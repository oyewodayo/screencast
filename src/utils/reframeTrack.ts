// utils/reframeTrack.ts
//
// Auto-reframe: exporting to another shape (16:9 -> 9:16, 1:1...) in Fill mode with the crop window
// following the subject, the way a camera operator would rather than a tracker would:
//
// - Evidence: where the action is, per frame (analyze_subject_track, services/subject_track.rs),
//   plus recorded clicks (a screen recording's own "look here" moments) weighted strongly - all
//   mapped onto the project frame through each clip's exact framing (fit, mirror, crop, Ken Burns -
//   clipFrameAffine) and onto the output timeline (clipTiming).
// - Shots: the camera re-frames at every cut (clip boundaries, detected scene cuts). A transition
//   becomes an eased move across it instead of a jump.
// - Within a shot it holds still while the subject stays inside a dead zone around the centre; when
//   the subject leaves it for a sustained moment, one eased move takes the window to where the
//   subject settles (looked up ahead - the whole clip is known, so the camera anticipates instead of
//   lagging). Brief glances elsewhere don't move it.
//
// The result is a short list of knots, eased between (eased_knots_expr in conversion.rs draws the
// identical curve for export; reframeWindowAt below for the preview).
import type { Clip } from "./videoEditTypes";
import { clipOutputDuration, sourceToOutputOffset } from "./clipTiming";
import { clipFrameAffine, containRect } from "./videoColorFilters";

export interface SubjectSample {
  t: number;
  x: number;
  y: number;
  confidence: number;
  cut: boolean;
}

export interface SubjectTrack {
  width: number;
  height: number;
  samples: SubjectSample[];
}

export interface ReframeKnot {
  t: number;
  x: number;
  y: number;
}

// A point of evidence on the output timeline, in frame fractions.
export interface TrackPoint {
  t: number;
  x: number;
  y: number;
  weight: number;
}

interface Size {
  width: number;
  height: number;
}

// The Fill crop window, as fractions of the project frame.
export function fillWindow(frame: Size, out: Size): { w: number; h: number } {
  const fa = frame.width / frame.height;
  const oa = out.width / out.height;
  return fa > oa ? { w: oa / fa, h: 1 } : { w: 1, h: fa / oa };
}

// Dead zone: how far (as a share of the window) the subject may sit off-centre before the camera moves.
const DEAD_ZONE = 0.16;
// ... and for how long it must stay out before that's a move rather than a glance.
const SUSTAIN_SEC = 0.4;
// Where the subject settles after leaving the zone: looked at over this long ahead.
const SETTLE_SEC = 0.8;
// Smoothing of the raw evidence (weighted median over +-this).
const MEDIAN_HALF_SEC = 0.6;
// Moves: base length plus per window-width travelled, within bounds.
const MOVE_BASE_SEC = 0.45;
const MOVE_PER_WINDOW_SEC = 0.9;
const MOVE_MIN_SEC = 0.5;
const MOVE_MAX_SEC = 1.5;
// A move starts this much before the subject leaves the zone (it's known in advance).
const ANTICIPATE_SEC = 0.15;
// A recorded click counts this much more than one frame's motion.
const CLICK_WEIGHT = 4;
// Around a click, the cursor is where to look for this long.
const CLICK_SPREAD_SEC = 0.6;
// A cut is a jump this short (one frame at 60fps).
const CUT_SEC = 1 / 60;

// Where in the clip's source frame `fractions` (x, y) land in the project frame - fit (letterboxed
// into the frame, as export's frame_fit_chain does), then the clip's own mirror/crop/Ken Burns.
function sourceToFrame(clip: Clip, picture: Size | null, frame: Size, sourceTime: number, x: number, y: number): [number, number] {
  const progress = (sourceTime - clip.start) / Math.max(0.01, clip.end - clip.start);
  const m = clipFrameAffine(clip, progress);
  let fx = x;
  let fy = y;
  if (picture && picture.width > 0 && picture.height > 0) {
    const fit = containRect(frame.width, frame.height, picture.width, picture.height);
    fx = fit.x / frame.width + x * (fit.width / frame.width);
    fy = fit.y / frame.height + y * (fit.height / frame.height);
  }
  return [m.ax * fx + m.bx, m.ay * fy + m.by];
}

// The window size to ask the analysis for, in the clip's source fractions (inverse of the above at
// the clip's middle - only used to pick which window holds the most action).
export function sourceWindow(clip: Clip, picture: Size | null, frame: Size, win: { w: number; h: number }): { w: number; h: number } {
  const m = clipFrameAffine(clip, 0.5);
  let sx = 1;
  let sy = 1;
  if (picture && picture.width > 0 && picture.height > 0) {
    const fit = containRect(frame.width, frame.height, picture.width, picture.height);
    sx = fit.width / frame.width;
    sy = fit.height / frame.height;
  }
  return { w: Math.min(1, win.w / Math.max(1e-6, Math.abs(m.ax) * sx)), h: Math.min(1, win.h / Math.max(1e-6, Math.abs(m.ay) * sy)) };
}

export interface ClipEvidence {
  clip: Clip;
  track: SubjectTrack | null;
  clicks: { time: number; x: number; y: number }[];
}

// Everything onto the output timeline: evidence points, and the shot boundaries (with how long
// the transition into each is, 0 = a cut).
export function gatherEvidence(evidence: ClipEvidence[], frame: Size): { points: TrackPoint[]; boundaries: { t: number; blend: number }[]; duration: number } {
  const points: TrackPoint[] = [];
  const boundaries: { t: number; blend: number }[] = [];
  let outputStart = 0;
  for (const { clip, track, clicks } of evidence) {
    if (outputStart > 0) boundaries.push({ t: outputStart, blend: clip.transitionIn?.duration ?? 0 });
    const picture = track && track.width > 0 && track.height > 0 ? { width: track.width, height: track.height } : null;
    const toOutput = (sourceTime: number) => outputStart + sourceToOutputOffset(clip, Math.max(clip.start, Math.min(clip.end, sourceTime)));
    for (const s of track?.samples ?? []) {
      if (s.t < clip.start || s.t > clip.end) continue;
      const t = toOutput(s.t);
      if (s.cut) boundaries.push({ t, blend: 0 });
      if (s.confidence <= 0) continue;
      const [x, y] = sourceToFrame(clip, picture, frame, s.t, s.x, s.y);
      points.push({ t, x, y, weight: s.confidence });
    }
    for (const c of clicks) {
      if (c.time < clip.start || c.time > clip.end) continue;
      const [x, y] = sourceToFrame(clip, picture, frame, c.time, c.x, c.y);
      // A few points across the moment, so the click holds the camera for it.
      for (const dt of [-CLICK_SPREAD_SEC / 2, 0, CLICK_SPREAD_SEC / 2]) {
        const sourceTime = c.time + dt;
        if (sourceTime < clip.start || sourceTime > clip.end) continue;
        points.push({ t: toOutput(sourceTime), x, y, weight: CLICK_WEIGHT });
      }
    }
    outputStart += clipOutputDuration(clip);
  }
  points.sort((a, b) => a.t - b.t);
  boundaries.sort((a, b) => a.t - b.t);
  return { points, boundaries, duration: outputStart };
}

function weightedMedian(values: { v: number; w: number }[]): number {
  const sorted = [...values].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((sum, e) => sum + e.w, 0);
  let acc = 0;
  for (const e of sorted) {
    acc += e.w;
    if (acc >= total / 2) return e.v;
  }
  return sorted[sorted.length - 1]?.v ?? 0.5;
}

// The points of time-sorted `points` within [from, to], by index (binary search).
function lowerBound(points: TrackPoint[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function within(points: TrackPoint[], from: number, to: number): TrackPoint[] {
  return points.slice(lowerBound(points, from), lowerBound(points, to + 1e-9));
}

// The smoothed target at each point: weighted median of the evidence around it.
function smoothTargets(points: TrackPoint[]): TrackPoint[] {
  return points.map((p) => {
    const near = within(points, p.t - MEDIAN_HALF_SEC, p.t + MEDIAN_HALF_SEC);
    return {
      t: p.t,
      x: weightedMedian(near.map((q) => ({ v: q.x, w: q.weight }))),
      y: weightedMedian(near.map((q) => ({ v: q.y, w: q.weight }))),
      weight: near.reduce((sum, q) => sum + q.weight, 0),
    };
  });
}

// Camera knots for the whole timeline.
export function solveReframe(points: TrackPoint[], boundaries: { t: number; blend: number }[], duration: number, win: { w: number; h: number }): ReframeKnot[] {
  const clampX = (x: number) => Math.max(win.w / 2, Math.min(1 - win.w / 2, x));
  const clampY = (y: number) => Math.max(win.h / 2, Math.min(1 - win.h / 2, y));
  // Shots between boundaries (deduplicated - a scene cut right at a clip boundary is one boundary).
  const cuts: { t: number; blend: number }[] = [];
  for (const b of boundaries) {
    if (b.t <= 0 || b.t >= duration) continue;
    const last = cuts[cuts.length - 1];
    if (last && b.t - last.t < 0.25) last.blend = Math.max(last.blend, b.blend);
    else cuts.push({ ...b });
  }
  const edges = [0, ...cuts.map((c) => c.t), duration];
  const knots: ReframeKnot[] = [];
  const push = (t: number, x: number, y: number) => {
    const k = { t, x: clampX(x), y: clampY(y) };
    const last = knots[knots.length - 1];
    if (last && Math.abs(last.t - t) < 1e-6) knots[knots.length - 1] = k;
    else knots.push(k);
  };

  let previous: { x: number; y: number } | null = null;
  for (let s = 0; s < edges.length - 1; s++) {
    const [s0, s1] = [edges[s], edges[s + 1]];
    const raw = points.slice(lowerBound(points, s0), lowerBound(points, s1));
    const targets = smoothTargets(raw);
    const settle = (from: number, to: number, fallback: { x: number; y: number }) => {
      const near = within(targets, from, to);
      if (near.length === 0) return fallback;
      return { x: weightedMedian(near.map((p) => ({ v: p.x, w: p.weight }))), y: weightedMedian(near.map((p) => ({ v: p.y, w: p.weight }))) };
    };
    // Opening framing: where the action is early in the shot (or where the last shot left off).
    let cam = settle(s0, s0 + 1.0, previous ?? { x: 0.5, y: 0.5 });
    cam = { x: clampX(cam.x), y: clampY(cam.y) };
    const cut = cuts[s - 1];
    if (s === 0) push(0, cam.x, cam.y);
    else if (cut && cut.blend > 0 && previous) {
      // Through a transition: one eased move across it.
      push(s0, previous.x, previous.y);
      push(Math.min(s1, s0 + cut.blend), cam.x, cam.y);
    } else {
      push(s0, cam.x, cam.y);
    }

    let busyUntil = knots[knots.length - 1].t;
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      if (p.t < busyUntil) continue;
      const outside = (q: TrackPoint) => Math.abs(q.x - cam.x) > DEAD_ZONE * win.w || Math.abs(q.y - cam.y) > DEAD_ZONE * win.h;
      if (!outside(p)) continue;
      // Sustained? Every target over the next SUSTAIN_SEC is out too.
      const ahead = within(targets, p.t, p.t + SUSTAIN_SEC);
      if (ahead.length < 2 || !ahead.every(outside)) continue;
      const dest = settle(p.t, p.t + SETTLE_SEC, cam);
      const target = { x: clampX(dest.x), y: clampY(dest.y) };
      const travel = Math.max(Math.abs(target.x - cam.x) / Math.max(win.w, 1e-3), Math.abs(target.y - cam.y) / Math.max(win.h, 1e-3));
      if (travel < DEAD_ZONE / 2) continue; // the window can't actually get closer (frame edge)
      const length = Math.max(MOVE_MIN_SEC, Math.min(MOVE_MAX_SEC, MOVE_BASE_SEC + MOVE_PER_WINDOW_SEC * travel));
      const start = Math.max(busyUntil, p.t - ANTICIPATE_SEC);
      const end = Math.min(s1 - CUT_SEC, start + length);
      if (end - start < 0.2) continue;
      push(start, cam.x, cam.y);
      push(end, target.x, target.y);
      cam = target;
      busyUntil = end;
    }
    // Hold to the end of the shot; the next shot's opening knot makes the cut.
    if (s < edges.length - 2 && !(cuts[s] && cuts[s].blend > 0)) push(s1 - CUT_SEC, cam.x, cam.y);
    previous = cam;
  }
  // Drop knots that are pure repeats in the middle of a hold.
  return knots.filter((k, i) => {
    const a = knots[i - 1];
    const b = knots[i + 1];
    return !(a && b && a.x === k.x && a.y === k.y && b.x === k.x && b.y === k.y);
  });
}

// The window centre at output time `t` - the same eased curve export draws (eased_knots_expr).
export function reframeWindowAt(knots: ReframeKnot[], t: number): { x: number; y: number } {
  if (knots.length === 0) return { x: 0.5, y: 0.5 };
  if (t <= knots[0].t) return { x: knots[0].x, y: knots[0].y };
  const last = knots[knots.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y };
  let lo = 0;
  let hi = knots.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = knots[lo];
  const b = knots[hi];
  const p = Math.max(0, Math.min(1, (t - a.t) / Math.max(1e-3, b.t - a.t)));
  const e = p * p * (3 - 2 * p);
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
}
