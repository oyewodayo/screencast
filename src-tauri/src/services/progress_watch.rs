// services/progress_watch.rs
//
// Windows-only for now, matching this codebase's "Windows is the only verified recording
// backend" posture (see RECORDING_UPGRADE_NOTES.md).
//
// win.rs's own recording_with_output_* functions null ffmpeg's stdout/stderr deliberately -
// piping either without a dedicated reader thread draining it would deadlock the whole recording
// once the OS pipe buffer fills (see recording_with_output_sva's comment on that). That means
// there was previously no live signal at all reaching the UI while a recording is in progress:
// dropped frames, the encoder falling behind, or a stalled capture were only ever discoverable
// after the fact in the finished file.
//
// This uses ffmpeg's own `-progress <file>` flag instead of stdout/stderr - ffmpeg periodically
// *writes* a block of key=value stats to that file on its own, so there's no pipe to drain and
// no deadlock risk. This module just polls that file on a timer and forwards the latest block to
// the frontend as a `recording-progress` event.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Arc;
use std::time::Duration;

use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingProgress {
    pub frame: Option<u64>,
    pub fps: Option<f64>,
    pub bitrate_kbps: Option<f64>,
    pub out_time_secs: Option<f64>,
    pub dup_frames: Option<u64>,
    pub drop_frames: Option<u64>,
    pub speed: Option<f64>,
}

// Sidecar convention mirrors click_sidecar_path/system_audio's own "<stem>.<suffix>" naming in
// recording.rs - deleted once the watcher stops, so it never lingers as a stray file next to a
// finished recording.
pub fn progress_sidecar_path(output_path: &Path) -> PathBuf {
    let stem = output_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    output_path.with_file_name(format!("{}.progress.log", stem))
}

// Spawns a background task that tails `progress_path` and emits a `recording-progress` event
// each time it grows, until the ffmpeg child at `expected_pid` is no longer the one stored in
// `ffmpeg_process` - covering both "this recording was stopped/replaced normally" and "ffmpeg
// died on its own", without needing a separate cancellation handle: AppState's own ffmpeg_process
// is already the single source of truth for "is this recording still going".
pub fn watch(
    app_handle: AppHandle,
    progress_path: PathBuf,
    ffmpeg_process: Arc<Mutex<Option<Child>>>,
    expected_pid: u32,
) {
    tauri::async_runtime::spawn(async move {
        let mut last_len: u64 = 0;
        loop {
            let _ = tauri::async_runtime::spawn_blocking(|| {
                std::thread::sleep(Duration::from_millis(750));
            })
            .await;

            let still_this_recording = {
                let guard = ffmpeg_process.lock().await;
                guard.as_ref().map(|c| c.id()) == Some(expected_pid)
            };
            if !still_this_recording {
                break;
            }

            let Ok(contents) = std::fs::read_to_string(&progress_path) else {
                continue;
            };
            let len = contents.len() as u64;
            if len == last_len {
                continue;
            }
            last_len = len;

            if let Some(progress) = parse_latest_block(&contents) {
                let _ = app_handle.emit("recording-progress", progress);
            }
        }
        let _ = std::fs::remove_file(&progress_path);
    });
}

// ffmpeg's -progress file is a sequence of key=value blocks, each one terminated by a
// "progress=continue" (mid-recording) or "progress=end" (final) line. Walks backward from the
// last such line to find where that final block starts, rather than re-parsing the whole
// (ever-growing, for a long recording) file's history every poll.
fn parse_latest_block(contents: &str) -> Option<RecordingProgress> {
    let lines: Vec<&str> = contents.lines().collect();
    let end_idx = lines.iter().rposition(|l| l.starts_with("progress="))?;
    let start_idx = lines[..end_idx]
        .iter()
        .rposition(|l| l.starts_with("progress="))
        .map(|i| i + 1)
        .unwrap_or(0);

    let mut map: HashMap<&str, &str> = HashMap::new();
    for line in &lines[start_idx..=end_idx] {
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim(), v.trim());
        }
    }

    let parse_u64 = |k: &str| map.get(k).and_then(|v| v.parse::<u64>().ok());
    let parse_f64 = |k: &str| map.get(k).and_then(|v| v.parse::<f64>().ok());

    Some(RecordingProgress {
        frame: parse_u64("frame"),
        fps: parse_f64("fps"),
        // "N/A" (no bitrate figure yet, e.g. audio-only capture) parses to None via .ok(),
        // same graceful "missing is fine" handling as every other field here.
        bitrate_kbps: map
            .get("bitrate")
            .and_then(|v| v.trim_end_matches("kbits/s").parse::<f64>().ok()),
        out_time_secs: parse_f64("out_time_us").map(|us| us / 1_000_000.0),
        dup_frames: parse_u64("dup_frames"),
        drop_frames: parse_u64("drop_frames"),
        speed: map.get("speed").and_then(|v| v.trim_end_matches('x').parse::<f64>().ok()),
    })
}
