// The AI voice: text-to-speech that sounds like a person (src/components/docker/AiVoicePanel.tsx).
//
// Kokoro-82M (Apache-2.0) - a small neural voice model that, in blind listening comparisons, sits
// with the big cloud voices while running in real time on an ordinary CPU. It runs here, on this
// PC: no account, no per-minute bill, the script never leaves the machine, and it works offline.
// It runs on the ONNX Runtime the background-removal feature already downloads.
//
// Not bundled (the model alone is 326 MB): the first use fetches it into <app local data>/tts, each
// file pinned by size and SHA-256 (asset_download.rs) - the model, the pronunciation dictionaries
// (services/tts_text.rs), and the handful of voices on offer (about half a megabyte each).
//
// A recording is made sentence by sentence: tts_text splits the script and sounds it out, each piece
// is one model run in that voice's style, the silence the model leaves around it is trimmed, and
// pauses of a chosen length go between - so the pace of a voice-over is something you set rather
// than something the model happens to produce. The result is a 24 kHz WAV in the library's
// Voice-overs folder, named by what it says and how, so saying the same thing again in the same
// voice is instant (and never piles up copies).
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

use crate::commands::background_removal::{engine_dir, engine_dlls_present, ensure_engine_dlls, ort_environment, ENGINE_DOWNLOAD_SIZE};
use crate::services::asset_download::{download_asset, is_valid_install, DownloadAsset};
use crate::services::tts_text::{speech_chunks, Lexicon};
use crate::services::tts_vocab::token_id;

pub const SAMPLE_RATE: u32 = 24_000;
// Bumped when the way a recording is made changes, so earlier results aren't reused as if current.
const RECIPE_VERSION: &str = "kokoro-v1.0-r1";
pub const CANCELLED_ERR: &str = "TTS_CANCELLED";

// Pinned to a revision of the repository, so the files can't change under their hashes.
const HF: &str = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231";

const MODEL: DownloadAsset = DownloadAsset {
    file_name: "kokoro-82m-v1.0.onnx",
    url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model.onnx",
    sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
    size: 325_532_232,
};

const DICTIONARIES: &[DownloadAsset] = &[
    DownloadAsset {
        file_name: "us_gold.json",
        url: "https://raw.githubusercontent.com/hexgrad/misaki/fba1236595f2d2bf21d414ba6e57d25256afada3/misaki/data/us_gold.json",
        sha256: "dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f",
        size: 3_000_469,
    },
    DownloadAsset {
        file_name: "us_silver.json",
        url: "https://raw.githubusercontent.com/hexgrad/misaki/fba1236595f2d2bf21d414ba6e57d25256afada3/misaki/data/us_silver.json",
        sha256: "de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475",
        size: 3_099_517,
    },
    DownloadAsset {
        file_name: "gb_gold.json",
        url: "https://raw.githubusercontent.com/hexgrad/misaki/fba1236595f2d2bf21d414ba6e57d25256afada3/misaki/data/gb_gold.json",
        sha256: "29e62f4b60261c88f7f3c2c7811ca3825978948090b72d2b27d565b729282f71",
        size: 2_838_552,
    },
    DownloadAsset {
        file_name: "gb_silver.json",
        url: "https://raw.githubusercontent.com/hexgrad/misaki/fba1236595f2d2bf21d414ba6e57d25256afada3/misaki/data/gb_silver.json",
        sha256: "48131e2d92ccc41655f4543e87e0f938e71463eb5a54be7f0693bb712ebb6bce",
        size: 3_663_898,
    },
];

// One voice: what Kokoro calls it, the name people see, whether it speaks British English, and the
// pin of its style file (all the same size: 510 style vectors of 256 floats).
pub struct VoiceSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub british: bool,
    sha256: &'static str,
}
const VOICE_FILE_SIZE: u64 = 522_240;
const STYLE_ROWS: usize = 510;
const STYLE_DIM: usize = 256;

// The voices worth offering - the ones Kokoro's own quality grades put at B- and above, plus the
// best of each remaining kind (a deep US voice, a warm British one) so there's a real choice.
pub const VOICES: &[VoiceSpec] = &[
    VoiceSpec { id: "af_heart", name: "Heart", british: false, sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b" },
    VoiceSpec { id: "af_bella", name: "Bella", british: false, sha256: "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b" },
    VoiceSpec { id: "af_nicole", name: "Nicole", british: false, sha256: "cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a" },
    VoiceSpec { id: "af_aoede", name: "Aoede", british: false, sha256: "4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361" },
    VoiceSpec { id: "af_kore", name: "Kore", british: false, sha256: "9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e" },
    VoiceSpec { id: "af_sarah", name: "Sarah", british: false, sha256: "4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a" },
    VoiceSpec { id: "af_nova", name: "Nova", british: false, sha256: "18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f" },
    VoiceSpec { id: "am_michael", name: "Michael", british: false, sha256: "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1" },
    VoiceSpec { id: "am_fenrir", name: "Fenrir", british: false, sha256: "c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43" },
    VoiceSpec { id: "am_puck", name: "Puck", british: false, sha256: "fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0" },
    VoiceSpec { id: "bf_emma", name: "Emma", british: true, sha256: "669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73" },
    VoiceSpec { id: "bf_isabella", name: "Isabella", british: true, sha256: "3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f" },
    VoiceSpec { id: "bm_george", name: "George", british: true, sha256: "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc" },
    VoiceSpec { id: "bm_fable", name: "Fable", british: true, sha256: "f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1" },
];

pub fn voice_spec(id: &str) -> Result<&'static VoiceSpec, String> {
    VOICES.iter().find(|v| v.id == id).ok_or_else(|| format!("There's no voice called \"{}\".", id))
}

// ---- Files --------------------------------------------------------------------------------------

pub fn tts_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_handle.path().app_local_data_dir().map_err(|e| format!("No app data folder: {}", e))?.join("tts"))
}

fn voice_asset(spec: &VoiceSpec) -> DownloadAsset {
    // Leaked: a few short strings, made once per process, that a 'static DownloadAsset can point at.
    let url: &'static str = Box::leak(format!("{}/voices/{}.bin", HF, spec.id).into_boxed_str());
    let file_name: &'static str = Box::leak(format!("{}.bin", spec.id).into_boxed_str());
    DownloadAsset { file_name, url, sha256: spec.sha256, size: VOICE_FILE_SIZE }
}

fn present(dir: &Path, asset: &DownloadAsset) -> bool {
    std::fs::metadata(dir.join(asset.file_name)).map(|m| m.len() == asset.size).unwrap_or(false)
}

pub fn assets_ready(app_handle: &AppHandle) -> bool {
    let (Ok(dir), Ok(engine)) = (tts_dir(app_handle), engine_dir(app_handle)) else { return false };
    engine_dlls_present(&engine) && present(&dir, &MODEL) && DICTIONARIES.iter().all(|a| present(&dir, a)) && VOICES.iter().all(|v| present(&dir, &voice_asset(v)))
}

// What a first run downloads, in bytes (the engine counts only if it isn't already there).
pub fn download_size(app_handle: &AppHandle) -> u64 {
    let engine = engine_dir(app_handle).map(|e| !engine_dlls_present(&e)).unwrap_or(true);
    (if engine { ENGINE_DOWNLOAD_SIZE } else { 0 }) + MODEL.size + DICTIONARIES.iter().map(|a| a.size).sum::<u64>() + VOICE_FILE_SIZE * VOICES.len() as u64
}

// Fetches whatever is missing or damaged. `emit` gets (bytes so far, bytes in all).
pub fn ensure_assets(app_handle: &AppHandle, cancel: &AtomicBool, emit: &dyn Fn(u64, u64)) -> Result<(), String> {
    let dir = tts_dir(app_handle)?;
    let engine = engine_dir(app_handle)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the voice folder: {}", e))?;
    std::fs::create_dir_all(&engine).map_err(|e| format!("Couldn't create the engine folder: {}", e))?;
    let total = download_size(app_handle);
    let mut base = 0u64;
    emit(0, total);
    if !engine_dlls_present(&engine) {
        ensure_engine_dlls(&engine, cancel, CANCELLED_ERR, &|n| emit(n, total))?;
        base += ENGINE_DOWNLOAD_SIZE;
    }
    let mut fetch = |asset: &DownloadAsset, base: &mut u64| -> Result<(), String> {
        let dest = dir.join(asset.file_name);
        if !is_valid_install(&dest, asset) {
            download_asset(asset, &dest, cancel, CANCELLED_ERR, &|n| emit(*base + n, total))?;
        }
        *base += asset.size;
        emit(*base, total);
        Ok(())
    };
    for asset in DICTIONARIES {
        fetch(asset, &mut base)?;
    }
    for spec in VOICES {
        fetch(&voice_asset(spec), &mut base)?;
    }
    fetch(&MODEL, &mut base)?;
    emit(total, total);
    Ok(())
}

// ---- The engine ---------------------------------------------------------------------------------

pub struct Engine {
    session: ort::session::Session,
    us: Lexicon,
    gb: Lexicon,
    voices: HashMap<&'static str, Vec<f32>>,
    dir: PathBuf,
}

static ENGINE: OnceLock<Mutex<Option<Engine>>> = OnceLock::new();
fn engine_slot() -> &'static Mutex<Option<Engine>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

impl Engine {
    fn load(dir: PathBuf, engine: &Path) -> Result<Engine, String> {
        use ort::session::Session;
        let env = ort_environment(engine)?;
        // Most of the machine - this is the thing the person is waiting for - but not all of it.
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let threads = (cores * 3 / 4).clamp(2, 8);
        let session = Session::builder(env)
            .and_then(|b| b.with_intra_threads(threads).map_err(|e| e.into()))
            .and_then(|mut b| b.commit_from_file(dir.join(MODEL.file_name)))
            .map_err(|e| format!("The voice model didn't load: {}", e))?;
        let read = |name: &str| std::fs::read_to_string(dir.join(name)).map_err(|e| format!("Couldn't read {}: {}", name, e));
        Ok(Engine {
            session,
            us: Lexicon::parse(&read("us_gold.json")?, &read("us_silver.json")?)?,
            gb: Lexicon::parse(&read("gb_gold.json")?, &read("gb_silver.json")?)?,
            voices: HashMap::new(),
            dir,
        })
    }

    // The voice's 510 x 256 style table, read once.
    fn style_table(&mut self, spec: &'static VoiceSpec) -> Result<&Vec<f32>, String> {
        if !self.voices.contains_key(spec.id) {
            let bytes = std::fs::read(self.dir.join(format!("{}.bin", spec.id))).map_err(|e| format!("Couldn't read the {} voice: {}", spec.name, e))?;
            let table: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
            if table.len() != STYLE_ROWS * STYLE_DIM {
                return Err(format!("The {} voice file is the wrong size.", spec.name));
            }
            self.voices.insert(spec.id, table);
        }
        Ok(&self.voices[spec.id])
    }

    // One piece of speech (phonemes) -> samples at 24 kHz.
    fn run(&mut self, spec: &'static VoiceSpec, phonemes: &str, speed: f32) -> Result<Vec<f32>, String> {
        use ort::value::Tensor;
        let tokens: Vec<i64> = phonemes.chars().filter_map(token_id).collect();
        if tokens.is_empty() {
            return Ok(Vec::new());
        }
        // The style vector is chosen by how long the utterance is - that's how the voices were trained.
        let row = tokens.len().min(STYLE_ROWS - 1);
        let style: Vec<f32> = self.style_table(spec)?[row * STYLE_DIM..(row + 1) * STYLE_DIM].to_vec();
        let mut ids = Vec::with_capacity(tokens.len() + 2);
        ids.push(0);
        ids.extend(&tokens);
        ids.push(0);
        let n = ids.len();
        let input = Tensor::from_array(([1usize, n], ids)).map_err(|e| e.to_string())?;
        let style = Tensor::from_array(([1usize, STYLE_DIM], style)).map_err(|e| e.to_string())?;
        let speed = Tensor::from_array(([1usize], vec![speed])).map_err(|e| e.to_string())?;
        let outputs = self
            .session
            .run(ort::inputs!["input_ids" => input, "style" => style, "speed" => speed])
            .map_err(|e| format!("The voice failed on a sentence: {}", e))?;
        let (_, wave) = outputs["waveform"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        Ok(wave.to_vec())
    }
}

// ---- Making a recording -------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Settings {
    pub voice: String,
    // 1.0 is the voice's own pace.
    pub speed: f32,
    // Scales the silence between sentences: 1.0 natural, below it brisk, above it measured.
    pub pause: f32,
}

impl Settings {
    pub fn clamped(mut self) -> Settings {
        self.speed = self.speed.clamp(0.6, 1.5);
        self.pause = self.pause.clamp(0.0, 2.5);
        self
    }
}

pub struct Spoken {
    pub samples: Vec<f32>,
}

// Silence the model leaves at the ends of a piece, trimmed so the pause that follows is the one
// that was asked for - and so a piece never starts or ends on a click.
fn trim_and_fade(wave: &mut Vec<f32>) {
    let floor = 0.003f32;
    let guard = (SAMPLE_RATE as f32 * 0.02) as usize;
    let first = wave.iter().position(|s| s.abs() > floor).unwrap_or(0);
    let last = wave.iter().rposition(|s| s.abs() > floor).unwrap_or(wave.len().saturating_sub(1));
    let from = first.saturating_sub(guard);
    let to = (last + guard).min(wave.len());
    if from < to {
        *wave = wave[from..to].to_vec();
    }
    let fade = ((SAMPLE_RATE as f32 * 0.008) as usize).min(wave.len() / 2);
    for i in 0..fade {
        let g = i as f32 / fade as f32;
        wave[i] *= g;
        let j = wave.len() - 1 - i;
        wave[j] *= g;
    }
}

pub fn synthesize(app_handle: &AppHandle, text: &str, settings: &Settings, cancel: &AtomicBool, progress: &dyn Fn(usize, usize)) -> Result<Spoken, String> {
    synthesize_at(&tts_dir(app_handle)?, &engine_dir(app_handle)?, text, settings, cancel, progress)
}

// `dir` holds the model, dictionaries and voices; `engine` the ONNX Runtime libraries.
pub fn synthesize_at(dir: &Path, engine: &Path, text: &str, settings: &Settings, cancel: &AtomicBool, progress: &dyn Fn(usize, usize)) -> Result<Spoken, String> {
    let spec = voice_spec(&settings.voice)?;
    let settings = settings.clone().clamped();
    let mut slot = engine_slot().lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        *slot = Some(Engine::load(dir.to_path_buf(), engine)?);
    }
    let engine = slot.as_mut().ok_or("The voice engine isn't running.")?;
    let chunks = speech_chunks(text, if spec.british { &engine.gb } else { &engine.us });
    if chunks.is_empty() {
        return Err("There's nothing to say - add some words first.".into());
    }
    let total = chunks.len();
    // A beat of room before the first word and after the last, so it doesn't clip when it lands on a cut.
    let silence = |seconds: f32| vec![0f32; (seconds * SAMPLE_RATE as f32) as usize];
    let mut out = silence(0.10);
    progress(0, total);
    for (i, chunk) in chunks.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED_ERR.into());
        }
        let mut wave = engine.run(spec, &chunk.phonemes, settings.speed)?;
        trim_and_fade(&mut wave);
        out.extend(wave);
        // The voice's own speed also stretches the gaps - a slower reader pauses longer.
        out.extend(silence(chunk.pause_after * settings.pause / settings.speed));
        progress(i + 1, total);
    }
    out.extend(silence(0.15));
    // Even out the level: hot output is pulled under clipping, a quiet one is lifted to a sensible
    // peak (Kokoro's own come out near -4 dBFS, about -22 LUFS - low for speech) (the export's loudness target and the mixer do the rest).
    let peak = out.iter().fold(0f32, |m, s| m.max(s.abs()));
    if peak > 0.0 {
        let gain = if peak > 0.97 { 0.97 / peak } else if peak < 0.8 { 0.89 / peak } else { 1.0 };
        if gain != 1.0 {
            out.iter_mut().for_each(|s| *s *= gain);
        }
    }
    Ok(Spoken { samples: out })
}

pub fn write_wav(path: &Path, samples: &[f32]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {}", dir.display(), e))?;
    }
    let tmp = path.with_extension("part");
    let spec = hound::WavSpec { channels: 1, sample_rate: SAMPLE_RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    {
        let mut writer = hound::WavWriter::create(&tmp, spec).map_err(|e| format!("Couldn't save the recording: {}", e))?;
        for s in samples {
            writer.write_sample((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("Couldn't save the recording: {}", e))
}

// A short stable name for what was said and how: the same request always lands on the same file.
pub fn request_key(text: &str, settings: &Settings) -> String {
    let s = settings.clone().clamped();
    let mut hasher = Sha256::new();
    hasher.update(format!("{}|{}|{:.2}|{:.2}|{}", RECIPE_VERSION, s.voice, s.speed, s.pause, text.trim()));
    hasher.finalize().iter().take(4).map(|b| format!("{:02x}", b)).collect()
}

// "Welcome to the show - today we're…" -> "Welcome to the show today were". Letters, digits and
// spaces only: a name with brackets, quotes or apostrophes is trouble for ffmpeg filter graphs and
// URLs further down the line.
pub fn name_from_text(text: &str) -> String {
    let words: Vec<String> = text
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|w| !w.is_empty())
        .take(6)
        .collect();
    if words.is_empty() { "voice".to_string() } else { words.join(" ") }
}

pub fn release_engine() {
    if let Ok(mut slot) = engine_slot().lock() {
        *slot = None;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub british: bool,
}

pub fn voice_list() -> Vec<VoiceInfo> {
    VOICES.iter().map(|v| VoiceInfo { id: v.id, name: v.name, british: v.british }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_voice_has_a_pin_and_a_unique_id() {
        let mut ids: Vec<_> = VOICES.iter().map(|v| v.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), VOICES.len());
        assert!(VOICES.iter().all(|v| v.sha256.len() == 64));
        assert_eq!(voice_asset(&VOICES[0]).url, format!("{}/voices/af_heart.bin", HF));
        assert!(MODEL.url.starts_with(HF) && DICTIONARIES.iter().all(|d| d.url.contains("/misaki/fba1236595f2d2bf21d414ba6e57d25256afada3/")));
    }

    #[test]
    fn requests_are_named_by_content() {
        let a = Settings { voice: "af_heart".into(), speed: 1.0, pause: 1.0 };
        let b = Settings { voice: "af_bella".into(), ..a.clone() };
        assert_eq!(request_key("Hello", &a), request_key("  Hello ", &a));
        assert_ne!(request_key("Hello", &a), request_key("Hello", &b));
        assert_ne!(request_key("Hello", &a), request_key("Hello!", &a));
        assert_eq!(name_from_text("Welcome to the show - today we're live, folks!"), "Welcome to the show today were");
    }

    // The whole path on real files: BRIEFCAST_TTS_FILES=<folder laid out like <app data>/tts>,
    // BRIEFCAST_TTS_ENGINE=<folder with onnxruntime.dll>, BRIEFCAST_TTS_OUT=<wav to write>.
    #[test]
    fn speaks_a_script_on_the_real_model() {
        let (Ok(files), Ok(engine), Ok(out)) = (std::env::var("BRIEFCAST_TTS_FILES"), std::env::var("BRIEFCAST_TTS_ENGINE"), std::env::var("BRIEFCAST_TTS_OUT")) else { return };
        let settings = Settings { voice: std::env::var("BRIEFCAST_TTS_VOICE").unwrap_or_else(|_| "af_heart".into()), speed: 1.0, pause: 1.0 };
        let text = std::env::var("BRIEFCAST_TTS_TEXT").unwrap_or_else(|_| "Welcome to Briefcast. In 2024 we shipped three new features, and it's the best release yet! Isn't that great?".into());
        let never = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let spoken = synthesize_at(Path::new(&files), Path::new(&engine), &text, &settings, &never, &|d, t| println!("part {d}/{t}")).unwrap();
        let seconds = spoken.samples.len() as f32 / SAMPLE_RATE as f32;
        println!("{seconds:.2}s of speech in {:.2}s", started.elapsed().as_secs_f32());
        assert!(seconds > 3.0 && seconds < 30.0);
        let rms = (spoken.samples.iter().map(|s| s * s).sum::<f32>() / spoken.samples.len() as f32).sqrt();
        assert!(rms > 0.02, "silent output, rms {rms}");
        write_wav(Path::new(&out), &spoken.samples).unwrap();
    }

    #[test]
    fn trimming_removes_silence_and_clicks() {
        let mut wave = vec![0.0f32; 4000];
        wave.extend(std::iter::repeat(0.5).take(8000));
        wave.extend(vec![0.0f32; 4000]);
        trim_and_fade(&mut wave);
        assert!(wave.len() < 8000 + 2 * 480 + 16 && wave.len() > 8000);
        assert!(wave[0].abs() < 1e-6 && wave[wave.len() - 1].abs() < 1e-6);
    }
}
