// The speech-to-text model behind generate_captions and transcribe_doc_audio (conversion.rs).
//
// Not bundled with the installer: it's 148 MB and barely compresses, which made it over half the
// download for a feature only some users ever touch. Instead the first caption/dictation run
// fetches it into <app local data>/whisper (pinned and verified by services/asset_download.rs),
// emitting "whisper-model-download" {downloaded, total} so the UI can say what the wait is.
//
// Deliberately the multilingual base model (no ".en" suffix): the English-only variant isn't
// meaningfully smaller, and language selection (generate_captions' `language` param) only works
// at all because this model understands more than English.
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};

use crate::services::asset_download::{download_asset, DownloadAsset};

static CACHED_MODEL_PATH: OnceLock<PathBuf> = OnceLock::new();
static CACHED_VAD_PATH: OnceLock<PathBuf> = OnceLock::new();
static VAD_PREFETCH_STARTED: AtomicBool = AtomicBool::new(false);

const MODEL_ASSET: DownloadAsset = DownloadAsset {
    file_name: "ggml-base.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    size: 147_951_465,
};

// Nothing cancels this download (captions/dictation have no cancel of their own), but
// download_asset takes a flag either way.
static NEVER_CANCELLED: AtomicBool = AtomicBool::new(false);

// Serializes downloads so captions and dictation started together don't both write the same
// .part file.
static DOWNLOAD_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelDownloadProgress {
    downloaded: u64,
    total: u64,
}

fn downloaded_model_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    app_handle
        .path()
        .app_local_data_dir()
        .map(|d| d.join("whisper").join(MODEL_ASSET.file_name))
        .map_err(|e| format!("Failed to resolve app data folder: {}", e))
}

// Size check only: the SHA-256 was verified when it was downloaded, and re-hashing 148 MB before
// every caption run would add a noticeable pause for nothing.
fn is_downloaded(path: &PathBuf) -> bool {
    std::fs::metadata(path).map(|m| m.len() == MODEL_ASSET.size).unwrap_or(false)
}

fn bundled_model_path(app_handle: &AppHandle) -> Option<PathBuf> {
    let resource_rel = format!("binaries/whisper/{}", MODEL_ASSET.file_name);
    if let Ok(candidate) = app_handle.path().resolve(&resource_rel, BaseDirectory::Resource) {
        if is_downloaded(&candidate) {
            return Some(candidate);
        }
    }
    if let Ok(cli_path) = crate::services::utility::get_whisper_cli_path(app_handle) {
        let sibling = cli_path.with_file_name(MODEL_ASSET.file_name);
        if is_downloaded(&sibling) {
            return Some(sibling);
        }
    }
    None
}

// Returns the model's path, downloading it first if this machine doesn't have it yet. Blocking -
// call from spawn_blocking.
pub fn ensure_model(app_handle: &AppHandle) -> Result<PathBuf, String> {
    if let Some(cached) = CACHED_MODEL_PATH.get() {
        if cached.is_file() {
            return Ok(cached.clone());
        }
    }
    if let Some(bundled) = bundled_model_path(app_handle) {
        let _ = CACHED_MODEL_PATH.set(bundled.clone());
        return Ok(bundled);
    }
    let dest = downloaded_model_path(app_handle)?;
    if is_downloaded(&dest) {
        let _ = CACHED_MODEL_PATH.set(dest.clone());
        return Ok(dest);
    }

    let _guard = DOWNLOAD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if is_downloaded(&dest) {
        let _ = CACHED_MODEL_PATH.set(dest.clone());
        return Ok(dest); // another caller finished it while this one waited
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create speech model folder: {}", e))?;
    }
    let total = MODEL_ASSET.size;
    let progress = |downloaded: u64| {
        let _ = app_handle.emit("whisper-model-download", ModelDownloadProgress { downloaded, total });
    };
    download_asset(&MODEL_ASSET, &dest, &NEVER_CANCELLED, "WHISPER_DOWNLOAD_CANCELLED", &progress)
        .map_err(|e| format!("Couldn't download the speech-to-text model (needed once, {} MB): {}", total / 1_000_000, e))?;
    progress(total);
    let _ = CACHED_MODEL_PATH.set(dest.clone());
    Ok(dest)
}

// Silero voice-activity detection, for whisper-cli's --vad: whisper then transcribes only the
// stretches that really contain speech, which is what gives edit-by-transcript accurate word
// starts - without it, word timings drift by a second or more across pauses (measured: a word
// spoken at 5.7s came back as 4.2s), and cutting a word by its timing would miss it. Under 1 MB,
// fetched alongside the speech model the first time a word-timed transcript is made.
const VAD_ASSET: DownloadAsset = DownloadAsset {
    file_name: "ggml-silero-v5.1.2.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
    size: 885_098,
};

// The VAD model's path, downloading it first if needed. Optional by design: callers fall back to
// transcribing without VAD (looser word timings, still usable captions) rather than failing.
// Blocking - call from spawn_blocking.
pub fn ensure_vad_model(app_handle: &AppHandle) -> Result<PathBuf, String> {
    if let Some(cached) = CACHED_VAD_PATH.get() {
        if cached.is_file() {
            return Ok(cached.clone());
        }
    }
    let dest = app_handle
        .path()
        .app_local_data_dir()
        .map(|d| d.join("whisper").join(VAD_ASSET.file_name))
        .map_err(|e| format!("Failed to resolve app data folder: {}", e))?;
    let ready = |p: &PathBuf| std::fs::metadata(p).map(|m| m.len() == VAD_ASSET.size).unwrap_or(false);
    if ready(&dest) {
        let _ = CACHED_VAD_PATH.set(dest.clone());
        return Ok(dest);
    }
    let _guard = DOWNLOAD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if ready(&dest) {
        let _ = CACHED_VAD_PATH.set(dest.clone());
        return Ok(dest);
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create speech model folder: {}", e))?;
    }
    download_asset(&VAD_ASSET, &dest, &NEVER_CANCELLED, "WHISPER_DOWNLOAD_CANCELLED", &|_| {})
        .map_err(|e| format!("Couldn't download the voice-detection model: {}", e))?;
    let _ = CACHED_VAD_PATH.set(dest.clone());
    Ok(dest)
}

// Non-blocking lookup for real-time dictation: returns the Silero VAD model immediately if it is
// already on disk, or triggers a one-time background fetch so subsequent chunks can use it without
// delaying the first spoken phrase.
pub fn existing_vad_model(app_handle: &AppHandle) -> Option<PathBuf> {
    if let Some(cached) = CACHED_VAD_PATH.get() {
        if cached.is_file() {
            return Some(cached.clone());
        }
    }
    let resource_rel = format!("binaries/whisper/{}", VAD_ASSET.file_name);
    if let Ok(candidate) = app_handle.path().resolve(&resource_rel, BaseDirectory::Resource) {
        if std::fs::metadata(&candidate).map(|m| m.len() == VAD_ASSET.size).unwrap_or(false) {
            let _ = CACHED_VAD_PATH.set(candidate.clone());
            return Some(candidate);
        }
    }
    if let Ok(dest) = app_handle.path().app_local_data_dir().map(|d| d.join("whisper").join(VAD_ASSET.file_name)) {
        if std::fs::metadata(&dest).map(|m| m.len() == VAD_ASSET.size).unwrap_or(false) {
            let _ = CACHED_VAD_PATH.set(dest.clone());
            return Some(dest);
        }
    }
    if !VAD_PREFETCH_STARTED.swap(true, Ordering::SeqCst) {
        let handle = app_handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = ensure_vad_model(&handle);
        });
    }
    None
}
