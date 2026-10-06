// utils/annotationStyles.ts
//
// Look and timing of the presentation annotation overlay's ink (AnnotationOverlayWindow.tsx),
// shared with Settings > Annotation so its live preview is drawn by exactly the same code as the
// real strokes. Settings are read from localStorage (appSettings.ts), which every Briefcast window
// shares - the overlay re-reads them each time draw mode turns on.

import { getStroke } from "perfect-freehand";

export type AnnotationStyle = "pen" | "marker" | "neon" | "laser";
export type AnnotationFade = "quick" | "normal" | "slow" | "never";

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
const tracePath = (ctx: CanvasRenderingContext2D, ink: AnnotationInk, size: number, thinning: number): void => {
  const pts = ink.points;
  const outline = getStroke(
    pts.map((p) => [p.x, p.y, p.pressure]),
    {
      size,
      thinning,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: pts.every((p) => p.pressure === 0.5),
    }
  );
  ctx.beginPath();
  if (outline.length === 0) {
    // A plain tap/click - perfect-freehand needs at least two samples to form an outline, so this
    // still leaves a visible dot instead of drawing nothing.
    ctx.arc(pts[0].x, pts[0].y, size / 2, 0, Math.PI * 2);
    return;
  }
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
  ctx.closePath();
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
      tracePath(ctx, ink, ink.width * 2.6, 0);
      ctx.fill();
      break;
    case "neon":
    case "laser": {
      const size = ink.style === "laser" ? ink.width * 0.85 : ink.width;
      ctx.shadowColor = ink.color;
      ctx.shadowBlur = size * 2.5;
      ctx.fillStyle = ink.color;
      tracePath(ctx, ink, size, 0.35);
      ctx.fill();
      // Second, tighter halo, then a near-white core - what reads as "lit" rather than just blurred.
      ctx.shadowBlur = size;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = opacity * 0.9;
      ctx.fillStyle = "#ffffff";
      tracePath(ctx, ink, Math.max(1.5, size * 0.38), 0.35);
      ctx.fill();
      break;
    }
    default:
      dropShadow();
      ctx.fillStyle = ink.color;
      tracePath(ctx, ink, ink.width, 0.6);
      ctx.fill();
  }
  ctx.restore();
};
