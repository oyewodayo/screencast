//recording.rs
//
// Cross-platform orchestrator: owns the shared state/types and the ffmpeg-agnostic pieces
// (overlay filter-graph construction, graceful stop, the completion-modal window), and dispatches
// the actual per-mode ffmpeg invocations to a platform module selected at compile time. Each
// platform module (win/macos/linux) implements the same set of `recording_with_output_*`
// functions plus `get_connected_devices`, using whatever ffmpeg input format that OS needs
// (dshow / avfoundation / x11grab+pulse+v4l2) — see each module for details.
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use chrono::Utc;
use tauri::AppHandle;
use std::sync::Arc;
use tauri::State;
use tauri::async_runtime::Mutex;
use tauri::Manager;
use std::fs;
use log::{info, warn};
use std::io::Write;
use std::ffi::OsStr;

use crate::services::utility::path_to_str;

#[cfg(target_os = "windows")]
mod win;
// pub(crate): window_capture::macos (a sibling module, not a descendant of this one) needs
// list_avfoundation_devices to enumerate "Capture screen N" devices for its own get_monitors -
// shared rather than duplicated so the ffmpeg-stderr-parsing logic only exists in one place.
#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "windows")]
use win as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "linux")]
use linux as platform;

#[derive(Default)]
pub struct AppState {
    output_path: Arc<Mutex<Option<PathBuf>>>,
    ffmpeg_process: Arc<Mutex<Option<Child>>>, // NEW: Store the process
}

#[derive(serde::Deserialize, Debug)]
pub struct FormData{
    file_name:String,
    file_ext:String,
    record_type:String,
    audio_device:String,
    video_device:String,
    screen_size:String,
    overlay_shape:String,
    overlay_position:String,
    overlay_size:String,
    // The title of the window screen_size names (as "window:<hwnd>") — the hwnd alone isn't
    // enough to actually *capture* that window on Windows (gdigrab targets windows by title, not
    // handle), so the frontend sends this alongside it. #[serde(default)] so a caller that
    // doesn't set it (screen_size isn't "window:...") doesn't need to send an empty string.
    #[serde(default)]
    window_title: String,
}

// What a "screen" capture should actually point ffmpeg at, resolved once from FormData.screen_size
// (and, for windows, window_title) so every capture mode — take_screenshot and every
// screen-capturing recording_with_output_* — interprets it the same way instead of each
// reimplementing (or, as before this existed, half-implementing) its own parsing of it.
pub(crate) enum CaptureTarget {
    FullScreen,
    Monitor { x: i32, y: i32, width: i32, height: i32 },
    Window { title: String },
}

// screen_size arrives as "fullscreen", "monitor:<id>", or "window:<hwnd>" (see
// EnhancedScreenOptions.tsx). The monitor case resolves `<id>` against get_monitors() for real
// geometry — previously this whole value was passed straight through as literal ffmpeg
// `-video_size` text, which is only ever a valid WxH string for the "fullscreen" case; for
// "monitor:monitor_0" or "window:66" it handed ffmpeg outright invalid syntax it could only
// reject. Falls back to FullScreen (rather than erroring the whole capture out) if a monitor id
// can't be resolved — a screen recording that captures more than intended beats one that
// silently doesn't start at all.
pub(crate) fn resolve_capture_target(app_handle: &AppHandle, form_data: &FormData) -> CaptureTarget {
    if let Some(monitor_id) = form_data.screen_size.strip_prefix("monitor:") {
        if let Ok(monitors) = crate::commands::window_capture::get_monitors(app_handle.clone()) {
            if let Some(m) = monitors.iter().find(|m| m.id == monitor_id) {
                return CaptureTarget::Monitor { x: m.x, y: m.y, width: m.width, height: m.height };
            }
        }
        return CaptureTarget::FullScreen;
    }

    if form_data.screen_size.starts_with("window:") && !form_data.window_title.is_empty() {
        return CaptureTarget::Window { title: form_data.window_title.clone() };
    }

    CaptureTarget::FullScreen
}

// ffmpeg's stderr always leads with its multi-hundred-character build banner (version, compile
// flags, bundled library list) before it ever gets to the actual failure, so dumping the whole
// thing as the error - as every take_screenshot used to - buries the one line anyone can act on
// under noise the UI can't even fully display. The real reason is reliably among the last few
// non-empty lines.
pub(crate) fn extract_ffmpeg_error(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return "ffmpeg exited with an error and produced no output".to_string();
    }
    let tail_len = lines.len().min(5);
    lines[lines.len() - tail_len..].join(" | ")
}

pub fn map_overlay_size(size: &str) -> String {
    match size {
        "small" => "320x240".to_string(),
        "medium" => "640x480".to_string(),
        _ => size.to_string(),
    }
}

// Shared by every platform's overlay compositing (a webcam bubble drawn over the screen
// capture) — only the *inputs* feeding this filter graph differ per OS (dshow/avfoundation/v4l2
// device syntax), the graph itself is plain ffmpeg filter syntax and has no OS dependency.
pub fn get_overlay_position(position: String) -> String {
    match position.as_str() {
        "bottom_left" => "overlay=x=100:y=H-h-50".to_string(),
        "bottom_middle" => "overlay=x=(W-w)/2:y=H-h-50".to_string(),
        "bottom_right" => "overlay=x=W-w-100:y=H-h-50".to_string(),
        _ => "overlay=x=W-w-100:y=H-h-50".to_string(),
    }
}

pub fn get_overlay_shape(shape: &str, overlay_filter: String) -> String {
    match shape {
        "circle" => format!(
            "[1:v]scale=w='min(iw,ih)':h='min(iw,ih)', \
            geq=lum_expr='if(gt((X-W/2)^2+(Y-H/2)^2,(W/2)^2),0,255)', \
            format=yuva420p[alpha]; \
            [1:v]scale=w='min(iw,ih)':h='min(iw,ih)'[video]; \
            [video][alpha]alphamerge[overlay]; \
            [0:v][overlay]{}",
            overlay_filter
        ),
        "rounded" => format!(
            "[1:v]scale=w='min(iw,ih)':h='min(iw,ih)', \
            geq=lum_expr='if(gte(X,{r})*gte(Y,{r})*gte(W-{r}-X,0)*gte(H-{r}-Y,0),255,0)', \
            format=yuva420p[alpha]; \
            [1:v]scale=w='min(iw,ih)':h='min(iw,ih)'[video]; \
            [video][alpha]alphamerge[overlay]; \
            [0:v][overlay]{}",
            overlay_filter,
            r = 20
        ),
        _ => format!("[0:v][1:v]{}", overlay_filter),
    }
}

// Output codec flags per container extension. win.rs's sva mode predates this and keeps its own
// inline copy (see the "leave Windows as-is" note on that module) — this exists so macOS/Linux,
// which are new code with no existing behavior to preserve, share one copy of it between them
// instead of duplicating the same match a second and third time.
#[allow(dead_code)]
pub(crate) fn codec_args_for_ext(ext: &str) -> Vec<String> {
    match ext.to_lowercase().as_str() {
        "mp4" => vec![
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "ultrafast".into(),
            "-crf".into(), "23".into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "192k".into(),
            "-movflags".into(), "+faststart+frag_keyframe+empty_moov".into(),
        ],
        "mkv" => vec![
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "ultrafast".into(),
            "-crf".into(), "23".into(),
            "-c:a".into(), "aac".into(),
        ],
        "avi" => vec![
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "ultrafast".into(),
            "-c:a".into(), "pcm_s16le".into(), // Better audio codec for AVI
        ],
        "mov" => vec![
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "ultrafast".into(),
            "-c:a".into(), "aac".into(),
            "-movflags".into(), "+faststart+frag_keyframe+empty_moov".into(),
        ],
        "webm" => vec![
            "-c:v".into(), "libvpx".into(), // libvpx (not libvpx-vp9) for wider compatibility
            "-b:v".into(), "2M".into(),
            "-c:a".into(), "libvorbis".into(), // libvorbis (not libopus), same reasoning
            // realtime+cpu-used 5, not good+cpu-used 0 (libvpx's slowest, offline-quality
            // preset) - this is live screen capture, not a file conversion, and needs an encoder
            // that can actually keep up with the incoming framerate. See win.rs's identical fix
            // for the full reasoning (an encoder that can't keep up backs up, and gets force-
            // killed with a large unflushed backlog when the recording stops, corrupting the
            // WebM/Matroska container).
            "-quality".into(), "realtime".into(),
            "-cpu-used".into(), "5".into(),
        ],
        _ => vec![
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "ultrafast".into(),
            "-c:a".into(), "aac".into(),
            "-movflags".into(), "+faststart+frag_keyframe+empty_moov".into(),
        ],
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

    let child = silent_command(ffmpeg_path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }

    Ok(format!("Recording started. File will be saved to {}", output_path.display()))
}

#[tauri::command]
pub fn get_connected_devices(app_handle: AppHandle) -> (Vec<String>, Vec<String>) {
    platform::get_connected_devices(&app_handle)
}

#[tauri::command]
pub fn get_connected_audios(app_handle: AppHandle)->Vec<String>{
    get_connected_devices(app_handle).1
}

#[tauri::command]
pub fn get_connected_cameras(app_handle: AppHandle)->Vec<String>{
    get_connected_devices(app_handle).0
}

// Shared by start_recording and take_screenshot — both need "figure out where this file goes,
// creating the Briefcast folder and dodging an existing same-named file along the way", neither
// cares how the bytes that eventually land there get produced.
fn resolve_output_path(form_data: &FormData) -> Result<PathBuf, String> {
    let mut output_file: String;
    let current_date = Utc::now().format("%Y_%m%d_%H_%M_%S");

    let briefcast_dir = crate::services::utility::briefcast_dir()?;

    output_file = format!("{}_recording_{}.{}", form_data.record_type.to_uppercase(), current_date, form_data.file_ext);

    if !form_data.file_name.is_empty() {
        output_file = format!("{}.{}", form_data.file_name, form_data.file_ext);
    }

    let output_path: PathBuf = briefcast_dir.join(&output_file);

    // Ensure the Briefcast directory exists, create it if it doesn't
    if !briefcast_dir.exists() {
        if let Err(err) = fs::create_dir_all(&briefcast_dir) {
            return Err(format!("Failed to create Briefcast directory: {}", err));
        }
    }

    // Check if the file exists
    if output_path.exists() {
        output_file = format!("Recording_{}.{}", current_date, form_data.file_ext);
        Ok(briefcast_dir.join(&output_file))
    } else {
        Ok(output_path)
    }
}

#[tauri::command]
pub async fn start_recording(app_handle: AppHandle,state:State<'_,AppState>,  form_data: FormData) -> Result<String, String> {
    log::debug!("Form data {:?}",form_data);
    #[cfg(target_os = "windows")]
    log::debug!("Here are the opened windows {:?}", crate::commands::window_capture::win::get_all_open_windows_titles());

    let output_path = resolve_output_path(&form_data)?;

    match form_data.record_type.as_str() {
        "sva" => platform::recording_with_output_sva(&app_handle, state, &output_path, &form_data).await,
        "sv" => platform::recording_with_output_sv(&app_handle, state, &output_path, &form_data).await,
        "sa" => platform::recording_with_output_sa(&app_handle, state, &output_path, &form_data).await,
        "va" => platform::recording_with_output_va(&app_handle, state, &output_path, &form_data).await,
        "s" => platform::recording_with_output_s(&app_handle, state, &output_path, &form_data).await,
        "v" => platform::recording_with_output_v(&app_handle, state, &output_path, &form_data).await,
        "a" => platform::recording_with_output_a(&app_handle, state, &output_path, &form_data).await,
        "c" => Err("Screenshot capture doesn't go through start_recording — use take_screenshot instead".to_string()),
        _ => Err("Invalid recording type".to_string()),
    }
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

    let output_path = resolve_output_path(&form_data)?;
    let result = platform::take_screenshot(&app_handle, &output_path, &form_data).await;

    if result.is_ok() {
        if let Err(e) = app_handle.emit_all("refresh-file-list", ()) {
            warn!("Failed to emit refresh-file-list: {}", e);
        }
    }

    result
}

#[tauri::command]
pub async fn stop_recording(app_handle: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    info!("Stop recording processing");

    let output_path = {
        let app_state = state.output_path.lock().await;
        match &*app_state {
            Some(path) => path.clone(),
            None => return Err("No recording in progress".to_string())
        }
    };

    // Try graceful shutdown first: send 'q' to ffmpeg's stdin (every platform's ffmpeg treats
    // this as "finalize the file and exit cleanly"), then poll off the async runtime's worker
    // threads instead of blocking them with a fixed sleep. `Child::kill()` is cross-platform on
    // its own (SIGKILL on Unix, TerminateProcess on Windows via Rust's std::process) — there used
    // to be a Windows-only `taskkill` fallback here too, which was both redundant (kill() already
    // ran) and the one piece of this function that wasn't portable.
    let mut process_state = state.ffmpeg_process.lock().await;
    if let Some(mut process) = process_state.take() {
        if let Some(stdin) = process.stdin.as_mut() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }

        let _ = tauri::async_runtime::spawn_blocking(move || {
            for _ in 0..20 {
                match process.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                    Err(_) => return,
                }
            }
            warn!("Graceful ffmpeg shutdown timed out, force-killing");
            let _ = process.kill();
        })
        .await;
    }
    drop(process_state);

    info!("Recording stopped");

    let output_str = path_to_str(&output_path)?;

    if let Err(e) = app_handle.emit_all("refresh-file-list", ()) {
        warn!("Failed to emit refresh-file-list: {}", e);
    }

    if let Err(e) = create_or_replace_rec_completed_modal(app_handle, output_str).await {
        return Err(format!("Failed to show completion modal: {}", e));
    }

    Ok(output_str.to_string())
}

async fn create_or_replace_rec_completed_modal(app_handle: tauri::AppHandle, file_path: &str) -> Result<String, String> {
    if let Some(modal_window) = app_handle.get_window("completed_recording") {
        if let Err(e) = modal_window.close() {
            return Err(format!("Failed to close existing modal window: {}", e));
        }
    }

    // The file path is baked into the window's own URL (rather than sent via a
    // 'display-file-modal' event emitted from here) because emit_all only reaches windows that
    // already exist at the moment it's called - this window doesn't exist yet until `build()`
    // below returns, and even then its webview/JS hasn't loaded far enough to have registered
    // a listener. An event fired here would always be missed. A URL query param has no such
    // race: the page reads it on its very first render.
    let url = format!(
        "src-tauri/src/views/completed_recording.html?path={}",
        urlencoding::encode(file_path)
    );
    let result = tauri::WindowBuilder::new(
        &app_handle,
        "completed_recording",
        tauri::WindowUrl::App(url.into()),
    )
    .title("Recording completed")
    .center()
    .resizable(false)
    .inner_size(420.0, 480.0)
    .always_on_top(true)
    .minimizable(false)
    .build();

    match result {
        Ok(_) => Ok("Recording completed".to_string()),
        Err(e) => Err(format!("Failed to create modal window: {}", e)),
    }
}
