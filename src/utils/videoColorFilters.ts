// utils/videoColorFilters.ts
//
// Live-preview counterparts to conversion.rs's export-side color grade/Ken Burns filters
// (color_filter_chain/ken_burns_chain) - CSS approximations of the same ffmpeg `eq`/
// `colorbalance`/`vignette` formulas, tuned to look comparably strong at the same intensity, not
// byte-identical output (a CSS `filter` and an ffmpeg pixel filter are never going to match
// exactly). If one side's formula is retuned, retune the other so preview and export don't
// silently drift apart - see the cross-reference comment on color_filter_chain itself.
import { ClipColorFilter, ClipCrop, ClipKenBurns, ColorFilterPreset, KenBurnsPreset, TransitionType } from "./videoEditTypes";

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

// CSS `transform` for a Ken Burns effect at `progress` (0 at the clip's own start, 1 at its own
// end - see ClipKenBurns's own doc comment). Mirrors ken_burns_chain's (conversion.rs) zoom/pan
// amounts approximately, not exactly - a CSS scale/translate and an ffmpeg crop-then-scale don't
// need to match pixel-for-pixel, just read as "the same effect" to the eye.
export function kenBurnsTransform(kb: ClipKenBurns, progress: number): string {
  const amount = kb.intensity ?? 0.5;
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const maxZoom = 1 + 0.25 * amount;
  const maxPanPct = 6 * amount;
  switch (kb.preset) {
    case "zoom-in":
    case "zoom-out": {
      const zoom = kb.preset === "zoom-in" ? 1 + (maxZoom - 1) * clampedProgress : maxZoom - (maxZoom - 1) * clampedProgress;
      // Standard "zoom toward a point" CSS recipe: scale() alone always zooms from the element's
      // own center (its default transform-origin, left untouched rather than reassigned - crop's
      // own translate/scale math, composed alongside this in the same transform string, assumes a
      // center origin too, so changing it here would silently detune crop for any clip that has
      // both effects set). Translating by (0.5-target)*(zoom-1) - a FIXED percentage of the
      // element's own untransformed size, per the CSS spec, unaffected by the scale() it's chained
      // with - shifts the enlarged content so `target` ends up back where it started instead of
      // drifting toward the frame's own center as zoom grows. (0.5, 0.5) - the default when no
      // click position set this - makes both translate terms 0, reducing to the exact pre-existing
      // centered-zoom look.
      const targetX = kb.targetX ?? 0.5;
      const targetY = kb.targetY ?? 0.5;
      const dx = (0.5 - targetX) * (zoom - 1) * 100;
      const dy = (0.5 - targetY) * (zoom - 1) * 100;
      return `translate(${dx}%, ${dy}%) scale(${zoom})`;
    }
    case "pan-left":
      return `scale(${1 + 0.08 * amount}) translateX(${maxPanPct * (0.5 - clampedProgress)}%)`;
    case "pan-right":
      return `scale(${1 + 0.08 * amount}) translateX(${maxPanPct * (clampedProgress - 0.5)}%)`;
    default:
      return "";
  }
}

// CSS `transform` for a static free-form crop window (see ClipCrop's own doc comment,
// videoEditTypes.ts) - the preview counterpart to crop_chain's ffmpeg crop+scale (conversion.rs).
// Non-uniformly scales the <video> element by 1/width horizontally and 1/height vertically (a
// two-argument `scale(sx, sy)`, unlike kenBurnsTransform's uniform zoom - the whole point of a
// free-form crop is that its own aspect ratio can differ from the frame's), then translates so the
// window's own center lands on the element's center - object-fit:contain handles the letterboxing
// the same way it already does for kenBurnsTransform, so this is safe to compose directly with it
// (see VideoPlayer.tsx, which appends kenBurnsTransform's own transform string after this one so
// Ken Burns zooms/pans within the already-cropped window, matching crop_chain running before
// ken_burns_chain on the export side). The non-uniform scale is exactly what makes this preview
// "stretch to fill" rather than letterbox, matching crop_chain's own plain `scale=out_w:out_h`.
export function cropStaticTransform(crop: ClipCrop): string {
  // Falls back to uncropped (1) rather than propagating NaN when width/height aren't valid
  // numbers - guards against a stale {x,y,size} value left over from an older shape this type
  // used earlier (in-memory state from before a shape change, or an already-saved sidecar file
  // written by that older version), same defensive fallback ClipCropOverlay's own `committed`
  // uses for the same reason.
  const width = Number.isFinite(crop.width) ? Math.max(0.05, Math.min(1, crop.width)) : 1;
  const height = Number.isFinite(crop.height) ? Math.max(0.05, Math.min(1, crop.height)) : 1;
  const centerX = crop.x + width / 2;
  const centerY = crop.y + height / 2;
  // translate() percentages resolve against this element's own untransformed border box, and
  // since `scale(...) translate(...)` applies translate BEFORE scale (rightmost function acts on
  // the point first), the offset needed to re-center the window is independent of `scale` itself
  // - same "no division by the scale factor" shape kenBurnsTransform's own translateX(...%)
  // panning already relies on.
  const dxPct = (0.5 - centerX) * 100;
  const dyPct = (0.5 - centerY) * 100;
  return `scale(${1 / width}, ${1 / height}) translate(${dxPct}%, ${dyPct}%)`;
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
  kenBurns?: ClipKenBurns;
  crop?: ClipCrop;
  flipHorizontal?: boolean;
  speed?: number;
  noiseReduction?: number;
}
