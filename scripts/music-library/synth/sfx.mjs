// Sound effects for the Briefcast Originals pack: transitions, UI sounds, notifications, impacts.
// Each returns a finished Stereo buffer (reverb included where it helps).
import { SR, TAU, Biquad, Stereo, eq, limit, mtof, panGains, peakOf, reverb, rng } from "./dsp.mjs";
import { bell, mallet } from "./instruments.mjs";

export const buf = (sec) => new Stereo(Math.round(sec * SR));

// Filtered-noise whoosh: a band-pass sweeping `from`→`peak`→`to`, a bell-shaped swell, panning across.
export function whooshInto(out, { at = 0, dur = 0.9, from = 300, peak = 2600, to = 500, q = 1.4, panFrom = -0.7, panTo = 0.7, seed = 1, gain = 1, shape = 2.2 }) {
  const r = rng(seed);
  const bpL = new Biquad("bandpass", from, q);
  const bpR = new Biquad("bandpass", from, q);
  const n = Math.round(dur * SR);
  const start = Math.round(at * SR);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const u = i / n;
    if ((i & 31) === 0) {
      const f = u < 0.5 ? from * (peak / from) ** (u * 2) : peak * (to / peak) ** ((u - 0.5) * 2);
      bpL.set(f);
      bpR.set(f * 1.05);
    }
    const env = Math.sin(Math.PI * u) ** shape * gain;
    const [gl, gr] = panGains(panFrom + (panTo - panFrom) * u);
    out.L[start + i] += bpL.process(r.bi()) * env * gl;
    out.R[start + i] += bpR.process(r.bi()) * env * gr;
  }
}

export function tone(out, { at = 0, dur, f0, f1 = f0, wave = "sine", attack = 0.002, decay, gain = 1, pan = 0, curve = "exp" }) {
  const n = Math.round(dur * SR);
  const start = Math.round(at * SR);
  const [gl, gr] = panGains(pan);
  let ph = 0;
  for (let i = 0; i < n && start + i < out.length; i++) {
    const u = i / n;
    const f = curve === "exp" ? f0 * (f1 / f0) ** u : f0 + (f1 - f0) * u;
    ph += f / SR;
    const p = ph % 1;
    const s = wave === "sine" ? Math.sin(TAU * p) : wave === "square" ? (p < 0.5 ? 1 : -1) : wave === "tri" ? 1 - 4 * Math.abs(p - 0.5) : 2 * p - 1;
    const env = Math.min(1, i / (attack * SR)) * (decay ? Math.exp(-i / SR / decay) : 1 - u);
    const v = s * env * gain;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

export function noiseBurst(out, { at = 0, dur, decay, filter = ["highpass", 2000], gain = 1, pan = 0, seed = 3, attack = 0.0005 }) {
  const r = rng(seed);
  const f = new Biquad(filter[0], filter[1], filter[2] ?? 0.9);
  const n = Math.round(dur * SR);
  const start = Math.round(at * SR);
  const [gl, gr] = panGains(pan);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const v = f.process(r.bi()) * Math.min(1, i / (attack * SR + 1)) * Math.exp(-i / SR / decay) * gain;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

export function withVerb(dry, { room = 0.7, damp = 0.4, wet = 0.25, preDelay = 0.01 } = {}) {
  const w = reverb(dry, { room, damp, preDelay });
  return dry.mixIn(w, wet);
}

export function finish(b, peakTarget = 0.9) {
  const p = peakOf(b);
  if (p > 0) b.scale(peakTarget / p);
  limit(b, 0.95);
  // 5 ms fade at both ends - no clicks at the edges.
  const f = Math.round(0.005 * SR);
  for (let i = 0; i < f; i++) {
    const g = i / f;
    b.L[b.length - 1 - i] *= g;
    b.R[b.length - 1 - i] *= g;
  }
  return b;
}

export const SFX = [
  {
    id: "sfx-whoosh", title: "Whoosh", tags: ["transition", "swipe", "fast"],
    make() {
      const b = buf(1.4);
      whooshInto(b, { dur: 0.9, seed: 1 });
      whooshInto(b, { dur: 0.9, from: 150, peak: 900, to: 250, q: 0.8, seed: 2, gain: 0.6 });
      return finish(withVerb(b, { wet: 0.2 }));
    },
  },
  {
    id: "sfx-whoosh-fast", title: "Quick Whoosh", tags: ["transition", "swipe"],
    make() {
      const b = buf(0.8);
      whooshInto(b, { dur: 0.42, from: 500, peak: 4200, to: 900, q: 1.2, seed: 3, shape: 1.6 });
      return finish(withVerb(b, { wet: 0.15 }));
    },
  },
  {
    id: "sfx-swoosh-up", title: "Swoosh Up", tags: ["transition", "rise", "reveal"],
    make() {
      const b = buf(1.3);
      whooshInto(b, { dur: 0.85, from: 250, peak: 2500, to: 7000, q: 1.5, seed: 4, shape: 1.2 });
      tone(b, { dur: 0.85, f0: 180, f1: 900, wave: "sine", gain: 0.12, attack: 0.3 });
      return finish(withVerb(b, { wet: 0.25 }));
    },
  },
  {
    id: "sfx-swoosh-down", title: "Swoosh Down", tags: ["transition", "fall", "exit"],
    make() {
      const b = buf(1.3);
      whooshInto(b, { dur: 0.85, from: 6000, peak: 1800, to: 250, q: 1.5, seed: 5, shape: 1.2, panFrom: 0.6, panTo: -0.6 });
      tone(b, { dur: 0.85, f0: 900, f1: 120, wave: "sine", gain: 0.12, decay: 0.4 });
      return finish(withVerb(b, { wet: 0.25 }));
    },
  },
  {
    id: "sfx-swipe", title: "Swipe", tags: ["ui", "transition", "slide"],
    make() {
      const b = buf(0.4);
      whooshInto(b, { dur: 0.22, from: 1500, peak: 6000, to: 3000, q: 0.9, seed: 6, shape: 1.3, panFrom: -0.4, panTo: 0.4 });
      return finish(b, 0.8);
    },
  },
  {
    id: "sfx-pop", title: "Pop", tags: ["ui", "appear", "bubble"],
    make() {
      const b = buf(0.25);
      tone(b, { dur: 0.12, f0: 700, f1: 180, decay: 0.035, gain: 1 });
      noiseBurst(b, { dur: 0.01, decay: 0.002, filter: ["bandpass", 3000, 1], gain: 0.4 });
      return finish(b);
    },
  },
  {
    id: "sfx-bubble", title: "Bubbles", tags: ["ui", "playful", "water"],
    make() {
      const b = buf(0.8);
      const r = rng(7);
      [0, 0.11, 0.19, 0.33, 0.41].forEach((at, i) => tone(b, { at, dur: 0.09, f0: r.range(280, 420), f1: r.range(900, 1500), decay: 0.04, gain: 0.8 - i * 0.08, pan: r.range(-0.5, 0.5) }));
      return finish(withVerb(b, { wet: 0.15, room: 0.4 }));
    },
  },
  {
    id: "sfx-click", title: "Click", tags: ["ui", "button", "select"],
    make() {
      const b = buf(0.08);
      noiseBurst(b, { dur: 0.02, decay: 0.0025, filter: ["highpass", 2500], gain: 0.7 });
      tone(b, { dur: 0.03, f0: 3200, decay: 0.005, gain: 0.5 });
      return finish(b, 0.75);
    },
  },
  {
    id: "sfx-mouse-click", title: "Mouse Click", tags: ["ui", "computer", "screen recording"],
    make() {
      const b = buf(0.25);
      for (const [at, f] of [[0, 2600], [0.085, 2200]]) {
        noiseBurst(b, { at, dur: 0.015, decay: 0.0018, filter: ["bandpass", f, 1.5], gain: 0.9, seed: f });
        tone(b, { at, dur: 0.02, f0: f * 0.6, decay: 0.004, gain: 0.25 });
      }
      return finish(b, 0.75);
    },
  },
  {
    id: "sfx-typing", title: "Typing", tags: ["computer", "keyboard", "screen recording"],
    make() {
      const b = buf(2.2);
      const r = rng(8);
      let at = 0.02;
      for (let k = 0; k < 16 && at < 2; k++) {
        const space = k === 6 || k === 12;
        const f = space ? 900 : r.range(1800, 3200);
        noiseBurst(b, { at, dur: 0.03, decay: space ? 0.006 : 0.003, filter: ["bandpass", f, 1.2], gain: space ? 0.8 : r.range(0.5, 0.85), pan: r.range(-0.3, 0.3), seed: 100 + k });
        tone(b, { at, dur: 0.025, f0: space ? 260 : r.range(380, 520), decay: 0.006, gain: 0.25 });
        at += r.range(0.07, 0.15) + (space ? 0.05 : 0);
      }
      return finish(withVerb(b, { wet: 0.06, room: 0.3 }), 0.8);
    },
  },
  {
    id: "sfx-shutter", title: "Camera Shutter", tags: ["photo", "screenshot", "capture"],
    make() {
      const b = buf(0.45);
      noiseBurst(b, { dur: 0.04, decay: 0.006, filter: ["bandpass", 3500, 1.3], gain: 1, seed: 9 });
      noiseBurst(b, { at: 0.012, dur: 0.08, decay: 0.02, filter: ["bandpass", 1200, 0.8], gain: 0.5, seed: 10 });
      noiseBurst(b, { at: 0.11, dur: 0.05, decay: 0.008, filter: ["bandpass", 2800, 1.3], gain: 0.8, seed: 11 });
      return finish(withVerb(b, { wet: 0.08, room: 0.3 }));
    },
  },
  {
    id: "sfx-ding", title: "Ding", tags: ["notification", "success", "bell"],
    make() {
      const b = buf(2.2);
      bell(b, { t: 0, dur: 1.5, midi: 88, vel: 0.9 }, { ratio: 3.5, index: 1.4, decay: 1.2 });
      mallet(b, { t: 0, dur: 1.5, midi: 88, vel: 0.5 }, { kind: "glock" });
      return finish(withVerb(b, { wet: 0.25 }));
    },
  },
  {
    id: "sfx-success", title: "Success Chime", tags: ["notification", "success", "complete"],
    make() {
      const b = buf(2.2);
      [84, 88, 91, 96].forEach((m, i) => mallet(b, { t: i * 0.085, dur: 1.2, midi: m, vel: 0.75 + i * 0.05, pan: -0.3 + i * 0.2 }, { kind: "glock" }));
      return finish(withVerb(b, { wet: 0.3, room: 0.75 }));
    },
  },
  {
    id: "sfx-notification", title: "Notification", tags: ["notification", "message", "alert"],
    make() {
      const b = buf(1.2);
      mallet(b, { t: 0, dur: 0.6, midi: 76, vel: 0.8 }, { kind: "marimba" });
      mallet(b, { t: 0.13, dur: 0.8, midi: 83, vel: 0.85 }, { kind: "marimba" });
      return finish(withVerb(b, { wet: 0.2, room: 0.5 }));
    },
  },
  {
    id: "sfx-error", title: "Error", tags: ["ui", "wrong", "alert"],
    make() {
      const b = buf(0.6);
      for (const at of [0, 0.17]) tone(b, { at, dur: 0.13, f0: 196, wave: "square", decay: 0.12, gain: 0.5 });
      eq(b, "lowpass", 1800);
      return finish(b, 0.8);
    },
  },
  {
    id: "sfx-coin", title: "Coin", tags: ["reward", "game", "points"],
    make() {
      const b = buf(0.7);
      tone(b, { dur: 0.08, f0: mtof(83), wave: "square", decay: 0.2, gain: 0.35 });
      tone(b, { at: 0.075, dur: 0.5, f0: mtof(88), wave: "square", decay: 0.15, gain: 0.35 });
      eq(b, "lowpass", 6000);
      return finish(withVerb(b, { wet: 0.12, room: 0.4 }), 0.8);
    },
  },
  {
    id: "sfx-sparkle", title: "Sparkle", tags: ["magic", "reveal", "shine"],
    make() {
      const b = buf(2.6);
      const r = rng(12);
      const notes = [84, 86, 88, 91, 93, 96, 98, 100, 103];
      for (let k = 0; k < 16; k++) mallet(b, { t: k * 0.055 + r.range(0, 0.02), dur: 0.8, midi: r.pick(notes), vel: 0.4 + 0.5 * (1 - k / 16), pan: r.range(-0.8, 0.8) }, { kind: "glock", decayScale: 0.6 });
      whooshInto(b, { dur: 1, from: 4000, peak: 9000, to: 6000, q: 2, seed: 13, gain: 0.15 });
      return finish(withVerb(b, { wet: 0.35, room: 0.85 }));
    },
  },
  {
    id: "sfx-riser", title: "Riser", tags: ["build-up", "transition", "tension"],
    make() {
      const b = buf(3.2);
      whooshInto(b, { dur: 3, from: 200, peak: 9000, to: 9000, q: 1.2, seed: 14, shape: 0.5, panFrom: -0.3, panTo: 0.3 });
      const env = (u) => u ** 2;
      const n = Math.round(3 * SR);
      for (const det of [0, 0.006, -0.006]) {
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const u = i / n;
          ph += (110 * 2 ** (u * 3) * (1 + det)) / SR;
          const v = (2 * (ph % 1) - 1) * env(u) * 0.12;
          b.L[i] += v;
          b.R[i] += v * (det ? 0.8 : 1);
        }
      }
      eq(b, "lowpass", 7000);
      return finish(withVerb(b, { wet: 0.25 }));
    },
  },
  {
    id: "sfx-downlifter", title: "Downlifter", tags: ["transition", "drop", "release"],
    make() {
      const b = buf(2.4);
      whooshInto(b, { dur: 2, from: 9000, peak: 2500, to: 150, q: 1.1, seed: 15, shape: 0.6, panFrom: 0.3, panTo: -0.3 });
      tone(b, { dur: 2, f0: 400, f1: 45, decay: 0.8, gain: 0.35 });
      return finish(withVerb(b, { wet: 0.3 }));
    },
  },
  {
    id: "sfx-impact", title: "Impact", tags: ["impact", "reveal", "trailer"],
    make() {
      const b = buf(3.5);
      tone(b, { dur: 2.5, f0: 90, f1: 32, decay: 0.7, gain: 1 });
      noiseBurst(b, { dur: 0.4, decay: 0.06, filter: ["lowpass", 1800], gain: 0.8, seed: 16 });
      noiseBurst(b, { dur: 1.5, decay: 0.35, filter: ["highpass", 3000], gain: 0.15, seed: 17 });
      return finish(withVerb(b, { wet: 0.45, room: 0.9, damp: 0.3 }));
    },
  },
  {
    id: "sfx-whoosh-hit", title: "Whoosh + Hit", tags: ["transition", "reveal", "logo"],
    make() {
      const b = buf(3);
      whooshInto(b, { dur: 0.75, from: 300, peak: 5000, to: 5000, q: 1.2, seed: 18, shape: 0.8 });
      tone(b, { at: 0.72, dur: 2, f0: 85, f1: 34, decay: 0.55, gain: 1 });
      noiseBurst(b, { at: 0.72, dur: 0.3, decay: 0.05, filter: ["lowpass", 2500], gain: 0.7, seed: 19 });
      return finish(withVerb(b, { wet: 0.4, room: 0.85 }));
    },
  },
  {
    id: "sfx-glitch", title: "Glitch", tags: ["tech", "digital", "transition"],
    make() {
      const b = buf(0.7);
      const r = rng(20);
      let at = 0;
      while (at < 0.55) {
        const d = r.range(0.015, 0.06);
        if (r.chance(0.5)) tone(b, { at, dur: d, f0: r.range(200, 2400), wave: r.pick(["square", "saw"]), gain: 0.4, decay: 0.05, pan: r.range(-0.8, 0.8) });
        else noiseBurst(b, { at, dur: d, decay: 0.03, filter: ["bandpass", r.range(800, 6000), 2], gain: 0.8, pan: r.range(-0.8, 0.8), seed: Math.round(at * 1e4) });
        at += d + r.range(0, 0.03);
      }
      return finish(b, 0.8);
    },
  },
  {
    id: "sfx-tick-tock", title: "Tick Tock", tags: ["clock", "time", "countdown"],
    make() {
      const b = buf(2.1);
      for (let k = 0; k < 4; k++) {
        const f = k % 2 ? 1500 : 1900;
        noiseBurst(b, { at: k * 0.5, dur: 0.03, decay: 0.004, filter: ["bandpass", f, 3], gain: 1, seed: 30 + k, pan: k % 2 ? 0.15 : -0.15 });
        tone(b, { at: k * 0.5, dur: 0.04, f0: f * 1.5, decay: 0.006, gain: 0.3 });
      }
      return finish(withVerb(b, { wet: 0.15, room: 0.5 }), 0.8);
    },
  },
];
