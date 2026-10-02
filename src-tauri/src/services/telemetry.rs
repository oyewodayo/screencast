// Anonymous usage analytics (Aptabase) and crash reports (Sentry), behind one opt-out switch.
//
// Both are compiled in only when their keys are set at BUILD time (BRIEFCAST_APTABASE_KEY,
// BRIEFCAST_SENTRY_DSN - the release workflow passes them from GitHub secrets), so dev builds and
// anyone building from source send nothing at all. At run time everything is gated on ENABLED,
// which mirrors <app config>/telemetry.json and flips immediately from Settings - no restart.
//
// What is sent, and what never is:
// - Analytics: an event name from a fixed list (track_event's callers), a few non-identifying
//   props (counts, durations, record type), app version, OS name, and a random per-launch session
//   id. No file names, paths, document text, or anything typed.
// - Crash reports: the panic/error message and stack trace, with the user's home folder replaced
//   by "~" everywhere in the event (scrub_paths) so Windows user names don't leave the machine.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const APTABASE_KEY: Option<&str> = option_env!("BRIEFCAST_APTABASE_KEY");
const SENTRY_DSN: Option<&str> = option_env!("BRIEFCAST_SENTRY_DSN");

static ENABLED: AtomicBool = AtomicBool::new(false);
static SESSION_ID: OnceLock<String> = OnceLock::new();
static SENTRY_GUARD: OnceLock<sentry::ClientInitGuard> = OnceLock::new();
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Serialize, Deserialize)]
struct ConsentFile {
    enabled: bool,
}

fn key_present(key: Option<&str>) -> bool {
    key.map(|k| !k.trim().is_empty()).unwrap_or(false)
}

fn consent_path(app_handle: &AppHandle) -> Option<PathBuf> {
    app_handle.path().app_config_dir().ok().map(|d| d.join("telemetry.json"))
}

// Opt-out: on unless the user has turned it off.
fn read_consent(app_handle: &AppHandle) -> bool {
    consent_path(app_handle)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<ConsentFile>(&s).ok())
        .map(|c| c.enabled)
        .unwrap_or(true)
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
    ENABLED.store(read_consent(app_handle), Ordering::SeqCst);
    let _ = SESSION_ID.set({
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        format!("{}{:09}", now.as_secs(), now.subsec_nanos())
    });

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

// Fire-and-forget Aptabase event. A no-op without a key or with telemetry turned off; network
// failures are swallowed - analytics must never surface as an error to the user.
pub fn track(event_name: &str, props: Option<Map<String, Value>>) {
    let Some(key) = APTABASE_KEY.filter(|_| key_present(APTABASE_KEY)) else { return };
    if !ENABLED.load(Ordering::SeqCst) {
        return;
    }
    // Aptabase app keys encode their region: A-US-..., A-EU-...
    let host = match key.split('-').nth(1) {
        Some("EU") => "https://eu.aptabase.com",
        _ => "https://us.aptabase.com",
    };
    let body = json!([{
        "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "sessionId": SESSION_ID.get().cloned().unwrap_or_default(),
        "eventName": event_name,
        "systemProps": {
            "isDebug": cfg!(debug_assertions),
            "osName": match std::env::consts::OS { "windows" => "Windows", "macos" => "macOS", "linux" => "Linux", other => other },
            "osVersion": "",
            "locale": "",
            "appVersion": env!("CARGO_PKG_VERSION"),
            "sdkVersion": concat!("briefcast-rust@", env!("CARGO_PKG_VERSION")),
        },
        "props": props.unwrap_or_default(),
    }]);
    let client = HTTP.get_or_init(reqwest::Client::new).clone();
    let url = format!("{}/api/v0/events", host);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = client.post(url).header("App-Key", key).json(&body).send().await {
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

#[tauri::command]
pub fn get_telemetry_settings() -> TelemetrySettings {
    TelemetrySettings {
        enabled: ENABLED.load(Ordering::SeqCst),
        available: key_present(APTABASE_KEY) || key_present(SENTRY_DSN),
    }
}

#[tauri::command]
pub fn set_telemetry_enabled(app_handle: AppHandle, enabled: bool) -> Result<(), String> {
    if !enabled {
        track("telemetry_disabled", None); // the last event this install sends
    }
    ENABLED.store(enabled, Ordering::SeqCst);
    let path = consent_path(&app_handle).ok_or("Could not resolve the app config folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create config folder: {}", e))?;
    }
    let text = serde_json::to_string(&ConsentFile { enabled }).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Failed to save telemetry setting: {}", e))
}

// For the frontend's own events (src/utils/telemetry.ts).
#[tauri::command]
pub fn track_event(name: String, props: Option<Map<String, Value>>) {
    track(&name, props);
}

// Uncaught frontend errors (ErrorBoundary, window.onerror) - same scrubbing and gating as panics.
#[tauri::command]
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
