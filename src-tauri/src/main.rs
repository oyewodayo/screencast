//main.rs
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use std::env::consts::OS;
use commands::recording::AppState;

use windows::{
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
    pub mod conversion;
}
mod services {
    pub mod utility;
}
use simplelog::{CombinedLogger, WriteLogger, TermLogger, ColorChoice, TerminalMode, ConfigBuilder};

use log::{LevelFilter, error};
use std::sync::Once;
use std::sync::Mutex;
use std::fs::OpenOptions;
use std::panic;


static WINDOW: Once = Once::new();
static mut GLOBAL_WINDOW: Option<Mutex<Window>> = None;
static mut HOOK_ID: Option<HHOOK> = None;

// Define the KBDLLHOOKSTRUCT structure
#[repr(C)]
pub struct KBDLLHOOKSTRUCT {
    pub vk_code: u32,
    pub scan_code: u32,
    pub flags: u32,
    pub time: u32,
    pub dw_extra_info: usize,
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
                let key_code = kbd_struct.vk_code;

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
    let log_file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open("app.log")
        .expect("Failed to open log file");

    // Configure logging with more verbose settings
    let config = ConfigBuilder::new()
        .set_time_format_rfc3339()
        .set_time_offset_to_local()
        .unwrap_or_else(|builder| builder)
        .build();

    // Initialize combined logger (writes to both terminal and file)
    CombinedLogger::init(vec![
        TermLogger::new(
            LevelFilter::Debug,
            config.clone(),
            TerminalMode::Mixed,
            ColorChoice::Auto,
        ),
        WriteLogger::new(LevelFilter::Trace, config, log_file), // TRACE captures everything
    ])
    .expect("Failed to initialize logger");

    // Set panic hook to log panics to file
    panic::set_hook(Box::new(|panic_info| {
        let payload = panic_info.payload();
        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            s
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.as_str()
        } else {
            "Unknown panic payload"
        };

        let location = if let Some(location) = panic_info.location() {
            format!("{}:{}:{}", location.file(), location.line(), location.column())
        } else {
            "Unknown location".to_string()
        };

        error!("PANIC occurred at {}: {}", location, message);
        
        // Also write to a separate panic log
        let panic_log = format!(
            "\n=== PANIC at {} ===\n{}\n{}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            location,
            message
        );
        
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open("panic.log")
        {
            use std::io::Write;
            let _ = file.write_all(panic_log.as_bytes());
        }
    }));
    
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
        .manage(commands::conversion::ConversionState::default())
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
            commands::windows_api::get_monitors,
            commands::windows_api::get_windows_titles,
            commands::windows_api::capture_window_screenshots_by_title_command,
            commands::windows_api::cleanup_screenshot_files,
            commands::windows_api::activate_and_open_window,
           
            commands::conversion::convert_to_mp4,
            commands::conversion::batch_convert_to_mp4,
            commands::conversion::cancel_conversion,
            commands::conversion::get_conversion_info,
            commands::conversion::get_supported_conversion_formats,
            commands::conversion::should_convert_file,
            commands::conversion::convert_video,

            services::utility::open_file_from_directory,
            services::utility::list_briefcast_files,
            services::utility::convert_file_path_to_url,
            tauri_emit_global_key_event
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}