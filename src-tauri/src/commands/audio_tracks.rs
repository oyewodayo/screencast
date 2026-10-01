// Audio-track tooling for the video editor's "Detach audio" action (ExtractAudioPopover /
// VideoTimelineDocker's handleDetachAudio):
//
// - probe_audio_streams: lists every audio stream in a file, so a file that really carries several
//   (e.g. a separate mic and system-audio track) can be detached one lane per stream instead of
//   ffmpeg silently picking just the first.
// - separate_voice_music: splits one already-mixed audio file into a voice stem and a music stem
//   with Demucs. Nothing in ffmpeg can do this at usable quality, so it shells out to whichever
//   Demucs engine is installed (see resolve_engine) - the same "external CLI, not a Rust binding"
//   tradeoff already made for whisper-cli.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, Window};

#[cfg(windows)]
use crate::commands::recording::hide_console_window;
use crate::services::utility::{find_on_path, get_ffmpeg_path, get_ffprobe_path, path_to_str};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    // Position among the file's AUDIO streams (ffmpeg's `0:a:N`), not the absolute stream index -
    // that's what extract_clip_audio's stream_index expects.
    pub index: u32,
    pub codec: Option<String>,
    pub channels: Option<u32>,
    pub language: Option<String>,
    pub title: Option<String>,
}

fn new_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.stdin(Stdio::null());
    cmd
}

#[tauri::command]
pub async fn probe_audio_streams(app_handle: AppHandle, source_path: String) -> Result<Vec<AudioStreamInfo>, String> {
    let ffprobe = get_ffprobe_path(&app_handle)?;
    tauri::async_runtime::spawn_blocking(move || {
        let output = new_command(&ffprobe)
            .args([
                "-v",
                "quiet",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=codec_name,channels:stream_tags=language,title",
                "-of",
                "json",
                &source_path,
            ])
            .output()
            .map_err(|e| format!("Failed to run ffprobe: {}", e))?;
        let json: serde_json::Value =
            serde_json::from_slice(&output.stdout).map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;
        let streams = json["streams"].as_array().cloned().unwrap_or_default();
        Ok(streams
            .iter()
            .enumerate()
            .map(|(i, s)| AudioStreamInfo {
                index: i as u32,
                codec: s["codec_name"].as_str().map(str::to_string),
                channels: s["channels"].as_u64().map(|c| c as u32),
                language: s["tags"]["language"].as_str().filter(|l| *l != "und").map(str::to_string),
                title: s["tags"]["title"].as_str().filter(|t| !t.trim().is_empty()).map(str::to_string),
            })
            .collect())
    })
    .await
    .map_err(|e| format!("Probe task failed: {}", e))?
}

// ---- Voice / music separation -----------------------------------------------------------------

const DEMUCS_CPP_MODEL: &str = "ggml-model-htdemucs-4s-f16.bin";
const DEMUCS_CPP_BINARIES: [&str; 2] = ["demucs_mt.cpp.main", "demucs.cpp.main"];

enum Engine {
    // sevagh/demucs.cpp - a native build plus its converted 4-stem model, in a `demucs` folder
    // either bundled as a resource or dropped into the app's local data dir.
    Native { exe: PathBuf, model: PathBuf, multithreaded: bool },
    // The reference Python implementation (`pip install demucs`), run as `demucs ...` or
    // `python -m demucs ...`.
    Python { program: PathBuf, prefix_args: Vec<String> },
}

impl Engine {
    fn label(&self) -> &'static str {
        match self {
            Engine::Native { .. } => "demucs.cpp",
            Engine::Python { .. } => "demucs (Python)",
        }
    }
}

fn native_engine_in(dir: &Path) -> Option<Engine> {
    let model = dir.join(DEMUCS_CPP_MODEL);
    if !model.is_file() {
        return None;
    }
    DEMUCS_CPP_BINARIES.iter().find_map(|name| {
        let exe = dir.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() });
        exe.is_file().then(|| Engine::Native { exe, model: model.clone(), multithreaded: name.starts_with("demucs_mt") })
    })
}

fn python_has_demucs(python: &Path) -> bool {
    new_command(python)
        .args(["-c", "import demucs"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn resolve_engine(app_handle: &AppHandle) -> Option<Engine> {
    let mut native_dirs = Vec::new();
    if let Ok(dir) = app_handle.path().resolve("binaries/demucs", BaseDirectory::Resource) {
        native_dirs.push(dir);
    }
    if let Ok(dir) = app_handle.path().app_local_data_dir() {
        native_dirs.push(dir.join("demucs"));
    }
    if let Some(engine) = native_dirs.iter().find_map(|d| native_engine_in(d)) {
        return Some(engine);
    }
    if let Some(program) = find_on_path("demucs") {
        return Some(Engine::Python { program, prefix_args: vec![] });
    }
    ["python", "python3", "py"].iter().find_map(|name| {
        let python = find_on_path(name)?;
        python_has_demucs(&python).then(|| Engine::Python { program: python, prefix_args: vec!["-m".into(), "demucs".into()] })
    })
}

const NOT_INSTALLED: &str = "SEPARATION_ENGINE_MISSING";

// ---- On-demand engine download ----------------------------------------------------------------
//
// The engine isn't bundled (it would add ~100 MB to every install for a feature most people never
// use). Instead the first "Voice and music" detach offers to download it into
// <app local data>/demucs, where resolve_engine already looks. Every file is pinned by size and
// SHA-256, so a truncated download or a swapped file on the host is rejected, never executed.
//
// Downloads go through the system curl (built into Windows 10 1803+, macOS and Linux) rather than
// an HTTP crate: the reqwest already in the dependency tree is built without TLS, and turning TLS
// on drags in a native crypto build - a lot of weight for one download button.

struct EngineAsset {
    file_name: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

// Converted htdemucs 4-stem weights from demucs.cpp's author (Hugging Face "Retrobear/demucs.cpp").
const MODEL_ASSET: EngineAsset = EngineAsset {
    file_name: DEMUCS_CPP_MODEL,
    url: "https://huggingface.co/datasets/Retrobear/demucs.cpp/resolve/main/ggml-model-htdemucs-4s-f16.bin",
    sha256: "72b17c42d308982ddb5069bc3bf48b81a5aac4cb6516e4366c0fa7cef6df0064",
    size: 83_994_361,
};

// demucs.cpp has no official Windows release, so these are our own fully static MinGW builds of
// demucs_mt.cpp.main (Eigen + static OpenBLAS + OpenMP - see scripts/build-demucs-engine.sh),
// published on this repo's GitHub Releases under the "demucs-engine-v1" tag. Two CPU levels:
// x86-64-v3 (AVX2/FMA - nearly every x86 CPU since 2013) and a slower x86-64-v2 fallback. Both
// install under the same name, so resolve_engine finds either. Rebuilding changes the hashes:
// upload under a new tag and update both URLs + hashes together.
#[cfg(all(windows, target_arch = "x86_64"))]
const EXE_V3_ASSET: EngineAsset = EngineAsset {
    file_name: "demucs_mt.cpp.main.exe",
    url: "https://github.com/oyewodayo/screencast/releases/download/demucs-engine-v1/demucs_mt-win-x64-v3.exe",
    sha256: "92a69333cdc20debb029c82db6658cc52d010c50cbba069f7f2b32f6f223e2bf",
    size: 34_481_678,
};
#[cfg(all(windows, target_arch = "x86_64"))]
const EXE_V2_ASSET: EngineAsset = EngineAsset {
    file_name: "demucs_mt.cpp.main.exe",
    url: "https://github.com/oyewodayo/screencast/releases/download/demucs-engine-v1/demucs_mt-win-x64-v2.exe",
    sha256: "4819eee498065ae1729fc16665afeae2f5a012d734b87d288f4c93fa7a3202c0",
    size: 34_283_534,
};

// The engine exe + model to fetch for this machine; None = no prebuilt engine for this platform
// (the Python fallback still works there).
fn downloadable_assets() -> Option<[&'static EngineAsset; 2]> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        let v3 = std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma");
        return Some([if v3 { &EXE_V3_ASSET } else { &EXE_V2_ASSET }, &MODEL_ASSET]);
    }
    #[allow(unreachable_code)]
    None
}

fn engine_install_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    app_handle
        .path()
        .app_local_data_dir()
        .map(|d| d.join("demucs"))
        .map_err(|e| format!("Failed to resolve app data folder: {}", e))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparationEngineStatus {
    // Name of the installed engine, if any.
    pub installed: Option<String>,
    // Total bytes a download would fetch; None when there's no prebuilt engine for this platform.
    pub download_bytes: Option<u64>,
}

// Lets the UI show whether "Voice and music" will run right away, needs a one-time download, or
// isn't available at all, before the user picks it.
#[tauri::command]
pub async fn get_separation_engine(app_handle: AppHandle) -> Result<SeparationEngineStatus, String> {
    tauri::async_runtime::spawn_blocking(move || SeparationEngineStatus {
        installed: resolve_engine(&app_handle).map(|e| e.label().to_string()),
        download_bytes: downloadable_assets().map(|assets| assets.iter().map(|a| a.size).sum()),
    })
    .await
    .map_err(|e| format!("Engine lookup failed: {}", e))
}

static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);
const DOWNLOAD_CANCELLED_ERR: &str = "SEPARATION_DOWNLOAD_CANCELLED";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineDownloadProgress {
    downloaded: u64,
    total: u64,
}

fn sha256_of(path: &Path) -> Result<String, String> {
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

fn is_valid_install(path: &Path, asset: &EngineAsset) -> bool {
    std::fs::metadata(path).map(|m| m.len() == asset.size).unwrap_or(false) && sha256_of(path).map(|h| h == asset.sha256).unwrap_or(false)
}

// Fetches one asset to `<dest>.part` via curl, reporting bytes on disk as progress (curl's own
// progress meter isn't machine-readable), then verifies it and renames it into place.
fn download_asset(window: &Window, asset: &EngineAsset, dest: &Path, already: u64, total: u64) -> Result<(), String> {
    let part = dest.with_extension("part");
    let _ = std::fs::remove_file(&part);
    let curl = find_on_path("curl").ok_or("curl was not found on this system, so the engine can't be downloaded")?;
    let mut child = new_command(curl)
        .args(["--location", "--fail", "--silent", "--show-error", "--retry", "3", "--output"])
        .arg(&part)
        .arg(asset.url)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start download: {}", e))?;

    let status = loop {
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&part);
            return Err(DOWNLOAD_CANCELLED_ERR.to_string());
        }
        let on_disk = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0).min(asset.size);
        let _ = window.emit("separation-engine-download", EngineDownloadProgress { downloaded: already + on_disk, total });
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

// Downloads (or repairs) the separation engine into <app local data>/demucs. Files already present
// and intact are skipped, so an interrupted download picks up at the next file. Emits
// "separation-engine-download" {downloaded, total} while running.
#[tauri::command]
pub async fn download_separation_engine(app_handle: AppHandle, window: Window) -> Result<String, String> {
    let assets = downloadable_assets().ok_or("There's no prebuilt voice/music engine for this platform yet. Install it with `pip install demucs` instead.")?;
    let dir = engine_install_dir(&app_handle)?;
    DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create engine folder: {}", e))?;
        let total: u64 = assets.iter().map(|a| a.size).sum();
        let mut done = 0u64;
        for asset in assets {
            let dest = dir.join(asset.file_name);
            if !is_valid_install(&dest, asset) {
                download_asset(&window, asset, &dest, done, total)?;
            }
            done += asset.size;
            let _ = window.emit("separation-engine-download", EngineDownloadProgress { downloaded: done, total });
        }
        resolve_engine(&app_handle)
            .map(|e| e.label().to_string())
            .ok_or_else(|| "Engine downloaded but could not be found afterwards".to_string())
    })
    .await
    .map_err(|e| format!("Download task failed: {}", e))?
}

#[tauri::command(async)]
pub fn cancel_separation_engine_download() {
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
}

fn run_checked(mut cmd: Command, what: &str) -> Result<(), String> {
    let output = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| format!("Failed to start {}: {}", what, e))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail: Vec<&str> = stderr.lines().rev().take(8).collect();
    Err(format!("{} failed: {}", what, tail.into_iter().rev().collect::<Vec<_>>().join("\n")))
}

static SEPARATION_CANCELLED: AtomicBool = AtomicBool::new(false);
const SEPARATION_CANCELLED_ERR: &str = "SEPARATION_CANCELLED";

#[derive(Clone, Serialize)]
struct SeparationProgress {
    percent: f64,
}

// Pulls a percentage out of one line of engine output, returning (worker key, percent):
// - demucs.cpp's demucs_mt: "[THREAD 3] (46.154%) Time (crosstransformer): layer 1" - each worker
//   reports its own slice, so the key is the thread number.
// - Python demucs: tqdm bars like " 42%|████▏     | 5.85/14.0" - one bar, key 0.
fn parse_progress(line: &str) -> Option<(u32, f64)> {
    if let Some(rest) = line.strip_prefix("[THREAD ") {
        let (thread, rest) = rest.split_once(']')?;
        let pct = rest.trim_start().strip_prefix('(')?.split_once('%')?.0;
        return Some((thread.trim().parse().ok()?, pct.parse().ok()?));
    }
    let (before, _) = line.split_once("%|")?;
    let digits: String = before.chars().rev().take_while(|c| c.is_ascii_digit() || *c == '.').collect::<Vec<_>>().into_iter().rev().collect();
    Some((0, digits.parse().ok()?))
}

// Runs a separation engine, emitting "separation-progress" {percent} as the overall average of
// every worker's own progress (`workers` = how many report; 1 for Python's single bar). Output
// is split on '\r' as well as '\n' because tqdm redraws its bar in place. Honors
// cancel_voice_music_separation by killing the engine.
fn run_with_progress(mut cmd: Command, what: &str, window: &Window, workers: u32, progress_on_stderr: bool) -> Result<(), String> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Failed to start {}: {}", what, e))?;
    let (progress_pipe, other_pipe): (Box<dyn Read + Send>, Box<dyn Read + Send>) = if progress_on_stderr {
        (Box::new(child.stderr.take().ok_or("no stderr")?), Box::new(child.stdout.take().ok_or("no stdout")?))
    } else {
        (Box::new(child.stdout.take().ok_or("no stdout")?), Box::new(child.stderr.take().ok_or("no stderr")?))
    };

    // Drain the non-progress pipe on its own thread so the engine can never block writing to it;
    // keep its tail for the error message.
    let other_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = { other_pipe }.read_to_string(&mut buf);
        buf
    });

    let window = window.clone();
    let progress_reader = std::thread::spawn(move || {
        let mut per_worker = std::collections::HashMap::<u32, f64>::new();
        let mut tail = String::new();
        let mut line = Vec::new();
        let mut last_emitted = -1.0;
        for byte in std::io::BufReader::new(progress_pipe).bytes() {
            let Ok(byte) = byte else { break };
            if byte != b'\n' && byte != b'\r' {
                line.push(byte);
                continue;
            }
            let text = String::from_utf8_lossy(&line).to_string();
            line.clear();
            if let Some((worker, pct)) = parse_progress(&text) {
                let entry = per_worker.entry(worker).or_insert(0.0);
                *entry = entry.max(pct.clamp(0.0, 100.0));
                let percent = per_worker.values().sum::<f64>() / workers.max(1) as f64;
                if percent - last_emitted >= 0.5 {
                    last_emitted = percent;
                    let _ = window.emit("separation-progress", SeparationProgress { percent: percent.min(99.0) });
                }
            } else if !text.trim().is_empty() {
                tail.push_str(&text);
                tail.push('\n');
            }
        }
        tail
    });

    let status = loop {
        if SEPARATION_CANCELLED.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SEPARATION_CANCELLED_ERR.to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => return Err(format!("{} failed: {}", what, e)),
        }
    };
    let progress_tail = progress_reader.join().unwrap_or_default();
    let other_tail = other_reader.join().unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let combined = format!("{}\n{}", other_tail, progress_tail);
    let tail: Vec<&str> = combined.lines().filter(|l| !l.trim().is_empty()).rev().take(8).collect();
    Err(format!("{} failed: {}", what, tail.into_iter().rev().collect::<Vec<_>>().join("\n")))
}

#[tauri::command(async)]
pub fn cancel_voice_music_separation() {
    SEPARATION_CANCELLED.store(true, Ordering::SeqCst);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparatedStems {
    pub voice_path: String,
    pub music_path: String,
    pub engine: String,
}

// Splits `input_path` (any audio file ffmpeg can read) into `<output_dir>/<stem>-voice.wav` and
// `<output_dir>/<stem>-music.wav`. Both stems keep the input's exact length, so they can be laid
// on the timeline at the same position the mixed audio occupied. Errors with NOT_INSTALLED when
// no engine is available, which the frontend turns into setup instructions. Emits
// "separation-progress" {percent} while the engine runs.
#[tauri::command]
pub async fn separate_voice_music(app_handle: AppHandle, window: Window, input_path: String, output_dir: String) -> Result<SeparatedStems, String> {
    let ffmpeg = get_ffmpeg_path(&app_handle)?;
    SEPARATION_CANCELLED.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let engine = resolve_engine(&app_handle).ok_or_else(|| NOT_INSTALLED.to_string())?;
        let out_dir = PathBuf::from(&output_dir);
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("Failed to create output folder: {}", e))?;
        let stem = Path::new(&input_path).file_stem().and_then(|s| s.to_str()).unwrap_or("audio").to_string();
        let work = out_dir.join(format!("{stem}-separation"));
        std::fs::create_dir_all(&work).map_err(|e| format!("Failed to create work folder: {}", e))?;

        // Both engines are trained on 44.1kHz stereo; normalizing up front avoids relying on each
        // engine's own resampling/mono handling.
        let normalized = work.join("input.wav");
        let mut cmd = new_command(&ffmpeg);
        cmd.args(["-y", "-i", &input_path, "-vn", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le"]).arg(path_to_str(&normalized)?);
        run_checked(cmd, "Audio preparation")?;

        let voice_out = out_dir.join(format!("{stem}-voice.wav"));
        let music_out = out_dir.join(format!("{stem}-music.wav"));

        let result = (|| -> Result<(), String> {
            match &engine {
                Engine::Native { exe, model, multithreaded } => {
                    let mut cmd = new_command(exe);
                    // demucs.cpp wants a trailing separator on the output dir.
                    let mut dir_arg = path_to_str(&work)?.to_string();
                    dir_arg.push(std::path::MAIN_SEPARATOR);
                    cmd.arg(path_to_str(model)?).arg(path_to_str(&normalized)?).arg(dir_arg);
                    let mut workers = 1;
                    if *multithreaded {
                        // demucs_mt's 4th arg: worker threads, each taking a slice of the track.
                        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 16);
                        cmd.arg(threads.to_string());
                        workers = threads as u32;
                    }
                    // demucs_mt already parallelizes across the track; letting OpenBLAS spin up its
                    // own thread pool per worker on top of that oversubscribes the CPU.
                    cmd.env("OPENBLAS_NUM_THREADS", "1");
                    run_with_progress(cmd, "Voice/music separation", &window, workers, false)?;
                    // 4-stem model: target_0_drums, target_1_bass, target_2_other, target_3_vocals.
                    // Music = everything that isn't vocals, summed back at unity gain.
                    std::fs::copy(work.join("target_3_vocals.wav"), &voice_out).map_err(|e| format!("Voice stem missing: {}", e))?;
                    let mut cmd = new_command(&ffmpeg);
                    cmd.arg("-y");
                    for name in ["target_0_drums.wav", "target_1_bass.wav", "target_2_other.wav"] {
                        cmd.arg("-i").arg(path_to_str(&work.join(name))?);
                    }
                    cmd.args(["-filter_complex", "amix=inputs=3:normalize=0", "-c:a", "pcm_s16le"]).arg(path_to_str(&music_out)?);
                    run_checked(cmd, "Music stem mixdown")
                }
                Engine::Python { program, prefix_args } => {
                    let mut cmd = new_command(program);
                    cmd.args(prefix_args)
                        .args(["--two-stems", "vocals", "-n", "htdemucs", "-o"])
                        .arg(path_to_str(&work)?)
                        .arg(path_to_str(&normalized)?);
                    run_with_progress(cmd, "Voice/music separation", &window, 1, true)?;
                    // Output layout: <out>/<model>/<input file stem>/{vocals,no_vocals}.wav
                    let result_dir = work.join("htdemucs").join("input");
                    std::fs::copy(result_dir.join("vocals.wav"), &voice_out).map_err(|e| format!("Voice stem missing: {}", e))?;
                    std::fs::copy(result_dir.join("no_vocals.wav"), &music_out).map_err(|e| format!("Music stem missing: {}", e))?;
                    Ok(())
                }
            }
        })();
        let _ = std::fs::remove_dir_all(&work);
        result?;

        Ok(SeparatedStems {
            voice_path: path_to_str(&voice_out)?.to_string(),
            music_path: path_to_str(&music_out)?.to_string(),
            engine: engine.label().to_string(),
        })
    })
    .await
    .map_err(|e| format!("Separation task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::parse_progress;

    #[test]
    fn parses_demucs_cpp_thread_progress() {
        assert_eq!(parse_progress("[THREAD 3] (46.154%) Time (crosstransformer): layer 1"), Some((3, 46.154)));
        assert_eq!(parse_progress("[THREAD 12] (0.000%) buffers.x: 4, 2048, 336"), Some((12, 0.0)));
    }

    #[test]
    fn parses_tqdm_bar() {
        assert_eq!(parse_progress(" 42%|####      | 5.85/14.0 [00:10<00:14]"), Some((0, 42.0)));
        assert_eq!(parse_progress("100%|##########| 14.0/14.0"), Some((0, 100.0)));
    }

    #[test]
    fn ignores_other_output() {
        assert_eq!(parse_progress("Loading weights from model_file"), None);
        assert_eq!(parse_progress("Writing wav file \"out/target_3_vocals.wav\""), None);
    }
}
