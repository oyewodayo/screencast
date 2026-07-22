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
  ImageObject,
  PdfAnnotationDocument,
  Pt,
  StrokeObject,
  TextColorRun,
  TextObject,
  TextRange,
} from "../utils/pdfAnnotationTypes";
import { getCachedImage } from "../utils/imageObjectCache";

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
// device space via the given viewport. `scale` further multiplies stroke width/font size so
// dimensions stay visually consistent as the viewport's zoom/DPR changes.
export function renderObject(
  ctx: CanvasRenderingContext2D,
  object: AnnotationObject,
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] },
  scale: number
): void {
  ctx.save();

  if (object.type === "text") {
    renderTextObject(ctx, object, viewport, scale);
    ctx.restore();
    return;
  }

  if (object.type === "image") {
    renderImageObject(ctx, object, viewport, scale);
    ctx.restore();
    return;
  }

  const devicePoints = object.points.map((p) => pdfPointToDevicePoint(viewport, p));
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

// ---- Images -------------------------------------------------------------------------------------
//
// Stored top-left anchored (pre-rotation), same convention as TextObject. Rotation is applied
// around the box's *center* at render/hit-test time, so x/y/width/height never change just because
// the object is rotated — only ImageAnnotationEditor's live resize (which is itself center-
// anchored) ever touches them directly.

function renderImageObject(
  ctx: CanvasRenderingContext2D,
  object: ImageObject,
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] },
  scale: number
): void {
  const img = getCachedImage(object.src);
  if (!img) return; // not decoded yet — the caller's preload effect redraws once it resolves

  const topLeft = pdfPointToDevicePoint(viewport, { x: object.x, y: object.y, pressure: 1 });
  const w = object.width * scale;
  const h = object.height * scale;

  ctx.translate(topLeft.x + w / 2, topLeft.y + h / 2);
  ctx.rotate(object.rotation);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
}

export function makeImageObject(
  pageIndex: number,
  x: number,
  y: number,
  width: number,
  height: number,
  src: string
): ImageObject {
  const now = Date.now();
  return { id: crypto.randomUUID(), type: "image", pageIndex, x, y, width, height, rotation: 0, src, createdAt: now, updatedAt: now };
}

// Rotates `point` by `radians` around `center`, using the standard CCW-positive matrix — used to
// bring a query point into an image's local (unrotated) frame instead of needing a rotated-
// rectangle intersection test.
//
// Note the sign here is *not* just "-object.rotation": `object.rotation` is authored as a
// device-space (y-down) clockwise angle (it's fed straight into ctx.rotate()/CSS `rotate()`), but
// this function operates on PDF-space (y-up) points. Flipping the y-axis between those two spaces
// also flips the apparent handedness of the rotation, so undoing a device-space +θ rotation on a
// PDF-space point requires rotating by +θ here, not -θ (verified by tracing a concrete vector
// through both spaces — see the ImageObject hit-testing discussion).
function rotatePointAroundCenter(point: Pt, center: { x: number; y: number }, radians: number): Pt {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos, pressure: point.pressure };
}

function imageIntersectsPoint(object: ImageObject, pdfPoint: Pt, paddingInPdfUnits: number): boolean {
  const center = { x: object.x + object.width / 2, y: object.y - object.height / 2 };
  const local = rotatePointAroundCenter(pdfPoint, center, object.rotation);
  return (
    local.x >= object.x - paddingInPdfUnits &&
    local.x <= object.x + object.width + paddingInPdfUnits &&
    local.y <= object.y + paddingInPdfUnits &&
    local.y >= object.y - object.height - paddingInPdfUnits
  );
}

// Click-to-select hit test, mirroring findTextObjectAt's signature/bounding-box style but
// iterating topmost (last-drawn) first — images are far more likely than text notes to overlap,
// so which one a click lands on should follow visual stacking order.
export function findImageObjectAt(objects: AnnotationObject[], point: Pt): ImageObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const object = objects[i];
    if (object.type === "image" && imageIntersectsPoint(object, point, 0)) return object;
  }
  return null;
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
  if (object.type === "text") {
    // Bounding-box test with the eraser radius as padding — text has no meaningful "line width"
    // the way a stroke/highlight path does.
    return (
      pdfPoint.x >= object.x - radiusInPdfUnits &&
      pdfPoint.x <= object.x + object.width + radiusInPdfUnits &&
      pdfPoint.y <= object.y + radiusInPdfUnits &&
      pdfPoint.y >= object.y - object.height - radiusInPdfUnits
    );
  }

  if (object.type === "image") {
    return imageIntersectsPoint(object, pdfPoint, radiusInPdfUnits);
  }

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
  } else if (command.type === "erase") {
    const removedIds = new Set(command.removed.map((o) => o.id));
    objects = objects.filter((o) => !removedIds.has(o.id));
  } else {
    // edit: replace the matching object in place (used for retyping an existing text note).
    objects = objects.map((o) => (o.id === command.after.id ? command.after : o));
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
  if (command.type === "edit") {
    return { type: "edit", pageIndex: command.pageIndex, before: command.after, after: command.before };
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

// ---- Text notes (jotting) ---------------------------------------------------------------------
//
// Fixed-width, word-wrapped text blocks. Wrapping is computed with plain canvas font metrics
// (measureText), and — critically — the *same* wrap function is used both when a note is
// committed (to measure its stored `height`) and when it's rendered, just fed PDF-space vs.
// device-space font sizes respectively. Because canvas text metrics scale linearly with font
// size, wrapping at "1 PDF unit == 1px" and later drawing at "fontSize * scale px" always
// produces identical line breaks — so there's exactly one wrap implementation to keep correct,
// not two that can silently drift apart (which would otherwise make the stored `height` used for
// click-to-edit/eraser hit-testing wrong relative to what's actually painted).

export const TEXT_FONT_FAMILY = "system-ui, -apple-system, sans-serif";
const TEXT_LINE_HEIGHT_MULTIPLIER = 1.3;

// A detached 1x1 canvas kept around purely so measureTextBlock has a 2D context to call
// ctx.measureText on without needing a real page's context (which may not be zoomed the way we
// want to measure in, and shouldn't have its transform/font state disturbed by an unrelated call).
let measurementCanvas: HTMLCanvasElement | null = null;
function getMeasurementContext(): CanvasRenderingContext2D {
  if (!measurementCanvas) measurementCanvas = document.createElement("canvas");
  const ctx = measurementCanvas.getContext("2d");
  if (!ctx) throw new Error("Failed to acquire 2D context for text measurement");
  return ctx;
}

// A wrapped line plus where it begins in the original (unwrapped) text — the offset is what lets
// renderTextObject map TextObject.colorRuns (character ranges into the original string) onto the
// right sub-span of the right visual line.
interface WrappedTextLine {
  text: string;
  startOffset: number;
}

// Splits `text` into wrapped lines that fit within `maxWidth` (in whatever unit `ctx.font`'s
// size is currently set in), honoring explicit newlines as hard paragraph breaks first. Tracks
// each line's starting offset in `text` alongside it as it goes — `wordOffset`/`paragraphOffset`
// can overrun by one (counting a trailing space/newline that isn't actually there) at the very
// end of a paragraph/the whole text, but that's harmless since neither is read again afterward.
function wrapTextBlock(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): WrappedTextLine[] {
  const lines: WrappedTextLine[] = [];
  let paragraphOffset = 0;

  const paragraphs = text.split("\n");
  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      lines.push({ text: "", startOffset: paragraphOffset });
    } else {
      const words = paragraph.split(" ");
      let current = "";
      let lineStart = paragraphOffset;
      let wordOffset = paragraphOffset;

      for (const word of words) {
        const attempt = current ? `${current} ${word}` : word;
        if (current && ctx.measureText(attempt).width > maxWidth) {
          lines.push({ text: current, startOffset: lineStart });
          current = word;
          lineStart = wordOffset;
        } else {
          current = attempt;
        }
        wordOffset += word.length + 1;
      }
      lines.push({ text: current, startOffset: lineStart });
    }
    paragraphOffset += paragraph.length + 1;
  }

  return lines;
}

export interface MeasuredTextBlock {
  lines: WrappedTextLine[];
  lineHeight: number;
  height: number;
}

// `fontSize`/`maxWidth` are read as PDF-space units here (see the section note above) — the
// returned `height` is therefore directly usable as TextObject.height with no further scaling.
export function measureTextBlock(text: string, fontSize: number, maxWidth: number): MeasuredTextBlock {
  const ctx = getMeasurementContext();
  ctx.font = `${fontSize}px ${TEXT_FONT_FAMILY}`;
  const lines = wrapTextBlock(ctx, text, maxWidth);
  const lineHeight = fontSize * TEXT_LINE_HEIGHT_MULTIPLIER;
  return { lines, lineHeight, height: lines.length * lineHeight };
}

function renderTextObject(
  ctx: CanvasRenderingContext2D,
  object: TextObject,
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] },
  scale: number
): void {
  const topLeft = pdfPointToDevicePoint(viewport, { x: object.x, y: object.y, pressure: 1 });
  const deviceFontSize = object.fontSize * scale;
  const deviceMaxWidth = object.width * scale;
  const baseFont = `${deviceFontSize}px ${TEXT_FONT_FAMILY}`;

  ctx.font = baseFont;
  ctx.textBaseline = "top";

  // Wrapping itself always uses the base (regular-weight, upright) font metrics, even for lines
  // containing bold text — bold glyphs run slightly wider, so a line with a lot of bold near the
  // wrap width could in principle overflow it by a few px. Accepted as a minor known limitation
  // rather than making wrapping itself format-aware, which these short annotation notes rarely
  // approach in practice.
  const lines = wrapTextBlock(ctx, object.text, deviceMaxWidth);
  const lineHeight = deviceFontSize * TEXT_LINE_HEIGHT_MULTIPLIER;
  const colorRuns = object.colorRuns ?? [];
  const boldRuns = object.boldRuns ?? [];
  const italicRuns = object.italicRuns ?? [];
  const hasFormatting = colorRuns.length > 0 || boldRuns.length > 0 || italicRuns.length > 0;

  lines.forEach((line, i) => {
    const y = topLeft.y + i * lineHeight;

    if (!hasFormatting) {
      ctx.font = baseFont;
      ctx.fillStyle = object.color;
      ctx.fillText(line.text, topLeft.x, y);
      return;
    }

    // Split this line into sub-segments at every color/bold/italic boundary that falls inside it
    // (clipped to the line's own bounds), so each segment is guaranteed to be either fully
    // covered by a given run or fully uncovered by it — never straddling a boundary — for all
    // three independently.
    const lineStart = line.startOffset;
    const lineEnd = line.startOffset + line.text.length;
    const cutSet = new Set<number>([0, line.text.length]);
    const addBoundaries = (ranges: TextRange[]): void => {
      for (const range of ranges) {
        if (range.end <= lineStart || range.start >= lineEnd) continue;
        cutSet.add(Math.max(0, range.start - lineStart));
        cutSet.add(Math.min(line.text.length, range.end - lineStart));
      }
    };
    addBoundaries(colorRuns);
    addBoundaries(boldRuns);
    addBoundaries(italicRuns);
    const cuts = Array.from(cutSet).sort((a, b) => a - b);

    let x = topLeft.x;
    for (let s = 0; s < cuts.length - 1; s++) {
      const segStart = cuts[s];
      const segEnd = cuts[s + 1];
      if (segEnd <= segStart) continue;
      const segment = line.text.slice(segStart, segEnd);
      const absoluteStart = lineStart + segStart;
      const absoluteEnd = lineStart + segEnd;
      const coveringColor = colorRuns.find((run) => run.start <= absoluteStart && run.end >= absoluteEnd);
      const isBold = boldRuns.some((run) => run.start <= absoluteStart && run.end >= absoluteEnd);
      const isItalic = italicRuns.some((run) => run.start <= absoluteStart && run.end >= absoluteEnd);

      ctx.font = `${isItalic ? "italic " : ""}${isBold ? "bold " : ""}${baseFont}`;
      ctx.fillStyle = coveringColor?.color ?? object.color;
      ctx.fillText(segment, x, y);
      x += ctx.measureText(segment).width;
    }
  });
}

// Inserts a new colored run over [start, end), trimming/splitting any existing runs that overlap
// it — the stored colorRuns array is always a flat, non-overlapping interval list (never a stack
// to composite at render time), which is what keeps renderTextObject's per-segment lookup above
// a simple single `.find`.
export function applyColorRun(existing: TextColorRun[], start: number, end: number, color: string): TextColorRun[] {
  if (start >= end) return existing;
  const result: TextColorRun[] = [];
  for (const run of existing) {
    if (run.end <= start || run.start >= end) {
      result.push(run);
      continue;
    }
    if (run.start < start) result.push({ start: run.start, end: start, color: run.color });
    if (run.end > end) result.push({ start: end, end: run.end, color: run.color });
  }
  result.push({ start, end, color });
  return result.sort((a, b) => a.start - b.start);
}

// Keeps a list of ranges' offsets correct as the user keeps typing — generic over anything
// shaped like a TextRange (TextColorRun's extra `color` field rides along for free via the
// spread), so color/bold/italic ranges can all share this one diffing implementation. Called on
// every keystroke with the text before/after that keystroke. Finds the common prefix/suffix
// between old and new text (the same trick a simple diff uses) to isolate what actually changed,
// then shifts ranges entirely after the edit, leaves ranges entirely before it alone, and trims
// ranges that overlap it down to whichever side(s) survive. The freshly-typed text inside an
// edited span never inherits formatting — simplest predictable behavior, not a full rich-text
// diff/merge.
function shiftRanges<T extends TextRange>(ranges: T[], oldText: string, newText: string): T[] {
  if (ranges.length === 0 || oldText === newText) return ranges;

  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;

  const oldEditEnd = oldText.length - suffix;
  const newEditEnd = newText.length - suffix;
  const delta = newEditEnd - oldEditEnd;

  const shifted: T[] = [];
  for (const range of ranges) {
    if (range.end <= prefix) {
      shifted.push(range);
      continue;
    }
    if (range.start >= oldEditEnd) {
      shifted.push({ ...range, start: range.start + delta, end: range.end + delta });
      continue;
    }
    if (range.start < prefix) shifted.push({ ...range, start: range.start, end: prefix });
    if (range.end > oldEditEnd) shifted.push({ ...range, start: newEditEnd, end: range.end + delta });
  }
  return shifted.filter((r) => r.end > r.start);
}

export function shiftColorRunsForEdit(runs: TextColorRun[], oldText: string, newText: string): TextColorRun[] {
  return shiftRanges(runs, oldText, newText);
}

export function shiftTextRangesForEdit(ranges: TextRange[], oldText: string, newText: string): TextRange[] {
  return shiftRanges(ranges, oldText, newText);
}

// Adds [start, end) to a list of plain (valueless) ranges — used for bold/italic, where "in the
// list" simply means "on". Unlike applyColorRun (which replaces on overlap, since a run's color
// is a single value), this is a straightforward interval union: overlapping/adjacent ranges merge
// into one rather than splitting.
export function addTextRange(existing: TextRange[], start: number, end: number): TextRange[] {
  if (start >= end) return existing;
  const merged = [...existing, { start, end }].sort((a, b) => a.start - b.start);
  const result: TextRange[] = [];
  for (const range of merged) {
    const last = result[result.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      result.push({ ...range });
    }
  }
  return result;
}

// Removes [start, end) from a list of ranges, trimming/splitting whatever overlapped it — the
// inverse of addTextRange, used to turn bold/italic back off over a selection.
export function removeTextRange(existing: TextRange[], start: number, end: number): TextRange[] {
  if (start >= end) return existing;
  const result: TextRange[] = [];
  for (const range of existing) {
    if (range.end <= start || range.start >= end) {
      result.push(range);
      continue;
    }
    if (range.start < start) result.push({ start: range.start, end: start });
    if (range.end > end) result.push({ start: end, end: range.end });
  }
  return result;
}

// Is [start, end) *entirely* within the union of `existing`? Used to decide which way a
// bold/italic toggle button should go for the current selection.
export function isTextRangeCovered(existing: TextRange[], start: number, end: number): boolean {
  if (start >= end) return false;
  let cursor = start;
  for (const range of [...existing].sort((a, b) => a.start - b.start)) {
    if (range.start > cursor) return false; // gap before this range — not fully covered
    if (range.end > cursor) cursor = range.end;
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

// Standard toggle semantics (as in any word processor): if the selection is already fully
// bold/italic, turn it off; otherwise turn it fully on. Shared by both the bold and italic
// buttons in TextNoteEditor — they only differ in which ranges array they pass in.
export function toggleTextRange(existing: TextRange[], start: number, end: number): TextRange[] {
  return isTextRangeCovered(existing, start, end) ? removeTextRange(existing, start, end) : addTextRange(existing, start, end);
}

export function makeTextObject(
  pageIndex: number,
  x: number,
  y: number,
  text: string,
  color: string,
  fontSize: number,
  width: number,
  height: number
): TextObject {
  const now = Date.now();
  return { id: crypto.randomUUID(), type: "text", pageIndex, x, y, text, color, fontSize, width, height, createdAt: now, updatedAt: now };
}

// Click-to-edit hit test: is `point` inside this text block's bounding box? (Top-left anchored,
// growing downward on screen == decreasing PDF y — see the TextObject doc comment.)
export function findTextObjectAt(objects: AnnotationObject[], point: Pt): TextObject | null {
  for (const object of objects) {
    if (object.type !== "text") continue;
    const withinX = point.x >= object.x && point.x <= object.x + object.width;
    const withinY = point.y <= object.y && point.y >= object.y - object.height;
    if (withinX && withinY) return object;
  }
  return null;
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
