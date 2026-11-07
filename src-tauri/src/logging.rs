// logging.rs
//
// Process-wide logging and the panic hook. Runs before Tauri's `Builder` exists, so a panic during
// plugin registration or setup is still captured - which is why the log directory is resolved from
// plain environment variables rather than Tauri's path API (there is no `AppHandle` yet).

use log::{error, LevelFilter};
use simplelog::{CombinedLogger, ConfigBuilder, SharedLogger, WriteLogger};
use std::fs::OpenOptions;
use std::path::PathBuf;

// File half of the logger, capped: once app.log passes MAX_LOG_BYTES it becomes app.log.1
// (replacing the previous one) and a fresh app.log starts, so the logs never hold more than about
// twice the cap. Uncapped and at TRACE, a month of normal use reached 126 MB.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

// Terminal half of the logger. Lines are handed to a background thread rather than written to
// stdout inline: in a dev build stdout is a pipe to the `tauri dev` terminal, and whenever that
// pipe stopped being drained, every log call in the process blocked on it - the UI thread, the
// watchdog, and stop_recording/pause_recording mid-command alike - which froze the Stop and Pause
// buttons for minutes at a time. If the queue is full the line is dropped from the terminal only;
// app.log still gets every line.
struct NonBlockingStdout(std::sync::mpsc::SyncSender<Vec<u8>>);

impl NonBlockingStdout {
    fn spawn() -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(4096);
        // If the thread can't start, rx is dropped and every try_send below just fails quietly.
        let _ = std::thread::Builder::new().name("log-stdout".into()).spawn(move || {
            use std::io::Write;
            let mut out = std::io::stdout();
            for chunk in rx {
                let _ = out.write_all(&chunk);
            }
        });
        Self(tx)
    }
}

impl std::io::Write for NonBlockingStdout {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = self.0.try_send(buf.to_vec());
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct RotatingLogFile {
    path: PathBuf,
    file: Option<std::fs::File>,
    written: u64,
}

impl RotatingLogFile {
    fn open(path: PathBuf) -> std::io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        let mut log = Self { path, file: Some(file), written };
        if log.written >= MAX_LOG_BYTES {
            log.rotate();
        }
        Ok(log)
    }

    fn rotate(&mut self) {
        // Windows can't rename a file that's still open, so the handle goes first.
        self.file = None;
        let _ = std::fs::rename(&self.path, self.path.with_extension("log.1"));
        self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        self.written = 0;
    }
}

impl std::io::Write for RotatingLogFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.written >= MAX_LOG_BYTES {
            self.rotate();
        }
        self.written += buf.len() as u64;
        match self.file.as_mut() {
            Some(file) => file.write(buf),
            // Reopening failed - drop the line rather than fail the caller; logging must never
            // take the app down.
            None => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.as_mut().map_or(Ok(()), |f| f.flush())
    }
}

/// Per-OS app-data directory for log files. Every target has an answer, so adding a platform
/// can never turn this into a compile error: anything not listed (including Android and iOS,
/// which have no `APPDATA`/`HOME` convention a bare env lookup can rely on) uses the temp dir.
fn resolve_log_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(target_os = "linux")]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let base: Option<PathBuf> = None;

    base.map(|dir| dir.join("Briefcast").join("logs")).unwrap_or_else(std::env::temp_dir)
}

fn panic_message<'a>(info: &'a std::panic::PanicHookInfo<'_>) -> &'a str {
    let payload = info.payload();
    if let Some(s) = payload.downcast_ref::<&str>() {
        s
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.as_str()
    } else {
        "Unknown panic payload"
    }
}

/// Starts the file + terminal loggers and installs the panic hook. Safe to call once, first thing.
pub fn init() {
    let log_dir = resolve_log_dir();
    let _ = std::fs::create_dir_all(&log_dir);
    let panic_log_path = log_dir.join("panic.log");
    // An unwritable app-data folder costs the log file, never the app.
    let log_file = RotatingLogFile::open(log_dir.join("app.log")).ok();

    let config = ConfigBuilder::new()
        .set_time_format_rfc3339()
        .set_time_offset_to_local()
        .unwrap_or_else(|builder| builder)
        .build();

    // The file comes first and the terminal never blocks - see NonBlockingStdout for why.
    let mut loggers: Vec<Box<dyn SharedLogger>> = Vec::new();
    if let Some(log_file) = log_file {
        // DEBUG while developing; INFO and up for users, which still keeps every warning,
        // error, watchdog stall and recording milestone without per-frame noise. Not TRACE even
        // in development: wasapi alone logs every 10ms audio packet at it, which rotated the
        // 10MB log in eight minutes - taking the start of any longer recording with it, along
        // with whatever went wrong there.
        let level = if cfg!(debug_assertions) { LevelFilter::Debug } else { LevelFilter::Info };
        loggers.push(WriteLogger::new(level, config.clone(), log_file));
    }
    loggers.push(WriteLogger::new(LevelFilter::Debug, config, NonBlockingStdout::spawn()));
    let _ = CombinedLogger::init(loggers);

    std::panic::set_hook(Box::new(move |info| {
        let message = panic_message(info);
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "Unknown location".to_string());
        error!("PANIC occurred at {}: {}", location, message);

        // Also write to a separate panic log, which survives app.log rotation.
        let entry = format!(
            "\n=== PANIC at {} ===\n{}\n{}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            location,
            message
        );
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&panic_log_path) {
            use std::io::Write;
            let _ = file.write_all(entry.as_bytes());
        }
    }));

    std::env::set_var("RUST_BACKTRACE", "1");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn log_dir_always_resolves_to_a_path() {
        // The contract that matters for porting: never panics, never empty.
        assert!(!resolve_log_dir().as_os_str().is_empty());
    }

    #[test]
    fn rotating_log_moves_the_full_file_aside_and_keeps_writing() {
        let dir = std::env::temp_dir().join(format!("briefcast-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app.log");
        std::fs::write(&path, vec![b'x'; MAX_LOG_BYTES as usize]).unwrap();

        let mut log = RotatingLogFile::open(path.clone()).unwrap();
        log.write_all(b"fresh\n").unwrap();
        log.flush().unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "fresh\n");
        assert_eq!(std::fs::metadata(path.with_extension("log.1")).unwrap().len(), MAX_LOG_BYTES);
    }
}
