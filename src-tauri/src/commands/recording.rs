//recording.rs
//
// Cross-platform orchestrator: owns the shared state/types and the ffmpeg-agnostic pieces
// (overlay filter-graph construction, graceful stop, the completion-modal window), and dispatches
// the actual per-mode ffmpeg invocations to a platform module selected at compile time. Each
// platform module (win/macos/linux) implements the same set of `recording_with_output_*`
// functions plus `get_connected_devices`, using whatever ffmpeg input format that OS needs
// (dshow / avfoundation / x11grab+pulse+v4l2) — see each module for details.
use chrono::Utc;
use log::{info, warn};
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::async_runtime::Mutex;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;

use crate::services::utility::{get_ffmpeg_path, path_to_str};

#[cfg(target_os = "windows")]
mod assembly;
#[cfg(target_os = "windows")]
mod gpu_capture;
#[cfg(target_os = "windows")]
mod win;
// pub(crate): window_capture::macos (a sibling module, not a descendant of this one) needs
// list_avfoundation_devices to enumerate "Capture screen N" devices for its own get_monitors -
// shared rather than duplicated so the ffmpeg-stderr-parsing logic only exists in one place.
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
pub(crate) mod macos;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
use win as platform;

// The in-flight phone-camera capture's paths, held in AppState for the life of one recording.
#[derive(Clone)]
pub struct PhoneCaptureTarget {
    // The screen recording this camera file belongs beside - decides the `_webcam.mp4` name.
    video_path: PathBuf,
    // Where MediaRecorder's bytes are being appended as they arrive.
    raw_path: PathBuf,
}

#[derive(Default)]
pub struct AppState {
    output_path: Arc<Mutex<Option<PathBuf>>>,
    // Newest live-preview frame for the recording in progress, fed straight from ffmpeg's stdout
    // by services/preview_stream.rs. Not behind the async Mutex the rest of this struct uses: the
    // producer is a blocking reader thread with no runtime to yield to.
    preview_frame: crate::services::preview_stream::PreviewFrame,
    // Where the phone camera's own recording is accumulating, for the recording in progress.
    //
    // Resolved once, on the first chunk, from output_path below - NOT passed in from the
    // frontend. start_recording returns a human-readable message ("Recording started. File will
    // be saved as:\n<path>"), not a bare path, and an earlier version of this feature handed that
    // whole string back as the video path: every chunk write then tried to open a file named after
    // a sentence. Deriving it here means the frontend never has to know the path at all, so it
    // cannot get it wrong.
    phone_capture: Arc<Mutex<Option<PhoneCaptureTarget>>>,
    ffmpeg_process: Arc<Mutex<Option<Child>>>, // NEW: Store the process
    // Whether the in-progress recording is currently paused (see pause_recording/resume_recording
    // below). Kept separately from ffmpeg_process's mere presence since "a process is running" and
    // "that process is actively capturing" are different questions once pausing exists - stop_
    // recording checks this to resume a paused process before asking it to shut down gracefully,
    // since a suspended process can't act on the 'q' written to its stdin either.
    paused: Arc<Mutex<bool>>,
    // Whether stop_recording should enhance the finished file's audio in place - a recording with
    // audio that isn't assembled (which enhances as it assembles): camera and audio-only modes, and
    // every mode outside Windows. See services/audio_enhance.rs.
    post_enhance: Arc<Mutex<bool>>,
    // The parts of a screen recording in progress (Windows) - the picture-only intermediate, its
    // frame timing, and the mic/system audio captured beside it - which stop_recording assembles
    // into the final file. See recording/assembly.rs.
    #[cfg(target_os = "windows")]
    assembly: Arc<Mutex<Option<assembly::Assembly>>>,
    // Click-tracking session for the recording currently in progress, if FormData.track_clicks
    // asked for one - Windows-only, see services/click_tracker.rs's own doc comment. stop_recording
    // stops it and writes its collected clicks to a sidecar JSON file next to the finished video.
    #[cfg(target_os = "windows")]
    click_capture: Arc<Mutex<Option<crate::services::click_tracker::ClickCapture>>>,
    // Screen<->camera view-switch events for the recording currently in progress, logged by the
    // record_view_switch command as the user toggles the live recording bar's "Screen"/"Camera"
    // control - see that command's own doc comment. Not Windows-only by construction (unlike
    // click_capture above): this is plain event bookkeeping, not an OS-specific capture mechanism,
    // so nothing here stops it from working wherever separate_webcam_capture eventually produces a
    // second file to switch to. Cleared at the start of every recording and written out (if
    // non-empty) as a sidecar JSON by stop_recording, same convention as click_capture's own
    // sidecar.
    view_switches: Arc<Mutex<Vec<ViewSwitchEvent>>>,
    // The live timer's inputs for the recording in progress - see get_recording_status.
    clock: Arc<std::sync::Mutex<Option<RecordingClock>>>,
}

// Wall-clock milliseconds, the same unit as the frontend's Date.now() its timer is built from.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingClock {
    pub record_type: String,
    pub started_at: i64,
    pub pause_started_at: Option<i64>,
    pub paused_accumulated_ms: i64,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub recording: bool,
    pub clock: Option<RecordingClock>,
}

// Lets a page that lost its state - reloaded after its renderer crashed (services/
// webview_recovery.rs), or opened while a recording runs - take control of the recording in
// progress again. Without this the page shows "Record", pressing it fails with "already in
// progress", and nothing on screen can stop the capture.
#[tauri::command]
pub async fn get_recording_status(state: State<'_, AppState>) -> Result<RecordingStatus, String> {
    let recording = state.output_path.lock().await.is_some()
        && state
            .ffmpeg_process
            .lock()
            .await
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
    let clock = if recording {
        state.clock.lock().unwrap_or_else(|p| p.into_inner()).clone()
    } else {
        None
    };
    Ok(RecordingStatus { recording, clock })
}

// One user-initiated toggle between "Screen" and "Camera" as the primary view during a recording
// that has both a screen and a separate camera stream to switch between (see
// FormData.separate_webcam_capture) - the editor and export step read the full sequence back to
// know when to cut from one to the other. `elapsed_secs` is computed by the FRONTEND (from the
// same recording-start timestamp its own live timer already uses, see RecordingOverlayWindow.tsx)
// rather than a backend Instant, so it lines up with what the user actually sees on the timer
// rather than a slightly-different backend notion of "when recording started."
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSwitchEvent {
    pub elapsed_secs: f64,
    pub mode: String,
}

#[derive(serde::Deserialize, Debug)]
pub struct FormData {
    file_name: String,
    file_ext: String,
    record_type: String,
    audio_device: String,
    #[serde(default)]
    video_devices: Vec<String>,
    screen_size: String,
    overlay_shape: String,
    overlay_position: String,
    overlay_size: String,
    // Camera bubble border: "none" | "thin" | "medium" | "thick", and its "#rrggbb" colour - see
    // OverlayStyle. Defaults keep an older caller's recording exactly as before (no border).
    #[serde(default = "default_border")]
    overlay_border: String,
    #[serde(default = "default_border_color")]
    overlay_border_color: String,
    // The title of the window screen_size names (as "window:<hwnd>") — the hwnd alone isn't
    // enough to actually *capture* that window on Windows (gdigrab targets windows by title, not
    // handle), so the frontend sends this alongside it. #[serde(default)] so a caller that
    // doesn't set it (screen_size isn't "window:...") doesn't need to send an empty string.
    #[serde(default)]
    window_title: String,
    // Whether to also capture system/"what you hear" audio (WASAPI loopback, Windows-only) -
    // only meaningful for the screen-capture modes (sva/sa/s); ignored otherwise. See
    // start_recording's handling of this field and services/audio_capture.rs.
    #[serde(default)]
    include_system_audio: bool,
    // Opt-in (default false via #[serde(default)], so an older/unaware caller reproduces today's
    // behavior exactly) - see recording_with_output_sva's own doc comment (win.rs) for what this
    // actually changes and why it's gated to exactly one camera on record_type "sva" only.
    #[serde(default)]
    separate_webcam_capture: bool,
    // Opt-in (default false), Windows-only - see services/click_tracker.rs and start_recording's
    // own handling of this field. Only meaningful for the screen-capture modes (sva/sa/s), same
    // as include_system_audio above.
    #[serde(default)]
    track_clicks: bool,
    // Max output width in px for screen-capture modes (sva/sa/s) - None reproduces the previous
    // hardcoded behavior exactly (MAX_RECORDING_WIDTH, 1920). The frontend's "native" option sends
    // a very large value (comfortably above any realistic display) rather than a separate sentinel/
    // boolean, so `min(iw, resolution_width)` in the scale filter naturally means "don't downscale"
    // without a second code path - same reasoning MAX_RECORDING_WIDTH's own doc comment gives for
    // why a cap exists at all (a software/marginal-hardware decode path struggling with an
    // undownscaled 4K/5K capture), now genuinely optional since hardware encoding (see
    // services/hw_encoder.rs) makes a higher-resolution capture far more feasible than when this
    // was software-libx264-only.
    #[serde(default)]
    resolution_width: Option<i32>,
    // Target capture framerate for screen-capture modes - None reproduces the previous hardcoded
    // per-mode default exactly (60 for sva, 30 for sa/s).
    #[serde(default)]
    framerate: Option<i32>,
    // Studio cleanup of the audio once the recording stops (Settings > "Enhance audio
    // automatically", services/audio_enhance.rs). Defaults on for a caller that doesn't send it.
    #[serde(default = "enhance_by_default")]
    enhance_audio: bool,
    // Set by start_recording, never sent by the frontend: where ffmpeg writes when the recording is
    // assembled at stop (Windows screen modes - see recording/assembly.rs) instead of written
    // straight to its final path.
    #[serde(skip)]
    capture_path: Option<PathBuf>,
    // Set by start_recording: the app is capturing the mic itself, so ffmpeg mustn't.
    #[serde(skip)]
    mic_external: bool,
}

fn default_border() -> String {
    "none".to_string()
}

fn default_border_color() -> String {
    "#ffffff".to_string()
}

fn enhance_by_default() -> bool {
    true
}

impl AppState {
    /// A handle on the live-preview slot, for the reader thread that fills it.
    ///
    /// Cloning the Arc rather than lending a reference matters: the thread outlives this call and
    /// runs until ffmpeg closes its stdout.
    pub(crate) fn preview_frame_handle(&self) -> crate::services::preview_stream::PreviewFrame {
        self.preview_frame.clone()
    }
}

impl FormData {
    // Removes the phone-camera sentinel (services/phone_camera.rs) from video_devices, reporting
    // whether it was there.
    //
    // This MUST run before any platform::recording_with_output_* sees the FormData. Every one of
    // them treats video_devices as a list of real capture-device names and interpolates them
    // straight into ffmpeg input args (`-f dshow -i video=<name>` on Windows, and the avfoundation
    // /v4l2 equivalents elsewhere), so leaving the sentinel in would hand ffmpeg a device that
    // cannot exist and kill the whole recording - not just the camera.
    //
    // The phone's video never reaches ffmpeg at record time at all: it arrives over WebRTC in the
    // WebView, which records it itself and hands the finished file to save_phone_camera_capture
    // below. So as far as the ffmpeg side is concerned, stripping the sentinel leaves exactly the
    // right thing behind - the real cameras, if any, and nothing else.
    fn strip_phone_camera(&mut self) -> bool {
        let before = self.video_devices.len();
        self.video_devices
            .retain(|d| d != crate::services::phone_camera::PHONE_DEVICE_SENTINEL);
        before != self.video_devices.len()
    }
}

// What a "screen" capture should actually point ffmpeg at, resolved once from FormData.screen_size
// (and, for windows, window_title) so every capture mode — take_screenshot and every
// screen-capturing recording_with_output_* — interprets it the same way instead of each
// reimplementing (or, as before this existed, half-implementing) its own parsing of it.
pub(crate) enum CaptureTarget {
    FullScreen,
    Monitor {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    },
    Window {
        title: String,
    },
}

// screen_size arrives as "fullscreen", "monitor:<id>", or "window:<hwnd>" (see
// EnhancedScreenOptions.tsx). The monitor case resolves `<id>` against get_monitors() for real
// geometry — previously this whole value was passed straight through as literal ffmpeg
// `-video_size` text, which is only ever a valid WxH string for the "fullscreen" case; for
// "monitor:monitor_0" or "window:66" it handed ffmpeg outright invalid syntax it could only
// reject. Falls back to FullScreen (rather than erroring the whole capture out) if a monitor id
// can't be resolved — a screen recording that captures more than intended beats one that
// silently doesn't start at all.
pub(crate) fn resolve_capture_target(
    app_handle: &AppHandle,
    form_data: &FormData,
) -> CaptureTarget {
    if let Some(monitor_id) = form_data.screen_size.strip_prefix("monitor:") {
        if let Ok(monitors) = crate::commands::window_capture::get_monitors(app_handle.clone()) {
            if let Some(m) = monitors.iter().find(|m| m.id == monitor_id) {
                return CaptureTarget::Monitor {
                    x: m.x,
                    y: m.y,
                    width: m.width,
                    height: m.height,
                };
            }
        }
        return CaptureTarget::FullScreen;
    }

    if form_data.screen_size.starts_with("window:") && !form_data.window_title.is_empty() {
        return CaptureTarget::Window {
            title: form_data.window_title.clone(),
        };
    }

    CaptureTarget::FullScreen
}

// Resolves a CaptureTarget to real SCREEN-coordinate pixel bounds - what services/click_tracker.rs
// needs to normalize a raw mouse-hook click position against, since gdigrab captures exactly this
// same region (see gdigrab_input_args, win.rs) and the editor's own overlay positions are all
// normalized fractions of "the captured frame", not raw screen pixels. FullScreen resolves against
// the virtual screen's own bounds (every monitor combined, with a possibly-negative origin if a
// monitor sits left of/above the primary) since that's what a plain "-i desktop" with no offset/
// crop actually grabs - not just the primary monitor.
#[cfg(target_os = "windows")]
pub(crate) fn capture_region_bounds(target: &CaptureTarget) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    match target {
        CaptureTarget::FullScreen => {
            let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
            let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
            if width <= 0 || height <= 0 {
                return None;
            }
            let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
            let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
            Some((x, y, width, height))
        }
        CaptureTarget::Monitor {
            x,
            y,
            width,
            height,
        } => Some((*x, *y, *width, *height)),
        CaptureTarget::Window { title } => {
            crate::commands::window_capture::win::get_window_rect_by_title(title).ok()
        }
    }
}

// Where a recording's own click-tracking data lives, if it has any - shared between stop_recording
// (which writes it) and load_click_sidecar below (which the editor calls to read it back). Mirrors
// the ".system_audio.wav"/"_webcam.mp4" sibling-file convention this same module already uses for
// other per-recording artifacts, rather than video_edits.rs's own ".edits.json" (append-to-whole-
// filename) convention - the two sidecar families were established independently and neither
// needs to match the other, just be internally consistent.
fn click_sidecar_path(video_path: &Path) -> PathBuf {
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    video_path.with_file_name(format!("{}.clicks.json", stem))
}

// Reads back whatever click_sidecar_path holds for `video_path`, if anything - None (not an
// error) when the video was never recorded with track_clicks on, same "no sidecar yet is normal,
// not a failure" convention load_video_edit_state (video_edits.rs) already uses.
#[tauri::command(async)]
pub fn load_click_sidecar(video_path: String) -> Result<Option<String>, String> {
    let _serial = crate::services::responsiveness::serial();
    let sidecar = click_sidecar_path(&PathBuf::from(&video_path));
    if !sidecar.exists() {
        return Ok(None);
    }
    fs::read_to_string(&sidecar)
        .map(Some)
        .map_err(|e| format!("Failed to read click-tracking sidecar: {}", e))
}

// Same sidecar convention as click_sidecar_path above, for the screen<->camera view-switch
// timeline instead of clicks.
fn view_switch_sidecar_path(video_path: &Path) -> PathBuf {
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    video_path.with_file_name(format!("{}.viewswitch.json", stem))
}

// Reads back whatever view_switch_sidecar_path holds for `video_path`, if anything - None (not an
// error) when the video was never recorded with any view switches, same convention
// load_click_sidecar above uses.
#[tauri::command(async)]
pub fn load_view_switch_sidecar(video_path: String) -> Result<Option<String>, String> {
    let _serial = crate::services::responsiveness::serial();
    let sidecar = view_switch_sidecar_path(&PathBuf::from(&video_path));
    if !sidecar.exists() {
        return Ok(None);
    }
    fs::read_to_string(&sidecar)
        .map(Some)
        .map_err(|e| format!("Failed to read view-switch sidecar: {}", e))
}

// Where a "record webcam separately" recording's own second file lives, if it has one - the
// naming convention win.rs's recording_with_output_sva establishes (`<stem>_webcam.mp4`). The
// editor calls this to find the file a view-switch timeline should cut TO. Returns None (not an
// error) if no such file exists - the normal case for any recording that didn't have
// FormData.separate_webcam_capture on, same "missing is fine" convention load_click_sidecar and
// load_view_switch_sidecar both use.
#[tauri::command(async)]
pub fn get_webcam_sidecar_path(video_path: String) -> Option<String> {
    let _serial = crate::services::responsiveness::serial();
    let path = PathBuf::from(&video_path);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("recording");
    let webcam_path = path.with_file_name(format!("{}_webcam.mp4", stem));
    if webcam_path.exists() {
        path_to_str(&webcam_path).ok().map(|s| s.to_string())
    } else {
        None
    }
}

// Where the phone-camera capture accumulates on disk while it's still being recorded. Next to
// the recording itself rather than in a temp dir so it's on the same volume as its final output.
fn phone_capture_raw_path(video_path: &Path, mime_type: &str) -> PathBuf {
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    // MediaRecorder hands back webm, or fragmented mp4 on newer Chromium.
    let ext = if mime_type.contains("mp4") { "mp4" } else { "webm" };
    video_path.with_file_name(format!("{}_webcam_raw.{}", stem, ext))
}

// Appends one MediaRecorder chunk to the in-progress phone capture.
//
// The recording is streamed to disk a chunk at a time rather than handed over in one piece at the
// end, because the whole thing has to cross Tauri's IPC boundary as JSON. A few minutes of 1080p
// is well into the hundreds of megabytes; as a JSON array of byte-numbers that inflates roughly
// fourfold and has to be held in memory whole on both sides at once - enough to wedge or kill the
// WebView outright. Per-chunk base64 keeps each message around a megabyte, bounds memory to one
// chunk, and means a crash mid-recording leaves everything already written still on disk.
//
// `first` truncates rather than appends, so a previous run's leftovers can't be prefixed onto this
// one - the frontend sets it on the first chunk of each recording.
#[tauri::command]
pub async fn phone_camera_capture_chunk(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    // The chunk arrives as a raw body with its metadata in headers, rather than as base64 inside a
    // JSON object. Video is the one thing that genuinely does not belong in Tauri's JSON IPC: at
    // the bitrates that look good, base64 inflates every chunk by a third, has to be built as a
    // string on the WebView's main thread, and parsed back out of a multi-megabyte JSON document
    // on this side - once every couple of seconds, for the whole recording. That overhead was what
    // forced the capture bitrate down in the first place; removing it is what lets the phone layer
    // record at full quality again.
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("Phone camera chunk arrived as JSON rather than raw bytes.".to_string())
        }
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string())
    };
    let mime_type = header("x-briefcast-mime").unwrap_or_else(|| "video/webm".to_string());
    let first = header("x-briefcast-first").as_deref() == Some("1");
    // On the first chunk, resolve the destination from the recording that's actually in progress
    // and remember it; every later chunk reuses it, so the answer can't drift mid-recording (and
    // stop_recording clearing output_path can't strand the final flush).
    let target = {
        let mut guard = state.phone_capture.lock().await;
        if first || guard.is_none() {
            let video_path = state
                .output_path
                .lock()
                .await
                .clone()
                .ok_or_else(|| {
                    "No recording is in progress, so there's nowhere to save the phone camera \
                     video."
                        .to_string()
                })?;
            let resolved = PhoneCaptureTarget {
                raw_path: phone_capture_raw_path(&video_path, &mime_type),
                video_path,
            };
            *guard = Some(resolved.clone());
            resolved
        } else {
            guard.as_ref().unwrap().clone()
        }
    };

    // Write on a blocking thread, for the same reason get_recording_preview_frame does above:
    // synchronous file I/O on the async runtime's workers starves it, and a starved runtime means
    // every other IPC call - including the ones the UI is waiting on - queues behind this one.
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(first)
            .append(!first)
            .open(&target.raw_path)
            .map_err(|e| {
                format!(
                    "Failed to open the phone camera capture file at {}: {e}",
                    target.raw_path.display()
                )
            })?;
        file.write_all(&bytes)
            .map_err(|e| format!("Failed to write the phone camera recording: {e}"))
    })
    .await
    .map_err(|e| format!("Failed to save the phone camera recording: {e}"))?
}

// Finishes the phone-camera recording accumulated by phone_camera_capture_chunk, landing it as
// the `<stem>_webcam.mp4` sidecar that get_webcam_sidecar_path (above) and the editor's PiP layer
// already know how to find - so a phone ends up indistinguishable from a real webcam recorded
// with FormData.separate_webcam_capture, and needs no new editor code at all.
//
// `start_offset_ms` is how long after ffmpeg started that the WebView's MediaRecorder actually
// began producing frames. It's never zero: start_recording has to spawn ffmpeg and wait out its
// own early-exit check before the frontend can even begin recording the phone stream. Rather than
// leaving the editor to reconcile two files with different zero points, the gap is padded onto the
// front of the camera file here so both share a t=0 - which is exactly what the PiP overlay and
// the view-switch timeline (buildViewSwitchOverlays, videoEditHandlers.ts) already assume.
#[tauri::command]
pub async fn save_phone_camera_capture(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    start_offset_ms: f64,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;

    // Taken, not borrowed: this capture is finished either way, and leaving it behind would let a
    // later recording pick up a stale target.
    let capture = state
        .phone_capture
        .lock()
        .await
        .take()
        .ok_or_else(|| "The phone camera never recorded anything.".to_string())?;

    let target = capture.video_path;
    let raw_path = capture.raw_path;
    let stem = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording")
        .to_string();
    let webcam_path = target.with_file_name(format!("{}_webcam.mp4", stem));

    match fs::metadata(&raw_path) {
        Ok(meta) if meta.len() > 0 => {}
        _ => {
            let _ = fs::remove_file(&raw_path);
            return Err("The phone camera recording came back empty.".to_string());
        }
    }

    let raw_str = path_to_str(&raw_path)?.to_string();
    let out_str = path_to_str(&webcam_path)?.to_string();

    let mut args: Vec<String> = vec!["-y".into(), "-i".into(), raw_str];

    // The frontend measures the offset from when it asked ffmpeg to start, but an assembled
    // screen recording begins at its first frame, which arrives later (GPU capture takes about a
    // second to come up) - re-based here onto that frame.
    #[cfg(target_os = "windows")]
    let start_offset_ms = {
        let parts = state.assembly.lock().await;
        let first_frame = parts.as_ref().and_then(|p| {
            let timing = p.timing.as_ref()?.lock().ok()?;
            Some((p.launch_hns, timing.segments(&p.pauses)?.start_hns()))
        });
        match first_frame {
            Some((launch, first)) => start_offset_ms - (first - launch) as f64 / 1e4,
            None => start_offset_ms,
        }
    };

    // Line the camera file up with the screen file: pad its head when it started later, trim it
    // when it started earlier. Sub-frame offsets aren't worth a filter pass.
    let offset_secs = start_offset_ms / 1000.0;
    if offset_secs > 0.02 {
        args.push("-vf".into());
        args.push(format!(
            "tpad=start_duration={:.3}:start_mode=add:color=black",
            offset_secs
        ));
    } else if offset_secs < -0.02 {
        args.push("-vf".into());
        args.push(format!("trim=start={:.3},setpts=PTS-STARTPTS", -offset_secs));
    }

    // A WebRTC-sourced MediaRecorder file is variable-frame-rate and, for webm, carries no
    // duration in its header at all (it was written as a live stream). Both are re-encoded away
    // here into a plain CFR mp4, which is what the editor's seeking assumes. Hardware encoding
    // when the machine has it, for the same reason the main recording path uses it.
    #[cfg(target_os = "windows")]
    let hw = crate::services::hw_encoder::detect(&ffmpeg_path);
    #[cfg(not(target_os = "windows"))]
    let hw: Option<()> = None;

    // Quality here is deliberately higher than the main recording's.
    //
    // This is a *second* encode of footage the phone already compressed once, so whatever it
    // spends is spent on top of an existing generation loss. The main recording encodes camera
    // frames straight from the sensor and can afford an ordinary quality target; this one is
    // re-compressing an H.264 stream, where the same target would visibly stack artefacts.
    //
    // (A straight `-c copy` would avoid the second encode entirely - measured at 9x faster and
    // half the size with every frame preserved - but it can only express the start offset below as
    // a container start_time, which the editor's PiP layer assumes is zero. Not worth trading
    // correct A/V alignment for, so the re-encode stays and simply pays for quality instead.)
    match hw {
        #[cfg(target_os = "windows")]
        Some(encoder) => {
            args.push("-c:v".into());
            args.push(encoder.name().to_string());
            args.extend(encoder.high_quality_args());
        }
        _ => {
            args.push("-c:v".into());
            args.push("libx264".into());
            args.push("-preset".into());
            args.push("faster".into());
            args.push("-crf".into());
            args.push("18".into());
        }
    }

    args.extend([
        // CFR, but at whatever rate the source actually ran at rather than a hardcoded 30 - a
        // phone sending 60fps was previously having half its frames thrown away here. `-fps_mode
        // cfr` alone still produces a constant rate (which is what the editor's seeking wants),
        // it just derives it from the input instead of overriding it.
        "-fps_mode".to_string(),
        "cfr".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        // The editor scrubs this file; without a relocated moov it has to read to the end first.
        "-movflags".to_string(),
        "+faststart".to_string(),
        // The phone sends video only (the page requests audio:false - the mic stays whichever
        // device the user picked on the PC), so there is deliberately no audio stream to map.
        "-an".to_string(),
        out_str,
    ]);

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.args(&args);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    hide_console_window(&mut cmd);

    let output = tauri::async_runtime::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| format!("Failed to run ffmpeg for the phone camera recording: {e}"))?
        .map_err(|e| format!("Failed to run ffmpeg for the phone camera recording: {e}"))?;

    if !output.status.success() {
        // Deliberately NOT cleaned up on failure. The raw file is the only copy of footage the
        // user cannot re-shoot - whatever went wrong in the conversion, throwing the recording
        // away on top of it is strictly worse. Tell them where it is instead.
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!(
            "Phone camera conversion failed, raw capture kept at {:?}: {}",
            raw_path,
            stderr
        );
        return Err(format!(
            "Couldn't convert the phone camera recording ({}). The raw footage was kept at {} - \
             it will play in VLC, and Briefcast can import it.",
            stderr.lines().last().unwrap_or("unknown ffmpeg error"),
            raw_path.display()
        ));
    }

    let _ = fs::remove_file(&raw_path);
    info!("Phone camera recording saved to {:?}", webcam_path);
    out_str_owned(&webcam_path)
}

// Small helper so save_phone_camera_capture can return an owned path string without borrowing a
// temporary - path_to_str hands back a &str tied to its argument.
fn out_str_owned(path: &Path) -> Result<String, String> {
    path_to_str(path).map(|s| s.to_string())
}

// Hands the frontend the newest live-preview frame, as raw JPEG bytes.
//
// The frame comes from memory, not from disk: ffmpeg streams the preview as MJPEG on its stdout
// and services/preview_stream.rs keeps the latest complete frame. So this is a buffer copy, which
// is what makes it safe to poll many times a second for the whole length of a recording.
//
// Raw, not a base64 data URL - base64 would cost 33% more bytes across the IPC boundary plus an
// encode here and a decode there, all of it to hand the frontend something it immediately turns
// back into binary. An empty response means "nothing to show yet", which covers both "no recording
// in progress" and "ffmpeg hasn't produced a frame yet"; a polling caller has no use for the
// distinction.
#[tauri::command]
pub async fn get_recording_preview_frame(
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let frame = state
        .preview_frame
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or(None);
    Ok(tauri::ipc::Response::new(frame.unwrap_or_default()))
}

// Waits for ffmpeg to finish writing after it has been asked to stop, force-killing only once it
// is demonstrably no longer making progress. Returns whether it had to resort to the kill.
//
// The previous version waited a flat two seconds and then killed unconditionally, which is the
// wrong shape for this problem: finalizing is not a fixed-cost operation. How long ffmpeg needs
// after 'q' scales with the recording - flushing encoder queues, writing an index, and for some
// containers rewriting structure at the head of the file - so a long or high-resolution capture
// can legitimately need far longer than two seconds, and killing it mid-write is precisely what
// corrupts the output. The frag-mp4 flags limit the damage for mp4 (the file stays playable up to
// the last complete fragment) but do nothing for avi/mkv/mov, and even for mp4 they only bound
// the loss rather than prevent it.
//
// So the timeout is on *progress*, not on elapsed time: as long as the output file keeps growing,
// ffmpeg is still doing the work it was asked to do and is left alone. Only when it has stopped
// both exiting and writing for IDLE_GRACE is it considered hung. A hard cap still exists so this
// can never wait forever on a pathological process.
fn wait_for_ffmpeg_to_finalize(process: &mut Child, output_path: &Path) -> bool {
    const POLL: Duration = Duration::from_millis(100);
    // No growth for this long, with the process still alive, means it is stuck rather than busy.
    // Matches the old flat timeout, which is a reasonable "it really isn't doing anything" bar.
    const IDLE_GRACE: Duration = Duration::from_secs(2);
    // Absolute ceiling, so a process that somehow keeps touching the file can't hold Stop open
    // indefinitely. Generous enough that only a genuinely stuck ffmpeg should ever reach it.
    const HARD_CAP: Duration = Duration::from_secs(120);

    let started = Instant::now();
    let mut last_progress = Instant::now();
    let mut last_size = fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);

    loop {
        match process.try_wait() {
            // Exited on its own - the file was finalized properly.
            Ok(Some(_)) => return false,
            Ok(None) => {}
            // Can't observe it any more; nothing useful left to do here.
            Err(_) => return false,
        }

        let size = fs::metadata(output_path).map(|m| m.len()).unwrap_or(last_size);
        if size != last_size {
            last_size = size;
            last_progress = Instant::now();
        }

        if started.elapsed() >= HARD_CAP {
            warn!(
                "ffmpeg still running {}s after being asked to stop, force-killing - the recording may be incomplete",
                HARD_CAP.as_secs()
            );
            let _ = process.kill();
            return true;
        }

        if last_progress.elapsed() >= IDLE_GRACE {
            warn!(
                "ffmpeg stopped writing {}s ago but hasn't exited, force-killing - the recording may be incomplete",
                IDLE_GRACE.as_secs()
            );
            let _ = process.kill();
            return true;
        }

        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
#[cfg(windows)]
mod shutdown_tests {
    use super::*;
    use std::process::Stdio;

    fn ps(script: &str) -> Child {
        Command::new("powershell")
            .args(["-NoProfile", "-Command", script])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn powershell")
    }

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("briefcast_shutdown_test_{name}"));
        let _ = fs::remove_file(&p);
        p
    }

    #[test]
    fn a_process_that_exits_promptly_is_not_killed() {
        let path = temp("quick");
        fs::write(&path, b"done").unwrap();
        let mut child = ps("exit 0");
        assert!(!wait_for_ffmpeg_to_finalize(&mut child, &path));
        let _ = fs::remove_file(&path);
    }

    // The regression this whole change exists for: ffmpeg still writing when the old flat
    // two-second timeout would have expired must be left alone, not killed mid-write.
    #[test]
    fn a_slow_but_still_writing_process_is_left_alone() {
        let path = temp("writing");
        fs::write(&path, b"").unwrap();
        let script = format!(
            "1..24 | ForEach-Object {{ Add-Content -LiteralPath '{}' -Value 'x'; Start-Sleep -Milliseconds 200 }}",
            path.display()
        );
        let mut child = ps(&script);
        let started = Instant::now();
        let killed = wait_for_ffmpeg_to_finalize(&mut child, &path);
        assert!(!killed, "a process still growing the output file must not be force-killed");
        assert!(
            started.elapsed() >= Duration::from_secs(3),
            "should have waited out the writes rather than giving up at the old 2s mark"
        );
        let _ = fs::remove_file(&path);
    }

    // The other half: alive but doing nothing is exactly what the kill is for.
    #[test]
    fn a_hung_process_is_killed_after_the_idle_grace() {
        let path = temp("hung");
        fs::write(&path, b"stalled").unwrap();
        let mut child = ps("Start-Sleep -Seconds 30");
        let started = Instant::now();
        assert!(wait_for_ffmpeg_to_finalize(&mut child, &path));
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "should give up shortly after the idle grace, not wait for the hard cap"
        );
        let _ = child.wait();
        let _ = fs::remove_file(&path);
    }
}

// Called by the live recording bar every time the user toggles between "Screen" and "Camera" as
// the primary view - just appends to AppState's own in-memory log, written out as a sidecar once
// the recording actually finishes (stop_recording). `elapsed_secs` is frontend-computed - see
// ViewSwitchEvent's own doc comment for why. No-ops rather than erroring if no recording is
// currently in progress (state.output_path is None) or mode isn't recognized - a stray/late call
// (e.g. a click landing right as the recording is already stopping) shouldn't surface a visible
// error for something this minor.
#[tauri::command]
pub async fn record_view_switch(
    state: State<'_, AppState>,
    elapsed_secs: f64,
    mode: String,
) -> Result<(), String> {
    if mode != "screen" && mode != "camera" {
        return Ok(());
    }
    if state.output_path.lock().await.is_none() {
        return Ok(());
    }
    state
        .view_switches
        .lock()
        .await
        .push(ViewSwitchEvent { elapsed_secs, mode });
    Ok(())
}

// ffmpeg's stderr always leads with its multi-hundred-character build banner (version, compile
// flags, bundled library list) before it ever gets to the actual failure, so dumping the whole
// thing as the error - as every take_screenshot used to - buries the one line anyone can act on
// under noise the UI can't even fully display. The real reason is reliably among the last few
// non-empty lines.
pub(crate) fn extract_ffmpeg_error(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return "ffmpeg exited with an error and produced no output".to_string();
    }
    let tail_len = lines.len().min(5);
    lines[lines.len() - tail_len..].join(" | ")
}

// Shared by every platform backend (win/macos/linux) - the swap is pure argument-vector
// surgery with nothing OS-specific in it, and hw_encoder handles which encoders are even worth
// probing per platform.
//
// Swaps codec_args_for_ext's software video-encode segment (`-c:v libx264 -preset ultrafast
// [-crf N]`) for a detected hardware encoder's own, when one actually works on this machine (see
// services/hw_encoder.rs) - CPU usage on a long/high-res recording is the single biggest
// encoding-side complaint this app's software-only libx264 path has (see
// RECORDING_UPGRADE_NOTES.md). Only for the h264-targeting containers that path already covers
// (mp4/mkv/avi/mov); webm's target codec is VP8, which has no equivalent widely-available
// hardware path, so it's left on software regardless. Finds the software segment by locating
// "-pix_fmt" (which immediately follows it in every one of those four branches) rather than
// hardcoding each branch's exact offset, so this stays correct if codec_args_for_ext's own args
// ever get reordered.
pub(crate) fn codec_args_for_ext_hw(ext: &str, ffmpeg_path: &std::path::Path) -> Vec<String> {
    let Some(encoder) = crate::services::hw_encoder::detect(ffmpeg_path) else {
        return codec_args_for_ext(ext);
    };
    let mut video = vec!["-c:v".to_string(), encoder.name().to_string()];
    video.extend(encoder.quality_args());
    codec_args_with_video_encoder(ext, &video, true).unwrap_or_else(|| codec_args_for_ext(ext))
}

// codec_args_for_ext's container/audio args with its software video-encoder segment (`-c:v ...`
// up to `-pix_fmt`) replaced by `video` - None for a container that segment doesn't exist in
// (webm, whose VP8 has no hardware path). `keep_pix_fmt` is false for encoders fed GPU-resident
// frames: -pix_fmt names a system-memory format, and asking for one would make ffmpeg try to
// convert frames it can't reach.
pub(crate) fn codec_args_with_video_encoder(
    ext: &str,
    video: &[String],
    keep_pix_fmt: bool,
) -> Option<Vec<String>> {
    if !matches!(ext.to_lowercase().as_str(), "mp4" | "mkv" | "avi" | "mov") {
        return None;
    }
    let args = codec_args_for_ext(ext);
    let cv_idx = args.iter().position(|a| a == "-c:v")?;
    let pix_fmt_idx = args.iter().position(|a| a == "-pix_fmt")?;
    if pix_fmt_idx <= cv_idx {
        return None;
    }

    let mut patched = args[..cv_idx].to_vec();
    patched.extend(video.iter().cloned());
    let rest = if keep_pix_fmt { pix_fmt_idx } else { pix_fmt_idx + 2 };
    patched.extend(args[rest..].iter().cloned());
    Some(patched)
}

// Caps the encoded/composited frame width for every desktop-capture recording mode - screen
// capture otherwise grabs at the monitor's exact native pixel resolution (see win.rs's
// desktop_crop_args) with no downscale at all, so a 4K/5K display produces files whose frames a
// software (or marginal-hardware) <video> decode path can struggle to keep up with in real time,
// which is what actually caused "playback lags/skips" - not a bug the browser reports as an
// error, so the existing get_playable_preview recovery path (conversion.rs) never even sees it.
// 1920 (1080p) is the safe, universally hardware-decodable ceiling every WebView2/Chromium build
// handles smoothly, and is still sharp for typical screencast content even downscaled from 4K.
// Only ever downscales (ffmpeg's scale filter leaves a source already <= this width untouched).
pub(crate) const MAX_RECORDING_WIDTH: i32 = 1920;

// Floor for FormData.resolution_width - below this a "downscale" would start looking more like a
// thumbnail than a screen recording, regardless of what a caller sends. No explicit ceiling: a
// user-requested "native" capture intentionally sends something far above any real display's own
// width (see FormData.resolution_width's own doc comment) - clamping that down would silently
// defeat the one thing that option is for.
const MIN_RESOLUTION_WIDTH: i32 = 640;

// Resolves FormData.resolution_width to a real scale-filter target, clamping a too-small explicit
// request rather than trusting it outright, and falling back to the previous hardcoded
// MAX_RECORDING_WIDTH when the caller didn't ask for anything in particular (every pre-existing
// caller, and every macOS/Linux one - see codec_args_for_ext_hw's own doc comment on why hardware-
// specific changes in this session stay Windows-only).
pub(crate) fn resolved_max_width(form_data: &FormData) -> i32 {
    form_data
        .resolution_width
        .map(|w| w.max(MIN_RESOLUTION_WIDTH))
        .unwrap_or(MAX_RECORDING_WIDTH)
}

// libx264 defaults to a ~250-frame GOP when -g is unset, which at these recording framerates
// (30-60fps) is 4-8+ seconds between keyframes - fine for straight-through decode, but expensive
// to seek/scrub through (every seek has to decode forward from the nearest preceding keyframe).
// 60 keeps that to at most 2s (30fps) or 1s (60fps) without meaningfully hurting compression.
const KEYFRAME_INTERVAL: &str = "60";

// The resolution a camera is captured at (dshow/avfoundation/v4l2 `-video_size`). Every named
// bubble size captures at 640x480 - a mode practically every webcam supports - and the bubble is
// scaled from that: the old "small" captured at 320x240, which looked soft even small, and asking
// a camera for a size it doesn't offer fails the whole recording. A literal "WxH" passes through.
pub fn map_overlay_size(size: &str) -> String {
    match size {
        "xs" | "small" | "medium" | "large" | "xl" => "640x480".to_string(),
        _ => size.to_string(),
    }
}

// How a camera bubble looks, as chosen in the Screen Options modal. Sizes, margins and border
// thickness are all fractions of the recorded frame's width, so a bubble looks the same at 1080p
// and at 4K - and so the modal's preview (CameraOverlayPreview.tsx, which mirrors every number
// here) can draw it exactly.
pub(crate) struct OverlayStyle<'a> {
    pub shape: &'a str,
    pub position: &'a str,
    pub size: &'a str,
    // "none" | "thin" | "medium" | "thick".
    pub border: &'a str,
    // "#rrggbb".
    pub border_color: &'a str,
}

fn even(v: f64) -> i32 {
    ((v.round() as i32) / 2 * 2).max(2)
}

// Bubble width as a share of the frame's.
fn bubble_fraction(size: &str) -> f64 {
    match size {
        "xs" => 0.10,
        "medium" => 0.18,
        "large" => 0.24,
        "xl" => 0.30,
        _ => 0.14, // "small" and anything unrecognised
    }
}

// The camera picture inside one bubble (border excluded): square for circle/rounded, 4:3 for the
// plain rectangle.
fn overlay_pixel_dimensions(shape: &str, size: &str, frame_width: i32) -> (i32, i32) {
    let side = even(frame_width as f64 * bubble_fraction(size));
    match shape {
        "circle" | "rounded" => (side, side),
        _ => (side, even(side as f64 * 3.0 / 4.0)),
    }
}

fn border_px(border: &str, frame_width: i32) -> i32 {
    let w = frame_width as f64;
    match border {
        "thin" => even((w * 0.003).max(2.0)),
        "medium" => even((w * 0.006).max(4.0)),
        "thick" => even((w * 0.011).max(6.0)),
        _ => 0,
    }
}

// "#rrggbb" for ffmpeg's color source; anything malformed falls back to white.
fn ffmpeg_color(hex: &str) -> String {
    let h = hex.trim().trim_start_matches('#');
    if h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("0x{}", h)
    } else {
        "white".to_string()
    }
}

// geq: 255 inside a rounded rectangle inset `o` px into the frame with corner radius `r`, else 0.
fn rounded_mask(o: i32, r: i32) -> String {
    format!(
        "if(lte(pow(max(max({o}+{r}-X,X-(W-1-{o}-{r})),0),2)+pow(max(max({o}+{r}-Y,Y-(H-1-{o}-{r})),0),2),{r}*{r}),255,0)",
        o = o,
        r = r
    )
}

// geq: 255 inside a centred circle inset `o` px into the frame, else 0.
fn circle_mask(o: i32) -> String {
    format!("if(lte((X-W/2+0.5)^2+(Y-H/2+0.5)^2,(W/2-{o})^2),255,0)", o = o)
}

// Where bubble `index` of `count` goes, for bubbles `bubble_w` wide (border included). Bubbles
// stack outward from the anchor corner; margin and gap scale with the frame like everything else.
fn overlay_position_expr(anchor: &str, index: usize, count: usize, bubble_w: i32, frame_width: i32) -> String {
    let margin = even(frame_width as f64 * 0.025);
    let gap = even(frame_width as f64 * 0.012);
    let step = index as i32 * (bubble_w + gap);

    // (horizontal, vertical) - the 3x3 grid the modal offers.
    let (x_base, y_base) = match anchor {
        "top_left" => ("left", "top"),
        "top_center" => ("center", "top"),
        "top_right" => ("right", "top"),
        "center_left" => ("left", "middle"),
        "center" => ("center", "middle"),
        "center_right" => ("right", "middle"),
        "bottom_left" => ("left", "bottom"),
        "bottom_center" => ("center", "bottom"),
        // "bottom_right" and any unrecognized anchor.
        _ => ("right", "bottom"),
    };
    let x_expr = match x_base {
        "left" => format!("{}+{}", margin, step),
        "center" => {
            let total = count as i32 * bubble_w + (count.saturating_sub(1)) as i32 * gap;
            format!("(W-{})/2+{}", total, step)
        }
        _ => format!("W-w-{}-{}", margin, step),
    };
    let y_expr = match y_base {
        "top" => format!("{}", margin),
        "middle" => "(H-h)/2".to_string(),
        _ => format!("H-h-{}", margin),
    };
    format!("overlay=x={}:y={}", x_expr, y_expr)
}

// One camera's bubble, composited onto `prev_label` into `out_label`.
//
// Everything that defines the bubble's shape and border is drawn ONCE and looped: masks and the
// border ring are static images, merged with each camera frame. Computing them per frame (geq)
// measured ~1.8 CPU cores on its own; looped, the whole composite costs ~0.3. The camera is
// center-cropped to the bubble's aspect rather than squeezed into it.
#[allow(clippy::too_many_arguments)]
fn overlay_stage_filter(
    style: &OverlayStyle,
    n: usize,
    input_label: &str,
    prev_label: &str,
    out_label: &str,
    position_expr: &str,
    pic: (i32, i32),
    border: i32,
) -> String {
    let (w, h) = pic;
    let (bw, bh) = (w + 2 * border, h + 2 * border);
    let color = ffmpeg_color(style.border_color);
    let radius = (w / 8).max(4);
    let shaped = style.shape == "circle" || style.shape == "rounded";
    // The camera, cropped to the bubble's aspect and scaled into it.
    let crop = if shaped {
        "crop='min(iw,ih)':'min(iw,ih)'"
    } else {
        "crop='min(iw,ih*4/3)':'min(ih,iw*3/4)'"
    };
    let mut picture = format!(
        "{input}{crop},scale={w}:{h},setsar=1,format=yuva420p",
        input = input_label,
        crop = crop,
        w = w,
        h = h
    );
    let mut stages = Vec::new();
    let mut cam = format!("cam{}", n);

    if border > 0 {
        // The picture sits inside a border-coloured frame. For shaped bubbles a looped ring
        // (border colour between the outer and inner shape) covers the frame's square corners
        // inside the outer shape, so the border follows the curve.
        picture.push_str(&format!(",pad={bw}:{bh}:{b}:{b}:color={c}", bw = bw, bh = bh, b = border, c = color));
        stages.push(format!("{}[{}]", picture, cam));
        let ring = match style.shape {
            "circle" => Some((circle_mask(0), circle_mask(border))),
            "rounded" => Some((rounded_mask(0, radius + border), rounded_mask(border, radius))),
            _ => None,
        };
        if let Some((outer, inner)) = ring {
            stages.push(format!(
                "color=c={c}:s={bw}x{bh}:r=1:d=1,format=yuva420p[ringc{n}]; \
                 color=black:s={bw}x{bh}:r=1:d=1,format=gray,geq=lum='if(gt({outer},0)*eq({inner},0),255,0)'[ringm{n}]; \
                 [ringc{n}][ringm{n}]alphamerge,loop=-1:1:0[ring{n}]; \
                 [{cam}][ring{n}]overlay=0:0:eof_action=repeat[camr{n}]",
                c = color,
                bw = bw,
                bh = bh,
                outer = outer,
                inner = inner,
                n = n,
                cam = cam
            ));
            cam = format!("camr{}", n);
        }
    } else {
        stages.push(format!("{}[{}]", picture, cam));
    }

    // The outer shape, cut out of the (bordered) picture.
    let outer = match style.shape {
        "circle" => Some(circle_mask(0)),
        "rounded" => Some(rounded_mask(0, radius + border)),
        _ => None,
    };
    let bubble = match outer {
        Some(mask) => {
            stages.push(format!(
                "color=black:s={bw}x{bh}:r=1:d=1,format=gray,geq=lum='{mask}',loop=-1:1:0[mask{n}]; \
                 [{cam}][mask{n}]alphamerge[bubble{n}]",
                bw = bw,
                bh = bh,
                mask = mask,
                n = n,
                cam = cam
            ));
            format!("[bubble{}]", n)
        }
        None => format!("[{}]", cam),
    };
    stages.push(format!("{}{}{}[{}]", prev_label, bubble, position_expr, out_label));
    stages.join("; ")
}

// Builds the full filter_complex chaining one overlay stage per camera onto the screen ([0:v],
// or `screen` - see build_camera_overlay_filter_complex_from), then a final downscale stage
// capping the composite at `max_width`, left unlabeled so ffmpeg maps it automatically.
//
// `crop` (w, h, x, y) is Some only for macOS's own window-capture path: avfoundation has no
// per-window capture mode at all, so a specific window has to be cropped out of a full-display
// capture instead - see window_capture::macos::get_window_rect_by_title.
#[cfg_attr(target_os = "windows", allow(dead_code))] // Windows uses the _from form below
pub fn build_camera_overlay_filter_complex(
    shape: &str,
    position: &str,
    size: &str,
    camera_count: usize,
    max_width: i32,
    crop: Option<(i32, i32, i32, i32)>,
) -> String {
    let style = OverlayStyle { shape, position, size, border: "none", border_color: "#ffffff" };
    build_camera_overlay_filter_complex_from(
        &style,
        camera_count,
        max_width,
        max_width.min(MAX_RECORDING_WIDTH),
        crop.map(|(w, h, x, y)| format!("[0:v]crop={}:{}:{}:{}", w, h, x, y)).as_deref(),
        1,
    )
}

// Same graph, with `screen` - a filter chain producing the screen picture - in place of the raw
// [0:v] input, and the cameras starting at input `first_camera`. `frame_width` is the width of
// the picture the bubbles are composited onto, which every bubble dimension scales with.
pub(crate) fn build_camera_overlay_filter_complex_from(
    style: &OverlayStyle,
    camera_count: usize,
    max_width: i32,
    frame_width: i32,
    screen: Option<&str>,
    first_camera: usize,
) -> String {
    let pic = overlay_pixel_dimensions(style.shape, style.size, frame_width);
    let border = border_px(style.border, frame_width);
    let bubble_w = pic.0 + 2 * border;
    let mut stages: Vec<String> = Vec::with_capacity(camera_count + 2);
    let mut prev_label = "[0:v]".to_string();

    if let Some(chain) = screen {
        stages.push(format!("{}[src]", chain));
        prev_label = "[src]".to_string();
    }

    for index in 0..camera_count {
        let input_label = format!("[{}:v]", index + first_camera);
        let position_expr = overlay_position_expr(style.position, index, camera_count, bubble_w, frame_width);
        let out_label = format!("comp{}", index + 1);
        stages.push(overlay_stage_filter(style, index, &input_label, &prev_label, &out_label, &position_expr, pic, border));
        prev_label = format!("[{}]", out_label);
    }

    stages.push(format!("{}scale='min({},iw)':-2", prev_label, max_width));
    stages.join("; ")
}

// Output codec flags per container extension. win.rs's sva mode predates this and keeps its own
// inline copy (see the "leave Windows as-is" note on that module), but recording_with_output_v
// uses this - it used to hardcode "-c:v mpeg4" for every extension, which is flatly invalid for
// "webm" (can't hold an mpeg4 stream) and, worse, produced mp4/mov files with no moov atom (and
// so completely unopenable - the reported "blank black screen") whenever stop_recording's
// graceful shutdown didn't finish in time and had to force-kill ffmpeg, since plain mp4/mov only
// ever write the moov atom once at the very end.
pub(crate) fn codec_args_for_ext(ext: &str) -> Vec<String> {
    match ext.to_lowercase().as_str() {
        "mp4" => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "23".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-g".into(),
            KEYFRAME_INTERVAL.into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart+frag_keyframe+empty_moov".into(),
        ],
        "mkv" => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "23".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-g".into(),
            KEYFRAME_INTERVAL.into(),
            "-c:a".into(),
            "aac".into(),
            // Without this, ffmpeg's native aac encoder defaults to 128k - noticeably more
            // compressed than the 192k every other lossy-audio branch here already uses. Same
            // fix as the "mp4"/"mov"/"webm"/fallback branches, just closing this one gap.
            "-b:a".into(),
            "192k".into(),
            // Same live-capture interleaving stall the "avi" branch above documents - measured
            // 5.7 fps written into mkv against 59.5 into mp4 for the same capture.
            "-max_interleave_delta".into(),
            "0".into(),
        ],
        "avi" => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-g".into(),
            KEYFRAME_INTERVAL.into(),
            "-c:a".into(),
            "pcm_s16le".into(), // Better audio codec for AVI
            // AVI interleaves audio and video strictly, and with a *live* capture whose audio
            // arrives in bursts the muxer ends up holding video back waiting for audio to catch
            // up. Measured on a 4K desktop capture with a microphone: 4.7 fps written, against
            // 59.5 fps for the same capture into mp4. Relaxing the interleave constraint recovers
            // most of it (10.4 fps) - the muxer writes each packet when it has it instead of
            // stalling for its counterpart.
            //
            // It does not close the gap entirely: AVI caps out around 11-12 fps here even with no
            // audio at all, where mp4 sustains 60. AVI is simply a poor container for a live
            // high-resolution capture, which is why mp4 is the default (see defaultFileExt in
            // src/utils/appSettings.ts) - this only makes the explicit choice less punishing.
            "-max_interleave_delta".into(),
            "0".into(),
        ],
        "mov" => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "23".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-g".into(),
            KEYFRAME_INTERVAL.into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart+frag_keyframe+empty_moov".into(),
        ],
        "webm" => vec![
            // gdigrab/avfoundation/x11grab all capture the screen with an alpha channel
            // (BGRA/ARGB) even though a desktop capture never has meaningful transparency.
            // libvpx's VP8 encoder happens to support alpha (as yuva420p), and ffmpeg's default
            // format auto-negotiation prefers that alpha-preserving path when the source has
            // one - but that path fails to even initialize in this build ("Error while opening
            // encoder... Nothing was written into output file", reproduced 100% of the time
            // against this app's own bundled ffmpeg on a real 4K capture). Forcing plain
            // yuv420p (dropping the pointless alpha channel) avoids that path entirely and the
            // encoder opens fine - this was the actual root cause of ".webm recordings don't
            // play", not a browser/WebView2 codec-support issue: the files were never valid to
            // begin with.
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:v".into(),
            "libvpx".into(), // libvpx (not libvpx-vp9) for wider compatibility
            "-b:v".into(),
            "2M".into(),
            "-c:a".into(),
            "libvorbis".into(), // libvorbis (not libopus), same reasoning
            // Without this, libvorbis defaults to its ~112k quality-3 preset - same gap as the
            // unset aac bitrate above, just for the vorbis encoder.
            "-b:a".into(),
            "192k".into(),
            // realtime+cpu-used 5, not good+cpu-used 0 (libvpx's slowest, offline-quality
            // preset) - this is live screen capture, not a file conversion, and needs an encoder
            // that can actually keep up with the incoming framerate. See win.rs's identical fix
            // for the full reasoning (an encoder that can't keep up backs up, and gets force-
            // killed with a large unflushed backlog when the recording stops, corrupting the
            // WebM/Matroska container).
            "-quality".into(),
            "realtime".into(),
            "-cpu-used".into(),
            "5".into(),
        ],
        _ => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "23".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-g".into(),
            KEYFRAME_INTERVAL.into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart+frag_keyframe+empty_moov".into(),
        ],
    }
}

// Codec/bitrate flags for the audio-only record type's file extensions (mp3/wav/aac/wma - see
// BottomDocker.tsx's file-extension options when record_type is "a"). Same reasoning as
// codec_args_for_ext: recording_with_output_a used to set none of this at all, leaving it to
// ffmpeg's per-container default - which for mp3 measured out to the same 128k default this file
// keeps hitting elsewhere.
pub(crate) fn audio_codec_args_for_ext(ext: &str) -> Vec<String> {
    match ext.to_lowercase().as_str() {
        "mp3" => vec![
            "-c:a".into(),
            "libmp3lame".into(),
            "-b:a".into(),
            "192k".into(),
        ],
        "wav" => vec!["-c:a".into(), "pcm_s16le".into()], // uncompressed - no bitrate to set
        "wma" => vec!["-c:a".into(), "wmav2".into(), "-b:a".into(), "192k".into()],
        // "aac" and any unrecognized extension
        _ => vec!["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()],
    }
}


// Hides the console window a spawned child would otherwise flash open on Windows (a no-op
// everywhere else, since spawning a child process never pops up a console on macOS/Linux in the
// first place). Split out from silent_command below so callers that actually want to read
// stdout/stderr (take_screenshot's error reporting needs ffmpeg's real stderr, not /dev/null)
// aren't forced to accept silent_command's opinion of nulling both.
#[cfg(target_os = "windows")]
pub(crate) fn hide_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000);
}

// Runs ffmpeg with a hidden console window on Windows, stdin piped (every recording mode needs
// this open for the graceful 'q'-to-stop in stop_recording), stdout/stderr discarded — the right
// default for the long-running recording modes below, none of which read their own output.
pub fn silent_command<P: AsRef<OsStr>>(program: P) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    hide_console_window(&mut cmd);

    cmd
}

// Shared ffmpeg-process bookkeeping used by the macOS/Linux platform modules (Windows's own
// per-mode functions predate this and are left with their own inline spawn logic — see win.rs —
// so nothing about their existing, working behavior changes here). Every mode boils down to
// "record the output path, spawn ffmpeg with these args, record the child" — this is that,
// once, so each new platform's per-mode function only has to build its own `args`.
// (Unused, hence `allow(dead_code)`, on whichever platform isn't the one currently being
// compiled for — e.g. entirely unused in a Windows build, since win.rs doesn't call it.)
#[allow(dead_code)]
pub(crate) async fn spawn_recording(
    state: &State<'_, AppState>,
    output_path: &PathBuf,
    ffmpeg_path: &PathBuf,
    args: Vec<String>,
) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }

    log::debug!("FFmpeg args: {:?}", args);

    let mut cmd = silent_command(ffmpeg_path);
    cmd.args(&args);
    crate::services::orphan_guard::before_spawn(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    crate::services::orphan_guard::after_spawn(&child);

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }

    Ok(format!(
        "Recording started. File will be saved to {}",
        output_path.display()
    ))
}

// Device enumeration shells out to ffmpeg (`-list_devices` on Windows), which takes a second or
// more and can take far longer while a recording already holds the camera/mic. It used to run on
// the UI thread on every call - twice in a row from the device pickers - which was one of the
// main "Not responding" triggers. Now: probed on a blocking thread, cached briefly, with
// concurrent callers sharing one probe (the cache lock is held across it), and never re-probed
// while a recording is running if there's any answer to give already.
type DeviceLists = (Vec<String>, Vec<String>);

struct CachedDevices {
    probed_at: Instant,
    devices: DeviceLists,
}

static DEVICE_CACHE: std::sync::Mutex<Option<CachedDevices>> = std::sync::Mutex::new(None);
const DEVICE_CACHE_TTL: Duration = Duration::from_secs(15);

fn connected_devices_cached(app_handle: &AppHandle, recording: bool) -> DeviceLists {
    let mut cache = DEVICE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = cache.as_ref() {
        if recording || cached.probed_at.elapsed() < DEVICE_CACHE_TTL {
            return cached.devices.clone();
        }
    }
    let devices = platform::get_connected_devices(app_handle);
    *cache = Some(CachedDevices {
        probed_at: Instant::now(),
        devices: devices.clone(),
    });
    devices
}

fn recording_in_progress(app_handle: &AppHandle) -> bool {
    app_handle
        .try_state::<AppState>()
        .map(|state| {
            state
                .ffmpeg_process
                .try_lock()
                // Locked means a start/stop is mid-flight - treat as recording.
                .map(|process| process.is_some())
                .unwrap_or(true)
        })
        .unwrap_or(false)
}

/// Fills the device cache in the background at startup so the first picker opens instantly.
// Probes GPU screen capture (see gpu_capture.rs) so the first recording doesn't wait on it. Blocks
// for as long as the probes take - call from a background thread.
pub fn warm_screen_capture(_ffmpeg_path: &Path) {
    #[cfg(target_os = "windows")]
    gpu_capture::warm(_ffmpeg_path);
}

pub fn warm_device_cache(app_handle: &AppHandle) {
    let app_handle = app_handle.clone();
    std::thread::spawn(move || {
        connected_devices_cached(&app_handle, false);
    });
}

#[tauri::command]
pub async fn get_connected_devices(app_handle: AppHandle) -> DeviceLists {
    let recording = recording_in_progress(&app_handle);
    crate::services::responsiveness::blocking(move || {
        connected_devices_cached(&app_handle, recording)
    })
    .await
    .unwrap_or_else(|e| (vec![e.clone()], vec![e]))
}

#[tauri::command]
pub async fn get_connected_audios(app_handle: AppHandle) -> Vec<String> {
    get_connected_devices(app_handle).await.1
}

#[tauri::command]
pub async fn get_connected_cameras(app_handle: AppHandle) -> Vec<String> {
    get_connected_devices(app_handle).await.0
}

// Shared by resolve_output_path and resolve_recording_output_path below - both need "figure out
// where this file goes, creating the target folder and dodging an existing same-named file along
// the way", neither cares how the bytes that eventually land there get produced. Split out so
// each caller only has to say WHICH folder, not reimplement the naming/dodge logic.
fn resolve_output_path_in(target_dir: PathBuf, form_data: &FormData) -> Result<PathBuf, String> {
    let mut output_file: String;
    let current_date = Utc::now().format("%Y_%m%d_%H_%M_%S");

    output_file = format!(
        "{}_recording_{}.{}",
        form_data.record_type.to_uppercase(),
        current_date,
        form_data.file_ext
    );

    if !form_data.file_name.is_empty() {
        output_file = format!("{}.{}", form_data.file_name, form_data.file_ext);
    }

    let output_path: PathBuf = target_dir.join(&output_file);

    // Ensure the target directory exists, create it if it doesn't
    if !target_dir.exists() {
        if let Err(err) = fs::create_dir_all(&target_dir) {
            return Err(format!("Failed to create output directory: {}", err));
        }
    }

    // Check if the file exists
    if output_path.exists() {
        output_file = format!("Recording_{}.{}", current_date, form_data.file_ext);
        Ok(target_dir.join(&output_file))
    } else {
        Ok(output_path)
    }
}

// Used by take_screenshot - screenshots get their own "screenshots" subfolder, same reasoning
// (and same shared helper) as recordings getting "recordings" below.
fn resolve_screenshot_output_path(form_data: &FormData) -> Result<PathBuf, String> {
    resolve_output_path_in(
        crate::services::utility::briefcast_dir()?.join("screenshots"),
        form_data,
    )
}

// Used by start_recording - every actual audio/video recording (not screenshots) lands in its
// own "recordings" subfolder of the Briefcast directory instead of alongside screenshots and
// everything else Briefcast manages, so a folder of recordings stays a folder of recordings.
fn resolve_recording_output_path(form_data: &FormData) -> Result<PathBuf, String> {
    resolve_output_path_in(
        crate::services::utility::briefcast_dir()?.join("recordings"),
        form_data,
    )
}

#[tauri::command]
pub async fn start_recording(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    form_data: FormData,
) -> Result<String, String> {
    // Taken by value, so this local shadow is the only copy anything downstream will see - see
    // FormData::strip_phone_camera for why the sentinel must never reach an ffmpeg arg builder.
    let mut form_data = form_data;
    let uses_phone_camera = form_data.strip_phone_camera();

    // A second start (the hotkey and a button, say) used to replace the running ffmpeg in state
    // without stopping it - the first kept recording, unreachable by Stop, until the app exited.
    // A process that has already died on its own is just cleared.
    {
        let mut process = state.ffmpeg_process.lock().await;
        if let Some(child) = process.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return Err("A recording is already in progress - stop it before starting another.".to_string());
            }
            *process = None;
        }
    }

    // The phone is always recorded by the WebView into the `<stem>_webcam.mp4` sidecar, never by
    // ffmpeg (it isn't a capture device ffmpeg can open - see FormData::strip_phone_camera). That
    // works alongside any mode where ffmpeg still has a picture of its own to record: a screen for
    // the screen modes, or a computer camera for the camera-only ones.
    //
    // The single case that genuinely cannot work is a camera-only recording where the phone is the
    // ONLY camera selected: stripping the sentinel leaves ffmpeg with no video input at all, so
    // the main recording would have no picture. Everything else is now allowed.
    if uses_phone_camera
        && matches!(form_data.record_type.as_str(), "v" | "va")
        && form_data.video_devices.is_empty()
    {
        return Err(
            "The phone can't be the only camera for this recording type yet. Also tick a camera \
             attached to this computer, or pick a \"Screen…\" recording option - either way the \
             phone is recorded as its own layer you can position in the editor."
                .to_string(),
        );
    }

    // The phone claims the `<stem>_webcam.mp4` sidecar slot (save_phone_camera_capture writes
    // it), and win.rs's separate-webcam path writes to that exact same name. With the phone AND a
    // single real camera both selected, the strip above leaves video_devices.len() == 1, which is
    // precisely what that path's gate looks for - so without this, two writers would race for one
    // file. The phone wins and the real camera falls back to being baked in as an overlay, which
    // is also the more predictable reading of "I picked both".
    if uses_phone_camera {
        form_data.separate_webcam_capture = false;
    }

    log::debug!("Form data {:?}", form_data);
    #[cfg(target_os = "windows")]
    log::debug!(
        "Here are the opened windows {:?}",
        crate::commands::window_capture::win::get_all_open_windows_titles()
    );

    let output_path = resolve_recording_output_path(&form_data)?;

    // A new recording starting - any view-switch events left over from a previous one (there
    // shouldn't be, stop_recording already clears this, but a recording that failed to start
    // cleanly could in principle skip that) must not leak into this one's sidecar.
    state.view_switches.lock().await.clear();
    // Same reasoning as the view-switch log above: a previous recording that failed partway could
    // otherwise leave a phone-capture target behind for this one to append to.
    *state.phone_capture.lock().await = None;
    if let Ok(mut guard) = state.preview_frame.lock() {
        *guard = None;
    }

    {
        let has_audio = matches!(form_data.record_type.as_str(), "sva" | "sa" | "va" | "a");
        let assembled = cfg!(target_os = "windows")
            && matches!(form_data.record_type.as_str(), "sva" | "sa" | "s" | "va" | "v");
        *state.post_enhance.lock().await = has_audio && !assembled && form_data.enhance_audio;
    }

    // Cloned before the match below moves `state` into whichever platform::recording_with_output_*
    // arm actually runs - these are Arc<Mutex<..>> clones of the same shared AppState fields, so
    // this doesn't lose access to whatever that arm stores into them. Needed so the liveness check
    // after the match (see its own comment) and, on Windows, its early-failure cleanup can still
    // reach them.
    let ffmpeg_process = state.ffmpeg_process.clone();
    let output_path_state = state.output_path.clone();
    #[cfg(target_os = "windows")]
    let assembly_state = state.assembly.clone();
    #[cfg(target_os = "windows")]
    let click_capture = state.click_capture.clone();

    // Screen recordings are assembled at stop from separately captured parts, in exact sync - see
    // recording/assembly.rs. The audio captures start here, before ffmpeg, so they're already
    // running when the first frame arrives; anything before it is trimmed off at assembly.
    #[cfg(target_os = "windows")]
    {
        // Screen and camera recordings alike: the camera is timed against the same clock as the mic.
        let assembled_mode = matches!(form_data.record_type.as_str(), "sva" | "sa" | "s" | "va" | "v");
        let screen_mode = matches!(form_data.record_type.as_str(), "sva" | "sa" | "s");
        *state.assembly.lock().await = None;
        if assembled_mode {
            use crate::services::audio_capture::{self, AudioSource};
            let launch_hns = audio_capture::now_hns();
            let (video_path, mic_path, system_path) = assembly::intermediate_paths(&output_path);
            let wants_mic = matches!(form_data.record_type.as_str(), "sva" | "sa" | "va")
                && !form_data.audio_device.is_empty();
            let wants_system = form_data.include_system_audio && screen_mode;
            let mic_name = form_data.audio_device.clone();
            let (mic, system) = crate::services::responsiveness::blocking(move || {
                let mic = wants_mic.then(|| audio_capture::start(AudioSource::Microphone(mic_name), mic_path));
                let system = wants_system.then(|| audio_capture::start(AudioSource::SystemOutput, system_path));
                (mic, system)
            })
            .await?;
            let mic = match mic {
                Some(Ok(capture)) => Some(capture),
                Some(Err(e)) => {
                    warn!("Couldn't capture the microphone directly ({}), ffmpeg will record it instead", e);
                    None
                }
                None => None,
            };
            let system = match system {
                Some(Ok(capture)) => Some(capture),
                Some(Err(e)) => {
                    warn!("Failed to start system-audio capture, recording will proceed without it: {}", e);
                    None
                }
                None => None,
            };
            form_data.mic_external = mic.is_some();
            form_data.capture_path = Some(video_path.clone());
            *state.assembly.lock().await = Some(assembly::Assembly {
                video_path,
                timing: None,
                video_has_audio: wants_mic && mic.is_none(),
                mic,
                system,
                launch_hns,
                pauses: Vec::new(),
                timer_zero_hns: None,
                camera: None,
                enhance: form_data.enhance_audio,
            });
        }

        // Click tracking for the editor's own "auto zoom on click" feature - see
        // services/click_tracker.rs. Same "any screen-capturing mode" gate as system audio above,
        // and started here (rather than inside each platform::recording_with_output_* fn) so it
        // doesn't need duplicating across every one of them for a concern that has nothing to do
        // with which ffmpeg args a given mode builds.
        let wants_click_tracking = form_data.track_clicks
            && matches!(form_data.record_type.as_str(), "sva" | "sa" | "s");
        if wants_click_tracking {
            match capture_region_bounds(&resolve_capture_target(&app_handle, &form_data)) {
                Some((x, y, width, height)) => match crate::services::click_tracker::ClickCapture::start((x, y), (width, height)) {
                    Ok(capture) => *state.click_capture.lock().await = Some(capture),
                    Err(e) => warn!("Failed to start click tracking, recording will proceed without it: {}", e),
                },
                None => warn!("Failed to resolve the capture region's own bounds, recording will proceed without click tracking"),
            }
        }
    }

    // ffmpeg's Command::spawn() only fails if the executable itself can't launch - a bad device
    // name, a device already in use, a GPU session that won't open or a permission error all still
    // let spawn() succeed, then exit ffmpeg almost immediately with nothing written. So this waits
    // until ffmpeg reports output actually being produced (or dies) before returning: failures
    // surface here instead of at Stop, and the frontend's timer starts when capture really does.
    //
    // A recording that went through GPU capture and died at start gets one more attempt through
    // gdigrab, with GPU capture switched off for the session - a driver that won't cooperate
    // costs the user a second's delay, not a failed recording.
    let progress_path = crate::services::progress_watch::progress_sidecar_path(&output_path);
    let mut attempts = 0;
    let (output, early_exit_status) = loop {
        attempts += 1;
        #[cfg(target_os = "windows")]
        gpu_capture::USED_BY_LAST_START.store(false, std::sync::atomic::Ordering::SeqCst);
        // A previous attempt's progress file would read as this one having started already.
        let _ = fs::remove_file(&progress_path);

        let output = match dispatch_recording(&app_handle, state.clone(), &output_path, &form_data).await {
            Ok(output) => output,
            Err(e) => {
                #[cfg(target_os = "windows")]
                discard_start(&assembly_state, &click_capture).await;
                return Err(e);
            }
        };
        let exited = wait_for_capture_start(&ffmpeg_process, &progress_path).await;

        #[cfg(target_os = "windows")]
        if exited.is_some()
            && attempts == 1
            && gpu_capture::USED_BY_LAST_START.load(std::sync::atomic::Ordering::SeqCst)
        {
            gpu_capture::disable_for_session(&format!(
                "ffmpeg exited at start with {}",
                exited.unwrap()
            ));
            continue;
        }
        break (output, exited);
    };

    if let Some(status) = early_exit_status {
        *output_path_state.lock().await = None;
        #[cfg(target_os = "windows")]
        discard_start(&assembly_state, &click_capture).await;
        return Err(format!(
            "Recording failed to start (ffmpeg exited immediately with {}). The selected device may be in use by another app, or unavailable.",
            status
        ));
    }

    #[cfg(target_os = "windows")]
    if let Some(parts) = assembly_state.lock().await.as_mut() {
        parts.timer_zero_hns = Some(crate::services::audio_capture::now_hns());
    }

    *state.clock.lock().unwrap_or_else(|p| p.into_inner()) = Some(RecordingClock {
        record_type: form_data.record_type.clone(),
        started_at: now_ms(),
        pause_started_at: None,
        paused_accumulated_ms: 0,
    });

    Ok(output)
}

// Stops a screen recording's audio captures and assembles its final file at `output_path` (see
// recording/assembly.rs). Returns the timeline mapping, for placing the recording's sidecar events,
// and how far into the final file the frontend's own timer started.
//
// If the full assembly fails the picture is still saved without the captured audio, and the WAVs
// are left in the temp capture folder rather than deleted, so nothing recorded is lost.
#[cfg(target_os = "windows")]
async fn finish_assembly(
    app_handle: &AppHandle,
    parts: assembly::Assembly,
    output_path: &Path,
) -> Result<(assembly::Segments, f64), String> {
    use crate::services::audio_enhance as enhance;
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let rnnoise_model = crate::services::utility::get_rnnoise_model_path(app_handle)
        .ok()
        .filter(|p| p.exists())
        .map(|p| enhance::escape_filter_path(&p));
    let output_path = output_path.to_path_buf();
    crate::services::responsiveness::blocking(move || {
        let stop = |capture: Option<crate::services::audio_capture::AudioCapture>, what: &str| {
            capture.and_then(|c| match c.stop() {
                // Loopback with nothing played the whole time: no track at all, rather than an
                // empty one the mix can't read.
                Ok(timeline) if timeline.frames == 0 => {
                    let _ = fs::remove_file(&timeline.wav_path);
                    None
                }
                Ok(timeline) => Some(timeline),
                Err(e) => {
                    warn!("{} capture failed, the recording will be saved without it: {}", what, e);
                    None
                }
            })
        };
        let mut parts = parts;
        // The separately recorded webcam: finalized the same way the screen was.
        let mut camera = parts.camera.take();
        if let Some(process) = camera.as_mut().and_then(|c| c.process.take()) {
            let mut process = process;
            if let Some(stdin) = process.stdin.as_mut() {
                let _ = stdin.write_all(b"q");
                let _ = stdin.flush();
            }
            let path = camera.as_ref().map(|c| c.video_path.clone()).unwrap_or_default();
            if wait_for_ffmpeg_to_finalize(&mut process, &path) {
                warn!("The webcam recording was force-stopped; its end may be cut short");
            }
        }
        let mic = stop(parts.mic, "Microphone");
        let system = stop(parts.system, "System-audio");

        let timing = parts.timing.as_ref().map(|t| t.lock().unwrap_or_else(|p| p.into_inner()));
        let Some(segments) = timing.as_ref().and_then(|t| t.segments(&parts.pauses)) else {
            if let Some(t) = &timing {
                warn!("ffmpeg's last output:
{}", t.diagnostics());
            }
            return Err("Recording failed: no video frames were captured. The selected screen may be unavailable.".to_string());
        };
        drop(timing);
        let timer_lead = parts
            .timer_zero_hns
            .map(|z| (z - segments.start_hns()) as f64 / 1e7)
            .unwrap_or(0.0)
            .max(0.0);

        let run = |p: &assembly::Parts| -> Result<(), String> {
            let args = assembly::assemble_args(p, &output_path)?;
            log::debug!("Assembly args: {:?}", args);
            let mut cmd = Command::new(&ffmpeg_path);
            cmd.args(&args).stdin(Stdio::null());
            hide_console_window(&mut cmd);
            let out = cmd.output().map_err(|e| format!("Failed to run ffmpeg: {}", e))?;
            if out.status.success() {
                Ok(())
            } else {
                Err(extract_ffmpeg_error(&String::from_utf8_lossy(&out.stderr)))
            }
        };

        info!("Assembly timing: {:?}; mic {:?}; system {:?}", segments, mic, system);
        // Diagnostics: keep the parts for inspection instead of deleting them.
        let keep_parts = std::env::var_os("BRIEFCAST_KEEP_CAPTURE").is_some();

        // Enhancement pass 1 (services/audio_enhance.rs): the voice cleaned and measured, the
        // system audio measured - side by side, since they're independent.
        let with_voice = mic.is_some() || parts.video_has_audio;
        let raw_mic = mic.as_ref().map(|m| m.wav_path.clone());
        let enhance_audio = parts.enhance;
        let (mic, mic_gain_db, system_gain_db) = if !enhance_audio {
            (mic, 0.0, 0.0)
        } else { std::thread::scope(|scope| {
            let system_loudness = system.as_ref().map(|s| {
                let (ff, wav) = (&ffmpeg_path, s.wav_path.clone());
                scope.spawn(move || enhance::measure(ff, &wav, "0:a"))
            });
            let (mic, mic_gain) = match mic {
                Some(mut tl) => {
                    let clean = tl.wav_path.with_extension("clean.wav");
                    match enhance::clean_voice(&ffmpeg_path, &tl.wav_path, "0:a", &clean, rnnoise_model.as_deref()) {
                        Ok(loudness) => {
                            tl.wav_path = clean;
                            (Some(tl), enhance::gain_to(enhance::TARGET_LUFS, loudness))
                        }
                        Err(e) => {
                            warn!("Voice cleanup failed, using the microphone as recorded: {}", e);
                            (Some(tl), 0.0)
                        }
                    }
                }
                None => (None, 0.0),
            };
            let system_gain = system_loudness
                .and_then(|h| h.join().ok())
                .and_then(|r| r.ok())
                .map(|l| enhance::gain_to(enhance::system_target(with_voice), l))
                .unwrap_or(0.0);
            (mic, mic_gain, system_gain)
        }) };

        let full = assembly::Parts {
            video_path: parts.video_path.clone(),
            segments: segments.clone(),
            mic,
            system,
            video_has_audio: parts.video_has_audio,
            mic_gain_db,
            system_gain_db,
            rnnoise_model: rnnoise_model.clone(),
            enhance: enhance_audio,
        };
        let started = Instant::now();
        match run(&full) {
            Ok(()) if keep_parts => info!("Assembled {:?} in {:?}, parts kept", output_path, started.elapsed()),
            Ok(()) => {
                info!("Assembled {:?} in {:?}", output_path, started.elapsed());
                for wav in [&full.mic, &full.system].into_iter().flatten() {
                    let _ = fs::remove_file(&wav.wav_path);
                }
                if let Some(raw) = &raw_mic {
                    let _ = fs::remove_file(raw);
                }
            }
            Err(e) => {
                // One bad track shouldn't cost the others: the voice alone, then the picture alone.
                warn!("Assembling the recording failed ({}), retrying without system audio", e);
                let keep_wavs = [&full.mic, &full.system].into_iter().flatten().map(|t| t.wav_path.clone()).collect::<Vec<_>>();
                let voice_only = assembly::Parts { system: None, ..full };
                if let Err(e) = run(&voice_only) {
                    warn!("Still failing ({}), saving the picture alone - audio kept in {:?}", e, keep_wavs);
                    let picture_only = assembly::Parts { mic: None, video_has_audio: false, ..voice_only };
                    run(&picture_only).map_err(|e| format!("Recording failed: couldn't write the finished file: {}", e))?;
                }
            }
        }
        if let Some(camera) = camera {
            retime_webcam(&ffmpeg_path, &segments, &camera);
            if !keep_parts {
                let _ = fs::remove_file(&camera.video_path);
            }
        }
        if !keep_parts {
            let _ = fs::remove_file(&parts.video_path);
        }
        Ok((segments, timer_lead))
    })
    .await?
}

// Writes the separately recorded webcam's `<stem>_webcam.mp4`, re-timed onto the final recording
// (see assembly::webcam_args). A failure costs the PiP layer, never the recording.
#[cfg(target_os = "windows")]
fn retime_webcam(ffmpeg_path: &Path, segments: &assembly::Segments, camera: &assembly::CameraSidecar) {
    let offset = camera.timing.lock().unwrap_or_else(|p| p.into_inner()).offset_hns();
    let Some(offset) = offset else {
        warn!("The webcam recorded no frames, so there's no webcam layer for this recording");
        return;
    };
    let args = match assembly::webcam_args(segments, offset, &camera.video_path, &camera.final_path) {
        Ok(args) => args,
        Err(e) => return warn!("Couldn't build the webcam layer: {}", e),
    };
    info!("Webcam timing offset {}; re-timing with {:?}", offset, args);
    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    hide_console_window(&mut cmd);
    match cmd.output() {
        Ok(out) if out.status.success() => {}
        // A half-written sidecar has no moov atom and can't be opened - the editor would show a
        // broken PiP layer and the thumbnailer would retry it forever. No file is better.
        Ok(out) => {
            let _ = fs::remove_file(&camera.final_path);
            warn!("Couldn't write the webcam layer: {}", extract_ffmpeg_error(&String::from_utf8_lossy(&out.stderr)))
        }
        Err(e) => {
            let _ = fs::remove_file(&camera.final_path);
            warn!("Couldn't write the webcam layer: {}", e)
        }
    }
}

// Undoes a start that failed: stops the side captures and deletes the intermediates.
#[cfg(target_os = "windows")]
async fn discard_start(
    assembly_state: &Arc<Mutex<Option<assembly::Assembly>>>,
    click_capture: &Arc<Mutex<Option<crate::services::click_tracker::ClickCapture>>>,
) {
    if let Some(mut parts) = assembly_state.lock().await.take() {
        if let Some(mut camera) = parts.camera.take() {
            if let Some(mut process) = camera.process.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
            let _ = fs::remove_file(&camera.video_path);
        }
        let _ = crate::services::responsiveness::blocking(move || {
            for capture in [parts.mic, parts.system].into_iter().flatten() {
                if let Ok(timeline) = capture.stop() {
                    let _ = fs::remove_file(timeline.wav_path);
                }
            }
            let _ = fs::remove_file(parts.video_path);
        })
        .await;
    }
    if let Some(capture) = click_capture.lock().await.take() {
        let _ = capture.stop();
    }
}

async fn dispatch_recording(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    match form_data.record_type.as_str() {
        "sva" => platform::recording_with_output_sva(app_handle, state, output_path, form_data).await,
        "sa" => platform::recording_with_output_sa(app_handle, state, output_path, form_data).await,
        "va" => platform::recording_with_output_va(app_handle, state, output_path, form_data).await,
        "s" => platform::recording_with_output_s(app_handle, state, output_path, form_data).await,
        "v" => platform::recording_with_output_v(app_handle, state, output_path, form_data).await,
        "a" => platform::recording_with_output_a(app_handle, state, output_path, form_data).await,
        "c" => Err(
            "Screenshot capture doesn't go through start_recording — use take_screenshot instead"
                .to_string(),
        ),
        _ => Err("Invalid recording type".to_string()),
    }
}

// How long to wait for a started ffmpeg to report output before assuming it's fine anyway - long
// enough for the slowest legitimate start measured (a GPU session plus a dshow device, ~1s).
const CAPTURE_START_TIMEOUT: Duration = Duration::from_secs(4);

// Waits until the recording ffmpeg has produced output (per its -progress file) or has exited,
// returning the exit status in the latter case - and clearing it from state, so nothing later
// mistakes a dead process for a live recording.
async fn wait_for_capture_start(
    ffmpeg_process: &Arc<Mutex<Option<Child>>>,
    progress_path: &Path,
) -> Option<std::process::ExitStatus> {
    let started = Instant::now();
    loop {
        {
            let mut guard = ffmpeg_process.lock().await;
            if let Some(status) = guard.as_mut().and_then(|c| c.try_wait().ok().flatten()) {
                *guard = None;
                return Some(status);
            }
        }
        if started.elapsed() >= CAPTURE_START_TIMEOUT {
            warn!("ffmpeg hasn't reported output after {:?}, continuing anyway", CAPTURE_START_TIMEOUT);
            return None;
        }
        let path = progress_path.to_path_buf();
        let producing = crate::services::responsiveness::blocking(move || {
            std::thread::sleep(Duration::from_millis(50));
            progress_shows_output(&fs::read_to_string(&path).unwrap_or_default())
        })
        .await
        .unwrap_or(false);
        if producing {
            info!("Capture producing output after {:?}", started.elapsed());
            return None;
        }
    }
}

// Whether an ffmpeg -progress file shows any output yet: a frame encoded, or (for audio-only
// recordings, which never count frames) any output time.
fn progress_shows_output(contents: &str) -> bool {
    contents.lines().any(|line| {
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        matches!(key.trim(), "frame" | "out_time_us")
            && value.trim().parse::<i64>().map(|n| n > 0).unwrap_or(false)
    })
}

// A real instant screenshot: one ffmpeg invocation that grabs a single frame and exits on its
// own — unlike every recording mode above, there's no ongoing process to track in AppState and
// nothing for stop_recording to ever stop. This used to be record_type "c", spawned through the
// exact same start/stop recording lifecycle as a video (a running timer, a Stop button, a
// completion modal reporting "Duration: Unknown" for what was supposed to be a still image) —
// which also wrote a multi-frame gdigrab capture straight into a static .png path, producing a
// broken, ~0-byte file. This replaces that path entirely.
#[tauri::command]
pub async fn take_screenshot(app_handle: AppHandle, form_data: FormData) -> Result<String, String> {
    log::debug!("Screenshot form data {:?}", form_data);

    let output_path = resolve_screenshot_output_path(&form_data)?;
    let result = platform::take_screenshot(&app_handle, &output_path, &form_data).await;

    if result.is_ok() {
        if let Err(e) = app_handle.emit("refresh-file-list", ()) {
            warn!("Failed to emit refresh-file-list: {}", e);
        }
    }

    result
}

#[tauri::command]
pub async fn stop_recording(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    info!("Stop recording processing");

    let output_path = {
        let app_state = state.output_path.lock().await;
        match &*app_state {
            Some(path) => path.clone(),
            None => return Err("No recording in progress".to_string()),
        }
    };

    // A suspended process can't act on the graceful 'q' written to its stdin below - resume it
    // first (same as resume_recording would) so the shutdown below can actually finish cleanly
    // instead of timing out and force-killing, which for containers that only finalize on exit
    // (mp4/mov - see codec_args_for_ext's own note on this) means a corrupt, unplayable file.
    {
        let mut paused = state.paused.lock().await;
        if *paused {
            if let Some(process) = state.ffmpeg_process.lock().await.as_ref() {
                if let Err(e) = platform::resume_process(process.id()) {
                    warn!("Failed to resume paused recording before stopping: {}", e);
                }
            }
            #[cfg(target_os = "windows")]
            mark_pause(&state, false).await;
            *paused = false;
        }
    }

    // A recording being assembled at stop has ffmpeg writing its intermediate, not output_path.
    #[cfg(target_os = "windows")]
    let capture_path = state
        .assembly
        .lock()
        .await
        .as_ref()
        .map(|a| a.video_path.clone())
        .unwrap_or_else(|| output_path.clone());
    #[cfg(not(target_os = "windows"))]
    let capture_path = output_path.clone();

    // Try graceful shutdown first: send 'q' to ffmpeg's stdin (every platform's ffmpeg treats
    // this as "finalize the file and exit cleanly"), then poll off the async runtime's worker
    // threads instead of blocking them with a fixed sleep. `Child::kill()` is cross-platform on
    // its own (SIGKILL on Unix, TerminateProcess on Windows via Rust's std::process) — there used
    // to be a Windows-only `taskkill` fallback here too, which was both redundant (kill() already
    // ran) and the one piece of this function that wasn't portable.
    let mut process_state = state.ffmpeg_process.lock().await;
    let mut force_killed = false;
    if let Some(mut process) = process_state.take() {
        if let Some(stdin) = process.stdin.as_mut() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }

        let wait_path = capture_path.clone();
        force_killed = tauri::async_runtime::spawn_blocking(move || {
            wait_for_ffmpeg_to_finalize(&mut process, &wait_path)
        })
        .await
        .unwrap_or(false);
    }
    drop(process_state);

    // The path is now stale regardless of what happens below - clearing it here (rather than
    // only on the success path) stops a failed recording's path from lingering in state and
    // being mistaken for an in-progress one by anything that checks it later.
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = None;
    }
    *state.clock.lock().unwrap_or_else(|p| p.into_inner()) = None;

    info!("Recording stopped");

    // Drop the last preview frame now that there is nothing live to preview. The reader thread
    // has already ended with ffmpeg's stdout closing; this just stops the final frame lingering
    // into whatever recording comes next.
    if let Ok(mut guard) = state.preview_frame.lock() {
        *guard = None;
    }

    // Assemble a screen recording's final file from its parts (see recording/assembly.rs). Must
    // happen after ffmpeg has exited above - the video is stream-copied from its finished file.
    #[cfg(target_os = "windows")]
    let segments = {
        let parts = state.assembly.lock().await.take();
        match parts {
            Some(parts) => Some(finish_assembly(&app_handle, parts, &output_path).await?),
            None => None,
        }
    };

    // ffmpeg's Command::spawn() only fails if the executable itself can't launch - a bad
    // device name, a closed capture window, or a permission error all still let spawn()
    // succeed, then exit ffmpeg almost immediately with nothing ever written to output_path.
    // stdout/stderr are nulled (see recording_with_output_sva's comment on why), so that
    // failure is otherwise silent: the caller would get back an apparent success and the
    // completed-recording popup would open pointing at a file that was never created. Checking
    // for a real, non-empty file here is what turns that into a visible error instead.
    // A force-killed ffmpeg may have been interrupted mid-write. The file is usually still
    // playable (especially mp4, whose fragment flags bound the loss to the last fragment), so
    // this is a warning on an otherwise successful stop rather than an error - but it must not
    // pass silently, because the damage is at the end of the file where it is easy to miss.
    if force_killed {
        warn!("Recording was force-stopped; the end of {:?} may be truncated", output_path);
    }

    match fs::metadata(&output_path) {
        Ok(meta) if meta.len() > 0 => {}
        Ok(_) => {
            let _ = fs::remove_file(&output_path);
            return Err("Recording failed: no video/audio was captured, so the output file is empty. The selected screen, camera, or microphone may have become unavailable during recording.".to_string());
        }
        Err(_) => {
            return Err("Recording failed: no output file was created. The selected screen, camera, or microphone may be unavailable, or recording may have been stopped before it could start.".to_string());
        }
    }

    // Studio cleanup of the audio, for recordings that weren't assembled (which already got it).
    // A failure keeps the recording exactly as captured.
    if std::mem::take(&mut *state.post_enhance.lock().await) {
        let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
        let model = crate::services::utility::get_rnnoise_model_path(&app_handle)
            .ok()
            .filter(|p| p.exists())
            .map(|p| crate::services::audio_enhance::escape_filter_path(&p));
        let path = output_path.clone();
        let result = crate::services::responsiveness::blocking(move || {
            crate::services::audio_enhance::enhance_in_place(&ffmpeg_path, &path, model.as_deref())
        })
        .await;
        match result {
            Ok(Ok(())) => info!("Enhanced the audio of {:?}", output_path),
            Ok(Err(e)) | Err(e) => warn!("Audio enhancement skipped, keeping the recording as captured: {}", e),
        }
    }

    // Stop click tracking (if this recording had it running) and write whatever it collected to a
    // sidecar JSON next to the finished video - the editor's own "auto zoom on click" feature reads
    // this back (see detect_silence's own sidecar-free precedent; this one needs a file rather than
    // an on-demand Rust command since the clicks only ever existed during the recording itself,
    // nothing to re-derive from the finished video file afterward). Only written once the file's
    // already confirmed non-empty above, so a failed recording doesn't leave an orphaned sidecar
    // pointing at a video that was just deleted.
    #[cfg(target_os = "windows")]
    {
        let click_capture = state.click_capture.lock().await.take();
        if let Some(capture) = click_capture {
            let started_hns = capture.started_hns;
            let mut clicks = capture.stop();
            // Onto the final file's own timeline: clicks before the first frame or during a pause
            // have no picture to zoom into and are dropped.
            if let Some((segments, _)) = &segments {
                clicks = clicks
                    .into_iter()
                    .filter_map(|mut c| {
                        let hns = started_hns + (c.elapsed_secs * 1e7) as i64;
                        c.elapsed_secs = segments.output_time(hns)?;
                        Some(c)
                    })
                    .collect();
            }
            if !clicks.is_empty() {
                let clicks_path = click_sidecar_path(&output_path);
                match serde_json::to_string(&clicks) {
                    Ok(json) => {
                        if let Err(e) = fs::write(&clicks_path, json) {
                            warn!("Failed to write click-tracking sidecar: {}", e);
                        }
                    }
                    Err(e) => warn!("Failed to serialize click-tracking data: {}", e),
                }
            }
        }
    }

    // Same idea as the click-tracking sidecar just above, for this recording's own screen<->camera
    // view-switch timeline (see record_view_switch's own doc comment) - written once the file's
    // already confirmed non-empty above, then cleared either way so a future recording never
    // inherits stale switches from this one.
    {
        #[allow(unused_mut)]
        let mut switches = std::mem::take(&mut *state.view_switches.lock().await);
        // The frontend times these from when start_recording returned, a moment after the first
        // frame - the final file's t=0.
        #[cfg(target_os = "windows")]
        if let Some((_, timer_lead)) = &segments {
            for s in &mut switches {
                s.elapsed_secs = (s.elapsed_secs + timer_lead).max(0.0);
            }
        }
        if !switches.is_empty() {
            let switches_path = view_switch_sidecar_path(&output_path);
            match serde_json::to_string(&switches) {
                Ok(json) => {
                    if let Err(e) = fs::write(&switches_path, json) {
                        warn!("Failed to write view-switch sidecar: {}", e);
                    }
                }
                Err(e) => warn!("Failed to serialize view-switch data: {}", e),
            }
        }
    }

    let output_str = path_to_str(&output_path)?;

    if let Err(e) = app_handle.emit("refresh-file-list", ()) {
        warn!("Failed to emit refresh-file-list: {}", e);
    }

    // A cosmetic popup must not turn a successful recording into a failed stop. The file is
    // already written and verified by this point; reporting "Failed to stop recording" because a
    // window wouldn't open tells the user their recording is lost when it is sitting on disk.
    if let Err(e) = create_or_replace_rec_completed_modal(app_handle, output_str).await {
        warn!("Recording saved, but the completion popup could not be shown: {}", e);
    }

    Ok(output_str.to_string())
}

// Pauses the in-progress recording: suspends every thread of the ffmpeg process (see each
// platform module's suspend_process - Windows approximates POSIX's SIGSTOP by hand since it has
// no direct equivalent) so no frames are captured or encoded while paused. On Windows the audio
// captures keep running; the paused stretch shows up as a gap in the video's timeline and is cut
// from video and audio alike when the recording is assembled (see recording/assembly.rs).
// Marks a pause starting (`starting`) or ending in the recording being assembled, so assembly cuts
// exactly that stretch (see recording/assembly.rs).
#[cfg(target_os = "windows")]
async fn mark_pause(state: &State<'_, AppState>, starting: bool) {
    let now = crate::services::audio_capture::now_hns();
    if let Some(parts) = state.assembly.lock().await.as_mut() {
        if starting {
            parts.pauses.push((now, i64::MAX));
        } else if let Some(open) = parts.pauses.last_mut().filter(|p| p.1 == i64::MAX) {
            open.1 = now;
        }
        // A separately recorded webcam pauses with the screen.
        if let Some(pid) = parts.camera.as_ref().and_then(|c| c.process.as_ref()).map(|p| p.id()) {
            let result = if starting { platform::suspend_process(pid) } else { platform::resume_process(pid) };
            if let Err(e) = result {
                warn!("Failed to {} the webcam recording: {}", if starting { "pause" } else { "resume" }, e);
            }
        }
    }
}

#[tauri::command]
pub async fn pause_recording(state: State<'_, AppState>) -> Result<(), String> {
    let mut paused = state.paused.lock().await;
    if *paused {
        return Err("Recording is already paused".to_string());
    }

    let pid = {
        let process_state = state.ffmpeg_process.lock().await;
        process_state
            .as_ref()
            .map(|p| p.id())
            .ok_or_else(|| "No recording in progress".to_string())?
    };

    platform::suspend_process(pid)?;
    #[cfg(target_os = "windows")]
    mark_pause(&state, true).await;


    *paused = true;
    if let Some(clock) = state.clock.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        clock.pause_started_at = Some(now_ms());
    }
    info!("Recording paused");
    Ok(())
}

#[tauri::command]
pub async fn resume_recording(state: State<'_, AppState>) -> Result<(), String> {
    let mut paused = state.paused.lock().await;
    if !*paused {
        return Err("Recording is not paused".to_string());
    }

    let pid = {
        let process_state = state.ffmpeg_process.lock().await;
        process_state
            .as_ref()
            .map(|p| p.id())
            .ok_or_else(|| "No recording in progress".to_string())?
    };

    platform::resume_process(pid)?;
    #[cfg(target_os = "windows")]
    mark_pause(&state, false).await;


    *paused = false;
    if let Some(clock) = state.clock.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        if let Some(since) = clock.pause_started_at.take() {
            clock.paused_accumulated_ms += now_ms() - since;
        }
    }
    info!("Recording resumed");
    Ok(())
}

const REC_COMPLETED_LABEL: &str = "completed_recording";

// Building a WebView2 window always runs on the UI thread and takes one to two seconds - long
// enough that stopping a recording visibly froze the app while this popup was created (caught by
// services::responsiveness's watchdog). So the popup's window is built once, hidden, shortly
// after startup (prewarm_rec_completed_modal), and every stop just points it at the new file and
// shows it. Closing it hides it instead of destroying it, so it's ready for the next recording.
fn build_rec_completed_window(
    app_handle: &tauri::AppHandle,
    url: String,
    visible: bool,
) -> tauri::Result<tauri::WebviewWindow> {
    let window = tauri::WebviewWindowBuilder::new(
        app_handle,
        REC_COMPLETED_LABEL,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("Recording completed")
    .center()
    .resizable(false)
    .inner_size(420.0, 480.0)
    .always_on_top(true)
    .minimizable(false)
    .visible(visible)
    .build()?;

    let handle = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Only kept alive while the app itself is - once the main window is gone, a hidden
            // popup must not be what keeps the process running.
            if handle.app_handle().get_webview_window("main").is_some() {
                api.prevent_close();
                let _ = handle.hide();
            }
        }
    });
    Ok(window)
}

/// Builds the recording-completed popup hidden, in the background, once the app has settled.
pub fn prewarm_rec_completed_modal(app_handle: &tauri::AppHandle) {
    let app_handle = app_handle.clone();
    std::thread::spawn(move || {
        // Let the main window finish its own startup work first.
        std::thread::sleep(Duration::from_secs(4));
        if app_handle.get_webview_window(REC_COMPLETED_LABEL).is_none() {
            if let Err(e) =
                build_rec_completed_window(&app_handle, "completed_recording.html".into(), false)
            {
                warn!("Could not pre-create the recording-completed window: {}", e);
            }
        }
    });
}

async fn create_or_replace_rec_completed_modal(
    app_handle: tauri::AppHandle,
    file_path: &str,
) -> Result<String, String> {
    // The file path is baked into the window's own URL (rather than sent via an event) because
    // the page reads it synchronously on its first render - an event emitted before its listener
    // registers would be missed. Re-navigating the pre-built window reloads that page with the
    // new path, so the same mechanism works for both the reused and the freshly built window.
    // Root-relative: the entry HTML sits beside index.html (see vite.config.ts's rollup input for
    // why it can't live under src-tauri/), which is where both the dev server and the bundled
    // frontend serve it from.
    let encoded_path = urlencoding::encode(file_path).into_owned();
    let url = format!("completed_recording.html?path={}", encoded_path);

    // spawn_blocking, not done inline: show()/navigate()/build() all marshal onto the main thread
    // and wait for it, so they must never be called from it - running them on a real background
    // thread guarantees that.
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(window) = app_handle.get_webview_window(REC_COMPLETED_LABEL) {
            let mut target = window
                .url()
                .map_err(|e| format!("Failed to read popup URL: {}", e))?;
            target.set_path("/completed_recording.html");
            target.set_query(Some(&format!("path={}", encoded_path)));
            window
                .navigate(target)
                .map_err(|e| format!("Failed to load recording into popup: {}", e))?;
            let _ = window.center();
            window
                .show()
                .map_err(|e| format!("Failed to show popup: {}", e))?;
            let _ = window.set_focus();
            return Ok("Recording completed".to_string());
        }

        // Not pre-built yet (a recording stopped within seconds of launch) - build it now.
        build_rec_completed_window(&app_handle, url, true)
            .map(|_| "Recording completed".to_string())
            .map_err(|e| format!("Failed to create modal window: {}", e))
    })
    .await
    .map_err(|e| format!("Modal window creation task panicked: {}", e))?
}

#[cfg(test)]
mod overlay_style_tests {
    use super::*;

    #[test]
    #[ignore] // prints graphs for a manual ffmpeg render check
    fn print_overlay_graphs() {
        for shape in ["circle", "rounded", "square"] {
            let style = OverlayStyle { shape, position: "bottom_right", size: "large", border: "thick", border_color: "#ff3355" };
            println!("GRAPH {} {}", shape, build_camera_overlay_filter_complex_from(&style, 1, 1920, 1920, None, 1));
        }
    }

    #[test]
    fn bubbles_scale_with_the_frame() {
        assert_eq!(overlay_pixel_dimensions("circle", "medium", 1920), (346, 346));
        assert_eq!(overlay_pixel_dimensions("circle", "medium", 3840), (690, 690));
        assert_eq!(overlay_pixel_dimensions("square", "small", 1920), (268, 200));
        assert_eq!(border_px("none", 1920), 0);
        assert!(border_px("thick", 1920) > border_px("thin", 1920));
        assert_eq!(ffmpeg_color("#FF3355"), "0xFF3355");
        assert_eq!(ffmpeg_color("red; drop"), "white");
        assert!(overlay_position_expr("center", 0, 1, 300, 1920).ends_with("y=(H-h)/2"));
        assert!(overlay_position_expr("center_left", 0, 1, 300, 1920).starts_with("overlay=x=48+0"));
    }
}
