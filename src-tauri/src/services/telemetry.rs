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
    // Whether the first-launch notice (Dashboard's TelemetryNotice) has been dismissed. Files
    // written before the notice existed lack it, so those users see it once too.
    #[serde(default)]
    notice_seen: bool,
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

// Opt-out: on unless the user has turned it off. A missing file is a fresh install. A file that
// exists but can't be read or parsed is treated as off - it may well be someone's opt-out, and
// silently turning telemetry back on for them would be the one unacceptable way to get this wrong.
fn read_consent(app_handle: &AppHandle) -> ConsentFile {
    let fresh = ConsentFile { enabled: true, install_id: None, notice_seen: false };
    let Some(path) = consent_path(app_handle) else { return fresh };
    if !path.exists() {
        return fresh;
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<ConsentFile>(&s).ok())
        .unwrap_or(ConsentFile { enabled: false, install_id: None, notice_seen: true })
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

// Any absolute file path, in any of the shapes this app's errors carry them: a drive path in
// either slash style, a UNC share, a Unix home, a "~"-relative path, and the asset-protocol URL
// the webview loads local files through (whose path part is URL-encoded, so it needs its own
// pattern). A path runs until a character no file name can contain - names can hold spaces, so
// whitespace can't end it, and ": " after a path (the usual "<path>: <os error>") ends it at the
// colon. Over-redacting a few trailing words is fine; leaking a file name is not.
fn path_pattern() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(concat!(
            r#"(?:https?://asset\.localhost|asset://localhost)/[^\s"'<>)]*"#,
            // \b keeps the drive-letter branch from matching the "p:/" inside "http://".
            r#"|(?:\b[A-Za-z]:|\\\\[^\\/\s"]+|~|/Users|/home)[\\/][^"\r\n:*?<>|]*"#,
        ))
        .expect("path pattern is valid")
    })
}

// Stack frame location fields: in a release build these are the build machine's source paths
// (where the code was compiled), not anything on the user's machine, and they're what makes a
// crash report readable - so they keep their text, with only the home folder replaced in case a
// local build is reporting.
const FRAME_KEYS: [&str; 5] = ["abs_path", "filename", "module", "package", "function"];

fn scrub_value(value: &mut Value, key: Option<&str>, home: Option<&str>) {
    match value {
        Value::String(s) => {
            if key.is_some_and(|k| FRAME_KEYS.contains(&k)) {
                if let Some(home) = home {
                    *s = s.replace(home, "~").replace(&home.replace('\\', "/"), "~");
                }
            } else if path_pattern().is_match(s) {
                *s = path_pattern().replace_all(s, "<path>").into_owned();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| scrub_value(v, None, home)),
        Value::Object(map) => map.iter_mut().for_each(|(k, v)| scrub_value(v, Some(k), home)),
        _ => {}
    }
}

// Removes every file path and the machine's name from an event before it leaves the machine -
// walking the whole serialized event (message, exception values, extras, breadcrumbs) rather
// than field by field, so a path can't slip through some field this didn't think to check.
fn scrub_event(mut event: sentry::protocol::Event<'static>) -> sentry::protocol::Event<'static> {
    // sentry-contexts fills server_name with the computer's hostname, which is very often the
    // owner's name ("JANE-SMITH-PC").
    event.server_name = None;
    let Ok(mut value) = serde_json::to_value(&event) else { return event };
    scrub_value(&mut value, None, home_dir().as_deref());
    serde_json::from_value(value).unwrap_or(event)
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
                Some(scrub_event(event))
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
    pub notice_seen: bool,
}

#[tauri::command(async)]
pub fn get_telemetry_settings(app_handle: AppHandle) -> TelemetrySettings {
    let _serial = crate::services::responsiveness::serial();
    TelemetrySettings {
        enabled: ENABLED.load(Ordering::SeqCst),
        available: key_present(POSTHOG_KEY) || key_present(SENTRY_DSN),
        notice_seen: read_consent(&app_handle).notice_seen,
    }
}

// The first-launch notice was dismissed (either button) - never show it again.
#[tauri::command(async)]
pub fn dismiss_telemetry_notice(app_handle: AppHandle) -> Result<(), String> {
    let _serial = crate::services::responsiveness::serial();
    let mut consent = read_consent(&app_handle);
    consent.notice_seen = true;
    // Mirror the live switch rather than whatever the file held, so this can never flip it.
    consent.enabled = ENABLED.load(Ordering::SeqCst);
    write_consent(&app_handle, &consent)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scrubbed(text: &str) -> String {
        let mut value = Value::String(text.to_string());
        scrub_value(&mut value, Some("message"), None);
        value.as_str().unwrap().to_string()
    }

    #[test]
    fn redacts_file_names_not_just_the_home_folder() {
        assert_eq!(
            scrubbed(r"Failed to rename C:\Users\Jane\Desktop\Briefcast\My Tax Return.pdf: Access is denied."),
            "Failed to rename <path>: Access is denied."
        );
        assert_eq!(scrubbed("Input file does not exist: D:/Library/Briefcast/clip one.mp4"), "Input file does not exist: <path>");
        assert_eq!(scrubbed(r"open \\nas\share\secret.docx failed"), "open <path>");
        assert_eq!(scrubbed("GET http://asset.localhost/C%3A%5CUsers%5CJane%5Cx.png 404"), "GET <path> 404");
        assert_eq!(scrubbed("no such file /home/jane/notes.md"), "no such file <path>");
    }

    #[test]
    fn leaves_text_and_app_urls_alone() {
        let text = "TypeError: x is undefined at http://tauri.localhost/assets/main-abc.js:12:34";
        assert_eq!(scrubbed(text), text);
    }

    #[test]
    fn keeps_stack_frame_locations_and_drops_the_hostname() {
        let mut value = json!({
            "message": r"C:\Users\Jane\secret.txt: denied",
            "frames": [{ "abs_path": r"D:\a\screencast\src-tauri\src\main.rs", "lineno": 3 }],
        });
        scrub_value(&mut value, None, None);
        assert_eq!(value["message"], "<path>: denied");
        assert_eq!(value["frames"][0]["abs_path"], r"D:\a\screencast\src-tauri\src\main.rs");

        let mut event = sentry::protocol::Event::default();
        event.server_name = Some("JANE-SMITH-PC".into());
        assert!(scrub_event(event).server_name.is_none());
    }
}
