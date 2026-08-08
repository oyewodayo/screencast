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
  StepObject,
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

// Highlighter: constant-width (no pressure taper, unlike the pen), semi-transparent,
// multiply-blended band with flat (butt) caps instead of round ones - a real highlighter's tip is
// a flat blade, not a point, and a round-capped line just reads as a translucent pen stroke. Width
// itself comes straight from the caller (ImageEditor.tsx keeps a separate, much wider Width range
// for this tool - see HIGHLIGHT_MIN_WIDTH/HIGHLIGHT_MAX_WIDTH there - rather than this function
// scaling a pen-sized value on its own, so the panel's slider position always matches what gets
// drawn).
function drawHighlightPath(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[], width: number): void {
  if (points.length === 0) return;
  ctx.lineCap = "butt";
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
// Exported so the live multi-line text-editing textarea (ImageEditorCanvas.tsx) can set the same
// CSS line-height, keeping each typed line's vertical spacing close to where renderTextObject
// will actually place it once committed.
export const TEXT_LINE_HEIGHT_MULTIPLIER = 1.3;

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

// Setting ctx.font triggers font matching/shaping internally, so it (and the measureText call
// after it) is genuinely not free - and textObjectBounds calls this for *every* text object on
// *every* canvas redraw (which happens on nearly every doc/adjustments change) plus, via
// getSelectionBounds, once per other-object snap target on *every animation frame* while
// something's being dragged. Real screenshots commonly carry a handful of text labels that never
// change once placed, so the (text, fontSize, bold) -> width mapping is cheap to memoize and
// almost always a hit. Capped and fully cleared (not evicted one entry at a time) past
// MAX_TEXT_WIDTH_CACHE_ENTRIES - simplest possible bound against unbounded growth across a long
// session touching many different photos; how it clears doesn't matter since a cache miss just
// costs one measureText call.
const textWidthCache = new Map<string, number>();
const MAX_TEXT_WIDTH_CACHE_ENTRIES = 500;

export function measureTextWidth(text: string, fontSize: number, bold: boolean = false): number {
  const key = `${bold ? 1 : 0} ${fontSize} ${text}`;
  const cached = textWidthCache.get(key);
  if (cached !== undefined) return cached;

  const ctx = getMeasurementContext();
  ctx.font = `${bold ? "bold " : ""}${fontSize}px ${TEXT_FONT_FAMILY}`;
  const width = ctx.measureText(text || " ").width;

  if (textWidthCache.size >= MAX_TEXT_WIDTH_CACHE_ENTRIES) textWidthCache.clear();
  textWidthCache.set(key, width);
  return width;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Proportional to font size (not a fixed px value) so the backdrop reads consistently whether the
// label is a small callout or a large heading. Exported so the live text-editing input
// (ImageEditorCanvas.tsx) can preview the backdrop at this exact padding instead of an
// unrelated fixed CSS value that would visibly jump in size once the edit commits.
export const TEXT_BACKGROUND_PADDING_RATIO = 0.18;

// Split out (rather than inlining `object.text.split("\n")` at both call sites) so
// textObjectBounds and renderTextObject can't drift apart on how a line break is recognized.
function textObjectLines(text: string): string[] {
  return text.split("\n");
}

// `y` is the text's top edge (ctx.textBaseline is set to "top" at render time - see
// renderTextObject), matching TextObject's own doc comment. Width is the widest line (each
// measured independently, not the whole string with embedded "\n"s, which measureText would
// otherwise render as stray tofu-glyph width); height grows with the line count.
export function textObjectBounds(object: TextObject): Bounds {
  const lines = textObjectLines(object.text);
  const w = Math.max(...lines.map((line) => measureTextWidth(line, object.fontSize, object.bold)));
  const h = lines.length * object.fontSize * TEXT_LINE_HEIGHT_MULTIPLIER;
  return { x: object.x, y: object.y, w, h };
}

// The box actually visible on screen: textObjectBounds inflated by the same padding
// renderTextObject draws the background rect with, when there is one. Callers that hit-test or
// draw chrome against a text object (findObjectAt, getSelectionBounds, TextAnnotationEditor's
// move/resize/rotate handles) all need this rather than the tight glyph bounds - otherwise the
// selection outline and click target sit visibly inside the yellow backdrop the user actually
// sees instead of tracing its edges. Symmetric padding on every side keeps the box's center
// identical to textObjectBounds's, so callers doing center-anchored math (e.g. the resize
// handler's keep-center-fixed logic) don't need to care which one they used for that part.
export function textObjectVisualBounds(object: TextObject): Bounds {
  const bounds = textObjectBounds(object);
  if (!object.background) return bounds;
  const pad = object.fontSize * TEXT_BACKGROUND_PADDING_RATIO;
  return { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 };
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
// heads, rather than a fixed pixel size that would look spindly on a heavy stroke. Shared between
// the two ends by renderArrow below so a double-headed arrow's second head is pixel-identical to
// its first, just pointed the other way (angle is the direction the head points *away* from,
// i.e. the direction of travel into the tip at (tipX, tipY)).
function drawArrowhead(ctx: CanvasRenderingContext2D, tipX: number, tipY: number, angle: number, width: number): void {
  const headLength = Math.max(10, width * 3.5);
  const headAngle = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - headLength * Math.cos(angle - headAngle), tipY - headLength * Math.sin(angle - headAngle));
  ctx.lineTo(tipX - headLength * Math.cos(angle + headAngle), tipY - headLength * Math.sin(angle + headAngle));
  ctx.closePath();
  ctx.fill();
}

function renderArrow(ctx: CanvasRenderingContext2D, object: ArrowObject): void {
  ctx.save();
  ctx.strokeStyle = object.color;
  ctx.fillStyle = object.color;
  ctx.lineWidth = object.width;
  ctx.lineCap = object.dashed ? "butt" : "round";
  // Scaled with width like the arrowhead itself - a thin dashed line with a fixed-px dash pattern
  // reads as barely-dashed once the line gets thick, and vice versa for a thick pattern on a hairline.
  if (object.dashed) ctx.setLineDash([object.width * 2.5, object.width * 2]);

  ctx.beginPath();
  ctx.moveTo(object.x1, object.y1);
  ctx.lineTo(object.x2, object.y2);
  ctx.stroke();

  const angle = Math.atan2(object.y2 - object.y1, object.x2 - object.x1);
  ctx.setLineDash([]); // arrowheads are always solid, even on a dashed shaft
  drawArrowhead(ctx, object.x2, object.y2, angle, object.width);
  if (object.doubleHeaded) drawArrowhead(ctx, object.x1, object.y1, angle + Math.PI, object.width);
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

// Fixed regardless of backgroundColor - a translucent backdrop is the point (it should still hint
// at the photo underneath), so opacity isn't user-configurable, only the color is. Exported so the
// live text-editing input (ImageEditorCanvas.tsx) can preview at the exact same alpha.
export const TEXT_BACKGROUND_ALPHA = 0.65;

function renderTextObject(ctx: CanvasRenderingContext2D, object: TextObject): void {
  ctx.save();
  const bounds = textObjectBounds(object);
  if (object.rotation !== 0) {
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(object.rotation);
    ctx.translate(-cx, -cy);
  }
  ctx.font = `${object.bold ? "bold " : ""}${object.fontSize}px ${TEXT_FONT_FAMILY}`;
  ctx.textBaseline = "top";
  if (object.background) {
    const visual = textObjectVisualBounds(object);
    ctx.globalAlpha = TEXT_BACKGROUND_ALPHA;
    ctx.fillStyle = object.backgroundColor;
    ctx.fillRect(visual.x, visual.y, visual.w, visual.h);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = object.color;
  const lineHeight = object.fontSize * TEXT_LINE_HEIGHT_MULTIPLIER;
  textObjectLines(object.text).forEach((line, i) => ctx.fillText(line, object.x, object.y + i * lineHeight));
  ctx.restore();
}

// Manual arcTo-based rounded rect rather than the native ctx.roundRect - this runs inside every
// placed-image render (so every redraw while one exists on canvas, not just at creation), and a
// hand-rolled path has no engine-support assumptions to make since this file's whole point is
// working the same regardless of which webview the app is running under.
function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

// Draws a second placed-on-top image, rotated around its own center - mirrors
// pdfAnnotationHandlers.ts's renderImageObject exactly (see PlacedImageObject's own doc comment
// for the shared x/y/rotation convention). Reads from the shared decoded-image cache
// (imageObjectCache.ts) rather than decoding inline, same "preload once, render synchronously"
// split that cache exists for - if the object's src hasn't decoded yet, this is a no-op and the
// caller's preload effect (ImageEditorCanvas) redraws once it resolves. Optional frame styling
// (corner radius / border / drop shadow) layers on in a fixed order: shadow first (a filled,
// otherwise-invisible copy of the same rounded shape, purely to cast the shadow, since
// ctx.shadow* would otherwise also shadow the border stroke and double up), then the image itself
// clipped to the rounded rect, then the border stroked on top so it reads as a frame rather than
// being half-covered by the photo.
function renderPlacedImage(ctx: CanvasRenderingContext2D, object: PlacedImageObject): void {
  const img = getCachedImage(object.src);
  if (!img) return;
  const left = -object.width / 2;
  const top = -object.height / 2;
  const radius = object.cornerRadius ?? 0;

  ctx.save();
  ctx.translate(object.x + object.width / 2, object.y + object.height / 2);
  ctx.rotate(object.rotation);

  if (object.shadow) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
    ctx.shadowBlur = Math.max(8, object.width * 0.03);
    ctx.shadowOffsetY = Math.max(4, object.height * 0.02);
    ctx.fillStyle = "#000000";
    roundedRectPath(ctx, left, top, object.width, object.height, radius);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  roundedRectPath(ctx, left, top, object.width, object.height, radius);
  ctx.clip();
  ctx.drawImage(img, left, top, object.width, object.height);
  ctx.restore();

  if (object.borderWidth && object.borderWidth > 0) {
    ctx.save();
    ctx.strokeStyle = object.borderColor ?? "#ffffff";
    ctx.lineWidth = object.borderWidth;
    // Inset by half the stroke width so the line is drawn *inside* the image's own edge (a stroke
    // centered exactly on the boundary would otherwise bleed half its width past width/height).
    const inset = object.borderWidth / 2;
    roundedRectPath(ctx, left + inset, top + inset, object.width - inset * 2, object.height - inset * 2, Math.max(0, radius - inset));
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

// Solid black box - unlike blur below, this is genuinely irreversible (the covered pixels are
// simply never drawn to the exported image again), so it's the right choice for anything that
// actually needs to stay hidden rather than just de-emphasized.
function renderRedactRegion(ctx: CanvasRenderingContext2D, object: BlurRegionObject): void {
  ctx.save();
  ctx.fillStyle = "#000000";
  ctx.fillRect(object.x, object.y, object.w, object.h);
  ctx.restore();
}

// Redraws a blurred copy of whatever's *already on the destination canvas* within this region -
// see renderComposedCanvas's draw-order comment for why this only ever samples the base
// photo+adjustments layer, never other annotations. `ctx.filter`'s blur is a post-process on the
// drawImage call itself, so drawing the canvas onto itself with a blur filter set is a cheap,
// good-enough (not pixel-perfect at the rect's own edges) way to blur just that region - the same
// technique any canvas-based screenshot tool uses for a de-emphasis effect. Not a *guaranteed*
// redaction (a strong enough deconvolution can partially recover blurred text) - see
// renderRedactRegion above for the actually-irreversible alternative BlurRegionObject's own doc
// comment calls out.
function renderBlurRegion(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, object: BlurRegionObject): void {
  if (object.mode === "redact") {
    renderRedactRegion(ctx, object);
    return;
  }
  ctx.save();
  ctx.filter = `blur(${object.blurRadius}px)`;
  ctx.drawImage(canvas, object.x, object.y, object.w, object.h, object.x, object.y, object.w, object.h);
  ctx.restore();
}

// A filled circle (diameter = the shorter of w/h, centered in the box) with a bold white number -
// deliberately not scaled/positioned via textObjectBounds/measureTextWidth the way TextObject is,
// since a step badge's number is always short (1-2 digits in practice) and centered by construction
// rather than measured; canvas's own textAlign/textBaseline "middle" centering is exact here in a
// way it isn't for TextObject's own left-aligned, top-anchored convention.
function renderStepObject(ctx: CanvasRenderingContext2D, object: StepObject): void {
  const cx = object.x + object.w / 2;
  const cy = object.y + object.h / 2;
  const radius = Math.min(object.w, object.h) / 2;
  ctx.save();
  ctx.fillStyle = object.color;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.max(10, radius * 1.1)}px ${TEXT_FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(object.number), cx, cy);
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
      case "step":
        renderStepObject(ctx, object);
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

export function makeArrowObject(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width: number,
  dashed: boolean = false,
  doubleHeaded: boolean = false
): ArrowObject {
  return { ...baseFields(), type: "arrow", x1, y1, x2, y2, color, width, dashed, doubleHeaded };
}

export function makeRectObject(x: number, y: number, w: number, h: number, color: string, width: number, filled: boolean = false): RectObject {
  return { ...baseFields(), type: "rect", x, y, w, h, color, width, filled };
}

export function makeEllipseObject(x: number, y: number, w: number, h: number, color: string, width: number, filled: boolean = false): EllipseObject {
  return { ...baseFields(), type: "ellipse", x, y, w, h, color, width, filled };
}

export function makeTextObject(
  x: number,
  y: number,
  text: string,
  color: string,
  fontSize: number,
  bold: boolean,
  background: boolean,
  backgroundColor: string
): TextObject {
  // Always starts unrotated, same as makePlacedImageObject's own rotation: 0 - there's no "place
  // it pre-rotated" gesture, only the rotate handle (added after selection) ever changes this.
  return { ...baseFields(), type: "text", x, y, text, color, fontSize, bold, background, backgroundColor, rotation: 0 };
}

export const DEFAULT_BLUR_RADIUS = 16;

export function makeBlurObject(
  x: number,
  y: number,
  w: number,
  h: number,
  mode: "blur" | "redact" = "blur",
  blurRadius: number = DEFAULT_BLUR_RADIUS
): BlurRegionObject {
  return { ...baseFields(), type: "blur", x, y, w, h, blurRadius, mode };
}

export function makePlacedImageObject(
  x: number,
  y: number,
  width: number,
  height: number,
  src: string,
  cornerRadius: number = 0,
  borderWidth: number = 0,
  borderColor: string = "#ffffff",
  shadow: boolean = false
): PlacedImageObject {
  return { ...baseFields(), type: "placed-image", x, y, width, height, rotation: 0, src, cornerRadius, borderWidth, borderColor, shadow };
}

export function makeStepObject(x: number, y: number, w: number, h: number, number: number, color: string): StepObject {
  return { ...baseFields(), type: "step", x, y, w, h, number, color };
}

// The number the *next* placed step badge should show - continues from the highest number
// already on the canvas rather than counting existing badges, so deleting an earlier one doesn't
// cause the next new badge to reuse a number still visible elsewhere in the document.
export function nextStepNumber(objects: ImageAnnotationObject[]): number {
  const numbers = objects.filter((o): o is StepObject => o.type === "step").map((o) => o.number);
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
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
      case "blur":
      case "step": {
        if (x >= object.x - hitRadius && x <= object.x + object.w + hitRadius && y >= object.y - hitRadius && y <= object.y + object.h + hitRadius) {
          return object;
        }
        break;
      }
      case "text": {
        // Visual bounds, not the tight glyph box - with a background on, clicking anywhere inside
        // the yellow backdrop should hit the object, not just the letters themselves.
        const b = textObjectVisualBounds(object);
        // Same unrotate-the-query-point trick placedImageIntersectsPoint uses - bounds stay the
        // object's own unrotated axis-aligned box (see TextObject's own doc comment), so the
        // point needs to be brought into that same local frame before comparing against it.
        const local =
          object.rotation === 0 ? { x, y } : unrotatePoint(x, y, b.x + b.w / 2, b.y + b.h / 2, object.rotation);
        if (local.x >= b.x - hitRadius && local.x <= b.x + b.w + hitRadius && local.y >= b.y - hitRadius && local.y <= b.y + b.h + hitRadius)
          return object;
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

// Bounding box used to draw the Select tool's generic axis-aligned outline/handles - null for
// stroke/highlight (no resize handles for freehand ink, see ImageEditorCanvas's own comment on why
// only bounded-box shapes get resize chrome) and for placed-image/text, which each get their own
// rotation-aware move/resize/rotate chrome instead (ImageAnnotationEditor.tsx and
// TextAnnotationEditor.tsx respectively). Step badges are box-shaped like rect/ellipse/blur (see
// StepObject's own doc comment for why), so they get the same generic corner-drag resize for free.
export function getObjectBounds(object: ImageAnnotationObject): Bounds | null {
  switch (object.type) {
    case "rect":
    case "ellipse":
    case "blur":
    case "step":
      return { x: object.x, y: object.y, w: object.w, h: object.h };
    default:
      return null;
  }
}

// A bounding box for *every* object type, including the ones getObjectBounds deliberately returns
// null for (stroke/highlight/arrow/placed-image, which don't get resize-handle chrome) - used only
// for marquee-select hit-testing and multi-select outline rendering, never for resize handles, so
// it's kept entirely separate from getObjectBounds rather than changing what that one returns.
export function getSelectionBounds(object: ImageAnnotationObject): Bounds {
  switch (object.type) {
    case "stroke":
    case "highlight": {
      const xs = object.points.map((p) => p.x);
      const ys = object.points.map((p) => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const pad = object.width / 2;
      return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    }
    case "arrow": {
      const minX = Math.min(object.x1, object.x2);
      const maxX = Math.max(object.x1, object.x2);
      const minY = Math.min(object.y1, object.y2);
      const maxY = Math.max(object.y1, object.y2);
      const pad = object.width / 2;
      return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    }
    case "placed-image":
      // Axis-aligned box ignoring rotation - good enough for "does the marquee overlap this
      // object", not meant to be pixel-exact for a rotated image.
      return { x: object.x, y: object.y, w: object.width, h: object.height };
    case "text":
      // Also axis-aligned/ignoring rotation, same simplification as placed-image just above -
      // called out explicitly (not left to the default case) now that getObjectBounds no longer
      // returns text's bounds at all, only TextAnnotationEditor's own rotation-aware chrome does.
      // Visual bounds (with background padding) so the marquee/multi-select outline matches what's
      // actually drawn, same reasoning as findObjectAt's hit-test and the single-select chrome.
      return textObjectVisualBounds(object);
    default:
      return getObjectBounds(object) ?? { x: 0, y: 0, w: 0, h: 0 };
  }
}

// Exported for ImageEditor.tsx's own crop handling - see transformObjectForGeometry's doc comment
// for why crop needs this same "does the transformed object still overlap the new canvas at all"
// check to decide which objects survive a crop.
export function rectsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Marquee/rubber-band select: every object whose selection bounds overlap the drag rectangle at
// all (not full-containment) - matches the "drag a box, grab anything it touches" convention most
// design tools use, which feels far less finicky than requiring the whole object to be enclosed.
export function findObjectsInRect(objects: ImageAnnotationObject[], rect: Bounds): ImageAnnotationObject[] {
  return objects.filter((o) => rectsIntersect(getSelectionBounds(o), rect));
}

export type ResizeCorner = "nw" | "ne" | "sw" | "se";

// Resizes a box-shaped object (rect/ellipse/blur/step - see ImageEditDocument's own module
// comment) by dragging one corner, keeping the *opposite* corner fixed. `minSize` prevents the
// box collapsing to zero/negative, which would otherwise flip its effective corners underfoot.
export function resizeBoxObject<T extends RectObject | EllipseObject | BlurRegionObject | StepObject>(
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
// buttons against the *base photo alone* (see ImageEditor.tsx's applyGeometry, which gets that via
// ImageEditorCanvas's getBaseOnlyCanvas rather than the fully-composed canvas) - annotation
// objects are carried through separately via transformObjectForGeometry below, using the exact
// same translate/rotate/scale sequence this function's own ctx calls apply, so an object's
// coordinates land in the same place on the transformed photo instead of being flattened into it.
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

// Maps one point through the exact same translate/rotate/scale sequence rotateFlipCanvas's own
// ctx calls apply (in the same order: center on the output, rotate, flip, then offset by the
// source's own half-size) - see that function's implementation for the canvas-pixel half of this.
// Kept private; callers go through transformObjectForGeometry below, which applies this per
// object-type field rather than duplicating the point math at every call site.
function transformPointForGeometry(
  x: number,
  y: number,
  params: GeometryTransformParams
): { x: number; y: number } {
  const { srcWidth, srcHeight, outWidth, outHeight, quarterTurns, flipH, flipV } = params;
  const localX = x - srcWidth / 2;
  const localY = y - srcHeight / 2;
  const flippedX = flipH ? -localX : localX;
  const flippedY = flipV ? -localY : localY;
  const theta = (quarterTurns * Math.PI) / 2;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    x: flippedX * cos - flippedY * sin + outWidth / 2,
    y: flippedX * sin + flippedY * cos + outHeight / 2,
  };
}

// Carries a stored rotation angle (TextObject.rotation / PlacedImageObject.rotation) through the
// same rotate/flip transformPointForGeometry uses. A flip alone isn't "add nothing" the way it is
// for a plain coordinate - it mirrors the *sense* of rotation (a clockwise tilt reads as
// counterclockwise once the canvas it's sitting on is mirrored), so the flip case negates/reflects
// the angle before the quarter-turn rotation (if any) is added on top - matching the order
// rotateFlipCanvas's own ctx calls apply (scale/flip happens before rotate in canvas-transform
// terms, since it's the transform closest to the drawn content).
function transformAngleForGeometry(theta: number, params: GeometryTransformParams): number {
  const { quarterTurns, flipH, flipV } = params;
  let phi = theta;
  if (flipH && flipV) phi = theta + Math.PI;
  else if (flipH) phi = Math.PI - theta;
  else if (flipV) phi = -theta;
  return phi + (quarterTurns * Math.PI) / 2;
}

export interface GeometryTransformParams {
  srcWidth: number;
  srcHeight: number;
  outWidth: number;
  outHeight: number;
  quarterTurns: 0 | 1 | 2 | 3;
  flipH: boolean;
  flipV: boolean;
}

// Carries one annotation object's own coordinates (and, where it has one, its own stored
// rotation) through a rotate/flip op, so Rotate/Flip can keep every object as a live, editable
// one instead of flattening the whole composition into the new base bitmap the way this editor
// used to (see ImageEditor.tsx's applyGeometry, which calls this once per object and gets
// GeometryTransformParams from the actual before/after canvas dimensions).
//
// Box-shaped objects (rect/ellipse/blur/step) have no rotation field of their own - only their
// center moves, and their w/h swap on a 90/270 turn (never on a plain flip). Text and placed-image
// *reposition and re-tilt* via their own `rotation` field, but their own content isn't
// mirrored/re-rendered - a flipped text label stays legible rather than reading backwards, and a
// placed image's own pixels aren't re-flipped, matching how flipping a whole document normally
// still leaves anything with actual words on it legible.
export function transformObjectForGeometry(object: ImageAnnotationObject, params: GeometryTransformParams): ImageAnnotationObject {
  const pt = (x: number, y: number) => transformPointForGeometry(x, y, params);
  const swapped = params.quarterTurns % 2 === 1;
  const updatedAt = Date.now();

  switch (object.type) {
    case "stroke":
    case "highlight":
      return { ...object, updatedAt, points: object.points.map((p) => ({ ...p, ...pt(p.x, p.y) })) };
    case "arrow": {
      const p1 = pt(object.x1, object.y1);
      const p2 = pt(object.x2, object.y2);
      return { ...object, updatedAt, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }
    case "rect":
    case "ellipse":
    case "blur":
    case "step": {
      const center = pt(object.x + object.w / 2, object.y + object.h / 2);
      const w = swapped ? object.h : object.w;
      const h = swapped ? object.w : object.h;
      return { ...object, updatedAt, x: center.x - w / 2, y: center.y - h / 2, w, h };
    }
    case "text": {
      const bounds = textObjectBounds(object);
      const center = pt(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2);
      return {
        ...object,
        updatedAt,
        x: center.x - bounds.w / 2,
        y: center.y - bounds.h / 2,
        rotation: transformAngleForGeometry(object.rotation, params),
      };
    }
    case "placed-image": {
      const center = pt(object.x + object.width / 2, object.y + object.height / 2);
      const width = swapped ? object.height : object.width;
      const height = swapped ? object.width : object.height;
      return {
        ...object,
        updatedAt,
        x: center.x - width / 2,
        y: center.y - height / 2,
        width,
        height,
        rotation: transformAngleForGeometry(object.rotation, params),
      };
    }
    default:
      return object;
  }
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
    case "batch-add":
      return { ...doc, objects: [...doc.objects, ...command.objects], updatedAt };
    case "batch-delete": {
      const removedIds = new Set(command.objects.map((o) => o.id));
      return { ...doc, objects: doc.objects.filter((o) => !removedIds.has(o.id)), updatedAt };
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
    case "batch-add":
      return { type: "batch-delete", objects: command.objects };
    case "batch-delete":
      return { type: "batch-add", objects: command.objects };
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
