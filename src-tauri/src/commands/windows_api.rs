use tauri::async_runtime::Mutex as AsyncMutex;
use std::sync::Mutex;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM, LRESULT, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows, FindWindowW, GetWindowTextLengthW,
    GetWindowTextW, IsWindowVisible, SetForegroundWindow, ShowWindow,
    SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, SW_RESTORE, WH_SHELL,
    GetWindowRect
};
use windows::Win32::Graphics::Gdi::{
    GetDC, ReleaseDC, CreateCompatibleDC, CreateCompatibleBitmap,
    SelectObject, DeleteObject, DeleteDC, GetDIBits,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HMONITOR,
    EnumDisplayMonitors, GetMonitorInfoW, MONITORINFO
};
// PrintWindow/PRINT_WINDOW_FLAGS live under Storage::Xps in this crate version's metadata,
// not UI::WindowsAndMessaging where the Win32 docs file them.
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::core::PCWSTR;
use std::fs;
use std::sync::OnceLock;
use serde::Serialize;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use log::info;
use image::{Rgba, RgbaImage};

// Written from a WH_SHELL callback, which runs synchronously on the OS message-pump thread
// and cannot await - a plain std Mutex (held only for a trivial array swap) avoids needing
// tauri::async_runtime::block_on inside that callback.
static LAST_TWO_WINDOWS: OnceLock<Mutex<[String; 2]>> = OnceLock::new();
static IS_MONITORING: AtomicBool = AtomicBool::new(false);
static HOOK: OnceLock<AsyncMutex<Option<HHOOK>>> = OnceLock::new();
static CAPTURE_RUN_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Debug, Clone)]
pub struct WindowTitles {
    active: String,
    last_active: String
}

#[derive(Serialize, Debug, Clone)]
pub struct WindowInfo {
    title: String,
    image_path: String,
    hwnd: isize,
}

#[derive(Serialize, Debug, Clone)]
pub struct MonitorInfo {
    id: String,
    name: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    is_primary: bool,
}

pub fn get_last_two_windows() -> &'static Mutex<[String; 2]> {
    LAST_TWO_WINDOWS.get_or_init(|| Mutex::new([String::new(), String::new()]))
}

fn get_hook() -> &'static AsyncMutex<Option<HHOOK>> {
    HOOK.get_or_init(|| AsyncMutex::new(None))
}

// Capture a window's content via PrintWindow(PW_RENDERFULLCONTENT), which asks the window
// to render itself into the provided DC directly. This is required for anything
// GPU/DWM-composited - which is effectively every modern app (Chrome, VS Code, Explorer,
// Windows Terminal, ...) - since the older GetDC(hwnd) + BitBlt approach only ever sees
// whatever was last painted into the window's classic GDI surface, which for these apps is
// nothing, producing a blank capture every time. PrintWindow also doesn't need the window
// focused, so this no longer needs to steal foreground focus from window to window either.
fn capture_window_enhanced(hwnd: HWND, output_path: &str) -> Result<(), String> {
    unsafe {
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).map_err(|e| format!("GetWindowRect failed: {}", e))?;

        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;

        if width <= 0 || height <= 0 || width > 10000 || height > 10000 {
            return Err(format!("Invalid window dimensions: {}x{}", width, height));
        }

        // A screen-compatible DC/bitmap is what PrintWindow expects to render into.
        let hdc_screen = GetDC(HWND(0));
        if hdc_screen.is_invalid() {
            return Err("Failed to get screen DC".to_string());
        }

        let hdc_mem = CreateCompatibleDC(hdc_screen);
        if hdc_mem.is_invalid() {
            ReleaseDC(HWND(0), hdc_screen);
            return Err("Failed to create compatible DC".to_string());
        }

        let h_bitmap = CreateCompatibleBitmap(hdc_screen, width, height);
        if h_bitmap.is_invalid() {
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(HWND(0), hdc_screen);
            return Err("Failed to create bitmap".to_string());
        }

        let old_bitmap = SelectObject(hdc_mem, h_bitmap);

        // 2 = PW_RENDERFULLCONTENT (not re-exported with a proper PRINT_WINDOW_FLAGS type
        // alongside PrintWindow itself in this crate version's Storage::Xps module).
        let printed = PrintWindow(hwnd, hdc_mem, PRINT_WINDOW_FLAGS(2));

        if !printed.as_bool() {
            SelectObject(hdc_mem, old_bitmap);
            let _ = DeleteObject(h_bitmap);
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(HWND(0), hdc_screen);
            return Err("PrintWindow failed".to_string());
        }

        // Small delay for rendering
        std::thread::sleep(std::time::Duration::from_millis(50));

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // Negative for top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [windows::Win32::Graphics::Gdi::RGBQUAD::default(); 1],
        };

        let buffer_size = (width * height * 4) as usize;
        let mut buffer = vec![0u8; buffer_size];

        let scan_lines = GetDIBits(
            hdc_mem,
            h_bitmap,
            0,
            height as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        SelectObject(hdc_mem, old_bitmap);
        let _ = DeleteObject(h_bitmap);
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(HWND(0), hdc_screen);

        if scan_lines == 0 {
            return Err("GetDIBits failed".to_string());
        }

        // Check if image has actual content (not all black or white)
        let mut has_content = false;
        let mut non_uniform_pixels = 0;
        let sample_size = (buffer.len() / 4).min(1000); // Sample up to 1000 pixels
        
        for i in 0..sample_size {
            let idx = i * 4;
            if idx + 3 < buffer.len() {
                let r = buffer[idx + 2];
                let g = buffer[idx + 1];
                let b = buffer[idx];
                
                // Check for variation in pixel values
                if (r != 0 || g != 0 || b != 0) && (r != 255 || g != 255 || b != 255) {
                    non_uniform_pixels += 1;
                    if non_uniform_pixels > 10 {
                        has_content = true;
                        break;
                    }
                }
            }
        }

        if !has_content {
            return Err("Captured image appears to be blank".to_string());
        }

        // Convert BGRA to RGBA
        let mut img_buffer = RgbaImage::new(width as u32, height as u32);
        
        for y in 0..height as u32 {
            for x in 0..width as u32 {
                let idx = ((y * width as u32 + x) * 4) as usize;
                if idx + 3 < buffer.len() {
                    let b = buffer[idx];
                    let g = buffer[idx + 1];
                    let r = buffer[idx + 2];
                    let a = 255; // Force opaque
                    
                    img_buffer.put_pixel(x, y, Rgba([r, g, b, a]));
                }
            }
        }

        img_buffer.save(output_path)
            .map_err(|e| format!("Failed to save image: {}", e))?;

        Ok(())
    }
}

// Get available monitors
#[tauri::command]
pub fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    let mut monitors = Vec::new();
    
    unsafe extern "system" fn enum_monitor_callback(
        hmonitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(lparam.0 as *mut Vec<MonitorInfo>);
        
        unsafe {
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            
            if GetMonitorInfoW(hmonitor, &mut info).as_bool() {
                let monitor = MonitorInfo {
                    id: format!("monitor_{}", monitors.len()),
                    name: format!("Display {}", monitors.len() + 1),
                    x: info.rcMonitor.left,
                    y: info.rcMonitor.top,
                    width: info.rcMonitor.right - info.rcMonitor.left,
                    height: info.rcMonitor.bottom - info.rcMonitor.top,
                    is_primary: info.dwFlags == 1,
                };
                monitors.push(monitor);
            }
        }
        
        true.into()
    }
    
    unsafe {
        let _ = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(enum_monitor_callback),
            LPARAM(&mut monitors as *mut _ as isize),
        );
    }
    
    Ok(monitors)
}

pub async fn capture_window_screenshots_by_title(_app_handle: tauri::AppHandle) -> Result<Vec<WindowInfo>, String> {
    let windows = get_all_open_windows_titles();
    
    let cleaned_windows: Vec<(HWND, String)> = windows
        .into_iter()
        .map(|(hwnd, title)| {
            let clean_title = title
                .trim_end_matches('\0')
                .trim()
                .to_string();
            (hwnd, clean_title)
        })
        .filter(|(hwnd, title)| {
            if title.is_empty() 
                || title.contains("Task Manager")
                || title.contains("Program Manager")
                || title == "Windows Shell Experience Host"
                || title == "Windows Input Experience"
                || title == "MSCTFIME UI"
                || title == "Default IME" {
                return false;
            }
            
            // Check if window has visible area
            unsafe {
                let mut rect = RECT::default();
                if !GetWindowRect(*hwnd, &mut rect).is_ok() {
                    return false;
                }
                let width = rect.right - rect.left;
                let height = rect.bottom - rect.top;
                if width <= 100 || height <= 100 {
                    return false;
                }

                // IsWindowVisible can report true for windows DWM has cloaked - e.g. apps
                // pre-loaded in the background on another virtual desktop, or cached instances
                // (the Settings app is a common case of this) - which are not actually visible
                // to the user despite passing every other check. Skip those.
                let mut cloaked: u32 = 0;
                let is_cloaked = DwmGetWindowAttribute(
                    *hwnd,
                    DWMWA_CLOAKED,
                    &mut cloaked as *mut u32 as *mut std::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                ).is_ok() && cloaked != 0;

                !is_cloaked
            }
        })
        .collect();
    
    if cleaned_windows.is_empty() {
        return Err("No valid windows found".to_string());
    }

    // capture_window_enhanced does blocking GDI work plus short rendering-delay sleeps;
    // run the whole per-window loop off the async runtime's worker threads.
    let run_id = format!(
        "{}_{}",
        std::process::id(),
        CAPTURE_RUN_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    tauri::async_runtime::spawn_blocking(move || {
        let mut window_infos = Vec::new();
        let temp_dir = std::env::temp_dir();

        for (index, (hwnd, title)) in cleaned_windows.iter().enumerate() {
            // Namespaced by process id + call counter so repeated captures (or multiple app
            // instances) don't overwrite each other's still-in-use screenshots.
            let output_filename = format!("briefcast_window_{}_{}.png", run_id, index);
            let output_path = temp_dir.join(&output_filename);
            let output_path_str = output_path.to_string_lossy().to_string();

            log::debug!("Attempting to capture: '{}'", title);

            // A thumbnail is purely cosmetic for this picker - the window is still perfectly
            // valid to select and record even if PrintWindow can't produce a preview for it
            // (some GPU-composited apps don't respond well to PrintWindow). Previously a
            // failed/blank capture removed the window from the list entirely, which meant
            // real, visible windows like Chrome or VS Code could vanish from the picker.
            let image_path = match capture_window_enhanced(*hwnd, &output_path_str) {
                Ok(_) => match fs::metadata(&output_path) {
                    Ok(metadata) if metadata.len() > 1000 => {
                        log::debug!("Captured '{}' ({} bytes)", title, metadata.len());
                        output_path_str
                    }
                    _ => {
                        log::debug!("Thumbnail for '{}' too small, listing without one", title);
                        let _ = fs::remove_file(&output_path);
                        String::new()
                    }
                },
                Err(e) => {
                    log::debug!("Failed to capture '{}': {} - listing without a thumbnail", title, e);
                    let _ = fs::remove_file(&output_path);
                    String::new()
                }
            };

            window_infos.push(WindowInfo {
                title: title.to_string(),
                image_path,
                hwnd: hwnd.0,
            });
        }

        log::debug!("Listed {} windows ({} with thumbnails)", window_infos.len(), window_infos.iter().filter(|w| !w.image_path.is_empty()).count());
        window_infos
    })
    .await
    .map_err(|e| format!("Screenshot capture task panicked: {}", e))
}

#[tauri::command]
pub async fn capture_window_screenshots_by_title_command(
    app_handle: tauri::AppHandle
) -> Result<Vec<WindowInfo>, String> {
    capture_window_screenshots_by_title(app_handle).await
}

pub fn get_all_open_windows_titles() -> Vec<(HWND, String)> {
    let mut windows: Vec<(HWND, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_window), LPARAM(&mut windows as *mut _ as isize));
    }
    windows
}

// Best-effort fallback for the frontend-driven cleanup_screenshot_files command above - if the
// frontend never calls it (crash, force-quit), this sweeps any leftover capture files on exit.
pub fn cleanup_stale_window_screenshots() {
    let temp_dir = std::env::temp_dir();
    if let Ok(entries) = fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("briefcast_window_") && name.ends_with(".png") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

#[tauri::command]
pub async fn cleanup_screenshot_files(file_paths: Vec<String>) -> Result<(), String> {
    for path in file_paths {
        if let Err(e) = std::fs::remove_file(&path) {
            eprintln!("Failed to delete {}: {}", path, e);
        }
    }
    Ok(())
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
    let title = title.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let wide: Vec<u16> = OsStr::new(&title).encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            FindWindowW(PCWSTR::null(), PCWSTR(wide.as_ptr()))
        };

        if handle.0 == 0 {
            return Err(format!("Window '{}' not found", title));
        }

        unsafe {
            let _ = ShowWindow(handle, SW_RESTORE);
            std::thread::sleep(std::time::Duration::from_millis(100));
            let _ = SetForegroundWindow(handle);
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Activate window task panicked: {}", e))?
}

#[tauri::command]
pub async fn start_monitoring_windows() -> Result<(), String> {
    if IS_MONITORING.load(Ordering::Relaxed) {
        return Err("Monitoring is already active".to_string());
    }

    let hook = HOOK.get_or_init(|| AsyncMutex::new(None));
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

        if let Ok(mut last_two) = get_last_two_windows().lock() {
            last_two[0] = last_two[1].clone();
            last_two[1] = title;
        }
    }

    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
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

    let titles = get_last_two_windows().lock().map_err(|e| e.to_string())?;
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