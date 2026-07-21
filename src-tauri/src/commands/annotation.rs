// commands/annotation.rs
//
// Backend for the system-wide "stylus annotation" overlay - a transparent, always-on-top window
// spanning every connected monitor that the user can toggle into "draw mode" (via a global
// hotkey, from the frontend) to circle/underline/emphasize anything on screen while presenting or
// recording. All actual drawing, fading, and the floating toolbar live entirely in the overlay's
// own page (src/components/AnnotationOverlayWindow.tsx) - this module only owns creating and
// correctly positioning the window itself, which needs real monitor geometry (get_monitors,
// already used for screen-capture targeting) that a plain WindowBuilder can't compute on its own.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size};

use super::window_capture::get_monitors;

pub const ANNOTATION_OVERLAY_LABEL: &str = "annotation-overlay";

// Idempotent - a no-op if the window already exists (e.g. the setting was toggled off and back
// on this session). Monitor topology is only computed once, at first creation; reconnecting or
// rearranging monitors while the overlay is already alive isn't handled - a rare edge case, worth
// revisiting only if it turns out to matter in practice (the fix would just be re-running this
// bounds computation and re-applying set_position/set_size to the existing window).
#[tauri::command]
pub fn ensure_annotation_overlay(app_handle: AppHandle) -> Result<(), String> {
    if app_handle.get_window(ANNOTATION_OVERLAY_LABEL).is_some() {
        return Ok(());
    }

    let monitors = get_monitors(app_handle.clone())?;
    if monitors.is_empty() {
        return Err("No monitors detected".to_string());
    }

    // Union of every monitor's bounds, in physical pixels - same union this app already computes
    // for clamp_rect_to_desktop (window_capture.rs), just kept local here since that helper is
    // `pub(crate)` for a different purpose and this only needs the four extremes once.
    let min_x = monitors.iter().map(|m| m.x).min().unwrap();
    let min_y = monitors.iter().map(|m| m.y).min().unwrap();
    let max_x = monitors.iter().map(|m| m.x + m.width).max().unwrap();
    let max_y = monitors.iter().map(|m| m.y + m.height).max().unwrap();
    let total_width = (max_x - min_x).max(1) as u32;
    let total_height = (max_y - min_y).max(1) as u32;

    let window = tauri::WindowBuilder::new(
        &app_handle,
        ANNOTATION_OVERLAY_LABEL,
        tauri::WindowUrl::App("/annotation-overlay".into()),
    )
    .title("Annotation")
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .minimizable(false)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|e| format!("Failed to create annotation overlay window: {}", e))?;

    // WindowBuilder's own position()/inner_size() take logical units, which would need a DPI
    // conversion that isn't well-defined across monitors with different scale factors. Setting
    // physical position/size directly after build sidesteps that entirely - these bounds already
    // came from get_monitors in physical pixels (the same units gdigrab/x11grab screen capture
    // already relies on it for).
    window
        .set_position(Position::Physical(PhysicalPosition { x: min_x, y: min_y }))
        .map_err(|e| format!("Failed to position annotation overlay: {}", e))?;
    window
        .set_size(Size::Physical(PhysicalSize {
            width: total_width,
            height: total_height,
        }))
        .map_err(|e| format!("Failed to size annotation overlay: {}", e))?;

    // Deliberately left hidden (and click-through is NOT set here) - this window is only ever
    // shown for the brief, user-initiated span while draw mode is actually on (see Dashboard.tsx's
    // toggleAnnotationDrawMode, which shows/hides it and applies ignore-cursor-events together, in
    // that order). An earlier version called set_ignore_cursor_events(true) here and then showed
    // the window immediately at every app launch so it could sit idle-but-click-through in the
    // background - on Windows, setting that style before the window is ever shown doesn't reliably
    // take effect, which meant the click-through never actually applied and this invisible,
    // always-on-top, all-monitors-spanning window silently ate every click on the whole desktop
    // from the moment the app started. Staying hidden until deliberately toggled on means a window
    // that fails to go click-through can never do that again - hidden blocks nothing, regardless.
    Ok(())
}
