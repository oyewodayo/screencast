// Commands behind the AI voice (components/docker/AiVoicePanel.tsx). The engine is services/tts.rs;
// this is the thin layer that fetches it, runs it off the UI thread, and reports progress.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Window};

use crate::services::tts::{self, Settings, VoiceInfo};

static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);
static SYNTH_CANCELLED: AtomicBool = AtomicBool::new(false);

// Anything longer is a book, not a voice-over; it also keeps one request from holding the engine for minutes.
const MAX_TEXT_CHARS: usize = 12_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    // "ready", "needs-download", or "unsupported" on this platform.
    state: &'static str,
    download_mb: u64,
    voices: Vec<VoiceInfo>,
}

#[tauri::command]
pub async fn tts_status(app_handle: AppHandle) -> Result<TtsStatus, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Ok(TtsStatus { state: "unsupported", download_mb: 0, voices: tts::voice_list() });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let ready = tts::assets_ready(&app_handle);
        Ok(TtsStatus { state: if ready { "ready" } else { "needs-download" }, download_mb: tts::download_size(&app_handle) / 1_000_000, voices: tts::voice_list() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

// Fetches (or repairs) the voice engine, model, dictionaries and voices. Emits "tts-download" {downloaded, total}.
#[tauri::command]
pub async fn download_tts(app_handle: AppHandle, window: Window) -> Result<(), String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("The AI voice isn't available on this platform yet.".into());
    }
    DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |downloaded: u64, total: u64| {
            let _ = window.emit("tts-download", DownloadProgress { downloaded, total });
        };
        tts::ensure_assets(&app_handle, &DOWNLOAD_CANCELLED, &emit)?;
        if tts::assets_ready(&app_handle) { Ok(()) } else { Err("The voice files didn't verify after downloading.".into()) }
    })
    .await
    .map_err(|e| format!("Download task failed: {}", e))?
}

#[tauri::command(async)]
pub fn cancel_tts_download() {
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpokenFile {
    path: String,
    seconds: f64,
    // Made earlier with these exact words and settings - nothing was run.
    cached: bool,
}

#[derive(Clone, Serialize)]
struct SynthProgress {
    done: usize,
    total: usize,
}

fn seconds_of(path: &PathBuf) -> f64 {
    hound::WavReader::open(path).map(|r| r.duration() as f64 / r.spec().sample_rate as f64).unwrap_or(0.0)
}

// Says `text` in `voice` and saves it in the library's Voice-overs folder. Emits "tts-progress"
// {done, total} per sentence. `speed` 0.6-1.5 (1 = the voice's own pace); `pause` scales the gaps
// between sentences (1 = natural).
#[tauri::command]
pub async fn tts_synthesize(app_handle: AppHandle, window: Window, text: String, voice: String, speed: f32, pause: f32) -> Result<SpokenFile, String> {
    if text.trim().is_empty() {
        return Err("There's nothing to say - add some words first.".into());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("That's too long for one voice-over ({} characters at most) - split it into parts.", MAX_TEXT_CHARS));
    }
    SYNTH_CANCELLED.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        if !tts::assets_ready(&app_handle) {
            return Err("The AI voice hasn't been downloaded yet.".to_string());
        }
        let settings = Settings { voice, speed, pause };
        let key = tts::request_key(&text, &settings);
        let dir = crate::services::utility::briefcast_dir()?.join("Voice-overs");
        let name = format!("AI voice - {} - {} {}.wav", tts::name_from_text(&text), settings.voice, key);
        let path = dir.join(&name);
        if path.is_file() && seconds_of(&path) > 0.0 {
            write_script(&path, &text, &settings);
            return Ok(SpokenFile { seconds: seconds_of(&path), path: path.to_string_lossy().into_owned(), cached: true });
        }
        let progress = |done: usize, total: usize| {
            let _ = window.emit("tts-progress", SynthProgress { done, total });
        };
        let spoken = tts::synthesize(&app_handle, &text, &settings, &SYNTH_CANCELLED, &progress)?;
        tts::write_wav(&path, &spoken.samples)?;
        write_script(&path, &text, &settings);
        Ok(SpokenFile { seconds: spoken.samples.len() as f64 / tts::SAMPLE_RATE as f64, path: path.to_string_lossy().into_owned(), cached: false })
    })
    .await
    .map_err(|e| format!("Voice task failed: {}", e))?
}

// What a voice-over was made from, kept beside its .wav as "<name>.wav.json" - the panel's history
// lists these so a voice-over can be found, placed again, or re-made with changed words long after
// the panel forgot its draft. Not media, so the library never shows it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Script {
    text: String,
    voice: String,
    speed: f32,
    pause: f32,
    created_at: u64,
}

fn script_path(wav: &Path) -> PathBuf {
    let mut name = wav.as_os_str().to_owned();
    name.push(".json");
    PathBuf::from(name)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// Best-effort: a voice-over without its script still plays; it just can't be re-made from history.
fn write_script(wav: &Path, text: &str, settings: &Settings) {
    let target = script_path(wav);
    if target.is_file() {
        return;
    }
    let script = Script { text: text.to_string(), voice: settings.voice.clone(), speed: settings.speed, pause: settings.pause, created_at: now_ms() };
    if let Ok(json) = serde_json::to_string_pretty(&script) {
        if let Err(e) = std::fs::write(&target, json) {
            eprintln!("Couldn't save the voice-over's script: {}", e);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOverEntry {
    path: String,
    seconds: f64,
    // None for one made before scripts were kept (v0.1.3 and earlier) - then only the start of its
    // words survives, in the file name.
    text: Option<String>,
    voice: Option<String>,
    speed: Option<f32>,
    pause: Option<f32>,
    created_at: u64,
}

// Every AI voice-over in the library's Voice-overs folder, newest first.
#[tauri::command]
pub async fn tts_history() -> Result<Vec<VoiceOverEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = crate::services::utility::briefcast_dir()?.join("Voice-overs");
        let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
        let mut list = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("AI voice - ") || !name.to_lowercase().ends_with(".wav") {
                continue;
            }
            let script: Option<Script> = std::fs::read_to_string(script_path(&path)).ok().and_then(|j| serde_json::from_str(&j).ok());
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            // "AI voice - <words> - <voice> <key>.wav" names the voice even without a script.
            let voice_from_name = name.trim_end_matches(".wav").rsplit(" - ").next().and_then(|tail| tail.split(' ').next()).map(str::to_string);
            list.push(match script {
                Some(s) => VoiceOverEntry { path: path.to_string_lossy().into_owned(), seconds: seconds_of(&path), text: Some(s.text), voice: Some(s.voice), speed: Some(s.speed), pause: Some(s.pause), created_at: s.created_at },
                None => VoiceOverEntry { path: path.to_string_lossy().into_owned(), seconds: seconds_of(&path), text: None, voice: voice_from_name, speed: None, pause: None, created_at: modified },
            });
        }
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(list)
    })
    .await
    .map_err(|e| format!("Voice history task failed: {}", e))?
}

#[tauri::command(async)]
pub fn cancel_tts() {
    SYNTH_CANCELLED.store(true, Ordering::SeqCst);
}

// A few seconds of `voice` for the picker - made once per voice and kept.
#[tauri::command]
pub async fn tts_preview(app_handle: AppHandle, voice: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let spec = tts::voice_spec(&voice)?;
        if !tts::assets_ready(&app_handle) {
            return Err("The AI voice hasn't been downloaded yet.".to_string());
        }
        let settings = Settings { voice: voice.clone(), speed: 1.0, pause: 1.0 };
        let text = format!("Hi, I'm {}. This is how I'd read your voice-over, with a steady pace and natural pauses.", spec.name);
        let path = tts::tts_dir(&app_handle)?.join("previews").join(format!("{}-{}.wav", voice, tts::request_key(&text, &settings)));
        if !path.is_file() {
            // Previews never interrupt, or are interrupted by, the person's own recording being made.
            let never = AtomicBool::new(false);
            let spoken = tts::synthesize(&app_handle, &text, &settings, &never, &|_, _| {})?;
            tts::write_wav(&path, &spoken.samples)?;
        }
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Voice task failed: {}", e))?
}

// Frees the model's memory (about half a gigabyte while loaded) - called when the panel closes.
#[tauri::command(async)]
pub fn tts_release() {
    tts::release_engine();
}
