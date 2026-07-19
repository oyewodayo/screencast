// commands/window_capture/macos.rs
//
// Not implemented yet. Window/monitor enumeration and screenshot capture on macOS need
// Core Graphics (CGWindowListCopyWindowInfo, CGWindowListCreateImage, CGGetActiveDisplayList)
// via Objective-C bridging, plus a Screen Recording permission (TCC) prompt the user has to grant
// — different enough in kind from both the Win32 and X11 paths (verified Rust bindings, real
// hardware to test the permission flow against) that it deserves its own real pass rather than
// a best-guess port with no way to check it actually asks for/receives that permission correctly.
//
// Every function below compiles and returns a clear error instead of silently doing nothing, so
// the "select window/monitor to record" UI fails loudly with an understandable message on macOS
// rather than the crate simply not building.
use super::{MonitorInfo, WindowInfo, WindowTitles};

const NOT_IMPLEMENTED: &str = "Window/monitor selection isn't implemented on macOS yet";

pub fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    Err(NOT_IMPLEMENTED.to_string())
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
