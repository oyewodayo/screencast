// native_playback.rs
//
// VLC-style fallback player: decodes a source file directly via ffmpeg's own pipeline (two
// piped child processes - one emitting MJPEG frames, one emitting raw PCM audio) instead of
// depending on WebView2's <video>/MediaSource implementation, which failed twice in practice for
// formats it can't natively decode (see VideoPlayer.tsx's handleVideoError). The frontend pulls
// frames/chunks on demand via get_next_video_frame/get_next_audio_chunk rather than having them
// pushed - this self-paces to whatever rate it can actually render, and the bound on the mpsc
// channel between the reader thread and the command handler backpressures the reader (and
// therefore ffmpeg itself, via normal OS pipe blocking) so a slow renderer can't make ffmpeg
// pile up unbounded frames in memory.
//
// Threading rules this module must keep (breaking any of them is what used to freeze the whole
// window as "Not responding" during editing):
// - Every command is `async` and every wait (ffprobe, spawning/killing ffmpeg, the bounded
//   recv_timeout on a pull) runs inside spawn_blocking. A non-async Tauri v2 command runs on the
//   UI thread, and a pull that waits there for up to 300ms, called back-to-back by two loops,
//   starves the Win32 message loop.
// - The sessions-map lock is only ever held long enough to clone an Arc out of it, and a
//   session's pipes lock only long enough to clone a receiver handle or swap pipes - never across
//   a wait, a spawn or a kill. A seek therefore never queues behind an in-flight pull.
// - Frames/chunks travel as raw bytes (tauri::ipc::Response), not base64 inside JSON, so neither
//   side spends CPU re-encoding every frame. See encode_video_packet/encode_audio_packet.
//
// Deliberately all plain functions (spawn_video_pipe/spawn_audio_pipe/read_video_frames/
// read_audio_chunks/probe_media) rather than logic embedded directly in #[tauri::command]
// bodies, so this can be exercised by an isolated test/scratch binary against the real bundled
// ffmpeg/ffprobe without needing a running Tauri app - see the module's test coverage.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, State};

use crate::services::utility::{get_ffmpeg_path, get_ffprobe_path};

#[cfg(windows)]
use crate::commands::recording::hide_console_window;

// 1280/q5/30fps (the original values) measured at ~4x real-time in isolation against this app's
// own bundled ffmpeg on a real 4K capture, but produced genuinely illegible text when displayed
// at typical player size - this app's primary content (screen recordings full of UI text) is far
// more sensitive to resolution/compression softness than to a few fewer frames per second. These
// values were chosen by measuring actual encode speed against a real 4K screen capture: 1600/q3
// still holds a ~3.3x real-time margin at 24fps (vs. ~2x at 30fps), and produces clearly legible
// text where the original settings did not.
const MAX_WIDTH: u32 = 1600;
const MAX_FPS: f64 = 24.0;
const MJPEG_QUALITY: &str = "3"; // ffmpeg -q:v scale: 2 (best) .. 31 (worst)
const AUDIO_SAMPLE_RATE: u32 = 48000;
const AUDIO_CHUNK_FRAMES: usize = 8192; // ~170ms of audio per chunk at 48kHz
const VIDEO_CHANNEL_CAP: usize = 12;
const AUDIO_CHANNEL_CAP: usize = 8;
// How long a pull will wait for the next frame/chunk before returning "nothing yet" rather than
// an error - short enough that stop/seek/pause feel responsive, long enough not to busy-loop.
const PULL_TIMEOUT_MS: u64 = 300;

#[derive(Default)]
pub struct NativePlaybackState {
    sessions: Mutex<HashMap<u64, Arc<NativeSession>>>,
    next_id: AtomicU64,
}

// One encoded frame/chunk, already in its wire layout. The receiver sits behind its own
// Arc<Mutex> so a pull can clone the handle out and wait on it without holding the session's
// pipes lock.
type Packet = Vec<u8>;
type PacketRx = Arc<Mutex<Receiver<Packet>>>;

struct SessionPipes {
    // Which seek produced these pipes - lets a slower, older seek that finishes spawning after a
    // newer one notice it lost the race and discard its own pipes instead of clobbering the newer
    // ones (rapid timeline scrubbing fires many overlapping seeks).
    generation: u64,
    video_child: Child,
    audio_child: Option<Child>,
    video_rx: PacketRx,
    audio_rx: Option<PacketRx>,
}

struct NativeSession {
    input_path: String,
    // width/fps/channels are re-used to respawn matching pipes on seek; height and the audio
    // sample rate aren't needed again after being reported once in PlaybackSessionInfo (height
    // is derived from width, sample rate is always the AUDIO_SAMPLE_RATE constant), so they're
    // not stored here.
    width: u32,
    fps: f64,
    has_audio: bool,
    channels: u16,
    seek_generation: AtomicU64,
    // None once the session has been stopped, so a seek that was already in flight discards its
    // freshly spawned pipes instead of resurrecting a dead session.
    pipes: Mutex<Option<SessionPipes>>,
}

// A panic anywhere while one of these locks is held would otherwise poison it and turn every
// later playback call into a panic too - recovering the guard keeps playback usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// Wire layout, little-endian, parsed by useNativePlaybackEngine.ts:
//   video: [pts f64][jpeg bytes...]
//   audio: [pts f64][sample_count u32][s16le pcm bytes...]
// An empty body means "nothing yet / stream ended".
fn encode_video_packet(pts: f64, jpeg: &[u8]) -> Packet {
    let mut packet = Vec::with_capacity(8 + jpeg.len());
    packet.extend_from_slice(&pts.to_le_bytes());
    packet.extend_from_slice(jpeg);
    packet
}

fn encode_audio_packet(pts: f64, sample_count: u32, pcm: &[u8]) -> Packet {
    let mut packet = Vec::with_capacity(12 + pcm.len());
    packet.extend_from_slice(&pts.to_le_bytes());
    packet.extend_from_slice(&sample_count.to_le_bytes());
    packet.extend_from_slice(pcm);
    packet
}

#[derive(Serialize)]
pub struct PlaybackSessionInfo {
    session_id: u64,
    duration: f64,
    width: u32,
    height: u32,
    fps: f64,
    has_audio: bool,
    sample_rate: u32,
    channels: u16,
}

struct ProbeInfo {
    duration: f64,
    width: u32,
    height: u32,
    fps: f64,
    has_audio: bool,
    channels: u16,
}

fn parse_fraction(s: &str) -> Option<f64> {
    let mut parts = s.split('/');
    let num: f64 = parts.next()?.parse().ok()?;
    let den: f64 = parts.next()?.parse().ok()?;
    if den == 0.0 {
        None
    } else {
        Some(num / den)
    }
}

// Plain function, no AppHandle - takes the resolved ffprobe path directly so it's callable from
// an isolated test binary that doesn't have a Tauri app to resolve resources through.
fn probe_media(ffprobe_path: &Path, input_path: &str) -> Result<ProbeInfo, String> {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        input_path,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;
    let probe: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    let duration = probe["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);

    let streams = probe["streams"].as_array().cloned().unwrap_or_default();
    let video_stream = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or("No video stream found in file")?;

    let width = video_stream["width"].as_u64().unwrap_or(0) as u32;
    let height = video_stream["height"].as_u64().unwrap_or(0) as u32;

    if width == 0 || height == 0 {
        return Err("Could not determine video dimensions".to_string());
    }

    let fps = video_stream["r_frame_rate"]
        .as_str()
        .and_then(parse_fraction)
        .filter(|f| *f > 0.0)
        .unwrap_or(30.0);

    let audio_stream = streams.iter().find(|s| s["codec_type"] == "audio");
    let has_audio = audio_stream.is_some();
    let channels = audio_stream
        .and_then(|s| s["channels"].as_u64())
        .map(|c| c as u16)
        .unwrap_or(2);

    Ok(ProbeInfo {
        duration,
        width,
        height,
        fps,
        has_audio,
        channels,
    })
}

// MJPEG frames on stdout, capped resolution/fps so the base64-over-JSON-IPC payload this
// produces (see read_video_frames) stays a manageable size - this is the primary lever against
// that being the bottleneck, applied server-side rather than left to the frontend to request
// responsibly.
fn spawn_video_pipe(
    ffmpeg_path: &Path,
    input_path: &str,
    seek_secs: f64,
    max_width: u32,
    fps: f64,
) -> Result<Child, String> {
    let mut cmd = Command::new(ffmpeg_path);
    cmd.args([
        "-ss",
        &seek_secs.to_string(),
        "-i",
        input_path,
        "-an",
        "-vf",
        &format!("scale='min({},iw)':-2", max_width),
        "-r",
        &fps.to_string(),
        "-q:v",
        MJPEG_QUALITY,
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
    ]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    spawn_guarded(cmd, "video")
}

// Raw PCM on stdout - directly usable by the Web Audio API without needing a container, and
// small enough (~192KB/s at 48kHz stereo 16-bit) that IPC size isn't a concern the way it is
// for video.
fn spawn_audio_pipe(
    ffmpeg_path: &Path,
    input_path: &str,
    seek_secs: f64,
    channels: u16,
) -> Result<Child, String> {
    let mut cmd = Command::new(ffmpeg_path);
    cmd.args([
        "-ss",
        &seek_secs.to_string(),
        "-i",
        input_path,
        "-vn",
        "-f",
        "s16le",
        "-ar",
        &AUDIO_SAMPLE_RATE.to_string(),
        "-ac",
        &channels.to_string(),
        "pipe:1",
    ]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    spawn_guarded(cmd, "audio")
}

// Bracketed by orphan_guard like the recording pipeline's own spawns, so a force-closed app
// (exactly what a user reaches for when it hangs) can't leave decode ffmpegs behind burning CPU
// and making the next session slower still.
fn spawn_guarded(mut cmd: Command, kind: &str) -> Result<Child, String> {
    crate::services::orphan_guard::before_spawn(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start {} decode: {}", kind, e))?;
    crate::services::orphan_guard::after_spawn(&child);
    Ok(child)
}

// Drains a child's stderr on its own thread so ffmpeg never blocks on a full stderr pipe (it
// writes progress/diagnostic text there continuously) - same reasoning as every other ffmpeg
// spawn in this codebase that isn't allowed to inherit/ignore stderr outright. Logged rather
// than discarded since a video/audio pipe that unexpectedly produces zero frames is otherwise
// silent about why.
fn drain_stderr(stderr: Option<std::process::ChildStderr>) {
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::debug!("[native_playback ffmpeg] {}", line);
            }
        });
    }
}

fn find_marker(haystack: &[u8], b0: u8, b1: u8) -> Option<usize> {
    haystack.windows(2).position(|w| w[0] == b0 && w[1] == b1)
}

// Splits ffmpeg's back-to-back MJPEG stream (image2pipe writes frames with no length prefix)
// into individual frames by scanning for JPEG SOI (0xFFD8) / EOI (0xFFD9) markers - safe to do
// with plain byte-pair scanning because JPEG's own byte-stuffing rule guarantees a literal
// 0xFF byte inside entropy-coded scan data is always followed by 0x00, never by a marker byte,
// so a genuine 0xFFD9 pair in the stream can only be a real EOI marker.
//
// Output fps is forced constant (-r in spawn_video_pipe), so each frame's timestamp is computed
// deterministically from its position in the sequence rather than parsed out of the stream.
fn read_video_frames(
    mut stdout: ChildStdout,
    fps: f64,
    seek_offset: f64,
    tx: SyncSender<Packet>,
) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut read_buf = [0u8; 65536];
    let mut frame_index: u64 = 0;

    loop {
        let n = match stdout.read(&mut read_buf) {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(_) => break,
        };
        buffer.extend_from_slice(&read_buf[..n]);

        loop {
            let Some(soi) = find_marker(&buffer, 0xFF, 0xD8) else {
                break;
            };
            let Some(eoi_rel) = find_marker(&buffer[soi + 2..], 0xFF, 0xD9) else {
                break;
            };
            let eoi = soi + 2 + eoi_rel;
            let frame_end = eoi + 2;

            let pts = seek_offset + (frame_index as f64) / fps;
            let packet = encode_video_packet(pts, &buffer[soi..frame_end]);

            if tx.send(packet).is_err() {
                return; // receiver gone (session stopped/seeked) - stop decoding, let the process exit
            }
            frame_index += 1;
            buffer.drain(..frame_end);
        }
    }
}

// Reads fixed-size PCM chunks (~170ms each) rather than forwarding every OS-level read() as its
// own chunk, so chunk size/timing is predictable regardless of how the pipe happens to buffer.
fn read_audio_chunks(
    mut stdout: ChildStdout,
    sample_rate: u32,
    channels: u16,
    seek_offset: f64,
    tx: SyncSender<Packet>,
) {
    let bytes_per_frame = (channels as usize).max(1) * 2; // s16le = 2 bytes/sample
    let chunk_bytes = AUDIO_CHUNK_FRAMES * bytes_per_frame;
    let mut chunk_index: u64 = 0;

    loop {
        let mut buf = vec![0u8; chunk_bytes];
        let mut filled = 0;
        while filled < chunk_bytes {
            match stdout.read(&mut buf[filled..]) {
                Ok(0) => break, // EOF mid-chunk - flush whatever we have as a final partial chunk
                Ok(n) => filled += n,
                Err(_) => {
                    filled = 0;
                    break;
                }
            }
        }
        if filled == 0 {
            break;
        }
        buf.truncate(filled);
        let sample_count = (filled / bytes_per_frame) as u32;
        let pts =
            seek_offset + (chunk_index as f64) * (AUDIO_CHUNK_FRAMES as f64) / (sample_rate as f64);
        if tx
            .send(encode_audio_packet(pts, sample_count, &buf))
            .is_err()
        {
            return;
        }
        chunk_index += 1;
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_session_pipes(
    ffmpeg_path: &Path,
    input_path: &str,
    seek_secs: f64,
    width: u32,
    fps: f64,
    has_audio: bool,
    channels: u16,
    generation: u64,
) -> Result<SessionPipes, String> {
    let mut video_child = spawn_video_pipe(ffmpeg_path, input_path, seek_secs, width, fps)?;
    let Some(video_stdout) = video_child.stdout.take() else {
        kill_child(&mut video_child);
        return Err("Failed to capture video stdout".to_string());
    };
    drain_stderr(video_child.stderr.take());
    let (video_tx, video_rx) = mpsc::sync_channel::<Packet>(VIDEO_CHANNEL_CAP);
    std::thread::spawn(move || read_video_frames(video_stdout, fps, seek_secs, video_tx));

    let (audio_child, audio_rx) = if has_audio {
        // If the audio half fails, the already-running video ffmpeg must not be leaked.
        let mut child = match spawn_audio_pipe(ffmpeg_path, input_path, seek_secs, channels) {
            Ok(child) => child,
            Err(e) => {
                kill_child(&mut video_child);
                return Err(e);
            }
        };
        let Some(audio_stdout) = child.stdout.take() else {
            kill_child(&mut child);
            kill_child(&mut video_child);
            return Err("Failed to capture audio stdout".to_string());
        };
        drain_stderr(child.stderr.take());
        let (tx, rx) = mpsc::sync_channel::<Packet>(AUDIO_CHANNEL_CAP);
        std::thread::spawn(move || {
            read_audio_chunks(audio_stdout, AUDIO_SAMPLE_RATE, channels, seek_secs, tx)
        });
        (Some(child), Some(Arc::new(Mutex::new(rx))))
    } else {
        (None, None)
    };

    Ok(SessionPipes {
        generation,
        video_child,
        audio_child,
        video_rx: Arc::new(Mutex::new(video_rx)),
        audio_rx,
    })
}

fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

// Killing closes each pipe's stdout, so its reader thread hits EOF and drops its sender, and any
// pull still waiting on the old receiver returns "nothing" immediately instead of hanging.
fn kill_pipes(mut pipes: SessionPipes) {
    kill_child(&mut pipes.video_child);
    if let Some(audio_child) = pipes.audio_child.as_mut() {
        kill_child(audio_child);
    }
}

fn find_session(state: &NativePlaybackState, session_id: u64) -> Result<Arc<NativeSession>, String> {
    lock(&state.sessions)
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "Unknown playback session".to_string())
}

// Waits (bounded) for the next packet on a blocking-pool thread - never the UI thread, and never
// one of the shared async workers every other command needs.
async fn pull_packet(rx: Option<PacketRx>) -> Result<Response, String> {
    let Some(rx) = rx else {
        return Ok(Response::new(Vec::new()));
    };
    let packet = tauri::async_runtime::spawn_blocking(move || {
        lock(&rx)
            .recv_timeout(Duration::from_millis(PULL_TIMEOUT_MS))
            .ok()
    })
    .await
    .map_err(|e| format!("Playback worker failed: {}", e))?;
    // Timed out (nothing new yet) or disconnected (EOF) - same "try again or stop" signal to the
    // caller: an empty body.
    Ok(Response::new(packet.unwrap_or_default()))
}

#[tauri::command]
pub async fn start_native_playback(
    app_handle: AppHandle,
    state: State<'_, NativePlaybackState>,
    input_path: String,
    start_time: Option<f64>,
) -> Result<PlaybackSessionInfo, String> {
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let ffprobe_path = get_ffprobe_path(&app_handle)?;
    let seek = start_time.unwrap_or(0.0);

    let (session, duration, out_height) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let probe = probe_media(&ffprobe_path, &input_path)?;

            let out_width = probe.width.min(MAX_WIDTH);
            let out_height = if probe.width > 0 {
                (((probe.height as f64) * (out_width as f64) / (probe.width as f64)).round()
                    as u32)
                    & !1
            } else {
                probe.height
            };
            let out_fps = probe.fps.min(MAX_FPS);

            let pipes = spawn_session_pipes(
                &ffmpeg_path,
                &input_path,
                seek,
                out_width,
                out_fps,
                probe.has_audio,
                probe.channels,
                0,
            )?;

            let session = NativeSession {
                input_path,
                width: out_width,
                fps: out_fps,
                has_audio: probe.has_audio,
                channels: probe.channels,
                seek_generation: AtomicU64::new(0),
                pipes: Mutex::new(Some(pipes)),
            };
            Ok((session, probe.duration, out_height))
        })
        .await
        .map_err(|e| format!("Playback worker failed: {}", e))??;

    let info = PlaybackSessionInfo {
        session_id: state.next_id.fetch_add(1, Ordering::SeqCst),
        duration,
        width: session.width,
        height: out_height,
        fps: session.fps,
        has_audio: session.has_audio,
        sample_rate: AUDIO_SAMPLE_RATE,
        channels: session.channels,
    };
    lock(&state.sessions).insert(info.session_id, Arc::new(session));
    Ok(info)
}

#[tauri::command]
pub async fn get_next_video_frame(
    state: State<'_, NativePlaybackState>,
    session_id: u64,
) -> Result<Response, String> {
    let session = find_session(&state, session_id)?;
    let rx = lock(&session.pipes).as_ref().map(|p| p.video_rx.clone());
    pull_packet(rx).await
}

#[tauri::command]
pub async fn get_next_audio_chunk(
    state: State<'_, NativePlaybackState>,
    session_id: u64,
) -> Result<Response, String> {
    let session = find_session(&state, session_id)?;
    // None for a source with no audio stream at all - answered with an empty body too.
    let rx = lock(&session.pipes)
        .as_ref()
        .and_then(|p| p.audio_rx.clone());
    pull_packet(rx).await
}

#[tauri::command]
pub async fn seek_native_playback(
    app_handle: AppHandle,
    state: State<'_, NativePlaybackState>,
    session_id: u64,
    time_secs: f64,
) -> Result<(), String> {
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let session = find_session(&state, session_id)?;
    let generation = session.seek_generation.fetch_add(1, Ordering::SeqCst) + 1;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // Spawned with no lock held - pulls on the current pipes carry on meanwhile.
        let fresh = spawn_session_pipes(
            &ffmpeg_path,
            &session.input_path,
            time_secs,
            session.width,
            session.fps,
            session.has_audio,
            session.channels,
            generation,
        )?;
        let to_kill = {
            let mut slot = lock(&session.pipes);
            match slot.as_ref() {
                // Stopped while spawning, or a newer seek already installed its own pipes.
                None => Some(fresh),
                Some(current) if current.generation > generation => Some(fresh),
                Some(_) => slot.replace(fresh),
            }
        };
        if let Some(stale) = to_kill {
            kill_pipes(stale);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Playback worker failed: {}", e))?
}

#[tauri::command]
pub async fn stop_native_playback(
    state: State<'_, NativePlaybackState>,
    session_id: u64,
) -> Result<(), String> {
    let Some(session) = lock(&state.sessions).remove(&session_id) else {
        return Ok(());
    };
    let pipes = lock(&session.pipes).take();
    if let Some(pipes) = pipes {
        tauri::async_runtime::spawn_blocking(move || kill_pipes(pipes))
            .await
            .map_err(|e| format!("Playback worker failed: {}", e))?;
    }
    Ok(())
}

// Called from main.rs's RunEvent::Exit handler - without this, quitting the app mid-playback
// would leave the session's ffmpeg.exe processes running until orphan_guard's job object reaps
// them; killing them here keeps a normal quit tidy on every platform.
pub fn cleanup_all_sessions(state: &NativePlaybackState) {
    let sessions: Vec<_> = lock(&state.sessions).drain().map(|(_, s)| s).collect();
    for session in sessions {
        if let Some(pipes) = lock(&session.pipes).take() {
            kill_pipes(pipes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packets_use_the_layout_the_frontend_parses() {
        let video = encode_video_packet(1.5, &[0xFF, 0xD8, 0xFF, 0xD9]);
        assert_eq!(f64::from_le_bytes(video[..8].try_into().unwrap()), 1.5);
        assert_eq!(&video[8..], &[0xFF, 0xD8, 0xFF, 0xD9]);

        let audio = encode_audio_packet(2.25, 3, &[1, 2, 3, 4]);
        assert_eq!(f64::from_le_bytes(audio[..8].try_into().unwrap()), 2.25);
        assert_eq!(u32::from_le_bytes(audio[8..12].try_into().unwrap()), 3);
        assert_eq!(&audio[12..], &[1, 2, 3, 4]);
    }
}
