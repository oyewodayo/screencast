use std::ffi::OsStr;
//recording.rs
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use chrono::Utc;
use tauri::AppHandle;
use tauri::regex::Regex;
use std::sync::Arc;
use tauri::State;
use tauri::async_runtime::Mutex;
use tauri::Manager;
use std::fs;
use std::env;
use chrono;
use log::{info, warn};
use std::io::Write;

use crate::commands::windows_api;
use crate::services::utility::{path_to_str, get_ffmpeg_path};
use std::os::windows::process::CommandExt;

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

#[tauri::command]
pub fn get_connected_devices(app_handle: AppHandle) -> (Vec<String>, Vec<String>) {
    let ffmpeg_path = match get_ffmpeg_path(&app_handle) {
        Ok(path) => path,
        Err(e) => {
            return (
                vec![e.clone()],
                vec![e],
            );
        }
    };

    let output = match Command::new(&ffmpeg_path)
        .args([
            "-list_devices", "true",
            "-f", "dshow",
            "-i", "dummy"
        ])
        .output()
    {
        Ok(output) => output,
        Err(e) => {
            return (
                vec![format!("Failed to execute command: {}", e)],
                vec![format!("Failed to execute command: {}", e)],
            );
        }
    };

    let stderr = String::from_utf8_lossy(&output.stderr);

    // Debug print the full stderr to see its content
    log::debug!("FFmpeg Stderr: {}", stderr);

    // Extract video and audio device names from stderr
    let video_pattern = Regex::new(r#"\[dshow @ [0-9a-fA-Fx]+\] "(.*?)" \(video\)"#).unwrap();
    let audio_pattern = Regex::new(r#"\[dshow @ [0-9a-fA-Fx]+\] "(.*?)" \(audio\)"#).unwrap();

    let video_devices: Vec<String> = video_pattern
        .captures_iter(&stderr)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .collect();

    let audio_devices: Vec<String> = audio_pattern
        .captures_iter(&stderr)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .collect();

    log::debug!("Parsed Video Devices: {:?}", video_devices);
    log::debug!("Parsed Audio Devices: {:?}", audio_devices);

    (video_devices, audio_devices)
}

#[tauri::command]
pub fn get_connected_audios(app_handle: AppHandle)->Vec<String>{
    
    get_connected_devices(app_handle).1
}

#[tauri::command]
pub fn get_connected_cameras(app_handle: AppHandle)->Vec<String>{
    
    get_connected_devices(app_handle).0
}


pub fn silent_command<P:AsRef<OsStr>>(program: P) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // hide console window
    }

    cmd
}

pub fn add_overlay_args(args: &mut Vec<String>, form_data: &FormData) {
    let overlay_size = map_overlay_size(&form_data.overlay_size);
    let video_audio_input = format!("video={}:audio={}", form_data.video_device, form_data.audio_device);
    
    args.extend(vec![
        "-f".to_string(), "dshow".to_string(),
        "-video_size".to_string(), overlay_size, "-i".to_string(), video_audio_input]);
    let overlay_filter = get_overlay_position(form_data.overlay_position.to_string());
    let filter_complex = get_overlay_shape(&form_data.overlay_shape, overlay_filter);

    args.extend(vec!["-filter_complex".to_string(), filter_complex]);
}

fn get_overlay_position(position: String) -> String {
    match position.as_str() {
        "bottom_left" => "overlay=x=100:y=H-h-50".to_string(),
        "bottom_middle" => "overlay=x=(W-w)/2:y=H-h-50".to_string(),
        "bottom_right" => "overlay=x=W-w-100:y=H-h-50".to_string(),
        _ => "overlay=x=W-w-100:y=H-h-50".to_string(),
    }
}

fn get_overlay_shape(shape: &str, overlay_filter: String) -> String {
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

#[tauri::command]
pub async fn start_recording(app_handle: AppHandle,state:State<'_,AppState>,  form_data: FormData) -> Result<String, String> {
    let mut output_file: String;
    
    let current_date = Utc::now().format("%Y_%m%d_%H_%M_%S");
    
    // Get the user's home directory
    let home_dir = match env::var("USERPROFILE") {
        Ok(profile_dir) => {
            let mut path_buf = PathBuf::from(profile_dir);
            path_buf.push("Videos");
            path_buf
        },
        Err(_) => return Err("Failed to get user's home directory".to_string()),
    };

    log::debug!("Form data {:?}",form_data);
    log::debug!("Here are the opened windows {:?}",windows_api::get_all_open_windows_titles());
    
    // Append the Briefcast directory to the user's Videos directory
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
        "sva" => recording_with_output_sva(&app_handle, state, &output_path, &form_data).await,
        "sv" => recording_with_output_sv(&app_handle, state, &output_path, &form_data).await,
        "sa" => recording_with_output_sa(&app_handle, state, &output_path, &form_data).await,
        "va" => recording_with_output_va(&app_handle, state, &output_path, &form_data).await,
        "s" => recording_with_output_s(&app_handle, state, &output_path, &form_data).await,
        "v" => recording_with_output_v(&app_handle, state, &output_path, &form_data).await,
        "c" => recording_with_output_c(&app_handle, state, &output_path, &form_data).await,
        "a" => recording_with_output_a(&app_handle, state, &output_path, &form_data).await,
        _ => Err("Invalid recording type".to_string()),
    }
}

//Screen video and audio
pub async fn recording_with_output_sva(
    app_handle: &AppHandle, 
    state: State<'_, AppState>, 
    output_path: &PathBuf, 
    form_data: &FormData
) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }
    
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    let mut args: Vec<String> = vec![
        "-f".to_string(), "gdigrab".to_string(),
        "-framerate".to_string(), "60".to_string(),    
    ];

    if form_data.screen_size != "fullscreen" {
        args.extend(vec!["-video_size".to_string(), form_data.screen_size.to_string()]);
    }

    args.extend(vec!["-i".to_string(), "desktop".to_string()]);
    
    if !form_data.overlay_shape.is_empty() {
        log::debug!("overlay is present");
        add_overlay_args(&mut args, form_data);
    } else {
        let mut audio_input = String::from("audio=");
        audio_input.push_str(&form_data.audio_device);
        args.push("-f".to_string());
        args.push("dshow".to_string());
        args.push("-i".to_string());
        args.push(audio_input);
    }

    // Add codec flags based on file extension
    match form_data.file_ext.to_lowercase().as_str() {
        "mp4" => {
            args.extend(vec![
                "-c:v".to_string(), "libx264".to_string(),
                "-preset".to_string(), "ultrafast".to_string(),
                "-crf".to_string(), "23".to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-b:a".to_string(), "192k".to_string(),
                "-movflags".to_string(), "+faststart+frag_keyframe+empty_moov".to_string(),
            ]);
        },
        "mkv" => {
            args.extend(vec![
                "-c:v".to_string(), "libx264".to_string(),
                "-preset".to_string(), "ultrafast".to_string(),
                "-crf".to_string(), "23".to_string(),
                "-c:a".to_string(), "aac".to_string(),
            ]);
        },
        "avi" => {
            args.extend(vec![
                "-c:v".to_string(), "libx264".to_string(),
                "-preset".to_string(), "ultrafast".to_string(),
                "-c:a".to_string(), "pcm_s16le".to_string(), // Better audio codec for AVI
            ]);
        },
        "mov" => {
            args.extend(vec![
                "-c:v".to_string(), "libx264".to_string(),
                "-preset".to_string(), "ultrafast".to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-movflags".to_string(), "+faststart+frag_keyframe+empty_moov".to_string(),
            ]);
        },
        "webm" => {
            args.extend(vec![
                "-c:v".to_string(), "libvpx".to_string(), // Use libvpx instead of libvpx-vp9 for better compatibility
                "-b:v".to_string(), "2M".to_string(),
                "-c:a".to_string(), "libvorbis".to_string(), // Use libvorbis instead of libopus
                "-quality".to_string(), "good".to_string(),
                "-cpu-used".to_string(), "0".to_string(),
            ]);
        },
        _ => {
            // Default to mp4
            args.extend(vec![
                "-c:v".to_string(), "libx264".to_string(),
                "-preset".to_string(), "ultrafast".to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-movflags".to_string(), "+faststart+frag_keyframe+empty_moov".to_string(),
            ]);
        }
    }

    let output_file = path_to_str(output_path)?.to_string();

    log::debug!("Output file: {}", output_file);

    // Add output file
    args.push(output_file.clone());

    log::debug!("FFmpeg args: {:?}", args);

    // IMPORTANT: Keep stdin open for graceful shutdown
    let child = Command::new(&ffmpeg_path)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped()) // Changed to piped to capture output for debugging
        .stderr(Stdio::piped()) // Changed to piped to capture errors
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    // Store the process in state
    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }

    log::debug!("FFmpeg process started successfully");

    Ok(format!("Recording started. File will be saved as:\n{}", output_path.display()))
}
//Screen and video without audio
pub async fn recording_with_output_sv(app_handle: &AppHandle, state: State<'_, AppState>, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
    
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    let mut args: Vec<String> = vec![
        "-f".to_string(), "dshow".to_string(),
        "-framerate".to_string(), "60".to_string(),    
    ];
    if form_data.screen_size != "fullscreen" {
        args.extend(vec!["-video_size".to_string(), form_data.screen_size.to_string()]);
    }

    args.extend(vec![
        "-i".to_string(), "desktop".to_string()
        ]);
    
    if !form_data.overlay_shape.is_empty() {
        log::debug!("overlay is present");
        add_overlay_args(&mut args, form_data);
    } 

    // Output command
    args.extend(vec![
        "-filter_complex".to_string(), "[0:v][1:v]overlay=x=W-w-100:y=H-h-50".to_string(),
        "-c:v".to_string(), "mpeg4".to_string(),
        "-segment_time".to_string(), "10".to_string(),
        "-segment_format".to_string(), "avi".to_string(),
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ]);

    let child = silent_command(&ffmpeg_path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }

    Ok(format!("Recording started. File will be saved to {}", output_path.display()))
}

//Screen and audio
pub async fn recording_with_output_sa(app_handle: &AppHandle, state: State<'_, AppState>, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }

    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    log::debug!("Path {:?}", output_path);
    let child = silent_command(&ffmpeg_path)
        .args([
            "-f", "gdigrab",
            "-framerate", "200",
            "-i", "desktop",
            "-f", "dshow",
            "-video_size", "320x240",
            "-i", &format!("audio={}", form_data.audio_device),
            "-y",
            path_to_str(output_path)?,
        ])
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }

    Ok(format!("Recording started. File will be saved to {}", output_path.display()))
}

//Video only
pub async fn recording_with_output_v(app_handle: &AppHandle, state: State<'_, AppState>, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    log::debug!("Path {:?}", output_path);
    let child = Command::new(&ffmpeg_path)
        .args([
            "-f", "dshow",
            "-i", &format!("video={}", form_data.video_device),
            "-c:v", "mpeg4",
            "-y",
            path_to_str(output_path)?,
        ])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }

    Ok(format!("Recording started. File will be saved to {:?}", output_path.file_name()))
}

//Audio only
pub async fn recording_with_output_a(app_handle: &AppHandle, state: State<'_, AppState>, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    log::debug!("Path {:?}", output_path);
    let child = silent_command(&ffmpeg_path)
        .args([
            "-f", "dshow",
            "-i", &format!("audio={}", form_data.audio_device),
            "-y",
            path_to_str(output_path)?,
        ])
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }

    Ok(format!("Recording started. File will be saved to {}", output_path.display()))
}

//Video and audio
pub async fn recording_with_output_va(app_handle: &AppHandle, state: State<'_, AppState>, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }

    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    log::debug!("Path {:?}", output_path);
    let child = silent_command(&ffmpeg_path)
        .args([
            "-f", "dshow",
            "-i", &format!("video={}:audio={}", form_data.video_device, form_data.audio_device),
            "-c:v", "mpeg4",
            "-y",
            path_to_str(output_path)?,
        ])
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }

    Ok(format!("Recording started. File will be saved to {}", output_path.display()))
}

//Screen only
pub async fn recording_with_output_s(app_handle: &AppHandle, state: State<'_, AppState>, output_path: &PathBuf, _form_data: &FormData) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    log::debug!("Path {:?}", output_path);
    let child = silent_command(&ffmpeg_path)
        .args([
            "-f", "gdigrab",
            "-framerate", "200",
            "-i", "desktop",
            "-y",
            path_to_str(output_path)?,
        ])
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }

    Ok(format!("Recording started. File will be saved to {}", output_path.display()))
}

//Capture
pub async fn recording_with_output_c(app_handle: &AppHandle, state: State<'_, AppState>, output_path: &PathBuf, _form_data: &FormData) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    log::debug!("Path {:?}", output_path);
    let child = silent_command(&ffmpeg_path)
        .args([
            "-f", "gdigrab",
            "-framerate", "30",
            "-i", "desktop",
            "-y",
            path_to_str(output_path)?,
        ])
        .spawn()
        .map_err(|e| format!("Failed to capture: {}", e))?;

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }

    Ok("Capture started".to_string())
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

    // Try graceful shutdown first: send 'q' to ffmpeg's stdin, then poll (off the async
    // runtime's worker threads) instead of blocking them with a fixed sleep.
    let mut process_state = state.ffmpeg_process.lock().await;
    let stop_pid: Option<u32> = if let Some(mut process) = process_state.take() {
        let pid = process.id();
        if let Some(stdin) = process.stdin.as_mut() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }

        let exited = tauri::async_runtime::spawn_blocking(move || {
            for _ in 0..20 {
                match process.try_wait() {
                    Ok(Some(_)) => return true,
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                    Err(_) => return false,
                }
            }
            let _ = process.kill();
            false
        })
        .await
        .unwrap_or(false);

        if exited { None } else { Some(pid) }
    } else {
        None
    };
    drop(process_state);

    // Fallback: force-kill only our own recording process, never every ffmpeg.exe on the
    // system (a blanket `/IM ffmpeg.exe` kill would also take out an unrelated conversion).
    if let Some(pid) = stop_pid {
        info!("Graceful shutdown failed, force-killing ffmpeg PID {}", pid);
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
    }

    info!("Recording stopped");

    let output_str = path_to_str(&output_path)?;

    if let Err(e) = app_handle.emit_all("display-file-modal", output_str.to_string()) {
        warn!("Failed to emit display-file-modal: {}", e);
    }
    if let Err(e) = app_handle.emit_all("refresh-file-list", ()) {
        warn!("Failed to emit refresh-file-list: {}", e);
    }

    if let Err(e) = create_or_replace_rec_completed_modal(app_handle).await {
        return Err(format!("Failed to show completion modal: {}", e));
    }

    Ok(output_str.to_string())
}

async fn create_or_replace_rec_completed_modal(app_handle: tauri::AppHandle) -> Result<String, String> {
    if let Some(modal_window) = app_handle.get_window("completed_recording") {
        if let Err(e) = modal_window.close() {
            return Err(format!("Failed to close existing modal window: {}", e));
        }
    }
    
    let file_path = "src-tauri/src/views/completed_recording.html";
    let result = tauri::WindowBuilder::new(
        &app_handle,
        "completed_recording",
        tauri::WindowUrl::App(file_path.into()),
    )
    .title("Recording completed")
    .center()
    .resizable(false)
    .inner_size(400.0, 500.0)
    .always_on_top(true)
    .minimizable(false)
    .build();

    match result {
        Ok(_) => Ok("Recording completed".to_string()),
        Err(e) => Err(format!("Failed to create modal window: {}", e)),
    }
}

