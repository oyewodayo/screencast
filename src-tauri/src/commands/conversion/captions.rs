// Offline Whisper caption generation, word-level timing, and audio transcription.
use super::*;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static WHISPER_CANCELLED: AtomicBool = AtomicBool::new(false);
static ACTIVE_WHISPER_PIDS: OnceLock<std::sync::Mutex<Vec<u32>>> = OnceLock::new();
static WHISPER_JOB_LOCK: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();

fn active_whisper_pids() -> &'static std::sync::Mutex<Vec<u32>> {
    ACTIVE_WHISPER_PIDS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

fn whisper_job_lock() -> &'static tauri::async_runtime::Mutex<()> {
    WHISPER_JOB_LOCK.get_or_init(|| tauri::async_runtime::Mutex::new(()))
}

fn kill_whisper_pid(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        hide_console_window(&mut cmd);
        let _ = cmd.args(["/F", "/PID", &pid.to_string()]).output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

fn register_whisper_pid(pid: u32) {
    if let Ok(mut pids) = active_whisper_pids().lock() {
        pids.push(pid);
    }
}

fn unregister_whisper_pid(pid: u32) {
    if let Ok(mut pids) = active_whisper_pids().lock() {
        pids.retain(|&p| p != pid);
    }
}

fn kill_all_active_whisper() {
    let pids: Vec<u32> = active_whisper_pids()
        .lock()
        .map(|mut guard| std::mem::take(&mut *guard))
        .unwrap_or_default();
    for pid in pids {
        kill_whisper_pid(pid);
    }
}

/// Immediately cancels any in-flight offline Whisper transcription job and terminates its worker.
#[tauri::command]
pub fn cancel_transcription() -> Result<(), String> {
    WHISPER_CANCELLED.store(true, Ordering::SeqCst);
    kill_all_active_whisper();
    Ok(())
}

// Offline speech-to-text fallback for VideoPlayer's CC button, used only when the user explicitly
// asks for it (no sibling .vtt/.srt file exists, and they choose "Generate from audio" rather than
// picking a file themselves) - genuinely slow relative to every other command in this file (real
// model inference, not a single ffmpeg pass), so this is entirely opt-in, never run automatically
// on open the way get_video_scrub_sprite is. Returns the VTT text directly (not a cached file
// path): unlike every other generated preview here, this can't be served via asset:// - Tauri's
// asset protocol doesn't know the .vtt MIME type and serves it as text/html, which <track> silently
// refuses to parse (see VideoPlayer.tsx's loadCaptionsSrc, which wraps whatever text this returns
// in a Blob URL with the correct type instead). Still cached to disk content-addressed by the
// VIDEO's own path+mtime (see preview_cache_path) so re-opening the same file is instant instead
// of re-transcribing.
#[tauri::command]
pub async fn generate_captions(
    app_handle: AppHandle,
    input_path: String,
    // Whisper language code ("en", "fr", ...), or omitted/"auto" to let whisper.cpp detect it
    // from the audio itself. Folded into the cache namespace (not just the video's own path+mtime)
    // so switching languages on the same video regenerates instead of silently returning
    // whatever language was cached from an earlier run.
    language: Option<String>,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let lang = language.filter(|l| !l.is_empty()).unwrap_or_else(|| "auto".to_string());
    let cache_path = preview_cache_path(&input, &format!("captions_generated_v2_{}", lang), "vtt")?;

    if cache_path.exists() {
        return std::fs::read_to_string(&cache_path)
            .map_err(|e| format!("Failed to read cached captions: {}", e));
    }

    let chunks = transcribe_in_chunks(&app_handle, &input, &cache_path, &lang, false).await?;

    // Stitch the per-chunk VTTs into one, each cue's times shifted by its chunk's start.
    let mut vtt = String::from("WEBVTT\n\n");
    for (offset, file) in &chunks {
        let text = std::fs::read_to_string(file).map_err(|e| format!("Failed to read a transcribed part: {}", e))?;
        for block in text.replace("\r\n", "\n").split("\n\n") {
            let mut lines = block.lines();
            let Some(timing) = lines.find(|l| l.contains("-->")) else { continue };
            let Some(shifted) = shift_vtt_timing(timing, *offset) else { continue };
            let body: Vec<&str> = lines.filter(|l| !l.trim().is_empty()).collect();
            if body.is_empty() {
                continue;
            }
            vtt.push_str(&shifted);
            vtt.push('\n');
            vtt.push_str(&body.join("\n"));
            vtt.push_str("\n\n");
        }
    }

    std::fs::write(&cache_path, &vtt).map_err(|e| format!("Failed to cache captions: {}", e))?;
    finish_chunked_transcription(&cache_path);
    Ok(vtt)
}

// One whisper run's worth of audio (90s chunks give frequent resumable checkpoints and fast
// feedback on long recordings without letting whisper's model-load overhead dominate).
pub(super) const CAPTION_CHUNK_SECS: f64 = 90.0;

// Bytes per second of the 16kHz mono s16le WAV extract_audio_for_whisper writes.
pub(super) const WHISPER_WAV_BYTES_PER_SEC: f64 = 32_000.0;

pub(super) fn chunk_parts_dir(cache_path: &PathBuf) -> PathBuf {
    cache_path.with_extension("parts")
}

// Transcribes `input` piece by piece into `<cache>.parts/`, resuming from whatever an earlier,
// interrupted run already finished (a piece counts as done once its `.ok` marker exists - written
// only after whisper succeeded, so a half-written output is never trusted). Returns every piece's
// start offset (seconds) and output file, in order. Emits "captions-progress" across the whole job,
// so a resumed run starts its bar at the share already done.
pub(super) async fn transcribe_in_chunks(
    app_handle: &AppHandle,
    input: &PathBuf,
    cache_path: &PathBuf,
    lang: &str,
    words: bool,
) -> Result<Vec<(f64, PathBuf)>, String> {
    // Cancel any orphaned prior transcription so multiple whisper-cli processes never pile up and
    // fight over CPU or overwrite each other's chunk files, then serialize via WHISPER_JOB_LOCK.
    WHISPER_CANCELLED.store(true, Ordering::SeqCst);
    kill_all_active_whisper();
    let _job_guard = whisper_job_lock().lock().await;
    WHISPER_CANCELLED.store(false, Ordering::SeqCst);

    let parts = chunk_parts_dir(cache_path);
    std::fs::create_dir_all(&parts).map_err(|e| format!("Failed to create captions work folder: {}", e))?;

    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let whisper_path = crate::services::utility::get_whisper_cli_path(app_handle)?;
    if !whisper_path.exists() {
        return Err(format!(
            "whisper-cli not found at {} - see README's Getting Started for how to obtain it",
            whisper_path.display()
        ));
    }
    let model_handle = app_handle.clone();
    let model_path = tauri::async_runtime::spawn_blocking(move || crate::services::whisper_model::ensure_model(&model_handle))
        .await
        .map_err(|e| format!("Speech model lookup failed: {}", e))??;

    // The whole audio track, extracted once and kept with the pieces until the job completes.
    // Written under a temporary name first so an interrupted extraction is never mistaken for a
    // finished one (ffmpeg picks the format from the extension, so it stays .wav).
    let wav = parts.join("audio.wav");
    if !wav.exists() {
        let partial = parts.join("audio.partial.wav");
        let extraction = extract_audio_for_whisper(&ffmpeg_path, input, &partial).await;
        if let Err(err) = extraction {
            let _ = std::fs::remove_file(&partial);
            return Err(err);
        }
        std::fs::rename(&partial, &wav).map_err(|e| format!("Failed to keep extracted audio: {}", e))?;
    }
    let wav_len = std::fs::metadata(&wav).map(|m| m.len()).unwrap_or(0);
    let duration = (wav_len.saturating_sub(44) as f64) / WHISPER_WAV_BYTES_PER_SEC;
    let total = ((duration / CAPTION_CHUNK_SECS).ceil() as usize).max(1);

    // Word mode only: voice-activity detection for accurate word timings (see ensure_vad_model).
    // Optional - if it can't be had, transcription goes ahead without it.
    let vad_model: Option<String> = if words {
        let handle = app_handle.clone();
        match tauri::async_runtime::spawn_blocking(move || crate::services::whisper_model::ensure_vad_model(&handle)).await {
            Ok(Ok(path)) => path_to_str(&path).ok().map(|s| s.to_string()),
            Ok(Err(err)) => {
                log::warn!("Transcribing without voice detection: {}", err);
                None
            }
            Err(_) => None,
        }
    } else {
        None
    };

    let ext = if words { "json" } else { "vtt" };
    let mut outputs = Vec::with_capacity(total);
    let _ = app_handle.emit("captions-progress", 1.0_f64);
    for i in 0..total {
        if WHISPER_CANCELLED.load(Ordering::SeqCst) {
            return Err("Transcription cancelled".to_string());
        }
        let offset = i as f64 * CAPTION_CHUNK_SECS;
        let chunk_secs = (duration - offset).clamp(1.0, CAPTION_CHUNK_SECS);
        let stem = parts.join(format!("chunk_{:04}", i));
        let out_file = stem.with_extension(ext);
        let ok_marker = stem.with_extension("ok");
        let span = (i as f64 / total as f64 * 100.0, (i + 1) as f64 / total as f64 * 100.0);

        if ok_marker.exists() && out_file.exists() {
            let _ = app_handle.emit("captions-progress", span.1);
            outputs.push((offset, out_file));
            continue;
        }

        let chunk_wav = stem.with_extension("wav");
        cut_wav_chunk(&ffmpeg_path, &wav, &chunk_wav, offset, CAPTION_CHUNK_SECS).await?;
        let keep_disfluencies = words && (lang == "en" || lang == "auto");
        let mut format_args: Vec<&str> = if words { vec!["-oj", "-ml", "1", "-sow"] } else { vec!["-ovtt"] };
        if keep_disfluencies {
            format_args.extend(["--prompt", WHISPER_DISFLUENCY_PROMPT]);
        }
        if let Some(vad) = vad_model.as_deref() {
            format_args.extend(["--vad", "-vm", vad]);
        }
        let result = run_whisper_cli(app_handle, &whisper_path, &model_path, &chunk_wav, &stem, lang, &format_args, span, chunk_secs).await;
        let _ = std::fs::remove_file(&chunk_wav);
        result?;
        if WHISPER_CANCELLED.load(Ordering::SeqCst) {
            return Err("Transcription cancelled".to_string());
        }
        std::fs::write(&ok_marker, b"").map_err(|e| format!("Failed to record transcription progress: {}", e))?;
        outputs.push((offset, out_file));
    }
    Ok(outputs)
}

pub(super) const WHISPER_DISFLUENCY_PROMPT: &str = "Umm, let me think like, hmm... Okay, uh, so here's what I'm, like, thinking, I- I mean the the plan.";

// The job is done and its final result cached - the pieces and extracted audio can go.
pub(super) fn finish_chunked_transcription(cache_path: &PathBuf) {
    let _ = std::fs::remove_dir_all(chunk_parts_dir(cache_path));
}

pub(super) async fn cut_wav_chunk(ffmpeg_path: &PathBuf, wav: &PathBuf, output: &PathBuf, start: f64, length: f64) -> Result<(), String> {
    let ffmpeg_path = ffmpeg_path.clone();
    let wav = wav.clone();
    let output = output.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-y");
        cmd.args(["-ss", &format!("{:.3}", start), "-t", &format!("{:.3}", length)]);
        cmd.arg("-i").arg(path_to_str(&wav)?);
        cmd.args(["-c:a", "pcm_s16le"]);
        cmd.arg(path_to_str(&output)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::piped());
        let result = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() || !output.exists() {
            return Err("Failed to cut the audio into pieces for transcription".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Audio split task failed: {}", e))?
}

// "00:01:02.345 --> 00:01:04.000 <settings>" with both times moved later by `offset` seconds.
pub(super) fn shift_vtt_timing(line: &str, offset: f64) -> Option<String> {
    let (left, right) = line.split_once("-->")?;
    let mut right_parts = right.trim().splitn(2, char::is_whitespace);
    let end_raw = right_parts.next()?;
    let settings = right_parts.next().unwrap_or("");
    let start = parse_vtt_time(left.trim())? + offset;
    let end = parse_vtt_time(end_raw)? + offset;
    let mut out = format!("{} --> {}", format_vtt_time(start), format_vtt_time(end));
    if !settings.is_empty() {
        out.push(' ');
        out.push_str(settings);
    }
    Some(out)
}

pub(super) fn parse_vtt_time(s: &str) -> Option<f64> {
    let s = s.replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    let (h, m, sec) = match parts.as_slice() {
        [h, m, sec] => (h.parse::<f64>().ok()?, m.parse::<f64>().ok()?, sec.parse::<f64>().ok()?),
        [m, sec] => (0.0, m.parse::<f64>().ok()?, sec.parse::<f64>().ok()?),
        _ => return None,
    };
    Some(h * 3600.0 + m * 60.0 + sec)
}

pub(super) fn format_vtt_time(t: f64) -> String {
    let ms_total = (t.max(0.0) * 1000.0).round() as u64;
    let h = ms_total / 3_600_000;
    let m = (ms_total % 3_600_000) / 60_000;
    let s = (ms_total % 60_000) / 1000;
    let ms = ms_total % 1000;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, ms)
}

#[derive(serde::Serialize)]
pub struct CaptionJobProgress {
    pub(super) done: usize,
    // 0 when the audio hasn't been extracted yet (nothing to measure the total from).
    pub(super) total: usize,
}

// Whether an interrupted caption job exists for this file+language (and how far it got) - lets
// the player resume it automatically on open, and the editor's Captions panel offer "Resume"
// instead of "Generate". None once the job is complete (or was never started).
#[tauri::command]
pub async fn caption_job_progress(input_path: String, language: Option<String>, words: bool) -> Result<Option<CaptionJobProgress>, String> {
    let input = PathBuf::from(&input_path);
    let lang = language.filter(|l| !l.is_empty()).unwrap_or_else(|| "auto".to_string());
    let (namespace, ext) = if words {
        (format!("captions_words_v4_{}", lang), "json")
    } else {
        (format!("captions_generated_v2_{}", lang), "vtt")
    };
    let cache_path = preview_cache_path(&input, &namespace, ext)?;
    if cache_path.exists() {
        return Ok(None);
    }
    let parts = chunk_parts_dir(&cache_path);
    if !parts.exists() {
        return Ok(None);
    }
    let done = std::fs::read_dir(&parts)
        .map(|entries| entries.filter_map(Result::ok).filter(|e| e.path().extension().map_or(false, |x| x == "ok")).count())
        .unwrap_or(0);
    let total = std::fs::metadata(parts.join("audio.wav"))
        .map(|m| ((m.len().saturating_sub(44) as f64 / WHISPER_WAV_BYTES_PER_SEC / CAPTION_CHUNK_SECS).ceil() as usize).max(1))
        .unwrap_or(0);
    Ok(Some(CaptionJobProgress { done, total }))
}

// One spoken word with its own timing, in seconds of the SOURCE file - the video editor's
// Captions tool (CaptionWord, videoEditTypes.ts) maps these through the timeline's clips itself,
// so the transcript stays valid across any trim/cut/reorder/speed change made afterwards.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct CaptionWordOut {
    pub(super) start: f64,
    pub(super) end: f64,
    pub(super) text: String,
}

// Word-timed transcript for the editor's burned-in captions - the same offline whisper.cpp pass
// generate_captions runs, but asking for one word per segment (-ml 1 -sow) as JSON instead of
// sentence-level VTT, which is what per-word emphasis and re-flowing lines need. Cached per
// file+mtime+language exactly like generate_captions, as the parsed word list itself.
#[tauri::command]
pub async fn generate_caption_words(
    app_handle: AppHandle,
    input_path: String,
    language: Option<String>,
) -> Result<Vec<CaptionWordOut>, String> {
    let input = PathBuf::from(&input_path);
    let lang = language.filter(|l| !l.is_empty()).unwrap_or_else(|| "auto".to_string());
    // v4: 90s chunks + greedy decoding (-bs 1 -bo 1) + live stdout/stderr progress.
    let cache_path = preview_cache_path(&input, &format!("captions_words_v4_{}", lang), "json")?;

    if cache_path.exists() {
        let cached = std::fs::read_to_string(&cache_path)
            .map_err(|e| format!("Failed to read cached captions: {}", e))?;
        if let Ok(words) = serde_json::from_str::<Vec<CaptionWordOut>>(&cached) {
            return Ok(words);
        }
        // Unreadable cache - fall through and regenerate over it.
    }
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create captions cache directory: {}", e))?;
    }

    // Word-per-segment JSON, transcribed (and resumable) piece by piece - see transcribe_in_chunks.
    let chunks = transcribe_in_chunks(&app_handle, &input, &cache_path, &lang, true).await?;
    let mut words: Vec<CaptionWordOut> = Vec::new();
    for (offset, file) in &chunks {
        let raw = std::fs::read_to_string(file).map_err(|e| format!("Failed to read a transcribed part: {}", e))?;
        for mut w in parse_whisper_word_json(&raw)? {
            w.start += offset;
            w.end += offset;
            words.push(w);
        }
    }

    if let Ok(json) = serde_json::to_string(&words) {
        let _ = std::fs::write(&cache_path, json); // best-effort - a missing cache just regenerates
    }
    finish_chunked_transcription(&cache_path);
    Ok(words)
}

// whisper-cli's `-oj -ml 1 -sow` output: { "transcription": [ { "offsets": { "from": ms, "to": ms },
// "text": " word" }, ... ] }. A leading space marks a new word; an entry WITHOUT one is a fragment
// of the previous word (whisper occasionally still splits one there) and gets merged back into
// it. Empty entries and non-speech markers ("[BLANK_AUDIO]", "(music)", "[Music]") are dropped.
pub(super) fn parse_whisper_word_json(raw: &str) -> Result<Vec<CaptionWordOut>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Couldn't read the transcription output: {}", e))?;
    let entries = value
        .get("transcription")
        .and_then(|t| t.as_array())
        .ok_or("Transcription output had no word list")?;

    let mut words: Vec<CaptionWordOut> = Vec::new();
    for entry in entries {
        let text = entry.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let offsets = entry.get("offsets");
        let from = offsets.and_then(|o| o.get("from")).and_then(|v| v.as_f64()).unwrap_or(0.0) / 1000.0;
        let to = offsets.and_then(|o| o.get("to")).and_then(|v| v.as_f64()).unwrap_or(0.0) / 1000.0;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        let is_marker = (trimmed.starts_with('[') && trimmed.ends_with(']'))
            || (trimmed.starts_with('(') && trimmed.ends_with(')'));
        if is_marker {
            continue;
        }
        match words.last_mut() {
            Some(last) if !text.starts_with(' ') => {
                last.text.push_str(trimmed);
                last.end = last.end.max(to);
            }
            _ => words.push(CaptionWordOut {
                start: from,
                end: to.max(from),
                text: trimmed.to_string(),
            }),
        }
    }
    Ok(words)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTranscript {
    pub(super) text: String,
    // whisper's own language code ("en", "de", ...) when it auto-detected one - the frontend locks
    // later chunks to it, since detection on a two-second utterance is far less reliable than on
    // the first, usually longer one.
    pub(super) language: Option<String>,
}

// Dictation chunks from useDocDictation.ts: the frontend cuts the mic stream at speech pauses and
// sends each utterance as a 16kHz mono WAV, so whisper runs on a few seconds of audio at a time and
// text lands while the user is still talking. `prompt` is the document text before the cursor,
// passed as whisper's initial prompt - biases spelling of names/jargon already in the doc and keeps
// punctuation/casing consistent with what's already written.
#[tauri::command]
pub async fn transcribe_doc_audio(
    app_handle: AppHandle,
    audio_bytes: Option<Vec<u8>>,
    audio_base64: Option<String>,
    mime_type: Option<String>,
    language: Option<String>,
    prompt: Option<String>,
) -> Result<DocTranscript, String> {
    let bytes: Vec<u8> = if let Some(b64) = audio_base64.filter(|s| !s.is_empty()) {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("Invalid base64 audio payload: {}", e))?
    } else if let Some(raw) = audio_bytes {
        raw
    } else {
        Vec::new()
    };
    if bytes.is_empty() {
        return Err("No audio was recorded".to_string());
    }

    let whisper_path = crate::services::utility::get_whisper_cli_path(&app_handle)?;
    if !whisper_path.exists() {
        return Err(format!(
            "whisper-cli not found at {} - see README's Getting Started for how to obtain it",
            whisper_path.display()
        ));
    }
    let model_handle = app_handle.clone();
    let model_path = tauri::async_runtime::spawn_blocking(move || crate::services::whisper_model::ensure_model(&model_handle))
        .await
        .map_err(|e| format!("Speech model lookup failed: {}", e))??;

    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let lang = language.filter(|l| !l.is_empty()).unwrap_or_else(|| "auto".to_string());
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let work_dir = std::env::temp_dir().join("briefcast_doc_dictation");
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Failed to create dictation temp directory: {}", e))?;

    let input_ext = audio_extension_for_mime(mime_type.as_deref());
    let input_path = work_dir.join(format!("dictation-{}-{}.{}", std::process::id(), stamp, input_ext));
    let wav_path = work_dir.join(format!("dictation-{}-{}.wav", std::process::id(), stamp));
    let output_stem = work_dir.join(format!("dictation-{}-{}", std::process::id(), stamp));
    let output_txt = output_stem.with_extension("txt");

    let ready_wav = is_whisper_ready_wav(&bytes);
    std::fs::write(&input_path, bytes)
        .map_err(|e| format!("Failed to write recorded audio: {}", e))?;

    let prompt = prompt.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    let result = async {
        // Already in whisper's input format - skip the ffmpeg round trip (a process spawn per chunk).
        let whisper_input = if ready_wav {
            &input_path
        } else {
            extract_audio_for_whisper(&ffmpeg_path, &input_path, &wav_path).await?;
            &wav_path
        };
        // 16kHz mono s16 = 32000 bytes/s after the 44-byte header.
        let seconds = std::fs::metadata(whisper_input)
            .map(|m| m.len().saturating_sub(44) as f64 / 32000.0)
            .unwrap_or(30.0);
        // Short dictation clips already passed the frontend's speech-band VAD and silence trim;
        // skipping the second Silero VAD model load saves ~150-300ms per live phrase.
        let vad_model_path = if seconds > 8.5 {
            crate::services::whisper_model::existing_vad_model(&app_handle)
        } else {
            None
        };
        let language = run_whisper_text_cli(
            &app_handle,
            &whisper_path,
            &model_path,
            vad_model_path.as_ref(),
            whisper_input,
            &output_stem,
            &lang,
            prompt.as_deref(),
            dictation_audio_ctx(seconds),
        )
        .await?;
        let text = std::fs::read_to_string(&output_txt)
            .map(|text| normalize_whisper_text(&text))
            .map_err(|e| format!("whisper-cli reported success but produced no readable transcript: {}", e))?;
        Ok::<_, String>(DocTranscript { text, language })
    }
    .await;

    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&wav_path);
    let _ = std::fs::remove_file(&output_txt);
    result
}

// whisper's encoder always runs over a full 30s window (1500 frames, 50/s) unless told otherwise,
// so a three-second dictation phrase paid for 27s of padding. Sizing the window to the clip plus a
// 1.0s tail margin, rounded up to 32 frames and clamped to a 128-frame (2.56s) floor, makes short
// real-time dictation phrases more than twice as fast without truncating the tail.
pub(super) fn dictation_audio_ctx(seconds: f64) -> u32 {
    let frames = ((seconds + 0.45) * 50.0).ceil() as u32;
    (frames.div_ceil(32) * 32).clamp(96, 1500)
}

// True for a canonical 44-byte-header PCM WAV that's already 16kHz, mono, 16-bit.
pub(super) fn is_whisper_ready_wav(bytes: &[u8]) -> bool {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" || &bytes[12..16] != b"fmt " {
        return false;
    }
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    u16_at(20) == 1 && u16_at(22) == 1 && u32_at(24) == 16000 && u16_at(34) == 16 && &bytes[36..40] == b"data"
}

pub(super) fn audio_extension_for_mime(mime_type: Option<&str>) -> &'static str {
    let mime = mime_type.unwrap_or("").to_ascii_lowercase();
    if mime.contains("mp4") || mime.contains("m4a") {
        "m4a"
    } else if mime.contains("ogg") {
        "ogg"
    } else if mime.contains("wav") {
        "wav"
    } else {
        "webm"
    }
}

pub(super) fn normalize_whisper_text(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn whisper_language_label(code: &str) -> String {
    match code.to_ascii_lowercase().as_str() {
        "en" => "English",
        "zh" => "Chinese",
        "de" => "German",
        "es" => "Spanish",
        "ru" => "Russian",
        "ko" => "Korean",
        "fr" => "French",
        "ja" => "Japanese",
        "pt" => "Portuguese",
        "tr" => "Turkish",
        "pl" => "Polish",
        "ca" => "Catalan",
        "nl" => "Dutch",
        "ar" => "Arabic",
        "sv" => "Swedish",
        "it" => "Italian",
        "id" => "Indonesian",
        "hi" => "Hindi",
        "fi" => "Finnish",
        "vi" => "Vietnamese",
        "he" => "Hebrew",
        "uk" => "Ukrainian",
        "el" => "Greek",
        "ms" => "Malay",
        "cs" => "Czech",
        "ro" => "Romanian",
        "da" => "Danish",
        "hu" => "Hungarian",
        "ta" => "Tamil",
        "no" => "Norwegian",
        "th" => "Thai",
        "ur" => "Urdu",
        "hr" => "Croatian",
        "bg" => "Bulgarian",
        "lt" => "Lithuanian",
        "la" => "Latin",
        "mi" => "Maori",
        "ml" => "Malayalam",
        "cy" => "Welsh",
        "sk" => "Slovak",
        "te" => "Telugu",
        "fa" => "Persian",
        "lv" => "Latvian",
        "bn" => "Bengali",
        "sr" => "Serbian",
        "az" => "Azerbaijani",
        "sl" => "Slovenian",
        "kn" => "Kannada",
        "et" => "Estonian",
        "mk" => "Macedonian",
        "br" => "Breton",
        "eu" => "Basque",
        "is" => "Icelandic",
        "hy" => "Armenian",
        "ne" => "Nepali",
        "mn" => "Mongolian",
        "bs" => "Bosnian",
        "kk" => "Kazakh",
        "sq" => "Albanian",
        "sw" => "Swahili",
        "gl" => "Galician",
        "mr" => "Marathi",
        "pa" => "Punjabi",
        "si" => "Sinhala",
        "km" => "Khmer",
        "sn" => "Shona",
        "yo" => "Yoruba",
        "so" => "Somali",
        "af" => "Afrikaans",
        "oc" => "Occitan",
        "ka" => "Georgian",
        "be" => "Belarusian",
        "tg" => "Tajik",
        "sd" => "Sindhi",
        "gu" => "Gujarati",
        "am" => "Amharic",
        "yi" => "Yiddish",
        "lo" => "Lao",
        "uz" => "Uzbek",
        "fo" => "Faroese",
        "ht" => "Haitian Creole",
        "ps" => "Pashto",
        "tk" => "Turkmen",
        "nn" => "Nynorsk",
        "mt" => "Maltese",
        "sa" => "Sanskrit",
        "lb" => "Luxembourgish",
        "my" => "Myanmar",
        "bo" => "Tibetan",
        "tl" => "Tagalog",
        "mg" => "Malagasy",
        "as" => "Assamese",
        "tt" => "Tatar",
        "haw" => "Hawaiian",
        "ln" => "Lingala",
        "ha" => "Hausa",
        "ba" => "Bashkir",
        "jw" => "Javanese",
        "su" => "Sundanese",
        _ => code,
    }
    .to_string()
}

pub(super) async fn extract_audio_for_whisper(
    ffmpeg_path: &PathBuf,
    input: &PathBuf,
    output: &PathBuf,
) -> Result<(), String> {
    let ffmpeg_path = ffmpeg_path.clone();
    let input = input.clone();
    let output = output.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-y");
        cmd.arg("-i").arg(path_to_str(&input)?);
        cmd.args(["-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"]);
        cmd.arg(path_to_str(&output)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let result = cmd
            .output()
            .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            let tail: Vec<&str> = stderr
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .rev()
                .take(3)
                .collect();
            let reason: String = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
            return Err(format!(
                "ffmpeg audio extraction failed: {}",
                if reason.is_empty() { "unknown error".to_string() } else { reason }
            ));
        }
        if !output.exists() {
            return Err("ffmpeg exited successfully but produced no audio - the source may have no audio track".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Audio extraction task panicked: {e}"))?
}

// Spawns whisper-cli and streams its progress back to the frontend as it works, rather than the
// caller just waiting on a single opaque `.output()` call - real model inference over a whole
// video's audio track can easily take longer than the video itself plays (measured directly:
// ~52s of audio took several minutes on ordinary consumer hardware even with every logical core
// in use), so without this the CC button's spinner gives no sign anything is happening versus
// having silently hung. -pp turns on whisper.cpp's own "whisper_print_progress_callback: progress
// = N%" lines (stderr - confirmed by capturing stdout/stderr separately during development;
// segment transcript lines are the ones on stdout), which the stderr reader thread below parses
// and re-emits as a "captions-progress" event. -t uses every logical core rather than whisper-cli's
// own default of 4, which measurably shortens the wait on anything with more than 4.
pub(super) async fn run_whisper_cli(
    app_handle: &AppHandle,
    whisper_path: &PathBuf,
    model_path: &PathBuf,
    wav_path: &PathBuf,
    output_stem: &PathBuf,
    language: &str,
    // Output-format flags - ["-ovtt"] for segment captions (generate_captions), or JSON at one word
    // per segment for the editor's word-timed captions (generate_caption_words).
    format_args: &[&str],
    // This run's share of the overall job's 0-100 progress (transcribe_in_chunks runs one per piece).
    progress_span: (f64, f64),
    chunk_secs: f64,
) -> Result<(), String> {
    let app_handle = app_handle.clone();
    let (span_start, span_end) = progress_span;
    let _ = app_handle.emit("captions-progress", span_start.max(1.0));
    let format_args: Vec<String> = format_args.iter().map(|a| a.to_string()).collect();
    let whisper_path = whisper_path.clone();
    let model_path = model_path.clone();
    let wav_path = wav_path.clone();
    let output_stem = output_stem.clone();
    let language = language.to_string();
    // Leave headroom for the UI and OS (cap at 6 threads) and use greedy decoding (-bs 1 -bo 1),
    // which is 3-5x faster on CPU than default beam search (5) with negligible quality difference.
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(2).clamp(1, 6))
        .unwrap_or(4);
    tauri::async_runtime::spawn_blocking(move || {
        if WHISPER_CANCELLED.load(Ordering::SeqCst) {
            return Err("Transcription cancelled".to_string());
        }
        let mut cmd = Command::new(&whisper_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-m").arg(path_to_str(&model_path)?);
        cmd.arg("-f").arg(path_to_str(&wav_path)?);
        cmd.args(&format_args);
        cmd.args(["-bs", "1", "-bo", "1", "-pp", "-t", &threads.to_string(), "-l", &language]);
        cmd.arg("-of").arg(path_to_str(&output_stem)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start whisper-cli: {}", e))?;
        let pid = child.id();
        register_whisper_pid(pid);

        let highest_pct = Arc::new(std::sync::Mutex::new(span_start));
        let emit_progress = {
            let app = app_handle.clone();
            let highest = highest_pct.clone();
            move |pct: f64| {
                let clamped = pct.clamp(span_start, span_end);
                if let Ok(mut guard) = highest.lock() {
                    if clamped > *guard + 0.15 {
                        *guard = clamped;
                        let _ = app.emit("captions-progress", clamped);
                    }
                }
            }
        };

        // Read stdout continuously (prevents pipe deadlock) AND parse segment end timestamps
        // (`[00:00:12.340 --> 00:00:15.800] ...`) for smooth, second-by-second progress updates.
        let stdout = child.stdout.take().ok_or("Failed to capture whisper-cli stdout")?;
        let emit_stdout = emit_progress.clone();
        let safe_chunk_secs = chunk_secs.max(1.0);
        let stdout_thread = std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let ts_re = regex::Regex::new(r"-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})").unwrap();
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Some(caps) = ts_re.captures(&line) {
                    if let Some(sec) = parse_vtt_time(&caps[1]) {
                        let frac = (sec / safe_chunk_secs).clamp(0.0, 1.0);
                        emit_stdout(span_start + frac * (span_end - span_start));
                    }
                }
            }
        });

        // Read stderr splitting on BOTH '\r' and '\n' so whisper.cpp's progress lines flush
        // immediately instead of buffering until the chunk finishes.
        let mut stderr = child.stderr.take().ok_or("Failed to capture whisper-cli stderr")?;
        let emit_stderr = emit_progress.clone();
        let stderr_thread = std::thread::spawn(move || {
            let mut full_output = String::new();
            let progress_re = regex::Regex::new(r"progress\s*=\s*(\d+)%").unwrap();
            let mut buf = [0u8; 1024];
            let mut line_buf = String::new();
            let process_segment = |seg: &str, out: &mut String| {
                if !seg.is_empty() {
                    out.push_str(seg);
                    out.push('\n');
                    if let Some(caps) = progress_re.captures(seg) {
                        if let Ok(pct) = caps[1].parse::<f64>() {
                            emit_stderr(span_start + (pct / 100.0).clamp(0.0, 1.0) * (span_end - span_start));
                        }
                    }
                }
            };
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buf[..n]);
                for ch in text.chars() {
                    if ch == '\n' || ch == '\r' {
                        process_segment(line_buf.trim(), &mut full_output);
                        line_buf.clear();
                    } else {
                        line_buf.push(ch);
                    }
                }
            }
            if !line_buf.trim().is_empty() {
                process_segment(line_buf.trim(), &mut full_output);
            }
            full_output
        });

        let status = child
            .wait()
            .map_err(|e| format!("Failed to wait for whisper-cli: {}", e))?;
        unregister_whisper_pid(pid);
        let _ = stdout_thread.join();
        let stderr_output = stderr_thread.join().unwrap_or_default();

        if WHISPER_CANCELLED.load(Ordering::SeqCst) {
            return Err("Transcription cancelled".to_string());
        }

        if !status.success() {
            let tail: Vec<&str> = stderr_output
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .rev()
                .take(3)
                .collect();
            let reason: String = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
            return Err(format!(
                "whisper-cli transcription failed: {}",
                if reason.is_empty() { "unknown error".to_string() } else { reason }
            ));
        }
        let _ = app_handle.emit("captions-progress", span_end);
        Ok(())
    })
    .await
    .map_err(|e| format!("Transcription task panicked: {e}"))?
}

// Returns the language code whisper auto-detected, if it detected one (None with an explicit -l).
pub(super) async fn run_whisper_text_cli(
    app_handle: &AppHandle,
    whisper_path: &PathBuf,
    model_path: &PathBuf,
    vad_model_path: Option<&PathBuf>,
    wav_path: &PathBuf,
    output_stem: &PathBuf,
    language: &str,
    prompt: Option<&str>,
    audio_ctx: u32,
) -> Result<Option<String>, String> {
    let app_handle = app_handle.clone();
    let whisper_path = whisper_path.clone();
    let model_path = model_path.clone();
    let vad_model_path = vad_model_path.cloned();
    let wav_path = wav_path.clone();
    let output_stem = output_stem.clone();
    let language = language.to_string();
    let prompt = prompt.map(str::to_string);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).clamp(1, 8))
        .unwrap_or(4);
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&whisper_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-m").arg(path_to_str(&model_path)?);
        cmd.arg("-f").arg(path_to_str(&wav_path)?);
        // -bs 1 -bo 1: greedy decoding - beam search (the default 5) cost ~250ms more per phrase
        // with no change in the transcript on short dictation clips. -sns: suppress non-speech
        // tokens ("[MUSIC]", "(laughs)") at decode time so speech writing accuracy stays pure.
        // -ac: see dictation_audio_ctx. No -pp: a phrase finishes in well under a second, so
        // per-percent progress events were just noise.
        // -nf (--no-fallback): prevents high-temperature fallback sampling (0.2..1.0) on quiet/noisy
        // audio, which otherwise regurgitates --prompt (screen text) and takes 5x longer.
        // -nt (--no-timestamps), -mc 64, -nth 0.50, -et 2.20, -lpt -0.80: tighter silence/entropy
        // thresholds and shorter context for fast, hallucination-free real-time dictation.
        let audio_ctx = audio_ctx.to_string();
        cmd.args([
            "-otxt",
            "-np",
            "-sns",
            "-nt",
            "-nf",
            "-bs",
            "1",
            "-bo",
            "1",
            "-mc",
            "32",
            "-nth",
            "0.50",
            "-et",
            "2.20",
            "-lpt",
            "-0.80",
            "-ac",
            &audio_ctx,
            "-t",
            &threads.to_string(),
            "-l",
            &language,
        ]);
        if let Some(vad_path) = &vad_model_path {
            if let Ok(vad_str) = path_to_str(vad_path) {
                cmd.args(["--vad", "-vm", vad_str, "-vt", "0.45", "-vspd", "180", "-vp", "120"]);
            }
        }
        if let Some(prompt) = &prompt {
            cmd.arg("--prompt").arg(prompt);
        }
        cmd.arg("-of").arg(path_to_str(&output_stem)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start whisper-cli: {}", e))?;

        let stdout = child.stdout.take().ok_or("Failed to capture whisper-cli stdout")?;
        let app_handle_for_stdout = app_handle.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut partial = String::new();
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let cleaned = line.trim();
                if !cleaned.is_empty() {
                    if !partial.is_empty() {
                        partial.push(' ');
                    }
                    partial.push_str(cleaned);
                    let _ = app_handle_for_stdout.emit("docs-dictation-partial", partial.clone());
                }
            }
        });

        let stderr = child.stderr.take().ok_or("Failed to capture whisper-cli stderr")?;
        let app_handle_for_stderr = app_handle.clone();
        let stderr_thread = std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut full_output = String::new();
            let progress_re = regex::Regex::new(r"progress\s*=\s*(\d+)%").unwrap();
            let language_re = regex::Regex::new(r"(?:auto-)?detected language:\s*([A-Za-z][A-Za-z_-]*)").unwrap();
            let mut detected_language: Option<String> = None;

            for line in reader.lines() {
                let Ok(line) = line else { continue };
                full_output.push_str(&line);
                full_output.push('\n');

                if let Some(caps) = progress_re.captures(&line) {
                    if let Ok(pct) = caps[1].parse::<f64>() {
                        let _ = app_handle_for_stderr.emit("docs-dictation-progress", pct);
                    }
                }
                if detected_language.is_none() {
                    if let Some(caps) = language_re.captures(&line.to_ascii_lowercase()) {
                        let label = whisper_language_label(&caps[1]);
                        let _ = app_handle_for_stderr.emit("docs-dictation-language", label);
                        detected_language = Some(caps[1].to_string());
                    }
                }
            }

            (full_output, detected_language)
        });

        let status = child
            .wait()
            .map_err(|e| format!("Failed to wait for whisper-cli: {}", e))?;
        let (stderr_output, detected_language) = stderr_thread.join().unwrap_or_default();

        if !status.success() {
            let tail: Vec<&str> = stderr_output
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .rev()
                .take(3)
                .collect();
            let reason: String = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
            return Err(format!(
                "whisper-cli transcription failed: {}",
                if reason.is_empty() { "unknown error".to_string() } else { reason }
            ));
        }
        let _ = app_handle.emit("docs-dictation-progress", 100.0);
        Ok(detected_language)
    })
    .await
    .map_err(|e| format!("Transcription task panicked: {e}"))?
}
