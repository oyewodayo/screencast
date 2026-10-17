// DSP building blocks for the Briefcast Originals synth: buffers, filters, effects and the master
// chain. Everything is plain Float32Array maths at 44.1 kHz - deterministic, no dependencies.

export const SR = 44100;
export const TAU = 2 * Math.PI;
export const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
export const dbToGain = (db) => 10 ** (db / 20);
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// Table sine with linear interpolation (error ~1e-8) - several times faster than Math.sin in the
// per-sample synth loops.
const TBL = 8192;
const SIN = new Float64Array(TBL + 1);
for (let i = 0; i <= TBL; i++) SIN[i] = Math.sin((i / TBL) * 2 * Math.PI);
const TO_IDX = TBL / (2 * Math.PI);
export function fsin(x) {
  let p = x * TO_IDX;
  p -= Math.floor(p / TBL) * TBL;
  const i = p | 0;
  return SIN[i] + (SIN[i + 1] - SIN[i]) * (p - i);
}

// xorshift32 - seeded so every render is byte-identical.
export function rng(seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
  next.range = (a, b) => a + (b - a) * next();
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.chance = (p) => next() < p;
  next.bi = () => next() * 2 - 1;
  return next;
}

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class Stereo {
  constructor(n) {
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
  }
  get length() {
    return this.L.length;
  }
  mixIn(src, gain = 1, offset = 0) {
    const n = Math.min(src.length, this.length - offset);
    for (let i = Math.max(0, -offset); i < n; i++) {
      this.L[i + offset] += src.L[i] * gain;
      this.R[i + offset] += src.R[i] * gain;
    }
    return this;
  }
  scale(g) {
    for (let i = 0; i < this.length; i++) {
      this.L[i] *= g;
      this.R[i] *= g;
    }
    return this;
  }
  // Multiplies by a per-sample gain curve gain(i).
  shape(gainAt) {
    for (let i = 0; i < this.length; i++) {
      const g = gainAt(i);
      this.L[i] *= g;
      this.R[i] *= g;
    }
    return this;
  }
}

// Equal-power pan, -1 (left) .. 1 (right).
export function panGains(pan) {
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

// Adds a mono sample array into a stereo buffer at time t (seconds).
export function placeMono(out, samples, t, gain = 1, pan = 0) {
  const start = Math.round(t * SR);
  const [gl, gr] = panGains(pan);
  const n = Math.min(samples.length, out.length - start);
  for (let i = Math.max(0, -start); i < n; i++) {
    const v = samples[i] * gain;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

// ---- Filters ---------------------------------------------------------------------------------

// RBJ cookbook biquad, transposed direct form II.
export class Biquad {
  constructor(type, freq, q = 0.707, gainDb = 0) {
    this.type = type;
    this.q = q;
    this.gainDb = gainDb;
    this.z1 = 0;
    this.z2 = 0;
    this.set(freq);
  }
  set(freq, q = this.q, gainDb = this.gainDb) {
    this.q = q;
    this.gainDb = gainDb;
    const w0 = (TAU * clamp(freq, 10, SR * 0.49)) / SR;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * q);
    const A = 10 ** (gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (this.type) {
      case "lowpass":
        b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      case "highpass":
        b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      case "bandpass":
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      case "peak":
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
        break;
      case "lowshelf": {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cos + s); b1 = 2 * A * (A - 1 - (A + 1) * cos); b2 = A * (A + 1 - (A - 1) * cos - s);
        a0 = A + 1 + (A - 1) * cos + s; a1 = -2 * (A - 1 + (A + 1) * cos); a2 = A + 1 + (A - 1) * cos - s;
        break;
      }
      case "highshelf": {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cos + s); b1 = -2 * A * (A - 1 + (A + 1) * cos); b2 = A * (A + 1 + (A - 1) * cos - s);
        a0 = A + 1 - (A - 1) * cos + s; a1 = 2 * (A - 1 - (A + 1) * cos); a2 = A + 1 - (A - 1) * cos - s;
        break;
      }
      default:
        throw new Error(`Unknown filter ${this.type}`);
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

export function eq(buf, type, freq, q = 0.707, gainDb = 0) {
  for (const ch of [buf.L, buf.R]) {
    const f = new Biquad(type, freq, q, gainDb);
    for (let i = 0; i < ch.length; i++) ch[i] = f.process(ch[i]);
  }
  return buf;
}

export function eqMono(arr, type, freq, q = 0.707, gainDb = 0) {
  const f = new Biquad(type, freq, q, gainDb);
  for (let i = 0; i < arr.length; i++) arr[i] = f.process(arr[i]);
  return arr;
}

// A filter whose cutoff follows freqAt(seconds) - coefficients refreshed every 32 samples.
export function sweep(buf, type, freqAt, q = 0.707, from = 0, to = buf.length) {
  const fl = new Biquad(type, freqAt(from / SR), q);
  const fr = new Biquad(type, freqAt(from / SR), q);
  for (let i = from; i < to; i++) {
    if (((i - from) & 31) === 0) {
      const f = freqAt(i / SR);
      fl.set(f);
      fr.set(f);
    }
    buf.L[i] = fl.process(buf.L[i]);
    buf.R[i] = fr.process(buf.R[i]);
  }
  return buf;
}

// Zavalishin TPT state-variable filter (stable under fast modulation) - per-voice filters.
export class Svf {
  constructor() {
    this.ic1 = 0;
    this.ic2 = 0;
    this.setCutoff(1000, 0.7);
  }
  setCutoff(fc, q = 0.7) {
    const g = Math.tan((Math.PI * clamp(fc, 20, SR * 0.45)) / SR);
    const k = 1 / q;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  low(v0) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v2;
  }
}

// ---- Effects ---------------------------------------------------------------------------------

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];

// Freeverb (Jezar's tunings). Returns only the wet signal.
export function reverb(send, { room = 0.82, damp = 0.35, preDelay = 0.02, width = 1 } = {}) {
  const n = send.length;
  const out = new Stereo(n);
  const fb = room * 0.28 + 0.7;
  const d = damp * 0.4;
  const pre = Math.round(preDelay * SR);
  const wet = [new Float32Array(n), new Float32Array(n)];
  [0, 23].forEach((spread, ch) => {
    const combBufs = COMBS.map((len) => new Float32Array(len + spread));
    const combIdx = new Int32Array(COMBS.length);
    const combStore = new Float64Array(COMBS.length);
    const apBufs = ALLPASSES.map((len) => new Float32Array(len + spread));
    const apIdx = new Int32Array(ALLPASSES.length);
    const w = wet[ch];
    for (let s = 0; s < n; s++) {
      const x = s >= pre ? (send.L[s - pre] + send.R[s - pre]) * 0.015 : 0;
      let acc = 0;
      for (let c = 0; c < 8; c++) {
        const b = combBufs[c];
        const i = combIdx[c];
        const y = b[i];
        combStore[c] = y * (1 - d) + combStore[c] * d;
        b[i] = x + combStore[c] * fb;
        combIdx[c] = i + 1 >= b.length ? 0 : i + 1;
        acc += y;
      }
      for (let a = 0; a < 4; a++) {
        const b = apBufs[a];
        const i = apIdx[a];
        const bo = b[i];
        b[i] = acc + bo * 0.5;
        apIdx[a] = i + 1 >= b.length ? 0 : i + 1;
        acc = bo - acc;
      }
      w[s] = acc * 3;
    }
  });
  const w1 = (width / 2 + 0.5) * 1;
  const w2 = (1 - width) / 2;
  for (let s = 0; s < n; s++) {
    out.L[s] = wet[0][s] * w1 + wet[1][s] * w2;
    out.R[s] = wet[1][s] * w1 + wet[0][s] * w2;
  }
  return out;
}

// Tempo-synced ping-pong delay, darkened on every repeat. Wet only.
export function pingPong(send, timeSec, feedback = 0.38, lowpass = 3800) {
  const n = send.length;
  const out = new Stereo(n);
  const d = Math.max(1, Math.round(timeSec * SR));
  const bl = new Float32Array(d);
  const br = new Float32Array(d);
  const fl = new Biquad("lowpass", lowpass);
  const fr = new Biquad("lowpass", lowpass);
  let i = 0;
  for (let s = 0; s < n; s++) {
    const yl = bl[i];
    const yr = br[i];
    bl[i] = fl.process((send.L[s] + send.R[s]) * 0.5 + yr * feedback);
    br[i] = fr.process(yl * feedback);
    out.L[s] = yl;
    out.R[s] = yr;
    i = i + 1 >= d ? 0 : i + 1;
  }
  return out;
}

// Stereo chorus - two modulated delay lines a quarter cycle apart. In place.
export function chorus(buf, { rate = 0.4, depth = 0.0025, base = 0.011, mix = 0.45 } = {}) {
  const max = Math.ceil((base + depth) * SR) + 4;
  const size = 1 << Math.ceil(Math.log2(max + 1));
  const mask = size - 1;
  const dl = new Float32Array(size);
  const dr = new Float32Array(size);
  let w = 0;
  for (let s = 0; s < buf.length; s++) {
    dl[w] = buf.L[s];
    dr[w] = buf.R[s];
    const ph = (TAU * rate * s) / SR;
    const tapL = (base + depth * Math.sin(ph)) * SR;
    const tapR = (base + depth * Math.cos(ph)) * SR;
    const read = (line, tap) => {
      const pos = w - tap;
      const i0 = Math.floor(pos);
      const f = pos - i0;
      return line[i0 & mask] * (1 - f) + line[(i0 + 1) & mask] * f;
    };
    buf.L[s] = buf.L[s] * (1 - mix) + read(dl, tapL) * mix;
    buf.R[s] = buf.R[s] * (1 - mix) + read(dr, tapR) * mix;
    w = (w + 1) & mask;
  }
  return buf;
}

// Tape wow - slow pitch drift for lo-fi. In place.
export function wow(buf, { rate = 0.55, depthSec = 0.0012 } = {}) {
  const size = 4096;
  const mask = size - 1;
  const dl = new Float32Array(size);
  const dr = new Float32Array(size);
  let w = 0;
  for (let s = 0; s < buf.length; s++) {
    dl[w] = buf.L[s];
    dr[w] = buf.R[s];
    const tap = (depthSec * (1.2 + Math.sin((TAU * rate * s) / SR) + 0.3 * Math.sin((TAU * rate * 2.7 * s) / SR))) * SR;
    const pos = w - tap;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    buf.L[s] = dl[i0 & mask] * (1 - f) + dl[(i0 + 1) & mask] * f;
    buf.R[s] = dr[i0 & mask] * (1 - f) + dr[(i0 + 1) & mask] * f;
    w = (w + 1) & mask;
  }
  return buf;
}

export function saturate(buf, drive = 1.5) {
  const norm = Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) {
    buf.L[i] = Math.tanh(buf.L[i] * drive) / norm;
    buf.R[i] = Math.tanh(buf.R[i] * drive) / norm;
  }
  return buf;
}

// Feed-forward compressor, stereo-linked, soft knee.
export function compress(buf, { threshDb = -16, ratio = 2.5, attack = 0.01, release = 0.15, kneeDb = 6, makeupDb = 0 } = {}) {
  const ta = Math.exp(-1 / (attack * SR));
  const tr = Math.exp(-1 / (release * SR));
  let env = 0;
  for (let i = 0; i < buf.length; i++) {
    const level = Math.max(Math.abs(buf.L[i]), Math.abs(buf.R[i]));
    env = level > env ? ta * env + (1 - ta) * level : tr * env + (1 - tr) * level;
    const db = 20 * Math.log10(env + 1e-9);
    const over = db - threshDb;
    let gr = 0;
    if (over > kneeDb / 2) gr = over * (1 - 1 / ratio);
    else if (over > -kneeDb / 2) gr = ((over + kneeDb / 2) ** 2 / (2 * kneeDb)) * (1 - 1 / ratio);
    const g = dbToGain(makeupDb - gr);
    buf.L[i] *= g;
    buf.R[i] *= g;
  }
  return buf;
}

// Brick-wall limiter: per-sample gain that never lets a peak past `ceiling`, ramped down over the
// lookahead before each peak (no clicks) and recovering over `release`.
export function limit(buf, ceiling = 0.95, lookahead = 0.004, release = 0.12) {
  const n = buf.length;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(buf.L[i]), Math.abs(buf.R[i]));
    g[i] = p > ceiling ? ceiling / p : 1;
  }
  const la = Math.max(1, Math.round(lookahead * SR));
  const step = 1 / la;
  for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + step);
  const rel = 1 / (release * SR);
  for (let i = 1; i < n; i++) g[i] = Math.min(g[i], g[i - 1] + rel);
  for (let i = 0; i < n; i++) {
    buf.L[i] *= g[i];
    buf.R[i] *= g[i];
  }
  return buf;
}

// Loudness of the parts of a buffer that actually play: the mean power of its loudest 40% of 50 ms
// windows. Lets every layer be set to a target level however loud its raw synthesis came out.
export function activeRmsDb(buf) {
  const win = Math.round(SR * 0.05);
  const powers = [];
  for (let s = 0; s + win <= buf.length; s += win) {
    let p = 0;
    for (let i = s; i < s + win; i++) p += buf.L[i] * buf.L[i] + buf.R[i] * buf.R[i];
    p /= 2 * win;
    if (p > 1e-10) powers.push(p);
  }
  if (powers.length === 0) return -Infinity;
  powers.sort((a, b) => b - a);
  const top = powers.slice(0, Math.max(1, Math.ceil(powers.length * 0.4)));
  return 10 * Math.log10(top.reduce((a, b) => a + b, 0) / top.length);
}

export function normalizeTo(buf, targetDb) {
  const cur = activeRmsDb(buf);
  if (Number.isFinite(cur)) buf.scale(dbToGain(targetDb - cur));
  return buf;
}

export function peakOf(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf.L[i]), Math.abs(buf.R[i]));
  return p;
}

// 24-bit stereo PCM WAV.
export function wavBytes(buf) {
  const n = buf.length;
  const data = Buffer.alloc(n * 6);
  const put = (v, o) => {
    const x = Math.round(clamp(v, -1, 1) * 8388607);
    data.writeIntLE(x, o, 3);
  };
  for (let i = 0; i < n; i++) {
    put(buf.L[i], i * 6);
    put(buf.R[i], i * 6 + 3);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 6, 28);
  h.writeUInt16LE(6, 32);
  h.writeUInt16LE(24, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
