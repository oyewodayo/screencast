// utils/cssColor.ts
//
// Reading and rewriting CSS colours for the overlay panels' custom colours: hex for the picker
// and hex field, and an opacity of its own for a highlight box. Any CSS colour string goes in -
// the browser's own parser (a canvas fillStyle) normalises it first.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

let parser: CanvasRenderingContext2D | null = null;

export function parseColor(color: string | undefined): Rgba | null {
  if (!color) return null;
  parser ??= document.createElement("canvas").getContext("2d");
  if (!parser) return null;
  // An invalid colour leaves fillStyle as it was - start from a sentinel to tell.
  parser.fillStyle = "#010203";
  parser.fillStyle = color;
  const v = String(parser.fillStyle);
  if (v === "#010203" && color.trim().toLowerCase() !== "#010203") return null;
  if (v.startsWith("#")) return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), a: 1 };
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a = "1"] = m[1].split(",").map((p) => p.trim());
  return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

export const toHex = (color: string | undefined): string => {
  const c = parseColor(color);
  return c ? `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}` : "#ffffff";
};

export const alphaOf = (color: string | undefined): number => parseColor(color)?.a ?? 1;

// `color` at opacity `a` (0-1) - a plain hex when fully opaque.
export function withAlpha(color: string, a: number): string {
  const c = parseColor(color);
  if (!c) return color;
  const alpha = Math.round(Math.max(0, Math.min(1, a)) * 100) / 100;
  return alpha >= 1 ? `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}` : `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

// The same colour, whatever its opacity.
export function sameRgb(a: string | undefined, b: string | undefined): boolean {
  const x = parseColor(a);
  const y = parseColor(b);
  return !!x && !!y && x.r === y.r && x.g === y.g && x.b === y.b;
}

// A typed hex ("f80", "#ff8800", "ff8800cc") as #rrggbb, or null.
export function parseHexInput(raw: string): string | null {
  const h = raw.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return `#${h.slice(0, 6)}`;
  return null;
}
