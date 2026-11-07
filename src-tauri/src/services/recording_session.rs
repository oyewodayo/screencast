// services/recording_session.rs
//
// Recording control that works with or without the main window.
//
// Two halves:
//   - Hooks (`on_started` / `on_stopped`) run by the start_recording / stop_recording commands
//     themselves, so the side effects every recording needs - the tray's red dot, the shortcuts
//     that only exist while recording, the recording bar's timer - happen whoever started or
//     stopped it: the main window, the recording bar's own Stop, or Rust with no window at all.
//     (Before, the main window did them, so a Stop from the recording bar with the main window
//     gone left the tray showing a recording that had ended.)
//   - Window-less handlers for the shortcut, tray and phone remote while the main window does not
//     exist (released to the tray, or never opened after a `--tray` launch). While it exists those
//     go to it instead, so its fuller flow (start sound, phone capture, messages) runs as before.
//
// The capture itself is untouched: everything here goes through the same commands the UI calls.

use crate::commands::recording::{self, AppState, FormData, RecordingStatus};
use crate::services::main_window::{self, MainAction};
use crate::services::phone_camera::PHONE_DEVICE_SENTINEL;
use crate::services::shortcuts::{self, Group};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const OVERLAY_LABEL: &str = "recording-overlay";

#[derive(Default)]
pub struct SessionState {
    can_switch_view: AtomicBool,
    /// "screen" or "camera" - the live view of a switchable recording.
    view_mode: Mutex<&'static str>,
}

fn session(app: &AppHandle) -> tauri::State<'_, SessionState> {
    app.state::<SessionState>()
}

/// Whether a recording with this setup produces a second (camera) file the live view can cut to:
/// a separately recorded webcam, or the phone camera, which always records to that same sidecar.
pub fn can_switch_view(record_type: &str, separate_webcam_capture: bool, video_devices: &[String]) -> bool {
    record_type == "sva" && (separate_webcam_capture || video_devices.iter().any(|d| d == PHONE_DEVICE_SENTINEL))
}

// ---- Hooks -----------------------------------------------------------------------------------------

/// Shortcut registration waits on the main thread; never do that on an async worker (or on the main
/// thread itself), so group changes get their own short-lived thread.
fn set_groups(app: &AppHandle, recording: bool, view_switch: bool) {
    let app = app.clone();
    std::thread::spawn(move || {
        shortcuts::set_group(&app, Group::Recording, recording);
        shortcuts::set_group(&app, Group::ViewSwitch, view_switch);
    });
}

async fn status(app: &AppHandle) -> RecordingStatus {
    recording::get_recording_status(app.state::<AppState>())
        .await
        .unwrap_or(RecordingStatus { recording: false, clock: None })
}

/// The recording bar's whole state, from the backend clock - the same payload the main window sends.
async fn push_overlay_state(app: &AppHandle) {
    let status = status(app).await;
    let can_switch = session(app).can_switch_view.load(Ordering::SeqCst);
    let payload = match &status.clock {
        Some(c) if status.recording => json!({
            "isRecording": true,
            "recordType": c.record_type,
            "startTime": c.started_at,
            "isPaused": c.pause_started_at.is_some(),
            "pauseStartedAt": c.pause_started_at,
            "pausedAccumulatedMs": c.paused_accumulated_ms,
            "canSwitchView": can_switch,
        }),
        _ => json!({ "isRecording": false, "recordType": "", "startTime": 0 }),
    };
    let _ = app.emit_to(OVERLAY_LABEL, "recording-state-update", payload);
    if !main_window::exists(app) {
        broadcast_remote_state(app, &status, can_switch);
    }
}

/// Phones mirror the recording state (the Remote). The main window broadcasts the full state while
/// it exists; without it, the recording part is sent from here.
fn broadcast_remote_state(app: &AppHandle, status: &RecordingStatus, can_switch: bool) {
    let now = chrono::Utc::now().timestamp_millis();
    let (paused, elapsed_ms) = match &status.clock {
        Some(c) if status.recording => {
            let until = c.pause_started_at.unwrap_or(now);
            (c.pause_started_at.is_some(), (until - c.started_at - c.paused_accumulated_ms).max(0))
        }
        _ => (false, 0),
    };
    let view = *session(app).view_mode.lock().unwrap_or_else(|p| p.into_inner());
    let settings = crate::services::settings_store::current(app);
    let mode = crate::services::settings_store::get_str(&settings, "defaultRecordType", "sva").to_owned();
    let state = json!({
        "recording": status.recording,
        "paused": paused,
        "elapsedMs": elapsed_ms,
        "canSwitchView": status.recording && can_switch,
        "view": if view.is_empty() { "screen" } else { view },
        "editing": Value::Null,
        "playing": false,
        "time": 0,
        "duration": 0,
        "canUndo": false,
        "canRedo": false,
        "mode": mode,
    });
    crate::services::phone_transfer::broadcast(app, "remote_state", state);
}

/// Called by start_recording once capture is running.
pub fn on_started(app: &AppHandle, can_switch_view: bool) {
    let st = session(app);
    st.can_switch_view.store(can_switch_view, Ordering::SeqCst);
    *st.view_mode.lock().unwrap_or_else(|p| p.into_inner()) = "screen";
    crate::services::tray::set_recording(app, true);
    set_groups(app, true, can_switch_view);
    let app = app.clone();
    tauri::async_runtime::spawn(async move { push_overlay_state(&app).await });
}

/// Called by stop_recording as soon as a stop begins - capture ends within a moment, while
/// assembling the file can take minutes, and the tray must not keep claiming a recording meanwhile.
pub fn on_stopped(app: &AppHandle) {
    session(app).can_switch_view.store(false, Ordering::SeqCst);
    crate::services::tray::set_recording(app, false);
    set_groups(app, false, false);
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = w.hide();
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { push_overlay_state(&app).await });
}

// ---- Window-less control ---------------------------------------------------------------------------

/// What the shortcut, tray and phone remote can ask for with no main window.
#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    /// Start with the current setup (or this record type), or stop the one running.
    Toggle(Option<String>),
    Start(Option<String>),
    Stop,
    PauseToggle,
    OverlayToggle,
    ViewToggle,
    /// The phone remote's mode picker: what the next Record captures.
    SetRecordType(String),
    Screenshot,
}

/// Handles `request` without a main window. Returns at once; the work runs on the async runtime.
pub fn handle(app: &AppHandle, request: Request) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match request {
            Request::Toggle(rt) => toggle(&app, rt).await,
            Request::Start(rt) => {
                if status(&app).await.recording {
                    Ok(())
                } else {
                    start(&app, rt).await
                }
            }
            Request::Stop => stop(&app).await,
            Request::PauseToggle => toggle_pause(&app).await,
            Request::OverlayToggle => {
                toggle_overlay(&app);
                Ok(())
            }
            Request::ViewToggle => toggle_view(&app).await,
            Request::SetRecordType(rt) => set_record_type(&app, rt).await,
            Request::Screenshot => crate::commands::snip::snip_begin(app.clone(), None).await,
        };
        if let Err(message) = result {
            log::warn!("window-less recording control: {}", message);
            report_error(&app, message);
        }
    });
}

/// A failure the user has to see. With no window to show it in, Briefcast opens.
fn report_error(app: &AppHandle, message: String) {
    main_window::deliver(app, MainAction { action: "error", record_type: None, message: Some(message) }, true);
}

async fn toggle(app: &AppHandle, record_type: Option<String>) -> Result<(), String> {
    // Record pressed again during the countdown: a change of mind.
    if crate::services::countdown::is_running() {
        crate::services::countdown::cancel();
        return Ok(());
    }
    if status(app).await.recording {
        stop(app).await
    } else {
        start(app, record_type).await
    }
}

async fn start(app: &AppHandle, record_type: Option<String>) -> Result<(), String> {
    let worker = app.clone();
    let rt = record_type.clone();
    let request = crate::services::responsiveness::blocking(move || {
        crate::services::recording_setup::current_setup_request(&worker, rt.as_deref())
    })
    .await??;

    // The phone camera records in a WebView (MediaRecorder), so this start needs a page: build the
    // main window hidden and hand it the start - its own flow captures the phone.
    let uses_phone = request["video_devices"]
        .as_array()
        .is_some_and(|d| d.iter().any(|v| v == PHONE_DEVICE_SENTINEL));
    if uses_phone {
        main_window::deliver(app, MainAction { action: "record", record_type, message: None }, false);
        return Ok(());
    }

    let settings = crate::services::settings_store::current(app);
    if crate::services::settings_store::get_bool(&settings, "recordingCountdownEnabled", false) {
        let seconds = crate::services::settings_store::get_u32(&settings, "recordingCountdownSeconds").unwrap_or(3);
        if !crate::services::countdown::run(app, seconds).await {
            return Ok(());
        }
    }

    let form: FormData = serde_json::from_value(request).map_err(|e| format!("Invalid recording setup: {}", e))?;
    recording::start_recording(app.clone(), app.state::<AppState>(), form)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to start recording: {}", e))
}

async fn stop(app: &AppHandle) -> Result<(), String> {
    match recording::stop_recording(app.clone(), app.state::<AppState>()).await {
        Ok(_) => Ok(()),
        // A second Stop while the first is still finishing - the recording is already being saved.
        Err(e) if e.contains("No recording in progress") => Ok(()),
        Err(e) => Err(format!("Failed to stop recording: {}", e)),
    }
}

async fn toggle_pause(app: &AppHandle) -> Result<(), String> {
    let status = status(app).await;
    let Some(clock) = status.clock.filter(|_| status.recording) else { return Ok(()) };
    let state = app.state::<AppState>();
    if clock.pause_started_at.is_some() {
        recording::resume_recording(state).await?;
    } else {
        recording::pause_recording(state).await?;
    }
    push_overlay_state(app).await;
    Ok(())
}

fn toggle_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
    }
}

/// Elapsed recording time at `now`, pause-aware - the formula every timer in the app uses.
fn elapsed_secs(started_at: i64, pause_started_at: Option<i64>, paused_accumulated_ms: i64, now: i64) -> f64 {
    let until = pause_started_at.unwrap_or(now);
    ((until - started_at - paused_accumulated_ms).max(0)) as f64 / 1000.0
}

async fn toggle_view(app: &AppHandle) -> Result<(), String> {
    if !session(app).can_switch_view.load(Ordering::SeqCst) {
        return Ok(());
    }
    let status = status(app).await;
    let Some(clock) = status.clock.filter(|_| status.recording) else { return Ok(()) };
    let st = session(app);
    let mode = {
        let mut current = st.view_mode.lock().unwrap_or_else(|p| p.into_inner());
        *current = if *current == "camera" { "screen" } else { "camera" };
        *current
    };
    let secs = elapsed_secs(clock.started_at, clock.pause_started_at, clock.paused_accumulated_ms, chrono::Utc::now().timestamp_millis());
    recording::record_view_switch(app.state::<AppState>(), secs, mode.to_owned()).await?;
    let _ = app.emit("view-mode-changed", json!({ "mode": mode }));
    push_overlay_state(app).await;
    Ok(())
}

async fn set_record_type(app: &AppHandle, record_type: String) -> Result<(), String> {
    if !crate::services::recording_setup::RECORD_TYPES.contains(&record_type.as_str()) || status(app).await.recording {
        return Ok(());
    }
    let worker = app.clone();
    crate::services::responsiveness::blocking(move || {
        crate::services::settings_store::write_blocking(&worker, |s| {
            s.insert("defaultRecordType".into(), Value::String(record_type));
        })
    })
    .await??;
    push_overlay_state(app).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_switching_needs_a_second_camera_file() {
        let cams = vec!["Cam".to_string()];
        let phone = vec![PHONE_DEVICE_SENTINEL.to_string()];
        assert!(!can_switch_view("sva", false, &cams));
        assert!(can_switch_view("sva", true, &cams));
        assert!(can_switch_view("sva", false, &phone));
        assert!(!can_switch_view("sa", true, &phone), "no camera in the picture to cut to");
    }

    #[test]
    fn elapsed_time_is_pause_aware() {
        // Started at 0, paused 2s in total, now at 10s: 8s recorded.
        assert_eq!(elapsed_secs(0, None, 2_000, 10_000), 8.0);
        // Paused right now since 6s (2s paused earlier): time stops at 4s.
        assert_eq!(elapsed_secs(0, Some(6_000), 2_000, 10_000), 4.0);
        // A clock that went backwards never yields negative time.
        assert_eq!(elapsed_secs(10_000, None, 0, 5_000), 0.0);
    }
}
