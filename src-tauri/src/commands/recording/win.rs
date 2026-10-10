// commands/recording/win.rs
//
// Windows recording backend: screen via ffmpeg's `gdigrab`, camera/microphone via `dshow`.
// Moved here verbatim from the old single-file recording.rs.
use std::path::PathBuf;
use std::process::{Command, Stdio};

use regex::Regex;
use tauri::{AppHandle, State};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::Threading::{
    OpenThread, ResumeThread, SuspendThread, THREAD_SUSPEND_RESUME,
};

use super::assembly::{CAMERA_LATENCY_HNS, FRAME_LOG_FILTER, SCREEN_LATENCY_HNS};
use super::gpu_capture::{self, GpuCapture};
use super::{
    audio_codec_args_for_ext, build_camera_overlay_filter_complex_from, capture_region_bounds,
    codec_args_for_ext_hw, codec_args_with_video_encoder, extract_ffmpeg_error, map_overlay_size,
    resolve_capture_target, silent_command, AppState, CaptureTarget, FormData,
    MAX_RECORDING_WIDTH,
};
use crate::services::progress_watch;
use crate::services::utility::{get_ffmpeg_path, path_to_str};

// "Don't downscale" for the GPU path's default - any real display is narrower than this.
const NATIVE_WIDTH: i32 = 16384;

// The screen half of a screen-capturing recording, decided once per recording: Desktop
// Duplication on the GPU when this machine can (see gpu_capture.rs), gdigrab otherwise. Every
// screen mode builds its screen input, filter chain and video codec args from this, so the GPU
// and gdigrab paths can't drift apart mode by mode.
struct ScreenSource {
    gpu: Option<GpuCapture>,
    target: CaptureTarget,
    framerate: i32,
    max_width: i32,
}

impl ScreenSource {
    // `legacy_fps` is the mode's own gdigrab default. `baked_camera` is a camera composited into
    // the screen picture on the CPU, which caps what the GPU path can sustain (see gpu_capture.rs).
    async fn resolve(
        app_handle: &AppHandle,
        form_data: &FormData,
        ffmpeg_path: &std::path::Path,
        legacy_fps: i32,
        baked_camera: bool,
    ) -> ScreenSource {
        let target = resolve_capture_target(app_handle, form_data);
        let gpu_container = matches!(
            form_data.file_ext.to_lowercase().as_str(),
            "mp4" | "mkv" | "avi" | "mov"
        );
        let region = capture_region_bounds(&target);
        let gpu = match region {
            Some(region) if gpu_container => {
                let exact = !matches!(target, CaptureTarget::Window { .. });
                let ffmpeg = ffmpeg_path.to_path_buf();
                // Normally answered from the startup probe's cache, but the first recording of a
                // session can land while that probe is still running - never on an async worker.
                crate::services::responsiveness::blocking(move || gpu_capture::plan(&ffmpeg, region, exact))
                    .await
                    .ok()
                    .flatten()
            }
            _ => None,
        };

        let (default_width, default_fps) = match &gpu {
            Some(g) if g.encoder.zero_copy() && !baked_camera => (NATIVE_WIDTH, 60),
            Some(_) => (MAX_RECORDING_WIDTH, 30),
            None => (MAX_RECORDING_WIDTH, legacy_fps),
        };
        let max_width = match form_data.resolution_width {
            Some(_) => super::resolved_max_width(form_data),
            None => default_width,
        };
        let mut framerate = form_data.framerate.unwrap_or(default_fps).clamp(1, 60);
        if gpu.is_some() && baked_camera {
            // The CPU composite can't keep up past this (measured ~30 fps at any size here).
            framerate = framerate.min(30);
        }

        gpu_capture::USED_BY_LAST_START.store(gpu.is_some(), std::sync::atomic::Ordering::SeqCst);
        let source = ScreenSource { gpu, target, framerate, max_width };
        log::info!("Screen capture: {}", source.summary());
        source
    }

    // What the screen adds before every other input. On the GPU path that's only the D3D11
    // device: ddagrab runs as a source filter inside the -filter_complex (see stage), not as an
    // input, for two measured reasons -
    //   - as a lavfi input, ffmpeg never acts on the 'q' stop_recording sends it (still recording
    //     15s later, every time), so every stop ended in a force-kill; inside the graph it
    //     finalizes and exits in about a second, same as gdigrab;
    //   - as an input, ffmpeg's scheduler paces it to the slowest input feeding the same graph: a
    //     webcam delivering 15 fps in dim light dragged the screen to 15 fps (134 frames in 8s).
    fn inputs(&self) -> Result<Vec<String>, String> {
        match &self.gpu {
            Some(g) => Ok(g.device_args()),
            None => {
                let mut args = vec![
                    "-f".to_string(),
                    "gdigrab".to_string(),
                    "-framerate".to_string(),
                    self.framerate.to_string(),
                ];
                args.extend(gdigrab_input_args(&self.target)?);
                Ok(args)
            }
        }
    }

    // Index of the first input added after the screen's own.
    fn next_input(&self) -> usize {
        if self.gpu.is_some() {
            0
        } else {
            1
        }
    }

    // The -filter_complex chain producing the screen picture (unlabeled - callers append their
    // own output label), and whether its frames end up in system memory. `to_cpu` asks for
    // system-memory frames regardless, for a CPU filter (the camera overlay) that follows it.
    fn stage(&self, to_cpu: bool) -> (String, bool) {
        match &self.gpu {
            Some(g) => {
                let (chain, cpu) = g.chain(g.scaled_size(self.max_width), to_cpu);
                (format!("{},{},{}", g.source_filter(self.framerate), FRAME_LOG_FILTER, chain), cpu)
            }
            None => (format!("[0:v]{},scale='min({},iw)':-2", FRAME_LOG_FILTER, self.max_width), true),
        }
    }

    fn codec_args(&self, ext: &str, ffmpeg_path: &std::path::Path, cpu_frames: bool) -> Vec<String> {
        let mut args = match &self.gpu {
            Some(g) => codec_args_with_video_encoder(ext, &g.encoder_args(ffmpeg_path, cpu_frames), false)
                .unwrap_or_else(|| codec_args_for_ext_hw(ext, ffmpeg_path)),
            None => codec_args_for_ext_hw(ext, ffmpeg_path),
        };
        // No B-frames: decode order then equals display order, which lets assembly close pause
        // gaps by shifting timestamps on a stream copy (see recording/assembly.rs) - and a live
        // capture gains nothing from the extra encoder latency anyway.
        args.extend(["-bf".to_string(), "0".to_string()]);
        args
    }

    // Everything after the inputs and filter graph: the mic map (when ffmpeg captures the mic -
    // `mic_input`), video codec, and the output. A recording being assembled at stop
    // (form_data.capture_path) is written to its intermediate - Matroska regardless of the final
    // container, since it must survive a crash and carry pause gaps as gaps - with every frame's
    // timestamp logged for the assembly's sync (see ScreenSource::stage).
    fn output_args(
        &self,
        form_data: &FormData,
        ffmpeg_path: &std::path::Path,
        cpu_frames: bool,
        mic_input: Option<usize>,
        output_path: &std::path::Path,
    ) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if let Some(i) = mic_input {
            args.extend(["-map".to_string(), format!("{}:a", i)]);
        }
        let mut codec = self.codec_args(&form_data.file_ext, ffmpeg_path, cpu_frames);
        let target = match &form_data.capture_path {
            Some(path) => {
                if let Some(i) = codec.iter().position(|a| a == "-movflags") {
                    codec.drain(i..(i + 2).min(codec.len()));
                }
                codec.extend(["-fps_mode:v".into(), "vfr".into(), "-f".into(), "matroska".into()]);
                path.as_path()
            }
            None => {
                output_path
            }
        };
        args.extend(codec);
        args.extend(["-y".to_string(), path_to_str(target)?.to_string()]);
        Ok(args)
    }

    // Width of the picture the screen stage produces - what camera bubbles are sized against.
    fn output_width(&self) -> i32 {
        match &self.gpu {
            Some(g) => g.scaled_size(self.max_width).0,
            None => capture_region_bounds(&self.target)
                .map(|(_, _, w, _)| w.min(self.max_width))
                .unwrap_or(self.max_width.min(MAX_RECORDING_WIDTH)),
        }
    }

    // For the log and the "Recording started" message, e.g. "3840x2160 at 60 fps, Intel Quick Sync".
    fn summary(&self) -> String {
        match &self.gpu {
            Some(g) => {
                let (w, h) = g.scaled_size(self.max_width);
                format!("{}x{} at {} fps, {}", w, h, self.framerate, g.encoder.label())
            }
            None => format!("{} fps, compatibility capture", self.framerate),
        }
    }
}


fn desktop_crop_args(x: i32, y: i32, width: i32, height: i32) -> Vec<String> {
    vec![
        "-offset_x".to_string(),
        x.to_string(),
        "-offset_y".to_string(),
        y.to_string(),
        "-video_size".to_string(),
        format!("{}x{}", width, height),
        "-i".to_string(),
        "desktop".to_string(),
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
        CaptureTarget::Monitor {
            x,
            y,
            width,
            height,
        } => Ok(desktop_crop_args(*x, *y, *width, *height)),
        CaptureTarget::Window { title } => {
            let (x, y, width, height) =
                crate::commands::window_capture::win::get_window_rect_by_title(title)?;
            Ok(desktop_crop_args(x, y, width, height))
        }
    }
}

pub fn get_connected_devices(app_handle: &AppHandle) -> (Vec<String>, Vec<String>) {
    let ffmpeg_path = match get_ffmpeg_path(app_handle) {
        Ok(path) => path,
        Err(e) => {
            return (vec![e.clone()], vec![e]);
        }
    };

    // Not silent_command, for the same reason take_screenshot below isn't: this *needs* ffmpeg's
    // stderr, because -list_devices writes the device list there rather than to stdout. Only the
    // console-hiding half is wanted here.
    let mut cmd = Command::new(&ffmpeg_path);
    cmd.args(["-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
    super::hide_console_window(&mut cmd);
    // Bounded: a dshow probe can hang on a camera driver that's busy or wedged, and nothing that
    // waits on this list should be able to hang with it.
    let output = match crate::services::responsiveness::output_with_timeout(
        cmd,
        std::time::Duration::from_secs(10),
    ) {
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
// `screen` and `first_camera` come from ScreenSource::graph_screen.
fn add_overlay_args(
    args: &mut Vec<String>,
    form_data: &FormData,
    screen: &str,
    first_camera: usize,
    max_width: i32,
    frame_width: i32,
) {
    let overlay_size = map_overlay_size(&form_data.overlay_size);

    for device in &form_data.video_devices {
        args.extend(vec![
            "-f".to_string(),
            "dshow".to_string(),
            "-video_size".to_string(),
            overlay_size.clone(),
            "-i".to_string(),
            format!("video={}", device),
        ]);
    }

    let style = super::OverlayStyle {
        shape: &form_data.overlay_shape,
        position: &form_data.overlay_position,
        size: &form_data.overlay_size,
        border: &form_data.overlay_border,
        border_color: &form_data.overlay_border_color,
    };
    let filter_complex = build_camera_overlay_filter_complex_from(
        &style,
        form_data.video_devices.len(),
        max_width,
        frame_width,
        Some(screen),
        first_camera,
    );

    args.extend(vec!["-filter_complex".to_string(), filter_complex]);
}

// Starts the recording ffmpeg and wires up everything a Windows recording needs, so that no
// individual mode has to reassemble it.
//
// This was six near-identical copies of the same sequence: build a Command with the right stdio,
// hide the console, spawn, assign to the orphan-kill Job Object, stash the child in AppState, and
// start the progress watcher. Keeping six copies in step is exactly the trap it sounds like - one
// of them had already drifted to a non-piped stdin, which meant stop_recording's graceful "q"
// went nowhere and that mode could only ever be force-killed.
//
// `capture_preview` is for the camera-only modes, whose ffmpeg writes a live MJPEG preview to its
// stdout (see preview_output_args). Only those pipe stdout at all: a mode with no preview output
// has nothing to read there, and piping it anyway would leave a thread parked on a pipe that
// never delivers a byte.
async fn start_recording_process(
    app_handle: &AppHandle,
    state: &State<'_, AppState>,
    ffmpeg_path: &std::path::Path,
    args: &[String],
    progress_sidecar: std::path::PathBuf,
    capture_preview: bool,
    // Recordings assembled at stop: the capture framerate and capture latency, and ffmpeg's stderr
    // is read for frame timing (see recording/assembly.rs) instead of discarded.
    frame_timing: Option<(i32, i64)>,
) -> Result<(), String> {
    log::debug!("FFmpeg args: {:?}", args);

    // silent_command is the single place stdio and console-hiding are decided; the only override
    // is stdout, and only for the modes that actually stream something through it.
    let mut cmd = silent_command(ffmpeg_path);
    cmd.args(args);
    if capture_preview {
        cmd.stdout(Stdio::piped());
    }
    let mut assembly = state.assembly.lock().await;
    let frame_timing = frame_timing.filter(|_| assembly.is_some());
    if frame_timing.is_some() {
        cmd.stderr(Stdio::piped());
    }

    crate::services::orphan_guard::before_spawn(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    crate::services::orphan_guard::after_spawn(&child);
    let pid = child.id();

    if let (Some((fps, latency)), Some(stderr), Some(parts)) = (frame_timing, child.stderr.take(), assembly.as_mut()) {
        parts.timing = Some(super::assembly::spawn_frame_timing(stderr, fps, latency));
        parts.command = Some(super::assembly::CaptureCommand {
            ffmpeg_path: ffmpeg_path.to_path_buf(),
            args: args.to_vec(),
            progress_path: progress_sidecar.clone(),
            framerate: fps,
            latency_hns: latency,
        });
    }
    drop(assembly);

    if capture_preview {
        if let Some(stdout) = child.stdout.take() {
            let slot = state.preview_frame_handle();
            // Must keep draining for as long as ffmpeg runs: a full pipe blocks its writes, and
            // because ffmpeg advances all of its outputs together that would stall the recording
            // itself rather than just the preview.
            std::thread::spawn(move || {
                crate::services::preview_stream::pump(stdout, slot);
            });
        }
    }

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }
    progress_watch::watch(
        app_handle.clone(),
        progress_sidecar,
        state.ffmpeg_process.clone(),
        pid,
    );

    Ok(())
}

// Starts a capture again from the command it was first started with, writing to `video_path`
// instead of the original intermediate - for the watchdog, when the first one died mid-recording
// (see capture_watchdog.rs). Spawned exactly as start_recording_process does.
pub(crate) fn respawn_capture(
    command: &super::assembly::CaptureCommand,
    original: &std::path::Path,
    video_path: &std::path::Path,
) -> Result<(std::process::Child, std::sync::Arc<std::sync::Mutex<super::assembly::FrameTiming>>), String> {
    let (original, video_path) = (path_to_str(original)?, path_to_str(video_path)?);
    let args: Vec<&str> = command
        .args
        .iter()
        .map(|a| if a == original { video_path } else { a.as_str() })
        .collect();
    let mut cmd = silent_command(&command.ffmpeg_path);
    cmd.args(&args).stderr(Stdio::piped());
    crate::services::orphan_guard::before_spawn(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Failed to restart the capture: {}", e))?;
    crate::services::orphan_guard::after_spawn(&child);
    let stderr = child.stderr.take().ok_or("The restarted capture has no output to time")?;
    let timing = super::assembly::spawn_frame_timing(stderr, command.framerate, command.latency_hns);
    Ok((child, timing))
}

// Starts the separately recorded webcam's own ffmpeg (see assembly::CameraSidecar), into the temp
// capture folder beside the screen's intermediate. Every frame is timed like the screen's, so
// assembly can re-time it onto the final recording.
async fn start_camera_sidecar(
    state: &State<'_, AppState>,
    ffmpeg_path: &std::path::Path,
    form_data: &FormData,
    output_path: &std::path::Path,
) -> Result<(), String> {
    let mut assembly = state.assembly.lock().await;
    let Some(parts) = assembly.as_mut() else {
        return Ok(());
    };
    // A start retried through another capture path would otherwise leave the first camera running.
    if let Some(mut old) = parts.camera.take().and_then(|c| c.process) {
        let _ = old.kill();
    }
    let stem = output_path.file_stem().and_then(|s| s.to_str()).unwrap_or("recording");
    let video_path = parts.video_path.with_file_name(format!("{}.camera.mkv", stem));
    let final_path = output_path.with_file_name(format!("{}_webcam.mp4", stem));

    let mut cmd = silent_command(ffmpeg_path);
    cmd.args([
        "-f",
        "dshow",
        "-video_size",
        &map_overlay_size(&form_data.overlay_size),
        "-i",
        &format!("video={}", form_data.video_devices[0]),
        "-vf",
        FRAME_LOG_FILTER,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-bf",
        "0",
        "-fps_mode:v",
        "vfr",
        "-f",
        "matroska",
        "-y",
    ])
    .arg(&video_path)
    .stderr(Stdio::piped());
    crate::services::orphan_guard::before_spawn(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start the webcam recording: {}", e))?;
    crate::services::orphan_guard::after_spawn(&child);
    let stderr = child.stderr.take().ok_or("The webcam recording has no output to time")?;
    let timing = super::assembly::spawn_frame_timing(stderr, 30, CAMERA_LATENCY_HNS);
    parts.camera = Some(super::assembly::CameraSidecar {
        process: Some(child),
        timing,
        video_path,
        final_path,
    });
    Ok(())
}

//Screen video and audio
pub async fn recording_with_output_sva(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }

    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let progress_sidecar = progress_watch::progress_sidecar_path(output_path);

    // Camera inputs (if any) must be added before the audio input below - both add_overlay_args's
    // filter_complex and the separate-capture filter_complex just below reference them as
    // [1:v].. (or [1:v]..[N:v] for the baked-in case), immediately following the screen capture at
    // index 0, so nothing else can be inserted between the screen input and the camera inputs.
    let has_camera_overlay = !form_data.video_devices.is_empty();
    // Opt-in (FormData.separate_webcam_capture) alternative to the baked-in overlay above -
    // records the camera as its OWN uncomposited file alongside the main recording instead of
    // burning it into a single frame, so the editor's PiP layer can reposition/resize/reshape it
    // after the fact (something no amount of post-processing can do once pixels are already
    // merged). Gated to exactly one camera: N-camera PiP editing (multiple independently
    // positionable bubbles) isn't built on the editor side, so a multi-camera selection here just
    // falls back to the existing baked-in overlay rather than silently dropping every camera past
    // the first.
    let separate_webcam_capture = has_camera_overlay
        && form_data.separate_webcam_capture
        && form_data.video_devices.len() == 1;
    let baked_camera = has_camera_overlay && !separate_webcam_capture;

    let screen = ScreenSource::resolve(app_handle, form_data, &ffmpeg_path, 60, baked_camera).await;
    let mut args: Vec<String> = vec![
        "-progress".to_string(),
        path_to_str(&progress_sidecar)?.to_string(),
    ];
    args.extend(screen.inputs()?);

    // Input order after the screen's own: camera(s) (when there are any), then the mic. The
    // filter graphs and -maps below index into exactly this order.
    let first_camera = screen.next_input();
    // The screen's stage, and whether its frames reach the encoder in system memory (which picks
    // the encoder args below). A baked-in camera composites on the CPU, so it asks for that.
    let (stage, cpu_frames) = screen.stage(baked_camera);
    let mic_input;
    if baked_camera {
        log::debug!("{} camera(s) overlaid", form_data.video_devices.len());
        add_overlay_args(&mut args, form_data, &stage, first_camera, screen.max_width, screen.output_width());
        mic_input = first_camera + form_data.video_devices.len();
    } else if separate_webcam_capture && form_data.capture_path.is_some() {
        // The camera gets its own ffmpeg (start_camera_sidecar, below) - see CameraSidecar for why.
        log::debug!("Recording webcam separately for PiP editing, in its own process");
        args.extend(vec!["-filter_complex".to_string(), format!("{}[scr]", stage)]);
        mic_input = first_camera;
    } else if separate_webcam_capture {
        log::debug!("Recording webcam separately for PiP editing");
        let overlay_size = map_overlay_size(&form_data.overlay_size);
        args.extend(vec![
            "-f".to_string(),
            "dshow".to_string(),
            "-video_size".to_string(),
            overlay_size,
            "-i".to_string(),
            format!("video={}", form_data.video_devices[0]),
        ]);
        args.extend(vec!["-filter_complex".to_string(), format!("{}[scr]", stage)]);
        mic_input = first_camera + 1;
    } else {
        args.extend(vec!["-filter_complex".to_string(), format!("{}[scr]", stage)]);
        mic_input = first_camera;
    }

    // Audio is its own standalone input - previously it was bundled into the single camera's dshow
    // input line (video=X:audio=Y), which only worked for exactly one camera. Not added at all when
    // the app captures the mic itself for assembly (form_data.mic_external).
    let mic_input = (!form_data.mic_external).then_some(mic_input);
    if mic_input.is_some() {
        args.extend(screen_mic_input_args(&form_data.audio_device));
    }

    // Explicit maps: with a -filter_complex in play ffmpeg's default stream selection can't be
    // relied on. The baked-in overlay graph ends in an unlabeled output, which ffmpeg maps itself.
    if !baked_camera {
        args.extend(vec!["-map".to_string(), "[scr]".to_string()]);
    }
    args.extend(screen.output_args(form_data, &ffmpeg_path, cpu_frames, mic_input, output_path)?);

    // Second output, same ffmpeg process: the raw camera stream (input first_camera), video-only (no
    // audio - the mic already went to the primary output above, and doubling it here would just
    // mix the same track twice if this ever got composited back in). Always .mp4 regardless of
    // the user's chosen file_ext for the main recording - this is an internal editor artifact, not
    // the deliverable, so it doesn't need to match. A simple, fast preset is enough: this is a
    // small-resolution (overlay_size) source, not the full desktop capture.
    if separate_webcam_capture && form_data.capture_path.is_none() {
        let webcam_output = output_path.with_file_name(format!(
            "{}_webcam.mp4",
            output_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("recording")
        ));
        args.extend(vec![
            "-map".to_string(),
            format!("{}:v", first_camera),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "veryfast".to_string(),
            "-crf".to_string(),
            "23".to_string(),
            path_to_str(&webcam_output)?.to_string(),
        ]);
    }

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
    start_recording_process(app_handle, &state, &ffmpeg_path, &args, progress_sidecar, false, Some((screen.framerate, SCREEN_LATENCY_HNS))).await?;
    if separate_webcam_capture && form_data.capture_path.is_some() {
        start_camera_sidecar(&state, &ffmpeg_path, form_data, output_path).await?;
    }

    Ok(format!(
        "Recording started ({}). File will be saved as:\n{}",
        screen.summary(),
        output_path.display()
    ))
}
//Screen and audio
pub async fn recording_with_output_sa(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }

    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let progress_sidecar = progress_watch::progress_sidecar_path(output_path);

    // 30 is the gdigrab default: it can't deliver more from a large desktop, and polling faster
    // only takes CPU from the encoder. The GPU path defaults higher - see ScreenSource::resolve.
    let screen = ScreenSource::resolve(app_handle, form_data, &ffmpeg_path, 30, false).await;
    let mut args: Vec<String> = vec![
        "-progress".to_string(),
        path_to_str(&progress_sidecar)?.to_string(),
    ];
    args.extend(screen.inputs()?);
    let mic_input = (!form_data.mic_external).then_some(screen.next_input());
    if mic_input.is_some() {
        args.extend(screen_mic_input_args(&form_data.audio_device));
    }
    let (stage, cpu_frames) = screen.stage(false);
    args.extend(vec![
        "-filter_complex".to_string(),
        format!("{}[scr]", stage),
        "-map".to_string(),
        "[scr]".to_string(),
    ]);
    args.extend(screen.output_args(form_data, &ffmpeg_path, cpu_frames, mic_input, output_path)?);

    log::debug!("Path {:?}", output_path);
    // stdout is captured rather than discarded here: for the camera-only modes it carries the
    // live preview stream (see preview_output_args). The reader thread below must start before
    // anything waits on this process, because a pipe nobody drains eventually blocks ffmpeg.
    start_recording_process(app_handle, &state, &ffmpeg_path, &args, progress_sidecar, false, Some((screen.framerate, SCREEN_LATENCY_HNS))).await?;

    Ok(format!(
        "Recording started ({}). File will be saved to {}",
        screen.summary(),
        output_path.display()
    ))
}

//Video only
pub async fn recording_with_output_v(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let progress_sidecar = progress_watch::progress_sidecar_path(output_path);

    log::debug!("Path {:?}", output_path);

    // Same multi-camera treatment as recording_with_output_va above, just with no audio input.
    let cameras = &form_data.video_devices;

    let mut args: Vec<String> = vec![
        "-progress".to_string(),
        path_to_str(&progress_sidecar)?.to_string(),
    ];
    for camera in cameras {
        args.extend(vec![
            "-f".to_string(),
            "dshow".to_string(),
            "-i".to_string(),
            format!("video={}", camera),
        ]);
    }
    args.extend(vec![
        "-filter_complex".to_string(),
        camera_only_filter_complex(cameras.len()),
    ]);
    args.extend(vec!["-map".to_string(), "[vout]".to_string()]);
    args.extend(camera_output_args(form_data, &ffmpeg_path, output_path)?);
    args.extend(preview_output_args());

    // stdout carries the live preview stream for this mode (see preview_output_args), so it is
    // captured and drained rather than inherited - left inherited it would write raw JPEG bytes
    // to whatever console the app was launched from.
    start_recording_process(app_handle, &state, &ffmpeg_path, &args, progress_sidecar, true, Some((30, CAMERA_LATENCY_HNS))).await?;

    Ok(format!(
        "Recording started. File will be saved to {:?}",
        output_path.file_name()
    ))
}

//Audio only
pub async fn recording_with_output_a(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let progress_sidecar = progress_watch::progress_sidecar_path(output_path);

    log::debug!("Path {:?}", output_path);
    let mut args: Vec<String> = vec![
        "-progress".to_string(),
        path_to_str(&progress_sidecar)?.to_string(),
    ];
    args.extend(mic_input_args(&form_data.audio_device));
    // Previously had no codec flags at all - left to ffmpeg's per-container default, which for
    // .mp3 measured out to 128k, same gap as every other mode fixed above.
    args.extend(audio_codec_args_for_ext(&form_data.file_ext));
    args.extend(vec![
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ]);

    // stdout is captured rather than discarded here: for the camera-only modes it carries the
    // live preview stream (see preview_output_args). The reader thread below must start before
    // anything waits on this process, because a pipe nobody drains eventually blocks ffmpeg.
    start_recording_process(app_handle, &state, &ffmpeg_path, &args, progress_sidecar, false, None).await?;

    Ok(format!(
        "Recording started. File will be saved to {}",
        output_path.display()
    ))
}

//Video and audio
// Height every camera is normalised to before they're stacked side by side. hstack requires all
// its inputs share a height, and the cameras' own resolutions aren't known without probing each
// device first - so they're all scaled to a fixed, typical-webcam height instead. Width is left
// to follow each camera's own aspect ratio (-2 keeps it even, which H.264 requires).
// How much audio dshow buffers before handing it to ffmpeg, in milliseconds.
//
// Measured, not guessed. ffmpeg advances all of its inputs together, so the audio device's buffer
// sets the cadence for the *whole* pipeline - including the live preview's writes. At the driver
// default this pushed the preview through in bursts: a preview asked for 12fps delivered barely 4
// distinct frames a second, because the frames in between were overwritten before anything could
// read them. Dropping the buffer to 50ms restored the full 12fps, matching what the same command
// achieves with no audio input at all, and the recorded audio stream is unchanged either way
// (still aac 44.1kHz stereo). It also cuts the capture latency at the head of every recording.
const AUDIO_BUFFER_MS: &str = "50";

// The mic for the screen modes: the driver's default buffer, not AUDIO_BUFFER_MS. That 50ms is
// for the camera modes' live preview, which the screen modes don't have - and alongside a screen
// captured inside the filter graph (see ScreenSource::inputs) it made ffmpeg's scheduler run the
// whole pipeline below real time: 0.59-0.82x speed across repeated runs, against 0.96x without it.
fn screen_mic_input_args(audio_device: &str) -> Vec<String> {
    vec![
        "-f".to_string(),
        "dshow".to_string(),
        "-i".to_string(),
        format!("audio={}", audio_device),
    ]
}

// One dshow microphone input, with the buffer size above applied - for the camera and audio-only
// modes (the screen modes use screen_mic_input_args).
fn mic_input_args(audio_device: &str) -> Vec<String> {
    vec![
        "-f".to_string(),
        "dshow".to_string(),
        "-audio_buffer_size".to_string(),
        AUDIO_BUFFER_MS.to_string(),
        "-i".to_string(),
        format!("audio={}", audio_device),
    ]
}

const CAMERA_STACK_HEIGHT: i32 = 720;
// The live preview ffmpeg writes alongside a camera-only recording. Still deliberately small -
// every pixel of it is CPU taken from the recording it sits beside - but sized to be watchable
// rather than merely indicative, now that it no longer costs a base64 round trip per frame.
const PREVIEW_WIDTH: i32 = 640;
// 12fps. The rate was cut to 3 when the preview lived in the user's own recordings folder, where
// each frame's create+rename was something Windows' real-time scanner opened - that churn was
// measurably degrading the whole app. Moving the file to the OS temp directory removed that cost,
// and 3fps reads as a slideshow rather than a live view, which defeats the point of having it.
//
// 12 is chosen from measurement, not taste: asking for more than ~10 delivered frames a second
// produced no additional distinct frames at the consumer, so anything higher is encoding work that
// nothing ever sees.
const PREVIEW_FPS: i32 = 12;

// Builds the -filter_complex for a camera-only recording: stacks the cameras left to right (when
// there's more than one), then splits the result so the same picture feeds both the recording and
// the live preview. `[vout]` is the recording's video, `[vpout]` the preview's.
//
// The split is deliberately after the stack, so the preview shows exactly the composite being
// recorded rather than just the first camera.
// Video codec and output for a camera-only recording's main output - its intermediate when it's
// assembled at stop (form_data.capture_path, see ScreenSource::output_args for the same treatment).
fn camera_output_args(form_data: &FormData, ffmpeg_path: &std::path::Path, output_path: &std::path::Path) -> Result<Vec<String>, String> {
    let mut args = codec_args_for_ext_hw(&form_data.file_ext, ffmpeg_path);
    args.extend(["-bf".to_string(), "0".to_string()]);
    let target = match &form_data.capture_path {
        Some(path) => {
            if let Some(i) = args.iter().position(|a| a == "-movflags") {
                args.drain(i..(i + 2).min(args.len()));
            }
            args.extend(["-fps_mode:v".into(), "vfr".into(), "-f".into(), "matroska".into()]);
            path.as_path()
        }
        None => output_path,
    };
    args.extend(["-y".to_string(), path_to_str(target)?.to_string()]);
    Ok(args)
}

fn camera_only_filter_complex(camera_count: usize) -> String {
    let mut fc = String::new();

    if camera_count > 1 {
        for i in 0..camera_count {
            fc.push_str(&format!(
                "[{i}:v]scale=-2:{h},setsar=1[c{i}];",
                i = i,
                h = CAMERA_STACK_HEIGHT
            ));
        }
        for i in 0..camera_count {
            fc.push_str(&format!("[c{}]", i));
        }
        fc.push_str(&format!("hstack=inputs={}[stacked];", camera_count));
        fc.push_str(&format!("[stacked]{},split=2[vout][vp];", FRAME_LOG_FILTER));
    } else {
        // Single camera: no scaling at all, so the recording keeps the camera's native
        // resolution exactly as it did before multi-camera support existed. split is a
        // passthrough, so this costs the output nothing.
        fc.push_str(&format!("[0:v]{},split=2[vout][vp];", FRAME_LOG_FILTER));
    }

    fc.push_str(&format!(
        "[vp]fps={fps},scale={w}:-2[vpout]",
        fps = PREVIEW_FPS,
        w = PREVIEW_WIDTH
    ));
    fc
}

// The trailing output args that make ffmpeg keep one small JPEG up to date for the live preview.
// -update overwrites a single file instead of writing a numbered sequence; -atomic_writing makes
// each overwrite a write-to-temp-then-rename, so a reader polling this file can never catch a
// half-written frame.
// The trailing output args that stream the live preview out of ffmpeg's stdout as MJPEG.
//
// stdout, not a file. A file meant a create-plus-rename per frame (-atomic_writing, needed so a
// reader couldn't catch a half-written frame), which put every frame in front of Windows'
// real-time scanner and had the reader and writer contending over one path - measured delivery
// swung between roughly 4 and 12 frames a second across identical runs. A pipe has none of that:
// no disk, no tearing, nothing stranded in temp when a recording ends abnormally.
//
// The consumer (services/preview_stream.rs) must keep draining this for as long as ffmpeg runs -
// pipes have a finite buffer, and a full one would block ffmpeg's writes and stall the recording
// itself, since ffmpeg advances all of its outputs together.
fn preview_output_args() -> Vec<String> {
    vec![
        "-map".to_string(),
        "[vpout]".to_string(),
        "-f".to_string(),
        "mjpeg".to_string(),
        // Quality is set explicitly because mjpeg's default is soft enough to look like a problem
        // with the camera rather than with the preview. 2-31, lower is better.
        "-q:v".to_string(),
        "6".to_string(),
        // Hand each frame to the pipe as it is produced rather than letting it wait in the muxer.
        "-flush_packets".to_string(),
        "1".to_string(),
        "pipe:1".to_string(),
    ]
}

pub async fn recording_with_output_va(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }

    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let progress_sidecar = progress_watch::progress_sidecar_path(output_path);

    log::debug!("Path {:?}", output_path);

    // Every selected camera is recorded, not just the first. They're stacked left to right into
    // one file by camera_only_filter_complex above.
    let cameras = &form_data.video_devices;

    let mut args: Vec<String> = vec![
        "-progress".to_string(),
        path_to_str(&progress_sidecar)?.to_string(),
    ];

    for camera in cameras {
        args.extend(vec![
            "-f".to_string(),
            "dshow".to_string(),
            "-i".to_string(),
            format!("video={}", camera),
        ]);
    }

    // The microphone is its own input rather than being bundled onto a camera's input line
    // (`video=X:audio=Y`), which only ever worked when there was exactly one camera to bundle it
    // onto - the same reasoning recording_with_output_sva already applies for its own mic.
    // Left out when the app captures the mic itself, to be lined up with the picture exactly when
    // the recording is assembled (form_data.mic_external).
    if !form_data.mic_external {
        args.extend(mic_input_args(&form_data.audio_device));
    }
    let audio_input_index = cameras.len();

    args.extend(vec![
        "-filter_complex".to_string(),
        camera_only_filter_complex(cameras.len()),
    ]);
    args.extend(vec!["-map".to_string(), "[vout]".to_string()]);
    if !form_data.mic_external {
        args.extend(vec!["-map".to_string(), format!("{}:a", audio_input_index)]);
    }
    args.extend(camera_output_args(form_data, &ffmpeg_path, output_path)?);
    args.extend(preview_output_args());

    // stdout is captured rather than discarded here: for the camera-only modes it carries the
    // live preview stream (see preview_output_args). The reader thread below must start before
    // anything waits on this process, because a pipe nobody drains eventually blocks ffmpeg.
    start_recording_process(app_handle, &state, &ffmpeg_path, &args, progress_sidecar, true, Some((30, CAMERA_LATENCY_HNS))).await?;

    Ok(format!(
        "Recording started. File will be saved to {}",
        output_path.display()
    ))
}

//Screen only
pub async fn recording_with_output_s(
    app_handle: &AppHandle,
    state: State<'_, AppState>,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    {
        let mut app_state = state.output_path.lock().await;
        *app_state = Some(output_path.clone());
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let progress_sidecar = progress_watch::progress_sidecar_path(output_path);

    // Same defaults as recording_with_output_sa.
    let screen = ScreenSource::resolve(app_handle, form_data, &ffmpeg_path, 30, false).await;
    let mut args: Vec<String> = vec![
        "-progress".to_string(),
        path_to_str(&progress_sidecar)?.to_string(),
    ];
    args.extend(screen.inputs()?);
    let (stage, cpu_frames) = screen.stage(false);
    args.extend(vec![
        "-filter_complex".to_string(),
        format!("{}[scr]", stage),
        "-map".to_string(),
        "[scr]".to_string(),
    ]);
    args.extend(screen.output_args(form_data, &ffmpeg_path, cpu_frames, None, output_path)?);

    log::debug!("Path {:?}", output_path);
    // stdout is captured rather than discarded here: for the camera-only modes it carries the
    // live preview stream (see preview_output_args). The reader thread below must start before
    // anything waits on this process, because a pipe nobody drains eventually blocks ffmpeg.
    start_recording_process(app_handle, &state, &ffmpeg_path, &args, progress_sidecar, false, Some((screen.framerate, SCREEN_LATENCY_HNS))).await?;

    Ok(format!(
        "Recording started ({}). File will be saved to {}",
        screen.summary(),
        output_path.display()
    ))
}

// A real instant screenshot: `-frames:v 1` tells gdigrab/ffmpeg to grab exactly one frame and
// exit on its own, so this is a single .output() call (wait for the process to finish, done) —
// no AppState involvement, no ffmpeg_process to track, nothing for stop_recording to stop.
pub async fn take_screenshot(
    app_handle: &AppHandle,
    output_path: &PathBuf,
    form_data: &FormData,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let output_path = output_path.clone();
    let input_args = gdigrab_input_args(&resolve_capture_target(app_handle, form_data))?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["-f".to_string(), "gdigrab".to_string()];
        args.extend(input_args);
        args.extend(vec![
            "-frames:v".to_string(),
            "1".to_string(),
            "-y".to_string(),
            path_to_str(&output_path)?.to_string(),
        ]);

        // Not silent_command: that nulls stderr, which would throw away ffmpeg's actual error
        // text right when it's most useful (a failed capture) — hide_console_window alone gets
        // the "don't flash a console window" behavior without that tradeoff.
        let mut cmd = Command::new(&ffmpeg_path);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        super::hide_console_window(&mut cmd);

        let output = cmd
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

// Runs `f` once per thread currently owned by `pid` - the enumeration primitive shared by
// suspend_process/resume_process below. Windows has no single "list this process's threads" call
// that doesn't also require walking every thread on the system: CreateToolhelp32Snapshot always
// snapshots system-wide, so the th32OwnerProcessID filter has to happen in the walk itself.
fn for_each_process_thread(pid: u32, mut f: impl FnMut(u32)) -> Result<(), String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
            .map_err(|e| format!("Failed to snapshot system threads: {}", e))?;

        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };

        let mut has_entry = Thread32First(snapshot, &mut entry).is_ok();
        while has_entry {
            if entry.th32OwnerProcessID == pid {
                f(entry.th32ThreadID);
            }
            has_entry = Thread32Next(snapshot, &mut entry).is_ok();
        }

        let _ = CloseHandle(snapshot);
    }
    Ok(())
}

// Windows has no single "pause a process" API the way POSIX has SIGSTOP - this is the standard
// approximation: suspend every thread the process owns individually. ffmpeg's screen/mic capture
// and encoding all happen on threads of this one process, so once every thread is suspended
// nothing in it can run at all until resume_process undoes this. Threads that exit between the
// snapshot and OpenThread (ffmpeg spinning up/down a worker thread at exactly the wrong moment)
// just fail OpenThread and are skipped - not a real failure, nothing to suspend there anymore.
//
// A single snapshot-then-suspend pass has the opposite race too, though: if ffmpeg spins up a
// *new* thread between the snapshot and this loop finishing, that thread is invisible to this
// pass and keeps running unsuspended while every other thread freezes - the process ends up only
// partially paused. Re-snapshotting after each pass and suspending only threads not already
// suspended converges on a fully-suspended process: once a full pass finds nothing new, nothing
// could still be spawning threads undetected. Each thread is suspended at most once - SuspendThread
// increments a per-thread suspend count, so suspending the same thread twice would need two
// matching ResumeThread calls to actually wake it, which resume_process's single blanket pass
// doesn't do. Capped at 5 passes since real convergence is 1-2 passes in practice (a thread being
// born at exactly the wrong instant, repeatedly, isn't realistic) and this must still return
// promptly for a UI-driven pause button.
pub(crate) fn suspend_process(pid: u32) -> Result<(), String> {
    use std::collections::HashSet;

    let mut suspended: HashSet<u32> = HashSet::new();
    for _ in 0..5 {
        let mut found_new = false;
        for_each_process_thread(pid, |tid| {
            if suspended.insert(tid) {
                found_new = true;
                unsafe {
                    if let Ok(handle) = OpenThread(THREAD_SUSPEND_RESUME, false, tid) {
                        SuspendThread(handle);
                        let _ = CloseHandle(handle);
                    }
                }
            }
        })?;
        if !found_new {
            break;
        }
    }
    Ok(())
}

pub(crate) fn resume_process(pid: u32) -> Result<(), String> {
    for_each_process_thread(pid, |tid| unsafe {
        if let Ok(handle) = OpenThread(THREAD_SUSPEND_RESUME, false, tid) {
            ResumeThread(handle);
            let _ = CloseHandle(handle);
        }
    })
}
