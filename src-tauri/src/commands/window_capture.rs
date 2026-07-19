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

// Only macOS's implementation actually needs the AppHandle (to resolve ffmpeg's bundled path
// for listing avfoundation "Capture screen N" devices) — Win32/X11 monitor enumeration is a
// direct syscall needing no app resources. Threaded through uniformly anyway so this command's
// signature doesn't need its own per-platform #[cfg], matching get_connected_devices elsewhere
// in this codebase (also uniformly takes an AppHandle even where most platforms ignore it).
#[tauri::command]
pub fn get_monitors(app_handle: tauri::AppHandle) -> Result<Vec<MonitorInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        platform::get_monitors(&app_handle)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_handle;
        platform::get_monitors()
    }
}

// Clamps a rect to the union of every monitor's bounds, so a rect that pokes even slightly
// outside the real desktop never reaches ffmpeg's screen-grab crop - gdigrab/x11grab both
// hard-reject an out-of-bounds -offset/-video_size region instead of clipping it (the original,
// motivating case: GetWindowRect's border padding on a maximized window on Windows - see
// win.rs's get_window_rect_by_title - but the same risk applies to any window that's simply
// been dragged partway off-screen, on any platform). Shared rather than duplicated per platform
// since the geometry math itself has nothing OS-specific about it.
pub(crate) fn clamp_rect_to_desktop(monitors: &[MonitorInfo], x: i32, y: i32, width: i32, height: i32) -> (i32, i32, i32, i32) {
    if monitors.is_empty() {
        return (x, y, width.max(1), height.max(1));
    }

    let min_x = monitors.iter().map(|m| m.x).min().unwrap();
    let min_y = monitors.iter().map(|m| m.y).min().unwrap();
    let max_x = monitors.iter().map(|m| m.x + m.width).max().unwrap();
    let max_y = monitors.iter().map(|m| m.y + m.height).max().unwrap();

    let left = x.clamp(min_x, max_x);
    let top = y.clamp(min_y, max_y);
    let right = (x + width).clamp(min_x, max_x);
    let bottom = (y + height).clamp(min_y, max_y);

    (left, top, (right - left).max(1), (bottom - top).max(1))
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
