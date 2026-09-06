// services/file_watcher.rs
//
// Watches the Briefcast root directory (recursively) for filesystem changes made from outside the
// app — a file dropped in from Explorer, another app saving straight into the folder, etc. — and
// re-emits "refresh-file-list" (the same event commands/recording.rs already fires after its own
// writes) so the sidebar picks the change up live instead of only on the next app restart or a
// manual refresh click.
//
// Debounced (see DEBOUNCE_MS) since a single file write/move typically fires several raw notify
// events in quick succession, and copying in a whole batch of files should still trigger one
// sidebar refresh rather than dozens.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager};

const DEBOUNCE_MS: u64 = 600;

// Held for the app's lifetime via .manage() (see main.rs) purely so the watcher — and the
// background thread notify/the debouncer spawn internally — isn't dropped (and thus silently
// stopped) the moment start_watching returns. Replaced wholesale by start_watching whenever the
// watched root itself changes (see set_briefcast_dir/reset_briefcast_dir), which drops — and so
// stops — whatever watcher was previously running before the new one takes over.
#[derive(Default)]
pub struct FileWatcherState(pub Mutex<Option<Debouncer<RecommendedWatcher>>>);

// Starts (or restarts) watching `dir` for this app session. Failures are only logged, never
// surfaced to the user — real-time refresh is a nice-to-have layered on top of the sidebar's
// existing on-mount scan and manual refresh button, never something the rest of the app should
// fail over.
pub fn start_watching(app_handle: &AppHandle, dir: &Path) {
    let emit_handle = app_handle.clone();
    let result = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        move |res: DebounceEventResult| match res {
            Ok(events) if !events.is_empty() => {
                if let Err(e) = emit_handle.emit("refresh-file-list", ()) {
                    log::warn!("Failed to emit refresh-file-list from file watcher: {}", e);
                }
            }
            Ok(_) => {}
            Err(e) => log::warn!("File watcher error: {:?}", e),
        },
    )
    .and_then(|mut debouncer| {
        debouncer.watcher().watch(dir, RecursiveMode::Recursive)?;
        Ok(debouncer)
    });

    let state = app_handle.state::<FileWatcherState>();
    match result {
        Ok(debouncer) => *state.0.lock().unwrap() = Some(debouncer),
        Err(e) => {
            log::warn!("Failed to start file watcher on {}: {:?}", dir.display(), e);
            *state.0.lock().unwrap() = None;
        }
    }
}
