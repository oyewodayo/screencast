// commands/window_capture/linux.rs
//
// Linux window/monitor enumeration and window-thumbnail capture via direct X11 protocol
// requests through x11rb (a pure-Rust X11 client — talks to the X server over its own socket
// transport, no libX11/libxcb .so needed at build or run time). This is the closest Linux analog
// to win.rs's direct Win32 calls: real protocol requests, not shelling out to xdotool/wmctrl/
// ImageMagick.
//
// Built on the EWMH conventions every mainstream desktop implements (GNOME, KDE, XFCE, Cinnamon,
// i3+polybar, ...) for window listing/activation, and RandR 1.5 (`get_monitors`) for monitor
// geometry — both near-universal on anything running an X server today, including XWayland.
//
// Window *screenshot* capture specifically needs a compositor redirecting the window's output to
// an off-screen pixmap (via the Composite extension) — present out of the box on GNOME/KDE/XFCE/
// Cinnamon, but tiling WMs like i3/dwm need a separate compositor (e.g. `picom`) running for this
// to work. Exactly like win.rs's own PrintWindow path ("a thumbnail is purely cosmetic... still
// perfectly valid to select... even if [it] can't produce a preview"), any failure here — no
// compositor, unmapped window, anything — just means no thumbnail, never a broken window list.
//
// UNVERIFIED: written against documented X11/EWMH/RandR/Composite protocol behavior, not
// exercised against a real X server from this (Windows) environment. The single spot most likely
// to need a quick fix on first build is the exact casing of `Redirect::AUTOMATIC` below, which
// depends on how the installed x11rb version's code generator named that enum variant.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;

use image::{Rgba, RgbaImage};
use x11rb::connection::Connection;
use x11rb::protocol::composite::{ConnectionExt as _, Redirect};
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::xproto::{
    AtomEnum, ChangeWindowAttributesAux, ClientMessageEvent, ConnectionExt as _, EventMask,
    ImageFormat, ImageOrder, Window,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

use super::{MonitorInfo, WindowInfo, WindowTitles};

static CAPTURE_RUN_COUNTER: AtomicU64 = AtomicU64::new(0);
static LAST_TWO_WINDOWS: OnceLock<Mutex<[String; 2]>> = OnceLock::new();
static MONITOR_THREAD: OnceLock<Mutex<Option<MonitorHandle>>> = OnceLock::new();

struct MonitorHandle {
    running: Arc<std::sync::atomic::AtomicBool>,
    join_handle: JoinHandle<()>,
}

fn last_two_windows() -> &'static Mutex<[String; 2]> {
    LAST_TWO_WINDOWS.get_or_init(|| Mutex::new([String::new(), String::new()]))
}

fn monitor_thread_slot() -> &'static Mutex<Option<MonitorHandle>> {
    MONITOR_THREAD.get_or_init(|| Mutex::new(None))
}

// -------- connection + EWMH atom helpers --------

struct Atoms {
    net_client_list: u32,
    net_wm_name: u32,
    utf8_string: u32,
    net_active_window: u32,
}

fn connect() -> Result<(RustConnection, usize), String> {
    x11rb::connect(None).map_err(|e| format!("Failed to connect to the X server (is DISPLAY set?): {}", e))
}

fn intern(conn: &RustConnection, name: &str) -> Result<u32, String> {
    conn.intern_atom(false, name.as_bytes())
        .map_err(|e| format!("Failed to intern atom {}: {}", name, e))?
        .reply()
        .map_err(|e| format!("Failed to intern atom {}: {}", name, e))
        .map(|r| r.atom)
}

fn atoms(conn: &RustConnection) -> Result<Atoms, String> {
    Ok(Atoms {
        net_client_list: intern(conn, "_NET_CLIENT_LIST")?,
        net_wm_name: intern(conn, "_NET_WM_NAME")?,
        utf8_string: intern(conn, "UTF8_STRING")?,
        net_active_window: intern(conn, "_NET_ACTIVE_WINDOW")?,
    })
}

// A window's title: _NET_WM_NAME (UTF8_STRING, the modern EWMH way) falling back to the legacy
// ICCCM WM_NAME property if a window (usually an older/simpler app) doesn't set it.
fn window_title(conn: &RustConnection, atoms: &Atoms, window: Window) -> String {
    if let Ok(Ok(reply)) = conn
        .get_property(false, window, atoms.net_wm_name, atoms.utf8_string, 0, u32::MAX)
        .map(|c| c.reply())
    {
        if !reply.value.is_empty() {
            return String::from_utf8_lossy(&reply.value).trim().to_string();
        }
    }
    if let Ok(Ok(reply)) = conn
        .get_property(false, window, AtomEnum::WM_NAME, AtomEnum::STRING, 0, u32::MAX)
        .map(|c| c.reply())
    {
        if !reply.value.is_empty() {
            return String::from_utf8_lossy(&reply.value).trim().to_string();
        }
    }
    String::new()
}

// The window manager's own list of top-level, user-facing windows — already excludes the kind
// of junk (tooltips, menus, the desktop itself) Win32's EnumWindows would otherwise require
// manual filtering for, since unlike Win32 this is the WM's *curated* list, not literally every
// top-level window that exists.
fn client_list(conn: &RustConnection, atoms: &Atoms, root: Window) -> Result<Vec<Window>, String> {
    let reply = conn
        .get_property(false, root, atoms.net_client_list, AtomEnum::WINDOW, 0, u32::MAX)
        .map_err(|e| format!("Failed to request _NET_CLIENT_LIST: {}", e))?
        .reply()
        .map_err(|e| {
            format!(
                "Window manager doesn't support _NET_CLIENT_LIST ({}). A modern EWMH-compliant \
                 desktop (GNOME/KDE/XFCE/...) is required for window selection.",
                e
            )
        })?;

    Ok(reply.value32().map(|iter| iter.collect()).unwrap_or_default())
}

fn open_windows_with_titles() -> Result<Vec<(Window, String)>, String> {
    let (conn, screen_num) = connect()?;
    let root = conn.setup().roots[screen_num].root;
    let atoms = atoms(&conn)?;
    let windows = client_list(&conn, &atoms, root)?;

    Ok(windows
        .into_iter()
        .map(|w| {
            let title = window_title(&conn, &atoms, w);
            (w, title)
        })
        .filter(|(_, title)| !title.is_empty())
        .collect())
}

// -------- public surface (mirrors win.rs) --------

pub fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    let (conn, screen_num) = connect()?;
    let root = conn.setup().roots[screen_num].root;

    let reply = conn
        .get_monitors(root, true)
        .map_err(|e| format!("Failed to request monitors: {}", e))?
        .reply()
        .map_err(|e| format!("Failed to get monitors (is RandR 1.5+ available?): {}", e))?;

    let mut monitors = Vec::new();
    for (index, m) in reply.monitors.iter().enumerate() {
        let name = conn
            .get_atom_name(m.name)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|r| String::from_utf8_lossy(&r.name).to_string())
            .unwrap_or_else(|| format!("Display {}", index + 1));

        monitors.push(MonitorInfo {
            id: format!("monitor_{}", index),
            name,
            x: m.x as i32,
            y: m.y as i32,
            width: m.width as i32,
            height: m.height as i32,
            is_primary: m.primary,
        });
    }

    Ok(monitors)
}

pub async fn capture_window_screenshots_by_title(_app_handle: tauri::AppHandle) -> Result<Vec<WindowInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (conn, screen_num) = connect()?;
        let root = conn.setup().roots[screen_num].root;
        let atoms = atoms(&conn)?;
        let windows = client_list(&conn, &atoms, root)?;

        let mut candidates: Vec<(Window, String)> = Vec::new();
        for window in windows {
            let title = window_title(&conn, &atoms, window);
            if title.is_empty() {
                continue;
            }
            let geometry = match conn.get_geometry(window).and_then(|c| c.reply()) {
                Ok(g) => g,
                Err(_) => continue, // window closed between listing and here, or unreadable
            };
            if geometry.width <= 100 || geometry.height <= 100 {
                continue;
            }
            candidates.push((window, title));
        }

        if candidates.is_empty() {
            return Err("No valid windows found".to_string());
        }

        let run_id = format!(
            "{}_{}",
            std::process::id(),
            CAPTURE_RUN_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let temp_dir = std::env::temp_dir();
        let mut window_infos = Vec::new();

        for (index, (window, title)) in candidates.iter().enumerate() {
            let output_filename = format!("briefcast_window_{}_{}.png", run_id, index);
            let output_path = temp_dir.join(&output_filename);

            log::debug!("Attempting to capture: '{}'", title);

            let image_path = match capture_window(&conn, *window, &output_path) {
                Ok(_) => output_path.to_string_lossy().to_string(),
                Err(e) => {
                    log::debug!("Failed to capture '{}': {} - listing without a thumbnail", title, e);
                    let _ = std::fs::remove_file(&output_path);
                    String::new()
                }
            };

            window_infos.push(WindowInfo {
                title: title.clone(),
                image_path,
                hwnd: *window as isize,
                // TODO: resolve via the window's _NET_WM_PID property + /proc/<pid>/exe, same
                // idea as win.rs's get_process_exe_path. Left empty for now rather than blocking
                // this on X11 process-id plumbing that nothing else here needs yet.
                exe_path: String::new(),
            });
        }

        log::debug!(
            "Listed {} windows ({} with thumbnails)",
            window_infos.len(),
            window_infos.iter().filter(|w| !w.image_path.is_empty()).count()
        );
        Ok(window_infos)
    })
    .await
    .map_err(|e| format!("Screenshot capture task panicked: {}", e))?
}

// Redirects the window's rendering into an off-screen pixmap via the Composite extension (so
// this works even for a partially-obscured window, not just whatever's currently on top — the
// same reason win.rs uses PrintWindow instead of a plain screen-region grab) and reads that
// pixmap's pixels back with GetImage.
fn capture_window(conn: &RustConnection, window: Window, output_path: &std::path::Path) -> Result<(), String> {
    conn.redirect_window(window, Redirect::AUTOMATIC)
        .map_err(|e| format!("redirect_window request failed: {}", e))?;

    let pixmap = conn
        .generate_id()
        .map_err(|e| format!("Failed to allocate a pixmap id: {}", e))?;

    let name_result = conn
        .name_window_pixmap(window, pixmap)
        .map_err(|e| format!("name_window_pixmap request failed: {}", e))
        .and_then(|cookie| cookie.check().map_err(|e| format!("name_window_pixmap failed (no compositor running?): {}", e)));

    if let Err(e) = name_result {
        let _ = conn.unredirect_window(window, Redirect::AUTOMATIC);
        return Err(e);
    }

    let capture_result = (|| -> Result<(), String> {
        let geometry = conn
            .get_geometry(pixmap)
            .map_err(|e| format!("get_geometry request failed: {}", e))?
            .reply()
            .map_err(|e| format!("get_geometry failed: {}", e))?;

        if geometry.width == 0 || geometry.height == 0 {
            return Err("Captured image has zero size".to_string());
        }

        let image_reply = conn
            .get_image(ImageFormat::Z_PIXMAP, pixmap, 0, 0, geometry.width, geometry.height, !0)
            .map_err(|e| format!("get_image request failed: {}", e))?
            .reply()
            .map_err(|e| format!("get_image failed: {}", e))?;

        pixels_to_png(&image_reply.data, geometry.width as u32, geometry.height as u32, conn.setup().image_byte_order, output_path)
    })();

    let _ = conn.free_pixmap(pixmap);
    let _ = conn.unredirect_window(window, Redirect::AUTOMATIC);

    capture_result
}

// 32bpp TrueColor visuals are laid out BGRX/BGRA in memory on virtually every modern Linux
// desktop (little-endian X servers, which is effectively all of them outside some ARM/big-endian
// setups) — image_byte_order flips the interpretation for that uncommon big-endian case rather
// than assuming one fixed order unconditionally.
fn pixels_to_png(data: &[u8], width: u32, height: u32, byte_order: ImageOrder, output_path: &std::path::Path) -> Result<(), String> {
    let msb_first = byte_order == ImageOrder::MSB_FIRST;
    let mut img = RgbaImage::new(width, height);

    for y in 0..height {
        for x in 0..width {
            let idx = ((y * width + x) * 4) as usize;
            if idx + 3 >= data.len() {
                continue;
            }
            let (b, g, r) = if msb_first {
                (data[idx + 1], data[idx + 2], data[idx + 3])
            } else {
                (data[idx], data[idx + 1], data[idx + 2])
            };
            img.put_pixel(x, y, Rgba([r, g, b, 255]));
        }
    }

    img.save(output_path).map_err(|e| format!("Failed to save image: {}", e))
}

pub fn get_windows_titles() -> Vec<String> {
    match open_windows_with_titles() {
        Ok(list) => list.into_iter().map(|(_, title)| title).collect(),
        Err(e) => {
            log::debug!("Failed to enumerate windows: {}", e);
            Vec::new()
        }
    }
}

pub async fn activate_and_open_window(title: &str) -> Result<(), String> {
    let title = title.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let (conn, screen_num) = connect()?;
        let root = conn.setup().roots[screen_num].root;
        let atoms = atoms(&conn)?;
        let windows = client_list(&conn, &atoms, root)?;

        let target = windows
            .into_iter()
            .find(|&w| window_title(&conn, &atoms, w) == title)
            .ok_or_else(|| format!("Window '{}' not found", title))?;

        // Ask the window manager to raise+focus (and, per the EWMH spec, deiconify if
        // minimized) via a standard _NET_ACTIVE_WINDOW client message to the root window — the
        // request every EWMH-compliant WM expects for this, rather than trying to manipulate
        // window state directly the way a WM itself would.
        let event = ClientMessageEvent::new(32, target, atoms.net_active_window, [1u32, 0, 0, 0, 0]);
        conn.send_event(
            false,
            root,
            EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
            event,
        )
        .map_err(|e| format!("Failed to send activate request: {}", e))?;
        conn.flush().map_err(|e| format!("Failed to flush X connection: {}", e))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Activate window task panicked: {}", e))?
}

pub async fn start_monitoring_windows() -> Result<(), String> {
    let mut slot = monitor_thread_slot().lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Err("Monitoring is already active".to_string());
    }

    let running = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let running_for_thread = running.clone();

    let join_handle = std::thread::spawn(move || {
        if let Err(e) = monitor_loop(running_for_thread) {
            log::debug!("Window monitoring thread exited: {}", e);
        }
    });

    *slot = Some(MonitorHandle { running, join_handle });
    log::info!("Monitoring started");
    Ok(())
}

pub async fn stop_monitoring_windows() -> Result<(), String> {
    let handle = {
        let mut slot = monitor_thread_slot().lock().map_err(|e| e.to_string())?;
        slot.take()
    };

    match handle {
        Some(h) => {
            h.running.store(false, Ordering::Relaxed);
            let _ = h.join_handle.join();
            log::info!("Monitoring stopped");
            Ok(())
        }
        None => Err("Monitoring is not active".to_string()),
    }
}

// Polls (rather than blocking on wait_for_event) purely so stop_monitoring_windows can interrupt
// this promptly via the `running` flag instead of being stuck waiting for the next X event —
// mirrors the short-interval polling stop_recording already uses elsewhere in this codebase for
// the same "need to be cleanly cancellable" reason.
fn monitor_loop(running: Arc<std::sync::atomic::AtomicBool>) -> Result<(), String> {
    let (conn, screen_num) = connect()?;
    let root = conn.setup().roots[screen_num].root;
    let atoms = atoms(&conn)?;

    conn.change_window_attributes(root, &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE))
        .map_err(|e| format!("Failed to request PropertyChangeMask on root window: {}", e))?
        .check()
        .map_err(|e| format!("Failed to select PropertyChangeMask on root window: {}", e))?;

    while running.load(Ordering::Relaxed) {
        while let Ok(Some(event)) = conn.poll_for_event() {
            if let Event::PropertyNotify(ev) = event {
                if ev.atom == atoms.net_active_window {
                    if let Ok(Ok(reply)) = conn
                        .get_property(false, root, atoms.net_active_window, AtomEnum::WINDOW, 0, 1)
                        .map(|c| c.reply())
                    {
                        if let Some(active) = reply.value32().and_then(|mut it| it.next()) {
                            let title = window_title(&conn, &atoms, active);
                            if let Ok(mut last_two) = last_two_windows().lock() {
                                if last_two[1] != title {
                                    last_two[0] = last_two[1].clone();
                                    last_two[1] = title;
                                }
                            }
                        }
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }

    Ok(())
}

pub async fn get_window_titles() -> Result<WindowTitles, String> {
    let is_active = monitor_thread_slot().lock().map(|s| s.is_some()).unwrap_or(false);
    if !is_active {
        return Err("Monitoring is not active".to_string());
    }

    let titles = last_two_windows().lock().map_err(|e| e.to_string())?;
    Ok(WindowTitles {
        active: titles[1].clone(),
        last_active: titles[0].clone(),
    })
}
