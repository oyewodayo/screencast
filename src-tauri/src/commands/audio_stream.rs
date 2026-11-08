// Audio that may be hours long, handled a piece at a time - never a whole file in memory:
//
// - A streaming WAV writer (wav_writer_open / _append / _close / _discard): the Record tab and the
//   bleed remover write as they go. The header is rewritten after every append, so the file on disk
//   is always a valid, playable WAV - a crash mid-take loses nothing already written. Past 4 GB
//   (about 7.7 hours of mono 24-bit at 48 kHz) it closes as RF64, the broadcast standard for long WAVs,
//   from a JUNK chunk reserved up front for exactly that.
// - A range reader (audio_range): any stretch of any file, decoded by ffmpeg to mono 48 kHz float
//   and answered as raw bytes - how the bleed remover reads a long take and its reference a
//   segment at a time.
// - Waveform peaks (audio_peaks): ffmpeg decodes once while the peaks are worked out on the fly at
//   a fixed number per second (sharp when zoomed in, on a five-hour file as on a five-second one),
//   cached on disk by the file's path, size and date so a long file is only ever read once.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::AppHandle;

#[cfg(windows)]
use crate::commands::recording::hide_console_window;
use crate::services::utility::{get_ffmpeg_path, path_to_str};

// ---- WAV writer ---------------------------------------------------------------------------------

// RIFF(12) + JUNK chunk (8 + 28, becomes ds64 for RF64) + fmt chunk (8 + 16) + data header (8).
const DATA_OFFSET: u64 = 12 + 36 + 24 + 8;

pub(crate) struct WavWriter {
    file: File,
    path: PathBuf,
    channels: u16,
    sample_rate: u32,
    bits: u16,
    data_len: u64,
}

impl WavWriter {
    pub(crate) fn create(path: PathBuf, channels: u16, sample_rate: u32, bits: u16) -> Result<Self, String> {
        let file = OpenOptions::new().create(true).write(true).truncate(true).read(true).open(&path).map_err(|e| format!("Couldn't create {}: {e}", path.display()))?;
        let mut w = WavWriter { file, path, channels, sample_rate, bits, data_len: 0 };
        let header = w.header(false);
        w.file.write_all(&header).map_err(|e| format!("Couldn't write the WAV header: {e}"))?;
        Ok(w)
    }

    // The whole header for the data written so far - plain RIFF, or RF64 once it's past 4 GB.
    fn header(&self, rf64: bool) -> Vec<u8> {
        let block = self.channels as u32 * (self.bits as u32 / 8);
        let mut h = Vec::with_capacity(DATA_OFFSET as usize);
        let riff_size = DATA_OFFSET - 8 + self.data_len;
        h.extend_from_slice(if rf64 { b"RF64" } else { b"RIFF" });
        h.extend_from_slice(&(if rf64 { u32::MAX } else { riff_size as u32 }).to_le_bytes());
        h.extend_from_slice(b"WAVE");
        if rf64 {
            h.extend_from_slice(b"ds64");
            h.extend_from_slice(&28u32.to_le_bytes());
            h.extend_from_slice(&riff_size.to_le_bytes());
            h.extend_from_slice(&self.data_len.to_le_bytes());
            h.extend_from_slice(&(self.data_len / block.max(1) as u64).to_le_bytes());
            h.extend_from_slice(&0u32.to_le_bytes()); // no table
        } else {
            h.extend_from_slice(b"JUNK");
            h.extend_from_slice(&28u32.to_le_bytes());
            h.extend_from_slice(&[0u8; 28]);
        }
        h.extend_from_slice(b"fmt ");
        h.extend_from_slice(&16u32.to_le_bytes());
        h.extend_from_slice(&1u16.to_le_bytes()); // PCM
        h.extend_from_slice(&self.channels.to_le_bytes());
        h.extend_from_slice(&self.sample_rate.to_le_bytes());
        h.extend_from_slice(&(self.sample_rate * block).to_le_bytes());
        h.extend_from_slice(&(block as u16).to_le_bytes());
        h.extend_from_slice(&self.bits.to_le_bytes());
        h.extend_from_slice(b"data");
        h.extend_from_slice(&(if rf64 { u32::MAX } else { self.data_len as u32 }).to_le_bytes());
        h
    }

    fn needs_rf64(&self) -> bool {
        DATA_OFFSET - 8 + self.data_len > u32::MAX as u64
    }

    pub(crate) fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        self.file.write_all(bytes).map_err(|e| format!("Couldn't write the recording: {e}"))?;
        self.data_len += bytes.len() as u64;
        // Always a valid file - the sizes follow every append (RF64 as soon as they need to).
        let header = self.header(self.needs_rf64());
        self.file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        self.file.write_all(&header).map_err(|e| format!("Couldn't update the WAV header: {e}"))?;
        Ok(())
    }

    // Closes and deletes the file.
    pub(crate) fn discard(self) {
        let path = self.path.clone();
        drop(self);
        let _ = std::fs::remove_file(path);
    }

    pub(crate) fn finish(mut self) -> Result<PathBuf, String> {
        let header = self.header(self.needs_rf64());
        self.file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        self.file.write_all(&header).map_err(|e| e.to_string())?;
        self.file.sync_all().map_err(|e| format!("Couldn't finish the recording: {e}"))?;
        Ok(self.path)
    }
}

fn writers() -> &'static Mutex<HashMap<u64, WavWriter>> {
    static WRITERS: OnceLock<Mutex<HashMap<u64, WavWriter>>> = OnceLock::new();
    WRITERS.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT_WRITER: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedWriter {
    id: u64,
    path: String,
}

// A new WAV in the library's Voice-overs folder, named "<name> <date time>.wav" (made unique).
#[tauri::command]
pub async fn wav_writer_open(name: String, channels: u16, sample_rate: u32, bits: u16) -> Result<OpenedWriter, String> {
    if !(bits == 16 || bits == 24 || bits == 32) || channels == 0 || sample_rate == 0 {
        return Err("Unsupported WAV format.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = voice_over_path(&name)?;
        let writer = WavWriter::create(path.clone(), channels, sample_rate, bits)?;
        let id = NEXT_WRITER.fetch_add(1, Ordering::Relaxed);
        writers().lock().map_err(|_| "Recording state is unavailable.".to_string())?.insert(id, writer);
        Ok(OpenedWriter { id, path: path_to_str(&path)?.to_string() })
    })
    .await
    .map_err(|e| format!("Couldn't start the file: {e}"))?
}

// A new file in the library's Voice-overs folder: "<name> <date time>.wav", made unique.
pub(crate) fn voice_over_path(name: &str) -> Result<PathBuf, String> {
    let dir = crate::services::utility::briefcast_dir()?.join("Voice-overs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the Voice-overs folder: {e}"))?;
    let clean: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '-' } else { c }).collect();
    let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
    let mut path = dir.join(format!("{clean} {stamp}.wav"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{clean} {stamp} ({n}).wav"));
        n += 1;
    }
    Ok(path)
}

// More PCM (already in the file's own sample format) - the raw request body, id in a header.
#[tauri::command]
pub async fn wav_writer_append(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(_) => return Err("Audio arrived as JSON rather than raw bytes.".to_string()),
    };
    let id: u64 = request
        .headers()
        .get("x-writer-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("Which file to write to wasn't said.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut map = writers().lock().map_err(|_| "Recording state is unavailable.".to_string())?;
        let writer = map.get_mut(&id).ok_or("That file is already closed.")?;
        writer.append(&bytes)
    })
    .await
    .map_err(|e| format!("Couldn't write: {e}"))?
}

#[tauri::command]
pub async fn wav_writer_close(id: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let writer = writers().lock().map_err(|_| "Recording state is unavailable.".to_string())?.remove(&id).ok_or("That file is already closed.")?;
        let path = writer.finish()?;
        path_to_str(&path).map(|s| s.to_string())
    })
    .await
    .map_err(|e| format!("Couldn't finish the file: {e}"))?
}

// Closes and deletes - a take too short to keep, a cancelled run.
#[tauri::command]
pub async fn wav_writer_discard(id: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(writer) = writers().lock().map_err(|_| "Recording state is unavailable.".to_string())?.remove(&id) {
            let path = writer.path.clone();
            drop(writer);
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Couldn't discard the file: {e}"))?
}

// ---- Reading ------------------------------------------------------------------------------------

fn ffmpeg_pcm(ffmpeg: &Path, path: &str, start: Option<f64>, seconds: Option<f64>, rate: u32) -> Command {
    let mut cmd = Command::new(ffmpeg);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.args(["-hide_banner", "-nostdin", "-v", "error"]);
    if let Some(s) = start.filter(|s| *s > 0.0) {
        cmd.args(["-ss", &format!("{s:.6}")]);
    }
    if let Some(t) = seconds {
        cmd.args(["-t", &format!("{t:.6}")]);
    }
    cmd.args(["-i", path, "-vn", "-ac", "1", "-ar", &rate.to_string(), "-f", "f32le", "pipe:1"]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd
}

// `seconds` of `path` from `start`, mono 48 kHz float little-endian - padded with silence where the
// file ends early, so a caller always gets exactly the length it asked for.
#[tauri::command]
pub async fn audio_range(app_handle: AppHandle, path: String, start: f64, seconds: f64) -> Result<tauri::ipc::Response, String> {
    if !(start.is_finite() && seconds.is_finite() && seconds > 0.0) {
        return Err("Nothing to read.".to_string());
    }
    let ffmpeg = get_ffmpeg_path(&app_handle)?;
    tauri::async_runtime::spawn_blocking(move || read_range(&ffmpeg, &path, start, seconds).map(tauri::ipc::Response::new))
        .await
        .map_err(|e| format!("Read task failed: {e}"))?
}

// audio_range's work: the raw little-endian f32 bytes, exactly `seconds` long.
pub(crate) fn read_range(ffmpeg: &Path, path: &str, start: f64, seconds: f64) -> Result<Vec<u8>, String> {
    let want = (seconds * 48000.0).round() as usize * 4;
    let out = ffmpeg_pcm(ffmpeg, path, Some(start.max(0.0)), Some(seconds), 48000).output().map_err(|e| format!("Failed to start ffmpeg: {e}"))?;
    if !out.status.success() && out.stdout.is_empty() {
        let reason = String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("unknown error").to_string();
        return Err(format!("Couldn't read the audio: {reason}"));
    }
    let mut bytes = out.stdout;
    bytes.resize(want, 0);
    Ok(bytes)
}

// Peak level per bucket from a float sample stream, `per_bucket` samples each.
fn peaks_from<R: Read>(mut stream: R, per_bucket: usize) -> std::io::Result<Vec<f32>> {
    let mut peaks = Vec::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut carry: Vec<u8> = Vec::new();
    let mut current = 0f32;
    let mut count = 0usize;
    loop {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / 4 * 4;
        for c in carry[..whole].chunks_exact(4) {
            let v = f32::from_le_bytes([c[0], c[1], c[2], c[3]]).abs();
            if v > current {
                current = v;
            }
            count += 1;
            if count == per_bucket {
                peaks.push(current.min(1.0));
                current = 0.0;
                count = 0;
            }
        }
        carry.drain(..whole);
    }
    if count > 0 {
        peaks.push(current.min(1.0));
    }
    Ok(peaks)
}

pub const PEAKS_PER_SECOND: u32 = 50;
const PEAKS_RATE: u32 = 8000;

// The file's peaks, PEAKS_PER_SECOND of them a second, as little-endian f32 - from the disk cache
// when this file (same size, same date) has been read before.
#[tauri::command]
pub async fn audio_peaks(app_handle: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    use std::hash::{Hash, Hasher};
    let ffmpeg = get_ffmpeg_path(&app_handle)?;
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        path.hash(&mut hasher);
        meta.len().hash(&mut hasher);
        meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).hash(&mut hasher);
        PEAKS_PER_SECOND.hash(&mut hasher);
        let dir = std::env::temp_dir().join("briefcast_preview_cache").join("peaks_v1");
        let cached = dir.join(format!("{:016x}.f32", hasher.finish()));
        if let Ok(bytes) = std::fs::read(&cached) {
            return Ok(tauri::ipc::Response::new(bytes));
        }
        let mut child = ffmpeg_pcm(&ffmpeg, &path, None, None, PEAKS_RATE).stderr(Stdio::null()).spawn().map_err(|e| format!("Failed to start ffmpeg: {e}"))?;
        let stdout = child.stdout.take().ok_or("ffmpeg gave no output")?;
        let peaks = peaks_from(stdout, (PEAKS_RATE / PEAKS_PER_SECOND) as usize).map_err(|e| format!("Couldn't read the audio: {e}"))?;
        let _ = child.wait();
        let bytes: Vec<u8> = peaks.iter().flat_map(|p| p.to_le_bytes()).collect();
        if !bytes.is_empty() {
            let _ = std::fs::create_dir_all(&dir);
            let partial = cached.with_extension("partial");
            if std::fs::write(&partial, &bytes).is_ok() {
                let _ = std::fs::rename(&partial, &cached);
            }
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| format!("Peaks task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("briefcast_test_{}_{name}", std::process::id()))
    }

    #[test]
    fn a_wav_is_valid_after_every_append() {
        let path = temp("valid.wav");
        let mut w = WavWriter::create(path.clone(), 1, 48000, 24).unwrap();
        w.append(&[1, 2, 3, 4, 5, 6]).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize, bytes.len() - 8);
        assert_eq!(&bytes[48..52], b"fmt ");
        assert_eq!(&bytes[72..76], b"data");
        assert_eq!(u32::from_le_bytes(bytes[76..80].try_into().unwrap()), 6);
        assert_eq!(&bytes[80..86], &[1, 2, 3, 4, 5, 6]);
        w.finish().unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn past_four_gigabytes_the_header_becomes_rf64() {
        let path = temp("rf64.wav");
        let mut w = WavWriter::create(path.clone(), 1, 48000, 24).unwrap();
        // Pretend 5 GB are already written - the header's job is only to describe them.
        w.data_len = 5_000_000_000;
        let h = w.header(w.needs_rf64());
        assert_eq!(&h[0..4], b"RF64");
        assert_eq!(&h[12..16], b"ds64");
        assert_eq!(u64::from_le_bytes(h[28..36].try_into().unwrap()), 5_000_000_000);
        assert_eq!(u64::from_le_bytes(h[36..44].try_into().unwrap()), 5_000_000_000 / 3);
        assert_eq!(h.len() as u64, DATA_OFFSET);
        drop(w);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn peaks_are_per_bucket_maxima_across_reads() {
        let samples: Vec<f32> = vec![0.1, -0.5, 0.2, 0.3, -0.9, 0.0, 0.25];
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let peaks = peaks_from(std::io::Cursor::new(bytes), 3).unwrap();
        assert_eq!(peaks, vec![0.5, 0.9, 0.25]);
    }
}
