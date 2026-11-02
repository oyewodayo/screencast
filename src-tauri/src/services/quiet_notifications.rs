// Keeps Windows toast notifications (WhatsApp, mail...) out of a recording.
//
// Windows has no per-app "don't disturb" switch an app may flip for itself, so this turns off the
// user's own toast setting (Settings > Notifications > "Get notifications from apps and other
// senders", HKCU\...\PushNotifications\ToastEnabled) when a recording starts and puts it back when
// it stops. Because a crash or a kill mid-recording would otherwise leave the user's notifications
// off for good, the value to restore is written to a marker file first, and restore() also runs at
// startup to undo a muted session that never got to finish.

#[cfg(target_os = "windows")]
mod win {
    use std::fs;
    use std::path::PathBuf;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_DWORD, RRF_RT_REG_DWORD,
    };

    const KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications");
    const VALUE: PCWSTR = w!("ToastEnabled");

    fn marker() -> Result<PathBuf, String> {
        Ok(crate::services::utility::briefcast_dir()?.join("notifications-muted"))
    }

    fn read() -> Option<u32> {
        let mut data = 0u32;
        let mut len = 4u32;
        let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, KEY, VALUE, RRF_RT_REG_DWORD, None, Some((&mut data as *mut u32).cast()), Some(&mut len)) };
        (status == ERROR_SUCCESS).then_some(data)
    }

    fn write(value: u32) -> Result<(), String> {
        let status = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, KEY, VALUE, REG_DWORD.0, Some((&value as *const u32).cast()), 4) };
        if status == ERROR_SUCCESS { Ok(()) } else { Err(format!("registry write failed ({:?})", status)) }
    }

    pub fn mute() -> Result<(), String> {
        let marker = marker()?;
        // Already muted by an earlier start (or already off for the user): nothing to take over.
        if marker.exists() {
            return Ok(());
        }
        // An absent value means "on" to Windows.
        let previous = read();
        if previous == Some(0) {
            return Ok(());
        }
        let saved = previous.map(|v| v.to_string()).unwrap_or_else(|| "absent".to_string());
        fs::write(&marker, saved).map_err(|e| format!("couldn't write the restore marker: {}", e))?;
        if let Err(e) = write(0) {
            let _ = fs::remove_file(&marker);
            return Err(e);
        }
        Ok(())
    }

    pub fn restore() -> Result<(), String> {
        let marker = marker()?;
        let Ok(saved) = fs::read_to_string(&marker) else { return Ok(()) };
        match saved.trim().parse::<u32>() {
            Ok(v) => write(v)?,
            // The value didn't exist before - deleting it is "on" again.
            Err(_) => unsafe {
                let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, KEY, VALUE);
            },
        }
        let _ = fs::remove_file(&marker);
        Ok(())
    }
}

pub fn mute() {
    #[cfg(target_os = "windows")]
    if let Err(e) = win::mute() {
        log::warn!("Couldn't mute notifications for the recording: {}", e);
    }
}

pub fn restore() {
    #[cfg(target_os = "windows")]
    if let Err(e) = win::restore() {
        log::warn!("Couldn't restore notifications after the recording: {}", e);
    }
}
