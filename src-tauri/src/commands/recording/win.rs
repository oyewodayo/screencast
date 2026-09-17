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

use super::{
    audio_codec_args_for_ext, build_camera_overlay_filter_complex, codec_args_for_ext,
    extract_ffmpeg_error, map_overlay_size, resolve_capture_target, silent_command, AppState,
    CaptureTarget, FormData, AUDIO_ENHANCE_FILTER,
};
use crate::services::hw_encoder;
use crate::services::process_job;
use crate::services::progress_watch;
use crate::services::utility::{get_ffmpeg_path, path_to_str};

// Downscale flag for the plain (no camera overlay) desktop-capture path - when a camera overlay
// IS in play, the equivalent downscale is instead the final stage of
// build_camera_overlay_filter_complex's own filter_complex, since ffmpeg rejects a separate -vf
// on the same output stream a -filter_complex already produces video for. `max_width` is
// FormData.resolution_width already resolved via super::resolved_max_width - see its own doc
// comment for how a "native" request is represented.
fn desktop_scale_args(max_width: i32) -> Vec<String> {
    vec![
        "-vf".to_string(),
        format!("scale='min({},iw)':-2", max_width),
    ]
}

// Swaps codec_args_for_ext's software video-encode segment (`-c:v libx264 -preset ultrafast
// [-crf N]`) for a detected hardware encoder's own, when one actually works on this machine (see
// services/hw_encoder.rs) - CPU usage on a long/high-res recording is the single biggest
// encoding-side complaint this app's software-only libx264 path has (see
// RECORDING_UPGRADE_NOTES.md). Only for the h264-targeting containers that path already covers
// (mp4/mkv/avi/mov); webm's target codec is VP8, which has no equivalent widely-available
// hardware path, so it's left on software regardless. Finds the software segment by locating
// "-pix_fmt" (which immediately follows it in every one of those four branches) rather than
// hardcoding each branch's exact offset, so this stays correct if codec_args_for_ext's own args
// ever get reordered.
fn codec_args_for_ext_hw(ext: &str, ffmpeg_path: &std::path::Path) -> Vec<String> {
    let args = codec_args_for_ext(ext);
    if !matches!(ext.to_lowercase().as_str(), "mp4" | "mkv" | "avi" | "mov") {
        return args;
    }
    let Some(encoder) = hw_encoder::detect(ffmpeg_path) else {
        return args;
    };
    let Some(cv_idx) = args.iter().position(|a| a == "-c:v") else {
        return args;
    };
    let Some(pix_fmt_idx) = args.iter().position(|a| a == "-pix_fmt") else {
        return args;
    };
    if pix_fmt_idx <= cv_idx {
        return args;
    }

    let mut patched = args[..cv_idx].to_vec();
    patched.push("-c:v".to_string());
    patched.push(encoder.name().to_string());
    patched.extend(encoder.quality_args());
    patched.extend(args[pix_fmt_idx..].iter().cloned());
    patched
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

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.args(["-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
    super::hide_console_window(&mut cmd);
    let output = match cmd.output() {
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
            "-f".to_string(),
            "dshow".to_string(),
            "-video_size".to_string(),
            overlay_size.clone(),
            "-i".to_string(),
            format!("video={}", device),
        ]);
    }

    let filter_complex = build_camera_overlay_filter_complex(
        &form_data.overlay_shape,
        &form_data.overlay_position,
        &form_data.overlay_size,
        form_data.video_devices.len(),
        super::resolved_max_width(form_data),
        None,
    );

    args.extend(vec!["-filter_complex".to_string(), filter_complex]);
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

    let max_width = super::resolved_max_width(form_data);
    let mut args: Vec<String> = vec![
        "-progress".to_string(),
        path_to_str(&progress_sidecar)?.to_string(),
        "-f".to_string(),
        "gdigrab".to_string(),
        "-framerate".to_string(),
        form_data.framerate.unwrap_or(60).to_string(),
    ];

    args.extend(gdigrab_input_args(&resolve_capture_target(
        app_handle, form_data,
    ))?);

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
    if has_camera_overlay && !separate_webcam_capture {
        log::debug!("{} camera(s) overlaid", form_data.video_devices.len());
        add_overlay_args(&mut args, form_data);
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
    }

    // Audio is now always its own standalone input - previously it was bundled into the single
    // camera's dshow input line (video=X:audio=Y), which only worked for exactly one camera.
    args.extend(vec![
        "-f".to_string(),
        "dshow".to_string(),
        "-i".to_string(),
        format!("audio={}", form_data.audio_device),
    ]);

    // Downscale the raw desktop capture - only when there's no BAKED-IN camera overlay, whose own
    // filter_complex (add_overlay_args, above) already ends with this same downscale as its final
    // stage. ffmpeg rejects a -vf here alongside a -filter_complex already producing video - the
    // separate-capture case below builds its own filter_complex for exactly this reason too.
    if !has_camera_overlay {
        args.extend(desktop_scale_args(max_width));
    } else if separate_webcam_capture {
        args.extend(vec![
            "-filter_complex".to_string(),
            format!("[0:v]scale='min({},iw)':-2[scr]", max_width),
        ]);
    }

    // Add codec flags based on file extension. Used to be its own inline copy of this match
    // (kept separate from codec_args_for_ext per this module's original "leave Windows as-is"
    // policy) - now unified with it since both needed the same fix (missing -b:a on mkv/webm
    // meant those fell back to noticeably-more-compressed default bitrates), so keeping two
    // copies in sync stopped being worth it.
    if separate_webcam_capture {
        // [scr] (the scaled screen) plus the mic audio input (index 2, since the raw camera sits
        // at index 1) - explicit -map is required once a -filter_complex is in play, unlike the
        // plain-desktop-capture branch above where ffmpeg's own default stream selection is enough.
        args.extend(vec![
            "-map".to_string(),
            "[scr]".to_string(),
            "-map".to_string(),
            "2:a".to_string(),
        ]);
    }
    args.extend(codec_args_for_ext_hw(&form_data.file_ext, &ffmpeg_path));
    // Evens out quiet/inconsistent mic levels - see AUDIO_ENHANCE_FILTER's doc comment.
    args.extend(vec!["-af".to_string(), AUDIO_ENHANCE_FILTER.to_string()]);

    let output_file = path_to_str(output_path)?.to_string();

    log::debug!("Output file: {}", output_file);

    // Add output file
    args.push(output_file.clone());

    // Second output, same ffmpeg process: the raw camera stream (input index 1), video-only (no
    // audio - the mic already went to the primary output above, and doubling it here would just
    // mix the same track twice if this ever got composited back in). Always .mp4 regardless of
    // the user's chosen file_ext for the main recording - this is an internal editor artifact, not
    // the deliverable, so it doesn't need to match. A simple, fast preset is enough: this is a
    // small-resolution (overlay_size) source, not the full desktop capture.
    if separate_webcam_capture {
        let webcam_output = output_path.with_file_name(format!(
            "{}_webcam.mp4",
            output_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("recording")
        ));
        args.extend(vec![
            "-map".to_string(),
            "1:v".to_string(),
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
    let mut cmd = Command::new(&ffmpeg_path);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    super::hide_console_window(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    process_job::assign_to_job(&child);
    let pid = child.id();

    // Store the process in state
    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }
    progress_watch::watch(app_handle.clone(), progress_sidecar, state.ffmpeg_process.clone(), pid);

    log::debug!("FFmpeg process started successfully");

    Ok(format!(
        "Recording started. File will be saved as:\n{}",
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

    // 200 was never a real target — gdigrab can't actually deliver anywhere near that from a
    // desktop source, it just means ffmpeg burns extra CPU polling far faster than any monitor
    // refreshes, which eats into the budget the encoder needs to keep up in real time. 30fps is
    // what screen-recording/tutorial content actually needs, and is still the default below.
    let max_width = super::resolved_max_width(form_data);
    let mut args: Vec<String> = vec![
        "-progress".to_string(),
        path_to_str(&progress_sidecar)?.to_string(),
        "-f".to_string(),
        "gdigrab".to_string(),
        "-framerate".to_string(),
        form_data.framerate.unwrap_or(30).to_string(),
    ];
    args.extend(gdigrab_input_args(&resolve_capture_target(
        app_handle, form_data,
    ))?);
    args.extend(vec![
        "-f".to_string(),
        "dshow".to_string(),
        "-i".to_string(),
        format!("audio={}", form_data.audio_device),
    ]);
    // Downscale the raw desktop capture - see desktop_scale_args' doc comment.
    args.extend(desktop_scale_args(max_width));
    // Previously had no codec flags at all here, leaving both streams to ffmpeg's per-container
    // defaults - which measured out to a 200kbps video bitrate for a 4K capture (badly
    // blocky) and default-quality MP3 audio, inconsistent with every other recording mode.
    args.extend(codec_args_for_ext_hw(&form_data.file_ext, &ffmpeg_path));
    args.extend(vec!["-af".to_string(), AUDIO_ENHANCE_FILTER.to_string()]);
    args.extend(vec![
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ]);

    log::debug!("Path {:?}", output_path);
    let child = silent_command(&ffmpeg_path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    process_job::assign_to_job(&child);
    let pid = child.id();

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }
    progress_watch::watch(app_handle.clone(), progress_sidecar, state.ffmpeg_process.clone(), pid);

    Ok(format!(
        "Recording started. File will be saved to {}",
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
    let video_device = form_data.video_devices.first().cloned().unwrap_or_default();

    let mut args: Vec<String> = vec![
        "-progress".to_string(),
        path_to_str(&progress_sidecar)?.to_string(),
        "-f".to_string(),
        "dshow".to_string(),
        "-i".to_string(),
        format!("video={}", video_device),
    ];
    args.extend(codec_args_for_ext_hw(&form_data.file_ext, &ffmpeg_path));
    args.push("-y".to_string());
    args.push(path_to_str(output_path)?.to_string());

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.args(&args).stdin(Stdio::piped());
    super::hide_console_window(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    process_job::assign_to_job(&child);
    let pid = child.id();

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }
    progress_watch::watch(app_handle.clone(), progress_sidecar, state.ffmpeg_process.clone(), pid);

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
        "-f".to_string(),
        "dshow".to_string(),
        "-i".to_string(),
        format!("audio={}", form_data.audio_device),
    ];
    // Previously had no codec flags at all - left to ffmpeg's per-container default, which for
    // .mp3 measured out to 128k, same gap as every other mode fixed above.
    args.extend(audio_codec_args_for_ext(&form_data.file_ext));
    args.extend(vec!["-af".to_string(), AUDIO_ENHANCE_FILTER.to_string()]);
    args.extend(vec![
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ]);

    let child = silent_command(&ffmpeg_path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    process_job::assign_to_job(&child);
    let pid = child.id();

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }
    progress_watch::watch(app_handle.clone(), progress_sidecar, state.ffmpeg_process.clone(), pid);

    Ok(format!(
        "Recording started. File will be saved to {}",
        output_path.display()
    ))
}

//Video and audio
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
    let video_device = form_data.video_devices.first().cloned().unwrap_or_default();

    let mut args: Vec<String> = vec![
        "-progress".to_string(),
        path_to_str(&progress_sidecar)?.to_string(),
        "-f".to_string(),
        "dshow".to_string(),
        "-i".to_string(),
        format!("video={}:audio={}", video_device, form_data.audio_device),
    ];
    args.extend(codec_args_for_ext_hw(&form_data.file_ext, &ffmpeg_path));
    args.extend(vec!["-af".to_string(), AUDIO_ENHANCE_FILTER.to_string()]);
    args.push("-y".to_string());
    args.push(path_to_str(output_path)?.to_string());

    let child = silent_command(&ffmpeg_path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    process_job::assign_to_job(&child);
    let pid = child.id();

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }
    progress_watch::watch(app_handle.clone(), progress_sidecar, state.ffmpeg_process.clone(), pid);

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

    // Same framerate fix as recording_with_output_sa - 200 was never reachable, just wasted CPU.
    let max_width = super::resolved_max_width(form_data);
    let mut args: Vec<String> = vec![
        "-progress".to_string(),
        path_to_str(&progress_sidecar)?.to_string(),
        "-f".to_string(),
        "gdigrab".to_string(),
        "-framerate".to_string(),
        form_data.framerate.unwrap_or(30).to_string(),
    ];
    args.extend(gdigrab_input_args(&resolve_capture_target(
        app_handle, form_data,
    ))?);
    // Downscale the raw desktop capture - see desktop_scale_args' doc comment.
    args.extend(desktop_scale_args(max_width));
    // This used to have no codec flags at all, leaving the video stream to ffmpeg's implicit
    // per-container default encoder (e.g. plain mpeg4 for .mp4) instead of libx264 - a real,
    // separate cause of poor quality/efficiency for screen-only recordings specifically, not
    // just the missing downscale/framerate fix above.
    args.extend(codec_args_for_ext_hw(&form_data.file_ext, &ffmpeg_path));
    args.extend(vec![
        "-y".to_string(),
        path_to_str(output_path)?.to_string(),
    ]);

    log::debug!("Path {:?}", output_path);
    let child = silent_command(&ffmpeg_path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    process_job::assign_to_job(&child);
    let pid = child.id();

    {
        let mut process_state = state.ffmpeg_process.lock().await;
        *process_state = Some(child);
    }
    progress_watch::watch(app_handle.clone(), progress_sidecar, state.ffmpeg_process.clone(), pid);

    Ok(format!(
        "Recording started. File will be saved to {}",
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
