// utils/videoColorFilters.ts
//
// Live-preview counterparts to conversion.rs's export-side color grade/Ken Burns filters
// (color_filter_chain/ken_burns_chain) - CSS approximations of the same ffmpeg `eq`/
// `colorbalance`/`vignette` formulas, tuned to look comparably strong at the same intensity, not
// byte-identical output (a CSS `filter` and an ffmpeg pixel filter are never going to match
// exactly). If one side's formula is retuned, retune the other so preview and export don't
// silently drift apart - see the cross-reference comment on color_filter_chain itself.
import type { ClipSpeedRamp } from "./clipTiming";
import { AudioCleanup, Clip, ClipColorFilter, ClipGrade, ClipCrop, ClipKenBurns, ColorFilterPreset, KenBurnsPreset, TransitionType } from "./videoEditTypes";

export const COLOR_FILTER_PRESETS: { value: ColorFilterPreset; label: string }[] = [
  { value: "none", label: "None" },
  { value: "vibrant", label: "Vibrant" },
  { value: "cinematic", label: "Cinematic" },
  { value: "bw", label: "B&W" },
  { value: "warm", label: "Warm" },
  { value: "cool", label: "Cool" },
  { value: "vignette", label: "Vignette" },
];

export const KEN_BURNS_PRESETS: { value: KenBurnsPreset; label: string; hint: string }[] = [
  { value: "zoom-in", label: "Zoom in", hint: "A steady push in" },
  { value: "zoom-out", label: "Zoom out", hint: "A steady pull back" },
  { value: "push", label: "Smooth push", hint: "Eases in, glides, eases to a stop - a dolly move" },
  { value: "punch-in", label: "Punch in", hint: "A quick snap closer that springs into place" },
  { value: "bounce-in", label: "Bounce in", hint: "Zooms in on an elastic spring" },
  { value: "pan-left", label: "Pan ←", hint: "Travels right to left" },
  { value: "pan-right", label: "Pan →", hint: "Travels left to right" },
  { value: "pan-up", label: "Pan ↑", hint: "Tilts from the bottom up" },
  { value: "pan-down", label: "Pan ↓", hint: "Tilts from the top down" },
  { value: "drift", label: "Drift", hint: "A slow diagonal float across the frame" },
  { value: "sway", label: "Sway", hint: "Rocks gently side to side" },
  { value: "float", label: "Float", hint: "Circles slowly, as if hovering" },
  { value: "breathe", label: "Breathe", hint: "Slowly pushes in and pulls back, over and over" },
  { value: "pulse", label: "Pulse", hint: "Punchy zoom kicks on a beat" },
  { value: "shake", label: "Shake", hint: "Handheld camera wobble" },
  { value: "vibrate", label: "Vibrate", hint: "A fast rumble, like an impact or a bass drop" },
];

// Names ffmpeg's own `xfade` transition names directly - see TransitionType's own doc comment
// (videoEditTypes.ts) for why there's no separate friendly-name mapping layer, and
// ALLOWED_TRANSITIONS (conversion.rs) for the export-side allowlist this must stay in sync with.
export const TRANSITION_PRESETS: { value: TransitionType; label: string }[] = [
  { value: "fade", label: "Crossfade" },
  { value: "lightleak", label: "Light leak" },
  { value: "fadewhite", label: "Flash" },
  { value: "whip", label: "Whip" },
  { value: "zoomblur", label: "Zoom blur" },
  { value: "push", label: "Push" },
  { value: "cube", label: "Cube" },
  { value: "tiles", label: "Tile wall" },
  { value: "split", label: "Split" },
  { value: "strips", label: "Strips" },
  { value: "glitch", label: "Glitch" },
  { value: "spin", label: "Spin" },
  { value: "beam", label: "Light beam" },
  { value: "slice", label: "Slice" },
  { value: "flip", label: "Flip" },
  { value: "pagecurl", label: "Page curl" },
  { value: "colorsweep", label: "Colour sweep" },
  { value: "iris", label: "Shape" },
  { value: "blocks", label: "Blocks" },
  { value: "mosaic", label: "Grid" },
  { value: "slider", label: "Before/after" },
  { value: "horzopen", label: "Bar open" },
  { value: "fadeblack", label: "Fade to black" },
  { value: "dissolve", label: "Dissolve" },
  { value: "wipeleft", label: "Wipe ←" },
  { value: "wiperight", label: "Wipe →" },
  { value: "slideleft", label: "Slide ←" },
  { value: "slideright", label: "Slide →" },
  { value: "circleopen", label: "Circle open" },
  { value: "zoomin", label: "Zoom in" },
  { value: "radial", label: "Radial" },
  { value: "pixelize", label: "Pixelize" },
];

// "vignette" returns "" here - it has no CSS `filter` primitive, so VideoPlayer renders it as a
// separate radial-gradient div over frameRect instead (see its own comment for why).
export function cssFilterForColorPreset(cf: ClipColorFilter): string {
  return cssFilterFromOps(colorPresetOps(cf));
}

// One CSS filter function on colour - what both the preview's CSS and export's colour matrix are
// built from (color_filter_chain / css_op_from_spec in conversion.rs compose the same list).
export type CssColorOpName = "brightness" | "contrast" | "saturate" | "hue-rotate" | "sepia" | "grayscale";
export interface CssColorOp {
  op: CssColorOpName;
  value: number; // degrees for hue-rotate
}

export function colorPresetOps(cf: ClipColorFilter): CssColorOp[] {
  const t = Math.max(0, Math.min(1, cf.intensity));
  switch (cf.preset) {
    case "vibrant":
      return [{ op: "saturate", value: 1 + 0.6 * t }, { op: "contrast", value: 1 + 0.15 * t }];
    case "cinematic":
      return [
        { op: "contrast", value: 1 + 0.2 * t },
        { op: "saturate", value: 1 - 0.15 * t },
        { op: "sepia", value: 0.08 * t },
        { op: "hue-rotate", value: -5 },
      ];
    case "bw":
      return [{ op: "grayscale", value: t }];
    case "warm":
      return [{ op: "sepia", value: 0.35 * t }, { op: "saturate", value: 1 + 0.1 * t }];
    case "cool":
      return [{ op: "hue-rotate", value: 10 * t }, { op: "saturate", value: 1 + 0.05 * t }];
    default:
      return [];
  }
}

export const cssFilterFromOps = (ops: CssColorOp[]): string =>
  ops.map(({ op, value }) => (op === "hue-rotate" ? `hue-rotate(${value}deg)` : `${op}(${value})`)).join(" ");

// The "vignette" preset's darkened edges as a CSS background over the frame (VideoPlayer's
// vignette layer and the colour picker's tiles).
export const vignetteBackground = (intensity: number): string =>
  `radial-gradient(ellipse at center, transparent ${40 - 15 * intensity}%, rgba(0,0,0,${(0.6 * intensity).toFixed(3)}) 100%)`;

// ---- Frame geometry: flip, crop and Ken Burns as one exact map ----------------------------------
//
// Export runs, per segment: hflip -> crop (stretched back to the frame) -> Ken Burns (a window
// cropped out of that and scaled back up) - segment_effect_chain / crop_chain / ken_burns_chain in
// conversion.rs. Each step is an axis-aligned scale + offset, so the whole chain is one affine map
// per axis from a point of the source frame (0..1) to where it lands in the output frame (0..1):
// out = a*u + b. The preview draws the picture through exactly that map, so what's on screen is
// the export's framing to the pixel - same amounts, same clamping, same composition order.

export interface FrameAffine {
  ax: number;
  bx: number;
  ay: number;
  by: number;
}

const IDENTITY: FrameAffine = { ax: 1, bx: 0, ay: 1, by: 0 };

// then(m, scale, offset): m followed by u -> scale*u + offset, per axis.
function then(m: FrameAffine, sx: number, ox: number, sy: number, oy: number): FrameAffine {
  return { ax: m.ax * sx, bx: m.bx * sx + ox, ay: m.ay * sy, by: m.by * sy + oy };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// The crop window export uses (crop_chain): sizes at least 5%, kept fully inside the frame.
function cropWindow(crop: ClipCrop): { x: number; y: number; w: number; h: number } | null {
  if (!Number.isFinite(crop.width) || !Number.isFinite(crop.height)) return null;
  const w = clamp(crop.width, 0.05, 1);
  const h = clamp(crop.height, 0.05, 1);
  return { x: clamp(crop.x || 0, 0, 1 - w), y: clamp(crop.y || 0, 0, 1 - h), w, h };
}

// Shared by kenBurnsWindow and ken_burns_chain (conversion.rs), which spells each one out as an
// ffmpeg expression: change one, change the other.
const TAU = 2 * Math.PI;
// How much faster "vibrate"'s wobble runs than "shake"'s (top component ~24Hz - under a 30fps
// export's Nyquist limit, so it reads as a rumble, not aliasing).
const KB_VIBRATE_RATE = 5;
const smooth01 = (x: number) => {
  const c = clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
};
const easeOutBack01 = (x: number) => {
  const c = clamp(x, 0, 1) - 1;
  return 1 + 2.70158 * c * c * c + 1.70158 * c * c;
};
// Spring settling at 1 (decaying cosine), 0 at x=0.
const elastic01 = (x: number) => {
  const c = clamp(x, 0, 1);
  return 1 - Math.exp(-6 * c) * Math.cos(3 * TAU * c);
};
// Smooth pseudo-random wobble in -1..1: three incommensurate sines. `f` scales every frequency.
const wobble = (t: number, f: number, phase: number) =>
  0.5 * Math.sin(TAU * 1.1 * f * t + phase) + 0.3 * Math.sin(TAU * 2.3 * f * t + 1.3 + phase) + 0.2 * Math.sin(TAU * 4.7 * f * t + 2.1 + phase);

// The window centred on (cx, cy) at `zoom`, kept fully on the frame (crop_chain's clamp).
const onFrame = (zoom: number, cx: number, cy: number) => {
  const half = 1 / (2 * zoom);
  return { zoom, cx: clamp(cx, half, 1 - half), cy: clamp(cy, half, 1 - half) };
};

// Ken Burns' window at `progress` (0..1 through the clip): its zoom and centre, as fractions of the
// frame it runs on - ken_burns_chain's arithmetic exactly. `durationSec` is the clip's own source
// length: the moving-on-a-clock presets (oscillations, a punch-in's snap) run in its seconds.
export function kenBurnsWindow(kb: ClipKenBurns, progress: number, durationSec = 5): { zoom: number; cx: number; cy: number } | null {
  const amount = clamp(kb.intensity ?? 0.5, 0, 1);
  const [s0, s1] = kb.span ?? [0, 1];
  const p = clamp(s0 + (s1 - s0) * clamp(progress, 0, 1), 0, 1);
  // Seconds along the whole move (a split-off piece continues its parent's clock).
  const t = p * (Math.max(0.01, durationSec) / Math.max(1e-3, s1 - s0));
  const tx = clamp(kb.targetX ?? 0.5, 0, 1);
  const ty = clamp(kb.targetY ?? 0.5, 0, 1);
  switch (kb.preset) {
    case "pan-up":
    case "pan-down": {
      const zoom = 1 + 0.15 * amount;
      const dir = kb.preset === "pan-down" ? p : 1 - p;
      return { zoom, cx: 0.5, cy: (1 - 1 / zoom) * dir + 1 / (2 * zoom) };
    }
    case "push":
      return onFrame(1 + 0.3 * amount * smooth01(p), tx, ty);
    case "punch-in":
      return onFrame(1 + 0.4 * amount * easeOutBack01(t / 0.35), tx, ty);
    case "bounce-in":
      return onFrame(1 + 0.3 * amount * elastic01(t / 1.2), tx, ty);
    case "drift": {
      const zoom = 1 + 0.2 * amount;
      const travel = 1 - 1 / zoom;
      return { zoom, cx: 1 / (2 * zoom) + travel * p, cy: 1 / (2 * zoom) + travel * p };
    }
    case "sway": {
      const zoom = 1 + 0.12 * amount;
      return onFrame(zoom, 0.5 + 0.48 * (1 - 1 / zoom) * Math.sin((TAU * t) / 2.5), 0.5);
    }
    case "float": {
      const zoom = 1 + 0.14 * amount;
      const r = 0.45 * (1 - 1 / zoom);
      return onFrame(zoom, 0.5 + r * Math.cos((TAU * t) / 4), 0.5 + r * Math.sin((TAU * t) / 4));
    }
    case "breathe":
      return onFrame(1 + 0.12 * amount * (0.5 - 0.5 * Math.cos((TAU * t) / 3)), tx, ty);
    case "pulse":
      return onFrame(1 + 0.1 * amount * Math.pow(0.5 + 0.5 * Math.cos((TAU * t) / 0.5), 6), tx, ty);
    case "shake":
    case "vibrate": {
      // Zoomed in just enough that the wobble never shows an edge.
      const fast = kb.preset === "vibrate";
      const zoom = 1 + (fast ? 0.02 + 0.04 * amount : 0.03 + 0.07 * amount);
      const m = 0.45 * (1 - 1 / zoom);
      const f = fast ? KB_VIBRATE_RATE : 1;
      return onFrame(zoom, 0.5 + m * wobble(t, f, 0), 0.5 + m * wobble(t, f, 4.1));
    }
  }
  switch (kb.preset) {
    case "zoom-in":
    case "zoom-out": {
      const top = 1 + 0.3 * amount;
      const zoom = kb.preset === "zoom-in" ? 1 + (top - 1) * p : top - (top - 1) * p;
      const half = 1 / (2 * zoom);
      // x = clip(tx*iw - ow/2, 0, iw - ow): the window centred on the target, kept on-frame.
      return { zoom, cx: clamp(clamp(kb.targetX ?? 0.5, 0, 1), half, 1 - half), cy: clamp(clamp(kb.targetY ?? 0.5, 0, 1), half, 1 - half) };
    }
    case "pan-left":
    case "pan-right": {
      const zoom = 1 + 0.15 * amount;
      const dir = kb.preset === "pan-right" ? p : 1 - p;
      // x = (iw - ow) * dir
      return { zoom, cx: (1 - 1 / zoom) * dir + 1 / (2 * zoom), cy: 0.5 };
    }
    default:
      return null;
  }
}

// Where each point of the source frame lands in the output frame for this clip at `progress`.
export function clipFrameAffine(
  // start/end: the clip's own source range (its Ken Burns clock); ActiveClipEffects-style
  // sourceStart/sourceEnd work too.
  clip: { crop?: ClipCrop | null; kenBurns?: ClipKenBurns; flipHorizontal?: boolean; start?: number; end?: number; sourceStart?: number; sourceEnd?: number },
  progress: number
): FrameAffine {
  let m = IDENTITY;
  if (clip.flipHorizontal) m = then(m, -1, 1, 1, 0);
  const crop = clip.crop ? cropWindow(clip.crop) : null;
  if (crop) m = then(m, 1 / crop.w, -crop.x / crop.w, 1 / crop.h, -crop.y / crop.h);
  const start = clip.start ?? clip.sourceStart;
  const end = clip.end ?? clip.sourceEnd;
  const duration = start !== undefined && end !== undefined ? end - start : undefined;
  const win = clip.kenBurns ? kenBurnsWindow(clip.kenBurns, progress, duration) : null;
  if (win) m = then(m, win.zoom, 0.5 - win.cx * win.zoom, win.zoom, 0.5 - win.cy * win.zoom);
  return m;
}

export function isIdentityAffine(m: FrameAffine): boolean {
  return Math.abs(m.ax - 1) < 1e-9 && Math.abs(m.ay - 1) < 1e-9 && Math.abs(m.bx) < 1e-9 && Math.abs(m.by) < 1e-9;
}

// The map as a CSS transform (default centre origin) on an element showing the frame, centred in
// it. `frame` is the frame's size in px when the element is larger (the offset is then in px);
// omitted, the element IS the frame and the offset is in %.
export function affineCssTransform(m: FrameAffine, frame?: { width: number; height: number }): string {
  if (isIdentityAffine(m)) return "";
  // centre-origin: out = 0.5 + a*(u - 0.5) + t  =>  t = b - 0.5 + 0.5*a
  const tx = m.bx - 0.5 + 0.5 * m.ax;
  const ty = m.by - 0.5 + 0.5 * m.ay;
  const offset = frame ? `${tx * frame.width}px, ${ty * frame.height}px` : `${tx * 100}%, ${ty * 100}%`;
  return `translate(${offset}) scale(${m.ax}, ${m.ay})`;
}

// How the player draws a clip so it looks exactly like the export: its <video> letterboxes the
// clip's own picture into the element (object-fit: contain), while export first fits that picture
// into the PROJECT frame (frame_fit_chain) and then runs flip/crop/Ken Burns on the frame. Per
// axis, an element point X maps to: picture fraction -> its place in the fitted project frame ->
// clipFrameAffine -> the project frame's rectangle on screen. That's one `matrix()` (origin 0 0)
// plus a clip-path keeping only what lands inside the frame - so nothing spills over the bars.
export interface PlayerFraming {
  transform: string;
  clipPath: string;
  // Where the project frame sits in the element - what overlays, captions and the vignette use.
  frameRect: { x: number; y: number; width: number; height: number };
  // `transform` as numbers: screen = (a*X + e, d*Y + f), origin 0 0.
  matrix: { a: number; d: number; e: number; f: number };
}

// The framing with the frame's picture placed into `inset` instead of the whole frame (fractions
// of the frame - the Screen Style's content rectangle, screenStyle.ts): one more scale + offset
// after it, the clip path unchanged (it's in the element's own space, before the transform).
export function insetFraming(framing: PlayerFraming, inset: { x: number; y: number; width: number; height: number } | null | undefined): PlayerFraming {
  if (!inset) return framing;
  const F = framing.frameRect;
  const sx = inset.width;
  const sy = inset.height;
  const ox = F.x + inset.x * F.width - sx * F.x;
  const oy = F.y + inset.y * F.height - sy * F.y;
  const { a, d, e, f } = framing.matrix;
  const m = { a: sx * a, d: sy * d, e: sx * e + ox, f: sy * f + oy };
  return { ...framing, transform: `matrix(${m.a}, 0, 0, ${m.d}, ${m.e}, ${m.f})`, matrix: m };
}

export function playerFraming(
  m: FrameAffine,
  element: { width: number; height: number },
  picture: { width: number; height: number },
  frame: { width: number; height: number } | null
): PlayerFraming {
  const F = containRect(element.width, element.height, frame?.width ?? picture.width, frame?.height ?? picture.height);
  const C = containRect(element.width, element.height, picture.width, picture.height);
  const inF = containRect(F.width, F.height, picture.width, picture.height);
  const P = { x: F.x + inF.x, y: F.y + inF.y, width: inF.width, height: inF.height };
  // screen = F.x + F.w * (a * f + b),  f = (P.x - F.x + P.w * (X - C.x) / C.w) / F.w
  const axis = (a: number, b: number, f0: number, fw: number, p0: number, pw: number, c0: number, cw: number) => {
    const A = cw > 0 ? (a * pw) / cw : 1;
    const E = f0 + a * (p0 - f0) - A * c0 + fw * b;
    // Visible: screen within the frame AND X within the picture.
    const u0 = (f0 - E) / A;
    const u1 = (f0 + fw - E) / A;
    const lo = Math.max(c0, Math.min(u0, u1));
    const hi = Math.min(c0 + cw, Math.max(u0, u1));
    return { A, E, lo, hi };
  };
  const x = axis(m.ax, m.bx, F.x, F.width, P.x, P.width, C.x, C.width);
  const y = axis(m.ay, m.by, F.y, F.height, P.y, P.height, C.y, C.height);
  const identity = Math.abs(x.A - 1) < 1e-9 && Math.abs(y.A - 1) < 1e-9 && Math.abs(x.E) < 1e-6 && Math.abs(y.E) < 1e-6;
  return {
    transform: identity ? "" : `matrix(${x.A}, 0, 0, ${y.A}, ${x.E}, ${y.E})`,
    clipPath: identity ? "" : `inset(${y.lo}px ${element.width - x.hi}px ${element.height - y.hi}px ${x.lo}px)`,
    frameRect: F,
    matrix: identity ? { a: 1, d: 1, e: 0, f: 0 } : { a: x.A, d: y.A, e: x.E, f: y.E },
  };
}

// The rectangle object-fit: contain draws a `videoW x videoH` picture into, inside a `boxW x boxH`
// element.
export function containRect(boxW: number, boxH: number, videoW: number, videoH: number): { x: number; y: number; width: number; height: number } {
  if (!(videoW > 0 && videoH > 0 && boxW > 0 && boxH > 0)) return { x: 0, y: 0, width: boxW, height: boxH };
  // The fitting axis is exactly the box's (no rounding noise at the frame's edges).
  if (videoW * boxH >= boxW * videoH) {
    const height = (boxW * videoH) / videoW;
    return { x: 0, y: (boxH - height) / 2, width: boxW, height };
  }
  const width = (boxH * videoW) / videoH;
  return { x: (boxW - width) / 2, y: 0, width, height: boxH };
}

// A clip's whole on-screen look at `progress` (0..1 through it) as CSS - the exact framing map
// plus the color preset filter. For elements standing in for a clip's frame elsewhere (they fill
// it exactly): the transition preview's frozen outgoing frame and the clip viewer popup.
export function clipFrameStyle(
  clip: Pick<Clip, "crop" | "kenBurns" | "flipHorizontal" | "colorFilter"> & Partial<Pick<Clip, "start" | "end">>,
  progress: number,
  // The frame's size in px when the styled element is larger than it (centred in it).
  frame?: { width: number; height: number }
): { transform: string; filter: string } {
  const transform = affineCssTransform(clipFrameAffine(clip, progress), frame);
  const filter = clip.colorFilter && clip.colorFilter.preset !== "none" ? cssFilterForColorPreset(clip.colorFilter) : "";
  return { transform, filter };
}

// What VideoTimelineDocker reports upward (onActiveClipChange) and VideoPlayer consumes
// (activeClipEffects prop) - just enough of the active clip's own fields to drive live preview,
// not the whole Clip (id/sourcePath/transitionIn are irrelevant to what's rendered on-screen
// moment to moment).
export interface ActiveClipEffects {
  // The clip's own id - unlike every other field here, not read for live-preview rendering
  // itself, but needed by Dashboard to call updateClipEffects(id, ...) when the on-canvas crop
  // tool (ClipCropOverlay) commits a drag directly against whichever clip is currently on screen.
  id: string;
  sourceStart: number;
  sourceEnd: number;
  colorFilter?: ClipColorFilter;
  // Manual grade / LUT - drawn by VideoPlayer's WebGL layer (GradeCanvas), not CSS.
  grade?: ClipGrade;
  kenBurns?: ClipKenBurns;
  crop?: ClipCrop;
  flipHorizontal?: boolean;
  speed?: number;
  // A speed curve across the clip - VideoPlayer follows it with playbackRate (clipTiming.ts).
  speedRamp?: ClipSpeedRamp;
  noiseReduction?: number;
  audioCleanup?: AudioCleanup;
  // The clip's own sound is off (Clip.muted) - VideoPlayer silences the track while it plays.
  muted?: boolean;
  // Which file this clip plays from - VideoPlayer decodes its noise sample from here.
  sourcePath?: string;
  // The project frame in px (the primary file's size - what export renders at). The player fits
  // every clip into it, as export does, so a clip of another shape previews letterboxed in it.
  frame?: { width: number; height: number };
}

// Everything switched on for a clip, as short labels - the badges its timeline block carries, so a
// clip's look and effects are visible without opening it. Transitions are drawn on the cut instead.
export interface ClipEffectBadge {
  key: string;
  label: string;
  // Badge colour family.
  tone: "look" | "fx" | "motion" | "time" | "frame" | "sound";
}
export function clipEffectBadges(
  clip: Pick<Clip, "grade" | "colorFilter" | "fx" | "kenBurns" | "speed" | "speedRamp" | "crop" | "flipHorizontal" | "stabilize" | "muted" | "reversedFrom">,
  labels: { look?: (name: string) => string | undefined; fx?: (kind: string) => string | undefined } = {}
): ClipEffectBadge[] {
  const out: ClipEffectBadge[] = [];
  const g = clip.grade;
  if (g?.look && g.look.intensity > 0) out.push({ key: "look", label: labels.look?.(g.look.name) ?? g.look.name, tone: "look" });
  const manual = g && (["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"] as const).some((k) => Math.abs(g[k] ?? 0) > 1e-4);
  if (manual || (g?.lut && g.lut.intensity > 0)) out.push({ key: "grade", label: g?.lut && g.lut.intensity > 0 ? "LUT" : "Graded", tone: "look" });
  if (clip.colorFilter && clip.colorFilter.preset !== "none")
    out.push({ key: "color", label: COLOR_FILTER_PRESETS.find((p) => p.value === clip.colorFilter!.preset)?.label ?? clip.colorFilter.preset, tone: "look" });
  if (clip.fx && clip.fx.intensity > 0) out.push({ key: "fx", label: labels.fx?.(clip.fx.kind) ?? clip.fx.kind, tone: "fx" });
  if (clip.kenBurns) out.push({ key: "motion", label: KEN_BURNS_PRESETS.find((p) => p.value === clip.kenBurns!.preset)?.label ?? "Motion", tone: "motion" });
  if (clip.speedRamp) out.push({ key: "speed", label: "Ramp", tone: "time" });
  else if (clip.speed && Math.abs(clip.speed - 1) > 1e-3) out.push({ key: "speed", label: `${+clip.speed.toFixed(2)}x`, tone: "time" });
  if (clip.reversedFrom) out.push({ key: "reverse", label: "Reverse", tone: "time" });
  if (clip.crop) out.push({ key: "crop", label: "Crop", tone: "frame" });
  if (clip.flipHorizontal) out.push({ key: "flip", label: "Mirror", tone: "frame" });
  if (clip.stabilize) out.push({ key: "steady", label: "Steady", tone: "frame" });
  if (clip.muted) out.push({ key: "muted", label: "Muted", tone: "sound" });
  return out;
}
