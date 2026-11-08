// commands/window_capture/win.rs
//
// Windows window/monitor enumeration and the picker's previews via Win32 (EnumWindows/GDI/DWM).
// The orchestrator (window_capture.rs) owns the one canonical command per operation and
// dispatches into these. Windows are addressed by handle everywhere - a title is neither unique
// (two "Briefcast" windows) nor stable (a browser's title follows its active tab).
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::async_runtime::Mutex as AsyncMutex;
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection, DeleteDC,
    DeleteObject, EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject,
    SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE,
    HBITMAP, HDC, HMONITOR, MONITORINFO, SRCCOPY,
};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::ExtractIconExW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DestroyIcon, DrawIconEx, EnumWindows, FindWindowW, GetClassLongPtrW,
    GetClientRect, GetWindow, GetWindowLongPtrW, GetWindowPlacement, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
    IsWindowVisible, SendMessageTimeoutW, SetForegroundWindow, SetWindowsHookExW, ShowWindow,
    UnhookWindowsHookEx, DI_NORMAL, GCLP_HICON, GWL_EXSTYLE, GW_OWNER, HHOOK, HICON, ICON_BIG,
    SMTO_ABORTIFHUNG, SW_RESTORE, SW_SHOWNOACTIVATE, WH_SHELL, WINDOWPLACEMENT, WM_GETICON,
    WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};
// PrintWindow/PRINT_WINDOW_FLAGS live under Storage::Xps in this crate version's metadata,
// not UI::WindowsAndMessaging where the Win32 docs file them.
use image::RgbaImage;
use log::info;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};

use super::{MonitorInfo, WindowInfo, WindowTitles};

// Written from a WH_SHELL callback, which runs synchronously on the OS message-pump thread
// and cannot await - a plain std Mutex (held only for a trivial array swap) avoids needing
// tauri::async_runtime::block_on inside that callback.
static LAST_TWO_WINDOWS: OnceLock<Mutex<[String; 2]>> = OnceLock::new();
static IS_MONITORING: AtomicBool = AtomicBool::new(false);
static HOOK: OnceLock<AsyncMutex<Option<HHOOK>>> = OnceLock::new();
static CAPTURE_RUN_COUNTER: AtomicU64 = AtomicU64::new(0);

// Big enough to read a window's content on a 4K picker card, small enough to encode in a few
// milliseconds - the full-size PNGs this used to write took seconds for a handful of 4K windows.
const THUMB_MAX: (u32, u32) = (640, 400);
const ICON_SIZE: i32 = 32;

pub fn get_last_two_windows() -> &'static Mutex<[String; 2]> {
    LAST_TWO_WINDOWS.get_or_init(|| Mutex::new([String::new(), String::new()]))
}

fn get_hook() -> &'static AsyncMutex<Option<HHOOK>> {
    HOOK.get_or_init(|| AsyncMutex::new(None))
}

pub(crate) fn hwnd(raw: isize) -> HWND {
    HWND(raw)
}

pub(crate) fn is_window(raw: isize) -> bool {
    raw != 0 && unsafe { IsWindow(HWND(raw)).as_bool() }
}

pub(crate) fn is_minimized(raw: isize) -> bool {
    unsafe { IsIconic(HWND(raw)).as_bool() }
}

// A minimized window has no picture to capture. Restored without activating it, so recording
// a window never pulls it in front of what the user is doing.
pub(crate) fn restore_without_focus(raw: isize) -> bool {
    if !is_minimized(raw) {
        return false;
    }
    unsafe {
        let _ = ShowWindow(HWND(raw), SW_SHOWNOACTIVATE);
    }
    true
}

// The visible bounds (screen pixels) - GetWindowRect plus the invisible resize border Windows
// 10/11 pad every window with, which for a maximized window reaches past every screen edge.
fn frame_rect(h: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    let dwm_ok = unsafe {
        DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok()
    };
    if !dwm_ok && unsafe { GetWindowRect(h, &mut rect) }.is_err() {
        return None;
    }
    (rect.right > rect.left && rect.bottom > rect.top).then_some(rect)
}

// What a window capture of `raw` picks up, in screen pixels: its content area alone, or with
// `title_bar` its whole visible frame. None for a window that's gone or has no area.
pub(crate) fn capture_rect(raw: isize, title_bar: bool) -> Option<(i32, i32, i32, i32)> {
    let h = HWND(raw);
    if !is_window(raw) {
        return None;
    }
    if title_bar {
        let r = frame_rect(h)?;
        return Some((r.left, r.top, r.right - r.left, r.bottom - r.top));
    }
    unsafe {
        let mut client = RECT::default();
        GetClientRect(h, &mut client).ok()?;
        let mut origin = POINT { x: 0, y: 0 };
        if !ClientToScreen(h, &mut origin).as_bool() {
            return None;
        }
        let (w, hgt) = (client.right - client.left, client.bottom - client.top);
        (w > 0 && hgt > 0).then_some((origin.x, origin.y, w, hgt))
    }
}

// The window's size as the user knows it - for a minimized one, the size it restores to.
fn display_size(h: HWND) -> (i32, i32) {
    unsafe {
        if IsIconic(h).as_bool() {
            let mut placement = WINDOWPLACEMENT {
                length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                ..Default::default()
            };
            if GetWindowPlacement(h, &mut placement).is_ok() {
                let r = placement.rcNormalPosition;
                return (r.right - r.left, r.bottom - r.top);
            }
            return (0, 0);
        }
    }
    frame_rect(h).map_or((0, 0), |r| (r.right - r.left, r.bottom - r.top))
}

// Renders a window into a bitmap via PrintWindow(PW_RENDERFULLCONTENT), which asks the window to
// draw itself - the only GDI route that sees GPU/DWM-composited content (nearly every modern app),
// and one that works whether or not the window is covered. Only the visible frame (the raw
// bitmap includes the transparent resize border) is scaled down by GDI into the thumbnail, and
// only that is read back: reading and resizing a 4K window's full bitmap pixel by pixel took
// seconds per window.
fn window_thumbnail(h: HWND) -> Result<RgbaImage, String> {
    unsafe {
        let mut rect = RECT::default();
        GetWindowRect(h, &mut rect).map_err(|e| format!("GetWindowRect failed: {}", e))?;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 || width > 16384 || height > 16384 {
            return Err(format!("Invalid window dimensions: {}x{}", width, height));
        }
        let frame = frame_rect(h).unwrap_or(rect);
        let cx = (frame.left - rect.left).clamp(0, width - 1);
        let cy = (frame.top - rect.top).clamp(0, height - 1);
        let cw = (frame.right - frame.left).min(width - cx).max(1);
        let ch = (frame.bottom - frame.top).min(height - cy).max(1);
        let (tw, th) = fit(cw as u32, ch as u32, THUMB_MAX);

        let screen = GetDC(HWND(0));
        if screen.is_invalid() {
            return Err("Failed to get screen DC".to_string());
        }
        let full_dc = CreateCompatibleDC(screen);
        let full = CreateCompatibleBitmap(screen, width, height);
        let small_dc = CreateCompatibleDC(screen);
        let small = CreateCompatibleBitmap(screen, tw as i32, th as i32);
        let mut pixels = None;
        if !full_dc.is_invalid() && !full.is_invalid() && !small_dc.is_invalid() && !small.is_invalid() {
            let old_full = SelectObject(full_dc, full);
            let old_small = SelectObject(small_dc, small);
            // 2 = PW_RENDERFULLCONTENT (not re-exported with a proper PRINT_WINDOW_FLAGS type
            // alongside PrintWindow itself in this crate version's Storage::Xps module).
            if PrintWindow(h, full_dc, PRINT_WINDOW_FLAGS(2)).as_bool() {
                SetStretchBltMode(small_dc, HALFTONE);
                if StretchBlt(small_dc, 0, 0, tw as i32, th as i32, full_dc, cx, cy, cw, ch, SRCCOPY).as_bool() {
                    pixels = read_bitmap(small_dc, small, tw as i32, th as i32);
                }
            }
            SelectObject(full_dc, old_full);
            SelectObject(small_dc, old_small);
        }
        for bitmap in [full, small] {
            if !bitmap.is_invalid() {
                let _ = DeleteObject(bitmap);
            }
        }
        for dc in [full_dc, small_dc] {
            if !dc.is_invalid() {
                let _ = DeleteDC(dc);
            }
        }
        ReleaseDC(HWND(0), screen);

        let thumb = pixels.ok_or("PrintWindow failed")?;
        if looks_blank(&thumb) {
            return Err("The window drew nothing".to_string());
        }
        Ok(thumb)
    }
}

// A window drawn by itself at full size (PrintWindow, as in window_thumbnail), cropped to its
// visible frame: the frame's screen position and its pixels. Exact whatever is on top of the
// window or animating at that moment - what a screenshot of one window wants.
pub(crate) fn render_window(raw: isize) -> Option<(i32, i32, RgbaImage)> {
    let h = HWND(raw);
    unsafe {
        if !IsWindow(h).as_bool() || IsIconic(h).as_bool() {
            return None;
        }
        let mut rect = RECT::default();
        GetWindowRect(h, &mut rect).ok()?;
        let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
        if width <= 0 || height <= 0 || width > 16384 || height > 16384 {
            return None;
        }
        let frame = frame_rect(h).unwrap_or(rect);
        let cx = (frame.left - rect.left).clamp(0, width - 1);
        let cy = (frame.top - rect.top).clamp(0, height - 1);
        let cw = (frame.right - frame.left).min(width - cx).max(1);
        let ch = (frame.bottom - frame.top).min(height - cy).max(1);

        let screen = GetDC(HWND(0));
        if screen.is_invalid() {
            return None;
        }
        let full_dc = CreateCompatibleDC(screen);
        let full = CreateCompatibleBitmap(screen, width, height);
        let crop_dc = CreateCompatibleDC(screen);
        let crop = CreateCompatibleBitmap(screen, cw, ch);
        let mut pixels = None;
        if !full_dc.is_invalid() && !full.is_invalid() && !crop_dc.is_invalid() && !crop.is_invalid() {
            let old_full = SelectObject(full_dc, full);
            let old_crop = SelectObject(crop_dc, crop);
            if PrintWindow(h, full_dc, PRINT_WINDOW_FLAGS(2)).as_bool()
                && StretchBlt(crop_dc, 0, 0, cw, ch, full_dc, cx, cy, cw, ch, SRCCOPY).as_bool()
            {
                pixels = read_bitmap(crop_dc, crop, cw, ch);
            }
            SelectObject(full_dc, old_full);
            SelectObject(crop_dc, old_crop);
        }
        for bitmap in [full, crop] {
            if !bitmap.is_invalid() {
                let _ = DeleteObject(bitmap);
            }
        }
        for dc in [full_dc, crop_dc] {
            if !dc.is_invalid() {
                let _ = DeleteDC(dc);
            }
        }
        ReleaseDC(HWND(0), screen);
        pixels.filter(|p| !looks_blank(p)).map(|p| (frame.left, frame.top, p))
    }
}

// Reads a 32-bit bitmap selected into `hdc` as opaque RGBA.
unsafe fn read_bitmap(hdc: HDC, bitmap: HBITMAP, width: i32, height: i32) -> Option<RgbaImage> {
    let mut bmi = bitmap_info(width, height);
    let mut buffer = vec![0u8; (width * height * 4) as usize];
    let lines = GetDIBits(
        hdc,
        bitmap,
        0,
        height as u32,
        Some(buffer.as_mut_ptr() as *mut _),
        &mut bmi,
        DIB_RGB_COLORS,
    );
    if lines == 0 {
        return None;
    }
    for px in buffer.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }
    RgbaImage::from_raw(width as u32, height as u32, buffer)
}

fn bitmap_info(width: i32, height: i32) -> BITMAPINFO {
    BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // Negative for top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        bmiColors: [windows::Win32::Graphics::Gdi::RGBQUAD::default(); 1],
    }
}

// A window that failed to draw comes back one flat colour (black, usually). Sampled on a grid
// over the whole picture - the old check read only the first 1000 pixels, which on any window
// wider than that is just the top row, and so failed every maximized window on its black border.
fn looks_blank(img: &RgbaImage) -> bool {
    let (w, h) = img.dimensions();
    let first = *img.get_pixel(0, 0);
    for gy in 0..48 {
        for gx in 0..64 {
            let p = img.get_pixel(gx * (w - 1) / 63, gy * (h - 1) / 47);
            if (0..3).any(|c| p[c].abs_diff(first[c]) > 6) {
                return false;
            }
        }
    }
    true
}

// `w`x`h` scaled down (never up) to fit `max`, aspect kept.
fn fit(w: u32, h: u32, max: (u32, u32)) -> (u32, u32) {
    let scale = (max.0 as f64 / w as f64).min(max.1 as f64 / h as f64).min(1.0);
    (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1))
}

// Get available monitors
pub fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    let mut monitors = Vec::new();

    unsafe extern "system" fn enum_monitor_callback(
        hmonitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(lparam.0 as *mut Vec<MonitorInfo>);

        unsafe {
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };

            if GetMonitorInfoW(hmonitor, &mut info).as_bool() {
                let monitor = MonitorInfo {
                    id: format!("monitor_{}", monitors.len()),
                    name: format!("Display {}", monitors.len() + 1),
                    x: info.rcMonitor.left,
                    y: info.rcMonitor.top,
                    width: info.rcMonitor.right - info.rcMonitor.left,
                    height: info.rcMonitor.bottom - info.rcMonitor.top,
                    is_primary: info.dwFlags == 1,
                };
                monitors.push(monitor);
            }
        }

        true.into()
    }

    unsafe {
        let _ = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(enum_monitor_callback),
            LPARAM(&mut monitors as *mut _ as isize),
        );
    }

    Ok(monitors)
}

// A small live picture of every monitor, scaled down by GDI while copying (HALFTONE keeps text
// legible) so nothing full-size is ever read back.
pub fn monitor_previews() -> HashMap<String, String> {
    let mut previews = HashMap::new();
    let monitors = get_monitors().unwrap_or_default();
    let run = CAPTURE_RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    unsafe {
        let screen = GetDC(HWND(0));
        if screen.is_invalid() {
            return previews;
        }
        for m in &monitors {
            if m.width <= 0 || m.height <= 0 {
                continue;
            }
            let (tw, th) = fit(m.width as u32, m.height as u32, THUMB_MAX);
            let mem = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, tw as i32, th as i32);
            if mem.is_invalid() || bitmap.is_invalid() {
                let _ = DeleteObject(bitmap);
                let _ = DeleteDC(mem);
                continue;
            }
            let old = SelectObject(mem, bitmap);
            SetStretchBltMode(mem, HALFTONE);
            let copied = StretchBlt(mem, 0, 0, tw as i32, th as i32, screen, m.x, m.y, m.width, m.height, SRCCOPY).as_bool();
            let image = if copied { read_bitmap(mem, bitmap, tw as i32, th as i32) } else { None };
            SelectObject(mem, old);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(mem);
            if let Some(image) = image {
                let path = std::env::temp_dir().join(format!("briefcast_monitor_{}_{}_{}.png", std::process::id(), run, m.id));
                if image.save(&path).is_ok() {
                    previews.insert(m.id.clone(), path.to_string_lossy().to_string());
                }
            }
        }
        ReleaseDC(HWND(0), screen);
    }
    previews
}

// Best-effort: the owning process's absolute executable path, used as a second, always-available
// identifier in the window picker. Any failure along the way (no process for the hwnd, access
// denied opening a protected/elevated process, ...) just yields an empty string rather than
// erroring the whole listing out over one window's metadata.
fn get_process_exe_path(pid: u32) -> String {
    unsafe {
        if pid == 0 {
            return String::new();
        }

        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };

        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        let path = if QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .is_ok()
        {
            String::from_utf16_lossy(&buffer[..size as usize])
        } else {
            String::new()
        };

        let _ = CloseHandle(process);
        path
    }
}

fn window_pid(h: HWND) -> u32 {
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(h, Some(&mut pid));
    }
    pid
}

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

// The executable's FileDescription ("Google Chrome", "Visual Studio Code"), else its file stem.
fn app_name(exe_path: &str) -> String {
    let stem = std::path::Path::new(exe_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if exe_path.is_empty() {
        return stem;
    }
    unsafe {
        let path = wide(exe_path);
        let size = GetFileVersionInfoSizeW(PCWSTR(path.as_ptr()), None);
        if size == 0 {
            return stem;
        }
        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(PCWSTR(path.as_ptr()), 0, size, data.as_mut_ptr() as *mut _).is_err() {
            return stem;
        }
        let mut translation: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let query = wide("\\VarFileInfo\\Translation");
        if !VerQueryValueW(data.as_ptr() as *const _, PCWSTR(query.as_ptr()), &mut translation, &mut len).as_bool()
            || len < 4
        {
            return stem;
        }
        let lang = *(translation as *const u16);
        let codepage = *(translation as *const u16).add(1);
        let key = wide(&format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", lang, codepage));
        let mut value: *mut std::ffi::c_void = std::ptr::null_mut();
        if !VerQueryValueW(data.as_ptr() as *const _, PCWSTR(key.as_ptr()), &mut value, &mut len).as_bool()
            || len <= 1
        {
            return stem;
        }
        let text = std::slice::from_raw_parts(value as *const u16, len as usize);
        let description = String::from_utf16_lossy(text).trim_end_matches('\0').trim().to_string();
        if description.is_empty() {
            stem
        } else {
            description
        }
    }
}

// The window's own big icon, else its class icon, else the executable's first icon.
fn window_icon(h: HWND, exe_path: &str) -> Option<RgbaImage> {
    unsafe {
        let mut result = 0usize;
        let _ = SendMessageTimeoutW(
            h,
            WM_GETICON,
            WPARAM(ICON_BIG as usize),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            100,
            Some(&mut result),
        );
        let mut icon = HICON(result as isize);
        if icon.is_invalid() {
            icon = HICON(GetClassLongPtrW(h, GCLP_HICON) as isize);
        }
        let mut owned = false;
        if icon.is_invalid() && !exe_path.is_empty() {
            let path = wide(exe_path);
            let mut large = HICON::default();
            if ExtractIconExW(PCWSTR(path.as_ptr()), 0, Some(&mut large), None, 1) > 0 {
                icon = large;
                owned = true;
            }
        }
        if icon.is_invalid() {
            return None;
        }
        let image = render_icon(icon);
        if owned {
            let _ = DestroyIcon(icon);
        }
        image
    }
}

unsafe fn render_icon(icon: HICON) -> Option<RgbaImage> {
    let screen = GetDC(HWND(0));
    let mem = CreateCompatibleDC(screen);
    let bmi = bitmap_info(ICON_SIZE, ICON_SIZE);
    let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
    let dib = CreateDIBSection(mem, &bmi, DIB_RGB_COLORS, &mut bits, None, 0);
    let result = match dib {
        Ok(dib) if !bits.is_null() => {
            let old = SelectObject(mem, dib);
            let drawn = DrawIconEx(mem, 0, 0, icon, ICON_SIZE, ICON_SIZE, 0, None, DI_NORMAL).is_ok();
            let n = (ICON_SIZE * ICON_SIZE * 4) as usize;
            let mut px = std::slice::from_raw_parts(bits as *const u8, n).to_vec();
            SelectObject(mem, old);
            let _ = DeleteObject(dib);
            if drawn {
                // Old-style icons carry no alpha: everything drawn is opaque.
                let has_alpha = px.chunks_exact(4).any(|p| p[3] != 0);
                for p in px.chunks_exact_mut(4) {
                    p.swap(0, 2);
                    if !has_alpha && (p[0] | p[1] | p[2]) != 0 {
                        p[3] = 255;
                    }
                }
                RgbaImage::from_raw(ICON_SIZE as u32, ICON_SIZE as u32, px)
            } else {
                None
            }
        }
        _ => None,
    };
    let _ = DeleteDC(mem);
    ReleaseDC(HWND(0), screen);
    result
}

// What Alt+Tab would show: visible, titled, not a tool window, not owned (a dialog belongs to
// its window, not the list) unless it asks to be, and not cloaked (on another virtual desktop,
// or a suspended Store app's frame).
fn is_pickable(h: HWND, title: &str) -> bool {
    if title.is_empty()
        || title.contains("Program Manager")
        || title == "Windows Shell Experience Host"
        || title == "Windows Input Experience"
        || title == "MSCTFIME UI"
        || title == "Default IME"
    {
        return false;
    }
    unsafe {
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        let owner = GetWindow(h, GW_OWNER);
        if owner.0 != 0 && ex & WS_EX_APPWINDOW.0 == 0 {
            return false;
        }
        let mut cloaked: u32 = 0;
        if DwmGetWindowAttribute(
            h,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
        {
            return false;
        }
    }
    let (w, hgt) = display_size(h);
    w > 100 && hgt > 100
}

pub async fn capture_window_screenshots_by_title(
    _app_handle: tauri::AppHandle,
) -> Result<Vec<WindowInfo>, String> {
    // PrintWindow is blocking GDI work - off the async runtime.
    tauri::async_runtime::spawn_blocking(list_windows)
        .await
        .map_err(|e| format!("Window listing task panicked: {}", e))?
}

// Every pickable window with its thumbnail, icon and app name - see capture_window_screenshots_by_title.
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let windows: Vec<(HWND, String)> = get_all_open_windows_titles()
        .into_iter()
        .map(|(h, title)| (h, title.trim_end_matches('\0').trim().to_string()))
        .filter(|(h, title)| is_pickable(*h, title))
        .collect();

    if windows.is_empty() {
        return Err("No valid windows found".to_string());
    }

    // Spread over a few threads: each window renders itself on its own UI thread, so they don't
    // serialize on each other.
    let run_id = format!(
        "{}_{}",
        std::process::id(),
        CAPTURE_RUN_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    {
        let temp_dir = std::env::temp_dir();
        let own_pid = unsafe { GetCurrentProcessId() };
        let raw: Vec<(isize, String)> = windows.iter().map(|(h, t)| (h.0, t.clone())).collect();
        let workers = std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(1, 4);
        let chunk = raw.len().div_ceil(workers);

        let mut infos: Vec<WindowInfo> = std::thread::scope(|scope| {
            let handles: Vec<_> = raw
                .chunks(chunk.max(1))
                .enumerate()
                .map(|(c, part)| {
                    let (temp_dir, run_id) = (&temp_dir, &run_id);
                    scope.spawn(move || {
                        let mut icons: HashMap<String, String> = HashMap::new();
                        let mut names: HashMap<String, String> = HashMap::new();
                        part.iter()
                            .enumerate()
                            .map(|(i, (raw_hwnd, title))| {
                                let index = c * chunk + i;
                                let h = HWND(*raw_hwnd);
                                let pid = window_pid(h);
                                let exe_path = get_process_exe_path(pid);
                                let is_minimized = unsafe { IsIconic(h).as_bool() };
                                let (width, height) = display_size(h);

                                // A thumbnail is purely cosmetic - a window is still perfectly
                                // valid to pick without one.
                                let image_path = if is_minimized {
                                    String::new()
                                } else {
                                    match window_thumbnail(h) {
                                        Ok(img) => {
                                            let path = temp_dir.join(format!("briefcast_window_{}_{}.png", run_id, index));
                                            match img.save(&path) {
                                                Ok(()) => path.to_string_lossy().to_string(),
                                                Err(_) => String::new(),
                                            }
                                        }
                                        Err(e) => {
                                            log::debug!("No thumbnail for '{}': {}", title, e);
                                            String::new()
                                        }
                                    }
                                };

                                let icon_path = icons
                                    .entry(exe_path.clone())
                                    .or_insert_with(|| {
                                        window_icon(h, &exe_path)
                                            .and_then(|icon| {
                                                let path = temp_dir.join(format!("briefcast_window_{}_icon_{}.png", run_id, index));
                                                icon.save(&path).ok().map(|_| path.to_string_lossy().to_string())
                                            })
                                            .unwrap_or_default()
                                    })
                                    .clone();
                                let app_name = names.entry(exe_path.clone()).or_insert_with(|| app_name(&exe_path)).clone();

                                WindowInfo {
                                    title: title.clone(),
                                    image_path,
                                    hwnd: *raw_hwnd,
                                    exe_path,
                                    app_name,
                                    icon_path,
                                    is_minimized,
                                    is_own: pid == own_pid,
                                    width,
                                    height,
                                }
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        // EnumWindows' order is front to back, which is also the most useful order to list them
        // in - minimized ones after everything on screen.
        infos.sort_by_key(|w| w.is_minimized);

        log::debug!(
            "Listed {} windows ({} with thumbnails)",
            infos.len(),
            infos.iter().filter(|w| !w.image_path.is_empty()).count()
        );
        Ok(infos)
    }
}

pub fn get_all_open_windows_titles() -> Vec<(HWND, String)> {
    let mut windows: Vec<(HWND, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_window), LPARAM(&mut windows as *mut _ as isize));
    }
    windows
}

unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let windows = &mut *(lparam.0 as *mut Vec<(HWND, String)>);
    if IsWindowVisible(hwnd).as_bool() {
        let length = GetWindowTextLengthW(hwnd) as usize;
        if length > 0 {
            let mut buffer = vec![0u16; length + 1];
            GetWindowTextW(hwnd, &mut buffer);
            let title = String::from_utf16_lossy(&buffer);
            windows.push((hwnd, title));
        }
    }
    true.into()
}

fn find_by_title(title: &str) -> Option<HWND> {
    let w = wide(title);
    let handle = unsafe { FindWindowW(PCWSTR::null(), PCWSTR(w.as_ptr())) };
    (handle.0 != 0).then_some(handle)
}

// The window a capture means: its handle when that's still a window, else (an older caller, or
// a window recreated since it was picked) the first window with its title.
pub(crate) fn resolve_window(raw: Option<isize>, title: &str) -> Option<isize> {
    if let Some(raw) = raw.filter(|&r| is_window(r)) {
        return Some(raw);
    }
    find_by_title(title).map(|h| h.0)
}

pub async fn activate_and_open_window(title: &str, raw: Option<isize>) -> Result<(), String> {
    let title = title.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let handle = resolve_window(raw, &title).ok_or_else(|| format!("Window '{}' not found", title))?;
        unsafe {
            let _ = ShowWindow(HWND(handle), SW_RESTORE);
            std::thread::sleep(std::time::Duration::from_millis(100));
            let _ = SetForegroundWindow(HWND(handle));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Activate window task panicked: {}", e))?
}

// The screen region a window covers, for capturing it as part of the screen (the fallback when
// it can't be captured on its own - see gpu_capture::window_capture_available), clamped to the
// desktop since gdigrab/ddagrab reject a region that pokes outside it.
pub fn get_window_rect(raw: Option<isize>, title: &str, title_bar: bool) -> Result<(i32, i32, i32, i32), String> {
    let handle = resolve_window(raw, title).ok_or_else(|| format!("Window '{}' not found", title))?;
    let (x, y, w, h) = capture_rect(handle, title_bar).ok_or_else(|| format!("Window '{}' has no area to capture", title))?;
    let monitors = get_monitors().unwrap_or_default();
    Ok(super::clamp_rect_to_desktop(&monitors, x, y, w, h))
}

pub async fn start_monitoring_windows() -> Result<(), String> {
    if IS_MONITORING.load(Ordering::Relaxed) {
        return Err("Monitoring is already active".to_string());
    }

    let hook = HOOK.get_or_init(|| AsyncMutex::new(None));
    let mut hook_guard = hook.lock().await;

    if hook_guard.is_some() {
        return Err("Hook is already set".to_string());
    }

    let thread_id = unsafe { GetCurrentThreadId() };

    *hook_guard = Some(unsafe {
        SetWindowsHookExW(WH_SHELL, Some(shell_proc), None, thread_id).map_err(|e| e.to_string())?
    });

    info!("Monitoring started");
    IS_MONITORING.store(true, Ordering::Relaxed);
    Ok(())
}

pub async fn stop_monitoring_windows() -> Result<(), String> {
    if !IS_MONITORING.load(Ordering::Relaxed) {
        return Err("Monitoring is not active".to_string());
    }

    let mut hook = get_hook().lock().await;
    if let Some(h) = hook.take() {
        unsafe {
            let _ = UnhookWindowsHookEx(h);
        }
    }

    IS_MONITORING.store(false, Ordering::Relaxed);
    info!("Monitoring stopped");
    Ok(())
}

unsafe extern "system" fn shell_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == 4 {
        let hwnd = HWND(wparam.0 as isize);
        let title = get_window_title(hwnd);

        if let Ok(mut last_two) = get_last_two_windows().lock() {
            last_two[0] = last_two[1].clone();
            last_two[1] = title;
        }
    }

    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

pub fn get_windows_titles() -> Vec<String> {
    let mut titles = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(enum_window_titles),
            LPARAM(&mut titles as *mut _ as isize),
        );
    }
    titles
}

unsafe extern "system" fn enum_window_titles(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let titles = &mut *(lparam.0 as *mut Vec<String>);
    if IsWindowVisible(hwnd).as_bool() {
        let length = GetWindowTextLengthW(hwnd) as usize;
        if length > 0 {
            let mut buffer = vec![0u16; length + 1];
            GetWindowTextW(hwnd, &mut buffer);
            let title = String::from_utf16_lossy(&buffer);
            titles.push(title);
        }
    }
    true.into()
}

pub async fn get_window_titles() -> Result<WindowTitles, String> {
    if !IS_MONITORING.load(Ordering::Relaxed) {
        return Err("Monitoring is not active".to_string());
    }

    let titles = get_last_two_windows().lock().map_err(|e| e.to_string())?;
    Ok(WindowTitles {
        active: titles[1].clone(),
        last_active: titles[0].clone(),
    })
}

pub fn get_window_title(hwnd: HWND) -> String {
    let mut text = [0u16; 512];
    unsafe {
        let len = GetWindowTextW(hwnd, &mut text);
        String::from_utf16_lossy(&text[..len as usize])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_scales_down_only() {
        assert_eq!(fit(3840, 2160, (640, 400)), (640, 360));
        assert_eq!(fit(300, 200, (640, 400)), (300, 200));
        assert_eq!(fit(1000, 4000, (640, 400)), (100, 400));
    }

    #[test]
    fn a_flat_picture_is_blank_and_a_detailed_one_is_not() {
        let mut img = RgbaImage::from_pixel(3840, 2160, image::Rgba([0, 0, 0, 255]));
        assert!(looks_blank(&img));
        // Content far from the first row - the old check never looked past it.
        for y in 1000..1100 {
            for x in 1800..2000 {
                img.put_pixel(x, y, image::Rgba([240, 240, 240, 255]));
            }
        }
        assert!(!looks_blank(&img));
    }

    // Not a unit test: lists this desktop's real windows and monitors the way the picker does and
    // copies what it made to $WINDOW_LIST_OUT for a look.
    #[test]
    #[ignore]
    fn lists_real_windows() {
        let Ok(out) = std::env::var("WINDOW_LIST_OUT") else { return };
        // As the app runs: per-monitor DPI aware, so every rect is in physical pixels.
        unsafe {
            let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
                windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            );
        }
        for (h, title) in get_all_open_windows_titles() {
            if is_pickable(h, title.trim_end_matches(' ').trim()) {
                let t = std::time::Instant::now();
                let thumb = window_thumbnail(h).is_ok();
                let t1 = t.elapsed();
                let exe = get_process_exe_path(window_pid(h));
                let t2 = t.elapsed();
                let _ = window_icon(h, &exe);
                let t3 = t.elapsed();
                let _ = app_name(&exe);
                println!("{:>10} thumb({})={:?} exe={:?} icon={:?} name={:?}", h.0, thumb, t1, t2 - t1, t3 - t2, t.elapsed() - t3);
            }
        }
        let started = std::time::Instant::now();
        let windows = list_windows().unwrap();
        println!("{} windows in {:?}", windows.len(), started.elapsed());
        for (i, w) in windows.iter().enumerate() {
            println!("{:>10} min={} own={} {}x{} [{}] {} | thumb={} icon={}", w.hwnd, w.is_minimized, w.is_own, w.width, w.height, w.app_name, w.title, !w.image_path.is_empty(), !w.icon_path.is_empty());
            if !w.image_path.is_empty() {
                let _ = std::fs::copy(&w.image_path, format!("{}/win{}.png", out, i));
            }
            if !w.icon_path.is_empty() {
                let _ = std::fs::copy(&w.icon_path, format!("{}/icon{}.png", out, i));
            }
            println!("    capture_rect content={:?} frame={:?}", capture_rect(w.hwnd, false), capture_rect(w.hwnd, true));
        }
        for (id, path) in monitor_previews() {
            let _ = std::fs::copy(&path, format!("{}/{}.png", out, id));
        }
    }
}
