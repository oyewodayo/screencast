// handlers/pdfAnnotationHandlers.ts
//
// Pure functions only — no React, no closures over component state. Mirrors the style of
// mediaHandlers.ts / keyboardHandlers.ts: callers pass in everything they need explicitly.

import { getStroke } from "perfect-freehand";
import type { PDFPageProxy } from "pdfjs-dist";
import {
  AnnotationCommand,
  AnnotationObject,
  HighlightObject,
  PdfAnnotationDocument,
  Pt,
  StrokeObject,
} from "../utils/pdfAnnotationTypes";

// ---- Coordinate conversion (device px <-> PDF page-space) ----------------------------------

export function devicePointToPdfPoint(
  viewport: { convertToPdfPoint: (x: number, y: number) => number[] },
  clientX: number,
  clientY: number,
  pressure: number
): Pt {
  const [x, y] = viewport.convertToPdfPoint(clientX, clientY);
  return { x, y, pressure };
}

export function pdfPointToDevicePoint(
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] },
  point: Pt
): { x: number; y: number } {
  const [x, y] = viewport.convertToViewportPoint(point.x, point.y);
  return { x, y };
}

// ---- Stroke geometry -------------------------------------------------------------------------

// Pen tool: pressure-tapered variable-width outline via perfect-freehand. Returns an outline
// polygon (already closed) in the same coordinate space as the input points.
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

// Highlighter: constant-width, semi-transparent, multiply-blended line — no pressure taper,
// cheaper than perfect-freehand for long swipes, and visually correct for a marker tool.
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

// Renders one committed object onto a canvas, converting its stored PDF-space points to
// device space via the given viewport. `scale` further multiplies stroke width so line
// thickness stays visually consistent as the viewport's zoom/DPR changes.
export function renderObject(
  ctx: CanvasRenderingContext2D,
  object: AnnotationObject,
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] },
  scale: number
): void {
  const devicePoints = object.points.map((p) => pdfPointToDevicePoint(viewport, p));

  ctx.save();
  ctx.globalAlpha = object.opacity;

  if (object.type === "stroke") {
    const outline = strokeToOutline(
      object.points.map((p, i) => ({ ...p, x: devicePoints[i].x, y: devicePoints[i].y })),
      object.width * scale
    );
    ctx.fillStyle = object.color;
    pathFromOutline(ctx, outline);
    ctx.fill();
  } else {
    ctx.globalCompositeOperation = object.blend ?? "multiply";
    ctx.strokeStyle = object.color;
    drawHighlightPath(ctx, devicePoints, object.width * scale);
  }

  ctx.restore();
}

// Clears a canvas regardless of any transform currently applied to its context (e.g. the
// ctx.scale(dpr, dpr) PdfPage applies once at setup) by resetting to the identity transform
// first. Safer than computing CSS-space clear dimensions by hand at every call site.
export function clearCanvas(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

// Live (in-progress) stroke preview, drawn in the same viewport/CSS-pixel coordinate space the
// points were captured in — called every pointermove against only the current stroke's points,
// so cost is independent of how many prior strokes exist on the page.
export function renderLiveStroke(
  ctx: CanvasRenderingContext2D,
  tool: "pen" | "highlighter",
  points: Pt[],
  color: string,
  width: number
): void {
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

export function renderEraserCursor(ctx: CanvasRenderingContext2D, point: Pt, radius: number): void {
  ctx.save();
  ctx.strokeStyle = "#666666";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function renderPageObjects(
  ctx: CanvasRenderingContext2D,
  objects: AnnotationObject[],
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] },
  scale: number
): void {
  for (const object of objects) {
    renderObject(ctx, object, viewport, scale);
  }
}

// ---- Eraser hit-testing ------------------------------------------------------------------------

function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

function objectIntersectsPoint(object: AnnotationObject, pdfPoint: Pt, radiusInPdfUnits: number): boolean {
  const hitRadius = radiusInPdfUnits + object.width / 2;
  for (let i = 0; i < object.points.length - 1; i++) {
    if (distanceToSegment(pdfPoint, object.points[i], object.points[i + 1]) <= hitRadius) {
      return true;
    }
  }
  if (object.points.length === 1) {
    return Math.hypot(pdfPoint.x - object.points[0].x, pdfPoint.y - object.points[0].y) <= hitRadius;
  }
  return false;
}

// Returns the objects on the page that intersect the eraser at this point. Callers accumulate
// results across a whole pointer drag and remove them all as a single undo command.
export function hitTestEraser(
  objects: AnnotationObject[],
  pdfPoint: Pt,
  radiusInPdfUnits: number
): AnnotationObject[] {
  return objects.filter((object) => objectIntersectsPoint(object, pdfPoint, radiusInPdfUnits));
}

// ---- Document mutation (pure) -------------------------------------------------------------------

// Applies a command, returning a new document. Only the affected page's array is copied —
// other pages keep their existing object references so unaffected <PdfPage> instances don't
// see a prop change. Callers (useAnnotationStore) are responsible for the undo/redo stacks.
export function applyCommand(doc: PdfAnnotationDocument, command: AnnotationCommand): PdfAnnotationDocument {
  const pageIndex = command.type === "add" ? command.object.pageIndex : command.pageIndex;
  const existingPage = doc.pages.find((p) => p.pageIndex === pageIndex);
  let objects = existingPage ? [...existingPage.objects] : [];

  if (command.type === "add") {
    objects.push(command.object);
  } else {
    const removedIds = new Set(command.removed.map((o) => o.id));
    objects = objects.filter((o) => !removedIds.has(o.id));
  }

  const newPage = { pageIndex, objects };
  const pages = existingPage
    ? doc.pages.map((p) => (p.pageIndex === pageIndex ? newPage : p))
    : [...doc.pages, newPage];

  return { ...doc, pages, updatedAt: new Date().toISOString() };
}

export function invertCommand(command: AnnotationCommand): AnnotationCommand {
  if (command.type === "add") {
    return { type: "erase", pageIndex: command.object.pageIndex, removed: [command.object] };
  }
  // Inverting an erase re-adds every removed object; applyCommand only understands single-object
  // 'add' commands, so the caller (undo) applies each removed object as its own 'add'.
  return command;
}

export function makeStrokeObject(
  pageIndex: number,
  points: Pt[],
  color: string,
  width: number
): StrokeObject {
  const now = Date.now();
  return { id: crypto.randomUUID(), type: "stroke", pageIndex, points, color, width, opacity: 1, createdAt: now, updatedAt: now };
}

export function makeHighlightObject(
  pageIndex: number,
  points: Pt[],
  color: string,
  width: number
): HighlightObject {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    type: "highlight",
    pageIndex,
    points,
    color,
    width,
    opacity: 0.35,
    blend: "multiply",
    createdAt: now,
    updatedAt: now,
  };
}

export function getPageViewportSize(page: PDFPageProxy, scale: number): { width: number; height: number } {
  const viewport = page.getViewport({ scale });
  return { width: viewport.width, height: viewport.height };
}

// ---- Text-aware highlighting -------------------------------------------------------------------
//
// pdf.js's text content items carry a `transform` matrix whose [e, f] translation is the glyph's
// baseline position, and a `width`/`height`, all in the page's default (unrotated, scale: 1)
// coordinate space — the exact same space `viewport.convertToPdfPoint` targets. That's what lets
// us hit-test a highlighter stroke against real text geometry without ever touching device pixels.

export interface TextLine {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

const FALLBACK_TEXT_HEIGHT = 4; // pdf-space units, for degenerate zero-height items

// pdf.js's own `TextItem` type isn't re-exported from the package's top-level entry point
// (only reachable via an internal `pdfjs-dist/types/src/display/api` path we'd rather not
// depend on) — this is the minimal shape we actually read off of it.
interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

function isTextItem(item: unknown): item is RawTextItem {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

// Extracts one bounding box per visual line of text on the page, merging individual word/run
// items that vertically overlap (i.e. sit on the same line). Cheap enough to run once per page
// view — not called per pointer event.
export async function getPageTextLines(page: PDFPageProxy): Promise<TextLine[]> {
  const content = await page.getTextContent();
  const lines: TextLine[] = [];

  for (const item of content.items) {
    if (!isTextItem(item) || !item.str.trim()) continue;
    const e = item.transform[4];
    const f = item.transform[5];
    const height = item.height || FALLBACK_TEXT_HEIGHT;
    const width = item.width || 0;

    const yMin = f;
    const yMax = f + height;
    const xMin = e;
    const xMax = e + width;

    const existing = lines.find((line) => Math.min(yMax, line.yMax) - Math.max(yMin, line.yMin) > height * 0.5);
    if (existing) {
      existing.xMin = Math.min(existing.xMin, xMin);
      existing.xMax = Math.max(existing.xMax, xMax);
      existing.yMin = Math.min(existing.yMin, yMin);
      existing.yMax = Math.max(existing.yMax, yMax);
    } else {
      lines.push({ xMin, xMax, yMin, yMax });
    }
  }

  return lines;
}

// Finds the text line under a PDF-space point, with generous slack so an imprecise click still
// lands on the intended line/word rather than requiring pixel-perfect placement. Returns null
// when the point isn't over any detected text — the caller's cue to fall back to freehand
// (manual-width) highlighting, which is exactly what makes highlighting still work over images
// or blank page regions.
export function findTextLineAt(lines: TextLine[], point: Pt, xToleranceMultiplier = 3): TextLine | null {
  for (const line of lines) {
    const height = line.yMax - line.yMin;
    const ySlack = height * 0.35;
    if (point.y < line.yMin - ySlack || point.y > line.yMax + ySlack) continue;
    const xSlack = height * xToleranceMultiplier;
    if (point.x < line.xMin - xSlack || point.x > line.xMax + xSlack) continue;
    return line;
  }
  return null;
}
