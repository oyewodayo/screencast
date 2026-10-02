// commands/presentation.rs
//
// The live camera display ("Present" mode in the Screen Options modal): a borderless full-screen
// window showing the selected cameras on a chosen monitor - typically a TV or projector fed from
// the PC's second display output, at a church service or event. The page itself
// (src/components/PresentationWindow.tsx) opens the cameras and follows the layout the main
// window sends it; this module only creates the window on the right monitor and closes it.
//
// Built here rather than with `new WebviewWindow` from the page for the same reasons as
// ensure_annotation_overlay (annotation.rs): window creation from JS is unproven in this app,
// placement needs the monitor's physical geometry (get_monitors), and `.build()` must run off the
// main thread or the invoke deadlocks.

use tauri::{AppHandle, Manager, PhysicalPosition, Position};

use super::window_capture::get_monitors;

pub const PRESENTATION_LABEL: &str = "presentation";

// Opens the display full screen on `monitor_id` (an id from get_monitors), or moves it there if
// it's already open. No id - or an id that's gone (a TV unplugged since the list was fetched) -
// falls back to the last monitor: on a laptop with a TV attached that's the TV, and on a single
// display it's the only one.
#[tauri::command]
pub async fn open_presentation_window(app_handle: AppHandle, monitor_id: Option<String>) -> Result<(), String> {
    let monitors = get_monitors(app_handle.clone())?;
    let monitor = monitor_id
        .as_deref()
        .and_then(|id| monitors.iter().find(|m| m.id == id))
        .or_else(|| monitors.last())
        .ok_or_else(|| "No monitors detected".to_string())?;
    let (x, y) = (monitor.x, monitor.y);

    tauri::async_runtime::spawn_blocking(move || {
        let window = match app_handle.get_webview_window(PRESENTATION_LABEL) {
            Some(window) => {
                // Fullscreen pins the window to its current monitor, so leave it before moving.
                let _ = window.set_fullscreen(false);
                window
            }
            None => tauri::WebviewWindowBuilder::new(
                &app_handle,
                PRESENTATION_LABEL,
                tauri::WebviewUrl::App("/presentation".into()),
            )
            .title("Briefcast Live Display")
            .decorations(false)
            .resizable(true)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| format!("Failed to create the live display window: {}", e))?,
        };

        // Physical coordinates straight from get_monitors - see ensure_annotation_overlay for
        // why not the builder's logical position(). Then full screen on whichever monitor the
        // window now sits on.
        window
            .set_position(Position::Physical(PhysicalPosition { x: x + 50, y: y + 50 }))
            .map_err(|e| format!("Failed to place the live display: {}", e))?;
        window
            .set_fullscreen(true)
            .map_err(|e| format!("Failed to make the live display full screen: {}", e))?;
        window
            .show()
            .map_err(|e| format!("Failed to show the live display: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Live display task failed: {}", e))?
}

#[tauri::command]
pub async fn close_presentation_window(app_handle: AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window(PRESENTATION_LABEL) {
        // close() releases the cameras along with the page; hiding would keep them open.
        window
            .close()
            .map_err(|e| format!("Failed to close the live display: {}", e))?;
    }
    Ok(())
}
