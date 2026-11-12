// services/macos_permissions.rs
//
// Checks and prompts for macOS privacy permissions (Screen Recording and Accessibility)
// so the user receives clear, upfront guidance before attempting to record, rather than
// encountering an unexpected silent failure or blank screen.

#[derive(serde::Serialize, Default)]
pub struct MacosPermissionsStatus {
    pub screen_recording: bool,
    pub accessibility: bool,
}

#[tauri::command(async)]
pub fn check_macos_permissions() -> MacosPermissionsStatus {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        // Check Screen Recording: screencapture -c checks capture capability
        let screen_recording = Command::new("screencapture")
            .args(["-c"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        // Check Accessibility via System Events query
        let accessibility = Command::new("osascript")
            .args(["-e", "tell application \"System Events\" to get name of current user"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        MacosPermissionsStatus {
            screen_recording,
            accessibility,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        MacosPermissionsStatus {
            screen_recording: true,
            accessibility: true,
        }
    }
}

#[tauri::command(async)]
pub fn open_macos_permission_settings(pane: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let url = match pane.as_str() {
            "accessibility" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        };
        Command::new("open")
            .arg(url)
            .status()
            .map_err(|e| format!("Failed to open Settings: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pane;
        Ok(())
    }
}
