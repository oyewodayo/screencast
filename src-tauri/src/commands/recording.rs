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
use std::env;
use log::{info, warn};
use std::io::Write;
use std::ffi::OsStr;

use crate::services::utility::path_to_str;

#[cfg(target_os = "windows")]
mod win;
#[cfg(target_os = "macos")]
mod macos;
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
            "-quality".into(), "good".into(),
            "-cpu-used".into(), "0".into(),
        ],
        _ => vec![
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "ultrafast".into(),
            "-c:a".into(), "aac".into(),
            "-movflags".into(), "+faststart+frag_keyframe+empty_moov".into(),
        ],
    }
}

// Runs ffmpeg with a hidden console window on Windows (a no-op everywhere else, since spawning
// a child process never pops up a console on macOS/Linux in the first place).
pub fn silent_command<P: AsRef<OsStr>>(program: P) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // hide console window
    }

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

// Windows/Linux both conventionally keep recordings under ~/Videos; macOS uses ~/Movies instead.
fn videos_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let home = env::var("USERPROFILE");
    #[cfg(not(target_os = "windows"))]
    let home = env::var("HOME");

    let mut path = PathBuf::from(home.map_err(|_| "Failed to get user's home directory".to_string())?);

    #[cfg(target_os = "macos")]
    path.push("Movies");
    #[cfg(not(target_os = "macos"))]
    path.push("Videos");

    Ok(path)
}

#[tauri::command]
pub async fn start_recording(app_handle: AppHandle,state:State<'_,AppState>,  form_data: FormData) -> Result<String, String> {
    let mut output_file: String;

    let current_date = Utc::now().format("%Y_%m%d_%H_%M_%S");

    let home_dir = videos_dir()?;

    log::debug!("Form data {:?}",form_data);
    #[cfg(target_os = "windows")]
    log::debug!("Here are the opened windows {:?}", crate::commands::window_capture::win::get_all_open_windows_titles());

    // Append the Briefcast directory to the user's Videos (or Movies, on macOS) directory
    let mut briefcast_dir = home_dir.clone();
    briefcast_dir.push("Briefcast");

    output_file = format!("{}_recording_{}.{}",form_data.record_type.to_uppercase(), current_date, form_data.file_ext);

    if !form_data.file_name.is_empty() {
        output_file = format!("{}.{}", form_data.file_name, form_data.file_ext);
    }

    let output_path:PathBuf = briefcast_dir.join(&output_file);

    // Ensure the Briefcast directory exists, create it if it doesn't
    if !briefcast_dir.exists() {
        if let Err(err) = fs::create_dir_all(&briefcast_dir) {
            return Err(format!("Failed to create Briefcast directory: {}", err));
        }
    }

    // Check if the file exists
    let output_path = if output_path.exists() {
        output_file = format!("Recording_{}.{}", current_date, form_data.file_ext);
        briefcast_dir.join(&output_file)
    } else {
        output_path
    };

    match form_data.record_type.as_str() {
        "sva" => platform::recording_with_output_sva(&app_handle, state, &output_path, &form_data).await,
        "sv" => platform::recording_with_output_sv(&app_handle, state, &output_path, &form_data).await,
        "sa" => platform::recording_with_output_sa(&app_handle, state, &output_path, &form_data).await,
        "va" => platform::recording_with_output_va(&app_handle, state, &output_path, &form_data).await,
        "s" => platform::recording_with_output_s(&app_handle, state, &output_path, &form_data).await,
        "v" => platform::recording_with_output_v(&app_handle, state, &output_path, &form_data).await,
        "c" => platform::recording_with_output_c(&app_handle, state, &output_path, &form_data).await,
        "a" => platform::recording_with_output_a(&app_handle, state, &output_path, &form_data).await,
        _ => Err("Invalid recording type".to_string()),
    }
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
