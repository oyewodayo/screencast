// handlers/imageEditHandlers.ts
//
// Pure functions only - no React, no closures over component state. Same style as
// pdfAnnotationHandlers.ts/mediaHandlers.ts, but everything here operates in plain canvas-pixel
// space: there's no PDF viewport to convert through, every coordinate is already where it needs
// to be drawn.

import { getStroke } from "perfect-freehand";
import {
  ArrowObject,
  BlurRegionObject,
  EllipseObject,
  GeometrySnapshot,
  ImageAdjustments,
  ImageAnnotationObject,
  ImageEditCommand,
  ImageEditDocument,
  PlacedImageObject,
  Pt,
  RectObject,
  StrokeObject,
  TextObject,
} from "../utils/imageEditTypes";
import { getCachedImage } from "../utils/imageObjectCache";

// ---- Adjustments -------------------------------------------------------------------------------

// Maps 1:1 onto CSS's brightness()/contrast()/saturate() - all neutral at 1, same convention
// ImageAdjustments itself uses. Applied only to the base photo (see renderComposedCanvas's
// draw-order comment below), never to annotation objects drawn on top of it.
export function cssFilterForAdjustments(adjustments: ImageAdjustments): string {
  const { brightness, contrast, saturation } = adjustments;
  if (brightness === 1 && contrast === 1 && saturation === 1) return "none";
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
}

// ---- Stroke geometry (pen/highlighter) ---------------------------------------------------------

// Pen tool: pressure-tapered variable-width outline via perfect-freehand, same tuning
// pdfAnnotationHandlers.ts's strokeToOutline uses. Points are already canvas px, so unlike that
// PDF counterpart there's no device-point conversion step first.
export function strokeToOutline(points: Pt[], baseWidth: number): number[][] {
  return getStroke(
    points.map((p) => [p.x, p.y, p.pressure]),
    {
      size: baseWidth,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: points.every((p) => p.pressure === 0.5),
    }
  );
}

function pathFromOutline(ctx: CanvasRenderingContext2D, outline: number[][]): void {
  if (outline.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    ctx.lineTo(outline[i][0], outline[i][1]);
  }
  ctx.closePath();
}

// Highlighter: constant-width, semi-transparent, multiply-blended line - no pressure taper, same
// as pdfAnnotationHandlers.ts's drawHighlightPath.
function drawHighlightPath(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[], width: number): void {
  if (points.length === 0) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
}

// ---- Text measurement ---------------------------------------------------------------------------

export const TEXT_FONT_FAMILY = "system-ui, -apple-system, sans-serif";
const TEXT_LINE_HEIGHT_MULTIPLIER = 1.3;

// A detached 1x1 canvas kept around purely for ctx.measureText, same pattern as
// pdfAnnotationHandlers.ts's getMeasurementContext - text objects here are single-line, but their
// bounding box (for selection/hit-testing) still needs a real measured width.
let measurementCanvas: HTMLCanvasElement | null = null;
function getMeasurementContext(): CanvasRenderingContext2D {
  if (!measurementCanvas) measurementCanvas = document.createElement("canvas");
  const ctx = measurementCanvas.getContext("2d");
  if (!ctx) throw new Error("Failed to acquire 2D context for text measurement");
  return ctx;
}

export function measureTextWidth(text: string, fontSize: number): number {
  const ctx = getMeasurementContext();
  ctx.font = `${fontSize}px ${TEXT_FONT_FAMILY}`;
  return ctx.measureText(text || " ").width;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

// `y` is the text's top edge (ctx.textBaseline is set to "top" at render time - see
// renderTextObject), matching TextObject's own doc comment.
export function textObjectBounds(object: TextObject): Bounds {
  const w = measureTextWidth(object.text, object.fontSize);
  const h = object.fontSize * TEXT_LINE_HEIGHT_MULTIPLIER;
  return { x: object.x, y: object.y, w, h };
}

// ---- Per-object rendering ------------------------------------------------------------------------

function renderStroke(ctx: CanvasRenderingContext2D, object: StrokeObject): void {
  ctx.save();
  ctx.globalAlpha = object.opacity;
  const outline = strokeToOutline(object.points, object.width);
  ctx.fillStyle = object.color;
  pathFromOutline(ctx, outline);
  ctx.fill();
  ctx.restore();
}

function renderHighlight(ctx: CanvasRenderingContext2D, object: Extract<ImageAnnotationObject, { type: "highlight" }>): void {
  ctx.save();
  ctx.globalAlpha = object.opacity;
  ctx.globalCompositeOperation = object.blend ?? "multiply";
  ctx.strokeStyle = object.color;
  drawHighlightPath(ctx, object.points, object.width);
  ctx.restore();
}

// Arrowhead sized off the line's own stroke width so thicker arrows get proportionally bigger
// heads, rather than a fixed pixel size that would look spindly on a heavy stroke.
function renderArrow(ctx: CanvasRenderingContext2D, object: ArrowObject): void {
  ctx.save();
  ctx.strokeStyle = object.color;
  ctx.fillStyle = object.color;
  ctx.lineWidth = object.width;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.moveTo(object.x1, object.y1);
  ctx.lineTo(object.x2, object.y2);
  ctx.stroke();

  const headLength = Math.max(10, object.width * 3.5);
  const angle = Math.atan2(object.y2 - object.y1, object.x2 - object.x1);
  const headAngle = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(object.x2, object.y2);
  ctx.lineTo(object.x2 - headLength * Math.cos(angle - headAngle), object.y2 - headLength * Math.sin(angle - headAngle));
  ctx.lineTo(object.x2 - headLength * Math.cos(angle + headAngle), object.y2 - headLength * Math.sin(angle + headAngle));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function renderRect(ctx: CanvasRenderingContext2D, object: RectObject): void {
  ctx.save();
  ctx.strokeStyle = object.color;
  ctx.fillStyle = object.color;
  ctx.lineWidth = object.width;
  if (object.filled) ctx.fillRect(object.x, object.y, object.w, object.h);
  else ctx.strokeRect(object.x, object.y, object.w, object.h);
  ctx.restore();
}

function renderEllipse(ctx: CanvasRenderingContext2D, object: EllipseObject): void {
  ctx.save();
  ctx.strokeStyle = object.color;
  ctx.fillStyle = object.color;
  ctx.lineWidth = object.width;
  ctx.beginPath();
  ctx.ellipse(object.x + object.w / 2, object.y + object.h / 2, Math.abs(object.w) / 2, Math.abs(object.h) / 2, 0, 0, Math.PI * 2);
  if (object.filled) ctx.fill();
  else ctx.stroke();
  ctx.restore();
}

function renderTextObject(ctx: CanvasRenderingContext2D, object: TextObject): void {
  ctx.save();
  ctx.font = `${object.fontSize}px ${TEXT_FONT_FAMILY}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = object.color;
  ctx.fillText(object.text, object.x, object.y);
  ctx.restore();
}

// Draws a second placed-on-top image, rotated around its own center - mirrors
// pdfAnnotationHandlers.ts's renderImageObject exactly (see PlacedImageObject's own doc comment
// for the shared x/y/rotation convention). Reads from the shared decoded-image cache
// (imageObjectCache.ts) rather than decoding inline, same "preload once, render synchronously"
// split that cache exists for - if the object's src hasn't decoded yet, this is a no-op and the
// caller's preload effect (ImageEditorCanvas) redraws once it resolves.
function renderPlacedImage(ctx: CanvasRenderingContext2D, object: PlacedImageObject): void {
  const img = getCachedImage(object.src);
  if (!img) return;
  ctx.save();
  ctx.translate(object.x + object.width / 2, object.y + object.height / 2);
  ctx.rotate(object.rotation);
  ctx.drawImage(img, -object.width / 2, -object.height / 2, object.width, object.height);
  ctx.restore();
}

// Redraws a blurred copy of whatever's *already on the destination canvas* within this region -
// see renderComposedCanvas's draw-order comment for why this only ever samples the base
// photo+adjustments layer, never other annotations. `ctx.filter`'s blur is a post-process on the
// drawImage call itself, so drawing the canvas onto itself with a blur filter set is a cheap,
// good-enough (not pixel-perfect at the rect's own edges) way to blur just that region - the same
// technique any canvas-based screenshot tool uses for a redaction/privacy blur.
function renderBlurRegion(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, object: BlurRegionObject): void {
  ctx.save();
  ctx.filter = `blur(${object.blurRadius}px)`;
  ctx.drawImage(canvas, object.x, object.y, object.w, object.h, object.x, object.y, object.w, object.h);
  ctx.restore();
}

// Renders the full composition: base photo (with live adjustments) -> blur regions (sampling that
// base layer) -> every other annotation object in creation order. `baseImage` is null while the
// source is still decoding - callers redraw once it resolves (see imageObjectCache.preloadImage).
export function renderComposedCanvas(
  canvas: HTMLCanvasElement,
  baseImage: CanvasImageSource | null,
  baseWidth: number,
  baseHeight: number,
  adjustments: ImageAdjustments,
  objects: ImageAnnotationObject[]
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (baseImage) {
    ctx.save();
    ctx.filter = cssFilterForAdjustments(adjustments);
    ctx.drawImage(baseImage, 0, 0, baseWidth, baseHeight);
    ctx.restore();
  }

  const blurs = objects.filter((o): o is BlurRegionObject => o.type === "blur");
  for (const blur of blurs) renderBlurRegion(ctx, canvas, blur);

  for (const object of objects) {
    if (object.type === "blur") continue;
    switch (object.type) {
      case "stroke":
        renderStroke(ctx, object);
        break;
      case "highlight":
        renderHighlight(ctx, object);
        break;
      case "arrow":
        renderArrow(ctx, object);
        break;
      case "rect":
        renderRect(ctx, object);
        break;
      case "ellipse":
        renderEllipse(ctx, object);
        break;
      case "text":
        renderTextObject(ctx, object);
        break;
      case "placed-image":
        renderPlacedImage(ctx, object);
        break;
    }
  }
}

// Live (in-progress) freehand preview, drawn directly against the working canvas each pointermove
// - called with only the current stroke's points, so cost is independent of how many committed
// objects already exist. Callers redraw the full composed canvas first, then this on top.
export function renderLiveStroke(ctx: CanvasRenderingContext2D, tool: "pen" | "highlighter", points: Pt[], color: string, width: number): void {
  if (points.length === 0) return;
  ctx.save();
  if (tool === "pen") {
    const outline = strokeToOutline(points, width);
    ctx.fillStyle = color;
    pathFromOutline(ctx, outline);
    ctx.fill();
  } else {
    ctx.globalAlpha = 0.35;
    ctx.globalCompositeOperation = "multiply";
    ctx.strokeStyle = color;
    drawHighlightPath(ctx, points, width);
  }
  ctx.restore();
}

// ---- Factories -----------------------------------------------------------------------------------

function baseFields(): { id: string; createdAt: number; updatedAt: number } {
  const now = Date.now();
  return { id: crypto.randomUUID(), createdAt: now, updatedAt: now };
}

export function makeStrokeObject(points: Pt[], color: string, width: number): StrokeObject {
  return { ...baseFields(), type: "stroke", points, color, width, opacity: 1 };
}

export function makeHighlightObject(points: Pt[], color: string, width: number): Extract<ImageAnnotationObject, { type: "highlight" }> {
  return { ...baseFields(), type: "highlight", points, color, width, opacity: 0.35, blend: "multiply" };
}

export function makeArrowObject(x1: number, y1: number, x2: number, y2: number, color: string, width: number): ArrowObject {
  return { ...baseFields(), type: "arrow", x1, y1, x2, y2, color, width };
}

export function makeRectObject(x: number, y: number, w: number, h: number, color: string, width: number): RectObject {
  return { ...baseFields(), type: "rect", x, y, w, h, color, width, filled: false };
}

export function makeEllipseObject(x: number, y: number, w: number, h: number, color: string, width: number): EllipseObject {
  return { ...baseFields(), type: "ellipse", x, y, w, h, color, width, filled: false };
}

export function makeTextObject(x: number, y: number, text: string, color: string, fontSize: number): TextObject {
  return { ...baseFields(), type: "text", x, y, text, color, fontSize };
}

export const DEFAULT_BLUR_RADIUS = 16;

export function makeBlurObject(x: number, y: number, w: number, h: number): BlurRegionObject {
  return { ...baseFields(), type: "blur", x, y, w, h, blurRadius: DEFAULT_BLUR_RADIUS };
}

export function makePlacedImageObject(x: number, y: number, width: number, height: number, src: string): PlacedImageObject {
  return { ...baseFields(), type: "placed-image", x, y, width, height, rotation: 0, src };
}

// ---- Move (translate) -----------------------------------------------------------------------------

// Shifts every stored coordinate field by (dx, dy) - covers the Select tool's drag-to-move for
// every object type uniformly (point arrays for stroke/highlight, x1/y1/x2/y2 for arrow, x/y for
// everything else).
export function translateObject(object: ImageAnnotationObject, dx: number, dy: number): ImageAnnotationObject {
  const updatedAt = Date.now();
  switch (object.type) {
    case "stroke":
    case "highlight":
      return { ...object, updatedAt, points: object.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
    case "arrow":
      return { ...object, updatedAt, x1: object.x1 + dx, y1: object.y1 + dy, x2: object.x2 + dx, y2: object.y2 + dy };
    default:
      return { ...object, updatedAt, x: object.x + dx, y: object.y + dy };
  }
}

// ---- Hit-testing / selection -----------------------------------------------------------------------

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Rotates (x, y) by -radians around (cx, cy) - brings a query point into a rotated box's own
// local (unrotated) frame, so hit-testing it is a plain axis-aligned bounds check instead of a
// rotated-rectangle intersection. Plain canvas/device space throughout this file (unlike
// pdfAnnotationHandlers.ts's rotatePointAroundCenter, there's no y-up/y-down crossing here, so the
// sign is just the everyday "undo a +rotation").
function unrotatePoint(x: number, y: number, cx: number, cy: number, radians: number): { x: number; y: number } {
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

function placedImageIntersectsPoint(object: PlacedImageObject, x: number, y: number, padding: number): boolean {
  const cx = object.x + object.width / 2;
  const cy = object.y + object.height / 2;
  const local = unrotatePoint(x, y, cx, cy, object.rotation);
  return (
    local.x >= object.x - padding &&
    local.x <= object.x + object.width + padding &&
    local.y >= object.y - padding &&
    local.y <= object.y + object.height + padding
  );
}

// Click-to-select hit test, topmost (last-drawn) object first - same visual-stacking-order
// convention as pdfAnnotationHandlers.ts's findImageObjectAt.
export function findObjectAt(objects: ImageAnnotationObject[], x: number, y: number): ImageAnnotationObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const object = objects[i];
    const hitRadius = 8; // generous padding - easier to grab a thin line/edge than pixel-perfect

    switch (object.type) {
      case "stroke":
      case "highlight": {
        const tolerance = hitRadius + object.width / 2;
        const pts = object.points;
        if (pts.length === 1 && Math.hypot(x - pts[0].x, y - pts[0].y) <= tolerance) return object;
        for (let j = 0; j < pts.length - 1; j++) {
          if (distanceToSegment(x, y, pts[j].x, pts[j].y, pts[j + 1].x, pts[j + 1].y) <= tolerance) return object;
        }
        break;
      }
      case "arrow": {
        if (distanceToSegment(x, y, object.x1, object.y1, object.x2, object.y2) <= hitRadius + object.width / 2) return object;
        break;
      }
      case "rect":
      case "ellipse":
      case "blur": {
        if (x >= object.x - hitRadius && x <= object.x + object.w + hitRadius && y >= object.y - hitRadius && y <= object.y + object.h + hitRadius) {
          return object;
        }
        break;
      }
      case "text": {
        const b = textObjectBounds(object);
        if (x >= b.x - hitRadius && x <= b.x + b.w + hitRadius && y >= b.y - hitRadius && y <= b.y + b.h + hitRadius) return object;
        break;
      }
      case "placed-image": {
        if (placedImageIntersectsPoint(object, x, y, hitRadius)) return object;
        break;
      }
    }
  }
  return null;
}

// Bounding box used to draw the Select tool's outline/handles - null for stroke/highlight (no
// resize handles for freehand ink, see ImageEditorCanvas's own comment on why only bounded-box
// shapes get resize chrome) and for placed-image (it gets its own rotation-aware move/resize/
// rotate chrome - ImageAnnotationEditor.tsx, reused from the PDF annotator - instead of this
// generic axis-aligned one).
export function getObjectBounds(object: ImageAnnotationObject): Bounds | null {
  switch (object.type) {
    case "rect":
    case "ellipse":
    case "blur":
      return { x: object.x, y: object.y, w: object.w, h: object.h };
    case "text":
      return textObjectBounds(object);
    default:
      return null;
  }
}

export type ResizeCorner = "nw" | "ne" | "sw" | "se";

// Resizes a box-shaped object (rect/ellipse/blur only - see ImageEditDocument's own module
// comment) by dragging one corner, keeping the *opposite* corner fixed. `minSize` prevents the
// box collapsing to zero/negative, which would otherwise flip its effective corners underfoot.
export function resizeBoxObject<T extends RectObject | EllipseObject | BlurRegionObject>(
  object: T,
  corner: ResizeCorner,
  pointerX: number,
  pointerY: number,
  minSize = 8
): T {
  const left = corner === "nw" || corner === "sw" ? pointerX : object.x;
  const right = corner === "ne" || corner === "se" ? pointerX : object.x + object.w;
  const top = corner === "nw" || corner === "ne" ? pointerY : object.y;
  const bottom = corner === "sw" || corner === "se" ? pointerY : object.y + object.h;

  const x = Math.min(left, right - minSize);
  const y = Math.min(top, bottom - minSize);
  return { ...object, x, y, w: Math.max(minSize, right - x), h: Math.max(minSize, bottom - y), updatedAt: Date.now() };
}

// ---- Geometry (crop/rotate/flip) -------------------------------------------------------------------

// Rotates (in 90 degree steps) and/or flips a canvas, returning a brand-new canvas sized for the
// result (width/height swap on an odd number of quarter turns). Used by the Rotate/Flip toolbar
// buttons - the caller is responsible for turning the result into a GeometrySnapshot (see that
// type's own doc comment for why this bakes in everything drawn so far rather than transforming
// each annotation object's coordinates).
export function rotateFlipCanvas(source: HTMLCanvasElement, quarterTurns: 0 | 1 | 2 | 3, flipH: boolean, flipV: boolean): HTMLCanvasElement {
  const rotated90or270 = quarterTurns % 2 === 1;
  const outWidth = rotated90or270 ? source.height : source.width;
  const outHeight = rotated90or270 ? source.width : source.height;

  const out = document.createElement("canvas");
  out.width = outWidth;
  out.height = outHeight;
  const ctx = out.getContext("2d");
  if (!ctx) return out;

  ctx.save();
  ctx.translate(outWidth / 2, outHeight / 2);
  ctx.rotate((quarterTurns * Math.PI) / 2);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  ctx.restore();

  return out;
}

// Crops a canvas to the given rectangle (canvas-pixel space, not fractions - callers on a
// zoomed-out display should scale up from their own display-space rect first, the same
// natural/display split ImageOverlayCropPanel.tsx already uses).
export function cropCanvas(source: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w));
  out.height = Math.max(1, Math.round(h));
  const ctx = out.getContext("2d");
  if (!ctx) return out;
  ctx.drawImage(source, x, y, w, h, 0, 0, out.width, out.height);
  return out;
}

// ---- Document mutation (pure) -----------------------------------------------------------------------

// Applies a command, returning a new document - callers (useImageEditStore) own the undo/redo
// stacks, same split of responsibility as pdfAnnotationHandlers.ts's applyCommand.
export function applyCommand(doc: ImageEditDocument, command: ImageEditCommand): ImageEditDocument {
  const updatedAt = new Date().toISOString();
  switch (command.type) {
    case "add":
      return { ...doc, objects: [...doc.objects, command.object], updatedAt };
    case "delete":
      return { ...doc, objects: doc.objects.filter((o) => o.id !== command.object.id), updatedAt };
    case "edit":
      return { ...doc, objects: doc.objects.map((o) => (o.id === command.after.id ? command.after : o)), updatedAt };
    case "batch-edit": {
      const afterById = new Map(command.after.map((o) => [o.id, o]));
      return { ...doc, objects: doc.objects.map((o) => afterById.get(o.id) ?? o), updatedAt };
    }
    case "reorder":
      return { ...doc, objects: command.after, updatedAt };
    case "adjustments":
      return { ...doc, adjustments: command.after, updatedAt };
    case "geometry":
      return {
        ...doc,
        baseImageOverride: command.after.baseImageOverride,
        baseWidth: command.after.baseWidth,
        baseHeight: command.after.baseHeight,
        adjustments: command.after.adjustments,
        objects: command.after.objects,
        updatedAt,
      };
  }
}

export function invertCommand(command: ImageEditCommand): ImageEditCommand {
  switch (command.type) {
    case "add":
      return { type: "delete", object: command.object };
    case "delete":
      return { type: "add", object: command.object };
    case "edit":
      return { type: "edit", before: command.after, after: command.before };
    case "batch-edit":
      return { type: "batch-edit", before: command.after, after: command.before };
    case "reorder":
      return { type: "reorder", before: command.after, after: command.before };
    case "adjustments":
      return { type: "adjustments", before: command.after, after: command.before };
    case "geometry":
      return { type: "geometry", before: command.after, after: command.before };
  }
}

export function currentGeometrySnapshot(doc: ImageEditDocument, currentBaseImageDataUrl: string): GeometrySnapshot {
  return {
    baseImageOverride: currentBaseImageDataUrl,
    baseWidth: doc.baseWidth,
    baseHeight: doc.baseHeight,
    adjustments: doc.adjustments,
    objects: doc.objects,
  };
}
