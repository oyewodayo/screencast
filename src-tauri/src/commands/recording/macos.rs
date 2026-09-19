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

use super::{
    build_camera_overlay_filter_complex, codec_args_for_ext, extract_ffmpeg_error,
    map_overlay_size, spawn_recording, AppState, FormData, MAX_RECORDING_WIDTH,
};
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
pub(crate) fn list_avfoundation_devices(
    app_handle: &AppHandle,
) -> Result<(Vec<AvDevice>, Vec<AvDevice>), String> {
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
        let Some(bracket_start) = line.rfind("] [") else {
            continue;
        };
        let rest = &line[bracket_start + 2..]; // "[0] FaceTime HD Camera"
        let Some(close) = rest.find(']') else {
            continue;
        };
        let Ok(index) = rest[1..close].parse::<u32>() else {
            continue;
        };
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
    devices
        .iter()
        .find(|d| d.name.starts_with("Capture screen"))
        .map(|d| d.index)
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

// Adds one video-only avfoundation input per selected camera - mirrors win.rs's add_overlay_args
// for dshow, including deliberately NOT bundling mic audio into any of these inputs the way
// av_input_spec normally would (that only ever made sense for exactly one camera): with N cameras
// each occupying its own video-only input, build_camera_overlay_filter_complex's [1:v]..[N:v]
// indexing lines up regardless of camera count, and callers add mic audio as its own separate
// input afterward. `crop` is Some only for a window-capture target - see
// build_camera_overlay_filter_complex's own doc comment for why cropping has to be baked into
// this same filter_complex rather than a separate -vf.
fn add_camera_overlay_args(
    args: &mut Vec<String>,
    form_data: &FormData,
    video_devices: &[AvDevice],
    crop: Option<(i32, i32, i32, i32)>,
) -> Result<(), String> {
    let overlay_size = map_overlay_size(&form_data.overlay_size);

    for device in &form_data.video_devices {
        let index = find_index(video_devices, device)
            .ok_or_else(|| format!("Camera '{}' not found", device))?;
        args.extend(vec![
            "-f".to_string(),
            "avfoundation".to_string(),
            "-video_size".to_string(),
            overlay_size.clone(),
            "-i".to_string(),
            av_input_spec(Some(index), None),
        ]);
    }

    let filter_complex = build_camera_overlay_filter_complex(
        &form_data.overlay_shape,
        &form_data.overlay_position,
        &form_data.overlay_size,
        form_data.video_devices.len(),
        MAX_RECORDING_WIDTH,
        crop.map(|(x, y, w, h)| (w, h, x, y)),
    );
    args.extend(vec!["-filter_complex".to_string(), filter_complex]);
    Ok(())
}

// Common, well-known virtual-audio-loopback device names, checked in roughly descending order of
// real-world prevalence so the first one actually installed wins. macOS has no built-in system-
// audio loopback the way Windows (WASAPI) or Linux (a PulseAudio monitor source) do, and
// avfoundation itself cannot record "what you hear" from a real output device at all - genuine
// loopback capture here needs either a virtual audio device rerouting output back as an input
// (this), or ScreenCaptureKit's own audio-capture API (macOS 13+), which would need real Swift/
// Objective-C integration well beyond what a pass with no way to compile or test macOS-specific
// code should attempt (see window_capture::macos's own module comment on why raw FFI is avoided
// here generally). If the user already has one of these installed - a common, well-known
// workaround plenty of existing macOS recording tools also lean on for exactly this reason - it's
// picked up automatically; if not, include_system_audio just doesn't add anything, the same
// "best effort, silently proceed without it" fallback Windows' own loopback capture already has
// for its own failure cases (see services/loopback_audio.rs).
const KNOWN_LOOPBACK_AUDIO_DEVICES: &[&str] = &[
    "BlackHole 2ch",
    "BlackHole 16ch",
    "BlackHole 64ch",
    "Loopback Audio",
    "Soundflower (2ch)",
    "Soundflower (64ch)",
];

fn detect_system_audio_device(audio_devices: &[AvDevice]) -> Option<&AvDevice> {
    KNOWN_LOOPBACK_AUDIO_DEVICES
        .iter()
        .find_map(|&known| audio_devices.iter().find(|d| d.name == known))
}

// Builds the -i/-filter_complex/-map args for a plain screen capture (no camera overlay) with an
// optional window-crop and/or system-audio mix - recording_with_output_sva's own no-camera-overlay
// path, recording_with_output_sa, and recording_with_output_s all reduce to exactly this same
// problem once a camera overlay isn't in the picture, so it's written once here. `mic_index` is
// None for the modes with no microphone input at all (recording_with_output_s).
fn screen_capture_args(
    screen_index: u32,
    crop: Option<(i32, i32, i32, i32)>,
    mic_index: Option<u32>,
    system_audio_index: Option<u32>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-f".to_string(),
        "avfoundation".to_string(),
        "-capture_cursor".to_string(),
        "1".to_string(),
        "-framerate".to_string(),
        "30".to_string(),
        "-i".to_string(),
        av_input_spec(
            Some(screen_index),
            if system_audio_index.is_some() {
                None
            } else {
                mic_index
            },
        ),
    ];

    let Some(sys_index) = system_audio_index else {
        // No system audio to mix in - mic (if any) already travels with the screen's own input
        // above (av_input_spec, right above); only a crop, if any, is still needed.
        if let Some((x, y, w, h)) = crop {
            args.extend(vec![
                "-vf".to_string(),
                format!("crop={}:{}:{}:{}", w, h, x, y),
            ]);
        }
        return args;
    };

    let mic_input_idx: Option<u32> = if let Some(index) = mic_index {
        args.extend(vec![
            "-f".to_string(),
            "avfoundation".to_string(),
            "-i".to_string(),
            av_input_spec(None, Some(index)),
        ]);
        Some(1)
    } else {
        None
    };
    args.extend(vec![
        "-f".to_string(),
        "avfoundation".to_string(),
        "-i".to_string(),
        av_input_spec(None, Some(sys_index)),
    ]);
    let system_input_idx = if mic_input_idx.is_some() { 2 } else { 1 };

    let video_label = if let Some((x, y, w, h)) = crop {
        args.extend(vec![
            "-filter_complex".to_string(),
            format!("[0:v]crop={}:{}:{}:{}[vout]", w, h, x, y),
        ]);
        "[vout]".to_string()
    } else {
        "0:v".to_string()
    };

    let audio_filter = match mic_input_idx {
        Some(mic) => format!(
            "[{}:a][{}:a]amix=inputs=2:duration=first[aout]",
            mic, system_input_idx
        ),
        // A single source still needs to land on the same [aout] label the -map below expects,
        // even with nothing to actually mix - `anull` is a plain passthrough for exactly that.
        None => format!("[{}:a]anull[aout]", system_input_idx),
    };

    // ffmpeg accepts only one -filter_complex per invocation - append rather than add a second
    // one when the crop stage above already opened one, same multi-stage-chain convention
    // build_camera_overlay_filter_complex's own "; "-joined stages use.
    if crop.is_some() {
        let last = args.len() - 1;
        args[last] = format!("{}; {}", args[last], audio_filter);
    } else {
        args.extend(vec!["-filter_complex".to_string(), audio_filter]);
    }

    args.extend(vec![
        "-map".to_string(),
        video_label,
        "-map".to_string(),
        "[aout]".to_string(),
    ]);

    args
}

fn require_screen_index(video_devices: &[AvDevice]) -> Result<u32, String> {
    find_screen_index(video_devices).ok_or_else(|| {
        "No screen capture device found (expected a 'Capture screen N' entry from avfoundation)"
            .to_string()
    })
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

// Resolves form_data.screen_size into (the avfoundation screen index to actually pass to -i, an
// optional (x, y, width, height) crop rect to apply afterward). Previously every screen-capturing
// function here ignored screen_size entirely (form_data was unused) and always grabbed
// require_screen_index's first screen - meaning picking a specific Monitor silently recorded/
// screenshotted the *wrong* one instead of the one actually selected.
//
// "window:..." now crops a full-display capture down to the target window instead of erroring -
// avfoundation has no per-window capture mode at all, so this is the only way to record just one
// window (see window_capture::macos::get_window_rect_by_title's own doc comment, including its
// multi-monitor caveat). Always captures require_screen_index's first screen (the primary
// display's own avfoundation device) for a window target specifically - that's the one case the
// caveat doesn't bite, since macOS's global coordinate origin coincides with the primary
// display's own top-left.
fn resolve_screen_target(
    video_devices: &[AvDevice],
    form_data: &FormData,
) -> Result<(u32, Option<(i32, i32, i32, i32)>), String> {
    if let Some(title) = form_data.screen_size.strip_prefix("window:") {
        let title = if form_data.window_title.is_empty() {
            title
        } else {
            &form_data.window_title
        };
        let rect = crate::commands::window_capture::macos::get_window_rect_by_title(title)?;
        return Ok((require_screen_index(video_devices)?, Some(rect)));
    }
    if let Some(monitor_id) = form_data.screen_size.strip_prefix("monitor:") {
        return resolve_screen_index(video_devices, monitor_id)
            .map(|i| (i, None))
            .ok_or_else(|| format!("Monitor '{}' not found", monitor_id));
    }
    Ok((require_screen_index(video_devices)?, None))
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
    let (screen_index, crop) = resolve_screen_target(&video_devices, form_data)?;
    let audio_index = find_index(&audio_devices, &form_data.audio_device);
    let has_camera_overlay = !form_data.video_devices.is_empty();
    // See detect_system_audio_device's own doc comment for why this can't just always work the
    // way it does on Windows/Linux. Skipped entirely alongside a camera overlay - mixing a THIRD
    // source (mic + system audio) into an already-composited camera-overlay filter_complex is a
    // rare enough combination that it's not worth the added risk in a pass with no way to test any
    // of it; falls back to mic-only, same as if no loopback device had been found at all.
    let system_audio_index = if form_data.include_system_audio && !has_camera_overlay {
        match detect_system_audio_device(&audio_devices) {
            Some(d) => Some(d.index),
            None => {
                log::warn!("include_system_audio was requested but no known loopback device (BlackHole/Loopback/Soundflower) was found - recording without system audio");
                None
            }
        }
    } else {
        if form_data.include_system_audio && has_camera_overlay {
            log::warn!("include_system_audio isn't supported together with a camera overlay on macOS yet - recording with mic audio only");
        }
        None
    };

    let mut args = if has_camera_overlay {
        let mut args: Vec<String> = vec![
            "-f".to_string(),
            "avfoundation".to_string(),
            "-capture_cursor".to_string(),
            "1".to_string(),
            "-framerate".to_string(),
            "30".to_string(),
            "-i".to_string(),
            av_input_spec(Some(screen_index), None),
        ];
        log::debug!("{} camera(s) overlaid", form_data.video_devices.len());
        add_camera_overlay_args(&mut args, form_data, &video_devices, crop)?;
        // The screen input above was left audio-less (its side of av_input_spec was None) so the
        // mic gets its own dedicated input instead - same reasoning as win.rs's sva mode keeping
        // camera and audio as separate dshow inputs rather than trying to bundle mic audio onto
        // whichever camera happens to be first.
        if let Some(index) = audio_index {
            args.extend(vec![
                "-f".to_string(),
                "avfoundation".to_string(),
                "-i".to_string(),
                av_input_spec(None, Some(index)),
            ]);
        }
        args
    } else {
        screen_capture_args(screen_index, crop, audio_index, system_audio_index)
    };

    args.extend(codec_args_for_ext(&form_data.file_ext));
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
    let (screen_index, crop) = resolve_screen_target(&video_devices, form_data)?;
    let audio_index = find_index(&audio_devices, &form_data.audio_device);
    let system_audio_index = if form_data.include_system_audio {
        match detect_system_audio_device(&audio_devices) {
            Some(d) => Some(d.index),
            None => {
                log::warn!("include_system_audio was requested but no known loopback device (BlackHole/Loopback/Soundflower) was found - recording without system audio");
                None
            }
        }
    } else {
        None
    };

    let mut args = screen_capture_args(screen_index, crop, audio_index, system_audio_index);
    args.extend(vec![
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ]);

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
    // Standalone video recording (no screen) only ever uses one camera, same as win.rs's own
    // recording_with_output_v - multi-camera only applies to the overlay-onto-screen modes above.
    let video_device = form_data.video_devices.first().cloned().unwrap_or_default();
    let camera_index = find_index(&video_devices, &video_device)
        .ok_or_else(|| format!("Camera '{}' not found", video_device))?;

    let args: Vec<String> = vec![
        "-f".to_string(),
        "avfoundation".to_string(),
        "-i".to_string(),
        av_input_spec(Some(camera_index), None),
        "-c:v".to_string(),
        "mpeg4".to_string(),
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
        "-f".to_string(),
        "avfoundation".to_string(),
        "-i".to_string(),
        av_input_spec(None, Some(audio_index)),
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
    // Same single-camera restriction as recording_with_output_v above.
    let video_device = form_data.video_devices.first().cloned().unwrap_or_default();
    let camera_index = find_index(&video_devices, &video_device)
        .ok_or_else(|| format!("Camera '{}' not found", video_device))?;
    let audio_index = find_index(&audio_devices, &form_data.audio_device);

    let args: Vec<String> = vec![
        "-f".to_string(),
        "avfoundation".to_string(),
        "-i".to_string(),
        av_input_spec(Some(camera_index), audio_index),
        "-c:v".to_string(),
        "mpeg4".to_string(),
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
    let (video_devices, audio_devices) = list_avfoundation_devices(app_handle)?;
    let (screen_index, crop) = resolve_screen_target(&video_devices, form_data)?;
    // No mic in this mode at all (screen only) - system audio, if requested and found, becomes
    // the sole audio track rather than something to mix.
    let system_audio_index = if form_data.include_system_audio {
        match detect_system_audio_device(&audio_devices) {
            Some(d) => Some(d.index),
            None => {
                log::warn!("include_system_audio was requested but no known loopback device (BlackHole/Loopback/Soundflower) was found - recording without system audio");
                None
            }
        }
    } else {
        None
    };

    let mut args = screen_capture_args(screen_index, crop, None, system_audio_index);
    args.extend(vec![
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ]);

    spawn_recording(&state, output_path, &ffmpeg_path, args).await
}

// A real instant screenshot: `-frames:v 1` tells ffmpeg to grab exactly one frame and exit on
// its own, so this is a single .output() call — no AppState involvement, no ffmpeg_process to
// track, nothing for stop_recording to stop. Replaces what used to be recording_with_output_c, a
// continuous screen recording started/stopped exactly like every other mode despite the
// "Screenshot" label the frontend showed for this record type — the same bug win.rs had.
pub async fn take_screenshot(
    app_handle: &AppHandle,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let (video_devices, _audio_devices) = list_avfoundation_devices(app_handle)?;
    let (screen_index, crop) = resolve_screen_target(&video_devices, form_data)?;
    let output_path = output_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec![
            "-f".to_string(),
            "avfoundation".to_string(),
            "-capture_cursor".to_string(),
            "1".to_string(),
            "-i".to_string(),
            av_input_spec(Some(screen_index), None),
        ];
        if let Some((x, y, w, h)) = crop {
            args.extend(vec![
                "-vf".to_string(),
                format!("crop={}:{}:{}:{}", w, h, x, y),
            ]);
        }
        args.extend(vec![
            "-frames:v".to_string(),
            "1".to_string(),
            "-y".to_string(),
            path_to_str(&output_path)?.to_string(),
        ]);

        let output = Command::new(&ffmpeg_path)
            .args(&args)
            .output()
            .map_err(|e| format!("Failed to capture screenshot: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Screenshot capture failed: {}",
                extract_ffmpeg_error(&stderr)
            ));
        }

        Ok(format!("Screenshot saved to {}", output_path.display()))
    })
    .await
    .map_err(|e| format!("Screenshot task panicked: {}", e))?
}

// Pauses/resumes every thread in the ffmpeg process at once via the standard POSIX job-control
// signals - the direct macOS/Linux equivalent of win.rs's per-thread SuspendThread/ResumeThread
// loop (Windows has no single "pause a process" signal, so it has to approximate this by hand;
// SIGSTOP/SIGCONT already do exactly this natively). Shelling out to `kill` rather than adding a
// libc dependency just for two syscalls this codebase otherwise has no other use for.
pub(crate) fn suspend_process(pid: u32) -> Result<(), String> {
    Command::new("kill")
        .args(["-STOP", &pid.to_string()])
        .status()
        .map_err(|e| format!("Failed to pause recording: {}", e))
        .and_then(|status| {
            status.success().then_some(()).ok_or_else(|| {
                "Failed to pause recording: kill -STOP exited with an error".to_string()
            })
        })
}

pub(crate) fn resume_process(pid: u32) -> Result<(), String> {
    Command::new("kill")
        .args(["-CONT", &pid.to_string()])
        .status()
        .map_err(|e| format!("Failed to resume recording: {}", e))
        .and_then(|status| {
            status.success().then_some(()).ok_or_else(|| {
                "Failed to resume recording: kill -CONT exited with an error".to_string()
            })
        })
}
