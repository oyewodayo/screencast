// Background removal for video-track layers (a webcam picture-in-picture over slides, without a
// green screen).
//
// A person is cut out of their video with Robust Video Matting (RVM, MobileNetV3 - Lin et al. 2021):
// a recurrent network that carries what it saw in earlier frames forward, so hair and edges stay
// steady instead of flickering frame to frame the way per-image segmentation does. It runs on ONNX
// Runtime through DirectML (any DirectX 12 GPU; ONNX Runtime falls back to the CPU on its own).
//
// The result is a derived video: the person's colours (RVM's de-spilled foreground) with an alpha
// channel, as VP9 in WebM - a format the webview plays with its transparency, and ffmpeg decodes
// with it (libvpx-vp9). Preview and export both use that one file, so they show the same cut-out by
// construction. It's made once per source file and kept with the other derived media.
//
// Nothing is bundled: the engine (ONNX Runtime with DirectML, ~40 MB, from Microsoft's official
// PyPI wheel) and the model (15 MB, from the RVM authors' release) download on first use into
// <app local data>/background-removal, each pinned by size and SHA-256 (asset_download.rs).
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, Window};

#[cfg(windows)]
use crate::commands::recording::hide_console_window;
use crate::services::asset_download::{download_asset, is_valid_install, sha256_of, DownloadAsset};
use crate::services::utility::{get_ffmpeg_path, get_ffprobe_path};

// ---- The engine -----------------------------------------------------------------------------------

// ONNX Runtime 1.24.4 with DirectML, as Microsoft publishes it for Python - the three native
// libraries inside are plain C-API DLLs, usable from here. Only those are kept.
const WHEEL_ASSET: DownloadAsset = DownloadAsset {
    file_name: "onnxruntime_directml-1.24.4.whl",
    url: "https://files.pythonhosted.org/packages/88/ea/33814eb0ec96775eda4c1d30b0d86e91d7d2cd0d84c66d3915aef0e06fa3/onnxruntime_directml-1.24.4-cp312-cp312-win_amd64.whl",
    sha256: "f2ecb68b7b7b259d2ef3112ae760149f9b5a1e7c0fbb73d539da6250a648a614",
    size: 25_111_930,
};
const DLLS: &[(&str, u64, &str)] = &[
    ("onnxruntime.dll", 21_111_832, "302c69f9779d63ef4ab90316e59444c4acbaca7fe3455020d79d10bcfcb00715"),
    ("DirectML.dll", 18_527_776, "b73972115320e906a49602f2027a3266622881b0d325ba685e0f165a9482a8d7"),
    ("onnxruntime_providers_shared.dll", 21_576, "f6bbae3af4c0673b0d1e6ca8db900dc85ad959a395b69d361038ec7995cc2652"),
];
// RVM MobileNetV3, fp32 (PeterL1n/RobustVideoMatting, release v1.0.0).
const MODEL_ASSET: DownloadAsset = DownloadAsset {
    file_name: "rvm_mobilenetv3_fp32.onnx",
    url: "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx",
    sha256: "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828",
    size: 14_975_696,
};
// Bumped when the cut-out's recipe changes, so files made the old way are made again.
const CUTOUT_VERSION: &str = "rvm-mnv3-v1";

pub(crate) fn engine_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_handle.path().app_local_data_dir().map_err(|e| format!("No app data folder: {}", e))?.join("background-removal"))
}

fn dll_ok(dir: &Path, (name, size, sha): &(&str, u64, &str)) -> bool {
    let path = dir.join(name);
    std::fs::metadata(&path).map(|m| m.len() == *size).unwrap_or(false) && sha256_of(&path).map(|h| h == *sha).unwrap_or(false)
}

pub(crate) fn model_path(dir: &Path) -> PathBuf {
    dir.join(MODEL_ASSET.file_name)
}

pub(crate) fn engine_ready(dir: &Path) -> bool {
    DLLS.iter().all(|d| dll_ok(dir, d)) && is_valid_install(&dir.join(MODEL_ASSET.file_name), &MODEL_ASSET)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundRemovalStatus {
    // "ready", "needs-download" (about `download_mb`), or "unsupported" on this platform.
    state: &'static str,
    download_mb: u64,
}

#[tauri::command]
pub async fn background_removal_status(app_handle: AppHandle) -> Result<BackgroundRemovalStatus, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Ok(BackgroundRemovalStatus { state: "unsupported", download_mb: 0 });
    }
    let dir = engine_dir(&app_handle)?;
    let ready = tauri::async_runtime::spawn_blocking(move || engine_ready(&dir)).await.map_err(|e| e.to_string())?;
    Ok(BackgroundRemovalStatus {
        state: if ready { "ready" } else { "needs-download" },
        download_mb: (WHEEL_ASSET.size + MODEL_ASSET.size) / 1_000_000,
    })
}

static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);
const DOWNLOAD_CANCELLED_ERR: &str = "BACKGROUND_REMOVAL_DOWNLOAD_CANCELLED";

#[derive(Clone, Serialize)]
struct EngineDownloadProgress {
    downloaded: u64,
    total: u64,
}

// Fetches (or repairs) the engine and model. Emits "background-removal-download" {downloaded, total}.
#[tauri::command]
pub async fn download_background_removal(app_handle: AppHandle, window: Window) -> Result<(), String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("Background removal isn't available on this platform yet.".into());
    }
    let dir = engine_dir(&app_handle)?;
    DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create the engine folder: {}", e))?;
        let total = WHEEL_ASSET.size + MODEL_ASSET.size;
        let emit = |downloaded: u64| {
            let _ = window.emit("background-removal-download", EngineDownloadProgress { downloaded, total });
        };
        if !DLLS.iter().all(|d| dll_ok(&dir, d)) {
            let wheel = dir.join(WHEEL_ASSET.file_name);
            if !is_valid_install(&wheel, &WHEEL_ASSET) {
                download_asset(&WHEEL_ASSET, &wheel, &DOWNLOAD_CANCELLED, DOWNLOAD_CANCELLED_ERR, &emit)?;
            }
            extract_dlls(&wheel, &dir)?;
            let _ = std::fs::remove_file(&wheel);
        }
        emit(WHEEL_ASSET.size);
        let model = dir.join(MODEL_ASSET.file_name);
        if !is_valid_install(&model, &MODEL_ASSET) {
            download_asset(&MODEL_ASSET, &model, &DOWNLOAD_CANCELLED, DOWNLOAD_CANCELLED_ERR, &|n| emit(WHEEL_ASSET.size + n))?;
        }
        emit(total);
        if engine_ready(&dir) { Ok(()) } else { Err("The background-removal engine didn't verify after downloading.".into()) }
    })
    .await
    .map_err(|e| format!("Download task failed: {}", e))?
}

#[tauri::command(async)]
pub fn cancel_background_removal_download() {
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
}

// The three DLLs out of the wheel (a zip) with Windows' own tar (bsdtar reads zip), each checked
// against its pin before it's put in place.
fn extract_dlls(wheel: &Path, dir: &Path) -> Result<(), String> {
    let staging = dir.join("extract");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let tar = std::env::var_os("SystemRoot").map(|r| PathBuf::from(r).join("System32").join("tar.exe")).filter(|p| p.exists()).unwrap_or_else(|| PathBuf::from("tar"));
    let mut cmd = Command::new(tar);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.arg("-xf").arg(wheel).arg("-C").arg(&staging);
    for (name, _, _) in DLLS {
        cmd.arg(format!("onnxruntime/capi/{name}"));
    }
    let out = cmd.stdout(Stdio::null()).stderr(Stdio::piped()).output().map_err(|e| format!("Failed to unpack the engine: {}", e))?;
    if !out.status.success() {
        return Err(format!("Failed to unpack the engine: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let unpacked = staging.join("onnxruntime").join("capi");
    for dll in DLLS {
        if !dll_ok(&unpacked, dll) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("{} from the engine download didn't verify.", dll.0));
        }
        std::fs::rename(unpacked.join(dll.0), dir.join(dll.0)).or_else(|_| std::fs::copy(unpacked.join(dll.0), dir.join(dll.0)).map(|_| ())).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(&staging);
    Ok(())
}

// ONNX Runtime, loaded once per process. onnxruntime.dll is loaded first by this code with its own
// folder on the search path, so DirectML.dll and the providers library resolve from beside it
// (not System32's older DirectML); ort's own load of the same path then reuses that module.
static ORT_ENV: OnceLock<Result<ort::environment::Environment, String>> = OnceLock::new();

pub(crate) fn ort_environment(dir: &Path) -> Result<&'static ort::environment::Environment, String> {
    ORT_ENV
        .get_or_init(|| {
            let dll = dir.join("onnxruntime.dll");
            #[cfg(windows)]
            unsafe {
                use windows::core::HSTRING;
                use windows::Win32::Foundation::HANDLE;
                use windows::Win32::System::LibraryLoader::{LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};
                LoadLibraryExW(&HSTRING::from(dll.as_os_str()), HANDLE::default(), LOAD_WITH_ALTERED_SEARCH_PATH).map_err(|e| format!("Couldn't load ONNX Runtime: {}", e))?;
            }
            ort::init_from(&dll).map_err(|e| e.to_string())?.with_name("briefcast").build().map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| e.clone())
}

// ---- Cutting a person out -----------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
struct SourceVideo {
    width: u32,
    height: u32,
    // Frames per second (the stream's average rate) and length in seconds.
    fps: f64,
    duration: f64,
    // How the webview decodes its colours (browser_color_for).
    matrix: &'static str,
    range: &'static str,
}

fn probe_source(ffprobe: &Path, source: &str) -> Result<SourceVideo, String> {
    let mut cmd = Command::new(ffprobe);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let out = cmd
        .args(["-v", "quiet", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,color_space,color_range:format=duration", "-of", "json", source])
        .output()
        .map_err(|e| format!("Couldn't read the video: {}", e))?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|_| "Couldn't read the video's details".to_string())?;
    let s = &v["streams"][0];
    let rate = |key: &str| -> Option<f64> {
        let (n, d) = s[key].as_str()?.split_once('/')?;
        let (n, d) = (n.parse::<f64>().ok()?, d.parse::<f64>().ok()?);
        (d > 0.0 && n > 0.0).then_some(n / d)
    };
    let fps = rate("avg_frame_rate").or_else(|| rate("r_frame_rate")).filter(|f| (1.0..=240.0).contains(f)).unwrap_or(30.0);
    let (width, height) = (s["width"].as_u64().unwrap_or(0) as u32, s["height"].as_u64().unwrap_or(0) as u32);
    if width == 0 || height == 0 {
        return Err("That file has no picture to cut out.".into());
    }
    let duration = v["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0);
    let (matrix, range) = crate::commands::conversion::browser_color_for(s["color_space"].as_str().unwrap_or(""), s["color_range"].as_str().unwrap_or(""), height as i64);
    Ok(SourceVideo { width, height, fps, duration, matrix, range })
}

// The size the cut-out is made at: the source's, at most 1280x720 (a picture-in-picture is rarely
// shown bigger), even on both sides; and RVM's downsample ratio for it - the network sees the frame
// at about 384 px on its long side and refines the matte back up to full size (the authors suggest
// 256-512; past ~400 it costs far more time than it adds edge detail).
fn work_size(width: u32, height: u32) -> (u32, u32, f32) {
    let scale = (1280.0 / width as f64).min(720.0 / height as f64).min(1.0);
    let even = |v: f64| ((v / 2.0).round() as u32 * 2).max(2);
    let (w, h) = (even(width as f64 * scale), even(height as f64 * scale));
    let ratio = (384.0 / w.max(h) as f32).min(1.0);
    (w, h, ratio)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CutoutProgress {
    job_id: String,
    // 0..1 of the frames done.
    progress: f64,
}

fn running_jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

const CANCELLED_ERR: &str = "BACKGROUND_REMOVAL_CANCELLED";

// Part of the source frame to cut out alone (fractions of its width/height) - a webcam bubble baked
// into a screen recording.
#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Region {
    fn clamped(self) -> Option<Region> {
        if ![self.x, self.y, self.width, self.height].iter().all(|v| v.is_finite()) {
            return None;
        }
        let width = self.width.clamp(0.02, 1.0);
        let height = self.height.clamp(0.02, 1.0);
        let r = Region { x: self.x.clamp(0.0, 1.0 - width), y: self.y.clamp(0.0, 1.0 - height), width, height };
        (r.width < 0.999 || r.height < 0.999).then_some(r)
    }
}

// Makes (or finds already made) the cut-out of `source_path` - or of just `region` of it: a VP9+alpha
// WebM the same length and frame timing as the source. Emits "background-removal-progress"
// {jobId, progress}.
#[tauri::command]
pub async fn remove_video_background(app_handle: AppHandle, window: Window, source_path: String, job_id: String, region: Option<Region>) -> Result<String, String> {
    let dir = engine_dir(&app_handle)?;
    let region = region.and_then(Region::clamped);
    let key = match region {
        Some(r) => format!("{CUTOUT_VERSION}|{:.4},{:.4},{:.4},{:.4}", r.x, r.y, r.width, r.height),
        None => CUTOUT_VERSION.to_string(),
    };
    let out = crate::commands::conversion::derived_media_path(&source_path, "cutout", &key, "webm")?;
    if out.exists() {
        return Ok(out.to_string_lossy().to_string());
    }
    let (ffmpeg, ffprobe) = (get_ffmpeg_path(&app_handle)?, get_ffprobe_path(&app_handle)?);
    let cancel = Arc::new(AtomicBool::new(false));
    running_jobs().lock().unwrap().insert(job_id.clone(), cancel.clone());
    let id = job_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if !engine_ready(&dir) {
            return Err("ENGINE_MISSING".to_string());
        }
        let env = ort_environment(&dir)?;
        let part = out.with_extension("part.webm");
        let progress = |p: f64| {
            let _ = window.emit("background-removal-progress", CutoutProgress { job_id: id.clone(), progress: p });
        };
        match cut_out(env, &dir.join(MODEL_ASSET.file_name), &ffmpeg, &ffprobe, &source_path, region, &part, &cancel, &progress) {
            Ok(()) => {
                std::fs::rename(&part, &out).map_err(|e| format!("Couldn't save the cut-out: {}", e))?;
                Ok(out.to_string_lossy().to_string())
            }
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                if e != CANCELLED_ERR {
                    log::warn!("Background removal of {} failed: {}", source_path, e);
                }
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("Background removal stopped unexpectedly: {}", e))?;
    running_jobs().lock().unwrap().remove(&job_id);
    result
}

#[tauri::command(async)]
pub fn cancel_background_removal(job_id: String) {
    if let Some(flag) = running_jobs().lock().unwrap().get(&job_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

// Kills both ffmpeg processes on the way out, however it ends.
struct Children(Vec<std::process::Child>);
impl Drop for Children {
    fn drop(&mut self) {
        for c in self.0.iter_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn cut_out(
    env: &ort::environment::Environment,
    model: &Path,
    ffmpeg: &Path,
    ffprobe: &Path,
    source: &str,
    region: Option<Region>,
    out: &Path,
    cancel: &AtomicBool,
    progress: &dyn Fn(f64),
) -> Result<(), String> {
    use ort::session::Session;
    use ort::value::Tensor;

    let src = probe_source(ffprobe, source)?;
    let (rw, rh) = match region {
        Some(r) => (((src.width as f64 * r.width).round() as u32).max(2), ((src.height as f64 * r.height).round() as u32).max(2)),
        None => (src.width, src.height),
    };
    let (w, h, ratio) = work_size(rw, rh);
    let crop = region.map(|r| format!("crop=iw*{:.6}:ih*{:.6}:iw*{:.6}:ih*{:.6},", r.width, r.height, r.x, r.y)).unwrap_or_default();
    let (wu, hu) = (w as usize, h as usize);
    let fps = format!("{:.6}", src.fps);
    let total_frames = (src.duration * src.fps).round().max(1.0);

    // DirectML first; ONNX Runtime uses the CPU when it can't (no DirectX 12 GPU). Half the cores at
    // most, so the editor stays responsive while it runs (all of them starved the webview for ~2 s
    // at a time).
    let threads = (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) / 2).clamp(1, 4);
    let mut session = Session::builder(env)
        .and_then(|b| b.with_execution_providers([ort::ep::DirectML::default().build()]).map_err(|e| e.into()))
        .and_then(|b| b.with_intra_threads(threads).map_err(|e| e.into()))
        .and_then(|mut b| b.commit_from_file(model))
        .map_err(|e| format!("The background-removal model didn't load: {}", e))?;

    // Decoder: constant frame rate from 0 (as the webview's media clock counts), RGB the way the
    // webview decodes it.
    let mut dec = Command::new(ffmpeg);
    #[cfg(windows)]
    hide_console_window(&mut dec);
    dec.args(["-v", "error", "-i", source, "-an", "-sn", "-vf"])
        .arg(format!(
            "setpts=PTS-STARTPTS,fps={fps},{crop}scale={w}:{h}:in_color_matrix={m}:in_range={r}:flags=bicubic,format=rgb24",
            m = src.matrix,
            r = src.range
        ))
        .args(["-f", "rawvideo", "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Encoder: VP9 with alpha, tagged BT.709 so the webview and ffmpeg read its colours alike.
    let mut enc = Command::new(ffmpeg);
    #[cfg(windows)]
    hide_console_window(&mut enc);
    enc.args(["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s"])
        .arg(format!("{w}x{h}"))
        .args(["-r", &fps, "-i", "pipe:0", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva420p"])
        .args(["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "18", "-b:v", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-auto-alt-ref", "0"])
        .args(["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-f", "webm"])
        .arg(out)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut children = Children(Vec::new());
    children.0.push(dec.spawn().map_err(|e| format!("Couldn't start ffmpeg: {}", e))?);
    children.0.push(enc.spawn().map_err(|e| format!("Couldn't start ffmpeg: {}", e))?);
    let mut reader = children.0[0].stdout.take().ok_or("ffmpeg gave no output")?;
    let mut writer = children.0[1].stdin.take().ok_or("ffmpeg took no input")?;

    let plane = wu * hu;
    let mut rgb = vec![0u8; plane * 3];
    let mut chw = vec![0f32; plane * 3];
    let mut rgba = vec![0u8; plane * 4];
    // The recurrent state, carried frame to frame (RVM starts from 1x1x1x1 zeros).
    let zero = || Tensor::from_array(([1usize, 1, 1, 1], vec![0f32])).map(|t| t.into_dyn());
    let mut rec: Vec<ort::value::DynValue> = (0..4).map(|_| zero()).collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    let ratio_tensor = Tensor::from_array(([1usize], vec![ratio])).map_err(|e| e.to_string())?;
    let mut done = 0f64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED_ERR.into());
        }
        if !read_frame(&mut reader, &mut rgb)? {
            break;
        }
        pixel_convert::rgb_to_planar(&rgb, &mut chw);
        let frame = Tensor::from_array(([1usize, 3, hu, wu], chw.clone())).map_err(|e| e.to_string())?;
        let [r1, r2, r3, r4]: [ort::value::DynValue; 4] = std::mem::take(&mut rec).try_into().map_err(|_| "recurrent state".to_string())?;
        let mut outputs = session
            .run(ort::inputs!["src" => frame, "r1i" => r1, "r2i" => r2, "r3i" => r3, "r4i" => r4, "downsample_ratio" => ratio_tensor.view()])
            .map_err(|e| format!("Background removal failed on a frame: {}", e))?;
        {
            let (_, fgr) = outputs["fgr"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            let (_, pha) = outputs["pha"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            pixel_convert::planar_to_rgba(fgr, pha, &mut rgba);
        }
        for name in ["r1o", "r2o", "r3o", "r4o"] {
            rec.push(outputs.remove(name).ok_or("recurrent state missing")?);
        }
        drop(outputs);
        writer.write_all(&rgba).map_err(|e| format!("Couldn't write the cut-out: {}", e))?;
        done += 1.0;
        if done as u64 % 5 == 0 {
            progress((done / total_frames).min(0.99));
        }
    }
    drop(writer);
    let enc_child = children.0.remove(1);
    let enc_out = enc_child.wait_with_output().map_err(|e| e.to_string())?;
    if !enc_out.status.success() {
        return Err(format!("Couldn't encode the cut-out: {}", String::from_utf8_lossy(&enc_out.stderr).lines().last().unwrap_or("")));
    }
    if done < 1.0 {
        return Err("No frames could be read from the video.".into());
    }
    progress(1.0);
    Ok(())
}

// Fills `buf` with the next frame; false at the end of the stream.
fn read_frame(reader: &mut impl Read, buf: &mut [u8]) -> Result<bool, String> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => return if filled == 0 { Ok(false) } else { Err("The video ended mid-frame.".into()) },
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(format!("Couldn't read the video: {}", e)),
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn works_at_up_to_720p_with_a_384px_view_for_the_network() {
        assert_eq!(work_size(1920, 1080), (1280, 720, 0.3));
        assert_eq!(work_size(640, 480), (640, 480, 0.6));
        assert_eq!(work_size(1080, 1920), (406, 720, 384.0 / 720.0));
        // Odd sizes come out even.
        assert_eq!(work_size(321, 241).0 % 2, 0);
    }

    #[test]
    fn regions_stay_inside_the_frame() {
        let r = Region { x: 0.9, y: -0.2, width: 0.3, height: 0.25 }.clamped().unwrap();
        assert!((r.x - 0.7).abs() < 1e-9 && r.y == 0.0 && r.width == 0.3);
        assert_eq!(Region { x: 0.0, y: 0.0, width: 1.0, height: 1.0 }.clamped(), None);
        assert_eq!(Region { x: f64::NAN, y: 0.0, width: 0.5, height: 0.5 }.clamped(), None);
    }

    // Not a unit test: runs the real engine ($BGR_ENGINE_DIR: the three DLLs and the model) on a
    // synthetic clip with $FFMPEG_DIR's ffmpeg, and checks the cut-out has every frame and an alpha
    // channel.
    #[test]
    #[ignore]
    fn cuts_out_a_clip_frame_for_frame() {
        let (Ok(engine), Ok(ff)) = (std::env::var("BGR_ENGINE_DIR"), std::env::var("FFMPEG_DIR")) else { return };
        let engine = PathBuf::from(engine);
        let ffmpeg = PathBuf::from(&ff).join("ffmpeg.exe");
        let ffprobe = PathBuf::from(&ff).join("ffprobe.exe");
        let tmp = std::env::temp_dir().join(format!("briefcast_bgr_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("src.mp4");
        let st = Command::new(&ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2", "-pix_fmt", "yuv420p", "-c:v", "libx264"])
            .arg(&src)
            .status()
            .unwrap();
        assert!(st.success());
        let env = ort_environment(&engine).unwrap();
        let out = tmp.join("cut.webm");
        let cancel = AtomicBool::new(false);
        let last = std::sync::Mutex::new(0.0);
        let t = std::time::Instant::now();
        cut_out(env, &engine.join(MODEL_ASSET.file_name), &ffmpeg, &ffprobe, &src.to_string_lossy(), None, &out, &cancel, &|p| *last.lock().unwrap() = p).unwrap();
        eprintln!("50 frames at 640x360 in {:?}", t.elapsed());
        assert_eq!(*last.lock().unwrap(), 1.0);
        // Decoded with libvpx (which keeps the alpha plane): all 50 frames, yuva420p.
        let probe = Command::new(&ffmpeg)
            .args(["-v", "error", "-c:v", "libvpx-vp9", "-i"])
            .arg(&out)
            .args(["-f", "framemd5", "-pix_fmt", "yuva420p", "-"])
            .output()
            .unwrap();
        let frames = String::from_utf8_lossy(&probe.stdout).lines().filter(|l| !l.starts_with('#')).count();
        assert_eq!(frames, 50);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
