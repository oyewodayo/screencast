// utils/keyframes.ts
//
// Keyframed motion for text and image overlays: position, scale and opacity set at moments in the
// overlay's life, eased in between. One curve shared by everything that draws it - the preview
// (VideoOverlayLayer, every frame) and export (keyframe_expr in conversion.rs builds the identical
// piecewise expression for ffmpeg), so a move looks the same on screen and in the file.
//
// Times are seconds from the overlay's own start (so moving the overlay on the timeline moves its
// animation with it); x/y are the box's top-left as fractions of the frame, like the overlay's own
// x/y; scale is about the box's centre (1 = its normal size); opacity multiplies its own.

export type KeyframeEasing = "linear" | "ease" | "ease-in" | "ease-out" | "hold";

export interface OverlayKeyframe {
  time: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  // How motion eases from this keyframe to the next.
  easing: KeyframeEasing;
}

export const KEYFRAME_EASINGS: { value: KeyframeEasing; label: string }[] = [
  { value: "ease", label: "Smooth" },
  { value: "linear", label: "Linear" },
  { value: "ease-in", label: "Ease in" },
  { value: "ease-out", label: "Ease out" },
  { value: "hold", label: "Hold" },
];

// Two keyframes closer than this are the same moment (one frame at 30fps).
export const KEYFRAME_SNAP_SEC = 1 / 30;

export function easeKeyframe(easing: KeyframeEasing, p: number): number {
  const t = Math.max(0, Math.min(1, p));
  switch (easing) {
    case "ease":
      return t * t * (3 - 2 * t);
    case "ease-in":
      return t * t;
    case "ease-out":
      return 1 - (1 - t) * (1 - t);
    case "hold":
      return 0;
    default:
      return t;
  }
}

export interface KeyframeState {
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

// The animated state at `time` (seconds from the overlay's start), or null without keyframes.
export function keyframeStateAt(keyframes: OverlayKeyframe[] | undefined, time: number): KeyframeState | null {
  if (!keyframes || keyframes.length === 0) return null;
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const state = (k: OverlayKeyframe): KeyframeState => ({ x: k.x, y: k.y, scale: k.scale, opacity: k.opacity });
  if (time <= sorted[0].time) return state(sorted[0]);
  const last = sorted[sorted.length - 1];
  if (time >= last.time) return state(last);
  // The segment [a, b) containing `time` - guaranteed to exist past the two holds above.
  let i = 0;
  while (time >= sorted[i + 1].time) i++;
  const a = sorted[i];
  const b = sorted[i + 1];
  const e = easeKeyframe(a.easing, (time - a.time) / Math.max(1e-3, b.time - a.time));
  const mix = (u: number, v: number) => u + (v - u) * e;
  return { x: mix(a.x, b.x), y: mix(a.y, b.y), scale: mix(a.scale, b.scale), opacity: mix(a.opacity, b.opacity) };
}

// Adds a keyframe, or replaces the one already at (about) that time - what moving or resizing a
// keyframed overlay at the playhead does.
export function upsertKeyframe(keyframes: OverlayKeyframe[] | undefined, keyframe: OverlayKeyframe): OverlayKeyframe[] {
  const rest = (keyframes ?? []).filter((k) => Math.abs(k.time - keyframe.time) > KEYFRAME_SNAP_SEC);
  return [...rest, keyframe].sort((a, b) => a.time - b.time);
}

export function removeKeyframeAt(keyframes: OverlayKeyframe[] | undefined, time: number): OverlayKeyframe[] {
  return (keyframes ?? []).filter((k) => Math.abs(k.time - time) > KEYFRAME_SNAP_SEC);
}

export function keyframeAt(keyframes: OverlayKeyframe[] | undefined, time: number): OverlayKeyframe | undefined {
  return (keyframes ?? []).find((k) => Math.abs(k.time - time) <= KEYFRAME_SNAP_SEC);
}
