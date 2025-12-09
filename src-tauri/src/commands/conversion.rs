// conversion.rs
use std::collections::HashMap;
use tauri::{AppHandle, Window, State};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Stdio, Command};
use std::sync::Arc;
use tauri::async_runtime::Mutex;
use std::io::{BufRead, BufReader};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConversionProgress {
    pub input_path: String,
    pub output_path: String,
    pub progress: f64,
    pub status: ConversionStatus,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ConversionStatus {
    Starting,
    Processing,
    Completed,
    Failed,
}

#[derive(Default, Clone)]
pub struct ConversionState {
    active_process: Arc<Mutex<Option<u32>>>, // Store PID instead of Child
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

// Helper function to parse duration from FFmpeg output (format: HH:MM:SS.ms)
fn parse_duration(output: &str) -> Option<f64> {
    for line in output.lines() {
        if line.contains("Duration:") {
            if let Some(duration_str) = line.split("Duration:").nth(1) {
                if let Some(time_str) = duration_str.split(',').next() {
                    let time_str = time_str.trim();
                    let parts: Vec<&str> = time_str.split(':').collect();
                    if parts.len() == 3 {
                        if let (Ok(hours), Ok(minutes), Ok(seconds)) = (
                            parts[0].parse::<f64>(),
                            parts[1].parse::<f64>(),
                            parts[2].parse::<f64>(),
                        ) {
                            return Some(hours * 3600.0 + minutes * 60.0 + seconds);
                        }
                    }
                }
            }
        }
    }
    None
}

// Helper function to parse current time from FFmpeg progress output
fn parse_current_time(output: &str) -> Option<f64> {
    for line in output.lines() {
        if line.contains("time=") {
            if let Some(time_str) = line.split("time=").nth(1) {
                if let Some(time_part) = time_str.split_whitespace().next() {
                    let parts: Vec<&str> = time_part.split(':').collect();
                    if parts.len() == 3 {
                        if let (Ok(hours), Ok(minutes), Ok(seconds)) = (
                            parts[0].parse::<f64>(),
                            parts[1].parse::<f64>(),
                            parts[2].parse::<f64>(),
                        ) {
                            return Some(hours * 3600.0 + minutes * 60.0 + seconds);
                        }
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn convert_to_mp4(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
    output_path: Option<String>,
    preserve_original: bool,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    
    let input = PathBuf::from(&input_path);
    
    // Validate input file exists
    if !input.exists() {
        return Err("Input file does not exist".to_string());
    }
    println!("Input path is {:?}",input_path);
    println!("Output path is {:?}",output_path);
    println!("preserve_original path is {:?}",preserve_original);
    // Determine output path
    let output = match output_path {
        Some(path) => PathBuf::from(path),
        None => input.with_extension("mp4"),
    };
    
    // Check if output already exists
    if output.exists() {
        return Err("Output file already exists".to_string());
    }

    // Emit starting progress
    let _ = window.emit("conversion-progress", ConversionProgress {
        input_path: input_path.clone(),
        output_path: output.to_string_lossy().to_string(),
        progress: 0.0,
        status: ConversionStatus::Starting,
        message: "Starting conversion...".to_string(),
    });

    // Build FFmpeg command
    let mut cmd = Command::new(&ffmpeg_path);
    
    cmd.args(&[
        "-i", input.to_str().unwrap(),
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        "-y", // Overwrite output
        output.to_str().unwrap(),
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    // Spawn the process
    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start conversion: {}", e))?;

    // Store the process ID for potential cancellation
    let pid = child.id();
    {
        let mut active_process = state.active_process.lock().await;
        *active_process = Some(pid);
    }

    // Clone stderr before moving child
    let stderr = child.stderr.take()
        .ok_or("Failed to capture stderr")?;
    
    // Spawn a thread to monitor progress
    let window_clone = window.clone();
    let input_path_clone = input_path.clone();
    let output_path_clone = output.to_string_lossy().to_string();
    
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut duration: Option<f64> = None;
        let mut full_output = String::new();
        
        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => continue,
            };
            
            full_output.push_str(&line);
            full_output.push('\n');
            
            // Parse duration if not already set
            if duration.is_none() {
                duration = parse_duration(&full_output);
            }
            
            // Parse current time and calculate progress
            if let (Some(current_time), Some(total_duration)) = (parse_current_time(&line), duration) {
                let progress = (current_time / total_duration * 100.0).min(99.0);
                
                let _ = window_clone.emit("conversion-progress", ConversionProgress {
                    input_path: input_path_clone.clone(),
                    output_path: output_path_clone.clone(),
                    progress,
                    status: ConversionStatus::Processing,
                    message: format!("Converting... {:.1}%", progress),
                });
            }
        }
    });

    // Wait for process to complete
    let result = child.wait()
        .map_err(|e| format!("Failed to wait for conversion: {}", e))?;

    // Clear the active process
    {
        let mut active_process = state.active_process.lock().await;
        *active_process = None;
    }

    if result.success() {
        // Emit completion event
        let _ = window.emit("conversion-progress", ConversionProgress {
            input_path: input_path.clone(),
            output_path: output.to_string_lossy().to_string(),
            progress: 100.0,
            status: ConversionStatus::Completed,
            message: "Conversion completed successfully".to_string(),
        });

        // Optionally delete original file
        if !preserve_original {
            let _ = std::fs::remove_file(&input);
        }

        Ok(output.to_string_lossy().to_string())
    } else {
        let error_msg = "Conversion failed - check FFmpeg output for details";
        
        let _ = window.emit("conversion-progress", ConversionProgress {
            input_path: input_path.clone(),
            output_path: output.to_string_lossy().to_string(),
            progress: 0.0,
            status: ConversionStatus::Failed,
            message: error_msg.to_string(),
        });

        Err(error_msg.to_string())
    }
}

// Cancel ongoing conversion
#[tauri::command]
pub async fn cancel_conversion(
    state: State<'_, ConversionState>
) -> Result<(), String> {
    let mut active_process = state.active_process.lock().await;
    
    if let Some(pid) = active_process.take() {
        #[cfg(windows)]
        {
            Command::new("taskkill")
                .args(&["/F", "/PID", &pid.to_string()])
                .output()
                .map_err(|e| format!("Failed to cancel conversion: {}", e))?;
        }
        
        #[cfg(not(windows))]
        {
            Command::new("kill")
                .args(&["-9", &pid.to_string()])
                .output()
                .map_err(|e| format!("Failed to cancel conversion: {}", e))?;
        }
        
        Ok(())
    } else {
        Err("No active conversion to cancel".to_string())
    }
}

// Enhanced batch conversion
#[tauri::command]
pub async fn batch_convert_to_mp4(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_paths: Vec<String>,
    output_dir: Option<String>,
    preserve_original: bool,
) -> Result<Vec<String>, String> {
    let mut results = Vec::new();
    let total_files = input_paths.len();

    for (index, input_path) in input_paths.iter().enumerate() {
        let progress = (index as f64 / total_files as f64) * 100.0;
        
        // Emit batch progress
        let _ = window.emit("batch-conversion-progress", serde_json::json!({
            "current_file": input_path,
            "current_index": index,
            "total_files": total_files,
            "overall_progress": progress,
        }));

        // Determine output path for this file
        let output_path = output_dir.as_ref().map(|dir| {
            let input_path_buf = PathBuf::from(input_path);
            let filename = input_path_buf.file_stem().unwrap().to_string_lossy();
            PathBuf::from(dir)
                .join(format!("{}.mp4", filename))
                .to_string_lossy()
                .to_string()
        });

        match convert_to_mp4(
            app_handle.clone(),
            window.clone(),
            state.clone(),
            input_path.clone(),
            output_path,
            preserve_original,
        ).await {
            Ok(output_path) => results.push(output_path),
            Err(e) => {
                println!("Failed to convert {}: {}", input_path, e);
                results.push(format!("FAILED: {}", e));
            }
        }
    }

    Ok(results)
}

// Get file information before conversion
#[tauri::command]
pub async fn get_conversion_info(
    app_handle: AppHandle,
    input_path: String,
) -> Result<HashMap<String, String>, String> {
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let input = PathBuf::from(&input_path);
    
    if !input.exists() {
        return Err("Input file does not exist".to_string());
    }
    
    let output = Command::new(&ffmpeg_path)
        .args(&["-i", input.to_str().unwrap()])
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to get file info: {}", e))?;
    
    let mut info = HashMap::new();
    info.insert("input_path".to_string(), input_path);
    
    // Get file size
    let file_size = input.metadata()
        .map(|m| m.len() / 1_000_000)
        .unwrap_or(0);
    info.insert("input_size".to_string(), format!("{} MB", file_size));
    
    info.insert("output_path".to_string(), 
        input.with_extension("mp4").to_string_lossy().to_string()
    );
    
    Ok(info)
}

// Get available conversion formats
#[tauri::command]
pub fn get_supported_conversion_formats() -> Vec<HashMap<&'static str, &'static str>> {
    vec![
        HashMap::from([("value", "mp4"), ("label", "MP4 (Recommended)")]),
        HashMap::from([("value", "mov"), ("label", "MOV")]),
        HashMap::from([("value", "mkv"), ("label", "MKV")]),
        HashMap::from([("value", "avi"), ("label", "AVI")]),
        HashMap::from([("value", "webm"), ("label", "WebM")]),
    ]
}

// Check if file needs conversion
#[tauri::command]
pub fn should_convert_file(file_path: String) -> bool {
    let path = PathBuf::from(file_path);
    if let Some(ext) = path.extension() {
        let ext_str = ext.to_string_lossy().to_lowercase();
        matches!(ext_str.as_str(), "mkv" | "avi" | "mov" | "wmv" | "flv")
    } else {
        false
    }
}

// Generic conversion to any format
#[tauri::command]
pub async fn convert_video(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
    output_format: String,
    output_path: Option<String>,
    preserve_original: bool,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    
    let input = PathBuf::from(&input_path);
    
    if !input.exists() {
        return Err("Input file does not exist".to_string());
    }
    
    // Determine output path
    let output = match output_path {
        Some(path) => PathBuf::from(path),
        None => input.with_extension(&output_format),
    };
    
    if output.exists() {
        return Err("Output file already exists".to_string());
    }

    // Emit starting progress
    let _ = window.emit("conversion-progress", ConversionProgress {
        input_path: input_path.clone(),
        output_path: output.to_string_lossy().to_string(),
        progress: 0.0,
        status: ConversionStatus::Starting,
        message: "Starting conversion...".to_string(),
    });

    // Build codec args based on format
    let codec_args: Vec<&str> = match output_format.to_lowercase().as_str() {
        "mp4" => vec![
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "23",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
        ],
        "mov" => vec![
            "-c:v", "libx264",
            "-preset", "medium",
            "-c:a", "aac",
            "-movflags", "+faststart",
        ],
        "mkv" => vec![
            "-c:v", "libx264",
            "-preset", "medium",
            "-c:a", "aac",
        ],
        "avi" => vec![
            "-c:v", "libx264",
            "-c:a", "mp3",
        ],
        "webm" => vec![
            "-c:v", "libvpx",
            "-c:a", "libvorbis",
        ],
        _ => return Err(format!("Unsupported output format: {}", output_format)),
    };

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.arg("-i").arg(input.to_str().unwrap());
    cmd.args(&codec_args);
    cmd.arg("-y").arg(output.to_str().unwrap());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start conversion: {}", e))?;

    let pid = child.id();
    {
        let mut active_process = state.active_process.lock().await;
        *active_process = Some(pid);
    }

    // Wait for completion
    let result = child.wait()
        .map_err(|e| format!("Failed to wait for conversion: {}", e))?;

    {
        let mut active_process = state.active_process.lock().await;
        *active_process = None;
    }

    if result.success() {
        let _ = window.emit("conversion-progress", ConversionProgress {
            input_path: input_path.clone(),
            output_path: output.to_string_lossy().to_string(),
            progress: 100.0,
            status: ConversionStatus::Completed,
            message: "Conversion completed successfully".to_string(),
        });

        if !preserve_original {
            let _ = std::fs::remove_file(&input);
        }

        Ok(output.to_string_lossy().to_string())
    } else {
        Err("Conversion failed".to_string())
    }
}