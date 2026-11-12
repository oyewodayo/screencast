// lib.rs
//
// The app itself. `main.rs` is only the desktop entry point; Tauri v2's Android and iOS shells
// call `run()` through `mobile_entry_point`, which is why everything lives in a library crate.
//
// Layout:
//   logging          - file + terminal logger and the panic hook, up before anything else
//   invoke_handler   - every command the frontend can call
//   commands/        - command modules that own a feature's state (recording, conversion, ...)
//   services/        - long-lived subsystems and storage (settings, tray, phone, docs, ...)
//
// Platform rule: a feature that only exists on some platforms keeps its commands registered
// everywhere and answers with a stub or a clear error elsewhere, so the frontend never calls a
// command that does not exist. Only plugins and modules whose *dependencies* cannot build on a
// target are cfg'd out, and that is done here, in one place.

mod invoke_handler;
mod logging;

pub(crate) mod commands {
    pub mod audio_stream;
    pub mod bleed_removal;
    pub mod audio_tracks;
    pub mod background_removal;
    pub mod camera_effects;
    pub mod compression;
    pub mod conversion;
    pub mod derived_images;
    pub mod embedded_scan;
    pub mod file_info;
    pub mod motion_tracking;
    pub mod object_find;
    pub mod face_find;
    pub mod music_library;
    // The AI voice's commands - see services/tts.rs.
    pub mod tts;
    pub mod native_playback;
    pub mod snip;
    pub mod screen_color;
    pub mod stage_render;
    pub mod recording;
    pub mod system_info;
    pub mod window_capture;
}
pub(crate) mod services {
    pub mod asset_download;
    pub mod bleed;
    pub mod transition_graphs;
    pub mod clip_fx;
    pub mod audio_fx;
    pub mod beat_detect;
    pub mod subject_track;
    pub mod boards;
    pub mod citations;
    pub mod docs;
    pub mod docs_search;
    pub mod links;
    pub mod file_watcher;
    pub mod google_share;
    pub mod image_annotations;
    pub mod pdf_annotations;
    // Serves a phone's browser as a camera source over the LAN - see the module's own doc
    // comment for why a webcam driver (DroidCam/Iriun/Camo) is otherwise the only way to get a
    // phone into a DirectShow device list, and why this needs to be an HTTPS server to avoid one.
    pub mod phone_camera;
    // "Transfer to phone" - sends files to a phone's browser over the LAN, pairing once by QR.
    // Builds on phone_camera's address/QR helpers; see the module's own doc comment.
    pub mod phone_transfer;
    // A real HTTPS certificate per install for phone transfers - see the module comment.
    pub mod lan_tls;
    // Phones on a USB cable: send to Android, import photos/videos from Android or iPhone, via
    // Windows Portable Devices. Commands exist everywhere; only Windows has a worker behind them.
    pub mod usb_phone;
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
    pub mod quiet_notifications;
    pub mod share;
    // Opt-out analytics + crash reports, compiled in only for release builds with keys.
    pub mod telemetry;
    pub mod sidecars;
    // App preferences in a file Rust can read with no window alive (shortcuts, tray, remote).
    pub mod settings_store;
    // "Record with my current setup", built from settings.json with no window alive.
    pub mod recording_setup;
    // Every system-wide shortcut, registered by Rust so it works with no page alive.
    pub mod shortcuts;
    // The main window's lifecycle: built here (not at startup by tauri.conf.json), released to the
    // tray and rebuilt on demand.
    pub mod main_window;
    // Recording control with or without the main window, and the side effects of every recording.
    pub mod recording_session;
    // The "3, 2, 1" before a recording, timed in Rust so it works with no main window.
    pub mod countdown;
    // "Start Briefcast when I sign in" - straight into the tray, no UI loaded.
    pub mod autostart;
    // Is the system ffmpeg (macOS/Linux) new enough, with the encoders recordings need?
    pub mod ffmpeg_check;
    pub mod trash;
    // The tray icon the closed window hides to - see the module's own comment.
    pub mod tray;
    pub mod utility;
    pub mod window_affinity;
    pub mod macos_permissions;
    pub mod whisper_model;
    // The AI voice: Kokoro text-to-speech on ONNX Runtime, and the text -> phonemes front end it needs.
    pub mod tts;
    pub mod tts_text;
    pub mod tts_vocab;
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
    // Mouse click tracking for the editor's auto-zoom on click.
    pub mod click_tracker;
    // The editable pointer and shortcut keys of a screen recording (the editor's Screen Style).
    pub mod input_tracker;
    // The annotation overlay's privacy blur - live acrylic regions you can still type through.
    // Stubbed off Windows inside the module, so its commands register everywhere.
    pub mod screen_blur;
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
    pub mod progress_watch;
    // Detects a real, working hardware H.264 encoder via a trial encode, so recordings can
    // offload from the CPU instead of always using software libx264 - see the module's own doc
    // comment for why "does ffmpeg list this encoder" alone isn't good enough. Cross-platform:
    // NVENC/QSV/AMF on Windows, VideoToolbox on macOS, NVENC on Linux. The detection mechanism is
    // a real subprocess encode with the exact intended flags, which is platform-agnostic by
    // construction - nothing here needed to be Windows-specific.
    pub mod hw_encoder;
    pub mod smart_render;
    pub mod hw_decoder;
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

use tauri::{AppHandle, Manager, RunEvent};

/// Entry point for every platform.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();

    // Must run before any TLS use (phone camera server, updater, telemetry) - see Cargo.toml's
    // rustls entry for why rustls can't pick a provider on its own in this build.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    services::responsiveness::install_async_runtime();

    register_plugins(tauri::Builder::default())
        .manage(commands::recording::AppState::default())
        .manage(commands::conversion::ConversionState::default())
        .manage(commands::conversion::ExportJobs::default())
        .manage(commands::motion_tracking::MotionTrackJobs::default())
        .manage(services::google_share::GoogleShareState::default())
        .manage(commands::native_playback::NativePlaybackState::default())
        .manage(services::file_watcher::FileWatcherState::default())
        .manage(services::phone_camera::PhoneCameraState::default())
        .manage(services::phone_transfer::PhoneTransferState::default())
        .manage(services::tray::TrayState::default())
        .manage(services::settings_store::SettingsStore::default())
        .manage(services::shortcuts::ShortcutsState::default())
        .manage(services::main_window::MainWindowState::default())
        .manage(services::recording_session::SessionState::default())
        .setup(|app| {
            setup(app.handle());
            Ok(())
        })
        .invoke_handler(invoke_handler::handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(on_run_event);
}

/// Desktop-only plugins first (their crates are not even compiled for Android/iOS - see
/// Cargo.toml), then the ones every platform has.
fn register_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(desktop)]
    let builder = builder
        // First, so a second launch exits before it registers anything: the running copy already
        // holds every global shortcut, and a second one starting up anyway is what used to produce
        // "Couldn't register the panel-buttons shortcut... it may already be in use by another
        // app". Instead the running copy's main window is brought forward - what the user
        // launching it again actually wanted.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            services::tray::show_main(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Checks this repo's latest GitHub Release for a newer signed build - see
        // src/utils/updater.ts for when the check runs and what the user sees. Desktop only:
        // app stores update mobile builds.
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
}

/// One-time startup work. Nothing here may block: every slow probe goes to its own thread, so the
/// first window paints without waiting on ffmpeg, the GPU or the disk.
fn setup(app: &AppHandle) {
    // Start watching the Briefcast folder for external changes right away, so the sidebar stays
    // live without needing a restart or a manual refresh click - see services/file_watcher.rs.
    // Best-effort: failures are logged inside start_watching itself and never block startup.
    match services::utility::briefcast_dir() {
        Ok(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            // Companion files written before they were hidden get hidden now (sidecars.rs).
            let hide_root = dir.clone();
            std::thread::spawn(move || services::sidecars::hide_sidecars_in(&hide_root));
            services::file_watcher::start_watching(app, &dir);
        }
        Err(e) => log::warn!("Could not resolve Briefcast dir for file watcher: {}", e),
    }

    // Before any page loads, so the shortcuts work from the first moment - window or not. On its
    // own thread: registering hands work to the main thread and waits for it, and setup itself is
    // running on the main thread before the event loop has started.
    let shortcuts_app = app.clone();
    std::thread::spawn(move || services::shortcuts::install(&shortcuts_app));
    if let Err(e) = services::tray::install(app) {
        log::warn!("Could not create the tray icon: {}", e);
    }
    services::telemetry::init(app);
    // Only if a phone was paired before - lets a phone that still has the page open reconnect
    // without anyone opening the Transfer dialog first.
    services::phone_transfer::autostart(app.clone());
    services::usb_phone::start(app);
    services::responsiveness::start_ui_watchdog(app);
    services::window_affinity::exclude_overlays_from_capture(app);
    #[cfg(target_os = "windows")]
    services::webview_recovery::install(app);
    // ffmpeg version and encoders, checked once in the background; the UI asks for the result.
    services::ffmpeg_check::warm(app);
    // A sign-in entry pointing at an executable an update has since moved is rewritten.
    std::thread::spawn(services::autostart::refresh);
    // After recovery is installed (create() attaches it to the new window itself). A `--tray`
    // launch - "Start Briefcast when I sign in" - comes up with no window: shortcuts, tray and the
    // phone remote all work without one, and the UI loads only when it's opened.
    if !services::main_window::launched_to_tray() {
        if let Err(e) = services::main_window::create(app, true) {
            log::error!("{}", e);
        }
    }
    // All slow first-time probes (ffmpeg -list_devices, a trial hardware encode, a trial GPU
    // screen capture); doing them now in the background means the device pickers and the first
    // recording never wait on them.
    commands::recording::warm_device_cache(app);
    // A recording that never reached its stop (crash, kill) leaves notifications muted.
    std::thread::spawn(services::quiet_notifications::restore);
    commands::recording::prewarm_rec_completed_modal(app);
    if let Ok(ffmpeg_path) = services::utility::get_ffmpeg_path(app) {
        std::thread::spawn(move || {
            services::hw_encoder::detect(&ffmpeg_path);
            commands::recording::warm_screen_capture(&ffmpeg_path);
        });
    }
}

fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        // Closing the main window quits Briefcast. Tauri only exits once EVERY window is gone, and
        // the overlay windows (recording bar, screenshot picker, annotation, countdown, live
        // display, completion popup) are pre-built and merely hidden - so the process used to stay
        // alive invisibly after the user closed the app, and the single-instance guard then turned
        // every relaunch into "focus a main window that no longer exists": nothing happened at
        // all. Destroyed, not CloseRequested, so the editors' own save-on-quit handlers (which
        // delay the close until they've flushed) always finish first.
        //
        // A release to the tray destroys it too (services/main_window.rs), and that one keeps the
        // app running.
        RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } if label == services::main_window::LABEL => {
            if !services::main_window::take_was_release(app) {
                services::main_window::request_quit(app);
                app.exit(0);
            }
        }
        // Tauri asks to exit when its last window closes. With the main window released, the hidden
        // overlays are the only windows - one closing (the completion popup does) must not end the
        // app the user is keeping in the tray. An explicit quit carries an exit code and passes.
        RunEvent::ExitRequested { code: None, api, .. } if !services::main_window::is_quitting(app) => {
            api.prevent_exit();
        }
        RunEvent::Exit => {
            commands::window_capture::cleanup_stale_window_screenshots();
            commands::native_playback::cleanup_all_sessions(
                &app.state::<commands::native_playback::NativePlaybackState>(),
            );
        }
        _ => {}
    }
}
