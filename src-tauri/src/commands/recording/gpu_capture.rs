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
//   - vpp_qsv is asked for a size only, never `format=nv12`: since ffmpeg 8 the NV12 frame pool it
//     then allocates fails on Intel's pre-oneVPL drivers (HD 630 here: "Could not create the
//     texture (80070057)"), while BGRA scaled frames go to h264_qsv fine.
//
// A single window is captured with Windows.Graphics.Capture (ffmpeg's `gfxcapture`, ffmpeg 8+)
// instead of a crop of the desktop: it delivers that window's own pixels - not whatever happens
// to be on top of it - follows it when it moves, and keeps going while the user works in another
// app. Its frames are D3D11 textures exactly like ddagrab's, so everything downstream is shared.
//
// Which path works is decided by actually running it (see probe), not by asking what the build
// supports - hw_encoder.rs's own header has the history of why "listed" doesn't mean "works".
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU8, Ordering};
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

// A window captured on its own (gfxcapture) rather than as part of an output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WindowSource {
    pub(crate) hwnd: isize,
    // The title bar and frame too, not just the window's content.
    pub(crate) title_bar: bool,
}

// One recording's GPU capture: which output (or window), which part of it, and how it gets encoded.
#[derive(Clone, Debug)]
pub(crate) struct GpuCapture {
    adapter: u32,
    output: u32,
    // Relative to the output, only when capturing less than the whole output.
    crop: Option<(i32, i32)>,
    window: Option<WindowSource>,
    cursor: bool,
    width: i32,
    height: i32,
    pub(crate) encoder: GpuEncoder,
}

static PROBED: Mutex<Option<HashMap<u32, Option<GpuEncoder>>>> = Mutex::new(None);
static DISABLED: AtomicBool = AtomicBool::new(false);
// Windows whose own capture died at start (a suspended Store app's frame, say) - recorded as the
// screen area they cover from then on.
static FAILED_WINDOWS: Mutex<Option<HashSet<isize>>> = Mutex::new(None);
static WINDOW_CAPTURE: Mutex<Option<bool>> = Mutex::new(None);

// How the recording most recently started captured the screen - start_recording reads it to
// decide whether an ffmpeg that died at start is worth retrying another way.
const START_NONE: u8 = 0;
const START_DESKTOP: u8 = 1;
const START_WINDOW: u8 = 2;
static LAST_START: AtomicU8 = AtomicU8::new(START_NONE);
static LAST_START_WINDOW: AtomicIsize = AtomicIsize::new(0);

pub(crate) fn note_start(capture: Option<&GpuCapture>) {
    let (kind, hwnd) = match capture {
        Some(GpuCapture { window: Some(w), .. }) => (START_WINDOW, w.hwnd),
        Some(_) => (START_DESKTOP, 0),
        None => (START_NONE, 0),
    };
    LAST_START_WINDOW.store(hwnd, Ordering::SeqCst);
    LAST_START.store(kind, Ordering::SeqCst);
}

// After the capture ffmpeg died at start: whether another attempt can go differently. A window
// that can't be captured on its own falls back to the screen area it covers (still on the GPU);
// a Desktop Duplication failure turns GPU capture off for the session (gdigrab next).
// `ffmpeg_output` is the tail of what that ffmpeg printed: only a failure of the screen capture
// itself is retried - a microphone or camera that wouldn't open fails the same way however the
// screen is captured.
pub(crate) fn fallback_after_failed_start(reason: &str, ffmpeg_output: &str) -> bool {
    if !blames_screen(ffmpeg_output) {
        LAST_START.store(START_NONE, Ordering::SeqCst);
        log::info!("Capture start failed on an input device, not the screen capture - not retrying it differently");
        return false;
    }
    match LAST_START.swap(START_NONE, Ordering::SeqCst) {
        START_WINDOW => {
            let hwnd = LAST_START_WINDOW.load(Ordering::SeqCst);
            log::warn!("Window capture of {:#x} failed ({}), recording the screen area it covers instead", hwnd, reason);
            FAILED_WINDOWS
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get_or_insert_with(HashSet::new)
                .insert(hwnd);
            true
        }
        START_DESKTOP => {
            disable_for_session(reason);
            true
        }
        _ => false,
    }
}

// Whether a failed start's ffmpeg output points at the screen capture (or says nothing useful,
// which is treated the same as before: the screen gets the blame) rather than at a dshow device.
fn blames_screen(ffmpeg_output: &str) -> bool {
    let out = ffmpeg_output.to_lowercase();
    if out.trim().is_empty() {
        return true;
    }
    let screen = ["gfxcapture", "ddagrab", "desktop duplication", "hwmap", "qsv", "d3d11", "nvenc", "amf", "gdigrab"]
        .iter()
        .any(|k| out.contains(k));
    let device = out.contains("dshow") || out.contains("audio=") || out.contains("video=");
    screen || !device
}

// Whether this ffmpeg has gfxcapture (ffmpeg 8+, Windows 10 1903+). Asked once per session.
pub(crate) fn window_capture_available(ffmpeg_path: &Path) -> bool {
    let mut cached = WINDOW_CAPTURE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(known) = *cached {
        return known;
    }
    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(["-hide_banner", "-h", "filter=gfxcapture"]);
    super::hide_console_window(&mut cmd);
    let known = match crate::services::responsiveness::output_with_timeout(cmd, Duration::from_secs(10)) {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            text.contains("Filter gfxcapture") && text.contains("hwnd")
        }
        Err(_) => false,
    };
    log::info!(
        "Window capture (gfxcapture): {}",
        if known { "available" } else { "unavailable, windows are recorded as screen areas" }
    );
    *cached = Some(known);
    known
}

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
pub(crate) fn plan(ffmpeg_path: &Path, region: (i32, i32, i32, i32), exact: bool, cursor: bool) -> Option<GpuCapture> {
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
        window: None,
        cursor,
        width,
        height,
        encoder,
    })
}

// A window captured on its own, or None when that isn't possible here (no gfxcapture, GPU
// capture off, the window already failed this way, or it has no area) and the caller should
// capture the screen area it covers instead. `region` is what the capture will hold, in screen
// pixels (window_capture::win::capture_rect): its size fixes the recording's size - the window
// is scaled to fit it, aspect kept, if it's resized while recording - and its centre picks the
// GPU whose encoder is used.
pub(crate) fn plan_window(
    ffmpeg_path: &Path,
    window: WindowSource,
    region: (i32, i32, i32, i32),
    cursor: bool,
) -> Option<GpuCapture> {
    if DISABLED.load(Ordering::SeqCst) || !window_capture_available(ffmpeg_path) {
        return None;
    }
    let failed = FAILED_WINDOWS.lock().unwrap_or_else(|p| p.into_inner());
    if failed.as_ref().is_some_and(|f| f.contains(&window.hwnd)) {
        return None;
    }
    drop(failed);
    let (x, y, w, h) = region;
    let (width, height) = (w & !1, h & !1);
    if width < MIN_REGION || height < MIN_REGION {
        return None;
    }
    let outputs = enumerate_outputs();
    let (cx, cy) = (x + w / 2, y + h / 2);
    let out = outputs
        .iter()
        .find(|o| cx >= o.left && cx < o.right && cy >= o.top && cy < o.bottom)
        .or_else(|| outputs.first())?;
    let encoder = encoder_for(ffmpeg_path, out)?;
    Some(GpuCapture {
        adapter: out.adapter,
        output: out.output,
        crop: None,
        window: Some(window),
        cursor,
        width,
        height,
        encoder,
    })
}

// The gfxcapture source for a still of `window`, sized as it is now - for screenshots.
pub(crate) fn window_still_filter(window: WindowSource, cursor: bool) -> String {
    format!(
        "gfxcapture=hwnd={}:capture_cursor={}:capture_border={}:display_border=0,hwdownload,format=bgra",
        window.hwnd, cursor as u8, window.title_bar as u8
    )
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

    pub(crate) fn window(&self) -> Option<WindowSource> {
        self.window
    }

    pub(crate) fn source_filter(&self, framerate: i32) -> String {
        if let Some(w) = self.window {
            // resize_mode=scale_aspect: a window resized mid-recording is fitted into the size the
            // recording started at (an encoder can't change size mid-stream) rather than cropped.
            // display_border=0 asks Windows not to draw its yellow "being captured" frame.
            return format!(
                "gfxcapture=hwnd={}:max_framerate={}:capture_cursor={}:capture_border={}:display_border=0:resize_mode=scale_aspect:scale_mode=bicubic:width={}:height={}",
                w.hwnd, framerate, self.cursor as u8, w.title_bar as u8, self.width, self.height
            );
        }
        let mut source = format!(
            "ddagrab=output_idx={}:framerate={}:draw_mouse={}",
            self.output, framerate, self.cursor as u8
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
                // Scaled frames stay BGRA (see the header on vpp_qsv and NV12); h264_qsv takes
                // BGRA surfaces as they are, and a CPU filter after this gets them as bgra.
                let mut chain = String::from("hwmap=derive_device=qsv,format=qsv");
                if scaled {
                    chain.push_str(&format!(",vpp_qsv=w={}:h={}", out.0, out.1));
                }
                if to_cpu {
                    chain.push_str(",hwdownload,format=bgra");
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
    let mut transient = false;
    let found = candidates.iter().copied().find(|&e| match probe(ffmpeg_path, out, e) {
        Probe::Works => true,
        Probe::Fails => false,
        Probe::Unavailable => {
            transient = true;
            false
        }
    });
    // Desktop Duplication refuses everyone while the secure desktop is up (a locked screen, a UAC
    // prompt) - which says nothing about this GPU. Not remembered, so the next recording asks again
    // instead of the whole session falling back to gdigrab because the app started on a lock screen.
    if found.is_none() && transient {
        log::info!("GPU screen capture probe on adapter {} deferred: the desktop is not available right now", out.adapter);
        return None;
    }
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
enum Probe {
    Works,
    Fails,
    // The desktop couldn't be duplicated at all right now - try again later.
    Unavailable,
}

fn probe(ffmpeg_path: &Path, out: &Output, encoder: GpuEncoder) -> Probe {
    let capture = GpuCapture {
        adapter: out.adapter,
        output: out.output,
        crop: None,
        window: None,
        cursor: true,
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
        Ok(output) if output.status.success() => Probe::Works,
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::debug!("GPU capture probe {:?} failed: {}", encoder, stderr.trim());
            if stderr.contains("Desktop duplication access denied") {
                Probe::Unavailable
            } else {
                Probe::Fails
            }
        }
        Err(e) => {
            log::debug!("GPU capture probe {:?} could not run: {}", encoder, e);
            Probe::Fails
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
        GpuCapture { adapter: 0, output: 0, crop: None, window: None, cursor: true, width: 3840, height: 2160, encoder }
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
        assert_eq!(c.chain((3840, 2160), false), ("hwmap=derive_device=qsv,format=qsv".to_string(), false));
        let (chain, cpu) = c.chain((1920, 1080), true);
        assert!(chain.contains("vpp_qsv=w=1920:h=1080") && chain.ends_with("hwdownload,format=bgra"));
        // NV12 output from vpp_qsv fails on pre-oneVPL Intel drivers with ffmpeg 8+.
        assert!(!chain.contains("nv12"));
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
        assert!(src.contains("draw_mouse=1"));
    }

    #[test]
    fn only_screen_failures_are_retried_differently() {
        // ffmpeg 9's own words for an empty `-i audio=` (no microphone picked).
        let empty = "[in#0 @ 0000024450b40500] Malformed dshow input string.
[in#0 @ 0000024450b40200] Error opening input: I/O error
Error opening input file audio=.";
        assert!(!blames_screen(empty));
        // ffmpeg's own words when the microphone named in `-i audio=...` doesn't exist.
        let mic = "[dshow @ 0000020f] Could not find audio only device with name [] among source devices of type audio.
[in#1 @ 0000020f] Error opening input: I/O error
Error opening input file audio=.";
        assert!(!blames_screen(mic));
        assert!(blames_screen("[Parsed_gfxcapture_0 @ 0000020b] Failed to setup graphics capture"));
        assert!(blames_screen("[Parsed_ddagrab_0 @ 0000024d] Desktop duplication access denied"));
        assert!(blames_screen(""));
    }

    #[test]
    fn a_window_is_captured_on_its_own_at_a_fixed_size() {
        let c = GpuCapture {
            window: Some(WindowSource { hwnd: 0x1234, title_bar: false }),
            cursor: false,
            width: 1600,
            height: 900,
            ..capture(GpuEncoder::Qsv)
        };
        let src = c.source_filter(30);
        assert!(src.starts_with("gfxcapture=hwnd=4660:max_framerate=30"), "{src}");
        assert!(src.contains("capture_cursor=0") && src.contains("capture_border=0"));
        assert!(src.contains("resize_mode=scale_aspect") && src.contains("width=1600:height=900"));
        assert!(src.contains("display_border=0"));
    }
}
