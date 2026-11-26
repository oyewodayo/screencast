// Audio conversion, timeline audio extraction/cleanup/mixdown, silence/beat detection, and subject tracking.
use super::*;

// Convert an audio file between mp3/wav/aac/flac/ogg/m4a. -vn drops any video stream before
// encoding - many mp3/m4a files carry embedded cover art as an attached-picture "video" stream,
// which would otherwise get passed through (or rejected outright by formats like wav/flac that
// don't support attachments at all) instead of producing a clean audio-only output.
#[tauri::command]
pub async fn convert_audio(
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
        "mp3" => vec!["-vn", "-c:a", "libmp3lame", "-b:a", "192k"],
        "wav" => vec!["-vn", "-c:a", "pcm_s16le"],
        "aac" => vec!["-vn", "-c:a", "aac", "-b:a", "192k"],
        "flac" => vec!["-vn", "-c:a", "flac"],
        "ogg" => vec!["-vn", "-c:a", "libvorbis", "-q:a", "5"],
        "m4a" => vec!["-vn", "-c:a", "aac", "-b:a", "192k"],
        _ => return Err(format!("Unsupported output format: {}", output_format)),
    };

    let result = run_conversion(
        &app_handle,
        &window,
        &state,
        &[InputSpec::plain(input_path.clone())],
        &input_path,
        output,
        &codec_args,
    )
    .await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
}

// rename_all is needed here (unlike this command's own top-level camelCase args, which Tauri's
// invoke_handler macro converts automatically) because this struct is deserialized as the
// *value* of the `segments` array by serde directly, not through that per-command conversion -
// without it, the frontend's `sourcePath` would fail to match `source_path`.
// A per-segment color grade - see color_filter_chain, applied to that segment's own trim step
// before concat so different clips can carry different looks. `preset` mirrors
// ColorFilterPreset (videoEditTypes.ts) as a plain string rather than a Rust enum - same
// "trust the frontend's own validated union, match on &str with a catch-all" convention this
// file has no existing enum-from-string precedent to follow, so a string keeps the two sides
// in sync with a one-line match arm instead of a serde enum needing its own rename mapping.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipColorFilter {
    pub preset: String,
    pub intensity: f64, // 0..1
}

// Extracts one timeline clip's own audio to a standalone file - the audio-only counterpart of
// export_trimmed_video's single-segment fast path, minus any video stream at all (`-vn`). Always
// goes through the atrim/atempo/afftdn filter chain (never a bare -ss/-to copy) since there's no
// "no effects at all" shortcut worth having here: an audio-only encode is already cheap regardless
// of whether a filter runs, unlike the video fast path this mirrors.
#[tauri::command]
pub async fn extract_clip_audio(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    source_path: String,
    start: f64,
    end: f64,
    // Same 0.25..4 clamp segment_speed applies to a KeepSegment - this command has no KeepSegment
    // of its own (the frontend passes the clip's own fields directly), so the clamp is inlined
    // below rather than routed through that helper.
    speed: f64,
    noise_reduction: Option<f64>,
    audio_cleanup: Option<AudioCleanup>,
    // Already folds mute into 0.0 on the frontend (Clip.ts's own effective-volume convention,
    // matching pipOverlays/effective_video_volume elsewhere in this file) - no separate `muted`
    // bool here.
    volume: f64,
    output_format: String, // "mp3" | "wav" | "aac"
    output_path: String,
    // Which audio stream to take (`0:a:N`, see audio_tracks::probe_audio_streams). None keeps
    // ffmpeg's own default pick - the single "best" audio stream - which silently ignores any
    // others in a multi-track file.
    stream_index: Option<u32>,
    // An audio track's own fades and mixer effects, for saving one piece as it sounds on the
    // timeline - applied after the volume, the export's order (volume, fades, then effects).
    fade_in: Option<f64>,
    fade_out: Option<f64>,
    fx: Option<AudioFxSpec>,
) -> Result<String, String> {
    if end <= start {
        return Err("End must be after start".to_string());
    }
    let speed = speed.max(0.25).min(16.0);
    let out_duration = (end - start) / speed;
    // "Detach audio" writes into the app cache dir, which may not exist yet on a fresh install.
    if let Some(parent) = PathBuf::from(&output_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create output folder: {}", e))?;
    }

    let rnnoise_model = crate::services::utility::get_rnnoise_model_path(&app_handle)
        .ok()
        .filter(|p| p.exists())
        .map(|p| escape_filter_path(&p));
    let sample = cleanup_noise_sample(noise_reduction, audio_cleanup.as_ref(), rnnoise_model.as_deref());
    let mut filters = audio_cleanup_filters_with_sample(
        noise_reduction,
        audio_cleanup.as_ref(),
        rnnoise_model.as_deref(),
        sample.map(|(s, e)| e - s),
    );
    if (volume - 1.0).abs() > 0.001 {
        filters.push(format!("volume={:.3}", volume.max(0.0)));
    }
    if let Some(d) = fade_in.filter(|d| *d > 0.0) {
        filters.push(format!("afade=t=in:st=0:d={:.3}", d.min(out_duration)));
    }
    if let Some(d) = fade_out.filter(|d| *d > 0.0) {
        let d = d.min(out_duration);
        filters.push(format!("afade=t=out:st={:.3}:d={:.3}", out_duration - d, d));
    }
    if let Some(fx) = &fx {
        let fx_filters = audio_fx_filters(fx);
        // Balance works on two channels - a mono file is spread to both first.
        if fx.pan.map_or(false, |p| p.abs() > 1e-4) {
            filters.push("aformat=channel_layouts=stereo".to_string());
        }
        filters.extend(fx_filters);
    }
    // Same branch builder as the export (audio_branch) - a filter graph rather than a plain -af so
    // a noise sample can be split off the same input and prepended.
    let input_label = match stream_index {
        Some(n) => format!("[0:a:{}]", n),
        None => "[0:a]".to_string(),
    };
    let graph = audio_branch(&input_label, start, end, speed, &filters, sample, "xa");

    let codec_args: Vec<&str> = match output_format.to_lowercase().as_str() {
        "mp3" => vec!["-c:a", "libmp3lame", "-b:a", "192k"],
        "wav" => vec!["-c:a", "pcm_s16le"],
        "aac" => vec!["-c:a", "aac", "-b:a", "192k"],
        _ => return Err(format!("Unsupported audio format: {}", output_format)),
    };

    let mut owned_args: Vec<String> = vec![
        "-filter_complex".to_string(),
        graph.trim_end_matches(';').to_string(),
        "-map".to_string(),
        "[xa]".to_string(),
        "-vn".to_string(),
    ];
    owned_args.extend(codec_args.iter().map(|s| s.to_string()));
    let args: Vec<&str> = owned_args.iter().map(String::as_str).collect();

    run_conversion(
        &app_handle,
        &window,
        &state,
        &[InputSpec::plain(source_path.clone())],
        &source_path,
        PathBuf::from(output_path),
        &args,
    )
    .await
}

// An audio track's own noise clean-up (Reduce/Remove, low-cut, hum, gate, levelling - the same
// chain a clip's sound gets, through extract_clip_audio) rendered once for the WHOLE file, so the
// track keeps its trims and timing and simply plays this file instead - in the preview and the
// export alike, so what is heard while editing is exactly what is saved. Cached by the source
// (path, size, modified time) and the settings; written to a .partial first so an interrupted run
// never passes for a finished one.
#[tauri::command]
pub async fn clean_audio_track(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    source_path: String,
    source_duration: f64,
    noise_reduction: Option<f64>,
    audio_cleanup: Option<AudioCleanup>,
) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    if !(source_duration.is_finite() && source_duration > 0.0) {
        return Err("The track's length isn't known.".to_string());
    }
    let meta = std::fs::metadata(&source_path).map_err(|e| format!("Couldn't read the track: {e}"))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source_path.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).hash(&mut hasher);
    format!("{:.4}", noise_reduction.unwrap_or(0.0)).hash(&mut hasher);
    serde_json::to_string(&audio_cleanup).unwrap_or_default().hash(&mut hasher);
    let dir = std::env::temp_dir().join("briefcast_preview_cache").join("cleaned_audio_v1");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the clean-up cache: {e}"))?;
    let finished = dir.join(format!("{:016x}.wav", hasher.finish()));
    if finished.exists() {
        return path_to_str(&finished).map(|s| s.to_string());
    }
    let partial = finished.with_extension("partial.wav");
    let _ = std::fs::remove_file(&partial);
    let written = extract_clip_audio(
        app_handle,
        window,
        state,
        source_path,
        0.0,
        source_duration,
        1.0,
        noise_reduction,
        audio_cleanup,
        1.0,
        "wav".to_string(),
        path_to_str(&partial)?.to_string(),
        None,
        None,
        None,
        None,
    )
    .await?;
    std::fs::rename(&written, &finished).map_err(|e| format!("Couldn't store the cleaned track: {e}"))?;
    path_to_str(&finished).map(|s| s.to_string())
}

// One sound playing on the timeline over a stretch - for render_timeline_audio.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineAudioPiece {
    pub source_path: String,
    // Seconds into the source, and where that lands in the rendered stretch.
    pub source_start: f64,
    pub source_end: f64,
    pub at: f64,
    #[serde(default = "one")]
    pub speed: f64,
    #[serde(default = "one")]
    pub volume: f64,
}

// What the timeline sounded like over a stretch - every piece of sound playing in it, trimmed,
// re-timed, levelled and laid at its place, mixed to mono 48 kHz float - as the reference the bleed
// remover subtracts from a voice take (src/utils/bleed). Pieces whose file has no sound are skipped;
// nothing sounding at all gives silence. Answered as raw little-endian f32 samples of exactly
// `duration` - asked for a stretch at a time, so a long take never becomes one huge file or buffer.
#[tauri::command]
pub async fn render_timeline_audio(app_handle: AppHandle, pieces: Vec<TimelineAudioPiece>, duration: f64) -> Result<tauri::ipc::Response, String> {
    if !(duration.is_finite() && duration > 0.0) {
        return Err("Nothing to render.".to_string());
    }
    let ffmpeg = get_ffmpeg_path(&app_handle)?;
    let ffprobe = get_ffprobe_path(&app_handle)?;
    tauri::async_runtime::spawn_blocking(move || {
        let has_audio = |path: &str| Path::new(path).exists() && probe_has_audio(&ffprobe, path);
        mix_timeline_pcm(&ffmpeg, &pieces, duration, &has_audio).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| format!("Render task panicked: {e}"))?
}

// render_timeline_audio's work: the raw little-endian f32 bytes. `has_audio` says which pieces'
// files are worth reading (a caller rendering many stretches asks once per file).
pub(crate) fn mix_timeline_pcm(ffmpeg: &Path, pieces: &[TimelineAudioPiece], duration: f64, has_audio: &dyn Fn(&str) -> bool) -> Result<Vec<u8>, String> {
    let mut args: Vec<String> = Vec::new();
    let mut graph = String::new();
    let mut labels = String::new();
    let mut n = 0;
    for p in pieces {
        let length = (p.source_end - p.source_start).max(0.0);
        if length < 0.01 || !has_audio(&p.source_path) {
            continue;
        }
        args.extend(["-ss".into(), format!("{:.6}", p.source_start.max(0.0)), "-t".into(), format!("{:.6}", length), "-i".into(), p.source_path.clone()]);
        let speed = if p.speed.is_finite() && p.speed > 0.0 { p.speed } else { 1.0 };
        graph.push_str(&format!(
            "[{n}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,{tempo},volume={vol:.4},adelay={delay:.0}:all=1[p{n}];",
            tempo = atempo_chain(speed),
            vol = p.volume.max(0.0),
            delay = (p.at.max(0.0) * 1000.0).round()
        ));
        labels.push_str(&format!("[p{n}]"));
        n += 1;
    }
    if n == 0 {
        args.extend(["-f".into(), "lavfi".into(), "-i".into(), "anullsrc=r=48000:cl=mono".into(), "-t".into(), format!("{:.6}", duration)]);
    } else {
        graph.push_str(&format!("{labels}amix=inputs={n}:normalize=0:duration=longest,apad,atrim=0:{duration:.6}[out]"));
        args.extend(["-filter_complex".into(), graph, "-map".into(), "[out]".into()]);
    }
    args.extend(["-ac".into(), "1".into(), "-ar".into(), "48000".into(), "-f".into(), "f32le".into(), "pipe:1".into()]);
    let mut cmd = Command::new(ffmpeg);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.args(["-hide_banner", "-nostdin", "-v", "error"]).args(&args);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {e}"))?;
    if !out.status.success() {
        let reason = String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("unknown error").to_string();
        return Err(format!("Couldn't render what the timeline played: {reason}"));
    }
    let mut bytes = out.stdout;
    bytes.resize((duration * 48000.0).round() as usize * 4, 0);
    Ok(bytes)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SilentRange {
    pub start: f64,
    pub end: f64,
}

// Runs ffmpeg's own `silencedetect` audio filter over the WHOLE source file (never scoped to one
// clip's own [start,end) - the frontend intersects these against whichever clip's current trim
// window is in play instead, see removeSilentRanges/videoEditHandlers.ts, so the same detection
// result stays valid even if that clip gets trimmed differently afterward). `-f null -` discards
// the re-encoded output entirely - only silencedetect's own stderr log lines are ever read.
#[tauri::command]
pub async fn detect_silence(
    app_handle: AppHandle,
    input_path: String,
    // dB threshold below which audio counts as "silent", and the minimum duration (seconds) a
    // silent stretch must last to be reported - both mirror ffmpeg's own `silencedetect` filter
    // options 1:1. Defaults (-30dB, 0.5s) are deliberately conservative: they catch genuine dead
    // air/pauses without flagging brief natural gaps between words as separate silent ranges.
    noise_db: Option<f64>,
    min_duration: Option<f64>,
) -> Result<Vec<SilentRange>, String> {
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Err(format!("Input file does not exist: {}", input_path));
    }
    let noise_db = noise_db.unwrap_or(-30.0);
    let min_duration = min_duration.unwrap_or(0.5).max(0.05);

    let ffprobe_path = get_ffprobe_path(&app_handle)?;
    let app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let duration = probe_duration_secs(&ffprobe_path, &input).unwrap_or(0.0);
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.args(["-nostdin", "-i"]).arg(&input_path);
        cmd.args([
            "-vn",
            "-af",
            &format!("silencedetect=noise={noise_db}dB:d={min_duration}"),
            "-f",
            "null",
            "-",
        ]);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        let stderr = child.stderr.take().ok_or("ffmpeg gave no log")?;
        // Read as it runs: the silence lines kept (only those - a long file's log is long), and
        // ffmpeg's own "time=" stamps reported as progress ("audio-job-progress", "silence:<path>").
        // silencedetect logs regardless of the overall exit status (a `-f null -` "encode"
        // succeeds as long as the input decodes at all).
        let key = format!("silence:{input_path}");
        let mut kept = String::new();
        let mut line = Vec::new();
        let mut last = std::time::Instant::now();
        for byte in std::io::Read::bytes(BufReader::new(stderr)) {
            let Ok(byte) = byte else { break };
            if byte != b'\n' && byte != b'\r' {
                line.push(byte);
                continue;
            }
            let text = String::from_utf8_lossy(&line).to_string();
            line.clear();
            if text.contains("silence_") {
                kept.push_str(&text);
                kept.push('\n');
            } else if duration > 0.0 && last.elapsed().as_millis() > 250 {
                if let Some(t) = text.split("time=").nth(1).and_then(|r| parse_ffmpeg_clock(r.split_whitespace().next().unwrap_or(""))) {
                    last = std::time::Instant::now();
                    emit_job_progress(&app, &key, (t / duration).min(0.99));
                }
            }
        }
        let _ = child.wait();
        emit_job_progress(&app, &key, 1.0);
        Ok(parse_silence_ranges(&kept))
    })
    .await
    .map_err(|e| format!("Silence detection task panicked: {}", e))?
}

// "01:02:03.45" (ffmpeg's progress clock) -> seconds.
pub(super) fn parse_ffmpeg_clock(clock: &str) -> Option<f64> {
    let parts: Vec<&str> = clock.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    Some(parts[0].parse::<f64>().ok()? * 3600.0 + parts[1].parse::<f64>().ok()? * 60.0 + parts[2].parse::<f64>().ok()?)
}

// Parses ffmpeg silencedetect's own stderr log lines:
//   [silencedetect @ 0x...] silence_start: 12.345
//   [silencedetect @ 0x...] silence_end: 15.678 | silence_duration: 3.333
// into paired (start,end) ranges. A trailing silence_start with no matching silence_end (the file
// ends while still silent) is dropped rather than guessed at - callers only ever want ranges with
// a real, detected end.
pub(super) fn parse_silence_ranges(stderr: &str) -> Vec<SilentRange> {
    let mut ranges = Vec::new();
    let mut pending_start: Option<f64> = None;
    for line in stderr.lines() {
        if let Some(rest) = line.split("silence_start:").nth(1) {
            if let Ok(start) = rest
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or("")
                .parse::<f64>()
            {
                pending_start = Some(start);
            }
        } else if let Some(rest) = line.split("silence_end:").nth(1) {
            let end_str = rest.split('|').next().unwrap_or("").trim();
            if let (Some(start), Ok(end)) = (pending_start.take(), end_str.parse::<f64>()) {
                if end > start {
                    ranges.push(SilentRange { start, end });
                }
            }
        }
    }
    ranges
}

// ---- Unit tests -------------------------------------------------------------------------------
//
// Covers the pure, deterministic filter-string builders/sanitizers/parsers in this file - no
// ffmpeg/ffprobe process spawned, no Tauri AppHandle/Window needed. These are the functions a
// future Tauri version bump (or any other refactor) should be able to leave completely unchanged;
// if one of these tests breaks, the export's actual OUTPUT changed, not just its plumbing.
// Runs ffmpeg to completion and returns its raw stdout - for the small f32le PCM/envelope streams
// the audio-cleanup UI reads back (never for anything video-sized).
pub(super) async fn run_ffmpeg_capture(ffmpeg_path: PathBuf, args: Vec<String>) -> Result<Vec<u8>, String> {
    blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.args(&args);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let out = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let reason = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("unknown error").to_string();
            return Err(format!("ffmpeg failed: {}", reason));
        }
        Ok(out.stdout)
    })
    .await?
}

pub(super) fn f32le_to_vec(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

// Peak of each channel per bucket, for interleaved stereo frames. Kept pure for testing.
pub(super) fn bucket_peaks(frames: &[f32], buckets: usize) -> Vec<f32> {
    let n = frames.len() / 2;
    let mut out = vec![0f32; buckets * 2];
    if n == 0 || buckets == 0 {
        return out;
    }
    for b in 0..buckets {
        let from = b * n / buckets;
        let to = ((b + 1) * n / buckets).max(from + 1).min(n);
        let (mut l, mut r) = (0f32, 0f32);
        for i in from..to {
            l = l.max(frames[i * 2].abs());
            r = r.max(frames[i * 2 + 1].abs());
        }
        out[b * 2] = l;
        out[b * 2 + 1] = r;
    }
    out
}

// Before/after envelope for the audio-cleanup popover's waveform: the clip's original audio and
// the same audio through the EXACT export chain (audio_branch + audio_cleanup_filters), so what the
// view shows as removed is what export removes. Returns raw little-endian f32 pairs
// [original, cleaned] per bucket - each the peak of a rectified, low-passed envelope (|x| averaged
// down by aresample), which reads like a loudness contour rather than spiky sample peaks.
// Seeks the input to whichever comes first, the clip or its noise sample, so a clip deep into a
// long recording doesn't decode everything before it.
#[tauri::command]
pub async fn audio_cleanup_waveform(
    app_handle: AppHandle,
    source_path: String,
    start: f64,
    end: f64,
    noise_reduction: Option<f64>,
    audio_cleanup: Option<AudioCleanup>,
    buckets: u32,
) -> Result<tauri::ipc::Response, String> {
    if !(end > start) {
        return Err("End must be after start".to_string());
    }
    let buckets = buckets.clamp(16, 4000) as usize;
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let rnnoise_model = crate::services::utility::get_rnnoise_model_path(&app_handle)
        .ok()
        .filter(|p| p.exists())
        .map(|p| escape_filter_path(&p));
    let sample = cleanup_noise_sample(noise_reduction, audio_cleanup.as_ref(), rnnoise_model.as_deref());
    let filters = audio_cleanup_filters_with_sample(
        noise_reduction,
        audio_cleanup.as_ref(),
        rnnoise_model.as_deref(),
        sample.map(|(s, e)| e - s),
    );

    let offset = sample.map_or(start, |(s, _)| s.min(start)).max(0.0);
    let span_end = sample.map_or(end, |(_, e)| e.max(end));
    let shifted_sample = sample.map(|(s, e)| (s - offset, e - offset));
    let (s, e) = (start - offset, end - offset);
    let duration = end - start;
    // ~16 envelope samples per bucket is plenty; bounded so a long clip stays a small transfer.
    let rate = ((buckets as f64 * 16.0 / duration).ceil() as u32).clamp(100, 4000);

    let clean = audio_branch("[wp]", s, e, 1.0, &filters, shifted_sample, "wc");
    // amerge cannot negotiate on its own once one side went through loudnorm/arnndn - pin both.
    let fmt = "aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=mono";
    let graph = format!(
        "[0:a]aresample=48000,aformat=channel_layouts=mono,asplit=2[wo][wp];\
         [wo]atrim=start={s:.3}:end={e:.3},asetpts=PTS-STARTPTS,{fmt}[wo2];\
         {clean}\
         [wc]aresample=48000,{fmt}[wc2];\
         [wo2][wc2]amerge=inputs=2,aresample=16000,aeval='abs(val(0))|abs(val(1))':c=same,aresample={rate}[wout]"
    );

    let args: Vec<String> = vec![
        "-v".into(), "error".into(),
        "-ss".into(), format!("{:.3}", offset),
        "-t".into(), format!("{:.3}", span_end - offset + 0.05),
        "-i".into(), source_path,
        "-filter_complex".into(), graph,
        "-map".into(), "[wout]".into(),
        "-f".into(), "f32le".into(),
        "-ac".into(), "2".into(),
        "pipe:1".into(),
    ];
    let bytes = run_ffmpeg_capture(ffmpeg_path, args).await?;
    let peaks = bucket_peaks(&f32le_to_vec(&bytes), buckets);
    let mut out = Vec::with_capacity(peaks.len() * 4);
    for v in peaks {
        out.extend_from_slice(&v.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(out))
}

// Mono 48kHz f32le PCM of [start,end) of a file's audio - the live preview's noise-reduction
// worklet learns its profile from this when a clip has a noise sample (VideoPlayer.tsx), the
// browser-side twin of the export's afftdn sample_noise. Capped at MAX_NOISE_SAMPLE_SECS.
#[tauri::command]
pub async fn decode_audio_range(
    app_handle: AppHandle,
    source_path: String,
    start: f64,
    end: f64,
) -> Result<tauri::ipc::Response, String> {
    let start = start.max(0.0);
    let duration = (end - start).min(MAX_NOISE_SAMPLE_SECS);
    if !(duration > 0.0) {
        return Err("End must be after start".to_string());
    }
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let args: Vec<String> = vec![
        "-v".into(), "error".into(),
        "-ss".into(), format!("{:.3}", start),
        "-t".into(), format!("{:.3}", duration),
        "-i".into(), source_path,
        "-vn".into(), "-ac".into(), "1".into(), "-ar".into(), "48000".into(),
        "-f".into(), "f32le".into(), "pipe:1".into(),
    ];
    Ok(tauri::ipc::Response::new(run_ffmpeg_capture(ffmpeg_path, args).await?))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatsResult {
    pub bpm: f64,
    pub beats: Vec<f64>,
}

// Progress of a long audio job (beats, speech scan, separation...) - `key` names the job and its file,
// `fraction` 0..1. The panels turn it into a bar and the time left (src/utils/jobProgress.ts).
#[derive(Serialize, Clone)]
pub struct JobProgress {
    pub(super) key: String,
    pub(super) fraction: f64,
}

pub fn emit_job_progress(app: &AppHandle, key: &str, fraction: f64) {
    let _ = app.emit("audio-job-progress", JobProgress { key: key.to_string(), fraction });
}

// Beat sync (video editor): the tempo and every beat of a music file, in that file's own seconds.
// Decoded to mono 22.05kHz and analysed by services/beat_detect.rs; cached per file, since
// analysing a long track takes a few seconds and the answer never changes.
#[tauri::command]
pub async fn detect_beats(app_handle: AppHandle, source_path: String) -> Result<BeatsResult, String> {
    let input = PathBuf::from(&source_path);
    let cache_path = preview_cache_path(&input, "beats_v1", "json")?;
    if let Ok(text) = std::fs::read_to_string(&cache_path) {
        if let Ok(cached) = serde_json::from_str::<BeatsResult>(&text) {
            return Ok(cached);
        }
    }
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let ffprobe_path = get_ffprobe_path(&app_handle)?;
    let app = app_handle.clone();
    // Streamed: ffmpeg's samples go straight into the frame energies a block at a time, so an
    // hours-long file costs a few bytes a frame rather than gigabytes of samples - with progress
    // ("audio-job-progress", key "beats:<path>") measured against its length.
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Option<crate::services::beat_detect::BeatAnalysis>, String> {
        let duration = probe_duration_secs(&ffprobe_path, &input).unwrap_or(0.0);
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.args(["-v", "error", "-nostdin", "-i", &source_path, "-vn", "-ac", "1", "-ar", "22050", "-f", "f32le", "pipe:1"]);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("Failed to start ffmpeg: {e}"))?;
        let mut stdout = child.stdout.take().ok_or("ffmpeg gave no output")?;
        let mut energies = crate::services::beat_detect::FrameEnergies::new();
        let key = format!("beats:{source_path}");
        let mut buf = vec![0u8; 1 << 16];
        let mut carry: Vec<u8> = Vec::new();
        let mut samples = 0usize;
        let mut last = std::time::Instant::now();
        loop {
            let n = std::io::Read::read(&mut stdout, &mut buf).map_err(|e| format!("Couldn't read the audio: {e}"))?;
            if n == 0 {
                break;
            }
            carry.extend_from_slice(&buf[..n]);
            let whole = carry.len() / 4 * 4;
            let block: Vec<f32> = carry[..whole].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
            carry.drain(..whole);
            samples += block.len();
            energies.push(&block);
            if duration > 0.0 && last.elapsed().as_millis() > 250 {
                last = std::time::Instant::now();
                emit_job_progress(&app, &key, (samples as f64 / 22050.0 / duration).min(0.99));
            }
        }
        let _ = child.wait();
        emit_job_progress(&app, &key, 1.0);
        Ok(crate::services::beat_detect::beats_from_envelope(energies.envelope(), 22050.0))
    })
    .await
    .map_err(|e| format!("Beat detection task panicked: {e}"))??
    .ok_or("No steady beat found - the track may be too short, or have no clear rhythm")?;
    let out = BeatsResult { bpm: (result.bpm * 10.0).round() / 10.0, beats: result.beats };
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&cache_path, serde_json::to_string(&out).unwrap_or_default());
    Ok(out)
}

// Auto-reframe analysis: where the action is in [start, end] of a clip's source, once per frame at
// ANALYSIS_FPS, for a crop window `crop_w` x `crop_h` (fractions of the source frame). The
// saliency profiles are cached per range (the slow part - decoding), so asking again for another
// output shape is instant. Times are source seconds.
#[tauri::command]
pub async fn analyze_subject_track(
    app_handle: AppHandle,
    source_path: String,
    start: f64,
    end: f64,
    crop_w: f64,
    crop_h: f64,
) -> Result<SubjectTrack, String> {
    use crate::services::subject_track::{profiles_from_gray, subject_samples, FrameProfile, ANALYSIS_FPS, ANALYSIS_SIZE};
    let input = PathBuf::from(&source_path);
    // The source's own size - the frontend fits it into the project frame, as export does.
    let ffprobe_path = get_ffprobe_path(&app_handle)?;
    let probe_path = source_path.clone();
    let (width, height) = tauri::async_runtime::spawn_blocking(move || probe_video_dimensions(&ffprobe_path, &probe_path))
        .await
        .map_err(|e| format!("Probe task panicked: {e}"))?
        .unwrap_or((0, 0));
    if !(end > start) {
        return Ok(SubjectTrack { width, height, samples: Vec::new() });
    }
    let cache_path = preview_cache_path(&input, &format!("subject_v1_{:.3}_{:.3}", start, end), "json")?;
    let cached = std::fs::read_to_string(&cache_path).ok().and_then(|text| serde_json::from_str::<Vec<FrameProfile>>(&text).ok());
    let profiles = match cached {
        Some(profiles) => profiles,
        None => {
            let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
            let args: Vec<String> = vec![
                "-v".into(), "error".into(), "-ss".into(), format!("{:.3}", start), "-i".into(), source_path,
                "-t".into(), format!("{:.3}", end - start), "-an".into(), "-sn".into(),
                "-vf".into(), format!("fps={ANALYSIS_FPS},scale={ANALYSIS_SIZE}:{ANALYSIS_SIZE}:flags=area,format=gray"),
                "-f".into(), "rawvideo".into(), "pipe:1".into(),
            ];
            let bytes = run_ffmpeg_capture(ffmpeg_path, args).await?;
            let profiles = tauri::async_runtime::spawn_blocking(move || profiles_from_gray(&bytes, ANALYSIS_SIZE, ANALYSIS_FPS))
                .await
                .map_err(|e| format!("Subject analysis task panicked: {e}"))?;
            if let Some(parent) = cache_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&cache_path, serde_json::to_string(&profiles).unwrap_or_default());
            profiles
        }
    };
    let mut samples = subject_samples(&profiles, crop_w.clamp(0.01, 1.0), crop_h.clamp(0.01, 1.0));
    for sample in &mut samples {
        sample.t += start;
    }
    Ok(SubjectTrack { width, height, samples })
}

#[derive(Debug, Serialize)]
pub struct SubjectTrack {
    pub width: i64,
    pub height: i64,
    pub samples: Vec<crate::services::subject_track::SubjectSample>,
}

