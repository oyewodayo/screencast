// commands/window_capture.rs
//
// Cross-platform orchestrator for window/monitor enumeration and window-thumbnail capture — used
// by the "select window/monitor to record" UI. Same structure as commands/recording.rs: shared
// types and OS-independent bookkeeping live here, the actual enumeration/capture mechanism is
// implemented once per platform (win.rs via Win32 GDI/EnumWindows, linux.rs via the raw X11
// protocol, macos.rs — not yet implemented, see that file) and selected at compile time.
use serde::Serialize;
use std::fs;

#[cfg(target_os = "windows")]
pub mod win;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
use win as platform;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;

#[derive(Serialize, Debug, Clone)]
pub struct WindowTitles {
    active: String,
    last_active: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct WindowInfo {
    title: String,
    image_path: String,
    hwnd: isize,
    // The owning process's executable path - window titles alone can be ambiguous (several
    // browser windows, several editor windows with similarly-named files) and thumbnails aren't
    // always available (see capture_window_enhanced's comment on why PrintWindow can fail for
    // some GPU-composited windows), so this gives the picker a second, always-available way to
    // tell windows apart. Empty string where a platform doesn't (yet) resolve it.
    exe_path: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct MonitorInfo {
    // pub(crate): recording.rs (a sibling module, not a descendant of this one — plain private
    // fields aren't visible there) reads these directly to resolve "monitor:<id>" screen_size
    // values into real geometry for gdigrab/x11grab/avfoundation targeting.
    pub(crate) id: String,
    name: String,
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
    is_primary: bool,
}

#[tauri::command]
pub fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    platform::get_monitors()
}

#[tauri::command]
pub async fn capture_window_screenshots_by_title_command(
    app_handle: tauri::AppHandle,
) -> Result<Vec<WindowInfo>, String> {
    platform::capture_window_screenshots_by_title(app_handle).await
}

#[tauri::command]
pub fn get_windows_titles() -> Vec<String> {
    platform::get_windows_titles()
}

#[tauri::command]
pub async fn activate_and_open_window(title: &str) -> Result<(), String> {
    platform::activate_and_open_window(title).await
}

#[tauri::command]
pub async fn start_monitoring_windows() -> Result<(), String> {
    platform::start_monitoring_windows().await
}

#[tauri::command]
pub async fn stop_monitoring_windows() -> Result<(), String> {
    platform::stop_monitoring_windows().await
}

#[tauri::command]
pub async fn get_window_titles() -> Result<WindowTitles, String> {
    platform::get_window_titles().await
}

// Best-effort fallback for the frontend-driven cleanup_screenshot_files command below - if the
// frontend never calls it (crash, force-quit), this sweeps any leftover capture files on exit.
// Purely filesystem work, identical on every platform (the naming convention is ours, not the
// OS's), so unlike everything else in this file it isn't part of the per-platform `platform`
// module.
pub fn cleanup_stale_window_screenshots() {
    let temp_dir = std::env::temp_dir();
    if let Ok(entries) = fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("briefcast_window_") && name.ends_with(".png") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

#[tauri::command]
pub async fn cleanup_screenshot_files(file_paths: Vec<String>) -> Result<(), String> {
    for path in file_paths {
        if let Err(e) = std::fs::remove_file(&path) {
            eprintln!("Failed to delete {}: {}", path, e);
        }
    }
    Ok(())
}
