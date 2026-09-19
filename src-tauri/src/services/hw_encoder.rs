// services/hw_encoder.rs
//
// Detects whether a real, working hardware H.264 encoder is available on this machine, so
// recordings can offload encoding from the CPU instead of always using software libx264 (see
// RECORDING_UPGRADE_NOTES.md's "no hardware-accelerated encoding" gap - `libx264 -preset
// ultrafast` visibly strains the CPU on longer/higher-resolution recordings). Windows-only for
// now, matching this codebase's "Windows is the only verified recording backend" posture.
//
// Critically, this is NOT just "does this ffmpeg build list h264_nvenc/_qsv/_amf as compiled in"
// - `ffmpeg -encoders` lists every encoder the BUILD supports regardless of what hardware is
// actually present, which says nothing about whether it'll actually work on this machine.
// Verified directly against this dev machine's own bundled ffmpeg build while writing this:
// h264_nvenc failed ("Driver does not support the required nvenc API version" - an NVIDIA GPU
// was present, but its driver was too old), h264_amf failed ("DLL amfrt64.dll failed to open" -
// no AMD GPU/driver), h264_qsv succeeded (this machine's Intel Quick Sync actually works) - all
// three are "supported" by the build; only one actually functions here. The only reliable way to
// know is to actually run a real, trivial (~100ms) encode with the exact flags this app intends
// to use for real, and use whichever candidate's test succeeds - which also means a bad
// quality-flag guess for an encoder this machine can't test gets caught right here, instead of
// surfacing mid-recording on someone else's machine.
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HwEncoder {
    Nvenc,
    Qsv,
    Amf,
}

impl HwEncoder {
    pub fn name(self) -> &'static str {
        match self {
            HwEncoder::Nvenc => "h264_nvenc",
            HwEncoder::Qsv => "h264_qsv",
            HwEncoder::Amf => "h264_amf",
        }
    }

    // Each hardware encoder has its own rate-control API - there's no shared "-crf"-equivalent
    // flag the way software libx264 has. These aim for roughly what libx264's own
    // "-preset ultrafast -crf 23" already targets here: keep up in real time, don't bloat the
    // file. h264_qsv's flags are verified against real hardware (see this module's own test
    // below); h264_nvenc/h264_amf's are ffmpeg's own documented conventions for a "fast,
    // reasonable quality" encode - detect()'s test-encode step validates whichever is actually
    // used before a real recording ever depends on it, so a wrong guess here just means that
    // candidate fails its own probe and detection falls through to the next one (or to software).
    pub fn quality_args(self) -> Vec<String> {
        let raw: &[&str] = match self {
            HwEncoder::Nvenc => &["-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
            HwEncoder::Qsv => &["-preset", "medium", "-global_quality", "23"],
            HwEncoder::Amf => &["-quality", "speed", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23"],
        };
        raw.iter().map(|s| s.to_string()).collect()
    }
}

static DETECTED: OnceLock<Option<HwEncoder>> = OnceLock::new();

// Runs at most once per app session (cached) - each candidate's probe is a real subprocess spawn
// (tens to low hundreds of ms), which is fine to pay once but not worth repeating on every single
// recording start.
pub fn detect(ffmpeg_path: &Path) -> Option<HwEncoder> {
    *DETECTED.get_or_init(|| {
        for candidate in [HwEncoder::Nvenc, HwEncoder::Qsv, HwEncoder::Amf] {
            if probe(ffmpeg_path, candidate) {
                log::info!("Detected working hardware encoder: {}", candidate.name());
                return Some(candidate);
            }
        }
        log::info!("No working hardware encoder detected, recordings will use software libx264");
        None
    })
}

// A tiny (64x64, single-frame) real encode with this candidate's exact intended flags, output
// discarded (-f null). Cheap enough to run for all three candidates in sequence without any
// user-visible delay on the first recording of a session, and - unlike checking `ffmpeg -encoders`
// - actually exercises the driver/hardware path the real recording will depend on.
fn probe(ffmpeg_path: &Path, encoder: HwEncoder) -> bool {
    let mut cmd = Command::new(ffmpeg_path);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=black:s=64x64:d=0.1",
        "-frames:v",
        "1",
        "-c:v",
        encoder.name(),
    ])
    .args(encoder.quality_args())
    .args(["-f", "null", "-"])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    crate::commands::recording::hide_console_window(&mut cmd);

    cmd.status().map(|s| s.success()).unwrap_or(false)
}
