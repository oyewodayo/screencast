// services/main_window.rs
//
// The main window's lifecycle, owned by Rust. The window is declared in tauri.conf.json with
// `"create": false` and built here, so that:
//   - Briefcast can start at sign-in straight into the tray without loading any UI (`--tray`);
//   - while it sits in the tray the WebView can be released (destroyed) to give back its memory -
//     roughly 150-300 MB - and rebuilt when the user opens Briefcast again;
//   - something that needs a page while none exists (a recording whose setup includes the phone
//     camera: its capture runs in MediaRecorder, inside a WebView) can rebuild it hidden.
//
// Handing work to a page that may not exist yet: `deliver` queues the action and the page *pulls*
// the queue (`take_main_window_actions`) once its listeners are installed. Pushing an event right
// after building the window would race those listeners and could be lost.
//
// Desktop only. On Android/iOS the OS owns the single window's lifecycle.

use serde::Serialize;
use tauri::AppHandle;

pub const LABEL: &str = "main";

/// Something for the main window to do once its page is ready.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MainAction {
    pub action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[cfg(desktop)]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tauri::{Emitter, Manager, WebviewWindowBuilder};

    #[derive(Default)]
    pub struct MainWindowState {
        /// The page has installed its listeners (it said so through take_main_window_actions).
        ready: AtomicBool,
        /// The next destroy is a release to the tray, not a quit.
        releasing: AtomicBool,
        /// Whether the page should show itself once painted. False for a hidden rebuild.
        reveal: AtomicBool,
        /// The user asked to quit - the one case an exit request is let through.
        quitting: AtomicBool,
        /// A build is under way - a second request (two quick tray clicks) must not race it.
        creating: AtomicBool,
        pending: Mutex<Vec<MainAction>>,
    }

    fn state(app: &AppHandle) -> tauri::State<'_, MainWindowState> {
        app.state::<MainWindowState>()
    }

    pub fn exists(app: &AppHandle) -> bool {
        app.get_webview_window(LABEL).is_some()
    }

    /// Builds the main window from its tauri.conf.json entry, unless it already exists. `reveal`:
    /// whether the page shows itself once it has painted (it always starts hidden, so no blank
    /// frame flashes first).
    pub fn create(app: &AppHandle, reveal: bool) -> Result<tauri::WebviewWindow, String> {
        if let Some(window) = app.get_webview_window(LABEL) {
            if reveal {
                state(app).reveal.store(true, Ordering::SeqCst);
            }
            return Ok(window);
        }
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|w| w.label == LABEL)
            .cloned()
            .ok_or("tauri.conf.json has no main window entry")?;
        let st = state(app);
        if st.creating.swap(true, Ordering::SeqCst) {
            // Another call is building it; it will reveal if either asked to.
            if reveal {
                st.reveal.store(true, Ordering::SeqCst);
            }
            return Err("The main window is already being created.".into());
        }
        st.ready.store(false, Ordering::SeqCst);
        st.reveal.store(reveal, Ordering::SeqCst);
        let built = WebviewWindowBuilder::from_config(app, &config)
            .map_err(|e| format!("Could not configure the main window: {}", e))
            .and_then(|b| b.build().map_err(|e| format!("Could not create the main window: {}", e)));
        st.creating.store(false, Ordering::SeqCst);
        let window = built?;
        #[cfg(target_os = "windows")]
        crate::services::webview_recovery::attach(app, &window);
        log::info!("main window created (reveal: {})", reveal);
        Ok(window)
    }

    /// Builds the window on its own thread. The callers can be on the main thread (tray menu and
    /// single-instance callbacks are), and on Windows building a window there blocks: the build waits
    /// for the very event loop the caller is occupying.
    fn create_off_main_thread(app: &AppHandle, reveal: bool) {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(e) = create(&app, reveal) {
                log::error!("{}", e);
            }
        });
    }

    /// Brings Briefcast forward, rebuilding the window if it was released.
    pub fn show(app: &AppHandle) {
        match app.get_webview_window(LABEL) {
            Some(window) => {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            None => create_off_main_thread(app, true),
        }
    }

    /// Hands `action` to the main window: straight away if its page is listening, otherwise queued
    /// for the page to pull once it is (building the window, hidden unless `reveal`, if needed).
    pub fn deliver(app: &AppHandle, action: MainAction, reveal: bool) {
        let st = state(app);
        if exists(app) && st.ready.load(Ordering::SeqCst) {
            let _ = app.emit_to(LABEL, "main-action", action);
            if reveal {
                show(app);
            }
            return;
        }
        st.pending.lock().unwrap_or_else(|p| p.into_inner()).push(action);
        if exists(app) {
            // Still loading: the page pulls the queue once it's listening.
            if reveal {
                show(app);
            }
        } else {
            create_off_main_thread(app, reveal);
        }
    }

    /// Destroys the main window but keeps Briefcast running in the tray. The page has already run
    /// its close guards (saves flushed) and checked nothing needs it (closeGuards.ts).
    pub fn release(app: &AppHandle) -> Result<(), String> {
        let Some(window) = app.get_webview_window(LABEL) else { return Ok(()) };
        let st = state(app);
        st.releasing.store(true, Ordering::SeqCst);
        st.ready.store(false, Ordering::SeqCst);
        window.destroy().map_err(|e| {
            st.releasing.store(false, Ordering::SeqCst);
            format!("Could not release the main window: {}", e)
        })?;
        log::info!("main window released to the tray");
        Ok(())
    }

    /// Called from the run loop when the main window is destroyed: true if it was a release (keep
    /// running), false if it was the user quitting.
    pub fn take_was_release(app: &AppHandle) -> bool {
        let st = state(app);
        st.ready.store(false, Ordering::SeqCst);
        st.releasing.swap(false, Ordering::SeqCst)
    }

    pub fn take_pending(app: &AppHandle) -> Vec<MainAction> {
        let st = state(app);
        st.ready.store(true, Ordering::SeqCst);
        let mut pending = st.pending.lock().unwrap_or_else(|p| p.into_inner());
        std::mem::take(&mut *pending)
    }

    pub fn should_reveal(app: &AppHandle) -> bool {
        state(app).reveal.load(Ordering::SeqCst)
    }

    pub fn request_quit(app: &AppHandle) {
        state(app).quitting.store(true, Ordering::SeqCst);
    }

    pub fn is_quitting(app: &AppHandle) -> bool {
        state(app).quitting.load(Ordering::SeqCst)
    }
}

#[cfg(mobile)]
mod imp {
    use super::*;
    use tauri::{Emitter, Manager};

    #[derive(Default)]
    pub struct MainWindowState;

    pub fn exists(app: &AppHandle) -> bool {
        app.get_webview_window(LABEL).is_some()
    }
    pub fn show(_app: &AppHandle) {}
    pub fn deliver(app: &AppHandle, action: MainAction, _reveal: bool) {
        let _ = app.emit_to(LABEL, "main-action", action);
    }
    pub fn release(_app: &AppHandle) -> Result<(), String> {
        Ok(())
    }
    pub fn take_was_release(_app: &AppHandle) -> bool {
        false
    }
    pub fn take_pending(_app: &AppHandle) -> Vec<MainAction> {
        Vec::new()
    }
    pub fn should_reveal(_app: &AppHandle) -> bool {
        true
    }
    pub fn request_quit(_app: &AppHandle) {}
    pub fn is_quitting(_app: &AppHandle) -> bool {
        true
    }
}

pub use imp::*;

/// Launched by "Start Briefcast when I sign in": come up in the tray with no window.
pub const TRAY_LAUNCH_ARG: &str = "--tray";

pub fn launched_to_tray() -> bool {
    std::env::args().any(|a| a == TRAY_LAUNCH_ARG)
}

/// The page asks once it has painted: show yourself, or stay hidden (a hidden rebuild).
#[tauri::command]
pub async fn main_window_should_reveal(app: AppHandle) -> bool {
    should_reveal(&app)
}

/// The page's listeners are installed: hand over whatever was waiting for it. Also marks the page
/// ready, so later actions are emitted straight to it.
#[tauri::command]
pub async fn take_main_window_actions(app: AppHandle) -> Vec<MainAction> {
    take_pending(&app)
}

/// Releases the main window to the tray (see `release`).
#[tauri::command]
pub async fn release_main_window(app: AppHandle) -> Result<(), String> {
    // Destroying a window from a command must not happen on the IPC worker that the window's own
    // page is waiting on; hand it to the main thread.
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(release(&worker));
    })
    .map_err(|e| e.to_string())?;
    crate::services::responsiveness::blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_serialize_without_empty_fields() {
        let a = MainAction { action: "record", record_type: None, message: None };
        assert_eq!(serde_json::to_value(&a).unwrap(), serde_json::json!({ "action": "record" }));
        let b = MainAction { action: "record", record_type: Some("sa".into()), message: None };
        assert_eq!(serde_json::to_value(&b).unwrap(), serde_json::json!({ "action": "record", "recordType": "sa" }));
    }
}
