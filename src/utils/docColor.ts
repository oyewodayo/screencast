// utils/docColor.ts
//
// Color math + palette + "recently used custom colors" persistence for DocColorPicker.tsx - kept
// separate from the component itself so the conversion functions (used both for the draggable
// saturation/value square and for keeping the hex/RGB text inputs in sync with it) are unit-testable
// in isolation and don't clutter the component's own render logic.
export type RGB = [number, number, number];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const sat = s / 100;
  const val = v / 100;
  const c = val * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = val - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : (d / max) * 100;
  const v = max * 100;
  return [h, s, v];
}

export function hexToRgb(hex: string): RGB | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const int = parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

// Palette grid: a grayscale row plus a hue x lightness matrix, generated from a handful of hue/
// lightness anchor points rather than ~60 hand-picked hex codes - visually in the same spirit as
// Word/Docs' own color grid (a bold "pure" row with lighter tints above and darker shades below)
// without needing to curate that many literal color values. Plain `hsl(...)` strings are valid CSS
// color values on their own, so these are used directly as swatch colors and as what gets applied
// to the doc - no hex conversion needed for palette picks, only for the custom picker below.
export const GRAYSCALE_SWATCHES = ["#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff"];

const PALETTE_HUES = [0, 30, 48, 90, 160, 195, 225, 265, 300];
const PALETTE_LIGHTNESS = [88, 72, 55, 42, 30, 18];

export function buildPaletteGrid(): string[][] {
  return PALETTE_LIGHTNESS.map((lightness) => PALETTE_HUES.map((hue) => `hsl(${hue}, 65%, ${lightness}%)`));
}

// Recently-used custom colors, one localStorage list per picker instance (text vs. highlight get
// their own history via a distinct `storageKey`, same reasoning docLibraryHistory.ts's pin list
// gives for being its own thing rather than shared/global state).
const RECENT_COLORS_KEY_PREFIX = "briefcast.docRecentColors.";
const MAX_RECENT_COLORS = 8;

export function getRecentColors(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(RECENT_COLORS_KEY_PREFIX + storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch (err) {
    console.error(`Failed to load recent colors for ${storageKey}, resetting:`, err);
    return [];
  }
}

export function addRecentColor(storageKey: string, hex: string): string[] {
  const next = [hex, ...getRecentColors(storageKey).filter((c) => c !== hex)].slice(0, MAX_RECENT_COLORS);
  localStorage.setItem(RECENT_COLORS_KEY_PREFIX + storageKey, JSON.stringify(next));
  return next;
}
