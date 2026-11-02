// utils/gradeLooks.ts
//
// Built-in creative looks - film stock, teal & orange, moody, golden hour, cyberpunk night, bleach
// bypass, pastel, noir. Each is a per-pixel function of gamma-encoded RGB (0..1), applied as the
// last step of a clip's grade (gradePixel, colorGrade.ts) and therefore baked into the same LUT the
// preview's WebGL layer and export's lut3d both use - a look previews exactly as it exports.
import type { GradeLookName } from "./videoEditTypes";

type RGB = [number, number, number];

export const GRADE_LOOKS: { value: GradeLookName; label: string; title: string }[] = [
  { value: "film", label: "Film", title: "Soft film stock - lifted blacks, warm highlights, gentle contrast" },
  { value: "tealorange", label: "Teal & orange", title: "Blockbuster - teal shadows, warm skin and highlights" },
  { value: "moody", label: "Moody", title: "Muted, cool shadows, a little faded" },
  { value: "golden", label: "Golden hour", title: "Warm, glowing sunset light" },
  { value: "cyber", label: "Neon night", title: "Magenta shadows, cyan highlights, vivid" },
  { value: "bleach", label: "Bleach", title: "Bleach bypass - desaturated and punchy" },
  { value: "pastel", label: "Pastel", title: "Airy, soft and light" },
  { value: "noir", label: "Noir", title: "High-contrast black and white" },
];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// An S-curve pulling `a` (0..1) of the way from linear toward smoothstep.
const curve = (x: number, a: number) => {
  const c = clamp01(x);
  return c + a * (c * c * (3 - 2 * c) - c);
};
const saturate = ([r, g, b]: RGB, s: number): RGB => {
  const y = luma(r, g, b);
  return [y + (r - y) * s, y + (g - y) * s, y + (b - y) * s];
};
// Adds `shadow` weighted by how dark the pixel is and `high` by how bright.
const splitTone = ([r, g, b]: RGB, shadow: RGB, high: RGB): RGB => {
  const y = clamp01(luma(r, g, b));
  const ws = (1 - y) * (1 - y);
  const wh = y * y;
  return [r + shadow[0] * ws + high[0] * wh, g + shadow[1] * ws + high[1] * wh, b + shadow[2] * ws + high[2] * wh];
};
// Lifts the blacks to `lift` and brings the whites down to `top`.
const fade = ([r, g, b]: RGB, lift: number, top = 1): RGB => {
  const k = top - lift;
  return [lift + r * k, lift + g * k, lift + b * k];
};
const each = (c: RGB, f: (v: number) => number): RGB => [f(c[0]), f(c[1]), f(c[2])];

function look(name: GradeLookName, c: RGB): RGB {
  switch (name) {
    case "film": {
      let o = each(c, (v) => curve(v, 0.45));
      o = splitTone(o, [-0.015, 0.035, 0.03], [0.08, 0.025, -0.06]);
      o = saturate(o, 0.88);
      return fade(o, 0.075, 0.96);
    }
    case "tealorange": {
      let o = each(c, (v) => curve(v, 0.45));
      o = splitTone(o, [-0.07, 0.03, 0.09], [0.09, 0.025, -0.08]);
      return saturate(o, 1.18);
    }
    case "moody": {
      let o = each(c, (v) => curve(Math.pow(clamp01(v), 1.12), 0.3));
      o = splitTone(o, [-0.025, 0.01, 0.05], [0.01, 0.005, -0.01]);
      o = saturate(o, 0.72);
      return fade(o, 0.04, 0.95);
    }
    case "golden": {
      let o: RGB = [c[0] * 1.05 + 0.02, c[1] * 1.01 + 0.005, c[2] * 0.86];
      o = splitTone(o, [0.02, 0.0, -0.03], [0.06, 0.035, -0.02]);
      o = each(o, (v) => curve(v, 0.15));
      return saturate(o, 1.1);
    }
    case "cyber": {
      let o = each(c, (v) => curve(v, 0.4));
      o = splitTone(o, [0.06, -0.04, 0.12], [-0.05, 0.05, 0.07]);
      return saturate(o, 1.32);
    }
    case "bleach": {
      const o = saturate(c, 0.45);
      return each(o, (v) => curve(v, 0.75));
    }
    case "pastel": {
      let o = saturate(each(c, (v) => Math.pow(clamp01(v), 0.8)), 0.72);
      o = splitTone(o, [0.05, 0.01, 0.07], [0.03, 0.015, 0.02]);
      return fade(each(o, (v) => curve(v, -0.25)), 0.16, 0.99);
    }
    case "noir": {
      const y = luma(c[0], c[1], c[2]);
      const v = curve(curve(y, 0.8), 0.4);
      return [v * 0.98, v * 0.99, v * 1.02];
    }
  }
}

// The look at `intensity` (0..1) - a straight mix between the pixel and its looked version.
export function applyLook(name: GradeLookName, intensity: number, r: number, g: number, b: number): RGB {
  const [lr, lg, lb] = look(name, [r, g, b]);
  return [clamp01(r + (lr - r) * intensity), clamp01(g + (lg - g) * intensity), clamp01(b + (lb - b) * intensity)];
}
