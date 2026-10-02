// commands/recording/assembly.rs
//
// Assembles a Windows screen recording's final file from its parts, in exact sync.
//
// While recording, ffmpeg captures only pictures (screen, plus a camera when one is baked in),
// into an intermediate file; the microphone and system audio are captured by
// services/audio_capture.rs into WAVs pinned to the QPC clock. On stop, one ffmpeg pass stream-copies
// the video into the final container and lays the audio against it.
//
// Why: an ffmpeg that captures the mic itself rebases mic and screen to zero independently, so
// sync came down to device start-up order - measured 0.3s to 3.3s off depending on the mode. Here
// both sides are timed against QPC:
//   - the audio by WASAPI's per-packet capture timestamps (audio_capture.rs);
//   - the video by a metadata filter that logs every frame's pts to stderr as it leaves the capture
//     source. FrameTiming stamps each line with QPC on arrival; the smallest (arrival - pts) seen is
//     the offset between the two clocks. Measured flat to under a millisecond over a recording
//     (212.1-212.9ms in one run), since a frame can be logged late but never early.
//
// Pauses suspend ffmpeg, and Desktop Duplication timestamps frames by the wall clock, so a pause
// shows up as a gap in the video's pts. Segments turns those gaps into the stretches to keep: the
// video's timestamps are shifted to close them (the setts bitstream filter - no re-encode) and the
// audio is cut over exactly the same wall-clock intervals, so audio and video can't come out of a
// pause misaligned. The same mapping places click-tracking events and the phone camera.
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::services::audio_capture::{self, AudioCapture, AudioTimeline, SAMPLE_RATE};

// Drift smaller than this isn't worth a resample (~36ms over an hour).
const DRIFT_PPM_THRESHOLD: f64 = 10.0;

// Timing of the frames the screen capture produced, gathered from ffmpeg's stderr as it records.
#[derive(Default)]
pub(crate) struct FrameTiming {
    frame_secs: f64,
    // How long after a frame is captured it reaches ffmpeg's log - subtracted so frames are placed
    // at the moment they show, not the moment they arrive (see CAMERA_LATENCY_HNS).
    latency_hns: i64,
    // Smallest (QPC arrival - pts) seen, in 100ns units: the QPC time of pts 0.
    offset_hns: Option<i64>,
    first_pts: Option<f64>,
    last_pts: Option<f64>,
    // Every hole in the frame sequence, (last pts before, first pts after). Only the ones a pause
    // caused are cut (see segments); a stall - the system briefly too busy to deliver frames - is
    // kept, holding the last frame, with its audio intact.
    gaps: Vec<(f64, f64)>,
    // ffmpeg's other output, for diagnosing a failed capture.
    tail: VecDeque<String>,
}

impl FrameTiming {
    fn new(framerate: i32, latency_hns: i64) -> Self {
        FrameTiming {
            frame_secs: 1.0 / framerate.max(1) as f64,
            latency_hns,
            ..Default::default()
        }
    }

    fn frame(&mut self, pts: f64, arrival_hns: i64) {
        let offset = arrival_hns - self.latency_hns - (pts * 1e7).round() as i64;
        self.offset_hns = Some(self.offset_hns.map_or(offset, |o| o.min(offset)));
        match self.last_pts {
            None => self.first_pts = Some(pts),
            // Out-of-order or duplicate lines don't move the end backwards.
            Some(last) if pts <= last => return,
            Some(last) if pts - last > 2.5 * self.frame_secs => self.gaps.push((last, pts)),
            _ => {}
        }
        self.last_pts = Some(pts);
    }

    fn other_line(&mut self, line: String) {
        if self.tail.len() >= 40 {
            self.tail.pop_front();
        }
        self.tail.push_back(line);
    }

    // The stretches to keep: everything from the first frame to the last, minus the holes that
    // overlap a pause (`pauses`, QPC 100ns intervals from pause_recording/resume_recording).
    pub(crate) fn segments(&self, pauses: &[(i64, i64)]) -> Option<Segments> {
        let offset_hns = self.offset_hns?;
        let (first, last) = (self.first_pts?, self.last_pts?);
        let to_pts = |hns: i64| (hns - offset_hns) as f64 / 1e7;
        let mut kept = Vec::new();
        let mut start = first;
        for &(before, after) in &self.gaps {
            let paused = pauses
                .iter()
                .any(|&(p0, p1)| before < to_pts(p1) && after > to_pts(p0));
            if paused {
                kept.push((start, before + self.frame_secs));
                start = after;
            }
        }
        kept.push((start, last + self.frame_secs));
        Some(Segments { offset_hns, kept })
    }

    pub(crate) fn offset_hns(&self) -> Option<i64> {
        self.offset_hns
    }

    pub(crate) fn diagnostics(&self) -> String {
        self.tail.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

// Capture latency of the screen: Desktop Duplication hands over a frame as it's composed, so the
// arrival time already is the display time.
pub(crate) const SCREEN_LATENCY_HNS: i64 = 0;
// Capture latency of a USB webcam - light on the sensor to the frame reaching ffmpeg (exposure,
// USB transfer, decode). Measured on an integrated webcam by lighting the room with a full-screen
// flash and timing when the camera's picture brightened: frames arrived 90-120ms after the flip,
// the screen itself lighting up 20-40ms after it. Without this the face trails the voice by that
// much - visibly, at the lips. Checked end to end: with 75ms the face still landed ~30ms after the
// light; 100ms puts it on it.
pub(crate) const CAMERA_LATENCY_HNS: i64 = 1_000_000;

// The metadata filter chain that makes ffmpeg log every frame's pts (see FrameTiming). It prints
// only frames carrying the key, so it adds one first.
pub(crate) const FRAME_LOG_FILTER: &str =
    "metadata=mode=add:key=bc_frame:value=1,metadata=mode=print:key=bc_frame";

// Drains ffmpeg's stderr on its own thread for as long as ffmpeg runs (a pipe nobody reads would
// eventually block ffmpeg), feeding frame lines into the returned FrameTiming.
pub(crate) fn spawn_frame_timing(
    stderr: impl Read + Send + 'static,
    framerate: i32,
    latency_hns: i64,
) -> Arc<Mutex<FrameTiming>> {
    let timing = Arc::new(Mutex::new(FrameTiming::new(framerate, latency_hns)));
    let shared = timing.clone();
    let _ = std::thread::Builder::new()
        .name("frame-timing".into())
        .spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                // Stamped before anything else so parsing can't add to the measured latency.
                let arrival = audio_capture::now_hns();
                let text = String::from_utf8_lossy(&line);
                let mut t = shared.lock().unwrap_or_else(|p| p.into_inner());
                match parse_frame_pts(&text) {
                    Some(pts) => t.frame(pts, arrival),
                    None if text.contains("bc_frame=") => {}
                    None => t.other_line(text.trim_end().to_string()),
                }
            }
        });
    timing
}

fn parse_frame_pts(line: &str) -> Option<f64> {
    if !line.contains("Parsed_metadata") {
        return None;
    }
    let rest = &line[line.find("pts_time:")? + 9..];
    rest.split_whitespace().next()?.parse().ok()
}

// The stretches of the screen capture's own timeline (pts seconds) that make it into the final
// file, and where that timeline sits on the QPC clock.
#[derive(Clone, Debug)]
pub(crate) struct Segments {
    offset_hns: i64,
    kept: Vec<(f64, f64)>,
}

impl Segments {
    // Where kept segment `k` starts in the final file.
    fn output_start(&self, k: usize) -> f64 {
        self.kept[..k].iter().map(|(a, b)| b - a).sum()
    }

    pub(crate) fn duration(&self) -> f64 {
        self.output_start(self.kept.len())
    }

    // QPC time (100ns) of the final file's t=0.
    pub(crate) fn start_hns(&self) -> i64 {
        self.offset_hns + (self.kept[0].0 * 1e7).round() as i64
    }

    // A QPC instant's position in the final file, or None when it falls in a cut stretch or
    // outside the recording.
    pub(crate) fn output_time(&self, hns: i64) -> Option<f64> {
        let pts = (hns - self.offset_hns) as f64 / 1e7;
        self.kept
            .iter()
            .enumerate()
            .find(|(_, (a, b))| pts >= *a && pts < *b)
            .map(|(k, (a, _))| self.output_start(k) + (pts - a))
    }

    // setts expression moving `var` (PTS or DTS) from capture time to final-file time: each
    // segment shifted back by its start minus where it lands. Encoders here run without B-frames
    // (see ScreenSource::codec_args), so DTS shifts exactly like PTS.
    fn setts_expr(&self, var: &str) -> String {
        let shift = |k: usize| self.kept[k].0 - self.output_start(k);
        let mut expr = format!("{:.6}", shift(0));
        for k in 1..self.kept.len() {
            // Half a frame early, so a frame stamped a hair before the boundary still moves with
            // its segment.
            let boundary = self.kept[k].0 - 0.004;
            expr.push_str(&format!(
                "+{:.6}*gte({}*TB,{:.6})",
                shift(k) - shift(k - 1),
                var,
                boundary
            ));
        }
        format!("{}-({})/TB", var, expr)
    }

    // Filter chain taking audio input `input` (captured on `timeline`) to the final file's
    // timeline: drift-corrected, cut to the kept segments, padded where the audio didn't cover
    // them. Ends in `[label]`.
    fn audio_chain(&self, input: usize, timeline: &AudioTimeline, extra: &str, label: &str) -> String {
        let mut pre = Vec::new();
        let ppm = (timeline.effective_rate / SAMPLE_RATE as f64 - 1.0) * 1e6;
        if ppm.abs() > DRIFT_PPM_THRESHOLD {
            // Re-declare the samples at the rate the device really ran at, then resample back:
            // afterwards one second of audio is one second of QPC time.
            pre.push(format!("asetrate={}", timeline.effective_rate.round() as i64));
            pre.push(format!("aresample={}", SAMPLE_RATE));
        }
        // Each segment's position in the audio, in seconds from its first sample.
        let starts: Vec<(f64, f64)> = self
            .kept
            .iter()
            .map(|(a, b)| {
                let s = (self.offset_hns + (a * 1e7) as i64 - timeline.first_sample_hns) as f64 / 1e7;
                (s, s + (b - a))
            })
            .collect();
        // Audio that began after the video did gets silence in front of it first.
        let lead = starts.iter().map(|(s, _)| -s).fold(0.0f64, f64::max);
        if lead > 0.0005 {
            pre.push(format!("adelay=delays={}:all=1", (lead * 1000.0).round() as i64));
        }
        // Silence past the audio's end, so every segment is full length.
        pre.push("apad".to_string());

        let n = starts.len();
        let mut chain = format!("[{}:a]{}", input, pre.join(","));
        if n == 1 {
            let (s, e) = starts[0];
            chain.push_str(&format!(
                ",atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS",
                s + lead,
                e + lead
            ));
        } else {
            chain.push_str(&format!(",asplit={}", n));
            for k in 0..n {
                chain.push_str(&format!("[{}s{}]", label, k));
            }
            for (k, (s, e)) in starts.iter().enumerate() {
                chain.push_str(&format!(
                    ";[{l}s{k}]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS[{l}t{k}]",
                    s + lead,
                    e + lead,
                    l = label,
                    k = k
                ));
            }
            chain.push(';');
            for k in 0..n {
                chain.push_str(&format!("[{}t{}]", label, k));
            }
            chain.push_str(&format!("concat=n={}:v=0:a=1", n));
        }
        if !extra.is_empty() {
            chain.push(',');
            chain.push_str(extra);
        }
        chain.push_str(&format!("[{}]", label));
        chain
    }
}

// Everything a screen recording in progress needs at stop to become its final file.
pub(crate) struct Assembly {
    // The picture-only intermediate ffmpeg writes (see intermediate_paths).
    pub video_path: PathBuf,
    pub timing: Option<Arc<Mutex<FrameTiming>>>,
    pub mic: Option<AudioCapture>,
    pub system: Option<AudioCapture>,
    // Whether ffmpeg is capturing the mic itself - only when the app's own capture couldn't open
    // it, in which case the intermediate carries that audio and it's kept as is.
    pub video_has_audio: bool,
    // QPC time start_recording began, for re-basing offsets measured from the frontend's own
    // launch timestamp (the phone camera's).
    pub launch_hns: i64,
    // Pauses so far, QPC 100ns (start, end) - only these are cut from the recording.
    pub pauses: Vec<(i64, i64)>,
    // QPC time start_recording returned - the moment the frontend's own recording timer starts,
    // which the view-switch events it logs are measured from.
    pub timer_zero_hns: Option<i64>,
    // The webcam recorded separately for PiP editing, when it is.
    pub camera: Option<CameraSidecar>,
    // Whether the audio gets the studio cleanup at assembly (FormData.enhance_audio).
    pub enhance: bool,
}

// A webcam recorded by its own ffmpeg beside a screen recording (FormData.separate_webcam_capture).
//
// Its own process, not a second output of the screen's: sharing one, ffmpeg paced the screen to
// the camera - measured 16.6 fps of screen against 30 of camera. At stop it's re-timed onto the
// final recording's timeline (webcam_args), so the editor's PiP layer lines up with the screen
// and the voice instead of starting whenever the camera happened to.
pub(crate) struct CameraSidecar {
    pub process: Option<std::process::Child>,
    pub timing: Arc<Mutex<FrameTiming>>,
    // The raw capture, in the temp capture folder.
    pub video_path: PathBuf,
    // The finished `<stem>_webcam.mp4` beside the recording.
    pub final_path: PathBuf,
}

// Where a recording's intermediates live: a temp folder rather than beside the recording, so the
// library never lists half-made files. The final file is written straight to its real path.
pub(crate) fn intermediate_paths(output_path: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join("briefcast-capture");
    let _ = std::fs::create_dir_all(&dir);
    let stem = output_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    (
        dir.join(format!("{}.video.mkv", stem)),
        dir.join(format!("{}.mic.wav", stem)),
        dir.join(format!("{}.system.wav", stem)),
    )
}

// The finished parts of a recording, ready to be assembled.
pub(crate) struct Parts {
    pub video_path: PathBuf,
    pub segments: Segments,
    // The mic, already through the voice chain (services/audio_enhance.rs, pass 1) - its timeline
    // is the raw capture's, since the chain doesn't move audio in time.
    pub mic: Option<AudioTimeline>,
    pub system: Option<AudioTimeline>,
    pub video_has_audio: bool,
    pub mic_gain_db: f64,
    pub system_gain_db: f64,
    // Filtergraph-escaped RNNoise model, for the voice chain applied to video_has_audio's track.
    pub rnnoise_model: Option<String>,
    // Off: the audio is aligned and mixed but otherwise left exactly as captured.
    pub enhance: bool,
}

// ffmpeg arguments producing `output` from `parts`: the video stream-copied with pause gaps closed,
// and every audio source aligned, enhanced and mixed (see services/audio_enhance.rs).
pub(crate) fn assemble_args(parts: &Parts, output: &Path) -> Result<Vec<String>, String> {
    use crate::services::audio_enhance as enhance;
    let ext = output.extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_lowercase();
    let path = |p: &Path| crate::services::utility::path_to_str(p).map(|s| s.to_string());

    let mut args = vec!["-y".to_string(), "-i".to_string(), path(&parts.video_path)?];
    let mut chains = Vec::new();
    let mut voices = Vec::new();
    let mut input = 1;
    if let Some(mic) = &parts.mic {
        args.extend(["-i".to_string(), path(&mic.wav_path)?]);
        chains.push(parts.segments.audio_chain(input, mic, &format!("volume={:.2}dB", parts.mic_gain_db), "mic"));
        voices.push("[mic]".to_string());
        input += 1;
    }
    let system = match &parts.system {
        Some(system) => {
            args.extend(["-i".to_string(), path(&system.wav_path)?]);
            chains.push(parts.segments.audio_chain(input, system, &format!("volume={:.2}dB", parts.system_gain_db), "sys"));
            Some("[sys]")
        }
        None => None,
    };
    if parts.video_has_audio {
        // ffmpeg's own mic capture (the app couldn't open the device): same voice chain, levelled
        // by it rather than measured, since it's processed in this one pass.
        if parts.enhance {
            chains.push(format!(
                "[0:a]aformat=channel_layouts=mono,{}[va]",
                enhance::voice_chain(parts.rnnoise_model.as_deref())
            ));
        } else {
            chains.push("[0:a]anull[va]".to_string());
        }
        voices.push("[va]".to_string());
    }

    let voice = match voices.len() {
        0 => None,
        1 => Some(voices[0].clone()),
        _ => {
            chains.push(format!(
                "{}amix=inputs={}:duration=longest:dropout_transition=0:normalize=0[voice]",
                voices.join(""),
                voices.len()
            ));
            Some("[voice]".to_string())
        }
    };
    let mixed = match (voice, system) {
        (Some(v), Some(s)) if parts.enhance => {
            chains.push(enhance::duck_and_mix(&v, s, "mix"));
            Some("[mix]".to_string())
        }
        (Some(v), Some(s)) => {
            chains.push(format!("{}{}amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mix]", v, s));
            Some("[mix]".to_string())
        }
        (Some(v), None) => Some(v),
        (None, Some(s)) => Some(s.to_string()),
        (None, None) => None,
    };
    if let Some(m) = &mixed {
        let limiter = if parts.enhance { format!("{},", enhance::LIMITER) } else { String::new() };
        chains.push(format!("{}{}aformat=channel_layouts=stereo[aout]", m, limiter));
        args.extend(["-filter_complex".to_string(), chains.join(";")]);
    }

    args.extend(["-map".to_string(), "0:v".to_string()]);
    if mixed.is_some() {
        args.extend(["-map".to_string(), "[aout]".to_string()]);
    }
    let mut bsf = format!(
        "setts=pts='{}':dts='{}'",
        parts.segments.setts_expr("PTS"),
        parts.segments.setts_expr("DTS")
    );
    // Matroska carries H.264 length-prefixed; AVI only takes it with start codes, and refuses the
    // stream copy without this conversion ("h264 bitstream malformed, no startcode found").
    if ext == "avi" {
        bsf.push_str(",h264_mp4toannexb");
    }
    args.extend(["-c:v".to_string(), "copy".to_string(), "-bsf:v".to_string(), bsf]);
    if mixed.is_some() {
        // No -t: it's measured before setts moves the timestamps, so after a pause it cut the end
        // of the picture off. The audio needs no limit - its segments are trimmed to length.
        args.extend(enhance::audio_codec_for(&ext));
    } else if matches!(ext.as_str(), "mp4" | "mov") {
        args.extend(["-movflags".to_string(), "+faststart".to_string()]);
    }
    args.push(path(output)?);
    Ok(args)
}

// ffmpeg arguments re-timing a separately captured webcam (`input`, timed by `camera_offset_hns`
// - its FrameTiming offset) onto the final recording's timeline: the same kept stretches, black
// where the camera hadn't started yet, constant 30fps for the editor's seeking.
pub(crate) fn webcam_args(segments: &Segments, camera_offset_hns: i64, input: &Path, output: &Path) -> Result<Vec<String>, String> {
    let path = |p: &Path| crate::services::utility::path_to_str(p).map(|s| s.to_string());
    let mut chains = Vec::new();
    let n = segments.kept.len();
    chains.push(format!("[0:v]split={}{}", n, (0..n).map(|k| format!("[c{}]", k)).collect::<String>()));
    // How long after the recording's start the camera's first frame came - it's shifted that late,
    // and the fps stage holds its first picture over the gap. (tpad's padding doesn't move the
    // frames after it, which left the whole layer that much early.)
    let mut lead = 0.0f64;
    for (k, (a, b)) in segments.kept.iter().enumerate() {
        let start = (segments.offset_hns + (a * 1e7) as i64 - camera_offset_hns) as f64 / 1e7;
        let len = b - a;
        if k == 0 {
            lead = (-start).max(0.0).min(len);
        }
        let from = start.max(0.0);
        let to = if k == 0 { from + len - lead } else { from + len };
        chains.push(format!(
            "[c{k}]trim=start={:.6}:end={:.6},setpts=PTS-STARTPTS[s{k}]",
            from,
            to,
            k = k
        ));
    }
    chains.push(format!(
        "{}concat=n={}:v=1:a=0,setpts=PTS+{:.6}/TB,fps=30:start_time=0,tpad=stop_mode=clone:stop_duration=1,trim=duration={:.6}[cam]",
        (0..n).map(|k| format!("[s{}]", k)).collect::<String>(),
        n,
        lead,
        segments.duration()
    ));
    Ok(vec![
        "-y".into(),
        "-i".into(),
        path(input)?,
        "-filter_complex".into(),
        chains.join(";"),
        "-map".into(),
        "[cam]".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "20".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-movflags".into(),
        "+faststart".into(),
        path(output)?,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timing(frames: &[(f64, i64)]) -> FrameTiming {
        let mut t = FrameTiming::new(60, 0);
        for &(pts, arrival) in frames {
            t.frame(pts, arrival);
        }
        t
    }

    #[test]
    fn offset_is_the_earliest_arrival() {
        let t = timing(&[(0.0, 2_000_100), (1.0, 12_000_050), (2.0, 22_000_000), (3.0, 32_300_000)]);
        assert_eq!(t.offset_hns, Some(2_000_000));
    }

    #[test]
    fn a_pause_gap_splits_the_timeline() {
        let mut frames = Vec::new();
        // Logged the moment they're produced: QPC time == pts.
        for i in 0..60 {
            let pts = i as f64 / 60.0;
            frames.push((pts, (pts * 1e7) as i64));
        }
        for i in 0..60 {
            let pts = 5.0 + i as f64 / 60.0;
            frames.push((pts, (pts * 1e7) as i64));
        }
        // A hole with no pause in it is a stall: kept.
        assert_eq!(timing(&frames).segments(&[]).unwrap().kept.len(), 1);
        let s = timing(&frames).segments(&[(20_000_000, 40_000_000)]).unwrap();
        assert_eq!(s.kept.len(), 2);
        assert!((s.duration() - 2.0).abs() < 1e-9);
        // A moment 0.5s into the second segment lands 0.5s after the first one ends.
        assert!((s.output_time((5.5 * 1e7) as i64).unwrap() - 1.5).abs() < 1e-6);
        assert_eq!(s.output_time((3.0 * 1e7) as i64), None);
    }

    #[test]
    fn setts_closes_gaps_and_starts_at_zero() {
        let s = Segments { offset_hns: 0, kept: vec![(0.25, 2.25), (5.0, 6.0)] };
        let expr = s.setts_expr("PTS");
        assert!(expr.starts_with("PTS-(0.250000+2.750000*gte(PTS*TB,4.996000))/TB"), "{}", expr);
    }

    #[test]
    fn audio_is_cut_against_the_same_wall_clock() {
        // Video pts 0 sits at QPC 10s; the mic's first sample at QPC 9s - one second earlier.
        let s = Segments { offset_hns: 100_000_000, kept: vec![(0.0, 2.0), (5.0, 6.0)] };
        let tl = AudioTimeline { wav_path: PathBuf::new(), first_sample_hns: 90_000_000, effective_rate: SAMPLE_RATE as f64, frames: 1 };
        let chain = s.audio_chain(1, &tl, "", "mic");
        assert!(chain.contains("atrim=start=1.000000:end=3.000000"), "{}", chain);
        assert!(chain.contains("atrim=start=6.000000:end=7.000000"), "{}", chain);
        assert!(!chain.contains("adelay"));
        assert!(!chain.contains("asetrate"));
    }

    #[test]
    fn late_audio_is_padded_and_drift_is_corrected() {
        let s = Segments { offset_hns: 100_000_000, kept: vec![(0.0, 2.0)] };
        let tl = AudioTimeline { wav_path: PathBuf::new(), first_sample_hns: 102_000_000, effective_rate: 48003.0, frames: 1 };
        let chain = s.audio_chain(1, &tl, "volume=2", "mic");
        assert!(chain.contains("asetrate=48003,aresample=48000"), "{}", chain);
        assert!(chain.contains("adelay=delays=200:all=1"), "{}", chain);
        assert!(chain.contains("atrim=start=0.000000:end=2.000000"), "{}", chain);
        assert!(chain.ends_with("volume=2[mic]"), "{}", chain);
    }

    #[test]
    fn webcam_is_cut_like_the_screen_and_padded_until_it_started() {
        // Screen pts 0 at QPC 10s; the camera's pts 0 at QPC 10.5s - it came up half a second late.
        let s = Segments { offset_hns: 100_000_000, kept: vec![(0.0, 2.0), (5.0, 6.0)] };
        let args = webcam_args(&s, 105_000_000, Path::new("in.mkv"), Path::new("out.mp4")).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("[c0]trim=start=0.000000:end=1.500000,setpts=PTS-STARTPTS"), "{}", fc);
        assert!(fc.contains("setpts=PTS+0.500000/TB,fps=30:start_time=0"), "{}", fc);
        assert!(fc.contains("[c1]trim=start=4.500000:end=5.500000"), "{}", fc);
        assert!(fc.contains("trim=duration=3.000000[cam]"), "{}", fc);
    }

    fn parts(enhance: bool) -> Parts {
        let tl = |p: &str| AudioTimeline { wav_path: PathBuf::from(p), first_sample_hns: 0, effective_rate: SAMPLE_RATE as f64, frames: 1 };
        Parts {
            video_path: PathBuf::from("v.mkv"),
            segments: Segments { offset_hns: 0, kept: vec![(0.0, 2.0)] },
            mic: Some(tl("m.wav")),
            system: Some(tl("s.wav")),
            video_has_audio: false,
            mic_gain_db: 3.0,
            system_gain_db: -6.0,
            rnnoise_model: None,
            enhance,
        }
    }

    #[test]
    fn enhancement_ducks_and_limits_and_off_leaves_audio_alone() {
        let on = assemble_args(&parts(true), Path::new("out.mp4")).unwrap().join(" ");
        assert!(on.contains("sidechaincompress") && on.contains("alimiter"), "{}", on);
        let off = assemble_args(&parts(false), Path::new("out.mp4")).unwrap().join(" ");
        assert!(!off.contains("sidechaincompress") && !off.contains("alimiter"), "{}", off);
        assert!(off.contains("amix=inputs=2"), "{}", off);
    }

    #[test]
    fn avi_gets_annex_b_h264() {
        let avi = assemble_args(&parts(true), Path::new("out.avi")).unwrap().join(" ");
        assert!(avi.contains("h264_mp4toannexb"), "{}", avi);
        let mp4 = assemble_args(&parts(true), Path::new("out.mp4")).unwrap().join(" ");
        assert!(!mp4.contains("h264_mp4toannexb"), "{}", mp4);
    }

    #[test]
    fn parses_metadata_print_lines() {
        let line = "[Parsed_metadata_1 @ 000001] frame:12   pts:205800  pts_time:0.2058\r\n";
        assert_eq!(parse_frame_pts(line), Some(0.2058));
        assert_eq!(parse_frame_pts("[out#0/null @ 0001] frame=  12 pts_time:3"), None);
    }
}
