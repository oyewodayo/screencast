// services/click_tracker.rs
//
// Records where and when the user clicks during a screen recording, for the editor's own "auto
// zoom on click" feature (see removeSilentRanges' own sibling handler, applyAutoZoomAtClicks,
// videoEditHandlers.ts) - punching in on each click the way Camtasia/ScreenStudio-style tools do
// needs to know where those clicks landed, which nothing in this app tracked before this existed.
//
// Uses a Windows low-level mouse hook (WH_MOUSE_LL) rather than a third-party crate (e.g. `rdev`):
// this app already depends directly on the `windows` crate for every other piece of Win32 access
// (cursor position, window capture, WASAPI loopback) with the exact Win32 modules a mouse hook
// needs (Win32_UI_WindowsAndMessaging) already enabled in Cargo.toml, so no new dependency is
// actually needed here. Same "own dedicated OS thread for the duration of a recording" shape as
// loopback_audio.rs's WASAPI capture, for an analogous reason: a low-level hook only ever delivers
// events to the thread that installed it, and that thread must run its own Win32 message loop
// (GetMessage/DispatchMessage) the whole time - it can't share a thread with anything else, and
// can't be driven by Tokio/async.
use std::cell::RefCell;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Instant;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, HHOOK, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_QUIT,
};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickEvent {
    // Seconds since the hook was installed - installed as close to the ffmpeg spawn as practical
    // (see recording.rs's own start_recording), so this lines up with the recording's own elapsed
    // time closely enough for the editor's own zoom-window padding (a couple hundred ms either
    // side) to absorb the gap. Not frame-accurate by construction - nothing about a background
    // input hook and a separate ffmpeg process starting could make it so.
    pub elapsed_secs: f64,
    // Normalized 0..1 against the capture region's own pixel bounds (not the full virtual screen -
    // see ClickCapture::start's own `origin`/`size` params), same basis every overlay type's own
    // x/y already uses. Clicks outside the captured region are dropped entirely rather than
    // clamped, since the editor has no matching frame content to zoom into for those anyway.
    pub x_fraction: f64,
    pub y_fraction: f64,
}

struct HookContext {
    start: Instant,
    origin: (i32, i32),
    size: (i32, i32),
    events: Vec<ClickEvent>,
}

// A low-level hook's callback runs ON THE INSTALLING THREAD (Windows delivers it via that thread's
// own message queue), so thread-local storage is the natural, lock-free place to keep its state -
// no other thread ever touches this. Not Arc<Mutex<..>> shared state: only ClickCapture::start's
// own spawned thread ever reads or writes it, so a lock would just be uncontended overhead.
thread_local! {
    static HOOK_CTX: RefCell<Option<HookContext>> = RefCell::new(None);
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // A negative code means "pass through untouched, don't even look at it" per the WH_MOUSE_LL
    // contract - not just a style preference, MSDN documents this as required.
    if code >= 0 && wparam.0 as u32 == WM_LBUTTONDOWN {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        HOOK_CTX.with(|ctx| {
            if let Some(ctx) = ctx.borrow_mut().as_mut() {
                let (origin_x, origin_y) = ctx.origin;
                let (width, height) = ctx.size;
                if width > 0 && height > 0 {
                    let x = (info.pt.x - origin_x) as f64 / width as f64;
                    let y = (info.pt.y - origin_y) as f64 / height as f64;
                    if (0.0..1.0).contains(&x) && (0.0..1.0).contains(&y) {
                        ctx.events.push(ClickEvent { elapsed_secs: ctx.start.elapsed().as_secs_f64(), x_fraction: x, y_fraction: y });
                    }
                }
            }
        });
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

pub struct ClickCapture {
    // Windows can only ever unhook/wake a low-level hook's own message loop from the thread that
    // installed it (or by posting a thread message at it, which is what stop() below does) - this
    // is that thread's id, captured once at spawn via the channel below.
    thread_id: u32,
    handle: JoinHandle<Vec<ClickEvent>>,
}

impl ClickCapture {
    /// Installs the hook on a fresh dedicated thread and starts its message loop. `origin`/`size`
    /// are the capture region's own top-left and pixel dimensions in SCREEN coordinates (same
    /// space resolve_capture_target/gdigrab_input_args already resolve for the ffmpeg side) - every
    /// click gets normalized against these before being recorded.
    pub fn start(origin: (i32, i32), size: (i32, i32)) -> Result<Self, String> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();

        let handle = std::thread::spawn(move || -> Vec<ClickEvent> {
            HOOK_CTX.with(|ctx| {
                *ctx.borrow_mut() = Some(HookContext { start: Instant::now(), origin, size, events: Vec::new() });
            });

            let thread_id = unsafe { GetCurrentThreadId() };
            let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0) };
            let hook = match hook {
                Ok(h) => {
                    let _ = ready_tx.send(Ok(thread_id));
                    h
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("Failed to install mouse hook: {}", e)));
                    return Vec::new();
                }
            };

            // A low-level hook delivers nothing at all unless the installing thread keeps pumping
            // messages - GetMessageW blocks until one arrives, which for this thread is either a
            // hook callback's own internal dispatch or the WM_QUIT stop() posts below.
            let mut msg = MSG::default();
            unsafe {
                while GetMessageW(&mut msg, HWND(0), 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                let _ = UnhookWindowsHookEx(hook);
            }

            HOOK_CTX.with(|ctx| ctx.borrow_mut().take().map(|c| c.events).unwrap_or_default())
        });

        match ready_rx.recv() {
            Ok(Ok(thread_id)) => Ok(Self { thread_id, handle }),
            Ok(Err(e)) => {
                let _ = handle.join();
                Err(e)
            }
            Err(_) => {
                let _ = handle.join();
                Err("Click tracker thread exited before it could start".to_string())
            }
        }
    }

    /// Signals the hook thread to unhook and exit, then blocks until it does, returning every
    /// click recorded (in the capture region, in click order).
    pub fn stop(self) -> Vec<ClickEvent> {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        self.handle.join().unwrap_or_default()
    }
}
