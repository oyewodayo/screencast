// Anonymous usage analytics (PostHog) and crash reports (Sentry), behind one opt-out switch.
//
// Both are compiled in only when their keys are set at BUILD time (BRIEFCAST_POSTHOG_KEY,
// BRIEFCAST_SENTRY_DSN - the release workflow passes them from GitHub secrets), so dev builds and
// anyone building from source send nothing at all. At run time everything is gated on ENABLED,
// which mirrors <app config>/telemetry.json and flips immediately from Settings - no restart.
//
// What is sent, and what never is:
// - Analytics: an event name from a fixed list (track_event's callers), a few non-identifying
//   props (counts, durations, record type), app version, OS name, and a random install id - so
//   users and retention can be counted. The id is generated on this machine, tied to nothing
//   else, and deleted when telemetry is turned off (a new one is made if it's turned back on).
//   No file names, paths, document text, or anything typed.
// - Crash reports: the panic/error message and stack trace, with the user's home folder replaced
//   by "~" everywhere in the event (scrub_paths) so Windows user names don't leave the machine.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const POSTHOG_KEY: Option<&str> = option_env!("BRIEFCAST_POSTHOG_KEY");
// PostHog cloud region of the project - set to https://eu.i.posthog.com for an EU project.
const POSTHOG_HOST: Option<&str> = option_env!("BRIEFCAST_POSTHOG_HOST");
const SENTRY_DSN: Option<&str> = option_env!("BRIEFCAST_SENTRY_DSN");

static ENABLED: AtomicBool = AtomicBool::new(false);
static INSTALL_ID: Mutex<Option<String>> = Mutex::new(None);
static SENTRY_GUARD: OnceLock<sentry::ClientInitGuard> = OnceLock::new();
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsentFile {
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    install_id: Option<String>,
}

// 128 random bits as hex. std's RandomState keys are drawn from the OS random source, which is
// all an anonymous id needs - not worth a new crate.
fn new_install_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let half = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(0);
        h.finish()
    };
    format!("{:016x}{:016x}", half(), half())
}

fn key_present(key: Option<&str>) -> bool {
    key.map(|k| !k.trim().is_empty()).unwrap_or(false)
}

fn consent_path(app_handle: &AppHandle) -> Option<PathBuf> {
    app_handle.path().app_config_dir().ok().map(|d| d.join("telemetry.json"))
}

// Opt-out: on unless the user has turned it off. A missing file is a fresh install.
fn read_consent(app_handle: &AppHandle) -> ConsentFile {
    consent_path(app_handle)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<ConsentFile>(&s).ok())
        .unwrap_or(ConsentFile { enabled: true, install_id: None })
}

fn write_consent(app_handle: &AppHandle, consent: &ConsentFile) -> Result<(), String> {
    let path = consent_path(app_handle).ok_or("Could not resolve the app config folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create config folder: {}", e))?;
    }
    let text = serde_json::to_string(consent).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Failed to save telemetry setting: {}", e))
}

// Keeps the stored id in step with the switch: an enabled install has one, a disabled one never
// keeps one around.
fn sync_install_id(app_handle: &AppHandle, mut consent: ConsentFile) -> Result<(), String> {
    let changed = match (consent.enabled, consent.install_id.is_some()) {
        (true, false) => {
            consent.install_id = Some(new_install_id());
            true
        }
        (false, true) => {
            consent.install_id = None;
            true
        }
        _ => false,
    };
    *INSTALL_ID.lock().unwrap_or_else(|e| e.into_inner()) = consent.install_id.clone();
    if changed {
        write_consent(app_handle, &consent)?;
    }
    Ok(())
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok().filter(|h| h.len() > 3)
}

// Replaces the home folder (in both slash styles, and JSON-escaped) with "~" across the whole
// serialized event - messages, stack frame paths, breadcrumbs - rather than field by field, so a
// path can't slip through some field this didn't think to check.
fn scrub_paths(event: sentry::protocol::Event<'static>) -> sentry::protocol::Event<'static> {
    let Some(home) = home_dir() else { return event };
    let Ok(mut text) = serde_json::to_string(&event) else { return event };
    let forward = home.replace('\\', "/");
    let escaped = home.replace('\\', "\\\\");
    for needle in [&escaped, &forward, &home] {
        text = text.replace(needle.as_str(), "~");
    }
    serde_json::from_str(&text).unwrap_or(event)
}

// Called once from main.rs's setup.
pub fn init(app_handle: &AppHandle) {
    let consent = read_consent(app_handle);
    ENABLED.store(consent.enabled, Ordering::SeqCst);
    if key_present(POSTHOG_KEY) {
        if let Err(e) = sync_install_id(app_handle, consent) {
            log::warn!("Telemetry settings not saved: {}", e);
        }
    }

    if let Some(dsn) = SENTRY_DSN.filter(|_| key_present(SENTRY_DSN)) {
        let mut options = sentry::ClientOptions::default();
        options.release = sentry::release_name!();
        options.environment = Some(if cfg!(debug_assertions) { "development" } else { "production" }.into());
        options.send_default_pii = false;
        options.before_send = Some(std::sync::Arc::new(|event| {
            if ENABLED.load(Ordering::SeqCst) {
                Some(scrub_paths(event))
            } else {
                None
            }
        }));
        let guard = sentry::init((dsn, options));
        let _ = SENTRY_GUARD.set(guard);
    }

    track("app_started", None);
}

// Fire-and-forget PostHog event. A no-op without a key or with telemetry turned off; network
// failures are swallowed - analytics must never surface as an error to the user.
pub fn track(event_name: &str, props: Option<Map<String, Value>>) {
    let Some(key) = POSTHOG_KEY.filter(|_| key_present(POSTHOG_KEY)) else { return };
    if !ENABLED.load(Ordering::SeqCst) {
        return;
    }
    let Some(install_id) = INSTALL_ID.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return };
    let host = POSTHOG_HOST.filter(|h| !h.trim().is_empty()).unwrap_or("https://us.i.posthog.com");

    let mut properties = props.unwrap_or_default();
    let os = match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "Mac OS X",
        "linux" => "Linux",
        other => other,
    };
    properties.insert("$os".into(), json!(os));
    properties.insert("app_version".into(), json!(env!("CARGO_PKG_VERSION")));
    properties.insert("$lib".into(), json!("briefcast-rust"));
    // Keeps events anonymous: PostHog never builds a person profile for this id.
    properties.insert("$process_person_profile".into(), json!(false));

    let body = json!({
        "api_key": key,
        "event": event_name,
        "distinct_id": install_id,
        "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "properties": properties,
    });
    let client = HTTP.get_or_init(reqwest::Client::new).clone();
    let url = format!("{}/i/v0/e/", host.trim_end_matches('/'));
    tauri::async_runtime::spawn(async move {
        if let Err(e) = client.post(url).json(&body).send().await {
            log::debug!("Analytics event not sent: {}", e);
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySettings {
    pub enabled: bool,
    // False in builds without any keys (dev, source builds) - Settings says nothing is collected.
    pub available: bool,
}

#[tauri::command(async)]
pub fn get_telemetry_settings() -> TelemetrySettings {
    TelemetrySettings {
        enabled: ENABLED.load(Ordering::SeqCst),
        available: key_present(POSTHOG_KEY) || key_present(SENTRY_DSN),
    }
}

#[tauri::command(async)]
pub fn set_telemetry_enabled(app_handle: AppHandle, enabled: bool) -> Result<(), String> {
    // Writes the consent file - serialized like every other sync (async) command, see responsiveness.rs.
    let _serial = crate::services::responsiveness::serial();
    if !enabled {
        track("telemetry_disabled", None); // the last event this install sends
    }
    ENABLED.store(enabled, Ordering::SeqCst);
    let mut consent = read_consent(&app_handle);
    consent.enabled = enabled;
    if key_present(POSTHOG_KEY) {
        sync_install_id(&app_handle, consent)
    } else {
        consent.install_id = None;
        write_consent(&app_handle, &consent)
    }
}

// For the frontend's own events (src/utils/telemetry.ts).
#[tauri::command(async)]
pub fn track_event(name: String, props: Option<Map<String, Value>>) {
    track(&name, props);
}

// Uncaught frontend errors (ErrorBoundary, window.onerror) - same scrubbing and gating as panics.
#[tauri::command(async)]
pub fn report_frontend_error(message: String, stack: Option<String>) {
    if SENTRY_GUARD.get().is_none() || !ENABLED.load(Ordering::SeqCst) {
        return;
    }
    sentry::with_scope(
        |scope| {
            scope.set_tag("source", "frontend");
            if let Some(stack) = &stack {
                scope.set_extra("stack", Value::String(stack.clone()));
            }
        },
        || sentry::capture_message(&message, sentry::Level::Error),
    );
}
