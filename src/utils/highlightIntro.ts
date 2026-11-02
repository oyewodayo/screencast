// utils/highlightIntro.ts
//
// The flash-cut "highlight intro": a burst of very short moments taken from across your footage,
// played back to back before the video proper - optionally cut exactly on the beats of a music
// track, with a flash or whip on every cut and a light leak into the first real shot. Pure
// function: it only proposes the intro's clips; useVideoEditStore's insertHighlightIntro puts them
// at the front of the timeline (moving everything else along) as one undo step.
import type { Clip, TransitionType } from "./videoEditTypes";
import { isImageClipPath } from "./videoEditTypes";
import { clipOutputDuration } from "./clipTiming";

export type IntroPace = "steady" | "build";
export type IntroOrder = "story" | "shuffle";
export type IntroCutStyle = "cut" | "flash" | "whip";

export interface HighlightIntroOptions {
  // Clips to take moments from; empty = every video clip on the timeline.
  sourceClipIds: string[];
  cuts: number;
  // Average cut length in seconds (ignored for beat-synced cuts, which follow the beats).
  cutSec: number;
  pace: IntroPace;
  order: IntroOrder;
  between: IntroCutStyle;
  muteCuts: boolean;
  // Beat times (output seconds from the intro's start, ascending) to cut on, or null.
  beats: number[] | null;
  // Cut every Nth beat.
  everyBeats: number;
  // Re-roll: a different seed picks different moments.
  seed: number;
}

export const MIN_CUT_SEC = 0.08;
// Skip this fraction at each end of a clip - first and last moments are usually the weakest.
const EDGE_SKIP = 0.08;

// Deterministic pseudo-random in [0,1).
const rand = (seed: number, n: number) => {
  const x = Math.sin(seed * 9301.17 + n * 49297.31) * 233280.5;
  return x - Math.floor(x);
};

// Lengths of the intro's cuts: on the beat, or the chosen length (speeding up over a build).
export function introCutLengths(opts: Pick<HighlightIntroOptions, "cuts" | "cutSec" | "pace" | "beats" | "everyBeats">): number[] {
  if (opts.beats && opts.beats.length > 0) {
    const every = Math.max(1, Math.round(opts.everyBeats));
    const marks = [0, ...opts.beats.filter((b) => b > MIN_CUT_SEC)].filter((_, i) => i % every === 0);
    const lengths: number[] = [];
    for (let i = 1; i < marks.length && lengths.length < opts.cuts; i++) {
      const len = marks[i] - marks[i - 1];
      if (len >= MIN_CUT_SEC) lengths.push(len);
    }
    if (lengths.length > 0) return lengths;
  }
  const n = Math.max(1, Math.round(opts.cuts));
  if (opts.pace === "steady" || n === 1) return Array.from({ length: n }, () => opts.cutSec);
  // A build-up: from 1.6x the average down to 0.5x, scaled so the total stays cuts * cutSec.
  const raw = Array.from({ length: n }, (_, i) => 1.6 - (1.1 * i) / (n - 1));
  const scale = n / raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => Math.max(MIN_CUT_SEC, r * scale * opts.cutSec));
}

export interface IntroMoment {
  clip: Clip;
  // Source seconds.
  start: number;
  end: number;
}

// Picks one moment per cut. Each clip gets a fair share of the cuts - half by how much footage it
// has, half split equally, never more than half of them while there are other clips - so a long
// clip doesn't swamp the montage; each clip's moments are spread evenly along it (with a seeded
// wobble so re-rolls differ). "story" keeps timeline order; "shuffle" mixes them with no clip
// twice in a row.
export function pickIntroMoments(clips: Clip[], lengths: number[], opts: Pick<HighlightIntroOptions, "sourceClipIds" | "order" | "seed">): IntroMoment[] {
  const pool = clips.filter((c) => !isImageClipPath(c.sourcePath) && (opts.sourceClipIds.length === 0 || opts.sourceClipIds.includes(c.id)));
  const n = lengths.length;
  if (pool.length === 0 || n === 0) return [];
  const longest = Math.max(...lengths);
  // Clips long enough to hold a cut inside their trimmed-in part; all of them if none are.
  const fits = pool.filter((c) => (c.end - c.start) * (1 - 2 * EDGE_SKIP) >= longest * (c.speed ?? 1));
  const sources = fits.length > 0 ? fits : pool;

  // Quotas by largest remainder, then capped.
  const total = sources.reduce((sum, c) => sum + clipOutputDuration(c), 0) || 1;
  const weights = sources.map((c) => 0.5 * (clipOutputDuration(c) / total) + 0.5 / sources.length);
  const exact = weights.map((w) => w * n);
  const quotas = exact.map(Math.floor);
  const byRemainder = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; quotas.reduce((a, b) => a + b, 0) < n; k++) quotas[byRemainder[k % byRemainder.length][1]] += 1;
  if (sources.length > 1) {
    const cap = Math.ceil(n / 2);
    for (let i = 0; i < quotas.length; i++) {
      while (quotas[i] > cap) {
        quotas[i] -= 1;
        const j = quotas.reduce((best, q, idx) => (idx !== i && q < quotas[best] ? idx : best), i === 0 ? 1 : 0);
        quotas[j] += 1;
      }
    }
  }

  // Where along each clip (0..1 of its trimmed-in part) its moments sit.
  const slots: { clip: Clip; at: number; order: number }[] = [];
  sources.forEach((clip, ci) => {
    const q = quotas[ci];
    for (let j = 0; j < q; j++) {
      const at = Math.max(0, Math.min(1, (j + 0.5 + (rand(opts.seed, ci * 97 + j) - 0.5) * 0.8) / q));
      slots.push({ clip, at, order: clips.indexOf(clip) + at });
    }
  });

  let ordered: typeof slots;
  if (opts.order === "story") ordered = [...slots].sort((a, b) => a.order - b.order);
  else {
    // Seeded shuffle, then re-sequence: always take next from the clip with the most moments left
    // that isn't the one just shown (ties in shuffled order).
    const remaining = [...slots];
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(rand(opts.seed + 7, i) * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    ordered = [];
    while (remaining.length > 0) {
      const counts = new Map<string, number>();
      for (const s of remaining) counts.set(s.clip.id, (counts.get(s.clip.id) ?? 0) + 1);
      const prev = ordered[ordered.length - 1]?.clip.id;
      let best = -1;
      remaining.forEach((s, i) => {
        if (s.clip.id === prev) return;
        if (best < 0 || counts.get(s.clip.id)! > counts.get(remaining[best].clip.id)!) best = i;
      });
      ordered.push(remaining.splice(best < 0 ? 0 : best, 1)[0]);
    }
  }

  return ordered.map(({ clip, at }, k) => {
    const span = lengths[k] * (clip.speed ?? 1);
    const lo = clip.start + (clip.end - clip.start) * EDGE_SKIP;
    const hi = Math.max(lo, clip.end - (clip.end - clip.start) * EDGE_SKIP - span);
    const start = Math.max(clip.start, Math.min(lo + (hi - lo) * at, clip.end - span));
    return { clip, start, end: Math.min(clip.end, start + span) };
  });
}

const CUT_TRANSITION: Record<Exclude<IntroCutStyle, "cut">, TransitionType> = { flash: "fadewhite", whip: "whip" };

// The intro's clips, ready to go in front of the timeline. Each keeps its source clip's look
// (grade, colour, crop, mirror, speed).
export function buildHighlightIntro(clips: Clip[], opts: HighlightIntroOptions, newId: () => string): Clip[] {
  const lengths = introCutLengths(opts);
  const moments = pickIntroMoments(clips, lengths, opts);
  return moments.map((m, k): Clip => {
    const { clip } = m;
    const out = (m.end - m.start) / (clip.speed ?? 1);
    return {
      id: newId(),
      sourcePath: clip.sourcePath,
      start: m.start,
      end: m.end,
      ...(clip.speed && clip.speed !== 1 ? { speed: clip.speed } : {}),
      ...(clip.colorFilter ? { colorFilter: clip.colorFilter } : {}),
      ...(clip.grade ? { grade: clip.grade } : {}),
      ...(clip.crop ? { crop: clip.crop } : {}),
      ...(clip.flipHorizontal ? { flipHorizontal: true } : {}),
      ...(opts.muteCuts ? { muted: true } : {}),
      ...(k > 0 && opts.between !== "cut"
        ? { transitionIn: { type: CUT_TRANSITION[opts.between], duration: Math.max(0.05, Math.min(0.12, out * 0.5)), look: { intensity: 0.85 } } }
        : {}),
    };
  });
}
