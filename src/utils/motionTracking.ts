// utils/motionTracking.ts
//
// Pins an overlay (text, picture, element, blur region) to something moving in the video. The
// user drags a box over the thing to follow at the playhead; track_motion (Rust, the motion-track
// crate) follows it through the clip; this maps every tracked frame back onto the output frame and
// bakes the overlay's motion into ordinary linear keyframes. Preview and export then play those
// same keyframes (keyframes.ts / keyframe_expr in conversion.rs), so the pinned overlay moves
// identically in both - nothing tracking-specific has to exist on either side.
//
// Frame geometry follows the export exactly: a source picture is fitted (contain, centred) into
// the project frame (frame_fit_chain), then flip/crop/Ken Burns map it to the output frame
// (clipFrameAffine). Tracking covers the clip under the playhead and any clips continuing the same
// source straight on from it; outside that the overlay holds where the track ended.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Clip, OverlayTrackInfo } from "./videoEditTypes";
import { isImageClipPath } from "./videoEditTypes";
import { OverlayKeyframe, keyframeStateAt } from "./keyframes";
import { clipOutputDuration, outputOffsetToSource } from "./clipTiming";
import { FrameAffine, clipFrameAffine, containRect } from "./videoColorFilters";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TrackSample {
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
  c: number;
  lost: boolean;
}

interface MotionTrackResult {
  width: number;
  height: number;
  fps: number;
  samples: TrackSample[];
}

interface Size {
  width: number;
  height: number;
}

// Keyframes are sampled at this rate before simplification (the export's overlay rate).
const BAKE_FPS = 30;
// Largest error, in output pixels, the simplified keyframes may stray from the tracked path.
const SIMPLIFY_TOLERANCE_PX = 0.35;

// Where the source picture sits in the project frame, as fractions of the frame (frame_fit_chain).
function fitRect(source: Size, frame: Size | null): Box {
  if (!frame) return { x: 0, y: 0, width: 1, height: 1 };
  const r = containRect(frame.width, frame.height, source.width, source.height);
  return { x: r.x / frame.width, y: r.y / frame.height, width: r.width / frame.width, height: r.height / frame.height };
}

const progressAt = (clip: Clip, sourceTime: number) => (clip.end > clip.start ? (sourceTime - clip.start) / (clip.end - clip.start) : 0);

// Source fraction -> output fraction, per axis, for a clip at a source time.
function forward(clip: Clip, fit: Box, sourceTime: number): { m: FrameAffine; fit: Box } {
  return { m: clipFrameAffine(clip, progressAt(clip, sourceTime)), fit };
}
const toOutX = (g: { m: FrameAffine; fit: Box }, u: number) => g.m.ax * (g.fit.x + u * g.fit.width) + g.m.bx;
const toOutY = (g: { m: FrameAffine; fit: Box }, v: number) => g.m.ay * (g.fit.y + v * g.fit.height) + g.m.by;
const toSrcX = (g: { m: FrameAffine; fit: Box }, X: number) => ((X - g.m.bx) / g.m.ax - g.fit.x) / g.fit.width;
const toSrcY = (g: { m: FrameAffine; fit: Box }, Y: number) => ((Y - g.m.by) / g.m.ay - g.fit.y) / g.fit.height;

interface ClipSpan {
  clip: Clip;
  outStart: number;
  outEnd: number;
}

function clipSpans(clips: Clip[]): ClipSpan[] {
  let at = 0;
  return clips.map((clip) => {
    const d = clipOutputDuration(clip);
    const span = { clip, outStart: at, outEnd: at + d };
    at += d;
    return span;
  });
}

// The clips the track can follow through: the one at `index`, and its neighbours that carry on the
// same source without a jump (a split, or trimmed pieces still touching).
function continuousRun(spans: ClipSpan[], index: number): ClipSpan[] {
  const same = (a: Clip, b: Clip) => a.sourcePath === b.sourcePath && Math.abs(a.end - b.start) < 0.05 && !a.reversedFrom && !b.reversedFrom;
  let lo = index;
  let hi = index;
  while (lo > 0 && same(spans[lo - 1].clip, spans[lo].clip)) lo--;
  while (hi + 1 < spans.length && same(spans[hi].clip, spans[hi + 1].clip)) hi++;
  return spans.slice(lo, hi + 1);
}

// The tracked box at source time t (fractions of the source frame): interpolated between samples,
// held before the first and after the last.
function sampleAt(samples: TrackSample[], t: number): TrackSample {
  if (t <= samples[0].t) return samples[0];
  const last = samples[samples.length - 1];
  if (t >= last.t) return last;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k, c: Math.min(a.c, b.c), lost: a.lost || b.lost };
}

// Keeps the fewest keyframes whose straight-line interpolation stays within `tol` of every
// sampled point (Ramer-Douglas-Peucker in time: the error is measured where the keyframes would
// put the overlay at that sample's time, not as a distance to a line in space).
export function simplifyTimed<T extends { time: number }>(points: T[], values: (p: T) => number[], tol: number): T[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const vi = values(points[i]);
    const vj = values(points[j]);
    const span = points[j].time - points[i].time;
    let worst = -1;
    let worstErr = 0;
    for (let k = i + 1; k < j; k++) {
      const f = span > 0 ? (points[k].time - points[i].time) / span : 0;
      const vk = values(points[k]);
      let err = 0;
      for (let c = 0; c < vk.length; c++) err = Math.max(err, Math.abs(vk[c] - (vi[c] + (vj[c] - vi[c]) * f)));
      if (err > worstErr) {
        worstErr = err;
        worst = k;
      }
    }
    if (worst > 0 && worstErr > tol) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return points.filter((_, k) => keep[k]);
}

export interface TrackOverlayRequest {
  clips: Clip[];
  // The project/timeline frame in pixels (what segments are fitted into), if known.
  frame: Size | null;
  overlay: { x: number; y: number; width: number; height: number; startTime: number; endTime: number; keyframes?: OverlayKeyframe[] };
  // What to follow, as output-frame fractions at `anchorTime` (output seconds).
  target: Box;
  anchorTime: number;
  followScale: boolean;
  // Position only (a blur region): scale stays at 1.
  positionOnly?: boolean;
  jobId: string;
  onProgress?: (progress: number) => void;
}

export interface TrackOverlayResult {
  keyframes: OverlayKeyframe[];
  track: OverlayTrackInfo;
}

export async function trackOverlay(req: TrackOverlayRequest): Promise<TrackOverlayResult> {
  const spans = clipSpans(req.clips);
  const index = spans.findIndex((s, i) => req.anchorTime < s.outEnd || i === spans.length - 1);
  const at = spans[index];
  if (!at) throw new Error("Nothing to track here");
  if (isImageClipPath(at.clip.sourcePath)) throw new Error("Motion tracking follows things in a video - this is a still picture");
  const run = continuousRun(spans, index);
  const anchorSource = outputOffsetToSource(at.clip, Math.max(0, req.anchorTime - at.outStart));

  // The tracked span: the overlay's time on screen within the run.
  const outFrom = Math.max(req.overlay.startTime, run[0].outStart);
  const outTo = Math.min(req.overlay.endTime, run[run.length - 1].outEnd);
  const sourceAt = (t: number) => {
    const s = run.find((r, i) => t < r.outEnd || i === run.length - 1)!;
    return { span: s, source: outputOffsetToSource(s.clip, Math.max(0, t - s.outStart)) };
  };
  const srcFrom = sourceAt(outFrom).source;
  const srcTo = sourceAt(Math.max(outFrom, outTo - 1e-3)).source;

  const [srcW, srcH] = await invoke<[number, number]>("video_frame_size", { sourcePath: at.clip.sourcePath });
  const fit = fitRect({ width: srcW, height: srcH }, req.frame);

  // The picked box in the source frame (a flip swaps its edges, hence min/max).
  const g0 = forward(at.clip, fit, anchorSource);
  const xs = [toSrcX(g0, req.target.x), toSrcX(g0, req.target.x + req.target.width)];
  const ys = [toSrcY(g0, req.target.y), toSrcY(g0, req.target.y + req.target.height)];
  const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.abs(xs[1] - xs[0]), height: Math.abs(ys[1] - ys[0]) };
  if (!(box.width > 0.002 && box.height > 0.002)) throw new Error("The box is too small to follow");

  const unlisten = await listen<{ jobId: string; progress: number }>("motion-track-progress", (e) => {
    if (e.payload.jobId === req.jobId) req.onProgress?.(e.payload.progress);
  });
  let result: MotionTrackResult;
  try {
    result = await invoke<MotionTrackResult>("track_motion", {
      request: { jobId: req.jobId, sourcePath: at.clip.sourcePath, start: Math.min(srcFrom, anchorSource), end: Math.max(srcTo, anchorSource + 1 / 30), anchor: anchorSource, ...box },
    });
  } finally {
    unlisten();
  }
  const samples = result.samples;
  if (samples.length === 0) throw new Error("Couldn't follow anything there");

  // The target's centre and width on the output frame at output time t.
  const targetAt = (t: number) => {
    const clamped = Math.max(outFrom, Math.min(outTo - 1e-4, t));
    const { span, source } = sourceAt(clamped);
    const s = sampleAt(samples, source);
    const g = forward(span.clip, fit, source);
    const x0 = toOutX(g, s.x - s.w / 2);
    const x1 = toOutX(g, s.x + s.w / 2);
    return { cx: (x0 + x1) / 2, cy: toOutY(g, s.y), w: Math.abs(x1 - x0), lost: s.lost };
  };
  const t0 = targetAt(req.anchorTime);
  const local0 = req.anchorTime - req.overlay.startTime;
  const state0 = keyframeStateAt(req.overlay.keyframes, local0) ?? { x: req.overlay.x, y: req.overlay.y, scale: 1, opacity: 1 };
  const halfW = req.overlay.width / 2;
  const halfH = req.overlay.height / 2;
  const offset = { x: state0.x + halfW - t0.cx, y: state0.y + halfH - t0.cy };

  // The overlay's state at every frame of its life: following the target's centre (and size).
  const duration = req.overlay.endTime - req.overlay.startTime;
  const frames = Math.max(1, Math.ceil(duration * BAKE_FPS));
  const baked: OverlayKeyframe[] = [];
  let lost = 0;
  let tracked = 0;
  for (let n = 0; n <= frames; n++) {
    const local = Math.min(duration, n / BAKE_FPS);
    const t = req.overlay.startTime + local;
    const target = targetAt(t);
    if (t >= outFrom && t <= outTo) {
      tracked++;
      if (target.lost) lost++;
    }
    const k = req.followScale && !req.positionOnly && t0.w > 1e-6 ? target.w / t0.w : 1;
    const own = keyframeStateAt(req.overlay.keyframes, local);
    const scale = req.positionOnly ? 1 : req.followScale ? state0.scale * k : (own?.scale ?? 1);
    baked.push({
      time: local,
      x: target.cx + offset.x * k - halfW,
      y: target.cy + offset.y * k - halfH,
      scale,
      opacity: own?.opacity ?? 1,
      easing: "linear",
    });
  }
  const W = req.frame?.width ?? 1920;
  const H = req.frame?.height ?? 1080;
  // Scale and opacity errors weighed as the pixels they'd move the box's edge / its alpha by.
  const keyframes = simplifyTimed(baked, (k) => [k.x * W, k.y * H, k.scale * Math.max(req.overlay.width * W, req.overlay.height * H) * 0.5, k.opacity * 255 * 0.25], SIMPLIFY_TOLERANCE_PX);
  return {
    keyframes,
    track: {
      sourcePath: at.clip.sourcePath,
      target: req.target,
      anchorTime: local0,
      followScale: req.followScale && !req.positionOnly,
      lostFraction: tracked > 0 ? lost / tracked : 0,
      trackedAt: Date.now(),
    },
  };
}

export const cancelTracking = (jobId: string) => invoke("cancel_motion_track", { jobId }).catch(() => {});
