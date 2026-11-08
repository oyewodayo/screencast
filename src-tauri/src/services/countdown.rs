// services/countdown.rs
//
// The optional "3, 2, 1" before a recording (Settings > Recording), timed here so a recording
// started with no main window (shortcut, tray, phone remote while Briefcast sits in the tray) gets
// it too. The countdown window (components/CountdownOverlay.tsx) only draws the number it is sent
// and reports a click as a cancel; the frontend's own countdown (utils/recordingCountdown.ts)
// calls the same commands, so there is one implementation.
//
// Cancelling: a click on the countdown, or pressing Record again while it runs.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, PhysicalPosition};
use tokio::sync::Notify;

const LABEL: &str = "countdown-overlay";
const TICK_EVENT: &str = "recording-countdown-tick";
const CANCEL_EVENT: &str = "recording-countdown-cancel";
/// Logical size of the countdown window (tauri.conf.json).
const SIZE: f64 = 220.0;

#[derive(Clone, Copy, Serialize)]
struct Tick {
    // Seconds left; 0 means over (finished or cancelled) and the window is hiding.
    remaining: u32,
    total: u32,
}

#[derive(Default)]
struct Cancel {
    notify: Notify,
    cancelled: std::sync::atomic::AtomicBool,
}

impl Cancel {
    fn fire(&self) {
        self.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
    }
}

static RUNNING: Mutex<Option<Arc<Cancel>>> = Mutex::new(None);

pub fn is_running() -> bool {
    RUNNING.lock().unwrap_or_else(|p| p.into_inner()).is_some()
}

pub fn cancel() {
    if let Some(c) = RUNNING.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        c.fire();
    }
}

/// Centres the window on the monitor the main window is on, else the primary one.
fn place(app: &AppHandle, window: &tauri::WebviewWindow) {
    let monitor = app
        .get_webview_window(crate::services::main_window::LABEL)
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let side = (SIZE * m.scale_factor()).round() as i32;
        let (pos, size) = (m.position(), m.size());
        let _ = window.set_position(PhysicalPosition::new(
            pos.x + (size.width as i32 - side) / 2,
            pos.y + (size.height as i32 - side) / 2,
        ));
    }
}

/// Runs the countdown. Resolves true when it reached the end (start recording), false when it was
/// cancelled - or when one is already running, since a second Record press means "cancel".
/// A countdown that can't be shown never blocks the recording: it just isn't drawn.
pub async fn run(app: &AppHandle, seconds: u32) -> bool {
    let total = seconds.max(1);
    let cancel = {
        let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        if running.is_some() {
            return false;
        }
        let c = Arc::new(Cancel::default());
        *running = Some(c.clone());
        c
    };
    let listener = {
        let c = cancel.clone();
        app.listen_any(CANCEL_EVENT, move |_| c.fire())
    };

    let window = app.get_webview_window(LABEL);
    if let Some(w) = &window {
        place(app, w);
        let _ = w.show();
    } else {
        log::warn!("countdown window missing - counting down without it");
    }
    let mut remaining = total;
    while remaining > 0 {
        // Registered before the cancelled check, so a cancel landing in between still wakes it.
        let woken = cancel.notify.notified();
        tokio::pin!(woken);
        woken.as_mut().enable();
        if cancel.is_cancelled() {
            break;
        }
        let _ = app.emit(TICK_EVENT, Tick { remaining, total });
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            _ = woken => {}
        }
        remaining -= 1;
    }

    app.unlisten(listener);
    let finished = !cancel.is_cancelled();
    *RUNNING.lock().unwrap_or_else(|p| p.into_inner()) = None;
    let _ = app.emit(TICK_EVENT, Tick { remaining: 0, total });
    if let Some(w) = &window {
        let _ = w.hide();
    }
    finished
}

#[tauri::command]
pub async fn run_recording_countdown(app: AppHandle, seconds: u32) -> bool {
    run(&app, seconds).await
}

#[tauri::command]
pub async fn cancel_recording_countdown() {
    cancel();
}

#[tauri::command]
pub async fn is_recording_countdown_running() -> bool {
    is_running()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_wakes_and_marks() {
        let c = Cancel::default();
        assert!(!c.is_cancelled());
        c.fire();
        assert!(c.is_cancelled());
    }

    #[test]
    fn cancel_with_nothing_running_is_harmless() {
        cancel();
        assert!(!is_running());
    }
}
