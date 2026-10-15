// services/webview_recovery.rs
//
// Brings the window back when WebView2 stops painting - most visibly as a blank white window
// after closing the laptop lid and opening it again.
//
// What happens there: the page itself survives sleep (app.log keeps showing frontend activity
// straight after a resume - thumbnails requested, stall reports from the page's own main thread),
// but the WebView's GPU compositing surface is lost while the machine is suspended and isn't
// rebuilt, so the window shows nothing but the background. A resize or minimize/restore usually
// brings it back, because both force WebView2 to recreate that surface - which is exactly what
// this module does on the user's behalf:
//
// 1. Resume watch: a background thread notices the wall clock jumping (the machine was asleep)
//    and nudges every visible WebView - IsVisible false -> true plus a position-changed
//    notification, the same thing a minimize/restore does internally. Twice, a few seconds
//    apart, because the GPU process often comes back a moment after the system does.
// 2. ProcessFailed: WebView2 reports when one of its child processes dies. GPU process gone ->
//    same nudge. Page (renderer) process gone -> reload, since a dead renderer stays white for
//    good. Every event is logged, so the next blank window leaves a trail either way.
//
// Windows-only: WebView2 is the Windows backend; WKWebView/WebKitGTK don't have this failure.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
};
use webview2_com::ProcessFailedEventHandler;

const RESUME_POLL: Duration = Duration::from_secs(2);
// The poll thread oversleeping by this much means the whole machine was suspended - nothing else
// stops a sleeping thread for 15s.
const RESUME_GAP: Duration = Duration::from_secs(15);
// Nudge once the display is likely back, then again in case the GPU process restarted late.
const NUDGE_DELAYS: [Duration; 2] = [Duration::from_millis(800), Duration::from_secs(4)];

// One GPU process serves every window, so its exit is reported once per window - and a resume
// can coincide with it. Only one refresh sequence runs at a time; the rest are dropped.
static REFRESH_RUNNING: AtomicBool = AtomicBool::new(false);

fn schedule_refresh(app: &AppHandle, reason: &'static str) {
    if REFRESH_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("webview-refresh".into()).spawn(move || {
        for delay in NUDGE_DELAYS {
            std::thread::sleep(delay);
            nudge_all(&app, reason);
        }
        REFRESH_RUNNING.store(false, Ordering::SeqCst);
    });
    if spawned.is_err() {
        REFRESH_RUNNING.store(false, Ordering::SeqCst);
    }
}

pub fn install(app: &AppHandle) {
    log::info!("[webview-recovery] installing for {} window(s)", app.webview_windows().len());
    for window in app.webview_windows().values() {
        watch_process_failures(app, window);
    }
    start_resume_watch(app);
}

fn start_resume_watch(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("resume-watch".into()).spawn(move || {
        let mut last = SystemTime::now();
        loop {
            std::thread::sleep(RESUME_POLL);
            let now = SystemTime::now();
            // Err = clock moved backwards (manual change / NTP) - not a resume, just re-baseline.
            if let Ok(elapsed) = now.duration_since(last) {
                if elapsed > RESUME_GAP {
                    log::info!(
                        "[webview-recovery] system resume detected (asleep ~{}s) - refreshing webviews",
                        elapsed.as_secs()
                    );
                    schedule_refresh(&app, "resume");
                }
            }
            last = SystemTime::now();
        }
    });
    if let Err(e) = spawned {
        log::warn!("[webview-recovery] could not start resume watch: {}", e);
    }
}

// Forces WebView2 to rebuild its rendering surface: toggling the controller's visibility is what
// minimize/restore does, and NotifyParentWindowPositionChanged makes it re-sync its bounds and
// re-present. Only for windows actually on screen - the hidden overlay windows stay as they are.
fn nudge_all(app: &AppHandle, reason: &'static str) {
    for (label, window) in app.webview_windows() {
        if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
            continue;
        }
        let result = window.with_webview(move |platform| unsafe {
            let controller = platform.controller();
            let mut visible = windows_core::BOOL::default();
            let _ = controller.IsVisible(&mut visible);
            if visible.as_bool() {
                let _ = controller.SetIsVisible(false);
                let _ = controller.SetIsVisible(true);
            }
            let _ = controller.NotifyParentWindowPositionChanged();
        });
        match result {
            Ok(()) => log::info!("[webview-recovery] refreshed \"{}\" ({})", label, reason),
            Err(e) => log::warn!("[webview-recovery] could not refresh \"{}\": {}", label, e),
        }
    }
}

fn kind_name(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> &'static str {
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser process exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "page process exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "page process unresponsive",
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => "frame process exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "GPU process exited",
        _ => "helper process exited",
    }
}

fn watch_process_failures(app: &AppHandle, window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let app = app.clone();
    let registered = window.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else { return };
        let window_label = label.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            if let Some(args) = args {
                let _ = args.ProcessFailedKind(&mut kind);
            }
            log::warn!("[webview-recovery] \"{}\": {}", label, kind_name(kind));
            match kind {
                // A dead renderer never comes back on its own - the page has to be reloaded.
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => {
                    if let Some(sender) = sender {
                        log::warn!("[webview-recovery] reloading \"{}\"", label);
                        let _ = sender.Reload();
                    }
                }
                // WebView2 restarts the GPU process itself, but the page can stay unpainted until
                // the surface is rebuilt. Off this callback (it runs inside WebView2's own
                // dispatch), and after the replacement GPU process has had a moment to start.
                COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => schedule_refresh(&app, "GPU process restart"),
                _ => {}
            }
            Ok(())
        }));
        let mut token = 0i64;
        match core.add_ProcessFailed(&handler, &mut token) {
            Ok(()) => log::info!("[webview-recovery] watching \"{}\" for process failures", window_label),
            Err(e) => log::warn!("[webview-recovery] could not watch \"{}\" for process failures: {}", window_label, e),
        }
    });
    if let Err(e) = registered {
        log::warn!("[webview-recovery] could not reach \"{}\": {}", window.label(), e);
    }
}
