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

pub const OVERLAY_LABELS: &[&str] = &[
    "recording-overlay",
    "countdown-overlay",
    "screenshot-overlay",
    "snip-overlay",
    "annotation-overlay",
];

#[cfg(target_os = "windows")]
pub fn exclude_window_from_capture(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WINDOW_DISPLAY_AFFINITY};

    // WDA_EXCLUDEFROMCAPTURE = 0x00000011 (WINDOW_DISPLAY_AFFINITY(17))
    const WDA_EXCLUDEFROMCAPTURE: WINDOW_DISPLAY_AFFINITY = WINDOW_DISPLAY_AFFINITY(0x00000011);

    let raw_hwnd = window.hwnd().map_err(|e| format!("Window hwnd error: {e}"))?;
    unsafe {
        let hwnd = HWND(raw_hwnd.0 as _);
        if let Err(e) = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) {
            log::warn!("SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) for {}: {}", window.label(), e);
            return Err(e.to_string());
        }
    }
    log::debug!("Excluded window '{}' from screen capture", window.label());
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn exclude_window_from_capture(window: &WebviewWindow) -> Result<(), String> {
    let ns_win = window.ns_window().map_err(|e| format!("ns_window error: {e}"))?;
    if ns_win.is_null() {
        return Err("NSWindow is null".to_string());
    }

    extern "C" {
        fn sel_registerName(name: *const std::ffi::c_char) -> *mut std::ffi::c_void;
        fn objc_msgSend(receiver: *mut std::ffi::c_void, selector: *mut std::ffi::c_void, ...) -> *mut std::ffi::c_void;
    }

    unsafe {
        let sel = sel_registerName(b"setSharingType:\0".as_ptr() as *const _);
        // NSWindowSharingNone = 0
        let _: *mut std::ffi::c_void = objc_msgSend(ns_win as _, sel, 0usize);
    }
    log::debug!("Set NSWindowSharingNone on window '{}'", window.label());
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn exclude_window_from_capture(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Applies capture exclusion to all pre-configured overlay windows in the application.
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
