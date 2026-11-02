// "Find & hide" for a person: when what the user outlined is a face, it's that person who's found -
// in every photo and every shot of the video, at any size, angle or lighting the face can still be
// told apart in - not the same patch of pixels (object_find.rs), which a face only matches in the
// very shot it was outlined in.
//
// Two small networks from OpenCV's model zoo, on ONNX Runtime (the same engine background removal
// downloads - background_removal.rs):
// - YuNet (Wu et al., 2023; face_detection_yunet_2023mar, MIT) finds every face in a frame with its
//   five landmarks. It reads a fixed 640x640 picture, so a small face in a big photo is looked for
//   again in overlapping zoomed-in tiles.
// - SFace (Zhong et al., 2021; face_recognition_sface_2021dec, Apache-2.0) turns a face, aligned on
//   those landmarks to its 112x112 template, into 128 numbers; two faces of one person point the
//   same way (cosine similarity, ~0.36 is OpenCV's "same person" line).
//
// A photo is one picture held for its clip. Video is sampled a few times a second; a face that
// matches starts a track, which then follows that face from sample to sample even through moments
// it can't be recognised in (turned away, blurred by motion) - so the cover doesn't flicker off.
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Window};

#[cfg(windows)]
use crate::commands::recording::hide_console_window;
use crate::commands::background_removal::{engine_dir, engine_dlls_present, engine_dlls_ready, ensure_engine_dlls, ort_environment, ENGINE_DOWNLOAD_SIZE};
use crate::commands::object_find::{jobs, FindAnchor, FindRange, FoundSample, FoundTrack};
use crate::services::asset_download::{download_asset, is_valid_install, DownloadAsset};
use crate::services::responsiveness::blocking;
use crate::services::utility::{get_ffmpeg_path, get_ffprobe_path};

const DETECTOR: DownloadAsset = DownloadAsset {
    file_name: "face_detection_yunet_2023mar.onnx",
    url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    size: 232_589,
};
const RECOGNIZER: DownloadAsset = DownloadAsset {
    file_name: "face_recognition_sface_2021dec.onnx",
    url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    size: 38_696_353,
};

// YuNet's input side, the confidence a face needs, and the overlap at which two finds are one face.
const DET_SIZE: usize = 640;
const DET_SCORE: f32 = 0.6;
const NMS_IOU: f32 = 0.3;
// SFace's aligned face, and where its template puts the eyes, nose tip and mouth corners.
const FACE_SIZE: usize = 112;
const TEMPLATE: [[f32; 2]; 5] = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
// Video samples per second, and the longest side frames are decoded at (faces keep enough detail
// to be recognised; a 4K frame isn't needed for that).
const SAMPLE_FPS: f64 = 6.0;
const DECODE_LONG_SIDE: i64 = 1280;
// A photo's track: the same box at this rate across its clip (the editor maps each through the
// clip's zoom and pan).
const STILL_STEP: f64 = 1.0 / 12.0;
// A track keeps following through this many samples without the face.
const TRACK_GAP: usize = 3;

const DOWNLOAD_CANCELLED_ERR: &str = "FACE_MATCHING_DOWNLOAD_CANCELLED";
static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

// Everything in place at its pinned size. The download verifies each file by hash as it lands
// (download_asset, ensure_engine_dlls); hashing ~100 MB again on every check and search would cost
// seconds each time in a debug build.
fn models_ready(dir: &Path) -> bool {
    let sized = |a: &DownloadAsset| std::fs::metadata(dir.join(a.file_name)).map(|m| m.len() == a.size).unwrap_or(false);
    engine_dlls_present(dir) && sized(&DETECTOR) && sized(&RECOGNIZER)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceMatchingStatus {
    // "ready", "needs-download" (about `download_mb`), or "unsupported" on this platform.
    state: &'static str,
    download_mb: u64,
}

#[tauri::command]
pub async fn face_matching_status(app_handle: AppHandle) -> Result<FaceMatchingStatus, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Ok(FaceMatchingStatus { state: "unsupported", download_mb: 0 });
    }
    let dir = engine_dir(&app_handle)?;
    let (ready, engine) = blocking(move || {
        let ready = models_ready(&dir);
        (ready, ready || engine_dlls_present(&dir))
    })
    .await?;
    let missing = if engine { 0 } else { ENGINE_DOWNLOAD_SIZE } + DETECTOR.size + RECOGNIZER.size;
    Ok(FaceMatchingStatus { state: if ready { "ready" } else { "needs-download" }, download_mb: (missing / 1_000_000).max(1) })
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

// Fetches whatever's missing of the engine and the two models. Emits "face-matching-download".
#[tauri::command]
pub async fn download_face_matching(app_handle: AppHandle, window: Window) -> Result<(), String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("Face matching isn't available on this platform yet.".into());
    }
    let dir = engine_dir(&app_handle)?;
    DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);
    blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create the engine folder: {}", e))?;
        let engine = if engine_dlls_ready(&dir) { 0 } else { ENGINE_DOWNLOAD_SIZE };
        let total = engine + DETECTOR.size + RECOGNIZER.size;
        let emit = |downloaded: u64| {
            let _ = window.emit("face-matching-download", DownloadProgress { downloaded, total });
        };
        ensure_engine_dlls(&dir, &DOWNLOAD_CANCELLED, DOWNLOAD_CANCELLED_ERR, &emit)?;
        let mut base = engine;
        for asset in [&DETECTOR, &RECOGNIZER] {
            let path = dir.join(asset.file_name);
            if !is_valid_install(&path, asset) {
                download_asset(asset, &path, &DOWNLOAD_CANCELLED, DOWNLOAD_CANCELLED_ERR, &|n| emit(base + n))?;
            }
            base += asset.size;
            emit(base);
        }
        let verified = engine_dlls_ready(&dir) && is_valid_install(&dir.join(DETECTOR.file_name), &DETECTOR) && is_valid_install(&dir.join(RECOGNIZER.file_name), &RECOGNIZER);
        if verified { Ok(()) } else { Err("Face matching didn't verify after downloading.".into()) }
    })
    .await?
}

#[tauri::command(async)]
pub fn cancel_face_matching_download() {
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
}

// ---- Pictures --------------------------------------------------------------------------------------

struct Rgb {
    w: usize,
    h: usize,
    data: Vec<u8>,
}

impl Rgb {
    // Bilinear sample of channel `c` at (x, y), edges clamped.
    fn sample(&self, x: f32, y: f32, c: usize) -> f32 {
        let x = x.clamp(0.0, (self.w - 1) as f32);
        let y = y.clamp(0.0, (self.h - 1) as f32);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let at = |px: usize, py: usize| self.data[(py * self.w + px) * 3 + c] as f32;
        let top = at(x0, y0) * (1.0 - fx) + at(x1, y0) * fx;
        let bottom = at(x0, y1) * (1.0 - fx) + at(x1, y1) * fx;
        top * (1.0 - fy) + bottom * fy
    }
}

#[derive(Clone, Copy, Debug)]
struct Face {
    // Box (top-left, size) and landmarks in the frame's pixels; YuNet's confidence.
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    score: f32,
    kps: [[f32; 2]; 5],
    // Which of the people looked for this face is most like (set once it's been compared).
    who: usize,
}

fn iou(a: &Face, b: &Face) -> f32 {
    let x1 = a.x.max(b.x);
    let y1 = a.y.max(b.y);
    let x2 = (a.x + a.w).min(b.x + b.w);
    let y2 = (a.y + a.h).min(b.y + b.h);
    let inter = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
    inter / (a.w * a.h + b.w * b.h - inter).max(1e-6)
}

struct Models {
    detector: ort::session::Session,
    recognizer: ort::session::Session,
}

impl Models {
    fn load(dir: &Path) -> Result<Models, String> {
        use ort::session::Session;
        let env = ort_environment(dir)?;
        let threads = (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) / 2).clamp(1, 4);
        let open = |file: &str| {
            // On the CPU: both are small (a 640x640 detector, a 112x112 embedder), and starting them
            // on DirectML compiles GPU shaders for seconds before the first face is looked at.
            Session::builder(env)
                .and_then(|b| b.with_intra_threads(threads).map_err(|e| e.into()))
                .and_then(|mut b| b.commit_from_file(dir.join(file)))
                .map_err(|e| format!("Face matching didn't load: {}", e))
        };
        Ok(Models { detector: open(DETECTOR.file_name)?, recognizer: open(RECOGNIZER.file_name)? })
    }

    // Every face in the part of `img` at (rx, ry, rw, rh), fitted whole into YuNet's square (the
    // rest of it black). Coordinates come back in `img`'s pixels.
    fn detect_in(&mut self, img: &Rgb, rx: f32, ry: f32, rw: f32, rh: f32) -> Result<Vec<Face>, String> {
        use ort::value::Tensor;
        let k = DET_SIZE as f32 / rw.max(rh);
        let (dw, dh) = (((rw * k).round() as usize).min(DET_SIZE), ((rh * k).round() as usize).min(DET_SIZE));
        let plane = DET_SIZE * DET_SIZE;
        let mut input = vec![0f32; plane * 3];
        // Bilinear, with each column's and row's source pixels and weights worked out once - this runs
        // for every tile of every frame searched.
        let taps = |n: usize, origin: f32, limit: usize| -> Vec<(usize, usize, f32)> {
            (0..n)
                .map(|i| {
                    let p = (origin + (i as f32 + 0.5) / k - 0.5).clamp(0.0, (limit - 1) as f32);
                    let p0 = p.floor() as usize;
                    (p0, (p0 + 1).min(limit - 1), p - p0 as f32)
                })
                .collect()
        };
        let (cols, rows) = (taps(dw, rx, img.w), taps(dh, ry, img.h));
        let stride = img.w * 3;
        for (v, &(y0, y1, fy)) in rows.iter().enumerate() {
            let (top, bottom) = (&img.data[y0 * stride..(y0 + 1) * stride], &img.data[y1 * stride..(y1 + 1) * stride]);
            for (u, &(x0, x1, fx)) in cols.iter().enumerate() {
                let at = v * DET_SIZE + u;
                // YuNet reads BGR, 0..255.
                for (plane_index, c) in [2usize, 1, 0].into_iter().enumerate() {
                    let t = top[x0 * 3 + c] as f32 * (1.0 - fx) + top[x1 * 3 + c] as f32 * fx;
                    let b = bottom[x0 * 3 + c] as f32 * (1.0 - fx) + bottom[x1 * 3 + c] as f32 * fx;
                    input[plane_index * plane + at] = t + (b - t) * fy;
                }
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, DET_SIZE, DET_SIZE], input)).map_err(|e| e.to_string())?;
        let outputs = self.detector.run(ort::inputs!["input" => tensor]).map_err(|e| format!("Face detection failed: {}", e))?;
        let mut faces = Vec::new();
        for stride in [8usize, 16, 32] {
            let cols = DET_SIZE / stride;
            let get = |name: &str| outputs[format!("{name}_{stride}").as_str()].try_extract_tensor::<f32>().map(|(_, d)| d.to_vec()).map_err(|e| e.to_string());
            let (cls, obj, bbox, kps) = (get("cls")?, get("obj")?, get("bbox")?, get("kps")?);
            for i in 0..cls.len() {
                let score = (cls[i].clamp(0.0, 1.0) * obj[i].clamp(0.0, 1.0)).sqrt();
                if score < DET_SCORE {
                    continue;
                }
                let (r, c) = ((i / cols) as f32, (i % cols) as f32);
                let s = stride as f32;
                let (cx, cy) = ((c + bbox[i * 4]) * s, (r + bbox[i * 4 + 1]) * s);
                let (bw, bh) = (bbox[i * 4 + 2].exp() * s, bbox[i * 4 + 3].exp() * s);
                let mut points = [[0f32; 2]; 5];
                for (n, p) in points.iter_mut().enumerate() {
                    *p = [rx + (kps[i * 10 + 2 * n] + c) * s / k, ry + (kps[i * 10 + 2 * n + 1] + r) * s / k];
                }
                faces.push(Face { x: rx + (cx - bw / 2.0) / k, y: ry + (cy - bh / 2.0) / k, w: bw / k, h: bh / k, score, kps: points, who: 0 });
            }
        }
        Ok(faces)
    }

    // Every face in the frame: once whole, and - for faces too small to show up that way - again in
    // overlapping tiles of `tile_frac` of its shorter side (none when 0).
    fn detect(&mut self, img: &Rgb, tile_frac: f32) -> Result<Vec<Face>, String> {
        let (w, h) = (img.w as f32, img.h as f32);
        let mut faces = self.detect_in(img, 0.0, 0.0, w, h)?;
        if tile_frac > 0.0 {
            let t = (w.min(h) * tile_frac).max(64.0);
            let step = t * 0.6;
            let mut y: f32 = 0.0;
            loop {
                let mut x: f32 = 0.0;
                loop {
                    faces.extend(self.detect_in(img, x.min(w - t).max(0.0), y.min(h - t).max(0.0), t.min(w), t.min(h))?);
                    if x + t >= w {
                        break;
                    }
                    x += step;
                }
                if y + t >= h {
                    break;
                }
                y += step;
            }
        }
        faces.sort_by(|a, b| b.score.total_cmp(&a.score));
        let mut kept: Vec<Face> = Vec::new();
        for f in faces {
            if kept.iter().all(|g| iou(&f, g) < NMS_IOU) {
                kept.push(f);
            }
        }
        Ok(kept)
    }

    // The faces in and around an outline - one look at just that part of the frame (a little beyond
    // the outline, squared up), so even a small face there is seen at full detail.
    fn detect_around(&mut self, img: &Rgb, outline: &Face) -> Result<Vec<Face>, String> {
        let side = (outline.w.max(outline.h) * 1.3).max(64.0).min(img.w.max(img.h) as f32);
        let x = (outline.x + outline.w / 2.0 - side / 2.0).clamp(0.0, (img.w as f32 - side).max(0.0));
        let y = (outline.y + outline.h / 2.0 - side / 2.0).clamp(0.0, (img.h as f32 - side).max(0.0));
        let mut faces = self.detect_in(img, x, y, side.min(img.w as f32), side.min(img.h as f32))?;
        faces.sort_by(|a, b| b.score.total_cmp(&a.score));
        let mut kept: Vec<Face> = Vec::new();
        for f in faces {
            if kept.iter().all(|g| iou(&f, g) < NMS_IOU) {
                kept.push(f);
            }
        }
        Ok(kept)
    }

    // The face's identity: aligned onto SFace's template (the similarity transform that best maps
    // its landmarks there), embedded, normalised to length 1.
    fn embed(&mut self, img: &Rgb, face: &Face) -> Result<Vec<f32>, String> {
        use ort::value::Tensor;
        let (a, b, tx, ty) = similarity(&face.kps, &TEMPLATE);
        // Inverse: src = A^-1 (dst - t), A = [a -b; b a].
        let det = (a * a + b * b).max(1e-9);
        let plane = FACE_SIZE * FACE_SIZE;
        let mut input = vec![0f32; plane * 3];
        for v in 0..FACE_SIZE {
            for u in 0..FACE_SIZE {
                let (dx, dy) = (u as f32 - tx, v as f32 - ty);
                let (sx, sy) = ((a * dx + b * dy) / det, (-b * dx + a * dy) / det);
                // SFace reads RGB, 0..255.
                for c in 0..3 {
                    input[c * plane + v * FACE_SIZE + u] = img.sample(sx, sy, c);
                }
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, FACE_SIZE, FACE_SIZE], input)).map_err(|e| e.to_string())?;
        let outputs = self.recognizer.run(ort::inputs!["data" => tensor]).map_err(|e| format!("Face matching failed: {}", e))?;
        let (_, v) = outputs["fc1"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
        Ok(v.iter().map(|x| x / norm).collect())
    }
}

// The models, loaded once and kept (loading them takes seconds; a search or an "is it a face?" check
// shouldn't pay that each time). One search at a time uses them.
static MODELS: std::sync::Mutex<Option<Models>> = std::sync::Mutex::new(None);
fn loaded_models(dir: &Path) -> Result<std::sync::MutexGuard<'static, Option<Models>>, String> {
    let mut guard = MODELS.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(Models::load(dir)?);
    }
    Ok(guard)
}

// Least-squares similarity (rotation, uniform scale, translation - no mirroring) taking `src` onto
// `dst`: dst = [a -b; b a] src + t. Closed form in 2-D.
fn similarity(src: &[[f32; 2]; 5], dst: &[[f32; 2]; 5]) -> (f32, f32, f32, f32) {
    let n = src.len() as f32;
    let (sx, sy) = (src.iter().map(|p| p[0]).sum::<f32>() / n, src.iter().map(|p| p[1]).sum::<f32>() / n);
    let (dx, dy) = (dst.iter().map(|p| p[0]).sum::<f32>() / n, dst.iter().map(|p| p[1]).sum::<f32>() / n);
    let (mut num_a, mut num_b, mut den) = (0f32, 0f32, 0f32);
    for (p, q) in src.iter().zip(dst) {
        let (px, py, qx, qy) = (p[0] - sx, p[1] - sy, q[0] - dx, q[1] - dy);
        num_a += px * qx + py * qy;
        num_b += px * qy - py * qx;
        den += px * px + py * py;
    }
    let (a, b) = (num_a / den.max(1e-9), num_b / den.max(1e-9));
    (a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy))
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

// ---- Decoding --------------------------------------------------------------------------------------

fn is_still(path: &str) -> bool {
    crate::commands::conversion::is_still_image_path(path)
}

// The size frames are decoded at: the source's (as it decodes - upright), the longest side capped.
fn decode_size(ffprobe: &Path, source: &str) -> Result<(usize, usize), String> {
    let (w, h) = crate::commands::conversion::probe_video_dimensions(&ffprobe.to_path_buf(), source).ok_or("Couldn't read the picture's size")?;
    let k = (DECODE_LONG_SIDE as f64 / w.max(h) as f64).min(1.0);
    let even = |v: f64| ((v.round() as usize) / 2 * 2).max(2);
    Ok((even(w as f64 * k), even(h as f64 * k)))
}

// RGB frames of `source` from `from` for `seconds` at `fps` - or a photo's one picture.
fn decoder(ffmpeg: &Path, source: &str, from: f64, seconds: f64, fps: f64, w: usize, h: usize) -> Result<std::process::Child, String> {
    let mut cmd = Command::new(ffmpeg);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.args(["-v", "error", "-nostdin"]);
    if is_still(source) {
        cmd.args(["-i", source, "-frames:v", "1", "-vf", &format!("scale={w}:{h}:flags=area,format=rgb24")]);
    } else {
        cmd.args(["-ss", &format!("{:.4}", from.max(0.0)), "-i", source, "-t", &format!("{:.4}", seconds.max(0.001))]);
        cmd.args(["-an", "-sn", "-vf", &format!("fps={fps:.4},scale={w}:{h}:flags=area,format=rgb24")]);
    }
    cmd.args(["-f", "rawvideo", "pipe:1"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    cmd.spawn().map_err(|e| format!("Couldn't start ffmpeg: {e}"))
}

fn read_frame(out: &mut impl Read, w: usize, h: usize) -> Option<Rgb> {
    let mut data = vec![0u8; w * h * 3];
    out.read_exact(&mut data).ok().map(|_| Rgb { w, h, data })
}

fn first_frame(ffmpeg: &Path, source: &str, time: f64, w: usize, h: usize) -> Result<Rgb, String> {
    let mut child = decoder(ffmpeg, source, time, 0.5, SAMPLE_FPS, w, h)?;
    let frame = child.stdout.take().and_then(|mut out| read_frame(&mut out, w, h));
    let _ = child.kill();
    let _ = child.wait();
    frame.ok_or_else(|| "Couldn't read that moment of the video".into())
}

// How far into the picture to tile: a photo always (one picture, and its faces are often small); a
// video only when the face being looked for is small in it.
fn tile_frac(still: bool, face_h_frac: f32) -> f32 {
    if still || face_h_frac < 0.08 {
        0.7
    } else {
        0.0
    }
}

fn outline_px(frame: &Rgb, a: &FindAnchor) -> Face {
    Face { x: (a.x * frame.w as f64) as f32, y: (a.y * frame.h as f64) as f32, w: (a.width * frame.w as f64) as f32, h: (a.height * frame.h as f64) as f32, score: 0.0, kps: [[0.0; 2]; 5], who: 0 }
}

// The faces the outline is around - each mostly inside it - biggest first.
fn faces_in_outline(faces: &[Face], outline: &Face) -> Vec<Face> {
    let mut inside: Vec<Face> = faces
        .iter()
        .filter(|f| {
            let x1 = f.x.max(outline.x);
            let y1 = f.y.max(outline.y);
            let x2 = (f.x + f.w).min(outline.x + outline.w);
            let y2 = (f.y + f.h).min(outline.y + outline.h);
            (x2 - x1).max(0.0) * (y2 - y1).max(0.0) / (f.w * f.h).max(1e-6) >= 0.4
        })
        .copied()
        .collect();
    inside.sort_by(|a, b| (b.w * b.h).total_cmp(&(a.w * a.h)));
    inside
}

// What the outline is around, which decides what gets found and covered:
// - "face": one face, outlined about its own size - that face, wherever the person is;
// - "person": one face in an outline well beyond it (head and shoulders, head to toe) - that much of
//   them, sized and placed from their face in each shot (Reach);
// - "faces": several faces, outlined about their own size - each of those faces;
// - "people": several faces in an outline well beyond them (a group, head to toe) - each person's
//   share of it (reaches_of);
// - "thing": no face - the pattern itself (object_find.rs).
fn outline_kind(inside: &[Face], outline: &Face) -> &'static str {
    match inside {
        [] => "thing",
        [one] if reach_of(one, outline).is_some() => "person",
        [_] => "face",
        _ if reaches_of(inside, outline).iter().all(Option::is_some) => "people",
        _ => "faces",
    }
}

// How much of each outlined person to cover. One person: the outline (reach_of). Several in an
// outline well beyond their faces: the outline cut into side-by-side columns, one per person, split
// halfway between neighbouring faces - each person's own body, scaled from their own face. Several
// outlined about their faces: just the faces.
fn reaches_of(inside: &[Face], outline: &Face) -> Vec<Option<Reach>> {
    if inside.len() == 1 {
        return vec![reach_of(&inside[0], outline)];
    }
    let faces_area: f32 = inside.iter().map(|f| f.w * f.h).sum();
    if outline.w * outline.h <= faces_area * 4.0 {
        return vec![None; inside.len()];
    }
    let centre = |f: &Face| f.x + f.w / 2.0;
    let mut order: Vec<usize> = (0..inside.len()).collect();
    order.sort_by(|&a, &b| centre(&inside[a]).total_cmp(&centre(&inside[b])));
    let mut reaches = vec![None; inside.len()];
    for (k, &i) in order.iter().enumerate() {
        let left = if k == 0 { outline.x } else { (centre(&inside[order[k - 1]]) + centre(&inside[i])) / 2.0 };
        let right = if k + 1 == order.len() { outline.x + outline.w } else { (centre(&inside[i]) + centre(&inside[order[k + 1]])) / 2.0 };
        let column = Face { x: left, y: outline.y, w: (right - left).max(1.0), h: outline.h, score: 0.0, kps: [[0.0; 2]; 5], who: 0 };
        let f = &inside[i];
        let fh = f.h.max(1.0);
        reaches[i] = Some(Reach { dx: (column.x + column.w / 2.0 - centre(f)) / fh, dy: (column.y + column.h / 2.0 - (f.y + f.h / 2.0)) / fh, w: column.w / fh, h: column.h / fh });
    }
    reaches
}

// What's covered where the person is found, relative to their face: when the outline is well beyond
// the face - the whole person, head and shoulders - its box, as offsets and sizes in face-heights from
// the face's centre, so it lands on them at whatever size and place they are in each shot. None: just
// the face (an outline about the face's size).
#[derive(Clone, Copy, Debug)]
struct Reach {
    dx: f32,
    dy: f32,
    w: f32,
    h: f32,
}

fn reach_of(face: &Face, outline: &Face) -> Option<Reach> {
    if outline.w * outline.h <= face.w * face.h * 4.0 {
        return None;
    }
    let (fx, fy, fh) = (face.x + face.w / 2.0, face.y + face.h / 2.0, face.h.max(1.0));
    Some(Reach { dx: (outline.x + outline.w / 2.0 - fx) / fh, dy: (outline.y + outline.h / 2.0 - fy) / fh, w: outline.w / fh, h: outline.h / fh })
}

// The box to cover for a face found - the face, or its reach - kept to the frame.
fn covered_box(f: &Face, reach: Option<Reach>, w: usize, h: usize) -> (f32, f32, f32, f32) {
    let (cx, cy, bw, bh) = match reach {
        None => (f.x + f.w / 2.0, f.y + f.h / 2.0, f.w, f.h),
        Some(r) => (f.x + f.w / 2.0 + r.dx * f.h, f.y + f.h / 2.0 + r.dy * f.h, r.w * f.h, r.h * f.h),
    };
    let x0 = (cx - bw / 2.0).max(0.0);
    let y0 = (cy - bh / 2.0).max(0.0);
    let x1 = (cx + bw / 2.0).min(w as f32);
    let y1 = (cy + bh / 2.0).min(h as f32);
    ((x0 + x1) / 2.0, (y0 + y1) / 2.0, (x1 - x0).max(1.0), (y1 - y0).max(1.0))
}

// Loads the models ahead of need - the editor calls it as Find & hide opens, so the first "what's
// outlined?" check doesn't wait seconds for them.
#[tauri::command]
pub async fn prepare_face_matching(app_handle: AppHandle) -> Result<(), String> {
    let dir = engine_dir(&app_handle)?;
    blocking(move || -> Result<(), String> {
        if models_ready(&dir) {
            loaded_models(&dir)?;
        }
        Ok(())
    })
    .await?
}

// ---- Asking whether an outline is a face -----------------------------------------------------------

// What the outline is around (outline_kind) - "unknown" until face matching is downloaded. The
// editor picks what to look for from it, and says so.
#[tauri::command]
pub async fn outline_kind_at(app_handle: AppHandle, anchor: FindAnchor) -> Result<&'static str, String> {
    let dir = engine_dir(&app_handle)?;
    let (ffmpeg, ffprobe) = (get_ffmpeg_path(&app_handle)?, get_ffprobe_path(&app_handle)?);
    blocking(move || -> Result<&'static str, String> {
        if !models_ready(&dir) {
            return Ok("unknown");
        }
        let mut guard = loaded_models(&dir)?;
        let models = guard.as_mut().ok_or("Face matching didn't load")?;
        let (w, h) = decode_size(&ffprobe, &anchor.source_path)?;
        let frame = first_frame(&ffmpeg, &anchor.source_path, anchor.time, w, h)?;
        let outline = outline_px(&frame, &anchor);
        let faces = models.detect_around(&frame, &outline)?;
        Ok(outline_kind(&faces_in_outline(&faces, &outline), &outline))
    })
    .await?
}

// ---- Finding the person ----------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindPersonRequest {
    pub job_id: String,
    pub anchor: FindAnchor,
    pub ranges: Vec<FindRange>,
    // 0..1: higher accepts less-certain matches too (default 0.5).
    #[serde(default)]
    pub sensitivity: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FindProgress {
    job_id: String,
    progress: f64,
    found: usize,
}

// The similarity a face needs to count as the person: 0.45 (sure) .. 0.22 (looser), 0.33 by default
// - a little under OpenCV's 0.36, since a missed face is worse than an extra cover here, and faces
// a couple of dozen pixels tall come out around 0.3 for the right person.
fn match_threshold(sensitivity: f64) -> f32 {
    (0.45 - 0.23 * sensitivity.clamp(0.0, 1.0)) as f32
}

struct Track {
    samples: Vec<(f64, Face, f32)>,
    // Samples since it was last seen.
    missed: usize,
}

// Follows the person through a video range's samples: a face that matches starts a track (or goes on
// one it's next to); a face that's only a weaker match goes on a track it's next to, so one turned
// away for a moment stays covered; a track the face has left for TRACK_GAP samples ends.
fn link(tracks: &mut Vec<Track>, done: &mut Vec<Track>, t: f64, faces: Vec<(Face, f32)>, threshold: f32) {
    let mut taken = vec![false; faces.len()];
    for track in tracks.iter_mut() {
        let last = track.samples.last().unwrap().1;
        let (lx, ly) = (last.x + last.w / 2.0, last.y + last.h / 2.0);
        let reach = last.w.max(last.h) * (1.0 + track.missed as f32);
        let best = faces
            .iter()
            .enumerate()
            .filter(|(i, (_, sim))| !taken[*i] && *sim >= threshold * 0.5)
            .map(|(i, (f, sim))| (i, ((f.x + f.w / 2.0 - lx).powi(2) + (f.y + f.h / 2.0 - ly).powi(2)).sqrt(), *sim))
            .filter(|(_, d, _)| *d <= reach)
            .min_by(|a, b| a.1.total_cmp(&b.1));
        match best {
            Some((i, _, sim)) => {
                taken[i] = true;
                track.samples.push((t, faces[i].0, sim));
                track.missed = 0;
            }
            None => track.missed += 1,
        }
    }
    let (ended, going): (Vec<Track>, Vec<Track>) = std::mem::take(tracks).into_iter().partition(|t| t.missed > TRACK_GAP);
    done.extend(ended);
    *tracks = going;
    for (i, (face, sim)) in faces.into_iter().enumerate() {
        if !taken[i] && sim >= threshold {
            tracks.push(Track { samples: vec![(t, face, sim)], missed: 0 });
        }
    }
}

fn to_found(range_index: usize, source_path: &str, samples: impl IntoIterator<Item = (f64, Face, f32)>, reach: Option<Reach>, w: usize, h: usize) -> FoundTrack {
    FoundTrack {
        range_index,
        source_path: source_path.to_string(),
        samples: samples
            .into_iter()
            .map(|(t, f, sim)| {
                let (cx, cy, bw, bh) = covered_box(&f, reach, w, h);
                FoundSample { t, x: (cx / w as f32) as f64, y: (cy / h as f32) as f64, w: (bw / w as f32) as f64, h: (bh / h as f32) as f64, score: (sim * 1000.0).round() / 1000.0 }
            })
            .collect(),
    }
}

#[tauri::command]
pub async fn find_person(app_handle: AppHandle, window: Window, request: FindPersonRequest) -> Result<Vec<FoundTrack>, String> {
    let dir = engine_dir(&app_handle)?;
    let (ffmpeg, ffprobe) = (get_ffmpeg_path(&app_handle)?, get_ffprobe_path(&app_handle)?);
    let cancel = Arc::new(AtomicBool::new(false));
    jobs().lock().unwrap().insert(request.job_id.clone(), cancel.clone());
    let job_id = request.job_id.clone();
    let result = blocking(move || -> Result<Vec<FoundTrack>, String> {
        if !models_ready(&dir) {
            return Err("FACE_MATCHING_NEEDS_DOWNLOAD".into());
        }
        let mut guard = loaded_models(&dir)?;
        let models = guard.as_mut().ok_or("Face matching didn't load")?;
        let a = &request.anchor;
        let threshold = match_threshold(request.sensitivity.unwrap_or(0.5));
        // Who to look for: the face the outline is around, on the frame it was drawn on.
        let (aw, ah) = decode_size(&ffprobe, &a.source_path)?;
        let frame = first_frame(&ffmpeg, &a.source_path, a.time, aw, ah)?;
        let outline = outline_px(&frame, a);
        let faces = models.detect_around(&frame, &outline)?;
        let targets = faces_in_outline(&faces, &outline);
        if targets.is_empty() {
            return Err("NO_FACE_IN_OUTLINE".into());
        }
        // Who: everyone outlined. How much of them: one person's outline as drawn (their face, or
        // more of them); several people's faces each.
        let identities = targets.iter().map(|t| models.embed(&frame, t)).collect::<Result<Vec<_>, _>>()?;
        let reaches = reaches_of(&targets, &outline);
        let target_h = targets.iter().map(|t| t.h).fold(f32::MAX, f32::min) / frame.h as f32;
        // How much a face found is like the people looked for - the closest of them.
        let likeness = |e: &[f32]| identities.iter().enumerate().map(|(i, id)| (cosine(e, id), i)).fold((f32::MIN, 0), |a, b| if b.0 > a.0 { b } else { a });

        let total: f64 = request.ranges.iter().map(|r| if is_still(&r.source_path) { 1.0 } else { (r.end - r.start).max(0.0) }).sum::<f64>().max(1e-3);
        let mut done_work = 0f64;
        let mut found: Vec<FoundTrack> = Vec::new();
        let emit = |p: f64, n: usize| {
            let _ = window.emit("find-objects-progress", FindProgress { job_id: job_id.clone(), progress: p.min(0.99), found: n });
        };
        for (range_index, r) in request.ranges.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let (w, h) = decode_size(&ffprobe, &r.source_path)?;
            if is_still(&r.source_path) {
                // A photo: its picture, every face in it, each one that's the person held for the clip.
                let picture = first_frame(&ffmpeg, &r.source_path, 0.0, w, h)?;
                for face in models.detect(&picture, tile_frac(true, target_h))? {
                    let (sim, who) = likeness(&models.embed(&picture, &face)?);
                    if sim < threshold {
                        continue;
                    }
                    let reach = reaches[who];
                    let steps = (((r.end - r.start) / STILL_STEP).ceil() as usize).max(1);
                    found.push(to_found(range_index, &r.source_path, (0..=steps).map(|k| ((r.start + k as f64 * STILL_STEP).min(r.end), face, sim)), reach, w, h));
                }
                done_work += 1.0;
                emit(done_work / total, found.len());
                continue;
            }
            let span = r.end - r.start;
            if span < 0.05 {
                continue;
            }
            let mut child = decoder(&ffmpeg, &r.source_path, r.start, span, SAMPLE_FPS, w, h)?;
            let mut out = child.stdout.take().ok_or("Couldn't read ffmpeg's output")?;
            let (mut tracks, mut ended) = (Vec::new(), Vec::new());
            let tiles = tile_frac(false, target_h);
            let mut k = 0usize;
            while let Some(picture) = read_frame(&mut out, w, h) {
                if cancel.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("cancelled".into());
                }
                let t = r.start + k as f64 / SAMPLE_FPS;
                let mut scored = Vec::new();
                for face in models.detect(&picture, tiles)? {
                    let (sim, who) = likeness(&models.embed(&picture, &face)?);
                    scored.push((Face { who, ..face }, sim));
                }
                link(&mut tracks, &mut ended, t, scored, threshold);
                k += 1;
                if k % 3 == 0 {
                    emit((done_work + (k as f64 / SAMPLE_FPS).min(span)) / total, found.len() + tracks.len() + ended.len());
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            ended.extend(tracks);
            for track in ended {
                // Who the track is: whoever its surest look was most like.
                let reach = track.samples.iter().max_by(|a, b| a.2.total_cmp(&b.2)).map(|s| reaches[s.1.who]).unwrap_or(None);
                if track.samples.len() >= 2 {
                    found.push(to_found(range_index, &r.source_path, track.samples, reach, w, h));
                } else if let Some(&(t, face, sim)) = track.samples.first() {
                    // Seen in one sample only: held for that sample's span.
                    found.push(to_found(range_index, &r.source_path, [(t, face, sim), ((t + 1.0 / SAMPLE_FPS).min(r.end), face, sim)], reach, w, h));
                }
            }
            done_work += span;
        }
        emit(1.0, found.len());
        Ok(found)
    })
    .await;
    jobs().lock().unwrap().remove(&request.job_id);
    result?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similarity_recovers_a_known_transform() {
        // dst = 2*R(30deg)*src + (5, -3)
        let (c, s) = (30f32.to_radians().cos() * 2.0, 30f32.to_radians().sin() * 2.0);
        let src = [[0.0, 0.0], [10.0, 0.0], [5.0, 7.0], [1.0, 12.0], [9.0, 12.0]];
        let mut dst = [[0f32; 2]; 5];
        for (d, p) in dst.iter_mut().zip(&src) {
            *d = [c * p[0] - s * p[1] + 5.0, s * p[0] + c * p[1] - 3.0];
        }
        let (a, b, tx, ty) = similarity(&src, &dst);
        assert!((a - c).abs() < 1e-4 && (b - s).abs() < 1e-4 && (tx - 5.0).abs() < 1e-3 && (ty + 3.0).abs() < 1e-3);
    }

    #[test]
    fn what_is_outlined_decides_what_is_found() {
        let face = Face { x: 100.0, y: 100.0, w: 40.0, h: 50.0, score: 0.9, kps: [[0.0; 2]; 5], who: 0 };
        let other = Face { x: 300.0, y: 110.0, w: 36.0, h: 45.0, score: 0.9, kps: [[0.0; 2]; 5], who: 0 };
        let around = |x: f32, y: f32, w: f32, h: f32| Face { x, y, w, h, score: 0.0, kps: [[0.0; 2]; 5], who: 0 };
        let faces = [face, other];
        let kind = |o: Face| outline_kind(&faces_in_outline(&faces, &o), &o);
        assert_eq!(kind(around(92.0, 92.0, 56.0, 66.0)), "face");
        assert_eq!(kind(around(60.0, 90.0, 120.0, 400.0)), "person");
        assert_eq!(kind(around(95.0, 95.0, 250.0, 55.0)), "faces");
        assert_eq!(kind(around(60.0, 80.0, 320.0, 500.0)), "people");
        assert_eq!(kind(around(600.0, 600.0, 80.0, 80.0)), "thing");
        // Only the edge of a face inside: that's not the face being outlined.
        assert_eq!(kind(around(130.0, 140.0, 60.0, 60.0)), "thing");
    }

    #[test]
    fn a_whole_person_outline_lands_on_them_at_their_size_elsewhere() {
        let face = Face { x: 100.0, y: 100.0, w: 40.0, h: 50.0, score: 0.9, kps: [[0.0; 2]; 5], who: 0 };
        // Head to toe: 3 face-widths wide, 8 face-heights tall, the face near the top.
        let outline = Face { x: 60.0, y: 90.0, w: 120.0, h: 400.0, score: 0.0, kps: [[0.0; 2]; 5], who: 0 };
        let reach = reach_of(&face, &outline);
        assert!(reach.is_some());
        // The same person, half the size, elsewhere.
        let small = Face { x: 500.0, y: 50.0, w: 20.0, h: 25.0, score: 0.9, kps: [[0.0; 2]; 5], who: 0 };
        let (cx, cy, bw, bh) = covered_box(&small, reach, 2000, 2000);
        // Face centre (510, 62.5), 25 tall: the outline's centre 3.3 face-heights below it, 2.4 x 8 of them.
        assert!((bw - 60.0).abs() < 0.01 && (bh - 200.0).abs() < 0.01);
        assert!((cx - 510.0).abs() < 0.01 && (cy - 145.0).abs() < 0.01);
        // An outline about the face's size covers the face itself.
        assert!(reach_of(&face, &Face { x: 95.0, y: 95.0, w: 50.0, h: 60.0, score: 0.0, kps: [[0.0; 2]; 5], who: 0 }).is_none());
    }

    #[test]
    fn a_group_outline_gives_each_person_their_own_column() {
        let a = Face { x: 100.0, y: 100.0, w: 40.0, h: 50.0, score: 0.9, kps: [[0.0; 2]; 5], who: 0 };
        let b = Face { x: 300.0, y: 110.0, w: 40.0, h: 50.0, score: 0.9, kps: [[0.0; 2]; 5], who: 0 };
        let outline = Face { x: 60.0, y: 80.0, w: 320.0, h: 500.0, score: 0.0, kps: [[0.0; 2]; 5], who: 0 };
        let r = reaches_of(&[a, b], &outline);
        // Split halfway between the faces' centres (120 and 320): 60..220 and 220..380.
        let (_, _, wa, _) = covered_box(&a, r[0], 2000, 2000);
        let (cxb, _, wb, _) = covered_box(&b, r[1], 2000, 2000);
        assert!((wa - 160.0).abs() < 0.01 && (wb - 160.0).abs() < 0.01 && (cxb - 300.0).abs() < 0.01);
    }

    fn face_at(x: f32) -> Face {
        Face { x, y: 100.0, w: 40.0, h: 50.0, score: 0.9, kps: [[0.0; 2]; 5], who: 0 }
    }

    #[test]
    fn a_track_follows_the_face_through_a_moment_it_isnt_recognised() {
        let (mut tracks, mut done) = (Vec::new(), Vec::new());
        link(&mut tracks, &mut done, 0.0, vec![(face_at(100.0), 0.8)], 0.33);
        // Turned away: a weak match, but right where the face was.
        link(&mut tracks, &mut done, 0.17, vec![(face_at(110.0), 0.2)], 0.33);
        // Someone else across the frame never joins it.
        link(&mut tracks, &mut done, 0.33, vec![(face_at(120.0), 0.7), (face_at(600.0), 0.05)], 0.33);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].samples.len(), 3);
    }

    #[test]
    fn a_track_ends_once_the_face_has_been_gone_a_while() {
        let (mut tracks, mut done) = (Vec::new(), Vec::new());
        link(&mut tracks, &mut done, 0.0, vec![(face_at(100.0), 0.8)], 0.33);
        for k in 1..=TRACK_GAP + 1 {
            link(&mut tracks, &mut done, k as f64 / SAMPLE_FPS, vec![], 0.33);
        }
        assert!(tracks.is_empty());
        assert_eq!(done.len(), 1);
    }
}
