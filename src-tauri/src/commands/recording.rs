//recording.rs
use std::path::PathBuf;
use std::process::Command;
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
use log::info;

use crate::commands::windows_api;

#[derive(Default, Clone)]
pub struct AppState{
    output_path:Arc<Mutex<Option<PathBuf>>>,
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

// Centralized FFmpeg path resolution with cross-platform support
pub fn get_ffmpeg_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(windows)]
    let binary_name = "ffmpeg.exe";
    
    #[cfg(not(windows))]
    let binary_name = "ffmpeg";
    
    let resource_path = format!("binaries/ffmpeg/{}", binary_name);
    
    app_handle
        .path_resolver()
        .resolve_resource(&resource_path)
        .ok_or_else(|| format!("Failed to resolve ffmpeg at {}", resource_path))
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
    println!("FFmpeg Stderr: {}", stderr);

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

    println!("Parsed Video Devices: {:?}", video_devices);
    println!("Parsed Audio Devices: {:?}", audio_devices);

    (video_devices, audio_devices)
}

#[tauri::command]
pub fn get_connected_audios(app_handle: AppHandle)->Vec<String>{
    let audio_devices = get_connected_devices(app_handle).1;
    audio_devices
}

#[tauri::command]
pub fn get_connected_cameras(app_handle: AppHandle)->Vec<String>{
    let video_devices = get_connected_devices(app_handle).0;
    video_devices
}

#[tauri::command]
pub async fn start_recording(app_handle: AppHandle,state:State<'_,AppState>,  form_data: FormData) -> Result<String, String> {
    let mut output_file: String;
    let output_path:PathBuf;
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

    println!("Here are the {:?}",form_data);
    println!("Here are the windows {:?}",windows_api::get_all_open_windows_titles());
    
    // Append the screencast directory to the user's Videos directory
    let mut screencast_dir = home_dir.clone();
    screencast_dir.push("screencast");

    output_file = format!("Recording_{}.{}", current_date, form_data.file_ext);

    if !form_data.file_name.is_empty() {
        output_file = format!("{}.{}", form_data.file_name, form_data.file_ext);
    }
    
    output_path = screencast_dir.join(&output_file);

    // Ensure the screencast directory exists, create it if it doesn't
    if !screencast_dir.exists() {
        if let Err(err) = fs::create_dir_all(&screencast_dir) {
            return Err(format!("Failed to create screencast directory: {}", err));
        }
    }

    // Check if the file exists
    let output_path = if output_path.exists() {
        output_file = format!("Recording_{}.{}", current_date, form_data.file_ext);
        screencast_dir.join(&output_file)
    } else {
        output_path
    };

    match form_data.record_type.as_str() {
        "sva" => recording_with_output_sva(&app_handle,state, &output_path, &form_data).await,
        "sv" => recording_with_output_sv(&app_handle, &output_path,&form_data.video_device),
        "sa" => recording_with_output_sa(&app_handle, &output_path, &form_data.audio_device),
        "va" => recording_with_output_va(&app_handle, &output_path,&form_data.audio_device, &form_data.video_device),
        "s" => recording_with_output_s(&app_handle, &output_path),
        "v" => recording_with_output_v(&app_handle, &output_path, &form_data.video_device),
        "c" => recording_with_output_c(&app_handle, &output_path),
        "a" => recording_with_output_a(&app_handle, &output_path,&form_data.audio_device),
        _ => Err("Invalid recording type".to_string()),
    }
}

//Screen video and audio
pub async fn recording_with_output_sva(app_handle: &AppHandle, state: State<'_, AppState>, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
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
        println!("overlay is present");
        add_overlay_args(&mut args, form_data);
    } else {
        let mut audio_input = String::from("audio=");
        audio_input.push_str(&form_data.audio_device);
        args.push("-i".to_string());
        args.push(audio_input);
    }

    // Output command
    args.extend(vec![
        "-segment_time".to_string(), "10".to_string(),
        "-segment_format".to_string(), "avi".to_string(),
        output_path.to_str().unwrap().to_string(),
    ]);

    let result = Command::new(&ffmpeg_path)
        .args(&args)
        .spawn();

    println!("{:?}", result);

    match result {
        Ok(_) => {
            Ok(format!("File will be saved as \n {}.{}", form_data.file_name, form_data.file_ext))
        },
        Err(e) => Err(format!("Failed to start recording: {}", e)),
    }
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

//Screen video
pub fn recording_with_output_sv(app_handle: &AppHandle, output_path: &PathBuf, video_device: &str) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    let result = Command::new(&ffmpeg_path)
        .args(&[
            "-f", "gdigrab",
            "-framerate", "200",
            "-i", "desktop",
            "-f", "dshow",
            "-video_size", "320x240",
            "-i", &format!("video={}", video_device),
            "-c:v", "mpeg4",
            "-filter_complex", "[0:v][1:v]overlay=x=W-w-100:y=H-h-50",
            "-segment_time", "10",
            "-segment_format", "avi",
            output_path.to_str().unwrap(),
        ])
        .spawn();

    match result {
        Ok(_) => Ok(format!("Recording started. File will be saved to {}", output_path.display())),
        Err(e) => Err(format!("Failed to start recording: {}", e)),
    }
}

//Screen and audio
pub fn recording_with_output_sa(app_handle: &AppHandle, output_path: &PathBuf, audio_device: &str) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    println!("Path {:?}", output_path);
    let result = Command::new(&ffmpeg_path)
        .args(&[
            "-f", "gdigrab",
            "-framerate", "200",
            "-i", "desktop",
            "-f", "dshow",
            "-video_size", "320x240",
            "-i", &format!("audio={}", audio_device),
            output_path.to_str().unwrap(),
        ])
        .spawn();

    match result {
        Ok(_) => Ok(format!("Recording started. File will be saved to {}", output_path.display())),
        Err(e) => Err(format!("Failed to start recording: {}", e)),
    }
}

//Video only
pub fn recording_with_output_v(app_handle: &AppHandle, output_path: &PathBuf, video_device: &str) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    println!("Path {:?}", output_path);
    let result = Command::new(&ffmpeg_path)
        .args(&[
            "-f", "dshow",
            "-i", &format!("video={}", video_device),
            "-c:v", "mpeg4",
            output_path.to_str().unwrap(),
        ])
        .spawn();

    match result {
        Ok(_) => Ok(format!("Recording started. File will be saved to {:?}", output_path.file_name())),
        Err(e) => Err(format!("Failed to start recording: {}", e)),
    }
}

//Audio only
pub fn recording_with_output_a(app_handle: &AppHandle, output_path: &PathBuf, audio_device: &str) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    println!("Path {:?}", output_path);
    let result = Command::new(&ffmpeg_path)
        .args(&[
            "-f", "dshow",
            "-i", &format!("audio={}", audio_device),
            output_path.to_str().unwrap(),
        ])
        .spawn();

    match result {
        Ok(_) => Ok(format!("Recording started. File will be saved to {}", output_path.display())),
        Err(e) => Err(format!("Failed to start recording: {}", e)),
    }
}

//Video and audio
pub fn recording_with_output_va(app_handle: &AppHandle, output_path: &PathBuf, audio_device: &str, video_device: &str) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    println!("Path {:?}", output_path);
    let result = Command::new(&ffmpeg_path)
        .args(&[
            "-f", "dshow",
            "-i", &format!("video={}:audio={}", video_device, audio_device),
            "-c:v", "mpeg4",
            output_path.to_str().unwrap(),
        ])
        .spawn();

    match result {
        Ok(_) => Ok(format!("Recording started. File will be saved to {}", output_path.display())),
        Err(e) => Err(format!("Failed to start recording: {}", e)),
    }
}

//Screen only
pub fn recording_with_output_s(app_handle: &AppHandle, output_path: &PathBuf) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    println!("Path {:?}", output_path);
    let result = Command::new(&ffmpeg_path)
        .args(&[
            "-f", "gdigrab",
            "-framerate", "200",
            "-i", "desktop",         
            output_path.to_str().unwrap(),
        ])
        .spawn();

    match result {
        Ok(_) => Ok(format!("Recording started. File will be saved to {}", output_path.display())),
        Err(e) => Err(format!("Failed to start recording: {}", e)),
    }
}

//Capture
pub fn recording_with_output_c(app_handle: &AppHandle, output_path: &PathBuf) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
   
    println!("Path {:?}", output_path);
    let result = Command::new(&ffmpeg_path)
        .args(&[
            "-f", "gdigrab",
            "-framerate", "30",
            "-i", "desktop",         
            output_path.to_str().unwrap(),
        ])
        .spawn();

    match result {
        Ok(_) => Ok("Recording stopped".to_string()),
        Err(e) => Err(format!("Failed to capture: {}", e)),
    }
}

pub fn _convert_video_type(app_handle: &AppHandle, input: &str, output: &str) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    
    let metadata = fs::metadata(input).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let output_path: &str;
    
    if metadata.is_file() {
        let output_file = input.split(".").nth(0);
        output_path = output_file.ok_or("File name not in the splitted index")?;
    } else {
        let output_file = input.split(".").nth(1);
        output_path = output_file.ok_or("File name not in the splitted index")?;
    }
   
    let _result = Command::new(&ffmpeg_path)
        .args([
            "-i", &format!("{}", input),
            "-c:v", "libx264",
            "-c:a", "aac",
            output_path,
        ])
        .spawn()
        .map_err(|e| format!("Failed to convert video: {}", e))?;
    
    Ok("Ok".to_string())
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
    
    let result = if cfg!(target_os = "windows") {
        Command::new("taskkill")
            .args(&["/F", "/IM", "ffmpeg.exe"])
            .output()
    } else if cfg!(target_os = "macos") {
        Command::new("pkill")
            .arg("ffmpeg")
            .output()
    } else if cfg!(target_os = "linux") {
        Command::new("pkill")
            .arg("ffmpeg")
            .output()
    } else {
        return Err("Unsupported operating system".to_string());
    };
    info!("Stopped recording");

    match result {
        Ok(_) => {
            if let Some(output_str) = output_path.to_str() {
                app_handle.emit_all("display-file-modal", output_str.to_string()).unwrap();
    
                if let Err(e) = create_or_replace_rec_completed_modal(app_handle).await {
                    return Err(format!("Failed to stop recording: {}", e));
                } else {
                    return Ok(output_str.to_string());
                }
            } else {
                return Err("Failed to convert output path to string".to_string());
            }
        },
        Err(e) => Err(format!("Failed to stop recording: {}", e)),
    }
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

fn _show_file_modal(app_handle: tauri::AppHandle, file_path: PathBuf) {
    app_handle.emit_all("display-file-modal", file_path.to_str().unwrap_or("")).unwrap();
}

pub fn screen_capture_by_title(app_handle: &AppHandle, title: String) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    
    let output_path = format!("{}.png", title.trim().replace('\0', "").replace(" ", "_")); 
    let clean_title = title.trim().replace('\0', ""); 
    
    println!("Path {:?}", output_path);
    let result = Command::new(&ffmpeg_path)
        .args(&[
            "-f", "gdigrab",
            "-rtbufsize", "100M",
            "-framerate", "1",
            "-t", "1",
            "-i", &format!("title={}", clean_title),  
            "-frames:v", "1",
            "-update", "1",       
            &output_path,
        ])
        .output();

    match result {
        Ok(output) => {
            if output.status.success() {
                Ok(output_path)
            } else {
                Err(format!("Failed to capture: {}", String::from_utf8_lossy(&output.stderr)))
            }
        },
        Err(e) => Err(format!("Failed to execute ffmpeg: {}", e)),
    }
}