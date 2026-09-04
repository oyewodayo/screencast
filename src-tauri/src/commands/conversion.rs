// conversion.rs
use std::collections::HashMap;
use tauri::{AppHandle, Window, State};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Stdio, Command};
use std::sync::Arc;
use tauri::async_runtime::Mutex;
use std::io::{BufRead, BufReader};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use crate::services::utility::{path_to_str, get_ffmpeg_path, get_ffprobe_path};

#[cfg(windows)]
use crate::commands::recording::hide_console_window;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConversionProgress {
    pub input_path: String,
    pub output_path: String,
    pub progress: f64,
    pub status: ConversionStatus,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ConversionStatus {
    Starting,
    Processing,
    Completed,
    Failed,
}

#[derive(Default, Clone)]
pub struct ConversionState {
    active_process: Arc<Mutex<Option<u32>>>, // Store PID instead of Child
}

// Helper function to parse duration from FFmpeg output (format: HH:MM:SS.ms)
fn parse_duration(output: &str) -> Option<f64> {
    for line in output.lines() {
        if line.contains("Duration:") {
            if let Some(duration_str) = line.split("Duration:").nth(1) {
                if let Some(time_str) = duration_str.split(',').next() {
                    let time_str = time_str.trim();
                    let parts: Vec<&str> = time_str.split(':').collect();
                    if parts.len() == 3 {
                        if let (Ok(hours), Ok(minutes), Ok(seconds)) = (
                            parts[0].parse::<f64>(),
                            parts[1].parse::<f64>(),
                            parts[2].parse::<f64>(),
                        ) {
                            return Some(hours * 3600.0 + minutes * 60.0 + seconds);
                        }
                    }
                }
            }
        }
    }
    None
}

// If `path` is already taken, finds the next free "name (1).ext", "name (2).ext", ... instead -
// converting the same source to the same target format twice (a very ordinary thing to do:
// convert, tweak something, convert again) used to hard-fail with "Output file already exists"
// for no reason a user could act on other than renaming or deleting the previous output
// themselves first. Recording's own resolve_output_path (commands/recording.rs) already takes
// this same approach for a name collision - conversion output just never got the same treatment.
fn unique_output_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }

    let parent = path.parent().map(PathBuf::from).unwrap_or_default();
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|s| s.to_string_lossy().to_string());

    for n in 1.. {
        let candidate_name = match &ext {
            Some(ext) => format!("{} ({}).{}", stem, n, ext),
            None => format!("{} ({})", stem, n),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!()
}


// One `-i` worth of input - `pre_args` is whatever ffmpeg input-level flags need to appear
// *before* that `-i` (input-level options only take effect on the input they immediately
// precede, unlike output-level options like `-c:v`). Every existing caller just needs a plain
// path (empty pre_args); export_trimmed_video's overlay PNGs are the one case that needs
// `-loop 1 -t <duration>` ahead of theirs, to turn a single still frame into a looped stream long
// enough to composite across the whole output - see its own comment for why.
struct InputSpec {
    path: String,
    pre_args: Vec<String>,
}

impl InputSpec {
    fn plain(path: String) -> Self {
        Self { path, pre_args: Vec::new() }
    }
}

// Shared conversion runner used by every command in this file, so every target format gets the
// same stderr progress-parsing thread (convert_video previously lacked one, so its progress bar
// silently never moved). Takes a *list* of inputs (each becomes its own `-i`) rather than a
// single path - export_trimmed_video needs that to pull clips from more than one source file;
// every other caller here just passes a single-element list. `progress_key` is what's reported
// as `input_path` on emitted events - for single-input callers that's just the input path
// itself, for a multi-input export it's the output file's own base path, since there's no one
// "the input" to name it after and the frontend already keys its progress listener off whatever
// it originally requested the export under.
async fn run_conversion(
    app_handle: &AppHandle,
    window: &Window,
    state: &State<'_, ConversionState>,
    inputs: &[InputSpec],
    progress_key: &str,
    output: PathBuf,
    codec_args: &[&str],
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;

    for input in inputs {
        if !PathBuf::from(&input.path).exists() {
            return Err(format!("Input file does not exist: {}", input.path));
        }
    }

    let output = unique_output_path(output);

    let _ = window.emit("conversion-progress", ConversionProgress {
        input_path: progress_key.to_string(),
        output_path: output.to_string_lossy().to_string(),
        progress: 0.0,
        status: ConversionStatus::Starting,
        message: "Starting conversion...".to_string(),
    });

    let mut cmd = Command::new(&ffmpeg_path);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    for input in inputs {
        for arg in &input.pre_args {
            cmd.arg(arg);
        }
        cmd.arg("-i").arg(path_to_str(&PathBuf::from(&input.path))?);
    }
    cmd.args(codec_args);
    // -progress pipe:1 makes ffmpeg write machine-readable key=value progress lines to
    // stdout, newline-terminated. Without it, ffmpeg only prints a human-readable status
    // line to stderr that it rewrites in place with '\r' (never '\n'), which BufReader's
    // line-based reader never yields as a line - so progress silently never updated.
    // -nostats suppresses that human status line so it doesn't clutter the stderr scan below.
    cmd.args(["-y", "-progress", "pipe:1", "-nostats"]);
    cmd.arg(path_to_str(&output)?);
    // No interactive input is ever needed (the -y above suppresses overwrite prompts), and
    // leaving stdin inherited from the parent risks ffmpeg blocking on a read that never
    // resolves when run from a console-attached dev build.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start conversion: {}", e))?;

    let pid = child.id();
    {
        let mut active_process = state.active_process.lock().await;
        *active_process = Some(pid);
    }

    let stderr = child.stderr.take()
        .ok_or("Failed to capture stderr")?;
    let stdout = child.stdout.take()
        .ok_or("Failed to capture stdout")?;

    // Total duration comes from ffmpeg's initial "Duration: HH:MM:SS.ms" line on stderr;
    // current position comes from the structured -progress stream on stdout. Shared so the
    // stdout reader thread can turn "out_time_us" into a percentage once duration is known.
    let duration = Arc::new(std::sync::Mutex::new(None::<f64>));

    let duration_for_stderr = duration.clone();
    // Returns the accumulated stderr (rather than stashing it in a Mutex read right after
    // child.wait()) so the failure branch below can .join() this thread and be sure every line
    // - including whatever ffmpeg printed right as it exited - was actually captured, instead of
    // racing a reader thread that's still draining the pipe.
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut full_output = String::new();

        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => continue,
            };

            full_output.push_str(&line);
            full_output.push('\n');

            let mut guard = duration_for_stderr.lock().unwrap();
            if guard.is_none() {
                *guard = parse_duration(&full_output);
            }
        }

        full_output
    });

    let window_clone = window.clone();
    let progress_key_clone = progress_key.to_string();
    let output_path_clone = output.to_string_lossy().to_string();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => continue,
            };

            let Some(us_str) = line.strip_prefix("out_time_us=") else { continue };
            let Ok(current_us) = us_str.trim().parse::<i64>() else { continue };
            if current_us < 0 { continue }

            let Some(total_duration) = *duration.lock().unwrap() else { continue };
            if total_duration <= 0.0 { continue }

            let current_time = current_us as f64 / 1_000_000.0;
            let progress = (current_time / total_duration * 100.0).clamp(0.0, 99.0);

            let _ = window_clone.emit("conversion-progress", ConversionProgress {
                input_path: progress_key_clone.clone(),
                output_path: output_path_clone.clone(),
                progress,
                status: ConversionStatus::Processing,
                message: format!("Converting... {:.1}%", progress),
            });
        }
    });

    // Wait for process to complete off the async runtime's worker threads - a transcode
    // can take minutes, and child.wait() blocks synchronously.
    let result = tauri::async_runtime::spawn_blocking(move || child.wait())
        .await
        .map_err(|e| format!("Conversion task panicked: {}", e))?
        .map_err(|e| format!("Failed to wait for conversion: {}", e))?;

    {
        let mut active_process = state.active_process.lock().await;
        *active_process = None;
    }

    if result.success() {
        let _ = window.emit("conversion-progress", ConversionProgress {
            input_path: progress_key.to_string(),
            output_path: output.to_string_lossy().to_string(),
            progress: 100.0,
            status: ConversionStatus::Completed,
            message: "Conversion completed successfully".to_string(),
        });

        Ok(output.to_string_lossy().to_string())
    } else {
        let stderr_output = stderr_thread.join().unwrap_or_default();
        let error_msg = format!(
            "Conversion failed: {}",
            crate::commands::recording::extract_ffmpeg_error(&stderr_output)
        );

        let _ = window.emit("conversion-progress", ConversionProgress {
            input_path: progress_key.to_string(),
            output_path: output.to_string_lossy().to_string(),
            progress: 0.0,
            status: ConversionStatus::Failed,
            message: error_msg.clone(),
        });

        Err(error_msg)
    }
}

#[tauri::command]
pub async fn convert_to_mp4(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
    output_path: Option<String>,
    preserve_original: bool,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let output = match output_path {
        Some(path) => PathBuf::from(path),
        None => input.with_extension("mp4"),
    };

    let codec_args = [
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
    ];

    let result = run_conversion(&app_handle, &window, &state, &[InputSpec::plain(input_path.clone())], &input_path, output, &codec_args).await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
}

// Deterministic, content-addressed cache location for a "just display/play it, no prompts"
// preview (see get_playable_preview and get_heic_preview below) - keyed by the source path plus
// its modification time, so a file replaced at the same path invalidates and regenerates
// automatically instead of ever silently reusing a stale preview. `namespace` is a subdirectory,
// not just decoration - it's what lets a *decoder* change (not just a source file change) bust
// old cached output too: get_heic_preview used to fall back to ffmpeg, whose HEIF tile-grid
// reconstruction badly under-reconstructed these photos (a cropped fragment, not just lower
// quality) - every photo previewed before that got fixed left a wrong-but-permanently-cached PNG
// sitting here under the *same* path+mtime key the corrected decoder would also produce, so nothing
// short of a namespace change would ever have invalidated it. Bump the namespace's suffix (e.g.
// "heic_v3") again if a future decoder change needs the same guarantee.
fn preview_cache_path(input: &PathBuf, namespace: &str, output_ext: &str) -> Result<PathBuf, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let metadata = std::fs::metadata(input).map_err(|e| format!("Failed to read input file: {}", e))?;
    let modified_secs = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    input.to_string_lossy().hash(&mut hasher);
    modified_secs.hash(&mut hasher);
    let key = hasher.finish();

    Ok(std::env::temp_dir().join("briefcast_preview_cache").join(namespace).join(format!("{:x}.{}", key, output_ext)))
}

// Silent, no-prompt fallback for a file the in-app player can't decode natively - most notably
// .avi, which WebView2's <video> element has no container support for at all regardless of the
// codec inside it; no ffmpeg encoding setting can change that. VideoPlayer.tsx calls this only
// from its <video> element's onError handler (never up front), so a file that already plays
// fine never pays this cost.
//
// This used to try to stream the conversion progressively (return the output path immediately
// and let the player read the still-growing file via MediaSource + ranged fetch) so a large
// recording wouldn't block on the full re-encode. That depended on WebView2's specific
// MediaSource implementation, exact codec-string matching, and fetch-over-a-custom-protocol all
// behaving as expected - none of which is inspectable from here (no devtools/console access to
// this app's running window), and it broke in practice twice. VLC-style universal playback works
// because VLC owns its entire decode pipeline (libavformat/libavcodec directly, no browser
// engine in between); trying to reproduce that inside a webview's <video>/MediaSource stack means
// depending on a browser vendor's partial implementation of it instead. Simpler and actually
// verifiable: wait for the real, complete conversion (ultrafast preset, so normally a small
// fraction of the recording's own runtime - measured ~3x faster than real-time against this
// app's own bundled ffmpeg) and then load an ordinary, fully-written file the exact way every
// other video in this app already plays.
#[tauri::command]
pub async fn get_playable_preview(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let cache_path = preview_cache_path(&input, "video", "mp4")?;

    // Already converted (fully, from a previous open) - just hand back the finished file, no
    // need to ever re-run ffmpeg for the same source.
    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create preview cache directory: {}", e))?;
    }

    let codec_args = [
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
    ];

    run_conversion(&app_handle, &window, &state, &[InputSpec::plain(input_path.clone())], &input_path, cache_path, &codec_args).await
}

// Convert a still image (screenshot) between png/jpeg/webp/bmp. No audio/video codec args
// apply here - ffmpeg's image2 muxer picks a sane default encoder from the output extension,
// and run_conversion's duration-based progress just never populates (there's no "Duration:"
// line for a single frame), which is fine since these finish effectively instantly anyway.
#[tauri::command]
pub async fn convert_image(
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
        "png" | "jpeg" | "jpg" | "webp" | "bmp" => vec![],
        _ => return Err(format!("Unsupported output format: {}", output_format)),
    };

    // HEIC/HEIF inputs skip ffmpeg entirely on Windows - see heic_windows.rs's module doc for why
    // (the bundled ffmpeg build mis-decodes modern iPhone Portrait-mode/multi-image HEIC files as
    // a black frame). Not gated on the *output* format because the bug is in reading the HEIC
    // source, not in what ffmpeg would have encoded it to.
    #[cfg(windows)]
    {
        let input_ext = input.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase());
        if matches!(input_ext.as_deref(), Some("heic") | Some("heif")) {
            return convert_heic_windows(&app_handle, &window, &state, &input, output, &output_format, preserve_original).await;
        }
    }

    let result = run_conversion(&app_handle, &window, &state, &[InputSpec::plain(input_path.clone())], &input_path, output, &codec_args).await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
}

// HEIC/HEIF path for convert_image, above - always decodes through Windows' own HEIF codec to a
// full-resolution PNG first (see heic_windows::decode_to_png), then - unless PNG is what was
// actually asked for - hands that PNG to the same ffmpeg image2 pipeline every other image format
// already uses to reach jpeg/webp/bmp. ffmpeg is perfectly reliable at that second step; the only
// thing it couldn't be trusted with was reading the HEIC file in the first place.
#[cfg(windows)]
async fn convert_heic_windows(
    app_handle: &AppHandle,
    window: &Window,
    state: &State<'_, ConversionState>,
    input: &PathBuf,
    output: PathBuf,
    output_format: &str,
    preserve_original: bool,
) -> Result<String, String> {
    let _ = window.emit("conversion-progress", ConversionProgress {
        input_path: input.to_string_lossy().to_string(),
        output_path: output.to_string_lossy().to_string(),
        progress: 0.0,
        status: ConversionStatus::Starting,
        message: "Decoding HEIC photo...".to_string(),
    });

    let format = output_format.to_lowercase();
    let final_output = unique_output_path(output);

    let native_result: Result<String, String> = async {
        if format == "png" {
            crate::services::heic_windows::decode_to_png(input.clone(), final_output.clone()).await?;
            Ok(final_output.to_string_lossy().to_string())
        } else {
            let temp_png = final_output.with_extension("heic_tmp.png");
            crate::services::heic_windows::decode_to_png(input.clone(), temp_png.clone()).await?;
            let transcode = run_conversion(
                app_handle,
                window,
                state,
                &[InputSpec::plain(temp_png.to_string_lossy().to_string())],
                &input.to_string_lossy(),
                final_output.clone(),
                &[],
            )
            .await;
            let _ = std::fs::remove_file(&temp_png);
            transcode
        }
    }
    .await;

    // Windows' own HEIC decoder needs the HEVC Video Extensions codec package installed (separate
    // from HEIF Image Extensions, which just handles the container/metadata) - plenty of machines
    // only have the latter. Rather than fail outright when that codec is missing, fall back to a
    // bundled libheif build (services/heif_tool.rs) instead of the app's own ffmpeg - ffmpeg's
    // HEIF tile-grid reconstruction badly under-reconstructs the tiled grid modern iPhone photos
    // are stored as (a small, blown-up fragment of the real photo, not just lower resolution -
    // confirmed against real user photos), where libheif is the reference implementation and gets
    // it right.
    let result = match native_result {
        Ok(path) => Ok(path),
        Err(native_err) => {
            log::warn!("HEIC native decode failed for {}: {native_err}; falling back to bundled libheif", input.display());
            let fallback: Result<String, String> = async {
                if format == "png" {
                    crate::services::heif_tool::decode_to_png(app_handle.clone(), input.clone(), final_output.clone()).await?;
                    Ok(final_output.to_string_lossy().to_string())
                } else {
                    let temp_png = final_output.with_extension("heic_tmp.png");
                    crate::services::heif_tool::decode_to_png(app_handle.clone(), input.clone(), temp_png.clone()).await?;
                    let transcode = run_conversion(
                        app_handle,
                        window,
                        state,
                        &[InputSpec::plain(temp_png.to_string_lossy().to_string())],
                        &input.to_string_lossy(),
                        final_output.clone(),
                        &[],
                    )
                    .await;
                    let _ = std::fs::remove_file(&temp_png);
                    transcode
                }
            }
            .await;
            if let Err(heif_err) = &fallback {
                log::error!("HEIC libheif fallback also failed for {}: {heif_err}", input.display());
            }
            fallback.map_err(|heif_err| format!("{native_err}; fallback conversion also failed: {heif_err}"))
        }
    };

    match &result {
        Ok(path) => {
            let _ = window.emit("conversion-progress", ConversionProgress {
                input_path: input.to_string_lossy().to_string(),
                output_path: path.clone(),
                progress: 100.0,
                status: ConversionStatus::Completed,
                message: "Conversion completed".to_string(),
            });
            if !preserve_original {
                let _ = std::fs::remove_file(input);
            }
        }
        Err(err) => {
            let _ = window.emit("conversion-progress", ConversionProgress {
                input_path: input.to_string_lossy().to_string(),
                output_path: String::new(),
                progress: 0.0,
                status: ConversionStatus::Failed,
                message: err.clone(),
            });
        }
    }

    result
}

// Silent, cached HEIC/HEIF -> PNG preview for on-screen display only, at full resolution - the
// single-image viewer's counterpart to get_playable_preview above but for photos instead of
// video (get_image_thumbnail below is the gallery-grid counterpart - deliberately a *different*
// command, since a grid tile only ever needs a few hundred pixels and paying this function's full
// decode cost per thumbnail was exactly what made opening a large HEIC folder painfully slow).
// WebView2 has no HEIC decoder at all, so a plain <img src> just fails to load one. Unlike
// convert_image/convert_heic_windows (an explicit, user-triggered "Convert" that writes a
// permanent sibling file into the library), this never touches the source file and never adds
// anything to the library - it only ever writes into the same content-addressed temp cache
// get_playable_preview uses, so viewing the same photo again is instant and nothing shows up next
// to the original in the file list. Frontend calls this once per HEIC/HEIF file (see
// Dashboard.tsx's resolveImageDisplayUrl) and feeds the returned path through the same
// convert_file_path_to_url + convertFileSrc round-trip every other preview already uses.
#[tauri::command]
pub async fn get_heic_preview(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let cache_path = preview_cache_path(&input, "heic_v2", "png")?;

    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create preview cache directory: {}", e))?;
    }

    #[cfg(windows)]
    {
        let _ = (&window, &state); // only used by the non-Windows branch below
        if let Err(native_err) = crate::services::heic_windows::decode_to_png(input.clone(), cache_path.clone()).await {
            // Windows' own HEIC decoder needs the HEVC Video Extensions codec package installed
            // (separate from HEIF Image Extensions) - plenty of machines only have the latter. Same
            // bundled-libheif fallback as convert_heic_windows above; see its comment for why that
            // replaced an ffmpeg fallback here.
            log::warn!("HEIC native decode failed for {}: {native_err}; falling back to bundled libheif", input.display());
            if let Err(heif_err) = crate::services::heif_tool::decode_to_png(app_handle.clone(), input.clone(), cache_path.clone()).await {
                log::error!("HEIC libheif fallback also failed for {}: {heif_err}", input.display());
                return Err(format!("{native_err}; fallback conversion also failed: {heif_err}"));
            }
        }
        path_to_str(&cache_path).map(|s| s.to_string())
    }

    #[cfg(not(windows))]
    {
        run_conversion(&app_handle, &window, &state, &[InputSpec::plain(input_path.clone())], &input_path, cache_path, &[]).await
    }
}

// Long edge, in pixels, of a gallery-grid thumbnail - generous headroom over the CSS tile size
// (ImageFolderGallery.tsx renders these well under 300px) for high-DPI displays, while staying
// small enough that decoding one in the browser is cheap and 100+ of them fit comfortably in the
// renderer's image cache at once (the full-resolution originals didn't - see get_image_thumbnail
// below).
const GALLERY_THUMBNAIL_MAX_DIMENSION: u32 = 480;

// Silent, cached, small preview for an image gallery grid tile - counterpart to get_heic_preview
// above, but deliberately NOT that function at a smaller size: ImageFolderGallery.tsx used to
// point every grid tile straight at the full-resolution decode (get_heic_preview, or the plain
// original file for non-HEIC), which is correct for a single enlarged view but wrong for a grid
// of 100+ tiles - each one is a multi-megapixel decoded bitmap the browser's image cache can't
// hold all of at once, so scrolling away and back forced a re-decode of whatever got evicted
// (observed directly: images visibly "reloading" on scroll-up, and the initial load being far
// slower than it needed to be). This produces something actually sized for a thumbnail instead.
//
// HEIC/HEIF goes through the bundled heif-thumbnailer (services/heif_tool.rs) - it renders the
// small embedded preview HEIC containers already carry (or a fast downscale of the primary image
// if there isn't one) rather than doing heif-dec's full tile-grid reconstruction, which measured
// roughly 20x faster per photo in practice. Every other format is decoded and downscaled directly
// via the `image` crate, in-process - no bundled binary needed for those, and cheaper than
// shelling out to ffmpeg for something this small.
#[tauri::command]
pub async fn get_image_thumbnail(app_handle: AppHandle, input_path: String) -> Result<String, String> {
    // Unconditional entry log (cache hit or miss) - the only line in this command that always
    // fires. Every other line here only logs on error, so a request that hangs (concurrencyLimiter
    // ts's withLimit racing it against a timeout instead of waiting forever - see that file's own
    // comment) previously left zero trace of ever having reached Rust at all: nothing in this log
    // to say whether the hang was in here or below the IPC layer entirely. This one line answers
    // that immediately next time - if it's missing for a stuck request, look at the frontend/IPC
    // side instead of in here.
    log::debug!("get_image_thumbnail: {}", input_path);
    let input = PathBuf::from(&input_path);
    let cache_path = preview_cache_path(&input, "thumb_v1", "jpg")?;

    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    }

    let ext = input.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase());
    #[cfg(windows)]
    if matches!(ext.as_deref(), Some("heic") | Some("heif")) {
        if let Err(err) = crate::services::heif_tool::extract_thumbnail(app_handle, input.clone(), cache_path.clone(), GALLERY_THUMBNAIL_MAX_DIMENSION).await {
            log::error!("HEIC thumbnail failed for {}: {err}", input.display());
            return Err(err);
        }
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    #[cfg(not(windows))]
    let _ = &ext; // HEIC thumbnails aren't specially handled outside Windows yet (see heif_tool.rs)

    let input_for_blocking = input.clone();
    let cache_for_blocking = cache_path.clone();
    tauri::async_runtime::spawn_blocking(move || generate_plain_thumbnail(&input_for_blocking, &cache_for_blocking))
        .await
        .map_err(|e| format!("Thumbnail task panicked: {e}"))?
        .map_err(|err| {
            log::error!("Image thumbnail failed for {}: {err}", input.display());
            err
        })?;

    path_to_str(&cache_path).map(|s| s.to_string())
}

fn generate_plain_thumbnail(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    let img = image::open(input).map_err(|e| format!("Failed to open image: {e}"))?;
    img.thumbnail(GALLERY_THUMBNAIL_MAX_DIMENSION, GALLERY_THUMBNAIL_MAX_DIMENSION)
        .save(output)
        .map_err(|e| format!("Failed to save thumbnail: {e}"))
}

// Silent, cached poster-frame thumbnail for a video gallery grid tile - the video counterpart to
// get_image_thumbnail above. Extracts a single downscaled frame via the bundled ffmpeg, 1 second
// in rather than frame 0 (a screen recording's very first frame is very often solid black/blank
// before anything's actually happened on screen) - with a fallback to frame 0 if that seek fails,
// which happens for clips shorter than a second. Cached the same way every other gallery
// thumbnail is (content-addressed by path+mtime - see preview_cache_path), so revisiting a video
// folder is instant after the first pass.
#[tauri::command]
pub async fn get_video_thumbnail(app_handle: AppHandle, input_path: String) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let cache_path = preview_cache_path(&input, "video_thumb_v1", "jpg")?;

    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    }

    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    if let Err(err) = extract_video_frame(&ffmpeg_path, &input, &cache_path, "00:00:01").await {
        log::warn!("Video thumbnail seek to 1s failed for {}: {err}; retrying at frame 0", input.display());
        if let Err(err2) = extract_video_frame(&ffmpeg_path, &input, &cache_path, "00:00:00").await {
            let combined = format!("{err}; retry at frame 0 also failed: {err2}");
            log::error!("Video thumbnail failed for {}: {combined}", input.display());
            return Err(combined);
        }
    }

    path_to_str(&cache_path).map(|s| s.to_string())
}

// -ss before -i is ffmpeg's fast (keyframe-seeking, not frame-accurate) seek - plenty precise for
// a thumbnail and far quicker than decoding from the start, which matters here since this runs
// once per video in a folder that can hold hundreds of them (bounded by the same shared
// thumbnailLimiter the frontend routes every gallery/sidebar thumbnail request through).
async fn extract_video_frame(ffmpeg_path: &PathBuf, input: &PathBuf, output: &PathBuf, seek: &str) -> Result<(), String> {
    let ffmpeg_path = ffmpeg_path.clone();
    let input = input.clone();
    let output = output.clone();
    let seek = seek.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.args(["-y", "-ss", &seek]);
        cmd.arg("-i").arg(path_to_str(&input)?);
        cmd.args(["-frames:v", "1", "-update", "1", "-vf", "scale=480:-1", "-q:v", "4"]);
        cmd.arg(path_to_str(&output)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let result = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            // ffmpeg's stderr always opens with its full version/build-config banner before
            // anything about THIS run - keeping only the last few non-empty lines is what
            // actually explains the failure (e.g. "Invalid data found when processing input"),
            // instead of a wall of --enable-* flags every single error gets buried under.
            let tail: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).rev().take(3).collect();
            let reason: String = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
            return Err(format!("ffmpeg frame extraction failed: {}", if reason.is_empty() { "unknown error".to_string() } else { reason }));
        }
        if !output.exists() {
            return Err("ffmpeg exited successfully but produced no output file".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Video thumbnail task panicked: {e}"))?
}

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

    let result = run_conversion(&app_handle, &window, &state, &[InputSpec::plain(input_path.clone())], &input_path, output, &codec_args).await?;

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

// A per-segment Ken Burns zoom/pan - see ken_burns_chain. `intensity` is optional (None means
// "moderate", matching ClipKenBurns.intensity's own undefined-means-0.5 convention in
// videoEditTypes.ts) since the frontend only sends it once a user has actually touched the
// slider away from its default.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipKenBurns {
    pub preset: String,
    pub intensity: Option<f64>,
    // Where "zoom-in"/"zoom-out" center their crop window - fraction of the source frame, None
    // means the frame's own center (0.5, 0.5). Ignored by "pan-left"/"pan-right". See
    // ClipKenBurns's own doc comment (videoEditTypes.ts) for why this exists (centering an
    // auto-zoom punch-in on a recorded click position instead of the frame's middle).
    pub target_x: Option<f64>,
    pub target_y: Option<f64>,
}

// A free-form crop window into this segment's own frame - see crop_chain. NOT locked to the
// source frame's own aspect ratio (independent width/height), matching ClipCrop's own doc comment
// in videoEditTypes.ts: since the cropped region's own aspect generally won't match the export's
// fixed output resolution, crop_chain's trailing `scale=out_w:out_h` stretches it to fill rather
// than letterboxing/padding.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// A crossfade transition INTO this segment from whichever segment immediately precedes it -
// see the has_transitions fold in export_trimmed_video. Meaningless on segments[0] (nothing
// precedes it) - never read for that index.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipTransitionIn {
    #[serde(rename = "type")]
    pub transition_type: String, // "crossfade" - only variant in v1
    pub duration: f64,           // seconds
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepSegment {
    pub source_path: String,
    pub start: f64,
    pub end: f64,
    pub color_filter: Option<ClipColorFilter>,
    pub ken_burns: Option<ClipKenBurns>,
    pub transition_in: Option<ClipTransitionIn>,
    pub crop: Option<ClipCrop>,
    // Horizontal mirror, applied first (before crop/Ken Burns) so crop/pan coordinates always
    // describe the already-mirrored frame the same way the live preview's own CSS transform order
    // does (VideoPlayer.tsx). None/false means the pre-existing unmirrored look.
    pub flip_horizontal: Option<bool>,
    // Playback-rate multiplier for just this segment - None/1 means unchanged. See Clip.speed's
    // own doc comment (videoEditTypes.ts) for the full "this changes the segment's own OUTPUT
    // duration" story; segment_speed() below is what actually clamps/defaults this.
    pub speed: Option<f64>,
    // Background-noise reduction strength, 0..1 - None/0 means off. See Clip.noiseReduction's own
    // doc comment (videoEditTypes.ts) for why this has no live-preview equivalent; segment_noise_
    // reduction_db() below is what actually clamps/maps this to afftdn's own `nr` dB parameter.
    pub noise_reduction: Option<f64>,
}

// One text or image overlay, already fully rendered client-side to a transparent PNG matching
// what the live preview shows (font/stroke/background/corner-radius for text; rotation/corner-
// radius/border/shadow for images - see videoOverlayRender.ts) - this command only knows about a
// flat image plus where/when to composite it, never about TextOverlay/ImageOverlay's own richer
// shape. `x`/`y` are already resolved to real output-video pixels by the frontend (it knows the
// loaded video's native width/height from the same hidden <video> element the timeline's filmstrip
// capture already uses), so no resolution lookup is needed on this side at all. `start_time`/
// `end_time` are seconds on the *output* (post-trim/concat) timeline, same space `segments` above
// occupies once trimmed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayImage {
    pub data_base64: String,
    pub x: i64,
    pub y: i64,
    pub start_time: f64,
    pub end_time: f64,
    // Mirrors OverlayAnimation (videoEditTypes.ts) minus "pop" - the frontend maps "pop" to "fade"
    // before sending (see exportEdited's own comment), since a true scale-up/overshoot animation
    // needs a time-varying overlay *size*, not just x/y or alpha, which is a bigger lift than the
    // x/y-expression approach overlay_position_expr below uses for slide-*. Sanitized against
    // ALLOWED_OVERLAY_ANIMATIONS the same way transition_type already is (sanitize_transition_name)
    // - interpolated directly into the filter_complex string, so this is a real security boundary.
    pub animation: String,
}

// A blurred region burned into the output video for its own [start_time,end_time) window - unlike
// OverlayImage, there's no *picture* content to pre-render: this only ever reads pixels that are
// already decoded into the filter graph's own current_label node (see export_trimmed_video's blur
// pass, built via ffmpeg's own split+crop+boxblur[+alphamerge]+overlay). `x`/`y`/`width`/`height`
// are already resolved to real output-video pixels by the frontend, same as OverlayImage's own
// x/y - for a plain rectangle these are the region itself; for anything mask-shaped they're the
// mask's own bounding box (see mask_data_base64's own doc comment).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayBlur {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub intensity: f64, // 0..1
    // A black/white mask PNG (frontend: renderBlurMaskToPng, only rendered when blurNeedsMask(o)
    // is true - ellipse, rounded corners, or rotated) - None for a plain axis-aligned rectangle,
    // which needs no mask at all since ffmpeg's own `crop` already produces exactly that shape.
    // When present, written to a temp file the same way OverlayImage's own data_base64 already is
    // (see write_temp_overlay_png) and applied via `alphamerge` instead of a bare crop+boxblur+overlay.
    pub mask_data_base64: Option<String>,
    pub start_time: f64,
    pub end_time: f64,
}

// A background music/voiceover track to mix into the output's own audio - unlike OverlayImage,
// there's no client-side rendering step for this at all: the frontend never touches the source
// audio, it just names it (source_path) and passes the same trim/volume/fade parameters the
// AudioOverlay/AudioOverlayPopover editing UI already tracks (see videoEditTypes.ts's AudioOverlay
// and VideoTimelineDocker.tsx). trim_start/start_time/end_time are already resolved by the
// frontend (start_time/end_time are output-timeline seconds, same space `segments` occupies;
// trim_start is seconds into this track's own source file) - this command only builds the ffmpeg
// filter chain from them, same "just compositing, no richer shape known here" split OverlayImage
// already draws.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayAudio {
    pub source_path: String,
    pub start_time: f64,
    pub end_time: f64,
    pub trim_start: f64,
    pub volume: f64,
    pub fade_in: f64,
    pub fade_out: f64,
}

// A picture-in-picture video layer - e.g. a webcam recorded separately from the screen (see
// FormData.separate_webcam_capture, recording.rs) and composited back on top of the primary clip
// track here instead of being permanently baked in. Unlike OverlayImage, there's real per-frame
// video content to read (not a single pre-rendered PNG), so this gets its own `-i` input (the
// FULL source file - trim_start/start_time/end_time below scope which window of it is actually
// used, the same trim-then-composite shape `segments` itself uses) rather than joining the image/
// blur temp-file pipeline. `x`/`y`/`width`/`height` are already resolved to real output-video
// pixels by the frontend, same as OverlayImage's own x/y.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipOverlay {
    pub source_path: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub shape: String, // "circle" | "rounded" | "rectangle" - sanitized via sanitize_pip_shape
    pub corner_radius: Option<f64>, // fraction of `height`, "rounded" only
    pub trim_start: f64,
    pub start_time: f64,
    pub end_time: f64,
    // 0.0 when the frontend's own "play this clip's own audio" toggle is off (see
    // PipOverlay.muted, videoEditTypes.ts) - collapsed to a single number the same way
    // effective_video_volume already folds audio_muted into the primary track's own volume,
    // rather than carrying a separate bool here too.
    pub volume: f64,
}

const ALLOWED_PIP_SHAPES: &[&str] = &["circle", "rounded", "rectangle"];

fn sanitize_pip_shape(shape: &str) -> &str {
    ALLOWED_PIP_SHAPES.iter().find(|&&s| s == shape).copied().unwrap_or("rectangle")
}

// One PiP overlay's filter-graph fragment: trims this overlay's own [trim_start, trim_start+
// duration) window out of its (already `-i`'d, full-length) source, scales it to fill exactly
// `width`x`height` - `force_original_aspect_ratio=increase` then `crop` is the standard ffmpeg
// "cover" recipe, matching the live preview's own CSS `object-fit: cover` exactly rather than
// stretching or letterboxing - then masks it into shape and composites it onto `current_label`.
// Circle/rounded reuse the same geq-based geometric-mask technique recording.rs's own
// build_camera_overlay_filter_complex already uses for the baked-in overlay this feature is the
// editable alternative to (kept as a separate copy here rather than a shared function - the two
// commands build genuinely different surrounding graphs, and geq expressions are short enough that
// sharing would cost more in indirection than it'd save).
fn pip_overlay_chain(pip: &PipOverlay, input_index: usize, stage_index: usize, current_label: &str, out_label: &str) -> String {
    let duration = (pip.end_time - pip.start_time).max(0.01);
    let trim_end = pip.trim_start + duration;
    let cover = format!(
        "trim=start={ts:.3}:end={te:.3},setpts=PTS-STARTPTS,scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}",
        ts = pip.trim_start, te = trim_end, w = pip.width, h = pip.height
    );
    let shape = sanitize_pip_shape(&pip.shape);
    let video_label = format!("pip{}v", stage_index);

    let mut chain = String::new();
    let composited_label = match shape {
        "rectangle" => {
            chain.push_str(&format!("[{}:v]{}[{}];", input_index, cover, video_label));
            video_label
        }
        _ => {
            let mask_expr = if shape == "rounded" {
                let r = ((pip.corner_radius.unwrap_or(0.08).max(0.0).min(0.5)) * pip.height as f64).round() as i64;
                format!("if(gte(X,{r})*gte(Y,{r})*gte(W-{r}-X,0)*gte(H-{r}-Y,0),255,0)", r = r)
            } else {
                "if(gt((X-W/2)^2+(Y-H/2)^2,(W/2)^2),0,255)".to_string()
            };
            let alpha_label = format!("pip{}a", stage_index);
            let masked_label = format!("pip{}m", stage_index);
            // Reads the raw `-i`'d input twice (once per branch below) rather than an explicit
            // `split` - ffmpeg fans out a raw demuxed/decoded input stream reference on its own,
            // the same "{input}...{input}..." idiom overlay_stage_filter (recording.rs) already
            // relies on for exactly this shape-masking technique.
            chain.push_str(&format!("[{idx}:v]{cover},geq=lum_expr='{mask_expr}',format=yuva420p[{alpha}];", idx = input_index, cover = cover, mask_expr = mask_expr, alpha = alpha_label));
            chain.push_str(&format!("[{idx}:v]{cover}[{video}];", idx = input_index, cover = cover, video = video_label));
            chain.push_str(&format!("[{video}][{alpha}]alphamerge[{masked}];", video = video_label, alpha = alpha_label, masked = masked_label));
            masked_label
        }
    };

    chain.push_str(&format!(
        "[{current}][{composited}]overlay=x={x}:y={y}:enable='between(t,{start:.3},{end:.3})'[{out}];",
        current = current_label, composited = composited_label, x = pip.x, y = pip.y, start = pip.start_time, end = pip.end_time, out = out_label
    ));
    chain
}

// Per-segment color grade fragment, chained directly onto that segment's own trim step (before
// concat). Formulas are deliberately simple/approximate (not colorimetrically "correct") - a
// quick preset gallery, not a grading tool - and are meant to visually match their CSS-preview
// counterpart (cssFilterForColorPreset, src/utils/videoColorFilters.ts); if one is retuned, retune
// the other so preview and export don't silently drift apart. Empty string (no-op) for
// "none"/unrecognized so callers can unconditionally append the result without an extra branch.
fn color_filter_chain(cf: &ClipColorFilter) -> String {
    let t = cf.intensity.max(0.0).min(1.0);
    match cf.preset.as_str() {
        "vibrant" => format!(",eq=saturation={:.3}:contrast={:.3}", 1.0 + 0.6 * t, 1.0 + 0.15 * t),
        "cinematic" => format!(
            ",eq=contrast={:.3}:saturation={:.3}:gamma={:.3},colorbalance=rs={:.3}:bs={:.3}:rm={:.3}:bm={:.3}",
            1.0 + 0.2 * t, 1.0 - 0.15 * t, 1.0 - 0.05 * t, -0.10 * t, 0.15 * t, -0.05 * t, 0.10 * t
        ),
        "bw" => format!(",eq=saturation={:.3}", 1.0 - t),
        "warm" => format!(",colorbalance=rs={:.3}:bs={:.3}:rm={:.3}:bm={:.3}", 0.20 * t, -0.20 * t, 0.15 * t, -0.15 * t),
        "cool" => format!(",colorbalance=rs={:.3}:bs={:.3}:rm={:.3}:bm={:.3}", -0.20 * t, 0.20 * t, -0.15 * t, 0.15 * t),
        "vignette" => format!(",vignette=angle=PI/{:.3}", (6.0 - 4.0 * t).max(2.2)),
        _ => String::new(),
    }
}

// Per-segment Ken Burns fragment - a time-varying `crop` (using ffmpeg's own `t`/`iw`/`ih`/`ow`/
// `oh` expression variables - the same "expression string, not a filter option" idiom the
// enable='between(t,...)' chains elsewhere in this file already rely on), then a fixed `scale=`
// back to the export's own output resolution. The trailing scale is required, not cosmetic:
// concat needs every segment at matching resolution, and a shrinking crop window alone would
// leave this segment's frames smaller than its neighbors'. Chosen over ffmpeg's `zoompan` filter
// deliberately - zoompan's own output-size handling is more version-sensitive across ffmpeg
// builds than crop's plain expression support, and this only needs to spike-test cleanly once.
fn ken_burns_chain(kb: &ClipKenBurns, duration: f64, out_w: i64, out_h: i64) -> String {
    let amount = kb.intensity.unwrap_or(0.5).max(0.0).min(1.0);
    let d = duration.max(0.01);
    match kb.preset.as_str() {
        "zoom-in" | "zoom-out" => {
            let z = 1.0 + 0.30 * amount;
            let p = if kb.preset == "zoom-in" {
                format!("(1+({z:.4}-1)*min(t/{d:.3},1))")
            } else {
                format!("({z:.4}-({z:.4}-1)*min(t/{d:.3},1))")
            };
            // clip(...) rather than the plain "(iw-ow)/2" center every zoom used before targetX/
            // targetY existed - ow/oh are themselves time-varying here (they're `iw/p`/`ih/p`
            // above), so keeping the window fully on-frame at every instant needs a real clamp,
            // not just a fixed offset. Defaults (0.5, 0.5) reduce to exactly the old centered math.
            let tx = kb.target_x.unwrap_or(0.5).max(0.0).min(1.0);
            let ty = kb.target_y.unwrap_or(0.5).max(0.0).min(1.0);
            format!(
                ",crop=w='iw/{p}':h='ih/{p}':x='clip({tx:.4}*iw-ow/2,0,iw-ow)':y='clip({ty:.4}*ih-oh/2,0,ih-oh)',scale={out_w}:{out_h}"
            )
        }
        "pan-left" | "pan-right" => {
            let z = 1.0 + 0.15 * amount;
            let dir = if kb.preset == "pan-right" { format!("min(t/{d:.3},1)") } else { format!("1-min(t/{d:.3},1)") };
            format!(",crop=w='iw/{z:.4}':h='ih/{z:.4}':x='(iw-ow)*({dir})':y='(ih-oh)/2',scale={out_w}:{out_h}")
        }
        _ => String::new(),
    }
}

// Per-segment crop fragment - a static (non-time-varying) version of ken_burns_chain's own crop
// idiom, generalized to independent width/height: crop a free-form window out of the frame.
// Deliberately does NOT scale back to the export's own output resolution itself - unlike
// ken_burns_chain, whose own trailing `scale` is the only one that will ever run for that segment.
// segment_effect_chain below appends `scale=out_w:out_h` itself, but only when Ken Burns isn't ALSO
// set on the same segment: when it is, its own crop+scale runs immediately after this one and
// already ends in that exact scale, so adding a second one here would resample the frame twice for
// the same final pixels - wasted encode time and a marginally softer image from the extra
// resampling pass. Ken Burns' own crop math is proportional (iw/ih-relative) regardless of what
// this crop left iw/ih at, so skipping the scale here doesn't change what it produces. width/height
// are clamped away from 0 to avoid a degenerate near-zero-area crop, and x/y are clamped so the
// window can never crop past its own edge. The STRETCH (no force_original_aspect_ratio) that
// whichever trailing scale ends up running still applies - deliberate, see ClipCrop's own doc
// comment for why (letterboxing/padding was the alternative, not chosen).
fn crop_chain(c: &ClipCrop) -> String {
    let width = c.width.max(0.05).min(1.0);
    let height = c.height.max(0.05).min(1.0);
    let x = c.x.max(0.0).min(1.0 - width);
    let y = c.y.max(0.0).min(1.0 - height);
    format!(",crop=w='iw*{width:.4}':h='ih*{height:.4}':x='iw*{x:.4}':y='ih*{y:.4}'")
}

// One extra filter-string fragment for a segment's color grade + crop + Ken Burns, ready to
// append right after that segment's own `setpts=PTS-STARTPTS` in its trim step - the single call
// site both the single-segment and multi-segment branches below share, so the two branches can't
// drift apart on how a segment's effects get spliced in. Crop is applied before Ken Burns (not
// after) so Ken Burns' own zoom/pan animates within the already-cropped window, matching the live
// preview's own composition order (VideoPlayer.tsx). Whichever of crop/Ken Burns runs LAST is what
// actually rescales back to out_w:out_h - concat needs every segment at matching dimensions
// regardless of which effects it has, so at least one of them always has to; see crop_chain's own
// doc comment for why that's never both.
// This segment's own playback-speed multiplier, clamped defensively to the same 0.25..4 range the
// clip-effects UI itself offers (ClipEffectsPopover's MIN_SPEED/MAX_SPEED) - a value outside that
// couldn't have come from that slider, but clamping here (rather than trusting it) means a stale/
// hand-edited sidecar can't push the setpts/atempo math into something degenerate.
fn segment_speed(seg: &KeepSegment) -> f64 {
    seg.speed.unwrap_or(1.0).max(0.25).min(4.0)
}

// This segment's own noise-reduction strength (0..1, clamped defensively same as segment_speed's
// own comment explains) mapped to afftdn's `nr` parameter - its dB range is documented as
// 0.01..97, but anything past ~40dB starts eating into the wanted signal along with the noise for
// typical screen-recording mic input, so this maps onto the gentler 4..40 subrange rather than
// afftdn's full range. None/0 returns None (no filter at all) rather than "afftdn=nr=4" - keeps a
// clip that's never touched this feature byte-for-byte identical to before it existed, and skips
// an unnecessary filter stage in the common case.
fn segment_noise_reduction_db(seg: &KeepSegment) -> Option<f64> {
    let strength = seg.noise_reduction.unwrap_or(0.0).max(0.0).min(1.0);
    if strength <= 0.0 {
        None
    } else {
        Some(4.0 + strength * 36.0)
    }
}

// Decomposes an arbitrary speed factor into a chain of ffmpeg `atempo` filters, each within the
// single-instance range libavfilter enforces (0.5..2.0) - `atempo=4.0` alone is rejected outright
// at that value, so a larger speed-up/slow-down needs several chained instances instead (e.g. 4x
// is two atempo=2.0 stages back to back). segment_speed's own 0.25..4 clamp never actually needs
// more than two stages, but this loop isn't hardcoded to that in case that range ever widens.
fn atempo_chain(speed: f64) -> String {
    let mut remaining = speed.max(0.05);
    let mut stages: Vec<f64> = Vec::new();
    while remaining > 2.0 {
        stages.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        stages.push(0.5);
        remaining /= 0.5;
    }
    stages.push(remaining);
    stages.iter().map(|s| format!("atempo={:.4}", s)).collect::<Vec<_>>().join(",")
}

fn segment_effect_chain(seg: &KeepSegment, out_w: Option<i64>, out_h: Option<i64>) -> String {
    let mut extra = String::new();
    if seg.flip_horizontal.unwrap_or(false) {
        extra.push_str(",hflip");
    }
    if let Some(cf) = &seg.color_filter {
        if cf.preset != "none" {
            extra.push_str(&color_filter_chain(cf));
        }
    }
    if let (Some(crop), Some(w), Some(h)) = (&seg.crop, out_w, out_h) {
        extra.push_str(&crop_chain(crop));
        if seg.ken_burns.is_none() {
            extra.push_str(&format!(",scale={w}:{h}"));
        }
    }
    if let (Some(kb), Some(w), Some(h)) = (&seg.ken_burns, out_w, out_h) {
        // Divided by speed: Ken Burns' own crop expression reads `t` from the SAME filter chain
        // this is appended to, which by the time this runs has already had the segment's own
        // setpts=(PTS-STARTPTS)/speed applied (see the three trim-step call sites) - `t` there is
        // already OUTPUT time, not source time, so the progress fraction t/duration needs an
        // OUTPUT duration to reach exactly 1.0 at the segment's own end regardless of speed. The
        // live preview needs no equivalent adjustment - its own progress calc (VideoPlayer.tsx) is
        // a source-time ratio that's already speed-invariant by construction, see its own comment.
        extra.push_str(&ken_burns_chain(kb, (seg.end - seg.start) / segment_speed(seg), w, h));
    }
    extra
}

// Frame rate of a source file's first video stream, as a plain f64 (e.g. 30.0, 59.94) - only ever
// needed for the crossfade fold below, which requires every input at a matching constant frame
// rate before chaining more than one `xfade` in sequence (spike-tested: without this, ffmpeg
// rejects the second xfade in a chain with "needs to be a constant frame rate"). Defaults to 30.0
// on any probe failure (missing ffprobe, unparseable output, a 0/0 rate) rather than erroring the
// whole export over a cosmetic transition detail.
// Allowlist of ffmpeg `xfade` transition names this app exposes (mirrors TransitionType,
// videoEditTypes.ts, exactly - one flat vocabulary, no separate friendly-name mapping table).
// `transition_type` is interpolated directly into the filter_complex string below (see the
// has_transitions fold), so this is a real security boundary, not just UI validation - an
// unrecognized value (a hand-edited sidecar, a future frontend/backend version mismatch) falls
// back to "fade" rather than ever reaching the format! call unchecked.
const ALLOWED_TRANSITIONS: &[&str] = &["fade", "fadeblack", "wipeleft", "wiperight", "slideleft", "slideright", "circleopen", "zoomin", "pixelize", "radial", "dissolve"];

fn sanitize_transition_name(name: &str) -> &str {
    ALLOWED_TRANSITIONS.iter().find(|&&t| t == name).copied().unwrap_or("fade")
}

// Mirrors OverlayImage.animation's own doc comment - "pop" is deliberately absent (frontend maps
// it to "fade" before it ever reaches here). Same security-boundary reasoning as
// ALLOWED_TRANSITIONS: this string is interpolated directly into the filter_complex below.
const ALLOWED_OVERLAY_ANIMATIONS: &[&str] = &["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down"];

fn sanitize_overlay_animation(name: &str) -> &str {
    ALLOWED_OVERLAY_ANIMATIONS.iter().find(|&&a| a == name).copied().unwrap_or("none")
}

// Matches the live preview's own slide timing exactly (overlayAnimationStyle, VideoOverlayLayer.tsx)
// so a slide overlay looks the same in the exported file as it did on screen: `ramp` is how long the
// entry/exit glide takes (clamped to half the overlay's own duration so a very short overlay still
// finishes entering before it starts leaving), and `progress` is 0 right at either edge of
// [start_time,end_time), ramping to 1 once "fully arrived" - `remaining = 1-progress` is then how far
// from settled the overlay still is, which is what actually drives how far it's offset from its
// resting (ov.x, ov.y) position. ffmpeg's `clip(x,min,max)` and `min(a,b)` eval functions reproduce
// the same clamp/min the preview's own plain JS math uses.
const OVERLAY_ANIMATION_RAMP_SEC: f64 = 0.4;
const OVERLAY_SLIDE_DISTANCE_FRACTION: f64 = 0.12;

fn overlay_slide_remaining_expr(start_time: f64, end_time: f64) -> String {
    let ramp = OVERLAY_ANIMATION_RAMP_SEC.min((end_time - start_time) / 2.0).max(0.001);
    format!(
        "(1-clip(min((t-{start:.3})/{ramp:.4},({end:.3}-t)/{ramp:.4}),0,1))",
        start = start_time, end = end_time, ramp = ramp
    )
}

// The overlay filter's own x/y, as ffmpeg expression strings - a plain integer for "none"/"fade"
// (unchanged from before slide support existed), or a `main_w`/`main_h`-relative expression that
// glides in from the corresponding off-screen edge and back out for "slide-*", built with the exact
// same distance-from-resting-position idiom overlayAnimationStyle's own `remaining * distance` uses
// (VideoOverlayLayer.tsx) - `main_w`/`main_h` are the overlay filter's own built-in variables for the
// base video's pixel dimensions, evaluated per-frame, so no separate output-resolution lookup is
// needed here the way ken_burns_chain needs one.
fn overlay_position_expr(ov: &OverlayImage, animation: &str) -> (String, String) {
    match animation {
        "slide-left" => (
            format!("({x})-(main_w*{frac})*{remaining}", x = ov.x, frac = OVERLAY_SLIDE_DISTANCE_FRACTION, remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)),
            ov.y.to_string(),
        ),
        "slide-right" => (
            format!("({x})+(main_w*{frac})*{remaining}", x = ov.x, frac = OVERLAY_SLIDE_DISTANCE_FRACTION, remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)),
            ov.y.to_string(),
        ),
        "slide-up" => (
            ov.x.to_string(),
            format!("({y})-(main_h*{frac})*{remaining}", y = ov.y, frac = OVERLAY_SLIDE_DISTANCE_FRACTION, remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)),
        ),
        "slide-down" => (
            ov.x.to_string(),
            format!("({y})+(main_h*{frac})*{remaining}", y = ov.y, frac = OVERLAY_SLIDE_DISTANCE_FRACTION, remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)),
        ),
        _ => (ov.x.to_string(), ov.y.to_string()),
    }
}

fn probe_frame_rate(ffprobe_path: &PathBuf, source_path: &str) -> f64 {
    const FALLBACK_FPS: f64 = 30.0;
    let mut cmd = Command::new(ffprobe_path);
    cmd.args(["-v", "quiet", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", source_path]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return FALLBACK_FPS,
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    let parsed = match text.split_once('/') {
        Some((num, den)) => match (num.parse::<f64>(), den.parse::<f64>()) {
            (Ok(n), Ok(d)) if d > 0.0 => Some(n / d),
            _ => None,
        },
        None => text.parse::<f64>().ok(),
    };
    match parsed {
        Some(fps) if fps.is_finite() && fps > 0.0 => fps,
        _ => FALLBACK_FPS,
    }
}

// Whether `source_path` has at least one audio stream - screen recordings captured with no
// microphone/system audio are a real, common case (see the crop bug this was written for: cropping
// such a recording routes it into the filter-graph export path below, whose `[i:a]atrim=...`
// branches used to be unconditional and made ffmpeg reject the whole graph with "Stream specifier
// ':a' ... matches no streams" the moment a segment's source had no audio track at all). Defaults
// to true on any probe failure so an unreadable/unusual file keeps the previous "always assume
// audio" behavior rather than silently dropping a real track.
fn probe_has_audio(ffprobe_path: &PathBuf, source_path: &str) -> bool {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args(["-v", "quiet", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", source_path]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return true,
    };
    !String::from_utf8_lossy(&output.stdout).trim().is_empty()
}

// Native pixel size of `source_path`'s first video stream - the frontend normally already knows
// this (videoPixelSize, read off the same hidden capture <video> used for thumbnails) and passes it
// through as video_width/video_height, but that can still be None if Save is clicked before that
// metadata has loaded (a just-added clip, or an unusual codec). segment_effect_chain needs a
// concrete out_w/out_h to build the crop/Ken Burns filters at all, so without this fallback probe a
// segment with either effect set would take the (already forced, since has_clip_effects) filter-
// graph export path but have that one effect silently skipped - an uncropped/unpanned file, no
// error, no indication anything was dropped.
// Export quality presets - (libx264 preset, CRF) pairs. "standard" is the exact pair every export
// used unconditionally before this existed, so a caller that doesn't pass `quality` at all (or
// passes an unrecognized value) gets today's already-proven behavior, not a silent change.
// "high"'s slower preset spends more encode time finding smaller/cleaner bitrate allocations for
// the same visual quality; "small"'s faster preset trades some of that quality back for a shorter
// export - both directions users of a screen-recording tool routinely want (a quick draft to share
// immediately vs. a final archival-quality copy).
fn resolve_export_quality(quality: Option<&str>) -> (&'static str, &'static str) {
    match quality.unwrap_or("standard") {
        "high" => ("slow", "18"),
        "small" => ("veryfast", "28"),
        _ => ("medium", "23"),
    }
}

fn probe_video_dimensions(ffprobe_path: &PathBuf, source_path: &str) -> Option<(i64, i64)> {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args(["-v", "quiet", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", source_path]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let (w, h) = text.trim().split_once('x')?;
    match (w.parse::<i64>(), h.parse::<i64>()) {
        (Ok(w), Ok(h)) if w > 0 && h > 0 => Some((w, h)),
        _ => None,
    }
}

// One segment's audio branch of the filter graph, trimmed to [start,end) and labeled `out_label` -
// a real `atrim` off the segment's own input when it has audio, otherwise a synthesized silent
// track of the same duration (`anullsrc`, a filter *source*, needs no `-i` input of its own) so
// concat/xfade/acrossfade downstream always have a real audio stream to work with regardless of
// whether the source did.
fn audio_trim_chain(has_audio: bool, input_index: usize, start: f64, end: f64, speed: f64, noise_reduction_db: Option<f64>, out_label: &str) -> String {
    if has_audio {
        // atempo_chain (not a bare "atempo={speed}") since ffmpeg rejects a single atempo instance
        // outside 0.5..2.0 - see its own doc comment. A speed of 1 still resolves to exactly
        // "atempo=1.0000", functionally a no-op, so this needs no separate branch for that case.
        // afftdn runs AFTER atempo - it's a per-frame spectral filter, order relative to tempo
        // doesn't change its own output, so there's no reason to special-case which comes first.
        let denoise = match noise_reduction_db {
            Some(db) => format!(",afftdn=nr={:.2}", db),
            None => String::new(),
        };
        format!(
            "[{idx}:a]atrim=start={start:.3}:end={end:.3},asetpts=PTS-STARTPTS,{tempo}{denoise}[{out}];",
            idx = input_index, tempo = atempo_chain(speed), out = out_label
        )
    } else {
        // Divided by speed to match the video stream's own now-speed-adjusted duration (see the
        // trim/setpts call sites above) - concat/xfade both require the audio and video branches of
        // the same segment to agree on how long it lasts.
        format!(
            "anullsrc=channel_layout=stereo:sample_rate=44100:duration={dur:.3}[{out}];",
            dur = ((end - start) / speed).max(0.01), out = out_label
        )
    }
}

// Decodes one overlay's PNG payload and writes it to a fresh temp file - ffmpeg needs a real path
// for `-i`, not a data URL. `data_base64` may carry a "data:image/png;base64," prefix (what
// canvas.toDataURL() produces) or be the bare payload; splitting on the last comma handles both
// without the caller needing to know which.
fn write_temp_overlay_png(data_base64: &str, index: usize) -> Result<PathBuf, String> {
    let payload = data_base64.rsplit(',').next().unwrap_or(data_base64);
    let bytes = BASE64.decode(payload).map_err(|e| format!("Failed to decode overlay image: {}", e))?;
    let path = std::env::temp_dir().join(format!("briefcast_overlay_{}_{}.png", std::process::id(), index));
    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write overlay temp file: {}", e))?;
    Ok(path)
}

// Renders the edited (trimmed/split/reordered) video described by `segments` - an ordered list
// of the *kept* time ranges, each independently naming which source file it comes from, produced
// by VideoTimelineDocker's trim handles, split+delete tool, and drag-to-reorder/drag-in - to a
// brand-new file next to `output_base_path`, with any text/image overlays composited on top.
// Every source segments reference is opened read-only and never touched: unlike
// convert_to_mp4/convert_video/convert_audio above, there is no `preserve_original` parameter
// here at all, because there is no "false" branch to have.
//
// `output_base_path` only names/locates the DEFAULT output location (still used for the progress
// event's own progress_key regardless) - it's the file the timeline was opened on, which is not
// necessarily the source of any particular segment once clips have been dragged in from elsewhere
// (see DockerFile/DockerFile.path in VideoTimelineDocker.tsx). `output_path`, when set, overrides
// where the actual file gets written - see its own doc comment below.
//
// A single kept segment with no overlays (plain trim, no cuts, no drag-ins, nothing composited)
// uses fast, low-artifact `-ss`/`-to` range extraction on that one input and no filter graph at
// all. Anything else - multiple segments, multiple distinct source files, and/or any overlays -
// needs an actual filter graph: trim+concat can't be expressed as simple `-ss`/`-to` since ffmpeg
// only accepts one input range per input stream (each segment gets its own `-i` so segments can
// come from entirely different files), and compositing an overlay is a filter graph operation by
// definition.
#[tauri::command]
pub async fn export_trimmed_video(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    output_base_path: String,
    segments: Vec<KeepSegment>,
    overlays: Vec<OverlayImage>,
    blur_overlays: Vec<OverlayBlur>,
    audio_overlays: Vec<OverlayAudio>,
    // Always sent by the frontend (possibly empty), unlike video_width/quality/output_path below -
    // no #[serde(default)] here since a bare fn parameter can't carry one the way a struct field can.
    pip_overlays: Vec<PipOverlay>,
    audio_muted: bool,
    audio_volume: f64,
    // The primary file's native pixel resolution, already resolved by the frontend (same value
    // used for text/image overlay burn-in) - reused here as the Ken Burns crop's own trailing
    // `scale=` target rather than a fresh ffprobe lookup. None (e.g. an audio-only export path)
    // just means Ken Burns is silently skipped per-segment, same "skip gracefully" convention
    // exportEdited already uses for overlay rendering when videoPixelSize itself is null.
    video_width: Option<i64>,
    video_height: Option<i64>,
    // "standard" (unrecognized/omitted falls back to this too - see resolve_export_quality),
    // "high", or "small" - the encode speed/CRF trade-off the Save button's quality picker offers.
    quality: Option<String>,
    // Overrides the default "<output_base_path's name> (edited).<ext>" location - set when the
    // user picks a destination via the Save button's "Choose location…" option. Still runs through
    // unique_output_path (run_conversion) the same as the default location does, so a second export
    // to the exact same custom path doesn't clobber the first.
    output_path: Option<String>,
) -> Result<String, String> {
    if segments.is_empty() {
        return Err("No segments to export".to_string());
    }
    let (quality_preset, quality_crf) = resolve_export_quality(quality.as_deref());

    // The primary video's OWN audio level (distinct from any audio overlay's own volume/muted,
    // which are separate mixed-in tracks) - 0.0 when muted, otherwise whatever the editor's track
    // volume slider was set to.
    let effective_video_volume = if audio_muted { 0.0 } else { audio_volume.max(0.0) };

    let output = match output_path {
        Some(p) => PathBuf::from(p),
        None => {
            let base = PathBuf::from(&output_base_path);
            let stem = base.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let ext = base.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "mp4".to_string());
            let parent = base.parent().map(PathBuf::from).unwrap_or_default();
            parent.join(format!("{} (edited).{}", stem, ext))
        }
    };

    let mut inputs: Vec<InputSpec> = segments.iter().map(|s| InputSpec::plain(s.source_path.clone())).collect();

    // Written to temp files up front (ffmpeg needs real file paths, not data URLs) and cleaned up
    // unconditionally once the export attempt finishes below, success or failure.
    let total_duration: f64 = segments.iter().map(|s| s.end - s.start).sum();
    let mut temp_overlay_paths: Vec<PathBuf> = Vec::new();
    for (i, ov) in overlays.iter().enumerate() {
        // Deliberately not `?` here - that would return before the cleanup loop further down ever
        // runs, permanently leaking every overlay PNG already written earlier in this same loop
        // (e.g. overlay 0 succeeds, overlay 1 fails to decode - overlay 0's temp file would
        // otherwise sit in the temp dir forever, since its deterministic name never gets reused).
        let path = match write_temp_overlay_png(&ov.data_base64, i) {
            Ok(path) => path,
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        };
        temp_overlay_paths.push(path.clone());
        // -loop 1 turns the single PNG frame into a looped stream; -t caps it at the *whole*
        // output's duration rather than just this overlay's own [start,end) window - the overlay
        // filter's own enable='between(t,start,end)' below is what actually gates when it's
        // visible, so the input stream itself doesn't need to be time-shifted to line up.
        inputs.push(InputSpec {
            path: path.to_string_lossy().to_string(),
            pre_args: vec!["-loop".into(), "1".into(), "-t".into(), format!("{:.3}", total_duration.max(0.01))],
        });
    }

    // Blur masks (ellipse/rounded/rotated - see OverlayBlur.mask_data_base64's own doc comment)
    // get the same "-loop 1 -t total_duration" treatment as the image overlay PNGs above,
    // appended right after them - blur_mask_input_index remembers which ffmpeg input index (if
    // any) each blur_overlays[i] ended up with, so the filter-graph loop below doesn't need to
    // redo this bookkeeping. Filename indices start at overlays.len() (not 0) so they can never
    // collide with an image overlay PNG's own deterministic filename above.
    let mut blur_mask_input_index: Vec<Option<usize>> = Vec::with_capacity(blur_overlays.len());
    for (i, bv) in blur_overlays.iter().enumerate() {
        match &bv.mask_data_base64 {
            Some(data) => {
                let path = match write_temp_overlay_png(data, overlays.len() + i) {
                    Ok(path) => path,
                    Err(e) => {
                        for temp_path in &temp_overlay_paths {
                            let _ = std::fs::remove_file(temp_path);
                        }
                        return Err(e);
                    }
                };
                temp_overlay_paths.push(path.clone());
                let input_index = inputs.len();
                inputs.push(InputSpec {
                    path: path.to_string_lossy().to_string(),
                    pre_args: vec!["-loop".into(), "1".into(), "-t".into(), format!("{:.3}", total_duration.max(0.01))],
                });
                blur_mask_input_index.push(Some(input_index));
            }
            None => blur_mask_input_index.push(None),
        }
    }
    let blur_mask_count = blur_mask_input_index.iter().filter(|idx| idx.is_some()).count();

    // Audio overlays need no temp file and no -loop/-t pre_args at all, unlike the PNGs above -
    // there's no client-side rendering step for audio (see OverlayAudio's own doc comment), so
    // this just opens each track's original source file directly, atrim-ing into it in the filter
    // graph below rather than pre-shaping the input stream itself.
    for audio_ov in &audio_overlays {
        inputs.push(InputSpec::plain(audio_ov.source_path.clone()));
    }

    // PiP sources come last (after audio overlays) so audio_input_base's own formula further down
    // - segments.len() + overlays.len() + blur_mask_count - doesn't need to change to account for
    // them. Each gets the FULL source file as its own `-i` (no -loop/-t pre_args, unlike the image/
    // blur PNGs above) since pip_overlay_chain's own `trim=` does the windowing instead.
    let pip_input_base = inputs.len();
    for pip in &pip_overlays {
        inputs.push(InputSpec::plain(pip.source_path.clone()));
    }

    let has_video_overlays = !overlays.is_empty();
    let has_blur_overlays = !blur_overlays.is_empty();
    let has_audio_overlays = !audio_overlays.is_empty();
    let has_pip_overlays = !pip_overlays.is_empty();
    // Any clip-level effect also needs the full filter graph - the fast -ss/-to path below has no
    // filter graph at all, so a color grade/Ken Burns/transition would have nowhere to be applied.
    let has_clip_effects = segments.iter().any(|s| {
        s.color_filter.as_ref().map_or(false, |cf| cf.preset != "none") || s.ken_burns.is_some() || s.transition_in.is_some() || s.crop.is_some()
            || s.flip_horizontal.unwrap_or(false) || (s.speed.unwrap_or(1.0) - 1.0).abs() > 0.001
    });
    // Any segment beyond the first requesting a transition - gates the pairwise xfade/acrossfade
    // fold below instead of the plain all-at-once `concat=n=N` the multi-segment branch has always
    // used, so a timeline with no transitions set takes the exact same, already-proven path it did
    // before this feature existed.
    let has_transitions = segments.iter().skip(1).any(|s| s.transition_in.is_some());

    let owned_args: Vec<String> = if segments.len() == 1 && !has_video_overlays && !has_blur_overlays && !has_audio_overlays && !has_pip_overlays && !has_clip_effects {
        // Still the fast path even with a track volume/mute adjustment - that's a plain `-af`, no
        // filter graph needed just for it.
        let seg = &segments[0];
        let mut args = vec![
            "-ss".into(), format!("{:.3}", seg.start),
            "-to".into(), format!("{:.3}", seg.end),
            "-c:v".into(), "libx264".into(),
            "-preset".into(), quality_preset.into(),
            "-crf".into(), quality_crf.into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "128k".into(),
            "-movflags".into(), "+faststart".into(),
        ];
        if (effective_video_volume - 1.0).abs() > 0.001 {
            args.push("-af".into());
            args.push(format!("volume={:.3}", effective_video_volume));
        }
        args
    } else {
        let mut filter = String::new();
        // Probed once up front (not per-branch) since all three shapes below - single segment,
        // plain concat, transition fold - need it: see audio_trim_chain's own doc comment for why.
        let ffprobe_path = get_ffprobe_path(&app_handle)?;

        // One audio probe per UNIQUE source file, not one per segment - a timeline built by
        // splitting a single recording into several clips would otherwise spawn a redundant
        // ffprobe process per clip asking the exact same file the exact same question. Each probe
        // (and the dimensions probe just below) runs on the async runtime's blocking thread pool
        // via spawn_blocking rather than blocking whatever thread is running this command with a
        // synchronous Command::output() call - same reasoning as child.wait() further up. Spawned
        // before anything awaits, so they all actually run concurrently rather than one after
        // another.
        let unique_source_paths: Vec<String> = {
            let mut seen = std::collections::HashSet::new();
            segments.iter().map(|s| s.source_path.clone()).filter(|p| seen.insert(p.clone())).collect()
        };
        let audio_probe_handles: Vec<_> = unique_source_paths
            .iter()
            .map(|path| {
                let ffprobe_path = ffprobe_path.clone();
                let path = path.clone();
                tauri::async_runtime::spawn_blocking(move || (path.clone(), probe_has_audio(&ffprobe_path, &path)))
            })
            .collect();
        // Falls back to a real probe only when the frontend didn't already resolve this AND some
        // segment actually needs it (crop/Ken Burns) - see probe_video_dimensions' own doc comment.
        let dimensions_probe_handle = if (video_width.is_none() || video_height.is_none()) && has_clip_effects {
            let ffprobe_path = ffprobe_path.clone();
            let first_source = segments[0].source_path.clone();
            Some(tauri::async_runtime::spawn_blocking(move || probe_video_dimensions(&ffprobe_path, &first_source)))
        } else {
            None
        };

        let mut has_audio_by_path: HashMap<String, bool> = HashMap::new();
        for handle in audio_probe_handles {
            // A probe task can only fail here by panicking (probe_has_audio itself never returns
            // Err) - falls back to the same "assume audio" default probe_has_audio's own I/O
            // failure branch already uses.
            if let Ok((path, has_audio)) = handle.await {
                has_audio_by_path.insert(path, has_audio);
            }
        }
        let segment_has_audio: Vec<bool> = segments.iter().map(|s| *has_audio_by_path.get(&s.source_path).unwrap_or(&true)).collect();

        let (video_width, video_height): (Option<i64>, Option<i64>) = match dimensions_probe_handle {
            Some(handle) => match handle.await.ok().flatten() {
                Some((w, h)) => (Some(w), Some(h)),
                None => (video_width, video_height),
            },
            None => (video_width, video_height),
        };

        // Base video (trim, or trim+concat) always lands in a [base] node so the overlay chain
        // below has one consistent label to start from regardless of how many segments there were.
        if segments.len() == 1 {
            let seg = &segments[0];
            let extra = segment_effect_chain(seg, video_width, video_height);
            let speed = segment_speed(seg);
            filter.push_str(&format!(
                "[0:v]trim=start={0:.3}:end={1:.3},setpts=(PTS-STARTPTS)/{2:.4}{3}[base];",
                seg.start, seg.end, speed, extra
            ));
            filter.push_str(&audio_trim_chain(segment_has_audio[0], 0, seg.start, seg.end, speed, segment_noise_reduction_db(seg), "outa"));
        } else if !has_transitions {
            // Same segment-major trim+concat pattern as before this function grew overlay support
            // - concat's inputs must interleave [v0][a0][v1][a1]..., not group all video labels
            // before all audio ones, or ffmpeg rejects the whole filtergraph ("Media type
            // mismatch"). Untouched from before clip effects existed except for `extra` - a
            // timeline with no transitions takes this exact path regardless of color/Ken Burns.
            let mut concat_inputs = String::new();
            for (i, seg) in segments.iter().enumerate() {
                let extra = segment_effect_chain(seg, video_width, video_height);
                let speed = segment_speed(seg);
                filter.push_str(&format!(
                    "[{2}:v]trim=start={0:.3}:end={1:.3},setpts=(PTS-STARTPTS)/{4:.4}{3}[v{2}];",
                    seg.start, seg.end, i, extra, speed
                ));
                filter.push_str(&audio_trim_chain(segment_has_audio[i], i, seg.start, seg.end, speed, segment_noise_reduction_db(seg), &format!("a{}", i)));
                concat_inputs.push_str(&format!("[v{0}][a{0}]", i));
            }
            filter.push_str(&format!("{}concat=n={}:v=1:a=1[base][outa];", concat_inputs, segments.len()));
        } else {
            // At least one segment (beyond the first) has a crossfade transition - fold pairwise
            // left-to-right instead of one all-at-once concat, so each transitioned boundary can
            // use `xfade`/`acrossfade` in place of a plain 2-way concat at that one boundary only.
            //
            // xfade needs every input at a matching CONSTANT frame rate before it'll chain more
            // than one in sequence (spike-tested against this app's own bundled ffmpeg: omitting
            // this makes the *second* xfade in a chain fail with "needs to be a constant frame
            // rate, current rate of 1/0 is invalid", even though the first one alone works fine) -
            // so every segment gets an explicit `fps=` up front, using the first segment's own
            // source file's frame rate as the shared target (screen recordings from this app are
            // effectively always one consistent rate throughout a session either way).
            let target_fps = probe_frame_rate(&ffprobe_path, &segments[0].source_path);

            for (i, seg) in segments.iter().enumerate() {
                let extra = segment_effect_chain(seg, video_width, video_height);
                let speed = segment_speed(seg);
                filter.push_str(&format!(
                    "[{2}:v]trim=start={0:.3}:end={1:.3},setpts=(PTS-STARTPTS)/{5:.4}{3},fps={4:.3}[v{2}];",
                    seg.start, seg.end, i, extra, target_fps, speed
                ));
                filter.push_str(&audio_trim_chain(segment_has_audio[i], i, seg.start, seg.end, speed, segment_noise_reduction_db(seg), &format!("a{}", i)));
            }

            // Folds left-to-right: `accumulated` tracks the CURRENT duration of whatever
            // [cur_v]/[cur_a] point at right now, since xfade's own `offset` is relative to its
            // first input's timeline (not the original segment's own duration) once more than one
            // fold has already happened. Divided by speed - xfade/acrossfade operate on the
            // already-setpts'd (OUTPUT-time) streams built above, so every duration/offset here
            // needs to be in that same OUTPUT-time space, not raw source seconds.
            let mut cur_v = "v0".to_string();
            let mut cur_a = "a0".to_string();
            let mut accumulated = (segments[0].end - segments[0].start) / segment_speed(&segments[0]);
            for i in 1..segments.len() {
                let seg = &segments[i];
                let seg_dur = (seg.end - seg.start) / segment_speed(seg);
                let next_v = format!("fold{}v", i);
                let next_a = format!("fold{}a", i);
                let use_transition = seg.transition_in.as_ref().map_or(false, |tr| tr.duration > 0.0);
                if use_transition {
                    let tr = seg.transition_in.as_ref().unwrap();
                    let transition_name = sanitize_transition_name(&tr.transition_type);
                    // Clamped so the transition can never exceed 90% of either flanking segment's
                    // own duration - an unclamped duration could push `offset` negative (transition
                    // longer than everything accumulated so far) or overlap more of the next
                    // segment than actually exists.
                    let d = tr.duration.min(accumulated * 0.9).min(seg_dur * 0.9).max(0.05);
                    let offset = (accumulated - d).max(0.0);
                    // acrossfade has no equivalent "transition style" concept of its own (audio has
                    // no visual wipe/circle/pixelize shape to speak of) - every visual transition
                    // style shares the exact same linear audio crossfade underneath.
                    filter.push_str(&format!(
                        "[{cur_v}][v{i}]xfade=transition={transition_name}:duration={d:.3}:offset={offset:.3}[{next_v}];[{cur_a}][a{i}]acrossfade=d={d:.3}[{next_a}];"
                    ));
                    accumulated += seg_dur - d;
                } else {
                    filter.push_str(&format!("[{cur_v}][{cur_a}][v{i}][a{i}]concat=n=2:v=1:a=1[{next_v}][{next_a}];"));
                    accumulated += seg_dur;
                }
                cur_v = next_v;
                cur_a = next_a;
            }
            filter.push_str(&format!("[{cur_v}]copy[base];[{cur_a}]acopy[outa];"));
        }

        // Blur regions are chained onto [base] first, ahead of the text/image overlay loop below,
        // so blur always sits *underneath* text/image in the composite (matching the live preview,
        // where VideoOverlayLayer paints its blur boxes before its image/text ones - see that
        // file's own render-order comment). Each blur reads straight off whatever node it's
        // chained from (no separate `-i` input for the video itself - see OverlayBlur's own doc
        // comment): `split` duplicates that node, `crop` isolates the region on one copy, `boxblur`
        // blurs just that crop, and `overlay` composites the (possibly masked) blurred crop back
        // onto the *other*, unblurred copy at the same x/y - the standard ffmpeg technique for
        // "blur only part of a frame" (blurring the whole frame and overlaying a crop of the
        // ORIGINAL on top would do it backwards).
        let mut current_label = "base".to_string();
        for (i, bv) in blur_overlays.iter().enumerate() {
            // Scaled off the region's own height (not a fixed px count) so a small region doesn't
            // get an absurdly large radius relative to itself and vice versa; clamped both for
            // sane performance (boxblur's cost scales with radius) and so intensity:1 still reads
            // as "blurred", not "solid color", on a very tall region.
            let radius = ((bv.intensity.max(0.0).min(1.0)) * (bv.height as f64) * 0.08).round().clamp(1.0, 60.0) as i64;
            let src_label = format!("bb{}src", i);
            let bg_label = format!("bb{}bg", i);
            let out_label = format!("bb{}out", i);
            filter.push_str(&format!("[{}]split=2[{}][{}];", current_label, src_label, bg_label));

            // A plain axis-aligned rectangle (blur_mask_input_index[i] is None) needs nothing past
            // the bare crop+boxblur - ffmpeg's crop already produces exactly that shape. Anything
            // mask-shaped instead formats the blurred crop to rgba and merges in the mask PNG's own
            // luma as its alpha channel (`alphamerge`) before compositing, so only the masked-in
            // shape stays blurred and the rest of the crop shows through to bg's original pixels
            // once `overlay` blends by alpha below.
            let composited_label = match blur_mask_input_index[i] {
                None => {
                    let blurred_label = format!("bb{}blur", i);
                    filter.push_str(&format!(
                        "[{}]crop=w={}:h={}:x={}:y={},boxblur=luma_radius={}:luma_power=1:chroma_radius={}:chroma_power=1[{}];",
                        src_label, bv.width, bv.height, bv.x, bv.y, radius, radius, blurred_label
                    ));
                    blurred_label
                }
                Some(mask_input) => {
                    let cropped_label = format!("bb{}crop", i);
                    let mask_gray_label = format!("bb{}maskgray", i);
                    let masked_label = format!("bb{}masked", i);
                    filter.push_str(&format!(
                        "[{}]crop=w={}:h={}:x={}:y={},boxblur=luma_radius={}:luma_power=1:chroma_radius={}:chroma_power=1,format=rgba[{}];",
                        src_label, bv.width, bv.height, bv.x, bv.y, radius, radius, cropped_label
                    ));
                    filter.push_str(&format!("[{}:v]format=gray[{}];", mask_input, mask_gray_label));
                    filter.push_str(&format!("[{}][{}]alphamerge[{}];", cropped_label, mask_gray_label, masked_label));
                    masked_label
                }
            };

            filter.push_str(&format!(
                "[{}][{}]overlay=x={}:y={}:enable='between(t,{:.3},{:.3})'[{}];",
                bg_label, composited_label, bv.x, bv.y, bv.start_time, bv.end_time, out_label
            ));
            current_label = out_label;
        }

        // Chains each overlay onto whatever the blur pass above left [current_label] pointing at
        // (still "base" if there were no blur regions) in turn, the last one landing on [outv]. A
        // still PNG is "faded" via ffmpeg's own fade filter for animation:"fade" - alpha=1 fades the
        // alpha channel itself rather than to black, which is exactly what a transparent-background
        // overlay needs - or, for animation:"slide-*", composited at a time-varying x/y instead (see
        // overlay_position_expr) - before being composited via `overlay` gated to that overlay's own
        // [start,end) window on the output timeline either way.
        let overlay_input_base = segments.len();
        for (i, ov) in overlays.iter().enumerate() {
            let source_label = format!("{}:v", overlay_input_base + i);
            let animation = sanitize_overlay_animation(&ov.animation);
            let composited_label = if animation == "fade" {
                let faded_label = format!("ovfade{}", i);
                let fade_out_start = (ov.end_time - 0.4).max(ov.start_time);
                filter.push_str(&format!(
                    "[{}]fade=in:st={:.3}:d=0.4:alpha=1,fade=out:st={:.3}:d=0.4:alpha=1[{}];",
                    source_label, ov.start_time, fade_out_start, faded_label
                ));
                faded_label
            } else {
                source_label
            };
            let (x_expr, y_expr) = overlay_position_expr(ov, animation);
            let next_label = if i + 1 == overlays.len() { "outv".to_string() } else { format!("ov{}", i) };
            filter.push_str(&format!(
                "[{}][{}]overlay=x='{}':y='{}':enable='between(t,{:.3},{:.3})'[{}];",
                current_label, composited_label, x_expr, y_expr, ov.start_time, ov.end_time, next_label
            ));
            current_label = next_label;
        }

        // PiP layers composite last (on top of blur AND text/image, matching the live preview's
        // own DOM order - PipOverlayLayer is mounted after VideoOverlayLayer, see Dashboard.tsx) -
        // each stage always writes to its own "pipNout" intermediate label, never "outv" directly
        // (unlike the text/image loop just above, which can), since that loop may have already
        // claimed "outv" for itself and a second filter stage can't also output to the same label.
        // The shared fallback right below (`current_label != "outv"`) is what actually renames
        // whatever this leaves current_label pointing at.
        for (i, pip) in pip_overlays.iter().enumerate() {
            let out_label = format!("pip{}out", i);
            filter.push_str(&pip_overlay_chain(pip, pip_input_base + i, i, &current_label, &out_label));
            current_label = out_label;
        }

        // Whatever [current_label] is pointing at (the plain trim/concat [base], or the last blur/
        // image/text/pip stage that actually ran) needs to end up named [outv] for the -map below -
        // covers every combination of "any blur regions" x "any text/image overlays" x "any PiP
        // layers" with one check, rather than the single `!has_video_overlays` special case this
        // used to be before blur/pip support existed (back when [base] was the only possible
        // "nothing chained" label).
        if current_label != "outv" {
            filter.push_str(&format!("[{}]copy[outv];", current_label));
        }

        // Applies the track-level mute/volume to [outa] (the original video's own trimmed/
        // concatenated audio, built above) before anything else reads it - both the no-overlays
        // map below and the amix mixing block further down consume whichever label this produces.
        // Skipped entirely (base_audio_label just stays "outa") when the volume is untouched, so a
        // video nobody's adjusted this for doesn't grow an extra no-op filter node.
        let base_audio_label = if (effective_video_volume - 1.0).abs() > 0.001 {
            filter.push_str(&format!("[outa]volume={:.3}[outa_vol];", effective_video_volume));
            "outa_vol"
        } else {
            "outa"
        };

        // Which pip overlays actually contribute audio - the frontend already collapses its own
        // "play this clip's own audio" toggle into volume=0 when off (see PipOverlay.muted,
        // videoEditTypes.ts), so a plain volume>0 check covers that; probe_has_audio additionally
        // guards against a pip source with NO audio stream at all (e.g. the webcam sidecar
        // FormData.separate_webcam_capture itself produces, which is video-only by design - see
        // win.rs) - without this, a stray `[idx:a]` on a video-only input would reject the whole
        // filtergraph with "Stream specifier ':a' ... matches no streams", the same failure mode
        // probe_has_audio already exists to prevent for segments.
        let pip_audio_input_index: Vec<Option<usize>> = pip_overlays
            .iter()
            .enumerate()
            .map(|(i, p)| {
                if p.volume > 0.001 && probe_has_audio(&ffprobe_path, &p.source_path) {
                    Some(pip_input_base + i)
                } else {
                    None
                }
            })
            .collect();
        let has_pip_audio = pip_audio_input_index.iter().any(|idx| idx.is_some());

        // Mixes each audio overlay (and any audible pip layer) into base_audio_label - amix's
        // `normalize=0` is the detail that matters here: amix auto-attenuates every input by
        // 1/inputs by default, which would quietly turn the original video's own audio down just
        // because background music was added. normalize=0 keeps each track at whatever level its
        // own `volume=` filter below already set (the track volume above for the original track,
        // whatever the user picked for each overlay) - "30% volume" means 30%, not 30% further
        // divided by however many tracks happen to be mixed in.
        let audio_label = if has_audio_overlays || has_pip_audio {
            // Inputs so far, in push order: segments, then image overlay PNGs, then blur mask PNGs
            // (see blur_mask_input_index above) - audio overlay sources were appended right after
            // all of those, so this has to account for all three groups, not just the first two.
            let audio_input_base = segments.len() + overlays.len() + blur_mask_count;
            let mut mix_inputs = format!("[{}]", base_audio_label);
            for (i, audio_ov) in audio_overlays.iter().enumerate() {
                let input_index = audio_input_base + i;
                let trim_end = audio_ov.trim_start + (audio_ov.end_time - audio_ov.start_time);
                let mut chain = format!(
                    "[{}:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,volume={:.3}",
                    input_index, audio_ov.trim_start, trim_end, audio_ov.volume
                );
                if audio_ov.fade_in > 0.0 {
                    chain.push_str(&format!(",afade=t=in:st=0:d={:.3}", audio_ov.fade_in));
                }
                if audio_ov.fade_out > 0.0 {
                    let track_duration = audio_ov.end_time - audio_ov.start_time;
                    let fade_out_start = (track_duration - audio_ov.fade_out).max(0.0);
                    chain.push_str(&format!(",afade=t=out:st={:.3}:d={:.3}", fade_out_start, audio_ov.fade_out));
                }
                let delay_ms = (audio_ov.start_time * 1000.0).round().max(0.0);
                let track_label = format!("aov{}", i);
                filter.push_str(&format!("{},adelay={:.0}:all=1[{}];", chain, delay_ms, track_label));
                mix_inputs.push_str(&format!("[{}]", track_label));
            }
            // Same atrim+volume+adelay shape as the audio-overlay loop above, minus fade in/out
            // (pip has no fade controls of its own) - skips any pip pip_audio_input_index marked
            // None (muted, or a source with no audio stream at all).
            let mut pip_audio_count = 0;
            for (i, pip) in pip_overlays.iter().enumerate() {
                let Some(input_index) = pip_audio_input_index[i] else { continue };
                let trim_end = pip.trim_start + (pip.end_time - pip.start_time);
                let delay_ms = (pip.start_time * 1000.0).round().max(0.0);
                let track_label = format!("pipa{}", i);
                filter.push_str(&format!(
                    "[{idx}:a]atrim=start={ts:.3}:end={te:.3},asetpts=PTS-STARTPTS,volume={vol:.3},adelay={delay:.0}:all=1[{label}];",
                    idx = input_index, ts = pip.trim_start, te = trim_end, vol = pip.volume, delay = delay_ms, label = track_label
                ));
                mix_inputs.push_str(&format!("[{}]", track_label));
                pip_audio_count += 1;
            }
            filter.push_str(&format!(
                "{}amix=inputs={}:duration=first:dropout_transition=0:normalize=0[outa_mixed];",
                mix_inputs,
                audio_overlays.len() + pip_audio_count + 1
            ));
            "outa_mixed".to_string()
        } else {
            base_audio_label.to_string()
        };

        // Trailing `;` is harmless to ffmpeg either way, but trimmed for consistency with how the
        // original concat-only filter string here was always built without one.
        let filter = filter.trim_end_matches(';').to_string();

        vec![
            "-filter_complex".into(), filter,
            "-map".into(), "[outv]".into(),
            "-map".into(), format!("[{}]", audio_label),
            "-c:v".into(), "libx264".into(),
            "-preset".into(), quality_preset.into(),
            "-crf".into(), quality_crf.into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "128k".into(),
            "-movflags".into(), "+faststart".into(),
        ]
    };
    let codec_args: Vec<&str> = owned_args.iter().map(|s| s.as_str()).collect();

    let result = run_conversion(&app_handle, &window, &state, &inputs, &output_base_path, output, &codec_args).await;

    for temp_path in &temp_overlay_paths {
        let _ = std::fs::remove_file(temp_path);
    }

    result
}

// Cancel ongoing conversion
#[tauri::command]
pub async fn cancel_conversion(
    state: State<'_, ConversionState>
) -> Result<(), String> {
    let mut active_process = state.active_process.lock().await;
    
    if let Some(pid) = active_process.take() {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/F", "/PID", &pid.to_string()]);
            hide_console_window(&mut cmd);
            cmd.output()
                .map_err(|e| format!("Failed to cancel conversion: {}", e))?;
        }
        
        #[cfg(not(windows))]
        {
            Command::new("kill")
                .args(&["-9", &pid.to_string()])
                .output()
                .map_err(|e| format!("Failed to cancel conversion: {}", e))?;
        }
        
        Ok(())
    } else {
        Err("No active conversion to cancel".to_string())
    }
}

// Enhanced batch conversion
#[tauri::command]
pub async fn batch_convert_to_mp4(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_paths: Vec<String>,
    output_dir: Option<String>,
    preserve_original: bool,
) -> Result<Vec<String>, String> {
    let mut results = Vec::new();
    let total_files = input_paths.len();

    for (index, input_path) in input_paths.iter().enumerate() {
        let progress = (index as f64 / total_files as f64) * 100.0;
        
        // Emit batch progress
        let _ = window.emit("batch-conversion-progress", serde_json::json!({
            "current_file": input_path,
            "current_index": index,
            "total_files": total_files,
            "overall_progress": progress,
        }));

        // Determine output path for this file
        let output_path = match output_dir.as_ref() {
            Some(dir) => {
                let input_path_buf = PathBuf::from(input_path);
                let filename = match input_path_buf.file_stem() {
                    Some(stem) => stem.to_string_lossy().to_string(),
                    None => {
                        results.push(format!("FAILED: {} has no file name", input_path));
                        continue;
                    }
                };
                Some(
                    PathBuf::from(dir)
                        .join(format!("{}.mp4", filename))
                        .to_string_lossy()
                        .to_string(),
                )
            }
            None => None,
        };

        match convert_to_mp4(
            app_handle.clone(),
            window.clone(),
            state.clone(),
            input_path.clone(),
            output_path,
            preserve_original,
        ).await {
            Ok(output_path) => results.push(output_path),
            Err(e) => {
                log::warn!("Failed to convert {}: {}", input_path, e);
                results.push(format!("FAILED: {}", e));
            }
        }
    }

    Ok(results)
}

// Reads an arbitrary image file and returns it as a `data:` URL - used by the frontend's
// videoOverlayRender.ts to load an image overlay's source into a canvas (for rotation/corner-
// radius/border/shadow compositing before export burn-in) without tainting that canvas. Loading
// the same file via Tauri's asset:// protocol + <img> works fine for plain on-screen display, but
// the browser treats that protocol as cross-origin - drawing a cross-origin image onto a canvas
// taints it, and a tainted canvas throws on toDataURL() ("Tainted canvases may not be exported").
// A `data:` URL has no origin of its own, so it never triggers that. Going through a Rust command
// also sidesteps the frontend fs allowlist entirely (scoped to $VIDEO/Briefcast/**, which an
// externally-picked image needn't live under) - Rust's own filesystem access is unrestricted by
// that allowlist regardless of which folder the file is actually in.
#[tauri::command]
pub async fn read_image_data_url(path: String) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    let bytes = std::fs::read(&file_path).map_err(|e| format!("Failed to read image file: {}", e))?;
    let mime = match file_path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()) {
        Some(ext) if ext == "jpg" || ext == "jpeg" => "image/jpeg",
        Some(ext) if ext == "gif" => "image/gif",
        Some(ext) if ext == "webp" => "image/webp",
        Some(ext) if ext == "bmp" => "image/bmp",
        Some(ext) if ext == "svg" => "image/svg+xml",
        _ => "image/png",
    };
    Ok(format!("data:{};base64,{}", mime, BASE64.encode(&bytes)))
}

// Generic "read an arbitrary externally-picked file's raw bytes" - same rationale as
// read_image_data_url just above (sidesteps the frontend fs allowlist scope, unrestricted Rust-
// side fs access), but returning raw bytes rather than a base64 data URL since the caller (docx
// import, see src/utils/docxImport.ts) needs an ArrayBuffer to hand to a JS parsing library, not
// something to drop into an <img src>.
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))
}

// Get file information before conversion
#[tauri::command]
pub async fn get_conversion_info(
    app_handle: AppHandle,
    input_path: String,
) -> Result<HashMap<String, String>, String> {
    let ffprobe_path = get_ffprobe_path(&app_handle)?;
    let input = PathBuf::from(&input_path);

    if !input.exists() {
        return Err("Input file does not exist".to_string());
    }

    let mut cmd = Command::new(&ffprobe_path);
    cmd.args([
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        path_to_str(&input)?,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = cmd.output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    let mut info = HashMap::new();
    info.insert("input_path".to_string(), input_path);

    let file_size = input.metadata()
        .map(|m| m.len() / 1_000_000)
        .unwrap_or(0);
    info.insert("input_size".to_string(), format!("{} MB", file_size));

    info.insert("output_path".to_string(),
        input.with_extension("mp4").to_string_lossy().to_string()
    );

    if let Ok(probe) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
        if let Some(duration) = probe["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()) {
            info.insert("duration".to_string(), format!("{:.1}s", duration));
        }

        if let Some(streams) = probe["streams"].as_array() {
            if let Some(video) = streams.iter().find(|s| s["codec_type"] == "video") {
                if let Some(codec) = video["codec_name"].as_str() {
                    info.insert("video_codec".to_string(), codec.to_string());
                }
                if let (Some(w), Some(h)) = (video["width"].as_i64(), video["height"].as_i64()) {
                    info.insert("resolution".to_string(), format!("{}x{}", w, h));
                }
            }
            if let Some(audio) = streams.iter().find(|s| s["codec_type"] == "audio") {
                if let Some(codec) = audio["codec_name"].as_str() {
                    info.insert("audio_codec".to_string(), codec.to_string());
                }
            }
        }
    }

    Ok(info)
}

// Get available conversion formats
#[tauri::command]
pub fn get_supported_conversion_formats() -> Vec<HashMap<&'static str, &'static str>> {
    vec![
        HashMap::from([("value", "mp4"), ("label", "MP4 (Recommended)")]),
        HashMap::from([("value", "mov"), ("label", "MOV")]),
        HashMap::from([("value", "mkv"), ("label", "MKV")]),
        HashMap::from([("value", "avi"), ("label", "AVI")]),
        HashMap::from([("value", "webm"), ("label", "WebM")]),
    ]
}

// Check if file needs conversion
#[tauri::command]
pub fn should_convert_file(file_path: String) -> bool {
    let path = PathBuf::from(file_path);
    if let Some(ext) = path.extension() {
        let ext_str = ext.to_string_lossy().to_lowercase();
        matches!(ext_str.as_str(), "mkv" | "avi" | "mov" | "wmv" | "flv")
    } else {
        false
    }
}

// Generic conversion to any format
#[tauri::command]
pub async fn convert_video(
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
        "mp4" => vec![
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "23",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
        ],
        "mov" => vec![
            "-c:v", "libx264",
            "-preset", "medium",
            "-c:a", "aac",
            "-movflags", "+faststart",
        ],
        "mkv" => vec![
            "-c:v", "libx264",
            "-preset", "medium",
            "-c:a", "aac",
        ],
        "avi" => vec![
            "-c:v", "libx264",
            "-c:a", "mp3",
        ],
        "webm" => vec![
            "-c:v", "libvpx",
            "-c:a", "libvorbis",
        ],
        _ => return Err(format!("Unsupported output format: {}", output_format)),
    };

    let result = run_conversion(&app_handle, &window, &state, &[InputSpec::plain(input_path.clone())], &input_path, output, &codec_args).await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
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

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-i").arg(&input_path);
        cmd.args(["-af", &format!("silencedetect=noise={noise_db}dB:d={min_duration}"), "-f", "null", "-"]);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let output = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        // silencedetect writes to stderr regardless of the overall exit status (a `-f null -`
        // "encode" succeeds as long as the input decodes at all) - parsed either way, since the
        // only real failure mode here is ffmpeg being unable to read the file at all, which the
        // exists() check above already rules out for the common case.
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(parse_silence_ranges(&stderr))
    })
    .await
    .map_err(|e| format!("Silence detection task panicked: {}", e))?
}

// Parses ffmpeg silencedetect's own stderr log lines:
//   [silencedetect @ 0x...] silence_start: 12.345
//   [silencedetect @ 0x...] silence_end: 15.678 | silence_duration: 3.333
// into paired (start,end) ranges. A trailing silence_start with no matching silence_end (the file
// ends while still silent) is dropped rather than guessed at - callers only ever want ranges with
// a real, detected end.
fn parse_silence_ranges(stderr: &str) -> Vec<SilentRange> {
    let mut ranges = Vec::new();
    let mut pending_start: Option<f64> = None;
    for line in stderr.lines() {
        if let Some(rest) = line.split("silence_start:").nth(1) {
            if let Ok(start) = rest.trim().split_whitespace().next().unwrap_or("").parse::<f64>() {
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
#[cfg(test)]
mod tests {
    use super::*;

    // Bare-minimum KeepSegment with every optional field off - individual tests override just the
    // field(s) they care about via struct-update syntax (`..base_segment()`), so adding a new field
    // to KeepSegment later only means updating this one helper, not every test.
    fn base_segment() -> KeepSegment {
        KeepSegment {
            source_path: "clip.mp4".to_string(),
            start: 0.0,
            end: 10.0,
            color_filter: None,
            ken_burns: None,
            transition_in: None,
            crop: None,
            flip_horizontal: None,
            speed: None,
            noise_reduction: None,
        }
    }

    // ---- segment_speed / segment_noise_reduction_db --------------------------------------------

    #[test]
    fn segment_speed_defaults_to_1x_when_unset() {
        assert_eq!(segment_speed(&base_segment()), 1.0);
    }

    #[test]
    fn segment_speed_clamps_to_0_25_4_range() {
        let mut seg = base_segment();
        seg.speed = Some(100.0);
        assert_eq!(segment_speed(&seg), 4.0);
        seg.speed = Some(0.001);
        assert_eq!(segment_speed(&seg), 0.25);
        seg.speed = Some(1.5);
        assert_eq!(segment_speed(&seg), 1.5);
    }

    #[test]
    fn segment_noise_reduction_db_is_none_when_off() {
        let seg = base_segment();
        assert_eq!(segment_noise_reduction_db(&seg), None);

        let mut zero = base_segment();
        zero.noise_reduction = Some(0.0);
        assert_eq!(segment_noise_reduction_db(&zero), None);
    }

    #[test]
    fn segment_noise_reduction_db_maps_0_to_1_onto_4_to_40_db() {
        let mut seg = base_segment();
        seg.noise_reduction = Some(1.0);
        assert_eq!(segment_noise_reduction_db(&seg), Some(40.0));

        seg.noise_reduction = Some(0.5);
        assert_eq!(segment_noise_reduction_db(&seg), Some(22.0));

        // Clamped even if a stale/hand-edited sidecar carries an out-of-range value.
        seg.noise_reduction = Some(5.0);
        assert_eq!(segment_noise_reduction_db(&seg), Some(40.0));
        seg.noise_reduction = Some(-5.0);
        assert_eq!(segment_noise_reduction_db(&seg), None);
    }

    // ---- atempo_chain ---------------------------------------------------------------------------

    #[test]
    fn atempo_chain_1x_is_a_single_noop_stage() {
        assert_eq!(atempo_chain(1.0), "atempo=1.0000");
    }

    #[test]
    fn atempo_chain_within_single_instance_range_needs_no_chaining() {
        assert_eq!(atempo_chain(2.0), "atempo=2.0000");
        assert_eq!(atempo_chain(0.5), "atempo=0.5000");
        assert_eq!(atempo_chain(1.37), "atempo=1.3700");
    }

    #[test]
    fn atempo_chain_above_2x_splits_into_two_stages() {
        // 4.0 -> one atempo=2.0 stage, remaining 2.0 -> loop condition is `> 2.0` so exactly 2.0
        // stops there, leaving a second atempo=2.0000 stage for the remainder.
        assert_eq!(atempo_chain(4.0), "atempo=2.0000,atempo=2.0000");
    }

    #[test]
    fn atempo_chain_below_0_5x_splits_into_two_stages() {
        assert_eq!(atempo_chain(0.25), "atempo=0.5000,atempo=0.5000");
    }

    // ---- sanitizers - the security-boundary functions --------------------------------------------

    #[test]
    fn sanitize_transition_name_passes_through_allowed_values() {
        assert_eq!(sanitize_transition_name("wipeleft"), "wipeleft");
        assert_eq!(sanitize_transition_name("dissolve"), "dissolve");
    }

    #[test]
    fn sanitize_transition_name_falls_back_to_fade_for_anything_else() {
        assert_eq!(sanitize_transition_name("fade"), "fade");
        assert_eq!(sanitize_transition_name(""), "fade");
        assert_eq!(sanitize_transition_name("'; DROP TABLE clips; --"), "fade");
    }

    #[test]
    fn sanitize_overlay_animation_passes_through_allowed_values_only() {
        assert_eq!(sanitize_overlay_animation("slide-left"), "slide-left");
        assert_eq!(sanitize_overlay_animation("pop"), "none"); // "pop" is preview-only, never sent
        assert_eq!(sanitize_overlay_animation("anything-else"), "none");
    }

    #[test]
    fn sanitize_pip_shape_passes_through_allowed_values_only() {
        assert_eq!(sanitize_pip_shape("circle"), "circle");
        assert_eq!(sanitize_pip_shape("rounded"), "rounded");
        assert_eq!(sanitize_pip_shape("hexagon"), "rectangle");
    }

    // ---- color_filter_chain / ken_burns_chain / crop_chain ---------------------------------------

    #[test]
    fn color_filter_chain_none_preset_is_a_noop() {
        let cf = ClipColorFilter { preset: "none".to_string(), intensity: 0.7 };
        assert_eq!(color_filter_chain(&cf), "");
    }

    #[test]
    fn color_filter_chain_bw_at_full_intensity_fully_desaturates() {
        let cf = ClipColorFilter { preset: "bw".to_string(), intensity: 1.0 };
        assert_eq!(color_filter_chain(&cf), ",eq=saturation=0.000");
    }

    #[test]
    fn color_filter_chain_clamps_out_of_range_intensity() {
        let over = ClipColorFilter { preset: "bw".to_string(), intensity: 5.0 };
        let under = ClipColorFilter { preset: "bw".to_string(), intensity: -5.0 };
        assert_eq!(color_filter_chain(&over), ",eq=saturation=0.000"); // clamped to 1.0
        assert_eq!(color_filter_chain(&under), ",eq=saturation=1.000"); // clamped to 0.0
    }

    #[test]
    fn crop_chain_clamps_position_so_the_window_never_crosses_the_far_edge() {
        // x=0.9 with width=0.5 would crop past the right edge (0.9+0.5 > 1.0) - x must clamp to
        // 1.0-width=0.5, not the raw 0.9 the caller passed.
        let c = ClipCrop { x: 0.9, y: 0.0, width: 0.5, height: 0.5 };
        assert_eq!(crop_chain(&c), ",crop=w='iw*0.5000':h='ih*0.5000':x='iw*0.5000':y='ih*0.0000'");
    }

    #[test]
    fn crop_chain_rejects_a_degenerate_near_zero_area_crop() {
        let c = ClipCrop { x: 0.0, y: 0.0, width: 0.0, height: 0.0 };
        // width/height floor at 0.05, never truly 0.
        assert_eq!(crop_chain(&c), ",crop=w='iw*0.0500':h='ih*0.0500':x='iw*0.0000':y='ih*0.0000'");
    }

    #[test]
    fn ken_burns_chain_unrecognized_preset_is_a_noop() {
        let kb = ClipKenBurns { preset: "sparkle".to_string(), intensity: None, target_x: None, target_y: None };
        assert_eq!(ken_burns_chain(&kb, 5.0, 1920, 1080), "");
    }

    #[test]
    fn ken_burns_chain_zoom_in_ends_at_the_scaled_output_resolution() {
        let kb = ClipKenBurns { preset: "zoom-in".to_string(), intensity: Some(1.0), target_x: None, target_y: None };
        let chain = ken_burns_chain(&kb, 5.0, 1920, 1080);
        assert!(chain.starts_with(",crop="), "expected a crop expression, got: {chain}");
        assert!(chain.ends_with(",scale=1920:1080"), "expected a trailing scale to output resolution, got: {chain}");
    }

    // ---- segment_effect_chain - ordering matters (mirrored in VideoPlayer.tsx's own preview) -----

    #[test]
    fn segment_effect_chain_applies_hflip_before_color_before_crop() {
        let mut seg = base_segment();
        seg.flip_horizontal = Some(true);
        seg.color_filter = Some(ClipColorFilter { preset: "bw".to_string(), intensity: 1.0 });
        seg.crop = Some(ClipCrop { x: 0.0, y: 0.0, width: 1.0, height: 1.0 });
        let chain = segment_effect_chain(&seg, Some(1920), Some(1080));
        let hflip_pos = chain.find("hflip").expect("hflip missing");
        let color_pos = chain.find("eq=saturation").expect("color filter missing");
        let crop_pos = chain.find("crop=").expect("crop missing");
        assert!(hflip_pos < color_pos && color_pos < crop_pos, "wrong order: {chain}");
    }

    #[test]
    fn segment_effect_chain_skips_the_extra_scale_when_ken_burns_will_scale_anyway() {
        let mut seg = base_segment();
        seg.crop = Some(ClipCrop { x: 0.0, y: 0.0, width: 1.0, height: 1.0 });
        seg.ken_burns = Some(ClipKenBurns { preset: "zoom-in".to_string(), intensity: Some(0.5), target_x: None, target_y: None });
        let chain = segment_effect_chain(&seg, Some(1920), Some(1080));
        // Exactly one scale=1920:1080 (Ken Burns' own trailing one), not two.
        assert_eq!(chain.matches("scale=1920:1080").count(), 1);
    }

    #[test]
    fn segment_effect_chain_with_no_effects_is_empty() {
        assert_eq!(segment_effect_chain(&base_segment(), Some(1920), Some(1080)), "");
    }

    // ---- audio_trim_chain -----------------------------------------------------------------------

    #[test]
    fn audio_trim_chain_no_audio_synthesizes_silence_of_the_right_output_duration() {
        // 10 source seconds at 2x speed -> 5 output seconds.
        let chain = audio_trim_chain(false, 0, 0.0, 10.0, 2.0, None, "outa");
        assert_eq!(chain, "anullsrc=channel_layout=stereo:sample_rate=44100:duration=5.000[outa];");
    }

    #[test]
    fn audio_trim_chain_with_audio_includes_tempo_but_no_denoise_when_off() {
        let chain = audio_trim_chain(true, 0, 1.0, 5.0, 1.0, None, "outa");
        assert_eq!(chain, "[0:a]atrim=start=1.000:end=5.000,asetpts=PTS-STARTPTS,atempo=1.0000[outa];");
    }

    #[test]
    fn audio_trim_chain_appends_afftdn_after_atempo_when_noise_reduction_is_set() {
        let chain = audio_trim_chain(true, 2, 0.0, 5.0, 1.0, Some(22.0), "a2");
        assert_eq!(chain, "[2:a]atrim=start=0.000:end=5.000,asetpts=PTS-STARTPTS,atempo=1.0000,afftdn=nr=22.00[a2];");
    }

    // ---- overlay animation expressions ------------------------------------------------------------

    #[test]
    fn overlay_position_expr_none_and_fade_are_static_coordinates() {
        let ov = OverlayImage { data_base64: String::new(), x: 100, y: 200, start_time: 0.0, end_time: 5.0, animation: "none".to_string() };
        assert_eq!(overlay_position_expr(&ov, "none"), ("100".to_string(), "200".to_string()));
        assert_eq!(overlay_position_expr(&ov, "fade"), ("100".to_string(), "200".to_string()));
    }

    #[test]
    fn overlay_position_expr_slide_left_only_animates_x() {
        let ov = OverlayImage { data_base64: String::new(), x: 100, y: 200, start_time: 0.0, end_time: 5.0, animation: "slide-left".to_string() };
        let (x, y) = overlay_position_expr(&ov, "slide-left");
        assert_eq!(y, "200"); // y untouched
        assert!(x.contains("main_w"), "expected an x expression referencing main_w, got: {x}");
    }

    // ---- parse_duration / parse_silence_ranges - real ffmpeg stderr text shapes ------------------

    #[test]
    fn parse_duration_reads_the_standard_ffmpeg_banner_line() {
        let output = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':\n  Duration: 00:02:03.45, start: 0.000000, bitrate: 1234 kb/s\n";
        assert_eq!(parse_duration(output), Some(123.45));
    }

    #[test]
    fn parse_duration_returns_none_when_no_duration_line_present() {
        assert_eq!(parse_duration("some unrelated ffmpeg output\n"), None);
    }

    #[test]
    fn parse_silence_ranges_pairs_start_and_end_lines() {
        let stderr = "\
[silencedetect @ 0x1] silence_start: 12.345
[silencedetect @ 0x1] silence_end: 15.678 | silence_duration: 3.333
[silencedetect @ 0x1] silence_start: 20.0
[silencedetect @ 0x1] silence_end: 21.5 | silence_duration: 1.5
";
        let ranges = parse_silence_ranges(stderr);
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].start, 12.345);
        assert_eq!(ranges[0].end, 15.678);
        assert_eq!(ranges[1].start, 20.0);
        assert_eq!(ranges[1].end, 21.5);
    }

    #[test]
    fn parse_silence_ranges_drops_a_trailing_unmatched_silence_start() {
        // The file ends while still silent - no matching silence_end line at all.
        let stderr = "[silencedetect @ 0x1] silence_start: 12.345\n";
        assert_eq!(parse_silence_ranges(stderr).len(), 0);
    }

    // ---- resolve_export_quality / should_convert_file / unique_output_path ------------------------

    #[test]
    fn resolve_export_quality_unrecognized_and_missing_both_fall_back_to_standard() {
        assert_eq!(resolve_export_quality(None), ("medium", "23"));
        assert_eq!(resolve_export_quality(Some("ultra")), ("medium", "23"));
        assert_eq!(resolve_export_quality(Some("high")), ("slow", "18"));
        assert_eq!(resolve_export_quality(Some("small")), ("veryfast", "28"));
    }

    #[test]
    fn should_convert_file_flags_only_the_documented_extensions() {
        assert!(should_convert_file("clip.mkv".to_string()));
        assert!(should_convert_file("clip.MOV".to_string())); // case-insensitive
        assert!(!should_convert_file("clip.mp4".to_string()));
        assert!(!should_convert_file("no_extension".to_string()));
    }

    #[test]
    fn unique_output_path_appends_a_counter_when_the_target_already_exists() {
        let dir = std::env::temp_dir().join(format!("briefcast_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("out.mp4");
        std::fs::write(&target, b"existing").unwrap();

        let resolved = unique_output_path(target.clone());
        assert_eq!(resolved, dir.join("out (1).mp4"));

        // With "out (1).mp4" ALSO taken, the next free slot is "(2)".
        std::fs::write(&resolved, b"existing").unwrap();
        assert_eq!(unique_output_path(target.clone()), dir.join("out (2).mp4"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unique_output_path_returns_the_path_unchanged_when_free() {
        let dir = std::env::temp_dir().join(format!("briefcast_test_free_{}", std::process::id()));
        let target = dir.join("brand_new.mp4"); // dir deliberately never created - can't exist
        assert_eq!(unique_output_path(target.clone()), target);
    }
}