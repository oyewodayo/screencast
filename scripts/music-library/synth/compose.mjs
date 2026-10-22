// Turns a song description (songs.mjs) into a mixed stereo master: harmony with voice-leading,
// bass lines and comping from per-bar patterns, hook melodies built from a repeated motif
// (A A B A), drum grooves with swing, fills, risers and crashes, then a per-layer mix
// (EQ, level-matching, sidechain, reverb/delay sends) and a master chain.
import { SR, Stereo, chorus, clamp, compress, dbToGain, eq, hashSeed, limit, normalizeTo, activeRmsDb, pingPong, placeMono, reverb, rng, saturate, sweep, wow } from "./dsp.mjs";
import * as I from "./instruments.mjs";
import * as J from "./jazz-instruments.mjs";
import * as A from "./afro-instruments.mjs";
import { kit, noiseRiser, vinyl } from "./drums.mjs";
import { leslie } from "./jazz.mjs";

const INSTR = { ...I, ...J, ...A };

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

const degMidi = (key, sc, d) => key + 12 * Math.floor(d / sc.length) + sc[((d % sc.length) + sc.length) % sc.length];

// Levels each layer is matched to (dB, active RMS) before the master - a starting balance any song
// can nudge with `level`.
const TARGETS = {
  kick: -13.5, snare: -17.5, clap: -18.5, snap: -22, rim: -24, hat: -27, openHat: -28.5, shaker: -28, tom: -20, taiko: -16.5, crash: -27,
  conga: -24, congaLo: -24, bongo: -26.5, talk: -23, talkDown: -23, bell: -27, wood: -28,
  chords: -20, pad: -23.5, strings: -21.5, bass: -16, lead: -18.5, arp: -23, counter: -23.5, bells: -24.5, riser: -27, vinyl: -39,
};
const HIGHPASS = { chords: 140, pad: 180, strings: 200, lead: 220, arp: 260, counter: 220, bells: 320 };
const DRUM_PAN = { hat: 0.22, openHat: 0.25, shaker: -0.3, rim: -0.15, snap: 0.1, crash: 0.12, tom: -0.1, conga: 0.35, congaLo: 0.2, bongo: -0.38, talk: -0.25, talkDown: -0.25, bell: 0.3, wood: -0.32 };
const DRUM_SEND = { conga: 0.12, congaLo: 0.12, bongo: 0.12, talk: 0.2, talkDown: 0.2, bell: 0.15, wood: 0.15, snare: 0.2, clap: 0.22, snap: 0.25, rim: 0.2, tom: 0.35, taiko: 0.4, crash: 0.2, hat: 0.04, openHat: 0.08, shaker: 0.06, kick: 0.03 };

export const GROOVES = {
  pop: { kick: "X.....x.X.x.....", snare: "....X.......X...", hat: "x.x.x.x.x.x.x.x." },
  popFull: { kick: "X.....x.X.x.....", snare: "....X.......X...", clap: "....X.......X...", hat: "xoxoxoxoxoxoxoxo", openHat: "..............x." },
  popHalf: { kick: "X.........x.....", snare: "........X.......", hat: "x...x...x...x..." },
  house: { kick: "X...X...X...X...", hat: "..x...x...x...x.", shaker: "oxoooxoooxoooxoo" },
  houseFull: { kick: "X...X...X...X...", clap: "....X.......X...", hat: "xoxoxoxoxoxoxoxo", openHat: "..x...x...x...x." },
  lofi: { kick: "X......x..X.....", snare: "....X.......X...", hat: "x.x.x.x.x.x.x.xo" },
  lofiLight: { kick: "X.........X.....", hat: "x.x.x.x.x.x.x.x.", rim: "....x.......x..." },
  hiphop: { kick: "X......x..x.....X.x....x..X.....", snare: "....X.......X...", hat: "x.x.x.x.x.xxx.x." },
  hiphopLight: { kick: "X.........x.....", hat: "x.x.x.x.x.x.x.x.", rim: "....x.......x..." },
  synthwave: { kick: "X...X...X...X...", snare: "....X.......X...", hat: "x.x.x.x.x.x.x.x." },
  synthwaveHalf: { kick: "X.......X.......", hat: "x.x.x.x.x.x.x.x." },
  acoustic: { kick: "X.....x.X.......", clap: "....X.......X...", shaker: "oxoxoxoxoxoxoxox" },
  acousticLight: { shaker: "oxoxoxoxoxoxoxox", snap: "....x.......x..." },
  cinematic: { taiko: "X.....x.X...x.x.", tom: "....x.......x.x.", kick: "X.......X......." },
  cinematicLight: { taiko: "X.......X......." },
  soft: { kick: "X.......X.......", rim: "....x.......x...", shaker: "oxoxoxoxoxoxoxox" },
  softLight: { shaker: "oxoxoxoxoxoxoxox", kick: "X..............." },
  pulse: { kick: "X.......X.......", rim: "xoooxoooxoooxooo" },
  pulseFull: { kick: "X.......X.x.....", rim: "xoxoxoxoxoxoxoxo", snare: "....X.......X..." },
  chill: { kick: "X.......X.x.....", snare: "........X.......", hat: "x.x.x.x.x.x.x.x." },
  chillFull: { kick: "X.....x.X.x.....", snare: "....X.......X...", hat: "xoxoxoxoxoxoxoxo" },
  // Amapiano: four on the floor, the 16th shaker carrying the swing, syncopated rims and hand drums;
  // the "drop" takes the kick out and leaves the log drum on its own.
  amapiano: { kick: "X...X...X...X...", clap: "....x.......x...", shaker: "xoxxxoxxxoxxxoxx", hat: "..o...o...o...o.", conga: "...x..x....x.x..", wood: "..........o....." },
  amapianoFull: { kick: "X...X...X...X...", clap: "....x.......x...", rim: "..x....x..x...x.", shaker: "xoxxxoxxxoxxxoxx", openHat: "..x...x...x...x.", conga: "...x..x....x.x..", congaLo: "x.......x.....x.", bongo: ".......x.......x" },
  amapianoLight: { shaker: "xoxxxoxxxoxxxoxx", hat: "..o...o...o...o.", rim: "....x.......x..." },
  amapianoDrop: { shaker: "xoxxxoxxxoxxxoxx", clap: "....x.......x...", conga: "...x..x....x.x..", rim: "..x....x..x...x." },
  // Afrobeats: the 3-3-2 kick, rim on the off-beats, shaker 16ths, congas talking back.
  afrobeats: { kick: "X..X..X.X..X..X.", rim: "...x..x....x..x.", hat: "x.x.x.x.x.x.x.x.", shaker: "xoxoxoxoxoxoxoxo", conga: "..x.x..x..x.x..x" },
  afrobeatsFull: { kick: "X..X..X.X..X..X.", clap: "....X.......X...", rim: "...x..x....x..x.", hat: "x.x.x.x.x.x.x.x.", openHat: "...............x", shaker: "xoxoxoxoxoxoxoxo", conga: "..x.x..x..x.x..x", congaLo: "x.....x.......x.", talk: "................................x...........x..x" },
  afrobeatsLight: { shaker: "xoxoxoxoxoxoxoxo", rim: "...x..x....x..x.", conga: "..x.x..x..x.x..x" },
  // 70s Afrobeat: busy 16th hats with open accents, the bell pattern, shekere, a talking kick.
  afrobeat: { kick: "X......X..X.....", snare: "....x.......x..o", hat: "xoxxxoxxxoxxxoxx", openHat: "..x.......x.....", bell: "x.x.x..x.x.x..x.", shaker: "xoxoxoxoxoxoxoxo", conga: "..x..x.x..x..x.x", congaLo: "x.......x......." },
  afrobeatLight: { hat: "xoxxxoxxxoxxxoxx", bell: "x.x.x..x.x.x..x.", shaker: "xoxoxoxoxoxoxoxo", kick: "X.........X....." },
};

const VEL = { X: 1, x: 0.72, o: 0.42 };

// Voicing closest to the previous chord (or centred in range) - smooth voice-leading.
function voiceChord(midis, prev, lo, hi) {
  const pcs = midis.map((m) => ((m % 12) + 12) % 12);
  let best = null;
  let bestScore = Infinity;
  const center = (lo + hi) / 2;
  for (let rot = 0; rot < pcs.length; rot++) {
    const order = pcs.slice(rot).concat(pcs.slice(0, rot));
    for (let base = lo; base < lo + 12; base++) {
      if (base % 12 !== order[0]) continue;
      const v = [base];
      for (let k = 1; k < order.length; k++) {
        let m = v[k - 1] + 1;
        while (m % 12 !== order[k]) m++;
        v.push(m);
      }
      if (v[v.length - 1] > hi) continue;
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      const score = prev ? v.reduce((a, m, i) => a + Math.abs(m - prev[Math.min(i, prev.length - 1)]), 0) + Math.abs(mean - center) * 0.5 : Math.abs(mean - center);
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
  }
  return best ?? midis;
}

function timeline(song) {
  const beat = 60 / song.bpm;
  const bar = beat * 4;
  const sections = [];
  let b = 0;
  for (const [type, bars, prog] of song.sections) {
    sections.push({ type, bars, prog, startBar: b, t: b * bar });
    b += bars;
  }
  sections.push({ type: "end", bars: 1, prog: "end", startBar: b, t: b * bar });
  b += 1;
  for (const s of sections) {
    const prog = s.type === "end" ? [[1]] : song.progressions[s.prog].map((x) => (Array.isArray(x) ? x : [x]));
    s.chords = Array.from({ length: s.bars }, (_, k) => {
      const entry = prog[k % prog.length];
      return entry.map((deg, j) => ({ deg, startBeat: (j * 4) / entry.length }));
    });
  }
  return { beat, bar, s16: beat / 4, sections, totalBars: b };
}

function chordAt(section, bar, step) {
  const cs = section.chords[bar % section.chords.length];
  let c = cs[0];
  for (const x of cs) if (x.startBeat <= step / 4) c = x;
  return c;
}

function chordMidis(song, deg, size) {
  const sc = SCALES[song.scale];
  const r = deg - 1;
  // Five-note (9th) chords drop the root - the bass has it - for a lighter, jazzier voicing.
  const ks = size >= 5 ? [2, 4, 6, 8] : [0, 2, 4, 6].slice(0, size);
  return ks.map((k) => degMidi(song.key, sc, r + k));
}

// Seconds offset for swing on off-beat 16ths.
const swingAt = (ctx, step) => (step % 2 === 1 ? ctx.song.swing * ctx.s16 : 0);

function patternFor(layer, type) {
  return (layer.patterns && layer.patterns[type]) || layer.pattern;
}

// ---- Note generators -------------------------------------------------------------------------

function compNotes(ctx, layer, section, r) {
  const { song, s16 } = ctx;
  const notes = [];
  const pat = patternFor(layer, section.type);
  const [lo, hi] = layer.range ?? [55, 72];
  const size = layer.chordSize ?? song.chordSize ?? 3;
  for (let bar = 0; bar < section.bars; bar++) {
    for (let step = 0; step < 16; step++) {
      const g = bar * 16 + step;
      const ch = pat[g % pat.length];
      if (ch !== "x" && ch !== "o") continue;
      let hold = 1;
      while (hold < 32 && pat[(g + hold) % pat.length] === "-" && bar * 16 + step + hold < section.bars * 16) hold++;
      const c = chordAt(section, bar, step);
      const voiced = voiceChord(chordMidis(song, c.deg, size), layer._prev, lo, hi);
      layer._prev = voiced;
      const vel = (ch === "x" ? 1 : 0.7) * (layer.vel ?? 0.8);
      const t0 = section.t + g * s16 + swingAt(ctx, step);
      const strum = layer.style === "strum";
      const down = strum && step % 4 === 0;
      voiced.forEach((m, k) => {
        const order = down || !strum ? k : voiced.length - 1 - k;
        notes.push({ t: t0 + (strum ? order * 0.016 : r.range(0, 0.008)), dur: hold * s16 * (layer.gate ?? 0.95), midi: m, vel: vel * r.range(0.9, 1.05) * (strum && !down ? 0.8 : 1), pan: layer.pan ?? 0 });
      });
    }
  }
  return notes;
}

function sustainNotes(ctx, layer, section) {
  const { song, bar } = ctx;
  const notes = [];
  const [lo, hi] = layer.range ?? [52, 72];
  const size = layer.chordSize ?? song.chordSize ?? 3;
  section.chords.forEach((cs, b) =>
    cs.forEach((c, j) => {
      const beats = (j + 1 < cs.length ? cs[j + 1].startBeat : 4) - c.startBeat;
      const voiced = voiceChord(chordMidis(song, c.deg, size), layer._prev, lo, hi);
      layer._prev = voiced;
      const t = section.t + (b + c.startBeat / 4) * bar;
      voiced.forEach((m) => notes.push({ t, dur: (beats / 4) * bar * 1.02, midi: m, vel: layer.vel ?? 0.7, pan: layer.pan ?? 0 }));
    })
  );
  return notes;
}

function bassNotes(ctx, layer, section) {
  const { song, s16 } = ctx;
  const notes = [];
  const pat = patternFor(layer, section.type);
  const lo = layer.range?.[0] ?? 33;
  const sc = SCALES[song.scale];
  const place = (m) => {
    while (m < lo) m += 12;
    while (m >= lo + 12) m -= 12;
    return m;
  };
  for (let bar = 0; bar < section.bars; bar++) {
    for (let step = 0; step < 16; step++) {
      const g = bar * 16 + step;
      const ch = pat[g % pat.length];
      if (!"ROFTA".includes(ch)) continue;
      let hold = 1;
      while (hold < 32 && pat[(g + hold) % pat.length] === "-" && g + hold < section.bars * 16) hold++;
      const c = chordAt(section, bar, step);
      const root = place(degMidi(song.key, sc, c.deg - 1));
      let m = root;
      if (ch === "O") m = root + 12;
      else if (ch === "F") m = place(degMidi(song.key, sc, c.deg + 3));
      else if (ch === "T") m = place(degMidi(song.key, sc, c.deg + 1));
      else if (ch === "A") {
        const nextBar = step + hold >= 16 ? bar + 1 : bar;
        const next = nextBar < section.bars ? chordAt(section, nextBar, (step + hold) % 16) : c;
        const target = place(degMidi(song.key, sc, next.deg - 1));
        m = target + (target > root ? -1 : 1);
      }
      const vel = (layer.vel ?? 0.85) * (step % 4 === 0 ? 1 : 0.85);
      notes.push({ t: section.t + g * s16 + swingAt(ctx, step), dur: hold * s16 * (layer.gate ?? 0.9), midi: m, vel, pan: 0 });
    }
  }
  return notes;
}

function arpNotes(ctx, layer, section) {
  const { song, s16 } = ctx;
  const { rate = 2, order = [0, 1, 2, 1], octaves = 1, gate = 0.8 } = layer.arp;
  const [lo, hi] = layer.range ?? [60, 76];
  const size = layer.chordSize ?? Math.min(song.chordSize ?? 3, 4);
  const notes = [];
  let n = 0;
  for (let bar = 0; bar < section.bars; bar++) {
    for (let step = 0; step < 16; step += rate) {
      const c = chordAt(section, bar, step);
      const voiced = voiceChord(chordMidis(song, c.deg, size), layer._prev, lo, hi);
      layer._prev = voiced;
      const tones = [];
      for (let o = 0; o < octaves; o++) voiced.forEach((m) => tones.push(m + 12 * o));
      const midi = tones[order[n % order.length] % tones.length];
      n++;
      notes.push({ t: section.t + (bar * 16 + step) * s16 + swingAt(ctx, step), dur: rate * s16 * gate, midi, vel: (layer.vel ?? 0.7) * (step % 4 === 0 ? 1 : 0.78), pan: layer.pan ?? 0 });
    }
  }
  return notes;
}

// A 2-bar rhythm: onsets weighted towards strong beats, with a breath at the end.
function makeRhythm(r, steps, density) {
  const on = [];
  for (let s = 0; s < steps; s++) {
    const pos = s % 16;
    let p = pos === 0 ? 0.95 : pos % 4 === 0 ? 0.6 : pos % 2 === 0 ? 0.38 : 0.1;
    p = Math.min(0.97, p * density * 1.7);
    if (s >= steps - 3) p *= 0.25;
    if (s === 0 || r() < p) on.push(s);
  }
  if (on.length < 3) on.push(...[6, 12, 20].filter((s) => !on.includes(s)));
  on.sort((a, b) => a - b);
  return on.map((s, i) => ({ step: s, len: Math.min((on[i + 1] ?? steps) - s, 8) }));
}

// Hook melody: motif A (2 bars), repeated and re-fitted to the chords, a contrasting B, back to A,
// resolving to the tonic. The same section type + progression always gets the same melody, so a
// chorus comes back recognisably.
function composeMelody(ctx, layer, section, r) {
  const { song, s16 } = ctx;
  const sc = SCALES[song.scale];
  const n = sc.length;
  const [lo, hi] = layer.range ?? [67, 84];
  const degOf = (midi) => {
    let best = 0;
    let bd = Infinity;
    for (let d = -40; d < 50; d++) {
      const dist = Math.abs(degMidi(song.key, sc, d) - midi);
      if (dist < bd) [best, bd] = [d, dist];
    }
    return best;
  };
  const dLo = degOf(lo);
  const dHi = degOf(hi);
  const dMid = Math.round((dLo + dHi) / 2);
  const rootAt = (bar, step) => chordAt(section, bar, step).deg - 1;
  const isCT = (d, root) => [0, 2, 4].includes((((d - root) % n) + n) % n);
  const nearestCT = (d, root) => {
    for (let k = 0; k <= 3; k++) {
      if (isCT(d + k, root) && d + k <= dHi) return d + k;
      if (isCT(d - k, root) && d - k >= dLo) return d - k;
    }
    return d;
  };
  const density = layer.density ?? 0.45;
  const rA = makeRhythm(r, 32, density);
  const rB = makeRhythm(r, 32, Math.min(0.95, density * 1.2));
  const segs = Math.ceil(section.bars / 2);
  const forms = segs <= 2 ? ["A", "B"] : ["A", "A", "B", "A"];
  const out = [];
  let prev = dMid;
  let dir = 1;
  let shapeA = null;
  for (let sg = 0; sg < segs; sg++) {
    const form = forms[sg % forms.length];
    const rh = form === "B" ? rB : rA;
    const barBase = sg * 2;
    const root = (k) => rootAt(barBase + Math.floor(rh[k].step / 16), rh[k].step % 16);
    const degs = [];
    if (form === "A" && shapeA) {
      let d = nearestCT(shapeA.start, root(0));
      for (let k = 0; k < rh.length; k++) {
        if (k > 0) d += shapeA.intervals[k] ?? 0;
        if (rh[k].step % 4 === 0 && !isCT(d, root(k))) d = nearestCT(d, root(k));
        d = clamp(d, dLo, dHi);
        degs.push(d);
      }
    } else {
      let d = form === "A" ? nearestCT(dMid + r.pick([-2, 0, 1]), root(0)) : nearestCT(prev + r.pick([1, 2, 3]), root(0));
      for (let k = 0; k < rh.length; k++) {
        if (k > 0) {
          if (rh[k].step % 4 === 0) d = nearestCT(d + dir * r.pick([0, 1, 2, 2, 3]), root(k));
          else d += dir * (r.chance(0.75) ? 1 : 2);
          if (d >= dHi - 1 || d <= dLo + 1 || r.chance(0.28)) dir = -dir;
          d = clamp(d, dLo, dHi);
        }
        degs.push(d);
      }
      if (form === "A") shapeA = { start: degs[0], intervals: degs.map((x, i) => (i ? x - degs[i - 1] : 0)) };
    }
    const last = sg === segs - 1;
    rh.forEach((h, k) => {
      const bar = barBase + Math.floor(h.step / 16);
      if (bar >= section.bars) return;
      let d = degs[k];
      let len = h.len;
      if (last && k === rh.length - 1) {
        // Resolve to the tonic, held to the end of the phrase.
        const up = Math.ceil(d / n) * n;
        const down = Math.floor(d / n) * n;
        d = clamp(Math.abs(up - d) < Math.abs(d - down) ? up : down, dLo, dHi);
        len = Math.max(len, section.bars * 16 - (barBase * 16 + h.step) - 2);
      }
      const strong = h.step % 4 === 0;
      out.push({ t: (barBase * 16 + h.step) * s16 + swingAt(ctx, h.step % 16), dur: len * s16 * (layer.gate ?? 0.9), midi: degMidi(song.key, sc, d), vel: (layer.vel ?? 0.8) * (strong ? 1 : 0.8) * r.range(0.92, 1.05), pan: layer.pan ?? 0 });
    });
    prev = degs[degs.length - 1];
  }
  return out;
}

// `unison`: play another layer's melody (horn sections in unison or octaves, `transpose`).
function melodyNotes(ctx, layer, section, r) {
  const src = layer.unison != null ? ctx.song.layers[layer.unison] : layer;
  src._melodies ??= new Map();
  const key = `${section.type}:${section.prog}:${section.bars}`;
  if (!src._melodies.has(key)) src._melodies.set(key, composeMelody(ctx, src, section, r));
  return src._melodies.get(key).map((nt) => ({ ...nt, t: section.t + nt.t, midi: nt.midi + (layer.transpose ?? 0), pan: layer.pan ?? nt.pan }));
}

// ---- Rendering -------------------------------------------------------------------------------

function renderLayer(ctx, layer, bus, r) {
  const play = INSTR[layer.inst];
  if (!play) throw new Error(`Unknown instrument ${layer.inst}`);
  for (const section of ctx.tl.sections) {
    let notes = [];
    if (section.type === "end") {
      if (layer.end === false || !["chords", "pad", "strings", "bass"].includes(layer.role)) continue;
      // The final chord rings out instead of being cut.
      const hold = { ...layer, _prev: layer._prev };
      notes = layer.role === "bass" ? bassNotes(ctx, { ...layer, pattern: "R---------------", gate: 1 }, section) : sustainNotes(ctx, hold, section);
      notes.forEach((nt) => (nt.dur = ctx.bar * 1.5));
    } else if ((layer.in ?? []).includes(section.type)) {
      const style = layer.style;
      if (style === "comp" || style === "strum") notes = compNotes(ctx, layer, section, r);
      else if (style === "sustain") notes = sustainNotes(ctx, layer, section);
      else if (style === "bass") notes = bassNotes(ctx, layer, section);
      else if (style === "arp") notes = arpNotes(ctx, layer, section);
      else if (style === "melody") notes = melodyNotes(ctx, layer, section, r);
      else throw new Error(`Unknown style ${style}`);
    }
    for (const nt of notes) play(bus, { ...nt, t: Math.max(0, nt.t) }, layer.opts ?? {});
  }
}

function renderDrums(ctx, r) {
  const { song, tl, s16 } = ctx;
  const d = song.drums;
  const buses = {};
  const kickTimes = [];
  if (!d) return { buses, kickTimes };
  const k = kit(d.kit);
  const bus = (name) => (buses[name] ??= new Stereo(ctx.length));
  const hit = (name, t, vel) => {
    if (!k[name]) return;
    placeMono(bus(name), k[name], t, vel, DRUM_PAN[name] ?? 0);
    if (name === "kick" || name === "taiko") kickTimes.push(t);
  };
  tl.sections.forEach((section, si) => {
    const next = tl.sections[si + 1];
    const intoChorus = next && next.type === "chorus";
    if (section.type === "end") {
      hit(k.kick ? "kick" : "taiko", section.t, 1);
      hit("crash", section.t, 0.9);
      return;
    }
    const grooveName = d.sections?.[section.type];
    const groove = grooveName ? GROOVES[grooveName] : null;
    if (section.type === "chorus" && groove) hit("crash", section.t, 0.85);
    if (!groove) return;
    for (let bar = 0; bar < section.bars; bar++) {
      const lastBar = bar === section.bars - 1;
      const roll = lastBar && section.type === "build";
      for (const [inst, pat] of Object.entries(groove)) {
        if (roll && (inst === "snare" || inst === "clap" || inst === "tom")) continue;
        for (let step = 0; step < 16; step++) {
          const ch = pat[(bar * 16 + step) % pat.length];
          const v = VEL[ch];
          if (!v) continue;
          // Leave room for the fill in the last beat into a chorus.
          if (lastBar && intoChorus && !roll && step >= 12 && inst !== "kick" && inst !== "hat") continue;
          const jitter = step === 0 ? 0 : r.range(-0.004, 0.004);
          hit(inst, section.t + (bar * 16 + step) * s16 + swingAt(ctx, step) + jitter, v * r.range(0.9, 1.06));
        }
      }
      if (roll) {
        const inst = k.snare ? "snare" : "taiko";
        for (let step = 0; step < 16; step++) hit(inst, section.t + (bar * 16 + step) * s16, 0.25 + 0.75 * (step / 15) ** 1.5);
      } else if (lastBar && intoChorus) {
        const inst = k.talk ? "talk" : k.tom ? "tom" : "snare";
        [12, 13, 14, 15].forEach((step, j) => hit(inst, section.t + (bar * 16 + step) * s16, 0.6 + j * 0.12));
      }
    }
  });
  return { buses, kickTimes: kickTimes.sort((a, b) => a - b) };
}

// Pumping gain curve from kick times (house/synthwave "sidechain" feel).
function sidechain(buf, kickTimes, depth, release = 0.16) {
  let ki = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    while (ki + 1 < kickTimes.length && kickTimes[ki + 1] <= t) ki++;
    const since = kickTimes.length && t >= kickTimes[ki] ? t - kickTimes[ki] : 99;
    const env = since < 0.006 ? since / 0.006 : Math.exp(-(since - 0.006) / release);
    const g = 1 - depth * (since < 99 ? env : 0);
    buf.L[i] *= g;
    buf.R[i] *= g;
  }
}

export function renderSong(song) {
  const tl = timeline(song);
  const tail = 3.5;
  const length = Math.ceil((tl.totalBars * tl.bar + tail) * SR);
  const ctx = { song, tl, bar: tl.bar, s16: tl.s16, length };
  const r = rng(hashSeed(song.id));

  const drums = renderDrums(ctx, r);
  const music = new Stereo(length);
  const drumBus = new Stereo(length);
  const revSend = new Stereo(length);
  const dlySend = new Stereo(length);
  const mix = song.mix ?? {};

  for (const layer of song.layers) {
    const bus = new Stereo(length);
    renderLayer(ctx, layer, bus, r);
    if (layer.role !== "bass") eq(bus, "highpass", layer.hp ?? HIGHPASS[layer.role] ?? 120);
    else eq(bus, "highpass", 32);
    if (layer.lp) eq(bus, "lowpass", layer.lp);
    for (const [type, f, q, g] of layer.eq ?? []) eq(bus, type, f, q, g);
    if (layer.chorus) chorus(bus, layer.chorus === true ? {} : layer.chorus);
    if (layer.leslie) leslie(bus, { rate: () => layer.leslie });
    normalizeTo(bus, (TARGETS[layer.role] ?? -22) + (layer.level ?? 0));
    if (layer.duck && drums.kickTimes.length) sidechain(bus, drums.kickTimes, mix.sidechain ?? 0.45);
    music.mixIn(bus);
    if (layer.reverb) revSend.mixIn(bus, layer.reverb);
    if (layer.delay) dlySend.mixIn(bus, layer.delay);
  }

  for (const [name, bus] of Object.entries(drums.buses)) {
    if (name === "hat" || name === "openHat") eq(bus, "highpass", 5000);
    normalizeTo(bus, (TARGETS[name] ?? -24) + (song.drums.levels?.[name] ?? 0));
    drumBus.mixIn(bus);
    revSend.mixIn(bus, (DRUM_SEND[name] ?? 0.05) * (mix.drumReverb ?? 1));
  }

  // Risers into each chorus that follows a build.
  if (mix.riser !== false) {
    const riser = new Stereo(length);
    tl.sections.forEach((s, i) => {
      const next = tl.sections[i + 1];
      if (s.type !== "build" || !next) return;
      const secs = Math.min(s.bars, 4) * tl.bar;
      placeMono(riser, noiseRiser(secs, hashSeed(song.id) + i), next.t - secs, 1, 0);
    });
    if (activeRmsDb(riser) > -200) {
      normalizeTo(riser, TARGETS.riser);
      music.mixIn(riser);
      revSend.mixIn(riser, 0.3);
    }
  }

  // Intro opens up from a muffled low-pass.
  const intro = tl.sections[0];
  if (mix.introFilter && intro.type === "intro") {
    const end = intro.t + intro.bars * tl.bar;
    sweep(music, "lowpass", (t) => (t >= end ? 20000 : 500 * (20000 / 500) ** ((t / end) ** 2)), 0.8, 0, Math.ceil(end * SR) + 64);
  }

  const dryDb = activeRmsDb(music.mixIn(drumBus));
  if (activeRmsDb(revSend) > -200) {
    const wet = reverb(revSend, mix.reverb ?? {});
    music.mixIn(normalizeTo(wet, dryDb - 13 + (mix.reverbDb ?? 0)));
  }
  if (activeRmsDb(dlySend) > -200) {
    const wet = pingPong(dlySend, tl.beat * (mix.delayBeats ?? 0.75), mix.delayFeedback ?? 0.38);
    music.mixIn(normalizeTo(wet, dryDb - 17 + (mix.delayDb ?? 0)));
  }

  const master = music;
  if (mix.lofi) {
    eq(master, "lowpass", 7200);
    eq(master, "lowshelf", 200, 0.7, 2);
    wow(master);
    const crackle = new Stereo(length);
    placeMono(crackle, vinyl(length / SR, hashSeed(song.id)), 0, 1, 0);
    normalizeTo(crackle, dryDb - 26);
    master.mixIn(crackle);
  }
  for (const [type, f, q, g] of mix.masterEq ?? []) eq(master, type, f, q, g);
  normalizeTo(master, -15);
  compress(master, { threshDb: -17, ratio: 2, attack: 0.02, release: 0.25, makeupDb: 1 });
  saturate(master, mix.lofi ? 1.4 : 1.12);
  normalizeTo(master, -14);
  limit(master, 0.94);
  // Ease the last moment of the reverb tail to silence.
  const fade = Math.round(0.6 * SR);
  for (let i = 0; i < fade; i++) {
    const g = 1 - i / fade;
    master.L[length - fade + i] *= g;
    master.R[length - fade + i] *= g;
  }

  const chorusSection = tl.sections.find((s) => s.type === "chorus") ?? tl.sections[1] ?? tl.sections[0];
  return { buffer: master, highlightStart: +chorusSection.t.toFixed(2), duration: length / SR, bpm: song.bpm };
}

export { dbToGain };
