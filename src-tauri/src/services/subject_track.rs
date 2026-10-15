// services/subject_track.rs
//
// Where the action is in a video, for auto-reframe (Fill to another aspect ratio following the
// subject). Works on a small grayscale copy of the clip (ANALYSIS_SIZE square, ANALYSIS_FPS) piped
// out of ffmpeg - the aspect squash doesn't matter, everything here is in 0..1 fractions of the
// frame.
//
// Per frame, a saliency map: what MOVED since the previous frame (above a noise floor, so sensor
// noise and compression shimmer don't count), plus a faint share of edge detail as a prior for
// still moments. A scene cut (most of the picture changing at once) is flagged and its motion
// discarded - the cut itself isn't the subject. Each frame is kept as column and row energy
// profiles, which is all a crop window needs: the best window of any width is then a prefix-sum
// search (subject_samples), so one analysis serves every output shape.
//
// The camera work - smoothing, holding still, easing between positions - is the frontend's
// (reframeTrack.ts), which also fuses recorded clicks in and maps it all onto the output timeline.

use serde::{Deserialize, Serialize};

pub const ANALYSIS_SIZE: usize = 160;
pub const ANALYSIS_FPS: f64 = 6.0;
pub const BINS: usize = 40;

// Grey-level change below this is noise, not motion.
const MOTION_FLOOR: f32 = 6.0;
// Edge strength below this is texture/noise.
const EDGE_FLOOR: f32 = 20.0;
// How much edge detail counts against motion.
const EDGE_WEIGHT: f32 = 0.08;
// Mean absolute change (0..255) above which a frame is a cut.
const CUT_MEAN_DIFF: f32 = 30.0;
// Mean motion (per pixel) at which a frame's evidence is ~63% - saturating, so one small clear
// subject already counts and more motion only adds a little.
const CONFIDENCE_MOTION_SCALE: f64 = 0.5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameProfile {
    // Seconds from the analysed range's start.
    pub t: f64,
    pub cols: Vec<f32>,
    pub rows: Vec<f32>,
    // Mean motion per pixel - how much evidence this frame carries.
    pub motion: f32,
    pub cut: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubjectSample {
    pub t: f64,
    // Centre of the best crop window, 0..1 of the frame.
    pub x: f64,
    pub y: f64,
    // 0..1: how sure this frame is (motion present, and concentrated in the window).
    pub confidence: f64,
    pub cut: bool,
}

// Profiles for consecutive `size`x`size` gray frames.
pub fn profiles_from_gray(data: &[u8], size: usize, fps: f64) -> Vec<FrameProfile> {
    let frame_len = size * size;
    if size < 3 || frame_len == 0 {
        return Vec::new();
    }
    let bin = (size / BINS).max(1);
    let mut out = Vec::with_capacity(data.len() / frame_len);
    let mut previous: Option<&[u8]> = None;
    for (index, frame) in data.chunks_exact(frame_len).enumerate() {
        let mut cols = vec![0f32; BINS];
        let mut rows = vec![0f32; BINS];
        let mut motion_sum = 0f32;
        let mut diff_sum = 0f32;
        if let Some(prev) = previous {
            for (a, b) in frame.iter().zip(prev) {
                diff_sum += (*a as f32 - *b as f32).abs();
            }
        }
        let cut = previous.is_some() && diff_sum / frame_len as f32 > CUT_MEAN_DIFF;
        for y in 1..size - 1 {
            for x in 1..size - 1 {
                let i = y * size + x;
                let mut s = 0f32;
                if let (Some(prev), false) = (previous, cut) {
                    let m = (frame[i] as f32 - prev[i] as f32).abs() - MOTION_FLOOR;
                    if m > 0.0 {
                        s += m;
                        motion_sum += m;
                    }
                }
                let gx = (frame[i + 1] as f32 - frame[i - 1] as f32).abs();
                let gy = (frame[i + size] as f32 - frame[i - size] as f32).abs();
                let e = gx + gy - EDGE_FLOOR;
                if e > 0.0 {
                    s += EDGE_WEIGHT * e;
                }
                if s > 0.0 {
                    cols[(x / bin).min(BINS - 1)] += s;
                    rows[(y / bin).min(BINS - 1)] += s;
                }
            }
        }
        out.push(FrameProfile { t: index as f64 / fps, cols, rows, motion: motion_sum / frame_len as f32, cut });
        previous = Some(frame);
    }
    out
}

// The centre (0..1) of the window `width` (0..1) wide holding the most energy in `profile`, refined
// to the energy's centroid inside that window; and the share of all energy the window holds.
pub fn best_window(profile: &[f32], width: f64) -> (f64, f64) {
    let n = profile.len();
    let total: f64 = profile.iter().map(|v| *v as f64).sum();
    if n == 0 || total <= 0.0 || width >= 1.0 {
        return (0.5, if width >= 1.0 { 1.0 } else { 0.0 });
    }
    let width = width.max(1.0 / n as f64);
    // Energy in [0, u] (u in 0..1), linear within a bin.
    let mut prefix = vec![0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + profile[i] as f64;
    }
    let cumulative = |u: f64| {
        let pos = (u.clamp(0.0, 1.0)) * n as f64;
        let i = (pos.floor() as usize).min(n - 1);
        prefix[i] + (pos - i as f64) * profile[i] as f64
    };
    // Quarter-bin steps across every valid window start.
    let steps = ((1.0 - width) * n as f64 * 4.0).ceil().max(1.0) as usize;
    let mut best = (0.0f64, -1.0f64);
    for k in 0..=steps {
        let start = (1.0 - width) * k as f64 / steps as f64;
        let energy = cumulative(start + width) - cumulative(start);
        // Ties go to the window nearer the centre.
        let better = energy > best.1 + 1e-9 || ((energy - best.1).abs() <= 1e-9 && (start + width / 2.0 - 0.5).abs() < (best.0 + width / 2.0 - 0.5).abs());
        if better {
            best = (start, energy);
        }
    }
    let (start, energy) = best;
    // Centroid inside the window, for sub-bin precision.
    let mut weighted = 0.0;
    let mut mass = 0.0;
    for i in 0..n {
        let lo = (i as f64 / n as f64).max(start);
        let hi = ((i + 1) as f64 / n as f64).min(start + width);
        if hi > lo {
            let share = (hi - lo) * n as f64 * profile[i] as f64;
            weighted += share * (lo + hi) / 2.0;
            mass += share;
        }
    }
    let centre = if mass > 0.0 { weighted / mass } else { start + width / 2.0 };
    let half = width / 2.0;
    (centre.clamp(half, 1.0 - half), (energy / total).clamp(0.0, 1.0))
}

// One sample per frame: the best crop window of `crop_w` x `crop_h` (fractions of the frame).
pub fn subject_samples(profiles: &[FrameProfile], crop_w: f64, crop_h: f64) -> Vec<SubjectSample> {
    profiles
        .iter()
        .map(|p| {
            let (x, share_x) = best_window(&p.cols, crop_w);
            let (y, share_y) = best_window(&p.rows, crop_h);
            let evidence = 1.0 - (-(p.motion as f64) / CONFIDENCE_MOTION_SCALE).exp();
            // Only the axes that can actually move say anything about concentration.
            let share = match (crop_w < 0.999, crop_h < 0.999) {
                (true, true) => share_x.min(share_y),
                (true, false) => share_x,
                (false, true) => share_y,
                _ => 1.0,
            };
            SubjectSample { t: p.t, x, y, confidence: if p.cut { 0.0 } else { evidence * share }, cut: p.cut }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A dark frame with a bright square at (cx, cy) (pixels).
    fn frame(size: usize, cx: usize, cy: usize, half: usize) -> Vec<u8> {
        let mut f = vec![16u8; size * size];
        for y in cy.saturating_sub(half)..(cy + half).min(size) {
            for x in cx.saturating_sub(half)..(cx + half).min(size) {
                f[y * size + x] = 220;
            }
        }
        f
    }

    #[test]
    fn follows_a_moving_square() {
        let size = ANALYSIS_SIZE;
        let mut data = Vec::new();
        for i in 0..6 {
            data.extend(frame(size, 30 + i * 4, 40, 6));
        }
        let profiles = profiles_from_gray(&data, size, ANALYSIS_FPS);
        assert_eq!(profiles.len(), 6);
        let samples = subject_samples(&profiles, 0.3, 1.0);
        let last = samples.last().unwrap();
        // The square sits at x 50/160 = 0.31 by the last frame; motion spans its old and new edges.
        assert!((last.x - 50.0 / 160.0).abs() < 0.04, "x {}", last.x);
        assert!(last.confidence > 0.5, "confidence {}", last.confidence);
        assert!(!last.cut);
    }

    #[test]
    fn a_cut_is_flagged_and_carries_no_confidence() {
        let size = ANALYSIS_SIZE;
        let mut data = frame(size, 40, 40, 6);
        data.extend(vec![200u8; size * size]);
        let profiles = profiles_from_gray(&data, size, ANALYSIS_FPS);
        let samples = subject_samples(&profiles, 0.5, 1.0);
        assert!(samples[1].cut);
        assert_eq!(samples[1].confidence, 0.0);
    }

    #[test]
    fn best_window_is_clamped_inside_the_frame_and_centres_on_the_mass() {
        let mut p = vec![0f32; BINS];
        p[0] = 10.0;
        let (c, share) = best_window(&p, 0.4);
        assert!((c - 0.2).abs() < 1e-9);
        assert!((share - 1.0).abs() < 1e-9);
        let mut q = vec![0f32; BINS];
        q[20] = 5.0;
        q[21] = 5.0;
        let (c, _) = best_window(&q, 0.2);
        assert!((c - 0.525).abs() < 1e-6, "{c}");
        // Nothing to go on: centred.
        assert_eq!(best_window(&vec![0f32; BINS], 0.3).0, 0.5);
    }
}
