// services/audio_enhance.rs
//
// Studio-style cleanup applied to every recording's audio by default - the mic/voice, system audio,
// and the final mix - once the recording has stopped, so it can use offline-quality processing a
// live capture can't afford.
//
// The voice chain, and why each stage (measured on speech over real fan-like room noise, ~10dB
// SNR - a typical laptop mic):
//   highpass 80Hz   rumble, desk thumps, HVAC
//   arnndn          RNNoise neural denoise (the bundled bd.rnnn model): pause noise -18dB -> -38dB
//                   relative to speech, where spectral afftdn barely moved it. It keeps anything
//                   voice-like - background talkers stay, by design
//   acompressor     tames peaks so leveling doesn't chase them
//   dynaudnorm      evens out leaning in/away: a passage 12dB quieter came out within 0.1dB
//   agate           gentle expander (-30dB range, 350ms release) - pauses go to near silence
//                   (-46 to -60dB below speech) without chopping word tails
//   deesser         softens the harsh "s" sounds the boosts above bring forward
// then an exact gain to -16 LUFS (measured in the same pass - constant gain, so nothing pumps;
// single-pass loudnorm raised the noise in every pause) and a -1.5dBTP limiter: the loudness
// YouTube and podcast platforms normalize to.
//
// The previous live filter (compressor + 6dB) made pauses *louder* relative to speech (-18dB ->
// -8.5dB) and left a quiet passage 2.5dB under. Cost of this one: ~1.7% of the recording's
// length (5.2s for 5 minutes), on a background thread, once.
//
// Before all that, steady tones are notched out (see `hum`): a fan, coil whine or electrical hum
// is a fixed set of pitches - one measured here at 80.8Hz and its harmonics, a "vannnn" under every
// word - that RNNoise keeps (it's broadband noise it removes, and tones look voice-like), the 80Hz
// highpass barely touches, and dynaudnorm then lifts in every pause.
use std::path::Path;
use std::process::{Command, Stdio};

pub mod hum {
    // Finds the steady tones in a recording and builds the narrow notches that remove them.
    //
    // Speech moves - its pitch and harmonics change from one half second to the next - while a fan
    // or whine sits on the same frequencies for the whole recording, pauses included. So the
    // analysis takes the per-bin *median* spectrum of the quietest frames (the pauses: speech is
    // gone, the tone isn't), keeps peaks standing well clear of their neighbourhood, and confirms
    // each is there in most of those frames individually.
    //
    // Each tone is then removed by two `bandreject` notches in series, ~4-9Hz wide. Measured on a
    // real recording (a fan at 80.7Hz + 13 harmonics): every harmonic down 19-27dB in the pauses,
    // while white noise through the same chain loses 0.13dB overall (0.5dB at 10Hz from a tone,
    // nothing beyond). The first version used `equalizer` cuts instead: a peaking EQ's width is
    // measured at half its cut, so a -25dB cut spread into a skirt still -3.5dB 20Hz away and took
    // 3dB off the voice - don't go back to it.
    use std::io::Read;
    use std::path::Path;
    use std::process::{Command, Stdio};

    const RATE: usize = 16_000;
    const FRAME: usize = 8192; // ~2Hz bins at 16kHz
    const HOP: usize = 4096;
    // Up to two minutes is plenty to find a steady tone, and keeps the analysis well under a second.
    const MAX_SECONDS: usize = 120;
    const MIN_HZ: f64 = 40.0;
    const MAX_HZ: f64 = 6000.0;
    // How far a peak must stand above its surroundings in the median spectrum, and in each frame.
    const PROMINENCE_DB: f64 = 10.0;
    const PER_FRAME_DB: f64 = 5.0;
    // Share of the quiet frames (the pauses - see QUIET_SHARE) a tone must show up in. A voice is by
    // definition absent from the pauses, so this is what tells a fan from speech.
    const PRESENCE: f64 = 0.7;
    const QUIET_SHARE: f64 = 0.4;
    const MAX_NOTCHES: usize = 16;
    // Notch width (-3dB points): a fan's pitch wanders a little, and more in Hz the higher the
    // harmonic, so the width grows with frequency - 4.4Hz at 80Hz, 8.9Hz at 980Hz.
    const WIDTH_HZ: f64 = 4.0;
    const WIDTH_PER_HZ: f64 = 0.005;

    #[derive(Debug, Clone, PartialEq)]
    pub struct Tone {
        pub hz: f64,
        // How far it stands above its surroundings (dB) - which tones count, and which matter most.
        pub prominence_db: f64,
    }

    // The notch chain for `map` of `input`, or None when there's no steady tone (or it can't be
    // analysed - this is a refinement, never a reason for enhancement to fail).
    pub fn notch_filter(ffmpeg: &Path, input: &Path, map: &str) -> Option<String> {
        let samples = decode(ffmpeg, input, map)?;
        let tones = find_tones(&samples);
        if tones.is_empty() {
            return None;
        }
        log::info!(
            "Removing {} steady tone(s): {}",
            tones.len(),
            tones.iter().map(|t| format!("{:.1}Hz ({:.0}dB)", t.hz, t.prominence_db)).collect::<Vec<_>>().join(", ")
        );
        Some(filter_for(&tones))
    }

    // Two identical notches per tone: one notch's center is deep but narrow; a second in series
    // roughly doubles the cut across the width the tone wanders in.
    pub fn filter_for(tones: &[Tone]) -> String {
        tones
            .iter()
            .flat_map(|t| {
                let notch = format!("bandreject=f={:.1}:t=h:w={:.1}", t.hz, WIDTH_HZ + t.hz * WIDTH_PER_HZ);
                [notch.clone(), notch]
            })
            .collect::<Vec<_>>()
            .join(",")
    }

    fn decode(ffmpeg: &Path, input: &Path, map: &str) -> Option<Vec<f32>> {
        // Fast path: when analyzing a local PCM WAV we just recorded (48kHz mono/stereo, 16-bit),
        // read it directly in Rust with hound and decimate 3:1 to 16kHz (~5ms instead of spawning
        // an entire ffmpeg subprocess).
        if matches!(map, "0:a" | "0:a:0")
            && input.extension().is_some_and(|e| e.eq_ignore_ascii_case("wav"))
        {
            if let Some(samples) = decode_wav_fast(input) {
                return Some(samples);
            }
        }
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(input)
            .args(["-map", map, "-t", &MAX_SECONDS.to_string(), "-ac", "1", "-ar", &RATE.to_string(), "-f", "f32le", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        crate::commands::recording::hide_console_window(&mut cmd);
        let mut child = cmd.spawn().ok()?;
        let mut bytes = Vec::new();
        child.stdout.take()?.read_to_end(&mut bytes).ok()?;
        let _ = child.wait();
        Some(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
    }

    // Reads up to MAX_SECONDS from a local 16-bit integer WAV (at an integer multiple of RATE,
    // e.g. 48kHz -> 3:1 box decimation to 16kHz) without spawning ffmpeg.
    fn decode_wav_fast(path: &Path) -> Option<Vec<f32>> {
        let mut reader = hound::WavReader::open(path).ok()?;
        let spec = reader.spec();
        if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
            return None;
        }
        let sr = spec.sample_rate as usize;
        if sr < RATE || sr % RATE != 0 || spec.channels == 0 {
            return None;
        }
        let decimate = sr / RATE;
        let ch = spec.channels as usize;
        let max_out = MAX_SECONDS * RATE;
        let mut out = Vec::with_capacity(max_out.min(reader.len() as usize / (ch * decimate) + 1));
        let mut iter = reader.samples::<i16>();
        let inv = 1.0f32 / (32768.0 * (ch * decimate) as f32);
        'outer: while out.len() < max_out {
            let mut acc = 0.0f32;
            for _ in 0..(decimate * ch) {
                match iter.next() {
                    Some(Ok(s)) => acc += s as f32,
                    _ => break 'outer,
                }
            }
            out.push(acc * inv);
        }
        Some(out)
    }

    pub fn find_tones(samples: &[f32]) -> Vec<Tone> {
        use rayon::prelude::*;
        use realfft::RealFftPlanner;

        if samples.len() < FRAME * 4 {
            return Vec::new();
        }
        let window: Vec<f32> = (0..FRAME)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FRAME - 1) as f32).cos())
            .collect();
        let mut planner = RealFftPlanner::<f32>::new();
        let r2c = planner.plan_fft_forward(FRAME);

        // Compute per-frame power spectra in parallel via SIMD-accelerated realfft + rayon
        // (orders of magnitude faster than the old single-threaded trig-loop FFT).
        let starts: Vec<usize> = (0..=samples.len() - FRAME).step_by(HOP).collect();
        let mut frames: Vec<(f32, Vec<f32>)> = starts
            .into_par_iter()
            .filter_map(|start| {
                let chunk = &samples[start..start + FRAME];
                if !chunk.iter().any(|s| s.abs() > 1e-6) {
                    return None;
                }
                let energy: f32 = chunk.iter().map(|s| s * s).sum();
                let mut input: Vec<f32> = chunk.iter().zip(&window).map(|(s, w)| s * w).collect();
                let mut spectrum = r2c.make_output_vec();
                let mut scratch = r2c.make_scratch_vec();
                r2c.process_with_scratch(&mut input, &mut spectrum, &mut scratch).ok()?;
                let db: Vec<f32> = spectrum
                    .iter()
                    .take(FRAME / 2)
                    .map(|c| 10.0 * (c.re * c.re + c.im * c.im + 1e-20).log10())
                    .collect();
                Some((energy, db))
            })
            .collect();

        // The pauses: the quietest frames.
        frames.sort_by(|a, b| a.0.total_cmp(&b.0));
        let quiet = ((frames.len() as f64 * QUIET_SHARE).ceil() as usize).max(4);
        if frames.len() < quiet {
            return Vec::new();
        }
        let frames: Vec<Vec<f32>> = frames.into_iter().take(quiet).map(|(_, f)| f).collect();
        let bins = FRAME / 2;
        let median: Vec<f32> = (0..bins)
            .map(|k| {
                let mut v: Vec<f32> = frames.iter().map(|f| f[k]).collect();
                v.sort_by(|a, b| a.total_cmp(b));
                v[v.len() / 2]
            })
            .collect();

        let hz_per_bin = RATE as f64 / FRAME as f64;
        let lo = (MIN_HZ / hz_per_bin) as usize;
        let hi = ((MAX_HZ / hz_per_bin) as usize).min(bins - 2);
        let mut tones = Vec::new();
        for k in lo.max(1)..hi {
            if !(median[k] > median[k - 1] && median[k] >= median[k + 1]) {
                continue;
            }
            let prominence = (median[k] - floor(&median, k)) as f64;
            if prominence < PROMINENCE_DB {
                continue;
            }
            let present = frames.iter().filter(|f| {
                let best = f[k - 1].max(f[k]).max(f[k + 1]);
                (best - floor(f, k)) as f64 >= PER_FRAME_DB
            });
            if (present.count() as f64) < PRESENCE * frames.len() as f64 {
                continue;
            }
            // Parabolic interpolation between bins for the exact pitch.
            let (a, b, c) = (median[k - 1] as f64, median[k] as f64, median[k + 1] as f64);
            let offset = 0.5 * (a - c) / (a - 2.0 * b + c);
            let offset = if offset.is_finite() { offset.clamp(-0.5, 0.5) } else { 0.0 };
            tones.push(Tone { hz: (k as f64 + offset) * hz_per_bin, prominence_db: prominence });
        }
        tones.sort_by(|a, b| b.prominence_db.total_cmp(&a.prominence_db));
        tones.truncate(MAX_NOTCHES);
        tones.sort_by(|a, b| a.hz.total_cmp(&b.hz));
        tones
    }

    // The spectrum's level around bin `k`: the median of a ±40Hz neighbourhood, leaving out ±6Hz
    // around the bin itself (the peak's own skirt).
    fn floor(spectrum: &[f32], k: usize) -> f32 {
        let span = 20; // bins, ~40Hz
        let gap = 3; // bins, ~6Hz
        let mut v: Vec<f32> = (k.saturating_sub(span)..(k + span + 1).min(spectrum.len()))
            .filter(|&i| i + gap < k || i > k + gap)
            .map(|i| spectrum[i])
            .collect();
        v.sort_by(|a, b| a.total_cmp(b));
        v[v.len() / 2]
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        // Deterministic noise without a dependency.
        fn noise(n: usize, seed: u64) -> Vec<f32> {
            let mut x = seed;
            (0..n)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    (x as f64 / u64::MAX as f64 * 2.0 - 1.0) as f32
                })
                .collect()
        }

        #[test]
        fn finds_a_fan_and_its_harmonics_but_not_a_moving_voice() {
            let n = RATE * 30;
            let room = noise(n, 7);
            let pi2 = 2.0 * std::f64::consts::PI;
            let samples: Vec<f32> = (0..n)
                .map(|i| {
                    let t = i as f64 / RATE as f64;
                    // The hum measured in a real recording: 80.8Hz and harmonics, ~-60dBFS.
                    let hum: f64 = (1..=5).map(|h| 0.001 * (pi2 * 80.8 * h as f64 * t).sin()).sum();
                    // "Speech": a loud voice whose pitch glides 110-220Hz, with harmonics.
                    let f0 = 165.0 + 55.0 * (pi2 * 0.4 * t).sin();
                    let phase = pi2 * (165.0 * t - 55.0 / (pi2 * 0.4) * (pi2 * 0.4 * t).cos());
                    let voice: f64 = (1..=6).map(|h| 0.05 / h as f64 * (phase * h as f64).sin()).sum::<f64>()
                        * if (t / 4.0).fract() < 0.625 { 1.0 } else { 0.0 }; // 2.5s phrases, 1.5s pauses
                    let _ = f0;
                    (hum + voice) as f32 + room[i] * 0.0003
                })
                .collect();
            let tones = find_tones(&samples);
            let hz: Vec<f64> = tones.iter().map(|t| t.hz).collect();
            for h in 1..=5 {
                let want = 80.8 * h as f64;
                assert!(hz.iter().any(|f| (f - want).abs() < 1.0), "missed {want}Hz in {hz:?}");
            }
            assert_eq!(tones.len(), 5, "found more than the hum: {tones:?}");
        }

        // Not a unit test: prints the notches for a real recording ($HUM_FILE, $FFMPEG_DIR).
        #[test]
        #[ignore]
        fn notches_for_a_real_recording() {
            let (Ok(file), Ok(dir)) = (std::env::var("HUM_FILE"), std::env::var("FFMPEG_DIR")) else { return };
            let ffmpeg = std::path::Path::new(&dir).join("ffmpeg.exe");
            let t = std::time::Instant::now();
            let f = notch_filter(&ffmpeg, std::path::Path::new(&file), "0:a:0");
            println!("analysis {:?}
FILTER {}", t.elapsed(), f.unwrap_or_default());
        }

        // Verify the realfft-backed hum detector still matches a direct DFT on a test signal.
        #[test]
        fn fft_matches_a_direct_dft() {
            use realfft::RealFftPlanner;
            let n = 256;
            let x = noise(n, 11);
            let mut planner = RealFftPlanner::<f32>::new();
            let r2c = planner.plan_fft_forward(n);
            let mut input = x.clone();
            let mut spec = r2c.make_output_vec();
            r2c.process(&mut input, &mut spec).unwrap();
            for k in 0..n / 2 {
                let (mut dr, mut di) = (0.0f64, 0.0f64);
                for (t, &v) in x.iter().enumerate() {
                    let a = -2.0 * std::f64::consts::PI * (k * t) as f64 / n as f64;
                    dr += v as f64 * a.cos();
                    di += v as f64 * a.sin();
                }
                assert!((spec[k].re as f64 - dr).abs() < 1e-3 && (spec[k].im as f64 - di).abs() < 1e-3, "bin {k}");
            }
        }

        #[test]
        fn a_clean_recording_gets_no_notches() {
            let samples: Vec<f32> = noise(RATE * 20, 3).iter().map(|s| s * 0.01).collect();
            assert!(find_tones(&samples).is_empty());
        }

        #[test]
        fn notches_are_narrow_true_notches() {
            let f = filter_for(&[Tone { hz: 80.84, prominence_db: 22.0 }, Tone { hz: 980.0, prominence_db: 40.0 }]);
            assert_eq!(
                f,
                "bandreject=f=80.8:t=h:w=4.4,bandreject=f=80.8:t=h:w=4.4,bandreject=f=980.0:t=h:w=8.9,bandreject=f=980.0:t=h:w=8.9"
            );
        }
    }
}

// Integrated loudness everything is delivered at.
pub const TARGET_LUFS: f64 = -16.0;
// System audio sits this far under the voice when both are present, before ducking.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const SYSTEM_UNDER_VOICE_LU: f64 = 10.0;
// Final safety limiter, -1.5dBFS - the headroom lossy encoders need to avoid clipping on decode.
pub const LIMITER: &str = "alimiter=limit=0.84:attack=2:release=50:level=false";

// The voice chain, ending before the loudness gain (which needs the measurement). `model` is the
// RNNoise model path, already filtergraph-escaped; without one, spectral denoise stands in.
pub fn voice_chain(model: Option<&str>) -> String {
    let denoise = match model {
        Some(m) => format!("arnndn=m='{}'", m),
        None => "afftdn=nr=12:nf=-40:tn=1".to_string(),
    };
    format!(
        "highpass=f=80,{},acompressor=threshold=-24dB:ratio=3:attack=5:release=250:knee=6,\
         dynaudnorm=f=250:g=15:p=0.9:m=15,\
         agate=threshold=0.02:ratio=3:attack=10:release=350:range=0.03,deesser=i=0.4",
        denoise
    )
}

// Filtergraph-safe form of a file path (drive colon escaped, forward slashes).
pub fn escape_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "")
}

// Gain (dB) bringing `measured` LUFS to `target`, clamped so a near-silent track isn't blown up
// into pure noise.
pub fn gain_to(target: f64, measured: Option<f64>) -> f64 {
    match measured {
        Some(i) if i.is_finite() && i > -70.0 => (target - i).clamp(-20.0, 30.0),
        _ => 0.0,
    }
}

// The system-audio target: under the voice when there is one, the delivery level when it's alone.
// System audio is ducked under the voice here only on Windows, where loopback capture is a separate
// file mixed at the end; macOS and Linux mix it live while recording (amix), so it isn't ducked yet.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn system_target(with_voice: bool) -> f64 {
    if with_voice {
        TARGET_LUFS - SYSTEM_UNDER_VOICE_LU
    } else {
        TARGET_LUFS
    }
}

// Ducks `[system]` under `[voice]` (sidechain: the system audio dips while you talk) and mixes
// them, ending in `[label]` - the final limiter is the caller's.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn duck_and_mix(voice: &str, system: &str, label: &str) -> String {
    format!(
        "{v}asplit=2[dv][dk];{s}[dk]sidechaincompress=threshold=0.03:ratio=4:attack=30:release=500:makeup=1[ds];\
         [dv][ds]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[{l}]",
        v = voice,
        s = system,
        l = label
    )
}

// Pass 1 for a voice track: `map` from `input` through the voice chain to a mono PCM WAV at
// `out`, measuring its loudness on the way. Returns that loudness (LUFS), when measurable.
pub fn clean_voice(
    ffmpeg: &Path,
    input: &Path,
    map: &str,
    out: &Path,
    model: Option<&str>,
) -> Result<Option<f64>, String> {
    let hum = hum::notch_filter(ffmpeg, input, map);
    let af = format!(
        "aformat=channel_layouts=mono,{}{},ebur128=framelog=quiet",
        hum.map(|h| format!("{},", h)).unwrap_or_default(),
        voice_chain(model)
    );
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostats", "-y", "-i"])
        .arg(input)
        .args(["-map", map, "-af", &af, "-c:a", "pcm_s16le", "-ar", "48000"])
        .arg(out);
    run_measuring(cmd)
}

// Loudness of `map` in `input` without writing anything.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn measure(ffmpeg: &Path, input: &Path, map: &str) -> Result<Option<f64>, String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostats", "-i"])
        .arg(input)
        .args(["-map", map, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
    run_measuring(cmd)
}

fn run_measuring(mut cmd: Command) -> Result<Option<f64>, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    crate::commands::recording::hide_console_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("Failed to run ffmpeg: {}", e))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        let tail: Vec<&str> = stderr.lines().rev().take(3).collect();
        return Err(format!("Audio enhancement failed: {}", tail.join(" | ")));
    }
    Ok(parse_integrated(&stderr))
}

// The integrated loudness from ebur128's end-of-stream summary ("    I:  -23.1 LUFS").
fn parse_integrated(stderr: &str) -> Option<f64> {
    let summary = &stderr[stderr.rfind("Summary:")?..];
    summary
        .lines()
        .find(|l| l.trim_start().starts_with("I:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

// Applies the full treatment to a recording's own audio in place - for recordings written
// straight to their final file (camera and audio-only modes, and every mode on macOS/Linux),
// which have no assembly step to do it in. Video is stream-copied; only the audio is redone.
pub fn enhance_in_place(ffmpeg: &Path, path: &Path, model: Option<&str>) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let audio_only = matches!(ext.as_str(), "mp3" | "wav" | "aac" | "wma" | "m4a" | "ogg" | "flac");
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("recording");
    let dir = std::env::temp_dir().join("briefcast-capture");
    let _ = std::fs::create_dir_all(&dir);
    let clean = dir.join(format!("{}.voice.wav", stem));
    let finished = path.with_file_name(format!(".{}.enhanced.{}", stem, ext));

    let loudness = clean_voice(ffmpeg, path, "0:a:0", &clean, model)?;
    let af = format!("volume={:.2}dB,{},aformat=channel_layouts=stereo", gain_to(TARGET_LUFS, loudness), LIMITER);

    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-y", "-i"]).arg(path).arg("-i").arg(&clean);
    if !audio_only {
        cmd.args(["-map", "0:v?", "-c:v", "copy"]);
    }
    cmd.args(["-map", "1:a", "-af", &af]);
    cmd.args(audio_codec_for(&ext));
    cmd.arg(&finished);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    crate::commands::recording::hide_console_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("Failed to run ffmpeg: {}", e));
    let _ = std::fs::remove_file(&clean);
    let out = out?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&finished);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(3).collect();
        return Err(format!("Audio enhancement failed: {}", tail.join(" | ")));
    }
    std::fs::rename(&finished, path).map_err(|e| format!("Failed to replace the recording: {}", e))
}

// Audio codec (and container flags) for a final file of extension `ext`.
pub fn audio_codec_for(ext: &str) -> Vec<String> {
    let args: &[&str] = match ext {
        "avi" | "wav" => &["-c:a", "pcm_s16le"],
        "webm" | "ogg" => &["-c:a", "libvorbis", "-b:a", "192k"],
        "mp3" => &["-c:a", "libmp3lame", "-b:a", "192k"],
        "wma" => &["-c:a", "wmav2", "-b:a", "192k"],
        "flac" => &["-c:a", "flac"],
        "mkv" | "aac" => &["-c:a", "aac", "-b:a", "192k"],
        // mp4/mov/m4a: moov-first, so the file opens and seeks instantly.
        _ => &["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    };
    args.iter().map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_summary_not_the_running_lines() {
        let stderr = "[Parsed_ebur128_0 @ 1] t: 1.0 M: -30 S: -30 I: -40.0 LUFS\n\
                      [Parsed_ebur128_0 @ 1] Summary:\n\n  Integrated loudness:\n    I:         -23.4 LUFS\n";
        assert_eq!(parse_integrated(stderr), Some(-23.4));
    }

    #[test]
    fn gain_is_clamped_and_silence_left_alone() {
        assert_eq!(gain_to(-16.0, Some(-30.0)), 14.0);
        assert_eq!(gain_to(-16.0, Some(-60.0)), 30.0);
        assert_eq!(gain_to(-16.0, Some(-120.0)), 0.0);
        assert_eq!(gain_to(-16.0, None), 0.0);
    }

    #[test]
    fn falls_back_to_spectral_denoise_without_a_model() {
        assert!(voice_chain(None).contains("afftdn"));
        assert!(voice_chain(Some("C\\:/m.rnnn")).contains("arnndn=m='C\\:/m.rnnn'"));
    }
}
