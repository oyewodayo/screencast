// services/beat_detect.rs
//
// Finds the beats in a music track, for the video editor's beat sync (beat markers on the timeline,
// snapping, "cut on the beat"). Pure signal processing on mono PCM - no model, no download:
//
// 1. Onset strength: per ~23ms frame, the rise in log energy of the full signal and of a
//    high-emphasis copy (first difference - brings out snares and hi-hats over a bass line),
//    half-wave rectified, so a frame scores high when sound suddenly gets louder.
// 2. Tempo: autocorrelation of that envelope over 60-180 BPM, weighted toward ~120 BPM (the usual
//    prior - between a song's tempo and its half/double, the one nearer 120 is what people tap).
// 3. Beats: dynamic programming (Ellis 2007) - each frame's best score is its own onset strength
//    plus the best earlier beat about one beat-period back, penalized by how far the gap strays
//    from the period. Backtracking from the best ending gives a beat train that follows the music's
//    actual hits while staying evenly spaced through quiet bars.

pub struct BeatAnalysis {
    pub bpm: f64,
    pub beats: Vec<f64>, // seconds
}

const HOP: usize = 512;
const WINDOW: usize = 1024;

// Per-frame log energies of the signal and of its high-emphasis copy, worked out from a stream of
// samples a block at a time - only the last WINDOW samples are ever held, so a track of any length
// (hours of a long recording) costs a few bytes a frame, never the whole signal.
pub struct FrameEnergies {
    ring: Vec<f32>,
    filled: usize,
    since_frame: usize,
    full: Vec<f32>,
    high: Vec<f32>,
}

impl FrameEnergies {
    pub fn new() -> Self {
        FrameEnergies { ring: vec![0.0; WINDOW], filled: 0, since_frame: 0, full: Vec::new(), high: Vec::new() }
    }

    pub fn push(&mut self, samples: &[f32]) {
        for &s in samples {
            // A sliding window kept as a ring: the newest sample overwrites the oldest.
            self.ring[self.filled % WINDOW] = s;
            self.filled += 1;
            if self.filled < WINDOW {
                continue;
            }
            // A frame every HOP samples once the first window is full - the same frames as
            // windowing the whole signal at f * HOP.
            if self.filled == WINDOW || { self.since_frame += 1; self.since_frame == HOP } {
                self.since_frame = 0;
                let start = self.filled % WINDOW; // the oldest sample in the window
                let mut e_full = 0.0f32;
                let mut e_high = 0.0f32;
                let mut prev = self.ring[start];
                for k in 0..WINDOW {
                    let v = self.ring[(start + k) % WINDOW];
                    e_full += v * v;
                    let d = v - prev;
                    e_high += d * d;
                    prev = v;
                }
                self.full.push((1e-6 + e_full / WINDOW as f32).ln());
                self.high.push((1e-6 + e_high / WINDOW as f32).ln());
            }
        }
    }

    // The onset strength envelope (see the module comment, step 1).
    pub fn envelope(self) -> Vec<f32> {
        let (full, high) = (self.full, self.high);
        let frames = full.len();
        let mut env = vec![0.0f32; frames];
        for f in 1..frames {
            env[f] = (full[f] - full[f - 1]).max(0.0) + (high[f] - high[f - 1]).max(0.0);
        }
        // Remove the slowly varying part (a local mean), keep the peaks.
        let half = 8;
        let mut out = vec![0.0f32; frames];
        for f in 0..frames {
            let lo = f.saturating_sub(half);
            let hi = (f + half + 1).min(frames);
            let mean: f32 = env[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
            out[f] = (env[f] - mean).max(0.0);
        }
        let peak = out.iter().cloned().fold(0.0f32, f32::max);
        if peak > 0.0 {
            for v in &mut out {
                *v /= peak;
            }
        }
        out
    }
}

fn onset_envelope(samples: &[f32]) -> Vec<f32> {
    let mut energies = FrameEnergies::new();
    energies.push(samples);
    energies.envelope()
}

fn autocorrelation(env: &[f32], lag: usize) -> f64 {
    if lag >= env.len() {
        return 0.0;
    }
    let mut sum = 0.0f64;
    for i in lag..env.len() {
        sum += (env[i] * env[i - lag]) as f64;
    }
    sum / (env.len() - lag) as f64
}

// The beat period in frames - fractional, refined by fitting a parabola through the best lag and
// its neighbours (whole frames alone only resolve tempo in ~3 BPM steps at 140 BPM).
fn estimate_period(env: &[f32], frame_rate: f64) -> Option<f64> {
    let min_lag = (frame_rate * 60.0 / 180.0).round() as usize;
    let max_lag = (frame_rate * 60.0 / 60.0).round() as usize;
    if env.len() < max_lag * 4 {
        return None;
    }
    // Smoothed for tempo estimation only: a beat period rarely falls on a whole number of frames
    // (120 BPM is 21.5 frames), and unsmoothed, half the clicks then miss each other at lag 21 or
    // 22 - making the double period (43 frames, which does line up) look stronger and halving
    // the tempo.
    let kernel = [1.0f32, 2.0, 3.0, 2.0, 1.0];
    let smooth: Vec<f32> = (0..env.len())
        .map(|i| {
            let mut acc = 0.0;
            let mut wsum = 0.0;
            for (k, w) in kernel.iter().enumerate() {
                let j = i as isize + k as isize - 2;
                if j >= 0 && (j as usize) < env.len() {
                    acc += env[j as usize] * w;
                    wsum += w;
                }
            }
            acc / wsum
        })
        .collect();
    let score_at = |lag: usize| -> f64 {
        // The period and its double together: a true beat period also correlates at 2x, a
        // half-tempo candidate only at its own lag.
        let acf = autocorrelation(&smooth, lag) + 0.5 * autocorrelation(&smooth, lag * 2);
        let bpm = 60.0 * frame_rate / lag as f64;
        // Log-Gaussian tempo prior centred on 120 BPM, one octave wide.
        acf * (-0.5 * (bpm / 120.0).log2().powi(2)).exp()
    };
    let best = (min_lag..=max_lag).max_by(|&a, &b| score_at(a).partial_cmp(&score_at(b)).unwrap_or(std::cmp::Ordering::Equal))?;
    let (y0, y1, y2) = (score_at(best - 1), score_at(best), score_at(best + 1));
    let denom = y0 - 2.0 * y1 + y2;
    let shift = if denom.abs() > 1e-12 { (0.5 * (y0 - y2) / denom).clamp(-0.5, 0.5) } else { 0.0 };
    Some(best as f64 + shift)
}

pub fn track_beats(samples: &[f32], sample_rate: f64) -> Option<BeatAnalysis> {
    beats_from_envelope(onset_envelope(samples), sample_rate)
}

// Steps 2 and 3 on an envelope already worked out (FrameEnergies - streamed for a long file).
pub fn beats_from_envelope(env: Vec<f32>, sample_rate: f64) -> Option<BeatAnalysis> {
    let frame_rate = sample_rate / HOP as f64;
    let period_frac = estimate_period(&env, frame_rate)?;
    let period = period_frac.round().max(1.0) as usize;
    let n = env.len();
    let tightness = 100.0f64;
    let mut score = vec![0.0f64; n];
    let mut back = vec![usize::MAX; n];
    for t in 0..n {
        let lo = t.saturating_sub(2 * period);
        let hi = t.saturating_sub(period / 2);
        let mut best = 0.0f64;
        let mut best_i = usize::MAX;
        for tau in lo..hi {
            let gap = (t - tau) as f64 / period as f64;
            let penalty = tightness * gap.ln().powi(2);
            let candidate = score[tau] - penalty;
            if best_i == usize::MAX || candidate > best {
                best = candidate;
                best_i = tau;
            }
        }
        score[t] = env[t] as f64 + if best_i == usize::MAX { 0.0 } else { best.max(0.0) };
        back[t] = if best_i != usize::MAX && best > 0.0 { best_i } else { usize::MAX };
    }
    // End on the best-scoring frame within the last beat period, then backtrack.
    let start = n.saturating_sub(period);
    let mut t = (start..n).max_by(|&a, &b| score[a].partial_cmp(&score[b]).unwrap_or(std::cmp::Ordering::Equal))?;
    let mut beats_frames = vec![t];
    while back[t] != usize::MAX {
        t = back[t];
        beats_frames.push(t);
    }
    beats_frames.reverse();
    // A frame's onset sits at the centre of its analysis window.
    let offset = (WINDOW as f64 / 2.0) / sample_rate;
    let beats: Vec<f64> = beats_frames.iter().map(|&f| f as f64 / frame_rate + offset).collect();
    Some(BeatAnalysis { bpm: 60.0 * frame_rate / period_frac, beats })
}

#[cfg(test)]
mod tests {
    use super::*;

    // A synthetic track: short decaying noise-like clicks every `interval` seconds over a quiet hum.
    fn click_track(bpm: f64, seconds: f64, sr: f64) -> Vec<f32> {
        let n = (seconds * sr) as usize;
        let interval = 60.0 / bpm;
        let mut out = vec![0.0f32; n];
        let mut seed = 12345u32;
        for (i, s) in out.iter_mut().enumerate() {
            let t = i as f64 / sr;
            *s = 0.02 * (t * 110.0 * std::f64::consts::TAU).sin() as f32;
            let since = t % interval;
            if since < 0.04 {
                seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
                let noise = ((seed >> 16) as f32 / 32768.0) - 1.0;
                *s += 0.8 * noise * (1.0 - (since / 0.04) as f32);
            }
        }
        out
    }

    #[test]
    fn streaming_in_any_block_size_gives_the_same_envelope() {
        let samples = click_track(120.0, 6.0, 22050.0);
        let whole = onset_envelope(&samples);
        let mut energies = FrameEnergies::new();
        for block in samples.chunks(777) {
            energies.push(block);
        }
        let streamed = energies.envelope();
        assert_eq!(whole.len(), (samples.len() - WINDOW) / HOP + 1);
        assert_eq!(whole, streamed);
    }

    #[test]
    fn finds_tempo_and_beats_of_a_steady_click_track() {
        let sr = 22050.0;
        for bpm in [96.0, 120.0, 140.0] {
            let samples = click_track(bpm, 20.0, sr);
            let analysis = track_beats(&samples, sr).expect("analysis");
            assert!((analysis.bpm - bpm).abs() < 3.0, "bpm {} for {}", analysis.bpm, bpm);
            let interval = 60.0 / bpm;
            // Every detected beat lands within 30ms of a real click.
            for &b in &analysis.beats[2..analysis.beats.len() - 2] {
                let off = (b % interval).min(interval - b % interval);
                assert!(off < 0.03, "beat at {b:.3} is {off:.3}s off the grid at {bpm} bpm");
            }
            assert!(analysis.beats.len() as f64 > 20.0 * bpm / 60.0 * 0.8);
        }
    }
}
