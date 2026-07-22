// services/loopback_audio.rs
//
// System/"what you hear" audio capture via WASAPI loopback. This exists because ffmpeg (via
// dshow) can only ever capture from a device Windows already exposes as a *recording* device —
// normally just microphones/line-in, plus "Stereo Mix" on the machines whose driver still ships
// it. On a machine with no such device at all (increasingly common — many modern
// laptops/Realtek/Windows 11 setups hide or never expose it), there is no ffmpeg flag that can
// make dshow capture what's playing through the speakers: the device simply isn't there for it
// to select. WASAPI loopback sidesteps this entirely — every Windows install since Vista can open
// any *render* (output) endpoint in loopback mode and read back whatever it's currently playing,
// with no driver, no virtual audio cable, and no Windows Sound Panel configuration required.
//
// Runs on its own dedicated OS thread (WASAPI/COM state is per-thread, so this can't share a
// thread with anything else) for the duration of a recording, writing 16-bit PCM straight to a
// WAV file. recording.rs starts this alongside the screen-capture ffmpeg process and, once both
// have stopped, muxes the WAV into the final output (see mux_system_audio in recording.rs) —
// mixed with the mic track if the recording mode already has one (sva/sa), or added as the sole
// audio track otherwise (s).
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use hound::{SampleFormat, WavSpec, WavWriter};
use wasapi::{deinitialize, initialize_mta, Direction, DeviceEnumerator, SampleType, StreamMode, WaveFormat};

const SAMPLE_RATE: usize = 44100;
const CHANNELS: usize = 2;
const BITS_PER_SAMPLE: usize = 16;

pub struct LoopbackCapture {
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<Result<(), String>>,
    pub wav_path: PathBuf,
}

impl LoopbackCapture {
    /// Signals the capture thread to stop and blocks until it has finished flushing the WAV
    /// file to disk, returning the completed file's path.
    pub fn stop(self) -> Result<PathBuf, String> {
        self.stop_flag.store(true, Ordering::SeqCst);
        match self.handle.join() {
            Ok(Ok(())) => Ok(self.wav_path),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("Loopback capture thread panicked".to_string()),
        }
    }
}

/// Starts capturing whatever's currently playing through the default output device on a
/// dedicated background thread, writing PCM to a new WAV file at `wav_path` (overwriting any
/// existing file there). Returns as soon as the thread is spawned — actual capture continues
/// until `LoopbackCapture::stop()` is called.
pub fn start(wav_path: PathBuf) -> Result<LoopbackCapture, String> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = stop_flag.clone();
    let thread_wav_path = wav_path.clone();

    let handle = std::thread::Builder::new()
        .name("loopback-audio-capture".to_string())
        .spawn(move || capture_loop(thread_wav_path, thread_stop_flag))
        .map_err(|e| format!("Failed to start system-audio capture thread: {}", e))?;

    Ok(LoopbackCapture { stop_flag, handle, wav_path })
}

fn capture_loop(wav_path: PathBuf, stop_flag: Arc<AtomicBool>) -> Result<(), String> {
    // COM apartment state is per-thread and must be torn down on the same thread that set it up
    // - this whole function runs on the dedicated thread spawn() above created for exactly that.
    let _ = initialize_mta();
    let result = run_capture(&wav_path, &stop_flag);
    deinitialize();
    result
}

fn run_capture(wav_path: &Path, stop_flag: &Arc<AtomicBool>) -> Result<(), String> {
    let enumerator = DeviceEnumerator::new().map_err(|e| format!("Failed to enumerate audio devices: {}", e))?;

    // The trick: open the default *render* (playback) device, but initialize its AudioClient for
    // Capture use below. That Render-device-used-as-Capture mismatch is precisely what puts
    // WASAPI into loopback mode (see the `wasapi` crate's own record.rs example, which documents
    // this exact pattern) - there is no separate "loopback device" to select.
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| format!("Failed to get the default playback device: {}", e))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| format!("Failed to open the playback device for loopback capture: {}", e))?;

    let desired_format = WaveFormat::new(BITS_PER_SAMPLE, BITS_PER_SAMPLE, &SampleType::Int, SAMPLE_RATE, CHANNELS, None);
    let blockalign = desired_format.get_blockalign() as usize;

    let (_default_period, min_period) = audio_client
        .get_device_period()
        .map_err(|e| format!("Failed to query the playback device's timing: {}", e))?;

    // autoconvert: true means the audio engine handles resampling/reformatting from whatever the
    // device's own native mix format actually is down to our fixed 16-bit/44.1kHz/stereo target,
    // so this doesn't need to query (or care about) the device's native format at all.
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: min_period };
    audio_client
        .initialize_client(&desired_format, &Direction::Capture, &mode)
        .map_err(|e| format!("Failed to initialize system-audio loopback capture: {}", e))?;

    let event_handle = audio_client
        .set_get_eventhandle()
        .map_err(|e| format!("Failed to create the loopback capture event: {}", e))?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("Failed to get the loopback audio capture client: {}", e))?;

    let spec = WavSpec {
        channels: CHANNELS as u16,
        sample_rate: SAMPLE_RATE as u32,
        bits_per_sample: BITS_PER_SAMPLE as u16,
        sample_format: SampleFormat::Int,
    };
    let mut writer =
        WavWriter::create(wav_path, spec).map_err(|e| format!("Failed to create the system-audio WAV file: {}", e))?;

    let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(blockalign * 1024 * 8);

    audio_client
        .start_stream()
        .map_err(|e| format!("Failed to start the loopback capture stream: {}", e))?;

    while !stop_flag.load(Ordering::SeqCst) {
        capture_client
            .read_from_device_to_deque(&mut sample_queue)
            .map_err(|e| format!("Loopback capture read failed: {}", e))?;

        // Stream straight to disk rather than buffering the whole recording in memory - two
        // bytes at a time since BITS_PER_SAMPLE is fixed at 16 above; the incoming bytes are
        // already interleaved L/R per the requested (stereo) format, so writing one i16 sample
        // at a time in arrival order reproduces that interleaving correctly.
        while sample_queue.len() >= 2 {
            let low = sample_queue.pop_front().unwrap();
            let high = sample_queue.pop_front().unwrap();
            writer
                .write_sample(i16::from_le_bytes([low, high]))
                .map_err(|e| format!("Failed to write a system-audio sample: {}", e))?;
        }

        // Ignored on purpose: this is a periodic "wake up and check the stop flag" tick, not a
        // fatal condition the way wasapi's own examples treat a timeout - a quiet moment with
        // nothing new to read is completely normal and shouldn't stop the capture.
        let _ = event_handle.wait_for_event(100);
    }

    let _ = audio_client.stop_stream();
    writer.finalize().map_err(|e| format!("Failed to finalize the system-audio WAV file: {}", e))?;

    Ok(())
}
