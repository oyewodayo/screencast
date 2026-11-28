// utils/studioPolish.ts
//
// Pure planning & preset helpers for 1-Click Studio Polish (StudioPolishPopover.tsx): bundles
// Briefcast's separate polish tools — Screen Style frame, Make it Sound Pro (RNNoise + EQ +
// compressor + limiter + loudness), dead-air silence removal, click-tracked auto-zoom, and
// editable pointer/shortcut chips — into a single reviewable one-click pass.
import { DEFAULT_SCREEN_STYLE, SCREEN_GRADIENTS, type ScreenStyle } from "./screenStyle";
import type { AutoZoomClick } from "../handlers/videoEditHandlers";
import type { Clip } from "./videoEditTypes";

export interface StudioPolishTheme {
  id: string;
  label: string;
  swatch: string;
}

export const STUDIO_POLISH_THEMES: StudioPolishTheme[] = SCREEN_GRADIENTS.map((g) => ({
  id: g.id,
  label: g.label,
  swatch: `linear-gradient(${g.angle}deg,${g.stops.join(",")})`,
}));

export interface StudioPolishOptions {
  frame: boolean;
  themeId: string;
  soundPro: boolean;
  trimSilence: boolean;
  autoZoom: boolean;
  pointerAndKeys: boolean;
}

export interface StudioPolishAvailability {
  hasExistingFrame: boolean;
  existingThemeId: string | null;
  hasSound: boolean;
  hasClickSidecar: boolean;
  hasEditablePointer: boolean;
  shortcutCount: number;
}

export interface StudioPolishStepResult {
  key: "frame" | "sound" | "silence" | "zoom" | "pointer";
  label: string;
  detail: string;
  status: "done" | "skipped" | "error";
}

export function defaultStudioPolishOptions(avail: StudioPolishAvailability): StudioPolishOptions {
  return {
    frame: true,
    themeId: avail.existingThemeId ?? "dusk",
    soundPro: avail.hasSound,
    trimSilence: avail.hasSound,
    autoZoom: avail.hasClickSidecar,
    pointerAndKeys: avail.hasEditablePointer || avail.shortcutCount > 0,
  };
}

export function buildStudioScreenStyle(themeId: string, existing: ScreenStyle | null): ScreenStyle {
  const base = existing ?? DEFAULT_SCREEN_STYLE;
  return {
    ...base,
    background: { kind: "gradient", preset: themeId },
  };
}

export function buildStudioImageScreenStyle(imagePath: string, existing: ScreenStyle | null): ScreenStyle {
  const base = existing ?? DEFAULT_SCREEN_STYLE;
  return {
    ...base,
    background: { kind: "image", path: imagePath },
  };
}

export function buildStudioColorScreenStyle(color: string, existing: ScreenStyle | null): ScreenStyle {
  const base = existing ?? DEFAULT_SCREEN_STYLE;
  return {
    ...base,
    background: { kind: "color", color },
  };
}

// Intersects raw source-time silence ranges with a clip's active [start, end) window.
export function filterSilentRangesForClip(
  clip: Pick<Clip, "start" | "end">,
  ranges: { start: number; end: number }[]
): { start: number; end: number }[] {
  return ranges
    .map((r) => ({
      start: Math.max(clip.start, r.start),
      end: Math.min(clip.end, r.end),
    }))
    .filter((r) => r.end - r.start > 0.05);
}

// Filters raw click-sidecar entries to a clip's active [start, end) range.
export function filterClicksForClip(
  clip: Pick<Clip, "start" | "end">,
  rawClicks: { elapsedSecs: number; xFraction: number; yFraction: number }[]
): AutoZoomClick[] {
  return rawClicks
    .filter((c) => Number.isFinite(c.elapsedSecs) && c.elapsedSecs > clip.start && c.elapsedSecs < clip.end)
    .map((c) => ({ time: c.elapsedSecs, x: c.xFraction, y: c.yFraction }));
}

export function totalRangeDuration(ranges: { start: number; end: number }[]): number {
  return ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0);
}
