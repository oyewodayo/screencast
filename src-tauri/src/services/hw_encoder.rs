// services/hw_encoder.rs
//
// Detects whether a real, working hardware H.264 encoder is available on this machine, so
// recordings can offload encoding from the CPU instead of always using software libx264 (see
// RECORDING_UPGRADE_NOTES.md - `libx264 -preset ultrafast` visibly strains the CPU on longer or
// higher-resolution recordings).
//
// Critically, this is NOT just "does this ffmpeg build list the encoder as compiled in".
// `ffmpeg -encoders` lists every encoder the BUILD supports regardless of what hardware is
// actually present, which says nothing about whether it will work here. Verified directly against
// this dev machine's own bundled ffmpeg while writing this: h264_nvenc failed ("Driver does not
// support the required nvenc API version" - an NVIDIA GPU was present, but its driver was too
// old), h264_amf failed ("DLL amfrt64.dll failed to open" - no AMD GPU), h264_qsv succeeded. All
// three are "supported" by the build; only one functions. Later the same lesson repeated with
// vp9_qsv, which this build lists and which produces a 0-byte file on this hardware.
//
// So the only reliable test is to actually run a tiny encode with the exact flags the app intends
// to use, and keep whichever candidate's test succeeds.
//
// Each encoder also gets more than one candidate *rate-control* mode, tried in order. Hardware
// encoders disagree about which modes they expose - h264_videotoolbox's constant-quality mode in
// particular is unavailable on some Intel Macs, where it errors out rather than degrading - and
// without a fallback a machine like that would silently drop all the way back to software x264
// despite having a perfectly good hardware encoder. Probing the fallback costs one extra ~100ms
// subprocess on machines that need it and nothing on machines that don't.
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

// Which variants are reachable depends on the target: candidates_for_platform only offers the
// ones that can exist on the platform being compiled for, so every build legitimately leaves some
// variants unconstructed. That is the design, not dead code.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HwEncoder {
    Nvenc,
    Qsv,
    Amf,
    /// Apple's hardware encoder. Present on every Mac this app can run on (Intel and Apple
    /// Silicon alike), which makes it far less of a gamble than the PC-side encoders - there is
    /// no "maybe this machine has the right GPU" question, only which rate-control mode it takes.
    VideoToolbox,
}

impl HwEncoder {
    pub fn name(self) -> &'static str {
        match self {
            HwEncoder::Nvenc => "h264_nvenc",
            HwEncoder::Qsv => "h264_qsv",
            HwEncoder::Amf => "h264_amf",
            HwEncoder::VideoToolbox => "h264_videotoolbox",
        }
    }

    // Rate-control candidates, best first.
    //
    // There is no shared "-crf"-equivalent across hardware encoders the way software libx264 has
    // one, so each gets its own. The first entry targets roughly what `libx264 -preset ultrafast
    // -crf 23` already aims for here: keep up in real time, don't bloat the file. The second is a
    // plain average-bitrate mode, which every one of these encoders supports unconditionally -
    // it exists purely so a device that rejects the constant-quality mode still gets hardware
    // encoding instead of falling back to the CPU.
    fn quality_candidates(self) -> Vec<Vec<&'static str>> {
        match self {
            HwEncoder::Nvenc => vec![
                vec!["-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
                vec!["-preset", "p4", "-b:v", "12M"],
            ],
            HwEncoder::Qsv => vec![
                vec!["-preset", "medium", "-global_quality", "23"],
                vec!["-preset", "medium", "-b:v", "12M"],
            ],
            HwEncoder::Amf => vec![
                vec!["-quality", "speed", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23"],
                vec!["-quality", "speed", "-b:v", "12M"],
            ],
            HwEncoder::VideoToolbox => vec![
                // -realtime tells VideoToolbox to favour keeping up over squeezing the last bit
                // of efficiency out, which is what a live screen capture wants.
                vec!["-realtime", "1", "-q:v", "55"],
                vec!["-realtime", "1", "-b:v", "12M"],
            ],
        }
    }

    // The same modes aimed higher, for re-encoding footage that has already been compressed once
    // (see save_phone_camera_capture) where the ordinary target would stack a second generation
    // of artefacts on the first. Index-matched to quality_candidates so whichever mode probed
    // successfully has a corresponding high-quality form.
    fn high_quality_candidates(self) -> Vec<Vec<&'static str>> {
        match self {
            HwEncoder::Nvenc => vec![
                vec!["-preset", "p5", "-rc", "vbr", "-cq", "18", "-b:v", "0"],
                vec!["-preset", "p5", "-b:v", "20M"],
            ],
            HwEncoder::Qsv => vec![
                vec!["-preset", "slow", "-global_quality", "18"],
                vec!["-preset", "slow", "-b:v", "20M"],
            ],
            HwEncoder::Amf => vec![
                vec!["-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "18"],
                vec!["-quality", "quality", "-b:v", "20M"],
            ],
            HwEncoder::VideoToolbox => vec![
                vec!["-realtime", "0", "-q:v", "75"],
                vec!["-realtime", "0", "-b:v", "20M"],
            ],
        }
    }

    // Which encoders are worth probing at all on this platform. Probing one that cannot exist
    // here just burns a subprocess on every fresh app session.
    fn candidates_for_platform() -> &'static [HwEncoder] {
        #[cfg(target_os = "windows")]
        {
            &[HwEncoder::Nvenc, HwEncoder::Qsv, HwEncoder::Amf]
        }
        #[cfg(target_os = "macos")]
        {
            // avfoundation machines are Macs, and every Mac has VideoToolbox. NVENC can't appear
            // here (Apple dropped NVIDIA support long before this app's minimum), and QSV/AMF are
            // PC-only paths.
            &[HwEncoder::VideoToolbox]
        }
        #[cfg(target_os = "linux")]
        {
            // NVENC only, deliberately. VAAPI is the other encoder worth having on Linux and is
            // the *common* one (Intel/AMD laptops), but it cannot be swapped in the way this
            // module swaps the others: it needs a `-vaapi_device` plus frames uploaded to the GPU
            // (`format=nv12,hwupload`) inside the filter chain, which means touching every mode's
            // filter graph rather than just the codec flags. Worth doing, but as its own change
            // on hardware where it can actually be tested - see RECORDING_UPGRADE_NOTES.md.
            &[HwEncoder::Nvenc]
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            &[]
        }
    }
}

/// A hardware encoder that has been proven to work on this machine, together with the rate-control
/// mode it actually accepted.
#[derive(Clone, Debug)]
pub struct HwEncoding {
    encoder: HwEncoder,
    mode: usize,
}

impl HwEncoding {
    pub fn name(&self) -> &'static str {
        self.encoder.name()
    }

    pub fn quality_args(&self) -> Vec<String> {
        pick(self.encoder.quality_candidates(), self.mode)
    }

    pub fn high_quality_args(&self) -> Vec<String> {
        pick(self.encoder.high_quality_candidates(), self.mode)
    }
}

fn pick(mut candidates: Vec<Vec<&'static str>>, index: usize) -> Vec<String> {
    let chosen = if index < candidates.len() {
        candidates.swap_remove(index)
    } else {
        candidates.swap_remove(0)
    };
    chosen.into_iter().map(|s| s.to_string()).collect()
}

static DETECTED: OnceLock<Option<HwEncoding>> = OnceLock::new();

/// Runs at most once per app session (cached) - each probe is a real subprocess spawn (tens to low
/// hundreds of ms), fine to pay once but not worth repeating on every recording start.
pub fn detect(ffmpeg_path: &Path) -> Option<HwEncoding> {
    DETECTED
        .get_or_init(|| {
            for &candidate in HwEncoder::candidates_for_platform() {
                for mode in 0..candidate.quality_candidates().len() {
                    let encoding = HwEncoding {
                        encoder: candidate,
                        mode,
                    };
                    if probe(ffmpeg_path, &encoding) {
                        log::info!(
                            "Detected working hardware encoder: {} (rate-control mode {})",
                            candidate.name(),
                            mode
                        );
                        return Some(encoding);
                    }
                }
            }
            log::info!("No working hardware encoder detected, recordings will use software libx264");
            None
        })
        .clone()
}

// A tiny (64x64, single-frame) real encode with this candidate's exact intended flags, output
// discarded. Cheap enough to run through the candidate list without a user-visible delay on the
// first recording of a session, and - unlike reading `ffmpeg -encoders` - actually exercises the
// driver/hardware path the real recording will depend on.
fn probe(ffmpeg_path: &Path, encoding: &HwEncoding) -> bool {
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
        encoding.name(),
    ])
    .args(encoding.quality_args())
    .args(["-f", "null", "-"])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    crate::commands::recording::hide_console_window(&mut cmd);

    cmd.status().map(|s| s.success()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_encoder_has_matching_standard_and_high_quality_modes() {
        // quality_args/high_quality_args are looked up by the same index, so a mismatch would
        // silently hand back the wrong rate-control mode for re-encodes.
        for enc in [
            HwEncoder::Nvenc,
            HwEncoder::Qsv,
            HwEncoder::Amf,
            HwEncoder::VideoToolbox,
        ] {
            assert_eq!(
                enc.quality_candidates().len(),
                enc.high_quality_candidates().len(),
                "{} has mismatched candidate counts",
                enc.name()
            );
            assert!(!enc.quality_candidates().is_empty());
        }
    }

    #[test]
    fn every_encoder_offers_a_plain_bitrate_fallback() {
        // The whole point of the second candidate: a mode every one of these encoders supports
        // unconditionally, so a device that rejects constant-quality still gets hardware encoding.
        for enc in [
            HwEncoder::Nvenc,
            HwEncoder::Qsv,
            HwEncoder::Amf,
            HwEncoder::VideoToolbox,
        ] {
            let last = enc.quality_candidates().pop().unwrap();
            assert!(
                last.contains(&"-b:v"),
                "{}'s fallback mode should be plain bitrate, got {:?}",
                enc.name(),
                last
            );
        }
    }

    #[test]
    fn this_platform_probes_something_sensible() {
        let list = HwEncoder::candidates_for_platform();
        if cfg!(target_os = "macos") {
            assert_eq!(list, &[HwEncoder::VideoToolbox]);
        } else if cfg!(any(target_os = "windows", target_os = "linux")) {
            assert!(!list.is_empty());
        }
    }

    #[test]
    fn mode_index_out_of_range_falls_back_rather_than_panicking() {
        let e = HwEncoding {
            encoder: HwEncoder::Qsv,
            mode: 99,
        };
        assert!(!e.quality_args().is_empty());
    }
}
