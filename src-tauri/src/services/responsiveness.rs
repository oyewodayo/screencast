// services/responsiveness.rs
//
// Everything that keeps the window from going "Not responding".
//
// Windows marks a window "Not responding" once its UI thread stops pumping messages for ~5s. In
// Tauri v2 a `#[tauri::command]` declared as a plain (non-async) `fn` runs ON that UI thread, so
// any such command that touches the disk, spawns a process or waits on a channel freezes the whole
// window for as long as it takes. That was the cause of the long freezes during editing and
// recording (native playback pulls waiting up to 300ms back-to-back, `ffmpeg -list_devices`
// probes, autosaves, file listings...). The rules, enforced by the test at the bottom:
//
// 1. Every command is either `async fn`, or a sync `fn` marked `#[command(async)]` (which Tauri
//    runs on its async runtime instead of the UI thread). Never a plain sync command.
// 2. Inside async code, anything that can take more than a few milliseconds - a child process, a
//    large file, a channel wait, a sleep - goes through `blocking()` (spawn_blocking), so it can't
//    tie up the shared async workers every other command needs either.
// 3. Sync `(async)` commands call `serial()` first. They used to be serialized for free by all
//    sharing the one UI thread, and several do read-modify-write on JSON/index files (docs
//    folders, comments, versions, trash) that would corrupt if two ran at once - the guard keeps
//    exactly that one-at-a-time guarantee without blocking the window.
//
// On top of that: a larger async worker pool as a safety margin (install_async_runtime), a
// watchdog that logs any UI-thread stall that still happens (start_ui_watchdog), and a command the
// frontend uses to log its own long main-thread tasks (report_frontend_stall), so any future
// freeze shows up in app.log with a cause instead of as a user complaint.

use std::cell::Cell;
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::AppHandle;

/// Runs blocking work on Tauri's blocking thread pool and awaits it.
pub async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("Background task failed: {}", e))
}

static SERIAL: Mutex<()> = Mutex::new(());

thread_local! {
    static HOLDS_SERIAL: Cell<bool> = const { Cell::new(false) };
}

pub struct SerialGuard {
    guard: Option<MutexGuard<'static, ()>>,
}

impl Drop for SerialGuard {
    fn drop(&mut self) {
        if self.guard.is_some() {
            HOLDS_SERIAL.with(|held| held.set(false));
        }
    }
}

/// See rule 3 above. Re-entrant on the same thread, so a command that calls another command's
/// function directly can't deadlock on itself; poison-tolerant, so one panicking command can't
/// wedge every later one.
pub fn serial() -> SerialGuard {
    if HOLDS_SERIAL.with(|held| held.get()) {
        return SerialGuard { guard: None };
    }
    let guard = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    HOLDS_SERIAL.with(|held| held.set(true));
    SerialGuard { guard: Some(guard) }
}

/// Gives Tauri a tokio runtime with more workers than its default (one per core). Rule 2 keeps
/// long waits off these workers, but a sync `(async)` command still occupies one for its few
/// milliseconds of disk I/O, and the serial guard can queue several of them - the extra headroom
/// means that can never starve recording start/stop or playback of a worker. Must run before
/// tauri::Builder; falls back to Tauri's own runtime if building one fails.
pub fn install_async_runtime() {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let workers = (cores * 2).clamp(8, 32);
    match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .thread_name("briefcast-async")
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            let handle = runtime.handle().clone();
            // Lives for the whole process, exactly like the runtime Tauri would have created.
            Box::leak(Box::new(runtime));
            tauri::async_runtime::set(handle);
        }
        Err(e) => log::warn!("Falling back to Tauri's default async runtime: {}", e),
    }
}

/// `Command::output()` with a hard deadline: a child that hangs (a dshow probe stuck on a busy
/// camera driver, say) is killed instead of hanging its caller forever.
pub fn output_with_timeout(mut cmd: Command, timeout: Duration) -> std::io::Result<Output> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    // Drained on their own threads so a chatty child can't block on a full pipe while we wait.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("process did not finish within {}s", timeout.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

const WATCHDOG_INTERVAL: Duration = Duration::from_millis(250);
const STALL_REPORT_MS: u64 = 1000;

/// Logs every UI-thread stall over STALL_REPORT_MS to app.log (start and recovery, with its
/// length). With rule 1 enforced this should stay silent; if it ever fires, it is the first
/// place to look. Note that dragging/resizing the window runs a modal Win32 loop that can delay
/// the heartbeat too, so an isolated short entry while moving the window is expected.
pub fn start_ui_watchdog(app: &AppHandle) {
    let app = app.clone();
    let clock = Instant::now();
    let last_beat = Arc::new(AtomicU64::new(0));

    let spawned = std::thread::Builder::new()
        .name("ui-watchdog".into())
        .spawn(move || {
            let mut stall_peak: Option<u64> = None;
            loop {
                let slept_from = std::time::SystemTime::now();
                std::thread::sleep(WATCHDOG_INTERVAL);
                // This thread oversleeping by many seconds means the machine was suspended, not
                // that the UI froze - the heartbeat is stale only because nothing ran at all.
                // Skip this round instead of logging the sleep as an hours-long "stall".
                let suspended = slept_from.elapsed().is_ok_and(|e| e > WATCHDOG_INTERVAL + Duration::from_secs(10));
                if suspended {
                    stall_peak = None;
                    last_beat.store(clock.elapsed().as_millis() as u64, Ordering::Relaxed);
                    continue;
                }
                let beat = last_beat.clone();
                let posted = app.run_on_main_thread(move || {
                    beat.store(clock.elapsed().as_millis() as u64, Ordering::Relaxed);
                });
                if posted.is_err() {
                    return; // event loop gone - app is exiting
                }
                let now = clock.elapsed().as_millis() as u64;
                let lag = now.saturating_sub(last_beat.load(Ordering::Relaxed));
                if lag >= STALL_REPORT_MS {
                    if stall_peak.is_none() {
                        log::warn!("[watchdog] UI thread unresponsive for {}ms so far", lag);
                    }
                    stall_peak = Some(stall_peak.unwrap_or(0).max(lag));
                } else if let Some(peak) = stall_peak.take() {
                    log::warn!("[watchdog] UI thread recovered after a ~{}ms stall", peak);
                }
            }
        });
    if let Err(e) = spawned {
        log::warn!("Could not start UI watchdog: {}", e);
    }
}

/// One-line diagnostics from the frontend that belong next to the watchdog's own lines - e.g. the
/// page's canvases losing their GPU contents (src/utils/stallMonitor.ts's canvas monitor).
#[tauri::command]
pub async fn report_frontend_event(message: String) {
    log::info!("[frontend] {}", message);
}

/// The webview's own main thread is separate from the native UI thread above - a long JS task
/// freezes the page's contents without Windows ever flagging the window. The frontend reports
/// those here (see src/utils/stallMonitor.ts) so they land in the same log.
#[tauri::command]
pub async fn report_frontend_stall(duration_ms: f64, context: Option<String>) {
    log::warn!(
        "[watchdog] webview main thread blocked for {:.0}ms{}",
        duration_ms,
        context.map(|c| format!(" ({})", c)).unwrap_or_default()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    // Rule 1. A plain sync command anywhere in the crate fails this test - mark it `async`, or
    // `#[command(async)]` + `serial()` for a quick sync body.
    #[test]
    fn no_command_runs_on_the_ui_thread() {
        let mut files = Vec::new();
        rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);

        let mut offenders = Vec::new();
        for file in files {
            let source = std::fs::read_to_string(&file).unwrap();
            let lines: Vec<&str> = source.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                let attr = line.trim();
                if !(attr.starts_with("#[command") || attr.starts_with("#[tauri::command")) {
                    continue;
                }
                if attr.contains("async") {
                    continue;
                }
                let Some(signature) = lines[i + 1..].iter().find(|l| l.contains("fn ")) else {
                    continue;
                };
                if !signature.contains("async fn") {
                    offenders.push(format!("{}:{}: {}", file.display(), i + 1, signature.trim()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "these commands would run on the UI thread and can freeze the window:\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn serial_guard_is_reentrant_and_releases() {
        {
            let _outer = serial();
            let _inner = serial(); // would deadlock if not re-entrant
        }
        let other = std::thread::spawn(|| {
            let _g = serial(); // would hang if the guard above leaked
        });
        other.join().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn hung_child_is_killed_at_the_deadline() {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
        let started = Instant::now();
        let result = output_with_timeout(cmd, Duration::from_secs(1));
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
