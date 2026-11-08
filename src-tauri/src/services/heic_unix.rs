// services/heic_unix.rs
//
// HEIC/HEIF decode for macOS and Linux - the non-Windows counterpart to heic_windows.rs +
// heif_tool.rs. There's no OS-built-in HEIC decoder to try first here the way Windows has WIC, so
// this goes straight to libheif, the reference HEIF implementation, exactly like heif_tool.rs's
// fallback tier already does on Windows - see that module's own doc comment for why ffmpeg's own
// HEIF tile-grid reconstruction can't be trusted (black frames / badly-under-reconstructed
// fragments on real multi-image iPhone Portrait-mode/Deep Fusion photos).
//
// Unlike heif_tool.rs, this doesn't bundle a prebuilt binary - it shells out to a system-installed
// `heif-convert` / `heif-thumbnailer`, libheif's own example CLI tools (installable via
// `brew install libheif` on macOS, `apt install libheif-examples` on Debian/Ubuntu Linux). Bundling
// would mean either linking libheif at build time (forcing every Linux/macOS build - CI included -
// to have libheif-dev present just to compile, and the resulting binary to dynamically link
// libheif at runtime, failing to even *launch* without it) or replicating the ~15-DLL dependency
// tree binaries/heif/ bundles for Windows across every Linux distro's ABI - a real packaging
// project of its own. A missing system tool instead degrades to a clear, actionable error only
// when a HEIC file is actually opened, the same soft-failure shape this app already uses for
// Windows' HEVC-Extensions-missing case.
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::services::utility::path_to_str;

#[cfg(target_os = "macos")]
const INSTALL_HINT: &str = "install libheif (`brew install libheif`)";
#[cfg(target_os = "linux")]
const INSTALL_HINT: &str = "install libheif's example tools (e.g. `sudo apt install libheif-examples` on Debian/Ubuntu, or the equivalent `libheif-tools`/`libheif-utils` package on your distro)";

// libheif ships its codecs as plugins on newer distributions, and iPhone photos are HEVC. With
// libheif installed but no HEVC decoder plugin, heif-convert fails with "Unsupported feature:
// Unsupported codec" - true, but not something anyone can act on. This says what is missing.
pub const NO_HEVC_DECODER: &str = "libheif has no HEVC decoder";

#[cfg(target_os = "macos")]
const DECODER_HINT: &str = "reinstall it with `brew reinstall libheif`";
#[cfg(target_os = "linux")]
const DECODER_HINT: &str = "install the decoder plugin (`sudo apt install libheif-plugin-libde265` on Debian/Ubuntu 24.04 or newer; older releases include it in libheif1, and Fedora has it in `libheif-freeworld` from RPM Fusion)";

/// Whether an error from this module means "no HEVC decoder" rather than a problem with the photo.
/// (Tests use it to tell an environment without the plugin from a real decode failure.)
#[cfg(test)]
pub fn is_missing_hevc_decoder(error: &str) -> bool {
    error.contains(NO_HEVC_DECODER)
}

fn failure_message(tool: &str, stderr: &str) -> String {
    let stderr = stderr.trim();
    if stderr.contains("Unsupported codec") {
        format!("{NO_HEVC_DECODER}, the codec iPhone photos use, so this photo can't be opened - {DECODER_HINT} ({tool}: {stderr})")
    } else {
        format!("{tool} failed: {stderr}")
    }
}

fn run(mut cmd: Command, tool: &str) -> Result<std::process::Output, String> {
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    cmd.output().map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            format!("{tool} is not installed - {INSTALL_HINT} to convert HEIC/HEIF photos on this platform")
        } else {
            format!("Failed to start {tool}: {e}")
        }
    })
}

fn decode_blocking(input_path: &Path, output_path: &Path) -> Result<(), String> {
    let mut cmd = Command::new("heif-convert");
    cmd.arg(path_to_str(input_path)?);
    cmd.arg(path_to_str(output_path)?);

    let output = run(cmd, "heif-convert")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(failure_message("heif-convert", &stderr));
    }
    if !output_path.exists() {
        return Err("heif-convert exited successfully but produced no output file".to_string());
    }
    Ok(())
}

// Mirrors heic_windows::decode_to_png / heif_tool::decode_to_png's signature exactly, so
// commands/conversion.rs's call sites need only a third dispatch arm, not new call shapes.
pub async fn decode_to_png(input_path: PathBuf, output_path: PathBuf) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || decode_blocking(&input_path, &output_path))
        .await
        .map_err(|e| format!("HEIC decode task panicked: {e}"))?
}

fn extract_thumbnail_blocking(
    input_path: &Path,
    output_path: &Path,
    size: u32,
) -> Result<(), String> {
    let mut cmd = Command::new("heif-thumbnailer");
    cmd.arg("-s").arg(size.to_string());
    cmd.arg(path_to_str(input_path)?);
    cmd.arg(path_to_str(output_path)?);

    let output = run(cmd, "heif-thumbnailer")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(failure_message("heif-thumbnailer", &stderr));
    }
    if !output_path.exists() {
        return Err("heif-thumbnailer exited successfully but produced no output file".to_string());
    }
    Ok(())
}

// Mirrors heif_tool::extract_thumbnail's signature - see that module's own doc comment for why
// this is a distinct, much cheaper operation than a full decode_to_png (renders the small embedded
// preview a HEIC container already carries, rather than reconstructing the full tile grid).
pub async fn extract_thumbnail(
    input_path: PathBuf,
    output_path: PathBuf,
    size: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        extract_thumbnail_blocking(&input_path, &output_path, size)
    })
    .await
    .map_err(|e| format!("HEIC thumbnail task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_hevc_decoder_gets_an_actionable_message() {
        // What libheif prints on a CI image with heif-convert but no libde265 plugin.
        let m = failure_message("heif-convert", "Could not decode image: 0: Unsupported feature: Unsupported codec\n");
        assert!(is_missing_hevc_decoder(&m), "{m}");
        assert!(m.contains(DECODER_HINT), "must say how to fix it: {m}");
        assert!(m.contains("Unsupported codec"), "and keep libheif's own words for support: {m}");
    }

    #[test]
    fn other_failures_pass_through_and_are_not_mistaken_for_a_missing_decoder() {
        let m = failure_message("heif-convert", "Could not read input file\n");
        assert_eq!(m, "heif-convert failed: Could not read input file");
        assert!(!is_missing_hevc_decoder(&m));
        // An unsupported *feature* of some other kind is the photo's problem, not a missing plugin.
        assert!(!is_missing_hevc_decoder(&failure_message("heif-convert", "Unsupported feature: Unsupported image type")));
    }
}
