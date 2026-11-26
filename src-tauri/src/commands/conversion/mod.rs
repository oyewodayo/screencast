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
// Where an export goes when no location was chosen: the library's Exports folder, named after what
// was edited and numbered by version - "Hand_Explainer_Demo - v1.mp4", then "- v2"... Finished
// videos then sit together, easy to find (and send), instead of next to each source as
// "(edited) (edited) (2)": exporting an export, or re-exporting, counts on from the same name.
// A video project renders to an .mp4 named after the project.
fn export_output_path(output_base_path: &str) -> Result<PathBuf, String> {
    let base = PathBuf::from(output_base_path);
    let ext = base.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "mp4".to_string());
    let ext = if ext.eq_ignore_ascii_case(crate::services::video_edits::VIDEO_PROJECT_EXTENSION) { "mp4".to_string() } else { ext };
    let name = export_base_name(&base.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
    let dir = crate::services::utility::briefcast_dir()?.join(crate::services::video_edits::EXPORTS_FOLDER);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create the Exports folder: {}", e))?;
    Ok(next_version_path(&dir, &name, &ext))
}

// A name with the export suffixes earlier exports gave it taken off: " (edited)", " (share-ready)",
// " (2)" after those, " - v3" - repeatedly ("x (edited) (edited) (2)" -> "x").
fn export_base_name(stem: &str) -> String {
    let mut name = stem.trim().to_string();
    loop {
        let before = name.len();
        for suffix in [" (edited)", " (share-ready)"] {
            if name.to_lowercase().ends_with(suffix) {
                name.truncate(name.len() - suffix.len());
            }
        }
        // " (n)" right after an export suffix, and " - vN".
        if let Some(i) = name.rfind(" (") {
            let tail = &name[i + 2..];
            if tail.ends_with(')') && tail[..tail.len() - 1].chars().all(|c| c.is_ascii_digit()) && !tail[..tail.len() - 1].is_empty() {
                let rest = name[..i].to_lowercase();
                if rest.ends_with(" (edited)") || rest.ends_with(" (share-ready)") {
                    name.truncate(i);
                }
            }
        }
        if let Some(i) = name.rfind(" - v") {
            let digits = &name[i + 4..];
            if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
                name.truncate(i);
            }
        }
        if name.len() == before {
            break;
        }
    }
    let name = name.trim().to_string();
    if name.is_empty() { "Video".to_string() } else { name }
}

// "<name> - vN.<ext>" in `dir`, N one past the highest version already there.
fn next_version_path(dir: &Path, name: &str, ext: &str) -> PathBuf {
    let prefix = format!("{} - v", name).to_lowercase();
    let highest = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| {
                    let file = e.file_name().to_string_lossy().to_lowercase();
                    let stem = file.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(file);
                    stem.strip_prefix(&prefix).and_then(|n| n.parse::<u32>().ok())
                })
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    dir.join(format!("{} - v{}.{}", name, highest + 1, ext))
}

pub(crate) fn unique_output_path(path: PathBuf) -> PathBuf {
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
pub(crate) struct InputSpec {
    path: String,
    pre_args: Vec<String>,
}

impl InputSpec {
    pub(crate) fn plain(path: String) -> Self {
        Self {
            path,
            pre_args: Vec::new(),
        }
    }

    // The file that has to be on disk for this input to open. An image-sequence input (an
    // animated overlay's frames - write_temp_overlay_sequence) is a printf pattern, not a file:
    // it's there when its first frame is.
    pub(crate) fn existing_path(&self) -> PathBuf {
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
pub(crate) async fn run_conversion(
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

pub(crate) async fn run_conversion_low_priority(
    app_handle: &AppHandle,
    window: &Window,
    state: &ConversionState,
    inputs: &[InputSpec],
    progress_key: &str,
    output: PathBuf,
    codec_args: &[&str],
) -> Result<String, String> {
    run_conversion_with(
        app_handle,
        window,
        state,
        inputs,
        progress_key,
        output,
        codec_args,
        None,
        &RunExtras {
            low_priority: true,
            ..Default::default()
        },
    )
    .await
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

    let fit = format!("scale={width}:{height}:force_original_aspect_ratio=decrease:out_range=tv,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps},format=yuv420p");
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
    // - without it, colour-managed players show the copy slightly off. Not its range, though:
    // `fit` above converts to standard range (out_range=tv) whatever the source was, so
    // copying a "pc" tag over would mislabel the picture (washed out, or refused by uploaders).
    for (flag, key) in [("-color_primaries", "color_primaries"), ("-color_trc", "color_transfer"), ("-colorspace", "color_space")] {
        if let Some(value) = video[key].as_str().filter(|v| !v.is_empty() && *v != "unknown" && *v != "reserved") {
            args.extend([flag.to_string(), value.to_string()]);
        }
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    // With the other finished videos, in the library's Exports folder (export_output_path).
    let exports = crate::services::utility::briefcast_dir()?.join(crate::services::video_edits::EXPORTS_FOLDER);
    std::fs::create_dir_all(&exports).map_err(|e| format!("Failed to create the Exports folder: {}", e))?;
    let output = exports.join(format!("{} (share-ready).mp4", export_base_name(stem)));
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
    // "blur": fitted over a blurred copy of itself (a canvas's Blur background), as export does.
    background: Option<String>,
) -> Result<String, String> {
    let input = PathBuf::from(&image_path);
    let (w, h) = proxy_size(frame_width, frame_height);
    let blur = background.as_deref() == Some("blur");
    // Frame size goes in the file name, not the namespace, so every proxy shares one cache entry in
    // Settings' storage list regardless of how many frame sizes have been used.
    let cache_path = preview_cache_path(&input, "image_clip_v1", &format!("{}x{}{}.mp4", w, h, if blur { "_blur" } else { "" }))?;
    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    let source = still_image_source(&app_handle, &window, &state, &image_path).await?;
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let args = image_clip_proxy_args(source, w, h, blur);
    // Each encode holds a decoded full-size photo (a 64-megapixel phone photo is ~190 MB) and
    // several threads; past a few at once they only slow each other down (measured with 8 phone
    // photos: 2-3 at once 2.7-2.9s, 4 at once 3.4s, 6 at once 17s).
    let _permit = IMAGE_PROXY_ENCODES.acquire().await.map_err(|e| e.to_string())?;
    encode_preview_proxy(ffmpeg_path, args, cache_path).await
}

// Concurrent image-proxy encodes. The editor's background preparation keeps two going, which
// leaves one for the photo actually under the playhead.
static IMAGE_PROXY_ENCODES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

// One frame every 10s: every frame is the same picture, and encode time scales with frame count.
const IMAGE_CLIP_PROXY_FRAME_SECONDS: u32 = 10;

// The proxy's ffmpeg arguments. The photo is decoded and fitted ONCE, then that one frame is
// repeated (the `loop` filter) and spaced out (setpts) - not looped as an input (`-loop 1`), which
// decodes and scales the whole photo again for every output frame. With phone photos that was the
// entire cost: a 64-megapixel JPEG took 26-32s per proxy that way and ~0.8s this way, for a
// bit-identical file (same size, frame count, duration and picture - checked with ffprobe and PSNR).
fn image_clip_proxy_args(source: String, w: u32, h: u32, blur: bool) -> Vec<String> {
    let frames = IMAGE_CLIP_PROXY_SECONDS / IMAGE_CLIP_PROXY_FRAME_SECONDS;
    let fit = if blur { frame_fit_blur_chain(w as i64, h as i64, true, "p") } else { frame_fit_chain(w as i64, h as i64, true) };
    let filter = format!(
        "{},loop=loop={}:size=1:start=0,setpts=N*{}/TB",
        &fit[1..],
        frames - 1,
        IMAGE_CLIP_PROXY_FRAME_SECONDS
    );
    vec![
        "-i".into(), source,
        "-vf".into(), filter,
        "-r".into(), format!("1/{}", IMAGE_CLIP_PROXY_FRAME_SECONDS),
        "-t".into(), IMAGE_CLIP_PROXY_SECONDS.to_string(),
        "-c:v".into(), "libx264".into(),
        "-preset".into(), "ultrafast".into(),
        "-tune".into(), "stillimage".into(),
        // A single keyframe - the rest are near-empty repeats, so seeking anywhere decodes only a
        // few dozen trivial frames, and the whole proxy stays a few hundred KB.
        "-g".into(), "60".into(),
        "-an".into(),
        "-movflags".into(), "+faststart".into(),
    ]
}

// The "primary file" a video project plays while no clip is under the playhead (an empty
// timeline, or before the first clip has loaded) - a black video at the project's own frame size.
// The timeline reads the project's frame size off this (its videoPixelSize), the same way it
// reads a real video's, so overlay burn-in and export resolution need no project-specific path.
// A hundred hours long (VIDEO_CANVAS_SECONDS in videoEditTypes.ts), because a project of sound
// alone plays straight over it (blankClipsFor) - the player is already on it, so there's nothing to
// load or switch to, and audio of any length a person records or extracts plays through without
// the picture ever jumping back to the start (a seek the timeline's clock would stall on). Made
// in a moment however long: one hour encoded (one frame every 10 s - it's all black), then
// repeated by stream copy, and the whole file is a few hundred KB.
// Serialises canvas builds - see get_video_canvas_proxy.
static CANVAS_BUILD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const VIDEO_CANVAS_SECONDS: u32 = 100 * 3600;
const CANVAS_BASE_SECONDS: u32 = 3600;

#[tauri::command]
pub async fn get_video_canvas_proxy(app_handle: AppHandle, width: u32, height: u32) -> Result<String, String> {
    let (w, h) = ((width.max(2) / 2) * 2, (height.max(2) / 2) * 2);
    let dir = std::env::temp_dir().join("briefcast_preview_cache").join("video_canvas_v3");
    let cache_path = dir.join(format!("{}x{}.mp4", w, h));
    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    // One build at a time. The Create dialog asks for its canvas in the background the moment it
    // opens (first use of a size costs several seconds), so the editor asking again on Create would
    // otherwise run a second build of the same file into the same temporary paths. The second caller
    // waits here and then finds the finished file.
    let _build = CANVAS_BUILD.lock().await;
    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let base = dir.join(format!("{}x{}.hour.mp4", w, h));
    if !base.exists() {
        let args: Vec<String> = vec![
            "-f".into(), "lavfi".into(),
            "-i".into(), format!("color=c=black:s={}x{}:r=0.1:d={}", w, h, CANVAS_BASE_SECONDS),
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "ultrafast".into(),
            "-pix_fmt".into(), "yuv420p".into(),
            "-an".into(),
        ];
        encode_preview_proxy(ffmpeg_path.clone(), args, base.clone()).await?;
    }
    let list = dir.join(format!("{}x{}.concat.txt", w, h));
    let entry = format!("file '{}'\n", path_to_str(&base)?.replace('\\', "/"));
    std::fs::write(&list, entry.repeat((VIDEO_CANVAS_SECONDS / CANVAS_BASE_SECONDS) as usize)).map_err(|e| format!("Couldn't prepare the project canvas: {e}"))?;
    let args: Vec<String> = vec![
        "-f".into(), "concat".into(),
        "-safe".into(), "0".into(),
        "-i".into(), path_to_str(&list)?.to_string(),
        "-c".into(), "copy".into(),
        "-movflags".into(), "+faststart".into(),
    ];
    let made = encode_preview_proxy(ffmpeg_path, args, cache_path).await;
    let _ = std::fs::remove_file(&list);
    let _ = std::fs::remove_file(&base);
    made
}

// The picture of an audio-only project: a black still at the project's frame size, laid under the
// audio as ordinary image clips (videoEditTypes.ts blankClipsFor) so it previews through the
// image-clip proxy and exports as a blank-screen video with no special case on either side.
#[tauri::command]
pub async fn get_blank_frame_image(app_handle: AppHandle, width: u32, height: u32) -> Result<String, String> {
    let (w, h) = ((width.max(2) / 2) * 2, (height.max(2) / 2) * 2);
    let cache_path = std::env::temp_dir()
        .join("briefcast_preview_cache")
        .join("blank_frame_v1")
        .join(format!("{}x{}.png", w, h));
    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    // encode_preview_proxy writes to a ".partial.mp4" first, so the image muxer is named outright.
    let args: Vec<String> = vec![
        "-f".into(), "lavfi".into(),
        "-i".into(), format!("color=c=black:s={}x{}", w, h),
        "-frames:v".into(), "1".into(),
        "-c:v".into(), "png".into(),
        "-f".into(), "image2".into(),
        "-update".into(), "1".into(),
    ];
    encode_preview_proxy(ffmpeg_path, args, cache_path).await
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


mod images;
mod captions;
mod audio;
mod filter_graphs;
mod video_export;
#[cfg(test)]
mod tests;

// Glob re-exports preserve Tauri's generated `__cmd__*` macros for `invoke_handler.rs` and share
// `pub(super)` helpers across sibling submodules without exposing them outside `conversion`.
#[allow(unused_imports)]
pub use images::*;
#[allow(unused_imports)]
pub use captions::*;
#[allow(unused_imports)]
pub use audio::*;
#[allow(unused_imports)]
#[allow(unused_imports)]
pub use filter_graphs::*;
#[allow(unused_imports)]
pub use video_export::*;
