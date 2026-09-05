//main.rs
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use commands::recording::AppState;
use std::env::consts::OS;
use tauri::Manager;

mod commands {
    pub mod annotation;
    pub mod conversion;
    pub mod native_playback;
    pub mod recording;
    pub mod system_info;
    pub mod window_capture;
}
mod services {
    pub mod boards;
    pub mod docs;
    pub mod docs_search;
    pub mod file_watcher;
    pub mod image_annotations;
    pub mod pdf_annotations;
    pub mod trash;
    pub mod utility;
    pub mod video_edits;
    // WASAPI is Windows-only - see the module's own doc comment for why this exists (no Stereo
    // Mix-equivalent dshow device on some machines means ffmpeg alone can never capture system/
    // "what you hear" audio; WASAPI loopback is the universal, driver-independent alternative).
    #[cfg(target_os = "windows")]
    pub mod loopback_audio;
    // A Win32 low-level mouse hook, Windows-only for the same reason loopback_audio above is
    // (SetWindowsHookExW/WH_MOUSE_LL has no cross-platform equivalent this app's existing `windows`
    // crate dependency could reuse) - see the module's own doc comment for why this needed no new
    // Cargo dependency at all.
    #[cfg(target_os = "windows")]
    pub mod click_tracker;
    // HEIC/HEIF decoding via WIC/WinRT (Windows' own photo codec) - see the module's doc comment
    // for why convert_image (commands/conversion.rs) can't just hand these to ffmpeg: this bundled
    // ffmpeg build mis-decodes multi-image HEIC files (Portrait mode, Deep Fusion, etc.) as a
    // black frame instead of the actual photo. macOS's WebKit-based webview decodes HEIC directly
    // in <img> tags, so this problem - and this module - is Windows-only.
    #[cfg(target_os = "windows")]
    pub mod heic_windows;
    // Fallback HEIC/HEIF decoder for when heic_windows above fails (most commonly: the machine
    // has "HEIF Image Extensions" but not the separate "HEVC Video Extensions" package, so WIC
    // can open the container but not decode its pixels - see heic_windows.rs's own doc comment).
    // Shells out to a bundled libheif build instead of the ffmpeg fallback this used to be - see
    // heif_tool.rs's own doc comment for why ffmpeg's HEIF tile-grid reconstruction isn't good
    // enough here. Windows-only for the same reason heic_windows is: it's the only platform this
    // fallback path is ever reached from.
    #[cfg(target_os = "windows")]
    pub mod heif_tool;
}
use simplelog::{
    ColorChoice, CombinedLogger, ConfigBuilder, TermLogger, TerminalMode, WriteLogger,
};

use log::{error, LevelFilter};
use std::fs::OpenOptions;
use std::panic;

#[tauri::command]
fn get_os_info() -> String {
    OS.to_string().to_uppercase()
}

// Per-OS app-data directory for log files, resolved via plain env vars rather than Tauri's path
// APIs - see the call site's comment for why. Falls back to the system temp dir if the relevant
// env var isn't set (should never happen in practice on any of these platforms).
fn resolve_log_dir() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA").map(std::path::PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME")
        .map(|home| std::path::PathBuf::from(home).join("Library/Application Support"));
    #[cfg(target_os = "linux")]
    let base =
        std::env::var("HOME").map(|home| std::path::PathBuf::from(home).join(".local/share"));

    base.map(|dir| dir.join("Briefcast").join("logs"))
        .unwrap_or_else(|_| std::env::temp_dir())
}

// Shows a native "already running" notice before the duplicate process exits - Windows only for
// now (matches this codebase's existing "Windows is the verified platform" posture elsewhere,
// e.g. loopback_audio.rs/heic_windows.rs), since MessageBoxW needs no Tauri app context to call,
// unlike tauri::api::dialog which assumes a running app. A silent exit is an acceptable fallback
// on macOS/Linux - a launcher/dock effectively already fills this role there by focusing the
// existing window instead of spawning a second process in the first place.
#[cfg(target_os = "windows")]
fn show_already_running_message() {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK};

    let title: Vec<u16> = "Briefcast"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let text: Vec<u16> = "Briefcast is already running."
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(text.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}

fn main() {
    // Single-instance guard: binding a fixed localhost port is atomic and self-cleaning (the OS
    // releases it the moment this process exits, crash or not - no stale-PID-file cleanup needed,
    // unlike a lock file). A second launch failing this bind means a first instance is already
    // running and already holds every global shortcut (Ctrl+Shift+R/H/B/D, see Dashboard.tsx) -
    // letting a second copy proceed anyway is exactly what produced "Couldn't register the
    // panel-buttons shortcut... it may already be in use by another app": that "another app" was
    // just an earlier copy of this same app. The listener is kept bound for main()'s entire
    // lifetime (held in this variable, never touched again) rather than dropped right after the
    // check, which would let a third launch slip in during the race between checking and the app
    // actually starting up.
    let _single_instance_guard = match std::net::TcpListener::bind(("127.0.0.1", 47_813)) {
        Ok(listener) => listener,
        Err(_) => {
            #[cfg(target_os = "windows")]
            show_already_running_message();
            std::process::exit(0);
        }
    };

    let context = tauri::generate_context!();

    // Resolve logs to the app's own data directory instead of the process's current working
    // directory, which varies depending on how the app was launched (Start Menu shortcut,
    // double-click from Explorer, `cargo run`, etc.) and previously scattered app.log/panic.log
    // wherever that happened to be. Plain env-var resolution rather than Tauri's path APIs -
    // mirroring services::utility's own home_dir/config_file_path (see that module's comment on
    // config_file_path) - since no `App`/`AppHandle` exists yet this early (before
    // `tauri::Builder::build` even runs), and logging needs to be live before then to catch a
    // panic during plugin registration or setup.
    let log_dir = resolve_log_dir();
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
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(commands::conversion::ConversionState::default())
        .manage(commands::native_playback::NativePlaybackState::default())
        .manage(services::file_watcher::FileWatcherState::default())
        .setup(|app| {
            // Start watching the Briefcast folder for external changes right away, so the sidebar
            // stays live without needing a restart or a manual refresh click - see
            // services/file_watcher.rs. Best-effort: failures are logged inside start_watching
            // itself and never block startup.
            match services::utility::briefcast_dir() {
                Ok(dir) => {
                    let _ = std::fs::create_dir_all(&dir);
                    services::file_watcher::start_watching(&app.handle(), &dir);
                }
                Err(e) => log::warn!("Could not resolve Briefcast dir for file watcher: {}", e),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system_info::get_ram_info,
            get_os_info,
            commands::recording::get_connected_audios,
            commands::recording::get_connected_cameras,
            commands::recording::get_connected_devices,
            commands::recording::start_recording,
            commands::recording::stop_recording,
            commands::recording::load_click_sidecar,
            commands::recording::pause_recording,
            commands::recording::resume_recording,
            commands::recording::take_screenshot,
            commands::window_capture::start_monitoring_windows,
            commands::window_capture::stop_monitoring_windows,
            commands::window_capture::get_window_titles,
            commands::window_capture::get_monitors,
            commands::window_capture::get_windows_titles,
            commands::window_capture::capture_window_screenshots_by_title_command,
            commands::window_capture::cleanup_screenshot_files,
            commands::window_capture::activate_and_open_window,
            commands::conversion::convert_to_mp4,
            commands::conversion::get_playable_preview,
            commands::conversion::batch_convert_to_mp4,
            commands::conversion::cancel_conversion,
            commands::conversion::get_conversion_info,
            commands::conversion::get_supported_conversion_formats,
            commands::conversion::should_convert_file,
            commands::conversion::convert_video,
            commands::conversion::convert_image,
            commands::conversion::get_heic_preview,
            commands::conversion::get_image_thumbnail,
            commands::conversion::get_video_thumbnail,
            commands::conversion::convert_audio,
            commands::conversion::export_trimmed_video,
            commands::conversion::detect_silence,
            commands::conversion::read_image_data_url,
            commands::conversion::read_file_bytes,
            commands::native_playback::start_native_playback,
            commands::native_playback::get_next_video_frame,
            commands::native_playback::get_next_audio_chunk,
            commands::native_playback::seek_native_playback,
            commands::native_playback::stop_native_playback,
            commands::annotation::ensure_annotation_overlay,
            services::utility::open_file_from_directory,
            services::utility::open_file_with_default_app,
            services::utility::list_briefcast_files,
            services::utility::convert_file_path_to_url,
            services::utility::get_cursor_position_in_window,
            services::utility::rename_file,
            services::utility::create_folder,
            services::utility::delete_folder,
            services::utility::move_file,
            services::utility::import_file,
            services::utility::get_platform,
            services::utility::get_briefcast_dir,
            services::utility::get_default_briefcast_dir,
            services::utility::set_briefcast_dir,
            services::utility::reset_briefcast_dir,
            services::utility::repair_stale_file_references,
            services::pdf_annotations::save_pdf_annotations,
            services::pdf_annotations::load_pdf_annotations,
            services::pdf_annotations::save_exported_pdf,
            services::image_annotations::save_image_annotations,
            services::image_annotations::load_image_annotations,
            services::image_annotations::save_edited_image,
            services::boards::list_boards,
            services::boards::create_board,
            services::boards::duplicate_board,
            services::boards::save_board,
            services::boards::load_board,
            services::boards::delete_board,
            services::boards::import_board_image,
            services::boards::save_board_thumbnail,
            services::boards::export_board_png,
            services::boards::export_board_png_to_path,
            services::docs::list_docs,
            services::docs::create_doc,
            services::docs::save_doc,
            services::docs::load_doc,
            services::docs::delete_doc,
            services::docs::link_doc_to_file,
            services::docs::unlink_doc,
            services::docs::find_docs_linked_to,
            services::docs::relink_doc_path,
            services::docs::export_doc,
            services::docs::export_doc_binary,
            services::docs::save_doc_image,
            services::docs::list_trashed_docs,
            services::docs::restore_doc,
            services::docs::delete_doc_permanently,
            services::docs::list_doc_folders,
            services::docs::create_doc_folder,
            services::docs::rename_doc_folder,
            services::docs::move_doc_folder,
            services::docs::delete_doc_folder,
            services::docs::set_doc_folder,
            services::docs::create_doc_version,
            services::docs::list_doc_versions,
            services::docs::load_doc_version,
            services::docs::restore_doc_version,
            services::docs::list_doc_comments,
            services::docs::add_doc_comment,
            services::docs::resolve_doc_comment,
            services::docs::reopen_doc_comment,
            services::docs::delete_doc_comment,
            services::docs::set_doc_page_setup,
            services::docs_search::index_doc_content,
            services::docs_search::remove_doc_from_index,
            services::docs_search::list_indexed_doc_ids,
            services::docs_search::search_docs,
            services::video_edits::save_video_edit_state,
            services::video_edits::load_video_edit_state,
            services::trash::move_to_trash,
            services::trash::list_trash,
            services::trash::restore_from_trash,
            services::trash::delete_trash_item,
            services::trash::empty_trash,
            services::trash::purge_expired_trash
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                commands::window_capture::cleanup_stale_window_screenshots();
                commands::native_playback::cleanup_all_sessions(
                    &app_handle.state::<commands::native_playback::NativePlaybackState>(),
                );
            }
        });
}
