// utils/videoColorFilters.ts
//
// Live-preview counterparts to conversion.rs's export-side color grade/Ken Burns filters
// (color_filter_chain/ken_burns_chain) - CSS approximations of the same ffmpeg `eq`/
// `colorbalance`/`vignette` formulas, tuned to look comparably strong at the same intensity, not
// byte-identical output (a CSS `filter` and an ffmpeg pixel filter are never going to match
// exactly). If one side's formula is retuned, retune the other so preview and export don't
// silently drift apart - see the cross-reference comment on color_filter_chain itself.
import { ClipColorFilter, ClipKenBurns, ColorFilterPreset, KenBurnsPreset, TransitionType } from "./videoEditTypes";

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
      return `scale(${1 + (maxZoom - 1) * clampedProgress})`;
    case "zoom-out":
      return `scale(${maxZoom - (maxZoom - 1) * clampedProgress})`;
    case "pan-left":
      return `scale(${1 + 0.08 * amount}) translateX(${maxPanPct * (0.5 - clampedProgress)}%)`;
    case "pan-right":
      return `scale(${1 + 0.08 * amount}) translateX(${maxPanPct * (clampedProgress - 0.5)}%)`;
    default:
      return "";
  }
}

// What VideoTimelineDocker reports upward (onActiveClipChange) and VideoPlayer consumes
// (activeClipEffects prop) - just enough of the active clip's own fields to drive live preview,
// not the whole Clip (id/sourcePath/transitionIn are irrelevant to what's rendered on-screen
// moment to moment).
export interface ActiveClipEffects {
  sourceStart: number;
  sourceEnd: number;
  colorFilter?: ClipColorFilter;
  kenBurns?: ClipKenBurns;
}
