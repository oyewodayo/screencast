// utils/stage/stageColor.ts
//
// Colours the Stage animates between, as OKLab coordinates plus alpha. OKLab is perceptually even:
// halfway from grey to black looks halfway, and a hue change doesn't pass through a muddy midpoint
// the way mixing sRGB channels does - which matters for the dimming and colour settles a beat plays.
// Pure (no canvas), so the engine runs the same in tests, the preview and export.

export type Oklab = [number, number, number, number];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() with 0-255 channels; null for anything else (the
// Stage then switches that colour at the beat instead of animating it).
export function parseStageColor(color: string | undefined): [number, number, number, number] | null {
  if (!color) return null;
  const c = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(c);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const v = h.split("").map((ch) => parseInt(ch + ch, 16));
      return [v[0], v[1], v[2], h.length === 4 ? v[3] / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
      return [v[0], v[1], v[2], h.length === 8 ? v[3] / 255 : 1];
    }
    return null;
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(c);
  if (fn) {
    const a = fn[4] === undefined ? 1 : fn[4].endsWith("%") ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
    return [parseFloat(fn[1]), parseFloat(fn[2]), parseFloat(fn[3]), clamp01(a)];
  }
  return null;
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

// A scene uses a handful of colours, converted thousands of times while it compiles.
const oklabCache = new Map<string, Oklab | null>();

export function toOklab(color: string | undefined): Oklab | null {
  if (color === undefined) return null;
  const hit = oklabCache.get(color);
  if (hit !== undefined) return hit;
  const lab = oklabUncached(color);
  if (oklabCache.size > 1024) oklabCache.clear();
  oklabCache.set(color, lab);
  return lab;
}

function oklabUncached(color: string): Oklab | null {
  const rgba = parseStageColor(color);
  if (!rgba) return null;
  const [r, g, b] = rgba.slice(0, 3).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    rgba[3],
  ];
}

// An OKLab colour as sRGB: 0-255 channels (clipped into the gamut) and 0-1 alpha.
export function oklabToRgb([L, A, B, alpha]: Oklab): [number, number, number, number] {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  const ch = (v: number) => Math.round(Math.max(0, Math.min(255, fromLinear(v))));
  return [
    ch(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    ch(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    ch(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    Math.round(clamp01(alpha) * 1000) / 1000,
  ];
}

export const rgbCss = (c: [number, number, number, number]) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})`;

// An OKLab colour as a CSS rgba() string, clipped into sRGB.
export function fromOklab(lab: Oklab): string {
  return rgbCss(oklabToRgb(lab));
}
