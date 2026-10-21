// conversion.rs
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Emitter, State, Window};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use crate::services::responsiveness::blocking;
use crate::services::audio_fx::{audio_fx_filters, mono_to_stereo_filter, AudioFxSpec};
use crate::services::utility::{get_ffmpeg_path, get_ffprobe_path, path_to_str};

#[cfg(windows)]
use crate::commands::recording::hide_console_window;
use crate::services::transition_graphs::{canvas_transition, is_canvas_transition};
use crate::services::clip_fx::{clip_fx_graph, ClipFx};

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
    // Set by cancel_conversion - a run that fails because the user stopped it is never retried
    // (export_trimmed_video's software fallback). Cleared as each run starts.
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

// Exports running from the background queue (src/utils/exportQueue.ts), by job id - each on its
// own ConversionState, so cancelling one (cancel_export_job) never stops another export or any
// other conversion, and nothing else's cancel stops it.
#[derive(Default)]
pub struct ExportJobs(std::sync::Mutex<HashMap<String, ConversionState>>);

// Keeps a job registered for exactly as long as its export_trimmed_video call runs.
struct ExportJobGuard<'a> {
    jobs: &'a ExportJobs,
    id: String,
    state: ConversionState,
}

impl<'a> ExportJobGuard<'a> {
    fn register(jobs: &'a ExportJobs, id: &str) -> Self {
        let state = ConversionState::default();
        jobs.0.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), state.clone());
        Self { jobs, id: id.to_string(), state }
    }
}

impl Drop for ExportJobGuard<'_> {
    fn drop(&mut self) {
        self.jobs.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.id);
    }
}

// A job id as it may appear in a temp file name.
fn sanitize_job_id(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect()
}

#[tauri::command]
pub async fn cancel_export_job(export_jobs: State<'_, ExportJobs>, job_id: String) -> Result<(), String> {
    let job = export_jobs.0.lock().unwrap_or_else(|e| e.into_inner()).get(&job_id).cloned();
    match job {
        Some(state) => cancel_state(&state).await,
        // Already finished (or never started) - nothing to stop.
        None => Ok(()),
    }
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
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
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
        Self {
            path,
            pre_args: Vec::new(),
        }
    }

    // The file that has to be on disk for this input to open. An image-sequence input (an
    // animated overlay's frames - write_temp_overlay_sequence) is a printf pattern, not a file:
    // it's there when its first frame is.
    fn existing_path(&self) -> PathBuf {
        if self.pre_args.iter().any(|a| a == "-start_number") {
            PathBuf::from(self.path.replace("%06d", "000000"))
        } else {
            PathBuf::from(&self.path)
        }
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
    state: &ConversionState,
    inputs: &[InputSpec],
    progress_key: &str,
    output: PathBuf,
    codec_args: &[&str],
) -> Result<String, String> {
    run_conversion_timed(app_handle, window, state, inputs, progress_key, output, codec_args, None).await
}

// The same, with the output's length known up front (an export of cuts from a long recording):
// progress is measured against that, not against the first input file's whole length - which for
// a 60s cut out of a 10-minute recording read 10% at the finish line.
#[allow(clippy::too_many_arguments)]
async fn run_conversion_timed(
    app_handle: &AppHandle,
    window: &Window,
    state: &ConversionState,
    inputs: &[InputSpec],
    progress_key: &str,
    output: PathBuf,
    codec_args: &[&str],
    expected_duration: Option<f64>,
) -> Result<String, String> {
    run_conversion_with(app_handle, window, state, inputs, progress_key, output, codec_args, expected_duration, &RunExtras::default()).await
}

// What a background export (the queue - see export_trimmed_video's job_id) adds to a run.
#[derive(Default)]
struct RunExtras {
    // A second output after the main one: the live preview frame, written to `preview` as a small
    // JPEG that ffmpeg replaces atomically (-update 1 -atomic_writing 1) as the render advances.
    preview_args: Vec<String>,
    // (job id, file): the frame is read back whenever it changes and sent as export-job-preview.
    preview: Option<(String, PathBuf)>,
    // Below-normal CPU priority, so the editor keeps every core it asks for while this renders.
    low_priority: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportJobPreview {
    job_id: String,
    data_url: String,
}

// How often the preview frame file is checked for a newer frame.
const PREVIEW_FRAME_POLL_MS: u64 = 300;

#[allow(clippy::too_many_arguments)]
async fn run_conversion_with(
    app_handle: &AppHandle,
    window: &Window,
    state: &ConversionState,
    inputs: &[InputSpec],
    progress_key: &str,
    output: PathBuf,
    codec_args: &[&str],
    expected_duration: Option<f64>,
    extras: &RunExtras,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    state.cancelled.store(false, std::sync::atomic::Ordering::SeqCst);

    for input in inputs {
        if !input.existing_path().exists() {
            return Err(format!("Input file does not exist: {}", input.path));
        }
    }

    let output = unique_output_path(output);

    let _ = window.emit(
        "conversion-progress",
        ConversionProgress {
            input_path: progress_key.to_string(),
            output_path: output.to_string_lossy().to_string(),
            progress: 0.0,
            status: ConversionStatus::Starting,
            message: "Starting conversion...".to_string(),
        },
    );

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
    cmd.args(&extras.preview_args);
    // No interactive input is ever needed (the -y above suppresses overwrite prompts), and
    // leaving stdin inherited from the parent risks ffmpeg blocking on a read that never
    // resolves when run from a console-attached dev build.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    if extras.low_priority {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (as hide_console_window) | BELOW_NORMAL_PRIORITY_CLASS.
        cmd.creation_flags(0x0800_0000 | 0x0000_4000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start conversion: {}", e))?;

    let pid = child.id();
    #[cfg(unix)]
    if extras.low_priority {
        let _ = Command::new("renice").args(["-n", "10", "-p", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    // The live preview frame: re-read whenever ffmpeg has replaced it, until the run ends.
    let preview_running = Arc::new(std::sync::atomic::AtomicBool::new(true));
    if let Some((job_id, path)) = extras.preview.clone() {
        let running = preview_running.clone();
        let window = window.clone();
        std::thread::spawn(move || {
            let mut last_modified = None;
            while running.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(PREVIEW_FRAME_POLL_MS));
                let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) else { continue };
                if last_modified == Some(modified) {
                    continue;
                }
                let Ok(bytes) = std::fs::read(&path) else { continue };
                // A complete JPEG ends FF D9 - the rename makes this always true, but a torn read
                // must never reach the page as a broken image.
                if bytes.len() < 4 || bytes[bytes.len() - 2..] != [0xFF, 0xD9] {
                    continue;
                }
                last_modified = Some(modified);
                let data_url = format!("data:image/jpeg;base64,{}", BASE64.encode(&bytes));
                let _ = window.emit("export-job-preview", ExportJobPreview { job_id: job_id.clone(), data_url });
            }
            let _ = std::fs::remove_file(&path);
        });
    }
    struct StopPreview(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for StopPreview {
        fn drop(&mut self) {
            self.0.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _stop_preview = StopPreview(preview_running);
    {
        let mut active_process = state.active_process.lock().await;
        *active_process = Some(pid);
    }

    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

    // Total duration comes from ffmpeg's initial "Duration: HH:MM:SS.ms" line on stderr;
    // current position comes from the structured -progress stream on stdout. Shared so the
    // stdout reader thread can turn "out_time_us" into a percentage once duration is known.
    let duration = Arc::new(std::sync::Mutex::new(expected_duration.filter(|d| *d > 0.0)));

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

            let Some(us_str) = line.strip_prefix("out_time_us=") else {
                continue;
            };
            let Ok(current_us) = us_str.trim().parse::<i64>() else {
                continue;
            };
            if current_us < 0 {
                continue;
            }

            let Some(total_duration) = *duration.lock().unwrap() else {
                continue;
            };
            if total_duration <= 0.0 {
                continue;
            }

            let current_time = current_us as f64 / 1_000_000.0;
            let progress = (current_time / total_duration * 100.0).clamp(0.0, 99.0);

            let _ = window_clone.emit(
                "conversion-progress",
                ConversionProgress {
                    input_path: progress_key_clone.clone(),
                    output_path: output_path_clone.clone(),
                    progress,
                    status: ConversionStatus::Processing,
                    message: format!("Converting... {:.1}%", progress),
                },
            );
        }
    });

    // Wait for process to complete off the async runtime's worker threads - a transcode
    // can take minutes, and child.wait() blocks synchronously.
    let result = tauri::async_runtime::spawn_blocking(move || child.wait())
        .await
        .map_err(|e| format!("Conversion task panicked: {}", e))
        .and_then(|r| r.map_err(|e| format!("Failed to wait for conversion: {}", e)));

    {
        let mut active_process = state.active_process.lock().await;
        *active_process = None;
    }

    // ffmpeg creates the output the moment it starts, so a failed or cancelled (taskkill) run
    // would otherwise leave an empty or unplayable file in the library, which the sidebar then
    // lists and the thumbnailer retries on every scan. unique_output_path above guarantees the
    // file didn't exist before this run, so removing it never touches anything of the user's.
    let result = match result {
        Ok(status) => status,
        Err(e) => {
            let _ = std::fs::remove_file(&output);
            return Err(e);
        }
    };

    if result.success() {
        let _ = window.emit(
            "conversion-progress",
            ConversionProgress {
                input_path: progress_key.to_string(),
                output_path: output.to_string_lossy().to_string(),
                progress: 100.0,
                status: ConversionStatus::Completed,
                message: "Conversion completed successfully".to_string(),
            },
        );

        Ok(output.to_string_lossy().to_string())
    } else {
        let stderr_output = stderr_thread.join().unwrap_or_default();
        let _ = std::fs::remove_file(&output);
        let error_msg = format!(
            "Conversion failed: {}",
            crate::commands::recording::extract_ffmpeg_error(&stderr_output)
        );

        let _ = window.emit(
            "conversion-progress",
            ConversionProgress {
                input_path: progress_key.to_string(),
                output_path: output.to_string_lossy().to_string(),
                progress: 0.0,
                status: ConversionStatus::Failed,
                message: error_msg.clone(),
            },
        );

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
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
    ];

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
pub(crate) fn preview_cache_path(
    input: &PathBuf,
    namespace: &str,
    output_ext: &str,
) -> Result<PathBuf, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let metadata =
        std::fs::metadata(input).map_err(|e| format!("Failed to read input file: {}", e))?;
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

    Ok(std::env::temp_dir()
        .join("briefcast_preview_cache")
        .join(namespace)
        .join(format!("{:x}.{}", key, output_ext)))
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

    // One conversion per file at a time: the player, the timeline's filmstrip and an inserted
    // clip can all ask for the same file at once (an iPhone HEVC .MOV none of them can decode) -
    // the later callers wait here and then get the finished file from the check below.
    let flight = {
        static IN_FLIGHT: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<PathBuf, std::sync::Arc<Mutex<()>>>>> =
            std::sync::OnceLock::new();
        let mut map = IN_FLIGHT.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
        map.entry(cache_path.clone()).or_default().clone()
    };
    let _guard = flight.lock().await;

    // Already converted (fully, from a previous open) - just hand back the finished file, no
    // need to ever re-run ffmpeg for the same source. Only ever a WHOLE file: the conversion
    // writes to a .partial sibling and renames it into place once ffmpeg has succeeded, so an
    // interrupted run (app closed mid-way) can't leave a truncated file to be served from here.
    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create preview cache directory: {}", e))?;
    }
    let partial_path = cache_path.with_extension("partial.mp4");
    let _ = std::fs::remove_file(&partial_path); // a leftover from an interrupted run

    let codec_args = [
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
    ];

    run_conversion(
        &app_handle,
        &window,
        &state,
        &[InputSpec::plain(input_path.clone())],
        &input_path,
        partial_path.clone(),
        &codec_args,
    )
    .await?;
    std::fs::rename(&partial_path, &cache_path).map_err(|e| {
        let _ = std::fs::remove_file(&partial_path);
        format!("Failed to finish the playable copy: {}", e)
    })?;
    path_to_str(&cache_path).map(|s| s.to_string())
}

// How long a share-ready copy holds the thumbnail before the video starts.
const SHARE_COVER_SECONDS: f64 = 0.3;

// A copy of the video that OPENS on its chosen thumbnail. WhatsApp, Telegram, Instagram and the
// like ignore a video's embedded cover (set_video_thumbnail) and build their preview from its
// first frame - so a video that starts on black shows as black there however carefully its cover
// was chosen. This holds the thumbnail for SHARE_COVER_SECONDS at the start (silence under it),
// then the video as it was: re-encoded to H.264/AAC MP4 (needed to join the two; also the format
// every messaging app takes), fitted to the video's own size and frame rate. The original is left
// alone; the copy lands next to it as "<name> (share-ready).mp4". Reports progress on the same
// "conversion-progress" event as any conversion, keyed by the input path.
#[tauri::command]
pub async fn make_share_ready_copy(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let cover = custom_thumbnail_path(&app_handle, &input)?;
    if !cover.exists() {
        return Err("Set a thumbnail for this video first".to_string());
    }

    let probe = {
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        let input = input.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
            let mut cmd = Command::new(&ffprobe_path);
            cmd.args(["-v", "quiet", "-print_format", "json", "-show_streams"]);
            cmd.arg(path_to_str(&input)?);
            #[cfg(windows)]
            hide_console_window(&mut cmd);
            let output = cmd.output().map_err(|e| format!("Failed to run ffprobe: {}", e))?;
            serde_json::from_slice(&output.stdout).map_err(|e| format!("Failed to read the video's details: {}", e))
        })
        .await
        .map_err(|e| format!("Video check panicked: {e}"))??
    };
    let streams = probe["streams"].as_array().cloned().unwrap_or_default();
    let video = streams
        .iter()
        .find(|st| st["codec_type"] == "video" && st["disposition"]["attached_pic"].as_i64() != Some(1))
        .ok_or("This file has no video to put a thumbnail on")?;
    let has_audio = streams.iter().any(|st| st["codec_type"] == "audio");
    let (mut width, mut height) = (video["width"].as_u64().unwrap_or(0), video["height"].as_u64().unwrap_or(0));
    if width == 0 || height == 0 {
        return Err("Couldn't read the video's size".to_string());
    }
    // ffmpeg turns a rotated phone video upright as it decodes - the opening frame has to match.
    let rotation = video["side_data_list"]
        .as_array()
        .and_then(|list| list.iter().find_map(|d| d["rotation"].as_f64()))
        .or_else(|| video["tags"]["rotate"].as_str().and_then(|r| r.parse::<f64>().ok()))
        .unwrap_or(0.0);
    if (rotation.abs() as i64) % 180 == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    let (width, height) = (width - width % 2, height - height % 2);
    let fps = video["r_frame_rate"]
        .as_str()
        .filter(|r| {
            let mut parts = r.split('/').map(|n| n.parse::<f64>().unwrap_or(0.0));
            let (num, den) = (parts.next().unwrap_or(0.0), parts.next().unwrap_or(1.0));
            den > 0.0 && num / den >= 1.0 && num / den <= 120.0
        })
        .unwrap_or("30")
        .to_string();

    let fit = format!("scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps},format=yuv420p");
    let cover_chain = format!("[1:v]{fit},trim=duration={SHARE_COVER_SECONDS},setpts=PTS-STARTPTS[c]");
    let video_chain = format!("[0:V:0]{fit}[v]");
    let graph = if has_audio {
        format!(
            "{cover_chain};{video_chain};anullsrc=r=48000:cl=stereo,atrim=duration={SHARE_COVER_SECONDS}[s];[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a];[c][s][v][a]concat=n=2:v=1:a=1[ov][oa]"
        )
    } else {
        format!("{cover_chain};{video_chain};[c][v]concat=n=2:v=1:a=0[ov]")
    };
    let mut args: Vec<String> = vec!["-filter_complex".into(), graph, "-map".into(), "[ov]".into()];
    if has_audio {
        args.extend(["-map".into(), "[oa]".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    }
    args.extend(
        ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-map_metadata", "0", "-movflags", "+faststart"]
            .iter()
            .map(|a| a.to_string()),
    );
    // Pinned to the video's own rate - left to itself the joined output took the still image's
    // default 25 fps and dropped one frame in six of a 30 fps video (measured: SSIM 0.96 against
    // the original, vs 0.99 - the encoder's own ceiling at this CRF - with this).
    args.extend(["-r".to_string(), fps.clone()]);
    // The source's colour description carries over (an iPhone's Display-P3 tagging, HDR transfer...)
    // - without it, colour-managed players show the copy slightly off.
    for (flag, key) in [("-color_primaries", "color_primaries"), ("-color_trc", "color_transfer"), ("-colorspace", "color_space"), ("-color_range", "color_range")] {
        if let Some(value) = video[key].as_str().filter(|v| !v.is_empty() && *v != "unknown" && *v != "reserved") {
            args.extend([flag.to_string(), value.to_string()]);
        }
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let output = input.with_file_name(format!("{stem} (share-ready).mp4"));
    let cover_input = InputSpec {
        path: path_to_str(&cover)?.to_string(),
        pre_args: vec!["-framerate".into(), fps.clone(), "-loop".into(), "1".into(), "-t".into(), format!("{SHARE_COVER_SECONDS}")],
    };
    // The path actually written - "(1)" etc. is added when an earlier share-ready copy is there.
    let written = run_conversion(
        &app_handle,
        &window,
        &state,
        &[InputSpec::plain(input_path.clone()), cover_input],
        &input_path,
        output,
        &arg_refs,
    )
    .await?;

    // Messaging apps read the first frame, but File Explorer reads the embedded cover - and
    // without one it picks some frame from the middle. So the copy carries the cover too (the same
    // re-mux set_video_thumbnail does - WhatsApp sends such files fine), and Briefcast shows it as
    // well. Best effort: a copy without the embedded cover still does its main job.
    let output = PathBuf::from(&written);
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let tmp = output.with_extension("thumbtmp.mp4");
    match embed_cover_art(&ffmpeg_path, &output, &cover, &tmp, 1).await {
        Ok(()) => {
            if let Err(e) = std::fs::rename(&tmp, &output) {
                let _ = std::fs::remove_file(&tmp);
                log::warn!("Share-ready copy kept without an embedded cover: {e}");
            }
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            log::warn!("Share-ready copy kept without an embedded cover: {e}");
        }
    }
    if let Ok(custom) = custom_thumbnail_path(&app_handle, &output) {
        let _ = std::fs::copy(&cover, custom);
    }
    path_to_str(&output).map(|s| s.to_string())
}

// How long an image clip's preview proxy runs - and so the longest an image clip can be stretched
// on the timeline (its "source duration", see IMAGE_CLIP_MAX_SECONDS in videoEditTypes.ts).
const IMAGE_CLIP_PROXY_SECONDS: u32 = 600;
// Preview proxies never need more than this on their long edge - the player shows them at window
// size, and every pixel here is encode time spent before the clip can preview at all.
const PROXY_MAX_EDGE: u32 = 1920;

// Scales frame_width x frame_height down (aspect kept) to fit PROXY_MAX_EDGE, even dimensions.
fn proxy_size(frame_width: u32, frame_height: u32) -> (u32, u32) {
    let (w, h) = (frame_width.max(2) as f64, frame_height.max(2) as f64);
    let scale = (PROXY_MAX_EDGE as f64 / w.max(h)).min(1.0);
    let even = |v: f64| ((v * scale / 2.0).round() as u32 * 2).max(2);
    (even(w), even(h))
}

// Runs one short-lived ffmpeg encode for the proxies below (no progress events, no shared
// ConversionState - these are background preview assets, not a user-visible conversion), writing
// to a temp file first so an interrupted encode can never leave a truncated file at the cache path.
async fn encode_preview_proxy(ffmpeg_path: PathBuf, args: Vec<String>, cache_path: PathBuf) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = cache_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create preview cache directory: {}", e))?;
        }
        let tmp = cache_path.with_extension("partial.mp4");
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-y").args(&args).arg(path_to_str(&tmp)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::piped());
        let result = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() {
            let _ = std::fs::remove_file(&tmp);
            let stderr = String::from_utf8_lossy(&result.stderr);
            let reason = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("unknown error").to_string();
            return Err(format!("Couldn't prepare preview: {}", reason));
        }
        std::fs::rename(&tmp, &cache_path).map_err(|e| format!("Failed to store preview: {}", e))?;
        path_to_str(&cache_path).map(|s| s.to_string())
    })
    .await
    .map_err(|e| format!("Preview task panicked: {e}"))?
}

// The live preview of an image clip. The editor's player follows the timeline by seeking one
// <video> element from clip to clip (VideoTimelineDocker's live-preview effect), so rather than
// teaching it a second, image-shaped playback mode, an image clip previews as a cached
// low-frame-rate "still video" of that image - every existing preview effect (crop, Ken Burns, color grade,
// flip) then just works on it. Already letterboxed into the timeline's own frame by the same
// scale+pad export applies (frame_fit_chain), so positions line up with the real render exactly.
// Export never reads this file - it loops the original image at full quality instead.
#[tauri::command]
pub async fn get_image_clip_proxy(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    image_path: String,
    frame_width: u32,
    frame_height: u32,
) -> Result<String, String> {
    let input = PathBuf::from(&image_path);
    let (w, h) = proxy_size(frame_width, frame_height);
    // Frame size goes in the file name, not the namespace, so every proxy shares one cache entry in
    // Settings' storage list regardless of how many frame sizes have been used.
    let cache_path = preview_cache_path(&input, "image_clip_v1", &format!("{}x{}.mp4", w, h))?;
    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    let source = still_image_source(&app_handle, &window, &state, &image_path).await?;
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let args: Vec<String> = vec![
        "-loop".into(), "1".into(),
        // One frame every 10s: every frame is the same picture, and encode time scales with frame
        // count (measured: 600 frames took ~15s at 1080p, 60 frames ~2.4s, for the same file).
        "-framerate".into(), "0.1".into(),
        "-i".into(), source,
        "-t".into(), IMAGE_CLIP_PROXY_SECONDS.to_string(),
        "-vf".into(), frame_fit_chain(w as i64, h as i64, true)[1..].to_string(),
        "-c:v".into(), "libx264".into(),
        "-preset".into(), "ultrafast".into(),
        "-tune".into(), "stillimage".into(),
        // A single keyframe - the rest are near-empty repeats, so seeking anywhere decodes only a
        // few dozen trivial frames, and the whole proxy stays a few hundred KB.
        "-g".into(), "60".into(),
        "-an".into(),
        "-movflags".into(), "+faststart".into(),
    ];
    encode_preview_proxy(ffmpeg_path, args, cache_path).await
}

// The "primary file" a video project plays while no clip is under the playhead (an empty
// timeline, or before the first clip has loaded) - a short black video at the project's own frame
// size. The timeline reads the project's frame size off this (its videoPixelSize), the same way it
// reads a real video's, so overlay burn-in and export resolution need no project-specific path.
#[tauri::command]
pub async fn get_video_canvas_proxy(app_handle: AppHandle, width: u32, height: u32) -> Result<String, String> {
    let (w, h) = ((width.max(2) / 2) * 2, (height.max(2) / 2) * 2);
    let cache_path = std::env::temp_dir()
        .join("briefcast_preview_cache")
        .join("video_canvas_v1")
        .join(format!("{}x{}.mp4", w, h));
    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let args: Vec<String> = vec![
        "-f".into(), "lavfi".into(),
        "-i".into(), format!("color=c=black:s={}x{}:r=1:d=10", w, h),
        "-c:v".into(), "libx264".into(),
        "-preset".into(), "ultrafast".into(),
        "-pix_fmt".into(), "yuv420p".into(),
        "-an".into(),
        "-movflags".into(), "+faststart".into(),
    ];
    encode_preview_proxy(ffmpeg_path, args, cache_path).await
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
        let input_ext = input
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase());
        if matches!(input_ext.as_deref(), Some("heic") | Some("heif")) {
            return convert_heic_windows(
                &app_handle,
                &window,
                &state,
                &input,
                output,
                &output_format,
                preserve_original,
            )
            .await;
        }
    }

    // macOS/Linux counterpart to the Windows block above - same bug (ffmpeg mis-decodes modern
    // multi-image HEIC), same fix (libheif via heic_unix.rs), just one tier instead of two since
    // there's no OS-built-in decoder to try first here the way Windows has WIC.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let input_ext = input
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase());
        if matches!(input_ext.as_deref(), Some("heic") | Some("heif")) {
            return convert_heic_unix(
                &app_handle,
                &window,
                &state,
                &input,
                output,
                &output_format,
                preserve_original,
            )
            .await;
        }
    }

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

// HEIC/HEIF path for convert_image, above - always decodes through Windows' own HEIF codec to a
// full-resolution PNG first (see heic_windows::decode_to_png), then - unless PNG is what was
// actually asked for - hands that PNG to the same ffmpeg image2 pipeline every other image format
// already uses to reach jpeg/webp/bmp. ffmpeg is perfectly reliable at that second step; the only
// thing it couldn't be trusted with was reading the HEIC file in the first place.
#[cfg(windows)]
async fn convert_heic_windows(
    app_handle: &AppHandle,
    window: &Window,
    state: &ConversionState,
    input: &PathBuf,
    output: PathBuf,
    output_format: &str,
    preserve_original: bool,
) -> Result<String, String> {
    let _ = window.emit(
        "conversion-progress",
        ConversionProgress {
            input_path: input.to_string_lossy().to_string(),
            output_path: output.to_string_lossy().to_string(),
            progress: 0.0,
            status: ConversionStatus::Starting,
            message: "Decoding HEIC photo...".to_string(),
        },
    );

    let format = output_format.to_lowercase();
    let final_output = unique_output_path(output);

    let native_result: Result<String, String> = async {
        if format == "png" {
            crate::services::heic_windows::decode_to_png(input.clone(), final_output.clone())
                .await?;
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
            log::warn!(
                "HEIC native decode failed for {}: {native_err}; falling back to bundled libheif",
                input.display()
            );
            let fallback: Result<String, String> = async {
                if format == "png" {
                    crate::services::heif_tool::decode_to_png(
                        app_handle.clone(),
                        input.clone(),
                        final_output.clone(),
                    )
                    .await?;
                    Ok(final_output.to_string_lossy().to_string())
                } else {
                    let temp_png = final_output.with_extension("heic_tmp.png");
                    crate::services::heif_tool::decode_to_png(
                        app_handle.clone(),
                        input.clone(),
                        temp_png.clone(),
                    )
                    .await?;
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
                log::error!(
                    "HEIC libheif fallback also failed for {}: {heif_err}",
                    input.display()
                );
            }
            fallback.map_err(|heif_err| {
                format!("{native_err}; fallback conversion also failed: {heif_err}")
            })
        }
    };

    match &result {
        Ok(path) => {
            let _ = window.emit(
                "conversion-progress",
                ConversionProgress {
                    input_path: input.to_string_lossy().to_string(),
                    output_path: path.clone(),
                    progress: 100.0,
                    status: ConversionStatus::Completed,
                    message: "Conversion completed".to_string(),
                },
            );
            if !preserve_original {
                let _ = std::fs::remove_file(input);
            }
        }
        Err(err) => {
            let _ = window.emit(
                "conversion-progress",
                ConversionProgress {
                    input_path: input.to_string_lossy().to_string(),
                    output_path: String::new(),
                    progress: 0.0,
                    status: ConversionStatus::Failed,
                    message: err.clone(),
                },
            );
        }
    }

    result
}

// macOS/Linux counterpart to convert_heic_windows above - same shape (decode to PNG first, then
// hand off to the normal ffmpeg image2 pipeline unless PNG is what was actually asked for), just a
// single tier since there's no OS-built-in HEIC decoder to try before falling back to libheif here.
#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn convert_heic_unix(
    app_handle: &AppHandle,
    window: &Window,
    state: &ConversionState,
    input: &PathBuf,
    output: PathBuf,
    output_format: &str,
    preserve_original: bool,
) -> Result<String, String> {
    let _ = window.emit(
        "conversion-progress",
        ConversionProgress {
            input_path: input.to_string_lossy().to_string(),
            output_path: output.to_string_lossy().to_string(),
            progress: 0.0,
            status: ConversionStatus::Starting,
            message: "Decoding HEIC photo...".to_string(),
        },
    );

    let format = output_format.to_lowercase();
    let final_output = unique_output_path(output);

    let result: Result<String, String> = async {
        if format == "png" {
            crate::services::heic_unix::decode_to_png(input.clone(), final_output.clone()).await?;
            Ok(final_output.to_string_lossy().to_string())
        } else {
            let temp_png = final_output.with_extension("heic_tmp.png");
            crate::services::heic_unix::decode_to_png(input.clone(), temp_png.clone()).await?;
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

    match &result {
        Ok(path) => {
            let _ = window.emit(
                "conversion-progress",
                ConversionProgress {
                    input_path: input.to_string_lossy().to_string(),
                    output_path: path.clone(),
                    progress: 100.0,
                    status: ConversionStatus::Completed,
                    message: "Conversion completed".to_string(),
                },
            );
            if !preserve_original {
                let _ = std::fs::remove_file(input);
            }
        }
        Err(err) => {
            let _ = window.emit(
                "conversion-progress",
                ConversionProgress {
                    input_path: input.to_string_lossy().to_string(),
                    output_path: String::new(),
                    progress: 0.0,
                    status: ConversionStatus::Failed,
                    message: err.clone(),
                },
            );
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
    heic_preview(app_handle, window, &state, input_path).await
}

async fn heic_preview(app_handle: AppHandle, window: Window, state: &ConversionState, input_path: String) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let cache_path = preview_cache_path(&input, "heic_v2", "png")?;

    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create preview cache directory: {}", e))?;
    }

    #[cfg(windows)]
    {
        let _ = (&window, &state); // only used by the non-Windows branch below
        if let Err(native_err) =
            crate::services::heic_windows::decode_to_png(input.clone(), cache_path.clone()).await
        {
            // Windows' own HEIC decoder needs the HEVC Video Extensions codec package installed
            // (separate from HEIF Image Extensions) - plenty of machines only have the latter. Same
            // bundled-libheif fallback as convert_heic_windows above; see its comment for why that
            // replaced an ffmpeg fallback here.
            log::warn!(
                "HEIC native decode failed for {}: {native_err}; falling back to bundled libheif",
                input.display()
            );
            if let Err(heif_err) = crate::services::heif_tool::decode_to_png(
                app_handle.clone(),
                input.clone(),
                cache_path.clone(),
            )
            .await
            {
                log::error!(
                    "HEIC libheif fallback also failed for {}: {heif_err}",
                    input.display()
                );
                return Err(format!(
                    "{native_err}; fallback conversion also failed: {heif_err}"
                ));
            }
        }
        path_to_str(&cache_path).map(|s| s.to_string())
    }

    // macOS/Linux: try libheif first (see heic_unix.rs) - ffmpeg's own HEIF tile-grid
    // reconstruction is the same known-bad path documented on the Windows side above. Falls back
    // to ffmpeg only if libheif isn't installed, since this is a silent/cached background preview
    // rather than an explicit user action - producing a possibly-low-quality preview beats a hard
    // error here (unlike convert_image/convert_heic_unix, where a failed conversion should surface
    // clearly rather than silently write a degraded file into the library).
    #[cfg(not(windows))]
    {
        if let Err(err) =
            crate::services::heic_unix::decode_to_png(input.clone(), cache_path.clone()).await
        {
            log::warn!(
                "HEIC libheif decode failed for {}: {err}; falling back to ffmpeg (may be low quality for multi-image HEIC)",
                input.display()
            );
            run_conversion(
                &app_handle,
                &window,
                &state,
                &[InputSpec::plain(input_path.clone())],
                &input_path,
                cache_path,
                &[],
            )
            .await
        } else {
            path_to_str(&cache_path).map(|s| s.to_string())
        }
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
pub async fn get_image_thumbnail(
    app_handle: AppHandle,
    input_path: String,
) -> Result<String, String> {
    // Unconditional entry log (cache hit or miss) - the only line in this command that always
    // fires. Every other line here only logs on error, so a request that hangs (concurrencyLimiter
    // ts's withLimit racing it against a timeout instead of waiting forever - see that file's own
    // comment) previously left zero trace of ever having reached Rust at all: nothing in this log
    // to say whether the hang was in here or below the IPC layer entirely. This one line answers
    // that immediately next time - if it's missing for a stuck request, look at the frontend/IPC
    // side instead of in here.
    log::debug!("get_image_thumbnail: {}", input_path);
    let input = PathBuf::from(&input_path);
    // v2: thumbnails now honor EXIF orientation (see generate_plain_thumbnail) - the bump is what
    // retires every sideways phone-photo thumbnail cached under v1.
    let cache_path = preview_cache_path(&input, "thumb_v2", "jpg")?;

    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    }

    #[cfg(not(windows))]
    let _ = &app_handle; // only used by heif_tool on Windows - heic_unix needs no AppHandle

    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    #[cfg(windows)]
    if matches!(ext.as_deref(), Some("heic") | Some("heif")) {
        if let Err(err) = crate::services::heif_tool::extract_thumbnail(
            app_handle,
            input.clone(),
            cache_path.clone(),
            GALLERY_THUMBNAIL_MAX_DIMENSION,
        )
        .await
        {
            log::error!("HEIC thumbnail failed for {}: {err}", input.display());
            return Err(err);
        }
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    // macOS/Linux counterpart to the Windows block above - see heic_unix.rs. No ffmpeg fallback
    // here (unlike get_heic_preview) since a gallery thumbnail is cheap to retry and a silently
    // wrong/blank tile is worse than a clear per-file error surfaced to the frontend.
    #[cfg(not(windows))]
    if matches!(ext.as_deref(), Some("heic") | Some("heif")) {
        if let Err(err) = crate::services::heic_unix::extract_thumbnail(
            input.clone(),
            cache_path.clone(),
            GALLERY_THUMBNAIL_MAX_DIMENSION,
        )
        .await
        {
            log::error!("HEIC thumbnail failed for {}: {err}", input.display());
            return Err(err);
        }
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    let input_for_blocking = input.clone();
    let cache_for_blocking = cache_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        generate_plain_thumbnail(&input_for_blocking, &cache_for_blocking)
    })
    .await
    .map_err(|e| format!("Thumbnail task panicked: {e}"))?
    .map_err(|err| {
        log::error!("Image thumbnail failed for {}: {err}", input.display());
        err
    })?;

    path_to_str(&cache_path).map(|s| s.to_string())
}

fn generate_plain_thumbnail(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    use image::ImageDecoder;
    // Decoded through the format's own decoder (not image::open) so the EXIF orientation a phone
    // camera writes instead of rotating the pixels can be applied - image::open ignores it, which
    // left every portrait phone photo's thumbnail lying on its side. ffmpeg (image clip previews
    // and export) already honors the same tag, so thumbnails now match what renders.
    let mut decoder = image::ImageReader::open(input)
        .and_then(|reader| reader.with_guessed_format())
        .map_err(|e| format!("Failed to open image: {e}"))?
        .into_decoder()
        .map_err(|e| format!("Failed to open image: {e}"))?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(|e| format!("Failed to decode image: {e}"))?;
    img.apply_orientation(orientation);
    img.thumbnail(
        GALLERY_THUMBNAIL_MAX_DIMENSION,
        GALLERY_THUMBNAIL_MAX_DIMENSION,
    )
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
pub async fn get_video_thumbnail(
    app_handle: AppHandle,
    input_path: String,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    // One the user chose ("Set thumbnail") wins over any extracted frame - see custom_thumbnail_path.
    if let Ok(custom) = custom_thumbnail_path(&app_handle, &input) {
        if custom.exists() {
            return path_to_str(&custom).map(|s| s.to_string());
        }
    }
    let cache_path = preview_cache_path(&input, "video_thumb_v1", "jpg")?;

    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    // A file that already failed both extractions isn't retried until it changes (the cache path
    // is keyed by mtime, so a changed file gets a fresh key) - a broken file in a gallery used to
    // cost two ffmpeg runs every time the grid re-rendered, about once a second, indefinitely.
    // The marker file carries that across restarts too - otherwise every launch re-ran both
    // extractions for every broken file in the library (over a thousand logged failures a day).
    let failed_marker = cache_path.with_extension("failed");
    if failed_video_thumbnails().contains(&cache_path) || failed_marker.exists() {
        return Err("Thumbnail extraction already failed for this version of the file".to_string());
    }
    // An empty file (a recording or export that never got going) can't hold a frame - no need to
    // spend two ffmpeg runs finding that out.
    if std::fs::metadata(&input).map(|m| m.len() == 0).unwrap_or(false) {
        failed_video_thumbnails().insert(cache_path);
        return Err("The file is empty".to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    }

    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    if let Err(err) = extract_video_frame(&ffmpeg_path, &input, &cache_path, "00:00:01", 480).await {
        log::warn!(
            "Video thumbnail seek to 1s failed for {}: {err}; retrying at frame 0",
            input.display()
        );
        if let Err(err2) = extract_video_frame(&ffmpeg_path, &input, &cache_path, "00:00:00", 480).await
        {
            let combined = format!("{err}; retry at frame 0 also failed: {err2}");
            log::error!("Video thumbnail failed for {}: {combined}", input.display());
            let _ = std::fs::write(&failed_marker, b"");
            failed_video_thumbnails().insert(cache_path);
            return Err(combined);
        }
    }

    path_to_str(&cache_path).map(|s| s.to_string())
}

fn failed_video_thumbnails() -> std::sync::MutexGuard<'static, std::collections::HashSet<PathBuf>> {
    static FAILED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    FAILED
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

// Lets a user pick which frame becomes a video's thumbnail - both inside Briefcast (gallery/
// sidebar poster, get_video_thumbnail's cache) AND wherever the file itself is shared, by
// embedding that same frame as the file's attached-picture/cover image (the same mechanism MP3
// cover art uses) - the thing an app-side cache alone can never affect, since Explorer, WhatsApp,
// etc. never see Briefcast's cache, only the file's own bytes/metadata.
//
// Two ffmpeg passes: extract_video_frame gets the chosen frame as a jpg straight into
// get_video_thumbnail's own cache slot (so the in-app poster updates for free, no separate write),
// then embed_cover_art re-muxes that jpg into a new copy of the video with `-c copy` on the real
// audio/video streams (fast, lossless - only the newly-added still-image stream gets encoded, as
// mjpeg) and `-disposition:v:1 attached_pic` marking it as cover art. The re-mux writes to a
// sibling temp file, never in place - ffmpeg cannot read and write the same file at once - and
// only replaces the original on success, same write-tmp-then-rename convention as every sidecar
// in this app, just applied to the video file itself here instead of a JSON file next to it.
//
// Replacing the original changes its mtime, which orphans (not corrupts - just makes unreachable)
// every other path+mtime-keyed cache for this file (scrub sprite, captions, whisper transcript) -
// accepted fallout, identical in kind to what exporting/re-encoding this file already does today;
// each regenerates transparently on next use. Sidecars (.edits.json/.chapters.json) stay valid
// since they're keyed by path, not mtime.
#[tauri::command]
pub async fn set_video_thumbnail(
    app_handle: AppHandle,
    input_path: String,
    time: f64,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let cache_path = preview_cache_path(&input, "video_thumb_v1", "jpg")?;

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    }

    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let seek = format!("{:.3}", time.max(0.0));
    extract_video_frame(&ffmpeg_path, &input, &cache_path, &seek, 1920).await?;
    embed_cover_and_replace(&app_handle, &ffmpeg_path, &input, &cache_path, &input_path).await
}

// set_video_thumbnail's counterpart for a picture from disk instead of one of the video's own
// frames ("Choose image..." in the thumbnail picker). ffmpeg converts whatever image it is (png,
// webp, a big camera jpg...) into the same downscaled jpg in get_video_thumbnail's cache slot,
// then the same embed-and-replace step runs.
#[tauri::command]
pub async fn set_video_thumbnail_from_image(
    app_handle: AppHandle,
    input_path: String,
    image_path: String,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let image = PathBuf::from(&image_path);
    if !image.is_file() {
        return Err("That image no longer exists".to_string());
    }
    let cache_path = preview_cache_path(&input, "video_thumb_v1", "jpg")?;
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    }
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    image_to_cover_jpg(&ffmpeg_path, &image, &cache_path).await?;
    embed_cover_and_replace(&app_handle, &ffmpeg_path, &input, &cache_path, &input_path).await
}

// The thumbnail editor's output (a frame or picture with text/logo layers drawn on, composed in
// the webview's canvas) - same as set_video_thumbnail_from_image, from the encoded bytes instead
// of a file that already exists on disk.
#[tauri::command]
pub async fn set_video_thumbnail_from_bytes(
    app_handle: AppHandle,
    input_path: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("The edited thumbnail came through empty".to_string());
    }
    let input = PathBuf::from(&input_path);
    let cache_path = preview_cache_path(&input, "video_thumb_v1", "jpg")?;
    let parent = cache_path
        .parent()
        .ok_or("Invalid thumbnail cache path")?
        .to_path_buf();
    std::fs::create_dir_all(&parent)
        .map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    let source = parent.join(format!("edited_{}.jpg", std::process::id()));
    std::fs::write(&source, &bytes).map_err(|e| format!("Failed to write the edited thumbnail: {}", e))?;
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let converted = image_to_cover_jpg(&ffmpeg_path, &source, &cache_path).await;
    let _ = std::fs::remove_file(&source);
    converted?;
    embed_cover_and_replace(&app_handle, &ffmpeg_path, &input, &cache_path, &input_path).await
}

async fn image_to_cover_jpg(ffmpeg_path: &PathBuf, image: &PathBuf, output: &PathBuf) -> Result<(), String> {
    let ffmpeg_path = ffmpeg_path.clone();
    let image = image.clone();
    let output = output.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-y");
        cmd.arg("-i").arg(path_to_str(&image)?);
        // Even dimensions (mjpeg in an mp4 is happier) and never upscaled past the original.
        cmd.args(["-frames:v", "1", "-update", "1", "-vf", "scale='min(1920,iw)':-2", "-q:v", "2"]);
        cmd.arg(path_to_str(&output)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let result = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() || !output.exists() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            let reason = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("unknown ffmpeg error").to_string();
            return Err(format!("Couldn't read that image: {reason}"));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Thumbnail image task panicked: {e}"))?
}

// Where a thumbnail the user chose is kept: the app's own data folder (not the temp-dir preview
// cache, which Windows' disk cleanup empties), keyed by the file's path - so it survives restarts
// and holds for files that can't carry a cover themselves (.mov, .avi, .mkv...).
fn custom_thumbnail_path(app_handle: &AppHandle, input: &PathBuf) -> Result<PathBuf, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use tauri::Manager;
    let mut hasher = DefaultHasher::new();
    input.to_string_lossy().to_lowercase().hash(&mut hasher);
    let dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("No app data folder: {e}"))?
        .join("custom_thumbnails");
    Ok(dir.join(format!("{:x}.jpg", hasher.finish())))
}

// Why the cover can't go INTO this file, if it can't - the file is then left untouched and the
// thumbnail lives in Briefcast only. Measured against the bundled ffmpeg:
// - only the MP4 writer stores a cover; the QuickTime (.mov) writer silently drops it, so a .mov
//   used to come out rewritten with no cover at all;
// - keeping Apple's metadata (recording date, location, camera model) needs -movflags
//   use_metadata_tags, which in turn makes the MP4 writer drop the cover - so an MP4 carrying
//   those tags is never rewritten either: a cover isn't worth anyone's date/location history.
// Otherwise returns the number of real (non-cover) video streams - where the new cover goes.
fn embed_blocker(app_handle: &AppHandle, input: &PathBuf) -> Result<usize, &'static str> {
    let ext = input.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if ext != "mp4" && ext != "m4v" {
        return Err("format");
    }
    let ffprobe_path = get_ffprobe_path(app_handle).map_err(|_| "probe")?;
    let mut cmd = Command::new(&ffprobe_path);
    cmd.args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams"]);
    cmd.arg(path_to_str(input).map_err(|_| "probe")?);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = cmd.output().map_err(|_| "probe")?;
    let probe: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| "probe")?;
    let has_apple_tags = probe["format"]["tags"]
        .as_object()
        .map(|tags| tags.keys().any(|k| k.to_lowercase().starts_with("com.apple.")))
        .unwrap_or(false);
    if has_apple_tags {
        return Err("metadata");
    }
    let real_videos = probe["streams"]
        .as_array()
        .map(|streams| {
            streams
                .iter()
                .filter(|st| st["codec_type"] == "video" && st["disposition"]["attached_pic"].as_i64() != Some(1))
                .count()
        })
        .unwrap_or(0);
    if real_videos == 0 {
        return Err("probe");
    }
    Ok(real_videos)
}

// Applies `cover` (already in get_video_thumbnail's cache slot) as this video's thumbnail: always
// in Briefcast (custom_thumbnail_path), and also inside the file itself - a re-muxed copy swapped
// in for the original - only where that's possible without losing anything (embed_blocker).
// Returns "embedded", or "app-only:<why>" (embed_blocker's reason), so the picker can say which.
async fn embed_cover_and_replace(
    app_handle: &AppHandle,
    ffmpeg_path: &PathBuf,
    input: &PathBuf,
    cover: &PathBuf,
    input_path: &str,
) -> Result<String, String> {
    let cache_path = cover;
    let custom = custom_thumbnail_path(app_handle, input)?;
    if let Some(parent) = custom.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create the thumbnails folder: {}", e))?;
    }
    std::fs::copy(cache_path, &custom).map_err(|e| format!("Failed to keep the thumbnail: {}", e))?;

    let blocker = {
        let app_handle = app_handle.clone();
        let input = input.clone();
        tauri::async_runtime::spawn_blocking(move || embed_blocker(&app_handle, &input))
            .await
            .map_err(|e| format!("Thumbnail check panicked: {e}"))?
    };
    let video_streams = match blocker {
        Ok(n) => n,
        Err(reason) => {
            let _ = app_handle.emit("video-thumbnail-updated", input_path);
            return Ok(format!("app-only:{reason}"));
        }
    };

    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4")
        .to_string();
    let tmp_output = input.with_extension(format!("thumbtmp.{ext}"));

    if let Err(err) = embed_cover_art(ffmpeg_path, input, cache_path, &tmp_output, video_streams).await {
        let _ = std::fs::remove_file(&tmp_output);
        return Err(err);
    }

    // Windows won't let this rename succeed while another process (most likely this same video,
    // still open in the player that triggered this) holds the original file open - surfaced as a
    // clear, actionable error rather than a raw OS error code, with the half-written temp file
    // cleaned up either way so a retry doesn't trip over it.
    if let Err(e) = std::fs::rename(&tmp_output, input) {
        let _ = std::fs::remove_file(&tmp_output);
        return Err(format!(
            "Saved the thumbnail in Briefcast, but couldn't update the video file itself - it may still be open in the player. Try again in a moment. ({e})"
        ));
    }

    let _ = app_handle.emit("video-thumbnail-updated", input_path);
    Ok("embedded".to_string())
}

// mjpeg-encodes only the newly-added cover-image stream (map 1); -c copy on both mapped streams
// together would otherwise apply to it too, and ffmpeg can't stream-copy a jpg into a video-track
// slot. attached_pic is the disposition flag that tells MP4/MOV/MKV muxers (and, in turn, Explorer
// and any app that reads embedded cover art) "this stream is a poster image, not a played track."
async fn embed_cover_art(
    ffmpeg_path: &PathBuf,
    input: &PathBuf,
    cover: &PathBuf,
    output: &PathBuf,
    video_streams: usize,
) -> Result<(), String> {
    let ffmpeg_path = ffmpeg_path.clone();
    let input = input.clone();
    let cover = cover.clone();
    let output = output.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-y");
        cmd.arg("-i").arg(path_to_str(&input)?);
        cmd.arg("-i").arg(path_to_str(&cover)?);
        cmd.args([
            // Video first (0:V is video WITHOUT attached pictures - an old cover is dropped, or it
            // would take the new one's place), then audio/subtitles, then the new cover.
            "-map", "0:V", "-map", "0:a?", "-map", "0:s?", "-map", "1", "-map_metadata", "0",
            "-c", "copy",
        ]);
        // The cover is the video stream right after the real ones.
        let cover_stream = format!("v:{video_streams}");
        cmd.args([format!("-c:{cover_stream}"), "mjpeg".to_string(), format!("-disposition:{cover_stream}"), "attached_pic".to_string()]);
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
                .take(4)
                .collect();
            let reason: String = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
            return Err(format!(
                "Failed to embed thumbnail into the video file: {}",
                if reason.is_empty() { "unknown ffmpeg error".to_string() } else { reason }
            ));
        }
        if !output.exists() {
            return Err("ffmpeg exited successfully but produced no output file".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Thumbnail embed task panicked: {e}"))?
}

// -ss before -i is ffmpeg's fast (keyframe-seeking, not frame-accurate) seek - plenty precise for
// a thumbnail and far quicker than decoding from the start, which matters here since this runs
// once per video in a folder that can hold hundreds of them (bounded by the same shared
// thumbnailLimiter the frontend routes every gallery/sidebar thumbnail request through).
async fn extract_video_frame(
    ffmpeg_path: &PathBuf,
    input: &PathBuf,
    output: &PathBuf,
    seek: &str,
    max_width: u32,
) -> Result<(), String> {
    let ffmpeg_path = ffmpeg_path.clone();
    let input = input.clone();
    let output = output.clone();
    let seek = seek.to_string();
    let scale = format!("scale='min({max_width},iw)':-2");
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.args(["-y", "-ss", &seek]);
        cmd.arg("-i").arg(path_to_str(&input)?);
        cmd.args([
            "-frames:v",
            "1",
            "-update",
            "1",
            "-vf",
            &scale,
            "-q:v",
            "4",
        ]);
        cmd.arg(path_to_str(&output)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let result = cmd
            .output()
            .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            // ffmpeg's stderr always opens with its full version/build-config banner before
            // anything about THIS run - keeping only the last few non-empty lines is what
            // actually explains the failure (e.g. "Invalid data found when processing input"),
            // instead of a wall of --enable-* flags every single error gets buried under.
            let tail: Vec<&str> = stderr
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .rev()
                .take(3)
                .collect();
            let reason: String = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
            return Err(format!(
                "ffmpeg frame extraction failed: {}",
                if reason.is_empty() {
                    "unknown error".to_string()
                } else {
                    reason
                }
            ));
        }
        if !output.exists() {
            return Err("ffmpeg exited successfully but produced no output file".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Video thumbnail task panicked: {e}"))?
}

// Fixed per-tile size for the scrub-bar hover-preview sprite sheet (see get_video_scrub_sprite) -
// matches the 16:9 aspect ratio the frontend's hover-preview box (.preview-img-wrap in player.css)
// already renders at, just at a real decode resolution instead of a CSS box size.
const SCRUB_SPRITE_TILE_WIDTH: u32 = 160;
const SCRUB_SPRITE_TILE_HEIGHT: u32 = 90;
// Aim for one tile roughly every 5s of footage - granular enough that scrubbing feels responsive
// - but keep the grid bounded on both ends: a very short clip still gets a useful number of
// tiles (MIN), and a very long recording can't force ffmpeg to decode+encode an enormous sprite
// or the frontend to size an oversized <img> (MAX).
const SCRUB_SPRITE_TARGET_INTERVAL_SECS: f64 = 5.0;
const SCRUB_SPRITE_MIN_TILES: u32 = 10;
const SCRUB_SPRITE_MAX_TILES: u32 = 100;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScrubSprite {
    pub sprite_path: String,
    pub columns: u32,
    pub rows: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    pub count: u32,
    // Seconds of footage each tile represents - the frontend divides a hover position's time by
    // this to pick which tile to show.
    pub interval: f64,
}

// Pre-generated, cached hover-preview sprite for the scrub bar - one ffmpeg call builds a single
// grid image of downsampled frames spanning the whole video, so hovering the timeline afterwards
// is an instant CSS crop (VideoPlayer.tsx's handleTimelineHover) rather than a per-hover decode.
// Cached the same content-addressed way get_video_thumbnail is (path+mtime, see
// preview_cache_path), alongside a small JSON sidecar recording the grid layout that produced it -
// needed because that layout depends on this specific video's duration and has to be reproduced
// exactly on a cache hit for the frontend's tile math to stay correct, and re-probing duration
// on every hit just to recompute it would be wasted work the sidecar avoids entirely.
#[tauri::command]
pub async fn get_video_scrub_sprite(
    app_handle: AppHandle,
    input_path: String,
) -> Result<ScrubSprite, String> {
    let input = PathBuf::from(&input_path);
    let sprite_cache_path = preview_cache_path(&input, "scrub_sprite_v1", "jpg")?;
    let meta_cache_path = preview_cache_path(&input, "scrub_sprite_v1", "json")?;

    if sprite_cache_path.exists() {
        if let Ok(bytes) = std::fs::read(&meta_cache_path) {
            if let Ok(cached) = serde_json::from_slice::<ScrubSprite>(&bytes) {
                return Ok(ScrubSprite {
                    sprite_path: path_to_str(&sprite_cache_path)?.to_string(),
                    ..cached
                });
            }
        }
        // Sprite image exists but its metadata sidecar is missing/unreadable - fall through and
        // regenerate both together rather than risk the frontend slicing tiles with a guessed
        // layout that doesn't match what's actually in the cached image.
    }

    if let Some(parent) = sprite_cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create scrub-sprite cache directory: {}", e))?;
    }

    let ffprobe_path = get_ffprobe_path(&app_handle)?;
    let duration = {
        let ffprobe_path = ffprobe_path.clone();
        let input = input.clone();
        blocking(move || probe_duration_secs(&ffprobe_path, &input)).await??
    };
    if duration <= 0.0 {
        return Err("Video has no measurable duration".to_string());
    }

    let target = ((duration / SCRUB_SPRITE_TARGET_INTERVAL_SECS).round() as u32)
        .clamp(SCRUB_SPRITE_MIN_TILES, SCRUB_SPRITE_MAX_TILES)
        .min((duration.floor() as u32).max(1));
    let columns = (target as f64).sqrt().ceil() as u32;
    let rows = ((target as f64) / (columns as f64)).ceil() as u32;
    // The tile filter below always consumes exactly columns*rows input frames to emit its one
    // output grid - using that (rather than `target`) as the authoritative count keeps this
    // metadata truthful even though it can be a few tiles more than `target` asked for (the last
    // couple of cells then just repeat the final frame, an imperceptible edge case for a hover
    // preview).
    let count = columns * rows;
    let interval = duration / count as f64;

    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    generate_scrub_sprite(&ffmpeg_path, &input, &sprite_cache_path, interval, columns, rows).await?;

    let sprite = ScrubSprite {
        sprite_path: path_to_str(&sprite_cache_path)?.to_string(),
        columns,
        rows,
        tile_width: SCRUB_SPRITE_TILE_WIDTH,
        tile_height: SCRUB_SPRITE_TILE_HEIGHT,
        count,
        interval,
    };
    std::fs::write(
        &meta_cache_path,
        serde_json::to_vec(&sprite).map_err(|e| format!("Failed to serialize scrub-sprite metadata: {}", e))?,
    )
    .map_err(|e| format!("Failed to write scrub-sprite metadata: {}", e))?;

    Ok(sprite)
}

fn probe_duration_secs(ffprobe_path: &PathBuf, input: &PathBuf) -> Result<f64, String> {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        path_to_str(input)?,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;
    let probe: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;
    probe["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .ok_or_else(|| "ffprobe returned no duration for this file".to_string())
}

// Single ffmpeg call: samples one frame every `interval` seconds (fps=1/interval), downsizes each
// to the fixed tile size, then tiles them into one columns x rows grid image - see
// get_video_scrub_sprite's own doc comment for why a sprite sheet instead of per-tile files.
async fn generate_scrub_sprite(
    ffmpeg_path: &PathBuf,
    input: &PathBuf,
    output: &PathBuf,
    interval: f64,
    columns: u32,
    rows: u32,
) -> Result<(), String> {
    let ffmpeg_path = ffmpeg_path.clone();
    let input = input.clone();
    let output = output.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-y");
        // Decode keyframes only once tiles are far enough apart for keyframe spacing not to show
        // (recordings carry one every 1-2s). Otherwise every frame of the file is decoded on the
        // CPU just to keep a few dozen - measured 18s of CPU against 0.6s for a 15s 4K60
        // recording, and it scales with length, right when the user opens a fresh recording.
        if interval >= 2.0 {
            cmd.args(["-skip_frame", "nokey"]);
        }
        cmd.arg("-i").arg(path_to_str(&input)?);
        cmd.args([
            "-frames:v",
            "1",
            "-update",
            "1",
            "-vf",
            &format!(
                "fps=1/{interval},scale={tw}:{th},tile={cols}x{rows}",
                interval = interval,
                tw = SCRUB_SPRITE_TILE_WIDTH,
                th = SCRUB_SPRITE_TILE_HEIGHT,
                cols = columns,
                rows = rows
            ),
            "-q:v",
            "4",
        ]);
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
                "ffmpeg scrub-sprite generation failed: {}",
                if reason.is_empty() {
                    "unknown error".to_string()
                } else {
                    reason
                }
            ));
        }
        if !output.exists() {
            return Err("ffmpeg exited successfully but produced no scrub-sprite file".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Scrub-sprite task panicked: {e}"))?
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
    let cache_path = preview_cache_path(&input, &format!("captions_generated_v1_{}", lang), "vtt")?;

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

// One whisper run's worth of audio. Long recordings are transcribed in pieces this size so the
// work survives the app closing: each finished piece is kept, and a later run (same file, same
// language) only transcribes what's still missing - see transcribe_in_chunks. Short enough that
// little is lost to an interruption, long enough that whisper's per-run model load stays a small
// share of the time.
const CAPTION_CHUNK_SECS: f64 = 300.0;

// Bytes per second of the 16kHz mono s16le WAV extract_audio_for_whisper writes.
const WHISPER_WAV_BYTES_PER_SEC: f64 = 32_000.0;

fn chunk_parts_dir(cache_path: &PathBuf) -> PathBuf {
    cache_path.with_extension("parts")
}

// Transcribes `input` piece by piece into `<cache>.parts/`, resuming from whatever an earlier,
// interrupted run already finished (a piece counts as done once its `.ok` marker exists - written
// only after whisper succeeded, so a half-written output is never trusted). Returns every piece's
// start offset (seconds) and output file, in order. Emits "captions-progress" across the whole job,
// so a resumed run starts its bar at the share already done.
async fn transcribe_in_chunks(
    app_handle: &AppHandle,
    input: &PathBuf,
    cache_path: &PathBuf,
    lang: &str,
    words: bool,
) -> Result<Vec<(f64, PathBuf)>, String> {
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
    for i in 0..total {
        let offset = i as f64 * CAPTION_CHUNK_SECS;
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
        // Word mode feeds edit-by-transcript as well as captions, and there the hesitations are the
        // point: Whisper normally tidies speech up, silently dropping "um"/"uh" and stutters, so
        // "remove filler words" would have nothing to find. A disfluent prompt (the known trick
        // for keeping them) makes it transcribe what was actually said. English-only text, so
        // it's only given when the speech is English or being auto-detected.
        let keep_disfluencies = words && (lang == "en" || lang == "auto");
        let mut format_args: Vec<&str> = if words { vec!["-oj", "-ml", "1", "-sow"] } else { vec!["-ovtt"] };
        if keep_disfluencies {
            format_args.extend(["--prompt", WHISPER_DISFLUENCY_PROMPT]);
        }
        if let Some(vad) = vad_model.as_deref() {
            format_args.extend(["--vad", "-vm", vad]);
        }
        let result = run_whisper_cli(app_handle, &whisper_path, &model_path, &chunk_wav, &stem, lang, &format_args, span).await;
        let _ = std::fs::remove_file(&chunk_wav);
        result?;
        std::fs::write(&ok_marker, b"").map_err(|e| format!("Failed to record transcription progress: {}", e))?;
        outputs.push((offset, out_file));
    }
    Ok(outputs)
}

const WHISPER_DISFLUENCY_PROMPT: &str = "Umm, let me think like, hmm... Okay, uh, so here's what I'm, like, thinking, I- I mean the the plan.";

// The job is done and its final result cached - the pieces and extracted audio can go.
fn finish_chunked_transcription(cache_path: &PathBuf) {
    let _ = std::fs::remove_dir_all(chunk_parts_dir(cache_path));
}

async fn cut_wav_chunk(ffmpeg_path: &PathBuf, wav: &PathBuf, output: &PathBuf, start: f64, length: f64) -> Result<(), String> {
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
fn shift_vtt_timing(line: &str, offset: f64) -> Option<String> {
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

fn parse_vtt_time(s: &str) -> Option<f64> {
    let s = s.replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    let (h, m, sec) = match parts.as_slice() {
        [h, m, sec] => (h.parse::<f64>().ok()?, m.parse::<f64>().ok()?, sec.parse::<f64>().ok()?),
        [m, sec] => (0.0, m.parse::<f64>().ok()?, sec.parse::<f64>().ok()?),
        _ => return None,
    };
    Some(h * 3600.0 + m * 60.0 + sec)
}

fn format_vtt_time(t: f64) -> String {
    let ms_total = (t.max(0.0) * 1000.0).round() as u64;
    let h = ms_total / 3_600_000;
    let m = (ms_total % 3_600_000) / 60_000;
    let s = (ms_total % 60_000) / 1000;
    let ms = ms_total % 1000;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, ms)
}

#[derive(serde::Serialize)]
pub struct CaptionJobProgress {
    done: usize,
    // 0 when the audio hasn't been extracted yet (nothing to measure the total from).
    total: usize,
}

// Whether an interrupted caption job exists for this file+language (and how far it got) - lets
// the player resume it automatically on open, and the editor's Captions panel offer "Resume"
// instead of "Generate". None once the job is complete (or was never started).
#[tauri::command]
pub async fn caption_job_progress(input_path: String, language: Option<String>, words: bool) -> Result<Option<CaptionJobProgress>, String> {
    let input = PathBuf::from(&input_path);
    let lang = language.filter(|l| !l.is_empty()).unwrap_or_else(|| "auto".to_string());
    let (namespace, ext) = if words {
        (format!("captions_words_v3_{}", lang), "json")
    } else {
        (format!("captions_generated_v1_{}", lang), "vtt")
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
    start: f64,
    end: f64,
    text: String,
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
    // v3: fillers and stutters kept (WHISPER_DISFLUENCY_PROMPT) and words timed with voice
    // detection (ensure_vad_model) - the bump retires older transcripts that had neither.
    let cache_path = preview_cache_path(&input, &format!("captions_words_v3_{}", lang), "json")?;

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
fn parse_whisper_word_json(raw: &str) -> Result<Vec<CaptionWordOut>, String> {
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
    text: String,
    // whisper's own language code ("en", "de", ...) when it auto-detected one - the frontend locks
    // later chunks to it, since detection on a two-second utterance is far less reliable than on
    // the first, usually longer one.
    language: Option<String>,
}

// Dictation chunks from useDocDictation.ts: the frontend cuts the mic stream at speech pauses and
// sends each utterance as a 16kHz mono WAV, so whisper runs on a few seconds of audio at a time and
// text lands while the user is still talking. `prompt` is the document text before the cursor,
// passed as whisper's initial prompt - biases spelling of names/jargon already in the doc and keeps
// punctuation/casing consistent with what's already written.
#[tauri::command]
pub async fn transcribe_doc_audio(
    app_handle: AppHandle,
    audio_bytes: Vec<u8>,
    mime_type: Option<String>,
    language: Option<String>,
    prompt: Option<String>,
) -> Result<DocTranscript, String> {
    if audio_bytes.is_empty() {
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

    let ready_wav = is_whisper_ready_wav(&audio_bytes);
    std::fs::write(&input_path, audio_bytes)
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
        let language = run_whisper_text_cli(
            &app_handle,
            &whisper_path,
            &model_path,
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
// margin, rounded up to 64 frames, cut a 6s phrase from ~1.6s to ~0.75s on this machine with an
// identical transcript. Too tight a window truncates the tail, hence the 2.5s margin.
fn dictation_audio_ctx(seconds: f64) -> u32 {
    let frames = ((seconds + 2.5) * 50.0).ceil() as u32;
    (frames.div_ceil(64) * 64).clamp(256, 1500)
}

// True for a canonical 44-byte-header PCM WAV that's already 16kHz, mono, 16-bit.
fn is_whisper_ready_wav(bytes: &[u8]) -> bool {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" || &bytes[12..16] != b"fmt " {
        return false;
    }
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    u16_at(20) == 1 && u16_at(22) == 1 && u32_at(24) == 16000 && u16_at(34) == 16 && &bytes[36..40] == b"data"
}

fn audio_extension_for_mime(mime_type: Option<&str>) -> &'static str {
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

fn normalize_whisper_text(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn whisper_language_label(code: &str) -> String {
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

async fn extract_audio_for_whisper(
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
async fn run_whisper_cli(
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
) -> Result<(), String> {
    let app_handle = app_handle.clone();
    let (span_start, span_end) = progress_span;
    let _ = app_handle.emit("captions-progress", span_start);
    let format_args: Vec<String> = format_args.iter().map(|a| a.to_string()).collect();
    let whisper_path = whisper_path.clone();
    let model_path = model_path.clone();
    let wav_path = wav_path.clone();
    let output_stem = output_stem.clone();
    let language = language.to_string();
    // Leaves one logical core free rather than claiming every one of them - using all of them
    // starves everything else on the machine of CPU for the whole transcription (measured: a
    // couple of minutes even for under a minute of audio), including the UI thread rendering the
    // very progress this is meant to report and, in dev builds, the separate Vite dev-server
    // process - a real, reproduced symptom (window frame responsive, content area just never
    // repainting) that this one-core margin is meant to prevent.
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(1))
        .unwrap_or(4);
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&whisper_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-m").arg(path_to_str(&model_path)?);
        cmd.arg("-f").arg(path_to_str(&wav_path)?);
        cmd.args(&format_args);
        cmd.args(["-np", "-pp", "-t", &threads.to_string(), "-l", &language]);
        cmd.arg("-of").arg(path_to_str(&output_stem)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start whisper-cli: {}", e))?;

        // Drained but discarded - whisper-cli writes each transcribed segment here as it goes
        // (not currently surfaced anywhere), but the pipe still has to be read continuously or a
        // long transcription fills the OS pipe buffer and the child blocks trying to write to it,
        // silently hanging the whole command.
        let stdout = child.stdout.take().ok_or("Failed to capture whisper-cli stdout")?;
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if line.is_err() {
                    break;
                }
            }
        });

        let stderr = child.stderr.take().ok_or("Failed to capture whisper-cli stderr")?;
        let app_handle_for_stderr = app_handle.clone();
        let stderr_thread = std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut full_output = String::new();
            let progress_re = regex::Regex::new(r"progress\s*=\s*(\d+)%").unwrap();

            for line in reader.lines() {
                let Ok(line) = line else { continue };
                full_output.push_str(&line);
                full_output.push('\n');

                if let Some(caps) = progress_re.captures(&line) {
                    if let Ok(pct) = caps[1].parse::<f64>() {
                        let _ = app_handle_for_stderr.emit("captions-progress", span_start + pct / 100.0 * (span_end - span_start));
                    }
                }
            }

            full_output
        });

        let status = child
            .wait()
            .map_err(|e| format!("Failed to wait for whisper-cli: {}", e))?;
        let stderr_output = stderr_thread.join().unwrap_or_default();

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
async fn run_whisper_text_cli(
    app_handle: &AppHandle,
    whisper_path: &PathBuf,
    model_path: &PathBuf,
    wav_path: &PathBuf,
    output_stem: &PathBuf,
    language: &str,
    prompt: Option<&str>,
    audio_ctx: u32,
) -> Result<Option<String>, String> {
    let app_handle = app_handle.clone();
    let whisper_path = whisper_path.clone();
    let model_path = model_path.clone();
    let wav_path = wav_path.clone();
    let output_stem = output_stem.clone();
    let language = language.to_string();
    let prompt = prompt.map(str::to_string);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(1))
        .unwrap_or(4);
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&whisper_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-m").arg(path_to_str(&model_path)?);
        cmd.arg("-f").arg(path_to_str(&wav_path)?);
        // -bs 1 -bo 1: greedy decoding - beam search (the default 5) cost ~250ms more per phrase
        // with no change in the transcript on short dictation clips. -ac: see
        // dictation_audio_ctx. No -pp: a phrase finishes in well under a second, so per-percent
        // progress events were just noise.
        // -sns: suppress non-speech tokens ("[MUSIC]", "(laughs)") at decode time rather than only
        // filtering them out afterwards.
        let audio_ctx = audio_ctx.to_string();
        cmd.args(["-otxt", "-np", "-sns", "-bs", "1", "-bo", "1", "-ac", &audio_ctx, "-t", &threads.to_string(), "-l", &language]);
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
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if line.is_err() {
                    break;
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
    // The part of the move (0..1) this clip plays - a piece split out of a Ken Burns clip
    // continues the move (kenBurnsWindow, videoColorFilters.ts). None = all of it.
    pub span: Option<[f64; 2]>,
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
    pub duration: f64, // seconds
    // How a light leak / flash / bar open looks (TransitionLook, videoEditTypes.ts). Every field
    // is parsed/clamped before reaching the filter graph (transition_window_graph).
    #[serde(default)]
    pub look: Option<TransitionLook>,
}

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransitionLook {
    pub color: Option<String>,
    pub intensity: Option<f64>,
    pub direction: Option<String>,
    pub size: Option<f64>,
    pub orientation: Option<String>,
    // Iris: the shape the new clip opens out of. Only ever matched against known names.
    pub shape: Option<String>,
}

// "#rrggbb" -> (r, g, b); anything else -> None.
pub(crate) fn parse_hex_color(color: &str) -> Option<(f64, f64, f64)> {
    let hex = color.trim().strip_prefix('#')?;
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let ch = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok().map(f64::from);
    Some((ch(0)?, ch(2)?, ch(4)?))
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
    // Background-noise reduction strength, 0..1 - None/0 means off. VideoPlayer.tsx runs a
    // perceptually-similar (not bit-identical) live preview of this via a Web Audio worklet;
    // segment_noise_reduction_params() below is what actually clamps/maps this value onto afftdn's
    // own `nr`/`nf` parameter pair for the real export-time filter.
    pub noise_reduction: Option<f64>,
    // How noise_reduction is applied plus the extra cleanup stages around it - see AudioCleanup.
    pub audio_cleanup: Option<AudioCleanup>,
    // The clip's color grade baked to .cube text by the frontend (colorGrade.ts) - the exact table
    // its WebGL preview draws with, applied here with lut3d so the export matches it.
    pub lut_cube: Option<String>,
    // Camera-shake removal (vidstab, two passes) - see stabilization_transforms.
    pub stabilize: Option<StabilizeSettings>,
    // A speed ramp: the clip's range as consecutive constant-speed steps (clipTiming.ts - the same
    // steps the preview plays). Rendered as ONE segment - a single piecewise setpts for the picture
    // and per-step atempo for the sound - so the ramp's length is exact (joining the steps as
    // separate segments rounded every join to a whole frame: 0.17s drift over 16 steps). When set,
    // `speed` is ignored.
    pub speed_steps: Option<Vec<SpeedStep>>,
    // The clip's own sound is silenced (Clip.muted) - e.g. the quick cuts of a highlight intro,
    // which play over music. Rendered as silence of the segment's exact length.
    #[serde(default)]
    pub muted: Option<bool>,
    // An effect over the clip's whole picture (services/clip_fx.rs) - after its look, before the
    // vignette preset's layer.
    #[serde(default)]
    pub fx: Option<ClipFx>,
    // The editor-drawn pointer of an "Editable pointer" recording (pointerTrack.ts): its ripples and
    // cursor as sprite tracks timed in the source's own seconds, laid onto the clip's picture before
    // its crop and zoom (so they zoom with it) - see segment_effect_chain.
    #[serde(default)]
    pub pointer_layers: Option<Vec<SpriteTrack>>,
    // The source's own frame rate - what Ken Burns clocks itself by (ken_burns_chain). Filled in by
    // export_trimmed_video before the graph is built; never sent by the frontend.
    #[serde(skip)]
    pub source_fps: Option<f64>,
}

fn has_pointer_layers(seg: &KeepSegment) -> bool {
    seg.pointer_layers.as_ref().is_some_and(|l| !l.is_empty())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedStep {
    pub source_start: f64,
    pub source_end: f64,
    pub speed: f64,
}

fn clamp_speed(speed: f64) -> f64 {
    speed.max(0.25).min(16.0)
}

// The segment's steps relative to its own start: (from, to, speed) in source seconds. A plain
// segment is one step.
fn segment_steps(seg: &KeepSegment) -> Vec<(f64, f64, f64)> {
    match &seg.speed_steps {
        Some(steps) if !steps.is_empty() => steps
            .iter()
            .map(|st| ((st.source_start - seg.start).max(0.0), (st.source_end - seg.start).min(seg.end - seg.start), clamp_speed(st.speed)))
            .filter(|(a, b, _)| b > a)
            .collect(),
        _ => vec![(0.0, seg.end - seg.start, segment_speed(seg))],
    }
}

// How long the segment plays for in the OUTPUT - what every transition offset and silent-audio
// length is measured in.
fn segment_output_duration(seg: &KeepSegment) -> f64 {
    segment_steps(seg).iter().map(|(a, b, sp)| (b - a) / sp).sum::<f64>().max(0.0)
}

// The picture's speed change, applied after the clip's effects (so Ken Burns and friends run on
// the clip's own source time, exactly as the preview computes them): one setpts - a plain divide
// for constant speed, a continuous piecewise map for a ramp.
fn segment_speed_filter(seg: &KeepSegment) -> String {
    let steps = segment_steps(seg);
    if steps.len() <= 1 {
        let speed = steps.first().map(|s| s.2).unwrap_or(1.0);
        return format!("setpts=PTS/{:.4}", speed);
    }
    let mut out_before = Vec::with_capacity(steps.len());
    let mut acc = 0.0;
    for (a, b, sp) in &steps {
        out_before.push(acc);
        acc += (b - a) / sp;
    }
    let last = steps.len() - 1;
    let mut expr = format!("({:.6}+(T-{:.6})/{:.6})", out_before[last], steps[last].0, steps[last].2);
    for i in (0..last).rev() {
        expr = format!(
            "if(lt(T,{:.6}),({:.6}+(T-{:.6})/{:.6}),{})",
            steps[i + 1].0, out_before[i], steps[i].0, steps[i].2, expr
        );
    }
    format!("setpts='({})/TB'", expr)
}

// The video branch of one segment: trim to its range, effects, then its speed.
fn segment_video_chain(input: &str, seg: &KeepSegment, extra: &str) -> String {
    segment_video_chain_with_tail(input, seg, extra, 0.0)
}

// The same, reading `tail` source seconds past the segment's end - the tail handle a transition
// out of it plays (transition_tail). Effects are unchanged by it: Ken Burns holds its end state
// past the clip's own length, and the speed map's last step simply continues.
fn segment_video_chain_with_tail(input: &str, seg: &KeepSegment, extra: &str, tail: f64) -> String {
    format!(
        "{input}trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS{extra},{}",
        seg.start,
        seg.end + tail.max(0.0),
        segment_speed_filter(seg)
    )
}

// How long the transition INTO `seg` plays, in output seconds - at most 90% of `seg`, the same
// clamp transition_fold_step applies. None when it has none.
fn transition_window(seg: &KeepSegment) -> Option<f64> {
    seg.transition_in
        .as_ref()
        .filter(|tr| tr.duration > 0.0)
        .map(|tr| tr.duration.min(segment_output_duration(seg) * 0.9).max(0.05))
}

// Source seconds to read past a segment's end so it can keep PLAYING through the next clip's
// transition (window `d` output seconds) instead of freezing - at the speed it ends on, plus a
// little slack. Zero for a stabilized clip: its camera-path analysis covers only its own frames
// (stabilization_transforms), so it holds its last frame instead (as the preview does,
// TransitionPreviewLayer's hasMovingTail). A still's tail is the same picture either way.
fn tail_source_seconds(seg: &KeepSegment, d: f64) -> f64 {
    if seg.stabilize.is_some() {
        return 0.0;
    }
    let end_speed = segment_steps(seg).last().map(|s| s.2).unwrap_or(1.0);
    d * end_speed + 0.1
}

// Splits a segment's (tail-extended) picture `[src]` into the segment itself `[main]`, exactly
// `dur` output seconds, and its tail `[tail]`: the next `d` seconds, timed from 0 - the outgoing
// side of the transition into the next clip. Padded with the segment's last frame first, so the
// tail is always a full `d` long even when the source file ends at (or soon after) the cut.
fn transition_tail(src: &str, main: &str, tail: &str, dur: f64, d: f64, fps: f64) -> String {
    format!(
        "[{src}]tpad=stop_mode=clone:stop_duration={d:.3},split[{src}m][{src}t];\
         [{src}m]trim=end={dur:.6}[{main}];\
         [{src}t]trim=start={dur:.6},setpts=PTS-STARTPTS,fps={fps:.3},settb=AVTB,trim=end={d:.3}[{tail}];"
    )
}

const RAMP_AUDIO_LOOKAHEAD: f64 = 0.25;

// The audio branch of one segment. A ramp gets its cleanup on the source timeline first (where a
// noise sample's times mean what they say), then each step's tempo, joined sample-accurately.
fn segment_audio_chain(
    has_audio: bool,
    input_index: usize,
    seg: &KeepSegment,
    cleanup: &(Vec<String>, Option<(f64, f64)>),
    out_label: &str,
) -> String {
    let steps = segment_steps(seg);
    let has_audio = has_audio && !seg.muted.unwrap_or(false);
    if steps.len() <= 1 || !has_audio {
        if !has_audio {
            return format!(
                "anullsrc=channel_layout=stereo:sample_rate=44100:duration={:.3}[{}];",
                segment_output_duration(seg).max(0.01),
                out_label
            );
        }
        return audio_trim_chain(true, input_index, seg.start, seg.end, steps[0].2, cleanup, out_label);
    }
    let clean = format!("{}_src", out_label);
    let mut graph = audio_branch(&format!("[{}:a]", input_index), seg.start, seg.end, 1.0, &cleanup.0, cleanup.1, &clean);
    let split: String = (0..steps.len()).map(|i| format!("[{}_p{}]", out_label, i)).collect();
    graph.push_str(&format!("[{clean}]asplit={}{split};", steps.len()));
    let mut joined = String::new();
    // Each atempo drops its last partial window (~17ms) when its input ends - 0.27s lost over 16
    // steps. So each step reads a little past its end (silence past the clip's own end) and is then
    // trimmed to exactly its output length.
    for (i, (a, b, sp)) in steps.iter().enumerate() {
        graph.push_str(&format!(
            "[{out}_p{i}]atrim=start={a:.6}:end={lookahead:.6},asetpts=PTS-STARTPTS,apad=pad_dur={RAMP_AUDIO_LOOKAHEAD},{tempo},atrim=end={len:.6}[{out}_q{i}];",
            out = out_label,
            lookahead = b + RAMP_AUDIO_LOOKAHEAD,
            tempo = atempo_chain(*sp),
            len = (b - a) / sp
        ));
        joined.push_str(&format!("[{}_q{}]", out_label, i));
    }
    graph.push_str(&format!("{joined}concat=n={}:v=0:a=1[{out_label}];", steps.len()));
    graph
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StabilizeSettings {
    // 0..1 - how much camera movement is smoothed away (more = steadier, but crops in further).
    pub strength: f64,
}

// vidstabtransform's smoothing window (frames each side) for a 0..1 strength: 0.5 -> 25 frames,
// close to tripod-like steadiness for handheld footage without looking floaty.
fn stabilize_smoothing(strength: f64) -> u32 {
    (5.0 + strength.clamp(0.0, 1.0) * 40.0).round() as u32
}

// Pass 1 of stabilization: vidstabdetect over exactly the frames this clip uses (the same
// trim+setpts the export applies, so frame numbers line up with pass 2), cached per source file +
// range so it runs once however often the clip is exported or previewed.
async fn stabilization_transforms(app_handle: &AppHandle, source_path: &str, start: f64, end: f64) -> Result<PathBuf, String> {
    let input = PathBuf::from(source_path);
    let cache_path = preview_cache_path(&input, "stabilize_v1", &format!("{:.3}_{:.3}.trf", start, end))?;
    if cache_path.exists() {
        return Ok(cache_path);
    }
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create stabilization cache: {}", e))?;
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let partial = cache_path.with_extension("partial.trf");
    let filter = format!(
        "trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS,vidstabdetect=shakiness=6:accuracy=12:result='{}'",
        start,
        end,
        escape_filter_path(&partial)
    );
    let source = source_path.to_string();
    let partial_for_task = partial.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.args(["-y", "-i", &source, "-an", "-vf", &filter, "-f", "null", "-"]);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::piped());
        let result = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() || !partial_for_task.exists() {
            let _ = std::fs::remove_file(&partial_for_task);
            let stderr = String::from_utf8_lossy(&result.stderr);
            let reason = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("unknown error").to_string();
            return Err(format!("Couldn't analyse the clip for stabilization: {}", reason));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Stabilization task panicked: {e}"))??;
    std::fs::rename(&partial, &cache_path).map_err(|e| format!("Failed to keep stabilization data: {}", e))?;
    Ok(cache_path)
}

// A name for a file the editor derives from a clip, unique to its source, range and kind - so asking
// again for the same thing finds the file already made instead of rendering it twice.
pub(crate) fn derived_media_path(source_path: &str, kind: &str, key: &str, ext: &str) -> Result<PathBuf, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    source_path.hash(&mut hasher);
    key.hash(&mut hasher);
    let stem = std::path::Path::new(source_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip".to_string());
    Ok(crate::services::utility::derived_media_dir()?.join(format!("{} {} {:08x}.{}", stem, kind, hasher.finish() as u32, ext)))
}

fn run_ffmpeg_quiet(ffmpeg_path: &PathBuf, args: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg_path);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.arg("-y").args(args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    let result = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let reason = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("unknown error").to_string();
        return Err(reason);
    }
    Ok(())
}

// Freeze frame: the frame at `time` (source seconds) as a full-resolution PNG, which the editor
// then uses as an ordinary image clip. Returns the PNG's path.
#[tauri::command]
pub async fn extract_frame_still(app_handle: AppHandle, source_path: String, time: f64) -> Result<String, String> {
    let out = derived_media_path(&source_path, "frame", &format!("{:.3}", time), "png")?;
    if out.exists() {
        return path_to_str(&out).map(|s| s.to_string());
    }
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let partial = out.with_extension("partial.png");
    let args: Vec<String> = vec![
        "-ss".into(), format!("{:.3}", time.max(0.0)), "-i".into(), source_path.clone(),
        "-frames:v".into(), "1".into(), "-update".into(), "1".into(), path_to_str(&partial)?.to_string(),
    ];
    let task_partial = partial.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_ffmpeg_quiet(&ffmpeg_path, &args).and_then(|_| {
            if task_partial.exists() { Ok(()) } else { Err("no frame at that time".to_string()) }
        })
    })
    .await
    .map_err(|e| format!("Freeze frame task panicked: {e}"))?
    .map_err(|e| format!("Couldn't grab that frame: {}", e))?;
    std::fs::rename(&partial, &out).map_err(|e| format!("Failed to save the frame: {}", e))?;
    path_to_str(&out).map(|s| s.to_string())
}

// Where a "Merge clips" render goes (the timeline's clip menu): a new file in the editor's media
// folder next to reversed clips and frozen frames, named after the first clip's source. Each merge
// is its own file - unlike those, there's no fixed range to find an earlier render by.
#[tauri::command(async)]
pub fn merged_clip_output_path(source_path: String) -> Result<String, String> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out = derived_media_path(&source_path, "merged", &nonce.to_string(), "mp4")?;
    path_to_str(&out).map(|s| s.to_string())
}

// Deletes what a cancelled merge left behind (ffmpeg killed mid-write). Only ever a merge render in
// the editor's own media folder - anything else is refused, so this can't be pointed at user files.
#[tauri::command(async)]
pub fn discard_merged_clip(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = crate::services::utility::derived_media_dir()?;
    let in_media_dir = target.parent().map(|p| p == dir.as_path()).unwrap_or(false);
    let is_merge = target.file_name().map(|n| n.to_string_lossy().contains(" merged ")).unwrap_or(false);
    if !in_media_dir || !is_merge {
        return Err("Not a merge render".to_string());
    }
    match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Couldn't remove the cancelled merge: {}", e)),
    }
}

// How much of a clip is reversed at a time. ffmpeg's `reverse` holds every frame of its input in
// memory, so reversing a long clip in one go can take gigabytes; reversing it in short pieces and
// joining them last-to-first gives the identical result in bounded memory.
const REVERSE_CHUNK_SECS: f64 = 5.0;

// Reverse: the clip's [start,end) range played backwards, picture and sound, as a new file the
// clip then points at (its original range is remembered so it can be un-reversed). Returns the
// file's path.
#[tauri::command]
pub async fn render_reversed_clip(app_handle: AppHandle, source_path: String, start: f64, end: f64) -> Result<String, String> {
    if end - start <= 0.05 {
        return Err("The clip is too short to reverse".to_string());
    }
    // v2 in the key: the first version lost frames (see `fps` below), so its files aren't reused.
    let out = derived_media_path(&source_path, "reversed", &format!("v3 {:.3}-{:.3}", start, end), "mp4")?;
    if out.exists() {
        return path_to_str(&out).map(|s| s.to_string());
    }
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let has_audio = {
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        let path = source_path.clone();
        tauri::async_runtime::spawn_blocking(move || probe_has_audio(&ffprobe_path, &path)).await.unwrap_or(false)
    };
    // `reverse` drops the stream's frame rate, and ffmpeg then falls back to 25fps and silently
    // discards frames from a 30/60fps source - so every piece is re-timed at the source's own rate
    // (measured on a 30fps clip: 442 frames in, 372 out, before this).
    let fps = {
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        let path = source_path.clone();
        tauri::async_runtime::spawn_blocking(move || probe_frame_rate(&ffprobe_path, &path)).await.unwrap_or(30.0)
    };
    let work = std::env::temp_dir().join(format!("briefcast_reverse_{}_{:x}", std::process::id(), (start * 1000.0) as u64));
    std::fs::create_dir_all(&work).map_err(|e| format!("Failed to create a work folder: {}", e))?;
    let _cleanup = TempDir(work.clone());
    let source = source_path.clone();
    let out_for_task = out.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // Pieces cut by FRAME number (not time), so they tile the range exactly - cutting by time let
        // each boundary round to an extra frame. Rendered reversed, listed last piece first; audio
        // is cut at the same frame boundaries' times.
        let mut list = String::new();
        let first_frame = (start * fps).round() as i64;
        let last_frame = ((end * fps).round() as i64).max(first_frame + 1);
        let chunk = ((REVERSE_CHUNK_SECS * fps).round() as i64).max(1);
        let mut pieces: Vec<(i64, i64)> = Vec::new();
        let mut f = first_frame;
        while f < last_frame {
            let next = (f + chunk).min(last_frame);
            pieces.push((f, next));
            f = next;
        }
        for (i, (fa, fb)) in pieces.iter().enumerate().rev() {
            let piece = work.join(format!("piece_{:04}.mp4", i));
            let (a, b) = (*fa as f64 / fps, *fb as f64 / fps);
            let mut args: Vec<String> = vec!["-i".into(), source.clone(), "-filter_complex".into()];
            let video = format!("[0:v]trim=start_frame={fa}:end_frame={fb},setpts=PTS-STARTPTS,reverse,setpts=N/({fps:.3}*TB)[v]");
            if has_audio {
                args.push(format!("{video};[0:a]atrim=start={a:.4}:end={b:.4},asetpts=PTS-STARTPTS,areverse[a]"));
                args.extend(["-map".into(), "[v]".into(), "-map".into(), "[a]".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
            } else {
                args.push(video);
                args.extend(["-map".into(), "[v]".into()]);
            }
            args.extend(["-r".into(), format!("{:.3}", fps), "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(), "-crf".into(), "18".into(), "-pix_fmt".into(), "yuv420p".into()]);
            args.push(path_to_str(&piece)?.to_string());
            run_ffmpeg_quiet(&ffmpeg_path, &args).map_err(|e| format!("Couldn't reverse the clip: {}", e))?;
            list.push_str(&format!("file '{}'\n", path_to_str(&piece)?.replace('\\', "/").replace('\'', "'\\''")));
        }
        let list_path = work.join("pieces.txt");
        std::fs::write(&list_path, list).map_err(|e| format!("Failed to write the piece list: {}", e))?;
        let partial = out_for_task.with_extension("partial.mp4");
        let args: Vec<String> = vec![
            "-f".into(), "concat".into(), "-safe".into(), "0".into(), "-i".into(), path_to_str(&list_path)?.to_string(),
            "-c".into(), "copy".into(), "-movflags".into(), "+faststart".into(), path_to_str(&partial)?.to_string(),
        ];
        run_ffmpeg_quiet(&ffmpeg_path, &args).map_err(|e| format!("Couldn't join the reversed clip: {}", e))?;
        std::fs::rename(&partial, &out_for_task).map_err(|e| format!("Failed to save the reversed clip: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Reverse task panicked: {e}"))??;
    path_to_str(&out).map(|s| s.to_string())
}

// A work folder removed when dropped, whatever happens in between.
struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// Pass 2, as a filter-chain fragment for segment_effect_chain. `optzoom=1` crops in just enough to
// hide the moving edges; the light unsharp makes up for the resampling softness.
fn stabilize_chain(trf_path: &str, strength: f64) -> String {
    format!(
        ",vidstabtransform=input='{}':smoothing={}:optzoom=1:interpol=bicubic,unsharp=5:5:0.6:3:3:0.3",
        trf_path,
        stabilize_smoothing(strength)
    )
}

// A stabilized render of one clip's range (no other effects), for "Preview stabilized" in the clip
// viewer - stabilization needs the whole clip analysed first, so it can't preview live in the
// player. Cached per source + range + strength; 720p ultrafast, so it's quick to make.
#[tauri::command]
pub async fn stabilized_clip_preview(app_handle: AppHandle, source_path: String, start: f64, end: f64, strength: f64) -> Result<String, String> {
    let input = PathBuf::from(&source_path);
    let cache_path = preview_cache_path(&input, "stabilize_v1", &format!("{:.3}_{:.3}_{:.2}.mp4", start, end, strength))?;
    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    let trf = stabilization_transforms(&app_handle, &source_path, start, end).await?;
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let video = format!(
        "[0:v]trim=start={s:.3}:end={e:.3},setpts=PTS-STARTPTS{stab},scale=-2:'min(720,ih)'[v]",
        s = start,
        e = end,
        stab = stabilize_chain(&escape_filter_path(&trf), strength)
    );
    let has_audio = {
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        let path = source_path.clone();
        tauri::async_runtime::spawn_blocking(move || probe_has_audio(&ffprobe_path, &path))
            .await
            .unwrap_or(false)
    };
    let mut args: Vec<String> = vec!["-i".into(), source_path.clone(), "-filter_complex".into()];
    if has_audio {
        args.push(format!("{video};[0:a]atrim=start={start:.3}:end={end:.3},asetpts=PTS-STARTPTS[a]"));
        args.extend(["-map".into(), "[v]".into(), "-map".into(), "[a]".into(), "-c:a".into(), "aac".into()]);
    } else {
        args.push(video);
        args.extend(["-map".into(), "[v]".into()]);
    }
    args.extend([
        "-c:v".into(), "libx264".into(), "-preset".into(), "ultrafast".into(), "-crf".into(), "23".into(),
        "-pix_fmt".into(), "yuv420p".into(), "-movflags".into(), "+faststart".into(),
    ]);
    encode_preview_proxy(ffmpeg_path, args, cache_path).await
}

// A platform format for the export (Shorts/Reels 9:16, square, 4:5...) and how the picture is
// fitted into it. Applied to the assembled video before overlays and captions, which are then
// drawn at this size - so captions sit properly in a vertical frame instead of being cropped off.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputFrame {
    pub width: i64,
    pub height: i64,
    // "fit-blur" (whole picture over a blurred, zoomed copy of itself), "fit" (black bars), or
    // "fill" (cropped to fill).
    pub mode: String,
    // Fill only: where the crop window sits, 0..1 across the spare width/height (0.5 = centred).
    pub anchor_x: Option<f64>,
    pub anchor_y: Option<f64>,
    // Fill only, auto-reframe: the crop window's centre over the output timeline as knots
    // (seconds, x, y - fractions of the frame), eased between (reframeTrack.ts). Replaces the anchor.
    pub track: Option<Vec<[f64; 3]>>,
}

// A value through `knots` (time, value) over `tvar`: held before the first and after the last,
// smoothstep-eased between each pair, constant where a pair is equal (a hold). Built as a balanced
// tree of if()s - depth log2(n), so an hour of camera moves stays cheap per frame.
fn eased_knots_expr(knots: &[(f64, f64)], tvar: &str) -> String {
    fn segment(a: (f64, f64), b: (f64, f64), tvar: &str) -> String {
        if (b.1 - a.1).abs() < 1e-6 {
            return format!("{:.5}", a.1);
        }
        let p = format!("clip(({tvar}-{:.4})/{:.4},0,1)", a.0, (b.0 - a.0).max(1e-3));
        format!("({:.5}+({:.5})*{p}*{p}*(3-2*{p}))", a.1, b.1 - a.1)
    }
    fn build(knots: &[(f64, f64)], lo: usize, hi: usize, tvar: &str) -> String {
        if lo == hi {
            return segment(knots[lo], knots[lo + 1], tvar);
        }
        let mid = (lo + hi) / 2;
        format!("if(lt({tvar},{:.4}),{},{})", knots[mid + 1].0, build(knots, lo, mid, tvar), build(knots, mid + 1, hi, tvar))
    }
    match knots.len() {
        0 => "0.5".into(),
        1 => format!("{:.5}", knots[0].1),
        n => build(knots, 0, n - 2, tvar),
    }
}

fn reframe_chain(input: &str, output: &str, frame: &OutputFrame) -> String {
    let w = (frame.width.max(16) / 2) * 2;
    let h = (frame.height.max(16) / 2) * 2;
    match frame.mode.as_str() {
        "fill" if frame.track.as_ref().map_or(false, |t| !t.is_empty()) => {
            let track = frame.track.as_ref().unwrap();
            let mut sorted: Vec<[f64; 3]> = track.iter().filter(|k| k.iter().all(|v| v.is_finite())).cloned().collect();
            sorted.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(std::cmp::Ordering::Equal));
            let x = eased_knots_expr(&sorted.iter().map(|k| (k[0], k[1].clamp(0.0, 1.0))).collect::<Vec<_>>(), "t");
            let y = eased_knots_expr(&sorted.iter().map(|k| (k[0], k[2].clamp(0.0, 1.0))).collect::<Vec<_>>(), "t");
            // The window centred on the track, kept inside the frame.
            format!("[{input}]scale={w}:{h}:force_original_aspect_ratio=increase,crop=w={w}:h={h}:x='clip(({x})*iw-ow/2,0,iw-ow)':y='clip(({y})*ih-oh/2,0,ih-oh)',setsar=1[{output}];")
        }
        "fill" => {
            let ax = frame.anchor_x.unwrap_or(0.5).clamp(0.0, 1.0);
            let ay = frame.anchor_y.unwrap_or(0.5).clamp(0.0, 1.0);
            if (ax - 0.5).abs() < 1e-6 && (ay - 0.5).abs() < 1e-6 {
                format!("[{input}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1[{output}];")
            } else {
                format!("[{input}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}:(iw-ow)*{ax:.4}:(ih-oh)*{ay:.4},setsar=1[{output}];")
            }
        }
        "fit" => format!("[{input}]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[{output}];"),
        _ => format!(
            "[{input}]split=2[rf_bg_in][rf_fg_in];\
             [rf_bg_in]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=luma_radius=40:luma_power=2,eq=brightness=-0.06[rf_bg];\
             [rf_fg_in]scale={w}:{h}:force_original_aspect_ratio=decrease[rf_fg];\
             [rf_bg][rf_fg]overlay=(W-w)/2:(H-h)/2,setsar=1[{output}];"
        ),
    }
}

// Files an export writes for ffmpeg to read (graded clips' LUTs), deleted when the export is done
// however it ends - success, failure or an early error return.
struct TempFiles(Vec<PathBuf>);
impl Drop for TempFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

// Mirrors AudioCleanup (videoEditTypes.ts). None/default fields keep the original behaviour:
// spectral afftdn denoise only, no extra stages.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCleanup {
    // "reduce" (afftdn) or "remove" (arnndn voice isolation). Anything else means "reduce".
    pub mode: Option<String>,
    pub low_cut: Option<bool>,
    // Mains frequency to notch out, 50 or 60 (anything else is ignored).
    pub hum: Option<u32>,
    pub gate: Option<bool>,
    // Loudness levelling (speechnorm + loudnorm) - evens out quiet and loud speakers.
    pub level: Option<bool>,
    // A noise-only stretch of the clip's own source file (source seconds) for "reduce" mode to
    // learn its profile from, instead of afftdn's built-in estimate - see audio_branch.
    pub noise_sample: Option<NoiseSample>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct NoiseSample {
    pub start: f64,
    pub end: f64,
}

// Longest noise sample afftdn is asked to learn from - a profile settles within a second or two,
// so anything longer is wasted decode time.
const MAX_NOISE_SAMPLE_SECS: f64 = 10.0;

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
    // Mirrors OverlayAnimation (videoEditTypes.ts): "pop" scales per frame (overlay_pop_scale_expr),
    // slide-* moves via overlay_position_expr, fade fades the alpha. Sanitized against
    // ALLOWED_OVERLAY_ANIMATIONS the same way transition_type already is (sanitize_transition_name)
    // - interpolated directly into the filter_complex string, so this is a real security boundary.
    pub animation: String,
    // Keyframed motion (keyframes.ts): position/scale/opacity over time, replacing `animation`'s
    // slide when present. Already in output-video pixels and absolute output seconds.
    #[serde(default)]
    pub keyframes: Option<Vec<OverlayKeyframe>>,
    // An animated overlay (a shape/element - videoAssets.ts) as a PNG frame sequence instead of
    // one still: frame k shows at start_time + k/OVERLAY_INPUT_FPS. Frames repeat a lot (a looping
    // pulse, a held shape), so only the distinct images travel - `sequence[k]` indexes `unique`.
    // `data_base64` is unused when this is set.
    #[serde(default)]
    pub frames: Option<OverlayFrames>,
    // A CSS mix-blend-mode name ("multiply", "screen"...) - the preview's look - composited by
    // blend_composite. None/"normal" (or anything not in blend_mode_ffmpeg) is a plain overlay.
    #[serde(default)]
    pub blend_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayFrames {
    pub unique: Vec<String>,
    pub sequence: Vec<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayKeyframe {
    pub time: f64,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub opacity: f64,
    // How the motion eases from this keyframe to the next: "linear", "ease", "ease-in",
    // "ease-out" or "hold" (stays put, then jumps). Matches easeKeyframe (keyframes.ts).
    pub easing: String,
}

// Overlay PNG inputs run at this rate so a keyframed scale (which, in this ffmpeg, can only follow
// time through the frame number `n`) maps frames to seconds exactly.
const OVERLAY_INPUT_FPS: f64 = 30.0;

fn easing_expr(easing: &str, p: &str) -> String {
    match easing {
        "ease" => format!("({p})*({p})*(3-2*({p}))"),
        "ease-in" => format!("({p})*({p})"),
        "ease-out" => format!("(1-(1-({p}))*(1-({p})))"),
        "hold" => "0".to_string(),
        _ => p.to_string(),
    }
}

// easing_expr's curves, evaluated here.
fn ease_value(easing: &str, p: f64) -> f64 {
    let p = p.clamp(0.0, 1.0);
    match easing {
        "ease" => p * p * (3.0 - 2.0 * p),
        "ease-in" => p * p,
        "ease-out" => 1.0 - (1.0 - p) * (1.0 - p),
        "hold" => 0.0,
        _ => p,
    }
}

// keyframe_expr's curve evaluated at time `t` - held before the first keyframe and after the last.
fn keyframe_value(kfs: &[OverlayKeyframe], t: f64, value: impl Fn(&OverlayKeyframe) -> f64) -> f64 {
    let mut sorted: Vec<&OverlayKeyframe> = kfs.iter().collect();
    sorted.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    let (first, last) = (sorted[0], sorted[sorted.len() - 1]);
    if t <= first.time {
        return value(first);
    }
    for pair in sorted.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if t < b.time {
            let p = (t - a.time) / (b.time - a.time).max(1e-3);
            return value(a) + (value(b) - value(a)) * ease_value(&a.easing, p);
        }
    }
    value(last)
}

// A keyframed overlay's opacity as per-frame alpha commands for `target` (a named
// colorchannelmixer): its value at every frame where it changes - from the overlay's start through
// its last keyframe - and nothing after, where it holds.
fn opacity_commands(kfs: &[OverlayKeyframe], target: &str, start: f64, end: f64) -> String {
    let opacity = |t: f64| keyframe_value(kfs, t, |k| k.opacity.clamp(0.0, 1.0));
    let last_change = kfs.iter().map(|k| k.time).fold(start, f64::max).min(end);
    let frames = ((last_change - start) * OVERLAY_INPUT_FPS).ceil().max(0.0) as usize;
    // Only where the 8-bit alpha actually changes - a hold costs no commands.
    let mut cmds: Vec<String> = Vec::new();
    let mut last = String::new();
    for n in 0..=frames {
        let t = start + n as f64 / OVERLAY_INPUT_FPS;
        let v = format!("{:.4}", (opacity(t) * 255.0).round() / 255.0);
        if v != last {
            cmds.push(format!("{t:.4} {target} aa {v}"));
            last = v;
        }
    }
    format!("sendcmd=c='{}'", cmds.join(";"))
}

// One keyframed value over time as an ffmpeg expression in `tvar`: held at the first keyframe's
// value before it, eased between each pair, held at the last after it - the same piecewise curve
// keyframeStateAt (keyframes.ts) draws in the preview.
//
// Piece i is the eased segment from keyframe i to i+1 (the last piece holds the last value), and
// the pieces are chosen by a balanced tree of time comparisons rather than a chain: a motion
// track bakes hundreds of keyframes, and a chain of hundreds of nested if()s is as deep as it is
// long for ffmpeg's recursive expression parser and costs every frame a walk down all of it.
fn keyframe_expr(kfs: &[OverlayKeyframe], tvar: &str, value: impl Fn(&OverlayKeyframe) -> f64) -> String {
    let mut sorted: Vec<&OverlayKeyframe> = kfs.iter().collect();
    sorted.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    let piece = |i: usize| -> String {
        if i + 1 >= n {
            return format!("{:.4}", value(sorted[n - 1]));
        }
        let (a, b) = (sorted[i], sorted[i + 1]);
        let p = format!("clip(({tvar}-{:.4})/{:.4},0,1)", a.time, (b.time - a.time).max(1e-3));
        format!("({:.4}+({:.4})*{})", value(a), value(b) - value(a), easing_expr(&a.easing, &p))
    };
    // Pieces lo..=hi; piece i covers [time of keyframe i, time of keyframe i+1).
    fn build(lo: usize, hi: usize, tvar: &str, sorted: &[&OverlayKeyframe], piece: &dyn Fn(usize) -> String) -> String {
        if lo == hi {
            return piece(lo);
        }
        let mid = (lo + hi) / 2;
        format!("if(lt({tvar},{:.4}),{},{})", sorted[mid + 1].time, build(lo, mid, tvar, sorted, piece), build(mid + 1, hi, tvar, sorted, piece))
    }
    build(0, n - 1, tvar, &sorted, &piece)
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
    // The preview's CSS blur radius (a Gaussian's standard deviation) in output pixels -
    // gaussian_blur_chain reproduces it. None: the older boxblur radius from `intensity`.
    #[serde(default)]
    pub sigma: Option<f64>,
    // Keyframed (e.g. motion-tracked) position: x/y are the region's top-left in output pixels at
    // absolute output seconds; scale/opacity are ignored (the region keeps its size).
    #[serde(default)]
    pub keyframes: Option<Vec<OverlayKeyframe>>,
}

// An adjustment layer (adjustmentLayers.ts): grades and/or blurs everything beneath it in the
// stack for its window - "under" sits on the video itself (below blur regions and every overlay),
// "over" above every overlay and PiP (captions stay on top). The preview is a backdrop-filter of
// the same CSS functions in the same order, so this composes exactly what the browser draws.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentLayerSpec {
    pub start_time: f64,
    pub end_time: f64,
    pub placement: String,
    // CSS colour filter functions in order ("brightness", "contrast", "saturate", "hue-rotate"
    // (degrees), "sepia", "grayscale"), applied after the blur as the backdrop-filter list is.
    #[serde(default)]
    pub color_ops: Vec<CssOpSpec>,
    // Gaussian standard deviation in output pixels (CSS blur()); 0/None = none.
    #[serde(default)]
    pub blur_sigma: Option<f64>,
    // The "vignette" look's strength (vignetteBackground) drawn over the adjusted picture.
    #[serde(default)]
    pub vignette: Option<f64>,
    // 0..1, how much of the adjustment shows (the preview element's opacity).
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    // Where the effect applies: a grey mask PNG (renderAdjustmentMask) whose top-left sits at
    // (mask_x, mask_y) in output pixels - the effect is confined to that box and weighted by the
    // mask. None: the whole frame.
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub mask_x: i64,
    #[serde(default)]
    pub mask_y: i64,
    // The region moving (a spotlight following someone - adjustmentLayers.ts): the mask PNG is then
    // the region alone (not inverted), and these place its top-left over time (output pixels,
    // absolute output seconds); `mask_invert` turns it into "everything but the region".
    #[serde(default)]
    pub mask_keyframes: Option<Vec<OverlayKeyframe>>,
    #[serde(default)]
    pub mask_invert: bool,
    // A solid colour instead of the adjusted picture ("#rrggbb") - what masks the main video: show
    // only a region of it, the rest filled.
    #[serde(default)]
    pub fill: Option<String>,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Deserialize, Clone)]
pub struct CssOpSpec {
    pub op: String,
    pub value: f64,
}

// A chapter of the exported video - embedded in the MP4 (embed_chapters) and written to its
// `.chapters.json` sidecar so the player shows it. `time` is output seconds.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChapterSpec {
    pub time: f64,
    pub label: String,
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
    // Music ducking: lowered to `level` while someone speaks - see duck_volume_filter.
    #[serde(default)]
    pub duck: Option<DuckEnvelope>,
    // The mixer channel's EQ/compressor/balance (audio_fx.rs), after the volume and fades.
    #[serde(default)]
    pub fx: Option<AudioFxSpec>,
}

// Where to lower a music track under speech, worked out by the frontend (src/utils/musicDucking.ts,
// which applies the very same curve to the live preview): `ranges` are output-timeline seconds of
// speech; the gain eases down `attack` s before each one starts (the export can look ahead, so the
// music is already down when the first word lands) and back up over `release` s after it ends.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckEnvelope {
    pub level: f64,
    pub attack: f64,
    pub release: f64,
    pub ranges: Vec<[f64; 2]>,
}

// "-x" for a non-negative x, "+|x|" otherwise - ffmpeg's expression parser doesn't need it, but a
// "t--1.2" in a filter graph is easy to misread when debugging one.
fn minus_term(x: f64) -> String {
    if x >= 0.0 { format!("-{:.3}", x) } else { format!("+{:.3}", -x) }
}

// A `volume` filter (evaluated per audio frame) for one overlay's ducking, in the overlay's own
// local time (its chain is atrim'd and asetpts'd to start at 0 = its start_time). Per speech range,
// a trapezoid rising over `attack` and falling over `release`; summed and capped at 1, since the
// frontend merges ranges whose ramps would otherwise meet. None when there's nothing to duck.
fn duck_volume_filter(duck: &DuckEnvelope, start_time: f64, duration: f64) -> Option<String> {
    let level = duck.level.clamp(0.0, 1.0);
    let (attack, release) = (duck.attack.max(0.01), duck.release.max(0.01));
    if level >= 0.999 {
        return None;
    }
    let terms: Vec<String> = duck
        .ranges
        .iter()
        .map(|[s, e]| (s - start_time, e - start_time))
        .filter(|(s, e)| s.is_finite() && e.is_finite() && e > s && e + release > 0.0 && s - attack < duration)
        .map(|(s, e)| format!("clip((t{})/{:.3},0,1)*clip(({:.3}-t)/{:.3},0,1)", minus_term(s - attack), attack, e + release, release))
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(format!("volume='1-{:.3}*min(1,{})':eval=frame", 1.0 - level, terms.join("+")))
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
    // Source-frame region to keep (fractions of the pip source's own width/height, same basis as
    // PipOverlay.crop, videoEditTypes.ts) - applied before the cover-fit scale below. `default` so
    // an older frontend that never sends it still deserializes.
    #[serde(default)]
    pub crop: Option<PipCrop>,
    pub trim_start: f64,
    pub start_time: f64,
    pub end_time: f64,
    // 0.0 when the frontend's own "play this clip's own audio" toggle is off (see
    // PipOverlay.muted, videoEditTypes.ts) - collapsed to a single number the same way
    // effective_video_volume already folds audio_muted into the primary track's own volume,
    // rather than carrying a separate bool here too.
    pub volume: f64,
    // CSS mix-blend-mode, as OverlayImage.blend_mode.
    #[serde(default)]
    pub blend_mode: Option<String>,
    // Its sound's EQ/compressor/balance (audio_fx.rs), as OverlayAudio.fx.
    #[serde(default)]
    pub fx: Option<AudioFxSpec>,
    // 0..1 (None = 1), and linear alpha ramps at its ends in seconds (already capped at half its
    // length by the frontend - videoTracks.ts exportFades).
    #[serde(default)]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    // Green/blue-screen keying (chroma_key_filters); None = none.
    #[serde(default)]
    pub chroma_key: Option<ChromaKeySpec>,
    // A grey PNG the size of the box (white = shown): the layer's shape and its mask, feathered,
    // rendered by the frontend (layerMask.ts) - the very picture the preview masks with. Multiplied
    // into the layer's alpha. None: the shape alone, drawn here (geq).
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    // Filled in by export_trimmed_video, not sent: how the preview decoded the source's colours
    // (probe_browser_color), and the ffmpeg input holding the mask PNG.
    #[serde(skip)]
    pub source_color: Option<(&'static str, &'static str)>,
    #[serde(skip)]
    pub mask_input: Option<usize>,
    // The person cut out of the source (background_removal.rs): a VP9+alpha WebM shown in place of
    // the source's picture. Its sound still comes from the source.
    #[serde(default)]
    pub cutout_path: Option<String>,
    // What shows behind a cut-out person, inside the layer (none = see-through).
    #[serde(default)]
    pub cutout_background: Option<CutoutBackgroundSpec>,
    // Filled in by export_trimmed_video: the inputs holding its picture and, when that's the
    // cut-out, its sound - and its background's (the source again, or the picture).
    #[serde(skip)]
    pub video_input: usize,
    #[serde(skip)]
    pub audio_input: Option<usize>,
    #[serde(skip)]
    pub background_input: Option<usize>,
    // A mask that moves and resizes (a reveal - layerMask.ts): its own picture (the shape, feathered,
    // with room for the feather around it) placed at each moment's box inside the layer.
    #[serde(default)]
    pub mask_motion: Option<MaskMotionSpec>,
    #[serde(skip)]
    pub mask_motion_input: Option<usize>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MaskMotionSpec {
    pub image_base64: String,
    // The picture's top-left and size in the layer's box (pixels), at absolute output seconds.
    pub keyframes: Vec<MaskKeyframeSpec>,
    #[serde(default)]
    pub invert: bool,
}

#[derive(Debug, Deserialize, Clone)]
pub struct MaskKeyframeSpec {
    pub time: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub easing: String,
}

// The moving mask as a grey stream the layer's size ([out]): the mask's picture scaled and placed
// per frame on black (inverted when asked). Its input is the picture looped at OVERLAY_INPUT_FPS
// from the layer's start, so the frame number gives the time for the per-frame size.
fn moving_mask_chain(pip: &PipOverlay, motion: &MaskMotionSpec, input: usize, tag: &str, out: &str) -> String {
    // The keyframes as OverlayKeyframes (x, y, and the size riding in scale/opacity), for keyframe_expr.
    let kfs: Vec<OverlayKeyframe> = motion
        .keyframes
        .iter()
        .map(|k| OverlayKeyframe { time: k.time, x: k.x, y: k.y, scale: k.w.max(2.0), opacity: k.h.max(2.0), easing: k.easing.clone() })
        .collect();
    let (w, h, st) = (pip.width, pip.height, pip.start_time);
    let frame_time = format!("({st:.4}+n/{OVERLAY_INPUT_FPS})");
    let (mw, mh) = (keyframe_expr(&kfs, &frame_time, |k| k.scale), keyframe_expr(&kfs, &frame_time, |k| k.opacity));
    let (kx, ky) = (keyframe_expr(&kfs, "t", |k| k.x), keyframe_expr(&kfs, "t", |k| k.y));
    // Smaller than 2 px the picture can't be scaled down any further - a closed reveal would show as
    // a faint dot or line. The preview draws nothing there, so neither does this.
    let raw: Vec<OverlayKeyframe> = motion
        .keyframes
        .iter()
        .map(|k| OverlayKeyframe { time: k.time, x: 0.0, y: 0.0, scale: k.w, opacity: k.h, easing: k.easing.clone() })
        .collect();
    let (tw, th) = (keyframe_expr(&raw, "t", |k| k.scale), keyframe_expr(&raw, "t", |k| k.opacity));
    let shown = format!("gte({tw},2)*gte({th},2)");
    let negate = if motion.invert { ",negate" } else { "" };
    let d = (pip.end_time - pip.start_time).max(0.01) + 0.1;
    format!(
        "color=c=black:s={w}x{h}:r={OVERLAY_INPUT_FPS}:d={d:.3},setpts=PTS+{st:.4}/TB,format=yuv420p[{tag}mc];\
         [{input}:v]format=yuv420p,setpts=PTS-STARTPTS+{st:.4}/TB,scale=w='max(2,trunc({mw}/2)*2)':h='max(2,trunc({mh}/2)*2)':eval=frame[{tag}mp];\
         [{tag}mc][{tag}mp]overlay=x='{kx}':y='{ky}':eof_action=repeat:enable='{shown}',format=gray{negate}[{out}];"
    )
}

// Behind a cut-out (cutoutBackground.ts): "color" - a solid colour; "image" - a picture, already
// fitted to the layer's box by the frontend (the very drawing the preview shows); "blur" - the
// source itself (its `source_crop` part) blurred by `blur_sigma` output pixels, drawn
// `blur_margin` px larger on each side before the blur so its edges stay full (the preview draws
// it the same way).
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CutoutBackgroundSpec {
    pub kind: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub image_base64: Option<String>,
    #[serde(default)]
    pub blur_sigma: Option<f64>,
    #[serde(default)]
    pub blur_margin: Option<i64>,
    #[serde(default)]
    pub source_crop: Option<PipCrop>,
}

// The filters putting `bg` behind the cut-out [cut] (both the layer's size), writing [out] - empty
// when the background can't be drawn (it then stays see-through).
fn cutout_background_chain(pip: &PipOverlay, bg: &CutoutBackgroundSpec, cut: &str, tag: &str, out: &str) -> String {
    let (w, h, st) = (pip.width, pip.height, pip.start_time);
    let dur = (pip.end_time - pip.start_time).max(0.01) + 0.1;
    let base = match bg.kind.as_str() {
        "color" => {
            let hex = bg.color.as_deref().map(|c| c.trim().trim_start_matches('#')).and_then(|c| u32::from_str_radix(c, 16).ok()).unwrap_or(0) & 0xff_ffff;
            format!("color=c=0x{hex:06x}:s={w}x{h}:r={OVERLAY_INPUT_FPS}:d={dur:.3},setpts=PTS+{st:.4}/TB,format=yuv420p[{tag}bg];")
        }
        "image" => match pip.background_input {
            Some(input) => format!(
                "color=c=black:s={w}x{h}:r={OVERLAY_INPUT_FPS}:d={dur:.3},setpts=PTS+{st:.4}/TB,format=yuv420p[{tag}bb];\
                 [{input}:v]scale={w}:{h},setpts=PTS-STARTPTS+{st:.4}/TB[{tag}bi];[{tag}bb][{tag}bi]overlay=eof_action=repeat:format=auto,format=yuv420p[{tag}bg];"
            ),
            None => return String::new(),
        },
        "blur" => match pip.background_input {
            Some(input) => {
                let sigma = bg.blur_sigma.filter(|s| s.is_finite()).unwrap_or(0.0).max(0.0);
                let m = bg.blur_margin.unwrap_or(0).clamp(0, 4096);
                let (bw, bh) = (w + 2 * m, h + 2 * m);
                let blur = gaussian_blur_chain(sigma, bw, bh, None);
                let blur = if blur.is_empty() { String::new() } else { format!("{blur},") };
                format!(
                    "[{input}:v]trim=start={ts:.3}:end={te:.3},setpts=PTS-STARTPTS+{st:.4}/TB,{crop}scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},format=yuv420p,{blur}crop={w}:{h}:{m}:{m}[{tag}bg];",
                    ts = pip.trim_start,
                    te = pip.trim_start + dur,
                    crop = pip_crop_fragment(bg.source_crop),
                )
            }
            None => return String::new(),
        },
        _ => return String::new(),
    };
    format!("{base}[{tag}bg][{cut}]overlay=shortest=1:format=auto,format=yuv420p[{out}];")
}

// A key colour ("#rrggbb"), how close to it counts as screen and how soft the edge is (ffmpeg
// chromakey's similarity/blend), and how much screen-coloured spill to take out of the subject.
#[derive(Debug, Deserialize, Clone)]
pub struct ChromaKeySpec {
    pub color: String,
    pub similarity: f64,
    pub blend: f64,
    #[serde(default)]
    pub spill: f64,
}

#[derive(Debug, Deserialize, Clone, Copy)]
pub struct PipCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// `crop=` fragment (with trailing comma) for a pip's source-frame crop, or "" when there's nothing
// to crop - an unset, non-finite, or effectively full-frame crop is skipped entirely rather than
// emitted as a no-op filter. Clamped the same way ClipCropOverlay clamps it on the frontend
// (MIN_FRACTION 0.05), so a hand-edited sidecar can't ask ffmpeg for a zero-area crop.
fn pip_crop_fragment(crop: Option<PipCrop>) -> String {
    let Some(c) = crop else { return String::new() };
    if ![c.x, c.y, c.width, c.height].iter().all(|v| v.is_finite()) {
        return String::new();
    }
    let w = c.width.clamp(0.05, 1.0);
    let h = c.height.clamp(0.05, 1.0);
    let x = c.x.clamp(0.0, 1.0 - w);
    let y = c.y.clamp(0.0, 1.0 - h);
    if w > 0.999 && h > 0.999 {
        return String::new();
    }
    format!(
        "crop=w=iw*{w:.6}:h=ih*{h:.6}:x=iw*{x:.6}:y=ih*{y:.6},",
        w = w, h = h, x = x, y = y
    )
}

const ALLOWED_PIP_SHAPES: &[&str] = &["circle", "rounded", "rectangle"];

fn sanitize_pip_shape(shape: &str) -> &str {
    ALLOWED_PIP_SHAPES
        .iter()
        .find(|&&s| s == shape)
        .copied()
        .unwrap_or("rectangle")
}

// How the webview decodes a source's colours to RGB, as scale's in_color_matrix/in_range values: its
// own tags when it has them; untagged, BT.709 from 720 rows up and BT.601 below, limited range -
// measured on WebView2's decoder (an untagged 1280x718 frame decodes as 601, 64x720 as 709).
// ffmpeg on its own would assume BT.601 for all of them.
pub(crate) fn browser_color_for(color_space: &str, color_range: &str, height: i64) -> (&'static str, &'static str) {
    let matrix = match color_space {
        "bt709" => "bt709",
        "smpte170m" | "bt470bg" => "bt601",
        "bt2020nc" | "bt2020c" => "bt2020",
        "smpte240m" => "smpte240m",
        "fcc" => "fcc",
        _ if height >= 720 => "bt709",
        _ => "bt601",
    };
    let range = if matches!(color_range, "pc" | "jpeg") { "pc" } else { "tv" };
    (matrix, range)
}

fn probe_browser_color(ffprobe_path: &PathBuf, source_path: &str) -> (&'static str, &'static str) {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args(["-v", "quiet", "-select_streams", "v:0", "-show_entries", "stream=height,color_space,color_range", "-of", "json", source_path]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let stream = cmd
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
        .and_then(|v| v["streams"].get(0).cloned())
        .unwrap_or_default();
    browser_color_for(stream["color_space"].as_str().unwrap_or(""), stream["color_range"].as_str().unwrap_or(""), stream["height"].as_i64().unwrap_or(0))
}

// The YUV matrix a player will decode an untagged export of `frame_height` rows with - what a keyed
// layer's colours are converted back to (the same 720-row rule as browser_color_for).
fn output_matrix(frame_height: i64) -> &'static str {
    if frame_height >= 720 { "bt709" } else { "bt601" }
}

// Green/blue-screen keying - the filter fragment (no trailing comma) taking a source frame to
// straight-alpha rgba. The preview's shader (ChromaKeyCanvas.tsx) runs the same maths, checked
// against these filters in chromaKey.test.ts:
//   1. to RGB the way the webview decodes it (`source`: matrix, range), then full-range BT.601 YUV
//      4:4:4 - the space chromakey measures chroma in (it's chroma only, so shadows key too);
//   2. chromakey: alpha from the 3x3 neighbourhood's distance to the key colour's (U,V);
//   3. back to RGB, then despill: the screen channel pulled toward the average of the other two.
fn chroma_key_filters(k: &ChromaKeySpec, (matrix, range): (&str, &str)) -> String {
    let hex = u32::from_str_radix(k.color.trim().trim_start_matches('#'), 16).unwrap_or(0x00b140) & 0xff_ffff;
    let finite = |v: f64, d: f64| if v.is_finite() { v } else { d };
    let similarity = finite(k.similarity, 0.12).clamp(0.01, 1.0);
    let blend = finite(k.blend, 0.08).clamp(0.0, 1.0);
    let spill = finite(k.spill, 0.0).clamp(0.0, 1.0);
    let mut f = format!(
        "scale=in_color_matrix={matrix}:in_range={range},format=gbrp,scale=out_color_matrix=bt601:out_range=pc,format=yuv444p,\
         chromakey=color=0x{hex:06x}:similarity={similarity}:blend={blend},scale=in_color_matrix=bt601:in_range=pc,format=rgba"
    );
    if spill > 0.0 {
        // Blue screen when the key leans blue, as spillType (chromaKey.ts) decides.
        let (g, b) = ((hex >> 8) & 0xff, hex & 0xff);
        let (kind, green, blue) = if b > g { ("blue", 0.0, -spill) } else { ("green", -spill, 0.0) };
        f.push_str(&format!(",despill=type={kind}:mix=0.5:expand=0:red=0:green={green}:blue={blue}:brightness=0:alpha=0"));
    }
    f
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
fn pip_overlay_chain(
    pip: &PipOverlay,
    input_index: usize,
    stage_index: usize,
    current_label: &str,
    out_label: &str,
    // The final frame's size - needed to blend (blend_composite); None composites normally.
    frame: Option<(i64, i64)>,
) -> String {
    let duration = (pip.end_time - pip.start_time).max(0.01);
    let trim_end = pip.trim_start + duration;
    // Re-timed to start at the PiP's own start_time on the output timeline - starting it at 0 made
    // the overlay below (which takes the latest frame at or before each output moment) show the
    // wrong part of the source, or freeze on its last frame, whenever a PiP didn't start at 0:00.
    // A keyed layer is keyed at the source's own size (as the preview's shader keys the decoded
    // frame), scaled with its alpha premultiplied (as the browser scales it - no screen-coloured
    // fringe), and converted back to YUV with the matrix the export will be watched with.
    // A cut-out (background_removal.rs) already carries its alpha - tagged BT.709, as it was written.
    let alpha_source = if pip.cutout_path.is_some() {
        Some("scale=in_color_matrix=bt709:in_range=tv,format=rgba".to_string())
    } else {
        pip.chroma_key.as_ref().map(|k| chroma_key_filters(k, pip.source_color.unwrap_or(("bt601", "tv"))))
    };
    let (key, cover_scale, to_yuv) = match alpha_source {
        Some(to_rgba) => (
            format!("{to_rgba},"),
            format!("premultiply=inplace=1,scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},unpremultiply=inplace=1", w = pip.width, h = pip.height),
            format!(",scale=out_color_matrix={}:out_range=tv,format=yuva420p", output_matrix(frame.map_or(0, |(_, h)| h))),
        ),
        None => (String::new(), format!("scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}", w = pip.width, h = pip.height), String::new()),
    };
    let cover = format!(
        "trim=start={ts:.3}:end={te:.3},setpts=PTS-STARTPTS+{st:.4}/TB,{src_crop}{key}{cover_scale}{to_yuv}",
        ts = pip.trim_start, te = trim_end, st = pip.start_time, src_crop = pip_crop_fragment(pip.crop)
    );
    let shape = sanitize_pip_shape(&pip.shape);
    let video_label = format!("pip{}v", stage_index);

    let mut chain = String::new();
    // With a mask PNG (shape and mask together, from the frontend) or a key, the picture's own
    // alpha is kept and the mask multiplied into it; otherwise the shape is drawn here.
    let composited_label = if pip.mask_input.is_some() || pip.mask_motion_input.is_some() || pip.chroma_key.is_some() || pip.cutout_path.is_some() {
        chain.push_str(&format!("[{input_index}:v]{cover}[{video_label}];"));
        // A cut-out's background goes in behind the person first; shape and mask then cut both.
        let video_label = match (pip.cutout_path.as_ref(), pip.cutout_background.as_ref()) {
            (Some(_), Some(bg)) => {
                let out = format!("pip{stage_index}bgo");
                let bg_chain = cutout_background_chain(pip, bg, &video_label, &format!("pip{stage_index}"), &out);
                if bg_chain.is_empty() {
                    video_label
                } else {
                    chain.push_str(&bg_chain);
                    out
                }
            }
            _ => video_label,
        };
        let t = format!("pip{stage_index}k");
        // The mask to multiply in: the static shape/mask picture, the moving mask, or both.
        let still = pip.mask_input.map(|mask| {
            chain.push_str(&format!("[{mask}:v]format=gray,scale={w}:{h},setpts=PTS-STARTPTS+{st:.4}/TB[{t}m];", w = pip.width, h = pip.height, st = pip.start_time));
            format!("{t}m")
        });
        let moving = match (pip.mask_motion.as_ref(), pip.mask_motion_input) {
            (Some(motion), Some(input)) => {
                chain.push_str(&moving_mask_chain(pip, motion, input, &t, &format!("{t}mv")));
                Some(format!("{t}mv"))
            }
            _ => None,
        };
        let mask = match (still, moving) {
            (Some(a), Some(b)) => {
                chain.push_str(&format!("[{a}][{b}]blend=all_mode=multiply[{t}mb];"));
                Some(format!("{t}mb"))
            }
            (a, b) => a.or(b),
        };
        match mask {
            Some(mask) => {
                chain.push_str(&format!(
                    "[{video_label}]format=yuva420p,split=2[{t}c][{t}a0];[{t}a0]alphaextract[{t}a];[{t}a][{mask}]blend=all_mode=multiply[{t}ma];[{t}c][{t}ma]alphamerge[{t}out];"
                ));
                format!("{t}out")
            }
            None => video_label,
        }
    } else {
        match shape {
        "rectangle" => {
            chain.push_str(&format!("[{}:v]{}[{}];", input_index, cover, video_label));
            video_label
        }
        _ => {
            let mask_expr = if shape == "rounded" {
                let r = ((pip.corner_radius.unwrap_or(0.08).max(0.0).min(0.5)) * pip.height as f64)
                    .round() as i64;
                // Distance past the nearest corner circle's centre on each axis (0 anywhere along
                // the straight edges/interior) - opaque iff that point lies within radius r, i.e.
                // real quarter-circle corners matching the preview's CSS border-radius.
                format!(
                    "if(lte(pow(max(max({r}-X,X-(W-1-{r})),0),2)+pow(max(max({r}-Y,Y-(H-1-{r})),0),2),{r}*{r}),255,0)",
                    r = r.max(1)
                )
            } else {
                // Ellipse inscribed in the box (a true circle when the box is square) - matches the
                // preview's `ellipse(50% 50%)` clip-path, so a non-square box never gets cut into
                // the circle-wider-than-its-box shape a plain W/2 radius produced.
                "if(gt((X-W/2)^2/((W/2)^2)+(Y-H/2)^2/((H/2)^2),1),0,255)".to_string()
            };
            let alpha_label = format!("pip{}a", stage_index);
            let masked_label = format!("pip{}m", stage_index);
            // Reads the raw `-i`'d input twice (once per branch below) rather than an explicit
            // `split` - ffmpeg fans out a raw demuxed/decoded input stream reference on its own,
            // the same "{input}...{input}..." idiom overlay_stage_filter (recording.rs) already
            // relies on for exactly this shape-masking technique.
            chain.push_str(&format!(
                "[{idx}:v]{cover},geq=lum_expr='{mask_expr}',format=yuva420p[{alpha}];",
                idx = input_index,
                cover = cover,
                mask_expr = mask_expr,
                alpha = alpha_label
            ));
            chain.push_str(&format!(
                "[{idx}:v]{cover}[{video}];",
                idx = input_index,
                cover = cover,
                video = video_label
            ));
            chain.push_str(&format!(
                "[{video}][{alpha}]alphamerge[{masked}];",
                video = video_label,
                alpha = alpha_label,
                masked = masked_label
            ));
            masked_label
        }
        }
    };

    let composited_label = pip_alpha_stage(pip, stage_index, composited_label, &mut chain);

    if let (Some(mode), Some(frame)) = (pip.blend_mode.as_deref().and_then(blend_mode_ffmpeg), frame) {
        let layer = BlendLayer { label: &composited_label, x: pip.x.to_string(), y: pip.y.to_string(), width: pip.width, height: pip.height, moving: false, fps: PIP_BLEND_FPS };
        chain.push_str(&blend_composite(current_label, &layer, frame, mode, pip.start_time, pip.end_time, &format!("pipb{stage_index}"), out_label));
        return chain;
    }
    chain.push_str(&format!(
        "[{current}][{composited}]overlay=x={x}:y={y}:enable='between(t,{start:.3},{end:.3})'[{out}];",
        current = current_label, composited = composited_label, x = pip.x, y = pip.y, start = pip.start_time, end = pip.end_time, out = out_label
    ));
    chain
}

// A layer's opacity and fade in/out: its alpha scaled, the fades as linear ramps over its own
// (re-timed) frames - the same curve layerOpacityAt (videoTracks.ts) draws in the preview. Returns
// the label to composite (`label` itself when there's nothing to do).
fn pip_alpha_stage(pip: &PipOverlay, stage_index: usize, label: String, chain: &mut String) -> String {
    let opacity = pip.opacity.unwrap_or(1.0);
    let opacity = if opacity.is_finite() { opacity.clamp(0.0, 1.0) } else { 1.0 };
    let half = ((pip.end_time - pip.start_time) / 2.0).max(0.0);
    let fade_in = if pip.fade_in.is_finite() { pip.fade_in.clamp(0.0, half) } else { 0.0 };
    let fade_out = if pip.fade_out.is_finite() { pip.fade_out.clamp(0.0, half) } else { 0.0 };
    if opacity >= 0.999 && fade_in < 0.001 && fade_out < 0.001 {
        return label;
    }
    // On the alpha plane alone - format=yuva420p only adds one (opaque) to a layer without, and
    // leaves its colours as they are.
    let mut filters = vec!["format=yuva420p".to_string()];
    if opacity < 0.999 {
        filters.push(format!("lut=a='val*{opacity:.4}'"));
    }
    if fade_in >= 0.001 {
        filters.push(format!("fade=t=in:st={:.4}:d={fade_in:.4}:alpha=1", pip.start_time));
    }
    if fade_out >= 0.001 {
        filters.push(format!("fade=t=out:st={:.4}:d={fade_out:.4}:alpha=1", pip.end_time - fade_out));
    }
    let out = format!("pip{stage_index}o");
    chain.push_str(&format!("[{label}]{}[{out}];", filters.join(",")));
    out
}

// ---- Blend modes -------------------------------------------------------------------------------
//
// An overlay with a CSS mix-blend-mode (the preview sets it on the overlay's element, over the
// video) is composited the way the W3C compositing spec defines: the blend function B(backdrop,
// source) per RGB channel, then mixed over the backdrop by the layer's alpha -
// result = backdrop + alpha * (B - backdrop). The blend runs in planar RGB (gbrp), where every
// mode below was measured against the spec's formula on all 65,536 8-bit pairs: within 2 levels
// (most exact). Soft light (31 dB off) and dodge/burn (wrong at the extremes) aren't offered.
// The backdrop is blend's TOP input - overlay/hard-light are only the spec's with it that way round.
fn blend_mode_ffmpeg(mode: &str) -> Option<&'static str> {
    match mode {
        "multiply" => Some("multiply"),
        "screen" => Some("screen"),
        "overlay" => Some("overlay"),
        "hard-light" => Some("hardlight"),
        "darken" => Some("darken"),
        "lighten" => Some("lighten"),
        "difference" => Some("difference"),
        "exclusion" => Some("exclusion"),
        // CSS plus-lighter: min(1, alpha*source + backdrop) - an add of the premultiplied layer.
        "plus-lighter" => Some("addition"),
        _ => None,
    }
}

// A PiP's own frames are sampled onto its blend canvas at up to this rate (a source faster than
// the canvas would otherwise lose frames there).
const PIP_BLEND_FPS: f64 = 60.0;

// The layer blend_composite blends: an rgba stream of width x height, at (x, y) of the frame
// (ffmpeg expressions in `t`, overlay_w/overlay_h and W/H when `moving`), timed in absolute
// output seconds.
struct BlendLayer<'a> {
    label: &'a str,
    x: String,
    y: String,
    width: i64,
    height: i64,
    // Position changes over time: the blend then covers the whole frame instead of the layer's box.
    moving: bool,
    // Rate the layer is drawn onto its canvas at.
    fps: f64,
}

// Composites `layer` onto [current] with blend `mode` over [start, end], writing [out]. Only the
// layer's own box is touched (for a still one; the frame for a moving one) - the rest passes
// through untouched, never round-tripped through RGB.
#[allow(clippy::too_many_arguments)]
fn blend_composite(current: &str, layer: &BlendLayer, (fw, fh): (i64, i64), mode: &str, start: f64, end: f64, tag: &str, out: &str) -> String {
    // The box, clamped to the frame and widened to even edges: 4:2:0 chroma can only be cropped on
    // even pixels, so an odd edge would shift the backdrop half a chroma sample against the layer.
    let (rx, ry, rw, rh) = if layer.moving {
        (0, 0, fw, fh)
    } else {
        let (x, y) = (layer.x.parse::<i64>().unwrap_or(0), layer.y.parse::<i64>().unwrap_or(0));
        let x0 = x.clamp(0, fw) & !1;
        let y0 = y.clamp(0, fh) & !1;
        let x1 = ((x + layer.width).clamp(0, fw) + 1) & !1;
        let y1 = ((y + layer.height).clamp(0, fh) + 1) & !1;
        (x0, y0, (x1.min(fw) - x0).max(2), (y1.min(fh) - y0).max(2))
    };
    let (lx, ly) = if layer.moving {
        (layer.x.clone(), layer.y.clone())
    } else {
        ((layer.x.parse::<i64>().unwrap_or(0) - rx).to_string(), (layer.y.parse::<i64>().unwrap_or(0) - ry).to_string())
    };
    let dur = (end - start).max(0.01);
    let add = mode == "addition";
    // The layer's straight colour (premultiplied for an add) and its alpha - an add's result is
    // already final wherever the layer covers anything, so its mask is just "covered or not".
    let colour = if add { "format=gbrap,premultiply=inplace=1,format=gbrp" } else { "format=gbrp" };
    let alpha = if add { "alphaextract,lut=c0='if(gt(val,0),255,0)'" } else { "alphaextract" };
    format!(
        "color=c=black@0:s={rw}x{rh}:r={fps:.3}:d={d:.3},format=rgba,setpts=PTS+{start:.4}/TB[{tag}cv];\
         [{tag}cv][{layer}]overlay=x='{lx}':y='{ly}':format=auto:eof_action=pass[{tag}ly];\
         [{tag}ly]split=2[{tag}lc0][{tag}la0];[{tag}lc0]{colour}[{tag}lc];[{tag}la0]{alpha}[{tag}la];\
         [{current}]split=2[{tag}bg][{tag}bd0];\
         [{tag}bd0]trim=start={start:.4}:end={end:.4},crop={rw}:{rh}:{rx}:{ry},format=gbrp[{tag}bd];\
         [{tag}bd][{tag}lc]blend=all_mode={mode}:shortest=1,format=gbrap[{tag}bl];\
         [{tag}bl][{tag}la]alphamerge[{tag}bm];\
         [{tag}bg][{tag}bm]overlay=x={rx}:y={ry}:eof_action=pass:format=auto[{out}];",
        fps = layer.fps,
        d = dur + 0.1,
        layer = layer.label,
    )
}

// ---- Gaussian blur -----------------------------------------------------------------------------
//
// CSS blur(sigma) - what the preview's backdrop-filter draws - as three box blurs whose widths are
// chosen (Kovesi's method) so their combined variance is sigma^2: within 1% of sigma and a few % of
// the Gaussian's shape, and O(1) per pixel at any radius. ffmpeg's gblur was measured first: its
// IIR approximation was 7-77% off the Gaussian depending on `steps`. Chroma is half-resolution in
// 4:2:0, so its planes get sigma/2 - a blur of Y, Cb and Cr is then exactly a blur of RGB.
fn box_widths_for_sigma(sigma: f64, passes: usize) -> Vec<i64> {
    let n = passes as f64;
    let ideal = (12.0 * sigma * sigma / n + 1.0).sqrt();
    let mut wl = ideal.floor() as i64;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wl = wl.max(1);
    let wu = wl + 2;
    // How many passes use the narrower box: whichever split lands the combined sigma closest
    // (Kovesi's closed form rounds, which can miss by a few % at small sigmas).
    let sigma_with = |m: usize| (((m as f64) * (wl * wl - 1) as f64 + ((passes - m) as f64) * (wu * wu - 1) as f64) / 12.0).sqrt();
    let m = (0..=passes).min_by(|a, b| (sigma_with(*a) - sigma).abs().total_cmp(&(sigma_with(*b) - sigma).abs())).unwrap_or(passes);
    (0..passes).map(|i| if i < m { wl } else { wu }).collect()
}

// The filter fragment (no leading/trailing comma, "" when there's nothing to blur) blurring a
// `w`x`h` yuv420p stream by `sigma` px. Radii are clamped to what boxblur allows on that size.
fn gaussian_blur_chain(sigma: f64, w: i64, h: i64, enable: Option<&str>) -> String {
    if !(sigma > 0.25) {
        return String::new();
    }
    let luma = box_widths_for_sigma(sigma, 3);
    let chroma = box_widths_for_sigma(sigma / 2.0, 3);
    let max_luma = (w.min(h) / 2 - 1).max(0);
    let max_chroma = (((w + 1) / 2).min((h + 1) / 2) / 2 - 1).max(0);
    let enable = enable.map(|e| format!(":enable='{e}'")).unwrap_or_default();
    luma.iter()
        .zip(&chroma)
        .map(|(wl, wc)| (((wl - 1) / 2).min(max_luma), ((wc - 1) / 2).min(max_chroma)))
        .filter(|(rl, rc)| *rl > 0 || *rc > 0)
        .map(|(rl, rc)| format!("boxblur=luma_radius={rl}:luma_power=1:chroma_radius={rc}:chroma_power=1{enable}"))
        .collect::<Vec<_>>()
        .join(",")
}

// One blur region onto [current], writing [out]: its patch of the picture cut out for its own
// window, blurred, shaped by its mask (when it has one) and laid back where it came from.
fn blur_region_chain(bv: &OverlayBlur, i: usize, mask_input: Option<usize>, current: &str, out_label: &str) -> String {
    let mut graph = String::new();
    let src_label = format!("bb{}src", i);
    let bg_label = format!("bb{}bg", i);
    // The blurred copy only exists for the region's own window (trim), so nothing is
    // cropped or blurred for the rest of the video.
    graph.push_str(&format!(
        "[{}]split=2[{}][{}];",
        current, bg_label, src_label
    ));
    // Where the region is: fixed, or keyframed (a motion track) - on even pixels either
    // way (4:2:0 chroma crops on even pixels), kept inside the frame, and the same
    // expression for the crop and the overlay so the blurred patch lands where it was cut.
    let (x_expr, y_expr) = match bv.keyframes.as_ref().filter(|k| !k.is_empty()) {
        Some(kfs) => (keyframe_expr(kfs, "t", |k| k.x), keyframe_expr(kfs, "t", |k| k.y)),
        None => (bv.x.to_string(), bv.y.to_string()),
    };
    let crop_x = format!("clip(2*floor(({x_expr})/2),0,iw-ow)");
    let crop_y = format!("clip(2*floor(({y_expr})/2),0,ih-oh)");
    let place_x = format!("clip(2*floor(({x_expr})/2),0,main_w-overlay_w)");
    let place_y = format!("clip(2*floor(({y_expr})/2),0,main_h-overlay_h)");
    // The preview's Gaussian (CSS blur(sigma)); an older frontend sends only intensity,
    // which keeps the boxblur it always had.
    let blur = match bv.sigma {
        Some(sigma) => gaussian_blur_chain(sigma, bv.width, bv.height, None),
        None => {
            let radius = ((bv.intensity.max(0.0).min(1.0)) * (bv.height as f64) * 0.08).round().clamp(1.0, 60.0) as i64;
            format!("boxblur=luma_radius={radius}:luma_power=1:chroma_radius={radius}:chroma_power=1")
        }
    };
    let blur = if blur.is_empty() { "null".to_string() } else { blur };
    let cut = format!(
        "[{src_label}]trim=start={:.4}:end={:.4},crop=w={}:h={}:x='{crop_x}':y='{crop_y}',{blur}",
        bv.start_time, bv.end_time, bv.width, bv.height
    );

    // A plain axis-aligned rectangle needs nothing past the crop+blur - crop already
    // produces exactly that shape. Anything mask-shaped merges the mask PNG's luma in as
    // the blurred patch's alpha (`alphamerge`), so only the shape stays blurred and the
    // rest of the crop shows the original pixels once `overlay` blends by alpha below.
    let composited_label = match mask_input {
        None => {
            let blurred_label = format!("bb{}blur", i);
            graph.push_str(&format!("{cut}[{blurred_label}];"));
            blurred_label
        }
        Some(mask_input) => {
            let cropped_label = format!("bb{}crop", i);
            let mask_gray_label = format!("bb{}maskgray", i);
            let masked_label = format!("bb{}masked", i);
            graph.push_str(&format!("{cut},format=rgba[{cropped_label}];"));
            graph.push_str(&format!(
                "[{}:v]format=gray,setpts=PTS-STARTPTS+{:.4}/TB[{}];",
                mask_input, bv.start_time, mask_gray_label
            ));
            graph.push_str(&format!(
                "[{}][{}]alphamerge[{}];",
                cropped_label, mask_gray_label, masked_label
            ));
            masked_label
        }
    };

    graph.push_str(&format!(
        "[{bg_label}][{composited_label}]overlay=x='{place_x}':y='{place_y}':eof_action=pass[{out_label}];"
    ));
    graph
}

// ---- Adjustment layers -------------------------------------------------------------------------

fn css_op_from_spec(spec: &CssOpSpec) -> Option<CssColorOp> {
    let v = spec.value;
    if !v.is_finite() {
        return None;
    }
    Some(match spec.op.as_str() {
        "brightness" => CssColorOp::Brightness(v),
        "contrast" => CssColorOp::Contrast(v),
        "saturate" => CssColorOp::Saturate(v),
        "hue-rotate" => CssColorOp::HueRotate(v),
        "sepia" => CssColorOp::Sepia(v),
        "grayscale" => CssColorOp::Grayscale(v),
        _ => return None,
    })
}

// One adjustment layer onto [current], writing [out]. The adjusted copy is cut to the layer's
// window and box (trim + crop) so nothing outside either is ever processed, then laid back over
// the untouched picture - weighted by its mask, opacity and fades.
#[allow(clippy::too_many_arguments)]
fn adjustment_layer_chain(layer: &AdjustmentLayerSpec, mask_input: Option<(usize, i64, i64)>, (fw, fh): (i64, i64), current: &str, tag: &str, out: &str) -> String {
    // The frontend renders the mask on even edges inside the frame (4:2:0 chroma can only be
    // cropped on even pixels); kept that way here whatever arrives, the mask scaled to match.
    let moving = mask_input.is_some() && layer.mask_keyframes.as_ref().is_some_and(|k| !k.is_empty());
    let (rx, ry, rw, rh) = match mask_input {
        // A moving region works on the whole frame, its mask placed afresh every frame.
        Some(_) if moving => (0, 0, fw, fh),
        Some((_, mw, mh)) => {
            let x0 = layer.mask_x.clamp(0, (fw - 2).max(0)) & !1;
            let y0 = layer.mask_y.clamp(0, (fh - 2).max(0)) & !1;
            (x0, y0, (mw.min(fw - x0) & !1).max(2), (mh.min(fh - y0) & !1).max(2))
        }
        None => (0, 0, fw, fh),
    };
    let (start, end) = (layer.start_time, layer.end_time.max(layer.start_time + 0.01));
    let mut fx: Vec<String> = vec![format!("trim=start={start:.4}:end={end:.4}")];
    if mask_input.is_some() && !moving {
        fx.push(format!("crop={rw}:{rh}:{rx}:{ry}"));
    }
    let blur = gaussian_blur_chain(layer.blur_sigma.unwrap_or(0.0), rw, rh, None);
    if !blur.is_empty() {
        fx.push(blur);
    }
    let ops: Vec<CssColorOp> = layer.color_ops.iter().filter_map(css_op_from_spec).collect();
    fx.push("format=rgba".into());
    if !ops.is_empty() {
        let (m, o) = compose_css_color_ops(&ops);
        fx.push(format!(
            "colorchannelmixer=rr={:.6}:rg={:.6}:rb={:.6}:ra={:.6}:gr={:.6}:gg={:.6}:gb={:.6}:ga={:.6}:br={:.6}:bg={:.6}:bb={:.6}:ba={:.6}:aa=1",
            m[0][0], m[0][1], m[0][2], o[0], m[1][0], m[1][1], m[1][2], o[1], m[2][0], m[2][1], m[2][2], o[2]
        ));
    }
    if let Some(hex) = layer.fill.as_deref().map(|c| c.trim().trim_start_matches('#')).and_then(|c| u32::from_str_radix(c, 16).ok()) {
        // Every pixel the colour: no input weights, the colour as the offset (on the alpha column).
        let (r, g, b) = (((hex >> 16) & 255) as f64 / 255.0, ((hex >> 8) & 255) as f64 / 255.0, (hex & 255) as f64 / 255.0);
        fx.push(format!("colorchannelmixer=rr=0:rg=0:rb=0:ra={r:.6}:gr=0:gg=0:gb=0:ga={g:.6}:br=0:bg=0:bb=0:ba={b:.6}:aa=1"));
    }
    let mut graph = format!("[{current}]split=2[{tag}bg][{tag}src];[{tag}src]{}[{tag}a0];", fx.join(","));
    let mut cur = format!("{tag}a0");
    if let Some(v) = layer.vignette.filter(|v| *v > 0.001) {
        // Drawn over the adjusted picture, as the preview's gradient sits on top of its backdrop.
        graph.push_str(&vignette_layer(v, rw, rh, 30.0, &cur, &format!("{tag}a1"), tag));
        graph.push_str(&format!("[{tag}a1]format=rgba[{tag}a2];"));
        cur = format!("{tag}a2");
    }
    if let Some((input, _, _)) = mask_input {
        if moving {
            // The region's mask pasted onto black where the keyframes put it, every frame (the
            // keyframe expressions blur regions use), inverted for a spotlight.
            let kfs = layer.mask_keyframes.as_deref().unwrap_or(&[]);
            let (kx, ky) = (keyframe_expr(kfs, "t", |k| k.x), keyframe_expr(kfs, "t", |k| k.y));
            let negate = if layer.mask_invert { ",negate" } else { "" };
            graph.push_str(&format!(
                "color=c=black:s={fw}x{fh}:r={OVERLAY_INPUT_FPS}:d={d:.3},setpts=PTS+{start:.4}/TB,format=yuv420p[{tag}mc];\
                 [{input}:v]format=yuv420p,setpts=PTS-STARTPTS+{start:.4}/TB[{tag}mp];\
                 [{tag}mc][{tag}mp]overlay=x='{kx}':y='{ky}':eof_action=repeat,format=gray{negate}[{tag}mk];[{cur}][{tag}mk]alphamerge[{tag}a3];",
                d = end - start + 0.1
            ));
        } else {
            graph.push_str(&format!(
                "[{input}:v]format=gray,scale={rw}:{rh},setpts=PTS-STARTPTS+{start:.4}/TB[{tag}mk];[{cur}][{tag}mk]alphamerge[{tag}a3];"
            ));
        }
        cur = format!("{tag}a3");
    }
    let mut alpha_ops: Vec<String> = Vec::new();
    let opacity = layer.opacity.clamp(0.0, 1.0);
    if opacity < 0.999 {
        alpha_ops.push(format!("colorchannelmixer=aa={opacity:.4}"));
    }
    let span = end - start;
    let fade_in = layer.fade_in.clamp(0.0, span / 2.0);
    let fade_out = layer.fade_out.clamp(0.0, span / 2.0);
    if fade_in > 0.01 {
        alpha_ops.push(format!("fade=in:st={start:.4}:d={fade_in:.4}:alpha=1"));
    }
    if fade_out > 0.01 {
        alpha_ops.push(format!("fade=out:st={:.4}:d={fade_out:.4}:alpha=1", end - fade_out));
    }
    if !alpha_ops.is_empty() {
        graph.push_str(&format!("[{cur}]{}[{tag}a4];", alpha_ops.join(",")));
        cur = format!("{tag}a4");
    }
    graph.push_str(&format!("[{tag}bg][{cur}]overlay=x={rx}:y={ry}:eof_action=pass:format=auto[{out}];"));
    graph
}

// Per-segment color grade fragment, chained directly onto that segment's own trim step (before
// concat). Formulas are deliberately simple/approximate (not colorimetrically "correct") - a
// quick preset gallery, not a grading tool - and are meant to visually match their CSS-preview
// counterpart (cssFilterForColorPreset, src/utils/videoColorFilters.ts); if one is retuned, retune
// the other so preview and export don't silently drift apart. Empty string (no-op) for
// "none"/unrecognized so callers can unconditionally append the result without an extra branch.
//
// Exactly the preview's look: each preset is the same list of CSS filter functions the preview
// applies (cssFilterForColorPreset), and every one of them is defined by the Filter Effects spec as
// a fixed colour matrix (contrast as an affine scale about 0.5). The list composes into ONE affine
// map, applied in a single colorchannelmixer pass - the offset rides on the alpha column (alpha is
// 255 in rgba, so ra/ga/ba are a per-channel offset). Nothing here is tuned "to look similar": it
// is the same arithmetic the browser does. "vignette" isn't a colour map - see vignette_layer.
fn color_filter_chain(cf: &ClipColorFilter) -> String {
    let t = cf.intensity.clamp(0.0, 1.0);
    let ops: Vec<CssColorOp> = match cf.preset.as_str() {
        "vibrant" => vec![CssColorOp::Saturate(1.0 + 0.6 * t), CssColorOp::Contrast(1.0 + 0.15 * t)],
        "cinematic" => vec![
            CssColorOp::Contrast(1.0 + 0.2 * t),
            CssColorOp::Saturate(1.0 - 0.15 * t),
            CssColorOp::Sepia(0.08 * t),
            CssColorOp::HueRotate(-5.0),
        ],
        "bw" => vec![CssColorOp::Grayscale(t)],
        "warm" => vec![CssColorOp::Sepia(0.35 * t), CssColorOp::Saturate(1.0 + 0.1 * t)],
        "cool" => vec![CssColorOp::HueRotate(10.0 * t), CssColorOp::Saturate(1.0 + 0.05 * t)],
        _ => return String::new(),
    };
    let (m, o) = compose_css_color_ops(&ops);
    format!(
        ",format=rgba,colorchannelmixer=rr={:.6}:rg={:.6}:rb={:.6}:ra={:.6}:gr={:.6}:gg={:.6}:gb={:.6}:ga={:.6}:br={:.6}:bg={:.6}:bb={:.6}:ba={:.6}:aa=1,format=yuv420p",
        m[0][0], m[0][1], m[0][2], o[0], m[1][0], m[1][1], m[1][2], o[1], m[2][0], m[2][1], m[2][2], o[2]
    )
}

// One CSS filter function on colour (Filter Effects Module, "filter functions" - their SVG
// feColorMatrix equivalents).
#[derive(Clone, Copy, Debug)]
pub(crate) enum CssColorOp {
    Brightness(f64),
    Grayscale(f64),
    Sepia(f64),
    Saturate(f64),
    HueRotate(f64), // degrees
    Contrast(f64),
}

impl CssColorOp {
    // (matrix, offset) on 0..1 RGB.
    fn affine(self) -> ([[f64; 3]; 3], [f64; 3]) {
        match self {
            CssColorOp::Brightness(b) => {
                let b = b.max(0.0);
                ([[b, 0.0, 0.0], [0.0, b, 0.0], [0.0, 0.0, b]], [0.0; 3])
            }
            CssColorOp::Grayscale(a) => {
                let s = 1.0 - a.clamp(0.0, 1.0);
                ([[0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s], [0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s], [0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s]], [0.0; 3])
            }
            CssColorOp::Sepia(a) => {
                let s = 1.0 - a.clamp(0.0, 1.0);
                ([[0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s], [0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s], [0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s]], [0.0; 3])
            }
            CssColorOp::Saturate(s) => {
                let s = s.max(0.0);
                ([[0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s], [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s], [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]], [0.0; 3])
            }
            CssColorOp::HueRotate(deg) => {
                let (s, c) = deg.to_radians().sin_cos();
                (
                    [
                        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
                        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
                        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
                    ],
                    [0.0; 3],
                )
            }
            CssColorOp::Contrast(c) => {
                let c = c.max(0.0);
                ([[c, 0.0, 0.0], [0.0, c, 0.0], [0.0, 0.0, c]], [0.5 - 0.5 * c; 3])
            }
        }
    }
}

// The filter list applied left to right, as one affine map: x -> M x + o.
pub(crate) fn compose_css_color_ops(ops: &[CssColorOp]) -> ([[f64; 3]; 3], [f64; 3]) {
    let mut m = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut o = [0.0; 3];
    for op in ops {
        let (a, b) = op.affine();
        let mut nm = [[0.0; 3]; 3];
        let mut no = [0.0; 3];
        for r in 0..3 {
            for c in 0..3 {
                nm[r][c] = (0..3).map(|k| a[r][k] * m[k][c]).sum();
            }
            no[r] = (0..3).map(|k| a[r][k] * o[k]).sum::<f64>() + b[r];
        }
        m = nm;
        o = no;
    }
    (m, o)
}

// Where a segment's video chain should end, and what follows it: a vignette preset puts its layer
// between the chain and `label` (vignette_layer, over the clip's finished frame as the preview
// draws it); anything else ends straight at `label`.
//
// A clip effect (Clip.fx) goes first, over the clip's picture, with the vignette over it - the order
// the preview's ClipFxLayer draws them in.
fn segment_vignette(seg: &KeepSegment, w: Option<i64>, h: Option<i64>, label: &str, i: usize) -> (String, String) {
    let (vig_in, vig_graph) = match (&seg.color_filter, w, h) {
        (Some(cf), Some(w), Some(h)) if cf.preset == "vignette" => {
            let pre = format!("{label}nv");
            (pre.clone(), vignette_layer(cf.intensity, w, h, 30.0, &pre, label, i))
        }
        _ => (label.to_string(), String::new()),
    };
    if let (Some(fx), Some(w), Some(h)) = (&seg.fx, w, h) {
        let pre = format!("{label}fx");
        // Its own length plus room for a transition's tail.
        if let Some(fx_graph) = clip_fx_graph(fx, &pre, &vig_in, (w, h), segment_output_duration(seg) + 2.0, i) {
            return (pre, format!("{fx_graph}{vig_graph}"));
        }
    }
    (vig_in, vig_graph)
}

// The "vignette" preset: the preview's radial-gradient(ellipse at center, transparent s0%,
// rgba(0,0,0,0.6t) 100%) laid over the clip's finished frame (vignetteBackground,
// videoColorFilters.ts) - drawn once, small, scaled up (a smooth gradient loses nothing) and looped
// as a static layer, so it costs one overlay per frame. A graph fragment taking [in] to [out].
fn vignette_layer(intensity: f64, w: i64, h: i64, fps: f64, input: &str, out: &str, i: impl std::fmt::Display) -> String {
    let t = intensity.clamp(0.0, 1.0);
    let s0 = (40.0 - 15.0 * t) / 100.0;
    // Distance from the centre on the ellipse through the corners (CSS's default farthest-corner).
    let r = "(hypot(X/W-0.5,Y/H-0.5)*1.414214)";
    let alpha = format!("255*{:.4}*clip(({r}-{s0:.4})/{:.4},0,1)", 0.6 * t, (1.0 - s0).max(1e-3));
    let (lw, lh) = ((w / 4).max(2), (h / 4).max(2));
    format!(
        "color=black:s={lw}x{lh}:d=1:r={fps:.3},format=yuva420p,geq=lum=16:cb=128:cr=128:a='{alpha}',scale={w}:{h}:flags=bilinear,loop=loop=-1:size=1[vig{i}];\
         [{input}][vig{i}]overlay=shortest=1:format=auto[{out}];"
    )
}

// Per-segment Ken Burns fragment - a time-varying `crop` (using ffmpeg's own `t`/`iw`/`ih`/`ow`/
// `oh` expression variables - the same "expression string, not a filter option" idiom the
// enable='between(t,...)' chains elsewhere in this file already rely on), then a fixed `scale=`
// back to the export's own output resolution. The trailing scale is required, not cosmetic:
// concat needs every segment at matching resolution, and a shrinking crop window alone would
// leave this segment's frames smaller than its neighbors'. Chosen over ffmpeg's `zoompan` filter
// deliberately - zoompan's own output-size handling is more version-sensitive across ffmpeg
// builds than crop's plain expression support, and this only needs to spike-test cleanly once.
//
// The window - a zoom and centre (fractions of the frame) over time - is kenBurnsWindow's
// (videoColorFilters.ts) arithmetic exactly, preset for preset. It's drawn with `perspective`
// mapping the window's corners to the frame: per-frame and sub-pixel, so a slow push or a shake
// glides instead of stepping a whole pixel at a time. (crop can't do it: its width/height are
// evaluated once at setup - every zoom used to export frozen at one size.) perspective only knows
// the frame number, so the stream is first held to a constant `fps` (the source's own rate):
// seconds = n / fps, exactly, even for a variable-frame-rate phone video.
fn ken_burns_chain(kb: &ClipKenBurns, duration: f64, out_w: i64, out_h: i64, fps: f64) -> String {
    let a = kb.intensity.unwrap_or(0.5).clamp(0.0, 1.0);
    let d = duration.max(0.01);
    let fps = if fps.is_finite() && fps > 0.0 { fps } else { 30.0 };
    let (s0, s1) = match kb.span {
        Some([x, y]) => (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)),
        None => (0.0, 1.0),
    };
    // p: 0..1 along the whole move; t: seconds along it (a split-off piece continues its clock).
    // perspective's `in` counts frames from 1.
    let p = format!("({s0:.6}+{:.6}*min((in-1)/{fps:.4}/{d:.4},1))", s1 - s0);
    let t = format!("({p}*{:.6})", d / (s1 - s0).max(1e-3));
    let tx = kb.target_x.unwrap_or(0.5).clamp(0.0, 1.0);
    let ty = kb.target_y.unwrap_or(0.5).clamp(0.0, 1.0);
    let tau = std::f64::consts::TAU;
    let wobble = |f: f64, ph: f64| {
        format!(
            "(0.5*sin({:.6}*{t}+{ph})+0.3*sin({:.6}*{t}+{:.4})+0.2*sin({:.6}*{t}+{:.4}))",
            tau * 1.1 * f,
            tau * 2.3 * f,
            1.3 + ph,
            tau * 4.7 * f,
            2.1 + ph
        )
    };
    // (zoom, centre x, centre y) as expressions.
    let (z, cx, cy): (String, String, String) = match kb.preset.as_str() {
        "zoom-in" => (format!("(1+{:.4}*{p})", 0.3 * a), tx.to_string(), ty.to_string()),
        "zoom-out" => (format!("({:.4}-{:.4}*{p})", 1.0 + 0.3 * a, 0.3 * a), tx.to_string(), ty.to_string()),
        "pan-left" | "pan-right" | "pan-up" | "pan-down" => {
            let z = 1.0 + 0.15 * a;
            let dir = if matches!(kb.preset.as_str(), "pan-right" | "pan-down") { p.clone() } else { format!("(1-{p})") };
            let along = format!("({:.6}*{dir}+{:.6})", 1.0 - 1.0 / z, 1.0 / (2.0 * z));
            if kb.preset.starts_with("pan-l") || kb.preset.starts_with("pan-r") {
                (format!("{z:.4}"), along, "0.5".into())
            } else {
                (format!("{z:.4}"), "0.5".into(), along)
            }
        }
        "push" => (format!("(1+{:.4}*{p}*{p}*(3-2*{p}))", 0.3 * a), tx.to_string(), ty.to_string()),
        "punch-in" => {
            let c = format!("(clip({t}/0.35,0,1)-1)");
            (format!("(1+{:.4}*(1+2.70158*pow({c},3)+1.70158*pow({c},2)))", 0.4 * a), tx.to_string(), ty.to_string())
        }
        "bounce-in" => {
            let c = format!("clip({t}/1.2,0,1)");
            (format!("(1+{:.4}*(1-exp(-6*{c})*cos({:.6}*{c})))", 0.3 * a, 3.0 * tau), tx.to_string(), ty.to_string())
        }
        "drift" => {
            let z = 1.0 + 0.2 * a;
            let along = format!("({:.6}+{:.6}*{p})", 1.0 / (2.0 * z), 1.0 - 1.0 / z);
            (format!("{z:.4}"), along.clone(), along)
        }
        "sway" => {
            let z = 1.0 + 0.12 * a;
            (format!("{z:.4}"), format!("(0.5+{:.6}*sin({:.6}*{t}))", 0.48 * (1.0 - 1.0 / z), tau / 2.5), "0.5".into())
        }
        "float" => {
            let z = 1.0 + 0.14 * a;
            let r = 0.45 * (1.0 - 1.0 / z);
            (format!("{z:.4}"), format!("(0.5+{r:.6}*cos({:.6}*{t}))", tau / 4.0), format!("(0.5+{r:.6}*sin({:.6}*{t}))", tau / 4.0))
        }
        "breathe" => (format!("(1+{:.4}*(0.5-0.5*cos({:.6}*{t})))", 0.12 * a, tau / 3.0), tx.to_string(), ty.to_string()),
        "pulse" => (format!("(1+{:.4}*pow(0.5+0.5*cos({:.6}*{t}),6))", 0.1 * a, tau / 0.5), tx.to_string(), ty.to_string()),
        "shake" | "vibrate" => {
            let fast = kb.preset == "vibrate";
            let z = 1.0 + if fast { 0.02 + 0.04 * a } else { 0.03 + 0.07 * a };
            let m = 0.45 * (1.0 - 1.0 / z);
            let f = if fast { KB_VIBRATE_RATE } else { 1.0 };
            (format!("{z:.4}"), format!("(0.5+{m:.6}*{})", wobble(f, 0.0)), format!("(0.5+{m:.6}*{})", wobble(f, 4.1)))
        }
        _ => return String::new(),
    };
    // The window kept fully on the frame, then its corners (source pixels) sent to the frame's.
    let half = format!("(0.5/{z})");
    let cx = format!("clip({cx},{half},1-{half})");
    let cy = format!("clip({cy},{half},1-{half})");
    let (l, r) = (format!("(({cx})-{half})*W"), format!("(({cx})+{half})*W"));
    let (top, bot) = (format!("(({cy})-{half})*H"), format!("(({cy})+{half})*H"));
    format!(
        ",fps={fps:.4},perspective=x0='{l}':y0='{top}':x1='{r}':y1='{top}':x2='{l}':y2='{bot}':x3='{r}':y3='{bot}':interpolation=cubic:sense=source:eval=frame,scale={out_w}:{out_h}"
    )
}

// How much faster "vibrate"'s wobble runs than "shake"'s - KB_VIBRATE_RATE in videoColorFilters.ts.
const KB_VIBRATE_RATE: f64 = 5.0;

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
// This segment's own playback-speed multiplier, clamped defensively to the same 0.25..16 range the
// clip-effects UI itself offers (SpeedPopover's MIN_SPEED/MAX_SPEED) - a value outside that
// couldn't have come from that slider, but clamping here (rather than trusting it) means a stale/
// hand-edited sidecar can't push the setpts/atempo math into something degenerate.
fn segment_speed(seg: &KeepSegment) -> f64 {
    seg.speed.unwrap_or(1.0).max(0.25).min(16.0)
}

// This segment's own noise-reduction strength (0..1, clamped defensively same as segment_speed's
// own comment explains) mapped to just afftdn's `nr` parameter half of noise_reduction_afftdn_params
// - kept as its own function since it's the half segment_needs_filter_graph and the existing test
// suite already key off of (an (nr, nf) tuple would make ".is_some()" checks awkward for no
// benefit). See noise_reduction_afftdn_params for the actual mapping and why `nf` matters just as
// much as `nr` does.
fn segment_noise_reduction_db(seg: &KeepSegment) -> Option<f64> {
    segment_noise_reduction_params(seg).map(|(nr, _nf)| nr)
}

fn segment_noise_reduction_params(seg: &KeepSegment) -> Option<(f64, f64)> {
    noise_reduction_afftdn_params(seg.noise_reduction)
}

// The actual 0..1 -> afftdn (nr, nf) mapping, pulled out standalone (raw strength, not a
// KeepSegment) so extract_clip_audio - which has no KeepSegment of its own - can share it too.
//
// nr (0.01..97dB, "how much to reduce") is the obvious half and was the only one this used to set,
// clamped to a gentler 4..40 subrange since anything past ~40dB starts eating into the wanted
// signal along with the noise for typical screen-recording mic input.
//
// nf (-80..-20dB, "how loud something has to be to NOT count as noise") turned out to matter just
// as much: afftdn's own default (-50dB) assumes real noise sits far below the wanted signal, which
// holds for light tape hiss but not for the kind of background noise a screen recording's mic
// actually picks up (fans, room tone, distant machinery) - that can sit only 15-25dB below speech,
// well above -50dB, so afftdn quietly left it almost untouched regardless of how high `nr` was
// pushed. Verified against synthetic noise+tone fixtures: nr alone (default nf=-50) measured
// <0.1dB of RMS reduction even at nr=40, while pairing it with nf up to afftdn's own most
// aggressive allowed value (-20) measured several dB - see this repo's run-briefcast skill session
// notes for the numbers. None/0 strength returns None (no filter at all) rather than
// "afftdn=nr=4:nf=-50" - keeps a clip that's never touched this feature byte-for-byte identical to
// before it existed, and skips an unnecessary filter stage in the common case.
fn noise_reduction_afftdn_params(strength: Option<f64>) -> Option<(f64, f64)> {
    let strength = strength.unwrap_or(0.0).max(0.0).min(1.0);
    if strength <= 0.0 {
        None
    } else {
        let nr = 4.0 + strength * 36.0; // 4..40dB
        let nf = -50.0 + strength * 30.0; // -50..-20dB
        Some((nr, nf))
    }
}

// Whether this segment needs export_trimmed_video's full filter-graph path rather than its fast
// `-ss`/`-to` passthrough - true for any per-segment effect that path has nowhere to apply. Pulled
// out of export_trimmed_video itself (rather than an inline closure) so this decision is unit-
// testable without spawning ffmpeg - see this file's own test module. noise_reduction belongs here
// exactly like speed/crop/etc: omitting it once meant a single-segment timeline with ONLY noise
// reduction turned on silently took the effect-free fast path and never got afftdn applied at all.
// The full audio-cleanup chain for one clip, in the same order the live preview's Web Audio graph
// runs it (VideoPlayer.tsx): low-cut -> hum notches -> denoise -> gate. Empty when nothing is on,
// so an untouched clip's filter graph stays byte-for-byte what it was before this existed.
// `rnnoise_model` is the already filtergraph-escaped path of the bundled arnndn model (see
// escape_filter_path); "remove" mode falls back to afftdn if it's missing rather than failing the
// whole export.
//
// `sample_secs` is set when the caller has prepended a noise sample of that length to the stream
// (see audio_branch / cleanup_noise_sample): afftdn learns its profile from exactly that prefix via
// asendcmd, and the prefix is trimmed off again right after the denoiser.
fn audio_cleanup_filters(strength: Option<f64>, cleanup: Option<&AudioCleanup>, rnnoise_model: Option<&str>) -> Vec<String> {
    audio_cleanup_filters_with_sample(strength, cleanup, rnnoise_model, None)
}

fn audio_cleanup_filters_with_sample(
    strength: Option<f64>,
    cleanup: Option<&AudioCleanup>,
    rnnoise_model: Option<&str>,
    sample_secs: Option<f64>,
) -> Vec<String> {
    let mut filters = Vec::new();
    let cleanup = cleanup.cloned().unwrap_or_default();
    if cleanup.low_cut.unwrap_or(false) {
        filters.push("highpass=f=80".to_string());
    }
    if let Some(hz) = cleanup.hum.filter(|hz| *hz == 50 || *hz == 60) {
        // Fundamental plus the next two harmonics - mains hum is rarely a pure sine. Narrow (Q=8)
        // so voice energy right next to each notch survives.
        for harmonic in 1..=3 {
            filters.push(format!("bandreject=f={}:t=q:w=8", hz * harmonic));
        }
    }
    let wants_remove = cleanup.mode.as_deref() == Some("remove");
    match (wants_remove, rnnoise_model) {
        (true, Some(model)) => {
            let strength = strength.unwrap_or(0.0).max(0.0).min(1.0);
            if strength > 0.0 {
                // mix: 1 = fully denoised, lower blends the original back in (sample-aligned).
                filters.push(format!("arnndn=m='{}':mix={:.2}", model, strength));
            }
        }
        _ => {
            if let Some((nr, nf)) = noise_reduction_afftdn_params(strength) {
                match sample_secs {
                    Some(secs) => {
                        // With a real noise profile the floor needn't be pushed as far: measured
                        // on a noisy field recording, nf=-20 cost ~6dB of speech while -28 cost
                        // ~2.5dB for nearly the same noise removal.
                        let s = strength.unwrap_or(0.0).max(0.0).min(1.0);
                        let nf = -44.0 + 16.0 * s;
                        filters.push(format!(
                            "asendcmd=c='0.000 afftdn sample_noise start;{:.3} afftdn sample_noise stop'",
                            (secs - 0.001).max(0.0)
                        ));
                        filters.push(format!("afftdn=nr={:.2}:nf={:.1}", nr, nf));
                        filters.push(format!("atrim=start={:.6}", secs));
                        filters.push("asetpts=PTS-STARTPTS".to_string());
                    }
                    None => filters.push(format!("afftdn=nr={:.2}:nf={:.1}", nr, nf)),
                }
            }
        }
    }
    if cleanup.gate.unwrap_or(false) {
        // Gentle downward expander rather than a hard gate: ~-24dB of reduction (range) below the
        // threshold, slow release so word tails aren't chopped.
        filters.push("agate=threshold=0.015:ratio=3:attack=5:release=250:range=0.06".to_string());
    }
    if cleanup.level.unwrap_or(false) {
        // speechnorm evens out speaker-to-speaker level (bounded expansion so pauses aren't pumped
        // up into noise), then loudnorm lands the result on -16 LUFS with -1.5dBTP headroom. loudnorm
        // runs internally at 192kHz, hence the resample back.
        filters.push("speechnorm=e=4:r=0.0001:l=1".to_string());
        filters.push("loudnorm=I=-16:TP=-1.5:LRA=11".to_string());
        filters.push("aresample=48000".to_string());
    }
    filters
}

// The noise sample range to prepend, when one applies: only for the afftdn path ("reduce" mode,
// or "remove" falling back without a model), only with the denoiser actually on, and clamped to
// a sane length. None means "no prefix" - callers then use the plain single-branch graph.
fn cleanup_noise_sample(strength: Option<f64>, cleanup: Option<&AudioCleanup>, rnnoise_model: Option<&str>) -> Option<(f64, f64)> {
    let cleanup = cleanup?;
    if strength.unwrap_or(0.0) <= 0.0 {
        return None;
    }
    if cleanup.mode.as_deref() == Some("remove") && rnnoise_model.is_some() {
        return None;
    }
    let sample = cleanup.noise_sample?;
    let start = sample.start.max(0.0);
    let end = sample.end.min(start + MAX_NOISE_SAMPLE_SECS);
    if !(start.is_finite() && end.is_finite()) || end - start < 0.1 {
        return None;
    }
    // Rounded to the same 3 decimals atrim gets, so the trim-off after afftdn removes exactly the
    // prefix that was prepended.
    let r = |x: f64| (x * 1000.0).round() / 1000.0;
    Some((r(start), r(end)))
}

// One clip's audio branch from `input_label` (e.g. "[2:a]") to `[out_label]`: trim to
// [start,end), speed, then the cleanup chain. With a noise sample, the input is split, the sample
// range is cut out and concatenated IN FRONT of the clip so afftdn can learn from it, and the
// cleanup chain's own atrim (audio_cleanup_filters_with_sample) drops it again - the profile then
// applies to the whole clip from its first sample, unlike learning mid-stream.
fn audio_branch(
    input_label: &str,
    start: f64,
    end: f64,
    speed: f64,
    filters: &[String],
    noise_sample: Option<(f64, f64)>,
    out_label: &str,
) -> String {
    let chain: String = filters.iter().map(|f| format!(",{}", f)).collect();
    match noise_sample {
        None => format!(
            "{input}atrim=start={start:.3}:end={end:.3},asetpts=PTS-STARTPTS,{tempo}{chain}[{out}];",
            input = input_label, tempo = atempo_chain(speed), out = out_label
        ),
        Some((ss, se)) => format!(
            "{input}asplit=2[{out}_m][{out}_s];\
             [{out}_s]atrim=start={ss:.3}:end={se:.3},asetpts=PTS-STARTPTS[{out}_n];\
             [{out}_m]atrim=start={start:.3}:end={end:.3},asetpts=PTS-STARTPTS,{tempo}[{out}_t];\
             [{out}_n][{out}_t]concat=n=2:v=0:a=1{chain}[{out}];",
            input = input_label, tempo = atempo_chain(speed), out = out_label
        ),
    }
}

// (filters, noise sample) for one segment - the pair audio_trim_chain needs.
fn segment_cleanup(seg: &KeepSegment, rnnoise_model: Option<&str>) -> (Vec<String>, Option<(f64, f64)>) {
    let sample = cleanup_noise_sample(seg.noise_reduction, seg.audio_cleanup.as_ref(), rnnoise_model);
    let filters = audio_cleanup_filters_with_sample(
        seg.noise_reduction,
        seg.audio_cleanup.as_ref(),
        rnnoise_model,
        sample.map(|(s, e)| e - s),
    );
    (filters, sample)
}

fn segment_audio_cleanup_filters(seg: &KeepSegment, rnnoise_model: Option<&str>) -> Vec<String> {
    audio_cleanup_filters(seg.noise_reduction, seg.audio_cleanup.as_ref(), rnnoise_model)
}

// A path as a filter option value inside single quotes: forward slashes, and the drive colon
// escaped for the option parser (the quotes protect it at the filtergraph level) - checked against
// the bundled ffmpeg with `arnndn=m='C\:/.../bd.rnnn'`. Quotes are dropped since they can't be
// escaped inside a quoted value.
fn escape_filter_path(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/").replace(':', "\\:").replace('\'', "")
}

fn lowercase_extension(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default()
}

// Still images a timeline clip can be built from (the editor's image clips - see Clip's own doc
// comment, videoEditTypes.ts). Mirrors IMAGE_CLIP_EXTENSIONS there. EXIF orientation needs no
// handling of its own: ffmpeg auto-rotates image inputs by it, in -vf and -filter_complex alike.
fn is_still_image_path(path: &str) -> bool {
    matches!(
        lowercase_extension(path).as_str(),
        "png" | "jpg" | "jpeg" | "bmp" | "tif" | "tiff" | "webp" | "gif" | "heic" | "heif"
    )
}

// HEIC/HEIF stills (iPhone's default) - the bundled ffmpeg's HEIF tile-grid decoding is unreliable
// (see get_heic_preview), so these never reach ffmpeg directly: still_image_source swaps in the
// same cached, correctly decoded PNG the image viewer already shows.
fn is_heic_path(path: &str) -> bool {
    matches!(lowercase_extension(path).as_str(), "heic" | "heif")
}

// The file ffmpeg should actually read for an image clip - the image itself, or for HEIC/HEIF its
// decoded PNG (generated once, then a cache hit).
async fn still_image_source(app_handle: &AppHandle, window: &Window, state: &ConversionState, path: &str) -> Result<String, String> {
    if !is_heic_path(path) {
        return Ok(path.to_string());
    }
    heic_preview(app_handle.clone(), window.clone(), state, path.to_string()).await
}

// Frame rate every image segment is looped at (`-loop 1 -framerate`) - there's no source rate to
// inherit from a still, and 30 matches probe_frame_rate's own fallback.
const IMAGE_SEGMENT_FPS: f64 = 30.0;

// Fits a segment's frames into the shared out_w:out_h output frame (letterboxed, never stretched)
// before any of its own effects run - needed whenever segments can differ in size, since concat/
// xfade both reject inputs of different dimensions. Image clips always need it (a photo is almost
// never exactly the output size); same-size video segments pass through scale untouched. The
// preview's own image proxy (get_image_clip_proxy) applies this exact scale+pad, which is what
// keeps crop/Ken Burns/overlay positions on an image clip identical between preview and export.
fn frame_fit_chain(out_w: i64, out_h: i64, is_image: bool) -> String {
    format!(
        ",scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1{fmt}",
        w = out_w,
        h = out_h,
        fmt = if is_image { ",format=yuv420p" } else { "" }
    )
}

fn segment_needs_filter_graph(seg: &KeepSegment) -> bool {
    is_still_image_path(&seg.source_path) || seg.lut_cube.is_some() || seg.stabilize.is_some() || seg.color_filter
        .as_ref()
        .map_or(false, |cf| cf.preset != "none")
        || seg.ken_burns.is_some()
        || seg.transition_in.is_some()
        || seg.crop.is_some()
        || seg.flip_horizontal.unwrap_or(false)
        || (segment_speed(seg) - 1.0).abs() > 0.001
        || seg.speed_steps.as_ref().map_or(false, |s| !s.is_empty())
        || segment_noise_reduction_db(seg).is_some()
        || !segment_audio_cleanup_filters(seg, None).is_empty()
        || seg.muted.unwrap_or(false)
        || has_pointer_layers(seg)
        || seg.fx.as_ref().is_some_and(|fx| fx.intensity > 0.0)
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
    stages
        .iter()
        .map(|s| format!("atempo={:.4}", s))
        .collect::<Vec<_>>()
        .join(",")
}

// `pointer`: the clip's editor-drawn pointer (pointer_fragment), laid on after the clip's look and
// before any change of geometry - the preview draws the pointer over the graded picture, at the
// source position, moved and zoomed along with crop / Ken Burns / mirror. Fitting and mirroring then
// follow the colour stages instead of preceding them (per-pixel colour maps don't care), only for
// such a clip; every other clip keeps its exact chain.
fn segment_effect_chain(seg: &KeepSegment, out_w: Option<i64>, out_h: Option<i64>, fit_frame: bool, lut_path: Option<&str>, stab_path: Option<&str>, pointer: Option<&str>) -> String {
    let mut extra = String::new();
    // Stabilization first, on the clip's own frames exactly as pass 1 analysed them.
    if let (Some(path), Some(stab)) = (stab_path, &seg.stabilize) {
        extra.push_str(&stabilize_chain(path, stab.strength));
    }
    let fit_and_flip = |extra: &mut String| {
        if let (true, Some(w), Some(h)) = (fit_frame, out_w, out_h) {
            extra.push_str(&frame_fit_chain(w, h, is_still_image_path(&seg.source_path)));
        }
        if seg.flip_horizontal.unwrap_or(false) {
            extra.push_str(",hflip");
        }
    };
    if pointer.is_none() {
        fit_and_flip(&mut extra);
    }
    // The grade, then the colour preset - the preview's order: GradeCanvas draws the graded frame
    // and the preset's CSS filter applies on top of it (colour maps don't commute, so the order is
    // part of matching it).
    if let Some(path) = lut_path {
        extra.push_str(&format!(",lut3d=file='{}':interp=trilinear", path));
    }
    if let Some(cf) = &seg.color_filter {
        if cf.preset == "vignette" && (out_w.is_none() || out_h.is_none()) {
            // No frame size to draw the exact layer at (segment_vignette) - ffmpeg's own falloff.
            extra.push_str(&format!(",vignette=angle=PI/{:.3}", (6.0 - 4.0 * cf.intensity.clamp(0.0, 1.0)).max(2.2)));
        } else if cf.preset != "none" {
            extra.push_str(&color_filter_chain(cf));
        }
    }
    if let Some(fragment) = pointer {
        extra.push_str(fragment);
        fit_and_flip(&mut extra);
    }
    if let (Some(crop), Some(w), Some(h)) = (&seg.crop, out_w, out_h) {
        extra.push_str(&crop_chain(crop));
        if seg.ken_burns.is_none() {
            extra.push_str(&format!(",scale={w}:{h}"));
        }
    }
    if let (Some(kb), Some(w), Some(h)) = (&seg.ken_burns, out_w, out_h) {
        // Over the clip's SOURCE duration: this chain runs before the segment's speed change
        // (segment_video_chain), so `t` here is source time - the same progress the preview uses
        // (source-time fraction, VideoPlayer.tsx), and the same for a speed ramp as for a constant
        // speed.
        extra.push_str(&ken_burns_chain(kb, seg.end - seg.start, w, h, seg.source_fps.unwrap_or(30.0)));
    }
    extra
}

// One left-to-right fold step joining segment `i` ([v{i}]/[a{i}]) onto everything folded so far
// ([cur_v]/[cur_a], `accumulated` seconds long). Returns the filter text and the new labels.
//
// A transition plays over the START of the incoming clip, from the outgoing clip still PLAYING
// past its out-point - its tail handle ([old{i}], transition_tail), drawn over the incoming clip's
// first `d` seconds exactly the way the live preview draws it (renderTransitionFrame,
// transitionFrame.ts, over TransitionPreviewLayer). The incoming clip simply follows the outgoing
// one, so a transition never eats into either clip and the output is exactly the sum of the
// clips' own lengths - the same timeline the editor shows, which is what keeps text/image overlays
// and captions (all timed on that timeline) in sync. Audio simply cuts (concat): the tail is
// picture only, so no cut-away sound returns and no clip's sound gets shortened.
//
// `frame` is the output size every segment has been fitted to; without one (it couldn't be
// determined) only size-independent drawing is possible, so every transition becomes a crossfade.
#[allow(clippy::too_many_arguments)]
fn transition_fold_step(
    cur_v: &str,
    cur_a: &str,
    i: usize,
    accumulated: f64,
    seg_dur: f64,
    fps: f64,
    frame: Option<(i64, i64)>,
    transition: Option<(&str, f64)>,
    look: Option<&TransitionLook>,
) -> (String, String, String) {
    let next_v = format!("fold{}v", i);
    let next_a = format!("fold{}a", i);
    let step = match transition {
        Some((name, duration)) => {
            // At most 90% of the incoming clip - it plays entirely over that clip's own start.
            let d = duration.min(seg_dur * 0.9).max(0.05);
            let _ = accumulated;
            let default_look = TransitionLook::default();
            let look = look.unwrap_or(&default_look);
            let name = if frame.is_some() { name } else { "fade" };
            let body = transition_window_graph(name, i, d, fps, frame.unwrap_or((2, 2)), look);
            // The incoming clip's first `d` seconds ([head{i}]) get the transition drawn over
            // them; the rest ([rest{i}]) follows untouched. The join is pinned back to the
            // timeline's frame rate: setpts leaves [rest{i}]'s unknown, and an unknown rate reaches
            // the encoder as its 25fps default - silently dropping frames from 30/60fps footage.
            format!(
                "[v{i}]split[vh{i}][vr{i}];[vh{i}]trim=end={d:.6}[head{i}];[vr{i}]trim=start={d:.6},setpts=PTS-STARTPTS,fps={fps:.3}[rest{i}];\
                 {body}\
                 [{cur_v}][tr{i}][rest{i}]concat=n=3:v=1:a=0,fps={fps:.3},settb=AVTB[{next_v}];[{cur_a}][a{i}]concat=n=2:v=0:a=1[{next_a}];"
            )
        }
        None => format!("[{cur_v}][{cur_a}][v{i}][a{i}]concat=n=2:v=1:a=1[{next_v}][{next_a}];"),
    };
    (step, next_v, next_a)
}

// BT.601 limited-range Y, Cb, Cr of an 8-bit RGB colour.
fn rgb_to_yuv((r, g, b): (f64, f64, f64)) -> (i64, i64, i64) {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let y = 16.0 + 65.481 * r + 128.553 * g + 24.966 * b;
    let u = 128.0 - 37.797 * r - 74.203 * g + 112.0 * b;
    let v = 128.0 + 112.0 * r - 93.786 * g - 18.214 * b;
    (y.round() as i64, u.round() as i64, v.round() as i64)
}

// A per-frame command series for `target` (a named filter instance, "gblur@w3"): `param` set to
// value(p) at every frame of the window, p = transition progress 0..1. How a filter whose options
// aren't expressions (a blur radius, a pixel block size) follows the transition exactly.
pub(crate) fn sendcmd_series(target: &str, params: &[&str], d: f64, fps: f64, value: impl Fn(f64) -> f64) -> String {
    let frames = (d * fps).ceil().max(1.0) as usize;
    // Only where the value changes.
    let mut cmds: Vec<String> = Vec::new();
    let mut last = String::new();
    for k in 0..=frames {
        let t = k as f64 / fps;
        let v = format!("{:.3}", value((t / d).min(1.0)));
        if v != last {
            let set: Vec<String> = params.iter().map(|p| format!("{target} {p} {v}")).collect();
            cmds.push(format!("{t:.4} {}", set.join(",")));
            last = v;
        }
    }
    format!("sendcmd=c='{}'", cmds.join(";"))
}

// Draws one transition over the incoming clip's first `d` seconds: [old{i}] (the outgoing clip's
// tail, timed from 0) over [head{i}], into [tr{i}]. Every case mirrors renderTransitionFrame
// (transitionFrame.ts) step for step - the same layers in the same order (outgoing picture, black
// dip, glow, drawn layers), the same curves - so the export is the preview.
//
// Everything that moves is per FRAME (overlay x/y and enable, perspective corners, sendcmd'd blur
// and pixel size) over native filters. Per-pixel maths (geq) only ever runs on small frames scaled
// up afterwards - masks and glows are smooth or soft-edged, so nothing is lost - since full-size
// per-pixel expressions cost about a second per 1080p frame (measured against the bundled ffmpeg).
// Glows composite with `blend=screen` in RGB: a colour layer premultiplied by its opacity, screened
// on, is exactly CSS's mix-blend-mode:screen at that opacity.
fn transition_window_graph(name: &str, i: usize, d: f64, fps: f64, (w, h): (i64, i64), look: &TransitionLook) -> String {
    let k = look.intensity.unwrap_or(1.0).clamp(0.1, 1.5);
    // Progress in an overlay's/eq's `t`, and in geq's `T`.
    let pt = format!("min(t/{d:.4},1)");
    let pg = format!("min(T/{d:.4},1)");
    let fade_out = format!("format=yuva420p,fade=t=out:st=0:d={d:.4}:alpha=1");
    let half = d / 2.0;
    // A uniform layer (8x8, scaled up): yuva with this luma and per-frame alpha (0..1 in `pg`).
    let flat = |src: &str, out: &str, luma: i64, alpha: &str| {
        format!("[{src}]scale=8:8,format=yuva420p,geq=lum={luma}:cb=128:cr=128:a='255*({alpha})',scale={w}:{h}[{out}];")
    };
    // A screen-blended RGB glow (premultiplied 0..255 per channel), computed on a small frame.
    let screen = |src: &str, base: &str, out: &str, div: i64, r: &str, g: &str, b: &str| {
        let (lw, lh) = ((w / div).max(2), (h / div).max(2));
        format!(
            "[{src}]scale={lw}:{lh},format=gbrp,geq=r='{r}':g='{g}':b='{b}',scale={w}:{h}[gl{i}];\
             [{base}]format=gbrp[bg{i}];[bg{i}][gl{i}]blend=all_mode=screen:shortest=1,format=yuv420p[{out}];"
        )
    };
    // A soft mask (luma = opacity of the outgoing picture), computed at half size.
    let mask = |src: &str, out: &str, lum: &str| {
        let (lw, lh) = ((w / 2).max(2), (h / 2).max(2));
        format!("[{src}]scale={lw}:{lh},format=gray,geq=lum='{lum}',scale={w}:{h}:flags=bilinear[{out}];")
    };
    let masked = |lum: &str| {
        format!(
            "[old{i}]split[ma{i}][mm{i}];{m}[ma{i}]format=yuva420p[mb{i}];[mb{i}][mk{i}]alphamerge[mo{i}];[head{i}][mo{i}]overlay=eof_action=pass[tr{i}];",
            m = mask(&format!("mm{i}"), &format!("mk{i}"), lum)
        )
    };
    let tint = look.color.as_deref().and_then(parse_hex_color);
    match name {
        "dissolve" => {
            // Grain by grain: a fixed noise field (160 cells across) and every cell whose value
            // the progress has passed shows the new clip. The same hash as the preview's.
            let s = "(sin(X*12.9898+Y*78.233)*43758.5453)";
            format!(
                "[old{i}]split[ma{i}][mm{i}];[mm{i}]scale=160:-1,format=gray,geq=lum='255*gte({s}-floor({s}),{pg})',scale={w}:{h}:flags=bilinear[mk{i}];\
                 [ma{i}]format=yuva420p[mb{i}];[mb{i}][mk{i}]alphamerge[mo{i}];[head{i}][mo{i}]overlay=eof_action=pass[tr{i}];"
            )
        }
        "fadeblack" | "fadewhite" if name == "fadeblack" || (tint.map_or(true, |c| c == (255.0, 255.0, 255.0)) && look.intensity.is_none()) => {
            // Out to black/white over the first half, then from it over the second.
            let luma = if name == "fadeblack" { 16 } else { 235 };
            format!(
                "[old{i}]split[oa{i}][ob{i}];[head{i}][oa{i}]overlay=eof_action=pass:enable='lt(t,{half:.4})'[x{i}];{dip}[x{i}][dip{i}]overlay=eof_action=pass[tr{i}];",
                dip = flat(&format!("ob{i}"), &format!("dip{i}"), luma, &format!("if(lt({pg},0.5),2*{pg},2-2*{pg})"))
            )
        }
        "fadewhite" => {
            // A crossfade washed in the flash colour at its peak - screened on, or laid over for black.
            let (r, g, b) = tint.unwrap_or((255.0, 255.0, 255.0));
            let o = format!("min(1,{k:.3}*sin(PI*{pg}))");
            let lead = format!("[old{i}]split[oa{i}][ob{i}];[oa{i}]{fade_out}[oc{i}];[head{i}][oc{i}]overlay=eof_action=pass[x{i}];");
            if (r, g, b) == (0.0, 0.0, 0.0) {
                format!("{lead}{}[x{i}][dip{i}]overlay=eof_action=pass[tr{i}];", flat(&format!("ob{i}"), &format!("dip{i}"), 16, &o))
            } else {
                format!("{lead}{}", screen(&format!("ob{i}"), &format!("x{i}"), &format!("tr{i}"), 8, &format!("{r}*{o}"), &format!("{g}*{o}"), &format!("{b}*{o}")))
            }
        }
        "lightleak" => {
            // A crossfade under a coloured burn whose hot spot travels across: CSS's
            // radial-gradient(ellipse 0.83*size, white-hot -> colour@0.95 at 35% -> clear) over a
            // flat colour@0.5, interpolated premultiplied as CSS does, screened at min(1, 1.15k sin).
            let (r, g, b) = tint.unwrap_or((255.0, 122.0, 46.0));
            let size = look.size.unwrap_or(1.0).clamp(0.3, 2.5);
            let (sx, sy) = match look.direction.as_deref() {
                Some("left") => (format!("(1.2-1.4*{pg})"), "0.35".to_string()),
                Some("down") => ("0.4".to_string(), format!("(-0.2+1.4*{pg})")),
                Some("up") => ("0.4".to_string(), format!("(1.2-1.4*{pg})")),
                Some("diagonal") => (format!("(-0.2+1.4*{pg})"), format!("(-0.2+1.4*{pg})")),
                Some("center") => ("0.5".to_string(), "0.5".to_string()),
                _ => (format!("(-0.2+1.4*{pg})"), "0.35".to_string()),
            };
            let rad = 0.83 * size;
            let dist = format!("hypot((X/W-{sx})/{rad:.4},(Y/H-{sy})/{rad:.4})");
            let t1 = format!("clip({dist}/0.35,0,1)");
            let t2 = format!("clip(({dist}-0.35)/0.65,0,1)");
            let alpha = format!("if(lt({dist},0.35),1-0.05*{t1},0.95*(1-{t2}))");
            let o = format!("min(1,{:.3}*sin(PI*{pg}))", 1.15 * k);
            let channel = |hot: f64, c: f64| {
                format!("{o}*(if(lt({dist},0.35),{hot}*(1-{t1})+{c1:.3}*{t1},{c1:.3}*(1-{t2}))+{half_c:.3}*(1-{alpha}))", c1 = c * 0.95, half_c = c * 0.5)
            };
            format!(
                "[old{i}]split[oa{i}][ob{i}];[oa{i}]{fade_out}[oc{i}];[head{i}][oc{i}]overlay=eof_action=pass[x{i}];{}",
                screen(&format!("ob{i}"), &format!("x{i}"), &format!("tr{i}"), 16, &channel(255.0, r), &channel(252.0, g), &channel(240.0, b))
            )
        }
        "whip" => {
            // A sideways smear through a white flash: blur sin(pi p)*3% of the width, sliding 30%.
            // gblur takes its vertical sigma from `sigma` only once, at init - a series has to drive
            // sigmaV too, or the blur stays one-dimensional.
            let blur = sendcmd_series(&format!("gblur@w{i}"), &["sigma", "sigmaV"], d, fps, |p| (std::f64::consts::PI * p).sin() * 0.03 * w as f64);
            format!(
                "[old{i}]split[oa{i}][ob{i}];[oa{i}]format=yuva420p,{blur},gblur@w{i}=sigma=0:sigmaV=0,fade=t=out:st=0:d={d:.4}:alpha=1[oc{i}];\
                 [head{i}][oc{i}]overlay=x='-0.3*main_w*{pt}':y=0:eof_action=pass[x{i}];{flash}[x{i}][fl{i}]overlay=eof_action=pass[tr{i}];",
                flash = flat(&format!("ob{i}"), &format!("fl{i}"), 235, &format!("min(1,{:.3}*pow(sin(PI*{pg}),2))", 0.8 * k))
            )
        }
        "zoomblur" | "zoomin" => {
            // The old picture zooms at the camera about the centre - zoom blur also smears (blur
            // before the zoom, as CSS applies `filter` before `transform`) through a white flash.
            let frames = (d * fps.max(1.0)).max(1.0);
            // perspective's `in` counts frames from 1.
            let p = format!("min((in-1)/{frames:.3},1)");
            let z = if name == "zoomblur" { format!("(1+1.6*pow({p},2))") } else { format!("(1+{p})") };
            let persp = format!(
                "perspective=x0='W/2-W/2/{z}':y0='H/2-H/2/{z}':x1='W/2+W/2/{z}':y1='H/2-H/2/{z}':x2='W/2-W/2/{z}':y2='H/2+H/2/{z}':x3='W/2+W/2/{z}':y3='H/2+H/2/{z}':sense=source:eval=frame"
            );
            if name == "zoomin" {
                return format!("[old{i}]{persp},{fade_out}[oc{i}];[head{i}][oc{i}]overlay=eof_action=pass[tr{i}];");
            }
            let blur = sendcmd_series(&format!("gblur@z{i}"), &["sigma", "sigmaV"], d, fps, |p| p * 0.012 * w as f64 * k);
            format!(
                "[old{i}]split[oa{i}][ob{i}];[oa{i}]format=yuva420p,{blur},gblur@z{i}=sigma=0:sigmaV=0,{persp},fade=t=out:st=0:d={d:.4}:alpha=1[oc{i}];\
                 [head{i}][oc{i}]overlay=eof_action=pass[x{i}];{flash}[x{i}][fl{i}]overlay=eof_action=pass[tr{i}];",
                flash = flat(&format!("ob{i}"), &format!("fl{i}"), 235, &format!("min(1,{:.3}*pow(sin(PI*{pg}),2))", 0.35 * k))
            )
        }
        "horzopen" => {
            // The new clip opens out of a line through the middle (or doors, vertical): the old
            // picture's opacity is CSS's linear-gradient(#000 a, clear a+soft, clear b-soft, #000 b),
            // stop positions clamped to be increasing as CSS does.
            let axis = if look.orientation.as_deref() == Some("vertical") { "X/W" } else { "Y/H" };
            let band = format!("({pg}*0.54)");
            let (s1, s2) = (format!("(0.5-{band})"), format!("(0.54-{band})"));
            let s3 = format!("max({s2},0.46+{band})");
            let s4 = format!("max({s3},0.5+{band})");
            let v = axis;
            let lum = format!(
                "255*if(lte({v},{s1}),1,if(lt({v},{s2}),1-({v}-{s1})/0.04,if(lt({v},{s3}),0,if(lt({v},{s4}),({v}-{s3})/max({s4}-{s3},1e-6),1))))"
            );
            masked(&lum)
        }
        "circleopen" => masked(&format!("255*gt(hypot(X-W/2,Y-H/2),{pg}*hypot(W,H)/2)")),
        "radial" => {
            // A sweep clockwise from 12 o'clock (CSS conic-gradient from 0deg).
            let a = "atan2(X-W/2,H/2-Y)";
            masked(&format!("255*gte(if(lt({a},0),{a}+2*PI,{a}),{pg}*2*PI)"))
        }
        "wipeleft" | "wiperight" => {
            // A hard edge, exact to the pixel: a half-white sprite two frames wide slid across.
            let (pad_x, x) = if name == "wipeleft" { ("0", format!("-main_w*{pt}")) } else { ("iw", format!("main_w*{pt}-main_w")) };
            format!(
                "[old{i}]split=3[ma{i}][mc{i}][ms{i}];\
                 [ms{i}]trim=end_frame=1,lutyuv=y=255:u=128:v=128,pad=iw*2:ih:{pad_x}:0:black,tpad=stop_mode=clone:stop_duration={d:.4}[sp{i}];\
                 [mc{i}]lutyuv=y=0:u=128:v=128[cv{i}];[cv{i}][sp{i}]overlay=x='{x}':y=0[mk{i}];\
                 [ma{i}]format=yuva420p[mb{i}];[mb{i}][mk{i}]alphamerge[mo{i}];[head{i}][mo{i}]overlay=eof_action=pass[tr{i}];"
            )
        }
        "slideleft" | "slideright" => {
            let sign = if name == "slideleft" { "-" } else { "" };
            format!("[head{i}][old{i}]overlay=x='{sign}main_w*{pt}':y=0:eof_action=pass[tr{i}];")
        }
        "pixelize" => {
            // Coarsens toward the midpoint (blocks up to 1/24 of the width), then the new clip.
            let max_block = (w as f64 / 24.0).max(2.0);
            let px = sendcmd_series(&format!("pixelize@p{i}"), &["w", "h"], d, fps, |p| (1.0 + (max_block - 1.0) * (2.0 * p).min(1.0)).round());
            format!("[old{i}]{px},pixelize@p{i}=w=1:h=1[oc{i}];[head{i}][oc{i}]overlay=eof_action=pass:enable='lt(t,{half:.4})'[tr{i}];")
        }
        "pagecurl" | "colorsweep" => drawn_transition(name, i, d, look),
        n if is_canvas_transition(n) => canvas_transition(n, i, d, fps, (w, h), look),
        _ => format!("[old{i}]{fade_out}[oc{i}];[head{i}][oc{i}]overlay=eof_action=pass[tr{i}];"),
    }
}

#[cfg(test)]
pub(crate) fn transition_window_graph_for_tests(name: &str, i: usize, d: f64, fps: f64, frame: (i64, i64)) -> String {
    transition_window_graph(name, i, d, fps, frame, &TransitionLook::default())
}

// The two transitions drawn from sprites slid per frame (page curl, colour sweep): [old{i}] (the
// outgoing clip's tail, `d` seconds, timed from 0) over [head{i}], into [tr{i}].
fn drawn_transition(name: &str, i: usize, d: f64, look: &TransitionLook) -> String {
    // Transition progress 0..1 from an overlay's `t` (seconds since the window began).
    let q = format!("min(t/{d:.3},1)");
    match name {
        // A colour panel slides across - one frame plus a lighter band at each end long, so its
        // leading edge has covered the old picture by the midpoint (when the old picture goes) and
        // its trailing edge uncovers the new clip after. Eased in and out (smoothstep).
        "colorsweep" => {
            const ACCENT: f64 = 0.08;
            let (r, g, b) = look.color.as_deref().and_then(parse_hex_color).unwrap_or((255.0, 176.0, 32.0));
            let (y, u, v) = rgb_to_yuv((r, g, b));
            let lift = |c: f64| (c + (255.0 - c) * 0.55).round() as u8;
            let accent = format!("0x{:02x}{:02x}{:02x}", lift(r), lift(g), lift(b));
            let lead = format!("({:.3}*{q}*{q}*(3-2*{q}))", 2.0 + 2.0 * ACCENT);
            let vertical = !matches!(look.direction.as_deref(), Some("left") | Some("right"));
            let pad = if vertical {
                format!("pad=iw:ih*{span}:0:ih*{ACCENT}:color={accent}", span = 1.0 + 2.0 * ACCENT)
            } else {
                format!("pad=iw*{span}:ih:iw*{ACCENT}:0:color={accent}", span = 1.0 + 2.0 * ACCENT)
            };
            let (x, y_pos) = match look.direction.as_deref() {
                Some("down") => ("0".to_string(), format!("main_h*{lead}-overlay_h")),
                Some("right") => (format!("main_w*{lead}-overlay_w"), "0".to_string()),
                Some("left") => (format!("main_w*(1-{lead})"), "0".to_string()),
                _ => ("0".to_string(), format!("main_h*(1-{lead})")),
            };
            format!(
                "[old{i}]split[oldf{i}][panel{i}];\
                 [panel{i}]trim=end_frame=1,lutyuv=y={y}:u={u}:v={v},{pad},tpad=stop_mode=clone:stop_duration={d:.3}[sweep{i}];\
                 [head{i}][oldf{i}]overlay=eof_action=pass:enable='lt(t,{half:.3})'[under{i}];\
                 [under{i}][sweep{i}]overlay=x='{x}':y='{y_pos}':eof_action=pass[tr{i}];",
                half = d / 2.0,
            )
        }
        // The old page peels away from its bottom-right corner along a fold line u+v = k (u, v =
        // fractions across / down the frame) sweeping from k=2 to 0: the page shows on one side,
        // the new clip on the other, with a paper-white curl over the page's edge and soft shadows
        // either side of it. Both layers are functions of u+v-k alone, so each is drawn ONCE, on a
        // sprite three frames wide (a = 3x/w - 2 + y/h runs over every u+v-k the frame needs),
        // and slid left by 2*q frame widths: the page's mask (white = page) onto black, and the
        // curl + shadows (with alpha) straight over the result. Drawn at quarter size and scaled
        // up, which also softens their edges.
        _ => {
            let a = "(3*X/W-2+Y/H)";
            let sprite = |planes: &str, fmt: &str| {
                format!("trim=end_frame=1,scale=iw*3/2:ih/2,format={fmt},geq={planes},scale=iw*2:ih*2:flags=bilinear,tpad=stop_mode=clone:stop_duration={d:.3}")
            };
            let mask = sprite(&format!("lum='255*clip(0.5-{a}*60,0,1)':cb=128:cr=128"), "yuv420p");
            // The curl's coverage, antialiased over ~1.5 sprite pixels at both its edges (a step
            // in `a` per pixel is 3/W), and the shadows' opacity either side of it.
            let e = "(4.5/W)";
            let f = format!("(clip(({a}+0.45)/{e},0,1)*clip(-{a}/{e},0,1))");
            let shadow = format!("if(between({a},-0.51,-0.45),0.3*({a}+0.51)/0.06,if(between({a},0,0.12),0.45*(1-{a}/0.12),0))");
            let curl = sprite(
                &format!("lum='if(gt({f},0),180+45*sin(PI*clip(-{a}/0.45,0,1)),16)':cb=128:cr=128:a='255*({f}+(1-{f})*{shadow})'"),
                "yuva420p",
            );
            let slide = format!("x='-2*main_w*{q}':y=0");
            format!(
                "[old{i}]split=4[page{i}][canvas{i}][maskf{i}][curlf{i}];\
                 [maskf{i}]{mask}[masks{i}];[curlf{i}]{curl}[curls{i}];\
                 [canvas{i}]lutyuv=y=0:u=128:v=128[black{i}];[black{i}][masks{i}]overlay={slide}[mask{i}];\
                 [page{i}][mask{i}]alphamerge[peel{i}];\
                 [head{i}][peel{i}]overlay=eof_action=pass[paged{i}];\
                 [paged{i}][curls{i}]overlay={slide}:eof_action=pass[tr{i}];"
            )
        }
    }
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
const ALLOWED_TRANSITIONS: &[&str] = &[
    "fade",
    "fadeblack",
    "wipeleft",
    "wiperight",
    "slideleft",
    "slideright",
    "circleopen",
    "zoomin",
    "pixelize",
    "radial",
    "dissolve",
    "fadewhite",
    "horzopen",
    // Not ffmpeg names - xfade plus a glow pass (see transition_fold_step).
    "lightleak",
    "whip",
    // xfade custom expressions (page_curl_expr, zoom_blur_expr, color_sweep_expr).
    "pagecurl",
    "zoomblur",
    "colorsweep",
    // Both pictures move (services/transition_graphs.rs).
    "blocks",
    "mosaic",
    "split",
    "slider",
    "strips",
    "beam",
    "iris",
    "spin",
    "glitch",
    "slice",
    "push",
    "cube",
    "flip",
    "tiles",
];

fn sanitize_transition_name(name: &str) -> &str {
    ALLOWED_TRANSITIONS
        .iter()
        .find(|&&t| t == name)
        .copied()
        .unwrap_or("fade")
}

// Every OverlayAnimation that burns in as a whole-overlay animation (title reveals are rendered
// into their own frames instead). Same security-boundary reasoning as ALLOWED_TRANSITIONS: this
// string is interpolated directly into the filter_complex below.
const ALLOWED_OVERLAY_ANIMATIONS: &[&str] = &[
    "none",
    "fade",
    "slide-left",
    "slide-right",
    "slide-up",
    "slide-down",
    "pop",
    "flip",
    "zoom",
    "drop",
];

fn sanitize_overlay_animation(name: &str) -> &str {
    ALLOWED_OVERLAY_ANIMATIONS
        .iter()
        .find(|&&a| a == name)
        .copied()
        .unwrap_or("none")
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

fn overlay_animation_ramp(start_time: f64, end_time: f64) -> f64 {
    OVERLAY_ANIMATION_RAMP_SEC.min((end_time - start_time) / 2.0).max(0.001)
}

// The preview's `progress` (0 at either edge of the overlay's window, 1 once fully arrived) in
// time variable `tv`.
fn overlay_arrival_expr(start_time: f64, end_time: f64, tv: &str) -> String {
    let ramp = overlay_animation_ramp(start_time, end_time);
    format!("clip(min(({tv}-{start_time:.3})/{ramp:.4},({end_time:.3}-{tv})/{ramp:.4}),0,1)")
}

fn overlay_slide_remaining_expr(start_time: f64, end_time: f64) -> String {
    format!("(1-{})", overlay_arrival_expr(start_time, end_time, "t"))
}

// "pop": the overlay's scale over time in `tv` - the preview's ease-out-back overshoot
// (easeOutBack, VideoOverlayLayer.tsx) of the same arrival progress: from nothing, past full size,
// settling at 1; symmetric on the way out.
fn overlay_pop_scale_expr(start_time: f64, end_time: f64, tv: &str) -> String {
    let p = overlay_arrival_expr(start_time, end_time, tv);
    format!("if(gte({p},1),1,max(0.01,1+2.70158*pow({p}-1,3)+1.70158*pow({p}-1,2)))")
}

// "flip": its horizontal squash - one and a half coin turns, |cos((1-p)^3 3pi)| (overlayAnimation.ts).
fn overlay_flip_sx_expr(start_time: f64, end_time: f64, tv: &str) -> String {
    let p = overlay_arrival_expr(start_time, end_time, tv);
    format!("if(gte({p},1),1,max(0.02,abs(cos(pow(1-{p},3)*3*PI))))")
}

// "zoom": rushing in from 2.5x.
fn overlay_zoom_scale_expr(start_time: f64, end_time: f64, tv: &str) -> String {
    let p = overlay_arrival_expr(start_time, end_time, tv);
    format!("(1+1.5*pow(1-{p},3))")
}

// The overlay's own scale animation over time in `tv` (pop / flip / zoom), if it has one.
fn overlay_anim_scale_expr(animation: &str, start_time: f64, end_time: f64, tv: &str) -> Option<String> {
    match animation {
        "pop" | "flip" => Some(overlay_pop_scale_expr(start_time, end_time, tv)),
        "zoom" => Some(overlay_zoom_scale_expr(start_time, end_time, tv)),
        _ => None,
    }
}

// "drop": how far above its resting spot it is - easeOutBounce of the arrival, from 0.3 frames up.
fn overlay_drop_offset_expr(start_time: f64, end_time: f64) -> String {
    let p = overlay_arrival_expr(start_time, end_time, "t");
    let (n1, d1) = (7.5625, 2.75);
    let bounce = format!(
        "if(lt({p},{a:.6}),{n1}*pow({p},2),if(lt({p},{b:.6}),{n1}*pow({p}-{c:.6},2)+0.75,if(lt({p},{d:.6}),{n1}*pow({p}-{e:.6},2)+0.9375,{n1}*pow({p}-{f:.6},2)+0.984375)))",
        a = 1.0 / d1,
        b = 2.0 / d1,
        c = 1.5 / d1,
        d = 2.5 / d1,
        e = 2.25 / d1,
        f = 2.625 / d1
    );
    format!("-(1-({bounce}))*main_h*0.3")
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
            format!(
                "({x})-(main_w*{frac})*{remaining}",
                x = ov.x,
                frac = OVERLAY_SLIDE_DISTANCE_FRACTION,
                remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)
            ),
            ov.y.to_string(),
        ),
        "slide-right" => (
            format!(
                "({x})+(main_w*{frac})*{remaining}",
                x = ov.x,
                frac = OVERLAY_SLIDE_DISTANCE_FRACTION,
                remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)
            ),
            ov.y.to_string(),
        ),
        "slide-up" => (
            ov.x.to_string(),
            format!(
                "({y})-(main_h*{frac})*{remaining}",
                y = ov.y,
                frac = OVERLAY_SLIDE_DISTANCE_FRACTION,
                remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)
            ),
        ),
        "slide-down" => (
            ov.x.to_string(),
            format!(
                "({y})+(main_h*{frac})*{remaining}",
                y = ov.y,
                frac = OVERLAY_SLIDE_DISTANCE_FRACTION,
                remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)
            ),
        ),
        "drop" => (ov.x.to_string(), format!("({})+({})", ov.y, overlay_drop_offset_expr(ov.start_time, ov.end_time))),
        _ => (ov.x.to_string(), ov.y.to_string()),
    }
}

// Just a slide's offset from the resting position ("0" for anything else) - added to a keyframed
// position, where the resting spot itself moves.
fn overlay_slide_offset_expr(ov: &OverlayImage, animation: &str) -> (String, String) {
    let r = overlay_slide_remaining_expr(ov.start_time, ov.end_time);
    let f = OVERLAY_SLIDE_DISTANCE_FRACTION;
    match animation {
        "slide-left" => (format!("-(main_w*{f})*{r}"), "0".into()),
        "slide-right" => (format!("(main_w*{f})*{r}"), "0".into()),
        "slide-up" => ("0".into(), format!("-(main_h*{f})*{r}")),
        "slide-down" => ("0".into(), format!("(main_h*{f})*{r}")),
        "drop" => ("0".into(), overlay_drop_offset_expr(ov.start_time, ov.end_time)),
        _ => ("0".into(), "0".into()),
    }
}

pub(crate) fn probe_frame_rate(ffprobe_path: &PathBuf, source_path: &str) -> f64 {
    const FALLBACK_FPS: f64 = 30.0;
    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "quiet",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate",
        "-of",
        "csv=p=0",
        source_path,
    ]);
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
// Channel count of `source_path`'s first audio stream; None when it has none or the probe fails.
fn probe_audio_channels(ffprobe_path: &PathBuf, source_path: &str) -> Option<u32> {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args(["-v", "quiet", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", source_path]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = cmd.output().ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

fn probe_has_audio(ffprobe_path: &PathBuf, source_path: &str) -> bool {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "quiet",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        source_path,
    ]);
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
// ---- Input seeking ------------------------------------------------------------------------------
//
// Every `-i` that only needs part of a long file jumps straight to it: an input-level `-ss` seeks
// the demuxer to the keyframe before that point and decodes only from there, where a bare `trim=`
// in the filter graph decoded (and threw away) everything from the very start of the file first -
// a cut at minute 50 of a recording decoded 50 minutes, once per segment taken from that file.
// Measured on a 10-minute 1080p source, three 20s cuts: 92.5s of decoding down to 6.6s.
//
// It's frame-exact and changes nothing in the picture: the seek lands SEEK_PREROLL_SECS early and
// the graph's own trim/atrim still make the cut, with every source time shifted by the seek (the
// input's timestamps start at 0 where the seek landed). Only times read from the INPUT shift -
// a segment's range, its speed-ramp steps and its audio noise sample.
const SEEK_PREROLL_SECS: f64 = 1.0;

// Where a segment's input can start reading: just before its own range or its noise sample
// (which can sit anywhere in the file, even before the clip), whichever is earlier. 0 for stills
// (looped, nothing to seek) and when it's near the file's start anyway.
fn segment_input_seek(seg: &KeepSegment) -> f64 {
    if is_still_image_path(&seg.source_path) {
        return 0.0;
    }
    let sample_start = seg.audio_cleanup.as_ref().and_then(|c| c.noise_sample).map(|s| s.start).unwrap_or(f64::INFINITY);
    let seek = seg.start.min(sample_start) - SEEK_PREROLL_SECS;
    if seek.is_finite() && seek > 0.0 { seek } else { 0.0 }
}

// Re-times a segment for an input that starts `by` seconds into its file.
fn shift_segment_times(seg: &mut KeepSegment, by: f64) {
    if by == 0.0 {
        return;
    }
    seg.start -= by;
    seg.end -= by;
    if let Some(steps) = seg.speed_steps.as_mut() {
        for step in steps {
            step.source_start -= by;
            step.source_end -= by;
        }
    }
    if let Some(sample) = seg.audio_cleanup.as_mut().and_then(|c| c.noise_sample.as_mut()) {
        sample.start -= by;
        sample.end -= by;
    }
}

// An input reading `path` from `seek` seconds in (plain when 0).
fn seeking_input(path: String, seek: f64) -> InputSpec {
    if seek > 0.0 {
        InputSpec { path, pre_args: vec!["-ss".into(), format!("{seek:.6}")] }
    } else {
        InputSpec::plain(path)
    }
}

// The seek for an overlay track used from `trim_start` seconds into its file.
fn trim_input_seek(trim_start: f64) -> f64 {
    let seek = trim_start - SEEK_PREROLL_SECS;
    if seek.is_finite() && seek > 0.0 { seek } else { 0.0 }
}

fn resolve_export_quality(quality: Option<&str>) -> (&'static str, &'static str) {
    match quality.unwrap_or("standard") {
        "high" => ("slow", "18"),
        "small" => ("veryfast", "28"),
        _ => ("medium", "23"),
    }
}

pub(crate) fn probe_video_dimensions(ffprobe_path: &PathBuf, source_path: &str) -> Option<(i64, i64)> {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "quiet",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:stream_side_data=rotation:stream_tags=rotate",
        "-of",
        "json",
        source_path,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = cmd.output().ok()?;
    let probe: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let video = probe["streams"].get(0)?;
    let (w, h) = (video["width"].as_i64()?, video["height"].as_i64()?);
    if w <= 0 || h <= 0 {
        return None;
    }
    // The size the frames DECODE at: ffmpeg turns a rotated phone video upright as it decodes.
    let rotation = video["side_data_list"]
        .as_array()
        .and_then(|list| list.iter().find_map(|d| d["rotation"].as_f64()))
        .or_else(|| video["tags"]["rotate"].as_str().and_then(|r| r.parse::<f64>().ok()))
        .unwrap_or(0.0);
    Some(if (rotation.abs() as i64) % 180 == 90 { (h, w) } else { (w, h) })
}

// One segment's audio branch of the filter graph, trimmed to [start,end) and labeled `out_label` -
// a real `atrim` off the segment's own input when it has audio, otherwise a synthesized silent
// track of the same duration (`anullsrc`, a filter *source*, needs no `-i` input of its own) so
// concat/xfade/acrossfade downstream always have a real audio stream to work with regardless of
// whether the source did.
fn audio_trim_chain(
    has_audio: bool,
    input_index: usize,
    start: f64,
    end: f64,
    speed: f64,
    cleanup: &(Vec<String>, Option<(f64, f64)>),
    out_label: &str,
) -> String {
    if has_audio {
        // atempo_chain (not a bare "atempo={speed}") since ffmpeg rejects a single atempo instance
        // outside 0.5..2.0 - see its own doc comment. A speed of 1 still resolves to exactly
        // "atempo=1.0000", functionally a no-op, so this needs no separate branch for that case.
        // afftdn runs AFTER atempo - it's a per-frame spectral filter, order relative to tempo
        // doesn't change its own output, so there's no reason to special-case which comes first.
        audio_branch(&format!("[{}:a]", input_index), start, end, speed, &cleanup.0, cleanup.1, out_label)
    } else {
        // Divided by speed to match the video stream's own now-speed-adjusted duration (see the
        // trim/setpts call sites above) - concat/xfade both require the audio and video branches of
        // the same segment to agree on how long it lasts.
        format!(
            "anullsrc=channel_layout=stereo:sample_rate=44100:duration={dur:.3}[{out}];",
            dur = ((end - start) / speed).max(0.01),
            out = out_label
        )
    }
}

// Decodes one overlay's PNG payload and writes it to a fresh temp file - ffmpeg needs a real path
// for `-i`, not a data URL. `data_base64` may carry a "data:image/png;base64," prefix (what
// canvas.toDataURL() produces) or be the bare payload; splitting on the last comma handles both
// without the caller needing to know which.
// An overlay image's pixel size, read from its PNG header (the first frame's, for a sequence).
fn overlay_layer_size(ov: &OverlayImage) -> Option<(i64, i64)> {
    let data = match &ov.frames {
        Some(frames) => frames.unique.first()?,
        None => &ov.data_base64,
    };
    let payload = data.rsplit(',').next().unwrap_or(data);
    // The IHDR's width/height sit at bytes 16..24 - 32 base64 characters decode them.
    let head = BASE64.decode(payload.get(..32)?).ok()?;
    if head.len() < 24 || &head[1..4] != b"PNG" {
        return None;
    }
    let w = u32::from_be_bytes(head[16..20].try_into().ok()?) as i64;
    let h = u32::from_be_bytes(head[20..24].try_into().ok()?) as i64;
    (w > 0 && h > 0).then_some((w, h))
}

fn write_temp_overlay_png(data_base64: &str, index: usize) -> Result<PathBuf, String> {
    let payload = data_base64.rsplit(',').next().unwrap_or(data_base64);
    let bytes = BASE64
        .decode(payload)
        .map_err(|e| format!("Failed to decode overlay image: {}", e))?;
    let path = std::env::temp_dir().join(format!(
        "briefcast_overlay_{}_{}.png",
        std::process::id(),
        index
    ));
    std::fs::write(&path, &bytes)
        .map_err(|e| format!("Failed to write overlay temp file: {}", e))?;
    Ok(path)
}

// Writes an animated overlay's frames as a numbered PNG sequence ffmpeg's image2 demuxer can read
// (`..._f%06d.png`). Each distinct frame is written once and every repeat is a hard link to it
// (a copy where linking isn't possible), so a long looping element costs little disk or time.
// Every file created is pushed onto `created` - including on failure - for the caller's cleanup.
// Returns the sequence's printf-style pattern.
fn write_temp_overlay_sequence(frames: &OverlayFrames, index: usize, created: &mut Vec<PathBuf>) -> Result<String, String> {
    if frames.unique.is_empty() || frames.sequence.is_empty() {
        return Err("Animated overlay has no frames".to_string());
    }
    let prefix = format!("briefcast_ovseq_{}_{}", std::process::id(), index);
    let dir = std::env::temp_dir();
    let mut unique_paths: Vec<PathBuf> = Vec::with_capacity(frames.unique.len());
    for (j, data) in frames.unique.iter().enumerate() {
        let payload = data.rsplit(',').next().unwrap_or(data);
        let bytes = BASE64
            .decode(payload)
            .map_err(|e| format!("Failed to decode overlay frame: {}", e))?;
        let path = dir.join(format!("{}_u{}.png", prefix, j));
        std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write overlay frame: {}", e))?;
        created.push(path.clone());
        unique_paths.push(path);
    }
    for (k, &u) in frames.sequence.iter().enumerate() {
        let src = unique_paths
            .get(u as usize)
            .ok_or_else(|| "Animated overlay frame index out of range".to_string())?;
        let path = dir.join(format!("{}_f{:06}.png", prefix, k));
        let _ = std::fs::remove_file(&path);
        if std::fs::hard_link(src, &path).is_err() {
            std::fs::copy(src, &path).map_err(|e| format!("Failed to write overlay frame: {}", e))?;
        }
        created.push(path);
    }
    Ok(dir.join(format!("{}_f%06d.png", prefix)).to_string_lossy().to_string())
}

// ---- Sprite tracks and the screen frame (the Screen Style panel) ---------------------------------
//
// A sprite track (spriteTrack.ts) is a layer made of a few small pictures shown one after another
// at changing places - an editor-drawn pointer at its sub-pixel phases, a click ripple's frames,
// keyboard-shortcut chips. The editor paints each distinct picture once, with the code its preview
// paints with; here they become an ffconcat list (each picture held until the next run - nothing is
// rendered per frame) overlaid at a position that is a step function of time. Runs change on
// boundaries the editor puts between frames, so a frame never lands where the picture and its
// position could disagree.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpriteTrack {
    // PNG data URLs, each exactly width x height.
    pub sprites: Vec<String>,
    pub width: i64,
    pub height: i64,
    // (from seconds, sprite index or -1 for nothing, x, y) - sorted; each holds until the next.
    pub runs: Vec<(f64, i64, i64, i64)>,
    // Where the last run ends.
    pub end: f64,
}

// The frame around the video (screenStyle.ts): the backdrop at the final frame's size with a
// transparent rounded hole, and where the edited picture is scaled into - the hole's box.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenStyleSpec {
    pub backdrop_base64: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

// A sprite's bytes as an 8-bit RGBA PNG of exactly w x h - what the canvas usually hands over
// already; anything else (an opaque canvas saved as RGB, a size off by one) is redrawn so every
// picture in the concat list has one size and format (a change mid-stream reconfigures the graph).
fn normalized_sprite_png(data_base64: &str, w: u32, h: u32) -> Result<Vec<u8>, String> {
    let payload = data_base64.rsplit(',').next().unwrap_or(data_base64);
    let bytes = BASE64.decode(payload).map_err(|e| format!("Failed to decode a sprite: {}", e))?;
    let ihdr_ok = bytes.len() > 26
        && &bytes[1..4] == b"PNG"
        && u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) == w
        && u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]) == h
        && bytes[24] == 8
        && bytes[25] == 6;
    if ihdr_ok {
        return Ok(bytes);
    }
    let decoded = image::load_from_memory(&bytes).map_err(|e| format!("Failed to read a sprite: {}", e))?.to_rgba8();
    let mut canvas = image::RgbaImage::new(w, h);
    image::imageops::overlay(&mut canvas, &decoded, 0, 0);
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to write a sprite: {}", e))?;
    Ok(out)
}

// The track's pictures in `dir` and an ffconcat list showing them run by run, timed from `shift`
// (run times minus `shift`, anything before 0 dropped). Returns the list's path.
fn write_sprite_track(track: &SpriteTrack, dir: &Path, shift: f64) -> Result<PathBuf, String> {
    let (w, h) = (track.width.clamp(2, 8192) as u32, track.height.clamp(2, 8192) as u32);
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create a sprite folder: {}", e))?;
    for (i, data) in track.sprites.iter().enumerate() {
        std::fs::write(dir.join(format!("s{i}.png")), normalized_sprite_png(data, w, h)?).map_err(|e| format!("Failed to write a sprite: {}", e))?;
    }
    let mut blank = Vec::new();
    image::DynamicImage::ImageRgba8(image::RgbaImage::new(w, h))
        .write_to(&mut std::io::Cursor::new(&mut blank), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to write a sprite: {}", e))?;
    std::fs::write(dir.join("blank.png"), blank).map_err(|e| format!("Failed to write a sprite: {}", e))?;

    let name = |sprite: i64| -> String {
        if sprite >= 0 && (sprite as usize) < track.sprites.len() {
            format!("s{sprite}.png")
        } else {
            "blank.png".to_string()
        }
    };
    // Boundaries rounded once, so the durations add up to exactly them (no drift over a long list).
    let at = |t: f64| ((t - shift).max(0.0) * 1e6).round() / 1e6;
    let mut list = String::from("ffconcat version 1.0\n");
    let mut cursor = 0.0;
    // Each picture opened at a microsecond frame rate: the list's timestamps take the first file's
    // timebase, and the image demuxer's default (1/25 s) rounded every run onto a 40 ms grid -
    // measured: a sprite meant for one 60 fps frame showed on the next.
    fn push(file: &str, until: f64, list: &mut String, cursor: &mut f64) {
        let d = until - *cursor;
        if d > 0.0 {
            list.push_str(&format!("file '{file}'\noption framerate 1000000\nduration {d:.6}\n"));
            *cursor = until;
        }
    }
    for (k, run) in track.runs.iter().enumerate() {
        let from = at(run.0);
        let until = at(track.runs.get(k + 1).map(|r| r.0).unwrap_or(track.end));
        if from > cursor {
            push("blank.png", from, &mut list, &mut cursor);
        }
        push(&name(run.1), until, &mut list, &mut cursor);
    }
    // Then nothing. The demuxer ignores a list's last duration, so the blank is listed twice.
    list.push_str("file 'blank.png'\noption framerate 1000000\nduration 1\nfile 'blank.png'\noption framerate 1000000\n");
    let path = dir.join("track.ffconcat");
    std::fs::write(&path, list).map_err(|e| format!("Failed to write a sprite list: {}", e))?;
    Ok(path)
}

// The ffmpeg input reading a sprite track's list.
fn sprite_track_input(list: &Path) -> InputSpec {
    InputSpec { path: list.to_string_lossy().to_string(), pre_args: vec!["-f".into(), "concat".into(), "-safe".into(), "0".into()] }
}

// A value that holds from each point's time to the next, as an expression in `tvar` - a balanced
// tree of comparisons (a long pointer path has thousands of steps).
fn step_expr(points: &[(f64, i64)], tvar: &str) -> String {
    fn build(points: &[(f64, i64)], lo: usize, hi: usize, tvar: &str) -> String {
        if lo == hi {
            return points[lo].1.to_string();
        }
        let mid = (lo + hi + 1) / 2;
        format!("if(lt({tvar},{:.6}),{},{})", points[mid].0, build(points, lo, mid - 1, tvar), build(points, mid, hi, tvar))
    }
    if points.is_empty() {
        return "0".into();
    }
    build(points, 0, points.len() - 1, tvar)
}

// One axis of a track's position over time (run times minus `shift`), changes only.
fn sprite_track_axis(track: &SpriteTrack, shift: f64, value: impl Fn(&(f64, i64, i64, i64)) -> i64) -> String {
    let mut points: Vec<(f64, i64)> = Vec::new();
    for run in &track.runs {
        let v = value(run);
        if points.last().map_or(true, |p| p.1 != v) {
            points.push((run.0 - shift, v));
        }
    }
    step_expr(&points, "t")
}

// [main] with the sprite track read from input `input` laid over it, into [out].
fn sprite_track_overlay(track: &SpriteTrack, input: usize, shift: f64, main: &str, tag: &str, out: &str) -> String {
    let x = sprite_track_axis(track, shift, |r| r.2);
    let y = sprite_track_axis(track, shift, |r| r.3);
    format!("[{input}:v]format=rgba[{tag}s];[{main}][{tag}s]overlay=x='{x}':y='{y}':eof_action=pass[{out}];")
}

// A segment's pointer layers as a fragment spliced into its chain (segment_effect_chain): the chain
// so far is named, each layer (read from `inputs`, timed from `shift` - the segment's first frame)
// laid over it in turn, and the chain carries on from the result.
fn pointer_fragment(i: usize, layers: &[SpriteTrack], inputs: &[usize], shift: f64) -> String {
    let mut fragment = format!("[ptr{i}m];");
    let mut current = format!("ptr{i}m");
    for (k, (layer, input)) in layers.iter().zip(inputs).enumerate() {
        let out = format!("ptr{i}l{k}");
        fragment.push_str(&sprite_track_overlay(layer, *input, shift, &current, &format!("ptr{i}s{k}"), &out));
        current = out;
    }
    fragment.push_str(&format!("[{current}]null"));
    fragment
}

// The video scaled into the frame's hole, the backdrop (single frame, repeated) over it.
fn screen_style_chain(input: &str, backdrop_input: usize, ss: &ScreenStyleSpec, (w, h): (i64, i64), out: &str) -> String {
    let cw = (ss.width.clamp(2, w) / 2) * 2;
    let ch = (ss.height.clamp(2, h) / 2) * 2;
    let cx = (ss.x.clamp(0, w - cw) / 2) * 2;
    let cy = (ss.y.clamp(0, h - ch) / 2) * 2;
    format!(
        "[{input}]scale={cw}:{ch},setsar=1,pad={w}:{h}:{cx}:{cy}:color=black[{out}c];[{backdrop_input}:v]format=rgba[{out}b];[{out}c][{out}b]overlay=0:0[{out}];"
    )
}

// When the first frame at or after `at` (seconds of the file's own timeline) is shown - what a
// segment trimmed from `at` counts its time from. Packets only, so it's quick.
fn probe_first_frame_at(ffprobe_path: &PathBuf, path: &str, at: f64) -> Option<f64> {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-read_intervals",
        &format!("{:.3}%{:.3}", (at - 3.0).max(0.0), at + 1.0),
        "-show_entries",
        "packet=pts_time:format=start_time",
        "-of",
        "json",
        path,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let out = cmd.output().ok()?;
    let probe: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let start = probe["format"]["start_time"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    probe["packets"]
        .as_array()?
        .iter()
        .filter_map(|p| p["pts_time"].as_str()?.parse::<f64>().ok())
        .map(|t| t - start)
        .filter(|t| *t >= at - 1e-6)
        .fold(None, |best: Option<f64>, t| Some(best.map_or(t, |b| b.min(t))))
}

// ---- Smart render (plain cuts) ------------------------------------------------------------------
//
// See services/smart_render.rs for the idea. This runs it: every piece of every clip (copied GOPs,
// re-encoded edges) and the audio as independent ffmpeg jobs at once, joins the pieces into an
// avc3 MP4, then checks the result - the exact frame count and a clean decode across every join -
// before trusting it. Ok(None) means "not this time" (not eligible, or the result didn't check
// out) and the caller renders normally; nothing a user sees ever depends on smart render working.

// The re-encoded edges are a second of video or two around each cut: encode them at a quality
// well above any export tier, so they sit invisibly between the untouched copied stretches.
const SMART_EDGE_CRF: &str = "16";

struct SmartJob {
    args: Vec<String>,
}

// Runs `jobs` as concurrent ffmpeg processes (at most `parallel` at once), reporting progress as
// each finishes. Stops everything on the first failure or when the user cancels.
fn run_smart_jobs(
    ffmpeg: &std::path::Path,
    jobs: Vec<SmartJob>,
    parallel: usize,
    cancelled: &std::sync::atomic::AtomicBool,
    mut on_done: impl FnMut(usize, usize),
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let total = jobs.len();
    let mut queue = jobs.into_iter();
    let mut running: Vec<std::process::Child> = Vec::new();
    let mut done = 0;
    let kill_all = |running: &mut Vec<std::process::Child>| {
        for child in running.iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    };
    loop {
        while running.len() < parallel.max(1) {
            let Some(job) = queue.next() else { break };
            let mut cmd = Command::new(ffmpeg);
            #[cfg(windows)]
            hide_console_window(&mut cmd);
            cmd.args(&job.args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
            running.push(cmd.spawn().map_err(|e| format!("Failed to start ffmpeg: {}", e))?);
        }
        if running.is_empty() {
            return Ok(());
        }
        if cancelled.load(Ordering::SeqCst) {
            kill_all(&mut running);
            return Err("Export cancelled".to_string());
        }
        let mut i = 0;
        while i < running.len() {
            match running[i].try_wait() {
                Ok(Some(status)) => {
                    let mut child = running.swap_remove(i);
                    if !status.success() {
                        let mut err = String::new();
                        if let Some(mut stderr) = child.stderr.take() {
                            let _ = std::io::Read::read_to_string(&mut stderr, &mut err);
                        }
                        kill_all(&mut running);
                        return Err(format!("A smart render piece failed: {}", err.trim()));
                    }
                    done += 1;
                    on_done(done, total);
                }
                Ok(None) => i += 1,
                Err(e) => {
                    kill_all(&mut running);
                    return Err(format!("Lost track of an ffmpeg job: {}", e));
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

// What one smart render runs: a job per piece (each to its own .ts in `work`), the audio job,
// the concat list joining the pieces in order, where the joins fall (output seconds), the total
// length and the exact frame count to verify against.
struct SmartBuild {
    jobs: Vec<SmartJob>,
    list: String,
    joins: Vec<f64>,
    seconds: f64,
    expected_frames: usize,
    audio_out: PathBuf,
}

fn smart_render_jobs(
    segments: &[KeepSegment],
    plans: &[Vec<crate::services::smart_render::Piece>],
    video: &crate::services::smart_render::SourceVideo,
    has_audio: &[bool],
    volume: f64,
    work: &std::path::Path,
) -> Result<SmartBuild, String> {
    use crate::services::smart_render::Piece;
    let fps = video.fps();
    let rate = format!("{}/{}", video.fps_num, video.fps_den);
    let expected_frames: usize = plans.iter().flatten().map(Piece::frames).sum();
    let eps = 0.25 / fps;
    let mut jobs = Vec::new();
    let mut list = String::new();
    let mut joins = Vec::new();
    let mut at = 0.0;
    for (seg, plan) in segments.iter().zip(plans) {
        for piece in plan {
            let out = work.join(format!("p{:05}.ts", jobs.len()));
            let out_str = path_to_str(&out)?.to_string();
            let args: Vec<String> = match piece {
                Piece::Copy { start, frames, .. } => vec![
                    "-v".into(), "error".into(), "-ss".into(), format!("{start:.6}"), "-i".into(), seg.source_path.clone(),
                    "-map".into(), "0:v:0".into(), "-frames:v".into(), frames.to_string(), "-c:v".into(), "copy".into(),
                    "-bsf:v".into(), "h264_mp4toannexb".into(), "-an".into(), "-sn".into(), "-dn".into(),
                    "-f".into(), "mpegts".into(), "-muxdelay".into(), "0".into(), "-muxpreload".into(), "0".into(), "-y".into(), out_str.clone(),
                ],
                Piece::Encode { start, end, frames } => {
                    let seek = (start - 1.0).max(0.0);
                    vec![
                        "-v".into(), "error".into(), "-ss".into(), format!("{seek:.6}"), "-i".into(), seg.source_path.clone(),
                        "-map".into(), "0:v:0".into(),
                        "-vf".into(), format!("trim=start={:.6}:end={:.6},setpts=PTS-STARTPTS,fps={rate}", start - seek - eps, end - seek - eps),
                        "-frames:v".into(), frames.to_string(), "-an".into(), "-sn".into(), "-dn".into(),
                        "-c:v".into(), "libx264".into(), "-preset".into(), "medium".into(), "-crf".into(), SMART_EDGE_CRF.into(), "-pix_fmt".into(), "yuv420p".into(),
                        "-f".into(), "mpegts".into(), "-muxdelay".into(), "0".into(), "-muxpreload".into(), "0".into(), "-y".into(), out_str.clone(),
                    ]
                }
            };
            jobs.push(SmartJob { args });
            let secs = piece.frames() as f64 / fps;
            list.push_str(&format!("file '{}'\nduration {secs:.6}\n", out_str.replace('\'', "'\\''")));
            at += secs;
            joins.push(at);
        }
    }
    joins.pop(); // the end of the last piece isn't a join

    // The audio: every clip's sound, trimmed exactly, joined, at the track volume (seeking inputs).
    let audio_out = work.join("audio.m4a");
    {
        let mut args: Vec<String> = vec!["-v".into(), "error".into()];
        let mut graph = String::new();
        let mut joined = String::new();
        for (i, (seg, plan)) in segments.iter().zip(plans).enumerate() {
            let seek = segment_input_seek(seg);
            // Exactly as long as the clip's video (whole frames), so sound and picture stay locked
            // across any number of cuts instead of drifting by a fraction of a frame at each.
            let seconds = plan.iter().map(Piece::frames).sum::<usize>() as f64 / fps;
            args.extend(["-ss".into(), format!("{seek:.6}"), "-i".into(), seg.source_path.clone()]);
            graph.push_str(&audio_trim_chain(has_audio[i], i, seg.start - seek, seg.start - seek + seconds, 1.0, &(Vec::new(), None), &format!("a{i}")));
            joined.push_str(&format!("[a{i}]"));
        }
        graph.push_str(&format!("{joined}concat=n={}:v=0:a=1,volume={volume:.3}[outa]", segments.len()));
        args.extend(["-filter_complex".into(), graph, "-map".into(), "[outa]".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "128k".into(), "-y".into(), path_to_str(&audio_out)?.to_string()]);
        jobs.push(SmartJob { args });
    }
    Ok(SmartBuild { jobs, list, joins, seconds: at, expected_frames, audio_out })
}

#[allow(clippy::too_many_arguments)]
async fn smart_render_export(
    app_handle: &AppHandle,
    window: &Window,
    state: &ConversionState,
    segments: &[KeepSegment],
    has_audio: &[bool],
    volume: f64,
    progress_key: &str,
    output: PathBuf,
) -> Result<Option<String>, String> {
    use crate::services::smart_render::{plan_clip, probe_packets, probe_source, Piece, SourceVideo};
    let ext = output.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    // MP4 only: avc3 (parameter sets in-stream) is an MP4 sample entry; a .mov keeps one set.
    if !matches!(ext.as_str(), "mp4" | "m4v") || segments.is_empty() {
        return Ok(None);
    }
    let ffmpeg = get_ffmpeg_path(app_handle)?;
    let ffprobe = get_ffprobe_path(app_handle)?;

    // Every clip's source must be copyable, and all of them alike (one stream can't change size
    // or rate mid-file). Then each clip's split, from its source's packet index.
    let owned: Vec<(String, f64, f64)> = segments.iter().map(|s| (s.source_path.clone(), s.start, s.end)).collect();
    let probe = ffprobe.clone();
    let planned = blocking(move || -> Option<(SourceVideo, Vec<Vec<Piece>>)> {
        let mut video: Option<SourceVideo> = None;
        let mut sources: HashMap<String, SourceVideo> = HashMap::new();
        let mut plans = Vec::with_capacity(owned.len());
        for (path, start, end) in &owned {
            let v = match sources.get(path) {
                Some(v) => v.clone(),
                None => {
                    let v = probe_source(&probe, path)?;
                    sources.insert(path.clone(), v.clone());
                    v
                }
            };
            if !v.copyable() || video.as_ref().is_some_and(|first| (first.width, first.height, first.fps_num, first.fps_den) != (v.width, v.height, v.fps_num, v.fps_den)) {
                return None;
            }
            let packets = probe_packets(&probe, path, (start - 1.0).max(0.0), end + 1.0)?;
            let plan = plan_clip(&packets, *start, *end, v.fps());
            if plan.is_empty() {
                return None;
            }
            plans.push(plan);
            video.get_or_insert(v);
        }
        Some((video?, plans))
    })
    .await?;
    let Some((video, plans)) = planned else { return Ok(None) };
    // Worth it only when something is actually copied.
    if !plans.iter().flatten().any(|p| matches!(p, Piece::Copy { .. })) {
        return Ok(None);
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let work = std::env::temp_dir().join(format!("briefcast_smart_{}_{stamp}", std::process::id()));
    std::fs::create_dir_all(&work).map_err(|e| format!("Failed to create a work folder: {}", e))?;
    let _cleanup = TempDir(work.clone());
    let SmartBuild { jobs, list, joins, seconds: at, expected_frames, audio_out } = smart_render_jobs(segments, &plans, &video, has_audio, volume, &work)?;

    // Run them all, a few at once.
    let parallel = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).clamp(1, 4);
    let cancelled = state.cancelled.clone();
    let progress_window = window.clone();
    let key = progress_key.to_string();
    let output_name = output.to_string_lossy().to_string();
    let ffmpeg_jobs = ffmpeg.clone();
    cancelled.store(false, std::sync::atomic::Ordering::SeqCst);
    let ran = blocking(move || {
        run_smart_jobs(&ffmpeg_jobs, jobs, parallel, &cancelled, |done, total| {
            let progress = done as f64 / total as f64 * 90.0;
            let _ = progress_window.emit(
                "conversion-progress",
                ConversionProgress {
                    input_path: key.clone(),
                    output_path: output_name.clone(),
                    progress,
                    status: ConversionStatus::Processing,
                    message: format!("Converting... {:.1}%", progress),
                },
            );
        })
    })
    .await?;
    if let Err(e) = ran {
        if state.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(e);
        }
        log::warn!("Smart render fell back to a full render: {}", e);
        return Ok(None);
    }

    // Join: the pieces in order (each with its own parameter sets - avc3), with the audio.
    let list_path = work.join("pieces.txt");
    std::fs::write(&list_path, list).map_err(|e| format!("Failed to write the piece list: {}", e))?;
    let inputs = [
        InputSpec { path: path_to_str(&list_path)?.to_string(), pre_args: vec!["-f".into(), "concat".into(), "-safe".into(), "0".into()] },
        InputSpec::plain(path_to_str(&audio_out)?.to_string()),
    ];
    let mux_args = ["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-tag:v", "avc3", "-movflags", "+faststart"];
    let written = match run_conversion_timed(app_handle, window, state, &inputs, progress_key, output, &mux_args, Some(at)).await {
        Ok(path) => path,
        Err(e) if state.cancelled.load(std::sync::atomic::Ordering::SeqCst) => return Err(e),
        Err(e) => {
            log::warn!("Smart render's join failed, falling back to a full render: {}", e);
            return Ok(None);
        }
    };

    // Check it: exactly the frames planned, and every join decodes cleanly.
    let check_path = written.clone();
    let ok = blocking(move || {
        let mut cmd = Command::new(&ffprobe);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.args(["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", &check_path]);
        let count = cmd.output().ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<usize>().ok());
        if count != Some(expected_frames) {
            log::warn!("Smart render produced {:?} frames, expected {}", count, expected_frames);
            return false;
        }
        joins.iter().all(|&j| {
            let mut cmd = Command::new(&ffmpeg);
            #[cfg(windows)]
            hide_console_window(&mut cmd);
            cmd.args(["-v", "error", "-ss", &format!("{:.6}", (j - 1.0).max(0.0)), "-i", &check_path, "-t", "2", "-map", "0:v:0", "-f", "null", "-"]);
            match cmd.output() {
                Ok(o) => o.status.success() && String::from_utf8_lossy(&o.stderr).trim().is_empty(),
                Err(_) => false,
            }
        })
    })
    .await?;
    if !ok {
        log::warn!("Smart render's result didn't verify - falling back to a full render");
        let _ = std::fs::remove_file(&written);
        return Ok(None);
    }
    Ok(Some(written))
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
    // user picks a destination via the Save button's "Choose locationâ€¦" option. Still runs through
    // unique_output_path (run_conversion) the same as the default location does, so a second export
    // to the exact same custom path doesn't clobber the first.
    output_path: Option<String>,
    // A complete ASS subtitle script (the editor's Captions tool - buildCaptionsAss, captions.ts),
    // already timed to the OUTPUT timeline and laid out at the video's own pixel size. Burned in
    // with libass as the very last video stage, above every overlay. None/omitted = no captions.
    captions_ass: Option<String>,
    // A platform format to export in (see OutputFrame); None keeps the timeline's own frame.
    output_frame: Option<OutputFrame>,
    // Loudness target in LUFS (e.g. -14 for YouTube/Spotify, -16 for podcasts); None = as mixed.
    loudness_lufs: Option<f64>,
    // Adjustment layers (see AdjustmentLayerSpec), in stacking order; None = none.
    adjustment_layers: Option<Vec<AdjustmentLayerSpec>>,
    // Chapters embedded in the file and written to its .chapters.json sidecar; None = none.
    chapters: Option<Vec<ChapterSpec>>,
    // The video's own sound's mixer channel - EQ/compressor/balance after the track volume
    // (audio_fx.rs); None = none.
    video_audio_fx: Option<AudioFxSpec>,
    // The frame around the video (Screen Style - screenStyle.ts): wallpaper, padding, corners and
    // shadow at the final frame's size. None = the video fills the frame as always.
    screen_style: Option<ScreenStyleSpec>,
    // Keyboard-shortcut chips (keystrokes.ts) as a sprite track on the output timeline, over every
    // overlay and under the captions. None = none.
    keystrokes: Option<SpriteTrack>,
    // Set by the background export queue (exportQueue.ts): the run gets its own cancel state
    // (cancel_export_job), progress events keyed "export-job:<id>", a live preview frame
    // (export-job-preview events) and below-normal CPU priority so editing stays smooth meanwhile.
    job_id: Option<String>,
    export_jobs: State<'_, ExportJobs>,
) -> Result<String, String> {
    if segments.is_empty() {
        return Err("No segments to export".to_string());
    }
    // A queued job runs on its own ConversionState, registered for cancel_export_job until it ends.
    let job = job_id.as_ref().map(|id| ExportJobGuard::register(&export_jobs, id));
    let state: &ConversionState = match &job {
        Some(guard) => &guard.state,
        None => &state,
    };
    let progress_key: String = match &job_id {
        Some(id) => format!("export-job:{id}"),
        None => output_base_path.clone(),
    };
    let preview_frame = job_id.as_ref().map(|id| std::env::temp_dir().join(format!("briefcast_export_preview_{}_{}.jpg", std::process::id(), sanitize_job_id(id))));
    let adjustment_layers = adjustment_layers.unwrap_or_default();
    let chapters = chapters.unwrap_or_default();
    let video_fx_filters = video_audio_fx.as_ref().map(audio_fx_filters).unwrap_or_default();
    // HEIC/HEIF image clips render from their decoded PNG (see still_image_source) - swapped in
    // before anything below reads a segment's path, so every later step just sees a plain image.
    let mut segments = segments;
    for seg in segments.iter_mut() {
        if is_heic_path(&seg.source_path) {
            seg.source_path = still_image_source(&app_handle, &window, &state, &seg.source_path).await?;
        }
    }
    let (quality_preset, quality_crf) = resolve_export_quality(quality.as_deref());

    // The primary video's OWN audio level (distinct from any audio overlay's own volume/muted,
    // which are separate mixed-in tracks) - 0.0 when muted, otherwise whatever the editor's track
    // volume slider was set to.
    let effective_video_volume = if audio_muted {
        0.0
    } else {
        audio_volume.max(0.0)
    };

    let output = match output_path {
        Some(p) => PathBuf::from(p),
        None => {
            let base = PathBuf::from(&output_base_path);
            let stem = base
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let ext = base
                .extension()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "mp4".to_string());
            let parent = base.parent().map(PathBuf::from).unwrap_or_default();
            if ext.eq_ignore_ascii_case(crate::services::video_edits::VIDEO_PROJECT_EXTENSION) {
                // A video project (made from images - see video_edits.rs) isn't itself a video, so
                // its render is "<project name>.mp4", not "<name> (edited).briefvideo".
                parent.join(format!("{}.mp4", stem))
            } else {
                parent.join(format!("{} (edited).{}", stem, ext))
            }
        }
    };

    // An image segment is a single still looped into a constant-rate stream long enough to cover
    // its own [start,end) window plus any transition tail out of it - trim= below then cuts it
    // exactly like a video segment.
    let mut inputs: Vec<InputSpec> = segments
        .iter()
        .enumerate()
        .map(|(i, s)| {
            if is_still_image_path(&s.source_path) {
                let tail = segments.get(i + 1).and_then(transition_window).map(|d| tail_source_seconds(s, d)).unwrap_or(0.0);
                InputSpec {
                    path: s.source_path.clone(),
                    pre_args: vec![
                        "-loop".into(),
                        "1".into(),
                        "-framerate".into(),
                        format!("{}", IMAGE_SEGMENT_FPS),
                        "-t".into(),
                        format!("{:.3}", s.end + tail + 0.5),
                    ],
                }
            } else {
                InputSpec::plain(s.source_path.clone())
            }
        })
        .collect();

    // Written to temp files up front (ffmpeg needs real file paths, not data URLs) and cleaned up
    // unconditionally once the export attempt finishes below, success or failure.
    let total_duration: f64 = segments.iter().map(segment_output_duration).sum();
    let mut temp_overlay_paths: Vec<PathBuf> = Vec::new();
    for (i, ov) in overlays.iter().enumerate() {
        // An animated overlay reads its own frame sequence at the overlay rate - it starts at
        // timestamp 0 and is shifted to start_time in the filter graph (see the overlay loop).
        if let Some(frames) = &ov.frames {
            match write_temp_overlay_sequence(frames, i, &mut temp_overlay_paths) {
                Ok(pattern) => inputs.push(InputSpec {
                    path: pattern,
                    pre_args: vec![
                        "-framerate".into(),
                        format!("{}", OVERLAY_INPUT_FPS),
                        "-start_number".into(),
                        "0".into(),
                    ],
                }),
                Err(e) => {
                    for temp_path in &temp_overlay_paths {
                        let _ = std::fs::remove_file(temp_path);
                    }
                    return Err(e);
                }
            }
            continue;
        }
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
        // -loop 1 turns the single PNG into a stream that lasts only as long as the overlay is on
        // screen; the graph shifts it to start at start_time (like a frame sequence). Looping it
        // for the whole output instead decoded the PNG at 30fps for the entire video, per
        // overlay - most of that only to be hidden by the overlay's enable window.
        inputs.push(InputSpec {
            path: path.to_string_lossy().to_string(),
            pre_args: vec![
                "-loop".into(),
                "1".into(),
                "-framerate".into(),
                format!("{}", OVERLAY_INPUT_FPS),
                "-t".into(),
                format!("{:.3}", (ov.end_time - ov.start_time).clamp(0.01, total_duration.max(0.01)) + 0.1),
            ],
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
                // Only for the region's own window (shifted into place in the graph) - see the
                // overlay PNGs above.
                inputs.push(InputSpec {
                    path: path.to_string_lossy().to_string(),
                    pre_args: vec![
                        "-loop".into(),
                        "1".into(),
                        "-framerate".into(),
                        format!("{}", OVERLAY_INPUT_FPS),
                        "-t".into(),
                        format!("{:.3}", (bv.end_time - bv.start_time).clamp(0.01, total_duration.max(0.01)) + 0.1),
                    ],
                });
                blur_mask_input_index.push(Some(input_index));
            }
            None => blur_mask_input_index.push(None),
        }
    }
    let blur_mask_count = blur_mask_input_index
        .iter()
        .filter(|idx| idx.is_some())
        .count();

    // Audio overlays need no temp file and no -loop/-t pre_args at all, unlike the PNGs above -
    // there's no client-side rendering step for audio (see OverlayAudio's own doc comment), so
    // this just opens each track's original source file directly, atrim-ing into it in the filter
    // graph below rather than pre-shaping the input stream itself.
    // Each seeks to just before the part it plays (see segment_input_seek), its trim re-timed to match.
    let mut audio_overlays = audio_overlays;
    for audio_ov in audio_overlays.iter_mut() {
        let seek = trim_input_seek(audio_ov.trim_start);
        audio_ov.trim_start -= seek;
        inputs.push(seeking_input(audio_ov.source_path.clone(), seek));
    }

    // PiP sources come last (after audio overlays) so audio_input_base's own formula further down
    // - segments.len() + overlays.len() + blur_mask_count - doesn't need to change to account for
    // them. Each gets the FULL source file as its own `-i` (no -loop/-t pre_args, unlike the image/
    // blur PNGs above) since pip_overlay_chain's own `trim=` does the windowing instead.
    let mut pip_overlays = pip_overlays;
    for pip in pip_overlays.iter_mut() {
        // A cut-out that's gone from disk (derived media cleared) - the original picture instead.
        if pip.cutout_path.as_deref().is_some_and(|p| !Path::new(p).exists()) {
            log::warn!("Cut-out missing, exporting the original picture: {:?}", pip.cutout_path);
            pip.cutout_path = None;
        }
        let seek = trim_input_seek(pip.trim_start);
        pip.trim_start -= seek;
        pip.video_input = inputs.len();
        match pip.cutout_path.clone() {
            // A cut-out's alpha only survives libvpx's own VP9 decoder (ffmpeg's native one drops
            // it). Its sound comes from the source, read from the same moment.
            Some(cutout) => {
                let mut input = seeking_input(cutout, seek);
                input.pre_args.splice(0..0, ["-c:v".to_string(), "libvpx-vp9".to_string()]);
                inputs.push(input);
                if pip.volume > 0.001 {
                    pip.audio_input = Some(inputs.len());
                    inputs.push(seeking_input(pip.source_path.clone(), seek));
                }
                if pip.cutout_background.as_ref().is_some_and(|b| b.kind == "blur") {
                    pip.background_input = Some(inputs.len());
                    inputs.push(seeking_input(pip.source_path.clone(), seek));
                }
            }
            None => inputs.push(seeking_input(pip.source_path.clone(), seek)),
        }
    }

    // Adjustment layers' region masks, after everything else (no index arithmetic above changes):
    // (input index, mask width, mask height) per layer that has one.
    let mut adjustment_masks: Vec<Option<(usize, i64, i64)>> = Vec::with_capacity(adjustment_layers.len());
    for (i, layer) in adjustment_layers.iter().enumerate() {
        let Some(data) = &layer.mask_data_base64 else {
            adjustment_masks.push(None);
            continue;
        };
        let path = match write_temp_overlay_png(data, 10_000 + i) {
            Ok(path) => path,
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        };
        temp_overlay_paths.push(path.clone());
        let (mw, mh) = image::image_dimensions(&path).map(|(w, h)| (w as i64, h as i64)).unwrap_or((0, 0));
        if mw < 2 || mh < 2 {
            adjustment_masks.push(None);
            continue;
        }
        adjustment_masks.push(Some((inputs.len(), mw, mh)));
        inputs.push(InputSpec {
            path: path.to_string_lossy().to_string(),
            pre_args: vec![
                "-loop".into(),
                "1".into(),
                "-framerate".into(),
                format!("{}", OVERLAY_INPUT_FPS),
                "-t".into(),
                format!("{:.3}", (layer.end_time - layer.start_time).clamp(0.01, total_duration.max(0.01)) + 0.1),
            ],
        });
    }

    // Video-track layers' mask PNGs - a single frame each (re-timed to the layer's start in the
    // graph): a looped still would make the alpha multiply emit a frame on the mask's own clock too.
    for (i, pip) in pip_overlays.iter_mut().enumerate() {
        let Some(data) = pip.mask_data_base64.take() else { continue };
        let path = match write_temp_overlay_png(&data, 20_000 + i) {
            Ok(path) => path,
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        };
        temp_overlay_paths.push(path.clone());
        pip.mask_input = Some(inputs.len());
        inputs.push(InputSpec::plain(path.to_string_lossy().to_string()));
    }
    // Moving masks' pictures, looped at the overlay rate for the layer's length (the per-frame size
    // follows the frame number - moving_mask_chain).
    for (i, pip) in pip_overlays.iter_mut().enumerate() {
        let Some(data) = pip.mask_motion.as_ref().map(|m| m.image_base64.clone()) else { continue };
        let path = match write_temp_overlay_png(&data, 40_000 + i) {
            Ok(path) => path,
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        };
        temp_overlay_paths.push(path.clone());
        pip.mask_motion_input = Some(inputs.len());
        inputs.push(InputSpec {
            path: path.to_string_lossy().to_string(),
            pre_args: vec!["-loop".into(), "1".into(), "-framerate".into(), format!("{}", OVERLAY_INPUT_FPS), "-t".into(), format!("{:.3}", (pip.end_time - pip.start_time).max(0.01) + 0.1)],
        });
    }
    // Cut-out backgrounds that are pictures - single frames too, like the masks.
    for (i, pip) in pip_overlays.iter_mut().enumerate() {
        let Some(bg) = pip.cutout_background.as_mut().filter(|b| b.kind == "image") else { continue };
        let Some(data) = bg.image_base64.take() else { continue };
        let path = match write_temp_overlay_png(&data, 30_000 + i) {
            Ok(path) => path,
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        };
        temp_overlay_paths.push(path.clone());
        pip.background_input = Some(inputs.len());
        inputs.push(InputSpec::plain(path.to_string_lossy().to_string()));
    }
    // Keyed layers are converted to RGB the way the webview decoded them (probe_browser_color).
    for pip in pip_overlays.iter_mut().filter(|p| p.chroma_key.is_some()) {
        let (ffprobe_path, source_path) = (get_ffprobe_path(&app_handle)?, pip.source_path.clone());
        pip.source_color = Some(blocking(move || probe_browser_color(&ffprobe_path, &source_path)).await?);
    }

    // Written next to the overlay PNGs (and cleaned up by the same loop once the export finishes).
    let captions_ass_path: Option<PathBuf> = match captions_ass.as_deref().filter(|a| !a.trim().is_empty()) {
        Some(ass) => {
            let path = std::env::temp_dir().join(format!("briefcast_captions_{}.ass", std::process::id()));
            if let Err(e) = std::fs::write(&path, ass) {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(format!("Failed to write captions file: {}", e));
            }
            temp_overlay_paths.push(path.clone());
            Some(path)
        }
        None => None,
    };

    let has_video_overlays = !overlays.is_empty();
    let has_blur_overlays = !blur_overlays.is_empty();
    let has_audio_overlays = !audio_overlays.is_empty();
    let has_pip_overlays = !pip_overlays.is_empty();
    // Any clip-level effect also needs the full filter graph - the fast -ss/-to path below has no
    // filter graph at all, so a color grade/Ken Burns/transition would have nowhere to be applied.
    // Graded clips' LUTs, written where ffmpeg can read them (lut3d needs a file) and deleted again
    // when this function returns, by TempFiles' Drop.
    let mut lut_files = TempFiles(Vec::new());
    let mut lut_paths: Vec<Option<String>> = Vec::with_capacity(segments.len());
    for (i, seg) in segments.iter().enumerate() {
        match &seg.lut_cube {
            Some(cube) => {
                let path = std::env::temp_dir().join(format!("briefcast_grade_{}_{}.cube", std::process::id(), i));
                std::fs::write(&path, cube).map_err(|e| format!("Failed to write a clip's color grade: {}", e))?;
                lut_paths.push(Some(escape_filter_path(&path)));
                lut_files.0.push(path);
            }
            None => lut_paths.push(None),
        }
    }
    // Stabilized clips' pass-1 analysis (cached after the first time), escaped for the filter.
    let mut stab_paths: Vec<Option<String>> = Vec::with_capacity(segments.len());
    for seg in &segments {
        stab_paths.push(match &seg.stabilize {
            Some(_) if !is_still_image_path(&seg.source_path) => {
                Some(escape_filter_path(&stabilization_transforms(&app_handle, &seg.source_path, seg.start, seg.end).await?))
            }
            _ => None,
        });
    }
    let has_clip_effects = segments.iter().any(segment_needs_filter_graph);
    // Any segment beyond the first requesting a transition - gates the pairwise xfade/acrossfade
    // fold below instead of the plain all-at-once `concat=n=N` the multi-segment branch has always
    // used, so a timeline with no transitions set takes the exact same, already-proven path it did
    // before this feature existed.
    let has_transitions = segments.iter().skip(1).any(|s| s.transition_in.is_some());

    // Plain cuts (nothing drawn, nothing re-timed or re-coloured) keep the source's own video
    // wherever whole GOPs survive - smart_render_export. "small" asks for recompression, so it
    // still re-encodes. Anything smart render can't do (or can't verify) falls through to the
    // normal render below.
    let has_adjustments = !adjustment_layers.is_empty();
    let plain_cuts = !has_video_overlays
        && !has_blur_overlays
        && !has_audio_overlays
        && !has_pip_overlays
        && !has_adjustments
        && !has_clip_effects
        && !has_transitions
        && video_fx_filters.is_empty()
        && captions_ass_path.is_none()
        && output_frame.is_none()
        && screen_style.is_none()
        && keystrokes.is_none()
        && quality.as_deref() != Some("small");
    if plain_cuts {
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        let mut has_audio = Vec::with_capacity(segments.len());
        for seg in &segments {
            let (probe, path) = (ffprobe_path.clone(), seg.source_path.clone());
            has_audio.push(blocking(move || probe_has_audio(&probe, &path)).await?);
        }
        let smart = smart_render_export(&app_handle, &window, state, &segments, &has_audio, effective_video_volume, &progress_key, output.clone()).await;
        match smart {
            Ok(Some(path)) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return finish_export(&app_handle, path, loudness_lufs, &chapters).await;
            }
            Ok(None) => {}
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        }
    }

    // A queued export's live preview frame output (RunExtras), filled in by whichever path runs.
    let mut preview_args: Vec<String> = Vec::new();
    // Sprite tracks' pictures and lists (the drawn pointer, shortcut chips), removed when the export
    // ends however it ends.
    let sprite_root = TempDir(std::env::temp_dir().join(format!(
        "briefcast_sprites_{}_{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    )));
    let owned_args: Vec<String> = if segments.len() == 1
        && !has_video_overlays
        && !has_blur_overlays
        && !has_audio_overlays
        && !has_pip_overlays
        && !has_adjustments
        && !has_clip_effects
        && captions_ass_path.is_none()
        && output_frame.is_none()
        && loudness_lufs.is_none()
        && screen_style.is_none()
        && keystrokes.is_none()
    {
        // Still the fast path even with a track volume/mute adjustment - that's a plain `-af`, no
        // filter graph needed just for it.
        let seg = &segments[0];
        // Seeks on the INPUT (keyframe, then frame-exact): as output options -ss/-to decoded the
        // whole file up to the cut first.
        if seg.start > 0.0 {
            inputs[0].pre_args = vec!["-ss".into(), format!("{:.6}", seg.start)];
        }
        if let Some(path) = &preview_frame {
            // Its own length too, or the preview output alone would read on to the file's end.
            preview_args = ["-map", "0:v:0", "-t"].iter().map(|s| s.to_string()).chain([format!("{:.6}", (seg.end - seg.start).max(0.0)), "-vf".into(), PREVIEW_FRAME_FILTER.into()]).chain(preview_output_args(path)).collect();
        }
        let mut args = vec![
            "-t".into(),
            format!("{:.6}", (seg.end - seg.start).max(0.0)),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "128k".into(),
            "-movflags".into(),
            "+faststart".into(),
        ];
        let mut af: Vec<String> = Vec::new();
        if (effective_video_volume - 1.0).abs() > 0.001 {
            af.push(format!("volume={:.3}", effective_video_volume));
        }
        af.extend(video_fx_filters.iter().cloned());
        if !af.is_empty() {
            args.push("-af".into());
            args.push(af.join(","));
        }
        args
    } else {
        // Each segment's input seeks to just before what it uses, and its times are re-based on
        // where that input now starts (segment_input_seek). After the stabilization analysis above,
        // which reads the file itself at absolute times.
        let ffmpeg_for_decode = get_ffmpeg_path(&app_handle)?;
        let ffprobe_for_decode = get_ffprobe_path(&app_handle)?;

        // The screen frame, the drawn pointer and the shortcut chips (the Screen Style panel) - their
        // inputs come after every other kind, so no index arithmetic above changes. Each clip's
        // pointer is timed from the clip's first frame (what its trimmed picture calls t=0), found
        // before the segments are re-timed for input seeking below.
        let fail = |e: String, temp: &[PathBuf]| {
            for path in temp {
                let _ = std::fs::remove_file(path);
            }
            e
        };
        let mut pointer_fragments: Vec<Option<String>> = vec![None; segments.len()];
        for (i, seg) in segments.iter().enumerate() {
            let Some(layers) = seg.pointer_layers.as_ref().filter(|l| !l.is_empty()) else { continue };
            let (ffprobe, path, at) = (ffprobe_for_decode.clone(), seg.source_path.clone(), seg.start);
            let first = blocking(move || probe_first_frame_at(&ffprobe, &path, at)).await?.unwrap_or(seg.start);
            let mut indices = Vec::with_capacity(layers.len());
            for (k, layer) in layers.iter().enumerate() {
                let list = write_sprite_track(layer, &sprite_root.0.join(format!("seg{i}_{k}")), first).map_err(|e| fail(e, &temp_overlay_paths))?;
                indices.push(inputs.len());
                inputs.push(sprite_track_input(&list));
            }
            pointer_fragments[i] = Some(pointer_fragment(i, layers, &indices, first));
        }
        let screen_style_input = match &screen_style {
            Some(ss) => {
                let path = write_temp_overlay_png(&ss.backdrop_base64, 50_000).map_err(|e| fail(e, &temp_overlay_paths))?;
                temp_overlay_paths.push(path.clone());
                inputs.push(InputSpec::plain(path.to_string_lossy().to_string()));
                Some(inputs.len() - 1)
            }
            None => None,
        };
        let keystroke_input = match &keystrokes {
            Some(track) => {
                let list = write_sprite_track(track, &sprite_root.0.join("keys"), 0.0).map_err(|e| fail(e, &temp_overlay_paths))?;
                inputs.push(sprite_track_input(&list));
                Some(inputs.len() - 1)
            }
            None => None,
        };

        let mut decode_choice: HashMap<String, bool> = HashMap::new();
        // Source seconds each file is read for - only a long read of a heavy source is worth racing.
        let mut seconds_from: HashMap<String, f64> = HashMap::new();
        for seg in &segments {
            *seconds_from.entry(seg.source_path.clone()).or_default() += seg.end - seg.start;
        }
        for (i, seg) in segments.iter_mut().enumerate() {
            // GPU decoding for heavy (1440p+) sources where it measurably wins on this machine -
            // see services/hw_decoder.rs.
            let worth_racing = seconds_from.get(&seg.source_path).copied().unwrap_or(0.0) >= crate::services::hw_decoder::MIN_SECONDS_TO_PROBE;
            if !is_still_image_path(&seg.source_path) && worth_racing {
                let hw = match decode_choice.get(&seg.source_path) {
                    Some(&hw) => hw,
                    None => {
                        let (ffmpeg, ffprobe, path, at) = (ffmpeg_for_decode.clone(), ffprobe_for_decode.clone(), seg.source_path.clone(), seg.start);
                        let hw = blocking(move || {
                            crate::services::smart_render::probe_source(&ffprobe, &path)
                                .is_some_and(|v| crate::services::hw_decoder::should_hw_decode(&ffmpeg, &path, &v.codec, v.width, v.height, at))
                        })
                        .await?;
                        decode_choice.insert(seg.source_path.clone(), hw);
                        hw
                    }
                };
                if hw {
                    inputs[i].pre_args.extend(["-hwaccel".into(), "auto".into()]);
                }
            }
            let seek = segment_input_seek(seg);
            if seek > 0.0 {
                inputs[i].pre_args.extend(["-ss".into(), format!("{seek:.6}")]);
                shift_segment_times(seg, seek);
            }
        }
        let mut filter = String::new();
        // Probed once up front (not per-branch) since all three shapes below - single segment,
        // plain concat, transition fold - need it: see audio_trim_chain's own doc comment for why.
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        // Only needed for "remove" mode clips; missing just falls back to afftdn per clip.
        let rnnoise_model = crate::services::utility::get_rnnoise_model_path(&app_handle)
            .ok()
            .filter(|p| p.exists())
            .map(|p| escape_filter_path(&p));

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
            segments
                .iter()
                .map(|s| s.source_path.clone())
                .filter(|p| seen.insert(p.clone()))
                .collect()
        };
        let audio_probe_handles: Vec<_> = unique_source_paths
            .iter()
            .filter(|path| !is_still_image_path(path))
            .map(|path| {
                let ffprobe_path = ffprobe_path.clone();
                let path = path.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    (path.clone(), probe_has_audio(&ffprobe_path, &path))
                })
            })
            .collect();
        // Falls back to a real probe only when the frontend didn't already resolve this AND some
        // segment actually needs it (crop/Ken Burns) - see probe_video_dimensions' own doc comment.
        let dimensions_probe_handle =
            if (video_width.is_none() || video_height.is_none()) && (has_clip_effects || has_transitions) {
                let ffprobe_path = ffprobe_path.clone();
                // A real video's size beats a photo's as the output frame - photos come in any
                // size/orientation, and an odd dimension would also break yuv420p encoding.
                let first_source = segments
                    .iter()
                    .find(|s| !is_still_image_path(&s.source_path))
                    .unwrap_or(&segments[0])
                    .source_path
                    .clone();
                Some(tauri::async_runtime::spawn_blocking(move || {
                    probe_video_dimensions(&ffprobe_path, &first_source)
                        .map(|(w, h)| ((w / 2 * 2).max(2), (h / 2 * 2).max(2)))
                }))
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
        let segment_has_audio: Vec<bool> = segments
            .iter()
            .map(|s| !is_still_image_path(&s.source_path) && *has_audio_by_path.get(&s.source_path).unwrap_or(&true))
            .collect();

        let (video_width, video_height): (Option<i64>, Option<i64>) = match dimensions_probe_handle
        {
            Some(handle) => match handle.await.ok().flatten() {
                Some((w, h)) => (Some(w), Some(h)),
                None => (video_width, video_height),
            },
            None => (video_width, video_height),
        };
        let has_image_segments = segments.iter().any(|s| is_still_image_path(&s.source_path));
        // Image segments can't be concatenated without a concrete output frame to fit them into,
        // so a timeline with images always has one - 1080p only if nothing else could say.
        let (video_width, video_height) = match (video_width, video_height) {
            (Some(w), Some(h)) => (Some(w), Some(h)),
            _ if has_image_segments => (Some(1920), Some(1080)),
            other => other,
        };
        // Ken Burns clocks itself by its source's own frame rate (ken_burns_chain) - one probe per
        // file that has one; a still is looped at IMAGE_SEGMENT_FPS.
        let mut kb_rates: HashMap<String, f64> = HashMap::new();
        for seg in segments.iter_mut().filter(|s| s.ken_burns.is_some()) {
            let rate = if is_still_image_path(&seg.source_path) {
                IMAGE_SEGMENT_FPS
            } else if let Some(rate) = kb_rates.get(&seg.source_path) {
                *rate
            } else {
                let (ffprobe_path, source_path) = (ffprobe_path.clone(), seg.source_path.clone());
                let rate = blocking(move || probe_frame_rate(&ffprobe_path, &source_path)).await?;
                kb_rates.insert(seg.source_path.clone(), rate);
                rate
            };
            seg.source_fps = Some(rate);
        }
        // Every segment gets fitted to the output frame once sources can differ in size - an
        // image anywhere, or clips from more than one file. A single-file timeline keeps its
        // exact pre-existing filter graph.
        // Transitions are drawn at the output size (transition_window_graph), so with any, every
        // segment is fitted to it too - exactly that size, frame for frame (a no-op scale for a
        // source already that size).
        let fit_frame = has_image_segments || unique_source_paths.len() > 1 || (has_transitions && video_width.is_some() && video_height.is_some());

        // Base video (trim, or trim+concat) always lands in a [base] node so the overlay chain
        // below has one consistent label to start from regardless of how many segments there were.
        if segments.len() == 1 {
            let seg = &segments[0];
            let extra = segment_effect_chain(seg, video_width, video_height, fit_frame, lut_paths[0].as_deref(), stab_paths[0].as_deref(), pointer_fragments[0].as_deref());
            let (end, vignette) = segment_vignette(seg, video_width, video_height, "base", 0);
            filter.push_str(&format!("{}[{end}];{vignette}", segment_video_chain("[0:v]", seg, &extra)));
            filter.push_str(&segment_audio_chain(
                segment_has_audio[0],
                0,
                seg,
                &segment_cleanup(seg, rnnoise_model.as_deref()),
                "outa",
            ));
        } else if !has_transitions {
            // Same segment-major trim+concat pattern as before this function grew overlay support
            // - concat's inputs must interleave [v0][a0][v1][a1]..., not group all video labels
            // before all audio ones, or ffmpeg rejects the whole filtergraph ("Media type
            // mismatch"). Untouched from before clip effects existed except for `extra` - a
            // timeline with no transitions takes this exact path regardless of color/Ken Burns.
            let mut concat_inputs = String::new();
            for (i, seg) in segments.iter().enumerate() {
                let extra = segment_effect_chain(seg, video_width, video_height, fit_frame, lut_paths[i].as_deref(), stab_paths[i].as_deref(), pointer_fragments[i].as_deref());
                let (end, vignette) = segment_vignette(seg, video_width, video_height, &format!("v{i}"), i);
                filter.push_str(&format!("{}[{end}];{vignette}", segment_video_chain(&format!("[{i}:v]"), seg, &extra)));
                filter.push_str(&segment_audio_chain(
                    segment_has_audio[i],
                    i,
                    seg,
                    &segment_cleanup(seg, rnnoise_model.as_deref()),
                    &format!("a{}", i),
                ));
                concat_inputs.push_str(&format!("[v{0}][a{0}]", i));
            }
            filter.push_str(&format!(
                "{}concat=n={}:v=1:a=1[base][outa];",
                concat_inputs,
                segments.len()
            ));
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
            // The first VIDEO segment's rate - an image has no rate of its own to offer (ffprobe
            // reports image2's arbitrary 25), so an all-image timeline uses IMAGE_SEGMENT_FPS.
            let target_fps = match segments.iter().find(|s| !is_still_image_path(&s.source_path)) {
                Some(seg) => {
                    let ffprobe_path = ffprobe_path.clone();
                    let source_path = seg.source_path.clone();
                    blocking(move || probe_frame_rate(&ffprobe_path, &source_path)).await?
                }
                None => IMAGE_SEGMENT_FPS,
            };

            // `settb=AVTB` too: xfade also demands both inputs share one timebase, but a plain
            // 2-way `concat` fold step (a boundary with no transition) outputs AVTB (1/1000000)
            // while an untouched segment is still at 1/fps - so an xfade following any concat
            // failed with "First input link main timebase ... do not match" (reproduced against
            // the bundled ffmpeg). Pinning every segment to AVTB makes all fold steps agree.
            for (i, seg) in segments.iter().enumerate() {
                let extra = segment_effect_chain(seg, video_width, video_height, fit_frame, lut_paths[i].as_deref(), stab_paths[i].as_deref(), pointer_fragments[i].as_deref());
                // A transition into the next clip plays this one's tail handle (transition_tail):
                // read past the cut, then split the tail off as [old{i+1}].
                match segments.get(i + 1).and_then(transition_window) {
                    Some(d) => {
                        let (end, vignette) = segment_vignette(seg, video_width, video_height, &format!("full{i}"), i);
                        filter.push_str(&format!(
                            "{},fps={:.3},settb=AVTB[{end}];{vignette}",
                            segment_video_chain_with_tail(&format!("[{i}:v]"), seg, &extra, tail_source_seconds(seg, d)),
                            target_fps
                        ));
                        filter.push_str(&transition_tail(
                            &format!("full{i}"),
                            &format!("v{i}"),
                            &format!("old{}", i + 1),
                            segment_output_duration(seg),
                            d,
                            target_fps,
                        ));
                    }
                    None => {
                        let (end, vignette) = segment_vignette(seg, video_width, video_height, &format!("v{i}"), i);
                        filter.push_str(&format!(
                            "{},fps={:.3},settb=AVTB[{end}];{vignette}",
                            segment_video_chain(&format!("[{i}:v]"), seg, &extra),
                            target_fps
                        ));
                    }
                }
                filter.push_str(&segment_audio_chain(
                    segment_has_audio[i],
                    i,
                    seg,
                    &segment_cleanup(seg, rnnoise_model.as_deref()),
                    &format!("a{}", i),
                ));
            }

            // Folds left-to-right: `accumulated` tracks the CURRENT duration of whatever
            // [cur_v]/[cur_a] point at right now, since xfade's own `offset` is relative to its
            // first input's timeline (not the original segment's own duration) once more than one
            // fold has already happened. Divided by speed - xfade/acrossfade operate on the
            // already-setpts'd (OUTPUT-time) streams built above, so every duration/offset here
            // needs to be in that same OUTPUT-time space, not raw source seconds.
            let mut cur_v = "v0".to_string();
            let mut cur_a = "a0".to_string();
            let mut accumulated = segment_output_duration(&segments[0]);
            for i in 1..segments.len() {
                let seg = &segments[i];
                let seg_dur = segment_output_duration(seg);
                let transition = seg
                    .transition_in
                    .as_ref()
                    .filter(|tr| tr.duration > 0.0)
                    .map(|tr| (sanitize_transition_name(&tr.transition_type), tr.duration));
                let look = seg.transition_in.as_ref().and_then(|tr| tr.look.as_ref());
                let (step, next_v, next_a) = transition_fold_step(&cur_v, &cur_a, i, accumulated, seg_dur, target_fps, video_width.zip(video_height), transition, look);
                filter.push_str(&step);
                accumulated += seg_dur;
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
        // Platform format: the assembled video fitted into it first, so every overlay below (and
        // the captions, laid out by the frontend at this same size) lands on the final frame.
        if let Some(frame) = &output_frame {
            filter.push_str(&reframe_chain(&current_label, "framed", frame));
            current_label = "framed".to_string();
        }
        // Adjustment layers placed "under" grade/blur the video itself - before blur regions and
        // every overlay, as the preview mounts them beneath VideoOverlayLayer.
        let adjust_frame = video_width.zip(video_height).map(|(w, h)| match &output_frame {
            Some(frame) => (frame.width, frame.height),
            None => (w, h),
        });
        let adjust_pass = |filter: &mut String, current_label: &mut String, over: bool| {
            let Some(frame) = adjust_frame else { return };
            for (i, layer) in adjustment_layers.iter().enumerate() {
                if (layer.placement == "over") != over {
                    continue;
                }
                let out = format!("adj{i}out");
                filter.push_str(&adjustment_layer_chain(layer, adjustment_masks[i], frame, current_label, &format!("adj{i}"), &out));
                *current_label = out;
            }
        };
        adjust_pass(&mut filter, &mut current_label, false);
        // Video tracks (PiP and B-roll layers) next, straight on the video: beneath blur regions,
        // pictures, text and captions - as the preview mounts PipOverlayLayer before
        // VideoOverlayLayer (Dashboard.tsx). They arrive bottom track first (videoTracks.ts
        // stackOrder), so each composites over the ones before it.
        for (i, pip) in pip_overlays.iter().enumerate() {
            let out_label = format!("pip{}out", i);
            filter.push_str(&pip_overlay_chain(pip, pip.video_input, i, &current_label, &out_label, adjust_frame));
            current_label = out_label;
        }
        for (i, bv) in blur_overlays.iter().enumerate() {
            let out_label = format!("bb{}out", i);
            filter.push_str(&blur_region_chain(bv, i, blur_mask_input_index[i], &current_label, &out_label));
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
            let mut source_label = format!("{}:v", overlay_input_base + i);
            // Every overlay input (a frame sequence, or a still looped for its own window) starts
            // at timestamp 0 - shifted to start at the overlay's own start_time, so everything
            // below (fade st=, the opacity commands, the enable window) reads absolute output times.
            {
                let shifted = format!("ovseq{}", i);
                filter.push_str(&format!(
                    "[{}]format=rgba,setpts=PTS-STARTPTS+{:.4}/TB[{}];",
                    source_label, ov.start_time, shifted
                ));
                source_label = shifted;
            }
            let animation = sanitize_overlay_animation(&ov.animation);
            let composited_label = if animation == "fade" || animation == "zoom" {
                // The preview's ramp: 0.4s, or half the overlay's length if that's shorter.
                let ramp = overlay_animation_ramp(ov.start_time, ov.end_time);
                let faded_label = format!("ovfade{}", i);
                let fade_out_start = (ov.end_time - ramp).max(ov.start_time);
                filter.push_str(&format!(
                    "[{}]fade=in:st={:.3}:d={ramp:.4}:alpha=1,fade=out:st={:.3}:d={ramp:.4}:alpha=1[{}];",
                    source_label, ov.start_time, fade_out_start, faded_label
                ));
                faded_label
            } else {
                source_label
            };
            let (mut x_expr, mut y_expr) = overlay_position_expr(ov, animation);
            let mut composited_label = composited_label;
            let kfs = ov.keyframes.as_ref().filter(|k| !k.is_empty());
            let flips = animation == "flip";
            let kf_scales = kfs.is_some_and(|kfs| kfs.iter().any(|k| (k.scale - 1.0).abs() > 1e-3));
            // The overlay's scale over time in `tv`: its keyframed scale times pop's overshoot -
            // the preview multiplies the two the same way (the box's scale() transform inside the
            // keyframe layer's). None when it never scales.
            let scale_at = |tv: &str| -> Option<String> {
                let kf = kfs.filter(|_| kf_scales).map(|kfs| keyframe_expr(kfs, tv, |k| k.scale.max(0.01)));
                let pop = overlay_anim_scale_expr(animation, ov.start_time, ov.end_time, tv);
                match (kf, pop) {
                    (Some(a), Some(b)) => Some(format!("({a})*({b})")),
                    (a, b) => a.or(b),
                }
            };
            // Scale per frame - `n` counts this input's frames, which start at start_time.
            let frame_time = format!("({:.4}+n/{})", ov.start_time, OVERLAY_INPUT_FPS);
            // A flip squashes the width on top (overlay_flip_sx_expr).
            let squash_at = |tv: &str| flips.then(|| overlay_flip_sx_expr(ov.start_time, ov.end_time, tv));
            if let Some(s) = scale_at(&frame_time) {
                let sx = squash_at(&frame_time).map(|q| format!("({s})*({q})")).unwrap_or_else(|| s.clone());
                let scaled = format!("ovkfs{}", i);
                filter.push_str(&format!(
                    "[{composited_label}]scale=w='max(2,trunc(iw*({sx})/2)*2)':h='max(2,trunc(ih*({s})/2)*2)':eval=frame[{scaled}];"
                ));
                composited_label = scaled;
            }
            if let Some(kfs) = kfs {
                // Keyframed opacity: one alpha factor per frame (opacity_commands), applied by
                // colorchannelmixer - a multiply per pixel, where the per-pixel expression it
                // replaces (geq) cost ~1µs a pixel.
                if kfs.iter().any(|k| (k.opacity - 1.0).abs() > 1e-3) {
                    let faded = format!("ovkfa{}", i);
                    filter.push_str(&format!(
                        "[{composited_label}]format=rgba,{},colorchannelmixer@ka{i}=aa=1[{faded}];",
                        opacity_commands(kfs, &format!("colorchannelmixer@ka{i}"), ov.start_time, ov.end_time)
                    ));
                    composited_label = faded;
                }
                // A slide still plays on top of keyframed motion, as in the preview: its offset
                // from the resting spot is added to the keyframed position.
                let (slide_x, slide_y) = overlay_slide_offset_expr(ov, animation);
                x_expr = format!("({})+({slide_x})", keyframe_expr(kfs, "t", |k| k.x));
                y_expr = format!("({})+({slide_y})", keyframe_expr(kfs, "t", |k| k.y));
            }
            if let Some(s) = scale_at("t") {
                // Scaled about the box's centre, as the preview does.
                let sx = squash_at("t").map(|q| format!("({s})*({q})")).unwrap_or_else(|| s.clone());
                x_expr = format!("({x_expr})+overlay_w*(1/({sx})-1)/2");
                y_expr = format!("({y_expr})+overlay_h*(1/({s})-1)/2");
            }
            // Never "outv" itself - later stages (PiP, adjustment layers, captions) read from here;
            // the final rename below names whatever ran last.
            let next_label = format!("ov{}", i);
            // A blend mode composites through blend_composite instead: over the overlay's own box
            // when it stays put, the whole frame when anything moves it.
            if let (Some(mode), Some(frame), Some((w, h))) = (ov.blend_mode.as_deref().and_then(blend_mode_ffmpeg), adjust_frame, overlay_layer_size(ov)) {
                let moving = kfs.is_some() || animation.starts_with("slide") || animation == "drop" || scale_at("t").is_some();
                let layer = BlendLayer { label: &composited_label, x: x_expr.clone(), y: y_expr.clone(), width: w, height: h, moving, fps: OVERLAY_INPUT_FPS };
                filter.push_str(&blend_composite(&current_label, &layer, frame, mode, ov.start_time, ov.end_time, &format!("ovb{i}"), &next_label));
                current_label = next_label;
                continue;
            }
            filter.push_str(&format!(
                "[{}][{}]overlay=x='{}':y='{}':enable='between(t,{:.3},{:.3})'[{}];",
                current_label,
                composited_label,
                x_expr,
                y_expr,
                ov.start_time,
                ov.end_time,
                next_label
            ));
            current_label = next_label;
        }

        // Adjustment layers placed "over" act on everything composited so far (captions excepted).
        adjust_pass(&mut filter, &mut current_label, true);

        // The screen frame (wallpaper, padding, corners, shadow) goes around the whole edited
        // picture - clips, layers, blurs, pictures and text shrink into it together, so nothing
        // placed on the video ever moves off what it was placed on. Only the shortcut chips and
        // captions sit on the frame itself, as in the preview.
        if let (Some(ss), Some(input), Some(frame)) = (&screen_style, screen_style_input, adjust_frame) {
            filter.push_str(&screen_style_chain(&current_label, input, ss, frame, "styled"));
            current_label = "styled".to_string();
        }

        // Shortcut chips over everything but the captions, as the preview stacks them.
        if let (Some(track), Some(input)) = (&keystrokes, keystroke_input) {
            filter.push_str(&sprite_track_overlay(track, input, 0.0, &current_label, "keys", "keysout"));
            current_label = "keysout".to_string();
        }

        // Whatever [current_label] is pointing at (the plain trim/concat [base], or the last blur/
        // image/text/pip stage that actually ran) needs to end up named [outv] for the -map below -
        // covers every combination of "any blur regions" x "any text/image overlays" x "any PiP
        // layers" with one check, rather than the single `!has_video_overlays` special case this
        // used to be before blur/pip support existed (back when [base] was the only possible
        // "nothing chained" label).
        // Captions last, so they sit above every image/text/blur/PiP layer.
        if let Some(ass_path) = &captions_ass_path {
            filter.push_str(&format!(
                "[{}]ass=filename='{}'[capv];",
                current_label,
                escape_filter_path(ass_path)
            ));
            current_label = "capv".to_string();
        }

        if let Some(path) = &preview_frame {
            // The queue's live preview: a small copy of the finished picture, a couple of frames
            // per second of output, split off the very last stage.
            filter.push_str(&format!("[{current_label}]split=2[outv][prevtap];[prevtap]{PREVIEW_FRAME_FILTER}[prevv];"));
            preview_args = ["-map", "[prevv]"].iter().map(|s| s.to_string()).chain(preview_output_args(path)).collect();
        } else if current_label != "outv" {
            filter.push_str(&format!("[{}]copy[outv];", current_label));
        }

        // Applies the track-level mute/volume to [outa] (the original video's own trimmed/
        // concatenated audio, built above) before anything else reads it - both the no-overlays
        // map below and the amix mixing block further down consume whichever label this produces.
        // Skipped entirely (base_audio_label just stays "outa") when the volume is untouched, so a
        // video nobody's adjusted this for doesn't grow an extra no-op filter node.
        let mut base_audio_label = if (effective_video_volume - 1.0).abs() > 0.001 {
            filter.push_str(&format!(
                "[outa]volume={:.3}[outa_vol];",
                effective_video_volume
            ));
            "outa_vol"
        } else {
            "outa"
        };
        // The video sound's mixer channel, after its volume - as the preview's effects sit after
        // the element's own volume.
        if !video_fx_filters.is_empty() {
            filter.push_str(&format!("[{base_audio_label}]{}[outa_fx];", video_fx_filters.join(",")));
            base_audio_label = "outa_fx";
        }

        // Which pip overlays actually contribute audio - the frontend already collapses its own
        // "play this clip's own audio" toggle into volume=0 when off (see PipOverlay.muted,
        // videoEditTypes.ts), so a plain volume>0 check covers that; probe_has_audio additionally
        // guards against a pip source with NO audio stream at all (e.g. the webcam sidecar
        // FormData.separate_webcam_capture itself produces, which is video-only by design - see
        // win.rs) - without this, a stray `[idx:a]` on a video-only input would reject the whole
        // filtergraph with "Stream specifier ':a' ... matches no streams", the same failure mode
        // probe_has_audio already exists to prevent for segments.
        let pip_audio_probes: Vec<_> = pip_overlays
            .iter()
            .map(|p| {
                let audible = p.volume > 0.001;
                let ffprobe_path = ffprobe_path.clone();
                let source_path = p.source_path.clone();
                // Spawned (not just created) here, so every probe runs concurrently. The channel
                // count is what tells a mono source apart (mono_to_stereo_filter).
                tauri::async_runtime::spawn_blocking(move || {
                    if audible && probe_has_audio(&ffprobe_path, &source_path) {
                        Some(probe_audio_channels(&ffprobe_path, &source_path))
                    } else {
                        None
                    }
                })
            })
            .collect();
        let mut pip_audio_input_index: Vec<Option<usize>> = Vec::with_capacity(pip_overlays.len());
        let mut pip_audio_channels: Vec<Option<u32>> = Vec::with_capacity(pip_overlays.len());
        for (i, probe) in pip_audio_probes.into_iter().enumerate() {
            let probed = probe
                .await
                .map_err(|e| format!("Background task failed: {}", e))?;
            pip_audio_input_index.push(probed.map(|_| pip_overlays[i].audio_input.unwrap_or(pip_overlays[i].video_input)));
            pip_audio_channels.push(probed.flatten());
        }
        // Audio overlays' channel counts, for the same mono up-mix.
        let overlay_channel_probes: Vec<_> = audio_overlays
            .iter()
            .map(|o| {
                let (ffprobe_path, source_path) = (ffprobe_path.clone(), o.source_path.clone());
                tauri::async_runtime::spawn_blocking(move || probe_audio_channels(&ffprobe_path, &source_path))
            })
            .collect();
        let mut overlay_channels: Vec<Option<u32>> = Vec::with_capacity(audio_overlays.len());
        for probe in overlay_channel_probes {
            overlay_channels.push(probe.await.map_err(|e| format!("Background task failed: {}", e))?);
        }
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
                let upmix = mono_to_stereo_filter(overlay_channels[i]).map(|f| format!("{f},")).unwrap_or_default();
                let mut chain = format!(
                    "[{}:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,{}volume={:.3}",
                    input_index, audio_ov.trim_start, trim_end, upmix, audio_ov.volume
                );
                if let Some(duck) = audio_ov.duck.as_ref().and_then(|d| duck_volume_filter(d, audio_ov.start_time, audio_ov.end_time - audio_ov.start_time)) {
                    chain.push(',');
                    chain.push_str(&duck);
                }
                if audio_ov.fade_in > 0.0 {
                    chain.push_str(&format!(",afade=t=in:st=0:d={:.3}", audio_ov.fade_in));
                }
                if audio_ov.fade_out > 0.0 {
                    let track_duration = audio_ov.end_time - audio_ov.start_time;
                    let fade_out_start = (track_duration - audio_ov.fade_out).max(0.0);
                    chain.push_str(&format!(
                        ",afade=t=out:st={:.3}:d={:.3}",
                        fade_out_start, audio_ov.fade_out
                    ));
                }
                for f in audio_ov.fx.as_ref().map(audio_fx_filters).unwrap_or_default() {
                    chain.push(',');
                    chain.push_str(&f);
                }
                let delay_ms = (audio_ov.start_time * 1000.0).round().max(0.0);
                let track_label = format!("aov{}", i);
                filter.push_str(&format!(
                    "{},adelay={:.0}:all=1[{}];",
                    chain, delay_ms, track_label
                ));
                mix_inputs.push_str(&format!("[{}]", track_label));
            }
            // Same atrim+volume+adelay shape as the audio-overlay loop above, minus fade in/out
            // (pip has no fade controls of its own) - skips any pip pip_audio_input_index marked
            // None (muted, or a source with no audio stream at all).
            let mut pip_audio_count = 0;
            for (i, pip) in pip_overlays.iter().enumerate() {
                let Some(input_index) = pip_audio_input_index[i] else {
                    continue;
                };
                let trim_end = pip.trim_start + (pip.end_time - pip.start_time);
                let delay_ms = (pip.start_time * 1000.0).round().max(0.0);
                let track_label = format!("pipa{}", i);
                let upmix = mono_to_stereo_filter(pip_audio_channels[i]).map(|f| format!("{f},")).unwrap_or_default();
                let fx: String = pip.fx.as_ref().map(audio_fx_filters).unwrap_or_default().iter().map(|f| format!(",{f}")).collect();
                filter.push_str(&format!(
                    "[{idx}:a]atrim=start={ts:.3}:end={te:.3},asetpts=PTS-STARTPTS,{upmix}volume={vol:.3}{fx},adelay={delay:.0}:all=1[{label}];",
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
        // (A loudness target is applied after the render - see normalize_loudness.)

        // Trailing `;` is harmless to ffmpeg either way, but trimmed for consistency with how the
        // original concat-only filter string here was always built without one.
        let filter = filter.trim_end_matches(';').to_string();
        // A long graph (many clips, transitions' per-frame commands, keyframed overlays) goes to
        // ffmpeg as a script file: Windows caps a whole command line at 32,767 characters.
        let (graph_flag, graph_arg) = if filter.len() > 8000 {
            let script = std::env::temp_dir().join(format!("briefcast_graph_{}.txt", std::process::id()));
            std::fs::write(&script, &filter).map_err(|e| format!("Failed to write the export's filter graph: {}", e))?;
            temp_overlay_paths.push(script.clone());
            // `-/option file` reads the option's value from a file (ffmpeg 7+); the old
            // -filter_complex_script spelling was removed in ffmpeg 8.
            ("-/filter_complex", script.to_string_lossy().to_string())
        } else {
            ("-filter_complex", filter)
        };

        vec![
            graph_flag.into(),
            graph_arg,
            "-map".into(),
            "[outv]".into(),
            "-map".into(),
            format!("[{}]", audio_label),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "128k".into(),
            "-movflags".into(),
            "+faststart".into(),
        ]
    };

    // The video encoder: this machine's proven hardware encoder at the tier's calibrated quality
    // (HwEncoding::export_args - same picture as x264, many times faster), else software x264.
    // A hardware encode that fails for any reason other than the user cancelling is re-run in
    // software, so a flaky driver costs time, never the export.
    let software: Vec<String> = ["-c:v", "libx264", "-preset", quality_preset, "-crf", quality_crf].iter().map(|s| s.to_string()).collect();
    let tier = quality.clone().unwrap_or_default();
    let ffmpeg_for_probe = get_ffmpeg_path(&app_handle)?;
    let hardware = blocking(move || crate::services::hw_encoder::detect(&ffmpeg_for_probe)).await?.and_then(|hw| hw.export_args(&tier));
    let encoders: Vec<Vec<String>> = hardware.into_iter().chain(std::iter::once(software)).collect();
    let output_seconds: f64 = segments.iter().map(segment_output_duration).sum();

    let extras = RunExtras {
        preview: job_id.as_ref().zip(preview_frame.clone()).filter(|_| !preview_args.is_empty()).map(|(id, path)| (id.clone(), path)),
        preview_args,
        low_priority: job_id.is_some(),
    };
    let mut result = Err("No encoder to run".to_string());
    for (attempt, video_encoder) in encoders.iter().enumerate() {
        let codec_args: Vec<&str> = owned_args.iter().chain(video_encoder.iter()).map(|s| s.as_str()).collect();
        result = run_conversion_with(&app_handle, &window, state, &inputs, &progress_key, output.clone(), &codec_args, Some(output_seconds), &extras).await;
        let cancelled = state.cancelled.load(std::sync::atomic::Ordering::SeqCst);
        if result.is_ok() || cancelled || attempt + 1 == encoders.len() {
            break;
        }
        log::warn!("Hardware export encode failed, re-running in software: {:?}", result.as_ref().err());
    }

    for temp_path in &temp_overlay_paths {
        let _ = std::fs::remove_file(temp_path);
    }

    finish_export(&app_handle, result?, loudness_lufs, &chapters).await
}

// ffmpeg arguments writing the live preview frame (RunExtras) after whatever selects its stream.
const PREVIEW_FRAME_FILTER: &str = "fps=2,scale=-2:240:flags=bilinear";
fn preview_output_args(path: &Path) -> Vec<String> {
    ["-an", "-sn", "-f", "image2", "-update", "1", "-atomic_writing", "1", "-q:v", "5"]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(path.to_string_lossy().to_string()))
        .collect()
}

// What every finished export still gets: its loudness target, then its chapters.
async fn finish_export(app_handle: &AppHandle, path: String, loudness_lufs: Option<f64>, chapters: &[ChapterSpec]) -> Result<String, String> {
    if let Some(target) = loudness_lufs {
        normalize_loudness(app_handle, &path, target).await?;
    }
    if !chapters.is_empty() {
        embed_chapters(app_handle, &path, chapters).await?;
    }
    Ok(path)
}

// Chapters into the file itself (MP4/MOV chapter atoms - VLC, QuickTime, most players list them)
// by a stream-copy remux, and into its .chapters.json sidecar so Briefcast's own player shows them.
async fn embed_chapters(app_handle: &AppHandle, path: &str, chapters: &[ChapterSpec]) -> Result<(), String> {
    let mut sorted: Vec<ChapterSpec> = chapters.iter().filter(|c| c.time.is_finite() && c.time >= 0.0).cloned().collect();
    sorted.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    if sorted.is_empty() {
        return Ok(());
    }
    let ffmpeg = get_ffmpeg_path(app_handle)?;
    let ffprobe = get_ffprobe_path(app_handle)?;
    let target = PathBuf::from(path);
    let duration = {
        let (probe, p) = (ffprobe.clone(), target.clone());
        blocking(move || probe_duration_secs(&probe, &p)).await?.unwrap_or(0.0)
    };
    // ffmetadata: each chapter runs to the next one (the last to the end); its title escaped.
    let escape = |s: &str| s.replace('\\', "\\\\").replace('=', "\\=").replace(';', "\\;").replace('#', "\\#").replace('\n', " ");
    let mut meta = String::from(";FFMETADATA1\n");
    for (i, c) in sorted.iter().enumerate() {
        let end = sorted.get(i + 1).map(|n| n.time).unwrap_or(duration.max(c.time + 0.001));
        meta.push_str(&format!("[CHAPTER]\nTIMEBASE=1/1000\nSTART={}\nEND={}\ntitle={}\n", (c.time * 1000.0).round() as i64, (end * 1000.0).round() as i64, escape(&c.label)));
    }
    let meta_path = std::env::temp_dir().join(format!("briefcast_chapters_{}.txt", std::process::id()));
    std::fs::write(&meta_path, meta).map_err(|e| format!("Couldn't write the chapters: {}", e))?;
    let ext = target.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "mp4".into());
    let remuxed = target.with_extension(format!("chapters.{ext}"));
    let args: Vec<String> = vec![
        "-v".into(), "error".into(), "-y".into(), "-i".into(), path.to_string(), "-i".into(), meta_path.to_string_lossy().to_string(),
        "-map".into(), "0".into(), "-map_metadata".into(), "0".into(), "-map_chapters".into(), "1".into(), "-c".into(), "copy".into(),
        "-movflags".into(), "+faststart".into(), remuxed.to_string_lossy().to_string(),
    ];
    let ran = blocking(move || run_ffmpeg_quiet(&ffmpeg, &args)).await?;
    let _ = std::fs::remove_file(&meta_path);
    match ran {
        Ok(()) => std::fs::rename(&remuxed, &target).map_err(|e| format!("Couldn't add the chapters: {}", e))?,
        Err(e) => {
            // The video itself is fine - only its chapters are missing.
            let _ = std::fs::remove_file(&remuxed);
            log::warn!("Embedding chapters failed: {e}");
        }
    }
    let sidecar: Vec<serde_json::Value> = sorted
        .iter()
        .map(|c| serde_json::json!({ "id": format!("ch-{}", (c.time * 1000.0).round() as i64), "time": c.time, "label": c.label }))
        .collect();
    crate::services::video_edits::save_video_chapters(path.to_string(), serde_json::to_string(&sidecar).unwrap_or_default())
}

// Integrated loudness (LUFS) of a file's audio, measured with ffmpeg's EBU R128 scanner.
fn measure_loudness(ffmpeg_path: &PathBuf, path: &str) -> Result<f64, String> {
    let mut cmd = Command::new(ffmpeg_path);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.args(["-hide_banner", "-nostats", "-i", path, "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
    let log = String::from_utf8_lossy(&out.stderr);
    // The summary's "I: -17.4 LUFS" line (the last one - the per-frame log is off).
    log.lines()
        .filter_map(|l| l.trim().strip_prefix("I:"))
        .filter_map(|v| v.trim().trim_end_matches("LUFS").trim().parse::<f64>().ok())
        .last()
        .ok_or_else(|| "Couldn't measure the export's loudness".to_string())
}

// Loudness target: the finished export's audio is re-rendered with the gain that lands it on
// `target` LUFS (EBU R128 integrated); the picture is copied untouched.
//
// - The chain (loudness_chain) is the gain, then a lookahead peak limiter holding peaks near
//   -2 dBFS (room for AAC's overshoot). A short release shaves the peaks inside each syllable rather
//   than ducking whole words: on dense speech (every syllable within a few dB of the loudest) a
//   40ms release took back 11 of 15 dB of gain on the way to -14 LUFS, 8ms takes back ~5. No
//   compressor: the loudness then rises smoothly and monotonically with the gain, which is what
//   makes the search exact.
// - The gain is searched with measure-only passes (decode -> chain -> R128 scanner, nothing
//   written): secant steps, safeguarded by bisection once the target is bracketed. Limited,
//   high-crest audio bends the curve well below 1:1, which is what the secant follows.
// - Then the audio alone is encoded once and checked (AAC moves the result by a few hundredths),
//   with one correction if needed, and muxed back next to the copied video.
const LOUDNESS_TOLERANCE_LU: f64 = 0.1;
const LOUDNESS_MAX_SEARCH_PASSES: usize = 10;
const LOUDNESS_MAX_GAIN_DB: f64 = 30.0;

fn loudness_chain(gain: f64) -> String {
    // latency=1: the 2ms lookahead is compensated, so the sound stays in sync with the picture.
    format!("volume={gain:.3}dB,alimiter=limit=0.79:attack=2:release=8:level=false:latency=1")
}

// Integrated loudness of `path`'s audio after `chain`, without writing anything.
fn measure_loudness_through(ffmpeg_path: &PathBuf, path: &str, chain: &str) -> Result<f64, String> {
    let mut cmd = Command::new(ffmpeg_path);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let af = format!("{chain},ebur128=framelog=quiet");
    cmd.args(["-hide_banner", "-nostats", "-i", path, "-vn", "-af", &af, "-f", "null", "-"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
    let log = String::from_utf8_lossy(&out.stderr);
    log.lines()
        .filter_map(|l| l.trim().strip_prefix("I:"))
        .filter_map(|v| v.trim().trim_end_matches("LUFS").trim().parse::<f64>().ok())
        .last()
        .ok_or_else(|| "Couldn't measure the export's loudness".to_string())
}

// The gain search on a monotone gain -> loudness curve `f`: secant steps from `first_gain`, kept
// inside the bracket once the target is crossed (bisecting when a step would leave it). Returns the
// gain whose result was closest, and that result.
fn search_loudness_gain(target: f64, first_gain: f64, mut f: impl FnMut(f64) -> Result<f64, String>) -> Result<(f64, f64), String> {
    let clamp_gain = |g: f64| g.clamp(-LOUDNESS_MAX_GAIN_DB, LOUDNESS_MAX_GAIN_DB);
    let mut gain = clamp_gain(first_gain);
    let mut best: Option<(f64, f64)> = None; // (gain, result)
    let mut previous: Option<(f64, f64)> = None;
    let mut below: Option<f64> = None; // a gain known to land under the target
    let mut above: Option<f64> = None; // ... and over it
    for _ in 0..LOUDNESS_MAX_SEARCH_PASSES {
        let result = f(gain)?;
        if best.map_or(true, |(_, r)| (target - result).abs() < (target - r).abs()) {
            best = Some((gain, result));
        }
        if (target - result).abs() <= LOUDNESS_TOLERANCE_LU {
            break;
        }
        if result < target {
            below = Some(below.map_or(gain, |b: f64| b.max(gain)));
        } else {
            above = Some(above.map_or(gain, |a: f64| a.min(gain)));
        }
        let slope = match previous {
            Some((g0, r0)) if (gain - g0).abs() > 1e-6 && (result - r0).abs() > 1e-3 => ((result - r0) / (gain - g0)).clamp(0.02, 1.5),
            _ => 1.0,
        };
        previous = Some((gain, result));
        let mut next = clamp_gain(gain + (target - result) / slope);
        if let (Some(lo), Some(hi)) = (below, above) {
            if !(next > lo.min(hi) && next < lo.max(hi)) {
                next = (lo + hi) / 2.0;
            }
        }
        if (next - gain).abs() < 1e-3 {
            break; // pinned at the gain limit, or the curve has flattened out (limiter wall)
        }
        gain = next;
    }
    best.ok_or_else(|| "Couldn't measure the export's loudness".to_string())
}

async fn normalize_loudness(app_handle: &AppHandle, path: &str, target: f64) -> Result<(), String> {
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let target = target.clamp(-30.0, -5.0);
    let file = path.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let measured = measure_loudness(&ffmpeg_path, &file)?;
        if !measured.is_finite() || measured < -70.0 || (target - measured).abs() < LOUDNESS_TOLERANCE_LU {
            return Ok(()); // silent, or already on target
        }
        let (mut gain, searched) =
            search_loudness_gain(target, target - measured, |g| measure_loudness_through(&ffmpeg_path, &file, &loudness_chain(g)))?;

        let source = PathBuf::from(&file);
        let temps = TempFiles(vec![source.with_extension("loudness.m4a"), source.with_extension("loudness.mp4")]);
        let (audio, muxed) = (&temps.0[0], &temps.0[1]);
        let encode = |g: f64| -> Result<f64, String> {
            let args: Vec<String> = vec![
                "-i".into(), file.clone(), "-vn".into(), "-af".into(), loudness_chain(g),
                "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(), path_to_str(audio)?.to_string(),
            ];
            run_ffmpeg_quiet(&ffmpeg_path, &args).map_err(|e| format!("Couldn't adjust the export's loudness: {}", e))?;
            measure_loudness(&ffmpeg_path, path_to_str(audio)?)
        };
        let mut result = encode(gain)?;
        // AAC shifts it by a few hundredths at most; one correction if that crossed the tolerance.
        if (target - result).abs() > LOUDNESS_TOLERANCE_LU && (target - searched).abs() <= LOUDNESS_TOLERANCE_LU {
            gain += target - result;
            result = encode(gain)?;
        }
        let args: Vec<String> = vec![
            "-i".into(), file.clone(), "-i".into(), path_to_str(audio)?.to_string(),
            "-map".into(), "0".into(), "-map".into(), "-0:a".into(), "-map".into(), "1:a".into(),
            "-c".into(), "copy".into(), "-movflags".into(), "+faststart".into(), path_to_str(muxed)?.to_string(),
        ];
        run_ffmpeg_quiet(&ffmpeg_path, &args).map_err(|e| format!("Couldn't save the loudness-adjusted export: {}", e))?;
        std::fs::rename(muxed, &source).map_err(|e| format!("Failed to save the loudness-adjusted export: {}", e))?;
        log::info!("[export] loudness {:.2} LUFS -> {:.2} (target {:.1}, gain {:+.2} dB)", measured, result, target, gain);
        Ok(())
    })
    .await
    .map_err(|e| format!("Loudness task panicked: {e}"))?
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
) -> Result<String, String> {
    if end <= start {
        return Err("End must be after start".to_string());
    }
    let speed = speed.max(0.25).min(16.0);
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

// Cancel ongoing conversion
#[tauri::command]
pub async fn cancel_conversion(state: State<'_, ConversionState>) -> Result<(), String> {
    cancel_state(&state).await
}

async fn cancel_state(state: &ConversionState) -> Result<(), String> {
    let mut active_process = state.active_process.lock().await;
    // Always raised: a smart render's parallel jobs (run_smart_jobs) watch this flag rather than
    // one tracked process.
    state.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);

    if let Some(pid) = active_process.take() {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/F", "/PID", &pid.to_string()]);
            hide_console_window(&mut cmd);
            blocking(move || cmd.output())
                .await?
                .map_err(|e| format!("Failed to cancel conversion: {}", e))?;
        }

        #[cfg(not(windows))]
        {
            let mut cmd = Command::new("kill");
            cmd.args(["-9", &pid.to_string()]);
            blocking(move || cmd.output())
                .await?
                .map_err(|e| format!("Failed to cancel conversion: {}", e))?;
        }

        Ok(())
    } else {
        // Nothing tracked by pid - a smart render in progress stops on the flag set above.
        Ok(())
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
        let _ = window.emit(
            "batch-conversion-progress",
            serde_json::json!({
                "current_file": input_path,
                "current_index": index,
                "total_files": total_files,
                "overall_progress": progress,
            }),
        );

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
        )
        .await
        {
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
    let read_path = file_path.clone();
    let bytes = blocking(move || std::fs::read(&read_path))
        .await?
        .map_err(|e| format!("Failed to read image file: {}", e))?;
    let mime = match file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
    {
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
// something to drop into an <img src>. Answered as raw bytes (tauri::ipc::Response, an
// ArrayBuffer on the JS side) rather than Vec<u8>, which serde would turn into a JSON array of
// numbers several times the file's size.
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = blocking(move || std::fs::read(&path))
        .await?
        .map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
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
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        path_to_str(&input)?,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = blocking(move || cmd.output())
        .await?
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    let mut info = HashMap::new();
    info.insert("input_path".to_string(), input_path);

    let file_size = input.metadata().map(|m| m.len() / 1_000_000).unwrap_or(0);
    info.insert("input_size".to_string(), format!("{} MB", file_size));

    info.insert(
        "output_path".to_string(),
        input.with_extension("mp4").to_string_lossy().to_string(),
    );

    if let Ok(probe) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
        if let Some(duration) = probe["format"]["duration"]
            .as_str()
            .and_then(|d| d.parse::<f64>().ok())
        {
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
        ],
        "mov" => vec![
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
        ],
        "mkv" => vec!["-c:v", "libx264", "-preset", "medium", "-c:a", "aac"],
        "avi" => vec!["-c:v", "libx264", "-c:a", "mp3"],
        "webm" => vec!["-c:v", "libvpx", "-c:a", "libvorbis"],
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
        cmd.args([
            "-af",
            &format!("silencedetect=noise={noise_db}dB:d={min_duration}"),
            "-f",
            "null",
            "-",
        ]);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
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
async fn run_ffmpeg_capture(ffmpeg_path: PathBuf, args: Vec<String>) -> Result<Vec<u8>, String> {
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

fn f32le_to_vec(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

// Peak of each channel per bucket, for interleaved stereo frames. Kept pure for testing.
fn bucket_peaks(frames: &[f32], buckets: usize) -> Vec<f32> {
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
    let args: Vec<String> = vec![
        "-v".into(), "error".into(), "-i".into(), source_path,
        "-vn".into(), "-ac".into(), "1".into(), "-ar".into(), "22050".into(),
        "-f".into(), "f32le".into(), "pipe:1".into(),
    ];
    let bytes = run_ffmpeg_capture(ffmpeg_path, args).await?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let samples: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        crate::services::beat_detect::track_beats(&samples, 22050.0)
    })
    .await
    .map_err(|e| format!("Beat detection task panicked: {e}"))?
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

#[cfg(test)]
mod tests {
    #[test]
    fn duck_filter_is_local_to_the_overlay_and_skips_far_ranges() {
        let duck = DuckEnvelope { level: 0.25, attack: 0.25, release: 0.5, ranges: vec![[11.0, 13.0], [50.0, 51.0], [2.0, 3.0]] };
        // Overlay plays output 10..20: only the 11..13 range touches it, shifted to local 1..3.
        let f = super::duck_volume_filter(&duck, 10.0, 10.0).unwrap();
        assert_eq!(f, "volume='1-0.750*min(1,clip((t-0.750)/0.250,0,1)*clip((3.500-t)/0.500,0,1))':eval=frame");
        // A range starting before the overlay gives a "+" offset, never "--".
        let early = DuckEnvelope { ranges: vec![[9.0, 12.0]], ..duck };
        assert!(super::duck_volume_filter(&early, 10.0, 10.0).unwrap().contains("clip((t+1.250)/0.250"));
        let none = DuckEnvelope { level: 1.0, attack: 0.25, release: 0.5, ranges: vec![[11.0, 12.0]] };
        assert!(super::duck_volume_filter(&none, 10.0, 10.0).is_none());
    }

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
            audio_cleanup: None,
            lut_cube: None,
            stabilize: None,
            speed_steps: None,
            muted: None,
            pointer_layers: None,
            source_fps: None,
            fx: None,
        }
    }

    #[test]
    fn an_overlay_frame_sequence_counts_as_present_when_its_first_frame_is() {
        let frames = OverlayFrames { unique: vec![BASE64.encode([137u8, 80, 78, 71])], sequence: vec![0, 0, 0] };
        let mut created = Vec::new();
        let pattern = write_temp_overlay_sequence(&frames, 9_999, &mut created).expect("frames written");
        let input = InputSpec { path: pattern.clone(), pre_args: vec!["-framerate".into(), "30".into(), "-start_number".into(), "0".into()] };
        assert!(!PathBuf::from(&pattern).exists(), "the pattern itself is not a file");
        assert!(input.existing_path().exists(), "{pattern}");
        for path in &created {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn a_muted_clip_renders_silence_of_its_own_length() {
        let seg = KeepSegment { muted: Some(true), end: 4.0, ..base_segment() };
        assert!(segment_needs_filter_graph(&seg));
        let audio = segment_audio_chain(true, 2, &seg, &(vec![], None), "a2");
        assert!(audio.starts_with("anullsrc") && audio.contains("duration=4.000"), "{audio}");
    }

    // ---- segment_speed / segment_noise_reduction_db --------------------------------------------

    #[test]
    fn segment_speed_defaults_to_1x_when_unset() {
        assert_eq!(segment_speed(&base_segment()), 1.0);
    }

    #[test]
    fn segment_speed_clamps_to_0_25_16_range() {
        let mut seg = base_segment();
        seg.speed = Some(100.0);
        assert_eq!(segment_speed(&seg), 16.0);
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

    #[test]
    fn segment_noise_reduction_params_maps_0_to_1_onto_the_full_nr_nf_pair() {
        let mut seg = base_segment();
        seg.noise_reduction = Some(1.0);
        assert_eq!(segment_noise_reduction_params(&seg), Some((40.0, -20.0)));

        seg.noise_reduction = Some(0.5);
        assert_eq!(segment_noise_reduction_params(&seg), Some((22.0, -35.0)));

        seg.noise_reduction = Some(0.0);
        assert_eq!(segment_noise_reduction_params(&seg), None);
    }

    // ---- segment_needs_filter_graph ---------------------------------------------------------------

    #[test]
    fn segment_needs_filter_graph_is_false_for_a_plain_trim() {
        assert!(!segment_needs_filter_graph(&base_segment()));
    }

    #[test]
    fn segment_needs_filter_graph_is_true_for_noise_reduction_alone() {
        // Regression case: a single-segment timeline whose ONLY edit is noise reduction (no crop,
        // speed, color grade, etc.) used to be misclassified as needing no filter graph at all,
        // which meant export_trimmed_video's fast -ss/-to path was taken and afftdn never got
        // applied - see this function's own doc comment.
        let mut seg = base_segment();
        seg.noise_reduction = Some(0.5);
        assert!(segment_needs_filter_graph(&seg));

        // 0/None must still count as "off", same convention segment_noise_reduction_db itself uses.
        let mut off = base_segment();
        off.noise_reduction = Some(0.0);
        assert!(!segment_needs_filter_graph(&off));
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
    fn pop_scales_from_nothing_past_full_size_and_back() {
        let s = overlay_pop_scale_expr(1.0, 3.0, "t");
        // The preview's ease-out-back over a 0.4s ramp at each end.
        assert!(s.contains("clip(min((t-1.000)/0.4000,(3.000-t)/0.4000),0,1)") && s.contains("2.70158*pow("), "{s}");
        // A very short overlay ramps over half its length, as the preview does.
        assert!(overlay_pop_scale_expr(1.0, 1.5, "t").contains("/0.2500"));
    }

    #[test]
    fn sanitize_overlay_animation_passes_through_allowed_values_only() {
        assert_eq!(sanitize_overlay_animation("slide-left"), "slide-left");
        assert_eq!(sanitize_overlay_animation("pop"), "pop"); // burned in as a per-frame scale
        assert_eq!(sanitize_overlay_animation("anything-else"), "none");
    }

    #[test]
    fn pip_crop_fragment_skips_full_frame_and_clamps() {
        assert_eq!(pip_crop_fragment(None), "");
        assert_eq!(
            pip_crop_fragment(Some(PipCrop { x: 0.0, y: 0.0, width: 1.0, height: 1.0 })),
            ""
        );
        assert_eq!(
            pip_crop_fragment(Some(PipCrop { x: 0.25, y: 0.1, width: 0.5, height: 0.8 })),
            "crop=w=iw*0.500000:h=ih*0.800000:x=iw*0.250000:y=ih*0.100000,"
        );
        // Zero-area and overflowing crops are clamped rather than handed to ffmpeg as-is.
        assert_eq!(
            pip_crop_fragment(Some(PipCrop { x: 0.99, y: 0.0, width: 0.0, height: 1.0 })),
            "crop=w=iw*0.050000:h=ih*1.000000:x=iw*0.950000:y=ih*0.000000,"
        );
        assert_eq!(pip_crop_fragment(Some(PipCrop { x: f64::NAN, y: 0.0, width: 0.5, height: 0.5 })), "");
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
        let cf = ClipColorFilter {
            preset: "none".to_string(),
            intensity: 0.7,
        };
        assert_eq!(color_filter_chain(&cf), "");
    }

    #[test]
    fn color_filter_chain_bw_at_full_intensity_is_css_grayscale() {
        let cf = ClipColorFilter {
            preset: "bw".to_string(),
            intensity: 1.0,
        };
        // CSS grayscale(1): every channel = 0.2126 R + 0.7152 G + 0.0722 B.
        let chain = color_filter_chain(&cf);
        assert!(chain.starts_with(",format=rgba,colorchannelmixer=rr=0.212600:rg=0.715200:rb=0.072200:ra=0.000000:gr=0.212600:"), "{chain}");
        assert!(chain.ends_with(":aa=1,format=yuv420p"), "{chain}");
    }

    #[test]
    fn color_filter_chain_clamps_out_of_range_intensity() {
        let over = ClipColorFilter { preset: "bw".to_string(), intensity: 5.0 };
        let full = ClipColorFilter { preset: "bw".to_string(), intensity: 1.0 };
        assert_eq!(color_filter_chain(&over), color_filter_chain(&full)); // clamped to 1.0
        // Clamped to 0: grayscale(0) is the identity.
        let under = ClipColorFilter { preset: "bw".to_string(), intensity: -5.0 };
        assert!(color_filter_chain(&under).contains("rr=1.000000:rg=0.000000:rb=0.000000:ra=0.000000"), "{}", color_filter_chain(&under));
    }

    #[test]
    fn css_color_ops_compose_like_the_browser() {
        // contrast then saturate: M = S*C, o = S*(0.5-0.5c) - an affine map, applied in one pass.
        let (m, o) = compose_css_color_ops(&[CssColorOp::Contrast(2.0), CssColorOp::Saturate(1.0)]);
        assert!((m[0][0] - 2.0).abs() < 1e-9 && m[0][1].abs() < 1e-9 && (o[0] + 0.5).abs() < 1e-9);
        // A grey stays grey through any saturate / hue-rotate (their rows sum to 1).
        let (m, o) = compose_css_color_ops(&[CssColorOp::Saturate(1.6), CssColorOp::HueRotate(37.0)]);
        for r in 0..3 {
            assert!(((m[r][0] + m[r][1] + m[r][2]) * 0.4 + o[r] - 0.4).abs() < 1e-6);
        }
        // Every preset at zero intensity is the identity (only cinematic's fixed hue nudge isn't).
        for preset in ["vibrant", "bw", "warm", "cool"] {
            let chain = color_filter_chain(&ClipColorFilter { preset: preset.to_string(), intensity: 0.0 });
            assert!(chain.contains("rr=1.000000:rg=0.000000:rb=0.000000:ra=0.000000:gr=0.000000:gg=1.000000"), "{preset}: {chain}");
        }
    }

    #[test]
    fn a_vignette_is_a_layer_over_the_finished_frame() {
        let mut seg = base_segment();
        seg.color_filter = Some(ClipColorFilter { preset: "vignette".to_string(), intensity: 1.0 });
        let (end, graph) = segment_vignette(&seg, Some(1280), Some(720), "v2", 2);
        assert_eq!(end, "v2nv");
        assert!(graph.starts_with("color=black:s=320x180:") && graph.ends_with("[v2nv][vig2]overlay=shortest=1:format=auto[v2];"), "{graph}");
        // Not a colour map, and without a frame size, ffmpeg's own vignette.
        assert_eq!(color_filter_chain(seg.color_filter.as_ref().unwrap()), "");
        assert!(segment_effect_chain(&seg, None, None, false, None, None, None).contains(",vignette="));
        assert!(!segment_effect_chain(&seg, Some(1280), Some(720), false, None, None, None).contains("vignette"));
    }

    #[test]
    fn segments_seek_to_just_before_what_they_use() {
        let mut seg = base_segment();
        seg.start = 600.0;
        seg.end = 620.0;
        assert_eq!(segment_input_seek(&seg), 599.0);
        // A noise sample earlier in the file pulls the seek back to it.
        seg.audio_cleanup = Some(AudioCleanup { noise_sample: Some(NoiseSample { start: 100.0, end: 101.0 }), ..Default::default() });
        assert_eq!(segment_input_seek(&seg), 99.0);
        seg.speed_steps = Some(vec![SpeedStep { source_start: 600.0, source_end: 610.0, speed: 2.0 }]);
        shift_segment_times(&mut seg, 99.0);
        assert_eq!((seg.start, seg.end), (501.0, 521.0));
        assert_eq!(seg.speed_steps.as_ref().unwrap()[0].source_start, 501.0);
        let sample = seg.audio_cleanup.as_ref().unwrap().noise_sample.unwrap();
        assert_eq!((sample.start, sample.end), (1.0, 2.0));
        // Near the file's start, and stills: no seek.
        seg.start = 0.4;
        seg.audio_cleanup = None;
        assert_eq!(segment_input_seek(&seg), 0.0);
        seg.source_path = "photo.jpg".into();
        seg.start = 300.0;
        assert_eq!(segment_input_seek(&seg), 0.0);
        assert_eq!(trim_input_seek(42.5), 41.5);
        assert_eq!(trim_input_seek(0.3), 0.0);
    }

    #[test]
    fn keyframed_opacity_is_per_frame_commands_only_where_it_changes() {
        let kf = |time: f64, opacity: f64| OverlayKeyframe { time, x: 0.0, y: 0.0, scale: 1.0, opacity, easing: "linear".into() };
        let cmds = opacity_commands(&[kf(10.0, 0.0), kf(11.0, 1.0)], "colorchannelmixer@ka0", 10.0, 60.0);
        assert!(cmds.starts_with("sendcmd=c='10.0000 colorchannelmixer@ka0 aa 0.0000;"), "{cmds}");
        assert!(cmds.ends_with("11.0000 colorchannelmixer@ka0 aa 1.0000'"), "{cmds}");
        // 31 frames across the fade, nothing for the 49s it then holds.
        assert_eq!(cmds.matches("aa ").count(), 31, "{cmds}");
        assert!((keyframe_value(&[kf(0.0, 0.0), kf(2.0, 1.0)], 0.5, |k| k.opacity) - 0.25).abs() < 1e-9);
    }

    #[test]
    fn crop_chain_clamps_position_so_the_window_never_crosses_the_far_edge() {
        // x=0.9 with width=0.5 would crop past the right edge (0.9+0.5 > 1.0) - x must clamp to
        // 1.0-width=0.5, not the raw 0.9 the caller passed.
        let c = ClipCrop {
            x: 0.9,
            y: 0.0,
            width: 0.5,
            height: 0.5,
        };
        assert_eq!(
            crop_chain(&c),
            ",crop=w='iw*0.5000':h='ih*0.5000':x='iw*0.5000':y='ih*0.0000'"
        );
    }

    #[test]
    fn crop_chain_rejects_a_degenerate_near_zero_area_crop() {
        let c = ClipCrop {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
        // width/height floor at 0.05, never truly 0.
        assert_eq!(
            crop_chain(&c),
            ",crop=w='iw*0.0500':h='ih*0.0500':x='iw*0.0000':y='ih*0.0000'"
        );
    }

    #[test]
    fn ken_burns_chain_unrecognized_preset_is_a_noop() {
        let kb = ClipKenBurns {
            preset: "sparkle".to_string(),
            intensity: None,
            target_x: None,
            target_y: None,
            span: None,
        };
        assert_eq!(ken_burns_chain(&kb, 5.0, 1920, 1080, 30.0), "");
    }

    #[test]
    fn every_ken_burns_motion_animates_per_frame_on_the_source_clock() {
        for preset in [
            "zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down", "push", "punch-in", "bounce-in", "drift", "sway", "float", "breathe", "pulse",
            "shake", "vibrate",
        ] {
            let kb = ClipKenBurns { preset: preset.to_string(), intensity: Some(0.7), target_x: None, target_y: None, span: None };
            let chain = ken_burns_chain(&kb, 4.0, 1280, 720, 29.97);
            // Held to the source rate first, so the frame number is an exact clock.
            assert!(chain.starts_with(",fps=29.9700,perspective=x0='"), "{preset}: {chain}");
            assert!(chain.contains("(in-1)/29.9700/4.0000") && chain.contains(":eval=frame"), "{preset}: {chain}");
            assert!(chain.ends_with(",scale=1280:720"), "{preset}: {chain}");
        }
    }

    #[test]
    fn ken_burns_chain_zoom_in_ends_at_the_scaled_output_resolution() {
        let kb = ClipKenBurns {
            preset: "zoom-in".to_string(),
            intensity: Some(1.0),
            target_x: None,
            target_y: None,
            span: None,
        };
        let chain = ken_burns_chain(&kb, 5.0, 1920, 1080, 30.0);
        assert!(
            chain.contains(",perspective="),
            "expected a per-frame perspective window, got: {chain}"
        );
        assert!(
            chain.ends_with(",scale=1920:1080"),
            "expected a trailing scale to output resolution, got: {chain}"
        );
    }

    #[test]
    fn ken_burns_chain_continues_a_split_move_over_its_span() {
        let kb = ClipKenBurns {
            preset: "zoom-in".to_string(),
            intensity: Some(1.0),
            target_x: None,
            target_y: None,
            span: Some([0.5, 1.0]),
        };
        let chain = ken_burns_chain(&kb, 4.0, 1920, 1080, 30.0);
        assert!(chain.contains("(0.500000+0.500000*min((in-1)/30.0000/4.0000,1))"), "{chain}");
    }

    #[test]
    fn loudness_search_lands_on_a_limited_curve() {
        // A limiter wall: 1:1 up to -16 LUFS, then only 0.15 LU per dB.
        let curve = |g: f64| {
            let raw = -30.0 + g;
            if raw < -16.0 { raw } else { -16.0 + 0.15 * (raw + 16.0) }
        };
        let mut evals = 0;
        let (gain, result) = search_loudness_gain(-14.0, 16.0, |g| { evals += 1; Ok(curve(g)) }).unwrap();
        assert!((result + 14.0).abs() <= LOUDNESS_TOLERANCE_LU, "result {result} gain {gain} after {evals}");
        assert!(evals <= LOUDNESS_MAX_SEARCH_PASSES);
    }

    #[test]
    fn loudness_search_stops_at_the_gain_limit_when_unreachable() {
        let (gain, result) = search_loudness_gain(-5.0, 20.0, |g| Ok(-40.0 + 0.2 * g)).unwrap();
        assert!((gain - LOUDNESS_MAX_GAIN_DB).abs() < 1e-9);
        assert!((result - (-40.0 + 0.2 * LOUDNESS_MAX_GAIN_DB)).abs() < 1e-9);
    }

    #[test]
    fn loudness_chain_is_one_shape_for_every_gain() {
        assert_eq!(loudness_chain(-1.0), "volume=-1.000dB,alimiter=limit=0.79:attack=2:release=8:level=false:latency=1");
        assert!(loudness_chain(12.0).starts_with("volume=12.000dB,alimiter"));
    }

    // ---- segment_effect_chain - ordering matters (mirrored in VideoPlayer.tsx's own preview) -----

    #[test]
    fn segment_effect_chain_applies_hflip_before_color_before_crop() {
        let mut seg = base_segment();
        seg.flip_horizontal = Some(true);
        seg.color_filter = Some(ClipColorFilter {
            preset: "bw".to_string(),
            intensity: 1.0,
        });
        seg.crop = Some(ClipCrop {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        });
        let chain = segment_effect_chain(&seg, Some(1920), Some(1080), false, None, None, None);
        let hflip_pos = chain.find("hflip").expect("hflip missing");
        let color_pos = chain.find("colorchannelmixer").expect("color filter missing");
        let crop_pos = chain.find("crop=").expect("crop missing");
        assert!(
            hflip_pos < color_pos && color_pos < crop_pos,
            "wrong order: {chain}"
        );
    }

    #[test]
    fn segment_effect_chain_skips_the_extra_scale_when_ken_burns_will_scale_anyway() {
        let mut seg = base_segment();
        seg.crop = Some(ClipCrop {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        });
        seg.ken_burns = Some(ClipKenBurns {
            preset: "zoom-in".to_string(),
            intensity: Some(0.5),
            target_x: None,
            target_y: None,
            span: None,
        });
        let chain = segment_effect_chain(&seg, Some(1920), Some(1080), false, None, None, None);
        // Exactly one scale=1920:1080 (Ken Burns' own trailing one), not two.
        assert_eq!(chain.matches("scale=1920:1080").count(), 1);
    }

    #[test]
    fn segment_effect_chain_with_no_effects_is_empty() {
        assert_eq!(
            segment_effect_chain(&base_segment(), Some(1920), Some(1080), false, None, None, None),
            ""
        );
    }

    // ---- audio_trim_chain -----------------------------------------------------------------------

    #[test]
    fn audio_trim_chain_no_audio_synthesizes_silence_of_the_right_output_duration() {
        // 10 source seconds at 2x speed -> 5 output seconds.
        let chain = audio_trim_chain(false, 0, 0.0, 10.0, 2.0, &(vec![], None), "outa");
        assert_eq!(
            chain,
            "anullsrc=channel_layout=stereo:sample_rate=44100:duration=5.000[outa];"
        );
    }

    #[test]
    fn audio_trim_chain_with_audio_includes_tempo_but_no_denoise_when_off() {
        let chain = audio_trim_chain(true, 0, 1.0, 5.0, 1.0, &(vec![], None), "outa");
        assert_eq!(
            chain,
            "[0:a]atrim=start=1.000:end=5.000,asetpts=PTS-STARTPTS,atempo=1.0000[outa];"
        );
    }

    #[test]
    fn audio_trim_chain_appends_afftdn_after_atempo_when_noise_reduction_is_set() {
        let chain = audio_trim_chain(true, 2, 0.0, 5.0, 1.0, &(vec!["afftdn=nr=22.00:nf=-35.0".to_string()], None), "a2");
        assert_eq!(
            chain,
            "[2:a]atrim=start=0.000:end=5.000,asetpts=PTS-STARTPTS,atempo=1.0000,afftdn=nr=22.00:nf=-35.0[a2];"
        );
    }

    // ---- audio_cleanup_filters --------------------------------------------------------------------

    #[test]
    fn audio_cleanup_filters_is_empty_when_nothing_is_on() {
        assert!(audio_cleanup_filters(None, None, None).is_empty());
        assert!(audio_cleanup_filters(Some(0.0), Some(&AudioCleanup::default()), Some("m")).is_empty());
    }

    #[test]
    fn audio_cleanup_filters_orders_lowcut_hum_denoise_gate() {
        let cleanup = AudioCleanup { low_cut: Some(true), hum: Some(50), gate: Some(true), ..Default::default() };
        let f = audio_cleanup_filters(Some(0.5), Some(&cleanup), None);
        assert_eq!(f[0], "highpass=f=80");
        assert_eq!(&f[1..4], ["bandreject=f=50:t=q:w=8", "bandreject=f=100:t=q:w=8", "bandreject=f=150:t=q:w=8"]);
        assert_eq!(f[4], "afftdn=nr=22.00:nf=-35.0");
        assert!(f[5].starts_with("agate="));
    }

    #[test]
    fn audio_cleanup_filters_remove_mode_uses_arnndn_and_falls_back_without_a_model() {
        let cleanup = AudioCleanup { mode: Some("remove".into()), ..Default::default() };
        assert_eq!(audio_cleanup_filters(Some(1.0), Some(&cleanup), Some("C\\:/m.rnnn")), ["arnndn=m='C\\:/m.rnnn':mix=1.00"]);
        assert_eq!(audio_cleanup_filters(Some(1.0), Some(&cleanup), None), ["afftdn=nr=40.00:nf=-20.0"]);
    }

    #[test]
    fn audio_cleanup_filters_appends_levelling_last() {
        let cleanup = AudioCleanup { gate: Some(true), level: Some(true), ..Default::default() };
        let f = audio_cleanup_filters(None, Some(&cleanup), None);
        assert!(f[0].starts_with("agate="));
        assert_eq!(&f[1..], ["speechnorm=e=4:r=0.0001:l=1", "loudnorm=I=-16:TP=-1.5:LRA=11", "aresample=48000"]);
    }

    #[test]
    fn noise_sample_learns_from_the_prefix_then_trims_it_off() {
        let cleanup = AudioCleanup { noise_sample: Some(NoiseSample { start: 5.3, end: 6.3 }), ..Default::default() };
        let sample = cleanup_noise_sample(Some(1.0), Some(&cleanup), None);
        assert_eq!(sample, Some((5.3, 6.3)));
        let f = audio_cleanup_filters_with_sample(Some(1.0), Some(&cleanup), None, sample.map(|(s, e)| e - s));
        assert_eq!(f[0], "asendcmd=c='0.000 afftdn sample_noise start;0.999 afftdn sample_noise stop'");
        assert_eq!(f[1], "afftdn=nr=40.00:nf=-28.0");
        assert_eq!(f[2], "atrim=start=1.000000");
        assert_eq!(f[3], "asetpts=PTS-STARTPTS");
        let branch = audio_branch("[0:a]", 0.0, 40.0, 1.0, &f, sample, "a0");
        assert!(branch.starts_with("[0:a]asplit=2[a0_m][a0_s];[a0_s]atrim=start=5.300:end=6.300"));
        assert!(branch.contains("[a0_n][a0_t]concat=n=2:v=0:a=1,asendcmd="));
        assert!(branch.ends_with("[a0];"));
    }

    #[test]
    fn noise_sample_is_ignored_when_off_too_short_or_in_remove_mode() {
        let mut cleanup = AudioCleanup { noise_sample: Some(NoiseSample { start: 1.0, end: 1.05 }), ..Default::default() };
        assert_eq!(cleanup_noise_sample(Some(1.0), Some(&cleanup), None), None);
        cleanup.noise_sample = Some(NoiseSample { start: 1.0, end: 30.0 });
        assert_eq!(cleanup_noise_sample(Some(1.0), Some(&cleanup), None), Some((1.0, 11.0)));
        assert_eq!(cleanup_noise_sample(Some(0.0), Some(&cleanup), None), None);
        cleanup.mode = Some("remove".into());
        assert_eq!(cleanup_noise_sample(Some(1.0), Some(&cleanup), Some("m")), None);
    }

    #[test]
    fn bucket_peaks_takes_per_channel_maxima() {
        let frames = [0.1, -0.5, -0.3, 0.2, 0.05, 0.0, 0.0, 0.9];
        assert_eq!(bucket_peaks(&frames, 2), vec![0.3, 0.5, 0.05, 0.9]);
    }

    #[test]
    fn audio_cleanup_filters_ignores_unknown_hum_frequencies() {
        let cleanup = AudioCleanup { hum: Some(55), ..Default::default() };
        assert!(audio_cleanup_filters(None, Some(&cleanup), None).is_empty());
    }

    #[test]
    fn escape_filter_path_escapes_drive_colon_and_backslashes() {
        assert_eq!(escape_filter_path(std::path::Path::new(r"C:\a\b.rnnn")), r"C\:/a/b.rnnn");
    }

    // ---- overlay animation expressions ------------------------------------------------------------

    #[test]
    fn overlay_position_expr_none_and_fade_are_static_coordinates() {
        let ov = OverlayImage {
            blend_mode: None,
            data_base64: String::new(),
            x: 100,
            y: 200,
            start_time: 0.0,
            end_time: 5.0,
            animation: "none".to_string(),
            keyframes: None,
            frames: None,
        };
        assert_eq!(
            overlay_position_expr(&ov, "none"),
            ("100".to_string(), "200".to_string())
        );
        assert_eq!(
            overlay_position_expr(&ov, "fade"),
            ("100".to_string(), "200".to_string())
        );
    }

    #[test]
    fn overlay_position_expr_slide_left_only_animates_x() {
        let ov = OverlayImage {
            blend_mode: None,
            data_base64: String::new(),
            x: 100,
            y: 200,
            start_time: 0.0,
            end_time: 5.0,
            animation: "slide-left".to_string(),
            keyframes: None,
            frames: None,
        };
        let (x, y) = overlay_position_expr(&ov, "slide-left");
        assert_eq!(y, "200"); // y untouched
        assert!(
            x.contains("main_w"),
            "expected an x expression referencing main_w, got: {x}"
        );
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

    // Real round-trip against libheif's own CLI tools (not a pure-function unit test like the
    // ones above) - encodes a tiny synthetic image to HEIC with heif-enc, then decodes it back via
    // heic_unix::decode_to_png, and checks a valid same-size PNG comes out. This is the one part
    // of the macOS/Linux HEIC gap that CI can fully prove correctness for (not just compilation) -
    // see heic_unix.rs's own doc comment for why this needs a system-installed libheif rather than
    // a bundled one, and the CI workflow for the exact install step this test relies on.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn heic_unix_decode_round_trip_produces_a_valid_png() {
        use image::{GenericImageView, Rgb, RgbImage};

        let dir = std::env::temp_dir().join(format!("briefcast_test_heic_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Dimensions/content don't matter for proving the decode round-trip works - heif-enc just
        // needs *some* valid source image.
        let source_png = dir.join("source.png");
        let mut img = RgbImage::new(16, 16);
        for pixel in img.pixels_mut() {
            *pixel = Rgb([200, 100, 50]);
        }
        img.save(&source_png)
            .expect("failed to write synthetic source PNG");

        let heic_path = dir.join("source.heic");
        let encode = std::process::Command::new("heif-enc")
            .arg(&source_png)
            .arg("-o")
            .arg(&heic_path)
            .output()
            .expect(
                "heif-enc not found - install libheif's example tools to run this test locally \
                 (see heic_unix.rs's own doc comment for the exact package per OS)",
            );
        assert!(
            encode.status.success(),
            "heif-enc failed: {}",
            String::from_utf8_lossy(&encode.stderr)
        );
        assert!(heic_path.exists(), "heif-enc produced no output file");

        let decoded_png = dir.join("decoded.png");
        tauri::async_runtime::block_on(crate::services::heic_unix::decode_to_png(
            heic_path.clone(),
            decoded_png.clone(),
        ))
        .expect("heic_unix::decode_to_png failed");

        let decoded = image::open(&decoded_png).expect("decoded output is not a valid image");
        assert_eq!(decoded.dimensions(), (16, 16));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- image clips -----------------------------------------------------------------------------

    #[test]
    fn still_image_paths_are_recognized_case_insensitively() {
        assert!(is_still_image_path("C:/photos/IMG_0001.JPG"));
        assert!(is_still_image_path("shot.png"));
        assert!(is_still_image_path("scan.webp"));
        assert!(!is_still_image_path("clip.mp4"));
        assert!(is_still_image_path("photo.HEIC"));
        assert!(is_heic_path("photo.heif") && !is_heic_path("photo.jpg"));
        assert!(!is_still_image_path("My video.briefvideo"));
    }

    #[test]
    fn image_segments_always_need_the_filter_graph() {
        let seg = KeepSegment { source_path: "photo.jpg".to_string(), end: 5.0, ..base_segment() };
        assert!(segment_needs_filter_graph(&seg));
        assert!(!segment_needs_filter_graph(&base_segment()));
    }

    #[test]
    fn frame_fit_letterboxes_before_any_clip_effect() {
        let seg = KeepSegment { source_path: "photo.jpg".to_string(), flip_horizontal: Some(true), ..base_segment() };
        let chain = segment_effect_chain(&seg, Some(1920), Some(1080), true, None, None, None);
        let fit = chain.find("pad=1920:1080").expect("pads to the output frame");
        let flip = chain.find("hflip").expect("still applies the clip's own effects");
        assert!(fit < flip, "fit must come first so effects see the output-sized frame: {chain}");
        assert!(chain.contains("force_original_aspect_ratio=decrease"), "never stretches: {chain}");
        assert!(chain.contains("format=yuv420p"), "images get converted to the encode format: {chain}");
    }

    #[test]
    fn frame_fit_is_skipped_unless_requested() {
        let seg = KeepSegment { source_path: "photo.jpg".to_string(), ..base_segment() };
        assert_eq!(segment_effect_chain(&seg, Some(1920), Some(1080), false, None, None, None), "");
        assert!(!frame_fit_chain(1280, 720, false).contains("format="), "videos keep their own pixel format");
    }

    #[test]
    fn proxy_size_caps_the_long_edge_and_stays_even() {
        assert_eq!(proxy_size(1920, 1080), (1920, 1080));
        assert_eq!(proxy_size(3840, 2160), (1920, 1080));
        assert_eq!(proxy_size(1080, 1920), (1080, 1920));
        let (w, h) = proxy_size(4001, 3001);
        assert!(w <= PROXY_MAX_EDGE && h <= PROXY_MAX_EDGE && w % 2 == 0 && h % 2 == 0);
    }

    // ---- transition_fold_step ------------------------------------------------------------------

    #[test]
    fn transition_draws_the_outgoing_tail_over_the_incoming_head() {
        let (step, v, a) = transition_fold_step("v0", "a0", 1, 5.0, 5.0, 30.0, Some((1920, 1080)), Some(("fade", 1.0)), None);
        assert_eq!((v.as_str(), a.as_str()), ("fold1v", "fold1a"));
        // The incoming clip's first second gets the transition, the rest follows untouched.
        assert!(step.starts_with("[v1]split[vh1][vr1];[vh1]trim=end=1.000000[head1];[vr1]trim=start=1.000000,setpts=PTS-STARTPTS,fps=30.000[rest1];"), "{step}");
        assert!(step.contains("[old1]format=yuva420p,fade=t=out:st=0:d=1.0000:alpha=1[oc1];[head1][oc1]overlay=eof_action=pass[tr1];"), "{step}");
        // Pinned to the timeline's rate - an unknown one would reach the encoder as 25fps.
        assert!(step.ends_with("[v0][tr1][rest1]concat=n=3:v=1:a=0,fps=30.000,settb=AVTB[fold1v];[a0][a1]concat=n=2:v=0:a=1[fold1a];"), "audio just cuts: {step}");
        assert!(!step.contains("xfade"), "{step}");
    }

    #[test]
    fn a_segment_reads_its_tail_handle_and_splits_it_off() {
        let mut seg = base_segment();
        seg.start = 2.0;
        seg.end = 6.0;
        seg.speed = Some(2.0);
        // Plays on at its end speed: 0.5s of transition = 1s of source, plus slack.
        assert!((tail_source_seconds(&seg, 0.5) - 1.1).abs() < 1e-9);
        assert!(segment_video_chain_with_tail("[0:v]", &seg, "", 1.1).starts_with("[0:v]trim=start=2.000:end=7.100,"));
        // Stabilized clips hold their last frame instead.
        seg.stabilize = Some(StabilizeSettings { strength: 0.5 });
        assert_eq!(tail_source_seconds(&seg, 0.5), 0.0);
        let split = transition_tail("full0", "v0", "old1", 2.0, 0.5, 30.0);
        assert!(split.starts_with("[full0]tpad=stop_mode=clone:stop_duration=0.500,split[full0m][full0t];"), "{split}");
        assert!(split.contains("[full0m]trim=end=2.000000[v0];"), "{split}");
        assert!(split.contains("[full0t]trim=start=2.000000,setpts=PTS-STARTPTS,fps=30.000,settb=AVTB,trim=end=0.500[old1];"), "{split}");
    }

    #[test]
    fn transition_is_capped_by_the_incoming_clip_only() {
        // A tiny first clip no longer limits the transition - it plays over the incoming clip.
        let (step, _, _) = transition_fold_step("v0", "a0", 1, 0.5, 2.0, 30.0, Some((1920, 1080)), Some(("wipeleft", 3.0)), None);
        assert!(step.contains("[vh1]trim=end=1.800000[head1]"), "{step}");
    }

    #[test]
    fn no_transition_is_a_plain_concat() {
        let (step, _, _) = transition_fold_step("fold1v", "fold1a", 2, 9.0, 4.0, 30.0, Some((1920, 1080)), None, None);
        assert_eq!(step, "[fold1v][fold1a][v2][a2]concat=n=2:v=1:a=1[fold2v][fold2a];");
    }

    #[test]
    fn every_transition_builds_a_window_and_unknown_sizes_crossfade() {
        for name in ALLOWED_TRANSITIONS {
            let (step, _, _) = transition_fold_step("v0", "a0", 1, 5.0, 5.0, 30.0, Some((1280, 720)), Some((name, 0.6)), None);
            assert!(step.contains("[tr1]") && step.contains("[old1]") && step.contains("[head1]"), "{name}: {step}");
            assert!(!step.contains("xfade") && !step.contains("st(") && !step.contains("ld("), "{name}: {step}");
        }
        // No known frame size: drawing at the output size is impossible, so a plain crossfade.
        let (step, _, _) = transition_fold_step("v0", "a0", 1, 5.0, 5.0, 30.0, None, Some(("pagecurl", 0.6)), None);
        assert!(step.contains("[old1]format=yuva420p,fade=t=out") && !step.contains("geq"), "{step}");
    }

    #[test]
    fn per_frame_values_follow_the_preview_curves() {
        // A whip's blur: sin(pi p) * 3% of the width, one command per frame of the window.
        let blur = sendcmd_series("gblur@w1", &["sigma"], 0.5, 30.0, |p| (std::f64::consts::PI * p).sin() * 0.03 * 1000.0);
        assert!(blur.starts_with("sendcmd=c='0.0000 gblur@w1 sigma 0.000;0.0333 gblur@w1 sigma 6.237;"), "{blur}");
        assert!(blur.ends_with("0.5000 gblur@w1 sigma 0.000'"), "{blur}");
        // Pixelize sets both block dimensions together.
        let px = sendcmd_series("pixelize@p1", &["w", "h"], 0.1, 10.0, |_| 5.0);
        // ...and only when it changes: a constant value is a single command.
        assert_eq!(px, "sendcmd=c='0.0000 pixelize@p1 w 5.000,pixelize@p1 h 5.000'");
        let step = transition_window_graph("whip", 1, 0.5, 30.0, (1000, 500), &TransitionLook::default());
        assert!(step.contains("gblur@w1=sigma=0") && step.contains("overlay=x='-0.3*main_w*min(t/0.5000,1)'"), "{step}");
    }

    #[test]
    fn transition_looks_are_parsed_never_interpolated_raw() {
        let hostile = TransitionLook {
            color: Some("'; drop".to_string()),
            intensity: Some(9.0),
            direction: Some("'; drop".to_string()),
            size: Some(1.0),
            orientation: Some("'; drop".to_string()),
            shape: Some("'; drop".to_string()),
        };
        for name in ALLOWED_TRANSITIONS {
            let step = transition_window_graph(name, 1, 0.5, 30.0, (1280, 720), &hostile);
            assert!(!step.contains("drop"), "{name}: {step}");
        }
        assert!(parse_hex_color("red").is_none() && parse_hex_color("#12345g").is_none());
        // Intensity is clamped to 1.5: the flash's sin() peak scale.
        let look = TransitionLook { color: Some("#3b82f6".into()), intensity: Some(9.0), ..Default::default() };
        let step = transition_window_graph("fadewhite", 1, 0.5, 30.0, (1280, 720), &look);
        assert!(step.contains("blend=all_mode=screen") && step.contains("min(1,1.500*sin(PI*"), "{step}");
        // A plain white flash dips through white like fadeblack does through black.
        let step = transition_window_graph("fadewhite", 1, 0.5, 30.0, (1280, 720), &TransitionLook::default());
        assert!(step.contains("geq=lum=235") && !step.contains("blend"), "{step}");
        // Doors: a vertical opening reads the x axis.
        let step = transition_window_graph("horzopen", 1, 0.5, 30.0, (1280, 720), &TransitionLook { orientation: Some("vertical".into()), ..Default::default() });
        assert!(step.contains("lte(X/W,"), "{step}");
    }

    // Not a unit test: writes the real export graph for two 2s clips joined by each transition
    // (1s) to $DUMP_TRANSITION_GRAPHS/<name>.txt, for rendering against the preview (parity check).
    #[test]
    #[ignore]
    fn dump_transition_graphs() {
        let Ok(dir) = std::env::var("DUMP_TRANSITION_GRAPHS") else { return };
        // Every colour preset at 80%, and the vignette layer at 640x360.
        for preset in ["vibrant", "cinematic", "bw", "warm", "cool"] {
            std::fs::write(format!("{dir}/color_{preset}.chain"), color_filter_chain(&ClipColorFilter { preset: preset.into(), intensity: 0.8 })).unwrap();
        }
        std::fs::write(format!("{dir}/color_vignette.graph"), vignette_layer(0.8, 640, 360, 30.0, "0:v", "out", 0)).unwrap();
        // And every Ken Burns motion over a 4s clip at 30fps, output 640x360.
        for preset in [
            "zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down", "push", "punch-in", "bounce-in", "drift", "sway", "float", "breathe", "pulse",
            "shake", "vibrate",
        ] {
            let kb = ClipKenBurns { preset: preset.to_string(), intensity: Some(0.8), target_x: None, target_y: None, span: None };
            std::fs::write(format!("{dir}/kb_{preset}.chain"), ken_burns_chain(&kb, 4.0, 640, 360, 30.0)).unwrap();
        }
        // Every clip effect over a 4s clip at 640x360, [0:v] -> [out].
        for kind in ["echo", "rgbsplit", "huecycle", "focus", "colorin", "flicker"] {
            let fx = ClipFx { kind: kind.into(), intensity: 0.6 };
            std::fs::write(format!("{dir}/fx_{kind}.graph"), clip_fx_graph(&fx, "0:v", "out", (640, 360), 4.0, 0).unwrap()).unwrap();
        }
        // The box animations' scale / squash / position expressions for an overlay shown 1s-3s.
        for anim in ["pop", "flip", "zoom", "drop"] {
            let s = overlay_anim_scale_expr(anim, 1.0, 3.0, "t").unwrap_or_else(|| "1".into());
            let sx = if anim == "flip" { overlay_flip_sx_expr(1.0, 3.0, "t") } else { "1".into() };
            let dy = if anim == "drop" { overlay_drop_offset_expr(1.0, 3.0) } else { "0".into() };
            std::fs::write(format!("{dir}/anim_{anim}.txt"), format!("{s}\n{sx}\n{dy}")).unwrap();
        }
        let look: TransitionLook = std::env::var("DUMP_TRANSITION_LOOK").ok().and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
        let mut seg0 = base_segment();
        seg0.end = 2.0;
        let mut seg1 = base_segment();
        seg1.end = 2.0;
        for name in ALLOWED_TRANSITIONS {
            let mut graph = String::new();
            graph.push_str(&format!("{},fps=30.000,settb=AVTB[full0];", segment_video_chain_with_tail("[0:v]", &seg0, "", tail_source_seconds(&seg0, 1.0))));
            graph.push_str(&transition_tail("full0", "v0", "old1", 2.0, 1.0, 30.0));
            graph.push_str(&format!("{},fps=30.000,settb=AVTB[v1];", segment_video_chain("[1:v]", &seg1, "")));
            graph.push_str("anullsrc=channel_layout=stereo:sample_rate=44100:duration=2[a0];anullsrc=channel_layout=stereo:sample_rate=44100:duration=2[a1];");
            let size = std::env::var("DUMP_TRANSITION_SIZE")
                .ok()
                .and_then(|s| s.split_once('x').and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?))))
                .unwrap_or((640, 360));
            let (step, v, _) = transition_fold_step("v0", "a0", 1, 2.0, 2.0, 30.0, Some(size), Some((name, 1.0)), Some(&look));
            graph.push_str(&step);
            graph.push_str(&format!("[{v}]format=yuv420p[out]"));
            std::fs::write(format!("{dir}/{name}.txt"), graph).unwrap();
        }
    }

    // Not a unit test: smart-renders three clips of $DUMP_SOURCE with the bundled ffmpeg in
    // $FFMPEG_DIR - mid-GOP cuts (copy + both edges), a cut starting on a keyframe, and a clip too
    // short to hold a GOP (encoded whole) - into $DUMP_TRANSITION_GRAPHS/smart.mp4, verifying it
    // exactly as smart_render_export does.
    #[test]
    #[ignore]
    fn smart_render_end_to_end() {
        use crate::services::smart_render::{plan_clip, probe_packets, probe_source};
        let (Ok(dir), Ok(source), Ok(bin)) = (std::env::var("DUMP_TRANSITION_GRAPHS"), std::env::var("DUMP_SOURCE"), std::env::var("FFMPEG_DIR")) else { return };
        let (ffmpeg, ffprobe) = (PathBuf::from(&bin).join("ffmpeg.exe"), PathBuf::from(&bin).join("ffprobe.exe"));
        let started = std::time::Instant::now();
        let segs: Vec<KeepSegment> = [(121.3, 140.7), (300.0, 320.0), (539.5, 541.0)]
            .iter()
            .map(|&(start, end)| KeepSegment { source_path: source.clone(), start, end, ..base_segment() })
            .collect();
        let video = probe_source(&ffprobe, &source).expect("probe");
        assert!(video.copyable(), "{video:?}");
        let plans: Vec<_> = segs.iter().map(|s| plan_clip(&probe_packets(&ffprobe, &source, s.start - 1.0, s.end + 1.0).unwrap(), s.start, s.end, video.fps())).collect();
        println!("plans: {plans:?}");
        let work = PathBuf::from(&dir).join("smart_work");
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let build = smart_render_jobs(&segs, &plans, &video, &[true, true, true], 1.0, &work).unwrap();
        let flag = std::sync::atomic::AtomicBool::new(false);
        run_smart_jobs(&ffmpeg, build.jobs, 4, &flag, |d, t| println!("job {d}/{t} at {:.1}s", started.elapsed().as_secs_f64())).unwrap();
        std::fs::write(work.join("pieces.txt"), &build.list).unwrap();
        let out = PathBuf::from(&dir).join("smart.mp4");
        let status = Command::new(&ffmpeg)
            .args(["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i"])
            .arg(work.join("pieces.txt"))
            .arg("-i")
            .arg(&build.audio_out)
            .args(["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-tag:v", "avc3", "-movflags", "+faststart"])
            .arg(&out)
            .status()
            .unwrap();
        assert!(status.success());
        println!("smart render done in {:.1}s, {} frames expected, joins at {:?}", started.elapsed().as_secs_f64(), build.expected_frames, build.joins);
        let count = Command::new(&ffprobe).args(["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0"]).arg(&out).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&count.stdout).trim().parse::<usize>().unwrap(), build.expected_frames);
        for j in &build.joins {
            let o = Command::new(&ffmpeg).args(["-v", "error", "-ss", &format!("{:.6}", (j - 1.0).max(0.0)), "-i"]).arg(&out).args(["-t", "2", "-map", "0:v:0", "-f", "null", "-"]).output().unwrap();
            assert!(o.status.success() && o.stderr.is_empty(), "join at {j}: {}", String::from_utf8_lossy(&o.stderr));
        }
    }

    // Not a unit test: writes an export graph (three 20s cuts from minutes 2, 5 and 9 of $DUMP_SOURCE,
    // joined by crossfade and page curl, colour preset + vignette on one) twice - as before input
    // seeking ("plain") and with it ("seek") - each as `<inputs args>\n<graph>` for benchmarking.
    #[test]
    #[ignore]
    fn dump_export_benchmark_graph() {
        let (Ok(dir), Ok(source)) = (std::env::var("DUMP_TRANSITION_GRAPHS"), std::env::var("DUMP_SOURCE")) else { return };
        for seeking in [false, true] {
            let mut segs: Vec<KeepSegment> = [(120.0, 140.0), (300.0, 320.0), (540.0, 560.0)]
                .iter()
                .map(|&(start, end)| KeepSegment { source_path: source.clone(), start, end, ..base_segment() })
                .collect();
            segs[1].transition_in = Some(ClipTransitionIn { transition_type: "fade".into(), duration: 0.8, look: None });
            segs[2].transition_in = Some(ClipTransitionIn { transition_type: "pagecurl".into(), duration: 0.8, look: None });
            segs[2].color_filter = Some(ClipColorFilter { preset: "cinematic".into(), intensity: 0.8 });
            let mut inputs = Vec::new();
            for seg in segs.iter_mut() {
                let seek = if seeking { segment_input_seek(seg) } else { 0.0 };
                shift_segment_times(seg, seek);
                inputs.push(if seek > 0.0 { format!("-ss {seek:.6} -i") } else { "-i".to_string() });
            }
            let mut g = String::new();
            for (i, seg) in segs.iter().enumerate() {
                let extra = segment_effect_chain(seg, Some(1920), Some(1080), true, None, None, None);
                match segs.get(i + 1).and_then(transition_window) {
                    Some(d) => {
                        g.push_str(&format!("{},fps=30.000,settb=AVTB[full{i}];", segment_video_chain_with_tail(&format!("[{i}:v]"), seg, &extra, tail_source_seconds(seg, d))));
                        g.push_str(&transition_tail(&format!("full{i}"), &format!("v{i}"), &format!("old{}", i + 1), segment_output_duration(seg), d, 30.0));
                    }
                    None => g.push_str(&format!("{},fps=30.000,settb=AVTB[v{i}];", segment_video_chain(&format!("[{i}:v]"), seg, &extra))),
                }
                g.push_str(&audio_trim_chain(true, i, seg.start, seg.end, 1.0, &(Vec::new(), None), &format!("a{i}")));
            }
            let (mut cv, mut ca) = ("v0".to_string(), "a0".to_string());
            for i in 1..segs.len() {
                let tr = segs[i].transition_in.as_ref().map(|t| (t.transition_type.as_str(), t.duration));
                let (step, v, a) = transition_fold_step(&cv, &ca, i, 0.0, segment_output_duration(&segs[i]), 30.0, Some((1920, 1080)), tr, None);
                g.push_str(&step);
                (cv, ca) = (v, a);
            }
            g.push_str(&format!("[{cv}]format=yuv420p[outv];[{ca}]anull[outa]"));
            let name = if seeking { "seek" } else { "plain" };
            std::fs::write(format!("{dir}/export_{name}.txt"), format!("{}\n{g}", inputs.join("|"))).unwrap();
        }
    }

    #[test]
    fn drawn_transitions_slide_sprites_over_the_incoming_head() {
        for name in ["pagecurl", "colorsweep"] {
            assert_eq!(sanitize_transition_name(name), name);
            let step = drawn_transition(name, 1, 0.8, &TransitionLook::default());
            assert!(step.contains("[old1]") && step.contains("[head1]") && step.ends_with("[tr1];"), "{step}");
        }
        // The sweep's colour and direction come from the look - parsed, never interpolated raw.
        let look = TransitionLook { color: Some("#2563eb".into()), direction: Some("left".into()), ..Default::default() };
        let step = drawn_transition("colorsweep", 1, 0.8, &look);
        let (y, u, v) = rgb_to_yuv((37.0, 99.0, 235.0));
        assert!(step.contains(&format!("lutyuv=y={y}:u={u}:v={v}")) && step.contains("x='main_w*(1-"), "{step}");
        let hostile = TransitionLook { color: Some("'; drop".into()), direction: Some("'; drop".into()), ..Default::default() };
        let step = drawn_transition("colorsweep", 1, 0.8, &hostile);
        assert!(step.contains("y='main_h*(1-") && !step.contains("drop"), "{step}");
    }

    #[test]
    fn graded_segments_get_their_color_preset_after_the_lut3d() {
        // The preview's order: the graded frame (GradeCanvas), the preset's CSS filter on top.
        let seg = KeepSegment {
            color_filter: Some(ClipColorFilter { preset: "warm".to_string(), intensity: 0.5 }),
            lut_cube: Some("LUT_3D_SIZE 2".to_string()),
            ..base_segment()
        };
        assert!(segment_needs_filter_graph(&seg));
        let chain = segment_effect_chain(&seg, Some(1920), Some(1080), false, Some(r"C\:/tmp/g.cube"), None, None);
        let lut = chain.find(r"lut3d=file='C\:/tmp/g.cube':interp=trilinear").expect("lut3d step");
        assert!(lut < chain.find("colorchannelmixer").unwrap(), "{chain}");
    }

    #[test]
    fn a_ramp_is_one_segment_with_a_continuous_time_map_and_stepped_audio() {
        let seg = KeepSegment {
            start: 10.0,
            end: 14.0,
            speed_steps: Some(vec![
                SpeedStep { source_start: 10.0, source_end: 12.0, speed: 1.0 },
                SpeedStep { source_start: 12.0, source_end: 14.0, speed: 0.5 },
            ]),
            ..base_segment()
        };
        assert!(segment_needs_filter_graph(&seg));
        assert!((segment_output_duration(&seg) - 6.0).abs() < 1e-9); // 2s + 2s at half speed
        assert_eq!(
            segment_speed_filter(&seg),
            "setpts='(if(lt(T,2.000000),(0.000000+(T-0.000000)/1.000000),(2.000000+(T-2.000000)/0.500000)))/TB'"
        );
        let audio = segment_audio_chain(true, 3, &seg, &(vec![], None), "a3");
        assert!(audio.contains("[a3_src]asplit=2[a3_p0][a3_p1];"), "{audio}");
        assert!(audio.contains("[a3_p1]atrim=start=2.000000:end=4.250000,asetpts=PTS-STARTPTS,apad=pad_dur=0.25,atempo=0.5000,atrim=end=4.000000[a3_q1];"), "{audio}");
        assert!(audio.ends_with("[a3_q0][a3_q1]concat=n=2:v=0:a=1[a3];"), "{audio}");
        // Silent clip: silence as long as the ramped output.
        assert!(segment_audio_chain(false, 3, &seg, &(vec![], None), "a3").contains("duration=6.000"));
    }

    #[test]
    fn constant_speed_keeps_its_plain_chain() {
        let seg = KeepSegment { speed: Some(2.0), ..base_segment() };
        assert_eq!(segment_video_chain("[0:v]", &seg, ",hflip"), "[0:v]trim=start=0.000:end=10.000,setpts=PTS-STARTPTS,hflip,setpts=PTS/2.0000");
        assert!((segment_output_duration(&seg) - 5.0).abs() < 1e-9);
    }

    #[test]
    fn reframe_modes_produce_the_output_size() {
        let frame = |mode: &str| OutputFrame { width: 1080, height: 1920, mode: mode.to_string(), anchor_x: None, anchor_y: None , track: None};
        assert_eq!(
            reframe_chain("base", "framed", &frame("fill")),
            "[base]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[framed];"
        );
        assert!(reframe_chain("base", "framed", &frame("fit")).contains("pad=1080:1920"));
        let blur = reframe_chain("base", "framed", &frame("fit-blur"));
        assert!(blur.starts_with("[base]split=2") && blur.contains("boxblur") && blur.ends_with("[framed];"), "{blur}");
    }

    #[test]
    fn eased_knots_build_a_balanced_tree_that_holds_and_eases() {
        assert_eq!(eased_knots_expr(&[(0.0, 0.3)], "t"), "0.30000");
        let two = eased_knots_expr(&[(1.0, 0.2), (2.0, 0.2)], "t");
        assert_eq!(two, "0.20000"); // a hold is a constant
        let k: Vec<(f64, f64)> = (0..64).map(|i| (i as f64, (i % 2) as f64)).collect();
        let e = eased_knots_expr(&k, "t");
        // 63 segments -> nesting depth ~6, not 63.
        let mut depth = 0i32;
        let mut max_depth = 0;
        for c in e.chars() {
            if c == '(' { depth += 1; max_depth = max_depth.max(depth); }
            if c == ')' { depth -= 1; }
        }
        assert!(max_depth < 20, "depth {max_depth}");
        assert_eq!(e.matches("if(").count(), 62);
    }

    #[test]
    fn a_tracked_fill_crops_on_the_track() {
        let frame = OutputFrame { width: 1080, height: 1920, mode: "fill".into(), anchor_x: None, anchor_y: None, track: Some(vec![[0.0, 0.3, 0.5], [2.0, 0.7, 0.5]]) };
        let chain = reframe_chain("base", "framed", &frame);
        assert!(chain.contains("x='clip(((0.30000+(0.40000)*"), "{chain}");
        assert!(chain.contains(":y='clip((0.50000)*ih-oh/2,0,ih-oh)'"), "{chain}");
    }

    #[test]
    fn keyframe_expressions_hold_ease_and_hold_again() {
        let kf = |time: f64, x: f64, easing: &str| OverlayKeyframe { time, x, y: 0.0, scale: 1.0, opacity: 1.0, easing: easing.to_string() };
        assert_eq!(keyframe_expr(&[kf(1.0, 50.0, "linear")], "t", |k| k.x), "50.0000");
        let e = keyframe_expr(&[kf(2.0, 100.0, "linear"), kf(1.0, 0.0, "ease")], "t", |k| k.x);
        assert_eq!(e, "if(lt(t,2.0000),(0.0000+(100.0000)*(clip((t-1.0000)/1.0000,0,1))*(clip((t-1.0000)/1.0000,0,1))*(3-2*(clip((t-1.0000)/1.0000,0,1)))),100.0000)");
        assert!(keyframe_expr(&[kf(0.0, 0.0, "hold"), kf(1.0, 10.0, "linear")], "t", |k| k.x).contains("(0.0000+(10.0000)*0)"));
    }

    #[test]
    fn keyframe_expressions_stay_shallow() {
        // A motion track's worth of keyframes: the comparisons nest log2(n) deep, not n.
        let kfs: Vec<OverlayKeyframe> = (0..300)
            .map(|i| OverlayKeyframe { time: i as f64 / 30.0, x: (i * 3) as f64, y: 0.0, scale: 1.0, opacity: 1.0, easing: "linear".into() })
            .collect();
        let e = keyframe_expr(&kfs, "t", |k| k.x);
        // How many if()s are open at once: each remembers the paren depth it opened at.
        let (mut parens, mut open_ifs, mut max_depth) = (0usize, Vec::<usize>::new(), 0usize);
        for (i, c) in e.char_indices() {
            match c {
                '(' => {
                    if e[..i].ends_with("if") {
                        open_ifs.push(parens);
                        max_depth = max_depth.max(open_ifs.len());
                    }
                    parens += 1;
                }
                ')' => {
                    parens -= 1;
                    if open_ifs.last() == Some(&parens) {
                        open_ifs.pop();
                    }
                }
                _ => {}
            }
        }
        assert!(max_depth <= 10, "nested {max_depth} deep");
        assert!(e.starts_with("if(lt(t,"), "{}", &e[..60]);
    }

    #[test]
    fn three_boxes_make_the_gaussian() {
        for sigma in [1.5, 4.0, 12.0, 40.0, 130.0] {
            let widths = box_widths_for_sigma(sigma, 3);
            let variance: f64 = widths.iter().map(|w| ((w * w - 1) as f64) / 12.0).sum();
            // Whole-pixel box widths can't land a tiny sigma exactly; at real blur sizes they do.
            let tolerance = if sigma < 3.0 { 0.08 } else if sigma < 8.0 { 0.05 } else { 0.02 };
            assert!((variance.sqrt() - sigma).abs() / sigma < tolerance, "sigma {sigma}: {widths:?} -> {}", variance.sqrt());
        }
        assert_eq!(gaussian_blur_chain(0.1, 100, 100, None), "");
        // Radii never exceed what boxblur accepts on a small region.
        let chain = gaussian_blur_chain(80.0, 40, 30, None);
        assert!(!chain.is_empty() && !chain.contains("luma_radius=20") && !chain.contains("luma_radius=4"), "{chain}");
    }

    #[test]
    fn only_measured_blend_modes_reach_ffmpeg() {
        assert_eq!(blend_mode_ffmpeg("hard-light"), Some("hardlight"));
        assert_eq!(blend_mode_ffmpeg("plus-lighter"), Some("addition"));
        for unsafe_mode in ["soft-light", "color-dodge", "normal", "multiply'; drop", ""] {
            assert_eq!(blend_mode_ffmpeg(unsafe_mode), None, "{unsafe_mode}");
        }
    }

    // Not a unit test: renders each new compositing path with the real ffmpeg ($FFMPEG_DIR) and
    // checks pixels against the formula the preview's CSS uses (W3C compositing / CSS filters).
    #[test]
    #[ignore]
    fn new_effects_render_like_the_spec() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let tmp = std::env::temp_dir().join(format!("briefcast_fx_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let (w, h) = (320usize, 240usize);
        let run = |args: &[String]| {
            let out = Command::new(&ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
            assert!(out.status.success(), "ffmpeg failed: {}\n{:?}", String::from_utf8_lossy(&out.stderr), args);
            out.stdout
        };
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
        // One rgb24 frame of [out] at output time t.
        let frame = |inputs: &[Vec<String>], graph: &str, t: f64| -> Vec<u8> {
            let mut args: Vec<String> = Vec::new();
            for i in inputs {
                args.extend(i.iter().cloned());
            }
            args.extend(s(&["-filter_complex", graph, "-map", "[out]", "-ss"]));
            args.push(format!("{t:.3}"));
            args.extend(s(&["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]));
            let px = run(&args);
            assert_eq!(px.len(), w * h * 3, "graph: {graph}");
            px
        };
        let at = |px: &[u8], x: usize, y: usize| -> [f64; 3] {
            let i = (y * w + x) * 3;
            [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64]
        };
        let near = |got: [f64; 3], want: [f64; 3], tol: f64, what: &str| {
            for c in 0..3 {
                assert!((got[c] - want[c]).abs() <= tol, "{what}: got {got:?}, want {want:?}");
            }
        };
        let base_rgb = [200.0, 100.0, 50.0];
        let base = s(&["-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=30:d=3"]);
        // A 64x64 layer of (100, 200, 250) at half alpha.
        let layer_png = tmp.join("layer.png");
        run(&s(&["-f", "lavfi", "-i", "color=c=0x64C8FA@0.5:s=64x64,format=rgba", "-frames:v", "1", &layer_png.to_string_lossy()]));
        let layer = s(&["-loop", "1", "-framerate", "30", "-t", "1.1", "-i", &layer_png.to_string_lossy()]);
        let alpha = 128.0 / 255.0;
        let src = [100.0, 200.0, 250.0];
        let w3c = |mode: &str, b: f64, s: f64| -> f64 {
            let (b, s) = (b / 255.0, s / 255.0);
            let multiply = |a: f64, c: f64| a * c;
            let screen = |a: f64, c: f64| a + c - a * c;
            let r = match mode {
                "multiply" => multiply(b, s),
                "screen" => screen(b, s),
                // Overlay is hard-light with the roles swapped: the backdrop decides.
                "overlay" => if b <= 0.5 { multiply(s, 2.0 * b) } else { screen(s, 2.0 * b - 1.0) },
                "difference" => (b - s).abs(),
                _ => unreachable!(),
            };
            r * 255.0
        };
        for mode in ["multiply", "screen", "overlay", "difference"] {
            let ff = blend_mode_ffmpeg(mode).unwrap();
            let l = BlendLayer { label: "lay", x: "100".into(), y: "80".into(), width: 64, height: 64, moving: false, fps: 30.0 };
            let graph = format!("[0:v]format=yuv420p[base];[1:v]format=rgba,setpts=PTS-STARTPTS+0.5/TB[lay];{}", blend_composite("base", &l, (320, 240), ff, 0.5, 1.5, "t0", "out"));
            let graph = graph.trim_end_matches(';');
            let px = frame(&[base.clone(), layer.clone()], graph, 1.0);
            let want: Vec<f64> = (0..3).map(|c| base_rgb[c] + alpha * (w3c(mode, base_rgb[c], src[c]) - base_rgb[c])).collect();
            near(at(&px, 132, 112), [want[0], want[1], want[2]], 4.0, mode);
            near(at(&px, 20, 20), base_rgb, 3.0, &format!("{mode} outside"));
            let before = frame(&[base.clone(), layer.clone()], graph, 0.2);
            near(at(&before, 132, 112), base_rgb, 3.0, &format!("{mode} before its window"));
        }
        // Add (plus-lighter): min(1, alpha * source + backdrop).
        let l = BlendLayer { label: "lay", x: "100".into(), y: "80".into(), width: 64, height: 64, moving: false, fps: 30.0 };
        let graph = format!("[0:v]format=yuv420p[base];[1:v]format=rgba,setpts=PTS-STARTPTS+0.5/TB[lay];{}", blend_composite("base", &l, (320, 240), "addition", 0.5, 1.5, "t1", "out"));
        let px = frame(&[base.clone(), layer.clone()], graph.trim_end_matches(';'), 1.0);
        near(at(&px, 132, 112), [(200.0 + alpha * 100.0f64).min(255.0), 100.0 + alpha * 200.0, 50.0 + alpha * 250.0], 4.0, "add");
        // Moving: x goes 0 -> 200 over 0.5..1.5s, so at 1.0s the layer's centre is at 132.
        let kfs = vec![
            OverlayKeyframe { time: 0.5, x: 0.0, y: 80.0, scale: 1.0, opacity: 1.0, easing: "linear".into() },
            OverlayKeyframe { time: 1.5, x: 200.0, y: 80.0, scale: 1.0, opacity: 1.0, easing: "linear".into() },
        ];
        let l = BlendLayer { label: "lay", x: keyframe_expr(&kfs, "t", |k| k.x), y: keyframe_expr(&kfs, "t", |k| k.y), width: 64, height: 64, moving: true, fps: 30.0 };
        let graph = format!("[0:v]format=yuv420p[base];[1:v]format=rgba,setpts=PTS-STARTPTS+0.5/TB[lay];{}", blend_composite("base", &l, (320, 240), "multiply", 0.5, 1.5, "t2", "out"));
        let px = frame(&[base.clone(), layer.clone()], graph.trim_end_matches(';'), 1.0);
        let want: Vec<f64> = (0..3).map(|c| base_rgb[c] + alpha * (w3c("multiply", base_rgb[c], src[c]) - base_rgb[c])).collect();
        near(at(&px, 132, 112), [want[0], want[1], want[2]], 5.0, "moving multiply");
        near(at(&px, 40, 112), base_rgb, 3.0, "where the moving layer has left");

        // Adjustment layers: CSS brightness(0.5) over 0.5..1.5s.
        let adj = |ops: Vec<CssOpSpec>, extra: &dyn Fn(&mut AdjustmentLayerSpec)| {
            let mut a = AdjustmentLayerSpec { start_time: 0.5, end_time: 1.5, placement: "under".into(), color_ops: ops, blur_sigma: None, vignette: None, opacity: 1.0, fade_in: 0.0, fade_out: 0.0, mask_data_base64: None, mask_x: 0, mask_y: 0, mask_keyframes: None, mask_invert: false, fill: None };
            extra(&mut a);
            a
        };
        let dim = vec![CssOpSpec { op: "brightness".into(), value: 0.5 }];
        let a = adj(dim.clone(), &|_| {});
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, None, (320, 240), "base", "a0", "out"));
        let px = frame(&[base.clone()], graph.trim_end_matches(';'), 1.0);
        near(at(&px, 160, 120), [100.0, 50.0, 25.0], 3.0, "brightness");
        let px = frame(&[base.clone()], graph.trim_end_matches(';'), 0.2);
        near(at(&px, 160, 120), base_rgb, 3.0, "brightness before its window");
        // Half opacity mixes halfway; a fade-in is halfway up half-way through it.
        let a = adj(dim.clone(), &|a| a.opacity = 0.5);
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, None, (320, 240), "base", "a1", "out"));
        near(at(&frame(&[base.clone()], graph.trim_end_matches(';'), 1.0), 160, 120), [150.0, 75.0, 37.5], 3.0, "opacity");
        let a = adj(dim.clone(), &|a| a.fade_in = 0.5);
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, None, (320, 240), "base", "a2", "out"));
        near(at(&frame(&[base.clone()], graph.trim_end_matches(';'), 0.75), 160, 120), [150.0, 75.0, 37.5], 6.0, "fade in");
        // A mask confines it: the left half only.
        let mask_png = tmp.join("mask.png");
        run(&s(&["-f", "lavfi", "-i", "color=c=white:s=160x240,format=gray", "-frames:v", "1", &mask_png.to_string_lossy()]));
        let mask = s(&["-loop", "1", "-framerate", "30", "-t", "1.1", "-i", &mask_png.to_string_lossy()]);
        let a = adj(dim.clone(), &|_| {});
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, Some((1, 160, 240)), (320, 240), "base", "a3", "out"));
        let px = frame(&[base.clone(), mask.clone()], graph.trim_end_matches(';'), 1.0);
        near(at(&px, 40, 120), [100.0, 50.0, 25.0], 3.0, "masked in");
        near(at(&px, 280, 120), base_rgb, 3.0, "masked out");
        // Blur: a black|white edge comes out as the Gaussian's integral - 1 sigma in, ~84%.
        let edge = s(&["-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=3,drawbox=x=160:y=0:w=160:h=240:color=white:t=fill"]);
        let a = adj(vec![], &|a| a.blur_sigma = Some(10.0));
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, None, (320, 240), "base", "a4", "out"));
        let px = frame(&[edge.clone()], graph.trim_end_matches(';'), 1.0);
        let phi = |z: f64| 0.5 * (1.0 + erf(z / std::f64::consts::SQRT_2));
        for x in [150usize, 155, 160, 165, 170, 180] {
            let want = 255.0 * phi((x as f64 + 0.5 - 160.0) / 10.0);
            assert!((at(&px, x, 120)[1] - want).abs() < 10.0, "blur at x={x}: {} vs {want}", at(&px, x, 120)[1]);
        }
        // A vignette layer and a colour look together still render.
        let a = adj(vec![CssOpSpec { op: "saturate".into(), value: 1.6 }, CssOpSpec { op: "hue-rotate".into(), value: 10.0 }], &|a| a.vignette = Some(0.8));
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, None, (320, 240), "base", "a5", "out"));
        frame(&[base.clone()], graph.trim_end_matches(';'), 1.0);

        // A keyframed blur region lands where its keyframes put it.
        let checker = s(&["-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=3,geq=lum='if(mod(floor(X/4)+floor(Y/4),2),235,16)':cb=128:cr=128"]);
        let bv = OverlayBlur {
            x: 0,
            y: 80,
            width: 64,
            height: 64,
            intensity: 0.5,
            mask_data_base64: None,
            start_time: 0.5,
            end_time: 1.5,
            sigma: Some(8.0),
            keyframes: Some(kfs.clone()),
        };
        let graph = format!("[0:v]format=yuv420p[base];{}", blur_region_chain(&bv, 0, None, "base", "out"));
        let px = frame(&[checker.clone()], graph.trim_end_matches(';'), 1.0);
        let variance = |x0: usize, y0: usize| {
            let v: Vec<f64> = (0..16).flat_map(|j| (0..16).map(move |i| (i, j))).map(|(i, j)| at(&px, x0 + i, y0 + j)[1]).collect();
            let m = v.iter().sum::<f64>() / v.len() as f64;
            v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / v.len() as f64
        };
        assert!(variance(124, 104) < 200.0, "inside the moved region it's blurred: {}", variance(124, 104));
        assert!(variance(20, 104) > 2000.0, "where it was isn't: {}", variance(20, 104));

        // Picture-in-picture starting at 3s, 2s into its source, shows source 3s at output 4s.
        let pip_src = s(&["-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=10"]);
        let pip = PipOverlay {
            source_path: String::new(),
            x: 0,
            y: 0,
            width: 160,
            height: 120,
            shape: "rectangle".into(),
            corner_radius: None,
            crop: None,
            trim_start: 2.0,
            start_time: 3.0,
            end_time: 5.0,
            volume: 0.0,
            blend_mode: None,
            fx: None,
            opacity: None,
            fade_in: 0.0,
            fade_out: 0.0,
            chroma_key: None,
            mask_data_base64: None,
            source_color: None,
            mask_input: None,
            cutout_path: None,
            cutout_background: None,
            video_input: 1,
            audio_input: None,
            background_input: None,
            mask_motion: None,
            mask_motion_input: None,
        };
        let long_base = s(&["-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=30:d=6"]);
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240))));
        let px = frame(&[long_base.clone(), pip_src.clone()], graph.trim_end_matches(';'), 4.0);
        let reference = |t: f64| run(&s(&["-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=10", "-ss", &format!("{t:.3}"), "-frames:v", "1", "-vf", "scale=160:120,format=yuv420p,format=rgb24", "-f", "rawvideo", "pipe:1"]));
        let mse = |r: &[u8]| {
            let mut sum = 0.0;
            for y in 0..120 {
                for x in 0..160 {
                    for c in 0..3 {
                        let d = px[(y * w + x) * 3 + c] as f64 - r[(y * 160 + x) * 3 + c] as f64;
                        sum += d * d;
                    }
                }
            }
            sum / (160.0 * 120.0 * 3.0)
        };
        let (right, wrong) = (mse(&reference(3.0)), mse(&reference(4.0)));
        assert!(right < 60.0 && right * 4.0 < wrong, "pip timing: mse {right} at the right moment vs {wrong}");
        // ...and blends: screen over the base.
        let pip = PipOverlay { blend_mode: Some("screen".into()), ..pip };
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240))));
        frame(&[long_base.clone(), pip_src.clone()], graph.trim_end_matches(';'), 4.0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7) - plenty for a pixel check.
    fn erf(x: f64) -> f64 {
        let t = 1.0 / (1.0 + 0.3275911 * x.abs());
        let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * (-x * x).exp();
        if x >= 0.0 { y } else { -y }
    }

    #[test]
    fn decodes_colours_the_way_the_webview_does() {
        assert_eq!(browser_color_for("unknown", "unknown", 720), ("bt709", "tv"));
        assert_eq!(browser_color_for("", "", 718), ("bt601", "tv"));
        assert_eq!(browser_color_for("smpte170m", "pc", 1080), ("bt601", "pc"));
        assert_eq!(browser_color_for("bt709", "tv", 480), ("bt709", "tv"));
        assert_eq!(output_matrix(1080), "bt709");
        assert_eq!(output_matrix(480), "bt601");
    }

    #[test]
    fn keys_with_the_chain_the_preview_is_checked_against() {
        let k = ChromaKeySpec { color: "#18a848".into(), similarity: 0.1, blend: 0.12, spill: 0.7 };
        // chromaKey.test.ts runs this same chain (after the source's own RGB conversion) in ffmpeg
        // and compares it with the preview shader's maths.
        assert_eq!(
            chroma_key_filters(&k, ("bt709", "tv")),
            "scale=in_color_matrix=bt709:in_range=tv,format=gbrp,scale=out_color_matrix=bt601:out_range=pc,format=yuv444p,\
             chromakey=color=0x18a848:similarity=0.1:blend=0.12,scale=in_color_matrix=bt601:in_range=pc,format=rgba,\
             despill=type=green:mix=0.5:expand=0:red=0:green=-0.7:blue=0:brightness=0:alpha=0"
        );
        let blue = ChromaKeySpec { color: "1040d0".into(), similarity: 5.0, blend: f64::NAN, spill: 0.0 };
        let f = chroma_key_filters(&blue, ("bt601", "tv"));
        assert!(f.contains("chromakey=color=0x1040d0:similarity=1:blend=0.08,"), "{f}");
        assert!(!f.contains("despill"), "{f}");
    }

    // Not a unit test: a green-screen layer keyed, masked and faded in through pip_overlay_chain with
    // the real ffmpeg ($FFMPEG_DIR), checked pixel by pixel.
    #[test]
    #[ignore]
    fn video_layers_key_mask_and_fade() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let tmp = std::env::temp_dir().join(format!("briefcast_layer_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let (w, h) = (320usize, 240usize);
        let run = |args: &[String]| {
            let out = Command::new(&ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
            assert!(out.status.success(), "ffmpeg failed: {}\n{:?}", String::from_utf8_lossy(&out.stderr), args);
            out.stdout
        };
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
        // Grey subject on a green screen, 160x120 - placed 1:1 at the frame's top-left.
        let screen = s(&["-f", "lavfi", "-i", "color=c=0x00B140:s=160x120:r=30:d=3,drawbox=x=50:y=30:w=60:h=60:color=0x808080:t=fill"]);
        let base = s(&["-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=30:d=3"]);
        // Mask: the left half shows.
        let mask_png = tmp.join("mask.png");
        run(&s(&["-f", "lavfi", "-i", "color=c=white:s=160x120,format=gray,geq=lum='if(lt(X,80),255,0)'", "-frames:v", "1", &mask_png.to_string_lossy()]));
        let mask = s(&["-i", &mask_png.to_string_lossy()]);
        let pip = PipOverlay {
            source_path: String::new(),
            x: 0,
            y: 0,
            width: 160,
            height: 120,
            shape: "rectangle".into(),
            corner_radius: None,
            crop: None,
            trim_start: 0.0,
            start_time: 0.5,
            end_time: 2.5,
            volume: 0.0,
            blend_mode: None,
            fx: None,
            opacity: None,
            fade_in: 0.5,
            fade_out: 0.0,
            chroma_key: Some(ChromaKeySpec { color: "#00b140".into(), similarity: 0.1, blend: 0.05, spill: 0.0 }),
            mask_data_base64: None,
            source_color: Some(("bt601", "tv")),
            mask_input: Some(2),
            cutout_path: None,
            cutout_background: None,
            video_input: 1,
            audio_input: None,
            background_input: None,
            mask_motion: None,
            mask_motion_input: None,
        };
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240))));
        let frame = |t: f64| -> Vec<u8> {
            let mut args: Vec<String> = [base.clone(), screen.clone(), mask.clone()].concat();
            args.extend(s(&["-filter_complex", graph.trim_end_matches(';'), "-map", "[out]", "-ss"]));
            args.push(format!("{t:.3}"));
            args.extend(s(&["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]));
            let px = run(&args);
            assert_eq!(px.len(), w * h * 3);
            px
        };
        let at = |px: &[u8], x: usize, y: usize| -> [f64; 3] {
            let i = (y * w + x) * 3;
            [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64]
        };
        let near = |got: [f64; 3], want: [f64; 3], tol: f64, what: &str| {
            for c in 0..3 {
                assert!((got[c] - want[c]).abs() <= tol, "{what}: got {got:?}, want {want:?}");
            }
        };
        let base_rgb = [200.0, 100.0, 50.0];
        let grey = [128.0, 128.0, 128.0];
        let px = frame(1.5);
        near(at(&px, 20, 20), base_rgb, 6.0, "the screen is keyed out");
        near(at(&px, 65, 60), grey, 6.0, "the subject shows");
        near(at(&px, 100, 60), base_rgb, 6.0, "the masked-off half of the subject doesn't");
        near(at(&px, 200, 60), base_rgb, 6.0, "outside the layer");
        // Halfway through its half-second fade-in: half subject, half video.
        let px = frame(0.75);
        let half = [(grey[0] + base_rgb[0]) / 2.0, (grey[1] + base_rgb[1]) / 2.0, (grey[2] + base_rgb[2]) / 2.0];
        near(at(&px, 65, 60), half, 10.0, "fading in");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // Not a unit test: a cut-out (VP9 with alpha, as background_removal.rs writes) composited through
    // pip_overlay_chain with the real ffmpeg ($FFMPEG_DIR) - its transparency must survive.
    #[test]
    #[ignore]
    fn cutout_layers_keep_their_alpha() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let tmp = std::env::temp_dir().join(format!("briefcast_cutout_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let run = |args: &[&str]| {
            let out = Command::new(&ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
            assert!(out.status.success(), "ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        };
        // A grey picture whose left half is transparent, written the way the cut-outs are.
        let cutout = tmp.join("cut.webm");
        run(&[
            "-f", "lavfi", "-i", "color=c=0x808080:s=160x120:r=25:d=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,80),0,255)'",
            "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva420p",
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "18", "-b:v", "0", "-auto-alt-ref", "0", "-colorspace", "bt709", &cutout.to_string_lossy(),
        ]);
        let pip = PipOverlay {
            source_path: String::new(),
            x: 0,
            y: 0,
            width: 160,
            height: 120,
            shape: "rectangle".into(),
            corner_radius: None,
            crop: None,
            trim_start: 0.0,
            start_time: 0.0,
            end_time: 2.0,
            volume: 0.0,
            blend_mode: None,
            fx: None,
            opacity: None,
            fade_in: 0.0,
            fade_out: 0.0,
            chroma_key: None,
            mask_data_base64: None,
            source_color: None,
            mask_input: None,
            cutout_path: Some(cutout.to_string_lossy().to_string()),
            cutout_background: None,
            video_input: 1,
            audio_input: None,
            background_input: None,
            mask_motion: None,
            mask_motion_input: None,
        };
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240))));
        let px = run(&[
            "-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=25:d=2",
            "-c:v", "libvpx-vp9", "-i", &cutout.to_string_lossy(),
            "-filter_complex", graph.trim_end_matches(';'), "-map", "[out]", "-ss", "1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ]);
        let at = |x: usize, y: usize| { let i = (y * 320 + x) * 3; [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64] };
        let near = |got: [f64; 3], want: [f64; 3], what: &str| assert!(got.iter().zip(want).all(|(g, w)| (g - w).abs() <= 6.0), "{what}: got {got:?}, want {want:?}");
        near(at(30, 60), [200.0, 100.0, 50.0], "the transparent half shows the video under it");
        near(at(130, 60), [128.0, 128.0, 128.0], "the opaque half shows the cut-out");
        // With a colour behind the person, the see-through half shows that colour instead.
        let pip = PipOverlay { cutout_background: Some(CutoutBackgroundSpec { kind: "color".into(), color: Some("#2050e0".into()), image_base64: None, blur_sigma: None, blur_margin: None, source_crop: None }), ..pip };
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240))));
        let px = run(&[
            "-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=25:d=2",
            "-c:v", "libvpx-vp9", "-i", &cutout.to_string_lossy(),
            "-filter_complex", graph.trim_end_matches(';'), "-map", "[out]", "-ss", "1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ]);
        let at = |x: usize, y: usize| { let i = (y * 320 + x) * 3; [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64] };
        near(at(30, 60), [32.0, 80.0, 224.0], "the background colour fills behind the person");
        near(at(130, 60), [128.0, 128.0, 128.0], "the person stays in front");
        near(at(250, 60), [200.0, 100.0, 50.0], "outside the layer");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // Not a unit test: a spotlight sliding across the frame, a fill, and a reveal mask sliding inside
    // a layer, through the real ffmpeg ($FFMPEG_DIR), checked where each should be at mid-move.
    #[test]
    #[ignore]
    fn moving_masks_and_fill() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let tmp = std::env::temp_dir().join(format!("briefcast_moving_mask_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let run = |args: &[&str]| {
            let out = Command::new(&ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
            assert!(out.status.success(), "ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        };
        // A hard-edged 40x40 white mask.
        let square = tmp.join("square.png");
        run(&["-f", "lavfi", "-i", "color=c=white:s=40x40,format=gray", "-frames:v", "1", &square.to_string_lossy()]);
        let b64 = BASE64.encode(std::fs::read(&square).unwrap());
        let kf = |time: f64, x: f64, y: f64| OverlayKeyframe { time, x, y, scale: 1.0, opacity: 1.0, easing: "linear".into() };
        let frame_at = |inputs: &[&str], graph: &str, t: &str| -> Vec<u8> {
            let mut args: Vec<&str> = inputs.to_vec();
            args.extend(["-filter_complex", graph, "-map", "[out]", "-ss", t, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
            run(&args)
        };
        let at = |px: &[u8], x: usize, y: usize| { let i = (y * 320 + x) * 3; [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64] };
        let near = |got: [f64; 3], want: [f64; 3], what: &str| assert!(got.iter().zip(want).all(|(g, w)| (g - w).abs() <= 8.0), "{what}: got {got:?}, want {want:?}");
        let base = "color=c=0xC86432:s=320x240:r=30:d=3";
        let orange = [200.0, 100.0, 50.0];

        // Spotlight: everything but a 40x40 square goes black; the square slides from x=20 to x=220
        // between 0.5 s and 1.5 s - at 1.0 s it's at x=120.
        let spot = AdjustmentLayerSpec {
            start_time: 0.0, end_time: 3.0, placement: "under".into(), color_ops: vec![CssOpSpec { op: "brightness".into(), value: 0.0 }], blur_sigma: None, vignette: None,
            opacity: 1.0, fade_in: 0.0, fade_out: 0.0, mask_data_base64: None, mask_x: 0, mask_y: 0,
            mask_keyframes: Some(vec![kf(0.5, 20.0, 100.0), kf(1.5, 220.0, 100.0)]), mask_invert: true, fill: None,
        };
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&spot, Some((1, 40, 40)), (320, 240), "base", "spot", "out"));
        let sq = square.to_string_lossy().to_string();
        let px = frame_at(&["-f", "lavfi", "-i", base, "-loop", "1", "-framerate", "30", "-t", "3.1", "-i", &sq], graph.trim_end_matches(';'), "1.0");
        near(at(&px, 140, 120), orange, "inside the spotlight at mid-move");
        near(at(&px, 40, 120), [0.0, 0.0, 0.0], "where it started is dark now");
        near(at(&px, 240, 120), [0.0, 0.0, 0.0], "where it's going is still dark");

        // Fill: the whole frame one colour.
        let fill = AdjustmentLayerSpec { color_ops: vec![], mask_keyframes: None, mask_invert: false, fill: Some("#2050e0".into()), ..spot };
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&fill, None, (320, 240), "base", "fill", "out"));
        let px = frame_at(&["-f", "lavfi", "-i", base], graph.trim_end_matches(';'), "1.0");
        near(at(&px, 160, 120), [32.0, 80.0, 224.0], "filled");

        // Reveal: a grey 160x120 layer shows only inside a 40x40 mask sliding from x=0 to x=120
        // (within the layer) between 0.5 s and 1.5 s.
        let pip = PipOverlay {
            source_path: String::new(), x: 0, y: 0, width: 160, height: 120, shape: "rectangle".into(), corner_radius: None, crop: None,
            trim_start: 0.0, start_time: 0.0, end_time: 3.0, volume: 0.0, blend_mode: None, fx: None, opacity: None, fade_in: 0.0, fade_out: 0.0,
            chroma_key: None, mask_data_base64: None, source_color: None, mask_input: None, cutout_path: None, cutout_background: None,
            video_input: 1, audio_input: None, background_input: None,
            mask_motion: Some(MaskMotionSpec { image_base64: b64, keyframes: vec![
                MaskKeyframeSpec { time: 0.5, x: 0.0, y: 40.0, w: 40.0, h: 40.0, easing: "linear".into() },
                MaskKeyframeSpec { time: 1.5, x: 120.0, y: 40.0, w: 40.0, h: 40.0, easing: "linear".into() },
            ], invert: false }),
            mask_motion_input: Some(2),
        };
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240))));
        let px = frame_at(&["-f", "lavfi", "-i", base, "-f", "lavfi", "-i", "color=c=0x808080:s=160x120:r=30:d=3", "-loop", "1", "-framerate", "30", "-t", "3.1", "-i", &sq], graph.trim_end_matches(';'), "1.0");
        near(at(&px, 80, 60), [128.0, 128.0, 128.0], "the layer shows inside the mask at mid-move");
        near(at(&px, 20, 60), orange, "and not where the mask started");

        // An iris opening from nothing at the layer's centre: fully hidden on its first frame (no
        // 2 px dot), open by 1 s; inverted, the whole layer shows on the first frame.
        let iris = |invert: bool| PipOverlay {
            mask_motion: Some(MaskMotionSpec { image_base64: BASE64.encode(std::fs::read(&square).unwrap()), keyframes: vec![
                MaskKeyframeSpec { time: 0.0, x: 80.0, y: 60.0, w: 0.0, h: 0.0, easing: "ease-out".into() },
                MaskKeyframeSpec { time: 1.0, x: 60.0, y: 40.0, w: 40.0, h: 40.0, easing: "hold".into() },
            ], invert }),
            mask_motion_input: Some(2),
            source_path: String::new(), x: 0, y: 0, width: 160, height: 120, shape: "rectangle".into(), corner_radius: None, crop: None,
            trim_start: 0.0, start_time: 0.0, end_time: 3.0, volume: 0.0, blend_mode: None, fx: None, opacity: None, fade_in: 0.0, fade_out: 0.0,
            chroma_key: None, mask_data_base64: None, source_color: None, mask_input: None, cutout_path: None, cutout_background: None,
            video_input: 1, audio_input: None, background_input: None,
        };
        let inputs = ["-f", "lavfi", "-i", base, "-f", "lavfi", "-i", "color=c=0x808080:s=160x120:r=30:d=3", "-loop", "1", "-framerate", "30", "-t", "3.1", "-i", &sq];
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&iris(false), 1, 0, "base", "out", Some((320, 240))));
        let first = frame_at(&inputs, graph.trim_end_matches(';'), "0");
        for (x, y) in [(79, 59), (80, 60), (81, 61), (80, 59)] {
            near(at(&first, x, y), orange, "nothing of the layer on the closed iris's first frame");
        }
        near(at(&frame_at(&inputs, graph.trim_end_matches(';'), "1.2"), 80, 60), [128.0, 128.0, 128.0], "open after the iris");
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&iris(true), 1, 0, "base", "out", Some((320, 240))));
        near(at(&frame_at(&inputs, graph.trim_end_matches(';'), "0"), 80, 60), [128.0, 128.0, 128.0], "inverted: the whole layer on the first frame");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // Evaluates what step_expr builds: nested if(lt(t,X),A,B) over integer leaves.
    fn eval_step(expr: &str, t: f64) -> i64 {
        if let Some(rest) = expr.strip_prefix("if(lt(t,") {
            let close = rest.find(')').unwrap();
            let threshold: f64 = rest[..close].parse().unwrap();
            let body = &rest[close + 2..rest.len() - 1];
            // Split the two branches at the top-level comma.
            let mut depth = 0;
            let split = body.char_indices().find(|&(_, c)| {
                match c {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    ',' if depth == 0 => return true,
                    _ => {}
                }
                false
            });
            let (a, b) = body.split_at(split.unwrap().0);
            return if t < threshold { eval_step(a, t) } else { eval_step(&b[1..], t) };
        }
        expr.parse().unwrap()
    }

    #[test]
    fn step_expressions_hold_each_value_until_the_next() {
        assert_eq!(step_expr(&[], "t"), "0");
        assert_eq!(step_expr(&[(0.0, 10)], "t"), "10");
        assert_eq!(step_expr(&[(0.0, 10), (1.0, 20), (2.0, 30)], "t"), "if(lt(t,1.000000),10,if(lt(t,2.000000),20,30))");
        let points: Vec<(f64, i64)> = (0..37).map(|i| (i as f64 * 0.25 - 1.0, i * 7)).collect();
        for k in 0..200 {
            let t = k as f64 * 0.05 - 2.0;
            let want = points.iter().rev().find(|p| p.0 <= t).map_or(points[0].1, |p| p.1);
            assert_eq!(eval_step(&step_expr(&points, "t"), t), want, "at {t}");
        }
    }

    fn tiny_png(w: u32, h: u32, rgba: [u8; 4]) -> String {
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(w, h, image::Rgba(rgba)))
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        format!("data:image/png;base64,{}", BASE64.encode(out))
    }

    #[test]
    fn sprite_lists_hold_each_picture_for_its_run() {
        let dir = std::env::temp_dir().join(format!("briefcast_sprite_list_test_{}", std::process::id()));
        let track = SpriteTrack {
            sprites: vec![tiny_png(4, 4, [255, 0, 0, 255]), tiny_png(4, 4, [0, 0, 255, 255])],
            width: 4,
            height: 4,
            runs: vec![(0.5, 0, 2, 2), (0.75, -1, 2, 2), (1.0, 1, 4, 4)],
            end: 1.5,
        };
        // Timed from 0.25: blank first, then each run - and everything before 0 dropped.
        let list = std::fs::read_to_string(write_sprite_track(&track, &dir, 0.25).unwrap()).unwrap();
        let entries: Vec<(&str, &str)> = list
            .lines()
            .filter(|l| !l.starts_with("option ") && !l.starts_with("ffconcat"))
            .collect::<Vec<_>>()
            .chunks(2)
            .map(|c| (c[0], c.get(1).copied().unwrap_or("")))
            .collect();
        assert_eq!(
            entries,
            vec![
                ("file 'blank.png'", "duration 0.250000"),
                ("file 's0.png'", "duration 0.250000"),
                ("file 'blank.png'", "duration 0.250000"),
                ("file 's1.png'", "duration 0.500000"),
                ("file 'blank.png'", "duration 1"),
                ("file 'blank.png'", ""),
            ]
        );
        // Every picture at a microsecond timebase (see write_sprite_track).
        assert_eq!(list.matches("option framerate 1000000").count(), 6);
        let list = std::fs::read_to_string(write_sprite_track(&track, &dir, 0.6).unwrap()).unwrap();
        assert!(list.starts_with("ffconcat version 1.0\nfile 's0.png'\noption framerate 1000000\nduration 0.150000\n"), "{list}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sprites_become_rgba_of_the_tracks_size() {
        // An opaque RGB picture one pixel short.
        let mut rgb = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(3, 4, image::Rgb([9, 8, 7])))
            .write_to(&mut std::io::Cursor::new(&mut rgb), image::ImageFormat::Png)
            .unwrap();
        let fixed = image::load_from_memory(&normalized_sprite_png(&BASE64.encode(rgb), 4, 4).unwrap()).unwrap();
        assert!(matches!(fixed, image::DynamicImage::ImageRgba8(_)));
        let px = fixed.to_rgba8();
        assert_eq!(px.dimensions(), (4, 4));
        assert_eq!(px.get_pixel(0, 0).0, [9, 8, 7, 255]);
        assert_eq!(px.get_pixel(3, 0).0[3], 0);
        // Already right: passed through untouched.
        let ok = tiny_png(4, 4, [1, 2, 3, 4]);
        assert_eq!(normalized_sprite_png(&ok, 4, 4).unwrap(), BASE64.decode(ok.rsplit(',').next().unwrap()).unwrap());
    }

    // Not a unit test: the editor-drawn pointer through a clip's real chain and the screen frame,
    // rendered by the real ffmpeg ($FFMPEG_DIR) and checked frame by frame. The sprite alternates
    // red/blue every frame while it moves 2 px a frame, so a picture or a position one frame early
    // or late shows up as the wrong colour or a coloured pixel where the box just was.
    #[test]
    #[ignore]
    fn pointer_sprites_land_on_their_frames_and_zoom_with_the_clip() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let tmp = std::env::temp_dir().join(format!("briefcast_pointer_test_{}", std::process::id()));
        let run = |args: &[&str]| {
            let out = Command::new(&ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
            assert!(out.status.success(), "ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        };
        // Cells centred on k/60 of SOURCE time, boundaries half a cell before - as pointerTrack.ts.
        let runs: Vec<(f64, i64, i64, i64)> = (30..91).map(|k: i64| ((k as f64 - 0.5) / 60.0, k % 2, 2 * (k - 30), 40)).collect();
        let track = SpriteTrack { sprites: vec![tiny_png(8, 8, [255, 0, 0, 255]), tiny_png(8, 8, [0, 0, 255, 255])], width: 8, height: 8, runs, end: 90.5 / 60.0 };
        let list = write_sprite_track(&track, &tmp.join("ptr"), 0.5).unwrap();
        let list_path = list.to_string_lossy().to_string();
        // The clip: 0.5..1.5 s of a grey 60 fps source, cropped to its top-left quarter (2x zoom).
        let seg = KeepSegment { start: 0.5, end: 1.5, crop: Some(ClipCrop { x: 0.0, y: 0.0, width: 0.5, height: 0.5 }), ..base_segment() };
        let fragment = pointer_fragment(0, std::slice::from_ref(&track), &[1], 0.5);
        let extra = segment_effect_chain(&seg, Some(320), Some(240), false, None, None, Some(&fragment));
        let graph = format!("{}[out]", segment_video_chain("[0:v]", &seg, &extra));
        let px = run(&[
            "-f", "lavfi", "-i", "color=c=0x808080:s=320x240:r=60:d=3",
            "-f", "concat", "-safe", "0", "-i", &list_path,
            "-filter_complex", &graph, "-map", "[out]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ]);
        let frame_bytes = 320 * 240 * 3;
        let frames = px.len() / frame_bytes;
        assert!(frames >= 58, "only {frames} frames");
        let at = |f: usize, x: usize, y: usize| { let i = f * frame_bytes + (y * 320 + x) * 3; [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64] };
        let near = |got: [f64; 3], want: [f64; 3], what: &str| assert!(got.iter().zip(want).all(|(g, w)| (g - w).abs() <= 12.0), "{what}: got {got:?}, want {want:?}");
        for f in 0..frames.min(60) {
            let k = 30 + f as i64;
            // Zoomed 2x: the 8 px box at (2j, 40) of the source is 16 px at (4j, 80).
            let x = 4 * (k - 30) as usize;
            let want = if k % 2 == 0 { [255.0, 0.0, 0.0] } else { [0.0, 0.0, 255.0] };
            near(at(f, x + 8, 88), want, &format!("the pointer on frame {f}"));
            if x >= 4 {
                // A frame late, the box would still cover x-4 (red or blue are far darker than the
                // grey) - luma, since 4:2:0 chroma smears across the edge either way.
                let [r, g, b] = at(f, x - 4, 88);
                let luma = 0.299 * r + 0.587 * g + 0.114 * b;
                assert!((luma - 128.0).abs() <= 12.0, "nothing where it was, frame {f}: luma {luma}");
            }
        }

        // The screen frame: a green backdrop with a transparent hole at (40, 30) 240 x 180.
        let mut backdrop = image::RgbaImage::from_pixel(320, 240, image::Rgba([0, 200, 0, 255]));
        for y in 30..210 {
            for x in 40..280 {
                backdrop.put_pixel(x, y, image::Rgba([0, 0, 0, 0]));
            }
        }
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(backdrop).write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
        let backdrop_path = tmp.join("backdrop.png");
        std::fs::write(&backdrop_path, &bytes).unwrap();
        let ss = ScreenStyleSpec { backdrop_base64: String::new(), x: 40, y: 30, width: 240, height: 180 };
        let graph = format!("[0:v]format=yuv420p[base];{}", screen_style_chain("base", 1, &ss, (320, 240), "out"));
        let px = run(&[
            "-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=30:d=2", "-i", &backdrop_path.to_string_lossy(),
            "-filter_complex", graph.trim_end_matches(';'), "-map", "[out]", "-ss", "1.0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ]);
        let at = |x: usize, y: usize| { let i = (y * 320 + x) * 3; [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64] };
        near(at(10, 10), [0.0, 200.0, 0.0], "the wallpaper");
        near(at(160, 120), [200.0, 100.0, 50.0], "the video in the hole");
        near(at(42, 32), [200.0, 100.0, 50.0], "right to the hole's edge");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
