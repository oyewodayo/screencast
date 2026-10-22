// The jazz engine behind the Briefcast Originals' jazz set. A tune is a lead sheet plus a band and
// an arrangement (jazz-songs.mjs): chord symbols, a form (AABA, blues, modal...), and a plan -
// count-off, intro, head, solos, trading fours, shout chorus, head out, tag, final chord. From that
// it performs the tune the way a band would:
//   - walking bass with chromatic and dominant approaches, two-feel, bossa and pattern bass
//   - rootless, quartal, shell and drop-2 voicings, voice-led, in rhythmic comping cells
//   - heads built from a motif that comes back every A; riffs for blues; call-and-response for modal
//   - solos as bebop lines (chord tones on the beat, enclosures, triplet turns, arpeggio-up/scale-down)
//   - a swing ride with the skip beat, hi-hat on 2 and 4, feathered kick, snare chatter, fills that
//     set up each section, brushes, bossa cross-stick, shuffle, trading fours with a drum solo
//   - laid-back horns, a tempo map with a ritardando into a held final chord, and a mix in a small
//     room (or a live club with a crowd that claps after the solos).
import { SR, TAU, Biquad, Stereo, activeRmsDb, chorus, clamp, compress, dbToGain, eq, hashSeed, limit, normalizeTo, panGains, pingPong, placeMono, reverb, rng, saturate, wow } from "./dsp.mjs";
import * as I from "./instruments.mjs";
import * as J from "./jazz-instruments.mjs";
import { kit, vinyl } from "./drums.mjs";

const INST = { ...I, ...J };

// ---- Chord symbols ---------------------------------------------------------------------------

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const pcOf = (s) => (LETTER[s[0]] + (s[1] === "#" ? 1 : s[1] === "b" ? -1 : 0) + 12) % 12;
const mod12 = (x) => ((x % 12) + 12) % 12;

// "Cmaj9", "A7b9", "Dm11", "G13", "Bm7b5", "Ebdim7", "F#m6", "C69", "G7alt", "D9sus", "Bb7#11", "C/E".
export function parseChord(sym) {
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(sym);
  if (!m) throw new Error(`Can't read chord "${sym}"`);
  const c = { sym, root: pcOf(m[1]), bass: m[3] ? pcOf(m[3]) : null, kind: "maj", third: 4, fifth: 7, seventh: null, sixth: false, tens: new Set(), alt: false, sus: false };
  let q = m[2];
  const eat = (re) => {
    const x = re.exec(q);
    if (x) q = q.slice(x[0].length);
    return !!x;
  };
  if (eat(/^(m7b5|ø7?)/)) Object.assign(c, { kind: "half", third: 3, fifth: 6, seventh: 10 });
  else if (eat(/^(dim7?|°7?)/)) Object.assign(c, { kind: "dim", third: 3, fifth: 6, seventh: 9 });
  else if (eat(/^(mMaj7?|mM7?)/)) Object.assign(c, { kind: "minmaj", third: 3, seventh: 11 });
  else if (eat(/^(maj7?|M7?|Δ7?)/)) Object.assign(c, { kind: "maj", seventh: 11 });
  else if (eat(/^(m|min|-)/)) Object.assign(c, { kind: "min", third: 3 });
  for (const tok of q.match(/b9|#9|#11|b13|b5|#5|\+|alt|sus4|sus2|sus|add9|69|13|11|9|7|6/g) ?? []) {
    switch (tok) {
      case "7": c.seventh ??= 10; break;
      case "9": c.seventh ??= 10; c.tens.add(14); break;
      case "11": c.seventh ??= 10; c.tens.add(14).add(17); break;
      case "13": c.seventh ??= 10; c.tens.add(14).add(21); break;
      case "6": c.sixth = true; break;
      case "69": c.sixth = true; c.tens.add(14); break;
      case "add9": c.tens.add(14); break;
      case "b9": c.tens.add(13); break;
      case "#9": c.tens.add(15); break;
      case "#11": c.tens.add(18); break;
      case "b13": c.tens.add(20); break;
      case "b5": c.fifth = 6; break;
      case "#5": case "+": c.fifth = 8; break;
      case "alt": c.alt = true; c.tens.add(13).add(15).add(20); c.fifth = null; break;
      case "sus": case "sus4": c.third = 5; c.sus = true; break;
      case "sus2": c.third = 2; c.sus = true; break;
    }
  }
  if (c.kind === "maj" && c.seventh === 10) c.kind = "dom";
  if (c.sus) c.kind = "sus";
  return c;
}

// Chord tones as intervals over the root (a plain triad borrows the 6th, the jazz default).
const seventhOf = (c) => c.seventh ?? (c.kind === "dom" || c.kind === "sus" ? 10 : 9);
const tonesOf = (c) => [0, c.third, c.fifth ?? 8, seventhOf(c)];

// The notes a line can sit on at a strong beat: guide tones first, then root, 5th and the tensions.
function targetsOf(c) {
  const t = [c.third, seventhOf(c), 0];
  if (c.fifth != null) t.push(c.fifth);
  for (const x of c.tens) t.push(x);
  if (c.kind === "maj" || c.kind === "min" || c.kind === "minmaj") t.push(2);
  if (c.kind === "dom" && c.tens.size === 0) t.push(2, 9);
  return [...new Set(t.map(mod12))];
}

function scaleOf(c) {
  switch (c.kind) {
    case "maj": return c.tens.has(18) ? [0, 2, 4, 6, 7, 9, 11] : [0, 2, 4, 5, 7, 9, 11];
    case "min": return c.seventh === 11 ? [0, 2, 3, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 9, 10];
    case "minmaj": return [0, 2, 3, 5, 7, 9, 11];
    case "half": return [0, 2, 3, 5, 6, 8, 10];
    case "dim": return [0, 2, 3, 5, 6, 8, 9, 11];
    case "sus": return [0, 2, 4, 5, 7, 9, 10];
    default:
      if (c.alt) return [0, 1, 3, 4, 6, 8, 10];
      if (c.tens.has(13) || c.tens.has(15)) return [0, 1, 3, 4, 6, 7, 9, 10];
      if (c.tens.has(20)) return [0, 2, 4, 5, 7, 8, 10];
      if (c.tens.has(18)) return [0, 2, 4, 6, 7, 9, 10];
      return [0, 2, 4, 5, 7, 9, 10];
  }
}

// Bill Evans-style rootless voicings (the bass has the root): 3-5-7-9 / 3-13-7-9 and friends.
function rootlessOf(c) {
  const T = c.tens;
  let v;
  switch (c.kind) {
    case "maj": v = [4, T.has(18) ? 6 : c.seventh === 11 && (T.has(21) || c.sixth) ? 9 : 7, c.seventh ?? 9, 2]; break;
    case "min": v = [3, T.has(17) ? 5 : 7, c.seventh ?? 9, 2]; break;
    case "minmaj": v = [3, 7, 11, 2]; break;
    case "half": v = [3, 6, 10, 5]; break;
    case "dim": v = [0, 3, 6, 9]; break;
    case "sus": v = [5, T.has(21) ? 9 : 7, 10, 2]; break;
    default:
      if (c.alt) v = [4, 8, 10, 3];
      else v = [4, T.has(20) || c.fifth === 8 ? 8 : T.has(18) ? 6 : 9, 10, T.has(13) ? 1 : T.has(15) ? 3 : 2];
  }
  return [...new Set(v.map((x) => mod12(c.root + x)))];
}

const shellOf = (c) => [c.root, mod12(c.root + c.third), mod12(c.root + seventhOf(c))];
const upperOf = (c) => [mod12(c.root + c.third), mod12(c.root + seventhOf(c)), mod12(c.root + (c.kind === "dom" ? (c.tens.has(13) ? 1 : c.tens.has(20) ? 8 : 9) : c.kind === "half" ? 5 : 2))];
// Gypsy rhythm-guitar chords: root on the bottom, 6ths on minor and major chords, 9ths on dominants.
const pompeOf = (c) => [...new Set([0, c.third, c.fifth ?? 8, c.kind === "dom" ? 10 : c.kind === "half" || c.kind === "dim" ? seventhOf(c) : c.seventh === 11 ? 11 : 9, c.kind === "dom" ? 2 : 7].map((x) => mod12(c.root + x)))];

// Every close-position stacking of `pcs` (plus drop-2 spreads) inside [lo, hi].
function voicingsOf(pcs, lo, hi, drop2) {
  const out = [];
  const n = pcs.length;
  for (let rot = 0; rot < n; rot++) {
    const order = pcs.slice(rot).concat(pcs.slice(0, rot));
    for (let base = lo; base < lo + 12; base++) {
      if (base % 12 !== order[0]) continue;
      const v = [base];
      for (let k = 1; k < n; k++) {
        let m = v[k - 1] + 1;
        while (m % 12 !== order[k]) m++;
        v.push(m);
      }
      if (v[n - 1] <= hi) out.push(v);
      if (drop2 && n >= 4) {
        const d = v.slice();
        const [x] = d.splice(n - 2, 1);
        d.push(x - 12);
        d.sort((a, b) => a - b);
        if (d[0] >= lo - 5 && d[n - 1] <= hi) out.push(d);
      }
    }
  }
  return out;
}

// The voicing closest to the last one (smooth voice-leading, a singing top line), kept out of mud.
function voice(pcs, prev, lo, hi, { drop2 = false } = {}) {
  const cands = voicingsOf(pcs, lo, hi, drop2);
  const center = (lo + hi) / 2;
  let best = cands[0] ?? pcs.map((p) => lo + mod12(p - lo));
  let bestS = Infinity;
  for (const v of cands) {
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    let s = Math.abs(mean - center) * (prev ? 0.35 : 1);
    if (prev) {
      for (let i = 0; i < v.length; i++) s += Math.abs(v[i] - prev[Math.min(i, prev.length - 1)]);
      s += Math.abs(v[v.length - 1] - prev[prev.length - 1]) * 0.5;
    }
    if (v[0] < 52 && v[1] - v[0] < 5) s += 6;
    if (s < bestS) [best, bestS] = [v, s];
  }
  return best;
}

// Nearest pitch to p whose pitch class is in `ivs` over the chord root - strictly above/below when
// `dir` is given - inside [lo, hi].
function nearestIn(c, ivs, p, dir = 0, lo = 0, hi = 127) {
  const set = new Set(ivs.map((x) => mod12(c.root + x)));
  let best = null;
  for (let d = dir ? 1 : 0; d <= 14; d++) {
    for (const m of dir ? [p + dir * d] : d === 0 ? [p] : [p - d, p + d]) {
      if (m >= lo && m <= hi && set.has(mod12(m))) {
        best = m;
        break;
      }
    }
    if (best != null) break;
  }
  if (best == null) return dir ? nearestIn(c, ivs, p, 0, lo, hi) : clamp(p, lo, hi);
  return best;
}
const stepScale = (c, p, dir, n, lo, hi) => {
  let x = p;
  for (let k = 0; k < n; k++) x = nearestIn(c, scaleOf(c), x, dir, lo, hi);
  return x;
};
const isTarget = (c, m) => targetsOf(c).includes(mod12(m - c.root));
const BLUES = [0, 3, 5, 6, 7, 10];

function closestPc(pc, ref, lo, hi, center = ref) {
  let best = null;
  let bs = Infinity;
  for (let m = lo; m <= hi; m++) {
    if (mod12(m) !== mod12(pc)) continue;
    const s = Math.abs(m - ref) + 0.3 * Math.abs(m - center);
    if (s < bs) [best, bs] = [m, s];
  }
  return best ?? clamp(ref, lo, hi);
}

function weighted(r, items, w) {
  const ws = items.map(w);
  let x = r() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) if ((x -= ws[i]) <= 0) return items[i];
  return items[items.length - 1];
}

// ---- Arrangement and time --------------------------------------------------------------------

function parseChart(str, meter) {
  const bars = [];
  for (const raw of str.split("|")) {
    const tok = raw.trim();
    if (!tok) continue;
    if (tok === "%") {
      bars.push(bars[bars.length - 1]);
      continue;
    }
    const syms = tok.split(/\s+/);
    bars.push(syms.map((s, j) => ({ c: parseChord(s), beat: (j * meter) / syms.length, len: meter / syms.length })));
  }
  return bars;
}

const PART_INT = { count: 0.3, intro: 0.38, head: 0.5, solo: 0.6, trade: 0.82, shout: 0.95, bassSolo: 0.3, tag: 0.6, final: 0.7, vamp: 0.55, groove: 0.5 };

function arrange(song) {
  const meter = song.meter ?? 4;
  const charts = Object.fromEntries(Object.entries(song.charts).map(([k, v]) => [k, parseChart(v, meter)]));
  const segs = [];
  let bar = 0;
  song.plan.forEach((item, pi) => {
    const times = item.times ?? 1;
    const labels = item.chart ? [].concat(item.chart) : song.form;
    for (let k = 0; k < times; k++) {
      labels.forEach((label, li) => {
        const bars = charts[label];
        if (!bars) throw new Error(`${song.id}: no chart "${label}"`);
        const prog = (k * labels.length + li) / (times * labels.length);
        const ramp = item.part === "solo" ? 0.32 : item.part === "head" ? 0.12 : item.part === "vamp" ? 0.15 : 0.05;
        const int = clamp((item.int ?? PART_INT[item.part] ?? 0.5) + ramp * prog, 0.12, 1);
        segs.push({ part: item.part, item, label, bars, nBars: bars.length, b0: bar * meter, b1: (bar + bars.length) * meter, pass: k, of: times, idx: li, n: labels.length, planIndex: pi, int, first: k === 0 && li === 0, last: k === times - 1 && li === labels.length - 1 });
        bar += bars.length;
      });
    }
  });
  const chords = [];
  for (const s of segs) s.bars.forEach((bar, k) => bar.forEach((ch) => chords.push({ b: s.b0 + k * meter + ch.beat, len: ch.len, c: ch.c })));
  return { meter, segs, chords, totalBeats: bar * meter };
}

function context(song) {
  const A = arrange(song);
  const M = A.meter;
  const beat = 60 / song.bpm;
  const total = A.totalBeats + 16;
  const durs = new Float64Array(total).fill(beat);
  for (const s of A.segs) {
    if (s.part === "final") for (let k = s.b0; k < s.b1; k++) durs[k] = beat * (s.item.stretch ?? 1.5);
    else if (s.item.rit && s.last) {
      const n = s.b1 - s.b0;
      for (let k = s.b0; k < s.b1; k++) durs[k] = beat * (1 + (s.item.rit === true ? 0.55 : s.item.rit) * ((k - s.b0 + 0.5) / n) ** 1.7);
    }
  }
  const pre = song.live?.preroll ?? 0;
  const T = new Float64Array(total + 1);
  T[0] = pre;
  for (let k = 0; k < total; k++) T[k + 1] = T[k] + durs[k];
  const at = (b) => {
    const k = clamp(Math.floor(b), 0, total - 1);
    return T[k] + (b - k) * durs[k];
  };
  const s = song.swing ?? clamp(0.67 - (song.bpm - 110) * 0.0008, 0.56, 0.68);
  const sw = (f) => (f < 0.5 ? (f / 0.5) * s : s + ((f - 0.5) / 0.5) * (1 - s));
  const time = (b, trip) => {
    if (trip || s === 0.5) return at(b);
    const k = Math.floor(b + 1e-9);
    const fr = b - k;
    if (song.swing16) {
      const h = Math.floor(fr * 2 + 1e-9) / 2;
      return at(k + h + sw((fr - h) * 2) / 2);
    }
    return at(k + sw(fr));
  };
  const C = A.chords;
  const idx = (b) => {
    let lo = 0;
    let hi = C.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (C[m].b <= b + 1e-6) lo = m;
      else hi = m - 1;
    }
    return lo;
  };
  const chordAt = (b) => C[idx(b)].c;
  // A chord "starts" where its symbol differs from the one before (a held chord across bars doesn't).
  const chordStartAt = (b) => {
    const i = idx(b);
    return Math.abs(C[i].b - b) < 1e-6 && (i === 0 || C[i - 1].c.sym !== C[i].c.sym);
  };
  const nextChange = (b) => {
    const i = idx(b);
    for (let j = i + 1; j < C.length; j++) if (C[j].c.sym !== C[i].c.sym) return C[j].b;
    return A.totalBeats;
  };
  return { song, A, M, segs: A.segs, beat, at, time, chordAt, chordStartAt, nextChange, swing: s, totalBeats: A.totalBeats, pre };
}

// ---- Melody: heads ---------------------------------------------------------------------------

// A 2-bar rhythm for a head: onsets on the half-beat grid, syncopation welcome, a breath at the end.
function headRhythm(r, M, style, type) {
  const U = 2 * M;
  for (let attempt = 0; attempt < 40; attempt++) {
    const on = [];
    for (let o = 0; o < U - 0.01; o += 0.5) {
      const pos = o % M;
      let w = pos === 0 ? 0.52 : pos % 1 === 0 ? 0.36 : 0.3;
      if (style === "ballad") w *= 0.5;
      if (style === "bossa") w *= pos % 1 === 0.5 ? 1.15 : 0.75;
      if (type === "busy") w *= 1.55;
      if (type === "motif" && o >= U - 1.5) w *= 0.2;
      if (type === "cadence") w = o < M - 0.01 ? w * 0.85 : Math.abs(o - M) < 0.01 ? 0.97 : 0;
      if (r() < w) on.push(o);
    }
    const min = style === "ballad" ? 2 : 3;
    const max = style === "ballad" ? 5 : type === "busy" ? 9 : 7;
    if (on.length < min || on.length > max) continue;
    if (type === "cadence" && on[on.length - 1] !== M) continue;
    return on.map((o, i) => ({ o, len: (on[i + 1] ?? (type === "cadence" ? U - 0.5 : Math.min(U - 0.5, o + 3))) - o }));
  }
  return [{ o: 0.5, len: 1 }, { o: 1.5, len: 1.5 }, { o: M, len: M - 0.5 }];
}

function contourMove(r, i, n, style, kind) {
  const choices = style === "ballad" ? [1, 2, 3, 4, 1, 2] : [1, 1, 2, 1, 2, 3, 0];
  let s = r.pick(choices);
  if (kind === "C" || kind === "F") return -s * (r.chance(0.8) ? 1 : -1);
  return i < n / 2 ? s * (r.chance(0.7) ? 1 : -1) : -s * (r.chance(0.72) ? 1 : -1);
}

const moveBy = (c, q, steps, lo, hi) => {
  let x = steps ? stepScale(c, q, Math.sign(steps), Math.abs(steps), lo, hi) : q;
  if (x === q && steps) x = stepScale(c, q, -Math.sign(steps), 1, lo, hi);
  return x;
};

// Motif-built melody: M (the idea), S (the idea again, re-fitted to the new chords), N (contrast),
// C/F (cadence: a few notes then a long, landed tone). The same section label gets the same melody.
function motifMelody(ctx, r, seg, style, lo, hi) {
  const M = ctx.M;
  const U = 2 * M;
  const units = Math.ceil(seg.nBars / 2);
  const plan = units >= 8 ? ["M", "S", "N", "C", "M", "S", "O", "F"] : units >= 4 ? ["M", "S", "N", "F"] : units === 3 ? ["M", "S", "F"] : units === 2 ? ["M", "F"] : ["F"];
  const mid = Math.round(lo + (hi - lo) * 0.5);
  const rh = {};
  let motif = null;
  const out = [];
  let p = mid;
  for (let u = 0; u < units; u++) {
    const kind = plan[u];
    const ub = seg.b0 + u * U;
    const rk = kind === "S" ? "M" : kind === "F" ? "C" : kind;
    rh[rk] ??= headRhythm(r, M, style, rk === "C" ? "cadence" : rk === "N" || rk === "O" ? "busy" : "motif");
    const R = rh[rk];
    const reuse = (kind === "M" || kind === "S") && motif;
    const moves = reuse ? motif.moves : R.map((_, i) => (i === 0 ? 0 : contourMove(r, i, R.length, style, kind)));
    const c0 = ctx.chordAt(ub + R[0].o);
    let q;
    if (kind === "M" && motif) q = motif.start;
    else if (kind === "S" && motif) q = nearestIn(c0, targetsOf(c0), motif.start + r.pick([-2, 2, 3, -3, 1]), 0, lo + 2, hi - 2);
    else q = nearestIn(c0, targetsOf(c0), kind === "C" || kind === "F" ? p + 2 : r.pick([mid, mid + 3, mid - 2, p]), 0, lo + 2, hi - 2);
    const start = q;
    R.forEach((h, i) => {
      const b = ub + h.o;
      if (b >= seg.b1 - 0.01) return;
      const c = ctx.chordAt(b);
      if (i > 0) q = moveBy(c, q, moves[i], lo, hi);
      const strong = h.o % M === 0 || h.len >= 1.5 || (h.o % 1 === 0 && r.chance(0.5));
      if (strong && !isTarget(c, q)) q = nearestIn(c, targetsOf(c), q, 0, lo, hi);
      if ((kind === "F" || kind === "C") && i === R.length - 1) q = nearestIn(c, kind === "F" ? [c.third, 0, 2] : [c.third, seventhOf(c), 2], q, 0, lo, hi);
      out.push({ b, len: Math.min(h.len, seg.b1 - b), midi: q, vel: 0.8, end: i === R.length - 1 });
    });
    if (kind === "M" && !motif) motif = { start, moves };
    p = q;
  }
  return out;
}

// Blues head: a 2-bar riff from the blues scale, played over the I, moved up for the IV, answered
// in bars 9-10 and resolved in 11-12.
function riffMelody(ctx, r, seg, lo, hi) {
  const M = ctx.M;
  const U = 2 * M;
  const key = ctx.song.keyPc ?? ctx.chordAt(seg.b0).root;
  const mid = Math.round((lo + hi) / 2);
  const pcs = BLUES.map((x) => mod12(key + x));
  const nearest = (p) => {
    for (let d = 0; d < 12; d++) for (const m of [p - d, p + d]) if (pcs.includes(mod12(m)) && m >= lo && m <= hi) return m;
    return p;
  };
  const step = (p, dir) => {
    let m = p + dir;
    while (!pcs.includes(mod12(m))) m += dir;
    return clamp(m, lo, hi);
  };
  const make = (type, startPc) => {
    const R = headRhythm(r, M, "swing", type);
    let q = nearest(closestPc(startPc, mid, lo, hi));
    return R.map((h, i) => {
      if (i > 0) q = step(q, r.chance(i < R.length / 2 ? 0.6 : 0.3) ? 1 : -1);
      if (r.chance(0.25) && i > 0) q = step(q, r.chance(0.5) ? 1 : -1);
      return { o: h.o, len: h.len, midi: q };
    });
  };
  const riff = make("motif", key + 7);
  const answer = make("busy", key + 10);
  const cadence = make("cadence", key + 3);
  cadence[cadence.length - 1].midi = closestPc(key, cadence[cadence.length - 1].midi, lo, hi);
  const units = Math.ceil(seg.nBars / 2);
  const shapes = [[riff, 0], [riff, 0], [riff, 5], [riff, 0], [answer, 0], [cadence, 0]];
  const out = [];
  for (let u = 0; u < units; u++) {
    const [shape, tr] = shapes[Math.min(u, shapes.length - 1)];
    for (const n of shape) {
      const b = seg.b0 + u * U + n.o;
      if (b < seg.b1 - 0.01) out.push({ b, len: Math.min(n.len, seg.b1 - b), midi: clamp(n.midi + (n.midi + tr > hi ? tr - 12 : tr), lo, hi), vel: 0.85 });
    }
  }
  return out;
}

function headNotes(ctx, P, seg) {
  P._heads ??= new Map();
  const style = P.headStyle ?? ctx.song.head ?? "lyrical";
  if (!P._heads.has(seg.label)) {
    const r = rng(hashSeed(`${ctx.song.id}:head:${seg.label}`));
    const [lo, hi] = P.headRange ?? (P.role === "comp" ? P.soloRange : null) ?? P.range;
    let notes;
    if (style === "bebop") notes = improvise(ctx, { ...P, r, _p: Math.round(lo + (hi - lo) * 0.6) }, seg.b0, seg.b1, { style: "bebop", density: 0.9, startOffset: 0.5, range: [lo, hi] });
    else if (style === "riff") notes = riffMelody(ctx, r, seg, lo, hi);
    else notes = motifMelody(ctx, r, seg, style, lo, hi);
    articulate(ctx, { ...P, range: [lo, hi], soloRange: [lo, hi], r: rng(hashSeed(`${ctx.song.id}:phrasing:${seg.label}`)) }, notes, style === "riff" ? "blues" : style);
    P._heads.set(seg.label, notes.map((n) => ({ ...n, b: n.b - seg.b0 })));
  }
  return P._heads.get(seg.label).map((n) => ({ ...n, b: n.b + seg.b0 }));
}

// ---- Melody: improvisation -------------------------------------------------------------------

// Bebop-grammar lines: chord tones on the beat, scale steps and chromatic passing tones between,
// arpeggios going up and scales coming down, enclosures into chord changes, triplet turns, phrases
// that breathe. `style`: bebop | lyrical | blues | bass | fill.
function improvise(ctx, P, b0, b1, o = {}) {
  const r = P.r;
  const [lo, hi] = o.range ?? P.soloRange ?? P.range;
  const style = o.style ?? "bebop";
  const dens = clamp(o.density ?? 0.6, 0.1, 1);
  const mid = (lo + hi) / 2;
  const blues = o.blues;
  const out = [];
  let p = clamp(P._p ?? Math.round(mid), lo, hi);
  let dir = r.chance(0.5) ? 1 : -1;
  let b = b0 + (o.startOffset ?? r.pick([0, 0.5, 1, 1.5]));
  while (b < b1 - 0.75) {
    const phraseBeats = style === "bebop" ? r.pick([3, 4, 4, 6, 7, 8]) * (0.6 + 0.7 * dens) : style === "bass" ? r.pick([3, 4, 6]) : style === "fill" ? r.pick([1.5, 2, 2.5]) : r.pick([2, 3, 4, 5]) * (0.6 + 0.6 * dens);
    const end = Math.min(b1 - 0.25, b + phraseBeats);
    const c0 = ctx.chordAt(b);
    if (Math.abs(p - mid) > (hi - lo) * 0.35 || r.chance(0.3)) p = nearestIn(c0, targetsOf(c0), Math.round(mid + r.range(-5, 5)), 0, lo, hi);
    let mode = r.chance(0.45) ? "arp" : "scale";
    let forced = null;
    let first = true;
    const phrase = [];
    // The organ/sax climax trick: one bluesy cell repeated in triplets.
    if (blues != null && dens > 0.75 && r.chance(0.18) && end - b >= 2) {
      const cell = [p, p - 2, p - 5].map((x) => nearestIn({ root: blues }, BLUES, x, 0, lo, hi));
      const n = Math.floor(end - b) * 3;
      for (let j = 0; j < n; j++) phrase.push({ b: b + j / 3, len: 0.3, midi: cell[j % 3], trip: true, vel: 0.85 });
      b += n / 3;
    }
    while (b < end - 0.01) {
      const c = ctx.chordAt(b);
      const onBeat = Math.abs(b - Math.round(b)) < 1e-6;
      if (onBeat && style !== "lyrical" && style !== "bass" && forced == null && b + 1 <= end && r.chance(style === "bebop" ? 0.09 + 0.08 * dens : 0.05)) {
        p = nearestIn(c, targetsOf(c), p, 0, lo, hi);
        for (let j = 0; j < 3; j++) {
          if (j > 0) p = stepScale(c, p, dir, 1, lo, hi);
          phrase.push({ b: b + j / 3, len: 0.3, midi: p, trip: true, vel: 0.78 });
        }
        b += 1;
        first = false;
        continue;
      }
      const nb = b + 1;
      if (onBeat && !first && forced == null && style !== "bass" && nb < end && ctx.chordStartAt(nb) && r.chance(0.3 + 0.2 * dens)) {
        const cn = ctx.chordAt(nb);
        const T = nearestIn(cn, [cn.third, seventhOf(cn)], p, 0, lo + 2, hi - 2);
        phrase.push({ b, len: 0.5, midi: stepScale(cn, T, 1, 1, lo, hi), vel: 0.74 }, { b: b + 0.5, len: 0.5, midi: T - 1, vel: 0.84 });
        forced = T;
        b = nb;
        dir = r.chance(0.5) ? 1 : -1;
        continue;
      }
      const x = r();
      let len;
      if (style === "bebop") len = x < 0.78 ? 0.5 : x < 0.92 ? 1 : 1.5;
      else if (style === "bass") len = x < 0.45 ? 1 : x < 0.85 ? 0.5 : 1.5;
      else if (style === "lyrical") len = x < 0.4 ? 0.5 : x < 0.72 ? 1 : x < 0.88 ? 1.5 : 2;
      else len = x < 0.6 ? 0.5 : x < 0.85 ? 1 : 1.5;
      if (!onBeat && len > 0.5 && r.chance(0.5)) len = 0.5;
      if (b + len > end) len = Math.max(0.5, end - b);
      if (forced != null) {
        p = forced;
        forced = null;
      } else if (!first) {
        if (onBeat || len >= 1) {
          const q = mode === "arp" ? nearestIn(c, tonesOf(c).concat([2]), p, dir, lo, hi) : nearestIn(c, targetsOf(c), p + dir * r.pick([1, 2, 2, 3]), 0, lo, hi);
          p = q === p ? stepScale(c, p, dir, 1, lo, hi) : q;
        } else if (r.chance(0.16)) p += dir;
        else p = mode === "arp" ? nearestIn(c, tonesOf(c), p, dir, lo, hi) : stepScale(c, p, dir, r.chance(0.2) ? 2 : 1, lo, hi);
        if (blues != null && r.chance(0.18)) p = nearestIn({ root: blues }, BLUES, p, 0, lo, hi);
      }
      p = clamp(p, lo, hi);
      if (p >= hi - 1) {
        dir = -1;
        mode = "scale";
      } else if (p <= lo + 1) {
        dir = 1;
        mode = r.chance(0.6) ? "arp" : "scale";
      } else if (r.chance(mode === "arp" ? 0.22 : 0.12)) {
        dir = -dir;
        mode = dir > 0 && r.chance(0.55) ? "arp" : "scale";
      }
      // Blue-note grace: slide into the major 3rd from the minor 3rd.
      if (blues != null && len >= 1 && mod12(p - c.root) === 4 && r.chance(0.35)) phrase.push({ b: b - 0.12, len: 0.12, midi: p - 1, vel: 0.6, trip: true });
      phrase.push({ b, len, midi: p, vel: 0.8 });
      first = false;
      b += len;
    }
    if (phrase.length) {
      const last = phrase[phrase.length - 1];
      const c = ctx.chordAt(last.b);
      last.midi = nearestIn(c, targetsOf(c), last.midi, 0, lo, hi);
      last.end = true;
      if (style !== "bass" && last.len < 1 && last.b + 1.5 <= b1 && r.chance(0.5)) last.len = r.pick([1, 1.5, 2]);
      b = Math.max(b, last.b + last.len);
    }
    out.push(...phrase);
    P._p = p;
    const rest = (style === "bebop" ? r.pick([0.5, 1, 1, 1.5, 2, 3]) : style === "fill" ? 99 : r.pick([1, 1.5, 2, 3, 4])) * (1.5 - dens);
    b = Math.round((b + rest) * 2) / 2;
  }
  return out.filter((n) => n.b >= b0 - 0.2 && n.b < b1);
}

// Phrasing: velocities, gates, slurs (bebop slurs into the beat and tongues the off-beat), scoops,
// fall-offs and swells. Horns read all of it; keyboards just get the dynamics.
function articulate(ctx, P, notes, style) {
  const [lo, hi] = P.soloRange ?? P.range;
  notes.sort((a, b) => a.b - b.b);
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const prev = notes[i - 1];
    const next = notes[i + 1];
    const onBeat = !n.trip && Math.abs(n.b - Math.round(n.b)) < 1e-6;
    const joined = prev && n.b - (prev.b + prev.len) < 0.06;
    const gapAfter = !next || next.b - (n.b + n.len) > 0.06;
    let v = n.vel ?? 0.8;
    if (style === "bebop" || style === "blues") v *= onBeat ? 0.86 : 1;
    v *= 0.9 + (0.2 * (n.midi - lo)) / Math.max(1, hi - lo);
    if (gapAfter && n.len <= 0.5 && style === "bebop") v *= 1.08;
    n.vel = clamp(v * (P.vel ?? 1), 0.08, 1);
    if (next && next.b < n.b + n.len) n.len = Math.max(0.1, next.b - n.b);
    n.len *= gapAfter ? (n.len <= 0.5 ? 0.72 : 0.93) : 1.03;
    if (joined && Math.abs(n.midi - prev.midi) <= 5 && (style !== "bebop" || onBeat) && P.r.chance(0.75)) n.legato = true;
    if (gapAfter && n.len >= 0.9 && (style === "bebop" || style === "blues") && P.r.chance(0.16)) n.fall = P.r.pick([3, 5, 7]);
    if (!joined && n.len >= 1 && style !== "bebop" && P.r.chance(0.35)) n.scoop = 1.6;
    if ((style === "ballad" || style === "lyrical") && n.len >= 2.5) n.swell = true;
  }
  return notes;
}

// ---- Comping ---------------------------------------------------------------------------------

// Rhythm cells a jazz pianist comps in, by meter: [beat, length] hits.
const CELLS = {
  4: [
    { w: 3, h: [[0, 1.3], [1.5, 0.45]] },
    { w: 2.2, h: [[1.5, 0.45], [3, 0.9]] },
    { w: 2, h: [[0.5, 0.45], [2, 1.5]] },
    { w: 2, h: [[1, 0.45], [2.5, 1.3]] },
    { w: 2.2, h: [[3.5, 1.5]] },
    { w: 1.6, h: [[0, 0.45], [1.5, 0.45], [3.5, 1.2]] },
    { w: 1.2, h: [[2, 1.8]] },
    { w: 1.4, h: [] },
    { w: 1.2, busy: true, h: [[1, 0.35], [2, 0.35], [3.5, 1]] },
    { w: 1, busy: true, h: [[0.5, 0.35], [1.5, 0.35], [2.5, 0.4], [3.5, 1]] },
    { w: 1, calm: true, h: [[0, 3.6]] },
  ],
  3: [
    { w: 2.5, h: [[1, 0.6], [2, 0.6]] },
    { w: 2, h: [[0, 0.9], [1.5, 1.2]] },
    { w: 2, h: [[2.5, 1.2]] },
    { w: 1.6, h: [[1, 1.8]] },
    { w: 1.2, h: [] },
    { w: 1.2, busy: true, h: [[0.5, 0.4], [1.5, 0.4], [2.5, 1]] },
    { w: 1, calm: true, h: [[0, 2.7]] },
  ],
};

function pushChord(out, pitches, b, len, vel, { roll = 0, rand, accentTop = 0.05, trip } = {}) {
  pitches.forEach((m, k) => out.push({ b, len, midi: m, vel: clamp(vel * (0.92 + 0.12 * rand()) + (k === pitches.length - 1 ? accentTop : 0), 0.05, 1), dt: roll * k + rand() * 0.006, trip }));
}

// Swing comping in cells; a hit half a beat before a chord change voices the coming chord.
function compCells(ctx, P, seg, out, { lo, hi, pcsOf = rootlessOf, sparse = 1, hold = 1, velBase = 0.5, quartal = false } = {}) {
  const r = P.r;
  const M = ctx.M;
  const cells = CELLS[M] ?? CELLS[4];
  const int = seg.int;
  for (let bar = 0; bar < seg.nBars; bar++) {
    const b0 = seg.b0 + bar * M;
    const cell = weighted(r, cells, (c) => c.w * (c.busy ? (0.3 + 1.6 * int) / sparse : 1) * (c.h.length === 0 ? (1.7 - int) * sparse : 1) * (c.calm ? 1.5 - int : 1));
    for (const [pos, len] of cell.h) {
      const b = b0 + pos;
      if (pos === 0 && P._antic === b0) continue;
      if (b >= seg.b1 - 0.01) continue;
      const ahead = pos % 1 === 0.5 && ctx.chordStartAt(b + 0.5);
      const cb = ahead ? b + 0.5 : b;
      const c = ctx.chordAt(cb);
      if (pos + len > M) P._antic = b0 + M;
      const end = Math.min(b + len * hold, ctx.nextChange(cb));
      const pitches = quartal ? quartalVoicing(ctx, P, c, lo, hi) : (P._v = voice(pcsOf(c), P._v, lo, hi, { drop2: P.drop2 }));
      pushChord(out, pitches, b, Math.max(0.25, end - b), (velBase + 0.15 * int) * (len < 0.5 ? 1.08 : 1), { rand: r });
    }
  }
}

// So What-style voicing: three 4ths and a 3rd stacked from a mode tone, planing step-wise.
function quartalVoicing(ctx, P, c, lo, hi) {
  const sc = scaleOf(c);
  const n = sc.length;
  P._qk = clamp((P._qk ?? 1) + P.r.pick([-1, 0, 0, 1]), 0, n - 1);
  const notes = [0, 3, 6, 9, 11].map((s) => {
    const d = P._qk + s;
    return c.root + 12 * Math.floor(d / n) + sc[d % n];
  });
  let base = notes[0];
  while (base < lo) base += 12;
  while (base > lo + 9) base -= 12;
  const shift = base - notes[0];
  return notes.map((m) => m + shift).filter((m) => m <= hi + 5);
}

function compBallad(ctx, P, seg, out, { lo, hi }) {
  const r = P.r;
  for (let b = seg.b0; b < seg.b1 - 0.01; ) {
    const c = ctx.chordAt(b);
    const end = Math.min(ctx.nextChange(b), seg.b1);
    const at = b > seg.b0 && r.chance(0.25) ? b - 0.5 : b;
    P._v = voice(rootlessOf(c), P._v, lo, hi);
    pushChord(out, P._v, at, end - at + 0.15, 0.4 + 0.12 * seg.int, { roll: r.range(0.018, 0.035), rand: r, accentTop: 0.08 });
    if (end - b >= 4 && r.chance(0.4)) pushChord(out, P._v, b + 2.5, end - b - 2.5, 0.32, { roll: 0.012, rand: r });
    b = end;
  }
  // Fills answering the melody in its rests.
  for (const [g0, g1] of gapsIn(ctx, seg.b0, seg.b1, 2)) {
    if (!r.chance(0.6)) continue;
    const fill = improvise(ctx, P, g0 + 0.25, g1 - 0.25, { style: "fill", density: 0.5, range: P.fillRange ?? [70, 86], startOffset: 0 });
    fill.forEach((n) => (n.vel = 0.42 * (0.9 + 0.2 * r())));
    out.push(...fill);
  }
}

// Bossa nova guitar: thumb on 1 and 3 (root, fifth), fingers on the 2-bar syncopation.
function compBossa(ctx, P, seg, out, { lo, hi }) {
  const r = P.r;
  const fingers = [[0, 1.5], [1.5, 1.5], [3, 1.5], [5, 1.5], [6.5, 1.5]];
  for (let bar = 0; bar < seg.nBars; bar += 2) {
    const b0 = seg.b0 + bar * 4;
    for (const [pos, len] of fingers) {
      const b = b0 + pos;
      if (b >= seg.b1 - 0.01) continue;
      const c = ctx.chordAt(b);
      P._v = voice(upperOf(c), P._v, lo, hi);
      pushChord(out, P._v, b, Math.min(len * 0.85, ctx.nextChange(b) - b), 0.5 + 0.1 * seg.int, { roll: 0.007, rand: r });
    }
    for (let k = 0; k < 8 && b0 + k < seg.b1; k += 2) {
      const c = ctx.chordAt(b0 + k);
      const pc = k % 4 === 0 ? c.bass ?? c.root : c.root + (c.fifth ?? 7);
      out.push({ b: b0 + k, len: 1.8, midi: closestPc(pc, 45, 40, 52), vel: 0.55 });
    }
  }
}

// Gypsy "la pompe": a long-ish chord on 1 and 3, a choked accent on 2 and 4, with the little
// upstroke ghost before it.
function compPompe(ctx, P, seg, out, { lo, hi }) {
  const r = P.r;
  for (let b = seg.b0; b < seg.b1 - 0.01; b += 1) {
    const c = ctx.chordAt(b);
    P._v = voice(pompeOf(c), P._v, lo, hi);
    const back = (b - seg.b0) % 2 === 1;
    pushChord(out, P._v, b, back ? 0.16 : 0.42, back ? 0.85 : 0.55, { roll: 0.005, rand: r, accentTop: 0 });
    if (back && r.chance(0.55)) pushChord(out, P._v.slice(-2), b - 1 / 3, 0.07, 0.24, { roll: 0.003, rand: r, trip: true });
  }
}

// Freddie Green: three-note shells, four to the bar.
function compFour(ctx, P, seg, out, { lo, hi }) {
  const r = P.r;
  for (let b = seg.b0; b < seg.b1 - 0.01; b += 1) {
    const c = ctx.chordAt(b);
    P._v = voice(shellOf(c), P._v, lo, hi);
    pushChord(out, P._v, b, 0.4, (b - seg.b0) % 2 === 1 ? 0.58 : 0.5, { roll: 0.008, rand: r, accentTop: 0 });
  }
}

// Pattern comping (16-step strings, x accent / o soft / - hold / . rest) for jazz-hop and smooth.
function compPattern(ctx, P, seg, out, { lo, hi }) {
  const r = P.r;
  const pat = P.patterns?.[seg.part] ?? P.pattern;
  for (let bar = 0; bar < seg.nBars; bar++) {
    for (let step = 0; step < 16; step++) {
      const g = bar * 16 + step;
      const ch = pat[g % pat.length];
      if (ch !== "x" && ch !== "o") continue;
      let hold = 1;
      while (hold < 32 && pat[(g + hold) % pat.length] === "-" && step + hold < 32) hold++;
      const b = seg.b0 + g / 4;
      const ahead = [0.25, 0.5].find((d) => ctx.chordStartAt(b + d));
      const c = ctx.chordAt(ahead ? b + ahead : b);
      P._v = voice(rootlessOf(c), P._v, lo, hi);
      pushChord(out, P._v, b, Math.min(hold / 4, seg.b1 - b) * 0.95, (ch === "x" ? 0.6 : 0.45) + 0.1 * seg.int, { roll: P.roll ?? 0.006, rand: r });
    }
  }
}

function gapsIn(ctx, b0, b1, minBeats) {
  const busy = (ctx.busy ?? []).filter(([s, e]) => e > b0 && s < b1).sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cur = b0;
  for (const [s, e] of busy) {
    if (s - cur >= minBeats) gaps.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (b1 - cur >= minBeats) gaps.push([cur, b1]);
  return gaps;
}

// ---- Bass ------------------------------------------------------------------------------------

function walk(ctx, P, seg, b0, b1, two = false) {
  const r = P.r;
  const [lo, hi] = P.range ?? [28, 52];
  const center = (lo + hi) / 2 - 2;
  const out = [];
  let last = P._last ?? Math.round(center);
  const step = two ? (ctx.M === 3 ? 3 : 2) : 1;
  for (let b = b0; b < b1 - 0.01; b += step) {
    const c = ctx.chordAt(b);
    const nb = b + step;
    const changeNow = ctx.chordStartAt(b) || b === b0;
    const changeNext = nb >= b1 || ctx.chordStartAt(nb) || ctx.nextChange(b) < nb;
    const cn = ctx.chordAt(Math.min(ctx.nextChange(b), nb + 8));
    const tgt = closestPc(cn.bass ?? cn.root, last, lo, hi, center);
    let m;
    if (changeNow) {
      const colour = !two && b !== b0 && ctx.nextChange(b) - b >= 2 && r.chance(0.14);
      m = closestPc(colour ? c.root + r.pick([c.third, c.fifth ?? 7]) : c.bass ?? c.root, last, lo, hi, center);
      if (Math.abs(m - center) > 9) m += m > center ? -12 : 12;
    } else if (changeNext) {
      const x = r();
      if (x < 0.55) m = tgt + (last > tgt ? 1 : -1);
      else if (x < 0.75) m = tgt + 7 <= hi ? tgt + 7 : tgt - 5;
      else m = stepScale(c, tgt, last > tgt ? 1 : -1, 1, lo, hi);
    } else if (two) {
      m = closestPc(c.root + (c.fifth ?? 7), last, lo, hi, center);
    } else {
      const dir = Math.sign(tgt - last) || (r.chance(0.5) ? 1 : -1);
      m = r.chance(0.55) ? stepScale(c, last, dir, 1, lo, hi) : nearestIn(c, tonesOf(c), last, dir, lo, hi);
    }
    while (m < lo) m += 12;
    while (m > hi) m -= 12;
    if (m === last && !changeNow) m = stepScale(c, last, r.chance(0.5) ? 1 : -1, 1, lo, hi);
    const ghost = !two && r.chance(0.05 + 0.07 * seg.int);
    out.push({ b, len: step * (ghost ? 0.6 : 0.93), midi: m, vel: (0.78 + 0.1 * r()) * (P.vel ?? 1) });
    if (ghost) out.push({ b: b + 2 / 3, len: 0.25, midi: m, vel: 0.32, trip: true });
    if (two && r.chance(0.22)) {
      const pick = tgt + (m > tgt ? 1 : -1);
      out[out.length - 1].len = 1.4;
      out.push({ b: b + 1.5, len: 0.45, midi: changeNext ? pick : m, vel: 0.5 });
    }
    last = m;
  }
  P._last = last;
  return out;
}

function bossaBass(ctx, P, seg) {
  const [lo, hi] = P.range ?? [28, 50];
  const out = [];
  for (let b = seg.b0; b < seg.b1 - 0.01; b += 2) {
    const c = ctx.chordAt(b);
    const root = closestPc(c.bass ?? c.root, P._last ?? 38, lo, hi, 38);
    const fifth = root - 5 >= lo ? root - 5 : root + 7;
    out.push({ b, len: 1.4, midi: root, vel: 0.82 }, { b: b + 1.5, len: 0.45, midi: fifth, vel: 0.6 });
    P._last = root;
  }
  return out;
}

function patternBass(ctx, P, seg) {
  const [lo] = P.range ?? [33, 52];
  const pat = P.patterns?.[seg.part] ?? P.pattern;
  const place = (m) => {
    while (m < lo) m += 12;
    while (m >= lo + 12) m -= 12;
    return m;
  };
  const out = [];
  for (let bar = 0; bar < seg.nBars; bar++) {
    for (let step = 0; step < 16; step++) {
      const g = bar * 16 + step;
      const ch = pat[g % pat.length];
      if (!"ROFTA".includes(ch)) continue;
      let hold = 1;
      while (hold < 32 && pat[(g + hold) % pat.length] === "-") hold++;
      const b = seg.b0 + g / 4;
      if (b >= seg.b1 - 0.01) continue;
      const c = ctx.chordAt(b);
      const root = place(c.bass ?? c.root);
      let m = root;
      if (ch === "O") m = root + 12;
      else if (ch === "F") m = place(c.root + (c.fifth ?? 7));
      else if (ch === "T") m = place(c.root + c.third);
      else if (ch === "A") {
        const t = place(ctx.chordAt(b + hold / 4).root);
        m = t + (t > root ? -1 : 1);
      }
      out.push({ b, len: (hold / 4) * 0.9, midi: m, vel: (step % 4 === 0 ? 0.85 : 0.72) * (P.vel ?? 1) });
    }
  }
  return out;
}

// ---- Who plays what, part by part ------------------------------------------------------------

const playsIn = (P, seg) => (seg.part === "intro" || seg.part === "count" || seg.part === "groove" ? (seg.item.with ?? []).includes(P.name) : true);
const soloist = (seg) => (["solo", "trade", "bassSolo", "vamp", "tag"].includes(seg.part) ? seg.item.who : null);
function tradeWindows(ctx, seg, soloing) {
  const w = [];
  for (let k = 0; k < seg.nBars; k += 8) {
    const a = seg.b0 + k * ctx.M;
    w.push(soloing ? [a, Math.min(seg.b1, a + 4 * ctx.M)] : [a + 4 * ctx.M, Math.min(seg.b1, a + 8 * ctx.M)]);
  }
  return w.filter(([a, b]) => b > a);
}

function finalHold(ctx, P, seg, ivs, range, opts = {}) {
  const c = ctx.chordAt(seg.b0);
  const [lo, hi] = range;
  const len = seg.b1 - seg.b0 - (seg.item.cut ?? 0.6);
  return ivs.map((iv, k) => ({ b: seg.b0 + (opts.late ?? 0), len, midi: closestPc(c.root + iv, hi - 3 - k * 4, lo, hi), vel: opts.vel ?? 0.72, swell: true, vib: 1.2, dt: (opts.roll ?? 0) * k }));
}

function leadPart(ctx, P, seg) {
  const it = seg.item;
  const who = soloist(seg);
  const style = P.solo ?? ctx.song.soloStyle ?? "bebop";
  const blues = ctx.song.blues ? ctx.song.keyPc : undefined;
  if (seg.part === "head" && P.head !== false && (!it.lead || it.lead === P.name)) {
    if (ctx.song.head === "modal") return amenTop(ctx, P, seg, 0);
    return headNotes(ctx, P, seg);
  }
  if (seg.part === "intro" && playsIn(P, seg)) return articulate(ctx, P, improvise(ctx, P, seg.b0, seg.b1, { style: "lyrical", density: 0.35 }), "lyrical");
  if (who === P.name) {
    const windows = seg.part === "trade" ? tradeWindows(ctx, seg, true) : [[seg.b0, seg.b1]];
    const dens = seg.part === "tag" || seg.part === "vamp" ? 0.4 + 0.2 * seg.int : 0.42 + 0.55 * seg.int;
    return windows.flatMap(([a, b]) => articulate(ctx, P, improvise(ctx, P, a, b, { style, density: dens, blues }), style));
  }
  if (seg.part === "final" && P.final !== false) return finalHold(ctx, P, seg, [P.finalTone ?? 2], P.range, { vel: 0.7 });
  return [];
}

// The second horn: doubles or harmonises the head, solos when it's its turn.
function secondPart(ctx, P, seg) {
  const lead = ctx.players[P.with];
  if (seg.part === "head" && lead && P.head !== false) {
    if (ctx.song.head === "modal") return amenTop(ctx, P, seg, 1);
    return headNotes(ctx, lead, seg).map((n) => ({ ...n, midi: harmonyOf(ctx, n, P.harmony ?? "unison", P.range) }));
  }
  if (seg.part === "final") return finalHold(ctx, P, seg, [P.finalTone ?? 4], P.range, { vel: 0.66 });
  if (soloist(seg) === P.name) return leadPart(ctx, P, seg);
  return [];
}

function harmonyOf(ctx, n, how, [lo, hi]) {
  if (how === "unison") return n.midi;
  if (how === "octave") return n.midi - 12;
  const c = ctx.chordAt(n.b);
  const dist = how === "sixth" ? [8, 9, 7] : [3, 4, 5, 2];
  for (const d of dist) if (isTarget(c, n.midi - d) && n.midi - d >= lo) return n.midi - d;
  return clamp(stepScale(c, stepScale(c, n.midi, -1, 1, lo - 12, hi), -1, 1, lo - 12, hi), lo, hi);
}

// Modal head call-and-response ("So What"): the bass calls for a bar and a half, the band answers
// with two quartal chords, a step apart - "a-men".
function amenHits(ctx, seg) {
  const hits = [];
  for (let u = 0; u < seg.nBars; u += 4) {
    const b = seg.b0 + u * ctx.M;
    hits.push([b + ctx.M + 2.5, 0.8, 1], [b + ctx.M + 3.5, 2.2, 0]);
  }
  return hits.filter(([b]) => b < seg.b1);
}
function amenTop(ctx, P, seg, voiceIdx) {
  const [lo, hi] = P.range;
  return amenHits(ctx, seg).map(([b, len, k]) => {
    const v = quartalAt(ctx, ctx.chordAt(b + 0.5), k, 52);
    return { b, len, midi: clamp(v[v.length - 1 - voiceIdx] + 12 * (v[v.length - 1] + 12 <= hi ? 1 : 0), lo, hi), vel: 0.8, accent: 1.3 };
  });
}
function quartalAt(ctx, c, k, base) {
  const sc = scaleOf(c);
  const n = sc.length;
  const notes = [0, 3, 6, 9, 11].map((s) => c.root + 12 * Math.floor((k + 1 + s) / n) + sc[(k + 1 + s) % n]);
  const shift = Math.round((base - notes[0]) / 12) * 12;
  return notes.map((m) => m + shift);
}
function modalBassCall(ctx, P, seg) {
  P._call ??= (() => {
    const r = rng(hashSeed(`${ctx.song.id}:call`));
    const c = ctx.chordAt(seg.b0);
    const [lo, hi] = [33, 52];
    let q = closestPc(c.root, 40, lo, hi);
    const rh = [[0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 0.5], [2.5, 1], [3.5, 0.5], [4, 0.5], [4.5, 0.5], [5, 1]];
    return rh.map(([o, len], i) => {
      if (i > 0) q = stepScale(c, q, i < 5 ? 1 : r.chance(0.5) ? 1 : -1, r.chance(0.3) ? 2 : 1, lo, hi);
      return { o, len, iv: q - c.root, vel: 0.85 };
    });
  })();
  const out = [];
  for (let u = 0; u < seg.nBars; u += 4) {
    const b = seg.b0 + u * ctx.M;
    const c = ctx.chordAt(b);
    for (const n of P._call) out.push({ b: b + n.o, len: n.len * 0.9, midi: c.root + n.iv, vel: n.vel });
    for (const k of [2, 3]) if (u + k < seg.nBars) out.push({ b: b + k * ctx.M, len: ctx.M * 0.9, midi: closestPc(c.root, 36, 28, 45), vel: 0.75 });
  }
  return out;
}

function bassPart(ctx, P, seg) {
  if (!playsIn(P, seg)) return [];
  const it = seg.item;
  if (soloist(seg) === P.name && (seg.part === "bassSolo" || seg.part === "solo")) {
    return articulate(ctx, P, improvise(ctx, P, seg.b0, seg.b1, { style: "bass", density: 0.55 + 0.3 * seg.int, range: P.soloRange ?? [33, 58] }), "bass");
  }
  if (seg.part === "final") {
    const c = ctx.chordAt(seg.b0);
    return [{ b: seg.b0, len: seg.b1 - seg.b0 - (it.cut ?? 0.6), midi: closestPc(c.root, P.range[0] + 3, P.range[0], P.range[0] + 12), vel: 0.95 }];
  }
  if (seg.part === "head" && ctx.song.head === "modal" && P.call !== false) return modalBassCall(ctx, P, seg);
  const feel = it.bass ?? P.feels?.[seg.part] ?? P.feel ?? "walk";
  if (seg.part === "trade") return tradeWindows(ctx, seg, true).flatMap(([a, b]) => walk(ctx, P, seg, a, b));
  if (feel === "walk") return walk(ctx, P, seg, seg.b0, seg.b1);
  if (feel === "two") return walk(ctx, P, seg, seg.b0, seg.b1, true);
  if (feel === "bossa") return bossaBass(ctx, P, seg);
  if (feel === "pattern") return patternBass(ctx, P, seg);
  if (feel === "pedal") return Array.from({ length: seg.nBars }, (_, k) => ({ b: seg.b0 + k * ctx.M, len: ctx.M * 0.95, midi: closestPc(ctx.chordAt(seg.b0).root, 36, 28, 45), vel: 0.8 }));
  return [];
}

function compPart(ctx, P, seg) {
  if (!playsIn(P, seg)) return [];
  const it = seg.item;
  const out = [];
  const range = P.range ?? [50, 70];
  const soloing = soloist(seg) === P.name && seg.part !== "tag";
  const leading = (seg.part === "head" && (it.lead ?? ctx.song.headBy) === P.name) || (seg.part === "tag" && it.who === P.name);
  if (seg.part === "final") {
    const c = ctx.chordAt(seg.b0);
    const len = seg.b1 - seg.b0 - (it.cut ?? 0.6);
    const low = [closestPc(c.root, 38, 33, 45), closestPc(c.root + (c.fifth ?? 7), 45, 40, 52)];
    const mid = voice(rootlessOf(c), P._v, range[0], range[1]);
    const top = P.finalTop !== false ? voice(rootlessOf(c), null, range[1] - 2, range[1] + 14) : [];
    const all = P.lowEnd === false ? [...mid, ...top] : [...low, ...mid, ...top];
    pushChord(out, all, seg.b0, len, 0.62, { roll: P.comp === "bossa" || P.comp === "pompe" ? 0.012 : 0.03, rand: P.r, accentTop: 0.1 });
    return out;
  }
  if (soloing || leading) {
    const style = leading ? P.headStyle ?? ctx.song.head ?? "lyrical" : P.solo ?? ctx.song.soloStyle ?? "bebop";
    const windows = seg.part === "trade" ? tradeWindows(ctx, seg, true) : [[seg.b0, seg.b1]];
    for (const [a, b] of windows) {
      if (leading && seg.part === "head") {
        out.push(...headNotes(ctx, P, seg));
        continue;
      }
      const line = improvise(ctx, P, a, b, { style, density: 0.42 + 0.55 * seg.int, range: P.soloRange, blues: ctx.song.blues ? ctx.song.keyPc : undefined });
      out.push(...articulate(ctx, { ...P, range: P.soloRange ?? P.range }, line, style));
    }
    if (P.leftHand !== false) {
      const lh = [];
      compCells(ctx, { ...P, _v: P._lh }, seg, lh, { lo: P.lhRange?.[0] ?? 46, hi: P.lhRange?.[1] ?? 62, pcsOf: (c) => [mod12(c.root + c.third), mod12(c.root + seventhOf(c)), ...(P.r.chance(0.5) ? [mod12(c.root + 2)] : [])], sparse: 1.8, velBase: 0.36 });
      out.push(...lh);
    }
    return out;
  }
  if (seg.part === "head" && ctx.song.head === "modal") {
    for (const [b, len, k] of amenHits(ctx, seg)) pushChord(out, quartalAt(ctx, ctx.chordAt(b + 0.5), k, range[0] + 2), b, len, 0.66, { rand: P.r, accentTop: 0.08 });
    return out;
  }
  const sparse = seg.part === "bassSolo" ? 2.4 : seg.part === "trade" ? 1 : soloist(seg) && !["bassSolo"].includes(seg.part) ? 1 : 1.25;
  const style = P.comps?.[seg.part] ?? P.comp ?? "swing";
  const lo = range[0];
  const hi = range[1];
  if (seg.part === "trade") {
    for (const [a, b] of tradeWindows(ctx, seg, true)) {
      const sub = { ...seg, b0: a, b1: b, nBars: (b - a) / ctx.M };
      compCells(ctx, P, sub, out, { lo, hi });
    }
    return out;
  }
  if (style === "swing") compCells(ctx, P, seg, out, { lo, hi, sparse });
  else if (style === "organ") compCells(ctx, P, seg, out, { lo, hi, sparse, hold: 1.4, velBase: 0.55 });
  else if (style === "quartal") compCells(ctx, P, seg, out, { lo, hi, sparse, quartal: true });
  else if (style === "ballad") compBallad(ctx, P, seg, out, { lo, hi });
  else if (style === "bossa") compBossa(ctx, P, seg, out, { lo, hi });
  else if (style === "pompe") compPompe(ctx, P, seg, out, { lo, hi });
  else if (style === "four") compFour(ctx, P, seg, out, { lo, hi });
  else if (style === "pattern") compPattern(ctx, P, seg, out, { lo, hi });
  else if (style === "sustain") {
    for (let b = seg.b0; b < seg.b1 - 0.01; ) {
      const end = Math.min(ctx.nextChange(b), seg.b1);
      P._v = voice(rootlessOf(ctx.chordAt(b)), P._v, lo, hi);
      pushChord(out, P._v, b, end - b + 0.05, 0.6, { rand: P.r, accentTop: 0 });
      b = end;
    }
  }
  return out;
}

// Big-band sections: saxes or brass as one player with several voices (top to bottom). They play
// the head as a harmonised soli, backgrounds behind later solo choruses, the shout chorus (drop-2
// block voicing), punches, and the final chord.
function blockVoices(ctx, top, b, nv, drop2) {
  const c = ctx.chordAt(b);
  const pcs = new Set(rootlessOf(c));
  const v = [top];
  let m = top;
  while (v.length < Math.min(nv, 4)) {
    m--;
    let guard = 0;
    while ((!pcs.has(mod12(m)) || mod12(m) === mod12(top)) && guard++ < 12) m--;
    v.push(m);
  }
  if (drop2 && v.length >= 4) {
    v[1] -= 12;
    v.sort((a, b2) => b2 - a);
  }
  if (nv >= 5) v.push(top - 12);
  return v;
}

function shoutLine(ctx, P, seg) {
  P._shout ??= new Map();
  if (!P._shout.has(seg.label)) {
    const r = rng(hashSeed(`${ctx.song.id}:shout:${seg.label}`));
    const [lo, hi] = P.shoutRange ?? [70, 84];
    const line = [];
    const U = 2 * ctx.M;
    const riff = headRhythm(r, ctx.M, "swing", "busy");
    const ending = headRhythm(r, ctx.M, "swing", "cadence");
    let q = hi - 4;
    for (let u = 0; u < seg.nBars / 2; u++) {
      const R = u === seg.nBars / 2 - 1 ? ending : riff;
      R.forEach((h, i) => {
        const b = seg.b0 + u * U + h.o;
        const c = ctx.chordAt(b);
        q = i === 0 ? nearestIn(c, targetsOf(c), hi - 3 - (u % 2) * 2, 0, lo, hi) : nearestIn(c, targetsOf(c), q + r.pick([-3, -2, 2, 3, -4]), 0, lo, hi);
        line.push({ b: b - seg.b0, len: Math.min(h.len, 1.5), midi: q, vel: 0.9, accent: h.o % 1 ? 1.4 : 1.1 });
      });
    }
    P._shout.set(seg.label, line);
  }
  return P._shout.get(seg.label).map((n) => ({ ...n, b: n.b + seg.b0 }));
}

function sectionPart(ctx, P, seg) {
  if (!playsIn(P, seg)) return [];
  const nv = P.voices.length;
  const out = [];
  const add = (line, drop2, transpose = 0) => {
    for (const n of line) blockVoices(ctx, n.midi + transpose, n.b, nv, drop2).forEach((m, k) => out.push({ ...n, midi: m, voice: k, vel: (n.vel ?? 0.8) * (k === 0 ? 1 : 0.88) }));
  };
  const plays = P.plays ?? {};
  if (seg.part === "head" && plays.head === "soli") add(headNotes(ctx, P, seg), false);
  else if (seg.part === "head" && plays.head === "punches") punches(ctx, P, seg, out, nv);
  else if (seg.part === "shout" && plays.shout) {
    const line = articulate(ctx, P, shoutLine(ctx, ctx.players[plays.shout === true ? P.name : plays.shout], seg), "bebop");
    add(line, true, P.shoutTranspose ?? 0);
    if (P.name === (ctx.song.shoutLead ?? P.name)) ctx.hits.push(...line.filter((n) => n.accent > 1.2 || n.len >= 1).map((n) => [n.b, n.len]));
  } else if (seg.part === "solo" && plays.backgrounds && seg.pass >= (plays.backgroundsFrom ?? 1)) {
    if (plays.backgrounds === "pads") {
      for (let b = seg.b0; b < seg.b1 - 0.01; ) {
        const end = Math.min(ctx.nextChange(b), seg.b1);
        const v = voice(rootlessOf(ctx.chordAt(b)), P._v, P.padRange[0], P.padRange[1]);
        P._v = v;
        [...v].reverse().forEach((m, k) => k < nv && out.push({ b, len: end - b - 0.15, midi: m, voice: k, vel: 0.42, swell: true, vib: 0.5, legato: true }));
        if (nv >= 5) out.push({ b, len: end - b - 0.15, midi: closestPc(ctx.chordAt(b).root, 40, 34, 46), voice: nv - 1, vel: 0.45, swell: true, legato: true });
        b = end;
      }
    } else punches(ctx, P, seg, out, nv);
  } else if (seg.part === "final" && plays.final !== false) {
    const c = ctx.chordAt(seg.b0);
    const top = closestPc(c.root + (P.finalTone ?? 2), P.range[1] - 2, P.range[0], P.range[1]);
    blockVoices(ctx, top, seg.b0, nv, true).forEach((m, k) => out.push({ b: seg.b0, len: seg.b1 - seg.b0 - (seg.item.cut ?? 0.6), midi: m, voice: k, vel: 0.75, swell: true, vib: 1.1 }));
  }
  return out;
}

// Basie-style punches: short drop-2 stabs on the "and" of 4 into a new chord, now and then.
function punches(ctx, P, seg, out, nv) {
  const r = P.r;
  for (let bar = 1; bar < seg.nBars; bar += 2) {
    if (!r.chance(0.55)) continue;
    const b = seg.b0 + bar * ctx.M + r.pick([1.5, ctx.M - 0.5, ctx.M - 0.5]);
    if (b >= seg.b1 - 0.5) continue;
    const c = ctx.chordAt(b + 0.5);
    const top = nearestIn(c, targetsOf(c), P.range[1] - 4, 0, P.range[0], P.range[1]);
    blockVoices(ctx, top, b + 0.5, nv, true).forEach((m, k) => out.push({ b, len: 0.42, midi: m, voice: k, vel: 0.82, accent: 1.4 }));
    ctx.hits.push([b, 0.4]);
  }
}

function padPart(ctx, P, seg) {
  if (!playsIn(P, seg) || !(P.in ?? []).includes(seg.part)) return [];
  const out = [];
  for (let b = seg.b0; b < seg.b1 - 0.01; ) {
    const end = Math.min(ctx.nextChange(b), seg.b1);
    P._v = voice(rootlessOf(ctx.chordAt(b)), P._v, P.range[0], P.range[1]);
    P._v.forEach((m) => out.push({ b, len: end - b + 0.1, midi: m, vel: 0.6 }));
    b = end;
  }
  return out;
}

// ---- Drums -----------------------------------------------------------------------------------

function drumsFor(ctx, D, seg) {
  const it = seg.item;
  if (seg.part === "count") return countOff(ctx, seg);
  if (!playsIn(D, seg) && (seg.part === "intro" || seg.part === "groove")) return [];
  const style = it.drums ?? D.styles?.[seg.part] ?? D.style;
  if (style === "none") return [];
  const ev = [];
  const r = D.r;
  const M = ctx.M;
  if (seg.part === "final") return finalRoll(ctx, seg, ev);
  const prev = ctx.segs[ctx.segs.indexOf(seg) - 1];
  const sectionStart = prev && prev.part !== "count" && (prev.part !== seg.part || seg.idx === 0 || seg.part === "shout") && seg.int > 0.42;
  if (sectionStart && style !== "hop") ev.push({ piece: style === "brushes" ? "brushTap" : "crash", b: seg.b0, vel: 0.55 + 0.35 * seg.int }, { piece: "kick", b: seg.b0, vel: 0.5 + 0.3 * seg.int });
  const drumWin = seg.part === "trade" ? tradeWindows(ctx, seg, false) : [];
  for (let bar = 0; bar < seg.nBars; bar++) {
    const b0 = seg.b0 + bar * M;
    if (drumWin.some(([a, b]) => b0 >= a - 0.01 && b0 < b - 0.01)) {
      drumSolo(ctx, D, ev, b0, bar % 4, seg);
      continue;
    }
    const nextSeg = ctx.segs[ctx.segs.indexOf(seg) + 1];
    const phraseEnd = bar === seg.nBars - 1 || (bar + 1) % 8 === 0;
    const fill = phraseEnd && (seg.part !== "intro" || bar === seg.nBars - 1) && nextSeg && nextSeg.part !== "count" ? (bar === seg.nBars - 1 ? 0.5 + seg.int * 0.6 : 0.25 + seg.int * 0.3) : 0;
    const fillFrom = fill ? M - (r.chance(fill) ? 2 : 1) : M;
    if (style === "swing" || style === "hat") swingBar(ctx, D, ev, b0, seg, fillFrom, style === "hat");
    else if (style === "brushes") brushBar(ctx, D, ev, b0, seg);
    else if (style === "bossa") bossaBar(ctx, D, ev, b0, seg, bar, fillFrom);
    else if (style === "shuffle") shuffleBar(ctx, D, ev, b0, seg, fillFrom);
    else if (style === "hop" || style === "smooth") patternBar(ctx, D, ev, b0, seg, bar, style, fillFrom);
    if (fill && fillFrom < M) drumFill(ctx, D, ev, b0 + fillFrom, M - fillFrom, seg, style);
  }
  // The drummer catches the big-band hits.
  for (const [b, len] of ctx.hits.filter(([b]) => b >= seg.b0 && b < seg.b1)) {
    ev.push({ piece: "snare", b, vel: 0.62 }, { piece: "kick", b, vel: 0.72 });
    if (len >= 1) ev.push({ piece: "crash", b, vel: 0.6 });
  }
  return ev;
}

function swingBar(ctx, D, ev, b0, seg, fillFrom, hat) {
  const r = D.r;
  const M = ctx.M;
  const int = seg.int;
  const cym = hat ? "hatStick" : "ride";
  const pattern = M === 3 ? [[0, 0.8], [1, 0.6], [1 + 2 / 3, 0.45, true], [2, 0.7]] : [[0, 0.72], [1, 0.86], [1 + 2 / 3, 0.5, true], [2, 0.72], [3, 0.86], [3 + 2 / 3, 0.5, true]];
  for (const [pos, v, skip] of pattern) {
    if (pos >= fillFrom) continue;
    if (skip && r.chance(0.07)) continue;
    ev.push({ piece: cym, b: b0 + pos, trip: true, vel: v * (0.72 + 0.38 * int) * r.range(0.9, 1.08), v: r() });
  }
  if (M === 4 && fillFrom > 1 && r.chance(0.04 + 0.1 * int)) ev.push({ piece: cym, b: b0 + 2 / 3, trip: true, vel: 0.4, v: r() });
  for (const pos of M === 3 ? [1] : [1, 3]) ev.push({ piece: "hatFoot", b: b0 + pos, vel: (hat ? 0.4 : 0.72) * r.range(0.9, 1.1) });
  for (let k = 0; k < M; k++) ev.push({ piece: "kick", b: b0 + k, vel: 0.15 * r.range(0.8, 1.2) });
  for (let k = 0; k < Math.min(M, fillFrom); k++) {
    for (const sub of [1 / 3, 2 / 3]) {
      const p = (sub > 0.5 ? 0.07 : 0.025) + 0.2 * int * int;
      if (!r.chance(p)) continue;
      const bomb = r.chance(0.05 * int);
      ev.push({ piece: "snare", b: b0 + k + sub, trip: true, vel: bomb ? 0.7 : r.range(0.14, 0.36) + 0.12 * int });
      if (bomb) ev.push({ piece: "kick", b: b0 + k + sub, trip: true, vel: 0.65 });
    }
  }
}

function brushBar(ctx, D, ev, b0, seg) {
  const r = D.r;
  const M = ctx.M;
  for (let k = 0; k < M; k++) ev.push({ piece: "sweep", b: b0 + k, len: 1, vel: 0.5 + 0.15 * r(), trip: true });
  for (const pos of M === 3 ? [1, 2] : [1, 3]) {
    ev.push({ piece: "brushTap", b: b0 + pos, vel: (0.5 + 0.2 * seg.int) * r.range(0.9, 1.1), trip: true });
    if (ctx.song.bpm > 90 && r.chance(0.6)) ev.push({ piece: "brushTap", b: b0 + pos - 1 / 3, vel: 0.22, trip: true });
    ev.push({ piece: "hatFoot", b: b0 + pos, vel: 0.42 });
  }
  for (const pos of M === 3 ? [0] : [0, 2]) ev.push({ piece: "kick", b: b0 + pos, vel: 0.13 });
}

function bossaBar(ctx, D, ev, b0, seg, bar, fillFrom) {
  const r = D.r;
  const clave = bar % 2 === 0 ? [0, 1.5, 3] : [1, 2.5];
  for (const pos of clave) if (pos < fillFrom) ev.push({ piece: "cross", b: b0 + pos, vel: 0.62 * r.range(0.9, 1.08) });
  const ride = seg.int > 0.62;
  for (let k = 0; k < 8; k++) {
    if (k / 2 >= fillFrom) continue;
    ev.push({ piece: ride ? "ride" : "hatStick", b: b0 + k / 2, vel: (k % 2 ? 0.34 : 0.46) * r.range(0.88, 1.1) * (ride ? 0.8 : 1), v: r() });
    if (D.shaker) ev.push({ piece: "shaker", b: b0 + k / 2, vel: k % 2 ? 0.45 : 0.3 });
  }
  [[0, 0.6], [1.5, 0.35], [2, 0.5], [3.5, 0.35]].forEach(([pos, v]) => ev.push({ piece: "kick", b: b0 + pos, vel: v }));
}

function shuffleBar(ctx, D, ev, b0, seg, fillFrom) {
  const r = D.r;
  const int = seg.int;
  for (let k = 0; k < 4; k++) {
    if (k >= fillFrom) continue;
    ev.push({ piece: int > 0.6 ? "ride" : "hatStick", b: b0 + k, trip: true, vel: 0.72 * r.range(0.9, 1.08), v: r() });
    ev.push({ piece: int > 0.6 ? "ride" : "hatStick", b: b0 + k + 2 / 3, trip: true, vel: 0.46 * r.range(0.9, 1.1), v: r() });
    if (k % 2 === 1) ev.push({ piece: "snare", b: b0 + k, vel: 0.82 * r.range(0.95, 1.05) });
    else if (r.chance(0.35)) ev.push({ piece: "snare", b: b0 + k + 2 / 3, trip: true, vel: 0.2 });
  }
  if (int > 0.6) for (const pos of [1, 3]) ev.push({ piece: "hatFoot", b: b0 + pos, vel: 0.6 });
  ev.push({ piece: "kick", b: b0, vel: 0.8 }, { piece: "kick", b: b0 + 2, vel: 0.62 });
  if (r.chance(0.45)) ev.push({ piece: "kick", b: b0 + 1 + 2 / 3, trip: true, vel: 0.5 });
  if (r.chance(0.25) && fillFrom > 3) ev.push({ piece: "kick", b: b0 + 3 + 2 / 3, trip: true, vel: 0.42 });
}

const HOP = {
  hop: [{ kick: "X......x..X.....", snare: "....X.......X...", hat: "x.x.x.x.x.x.x.xo", rim: "..........o....." }, { kick: "X.........X..x..", snare: "....X.......X..o", hat: "x.x.x.xox.x.x.x." }],
  smooth: [{ kick: "X.....x.X.x.....", snare: "....X.......X...", hat: "xoxoxoxoxoxoxoxo" }, { kick: "X.....x.X...x...", snare: "....X.......X.o.", hat: "xoxoxoxoxoxoxoxo", openHat: "..............x." }],
};
const HVEL = { X: 1, x: 0.72, o: 0.4 };
function patternBar(ctx, D, ev, b0, seg, bar, style, fillFrom) {
  const r = D.r;
  const g = HOP[style][bar % 4 === 3 ? 1 : 0];
  for (const [piece, pat] of Object.entries(g)) {
    for (let s = 0; s < 16; s++) {
      const v = HVEL[pat[s]];
      if (!v || s / 4 >= fillFrom) continue;
      ev.push({ piece, b: b0 + s / 4, vel: v * r.range(0.9, 1.06) * (piece === "hat" && seg.int < 0.4 ? 0.7 : 1) });
    }
  }
}

function drumFill(ctx, D, ev, b, beats, seg, style) {
  const r = D.r;
  const soft = style === "brushes" || style === "bossa" || style === "hop";
  const n = Math.round(beats * 3);
  const toms = r.chance(0.6) && !soft;
  for (let k = 0; k < n; k++) {
    if (r.chance(soft ? 0.45 : 0.12)) continue;
    const u = k / Math.max(1, n - 1);
    const piece = soft ? (style === "bossa" ? "cross" : style === "hop" ? "snare" : "brushTap") : toms && u > 0.4 ? "toms" : "snare";
    ev.push({ piece, b: b + k / 3, trip: style !== "hop", vel: (soft ? 0.35 : 0.42) + 0.45 * u * seg.int, tom: Math.min(2, Math.floor(u * 3)) });
    if (!soft && r.chance(0.25)) ev.push({ piece: "kick", b: b + k / 3, trip: true, vel: 0.45 });
  }
}

function drumSolo(ctx, D, ev, b0, barOfFour, seg) {
  const r = D.r;
  const M = ctx.M;
  const build = 0.5 + 0.15 * barOfFour;
  for (let k = 0; k < M * 3; k++) {
    const pos = k / 3;
    if (Math.abs(pos - 1) < 0.01 || Math.abs(pos - 3) < 0.01) ev.push({ piece: "hatFoot", b: b0 + pos, vel: 0.65 });
    if (!r.chance(0.55 + 0.1 * barOfFour)) continue;
    const piece = weighted(r, ["snare", "toms", "kick", "crash", "ride"], (p) => ({ snare: 4.5, toms: 3, kick: 1.5, crash: pos === 0 ? 0.6 : 0.08, ride: 0.4 })[p]);
    ev.push({ piece, b: b0 + pos, trip: true, vel: clamp(r.range(0.35, 0.85) * build + (pos % 1 ? 0 : 0.1), 0.2, 1), tom: Math.floor(r() * 3), v: r() });
  }
}

function countOff(ctx, seg) {
  const M = ctx.M;
  const beats = M === 3 ? [0, 2, 3, 4, 5] : [0, 2, 4, 5, 6, 7];
  return beats.filter((b) => b < seg.b1 - seg.b0).map((b) => ({ piece: "hatStick", b: seg.b0 + b, vel: 0.5 }));
}

function finalRoll(ctx, seg, ev) {
  const len = seg.b1 - seg.b0 - (seg.item.cut ?? 0.6);
  ev.push({ piece: "crash", b: seg.b0, vel: 0.9 }, { piece: "kick", b: seg.b0, vel: 0.85 });
  const n = Math.floor(len * 6);
  for (let k = 3; k < n; k++) {
    const u = k / n;
    ev.push({ piece: "ride", b: seg.b0 + k / 6, trip: true, vel: 0.08 + 0.3 * u ** 1.5, v: (k * 0.37) % 1 });
  }
  return ev;
}

// ---- The room: crowd, applause, Leslie -------------------------------------------------------

const VOWELS = [[730, 1090], [530, 1840], [270, 2290], [570, 840], [300, 870], [660, 1720], [440, 1020], [490, 1350]];

// Club murmur: a dozen distant talkers (buzz through moving vowel formants, in syllables and
// pauses), with glasses clinking now and then.
export function crowd(seconds, { seed = 5, talkers = 14, clinks = 1, level = 1 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Stereo(n);
  const r = rng(seed);
  for (let k = 0; k < talkers; k++) {
    const [gl, gr] = panGains(r.range(-0.85, 0.85));
    const high = r.chance(0.5);
    const f0 = high ? r.range(175, 235) : r.range(95, 135);
    const dist = r.range(0.35, 1);
    const f1 = new Biquad("bandpass", 600, 4);
    const f2 = new Biquad("bandpass", 1500, 5);
    const lp = new Biquad("lowpass", 1800 + 1700 * dist);
    const hp = new Biquad("highpass", 3000);
    let ph = r();
    let syl = 0;
    let sylLen = 1;
    let speaking = r.chance(0.6);
    let left = r.range(0.2, 3) * SR;
    let tF1 = 600;
    let tF2 = 1500;
    let cF1 = 600;
    let cF2 = 1500;
    let pitch = f0;
    let pT = f0;
    let amp = 0;
    for (let i = 0; i < n; i++) {
      if (--left <= 0) {
        speaking = !speaking;
        left = (speaking ? r.range(0.8, 4.5) : r.range(0.3, 2.5)) * SR;
      }
      if (--syl <= 0) {
        sylLen = r.range(0.1, 0.26) * SR;
        syl = sylLen;
        const v = r.pick(VOWELS);
        tF1 = v[0] * (high ? 1.15 : 1);
        tF2 = v[1] * (high ? 1.12 : 1);
        amp = speaking ? r.range(0.35, 1) : 0;
        pT = f0 * r.range(0.85, 1.28);
      }
      const u = 1 - syl / sylLen;
      cF1 += (tF1 - cF1) * 0.002;
      cF2 += (tF2 - cF2) * 0.002;
      if ((i & 63) === 0) {
        f1.set(cF1);
        f2.set(cF2);
      }
      pitch += (pT - pitch) * 0.0006;
      ph += pitch / SR;
      if (ph >= 1) ph -= 1;
      if (amp === 0) continue;
      const env = Math.sin(Math.PI * u) ** 0.8 * amp;
      const x = (2 * ph - 1) * 0.6 + r.bi() * 0.18;
      const cons = u < 0.12 ? hp.process(r.bi()) * 0.25 : 0;
      const v = (lp.process(f1.process(x) + f2.process(x) * 0.6) + cons) * env * dist * 0.15 * level;
      out.L[i] += v * gl;
      out.R[i] += v * gr;
    }
  }
  let t = r.range(0.5, 3);
  while (t < seconds - 1) {
    clink(out, t, r, level);
    t += r.range(1.5, 6) / clinks;
  }
  return out;
}

export function clink(out, t, r, gain = 1) {
  const start = Math.round(t * SR);
  const f = r.range(2300, 3300);
  const [gl, gr] = panGains(r.range(-0.8, 0.8));
  const parts = [[f, 0.5, 0.45], [f * 2.71, 0.3, 0.25], [f * 5.13, 0.15, 0.12]];
  const g = r.range(0.04, 0.12) * gain;
  const n = Math.round(0.8 * SR);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const tt = i / SR;
    let s = 0;
    for (const [fr, a, d] of parts) s += Math.sin(TAU * fr * tt) * a * Math.exp(-tt / d);
    const v = s * g * Math.min(1, tt / 0.0005);
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}

function clapSample(r) {
  const out = new Float32Array(Math.round(0.07 * SR));
  const bp = new Biquad("bandpass", r.range(900, 2400), 1.2);
  const lo = new Biquad("lowpass", 700);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const n = r.bi();
    out[i] = (bp.process(n) * 1.6 + lo.process(n) * 0.3) * Math.min(1, t / 0.0006) * Math.exp(-t / 0.009);
  }
  return out;
}

// Club applause: each person clapping at their own rate and pitch, swelling in and thinning out,
// with a whistle or two when it's a big one.
export function applause(seconds, { seed = 9, people = 28, swell = 0.5, fade = 1.6, whistles = 0, level = 1 } = {}) {
  const out = new Stereo(Math.round(seconds * SR));
  const r = rng(seed);
  const claps = Array.from({ length: 12 }, () => clapSample(r));
  for (let p = 0; p < people; p++) {
    const rate = r.range(3.3, 5.6);
    const pan = r.range(-0.9, 0.9);
    const g = r.range(0.35, 1) * level;
    const stopAt = seconds - fade * r.range(0.2, 1.4);
    let t = r.range(0, swell);
    while (t < stopAt) {
      const env = Math.min(1, t / Math.max(0.05, swell)) * (t > seconds - fade ? (seconds - t) / fade : 1);
      placeMono(out, r.pick(claps), t, g * env * r.range(0.7, 1.1), pan);
      t += (1 / rate) * r.range(0.85, 1.15);
    }
  }
  for (let w = 0; w < whistles; w++) {
    const t0 = r.range(0.3, seconds * 0.5);
    const len = r.range(0.5, 1.1);
    const f0 = r.range(2100, 2900);
    const [gl, gr] = panGains(r.range(-0.6, 0.6));
    const start = Math.round(t0 * SR);
    let ph = 0;
    for (let i = 0; i < len * SR && start + i < out.length; i++) {
      const u = i / (len * SR);
      ph += (f0 * (1 + 0.18 * Math.sin(Math.PI * u) + 0.012 * Math.sin(TAU * 7 * u * len))) / SR;
      const v = Math.sin(TAU * ph) * Math.sin(Math.PI * u) ** 0.6 * 0.12 * level;
      out.L[start + i] += v * gl;
      out.R[start + i] += v * gr;
    }
  }
  return out;
}

// Rotating speaker: tube drive, then a crossover - the horn (doppler + amplitude, spun fast) and
// the drum (slower, heavier) - with real inertia when the speed changes.
export function leslie(buf, { rate = () => 0.8, drive = 1.8, depth = 0.00042 } = {}) {
  const n = buf.length;
  const lp = new Biquad("lowpass", 800);
  const hp = new Biquad("highpass", 800);
  const size = 2048;
  const mask = size - 1;
  const line = new Float32Array(size);
  const norm = Math.tanh(drive);
  let w = 0;
  let phH = 0;
  let phL = 0;
  let rH = rate(0);
  let rL = rH * 0.85;
  const read = (tap) => {
    const pos = w - tap;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    return line[i0 & mask] * (1 - f) + line[(i0 + 1) & mask] * f;
  };
  for (let i = 0; i < n; i++) {
    if ((i & 63) === 0) {
      const target = rate(i / SR);
      rH += (target - rH) * (64 / (SR * 0.7));
      rL += (target * 0.85 - rL) * (64 / (SR * 2.2));
    }
    const x = Math.tanh((buf.L[i] + buf.R[i]) * 0.5 * drive) / norm;
    const lo = lp.process(x);
    line[w] = hp.process(x);
    phH += (TAU * rH) / SR;
    phL += (TAU * rL) / SR;
    const sH = Math.sin(phH);
    const cH = Math.cos(phH);
    const hL = read((0.0012 + depth * sH) * SR) * (1 + 0.42 * sH);
    const hR = read((0.0012 + depth * cH) * SR) * (1 + 0.42 * cH);
    buf.L[i] = hL * 0.8 + lo * (1 + 0.16 * Math.sin(phL));
    buf.R[i] = hR * 0.8 + lo * (1 + 0.16 * Math.cos(phL));
    w = (w + 1) & mask;
  }
  return buf;
}

// ---- Rendering -------------------------------------------------------------------------------

const ROLE_TARGET = { lead: -17.5, second: -20.5, section: -19, bass: -16.5, comp: -19.5, pad: -25 };
const ROLE_HP = { lead: 90, second: 90, section: 70, bass: 35, comp: 60, pad: 150 };
const ROLE_FEEL = { lead: 0.014, second: 0.017, section: 0.008, bass: 0, comp: 0.005, pad: 0.01 };
const ROLE_SEND = { lead: 0.22, second: 0.22, section: 0.24, bass: 0.04, comp: 0.16, pad: 0.35 };
// Kit pieces: level at full velocity (dB, from a peak-normalised sample), pan, reverb send.
const PIECE = {
  ride: [-8, 0.35, 0.1], rideBell: [-10, 0.35, 0.1], crash: [-9, -0.32, 0.16], hatFoot: [-15, -0.3, 0.06], hatStick: [-12, -0.3, 0.07], snare: [-7, -0.06, 0.18], cross: [-8, -0.06, 0.15],
  brushTap: [-8, -0.06, 0.16], kick: [-3.5, 0, 0.05], toms: [-5, 0, 0.2], shaker: [-15, 0.4, 0.08], hat: [-14, -0.25, 0.05], openHat: [-15, -0.25, 0.08], rim: [-10, -0.06, 0.15], clap: [-8, 0, 0.18],
};
const TOM_PAN = [-0.25, 0.05, 0.3];

function samplesFor(D) {
  if (D._s) return D._s;
  const src = D.kit === "jazz" || !D.kit ? J.jazzKit() : { ...J.jazzKit(), ...kit(D.kit) };
  const norm = (a) => {
    let p = 0;
    for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
    const s = p > 0 ? 1 / p : 1;
    const o = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = a[i] * s;
    return o;
  };
  D._s = {};
  for (const [k, v] of Object.entries(src)) D._s[k] = Array.isArray(v) ? v.map(norm) : v instanceof Float32Array ? norm(v) : v;
  D._s.shaker = norm(kit("acoustic").shaker);
  return D._s;
}

function renderDrums(ctx, D, events, length) {
  const S = samplesFor(D);
  const bus = new Stereo(length);
  const send = new Stereo(length);
  const sweepBus = new Stereo(length);
  const h = rng(hashSeed(`${ctx.song.id}:drum-humanise`));
  for (const e of events) {
    const t = Math.max(0, ctx.time(e.b, e.trip) + (e.piece === "ride" ? -0.004 : 0) + h.bi() * 0.0035);
    if (e.piece === "sweep") {
      J.sweep(sweepBus, { t, dur: ctx.time(e.b + e.len, true) - ctx.time(e.b, true), vel: e.vel, pan: -0.05 });
      continue;
    }
    let s = S[e.piece];
    if (!s) continue;
    if (Array.isArray(s)) s = e.piece === "toms" ? s[e.tom ?? 0] : s[Math.floor((e.v ?? 0) * s.length) % s.length];
    const [db, pan, rev] = PIECE[e.piece] ?? [-10, 0, 0.1];
    const g = dbToGain(db + (D.levels?.[e.piece] ?? 0)) * e.vel;
    const p = e.piece === "toms" ? TOM_PAN[e.tom ?? 0] : pan;
    placeMono(bus, s, t, g, p);
    placeMono(send, s, t, g * rev, p);
  }
  return { bus, send, sweepBus };
}

function renderPlayer(ctx, P, notes, length) {
  const bus = new Stereo(length);
  const play = INST[P.inst];
  if (!play) throw new Error(`Unknown instrument ${P.inst}`);
  const h = rng(hashSeed(`${ctx.song.id}:${P.name}:humanise`));
  const feel = (P.feel ?? ROLE_FEEL[P.role] ?? 0) * (ctx.song.style === "ballad" ? 1.6 : 1);
  const jit = P.jitter ?? (P.role === "bass" ? 0.004 : 0.006);
  const voiceDrift = (P.voices ?? []).map(() => h.bi() * 0.006);
  for (const n of notes) {
    const v = P.voices?.[n.voice ?? 0];
    const t0 = ctx.time(n.b, n.trip) + feel + (n.dt ?? 0) + h.bi() * jit + (v ? voiceDrift[n.voice] : 0);
    const dur = Math.max(0.04, ctx.time(n.b + n.len, n.trip) - ctx.time(n.b, n.trip));
    const pan = v ? v.pan ?? 0 : P.panByPitch ? clamp((P.pan ?? 0) + ((n.midi - 64) / 40) * 0.45, -1, 1) : P.pan ?? 0;
    play(bus, { ...n, t: Math.max(0, t0), dur, pan }, v ? { ...(P.opts ?? {}), kind: v.kind } : P.opts ?? {});
  }
  return bus;
}

export function renderJazz(song, { loop = false, debug = false } = {}) {
  const ctx = context(song);
  ctx.hits = [];
  ctx.busy = [];
  const players = song.band.filter((p) => p.role !== "drums").map((p) => ({ ...p, r: rng(hashSeed(`${song.id}:${p.name}`)), notes: [] }));
  ctx.players = Object.fromEntries(players.map((p) => [p.name, p]));
  const parts = { lead: leadPart, second: secondPart, section: sectionPart, bass: bassPart, comp: compPart, pad: padPart };
  const ORDER = ["lead", "second", "section", "bass", "comp", "pad"];
  for (const role of ORDER) {
    for (const P of players.filter((p) => p.role === role)) {
      for (const seg of ctx.segs) P.notes.push(...parts[role](ctx, P, seg));
      if (role === "lead" || role === "second") for (const n of P.notes) ctx.busy.push([n.b, n.b + n.len]);
    }
  }
  const drumSpec = song.band.find((p) => p.role === "drums");
  const D = drumSpec ? { ...drumSpec, r: rng(hashSeed(`${song.id}:drums`)) } : null;
  const drumEvents = D ? ctx.segs.flatMap((seg) => drumsFor(ctx, D, seg)) : [];
  if (debug) return { ctx, players, drumEvents };

  const vamp = ctx.segs.filter((s) => s.part === "vamp");
  const tail = loop ? 0 : vamp.length ? 0.6 : 4;
  const endT = ctx.at(ctx.totalBeats) + tail + (song.live?.outro ?? 0);
  const length = Math.ceil(endT * SR);
  const music = new Stereo(length);
  const revSend = new Stereo(length);
  const dlySend = new Stereo(length);
  const mix = song.mix ?? {};

  // Leslie speeds up for organ solos that are cooking, slows for everything else.
  const fast = ctx.segs.filter((s) => s.int > 0.7 && ["solo", "shout", "trade"].includes(s.part)).map((s) => [ctx.at(s.b0), ctx.at(s.b1)]);
  const leslieRate = (t) => (fast.some(([a, b]) => t >= a + 0.5 && t < b) ? 6.7 : 0.85);

  for (const P of players) {
    if (!P.notes.length) continue;
    const bus = renderPlayer(ctx, P, P.notes, length);
    if (P.leslie) leslie(bus, { rate: leslieRate, ...(P.leslie === true ? {} : P.leslie) });
    eq(bus, "highpass", P.hp ?? ROLE_HP[P.role] ?? 80);
    if (P.lp) eq(bus, "lowpass", P.lp);
    for (const [type, f, q, g] of P.eq ?? []) eq(bus, type, f, q, g);
    if (P.chorus) chorus(bus, P.chorus === true ? {} : P.chorus);
    normalizeTo(bus, (ROLE_TARGET[P.role] ?? -21) + (P.level ?? 0));
    music.mixIn(bus);
    revSend.mixIn(bus, P.reverb ?? ROLE_SEND[P.role] ?? 0.15);
    if (P.delay) dlySend.mixIn(bus, P.delay);
  }

  if (D && drumEvents.length) {
    const { bus, send, sweepBus } = renderDrums(ctx, D, drumEvents, length);
    eq(bus, "highpass", 30);
    const before = activeRmsDb(bus);
    const target = (D.target ?? -20) + (D.level ?? 0);
    normalizeTo(bus, target);
    if (Number.isFinite(before)) send.scale(dbToGain(target - before));
    music.mixIn(bus);
    revSend.mixIn(send, mix.drumReverb ?? 1);
    if (activeRmsDb(sweepBus) > -200) {
      eq(sweepBus, "highpass", 700);
      normalizeTo(sweepBus, target - 7 + (D.levels?.sweep ?? 0));
      music.mixIn(sweepBus);
      revSend.mixIn(sweepBus, 0.12);
    }
  }

  // The live room: the crowd under it all, applause after the solos and a big hand at the end.
  if (song.live) {
    const L = song.live;
    const dry = activeRmsDb(music);
    const bed = crowd(length / SR, { seed: hashSeed(song.id), talkers: 16 });
    eq(bed, "lowpass", 4200);
    const startBand = ctx.at(0);
    bed.shape((i) => (i / SR < startBand ? 1 : 0.55 + 0.45 * Math.exp(-(i / SR - startBand) / 1.5)));
    normalizeTo(bed, dry - (L.crowdDb ?? 25));
    music.mixIn(bed);
    revSend.mixIn(bed, 0.5);
    const clapAt = [];
    ctx.segs.forEach((s, i) => {
      const next = ctx.segs[i + 1];
      if (s.last && (L.applauseAfter ?? []).includes(s.planIndex)) clapAt.push([ctx.at(s.b1) - 0.6, 3.6, 0.55, 0]);
      if (!next) clapAt.push([ctx.at(s.b1) - 0.3, (L.outro ?? 6) + 0.5, 1, 2]);
    });
    const hands = new Stereo(length);
    clapAt.forEach(([t, secs, lv, wh], k) => hands.mixIn(applause(secs, { seed: hashSeed(song.id) + k, people: Math.round(18 + 18 * lv), whistles: wh, swell: lv > 0.9 ? 0.25 : 0.6, level: lv }), 1, Math.round(t * SR)));
    if (activeRmsDb(hands) > -200) {
      normalizeTo(hands, dry - (L.applauseDb ?? 8));
      music.mixIn(hands);
      revSend.mixIn(hands, 0.45);
    }
  }

  const dryDb = activeRmsDb(music);
  if (activeRmsDb(revSend) > -200) {
    const wet = reverb(revSend, { room: 0.6, damp: 0.5, preDelay: 0.014, width: 0.9, ...(mix.reverb ?? {}) });
    music.mixIn(normalizeTo(wet, dryDb - 13.5 + (mix.reverbDb ?? 0)));
  }
  if (activeRmsDb(dlySend) > -200) {
    const wet = pingPong(dlySend, ctx.beat * (mix.delayBeats ?? 0.75), mix.delayFeedback ?? 0.32, 3200);
    music.mixIn(normalizeTo(wet, dryDb - 18 + (mix.delayDb ?? 0)));
  }

  const master = music;
  if (mix.lofi) {
    eq(master, "lowpass", 6800);
    eq(master, "lowshelf", 180, 0.7, 2);
    wow(master, { rate: 0.5, depthSec: 0.0009 });
    const crackle = new Stereo(length);
    placeMono(crackle, vinyl(length / SR, hashSeed(song.id)), 0, 1, 0);
    normalizeTo(crackle, dryDb - 27);
    master.mixIn(crackle);
  }
  if (mix.tape) {
    eq(master, "highshelf", 9000, 0.7, -2);
    eq(master, "lowshelf", 120, 0.7, 1);
    wow(master, { rate: 0.35, depthSec: 0.00025 });
  }
  for (const [type, f, q, g] of mix.masterEq ?? []) eq(master, type, f, q, g);
  eq(master, "highpass", 28);

  // A vamp fades out, the way a bossa ends on the record.
  if (vamp.length && mix.fadeOut !== false) {
    const a = ctx.at(vamp[0].b0 + (vamp[vamp.length - 1].b1 - vamp[0].b0) * 0.3);
    const b = ctx.at(vamp[vamp.length - 1].b1);
    master.shape((i) => {
      const t = i / SR;
      return t <= a ? 1 : t >= b ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * (t - a)) / (b - a));
    });
  }

  normalizeTo(master, -15);
  compress(master, { threshDb: -18, ratio: 1.8, attack: 0.025, release: 0.3, makeupDb: 1 });
  saturate(master, mix.lofi ? 1.35 : mix.tape ? 1.22 : 1.1);
  normalizeTo(master, -14.5);
  limit(master, 0.94);

  if (loop) return { buffer: master, ctx };
  const fadeLen = Math.round(0.8 * SR);
  for (let i = 0; i < fadeLen; i++) {
    const g = 1 - i / fadeLen;
    master.L[length - fadeLen + i] *= g;
    master.R[length - fadeLen + i] *= g;
  }
  const head = ctx.segs.find((s) => s.part === song.highlight) ?? ctx.segs.find((s) => s.part === "head") ?? ctx.segs[0];
  return { buffer: master, highlightStart: +ctx.at(head.b0).toFixed(2), duration: length / SR, bpm: song.bpm, firstBeat: +ctx.at(0).toFixed(3) };
}

// A seamless loop of the groove. The band plays a bar before the loop (so its first beat already
// has the ring of the bar before it) and on past it; the loop's last moments crossfade into the
// audio just before the loop point, which flows straight into its first sample.
export function renderJazzLoop(song) {
  const { buffer, ctx } = renderJazz(song, { loop: true });
  const loopStart = Math.round(ctx.at(ctx.segs.find((s) => s.item.loopStart)?.b0 ?? 0) * SR);
  const loopEnd = Math.round(ctx.at(ctx.segs.find((s) => s.item.loopEnd)?.b0 ?? ctx.totalBeats) * SR);
  const n = loopEnd - loopStart;
  const out = new Stereo(n);
  for (let i = 0; i < n; i++) {
    out.L[i] = buffer.L[loopStart + i];
    out.R[i] = buffer.R[loopStart + i];
  }
  const x = Math.min(loopStart, Math.round(0.03 * SR));
  for (let i = 0; i < x; i++) {
    const w = (i + 1) / x;
    const k = n - x + i;
    out.L[k] = out.L[k] * (1 - w) + buffer.L[loopStart - x + i] * w;
    out.R[k] = out.R[k] * (1 - w) + buffer.R[loopStart - x + i] * w;
  }
  return out;
}

export { parseChord as chord, rootlessOf, voice };
