// services/audio_capture.rs
//
// Timestamped WASAPI audio capture - the microphone, or system/"what you hear" audio via loopback -
// written to a WAV whose timeline is pinned to the system's QPC clock, so recording.rs can line it
// up with the screen capture to the millisecond when it assembles the final file.
//
// Why the app captures audio itself instead of letting ffmpeg's dshow input do it: ffmpeg starts
// the mic and the screen at different moments and rebases each to zero independently, so the
// final file's sync depended on device start-up times - measured anywhere from 0.3s to 3.3s off
// depending on the recording mode. Here every WASAPI packet carries the QPC time its first sample
// was captured (IAudioCaptureClient::GetBuffer's u64QPCPosition), and the screen capture's frames
// are timed against the same clock (see recording/win.rs), so the two can be aligned exactly.
//
// The WAV timeline follows QPC, not just the count of samples received:
//   - loopback delivers no packets at all while nothing is playing; those stretches are written
//     as silence (the previous loopback capture simply skipped them, so system audio slid earlier
//     every time the speakers went quiet);
//   - a packet arriving more than DRIFT_TOLERANCE away from where QPC says it belongs (a glitch, a
//     discontinuity) re-anchors the writer by padding silence or dropping the overlap.
// Within that tolerance the device's own sample clock is trusted, and its slow drift against QPC
// is measured instead (AudioTimeline::effective_rate) and corrected with a resample at mux time,
// which is inaudible where a pad or drop would click.
//
// Capture is never paused: recording.rs cuts paused stretches out of the audio at mux time using
// the exact intervals the screen capture lost, so the two can't come out of a pause misaligned.
//
// Runs on its own OS thread because WASAPI/COM state is per-thread.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use hound::{SampleFormat, WavSpec, WavWriter};
use wasapi::{
    deinitialize, initialize_mta, AudioClientProperties, DeviceEnumerator, Direction, SampleType,
    StreamMode, StreamOption, WaveFormat,
};

pub const SAMPLE_RATE: u32 = 48000;
const CHANNELS: u16 = 2;
const BITS_PER_SAMPLE: u16 = 16;
const BYTES_PER_FRAME: usize = (CHANNELS as usize) * (BITS_PER_SAMPLE as usize / 8);
// How far a packet may land from its QPC position before the writer re-anchors instead of
// trusting the device clock. Comfortably above packet jitter (~10ms), and small enough that sync
// never wanders further than this before being pulled back.
const DRIFT_TOLERANCE_SECS: f64 = 0.1;

#[derive(Clone, Debug)]
pub enum AudioSource {
    // Whatever is playing through the default output device (WASAPI loopback).
    SystemOutput,
    // An input device, by the name the recording UI lists it under (dshow's name - see find_input).
    Microphone(String),
}

// Where a finished capture's samples sit in time.
#[derive(Clone, Debug)]
pub struct AudioTimeline {
    pub wav_path: PathBuf,
    // QPC time, in 100ns units, of the WAV's first sample.
    pub first_sample_hns: i64,
    // Samples the device actually delivered per second of QPC time - SAMPLE_RATE give or take the
    // device clock's drift. Equal to SAMPLE_RATE when there wasn't enough audio to measure.
    pub effective_rate: f64,
    // Frames in the WAV. Zero for loopback when nothing played the whole recording.
    pub frames: u64,
}

pub struct AudioCapture {
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<Result<AudioTimeline, String>>,
}

impl AudioCapture {
    // Stops capturing, waits for the WAV to be finalized and returns its timeline.
    pub fn stop(self) -> Result<AudioTimeline, String> {
        self.stop_flag.store(true, Ordering::SeqCst);
        match self.handle.join() {
            Ok(result) => result,
            Err(_) => Err("Audio capture thread panicked".to_string()),
        }
    }
}

// Starts capturing `source` into a new WAV at `wav_path`. Returns once the device is open and
// capturing, so a device that can't be opened fails here rather than silently producing nothing.
pub fn start(source: AudioSource, wav_path: PathBuf) -> Result<AudioCapture, String> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop = stop_flag.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let handle = std::thread::Builder::new()
        .name("audio-capture".to_string())
        .spawn(move || {
            let _ = initialize_mta();
            let result = run_capture(&source, &wav_path, &thread_stop, &ready_tx);
            if let Err(e) = &result {
                let _ = ready_tx.send(Err(e.clone()));
            }
            deinitialize();
            result
        })
        .map_err(|e| format!("Failed to start the audio capture thread: {}", e))?;

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(AudioCapture { stop_flag, handle }),
        Ok(Err(e)) => {
            let _ = handle.join();
            Err(e)
        }
        Err(_) => match handle.join() {
            Ok(Err(e)) => Err(e),
            _ => Err("Audio capture thread exited before starting".to_string()),
        },
    }
}

// The recording UI lists devices by their DirectShow names. For WASAPI endpoints those are the
// same friendly names, except that legacy APIs may truncate them to 31 characters - so an exact
// match is preferred and a truncated prefix accepted.
fn find_input(enumerator: &DeviceEnumerator, name: &str) -> Result<wasapi::Device, String> {
    let collection = enumerator
        .get_device_collection(&Direction::Capture)
        .map_err(|e| format!("Failed to list audio input devices: {}", e))?;
    let count = collection.get_nbr_devices().map_err(|e| e.to_string())?;
    let mut prefix_match = None;
    for i in 0..count {
        let Ok(device) = collection.get_device_at_index(i) else { continue };
        let Ok(friendly) = device.get_friendlyname() else { continue };
        if friendly == name {
            return Ok(device);
        }
        if prefix_match.is_none() && name.len() >= 31 && friendly.starts_with(name) {
            prefix_match = Some(device);
        }
    }
    prefix_match.ok_or_else(|| format!("No audio input device named \"{}\"", name))
}

fn run_capture(
    source: &AudioSource,
    wav_path: &Path,
    stop_flag: &Arc<AtomicBool>,
    ready: &std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<AudioTimeline, String> {
    let enumerator =
        DeviceEnumerator::new().map_err(|e| format!("Failed to enumerate audio devices: {}", e))?;
    // Loopback is a render (output) device opened for capture - that mismatch is what puts WASAPI
    // into loopback mode; there's no separate loopback device to select.
    let device = match source {
        AudioSource::SystemOutput => enumerator
            .get_default_device(&Direction::Render)
            .map_err(|e| format!("Failed to get the default playback device: {}", e))?,
        AudioSource::Microphone(name) => find_input(&enumerator, name)?,
    };
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| format!("Failed to open the audio device: {}", e))?;

    let format = WaveFormat::new(
        BITS_PER_SAMPLE as usize,
        BITS_PER_SAMPLE as usize,
        &SampleType::Int,
        SAMPLE_RATE as usize,
        CHANNELS as usize,
        None,
    );
    // The mic is captured RAW - past Windows' and the driver's own voice effects (Realtek and
    // friends). Those effects delay audio before WASAPI timestamps it, so the stamps run late:
    // measured ~135ms against the same sound captured via loopback. Our own processing replaces
    // what they did (services/audio_enhance.rs). Devices without RAW support just get the default.
    let raw = matches!(source, AudioSource::Microphone(_))
        && audio_client
            .set_properties(AudioClientProperties::new().set_option(StreamOption::Raw))
            .is_ok();
    log::info!("Audio capture {:?} opened{}", source, if raw { " (raw)" } else { "" });
    let (_default_period, min_period) = audio_client
        .get_device_period()
        .map_err(|e| format!("Failed to query the audio device's timing: {}", e))?;
    // autoconvert: the audio engine converts from the device's native format to this fixed one,
    // so nothing here depends on what the device natively runs at.
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    audio_client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|e| format!("Failed to initialize audio capture: {}", e))?;
    let event = audio_client
        .set_get_eventhandle()
        .map_err(|e| format!("Failed to create the audio capture event: {}", e))?;
    let capture = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("Failed to get the audio capture client: {}", e))?;

    let spec = WavSpec {
        channels: CHANNELS,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: BITS_PER_SAMPLE,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(wav_path, spec)
        .map_err(|e| format!("Failed to create the audio WAV file: {}", e))?;
    audio_client
        .start_stream()
        .map_err(|e| format!("Failed to start audio capture: {}", e))?;
    let _ = ready.send(Ok(()));

    // The capture start time, used as the timeline origin until the first packet supplies the real
    // one - loopback delivers nothing at all until something plays.
    let started_hns = now_hns();
    let mut timeline = Timeline::new(started_hns);
    let mut buf = vec![0u8; BYTES_PER_FRAME * SAMPLE_RATE as usize];

    while !stop_flag.load(Ordering::SeqCst) {
        loop {
            let frames = match capture.get_next_packet_size() {
                Ok(Some(n)) if n > 0 => n as usize,
                Ok(_) => break,
                Err(e) => return Err(format!("Audio capture read failed: {}", e)),
            };
            if buf.len() < frames * BYTES_PER_FRAME {
                buf.resize(frames * BYTES_PER_FRAME, 0);
            }
            let (read, info) = capture
                .read_from_device(&mut buf)
                .map_err(|e| format!("Audio capture read failed: {}", e))?;
            let read = read as usize;
            if read == 0 {
                break;
            }
            let packet_hns = if info.flags.timestamp_error || info.timestamp == 0 {
                None
            } else {
                Some(info.timestamp as i64)
            };
            let (pad, skip) = timeline.place(packet_hns, read as u64);
            for _ in 0..pad * CHANNELS as u64 {
                writer.write_sample(0i16).map_err(write_err)?;
            }
            let data = &buf[(skip as usize).min(read) * BYTES_PER_FRAME..read * BYTES_PER_FRAME];
            if info.flags.silent {
                for _ in 0..data.len() / 2 {
                    writer.write_sample(0i16).map_err(write_err)?;
                }
            } else {
                for pair in data.chunks_exact(2) {
                    writer
                        .write_sample(i16::from_le_bytes([pair[0], pair[1]]))
                        .map_err(write_err)?;
                }
            }
        }
        // A periodic wake-up to check the stop flag, not an error: silence (or loopback with
        // nothing playing) legitimately produces no events.
        let _ = event.wait_for_event(100);
    }

    let _ = audio_client.stop_stream();
    writer
        .finalize()
        .map_err(|e| format!("Failed to finalize the audio WAV file: {}", e))?;
    Ok(timeline.finish(wav_path.to_path_buf()))
}

fn write_err(e: hound::Error) -> String {
    format!("Failed to write audio: {}", e)
}

// Where each packet goes in the WAV - see the module header. Separate from the capture loop so the
// placement rules can be tested without an audio device.
struct Timeline {
    // QPC time (100ns) of the WAV's first sample. Provisional (the capture start) until the first
    // timestamped packet arrives.
    origin_hns: i64,
    anchored: bool,
    // Frames written so far.
    written: u64,
    // Drift measurement: frames written vs QPC time elapsed, over the stretches where the writer
    // trusted the device clock (re-anchoring resets it).
    drift_start: Option<(i64, u64)>,
    drift_last: Option<(i64, u64)>,
    drift_frames: f64,
    drift_secs: f64,
}

impl Timeline {
    fn new(started_hns: i64) -> Self {
        Timeline {
            origin_hns: started_hns,
            anchored: false,
            written: 0,
            drift_start: None,
            drift_last: None,
            drift_frames: 0.0,
            drift_secs: 0.0,
        }
    }

    // Returns (silent frames to write first, frames to drop from the start of this packet).
    fn place(&mut self, packet_hns: Option<i64>, frames: u64) -> (u64, u64) {
        let Some(t) = packet_hns else {
            if !self.anchored {
                // Nothing to place it against yet - devices flag the first packets after a stream
                // starts as timestamp errors. Writing them would put audio in the WAV ahead of the
                // origin the first timed packet sets, delaying everything after it by their length
                // (measured: the mic landing ~140ms late against the same sound in loopback).
                return (0, frames);
            }
            // Untimed packet mid-stream: append, trusting the device clock.
            self.written += frames;
            return (0, 0);
        };
        if !self.anchored {
            self.anchored = true;
            self.origin_hns = t;
            self.drift_start = Some((t, 0));
            self.drift_last = Some((t, 0));
            self.written = frames;
            return (0, 0);
        }
        let target = ((t - self.origin_hns) as f64 * SAMPLE_RATE as f64 / 1e7).round().max(0.0) as u64;
        let tolerance = (DRIFT_TOLERANCE_SECS * SAMPLE_RATE as f64) as u64;

        if target + tolerance >= self.written && self.written + tolerance >= target {
            // Within tolerance: trust the device clock and append.
            self.drift_last = Some((t, self.written));
            self.written += frames;
            return (0, 0);
        }

        // Re-anchor so this packet's first frame lands exactly at `target`: pad the hole before it
        // with silence, or drop the part of it that overlaps audio already written.
        let (pad, skip) = if target > self.written {
            (target - self.written, 0)
        } else {
            (0, (self.written - target).min(frames))
        };
        self.close_drift_span();
        self.drift_start = Some((t, target));
        self.drift_last = Some((t, target));
        self.written = (self.written + pad).max(target + frames);
        (pad, skip)
    }

    fn close_drift_span(&mut self) {
        if let (Some((t0, f0)), Some((t1, f1))) = (self.drift_start, self.drift_last) {
            if t1 > t0 {
                self.drift_frames += (f1 - f0) as f64;
                self.drift_secs += (t1 - t0) as f64 / 1e7;
            }
        }
        self.drift_start = None;
        self.drift_last = None;
    }

    fn finish(mut self, wav_path: PathBuf) -> AudioTimeline {
        self.close_drift_span();
        // Under a minute of trusted audio can't resolve drift of a few ppm from packet jitter.
        let effective_rate = if self.drift_secs >= 60.0 {
            self.drift_frames / self.drift_secs
        } else {
            SAMPLE_RATE as f64
        };
        AudioTimeline {
            wav_path,
            first_sample_hns: self.origin_hns,
            effective_rate,
            frames: self.written,
        }
    }
}

// QPC "now" in the same 100ns units WASAPI reports packet times in.
pub fn now_hns() -> i64 {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let mut counter = 0i64;
    let mut freq = 0i64;
    unsafe {
        let _ = QueryPerformanceCounter(&mut counter);
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    if freq == 0 {
        return 0;
    }
    ((counter as i128 * 10_000_000) / freq as i128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACKET: u64 = 480; // 10ms
    fn hns(secs: f64) -> Option<i64> {
        Some((1_000_000_000.0 + secs * 1e7) as i64)
    }

    #[test]
    fn steady_packets_are_appended_as_they_come() {
        let mut t = Timeline::new(0);
        for i in 0..100 {
            assert_eq!(t.place(hns(i as f64 * 0.01), PACKET), (0, 0));
        }
        assert_eq!(t.written, 100 * PACKET);
        assert_eq!(t.origin_hns, hns(0.0).unwrap());
    }

    #[test]
    fn a_silent_stretch_with_no_packets_is_filled() {
        // Loopback while nothing plays: packets stop for 2s, then resume.
        let mut t = Timeline::new(0);
        t.place(hns(0.0), PACKET);
        let (pad, skip) = t.place(hns(2.01), PACKET);
        assert_eq!(skip, 0);
        assert_eq!(PACKET + pad, (2.01 * SAMPLE_RATE as f64).round() as u64);
    }

    #[test]
    fn untimed_packets_before_the_first_timestamp_are_dropped() {
        // Writing them would delay the whole timeline by their length.
        let mut t = Timeline::new(0);
        assert_eq!(t.place(None, PACKET), (0, PACKET));
        assert_eq!(t.place(None, PACKET), (0, PACKET));
        assert_eq!(t.place(hns(0.02), PACKET), (0, 0));
        assert_eq!(t.written, PACKET);
        assert_eq!(t.origin_hns, hns(0.02).unwrap());
    }

    #[test]
    fn jitter_within_tolerance_is_left_alone() {
        let mut t = Timeline::new(0);
        t.place(hns(0.0), PACKET);
        assert_eq!(t.place(hns(0.03), PACKET), (0, 0));
    }

    #[test]
    fn overlap_beyond_tolerance_is_dropped() {
        let mut t = Timeline::new(0);
        for i in 0..50 {
            t.place(hns(i as f64 * 0.01), PACKET);
        }
        // A burst claiming to start 0.2s earlier than where the writer already is.
        let (pad, skip) = t.place(hns(0.3), PACKET);
        assert_eq!(pad, 0);
        assert!(skip > 0);
    }

    #[test]
    fn drift_is_measured_from_the_device_clock() {
        let mut t = Timeline::new(0);
        // A device 100ppm fast: each 10ms of QPC time carries 480.048 frames on average.
        for i in 0..7000 {
            let frames = if i % 21 == 0 { PACKET + 1 } else { PACKET };
            t.place(hns(i as f64 * 0.01), frames);
        }
        let tl = t.finish(PathBuf::new());
        assert!(tl.effective_rate > SAMPLE_RATE as f64);
        assert!((tl.effective_rate - SAMPLE_RATE as f64).abs() < 5.0);
    }
}
