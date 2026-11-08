// The second wave of Briefcast Originals sound effects, for the people who use the editor most:
// YouTubers and content creators (meme beats, quiz sounds, reveals, comedy stings), researchers and
// lecturers (lab, data and lecture-hall sounds), plus interface sounds and ambience beds.
// Each is built from the same helpers as sfx.mjs and returns a finished Stereo buffer.
import { SR, TAU, Biquad, eq, mtof, panGains, placeMono, rng } from "./dsp.mjs";
import { bell, mallet, piano, sawEnsemble, subtractive } from "./instruments.mjs";
import { kit } from "./drums.mjs";
import { buf, finish, noiseBurst, tone, whooshInto, withVerb } from "./sfx.mjs";

// Adds samples from fn(t, i) into both channels (with optional pan) over `dur` from `at`.
function render(out, at, dur, fn, pan = 0) {
  const start = Math.round(at * SR);
  const n = Math.round(dur * SR);
  const [gl, gr] = panGains(pan);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const v = fn(i / SR, i);
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

// Gentle start/end ramps for beds and loops.
function fadeEdges(b, inSec, outSec) {
  const fi = Math.round(inSec * SR);
  const fo = Math.round(outSec * SR);
  for (let i = 0; i < fi && i < b.length; i++) {
    b.L[i] *= i / fi;
    b.R[i] *= i / fi;
  }
  for (let i = 0; i < fo && i < b.length; i++) {
    const k = b.length - 1 - i;
    b.L[k] *= i / fo;
    b.R[k] *= i / fo;
  }
  return b;
}

export const MORE_SFX = [
  // ---- Creator & comedy ----------------------------------------------------------------------
  {
    id: "sfx-record-scratch", title: "Record Scratch", category: "creator", tags: ["meme", "wait what", "youtube", "comedy", "stop"],
    make() {
      const b = buf(0.9);
      const r = rng(51);
      const bpL = new Biquad("bandpass", 800, 2.2);
      const bpR = new Biquad("bandpass", 820, 2.2);
      const n = Math.round(0.7 * SR);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const u = i / n;
        const v = Math.sin(TAU * u * 2.2) * (1 - u * 0.3);
        const f = 250 + 2600 * Math.abs(v);
        if ((i & 31) === 0) {
          bpL.set(f);
          bpR.set(f * 1.03);
        }
        ph += (f * 0.35) / SR;
        const env = Math.abs(v) ** 0.7 * Math.min(1, u / 0.02) * Math.min(1, (1 - u) / 0.1);
        const saw = 2 * (ph % 1) - 1;
        b.L[i] += (bpL.process(r.bi()) * 1.4 + saw * 0.12) * env;
        b.R[i] += (bpR.process(r.bi()) * 1.4 + saw * 0.12) * env;
      }
      return finish(b);
    },
  },
  {
    id: "sfx-bass-boom", title: "Bass Boom", category: "creator", tags: ["meme", "boom", "reveal", "youtube", "drop"],
    make() {
      const b = buf(2.8);
      let ph = 0;
      render(b, 0, 1.8, (t) => {
        ph += (55 + 110 * Math.exp(-t / 0.04)) / SR;
        return Math.tanh(2.5 * Math.sin(TAU * ph)) * Math.exp(-t / 0.55);
      });
      noiseBurst(b, { dur: 0.03, decay: 0.006, filter: ["lowpass", 2500], gain: 0.6, seed: 52 });
      return finish(withVerb(b, { wet: 0.35, room: 0.8 }));
    },
  },
  {
    id: "sfx-boing", title: "Boing", category: "creator", tags: ["cartoon", "comedy", "bounce", "spring"],
    make() {
      const b = buf(1);
      let ph = 0;
      render(b, 0, 0.9, (t) => {
        ph += (180 * (1 + 0.6 * t) * (1 + 0.35 * Math.sin(TAU * 14 * t) * Math.exp(-t * 4))) / SR;
        return (Math.sin(TAU * ph) + 0.3 * Math.sin(2 * TAU * ph)) * Math.exp(-t / 0.35) * Math.min(1, t / 0.004);
      });
      return finish(b);
    },
  },
  ...[
    { id: "sfx-slide-whistle-up", title: "Slide Whistle Up", from: 500, to: 1700 },
    { id: "sfx-slide-whistle-down", title: "Slide Whistle Down", from: 1700, to: 450 },
  ].map(({ id, title, from, to }) => ({
    id, title, category: "creator", tags: ["cartoon", "comedy", "whistle", from < to ? "up" : "down"],
    make() {
      const b = buf(1.1);
      const r = rng(53);
      const bp = new Biquad("bandpass", from, 6);
      let ph = 0;
      const n = 0.9;
      render(b, 0, n, (t, i) => {
        const f = from * (to / from) ** (t / n) * (1 + 0.01 * Math.sin(TAU * 6 * t));
        ph += f / SR;
        if ((i & 63) === 0) bp.set(f);
        const env = Math.min(1, t / 0.05) * Math.min(1, (n - t) / 0.1);
        return (Math.sin(TAU * ph) * 0.8 + bp.process(r.bi()) * 0.6) * env;
      });
      return finish(withVerb(b, { wet: 0.12, room: 0.4 }));
    },
  })),
  {
    id: "sfx-drumroll", title: "Drumroll", category: "creator", tags: ["reveal", "suspense", "announcement", "winner"],
    make() {
      const k = kit("pop");
      const b = buf(4.5);
      let t = 0;
      let i = 0;
      while (t < 2.2) {
        const u = t / 2.2;
        placeMono(b, k.snare, t, 0.3 + 0.7 * u ** 1.4, i % 2 ? 0.12 : -0.12);
        t += 1 / (12 + 12 * u);
        i++;
      }
      placeMono(b, k.kick, 2.2, 1, 0);
      placeMono(b, k.crash, 2.2, 1, 0.1);
      return finish(withVerb(b, { wet: 0.2 }));
    },
  },
  {
    id: "sfx-rimshot", title: "Ba-Dum-Tss", category: "creator", tags: ["joke", "comedy", "rimshot", "punchline"],
    make() {
      const k = kit("pop");
      const b = buf(2);
      placeMono(b, k.tom, 0, 0.8, -0.1);
      placeMono(b, k.snare, 0.17, 0.75, 0);
      placeMono(b, k.kick, 0.17, 0.8, 0);
      placeMono(b, k.openHat, 0.36, 1, 0.15);
      placeMono(b, k.crash, 0.36, 0.45, 0.15);
      return finish(withVerb(b, { wet: 0.18, room: 0.5 }));
    },
  },
  {
    id: "sfx-sad-trombone", title: "Sad Trombone", category: "creator", tags: ["fail", "comedy", "wah wah", "lose"],
    make() {
      const b = buf(3.4);
      const notes = [[62, 0, 0.4], [61, 0.45, 0.4], [60, 0.9, 0.4], [59, 1.35, 1.4]];
      notes.forEach(([midi, t, dur], i) =>
        subtractive(b, { t, dur, midi, vel: 0.9 }, { wave: "saw", cutoff: 450, envAmt: 1600, filterDecay: 0.25, attack: 0.04, decay: 0.5, sustain: 0.8, release: 0.15, drive: 1.4, vibrato: i === 3 ? 0.014 : 0 })
      );
      eq(b, "lowpass", 3000);
      return finish(withVerb(b, { wet: 0.2, room: 0.5 }));
    },
  },
  {
    id: "sfx-crickets", title: "Crickets", category: "creator", tags: ["awkward", "silence", "comedy", "night"],
    make() {
      const b = buf(4);
      const r = rng(54);
      for (const [f, pan, offset] of [[4600, -0.4, 0], [4250, 0.45, 0.27]]) {
        let t = offset;
        while (t < 3.7) {
          for (let p = 0; p < 3; p++) tone(b, { at: t + p * 0.037, dur: 0.025, f0: f, decay: 0.012, gain: 0.35, pan });
          t += r.range(0.45, 0.65);
        }
      }
      const lp = new Biquad("lowpass", 900);
      render(b, 0, 4, () => lp.process(r.bi()) * 0.04);
      return finish(fadeEdges(b, 0.3, 0.4), 0.7);
    },
  },
  {
    id: "sfx-applause", title: "Applause", category: "creator", tags: ["clapping", "audience", "success", "crowd"],
    make() {
      const b = buf(4);
      const r = rng(55);
      const env = (t) => Math.min(1, t / 0.35) * Math.min(1, (3.6 - t) / 1.2);
      for (let k = 0; k < 420; k++) {
        const t = r.range(0, 3.6);
        if (r() > env(t)) continue;
        noiseBurst(b, { at: t, dur: 0.03, decay: 0.007, filter: ["bandpass", r.range(900, 2600), 1.2], gain: r.range(0.3, 0.8), pan: r.range(-0.8, 0.8), seed: 600 + k });
      }
      const bp = new Biquad("bandpass", 1500, 0.7);
      render(b, 0, 3.6, (t) => bp.process(r.bi()) * 0.12 * env(t));
      return finish(withVerb(b, { wet: 0.25, room: 0.7 }));
    },
  },
  {
    id: "sfx-cash-register", title: "Cash Register", category: "creator", tags: ["money", "sale", "ka-ching", "business"],
    make() {
      const b = buf(2);
      noiseBurst(b, { dur: 0.15, decay: 0.05, filter: ["lowpass", 800], gain: 0.8, seed: 56 });
      noiseBurst(b, { at: 0.02, dur: 0.03, decay: 0.004, filter: ["bandpass", 3000, 2], gain: 0.7, seed: 57 });
      bell(b, { t: 0.08, dur: 1.2, midi: 93, vel: 0.8, pan: -0.1 }, { ratio: 3.5, index: 1.3, decay: 0.9 });
      bell(b, { t: 0.08, dur: 1.2, midi: 98, vel: 0.6, pan: 0.1 }, { ratio: 2.76, index: 1, decay: 0.8 });
      const r = rng(58);
      for (let k = 0; k < 6; k++) mallet(b, { t: 0.12 + k * 0.05, dur: 0.4, midi: r.pick([100, 103, 105]), vel: 0.25, pan: r.range(-0.5, 0.5) }, { kind: "glock", decayScale: 0.4 });
      return finish(withVerb(b, { wet: 0.15, room: 0.5 }));
    },
  },
  {
    id: "sfx-air-horn", title: "Air Horn", category: "creator", tags: ["hype", "party", "meme", "celebration"],
    make() {
      const b = buf(1.7);
      for (const [t, dur] of [[0, 0.16], [0.24, 0.16], [0.48, 0.85]]) {
        for (const midi of [69, 70]) subtractive(b, { t, dur, midi, vel: 1 }, { wave: "saw", cutoff: 2600, envAmt: 0, attack: 0.012, decay: 1, sustain: 1, release: 0.05, detuneCents: 18, drive: 2.5 });
      }
      eq(b, "peak", 1200, 1, 4);
      return finish(withVerb(b, { wet: 0.15, room: 0.6 }));
    },
  },
  {
    id: "sfx-censor-beep", title: "Censor Beep", category: "creator", tags: ["bleep", "censor", "swear", "mute"],
    make() {
      const b = buf(0.75);
      render(b, 0, 0.7, (t) => Math.sin(TAU * 1000 * t) * Math.min(1, t / 0.005, (0.7 - t) / 0.005) * 0.6);
      return finish(b, 0.7);
    },
  },
  {
    id: "sfx-level-up", title: "Level Up", category: "creator", tags: ["game", "achievement", "win", "progress"],
    make() {
      const b = buf(1.6);
      [72, 76, 79, 84, 88, 91, 96].forEach((m, i) => tone(b, { at: i * 0.055, dur: 0.18, f0: mtof(m), wave: "square", decay: 0.08, gain: 0.25 }));
      mallet(b, { t: 0.38, dur: 1, midi: 96, vel: 0.6 }, { kind: "glock" });
      eq(b, "lowpass", 7000);
      return finish(withVerb(b, { wet: 0.2, room: 0.5 }));
    },
  },
  {
    id: "sfx-laser", title: "Laser", category: "creator", tags: ["sci-fi", "game", "pew", "shoot"],
    make() {
      const b = buf(0.7);
      tone(b, { dur: 0.25, f0: 1800, f1: 220, wave: "square", decay: 0.2, gain: 0.45 });
      eq(b, "lowpass", 5000);
      return finish(withVerb(b, { wet: 0.2, room: 0.4 }), 0.8);
    },
  },
  {
    id: "sfx-ta-da", title: "Ta-Da!", category: "creator", tags: ["reveal", "fanfare", "success", "magic"],
    make() {
      const b = buf(2.6);
      const brass = { voices: 3, detuneCents: 8, attack: 0.02, decay: 0.4, sustain: 0.7, release: 0.35 };
      for (const m of [60, 64, 67, 72]) {
        sawEnsemble(b, { t: 0, dur: 0.12, midi: m, vel: 0.8 }, brass);
        sawEnsemble(b, { t: 0.16, dur: 1.1, midi: m, vel: 0.95 }, brass);
      }
      eq(b, "lowpass", 3500);
      placeMono(b, kit("pop").crash, 0.16, 0.5, 0.1);
      [84, 88, 91, 96].forEach((m, i) => mallet(b, { t: 0.2 + i * 0.06, dur: 1, midi: m, vel: 0.4 }, { kind: "glock" }));
      return finish(withVerb(b, { wet: 0.25, room: 0.7 }));
    },
  },
  {
    id: "sfx-heart-pop", title: "Heart Pop", category: "creator", tags: ["like", "love", "youtube", "subscribe"],
    make() {
      const b = buf(0.8);
      tone(b, { dur: 0.1, f0: 500, f1: 160, decay: 0.03, gain: 0.9 });
      tone(b, { at: 0.04, dur: 0.18, f0: 900, f1: 1800, decay: 0.06, gain: 0.45 });
      mallet(b, { t: 0.06, dur: 0.6, midi: 96, vel: 0.35 }, { kind: "glock" });
      return finish(withVerb(b, { wet: 0.12, room: 0.4 }));
    },
  },

  // ---- Notifications & quiz ------------------------------------------------------------------
  {
    id: "sfx-bell-ring", title: "Bell Ring", category: "notifications", tags: ["subscribe", "notification", "youtube", "reminder"],
    make() {
      const b = buf(2.4);
      [0, 0.09, 0.18, 0.27, 0.36].forEach((t, i) => {
        bell(b, { t, dur: 1.2, midi: 91, vel: 0.8 - i * 0.08, pan: i % 2 ? 0.15 : -0.15 }, { ratio: 2.76, index: 1.2, decay: 0.9 });
        bell(b, { t: t + 0.004, dur: 1.2, midi: 95, vel: 0.35 }, { ratio: 3.5, index: 1, decay: 0.7 });
      });
      return finish(withVerb(b, { wet: 0.2, room: 0.6 }));
    },
  },
  {
    id: "sfx-correct", title: "Correct Answer", category: "notifications", tags: ["quiz", "right", "yes", "success"],
    make() {
      const b = buf(1.6);
      mallet(b, { t: 0, dur: 0.8, midi: 84, vel: 0.8 }, { kind: "glock" });
      mallet(b, { t: 0.12, dur: 1, midi: 91, vel: 0.9 }, { kind: "glock" });
      bell(b, { t: 0.12, dur: 1, midi: 91, vel: 0.3 }, { decay: 0.8 });
      return finish(withVerb(b, { wet: 0.2, room: 0.5 }));
    },
  },
  {
    id: "sfx-wrong", title: "Wrong Buzzer", category: "notifications", tags: ["quiz", "wrong", "no", "fail"],
    make() {
      const b = buf(0.9);
      for (const at of [0, 0.4]) {
        tone(b, { at, dur: 0.32, f0: 120, wave: "square", gain: 0.35 });
        tone(b, { at, dur: 0.32, f0: 127, wave: "square", gain: 0.35 });
      }
      eq(b, "lowpass", 2000);
      return finish(b, 0.8);
    },
  },
  {
    id: "sfx-countdown", title: "Countdown Beeps", category: "notifications", tags: ["timer", "3 2 1", "start", "race"],
    make() {
      const b = buf(3.9);
      for (const at of [0, 1, 2]) render(b, at, 0.14, (t) => Math.sin(TAU * 880 * t) * Math.min(1, t / 0.004, (0.14 - t) / 0.01) * 0.5);
      render(b, 3, 0.65, (t) => Math.sin(TAU * 1760 * t) * Math.min(1, t / 0.004, (0.65 - t) / 0.05) * 0.5);
      return finish(b, 0.75);
    },
  },
  {
    id: "sfx-phone-vibrate", title: "Phone Vibrate", category: "notifications", tags: ["phone", "buzz", "message", "call"],
    make() {
      const b = buf(1.2);
      for (const at of [0, 0.6]) render(b, at, 0.4, (t) => Math.tanh(3 * Math.sin(TAU * 165 * t)) * (0.7 + 0.3 * Math.sin(TAU * 30 * t)) * Math.min(1, t / 0.01, (0.4 - t) / 0.02) * 0.5);
      eq(b, "lowpass", 1200);
      return finish(b, 0.75);
    },
  },
  {
    id: "sfx-alarm-clock", title: "Alarm Clock", category: "notifications", tags: ["wake up", "alarm", "time", "morning"],
    make() {
      const b = buf(1.6);
      for (const at of [0, 0.75]) render(b, at, 0.6, (t) => (Math.sin(TAU * 2200 * t) > 0 ? 1 : -1) * (Math.sin(TAU * 25 * t) > 0 ? 1 : 0.15) * Math.min(1, t / 0.005, (0.6 - t) / 0.01) * 0.3);
      eq(b, "bandpass", 2200, 0.8);
      return finish(withVerb(b, { wet: 0.1, room: 0.4 }), 0.75);
    },
  },

  // ---- Interface -----------------------------------------------------------------------------
  {
    id: "sfx-blip", title: "Blip", category: "interface", tags: ["ui", "text", "appear", "subtitle"],
    make() {
      const b = buf(0.12);
      tone(b, { dur: 0.06, f0: 1400, f1: 1800, decay: 0.02, gain: 0.7 });
      return finish(b, 0.7);
    },
  },
  {
    id: "sfx-tap", title: "Tap", category: "interface", tags: ["ui", "touch", "button", "phone"],
    make() {
      const b = buf(0.08);
      tone(b, { dur: 0.04, f0: 900, decay: 0.01, gain: 0.8 });
      noiseBurst(b, { dur: 0.01, decay: 0.0015, filter: ["highpass", 3000], gain: 0.4, seed: 59 });
      return finish(b, 0.7);
    },
  },
  {
    id: "sfx-toggle-on", title: "Toggle On", category: "interface", tags: ["ui", "switch", "enable"],
    make() {
      const b = buf(0.2);
      tone(b, { dur: 0.05, f0: 660, decay: 0.02, gain: 0.6 });
      tone(b, { at: 0.06, dur: 0.07, f0: 990, decay: 0.025, gain: 0.6 });
      return finish(b, 0.7);
    },
  },
  {
    id: "sfx-toggle-off", title: "Toggle Off", category: "interface", tags: ["ui", "switch", "disable"],
    make() {
      const b = buf(0.2);
      tone(b, { dur: 0.05, f0: 990, decay: 0.02, gain: 0.6 });
      tone(b, { at: 0.06, dur: 0.07, f0: 660, decay: 0.025, gain: 0.6 });
      return finish(b, 0.7);
    },
  },
  {
    id: "sfx-typewriter", title: "Typewriter", category: "interface", tags: ["typing", "writing", "retro", "title"],
    make() {
      const b = buf(2.3);
      const r = rng(60);
      let t = 0.02;
      for (let k = 0; k < 10; k++) {
        noiseBurst(b, { at: t, dur: 0.04, decay: 0.006, filter: ["bandpass", 1800, 1.4], gain: r.range(0.7, 1), pan: r.range(-0.2, 0.2), seed: 700 + k });
        tone(b, { at: t, dur: 0.05, f0: 300, decay: 0.012, gain: 0.35 });
        t += r.range(0.1, 0.16);
      }
      bell(b, { t: 1.45, dur: 0.8, midi: 100, vel: 0.6 }, { ratio: 3.5, index: 1, decay: 0.6 });
      whooshInto(b, { at: 1.6, dur: 0.35, from: 800, peak: 2500, to: 2000, q: 3, seed: 61, gain: 0.5, shape: 0.8, panFrom: 0.3, panTo: -0.3 });
      return finish(withVerb(b, { wet: 0.08, room: 0.3 }));
    },
  },
  {
    id: "sfx-drop-thud", title: "Drop Thud", category: "interface", tags: ["drop", "land", "place", "heavy"],
    make() {
      const b = buf(0.5);
      tone(b, { dur: 0.3, f0: 95, f1: 50, decay: 0.12, gain: 1 });
      noiseBurst(b, { dur: 0.08, decay: 0.02, filter: ["lowpass", 400], gain: 0.6, seed: 62 });
      return finish(b);
    },
  },

  // ---- Transitions ---------------------------------------------------------------------------
  {
    id: "sfx-rewind", title: "Rewind", category: "transitions", tags: ["tape", "flashback", "back", "vhs"],
    make() {
      const b = buf(1.5);
      const r = rng(63);
      for (let k = 0; k < 70; k++) {
        const u = k / 70;
        tone(b, { at: u * 1.2, dur: 0.014, f0: 400 * 7.5 ** u * r.range(0.9, 1.1), wave: "saw", decay: 0.008, gain: 0.25, pan: r.range(-0.3, 0.3) });
      }
      whooshInto(b, { dur: 1.25, from: 400, peak: 2500, to: 4500, q: 2, seed: 64, gain: 0.5, shape: 0.6 });
      eq(b, "lowpass", 6000);
      return finish(b);
    },
  },
  {
    id: "sfx-tv-static", title: "TV Static", category: "transitions", tags: ["glitch", "noise", "retro", "signal"],
    make() {
      const b = buf(1.4);
      const r = rng(65);
      const hp = new Biquad("highpass", 400);
      render(b, 0, 1.4, (t) => hp.process(r.bi()) * (0.75 + 0.25 * Math.sin(TAU * 50 * t)) * (r() < 0.002 ? 2 : 1) * Math.min(1, t / 0.02, (1.4 - t) / 0.08) * 0.5);
      return finish(b, 0.7);
    },
  },

  // ---- Cinematic -----------------------------------------------------------------------------
  {
    id: "sfx-dramatic-sting", title: "Dramatic Sting", category: "cinematic", tags: ["dun dun dun", "suspense", "reveal", "shock"],
    make() {
      const b = buf(4.2);
      const k = kit("cinematic");
      const hits = [[0, 0.3, [50, 53, 57]], [0.38, 0.3, [50, 53, 57]], [0.8, 2.4, [49, 53, 56]]];
      for (const [t, dur, chord] of hits) {
        for (const m of chord) sawEnsemble(b, { t, dur, midi: m, vel: 0.9 }, { voices: 3, detuneCents: 10, attack: 0.015, decay: 0.6, sustain: 0.7, release: 0.6 });
        piano(b, { t, dur, midi: chord[0] - 12, vel: 1 });
        placeMono(b, k.taiko, t, 1, 0);
      }
      eq(b, "lowpass", 3500);
      return finish(withVerb(b, { wet: 0.35, room: 0.85 }));
    },
  },
  {
    id: "sfx-heartbeat", title: "Heartbeat", category: "cinematic", tags: ["tension", "suspense", "medical", "pulse"],
    make() {
      const b = buf(2.2);
      for (const beat of [0, 0.95]) {
        tone(b, { at: beat, dur: 0.25, f0: 70, f1: 45, decay: 0.08, gain: 1 });
        tone(b, { at: beat + 0.28, dur: 0.22, f0: 80, f1: 50, decay: 0.07, gain: 0.7 });
      }
      eq(b, "lowpass", 300);
      return finish(b);
    },
  },

  // ---- Science & lecture ---------------------------------------------------------------------
  {
    id: "sfx-computer-processing", title: "Computer Processing", category: "science", tags: ["data", "analysis", "sci-fi", "research", "computing"],
    make() {
      const b = buf(1.8);
      const r = rng(66);
      for (let t = 0; t < 1.6; t += 0.06) {
        if (r() < 0.25) continue;
        tone(b, { at: t, dur: 0.05, f0: r.pick([880, 1100, 1320, 1760, 2200]), decay: 0.025, gain: 0.35, pan: r.range(-0.4, 0.4) });
      }
      render(b, 0, 1.7, (t) => Math.sin(TAU * 120 * t) * 0.05 * Math.min(1, t / 0.1, (1.7 - t) / 0.1));
      eq(b, "lowpass", 6000);
      return finish(b, 0.75);
    },
  },
  {
    id: "sfx-sonar-ping", title: "Sonar Ping", category: "science", tags: ["radar", "ocean", "scan", "detect"],
    make() {
      const b = buf(3.2);
      tone(b, { dur: 0.9, f0: 1180, f1: 1120, decay: 0.25, gain: 0.8 });
      return finish(withVerb(b, { wet: 0.6, room: 0.92, damp: 0.25, preDelay: 0.04 }));
    },
  },
  {
    id: "sfx-geiger-counter", title: "Geiger Counter", category: "science", tags: ["radiation", "physics", "lab", "detector"],
    make() {
      const b = buf(2.3);
      const r = rng(67);
      let t = 0;
      while (t < 2.2) {
        const rate = 5 + 55 * (t / 2.2) ** 1.5;
        t += -Math.log(1 - r()) / rate;
        if (t >= 2.2) break;
        noiseBurst(b, { at: t, dur: 0.006, decay: 0.0015, filter: ["highpass", 2000], gain: r.range(0.6, 1), seed: Math.round(t * 1e5) });
      }
      return finish(b, 0.8);
    },
  },
  {
    id: "sfx-bubbling-beaker", title: "Bubbling Beaker", category: "science", tags: ["chemistry", "lab", "boiling", "experiment"],
    make() {
      const b = buf(3);
      const r = rng(68);
      for (let k = 0; k < 80; k++) {
        const f0 = r.range(300, 900);
        tone(b, { at: r.range(0, 2.8), dur: r.range(0.03, 0.07), f0, f1: f0 * 1.8, decay: 0.02, gain: r.range(0.15, 0.4), pan: r.range(-0.6, 0.6) });
      }
      const hp = new Biquad("highpass", 4000);
      render(b, 0, 3, (t) => hp.process(r.bi()) * 0.05 * (0.7 + 0.3 * Math.sin(TAU * 1.3 * t)));
      return finish(fadeEdges(b, 0.2, 0.3), 0.75);
    },
  },
  {
    id: "sfx-electric-zap", title: "Electric Zap", category: "science", tags: ["electricity", "spark", "physics", "shock"],
    make() {
      const b = buf(0.9);
      const r = rng(69);
      const hp = new Biquad("highpass", 1500);
      let burst = 0;
      render(b, 0, 0.75, (t) => {
        if (r() < 0.004) burst = 1;
        burst *= 0.995;
        const buzz = Math.tanh(4 * (2 * ((t * 60) % 1) - 1)) * 0.3;
        return (hp.process(r.bi()) * burst + buzz * (0.5 + burst)) * Math.exp(-t / 0.4);
      });
      return finish(b, 0.8);
    },
  },
  {
    id: "sfx-ecg-monitor", title: "Heart Monitor", category: "science", tags: ["medical", "hospital", "ecg", "health"],
    make() {
      const b = buf(2.6);
      for (const at of [0, 0.85, 1.7]) render(b, at, 0.11, (t) => Math.sin(TAU * 1000 * t) * Math.min(1, t / 0.003, (0.11 - t) / 0.01) * 0.5);
      return finish(withVerb(b, { wet: 0.1, room: 0.4 }), 0.75);
    },
  },
  {
    id: "sfx-chalk-writing", title: "Chalk on Blackboard", category: "science", tags: ["lecture", "teacher", "classroom", "writing", "math"],
    make() {
      const b = buf(2.2);
      const r = rng(70);
      let t = 0.05;
      for (let k = 0; k < 7; k++) {
        const dur = r.range(0.12, 0.3);
        const bp = new Biquad("bandpass", r.range(2500, 4000), 2);
        render(b, t, dur, (x) => bp.process(r.bi()) * (0.5 + 0.5 * r()) * Math.min(1, x / 0.01, (dur - x) / 0.02) * 1.6, r.range(-0.2, 0.2));
        if (r() < 0.5) noiseBurst(b, { at: t + dur, dur: 0.02, decay: 0.004, filter: ["lowpass", 1500], gain: 0.5, seed: 800 + k });
        t += dur + r.range(0.05, 0.12);
      }
      return finish(withVerb(b, { wet: 0.15, room: 0.6 }), 0.8);
    },
  },
  {
    id: "sfx-page-turn", title: "Page Turn", category: "science", tags: ["paper", "book", "research", "document", "lecture"],
    make() {
      const b = buf(0.9);
      whooshInto(b, { dur: 0.55, from: 900, peak: 3500, to: 1500, q: 0.8, seed: 71, shape: 1.4, panFrom: 0.3, panTo: -0.3 });
      const r = rng(72);
      for (let k = 0; k < 8; k++) noiseBurst(b, { at: r.pick([r.range(0, 0.12), r.range(0.45, 0.6)]), dur: 0.015, decay: 0.003, filter: ["highpass", 3000], gain: r.range(0.2, 0.5), seed: 900 + k });
      return finish(b, 0.8);
    },
  },
  {
    id: "sfx-eureka", title: "Eureka", category: "science", tags: ["idea", "discovery", "insight", "lightbulb"],
    make() {
      const b = buf(2.2);
      whooshInto(b, { dur: 0.4, from: 1500, peak: 6000, to: 8000, q: 1.5, seed: 73, gain: 0.25, shape: 1 });
      [79, 84, 88, 91].forEach((m, i) => mallet(b, { t: 0.15 + i * 0.05, dur: 1, midi: m, vel: 0.6, pan: -0.3 + i * 0.2 }, { kind: "glock" }));
      bell(b, { t: 0.36, dur: 1.4, midi: 96, vel: 0.5 }, { decay: 1.1, index: 1.2 });
      return finish(withVerb(b, { wet: 0.35, room: 0.8 }));
    },
  },
  {
    id: "sfx-data-transfer", title: "Data Transfer", category: "science", tags: ["upload", "download", "network", "data", "sync"],
    make() {
      const b = buf(1.1);
      for (let k = 0; k < 12; k++) tone(b, { at: k * 0.05, dur: 0.035, f0: 600 * 4 ** (k / 11), decay: 0.015, gain: 0.35 });
      tone(b, { at: 0.68, dur: 0.07, f0: 2400, decay: 0.03, gain: 0.45 });
      tone(b, { at: 0.78, dur: 0.12, f0: 3200, decay: 0.05, gain: 0.45 });
      return finish(withVerb(b, { wet: 0.1, room: 0.3 }), 0.75);
    },
  },
  {
    id: "sfx-morse-code", title: "Morse Code", category: "science", tags: ["signal", "telegraph", "message", "sos"],
    make() {
      const b = buf(2.4);
      const unit = 0.07;
      let t = 0.05;
      for (const ch of "... --- ...") {
        if (ch === " ") {
          t += unit * 2;
          continue;
        }
        const len = ch === "." ? unit : unit * 3;
        render(b, t, len, (x) => Math.sin(TAU * 700 * x) * Math.min(1, x / 0.004, (len - x) / 0.004) * 0.5);
        t += len + unit;
      }
      return finish(b, 0.75);
    },
  },

  // ---- Ambience beds -------------------------------------------------------------------------
  {
    id: "sfx-deep-space", title: "Deep Space", category: "ambience", tags: ["space", "astronomy", "drone", "background", "cosmos"],
    make() {
      const b = buf(10);
      const r = rng(74);
      const bpL = new Biquad("bandpass", 400, 1.5);
      const bpR = new Biquad("bandpass", 420, 1.5);
      const n = b.length;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        if ((i & 63) === 0) {
          const f = 300 + 500 * (0.5 + 0.5 * Math.sin((TAU * t) / 10));
          bpL.set(f);
          bpR.set(f * 1.1);
        }
        const drone = (Math.sin(TAU * 55 * t) + 0.6 * Math.sin(TAU * 82.6 * t) + 0.4 * Math.sin(TAU * 110.3 * t)) * (0.6 + 0.4 * Math.sin((TAU * t) / 7));
        b.L[i] += drone * 0.18 + bpL.process(r.bi()) * 0.25;
        b.R[i] += drone * 0.18 + bpR.process(r.bi()) * 0.25;
      }
      for (const t of [2.5, 6.4]) bell(b, { t, dur: 2, midi: 96, vel: 0.15, pan: t < 4 ? -0.5 : 0.5 }, { decay: 2.5, index: 1 });
      return finish(fadeEdges(withVerb(b, { wet: 0.4, room: 0.95 }), 2, 2), 0.7);
    },
  },
  {
    id: "sfx-lab-room-tone", title: "Lab Room Tone", category: "ambience", tags: ["lab", "server", "hum", "background", "office"],
    make() {
      const b = buf(10);
      const r = rng(75);
      const lp = new Biquad("lowpass", 900);
      render(b, 0, 10, (t) => (Math.sin(TAU * 60 * t) * 0.2 + Math.sin(TAU * 120 * t) * 0.1 + Math.sin(TAU * 180 * t) * 0.05) * 0.5 + lp.process(r.bi()) * 0.35 * (0.95 + 0.05 * Math.sin(TAU * 3 * t)));
      for (const at of [3, 7.5]) render(b, at, 0.12, (t) => Math.sin(TAU * 1000 * t) * Math.min(1, t / 0.005, (0.12 - t) / 0.01) * 0.04, 0.4);
      return finish(fadeEdges(b, 0.5, 0.5), 0.6);
    },
  },
];
