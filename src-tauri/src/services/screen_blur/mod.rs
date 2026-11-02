// services/screen_blur/ - privacy blur for the annotation overlay.
//
// Rectangles of the real desktop blurred live, so a password, a chat list or an account number
// stays unreadable on screen, in a recording and in a screen share - while the app underneath keeps
// working (you can still click and type into it). Regions come from four places:
//   - drawn by hand with the overlay's Blur tool (B);
//   - the whole active window, toggled with Ctrl+Alt+B from anywhere;
//   - the WhatsApp rule: its chat list, the open chat's contact name + photo, and optionally the
//     messages, found from the window's own pixels (layout.rs);
//   - the sensitive-text rule: the foreground window read with Windows' OCR (ocr.rs) and checked
//     for passwords, keys, card/bank numbers and the user's keywords (sensitive.rs).
//
// Each region is its own tiny click-through native window (layered + WS_EX_TRANSPARENT +
// WS_EX_NOACTIVATE: every click and key goes to what's under it, and it never takes focus) whose
// content is a Windows.UI.Composition visual painted with the *host backdrop* brush - the blurred
// desktop behind the window, the same thing acrylic is made of - with an optional extra Gaussian
// blur and a frost tint on top (the strength setting). Why this and not the alternatives - all
// measured on this machine (Win11 22000):
//   - A transparent webview's backdrop-filter only sees the page itself, never the desktop.
//   - Capturing the screen and blurring it ourselves needs our window hidden from capture, and the
//     recorder captures through that same path (Desktop Duplication / gdigrab) - the recording
//     would come out unblurred. DWM-composited blur shows up in both capture paths.
//   - The DWM acrylic *accent* (SetWindowCompositionAttribute) looks the same, but every resize of
//     an acrylic window costs DWM two frames: a box being dragged out updated at 30fps while
//     everything else composed at 60, so the blur visibly trailed the outline. A composition
//     visual in a no-redirection-bitmap window resizes at a full 60fps, and lets us control the
//     strength. The window-region trick doesn't work - the accent ignores SetWindowRgn.
// When Windows' transparency effects are off (a setting, or battery saver), the host backdrop isn't
// trustworthy, so regions switch to solid frost - fail closed, never open.
//
// While a region is being drawn, moved or resized, the native side tracks the cursor itself -
// vsync-paced (DwmFlush) GetCursorPos on the worker thread - instead of being fed a position per
// pointermove over IPC. The overlay's outline follows the same physical cursor, so the two stay
// locked together with no round trip and nothing to queue up behind.
//
// A region over an app window is *owned* by that window (SetWindowLongPtr GWLP_HWNDPARENT - verified
// to work across processes), so it sits directly above it in z-order: a window dragged over the app
// covers its blur too, instead of the blur floating over everything. A WinEvent hook moves the
// region with its window and hides it while the window is minimized, hidden (closed to tray),
// cloaked (another virtual desktop) or gone. Regions over the desktop/taskbar are topmost instead.
//
// Coordinates cross the JS boundary in the annotation overlay's own CSS pixels, converted with the
// overlay's ClientToScreen + GetDpiForWindow in one place - see get_cursor_position_in_window
// (utility.rs) for why mixing in Tauri's JS-side window geometry gave wrong positions at 250%.
use serde::{Deserialize, Serialize};

pub mod layout;
pub mod sensitive;
#[cfg(target_os = "windows")]
mod ocr;
#[cfg(target_os = "windows")]
mod win;

pub use sensitive::TextRules;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlurRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlurRegion {
    pub id: String,
    // In the overlay's CSS pixels.
    pub rect: BlurRect,
    // False while the window it follows is minimized/hidden/on another desktop.
    pub visible: bool,
    // Follows an app window (vs. pinned to the screen).
    pub anchored: bool,
    // Placed by a rule rather than drawn by hand - not movable; `label` names it ("WhatsApp
    // chats", "API key", "Whole window").
    pub auto: bool,
    pub label: Option<String>,
}

// Which parts of WhatsApp the WhatsApp rule covers.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhatsAppParts {
    pub chat_list: bool,
    // The open chat's avatar and name, in its header.
    pub contact: bool,
    pub messages: bool,
}

// Each caller sends what it owns (the strength slider doesn't know whether a recording is running);
// a missing field keeps its current value.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlurConfig {
    // 0..100: 0 is the host backdrop's own blur (already unreadable); up from there adds Gaussian
    // blur and frost.
    pub strength: Option<f64>,
    pub auto_whatsapp: Option<bool>,
    pub whatsapp_parts: Option<WhatsAppParts>,
    pub auto_text: Option<bool>,
    pub text_rules: Option<TextRules>,
}

// What a drag is doing - the corner is the one under the pointer (the opposite one stays put).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum GestureMode {
    New,
    Move,
    Resize { corner: Corner },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Corner {
    Nw,
    Ne,
    Sw,
    Se,
}

pub const CHANGED_EVENT: &str = "screen-blur-changed";

#[cfg(target_os = "windows")]
fn overlay_hwnd(window: &tauri::Window) -> Result<isize, String> {
    Ok(window.hwnd().map_err(|e| format!("Couldn't reach the overlay window: {}", e))?.0 as isize)
}

// Creates the region `id`, or moves/resizes it if it exists. `rect` is in the calling window's
// (the annotation overlay's) CSS pixels; the region attaches to whichever app window is under its
// centre.
#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn screen_blur_set(app: tauri::AppHandle, window: tauri::Window, id: String, rect: BlurRect) -> Result<(), String> {
    win::set(&app, overlay_hwnd(&window)?, id, rect)
}

// A drag starts: from here the native side follows the cursor itself until screen_blur_gesture_end.
// `rect` is the region's rect at the start (CSS px), `pointer` where the press landed.
#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn screen_blur_gesture_begin(app: tauri::AppHandle, window: tauri::Window, id: String, mode: GestureMode, rect: BlurRect, pointer: (f64, f64)) -> Result<(), String> {
    win::gesture_begin(&app, overlay_hwnd(&window)?, id, mode, rect, pointer)
}

#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn screen_blur_gesture_end(window: tauri::Window, id: String, rect: BlurRect) -> Result<(), String> {
    win::gesture_end(overlay_hwnd(&window)?, id, rect)
}

#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn screen_blur_remove(id: String) -> Result<(), String> {
    win::remove(id)
}

#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn screen_blur_clear() -> Result<(), String> {
    win::clear()
}

#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn screen_blur_list(window: tauri::Window) -> Result<Vec<BlurRegion>, String> {
    win::list(overlay_hwnd(&window)?)
}

// Strength and the auto-blur rules - sent by the main window on launch, on settings changes and
// when recording starts/stops ("while recording" rules), and live from the strength slider.
#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn screen_blur_configure(app: tauri::AppHandle, config: BlurConfig) -> Result<(), String> {
    win::configure(&app, config)
}

// Blur the active window, or unblur it if it already is (the global Ctrl+Alt+B).
#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn screen_blur_toggle_window(app: tauri::AppHandle) -> Result<(), String> {
    win::toggle_window(&app)
}

// The OCR language sensitive-text detection would use, or None when Windows has no OCR language
// installed (Settings explains how to add one).
#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn screen_blur_ocr_language() -> Option<String> {
    ocr::availability()
}

#[cfg(not(target_os = "windows"))]
#[tauri::command(async)]
pub fn screen_blur_set(_id: String, _rect: BlurRect) -> Result<(), String> {
    Err("Screen blur is only available on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command(async)]
pub fn screen_blur_gesture_begin(_id: String, _mode: GestureMode, _rect: BlurRect, _pointer: (f64, f64)) -> Result<(), String> {
    Err("Screen blur is only available on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command(async)]
pub fn screen_blur_gesture_end(_id: String, _rect: BlurRect) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command(async)]
pub fn screen_blur_remove(_id: String) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command(async)]
pub fn screen_blur_clear() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command(async)]
pub fn screen_blur_list() -> Result<Vec<BlurRegion>, String> {
    Ok(Vec::new())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command(async)]
pub fn screen_blur_configure(_config: BlurConfig) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command(async)]
pub fn screen_blur_toggle_window() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command(async)]
pub fn screen_blur_ocr_language() -> Option<String> {
    None
}
