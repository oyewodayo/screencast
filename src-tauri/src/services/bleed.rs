// services/bleed.rs
//
// Playback bleed removal: a take recorded while the timeline played out of speakers has the
// timeline's own sound in it, a little late - heard back with the timeline it is a harsh echo. An
// ordinary recorder has to guess at that from the recording alone; the editor knows *exactly* what
// was playing (the reference, rendered from the timeline), so this is real acoustic echo
// cancellation, done offline where it can look at the whole take at once:
//
//  1. Delay   where the reference lands in the take, tracked all the way through - GCC-PHAT on 1 s
//             windows every 0.5 s at 4 kHz, kept only where the spike stands well clear, made into
//             a piecewise-constant track that follows each jump (the preview stalling on a clip
//             switch puts the timeline further behind).
//  2. Align   the reference re-timed onto the take, segment by segment, crossfaded at each jump.
//  3. Learn   the echo path per frequency bin as a short convolutive filter (8 taps of 21 ms - the
//             speakers, the room's early reflections, the mic) by least squares over the take: the
//             speaker's own voice doesn't correlate with the reference, so it averages out of the
//             statistics instead of throwing the filter off the way it upsets a live canceller
//             mid-sentence. Then a second, weighted pass: every bin of every frame counts by how
//             much of it the first pass found to be echo, so the voice - often louder than the
//             bleed - all but drops out. Every other frame is enough (at 75% overlap a frame is
//             mostly its neighbour). Solved per 4 s from that stretch and its neighbours, and blended
//             between - it follows a mic being moved or the music getting louder.
//  4. Remove  the predicted echo subtracted, then what the linear filter can't reach (speaker
//             distortion, the room's late tail) suppressed by a per-bin gain that only acts where the
//             residual echo outweighs what's left - the voice keeps its gain of 1.
//
// STFT: 4096-sample sqrt-Hann frames every 1024 samples (48 kHz: 85 ms / 21 ms), perfectly
// reconstructing. Every stage runs across all the cores (rayon): delay windows, frames' FFTs, and the
// bins of the statistics, the solve and the suppressor are all independent.
//
// A take of any length is worked through by `run` in SEGMENT_SEC stretches with MARGIN_SEC of
// context either side, only each stretch's middle kept and crossfaded into the last - so memory is a
// stretch's worth whether the take is five minutes or thirty hours, and the report adds up exactly
// across stretches (Sums).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rayon::prelude::*;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use rustfft::num_complex::Complex64;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};

type C = Complex64;
const ZERO: C = C { re: 0.0, im: 0.0 };

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Strength {
    Gentle,
    Normal,
    Strong,
}

impl Strength {
    // (share of the echo estimate assumed left after subtraction, over-subtraction, gain floor)
    fn params(self) -> (f64, f64, f64) {
        match self {
            Strength::Gentle => (0.1, 1.0, 0.25),
            Strength::Normal => (0.2, 1.5, 0.1),
            Strength::Strong => (0.35, 2.0, 0.03),
        }
    }
}

const N: usize = 4096;
const HOP: usize = 1024;
const TAPS: usize = 8;
const CHUNK_FRAMES: usize = 188; // ~4 s
const BINS: usize = N / 2 + 1;
// Per bin: A (TAPS x TAPS, upper triangle used) then b.
const STAT: usize = TAPS * TAPS + TAPS;
// The aligned reference leads the take by this much, so every echo arrives on or after tap 0.
const MARGIN_SEC: f64 = 0.01;
const CROSSFADE_SEC: f64 = 0.02;
const LEARN_STRIDE: usize = 2;

fn frame_count(samples: usize) -> usize {
    (samples + N + HOP - 1) / HOP
}
fn chunk_count(frames: usize) -> usize {
    (frames + CHUNK_FRAMES - 1) / CHUNK_FRAMES
}

// ---- 1. Delay -----------------------------------------------------------------------------------

const ANALYSIS_RATE: usize = 4000;
const DELAY_WINDOW: usize = 4096; // ~1 s at 4 kHz
const DELAY_HOP: usize = 2000; // 0.5 s
const MIN_LAG_SEC: f64 = -0.2;
const MAX_LAG_SEC: f64 = 1.5;
// How far the spike has to stand above the correlation's typical level to be believed.
const CONFIDENCE: f64 = 7.0;
const JUMP_SEC: f64 = 0.0015;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct DelaySegment {
    pub from: f64, // seconds into the take
    pub delay: f64,
}

#[derive(Clone, Copy, Debug)]
struct Reading {
    at: f64,
    delay: f64,
}

// Box-filtered and decimated - enough to locate a correlation peak, which is all this is for.
fn decimate(x: &[f32], rate: f64) -> Vec<f32> {
    let factor = ((rate / ANALYSIS_RATE as f64).round() as usize).max(1);
    (0..x.len() / factor).map(|i| x[i * factor..i * factor + factor].iter().sum::<f32>() / factor as f32).collect()
}

// The trusted readings (in time order), and how many windows had sound in both to read from.
fn measure_delays(take: &[f32], reference: &[f32]) -> (Vec<Reading>, usize) {
    let min_lag = (MIN_LAG_SEC * ANALYSIS_RATE as f64).round() as isize;
    let max_lag = (MAX_LAG_SEC * ANALYSIS_RATE as f64).round() as isize;
    let span = (max_lag - min_lag) as usize;
    let size = (DELAY_WINDOW + span).next_power_of_two();
    let windows = if take.len() >= DELAY_WINDOW { (take.len() - DELAY_WINDOW) / DELAY_HOP + 1 } else { 0 };
    let mut planner = FftPlanner::<f64>::new();
    let fwd = planner.plan_fft_forward(size);
    let inv = planner.plan_fft_inverse(size);
    let hann: Vec<f64> = (0..DELAY_WINDOW).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (DELAY_WINDOW - 1) as f64).cos()).collect();
    let results: Vec<(bool, Option<Reading>)> = (0..windows)
        .into_par_iter()
        .map(|w| {
            let start = w * DELAY_HOP;
            let mut t = vec![ZERO; size];
            let mut r = vec![ZERO; size];
            let (mut te, mut re) = (0.0, 0.0);
            for i in 0..DELAY_WINDOW {
                let v = take[start + i] as f64 * hann[i];
                t[i].re = v;
                te += v * v;
            }
            // ref[n - lag] for lags min..max: the reference from (start - max_lag), laid out so the
            // correlation's index k means lag (max_lag - k).
            let ref_start = start as isize - max_lag;
            for i in 0..DELAY_WINDOW + span {
                let j = ref_start + i as isize;
                let v = if j >= 0 && (j as usize) < reference.len() { reference[j as usize] as f64 } else { 0.0 };
                r[i].re = v;
                re += v * v;
            }
            if te < 1e-9 || re < 1e-9 {
                return (false, None);
            }
            fwd.process(&mut t);
            fwd.process(&mut r);
            // PHAT-weighted cross-spectrum R * conj(T).
            for k in 0..size {
                let c = r[k] * t[k].conj();
                r[k] = c / (c.norm() + 1e-12);
            }
            inv.process(&mut r);
            let (mut best, mut best_k, mut sum_abs) = (f64::NEG_INFINITY, 0usize, 0.0);
            for k in 0..=span {
                let v = r[k].re;
                sum_abs += v.abs();
                if v > best {
                    best = v;
                    best_k = k;
                }
            }
            let confidence = best / (sum_abs / (span + 1) as f64 + 1e-12);
            if confidence < CONFIDENCE {
                return (true, None);
            }
            // Parabolic refinement between the neighbouring lags.
            let y0 = if best_k > 0 { r[best_k - 1].re } else { best };
            let y2 = if best_k < span { r[best_k + 1].re } else { best };
            let denom = y0 - 2.0 * best + y2;
            let frac = if denom.abs() > 1e-12 { 0.5 * (y0 - y2) / denom } else { 0.0 };
            let lag = max_lag as f64 - (best_k as f64 + frac);
            (true, Some(Reading { at: (start + DELAY_WINDOW / 2) as f64 / ANALYSIS_RATE as f64, delay: lag / ANALYSIS_RATE as f64 }))
        })
        .collect();
    let sounding = results.iter().filter(|(s, _)| *s).count();
    (results.into_iter().filter_map(|(_, r)| r).collect(), sounding)
}

// Trusted readings -> a piecewise-constant delay over the take: it moves only when two readings in a
// row agree on a new value, so a stray window can't jerk it about but a real stall is followed.
fn delay_track(readings: &[Reading]) -> Vec<DelaySegment> {
    if readings.is_empty() {
        return Vec::new();
    }
    let mut first: Vec<f64> = readings.iter().take(5).map(|r| r.delay).collect();
    first.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut current = first[first.len() / 2];
    let mut segments = vec![DelaySegment { from: 0.0, delay: current }];
    for pair in readings.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if (b.delay - current).abs() > JUMP_SEC && (a.delay - current).abs() > JUMP_SEC && (a.delay - b.delay).abs() < JUMP_SEC {
            current = (a.delay + b.delay) / 2.0;
            // It moved somewhere in the half-second before the first new reading.
            segments.push(DelaySegment { from: (a.at - DELAY_HOP as f64 / ANALYSIS_RATE as f64 / 2.0).max(0.0), delay: current });
        }
    }
    segments
}

fn delay_at(segments: &[DelaySegment], t: f64) -> f64 {
    let mut d = segments[0].delay;
    for s in segments {
        if s.from > t {
            break;
        }
        d = s.delay;
    }
    d
}

// ref re-timed onto the take: aligned[n] = ref[n - delay(n) + margin], linearly interpolated, with a
// short crossfade wherever the delay jumps.
fn align_reference(reference: &[f32], length: usize, rate: f64, segments: &[DelaySegment]) -> Vec<f32> {
    let read = |pos: f64| -> f64 {
        let i = pos.floor();
        if i < 0.0 {
            return 0.0;
        }
        let i = i as usize;
        if i + 1 >= reference.len() {
            return if i < reference.len() { reference[i] as f64 } else { 0.0 };
        }
        let f = pos - i as f64;
        reference[i] as f64 * (1.0 - f) + reference[i + 1] as f64 * f
    };
    let margin = MARGIN_SEC * rate;
    let fade = ((CROSSFADE_SEC * rate).round() as usize).max(1);
    let mut seg = 0;
    (0..length)
        .map(|n| {
            while seg + 1 < segments.len() && n as f64 >= segments[seg + 1].from * rate {
                seg += 1;
            }
            let mut v = read(n as f64 - segments[seg].delay * rate + margin);
            if seg > 0 {
                let at = (segments[seg].from * rate).round() as usize;
                if n < at + fade {
                    let prev = read(n as f64 - segments[seg - 1].delay * rate + margin);
                    let x = (n as f64 - at as f64) / fade as f64;
                    v = prev * (1.0 - x) + v * x;
                }
            }
            v as f32
        })
        .collect()
}

// The delay track and the aligned reference - or None when there's no bleed to speak of (the
// readings have to keep agreeing with one track: a chance alignment of a voice and the music can
// fool a window or two, never a fifth of the take).
fn prepare(take: &[f32], reference: &[f32], rate: f64) -> Option<(Vec<DelaySegment>, Vec<f32>)> {
    let (readings, sounding) = measure_delays(&decimate(take, rate), &decimate(reference, rate));
    let segments = delay_track(&readings);
    if segments.is_empty() {
        return None;
    }
    let agreeing = readings.iter().filter(|r| (r.delay - delay_at(&segments, r.at)).abs() < 0.002).count();
    if (agreeing as f64) < (3.0f64).max(0.2 * sounding as f64) {
        return None;
    }
    let aligned = align_reference(reference, take.len(), rate, &segments);
    Some((segments, aligned))
}

// ---- STFT ---------------------------------------------------------------------------------------

struct Stft {
    r2c: Arc<dyn RealToComplex<f64>>,
    c2r: Arc<dyn ComplexToReal<f64>>,
    window: Vec<f64>,
}

impl Stft {
    fn new() -> Self {
        let mut planner = RealFftPlanner::<f64>::new();
        Stft {
            r2c: planner.plan_fft_forward(N),
            c2r: planner.plan_fft_inverse(N),
            window: (0..N).map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / N as f64).cos()).sqrt()).collect(),
        }
    }

    // Spectra of every `stride`-th frame from `first` (frames before 0 are silence), stored
    // BIN-MAJOR - index k * count + f - so the per-bin work that follows walks contiguous memory.
    // Frame t covers samples [t*HOP - (N - HOP), t*HOP + HOP).
    fn spectrogram(&self, src: &[f32], first: isize, count: usize, stride: usize) -> Vec<C> {
        let frames: Vec<Vec<C>> = (0..count)
            .into_par_iter()
            .map(|f| {
                let start = (first + (f * stride) as isize) * HOP as isize - (N - HOP) as isize;
                let mut buf = vec![0.0f64; N];
                for (i, b) in buf.iter_mut().enumerate() {
                    let j = start + i as isize;
                    if j >= 0 && (j as usize) < src.len() {
                        *b = src[j as usize] as f64 * self.window[i];
                    }
                }
                let mut out = self.r2c.make_output_vec();
                let _ = self.r2c.process(&mut buf, &mut out);
                out
            })
            .collect();
        let mut d = vec![ZERO; BINS * count];
        for (f, spectrum) in frames.iter().enumerate() {
            for (k, v) in spectrum.iter().enumerate() {
                d[k * count + f] = *v;
            }
        }
        d
    }
}

// Which two chunks' filters a frame sits between, and how far from the first.
fn chunk_blend(t: usize, chunks: usize) -> (usize, usize, f64) {
    let p = t as f64 / CHUNK_FRAMES as f64 - 0.5;
    let c0 = (p.floor().max(0.0) as usize).min(chunks - 1);
    let c1 = (c0 + 1).min(chunks - 1);
    (c0, c1, (p - c0 as f64).clamp(0.0, 1.0))
}

// ---- 3. Learn -----------------------------------------------------------------------------------

// One chunk's statistics, per bin: A = sum w conj(x) x^T (upper triangle) and b = sum w conj(x) d, x
// being the last TAPS reference spectra, over every LEARN_STRIDE-th frame. With `prior` filters
// (by chunk), w = how much of each bin they predict as echo.
fn chunk_stats(stft: &Stft, take: &[f32], aligned: &[f32], c: usize, prior: Option<&[Vec<C>]>) -> Vec<C> {
    let frames = frame_count(take.len());
    let chunks = chunk_count(frames);
    let first = c * CHUNK_FRAMES;
    let count = (first + CHUNK_FRAMES).min(frames) - first;
    let learning = (count + LEARN_STRIDE - 1) / LEARN_STRIDE;
    let d = stft.spectrogram(take, first as isize, learning, LEARN_STRIDE);
    let x_count = count + TAPS - 1;
    let x = stft.spectrogram(aligned, first as isize - (TAPS as isize - 1), x_count, 1);
    let blends: Vec<(usize, usize, f64)> = (0..learning).map(|g| chunk_blend(first + g * LEARN_STRIDE, chunks)).collect();
    let mut s = vec![ZERO; BINS * STAT];
    s.par_chunks_mut(STAT).enumerate().for_each(|(k, sk)| {
        let mut xs = [ZERO; TAPS];
        for g in 0..learning {
            let f = g * LEARN_STRIDE;
            // x_l = the reference l frames back: contiguous, walking back.
            let xo = k * x_count + f + TAPS - 1;
            for (l, v) in xs.iter_mut().enumerate() {
                *v = x[xo - l];
            }
            let dv = d[k * learning + g];
            let mut w = 1.0;
            if let Some(prior) = prior {
                let (c0, c1, b) = blends[g];
                let (f0, f1) = (&prior[c0], &prior[c1]);
                let mut y = ZERO;
                for l in 0..TAPS {
                    y += (f0[k * TAPS + l] * (1.0 - b) + f1[k * TAPS + l] * b) * xs[l];
                }
                let y2 = y.norm_sqr();
                w = y2 / (y2 + (dv - y).norm_sqr() + 1e-20);
                if w < 1e-3 {
                    continue;
                }
            }
            for i in 0..TAPS {
                let a = xs[i].conj() * w;
                for j in i..TAPS {
                    sk[i * TAPS + j] += a * xs[j];
                }
                sk[TAPS * TAPS + i] += a * dv;
            }
        }
    });
    s
}

// Per bin, the TAPS-long filter h solving (A + delta I) h = b - A and b summed over a chunk and half
// of each neighbour's. Hermitian positive definite, so by complex Cholesky.
fn solve_filters(prev: Option<&[C]>, cur: &[C], next: Option<&[C]>) -> Vec<C> {
    let mut out = vec![ZERO; BINS * TAPS];
    out.par_chunks_mut(TAPS).enumerate().for_each(|(k, h)| {
        let base = k * STAT;
        let sum = |o: usize| cur[base + o] + (prev.map_or(ZERO, |p| p[base + o]) + next.map_or(ZERO, |n| n[base + o])) * 0.5;
        let mut a = [[ZERO; TAPS]; TAPS];
        let mut b = [ZERO; TAPS];
        let mut trace = 0.0;
        for i in 0..TAPS {
            for j in i..TAPS {
                let v = sum(i * TAPS + j);
                a[i][j] = v;
                a[j][i] = v.conj();
            }
            trace += a[i][i].re;
            b[i] = sum(TAPS * TAPS + i);
        }
        // A bin the reference never reached has nothing to learn: its filter stays zero.
        if trace < 1e-12 {
            return;
        }
        let delta = 1e-3 * (trace / TAPS as f64) + 1e-12;
        for (i, row) in a.iter_mut().enumerate() {
            row[i] += delta;
        }
        // Cholesky: A = L L^H.
        let mut l = [[ZERO; TAPS]; TAPS];
        for j in 0..TAPS {
            let mut d = a[j][j].re;
            for m in 0..j {
                d -= l[j][m].norm_sqr();
            }
            if d <= 0.0 {
                return;
            }
            let ljj = d.sqrt();
            l[j][j] = C::new(ljj, 0.0);
            for i in j + 1..TAPS {
                let mut s = a[i][j];
                for m in 0..j {
                    s -= l[i][m] * l[j][m].conj();
                }
                l[i][j] = s / ljj;
            }
        }
        let mut y = [ZERO; TAPS];
        for i in 0..TAPS {
            let mut s = b[i];
            for m in 0..i {
                s -= l[i][m] * y[m];
            }
            y[i] = s / l[i][i].re;
        }
        for i in (0..TAPS).rev() {
            let mut s = y[i];
            for m in i + 1..TAPS {
                s -= l[m][i].conj() * h[m];
            }
            h[i] = s / l[i][i].re;
        }
    });
    out
}

// ---- 4. Remove ----------------------------------------------------------------------------------

struct Removed {
    samples: Vec<f64>, // starting at take sample `frames 0`'s start: -(N - HOP)
    take: Vec<f64>,    // per frame: the take's, the predicted echo's and the output's power
    echo: Vec<f64>,
    out: Vec<f64>,
}

// Every frame with its echo predicted (between the nearest chunks' filters), subtracted and what
// remains suppressed - in blocks of CHUNK_FRAMES, each bin's suppressor state carried across.
fn remove_frames(stft: &Stft, take: &[f32], aligned: &[f32], filters: &[Vec<C>], strength: Strength, progress: &(dyn Fn(f64) + Sync)) -> Removed {
    let frames = frame_count(take.len());
    let chunks = chunk_count(frames);
    let (residual, over, floor) = strength.params();
    let mut resid = vec![0.0f64; BINS];
    let mut gain = vec![1.0f64; BINS];
    let mut samples = vec![0.0f64; (frames.max(1) - 1) * HOP + N];
    let (mut p_take, mut p_echo, mut p_out) = (vec![0.0; frames], vec![0.0; frames], vec![0.0; frames]);
    let scale = 0.5 / N as f64; // realfft's inverse is unnormalised; 0.5 undoes the window overlap
    let mut block_start = 0;
    while block_start < frames {
        let count = (block_start + CHUNK_FRAMES).min(frames) - block_start;
        let x_count = count + TAPS - 1;
        let d = stft.spectrogram(take, block_start as isize, count, 1);
        let x = stft.spectrogram(aligned, block_start as isize - (TAPS as isize - 1), x_count, 1);
        let blends: Vec<(usize, usize, f64)> = (0..count).map(|f| chunk_blend(block_start + f, chunks)).collect();
        let mut cleaned = vec![ZERO; BINS * count];
        let mut echo_power = vec![0.0f64; BINS * count];
        cleaned
            .par_chunks_mut(count)
            .zip(echo_power.par_chunks_mut(count))
            .zip(resid.par_iter_mut())
            .zip(gain.par_iter_mut())
            .enumerate()
            .for_each(|(k, (((ck, ek), r0), g0))| {
                for f in 0..count {
                    let (c0, c1, w) = blends[f];
                    let (f0, f1) = (&filters[c0], &filters[c1]);
                    let xo = k * x_count + f + TAPS - 1;
                    let mut y = ZERO;
                    for l in 0..TAPS {
                        y += (f0[k * TAPS + l] * (1.0 - w) + f1[k * TAPS + l] * w) * x[xo - l];
                    }
                    let e = d[k * count + f] - y;
                    let e2 = e.norm_sqr();
                    let y2 = y.norm_sqr();
                    // What's left of the echo after subtraction: a share of the estimate, and the
                    // room's tail decaying from what came before.
                    *r0 = (residual * y2).max(0.7 * *r0);
                    let g = (1.0 - over * *r0 / (e2 + 1e-18)).clamp(floor, 1.0);
                    // Down at once, back up gently - no flutter as speech and echo trade places.
                    *g0 = if g < *g0 { g } else { *g0 + (g - *g0) * 0.4 };
                    ck[f] = e * *g0;
                    ek[f] = y2;
                }
            });
        // Back to samples, frame by frame.
        let synthesized: Vec<(f64, f64, f64, Vec<f64>)> = (0..count)
            .into_par_iter()
            .map(|f| {
                let mut spectrum: Vec<C> = (0..BINS).map(|k| cleaned[k * count + f]).collect();
                let (pt, pe, po) = (0..BINS).fold((0.0, 0.0, 0.0), |(a, b, c), k| (a + d[k * count + f].norm_sqr(), b + echo_power[k * count + f], c + spectrum[k].norm_sqr()));
                // A real signal's DC and Nyquist bins are real.
                spectrum[0].im = 0.0;
                spectrum[BINS - 1].im = 0.0;
                let mut out = stft.c2r.make_output_vec();
                let _ = stft.c2r.process(&mut spectrum, &mut out);
                let frame: Vec<f64> = out.iter().zip(&stft.window).map(|(v, w)| v * w * scale).collect();
                (pt, pe, po, frame)
            })
            .collect();
        for (f, (pt, pe, po, frame)) in synthesized.into_iter().enumerate() {
            let t = block_start + f;
            p_take[t] = pt;
            p_echo[t] = pe;
            p_out[t] = po;
            let at = t * HOP;
            for (i, v) in frame.iter().enumerate() {
                samples[at + i] += v;
            }
        }
        block_start += count;
        progress(block_start as f64 / frames as f64);
    }
    Removed { samples, take: p_take, echo: p_echo, out: p_out }
}

// ---- Report -------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default)]
pub struct Sums {
    pub bleed: f64,
    pub bleed_take: f64,
    pub solo_in: f64,
    pub solo_out: f64,
}

impl Sums {
    fn add(&mut self, o: &Sums) {
        self.bleed += o.bleed;
        self.bleed_take += o.bleed_take;
        self.solo_in += o.solo_in;
        self.solo_out += o.solo_out;
    }
    // How loud the bleed was against the take where it was present, and how far it was taken down
    // where it played on its own (dB).
    pub fn bleed_db(&self) -> f64 {
        if self.bleed_take > 0.0 { 10.0 * (self.bleed / self.bleed_take).log10() } else { f64::NEG_INFINITY }
    }
    pub fn removed_db(&self) -> f64 {
        if self.solo_in > 0.0 { 10.0 * (self.solo_in / (self.solo_out + 1e-18)).log10() } else { 0.0 }
    }
}

fn frame_sec(t: usize, rate: f64) -> f64 {
    (t as f64 * HOP as f64 - (N - HOP) as f64 + N as f64 / 2.0) / rate
}

// Over frames [from, to): the stretches with bleed (bridging gaps under 0.4 s, dropping blips under
// 0.3 s) and the sums.
fn report(r: &Removed, rate: f64, from: usize, to: usize) -> (Vec<[f64; 2]>, Sums) {
    let audible_floor = N as f64 * 1e-7; // ~-70 dBFS a frame
    let mut sums = Sums::default();
    let mut regions: Vec<[f64; 2]> = Vec::new();
    let mut start: Option<usize> = None;
    let mut last_on = 0;
    for t in from..to.min(r.take.len()) {
        let (echo, take) = (r.echo[t], r.take[t]);
        let audible = echo > audible_floor && echo > 0.06 * take;
        if audible {
            sums.bleed += echo;
            sums.bleed_take += take;
            match start {
                None => start = Some(t),
                Some(s) if frame_sec(t, rate) - frame_sec(last_on, rate) > 0.4 => {
                    regions.push([frame_sec(s, rate), frame_sec(last_on, rate)]);
                    start = Some(t);
                }
                _ => {}
            }
            last_on = t;
        }
        // The bleed all but alone (no one speaking over it) - where the removal can be measured.
        if echo > audible_floor && echo > 0.92 * take {
            sums.solo_in += take;
            sums.solo_out += r.out[t];
        }
    }
    if let Some(s) = start {
        regions.push([frame_sec(s, rate), frame_sec(last_on, rate)]);
    }
    regions.retain(|[a, b]| b - a >= 0.3);
    for r in &mut regions {
        r[0] = r[0].max(0.0);
    }
    (regions, sums)
}

// ---- One stretch --------------------------------------------------------------------------------

pub struct Stretch {
    // null when there's no bleed in the kept part - the take is left as it is there.
    pub output: Option<Vec<f32>>,
    pub segments: Vec<DelaySegment>,
    pub regions: Vec<[f64; 2]>,
    pub sums: Sums,
}

// The whole of one stretch (take and reference sample-aligned, `rate` Hz), reporting over `keep`
// seconds only (the rest is context a caller throws away). `progress` 0..1.
pub fn remove_stretch(take: &[f32], reference: &[f32], rate: f64, strength: Strength, keep: Option<(f64, f64)>, progress: &(dyn Fn(f64) + Sync)) -> Stretch {
    let none = Stretch { output: None, segments: Vec::new(), regions: Vec::new(), sums: Sums::default() };
    let Some((segments, aligned)) = prepare(take, reference, rate) else {
        progress(1.0);
        return none;
    };
    progress(0.1);
    let stft = Stft::new();
    let frames = frame_count(take.len());
    let chunks = chunk_count(frames);
    let learn = |prior: Option<&[Vec<C>]>| -> Vec<Vec<C>> {
        let stats: Vec<Vec<C>> = (0..chunks).into_par_iter().map(|c| chunk_stats(&stft, take, &aligned, c, prior)).collect();
        (0..chunks)
            .into_par_iter()
            .map(|c| solve_filters(c.checked_sub(1).map(|p| stats[p].as_slice()), &stats[c], stats.get(c + 1).map(|v| v.as_slice())))
            .collect()
    };
    let first = learn(None);
    progress(0.4);
    let filters = learn(Some(&first));
    progress(0.7);
    let removed = remove_frames(&stft, take, &aligned, &filters, strength, &|f| progress(0.7 + 0.3 * f));
    let frame_at = |sec: f64| -> usize { (((sec * rate + (N - HOP) as f64 - N as f64 / 2.0) / HOP as f64).round().max(0.0) as usize).min(frames) };
    let (from, to) = keep.map_or((0, frames), |(a, b)| (frame_at(a), frame_at(b)));
    let (regions, sums) = report(&removed, rate, from, to);
    if regions.is_empty() {
        return Stretch { segments, ..none };
    }
    // `samples` starts at frame 0's first sample, N - HOP before the take's.
    let output: Vec<f32> = (0..take.len()).map(|i| removed.samples[i + (N - HOP)] as f32).collect();
    Stretch { output: Some(output), segments, regions, sums }
}

// ---- A take of any length -----------------------------------------------------------------------

pub const SEGMENT_SEC: f64 = 45.0;
// Context either side of a stretch: the delay search looks 1.5 s back, the echo path is learned from
// 4 s chunks and their neighbours - all of it well inside this.
pub const MARGIN_SEC_SEGMENT: f64 = 10.0;
const SEGMENT_CROSSFADE_SEC: f64 = 0.1;

pub struct Outcome {
    pub found: bool,
    pub segments: Vec<DelaySegment>,
    pub regions: Vec<[f64; 2]>,
    pub sums: Sums,
}

type Pcm = Result<(Vec<f32>, Vec<f32>), String>;

// Works through a `length`-second take a stretch at a time: `read(from, seconds)` gives that stretch
// of the take and of the reference (sample-aligned, `rate` Hz, exactly as long as asked) - the next
// stretch is read while this one is worked on, so the disk and ffmpeg cost nothing extra - and
// `write` takes the cleaned take in order, sample after sample. Stops between stretches when
// `cancelled`.
pub fn run(
    length: f64,
    rate: f64,
    strength: Strength,
    read: &(dyn Fn(f64, f64) -> Pcm + Sync),
    write: &mut dyn FnMut(&[f32]) -> Result<(), String>,
    progress: &(dyn Fn(f64) + Sync),
    cancelled: &AtomicBool,
) -> Result<Outcome, String> {
    let stretches = ((length / SEGMENT_SEC).ceil() as usize).max(1);
    let span = |k: usize| {
        let core = (k as f64 * SEGMENT_SEC, ((k + 1) as f64 * SEGMENT_SEC).min(length));
        (core, (core.0 - MARGIN_SEC_SEGMENT).max(0.0), (core.1 + MARGIN_SEC_SEGMENT).min(length))
    };
    std::thread::scope(|scope| {
        let fetch = |k: usize| {
            let (_, from, to) = span(k);
            scope.spawn(move || read(from, to - from))
        };
        let mut next = Some(fetch(0));
        // Stretch k (read while k - 1 was worked on), and k + 1 set reading.
        let mut stretch = |k: usize| -> Pcm {
            let pcm = next.take().map_or_else(|| Err("Reading the audio failed.".to_string()), |h| h.join().unwrap_or_else(|_| Err("Reading the audio failed.".to_string())));
            if k + 1 < stretches {
                next = Some(fetch(k + 1));
            }
            pcm
        };
        run_stretches(stretches, rate, strength, &span, &mut stretch, write, progress, cancelled)
    })
}

fn run_stretches(
    stretches: usize,
    rate: f64,
    strength: Strength,
    span: &dyn Fn(usize) -> ((f64, f64), f64, f64),
    stretch: &mut dyn FnMut(usize) -> Pcm,
    write: &mut dyn FnMut(&[f32]) -> Result<(), String>,
    progress: &(dyn Fn(f64) + Sync),
    cancelled: &AtomicBool,
) -> Result<Outcome, String> {
    let fade = (SEGMENT_CROSSFADE_SEC * rate).round() as usize;
    let mut tail: Option<Vec<f32>> = None;
    let mut outcome = Outcome { found: false, segments: Vec::new(), regions: Vec::new(), sums: Sums::default() };
    for k in 0..stretches {
        if cancelled.load(Ordering::SeqCst) {
            return Err("Cancelled".to_string());
        }
        let (take, reference) = stretch(k)?;
        let (core, from, _) = span(k);
        let share = 1.0 / stretches as f64;
        let base = k as f64 * share;
        let stretch = remove_stretch(&take, &reference, rate, strength, Some((core.0 - from, core.1 - from)), &|f| progress(base + f * share));
        if let Some(_) = &stretch.output {
            outcome.found = true;
            outcome.sums.add(&stretch.sums);
            outcome.regions.extend(stretch.regions.iter().map(|[a, b]| [a + from, b + from]));
            for s in &stretch.segments {
                let at = s.from + from;
                if at >= core.1 {
                    continue;
                }
                if outcome.segments.last().map_or(true, |l| (l.delay - s.delay).abs() > JUMP_SEC) {
                    outcome.segments.push(DelaySegment { from: at.max(core.0), delay: s.delay });
                }
            }
        }
        let source = stretch.output.as_deref().unwrap_or(&take);
        // Kept: [core start, core end + fade) - the extra fade carried over as the next one's blend-in.
        let last = k + 1 == stretches;
        let a = (((core.0 - from) * rate).round() as usize).min(source.len());
        let b = ((((core.1 - from) * rate).round() as usize) + if last { 0 } else { fade }).min(source.len()).max(a);
        let mut kept = source[a..b].to_vec();
        if let Some(t) = tail.take() {
            for i in 0..t.len().min(kept.len()) {
                let x = (i as f32 + 0.5) / fade as f32;
                kept[i] = t[i] * (1.0 - x) + kept[i] * x;
            }
        }
        if !last && kept.len() > fade {
            tail = Some(kept.split_off(kept.len() - fade));
        }
        write(&kept)?;
    }
    // Regions from neighbouring stretches that touch (or overlap in their margins) as one.
    outcome.regions.sort_by(|x, y| x[0].partial_cmp(&y[0]).unwrap_or(std::cmp::Ordering::Equal));
    let mut merged: Vec<[f64; 2]> = Vec::new();
    for r in outcome.regions.drain(..) {
        match merged.last_mut() {
            Some(l) if r[0] <= l[1] + 0.4 => l[1] = l[1].max(r[1]),
            _ => merged.push(r),
        }
    }
    outcome.regions = merged;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48000.0;

    // A deterministic noise source, so the test is the same every run.
    fn rng(seed: u32) -> impl FnMut() -> f32 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(1664525).wrapping_add(1013904223);
            s as f32 / 4294967296.0 - 0.5
        }
    }

    // The timeline's sound (a melody, chords, a noise bed), a speaker reading in phrases, and a mic
    // hearing the speakers 90 ms late through a speaker-and-room path - until playback stalls
    // halfway and the bleed falls 25 ms further back.
    fn scene(seconds: f64) -> (Vec<f32>, Vec<f32>, Vec<f32>, f64) {
        let n = (SR * seconds) as usize;
        let (mut r1, mut r2, mut noise) = (rng(7), rng(99), rng(3));
        let mut reference = vec![0.0f32; n];
        let mut lp = 0.0f32;
        for (i, v) in reference.iter_mut().enumerate() {
            let t = i as f64 / SR;
            let note = 220.0 * 2f64.powf(((t * 2.0).floor() as i64 % 7) as f64 / 12.0);
            lp = 0.97 * lp + 0.03 * r1();
            *v = (0.18 * (2.0 * std::f64::consts::PI * note * t).sin() + 0.08 * (2.0 * std::f64::consts::PI * note * 1.5 * t).sin() + 0.06 * (2.0 * std::f64::consts::PI * 82.0 * t).sin()) as f32 + 0.6 * lp;
        }
        let phrase = 0.9;
        let mut voice = vec![0.0f32; n];
        let mut vlp = 0.0f32;
        for (i, v) in voice.iter_mut().enumerate() {
            let t = i as f64 / SR;
            let on = (t / phrase).floor() as i64 % 2 == 0;
            let env = if on { (std::f64::consts::PI * (t % phrase) / phrase).sin() } else { 0.0 };
            let f0 = 140.0 + 30.0 * (t * 3.0).sin();
            vlp = 0.9 * vlp + 0.1 * r2();
            *v = (env * (0.15 * (2.0 * std::f64::consts::PI * f0 * t).sin() + 0.07 * (2.0 * std::f64::consts::PI * 2.0 * f0 * t).sin() + 0.05 * (2.0 * std::f64::consts::PI * 3.1 * f0 * t).sin() + 0.4 * vlp as f64)) as f32;
        }
        let path = [(0.0, 0.45), (0.004, -0.12), (0.011, 0.2), (0.023, 0.09), (0.041, -0.06), (0.06, 0.035)];
        let mut take = vec![0.0f32; n];
        for i in 0..n {
            let delay = if i < n / 2 { 0.09 } else { 0.115 };
            let mut echo = 0.0f32;
            for (d, g) in path {
                let j = i as isize - ((delay + d) * SR).round() as isize;
                if j >= 0 {
                    echo += g * reference[j as usize];
                }
            }
            take[i] = voice[i] + echo + 0.0005 * noise();
        }
        (reference, voice, take, phrase)
    }

    fn reduction(take: &[f32], out: &[f32], seconds: f64, phrase: f64) -> f64 {
        let (mut before, mut after) = (0.0f64, 0.0f64);
        let mut p = 3;
        while (p as f64) < seconds / phrase - 1.0 {
            let a = ((p as f64 + 0.1) * phrase * SR) as usize;
            let b = ((p as f64 + 0.9) * phrase * SR) as usize;
            if ((a as f64 / SR) - seconds / 2.0).abs() >= 1.2 {
                for i in a..b {
                    before += (take[i] as f64).powi(2);
                    after += (out[i] as f64).powi(2);
                }
            }
            p += 2;
        }
        10.0 * (before / after).log10()
    }

    #[test]
    fn removes_bleed_follows_the_stall_and_keeps_the_voice() {
        let seconds = 24.0;
        let (reference, voice, take, phrase) = scene(seconds);
        let started = std::time::Instant::now();
        let s = remove_stretch(&take, &reference, SR, Strength::Normal, None, &|_| {});
        let elapsed = started.elapsed().as_secs_f64();
        let out = s.output.expect("bleed found");
        assert!((s.segments[0].delay - 0.09).abs() < 0.001, "{:?}", s.segments);
        let last = s.segments.last().unwrap();
        assert!((last.delay - 0.115).abs() < 0.001 && last.from > seconds / 2.0 - 1.5 && last.from < seconds / 2.0 + 0.5, "{:?}", s.segments);
        let r = reduction(&take, &out, seconds, phrase);
        // Voice against everything else while speaking, before and after.
        let (mut v, mut err, mut err_before) = (0.0f64, 0.0f64, 0.0f64);
        let mut p = 2;
        while (p as f64) < seconds / phrase - 1.0 {
            let a = ((p as f64 + 0.15) * phrase * SR) as usize;
            let b = ((p as f64 + 0.85) * phrase * SR) as usize;
            if ((a as f64 / SR) - seconds / 2.0).abs() >= 1.2 {
                for i in a..b {
                    v += (voice[i] as f64).powi(2);
                    err += (out[i] as f64 - voice[i] as f64).powi(2);
                    err_before += (take[i] as f64 - voice[i] as f64).powi(2);
                }
            }
            p += 2;
        }
        let (snr_before, snr_after) = (10.0 * (v / err_before).log10(), 10.0 * (v / err).log10());
        println!("native: bleed reduced {r:.1} dB, voice {snr_before:.1} -> {snr_after:.1} dB, {:.0} ms for {seconds} s", elapsed * 1000.0);
        assert!(r > 38.0, "reduction {r}");
        assert!(snr_after > snr_before + 12.0, "{snr_before} -> {snr_after}");
    }

    #[test]
    fn leaves_a_take_with_no_bleed_alone() {
        let (reference, voice, _, _) = scene(12.0);
        assert!(remove_stretch(&voice, &reference, SR, Strength::Normal, None, &|_| {}).output.is_none());
    }

    #[test]
    fn a_long_take_a_stretch_at_a_time_matches_and_has_no_seams() {
        let seconds = 120.0;
        let (reference, _, take, phrase) = scene(seconds);
        let mut out: Vec<f32> = Vec::new();
        let slice = |src: &[f32], from: f64, len: f64| -> Vec<f32> {
            let s = (from * SR).round() as usize;
            (0..(len * SR).round() as usize).map(|i| src.get(s + i).copied().unwrap_or(0.0)).collect()
        };
        let outcome = run(
            seconds,
            SR,
            Strength::Normal,
            &|from, len| Ok((slice(&take, from, len), slice(&reference, from, len))),
            &mut |samples| {
                out.extend_from_slice(samples);
                Ok(())
            },
            &|_| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(outcome.found);
        assert_eq!(out.len(), take.len());
        assert!((outcome.segments[0].delay - 0.09).abs() < 0.001);
        assert!((outcome.segments.last().unwrap().delay - 0.115).abs() < 0.001);
        let r = reduction(&take, &out, seconds, phrase);
        println!("native segmented: bleed reduced {r:.1} dB, reported {:.1} dB", outcome.sums.removed_db());
        assert!(r > 38.0, "reduction {r}");
        for seam in [45.0, 90.0] {
            let (a, b) = (((seam - 0.3) * SR) as usize, ((seam + 0.3) * SR) as usize);
            let (mut max_out, mut max_take) = (0.0f32, 0.0f32);
            for i in a + 1..b {
                max_out = max_out.max((out[i] - out[i - 1]).abs());
                max_take = max_take.max((take[i] - take[i - 1]).abs());
            }
            assert!(max_out < max_take * 1.5, "seam at {seam}: {max_out} vs {max_take}");
        }
    }
}
