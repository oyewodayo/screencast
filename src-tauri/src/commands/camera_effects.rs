// Live camera background - blur, a colour or a picture behind you, while you record.
//
// One camera feed for the whole app: it opens the camera itself (its own small ffmpeg, cropped to
// the bubble's shape at bubble resolution), cuts the person out of each frame with the same matting
// model background removal uses (Robust Video Matting, background_removal.rs), puts the chosen
// background behind them, and keeps the newest finished frame. Two things read it:
//
//   - the recording settings' preview (camera_effect_preview), so the effect is seen live before
//     recording - which also means the model is loaded and warm by the time Record is pressed;
//   - the recording itself: the screen recording's ffmpeg reads this feed over a local socket in
//     place of opening the camera (win.rs add_overlay_args), always at a steady 30 fps - the newest
//     finished frame is repeated when the model is between frames, so a slow machine costs smoothness
//     of the bubble, never the recording.
//
// It runs the model on whichever of the GPU (DirectML) and the CPU is faster on this machine, timed
// on its first frames. Off unless the user picks a background (FormData.camera_effect).
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::commands::background_removal::{engine_dir, engine_ready, model_path, ort_environment};
use crate::services::utility::get_ffmpeg_path;

// What goes behind the person: "blur" (their own background, blurred by `amount` 0..1), "color"
// ("#rrggbb") or "image" (a picture file, cover-fitted).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraEffectSpec {
    pub kind: String,
    #[serde(default)]
    pub amount: f64,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub image_path: Option<String>,
}

enum Backdrop {
    Blur(usize),
    Color([u8; 3]),
    Image(Vec<u8>),
}

const FEED_FPS: f64 = 30.0;

// The feed's picture: the bubble's shape (square for circle/rounded, 4:3 otherwise) at a resolution
// that keeps the model real-time - bigger bubbles get more pixels.
pub(crate) fn feed_size(shape: &str, size: &str) -> (u32, u32) {
    let side: u32 = match size {
        "xs" | "small" => 320,
        "medium" => 384,
        _ => 480,
    };
    if shape == "circle" || shape == "rounded" { (side, side) } else { (side, side * 3 / 4) }
}

fn backdrop_for(spec: &CameraEffectSpec, w: u32, h: u32) -> Backdrop {
    match spec.kind.as_str() {
        "color" => {
            let hex = spec.color.as_deref().map(|c| c.trim().trim_start_matches('#')).and_then(|c| u32::from_str_radix(c, 16).ok()).unwrap_or(0x0f172a);
            Backdrop::Color([(hex >> 16) as u8, (hex >> 8) as u8, hex as u8])
        }
        "image" => match spec.image_path.as_deref().and_then(|p| image::open(p).ok()) {
            Some(img) => {
                // Cover fit: scale to fill, crop the middle.
                let (iw, ih) = (img.width().max(1) as f64, img.height().max(1) as f64);
                let scale = (w as f64 / iw).max(h as f64 / ih);
                let (sw, sh) = ((iw * scale).ceil() as u32, (ih * scale).ceil() as u32);
                let scaled = image::imageops::resize(&img.to_rgb8(), sw.max(w), sh.max(h), image::imageops::FilterType::Triangle);
                let (x0, y0) = ((scaled.width() - w) / 2, (scaled.height() - h) / 2);
                Backdrop::Image(image::imageops::crop_imm(&scaled, x0, y0, w, h).to_image().into_raw())
            }
            None => Backdrop::Color([15, 23, 42]),
        },
        _ => {
            // Three box passes of radius r have sigma sqrt(r(r+1)); amount 1 = a sigma of 5% of the side.
            let sigma = spec.amount.clamp(0.0, 1.0) * 0.05 * h as f64;
            Backdrop::Blur((((4.0 * sigma * sigma + 1.0).sqrt() - 1.0) / 2.0).round().max(1.0) as usize)
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedStatus {
    // "starting", "gpu", "cpu", or "error: ..." when the model couldn't run (the camera then shows
    // without the effect).
    pub engine: String,
    // Frames the model finishes a second.
    pub fps: f64,
    pub width: u32,
    pub height: u32,
}

struct Shared {
    stop: AtomicBool,
    // Newest camera frame (packed RGB) and its number.
    latest: Mutex<Option<(u64, Arc<Vec<u8>>)>>,
    // Newest matte (0..1 a pixel) the model finished - every camera frame is composited with it,
    // so the picture moves at the camera's rate even when the model runs slower.
    alpha: Mutex<Option<Arc<Vec<f32>>>>,
    // Newest finished frame - the person over the background.
    composed: Mutex<Option<Arc<Vec<u8>>>>,
    preview_jpeg: Mutex<Option<Vec<u8>>>,
    backdrop: Mutex<Backdrop>,
    status: Mutex<FeedStatus>,
}

struct Feed {
    device: String,
    size: (u32, u32),
    port: u16,
    shared: Arc<Shared>,
    // The camera's ffmpeg of the moment (the supervisor reopens it after a failure).
    capture: Arc<Mutex<Option<Child>>>,
    threads: Vec<JoinHandle<()>>,
    // The recording reads it - the settings window closing mustn't stop it.
    recording: bool,
}

impl Feed {
    fn shut_down(mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(mut c) = self.capture.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

static FEED: Mutex<Option<Feed>> = Mutex::new(None);

// Starts the feed for `device` (or retunes the running one), returning its socket port and size.
pub(crate) fn ensure_feed(app_handle: &AppHandle, device: &str, shape: &str, size: &str, spec: &CameraEffectSpec, for_recording: bool) -> Result<(u16, u32, u32), String> {
    let (w, h) = feed_size(shape, size);
    // Wanted again: any pending stop is off.
    STOP_GENERATION.fetch_add(1, Ordering::SeqCst);
    let mut slot = FEED.lock().unwrap();
    if let Some(feed) = slot.as_mut() {
        if feed.device == device && feed.size == (w, h) && !feed.shared.stop.load(Ordering::SeqCst) {
            *feed.shared.backdrop.lock().unwrap() = backdrop_for(spec, w, h);
            feed.recording |= for_recording;
            return Ok((feed.port, w, h));
        }
    }
    if let Some(old) = slot.take() {
        old.shut_down();
    }
    let feed = start_feed(app_handle, device, size, (w, h), spec, for_recording)?;
    let port = feed.port;
    *slot = Some(feed);
    Ok((port, w, h))
}

fn start_feed(app_handle: &AppHandle, device: &str, size: &str, (w, h): (u32, u32), spec: &CameraEffectSpec, recording: bool) -> Result<Feed, String> {
    let dir = engine_dir(app_handle)?;
    if !engine_ready(&dir) {
        return Err("ENGINE_MISSING".into());
    }
    let ffmpeg = get_ffmpeg_path(app_handle)?;
    let crop = if w == h { "crop='min(iw,ih)':'min(iw,ih)'" } else { "crop='min(iw,ih*4/3)':'min(ih,iw*3/4)'" };
    let capture_args: Vec<String> = [
        "-v".to_string(),
        "error".into(),
        "-f".into(),
        "dshow".into(),
        "-video_size".into(),
        crate::commands::recording::map_overlay_size(size),
        "-i".into(),
        format!("video={device}"),
        "-an".into(),
        "-vf".into(),
        format!("{crop},scale={w}:{h},format=rgb24"),
        "-f".into(),
        "rawvideo".into(),
        "pipe:1".into(),
    ]
    .to_vec();
    let capture: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let shared = Arc::new(Shared {
        stop: AtomicBool::new(false),
        latest: Mutex::new(None),
        alpha: Mutex::new(None),
        composed: Mutex::new(None),
        preview_jpeg: Mutex::new(None),
        backdrop: Mutex::new(backdrop_for(spec, w, h)),
        status: Mutex::new(FeedStatus { engine: "starting".into(), fps: 0.0, width: w, height: h }),
    });
    let frame_bytes = (w * h * 3) as usize;

    // Camera -> newest frame. The camera is (re)opened here: right after the settings preview hands
    // it over the browser may still hold it for a moment, and a camera can drop out - either way it's
    // tried again every half second until the feed stops.
    let s = shared.clone();
    let slot = capture.clone();
    let reader = std::thread::spawn(move || {
        let mut seq = 0u64;
        while !s.stop.load(Ordering::SeqCst) {
            let mut cmd = std::process::Command::new(&ffmpeg);
            #[cfg(windows)]
            crate::commands::recording::hide_console_window(&mut cmd);
            cmd.args(&capture_args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
            crate::services::orphan_guard::before_spawn(&mut cmd);
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("Live camera background couldn't start ffmpeg: {}", e);
                    break;
                }
            };
            crate::services::orphan_guard::after_spawn(&child);
            let Some(mut camera) = child.stdout.take() else { break };
            *slot.lock().unwrap() = Some(child);
            loop {
                let mut buf = vec![0u8; frame_bytes];
                if camera.read_exact(&mut buf).is_err() || s.stop.load(Ordering::SeqCst) {
                    break;
                }
                seq += 1;
                *s.latest.lock().unwrap() = Some((seq, Arc::new(buf)));
            }
            if let Some(mut c) = slot.lock().unwrap().take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            if !s.stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    });

    // Newest frame -> person over the background.
    let s = shared.clone();
    let model = model_path(&dir);
    let infer = std::thread::spawn(move || {
        if let Err(e) = run_matting(&s, &dir, &model, w as usize, h as usize) {
            log::warn!("Live camera background stopped: {}", e);
            s.status.lock().unwrap().engine = format!("error: {e}");
            // The plain camera from here on, rather than a frozen matte.
            *s.alpha.lock().unwrap() = None;
            *s.composed.lock().unwrap() = None;
        }
    });

    // Each camera frame + newest matte -> the person over the background.
    let s = shared.clone();
    let compositor = std::thread::spawn(move || composite_frames(&s, w as usize, h as usize));

    // Finished frames -> the recording, at a steady rate.
    let s = shared.clone();
    let writer = std::thread::spawn(move || serve_frames(&s, listener, frame_bytes));

    Ok(Feed { device: device.to_string(), size: (w, h), port, shared, capture, threads: vec![reader, infer, compositor, writer], recording })
}

// The model loop: takes each new camera frame, mattes it, composites it, publishes it. Until the
// model is ready - or if it can't run - frames go out with the background alone filled in where
// the person would be unknown: blur/colour/picture over the whole frame would hide the person, so
// the raw frame is passed through instead.
fn run_matting(s: &Shared, dir: &std::path::Path, model: &std::path::Path, w: usize, h: usize) -> Result<(), String> {
    use ort::session::Session;
    use ort::value::Tensor;
    let env = ort_environment(dir)?;
    let threads = (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) / 2).clamp(1, 4);
    let cpu = Session::builder(env).and_then(|b| b.with_intra_threads(threads).map_err(|e| e.into())).and_then(|mut b| b.commit_from_file(model)).map_err(|e| e.to_string())?;
    let gpu = Session::builder(env)
        .and_then(|b| b.with_execution_providers([ort::ep::DirectML::default().build()]).map_err(|e| e.into()))
        .and_then(|mut b| b.commit_from_file(model))
        .ok();
    let mut sessions: Vec<(&str, Session)> = vec![("cpu", cpu)];
    if let Some(g) = gpu {
        sessions.push(("gpu", g));
    }
    let plane = w * h;
    let ratio = (224.0 / w.max(h) as f32).min(1.0);
    let ratio_tensor = Tensor::from_array(([1usize], vec![ratio])).map_err(|e| e.to_string())?;
    let zero = || Tensor::from_array(([1usize, 1, 1, 1], vec![0f32])).map(|t| t.into_dyn());
    let mut recs: Vec<Vec<ort::value::DynValue>> = sessions.iter().map(|_| (0..4).map(|_| zero()).collect::<Result<Vec<_>, _>>()).collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    // Engine trial: each engine gets frames 2..10 of its turn timed; then the faster one stays.
    const TRIAL: usize = 10;
    let mut timings: Vec<Vec<f64>> = vec![Vec::new(); sessions.len()];
    let mut chosen: Option<usize> = if sessions.len() == 1 { Some(0) } else { None };
    let mut frame_count = 0usize;
    let mut last_seq = 0u64;
    let mut chw = vec![0f32; plane * 3];
    let (mut fps_frames, mut fps_since) = (0u32, Instant::now());
    while !s.stop.load(Ordering::SeqCst) {
        let next = s.latest.lock().unwrap().as_ref().filter(|(seq, _)| *seq != last_seq).cloned();
        let Some((seq, frame)) = next else {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        };
        last_seq = seq;
        let which = chosen.unwrap_or((frame_count / TRIAL).min(sessions.len() - 1));
        let started = Instant::now();
        pixel_convert::rgb_to_planar(&frame, &mut chw);
        let src = Tensor::from_array(([1usize, 3, h, w], chw.clone())).map_err(|e| e.to_string())?;
        let [r1, r2, r3, r4]: [ort::value::DynValue; 4] = std::mem::take(&mut recs[which]).try_into().map_err(|_| "recurrent state".to_string())?;
        let (_, session) = &mut sessions[which];
        let mut outputs = session
            .run(ort::inputs!["src" => src, "r1i" => r1, "r2i" => r2, "r3i" => r3, "r4i" => r4, "downsample_ratio" => ratio_tensor.view()])
            .map_err(|e| e.to_string())?;
        {
            let (_, pha) = outputs["pha"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            *s.alpha.lock().unwrap() = Some(Arc::new(pha[..plane].to_vec()));
        }
        for name in ["r1o", "r2o", "r3o", "r4o"] {
            recs[which].push(outputs.remove(name).ok_or("recurrent state missing")?);
        }
        drop(outputs);

        // Engine trial bookkeeping.
        if chosen.is_none() {
            let in_turn = frame_count % TRIAL;
            if in_turn >= 2 {
                timings[which].push(started.elapsed().as_secs_f64());
            }
            frame_count += 1;
            if frame_count >= TRIAL * sessions.len() {
                let median = |t: &Vec<f64>| {
                    let mut t = t.clone();
                    t.sort_by(|a, b| a.total_cmp(b));
                    t.get(t.len() / 2).copied().unwrap_or(f64::MAX)
                };
                chosen = (0..sessions.len()).min_by(|a, b| median(&timings[*a]).total_cmp(&median(&timings[*b])));
                log::info!("Live camera background: {} ({:?} s/frame by engine)", sessions[chosen.unwrap_or(0)].0, timings.iter().map(median).collect::<Vec<_>>());
            }
        }
        fps_frames += 1;
        if fps_since.elapsed() >= Duration::from_secs(1) {
            let mut st = s.status.lock().unwrap();
            st.fps = fps_frames as f64 / fps_since.elapsed().as_secs_f64();
            st.engine = sessions[chosen.unwrap_or(which)].0.to_string();
            fps_frames = 0;
            fps_since = Instant::now();
        }
    }
    Ok(())
}

// Composites every camera frame with the newest matte and the chosen background, and keeps a small
// JPEG of it for the settings preview (~15 a second). Before the first matte there's nothing to cut
// with, so nothing is published and the raw camera shows.
fn composite_frames(s: &Shared, w: usize, h: usize) {
    let plane = w * h;
    let (mut bg, mut tmp, mut out) = (vec![0u8; plane * 3], vec![0u8; plane * 3], vec![0u8; plane * 3]);
    let mut last_seq = 0u64;
    let mut last_preview = Instant::now() - Duration::from_secs(1);
    while !s.stop.load(Ordering::SeqCst) {
        let next = s.latest.lock().unwrap().as_ref().filter(|(seq, _)| *seq != last_seq).cloned();
        let (Some((seq, frame)), Some(alpha)) = (next, s.alpha.lock().unwrap().clone()) else {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        };
        last_seq = seq;
        match &*s.backdrop.lock().unwrap() {
            Backdrop::Blur(r) => pixel_convert::blur_rgb(&frame, w, h, *r, &mut tmp, &mut bg),
            Backdrop::Color(c) => bg.chunks_exact_mut(3).for_each(|p| p.copy_from_slice(c)),
            Backdrop::Image(img) => bg.copy_from_slice(&img[..plane * 3]),
        }
        pixel_convert::composite_over(&frame, &alpha, &bg, &mut out);
        let composed = Arc::new(out.clone());
        *s.composed.lock().unwrap() = Some(composed.clone());
        if last_preview.elapsed() >= Duration::from_millis(66) {
            last_preview = Instant::now();
            let mut jpeg = Vec::new();
            if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 82).encode(&composed, w as u32, h as u32, image::ExtendedColorType::Rgb8).is_ok() {
                *s.preview_jpeg.lock().unwrap() = Some(jpeg);
            }
        }
    }
}

// Serves the recording: whenever its ffmpeg connects, writes the newest finished frame (or, before
// the first one, the raw camera frame) 30 times a second until it disconnects.
fn serve_frames(s: &Shared, listener: TcpListener, frame_bytes: usize) {
    let interval = Duration::from_secs_f64(1.0 / FEED_FPS);
    while !s.stop.load(Ordering::SeqCst) {
        let Ok((mut stream, _)) = listener.accept() else {
            std::thread::sleep(Duration::from_millis(20));
            continue;
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_nodelay(true);
        let mut next = Instant::now();
        let black = vec![0u8; frame_bytes];
        while !s.stop.load(Ordering::SeqCst) {
            let frame = s.composed.lock().unwrap().clone().or_else(|| s.latest.lock().unwrap().as_ref().map(|(_, f)| f.clone()));
            let bytes: &[u8] = frame.as_deref().map(|f| f.as_slice()).unwrap_or(&black);
            if stream.write_all(bytes).is_err() {
                break;
            }
            next += interval;
            let now = Instant::now();
            if next > now {
                std::thread::sleep(next - now);
            } else {
                next = now;
            }
        }
    }
}

// ffmpeg input arguments reading the feed - in place of the camera's own dshow input. Its frames
// are stamped as they arrive, so the bubble stays in step with the screen and the mic.
pub(crate) fn feed_input_args(port: u16, w: u32, h: u32) -> Vec<String> {
    [
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-video_size", &format!("{w}x{h}"), "-framerate", &format!("{FEED_FPS}"),
        "-use_wallclock_as_timestamps", "1", "-thread_queue_size", "64", "-i", &format!("tcp://127.0.0.1:{port}"),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

// The recording is over: the feed stops unless the settings preview reopened it since.
pub(crate) fn release_after_recording() {
    let mut slot = FEED.lock().unwrap();
    if slot.as_ref().is_some_and(|f| f.recording) {
        if let Some(feed) = slot.take() {
            feed.shut_down();
        }
    }
}

// ---- Commands for the recording settings' live preview ------------------------------------------

#[tauri::command]
pub async fn camera_effect_start(app_handle: AppHandle, device: String, shape: String, size: String, effect: CameraEffectSpec) -> Result<FeedStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_feed(&app_handle, &device, &shape, &size, &effect, false)?;
        Ok(FEED.lock().unwrap().as_ref().map(|f| f.shared.status.lock().unwrap().clone()).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub fn camera_effect_status() -> Option<FeedStatus> {
    FEED.lock().unwrap().as_ref().map(|f| f.shared.status.lock().unwrap().clone())
}

// The newest previewed frame as JPEG bytes (empty before the first one).
#[tauri::command(async)]
pub fn camera_effect_preview() -> tauri::ipc::Response {
    let jpeg = FEED.lock().unwrap().as_ref().and_then(|f| f.shared.preview_jpeg.lock().unwrap().clone()).unwrap_or_default();
    tauri::ipc::Response::new(jpeg)
}

// The settings closed: stops the feed - after a grace period, so the recording that Start launches
// (countdown included) picks up the warm feed instead of loading the model again. A recording
// claiming it, or the preview starting it again, cancels the stop.
//
// `immediate`: the effect was switched off while the preview stays open - the plain camera preview
// wants the camera back now. Waiting out the grace there left the preview on "In use elsewhere".
const STOP_GRACE: Duration = Duration::from_secs(10);
static STOP_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command(async)]
pub fn camera_effect_stop(immediate: Option<bool>) {
    let generation = STOP_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let grace = if immediate.unwrap_or(false) { Duration::ZERO } else { STOP_GRACE };
    std::thread::spawn(move || {
        std::thread::sleep(grace);
        if STOP_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let mut slot = FEED.lock().unwrap();
        if slot.as_ref().is_some_and(|f| !f.recording) {
            if let Some(feed) = slot.take() {
                feed.shut_down();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feeds_the_bubble_shape_at_a_real_time_size() {
        assert_eq!(feed_size("circle", "medium"), (384, 384));
        assert_eq!(feed_size("rectangle", "small"), (320, 240));
        assert_eq!(feed_size("rounded", "xl"), (480, 480));
        let args = feed_input_args(5000, 384, 384);
        assert!(args.windows(2).any(|p| p[0] == "-i" && p[1] == "tcp://127.0.0.1:5000"));
    }

    // Not a unit test: the feed's model loop and socket with the real engine ($BGR_ENGINE_DIR) and a
    // real ffmpeg ($FFMPEG_DIR) reading it exactly as a recording does - synthetic camera frames in,
    // 3 s of steady 30 fps out, composited (the blue backdrop shows where the frame was blank).
    #[test]
    #[ignore]
    fn feeds_a_recording_steadily() {
        let (Ok(engine), Ok(ff)) = (std::env::var("BGR_ENGINE_DIR"), std::env::var("FFMPEG_DIR")) else { return };
        let dir = std::path::PathBuf::from(engine);
        let (w, h) = (384u32, 384u32);
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            latest: Mutex::new(None),
            alpha: Mutex::new(None),
            composed: Mutex::new(None),
            preview_jpeg: Mutex::new(None),
            backdrop: Mutex::new(backdrop_for(&CameraEffectSpec { kind: "color".into(), amount: 0.0, color: Some("#0000ff".into()), image_path: None }, w, h)),
            status: Mutex::new(FeedStatus::default()),
        });
        // A fake camera: mid-grey frames at 30 fps.
        let s = shared.clone();
        let camera = std::thread::spawn(move || {
            let mut seq = 0;
            while !s.stop.load(Ordering::SeqCst) {
                seq += 1;
                *s.latest.lock().unwrap() = Some((seq, Arc::new(vec![128u8; (w * h * 3) as usize])));
                std::thread::sleep(Duration::from_millis(33));
            }
        });
        let s = shared.clone();
        let model = model_path(&dir);
        let d2 = dir.clone();
        let infer = std::thread::spawn(move || run_matting(&s, &d2, &model, w as usize, h as usize).unwrap());
        let s = shared.clone();
        let compositor = std::thread::spawn(move || composite_frames(&s, w as usize, h as usize));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let s = shared.clone();
        let writer = std::thread::spawn(move || serve_frames(&s, listener, (w * h * 3) as usize));
        // Let the engine trial finish, as the settings preview would have.
        std::thread::sleep(Duration::from_secs(6));
        let out = std::process::Command::new(std::path::PathBuf::from(&ff).join("ffmpeg.exe"))
            .args(["-v", "error"])
            .args(feed_input_args(port, w, h))
            .args(["-t", "3", "-f", "framemd5", "-"])
            .output()
            .unwrap();
        let frames = String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.starts_with('#')).count();
        let status = shared.status.lock().unwrap().clone();
        let composed = shared.composed.lock().unwrap().clone();
        shared.stop.store(true, Ordering::SeqCst);
        for t in [camera, infer, compositor, writer] {
            t.join().unwrap();
        }
        let preview = shared.preview_jpeg.lock().unwrap().clone();
        eprintln!("engine {} at {:.1} fps; {frames} frames in 3 s", status.engine, status.fps);
        assert!(preview.is_some_and(|j| j.starts_with(&[0xFF, 0xD8])), "a JPEG preview");
        assert!((80..=100).contains(&frames), "{frames} frames");
        assert!(status.engine == "cpu" || status.engine == "gpu", "{}", status.engine);
        // A blank grey frame has no person: the backdrop fills it (blue).
        let c = composed.expect("composited frames");
        assert!(c[2] > 200 && c[0] < 60, "{:?}", &c[..3]);
    }

    #[test]
    fn blur_reaches_further_with_more_amount() {
        let r = |a: f64| match backdrop_for(&CameraEffectSpec { kind: "blur".into(), amount: a, color: None, image_path: None }, 384, 384) {
            Backdrop::Blur(r) => r,
            _ => 0,
        };
        assert!(r(1.0) > r(0.3) && r(0.3) >= 1);
        assert!(matches!(backdrop_for(&CameraEffectSpec { kind: "color".into(), amount: 0.0, color: Some("#102030".into()), image_path: None }, 4, 4), Backdrop::Color([16, 32, 48])));
    }
}
