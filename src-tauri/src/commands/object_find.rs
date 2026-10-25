// "Find & hide": everywhere something the user outlined appears in the video - each appearance as a
// track of boxes over time, which the editor turns into blur regions or covers that follow it
// (src/utils/objectFind.ts).
//
// The source ranges are read as small grayscale frames (ffmpeg, constant rate). Every few frames
// the whole frame is searched for the object (motion_track::Finder - multi-scale normalised
// cross-correlation, so it's found at other sizes and under other lighting); in between, each
// appearance already found is followed by re-matching just around where it was. An appearance that
// can't be matched for a moment ends; one seen only for an instant is dropped as a fluke.
//
// Fast without cutting corners: a frame that's the same picture as the last one searched (most of
// a screen recording, a slide on screen) gets that frame's result instead of a new search, and a
// long range is split into pieces searched side by side, whose appearances are joined back up
// across the seams - the same tracks a single pass finds.
use motion_track::{Detection, Finder, GrayFrame};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Window};

#[cfg(windows)]
use crate::commands::recording::hide_console_window;
use crate::services::responsiveness::blocking;
use crate::services::utility::{get_ffmpeg_path, get_ffprobe_path};

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FindAnchor {
    pub source_path: String,
    // Source seconds of the frame the object was outlined on.
    pub time: f64,
    // The outline's box: top-left and size as fractions of the source frame.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FindRange {
    pub source_path: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindRequest {
    pub job_id: String,
    pub anchor: FindAnchor,
    pub ranges: Vec<FindRange>,
    // 0..1: higher finds less-certain matches too (default 0.5).
    #[serde(default)]
    pub sensitivity: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FoundSample {
    // Source seconds; the box's centre and size as fractions of the source frame; match 0..1.
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundTrack {
    // Which of the request's ranges it was found in.
    pub range_index: usize,
    pub source_path: String,
    pub samples: Vec<FoundSample>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FindProgress {
    job_id: String,
    progress: f64,
    found: usize,
}

// Frames a second analysed (fewer for long videos would miss quick appearances), the analysis
// width, and how often (in frames) the whole frame is searched for new appearances.
const FIND_FPS: f64 = 12.0;
const ANALYSIS_WIDTH: i64 = 960;
const MIN_OBJECT_PX: f64 = 28.0;
const FULL_SEARCH_EVERY: usize = 4;
// A frame is the same picture as another when no 16x16 block of it differs by more than this on
// average (decoder noise and a moving pointer's tip stay under it; a line of text changing doesn't).
const SAME_BLOCK: usize = 16;
const SAME_MEAN_DIFF: f64 = 1.5;
// Ranges longer than this are searched in pieces at once, each at least this long.
const PIECE_MIN_SECS: f64 = 60.0;
// An appearance unmatched for this long has ended; one seen for less than this was a fluke.
const LOST_AFTER_SECS: f64 = 0.4;
const MIN_TRACK_SECS: f64 = 0.25;
// Following an appearance accepts a slightly weaker match than discovering one (it's expected there).
const FOLLOW_SLACK: f32 = 0.08;

fn jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command(async)]
pub fn cancel_find_objects(job_id: String) {
    if let Some(f) = jobs().lock().unwrap().get(&job_id) {
        f.store(true, Ordering::SeqCst);
    }
}

fn probe(ffprobe: &std::path::Path, source: &str) -> Result<(i64, i64), String> {
    crate::commands::conversion::probe_video_dimensions(&ffprobe.to_path_buf(), source).ok_or_else(|| "Couldn't read the video's size".to_string())
}

// The analysis size for a W x H source: 960 wide (never wider than the source), larger when the
// object would otherwise be under ~28 px across.
fn analysis_size(w: i64, h: i64, object_frac: f64) -> (usize, usize) {
    let need = (MIN_OBJECT_PX / object_frac.max(1e-4)).round() as i64;
    let aw = (ANALYSIS_WIDTH.max(need).min(1920).min(w) / 2 * 2).max(2);
    let ah = ((aw as f64 * h as f64 / w.max(1) as f64).round() as i64 / 2 * 2).max(2);
    (aw as usize, ah as usize)
}

fn decoder(ffmpeg: &std::path::Path, source: &str, from: f64, seconds: f64, fps: f64, aw: usize, ah: usize) -> Result<std::process::Child, String> {
    let mut cmd = Command::new(ffmpeg);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.args(["-v", "error", "-nostdin", "-ss", &format!("{:.4}", from.max(0.0)), "-i", source, "-t", &format!("{:.4}", seconds.max(0.001))]);
    cmd.args(["-an", "-sn", "-vf", &format!("fps={fps:.4},scale={aw}:{ah}:flags=area,format=gray"), "-f", "rawvideo", "pipe:1"]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    cmd.spawn().map_err(|e| format!("Couldn't start ffmpeg: {e}"))
}

struct Open {
    last: Detection,
    misses: usize,
    // Whether it was matched on the frame `patch` was taken from.
    hit: bool,
    // The neighbourhood it was last looked for in - while that's still the same picture, the result
    // is too.
    patch: Option<Patch>,
    samples: Vec<(f64, Detection)>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
struct Rect {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
}

struct Patch {
    rect: Rect,
    data: Vec<u8>,
}

type Track = Vec<(f64, Detection)>;

fn crop(data: &[u8], stride: usize, r: Rect) -> Vec<u8> {
    let mut out = Vec::with_capacity(r.w * r.h);
    for y in r.y..r.y + r.h {
        out.extend_from_slice(&data[y * stride + r.x..y * stride + r.x + r.w]);
    }
    out
}

// The neighbourhood following looks at for `d` (as refine reads it: a box and a half, plus a little).
fn patch_rect(d: &Detection, aw: usize, ah: usize) -> Rect {
    let (hw, hh) = (d.w * 0.9 + 2.0, d.h * 0.9 + 2.0);
    let x0 = (d.cx - hw).floor().clamp(0.0, aw as f64 - 1.0) as usize;
    let y0 = (d.cy - hh).floor().clamp(0.0, ah as f64 - 1.0) as usize;
    let x1 = ((d.cx + hw).ceil() as usize).clamp(x0 + 1, aw);
    let y1 = ((d.cy + hh).ceil() as usize).clamp(y0 + 1, ah);
    Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// Whether `a` and `b` (w x h, gray) are the same picture: every 16x16 block within SAME_MEAN_DIFF.
fn same_picture(a: &[u8], b: &[u8], w: usize, h: usize) -> bool {
    changed_blocks(a, b, w, h).iter().all(|c| !c)
}

// Which 16x16 blocks of `b` differ from `a` (row-major, w/16 x h/16 rounded up).
fn changed_blocks(a: &[u8], b: &[u8], w: usize, h: usize) -> Vec<bool> {
    let bw = w.div_ceil(SAME_BLOCK);
    let mut out = Vec::with_capacity(bw * h.div_ceil(SAME_BLOCK));
    let mut sums = vec![0u32; bw];
    for by in (0..h).step_by(SAME_BLOCK) {
        sums.iter_mut().for_each(|v| *v = 0);
        let rows = SAME_BLOCK.min(h - by);
        for y in by..by + rows {
            let (ra, rb) = (&a[y * w..(y + 1) * w], &b[y * w..(y + 1) * w]);
            for (x, (&pa, &pb)) in ra.iter().zip(rb).enumerate() {
                sums[x / SAME_BLOCK] += pa.abs_diff(pb) as u32;
            }
        }
        for (bx, &sum) in sums.iter().enumerate() {
            let cols = SAME_BLOCK.min(w - bx * SAME_BLOCK);
            out.push(sum as f64 > SAME_MEAN_DIFF * (rows * cols) as f64);
        }
    }
    out
}

// The parts of the frame to search after `changed` blocks: each changed area grown by `margin`
// pixels (so anything touching it is wholly inside), overlapping ones merged - or the whole frame
// when that's most of it anyway.
fn search_regions(changed: &[bool], w: usize, h: usize, margin: usize) -> Vec<Rect> {
    let bw = w.div_ceil(SAME_BLOCK);
    let mut rects: Vec<(usize, usize, usize, usize)> = Vec::new();
    for (i, &c) in changed.iter().enumerate() {
        if c {
            let (bx, by) = (i % bw, i / bw);
            let x0 = (bx * SAME_BLOCK).saturating_sub(margin);
            let y0 = (by * SAME_BLOCK).saturating_sub(margin);
            let x1 = ((bx + 1) * SAME_BLOCK + margin).min(w);
            let y1 = ((by + 1) * SAME_BLOCK + margin).min(h);
            rects.push((x0, y0, x1, y1));
        }
    }
    // Merge until no two overlap.
    let mut merged = true;
    while merged {
        merged = false;
        let mut out: Vec<(usize, usize, usize, usize)> = Vec::new();
        for r in rects {
            if let Some(o) = out.iter_mut().find(|o| r.0 < o.2 && o.0 < r.2 && r.1 < o.3 && o.1 < r.3) {
                *o = (o.0.min(r.0), o.1.min(r.1), o.2.max(r.2), o.3.max(r.3));
                merged = true;
            } else {
                out.push(r);
            }
        }
        rects = out;
    }
    let area: usize = rects.iter().map(|r| (r.2 - r.0) * (r.3 - r.1)).sum();
    if area * 10 > w * h * 6 {
        return vec![Rect { x: 0, y: 0, w, h }];
    }
    rects.into_iter().map(|r| Rect { x: r.0, y: r.1, w: r.2 - r.0, h: r.3 - r.1 }).collect()
}

// Unchanged-picture reuse is always on; the real-video benchmark switches it off to compare.
#[cfg(not(test))]
fn reuse_unchanged() -> bool {
    true
}
#[cfg(test)]
static NO_REUSE: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
fn reuse_unchanged() -> bool {
    !NO_REUSE.load(Ordering::SeqCst)
}

// Do two boxes show the same appearance (centres within 70% of their mean half-size)?
fn same_place(a: &Detection, b: &Detection) -> bool {
    (a.cx - b.cx).abs() < (a.w + b.w) / 2.0 * 0.7 && (a.cy - b.cy).abs() < (a.h + b.h) / 2.0 * 0.7
}

// Finds and follows the object through frames fed in order, `step` seconds apart from `from`.
// Every appearance, however short, in the frames' own pixels (keep_tracks drops the flukes).
//
// New appearances are looked for every FULL_SEARCH_EVERY frames, only where the picture has changed
// since the last look (it searched everything else already), and each one found is then followed
// back through the frames since that last look - so it starts on the very frame it appeared. In
// between, each appearance is followed frame by frame, re-matched only when its neighbourhood
// changed.
fn scan_raw(finder: &Finder, frames: impl Iterator<Item = Vec<u8>>, aw: usize, ah: usize, from: f64, step: f64, threshold: f32, cancel: &AtomicBool, mut on_frame: impl FnMut(usize)) -> Result<Vec<Track>, String> {
    let lost_after = ((LOST_AFTER_SECS / step).ceil() as usize).max(1);
    let follow_min = threshold - FOLLOW_SLACK;
    let margin = (finder.max_extent() * 0.6).ceil() as usize + SAME_BLOCK;
    let reuse = reuse_unchanged();
    let mut open: Vec<Open> = Vec::new();
    let mut closed: Vec<Track> = Vec::new();
    // The picture as of the last look for new appearances (updated where it looked).
    let mut reference: Option<Vec<u8>> = None;
    // The frames since that look, for following a new appearance back to its start.
    let mut since: Vec<(f64, Vec<u8>)> = Vec::new();
    for (i, data) in frames.enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err("Search cancelled".into());
        }
        let t = from + i as f64 * step;
        let frame = GrayFrame { width: aw, height: ah, data: &data };
        // Follow what's already been found.
        for o in open.iter_mut() {
            let rect = patch_rect(&o.last, aw, ah);
            let unchanged = reuse && o.patch.as_ref().is_some_and(|p| p.rect == rect && same_picture(&p.data, &crop(&data, aw, rect), rect.w, rect.h));
            let found = if unchanged {
                o.hit.then_some(o.last)
            } else {
                let found = finder.locate_near(frame, o.last).filter(|d| d.score >= follow_min);
                o.patch = Some(Patch { rect, data: crop(&data, aw, rect) });
                o.hit = found.is_some();
                found
            };
            match found {
                Some(d) => {
                    o.last = d;
                    o.misses = 0;
                    o.samples.push((t, d));
                }
                None => o.misses += 1,
            }
        }
        let (ended, still): (Vec<Open>, Vec<Open>) = open.into_iter().partition(|o| o.misses >= lost_after);
        closed.extend(ended.into_iter().map(|o| o.samples));
        open = still;

        if i % FULL_SEARCH_EVERY == 0 {
            let regions = match (&reference, reuse) {
                (Some(r), true) => search_regions(&changed_blocks(r, &data, aw, ah), aw, ah, margin),
                _ => vec![Rect { x: 0, y: 0, w: aw, h: ah }],
            };
            for rect in &regions {
                let found = if rect.w == aw && rect.h == ah {
                    finder.find(frame, threshold)
                } else {
                    let sub = crop(&data, aw, *rect);
                    finder
                        .find(GrayFrame { width: rect.w, height: rect.h, data: &sub }, threshold)
                        .into_iter()
                        .map(|d| Detection { cx: d.cx + rect.x as f64, cy: d.cy + rect.y as f64, ..d })
                        .collect()
                };
                for d in found {
                    if open.iter().any(|o| same_place(&o.last, &d)) {
                        continue;
                    }
                    // Back through the frames since the last look, to where it first showed.
                    let mut earlier: Track = Vec::new();
                    let mut cur = d;
                    for (tj, fj) in since.iter().rev() {
                        match finder.locate_near(GrayFrame { width: aw, height: ah, data: fj }, cur).filter(|e| e.score >= follow_min) {
                            Some(e) => {
                                earlier.push((*tj, e));
                                cur = e;
                            }
                            None => break,
                        }
                    }
                    earlier.reverse();
                    earlier.push((t, d));
                    open.push(Open { last: d, misses: 0, hit: true, patch: None, samples: earlier });
                }
            }
            // What was looked at is now the reference; elsewhere the old picture stays, so a slow
            // change (a fade) still adds up to a look.
            match reference.as_mut() {
                Some(r) if reuse => {
                    for rect in &regions {
                        for y in rect.y..rect.y + rect.h {
                            r[y * aw + rect.x..y * aw + rect.x + rect.w].copy_from_slice(&data[y * aw + rect.x..y * aw + rect.x + rect.w]);
                        }
                    }
                }
                _ => reference = Some(data.clone()),
            }
            since.clear();
        } else {
            since.push((t, data));
        }
        on_frame(i);
    }
    closed.extend(open.into_iter().map(|o| o.samples));
    Ok(closed)
}

// The appearances worth keeping: seen on two frames or more, for at least MIN_TRACK_SECS.
fn keep_tracks(tracks: Vec<Track>, step: f64) -> Vec<Track> {
    let min_span = MIN_TRACK_SECS.max(step * 2.0);
    tracks.into_iter().filter(|s| s.len() >= 2 && s.last().map(|l| l.0).unwrap_or(0.0) - s[0].0 >= min_span - 1e-9).collect()
}

// Finds and follows the object through one range's frames (fed in order, `step` seconds apart from
// `from`). Returns the appearances, in the frames' own pixels.
pub(crate) fn scan_frames(finder: &Finder, frames: impl Iterator<Item = Vec<u8>>, aw: usize, ah: usize, from: f64, step: f64, threshold: f32, cancel: &AtomicBool, on_frame: impl FnMut(usize)) -> Result<Vec<Track>, String> {
    Ok(keep_tracks(scan_raw(finder, frames, aw, ah, from, step, threshold, cancel, on_frame)?, step))
}

// Joins the appearances of consecutive pieces of one range (`pieces[k]` starts at `starts[k]`): one
// still going at a seam continues as the appearance at the same place when the next piece starts -
// what a single pass would have followed straight through.
fn stitch(pieces: Vec<Vec<Track>>, starts: &[f64], step: f64) -> Vec<Track> {
    let window = LOST_AFTER_SECS + step * 1.5;
    let mut done: Vec<Track> = Vec::new();
    let mut running: Vec<Track> = Vec::new();
    for (k, piece) in pieces.into_iter().enumerate() {
        if k == 0 {
            running = piece;
            continue;
        }
        let seam = starts[k];
        let (mut ending, mut carried): (Vec<Track>, Vec<Track>) = (Vec::new(), Vec::new());
        for t in running.drain(..) {
            if t.last().is_some_and(|l| l.0 >= seam - window) {
                carried.push(t);
            } else {
                ending.push(t);
            }
        }
        done.append(&mut ending);
        let mut next: Vec<Track> = Vec::new();
        let mut taken = vec![false; carried.len()];
        for t in piece {
            let first = t[0];
            // The nearest track carried over the seam to where this one starts.
            let best = (first.0 <= seam + window)
                .then(|| {
                    carried
                        .iter()
                        .enumerate()
                        .filter(|(j, c)| !taken[*j] && same_place(&c.last().unwrap().1, &first.1))
                        .min_by(|(_, a), (_, b)| {
                            let d = |c: &Track| (c.last().unwrap().1.cx - first.1.cx).hypot(c.last().unwrap().1.cy - first.1.cy);
                            d(a).partial_cmp(&d(b)).unwrap_or(std::cmp::Ordering::Equal)
                        })
                        .map(|(j, _)| j)
                })
                .flatten();
            match best {
                Some(j) => {
                    taken[j] = true;
                    let mut joined = std::mem::take(&mut carried[j]);
                    joined.extend(t);
                    next.push(joined);
                }
                None => next.push(t),
            }
        }
        done.extend(carried.into_iter().zip(taken).filter(|(_, used)| !used).map(|(c, _)| c));
        running = next;
    }
    done.extend(running);
    done.sort_by(|a, b| a[0].0.partial_cmp(&b[0].0).unwrap_or(std::cmp::Ordering::Equal));
    done
}

// The match needed, raised above whatever ISN'T the object on the frame it was outlined on: text,
// icons and edges there that resemble it score up to some level, and anything elsewhere matching no
// better is as likely one of those. Exact copies on that frame (a logo shown twice) don't count -
// they're the object. `sensitivity` (0 exact .. 1 similar) sets how far above that level.
const EXACT_COPY: f32 = 0.97;
fn calibrated_threshold(finder: &Finder, frame: GrayFrame, picked: Detection, base: f32, sensitivity: f32) -> f32 {
    let distractor = finder
        .find(frame, 0.5)
        .into_iter()
        .filter(|d| !same_place(d, &picked) && d.score < EXACT_COPY)
        .map(|d| d.score)
        .fold(f32::MIN, f32::max);
    if distractor == f32::MIN {
        return base;
    }
    let margin = 0.02 + 0.03 * (1.0 - sensitivity);
    base.max((distractor + margin).min(0.93))
}

// How many pieces to search a range `span` seconds long in at once.
fn piece_count(span: f64) -> usize {
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2) / 2;
    ((span / PIECE_MIN_SECS).floor() as usize).clamp(1, workers.clamp(1, 4))
}

#[tauri::command]
pub async fn find_objects(app_handle: AppHandle, window: Window, request: FindRequest) -> Result<Vec<FoundTrack>, String> {
    let a = request.anchor.clone();
    if ![a.x, a.y, a.width, a.height, a.time].iter().all(|v| v.is_finite()) || a.width <= 0.0 || a.height <= 0.0 {
        return Err("Outline something to find first".into());
    }
    let (ffmpeg, ffprobe) = (get_ffmpeg_path(&app_handle)?, get_ffprobe_path(&app_handle)?);
    let cancel = Arc::new(AtomicBool::new(false));
    jobs().lock().unwrap().insert(request.job_id.clone(), cancel.clone());
    let job_id = request.job_id.clone();
    let result = blocking(move || -> Result<Vec<FoundTrack>, String> {
        // Sensitivity 0..1 -> the match needed: 0.86 (only near-identical) .. 0.62 (loose).
        let threshold = (0.86 - 0.24 * request.sensitivity.unwrap_or(0.5).clamp(0.0, 1.0)) as f32;
        // The object's appearance, from the frame it was outlined on.
        let (sw, sh) = probe(&ffprobe, &a.source_path)?;
        let (aw, ah) = analysis_size(sw, sh, a.width.min(a.height * sh as f64 / sw as f64));
        let mut child = decoder(&ffmpeg, &a.source_path, a.time, 0.5, FIND_FPS, aw, ah)?;
        let mut first = vec![0u8; aw * ah];
        let got = child.stdout.take().map(|mut out| out.read_exact(&mut first).is_ok()).unwrap_or(false);
        let _ = child.kill();
        let _ = child.wait();
        if !got {
            return Err("Couldn't read that moment of the video".into());
        }
        let finder = Finder::new(GrayFrame { width: aw, height: ah, data: &first }, a.x * aw as f64, a.y * ah as f64, a.width * aw as f64, a.height * ah as f64, 0.5, 2.0)
            .ok_or("That area is too plain to find elsewhere - outline something with more detail")?;
        let picked = Detection { cx: (a.x + a.width / 2.0) * aw as f64, cy: (a.y + a.height / 2.0) * ah as f64, w: a.width * aw as f64, h: a.height * ah as f64, score: 1.0 };
        let threshold = calibrated_threshold(&finder, GrayFrame { width: aw, height: ah, data: &first }, picked, threshold, request.sensitivity.unwrap_or(0.5).clamp(0.0, 1.0) as f32);

        let total: f64 = request.ranges.iter().map(|r| (r.end - r.start).max(0.0)).sum::<f64>().max(1e-3);
        let mut done = 0f64;
        let mut tracks: Vec<FoundTrack> = Vec::new();
        for (range_index, r) in request.ranges.iter().enumerate() {
            if r.end - r.start < 0.05 {
                continue;
            }
            // Ranges from another file are analysed at that file's own scale of the object.
            let (rw, rh) = if r.source_path == a.source_path { (sw, sh) } else { probe(&ffprobe, &r.source_path)? };
            let (rw_a, rh_a) = if r.source_path == a.source_path { (aw, ah) } else { analysis_size(rw, rh, a.width) };
            let step = 1.0 / FIND_FPS;
            let found_so_far = tracks.len();
            let span = r.end - r.start;
            // Pieces of whole frames, each searched by its own decoder and thread.
            let frames_total = (span * FIND_FPS).ceil().max(1.0) as usize;
            let pieces = piece_count(span);
            let per = frames_total.div_ceil(pieces);
            let starts: Vec<f64> = (0..pieces).map(|k| r.start + (k * per) as f64 * step).collect();
            let analysed = std::sync::atomic::AtomicUsize::new(0);
            let results: Vec<Result<Vec<Track>, String>> = std::thread::scope(|scope| {
                let handles: Vec<_> = (0..pieces)
                    .map(|k| {
                        let (from, cancel, analysed, finder, ffmpeg, window, job_id) = (starts[k], &cancel, &analysed, &finder, &ffmpeg, &window, &job_id);
                        let seconds = if k + 1 == pieces { r.end - from } else { per as f64 * step };
                        scope.spawn(move || -> Result<Vec<Track>, String> {
                            let mut child = decoder(ffmpeg, &r.source_path, from, seconds, FIND_FPS, rw_a, rh_a)?;
                            let mut out = child.stdout.take().ok_or("Couldn't read ffmpeg's output")?;
                            // The last piece reads to the end; the others stop at their share.
                            let limit = if k + 1 == pieces { usize::MAX } else { per };
                            let frames = std::iter::from_fn(|| {
                                let mut buf = vec![0u8; rw_a * rh_a];
                                out.read_exact(&mut buf).ok().map(|_| buf)
                            })
                            .take(limit);
                            let found = scan_raw(finder, frames, rw_a, rh_a, from, step, threshold, cancel, |_| {
                                let n = analysed.fetch_add(1, Ordering::Relaxed) + 1;
                                if n % 6 == 0 {
                                    let p = (done + (n as f64 * step).min(span)) / total;
                                    let _ = window.emit("find-objects-progress", FindProgress { job_id: job_id.clone(), progress: p.min(0.99), found: found_so_far });
                                }
                            });
                            let _ = child.kill();
                            let _ = child.wait();
                            if found.is_err() {
                                // One piece failing (or cancelled) stops the others too.
                                cancel.store(true, Ordering::SeqCst);
                            }
                            found
                        })
                    })
                    .collect();
                handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("The search stopped unexpectedly".into()))).collect()
            });
            let mut parts = Vec::with_capacity(pieces);
            for res in results {
                parts.push(res?);
            }
            let found = keep_tracks(stitch(parts, &starts, step), step);
            for samples in found {
                tracks.push(FoundTrack {
                    range_index,
                    source_path: r.source_path.clone(),
                    samples: samples
                        .into_iter()
                        .map(|(t, d)| FoundSample { t, x: d.cx / rw_a as f64, y: d.cy / rh_a as f64, w: d.w / rw_a as f64, h: d.h / rh_a as f64, score: (d.score * 1000.0).round() / 1000.0 })
                        .collect(),
                });
            }
            done += span;
        }
        let _ = window.emit("find-objects-progress", FindProgress { job_id: job_id.clone(), progress: 1.0, found: tracks.len() });
        Ok(tracks)
    })
    .await;
    jobs().lock().unwrap().remove(&request.job_id);
    result?
}

#[cfg(test)]
mod tests {
    use super::*;

    // A bright square with an "X" in it, moving right across a noisy frame and leaving at the end.
    fn frames(n: usize, w: usize, h: usize) -> Vec<Vec<u8>> {
        (0..n)
            .map(|k| {
                let mut seed = 5u32;
                let mut f: Vec<u8> = (0..w * h)
                    .map(|i| {
                        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
                        (100 + (i % 7) as u32 * 3 + (seed >> 29)) as u8
                    })
                    .collect();
                if k < n - 6 {
                    let (x0, y0) = (20 + k * 6, 60);
                    for y in 0..40usize {
                        for x in 0..40usize {
                            let on_x = x == y || x + y == 39 || x.abs_diff(y) <= 1 || (x + y).abs_diff(39) <= 1;
                            f[(y0 + y) * w + x0 + x] = if on_x { 20 } else { 230 };
                        }
                    }
                }
                f
            })
            .collect()
    }

    // Frames that hold still for stretches (the same frame repeated), with a little decoder-like
    // noise on the repeats - what unchanged-picture reuse is for.
    fn with_still_stretches(all: &[Vec<u8>]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        for (k, f) in all.iter().enumerate() {
            out.push(f.clone());
            if k % 5 == 2 {
                for r in 0..7u8 {
                    let mut g = f.clone();
                    g.iter_mut().enumerate().filter(|(i, _)| i % 97 == r as usize).for_each(|(_, v)| *v = v.saturating_add(1));
                    out.push(g);
                }
            }
        }
        out
    }

    // The same frames with a "webcam" corner that changes on every one - far from the object.
    fn with_busy_corner(all: &[Vec<u8>], w: usize) -> Vec<Vec<u8>> {
        all.iter()
            .enumerate()
            .map(|(k, f)| {
                let mut g = f.clone();
                for y in 130..176 {
                    for x in 250..316 {
                        g[y * w + x] = ((x * 7 + y * 3 + k * 41) % 251) as u8;
                    }
                }
                g
            })
            .collect()
    }

    #[test]
    fn reusing_unchanged_pictures_finds_the_same_tracks() {
        let (w, h) = (320, 180);
        let finder = Finder::new(GrayFrame { width: w, height: h, data: &frames(30, w, h)[0] }, 20.0, 60.0, 40.0, 40.0, 0.5, 2.0).unwrap();
        let cancel = AtomicBool::new(false);
        for all in [with_still_stretches(&frames(30, w, h)), with_busy_corner(&with_still_stretches(&frames(30, w, h)), w)] {
            let fast = scan_frames(&finder, all.clone().into_iter(), w, h, 0.0, 0.1, 0.8, &cancel, |_| {}).unwrap();
            NO_REUSE.store(true, Ordering::SeqCst);
            let full = scan_frames(&finder, all.into_iter(), w, h, 0.0, 0.1, 0.8, &cancel, |_| {});
            NO_REUSE.store(false, Ordering::SeqCst);
            let full = full.unwrap();
            assert_eq!(fast.len(), 1);
            assert_eq!(fast.len(), full.len());
            for (a, b) in fast.iter().zip(&full) {
                assert_eq!(a.len(), b.len());
                for ((ta, da), (tb, db)) in a.iter().zip(b) {
                    assert!((ta - tb).abs() < 1e-9 && (da.cx - db.cx).abs() < 0.6 && (da.cy - db.cy).abs() < 0.6 && (da.w - db.w).abs() < 0.6, "{ta} {da:?} vs {tb} {db:?}");
                }
            }
        }
        let all = frames(10, w, h);
        assert!(!same_picture(&all[0], &all[1], w, h), "a moved object is a different picture");
        let still = with_still_stretches(&all);
        assert!(same_picture(&still[3], &still[4], w, h), "decoder noise is the same picture");
    }

    #[test]
    fn an_appearance_starts_on_the_frame_it_appears_between_looks() {
        let (w, h) = (320, 180);
        let all = frames(30, w, h);
        let finder = Finder::new(GrayFrame { width: w, height: h, data: &all[0] }, 20.0, 60.0, 40.0, 40.0, 0.5, 2.0).unwrap();
        let cancel = AtomicBool::new(false);
        // Nothing for 6 frames (the object off screen), then it slides in: it first shows on frame 6,
        // between the looks at frames 4 and 8.
        let blank = frames(30, w, h).pop().unwrap();
        let mut seq = vec![blank; 6];
        seq.extend(all.iter().skip(3).take(12).cloned());
        let tracks = scan_frames(&finder, seq.into_iter(), w, h, 0.0, 0.1, 0.8, &cancel, |_| {}).unwrap();
        assert_eq!(tracks.len(), 1);
        assert!((tracks[0][0].0 - 0.6).abs() < 1e-9, "starts at {}", tracks[0][0].0);
        assert_eq!(tracks[0].len(), 12);
    }

    #[test]
    fn looks_only_where_the_picture_changed() {
        let (w, h) = (320usize, 180usize);
        let mut changed = vec![false; w.div_ceil(16) * h.div_ceil(16)];
        changed[0] = true;
        let r = search_regions(&changed, w, h, 40);
        assert_eq!(r, vec![Rect { x: 0, y: 0, w: 56, h: 56 }]);
        // Two changes close together become one area; most of the frame becomes the whole frame.
        changed[2] = true;
        assert_eq!(search_regions(&changed, w, h, 40).len(), 1);
        assert_eq!(search_regions(&vec![true; changed.len()], w, h, 40), vec![Rect { x: 0, y: 0, w, h }]);
        assert!(search_regions(&vec![false; changed.len()], w, h, 40).is_empty());
    }

    #[test]
    fn pieces_join_up_into_the_tracks_one_pass_finds() {
        let (w, h) = (320, 180);
        let all = frames(30, w, h);
        let finder = Finder::new(GrayFrame { width: w, height: h, data: &all[0] }, 20.0, 60.0, 40.0, 40.0, 0.5, 2.0).unwrap();
        let cancel = AtomicBool::new(false);
        let step = 0.1;
        let whole = scan_frames(&finder, all.clone().into_iter(), w, h, 10.0, step, 0.8, &cancel, |_| {}).unwrap();
        for cut in [1usize, 7, 12, 23] {
            let a = scan_raw(&finder, all[..cut].to_vec().into_iter(), w, h, 10.0, step, 0.8, &cancel, |_| {}).unwrap();
            let b = scan_raw(&finder, all[cut..].to_vec().into_iter(), w, h, 10.0 + cut as f64 * step, step, 0.8, &cancel, |_| {}).unwrap();
            let joined = keep_tracks(stitch(vec![a, b], &[10.0, 10.0 + cut as f64 * step], step), step);
            assert_eq!(joined.len(), whole.len(), "cut at {cut}: {joined:?}");
            assert_eq!(joined[0].len(), whole[0].len(), "cut at {cut}");
            assert!(joined[0].iter().zip(&whole[0]).all(|(x, y)| (x.0 - y.0).abs() < 1e-9 && (x.1.cx - y.1.cx).abs() < 0.6), "cut at {cut}");
        }
        // Two separate appearances either side of a seam stay separate.
        let blank = vec![vec![110u8; w * h]; 10];
        let mut gap = all[..8].to_vec();
        gap.extend(blank);
        gap.extend(all[..8].iter().cloned());
        let a = scan_raw(&finder, gap[..12].to_vec().into_iter(), w, h, 0.0, step, 0.8, &cancel, |_| {}).unwrap();
        let b = scan_raw(&finder, gap[12..].to_vec().into_iter(), w, h, 1.2, step, 0.8, &cancel, |_| {}).unwrap();
        assert_eq!(keep_tracks(stitch(vec![a, b], &[0.0, 1.2], step), step).len(), 2);
    }

    // Real footage, timed: FIND_BENCH_SOURCE (a video), FIND_BENCH_BOX ("t,x,y,w,h" - the moment
    // and box, fractions, of something in it), FIND_BENCH_RANGE ("start,end"), FFMPEG_DIR. Searches
    // the range the old way (every frame searched, one pass) and the new way (unchanged frames
    // reused, in pieces at once) and checks they find the same appearances.
    #[test]
    #[ignore]
    fn real_video_search_speed() {
        let (Ok(source), Ok(bx), Ok(range), Ok(dir)) = (std::env::var("FIND_BENCH_SOURCE"), std::env::var("FIND_BENCH_BOX"), std::env::var("FIND_BENCH_RANGE"), std::env::var("FFMPEG_DIR")) else { return };
        let ffmpeg = std::path::PathBuf::from(&dir).join("ffmpeg.exe");
        let ffprobe = std::path::PathBuf::from(&dir).join("ffprobe.exe");
        let v: Vec<f64> = bx.split(',').map(|s| s.parse().unwrap()).collect();
        let r: Vec<f64> = range.split(',').map(|s| s.parse().unwrap()).collect();
        let (sw, sh) = probe(&ffprobe, &source).unwrap();
        let (aw, ah) = analysis_size(sw, sh, v[3].min(v[4] * sh as f64 / sw as f64));
        let read = |from: f64, secs: f64| -> Vec<Vec<u8>> {
            let mut child = decoder(&ffmpeg, &source, from, secs, FIND_FPS, aw, ah).unwrap();
            let mut out = child.stdout.take().unwrap();
            let frames: Vec<Vec<u8>> = std::iter::from_fn(|| {
                let mut buf = vec![0u8; aw * ah];
                out.read_exact(&mut buf).ok().map(|_| buf)
            })
            .collect();
            let _ = child.wait();
            frames
        };
        let first = read(v[0], 0.2).remove(0);
        let finder = Finder::new(GrayFrame { width: aw, height: ah, data: &first }, v[1] * aw as f64, v[2] * ah as f64, v[3] * aw as f64, v[4] * ah as f64, 0.5, 2.0).unwrap();
        for d in finder.find(GrayFrame { width: aw, height: ah, data: &first }, 0.6).iter().take(8) {
            eprintln!("anchor frame: ({:.1},{:.1}) {:.1}x{:.1} score {:.3}", d.cx, d.cy, d.w, d.h, d.score);
        }
        eprintln!("picked: ({:.1},{:.1}) {:.1}x{:.1}", (v[1] + v[3] / 2.0) * aw as f64, (v[2] + v[4] / 2.0) * ah as f64, v[3] * aw as f64, v[4] * ah as f64);
        let picked = Detection { cx: (v[1] + v[3] / 2.0) * aw as f64, cy: (v[2] + v[4] / 2.0) * ah as f64, w: v[3] * aw as f64, h: v[4] * ah as f64, score: 1.0 };
        eprintln!("at the picked box: {:?}", finder.locate_near(GrayFrame { width: aw, height: ah, data: &first }, picked));
        let thr = calibrated_threshold(&finder, GrayFrame { width: aw, height: ah, data: &first }, picked, 0.74, 0.5);
        eprintln!("threshold 0.74 -> {thr:.3}");
        if std::env::var("FIND_BENCH_ANCHOR_ONLY").is_ok() {
            return;
        }
        let frames = read(r[0], r[1] - r[0]);
        let step = 1.0 / FIND_FPS;
        let cancel = AtomicBool::new(false);
        let unchanged = frames.windows(2).filter(|p| same_picture(&p[0], &p[1], aw, ah)).count();

        NO_REUSE.store(true, Ordering::SeqCst);
        let t0 = std::time::Instant::now();
        let old = scan_frames(&finder, frames.clone().into_iter(), aw, ah, r[0], step, thr, &cancel, |_| {}).unwrap();
        let old_secs = t0.elapsed().as_secs_f64();
        NO_REUSE.store(false, Ordering::SeqCst);

        let t0 = std::time::Instant::now();
        let pieces = piece_count((r[1] - r[0]).max(PIECE_MIN_SECS * 4.0));
        let per = frames.len().div_ceil(pieces);
        let starts: Vec<f64> = (0..pieces).map(|k| r[0] + (k * per) as f64 * step).collect();
        let parts: Vec<Vec<Track>> = std::thread::scope(|s| {
            let (finder, cancel) = (&finder, &cancel);
            let hs: Vec<_> = frames.chunks(per).zip(&starts).map(|(c, &from)| s.spawn(move || scan_raw(finder, c.to_vec().into_iter(), aw, ah, from, step, thr, cancel, |_| {}).unwrap())).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let new = keep_tracks(stitch(parts, &starts, step), step);
        let new_secs = t0.elapsed().as_secs_f64();
        eprintln!(
            "{} frames ({aw}x{ah}), {:.0}% unchanged: old {old_secs:.1}s ({} found), new {new_secs:.1}s ({} found) in {pieces} pieces - {:.1}x",
            frames.len(),
            unchanged as f64 * 100.0 / frames.len().max(1) as f64,
            old.len(),
            new.len(),
            old_secs / new_secs
        );
        let samples = |t: &[Track]| t.iter().map(|x| x.len()).sum::<usize>();
        eprintln!("samples: old {}, new {}", samples(&old), samples(&new));
        for t in &old {
            let (t0, d) = t[0];
            let (t1, _) = t[t.len() - 1];
            let mean = t.iter().map(|x| x.1.score).sum::<f32>() / t.len() as f32;
            eprintln!("  {t0:.2}-{t1:.2}s at ({:.0},{:.0}) {:.0}x{:.0} score {:.3} mean {mean:.3}", d.cx, d.cy, d.w, d.h, d.score);
        }
        assert_eq!(old.len(), new.len());
    }

    #[test]
    fn follows_an_appearance_and_ends_it_when_it_leaves() {
        let (w, h) = (320, 180);
        let all = frames(30, w, h);
        let finder = Finder::new(GrayFrame { width: w, height: h, data: &all[0] }, 20.0, 60.0, 40.0, 40.0, 0.5, 2.0).unwrap();
        let cancel = AtomicBool::new(false);
        let tracks = scan_frames(&finder, all.into_iter(), w, h, 10.0, 0.1, 0.8, &cancel, |_| {}).unwrap();
        assert_eq!(tracks.len(), 1, "{tracks:?}");
        let t = &tracks[0];
        assert_eq!(t.len(), 24, "every frame it was on screen");
        assert!((t[0].0 - 10.0).abs() < 1e-9);
        let (_, last) = t[t.len() - 1];
        assert!((last.cx - (20.0 + 23.0 * 6.0 + 20.0)).abs() < 3.0, "{last:?}");
    }
}
