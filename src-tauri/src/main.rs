#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::fs;
use std::env;
use std::env::consts::OS;
use std::path::PathBuf;
use std::process::Command;
use chrono::Utc;
use tauri::AppHandle;
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use tauri::regex::Regex;
use chrono;

#[derive(serde::Deserialize, Debug)]
struct FormData{
    file_name:String,
    file_ext:String,
    record_type:String,
    audio_device:String,
    video_device:String
}



#[tauri::command]
fn get_connected_devices(app_handle: AppHandle) -> (Vec<String>, Vec<String>) {
    let ffmpeg_path = match app_handle
        .path_resolver()
        .resolve_resource("binaries/ffmpeg/ffmpeg.exe")
    {
        Some(path) => path,
        None => {
            return (
                vec!["Failed to resolve ffmpeg path".to_string()],
                vec!["Failed to resolve ffmpeg path".to_string()],
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
fn get_connected_audios(app_handle: AppHandle)->Vec<String>{
    let audio_devices = get_connected_devices(app_handle).1;

    audio_devices
    

}

#[tauri::command]
fn get_connected_cameras(app_handle: AppHandle)->Vec<String>{
    let  video_devices = get_connected_devices(app_handle).0;

    video_devices

}



#[tauri::command]
fn start_recording(app_handle: AppHandle, form_data: FormData) -> Result<String, String> {
    let mut output_file: String;
    let mut output_path:PathBuf;
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
    if output_path.exists() {
        output_file = format!("Recording_{}.{}", current_date, form_data.file_ext);
        output_path = screencast_dir.join(&output_file);
       
     
    } 

    match form_data.record_type.as_str() {
        "sva" => {
               
                recording_with_output_sva(app_handle, &output_path, form_data)
            },
        "sv" => recording_with_output_sv(app_handle, &output_path,&form_data.video_device),
        "sa" => recording_with_output_sa(app_handle, &output_path, &form_data.audio_device),
        "va" => recording_with_output_va(app_handle, &output_path,&form_data.audio_device, &form_data.video_device),
        "s" => recording_with_output_s(app_handle, &output_path),
        "v" => recording_with_output_v(app_handle, &output_path, &form_data.video_device),
        "c" => recording_with_output_c(app_handle, &output_path),
        "a" => recording_with_output_a(app_handle, &output_path,&form_data.audio_device),
        _ => Err("Invalid recording type".to_string()),
    
    }

}


//Screen video and audio
fn recording_with_output_sva(app_handle: AppHandle, output_path: &PathBuf,form_data: FormData) -> Result<String, String> {
    let ffmpeg_path = app_handle
        .path_resolver()
        .resolve_resource("binaries/ffmpeg/ffmpeg.exe")
        .expect("failed to resolve ffmpeg path");

    let result = Command::new(&ffmpeg_path)
        .args(&[
            "-f", "gdigrab",
            "-framerate", "200",
            "-i", "desktop",
            "-f", "dshow",
            "-video_size", "320x240",
            "-i", &format!("video={}:audio={}", form_data.video_device, form_data.audio_device),
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


//Screen video and audio
fn recording_with_output_sv(app_handle: AppHandle, output_path: &PathBuf,video_device:&str) -> Result<String, String> {
    let ffmpeg_path = app_handle
        .path_resolver()
        .resolve_resource("binaries/ffmpeg/ffmpeg.exe")
        .expect("failed to resolve ffmpeg path");

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
fn recording_with_output_sa(app_handle: AppHandle, output_path: &PathBuf,audio_device:&str) -> Result<String, String> {
    let ffmpeg_path = app_handle
        .path_resolver()
        .resolve_resource("binaries/ffmpeg/ffmpeg.exe")
        .expect("failed to resolve ffmpeg path");

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
fn recording_with_output_v(app_handle: AppHandle, output_path: &PathBuf,video_device:&str) -> Result<String, String> {
    let ffmpeg_path = app_handle
        .path_resolver()
        .resolve_resource("binaries/ffmpeg/ffmpeg.exe")
        .expect("failed to resolve ffmpeg path");

    // let video_device = "Integrated Webcam";
    // let video_device = "Integrated Webcam";
    println!("Path {:?}", output_path);
    let result = Command::new(&ffmpeg_path)
        .args(&[
            "-f", "dshow",
            // "-video_size", "320x240",
            "-i", &format!("video={}", video_device),
            "-c:v", "mpeg4",
            output_path.to_str().unwrap(),
        ])
        .spawn();

    match result {
        Ok(_) => Ok(format!("Recording started. File will be saved to {}", output_path.display())),
        Err(e) => Err(format!("Failed to start recording: {}", e)),
    }
}

//Audio
fn recording_with_output_a(app_handle: AppHandle, output_path: &PathBuf,audio_device:&str) -> Result<String, String> {
    let ffmpeg_path = app_handle
        .path_resolver()
        .resolve_resource("binaries/ffmpeg/ffmpeg.exe")
        .expect("failed to resolve ffmpeg path");

    // let video_device = "Integrated Webcam";
    // let audio_device = "Microphone (Realtek Audio)";
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
fn recording_with_output_va(app_handle: AppHandle, output_path: &PathBuf,audio_device:&str,video_device:&str) -> Result<String, String> {
    let ffmpeg_path = app_handle
        .path_resolver()
        .resolve_resource("binaries/ffmpeg/ffmpeg.exe")
        .expect("failed to resolve ffmpeg path");

    println!("Path {:?}", output_path);
    let result = Command::new(&ffmpeg_path)
        .args(&[
            "-f", "dshow",
            // "-video_size", "320x240",
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
fn recording_with_output_s(app_handle: AppHandle, output_path: &PathBuf) -> Result<String, String> {
    let ffmpeg_path = app_handle
        .path_resolver()
        .resolve_resource("binaries/ffmpeg/ffmpeg.exe")
        .expect("failed to resolve ffmpeg path");

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

//Screen only
fn recording_with_output_c(app_handle: AppHandle, output_path: &PathBuf) -> Result<String, String> {
    let ffmpeg_path = app_handle
        .path_resolver()
        .resolve_resource("binaries/ffmpeg/ffmpeg.exe")
        .expect("failed to resolve ffmpeg path");
   
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
        Ok(_) => {
           
            match result {
                Ok(_) => Ok("Recording stopped {OS}".to_string()),
                Err(e) => Err(format!("Failed to stop recording: {}", e)),
            }
        },
        Err(e) => Err(format!("Failed to capture: {}", e)),
    }
    
}

fn _convert_video_type(app_handle: AppHandle,input:&str,output:&str)->Result<String, String>{
    let ffmpeg_path = app_handle
        .path_resolver()
        .resolve_resource("binaries/ffmpeg/ffmpeg.exe")
        .expect("Failed to resolve ffmpeg path");
     let metadata = fs::metadata(input).unwrap();
     let output_path:&str;
     if metadata.is_file() {
        let output_file = input.split(".").nth(0);
        output_path = output_file.expect("File name not in the splitted index");
    }
    else {
        let output_file = input.split(".").nth(1);
        output_path = output_file.expect("File name not in the splitted index");
    }
        
    
   
    let result = Command::new(&ffmpeg_path)
        .args([
            "-i",&format!("{}",input),
            "-c:v","libx264",
            "-c:a","aac",
            output_path,
        ]).spawn();
    Ok("Ok".to_string())
}

#[tauri::command]
fn stop_recording() -> Result<String, String> {
    let result = if cfg!(target_os = "windows") {
        Command::new("taskkill")
            .args(&["/F", "/IM", "ffmpeg.exe"])
            .output()
    } else {
        Command::new("killall").arg("ffmpeg").output()
    };

    match result {
        Ok(_) => Ok("Recording stopped {OS}".to_string()),
        Err(e) => Err(format!("Failed to stop recording: {}", e)),
    }
}


#[tauri::command]
fn get_ram_info() -> (u64, u64) {
    let mut mem_status = MEMORYSTATUSEX::default();
    mem_status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;

    let result = unsafe {
        // This call is unsafe because it modifies the mem_status struct directly
        GlobalMemoryStatusEx(&mut mem_status)
    };

    result.expect("Failed to get memory info");

    (
        mem_status.ullTotalPhys / (1024 * 1024),
        mem_status.ullAvailPhys / (1024 * 1024)
    )
}


#[tauri::command]
fn get_os_info() -> String {
    OS.to_string().to_uppercase()
}



fn main() {
    
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_connected_audios,
            get_connected_cameras,
            get_connected_devices,
            get_ram_info,
            get_os_info,
            start_recording,
            stop_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
