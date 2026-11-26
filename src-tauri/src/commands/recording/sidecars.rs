// Per-recording sidecars (clicks, pointer, webcam bubble, view switches) and phone-camera capture chunks.
use super::*;

// Where a recording's own click-tracking data lives, if it has any - shared between stop_recording
// (which writes it) and load_click_sidecar below (which the editor calls to read it back). Mirrors
// the ".system_audio.wav"/"_webcam.mp4" sibling-file convention this same module already uses for
// other per-recording artifacts, rather than video_edits.rs's own ".edits.json" (append-to-whole-
// filename) convention - the two sidecar families were established independently and neither
// needs to match the other, just be internally consistent.
pub(super) fn click_sidecar_path(video_path: &Path) -> PathBuf {
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    video_path.with_file_name(format!("{}.clicks.json", stem))
}

// Reads back whatever click_sidecar_path holds for `video_path`, if anything - None (not an
// error) when the video was never recorded with track_clicks on, same "no sidecar yet is normal,
// not a failure" convention load_video_edit_state (video_edits.rs) already uses.
#[tauri::command(async)]
pub fn load_click_sidecar(video_path: String) -> Result<Option<String>, String> {
    let _serial = crate::services::responsiveness::serial();
    let sidecar = click_sidecar_path(&PathBuf::from(&video_path));
    if !sidecar.exists() {
        return Ok(None);
    }
    fs::read_to_string(&sidecar)
        .map(Some)
        .map_err(|e| format!("Failed to read click-tracking sidecar: {}", e))
}

// Where a recording's editable pointer and shortcut keys live (services/input_tracker.rs) - read by
// the editor (pointerTrack.ts) to draw the pointer back and show the shortcuts. Named like the
// library's other companions (sidecars.rs) so it moves, copies and goes to the trash with the
// video: a recording parted from it would have no pointer at all.
pub(super) fn pointer_sidecar_path(video_path: &Path) -> PathBuf {
    crate::services::sidecars::sidecar_path(video_path, ".pointer.json")
}

#[tauri::command(async)]
pub fn load_pointer_sidecar(video_path: String) -> Result<Option<String>, String> {
    let sidecar = pointer_sidecar_path(&PathBuf::from(&video_path));
    if !sidecar.exists() {
        return Ok(None);
    }
    fs::read_to_string(&sidecar).map(Some).map_err(|e| format!("Failed to read the pointer sidecar: {}", e))
}

// Where the camera bubble was baked into a screen recording - its shape, anchor, size, border and
// how many cameras sat side by side - so the editor can find it exactly to fix its background
// (webcamBubble.ts recomputes the box from these with the same maths as overlay_stage_filter).
// Written when the recording starts, removed again if it comes to nothing.
pub(super) fn bubble_sidecar_path(video_path: &Path) -> PathBuf {
    let stem = video_path.file_stem().and_then(|s| s.to_str()).unwrap_or("recording");
    video_path.with_file_name(format!("{}.bubble.json", stem))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn write_bubble_sidecar(video_path: &Path, form_data: &FormData, camera_count: usize) {
    let json = serde_json::json!({
        "shape": form_data.overlay_shape,
        "position": form_data.overlay_position,
        "size": form_data.overlay_size,
        "border": form_data.overlay_border,
        "cameraCount": camera_count,
    });
    if let Err(e) = crate::services::sidecars::write_sidecar(&bubble_sidecar_path(video_path), json.to_string()) {
        warn!("Failed to write the camera bubble sidecar: {}", e);
    }
}

#[tauri::command(async)]
pub fn load_bubble_sidecar(video_path: String) -> Result<Option<String>, String> {
    let sidecar = bubble_sidecar_path(&PathBuf::from(&video_path));
    if !sidecar.exists() {
        return Ok(None);
    }
    fs::read_to_string(&sidecar).map(Some).map_err(|e| format!("Failed to read the camera bubble sidecar: {}", e))
}

// Same sidecar convention as click_sidecar_path above, for the screen<->camera view-switch
// timeline instead of clicks.
pub(super) fn view_switch_sidecar_path(video_path: &Path) -> PathBuf {
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    video_path.with_file_name(format!("{}.viewswitch.json", stem))
}

// Reads back whatever view_switch_sidecar_path holds for `video_path`, if anything - None (not an
// error) when the video was never recorded with any view switches, same convention
// load_click_sidecar above uses.
#[tauri::command(async)]
pub fn load_view_switch_sidecar(video_path: String) -> Result<Option<String>, String> {
    let _serial = crate::services::responsiveness::serial();
    let sidecar = view_switch_sidecar_path(&PathBuf::from(&video_path));
    if !sidecar.exists() {
        return Ok(None);
    }
    fs::read_to_string(&sidecar)
        .map(Some)
        .map_err(|e| format!("Failed to read view-switch sidecar: {}", e))
}

// Where a "record webcam separately" recording's own second file lives, if it has one - the
// naming convention win.rs's recording_with_output_sva establishes (`<stem>_webcam.mp4`). The
// editor calls this to find the file a view-switch timeline should cut TO. Returns None (not an
// error) if no such file exists - the normal case for any recording that didn't have
// FormData.separate_webcam_capture on, same "missing is fine" convention load_click_sidecar and
// load_view_switch_sidecar both use.
// Shared path convention for a recording's separate webcam sidecar (`<stem>_webcam.mp4`), used by
// Windows assembly, phone capture, and the macOS/Linux backends.
pub(crate) fn webcam_sidecar_path(video_path: &Path) -> PathBuf {
    let stem = video_path.file_stem().and_then(|s| s.to_str()).unwrap_or("recording");
    video_path.with_file_name(format!("{}_webcam.mp4", stem))
}

#[tauri::command(async)]
pub fn get_webcam_sidecar_path(video_path: String) -> Option<String> {
    let _serial = crate::services::responsiveness::serial();
    let path = PathBuf::from(&video_path);
    let webcam_path = webcam_sidecar_path(&path);
    if webcam_path.exists() {
        path_to_str(&webcam_path).ok().map(|s| s.to_string())
    } else {
        None
    }
}

// Where the phone-camera capture accumulates on disk while it's still being recorded. Next to
// the recording itself rather than in a temp dir so it's on the same volume as its final output.
pub(super) fn phone_capture_raw_path(video_path: &Path, mime_type: &str) -> PathBuf {
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    // MediaRecorder hands back webm, or fragmented mp4 on newer Chromium.
    let ext = if mime_type.contains("mp4") { "mp4" } else { "webm" };
    video_path.with_file_name(format!("{}_webcam_raw.{}", stem, ext))
}

// Appends one MediaRecorder chunk to the in-progress phone capture.
//
// The recording is streamed to disk a chunk at a time rather than handed over in one piece at the
// end, because the whole thing has to cross Tauri's IPC boundary as JSON. A few minutes of 1080p
// is well into the hundreds of megabytes; as a JSON array of byte-numbers that inflates roughly
// fourfold and has to be held in memory whole on both sides at once - enough to wedge or kill the
// WebView outright. Per-chunk base64 keeps each message around a megabyte, bounds memory to one
// chunk, and means a crash mid-recording leaves everything already written still on disk.
//
// `first` truncates rather than appends, so a previous run's leftovers can't be prefixed onto this
// one - the frontend sets it on the first chunk of each recording.
#[tauri::command]
pub async fn phone_camera_capture_chunk(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    // The chunk arrives as a raw body with its metadata in headers, rather than as base64 inside a
    // JSON object. Video is the one thing that genuinely does not belong in Tauri's JSON IPC: at
    // the bitrates that look good, base64 inflates every chunk by a third, has to be built as a
    // string on the WebView's main thread, and parsed back out of a multi-megabyte JSON document
    // on this side - once every couple of seconds, for the whole recording. That overhead was what
    // forced the capture bitrate down in the first place; removing it is what lets the phone layer
    // record at full quality again.
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("Phone camera chunk arrived as JSON rather than raw bytes.".to_string())
        }
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string())
    };
    let mime_type = header("x-briefcast-mime").unwrap_or_else(|| "video/webm".to_string());
    let first = header("x-briefcast-first").as_deref() == Some("1");
    // On the first chunk, resolve the destination from the recording that's actually in progress
    // and remember it; every later chunk reuses it, so the answer can't drift mid-recording (and
    // stop_recording clearing output_path can't strand the final flush).
    let target = {
        let mut guard = state.phone_capture.lock().await;
        if first || guard.is_none() {
            let video_path = state
                .output_path
                .lock()
                .await
                .clone()
                .ok_or_else(|| {
                    "No recording is in progress, so there's nowhere to save the phone camera \
                     video."
                        .to_string()
                })?;
            let resolved = PhoneCaptureTarget {
                raw_path: phone_capture_raw_path(&video_path, &mime_type),
                video_path,
                writer: Arc::new(std::sync::Mutex::new(None)),
            };
            *guard = Some(resolved.clone());
            resolved
        } else {
            guard.as_ref().unwrap().clone()
        }
    };

    // Write on a blocking thread via the persistent BufWriter<File> so chunks don't repeatedly
    // open/close the file handle on disk every second (avoiding AV rescan & metadata churn).
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = target.writer.lock().unwrap_or_else(|p| p.into_inner());
        if first || guard.is_none() {
            let file = fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(first)
                .append(!first)
                .open(&target.raw_path)
                .map_err(|e| {
                    format!(
                        "Failed to open the phone camera capture file at {}: {e}",
                        target.raw_path.display()
                    )
                })?;
            *guard = Some(std::io::BufWriter::with_capacity(256 * 1024, file));
        }
        let writer = guard.as_mut().unwrap();
        writer
            .write_all(&bytes)
            .map_err(|e| format!("Failed to write the phone camera recording: {e}"))
    })
    .await
    .map_err(|e| format!("Failed to save the phone camera recording: {e}"))?
}

// Finishes the phone-camera recording accumulated by phone_camera_capture_chunk, landing it as
// the `<stem>_webcam.mp4` sidecar that get_webcam_sidecar_path (above) and the editor's PiP layer
// already know how to find - so a phone ends up indistinguishable from a real webcam recorded
// with FormData.separate_webcam_capture, and needs no new editor code at all.
//
// `start_offset_ms` is how long after ffmpeg started that the WebView's MediaRecorder actually
// began producing frames. It's never zero: start_recording has to spawn ffmpeg and wait out its
// own early-exit check before the frontend can even begin recording the phone stream. Rather than
// leaving the editor to reconcile two files with different zero points, the gap is padded onto the
// front of the camera file here so both share a t=0 - which is exactly what the PiP overlay and
// the view-switch timeline (buildViewSwitchOverlays, videoEditHandlers.ts) already assume.
#[tauri::command]
pub async fn save_phone_camera_capture(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    start_offset_ms: f64,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;

    // Taken, not borrowed: this capture is finished either way, and leaving it behind would let a
    // later recording pick up a stale target.
    let capture = state
        .phone_capture
        .lock()
        .await
        .take()
        .ok_or_else(|| "The phone camera never recorded anything.".to_string())?;

    // Flush and close the persistent writer before ffmpeg reads the raw file.
    {
        let writer_handle = capture.writer.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Some(mut w) = writer_handle.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = w.flush();
            }
        })
        .await;
    }

    let target = capture.video_path;
    let raw_path = capture.raw_path;
    let webcam_path = webcam_sidecar_path(&target);

    match fs::metadata(&raw_path) {
        Ok(meta) if meta.len() > 0 => {}
        _ => {
            let _ = fs::remove_file(&raw_path);
            return Err("The phone camera recording came back empty.".to_string());
        }
    }

    let raw_str = path_to_str(&raw_path)?.to_string();
    let out_str = path_to_str(&webcam_path)?.to_string();

    let mut args: Vec<String> = vec!["-y".into(), "-i".into(), raw_str];

    // The frontend measures the offset from when it asked ffmpeg to start, but an assembled
    // screen recording begins at its first frame, which arrives later (GPU capture takes about a
    // second to come up) - re-based here onto that frame. Falls back to the snapshotted delay if
    // stop_recording already took `assembly` while running concurrently with this command.
    #[cfg(target_os = "windows")]
    let start_offset_ms = {
        let live_delay = {
            let parts = state.assembly.lock().await;
            parts.as_ref().and_then(|p| {
                let timing = p.timing.as_ref()?.lock().ok()?;
                Some((timing.segments(&p.pauses)?.start_hns() - p.launch_hns) as f64 / 1e4)
            })
        };
        let delay = live_delay.or_else(|| {
            *state
                .last_first_frame_delay_ms
                .lock()
                .unwrap_or_else(|p| p.into_inner())
        });
        match delay {
            Some(ms) => start_offset_ms - ms,
            None => start_offset_ms,
        }
    };

    // Line the camera file up with the screen file: pad its head when it started later, trim it
    // when it started earlier. Sub-frame offsets aren't worth a filter pass.
    let offset_secs = start_offset_ms / 1000.0;
    if offset_secs > 0.02 {
        args.push("-vf".into());
        args.push(format!(
            "tpad=start_duration={:.3}:start_mode=add:color=black",
            offset_secs
        ));
    } else if offset_secs < -0.02 {
        args.push("-vf".into());
        args.push(format!("trim=start={:.3},setpts=PTS-STARTPTS", -offset_secs));
    }

    // A WebRTC-sourced MediaRecorder file is variable-frame-rate and, for webm, carries no
    // duration in its header at all (it was written as a live stream). Both are re-encoded away
    // here into a plain CFR mp4, which is what the editor's seeking assumes. Hardware encoding
    // when the machine has it, for the same reason the main recording path uses it.
    let hw = crate::services::hw_encoder::detect(&ffmpeg_path);
    let mut keep_pix_fmt = true;

    match hw {
        Some(encoder) => {
            if encoder.is_vaapi() {
                // Prepend `-vaapi_device` before `-i` and upload frames in the filter graph.
                let pre = encoder.pre_input_args();
                args.splice(0..0, pre);
                if let Some(vf_idx) = args.iter().position(|a| a == "-vf") {
                    if let Some(vf_val) = args.get_mut(vf_idx + 1) {
                        vf_val.push_str(",format=nv12,hwupload");
                    }
                } else {
                    args.push("-vf".into());
                    args.push("format=nv12,hwupload".into());
                }
                keep_pix_fmt = false;
            }
            args.push("-c:v".into());
            args.push(encoder.name().to_string());
            args.extend(encoder.high_quality_args());
        }
        _ => {
            args.push("-c:v".into());
            args.push("libx264".into());
            args.push("-preset".into());
            args.push("faster".into());
            args.push("-crf".into());
            args.push("18".into());
        }
    }

    args.extend([
        // CFR, but at whatever rate the source actually ran at rather than a hardcoded 30 - a
        // phone sending 60fps was previously having half its frames thrown away here. `-fps_mode
        // cfr` alone still produces a constant rate (which is what the editor's seeking wants),
        // it just derives it from the input instead of overriding it.
        "-fps_mode".to_string(),
        "cfr".to_string(),
    ]);
    if keep_pix_fmt {
        args.extend(["-pix_fmt".to_string(), "yuv420p".to_string()]);
    }
    args.extend([
        // The editor scrubs this file; without a relocated moov it has to read to the end first.
        "-movflags".to_string(),
        "+faststart".to_string(),
        // The phone sends video only (the page requests audio:false - the mic stays whichever
        // device the user picked on the PC), so there is deliberately no audio stream to map.
        "-an".to_string(),
        out_str,
    ]);

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.args(&args);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    hide_console_window(&mut cmd);

    let output = tauri::async_runtime::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| format!("Failed to run ffmpeg for the phone camera recording: {e}"))?
        .map_err(|e| format!("Failed to run ffmpeg for the phone camera recording: {e}"))?;

    if !output.status.success() {
        // Deliberately NOT cleaned up on failure. The raw file is the only copy of footage the
        // user cannot re-shoot - whatever went wrong in the conversion, throwing the recording
        // away on top of it is strictly worse. Tell them where it is instead.
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!(
            "Phone camera conversion failed, raw capture kept at {:?}: {}",
            raw_path,
            stderr
        );
        return Err(format!(
            "Couldn't convert the phone camera recording ({}). The raw footage was kept at {} - \
             it will play in VLC, and Briefcast can import it.",
            stderr.lines().last().unwrap_or("unknown ffmpeg error"),
            raw_path.display()
        ));
    }

    let _ = fs::remove_file(&raw_path);
    info!("Phone camera recording saved to {:?}", webcam_path);
    out_str_owned(&webcam_path)
}

// Small helper so save_phone_camera_capture can return an owned path string without borrowing a
// temporary - path_to_str hands back a &str tied to its argument.
pub(super) fn out_str_owned(path: &Path) -> Result<String, String> {
    path_to_str(path).map(|s| s.to_string())
}

