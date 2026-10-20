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
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::services::asset_download::{download_asset, DownloadAsset};

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

// Returns the model's path, downloading it first if this machine doesn't have it yet. Blocking -
// call from spawn_blocking.
pub fn ensure_model(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dest = downloaded_model_path(app_handle)?;
    if is_downloaded(&dest) {
        return Ok(dest);
    }

    let _guard = DOWNLOAD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if is_downloaded(&dest) {
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
    let dest = app_handle
        .path()
        .app_local_data_dir()
        .map(|d| d.join("whisper").join(VAD_ASSET.file_name))
        .map_err(|e| format!("Failed to resolve app data folder: {}", e))?;
    let ready = |p: &PathBuf| std::fs::metadata(p).map(|m| m.len() == VAD_ASSET.size).unwrap_or(false);
    if ready(&dest) {
        return Ok(dest);
    }
    let _guard = DOWNLOAD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if ready(&dest) {
        return Ok(dest);
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create speech model folder: {}", e))?;
    }
    download_asset(&VAD_ASSET, &dest, &NEVER_CANCELLED, "WHISPER_DOWNLOAD_CANCELLED", &|_| {})
        .map_err(|e| format!("Couldn't download the voice-detection model: {}", e))?;
    Ok(dest)
}
