// services/share.rs
//
// Getting an exported document out of Briefcast and in front of other people, without the user
// having to go and find the file first. The frontend (DocShareDialog.tsx) exports into a staging
// folder (share_staging_path) and then hands that file to one of:
//   - the Windows share sheet (share_file_native) - every installed share target: Outlook, Mail,
//     WhatsApp, Teams, Nearby Share, OneDrive...
//   - the default desktop mail client with the file already attached (email_file, Simple MAPI)
//   - the clipboard as a file (copy_file_to_clipboard), so Ctrl+V drops it into any chat app,
//     web mail compose window or Explorer folder
//   - a chat/mail app or web compose page opened by URL (open_share_url)
// share_capabilities tells the dialog which of those this machine can actually do.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::command;

use super::responsiveness::{blocking, serial};

// Each share gets its own subfolder so the file keeps the document's clean title as its name
// ("Project proposal.pdf" is what the recipient sees) without colliding with an earlier share.
// Staged files are left in place for a day rather than deleted right away - share targets and mail
// clients read the attachment asynchronously, sometimes long after the call that handed it over.
#[command(async)]
pub fn share_staging_path(file_name: String) -> Result<String, String> {
    let _serial = serial();
    let name = file_name.trim();
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.contains("..") {
        return Err("Invalid file name".to_string());
    }
    let root = std::env::temp_dir().join("Briefcast Share");
    prune_stale(&root);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = root.join(stamp.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't prepare the file for sharing: {}", e))?;
    Ok(dir.join(name).to_string_lossy().to_string())
}

fn prune_stale(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let day = std::time::Duration::from_secs(24 * 60 * 60);
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|age| age > day)
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn existing_file(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if p.is_file() {
        Ok(p)
    } else {
        Err("The file to share no longer exists".to_string())
    }
}

#[derive(Serialize)]
pub struct ShareCapabilities {
    /// The Windows share sheet is available.
    native_share: bool,
    /// Display name of the Simple MAPI mail client (Outlook, Thunderbird...) - None when there is
    /// none, which is the common case for people who use web mail or the new Outlook.
    mail_client: Option<String>,
    /// URL schemes from the dialog's app list that some installed app handles, e.g. "whatsapp".
    apps: Vec<String>,
}

#[command(async)]
pub fn share_capabilities(schemes: Vec<String>) -> ShareCapabilities {
    let _serial = serial();
    #[cfg(windows)]
    {
        ShareCapabilities {
            native_share: win::share_supported(),
            mail_client: win::mapi_client_name(),
            apps: schemes.into_iter().filter(|s| win::protocol_handled(s)).collect(),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = schemes;
        ShareCapabilities { native_share: false, mail_client: None, apps: Vec::new() }
    }
}

// Only URLs the share dialog builds itself: web pages, mailto, and the chat apps it lists. Anything
// else (file:, ms-settings:, a javascript: smuggled through a doc title) is refused.
const ALLOWED_SCHEMES: [&str; 8] = ["https", "mailto", "whatsapp", "tg", "slack", "msteams", "discord", "skype"];

#[command(async)]
pub fn open_share_url(url: String) -> Result<(), String> {
    let _serial = serial();
    let scheme = url.split(':').next().unwrap_or("").to_ascii_lowercase();
    if !ALLOWED_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!("Can't open {}: links", scheme));
    }
    #[cfg(windows)]
    {
        win::shell_open(&url)
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

#[command(async)]
pub fn copy_file_to_clipboard(path: String) -> Result<(), String> {
    let _serial = serial();
    let file = existing_file(&path)?;
    #[cfg(windows)]
    {
        win::copy_file(&file)
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Err("Copying files to the clipboard is only available on Windows".to_string())
    }
}

#[command]
pub async fn share_file_native(window: tauri::WebviewWindow, path: String, title: String, description: String) -> Result<(), String> {
    let file = existing_file(&path)?;
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| format!("Couldn't reach the window: {}", e))?.0 as isize;
        // Resolving the StorageFile is async I/O; done off the UI thread, then handed over as an
        // agile reference (WinRT objects aren't Send) for the share sheet's DataRequested handler.
        let item = blocking(move || win::storage_file(&file)).await??;
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(win::show_share_ui(hwnd, item, title, description));
            })
            .map_err(|e| e.to_string())?;
        blocking(move || rx.recv()).await?.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, file, title, description);
        Err("The share sheet is only available on Windows".to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EmailOutcome {
    /// The mail client's compose window opened with the file attached.
    Opened,
    /// The user closed the compose window without sending.
    Cancelled,
    /// No usable Simple MAPI client - the frontend falls back to web mail / mailto.
    Unavailable,
}

#[command]
pub async fn email_file(path: String, subject: String, body: String, to: Vec<String>) -> Result<EmailOutcome, String> {
    let file = existing_file(&path)?;
    #[cfg(windows)]
    {
        if win::mapi_client_name().is_none() {
            return Ok(EmailOutcome::Unavailable);
        }
        // MAPISendMail blocks until the compose window is dealt with (or, modeless, handed off),
        // and Outlook wants an STA thread of its own - so a dedicated thread, not the async pool.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(win::mapi_send(&file, &subject, &body, &to));
        });
        blocking(move || rx.recv()).await?.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (file, subject, body, to);
        Ok(EmailOutcome::Unavailable)
    }
}

#[cfg(windows)]
mod win {
    use super::EmailOutcome;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::Mutex;
    use windows::core::{factory, w, AgileReference, Interface, HSTRING, PCWSTR, PWSTR};
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows::Foundation::Collections::IIterable;
    use windows::Foundation::{EventRegistrationToken, TypedEventHandler};
    use windows::Storage::{IStorageItem, StorageFile};
    use windows::Win32::Foundation::{GlobalFree, ERROR_SUCCESS, HANDLE, HWND};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows::Win32::System::Mapi::{MapiFileDescW, MapiMessageW, MapiRecipDescW, LPMAPISENDMAILW, MAPI_DIALOG, MAPI_LOGON_UI};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    use windows::Win32::UI::Shell::{AssocQueryStringW, IDataTransferManagerInterop, ShellExecuteW, ASSOCF_IS_PROTOCOL, ASSOCSTR_EXECUTABLE};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn share_supported() -> bool {
        DataTransferManager::IsSupported().unwrap_or(false)
    }

    fn reg_string(root: HKEY, key: PCWSTR) -> Option<String> {
        let mut buf = [0u16; 260];
        let mut len = (buf.len() * 2) as u32;
        let status = unsafe { RegGetValueW(root, key, PCWSTR::null(), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut len)) };
        if status != ERROR_SUCCESS {
            return None;
        }
        let chars = (len as usize / 2).saturating_sub(1);
        let s = String::from_utf16_lossy(&buf[..chars.min(buf.len())]).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    // The default Simple MAPI client, as Windows' own "Send to > Mail recipient" finds it. Outlook
    // (classic) and Thunderbird register here; web mail, the new Outlook and the Mail app don't.
    pub fn mapi_client_name() -> Option<String> {
        reg_string(HKEY_CURRENT_USER, w!("Software\\Clients\\Mail")).or_else(|| reg_string(HKEY_LOCAL_MACHINE, w!("SOFTWARE\\Clients\\Mail")))
    }

    // ASSOCF_IS_PROTOCOL also sees Store apps (WhatsApp, Telegram), whose protocol registrations
    // don't live under HKCR\<scheme>.
    pub fn protocol_handled(scheme: &str) -> bool {
        if !scheme.chars().all(|c| c.is_ascii_alphanumeric()) {
            return false;
        }
        let name = HSTRING::from(scheme);
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        unsafe { AssocQueryStringW(ASSOCF_IS_PROTOCOL, ASSOCSTR_EXECUTABLE, &name, PCWSTR::null(), PWSTR(buf.as_mut_ptr()), &mut len).is_ok() }
    }

    pub fn shell_open(url: &str) -> Result<(), String> {
        let target = HSTRING::from(url);
        let result = unsafe { ShellExecuteW(HWND(0), w!("open"), &target, PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        // ShellExecute's documented success test: a value greater than 32.
        if result.0 > 32 {
            Ok(())
        } else {
            Err("No app is set up to open this link".to_string())
        }
    }

    // CF_HDROP - the format Explorer's own Copy uses, so the file pastes into chat apps, web mail
    // and folders alike - plus "Preferred DropEffect" = copy, so pasting into a folder copies
    // rather than moves the staged file.
    pub fn copy_file(path: &Path) -> Result<(), String> {
        const CF_HDROP: u32 = 15;
        const DROPEFFECT_COPY: u32 = 1;
        // DROPFILES: pFiles (offset of the list), pt (x, y), fNC, fWide - 20 bytes.
        let header: [u32; 5] = [20, 0, 0, 0, 1];
        let list: Vec<u16> = path.as_os_str().encode_wide().chain([0, 0]).collect();
        unsafe {
            let size = 20 + list.len() * 2;
            let files = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size).map_err(|e| e.to_string())?;
            let ptr = GlobalLock(files) as *mut u8;
            if ptr.is_null() {
                let _ = GlobalFree(files);
                return Err("Couldn't copy the file".to_string());
            }
            std::ptr::copy_nonoverlapping(header.as_ptr() as *const u8, ptr, 20);
            std::ptr::copy_nonoverlapping(list.as_ptr() as *const u8, ptr.add(20), list.len() * 2);
            let _ = GlobalUnlock(files);

            let effect = GlobalAlloc(GMEM_MOVEABLE, 4).map_err(|e| e.to_string())?;
            let eptr = GlobalLock(effect) as *mut u32;
            if !eptr.is_null() {
                *eptr = DROPEFFECT_COPY;
                let _ = GlobalUnlock(effect);
            }

            if let Err(e) = OpenClipboard(HWND(0)) {
                let _ = GlobalFree(files);
                let _ = GlobalFree(effect);
                return Err(format!("Clipboard busy: {}", e));
            }
            let _ = EmptyClipboard();
            // On success the clipboard owns the memory.
            let set = SetClipboardData(CF_HDROP, HANDLE(files.0 as isize));
            if set.is_err() {
                let _ = GlobalFree(files);
            }
            let effect_format = RegisterClipboardFormatW(w!("Preferred DropEffect"));
            if effect_format == 0 || SetClipboardData(effect_format, HANDLE(effect.0 as isize)).is_err() {
                let _ = GlobalFree(effect);
            }
            let _ = CloseClipboard();
            set.map(|_| ()).map_err(|e| format!("Couldn't copy the file: {}", e))
        }
    }

    pub fn storage_file(path: &Path) -> Result<AgileReference<StorageFile>, String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_os_str()))
            .and_then(|op| op.get())
            .map_err(|e| format!("Couldn't open the file for sharing: {}", e.message()))?;
        AgileReference::new(&file).map_err(|e| e.message().to_string())
    }

    // DataRequested is per window and fires on every Share; the previous share's handler is
    // removed first so only the current file is offered.
    static SHARE_TOKEN: Mutex<Option<EventRegistrationToken>> = Mutex::new(None);

    // Must run on the window's UI thread.
    pub fn show_share_ui(hwnd: isize, item: AgileReference<StorageFile>, title: String, description: String) -> Result<(), String> {
        let run = || -> windows::core::Result<()> {
            let hwnd = HWND(hwnd);
            let interop = factory::<DataTransferManager, IDataTransferManagerInterop>()?;
            let manager: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };
            let mut slot = SHARE_TOKEN.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(token) = slot.take() {
                let _ = manager.RemoveDataRequested(token);
            }
            let title = HSTRING::from(title);
            let description = HSTRING::from(description);
            let token = manager.DataRequested(&TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let request = args.Request()?;
                let file = item.resolve()?;
                let data = request.Data()?;
                let props = data.Properties()?;
                props.SetTitle(&title)?;
                props.SetDescription(&description)?;
                let items: IIterable<IStorageItem> = vec![Some(file.cast::<IStorageItem>()?)].try_into()?;
                data.SetStorageItems(&items, true)?;
                Ok(())
            }))?;
            *slot = Some(token);
            drop(slot);
            unsafe { interop.ShowShareUIForWindow(hwnd) }
        };
        run().map_err(|e| format!("Couldn't open the share sheet: {}", e.message()))
    }

    pub fn mapi_send(file: &Path, subject: &str, body: &str, to: &[String]) -> Result<EmailOutcome, String> {
        // Win8+: compose window doesn't block the caller. Not every client takes it.
        const MAPI_DIALOG_MODELESS: u32 = 0x4;
        const MAPI_TO: u32 = 1;
        const MAPI_USER_ABORT: u32 = 1;
        const MAPI_E_UNKNOWN_FLAGS: u32 = 10;
        const MAPI_E_ATTACHMENT_NOT_FOUND: u32 = 11;

        let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
        let result = (|| {
            let send: LPMAPISENDMAILW = unsafe {
                let module = LoadLibraryW(w!("mapi32.dll")).map_err(|_| ())?;
                GetProcAddress(module, windows::core::s!("MAPISendMailW")).map(|f| std::mem::transmute(f))
            };
            let Some(send) = send else { return Err(()) };

            let mut subject_w = wide(subject);
            let mut body_w = wide(body);
            let mut path_w: Vec<u16> = file.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
            let mut name_w = wide(&file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
            let mut addresses: Vec<(Vec<u16>, Vec<u16>)> = to
                .iter()
                .map(|a| a.trim())
                .filter(|a| !a.is_empty())
                .map(|a| (wide(a), wide(&format!("SMTP:{}", a))))
                .collect();
            let mut recips: Vec<MapiRecipDescW> = addresses
                .iter_mut()
                .map(|(name, addr)| MapiRecipDescW {
                    ulRecipClass: MAPI_TO,
                    lpszName: PWSTR(name.as_mut_ptr()),
                    lpszAddress: PWSTR(addr.as_mut_ptr()),
                    ..Default::default()
                })
                .collect();
            let mut attachment = MapiFileDescW {
                nPosition: u32::MAX, // not placed in the body text
                lpszPathName: PWSTR(path_w.as_mut_ptr()),
                lpszFileName: PWSTR(name_w.as_mut_ptr()),
                ..Default::default()
            };
            let message = MapiMessageW {
                lpszSubject: PWSTR(subject_w.as_mut_ptr()),
                lpszNoteText: PWSTR(body_w.as_mut_ptr()),
                nRecipCount: recips.len() as u32,
                lpRecips: if recips.is_empty() { std::ptr::null_mut() } else { recips.as_mut_ptr() },
                nFileCount: 1,
                lpFiles: &mut attachment,
                ..Default::default()
            };
            let mut code = unsafe { send(0, 0, &message, MAPI_LOGON_UI | MAPI_DIALOG | MAPI_DIALOG_MODELESS, 0) };
            if code == MAPI_E_UNKNOWN_FLAGS {
                code = unsafe { send(0, 0, &message, MAPI_LOGON_UI | MAPI_DIALOG, 0) };
            }
            Ok(code)
        })();
        if com {
            unsafe { CoUninitialize() };
        }

        match result {
            Ok(0) => Ok(EmailOutcome::Opened),
            Ok(MAPI_USER_ABORT) => Ok(EmailOutcome::Cancelled),
            Ok(MAPI_E_ATTACHMENT_NOT_FOUND) => Err("The mail app couldn't read the attachment".to_string()),
            // Login failures, "not supported", a stub mapi32 with no real client behind it: let the
            // dialog offer web mail instead of showing a MAPI error code.
            Ok(_) | Err(()) => Ok(EmailOutcome::Unavailable),
        }
    }
}
