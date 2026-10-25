// Afro sounds for the Briefcast Originals: log drum hits and slides, talking drum, hand-drum fills,
// and seamless amapiano / afrobeats / Afrobeat groove loops cut from compose.mjs renders.
import { SR, Stereo, limit, peakOf, placeMono } from "./dsp.mjs";
import { logDrum } from "./afro-instruments.mjs";
import { kit } from "./drums.mjs";
import { renderSong } from "./compose.mjs";
import { buf, finish, withVerb } from "./sfx.mjs";

const hit = (b, s, t, gain = 1, pan = 0) => placeMono(b, s, t, gain / s.reduce((p, x) => Math.max(p, Math.abs(x)), 1e-9), pan);

// Renders the groove for 9 bars and keeps bars 4-8 (the progression's first chord again, with the
// ring of the bar before it), crossfading the very end into the audio just before the loop point.
function grooveLoop(song) {
  const { buffer } = renderSong({ ...song, sections: [["verse", 9, "A"]], mix: { ...(song.mix ?? {}), riser: false, introFilter: false } });
  const bar = (4 * 60) / song.bpm;
  const a = Math.round(4 * bar * SR);
  const n = Math.round(4 * bar * SR);
  const out = new Stereo(n);
  for (let i = 0; i < n; i++) {
    out.L[i] = buffer.L[a + i];
    out.R[i] = buffer.R[a + i];
  }
  const x = Math.round(0.03 * SR);
  for (let i = 0; i < x; i++) {
    const w = (i + 1) / x;
    out.L[n - x + i] = out.L[n - x + i] * (1 - w) + buffer.L[a - x + i] * w;
    out.R[n - x + i] = out.R[n - x + i] * (1 - w) + buffer.R[a - x + i] * w;
  }
  out.scale(0.9 / peakOf(out));
  return limit(out, 0.95);
}

const LOG = { decay: 0.42, drive: 2.4, droop: 0.7 };

export const AFRO_SFX = [
  {
    id: "sfx-log-drum", title: "Log Drum Hit", category: "afro", tags: ["amapiano", "log drum", "bass", "drop", "hit"],
    make() {
      const b = buf(1.4);
      logDrum(b, { t: 0.01, dur: 0.9, midi: 33, vel: 1 }, { ...LOG, decay: 0.5 });
      return finish(withVerb(b, { room: 0.5, wet: 0.08 }));
    },
  },
  {
    id: "sfx-log-drum-slide", title: "Log Drum Slide", category: "afro", tags: ["amapiano", "log drum", "transition", "groove", "bass"],
    make() {
      const b = buf(2.2);
      const s = 60 / 113 / 4;
      [[33, 0, 2, 0], [33, 3, 2, 0], [36, 6, 2, -3], [40, 9, 2, 0], [45, 12, 4, -5]].forEach(([midi, step, len, glideFrom]) => logDrum(b, { t: 0.01 + step * s, dur: len * s, midi, vel: 0.95, glideFrom }, LOG));
      return finish(withVerb(b, { room: 0.5, wet: 0.1 }));
    },
  },
  {
    id: "sfx-talking-drum", title: "Talking Drum", category: "afro", tags: ["afrobeats", "talking drum", "percussion", "nigeria", "call"],
    make() {
      const b = buf(2.4);
      const k = kit("afrobeats");
      const s = 60 / 104 / 4;
      [["talk", 0], ["talk", 2], ["talkDown", 3], ["talk", 6], ["talk", 7], ["talkDown", 8], ["talk", 11], ["talkDown", 12]].forEach(([p, step], i) => hit(b, k[p], 0.02 + step * s, 0.7 + 0.04 * i, -0.15));
      return finish(withVerb(b, { room: 0.55, wet: 0.15 }));
    },
  },
  {
    id: "sfx-afro-fill", title: "Afro Percussion Fill", category: "afro", tags: ["congas", "fill", "transition", "percussion", "build"],
    make() {
      const b = buf(2.6);
      const k = kit("afrobeats");
      const s = 60 / 108 / 4;
      ["conga", "conga", "congaLo", "bongo", "conga", "congaLo", "bongo", "bongo", "conga", "congaLo", "talk", "talk", "conga", "congaLo", "talkDown", "talk"].forEach((p, i) =>
        hit(b, k[p], 0.02 + i * s, 0.45 + 0.4 * (i / 15), { conga: 0.35, congaLo: 0.2, bongo: -0.35, talk: -0.2, talkDown: -0.2 }[p])
      );
      hit(b, k.crash, 0.02 + 16 * s, 0.6, 0.15);
      hit(b, k.kick, 0.02 + 16 * s, 0.9);
      return finish(withVerb(b, { room: 0.55, wet: 0.15 }));
    },
  },
  {
    id: "sfx-amapiano-loop", title: "Amapiano Loop", category: "afro", tags: ["loop", "amapiano", "log drum", "background", "groove"],
    make: () =>
      grooveLoop({
        id: "loop-amapiano", bpm: 113, key: 57, scale: "minor", chordSize: 5, swing: 0.12, progressions: { A: [1, 4, 7, 3] },
        layers: [
          { role: "chords", inst: "piano", opts: { bright: 0.75 }, style: "comp", in: ["verse"], pattern: "x..x..x...x..x..", gate: 0.6, range: [55, 72], reverb: 0.25, vel: 0.7 },
          { role: "bass", inst: "logDrum", opts: LOG, style: "bass", in: ["verse"], range: [33], vel: 0.95, pattern: "R-.R-.R-..O-R-..R-.R-.F-..A-R-.." },
        ],
        drums: { kit: "amapiano", sections: { verse: "amapianoFull" }, levels: { kick: -2 } },
        mix: { reverb: { room: 0.68 } },
      }),
  },
  {
    id: "sfx-afrobeats-loop", title: "Afrobeats Loop", category: "afro", tags: ["loop", "afrobeats", "guitar", "background", "groove"],
    make: () =>
      grooveLoop({
        id: "loop-afrobeats", bpm: 104, key: 56, scale: "major", chordSize: 4, swing: 0.08, progressions: { A: [4, 5, 3, 6] },
        layers: [
          { role: "arp", inst: "pluck", opts: { bright: 0.85, sustain: 0.7, pickPos: 0.13, mute: 0.05 }, style: "arp", arp: { rate: 2, order: [0, 2, 1, 2, 0, 2, 1, 3], gate: 0.5 }, in: ["verse"], range: [64, 77], pan: 0.3, level: 1 },
          { role: "bass", inst: "subtractive", opts: { wave: "saw", cutoff: 190, envAmt: 600, filterDecay: 0.18, sub: 0.9, drive: 1.3, release: 0.07, decay: 0.5, sustain: 0.55 }, style: "bass", in: ["verse"], pattern: "R..R..R.R..F..A.", range: [36] },
          { role: "pad", inst: "warmPad", style: "sustain", in: ["verse"], range: [56, 72], level: -4 },
        ],
        drums: { kit: "afrobeats", sections: { verse: "afrobeatsFull" } },
        mix: { reverb: { room: 0.6 } },
      }),
  },
  {
    id: "sfx-afrobeat-loop", title: "Afrobeat Horns Loop", category: "afro", tags: ["loop", "afrobeat", "funk", "organ", "vintage"],
    make: () =>
      grooveLoop({
        id: "loop-afrobeat", bpm: 116, key: 52, scale: "dorian", chordSize: 4, swing: 0.06, progressions: { A: [1, 1, 1, 4] },
        layers: [
          { role: "arp", inst: "pluck", opts: { bright: 0.9, sustain: 0.18, pickPos: 0.1, mute: 0.02 }, style: "arp", arp: { rate: 1, order: [0, 1, 0, 2, 0, 1, 0, 2], gate: 0.35 }, in: ["verse"], range: [64, 76], pan: 0.35 },
          { role: "chords", inst: "organ", opts: { drawbars: "888400000", perc: 0.2 }, style: "comp", in: ["verse"], pattern: "..x...x...x.x...", gate: 0.7, range: [55, 72], leslie: 0.9, level: -2 },
          { role: "bass", inst: "subtractive", opts: { wave: "saw", cutoff: 190, envAmt: 600, filterDecay: 0.18, sub: 0.9, drive: 1.3, release: 0.07, decay: 0.5, sustain: 0.55 }, style: "bass", in: ["verse"], pattern: "R..R.O.R..F.R.A.", range: [36] },
        ],
        drums: { kit: "afrobeat", sections: { verse: "afrobeat" } },
        mix: { reverb: { room: 0.58 } },
      }),
  },
];
