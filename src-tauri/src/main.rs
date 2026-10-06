//main.rs
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use commands::recording::AppState;
use std::env::consts::OS;
use tauri::Manager;

mod commands {
    pub mod audio_tracks;
    pub mod conversion;
    pub mod embedded_scan;
    pub mod file_info;
    pub mod native_playback;
    pub mod snip;
    pub mod recording;
    pub mod system_info;
    pub mod window_capture;
}
mod services {
    pub mod asset_download;
    pub mod boards;
    pub mod docs;
    pub mod docs_search;
    pub mod file_watcher;
    pub mod image_annotations;
    pub mod pdf_annotations;
    // Serves a phone's browser as a camera source over the LAN - see the module's own doc
    // comment for why a webcam driver (DroidCam/Iriun/Camo) is otherwise the only way to get a
    // phone into a DirectShow device list, and why this needs to be an HTTPS server to avoid one.
    pub mod phone_camera;
    // Carries the live recording preview from ffmpeg's stdout to the UI without touching the
    // disk - see the module's own doc comment for the file-based approach this replaced and why.
    pub mod preview_stream;
    // Makes a recording's ffmpeg child die with the app instead of outliving it, holding the
    // camera open and competing for the machine - Job Object on Windows, PR_SET_PDEATHSIG on
    // Linux. See the module's own comment for the macOS gap.
    pub mod orphan_guard;
    // Keeps the window from ever going "Not responding" - see the module's own comment for the
    // threading rules every command follows and the test that enforces them.
    pub mod responsiveness;
    // Opt-out analytics + crash reports, compiled in only for release builds with keys.
    pub mod telemetry;
    pub mod trash;
    pub mod utility;
    pub mod whisper_model;
    pub mod video_edits;
    pub mod mindmaps;
    pub mod whiteboards;
    // WASAPI is Windows-only - see the module's own doc comment for why this exists (no Stereo
    // Mix-equivalent dshow device on some machines means ffmpeg alone can never capture system/
    // "what you hear" audio; WASAPI loopback is the universal, driver-independent alternative).
    #[cfg(target_os = "windows")]
    pub mod audio_capture;
    // Default cleanup of every recording's audio - see the module's own doc comment.
    pub mod audio_enhance;
    // A Win32 low-level mouse hook, Windows-only for the same reason audio_capture above is
    // (SetWindowsHookExW/WH_MOUSE_LL has no cross-platform equivalent this app's existing `windows`
    // crate dependency could reuse) - see the module's own doc comment for why this needed no new
    // Cargo dependency at all.
    #[cfg(target_os = "windows")]
    pub mod click_tracker;
    // Windows Job Object wrapper that kills recording ffmpeg children the instant this app's own
    // process dies for any reason (including a force-kill), so they can't outlive it holding the
    // camera/mic open - see the module's own doc comment for the orphan this fixes.
    #[cfg(target_os = "windows")]
    pub mod process_job;
    // Repaints WebView2 after sleep/resume and after its GPU/page process dies - the blank white
    // window after reopening a laptop lid. See the module's own doc comment.
    #[cfg(target_os = "windows")]
    pub mod webview_recovery;
    // Polls ffmpeg's `-progress` sidecar file while a recording is in flight and forwards it to
    // the frontend as a `recording-progress` event - see the module's own doc comment for why
    // this exists (win.rs deliberately nulls ffmpeg's stdout/stderr, so there was previously no
    // live signal at all). Windows-only for now, same reasoning as process_job above.
    #[cfg(target_os = "windows")]
    pub mod progress_watch;
    // Detects a real, working hardware H.264 encoder via a trial encode, so recordings can
    // offload from the CPU instead of always using software libx264 - see the module's own doc
    // comment for why "does ffmpeg list this encoder" alone isn't good enough. Cross-platform:
    // NVENC/QSV/AMF on Windows, VideoToolbox on macOS, NVENC on Linux. The detection mechanism is
    // a real subprocess encode with the exact intended flags, which is platform-agnostic by
    // construction - nothing here needed to be Windows-specific.
    pub mod hw_encoder;
    // HEIC/HEIF decoding via WIC/WinRT (Windows' own photo codec) - see the module's doc comment
    // for why convert_image (commands/conversion.rs) can't just hand these to ffmpeg: this bundled
    // ffmpeg build mis-decodes multi-image HEIC files (Portrait mode, Deep Fusion, etc.) as a
    // black frame instead of the actual photo. macOS's WebKit-based webview decodes HEIC directly
    // in <img> tags, which is why get_heic_preview (the live-viewing path) doesn't need a non-
    // Windows fix - but convert_image/get_image_thumbnail have the exact same ffmpeg bug on macOS
    // and Linux too (see heic_unix.rs below), so this module's use is Windows-only, not the
    // underlying problem.
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
    // macOS/Linux counterpart to heic_windows.rs + heif_tool.rs above - same underlying problem
    // (ffmpeg mis-decodes multi-image HEIC), same libheif-backed fix, just via a system-installed
    // `heif-convert`/`heif-thumbnailer` instead of a bundled Windows binary - see the module's own
    // doc comment for why bundling isn't the right call here.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub mod heic_unix;
}
use simplelog::{CombinedLogger, ConfigBuilder, WriteLogger};

use log::{error, LevelFilter};
use std::fs::OpenOptions;
use std::panic;

// Terminal half of the logger. Lines are handed to a background thread rather than written to
// stdout inline: in a dev build stdout is a pipe to the `tauri dev` terminal, and whenever that
// pipe stopped being drained, every log call in the process blocked on it - the UI thread, the
// watchdog, and stop_recording/pause_recording mid-command alike - which froze the Stop and Pause
// buttons for minutes at a time. If the queue is full the line is dropped from the terminal only;
// app.log still gets every line.
struct NonBlockingStdout(std::sync::mpsc::SyncSender<Vec<u8>>);

impl NonBlockingStdout {
    fn spawn() -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(4096);
        // If the thread can't start, rx is dropped and every try_send below just fails quietly.
        let _ = std::thread::Builder::new()
            .name("log-stdout".into())
            .spawn(move || {
                use std::io::Write;
                let mut out = std::io::stdout();
                for chunk in rx {
                    let _ = out.write_all(&chunk);
                }
            });
        Self(tx)
    }
}

impl std::io::Write for NonBlockingStdout {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = self.0.try_send(buf.to_vec());
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// File half of the logger, capped: once app.log passes MAX_LOG_BYTES it becomes app.log.1
// (replacing the previous one) and a fresh app.log starts, so the logs never hold more than about
// twice the cap. Uncapped and at TRACE, a month of normal use reached 126 MB.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

struct RotatingLogFile {
    path: std::path::PathBuf,
    file: Option<std::fs::File>,
    written: u64,
}

impl RotatingLogFile {
    fn open(path: std::path::PathBuf) -> std::io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        let mut log = Self { path, file: Some(file), written };
        if log.written >= MAX_LOG_BYTES {
            log.rotate();
        }
        Ok(log)
    }

    fn rotate(&mut self) {
        // Windows can't rename a file that's still open, so the handle goes first.
        self.file = None;
        let _ = std::fs::rename(&self.path, self.path.with_extension("log.1"));
        self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        self.written = 0;
    }
}

impl std::io::Write for RotatingLogFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.written >= MAX_LOG_BYTES {
            self.rotate();
        }
        self.written += buf.len() as u64;
        match self.file.as_mut() {
            Some(file) => file.write(buf),
            // Reopening failed - drop the line rather than fail the caller; logging must never
            // take the app down.
            None => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.as_mut().map_or(Ok(()), |f| f.flush())
    }
}

#[tauri::command(async)]
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

fn main() {
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
    // An unwritable app-data folder costs the log file, never the app.
    let log_file = RotatingLogFile::open(app_log_path).ok();

    // Configure logging with more verbose settings
    let config = ConfigBuilder::new()
        .set_time_format_rfc3339()
        .set_time_offset_to_local()
        .unwrap_or_else(|builder| builder)
        .build();

    // Initialize combined logger (writes to both file and terminal). The file comes first and the
    // terminal never blocks - see NonBlockingStdout for why.
    let mut loggers: Vec<Box<dyn simplelog::SharedLogger>> = Vec::new();
    if let Some(log_file) = log_file {
        // Everything while developing; INFO and up for users, which still keeps every warning,
        // error, watchdog stall and recording milestone without per-frame noise.
        loggers.push(WriteLogger::new(
            if cfg!(debug_assertions) { LevelFilter::Trace } else { LevelFilter::Info },
            config.clone(),
            log_file,
        ));
    }
    loggers.push(WriteLogger::new(LevelFilter::Debug, config, NonBlockingStdout::spawn()));
    let _ = CombinedLogger::init(loggers);

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

    // Must run before any TLS use (phone camera server, updater, telemetry) - see Cargo.toml's
    // rustls entry for why rustls can't pick a provider on its own in this build.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    services::responsiveness::install_async_runtime();

    tauri::Builder::default()
        // First, so a second launch exits before it registers anything: the running copy already
        // holds every global shortcut (Ctrl+Shift+R/H/B/D, see Dashboard.tsx), and a second one
        // starting up anyway is what used to produce "Couldn't register the panel-buttons
        // shortcut... it may already be in use by another app". Instead the running copy's main
        // window is brought forward - what the user launching it again actually wanted.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        // Checks this repo's latest GitHub Release for a newer signed build - see
        // src/utils/updater.ts for when the check runs and what the user sees.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .manage(commands::conversion::ConversionState::default())
        .manage(commands::native_playback::NativePlaybackState::default())
        .manage(services::file_watcher::FileWatcherState::default())
        .manage(services::phone_camera::PhoneCameraState::default())
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

            services::telemetry::init(app.handle());
            services::responsiveness::start_ui_watchdog(app.handle());
            #[cfg(target_os = "windows")]
            services::webview_recovery::install(app.handle());
            // All slow first-time probes (ffmpeg -list_devices, a trial hardware encode, a trial
            // GPU screen capture); doing them now in the background means the device pickers and
            // the first recording never wait on them.
            commands::recording::warm_device_cache(app.handle());
            commands::recording::prewarm_rec_completed_modal(app.handle());
            if let Ok(ffmpeg_path) = services::utility::get_ffmpeg_path(app.handle()) {
                std::thread::spawn(move || {
                    services::hw_encoder::detect(&ffmpeg_path);
                    commands::recording::warm_screen_capture(&ffmpeg_path);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system_info::get_ram_info,
            get_os_info,
            services::responsiveness::report_frontend_stall,
            services::responsiveness::report_frontend_event,
            services::telemetry::get_telemetry_settings,
            services::telemetry::set_telemetry_enabled,
            services::telemetry::dismiss_telemetry_notice,
            services::telemetry::track_event,
            services::telemetry::report_frontend_error,
            commands::recording::get_connected_audios,
            commands::recording::get_connected_cameras,
            commands::recording::get_connected_devices,
            commands::recording::start_recording,
            commands::recording::stop_recording,
            commands::recording::get_recording_status,
            commands::recording::load_click_sidecar,
            commands::recording::load_view_switch_sidecar,
            commands::recording::record_view_switch,
            commands::recording::get_webcam_sidecar_path,
            commands::recording::phone_camera_capture_chunk,
            commands::recording::get_recording_preview_frame,
            commands::recording::save_phone_camera_capture,
            services::phone_camera::start_phone_camera_server,
            services::phone_camera::stop_phone_camera_server,
            services::phone_camera::phone_camera_status,
            services::phone_camera::phone_camera_send_signal,
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
            commands::conversion::set_video_thumbnail,
            commands::conversion::get_video_scrub_sprite,
            commands::conversion::generate_captions,
            commands::conversion::audio_cleanup_waveform,
            commands::conversion::decode_audio_range,
            commands::conversion::transcribe_doc_audio,
            commands::conversion::convert_audio,
            commands::conversion::export_trimmed_video,
            commands::conversion::extract_clip_audio,
            commands::audio_tracks::probe_audio_streams,
            commands::file_info::get_file_info,
            commands::file_info::get_library_item_info,
            commands::audio_tracks::get_separation_engine,
            commands::audio_tracks::separate_voice_music,
            commands::audio_tracks::download_separation_engine,
            commands::audio_tracks::cancel_separation_engine_download,
            commands::audio_tracks::cancel_voice_music_separation,
            commands::conversion::detect_silence,
            commands::conversion::read_image_data_url,
            commands::conversion::read_file_bytes,
            commands::native_playback::start_native_playback,
            commands::native_playback::get_next_video_frame,
            commands::native_playback::get_next_audio_chunk,
            commands::native_playback::seek_native_playback,
            commands::native_playback::stop_native_playback,
            commands::snip::snip_begin,
            commands::snip::snip_info,
            commands::snip::snip_frame,
            commands::snip::snip_finish,
            commands::snip::snip_cancel,
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
            services::utility::get_cache_info,
            services::utility::clear_preview_cache,
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
            services::mindmaps::list_mindmaps,
            services::mindmaps::create_mindmap,
            services::mindmaps::duplicate_mindmap,
            services::mindmaps::save_mindmap,
            services::mindmaps::load_mindmap,
            services::mindmaps::delete_mindmap,
            services::mindmaps::import_mindmap_image,
            services::mindmaps::save_mindmap_image,
            services::mindmaps::save_mindmap_thumbnail,
            services::mindmaps::export_mindmap_file,
            services::mindmaps::export_mindmap_to_path,
            services::whiteboards::list_whiteboards,
            services::whiteboards::create_whiteboard,
            services::whiteboards::duplicate_whiteboard,
            services::whiteboards::save_whiteboard,
            services::whiteboards::load_whiteboard,
            services::whiteboards::delete_whiteboard,
            services::whiteboards::import_whiteboard_image,
            services::whiteboards::save_whiteboard_image,
            services::whiteboards::save_whiteboard_thumbnail,
            services::whiteboards::export_whiteboard_file,
            services::whiteboards::export_whiteboard_to_path,
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
            services::docs::export_doc_pdf,
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
            services::video_edits::save_video_chapters,
            services::video_edits::load_video_chapters,
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
            // Closing the main window quits Briefcast. Tauri only exits once EVERY window is gone,
            // and the overlay windows (recording bar, screenshot picker, annotation, countdown,
            // live display, completion popup) are pre-built and merely hidden - so the process used
            // to stay alive invisibly after the user closed the app, and the single-instance guard
            // then turned every relaunch into "focus a main window that no longer exists": nothing
            // happened at all. Destroyed, not CloseRequested, so the editors' own save-on-quit
            // handlers (which delay the close until they've flushed) always finish first.
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event {
                if label == "main" {
                    app_handle.exit(0);
                }
            }
            if let tauri::RunEvent::Exit = event {
                commands::window_capture::cleanup_stale_window_screenshots();
                commands::native_playback::cleanup_all_sessions(
                    &app_handle.state::<commands::native_playback::NativePlaybackState>(),
                );
            }
        });
}
