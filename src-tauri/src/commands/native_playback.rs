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
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
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
    sessions: Mutex<HashMap<u64, NativeSession>>,
    next_id: AtomicU64,
}

struct NativeSession {
    video_child: Child,
    audio_child: Option<Child>,
    video_rx: Receiver<VideoFrame>,
    audio_rx: Option<Receiver<AudioChunk>>,
    input_path: String,
    // width/fps/channels are re-used to respawn matching pipes on seek; height and the audio
    // sample rate aren't needed again after being reported once in PlaybackSessionInfo (height
    // is derived from width, sample rate is always the AUDIO_SAMPLE_RATE constant), so they're
    // not stored here.
    width: u32,
    fps: f64,
    channels: u16,
}

#[derive(Serialize, Clone)]
pub struct VideoFrame {
    data_base64: String,
    pts: f64,
}

#[derive(Serialize, Clone)]
pub struct AudioChunk {
    data_base64: String,
    pts: f64,
    sample_count: u32,
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
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        input_path,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);

    let output = cmd.output().map_err(|e| format!("Failed to run ffprobe: {}", e))?;
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

    Ok(ProbeInfo { duration, width, height, fps, has_audio, channels })
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
        "-ss", &seek_secs.to_string(),
        "-i", input_path,
        "-an",
        "-vf", &format!("scale='min({},iw)':-2", max_width),
        "-r", &fps.to_string(),
        "-q:v", MJPEG_QUALITY,
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "pipe:1",
    ]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.spawn().map_err(|e| format!("Failed to start video decode: {}", e))
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
        "-ss", &seek_secs.to_string(),
        "-i", input_path,
        "-vn",
        "-f", "s16le",
        "-ar", &AUDIO_SAMPLE_RATE.to_string(),
        "-ac", &channels.to_string(),
        "pipe:1",
    ]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.spawn().map_err(|e| format!("Failed to start audio decode: {}", e))
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
            for line in BufReader::new(stderr).lines().flatten() {
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
fn read_video_frames(mut stdout: ChildStdout, fps: f64, seek_offset: f64, tx: SyncSender<VideoFrame>) {
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
            let Some(soi) = find_marker(&buffer, 0xFF, 0xD8) else { break };
            let Some(eoi_rel) = find_marker(&buffer[soi + 2..], 0xFF, 0xD9) else { break };
            let eoi = soi + 2 + eoi_rel;
            let frame_end = eoi + 2;

            let pts = seek_offset + (frame_index as f64) / fps;
            let data_base64 = BASE64.encode(&buffer[soi..frame_end]);

            if tx.send(VideoFrame { data_base64, pts }).is_err() {
                return; // receiver gone (session stopped/seeked) - stop decoding, let the process exit
            }
            frame_index += 1;
            buffer.drain(..frame_end);
        }
    }
}

// Reads fixed-size PCM chunks (~170ms each) rather than forwarding every OS-level read() as its
// own chunk, so chunk size/timing is predictable regardless of how the pipe happens to buffer.
fn read_audio_chunks(mut stdout: ChildStdout, sample_rate: u32, channels: u16, seek_offset: f64, tx: SyncSender<AudioChunk>) {
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
        let pts = seek_offset + (chunk_index as f64) * (AUDIO_CHUNK_FRAMES as f64) / (sample_rate as f64);
        let data_base64 = BASE64.encode(&buf);

        if tx.send(AudioChunk { data_base64, pts, sample_count }).is_err() {
            return;
        }
        chunk_index += 1;
    }
}

fn spawn_session_pipes(
    ffmpeg_path: &Path,
    input_path: &str,
    seek_secs: f64,
    width: u32,
    fps: f64,
    has_audio: bool,
    channels: u16,
) -> Result<(Child, Receiver<VideoFrame>, Option<Child>, Option<Receiver<AudioChunk>>), String> {
    let mut video_child = spawn_video_pipe(ffmpeg_path, input_path, seek_secs, width, fps)?;
    let video_stdout = video_child.stdout.take().ok_or("Failed to capture video stdout")?;
    drain_stderr(video_child.stderr.take());
    let (video_tx, video_rx) = mpsc::sync_channel::<VideoFrame>(VIDEO_CHANNEL_CAP);
    std::thread::spawn(move || read_video_frames(video_stdout, fps, seek_secs, video_tx));

    let (audio_child, audio_rx) = if has_audio {
        let mut child = spawn_audio_pipe(ffmpeg_path, input_path, seek_secs, channels)?;
        let audio_stdout = child.stdout.take().ok_or("Failed to capture audio stdout")?;
        drain_stderr(child.stderr.take());
        let (tx, rx) = mpsc::sync_channel::<AudioChunk>(AUDIO_CHANNEL_CAP);
        std::thread::spawn(move || read_audio_chunks(audio_stdout, AUDIO_SAMPLE_RATE, channels, seek_secs, tx));
        (Some(child), Some(rx))
    } else {
        (None, None)
    };

    Ok((video_child, video_rx, audio_child, audio_rx))
}

fn kill_session_children(session: &mut NativeSession) {
    let _ = session.video_child.kill();
    let _ = session.video_child.wait();
    if let Some(audio_child) = session.audio_child.as_mut() {
        let _ = audio_child.kill();
        let _ = audio_child.wait();
    }
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

    let probe = probe_media(&ffprobe_path, &input_path)?;

    let out_width = probe.width.min(MAX_WIDTH);
    let out_height = if probe.width > 0 {
        (((probe.height as f64) * (out_width as f64) / (probe.width as f64)).round() as u32) & !1
    } else {
        probe.height
    };
    let out_fps = probe.fps.min(MAX_FPS);

    let (video_child, video_rx, audio_child, audio_rx) = spawn_session_pipes(
        &ffmpeg_path, &input_path, seek, out_width, out_fps, probe.has_audio, probe.channels,
    )?;

    let session_id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let session = NativeSession {
        video_child,
        audio_child,
        video_rx,
        audio_rx,
        input_path: input_path.clone(),
        width: out_width,
        fps: out_fps,
        channels: probe.channels,
    };

    state.sessions.lock().unwrap().insert(session_id, session);

    Ok(PlaybackSessionInfo {
        session_id,
        duration: probe.duration,
        width: out_width,
        height: out_height,
        fps: out_fps,
        has_audio: probe.has_audio,
        sample_rate: AUDIO_SAMPLE_RATE,
        channels: probe.channels,
    })
}

#[tauri::command]
pub fn get_next_video_frame(state: State<'_, NativePlaybackState>, session_id: u64) -> Result<Option<VideoFrame>, String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&session_id).ok_or("Unknown playback session")?;
    match session.video_rx.recv_timeout(std::time::Duration::from_millis(PULL_TIMEOUT_MS)) {
        Ok(frame) => Ok(Some(frame)),
        Err(_) => Ok(None), // timed out (nothing new yet) or disconnected (EOF) - same "try again or stop" signal to the caller
    }
}

#[tauri::command]
pub fn get_next_audio_chunk(state: State<'_, NativePlaybackState>, session_id: u64) -> Result<Option<AudioChunk>, String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&session_id).ok_or("Unknown playback session")?;
    let Some(audio_rx) = session.audio_rx.as_ref() else {
        return Ok(None); // source has no audio stream at all
    };
    match audio_rx.recv_timeout(std::time::Duration::from_millis(PULL_TIMEOUT_MS)) {
        Ok(chunk) => Ok(Some(chunk)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn seek_native_playback(
    app_handle: AppHandle,
    state: State<'_, NativePlaybackState>,
    session_id: u64,
    time_secs: f64,
) -> Result<(), String> {
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;

    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(&session_id).ok_or("Unknown playback session")?;

    kill_session_children(session);

    let has_audio = session.audio_rx.is_some();
    let (video_child, video_rx, audio_child, audio_rx) = spawn_session_pipes(
        &ffmpeg_path, &session.input_path, time_secs, session.width, session.fps, has_audio, session.channels,
    )?;

    session.video_child = video_child;
    session.video_rx = video_rx;
    session.audio_child = audio_child;
    session.audio_rx = audio_rx;

    Ok(())
}

#[tauri::command]
pub fn stop_native_playback(state: State<'_, NativePlaybackState>, session_id: u64) -> Result<(), String> {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&session_id) {
        kill_session_children(&mut session);
    }
    Ok(())
}

// Called from main.rs's RunEvent::Exit handler - without this, quitting the app mid-playback
// would orphan the session's ffmpeg.exe processes (same residual risk already accepted for the
// main recording pipeline's AppState, not a new gap introduced here).
pub fn cleanup_all_sessions(state: &NativePlaybackState) {
    let mut sessions = state.sessions.lock().unwrap();
    for (_, mut session) in sessions.drain() {
        kill_session_children(&mut session);
    }
}
