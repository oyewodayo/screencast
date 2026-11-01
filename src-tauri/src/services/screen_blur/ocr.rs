// Sensitive-text watching: keeps blurs on the secrets in the window you're using - placed by OCR,
// and glued to the text frame by frame as it scrolls.
//
// Two threads:
//   - The tracker captures the foreground window with Windows.Graphics.Capture (borderless, no
//     cursor; measured here: first frame in ~30ms, a quarter-resolution GPU readback ~8ms on a 4K
//     window). WGC only delivers a frame when the window actually changes, so an idle window costs
//     nothing. Each frame is reduced on the GPU (mipmaps) to a small grey copy, and every blur is
//     moved by however far the text under it moved (blur_track::vertical_shift) - in the same frame,
//     no OCR involved. That's what keeps a scroll from walking the text out from under its blur.
//   - The OCR thread (Windows.Media.Ocr, offline) reads the newest frame whenever the window has
//     changed and it's free - half resolution on HiDPI screens, where text is big enough and it's ~4x
//     faster. Its findings belong to the frame it read, so the tracker realigns them to the current
//     frame before they replace the old set.
// Newly revealed text can't be known before OCR reads it, so while a window that holds secrets is
// scrolling - and until OCR has caught up with where it stopped - the columns those secrets live in
// stay covered. A window showing a secrets file (.env, *.pem, id_rsa...) is covered whole from its
// first frame until its first OCR pass. PrintWindow, the previous capture, took ~120ms per 4K frame -
// far too slow to follow a scroll.
use super::sensitive::{find_sensitive, Hit, Line, TextRules, Word};
use blur_track::{average_bgra, change, vertical_shift, Gray, InkMap, Shift};
use regex::Regex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Graphics::SizeInt32;
use windows::Media::Ocr::OcrEngine;
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, D3D11_BOX, ID3D11ShaderResourceView, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_RESOURCE_MISC_GENERATE_MIPS, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible};

// Don't start OCR passes closer together than this, even when frames keep changing...
const OCR_MIN_INTERVAL: Duration = Duration::from_millis(100);
// ...and back off up to this while passes keep finding nothing in a window that keeps changing (a
// playing video, an animation) - so it never pins a core. Any finding, a new window or a new file
// snaps back to the minimum.
const OCR_MAX_INTERVAL: Duration = Duration::from_millis(1500);
// The next pass waits at least this many times as long as the last one took (up to DUTY_CAP).
const DUTY_FACTOR: u32 = 3;
const DUTY_CAP: Duration = Duration::from_secs(6);
// Poll for frames this often right after activity, and this often when the window is quiet. WGC only
// produces frames on change, so the quiet rate costs nothing and adds no visible delay.
const POLL_ACTIVE: Duration = Duration::from_millis(3);
const POLL_IDLE: Duration = Duration::from_millis(20);
// How long after the last movement a scroll counts as still going.
const SCROLL_HOLD: Duration = Duration::from_millis(250);
// Furthest a blur can be followed between two frames, in quarter-resolution rows (~640px at full
// resolution - a fast flick of the wheel).
const MAX_STEP_Q: usize = 160;
// Mip levels: 0 full, 1 half, 2 quarter (tracking), 3 eighth (change detection - ~2ms to read back,
// cheap enough for every frame).
const TRACK_LEVEL: u32 = 2;
const DIFF_LEVEL: u32 = 3;
// While a scroll is under way, OCR waits for it to settle (its result would be stale on arrival -
// the covers hold the line meanwhile), except for a safety pass this often on a long scroll.
const SCROLL_SETTLE: Duration = Duration::from_millis(150);
const SCROLL_OCR_EVERY: Duration = Duration::from_millis(600);

// A finding in screen pixels, with the average colour under it (the blur's frost tint).
pub struct ScreenHit {
    pub rect: RECT,
    pub label: &'static str,
    pub tone: Option<(u8, u8, u8)>,
}

pub type Sink = Box<dyn Fn(isize, RECT, Vec<ScreenHit>) + Send>;

// Whether OCR can run at all here (it needs an installed OCR language - English ships with most
// Windows installs). The language tag, for Settings.
pub fn availability() -> Option<String> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().ok()?;
    engine.RecognizerLanguage().ok()?.LanguageTag().ok().map(|t| t.to_string())
}

pub fn start(rules: Arc<Mutex<TextRules>>, stop: Arc<AtomicBool>, sink: Sink) {
    let _ = std::thread::Builder::new().name("screen-blur-text".into()).spawn(move || unsafe {
        log::info!("Screen blur: sensitive-text watching started");
        match run(rules, stop, sink) {
            Ok(()) => log::info!("Screen blur: sensitive-text watching stopped"),
            Err(e) => log::warn!("Screen blur: sensitive-text watching failed: {}", e),
        }
    });
}

// A finding, in full-resolution window pixels.
#[derive(Clone)]
struct Tracked {
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    label: &'static str,
    tone: Option<(u8, u8, u8)>,
}

impl Tracked {
    fn shifted(&self, dy: f32) -> Tracked {
        Tracked { y0: self.y0 + dy, y1: self.y1 + dy, ..self.clone() }
    }
}

// Where `t` is now, given the grey frame it was found on and the current one. Full-res px = 4x
// quarter-res. Unknown motion keeps it where it was (fail safe: a blur over changed text, not a
// gap over a secret).
fn follow(t: &Tracked, then: &Gray, now: &Gray, max_step: usize) -> Tracked {
    let q = |v: f32| (v / 4.0).max(0.0) as usize;
    match vertical_shift(then, now, q(t.x0), q(t.x1) + 1, q(t.y0), q(t.y1) + 1, max_step) {
        Shift::Moved(d) => t.shifted(d as f32 * 4.0),
        _ => t.clone(),
    }
}

struct OcrRequest {
    hwnd: isize,
    frame: u64,
    // Tightly packed BGRA of rows y0.. of the window (the band that changed), at 1/`factor`
    // resolution.
    bgra: Vec<u8>,
    w: u32,
    h: u32,
    y0: u32,
    factor: f32,
    rules: TextRules,
    // A secrets file (.env...): ink OCR couldn't read gets hidden too.
    secret_file: bool,
}

struct OcrResult {
    hwnd: isize,
    frame: u64,
    // The rows that were read (full-resolution window px) - findings elsewhere still stand.
    band: (f32, f32),
    hits: Vec<Tracked>,
    // Lines OCR read - zero means a blank frame (a capture's first one can be), which must not
    // count as "read" and lift a secrets file's cover.
    lines: usize,
    // How long the pass took - the next one waits at least DUTY_FACTOR times that.
    took: Duration,
}

// Re-read this much above and below a change: a line's text is taller than the rows that changed.
const BAND_MARGIN_PX: u32 = 80;
// A change covering more of the window than this gets a full read anyway.
const FULL_READ_SHARE: f32 = 0.6;
// Bands taller than this are split across OCR threads; each strip overlaps its neighbours by
// STRIP_OVERLAP so a line on a seam is whole in at least one of them.
const SPLIT_ABOVE_PX: u32 = 500;
const STRIP_OVERLAP_PX: u32 = 72;

// One window being captured, with the GPU resources sized to it.
struct Capture {
    hwnd: HWND,
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    size: SizeInt32,
    // The newest frame plus its mip chain; staging copies of the levels read back.
    mip: ID3D11Texture2D,
    srv: ID3D11ShaderResourceView,
    track: ID3D11Texture2D,
    diff: ID3D11Texture2D,
    ocr: ID3D11Texture2D,
    ocr_level: u32,
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

fn level_size(size: SizeInt32, level: u32) -> (u32, u32) {
    (((size.Width as u32) >> level).max(1), ((size.Height as u32) >> level).max(1))
}

unsafe fn texture(device: &ID3D11Device, w: u32, h: u32, levels: u32, staging: bool) -> windows::core::Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: levels,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: if staging { D3D11_USAGE_STAGING } else { D3D11_USAGE_DEFAULT },
        BindFlags: if staging { 0 } else { (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32 },
        CPUAccessFlags: if staging { D3D11_CPU_ACCESS_READ.0 as u32 } else { 0 },
        MiscFlags: if staging { 0 } else { D3D11_RESOURCE_MISC_GENERATE_MIPS.0 as u32 },
    };
    let mut t = None;
    device.CreateTexture2D(&desc, None, Some(&mut t))?;
    t.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))
}

impl Capture {
    unsafe fn new(device: &ID3D11Device, d3d: &IDirect3DDevice, hwnd: HWND) -> windows::core::Result<Capture> {
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd)?;
        let size = item.Size()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(d3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)?;
        let session = pool.CreateCaptureSession(&item)?;
        // No yellow "being captured" border on the user's window, no cursor in the frames.
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetIsCursorCaptureEnabled(false);
        let r = Self::resources(device, size)?;
        session.StartCapture()?;
        Ok(Capture { hwnd, _item: item, pool, session, size, mip: r.0, srv: r.1, track: r.2, diff: r.3, ocr: r.4, ocr_level: r.5 })
    }

    #[allow(clippy::type_complexity)]
    unsafe fn resources(
        device: &ID3D11Device,
        size: SizeInt32,
    ) -> windows::core::Result<(ID3D11Texture2D, ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11Texture2D, ID3D11Texture2D, u32)> {
        let (w, h) = level_size(size, 0);
        let mip = texture(device, w, h, DIFF_LEVEL + 1, false)?;
        let mut srv = None;
        device.CreateShaderResourceView(&mip, None, Some(&mut srv))?;
        let (tw, th) = level_size(size, TRACK_LEVEL);
        let track = texture(device, tw, th, 1, true)?;
        let (dw, dh) = level_size(size, DIFF_LEVEL);
        let diff = texture(device, dw, dh, 1, true)?;
        // Full resolution: at half size Windows OCR stopped reading monospace text altogether
        // (measured on a 4K .env in Notepad: it returned the tab titles and almost no lines).
        let ocr_level = 0;
        let (ow, oh) = level_size(size, ocr_level);
        let ocr = texture(device, ow, oh, 1, true)?;
        Ok((mip, srv.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?, track, diff, ocr, ocr_level))
    }

    unsafe fn resize(&mut self, device: &ID3D11Device, d3d: &IDirect3DDevice, size: SizeInt32) -> windows::core::Result<()> {
        self.pool.Recreate(d3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)?;
        let r = Self::resources(device, size)?;
        (self.mip, self.srv, self.track, self.diff, self.ocr, self.ocr_level, self.size) = (r.0, r.1, r.2, r.3, r.4, r.5, size);
        Ok(())
    }

    unsafe fn read_diff(&self, ctx: &ID3D11DeviceContext) -> Option<Gray> {
        let (w, h) = level_size(self.size, DIFF_LEVEL);
        ctx.CopySubresourceRegion(&self.diff, 0, 0, 0, 0, &self.mip, DIFF_LEVEL, None);
        let (data, pitch) = Self::read(ctx, &self.diff, w, h)?;
        Some(Gray::from_bgra(&data, w as usize, h as usize, pitch))
    }

    // Reads a staging texture into tightly packed BGRA.
    unsafe fn read(ctx: &ID3D11DeviceContext, staging: &ID3D11Texture2D, _w: u32, h: u32) -> Option<(Vec<u8>, usize)> {
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        ctx.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut m)).ok()?;
        let pitch = m.RowPitch as usize;
        let data = std::slice::from_raw_parts(m.pData as *const u8, pitch * h as usize).to_vec();
        ctx.Unmap(staging, 0);
        Some((data, pitch))
    }

    unsafe fn read_track(&self, ctx: &ID3D11DeviceContext) -> Option<Gray> {
        let (w, h) = level_size(self.size, TRACK_LEVEL);
        ctx.CopySubresourceRegion(&self.track, 0, 0, 0, 0, &self.mip, TRACK_LEVEL, None);
        let (data, pitch) = Self::read(ctx, &self.track, w, h)?;
        Some(Gray::from_bgra(&data, w as usize, h as usize, pitch))
    }

    // Rows y0..y1 (full-resolution px) of the newest frame, tightly packed - only that band is
    // copied off the GPU.
    unsafe fn read_ocr(&self, ctx: &ID3D11DeviceContext, y0: u32, y1: u32) -> Option<(Vec<u8>, u32, u32, f32)> {
        let (w, full_h) = level_size(self.size, self.ocr_level);
        let (y0, y1) = ((y0 >> self.ocr_level).min(full_h), (y1 >> self.ocr_level).min(full_h));
        if y1 <= y0 {
            return None;
        }
        let h = y1 - y0;
        let region = D3D11_BOX { left: 0, top: y0, front: 0, right: w, bottom: y1, back: 1 };
        ctx.CopySubresourceRegion(&self.ocr, 0, 0, 0, 0, &self.mip, self.ocr_level, Some(&region));
        let (data, pitch) = Self::read(ctx, &self.ocr, w, h)?;
        let row = w as usize * 4;
        let mut tight = Vec::with_capacity(row * h as usize);
        for y in 0..h as usize {
            tight.extend_from_slice(&data[y * pitch..y * pitch + row]);
        }
        Some((tight, w, h, (1u32 << self.ocr_level) as f32))
    }
}

// The window worth reading: the foreground one, unless it's ours, minimized, or the desktop.
unsafe fn scannable(hwnd: HWND, own_pid: u32) -> bool {
    if hwnd.0 == 0 || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return false;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == own_pid {
        return false;
    }
    let mut class = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut class).max(0) as usize;
    !matches!(String::from_utf16_lossy(&class[..n]).as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}

// Window titles name the open file ("•.env - project - Visual Studio Code", "id_rsa - Notepad").
// One that's a secrets file gets covered whole until OCR has placed precise blurs.
fn secret_file_title(title: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)^(\.env(\.(local|production|prod|development|dev|staging|test))?|.+\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)|id_(rsa|ed25519|ecdsa|dsa)|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|\.npmrc|\.pypirc|\.netrc|\.pgpass|kubeconfig)$")
            .expect("valid title pattern")
    });
    title.split([' ', '\u{2014}']).filter(|p| !p.is_empty() && *p != "-").any(|part| re.is_match(part.trim_start_matches(['\u{25CF}', '\u{2022}', '*'])))
}

unsafe fn window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = GetWindowTextW(hwnd, &mut buf).max(0) as usize;
    String::from_utf16_lossy(&buf[..n])
}

unsafe fn frame_rect(hwnd: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32).ok().map(|_| r)
}

unsafe fn run(rules: Arc<Mutex<TextRules>>, stop: Arc<AtomicBool>, sink: Sink) -> windows::core::Result<()> {
    let _ = RoInitialize(RO_INIT_MULTITHREADED);
    let engine = match OcrEngine::TryCreateFromUserProfileLanguages() {
        Ok(e) => e,
        Err(_) => {
            log::warn!("Screen blur: no OCR language installed - sensitive text can't be detected");
            return Ok(());
        }
    };
    let (mut device, mut ctx) = (None, None);
    D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, None, D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut ctx))?;
    let (Some(device), Some(ctx)) = (device, ctx) else { return Ok(()) };
    let d3d: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>()?)?.cast()?;
    // Borderless capture is granted to desktop apps without a prompt; ask once up front - with a
    // bounded wait, never a blocking .get(): nothing here may hang the thread.
    if let Ok(op) = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless) {
        let asked = Instant::now();
        while op.Status().map(|s| s == windows::Foundation::AsyncStatus::Started).unwrap_or(false) && asked.elapsed() < Duration::from_millis(1500) {
            std::thread::sleep(Duration::from_millis(10));
        }
        match op.GetResults() {
            Ok(status) => log::info!("Screen blur: borderless capture access: {}", status.0),
            Err(_) => log::warn!("Screen blur: borderless capture access didn't answer - windows may show a capture border"),
        }
    }

    let (req_tx, req_rx) = mpsc::channel::<OcrRequest>();
    let (res_tx, res_rx) = mpsc::channel::<OcrResult>();
    spawn_ocr(engine, req_rx, res_tx, stop.clone());

    let own_pid = GetCurrentProcessId();
    let mut cap: Option<Capture> = None;
    let mut prev: Option<Gray> = None;
    let mut hits: Vec<Tracked> = Vec::new();
    // The grey frame each in-flight OCR pass read, to realign its findings when they come back.
    let mut snapshots: HashMap<u64, Gray> = HashMap::new();
    let mut frame: u64 = 0;
    let (mut ocr_busy, mut dirty) = (false, false);
    let mut last_ocr = Instant::now() - OCR_MIN_INTERVAL;
    let mut last_motion: Option<(Instant, u64)> = None;
    let mut last_result_frame: u64 = 0;
    let (mut secret_file, mut title) = (false, String::new());
    let mut first_result_frame: Option<u64> = None;
    let mut sent: Option<Vec<(i32, i32, i32, i32)>> = None;
    let mut lost_capture = false;
    let mut failed_hwnd: isize = 0;
    let mut ocr_interval = OCR_MIN_INTERVAL;
    let mut last_frame_at = Instant::now() - POLL_IDLE * 100;
    // Change detection compares against the frame OCR last read (eighth resolution), not the
    // previous frame: a blinking caret flips back and forth and never adds up to "changed", while
    // typing does.
    let mut ocr_base: Option<Gray> = None;
    let mut latest_diff: Option<Gray> = None;
    // The last OCR pass's findings, to tell "same as before" (back off) from news (stay quick).
    let mut last_found: Vec<(i32, i32, &'static str)> = Vec::new();

    while !stop.load(Ordering::Relaxed) {
        if std::mem::take(&mut lost_capture) {
            cap = None;
        }
        // Follow the foreground window. Our own windows (the overlay in draw mode) don't count -
        // keep watching what was in front before.
        let fg = GetForegroundWindow();
        if cap.as_ref().map(|c| c.hwnd) != Some(fg) && scannable(fg, own_pid) && fg.0 != failed_hwnd {
            cap = match Capture::new(&device, &d3d, fg) {
                Ok(c) => {
                    log::debug!("Screen blur: watching window {:?} ({}x{})", fg.0, c.size.Width, c.size.Height);
                    Some(c)
                }
                Err(e) => {
                    // Some windows can't be captured (protected content, elevated apps). Logged
                    // once per window, not retried every pass.
                    log::warn!("Screen blur: can't capture window {:?}: {}", fg.0, e);
                    failed_hwnd = fg.0;
                    None
                }
            };
            prev = None;
            hits.clear();
            snapshots.clear();
            dirty = true;
            last_motion = None;
            first_result_frame = Some(frame + 1);
            title.clear();
            sent = None;
            ocr_interval = OCR_MIN_INTERVAL;
            ocr_base = None;
            latest_diff = None;
            last_found.clear();
        }
        let Some(c) = cap.as_mut() else {
            std::thread::sleep(Duration::from_millis(30));
            continue;
        };
        if !IsWindow(c.hwnd).as_bool() {
            cap = None;
            continue;
        }
        let hwnd = c.hwnd;
        let mut changed = false;

        let t = window_title(hwnd);
        if t != title {
            secret_file = secret_file_title(&t);
            // Covered until a pass of what's on screen *now* comes back - the current frame counts
            // (a still window may never produce another one). A new file means a full read.
            first_result_frame = if secret_file { Some(frame) } else { None };
            ocr_base = None;
            dirty = true;
            title = t;
            changed = true;
            ocr_interval = OCR_MIN_INTERVAL;
        }

        // OCR findings, realigned from the frame they were read on to the current one.
        while let Ok(res) = res_rx.try_recv() {
            ocr_busy = false;
            let snap = snapshots.remove(&res.frame);
            if res.hwnd != hwnd.0 {
                continue;
            }
            // Same findings as last time (an unchanged screen re-read, a caret, a video frame):
            // slow down. Anything new: stay quick.
            let found: Vec<(i32, i32, &'static str)> = res.hits.iter().map(|h| ((h.x0 / 8.0) as i32, (h.y0 / 8.0) as i32, h.label)).collect();
            ocr_interval = if found == last_found { (ocr_interval * 3 / 2).min(OCR_MAX_INTERVAL) } else { OCR_MIN_INTERVAL };
            // However busy the window, OCR gets at most ~1/(DUTY_FACTOR+1) of its threads' time: a
            // pass that took 1.4s on a dense 4K window waits 4.2s before the next.
            ocr_interval = ocr_interval.max((res.took * DUTY_FACTOR).min(DUTY_CAP));
            last_found = found;
            let fresh: Vec<Tracked> = match (snap, prev.as_ref()) {
                (Some(then), Some(now)) => res.hits.iter().map(|h| follow(h, &then, now, now.h / 2)).collect(),
                _ => res.hits,
            };
            // A band read replaces only the findings inside that band - unless the window has
            // scrolled since it was read, when band coordinates no longer line up: replace all.
            let scrolled_since = last_motion.is_some_and(|(_, f)| f > res.frame);
            let (b0, b1) = res.band;
            if !scrolled_since {
                hits.retain(|h| h.y1 <= b0 || h.y0 >= b1);
                hits.extend(fresh);
            } else {
                hits = fresh;
            }
            last_result_frame = last_result_frame.max(res.frame);
            if res.lines > 0 && first_result_frame.is_some_and(|f| res.frame >= f) {
                first_result_frame = None;
            }
            changed = true;
        }

        // A new frame: move every blur with its text.
        match c.pool.TryGetNextFrame() {
            Ok(f) => {
                // A frame that can't be read (the window closing mid-frame) is skipped, never fatal.
                let Ok(size) = f.ContentSize() else { continue };
                if size.Width != c.size.Width || size.Height != c.size.Height {
                    drop(f);
                    lost_capture = c.resize(&device, &d3d, size).is_err();
                    prev = None;
                    ocr_base = None;
                    dirty = true;
                    continue;
                }
                let Ok(tex) = f.Surface().and_then(|s| s.cast::<IDirect3DDxgiInterfaceAccess>()).and_then(|a| a.GetInterface::<ID3D11Texture2D>()) else {
                    continue;
                };
                ctx.CopySubresourceRegion(&c.mip, 0, 0, 0, 0, &tex, 0, None);
                drop(f);
                ctx.GenerateMips(&c.srv);
                frame += 1;
                last_frame_at = Instant::now();
                // Worth an OCR pass? Only if it differs from what OCR last read by more than a
                // caret-sized sliver (2px at eighth resolution).
                if let Some(d) = c.read_diff(&ctx) {
                    let news = match &ocr_base {
                        None => true,
                        Some(base) => change(base, &d).is_some_and(|ch| !ch.is_caret(2)),
                    };
                    dirty |= news;
                    latest_diff = Some(d);
                }
                // Tracking needs a quarter-resolution copy; skip it (and its readback) when there's
                // nothing to move and no OCR pass in flight to realign.
                let track = !hits.is_empty() || secret_file || ocr_busy;
                if !track {
                    prev = None;
                } else if let Some(g) = c.read_track(&ctx) {
                    if let Some(p) = &prev {
                        if !g.same_as(p) {
                            let mut moved = false;
                            for h in hits.iter_mut() {
                                let next = follow(h, p, &g, MAX_STEP_Q);
                                if next.y0 != h.y0 {
                                    *h = next;
                                    moved = true;
                                }
                            }
                            if moved {
                                last_motion = Some((Instant::now(), frame));
                                changed = true;
                            }
                        }
                    }
                    prev = Some(g);
                }
            }
            Err(_) => std::thread::sleep(if last_frame_at.elapsed() < Duration::from_millis(300) { POLL_ACTIVE } else { POLL_IDLE }),
        }

        // Hand the newest frame to OCR when the window changed and OCR is free - but not in the
        // middle of a scroll (stale on arrival; the covers handle it), bar a periodic safety pass.
        let mid_scroll = last_motion.is_some_and(|(at, _)| at.elapsed() < SCROLL_SETTLE);
        if dirty && !ocr_busy && last_ocr.elapsed() >= ocr_interval && (!mid_scroll || last_ocr.elapsed() >= SCROLL_OCR_EVERY) {
            // Just the band that changed since the last read (full width, so a value's name at the
            // left of its line is read with it) - typing re-reads a line or two, not the window.
            let full_h = c.size.Height as u32;
            let band = match (&ocr_base, &latest_diff, first_result_frame) {
                (Some(base), Some(now), None) => change(base, now).map(|ch| {
                    let scale = 1u32 << DIFF_LEVEL;
                    ((ch.y0 as u32 * scale).saturating_sub(BAND_MARGIN_PX), (ch.y1 as u32 * scale + BAND_MARGIN_PX).min(full_h))
                }),
                _ => None,
            };
            let (y0, y1) = band.filter(|(a, b)| ((b - a) as f32) < full_h as f32 * FULL_READ_SHARE).unwrap_or((0, full_h));
            // The grey copy OCR's findings will be realigned from - this exact frame.
            let snap = c.read_track(&ctx);
            if let (Some((bgra, w, h, factor)), Some(g)) = (c.read_ocr(&ctx, y0, y1), snap) {
                snapshots.retain(|f, _| frame.saturating_sub(*f) < 600);
                snapshots.insert(frame, g.clone());
                prev = Some(g);
                let rules = rules.lock().map(|r| r.clone()).unwrap_or_default();
                if req_tx.send(OcrRequest { hwnd: hwnd.0, frame, bgra, w, h, y0, factor, rules, secret_file }).is_ok() {
                    ocr_busy = true;
                    dirty = false;
                    last_ocr = Instant::now();
                    ocr_base = latest_diff.clone();
                }
            }
        }

        // Covers for what OCR hasn't read yet: a secrets file until its first pass; the secret
        // columns of a window while it scrolls, and until OCR has read where it stopped.
        let (fw, fh) = (c.size.Width as f32, c.size.Height as f32);
        let scrolling = last_motion.is_some_and(|(at, f)| at.elapsed() < SCROLL_HOLD || f > last_result_frame);
        let cover: Option<Tracked> = if secret_file && first_result_frame.is_some() {
            Some(Tracked { x0: 0.0, y0: 0.0, x1: fw, y1: fh, label: "Sensitive file", tone: None })
        } else if scrolling && (!hits.is_empty() || secret_file) {
            let (x0, x1) = if hits.is_empty() {
                (0.0, fw)
            } else {
                (hits.iter().map(|h| h.x0).fold(f32::MAX, f32::min), hits.iter().map(|h| h.x1).fold(f32::MIN, f32::max))
            };
            Some(Tracked { x0, y0: 0.0, x1, y1: fh, label: "Hidden while scrolling", tone: None })
        } else {
            None
        };

        let scale = GetDpiForWindow(hwnd).max(96) as f32 / 96.0;
        let pad = (4.0 * scale).round();
        let all: Vec<&Tracked> = hits.iter().chain(cover.iter()).collect();
        let key: Vec<(i32, i32, i32, i32)> = all.iter().map(|h| ((h.x0 - pad) as i32, (h.y0 - pad) as i32, (h.x1 + pad) as i32, (h.y1 + pad) as i32)).collect();
        if changed || sent.as_ref() != Some(&key) {
            if let Some(fr) = frame_rect(hwnd) {
                let tone_of = |h: &Tracked| -> Option<(u8, u8, u8)> {
                    h.tone.or_else(|| {
                        // Covers: the average grey under them, from the tracking frame.
                        let g = prev.as_ref()?;
                        let (x0, y0) = ((h.x0 / 4.0).max(0.0) as usize, (h.y0 / 4.0).max(0.0) as usize);
                        let (x1, y1) = (((h.x1 / 4.0) as usize).min(g.w), ((h.y1 / 4.0) as usize).min(g.h));
                        if x1 <= x0 || y1 <= y0 {
                            return None;
                        }
                        let (mut sum, mut n) = (0u64, 0u64);
                        for y in (y0..y1).step_by(4) {
                            for x in (x0..x1).step_by(4) {
                                sum += g.px[y * g.w + x] as u64;
                                n += 1;
                            }
                        }
                        let v = (sum / n.max(1)) as u8;
                        Some((v, v, v))
                    })
                };
                let out = all
                    .iter()
                    .zip(&key)
                    .map(|(h, k)| ScreenHit { rect: RECT { left: fr.left + k.0, top: fr.top + k.1, right: fr.left + k.2, bottom: fr.top + k.3 }, label: h.label, tone: tone_of(h) })
                    .collect();
                sink(hwnd.0, fr, out);
                sent = Some(key);
            }
        }
    }
    Ok(())
}

// Background mode: lowest CPU, I/O and memory priority - OCR always yields to whatever the user is
// actually doing, so it can never make the machine feel slow.
fn background_thread() {
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
}

// One horizontal strip of a band, for an OCR helper thread.
struct Strip {
    bgra: Vec<u8>,
    w: u32,
    h: u32,
    // Strip rows within the band, and the part of them this strip is responsible for.
    top: u32,
    core: (u32, u32),
}

// OCR helpers for big reads, each with its own engine: Windows OCR runs a call on one core, so a
// full 4K window (~2.7s alone) is cut into strips read side by side - at most two, leaving the
// rest of the machine to the user (four measured >100% of a core under load).
fn spawn_helpers() -> Vec<(Sender<Strip>, Receiver<Vec<Line>>)> {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    (0..cores.saturating_sub(2).clamp(1, 2))
        .filter_map(|i| {
            let (job_tx, job_rx) = mpsc::channel::<Strip>();
            let (out_tx, out_rx) = mpsc::channel::<Vec<Line>>();
            std::thread::Builder::new()
                .name(format!("screen-blur-ocr-{}", i))
                .spawn(move || {
                    background_thread();
                    let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() else { return };
                    while let Ok(strip) = job_rx.recv() {
                        let lines = recognize(&engine, &strip.bgra, strip.w, strip.h).unwrap_or_default();
                        // Keep the lines whose middle falls in this strip's own part, shifted into
                        // band coordinates - a seam line is kept by exactly one strip.
                        let kept = lines
                            .into_iter()
                            .filter_map(|mut l| {
                                let ys: Vec<f32> = l.words.iter().map(|w| w.y + w.h / 2.0).collect();
                                let mid = ys.iter().sum::<f32>() / ys.len().max(1) as f32 + strip.top as f32;
                                if mid < strip.core.0 as f32 || mid >= strip.core.1 as f32 {
                                    return None;
                                }
                                l.words.iter_mut().for_each(|w| w.y += strip.top as f32);
                                Some(l)
                            })
                            .collect();
                        if out_tx.send(kept).is_err() {
                            break;
                        }
                    }
                })
                .ok()
                .map(|_| (job_tx, out_rx))
        })
        .collect()
}

// Reads a band: inline when it's short (typing, a new line), split across the helpers when it's
// tall (a new window, a page change).
fn read_band(engine: &OcrEngine, helpers: &[(Sender<Strip>, Receiver<Vec<Line>>)], req: &OcrRequest) -> windows::core::Result<Vec<Line>> {
    if req.h <= SPLIT_ABOVE_PX || helpers.len() < 2 {
        return recognize(engine, &req.bgra, req.w, req.h);
    }
    let n = helpers.len() as u32;
    let row = req.w as usize * 4;
    let step = req.h.div_ceil(n);
    let mut sent = 0;
    for (i, (tx, _)) in helpers.iter().enumerate() {
        let core = (i as u32 * step, ((i as u32 + 1) * step).min(req.h));
        if core.0 >= core.1 {
            break;
        }
        let (top, bottom) = (core.0.saturating_sub(STRIP_OVERLAP_PX), (core.1 + STRIP_OVERLAP_PX).min(req.h));
        let bgra = req.bgra[top as usize * row..bottom as usize * row].to_vec();
        if tx.send(Strip { bgra, w: req.w, h: bottom - top, top, core }).is_ok() {
            sent += 1;
        }
    }
    let mut lines: Vec<Line> = helpers.iter().take(sent).flat_map(|(_, rx)| rx.recv().unwrap_or_default()).collect();
    lines.sort_by(|a, b| {
        let y = |l: &Line| l.words.first().map(|w| w.y).unwrap_or(0.0);
        y(a).total_cmp(&y(b))
    });
    Ok(lines)
}

fn spawn_ocr(engine: OcrEngine, rx: Receiver<OcrRequest>, tx: Sender<OcrResult>, stop: Arc<AtomicBool>) {
    let _ = std::thread::Builder::new().name("screen-blur-ocr".into()).spawn(move || {
        background_thread();
        let helpers = spawn_helpers();
        let mut passes = 0u32;
        while let Ok(mut req) = rx.recv() {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            // Only the newest request matters - skip any that queued up behind it.
            while let Ok(newer) = rx.try_recv() {
                req = newer;
            }
            let started = Instant::now();
            let recognized = read_band(&engine, &helpers, &req);
            if let Err(e) = &recognized {
                log::warn!("Screen blur: OCR failed on a {}x{} frame: {}", req.w, req.h, e);
            }
            if passes < 6 {
                passes += 1;
                log::info!(
                    "Screen blur: OCR pass {} on {}x{}: {} lines in {}ms",
                    passes,
                    req.w,
                    req.h,
                    recognized.as_ref().map(|l| l.len()).unwrap_or(0),
                    started.elapsed().as_millis()
                );
            }
            let line_count = recognized.as_ref().map(|l| l.len()).unwrap_or(0);
            let hits = recognized
                .map(|lines| {
                    complete_with_ink(&lines, find_sensitive(&lines, &req.rules), &req)
                        .into_iter()
                        .map(|h| Tracked {
                            x0: h.x * req.factor,
                            y0: h.y * req.factor + req.y0 as f32,
                            x1: (h.x + h.w) * req.factor,
                            y1: (h.y + h.h) * req.factor + req.y0 as f32,
                            label: h.label,
                            tone: average_bgra(&req.bgra, req.w as usize, req.h as usize, h.x as i64, h.y as i64, (h.x + h.w) as i64, (h.y + h.h) as i64),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let band = (req.y0 as f32, req.y0 as f32 + req.h as f32 * req.factor);
            if tx.send(OcrResult { hwnd: req.hwnd, frame: req.frame, band, hits, lines: line_count, took: started.elapsed() }).is_err() {
                break;
            }
        }
    });
}

// Windows OCR drops what it can't read as words - and keys are exactly that: on a .env it returned
// "STRIPE_SECRET" and nothing after it, and skipped some key lines entirely. So findings are
// completed from the pixels: a value is blurred out to where its line's ink actually ends, and in
// a secrets file, ink OCR never accounted for is hidden as well.
fn complete_with_ink(lines: &[Line], mut found: Vec<Hit>, req: &OcrRequest) -> Vec<Hit> {
    let (w, h) = (req.w as usize, req.h as usize);
    let ink = InkMap::new(&req.bgra, w, h);
    found.retain_mut(|hit| {
        if !matches!(hit.label, "Secret" | "API key" | "Password" | "Connection string") {
            return true;
        }
        let (y0, y1) = (hit.y.max(0.0) as usize, (hit.y + hit.h).max(0.0) as usize);
        let from = (hit.x + hit.w).max(0.0) as usize;
        if let Some(end) = ink.ink_end(y0, y1, from, (hit.h * 2.5) as usize) {
            if end as f32 > hit.x + hit.w {
                hit.w = end as f32 - hit.x;
            }
        }
        // A secret name with no value after it after all.
        hit.w >= 1.0
    });
    if req.secret_file {
        let mut extra = Vec::new();
        for (y0, y1) in ink.text_bands(6, 120) {
            let band_h = y1 - y0;
            let overlaps = |y: f32, hh: f32| y < y1 as f32 && y + hh > y0 as f32;
            let mut covered = vec![false; w];
            let mut cover = |x: f32, ww: f32| {
                let (a, b) = ((x - 2.0).max(0.0) as usize, ((x + ww + 2.0).max(0.0) as usize).min(w));
                covered[a.min(b)..b].iter_mut().for_each(|c| *c = true);
            };
            for word in lines.iter().flat_map(|l| &l.words).filter(|wd| overlaps(wd.y, wd.h)) {
                cover(word.x, word.w);
            }
            for hit in found.iter().filter(|hh| overlaps(hh.y, hh.h)) {
                cover(hit.x, hit.w);
            }
            // Runs narrower than ~2 line-heights are icons and glyph fragments, not hidden values.
            for (s, e) in ink.unread_runs(y0, y1, &covered, band_h * 2, band_h * 2) {
                extra.push(Hit { x: s as f32, y: y0 as f32, w: (e - s) as f32, h: band_h as f32, label: "Unreadable text" });
            }
        }
        found.extend(extra);
    }
    found
}

// OCR of a tightly packed BGRA image, as lines of words in its own pixel coordinates.
fn recognize(engine: &OcrEngine, bgra: &[u8], w: u32, h: u32) -> windows::core::Result<Vec<Line>> {
    let buffer = CryptographicBuffer::CreateFromByteArray(bgra)?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w as i32, h as i32, BitmapAlphaMode::Premultiplied)?;
    let result = engine.RecognizeAsync(&bitmap)?.get()?;
    let mut lines = Vec::new();
    for line in result.Lines()? {
        let mut words = Vec::new();
        for word in line.Words()? {
            let r = word.BoundingRect()?;
            words.push(Word { text: word.Text()?.to_string(), x: r.X, y: r.Y, w: r.Width, h: r.Height });
        }
        lines.push(Line { words });
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::secret_file_title;

    #[test]
    fn secret_files_by_title() {
        assert!(secret_file_title(".env - briefbrew [WSL: Ubuntu-22.04] - Visual Studio Code"));
        assert!(secret_file_title("\u{25CF} .env.production - api - Visual Studio Code"));
        assert!(secret_file_title("id_rsa - Notepad"));
        assert!(secret_file_title("server.pem - Notepad++"));
        assert!(!secret_file_title(".env.example - briefbrew - Visual Studio Code"));
        assert!(!secret_file_title("web.php - briefbrew - Visual Studio Code"));
        assert!(!secret_file_title("WhatsApp"));
    }
}
