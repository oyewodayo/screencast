// One mixer channel's effects - EQ, compressor, balance - as an ffmpeg filter chain for the export.
//
// The live preview runs a sample-exact port of these very filters in an AudioWorklet
// (public/audio-worklets/track-fx-processor.js); both take the editor's settings in the same units
// (dB, ms - src/utils/audioFx.ts) and clamp them the same way, so what is heard while editing is
// what the saved video sounds like (checked against this ffmpeg to within float rounding: -142 dB).
//
//   EQ          lowshelf @100 Hz -> peaking (centre and Q chosen) -> highshelf @8 kHz, RBJ biquads
//               in double precision (`r=f64` - the default float path is ~-77 dB off the preview).
//   Compressor  acompressor (RMS detection, channels averaged), threshold/makeup/knee in dB.
//   Balance     the side panned away from is turned down; channels are never mixed together.
use serde::Deserialize;

pub const LOW_SHELF_HZ: f64 = 100.0;
pub const HIGH_SHELF_HZ: f64 = 8000.0;

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioFxSpec {
    #[serde(default)]
    pub eq: Option<EqSpec>,
    #[serde(default)]
    pub compressor: Option<CompressorSpec>,
    // -1 (left) .. 1 (right); None/0 = centred.
    #[serde(default)]
    pub pan: Option<f64>,
}

// Band gains in dB; the middle band's centre (Hz) and Q.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EqSpec {
    #[serde(default)]
    pub low: f64,
    #[serde(default)]
    pub mid: f64,
    #[serde(default)]
    pub mid_freq: Option<f64>,
    #[serde(default)]
    pub mid_q: Option<f64>,
    #[serde(default)]
    pub high: f64,
}

// threshold (dBFS), ratio (n:1), attack/release (ms), makeup and knee (dB).
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompressorSpec {
    pub threshold: f64,
    pub ratio: f64,
    pub attack: f64,
    pub release: f64,
    #[serde(default)]
    pub makeup: f64,
    #[serde(default = "default_knee_db")]
    pub knee: f64,
}

fn default_knee_db() -> f64 {
    // acompressor's own default knee (2.82843, as a ratio).
    9.0309
}

fn finite_or(v: f64, fallback: f64) -> f64 {
    if v.is_finite() { v } else { fallback }
}

fn db_to_linear(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

// A band's gain, as the preview limits it.
fn band(g: f64) -> f64 {
    finite_or(g, 0.0).clamp(-24.0, 24.0)
}

// The filters for `fx`, in order - empty when every stage is off or neutral.
pub fn audio_fx_filters(fx: &AudioFxSpec) -> Vec<String> {
    let mut filters = Vec::new();
    if let Some(eq) = &fx.eq {
        let (low, mid, high) = (band(eq.low), band(eq.mid), band(eq.high));
        let freq = finite_or(eq.mid_freq.unwrap_or(1000.0), 1000.0).clamp(20.0, 20000.0);
        let q = finite_or(eq.mid_q.unwrap_or(1.0), 1.0).clamp(0.1, 10.0);
        if low != 0.0 {
            filters.push(format!("lowshelf=f={LOW_SHELF_HZ}:g={low}:t=s:w=1:r=f64"));
        }
        if mid != 0.0 {
            filters.push(format!("equalizer=f={freq}:t=q:w={q}:g={mid}:r=f64"));
        }
        if high != 0.0 {
            filters.push(format!("highshelf=f={HIGH_SHELF_HZ}:g={high}:t=s:w=1:r=f64"));
        }
    }
    if let Some(c) = &fx.compressor {
        // acompressor's option ranges.
        let threshold = db_to_linear(finite_or(c.threshold, 0.0)).clamp(0.000976563, 1.0);
        let ratio = finite_or(c.ratio, 1.0).clamp(1.0, 20.0);
        let attack = finite_or(c.attack, 20.0).clamp(0.01, 2000.0);
        let release = finite_or(c.release, 250.0).clamp(0.01, 9000.0);
        let makeup = db_to_linear(finite_or(c.makeup, 0.0)).clamp(1.0, 64.0);
        let knee = db_to_linear(finite_or(c.knee, default_knee_db())).clamp(1.0, 8.0);
        filters.push(format!("acompressor=threshold={threshold}:ratio={ratio}:attack={attack}:release={release}:makeup={makeup}:knee={knee}"));
    }
    let pan = finite_or(fx.pan.unwrap_or(0.0), 0.0).clamp(-1.0, 1.0);
    if pan.abs() > 1e-4 {
        let (gl, gr) = if pan > 0.0 { (1.0 - pan, 1.0) } else { (1.0, 1.0 + pan) };
        filters.push(format!("pan=stereo|c0={gl}*c0|c1={gr}*c1"));
    }
    filters
}

// A mono source played in the browser comes out at full level on both sides; ffmpeg's own
// up-mix (aformat/amix's automatic conversion) would put it 3 dB lower on each. Copying the one
// channel to both keeps the export at the level the preview plays.
pub fn mono_to_stereo_filter(channels: Option<u32>) -> Option<&'static str> {
    (channels == Some(1)).then_some("pan=stereo|c0=c0|c1=c0")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_settings_add_nothing() {
        let fx = AudioFxSpec { eq: Some(EqSpec { low: 0.0, mid: 0.0, mid_freq: None, mid_q: None, high: 0.0 }), compressor: None, pan: Some(0.0) };
        assert!(audio_fx_filters(&fx).is_empty());
        assert!(audio_fx_filters(&AudioFxSpec::default()).is_empty());
    }

    #[test]
    fn builds_the_preview_chain_in_order() {
        let fx = AudioFxSpec {
            eq: Some(EqSpec { low: -3.0, mid: 3.0, mid_freq: Some(900.0), mid_q: Some(0.8), high: -6.0 }),
            compressor: Some(CompressorSpec { threshold: -30.0, ratio: 3.0, attack: 20.0, release: 250.0, makeup: 9.0, knee: 9.0 }),
            pan: Some(0.4),
        };
        let f = audio_fx_filters(&fx);
        assert_eq!(f[0], "lowshelf=f=100:g=-3:t=s:w=1:r=f64");
        assert_eq!(f[1], "equalizer=f=900:t=q:w=0.8:g=3:r=f64");
        assert_eq!(f[2], "highshelf=f=8000:g=-6:t=s:w=1:r=f64");
        assert!(f[3].starts_with("acompressor=threshold=0.0316227766"), "{}", f[3]);
        assert!(f[3].contains(":ratio=3:attack=20:release=250:makeup=2.818382931"), "{}", f[3]);
        assert_eq!(f[4], "pan=stereo|c0=0.6*c0|c1=1*c1");
    }

    #[test]
    fn clamps_to_the_filters_ranges() {
        let fx = AudioFxSpec {
            eq: None,
            compressor: Some(CompressorSpec { threshold: -90.0, ratio: 50.0, attack: 0.0, release: f64::NAN, makeup: 60.0, knee: 40.0 }),
            pan: Some(-3.0),
        };
        let f = audio_fx_filters(&fx);
        assert_eq!(f[0], "acompressor=threshold=0.000976563:ratio=20:attack=0.01:release=250:makeup=64:knee=8");
        assert_eq!(f[1], "pan=stereo|c0=1*c0|c1=0*c1");
    }

    #[test]
    fn up_mixes_mono_only() {
        assert_eq!(mono_to_stereo_filter(Some(1)), Some("pan=stereo|c0=c0|c1=c0"));
        assert_eq!(mono_to_stereo_filter(Some(2)), None);
        assert_eq!(mono_to_stereo_filter(None), None);
    }
}
