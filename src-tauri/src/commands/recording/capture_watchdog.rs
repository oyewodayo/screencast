// commands/recording/capture_watchdog.rs
//
// Keeps a recording's picture capture going for as long as the recording does.
//
// Picture and sound are captured apart (see assembly.rs): ffmpeg for the picture, in-process WASAPI
// threads for the audio. When ffmpeg died mid-recording - Desktop Duplication lost to a display
// mode change, a UAC prompt or a driver reset - nothing noticed: the audio went on, the timer kept
// counting, and at stop the recording came out only as long as the picture had lasted. One
// 35-minute presentation came out 2m51s long that way, its microphone WAV holding all 36 minutes.
//
// So while recording this looks at the capture once a second. Exited, or alive but without a new
// frame for STALL_AFTER (a hung driver - ddagrab duplicates frames on a still screen, and gdigrab
// and dshow deliver at a fixed rate, so a working capture never goes quiet that long), it's started
// again from the same command line into a new intermediate. At stop the parts are joined on one
// clock (assembly::merge_timings); the second or so a restart takes holds the last picture over
// unbroken audio.
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use log::{info, warn};
use tauri::{AppHandle, Emitter, Manager};

use super::assembly::{Assembly, CaptureCommand, VideoPart};
use super::AppState;

const TICK: Duration = Duration::from_secs(1);
const STALL_AFTER: Duration = Duration::from_secs(15);
// Restarts that die again before their first frame (the screen still unavailable while a UAC
// prompt is up, say) are retried less and less often, down to this.
const MAX_BACKOFF: Duration = Duration::from_secs(10);

// Watches the recording whose intermediate is `video_path` until it's stopped.
pub(crate) fn watch(app_handle: AppHandle, video_path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let state = app_handle.state::<AppState>();
        let mut last_frames = 0u64;
        let mut last_progress = Instant::now();
        // Restarts since the capture last delivered a frame.
        let mut failures = 0u32;
        // Set while the capture is down: when to try starting it again.
        let mut retry_at: Option<Instant> = None;
        let mut recovering = false;
        loop {
            let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(TICK)).await;

            // Same order pause_recording and stop_recording take these in.
            let paused = state.paused.lock().await;
            let mut process = state.ffmpeg_process.lock().await;
            let mut assembly = state.assembly.lock().await;
            // stop_recording takes the process first, so a missing one means the recording's over.
            let (Some(child), Some(parts)) = (
                process.as_mut(),
                assembly.as_mut().filter(|a| a.video_path == video_path),
            ) else {
                break;
            };
            let Some(command) = parts.command.clone() else { break };
            if *paused {
                last_progress = Instant::now();
                continue;
            }

            let frames = parts
                .current_timing()
                .map_or(0, |t| t.lock().unwrap_or_else(|p| p.into_inner()).frames());
            if frames != last_frames {
                last_frames = frames;
                last_progress = Instant::now();
                failures = 0;
                if recovering {
                    recovering = false;
                    info!("Screen capture recovered into {:?}", parts.current_video_path());
                    let _ = app_handle.emit("recording-capture-status", "recovered");
                }
            }

            match child.try_wait() {
                Ok(None) if last_progress.elapsed() < STALL_AFTER => continue,
                Ok(None) => {
                    warn!(
                        "Screen capture delivered no frames for {}s, restarting it. ffmpeg's last output:\n{}",
                        STALL_AFTER.as_secs(),
                        diagnostics(parts)
                    );
                    let _ = app_handle.emit("recording-capture-status", "lost");
                    // Asked to finish what it has, so the part written so far stays readable.
                    let Some(mut stalled) = process.take() else { break };
                    if let Some(stdin) = stalled.stdin.as_mut() {
                        use std::io::Write;
                        let _ = stdin.write_all(b"q");
                        let _ = stdin.flush();
                    }
                    let path = parts.current_video_path().to_path_buf();
                    let stalled = tauri::async_runtime::spawn_blocking(move || {
                        super::wait_for_ffmpeg_to_finalize(&mut stalled, &path);
                        stalled
                    })
                    .await;
                    match stalled {
                        Ok(stalled) => *process = Some(stalled),
                        Err(_) => break,
                    }
                    retry_at = Some(Instant::now());
                }
                Ok(Some(status)) if retry_at.is_none() => {
                    warn!(
                        "Screen capture exited mid-recording ({}), restarting it. ffmpeg's last output:\n{}",
                        status,
                        diagnostics(parts)
                    );
                    let _ = app_handle.emit("recording-capture-status", "lost");
                    let backoff = if failures == 0 {
                        Duration::ZERO
                    } else {
                        (Duration::from_secs(1) * 2u32.pow(failures.min(4) - 1)).min(MAX_BACKOFF)
                    };
                    retry_at = Some(Instant::now() + backoff);
                }
                Ok(Some(_)) => {}
                Err(_) => continue,
            }

            if retry_at.is_some_and(|at| Instant::now() >= at) {
                retry_at = None;
                failures += 1;
                match restart(parts, &command) {
                    Ok(child) => {
                        let pid = child.id();
                        *process = Some(child);
                        crate::services::progress_watch::watch(
                            app_handle.clone(),
                            command.progress_path.clone(),
                            state.ffmpeg_process.clone(),
                            pid,
                        );
                        info!("Screen capture restarted into {:?}", parts.current_video_path());
                    }
                    // The dead process stays in place, so the next tick tries again.
                    Err(e) => warn!("Couldn't restart the screen capture: {}", e),
                }
                last_frames = 0;
                last_progress = Instant::now();
                recovering = true;
            }
        }
    });
}

fn restart(parts: &mut Assembly, command: &CaptureCommand) -> Result<std::process::Child, String> {
    let path = part_path(&parts.video_path, parts.restarts.len() + 1);
    let (child, timing) = super::platform::respawn_capture(command, &parts.video_path, &path)?;
    parts.restarts.push(VideoPart { path, timing });
    Ok(child)
}

// `<stem>.video.mkv` -> `<stem>.video.part<n>.mkv`, beside it.
fn part_path(video_path: &Path, n: usize) -> PathBuf {
    let stem = video_path.file_stem().and_then(|s| s.to_str()).unwrap_or("recording");
    video_path.with_file_name(format!("{}.part{}.mkv", stem, n))
}

fn diagnostics(parts: &Assembly) -> String {
    parts
        .current_timing()
        .map(|t| t.lock().unwrap_or_else(|p| p.into_inner()).diagnostics())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_sit_beside_the_intermediate() {
        let base = Path::new(r"C:\tmp\briefcast-capture\Rec.video.mkv");
        assert_eq!(part_path(base, 2), Path::new(r"C:\tmp\briefcast-capture\Rec.video.part2.mkv"));
    }
}
