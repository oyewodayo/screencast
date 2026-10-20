// utils/audioFx.ts
//
// Mixer channels and their effects: an EQ, a compressor and a balance knob on the video's own
// sound, on every audio track and on a picture-in-picture's sound.
//
// The settings are stored in the editor's own units (dB, ms) and both renderers take them as they
// are: the live preview's AudioWorklet (public/audio-worklets/track-fx-processor.js) and the export's
// ffmpeg chain (services/audio_fx.rs) apply identical clamps and filter maths - the worklet is a
// port of ffmpeg's own lowshelf/equalizer/highshelf/acompressor/pan, checked sample for sample
// against it (audioFx.test.ts), so the preview is what the saved video sounds like.
//
// The mixer groups audio tracks into channels by name: every piece of a cut-up "Music" or "Voice"
// track is one strip, and a change on the strip applies to all of them.
import type { AudioOverlay } from "./videoEditTypes";

export interface AudioEq {
  // Band gains in dB (-12..12 in the UI).
  low: number;
  mid: number;
  high: number;
  // The middle band's centre (Hz) and width (Q).
  midFreq: number;
  midQ: number;
}

export interface AudioCompressor {
  threshold: number; // dBFS
  ratio: number; // n:1
  attack: number; // ms
  release: number; // ms
  makeup: number; // dB
  knee: number; // dB
}

export interface AudioFx {
  eq?: AudioEq;
  compressor?: AudioCompressor;
  // -1 (left) .. 1 (right). Undefined = centred.
  pan?: number;
}

export const LOW_SHELF_HZ = 100;
export const HIGH_SHELF_HZ = 8000;

export const FLAT_EQ: AudioEq = { low: 0, mid: 0, high: 0, midFreq: 1000, midQ: 1 };

export const EQ_PRESETS: { id: string; label: string; hint: string; eq: AudioEq }[] = [
  { id: "flat", label: "Flat", hint: "No change", eq: FLAT_EQ },
  { id: "voice", label: "Clear voice", hint: "Less boom, more presence - speech cuts through", eq: { low: -4, mid: 3, midFreq: 3000, midQ: 1, high: 2 } },
  { id: "warm", label: "Warm", hint: "Fuller low end, softer top", eq: { low: 3, mid: -1, midFreq: 400, midQ: 0.8, high: -2 } },
  { id: "bright", label: "Bright", hint: "More air and sparkle", eq: { low: 0, mid: 1, midFreq: 5000, midQ: 0.7, high: 4 } },
  { id: "bass", label: "Bass boost", hint: "Heavier low end for music", eq: { low: 6, mid: 0, midFreq: 1000, midQ: 1, high: 0 } },
  { id: "music-bed", label: "Music under voice", hint: "Carves a hole where speech sits so it doesn't fight the voice", eq: { low: 0, mid: -5, midFreq: 2500, midQ: 0.7, high: -1 } },
  { id: "phone", label: "Telephone", hint: "Thin, band-limited - for a call or flashback", eq: { low: -12, mid: 6, midFreq: 1500, midQ: 0.7, high: -12 } },
];

export const COMPRESSOR_PRESETS: { id: string; label: string; hint: string; comp: AudioCompressor }[] = [
  { id: "gentle", label: "Gentle", hint: "Evens out a voice without sounding processed", comp: { threshold: -24, ratio: 2, attack: 20, release: 250, makeup: 3, knee: 9 } },
  { id: "podcast", label: "Podcast", hint: "Steady, close, radio-style speech", comp: { threshold: -28, ratio: 4, attack: 10, release: 200, makeup: 8, knee: 6 } },
  { id: "punchy", label: "Punchy", hint: "Lets transients through - drums, music", comp: { threshold: -20, ratio: 3, attack: 40, release: 120, makeup: 4, knee: 6 } },
  { id: "limit", label: "Tame peaks", hint: "Only catches the loudest moments", comp: { threshold: -8, ratio: 12, attack: 1, release: 80, makeup: 0, knee: 3 } },
];

export const DEFAULT_COMPRESSOR = COMPRESSOR_PRESETS[0].comp;

const near = (a: number | undefined, b: number) => Math.abs((a ?? b) - b) < 1e-6;

export const isFlatEq = (eq: AudioEq | undefined): boolean => !eq || (near(eq.low, 0) && near(eq.mid, 0) && near(eq.high, 0));

// True when the effects would change nothing - the preview then skips its worklet, the export its filters.
export const isNeutralFx = (fx: AudioFx | undefined): boolean => !fx || (isFlatEq(fx.eq) && !fx.compressor && near(fx.pan, 0));

// What export_trimmed_video takes (services/audio_fx.rs AudioFxSpec), or null for nothing to do.
export function fxForExport(fx: AudioFx | undefined): AudioFx | null {
  if (!fx || isNeutralFx(fx)) return null;
  return {
    ...(fx.eq && !isFlatEq(fx.eq) ? { eq: fx.eq } : {}),
    ...(fx.compressor ? { compressor: fx.compressor } : {}),
    ...(!near(fx.pan, 0) ? { pan: fx.pan } : {}),
  };
}

// Drops neutral parts so a reset strip stores nothing.
export function tidyFx(fx: AudioFx | undefined): AudioFx | undefined {
  return fxForExport(fx) ?? undefined;
}

export const presetMatching = <T extends { id: string }>(presets: (T & { eq?: AudioEq; comp?: AudioCompressor })[], value: AudioEq | AudioCompressor | undefined): string | null => {
  if (!value) return null;
  const same = (a: object, b: object) => Object.entries(a).every(([k, v]) => near((b as Record<string, number>)[k], v as number));
  return presets.find((p) => same((p.eq ?? p.comp) as object, value))?.id ?? null;
};

// The magnitude response of the EQ in dB at `freqs` - the RBJ biquads the worklet and export run,
// for drawing the curve.
export function eqResponseDb(eq: AudioEq, freqs: number[], sampleRate = 48000): number[] {
  const coeffs = [biquad("lowshelf", LOW_SHELF_HZ, eq.low, 1, sampleRate), biquad("peaking", eq.midFreq, eq.mid, eq.midQ, sampleRate), biquad("highshelf", HIGH_SHELF_HZ, eq.high, 1, sampleRate)];
  return freqs.map((f) => {
    const w = (2 * Math.PI * f) / sampleRate;
    let db = 0;
    for (const c of coeffs) {
      // |H(e^jw)|^2 for b0 + b1 z^-1 + b2 z^-2 over 1 + a1 z^-1 + a2 z^-2.
      const cos1 = Math.cos(w);
      const cos2 = Math.cos(2 * w);
      const num = c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2 + 2 * (c.b0 * c.b1 + c.b1 * c.b2) * cos1 + 2 * c.b0 * c.b2 * cos2;
      const den = 1 + c.a1 * c.a1 + c.a2 * c.a2 + 2 * (c.a1 + c.a1 * c.a2) * cos1 + 2 * c.a2 * cos2;
      db += 10 * Math.log10(Math.max(1e-12, num / den));
    }
    return db;
  });
}

function biquad(type: "lowshelf" | "highshelf" | "peaking", freq: number, gainDb: number, width: number, sampleRate: number) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === "peaking") {
    const alpha = sin / (2 * width);
    [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  } else {
    const alpha = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / width - 1) + 2);
    const beta = 2 * Math.sqrt(A);
    if (type === "lowshelf") {
      [b0, b1, b2] = [A * (A + 1 - (A - 1) * cos + beta * alpha), 2 * A * (A - 1 - (A + 1) * cos), A * (A + 1 - (A - 1) * cos - beta * alpha)];
      [a0, a1, a2] = [A + 1 + (A - 1) * cos + beta * alpha, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - beta * alpha];
    } else {
      [b0, b1, b2] = [A * (A + 1 + (A - 1) * cos + beta * alpha), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - beta * alpha)];
      [a0, a1, a2] = [A + 1 - (A - 1) * cos + beta * alpha, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - beta * alpha];
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// The compressor's static curve: output level (dB) for a steady input level (dB) - acompressor's
// gain computer with its knee, for drawing.
export function compressorCurveDb(c: AudioCompressor, inputDb: number): number {
  const thres = (Math.min(0, Math.max(-60.2, c.threshold)) * Math.LN10) / 20;
  const ratio = Math.min(20, Math.max(1, c.ratio));
  const knee = Math.min(8, Math.max(1, Math.pow(10, c.knee / 20)));
  const kneeStart = thres - Math.log(Math.sqrt(knee));
  const kneeStop = thres + Math.log(Math.sqrt(knee));
  const slope = (inputDb * Math.LN10) / 20;
  let out = slope;
  if (slope > kneeStart) {
    out = (slope - thres) / ratio + thres;
    if (knee > 1 && slope < kneeStop) {
      const compressedKneeStop = (kneeStop - thres) / ratio + thres;
      const width = kneeStop - kneeStart;
      const t = (slope - kneeStart) / width;
      const [p0, p1, m0, m1] = [kneeStart, compressedKneeStop, width, width / ratio];
      out = (2 * p0 + m0 - 2 * p1 + m1) * t * t * t + (-3 * p0 - 2 * m0 + 3 * p1 - m1) * t * t + m0 * t + p0;
    }
  }
  return (out * 20) / Math.LN10 + Math.min(36, Math.max(0, c.makeup));
}

// ---- Mixer channels --------------------------------------------------------------------------

// Which strip an audio track belongs to: its name ("Music", "Voice", a library title), or its
// file for one the user added. Pieces cut from the same track share it.
export const audioChannelKey = (o: Pick<AudioOverlay, "label" | "src" | "library">): string => (o.label ? `label:${o.label}` : `src:${o.src}`);

export const fileStem = (path: string): string => (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, "");

export const audioChannelName = (o: Pick<AudioOverlay, "label" | "src" | "library">): string => o.label ?? o.library?.title ?? fileStem(o.src);

export const linearToDb = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);
