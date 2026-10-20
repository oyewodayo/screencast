// commands/snip.rs
//
// Screenshots the way Snipping Tool does them: Briefcast hides itself, the whole desktop is
// frozen into memory in one GDI grab, and a full-screen overlay (src/components/SnipOverlay.tsx)
// shows that still image so the user can drag a region, click a window, or click a screen. The
// chosen area is cropped from the frozen pixels - so what's saved is exactly what was on screen
// at the moment of the freeze, with no Briefcast window in it and no focus juggling - saved to
// the screenshots folder and copied to the clipboard.
//
// Windows-only for now; elsewhere these commands report "unsupported" and the frontend falls back
// to the older capture path (take_screenshot).

use serde::{Deserialize, Serialize};
#[cfg(windows)]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

pub const SNIP_OVERLAY_LABEL: &str = "snip-overlay";

#[derive(Serialize, Clone, Copy, Debug)]
pub struct SnipRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize, Clone, Debug)]
pub struct SnipWindow {
    pub title: String,
    pub rect: SnipRect,
}

// What the overlay needs besides the pixels. Every rect is in physical pixels, relative to the
// frozen image's top-left (the virtual desktop's origin).
#[derive(Serialize, Clone, Debug)]
pub struct SnipInfo {
    pub width: i32,
    pub height: i32,
    // Where the image's top-left sits on the virtual desktop - where the overlay window goes.
    pub origin_x: i32,
    pub origin_y: i32,
    // Top to bottom in z-order, so the first hit under the cursor is the window the user sees.
    pub windows: Vec<SnipWindow>,
    pub monitors: Vec<SnipRect>,
    // Index into `monitors` of the primary display - where the overlay puts its toolbar.
    pub primary: usize,
}

#[derive(Deserialize, Debug)]
pub struct SnipSelection {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize, Clone, Debug)]
pub struct SnipResult {
    pub path: String,
    pub copied: bool,
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::Mutex;
    use windows::Win32::Foundation::{BOOL, HANDLE, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC,
        GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, HDC, HMONITOR, MONITORINFO, ROP_CODE, SRCCOPY,
    };
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetSystemMetrics, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible, GWL_EXSTYLE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
        WS_EX_TOOLWINDOW,
    };

    // The frozen desktop, top-down RGBA, plus where its origin sits in virtual-desktop coordinates.
    pub struct Frozen {
        pub rgba: Vec<u8>,
        pub info: SnipInfo,
        pub origin: (i32, i32),
    }

    pub static FROZEN: Mutex<Option<Frozen>> = Mutex::new(None);

    // One BitBlt of the entire virtual desktop (every monitor). CAPTUREBLT includes layered
    // windows (tooltips, menus, translucent apps), which a plain SRCCOPY leaves out.
    pub fn capture_desktop() -> Result<Frozen, String> {
        unsafe {
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if width <= 0 || height <= 0 {
                return Err("Couldn't read the desktop size".into());
            }

            let screen = GetDC(HWND(0));
            if screen.is_invalid() {
                return Err("Failed to get the screen".into());
            }
            let mem = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, width, height);
            let old = SelectObject(mem, bitmap);
            let blit = BitBlt(mem, 0, 0, width, height, screen, x, y, ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0));

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
            let lines = GetDIBits(mem, bitmap, 0, height as u32, Some(pixels.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);

            SelectObject(mem, old);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(mem);
            ReleaseDC(HWND(0), screen);

            blit.map_err(|e| format!("Screen capture failed: {}", e))?;
            if lines == 0 {
                return Err("Screen capture failed: no pixels returned".into());
            }

            // BGRA -> RGBA, fully opaque (GDI leaves alpha undefined).
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2);
                px[3] = 255;
            }

            let monitors = list_monitors(x, y);
            // The primary display is the one at the virtual desktop's (0, 0).
            let primary = monitors.iter().position(|m| m.x == -x && m.y == -y).unwrap_or(0);
            let info = SnipInfo {
                width,
                height,
                origin_x: x,
                origin_y: y,
                windows: list_windows(x, y, width, height),
                monitors,
                primary,
            };
            Ok(Frozen { rgba: pixels, info, origin: (x, y) })
        }
    }

    // Visible top-level windows, top to bottom, clipped to the desktop. Skips Briefcast's own
    // windows (hidden for the capture anyway), minimised and cloaked ones (other virtual
    // desktops, suspended UWP apps), tool windows, and slivers too small to aim at.
    fn list_windows(ox: i32, oy: i32, width: i32, height: i32) -> Vec<SnipWindow> {
        struct Ctx {
            out: Vec<SnipWindow>,
            pid: u32,
            origin: (i32, i32),
            size: (i32, i32),
        }
        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let ctx = &mut *(lparam.0 as *mut Ctx);
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return BOOL(1);
            }
            if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0 {
                return BOOL(1);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == ctx.pid {
                return BOOL(1);
            }
            let mut cloaked = 0u32;
            if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4).is_ok() && cloaked != 0 {
                return BOOL(1);
            }
            // The visible frame, without the invisible resize borders GetWindowRect includes.
            let mut r = RECT::default();
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut r as *mut RECT as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_err()
            {
                return BOOL(1);
            }
            let left = (r.left - ctx.origin.0).max(0);
            let top = (r.top - ctx.origin.1).max(0);
            let right = (r.right - ctx.origin.0).min(ctx.size.0);
            let bottom = (r.bottom - ctx.origin.1).min(ctx.size.1);
            if right - left < 40 || bottom - top < 40 {
                return BOOL(1);
            }
            let mut buf = [0u16; 256];
            let n = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
            ctx.out.push(SnipWindow {
                title,
                rect: SnipRect { x: left, y: top, width: right - left, height: bottom - top },
            });
            BOOL(1)
        }
        let mut ctx = Ctx { out: Vec::new(), pid: std::process::id(), origin: (ox, oy), size: (width, height) };
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut ctx as *mut Ctx as isize));
        }
        ctx.out
    }

    fn list_monitors(ox: i32, oy: i32) -> Vec<SnipRect> {
        unsafe extern "system" fn each(monitor: HMONITOR, _: HDC, _: *mut RECT, lparam: LPARAM) -> BOOL {
            let out = &mut *(lparam.0 as *mut Vec<RECT>);
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if GetMonitorInfoW(monitor, &mut info).as_bool() {
                out.push(info.rcMonitor);
            }
            BOOL(1)
        }
        let mut rects: Vec<RECT> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(HDC(0), None, Some(each), LPARAM(&mut rects as *mut _ as isize));
        }
        rects
            .into_iter()
            .map(|r| SnipRect { x: r.left - ox, y: r.top - oy, width: r.right - r.left, height: r.bottom - r.top })
            .collect()
    }

    // Puts the image on the clipboard as a DIB - what Paint, Word, Slack, Teams and browsers paste.
    pub fn copy_to_clipboard(rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
        let header = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: height as i32, // bottom-up, the form every consumer accepts
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let header_size = std::mem::size_of::<BITMAPINFOHEADER>();
        let row = width as usize * 4;
        let total = header_size + row * height as usize;
        unsafe {
            let mem = GlobalAlloc(GMEM_MOVEABLE, total).map_err(|e| format!("Clipboard memory: {}", e))?;
            let ptr = GlobalLock(mem) as *mut u8;
            if ptr.is_null() {
                return Err("Clipboard memory lock failed".into());
            }
            std::ptr::copy_nonoverlapping(&header as *const _ as *const u8, ptr, header_size);
            let dst = std::slice::from_raw_parts_mut(ptr.add(header_size), row * height as usize);
            for y in 0..height as usize {
                let src = &rgba[y * row..(y + 1) * row];
                let out = &mut dst[(height as usize - 1 - y) * row..(height as usize - y) * row];
                for (s, d) in src.chunks_exact(4).zip(out.chunks_exact_mut(4)) {
                    d[0] = s[2];
                    d[1] = s[1];
                    d[2] = s[0];
                    d[3] = 255;
                }
            }
            let _ = GlobalUnlock(mem);

            OpenClipboard(HWND(0)).map_err(|e| format!("Clipboard busy: {}", e))?;
            let _ = EmptyClipboard();
            // 8 = CF_DIB. On success the clipboard owns the memory.
            let set = SetClipboardData(8, HANDLE(mem.0 as isize));
            let _ = CloseClipboard();
            set.map(|_| ()).map_err(|e| format!("Couldn't copy to the clipboard: {}", e))
        }
    }
}

#[cfg(windows)]
fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

// Hides Briefcast, waits for it to actually leave the screen (plus any delay the user asked for),
// freezes the desktop, and shows the overlay over every monitor.
#[tauri::command]
pub async fn snip_begin(app_handle: AppHandle, delay_ms: Option<u64>) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (app_handle, delay_ms);
        return Err("unsupported".into());
    }
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            if let Some(w) = app_handle.get_webview_window(SNIP_OVERLAY_LABEL) {
                let _ = w.hide();
            }
            if let Some(w) = main_window(&app_handle) {
                let _ = w.hide();
            }
            // Windows animates a hiding window for ~200ms; capturing sooner catches it mid-fade.
            std::thread::sleep(std::time::Duration::from_millis(250 + delay_ms.unwrap_or(0)));

            let frozen = match platform::capture_desktop() {
                Ok(f) => f,
                Err(e) => {
                    if let Some(w) = main_window(&app_handle) {
                        let _ = w.show();
                    }
                    return Err(e);
                }
            };
            let (ox, oy) = frozen.origin;
            let (w, h) = (frozen.info.width, frozen.info.height);
            *platform::FROZEN.lock().unwrap() = Some(frozen);

            // Pre-declared in tauri.conf.json, like the app's other overlays: building a window
            // from a command - and moving it from this thread - has hung this app before (see
            // ANNOTATION_FEATURE_DISABLED in Dashboard.tsx). The page places and shows itself.
            let Some(overlay) = app_handle.get_webview_window(SNIP_OVERLAY_LABEL) else {
                platform::FROZEN.lock().unwrap().take();
                close_overlay_and_return(&app_handle);
                return Err("The screenshot overlay window is missing".into());
            };
            // The overlay shows itself once the frozen image is drawn (no black flash while the
            // pixels load). If it never does - the page failed - bring Briefcast back rather than
            // leave the user with no visible app.
            let _ = overlay.emit("snip-armed", SnipRect { x: ox, y: oy, width: w, height: h });
            let app = app_handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                let shown = app
                    .get_webview_window(SNIP_OVERLAY_LABEL)
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);
                if !shown && platform::FROZEN.lock().unwrap().take().is_some() {
                    log::warn!("Screenshot overlay never appeared; restoring the main window");
                    close_overlay_and_return(&app);
                }
            });
            Ok(())
        })
        .await
        .map_err(|e| format!("Screenshot task failed: {}", e))?
    }
}

#[tauri::command(async)]
pub fn snip_info() -> Option<SnipInfo> {
    #[cfg(windows)]
    {
        platform::FROZEN.lock().unwrap().as_ref().map(|f| f.info.clone())
    }
    #[cfg(not(windows))]
    {
        None
    }
}

// The frozen image as raw RGBA, for the overlay to put straight into a canvas - no encoding on
// either side, which is what makes the overlay appear instantly even on a 4K desktop.
#[tauri::command(async)]
pub fn snip_frame() -> tauri::ipc::Response {
    #[cfg(windows)]
    {
        let bytes = platform::FROZEN.lock().unwrap().as_ref().map(|f| f.rgba.clone()).unwrap_or_default();
        tauri::ipc::Response::new(bytes)
    }
    #[cfg(not(windows))]
    {
        tauri::ipc::Response::new(Vec::new())
    }
}

fn screenshot_path(file_name: &str, ext: &str) -> Result<std::path::PathBuf, String> {
    let dir = crate::services::utility::briefcast_dir()?.join("screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the screenshots folder: {}", e))?;
    let stem: String = file_name
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let stem = stem.trim().trim_end_matches('.');
    let stem = if stem.is_empty() { "Screenshot" } else { stem };
    let mut path = dir.join(format!("{}.{}", stem, ext));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{} ({}).{}", stem, n, ext));
        n += 1;
    }
    Ok(path)
}

fn close_overlay_and_return(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SNIP_OVERLAY_LABEL) {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Crops the frozen image to `selection`, saves it, and copies it to the clipboard.
#[tauri::command]
pub async fn snip_finish(
    app_handle: AppHandle,
    selection: SnipSelection,
    format: String,
    file_name: String,
    copy: bool,
) -> Result<SnipResult, String> {
    #[cfg(not(windows))]
    {
        let _ = (app_handle, selection, format, file_name, copy);
        return Err("unsupported".into());
    }
    #[cfg(windows)]
    {
        let frozen = platform::FROZEN.lock().unwrap().take();
        close_overlay_and_return(&app_handle);
        let frozen = frozen.ok_or("Nothing to save - the screenshot was already taken or cancelled")?;

        let result = tauri::async_runtime::spawn_blocking(move || {
            let (fw, fh) = (frozen.info.width, frozen.info.height);
            let x = selection.x.clamp(0, fw - 1);
            let y = selection.y.clamp(0, fh - 1);
            let w = selection.width.clamp(1, fw - x) as u32;
            let h = selection.height.clamp(1, fh - y) as u32;

            let row = fw as usize * 4;
            let mut rgba = Vec::with_capacity(w as usize * h as usize * 4);
            for line in y as usize..(y as usize + h as usize) {
                let start = line * row + x as usize * 4;
                rgba.extend_from_slice(&frozen.rgba[start..start + w as usize * 4]);
            }
            drop(frozen);

            let copied = copy && platform::copy_to_clipboard(&rgba, w, h).map_err(|e| log::warn!("{}", e)).is_ok();

            let ext = match format.to_lowercase().as_str() {
                "jpeg" | "jpg" => "jpg",
                "webp" => "webp",
                _ => "png",
            };
            let path = screenshot_path(&file_name, ext)?;
            let img = image::RgbaImage::from_raw(w, h, rgba).ok_or("Couldn't assemble the image")?;
            let file = std::fs::File::create(&path).map_err(|e| format!("Couldn't save the screenshot: {}", e))?;
            let mut out = std::io::BufWriter::new(file);
            match ext {
                "jpg" => {
                    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92)
                        .encode_image(&rgb)
                        .map_err(|e| format!("Couldn't encode the screenshot: {}", e))?;
                }
                "webp" => {
                    image::codecs::webp::WebPEncoder::new_lossless(&mut out)
                        .encode(&img, w, h, image::ExtendedColorType::Rgba8)
                        .map_err(|e| format!("Couldn't encode the screenshot: {}", e))?;
                }
                _ => {
                    // Fast compression: a 4K screenshot saves in a fraction of a second, a few
                    // percent larger than the slowest setting.
                    use image::ImageEncoder;
                    image::codecs::png::PngEncoder::new_with_quality(
                        &mut out,
                        image::codecs::png::CompressionType::Fast,
                        image::codecs::png::FilterType::Adaptive,
                    )
                    .write_image(&img, w, h, image::ExtendedColorType::Rgba8)
                    .map_err(|e| format!("Couldn't encode the screenshot: {}", e))?;
                }
            }
            Ok::<_, String>(SnipResult { path: path.to_string_lossy().into_owned(), copied })
        })
        .await
        .map_err(|e| format!("Screenshot task failed: {}", e))??;

        let _ = app_handle.emit("refresh-file-list", ());
        let _ = app_handle.emit("snip-done", &result);
        Ok(result)
    }
}

#[tauri::command(async)]
pub fn snip_cancel(app_handle: AppHandle) {
    #[cfg(windows)]
    {
        platform::FROZEN.lock().unwrap().take();
        let _ = app_handle.emit("snip-done", Option::<SnipResult>::None);
    }
    close_overlay_and_return(&app_handle);
}

#[cfg(all(test, windows))]
mod tests {
    use super::platform;

    // Grabs the real desktop - run on demand: cargo test freezes_the_desktop -- --ignored
    #[test]
    #[ignore]
    fn freezes_the_desktop() {
        let frozen = platform::capture_desktop().expect("capture");
        let (w, h) = (frozen.info.width as usize, frozen.info.height as usize);
        assert_eq!(frozen.rgba.len(), w * h * 4);
        assert!(!frozen.info.monitors.is_empty());
        assert!(frozen.rgba.chunks_exact(4).step_by(997).any(|p| p[0] | p[1] | p[2] != 0), "all black");
        assert!(frozen.rgba.chunks_exact(4).all(|p| p[3] == 255));
        eprintln!(
            "{}x{} origin {:?}, monitors {:?} (primary {}), {} windows, first: {:?}",
            w,
            h,
            frozen.origin,
            frozen.info.monitors,
            frozen.info.primary,
            frozen.info.windows.len(),
            frozen.info.windows.first().map(|w| (&w.title, w.rect))
        );
    }
}
