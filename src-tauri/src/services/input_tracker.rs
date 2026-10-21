// services/input_tracker.rs
//
// Records the pointer and keyboard shortcuts during a screen recording, for the editor's
// screen-recording polish (pointerTrack.ts, keystrokes.ts) - the Screen Studio way: the screen is
// captured WITHOUT the pointer ("Editable pointer" turns ffmpeg's own cursor drawing off), and its
// path, clicks and looks are written to "<name>.pointer.json" beside the video, so the editor can
// draw it back smoothed, enlarged, with click ripples, hidden while idle - or not at all.
//
// - Movement and clicks come from a low-level mouse hook (WH_MOUSE_LL), the same mechanism as
//   click_tracker.rs: exact event times, at most PATH_RATE samples a second kept.
// - Looks: the system cursor (GetCursorInfo) is checked on every event and on a 50 ms timer, and
//   each distinct cursor's real bitmap is captured once (drawn on black and on white to recover
//   its colour and transparency - the I-beam and other inverting cursors become black with a white
//   outline, readable on any background).
// - Shortcuts (only when asked, "Record shortcuts"): a low-level keyboard hook keeps ONLY presses
//   made with Ctrl, Alt or Win held, plus Enter/Esc/Tab/F-keys. Ordinary typing - letters, digits,
//   punctuation, with or without Shift, and anything typed through AltGr - is never recorded, so
//   passwords and messages typed on camera don't end up in a file.
//
// Positions are the recorded area's own pixels at the moment the recording started; a window
// recording re-reads the window's place every 50 ms, so the path follows the window when it moves.
// Times are QPC instants (audio_capture::now_hns), mapped onto the final file at stop - pauses cut.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::thread::JoinHandle;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW, PatBlt, ReleaseDC, SelectObject, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, BLACKNESS, DIB_RGB_COLORS, HBRUSH, HGDIOBJ, ROP_CODE, WHITENESS,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{MapVirtualKeyW, MAPVK_VK_TO_CHAR};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, DrawIconEx, GetCursorInfo, GetCursorPos, GetIconInfo, GetMessageW, KillTimer, PostThreadMessageW, SetTimer,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, HCURSOR, HHOOK, HICON, ICONINFO, KBDLLHOOKSTRUCT, MSG,
    MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN,
    WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
};

use crate::services::audio_capture::now_hns;

// Movement kept at most this often (a 1000 Hz mouse would otherwise log 3.6 million points an
// hour); the editor's path is built at the same rate.
const PATH_RATE_HNS: i64 = 10_000_000 / 240;
// The timer that catches what no event announces: a cursor changing look while the mouse rests, a
// window moving, the last position of a quick flick.
const TICK_MS: u32 = 50;
// A still pointer is noted again this often, so the path is never empty for long (a recording
// paused and resumed with the pointer elsewhere picks it up within this).
const KEEPALIVE_HNS: i64 = 10_000_000;

// Briefcast's own global shortcuts (Dashboard.tsx) - pressing them runs the recorder, not the demo.
const OWN_HOTKEYS: [&[&str]; 5] = [&["Ctrl", "Shift", "R"], &["Ctrl", "Shift", "H"], &["Ctrl", "Shift", "B"], &["Ctrl", "Shift", "D"], &["Alt", "Shift", "V"]];

// What's being recorded: a fixed area of the screen, or a window (followed as it moves).
pub enum Area {
    Fixed { x: i32, y: i32, width: i32, height: i32 },
    Window { hwnd: Option<isize>, title: String, title_bar: bool, x: i32, y: i32, width: i32, height: i32 },
}

pub struct CursorBitmap {
    pub id: i32,
    pub hot_x: i32,
    pub hot_y: i32,
    pub png: Vec<u8>,
}

// Everything recorded, with QPC times.
pub struct InputLog {
    pub width: i32,
    pub height: i32,
    pub moves: Vec<(i64, f32, f32)>,
    // (time, x, y, button: 0 left, 1 right, 2 middle)
    pub clicks: Vec<(i64, f32, f32, u8)>,
    // (time, cursor id; -1 while the system hides the pointer)
    pub shapes: Vec<(i64, i32)>,
    pub cursors: Vec<CursorBitmap>,
    pub keys: Vec<(i64, Vec<String>)>,
}

#[derive(Default)]
struct Modifiers {
    lctrl: bool,
    rctrl: bool,
    lshift: bool,
    rshift: bool,
    lalt: bool,
    ralt: bool,
    lwin: bool,
    rwin: bool,
}

struct Ctx {
    track_pointer: bool,
    // The area's current place on screen, and its size when the recording started (the space every
    // position is given in).
    rect: (i32, i32, i32, i32),
    base: (i32, i32),
    window: Option<(Option<isize>, String, bool)>,
    moves: Vec<(i64, f32, f32)>,
    pending: Option<(i64, f32, f32)>,
    last_pushed: i64,
    clicks: Vec<(i64, f32, f32, u8)>,
    shapes: Vec<(i64, i32)>,
    current_shape: Option<i32>,
    cursors: Vec<CursorBitmap>,
    handle_ids: HashMap<isize, i32>,
    keys: Vec<(i64, Vec<String>)>,
    held: HashSet<u32>,
    mods: Modifiers,
}

thread_local! {
    // Hooks deliver to the installing thread only - see click_tracker.rs for why thread-local.
    static CTX: RefCell<Option<Ctx>> = const { RefCell::new(None) };
}

impl Ctx {
    fn to_area(&self, pt: POINT) -> (f32, f32) {
        let (x, y, w, h) = self.rect;
        let (bw, bh) = self.base;
        (((pt.x - x) as f64 / w.max(1) as f64 * bw as f64) as f32, ((pt.y - y) as f64 / h.max(1) as f64 * bh as f64) as f32)
    }

    fn push_move(&mut self, sample: (i64, f32, f32)) {
        if self.moves.last().is_some_and(|m| m.1 == sample.1 && m.2 == sample.2) {
            return;
        }
        self.moves.push(sample);
        self.last_pushed = sample.0;
    }

    fn flush_pending(&mut self) {
        if let Some(p) = self.pending.take() {
            self.push_move(p);
        }
    }

    fn on_move(&mut self, now: i64, pt: POINT) {
        let (x, y) = self.to_area(pt);
        if now - self.last_pushed >= PATH_RATE_HNS {
            self.pending = None;
            self.push_move((now, x, y));
        } else {
            self.pending = Some((now, x, y));
        }
    }

    fn on_click(&mut self, now: i64, pt: POINT, button: u8) {
        // The path is exactly at the click when it happens.
        self.flush_pending();
        let (x, y) = self.to_area(pt);
        self.push_move((now, x, y));
        self.clicks.push((now, x, y, button));
    }

    // Notes the pointer's look when it changes, capturing a new cursor's bitmap the first time.
    fn check_shape(&mut self, now: i64) {
        let mut info = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
        if unsafe { GetCursorInfo(&mut info) }.is_err() {
            return;
        }
        let id = if info.flags.0 & CURSOR_SHOWING.0 == 0 || info.hCursor.is_invalid() {
            -1
        } else {
            match self.handle_ids.get(&info.hCursor.0) {
                Some(&id) => id,
                None => {
                    let id = self.cursors.len() as i32;
                    match unsafe { cursor_bitmap(info.hCursor) } {
                        Some((hot_x, hot_y, png)) => {
                            self.cursors.push(CursorBitmap { id, hot_x, hot_y, png });
                            self.handle_ids.insert(info.hCursor.0, id);
                            id
                        }
                        // Unreadable (rare): shown as the cursor before it.
                        None => self.current_shape.unwrap_or(-1),
                    }
                }
            }
        };
        if self.current_shape != Some(id) {
            self.current_shape = Some(id);
            self.shapes.push((now, id));
        }
    }

    fn on_tick(&mut self, now: i64) {
        if let Some((hwnd, title, title_bar)) = &self.window {
            if let Ok(rect) = crate::commands::window_capture::win::get_window_rect(*hwnd, title, *title_bar) {
                self.rect = rect;
            }
        }
        if !self.track_pointer {
            return;
        }
        if self.pending.is_some_and(|p| now - p.0 >= PATH_RATE_HNS) {
            self.flush_pending();
        }
        if now - self.last_pushed >= KEEPALIVE_HNS {
            let mut pt = POINT::default();
            if unsafe { GetCursorPos(&mut pt) }.is_ok() {
                let (x, y) = self.to_area(pt);
                self.moves.push((now, x, y));
                self.last_pushed = now;
            }
        }
        self.check_shape(now);
    }

    fn on_key(&mut self, now: i64, msg: u32, vk: u32) {
        let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
        let m = &mut self.mods;
        let modifier = match vk {
            0xA2 => Some(&mut m.lctrl),
            0xA3 => Some(&mut m.rctrl),
            0xA0 => Some(&mut m.lshift),
            0xA1 => Some(&mut m.rshift),
            0xA4 => Some(&mut m.lalt),
            0xA5 => Some(&mut m.ralt),
            0x5B => Some(&mut m.lwin),
            0x5C => Some(&mut m.rwin),
            _ => None,
        };
        if let Some(flag) = modifier {
            if down || up {
                *flag = down;
            }
            return;
        }
        if up {
            self.held.remove(&vk);
            return;
        }
        // A held key repeats - one press is one chip.
        if !down || !self.held.insert(vk) {
            return;
        }
        if let Some(keys) = shortcut(&self.mods, vk) {
            self.keys.push((now, keys));
        }
    }
}

// The keys of a press worth showing, or None for typing. AltGr (right Alt) types characters on
// many layouts - nothing typed through it is kept either.
fn shortcut(m: &Modifiers, vk: u32) -> Option<Vec<String>> {
    if m.ralt {
        return None;
    }
    let ctrl = m.lctrl || m.rctrl;
    let alt = m.lalt;
    let win = m.lwin || m.rwin;
    let shift = m.lshift || m.rshift;
    let name = key_name(vk)?;
    let shown_alone = matches!(vk, 0x0D | 0x1B | 0x09) || (0x70..=0x87).contains(&vk);
    if !(ctrl || alt || win || shown_alone) {
        return None;
    }
    let mut keys: Vec<String> = Vec::new();
    for (on, label) in [(ctrl, "Ctrl"), (alt, "Alt"), (shift, "Shift"), (win, "Win")] {
        if on {
            keys.push(label.to_string());
        }
    }
    keys.push(name);
    if OWN_HOTKEYS.iter().any(|own| own.len() == keys.len() && own.iter().zip(&keys).all(|(a, b)| a == b)) {
        return None;
    }
    Some(keys)
}

fn key_name(vk: u32) -> Option<String> {
    let named = match vk {
        0x08 => "Backspace",
        0x09 => "Tab",
        0x0D => "Enter",
        0x1B => "Esc",
        0x20 => "Space",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0x23 => "End",
        0x24 => "Home",
        0x25 => "Left",
        0x26 => "Up",
        0x27 => "Right",
        0x28 => "Down",
        0x2C => "PrtSc",
        0x2D => "Insert",
        0x2E => "Delete",
        0x6A => "*",
        0x6B => "Plus",
        0x6D => "-",
        0x6E => ".",
        0x6F => "/",
        _ => "",
    };
    if !named.is_empty() {
        return Some(named.to_string());
    }
    match vk {
        0x30..=0x39 | 0x41..=0x5A => char::from_u32(vk).map(|c| c.to_string()),
        0x60..=0x69 => Some(format!("Num {}", vk - 0x60)),
        0x70..=0x87 => Some(format!("F{}", vk - 0x6F)),
        // Punctuation keys, named by what they type on this layout.
        0xBA..=0xC0 | 0xDB..=0xDF | 0xE2 => {
            let ch = unsafe { MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR) } & 0x7FFF;
            match char::from_u32(ch)?.to_uppercase().next()? {
                '+' => Some("Plus".to_string()),
                c if !c.is_control() => Some(c.to_string()),
                _ => None,
            }
        }
        _ => None,
    }
}

// One cursor's picture as an RGBA PNG and its hotspot. Drawn on black and on white: where the two
// agree the pixel is opaque, where they differ by d its alpha is 255 - d, and colour is recovered
// from the black one. A pixel that comes out brighter on black than on white inverts the screen
// (the classic I-beam) - drawn black, with a white outline around it.
unsafe fn cursor_bitmap(handle: HCURSOR) -> Option<(i32, i32, Vec<u8>)> {
    let mut info = ICONINFO::default();
    GetIconInfo(HICON(handle.0), &mut info).ok()?;
    let mut bm = BITMAP::default();
    let got = GetObjectW(HGDIOBJ(info.hbmMask.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut std::ffi::c_void));
    let has_color = !info.hbmColor.is_invalid();
    let (w, h) = (bm.bmWidth, if has_color { bm.bmHeight } else { bm.bmHeight / 2 });
    let _ = DeleteObject(info.hbmMask);
    if has_color {
        let _ = DeleteObject(info.hbmColor);
    }
    if got == 0 || !(1..=256).contains(&w) || !(1..=256).contains(&h) {
        return None;
    }
    let black = draw_cursor_on(handle, w, h, BLACKNESS)?;
    let white = draw_cursor_on(handle, w, h, WHITENESS)?;
    let (wu, hu) = (w as usize, h as usize);
    let mut rgba = vec![0u8; wu * hu * 4];
    let mut inverting = vec![false; wu * hu];
    for i in 0..wu * hu {
        // GetDIBits hands BGRA.
        let (b, wt) = (&black[i * 4..i * 4 + 3], &white[i * 4..i * 4 + 3]);
        let diff: i32 = (0..3).map(|c| wt[c] as i32 - b[c] as i32).sum::<i32>() / 3;
        if diff < -64 {
            inverting[i] = true;
            continue;
        }
        let alpha = (255 - diff).clamp(0, 255);
        if alpha == 0 {
            continue;
        }
        for (c, out) in [2usize, 1, 0].into_iter().enumerate() {
            rgba[i * 4 + c] = ((b[out] as i32 * 255 + alpha / 2) / alpha).clamp(0, 255) as u8;
        }
        rgba[i * 4 + 3] = alpha as u8;
    }
    for y in 0..hu {
        for x in 0..wu {
            let i = y * wu + x;
            if inverting[i] {
                rgba[i * 4..i * 4 + 4].copy_from_slice(&[0, 0, 0, 255]);
                continue;
            }
            if rgba[i * 4 + 3] >= 128 {
                continue;
            }
            let near = (y.saturating_sub(1)..(y + 2).min(hu)).any(|ny| (x.saturating_sub(1)..(x + 2).min(wu)).any(|nx| inverting[ny * wu + nx]));
            if near {
                rgba[i * 4..i * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
    }
    let image = image::RgbaImage::from_raw(w as u32, h as u32, rgba)?;
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(image).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some((info.xHotspot as i32, info.yHotspot as i32, png))
}

unsafe fn draw_cursor_on(handle: HCURSOR, w: i32, h: i32, background: ROP_CODE) -> Option<Vec<u8>> {
    let screen = GetDC(HWND(0));
    if screen.is_invalid() {
        return None;
    }
    let mem = CreateCompatibleDC(screen);
    let bitmap = CreateCompatibleBitmap(screen, w, h);
    let old = SelectObject(mem, bitmap);
    let _ = PatBlt(mem, 0, 0, w, h, background);
    let drawn = DrawIconEx(mem, 0, 0, HICON(handle.0), w, h, 0, HBRUSH::default(), DI_NORMAL).is_ok();
    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; (w * h * 4) as usize];
    let lines = GetDIBits(mem, bitmap, 0, h as u32, Some(pixels.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);
    SelectObject(mem, old);
    let _ = DeleteObject(bitmap);
    let _ = DeleteDC(mem);
    ReleaseDC(HWND(0), screen);
    (drawn && lines == h).then_some(pixels)
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let msg = wparam.0 as u32;
        CTX.with(|ctx| {
            if let Some(ctx) = ctx.borrow_mut().as_mut() {
                let now = now_hns();
                match msg {
                    WM_MOUSEMOVE => ctx.on_move(now, info.pt),
                    WM_LBUTTONDOWN => ctx.on_click(now, info.pt, 0),
                    WM_RBUTTONDOWN => ctx.on_click(now, info.pt, 1),
                    WM_MBUTTONDOWN => ctx.on_click(now, info.pt, 2),
                    _ => return,
                }
                ctx.check_shape(now);
            }
        });
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

unsafe extern "system" fn key_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let msg = wparam.0 as u32;
        CTX.with(|ctx| {
            if let Some(ctx) = ctx.borrow_mut().as_mut() {
                ctx.on_key(now_hns(), msg, info.vkCode);
            }
        });
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

pub struct InputCapture {
    thread_id: u32,
    handle: JoinHandle<Option<InputLog>>,
    pub started_hns: i64,
}

impl InputCapture {
    /// Starts recording on a dedicated thread with its own message loop (hooks need one).
    pub fn start(area: Area, track_pointer: bool, track_keys: bool) -> Result<Self, String> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, i64), String>>();
        let handle = std::thread::spawn(move || -> Option<InputLog> {
            let started = now_hns();
            let (rect, window) = match area {
                Area::Fixed { x, y, width, height } => ((x, y, width, height), None),
                Area::Window { hwnd, title, title_bar, x, y, width, height } => ((x, y, width, height), Some((hwnd, title, title_bar))),
            };
            CTX.with(|ctx| {
                *ctx.borrow_mut() = Some(Ctx {
                    track_pointer,
                    rect,
                    base: (rect.2.max(1), rect.3.max(1)),
                    window,
                    moves: Vec::new(),
                    pending: None,
                    last_pushed: i64::MIN / 2,
                    clicks: Vec::new(),
                    shapes: Vec::new(),
                    current_shape: None,
                    cursors: Vec::new(),
                    handle_ids: HashMap::new(),
                    keys: Vec::new(),
                    held: HashSet::new(),
                    mods: Modifiers::default(),
                })
            });
            let thread_id = unsafe { GetCurrentThreadId() };
            let mouse = if track_pointer { unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) }.ok() } else { None };
            let keyboard = if track_keys { unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_proc), None, 0) }.ok() } else { None };
            if (track_pointer && mouse.is_none()) || (track_keys && keyboard.is_none()) {
                for hook in [mouse, keyboard].into_iter().flatten() {
                    let _ = unsafe { UnhookWindowsHookEx(hook) };
                }
                let _ = ready_tx.send(Err("Failed to install the input hooks".to_string()));
                return None;
            }
            // Where the pointer starts and how it looks, before it first moves.
            CTX.with(|ctx| {
                if let Some(ctx) = ctx.borrow_mut().as_mut() {
                    ctx.on_tick(started);
                }
            });
            let timer = unsafe { SetTimer(HWND(0), 0, TICK_MS, None) };
            let _ = ready_tx.send(Ok((thread_id, started)));
            let mut msg = MSG::default();
            unsafe {
                while GetMessageW(&mut msg, HWND(0), 0, 0).as_bool() {
                    if msg.message == WM_TIMER {
                        CTX.with(|ctx| {
                            if let Some(ctx) = ctx.borrow_mut().as_mut() {
                                ctx.on_tick(now_hns());
                            }
                        });
                        continue;
                    }
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                if timer != 0 {
                    let _ = KillTimer(HWND(0), timer);
                }
                for hook in [mouse, keyboard].into_iter().flatten() {
                    let _ = UnhookWindowsHookEx(hook);
                }
            }
            CTX.with(|ctx| {
                ctx.borrow_mut().take().map(|mut c| {
                    c.flush_pending();
                    InputLog { width: c.base.0, height: c.base.1, moves: c.moves, clicks: c.clicks, shapes: c.shapes, cursors: c.cursors, keys: c.keys }
                })
            })
        });
        match ready_rx.recv() {
            Ok(Ok((thread_id, started_hns))) => Ok(Self { thread_id, handle, started_hns }),
            Ok(Err(e)) => {
                let _ = handle.join();
                Err(e)
            }
            Err(_) => {
                let _ = handle.join();
                Err("The input tracker stopped before it started".to_string())
            }
        }
    }

    /// Stops recording and returns everything recorded.
    pub fn stop(self) -> Option<InputLog> {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        self.handle.join().ok().flatten()
    }
}

impl InputLog {
    /// The "<name>.pointer.json" sidecar, every time placed on the final file by `to_output` (QPC
    /// instant -> seconds of the file, None when it fell in a cut stretch - before the first frame
    /// or in a pause; those are dropped, except that a look taken on during a pause still applies
    /// from the next movement after it).
    pub fn to_sidecar(&self, to_output: impl Fn(i64) -> Option<f64>) -> serde_json::Value {
        let round = |v: f64, k: f64| (v * k).round() / k;
        let moves: Vec<(f64, f32, f32)> = self.moves.iter().filter_map(|&(t, x, y)| Some((to_output(t)?, x, y))).collect();
        let flat: Vec<f64> = moves.iter().flat_map(|&(t, x, y)| [round(t, 1e4), round(x as f64, 10.0), round(y as f64, 10.0)]).collect();
        let clicks: Vec<serde_json::Value> = self
            .clicks
            .iter()
            .filter_map(|&(t, x, y, b)| Some(serde_json::json!([round(to_output(t)?, 1e4), round(x as f64, 10.0), round(y as f64, 10.0), b])))
            .collect();
        let mut shapes: Vec<serde_json::Value> = Vec::new();
        for &(t, id) in &self.shapes {
            let at = to_output(t).or_else(|| self.moves.iter().filter(|m| m.0 > t).find_map(|m| to_output(m.0)));
            if let Some(at) = at {
                shapes.push(serde_json::json!([round(at, 1e4), id]));
            }
        }
        let keys: Vec<serde_json::Value> = self.keys.iter().filter_map(|(t, k)| Some(serde_json::json!([round(to_output(*t)?, 1e4), k]))).collect();
        let cursors: Vec<serde_json::Value> = self
            .cursors
            .iter()
            .map(|c| serde_json::json!({ "id": c.id, "hotX": c.hot_x, "hotY": c.hot_y, "png": BASE64.encode(&c.png) }))
            .collect();
        serde_json::json!({
            "version": 1,
            "width": self.width,
            "height": self.height,
            "moves": flat,
            "clicks": clicks,
            "cursors": cursors,
            "shapes": shapes,
            "keys": keys,
        })
    }

    /// Left clicks in the shape of click_tracker's sidecar, for the editor's auto zoom on click.
    pub fn left_clicks(&self, to_output: impl Fn(i64) -> Option<f64>) -> Vec<crate::services::click_tracker::ClickEvent> {
        let (w, h) = (self.width.max(1) as f64, self.height.max(1) as f64);
        self.clicks
            .iter()
            .filter(|c| c.3 == 0)
            .filter_map(|&(t, x, y, _)| {
                let (fx, fy) = (x as f64 / w, y as f64 / h);
                ((0.0..1.0).contains(&fx) && (0.0..1.0).contains(&fy)).then_some(())?;
                Some(crate::services::click_tracker::ClickEvent { elapsed_secs: to_output(t)?, x_fraction: fx, y_fraction: fy })
            })
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.moves.is_empty() && self.clicks.is_empty() && self.keys.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mods(f: impl Fn(&mut Modifiers)) -> Modifiers {
        let mut m = Modifiers::default();
        f(&mut m);
        m
    }

    #[test]
    fn keeps_shortcuts_and_drops_typing() {
        let none = Modifiers::default();
        // Typing - with or without Shift - is never kept.
        assert_eq!(shortcut(&none, 0x41), None);
        assert_eq!(shortcut(&mods(|m| m.lshift = true), 0x41), None);
        assert_eq!(shortcut(&none, 0x31), None);
        assert_eq!(shortcut(&none, 0x20), None);
        assert_eq!(shortcut(&none, 0x08), None);
        // AltGr types characters (Ctrl+Alt on the wire) - not kept either.
        assert_eq!(shortcut(&mods(|m| { m.lctrl = true; m.ralt = true; }), 0x51), None);
        // Combos and named keys are.
        assert_eq!(shortcut(&mods(|m| m.lctrl = true), 0x43), Some(vec!["Ctrl".to_string(), "C".to_string()]));
        assert_eq!(shortcut(&mods(|m| { m.rctrl = true; m.lshift = true; }), 0x50), Some(vec!["Ctrl".to_string(), "Shift".to_string(), "P".to_string()]));
        assert_eq!(shortcut(&mods(|m| m.lwin = true), 0x44), Some(vec!["Win".to_string(), "D".to_string()]));
        assert_eq!(shortcut(&mods(|m| m.lalt = true), 0x09), Some(vec!["Alt".to_string(), "Tab".to_string()]));
        assert_eq!(shortcut(&none, 0x0D), Some(vec!["Enter".to_string()]));
        assert_eq!(shortcut(&mods(|m| m.lshift = true), 0x09), Some(vec!["Shift".to_string(), "Tab".to_string()]));
        assert_eq!(shortcut(&none, 0x74), Some(vec!["F5".to_string()]));
        // Briefcast's own stop-recording hotkey isn't part of the demo.
        assert_eq!(shortcut(&mods(|m| { m.lctrl = true; m.lshift = true; }), 0x52), None);
    }

    #[test]
    fn sidecar_places_events_on_the_final_file() {
        let log = InputLog {
            width: 100,
            height: 50,
            moves: vec![(10, 1.0, 2.0), (20, 3.0, 4.0), (30, 5.0, 6.0)],
            clicks: vec![(20, 3.0, 4.0, 0), (30, 5.0, 6.0, 1)],
            shapes: vec![(5, 0), (25, 1)],
            cursors: vec![],
            keys: vec![(30, vec!["Ctrl".into(), "S".into()])],
        };
        // 25 falls in a pause: the look it took on applies from the next movement (30).
        let to_output = |t: i64| (t != 25).then(|| t as f64 / 10.0);
        let json = log.to_sidecar(to_output);
        assert_eq!(json["moves"], serde_json::json!([1.0, 1.0, 2.0, 2.0, 3.0, 4.0, 3.0, 5.0, 6.0]));
        assert_eq!(json["shapes"], serde_json::json!([[0.5, 0], [3.0, 1]]));
        assert_eq!(json["keys"], serde_json::json!([[3.0, ["Ctrl", "S"]]]));
        let left = log.left_clicks(to_output);
        assert_eq!(left.len(), 1);
        assert!((left[0].x_fraction - 0.03).abs() < 1e-9 && (left[0].elapsed_secs - 2.0).abs() < 1e-9);
    }
}
