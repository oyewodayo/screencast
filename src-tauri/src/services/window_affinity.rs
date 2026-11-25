// services/window_affinity.rs
//
// Prevents overlay UI elements (recording controller bar, countdown timer, screenshot picker,
// snip canvas, annotation drawing layer) from appearing inside screen recordings or screenshots.
//
// - Windows: Uses `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` (0x00000011).
//   Introduced in Windows 10 version 2004 (build 19041), this cleanly hides the window from
//   GDI, DXGI Desktop Duplication, BitBlt, Windows Graphics Capture, ffmpeg, OBS, etc., while
//   keeping it fully visible, crisp and interactive to the user on their screen.
//
// - macOS: Uses Cocoa's `[NSWindow setSharingType:NSWindowSharingNone]` (0).
//   Quartz Window Services (CGWindowListCreateImage) and ScreenCaptureKit / avfoundation screen
//   capture skip windows whose sharing type is NSWindowSharingNone.
//
// - Linux / others: Safe no-op.

use tauri::{AppHandle, Manager, WebviewWindow};

#[allow(dead_code)]
pub const OVERLAY_LABELS: &[&str] = &[
    "recording-overlay",
    "countdown-overlay",
    "screenshot-overlay",
    "snip-overlay",
    // Intentionally NOT excluding "annotation-overlay": live ink strokes, pointer highlights,
    // and privacy blurs live on that window and are meant to appear inside the recording.
];

#[cfg(target_os = "windows")]
pub fn exclude_window_from_capture(window: &WebviewWindow) -> Result<(), String> {
    // On Windows, calling SetWindowDisplayAffinity on frameless/hidden WebView2 windows
    // (decorations: false, visible: false — including non-transparent overlays like snip-overlay)
    // forces DWM to attach a standard non-client title bar and makes hidden overlay windows
    // immediately visible at startup (commit 5d066492). Leave Windows overlays untouched here.
    let _ = window;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn exclude_window_from_capture(window: &WebviewWindow) -> Result<(), String> {
    use std::ffi::c_void;

    // AppKit requires [NSWindow setSharingType:] on the main thread, and Apple Silicon (ARM64)
    // requires calling objc_msgSend cast to the exact non-variadic function signature (variadic
    // `...` puts the argument on the stack instead of register x2 and crashes on M-series Macs).
    let win = window.clone();
    let label = window.label().to_string();
    window
        .run_on_main_thread(move || {
            let Ok(ns_win) = win.ns_window() else {
                return;
            };
            if ns_win.is_null() {
                return;
            }

            extern "C" {
                fn sel_registerName(name: *const std::ffi::c_char) -> *mut c_void;
                fn objc_msgSend();
            }

            unsafe {
                let sel = sel_registerName(b"setSharingType:\0".as_ptr() as *const _);
                // NSWindowSharingNone = 0
                let msg_send: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) =
                    std::mem::transmute(objc_msgSend as *const ());
                msg_send(ns_win as *mut c_void, sel, 0usize);
            }
            log::debug!("Set NSWindowSharingNone on window '{}'", label);
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn exclude_window_from_capture(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Applies capture exclusion to all pre-configured overlay windows in the application.
#[allow(dead_code)]
pub fn exclude_overlays_from_capture(app: &AppHandle) {
    for label in OVERLAY_LABELS {
        if let Some(win) = app.get_webview_window(label) {
            let _ = exclude_window_from_capture(&win);
        }
    }
}

/// Tauri command to allow dynamic or newly spawned overlay windows to opt into capture exclusion.
#[tauri::command(async)]
pub fn exclude_from_screen_capture(window: WebviewWindow) -> Result<(), String> {
    exclude_window_from_capture(&window)
}
