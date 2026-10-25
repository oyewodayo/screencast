//! Follows a picked region through a run of grayscale video frames - what Briefcast's motion
//! tracking pins text, stickers and blur regions to.
//!
//! Each step is Median Flow (Kalal, Mikolajczyk & Matas, 2010): a grid of points inside the box is
//! followed into the next frame with pyramidal Lucas-Kanade (Bouguet's formulation, sub-pixel),
//! then followed BACK; points whose round trip doesn't return home (forward-backward error) or
//! whose neighbourhood stopped looking alike (normalised cross-correlation) are dropped, and the
//! box moves by the median of what's left and scales by the median change in distance between
//! point pairs. Medians shrug off the points that landed on background or on something passing in
//! front. When the flow itself fails (occlusion, a cut, motion blur), the box is held and the
//! object is searched for by its appearance in the first frame, over a widening area and a range
//! of sizes, until it's found again.
//!
//! Nothing here knows about files, time or the editor: frames in, boxes out, in the frames' own
//! pixels. `smooth` takes the per-frame jitter out of a finished track.

mod finder;
pub use finder::{suppress_overlaps, Detection, Finder};

/// One grayscale frame, row-major, `width * height` bytes.
#[derive(Clone, Copy)]
pub struct GrayFrame<'a> {
    pub width: usize,
    pub height: usize,
    pub data: &'a [u8],
}

/// Where the tracked region is in one frame, in that frame's pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    /// Centre of the box.
    pub cx: f64,
    pub cy: f64,
    /// Size of the box (it scales as the object grows or shrinks on screen).
    pub w: f64,
    pub h: f64,
    /// 0..1: how sure this frame is - 0 while the object is lost (the box is then held).
    pub confidence: f64,
    pub lost: bool,
}

// Lucas-Kanade window radius (15x15) and iteration limits, per pyramid level.
const LK_RADIUS: i32 = 7;
const LK_MAX_ITERS: usize = 12;
const LK_EPSILON: f32 = 0.01;
// A window whose gradient matrix's smaller eigenvalue (per pixel) is below this has no texture to
// lock onto in some direction.
const LK_MIN_EIGEN: f32 = 1e-3 * 255.0 * 255.0 / 32.0;
// The coarsest level's shorter side is at least this many pixels.
const PYRAMID_MIN_SIDE: usize = 32;
const PYRAMID_MAX_LEVELS: usize = 4;
// Median Flow's grid of points, and its forward-backward error at which a step counts as failed.
const GRID: usize = 10;
const FB_FAIL_PX: f32 = 10.0;
// Tracked points' neighbourhoods normally correlate > 0.8 frame to frame; when even the median
// doesn't, the object has gone (covered, cut away) and the points are only following background.
const MIN_MEDIAN_NCC: f32 = 0.3;
const MIN_POINTS: usize = 4;
// NCC patch radius for each point (9x9).
const NCC_RADIUS: i32 = 4;
// Largest scale change accepted in one step, and overall.
const STEP_SCALE_LIMIT: f64 = 0.12;
const SCALE_RANGE: (f64, f64) = (0.15, 6.0);
// Appearance template: sampled on a grid with this many cells along its longer side.
const TEMPLATE_CELLS: usize = 24;
// Every this many tracked frames the box is checked against the object's own appearance nearby
// and pulled back onto it when that matches clearly better - flow alone slides slowly off a
// plain-coloured object (a dark suit, a wall) without ever "failing".
const ANCHOR_EVERY: usize = 4;
const ANCHOR_GAIN: f32 = 0.08;
// The coarse search's template grid, and how many of its best spots are refined.
const COARSE_TEMPLATE_CELLS: usize = 12;
const SEARCH_CANDIDATES: usize = 5;
// A candidate found by appearance search is accepted at or above this NCC with the template.
const REACQUIRE_NCC: f32 = 0.62;
// Mean absolute grey-level change between consecutive frames above which the picture has cut to
// another shot: whatever the box was on is gone, so it's searched for rather than followed.
const CUT_MEAN_DIFF: f64 = 30.0;

// Mean absolute difference of two frames, sampled on a coarse grid (cheap, and plenty for a cut).
fn mean_frame_diff(a: &[u8], b: &[u8]) -> f64 {
    let step = 7;
    let (mut sum, mut n) = (0u64, 0u64);
    let mut i = 0;
    while i < a.len().min(b.len()) {
        sum += (a[i] as i32 - b[i] as i32).unsigned_abs() as u64;
        n += 1;
        i += step;
    }
    if n == 0 { 0.0 } else { sum as f64 / n as f64 }
}

// Extra room around the region a step needs, so the next step can usually reuse its pyramid.
const REGION_PAD: f64 = 48.0;
// Consecutive frames of the box looking nothing like the object before flow is distrusted.
const DRIFT_NCC: f32 = 0.15;
const DRIFT_FRAMES: usize = 8;

struct Level {
    w: usize,
    h: usize,
    img: Vec<f32>,
    gx: Vec<f32>,
    gy: Vec<f32>,
}

struct Pyramid {
    levels: Vec<Level>,
}

impl Level {
    fn new(w: usize, h: usize, img: Vec<f32>) -> Level {
        let (gx, gy) = scharr(&img, w, h);
        Level { w, h, img, gx, gy }
    }

    // Bilinear sample of `buf` (one of this level's images) at (x, y), clamped to the edges.
    #[inline]
    fn sample(&self, buf: &[f32], x: f32, y: f32) -> f32 {
        let x = x.clamp(0.0, (self.w - 1) as f32 - 1e-3);
        let y = y.clamp(0.0, (self.h - 1) as f32 - 1e-3);
        let (x0, y0) = (x as usize, y as usize);
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let i = y0 * self.w + x0;
        let top = buf[i] + (buf[i + 1] - buf[i]) * fx;
        let bottom = buf[i + self.w] + (buf[i + self.w + 1] - buf[i + self.w]) * fx;
        top + (bottom - top) * fy
    }
}

// The (2r+1)^2 window of `buf` centred on (x, y), bilinearly sampled, into `out` (row-major). Every
// pixel of the window shares (x, y)'s sub-pixel offset, so the four weights are worked out once; a
// window touching the border falls back to clamped samples.
#[inline]
fn gather(level: &Level, buf: &[f32], x: f32, y: f32, r: i32, out: &mut [f32]) {
    let (xf, yf) = (x.floor(), y.floor());
    let (x0, y0) = (xf as i64, yf as i64);
    let r64 = r as i64;
    if x0 - r64 >= 0 && y0 - r64 >= 0 && x0 + r64 + 1 < level.w as i64 && y0 + r64 + 1 < level.h as i64 {
        let (fx, fy) = (x - xf, y - yf);
        let (w00, w10, w01, w11) = ((1.0 - fx) * (1.0 - fy), fx * (1.0 - fy), (1.0 - fx) * fy, fx * fy);
        let stride = level.w;
        let mut k = 0;
        for dy in -r64..=r64 {
            let row = (y0 + dy) as usize * stride;
            for dx in -r64..=r64 {
                let i = row + (x0 + dx) as usize;
                out[k] = w00 * buf[i] + w10 * buf[i + 1] + w01 * buf[i + stride] + w11 * buf[i + stride + 1];
                k += 1;
            }
        }
    } else {
        let mut k = 0;
        for dy in -r..=r {
            for dx in -r..=r {
                out[k] = level.sample(buf, x + dx as f32, y + dy as f32);
                k += 1;
            }
        }
    }
}

// Scharr derivative (scaled to the image's own units per pixel), edges replicated. The interior is
// plain indexing; only the one-pixel border goes through the clamped lookup.
fn scharr(img: &[f32], w: usize, h: usize) -> (Vec<f32>, Vec<f32>) {
    let mut gx = vec![0f32; w * h];
    let mut gy = vec![0f32; w * h];
    if w < 3 || h < 3 {
        return (gx, gy);
    }
    for y in 1..h - 1 {
        let (up, row, down) = (&img[(y - 1) * w..y * w], &img[y * w..(y + 1) * w], &img[(y + 1) * w..(y + 2) * w]);
        let (ox, oy) = (&mut gx[y * w..(y + 1) * w], &mut gy[y * w..(y + 1) * w]);
        for x in 1..w - 1 {
            ox[x] = (3.0 * (up[x + 1] - up[x - 1]) + 10.0 * (row[x + 1] - row[x - 1]) + 3.0 * (down[x + 1] - down[x - 1])) * (1.0 / 32.0);
            oy[x] = (3.0 * (down[x - 1] - up[x - 1]) + 10.0 * (down[x] - up[x]) + 3.0 * (down[x + 1] - up[x + 1])) * (1.0 / 32.0);
        }
    }
    let at = |x: isize, y: isize| -> f32 { img[(y.clamp(0, h as isize - 1) as usize) * w + x.clamp(0, w as isize - 1) as usize] };
    let mut edge = |x: isize, y: isize| {
        let i = y as usize * w + x as usize;
        gx[i] = (3.0 * (at(x + 1, y - 1) - at(x - 1, y - 1)) + 10.0 * (at(x + 1, y) - at(x - 1, y)) + 3.0 * (at(x + 1, y + 1) - at(x - 1, y + 1))) / 32.0;
        gy[i] = (3.0 * (at(x - 1, y + 1) - at(x - 1, y - 1)) + 10.0 * (at(x, y + 1) - at(x, y - 1)) + 3.0 * (at(x + 1, y + 1) - at(x + 1, y - 1))) / 32.0;
    };
    for x in 0..w as isize {
        edge(x, 0);
        edge(x, h as isize - 1);
    }
    for y in 1..h as isize - 1 {
        edge(0, y);
        edge(w as isize - 1, y);
    }
    (gx, gy)
}

// Half-size with a 5-tap binomial low-pass first, so the coarse levels don't alias.
fn downsample(img: &[f32], w: usize, h: usize) -> (Vec<f32>, usize, usize) {
    let (nw, nh) = (w.div_ceil(2), h.div_ceil(2));
    const K: [f32; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];
    // Horizontal pass at every other column, then vertical at every other row.
    let mut tmp = vec![0f32; nw * h];
    for y in 0..h {
        let row = &img[y * w..(y + 1) * w];
        for nx in 0..nw {
            let cx = (2 * nx) as isize;
            let mut acc = 0f32;
            for (k, kv) in K.iter().enumerate() {
                acc += kv * row[(cx + k as isize - 2).clamp(0, w as isize - 1) as usize];
            }
            tmp[y * nw + nx] = acc;
        }
    }
    let mut out = vec![0f32; nw * nh];
    for ny in 0..nh {
        let cy = (2 * ny) as isize;
        for nx in 0..nw {
            let mut acc = 0f32;
            for (k, kv) in K.iter().enumerate() {
                acc += kv * tmp[(cy + k as isize - 2).clamp(0, h as isize - 1) as usize * nw + nx];
            }
            out[ny * nw + nx] = acc;
        }
    }
    (out, nw, nh)
}

impl Pyramid {
    fn build(frame: GrayFrame) -> Pyramid {
        Pyramid::build_roi(frame, (0, 0, frame.width, frame.height))
    }

    // The pyramid of just the region (x, y, w, h) of the frame - coordinates in it are then
    // relative to (x, y).
    fn build_roi(frame: GrayFrame, (x0, y0, w, h): (usize, usize, usize, usize)) -> Pyramid {
        let mut base: Vec<f32> = Vec::with_capacity(w * h);
        for y in y0..y0 + h {
            base.extend(frame.data[y * frame.width + x0..y * frame.width + x0 + w].iter().map(|&v| v as f32));
        }
        let mut levels = vec![Level::new(w, h, base)];
        while levels.len() < PYRAMID_MAX_LEVELS {
            let last = levels.last().unwrap();
            if last.w.min(last.h) / 2 < PYRAMID_MIN_SIDE {
                break;
            }
            let (img, w, h) = downsample(&last.img, last.w, last.h);
            levels.push(Level::new(w, h, img));
        }
        Pyramid { levels }
    }

    fn base(&self) -> &Level {
        &self.levels[0]
    }
}

// Pyramidal Lucas-Kanade: where point `p` of `from` went in `to`, starting from the guess that it
// moved by `guess`. None when the window has no texture or the point leaves the frame.
fn lk(from: &Pyramid, to: &Pyramid, p: (f32, f32), guess: (f32, f32)) -> Option<(f32, f32)> {
    let top = from.levels.len().min(to.levels.len()) - 1;
    let n = ((2 * LK_RADIUS + 1) * (2 * LK_RADIUS + 1)) as usize;
    let mut tpl = [0f32; 225];
    let mut tgx = [0f32; 225];
    let mut tgy = [0f32; 225];
    let mut cur = [0f32; 225];
    debug_assert_eq!(n, 225);
    let scale0 = (1u32 << top) as f32;
    let mut g = (guess.0 / scale0, guess.1 / scale0);
    for l in (0..=top).rev() {
        let (fl, tl) = (&from.levels[l], &to.levels[l]);
        let s = 1.0 / (1u32 << l) as f32;
        let (px, py) = (p.0 * s, p.1 * s);
        gather(fl, &fl.img, px, py, LK_RADIUS, &mut tpl);
        gather(fl, &fl.gx, px, py, LK_RADIUS, &mut tgx);
        gather(fl, &fl.gy, px, py, LK_RADIUS, &mut tgy);
        let (mut gxx, mut gxy, mut gyy) = (0f32, 0f32, 0f32);
        for k in 0..n {
            gxx += tgx[k] * tgx[k];
            gxy += tgx[k] * tgy[k];
            gyy += tgy[k] * tgy[k];
        }
        let det = gxx * gyy - gxy * gxy;
        let min_eigen = ((gxx + gyy) - ((gxx - gyy) * (gxx - gyy) + 4.0 * gxy * gxy).sqrt()) / (2.0 * n as f32);
        if det.abs() < 1e-6 || min_eigen < LK_MIN_EIGEN {
            if l == 0 {
                return None;
            }
            g = (g.0 * 2.0, g.1 * 2.0);
            continue;
        }
        let (a, b, c) = (gyy / det, -gxy / det, gxx / det);
        let mut v = (0f32, 0f32);
        for _ in 0..LK_MAX_ITERS {
            gather(tl, &tl.img, px + g.0 + v.0, py + g.1 + v.1, LK_RADIUS, &mut cur);
            let (mut bx, mut by) = (0f32, 0f32);
            for k in 0..n {
                let diff = tpl[k] - cur[k];
                bx += diff * tgx[k];
                by += diff * tgy[k];
            }
            let eta = (a * bx + b * by, b * bx + c * by);
            v = (v.0 + eta.0, v.1 + eta.1);
            if eta.0 * eta.0 + eta.1 * eta.1 < LK_EPSILON * LK_EPSILON {
                break;
            }
        }
        g = if l > 0 { ((g.0 + v.0) * 2.0, (g.1 + v.1) * 2.0) } else { (g.0 + v.0, g.1 + v.1) };
    }
    let q = (p.0 + g.0, p.1 + g.1);
    let base = to.base();
    let inside = q.0 >= 0.0 && q.1 >= 0.0 && q.0 <= (base.w - 1) as f32 && q.1 <= (base.h - 1) as f32;
    (inside && q.0.is_finite() && q.1.is_finite()).then_some(q)
}

// Zero-mean normalised cross-correlation of the NCC_RADIUS patches around `p` in `a` and `q` in `b`.
fn patch_ncc(a: &Level, p: (f32, f32), b: &Level, q: (f32, f32)) -> f32 {
    let n = ((2 * NCC_RADIUS + 1) * (2 * NCC_RADIUS + 1)) as f32;
    let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0f32, 0f32, 0f32, 0f32, 0f32);
    for dy in -NCC_RADIUS..=NCC_RADIUS {
        for dx in -NCC_RADIUS..=NCC_RADIUS {
            let va = a.sample(&a.img, p.0 + dx as f32, p.1 + dy as f32);
            let vb = b.sample(&b.img, q.0 + dx as f32, q.1 + dy as f32);
            sa += va;
            sb += vb;
            saa += va * va;
            sbb += vb * vb;
            sab += va * vb;
        }
    }
    let cov = sab - sa * sb / n;
    let var = ((saa - sa * sa / n) * (sbb - sb * sb / n)).max(0.0).sqrt();
    if var < 1e-3 { 0.0 } else { cov / var }
}

fn median(values: &mut [f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = values.len() / 2;
    if values.len() % 2 == 1 { values[m] } else { 0.5 * (values[m - 1] + values[m]) }
}

// The object's appearance on a small grid (TEMPLATE_CELLS along its longer side), zero-mean and
// unit-length, sampled from a box of a level.
struct Template {
    gw: usize,
    gh: usize,
    values: Vec<f32>,
}

impl Template {
    fn grid(w: f64, h: f64, cells: usize) -> (usize, usize) {
        let long = w.max(h).max(1e-6);
        let gw = ((w / long) * cells as f64).round().max(4.0) as usize;
        let gh = ((h / long) * cells as f64).round().max(4.0) as usize;
        (gw, gh)
    }

    // Samples the box centred (cx, cy) of size (w, h) - level-0 pixels - from `level`.
    fn sample(level: &Level, l: usize, cx: f64, cy: f64, w: f64, h: f64, gw: usize, gh: usize) -> Option<Vec<f32>> {
        let s = 1.0 / (1u32 << l) as f64;
        let mut values = Vec::with_capacity(gw * gh);
        for j in 0..gh {
            for i in 0..gw {
                let x = (cx + ((i as f64 + 0.5) / gw as f64 - 0.5) * w) * s;
                let y = (cy + ((j as f64 + 0.5) / gh as f64 - 0.5) * h) * s;
                values.push(level.sample(&level.img, x as f32, y as f32));
            }
        }
        normalize(&mut values).then_some(values)
    }

    fn capture(pyr: &Pyramid, cx: f64, cy: f64, w: f64, h: f64, cells: usize) -> Option<Template> {
        let (gw, gh) = Template::grid(w, h, cells);
        Template::sample(pyr.base(), 0, cx, cy, w, h, gw, gh).map(|values| Template { gw, gh, values })
    }

    fn ncc(&self, other: &[f32]) -> f32 {
        self.values.iter().zip(other).map(|(a, b)| a * b).sum()
    }
}

// Zero-mean, unit-length in place; false for a flat patch (nothing to match).
fn normalize(values: &mut [f32]) -> bool {
    let n = values.len() as f32;
    let mean = values.iter().sum::<f32>() / n;
    let mut len = 0f32;
    for v in values.iter_mut() {
        *v -= mean;
        len += *v * *v;
    }
    let len = len.sqrt();
    if len < 1e-3 {
        return false;
    }
    for v in values.iter_mut() {
        *v /= len;
    }
    true
}

pub struct Tracker {
    // The previous frame, raw: each step builds pyramids of just the region around the object.
    prev: Vec<u8>,
    fw: usize,
    fh: usize,
    // The last frame's pyramid over a padded region - the next step's "previous" pyramid as long
    // as the object is still well inside it, so most steps build only one pyramid.
    cache: Option<(Pyramid, (usize, usize, usize, usize))>,
    cx: f64,
    cy: f64,
    w: f64,
    h: f64,
    // The box's size when picked: scale is relative to it.
    w0: f64,
    h0: f64,
    // Last step's motion, as the next step's starting guess (objects keep moving the way they were).
    velocity: (f32, f32),
    template: Option<Template>,
    // The same appearance on a coarser grid, for the wide first pass of a search.
    coarse: Option<Template>,
    lost: bool,
    lost_frames: usize,
    drift_frames: usize,
    tracked_frames: usize,
    last: Sample,
}

impl Tracker {
    /// Starts tracking the box centred (cx, cy) of size (w, h) in `frame`.
    pub fn new(frame: GrayFrame, cx: f64, cy: f64, w: f64, h: f64) -> Tracker {
        let (w, h) = (w.max(4.0), h.max(4.0));
        let pyramid = Pyramid::build(frame);
        let template = Template::capture(&pyramid, cx, cy, w, h, TEMPLATE_CELLS);
        let coarse = Template::capture(&pyramid, cx, cy, w, h, COARSE_TEMPLATE_CELLS);
        let last = Sample { cx, cy, w, h, confidence: 1.0, lost: false };
        let prev = frame.data[..frame.width * frame.height].to_vec();
        Tracker { prev, fw: frame.width, fh: frame.height, cache: None, cx, cy, w, h, w0: w, h0: h, velocity: (0.0, 0.0), template, coarse, lost: false, lost_frames: 0, drift_frames: 0, tracked_frames: 0, last }
    }

    /// The box as it was last found (or held, while lost).
    pub fn current(&self) -> Sample {
        self.last
    }

    /// Follows the box into the next frame.
    pub fn advance(&mut self, frame: GrayFrame) -> Sample {
        let cut = frame.width == self.fw && frame.height == self.fh && mean_frame_diff(&self.prev, &frame.data[..frame.width * frame.height]) > CUT_MEAN_DIFF;
        if cut && !self.lost {
            self.lose();
        }
        let sample = if self.lost || frame.width != self.fw || frame.height != self.fh {
            let full = Pyramid::build(frame);
            let sample = self.reacquire(&full);
            self.cache = Some((full, (0, 0, frame.width, frame.height)));
            sample
        } else {
            self.flow(frame)
        };
        self.prev.clear();
        self.prev.extend_from_slice(&frame.data[..frame.width * frame.height]);
        (self.fw, self.fh) = (frame.width, frame.height);
        self.last = sample;
        sample
    }

    // The part of the frame a step can need: the box, room for it to move and grow, and the
    // coarsest level's Lucas-Kanade window. Clamped to the frame.
    fn region(&self, pad: f64) -> (usize, usize, usize, usize) {
        let speed = (self.velocity.0.abs().max(self.velocity.1.abs())) as f64;
        let margin = self.w.max(self.h) * 0.75 + 3.0 * speed + ((LK_RADIUS as f64 + 2.0) * (1u32 << (PYRAMID_MAX_LEVELS - 1)) as f64) + pad;
        let x0 = (self.cx - self.w / 2.0 - margin).floor().clamp(0.0, self.fw as f64 - 1.0) as usize;
        let y0 = (self.cy - self.h / 2.0 - margin).floor().clamp(0.0, self.fh as f64 - 1.0) as usize;
        let x1 = (self.cx + self.w / 2.0 + margin).ceil().clamp(x0 as f64 + 1.0, self.fw as f64) as usize;
        let y1 = (self.cy + self.h / 2.0 + margin).ceil().clamp(y0 as f64 + 1.0, self.fh as f64) as usize;
        (x0, y0, x1 - x0, y1 - y0)
    }

    fn flow(&mut self, frame: GrayFrame) -> Sample {
        let (sample, next) = self.flow_step(frame);
        self.cache = Some(next);
        sample
    }

    fn flow_step(&mut self, frame: GrayFrame) -> (Sample, (Pyramid, (usize, usize, usize, usize))) {
        let need = self.region(0.0);
        let contains = |r: (usize, usize, usize, usize)| r.0 <= need.0 && r.1 <= need.1 && r.0 + r.2 >= need.0 + need.2 && r.1 + r.3 >= need.1 + need.3;
        let (prev, roi) = match self.cache.take() {
            Some((pyramid, r)) if contains(r) => (pyramid, r),
            _ => {
                let r = self.region(REGION_PAD);
                (Pyramid::build_roi(GrayFrame { width: self.fw, height: self.fh, data: &self.prev }, r), r)
            }
        };
        let next_pyramid = Pyramid::build_roi(frame, roi);
        let next = &next_pyramid;
        let (ox, oy) = (roi.0 as f64, roi.1 as f64);
        let base = prev.base();
        // The grid, inset a little so points sit on the object rather than its outline.
        let mut points: Vec<(f32, f32)> = Vec::with_capacity(GRID * GRID);
        let (iw, ih) = (self.w * 0.8, self.h * 0.8);
        let cells = GRID.min((iw.min(ih) / 2.0).max(2.0) as usize).max(2);
        for j in 0..cells {
            for i in 0..cells {
                let x = self.cx - ox + ((i as f64 + 0.5) / cells as f64 - 0.5) * iw;
                let y = self.cy - oy + ((j as f64 + 0.5) / cells as f64 - 0.5) * ih;
                if x >= 0.0 && y >= 0.0 && x < base.w as f64 && y < base.h as f64 {
                    points.push((x as f32, y as f32));
                }
            }
        }
        // Forward, back again, and how alike each point's neighbourhood stayed.
        let mut tracked: Vec<((f32, f32), (f32, f32), f32, f32)> = Vec::with_capacity(points.len());
        for &p in &points {
            let Some(q) = lk(&prev, next, p, self.velocity) else { continue };
            let Some(back) = lk(next, &prev, q, (-self.velocity.0, -self.velocity.1)) else { continue };
            let fb = ((back.0 - p.0).powi(2) + (back.1 - p.1).powi(2)).sqrt();
            let ncc = patch_ncc(base, p, next.base(), q);
            tracked.push((p, q, fb, ncc));
        }
        if tracked.len() < MIN_POINTS {
            return (self.lose(), (next_pyramid, roi));
        }
        let med_fb = median(&mut tracked.iter().map(|t| t.2).collect::<Vec<_>>());
        let med_ncc = median(&mut tracked.iter().map(|t| t.3).collect::<Vec<_>>());
        let kept: Vec<_> = tracked.iter().filter(|t| t.2 <= med_fb && t.3 >= med_ncc).collect();
        if kept.len() < MIN_POINTS || med_fb > FB_FAIL_PX || med_ncc < MIN_MEDIAN_NCC {
            return (self.lose(), (next_pyramid, roi));
        }
        let dx = median(&mut kept.iter().map(|t| t.1 .0 - t.0 .0).collect::<Vec<_>>());
        let dy = median(&mut kept.iter().map(|t| t.1 .1 - t.0 .1).collect::<Vec<_>>());
        // Scale: the median change in distance between pairs of points.
        let mut ratios: Vec<f32> = Vec::with_capacity(kept.len() * kept.len() / 2);
        for a in 0..kept.len() {
            for b in a + 1..kept.len() {
                let d0 = ((kept[a].0 .0 - kept[b].0 .0).powi(2) + (kept[a].0 .1 - kept[b].0 .1).powi(2)).sqrt();
                let d1 = ((kept[a].1 .0 - kept[b].1 .0).powi(2) + (kept[a].1 .1 - kept[b].1 .1).powi(2)).sqrt();
                if d0 > 2.0 {
                    ratios.push(d1 / d0);
                }
            }
        }
        let step_scale = if ratios.len() >= 6 { (median(&mut ratios) as f64).clamp(1.0 - STEP_SCALE_LIMIT, 1.0 + STEP_SCALE_LIMIT) } else { 1.0 };
        let scale = (self.w * step_scale / self.w0).clamp(SCALE_RANGE.0, SCALE_RANGE.1);
        self.cx += dx as f64;
        self.cy += dy as f64;
        self.w = self.w0 * scale;
        self.h = self.h0 * scale;
        self.velocity = (dx, dy);
        // The flow can slide off onto the background without ever failing - if the box stops
        // looking like the object for long, the flow isn't trusted any more.
        if let Some(t) = &self.template {
            let now = Template::sample(next.base(), 0, self.cx - ox, self.cy - oy, self.w, self.h, t.gw, t.gh).map(|v| t.ncc(&v)).unwrap_or(0.0);
            self.drift_frames = if now < DRIFT_NCC { self.drift_frames + 1 } else { 0 };
            if self.drift_frames >= DRIFT_FRAMES {
                self.drift_frames = 0;
                return (self.lose(), (next_pyramid, roi));
            }
        }
        // Pull back onto the object's appearance when the flow has slid off it.
        self.tracked_frames += 1;
        if self.tracked_frames % ANCHOR_EVERY == 0 {
            if let Some(t) = &self.template {
                let base = next.base();
                let (lx, ly) = (self.cx - ox, self.cy - oy);
                let at = |x: f64, y: f64| Template::sample(base, 0, x, y, self.w, self.h, t.gw, t.gh).map(|v| t.ncc(&v));
                if let Some(here) = at(lx, ly) {
                    let (rx, ry) = (self.w * 0.25, self.h * 0.25);
                    let stride = (self.w.min(self.h) / 24.0).max(1.0);
                    let mut best = (here, lx, ly);
                    let (nx, ny) = ((rx / stride) as i64, (ry / stride) as i64);
                    for j in -ny..=ny {
                        for i in -nx..=nx {
                            let (x, y) = (lx + i as f64 * stride, ly + j as f64 * stride);
                            if let Some(score) = at(x, y) {
                                if score > best.0 {
                                    best = (score, x, y);
                                }
                            }
                        }
                    }
                    if best.0 > here + ANCHOR_GAIN && best.0 > 0.5 {
                        // Half way there - a correction, not a jump.
                        self.cx += (best.1 - lx) * 0.5;
                        self.cy += (best.2 - ly) * 0.5;
                    }
                }
            }
        }
        let agreement = kept.len() as f64 / tracked.len().max(1) as f64;
        let confidence = ((1.0 - med_fb as f64 / FB_FAIL_PX as f64).clamp(0.0, 1.0) * (0.5 + agreement)).clamp(0.05, 1.0);
        (Sample { cx: self.cx, cy: self.cy, w: self.w, h: self.h, confidence, lost: false }, (next_pyramid, roi))
    }

    fn lose(&mut self) -> Sample {
        self.lost = true;
        self.lost_frames = 0;
        self.velocity = (0.0, 0.0);
        Sample { cx: self.cx, cy: self.cy, w: self.w, h: self.h, confidence: 0.0, lost: true }
    }

    // Looks for the object by its appearance around where it was last seen - wider the longer
    // it's been gone - over a range of sizes. Every frame for the first few, then every third.
    // Coarse to fine: a wide scan on a coarse pyramid level with a small template keeps the best
    // few spots, and only those are searched at full resolution with the full template.
    fn reacquire(&mut self, next: &Pyramid) -> Sample {
        self.lost_frames += 1;
        let held = Sample { cx: self.cx, cy: self.cy, w: self.w, h: self.h, confidence: 0.0, lost: true };
        let (Some(t), Some(coarse)) = (&self.template, &self.coarse) else { return held };
        if self.lost_frames > 6 && self.lost_frames % 3 != 0 {
            return held;
        }
        let base = next.base();
        let radius = (self.w.max(self.h) * (1.5 + 0.25 * self.lost_frames.min(24) as f64)).min(base.w.max(base.h) as f64);
        // (score, cx, cy, scale), best first.
        let mut top: Vec<(f32, f64, f64, f64)> = Vec::with_capacity(SEARCH_CANDIDATES + 1);
        for &s in &[0.85, 1.0, 1.18] {
            let (w, h) = (self.w * s, self.h * s);
            // The coarsest level the box still spans ~8 pixels on.
            let mut l = 0;
            while l + 1 < next.levels.len() && w.min(h) / (1u32 << (l + 1)) as f64 >= 8.0 {
                l += 1;
            }
            let step = (1u32 << l) as f64;
            let n = (radius / step).ceil() as i64;
            for j in -n..=n {
                for i in -n..=n {
                    let (cx, cy) = (self.cx + i as f64 * step, self.cy + j as f64 * step);
                    if cx < 0.0 || cy < 0.0 || cx >= base.w as f64 || cy >= base.h as f64 {
                        continue;
                    }
                    let Some(v) = Template::sample(&next.levels[l], l, cx, cy, w, h, coarse.gw, coarse.gh) else { continue };
                    // Nearer where it was last seen is likelier: a far look-alike must match better.
                    let far = (((i * i + j * j) as f64).sqrt() * step / radius.max(1.0)) as f32;
                    let score = coarse.ncc(&v) - 0.12 * far;
                    if top.len() < SEARCH_CANDIDATES || score > top[top.len() - 1].0 {
                        // Neighbours of a better spot are the same find, not another candidate.
                        if let Some(k) = top.iter().position(|c| (c.1 - cx).abs() <= 2.0 * step && (c.2 - cy).abs() <= 2.0 * step) {
                            if score > top[k].0 {
                                top[k] = (score, cx, cy, s);
                            }
                        } else {
                            top.push((score, cx, cy, s));
                        }
                        top.sort_by(|a, b| b.0.total_cmp(&a.0));
                        top.truncate(SEARCH_CANDIDATES);
                    }
                }
            }
        }
        // Each candidate refined at full resolution: within its coarse step, then to half a pixel.
        let mut best: (f32, f64, f64, f64) = (f32::MIN, self.cx, self.cy, 1.0);
        for &(_, ccx, ccy, s) in &top {
            let (w, h) = (self.w * s, self.h * s);
            let mut here = (f32::MIN, ccx, ccy);
            for (reach, stride) in [(6.0f64, 2.0f64), (2.0, 0.5)] {
                let (ox, oy) = (here.1, here.2);
                let k = (reach / stride) as i64;
                for j in -k..=k {
                    for i in -k..=k {
                        let (cx, cy) = (ox + i as f64 * stride, oy + j as f64 * stride);
                        if let Some(v) = Template::sample(base, 0, cx, cy, w, h, t.gw, t.gh) {
                            let score = t.ncc(&v);
                            if score > here.0 {
                                here = (score, cx, cy);
                            }
                        }
                    }
                }
            }
            let far = (((here.1 - self.cx).powi(2) + (here.2 - self.cy).powi(2)).sqrt() / radius.max(1.0)) as f32;
            if here.0 - 0.12 * far > best.0 - 0.12 * ((((best.1 - self.cx).powi(2) + (best.2 - self.cy).powi(2)).sqrt() / radius.max(1.0)) as f32) || best.0 == f32::MIN {
                best = (here.0, here.1, here.2, s);
            }
        }
        if best.0 < REACQUIRE_NCC {
            return held;
        }
        self.cx = best.1;
        self.cy = best.2;
        self.w *= best.3;
        self.h *= best.3;
        self.lost = false;
        self.drift_frames = 0;
        Sample { cx: self.cx, cy: self.cy, w: self.w, h: self.h, confidence: (best.0 as f64).clamp(0.05, 1.0) * 0.8, lost: false }
    }
}

/// Takes the frame-to-frame jitter out of a finished track: a Gaussian over time (`sigma_pos`
/// frames for the position, `sigma_size` for the size), within each run of found frames - never
/// across a lost stretch, so a re-acquired object doesn't drag the frames before it.
pub fn smooth(samples: &mut [Sample], sigma_pos: f64, sigma_size: f64) {
    let mut start = 0;
    while start < samples.len() {
        if samples[start].lost {
            start += 1;
            continue;
        }
        let mut end = start;
        while end < samples.len() && !samples[end].lost {
            end += 1;
        }
        let run = &mut samples[start..end];
        let original: Vec<Sample> = run.to_vec();
        let pass = |sigma: f64, value: &dyn Fn(&Sample) -> f64| -> Vec<f64> {
            if sigma <= 0.0 {
                return original.iter().map(value).collect();
            }
            let r = (3.0 * sigma).ceil() as isize;
            (0..original.len() as isize)
                .map(|i| {
                    let (mut acc, mut wsum) = (0.0, 0.0);
                    for k in -r..=r {
                        let j = i + k;
                        if j < 0 || j >= original.len() as isize {
                            continue;
                        }
                        let wk = (-(k * k) as f64 / (2.0 * sigma * sigma)).exp() * original[j as usize].confidence.max(0.05);
                        acc += wk * value(&original[j as usize]);
                        wsum += wk;
                    }
                    acc / wsum
                })
                .collect()
        };
        let (xs, ys) = (pass(sigma_pos, &|s| s.cx), pass(sigma_pos, &|s| s.cy));
        let (ws, hs) = (pass(sigma_size, &|s| s.w), pass(sigma_size, &|s| s.h));
        for (i, s) in run.iter_mut().enumerate() {
            s.cx = xs[i];
            s.cy = ys[i];
            s.w = ws[i];
            s.h = hs[i];
        }
        start = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A textured square on a textured background, at (x, y) - smooth noise so LK has gradients.
    fn scene(w: usize, h: usize, x: f64, y: f64, size: f64) -> Vec<u8> {
        let mut data = vec![0u8; w * h];
        for j in 0..h {
            for i in 0..w {
                let (fi, fj) = (i as f64, j as f64);
                let bg = 90.0 + 25.0 * ((fi * 0.05).sin() + (fj * 0.043).cos());
                let inside = fi >= x - size / 2.0 && fi < x + size / 2.0 && fj >= y - size / 2.0 && fj < y + size / 2.0;
                let v = if inside {
                    let (u, v) = ((fi - x) / size * 12.0, (fj - y) / size * 12.0);
                    170.0 + 60.0 * (u.sin() * v.cos())
                } else {
                    bg
                };
                data[j * w + i] = v.clamp(0.0, 255.0) as u8;
            }
        }
        data
    }

    #[test]
    fn follows_a_moving_square() {
        let (w, h) = (320, 240);
        let first = scene(w, h, 80.0, 100.0, 50.0);
        let mut t = Tracker::new(GrayFrame { width: w, height: h, data: &first }, 80.0, 100.0, 50.0, 50.0);
        let mut last = t.current();
        for k in 1..=40 {
            let (x, y) = (80.0 + 3.5 * k as f64, 100.0 + 1.2 * k as f64);
            let f = scene(w, h, x, y, 50.0);
            last = t.advance(GrayFrame { width: w, height: h, data: &f });
            assert!(!last.lost, "lost at frame {k}");
            assert!((last.cx - x).abs() < 1.5 && (last.cy - y).abs() < 1.5, "frame {k}: {:?} vs ({x}, {y})", last);
        }
        assert!((last.w - 50.0).abs() < 5.0);
    }

    #[test]
    fn follows_scale() {
        let (w, h) = (320, 240);
        let first = scene(w, h, 160.0, 120.0, 40.0);
        let mut t = Tracker::new(GrayFrame { width: w, height: h, data: &first }, 160.0, 120.0, 40.0, 40.0);
        let mut last = t.current();
        for k in 1..=20 {
            let size = 40.0 * (1.0 + 0.02 * k as f64);
            let f = scene(w, h, 160.0, 120.0, size);
            last = t.advance(GrayFrame { width: w, height: h, data: &f });
        }
        let want = 40.0 * 1.4;
        assert!((last.w - want).abs() / want < 0.08, "{:?} vs {want}", last);
    }

    #[test]
    fn finds_it_again_after_a_jump() {
        let (w, h) = (320, 240);
        let first = scene(w, h, 100.0, 100.0, 50.0);
        let mut t = Tracker::new(GrayFrame { width: w, height: h, data: &first }, 100.0, 100.0, 50.0, 50.0);
        // A frame where it's gone (covered), then it reappears somewhere else.
        let blank: Vec<u8> = scene(w, h, -500.0, -500.0, 50.0);
        let s = t.advance(GrayFrame { width: w, height: h, data: &blank });
        assert!(s.lost || s.confidence < 0.5);
        let mut found = None;
        for _ in 0..8 {
            let f = scene(w, h, 170.0, 130.0, 50.0);
            let s = t.advance(GrayFrame { width: w, height: h, data: &f });
            if !s.lost {
                found = Some(s);
                break;
            }
        }
        let s = found.expect("never found again");
        assert!((s.cx - 170.0).abs() < 2.0 && (s.cy - 130.0).abs() < 2.0, "{:?}", s);
    }

    #[test]
    fn a_cut_loses_it_rather_than_following_the_next_shot() {
        let (w, h) = (320, 240);
        let first = scene(w, h, 100.0, 100.0, 50.0);
        let mut t = Tracker::new(GrayFrame { width: w, height: h, data: &first }, 100.0, 100.0, 50.0, 50.0);
        // A different shot: an inverted, textured picture with nothing like the square in it.
        let other: Vec<u8> = scene(w, h, -500.0, -500.0, 50.0).iter().map(|v| 255 - v).collect();
        assert!(t.advance(GrayFrame { width: w, height: h, data: &other }).lost);
    }

    #[test]
    fn smoothing_stays_inside_runs() {
        let mut samples: Vec<Sample> = (0..10).map(|i| Sample { cx: i as f64, cy: 0.0, w: 10.0, h: 10.0, confidence: 1.0, lost: i == 5 }).collect();
        smooth(&mut samples, 1.0, 2.0);
        // A straight line stays straight away from the ends; the lost frame is untouched.
        assert!((samples[2].cx - 2.0).abs() < 1e-6);
        assert_eq!(samples[5].cx, 5.0);
    }
}
