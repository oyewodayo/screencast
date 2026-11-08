// utils/blendModes.ts
//
// Blend modes for overlays (text, pictures, elements, picture-in-picture). The preview sets the
// CSS mix-blend-mode on the overlay's element, over the video; export composites the W3C formula
// for the same mode (blend_composite, conversion.rs). Each mode here was measured against the
// spec's formula in ffmpeg on all 65,536 pairs of 8-bit values - within 2 levels. Soft light,
// colour dodge and colour burn aren't offered: ffmpeg's versions differ from the browser's.

import type { CSSProperties } from "react";
import type { BlendMode } from "./videoEditTypes";

export const BLEND_MODES: { value: BlendMode; label: string; hint: string }[] = [
  { value: "normal", label: "Normal", hint: "Covers what's underneath" },
  { value: "multiply", label: "Multiply", hint: "Darkens - white disappears (scanned ink, shadows)" },
  { value: "screen", label: "Screen", hint: "Lightens - black disappears (light leaks, flares, glows)" },
  { value: "overlay", label: "Overlay", hint: "Adds contrast and texture, keeps the picture's light and dark" },
  { value: "hard-light", label: "Hard light", hint: "Strong contrast, led by the overlay" },
  { value: "darken", label: "Darken", hint: "Keeps whichever is darker" },
  { value: "lighten", label: "Lighten", hint: "Keeps whichever is lighter" },
  { value: "difference", label: "Difference", hint: "Inverts where the overlay is bright" },
  { value: "exclusion", label: "Exclusion", hint: "A softer difference" },
  { value: "plus-lighter", label: "Add", hint: "Adds the light together - bright, punchy glows" },
];

// The CSS value for an overlay's element; undefined leaves it normal (and creates no stacking
// context, so a plain overlay renders exactly as it always has).
export const cssBlendMode = (mode: BlendMode | undefined): CSSProperties["mixBlendMode"] | undefined =>
  mode && mode !== "normal" ? (mode as CSSProperties["mixBlendMode"]) : undefined;

// What export receives; omitted for normal.
export const exportBlendMode = (mode: BlendMode | undefined): string | undefined => (mode && mode !== "normal" ? mode : undefined);
