// utils/builtinSfx.ts
//
// Briefcast's own sound effects - whooshes, risers, impacts, pops, glitches, sparkles, camera
// shutters, rain, wind, waves, birds, fire -
// synthesized on the spot with Web Audio (an OfflineAudioContext per sound, from fixed seeds, so a
// sound is identical every time it's made) and kept as WAV files in the library's own folder
// (store_builtin_sound). They sit in the music library's Sound effects tab next to the catalog's,
// as ordinary library tracks with ids "builtin:<name>" - previews, adding, saving and the
// project's audio overlays all work the same. Ours, so free of any licence.
import { invoke } from "@tauri-apps/api/core";
import type { MusicTrack } from "./musicLibrary";

const SAMPLE_RATE = 48000;
// Bump when a sound's recipe changes, so the stored file is made again.
const RECIPE_VERSION = 1;

type Render = (ctx: OfflineAudioContext, noise: (seconds: number, seed: number) => AudioBuffer) => void;

interface SfxRecipe {
  name: string;
  title: string;
  seconds: number;
  tags: string[];
  moods: string[];
  render: Render;
}

// ---------- building blocks ----------

// xorshift white noise, seeded.
function makeNoise(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const length = Math.max(1, Math.ceil(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    let s = (seed * 2654435761 + ch * 97) >>> 0 || 1;
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      data[i] = (s / 4294967296) * 2 - 1;
    }
  }
  return buffer;
}

function noiseSource(ctx: BaseAudioContext, noise: (s: number, seed: number) => AudioBuffer, seconds: number, seed: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noise(seconds, seed);
  return src;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

// A gain with an attack/decay envelope starting at `at`.
function envelope(ctx: BaseAudioContext, at: number, attack: number, peak: number, decay: number, curve: "exp" | "lin" = "exp"): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(peak, at + Math.max(0.001, attack));
  if (curve === "exp") g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  else g.gain.linearRampToValueAtTime(0, at + attack + decay);
  return g;
}

function osc(ctx: BaseAudioContext, type: OscillatorType, freq: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  return o;
}

// tanh saturation, `drive` > 1 for more.
function saturator(ctx: BaseAudioContext, drive: number): WaveShaperNode {
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  shaper.curve = curve;
  return shaper;
}

// Connects each node to the next; the last may be an AudioParam (an LFO modulating it).
function chain(...nodes: [...AudioNode[], AudioNode | AudioParam]): void {
  for (let i = 0; i < nodes.length - 1; i++) (nodes[i] as AudioNode).connect(nodes[i + 1] as AudioNode);
}

function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// A struck bell: inharmonic partials, each decaying on its own.
function bell(ctx: BaseAudioContext, out: AudioNode, at: number, freq: number, level: number, length: number): void {
  const partials: [number, number, number][] = [
    [1, 1, 1],
    [2.76, 0.45, 0.6],
    [5.4, 0.22, 0.35],
    [8.93, 0.1, 0.2],
  ];
  for (const [ratio, amp, life] of partials) {
    const o = osc(ctx, "sine", freq * ratio);
    chain(o, envelope(ctx, at, 0.003, level * amp, length * life), out);
    o.start(at);
    o.stop(at + length + 0.05);
  }
}

// A camera's shutter at `at`: the mirror slapping up (a low thunk and a bright click) and the
// curtain closing a moment later.
function cameraClick(ctx: BaseAudioContext, noise: (s: number, seed: number) => AudioBuffer, at: number, seed: number, level: number): void {
  for (const [dt, decay, peak, f] of [
    [0, 0.035, 0.95, 3400],
    [0.075, 0.05, 0.7, 2600],
  ] as const) {
    const src = noiseSource(ctx, noise, 0.1, seed + dt * 100);
    chain(src, filter(ctx, "bandpass", f, 0.9), envelope(ctx, at + dt, 0.001, peak * level, decay), ctx.destination);
    src.start(at + dt);
  }
  const thunk = osc(ctx, "sine", 210);
  thunk.frequency.setValueAtTime(210, at);
  thunk.frequency.exponentialRampToValueAtTime(120, at + 0.05);
  chain(thunk, envelope(ctx, at, 0.001, 0.45 * level, 0.055), ctx.destination);
  thunk.start(at);
  thunk.stop(at + 0.1);
}

// Rain: a wash of filtered noise and `drops` droplets scattered over it.
function rain(ctx: BaseAudioContext, noise: (s: number, seed: number) => AudioBuffer, seconds: number, seed: number, level: number, drops: number): void {
  const wash = noiseSource(ctx, noise, seconds, seed);
  const g = ctx.createGain();
  g.gain.value = 0.28 + 0.4 * level;
  chain(wash, filter(ctx, "highpass", 350), filter(ctx, "lowpass", 2200 + 3000 * level, 0.5), g, ctx.destination);
  wash.start(0);
  const r = rand(seed + 1);
  for (let k = 0; k < drops; k++) {
    const at = r() * (seconds - 0.05);
    const src = noiseSource(ctx, noise, 0.03, seed + 2 + (k % 11));
    const pan = ctx.createStereoPanner();
    pan.pan.value = r() * 1.8 - 0.9;
    chain(src, filter(ctx, "bandpass", 2000 + r() * 5000, 3), envelope(ctx, at, 0.001, 0.15 + r() * 0.35, 0.01 + r() * 0.015), pan, ctx.destination);
    src.start(at);
  }
}

// Birdsong: chirps, whistles and trills from birds about the stereo field. `density` scales how
// many.
function birds(ctx: BaseAudioContext, seconds: number, seed: number, density: number): void {
  const r = rand(seed);
  const calls = Math.round(16 * density);
  for (let k = 0; k < calls; k++) {
    const at = r() * (seconds - 0.8);
    const pan = ctx.createStereoPanner();
    pan.pan.value = r() * 1.6 - 0.8;
    const level = (0.12 + r() * 0.15) * (density < 1 ? 0.7 : 1);
    pan.connect(ctx.destination);
    const kind = Math.floor(r() * 3);
    const base = 2400 + r() * 2200;
    const notes = kind === 2 ? 6 + Math.floor(r() * 5) : 1 + Math.floor(r() * 3);
    for (let n = 0; n < notes; n++) {
      const t0 = at + n * (kind === 2 ? 0.05 : 0.14);
      const len = kind === 2 ? 0.035 : 0.08 + r() * 0.06;
      const o = osc(ctx, "sine", base);
      if (kind === 0) {
        // A falling chirp.
        o.frequency.setValueAtTime(base * 1.35, t0);
        o.frequency.exponentialRampToValueAtTime(base * 0.85, t0 + len);
      } else if (kind === 1) {
        // A rising whistle with a wobble.
        o.frequency.setValueAtTime(base * 0.8, t0);
        o.frequency.exponentialRampToValueAtTime(base * 1.25, t0 + len);
        const vib = osc(ctx, "sine", 28);
        const vd = ctx.createGain();
        vd.gain.value = base * 0.04;
        chain(vib, vd, o.frequency);
        vib.start(t0);
        vib.stop(t0 + len + 0.02);
      } else {
        // A trill: quick repeated tweets.
        o.frequency.setValueAtTime(base * 1.1, t0);
        o.frequency.exponentialRampToValueAtTime(base * 0.95, t0 + len);
      }
      chain(o, envelope(ctx, t0, 0.006, level, len), pan);
      o.start(t0);
      o.stop(t0 + len + 0.02);
    }
  }
}

// ---------- the sounds ----------

const RECIPES: SfxRecipe[] = [
  {
    name: "whoosh",
    title: "Whoosh",
    seconds: 0.8,
    tags: ["transition", "swish", "fast"],
    moods: ["transition"],
    render: (ctx, noise) => {
      const src = noiseSource(ctx, noise, 0.8, 1);
      const bp = filter(ctx, "bandpass", 250, 1.1);
      bp.frequency.setValueAtTime(250, 0);
      bp.frequency.exponentialRampToValueAtTime(2800, 0.36);
      bp.frequency.exponentialRampToValueAtTime(450, 0.78);
      const pan = ctx.createStereoPanner();
      pan.pan.setValueAtTime(-0.8, 0);
      pan.pan.linearRampToValueAtTime(0.8, 0.75);
      chain(src, bp, envelope(ctx, 0, 0.34, 1, 0.44), pan, ctx.destination);
      src.start(0);
    },
  },
  {
    name: "swoosh",
    title: "Quick swoosh",
    seconds: 0.45,
    tags: ["transition", "swish", "fast", "whip"],
    moods: ["transition"],
    render: (ctx, noise) => {
      const src = noiseSource(ctx, noise, 0.45, 2);
      const bp = filter(ctx, "bandpass", 600, 1.4);
      bp.frequency.setValueAtTime(600, 0);
      bp.frequency.exponentialRampToValueAtTime(5000, 0.16);
      bp.frequency.exponentialRampToValueAtTime(1400, 0.44);
      const pan = ctx.createStereoPanner();
      pan.pan.setValueAtTime(0.7, 0);
      pan.pan.linearRampToValueAtTime(-0.7, 0.42);
      chain(src, bp, envelope(ctx, 0, 0.15, 1, 0.28), pan, ctx.destination);
      src.start(0);
    },
  },
  {
    name: "swipe",
    title: "Swipe",
    seconds: 0.32,
    tags: ["transition", "ui", "slide"],
    moods: ["transition", "ui"],
    render: (ctx, noise) => {
      const src = noiseSource(ctx, noise, 0.32, 3);
      const bp = filter(ctx, "bandpass", 1500, 2);
      bp.frequency.setValueAtTime(1500, 0);
      bp.frequency.exponentialRampToValueAtTime(6500, 0.28);
      chain(src, bp, envelope(ctx, 0, 0.08, 0.9, 0.22), ctx.destination);
      src.start(0);
    },
  },
  {
    name: "riser",
    title: "Riser",
    seconds: 2.3,
    tags: ["build", "tension", "transition", "uplifter"],
    moods: ["impact", "transition"],
    render: (ctx, noise) => {
      const lp = filter(ctx, "lowpass", 400, 1.5);
      lp.frequency.setValueAtTime(400, 0);
      lp.frequency.exponentialRampToValueAtTime(9000, 2.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.03, 0);
      g.gain.exponentialRampToValueAtTime(0.9, 2.15);
      g.gain.linearRampToValueAtTime(0, 2.25);
      chain(lp, g, ctx.destination);
      const src = noiseSource(ctx, noise, 2.3, 4);
      const srcGain = ctx.createGain();
      srcGain.gain.value = 0.7;
      chain(src, srcGain, lp);
      for (const detune of [-12, 0, 9]) {
        const o = osc(ctx, "sawtooth", 180);
        o.detune.value = detune;
        o.frequency.setValueAtTime(180, 0);
        o.frequency.exponentialRampToValueAtTime(1150, 2.2);
        const og = ctx.createGain();
        og.gain.value = 0.12;
        chain(o, og, lp);
        o.start(0);
        o.stop(2.3);
      }
      src.start(0);
    },
  },
  {
    name: "reverse-cymbal",
    title: "Reverse swell",
    seconds: 1.9,
    tags: ["build", "transition", "cymbal", "reverse"],
    moods: ["transition"],
    render: (ctx, noise) => {
      const src = noiseSource(ctx, noise, 1.9, 5);
      const hp = filter(ctx, "highpass", 4500, 0.7);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0005, 0);
      g.gain.exponentialRampToValueAtTime(0.75, 1.82);
      g.gain.linearRampToValueAtTime(0, 1.86);
      chain(src, hp, g, ctx.destination);
      src.start(0);
    },
  },
  {
    name: "boom",
    title: "Boom",
    seconds: 2.0,
    tags: ["impact", "hit", "bass", "cinematic"],
    moods: ["impact"],
    render: (ctx, noise) => {
      const sat = saturator(ctx, 2.2);
      sat.connect(ctx.destination);
      const o = osc(ctx, "sine", 90);
      o.frequency.setValueAtTime(90, 0);
      o.frequency.exponentialRampToValueAtTime(32, 0.6);
      chain(o, envelope(ctx, 0, 0.005, 1, 1.8), sat);
      o.start(0);
      o.stop(2);
      const src = noiseSource(ctx, noise, 0.4, 6);
      chain(src, filter(ctx, "lowpass", 900), envelope(ctx, 0, 0.002, 0.8, 0.28), sat);
      src.start(0);
    },
  },
  {
    name: "hit",
    title: "Punch hit",
    seconds: 0.55,
    tags: ["impact", "kick", "beat"],
    moods: ["impact"],
    render: (ctx, noise) => {
      const o = osc(ctx, "sine", 160);
      o.frequency.setValueAtTime(160, 0);
      o.frequency.exponentialRampToValueAtTime(48, 0.12);
      chain(o, envelope(ctx, 0, 0.002, 1, 0.45), saturator(ctx, 1.6), ctx.destination);
      o.start(0);
      o.stop(0.55);
      const src = noiseSource(ctx, noise, 0.05, 7);
      chain(src, filter(ctx, "highpass", 2000), envelope(ctx, 0, 0.001, 0.6, 0.025), ctx.destination);
      src.start(0);
    },
  },
  {
    name: "sub-drop",
    title: "Sub drop",
    seconds: 2.5,
    tags: ["impact", "bass", "drop", "trailer"],
    moods: ["impact"],
    render: (ctx) => {
      const o = osc(ctx, "sine", 72);
      o.frequency.setValueAtTime(72, 0);
      o.frequency.exponentialRampToValueAtTime(28, 2.0);
      chain(o, envelope(ctx, 0, 0.02, 1, 2.4), saturator(ctx, 1.3), ctx.destination);
      o.start(0);
      o.stop(2.5);
    },
  },
  {
    name: "pop",
    title: "Pop",
    seconds: 0.25,
    tags: ["ui", "bubble", "appear", "cute"],
    moods: ["ui"],
    render: (ctx, noise) => {
      const o = osc(ctx, "sine", 300);
      o.frequency.setValueAtTime(300, 0);
      o.frequency.exponentialRampToValueAtTime(1300, 0.06);
      chain(o, envelope(ctx, 0, 0.004, 0.9, 0.18), ctx.destination);
      o.start(0);
      o.stop(0.25);
      const src = noiseSource(ctx, noise, 0.02, 8);
      chain(src, filter(ctx, "highpass", 3000), envelope(ctx, 0, 0.001, 0.25, 0.012), ctx.destination);
      src.start(0);
    },
  },
  {
    name: "click",
    title: "Click",
    seconds: 0.08,
    tags: ["ui", "tap", "button", "mouse"],
    moods: ["ui"],
    render: (ctx) => {
      const o = osc(ctx, "square", 1800);
      chain(o, filter(ctx, "highpass", 1200), envelope(ctx, 0, 0.001, 0.5, 0.05), ctx.destination);
      o.start(0);
      o.stop(0.08);
    },
  },
  {
    name: "notify",
    title: "Notification",
    seconds: 0.7,
    tags: ["ui", "alert", "message", "chime"],
    moods: ["ui"],
    render: (ctx) => {
      bell(ctx, ctx.destination, 0, 880, 0.45, 0.5);
      bell(ctx, ctx.destination, 0.13, 1318.5, 0.45, 0.55);
    },
  },
  {
    name: "ding",
    title: "Ding",
    seconds: 1.7,
    tags: ["bell", "correct", "chime", "ui"],
    moods: ["ui", "magic"],
    render: (ctx) => bell(ctx, ctx.destination, 0, 1046.5, 0.7, 1.6),
  },
  {
    name: "sparkle",
    title: "Sparkle",
    seconds: 1.8,
    tags: ["magic", "shine", "glitter", "reveal"],
    moods: ["magic"],
    render: (ctx, noise) => {
      // A rising pentatonic run of little bells over a breath of shimmer.
      const notes = [1046.5, 1318.5, 1568, 1760, 2093, 2637, 3136];
      notes.forEach((f, i) => bell(ctx, ctx.destination, i * 0.075, f, 0.22, 0.9));
      const src = noiseSource(ctx, noise, 1.2, 9);
      chain(src, filter(ctx, "bandpass", 8000, 1.5), envelope(ctx, 0, 0.25, 0.12, 0.9), ctx.destination);
      src.start(0);
    },
  },
  {
    name: "flash",
    title: "Camera flash",
    seconds: 1.4,
    tags: ["camera", "photo", "charge", "flash"],
    moods: ["retro"],
    render: (ctx, noise) => {
      const o = osc(ctx, "sine", 1800);
      o.frequency.setValueAtTime(1800, 0);
      o.frequency.exponentialRampToValueAtTime(7500, 0.95);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(0.09, 0.95);
      g.gain.linearRampToValueAtTime(0, 1.0);
      chain(o, g, ctx.destination);
      o.start(0);
      o.stop(1.05);
      const src = noiseSource(ctx, noise, 0.4, 12);
      chain(src, filter(ctx, "highpass", 2500), envelope(ctx, 1.0, 0.002, 0.8, 0.25), ctx.destination);
      src.start(1.0);
      bell(ctx, ctx.destination, 1.0, 2400, 0.2, 0.35);
    },
  },
  {
    name: "glitch",
    title: "Glitch",
    seconds: 0.7,
    tags: ["digital", "error", "tech", "transition"],
    moods: ["transition", "retro"],
    render: (ctx) => {
      // Chopped square tones at random pitches, crushed.
      const r = rand(13);
      const crush = ctx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) curve[i] = Math.round(((i / 255) * 2 - 1) * 6) / 6;
      crush.curve = curve;
      crush.connect(ctx.destination);
      for (let k = 0; k < 14; k++) {
        if (r() < 0.25) continue;
        const at = k * 0.048;
        const o = osc(ctx, r() < 0.5 ? "square" : "sawtooth", 80 + r() * 2300);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, 0);
        g.gain.setValueAtTime(0.32, at);
        g.gain.setValueAtTime(0, at + 0.04);
        chain(o, g, crush);
        o.start(at);
        o.stop(at + 0.045);
      }
    },
  },
  {
    name: "typewriter",
    title: "Typewriter",
    seconds: 1.7,
    tags: ["typing", "keys", "text", "retro"],
    moods: ["retro", "ui"],
    render: (ctx, noise) => {
      const r = rand(14);
      let at = 0.02;
      let k = 0;
      while (at < 1.35) {
        const src = noiseSource(ctx, noise, 0.04, 20 + k);
        chain(src, filter(ctx, "highpass", 1200), envelope(ctx, at, 0.001, 0.55 + r() * 0.3, 0.025), ctx.destination);
        src.start(at);
        const o = osc(ctx, "sine", 1900 + r() * 600);
        chain(o, envelope(ctx, at, 0.001, 0.08, 0.02), ctx.destination);
        o.start(at);
        o.stop(at + 0.04);
        at += 0.085 + r() * 0.08;
        k++;
      }
      bell(ctx, ctx.destination, 1.42, 2093, 0.25, 0.3);
    },
  },
  {
    name: "projector",
    title: "Film projector",
    seconds: 4.0,
    tags: ["film", "vintage", "loop", "retro"],
    moods: ["retro"],
    render: (ctx, noise) => {
      // 24 clatters a second over a motor hum - loops seamlessly (a whole number of frames).
      const out = ctx.createGain();
      out.gain.value = 0.8;
      out.connect(ctx.destination);
      for (let k = 0; k < 96; k++) {
        const at = k / 24;
        const src = noiseSource(ctx, noise, 0.03, 40 + (k % 7));
        chain(src, filter(ctx, "bandpass", 1800, 1.2), envelope(ctx, at, 0.001, k % 2 ? 0.35 : 0.55, 0.012), out);
        src.start(at);
      }
      const hum = osc(ctx, "sawtooth", 55);
      const hg = ctx.createGain();
      hg.gain.value = 0.05;
      chain(hum, filter(ctx, "lowpass", 220), hg, out);
      hum.start(0);
      hum.stop(4);
    },
  },
  {
    name: "tape-stop",
    title: "Tape stop",
    seconds: 1.1,
    tags: ["stop", "slow down", "record", "transition"],
    moods: ["transition", "retro"],
    render: (ctx) => {
      const lp = filter(ctx, "lowpass", 2400);
      lp.frequency.setValueAtTime(2400, 0);
      lp.frequency.exponentialRampToValueAtTime(250, 0.95);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.25, 0);
      g.gain.setValueAtTime(0.25, 0.7);
      g.gain.linearRampToValueAtTime(0, 1.05);
      chain(lp, g, ctx.destination);
      for (const f of [220, 277.2, 329.6]) {
        const o = osc(ctx, "sawtooth", f);
        o.frequency.setValueAtTime(f, 0);
        o.frequency.exponentialRampToValueAtTime(f / 12, 1.0);
        o.connect(lp);
        o.start(0);
        o.stop(1.1);
      }
    },
  },
  // ---------- camera ----------
  {
    name: "shutter",
    title: "DSLR shutter",
    seconds: 0.4,
    tags: ["camera", "photo", "snap", "click"],
    moods: ["camera"],
    render: (ctx, noise) => cameraClick(ctx, noise, 0, 10, 1),
  },
  {
    name: "shutter-burst",
    title: "Burst shots",
    seconds: 1.0,
    tags: ["camera", "photo", "rapid", "continuous", "click"],
    moods: ["camera"],
    render: (ctx, noise) => {
      for (let k = 0; k < 8; k++) cameraClick(ctx, noise, k * 0.105, 60 + k, 0.85);
    },
  },
  {
    name: "film-advance",
    title: "Film camera wind",
    seconds: 1.1,
    tags: ["camera", "film", "analog", "lever", "click", "vintage"],
    moods: ["camera", "retro"],
    render: (ctx, noise) => {
      cameraClick(ctx, noise, 0, 70, 1);
      // The lever ratcheting the film on.
      const r = rand(71);
      for (let k = 0; k < 11; k++) {
        const at = 0.35 + k * 0.045 + r() * 0.01;
        const src = noiseSource(ctx, noise, 0.03, 72 + k);
        chain(src, filter(ctx, "bandpass", 2600 + r() * 900, 2.5), envelope(ctx, at, 0.001, 0.45, 0.018), ctx.destination);
        src.start(at);
      }
    },
  },
  {
    name: "focus-beep",
    title: "Focus beep + click",
    seconds: 0.75,
    tags: ["camera", "photo", "autofocus", "beep", "click"],
    moods: ["camera"],
    render: (ctx, noise) => {
      for (const at of [0, 0.11]) {
        const o = osc(ctx, "sine", 2800);
        chain(o, envelope(ctx, at, 0.003, 0.25, 0.06, "lin"), ctx.destination);
        o.start(at);
        o.stop(at + 0.08);
      }
      cameraClick(ctx, noise, 0.3, 80, 1);
    },
  },
  {
    name: "instant-camera",
    title: "Instant camera",
    seconds: 1.6,
    tags: ["camera", "polaroid", "instant", "print", "motor"],
    moods: ["camera", "retro"],
    render: (ctx, noise) => {
      cameraClick(ctx, noise, 0, 90, 1);
      // The print being pushed out: a little motor, whirring up and down.
      const motor = osc(ctx, "sawtooth", 110);
      motor.frequency.setValueAtTime(90, 0.25);
      motor.frequency.linearRampToValueAtTime(140, 0.45);
      motor.frequency.setValueAtTime(140, 1.25);
      motor.frequency.linearRampToValueAtTime(80, 1.45);
      chain(motor, filter(ctx, "lowpass", 900, 1.5), envelope(ctx, 0.25, 0.08, 0.3, 1.2, "lin"), ctx.destination);
      motor.start(0.25);
      motor.stop(1.6);
      const src = noiseSource(ctx, noise, 1.3, 91);
      chain(src, filter(ctx, "bandpass", 3500, 1), envelope(ctx, 0.25, 0.1, 0.06, 1.15, "lin"), ctx.destination);
      src.start(0.25);
    },
  },
  {
    name: "vintage-camera",
    title: "Vintage camera",
    seconds: 0.9,
    tags: ["camera", "old", "mechanical", "spring", "click", "vintage"],
    moods: ["camera", "retro"],
    render: (ctx, noise) => {
      cameraClick(ctx, noise, 0, 100, 0.9);
      // The spring's ring after the curtain drops.
      bell(ctx, ctx.destination, 0.02, 1650, 0.12, 0.7);
      const o = osc(ctx, "triangle", 190);
      chain(o, envelope(ctx, 0.01, 0.002, 0.35, 0.18), ctx.destination);
      o.start(0);
      o.stop(0.3);
    },
  },

  // ---------- nature ----------
  {
    name: "rain-light",
    title: "Light rain",
    seconds: 8,
    tags: ["nature", "rain", "weather", "ambience", "loop", "calm"],
    moods: ["nature"],
    render: (ctx, noise) => rain(ctx, noise, 8, 110, 0.35, 140),
  },
  {
    name: "rain-heavy",
    title: "Heavy rain",
    seconds: 8,
    tags: ["nature", "rain", "storm", "downpour", "weather", "ambience", "loop"],
    moods: ["nature"],
    render: (ctx, noise) => rain(ctx, noise, 8, 120, 0.8, 520),
  },
  {
    name: "thunder",
    title: "Thunder",
    seconds: 6,
    tags: ["nature", "storm", "weather", "rumble"],
    moods: ["nature", "impact"],
    render: (ctx, noise) => {
      const sat = saturator(ctx, 1.8);
      sat.connect(ctx.destination);
      // The crack, then rolling rumbles of low noise.
      const crack = noiseSource(ctx, noise, 0.6, 130);
      chain(crack, filter(ctx, "highpass", 800), envelope(ctx, 0.05, 0.005, 0.3, 0.45), sat);
      crack.start(0.05);
      const r = rand(131);
      for (let k = 0; k < 5; k++) {
        const at = 0.1 + k * 0.7 + r() * 0.4;
        const src = noiseSource(ctx, noise, 6, 132 + k);
        chain(src, filter(ctx, "lowpass", 160 + r() * 200, 0.9), envelope(ctx, at, 0.15 + r() * 0.2, 1 - k * 0.15, 1.8 + r() * 1.5), sat);
        src.start(0);
      }
    },
  },
  {
    name: "wind",
    title: "Wind",
    seconds: 8,
    tags: ["nature", "wind", "breeze", "weather", "ambience", "loop"],
    moods: ["nature"],
    render: (ctx, noise) => {
      const src = noiseSource(ctx, noise, 8, 140);
      const bp = filter(ctx, "bandpass", 500, 1.8);
      // Gusts: the band and the level drift slowly (whole cycles in the 8s, so it loops).
      const lfo = osc(ctx, "sine", 0.25);
      const depth = ctx.createGain();
      depth.gain.value = 300;
      chain(lfo, depth, bp.frequency);
      const g = ctx.createGain();
      g.gain.value = 0.55;
      const lfo2 = osc(ctx, "sine", 0.375);
      const depth2 = ctx.createGain();
      depth2.gain.value = 0.35;
      chain(lfo2, depth2, g.gain);
      chain(src, bp, g, ctx.destination);
      for (const o of [lfo, lfo2]) {
        o.start(0);
        o.stop(8);
      }
      src.start(0);
    },
  },
  {
    name: "waves",
    title: "Ocean waves",
    seconds: 8,
    tags: ["nature", "ocean", "sea", "beach", "water", "ambience", "loop", "calm"],
    moods: ["nature"],
    render: (ctx, noise) => {
      // Two waves: each swells, breaks, and hisses back down the sand.
      for (const [at, seed] of [
        [0, 150],
        [4, 151],
      ] as const) {
        const swell = noiseSource(ctx, noise, 4, seed);
        const lp = filter(ctx, "lowpass", 300, 0.7);
        lp.frequency.setValueAtTime(300, at);
        lp.frequency.exponentialRampToValueAtTime(2500, at + 1.6);
        lp.frequency.exponentialRampToValueAtTime(600, at + 3.9);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.05, at);
        g.gain.linearRampToValueAtTime(0.9, at + 1.6);
        g.gain.linearRampToValueAtTime(0.18, at + 3.2);
        g.gain.linearRampToValueAtTime(0.05, at + 4);
        chain(swell, lp, g, ctx.destination);
        swell.start(at);
        const hiss = noiseSource(ctx, noise, 2.4, seed + 10);
        chain(hiss, filter(ctx, "highpass", 3000), envelope(ctx, at + 1.7, 0.3, 0.12, 2.0, "lin"), ctx.destination);
        hiss.start(at + 1.7);
      }
    },
  },
  {
    name: "stream",
    title: "Babbling stream",
    seconds: 8,
    tags: ["nature", "water", "river", "brook", "ambience", "loop", "calm"],
    moods: ["nature"],
    render: (ctx, noise) => {
      const bed = noiseSource(ctx, noise, 8, 160);
      const g = ctx.createGain();
      g.gain.value = 0.25;
      chain(bed, filter(ctx, "bandpass", 1800, 0.8), g, ctx.destination);
      bed.start(0);
      // Bubbles: little rising blips.
      const r = rand(161);
      for (let k = 0; k < 140; k++) {
        const at = r() * 7.9;
        const f = 500 + r() * 1300;
        const o = osc(ctx, "sine", f);
        o.frequency.setValueAtTime(f, at);
        o.frequency.exponentialRampToValueAtTime(f * (1.4 + r() * 0.6), at + 0.04);
        const pan = ctx.createStereoPanner();
        pan.pan.value = r() * 1.6 - 0.8;
        chain(o, envelope(ctx, at, 0.004, 0.05 + r() * 0.08, 0.04), pan, ctx.destination);
        o.start(at);
        o.stop(at + 0.06);
      }
    },
  },
  {
    name: "birds",
    title: "Birdsong",
    seconds: 8,
    tags: ["nature", "birds", "morning", "spring", "forest", "ambience", "loop"],
    moods: ["nature"],
    render: (ctx) => birds(ctx, 8, 170, 1),
  },
  {
    name: "crickets",
    title: "Crickets at night",
    seconds: 8,
    tags: ["nature", "night", "insects", "summer", "ambience", "loop", "calm"],
    moods: ["nature"],
    render: (ctx, noise) => {
      const r = rand(180);
      // Three crickets, each chirping three quick pulses on its own rhythm.
      for (let c = 0; c < 3; c++) {
        const freq = 4300 + c * 350;
        const period = 0.55 + c * 0.13;
        const pan = ctx.createStereoPanner();
        pan.pan.value = [-0.6, 0.5, 0.05][c];
        pan.connect(ctx.destination);
        for (let at = r() * period; at < 7.9; at += period) {
          for (let p = 0; p < 3; p++) {
            const t0 = at + p * 0.032;
            const o = osc(ctx, "sine", freq);
            chain(o, envelope(ctx, t0, 0.004, 0.12 - c * 0.025, 0.018, "lin"), pan);
            o.start(t0);
            o.stop(t0 + 0.03);
          }
        }
      }
      const air = noiseSource(ctx, noise, 8, 181);
      const g = ctx.createGain();
      g.gain.value = 0.03;
      chain(air, filter(ctx, "lowpass", 900), g, ctx.destination);
      air.start(0);
    },
  },
  {
    name: "campfire",
    title: "Campfire",
    seconds: 8,
    tags: ["nature", "fire", "crackle", "cozy", "ambience", "loop", "warm"],
    moods: ["nature"],
    render: (ctx, noise) => {
      const roar = noiseSource(ctx, noise, 8, 190);
      const g = ctx.createGain();
      g.gain.value = 0.35;
      chain(roar, filter(ctx, "lowpass", 280, 0.7), g, ctx.destination);
      roar.start(0);
      // Crackles and the odd pop, scattered.
      const r = rand(191);
      for (let k = 0; k < 110; k++) {
        const at = r() * 7.95;
        const big = r() > 0.88;
        const src = noiseSource(ctx, noise, 0.04, 200 + (k % 9));
        const pan = ctx.createStereoPanner();
        pan.pan.value = r() * 1.2 - 0.6;
        chain(src, filter(ctx, "bandpass", big ? 1200 : 2500 + r() * 2500, 1.2), envelope(ctx, at, 0.001, big ? 0.9 : 0.25 + r() * 0.35, big ? 0.03 : 0.008), pan, ctx.destination);
        src.start(at);
      }
    },
  },
  {
    name: "forest",
    title: "Forest ambience",
    seconds: 8,
    tags: ["nature", "forest", "woods", "birds", "breeze", "ambience", "loop", "calm"],
    moods: ["nature"],
    render: (ctx, noise) => {
      const leaves = noiseSource(ctx, noise, 8, 210);
      const bp = filter(ctx, "bandpass", 2400, 0.6);
      const g = ctx.createGain();
      g.gain.value = 0.12;
      const lfo = osc(ctx, "sine", 0.25);
      const depth = ctx.createGain();
      depth.gain.value = 0.07;
      chain(lfo, depth, g.gain);
      chain(leaves, bp, g, ctx.destination);
      lfo.start(0);
      lfo.stop(8);
      leaves.start(0);
      birds(ctx, 8, 211, 0.45);
    },
  },
];

const ID_PREFIX = "builtin:";
export const isBuiltinSfxId = (id: string): boolean => id.startsWith(ID_PREFIX);
const recipeOf = (id: string) => RECIPES.find((r) => ID_PREFIX + r.name === id);

// The pack as library tracks (MusicLibraryPanel lists them with the catalog's sound effects).
export const BUILTIN_SFX_TRACKS: MusicTrack[] = RECIPES.map((r) => ({
  id: ID_PREFIX + r.name,
  title: r.title,
  artist: "Briefcast",
  kind: "sfx",
  moods: r.moods,
  tags: [...r.tags, "built-in"],
  duration: r.seconds,
  peaks: [],
  // Never fetched - the sound is made here (builtinSfxFile).
  file: { url: `builtin/${r.name}.wav`, size: 0, sha256: "0".repeat(64) },
  license: { name: "CC0" },
}));

// Sounds offered for a transition, and how many seconds before the cut each starts - so its peak
// (a whoosh's middle, the end of a rise) lands on the cut; impacts start on it.
export const TRANSITION_SOUNDS: { id: string; label: string; lead: number }[] = [
  { id: "builtin:whoosh", label: "Whoosh", lead: 0.34 },
  { id: "builtin:swoosh", label: "Swoosh", lead: 0.15 },
  { id: "builtin:riser", label: "Riser", lead: 2.15 },
  { id: "builtin:reverse-cymbal", label: "Swell", lead: 1.82 },
  { id: "builtin:boom", label: "Boom", lead: 0 },
  { id: "builtin:glitch", label: "Glitch", lead: 0.1 },
  { id: "builtin:shutter", label: "Shutter", lead: 0 },
  { id: "builtin:sparkle", label: "Sparkle", lead: 0.05 },
];

// Renders a recipe to 16-bit stereo PCM WAV, normalised to -1 dBFS.
async function renderWav(recipe: SfxRecipe): Promise<Uint8Array> {
  const ctx = new OfflineAudioContext(2, Math.ceil(recipe.seconds * SAMPLE_RATE), SAMPLE_RATE);
  const cache = new Map<string, AudioBuffer>();
  const noise = (seconds: number, seed: number) => {
    const key = `${seconds}|${seed}`;
    let b = cache.get(key);
    if (!b) cache.set(key, (b = makeNoise(ctx, seconds, seed)));
    return b;
  };
  recipe.render(ctx, noise);
  const buffer = await ctx.startRendering();
  const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
  let peak = 1e-6;
  let energy = 0;
  for (const ch of channels)
    for (let i = 0; i < ch.length; i++) {
      peak = Math.max(peak, Math.abs(ch[i]));
      energy += ch[i] * ch[i];
    }
  const rms = Math.sqrt(energy / (2 * buffer.length)) || 1e-6;
  // Peaks to -1 dBFS, but nothing sustained louder than about -14 dB RMS - so a glitch or a tape
  // stop sits at the level of a whoosh rather than blaring.
  const gain = Math.min(0.891 / peak, 0.2 / rms);
  const frames = buffer.length;
  const out = new DataView(new ArrayBuffer(44 + frames * 4));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + frames * 4, true);
  text(8, "WAVE");
  text(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 2, true);
  out.setUint32(24, SAMPLE_RATE, true);
  out.setUint32(28, SAMPLE_RATE * 4, true);
  out.setUint16(32, 4, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < 2; c++) out.setInt16(44 + (i * 2 + c) * 2, Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * gain * 32767))), true);
  return new Uint8Array(out.buffer);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const files = new Map<string, Promise<string>>();
// A built-in sound's file on disk - made the first time it's needed, then reused.
export function builtinSfxFile(id: string): Promise<string> {
  let pending = files.get(id);
  if (!pending) {
    const recipe = recipeOf(id);
    if (!recipe) return Promise.reject(new Error(`Unknown built-in sound ${id}`));
    const name = `${recipe.name}-v${RECIPE_VERSION}`;
    pending = invoke<string | null>("store_builtin_sound", { name, wavBase64: null }).then(
      async (existing) => existing ?? (await invoke<string>("store_builtin_sound", { name, wavBase64: toBase64(await renderWav(recipe)) }))
    );
    pending.catch(() => files.delete(id));
    files.set(id, pending);
  }
  return pending;
}

// For tests: the WAV bytes of a recipe.
export const renderBuiltinSfxForTest = (name: string) => {
  const recipe = RECIPES.find((r) => r.name === name);
  return recipe ? renderWav(recipe) : Promise.reject(new Error(name));
};
