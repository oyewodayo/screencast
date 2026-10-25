// Jazz instruments for the Briefcast Originals: upright bass, breath-driven horns (saxes, trumpet,
// Harmon-muted trumpet, trombone, flute, violin), a tonewheel organ, a vibraphone with its motor,
// and an acoustic jazz kit (partial-bank ride, brushes, feathered kick). Same note signature as
// instruments.mjs:
//   inst(out, { t, dur, midi, vel, pan, ...expression }, options)
// Horns also read per-note expression: legato, glideFrom (semitones), scoop, fall (semitones),
// vib (vibrato multiplier), swell, accent, wah (fn of seconds -> 0 closed .. 1 open).
import { SR, TAU, Biquad, Svf, clamp, eqMono, fsin, mtof, panGains, rng } from "./dsp.mjs";

const span = (out, t, seconds) => {
  const start = Math.max(0, Math.round(t * SR));
  return [start, Math.max(0, Math.min(out.length - start, Math.round(seconds * SR)))];
};

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

// Upright bass: plucked-string partials (pluck-position comb, highs dying fast), the "bloom" of a
// fresh pluck settling, a little sharp at the attack as the string is pulled, a finger thump and
// click, and a fast finger-lift damp at the note's end.
export function upright(out, { t, dur, midi, vel = 0.8, pan = 0, glideFrom = 0 }, { bright = 0.5, sustain = 1.5, thump = 1 } = {}) {
  const f = mtof(midi);
  const r = rng(midi * 977 + Math.round(t * 1543));
  const lift = 0.055;
  const [start, len] = span(out, t, dur + lift * 6);
  const [gl, gr] = panGains(pan);
  const pos = 0.19 + r() * 0.07;
  const sus = sustain * clamp(Math.sqrt(55 / f), 0.5, 1.3);
  const n = [];
  const amp = [];
  const kk = [];
  const e = [];
  const off = [];
  for (let h = 1; h <= 12 && f * h < 4200; h++) {
    n.push(h);
    amp.push(Math.abs(Math.sin(Math.PI * h * pos)) / h ** (1.45 - 0.5 * bright * vel));
    kk.push(Math.exp(-1 / ((sus / (1 + 0.95 * (h - 1) ** 1.15)) * SR)));
    e.push(1);
    off.push(r() * 0.4);
  }
  const P = n.length;
  const relK = Math.exp(-1 / (lift * SR));
  const endS = dur * SR;
  const lp = new Biquad("lowpass", 240, 0.8);
  const hp = new Biquad("highpass", 2200);
  let ph = 0;
  let rel = 1;
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    const bend = 1 + 0.0055 * vel * Math.exp(-tt / 0.03);
    const glide = glideFrom ? 2 ** ((glideFrom * Math.exp(-tt / 0.05)) / 12) : 1;
    ph += (TAU * f * bend * glide) / SR;
    let s = 0;
    for (let k = 0; k < P; k++) {
      e[k] *= kk[k];
      s += fsin(ph * n[k] + off[k]) * amp[k] * e[k];
    }
    const bloom = 0.62 + 0.38 * Math.exp(-tt / 0.085);
    const nz = r.bi();
    const th = tt < 0.08 ? (lp.process(nz) * Math.exp(-tt / 0.013) * 1.5 + hp.process(nz) * Math.exp(-tt / 0.0022) * 0.1) * thump : 0;
    if (i > endS) {
      rel *= relK;
      if (rel < 1e-4) break;
    }
    const v = Math.tanh((s * bloom * Math.min(1, tt / 0.004) + th) * 1.3) * rel * vel * 0.5;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

// Breath-driven horns: a band-limited reed/lip source through a dynamic low-pass (brass and reeds
// brighten as they get louder), fixed body formants, breath noise, a scoop up into the note, delayed
// vibrato, slow pitch drift, tongued accents, legato slurs and fall-offs.
const HORNS = {
  tenor: { wave: "saw", formants: [[520, 1.5, 7], [1350, 2.2, 5], [2550, 3, 3.5]], bright: [1.2, 8.5], breath: 0.075, scoop: 0.6, vibRate: 5.0, vibDepth: 0.2, attack: 0.035, hp: 80 },
  alto: { wave: "saw", formants: [[700, 1.6, 6], [1700, 2.2, 5], [3000, 3, 3]], bright: [1.4, 9.5], breath: 0.06, scoop: 0.45, vibRate: 5.4, vibDepth: 0.19, attack: 0.03, hp: 140 },
  soprano: { wave: "saw", formants: [[950, 1.5, 5], [2150, 2.4, 5], [3600, 3, 3]], bright: [1.6, 8.5], breath: 0.05, scoop: 0.35, vibRate: 5.6, vibDepth: 0.17, attack: 0.03, hp: 200 },
  bari: { wave: "saw", formants: [[380, 1.5, 7], [950, 2.2, 5], [2100, 3, 3]], bright: [1.1, 7], breath: 0.06, scoop: 0.4, vibRate: 4.8, vibDepth: 0.14, attack: 0.04, hp: 50 },
  trumpet: { wave: "saw", formants: [[1250, 1.3, 7], [2500, 2, 5]], bright: [1.5, 13], breath: 0.02, scoop: 0.25, vibRate: 5.8, vibDepth: 0.12, attack: 0.022, hp: 180 },
  harmon: { wave: "saw", formants: [[1800, 3.5, 14], [3400, 3, 7]], bright: [2.5, 10], breath: 0.05, scoop: 0.2, vibRate: 5.2, vibDepth: 0.05, attack: 0.03, hp: 900 },
  trombone: { wave: "saw", formants: [[480, 1.3, 6], [1150, 2, 4]], bright: [1.1, 8], breath: 0.025, scoop: 0.35, vibRate: 5, vibDepth: 0.15, attack: 0.035, hp: 60 },
  flute: { wave: "flute", formants: [[2200, 1, 2]], bright: [3, 6], breath: 0.2, scoop: 0.1, vibRate: 5.1, vibDepth: 0.13, attack: 0.05, hp: 200 },
  violin: { wave: "saw", formants: [[290, 2.5, 7], [520, 2.5, 4], [1100, 3, -4], [2900, 1.4, 6]], bright: [3, 8], breath: 0.03, scoop: 0.3, vibRate: 6, vibDepth: 0.24, attack: 0.06, hp: 180 },
  clarinet: { wave: "square", formants: [[1500, 2, 3], [2600, 2.5, 2]], bright: [1.6, 7], breath: 0.06, scoop: 0.2, vibRate: 5, vibDepth: 0.06, attack: 0.035, hp: 120 },
};

export function horn(out, note, { kind = "tenor", ...over } = {}) {
  const H = { ...HORNS[kind], ...over };
  const { t, dur, midi, vel = 0.8, pan = 0 } = note;
  const f = mtof(midi);
  const rel = note.legato ? 0.035 : 0.07;
  const fallSec = note.fall ? 0.32 : 0;
  const [start, len] = span(out, t, dur + fallSec + rel * 7);
  const [gl, gr] = panGains(pan);
  const r = rng(midi * 131 + Math.round(t * 7919));
  const s1 = new Svf();
  const s2 = new Svf();
  const forms = H.formants.map(([fc, q, g]) => new Biquad("peak", fc, q, g));
  const hp = new Biquad("highpass", H.hp ?? 60);
  const bn = new Biquad("bandpass", clamp(f * 3, 1400, 5200), 0.7);
  const wah = note.wah ? new Biquad("peak", 600, 2.2, 14) : null;
  const attack = note.legato ? 0.012 : H.attack * (1.25 - 0.45 * vel);
  const accent = note.legato ? 0.04 : 0.28 * (note.accent ?? 1) * vel;
  const scoop = note.legato ? 0 : (note.scoop ?? 1) * H.scoop * (0.35 + 0.65 * r());
  const vibDepth = H.vibDepth * (note.vib ?? 1);
  const vibOn = dur > 0.32 && vibDepth > 0;
  const vibDelay = Math.min(0.22, dur * 0.3);
  const vRate = H.vibRate * (0.94 + r() * 0.12);
  const vPh = r() * TAU;
  const endS = dur * SR;
  const fallEnd = endS + fallSec * SR;
  const relK = Math.exp(-1 / (rel * SR));
  const susK = note.swell ? 0 : 1 / 0.7;
  let ph = r();
  let drift = 0;
  let rl = 1;
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    let semi = drift;
    if (scoop) semi -= scoop * Math.exp(-tt / 0.042);
    if (note.glideFrom) semi += note.glideFrom * Math.exp(-tt / 0.028);
    if (vibOn && tt > vibDelay) semi += vibDepth * Math.min(1, (tt - vibDelay) / 0.35) * fsin(TAU * vRate * tt + vPh);
    if (note.fall && tt > dur * 0.6) {
      const u = (tt - dur * 0.6) / (fallSec + dur * 0.4);
      semi -= note.fall * u * u;
    }
    if ((i & 63) === 0) drift += r.bi() * 0.012 - drift * 0.03;
    const fr = f * 2 ** (semi / 12);
    const d = fr / SR;
    ph += d;
    if (ph >= 1) ph -= 1;
    let env = tt < attack ? (tt / attack) ** 1.6 * (1 + accent) : 1 + accent * Math.exp(-(tt - attack) / 0.07);
    env *= note.swell ? 0.62 + 0.38 * Math.min(1, tt / Math.max(0.25, dur * 0.75)) : 0.86 + 0.14 * Math.exp(-tt * susK);
    if (i > (note.fall ? fallEnd : endS)) {
      rl *= relK;
      if (rl < 1e-4) break;
    }
    const fallG = note.fall && tt > dur ? Math.max(0, 1 - (tt - dur) / fallSec) ** 1.5 : 1;
    const a = env * rl * fallG;
    if ((i & 15) === 0) {
      const dyn = clamp(a * vel, 0, 1.25);
      const fc = clamp(fr * (H.bright[0] + H.bright[1] * dyn * dyn), 180, 12000);
      s1.setCutoff(fc, 0.6);
      s2.setCutoff(fc * 1.15, 0.7);
      if (wah) wah.set(450 + 1700 * note.wah(tt));
    }
    let x;
    if (H.wave === "flute") x = fsin(TAU * ph) + 0.24 * fsin(2 * TAU * ph + 0.5) + 0.07 * fsin(3 * TAU * ph + 1.1);
    else if (H.wave === "square") x = ((ph < 0.5 ? 1 : -1) + blep(ph, d) - blep((ph + 0.5) % 1, d)) * 0.7;
    else x = 2 * ph - 1 - blep(ph, d);
    x = s2.low(s1.low(x));
    const nz = bn.process(r.bi()) * H.breath * (0.55 + 1.6 * Math.exp(-tt / 0.03));
    let y = (x + nz) * a;
    for (let k = 0; k < forms.length; k++) y = forms[k].process(y);
    if (wah) y = wah.process(y) * (0.35 + 0.4 * note.wah(tt));
    y = hp.process(y);
    const v = Math.tanh(y * (0.8 + vel)) * 0.5;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

// Tonewheel organ. Drawbar registration as a 9-digit string (16' 5⅓' 8' 4' 2⅔' 2' 1⅗' 1⅓' 1'),
// single-trigger-style 3rd-harmonic percussion, key click on and off. Run the bus through leslie().
const DRAWBARS = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8];
export function organ(out, { t, dur, midi, vel = 0.8, pan = 0 }, { drawbars = "888000000", perc = 0.3, click = 0.05 } = {}) {
  const f = mtof(midi);
  const ws = [];
  const lv = [];
  [...drawbars].forEach((ch, k) => {
    const level = Number(ch) / 8;
    let fr = f * DRAWBARS[k];
    while (fr > 5900) fr /= 2; // tonewheel foldback
    if (level > 0) {
      ws.push((TAU * fr * (1 + (k - 4) * 0.0004)) / SR);
      lv.push(level * 0.32);
    }
  });
  const [start, len] = span(out, t, dur + 0.05);
  const [gl, gr] = panGains(pan);
  const r = rng(midi * 17 + Math.round(t * 313));
  const wp = (TAU * f * 3) / SR;
  const endS = dur * SR;
  const ck = new Biquad("highpass", 1200);
  const amp = 0.55 + 0.45 * vel;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let k = 0; k < ws.length; k++) s += fsin(ws[k] * i) * lv[k];
    const tt = i / SR;
    if (perc) s += fsin(wp * i) * perc * Math.exp(-tt / 0.2);
    let env = Math.min(1, tt / 0.004);
    if (i > endS) env *= Math.exp(-(i - endS) / (0.009 * SR));
    const nz = ck.process(r.bi());
    const c = click * (Math.exp(-tt / 0.0015) + (i > endS ? 0.5 * Math.exp(-(i - endS) / (0.001 * SR)) : 0));
    const v = (s * env + nz * c) * amp;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

// Vibraphone: tuned bars (1 : 4 : 10), soft yarn mallet, pedal damping at the note's end, and the
// motor's rotating discs - one shared tremolo clock for every note, a little out of phase L/R.
export function vibes(out, { t, dur, midi, vel = 0.75, pan = 0 }, { motor = 5.2, depth = 0.38, decay = 1 } = {}) {
  const f = mtof(midi);
  const base = clamp(4.5 * Math.sqrt(392 / f), 1.4, 7) * decay;
  const parts = [
    [1, 1, base],
    [3.99, 0.09 + 0.06 * vel, base * 0.22],
    [9.95, 0.025 * vel, base * 0.06],
  ].filter(([ratio]) => f * ratio < SR * 0.45);
  const damp = 0.14;
  const [start, len] = span(out, t, Math.min(dur + damp * 6, base * 5));
  const [gl, gr] = panGains(pan);
  const osc = parts.map(([ratio, a, d]) => {
    const w = (TAU * f * ratio) / SR;
    return { c: 2 * Math.cos(w), y1: Math.sin(-w), y2: Math.sin(-2 * w), a, k: Math.exp(-1 / (d * SR)), e: 1 };
  });
  const r = rng(midi * 7 + Math.round(t * 911));
  const lp = new Biquad("lowpass", 2400);
  const endS = dur * SR;
  const dK = Math.exp(-1 / (damp * SR));
  let rel = 1;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let j = 0; j < osc.length; j++) {
      const o = osc[j];
      const y = o.c * o.y1 - o.y2;
      o.y2 = o.y1;
      o.y1 = y;
      o.e *= o.k;
      s += y * o.a * o.e;
    }
    const tt = i / SR;
    if (tt < 0.03) s += lp.process(r.bi()) * Math.exp(-tt / 0.004) * 0.3 * vel;
    if (i > endS) {
      rel *= dK;
      if (rel < 1e-4) break;
    }
    const clock = TAU * motor * (t + tt);
    const v = s * rel * vel * 0.45;
    out.L[start + i] += v * gl * (1 - depth * (0.5 + 0.5 * fsin(clock)));
    out.R[start + i] += v * gr * (1 - depth * (0.5 + 0.5 * fsin(clock + 1.3)));
  }
}

// Brush sweep: a stroke of the wire brush across the head - grainy filtered noise that swells and
// fades over the note, its colour moving with the stroke.
export function sweep(out, { t, dur, vel = 0.6, pan = 0 }) {
  const [start, len] = span(out, t, dur);
  const [gl, gr] = panGains(pan);
  const r = rng(Math.round(t * 4447) + 3);
  const bp = new Biquad("bandpass", 3000, 0.6);
  const hp = new Biquad("highpass", 900);
  let grain = 0;
  for (let i = 0; i < len; i++) {
    const u = i / len;
    if ((i & 31) === 0) bp.set(2200 + 2600 * Math.sin(Math.PI * u));
    if ((i & 7) === 0) grain = 0.55 + 0.45 * r();
    const env = Math.sin(Math.PI * u) ** 1.4;
    const v = hp.process(bp.process(r.bi())) * env * grain * vel * 0.6;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

// ---- Jazz kit --------------------------------------------------------------------------------

const buf = (sec) => new Float32Array(Math.round(sec * SR));

// Bank of decaying inharmonic partials (recursive oscillators).
function partialBank(out, r, { count, lo, octaves, decay, tilt = 2500, from = 0 }) {
  const osc = [];
  for (let k = 0; k < count; k++) {
    const f = lo * 2 ** (r() * octaves);
    const w = (TAU * f) / SR;
    const ph = r() * TAU;
    const d = decay * (0.3 + 0.7 * r()) * clamp(Math.sqrt(1400 / f), 0.3, 1.5);
    osc.push({ c: 2 * Math.cos(w), y1: Math.sin(ph - w), y2: Math.sin(ph - 2 * w), a: (0.5 + r()) / (1 + f / tilt), k: Math.exp(-1 / (d * SR)), e: 1 });
  }
  for (let i = from; i < out.length; i++) {
    let s = 0;
    for (let j = 0; j < osc.length; j++) {
      const o = osc[j];
      const y = o.c * o.y1 - o.y2;
      o.y2 = o.y1;
      o.y1 = y;
      o.e *= o.k;
      s += y * o.a * o.e;
    }
    out[i] += s;
  }
}

// Ride cymbal: a dense wash that blooms just after the stick, the stick's ping, and (for the cup)
// a few strong bell partials.
function ride({ seed = 61, decay = 2.6, length = 3.6, bell = 0, ping = 1 } = {}) {
  const r = rng(seed);
  const wash = buf(length);
  partialBank(wash, r, { count: 110, lo: 330, octaves: 5, decay });
  const out = buf(length);
  const pingB = buf(0.25);
  partialBank(pingB, r, { count: 10, lo: 2600, octaves: 1.3, decay: 0.07, tilt: 9000 });
  const hp = new Biquad("highpass", 4000);
  // The shimmer: noise riding on the partials (the bronze's own chaotic modes), dying with them.
  const nh = new Biquad("highpass", 2600);
  const nl = new Biquad("lowpass", 10500);
  const nr = rng(seed + 7);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const shimmer = nl.process(nh.process(nr.bi())) * (0.5 + 2.5 * Math.abs(wash[i]) * 0.12) * Math.exp(-t / (decay * 0.45)) * 0.11;
    let v = (wash[i] * 0.09 + shimmer) * (1 - 0.6 * Math.exp(-t / 0.035));
    if (i < pingB.length) v += pingB[i] * ping * 0.16 * Math.exp(-t / 0.05);
    if (t < 0.02) v += hp.process(r.bi()) * Math.exp(-t / 0.0025) * 0.5;
    out[i] = v;
  }
  if (bell) {
    const b = buf(length);
    [2280, 3170, 4630, 5310].forEach((f, k) => {
      const d = 1.4 / (1 + k * 0.4);
      for (let i = 0; i < b.length; i++) b[i] += Math.sin((TAU * f * i) / SR) * Math.exp(-i / SR / d) * (k === 0 ? 0.5 : 0.3);
    });
    for (let i = 0; i < out.length; i++) out[i] += b[i] * bell * 0.25;
  }
  eqMono(out, "highpass", 260);
  return eqMono(out, "lowpass", 12500);
}

function crash({ seed = 71, decay = 1.8, length = 3.5 } = {}) {
  const r = rng(seed);
  const out = buf(length);
  partialBank(out, r, { count: 70, lo: 400, octaves: 5, decay, tilt: 5000 });
  const hp = new Biquad("highpass", 3000);
  const lp = new Biquad("lowpass", 11000);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] = out[i] * 0.09 * (1 - 0.5 * Math.exp(-t / 0.06)) + lp.process(hp.process(r.bi())) * (0.5 * Math.exp(-t / 0.5) + 0.6 * Math.exp(-t / 0.03));
  }
  return eqMono(out, "highpass", 300);
}

// The hi-hat closed with the foot on 2 and 4: a short "chick" of two plates meeting.
function hatFoot() {
  const r = rng(81);
  const out = buf(0.14);
  partialBank(out, r, { count: 12, lo: 3000, octaves: 1.8, decay: 0.03, tilt: 9000 });
  const bp = new Biquad("bandpass", 4200, 1.1);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] = (out[i] * 0.1 + bp.process(r.bi()) * 0.9) * Math.min(1, t / 0.003) * Math.exp(-t / 0.022);
  }
  return out;
}

// Closed hi-hat played with a stick (heads, quieter choruses).
function hatStick({ seed = 83, decay = 0.05 } = {}) {
  const r = rng(seed);
  const out = buf(0.3);
  partialBank(out, r, { count: 16, lo: 3200, octaves: 2, decay: decay * 1.5, tilt: 9000 });
  const hp = new Biquad("highpass", 6500);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] = (out[i] * 0.12 + hp.process(r.bi()) * 0.8) * Math.exp(-t / decay) + (t < 0.01 ? r.bi() * Math.exp(-t / 0.0015) * 0.4 : 0);
  }
  return eqMono(out, "highpass", 3000);
}

// Jazz snare: tuned high, loose wires ringing on after the head.
function snare({ seed = 91 } = {}) {
  const r = rng(seed);
  const out = buf(0.5);
  const bp = new Biquad("bandpass", 4200, 0.8);
  const hp = new Biquad("highpass", 1500);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const head = Math.sin(TAU * 245 * t * (1 + 0.15 * Math.exp(-t / 0.008))) * Math.exp(-t / 0.075) * 0.6 + Math.sin(TAU * 372 * t) * Math.exp(-t / 0.045) * 0.35;
    const wires = bp.process(r.bi()) * (0.65 * Math.exp(-t / 0.13) + 0.25 * Math.exp(-t / 0.3));
    const stick = t < 0.01 ? hp.process(r.bi()) * Math.exp(-t / 0.0015) * 0.5 : 0;
    out[i] = head + wires + stick;
  }
  return out;
}

// Cross-stick (bossa): the stick laid across the rim - a woody knock.
function crossStick() {
  const r = rng(93);
  const out = buf(0.12);
  const bp = new Biquad("bandpass", 1300, 2);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] = (Math.sin(TAU * 520 * t) * 0.6 * Math.exp(-t / 0.028) + Math.sin(TAU * 1720 * t) * 0.35 * Math.exp(-t / 0.01) + bp.process(r.bi()) * 1.1 * Math.exp(-t / 0.018)) * Math.min(1, t / 0.0005);
  }
  return eqMono(out, "highpass", 250);
}

// Brush tap: the wires landing on the head.
function brushTap() {
  const r = rng(95);
  const out = buf(0.3);
  const lp = new Biquad("lowpass", 6500);
  const hp = new Biquad("highpass", 800);
  const bp = new Biquad("bandpass", 4000, 0.9);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const n = r.bi();
    out[i] = hp.process(lp.process(n)) * Math.min(1, t / 0.003) * Math.exp(-t / 0.045) + bp.process(n) * 0.3 * Math.exp(-t / 0.13) + Math.sin(TAU * 240 * t) * 0.15 * Math.exp(-t / 0.05);
  }
  return out;
}

// 18" bass drum, tuned up and left open - feathered softly on every beat, "dropping bombs" louder.
function kick() {
  const r = rng(97);
  const out = buf(0.8);
  const lp = new Biquad("lowpass", 900);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    ph += (60 + 22 * Math.exp(-t / 0.03)) / SR;
    out[i] = Math.sin(TAU * ph) * Math.exp(-t / 0.36) + Math.sin(TAU * 98 * t) * 0.35 * Math.exp(-t / 0.14) + (t < 0.02 ? lp.process(r.bi()) * Math.exp(-t / 0.005) * 0.5 : 0);
  }
  return eqMono(out, "highpass", 35);
}

function tom(freq, decay, seed) {
  const r = rng(seed);
  const out = buf(decay * 4);
  const hp = new Biquad("highpass", 2000);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const bend = 1 + 0.12 * Math.exp(-t / 0.02);
    out[i] = Math.sin(TAU * freq * bend * t) * Math.exp(-t / decay) + Math.sin(TAU * freq * 1.59 * t) * 0.3 * Math.exp(-t / (decay * 0.4)) + (t < 0.01 ? hp.process(r.bi()) * Math.exp(-t / 0.002) * 0.4 : 0);
  }
  return out;
}

let jazzKitCache = null;
export function jazzKit() {
  if (!jazzKitCache) {
    jazzKitCache = {
      ride: [ride({ seed: 61 }), ride({ seed: 61, ping: 0.7 }), ride({ seed: 61, ping: 1.3 })],
      rideBell: ride({ seed: 61, bell: 1, ping: 1.4 }),
      crash: crash(),
      hatFoot: hatFoot(),
      hatStick: hatStick(),
      snare: snare(),
      cross: crossStick(),
      brushTap: brushTap(),
      kick: kick(),
      toms: [tom(196, 0.32, 101), tom(147, 0.4, 102), tom(98, 0.55, 103)],
    };
  }
  return jazzKitCache;
}
