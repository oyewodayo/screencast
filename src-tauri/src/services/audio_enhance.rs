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
use std::path::Path;
use std::process::{Command, Stdio};

// Integrated loudness everything is delivered at.
pub const TARGET_LUFS: f64 = -16.0;
// System audio sits this far under the voice when both are present, before ducking.
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
pub fn system_target(with_voice: bool) -> f64 {
    if with_voice {
        TARGET_LUFS - SYSTEM_UNDER_VOICE_LU
    } else {
        TARGET_LUFS
    }
}

// Ducks `[system]` under `[voice]` (sidechain: the system audio dips while you talk) and mixes
// them, ending in `[label]` - the final limiter is the caller's.
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
    let af = format!(
        "aformat=channel_layouts=mono,{},ebur128=framelog=quiet",
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
