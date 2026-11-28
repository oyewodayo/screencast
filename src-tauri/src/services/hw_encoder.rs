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
    /// Linux Intel/AMD hardware H.264 encoder via VA-API (`/dev/dri/renderD*`). Requires
    /// `-vaapi_device <node>` before inputs and `format=nv12,hwupload` at the end of the video
    /// filter graph instead of `-pix_fmt yuv420p`.
    Vaapi,
}

impl HwEncoder {
    pub fn name(self) -> &'static str {
        match self {
            HwEncoder::Nvenc => "h264_nvenc",
            HwEncoder::Qsv => "h264_qsv",
            HwEncoder::Amf => "h264_amf",
            HwEncoder::VideoToolbox => "h264_videotoolbox",
            HwEncoder::Vaapi => "h264_vaapi",
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
            HwEncoder::Vaapi => vec![
                vec!["-rc_mode", "CQP", "-qp", "23"],
                vec!["-b:v", "12M"],
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
            HwEncoder::Vaapi => vec![
                vec!["-rc_mode", "CQP", "-qp", "18"],
                vec!["-b:v", "20M"],
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
            // Try NVENC first (discrete NVIDIA GPUs), then VA-API (Intel/AMD integrated & discrete
            // GPUs via /dev/dri/renderD*).
            &[HwEncoder::Nvenc, HwEncoder::Vaapi]
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            &[]
        }
    }
}

/// Discovers a usable DRM render node for VA-API on Linux (`/dev/dri/renderD128` preferred).
#[cfg(target_os = "linux")]
fn discover_vaapi_render_node() -> Option<String> {
    let default = Path::new("/dev/dri/renderD128");
    if default.exists() {
        return Some(default.to_string_lossy().into_owned());
    }
    let mut nodes: Vec<String> = std::fs::read_dir("/dev/dri")
        .ok()?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with("renderD").then(|| format!("/dev/dri/{name}"))
        })
        .collect();
    nodes.sort();
    nodes.into_iter().next()
}

#[cfg(not(target_os = "linux"))]
fn discover_vaapi_render_node() -> Option<String> {
    None
}

/// A hardware encoder that has been proven to work on this machine, together with the rate-control
/// mode it actually accepted.
#[derive(Clone, Debug)]
pub struct HwEncoding {
    encoder: HwEncoder,
    mode: usize,
    vaapi_device: Option<String>,
}

impl HwEncoding {
    pub fn name(&self) -> &'static str {
        self.encoder.name()
    }

    pub fn is_vaapi(&self) -> bool {
        self.encoder == HwEncoder::Vaapi
    }

    /// Global ffmpeg arguments that must appear BEFORE input `-i` flags (non-empty for VA-API).
    pub fn pre_input_args(&self) -> Vec<String> {
        if self.encoder == HwEncoder::Vaapi {
            let dev = self
                .vaapi_device
                .as_deref()
                .unwrap_or("/dev/dri/renderD128");
            vec!["-vaapi_device".to_string(), dev.to_string()]
        } else {
            Vec::new()
        }
    }

    /// Video filter tail needed to upload software frames to the encoder's GPU surfaces.
    pub fn video_filter_suffix(&self) -> Option<&'static str> {
        (self.encoder == HwEncoder::Vaapi).then_some("format=nv12,hwupload")
    }

    /// Whether `-pix_fmt yuv420p` should stay on the output stream. VA-API encodes GPU-resident
    /// `vaapi` surfaces produced by `format=nv12,hwupload`, so `-pix_fmt yuv420p` must be omitted.
    pub fn keep_pix_fmt(&self) -> bool {
        self.encoder != HwEncoder::Vaapi
    }

    pub fn quality_args(&self) -> Vec<String> {
        pick(self.encoder.quality_candidates(), self.mode)
    }

    pub fn high_quality_args(&self) -> Vec<String> {
        pick(self.encoder.high_quality_candidates(), self.mode)
    }

    /// Encoder flags for an editor export at a quality tier ("small" / "standard" / "high" - the
    /// Save button's picker), aimed at matching the software x264 each tier used to use
    /// (veryfast crf 28 / medium crf 23 / slow crf 18) frame for frame while encoding many times
    /// faster. Calibrated against x264 on real footage (PSNR / SSIM to a lossless reference, this
    /// machine's QSV): global_quality 26 / 23 / 17 land level with or just above those x264
    /// settings - 5x faster at standard, 12x at high, files ~15-30% larger. The other encoders use
    /// their constant-quality scales' equivalent points, quality-first presets.
    ///
    /// None unless constant-quality mode probed successfully (mode 0): a bitrate-only fallback
    /// can't promise the tier's quality, so exports then stay on software x264.
    pub fn export_args(&self, tier: &str) -> Option<Vec<String>> {
        if self.mode != 0 || self.encoder == HwEncoder::Vaapi {
            return None;
        }
        let pick3 = |small: &'static str, standard: &'static str, high: &'static str| match tier {
            "small" => small,
            "high" => high,
            _ => standard,
        };
        let args: Vec<&str> = match self.encoder {
            HwEncoder::Nvenc => {
                let cq = pick3("27", "21", "17");
                vec!["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", cq, "-b:v", "0", "-spatial-aq", "1", "-bf", "3"]
            }
            HwEncoder::Qsv => vec!["-preset", "slower", "-global_quality", pick3("26", "23", "17")],
            HwEncoder::Amf => {
                let (p, b) = (pick3("26", "21", "17"), pick3("28", "23", "19"));
                vec!["-quality", "quality", "-rc", "cqp", "-qp_i", p, "-qp_p", p, "-qp_b", b]
            }
            HwEncoder::VideoToolbox => vec!["-realtime", "0", "-q:v", pick3("50", "65", "78")],
            HwEncoder::Vaapi => return None,
        };
        let mut out = vec!["-c:v".to_string(), self.name().to_string()];
        out.extend(args.into_iter().map(String::from));
        Some(out)
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
                let vaapi_device = if candidate == HwEncoder::Vaapi {
                    match discover_vaapi_render_node() {
                        Some(node) => Some(node),
                        None => continue,
                    }
                } else {
                    None
                };
                for mode in 0..candidate.quality_candidates().len() {
                    let encoding = HwEncoding {
                        encoder: candidate,
                        mode,
                        vaapi_device: vaapi_device.clone(),
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
    cmd.args(["-hide_banner", "-loglevel", "error"])
        .args(encoding.pre_input_args())
        .args(["-f", "lavfi", "-i", "color=black:s=64x64:d=0.1"]);
    if let Some(vf) = encoding.video_filter_suffix() {
        cmd.args(["-vf", vf]);
    }
    cmd.args(["-frames:v", "1", "-c:v", encoding.name()])
        .args(encoding.quality_args())
        .args(["-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    crate::commands::recording::hide_console_window(&mut cmd);

    // Bounded timeout: a wedged GPU driver must never hang startup warmup or the first recording.
    crate::services::responsiveness::output_with_timeout(cmd, std::time::Duration::from_secs(10))
        .map(|out| out.status.success())
        .unwrap_or(false)
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
            HwEncoder::Vaapi,
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
            HwEncoder::Vaapi,
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
        } else if cfg!(target_os = "linux") {
            assert_eq!(list, &[HwEncoder::Nvenc, HwEncoder::Vaapi]);
        } else if cfg!(target_os = "windows") {
            assert!(!list.is_empty());
        }
    }

    #[test]
    fn exports_use_constant_quality_only() {
        for encoder in [HwEncoder::Nvenc, HwEncoder::Qsv, HwEncoder::Amf, HwEncoder::VideoToolbox] {
            let cq = HwEncoding { encoder, mode: 0, vaapi_device: None };
            for tier in ["small", "standard", "high", "anything"] {
                let args = cq.export_args(tier).unwrap();
                assert_eq!(args[..2], ["-c:v".to_string(), encoder.name().to_string()]);
                assert!(!args.iter().any(|a| a == "12M" || a == "20M"), "{args:?}");
            }
            // A bitrate-only encoder can't promise a tier's quality - exports stay on x264.
            assert!(HwEncoding { encoder, mode: 1, vaapi_device: None }.export_args("standard").is_none());
        }
        let qsv = HwEncoding { encoder: HwEncoder::Qsv, mode: 0, vaapi_device: None };
        assert!(qsv.export_args("high").unwrap().contains(&"17".to_string()));
        assert!(qsv.export_args("small").unwrap().contains(&"26".to_string()));

        // VAAPI exposes pre-input device, hwupload suffix, and omits yuv420p.
        let vaapi = HwEncoding {
            encoder: HwEncoder::Vaapi,
            mode: 0,
            vaapi_device: Some("/dev/dri/renderD128".to_string()),
        };
        assert_eq!(vaapi.pre_input_args(), vec!["-vaapi_device", "/dev/dri/renderD128"]);
        assert_eq!(vaapi.video_filter_suffix(), Some("format=nv12,hwupload"));
        assert!(!vaapi.keep_pix_fmt());
        assert!(vaapi.export_args("standard").is_none());
    }

    #[test]
    fn mode_index_out_of_range_falls_back_rather_than_panicking() {
        let e = HwEncoding {
            encoder: HwEncoder::Qsv,
            mode: 99,
            vaapi_device: None,
        };
        assert!(!e.quality_args().is_empty());
    }
}
