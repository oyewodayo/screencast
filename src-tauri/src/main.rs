//main.rs
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use std::env::consts::OS;
use commands::recording::AppState;

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
use std::fs::OpenOptions;
use std::panic;

#[tauri::command]
fn get_ram_info() -> Result<(u64, u64), String> {
    let mut mem_status = MEMORYSTATUSEX::default();
    mem_status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;

    unsafe { GlobalMemoryStatusEx(&mut mem_status) }
        .map_err(|e| format!("Failed to get memory info: {}", e))?;

    Ok((
        mem_status.ullTotalPhys / (1024 * 1024),
        mem_status.ullAvailPhys / (1024 * 1024)
    ))
}

#[tauri::command]
fn get_os_info() -> String {
    OS.to_string().to_uppercase()
}

fn main() {
    let context = tauri::generate_context!();

    // Resolve logs to the app's own data directory instead of the process's current working
    // directory, which varies depending on how the app was launched (Start Menu shortcut,
    // double-click from Explorer, `cargo run`, etc.) and previously scattered app.log/panic.log
    // wherever that happened to be.
    let log_dir = tauri::api::path::app_log_dir(context.config())
        .unwrap_or_else(std::env::temp_dir);
    let _ = std::fs::create_dir_all(&log_dir);
    let app_log_path = log_dir.join("app.log");
    let panic_log_path = log_dir.join("panic.log");

    // Initialize logger
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&app_log_path)
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
    panic::set_hook(Box::new(move |panic_info| {
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
            .open(&panic_log_path)
        {
            use std::io::Write;
            let _ = file.write_all(panic_log.as_bytes());
        }
    }));

    std::env::set_var("RUST_BACKTRACE", "1");

    tauri::Builder::default()
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
            services::utility::rename_file
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                commands::windows_api::cleanup_stale_window_screenshots();
            }
        });
}