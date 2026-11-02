// Pinned, verified downloads for the large optional pieces that aren't bundled with the installer
// (the voice/music separation engine in commands/audio_tracks.rs, the speech-to-text model in
// services/whisper_model.rs). Every file is pinned by size and SHA-256, so a truncated download or
// a swapped file on the host is rejected, never used.
//
// Downloads go through the system curl (built into Windows 10 1803+, macOS and Linux) rather than
// an HTTP crate: the reqwest already in the dependency tree is built without TLS, and turning TLS
// on drags in a native crypto build - a lot of weight for a couple of download buttons.
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[cfg(windows)]
use crate::commands::recording::hide_console_window;
use crate::services::utility::find_on_path;

pub struct DownloadAsset {
    pub file_name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

pub fn sha256_of(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect())
}

pub fn is_valid_install(path: &Path, asset: &DownloadAsset) -> bool {
    std::fs::metadata(path).map(|m| m.len() == asset.size).unwrap_or(false) && sha256_of(path).map(|h| h == asset.sha256).unwrap_or(false)
}

// Fetches one asset to `<dest>.part` via curl, calling `on_progress` with the bytes on disk
// (curl's own progress meter isn't machine-readable), then verifies it and renames it into place.
// Returns Err(cancelled_err) if `cancel` is set while it runs.
pub fn download_asset(
    asset: &DownloadAsset,
    dest: &Path,
    cancel: &AtomicBool,
    cancelled_err: &str,
    on_progress: &dyn Fn(u64),
) -> Result<(), String> {
    let part = dest.with_extension("part");
    let _ = std::fs::remove_file(&part);
    let curl = find_on_path("curl").ok_or_else(|| format!("curl was not found on this system, so {} can't be downloaded", asset.file_name))?;
    let mut cmd = Command::new(curl);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let mut child = cmd
        .args(["--location", "--fail", "--silent", "--show-error", "--retry", "3", "--output"])
        .arg(&part)
        .arg(asset.url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start download: {}", e))?;

    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&part);
            return Err(cancelled_err.to_string());
        }
        on_progress(std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0).min(asset.size));
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => return Err(format!("Download failed: {}", e)),
        }
    };
    if !status.success() {
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut err);
        }
        let _ = std::fs::remove_file(&part);
        return Err(format!("Download of {} failed: {}", asset.file_name, err.trim()));
    }
    if !is_valid_install(&part, asset) {
        let _ = std::fs::remove_file(&part);
        return Err(format!("Downloaded {} failed its integrity check - please try again", asset.file_name));
    }
    let _ = std::fs::remove_file(dest);
    std::fs::rename(&part, dest).map_err(|e| format!("Failed to install {}: {}", asset.file_name, e))
}
