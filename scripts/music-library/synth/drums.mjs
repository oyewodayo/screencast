// Drum and percussion one-shots, synthesized once per kit and reused for every hit.
import { SR, TAU, Biquad, clamp, eqMono, rng } from "./dsp.mjs";

const len = (sec) => new Float32Array(Math.round(sec * SR));

function kick({ start = 150, end = 48, pitchDecay = 0.045, ampDecay = 0.32, click = 0.35, drive = 1.6, length = 0.6 } = {}) {
  const out = len(length);
  const r = rng(11);
  let ph = 0;
  const norm = Math.tanh(drive);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    ph += (end + (start - end) * Math.exp(-t / pitchDecay)) / SR;
    const body = Math.sin(TAU * ph) * Math.exp(-t / ampDecay);
    const c = r.bi() * Math.exp(-t / 0.0025) * click;
    out[i] = Math.tanh((body + c) * drive) / norm;
  }
  return eqMono(out, "highpass", 28);
}

function snare({ tone = 190, toneDecay = 0.07, noiseDecay = 0.16, toneAmt = 0.55, bright = 5500, length = 0.5, seed = 5 } = {}) {
  const out = len(length);
  const r = rng(seed);
  const hp = new Biquad("highpass", 900);
  const pk = new Biquad("peak", 3200, 1, 4);
  const lp = new Biquad("lowpass", bright);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    ph += (tone * (1 + 0.4 * Math.exp(-t / 0.01))) / SR;
    const body = (1 - 4 * Math.abs((ph % 1) - 0.5)) * Math.exp(-t / toneDecay) * toneAmt;
    const n = lp.process(pk.process(hp.process(r.bi()))) * Math.exp(-t / noiseDecay);
    out[i] = body + n * 0.9;
  }
  return out;
}

function clap({ decay = 0.14, freq = 1150, seed = 9 } = {}) {
  const out = len(0.5);
  const r = rng(seed);
  const bp = new Biquad("bandpass", freq, 1.4);
  const bursts = [0, 0.011, 0.023, 0.034];
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let env = 0;
    for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) / 0.006));
    if (t >= bursts[3]) env = Math.max(env, 0.7 * Math.exp(-(t - bursts[3]) / decay));
    out[i] = bp.process(r.bi()) * env * 2.2;
  }
  return out;
}

// 808-style metallic hat: six detuned square waves plus noise, band-passed high.
function hat({ decay = 0.045, length = 0.4, tone = 1, seed = 13 } = {}) {
  const out = len(length);
  const r = rng(seed);
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 1.7 * tone);
  const ph = new Float64Array(6);
  const bp = new Biquad("bandpass", 10000, 0.9);
  const hp = new Biquad("highpass", 7000);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let m = 0;
    for (let k = 0; k < 6; k++) {
      ph[k] += freqs[k] / SR;
      m += ph[k] % 1 < 0.5 ? 1 : -1;
    }
    const x = m / 6 * 0.6 + r.bi() * 0.5;
    out[i] = hp.process(bp.process(x)) * Math.exp(-t / decay) * 1.6;
  }
  return out;
}

function shaker({ seed = 17 } = {}) {
  const out = len(0.16);
  const r = rng(seed);
  const bp = new Biquad("bandpass", 6500, 1.2);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.018) * Math.exp(-Math.max(0, t - 0.018) / 0.045);
    out[i] = bp.process(r.bi()) * env * 1.5;
  }
  return out;
}

function rim() {
  const out = len(0.08);
  const r = rng(19);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] = (Math.sin(TAU * 1750 * t) * 0.7 + Math.sin(TAU * 520 * t) * 0.4 + r.bi() * 0.4) * Math.exp(-t / 0.012);
  }
  return eqMono(out, "highpass", 300);
}

function snap() {
  const out = len(0.12);
  const r = rng(23);
  const bp = new Biquad("bandpass", 2300, 2.5);
  for (let i = 0; i < out.length; i++) out[i] = bp.process(r.bi()) * Math.exp(-i / SR / 0.018) * 3;
  return out;
}

function tom({ freq = 110, decay = 0.35, length = 0.9, noise = 0.15, seed = 29 } = {}) {
  const out = len(length);
  const r = rng(seed);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    ph += (freq * (1 + 0.5 * Math.exp(-t / 0.03))) / SR;
    out[i] = Math.sin(TAU * ph) * Math.exp(-t / decay) + r.bi() * noise * Math.exp(-t / 0.02);
  }
  return out;
}

function cymbal({ decay = 1.6, length = 3, seed = 31 } = {}) {
  const out = len(length);
  const r = rng(seed);
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 2.3);
  const ph = new Float64Array(6);
  const hp = new Biquad("highpass", 4500);
  const lp = new Biquad("lowpass", 13000);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let m = 0;
    for (let k = 0; k < 6; k++) {
      ph[k] += freqs[k] / SR;
      m += ph[k] % 1 < 0.5 ? 1 : -1;
    }
    const env = Math.min(1, t / 0.002) * (0.6 * Math.exp(-t / decay) + 0.4 * Math.exp(-t / 0.2));
    out[i] = lp.process(hp.process(m / 6 * 0.5 + r.bi())) * env;
  }
  return out;
}

// Tuned to the feel of each genre.
const KITS = {
  pop: () => ({ kick: kick({ start: 160, end: 50, ampDecay: 0.3 }), snare: snare({ tone: 200, noiseDecay: 0.17 }), clap: clap(), hat: hat(), openHat: hat({ decay: 0.28, seed: 14 }), shaker: shaker(), crash: cymbal(), tom: tom({ freq: 120 }) }),
  house: () => ({ kick: kick({ start: 170, end: 47, ampDecay: 0.26, drive: 2.2, click: 0.45 }), snare: snare({ tone: 210, noiseDecay: 0.12 }), clap: clap({ decay: 0.16 }), hat: hat({ decay: 0.035 }), openHat: hat({ decay: 0.22, seed: 14 }), shaker: shaker(), crash: cymbal(), tom: tom() }),
  lofi: () => ({ kick: kick({ start: 120, end: 52, ampDecay: 0.24, click: 0.15, drive: 1.3 }), snare: snare({ tone: 175, noiseDecay: 0.14, bright: 3800, toneAmt: 0.7 }), clap: snap(), hat: hat({ decay: 0.03, tone: 0.8 }), openHat: hat({ decay: 0.18, tone: 0.8, seed: 14 }), shaker: shaker(), crash: cymbal({ decay: 1.2 }), tom: tom({ freq: 100 }), rim: rim() }),
  hiphop: () => ({ kick: kick({ start: 140, end: 46, ampDecay: 0.36, drive: 2, click: 0.25 }), snare: snare({ tone: 185, noiseDecay: 0.2, toneAmt: 0.65 }), clap: clap({ decay: 0.18 }), hat: hat({ decay: 0.04 }), openHat: hat({ decay: 0.2, seed: 14 }), shaker: shaker(), crash: cymbal(), tom: tom(), rim: rim() }),
  synthwave: () => ({ kick: kick({ start: 155, end: 50, ampDecay: 0.3, drive: 1.8 }), snare: snare({ tone: 200, noiseDecay: 0.32, toneAmt: 0.5, length: 0.6 }), clap: clap({ decay: 0.2 }), hat: hat({ decay: 0.04 }), openHat: hat({ decay: 0.25, seed: 14 }), shaker: shaker(), crash: cymbal({ decay: 2 }), tom: tom({ freq: 95, decay: 0.45 }) }),
  acoustic: () => ({ kick: kick({ start: 110, end: 55, ampDecay: 0.22, click: 0.2, drive: 1.2 }), snare: snare({ tone: 220, noiseDecay: 0.13, bright: 7000 }), clap: clap({ decay: 0.12 }), hat: hat({ decay: 0.03 }), openHat: hat({ decay: 0.2, seed: 14 }), shaker: shaker(), crash: cymbal(), tom: tom(), snap: snap() }),
  cinematic: () => ({ kick: kick({ start: 90, end: 38, ampDecay: 0.7, click: 0.3, drive: 1.5, length: 1.4 }), snare: snare({ tone: 170, noiseDecay: 0.25, toneAmt: 0.6, length: 0.7 }), clap: clap(), hat: hat({ decay: 0.03 }), openHat: hat({ decay: 0.3, seed: 14 }), shaker: shaker(), crash: cymbal({ decay: 2.6, length: 4 }), tom: tom({ freq: 70, decay: 0.7, length: 1.6, noise: 0.25 }), taiko: tom({ freq: 58, decay: 0.9, length: 2, noise: 0.35, seed: 37 }) }),
  soft: () => ({ kick: kick({ start: 100, end: 50, ampDecay: 0.2, click: 0.08, drive: 1.1 }), snare: rim(), clap: snap(), hat: hat({ decay: 0.025, tone: 0.9 }), openHat: hat({ decay: 0.15, seed: 14 }), shaker: shaker(), crash: cymbal({ decay: 1.2 }), tom: tom({ freq: 140, decay: 0.2 }), rim: rim() }),
};

const cache = new Map();
export function kit(name) {
  if (!cache.has(name)) cache.set(name, KITS[name]());
  return cache.get(name);
}

// Vinyl crackle + hiss bed for lo-fi, `seconds` long.
export function vinyl(seconds, seed = 41) {
  const out = len(seconds);
  const r = rng(seed);
  const lp = new Biquad("lowpass", 5000);
  const hp = new Biquad("highpass", 300);
  for (let i = 0; i < out.length; i++) {
    let x = r.bi() * 0.04;
    if (r() < 0.0009) x += r.bi() * clamp(r() * 1.5, 0.2, 1);
    out[i] = hp.process(lp.process(x));
  }
  return out;
}

// White-noise riser that sweeps up over `seconds`, ending at full level.
export function noiseRiser(seconds, seed = 43) {
  const out = len(seconds);
  const r = rng(seed);
  const bp = new Biquad("bandpass", 400, 1.2);
  for (let i = 0; i < out.length; i++) {
    const u = i / out.length;
    if ((i & 31) === 0) bp.set(300 * 2 ** (u * 5.2));
    out[i] = bp.process(r.bi()) * u ** 2.2 * 1.6;
  }
  return out;
}
