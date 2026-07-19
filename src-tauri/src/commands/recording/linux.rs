// commands/recording/linux.rs
//
// Linux recording backend: screen via ffmpeg's `x11grab` (X11 — including XWayland on most
// Wayland desktops; a compositor running "pure" Wayland with no XWayland has no equivalent here
// and would need a portal-based capture path instead, which this doesn't implement), microphone
// via PulseAudio (`-f pulse`, which also transparently covers PipeWire systems through
// pipewire-pulse), and camera via Video4Linux2 (`-f v4l2`).
//
// Unlike Windows/macOS, a PulseAudio source *name* (from `pactl list short sources`) is exactly
// what ffmpeg's `-f pulse -i <name>` wants — no index/path resolution needed, so audio device
// names are passed straight through, same as how dshow names are used as-is on Windows. v4l2,
// though, needs a /dev/videoN *path*, not a name — get_connected_cameras only ever hands the
// frontend a name, so every function here re-resolves that name back to a device path at
// record-start time; if the camera was unplugged/renumbered since the list was last fetched,
// that lookup fails with a clear error rather than silently recording the wrong device.
//
// UNVERIFIED: written against documented x11grab/pulse/v4l2 ffmpeg behavior, not exercised on
// real hardware from this (Windows) environment — treat as a first draft and test on a real
// Linux box (ideally both an X11 session and an XWayland/Wayland one) before relying on it.
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, State};

use super::{
    codec_args_for_ext, extract_ffmpeg_error, get_overlay_position, get_overlay_shape,
    map_overlay_size, resolve_capture_target, spawn_recording, AppState, CaptureTarget, FormData,
};
use crate::services::utility::{get_ffmpeg_path, path_to_str};

fn x11_display() -> String {
    env::var("DISPLAY").unwrap_or_else(|_| ":0.0".to_string())
}

// Resolves a CaptureTarget into x11grab's -video_size/-i arguments, mirroring win.rs's
// gdigrab_input_args. Unlike gdigrab's separate -offset_x/-offset_y flags, x11grab's offset
// lives right in the -i string itself (":D.S+X,Y") — same crop-the-desktop-grab shape of
// solution as Windows, since x11grab reading a specific window's own pixels isn't reliable
// either (a compositor's final on-screen output is what needs capturing, not necessarily
// whatever the window's own backing buffer holds).
//
// This also fixes a real, pre-existing bug: the code this replaces passed `form_data.screen_size`
// itself straight through as literal ffmpeg -video_size text, which is only ever a valid "WxH"
// string for the fullscreen case — for "monitor:monitor_0" or "window:12345" it handed ffmpeg
// outright invalid syntax. win.rs had - and fixed - the exact same bug; this was never fixed here.
fn x11grab_input_args(target: &CaptureTarget) -> Result<Vec<String>, String> {
    match target {
        CaptureTarget::FullScreen => Ok(vec!["-i".to_string(), x11_display()]),
        CaptureTarget::Monitor { x, y, width, height } => Ok(vec![
            "-video_size".to_string(), format!("{}x{}", width, height),
            "-i".to_string(), format!("{}+{},{}", x11_display(), x, y),
        ]),
        CaptureTarget::Window { title } => {
            let (x, y, width, height) = crate::commands::window_capture::linux::get_window_rect_by_title(title)?;
            Ok(vec![
                "-video_size".to_string(), format!("{}x{}", width, height),
                "-i".to_string(), format!("{}+{},{}", x11_display(), x, y),
            ])
        }
    }
}

// PulseAudio (and PipeWire's pulse-compatibility shim) source names — this list includes both
// real input devices (microphones) and ".monitor" sources, which is deliberate: a monitor source
// is how you record whatever's currently playing through an output device, and hiding those
// would remove the only way to capture system/app audio on Linux.
fn list_pulse_sources() -> Result<Vec<String>, String> {
    let output = Command::new("pactl")
        .args(["list", "short", "sources"])
        .output()
        .map_err(|e| format!("Failed to list audio sources (is PulseAudio/pipewire-pulse installed?): {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let sources: Vec<String> = stdout
        .lines()
        .filter_map(|line| line.split('\t').nth(1))
        .map(|name| name.to_string())
        .collect();

    Ok(sources)
}

// Video4Linux2 exposes every camera under /sys/class/video4linux/videoN, each with a sibling
// `name` file holding its human-readable label — reading that avoids depending on an external
// tool like v4l2-ctl just to enumerate devices.
//
// Known limitation: a single physical camera can expose more than one /dev/videoN node (e.g. one
// for actual capture, one for metadata) which this doesn't try to distinguish — a proper fix
// needs a VIDIOC_QUERYCAP ioctl to check which nodes actually support capture, which isn't worth
// pulling in a new dependency for on a code path nobody's been able to test yet.
fn list_v4l2_devices() -> Result<Vec<(String, String)>, String> {
    let sysfs = PathBuf::from("/sys/class/video4linux");
    let entries = fs::read_dir(&sysfs).map_err(|e| format!("Failed to list video devices: {}", e))?;

    let mut devices = Vec::new();
    for entry in entries.flatten() {
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let name_path = entry.path().join("name");
        let Ok(name) = fs::read_to_string(&name_path) else { continue };
        devices.push((format!("/dev/{}", dir_name), name.trim().to_string()));
    }

    Ok(devices)
}

fn find_v4l2_path(devices: &[(String, String)], name: &str) -> Option<String> {
    devices.iter().find(|(_, n)| n == name).map(|(path, _)| path.clone())
}

pub fn get_connected_devices(_app_handle: &AppHandle) -> (Vec<String>, Vec<String>) {
    let video = match list_v4l2_devices() {
        Ok(devices) => devices.into_iter().map(|(_, name)| name).collect(),
        Err(e) => vec![e],
    };
    let audio = match list_pulse_sources() {
        Ok(sources) => sources,
        Err(e) => vec![e],
    };
    (video, audio)
}

fn require_v4l2_path(name: &str) -> Result<String, String> {
    let devices = list_v4l2_devices()?;
    find_v4l2_path(&devices, name).ok_or_else(|| format!("Camera '{}' not found", name))
}

// Screen (x11grab) + optional camera overlay (v4l2), composited exactly like win.rs's
// add_overlay_args — same shared filter-graph builders, just fed x11grab/v4l2 inputs instead of
// gdigrab/dshow ones.
fn add_camera_overlay_args(args: &mut Vec<String>, form_data: &FormData, camera_path: &str) {
    let overlay_size = map_overlay_size(&form_data.overlay_size);
    args.extend(vec![
        "-f".to_string(), "v4l2".to_string(),
        "-video_size".to_string(), overlay_size,
        "-i".to_string(), camera_path.to_string(),
    ]);
    let overlay_filter = get_overlay_position(form_data.overlay_position.to_string());
    let filter_complex = get_overlay_shape(&form_data.overlay_shape, overlay_filter);
    args.extend(vec!["-filter_complex".to_string(), filter_complex]);
}

//Screen, optional camera overlay, and audio
pub async fn recording_with_output_sva(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    let mut args: Vec<String> = vec![
        "-f".to_string(), "x11grab".to_string(),
        "-framerate".to_string(), "30".to_string(),
    ];
    args.extend(x11grab_input_args(&resolve_capture_target(app_handle, form_data))?);

    let has_overlay = !form_data.overlay_shape.is_empty();
    if has_overlay {
        log::debug!("overlay is present");
        let camera_path = require_v4l2_path(&form_data.video_device)?;
        add_camera_overlay_args(&mut args, form_data, &camera_path);
        // Pulse can't be bundled into the screen or camera input the way avfoundation/dshow
        // combine video+audio in one -i — it's always its own input on Linux. With
        // filter_complex already in play for the video composite, the output stream selection
        // is made explicit here (rather than relying on ffmpeg's default auto-selection, which
        // is a needless ambiguity to leave in place once there are two video-capable inputs)
        // by labeling the filtergraph's output and mapping both it and the audio input in.
        if let Some(filter_complex_value) = args.last_mut() {
            filter_complex_value.push_str("[vout]");
        }
        args.extend(vec![
            "-f".to_string(), "pulse".to_string(),
            "-i".to_string(), form_data.audio_device.clone(),
            "-map".to_string(), "[vout]".to_string(),
            "-map".to_string(), "2:a".to_string(),
        ]);
    } else {
        args.extend(vec![
            "-f".to_string(), "pulse".to_string(),
            "-i".to_string(), form_data.audio_device.clone(),
        ]);
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

    let mut args: Vec<String> = vec![
        "-f".to_string(), "x11grab".to_string(),
        "-framerate".to_string(), "30".to_string(),
    ];
    args.extend(x11grab_input_args(&resolve_capture_target(app_handle, form_data))?);

    if !form_data.overlay_shape.is_empty() {
        let camera_path = require_v4l2_path(&form_data.video_device)?;
        add_camera_overlay_args(&mut args, form_data, &camera_path);
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

    let mut args: Vec<String> = vec![
        "-f".to_string(), "x11grab".to_string(),
        "-framerate".to_string(), "30".to_string(),
    ];
    args.extend(x11grab_input_args(&resolve_capture_target(app_handle, form_data))?);
    args.extend(vec![
        "-f".to_string(), "pulse".to_string(),
        "-i".to_string(), form_data.audio_device.clone(),
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
    let camera_path = require_v4l2_path(&form_data.video_device)?;

    let args: Vec<String> = vec![
        "-f".to_string(), "v4l2".to_string(),
        "-i".to_string(), camera_path,
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

    let args: Vec<String> = vec![
        "-f".to_string(), "pulse".to_string(),
        "-i".to_string(), form_data.audio_device.clone(),
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
    let camera_path = require_v4l2_path(&form_data.video_device)?;

    // v4l2 and pulse can't be combined into one -i (unlike dshow/avfoundation) — two separate
    // inputs, one video-only stream and one audio-only stream, which ffmpeg's default stream
    // selection maps unambiguously since each type has exactly one candidate.
    let args: Vec<String> = vec![
        "-f".to_string(), "v4l2".to_string(),
        "-i".to_string(), camera_path,
        "-f".to_string(), "pulse".to_string(),
        "-i".to_string(), form_data.audio_device.clone(),
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

    let mut args: Vec<String> = vec![
        "-f".to_string(), "x11grab".to_string(),
        "-framerate".to_string(), "30".to_string(),
    ];
    args.extend(x11grab_input_args(&resolve_capture_target(app_handle, form_data))?);
    args.push("-y".to_string());
    args.push(path_to_str(output_path)?.to_string());

    spawn_recording(&state, output_path, &ffmpeg_path, args).await
}

// A real instant screenshot: `-frames:v 1` tells ffmpeg to grab exactly one frame and exit on
// its own, so this is a single .output() call — no AppState involvement, no ffmpeg_process to
// track, nothing for stop_recording to stop. Replaces what used to be recording_with_output_c, a
// continuous screen recording started/stopped exactly like every other mode despite the
// "Screenshot" label the frontend showed for this record type — the same bug win.rs had.
pub async fn take_screenshot(app_handle: &AppHandle, output_path: &PathBuf, form_data: &FormData) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let output_path = output_path.clone();
    let input_args = x11grab_input_args(&resolve_capture_target(app_handle, form_data))?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["-f".to_string(), "x11grab".to_string()];
        args.extend(input_args);
        args.extend(vec![
            "-frames:v".to_string(), "1".to_string(),
            "-y".to_string(),
            path_to_str(&output_path)?.to_string(),
        ]);

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
