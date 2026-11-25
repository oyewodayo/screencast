// handlers/whiteboardFreehand.ts
//
// Variable-width tapered ink & translucent highlighter path generator powered by `perfect-freehand`.
// Shared by WhiteboardCanvas (live SVG + live drawing preview), whiteboardHandlers (Canvas2D PNG/PDF),
// and whiteboardInterchangeHandlers (standalone vector SVG) so every surface renders identical ink.

import { getStroke } from "perfect-freehand";

function average(a: number, b: number): number {
  return (a + b) / 2;
}

/**
 * Converts a closed polygon returned by `perfect-freehand`'s `getStroke` into a smooth cubic/quad
 * SVG path `d` string.
 */
function polygonToSvgPath(stroke: number[][]): string {
  const len = stroke.length;
  if (len < 3) return "";
  let a = stroke[0];
  let b = stroke[1];
  const c = stroke[2];
  let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${average(b[0], c[0]).toFixed(2)},${average(b[1], c[1]).toFixed(2)} T`;
  for (let i = 2; i < len - 1; i++) {
    a = stroke[i];
    b = stroke[i + 1];
    result += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(2)} `;
  }
  result += "Z";
  return result;
}

/**
 * Builds a smooth, tapered filled outline SVG path for a freehand stroke.
 * - Pen mode: responsive calligraphic taper (`thinning: 0.55`, `streamline: 0.52`, simulated velocity pressure)
 * - Highlighter mode: flat chisel-marker stroke (`thinning: 0.06`, rounded flat ends)
 */
export function buildTaperedFreehandPathD(
  points: { x: number; y: number }[],
  strokeWidth: number,
  isHighlighter = false
): string {
  if (points.length === 0) return "";
  const input = points.map((p) => [p.x, p.y]);
  const outline = getStroke(input, {
    size: Math.max(2, isHighlighter ? strokeWidth : strokeWidth * 1.65),
    thinning: isHighlighter ? 0.06 : 0.52,
    smoothing: 0.58,
    streamline: isHighlighter ? 0.45 : 0.52,
    simulatePressure: !isHighlighter,
    easing: (t) => t,
    start: { taper: isHighlighter ? 0 : Math.min(18, strokeWidth * 3), cap: true },
    end: { taper: isHighlighter ? 0 : Math.min(22, strokeWidth * 3.5), cap: true },
  });
  return polygonToSvgPath(outline);
}
