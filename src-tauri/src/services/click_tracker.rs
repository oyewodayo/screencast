// services/click_tracker.rs
//
// Records where and when the user clicks during a screen recording, for the editor's own "auto
// zoom on click" feature (see removeSilentRanges' own sibling handler, applyAutoZoomAtClicks,
// videoEditHandlers.ts) - punching in on each click the way Camtasia/ScreenStudio-style tools do
// needs to know where those clicks landed, which nothing in this app tracked before this existed.

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

#[cfg(target_os = "windows")]
use crate::services::audio_capture::now_hns;

#[cfg(not(target_os = "windows"))]
pub(crate) fn now_hns() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.as_nanos() / 100) as i64)
        .unwrap_or(0)
}

#[cfg(target_os = "windows")]
pub use win::*;

#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub use fallback::*;

#[cfg(target_os = "windows")]
mod win {
    use super::{now_hns, ClickEvent};
    use std::cell::RefCell;
    use std::sync::mpsc;
    use std::thread::JoinHandle;
    use std::time::Instant;

    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, HHOOK, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN,
        WM_QUIT,
    };

    struct HookContext {
        start: Instant,
        origin: (i32, i32),
        size: (i32, i32),
        events: Vec<ClickEvent>,
    }

    thread_local! {
        static HOOK_CTX: RefCell<Option<HookContext>> = RefCell::new(None);
    }

    unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
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
                            ctx.events.push(ClickEvent {
                                elapsed_secs: ctx.start.elapsed().as_secs_f64(),
                                x_fraction: x,
                                y_fraction: y,
                            });
                        }
                    }
                }
            });
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    pub struct ClickCapture {
        thread_id: u32,
        handle: JoinHandle<Vec<ClickEvent>>,
        pub started_hns: i64,
    }

    impl ClickCapture {
        pub fn start(origin: (i32, i32), size: (i32, i32)) -> Result<Self, String> {
            let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, i64), String>>();

            let handle = std::thread::spawn(move || -> Vec<ClickEvent> {
                let started_hns = now_hns();
                HOOK_CTX.with(|ctx| {
                    *ctx.borrow_mut() = Some(HookContext {
                        start: Instant::now(),
                        origin,
                        size,
                        events: Vec::new(),
                    });
                });

                let thread_id = unsafe { GetCurrentThreadId() };
                let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0) };
                let hook = match hook {
                    Ok(h) => {
                        let _ = ready_tx.send(Ok((thread_id, started_hns)));
                        h
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("Failed to install mouse hook: {}", e)));
                        return Vec::new();
                    }
                };

                let mut msg = MSG::default();
                unsafe {
                    while GetMessageW(&mut msg, HWND(0), 0, 0).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    let _ = UnhookWindowsHookEx(hook);
                }

                HOOK_CTX.with(|ctx| {
                    ctx.borrow_mut()
                        .take()
                        .map(|c| c.events)
                        .unwrap_or_default()
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
                    Err("Click tracker thread exited before it could start".to_string())
                }
            }
        }

        pub fn stop(self) -> Vec<ClickEvent> {
            unsafe {
                let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
            self.handle.join().unwrap_or_default()
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{now_hns, ClickEvent};
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::JoinHandle;
    use std::time::Instant;

    type CGFloat = f64;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: CGFloat,
        y: CGFloat,
    }

    type CGEventRef = *mut c_void;
    type CGEventSourceRef = *mut c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: CGEventSourceRef) -> CGEventRef;
        fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
        fn CFRelease(cf: *mut c_void);
    }

    pub struct ClickCapture {
        running: Arc<AtomicBool>,
        handle: JoinHandle<Vec<ClickEvent>>,
        pub started_hns: i64,
    }

    impl ClickCapture {
        pub fn start(origin: (i32, i32), size: (i32, i32)) -> Result<Self, String> {
            let started_hns = now_hns();
            let running = Arc::new(AtomicBool::new(true));
            let r = running.clone();

            let handle = std::thread::spawn(move || {
                let start = Instant::now();
                let mut events = Vec::new();
                let mut was_down = false;

                while r.load(Ordering::Relaxed) {
                    let is_down = unsafe { CGEventSourceButtonState(0, 0) };
                    if is_down && !was_down {
                        unsafe {
                            let event = CGEventCreate(std::ptr::null_mut());
                            if !event.is_null() {
                                let loc = CGEventGetLocation(event);
                                CFRelease(event);
                                let (ox, oy) = origin;
                                let (w, h) = size;
                                if w > 0 && h > 0 {
                                    let x = (loc.x - ox as f64) / w as f64;
                                    let y = (loc.y - oy as f64) / h as f64;
                                    if (0.0..1.0).contains(&x) && (0.0..1.0).contains(&y) {
                                        events.push(ClickEvent {
                                            elapsed_secs: start.elapsed().as_secs_f64(),
                                            x_fraction: x,
                                            y_fraction: y,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    was_down = is_down;
                    std::thread::sleep(std::time::Duration::from_millis(8));
                }
                events
            });

            Ok(Self { running, handle, started_hns })
        }

        pub fn stop(self) -> Vec<ClickEvent> {
            self.running.store(false, Ordering::Relaxed);
            self.handle.join().unwrap_or_default()
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod fallback {
    use super::{now_hns, ClickEvent};

    pub struct ClickCapture {
        pub started_hns: i64,
    }

    impl ClickCapture {
        pub fn start(_origin: (i32, i32), _size: (i32, i32)) -> Result<Self, String> {
            Ok(Self { started_hns: now_hns() })
        }
        pub fn stop(self) -> Vec<ClickEvent> {
            Vec::new()
        }
    }
}
