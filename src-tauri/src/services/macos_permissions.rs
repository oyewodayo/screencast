// services/macos_permissions.rs
//
// Checks and prompts for macOS privacy permissions (Screen Recording and Accessibility)
// using native CoreGraphics / ApplicationServices APIs so users receive clear upfront
// onboarding instead of opaque ffmpeg errors or blank captures.

#[derive(serde::Serialize, Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MacosPermissionsStatus {
    pub screen_recording: bool,
    pub accessibility: bool,
}

#[cfg(target_os = "macos")]
mod native {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        /// Non-intrusive check (macOS 10.15+): returns whether this process has Screen Recording
        /// TCC permission without showing a prompt or modifying the clipboard.
        pub fn CGPreflightScreenCaptureAccess() -> bool;
        /// Prompts macOS to add the app to Screen Recording settings and returns current access.
        pub fn CGRequestScreenCaptureAccess() -> bool;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        /// Returns whether this process is trusted for Accessibility (window picker & shortcuts).
        pub fn AXIsProcessTrusted() -> bool;
    }
}

#[tauri::command(async)]
pub fn check_macos_permissions() -> MacosPermissionsStatus {
    #[cfg(target_os = "macos")]
    {
        let screen_recording = unsafe { native::CGPreflightScreenCaptureAccess() };
        let accessibility = unsafe { native::AXIsProcessTrusted() };
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
pub fn request_macos_screen_recording_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { native::CGRequestScreenCaptureAccess() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command(async)]
pub fn open_macos_permission_settings(pane: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let url = match pane.as_str() {
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_macos_permissions_default_granted() {
        #[cfg(not(target_os = "macos"))]
        {
            let status = check_macos_permissions();
            assert!(status.screen_recording);
            assert!(status.accessibility);
            assert!(request_macos_screen_recording_permission());
        }
    }
}
