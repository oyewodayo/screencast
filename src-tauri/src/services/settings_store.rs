// services/settings_store.rs
//
// App-wide preferences, kept in a JSON file in the app config directory instead of the WebView's
// localStorage, so the Rust side can read them with no window alive. That is the prerequisite for
// everything that has to work while the UI is closed or destroyed: global shortcuts, the tray's
// "Start recording", and the phone remote all need "what is the user's current setup" without a
// page to ask.
//
// The file is deliberately an opaque JSON object here. The frontend owns the shape (`AppSettings`
// in src/utils/appSettings.ts), and most of its keys are UI-only, so mirroring all of them in a
// Rust struct would just be a second copy to keep in step. Rust reads the keys it needs through
// the typed accessors below, each with its own default, so a missing or malformed key can never
// stop a recording from starting.
//
// Nothing in this file is platform-specific: `app_config_dir()` resolves on desktop and mobile alike.

use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const FILE_NAME: &str = "settings.json";
/// Fired on every accepted write, with the full settings object as payload, so every window's
/// in-memory copy follows (the overlays are separate WebViews with their own JS state).
pub const SETTINGS_CHANGED_EVENT: &str = "settings-changed";

/// Choices that last one session only: they are in the file so a window-less start sees them while
/// the app runs, but dropped when the file is first read, so every launch starts with them off.
/// Both are newer capture paths that should never silently become someone's default (see their
/// comments in Dashboard.tsx).
const SESSION_ONLY_KEYS: [&str; 2] = ["separateWebcamCapture", "trackClicks"];

fn drop_session_only_keys(map: &mut Map<String, Value>) {
    for key in SESSION_ONLY_KEYS {
        map.remove(key);
    }
}

#[derive(Default)]
pub struct SettingsStore {
    /// `None` until the file has been read, and while no settings have ever been saved - which is
    /// how the frontend knows it should migrate the old localStorage copy.
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    value: Option<Map<String, Value>>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join(FILE_NAME))
        .map_err(|e| format!("Could not resolve the config directory: {}", e))
}

/// Reads the file. A file that exists but does not parse is moved aside rather than deleted
/// (the user's choices are in there, and a human may be able to recover them) and treated as
/// absent, so the app starts on defaults instead of failing.
fn read_file(path: &PathBuf) -> Option<Map<String, Value>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!("settings: could not read {}: {}", path.display(), e);
            return None;
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Some(map),
        _ => {
            let aside = path.with_extension("json.corrupt");
            log::warn!("settings: {} is not a JSON object, moving it to {}", path.display(), aside.display());
            let _ = std::fs::rename(path, &aside);
            None
        }
    }
}

/// Write to a sibling temp file and rename over the target, so a crash or power loss mid-write
/// leaves the previous complete file rather than a truncated one.
fn write_file_atomic(path: &PathBuf, map: &Map<String, Value>) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    }
    let text = serde_json::to_string_pretty(map).map_err(|e| format!("Could not encode settings: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("Could not write {}: {}", tmp.display(), e))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Could not replace {}: {}", path.display(), e))
}

impl SettingsStore {
    /// Loads from disk on first use. The lock is held across the file read, so concurrent first
    /// callers cannot both read and then overwrite each other's cache.
    fn with_loaded<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Inner) -> R) -> R {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if !inner.loaded {
            if let Ok(path) = settings_path(app) {
                inner.value = read_file(&path).map(|mut map| {
                    drop_session_only_keys(&mut map);
                    map
                });
            }
            inner.loaded = true;
        }
        f(&mut inner)
    }

    /// Whole settings object, or `None` if nothing has been saved yet.
    pub fn snapshot(&self, app: &AppHandle) -> Option<Map<String, Value>> {
        self.with_loaded(app, |i| i.value.clone())
    }
}

/// Settings for Rust-side readers (shortcut handlers, tray, remote). Empty when nothing has been
/// saved, which makes every typed accessor fall through to its default.
pub fn current(app: &AppHandle) -> Map<String, Value> {
    app.state::<SettingsStore>().snapshot(app).unwrap_or_default()
}

pub fn get_bool(settings: &Map<String, Value>, key: &str, default: bool) -> bool {
    settings.get(key).and_then(Value::as_bool).unwrap_or(default)
}

pub fn get_str<'a>(settings: &'a Map<String, Value>, key: &str, default: &'a str) -> &'a str {
    settings.get(key).and_then(Value::as_str).unwrap_or(default)
}

pub fn get_u32(settings: &Map<String, Value>, key: &str) -> Option<u32> {
    settings.get(key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok())
}

pub fn get_str_list(settings: &Map<String, Value>, key: &str) -> Vec<String> {
    settings
        .get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

/// The saved settings, or `null` when none exist yet (first run, or a pre-file install whose
/// preferences are still in the old localStorage key).
///
/// Async so it runs off the UI thread: the first call reads the file from disk.
#[tauri::command]
pub async fn get_settings(app: AppHandle, store: State<'_, SettingsStore>) -> Result<Option<Map<String, Value>>, String> {
    Ok(store.snapshot(&app))
}

/// Applies `change` to the settings under the store's lock, writes the result atomically, then
/// tells every window and resyncs the setting-driven shortcuts. Blocking (file IO and shortcut
/// registration, which waits on the main thread) - call it off the async runtime and never from the
/// main thread. The one write path: the frontend's saves and Rust's own changes both go through it.
pub fn write_blocking(app: &AppHandle, change: impl FnOnce(&mut Map<String, Value>)) -> Result<(), String> {
    let path = settings_path(app)?;
    let store = app.state::<SettingsStore>();
    let payload = store.with_loaded(app, |inner| {
        // Held across the write so two rapid saves can't reach the disk out of order: whichever
        // took the lock last is also what ends up in the file and the cache.
        let mut next = inner.value.clone().unwrap_or_default();
        change(&mut next);
        write_file_atomic(&path, &next)?;
        inner.value = Some(next.clone());
        Ok::<_, String>(next)
    })?;
    // Shortcut groups that follow a setting (the annotation tool) change with it, window or not.
    crate::services::shortcuts::sync_with_settings(app);
    // After the write succeeded, so a window never shows a value that did not persist.
    let _ = app.emit(SETTINGS_CHANGED_EVENT, Value::Object(payload));
    Ok(())
}

/// Replaces the whole settings object. The frontend always sends the complete object (it merges
/// over its own defaults), so there is no partial-update path to get wrong.
#[tauri::command]
pub async fn set_settings(app: AppHandle, settings: Value) -> Result<(), String> {
    let Value::Object(map) = settings else {
        return Err("Settings must be a JSON object.".into());
    };
    crate::services::responsiveness::blocking(move || write_blocking(&app, |current| *current = map)).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("briefcast-settings-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn round_trips_through_the_file() {
        let dir = temp_dir("roundtrip");
        let path = dir.join(FILE_NAME);
        let map = obj(json!({ "theme": "dark", "closeToTray": null, "defaultVideoDevices": ["Cam"] }));
        write_file_atomic(&path, &map).unwrap();
        assert_eq!(read_file(&path), Some(map));
        assert!(!path.with_extension("json.tmp").exists(), "temp file must not outlive the rename");
    }

    #[test]
    fn missing_file_reads_as_none_so_the_frontend_migrates() {
        let dir = temp_dir("missing");
        assert_eq!(read_file(&dir.join(FILE_NAME)), None);
    }

    #[test]
    fn corrupt_file_is_moved_aside_not_deleted() {
        let dir = temp_dir("corrupt");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(read_file(&path), None);
        assert!(!path.exists());
        assert_eq!(std::fs::read_to_string(path.with_extension("json.corrupt")).unwrap(), "{ not json");
    }

    #[test]
    fn non_object_json_counts_as_corrupt() {
        let dir = temp_dir("array");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "[1,2]").unwrap();
        assert_eq!(read_file(&path), None);
    }

    #[test]
    fn session_only_choices_do_not_survive_a_relaunch() {
        let mut map = obj(json!({ "trackClicks": true, "separateWebcamCapture": true, "theme": "dark" }));
        drop_session_only_keys(&mut map);
        assert_eq!(map, obj(json!({ "theme": "dark" })));
    }

    #[test]
    fn accessors_fall_back_to_defaults_on_missing_or_wrong_typed_keys() {
        let s = obj(json!({ "a": true, "b": "x", "n": 1280, "neg": -3, "list": ["p", 7, "q"], "wrong": "yes" }));
        assert!(get_bool(&s, "a", false));
        assert!(!get_bool(&s, "wrong", false), "a string is not a bool");
        assert!(get_bool(&s, "absent", true));
        assert_eq!(get_str(&s, "b", "d"), "x");
        assert_eq!(get_str(&s, "n", "d"), "d");
        assert_eq!(get_u32(&s, "n"), Some(1280));
        assert_eq!(get_u32(&s, "neg"), None);
        assert_eq!(get_str_list(&s, "list"), vec!["p", "q"]);
        assert!(get_str_list(&s, "absent").is_empty());
    }
}
