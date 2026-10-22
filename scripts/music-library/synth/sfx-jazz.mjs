// Jazz sounds for the Briefcast Originals: comedy stings (rimshot, sad trombone), big-band hits and
// endings, solo licks and instrument flourishes, a club's ambience and applause, and seamless
// groove loops played by the jazz engine's band. Each returns a finished Stereo buffer.
import { SR, eq, limit, peakOf, placeMono } from "./dsp.mjs";
import { piano } from "./instruments.mjs";
import { horn, jazzKit, organ, sweep, upright, vibes } from "./jazz-instruments.mjs";
import { applause, crowd, leslie, renderJazzLoop } from "./jazz.mjs";
import { kit } from "./drums.mjs";
import { buf, finish, withVerb } from "./sfx.mjs";

const K = () => jazzKit();
const hit = (b, sample, t, gain = 1, pan = 0) => placeMono(b, sample, t, gain / peakAbs(sample), pan);
const peakAbs = (a) => a.reduce((p, x) => Math.max(p, Math.abs(x)), 1e-9);

// A brass/sax chord: [kind, midi, pan] per voice.
function ensemble(b, voices, t, dur, note = {}) {
  voices.forEach(([kind, midi, pan], k) => horn(b, { t: t + k * 0.004, dur, midi, vel: note.vel ?? 0.9, pan, accent: note.accent ?? 1.3, ...note, fall: k === 0 ? note.fall : 0 }, { kind }));
}

// Loops skip finish()'s edge fade - a dip at the loop point would tick on every repeat.
function finishLoop(b) {
  b.scale(0.9 / peakOf(b));
  return limit(b, 0.95);
}

function fadeEdges(b, inSec, outSec) {
  const fi = Math.round(inSec * SR);
  const fo = Math.round(outSec * SR);
  for (let i = 0; i < fi && i < b.length; i++) {
    b.L[i] *= i / fi;
    b.R[i] *= i / fi;
  }
  for (let i = 0; i < fo && i < b.length; i++) {
    b.L[b.length - 1 - i] *= i / fo;
    b.R[b.length - 1 - i] *= i / fo;
  }
  return b;
}

const C9 = [["trumpet", 76, 0.3], ["trumpet", 74, 0.45], ["trumpet", 70, 0.15], ["trombone", 64, -0.15], ["trombone", 57, -0.3], ["alto", 67, -0.2], ["tenor", 62, 0.05], ["bari", 48, 0.1]];

const LOOP_BASS = { name: "bass", role: "bass", inst: "upright", range: [28, 52], eq: [["peak", 90, 1, 2.5], ["lowpass", 4500]] };
function loopSong(id, bpm, chart, band, extra = {}) {
  const groove = { part: "groove", chart: ["L"], with: band.map((p) => p.name), int: 0.4 };
  return { id, bpm, engine: "jazz", charts: { L: chart }, form: ["L"], plan: [groove, { ...groove, loopStart: true }, { ...groove, loopEnd: true }], band, ...extra };
}

export const JAZZ_SFX = [
  {
    id: "sfx-jazz-rimshot", title: "Jazz Rimshot", category: "jazz", tags: ["joke", "comedy", "punchline", "drum", "badum tss"],
    make() {
      const b = buf(2.4);
      hit(b, K().snare, 0.02, 0.75, -0.05);
      hit(b, K().toms[1], 0.2, 0.8, 0.05);
      hit(b, K().kick, 0.2, 0.7);
      hit(b, K().crash, 0.43, 0.75, -0.3);
      hit(b, K().kick, 0.43, 0.8);
      return finish(withVerb(b, { room: 0.55, wet: 0.18 }));
    },
  },
  {
    id: "sfx-muted-trombone", title: "Muted Trombone Wah-Wah", category: "jazz", tags: ["fail", "wah wah", "comedy", "lose", "oops"],
    make() {
      const b = buf(3.4);
      const open = (tt) => Math.min(1, tt / 0.16) * 0.9;
      [[58, 0.05, 0.4], [57, 0.5, 0.4], [56, 0.95, 0.4]].forEach(([midi, t, dur]) => horn(b, { t, dur, midi, vel: 0.85, wah: open, accent: 0.6 }, { kind: "trombone" }));
      horn(b, { t: 1.4, dur: 1.5, midi: 55, vel: 0.85, wah: (tt) => 0.55 + 0.45 * Math.sin(tt * 2 * Math.PI * 5.5), vib: 3, accent: 0.6 }, { kind: "trombone" });
      return finish(withVerb(b, { room: 0.5, wet: 0.15 }));
    },
  },
  {
    id: "sfx-jazz-sting", title: "Big Band Sting", category: "jazz", tags: ["brass", "hit", "reveal", "intro", "big band"],
    make() {
      const b = buf(2.6);
      ensemble(b, C9, 0.03, 0.42, { fall: 9 });
      hit(b, K().kick, 0.03, 0.9);
      hit(b, K().snare, 0.03, 0.55);
      hit(b, K().crash, 0.03, 0.8, -0.3);
      return finish(withVerb(b, { room: 0.75, wet: 0.25 }));
    },
  },
  {
    id: "sfx-brass-ta-da", title: "Brass Ta-Da", category: "jazz", tags: ["tada", "fanfare", "win", "celebrate", "showtime"],
    make() {
      const b = buf(3.6);
      const pick = C9.map(([k, m, p]) => [k, m - 1, p]);
      ensemble(b, pick, 0.04, 0.13, { accent: 1.4 });
      ensemble(b, C9.map(([k, m, p]) => [k, m + (k === "trumpet" && m === 76 ? 3 : 0), p]), 0.3, 2.2, { vib: 2.6, swell: true });
      hit(b, K().kick, 0.3, 0.9);
      hit(b, K().crash, 0.3, 0.8, -0.3);
      for (let k = 0; k < 28; k++) hit(b, K().ride[k % 3], 0.5 + k * 0.07, 0.06 + 0.25 * (k / 28) ** 1.5, 0.35);
      return finish(withVerb(b, { room: 0.78, wet: 0.25 }));
    },
  },
  {
    id: "sfx-basie-ending", title: "Basie Ending", category: "jazz", tags: ["ending", "outro", "plink", "big band", "the end"],
    make() {
      const b = buf(3);
      [84, 88, 91].forEach((m, k) => piano(b, { t: 0.05 + k * 0.32, dur: 0.18, midi: m, vel: 0.7, pan: 0.3 }));
      ensemble(b, C9, 1.2, 0.3, { accent: 1.5 });
      hit(b, K().kick, 1.2, 0.9);
      hit(b, K().snare, 1.2, 0.6);
      hit(b, K().crash, 1.2, 0.55, -0.3);
      upright(b, { t: 1.2, dur: 0.3, midi: 36, vel: 0.95 });
      return finish(withVerb(b, { room: 0.7, wet: 0.22 }));
    },
  },
  {
    id: "sfx-sax-lick", title: "Sultry Sax Lick", category: "jazz", tags: ["saxophone", "smooth", "romantic", "night", "lounge"],
    make() {
      const b = buf(4.2);
      const s = 0.27;
      [[60, 0, 1, true], [63, 1, 0.5], [65, 1.5, 0.5], [66, 2, 0.5], [67, 2.5, 1.5, true], [70, 4.5, 0.5], [67, 5, 0.5], [65, 5.5, 0.5], [63, 6, 0.5], [60, 6.5, 3.5]].forEach(([midi, beat, len, sc], i, a) =>
        horn(b, { t: 0.05 + beat * s, dur: len * s * 0.98, midi, vel: 0.75, scoop: sc ? 1.8 : 0.4, legato: i > 0 && a[i - 1][1] + a[i - 1][2] >= beat - 0.01 && !sc, fall: i === a.length - 1 ? 4 : 0, vib: 1.4 }, { kind: "tenor" })
      );
      return finish(withVerb(b, { room: 0.7, wet: 0.24 }));
    },
  },
  {
    id: "sfx-trumpet-fall", title: "Trumpet Fall-Off", category: "jazz", tags: ["fail", "fall", "comedy", "brass", "deflate"],
    make() {
      const b = buf(2.4);
      horn(b, { t: 0.04, dur: 0.9, midi: 77, vel: 0.9, fall: 12, accent: 1.4 }, { kind: "trumpet" });
      return finish(withVerb(b, { room: 0.6, wet: 0.2 }));
    },
  },
  {
    id: "sfx-piano-gliss", title: "Piano Glissando", category: "jazz", tags: ["piano", "transition", "magic", "sweep", "flourish"],
    make() {
      const b = buf(3.2);
      const white = [0, 2, 4, 5, 7, 9, 11];
      const keys = [];
      for (let m = 60; m <= 96; m++) if (white.includes(m % 12)) keys.push(m);
      keys.forEach((m, k) => piano(b, { t: 0.03 + k * 0.032 * (1 - k / keys.length / 3), dur: 0.5, midi: m, vel: 0.45 + 0.35 * (k / keys.length), pan: -0.3 + 0.6 * (k / keys.length) }));
      [72, 76, 79, 83, 86].forEach((m) => piano(b, { t: 0.95, dur: 1.8, midi: m, vel: 0.55, pan: 0.2 }));
      return finish(withVerb(b, { room: 0.75, wet: 0.25 }));
    },
  },
  {
    id: "sfx-bass-walk-up", title: "Upright Bass Walk-Up", category: "jazz", tags: ["bass", "transition", "walking", "intro", "cool"],
    make() {
      const b = buf(2.8);
      const beat = 0.3;
      [31, 33, 35, 36, 38, 39, 40].forEach((m, k) => upright(b, { t: 0.03 + k * beat, dur: beat * 0.92, midi: m, vel: 0.8 + 0.02 * k }));
      upright(b, { t: 0.03 + 7 * beat, dur: 0.6, midi: 41, vel: 0.95, glideFrom: -2 });
      eq(b, "peak", 90, 1, 2.5);
      return finish(withVerb(b, { room: 0.55, wet: 0.12 }));
    },
  },
  {
    id: "sfx-cymbal-swell", title: "Cymbal Swell", category: "jazz", tags: ["build", "suspense", "roll", "transition", "riser"],
    make() {
      const b = buf(5);
      for (let k = 0; k < 64; k++) {
        const u = k / 64;
        hit(b, K().ride[k % 3], 0.02 + u * 2.8, 0.03 + 0.5 * u ** 2.2, 0.2 * Math.sin(k));
      }
      hit(b, K().crash, 2.85, 0.9, -0.2);
      hit(b, K().kick, 2.85, 0.6);
      return finish(withVerb(b, { room: 0.8, wet: 0.25 }));
    },
  },
  {
    id: "sfx-brush-swish", title: "Brush Swish", category: "jazz", tags: ["brush", "drum", "soft", "transition", "texture"],
    make() {
      const b = buf(2.6);
      sweep(b, { t: 0.02, dur: 0.9, vel: 0.8, pan: -0.1 });
      sweep(b, { t: 0.8, dur: 0.9, vel: 0.9, pan: 0.05 });
      hit(b, K().brushTap, 1.55, 0.7);
      hit(b, K().kick, 1.55, 0.25);
      return finish(withVerb(b, { room: 0.55, wet: 0.15 }));
    },
  },
  {
    id: "sfx-vibes-shimmer", title: "Vibraphone Shimmer", category: "jazz", tags: ["vibraphone", "dream", "magic", "idea", "soft"],
    make() {
      const b = buf(5);
      [65, 69, 72, 76, 79, 84].forEach((m, k) => vibes(b, { t: 0.03 + k * 0.11, dur: 4, midi: m, vel: 0.7, pan: -0.3 + k * 0.12 }));
      return finish(withVerb(b, { room: 0.8, wet: 0.25 }));
    },
  },
  {
    id: "sfx-jazz-fill", title: "Jazz Drum Fill", category: "jazz", tags: ["drum", "fill", "transition", "swing", "build"],
    make() {
      const b = buf(3);
      const trip = 60 / 160 / 3;
      const seq = ["snare", "snare", "snare", "t0", "t0", "snare", "t1", "t1", "snare", "t2", "t2", "kick"];
      seq.forEach((p, k) => {
        const t = 0.03 + k * trip;
        const v = 0.45 + 0.5 * (k / seq.length);
        if (p === "snare") hit(b, K().snare, t, v, -0.05);
        else if (p === "kick") hit(b, K().kick, t, v);
        else hit(b, K().toms[+p[1]], t, v, [-0.25, 0.05, 0.3][+p[1]]);
      });
      const end = 0.03 + seq.length * trip;
      hit(b, K().crash, end, 0.9, -0.3);
      hit(b, K().kick, end, 0.85);
      return finish(withVerb(b, { room: 0.62, wet: 0.18 }));
    },
  },
  {
    id: "sfx-finger-snaps", title: "Finger Snaps", category: "jazz", tags: ["snap", "cool", "beatnik", "rhythm", "intro"],
    make() {
      const b = buf(4.4);
      const snap = kit("acoustic").snap;
      for (let k = 0; k < 8; k++) hit(b, snap, 0.25 + k * 0.5, 0.7 + 0.1 * Math.sin(k * 3), k % 2 ? 0.25 : -0.2);
      return finish(withVerb(b, { room: 0.6, wet: 0.2 }));
    },
  },
  {
    id: "sfx-organ-swell", title: "Organ Swell", category: "jazz", tags: ["hammond", "organ", "gospel", "soul", "build"],
    make() {
      const b = buf(4.5);
      [46, 50, 53, 56, 60, 62].forEach((m) => organ(b, { t: 0.02, dur: 3.6, midi: m, vel: 0.8 }, { drawbars: "888600000", perc: 0 }));
      b.shape((i) => Math.min(1, (i / SR / 2.2) ** 1.5));
      leslie(b, { rate: (t) => (t < 1.4 ? 0.8 : 6.8) });
      return finish(withVerb(b, { room: 0.65, wet: 0.2 }));
    },
  },
  {
    id: "sfx-jazz-club", title: "Jazz Club Ambience", category: "ambience", tags: ["crowd", "bar", "restaurant", "murmur", "background", "glasses"],
    make() {
      const b = crowd(20, { seed: 77, talkers: 18, clinks: 1.4 });
      eq(b, "lowpass", 4200);
      return finish(fadeEdges(withVerb(b, { room: 0.7, wet: 0.35 }), 1.2, 1.5), 0.6);
    },
  },
  {
    id: "sfx-club-applause", title: "Jazz Club Applause", category: "jazz", tags: ["applause", "clap", "audience", "live", "cheer"],
    make() {
      const b = applause(7, { seed: 31, people: 34, swell: 0.3, fade: 2.2, whistles: 2 });
      return finish(withVerb(b, { room: 0.7, wet: 0.3 }));
    },
  },
  {
    id: "sfx-swing-loop", title: "Swing Loop", category: "jazz", tags: ["loop", "swing", "background", "piano trio", "walking bass"],
    make: () =>
      finishLoop(
        renderJazzLoop(loopSong("loop-swing", 132, "Dm9 | G13 | Cmaj9 | A7b9 | Dm9 | G13 | Em7 A7b9 | Dm7 G7 |", [
          { name: "piano", role: "comp", inst: "piano", opts: { bright: 0.85 }, range: [50, 70], pan: -0.18, panByPitch: true },
          LOOP_BASS,
          { name: "drums", role: "drums", style: "swing", kit: "jazz" },
        ]))
      ),
  },
  {
    id: "sfx-bossa-loop", title: "Bossa Nova Loop", category: "jazz", tags: ["loop", "bossa", "background", "guitar", "cafe"],
    make: () =>
      finishLoop(
        renderJazzLoop(loopSong("loop-bossa", 136, "Cmaj9 | % | D9 | % | Dm9 | G13 | Cmaj9 | G7sus |", [
          { name: "guitar", role: "comp", inst: "pluck", opts: { bright: 0.42, sustain: 1.8, pickPos: 0.16, mute: 0.08 }, comp: "bossa", range: [55, 69], pan: -0.25, eq: [["lowpass", 5200], ["peak", 220, 1, 2]] },
          { ...LOOP_BASS, feel: "bossa" },
          { name: "drums", role: "drums", style: "bossa", kit: "jazz", shaker: true, target: -22 },
        ], { swing: 0.52 }))
      ),
  },
  {
    id: "sfx-lounge-loop", title: "Late Night Lounge Loop", category: "jazz", tags: ["loop", "lounge", "rhodes", "brushes", "background"],
    make: () =>
      finishLoop(
        renderJazzLoop(loopSong("loop-lounge", 76, "Ebmaj9 | Cm9 | Fm9 | Bb13 |", [
          { name: "rhodes", role: "comp", inst: "epiano", opts: { tremolo: 0.18 }, comp: "ballad", range: [53, 70], fillRange: [70, 84], pan: -0.15 },
          { ...LOOP_BASS, feel: "two" },
          { name: "drums", role: "drums", style: "brushes", kit: "jazz", target: -24 },
        ], { style: "ballad", mix: { reverb: { room: 0.75 } } }))
      ),
  },
];

