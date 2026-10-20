// utils/objectFind.ts
//
// "Find & hide": the user outlines something once - a logo, a picture or a name on screen, a face,
// a licence plate - and it's found everywhere it appears in the video (find_objects, Rust: the
// motion-track crate's Finder), each appearance followed as it moves and resizes. Each one then gets
// the chosen treatment: a blur region, a solid cover, or a picture over it - ordinary overlays with
// ordinary keyframes, so the preview and the export play them identically and each can still be
// adjusted or removed on its own.
//
// Geometry is motion tracking's (motionTracking.ts): the outline is mapped from the output frame
// into each clip's source picture, and every find back out through that clip's framing (fit, crop,
// Ken Burns, mirror) at its moment.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { BlurOverlay, Clip, ImageOverlay } from "./videoEditTypes";
import { isImageClipPath } from "./videoEditTypes";
import type { OverlayKeyframe } from "./keyframes";
import { outputOffsetToSource } from "./clipTiming";
import { clipSpans, fitRect, forward, simplifyTimed, toOutX, toOutY, toSrcX, toSrcY, type Box } from "./motionTracking";
import { assetEntry, type OverlayAsset } from "./videoAssets";

export type HideEffect = { kind: "blur"; strength: number } | { kind: "color"; color: string } | { kind: "image"; path: string };
export type HideShape = "rectangle" | "ellipse";

// One appearance on the output timeline: its box (centre and size, output-frame fractions) at
// output times.
export interface Appearance {
  frames: { t: number; cx: number; cy: number; w: number; h: number }[];
}

interface FoundTrack {
  rangeIndex: number;
  sourcePath: string;
  samples: { t: number; x: number; y: number; w: number; h: number; score: number }[];
}

// Analysis rate of find_objects - one frame's span, added to an appearance's end.
const FIND_STEP = 1 / 12;
// Largest error (output pixels) the baked keyframes may stray from the found path.
const SIMPLIFY_TOLERANCE_PX = 0.35;

// A clip whose source time maps straight onto the output (constant speed, not reversed).
const playsStraight = (c: Clip) => !c.speedRamp && !c.reversedFrom && !isImageClipPath(c.sourcePath);

export interface FindRequest {
  clips: Clip[];
  frame: { width: number; height: number } | null;
  // The outline's bounding box (output-frame fractions) at `anchorTime` (output seconds).
  target: Box;
  anchorTime: number;
  // 0 (only near-identical) .. 1 (looser matches too).
  sensitivity: number;
  jobId: string;
  onProgress?: (progress: number, found: number) => void;
}

export async function findEverywhere(req: FindRequest): Promise<Appearance[]> {
  const spans = clipSpans(req.clips);
  const anchorIndex = spans.findIndex((s, i) => req.anchorTime < s.outEnd || i === spans.length - 1);
  const at = spans[anchorIndex];
  if (!at || isImageClipPath(at.clip.sourcePath)) throw new Error("Outline it on a moment of the video (not a still picture)");
  // Each source's picture size - its fit into the frame decides the mapping.
  const sizes = new Map<string, Box>();
  const fitOf = async (path: string) => {
    if (!sizes.has(path)) {
      const [w, h] = await invoke<[number, number]>("video_frame_size", { sourcePath: path });
      sizes.set(path, fitRect({ width: w, height: h }, req.frame));
    }
    return sizes.get(path)!;
  };
  const anchorSource = outputOffsetToSource(at.clip, Math.max(0, req.anchorTime - at.outStart));
  const g0 = forward(at.clip, await fitOf(at.clip.sourcePath), anchorSource);
  const xs = [toSrcX(g0, req.target.x), toSrcX(g0, req.target.x + req.target.width)];
  const ys = [toSrcY(g0, req.target.y), toSrcY(g0, req.target.y + req.target.height)];
  const anchor = { sourcePath: at.clip.sourcePath, time: anchorSource, x: Math.min(...xs), y: Math.min(...ys), width: Math.abs(xs[1] - xs[0]), height: Math.abs(ys[1] - ys[0]) };
  if (!(anchor.width > 0.004 && anchor.height > 0.004)) throw new Error("Outline something a little bigger");

  const searched = spans.filter((s) => playsStraight(s.clip));
  for (const s of searched) await fitOf(s.clip.sourcePath);
  const ranges = searched.map((s) => ({ sourcePath: s.clip.sourcePath, start: s.clip.start, end: s.clip.end }));
  const unlisten = await listen<{ jobId: string; progress: number; found: number }>("find-objects-progress", (e) => {
    if (e.payload.jobId === req.jobId) req.onProgress?.(e.payload.progress, e.payload.found);
  });
  let tracks: FoundTrack[];
  try {
    tracks = await invoke<FoundTrack[]>("find_objects", { request: { jobId: req.jobId, anchor, ranges, sensitivity: req.sensitivity } });
  } finally {
    unlisten();
  }
  return tracks.flatMap((track) => {
    const span = searched[track.rangeIndex];
    if (!span) return [];
    const fit = sizes.get(span.clip.sourcePath)!;
    const speed = span.clip.speed ?? 1;
    const frames = track.samples
      .filter((s) => s.t >= span.clip.start - 1e-6 && s.t <= span.clip.end + 1e-6)
      .map((s) => {
        const g = forward(span.clip, fit, s.t);
        const [x0, x1] = [toOutX(g, s.x - s.w / 2), toOutX(g, s.x + s.w / 2)];
        const [y0, y1] = [toOutY(g, s.y - s.h / 2), toOutY(g, s.y + s.h / 2)];
        return { t: span.outStart + (s.t - span.clip.start) / speed, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      })
      // Only what's actually on the frame.
      .filter((f) => f.cx + f.w / 2 > 0 && f.cx - f.w / 2 < 1 && f.cy + f.h / 2 > 0 && f.cy - f.h / 2 < 1);
    return frames.length >= 2 ? [{ frames }] : [];
  });
}

export const cancelFind = (jobId: string) => invoke("cancel_find_objects", { jobId }).catch(() => {});

// ---- Appearances -> overlays -----------------------------------------------------------------

export interface Covers {
  blurs: BlurOverlay[];
  images: ImageOverlay[];
}

// Overlays hiding every appearance with `effect`, each `padding` (fraction of its size) bigger than
// what was found so edges don't peek out. `W`/`H`: the frame in pixels (for keyframe precision).
export function coversFor(appearances: Appearance[], effect: HideEffect, shape: HideShape, padding: number, W: number, H: number): Covers {
  const covers: Covers = { blurs: [], images: [] };
  const now = Date.now();
  for (const a of appearances) {
    const first = a.frames[0];
    const startTime = first.t;
    const endTime = a.frames[a.frames.length - 1].t + FIND_STEP;
    const grow = 1 + Math.max(0, padding) * 2;
    if (effect.kind === "blur") {
      // A blur region keeps its size - the largest the object gets - and follows its centre.
      const w = Math.min(1, Math.max(...a.frames.map((f) => f.w)) * grow);
      const h = Math.min(1, Math.max(...a.frames.map((f) => f.h)) * grow);
      const baked: OverlayKeyframe[] = a.frames.map((f) => ({ time: f.t - startTime, x: f.cx - w / 2, y: f.cy - h / 2, scale: 1, opacity: 1, easing: "linear" }));
      const keyframes = simplifyTimed(baked, (k) => [k.x * W, k.y * H], SIMPLIFY_TOLERANCE_PX);
      covers.blurs.push({
        id: crypto.randomUUID(),
        x: keyframes[0].x,
        y: keyframes[0].y,
        width: w,
        height: h,
        intensity: effect.strength,
        shape,
        keyframes: keyframes.length > 1 ? keyframes : undefined,
        startTime,
        endTime,
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }
    // A cover keeps the first find's proportions and follows the object's centre and size.
    const w0 = first.w * grow;
    const h0 = first.h * grow;
    const baked: OverlayKeyframe[] = a.frames.map((f) => ({ time: f.t - startTime, x: f.cx - w0 / 2, y: f.cy - h0 / 2, scale: first.w > 0 ? f.w / first.w : 1, opacity: 1, easing: "linear" }));
    const keyframes = simplifyTimed(baked, (k) => [k.x * W, k.y * H, k.scale * Math.max(w0 * W, h0 * H) * 0.5], SIMPLIFY_TOLERANCE_PX);
    const asset: OverlayAsset | undefined =
      effect.kind === "color"
        ? { ...assetEntry(shape === "ellipse" ? "circle" : "rectangle").defaults, kind: shape === "ellipse" ? "circle" : "rectangle", color: effect.color, color2: undefined, entrance: "none", exit: false, loop: "none", glow: false, outline: false }
        : undefined;
    covers.images.push({
      id: crypto.randomUUID(),
      src: effect.kind === "image" ? effect.path : "",
      asset,
      x: keyframes[0].x,
      y: keyframes[0].y,
      width: w0,
      height: h0,
      opacity: 1,
      // A picture over an ellipse-shaped find is rounded off into one.
      cornerRadius: effect.kind === "image" && shape === "ellipse" ? Math.min(w0 * (W / H), h0) / 2 : undefined,
      keyframes: keyframes.length > 1 ? keyframes : undefined,
      startTime,
      endTime,
      createdAt: now,
      updatedAt: now,
    });
  }
  return covers;
}
