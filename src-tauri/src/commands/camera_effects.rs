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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::commands::background_removal::{engine_dir, engine_present, model_path, ort_environment, with_gpu};
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

// Session-cached winner of the GPU (DirectML) vs CPU matting trial ("gpu" or "cpu"). Cached so
// subsequent modal opens or bubble resizes load only the winning execution provider immediately
// without re-running a dual-session trial.
static PREFERRED_ENGINE: OnceLock<&'static str> = OnceLock::new();

// Fast real-time matting resolution (<= 256px max side, 16-px aligned for DirectML/SIMD). The
// smooth alpha matte is bilinearly upscaled back to full bubble resolution `(w, h)` so the person
// stays crisp while matting runs 2x-3.5x faster.
fn matting_size(w: usize, h: usize) -> (usize, usize) {
    const MAX_SIDE: usize = 256;
    if w <= MAX_SIDE && h <= MAX_SIDE {
        return (w, h);
    }
    let scale = MAX_SIDE as f64 / w.max(h) as f64;
    let align16 = |v: f64| (((v / 16.0).round() as usize).max(1)) * 16;
    (align16(w as f64 * scale).min(w), align16(h as f64 * scale).min(h))
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedStatus {
    // "starting", "gpu", "cpu", or "error: ..." when the model couldn't run (the camera then shows
    // without the effect).
    pub engine: String,
    // Frames composited a second.
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    // Direct localhost HTTP MJPEG push URL (`http://127.0.0.1:<port>/stream`) for zero-IPC,
    // zero-Blob-GC preview rendering directly in `<img src=...>`.
    pub preview_url: Option<String>,
}

fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Shared {
    stop: AtomicBool,
    // Set while the recording is paused so matting, compositing, and TCP serving idle at 0% CPU.
    paused: AtomicBool,
    // Number of live HTTP MJPEG preview clients connected right now.
    preview_clients: AtomicUsize,
    // Epoch ms of the last camera_effect_preview poll (fallback path) - preview JPEG encoding runs
    // ONLY while a live MJPEG client is connected or a poll arrived recently (0% cost during recording).
    last_preview_poll_ms: AtomicU64,
    // Newest camera frame (packed RGB) and its number.
    latest: Mutex<Option<(u64, Arc<Vec<u8>>)>>,
    // Wakes run_matting / composite_frames immediately when a new camera frame or stop arrives.
    latest_ready: Condvar,
    // Newest matte (0..1 a pixel) the model finished - every camera frame is composited with it,
    // so the picture moves at the camera's rate even when the model runs slower.
    alpha: Mutex<Option<Arc<Vec<f32>>>>,
    // Newest finished frame - the person over the background.
    composed: Mutex<Option<Arc<Vec<u8>>>>,
    // (sequence number, JPEG bytes) for zero-copy MJPEG push and deduplicated preview polling.
    preview_jpeg: Mutex<Option<(u32, Arc<Vec<u8>>)>>,
    // Wakes connected HTTP MJPEG clients immediately when a new JPEG frame is ready.
    preview_ready: Condvar,
    backdrop: Mutex<Arc<Backdrop>>,
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
        self.shared.paused.store(false, Ordering::SeqCst);
        self.shared.latest_ready.notify_all();
        self.shared.preview_ready.notify_all();
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

/// Pauses or resumes the active live-camera-background feed along with the recording.
pub(crate) fn set_paused(paused: bool) {
    let slot = FEED.lock().unwrap();
    if let Some(feed) = slot.as_ref() {
        feed.shared.paused.store(paused, Ordering::SeqCst);
        if !paused {
            feed.shared.latest_ready.notify_all();
        }
    }
}

// Starts the feed for `device` (or retunes the running one), returning its socket port and size.
pub(crate) fn ensure_feed(app_handle: &AppHandle, device: &str, shape: &str, size: &str, spec: &CameraEffectSpec, for_recording: bool) -> Result<(u16, u32, u32), String> {
    let (w, h) = feed_size(shape, size);
    // Wanted again: any pending stop is off.
    STOP_GENERATION.fetch_add(1, Ordering::SeqCst);
    let mut slot = FEED.lock().unwrap();
    if let Some(feed) = slot.as_mut() {
        if feed.device == device && feed.size == (w, h) && !feed.shared.stop.load(Ordering::SeqCst) {
            *feed.shared.backdrop.lock().unwrap() = Arc::new(backdrop_for(spec, w, h));
            feed.recording |= for_recording;
            feed.shared.paused.store(false, Ordering::SeqCst);
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
    // Fast size check (0.1 ms) instead of SHA-256 hashing 55 MB on every modal open / resize.
    if !engine_present(&dir) {
        return Err("ENGINE_MISSING".into());
    }
    let ffmpeg = get_ffmpeg_path(app_handle)?;
    let crop = if w == h { "crop='min(iw,ih)':'min(iw,ih)'" } else { "crop='min(iw,ih*4/3)':'min(ih,iw*3/4)'" };
    // The camera by its name, however this system opens one (dshow, v4l2, avfoundation).
    let base_input = crate::commands::recording::camera_input_args(app_handle, device, size)?;
    let tail_args: Vec<String> = [
        "-an",
        "-sws_flags",
        "fast_bilinear",
        "-vf",
        &format!("{crop},scale={w}:{h},format=rgb24"),
        "-f",
        "rawvideo",
        "pipe:1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    // Low-latency live camera input: keep DirectShow's ring buffer tiny (3 MB = ~3-4 frames max,
    // NEVER 100 MB which queues up to 50 seconds of stale video!) and disable probe/demuxer
    // buffering (`-fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0`) so movement
    // stays in tight real-time lip-sync with zero queue drift.
    let build_capture_args = |with_framerate: bool| -> Vec<String> {
        let mut args = vec![
            "-v".to_string(),
            "error".into(),
            "-fflags".into(),
            "nobuffer".into(),
            "-flags".into(),
            "low_delay".into(),
            "-probesize".into(),
            "32".into(),
            "-analyzeduration".into(),
            "0".into(),
        ];
        #[cfg(target_os = "windows")]
        if base_input.len() >= 2 && base_input[0] == "-f" && base_input[1] == "dshow" {
            args.extend(["-f".to_string(), "dshow".into(), "-rtbufsize".into(), "3M".into()]);
            if with_framerate {
                args.extend(["-framerate".into(), "30".into()]);
            }
            args.extend(base_input[2..].iter().cloned());
            args.extend(tail_args.iter().cloned());
            return args;
        }
        let _ = with_framerate;
        args.extend(base_input.iter().cloned());
        args.extend(tail_args.iter().cloned());
        args
    };
    let fast_capture_args = build_capture_args(true);
    let fallback_capture_args = build_capture_args(false);
    let capture: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let preview_listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    preview_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let preview_port = preview_listener.local_addr().map_err(|e| e.to_string())?.port();
    let preview_url = format!("http://127.0.0.1:{preview_port}/stream");

    let initial_engine = PREFERRED_ENGINE.get().copied().unwrap_or("starting").to_string();
    let shared = Arc::new(Shared {
        stop: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        preview_clients: AtomicUsize::new(0),
        last_preview_poll_ms: AtomicU64::new(if recording { 0 } else { epoch_ms() }),
        latest: Mutex::new(None),
        latest_ready: Condvar::new(),
        alpha: Mutex::new(None),
        composed: Mutex::new(None),
        preview_jpeg: Mutex::new(None),
        preview_ready: Condvar::new(),
        backdrop: Mutex::new(Arc::new(backdrop_for(spec, w, h))),
        status: Mutex::new(FeedStatus {
            engine: initial_engine,
            fps: 0.0,
            width: w,
            height: h,
            preview_url: Some(preview_url),
        }),
    });
    let frame_bytes = (w * h * 3) as usize;

    // Camera -> newest frame. The camera is (re)opened here: right after the settings preview hands
    // it over the browser may still hold it for a moment, and a camera can drop out - either way it's
    // tried again briefly until the feed stops.
    let s = shared.clone();
    let slot = capture.clone();
    let reader = std::thread::spawn(move || {
        let mut seq = 0u64;
        let mut use_fast = true;
        while !s.stop.load(Ordering::SeqCst) {
            let args = if use_fast { &fast_capture_args } else { &fallback_capture_args };
            let mut cmd = std::process::Command::new(&ffmpeg);
            #[cfg(windows)]
            crate::commands::recording::hide_console_window(&mut cmd);
            cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
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
            let start_seq = seq;
            loop {
                let mut buf = vec![0u8; frame_bytes];
                if camera.read_exact(&mut buf).is_err() || s.stop.load(Ordering::SeqCst) {
                    break;
                }
                seq += 1;
                {
                    let mut guard = s.latest.lock().unwrap();
                    *guard = Some((seq, Arc::new(buf)));
                }
                s.latest_ready.notify_all();
            }
            if let Some(mut c) = slot.lock().unwrap().take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            // If explicit `-framerate 30` exited immediately with zero frames (e.g. a virtual camera
            // with a fixed non-30 fps mode), fall back to driver-default framerate immediately.
            if use_fast && seq == start_seq {
                use_fast = false;
                continue;
            }
            if !s.stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    });

    // Newest frame -> person matte (alpha).
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

    // Finished frames -> zero-IPC localhost HTTP MJPEG stream for `<img src=...>`.
    let s = shared.clone();
    let preview_server = std::thread::spawn(move || serve_mjpeg_preview(s, preview_listener));

    Ok(Feed {
        device: device.to_string(),
        size: (w, h),
        port,
        shared,
        capture,
        threads: vec![reader, infer, compositor, writer, preview_server],
        recording,
    })
}

// Waits until `s.latest` holds a frame newer than `last_seq`, or returns None when `s.stop` is set.
fn wait_for_next_frame(s: &Shared, last_seq: u64) -> Option<(u64, Arc<Vec<u8>>)> {
    let mut guard = s.latest.lock().unwrap();
    loop {
        if s.stop.load(Ordering::SeqCst) {
            return None;
        }
        if !s.paused.load(Ordering::Relaxed) {
            if let Some((seq, frame)) = guard.as_ref() {
                if *seq != last_seq {
                    return Some((*seq, frame.clone()));
                }
            }
        }
        let (next_guard, _) = s.latest_ready.wait_timeout(guard, Duration::from_millis(100)).unwrap();
        guard = next_guard;
    }
}

// The model loop: takes each new camera frame, mattes it at fast real-time resolution (<= 256px),
// bilinearly upscales the smooth alpha to `(w, h)`, and publishes it. Runs a brief CPU vs DirectML
// trial once per app session, caches the winner in `PREFERRED_ENGINE`, and drops the losing session
// immediately to reclaim RAM/VRAM.
fn run_matting(s: &Shared, dir: &std::path::Path, model: &std::path::Path, w: usize, h: usize) -> Result<(), String> {
    use ort::session::Session;
    use ort::value::{Tensor, TensorRef};
    let env = ort_environment(dir)?;
    let threads = (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) / 2).clamp(1, 3);
    let build_cpu = || {
        Session::builder(env)
            .and_then(|b| b.with_intra_threads(threads).map_err(|e| e.into()))
            .and_then(|mut b| b.commit_from_file(model))
            .map_err(|e| e.to_string())
    };
    let build_gpu = || {
        if cfg!(windows) {
            Session::builder(env).and_then(with_gpu).and_then(|mut b| b.commit_from_file(model)).ok()
        } else {
            None
        }
    };

    let mut sessions: Vec<(&'static str, Session)> = match PREFERRED_ENGINE.get().copied() {
        Some("gpu") => match build_gpu() {
            Some(g) => vec![("gpu", g)],
            None => vec![("cpu", build_cpu()?)],
        },
        Some("cpu") => vec![("cpu", build_cpu()?)],
        _ => {
            let mut list = Vec::new();
            // Load GPU first on Windows so if it succeeds, trial starts with GPU warm.
            if let Some(g) = build_gpu() {
                list.push(("gpu", g));
            }
            list.push(("cpu", build_cpu()?));
            list
        }
    };

    let (mw, mh) = matting_size(w, h);
    let m_plane = mw * mh;
    let out_plane = w * h;
    let ratio = (144.0 / mw.max(mh) as f32).clamp(0.25, 0.45);
    let ratio_tensor = Tensor::from_array(([1usize], vec![ratio])).map_err(|e| e.to_string())?;
    let zero = || Tensor::from_array(([1usize, 1, 1, 1], vec![0f32])).map(|t| t.into_dyn());
    let mut recs: Vec<Vec<ort::value::DynValue>> = sessions
        .iter()
        .map(|_| (0..4).map(|_| zero()).collect::<Result<Vec<_>, _>>())
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    // Fast one-time engine trial: 2 warm-up frames + 3 timed frames per engine (~0.5s total on first
    // run ever, 0ms on every subsequent modal open or resize once cached in `PREFERRED_ENGINE`).
    const WARMUP: usize = 2;
    const TRIAL: usize = 5;
    let mut timings: Vec<Vec<f64>> = vec![Vec::new(); sessions.len()];
    let mut chosen: Option<usize> = if sessions.len() == 1 {
        let _ = PREFERRED_ENGINE.set(sessions[0].0);
        s.status.lock().unwrap().engine = sessions[0].0.to_string();
        Some(0)
    } else {
        None
    };
    let mut frame_count = 0usize;
    let mut last_seq = 0u64;
    let mut chw = vec![0f32; m_plane * 3];
    let mut alpha_full = vec![0f32; out_plane];
    let mut fps_since = Instant::now();
    while let Some((seq, frame)) = wait_for_next_frame(s, last_seq) {
        last_seq = seq;
        let which = chosen.unwrap_or((frame_count / TRIAL).min(sessions.len() - 1));
        let started = Instant::now();
        pixel_convert::resize_rgb_to_planar(&frame, w, h, mw, mh, &mut chw);
        let src = TensorRef::from_array_view(([1usize, 3, mh, mw], chw.as_slice())).map_err(|e| e.to_string())?;
        let [r1, r2, r3, r4]: [ort::value::DynValue; 4] = std::mem::take(&mut recs[which]).try_into().map_err(|_| "recurrent state".to_string())?;
        let (_, session) = &mut sessions[which];
        let mut outputs = session
            .run(ort::inputs!["src" => src, "r1i" => r1, "r2i" => r2, "r3i" => r3, "r4i" => r4, "downsample_ratio" => ratio_tensor.view()])
            .map_err(|e| e.to_string())?;
        {
            let (_, pha) = outputs["pha"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            pixel_convert::upscale_alpha_bilinear(&pha[..m_plane], mw, mh, &mut alpha_full, w, h);
            *s.alpha.lock().unwrap() = Some(Arc::new(alpha_full.clone()));
        }
        for name in ["r1o", "r2o", "r3o", "r4o"] {
            recs[which].push(outputs.remove(name).ok_or("recurrent state missing")?);
        }
        drop(outputs);

        // One-time engine trial bookkeeping.
        if chosen.is_none() {
            let in_turn = frame_count % TRIAL;
            if in_turn >= WARMUP {
                timings[which].push(started.elapsed().as_secs_f64());
            }
            frame_count += 1;
            if frame_count >= TRIAL * sessions.len() {
                let median = |t: &Vec<f64>| {
                    let mut t = t.clone();
                    t.sort_by(|a, b| a.total_cmp(b));
                    t.get(t.len() / 2).copied().unwrap_or(f64::MAX)
                };
                let winner = (0..sessions.len()).min_by(|a, b| median(&timings[*a]).total_cmp(&median(&timings[*b]))).unwrap_or(0);
                let winner_name = sessions[winner].0;
                let _ = PREFERRED_ENGINE.set(winner_name);
                log::info!(
                    "Live camera background: {} at {}x{} ({:?} s/frame by engine)",
                    winner_name,
                    mw,
                    mh,
                    timings.iter().map(median).collect::<Vec<_>>()
                );
                // Drop the losing session + recurrent tensors immediately so they don't occupy RAM/VRAM.
                let winning_session = sessions.swap_remove(winner);
                let winning_rec = recs.swap_remove(winner);
                sessions.clear();
                recs.clear();
                sessions.push(winning_session);
                recs.push(winning_rec);
                chosen = Some(0);
                s.status.lock().unwrap().engine = winner_name.to_string();
            }
        }
        if fps_since.elapsed() >= Duration::from_secs(1) {
            let mut st = s.status.lock().unwrap();
            st.engine = sessions[chosen.unwrap_or(which)].0.to_string();
            fps_since = Instant::now();
        }
        // Leave a brief GPU/CPU breather (~5 ms) after each inference when running on an
        // integrated GPU so DirectML never starves WebView2's UI compositor during clicks/hovers.
        if chosen.is_some() {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    Ok(())
}

// Composites every camera frame with the newest matte and the chosen background (showing raw
// camera frames immediately during the first ~150 ms while the matte warms up so there's zero
// blank spinner), and pushes JPEG frames to connected MJPEG preview clients ONLY when a preview
// client is connected or actively polling (0% JPEG cost during recording once the modal closes).
fn composite_frames(s: &Shared, w: usize, h: usize) {
    let plane = w * h;
    let (mut bg, mut tmp, mut out) = (vec![0u8; plane * 3], vec![0u8; plane * 3], vec![0u8; plane * 3]);
    let mut last_seq = 0u64;
    let mut preview_seq: u32 = 0;
    let mut comp_frames = 0u32;
    let mut comp_since = Instant::now();
    let mut jpeg_buf = Vec::with_capacity(32 * 1024);
    while let Some((seq, frame)) = wait_for_next_frame(s, last_seq) {
        last_seq = seq;
        let composed: Arc<Vec<u8>> = if let Some(alpha) = s.alpha.lock().unwrap().clone() {
            // Clone only the Arc so the backdrop mutex is never held across pixel processing.
            let backdrop = s.backdrop.lock().unwrap().clone();
            match &*backdrop {
                Backdrop::Blur(r) => pixel_convert::blur_rgb_fast(&frame, w, h, *r, &mut tmp, &mut bg),
                Backdrop::Color(c) => bg.chunks_exact_mut(3).for_each(|p| p.copy_from_slice(c)),
                Backdrop::Image(img) => bg.copy_from_slice(&img[..plane * 3]),
            }
            pixel_convert::composite_over(&frame, &alpha, &bg, &mut out);
            Arc::new(out.clone())
        } else {
            // Publish live raw camera immediately while the first ONNX matte finishes (~100 ms).
            frame
        };
        *s.composed.lock().unwrap() = Some(composed.clone());
        comp_frames += 1;
        if comp_since.elapsed() >= Duration::from_secs(1) {
            let mut st = s.status.lock().unwrap();
            if !st.engine.is_empty() && !st.engine.starts_with("error") {
                st.fps = (comp_frames as f64 / comp_since.elapsed().as_secs_f64()).round().min(30.0);
            }
            comp_frames = 0;
            comp_since = Instant::now();
        }
        // Only spend CPU JPEG-encoding preview frames while an MJPEG client is connected or a
        // fallback IPC consumer has polled recently.
        let has_mjpeg = s.preview_clients.load(Ordering::Relaxed) > 0;
        let last_poll = s.last_preview_poll_ms.load(Ordering::Relaxed);
        let preview_wanted = has_mjpeg || (last_poll > 0 && epoch_ms().saturating_sub(last_poll) < 1500);
        if preview_wanted {
            jpeg_buf.clear();
            if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buf, 72)
                .encode(&composed, w as u32, h as u32, image::ExtendedColorType::Rgb8)
                .is_ok()
            {
                preview_seq = preview_seq.wrapping_add(1).max(1);
                {
                    let mut pj = s.preview_jpeg.lock().unwrap();
                    *pj = Some((preview_seq, Arc::new(jpeg_buf.clone())));
                }
                s.preview_ready.notify_all();
            }
        }
    }
}

// Localhost HTTP MJPEG push server (`multipart/x-mixed-replace; boundary=frame`): WebView2 renders
// `<img src="http://127.0.0.1:<port>/stream">` natively on its C++ network/decoder thread with
// zero Tauri IPC calls, zero JS Blob GC churn, and always skips directly to the newest frame.
fn serve_mjpeg_preview(s: Arc<Shared>, listener: TcpListener) {
    while !s.stop.load(Ordering::SeqCst) {
        let Ok((mut stream, _)) = listener.accept() else {
            std::thread::sleep(Duration::from_millis(15));
            continue;
        };
        let shared = Arc::clone(&s);
        std::thread::spawn(move || {
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_nodelay(true);
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            // Drain the HTTP GET request headers before streaming.
            let mut req_buf = [0u8; 1024];
            let _ = stream.read(&mut req_buf);

            let header = b"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\nCache-Control: no-store, no-cache, must-revalidate\r\nPragma: no-cache\r\nConnection: close\r\n\r\n";
            if stream.write_all(header).is_err() {
                return;
            }
            shared.preview_clients.fetch_add(1, Ordering::Relaxed);
            let mut last_seq = 0u32;
            while !shared.stop.load(Ordering::SeqCst) {
                let frame = {
                    let mut guard = shared.preview_jpeg.lock().unwrap();
                    loop {
                        if shared.stop.load(Ordering::SeqCst) {
                            break None;
                        }
                        if let Some((seq, jpg)) = guard.as_ref() {
                            if *seq != last_seq {
                                last_seq = *seq;
                                break Some(jpg.clone());
                            }
                        }
                        let (next_g, _) = shared
                            .preview_ready
                            .wait_timeout(guard, Duration::from_millis(100))
                            .unwrap();
                        guard = next_g;
                    }
                };
                let Some(jpg) = frame else { break };
                let part_header = format!(
                    "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                    jpg.len()
                );
                if stream.write_all(part_header.as_bytes()).is_err()
                    || stream.write_all(&jpg).is_err()
                    || stream.write_all(b"\r\n").is_err()
                {
                    break;
                }
            }
            shared.preview_clients.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

// Serves the recording: whenever its ffmpeg connects, writes the newest finished frame (or, before
// the first one, the raw camera frame) 30 times a second until it disconnects. Pauses cleanly while
// the recording ffmpeg is suspended so the TCP send buffer cannot fill and block.
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
            if s.paused.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(25));
                next = Instant::now();
                continue;
            }
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

// ffmpeg input arguments reading the feed - in place of the camera's own input. Its frames
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

// The newest previewed frame as JPEG bytes (empty before the first one, or when `after_seq`
// matches the current frame). When `after_seq` is given, non-empty responses are prefixed with a
// 4-byte little-endian u32 sequence number so the caller can skip unchanged frames.
#[tauri::command(async)]
pub fn camera_effect_preview(after_seq: Option<u32>) -> tauri::ipc::Response {
    let slot = FEED.lock().unwrap();
    let Some(feed) = slot.as_ref() else {
        return tauri::ipc::Response::new(Vec::<u8>::new());
    };
    feed.shared.last_preview_poll_ms.store(epoch_ms(), Ordering::Relaxed);
    let guard = feed.shared.preview_jpeg.lock().unwrap();
    let Some((seq, jpeg)) = guard.as_ref() else {
        return tauri::ipc::Response::new(Vec::<u8>::new());
    };
    if let Some(after) = after_seq {
        if *seq == after {
            return tauri::ipc::Response::new(Vec::<u8>::new());
        }
        let mut out = Vec::with_capacity(4 + jpeg.len());
        out.extend_from_slice(&seq.to_le_bytes());
        out.extend_from_slice(jpeg.as_slice());
        return tauri::ipc::Response::new(out);
    }
    tauri::ipc::Response::new(jpeg.as_ref().clone())
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
        assert_eq!(matting_size(320, 320), (256, 256));
        assert_eq!(matting_size(480, 480), (256, 256));
        assert_eq!(matting_size(320, 240), (256, 192));
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
            paused: AtomicBool::new(false),
            preview_clients: AtomicUsize::new(0),
            last_preview_poll_ms: AtomicU64::new(epoch_ms()),
            latest: Mutex::new(None),
            latest_ready: Condvar::new(),
            alpha: Mutex::new(None),
            composed: Mutex::new(None),
            preview_jpeg: Mutex::new(None),
            preview_ready: Condvar::new(),
            backdrop: Mutex::new(Arc::new(backdrop_for(&CameraEffectSpec { kind: "color".into(), amount: 0.0, color: Some("#0000ff".into()), image_path: None }, w, h))),
            status: Mutex::new(FeedStatus::default()),
        });
        // A fake camera: mid-grey frames at 30 fps.
        let s = shared.clone();
        let camera = std::thread::spawn(move || {
            let mut seq = 0;
            while !s.stop.load(Ordering::SeqCst) {
                seq += 1;
                *s.latest.lock().unwrap() = Some((seq, Arc::new(vec![128u8; (w * h * 3) as usize])));
                s.latest_ready.notify_all();
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
        shared.latest_ready.notify_all();
        for t in [camera, infer, compositor, writer] {
            t.join().unwrap();
        }
        let preview = shared.preview_jpeg.lock().unwrap().clone();
        eprintln!("engine {} at {:.1} fps; {frames} frames in 3 s", status.engine, status.fps);
        assert!(preview.is_some_and(|(_, j)| j.starts_with(&[0xFF, 0xD8])), "a JPEG preview");
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
