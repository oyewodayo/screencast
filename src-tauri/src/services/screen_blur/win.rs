// The native side of the screen blur: region windows, the worker thread that owns them, and the
// auto-blur rules (whole window, WhatsApp, sensitive text). See mod.rs for the why of the design.
use super::layout::{average_rgb, detect_whatsapp, WhatsAppEdges};
use super::ocr::{self, ScreenHit};
use super::sensitive::TextRules;
use super::{BlurConfig, BlurRect, BlurRegion, Corner, GestureMode, WhatsAppParts, CHANGED_EVENT};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use windows::core::{w, Interface, HSTRING, PCWSTR, PWSTR};
use windows::Foundation::Numerics::Vector2;
use windows::System::DispatcherQueueController;
use windows::UI::Color;
use windows::UI::Composition::Desktop::DesktopWindowTarget;
use windows::UI::Composition::{CompositionBrush, CompositionColorBrush, CompositionEffectSourceParameter, Compositor, SpriteVisual};
use windows::UI::ViewManagement::{UIColorType, UISettings};
use windows::Win32::Foundation::{CloseHandle, BOOL, COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmFlush, DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DWMWINDOWATTRIBUTE};
use windows::Win32::Graphics::Gdi::{ClientToScreen, GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentProcessId, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::WinRT::Composition::ICompositorDesktopInterop;
use windows::Win32::System::WinRT::{CreateDispatcherQueueController, DispatcherQueueOptions, DQTAT_COM_STA, DQTYPE_THREAD_CURRENT};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumWindows, GetAncestor, GetClassNameW, GetCursorPos, GetForegroundWindow,
    GetMessageW, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
    KillTimer, PeekMessageW, PostThreadMessageW, RegisterClassW, SetLayeredWindowAttributes, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    TranslateMessage, GA_ROOT, GWLP_HWNDPARENT, GWL_EXSTYLE, GW_HWNDPREV, GW_OWNER, HMENU, HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, LWA_ALPHA,
    MSG, PM_REMOVE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WM_APP, WM_NCHITTEST, WM_QUIT, WM_TIMER,
    WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

const WM_WAKE: u32 = WM_APP + 1;
const CLASS_NAME: PCWSTR = w!("BriefcastScreenBlur");
const CLASS_NAME_STR: &str = "BriefcastScreenBlur";
// DWMWA_USE_HOSTBACKDROPBRUSH: lets the window's composition content sample the desktop behind it.
const DWMWA_USE_HOSTBACKDROPBRUSH: DWMWINDOWATTRIBUTE = DWMWINDOWATTRIBUTE(17);

// WinEvent ids (winuser.h) - plain u32s, which is what SetWinEventHook and the callback take.
const EVENT_SYSTEM_MINIMIZESTART: u32 = 0x0016;
const EVENT_SYSTEM_MINIMIZEEND: u32 = 0x0017;
const EVENT_OBJECT_DESTROY: u32 = 0x8001;
const EVENT_OBJECT_SHOW: u32 = 0x8002;
const EVENT_OBJECT_HIDE: u32 = 0x8003;
const EVENT_OBJECT_LOCATIONCHANGE: u32 = 0x800B;
const EVENT_OBJECT_CLOAKED: u32 = 0x8017;
const EVENT_OBJECT_UNCLOAKED: u32 = 0x8018;
const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;
const WINEVENT_SKIPOWNPROCESS: u32 = 0x0002;

// Housekeeping: scan for new WhatsApp windows every tick, re-read their layout every few (the
// divider can be dragged, or a chat opened, without the window itself changing).
const TICK_MS: u32 = 1000;
const REDETECT_EVERY_TICKS: u32 = 3;
const REDETECT_BACKGROUND_TICKS: u32 = 30;
// Overlay outline updates, at most this often.
const PUBLISH_EVERY: Duration = Duration::from_millis(100);
// A screen full of keys shouldn't become hundreds of windows.
const MAX_TEXT_REGIONS: usize = 64;

enum Cmd {
    // Physical screen rect. `overlay` is the annotation overlay's HWND - screen-pinned regions
    // are slotted just below it so its own handles stay drawn on top of the blur.
    Set { id: String, rect: RECT, overlay: isize },
    GestureBegin { id: String, mode: GestureMode, rect: RECT, pointer: POINT, overlay: isize },
    GestureEnd { id: String, rect: RECT, overlay: isize },
    Remove(String),
    Clear,
    Configure(BlurConfig),
    ToggleWindow,
    WhatsAppLayout { anchor: isize, edges: Option<WhatsAppEdges> },
    TextHits { anchor: isize, frame: RECT, hits: Vec<ScreenHit> },
    // Average colour under each region, sampled from its window's own pixels.
    Tones(Vec<(String, (u8, u8, u8))>),
}

#[derive(Clone, Copy, PartialEq)]
enum WaPart {
    List,
    Contact,
    Messages,
}

impl WaPart {
    const ALL: [WaPart; 3] = [WaPart::List, WaPart::Contact, WaPart::Messages];
    fn key(self) -> &'static str {
        match self {
            WaPart::List => "wa-list",
            WaPart::Contact => "wa-contact",
            WaPart::Messages => "wa-messages",
        }
    }
    fn label(self) -> &'static str {
        match self {
            WaPart::List => "WhatsApp chats",
            WaPart::Contact => "WhatsApp contact",
            WaPart::Messages => "WhatsApp messages",
        }
    }
    fn enabled(self, parts: &WhatsAppParts) -> bool {
        match self {
            WaPart::List => parts.chat_list,
            WaPart::Contact => parts.contact,
            WaPart::Messages => parts.messages,
        }
    }
}

enum AutoPart {
    // The whole window (Ctrl+Alt+B).
    Window,
    WhatsApp(WaPart),
    // Sensitive text; top-left relative to the window's frame.
    Text { offset: (i32, i32) },
}

enum Kind {
    Manual { offset: (i32, i32) },
    Auto(AutoPart),
}

// Where WhatsApp's panes are inside its frame, in physical px.
#[derive(Clone, Copy)]
struct WaLayout {
    rail: i32,
    title: i32,
    header: i32,
    divider: i32,
    // The divider as a share of the frame width too, so a resize can move it at once while a fresh
    // look is on its way.
    divider_frac: f64,
    contact_w: i32,
    frame: (i32, i32),
    // Whether the parts' frost colours have been sampled yet.
    toned: bool,
}

struct Region {
    id: String,
    hwnd: HWND,
    anchor: Option<HWND>,
    kind: Kind,
    label: Option<String>,
    rect: RECT,
    hidden: bool,
    // The frost's colour: what's under the region, averaged (or the system theme's background
    // until that's been sampled).
    base: (u8, u8, u8),
    // Composition objects kept alive for as long as the window: the target binds the visual
    // tree to the window; `root` carries the blur brush, `tint` the frost.
    _target: DesktopWindowTarget,
    root: SpriteVisual,
    tint: CompositionColorBrush,
}

struct Gesture {
    id: String,
    mode: GestureMode,
    start_rect: RECT,
    start_pointer: POINT,
    last_cursor: POINT,
    button_up_since: Option<Instant>,
}

#[derive(Clone, Copy, PartialEq)]
struct Config {
    strength: f64,
    auto_whatsapp: bool,
    wa_parts: WhatsAppParts,
    auto_text: bool,
}

struct State {
    _dq: DispatcherQueueController,
    compositor: Compositor,
    regions: Vec<Region>,
    config: Config,
    effects_on: bool,
    gesture: Option<Gesture>,
    timer: usize,
    // Throttles events to the overlay; `flush_timer` delivers the last one of a burst.
    last_publish: Instant,
    flush_timer: usize,
    ticks: u32,
    next_text_id: u64,
    wa: HashMap<isize, WaLayout>,
    // Auto regions the user removed: (window, rule) - they stay off until that window closes.
    dismissed: HashSet<(isize, &'static str)>,
    detecting: HashSet<isize>,
    whatsapp_pids: HashMap<u32, bool>,
    ocr_stop: Option<Arc<AtomicBool>>,
}

struct Worker {
    tx: Sender<Cmd>,
    thread_id: u32,
}

static WORKER: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static OVERLAY: AtomicIsize = AtomicIsize::new(0);
// Written by the worker after every change; read by `list` from any thread.
static SNAPSHOT: Mutex<Vec<Snapshot>> = Mutex::new(Vec::new());
// Read by the OCR thread on every pass.
static RULES: OnceLock<Arc<Mutex<TextRules>>> = OnceLock::new();

fn rules() -> &'static Arc<Mutex<TextRules>> {
    RULES.get_or_init(|| Arc::new(Mutex::new(TextRules::default())))
}

#[derive(Clone)]
struct Snapshot {
    id: String,
    rect: RECT,
    visible: bool,
    anchored: bool,
    label: Option<String>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    static RX: RefCell<Option<Receiver<Cmd>>> = const { RefCell::new(None) };
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> Option<R> {
    STATE.with(|s| s.borrow_mut().as_mut().map(f))
}

// ---- coordinate conversion (overlay CSS px <-> physical screen px) ----

fn overlay_frame(overlay: HWND) -> Result<(POINT, f64), String> {
    let mut origin = POINT::default();
    unsafe {
        if !ClientToScreen(overlay, &mut origin).as_bool() {
            return Err("Couldn't locate the annotation overlay".into());
        }
        let dpi = GetDpiForWindow(overlay);
        Ok((origin, if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 }))
    }
}

fn to_physical(overlay: HWND, r: &BlurRect) -> Result<RECT, String> {
    let (o, s) = overlay_frame(overlay)?;
    let left = o.x + (r.x * s).round() as i32;
    let top = o.y + (r.y * s).round() as i32;
    Ok(RECT { left, top, right: left + (r.width * s).round().max(1.0) as i32, bottom: top + (r.height * s).round().max(1.0) as i32 })
}

fn point_to_physical(overlay: HWND, x: f64, y: f64) -> Result<POINT, String> {
    let (o, s) = overlay_frame(overlay)?;
    Ok(POINT { x: o.x + (x * s).round() as i32, y: o.y + (y * s).round() as i32 })
}

fn to_css(origin: POINT, scale: f64, r: &RECT) -> BlurRect {
    BlurRect {
        x: (r.left - origin.x) as f64 / scale,
        y: (r.top - origin.y) as f64 / scale,
        width: (r.right - r.left) as f64 / scale,
        height: (r.bottom - r.top) as f64 / scale,
    }
}

// ---- public entry points (any thread) ----

fn send(app: Option<&AppHandle>, cmd: Cmd) -> Result<(), String> {
    if let Some(app) = app {
        let _ = APP.set(app.clone());
    }
    let cell = WORKER.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().map_err(|_| "Screen blur worker lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(spawn_worker()?);
    }
    let worker = guard.as_ref().expect("worker just spawned");
    worker.tx.send(cmd).map_err(|_| "Screen blur worker stopped".to_string())?;
    unsafe { PostThreadMessageW(worker.thread_id, WM_WAKE, WPARAM(0), LPARAM(0)) }.map_err(|e| format!("Couldn't reach the screen blur worker: {}", e))
}

pub fn set(app: &AppHandle, overlay: isize, id: String, rect: BlurRect) -> Result<(), String> {
    OVERLAY.store(overlay, Ordering::Relaxed);
    let rect = to_physical(HWND(overlay), &rect)?;
    send(Some(app), Cmd::Set { id, rect, overlay })
}

pub fn gesture_begin(app: &AppHandle, overlay: isize, id: String, mode: GestureMode, rect: BlurRect, pointer: (f64, f64)) -> Result<(), String> {
    OVERLAY.store(overlay, Ordering::Relaxed);
    let rect = to_physical(HWND(overlay), &rect)?;
    let pointer = point_to_physical(HWND(overlay), pointer.0, pointer.1)?;
    send(Some(app), Cmd::GestureBegin { id, mode, rect, pointer, overlay })
}

pub fn gesture_end(overlay: isize, id: String, rect: BlurRect) -> Result<(), String> {
    let rect = to_physical(HWND(overlay), &rect)?;
    send(None, Cmd::GestureEnd { id, rect, overlay })
}

pub fn remove(id: String) -> Result<(), String> {
    send(None, Cmd::Remove(id))
}

pub fn clear() -> Result<(), String> {
    send(None, Cmd::Clear)
}

pub fn configure(app: &AppHandle, config: BlurConfig) -> Result<(), String> {
    if let Some(r) = &config.text_rules {
        if let Ok(mut current) = rules().lock() {
            *current = r.clone();
        }
    }
    send(Some(app), Cmd::Configure(config))
}

pub fn toggle_window(app: &AppHandle) -> Result<(), String> {
    send(Some(app), Cmd::ToggleWindow)
}

pub fn list(overlay: isize) -> Result<Vec<BlurRegion>, String> {
    OVERLAY.store(overlay, Ordering::Relaxed);
    let snap = SNAPSHOT.lock().map_err(|_| "Screen blur snapshot lock poisoned".to_string())?.clone();
    let (origin, scale) = overlay_frame(HWND(overlay))?;
    Ok(snap.iter().map(|s| to_region(origin, scale, s)).collect())
}

fn to_region(origin: POINT, scale: f64, s: &Snapshot) -> BlurRegion {
    BlurRegion { id: s.id.clone(), rect: to_css(origin, scale, &s.rect), visible: s.visible, anchored: s.anchored, auto: s.label.is_some(), label: s.label.clone() }
}

// ---- worker thread ----

fn spawn_worker() -> Result<Worker, String> {
    let (tx, rx) = mpsc::channel::<Cmd>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    std::thread::Builder::new()
        .name("screen-blur".into())
        .spawn(move || unsafe {
            // The composition dispatcher runs on this thread's message loop (and makes it an STA).
            let dq = CreateDispatcherQueueController(DispatcherQueueOptions {
                dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
                threadType: DQTYPE_THREAD_CURRENT,
                apartmentType: DQTAT_COM_STA,
            });
            let compositor = dq.as_ref().ok().and_then(|_| Compositor::new().ok());
            let (Ok(dq), Some(compositor)) = (dq, compositor) else {
                let _ = ready_tx.send(Err("Windows composition isn't available".into()));
                return;
            };
            STATE.with(|s| {
                *s.borrow_mut() = Some(State {
                    _dq: dq,
                    compositor,
                    regions: Vec::new(),
                    config: Config {
                        strength: 50.0,
                        auto_whatsapp: false,
                        wa_parts: WhatsAppParts { chat_list: true, contact: true, messages: false },
                        auto_text: false,
                    },
                    effects_on: effects_enabled(),
                    gesture: None,
                    timer: 0,
                    last_publish: Instant::now(),
                    flush_timer: 0,
                    ticks: 0,
                    next_text_id: 0,
                    wa: HashMap::new(),
                    dismissed: HashSet::new(),
                    detecting: HashSet::new(),
                    whatsapp_pids: HashMap::new(),
                    ocr_stop: None,
                })
            });
            RX.with(|cell| *cell.borrow_mut() = Some(rx));
            register_class();
            // Out-of-context hooks deliver to this thread's message loop below. Skipping our own
            // process keeps our blur windows' own moves from echoing back.
            let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
            let _h1: HWINEVENTHOOK = SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, None, Some(win_event), 0, 0, flags);
            let _h2: HWINEVENTHOOK = SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_LOCATIONCHANGE, None, Some(win_event), 0, 0, flags);
            let _h3: HWINEVENTHOOK = SetWinEventHook(EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED, None, Some(win_event), 0, 0, flags);
            // The housekeeping tick: transparency-effects check and WhatsApp scan. A thread timer
            // (no window) arrives as a plain WM_TIMER in the loop.
            let timer = SetTimer(HWND::default(), 0, TICK_MS, None);
            with_state(|s| s.timer = timer);
            let _ = ready_tx.send(Ok(GetCurrentThreadId()));
            run_loop();
        })
        .map_err(|e| format!("Couldn't start the screen blur worker: {}", e))?;
    let thread_id = ready_rx.recv().map_err(|_| "Screen blur worker failed to start".to_string())??;
    Ok(Worker { tx, thread_id })
}

// Blocks on GetMessage while idle (zero CPU). During a drag it switches to a vsync-paced loop:
// drain messages, follow the cursor, wait for the next composition.
unsafe fn run_loop() {
    let mut msg = MSG::default();
    loop {
        let dragging = with_state(|s| s.gesture.is_some()).unwrap_or(false);
        if dragging {
            while PeekMessageW(&mut msg, HWND::default(), 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    return;
                }
                handle(&msg);
            }
            step_gesture();
            let _ = DwmFlush();
        } else {
            if !GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                return;
            }
            handle(&msg);
        }
    }
}

unsafe fn handle(msg: &MSG) {
    if msg.hwnd.0 == 0 && msg.message == WM_WAKE {
        drain_commands();
    } else if msg.hwnd.0 == 0 && msg.message == WM_TIMER {
        let flush = with_state(|s| s.flush_timer != 0 && msg.wParam.0 == s.flush_timer).unwrap_or(false);
        if flush {
            if let Some(id) = with_state(|s| std::mem::take(&mut s.flush_timer)) {
                let _ = KillTimer(HWND::default(), id);
            }
            emit_snapshot();
        } else {
            auto_tick();
        }
    } else {
        let _ = TranslateMessage(msg);
        DispatchMessageW(msg);
    }
}

unsafe fn drain_commands() {
    let cmds: Vec<Cmd> = RX.with(|cell| cell.borrow().as_ref().map(|rx| rx.try_iter().collect()).unwrap_or_default());
    if cmds.is_empty() {
        return;
    }
    for cmd in cmds {
        match cmd {
            Cmd::Set { id, rect, overlay } => set_manual(&id, rect, HWND(overlay)),
            Cmd::GestureBegin { id, mode, rect, pointer, overlay } => {
                // A new region starts screen-pinned under the overlay; it finds its window when
                // the drag ends.
                let exists = with_state(|s| s.regions.iter().any(|r| r.id == id)).unwrap_or(false);
                if !exists {
                    create_region(id.clone(), rect, None, Kind::Manual { offset: (0, 0) }, None, None, HWND(overlay));
                }
                with_state(|s| s.gesture = Some(Gesture { id, mode, start_rect: rect, start_pointer: pointer, last_cursor: pointer, button_up_since: None }));
            }
            Cmd::GestureEnd { id, rect, overlay } => {
                with_state(|s| {
                    if s.gesture.as_ref().is_some_and(|g| g.id == id) {
                        s.gesture = None;
                    }
                });
                set_manual(&id, rect, HWND(overlay));
            }
            Cmd::Remove(id) => remove_region(&id, true),
            Cmd::Clear => {
                let ids: Vec<String> = with_state(|s| s.regions.iter().map(|r| r.id.clone()).collect()).unwrap_or_default();
                for id in ids {
                    remove_region(&id, true);
                }
            }
            Cmd::Configure(config) => configure_worker(config),
            Cmd::ToggleWindow => toggle_window_worker(),
            Cmd::WhatsAppLayout { anchor, edges } => apply_wa_layout(HWND(anchor), edges),
            Cmd::TextHits { anchor, frame, hits } => apply_text_hits(HWND(anchor), frame, hits),
            Cmd::Tones(tones) => apply_tones(tones),
        }
    }
    publish();
}

// ---- regions ----

unsafe fn register_class() {
    let hinstance = GetModuleHandleW(None).map(|m| HINSTANCE(m.0)).unwrap_or_default();
    let wc = WNDCLASSW { lpfnWndProc: Some(wnd_proc), hInstance: hinstance, lpszClassName: CLASS_NAME, ..Default::default() };
    RegisterClassW(&wc);
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // Belt and braces with WS_EX_TRANSPARENT: never a hit-test target.
    if msg == WM_NCHITTEST {
        return LRESULT(-1); // HTTRANSPARENT
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn effects_enabled() -> bool {
    UISettings::new().and_then(|s| s.AdvancedEffectsEnabled()).unwrap_or(true)
}

// Frost over the blur, in the colour of what's underneath: denser with strength, and opaque when
// the backdrop can't be trusted (still in that colour, so it looks deliberate, not broken).
fn tint_color(strength: f64, effects_on: bool, base: (u8, u8, u8)) -> Color {
    let a = if effects_on { 0x40 as f64 + strength.clamp(0.0, 100.0) * 1.5 } else { 255.0 };
    Color { A: a.round() as u8, R: base.0, G: base.1, B: base.2 }
}

// Until a region's own colour is sampled: the system theme's window background.
fn theme_base() -> (u8, u8, u8) {
    UISettings::new()
        .and_then(|s| s.GetColorValue(UIColorType::Background))
        .map(|c| (c.R, c.G, c.B))
        .unwrap_or((0x22, 0x24, 0x28))
}

// The host backdrop is already a strong blur; strength stacks a real Gaussian on top of it.
fn blur_brush(compositor: &Compositor, strength: f64, effects_on: bool) -> windows::core::Result<CompositionBrush> {
    if !effects_on {
        return compositor.CreateColorBrushWithColor(Color { A: 255, R: 0x22, G: 0x24, B: 0x28 })?.cast();
    }
    let backdrop = compositor.CreateHostBackdropBrush()?;
    let extra = (strength.clamp(0.0, 100.0) * 0.36) as f32;
    if extra < 0.5 {
        return backdrop.cast();
    }
    let effect = composition_effects::gaussian_blur(extra, CompositionEffectSourceParameter::Create(&HSTRING::from("source"))?.cast()?);
    let brush = compositor.CreateEffectFactory(&effect)?.CreateBrush()?;
    brush.SetSourceParameter(&HSTRING::from("source"), &backdrop)?;
    brush.cast()
}

unsafe fn create_region(id: String, rect: RECT, anchor: Option<HWND>, kind: Kind, label: Option<String>, tone: Option<(u8, u8, u8)>, overlay: HWND) {
    let base = tone.unwrap_or_else(theme_base);
    let hinstance = GetModuleHandleW(None).map(|m| HINSTANCE(m.0)).unwrap_or_default();
    let hwnd = CreateWindowExW(
        WS_EX_NOREDIRECTIONBITMAP | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        CLASS_NAME,
        w!(""),
        WS_POPUP,
        rect.left,
        rect.top,
        (rect.right - rect.left).max(1),
        (rect.bottom - rect.top).max(1),
        HWND::default(),
        HMENU::default(),
        hinstance,
        None,
    );
    if hwnd.0 == 0 {
        log::warn!("Screen blur: CreateWindowExW failed");
        return;
    }
    let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
    let on = BOOL(1);
    let _ = DwmSetWindowAttribute(hwnd, DWMWA_USE_HOSTBACKDROPBRUSH, &on as *const BOOL as *const _, 4);

    let built = with_state(|s| -> windows::core::Result<(DesktopWindowTarget, SpriteVisual, CompositionColorBrush)> {
        let interop: ICompositorDesktopInterop = s.compositor.cast()?;
        let target = interop.CreateDesktopWindowTarget(hwnd, true)?;
        let root = s.compositor.CreateSpriteVisual()?;
        root.SetRelativeSizeAdjustment(Vector2 { X: 1.0, Y: 1.0 })?;
        root.SetBrush(&blur_brush(&s.compositor, s.config.strength, s.effects_on)?)?;
        let tint = s.compositor.CreateColorBrushWithColor(tint_color(s.config.strength, s.effects_on, base))?;
        let frost = s.compositor.CreateSpriteVisual()?;
        frost.SetRelativeSizeAdjustment(Vector2 { X: 1.0, Y: 1.0 })?;
        frost.SetBrush(&tint)?;
        root.Children()?.InsertAtTop(&frost)?;
        target.SetRoot(&root)?;
        Ok((target, root, tint))
    });
    let Some(Ok((target, root, tint))) = built else {
        log::warn!("Screen blur: couldn't build the composition visual");
        let _ = DestroyWindow(hwnd);
        return;
    };
    let anchor = attach(hwnd, anchor, overlay);
    let hidden = anchor.is_some_and(|a| IsIconic(a).as_bool() || !IsWindowVisible(a).as_bool());
    if !hidden {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    with_state(|s| s.regions.push(Region { id, hwnd, anchor, kind, label, rect, hidden, base, _target: target, root, tint }));
}

// Samples the colour under each region from `anchor`'s own pixels (PrintWindow - never our blur),
// off the worker thread since it's a cross-process call. Results arrive as Cmd::Tones.
unsafe fn probe_tones(anchor: HWND, regions: Vec<(String, RECT)>) {
    if regions.is_empty() {
        return;
    }
    let raw = anchor.0;
    std::thread::spawn(move || {
        let Some((left, top, img)) = crate::commands::window_capture::win::render_window(raw) else { return };
        let tones: Vec<(String, (u8, u8, u8))> = regions
            .into_iter()
            .filter_map(|(id, r)| average_rgb(&img, r.left - left, r.top - top, r.right - left, r.bottom - top).map(|t| (id, t)))
            .collect();
        if !tones.is_empty() {
            let _ = send(None, Cmd::Tones(tones));
        }
    });
}

// The regions of `anchor` (optionally only some kinds), as probe input.
fn regions_of(anchor: HWND, keep: impl Fn(&Kind) -> bool) -> Vec<(String, RECT)> {
    with_state(|s| s.regions.iter().filter(|r| r.anchor == Some(anchor) && keep(&r.kind)).map(|r| (r.id.clone(), r.rect)).collect()).unwrap_or_default()
}

fn apply_tones(tones: Vec<(String, (u8, u8, u8))>) {
    with_state(|s| {
        for (id, tone) in tones {
            if let Some(r) = s.regions.iter_mut().find(|r| r.id == id) {
                r.base = tone;
                let _ = r.tint.SetColor(tint_color(s.config.strength, s.effects_on, tone));
            }
        }
    });
}

// Makes `anchor` the window's owner (or none: topmost, just under the overlay) and slots it into
// z-order to match. Returns the anchor it actually got - a refused owner falls back to pinned.
unsafe fn attach(hwnd: HWND, anchor: Option<HWND>, overlay: HWND) -> Option<HWND> {
    SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, anchor.map(|a| a.0).unwrap_or(0));
    let owner = anchor.filter(|a| GetWindow(hwnd, GW_OWNER) == *a);
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
    match owner {
        Some(a) => {
            // Changing the owner doesn't move the window in z-order: put it directly above the
            // owner (SetWindowPos places a window *below* hWndInsertAfter). Inserting after a
            // topmost window would make it topmost, so that case goes to the top of the normal band.
            let _ = SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
            let above = GetWindow(a, GW_HWNDPREV);
            let topmost = (GetWindowLongW(above, GWL_EXSTYLE) as u32) & WS_EX_TOPMOST.0 != 0;
            let after = if above.0 == 0 || above == hwnd || topmost { HWND_TOP } else { above };
            let _ = SetWindowPos(hwnd, after, 0, 0, 0, 0, flags);
        }
        None => {
            let _ = SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
            if overlay.0 != 0 && IsWindow(overlay).as_bool() {
                let _ = SetWindowPos(hwnd, overlay, 0, 0, 0, 0, flags);
            }
        }
    }
    owner
}

unsafe fn move_window(hwnd: HWND, r: &RECT) {
    let _ = SetWindowPos(hwnd, HWND::default(), r.left, r.top, (r.right - r.left).max(1), (r.bottom - r.top).max(1), SWP_NOZORDER | SWP_NOACTIVATE);
}

// Final placement of a hand-drawn region: re-attached to whatever window is under its centre now.
unsafe fn set_manual(id: &str, rect: RECT, overlay: HWND) {
    let anchor = window_under(center(&rect));
    let anchor_rect = anchor.and_then(|a| window_rect(a));
    let offset = anchor_rect.map(|a| (rect.left - a.left, rect.top - a.top)).unwrap_or((0, 0));
    let existing = with_state(|s| s.regions.iter().find(|r| r.id == id).map(|r| (r.hwnd, r.anchor))).flatten();
    let actual = match existing {
        None => {
            create_region(id.to_string(), rect, anchor, Kind::Manual { offset }, None, None, overlay);
            anchor
        }
        Some((hwnd, current)) => {
            move_window(hwnd, &rect);
            let actual = if current == anchor { current } else { attach(hwnd, anchor, overlay) };
            with_state(|s| {
                if let Some(r) = s.regions.iter_mut().find(|r| r.id == id) {
                    r.rect = rect;
                    r.anchor = actual;
                    r.kind = Kind::Manual { offset };
                }
            });
            actual
        }
    };
    if let Some(a) = actual {
        probe_tones(a, vec![(id.to_string(), rect)]);
    }
}

// `by_user`: removed from the overlay - an auto rule then stays off for that window until it closes.
unsafe fn remove_region(id: &str, by_user: bool) {
    let removed = with_state(|s| {
        let i = s.regions.iter().position(|r| r.id == id)?;
        let r = s.regions.remove(i);
        if let (true, Some(a)) = (by_user, r.anchor) {
            match &r.kind {
                Kind::Auto(AutoPart::WhatsApp(p)) => {
                    s.dismissed.insert((a.0, p.key()));
                }
                Kind::Auto(AutoPart::Text { .. }) => {
                    s.dismissed.insert((a.0, "text"));
                }
                _ => {}
            }
        }
        if s.gesture.as_ref().is_some_and(|g| g.id == id) {
            s.gesture = None;
        }
        Some(r.hwnd)
    })
    .flatten();
    if let Some(hwnd) = removed {
        let _ = DestroyWindow(hwnd);
    }
    // Dismissing one sensitive-text blur means "stop blurring text in this window" - all of them.
    if by_user && id.starts_with("auto-text-") {
        let rest: Vec<String> = with_state(|s| {
            s.regions
                .iter()
                .filter(|r| matches!(r.kind, Kind::Auto(AutoPart::Text { .. })) && r.anchor.is_some_and(|a| s.dismissed.contains(&(a.0, "text"))))
                .map(|r| r.id.clone())
                .collect()
        })
        .unwrap_or_default();
        for id in rest {
            remove_region(&id, false);
        }
    }
}

unsafe fn step_gesture() {
    let mut cursor = POINT::default();
    if GetCursorPos(&mut cursor).is_err() {
        return;
    }
    let button_down = (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0;
    let update = with_state(|s| {
        let g = s.gesture.as_mut()?;
        // Safety net: if the overlay's end message never comes (it lost the pointer), stop
        // following shortly after the button is released.
        if !button_down {
            let since = *g.button_up_since.get_or_insert_with(Instant::now);
            if since.elapsed() > Duration::from_millis(400) {
                s.gesture = None;
                return None;
            }
        } else {
            g.button_up_since = None;
        }
        if cursor.x == g.last_cursor.x && cursor.y == g.last_cursor.y {
            return None;
        }
        g.last_cursor = cursor;
        let (o, p) = (g.start_rect, g.start_pointer);
        let rect = match g.mode {
            GestureMode::New => from_points(p, cursor),
            GestureMode::Move => {
                let (dx, dy) = (cursor.x - p.x, cursor.y - p.y);
                RECT { left: o.left + dx, top: o.top + dy, right: o.right + dx, bottom: o.bottom + dy }
            }
            GestureMode::Resize { corner } => {
                let fixed_x = if matches!(corner, Corner::Nw | Corner::Sw) { o.right } else { o.left };
                let fixed_y = if matches!(corner, Corner::Nw | Corner::Ne) { o.bottom } else { o.top };
                from_points(POINT { x: fixed_x, y: fixed_y }, cursor)
            }
        };
        let id = g.id.clone();
        let r = s.regions.iter_mut().find(|r| r.id == id)?;
        r.rect = rect;
        Some((r.hwnd, rect))
    })
    .flatten();
    if let Some((hwnd, rect)) = update {
        move_window(hwnd, &rect);
    }
}

fn from_points(a: POINT, b: POINT) -> RECT {
    RECT { left: a.x.min(b.x), top: a.y.min(b.y), right: a.x.max(b.x).max(a.x.min(b.x) + 1), bottom: a.y.max(b.y).max(a.y.min(b.y) + 1) }
}

fn center(r: &RECT) -> POINT {
    POINT { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }
}

fn frame_size(r: &RECT) -> (i32, i32) {
    (r.right - r.left, r.bottom - r.top)
}

unsafe fn window_rect(hwnd: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    GetWindowRect(hwnd, &mut r).ok().map(|_| r)
}

unsafe fn frame_rect(hwnd: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32).ok().map(|_| r)
}

unsafe fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4).is_ok() && cloaked != 0
}

unsafe fn class_of(hwnd: HWND) -> String {
    let mut class = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut class).max(0) as usize;
    String::from_utf16_lossy(&class[..n])
}

fn is_shell(class: &str) -> bool {
    matches!(class, "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}

fn scale_of(hwnd: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 }
}

// The topmost real app window under `pt`, or None for the desktop/taskbar - EnumWindows walks
// top-level windows front to back, so the first hit is the one you see there. Skips this
// process (the overlay, our own blur windows), click-through overlays, tool windows, and
// anything minimized, hidden or cloaked.
unsafe fn window_under(pt: POINT) -> Option<HWND> {
    struct Ctx {
        pt: POINT,
        pid: u32,
        hit: Option<HWND>,
    }
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == ctx.pid {
            return BOOL(1);
        }
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if ex & (WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0) != 0 || is_cloaked(hwnd) {
            return BOOL(1);
        }
        let Some(r) = frame_rect(hwnd) else { return BOOL(1) };
        if ctx.pt.x < r.left || ctx.pt.x >= r.right || ctx.pt.y < r.top || ctx.pt.y >= r.bottom {
            return BOOL(1);
        }
        ctx.hit = Some(hwnd);
        BOOL(0)
    }
    let mut ctx = Ctx { pt, pid: GetCurrentProcessId(), hit: None };
    let _ = EnumWindows(Some(each), LPARAM(&mut ctx as *mut Ctx as isize));
    let hit = ctx.hit?;
    if is_shell(&class_of(hit)) {
        return None;
    }
    Some(hit)
}

// ---- whole window (Ctrl+Alt+B) ----

// Blurs the active window, or unblurs it if it already is. The blur never takes focus, so the
// second press still finds the same window in front. When what's "in front" can't be the target -
// the annotation overlay in draw mode, one of our blurs - it's the app under the cursor instead; and
// on the desktop or taskbar, the whole screen under the cursor.
unsafe fn toggle_window_worker() {
    let fg = GetForegroundWindow();
    let usable = |h: HWND| {
        if h.0 == 0 || !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() || h.0 == OVERLAY.load(Ordering::Relaxed) {
            return false;
        }
        let class = class_of(h);
        class != CLASS_NAME_STR && !is_shell(&class)
    };
    let mut cursor = POINT::default();
    let _ = GetCursorPos(&mut cursor);
    // A whole-screen blur up on this monitor: this press is the one that lifts it.
    let screen_id = format!("auto-screen-{}", MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST).0);
    if with_state(|s| s.regions.iter().any(|r| r.id == screen_id)).unwrap_or(false) {
        remove_region(&screen_id, false);
        return;
    }
    let target = if usable(fg) { Some(fg) } else { window_under(cursor) };

    let Some(win) = target else {
        // The whole monitor under the cursor, pinned to the screen.
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return;
        }
        let id = format!("auto-screen-{}", monitor.0);
        if with_state(|s| s.regions.iter().any(|r| r.id == id)).unwrap_or(false) {
            remove_region(&id, false);
        } else {
            create_region(id, info.rcMonitor, None, Kind::Auto(AutoPart::Window), Some("Whole screen".into()), None, HWND(OVERLAY.load(Ordering::Relaxed)));
        }
        return;
    };
    let id = format!("auto-window-{}", win.0);
    if with_state(|s| s.regions.iter().any(|r| r.id == id)).unwrap_or(false) {
        remove_region(&id, false);
        return;
    }
    let Some(frame) = frame_rect(win) else { return };
    create_region(id.clone(), frame, Some(win), Kind::Auto(AutoPart::Window), Some("Whole window".into()), None, HWND::default());
    probe_tones(win, vec![(id, frame)]);
}

// ---- strength / config ----

unsafe fn configure_worker(config: BlurConfig) {
    let Some((old, new)) = with_state(|s| {
        let old = s.config;
        s.config = Config {
            strength: config.strength.unwrap_or(old.strength),
            auto_whatsapp: config.auto_whatsapp.unwrap_or(old.auto_whatsapp),
            wa_parts: config.whatsapp_parts.unwrap_or(old.wa_parts),
            auto_text: config.auto_text.unwrap_or(old.auto_text),
        };
        (old, s.config)
    }) else {
        return;
    };
    if (old.strength - new.strength).abs() > 0.01 {
        restyle_all();
    }
    if old.auto_whatsapp != new.auto_whatsapp || old.auto_text != new.auto_text {
        log::info!("Screen blur: WhatsApp rule {}, sensitive-text rule {}", if new.auto_whatsapp { "on" } else { "off" }, if new.auto_text { "on" } else { "off" });
    }

    if old.auto_whatsapp != new.auto_whatsapp || old.wa_parts != new.wa_parts {
        // Drop the parts no longer wanted; switching back on forgives earlier dismissals.
        let drop: Vec<String> = with_state(|s| {
            s.regions
                .iter()
                .filter(|r| matches!(r.kind, Kind::Auto(AutoPart::WhatsApp(p)) if !new.auto_whatsapp || !p.enabled(&new.wa_parts)))
                .map(|r| r.id.clone())
                .collect()
        })
        .unwrap_or_default();
        for id in drop {
            remove_region(&id, false);
        }
        if new.auto_whatsapp && !old.auto_whatsapp {
            with_state(|s| s.dismissed.retain(|(_, k)| !k.starts_with("wa-")));
        }
        if new.auto_whatsapp {
            auto_tick();
        }
    }

    if old.auto_text != new.auto_text {
        if new.auto_text {
            let stop = Arc::new(AtomicBool::new(false));
            with_state(|s| {
                s.dismissed.retain(|(_, k)| *k != "text");
                s.ocr_stop = Some(stop.clone());
            });
            ocr::start(
                rules().clone(),
                stop,
                Box::new(|anchor, frame, hits| {
                    let _ = send(None, Cmd::TextHits { anchor, frame, hits });
                }),
            );
        } else {
            with_state(|s| {
                if let Some(stop) = s.ocr_stop.take() {
                    stop.store(true, Ordering::Relaxed);
                }
            });
            let drop: Vec<String> =
                with_state(|s| s.regions.iter().filter(|r| matches!(r.kind, Kind::Auto(AutoPart::Text { .. }))).map(|r| r.id.clone()).collect()).unwrap_or_default();
            for id in drop {
                remove_region(&id, false);
            }
        }
    }
}

fn restyle_all() {
    with_state(|s| {
        for r in &s.regions {
            if let Ok(brush) = blur_brush(&s.compositor, s.config.strength, s.effects_on) {
                let _ = r.root.SetBrush(&brush);
            }
            let _ = r.tint.SetColor(tint_color(s.config.strength, s.effects_on, r.base));
        }
    });
}

// ---- auto-blur: WhatsApp ----

unsafe fn auto_tick() {
    // Transparency effects can be switched off at any time (or by battery saver) - re-check, and
    // switch every region to solid frost if the backdrop can no longer be trusted.
    let effects = effects_enabled();
    if with_state(|s| std::mem::replace(&mut s.effects_on, effects) != effects).unwrap_or(false) {
        restyle_all();
        publish();
    }
    let Some(true) = with_state(|s| s.config.auto_whatsapp) else { return };
    let ticks = with_state(|s| {
        s.ticks = s.ticks.wrapping_add(1);
        s.ticks
    })
    .unwrap_or(0);
    let mut changed = false;
    let fg = GetForegroundWindow();
    for hwnd in whatsapp_windows() {
        let (created, known) = ensure_whatsapp(hwnd);
        changed |= created;
        // Re-reading the layout makes WhatsApp render a copy of itself (PrintWindow, ~100ms at 4K):
        // often while you're using it, rarely while it sits in the background.
        let due = if hwnd == fg { ticks % REDETECT_EVERY_TICKS == 0 } else { ticks % REDETECT_BACKGROUND_TICKS == 0 };
        if created && !known || due {
            request_detection(hwnd);
        }
    }
    if changed {
        publish();
    }
}

fn wa_default(frame: &RECT, scale: f64) -> WaLayout {
    let size = frame_size(frame);
    let title = (32.0 * scale).round() as i32;
    WaLayout {
        rail: 0,
        title,
        header: title + (64.0 * scale).round() as i32,
        divider: (size.0 as f64 * 0.45) as i32,
        divider_frac: 0.45,
        contact_w: (420.0 * scale).round() as i32,
        frame: size,
        toned: false,
    }
}

fn wa_rect(part: WaPart, f: &RECT, l: &WaLayout) -> RECT {
    let r = match part {
        WaPart::List => RECT { left: f.left + l.rail, top: f.top + l.title, right: f.left + l.divider, bottom: f.bottom },
        WaPart::Contact => RECT { left: f.left + l.divider, top: f.top + l.title, right: (f.left + l.divider + l.contact_w).min(f.right), bottom: f.top + l.header },
        WaPart::Messages => RECT { left: f.left + l.divider, top: f.top + l.header, right: f.right, bottom: f.bottom },
    };
    RECT { right: r.right.max(r.left + 1), bottom: r.bottom.max(r.top + 1), ..r }
}

// Adds whichever enabled parts the window doesn't have yet. Returns (any created, layout known
// before) - a window seen for the first time gets a generous default at once (privacy first: names
// shouldn't be readable while detection runs), then tightens to the real panes.
unsafe fn ensure_whatsapp(hwnd: HWND) -> (bool, bool) {
    let Some(frame) = frame_rect(hwnd) else { return (false, false) };
    let scale = scale_of(hwnd);
    let Some((layout, known, todo)) = with_state(|s| {
        let known = s.wa.contains_key(&hwnd.0);
        let layout = *s.wa.entry(hwnd.0).or_insert_with(|| wa_default(&frame, scale));
        let todo: Vec<WaPart> = WaPart::ALL
            .into_iter()
            .filter(|p| p.enabled(&s.config.wa_parts))
            .filter(|p| !s.dismissed.contains(&(hwnd.0, p.key())))
            .filter(|p| !s.regions.iter().any(|r| r.anchor == Some(hwnd) && matches!(r.kind, Kind::Auto(AutoPart::WhatsApp(q)) if q == *p)))
            .collect();
        (layout, known, todo)
    }) else {
        return (false, false);
    };
    for part in &todo {
        create_region(
            format!("auto-{}-{}", part.key(), hwnd.0),
            wa_rect(*part, &frame, &layout),
            Some(hwnd),
            Kind::Auto(AutoPart::WhatsApp(*part)),
            Some(part.label().into()),
            None,
            HWND::default(),
        );
    }
    (!todo.is_empty(), known)
}

// Visible, restored WhatsApp main windows ("WhatsApp..." titled windows of WhatsApp.exe - the
// classic desktop app - or WhatsApp.Root.exe, the current one).
unsafe fn whatsapp_windows() -> Vec<HWND> {
    struct Ctx {
        out: Vec<HWND>,
        pids: HashMap<u32, bool>,
    }
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || is_cloaked(hwnd) {
            return BOOL(1);
        }
        let mut title = [0u16; 32];
        let n = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        if !String::from_utf16_lossy(&title[..n]).starts_with("WhatsApp") {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let is_wa = *ctx.pids.entry(pid).or_insert_with(|| is_whatsapp_process(pid));
        if is_wa && frame_rect(hwnd).is_some_and(|r| r.right - r.left >= 400 && r.bottom - r.top >= 300) {
            ctx.out.push(hwnd);
        }
        BOOL(1)
    }
    let pids = with_state(|s| std::mem::take(&mut s.whatsapp_pids)).unwrap_or_default();
    let mut ctx = Ctx { out: Vec::new(), pids };
    let _ = EnumWindows(Some(each), LPARAM(&mut ctx as *mut Ctx as isize));
    let Ctx { out, mut pids } = ctx;
    // A cache of pid -> verdict, bounded so recycled pids can't make it grow forever.
    if pids.len() > 256 {
        pids.clear();
    }
    with_state(|s| s.whatsapp_pids = pids);
    out
}

unsafe fn is_whatsapp_process(pid: u32) -> bool {
    let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
    let _ = CloseHandle(process);
    if !ok {
        return false;
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
    let exe = path.rsplit(['\\', '/']).next().unwrap_or("");
    exe == "whatsapp.exe" || exe == "whatsapp.root.exe"
}

// PrintWindow + analysis on a short-lived thread: PrintWindow is a cross-process call into
// WhatsApp's UI thread, and must never stall the worker (or a drag in progress).
unsafe fn request_detection(hwnd: HWND) {
    if !with_state(|s| s.detecting.insert(hwnd.0)).unwrap_or(false) {
        return;
    }
    let raw = hwnd.0;
    let scale = scale_of(hwnd);
    std::thread::spawn(move || {
        let edges = crate::commands::window_capture::win::render_window(raw).and_then(|(_, _, img)| detect_whatsapp(&img, scale));
        let _ = send(None, Cmd::WhatsAppLayout { anchor: raw, edges });
    });
}

unsafe fn apply_wa_layout(anchor: HWND, edges: Option<WhatsAppEdges>) {
    with_state(|s| s.detecting.remove(&anchor.0));
    // Nothing confident (mid-animation, an unusual theme): keep the current, generous layout.
    let (Some(e), Some(frame)) = (edges, frame_rect(anchor)) else { return };
    let moves: Vec<(HWND, RECT)> = with_state(|s| {
        let Some(l) = s.wa.get_mut(&anchor.0) else { return Vec::new() };
        let size = frame_size(&frame);
        l.rail = e.chat.rail.map(|r| r as i32 + 1).unwrap_or(0);
        l.divider = e.chat.divider as i32;
        l.divider_frac = e.chat.divider as f64 / size.0.max(1) as f64;
        if let Some(t) = e.title_bottom {
            l.title = t as i32;
        }
        if let Some(h) = e.header_bottom {
            l.header = h as i32;
        }
        if let Some(c) = e.contact_right {
            l.contact_w = c as i32 - l.divider;
        }
        l.frame = size;
        let l = *l;
        let mut moves = Vec::new();
        for r in s.regions.iter_mut().filter(|r| r.anchor == Some(anchor)) {
            if let Kind::Auto(AutoPart::WhatsApp(p)) = r.kind {
                let next = wa_rect(p, &frame, &l);
                if next != r.rect {
                    r.rect = next;
                    moves.push((r.hwnd, next));
                }
            }
        }
        moves
    })
    .unwrap_or_default();
    // Re-tint to what's under each part when the layout changed (a chat opened or closed) - not on
    // every unchanged re-check, which would be a second capture for nothing.
    let relaid = !moves.is_empty();
    for (w, r) in moves {
        move_window(w, &r);
    }
    let first = with_state(|s| s.wa.get_mut(&anchor.0).map(|l| !std::mem::replace(&mut l.toned, true))).flatten().unwrap_or(false);
    if relaid || first {
        probe_tones(anchor, regions_of(anchor, |k| matches!(k, Kind::Auto(AutoPart::WhatsApp(_)))));
    }
}

// ---- auto-blur: sensitive text ----

// Merges findings that substantially overlap (a key split across OCR words; a cover over a blur)
// into one blur. Merely touching isn't enough: neighbouring lines' padded blurs touch, and chaining
// those fused a whole page into one block.
fn merge(mut hits: Vec<ScreenHit>) -> Vec<ScreenHit> {
    let area = |r: &RECT| ((r.right - r.left).max(0) as i64) * ((r.bottom - r.top).max(0) as i64);
    let overlap = |a: &RECT, b: &RECT| {
        let w = (a.right.min(b.right) - a.left.max(b.left)).max(0) as i64;
        let h = (a.bottom.min(b.bottom) - a.top.max(b.top)).max(0) as i64;
        w * h
    };
    let mut out: Vec<ScreenHit> = Vec::new();
    hits.sort_by_key(|h| (h.rect.top, h.rect.left));
    for h in hits {
        let r = h.rect;
        if let Some(o) = out.iter_mut().find(|o| overlap(&o.rect, &r) * 2 >= area(&o.rect).min(area(&r))) {
            o.rect = RECT { left: o.rect.left.min(r.left), top: o.rect.top.min(r.top), right: o.rect.right.max(r.right), bottom: o.rect.bottom.max(r.bottom) };
        } else {
            out.push(h);
        }
    }
    out
}

// Replaces the window's text blurs with the latest findings - existing blur windows are moved
// rather than recreated, so a rescan never flickers.
unsafe fn apply_text_hits(anchor: HWND, scan_frame: RECT, hits: Vec<ScreenHit>) {
    let allowed = with_state(|s| s.config.auto_text && !s.dismissed.contains(&(anchor.0, "text"))).unwrap_or(false);
    if !allowed || !IsWindow(anchor).as_bool() {
        return;
    }
    // Findings are relative to where the window was when captured; place them where it is now.
    let frame = frame_rect(anchor).unwrap_or(scan_frame);
    let (dx, dy) = (frame.left - scan_frame.left, frame.top - scan_frame.top);
    let wanted: Vec<(RECT, &'static str, Option<(u8, u8, u8)>)> = merge(hits)
        .into_iter()
        .take(MAX_TEXT_REGIONS)
        .map(|h| (RECT { left: h.rect.left + dx, top: h.rect.top + dy, right: h.rect.right + dx, bottom: h.rect.bottom + dy }, h.label, h.tone))
        .collect();
    let existing: Vec<String> = with_state(|s| {
        s.regions.iter().filter(|r| r.anchor == Some(anchor) && matches!(r.kind, Kind::Auto(AutoPart::Text { .. }))).map(|r| r.id.clone()).collect()
    })
    .unwrap_or_default();

    for (i, (rect, label, tone)) in wanted.iter().enumerate() {
        let offset = (rect.left - frame.left, rect.top - frame.top);
        if let Some(id) = existing.get(i) {
            let hwnd = with_state(|s| {
                let (strength, effects_on) = (s.config.strength, s.effects_on);
                let r = s.regions.iter_mut().find(|r| &r.id == id)?;
                r.rect = *rect;
                r.kind = Kind::Auto(AutoPart::Text { offset });
                r.label = Some((*label).into());
                if let Some(t) = tone {
                    r.base = *t;
                    let _ = r.tint.SetColor(tint_color(strength, effects_on, *t));
                }
                Some(r.hwnd)
            })
            .flatten();
            if let Some(h) = hwnd {
                move_window(h, rect);
            }
        } else {
            let id = with_state(|s| {
                s.next_text_id += 1;
                format!("auto-text-{}-{}", anchor.0, s.next_text_id)
            })
            .unwrap_or_default();
            create_region(id, *rect, Some(anchor), Kind::Auto(AutoPart::Text { offset }), Some((*label).into()), *tone, HWND::default());
        }
    }
    for id in existing.iter().skip(wanted.len()) {
        remove_region(id, false);
    }
}

// ---- following the anchor window ----

unsafe extern "system" fn win_event(_hook: HWINEVENTHOOK, event: u32, hwnd: HWND, id_object: i32, id_child: i32, _thread: u32, _time: u32) {
    // OBJID_WINDOW / CHILDID_SELF: the window itself, not a caret, scrollbar or child control.
    if id_object != 0 || id_child != 0 || hwnd.0 == 0 {
        return;
    }
    // A WhatsApp window appearing (or coming back from the tray) is picked up at once rather
    // than on the next tick.
    if event == EVENT_OBJECT_SHOW
        && with_state(|s| s.config.auto_whatsapp && !s.regions.iter().any(|r| r.anchor == Some(hwnd))).unwrap_or(false)
        && GetAncestor(hwnd, GA_ROOT) == hwnd
    {
        auto_tick();
    }
    let mut detect = false;
    let mut changed = false;
    let moves: Vec<(HWND, RECT)> = with_state(|s| {
        let mut moves = Vec::new();
        if !s.regions.iter().any(|r| r.anchor == Some(hwnd)) {
            return moves;
        }
        match event {
            EVENT_OBJECT_DESTROY => {
                s.regions.retain(|r| {
                    if r.anchor == Some(hwnd) {
                        let _ = DestroyWindow(r.hwnd);
                        false
                    } else {
                        true
                    }
                });
                s.wa.remove(&hwnd.0);
                s.dismissed.retain(|(h, _)| *h != hwnd.0);
                changed = true;
            }
            EVENT_OBJECT_LOCATIONCHANGE => {
                let (Some(a), Some(frame)) = (window_rect(hwnd), frame_rect(hwnd)) else { return moves };
                // WhatsApp resized: move the divider proportionally now, confirm with a fresh look.
                if let Some(l) = s.wa.get_mut(&hwnd.0) {
                    let size = frame_size(&frame);
                    if size != l.frame {
                        l.divider = (size.0 as f64 * l.divider_frac).round() as i32;
                        l.frame = size;
                        detect = true;
                    }
                }
                let wa = s.wa.get(&hwnd.0).copied();
                let in_gesture = s.gesture.as_ref().map(|g| g.id.clone());
                for r in s.regions.iter_mut().filter(|r| r.anchor == Some(hwnd)) {
                    if in_gesture.as_deref() == Some(r.id.as_str()) {
                        continue;
                    }
                    let (w, h) = (r.rect.right - r.rect.left, r.rect.bottom - r.rect.top);
                    let next = match &r.kind {
                        Kind::Manual { offset } => {
                            let (left, top) = (a.left + offset.0, a.top + offset.1);
                            RECT { left, top, right: left + w, bottom: top + h }
                        }
                        Kind::Auto(AutoPart::Window) => frame,
                        Kind::Auto(AutoPart::WhatsApp(p)) => wa.map(|l| wa_rect(*p, &frame, &l)).unwrap_or(r.rect),
                        Kind::Auto(AutoPart::Text { offset }) => {
                            let (left, top) = (frame.left + offset.0, frame.top + offset.1);
                            RECT { left, top, right: left + w, bottom: top + h }
                        }
                    };
                    if next != r.rect {
                        r.rect = next;
                        moves.push((r.hwnd, next));
                    }
                }
                changed = !moves.is_empty();
            }
            EVENT_SYSTEM_MINIMIZESTART | EVENT_OBJECT_HIDE | EVENT_OBJECT_CLOAKED => {
                for r in s.regions.iter_mut().filter(|r| r.anchor == Some(hwnd)) {
                    r.hidden = true;
                    let _ = ShowWindow(r.hwnd, SW_HIDE);
                }
                changed = true;
            }
            EVENT_SYSTEM_MINIMIZEEND | EVENT_OBJECT_SHOW | EVENT_OBJECT_UNCLOAKED => {
                if IsIconic(hwnd).as_bool() || !IsWindowVisible(hwnd).as_bool() {
                    return moves;
                }
                for r in s.regions.iter_mut().filter(|r| r.anchor == Some(hwnd)) {
                    r.hidden = false;
                    let _ = ShowWindow(r.hwnd, SW_SHOWNOACTIVATE);
                }
                changed = true;
                detect = s.wa.contains_key(&hwnd.0);
            }
            _ => {}
        }
        moves
    })
    .unwrap_or_default();
    for (w, r) in &moves {
        move_window(*w, r);
    }
    if detect && with_state(|s| s.config.auto_whatsapp && s.wa.contains_key(&hwnd.0)).unwrap_or(false) {
        request_detection(hwnd);
    }
    if changed {
        publish();
    }
}

// Refreshes the shared snapshot and tells the overlay (which draws handles for the regions in
// draw mode) where everything is now - at most every PUBLISH_EVERY: while a window scrolls, blurs
// move up to 60 times a second, and only the overlay's outlines need to hear about it.
fn publish() {
    let snap: Option<Vec<Snapshot>> = with_state(|s| {
        s.regions
            .iter()
            .map(|r| Snapshot { id: r.id.clone(), rect: r.rect, visible: !r.hidden, anchored: r.anchor.is_some(), label: r.label.clone() })
            .collect()
    });
    let Some(snap) = snap else { return };
    if let Ok(mut s) = SNAPSHOT.lock() {
        *s = snap;
    }
    let due = with_state(|s| {
        if s.last_publish.elapsed() >= PUBLISH_EVERY {
            return true;
        }
        if s.flush_timer == 0 {
            s.flush_timer = unsafe { SetTimer(HWND::default(), 0, PUBLISH_EVERY.as_millis() as u32, None) };
        }
        false
    })
    .unwrap_or(false);
    if due {
        emit_snapshot();
    }
}

fn emit_snapshot() {
    with_state(|s| s.last_publish = Instant::now());
    let Some(snap) = SNAPSHOT.lock().ok().map(|s| s.clone()) else { return };
    let (Some(app), overlay) = (APP.get(), OVERLAY.load(Ordering::Relaxed)) else { return };
    if overlay == 0 {
        return;
    }
    let Ok((origin, scale)) = overlay_frame(HWND(overlay)) else { return };
    let regions: Vec<BlurRegion> = snap.iter().map(|s| to_region(origin, scale, s)).collect();
    let _ = app.emit_to("annotation-overlay", CHANGED_EVENT, regions);
}
