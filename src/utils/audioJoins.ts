// utils/audioJoins.ts
//
// Joins that never click or dip, with nothing to set. Every audio piece's fades as they're played
// and exported - the ones set in its panel, plus what its edges need:
//
// - A crossfade wherever two pieces of one track (one mixer channel - audioChannelKey) overlap:
//   the first fades out and the second in across the overlap, equal-power (sin/cos), so the level
//   holds steady through it - a straight linear crossfade dips by 3 dB in the middle.
// - A short edge fade (EDGE_FADE_SEC) wherever a piece starts or stops in the middle of its sound -
//   a waveform cut mid-swing jumps to or from zero, and that jump is a click. 8 ms is far too short
//   to hear as a fade.
// - Nothing where a split piece carries straight on into its other half (same file, the source
//   continuing exactly) - that join is already seamless, and a fade would only dip it.
//
// A longer fade set in the piece's panel always wins - and keeps its own (linear) shape.

import type { AudioOverlay } from "./videoEditTypes";
import { audioChannelKey } from "./audioFx";

export type FadeCurve = "linear" | "equalPower";

export interface PieceFades {
  fadeIn: number;
  fadeOut: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
}

export const EDGE_FADE_SEC = 0.008;
// Overlaps shorter than this are a placement wobble, not a crossfade - treated as a butt join.
const MIN_CROSSFADE_SEC = 0.02;
// How close two edges or source times have to be to count as the same moment.
const SAME_SEC = 0.002;

type Piece = Pick<AudioOverlay, "id" | "src" | "label" | "library" | "startTime" | "endTime" | "trimStart" | "sourceDuration" | "fadeInSec" | "fadeOutSec" | "muted">;

// Every piece's fades, by id.
export function joinFades(pieces: readonly Piece[]): Map<string, PieceFades> {
  const out = new Map<string, PieceFades>();
  const crossIn = new Map<string, number>();
  const crossOut = new Map<string, number>();
  const seamlessIn = new Set<string>();
  const seamlessOut = new Set<string>();
  const byTrack = new Map<string, Piece[]>();
  for (const p of pieces) {
    if (p.muted) continue;
    const key = audioChannelKey(p);
    byTrack.set(key, [...(byTrack.get(key) ?? []), p]);
  }
  for (const track of byTrack.values()) {
    track.sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < track.length; i++) {
      const a = track[i];
      for (let j = i + 1; j < track.length && track[j].startTime < a.endTime + SAME_SEC; j++) {
        const b = track[j];
        if (b.endTime <= a.endTime) continue; // inside a, not a join
        const continues = b.src === a.src && Math.abs(b.startTime - a.endTime) < SAME_SEC && Math.abs(b.trimStart - (a.trimStart + a.endTime - a.startTime)) < SAME_SEC;
        if (continues) {
          seamlessOut.add(a.id);
          seamlessIn.add(b.id);
          continue;
        }
        const overlap = a.endTime - b.startTime;
        if (overlap >= MIN_CROSSFADE_SEC) {
          crossOut.set(a.id, Math.max(crossOut.get(a.id) ?? 0, overlap));
          crossIn.set(b.id, Math.max(crossIn.get(b.id) ?? 0, overlap));
        }
      }
    }
  }
  for (const p of pieces) {
    const length = Math.max(0, p.endTime - p.startTime);
    const cutIn = p.trimStart > SAME_SEC && !seamlessIn.has(p.id);
    const cutOut = p.trimStart + length < p.sourceDuration - SAME_SEC && !seamlessOut.has(p.id);
    const side = (own: number | undefined, cross: number | undefined, cut: boolean): [number, FadeCurve] => {
      const auto = Math.max(cross ?? 0, cut ? EDGE_FADE_SEC : 0);
      const set = own ?? 0;
      return set >= auto ? [set, "linear"] : [auto, "equalPower"];
    };
    let [fadeIn, fadeInCurve] = side(p.fadeInSec, crossIn.get(p.id), cutIn);
    let [fadeOut, fadeOutCurve] = side(p.fadeOutSec, crossOut.get(p.id), cutOut);
    // Never longer than the piece between them.
    if (fadeIn + fadeOut > length && fadeIn + fadeOut > 0) {
      const scale = length / (fadeIn + fadeOut);
      fadeIn *= scale;
      fadeOut *= scale;
    }
    out.set(p.id, { fadeIn, fadeOut, fadeInCurve, fadeOutCurve });
  }
  return out;
}

export const NO_FADES: PieceFades = { fadeIn: 0, fadeOut: 0, fadeInCurve: "linear", fadeOutCurve: "linear" };

const shape = (x: number, curve: FadeCurve): number => {
  const t = Math.max(0, Math.min(1, x));
  return curve === "equalPower" ? Math.sin((Math.PI / 2) * t) : t;
};

// The fades' level `local` seconds into a piece `length` long (0..1).
export function fadeLevel(f: PieceFades, local: number, length: number): number {
  let level = 1;
  if (f.fadeIn > 0) level = Math.min(level, shape(local / f.fadeIn, f.fadeInCurve));
  if (f.fadeOut > 0) level = Math.min(level, shape((length - local) / f.fadeOut, f.fadeOutCurve));
  return level;
}
