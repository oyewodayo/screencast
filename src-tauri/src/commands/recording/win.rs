// commands/recording/win.rs
//
// Windows recording backend: screen via ffmpeg's `gdigrab`, camera/microphone via `dshow`.
// Moved here verbatim from the old single-file recording.rs — no behavior change, including its
// existing inconsistencies (recording_with_output_sva/_v spawn without silent_command, unlike
// every other mode here; that's pre-existing, not something this move introduces or fixes).
use std::path::PathBuf;
use std::process::{Command, Stdio};

use tauri::regex::Regex;
use tauri::{AppHandle, State};

use super::{audio_codec_args_for_ext, build_camera_overlay_filter_complex, codec_args_for_ext, extract_ffmpeg_error, map_overlay_size, resolve_capture_target, silent_command, AppState, CaptureTarget, FormData, AUDIO_ENHANCE_FILTER};
use crate::services::utility::{get_ffmpeg_path, path_to_str};

fn desktop_crop_args(x: i32, y: i32, width: i32, height: i32) -> Vec<String> {
    vec![
        "-offset_x".to_string(), x.to_string(),
        "-offset_y".to_string(), y.to_string(),
        "-video_size".to_string(), format!("{}x{}", width, height),
        "-i".to_string(), "desktop".to_string(),
    ]
}

// gdigrab does have its own dedicated window-capture mode (`-i title=<exact title>` instead of
// `-i desktop`), which is the more obvious way to implement this — deliberately not used here.
// That mode grabs a window's contents the same way the classic GetDC(hwnd)+BitBlt technique
// does, which is exactly what this app's own window-thumbnail feature (see
// window_capture/win.rs's capture_window_enhanced) already had to move *away* from in favor of
// PrintWindow(PW_RENDERFULLCONTENT), because BitBlt-style capture comes back solid black for any
// GPU-composited window — which in practice is nearly every modern app (Chrome, VS Code,
// Electron, ...). ffmpeg has no PrintWindow-equivalent flag for gdigrab.
//
// Instead, this captures the screen *region* the window currently occupies — a real,
// already-composited pixel source, since it's just cropping the same desktop grab the Monitor
// case above already uses successfully. This only produces the right pixels if the window is
// actually the frontmost thing at that location, which is why callers are expected to have
// already awaited activate_and_open_window before starting capture (Dashboard.tsx does this for
// recording; take_screenshot needs the same treatment on the frontend).
fn gdigrab_input_args(target: &CaptureTarget) -> Result<Vec<String>, String> {
    match target {
        CaptureTarget::FullScreen => Ok(vec!["-i".to_string(), "desktop".to_string()]),
        CaptureTarget::Monitor { x, y, width, height } => Ok(desktop_crop_args(*x, *y, *width, *height)),
        CaptureTarget::Window { title } => {
            let (x, y, width, height) = crate::commands::window_capture::win::get_window_rect_by_title(title)?;
            Ok(desktop_crop_args(x, y, width, height))
        }
    }
}

pub fn get_connected_devices(app_handle: &AppHandle) -> (Vec<String>, Vec<String>) {
    let ffmpeg_path = match get_ffmpeg_path(app_handle) {
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

// Adds one video-only dshow input per selected camera (mic audio travels as its own separate
// input now - see recording_with_output_sva - rather than being bundled into a single camera's
// input line, which only ever made sense when there was exactly one camera), then a
// -filter_complex chaining an overlay stage per camera onto the screen capture.
pub fn add_overlay_args(args: &mut Vec<String>, form_data: &FormData) {
    let overlay_size = map_overlay_size(&form_data.overlay_size);

    for device in &form_data.video_devices {
        args.extend(vec![
            "-f".to_string(), "dshow".to_string(),
            "-video_size".to_string(), overlay_size.clone(),
            "-i".to_string(), format!("video={}", device),
        ]);
    }

    let filter_complex = build_camera_overlay_filter_complex(
        &form_data.overlay_shape,
        &form_data.overlay_position,
        &form_data.overlay_size,
        form_data.video_devices.len(),
    );

    args.extend(vec!["-filter_complex".to_string(), filter_complex]);
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

    args.extend(gdigrab_input_args(&resolve_capture_target(app_handle, form_data))?);

    // Camera inputs (if any) must be added before the audio input below - add_overlay_args's
    // filter_complex references them as [1:v]..[N:v], immediately following the screen capture
    // at index 0, so nothing else can be inserted between the screen input and the camera inputs.
    if !form_data.video_devices.is_empty() {
        log::debug!("{} camera(s) overlaid", form_data.video_devices.len());
        add_overlay_args(&mut args, form_data);
    }

    // Audio is now always its own standalone input - previously it was bundled into the single
    // camera's dshow input line (video=X:audio=Y), which only worked for exactly one camera.
    args.extend(vec![
        "-f".to_string(), "dshow".to_string(),
        "-i".to_string(), format!("audio={}", form_data.audio_device),
    ]);

    // Add codec flags based on file extension. Used to be its own inline copy of this match
    // (kept separate from codec_args_for_ext per this module's original "leave Windows as-is"
    // policy) - now unified with it since both needed the same fix (missing -b:a on mkv/webm
    // meant those fell back to noticeably-more-compressed default bitrates), so keeping two
    // copies in sync stopped being worth it.
    args.extend(codec_args_for_ext(&form_data.file_ext));
    // Evens out quiet/inconsistent mic levels - see AUDIO_ENHANCE_FILTER's doc comment.
    args.extend(vec!["-af".to_string(), AUDIO_ENHANCE_FILTER.to_string()]);

    let output_file = path_to_str(output_path)?.to_string();

    log::debug!("Output file: {}", output_file);

    // Add output file
    args.push(output_file.clone());

    log::debug!("FFmpeg args: {:?}", args);

    // IMPORTANT: Keep stdin open for graceful shutdown. stdout/stderr are nulled, not piped:
    // ffmpeg writes continuous stats/progress lines to stderr throughout the whole recording,
    // and nothing here ever reads a piped stdout/stderr to drain it - once the OS pipe buffer
    // fills (a matter of minutes, not seconds, for any real recording), ffmpeg's next write()
    // blocks forever. At that point it's stuck *before* it ever gets back around to checking
    // stdin, so stop_recording's graceful "q" write goes nowhere, its 2-second wait times out,
    // and the process gets force-killed - which for a container format that needs a proper
    // finalize on exit (WebM/Matroska in particular) produces exactly the kind of corrupt,
    // unparseable file ("EBML header parsing failed") this was silently causing.
    let child = Command::new(&ffmpeg_path)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
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

    // add_overlay_args already appends its own -filter_complex chaining every selected camera
    // (see recording_with_output_sva) - a second hardcoded "-filter_complex" here used to follow
    // it and silently win, ignoring the user's shape/position choice and hardcoding exactly one
    // camera. Removed so add_overlay_args's chain is authoritative, same as sva.
    if !form_data.video_devices.is_empty() {
        log::debug!("{} camera(s) overlaid", form_data.video_devices.len());
        add_overlay_args(&mut args, form_data);
    }

    // Output command
    args.extend(vec![
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

    let mut args: Vec<String> = vec!["-f".to_string(), "gdigrab".to_string(), "-framerate".to_string(), "200".to_string()];
    args.extend(gdigrab_input_args(&resolve_capture_target(app_handle, form_data))?);
    args.extend(vec![
        "-f".to_string(), "dshow".to_string(),
        "-i".to_string(), format!("audio={}", form_data.audio_device),
    ]);
    // Previously had no codec flags at all here, leaving both streams to ffmpeg's per-container
    // defaults - which measured out to a 200kbps video bitrate for a 4K capture (badly
    // blocky) and default-quality MP3 audio, inconsistent with every other recording mode.
    args.extend(codec_args_for_ext(&form_data.file_ext));
    args.extend(vec!["-af".to_string(), AUDIO_ENHANCE_FILTER.to_string()]);
    args.extend(vec!["-y".to_string(), path_to_str(output_path)?.to_string()]);

    log::debug!("Path {:?}", output_path);
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

//Video only
pub async fn recording_with_output_v(app_handle: &AppHandle, state: State<'_, AppState>, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    log::debug!("Path {:?}", output_path);
    let video_device = form_data.video_devices.first().cloned().unwrap_or_default();

    let mut args: Vec<String> = vec![
        "-f".to_string(), "dshow".to_string(),
        "-i".to_string(), format!("video={}", video_device),
    ];
    args.extend(codec_args_for_ext(&form_data.file_ext));
    args.push("-y".to_string());
    args.push(path_to_str(output_path)?.to_string());

    let child = Command::new(&ffmpeg_path)
        .args(&args)
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
    let mut args: Vec<String> = vec![
        "-f".to_string(), "dshow".to_string(),
        "-i".to_string(), format!("audio={}", form_data.audio_device),
    ];
    // Previously had no codec flags at all - left to ffmpeg's per-container default, which for
    // .mp3 measured out to 128k, same gap as every other mode fixed above.
    args.extend(audio_codec_args_for_ext(&form_data.file_ext));
    args.extend(vec!["-af".to_string(), AUDIO_ENHANCE_FILTER.to_string()]);
    args.extend(vec!["-y".to_string(), path_to_str(output_path)?.to_string()]);

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

//Video and audio
pub async fn recording_with_output_va(app_handle: &AppHandle, state: State<'_, AppState>, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }

    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    log::debug!("Path {:?}", output_path);
    let video_device = form_data.video_devices.first().cloned().unwrap_or_default();

    let mut args: Vec<String> = vec![
        "-f".to_string(), "dshow".to_string(),
        "-i".to_string(), format!("video={}:audio={}", video_device, form_data.audio_device),
    ];
    args.extend(codec_args_for_ext(&form_data.file_ext));
    args.extend(vec!["-af".to_string(), AUDIO_ENHANCE_FILTER.to_string()]);
    args.push("-y".to_string());
    args.push(path_to_str(output_path)?.to_string());

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

//Screen only
pub async fn recording_with_output_s(app_handle: &AppHandle, state: State<'_, AppState>, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    let mut args: Vec<String> = vec!["-f".to_string(), "gdigrab".to_string(), "-framerate".to_string(), "200".to_string()];
    args.extend(gdigrab_input_args(&resolve_capture_target(app_handle, form_data))?);
    args.extend(vec!["-y".to_string(), path_to_str(output_path)?.to_string()]);

    log::debug!("Path {:?}", output_path);
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

// A real instant screenshot: `-frames:v 1` tells gdigrab/ffmpeg to grab exactly one frame and
// exit on its own, so this is a single .output() call (wait for the process to finish, done) —
// no AppState involvement, no ffmpeg_process to track, nothing for stop_recording to stop.
pub async fn take_screenshot(app_handle: &AppHandle, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let output_path = output_path.clone();
    let input_args = gdigrab_input_args(&resolve_capture_target(app_handle, form_data))?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["-f".to_string(), "gdigrab".to_string()];
        args.extend(input_args);
        args.extend(vec![
            "-frames:v".to_string(), "1".to_string(),
            "-y".to_string(),
            path_to_str(&output_path)?.to_string(),
        ]);

        // Not silent_command: that nulls stderr, which would throw away ffmpeg's actual error
        // text right when it's most useful (a failed capture) — hide_console_window alone gets
        // the "don't flash a console window" behavior without that tradeoff.
        let mut cmd = Command::new(&ffmpeg_path);
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        super::hide_console_window(&mut cmd);

        let output = cmd.output().map_err(|e| format!("Failed to capture screenshot: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Screenshot capture failed: {}", extract_ffmpeg_error(&stderr)));
        }

        Ok(format!("Screenshot saved to {}", output_path.display()))
    })
    .await
    .map_err(|e| format!("Screenshot task panicked: {}", e))?
}
