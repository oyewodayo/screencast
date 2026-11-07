// services/autostart.rs
//
// "Start Briefcast when I sign in". Launches with `--tray` (services/main_window.rs), so Briefcast
// comes up in the tray with its shortcuts, tray menu and phone remote ready and no UI loaded - the
// window is built only when the user opens it.
//
// The OS holds the truth (a Run value, a LaunchAgent, an XDG autostart entry), not the settings
// file, so the two can never disagree - e.g. after the user removes it in Task Manager's Startup
// tab. Each mechanism is the per-user one: no admin rights, nothing system-wide.
//
// Written directly rather than through tauri-plugin-autostart: each is a single value or file, the
// crate already has the Win32 registry bindings, and it keeps the entry exactly under this app's
// control (the exact command line, refreshed when an update moves the executable).

use std::path::Path;

pub const LAUNCH_ARG: &str = crate::services::main_window::TRAY_LAUNCH_ARG;

/// `"C:\path\Briefcast.exe" --tray` - quoted, since install paths contain spaces.
pub fn command_line(exe: &Path) -> String {
    format!("\"{}\" {}", exe.display(), LAUNCH_ARG)
}

#[cfg(any(target_os = "macos", test))]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[cfg(any(target_os = "macos", test))]
/// macOS LaunchAgent: run at login, once, with the tray argument.
pub fn launch_agent_plist(label: &str, exe: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>{arg}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
        label = xml_escape(label),
        exe = xml_escape(&exe.display().to_string()),
        arg = LAUNCH_ARG
    )
}

#[cfg(any(target_os = "linux", test))]
/// XDG autostart entry (GNOME, KDE, XFCE...).
pub fn desktop_entry(exe: &Path) -> String {
    // Exec quoting per the Desktop Entry spec: the path in double quotes, with ", `, $ and \ escaped.
    let path = exe.display().to_string();
    let escaped: String = path
        .chars()
        .flat_map(|c| match c {
            '"' | '`' | '$' | '\\' => vec!['\\', c],
            _ => vec![c],
        })
        .collect();
    format!(
        "[Desktop Entry]\nType=Application\nName=Briefcast\nExec=\"{}\" {}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n",
        escaped, LAUNCH_ARG
    )
}

#[cfg(target_os = "windows")]
mod platform {
    use super::command_line;
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ};

    const KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    const VALUE: PCWSTR = w!("Briefcast");

    fn read() -> Option<String> {
        let mut len = 0u32;
        let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, KEY, VALUE, RRF_RT_REG_SZ, None, None, Some(&mut len)) };
        if status != ERROR_SUCCESS || len == 0 {
            return None;
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2)];
        let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, KEY, VALUE, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut len)) };
        if status != ERROR_SUCCESS {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }

    pub fn is_enabled() -> bool {
        read().is_some()
    }

    pub fn enable(exe: &std::path::Path) -> Result<(), String> {
        let value = HSTRING::from(command_line(exe));
        // REG_SZ data is the UTF-16 string including its terminating NUL.
        let bytes = ((value.len() + 1) * 2) as u32;
        let status = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, KEY, VALUE, REG_SZ.0, Some(value.as_ptr().cast()), bytes) };
        if status == ERROR_SUCCESS { Ok(()) } else { Err(format!("Couldn't add Briefcast to sign-in apps ({:?})", status)) }
    }

    pub fn disable() -> Result<(), String> {
        let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, KEY, VALUE) };
        // Already absent is the state we wanted.
        if status == ERROR_SUCCESS || read().is_none() {
            Ok(())
        } else {
            Err(format!("Couldn't remove Briefcast from sign-in apps ({:?})", status))
        }
    }

    pub fn points_at(exe: &std::path::Path) -> bool {
        read().is_some_and(|v| v == command_line(exe))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::PathBuf;
    const LABEL: &str = "com.withbriefs.briefcast";

    fn plist() -> Result<PathBuf, String> {
        let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
        Ok(PathBuf::from(home).join("Library/LaunchAgents").join(format!("{}.plist", LABEL)))
    }
    pub fn is_enabled() -> bool {
        plist().is_ok_and(|p| p.exists())
    }
    pub fn enable(exe: &std::path::Path) -> Result<(), String> {
        let path = plist()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, super::launch_agent_plist(LABEL, exe)).map_err(|e| e.to_string())
    }
    pub fn disable() -> Result<(), String> {
        match std::fs::remove_file(plist()?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
    pub fn points_at(exe: &std::path::Path) -> bool {
        plist().ok().and_then(|p| std::fs::read_to_string(p).ok()).is_some_and(|s| s == super::launch_agent_plist(LABEL, exe))
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::path::PathBuf;

    fn entry() -> Result<PathBuf, String> {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
            .ok_or("Neither XDG_CONFIG_HOME nor HOME is set")?;
        Ok(config.join("autostart").join("briefcast.desktop"))
    }
    pub fn is_enabled() -> bool {
        entry().is_ok_and(|p| p.exists())
    }
    pub fn enable(exe: &std::path::Path) -> Result<(), String> {
        let path = entry()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, super::desktop_entry(exe)).map_err(|e| e.to_string())
    }
    pub fn disable() -> Result<(), String> {
        match std::fs::remove_file(entry()?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
    pub fn points_at(exe: &std::path::Path) -> bool {
        entry().ok().and_then(|p| std::fs::read_to_string(p).ok()).is_some_and(|s| s == super::desktop_entry(exe))
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    pub fn is_enabled() -> bool {
        false
    }
    pub fn enable(_exe: &std::path::Path) -> Result<(), String> {
        Err("Starting at sign-in isn't available on this platform.".into())
    }
    pub fn disable() -> Result<(), String> {
        Ok(())
    }
    pub fn points_at(_exe: &std::path::Path) -> bool {
        true
    }
}

fn current_exe() -> Result<std::path::PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("Couldn't find Briefcast's own executable: {}", e))
}

/// At startup: an enabled entry that points at an old executable (an update or a reinstall moved
/// it) is rewritten, so signing in never launches a path that no longer exists.
pub fn refresh() {
    if !platform::is_enabled() {
        return;
    }
    if let Ok(exe) = current_exe() {
        if !platform::points_at(&exe) {
            if let Err(e) = platform::enable(&exe) {
                log::warn!("autostart: couldn't refresh the sign-in entry: {}", e);
            }
        }
    }
}

#[tauri::command]
pub async fn get_launch_at_login() -> bool {
    crate::services::responsiveness::blocking(platform::is_enabled).await.unwrap_or(false)
}

#[tauri::command]
pub async fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    crate::services::responsiveness::blocking(move || {
        if enabled {
            platform::enable(&current_exe()?)
        } else {
            platform::disable()
        }
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn command_line_quotes_paths_with_spaces() {
        let exe = PathBuf::from(r"C:\Program Files\Briefcast\Briefcast.exe");
        assert_eq!(command_line(&exe), r#""C:\Program Files\Briefcast\Briefcast.exe" --tray"#);
    }

    #[test]
    fn plist_escapes_xml_and_carries_the_tray_arg() {
        let p = launch_agent_plist("com.example", &PathBuf::from("/Apps/R&D <x>/Briefcast"));
        assert!(p.contains("<string>/Apps/R&amp;D &lt;x&gt;/Briefcast</string>"));
        assert!(p.contains("<string>--tray</string>"));
        assert!(p.contains("<key>RunAtLoad</key>\n  <true/>"));
    }

    #[test]
    fn desktop_entry_escapes_exec_specials() {
        let e = desktop_entry(&PathBuf::from("/opt/my $app/brief\"cast"));
        assert!(e.contains(r#"Exec="/opt/my \$app/brief\"cast" --tray"#), "{e}");
    }
}
