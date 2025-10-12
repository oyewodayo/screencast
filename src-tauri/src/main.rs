//main.rs
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use std::env::consts::OS;
use commands::recording::AppState;

use windows::{
    core::*,
    Win32::{
        Foundation::*,
        System::LibraryLoader::*,
        UI::{WindowsAndMessaging::*, Input::KeyboardAndMouse::*},
    },
};
use windows::core::{Result as WindowsResult, Error as WindowsError, HRESULT};
use tauri::{Manager, Window};

mod commands {
    pub mod windows_api;
    pub mod recording;
}
mod services {
    pub mod utility;
}

use log::LevelFilter;
use simplelog::{Config, WriteLogger};
use std::fs::File;
use std::sync::Once;
use std::sync::Mutex;

static WINDOW: Once = Once::new();
static mut GLOBAL_WINDOW: Option<Mutex<Window>> = None;
static mut HOOK_ID: Option<HHOOK> = None;

// Define the KBDLLHOOKSTRUCT structure
#[repr(C)]
pub struct KBDLLHOOKSTRUCT {
    pub vkCode: u32,
    pub scanCode: u32,
    pub flags: u32,
    pub time: u32,
    pub dwExtraInfo: usize,
}

// Keyboard hook procedure
extern "system" fn keyboard_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    unsafe {
        if n_code >= 0 {
            let w_param_u32 = w_param.0 as u32;
            if w_param_u32 == WM_KEYDOWN {
                let kbd_struct = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
                let key_code = kbd_struct.vkCode;

                // Convert key_code to a readable key name
                let key_name = get_key_name(key_code);

                println!("Key Pressed: {}", key_name);

                // Emit the global key event using the stored Window
                if let Some(window) = &GLOBAL_WINDOW {
                    if let Ok(window) = window.lock() {
                        if let Err(e) = emit_global_key_event(window.clone(), key_name) {
                            eprintln!("Failed to emit global key event: {:?}", e);
                        }
                    }
                }
            }
        }

        // Call the next hook in the chain
        CallNextHookEx(HOOK_ID.unwrap_or(HHOOK(0)), n_code, w_param, l_param)
    }
}

fn get_key_name(vk_code: u32) -> String {
    let scan_code = unsafe { MapVirtualKeyW(vk_code, MAPVK_VK_TO_VSC) };
    let mut key_name = [0u16; 128];
    let length = unsafe { GetKeyNameTextW((scan_code << 16) as i32, &mut key_name) };
    String::from_utf16_lossy(&key_name[..length as usize])
}

// Emit the global key event
fn emit_global_key_event(window: tauri::Window, key_name: String) -> WindowsResult<()> {
    window.emit("global-key-event", key_name)
        .map_err(|e| WindowsError::new(HRESULT(0), e.to_string()))
}

#[tauri::command]
fn tauri_emit_global_key_event(window: Window, key_name: String) {
    let _ = window.emit("global-key-event", key_name);
}

#[tauri::command]
fn get_ram_info() -> (u64, u64) {
    let mut mem_status = MEMORYSTATUSEX::default();
    mem_status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;

    let result = unsafe {
        GlobalMemoryStatusEx(&mut mem_status)
    };

    result.expect("Failed to get memory info");

    (
        mem_status.ullTotalPhys / (1024 * 1024),
        mem_status.ullAvailPhys / (1024 * 1024)
    )
}

#[tauri::command]
fn get_os_info() -> String {
    OS.to_string().to_uppercase()
}

fn main() {
    // Initialize logger
    WriteLogger::init(
        LevelFilter::Info, 
        Config::default(),  
        File::create("app.log").unwrap(),
    )
    .unwrap();
    
    std::env::set_var("RUST_BACKTRACE", "1");

    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_window("main").expect("main window not found");
            
            // Store the window globally
            WINDOW.call_once(|| {
                unsafe {
                    GLOBAL_WINDOW = Some(Mutex::new(window.clone()));
                }
            });

            unsafe {
                let instance = GetModuleHandleW(None).unwrap();
                HOOK_ID = Some(SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(keyboard_proc),
                    instance,
                    0,
                ).expect("Failed to set global keyboard hook"));

                if let Some(hook) = HOOK_ID {
                    if hook.0 == 0 {
                        panic!("Failed to set global keyboard hook: HOOK_ID is 0");
                    }
                } else {
                    panic!("Failed to set global keyboard hook: HOOK_ID is None");
                }

                std::thread::spawn(move || {
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, HWND(0), 0, 0).as_bool() {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                });
            }
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_ram_info,
            get_os_info,
            commands::recording::get_connected_audios,
            commands::recording::get_connected_cameras,
            commands::recording::get_connected_devices,           
            commands::recording::start_recording,
            commands::recording::stop_recording,
            commands::windows_api::start_monitoring_windows,
            commands::windows_api::stop_monitoring_windows,
            commands::windows_api::get_window_titles,
            commands::windows_api::get_windows_titles,
            commands::windows_api::capture_window_screenshots_by_title,
            commands::windows_api::activate_and_open_window,
            services::utility::open_file_from_directory,
            tauri_emit_global_key_event
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}