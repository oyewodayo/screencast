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
import { keyframeStateAt, type KeyframeEasing } from "./keyframes";

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
  // Animated: the mask opens over the layer's first seconds (and closes over its last).
  reveal?: MaskReveal;
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

// ---- Reveals: the mask growing over time --------------------------------------------------------
//
// A reveal animates the mask's box from nothing to the mask itself (an iris opening from its
// centre, or a wipe from one side) over `duration` seconds from the layer's start - and, with
// `exit`, back again over its last seconds. The mask's own box is always the fully-open state, so
// editing the mask keeps the reveal. Both renderers scale and place ONE picture of the mask's shape
// (revealMaskPicture) per frame: the preview as a CSS mask layer, export as a moving mask
// (moving_mask_chain, conversion.rs) - so the edge is the same at every moment.

export type RevealStyle = "iris" | "wipe-right" | "wipe-left" | "wipe-down" | "wipe-up";

export interface MaskReveal {
  style: RevealStyle;
  duration: number;
  exit?: boolean;
}

export const REVEAL_STYLES: { value: RevealStyle; label: string; hint: string }[] = [
  { value: "iris", label: "Iris", hint: "Opens from the middle" },
  { value: "wipe-right", label: "Wipe →", hint: "Uncovers from the left edge" },
  { value: "wipe-left", label: "Wipe ←", hint: "Uncovers from the right edge" },
  { value: "wipe-down", label: "Wipe ↓", hint: "Uncovers from the top" },
  { value: "wipe-up", label: "Wipe ↑", hint: "Uncovers from the bottom" },
];

// The mask a reveal starts from when the layer has none: the whole box, a little beyond so the
// soft edge doesn't show at the sides once it's open (iris: the ellipse around the whole box).
export function revealStartingMask(style: RevealStyle): LayerMask {
  if (style === "iris") {
    const r = Math.SQRT2 / 2 + 0.04;
    return { shape: "ellipse", x: 0.5 - r, y: 0.5 - r, width: 2 * r, height: 2 * r, feather: 0.04, invert: false };
  }
  return { shape: "rectangle", x: -0.08, y: -0.08, width: 1.16, height: 1.16, feather: 0.03, invert: false };
}

export interface MaskBoxKeyframe {
  // Seconds from the layer's start.
  time: number;
  x: number;
  y: number;
  width: number;
  height: number;
  easing: KeyframeEasing;
}

// The closed state for `style`: the mask's box shrunk to nothing toward where it opens from.
function closedBox(m: LayerMask, style: RevealStyle) {
  switch (style) {
    case "iris":
      return { x: m.x + m.width / 2, y: m.y + m.height / 2, width: 0, height: 0 };
    case "wipe-right":
      return { x: m.x, y: m.y, width: 0, height: m.height };
    case "wipe-left":
      return { x: m.x + m.width, y: m.y, width: 0, height: m.height };
    case "wipe-down":
      return { x: m.x, y: m.y, width: m.width, height: 0 };
    case "wipe-up":
      return { x: m.x, y: m.y + m.height, width: m.width, height: 0 };
  }
}

// The reveal's keyframes over a layer `span` seconds long (none when there's no reveal).
export function revealKeyframes(m: LayerMask, span: number): MaskBoxKeyframe[] {
  const r = m.reveal;
  if (!r || span <= 0.05) return [];
  const open = { x: m.x, y: m.y, width: m.width, height: m.height };
  const closed = closedBox(m, r.style);
  const d = Math.max(0.05, Math.min(r.duration, r.exit ? span / 2 : span));
  const out: MaskBoxKeyframe[] = [
    { time: 0, ...closed, easing: "ease-out" },
    { time: d, ...open, easing: "hold" },
  ];
  if (r.exit) {
    out[1].easing = "linear";
    out.push({ time: Math.max(d, span - d), ...open, easing: "ease-in" }, { time: span, ...closed, easing: "hold" });
  }
  return out;
}

// The mask's box at `local` seconds into a layer `span` long.
export function revealBoxAt(m: LayerMask, local: number, span: number): { x: number; y: number; width: number; height: number } {
  const k = keyframeStateAt(
    revealKeyframes(m, span).map((f) => ({ time: f.time, x: f.x, y: f.y, scale: f.width, opacity: f.height, easing: f.easing })),
    local
  );
  return k ? { x: k.x, y: k.y, width: k.scale, height: k.opacity } : { x: m.x, y: m.y, width: m.width, height: m.height };
}

// The picture of the mask's shape alone (white on transparent; `grey`: on black), drawn for a layer
// box `boxW` x `boxH` px with the mask at its open size, plus `pad` px of room on each side for the
// soft edge. Placing it: the mask box (bx, by, bw, bh) px -> the picture at
// (bx - pad*bw/mw, by - pad*bh/mh) sized ((mw + 2pad)*bw/mw, (mh + 2pad)*bh/mh).
export function revealMaskPicture(m: LayerMask, boxW: number, boxH: number, grey: boolean): { url: string; mw: number; mh: number; pad: number } {
  const pic = revealMaskCanvas(m, boxW, boxH, grey);
  return { url: pic.canvas.toDataURL("image/png"), mw: pic.mw, mh: pic.mh, pad: pic.pad };
}

// revealMaskPicture's drawing, as a canvas - for renderers that draw it straight onto another
// canvas (a revealing picture's export frames). `mw`/`mh` are the whole pixels the open mask spans
// in it, so placement maps exactly.
export function revealMaskCanvas(m: LayerMask, boxW: number, boxH: number, grey: boolean): { canvas: HTMLCanvasElement; mw: number; mh: number; pad: number } {
  const sigma = Math.max(0, Math.min(MAX_FEATHER, m.feather)) * Math.min(boxW, boxH);
  const pad = Math.ceil(sigma * 3) + 1;
  const c = canvasOf(Math.max(1, m.width * boxW) + 2 * pad, Math.max(1, m.height * boxH) + 2 * pad);
  const mw = Math.max(1, c.width - 2 * pad);
  const mh = Math.max(1, c.height - 2 * pad);
  const ctx = c.getContext("2d")!;
  if (grey) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.fillStyle = "#fff";
  ctx.filter = sigma > 0.25 ? `blur(${sigma}px)` : "none";
  const inner = placeMask(m, { x: pad / c.width, y: pad / c.height, width: mw / c.width, height: mh / c.height });
  maskPath(ctx, inner, c.width, c.height);
  ctx.fill();
  return { canvas: c, mw, mh, pad };
}

// Paints a revealing mask's coverage as ALPHA (opaque = shown) onto a w x h canvas at `local`
// seconds into a layer `span` long - the picture placed where the mask box is then, inverted
// when asked. The same coverage the preview's CSS (revealMaskCss) shows.
export function drawRevealCoverage(ctx: CanvasRenderingContext2D, m: LayerMask, pic: { canvas: HTMLCanvasElement; mw: number; mh: number; pad: number }, local: number, span: number, w: number, h: number) {
  const at = revealPicturePlacement(pic, revealBoxAt(m, local, span), w, h);
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  if (m.invert) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "destination-out";
  }
  if (at.width > 0 && at.height > 0) ctx.drawImage(pic.canvas, at.x, at.y, at.width, at.height);
  ctx.restore();
}

// Frames with equal keys show the mask identically - the box rounded to 1/100 of a pixel.
export function revealCoverageKey(m: LayerMask, local: number, span: number, w: number, h: number): string {
  const b = revealBoxAt(m, local, span);
  return [b.x * w, b.y * h, b.width * w, b.height * h].map((v) => Math.round(v * 100)).join(",");
}

// Where the picture goes when the mask box is `b` (fractions of a boxW x boxH layer box), in px.
export function revealPicturePlacement(pic: { mw: number; mh: number; pad: number }, b: { x: number; y: number; width: number; height: number }, boxW: number, boxH: number) {
  const sx = (b.width * boxW) / pic.mw;
  const sy = (b.height * boxH) / pic.mh;
  return { x: b.x * boxW - pic.pad * sx, y: b.y * boxH - pic.pad * sy, width: (pic.mw + 2 * pic.pad) * sx, height: (pic.mh + 2 * pic.pad) * sy };
}

// Export's moving mask for a revealing layer `wPx` x `hPx` (output px) on screen startTime..endTime:
// the shape picture on black, its placement at absolute output seconds (MaskMotionSpec,
// conversion.rs). The layer's own shape goes separately, as its still mask.
export function revealMaskMotion(o: { mask?: LayerMask; startTime: number; endTime: number }, wPx: number, hPx: number) {
  const m = o.mask;
  if (!m?.reveal) return null;
  const pic = revealMaskPicture(m, wPx, hPx, true);
  const keyframes = revealKeyframes(m, o.endTime - o.startTime).map((k) => {
    const at = revealPicturePlacement(pic, k, wPx, hPx);
    return { time: o.startTime + k.time, x: at.x, y: at.y, w: at.width, h: at.height, easing: k.easing };
  });
  return keyframes.length ? { imageBase64: pic.url, keyframes, invert: m.invert } : null;
}

// The preview's CSS mask for a revealing layer at `local` seconds: the shape picture placed where the
// mask box is now, intersected with the layer's own shape (`shapeUrl`), inverted against a full layer
// when asked - the same coverage export multiplies in.
export function revealMaskCss(
  m: LayerMask,
  pic: { url: string; mw: number; mh: number; pad: number },
  shapeUrl: string | null,
  local: number,
  span: number,
  boxW: number,
  boxH: number
): Record<string, string> {
  const at = revealPicturePlacement(pic, revealBoxAt(m, local, span), boxW, boxH);
  const layers: { image: string; position: string; size: string }[] = [];
  if (shapeUrl) layers.push({ image: `url(${shapeUrl})`, position: "0px 0px", size: "100% 100%" });
  layers.push({ image: `url(${pic.url})`, position: `${at.x}px ${at.y}px`, size: `${Math.max(0, at.width)}px ${Math.max(0, at.height)}px` });
  if (m.invert) layers.push({ image: "linear-gradient(#000, #000)", position: "0px 0px", size: "100% 100%" });
  // Each layer composites onto the ones after it: the shape intersects, the picture cuts out of the
  // full layer when inverted.
  const ops = [...(shapeUrl ? ["intersect"] : []), ...(m.invert ? ["exclude"] : [])];
  const webkit = ops.map((op) => (op === "intersect" ? "source-in" : "xor"));
  const join = (k: "image" | "position" | "size") => layers.map((l) => l[k]).join(", ");
  return {
    maskImage: join("image"),
    WebkitMaskImage: join("image"),
    maskPosition: join("position"),
    WebkitMaskPosition: join("position"),
    maskSize: join("size"),
    WebkitMaskSize: join("size"),
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskComposite: ops.length ? ops.join(", ") : "add",
    WebkitMaskComposite: webkit.length ? webkit.join(", ") : "source-over",
  };
}
