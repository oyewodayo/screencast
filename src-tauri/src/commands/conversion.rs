// conversion.rs
use std::collections::HashMap;
use tauri::{AppHandle, Window, State};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Stdio, Command};
use std::sync::Arc;
use tauri::async_runtime::Mutex;
use std::io::{BufRead, BufReader};

use crate::services::utility::{path_to_str, get_ffmpeg_path, get_ffprobe_path};

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

// If `path` is already taken, finds the next free "name (1).ext", "name (2).ext", ... instead -
// converting the same source to the same target format twice (a very ordinary thing to do:
// convert, tweak something, convert again) used to hard-fail with "Output file already exists"
// for no reason a user could act on other than renaming or deleting the previous output
// themselves first. Recording's own resolve_output_path (commands/recording.rs) already takes
// this same approach for a name collision - conversion output just never got the same treatment.
fn unique_output_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }

    let parent = path.parent().map(PathBuf::from).unwrap_or_default();
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|s| s.to_string_lossy().to_string());

    for n in 1.. {
        let candidate_name = match &ext {
            Some(ext) => format!("{} ({}).{}", stem, n, ext),
            None => format!("{} ({})", stem, n),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!()
}


// Shared conversion runner used by both convert_to_mp4 and convert_video, so every target
// format gets the same stderr progress-parsing thread (convert_video previously lacked one,
// so its progress bar silently never moved).
async fn run_conversion(
    app_handle: &AppHandle,
    window: &Window,
    state: &State<'_, ConversionState>,
    input_path: &str,
    output: PathBuf,
    codec_args: &[&str],
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let input = PathBuf::from(input_path);

    if !input.exists() {
        return Err("Input file does not exist".to_string());
    }

    let output = unique_output_path(output);

    let _ = window.emit("conversion-progress", ConversionProgress {
        input_path: input_path.to_string(),
        output_path: output.to_string_lossy().to_string(),
        progress: 0.0,
        status: ConversionStatus::Starting,
        message: "Starting conversion...".to_string(),
    });

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.arg("-i").arg(path_to_str(&input)?);
    cmd.args(codec_args);
    // -progress pipe:1 makes ffmpeg write machine-readable key=value progress lines to
    // stdout, newline-terminated. Without it, ffmpeg only prints a human-readable status
    // line to stderr that it rewrites in place with '\r' (never '\n'), which BufReader's
    // line-based reader never yields as a line - so progress silently never updated.
    // -nostats suppresses that human status line so it doesn't clutter the stderr scan below.
    cmd.args(["-y", "-progress", "pipe:1", "-nostats", path_to_str(&output)?]);
    // No interactive input is ever needed (the -y above suppresses overwrite prompts), and
    // leaving stdin inherited from the parent risks ffmpeg blocking on a read that never
    // resolves when run from a console-attached dev build.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start conversion: {}", e))?;

    let pid = child.id();
    {
        let mut active_process = state.active_process.lock().await;
        *active_process = Some(pid);
    }

    let stderr = child.stderr.take()
        .ok_or("Failed to capture stderr")?;
    let stdout = child.stdout.take()
        .ok_or("Failed to capture stdout")?;

    // Total duration comes from ffmpeg's initial "Duration: HH:MM:SS.ms" line on stderr;
    // current position comes from the structured -progress stream on stdout. Shared so the
    // stdout reader thread can turn "out_time_us" into a percentage once duration is known.
    let duration = Arc::new(std::sync::Mutex::new(None::<f64>));

    let duration_for_stderr = duration.clone();
    // Returns the accumulated stderr (rather than stashing it in a Mutex read right after
    // child.wait()) so the failure branch below can .join() this thread and be sure every line
    // - including whatever ffmpeg printed right as it exited - was actually captured, instead of
    // racing a reader thread that's still draining the pipe.
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut full_output = String::new();

        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => continue,
            };

            full_output.push_str(&line);
            full_output.push('\n');

            let mut guard = duration_for_stderr.lock().unwrap();
            if guard.is_none() {
                *guard = parse_duration(&full_output);
            }
        }

        full_output
    });

    let window_clone = window.clone();
    let input_path_clone = input_path.to_string();
    let output_path_clone = output.to_string_lossy().to_string();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => continue,
            };

            let Some(us_str) = line.strip_prefix("out_time_us=") else { continue };
            let Ok(current_us) = us_str.trim().parse::<i64>() else { continue };
            if current_us < 0 { continue }

            let Some(total_duration) = *duration.lock().unwrap() else { continue };
            if total_duration <= 0.0 { continue }

            let current_time = current_us as f64 / 1_000_000.0;
            let progress = (current_time / total_duration * 100.0).clamp(0.0, 99.0);

            let _ = window_clone.emit("conversion-progress", ConversionProgress {
                input_path: input_path_clone.clone(),
                output_path: output_path_clone.clone(),
                progress,
                status: ConversionStatus::Processing,
                message: format!("Converting... {:.1}%", progress),
            });
        }
    });

    // Wait for process to complete off the async runtime's worker threads - a transcode
    // can take minutes, and child.wait() blocks synchronously.
    let result = tauri::async_runtime::spawn_blocking(move || child.wait())
        .await
        .map_err(|e| format!("Conversion task panicked: {}", e))?
        .map_err(|e| format!("Failed to wait for conversion: {}", e))?;

    {
        let mut active_process = state.active_process.lock().await;
        *active_process = None;
    }

    if result.success() {
        let _ = window.emit("conversion-progress", ConversionProgress {
            input_path: input_path.to_string(),
            output_path: output.to_string_lossy().to_string(),
            progress: 100.0,
            status: ConversionStatus::Completed,
            message: "Conversion completed successfully".to_string(),
        });

        Ok(output.to_string_lossy().to_string())
    } else {
        let stderr_output = stderr_thread.join().unwrap_or_default();
        let error_msg = format!(
            "Conversion failed: {}",
            crate::commands::recording::extract_ffmpeg_error(&stderr_output)
        );

        let _ = window.emit("conversion-progress", ConversionProgress {
            input_path: input_path.to_string(),
            output_path: output.to_string_lossy().to_string(),
            progress: 0.0,
            status: ConversionStatus::Failed,
            message: error_msg.clone(),
        });

        Err(error_msg)
    }
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
    let input = PathBuf::from(&input_path);
    let output = match output_path {
        Some(path) => PathBuf::from(path),
        None => input.with_extension("mp4"),
    };

    let codec_args = [
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
    ];

    let result = run_conversion(&app_handle, &window, &state, &input_path, output, &codec_args).await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
}

// Deterministic, content-addressed cache location for the "just play, no prompts" preview
// fallback (see get_playable_preview below) - keyed by the source path plus its modification
// time, so a file replaced at the same path invalidates and regenerates automatically instead
// of ever silently reusing a stale preview.
fn preview_cache_path(input: &PathBuf) -> Result<PathBuf, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let metadata = std::fs::metadata(input).map_err(|e| format!("Failed to read input file: {}", e))?;
    let modified_secs = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    input.to_string_lossy().hash(&mut hasher);
    modified_secs.hash(&mut hasher);
    let key = hasher.finish();

    Ok(std::env::temp_dir().join("briefcast_preview_cache").join(format!("{:x}.mp4", key)))
}

// Silent, no-prompt fallback for a file the in-app player can't decode natively - most notably
// .avi, which WebView2's <video> element has no container support for at all regardless of the
// codec inside it; no ffmpeg encoding setting can change that. VideoPlayer.tsx calls this only
// from its <video> element's onError handler (never up front), so a file that already plays
// fine never pays this cost.
//
// This used to try to stream the conversion progressively (return the output path immediately
// and let the player read the still-growing file via MediaSource + ranged fetch) so a large
// recording wouldn't block on the full re-encode. That depended on WebView2's specific
// MediaSource implementation, exact codec-string matching, and fetch-over-a-custom-protocol all
// behaving as expected - none of which is inspectable from here (no devtools/console access to
// this app's running window), and it broke in practice twice. VLC-style universal playback works
// because VLC owns its entire decode pipeline (libavformat/libavcodec directly, no browser
// engine in between); trying to reproduce that inside a webview's <video>/MediaSource stack means
// depending on a browser vendor's partial implementation of it instead. Simpler and actually
// verifiable: wait for the real, complete conversion (ultrafast preset, so normally a small
// fraction of the recording's own runtime - measured ~3x faster than real-time against this
// app's own bundled ffmpeg) and then load an ordinary, fully-written file the exact way every
// other video in this app already plays.
#[tauri::command]
pub async fn get_playable_preview(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let cache_path = preview_cache_path(&input)?;

    // Already converted (fully, from a previous open) - just hand back the finished file, no
    // need to ever re-run ffmpeg for the same source.
    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create preview cache directory: {}", e))?;
    }

    let codec_args = [
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
    ];

    run_conversion(&app_handle, &window, &state, &input_path, cache_path, &codec_args).await
}

// Convert a still image (screenshot) between png/jpeg/webp/bmp. No audio/video codec args
// apply here - ffmpeg's image2 muxer picks a sane default encoder from the output extension,
// and run_conversion's duration-based progress just never populates (there's no "Duration:"
// line for a single frame), which is fine since these finish effectively instantly anyway.
#[tauri::command]
pub async fn convert_image(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
    output_format: String,
    output_path: Option<String>,
    preserve_original: bool,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let output = match output_path {
        Some(path) => PathBuf::from(path),
        None => input.with_extension(&output_format),
    };

    let codec_args: Vec<&str> = match output_format.to_lowercase().as_str() {
        "png" | "jpeg" | "jpg" | "webp" | "bmp" => vec![],
        _ => return Err(format!("Unsupported output format: {}", output_format)),
    };

    let result = run_conversion(&app_handle, &window, &state, &input_path, output, &codec_args).await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
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
                .args(["/F", "/PID", &pid.to_string()])
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
        let output_path = match output_dir.as_ref() {
            Some(dir) => {
                let input_path_buf = PathBuf::from(input_path);
                let filename = match input_path_buf.file_stem() {
                    Some(stem) => stem.to_string_lossy().to_string(),
                    None => {
                        results.push(format!("FAILED: {} has no file name", input_path));
                        continue;
                    }
                };
                Some(
                    PathBuf::from(dir)
                        .join(format!("{}.mp4", filename))
                        .to_string_lossy()
                        .to_string(),
                )
            }
            None => None,
        };

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
                log::warn!("Failed to convert {}: {}", input_path, e);
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
    let ffprobe_path = get_ffprobe_path(&app_handle)?;
    let input = PathBuf::from(&input_path);

    if !input.exists() {
        return Err("Input file does not exist".to_string());
    }

    let output = Command::new(&ffprobe_path)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            path_to_str(&input)?,
        ])
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    let mut info = HashMap::new();
    info.insert("input_path".to_string(), input_path);

    let file_size = input.metadata()
        .map(|m| m.len() / 1_000_000)
        .unwrap_or(0);
    info.insert("input_size".to_string(), format!("{} MB", file_size));

    info.insert("output_path".to_string(),
        input.with_extension("mp4").to_string_lossy().to_string()
    );

    if let Ok(probe) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
        if let Some(duration) = probe["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()) {
            info.insert("duration".to_string(), format!("{:.1}s", duration));
        }

        if let Some(streams) = probe["streams"].as_array() {
            if let Some(video) = streams.iter().find(|s| s["codec_type"] == "video") {
                if let Some(codec) = video["codec_name"].as_str() {
                    info.insert("video_codec".to_string(), codec.to_string());
                }
                if let (Some(w), Some(h)) = (video["width"].as_i64(), video["height"].as_i64()) {
                    info.insert("resolution".to_string(), format!("{}x{}", w, h));
                }
            }
            if let Some(audio) = streams.iter().find(|s| s["codec_type"] == "audio") {
                if let Some(codec) = audio["codec_name"].as_str() {
                    info.insert("audio_codec".to_string(), codec.to_string());
                }
            }
        }
    }

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
    let input = PathBuf::from(&input_path);
    let output = match output_path {
        Some(path) => PathBuf::from(path),
        None => input.with_extension(&output_format),
    };

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

    let result = run_conversion(&app_handle, &window, &state, &input_path, output, &codec_args).await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
}