//! Finds every place an object appears in a frame - by its look alone, anywhere, at a range of
//! sizes. "Find & hide" uses it: the user outlines something once (a logo, a picture on screen, a
//! name, a face) and it's found throughout the video, each appearance then followed and blurred,
//! covered or replaced.
//!
//! Zero-mean normalised cross-correlation of the object's appearance against every position of
//! the frame, coarse to fine: a small template over a much reduced frame finds candidates cheaply at
//! each size, then the best are scored again with a finer template over a less reduced frame, and
//! overlapping finds are merged (non-maximum suppression). NCC ignores brightness and contrast
//! changes, so the object is found under different lighting or a dimmed screen; it doesn't follow
//! rotation or a change of viewpoint - a different view of a 3D object is a different picture.
//! Integral images make each position's own normalisation cost the same whatever the template size.

use crate::GrayFrame;

/// One place the object was found, in the frame's own pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Detection {
    pub cx: f64,
    pub cy: f64,
    pub w: f64,
    pub h: f64,
    /// Fine NCC with the object, -1..1.
    pub score: f32,
}

// Template sizes (cells along the longer side) of the two passes, and how much of the frame the
// coarse pass keeps per template cell.
const COARSE_CELLS: f64 = 12.0;
const FINE_CELLS: f64 = 28.0;
// Candidates from the coarse pass at or above this go on to be refined.
const COARSE_ACCEPT: f32 = 0.55;
const MAX_CANDIDATES: usize = 64;
// Overlap (intersection over union) at which two finds are the same one.
const NMS_IOU: f64 = 0.3;

#[derive(Clone)]
struct Template {
    w: usize,
    h: usize,
    // Zero-mean, unit length.
    values: Vec<f32>,
}

// How much better (NCC) another size has to match before a followed box changes size.
const SIZE_CHANGE_MARGIN: f32 = 0.015;

/// The object's appearance, ready to search for.
pub struct Finder {
    // The box as picked, in its frame's pixels.
    w: f64,
    h: f64,
    coarse: Template,
    fine: Template,
    scales: Vec<f64>,
}

// Area-averaged resample of the box (x, y, w, h) of `frame` to tw x th.
fn resample_box(frame: GrayFrame, x: f64, y: f64, w: f64, h: f64, tw: usize, th: usize) -> Vec<f32> {
    let mut out = vec![0f32; tw * th];
    let (sx, sy) = (w / tw as f64, h / th as f64);
    for j in 0..th {
        let y0 = y + j as f64 * sy;
        for i in 0..tw {
            let x0 = x + i as f64 * sx;
            // Average a few samples across the cell (cheap box filter, enough against aliasing).
            let n = 3;
            let mut acc = 0f32;
            for b in 0..n {
                for a in 0..n {
                    let px = (x0 + (a as f64 + 0.5) / n as f64 * sx).clamp(0.0, frame.width as f64 - 1.0) as usize;
                    let py = (y0 + (b as f64 + 0.5) / n as f64 * sy).clamp(0.0, frame.height as f64 - 1.0) as usize;
                    acc += frame.data[py * frame.width + px] as f32;
                }
            }
            out[j * tw + i] = acc / (n * n) as f32;
        }
    }
    out
}

fn normalized(mut values: Vec<f32>) -> Option<Vec<f32>> {
    let n = values.len() as f32;
    let mean = values.iter().sum::<f32>() / n;
    let mut len = 0f32;
    for v in values.iter_mut() {
        *v -= mean;
        len += *v * *v;
    }
    let len = len.sqrt();
    // A flat patch (no detail) can't be told from anything else.
    if len < 2.0 * n.sqrt() {
        return None;
    }
    values.iter_mut().for_each(|v| *v /= len);
    Some(values)
}

fn template(frame: GrayFrame, x: f64, y: f64, w: f64, h: f64, cells: f64) -> Option<Template> {
    let long = w.max(h);
    let tw = ((w / long) * cells).round().max(3.0) as usize;
    let th = ((h / long) * cells).round().max(3.0) as usize;
    normalized(resample_box(frame, x, y, w, h, tw, th)).map(|values| Template { w: tw, h: th, values })
}

// The whole frame resampled by `factor` (< 1 shrinks), area averaged.
fn resample_frame(frame: GrayFrame, factor: f64) -> (Vec<f32>, usize, usize) {
    let w = ((frame.width as f64 * factor).round() as usize).max(1);
    let h = ((frame.height as f64 * factor).round() as usize).max(1);
    let img = resample_box(frame, 0.0, 0.0, frame.width as f64, frame.height as f64, w, h);
    (img, w, h)
}

// Integral images of the values and their squares, (w+1) x (h+1), for any rectangle's sum in O(1).
fn integrals(img: &[f32], w: usize, h: usize) -> (Vec<f64>, Vec<f64>) {
    let (mut s, mut s2) = (vec![0f64; (w + 1) * (h + 1)], vec![0f64; (w + 1) * (h + 1)]);
    for y in 0..h {
        let (mut row, mut row2) = (0f64, 0f64);
        for x in 0..w {
            let v = img[y * w + x] as f64;
            row += v;
            row2 += v * v;
            s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row;
            s2[(y + 1) * (w + 1) + x + 1] = s2[y * (w + 1) + x + 1] + row2;
        }
    }
    (s, s2)
}

// NCC of `t` with the image at top-left (x, y) - `sums` are the image's integrals.
#[inline]
fn ncc_at(img: &[f32], w: usize, sums: &(Vec<f64>, Vec<f64>), t: &Template, x: usize, y: usize) -> f32 {
    let mut dot = 0f32;
    for j in 0..t.h {
        let row = &img[(y + j) * w + x..(y + j) * w + x + t.w];
        let trow = &t.values[j * t.w..(j + 1) * t.w];
        for (a, b) in row.iter().zip(trow) {
            dot += a * b;
        }
    }
    let n = (t.w * t.h) as f64;
    let w1 = w + 1;
    let rect = |s: &Vec<f64>| s[(y + t.h) * w1 + x + t.w] - s[y * w1 + x + t.w] - s[(y + t.h) * w1 + x] + s[y * w1 + x];
    let (sum, sum2) = (rect(&sums.0), rect(&sums.1));
    let var = sum2 - sum * sum / n;
    if var < 4.0 * n {
        // A flat patch of the frame - no match, whatever the template.
        return 0.0;
    }
    // The template is zero-mean, so the image's mean drops out of the dot product.
    (dot as f64 / var.sqrt()) as f32
}

// Overlap of two boxes: intersection over union, and over the smaller box (1 when one lies inside
// the other).
fn overlaps(a: &Detection, b: &Detection) -> (f64, f64) {
    let ix = ((a.cx + a.w / 2.0).min(b.cx + b.w / 2.0) - (a.cx - a.w / 2.0).max(b.cx - b.w / 2.0)).max(0.0);
    let iy = ((a.cy + a.h / 2.0).min(b.cy + b.h / 2.0) - (a.cy - a.h / 2.0).max(b.cy - b.h / 2.0)).max(0.0);
    let inter = ix * iy;
    (inter / (a.w * a.h + b.w * b.h - inter).max(1e-9), inter / (a.w * a.h).min(b.w * b.h).max(1e-9))
}

// A find lying (mostly) inside a bigger one is a piece of the same thing - a detail of an object
// can look like a smaller copy of it (the middle of an X is an X) - so the whole is kept unless the
// piece matches clearly better.
const CONTAINED: f64 = 0.7;
const PIECE_MARGIN: f32 = 0.03;

/// Keeps the best of overlapping finds - and the whole over a piece of it.
pub fn suppress_overlaps(mut found: Vec<Detection>) -> Vec<Detection> {
    found.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for d in found {
        let mut absorbed = false;
        for k in kept.iter_mut() {
            let (iou, inside) = overlaps(k, &d);
            if iou >= NMS_IOU || inside >= CONTAINED {
                // The same thing: a clearly bigger find that matches nearly as well replaces a piece.
                if d.w * d.h > k.w * k.h * 1.5 && d.score >= k.score - PIECE_MARGIN {
                    *k = d;
                }
                absorbed = true;
                break;
            }
        }
        if !absorbed {
            kept.push(d);
        }
    }
    kept
}

// The coarse pass's candidates from every size, cut to the best distinct ones. Only near-identical
// boxes merge here: a candidate at the right size inside a bigger, wrong-sized one has to survive
// to be scored properly - whether the bigger one is the object or just contains it is for the fine
// pass to tell.
fn distinct_candidates(mut found: Vec<Detection>) -> Vec<Detection> {
    found.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for d in found {
        if !kept.iter().any(|k| overlaps(k, &d).0 >= CANDIDATE_SAME_IOU) {
            kept.push(d);
        }
        if kept.len() >= MAX_CANDIDATES {
            break;
        }
    }
    kept
}
const CANDIDATE_SAME_IOU: f64 = 0.6;

impl Finder {
    /// The object in the box (x, y, w, h) (top-left and size, pixels) of `frame`, to be searched
    /// for at sizes from `min_scale` to `max_scale` times its own. None for a box with no detail.
    pub fn new(frame: GrayFrame, x: f64, y: f64, w: f64, h: f64, min_scale: f64, max_scale: f64) -> Option<Finder> {
        let (w, h) = (w.max(6.0), h.max(6.0));
        let coarse = template(frame, x, y, w, h, COARSE_CELLS)?;
        let fine = template(frame, x, y, w, h, FINE_CELLS)?;
        let (lo, hi) = (min_scale.clamp(0.1, 1.0), max_scale.clamp(1.0, 10.0));
        let mut scales = Vec::new();
        let mut s = lo;
        while s <= hi * 1.0001 {
            scales.push(s);
            s *= 1.12;
        }
        if !scales.iter().any(|s| (s - 1.0).abs() < 0.03) {
            scales.push(1.0);
        }
        Some(Finder { w, h, coarse, fine, scales })
    }

    /// Every place the object is in `frame` with a fine match of at least `threshold` (0..1, ~0.75
    /// is a sure match), best first.
    pub fn find(&self, frame: GrayFrame, threshold: f32) -> Vec<Detection> {
        // Coarse pass, one size per worker thread: the frame shrunk so an object `s` times the picked
        // size is the coarse template's size, every position scored, the local peaks kept.
        let per_scale = |s: f64| -> Vec<Detection> {
            let long = self.w.max(self.h);
            let factor = (COARSE_CELLS / (long * s)).min(1.0);
            let t = &self.coarse;
            if frame.width as f64 * factor < t.w as f64 + 2.0 || frame.height as f64 * factor < t.h as f64 + 2.0 {
                return Vec::new();
            }
            let (img, w, h) = resample_frame(frame, factor);
            let sums = integrals(&img, w, h);
            let (cw, ch) = (w - t.w + 1, h - t.h + 1);
            let mut scores = vec![f32::MIN; cw * ch];
            for y in 0..ch {
                for x in 0..cw {
                    scores[y * cw + x] = ncc_at(&img, w, &sums, t, x, y);
                }
            }
            let mut local: Vec<Detection> = Vec::new();
            for y in 0..ch {
                for x in 0..cw {
                    let v = scores[y * cw + x];
                    if v < COARSE_ACCEPT {
                        continue;
                    }
                    // A peak: no neighbour scores higher.
                    let peak = (y.saturating_sub(1)..(y + 2).min(ch)).all(|yy| (x.saturating_sub(1)..(x + 2).min(cw)).all(|xx| scores[yy * cw + xx] <= v));
                    if peak {
                        local.push(Detection { cx: (x as f64 + t.w as f64 / 2.0) / factor, cy: (y as f64 + t.h as f64 / 2.0) / factor, w: self.w * s, h: self.h * s, score: v });
                    }
                }
            }
            suppress_overlaps(local).into_iter().take(MAX_CANDIDATES).collect()
        };
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(self.scales.len()).max(1);
        let mut candidates: Vec<Detection> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..threads)
                .map(|k| {
                    let per_scale = &per_scale;
                    let scales: Vec<f64> = self.scales.iter().copied().skip(k).step_by(threads).collect();
                    scope.spawn(move || scales.into_iter().flat_map(per_scale).collect::<Vec<_>>())
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        candidates = distinct_candidates(candidates);
        // Fine pass: each candidate re-scored at the finer template's resolution, nudged around its
        // spot and size; the likely ones then once more with the sampling grid shifted by half a
        // sample (a thin line falling between samples otherwise scores well below its true match).
        let mut found: Vec<Detection> = Vec::new();
        for c in candidates.into_iter().take(MAX_CANDIDATES) {
            if let Some(d) = self.refine(frame, c, false) {
                if d.score >= threshold - 0.15 {
                    let d = self.refine(frame, d, true).filter(|e| e.score > d.score).unwrap_or(d);
                    if d.score >= threshold {
                        found.push(d);
                    }
                }
            }
        }
        suppress_overlaps(found)
    }

    /// The largest box an appearance can have (its longer side at the largest size searched), in
    /// the picked frame's pixels.
    pub fn max_extent(&self) -> f64 {
        self.w.max(self.h) * self.scales.iter().copied().fold(1.0, f64::max)
    }

    /// The object near where it last was (`last`) - a cheap follow-up to `find` from one frame to
    /// the next: only the neighbourhood is searched, at about its last size.
    pub fn locate_near(&self, frame: GrayFrame, last: Detection) -> Option<Detection> {
        // Following: the size only changes when a new one is clearly better. Otherwise a pattern that
        // looks alike at slightly smaller scales (a cross, rings, text) scores a hair higher in a
        // smaller box every frame, and the box creeps inward until what it hides peeks out.
        let sizes = [0.94, 1.0, 1.06].map(|d| self.refine_at(frame, last, true, &[d]));
        let keep = sizes[1];
        let change = [sizes[0], sizes[2]].into_iter().flatten().max_by(|a, b| a.score.total_cmp(&b.score));
        match (keep, change) {
            (Some(k), Some(c)) if c.score > k.score + SIZE_CHANGE_MARGIN => Some(c),
            (Some(k), _) => Some(k),
            (None, c) => c,
        }
    }

    fn refine(&self, frame: GrayFrame, c: Detection, half_shifts: bool) -> Option<Detection> {
        self.refine_at(frame, c, half_shifts, &[0.94, 1.0, 1.06])
    }

    // The best match around `c` at each of `scales` (times its size).
    fn refine_at(&self, frame: GrayFrame, c: Detection, half_shifts: bool, scales: &[f64]) -> Option<Detection> {
        let t = &self.fine;
        let mut best: Option<Detection> = None;
        let shifts: &[(f64, f64)] = if half_shifts { &[(0.0, 0.0), (0.5, 0.0), (0.0, 0.5), (0.5, 0.5)] } else { &[(0.0, 0.0)] };
        for (ds, &(shx, shy)) in scales.iter().copied().flat_map(|d| shifts.iter().map(move |s| (d, s))) {
            let (w, h) = (c.w * ds, c.h * ds);
            // The neighbourhood (a box and a half around the candidate) on a grid of the template's
            // own cells, laid so the candidate box itself falls exactly on it - an unmoved object is
            // compared cell for cell with its template, not between grid points (which made a
            // slightly different size win by sampling luck). Half-cell shifts cover in between.
            let (cw, ch) = (w / t.w as f64, h / t.h as f64);
            let (mx, my) = ((t.w as f64 * 0.3).ceil() as usize, (t.h as f64 * 0.3).ceil() as usize);
            let (pw, ph) = (t.w + 2 * mx, t.h + 2 * my);
            let x0 = c.cx - (t.w as f64 / 2.0 + mx as f64 - shx) * cw;
            let y0 = c.cy - (t.h as f64 / 2.0 + my as f64 - shy) * ch;
            let img = resample_box(frame, x0, y0, pw as f64 * cw, ph as f64 * ch, pw, ph);
            let sums = integrals(&img, pw, ph);
            for y in 0..=ph - t.h {
                for x in 0..=pw - t.w {
                    let score = ncc_at(&img, pw, &sums, t, x, y);
                    if best.is_none_or(|b| score > b.score) {
                        best = Some(Detection { cx: x0 + (x as f64 + t.w as f64 / 2.0) * cw, cy: y0 + (y as f64 + t.h as f64 / 2.0) * ch, w, h, score });
                    }
                }
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A textured "logo" (deterministic noise blob) pasted into a noisy frame at given spots/sizes.
    fn logo(size: usize) -> Vec<u8> {
        let mut v = vec![0u8; size * size];
        for y in 0..size {
            for x in 0..size {
                let (u, w) = (x as f64 / size as f64, y as f64 / size as f64);
                let ring = ((u - 0.5).hypot(w - 0.5) * 18.0).sin();
                let bar = if (u * 6.0) as i32 % 2 == 0 { 60.0 } else { -40.0 };
                v[y * size + x] = (128.0 + 70.0 * ring + bar * (w - 0.5)).clamp(0.0, 255.0) as u8;
            }
        }
        v
    }

    fn scene(w: usize, h: usize, pastes: &[(usize, usize, usize)]) -> Vec<u8> {
        let mut seed = 11u32;
        let mut frame: Vec<u8> = (0..w * h)
            .map(|i| {
                seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
                (90 + ((i / w + i % w) % 40) as u32 + (seed >> 28)) as u8
            })
            .collect();
        for &(px, py, size) in pastes {
            let l = logo(size);
            for y in 0..size {
                for x in 0..size {
                    frame[(py + y) * w + px + x] = l[y * size + x];
                }
            }
        }
        frame
    }

    // A cross in a square - alike at slightly smaller scales, the case that used to shrink.
    fn cross(w: usize, h: usize, x0: usize, y0: usize, size: usize) -> Vec<u8> {
        let mut f = scene(w, h, &[]);
        for y in 0..size {
            for x in 0..size {
                let on = x.abs_diff(y) <= 1 || (x + y).abs_diff(size - 1) <= 1;
                f[(y0 + y) * w + x0 + x] = if on { 20 } else { 230 };
            }
        }
        f
    }

    #[test]
    fn following_keeps_the_size_of_what_it_follows() {
        let (w, h) = (320, 180);
        let f = cross(w, h, 100, 60, 40);
        let finder = Finder::new(GrayFrame { width: w, height: h, data: &f }, 100.0, 60.0, 40.0, 40.0, 0.5, 2.0).unwrap();
        let mut d = Detection { cx: 120.0, cy: 80.0, w: 40.0, h: 40.0, score: 1.0 };
        for _ in 0..40 {
            d = finder.locate_near(GrayFrame { width: w, height: h, data: &f }, d).unwrap();
        }
        assert!((d.w - 40.0).abs() < 1.5 && (d.cx - 120.0).abs() < 1.0 && (d.cy - 80.0).abs() < 1.0, "{d:?}");
    }

    #[test]
    fn following_still_follows_a_real_change_of_size() {
        // A logo coming closer: 60 px growing 1.5 px a frame to 90 px, centred on (160, 90).
        let (w, h) = (320, 180);
        let at = |size: usize| scene(w, h, &[(160 - size / 2, 90 - size / 2, size)]);
        let first = at(60);
        let finder = Finder::new(GrayFrame { width: w, height: h, data: &first }, 130.0, 60.0, 60.0, 60.0, 0.5, 2.0).unwrap();
        let mut d = Detection { cx: 160.0, cy: 90.0, w: 60.0, h: 60.0, score: 1.0 };
        for k in 1..=20 {
            let size = 60 + (k * 3) / 2;
            d = finder.locate_near(GrayFrame { width: w, height: h, data: &at(size) }, d).unwrap();
        }
        let big = at(90);
        for _ in 0..4 {
            d = finder.locate_near(GrayFrame { width: w, height: h, data: &big }, d).unwrap();
        }
        assert!((d.w - 90.0).abs() < 90.0 * 0.06 && (d.cx - 160.0).abs() < 2.0, "{d:?}");
    }

    #[test]
    fn finds_every_copy_at_its_size() {
        let (w, h) = (640, 360);
        // The picked copy (80 px), a second at the same size, a third at 1.5x.
        let data = scene(w, h, &[(40, 40, 80), (420, 60, 80), (300, 200, 120)]);
        let frame = GrayFrame { width: w, height: h, data: &data };
        let finder = Finder::new(frame, 40.0, 40.0, 80.0, 80.0, 0.5, 2.0).unwrap();
        let mut found = finder.find(frame, 0.75);
        found.sort_by(|a, b| a.cx.total_cmp(&b.cx));
        assert_eq!(found.len(), 3, "{found:?}");
        let want = [(80.0, 80.0, 80.0), (360.0, 260.0, 120.0), (460.0, 100.0, 80.0)];
        for (d, (cx, cy, size)) in found.iter().zip(want) {
            assert!((d.cx - cx).abs() < 5.0 && (d.cy - cy).abs() < 5.0, "{d:?} vs {cx},{cy}");
            assert!((d.w - size).abs() / size < 0.12, "{d:?} size vs {size}");
        }
    }

    #[test]
    fn ignores_brightness_and_finds_nothing_where_its_absent() {
        let (w, h) = (480, 270);
        let data = scene(w, h, &[(100, 80, 64)]);
        let frame = GrayFrame { width: w, height: h, data: &data };
        let finder = Finder::new(frame, 100.0, 80.0, 64.0, 64.0, 0.6, 1.6).unwrap();
        // Same scene, dimmed and with lower contrast: still found.
        let dim: Vec<u8> = data.iter().map(|&v| (v as f32 * 0.6 + 20.0) as u8).collect();
        let found = finder.find(GrayFrame { width: w, height: h, data: &dim }, 0.75);
        assert_eq!(found.len(), 1, "{found:?}");
        // A scene without it: nothing.
        let empty = scene(w, h, &[]);
        assert!(finder.find(GrayFrame { width: w, height: h, data: &empty }, 0.75).is_empty());
        // A flat box can't be searched for.
        let flat = vec![128u8; w * h];
        assert!(Finder::new(GrayFrame { width: w, height: h, data: &flat }, 10.0, 10.0, 50.0, 50.0, 0.5, 2.0).is_none());
    }

    #[test]
    #[ignore]
    fn search_speed() {
        let (w, h) = (960, 540);
        let data = scene(w, h, &[(100, 100, 90), (600, 300, 120)]);
        let frame = GrayFrame { width: w, height: h, data: &data };
        let finder = Finder::new(frame, 100.0, 100.0, 90.0, 90.0, 0.5, 2.0).unwrap();
        let t = std::time::Instant::now();
        for _ in 0..10 {
            assert_eq!(finder.find(frame, 0.75).len(), 2);
        }
        eprintln!("{:.1} ms per 960x540 frame", t.elapsed().as_secs_f64() * 100.0);
    }
}
