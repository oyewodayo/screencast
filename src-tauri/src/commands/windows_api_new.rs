//windows_api_new.rs
use image::{ImageBuffer, Rgba};
use tauri::async_runtime::Mutex;
use windows::Win32::Graphics::Gdi::{CreateDCA, DeleteDC, BitBlt, SRCCOPY,GetPixel};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM, LRESULT, RECT,COLORREF};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW,CallNextHookEx, EnumWindows, FindWindowW, GetForegroundWindow, GetWindowRect, GetWindowTextW, IsWindowVisible, SetForegroundWindow, SetWindowsHookExW, ShowWindow, UnhookWindowsHookEx, HHOOK, SW_RESTORE, WH_SHELL};
use windows::core::{PCWSTR, PWSTR,PCSTR};
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};
use std::ffi::{CString, OsStr};
use image::ImageFormat;
use std::io::Cursor;
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};
use log::{info,error};
use std::ptr;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use tauri::AppHandle;
use crate::commands::recording;

static LAST_TWO_WINDOWS: OnceLock<Mutex<[String; 2]>> = OnceLock::new();
static IS_MONITORING: AtomicBool = AtomicBool::new(false);
static HOOK: OnceLock<Mutex<Option<HHOOK>>> = OnceLock::new();

#[derive(Serialize, Debug)]
pub struct WindowTitles{
    active:String,
    last_active:String
}

pub fn get_last_two_windows()-> &'static Mutex<[String;2]>{
    LAST_TWO_WINDOWS.get_or_init(|| Mutex::new([String::new(), String::new()]))
}


fn get_hook()->&'static Mutex<Option<HHOOK>>{
    HOOK.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub async fn capture_window_screenshots_by_title(app_handle: tauri::AppHandle) -> Result<Vec<WindowInfo>, String> {
    let windows = get_all_open_windows_titles();
    let mut window_infos = Vec::new();
    println!("W: {:?}", windows);
    for (_, title) in windows {
        let window_title = title.split("-").last().unwrap();
        match recording::screen_capture_by_title(&app_handle, window_title.to_string()) {
            Ok(image_path) => {
                println!("Images: {}",image_path);
                // println!("Windows: {:?}",WindowInfo { title, image:image_path } );
                window_infos.push(WindowInfo { title:window_title.to_string(), image:image_path });

            }
            Err(e) => eprintln!("Error capturing window {}: {}", title, e),
        }
    }

    Ok(window_infos)
}

// #[tauri::command]
// pub async fn capture_window_screenshots() -> Result<Vec<WindowInfo>, String> {
//     info!("Starting capture_window_screenshots");
//     let windows = get_all_open_windows_titles();
//     println!("W: {:?}", windows);
//     if windows.is_empty() {
//         error!("No windows found");
//         return Err("No windows found".to_string());
//     }
//     let mut window_infos = Vec::new();
//     for (hwnd, title) in windows {
//         println!("Window titles: {}",title);
//         info!("Capturing window: {}", title);

//              match capture_window(hwnd) {           

//             Ok(image) => {
//                 println!("Window hwnd: {:?}",hwnd);
//                 let mut png_data = Vec::new();
//                 match image.write_to(&mut Cursor::new(&mut png_data), ImageFormat::Png) {
//                     Ok(_) => {
//                         window_infos.push(WindowInfo { title:title.clone(), image: png_data });
//                         println!("Info: {:?}",window_infos);
//                         info!("Successfully captured window: {}", title);
//                     },
//                     Err(e) => {
//                         error!("Error writing image for window '{}': {}", title, e);
//                         return Err(format!("Error writing image for window '{}': {}", title, e));
//                     }
//                 }
//             },
//             Err(e) => {
//                 println!("Window hwnd: {}",e);
//                 error!("Error capturing window '{}': {}", title, e);
//                 return Err(format!("Error capturing window '{}': {}", title, e));
//             }
//         }
//     }
//     info!("Finished capturing {} windows", window_infos.len());
//     Ok(window_infos)
// }

pub fn capture_window(hwnd: HWND) -> Result<ImageBuffer<Rgba<u8>, Vec<u8>>, String> {
    unsafe {
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect);
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;

        let display_name = PCSTR::from_raw("DISPLAY\0".as_ptr());
        let hdc = CreateDCA(display_name, None, None, None);
        if hdc.is_invalid() {
            return Err("Failed to create device context".to_string());
        }

        let mut image = ImageBuffer::new(width as u32, height as u32);

        match BitBlt(hdc, 0, 0, width, height, hdc, rect.left, rect.top, SRCCOPY) {
            Ok(_) => {
                for y in 0..height {
                    for x in 0..width {
                        let color: COLORREF = GetPixel(hdc, x, y);
                        let pixel = image.get_pixel_mut(x as u32, y as u32);
                        *pixel = Rgba([
                            (color.0 & 0xFF) as u8,        // Blue
                            ((color.0 >> 8) & 0xFF) as u8, // Green
                            ((color.0 >> 16) & 0xFF) as u8,// Red
                            255,                           // Alpha
                        ]);
                    }
                }
                DeleteDC(hdc);
                Ok(image)
            },
            Err(e) => {
                DeleteDC(hdc);
                Err(format!("BitBlt operation failed: {:?}", e))
            }
        }
    }
}




extern "system" fn enum_window(window: HWND, param:LPARAM)->BOOL{
    unsafe {
        if IsWindowVisible(window).as_bool() {
            let mut text = [0u16; 512];
            let len = GetWindowTextW(window, &mut text);

            if len > 0 {
                let title = String::from_utf16_lossy(&text[..len as usize]);
                let titles = &mut *(param.0 as *mut Vec<String>);

                titles.push(title);
            }
        }
        
    }
    BOOL::from(true)
}

#[tauri::command]
pub async fn activate_and_open_window(title:&str) -> Result<(), String> {
  let wide:Vec<u16> = OsStr::new(title).encode_wide().chain(Some(0)).collect();
  let handle = unsafe {
      FindWindowW(PCWSTR::null(), PCWSTR(wide.as_ptr()))
  };

  if handle.0 ==0 {
      return Err(format!("Window {} not found", title));

  }

  unsafe {
    ShowWindow(handle, SW_RESTORE);

    SetForegroundWindow(handle);
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

    println!("monitoring started");
    IS_MONITORING.store(true, Ordering::Relaxed);
    Ok(())


}

#[tauri::command]
pub async fn stop_monitoring_windows()->Result<(), String>{

    if !IS_MONITORING.load(Ordering::Relaxed) {
        return Err("Monitoring is not active".to_string());
    }

    let mut hook = get_hook().lock().await;
    if let Some(h) = hook.take() {
        unsafe {
            UnhookWindowsHookEx(h);
        }
    }
    

    IS_MONITORING.store(false, Ordering::Relaxed);

    Ok(())
}

unsafe extern "system" fn shell_proc(code:i32, wparam:WPARAM,lparam:LPARAM)->LRESULT{
    if code == 4 {
        let hwnd = HWND(wparam.0 as isize);
        let title = get_window_title(hwnd);

        tauri::async_runtime::block_on(async{
            let mut last_two = get_last_two_windows().lock().await;
            last_two[0] = last_two[1].clone();
            last_two[1]=title;
        });
        
    }

    CallNextHookEx(None, code, wparam, lparam)
}


pub fn get_all_open_windows_titles() -> Vec<(HWND, String)> {
    let mut windows: Vec<(HWND, String)> = Vec::new();

    unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd).as_bool() {
            let length = GetWindowTextLengthW(hwnd) + 1;
            let mut buffer: Vec<u16> = vec![0; length as usize];
            if GetWindowTextW(hwnd, &mut buffer) > 0 {
                let title = OsString::from_wide(&buffer)
                    .to_string_lossy()
                    .into_owned()
                    .replace('\0', ""); // Remove null bytes
                let windows = &mut *(lparam.0 as *mut Vec<(HWND, String)>);
                windows.push((hwnd, title));
            }
        }
        BOOL(1) // Continue enumeration
    }

    unsafe {
        EnumWindows(Some(enum_window), LPARAM(&mut windows as *mut _ as isize));
    }

    if windows.is_empty() {
        eprintln!("Failed to get window titles");
    }

    windows
}


#[tauri::command]
pub fn get_windows_titles() -> Vec<String> {
    let mut titles = Vec::new();
    unsafe {
        EnumWindows(Some(enum_window), LPARAM(&mut titles as *mut _ as isize));
    }
    titles
}



#[tauri::command] 
pub async fn get_window_titles() -> Result<WindowTitles, String> {
    if !IS_MONITORING.load(Ordering::Relaxed) {
        return Err("Monitoring is not active".to_string());
    }

    let titles = get_last_two_windows().lock().await;

  Ok(WindowTitles { active: titles[1].clone(), last_active: titles[0].clone() })
}

pub fn get_window_title(hwnd:HWND)->String{
    let mut text = [0u16;512];
    unsafe {
        let len = GetWindowTextW(hwnd, &mut text);
        String::from_utf16_lossy(&text[..len as usize])
    }
}


#[derive(Serialize, Deserialize,Debug)]
pub struct WindowInfo{
    title:String,
    image:String,
    // image:Vec<u8>,
}


#[tauri::command]
pub async fn get_current_window_title() -> Result<String, String> {
    if !IS_MONITORING.load(Ordering::Relaxed) {
        return Err("Monitoring is not active".to_string());
    }
  Ok(get_last_two_windows().lock().await[1].clone())
}
pub async fn get_previous_window_title() -> Result<String, String> {
    if !IS_MONITORING.load(Ordering::Relaxed) {
        return Err("Monitoring is not active".to_string());
    }
  Ok(get_last_two_windows().lock().await[0].clone())
}

