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

export const KEN_BURNS_PRESETS: { value: KenBurnsPreset; label: string }[] = [
  { value: "zoom-in", label: "Zoom in" },
  { value: "zoom-out", label: "Zoom out" },
  { value: "pan-left", label: "Pan left" },
  { value: "pan-right", label: "Pan right" },
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
  { value: "pagecurl", label: "Page curl" },
  { value: "colorsweep", label: "Colour sweep" },
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
  const t = Math.max(0, Math.min(1, cf.intensity));
  switch (cf.preset) {
    case "vibrant":
      return `saturate(${1 + 0.6 * t}) contrast(${1 + 0.15 * t})`;
    case "cinematic":
      return `contrast(${1 + 0.2 * t}) saturate(${1 - 0.15 * t}) sepia(${0.08 * t}) hue-rotate(-5deg)`;
    case "bw":
      return `grayscale(${t})`;
    case "warm":
      return `sepia(${0.35 * t}) saturate(${1 + 0.1 * t})`;
    case "cool":
      return `hue-rotate(${10 * t}deg) saturate(${1 + 0.05 * t})`;
    default:
      return "";
  }
}

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

// Ken Burns' window at `progress` (0..1 through the clip): its zoom and centre, as fractions of the
// frame it runs on - ken_burns_chain's arithmetic exactly.
export function kenBurnsWindow(kb: ClipKenBurns, progress: number): { zoom: number; cx: number; cy: number } | null {
  const amount = clamp(kb.intensity ?? 0.5, 0, 1);
  const [s0, s1] = kb.span ?? [0, 1];
  const p = clamp(s0 + (s1 - s0) * clamp(progress, 0, 1), 0, 1);
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
  clip: { crop?: ClipCrop | null; kenBurns?: ClipKenBurns; flipHorizontal?: boolean },
  progress: number
): FrameAffine {
  let m = IDENTITY;
  if (clip.flipHorizontal) m = then(m, -1, 1, 1, 0);
  const crop = clip.crop ? cropWindow(clip.crop) : null;
  if (crop) m = then(m, 1 / crop.w, -crop.x / crop.w, 1 / crop.h, -crop.y / crop.h);
  const win = clip.kenBurns ? kenBurnsWindow(clip.kenBurns, progress) : null;
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
  clip: Pick<Clip, "crop" | "kenBurns" | "flipHorizontal" | "colorFilter">,
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
