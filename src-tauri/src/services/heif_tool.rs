// services/heif_tool.rs
//
// Fallback HEIC/HEIF decoder for when Windows' own WIC/WinRT decode (heic_windows.rs) fails -
// most commonly because the machine has "HEIF Image Extensions" (container/metadata) but not the
// separate "HEVC Video Extensions" package (the actual H.265 pixel decoder), which many real
// Windows installs simply don't have preinstalled. commands/conversion.rs used to fall back to
// the app's own bundled ffmpeg for this, but ffmpeg's HEIF tile-grid reconstruction badly
// under-reconstructs the tiled grid modern iPhone photos are stored as - not a black frame this
// time, but a small, blown-up fragment of the real photo (confirmed against real user photos).
// That's a known limitation of that ffmpeg build's HEIF support, not a flag to tune away (see
// commands/conversion.rs's convert_heic_windows/get_heic_preview for where this replaced it).
//
// Instead, this shells out to a bundled libheif build (binaries/heif/heif-dec.exe, from MSYS2's
// mingw-w64-x86_64-libheif package) - the reference HEIF implementation, which reconstructs tile
// grids correctly. It's a real process spawn rather than an in-process library call (no Rust
// FFI bindings to libheif exist for this project), so it's spawned on the blocking thread pool
// the same way heic_windows.rs's WIC calls are, and hidden from the taskbar/screen the same way
// every other bundled-binary spawn in this app is (hide_console_window).
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::AppHandle;

use crate::services::utility::{get_heif_decoder_path, get_heif_thumbnailer_path, path_to_str};

#[cfg(windows)]
use crate::commands::recording::hide_console_window;

fn extract_thumbnail_blocking(app_handle: &AppHandle, input_path: &PathBuf, output_path: &PathBuf, size: u32) -> Result<(), String> {
    let thumbnailer_path = get_heif_thumbnailer_path(app_handle)?;

    let mut cmd = Command::new(&thumbnailer_path);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.arg("-s").arg(size.to_string());
    cmd.arg(path_to_str(input_path)?);
    cmd.arg(path_to_str(output_path)?);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = cmd.output().map_err(|e| format!("Failed to start heif-thumbnailer: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("heif-thumbnailer failed: {}", stderr.trim()));
    }
    if !output_path.exists() {
        return Err("heif-thumbnailer exited successfully but produced no output file".to_string());
    }
    Ok(())
}

// Renders/extracts a small preview from a HEIC/HEIF file for gallery-grid display - see this
// module's own doc comment for why that's a different tool (and dramatically faster) than
// decode_to_png's full tile-grid reconstruction. Same blocking-pool-spawn shape as decode_to_png.
pub async fn extract_thumbnail(app_handle: AppHandle, input_path: PathBuf, output_path: PathBuf, size: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || extract_thumbnail_blocking(&app_handle, &input_path, &output_path, size))
        .await
        .map_err(|e| format!("HEIC thumbnail task panicked: {e}"))?
}

fn decode_blocking(app_handle: &AppHandle, input_path: &PathBuf, output_path: &PathBuf) -> Result<(), String> {
    let decoder_path = get_heif_decoder_path(app_handle)?;

    let mut cmd = Command::new(&decoder_path);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.arg(path_to_str(input_path)?);
    cmd.arg(path_to_str(output_path)?);
    // No interactive input, and no progress stream to read - a single still image decodes in
    // well under a second, so there's nothing worth the complexity run_conversion's stdout/stderr
    // progress-parsing threads exist for.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = cmd.output().map_err(|e| format!("Failed to start heif-dec: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("heif-dec failed: {}", stderr.trim()));
    }
    if !output_path.exists() {
        return Err("heif-dec exited successfully but produced no output file".to_string());
    }
    Ok(())
}

// Runs the external process on a dedicated blocking-pool thread - Command::output() blocks the
// calling thread until the child exits, which doesn't belong on an async worker thread (mirrors
// heic_windows.rs's decode_to_png wrapper for the same reason).
pub async fn decode_to_png(app_handle: AppHandle, input_path: PathBuf, output_path: PathBuf) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || decode_blocking(&app_handle, &input_path, &output_path))
        .await
        .map_err(|e| format!("HEIC fallback decode task panicked: {e}"))?
}
