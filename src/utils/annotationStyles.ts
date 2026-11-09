// utils/annotationStyles.ts
//
// Look and timing of the presentation annotation overlay's ink (AnnotationOverlayWindow.tsx),
// shared with Settings > Annotation so its live preview is drawn by exactly the same code as the
// real strokes. Settings are read from localStorage (appSettings.ts), which every Briefcast window
// shares - the overlay re-reads them each time draw mode turns on.

import { getStroke } from "perfect-freehand";

export type AnnotationStyle = "pen" | "marker" | "neon" | "laser";
export type AnnotationFade = "quick" | "normal" | "slow" | "never";

// What follows the cursor while drawing. "hand" is the signature one - a glove on a stick, tinted
// to the current ink colour; "custom" is the user's own PNG (appSettings.annotationPointerImage).
export type AnnotationPointer = "hand" | "dot" | "system" | "custom";
export type AnnotationTapSound = "off" | "tick" | "pop" | "wood";

export const ANNOTATION_POINTERS: { id: AnnotationPointer; label: string }[] = [
  { id: "hand", label: "Hand" },
  { id: "dot", label: "Dot" },
  { id: "system", label: "Crosshair" },
  { id: "custom", label: "Custom" },
];

export const ANNOTATION_TAP_SOUNDS: { id: AnnotationTapSound; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "tick", label: "Tick" },
  { id: "pop", label: "Pop" },
  { id: "wood", label: "Wood" },
];

export const ANNOTATION_COLORS = ["#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#ffffff", "#111111"];

export const ANNOTATION_STYLES: { id: AnnotationStyle; label: string; hint: string }[] = [
  { id: "pen", label: "Pen", hint: "Solid ink that tapers with stylus pressure" },
  { id: "marker", label: "Marker", hint: "Wide, see-through highlighter" },
  { id: "neon", label: "Neon", hint: "Glowing line with a bright core" },
  { id: "laser", label: "Laser", hint: "Glowing trail that vanishes almost at once - for pointing" },
];

export const ANNOTATION_FADES: { id: AnnotationFade; label: string }[] = [
  { id: "quick", label: "Quick" },
  { id: "normal", label: "Normal" },
  { id: "slow", label: "Slow" },
  { id: "never", label: "Until I exit" },
];

// How long a finished stroke stays fully visible, then how long it takes to fade out. Laser
// ignores the fade setting - a pointer trail that lingers stops being a pointer.
const FADE_TIMINGS: Record<AnnotationFade, { hold: number; out: number }> = {
  quick: { hold: 500, out: 700 },
  normal: { hold: 1200, out: 1400 },
  slow: { hold: 3500, out: 2000 },
  never: { hold: Infinity, out: 0 },
};
const LASER_TIMING = { hold: 120, out: 650 };

export const fadeTiming = (style: AnnotationStyle, fade: AnnotationFade) => (style === "laser" ? LASER_TIMING : FADE_TIMINGS[fade]);

// Total time from a stroke being finished to it being gone - 0 for "never", which only ends when
// draw mode does. Dashboard keeps the overlay up this long after draw mode turns off.
export const fadeTotalMs = (style: AnnotationStyle, fade: AnnotationFade): number => {
  const t = fadeTiming(style, fade);
  return Number.isFinite(t.hold) ? t.hold + t.out : 0;
};

// 0..1 visibility of a stroke `age` ms after it was finished.
export const strokeOpacity = (age: number, style: AnnotationStyle, fade: AnnotationFade): number => {
  const { hold, out } = fadeTiming(style, fade);
  if (age <= hold) return 1;
  return out <= 0 ? 0 : Math.max(0, 1 - (age - hold) / out);
};

export interface AnnotationStrokePoint {
  x: number;
  y: number;
  pressure: number;
}

export interface AnnotationInk {
  points: AnnotationStrokePoint[];
  color: string;
  width: number;
  style: AnnotationStyle;
  shadow: boolean;
}

// perfect-freehand turns the raw point+pressure samples into a pressure-tapered outline polygon,
// filled rather than stroked, which is what gives it a real marker/stylus feel instead of a
// uniform-width polyline (same technique as PdfAnnotator's pen tool).
//
// Balanced streamline (0.45) and smoothing (0.55) eliminate jagged mouse jitter and staircase steps
// while keeping the stroke fluidly responsive under the hand pointer without lagging.
// Caps ensure round ends on strokes and clean tap dots.
const STREAMLINE = 0.45;
const outlines = new WeakMap<AnnotationInk, Map<string, { points: AnnotationStrokePoint[]; count: number; path: Path2D }>>();

const tracePath = (ink: AnnotationInk, size: number, thinning: number): Path2D => {
  const pts = ink.points;
  const key = `${size}|${thinning}`;
  let byKey = outlines.get(ink);
  const cached = byKey?.get(key);
  if (cached && cached.points === pts && cached.count === pts.length) return cached.path;
  const outline = getStroke(
    pts.map((p) => [p.x, p.y, p.pressure]),
    {
      size,
      thinning,
      smoothing: 0.55,
      streamline: STREAMLINE,
      simulatePressure: pts.every((p) => p.pressure === 0.5),
      start: { cap: true, taper: 0 },
      end: { cap: true, taper: 0 },
    }
  );
  const path = new Path2D();
  if (outline.length === 0) {
    // A plain tap/click - perfect-freehand needs at least two samples to form an outline, so this
    // still leaves a visible dot instead of drawing nothing.
    path.arc(pts[0].x, pts[0].y, size / 2, 0, Math.PI * 2);
  } else {
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) path.lineTo(outline[i][0], outline[i][1]);
    path.closePath();
  }
  if (!byKey) outlines.set(ink, (byKey = new Map()));
  byKey.set(key, { points: pts, count: pts.length, path });
  return path;
};

export const drawAnnotationInk = (ctx: CanvasRenderingContext2D, ink: AnnotationInk, opacity: number): void => {
  if (ink.points.length === 0 || opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha = opacity;

  // Lifts pen/marker ink off busy or same-coloured backgrounds. Neon and laser carry their own glow.
  const dropShadow = (): void => {
    if (!ink.shadow) return;
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = Math.max(4, ink.width * 0.8);
    ctx.shadowOffsetY = Math.max(1, ink.width * 0.25);
  };

  switch (ink.style) {
    case "marker":
      dropShadow();
      ctx.globalAlpha = opacity * 0.42;
      ctx.fillStyle = ink.color;
      ctx.fill(tracePath(ink, ink.width * 2.6, 0));
      break;
    case "neon":
    case "laser": {
      const size = ink.style === "laser" ? ink.width * 0.85 : ink.width;
      ctx.shadowColor = ink.color;
      ctx.shadowBlur = size * 2.5;
      ctx.fillStyle = ink.color;
      const body = tracePath(ink, size, 0.35);
      ctx.fill(body);
      // Second, tighter halo, then a near-white core - what reads as "lit" rather than just blurred.
      ctx.shadowBlur = size;
      ctx.fill(body);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = opacity * 0.9;
      ctx.fillStyle = "#ffffff";
      ctx.fill(tracePath(ink, Math.max(1.5, size * 0.38), 0.35));
      break;
    }
    default:
      dropShadow();
      ctx.fillStyle = ink.color;
      ctx.fill(tracePath(ink, ink.width, 0.6));
  }
  ctx.restore();
};

// A finished stroke drawn once, at full opacity, into a bitmap just big enough for it and its glow
// or shadow - so the overlay's frames (a stroke holding, then fading) are a drawImage each instead
// of re-filling every outline with its blurs. `dpr` keeps it as sharp as the live canvas.
export interface BakedInk {
  image: HTMLCanvasElement;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const bakeAnnotationInk = (ink: AnnotationInk, dpr: number): BakedInk | null => {
  if (ink.points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ink.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // The widest anything reaches past the points: the marker's 2.6x body, neon's 2.5x halo, a shadow.
  const pad = Math.ceil(ink.width * 6 + 16);
  const x = Math.floor(minX - pad);
  const y = Math.floor(minY - pad);
  const width = Math.ceil(maxX + pad) - x;
  const height = Math.ceil(maxY + pad) - y;
  const image = document.createElement("canvas");
  image.width = Math.max(1, Math.round(width * dpr));
  image.height = Math.max(1, Math.round(height * dpr));
  const ctx = image.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, -x * dpr, -y * dpr);
  drawAnnotationInk(ctx, ink, 1);
  return { image, x, y, width, height };
};
