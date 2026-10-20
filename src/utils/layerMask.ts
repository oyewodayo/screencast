// utils/layerMask.ts
//
// Masks on layers - a video-track layer (PipOverlay.mask) or a picture (ImageOverlay.mask): only the
// part of the layer inside the mask shows (or, inverted, only the part outside), with a soft,
// feathered edge. Shapes are a rectangle (optionally rounded), an ellipse, or a freehand outline.
//
// One picture serves both renderers: drawLayerMask paints the layer's shape (circle/rounded) times
// its mask, feathered with a Gaussian blur, onto a canvas the size of the layer's box. The preview
// uses it as the box's CSS mask-image (its alpha); export gets the same drawing as a grey PNG
// (white = shown) and multiplies it into the layer's alpha (pip_overlay_chain, conversion.rs) -
// so the edge the preview shows is the edge the saved video has.
import type { PipShape } from "./videoEditTypes";

export interface MaskPoint {
  x: number;
  y: number;
}

export interface LayerMask {
  shape: "rectangle" | "ellipse" | "path";
  // The mask's box, in fractions of the layer's own box (it moves and scales with the layer).
  x: number;
  y: number;
  width: number;
  height: number;
  // "path": the closed outline, in fractions of the layer's box.
  points?: MaskPoint[];
  // Rectangle: corner radius as a fraction of the mask box's shorter side (0..0.5).
  cornerRadius?: number;
  // Edge softness: a Gaussian's sigma as a fraction of the layer box's shorter side (0..0.25).
  feather: number;
  // Show everything EXCEPT the mask's shape.
  invert: boolean;
}

export const DEFAULT_MASK: LayerMask = { shape: "ellipse", x: 0.2, y: 0.15, width: 0.6, height: 0.7, feather: 0.03, invert: false };

export const MAX_FEATHER = 0.25;

// The layer's own shape (a PiP's circle or rounded corners) - part of the same picture.
export interface LayerShape {
  shape?: PipShape;
  // "rounded": radius as a fraction of the box's height (PipOverlay.cornerRadius).
  cornerRadius?: number;
}

export const hasShapeOrMask = (o: LayerShape & { mask?: LayerMask }): boolean => !!o.mask || (!!o.shape && o.shape !== "rectangle");

function shapePath(ctx: CanvasRenderingContext2D, o: LayerShape, w: number, h: number) {
  ctx.beginPath();
  if (o.shape === "circle") {
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (o.shape === "rounded") {
    const r = Math.min(w / 2, h / 2, Math.max(0, (o.cornerRadius ?? 0.08) * h));
    ctx.roundRect(0, 0, w, h, r);
  } else {
    ctx.rect(0, 0, w, h);
  }
}

function maskPath(ctx: CanvasRenderingContext2D, m: LayerMask, w: number, h: number) {
  ctx.beginPath();
  const x = m.x * w;
  const y = m.y * h;
  const mw = m.width * w;
  const mh = m.height * h;
  if (m.shape === "ellipse") {
    ctx.ellipse(x + mw / 2, y + mh / 2, Math.max(0, mw / 2), Math.max(0, mh / 2), 0, 0, Math.PI * 2);
  } else if (m.shape === "path" && m.points && m.points.length >= 3) {
    // A smooth closed curve through the points (midpoint quadratic Béziers).
    const p = m.points.map((q) => ({ x: q.x * w, y: q.y * h }));
    const mid = (a: MaskPoint, b: MaskPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const start = mid(p[p.length - 1], p[0]);
    ctx.moveTo(start.x, start.y);
    for (let i = 0; i < p.length; i++) {
      const next = mid(p[i], p[(i + 1) % p.length]);
      ctx.quadraticCurveTo(p[i].x, p[i].y, next.x, next.y);
    }
    ctx.closePath();
  } else {
    const r = Math.max(0, Math.min(0.5, m.cornerRadius ?? 0)) * Math.min(mw, mh);
    ctx.roundRect(x, y, Math.max(0, mw), Math.max(0, mh), r);
  }
}

// Paints the layer's coverage as ALPHA (opaque white = shown) onto a w x h canvas.
export function drawLayerMask(ctx: CanvasRenderingContext2D, o: LayerShape & { mask?: LayerMask }, w: number, h: number) {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  const m = o.mask;
  if (m) {
    const sigma = Math.max(0, Math.min(MAX_FEATHER, m.feather)) * Math.min(w, h);
    if (m.invert) {
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "destination-out";
    }
    ctx.filter = sigma > 0.25 ? `blur(${sigma}px)` : "none";
    maskPath(ctx, m, w, h);
    ctx.fill();
    ctx.filter = "none";
    // The layer's shape on top: keep only what's inside it.
    ctx.globalCompositeOperation = "destination-in";
  }
  shapePath(ctx, o, w, h);
  ctx.fill();
  ctx.restore();
}

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// The preview's mask-image: coverage as alpha, at the box's on-screen size.
export function layerMaskAlphaUrl(o: LayerShape & { mask?: LayerMask }, w: number, h: number): string {
  const c = canvasOf(w, h);
  drawLayerMask(c.getContext("2d")!, o, c.width, c.height);
  return c.toDataURL("image/png");
}

// Export's mask: the same coverage as a grey picture (white = shown) at the box's size in output
// pixels.
export function layerMaskGreyPng(o: LayerShape & { mask?: LayerMask }, w: number, h: number): string {
  const c = canvasOf(w, h);
  const ctx = c.getContext("2d")!;
  drawLayerMask(ctx, o, c.width, c.height);
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

// ---- Freehand outlines ----------------------------------------------------------------------------

// Ramer-Douglas-Peucker: drops points within `tolerance` of the line through their neighbours, so a
// drawn outline is a handful of points that still follow the stroke.
export function simplifyPath(points: MaskPoint[], tolerance: number): MaskPoint[] {
  if (points.length <= 3) return points;
  const dist = (p: MaskPoint, a: MaskPoint, b: MaskPoint) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
  };
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = dist(points[i], points[i0], points[i1]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = true;
      stack.push([i0, at], [at, i1]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// The bounding box of an outline - a path mask's x/y/width/height.
export function pathBounds(points: MaskPoint[]): { x: number; y: number; width: number; height: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// A mask moved/resized to `box` - a path's points follow its bounds.
export function placeMask(m: LayerMask, box: { x: number; y: number; width: number; height: number }): LayerMask {
  if (m.shape !== "path" || !m.points?.length || m.width <= 0 || m.height <= 0) return { ...m, ...box };
  const sx = box.width / m.width;
  const sy = box.height / m.height;
  return { ...m, ...box, points: m.points.map((p) => ({ x: box.x + (p.x - m.x) * sx, y: box.y + (p.y - m.y) * sy })) };
}

// layerMaskAlphaUrl, remembered - for renderers that draw many layers each frame and can't hold
// their own memo. Keyed on everything the picture depends on, sizes rounded to whole pixels.
const urlCache = new Map<string, string>();
export function cachedLayerMaskAlphaUrl(o: LayerShape & { mask?: LayerMask }, w: number, h: number): string {
  const key = JSON.stringify([o.shape, o.cornerRadius, o.mask, Math.round(w), Math.round(h)]);
  let url = urlCache.get(key);
  if (!url) {
    url = layerMaskAlphaUrl(o, Math.round(w), Math.round(h));
    urlCache.set(key, url);
    if (urlCache.size > 64) urlCache.delete(urlCache.keys().next().value!);
  }
  return url;
}
