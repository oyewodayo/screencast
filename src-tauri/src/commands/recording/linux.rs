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
    build_camera_overlay_filter_complex, codec_args_for_ext, extract_ffmpeg_error,
    map_overlay_size, resolve_capture_target, spawn_recording, AppState, CaptureTarget, FormData,
    MAX_RECORDING_WIDTH,
};
use crate::services::utility::{get_ffmpeg_path, path_to_str};

fn x11_display() -> String {
    env::var("DISPLAY").unwrap_or_else(|_| ":0.0".to_string())
}

// A "pure" Wayland session (no XWayland compatibility layer running) has no X11 display for
// x11grab to attach to at all - detected via the standard Wayland/X11 session environment
// variables rather than letting the actual x11grab invocation fail partway through with a cryptic
// ffmpeg error (or, worse, silently produce a black recording). WAYLAND_DISPLAY is set on
// essentially every Wayland session; DISPLAY is what XWayland (present on most, but not
// necessarily all, Wayland desktops) sets up specifically so X11-only apps like ffmpeg's x11grab
// still work there - its absence is what actually signals no X11 path exists at all. Camera/audio-
// only recording (v4l2/pulse) doesn't go through this at all, so it stays unaffected either way.
fn require_x11_display() -> Result<(), String> {
    if env::var("WAYLAND_DISPLAY").is_ok() && env::var("DISPLAY").is_err() {
        return Err(
            "This desktop is running Wayland without XWayland, which x11grab (this app's Linux \
             screen-capture method) can't attach to - screen recording isn't available on a pure \
             Wayland session yet. Camera/audio-only recording is unaffected."
                .to_string(),
        );
    }
    Ok(())
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
    require_x11_display()?;
    match target {
        CaptureTarget::FullScreen => Ok(vec!["-i".to_string(), x11_display()]),
        CaptureTarget::Monitor {
            x,
            y,
            width,
            height,
        } => Ok(vec![
            "-video_size".to_string(),
            format!("{}x{}", width, height),
            "-i".to_string(),
            format!("{}+{},{}", x11_display(), x, y),
        ]),
        CaptureTarget::Window { title } => {
            let (x, y, width, height) =
                crate::commands::window_capture::linux::get_window_rect_by_title(title)?;
            Ok(vec![
                "-video_size".to_string(),
                format!("{}x{}", width, height),
                "-i".to_string(),
                format!("{}+{},{}", x11_display(), x, y),
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
        .map_err(|e| {
            format!(
                "Failed to list audio sources (is PulseAudio/pipewire-pulse installed?): {}",
                e
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let sources: Vec<String> = stdout
        .lines()
        .filter_map(|line| line.split('\t').nth(1))
        .map(|name| name.to_string())
        .collect();

    Ok(sources)
}

// PulseAudio's own convention for "what you hear" - the monitor source of the current default
// sink (output device), auto-selected via `pactl get-default-sink` rather than requiring the user
// to dig through list_pulse_sources' own output and manually pick out the "*.monitor" entry
// themselves (still possible - that's what the doc comment there is about; this is the same
// include_system_audio checkbox Windows/macOS already have, automated). Unlike Windows (no
// built-in loopback at all, needs its own WASAPI capture thread + post-record mux - see
// services/loopback_audio.rs) a monitor source is already just another ffmpeg-recordable
// `-f pulse -i <name>` input, live-mixed with the mic rather than needing any separate capture
// mechanism or post-processing pass.
fn default_monitor_source() -> Option<String> {
    let output = Command::new("pactl").args(["get-default-sink"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let sink = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sink.is_empty() {
        return None;
    }
    Some(format!("{}.monitor", sink))
}

fn resolve_system_audio_source(form_data: &FormData) -> Option<String> {
    if !form_data.include_system_audio {
        return None;
    }
    match default_monitor_source() {
        Some(source) => Some(source),
        None => {
            log::warn!("include_system_audio was requested but no default PulseAudio sink could be determined - recording without system audio");
            None
        }
    }
}

// Builds a plain (no camera overlay) screen capture's audio args: mic alone, the system-audio
// monitor source alone, both mixed live via amix, or neither at all - covers
// recording_with_output_sva's own no-camera-overlay path and recording_with_output_sa.
// `next_input_index` is 1 in both callers (only the screen input precedes audio there).
fn plain_audio_args(args: &mut Vec<String>, form_data: &FormData, next_input_index: usize) {
    let has_mic = !form_data.audio_device.is_empty();
    let system_source = resolve_system_audio_source(form_data);

    match (has_mic, system_source) {
        (false, None) => {}
        (true, None) => {
            args.extend(vec![
                "-f".to_string(),
                "pulse".to_string(),
                "-i".to_string(),
                form_data.audio_device.clone(),
            ]);
        }
        (false, Some(source)) => {
            args.extend(vec![
                "-f".to_string(),
                "pulse".to_string(),
                "-i".to_string(),
                source,
            ]);
        }
        (true, Some(source)) => {
            args.extend(vec![
                "-f".to_string(),
                "pulse".to_string(),
                "-i".to_string(),
                form_data.audio_device.clone(),
                "-f".to_string(),
                "pulse".to_string(),
                "-i".to_string(),
                source,
            ]);
            let mic_idx = next_input_index;
            let sys_idx = next_input_index + 1;
            args.extend(vec![
                "-filter_complex".to_string(),
                format!(
                    "[{}:a][{}:a]amix=inputs=2:duration=first[aout]",
                    mic_idx, sys_idx
                ),
                "-map".to_string(),
                "0:v".to_string(),
                "-map".to_string(),
                "[aout]".to_string(),
            ]);
        }
    }
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
    let entries =
        fs::read_dir(&sysfs).map_err(|e| format!("Failed to list video devices: {}", e))?;

    let mut devices = Vec::new();
    for entry in entries.flatten() {
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let name_path = entry.path().join("name");
        let Ok(name) = fs::read_to_string(&name_path) else {
            continue;
        };
        devices.push((format!("/dev/{}", dir_name), name.trim().to_string()));
    }

    Ok(devices)
}

fn find_v4l2_path(devices: &[(String, String)], name: &str) -> Option<String> {
    devices
        .iter()
        .find(|(_, n)| n == name)
        .map(|(path, _)| path.clone())
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

// Adds one video-only v4l2 input per selected camera, then a -filter_complex chaining an overlay
// stage per camera onto the screen capture — mirrors win.rs's add_overlay_args for dshow, using
// the same shared, camera-count-aware filter-graph builder rather than a single-camera one.
fn add_camera_overlay_args(args: &mut Vec<String>, form_data: &FormData) -> Result<(), String> {
    let overlay_size = map_overlay_size(&form_data.overlay_size);

    for device in &form_data.video_devices {
        let camera_path = require_v4l2_path(device)?;
        args.extend(vec![
            "-f".to_string(),
            "v4l2".to_string(),
            "-video_size".to_string(),
            overlay_size.clone(),
            "-i".to_string(),
            camera_path,
        ]);
    }

    let filter_complex = build_camera_overlay_filter_complex(
        &form_data.overlay_shape,
        &form_data.overlay_position,
        &form_data.overlay_size,
        form_data.video_devices.len(),
        MAX_RECORDING_WIDTH,
        None,
    );
    args.extend(vec!["-filter_complex".to_string(), filter_complex]);
    Ok(())
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
        "-f".to_string(),
        "x11grab".to_string(),
        "-framerate".to_string(),
        "30".to_string(),
    ];
    args.extend(x11grab_input_args(&resolve_capture_target(
        app_handle, form_data,
    ))?);

    let has_camera_overlay = !form_data.video_devices.is_empty();
    if has_camera_overlay {
        log::debug!("{} camera(s) overlaid", form_data.video_devices.len());
        add_camera_overlay_args(&mut args, form_data)?;
        // Pulse can't be bundled into the screen or camera input the way avfoundation/dshow
        // combine video+audio in one -i — it's always its own input on Linux. With
        // filter_complex already in play for the video composite, the output stream selection
        // is made explicit here (rather than relying on ffmpeg's default auto-selection, which
        // is a needless ambiguity to leave in place once there's more than one video-capable
        // input) by labeling the filtergraph's output and mapping both it and the audio input
        // in. The audio input lands right after the screen input (index 0) and however many
        // camera inputs add_camera_overlay_args just added, so its index has to be computed
        // rather than the single-camera-only hardcoded "2:a" this used to be.
        //
        // Its index is captured here (rather than re-finding it with args.last_mut() later)
        // because more args - the mic and, if requested, system-audio pulse inputs - get pushed
        // in between before an amix stage might need to be appended to this same string.
        let filter_complex_idx = args.len() - 1;
        args[filter_complex_idx].push_str("[vout]");

        let mic_input_index = 1 + form_data.video_devices.len();
        args.extend(vec![
            "-f".to_string(),
            "pulse".to_string(),
            "-i".to_string(),
            form_data.audio_device.clone(),
        ]);

        let audio_label = if let Some(source) = resolve_system_audio_source(form_data) {
            let system_input_index = mic_input_index + 1;
            args.extend(vec![
                "-f".to_string(),
                "pulse".to_string(),
                "-i".to_string(),
                source,
            ]);
            // ffmpeg accepts only one -filter_complex per invocation - append the audio mix to
            // the video one already built above rather than adding a second, separate one, same
            // "; "-joined multi-stage convention build_camera_overlay_filter_complex itself uses.
            args[filter_complex_idx] = format!(
                "{}; [{}:a][{}:a]amix=inputs=2:duration=first[aout]",
                args[filter_complex_idx], mic_input_index, system_input_index
            );
            "[aout]".to_string()
        } else {
            format!("{}:a", mic_input_index)
        };

        args.extend(vec![
            "-map".to_string(),
            "[vout]".to_string(),
            "-map".to_string(),
            audio_label,
        ]);
    } else {
        plain_audio_args(&mut args, form_data, 1);
    }

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

    let mut args: Vec<String> = vec![
        "-f".to_string(),
        "x11grab".to_string(),
        "-framerate".to_string(),
        "30".to_string(),
    ];
    args.extend(x11grab_input_args(&resolve_capture_target(
        app_handle, form_data,
    ))?);
    plain_audio_args(&mut args, form_data, 1);
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
    // Standalone video recording (no screen) only ever uses one camera, same as win.rs's own
    // recording_with_output_v - multi-camera only applies to the overlay-onto-screen modes above.
    let video_device = form_data.video_devices.first().cloned().unwrap_or_default();
    let camera_path = require_v4l2_path(&video_device)?;

    let args: Vec<String> = vec![
        "-f".to_string(),
        "v4l2".to_string(),
        "-i".to_string(),
        camera_path,
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

    let args: Vec<String> = vec![
        "-f".to_string(),
        "pulse".to_string(),
        "-i".to_string(),
        form_data.audio_device.clone(),
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
    // Same single-camera restriction as recording_with_output_v above.
    let video_device = form_data.video_devices.first().cloned().unwrap_or_default();
    let camera_path = require_v4l2_path(&video_device)?;

    // v4l2 and pulse can't be combined into one -i (unlike dshow/avfoundation) — two separate
    // inputs, one video-only stream and one audio-only stream, which ffmpeg's default stream
    // selection maps unambiguously since each type has exactly one candidate.
    let args: Vec<String> = vec![
        "-f".to_string(),
        "v4l2".to_string(),
        "-i".to_string(),
        camera_path,
        "-f".to_string(),
        "pulse".to_string(),
        "-i".to_string(),
        form_data.audio_device.clone(),
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

    let mut args: Vec<String> = vec![
        "-f".to_string(),
        "x11grab".to_string(),
        "-framerate".to_string(),
        "30".to_string(),
    ];
    args.extend(x11grab_input_args(&resolve_capture_target(
        app_handle, form_data,
    ))?);
    // No mic in this mode at all (screen only) - system audio, if requested and available, is the
    // only audio this can ever add, so there's nothing to mix; a plain second input is enough
    // (same "each type has exactly one candidate" default stream selection recording_with_output_va
    // already relies on for its own two-input case).
    if let Some(source) = resolve_system_audio_source(form_data) {
        args.extend(vec![
            "-f".to_string(),
            "pulse".to_string(),
            "-i".to_string(),
            source,
        ]);
    }
    args.push("-y".to_string());
    args.push(path_to_str(output_path)?.to_string());

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
    let output_path = output_path.clone();
    let input_args = x11grab_input_args(&resolve_capture_target(app_handle, form_data))?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["-f".to_string(), "x11grab".to_string()];
        args.extend(input_args);
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
// signals - the direct Linux/macOS equivalent of win.rs's per-thread SuspendThread/ResumeThread
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
