// services/hw_decoder.rs
//
// Whether to decode a source on the GPU (`-hwaccel auto`) for an export - decided by MEASURING, not
// assumed. Every export filter runs on the CPU, so a GPU-decoded frame is copied back to system
// memory first, and that copy can cost more than decoding saved: on this project's dev machine
// (Intel iGPU) GPU decoding made a filtered 4K export 2x SLOWER than the CPU (43s vs 20s), while a
// discrete NVIDIA card's NVDEC on 4K HEVC is the kind of case where it wins big. So the first time
// a kind of source needs it, both ways race over three seconds of that very file (through a scale,
// so the copy-back is counted), and the GPU is used only if it's clearly faster. The verdict is
// cached for the session per codec and size class. Hardware decoders are bit-exact for the codecs
// involved, so the choice never changes the picture - only how long it takes.
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;

// Below this many pixels per frame the CPU decodes faster than any copy-back could repay.
const MIN_PIXELS: i64 = 2560 * 1440;
// The GPU has to win clearly: at most 60% of the CPU's time. Real wins (NVDEC on 4K HEVC) are
// several times faster; near-ties stay on the CPU, where a busy machine's timing noise (the same
// decode measured at 38s and 147s on the dev machine under load) can't flip the choice.
const REQUIRED_SPEEDUP: f64 = 0.6;
// A verdict is re-raced after this long (drivers update; a race run on a busy machine shouldn't
// stick forever).
const VERDICT_MAX_AGE_SECS: u64 = 14 * 24 * 3600;
// Each side decodes this much, twice (alternating), best time kept: a 3s race proved too noisy
// (it once called the GPU 30% faster on a machine where a full export showed it 2x slower).
const PROBE_SECONDS: &str = "5";
// Only an export decoding at least this much of a heavy source is worth the race's own cost.
pub const MIN_SECONDS_TO_PROBE: f64 = 120.0;

// key -> (use the GPU, unix seconds the race ran).
static VERDICTS: Mutex<Option<HashMap<String, (bool, u64)>>> = Mutex::new(None);

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// Verdicts outlive the session: the race runs once per machine and kind of source (until stale).
fn verdict_file() -> std::path::PathBuf {
    std::env::temp_dir().join("briefcast_hw_decode_verdicts_v2.json")
}

fn load_verdicts() -> HashMap<String, (bool, u64)> {
    std::fs::read(verdict_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn hide(cmd: &mut Command) {
    #[cfg(windows)]
    crate::commands::recording::hide_console_window(cmd);
    let _ = cmd;
}

// Decodes PROBE_SECONDS of `path` from `at` through a downscale (forcing frames into system memory,
// as the export's filters do). Wall time if it ran cleanly.
fn time_decode(ffmpeg: &Path, path: &str, at: f64, hw: bool) -> Option<f64> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-v", "error"]);
    if hw {
        cmd.args(["-hwaccel", "auto"]);
    }
    cmd.args(["-ss", &format!("{at:.3}"), "-t", PROBE_SECONDS, "-i", path, "-map", "0:v:0", "-vf", "scale=iw/2:ih/2", "-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide(&mut cmd);
    let started = Instant::now();
    let out = cmd.output().ok()?;
    (out.status.success() && out.stderr.is_empty()).then(|| started.elapsed().as_secs_f64())
}

/// Whether to add `-hwaccel auto` to an export input reading `path` (a `codec` video of
/// `width`x`height`), measured once per codec and size class per session.
pub fn should_hw_decode(ffmpeg: &Path, path: &str, codec: &str, width: i64, height: i64, sample_at: f64) -> bool {
    if width * height < MIN_PIXELS {
        return false;
    }
    let key = format!("{codec}@{}", if width * height >= 3840 * 2160 { "4k" } else { "1440p" });
    let cached = VERDICTS.lock().ok().and_then(|mut v| v.get_or_insert_with(load_verdicts).get(&key).copied());
    if let Some((verdict, at)) = cached {
        if now_secs().saturating_sub(at) < VERDICT_MAX_AGE_SECS {
            return verdict;
        }
    }
    // Warm the file cache first so neither side pays for the first read, then race twice,
    // alternating, keeping each side's best.
    let _ = time_decode(ffmpeg, path, sample_at, false);
    let mut best = (f64::INFINITY, f64::INFINITY);
    let mut failed = false;
    for _ in 0..2 {
        match (time_decode(ffmpeg, path, sample_at, true), time_decode(ffmpeg, path, sample_at, false)) {
            (Some(gpu), Some(cpu)) => best = (best.0.min(cpu), best.1.min(gpu)),
            _ => failed = true,
        }
    }
    let verdict = !failed && best.1 < best.0 * REQUIRED_SPEEDUP;
    log::info!(
        "Hardware decoding for {key} exports: cpu {:.2}s, gpu {:.2}s - {}",
        best.0,
        best.1,
        if verdict { "on" } else { "off" }
    );
    if let Ok(mut v) = VERDICTS.lock() {
        let map = v.get_or_insert_with(load_verdicts);
        map.insert(key, (verdict, now_secs()));
        let _ = std::fs::write(verdict_file(), serde_json::to_vec(&*map).unwrap_or_default());
    }
    verdict
}

#[cfg(test)]
mod tests {
    use super::*;

    // Not a unit test: races both decoders on $DUMP_SOURCE with the ffmpeg in $FFMPEG_DIR.
    #[test]
    #[ignore]
    fn race_on_a_real_file() {
        let (Ok(src), Ok(bin)) = (std::env::var("DUMP_SOURCE"), std::env::var("FFMPEG_DIR")) else { return };
        let ffmpeg = Path::new(&bin).join("ffmpeg.exe");
        let started = Instant::now();
        let cpu = time_decode(&ffmpeg, &src, 10.0, false);
        let gpu = time_decode(&ffmpeg, &src, 10.0, true);
        let verdict = should_hw_decode(&ffmpeg, &src, "hevc", 3840, 2160, 10.0);
        println!("cpu {cpu:?}s  gpu {gpu:?}s  -> use gpu: {verdict}  (whole probe {:.1}s)", started.elapsed().as_secs_f64());
    }

    #[test]
    fn small_sources_never_probe() {
        // No ffmpeg needed: anything under 1440p is decided without running anything.
        assert!(!should_hw_decode(Path::new("missing-ffmpeg"), "x.mp4", "h264", 1920, 1080, 0.0));
    }
}
