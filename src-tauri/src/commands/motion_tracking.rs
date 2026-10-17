// commands/motion_tracking.rs
//
// Motion tracking: follows a region the user picked on one frame of a clip through the rest of it,
// so text, a sticker or a blur region can be pinned to a moving object (src/utils/motionTracking.ts
// turns the result into the overlay's keyframes - the preview and the export then play the very
// same motion). The tracking itself is the motion-track crate (Median Flow + re-acquisition by
// appearance); this decodes the clip into it.
//
// The clip is read as small grayscale frames piped out of ffmpeg at a constant rate (at most the
// source's own, capped at 60): forward from the picked frame to the end of the range as it streams,
// then backward to the start of the range in chunks decoded and walked in reverse, memory-bounded.
// The analysis size keeps the picked box at least ~48 px across (Lucas-Kanade needs texture to
// work with), between 640 px wide and the source's own width (capped at 1920).
//
// Results are cached on disk by everything they depend on, so re-tracking the same thing is
// instant. Progress arrives as `motion-track-progress`; cancel_motion_track stops a run.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State, Window};

use crate::commands::conversion::{preview_cache_path, probe_frame_rate, probe_video_dimensions};
use crate::services::responsiveness::blocking;
use crate::services::utility::{get_ffmpeg_path, get_ffprobe_path};
use motion_track::{smooth, GrayFrame, Sample, Tracker};

#[cfg(windows)]
use crate::commands::recording::hide_console_window;

#[derive(Default)]
pub struct MotionTrackJobs(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionTrackRequest {
    pub job_id: String,
    pub source_path: String,
    // The source range to cover, and the moment the box was picked at (source seconds).
    pub start: f64,
    pub end: f64,
    pub anchor: f64,
    // The picked box: top-left and size as fractions of the source frame.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackSample {
    // Source seconds.
    pub t: f64,
    // The box's centre and size, as fractions of the source frame.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    // 0..1; 0 while the object was lost (the box held where it was last seen).
    pub c: f64,
    pub lost: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionTrackResult {
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub samples: Vec<TrackSample>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackProgress {
    job_id: String,
    progress: f64,
}

const MIN_BOX_PX: f64 = 48.0;
const ANALYSIS_MIN_WIDTH: i64 = 640;
const ANALYSIS_MAX_WIDTH: i64 = 1920;
const MAX_FPS: f64 = 60.0;
// Bytes of decoded frames held at once while walking backward.
const BACKWARD_CHUNK_BYTES: usize = 96 * 1024 * 1024;

struct Unregister<'a>(&'a MotionTrackJobs, String);
impl Drop for Unregister<'_> {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.1);
    }
}

#[tauri::command]
pub async fn cancel_motion_track(jobs: State<'_, MotionTrackJobs>, job_id: String) -> Result<(), String> {
    if let Some(flag) = jobs.0.lock().unwrap_or_else(|e| e.into_inner()).get(&job_id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub async fn track_motion(app_handle: AppHandle, window: Window, jobs: State<'_, MotionTrackJobs>, request: MotionTrackRequest) -> Result<MotionTrackResult, String> {
    let r = request;
    if !(r.end > r.start) || ![r.x, r.y, r.width, r.height, r.anchor].iter().all(|v| v.is_finite()) || r.width <= 0.0 || r.height <= 0.0 {
        return Err("Pick something to follow first".into());
    }
    let anchor = r.anchor.clamp(r.start, r.end);
    let input = PathBuf::from(&r.source_path);
    let ffprobe = get_ffprobe_path(&app_handle)?;
    let ffmpeg = get_ffmpeg_path(&app_handle)?;
    let (probe, path) = (ffprobe.clone(), r.source_path.clone());
    let (src_w, src_h) = blocking(move || probe_video_dimensions(&probe, &path)).await?.ok_or("Couldn't read the video's size")?;
    let (probe, path) = (ffprobe, r.source_path.clone());
    let rate = blocking(move || probe_frame_rate(&probe, &path)).await?;
    let fps = if rate.is_finite() && rate > 1.0 { rate.min(MAX_FPS) } else { 30.0 };

    // Analysis size: the box at least MIN_BOX_PX across where the source allows it.
    let box_px = (r.width * src_w as f64).min(r.height * src_h as f64);
    let want = (src_w as f64 * MIN_BOX_PX / box_px.max(1.0)).round() as i64;
    let aw = (want.max(ANALYSIS_MIN_WIDTH).min(ANALYSIS_MAX_WIDTH).min(src_w)) / 2 * 2;
    let ah = ((aw as f64 * src_h as f64 / src_w.max(1) as f64).round() as i64 / 2 * 2).max(2);

    let key = format!(
        "track_v1_{:.3}_{:.3}_{:.3}_{:.4}_{:.4}_{:.4}_{:.4}_{aw}x{ah}_{fps:.3}",
        r.start, r.end, anchor, r.x, r.y, r.width, r.height
    );
    let cache_path = preview_cache_path(&input, &key, "json")?;
    if let Some(cached) = std::fs::read_to_string(&cache_path).ok().and_then(|t| serde_json::from_str::<MotionTrackResult>(&t).ok()) {
        return Ok(cached);
    }

    let cancel = Arc::new(AtomicBool::new(false));
    jobs.0.lock().unwrap_or_else(|e| e.into_inner()).insert(r.job_id.clone(), cancel.clone());
    let _unregister = Unregister(&jobs, r.job_id.clone());

    let job = TrackJob {
        ffmpeg,
        source: r.source_path.clone(),
        aw: aw as usize,
        ah: ah as usize,
        fps,
        start: r.start,
        end: r.end,
        anchor,
        // The box in analysis pixels: centre and size.
        cx: (r.x + r.width / 2.0) * aw as f64,
        cy: (r.y + r.height / 2.0) * ah as f64,
        bw: r.width * aw as f64,
        bh: r.height * ah as f64,
        cancel,
        window,
        job_id: r.job_id.clone(),
    };
    let (times, mut samples) = blocking(move || job.run()).await??;
    // The jitter out (a Gaussian over ~1/30 s of position, ~1/10 s of size), runs kept apart.
    let per_frame = fps / 30.0;
    smooth(&mut samples, 1.0 * per_frame, 3.0 * per_frame);
    let result = MotionTrackResult {
        width: src_w,
        height: src_h,
        fps,
        samples: times
            .iter()
            .zip(&samples)
            .map(|(t, s)| TrackSample {
                t: *t,
                x: s.cx / aw as f64,
                y: s.cy / ah as f64,
                w: s.w / aw as f64,
                h: s.h / ah as f64,
                c: (s.confidence * 1000.0).round() / 1000.0,
                lost: s.lost,
            })
            .collect(),
    };
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&cache_path, serde_json::to_string(&result).unwrap_or_default());
    Ok(result)
}

struct TrackJob {
    ffmpeg: PathBuf,
    source: String,
    aw: usize,
    ah: usize,
    fps: f64,
    start: f64,
    end: f64,
    anchor: f64,
    cx: f64,
    cy: f64,
    bw: f64,
    bh: f64,
    cancel: Arc<AtomicBool>,
    window: Window,
    job_id: String,
}

impl TrackJob {
    fn frame_len(&self) -> usize {
        self.aw * self.ah
    }

    // ffmpeg decoding [from, from + seconds) of the source as raw gray frames at the job's size and rate.
    fn decoder(&self, from: f64, seconds: f64) -> Result<std::process::Child, String> {
        let mut cmd = Command::new(&self.ffmpeg);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.args(["-v", "error", "-nostdin", "-ss", &format!("{:.4}", from.max(0.0)), "-i", &self.source, "-t", &format!("{:.4}", seconds.max(0.001))]);
        cmd.args(["-an", "-sn", "-vf", &format!("fps={:.4},scale={}:{}:flags=area,format=gray", self.fps, self.aw, self.ah), "-f", "rawvideo", "pipe:1"]);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        cmd.spawn().map_err(|e| format!("Couldn't start ffmpeg: {e}"))
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn progress(&self, done: usize, total: usize) {
        let _ = self.window.emit("motion-track-progress", TrackProgress { job_id: self.job_id.clone(), progress: (done as f64 / total.max(1) as f64).min(1.0) });
    }

    fn gray<'a>(&self, data: &'a [u8]) -> GrayFrame<'a> {
        GrayFrame { width: self.aw, height: self.ah, data }
    }

    // (source time, sample) for every analysed frame from start to end, in time order.
    fn run(self) -> Result<(Vec<f64>, Vec<Sample>), String> {
        let step = 1.0 / self.fps;
        let total = (((self.end - self.start) * self.fps).round() as usize).max(1);
        let mut done = 0usize;

        // Forward, streaming: the first frame is the picked one. Right at the end of a file (or in
        // a gap between frames) there may be no frame to start from - then the nearest one
        // before it is, up to half a second back.
        let mut frame = vec![0u8; self.frame_len()];
        let mut opened = None;
        for back in [0.0, step, 3.0 * step, 0.25, 0.5] {
            let from = (self.anchor - back).max(0.0);
            let mut child = self.decoder(from, self.end - from + step * 0.5)?;
            let mut stdout = child.stdout.take().ok_or("Couldn't read ffmpeg's output")?;
            if stdout.read_exact(&mut frame).is_ok() {
                opened = Some((child, stdout));
                break;
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        let Some((mut child, mut stdout)) = opened else {
            return Err("Couldn't read that moment of the video".into());
        };
        let anchor_frame = frame.clone();
        let mut forward = Tracker::new(self.gray(&frame), self.cx, self.cy, self.bw, self.bh);
        let mut times = vec![self.anchor];
        let mut samples = vec![forward.current()];
        let mut i = 1usize;
        while stdout.read_exact(&mut frame).is_ok() {
            if self.cancelled() {
                let _ = child.kill();
                return Err("Tracking cancelled".into());
            }
            let t = self.anchor + i as f64 * step;
            if t > self.end + step * 0.5 {
                break;
            }
            samples.push(forward.advance(self.gray(&frame)));
            times.push(t);
            i += 1;
            done += 1;
            if done % 8 == 0 {
                self.progress(done, total);
            }
        }
        let _ = child.kill();
        let _ = child.wait();

        // Backward, a chunk at a time: decoded forward, walked in reverse from the frame just
        // before the one already tracked.
        let mut back_times: Vec<f64> = Vec::new();
        let mut back_samples: Vec<Sample> = Vec::new();
        if self.anchor - self.start >= step * 0.5 {
            let mut backward = Tracker::new(self.gray(&anchor_frame), self.cx, self.cy, self.bw, self.bh);
            let chunk_frames = (BACKWARD_CHUNK_BYTES / self.frame_len().max(1)).clamp(8, (self.fps * 4.0) as usize);
            // Every frame time is anchor - k/fps, so chunks line up with the forward pass's grid.
            let mut k_end = 0usize; // the earliest frame tracked so far is anchor - k_end/fps
            let k_last = ((self.anchor - self.start) * self.fps).round() as usize;
            while k_end < k_last {
                let k_start = (k_end + chunk_frames).min(k_last);
                let from = self.anchor - k_start as f64 * step;
                let count = k_start - k_end; // frames anchor-k_start .. anchor-(k_end+1)
                let mut child = self.decoder(from, count as f64 * step + step * 0.5)?;
                let mut stdout = child.stdout.take().ok_or("Couldn't read ffmpeg's output")?;
                let mut chunk: Vec<Vec<u8>> = Vec::with_capacity(count);
                let mut buf = vec![0u8; self.frame_len()];
                while chunk.len() < count && stdout.read_exact(&mut buf).is_ok() {
                    chunk.push(buf.clone());
                }
                let _ = child.kill();
                let _ = child.wait();
                if chunk.is_empty() {
                    break;
                }
                for (j, data) in chunk.iter().enumerate().rev() {
                    if self.cancelled() {
                        return Err("Tracking cancelled".into());
                    }
                    back_samples.push(backward.advance(self.gray(data)));
                    back_times.push(from + j as f64 * step);
                    done += 1;
                    if done % 8 == 0 {
                        self.progress(done, total);
                    }
                }
                k_end = k_start;
            }
        }
        self.progress(total, total);
        back_times.reverse();
        back_samples.reverse();
        back_times.extend(times);
        back_samples.extend(samples);
        Ok((back_times, back_samples))
    }
}

// A video's displayed size (rotation applied) - what the frontend needs to map a box picked on
// the output frame back into the source's own frame before tracking.
#[tauri::command]
pub async fn video_frame_size(app_handle: AppHandle, source_path: String) -> Result<(i64, i64), String> {
    let ffprobe = get_ffprobe_path(&app_handle)?;
    blocking(move || probe_video_dimensions(&ffprobe, &source_path)).await?.ok_or_else(|| "Couldn't read the video's size".to_string())
}
