// utils/audioAutomation.ts
//
// Volume automation: a line of points drawn over an audio piece on the timeline that rides its level
// up and down over time - the move a mix engineer makes a hundred times a session (lift a quiet
// phrase, dip under a line, swell into a chorus) and that a single volume slider can't make.
//
// Points are pinned to the SONG, not the timeline: `at` is seconds into the source file, so trimming
// the piece or sliding it along keeps every point on the same musical moment. The level between two
// points moves in a straight line in dB (as a fader would), and holds flat before the first point and
// after the last. It multiplies onto the piece's volume, fades and ducking.
//
// The preview schedules this exact curve on a Web Audio gain (mixerGraph.ts setElementGain); the
// export evaluates the same piecewise-linear dB curve per 256 samples (automation_volume_filter,
// conversion.rs) from automationForExport below.
import type { AudioOverlay } from "./videoEditTypes";

export interface GainPoint {
  at: number; // seconds into the source file
  db: number; // AUTOMATION_MIN_DB (silence) .. AUTOMATION_MAX_DB
}

export const AUTOMATION_MAX_DB = 6;
// The bottom of the line - treated as silence on screen; -60 dB is inaudible under any programme.
export const AUTOMATION_MIN_DB = -60;

export const clampDb = (db: number): number => Math.max(AUTOMATION_MIN_DB, Math.min(AUTOMATION_MAX_DB, db));
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

// The level at `at` (source seconds), in dB - 0 with no points.
export function gainDbAt(points: GainPoint[] | undefined, at: number): number {
  if (!points || points.length === 0) return 0;
  if (at <= points[0].at) return points[0].db;
  const last = points[points.length - 1];
  if (at >= last.at) return last.db;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (at <= b.at) {
      const a = points[i - 1];
      const span = b.at - a.at;
      return span <= 0 ? b.db : a.db + ((b.db - a.db) * (at - a.at)) / span;
    }
  }
  return last.db;
}

// Where a level sits on the lane, 0 (bottom) .. 1 (top). A cube-root of the gain like a fader's
// travel: unity sits about four-fifths up and the musically useful -20..+6 dB gets most of the height.
export function dbToFraction(db: number): number {
  if (db <= AUTOMATION_MIN_DB) return 0;
  return Math.min(1, Math.cbrt(dbToGain(db) / dbToGain(AUTOMATION_MAX_DB)));
}
export function fractionToDb(fraction: number): number {
  const f = Math.max(0, Math.min(1, fraction));
  if (f <= 0) return AUTOMATION_MIN_DB;
  return clampDb(20 * Math.log10(f * f * f * dbToGain(AUTOMATION_MAX_DB)));
}

export const hasAutomation = (o: Pick<AudioOverlay, "gain">): boolean => !!o.gain && o.gain.some((p) => Math.abs(p.db) > 0.01);

// Adds a point, keeping them in time order. Returns the new list and the new point's index.
export function addGainPoint(points: GainPoint[] | undefined, at: number, db: number): { points: GainPoint[]; index: number } {
  const list = [...(points ?? [])];
  let index = list.findIndex((p) => p.at > at);
  if (index === -1) index = list.length;
  list.splice(index, 0, { at, db: clampDb(db) });
  return { points: list, index };
}

// Moves one point - never past its neighbours, so the line stays a function of time.
export function moveGainPoint(points: GainPoint[], index: number, at: number, db: number): GainPoint[] {
  const MIN_GAP = 0.01;
  const lo = index > 0 ? points[index - 1].at + MIN_GAP : -Infinity;
  const hi = index < points.length - 1 ? points[index + 1].at - MIN_GAP : Infinity;
  return points.map((p, i) => (i === index ? { at: Math.max(lo, Math.min(hi, at)), db: clampDb(db) } : p));
}

export const removeGainPoint = (points: GainPoint[], index: number): GainPoint[] => points.filter((_, i) => i !== index);

// The curve for the export, in the piece's own output time (0 = where it starts on the timeline):
// [seconds, dB] pairs, just the points that shape the part that plays plus one either side so the
// line runs into it correctly. null when nothing would change.
export function automationForExport(o: Pick<AudioOverlay, "gain" | "trimStart" | "startTime" | "endTime">): [number, number][] | null {
  if (!o.gain || !hasAutomation(o)) return null;
  const length = o.endTime - o.startTime;
  const local = o.gain.map((p) => [p.at - o.trimStart, p.db] as [number, number]);
  // From the last point at or before the start to the first at or after the end.
  let from = 0;
  local.forEach(([t], i) => {
    if (t <= 0) from = i;
  });
  let to = local.length - 1;
  for (let i = local.length - 1; i >= 0; i--) if (local[i][0] >= length) to = i;
  return local.slice(from, Math.max(from, to) + 1);
}
