// commands/recording/gpu_capture.rs
//
// GPU screen capture for Windows: the Desktop Duplication API (ffmpeg's `ddagrab`) feeding a
// hardware encoder, with frames that never leave video memory.
//
// gdigrab - the capture source every screen mode used before this - copies each frame out of the
// compositor through GDI on the CPU, and on a 4K display that is simply too slow to be usable.
// Measured on an i7-7820HQ / Intel HD 630 driving a 3840x2160 panel:
//
//   gdigrab, capture alone, no encode                   ~10 fps
//   gdigrab -> scale to 1080p -> h264_qsv (old default)  ~12 fps  (2 fps under load)
//   ddagrab -> h264_qsv, native 4K                        60 fps, ~2.5s CPU per 15s recorded
//
// That last figure is roughly 2% of the machine, which is what keeps the rest of the app (and
// everything else the user is demonstrating) smooth while a recording runs.
//
// What can and can't stay on the GPU decides the shape of everything below:
//   - Quick Sync takes Desktop Duplication frames via hwmap, and scales/converts them with
//     vpp_qsv on the GPU, so any output size is free.
//   - NVENC and AMF take the D3D11 frames directly, but this ffmpeg build has no D3D11 scaler, so
//     a downscale (or a camera composite) on those means copying frames to system memory first.
//   - Copying frames back to the CPU is expensive at 4K (one full core, capped at ~38 fps here), so
//     the copy path ("Copy") defaults to 1080p30 - still several times what gdigrab manages.
//   - overlay_qsv refuses frames from two different derived QSV sessions, which is what a
//     Desktop Duplication source plus an uploaded webcam always are in this build, so a baked-in
//     camera composites on the CPU after a GPU downscale.
//
// Which path works is decided by actually running it (see probe), not by asking what the build
// supports - hw_encoder.rs's own header has the history of why "listed" doesn't mean "works".
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_DESC1, DXGI_OUTPUT_DESC,
};

// Named so it can't collide with anything else an ffmpeg command line might define.
const DEVICE_NAME: &str = "bcdx";

// Below this a capture region isn't worth a GPU session (and an encoder may refuse it outright).
const MIN_REGION: i32 = 64;

const VENDOR_INTEL: u32 = 0x8086;
const VENDOR_NVIDIA: u32 = 0x10DE;
const VENDOR_AMD: u32 = 0x1002;

// Constant-quality target for screen content. A notch below the 23 the software path uses: text
// is what screen recordings are watched for, and at these hardware encoders' efficiency the cost
// is small (a mostly-static 4K desktop measured ~2.5 Mbit/s at 23).
const QUALITY: &str = "21";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GpuEncoder {
    Qsv,
    Nvenc,
    Amf,
    // Desktop Duplication capture, frames copied to system memory for whatever encoder works there.
    Copy,
}

impl GpuEncoder {
    // Whether frames reach the encoder without leaving the GPU when nothing needs the CPU.
    pub(crate) fn zero_copy(self) -> bool {
        !matches!(self, GpuEncoder::Copy)
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            GpuEncoder::Qsv => "Intel Quick Sync",
            GpuEncoder::Nvenc => "NVIDIA NVENC",
            GpuEncoder::Amf => "AMD AMF",
            GpuEncoder::Copy => "GPU capture",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Output {
    adapter: u32,
    output: u32,
    vendor: u32,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

// One recording's GPU capture: which output, which part of it, and how it gets encoded.
#[derive(Clone, Debug)]
pub(crate) struct GpuCapture {
    adapter: u32,
    output: u32,
    // Relative to the output, only when capturing less than the whole output.
    crop: Option<(i32, i32)>,
    width: i32,
    height: i32,
    pub(crate) encoder: GpuEncoder,
}

static PROBED: Mutex<Option<HashMap<u32, Option<GpuEncoder>>>> = Mutex::new(None);
static DISABLED: AtomicBool = AtomicBool::new(false);
// Whether the recording most recently started went through GPU capture - start_recording reads
// it to decide whether an ffmpeg that died at start is worth retrying through gdigrab.
pub(crate) static USED_BY_LAST_START: AtomicBool = AtomicBool::new(false);

// Turns GPU capture off for the rest of this session, after a recording that used it died at
// start - the next attempt goes through gdigrab instead of failing the same way again.
pub(crate) fn disable_for_session(reason: &str) {
    if !DISABLED.swap(true, Ordering::SeqCst) {
        log::warn!("GPU screen capture disabled for this session: {}", reason);
    }
}

// Probes every adapter that drives a display, so the first recording never waits on it. Called
// from a background thread at startup.
pub(crate) fn warm(ffmpeg_path: &Path) {
    let outputs = enumerate_outputs();
    let mut seen = Vec::new();
    for o in outputs {
        if !seen.contains(&o.adapter) {
            seen.push(o.adapter);
            encoder_for(ffmpeg_path, &o);
        }
    }
}

// Resolves a screen-coordinate region to a GPU capture of it, or None when it can't be done on
// the GPU (the region spans monitors, no path probed as working, or GPU capture was disabled) and
// the caller should fall back to gdigrab.
//
// `exact` is for regions that must be captured as given (the full screen, a whole monitor): they
// have to match one output exactly. Otherwise (a window) the region is clipped to the output
// holding its centre, which is what the user can actually see of it anyway.
pub(crate) fn plan(ffmpeg_path: &Path, region: (i32, i32, i32, i32), exact: bool) -> Option<GpuCapture> {
    if DISABLED.load(Ordering::SeqCst) {
        return None;
    }
    let (x, y, w, h) = region;
    let outputs = enumerate_outputs();

    let out = if exact {
        outputs
            .iter()
            .find(|o| o.left == x && o.top == y && o.right - o.left == w && o.bottom - o.top == h)?
    } else {
        let (cx, cy) = (x + w / 2, y + h / 2);
        outputs
            .iter()
            .find(|o| cx >= o.left && cx < o.right && cy >= o.top && cy < o.bottom)?
    };

    // Clip to the output, relative to its own origin, with even dimensions (4:2:0 needs them).
    let left = x.max(out.left) - out.left;
    let top = y.max(out.top) - out.top;
    let right = (x + w).min(out.right) - out.left;
    let bottom = (y + h).min(out.bottom) - out.top;
    let width = (right - left) & !1;
    let height = (bottom - top) & !1;
    if width < MIN_REGION || height < MIN_REGION {
        return None;
    }
    let full = left == 0 && top == 0 && width == out.right - out.left && height == out.bottom - out.top;

    let encoder = encoder_for(ffmpeg_path, out)?;
    Some(GpuCapture {
        adapter: out.adapter,
        output: out.output,
        crop: if full { None } else { Some((left, top)) },
        width,
        height,
        encoder,
    })
}

impl GpuCapture {
    pub(crate) fn size(&self) -> (i32, i32) {
        (self.width, self.height)
    }

    // The D3D11 device ddagrab and the GPU filters run on. ddagrab itself always runs as a source
    // filter inside the -filter_complex, never as a lavfi input - see ScreenSource::inputs in
    // win.rs for the two measured reasons.
    pub(crate) fn device_args(&self) -> Vec<String> {
        vec![
            "-init_hw_device".into(),
            format!("d3d11va={}:{}", DEVICE_NAME, self.adapter),
            "-filter_hw_device".into(),
            DEVICE_NAME.into(),
        ]
    }

    pub(crate) fn source_filter(&self, framerate: i32) -> String {
        let mut source = format!(
            "ddagrab=output_idx={}:framerate={}:draw_mouse=1",
            self.output, framerate
        );
        if let Some((x, y)) = self.crop {
            source.push_str(&format!(
                ":offset_x={}:offset_y={}:video_size={}x{}",
                x, y, self.width, self.height
            ));
        }
        source
    }

    // The output size for a width cap, aspect kept, both sides even.
    pub(crate) fn scaled_size(&self, max_width: i32) -> (i32, i32) {
        if self.width <= max_width {
            return (self.width, self.height);
        }
        let w = max_width & !1;
        let h = ((self.height as i64 * w as i64 / self.width as i64) as i32) & !1;
        (w, h.max(2))
    }

    // The filter chain from the raw capture to what the encoder (or, with `to_cpu`, a CPU filter
    // such as the camera overlay) receives. Returns the chain and whether its frames end up in
    // system memory - which decides the encoder arguments, see encoder_args.
    pub(crate) fn chain(&self, out: (i32, i32), to_cpu: bool) -> (String, bool) {
        let scaled = out != (self.width, self.height);
        match self.encoder {
            GpuEncoder::Qsv => {
                let mut chain = String::from("hwmap=derive_device=qsv,format=qsv,vpp_qsv=");
                if scaled {
                    chain.push_str(&format!("w={}:h={}:", out.0, out.1));
                }
                chain.push_str("format=nv12");
                if to_cpu {
                    chain.push_str(",hwdownload,format=nv12");
                }
                (chain, to_cpu)
            }
            GpuEncoder::Nvenc | GpuEncoder::Amf if !scaled && !to_cpu => ("null".into(), false),
            GpuEncoder::Nvenc | GpuEncoder::Amf | GpuEncoder::Copy => {
                let mut chain = String::from("hwdownload,format=bgra");
                if scaled {
                    chain.push_str(&format!(",scale={}:{}:flags=bicubic", out.0, out.1));
                }
                (chain, true)
            }
        }
    }

    // `-c:v` and its rate control. `cpu_frames` must be what chain() returned: GPU-resident frames
    // need the encoder's own hardware input, system-memory frames go through the ordinary path.
    pub(crate) fn encoder_args(&self, ffmpeg_path: &Path, cpu_frames: bool) -> Vec<String> {
        encoder_args(self.encoder, ffmpeg_path, cpu_frames)
    }
}

fn encoder_args(encoder: GpuEncoder, ffmpeg_path: &Path, cpu_frames: bool) -> Vec<String> {
    let args: Vec<&str> = match encoder {
        GpuEncoder::Qsv => vec!["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", QUALITY],
        GpuEncoder::Nvenc => vec!["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", QUALITY, "-b:v", "0"],
        GpuEncoder::Amf => vec![
            "-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", QUALITY, "-qp_p", QUALITY,
            "-qp_b", QUALITY,
        ],
        GpuEncoder::Copy => {
            // Whatever hw_encoder proved works on system-memory frames, else software x264.
            let mut args = match crate::services::hw_encoder::detect(ffmpeg_path) {
                Some(hw) => {
                    let mut a = vec!["-c:v".to_string(), hw.name().to_string()];
                    a.extend(hw.quality_args());
                    a
                }
                None => ["-c:v", "libx264", "-preset", "ultrafast", "-crf", QUALITY]
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            };
            args.extend(["-pix_fmt".to_string(), "yuv420p".to_string()]);
            return args;
        }
    };
    let mut args: Vec<String> = args.into_iter().map(String::from).collect();
    if cpu_frames {
        args.extend(["-pix_fmt".to_string(), "yuv420p".to_string()]);
    }
    args
}

fn encoder_for(ffmpeg_path: &Path, out: &Output) -> Option<GpuEncoder> {
    // Held across the probe on purpose: a recording started while the startup warm-up is still
    // probing waits for that answer instead of launching a second probe of the same GPU.
    let mut guard = PROBED.lock().unwrap_or_else(|p| p.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some(found) = cache.get(&out.adapter) {
        return *found;
    }

    let candidates: &[GpuEncoder] = match out.vendor {
        VENDOR_INTEL => &[GpuEncoder::Qsv, GpuEncoder::Copy],
        VENDOR_NVIDIA => &[GpuEncoder::Nvenc, GpuEncoder::Copy],
        VENDOR_AMD => &[GpuEncoder::Amf, GpuEncoder::Copy],
        _ => &[GpuEncoder::Copy],
    };
    let found = candidates.iter().copied().find(|&e| probe(ffmpeg_path, out, e));
    match found {
        Some(e) => log::info!(
            "GPU screen capture on adapter {} (vendor {:04x}): {:?}",
            out.adapter, out.vendor, e
        ),
        None => log::info!(
            "GPU screen capture unavailable on adapter {} (vendor {:04x}), screen recordings will use gdigrab",
            out.adapter, out.vendor
        ),
    }
    cache.insert(out.adapter, found);
    found
}

// A few real frames through the exact chain and encoder a recording would use - including a
// downscale where the path has a GPU scaler, since that is a separate piece of hardware support.
fn probe(ffmpeg_path: &Path, out: &Output, encoder: GpuEncoder) -> bool {
    let capture = GpuCapture {
        adapter: out.adapter,
        output: out.output,
        crop: None,
        width: (out.right - out.left) & !1,
        height: (out.bottom - out.top) & !1,
        encoder,
    };
    let size = if encoder == GpuEncoder::Qsv { capture.scaled_size(1280) } else { capture.size() };
    let (chain, cpu_frames) = capture.chain(size, false);

    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin"])
        .args(capture.device_args())
        .args(["-filter_complex", &format!("{},{}", capture.source_filter(30), chain)])
        .args(["-frames:v", "5"])
        .args(encoder_args(encoder, ffmpeg_path, cpu_frames))
        .args(["-f", "null", "-"]);
    super::hide_console_window(&mut cmd);

    match crate::services::responsiveness::output_with_timeout(cmd, Duration::from_secs(20)) {
        Ok(output) if output.status.success() => true,
        Ok(output) => {
            log::debug!(
                "GPU capture probe {:?} failed: {}",
                encoder,
                String::from_utf8_lossy(&output.stderr).trim()
            );
            false
        }
        Err(e) => {
            log::debug!("GPU capture probe {:?} could not run: {}", encoder, e);
            false
        }
    }
}

// Every display output, with the adapter index ffmpeg's `-init_hw_device d3d11va=<name>:<index>`
// means (it enumerates adapters through the same DXGI factory order) and the output index
// ddagrab's output_idx means within that adapter.
fn enumerate_outputs() -> Vec<Output> {
    let mut found = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return found;
        };
        let mut a = 0;
        while let Ok(adapter) = factory.EnumAdapters1(a) {
            let mut adapter_desc = DXGI_ADAPTER_DESC1::default();
            let vendor = match adapter.GetDesc1(&mut adapter_desc) {
                Ok(()) => adapter_desc.VendorId,
                Err(_) => 0,
            };
            let mut o = 0;
            while let Ok(output) = adapter.EnumOutputs(o) {
                let mut desc = DXGI_OUTPUT_DESC::default();
                if output.GetDesc(&mut desc).is_ok() {
                    if desc.AttachedToDesktop.as_bool() {
                        let r = desc.DesktopCoordinates;
                        found.push(Output {
                            adapter: a,
                            output: o,
                            vendor,
                            left: r.left,
                            top: r.top,
                            right: r.right,
                            bottom: r.bottom,
                        });
                    }
                }
                o += 1;
            }
            a += 1;
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(encoder: GpuEncoder) -> GpuCapture {
        GpuCapture { adapter: 0, output: 0, crop: None, width: 3840, height: 2160, encoder }
    }

    #[test]
    fn scaled_size_keeps_aspect_and_even_sides() {
        let c = capture(GpuEncoder::Qsv);
        assert_eq!(c.scaled_size(1920), (1920, 1080));
        assert_eq!(c.scaled_size(7680), (3840, 2160));
        let odd = GpuCapture { width: 1001, height: 777, ..capture(GpuEncoder::Qsv) };
        let (w, h) = odd.scaled_size(640);
        assert_eq!((w % 2, h % 2), (0, 0));
    }

    #[test]
    fn qsv_stays_on_the_gpu_unless_asked_not_to() {
        let c = capture(GpuEncoder::Qsv);
        assert_eq!(c.chain((3840, 2160), false), ("hwmap=derive_device=qsv,format=qsv,vpp_qsv=format=nv12".to_string(), false));
        let (chain, cpu) = c.chain((1920, 1080), true);
        assert!(chain.contains("w=1920:h=1080") && chain.ends_with("hwdownload,format=nv12"));
        assert!(cpu);
    }

    #[test]
    fn nvenc_downloads_only_when_it_has_to() {
        let c = capture(GpuEncoder::Nvenc);
        assert_eq!(c.chain((3840, 2160), false), ("null".to_string(), false));
        assert!(c.chain((1920, 1080), false).1);
    }

    #[test]
    fn gpu_frames_get_no_pix_fmt() {
        let p = Path::new("ffmpeg");
        assert!(!encoder_args(GpuEncoder::Qsv, p, false).contains(&"-pix_fmt".to_string()));
        assert!(encoder_args(GpuEncoder::Qsv, p, true).contains(&"-pix_fmt".to_string()));
    }

    #[test]
    fn crop_goes_into_the_ddagrab_source() {
        let c = GpuCapture { crop: Some((100, 50)), width: 1280, height: 720, ..capture(GpuEncoder::Qsv) };
        let src = c.source_filter(60);
        assert!(src.contains("offset_x=100:offset_y=50:video_size=1280x720"));
        assert!(src.contains("framerate=60"));
    }
}
