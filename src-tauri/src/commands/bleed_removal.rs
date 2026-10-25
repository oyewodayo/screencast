// "Remove playback bleed" on one audio track (services/bleed.rs does the work) - for a take of any
// length, without ever holding it whole: a stretch at a time, the take read from its file
// (audio_stream::read_range) and what the timeline played over that same stretch rendered beside it
// (conversion::mix_timeline_pcm), the cleaned take written straight to a new 24-bit WAV in the
// Voice-overs folder. The track's own file is never touched - the result is a new file it plays
// instead, and the original stays to go back to.
//
// Progress goes out as "audio-job-progress" with key "bleed:<job>"; cancel_bleed(job) stops it
// between stretches and the half-written file is deleted.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::audio_stream::{read_range, voice_over_path, WavWriter};
use crate::commands::conversion::{emit_job_progress, mix_timeline_pcm, probe_has_audio, TimelineAudioPiece};
use crate::services::bleed::{self, DelaySegment, Strength};
use crate::services::utility::{get_ffmpeg_path, get_ffprobe_path, path_to_str};

const RATE: f64 = 48000.0;

fn running() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BleedRemoval {
    // The cleaned take's file, or None when there was no bleed to remove.
    path: Option<String>,
    segments: Vec<DelaySegment>,
    regions: Vec<[f64; 2]>,
    // None for "no bleed at all" (-infinity doesn't survive JSON).
    bleed_db: Option<f64>,
    removed_db: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BleedRequest {
    job: String,
    // The take as recorded, its length (seconds), and a name for the new file.
    source: String,
    length: f64,
    name: String,
    strength: Strength,
    // Everything that played over the take, placed in the take file's own seconds.
    pieces: Vec<TimelineAudioPiece>,
}

// The pieces sounding over [from, from + seconds), re-placed relative to `from`.
fn pieces_within(pieces: &[TimelineAudioPiece], from: f64, seconds: f64) -> Vec<TimelineAudioPiece> {
    let to = from + seconds;
    pieces
        .iter()
        .filter_map(|p| {
            let speed = if p.speed.is_finite() && p.speed > 0.0 { p.speed } else { 1.0 };
            let end = p.at + (p.source_end - p.source_start) / speed;
            let (a, b) = (p.at.max(from), end.min(to));
            (b - a >= 0.01).then(|| TimelineAudioPiece {
                source_path: p.source_path.clone(),
                source_start: p.source_start + (a - p.at) * speed,
                source_end: p.source_start + (b - p.at) * speed,
                at: a - from,
                speed,
                volume: p.volume,
            })
        })
        .collect()
}

fn floats(bytes: Vec<u8>) -> Vec<f32> {
    bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn pcm24(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 3);
    for &v in samples {
        let i = (v.clamp(-1.0, 1.0) as f64 * 8_388_607.0).round() as i32;
        out.extend_from_slice(&i.to_le_bytes()[..3]);
    }
    out
}

#[tauri::command]
pub async fn remove_bleed(app_handle: AppHandle, request: BleedRequest) -> Result<BleedRemoval, String> {
    if !(request.length.is_finite() && request.length > 0.0) {
        return Err("The track has no length.".to_string());
    }
    let ffmpeg = get_ffmpeg_path(&app_handle)?;
    let ffprobe = get_ffprobe_path(&app_handle)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    running().lock().map_err(|_| "Bleed state is unavailable.")?.insert(request.job.clone(), cancelled.clone());
    let job = request.job.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<BleedRemoval, String> {
        let key = format!("bleed:{}", request.job);
        // Which files have sound, asked once rather than once a stretch.
        let sounding: HashSet<String> = request
            .pieces
            .iter()
            .map(|p| p.source_path.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .filter(|p| std::path::Path::new(p).exists() && probe_has_audio(&ffprobe, p))
            .collect();
        let has_audio = |p: &str| sounding.contains(p);
        let read = |from: f64, seconds: f64| -> Result<(Vec<f32>, Vec<f32>), String> {
            let pieces = pieces_within(&request.pieces, from, seconds);
            let (take, reference) = std::thread::scope(|s| {
                let take = s.spawn(|| read_range(&ffmpeg, &request.source, from, seconds));
                let reference = mix_timeline_pcm(&ffmpeg, &pieces, seconds, &has_audio);
                (take.join().unwrap_or_else(|_| Err("Reading the take failed.".to_string())), reference)
            });
            Ok((floats(take?), floats(reference?)))
        };
        let mut writer = Some(WavWriter::create(voice_over_path(&format!("{} (bleed removed)", request.name))?, 1, RATE as u32, 24)?);
        let outcome = bleed::run(
            request.length,
            RATE,
            request.strength,
            &read,
            &mut |samples| writer.as_mut().map_or(Ok(()), |w| w.append(&pcm24(samples))),
            &|f| emit_job_progress(&app_handle, &key, (f * 0.995).min(0.995)),
            &cancelled,
        );
        let writer = writer.take().expect("writer");
        let outcome = match outcome {
            Ok(o) if o.found => o,
            other => {
                writer.discard();
                emit_job_progress(&app_handle, &key, 1.0);
                return other.map(|_| BleedRemoval { path: None, segments: Vec::new(), regions: Vec::new(), bleed_db: None, removed_db: 0.0 });
            }
        };
        let path = writer.finish()?;
        emit_job_progress(&app_handle, &key, 1.0);
        let bleed_db = outcome.sums.bleed_db();
        Ok(BleedRemoval {
            path: Some(path_to_str(&path)?.to_string()),
            segments: outcome.segments,
            regions: outcome.regions,
            bleed_db: bleed_db.is_finite().then_some(bleed_db),
            removed_db: outcome.sums.removed_db(),
        })
    })
    .await
    .map_err(|e| format!("Bleed removal failed: {e}"));
    if let Ok(mut map) = running().lock() {
        map.remove(&job);
    }
    result?
}

#[tauri::command]
pub fn cancel_bleed(job: String) {
    if let Some(flag) = running().lock().ok().and_then(|m| m.get(&job).cloned()) {
        flag.store(true, Ordering::SeqCst);
    }
}
