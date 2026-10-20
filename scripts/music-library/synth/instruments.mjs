// Pitched instruments. Each renders one note additively into a Stereo bus:
//   inst(out, { t, dur, midi, vel, pan }, options)
// t/dur in seconds; vel 0..1. Levels are relative - the mixer normalizes each layer afterwards.
import { SR, TAU, Svf, clamp, fsin, mtof, panGains, rng } from "./dsp.mjs";

const span = (out, t, seconds) => {
  const start = Math.max(0, Math.round(t * SR));
  return [start, Math.max(0, Math.min(out.length - start, Math.round(seconds * SR)))];
};

// Attack, then exponential decay towards `sustain`, then exponential release after dur.
function adsr(tt, dur, a, d, s, r) {
  const x = tt < dur ? tt : dur;
  const v = x < a ? x / a : s + (1 - s) * Math.exp(-(x - a) / d);
  return tt < dur ? v : v * Math.exp(-(tt - dur) / r);
}

// Band-limited saw step correction.
function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// Sum of decaying sine partials via recursive oscillators (no Math.sin in the loop).
// partials: [{ ratio, amp, decay (s), detune? }]
function additive(out, { t, dur, midi, vel = 0.8, pan = 0 }, partials, { attack = 0.002, release = 0.25, gain = 0.4, hammer = 0, seed = 1 } = {}) {
  const f0 = mtof(midi);
  const longest = Math.max(...partials.map((p) => p.decay));
  const [start, len] = span(out, t, Math.min(dur + release * 6, longest * 7 + 0.05));
  const [gl, gr] = panGains(pan);
  const ps = partials.filter((p) => f0 * p.ratio < SR * 0.45);
  const osc = ps.map((p) => {
    const w = (TAU * f0 * p.ratio) / SR;
    return { c: 2 * Math.cos(w), y1: Math.sin(-w), y2: Math.sin(-2 * w), amp: p.amp, k: Math.exp(-1 / (p.decay * SR)), e: 1 };
  });
  const relK = Math.exp(-1 / (release * SR));
  const atk = Math.max(1, attack * SR);
  const endS = dur * SR;
  const noise = rng(seed);
  let relEnv = 1;
  let hp = 0;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let j = 0; j < osc.length; j++) {
      const o = osc[j];
      const y = o.c * o.y1 - o.y2;
      o.y2 = o.y1;
      o.y1 = y;
      o.e *= o.k;
      s += y * o.amp * o.e;
    }
    if (hammer && i < 2000) {
      const n = noise.bi();
      hp = hp * 0.6 + n * 0.4;
      s += (n - hp) * hammer * Math.exp(-i / 150);
    }
    if (i > endS) relEnv *= relK;
    const v = s * Math.min(1, i / atk) * relEnv * vel * gain;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

// Acoustic-ish grand: slightly stretched partials, brighter when struck harder, upper partials
// dying first, plus a little hammer noise.
export function piano(out, note, { bright = 1 } = {}) {
  const f = mtof(note.midi);
  const base = clamp(3.2 * Math.sqrt(261.6 / f), 0.7, 6);
  const v = note.vel ?? 0.8;
  const partials = [];
  for (let n = 1; n <= 12; n++) {
    partials.push({ ratio: n * Math.sqrt(1 + 0.00035 * n * n), amp: (1 / n ** 1.15) * (n === 1 ? 1 : (0.35 + 0.65 * v * bright) ** (n * 0.45)), decay: base / (1 + 0.32 * (n - 1)) });
  }
  // A second string a hair sharp on the fundamental and 2nd partial - the chorus of a real unison.
  partials.push({ ratio: 1.0011, amp: 0.45, decay: base * 1.1 }, { ratio: 2.0024, amp: 0.15, decay: base * 0.7 });
  additive(out, note, partials, { attack: 0.0015, release: 0.18, gain: 0.32, hammer: 0.05 * v, seed: note.midi * 31 + Math.round(note.t * 1000) });
}

// Rhodes-style electric piano: 2-operator FM with a bell "tine" on the attack and stereo tremolo.
export function epiano(out, { t, dur, midi, vel = 0.8, pan = 0 }, { tremolo = 0.12, bark = 1 } = {}) {
  const f = mtof(midi);
  const rel = 0.3;
  const [start, len] = span(out, t, dur + rel * 5);
  const [gl, gr] = panGains(pan);
  const decayK = Math.exp(-1 / ((1.4 + 350 / f) * SR));
  const relK = Math.exp(-1 / (rel * SR));
  const idxK = Math.exp(-5 / SR);
  const tineK = Math.exp(-30 / SR);
  const dc = (TAU * f) / SR;
  const tineF = f * 14.03;
  const dt = tineF < SR * 0.4 ? (TAU * tineF) / SR : 0;
  const dTrem = (TAU * 4.6) / SR;
  const atk = 0.002 * SR;
  const endS = dur * SR;
  let pc = 0;
  let pt = 0;
  let e = 1;
  let ie = 1;
  let te = 0.1 * vel;
  for (let i = 0; i < len; i++) {
    e *= i > endS ? decayK * relK : decayK;
    if (e < 2e-4) break;
    ie *= idxK;
    te *= tineK;
    const index = vel * bark * (1.5 * ie + 0.22);
    let s = fsin(pc + fsin(pc) * index);
    if (dt) s += te * fsin(pt);
    pc += dc;
    pt += dt;
    const trem = tremolo * fsin(dTrem * i);
    const v = s * e * (i < atk ? i / atk : 1) * vel * 0.45;
    out.L[start + i] += v * gl * (1 + trem);
    out.R[start + i] += v * gr * (1 - trem);
  }
}

// Detuned-saw ensemble. Pads, strings and big synth chords.
export function sawEnsemble(out, { t, dur, midi, vel = 0.8, pan = 0 }, { voices = 5, detuneCents = 14, attack = 0.5, decay = 1, sustain = 0.85, release = 1.2, width = 0.7, vibrato = 0, vibratoRate = 5.2, seed = 7, octaveSub = 0 } = {}) {
  const f = mtof(midi);
  const [start, len] = span(out, t, dur + release * 4);
  const r = rng(seed + midi * 97);
  const vs = Array.from({ length: voices }, (_, k) => {
    const spread = voices === 1 ? 0 : k / (voices - 1) - 0.5;
    const fr = f * 2 ** ((spread * 2 * detuneCents) / 1200);
    const [gl, gr] = panGains(clamp(pan + spread * 2 * width, -1, 1));
    return { dt: fr / SR, ph: r(), gl, gr };
  });
  const sub = octaveSub ? { dt: f / 2 / SR, ph: 0 } : null;
  const norm = 1 / Math.sqrt(voices);
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    const env = adsr(tt, dur, attack, decay, sustain, release) * vel * norm * 0.5;
    const vib = vibrato ? 1 + vibrato * fsin(TAU * vibratoRate * tt) * Math.min(1, tt / 0.4) : 1;
    let l = 0;
    let rr = 0;
    for (let k = 0; k < vs.length; k++) {
      const v = vs[k];
      const d = v.dt * vib;
      v.ph += d;
      if (v.ph >= 1) v.ph -= 1;
      const s = 2 * v.ph - 1 - blep(v.ph, d);
      l += s * v.gl;
      rr += s * v.gr;
    }
    if (sub) {
      sub.ph += sub.dt;
      if (sub.ph >= 1) sub.ph -= 1;
      const s = fsin(TAU * sub.ph) * octaveSub;
      l += s;
      rr += s;
    }
    out.L[start + i] += l * env;
    out.R[start + i] += rr * env;
  }
}

// Karplus-Strong plucked string, fractionally tuned with an allpass. Guitar, harp, ukulele.
export function pluck(out, { t, dur, midi, vel = 0.8, pan = 0 }, { bright = 0.6, sustain = 2.5, mute = 0.12, pickPos = 0.18, seed = 3 } = {}) {
  const f = mtof(midi);
  const period = SR / f;
  const N = Math.max(2, Math.floor(period - 0.5));
  const frac = period - N - 0.5;
  const C = (1 - frac) / (1 + frac);
  const line = new Float32Array(N);
  const r = rng(seed + midi * 13 + Math.round(t * 997));
  // Excitation: noise softened by velocity/brightness, with a pick-position comb.
  let lp = 0;
  const a = clamp(0.15 + bright * 0.6 * (0.5 + vel * 0.5), 0.05, 0.95);
  for (let i = 0; i < N; i++) {
    lp += a * (r.bi() - lp);
    line[i] = lp;
  }
  const pick = Math.max(1, Math.round(N * pickPos));
  for (let i = N - 1; i >= pick; i--) line[i] -= line[i - pick] * 0.9;
  const lossOn = 10 ** (-3 / (sustain * f));
  const lossOff = 10 ** (-3 / (mute * f));
  const [start, len] = span(out, t, Math.min(sustain * 1.5, dur + mute * 4 + 0.02) + 0.01);
  const [gl, gr] = panGains(pan);
  const endS = dur * SR;
  let idx = 0;
  let last = 0;
  let apX = 0;
  let apY = 0;
  for (let i = 0; i < len; i++) {
    const cur = line[idx];
    const loss = i < endS ? lossOn : lossOff;
    const avg = 0.5 * (cur + last) * loss;
    last = cur;
    const y = C * avg + apX - C * apY;
    apX = avg;
    apY = y;
    line[idx] = y;
    idx = idx + 1 >= N ? 0 : idx + 1;
    const v = cur * vel * 0.6;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

// Subtractive mono synth: saw/square through an enveloped low-pass. Basses and leads.
export function subtractive(out, { t, dur, midi, vel = 0.8, pan = 0 }, { wave = "saw", cutoff = 900, envAmt = 2400, filterDecay = 0.22, q = 0.9, attack = 0.004, decay = 0.4, sustain = 0.8, release = 0.12, sub = 0, drive = 1.2, vibrato = 0, detuneCents = 0, glideFrom = 0 } = {}) {
  const f = mtof(midi);
  const [start, len] = span(out, t, dur + release * 6);
  const [gl, gr] = panGains(pan);
  const svf = new Svf();
  const detuned = detuneCents ? 2 ** (detuneCents / 1200) : 0;
  let ph = 0;
  let ph2 = 0.37;
  let phs = 0;
  const norm = Math.tanh(drive);
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    if ((i & 15) === 0) svf.setCutoff(cutoff + envAmt * vel * Math.exp(-tt / filterDecay), q);
    const vib = vibrato ? 1 + vibrato * fsin(TAU * 5.5 * tt) * clamp((tt - 0.15) / 0.3, 0, 1) : 1;
    const glide = glideFrom ? 2 ** ((glideFrom * Math.exp(-tt / 0.06)) / 12) : 1;
    const fr = f * vib * glide;
    const d = fr / SR;
    ph += d;
    if (ph >= 1) ph -= 1;
    let s = wave === "square" ? (ph < 0.5 ? 1 : -1) + blep(ph, d) - blep((ph + 0.5) % 1, d) : 2 * ph - 1 - blep(ph, d);
    if (detuned) {
      const d2 = d * detuned;
      ph2 += d2;
      if (ph2 >= 1) ph2 -= 1;
      s = 0.6 * s + 0.6 * (2 * ph2 - 1 - blep(ph2, d2));
    }
    let x = svf.low(s);
    if (sub) {
      phs += d / 2;
      if (phs >= 1) phs -= 1;
      x += fsin(TAU * phs) * sub;
    }
    x = Math.tanh(x * drive) / norm;
    const v = x * adsr(tt, dur, attack, decay, sustain, release) * vel * 0.5;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

// 808-style bass: a sine with a short pitch drop and saturation.
export function bass808(out, { t, dur, midi, vel = 0.9, pan = 0 }, { drive = 2.2, decay = 1.1 } = {}) {
  const f = mtof(midi);
  const [start, len] = span(out, t, dur + 0.5);
  const [gl, gr] = panGains(pan);
  let ph = 0;
  const norm = Math.tanh(drive);
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    ph += (f * (1 + 0.8 * Math.exp(-tt / 0.025))) / SR;
    const amp = Math.min(1, tt / 0.003) * Math.exp(-tt / decay) * (tt > dur ? Math.exp(-(tt - dur) / 0.06) : 1);
    const v = (Math.tanh(fsin(TAU * ph) * drive) / norm) * amp * vel * 0.6;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

// Struck bars and bells, from measured partial ratios.
const MALLETS = {
  marimba: [
    { ratio: 1, amp: 1, decay: 0.55 },
    { ratio: 3.99, amp: 0.3, decay: 0.12 },
    { ratio: 9.2, amp: 0.08, decay: 0.04 },
  ],
  kalimba: [
    { ratio: 1, amp: 1, decay: 1.1 },
    { ratio: 5.92, amp: 0.18, decay: 0.12 },
    { ratio: 9.1, amp: 0.06, decay: 0.05 },
  ],
  glock: [
    { ratio: 1, amp: 1, decay: 2.2 },
    { ratio: 2.76, amp: 0.35, decay: 0.9 },
    { ratio: 5.4, amp: 0.16, decay: 0.5 },
    { ratio: 8.93, amp: 0.07, decay: 0.3 },
  ],
  vibes: [
    { ratio: 1, amp: 1, decay: 2.8 },
    { ratio: 4, amp: 0.12, decay: 0.6 },
    { ratio: 10, amp: 0.03, decay: 0.2 },
  ],
  celesta: [
    { ratio: 1, amp: 1, decay: 1.4 },
    { ratio: 2, amp: 0.25, decay: 0.7 },
    { ratio: 3, amp: 0.1, decay: 0.3 },
    { ratio: 4.1, amp: 0.05, decay: 0.2 },
  ],
};

export function mallet(out, note, { kind = "marimba", decayScale = 1 } = {}) {
  const parts = MALLETS[kind].map((p) => ({ ...p, decay: p.decay * decayScale * clamp(Math.sqrt(523 / mtof(note.midi)), 0.5, 2) }));
  additive(out, note, parts, { attack: 0.001, release: 0.08, gain: 0.45, hammer: kind === "kalimba" ? 0.04 : 0.015, seed: note.midi });
}

// FM bell - inharmonic, long ring.
export function bell(out, { t, dur, midi, vel = 0.7, pan = 0 }, { ratio = 3.5, index = 2.2, decay = 3.5 } = {}) {
  const f = mtof(midi);
  const [start, len] = span(out, t, Math.max(dur, decay * 4));
  const [gl, gr] = panGains(pan);
  const dc = (TAU * f) / SR;
  const dm = dc * ratio;
  let pc = 0;
  let pm = 0;
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    const s = fsin(pc + fsin(pm) * index * Math.exp(-tt / (decay * 0.35)));
    pc += dc;
    pm += dm;
    if (pc > 1e4) {
      pc %= TAU;
      pm %= TAU;
    }
    const v = s * Math.min(1, tt / 0.001) * Math.exp(-tt / decay) * vel * 0.35;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

// A soft sine pad layer (organ-ish warmth under ambient tracks).
export function warmPad(out, { t, dur, midi, vel = 0.7, pan = 0 }, { attack = 1.5, release = 2.5 } = {}) {
  const f = mtof(midi);
  const [start, len] = span(out, t, dur + release * 3.5);
  const [gl, gr] = panGains(pan);
  const w = (TAU * f) / SR;
  const wl = (TAU * 0.13) / SR;
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    const env = adsr(tt, dur, attack, 2, 0.9, release) * vel * 0.3;
    if (tt > dur && env < 5e-4) break;
    const s = fsin(w * i) + 0.35 * fsin(w * 2.003 * i + 1) + 0.15 * fsin(w * 3.01 * i + 2);
    const lfo = 0.15 * fsin(wl * i);
    out.L[start + i] += s * (1 + lfo) * env * gl;
    out.R[start + i] += s * (1 - lfo) * env * gr;
  }
}

export const INSTRUMENTS = { piano, epiano, sawEnsemble, pluck, subtractive, bass808, mallet, bell, warmPad };
