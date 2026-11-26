// commands/window_capture/macos.rs
//
// Monitor enumeration IS implemented, via ffmpeg's own avfoundation device listing
// (list_avfoundation_devices, shared with recording::macos) rather than a direct Core Graphics
// binding: each active display shows up there as its own "Capture screen N" entry, in display
// order, which is all Monitor selection actually needs - avfoundation captures a whole display
// directly, with no crop/offset math the way gdigrab/x11grab need, so real pixel geometry
// (x/y/width/height) isn't needed here the way it is on Windows/Linux and is left as 0.
//
// Window enumeration/capture is implemented via `osascript` (AppleScript), NOT Core Graphics
// (CGWindowListCopyWindowInfo etc.) via Objective-C bridging - a deliberate choice, not a
// shortcut. This whole codebase's existing pattern for platform integration (Windows device
// enumeration, Linux device enumeration, both elsewhere in this file's siblings) is "shell out to
// a real command-line tool and parse its output," never raw FFI - and that pattern matters even
// more here, because this file cannot be compiled OR run from the Windows machine it was written
// on. A shell-based approach at least has a chance of being right by inspection (correct
// AppleScript syntax, correct text parsing); a raw Objective-C/Core Graphics binding would
// additionally risk not compiling at all, with no way to find out until someone with a Mac tries.
// Needs Accessibility permission (a macOS privacy prompt, granted once) for "tell application
// System Events" to see other apps' windows at all - a different, generally less alarming TCC
// permission than the Screen Recording one avfoundation's own screen capture separately needs.
//
// KNOWN LIMITATION (flagged rather than silently wrong, same policy as this backend's own
// UNVERIFIED note in recording/macos.rs): System Events reports window position in *global*
// screen coordinates (spanning every display), but avfoundation's "Capture screen N" devices each
// capture starting from THEIR OWN (0,0) - so a crop computed from these coordinates is only
// correct for a window on whichever display ends up being captured. In practice that's the
// primary display (macOS's own global coordinate origin IS the primary display's top-left, so the
// two coordinate spaces coincide there), which is what "Full Screen" and the first Monitor entry
// both resolve to - so the common case is correct. A window dragged onto a second, non-primary
// display would crop the wrong region. Properly fixing this needs each display's own origin
// within the global coordinate space (obtainable via NSScreen, itself another osascript/JXA call)
// - deferred until real multi-monitor Mac hardware exists to verify the fix against.
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::AppHandle;

use super::{MonitorInfo, WindowInfo, WindowTitles};
use crate::commands::recording::macos::list_avfoundation_devices;

const WINDOW_FIELD_SEP: &str = "|||";

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGGetActiveDisplayList(
        max_displays: u32,
        active_displays: *mut u32,
        display_count: *mut u32,
    ) -> i32;
    fn CGDisplayBounds(display: u32) -> CGRect;
}

#[derive(Clone, Copy, Debug)]
struct DisplayBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    is_primary: bool,
}

/// Active display geometry in macOS global display coordinates (primary display origin at 0,0),
/// ordered to match AVFoundation's "Capture screen N" enumeration.
fn active_display_bounds() -> Vec<DisplayBounds> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    let err = unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
    if err != 0 || count == 0 {
        return Vec::new();
    }
    let main_id = unsafe { CGMainDisplayID() };
    ids[..(count as usize).min(ids.len())]
        .iter()
        .map(|&id| {
            let rect = unsafe { CGDisplayBounds(id) };
            DisplayBounds {
                x: rect.origin.x.round() as i32,
                y: rect.origin.y.round() as i32,
                width: rect.size.width.round().max(0.0) as i32,
                height: rect.size.height.round().max(0.0) as i32,
                is_primary: id == main_id,
            }
        })
        .collect()
}

struct AppleScriptWindow {
    process_name: String,
    title: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

// One `osascript` call enumerating every visible process's windows, formatted as one
// WINDOW_FIELD_SEP-joined line per window so parsing is a plain string split rather than needing
// to fight AppleScript's own list/record-to-text formatting (which is fiddly enough - nested
// braces, comma-joined lists - that it's more error-prone than owning the format ourselves).
fn list_windows_via_osascript() -> Result<Vec<AppleScriptWindow>, String> {
    let script = format!(
        r#"set outputLines to {{}}
tell application "System Events"
    set procList to every process whose visible is true
    repeat with proc in procList
        try
            set winList to every window of proc
            repeat with win in winList
                try
                    set winTitle to name of win
                    set winPos to position of win
                    set winSize to size of win
                    set procName to name of proc
                    set end of outputLines to procName & "{sep}" & winTitle & "{sep}" & (item 1 of winPos) & "{sep}" & (item 2 of winPos) & "{sep}" & (item 1 of winSize) & "{sep}" & (item 2 of winSize)
                end try
            end repeat
        end try
    end repeat
end tell
set AppleScript's text item delimiters to linefeed
return outputLines as string"#,
        sep = WINDOW_FIELD_SEP
    );

    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("Failed to run osascript (window enumeration): {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // A denied/never-granted Accessibility permission is the single most likely real-world
        // failure here (osascript exits non-zero with "Not authorized to send Apple events") -
        // surfaced as a clear, actionable error instead of a bare ffmpeg-style stderr dump.
        return Err(format!(
            "Failed to list windows - if macOS didn't already prompt you, grant Briefcast Accessibility access in System Settings > Privacy & Security > Accessibility: {}",
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut windows = Vec::new();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split(WINDOW_FIELD_SEP).collect();
        if fields.len() != 6 {
            continue;
        }
        let (Ok(x), Ok(y), Ok(width), Ok(height)) = (
            fields[2].trim().parse::<i32>(),
            fields[3].trim().parse::<i32>(),
            fields[4].trim().parse::<i32>(),
            fields[5].trim().parse::<i32>(),
        ) else {
            continue;
        };
        let title = fields[1].to_string();
        // Matches win.rs's own capture_window_screenshots_by_title filtering intent - a sliver of
        // a window (some background utility's invisible helper window) isn't a meaningful
        // recording target and just clutters the picker.
        if title.is_empty() || width <= 50 || height <= 50 {
            continue;
        }
        windows.push(AppleScriptWindow {
            process_name: fields[0].to_string(),
            title,
            x,
            y,
            width,
            height,
        });
    }
    Ok(windows)
}

// id is "monitor_<i>" where i is the position within this same filtered "Capture screen" list -
// recording::macos::resolve_screen_target re-derives an avfoundation index from that same
// position, so this function and that one must stay in lock-step on the filter/ordering.
pub fn get_monitors(app_handle: &AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let (video_devices, _audio_devices) = list_avfoundation_devices(app_handle)?;
    let bounds = active_display_bounds();

    let screens: Vec<MonitorInfo> = video_devices
        .iter()
        .filter(|d| d.name.starts_with("Capture screen"))
        .enumerate()
        .map(|(i, d)| {
            let b = bounds.get(i).copied();
            MonitorInfo {
                id: format!("monitor_{}", i),
                name: d.name.clone(),
                x: b.map(|v| v.x).unwrap_or(0),
                y: b.map(|v| v.y).unwrap_or(0),
                width: b.map(|v| v.width).unwrap_or(0),
                height: b.map(|v| v.height).unwrap_or(0),
                is_primary: b.map(|v| v.is_primary).unwrap_or(i == 0),
            }
        })
        .collect();

    if screens.is_empty() {
        return Err("No screen capture device found (expected a 'Capture screen N' entry from avfoundation)".to_string());
    }

    Ok(screens)
}

pub async fn capture_window_screenshots_by_title(
    _app_handle: tauri::AppHandle,
) -> Result<Vec<WindowInfo>, String> {
    let windows = list_windows_via_osascript()?;
    if windows.is_empty() {
        return Err("No valid windows found".to_string());
    }

    // No thumbnail generation - a real per-window preview image would need each window's actual
    // CGWindowID to hand to `screencapture -l<id>`, which System Events doesn't expose (only Core
    // Graphics does - the exact FFI surface this file deliberately avoids, see its own module
    // comment). WindowInfo's own doc comment already treats a missing thumbnail as fine for
    // exactly this reason: the title/process name is still enough to tell windows apart.
    Ok(windows
        .into_iter()
        .enumerate()
        .map(|(index, w)| WindowInfo {
            title: w.title,
            image_path: String::new(),
            hwnd: index as isize,
            exe_path: w.process_name,
            ..Default::default()
        })
        .collect())
}

pub fn get_windows_titles() -> Vec<String> {
    list_windows_via_osascript()
        .map(|windows| windows.into_iter().map(|w| w.title).collect())
        .unwrap_or_default()
}

pub async fn activate_and_open_window(title: &str) -> Result<(), String> {
    let title = title.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let windows = list_windows_via_osascript()?;
        let window = windows
            .into_iter()
            .find(|w| w.title == title)
            .ok_or_else(|| format!("Window '{}' not found", title))?;

        // Activates the whole owning application, not this one specific window - AppleScript has
        // no "bring exactly this window to front" verb the way Windows' SetForegroundWindow does;
        // for an app with a single window (the overwhelmingly common case for what gets recorded)
        // this is indistinguishable in effect.
        let script = format!(
            r#"tell application "{}" to activate"#,
            window.process_name.replace('\\', "\\\\").replace('"', "\\\"")
        );
        let status = Command::new("osascript")
            .args(["-e", &script])
            .status()
            .map_err(|e| format!("Failed to activate '{}': {}", window.process_name, e))?;
        if !status.success() {
            return Err(format!("Failed to activate '{}'", window.process_name));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Activate window task panicked: {}", e))?
}

// Resolves a window title to BOTH the display ordinal (matching AVFoundation's "Capture screen N"
// order) and a display-local, clamped, even-dimensioned `(x, y, width, height)` crop rect.
// Translating System Events' global coordinates into the containing display's local origin fixes
// window recording on secondary monitors.
pub fn get_window_target_by_title(title: &str) -> Result<(usize, (i32, i32, i32, i32)), String> {
    let windows = list_windows_via_osascript()?;
    let win = windows
        .into_iter()
        .find(|w| w.title == title)
        .ok_or_else(|| format!("Window '{}' not found", title))?;

    let bounds = active_display_bounds();
    if bounds.is_empty() {
        let w = (win.width & !1).max(2);
        let h = (win.height & !1).max(2);
        return Ok((0, (win.x.max(0), win.y.max(0), w, h)));
    }

    let cx = win.x + win.width / 2;
    let cy = win.y + win.height / 2;
    let display_idx = bounds
        .iter()
        .position(|d| cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height)
        .or_else(|| bounds.iter().position(|d| d.is_primary))
        .unwrap_or(0);

    let d = bounds[display_idx];
    let local_x = (win.x - d.x).clamp(0, (d.width - 2).max(0));
    let local_y = (win.y - d.y).clamp(0, (d.height - 2).max(0));
    let max_w = (d.width - local_x).max(2);
    let max_h = (d.height - local_y).max(2);
    let local_w = (win.width.min(max_w) & !1).max(2);
    let local_h = (win.height.min(max_h) & !1).max(2);

    Ok((display_idx, (local_x, local_y, local_w, local_h)))
}

#[allow(dead_code)]
pub fn get_window_rect_by_title(title: &str) -> Result<(i32, i32, i32, i32), String> {
    let (_, rect) = get_window_target_by_title(title)?;
    Ok(rect)
}

/// Global screen-space rect of `title` (matching `CGEventGetLocation` coordinates for click and
/// pointer tracking).
#[allow(dead_code)]
pub fn get_window_global_rect_by_title(title: &str) -> Result<(i32, i32, i32, i32), String> {
    let windows = list_windows_via_osascript()?;
    windows
        .into_iter()
        .find(|w| w.title == title)
        .map(|w| (w.x, w.y, w.width, w.height))
        .ok_or_else(|| format!("Window '{}' not found", title))
}

struct MonitorHandle {
    running: Arc<AtomicBool>,
    join_handle: std::thread::JoinHandle<()>,
}

fn monitor_thread_slot() -> &'static Mutex<Option<MonitorHandle>> {
    static SLOT: OnceLock<Mutex<Option<MonitorHandle>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn last_two_windows() -> &'static Mutex<[String; 2]> {
    static TITLES: OnceLock<Mutex<[String; 2]>> = OnceLock::new();
    TITLES.get_or_init(|| Mutex::new([String::new(), String::new()]))
}

/// Queries the frontmost application's active window title (falling back to the app name when the
/// frontmost app has no titled window, e.g. Finder desktop).
fn query_frontmost_window_title() -> Option<String> {
    let script = r#"
tell application "System Events"
    set frontApp to first application process whose frontmost is true
    set appName to name of frontApp
    try
        set winTitle to name of front window of frontApp
        if winTitle is not "" then
            return winTitle
        end if
    end try
    return appName
end tell
"#;
    let output = Command::new("osascript").args(["-e", script]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!title.is_empty()).then_some(title)
}

pub async fn start_monitoring_windows() -> Result<(), String> {
    let mut slot = monitor_thread_slot().lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Err("Monitoring is already active".to_string());
    }
    let running = Arc::new(AtomicBool::new(true));
    let flag = running.clone();
    let join_handle = std::thread::spawn(move || {
        while flag.load(Ordering::Relaxed) {
            if let Some(title) = query_frontmost_window_title() {
                if let Ok(mut last_two) = last_two_windows().lock() {
                    if last_two[1] != title {
                        last_two[0] = last_two[1].clone();
                        last_two[1] = title;
                    }
                }
            }
            // Poll at 400ms in small sleep slices so stop_monitoring_windows exits promptly.
            for _ in 0..4 {
                if !flag.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    });
    *slot = Some(MonitorHandle { running, join_handle });
    log::info!("macOS window focus monitoring started");
    Ok(())
}

pub async fn stop_monitoring_windows() -> Result<(), String> {
    let handle = {
        let mut slot = monitor_thread_slot().lock().map_err(|e| e.to_string())?;
        slot.take()
    };
    match handle {
        Some(h) => {
            h.running.store(false, Ordering::Relaxed);
            let _ = h.join_handle.join();
            log::info!("macOS window focus monitoring stopped");
            Ok(())
        }
        None => Err("Monitoring is not active".to_string()),
    }
}

pub async fn get_window_titles() -> Result<WindowTitles, String> {
    let is_active = monitor_thread_slot()
        .lock()
        .map(|s| s.is_some())
        .unwrap_or(false);
    if !is_active {
        return Err("Monitoring is not active".to_string());
    }
    let titles = last_two_windows().lock().map_err(|e| e.to_string())?;
    Ok(WindowTitles {
        active: titles[1].clone(),
        last_active: titles[0].clone(),
    })
}
