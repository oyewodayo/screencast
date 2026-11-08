// services/tray.rs
//
// The tray icon by the clock. Closing the main window hides Briefcast here instead of quitting
// (settings.closeToTray, src/utils/closeGuards.ts), so the global shortcuts keep working; the
// icon brings the window back, and its menu records, takes a screenshot or quits without opening
// it. Menu picks go to the main window as a `tray-action` event while it exists (its flow has the
// start sound, phone capture and save-on-quit guards); with the window released to the tray they
// are handled in Rust (services/recording_session.rs). While recording the icon carries a red dot:
// with the window hidden and the recording bar tucked away (Ctrl+Shift+H) it's the only sign one is
// running. The dot is set by the recording commands themselves, whoever started the recording.
//
// Desktop only: Tauri has no tray (and no show/hide/focus of a window) on Android or iOS. The
// public surface below is identical on every platform so callers and the command list need no
// cfg of their own; on mobile each call is a no-op.

#[cfg(desktop)]
mod imp {
    use std::sync::Mutex;

    use serde::Serialize;
    use tauri::image::Image;
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
    use tauri::{AppHandle, Emitter, Manager, Wry};

    struct Tray {
        icon: TrayIcon,
        record: Submenu<Wry>,
        stop: MenuItem<Wry>,
        idle: Image<'static>,
        recording: Image<'static>,
    }

    #[derive(Default)]
    pub struct TrayState(Mutex<Option<Tray>>);

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TrayAction {
        action: &'static str,
        record_type: Option<&'static str>,
    }

    // The recording setups the "Start recording" submenu offers - record_type values start_recording
    // takes (commands/recording.rs). "sv" isn't one, hence no screen + camera without the mic.
    const RECORD_SETUPS: [(&str, &str); 5] = [
        ("sa", "Screen + mic"),
        ("sva", "Screen + camera + mic"),
        ("s", "Screen only"),
        ("va", "Camera + mic"),
        ("a", "Mic only"),
    ];

    /// Brings Briefcast forward, rebuilding the main window if it was released to the tray.
    pub fn show_main(app: &AppHandle) {
        crate::services::main_window::show(app);
    }

    /// With the main window alive its page handles the pick; without it, Rust does.
    fn send(app: &AppHandle, action: &'static str, record_type: Option<&'static str>) {
        use crate::services::recording_session::{handle, Request};
        if crate::services::main_window::exists(app) {
            let _ = app.emit_to("main", "tray-action", TrayAction { action, record_type });
            return;
        }
        let rt = record_type.map(str::to_owned);
        match action {
            "record" => handle(app, Request::Start(rt)),
            "stop" => handle(app, Request::Stop),
            "screenshot" => handle(app, Request::Screenshot),
            _ => {}
        }
    }

    fn on_menu(app: &AppHandle, id: &str) {
        match id {
            "open" => show_main(app),
            "record:current" => send(app, "record", None),
            "stop" => send(app, "stop", None),
            "screenshot" => send(app, "screenshot", None),
            // The main window runs the save-on-quit / "recording in progress" guards and then closes,
            // which quits (lib.rs). Without one, a recording in progress is stopped and saved first.
            "quit" if crate::services::main_window::exists(app) => {
                let _ = app.emit_to("main", "tray-action", TrayAction { action: "quit", record_type: None });
            }
            "quit" => quit_without_window(app),
            _ => {
                let setup = id.strip_prefix("record:").and_then(|rt| RECORD_SETUPS.iter().find(|(r, _)| *r == rt));
                if let Some((record_type, _)) = setup {
                    send(app, "record", Some(record_type));
                }
            }
        }
    }

    /// Quit from the tray with no window: a recording in progress is stopped properly first, so its
    /// parts are assembled into a file instead of being cut off.
    fn quit_without_window(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<crate::commands::recording::AppState>();
            if crate::commands::recording::get_recording_status(state.clone()).await.is_ok_and(|s| s.recording) {
                if let Err(e) = crate::commands::recording::stop_recording(app.clone(), state).await {
                    log::warn!("stopping the recording before quitting: {}", e);
                }
            }
            crate::services::main_window::request_quit(&app);
            app.exit(0);
        });
    }

    // The app icon with a red dot in its corner, ringed in white so it reads on light and dark
    // taskbars alike. Drawn from the bundled icon rather than shipped as a second image, so the two
    // can never drift apart.
    fn with_recording_dot(icon: &Image<'_>) -> Image<'static> {
        let (w, h) = (icon.width() as usize, icon.height() as usize);
        let mut rgba = icon.rgba().to_vec();
        let r = w.min(h) as f64 * 0.25;
        let ring = (r * 0.25).max(1.0);
        let (cx, cy) = (w as f64 - r, h as f64 - r);
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt();
                let cover = (r + 0.5 - d).clamp(0.0, 1.0);
                if cover <= 0.0 {
                    continue;
                }
                let red = (r - ring + 0.5 - d).clamp(0.0, 1.0);
                let color = [255.0 - 16.0 * red, 255.0 - 187.0 * red, 255.0 - 187.0 * red]; // white -> #ef4444
                let px = &mut rgba[(y * w + x) * 4..(y * w + x) * 4 + 4];
                let under = px[3] as f64 / 255.0;
                let alpha = cover + under * (1.0 - cover);
                for c in 0..3 {
                    px[c] = ((color[c] * cover + px[c] as f64 * under * (1.0 - cover)) / alpha).round() as u8;
                }
                px[3] = (alpha * 255.0).round() as u8;
            }
        }
        Image::new_owned(rgba, w as u32, h as u32)
    }

    pub fn install(app: &AppHandle) -> tauri::Result<()> {
        let Some(idle) = app.default_window_icon().cloned().map(Image::to_owned) else {
            log::warn!("No app icon to build the tray icon from");
            return Ok(());
        };
        let recording = with_recording_dot(&idle);

        let current = MenuItem::with_id(app, "record:current", "With my current setup", true, None::<&str>)?;
        let setups = RECORD_SETUPS
            .iter()
            .map(|(record_type, label)| MenuItem::with_id(app, format!("record:{record_type}"), *label, true, None::<&str>))
            .collect::<tauri::Result<Vec<_>>>()?;
        let separator = PredefinedMenuItem::separator(app)?;
        let mut record_items: Vec<&dyn IsMenuItem<Wry>> = vec![&current, &separator];
        record_items.extend(setups.iter().map(|item| item as &dyn IsMenuItem<Wry>));
        let record = Submenu::with_id_and_items(app, "record", "Start recording", true, &record_items)?;

        let open = MenuItem::with_id(app, "open", "Open Briefcast", true, None::<&str>)?;
        let stop = MenuItem::with_id(app, "stop", "Stop recording", false, None::<&str>)?;
        let screenshot = MenuItem::with_id(app, "screenshot", "Take a screenshot", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit Briefcast", true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[
                &open,
                &PredefinedMenuItem::separator(app)?,
                &record,
                &stop,
                &screenshot,
                &PredefinedMenuItem::separator(app)?,
                &quit,
            ],
        )?;

        let icon = TrayIconBuilder::with_id("main")
            .icon(idle.clone())
            .tooltip("Briefcast")
            .menu(&menu)
            // Left click opens the window, like every other tray app; the menu is a right click.
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show_main(tray.app_handle());
                }
            })
            .build(app)?;

        *app.state::<TrayState>().0.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Tray { icon, record, stop, idle, recording });
        Ok(())
    }

    /// Red dot while recording. Called by the recording commands (services/recording_session.rs).
    pub fn set_recording(app: &AppHandle, recording: bool) {
        let state = app.state::<TrayState>();
        let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(tray) = guard.as_ref() else { return };
        let _ = tray.icon.set_icon(Some(if recording { tray.recording.clone() } else { tray.idle.clone() }));
        let _ = tray.icon.set_tooltip(Some(if recording { "Briefcast - recording" } else { "Briefcast" }));
        let _ = tray.record.set_enabled(!recording);
        let _ = tray.stop.set_enabled(recording);
    }
}

#[cfg(mobile)]
mod imp {
    use super::*;

    #[derive(Default)]
    pub struct TrayState;

    pub fn show_main(_app: &AppHandle) {}

    pub fn set_recording(_app: &AppHandle, _recording: bool) {}

    pub fn install(_app: &AppHandle) -> tauri::Result<()> {
        Ok(())
    }

}

#[allow(unused_imports)]
use tauri::AppHandle;
pub use imp::*;
