// commands/recording/macos.rs
//
// macOS recording backend: everything (screen, camera, microphone) goes through ffmpeg's
// `avfoundation` input device, which — unlike Windows' dshow — addresses devices by numeric
// index rather than name, and expects video+audio combined into a single `-i "VIDEO:AUDIO"`
// argument (either side can be left empty to omit that stream). `get_connected_devices` still
// hands the frontend device *names* (to match the existing contract get_connected_cameras/
// get_connected_audios expose), so every recording function here re-resolves the name it's
// handed back to the index avfoundation actually needs, at record-start time — if a device was
// unplugged/renamed since the list was last fetched, that lookup fails with a clear error rather
// than silently recording the wrong device.
//
// UNVERIFIED: written against documented avfoundation/ffmpeg behavior, not exercised on real
// hardware from this (Windows) environment — treat as a first draft and test on an actual Mac
// before relying on it.
use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, State};

use super::{codec_args_for_ext, extract_ffmpeg_error, get_overlay_position, get_overlay_shape, map_overlay_size, spawn_recording, AppState, FormData};
use crate::services::utility::{get_ffmpeg_path, path_to_str};

#[derive(Debug, Clone)]
pub(crate) struct AvDevice {
    pub(crate) index: u32,
    pub(crate) name: String,
}

// Parses `ffmpeg -f avfoundation -list_devices true -i ""`'s stderr, which looks like:
//   [AVFoundation indev @ 0x...] AVFoundation video devices:
//   [AVFoundation indev @ 0x...] [0] FaceTime HD Camera
//   [AVFoundation indev @ 0x...] [1] Capture screen 0
//   [AVFoundation indev @ 0x...] AVFoundation audio devices:
//   [AVFoundation indev @ 0x...] [0] MacBook Pro Microphone
pub(crate) fn list_avfoundation_devices(app_handle: &AppHandle) -> Result<(Vec<AvDevice>, Vec<AvDevice>), String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    // ffmpeg exits non-zero here (there's no real input, only a device listing was asked for) —
    // .output() rather than .status() is used specifically so that expected failure doesn't
    // stop us from reading stderr, which is where the actual device list was printed.
    let output = Command::new(&ffmpeg_path)
        .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    log::debug!("FFmpeg avfoundation device list: {}", stderr);

    let mut video = Vec::new();
    let mut audio = Vec::new();
    let mut in_video_section = false;
    let mut in_audio_section = false;

    for line in stderr.lines() {
        if line.contains("AVFoundation video devices") {
            in_video_section = true;
            in_audio_section = false;
            continue;
        }
        if line.contains("AVFoundation audio devices") {
            in_video_section = false;
            in_audio_section = true;
            continue;
        }
        if !in_video_section && !in_audio_section {
            continue;
        }

        // Device lines end in "] [<index>] <name>" — find the *last* "] [" so a name that
        // itself happens to contain "] [" can't confuse the split.
        let Some(bracket_start) = line.rfind("] [") else { continue };
        let rest = &line[bracket_start + 2..]; // "[0] FaceTime HD Camera"
        let Some(close) = rest.find(']') else { continue };
        let Ok(index) = rest[1..close].parse::<u32>() else { continue };
        let name = rest[close + 1..].trim().to_string();

        if in_video_section {
            video.push(AvDevice { index, name });
        } else {
            audio.push(AvDevice { index, name });
        }
    }

    Ok((video, audio))
}

pub fn get_connected_devices(app_handle: &AppHandle) -> (Vec<String>, Vec<String>) {
    match list_avfoundation_devices(app_handle) {
        Ok((video, audio)) => (
            video.into_iter().map(|d| d.name).collect(),
            audio.into_iter().map(|d| d.name).collect(),
        ),
        Err(e) => (vec![e.clone()], vec![e]),
    }
}

fn find_index(devices: &[AvDevice], name: &str) -> Option<u32> {
    devices.iter().find(|d| d.name == name).map(|d| d.index)
}

fn find_screen_index(devices: &[AvDevice]) -> Option<u32> {
    devices.iter().find(|d| d.name.starts_with("Capture screen")).map(|d| d.index)
}

// Builds avfoundation's "VIDEO:AUDIO" input spec — e.g. "1:0" (both), "1:" (video only), ":0"
// (audio only). Leaving a side empty tells avfoundation to omit that stream entirely.
fn av_input_spec(video_index: Option<u32>, audio_index: Option<u32>) -> String {
    format!(
        "{}:{}",
        video_index.map(|i| i.to_string()).unwrap_or_default(),
        audio_index.map(|i| i.to_string()).unwrap_or_default(),
    )
}

// Mirrors win.rs's add_overlay_args: the camera input carries both its video AND its paired
// microphone audio combined in one avfoundation input (just like dshow's "video=X:audio=Y") —
// so when this is used, ffmpeg auto-selects that as the sole audio stream (the screen input has
// none), no explicit -map needed.
fn add_camera_overlay_args(args: &mut Vec<String>, form_data: &FormData, camera_index: u32, audio_index: Option<u32>) {
    let overlay_size = map_overlay_size(&form_data.overlay_size);
    args.extend(vec![
        "-f".to_string(), "avfoundation".to_string(),
        "-video_size".to_string(), overlay_size,
        "-i".to_string(), av_input_spec(Some(camera_index), audio_index),
    ]);
    let overlay_filter = get_overlay_position(form_data.overlay_position.to_string());
    let filter_complex = get_overlay_shape(&form_data.overlay_shape, overlay_filter);
    args.extend(vec!["-filter_complex".to_string(), filter_complex]);
}

fn require_screen_index(video_devices: &[AvDevice]) -> Result<u32, String> {
    find_screen_index(video_devices)
        .ok_or_else(|| "No screen capture device found (expected a 'Capture screen N' entry from avfoundation)".to_string())
}

// Re-derives the avfoundation screen index a "monitor:monitor_<i>" screen_size value refers to,
// by position within the same filtered "Capture screen" list window_capture::macos::get_monitors
// builds its ids from (see that function's comment) - avfoundation captures a whole display
// directly, so all a Monitor selection actually needs to become is that device's own index.
fn resolve_screen_index(video_devices: &[AvDevice], monitor_id: &str) -> Option<u32> {
    let i: usize = monitor_id.strip_prefix("monitor_")?.parse().ok()?;
    video_devices
        .iter()
        .filter(|d| d.name.starts_with("Capture screen"))
        .nth(i)
        .map(|d| d.index)
}

// Resolves form_data.screen_size into the avfoundation screen index to actually pass to -i.
// Previously every screen-capturing function here ignored screen_size entirely (form_data was
// unused) and always grabbed require_screen_index's first screen - meaning picking a specific
// Monitor silently recorded/screenshotted the *wrong* one instead of the one actually selected.
// "window:..." isn't supported (see window_capture::macos's module comment for why) and errors
// clearly instead of falling back to some screen, which would be the same silent-wrong-capture
// bug in a different shape.
fn resolve_screen_target(video_devices: &[AvDevice], form_data: &FormData) -> Result<u32, String> {
    if form_data.screen_size.starts_with("window:") {
        return Err("Window-specific capture isn't implemented on macOS yet — pick Full Screen or a Monitor instead.".to_string());
    }
    if let Some(monitor_id) = form_data.screen_size.strip_prefix("monitor:") {
        return resolve_screen_index(video_devices, monitor_id)
            .ok_or_else(|| format!("Monitor '{}' not found", monitor_id));
    }
    require_screen_index(video_devices)
}

//Screen, optional camera overlay, and audio
pub async fn recording_with_output_sva(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let (video_devices, audio_devices) = list_avfoundation_devices(app_handle)?;
    let screen_index = resolve_screen_target(&video_devices, form_data)?;
    let audio_index = find_index(&audio_devices, &form_data.audio_device);

    let has_overlay = !form_data.overlay_shape.is_empty();
    let mut args: Vec<String> = vec![
        "-f".to_string(), "avfoundation".to_string(),
        "-capture_cursor".to_string(), "1".to_string(),
        "-framerate".to_string(), "30".to_string(),
        "-i".to_string(), av_input_spec(Some(screen_index), if has_overlay { None } else { audio_index }),
    ];

    if has_overlay {
        log::debug!("overlay is present");
        let camera_index = find_index(&video_devices, &form_data.video_device)
            .ok_or_else(|| format!("Camera '{}' not found", form_data.video_device))?;
        add_camera_overlay_args(&mut args, form_data, camera_index, audio_index);
    }

    args.extend(codec_args_for_ext(&form_data.file_ext));
    args.push(path_to_str(output_path)?.to_string());

    spawn_recording(&state, output_path, &ffmpeg_path, args).await
}

//Screen and video overlay, no audio — mirrors win.rs's recording_with_output_sv, which (like
// this one) is not currently reachable from the frontend (the UI's record-type options never
// send "sv"); kept only for parity with the dispatch table in the orchestrator.
pub async fn recording_with_output_sv(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let (video_devices, _audio_devices) = list_avfoundation_devices(app_handle)?;
    let screen_index = resolve_screen_target(&video_devices, form_data)?;

    let mut args: Vec<String> = vec![
        "-f".to_string(), "avfoundation".to_string(),
        "-framerate".to_string(), "30".to_string(),
        "-i".to_string(), av_input_spec(Some(screen_index), None),
    ];

    if !form_data.overlay_shape.is_empty() {
        let camera_index = find_index(&video_devices, &form_data.video_device)
            .ok_or_else(|| format!("Camera '{}' not found", form_data.video_device))?;
        add_camera_overlay_args(&mut args, form_data, camera_index, None);
    }

    args.extend(vec!["-c:v".to_string(), "mpeg4".to_string()]);
    args.push(path_to_str(output_path)?.to_string());

    spawn_recording(&state, output_path, &ffmpeg_path, args).await
}

//Screen and audio
pub async fn recording_with_output_sa(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let (video_devices, audio_devices) = list_avfoundation_devices(app_handle)?;
    let screen_index = resolve_screen_target(&video_devices, form_data)?;
    let audio_index = find_index(&audio_devices, &form_data.audio_device);

    let args: Vec<String> = vec![
        "-f".to_string(), "avfoundation".to_string(),
        "-capture_cursor".to_string(), "1".to_string(),
        "-framerate".to_string(), "30".to_string(),
        "-i".to_string(), av_input_spec(Some(screen_index), audio_index),
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ];

    spawn_recording(&state, output_path, &ffmpeg_path, args).await
}

//Video (camera) only
pub async fn recording_with_output_v(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let (video_devices, _audio_devices) = list_avfoundation_devices(app_handle)?;
    let camera_index = find_index(&video_devices, &form_data.video_device)
        .ok_or_else(|| format!("Camera '{}' not found", form_data.video_device))?;

    let args: Vec<String> = vec![
        "-f".to_string(), "avfoundation".to_string(),
        "-i".to_string(), av_input_spec(Some(camera_index), None),
        "-c:v".to_string(), "mpeg4".to_string(),
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ];

    spawn_recording(&state, output_path, &ffmpeg_path, args).await
}

//Audio only
pub async fn recording_with_output_a(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let (_video_devices, audio_devices) = list_avfoundation_devices(app_handle)?;
    let audio_index = find_index(&audio_devices, &form_data.audio_device)
        .ok_or_else(|| format!("Audio device '{}' not found", form_data.audio_device))?;

    let args: Vec<String> = vec![
        "-f".to_string(), "avfoundation".to_string(),
        "-i".to_string(), av_input_spec(None, Some(audio_index)),
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ];

    spawn_recording(&state, output_path, &ffmpeg_path, args).await
}

//Video (camera) and audio
pub async fn recording_with_output_va(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let (video_devices, audio_devices) = list_avfoundation_devices(app_handle)?;
    let camera_index = find_index(&video_devices, &form_data.video_device)
        .ok_or_else(|| format!("Camera '{}' not found", form_data.video_device))?;
    let audio_index = find_index(&audio_devices, &form_data.audio_device);

    let args: Vec<String> = vec![
        "-f".to_string(), "avfoundation".to_string(),
        "-i".to_string(), av_input_spec(Some(camera_index), audio_index),
        "-c:v".to_string(), "mpeg4".to_string(),
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ];

    spawn_recording(&state, output_path, &ffmpeg_path, args).await
}

//Screen only
pub async fn recording_with_output_s(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let (video_devices, _audio_devices) = list_avfoundation_devices(app_handle)?;
    let screen_index = resolve_screen_target(&video_devices, form_data)?;

    let args: Vec<String> = vec![
        "-f".to_string(), "avfoundation".to_string(),
        "-capture_cursor".to_string(), "1".to_string(),
        "-framerate".to_string(), "30".to_string(),
        "-i".to_string(), av_input_spec(Some(screen_index), None),
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ];

    spawn_recording(&state, output_path, &ffmpeg_path, args).await
}

// A real instant screenshot: `-frames:v 1` tells ffmpeg to grab exactly one frame and exit on
// its own, so this is a single .output() call — no AppState involvement, no ffmpeg_process to
// track, nothing for stop_recording to stop. Replaces what used to be recording_with_output_c, a
// continuous screen recording started/stopped exactly like every other mode despite the
// "Screenshot" label the frontend showed for this record type — the same bug win.rs had.
pub async fn take_screenshot(app_handle: &AppHandle, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let (video_devices, _audio_devices) = list_avfoundation_devices(app_handle)?;
    let screen_index = resolve_screen_target(&video_devices, form_data)?;
    let output_path = output_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let args: Vec<String> = vec![
            "-f".to_string(), "avfoundation".to_string(),
            "-capture_cursor".to_string(), "1".to_string(),
            "-i".to_string(), av_input_spec(Some(screen_index), None),
            "-frames:v".to_string(), "1".to_string(),
            "-y".to_string(),
            path_to_str(&output_path)?.to_string(),
        ];

        let output = Command::new(&ffmpeg_path)
            .args(&args)
            .output()
            .map_err(|e| format!("Failed to capture screenshot: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Screenshot capture failed: {}", extract_ffmpeg_error(&stderr)));
        }

        Ok(format!("Screenshot saved to {}", output_path.display()))
    })
    .await
    .map_err(|e| format!("Screenshot task panicked: {}", e))?
}
