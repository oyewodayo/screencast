// commands/window_capture/macos.rs
//
// Monitor enumeration IS implemented, via ffmpeg's own avfoundation device listing
// (list_avfoundation_devices, shared with recording::macos) rather than a direct Core Graphics
// binding: each active display shows up there as its own "Capture screen N" entry, in display
// order, which is all Monitor selection actually needs - avfoundation captures a whole display
// directly, with no crop/offset math the way gdigrab/x11grab need, so real pixel geometry
// (x/y/width/height) isn't needed here the way it is on Windows/Linux and is left as 0.
//
// Window enumeration/capture is NOT implemented. That needs Core Graphics
// (CGWindowListCopyWindowInfo, CGWindowListCreateImage, CGGetActiveDisplayList) via Objective-C
// bridging, plus a Screen Recording permission (TCC) prompt the user has to grant — different
// enough in kind from both the Win32 and X11 paths (verified Rust bindings, real hardware to
// test the permission flow against) that it deserves its own real pass rather than a best-guess
// port with no way to check it actually asks for/receives that permission correctly.
//
// Every window-related function below compiles and returns a clear error instead of silently
// doing nothing, so the "select window to record" UI fails loudly with an understandable message
// rather than the crate simply not building. The frontend also hides the Window option entirely
// on macOS (see the get_platform command and its use in EnhancedScreenOptions.tsx) so a normal
// user never has to hit this error to find out it isn't there.
use tauri::AppHandle;

use super::{MonitorInfo, WindowInfo, WindowTitles};
use crate::commands::recording::macos::list_avfoundation_devices;

const NOT_IMPLEMENTED: &str = "Window selection isn't implemented on macOS yet";

// id is "monitor_<i>" where i is the position within this same filtered "Capture screen" list -
// recording::macos::resolve_screen_target re-derives an avfoundation index from that same
// position, so this function and that one must stay in lock-step on the filter/ordering.
pub fn get_monitors(app_handle: &AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let (video_devices, _audio_devices) = list_avfoundation_devices(app_handle)?;

    let screens: Vec<MonitorInfo> = video_devices
        .iter()
        .filter(|d| d.name.starts_with("Capture screen"))
        .enumerate()
        .map(|(i, d)| MonitorInfo {
            id: format!("monitor_{}", i),
            name: d.name.clone(),
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            is_primary: i == 0,
        })
        .collect();

    if screens.is_empty() {
        return Err("No screen capture device found (expected a 'Capture screen N' entry from avfoundation)".to_string());
    }

    Ok(screens)
}

pub async fn capture_window_screenshots_by_title(_app_handle: tauri::AppHandle) -> Result<Vec<WindowInfo>, String> {
    Err(NOT_IMPLEMENTED.to_string())
}

pub fn get_windows_titles() -> Vec<String> {
    Vec::new()
}

pub async fn activate_and_open_window(_title: &str) -> Result<(), String> {
    Err(NOT_IMPLEMENTED.to_string())
}

pub async fn start_monitoring_windows() -> Result<(), String> {
    Err(NOT_IMPLEMENTED.to_string())
}

pub async fn stop_monitoring_windows() -> Result<(), String> {
    Err(NOT_IMPLEMENTED.to_string())
}

pub async fn get_window_titles() -> Result<WindowTitles, String> {
    Err(NOT_IMPLEMENTED.to_string())
}
