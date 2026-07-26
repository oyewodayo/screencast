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

// Deterministic, content-addressed cache location for the "just play, no prompts" preview
// fallback (see get_playable_preview below) - keyed by the source path plus its modification
// time, so a file replaced at the same path invalidates and regenerates automatically instead
// of ever silently reusing a stale preview.
fn preview_cache_path(input: &PathBuf) -> Result<PathBuf, String> {
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

    Ok(std::env::temp_dir().join("briefcast_preview_cache").join(format!("{:x}.mp4", key)))
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
    let cache_path = preview_cache_path(&input)?;

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

    let result = run_conversion(&app_handle, &window, &state, &[InputSpec::plain(input_path.clone())], &input_path, output, &codec_args).await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
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
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepSegment {
    pub source_path: String,
    pub start: f64,
    pub end: f64,
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
    pub fade: bool,
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
// `output_base_path` only names/locates the output - it's the file the timeline was opened on,
// which is not necessarily the source of any particular segment once clips have been dragged in
// from elsewhere (see DockerFile/DockerFile.path in VideoTimelineDocker.tsx).
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
    audio_muted: bool,
    audio_volume: f64,
) -> Result<String, String> {
    if segments.is_empty() {
        return Err("No segments to export".to_string());
    }

    // The primary video's OWN audio level (distinct from any audio overlay's own volume/muted,
    // which are separate mixed-in tracks) - 0.0 when muted, otherwise whatever the editor's track
    // volume slider was set to.
    let effective_video_volume = if audio_muted { 0.0 } else { audio_volume.max(0.0) };

    let base = PathBuf::from(&output_base_path);
    let stem = base.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = base.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "mp4".to_string());
    let parent = base.parent().map(PathBuf::from).unwrap_or_default();
    let output = parent.join(format!("{} (edited).{}", stem, ext));

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

    let has_video_overlays = !overlays.is_empty();
    let has_blur_overlays = !blur_overlays.is_empty();
    let has_audio_overlays = !audio_overlays.is_empty();

    let owned_args: Vec<String> = if segments.len() == 1 && !has_video_overlays && !has_blur_overlays && !has_audio_overlays {
        // Still the fast path even with a track volume/mute adjustment - that's a plain `-af`, no
        // filter graph needed just for it.
        let seg = &segments[0];
        let mut args = vec![
            "-ss".into(), format!("{:.3}", seg.start),
            "-to".into(), format!("{:.3}", seg.end),
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "medium".into(),
            "-crf".into(), "23".into(),
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

        // Base video (trim, or trim+concat) always lands in a [base] node so the overlay chain
        // below has one consistent label to start from regardless of how many segments there were.
        if segments.len() == 1 {
            let seg = &segments[0];
            filter.push_str(&format!(
                "[0:v]trim=start={0:.3}:end={1:.3},setpts=PTS-STARTPTS[base];[0:a]atrim=start={0:.3}:end={1:.3},asetpts=PTS-STARTPTS[outa];",
                seg.start, seg.end
            ));
        } else {
            // Same segment-major trim+concat pattern as before this function grew overlay support
            // - concat's inputs must interleave [v0][a0][v1][a1]..., not group all video labels
            // before all audio ones, or ffmpeg rejects the whole filtergraph ("Media type
            // mismatch").
            let mut concat_inputs = String::new();
            for (i, seg) in segments.iter().enumerate() {
                filter.push_str(&format!(
                    "[{2}:v]trim=start={0:.3}:end={1:.3},setpts=PTS-STARTPTS[v{2}];[{2}:a]atrim=start={0:.3}:end={1:.3},asetpts=PTS-STARTPTS[a{2}];",
                    seg.start, seg.end, i
                ));
                concat_inputs.push_str(&format!("[v{0}][a{0}]", i));
            }
            filter.push_str(&format!("{}concat=n={}:v=1:a=1[base][outa];", concat_inputs, segments.len()));
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
        // still PNG is "faded" via ffmpeg's own fade filter for overlays with animation:"fade" set
        // in the editor - alpha=1 fades the alpha channel itself rather than to black, which is
        // exactly what a transparent-background overlay needs - before being composited via
        // `overlay` gated to that overlay's own [start,end) window on the output timeline either way.
        let overlay_input_base = segments.len();
        for (i, ov) in overlays.iter().enumerate() {
            let source_label = format!("{}:v", overlay_input_base + i);
            let composited_label = if ov.fade {
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
            let next_label = if i + 1 == overlays.len() { "outv".to_string() } else { format!("ov{}", i) };
            filter.push_str(&format!(
                "[{}][{}]overlay=x={}:y={}:enable='between(t,{:.3},{:.3})'[{}];",
                current_label, composited_label, ov.x, ov.y, ov.start_time, ov.end_time, next_label
            ));
            current_label = next_label;
        }
        // Whatever [current_label] is pointing at (the plain trim/concat [base], or the last blur/
        // image/text stage that actually ran) needs to end up named [outv] for the -map below -
        // covers all four combinations of "any blur regions" x "any text/image overlays" with one
        // check, rather than the single `!has_video_overlays` special case this used to be before
        // blur support existed (back when [base] was the only possible "nothing chained" label).
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

        // Mixes each audio overlay into base_audio_label - amix's `normalize=0` is the detail that
        // matters here: amix auto-attenuates every input by 1/inputs by default, which would
        // quietly turn the original video's own audio down just because background music was
        // added. normalize=0 keeps each track at whatever level its own `volume=` filter below
        // already set (the track volume above for the original track, whatever the user picked for
        // each overlay) - "30% volume" means 30%, not 30% further divided by however many tracks
        // happen to be mixed in.
        let audio_label = if has_audio_overlays {
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
            filter.push_str(&format!(
                "{}amix=inputs={}:duration=first:dropout_transition=0:normalize=0[outa_mixed];",
                mix_inputs,
                audio_overlays.len() + 1
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
            "-preset".into(), "medium".into(),
            "-crf".into(), "23".into(),
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
            Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .output()
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

    let output = Command::new(&ffprobe_path)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            path_to_str(&input)?,
        ])
        .output()
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