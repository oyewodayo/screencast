//windows_api.rs
use tauri::async_runtime::Mutex;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM, LRESULT};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows, FindWindowW, GetWindowTextLengthW, 
    GetWindowTextW, IsWindowVisible, SetForegroundWindow, ShowWindow, 
    SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, SW_RESTORE, WH_SHELL
};
use windows::core::PCWSTR;
use std::sync::OnceLock;
use serde::Serialize;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};
use log::info;
use std::process::Command;
use std::path::PathBuf;

static LAST_TWO_WINDOWS: OnceLock<Mutex<[String; 2]>> = OnceLock::new();
static IS_MONITORING: AtomicBool = AtomicBool::new(false);
static HOOK: OnceLock<Mutex<Option<HHOOK>>> = OnceLock::new();

#[derive(Serialize, Debug)]
pub struct WindowTitles {
    active: String,
    last_active: String
}

#[derive(Serialize, Debug)]
pub struct WindowInfo {
    title: String,
    image: Vec<u8>,
}

pub fn get_last_two_windows() -> &'static Mutex<[String; 2]> {
    LAST_TWO_WINDOWS.get_or_init(|| Mutex::new([String::new(), String::new()]))
}

fn get_hook() -> &'static Mutex<Option<HHOOK>> {
    HOOK.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub async fn capture_window_screenshots_by_title(app_handle: tauri::AppHandle) -> Vec<WindowInfo> {
    use crate::commands::recording::get_ffmpeg_path;
    use std::fs;
    
    let windows = get_all_open_windows_titles();
    println!("W: {:?}", windows);
    
    let mut ffmpeg_cmd = String::from("-filter_complex ");
    for (_, title) in &windows {
        ffmpeg_cmd.push_str(&format!("gdigrab=input=title='{}'[{}];", title, title));
    }

    ffmpeg_cmd.push_str("-map ");
    for (_, title) in &windows {
        ffmpeg_cmd.push_str(&format!("[{}] output_{}.png ", title, title));
    }

    let ffmpeg_path = match get_ffmpeg_path(&app_handle) {
        Ok(path) => path,
        Err(e) => {
            eprintln!("Failed to get ffmpeg path: {}", e);
            return Vec::new();
        }
    };

    let output = Command::new(&ffmpeg_path)
        .args(ffmpeg_cmd.split_whitespace())
        .output()
        .expect("failed to execute process");

    if !output.status.success() {
        eprintln!("FFmpeg error: {}", String::from_utf8_lossy(&output.stderr));
        return Vec::new();
    }

    let mut window_images = Vec::new();

    for (_, title) in &windows {
        let image_path = format!("output_{}.png", title);
        match fs::read(&image_path) {
            Ok(image_data) => {
                window_images.push(WindowInfo {
                    title: title.to_string(),
                    image: image_data,
                });
                let _ = fs::remove_file(&image_path);
            },
            Err(e) => eprintln!("Failed to read image {}: {}", image_path, e),
        }
    }

    window_images
}

pub fn get_all_open_windows_titles() -> Vec<(HWND, String)> {
    let mut windows: Vec<(HWND, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_window), LPARAM(&mut windows as *mut _ as isize));
    }
    windows
}

unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let windows = &mut *(lparam.0 as *mut Vec<(HWND, String)>);
    if IsWindowVisible(hwnd).as_bool() {
        let length = GetWindowTextLengthW(hwnd) as usize;
        if length > 0 {
            let mut buffer = vec![0u16; length + 1];
            GetWindowTextW(hwnd, &mut buffer);
            let title = String::from_utf16_lossy(&buffer);
            windows.push((hwnd, title));
        }
    }
    true.into()
}

#[tauri::command]
pub async fn activate_and_open_window(title: &str) -> Result<(), String> {
    let wide: Vec<u16> = OsStr::new(title).encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        FindWindowW(PCWSTR::null(), PCWSTR(wide.as_ptr()))
    };

    if handle.0 == 0 {
        return Err(format!("Window {} not found", title));
    }

    unsafe {
        let _ = ShowWindow(handle, SW_RESTORE);
        let _ = SetForegroundWindow(handle);
    }

    Ok(())
}

#[tauri::command]
pub async fn start_monitoring_windows() -> Result<(), String> {
    if IS_MONITORING.load(Ordering::Relaxed) {
        return Err("Monitoring is already active".to_string());
    }

    let hook = HOOK.get_or_init(|| Mutex::new(None));
    let mut hook_guard = hook.lock().await;

    if hook_guard.is_some() {
        return Err("Hook is already set".to_string());
    }

    let thread_id = unsafe { GetCurrentThreadId() };

    *hook_guard = Some(unsafe {
        SetWindowsHookExW(
            WH_SHELL,
            Some(shell_proc),
            None,
            thread_id
        ).map_err(|e| e.to_string())?
    });

    info!("Monitoring started");
    IS_MONITORING.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn stop_monitoring_windows() -> Result<(), String> {
    if !IS_MONITORING.load(Ordering::Relaxed) {
        return Err("Monitoring is not active".to_string());
    }

    let mut hook = get_hook().lock().await;
    if let Some(h) = hook.take() {
        unsafe {
            let _ = UnhookWindowsHookEx(h);
        }
    }

    IS_MONITORING.store(false, Ordering::Relaxed);
    info!("Monitoring stopped");
    Ok(())
}

unsafe extern "system" fn shell_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == 4 {
        let hwnd = HWND(wparam.0 as isize);
        let title = get_window_title(hwnd);

        tauri::async_runtime::block_on(async {
            let mut last_two = get_last_two_windows().lock().await;
            last_two[0] = last_two[1].clone();
            last_two[1] = title;
        });
    }

    CallNextHookEx(None, code, wparam, lparam)
}

#[tauri::command]
pub fn get_windows_titles() -> Vec<String> {
    let mut titles = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_window_titles), LPARAM(&mut titles as *mut _ as isize));
    }
    titles
}

unsafe extern "system" fn enum_window_titles(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let titles = &mut *(lparam.0 as *mut Vec<String>);
    if IsWindowVisible(hwnd).as_bool() {
        let length = GetWindowTextLengthW(hwnd) as usize;
        if length > 0 {
            let mut buffer = vec![0u16; length + 1];
            GetWindowTextW(hwnd, &mut buffer);
            let title = String::from_utf16_lossy(&buffer);
            titles.push(title);
        }
    }
    true.into()
}

#[tauri::command] 
pub async fn get_window_titles() -> Result<WindowTitles, String> {
    if !IS_MONITORING.load(Ordering::Relaxed) {
        return Err("Monitoring is not active".to_string());
    }

    let titles = get_last_two_windows().lock().await;
    Ok(WindowTitles { 
        active: titles[1].clone(), 
        last_active: titles[0].clone() 
    })
}

pub fn get_window_title(hwnd: HWND) -> String {
    let mut text = [0u16; 512];
    unsafe {
        let len = GetWindowTextW(hwnd, &mut text);
        String::from_utf16_lossy(&text[..len as usize])
    }
}