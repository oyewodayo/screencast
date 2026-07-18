// hooks/useStrokeCapture.ts
import { RefObject, useEffect, useRef } from "react";
import type { PageViewport } from "pdfjs-dist";
import { AnnotationObject, AnnotationTool, Pt } from "../utils/pdfAnnotationTypes";
import {
  clearCanvas,
  devicePointToPdfPoint,
  findTextLineAt,
  makeHighlightObject,
  makeStrokeObject,
  pdfPointToDevicePoint,
  renderEraserCursor,
  renderLiveStroke,
  TextLine,
} from "../handlers/pdfAnnotationHandlers";

interface UseStrokeCaptureOptions {
  scratchCanvasRef: RefObject<HTMLCanvasElement>;
  enabled: boolean;
  tool: AnnotationTool | null; // null = no tool selected, capture is disabled entirely
  color: string;
  width: number; // device/CSS pixels, at the current zoom — manual fallback for pen/eraser,
  // and for the highlighter whenever the stroke isn't over detected text (e.g. an image).
  eraserRadius: number; // device/CSS pixels
  pageIndex: number;
  viewport: PageViewport | null;
  textLines: TextLine[] | null; // null while still loading; [] once loaded with no text
  onStrokeComplete: (object: AnnotationObject) => void;
  onEraseBegin: (pageIndex: number) => void;
  onEraseAt: (pageIndex: number, point: Pt, radiusInPdfUnits: number) => void;
  onEraseEnd: () => void;
}

// The line of text the highlighter has locked onto for the current stroke. Null means either
// the tool isn't the highlighter, or no text has been found under the pointer *yet* — detection
// keeps retrying on every pointermove until it locks (see detectActiveLine), so a drag that
// starts a few pixels off the text still catches it as soon as it crosses into it, rather than
// silently staying in freehand mode for the rest of the stroke.
interface ActiveTextLine {
  heightPdf: number;
  centerYDevice: number;
}

// Captures pointerdown/move/up on a small "scratch" canvas layered above the committed ink
// overlay. Only the in-progress stroke is redrawn per frame (rAF-throttled), so cost is
// independent of how many prior strokes already exist on the page. The finished stroke is
// converted to PDF page-space once, on pointerup, and handed to the caller to commit.
export default function useStrokeCapture(opts: UseStrokeCaptureOptions): void {
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const pointsRef = useRef<Pt[]>([]);
  const drawingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const activeLineRef = useRef<ActiveTextLine | null>(null);
  // The single pointer this stroke belongs to. Without this, a resting palm on a touchscreen
  // (or any second simultaneous contact) fires its own independent pointerdown/move/up stream on
  // this same canvas — its pointerdown resets `pointsRef` mid-stroke and its moves get appended
  // alongside the real finger's, producing exactly the chaotic, jumping-between-two-locations
  // scribble you get from bare-hand touch drawing without this. Every handler below ignores
  // events from any pointerId other than this one for the duration of a stroke — first contact
  // wins, everything else is rejected until release, which is the standard "poor man's palm
  // rejection" approach for devices without hardware-level palm detection.
  const activePointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = opts.scratchCanvasRef.current;
    if (!canvas || !opts.enabled) return;

    // touch-action: none while a drawing tool is active (this effect only runs then — see
    // `enabled` in PdfPage, which is false in plain view/select mode) so a touchscreen doesn't
    // interpret an in-progress stroke as a pan/scroll gesture, which otherwise intermittently
    // hijacks the drag (stutters, or cuts the stroke short with a pointercancel) partway through.
    // Reset on cleanup so scrolling by touch still works normally once no tool is selected.
    const previousTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = "none";

    const localPoint = (e: PointerEvent): Pt => {
      const rect = canvas.getBoundingClientRect();
      const pressure = e.pointerType === "pen" ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5;
      return { x: e.clientX - rect.left, y: e.clientY - rect.top, pressure };
    };

    // While locked onto a text line, a captured point's y is pinned to that line's device-space
    // center — only x follows the pointer. That's what turns a wobbly hand-drawn drag into a
    // clean, line-aligned highlight band, the same way a real text highlighter behaves.
    const snapToActiveLine = (point: Pt): Pt => {
      const line = activeLineRef.current;
      return line ? { ...point, y: line.centerYDevice } : point;
    };

    // Tries to lock the highlighter onto whatever text line is under `point`. Only takes effect
    // while not already locked — once a line is found it's held for the rest of the stroke
    // (crossing into a different line mid-drag doesn't re-target, which would otherwise produce
    // a single object jumping between two different line heights).
    const detectActiveLine = (point: Pt): void => {
      if (activeLineRef.current) return;
      const current = optsRef.current;
      if (current.tool !== "highlighter" || !current.viewport || !current.textLines) return;

      const pdfPoint = devicePointToPdfPoint(current.viewport, point.x, point.y, point.pressure);
      const line = findTextLineAt(current.textLines, pdfPoint);
      if (!line) return;

      const centerYPdf = (line.yMin + line.yMax) / 2;
      const heightPdf = line.yMax - line.yMin;
      const centerYDevice = pdfPointToDevicePoint(current.viewport, { x: pdfPoint.x, y: centerYPdf, pressure: 1 }).y;
      activeLineRef.current = { heightPdf, centerYDevice };

      // Retroactively snap every point captured before the lock landed, so the stroke doesn't
      // show a kink where it transitions from "following the raw cursor" to "glued to the line".
      pointsRef.current = pointsRef.current.map((p) => ({ ...p, y: centerYDevice }));
    };

    const effectiveWidthDevice = (): number => {
      const current = optsRef.current;
      const line = activeLineRef.current;
      if (current.tool === "highlighter" && line && current.viewport) {
        return line.heightPdf * current.viewport.scale;
      }
      return current.width;
    };

    const redraw = (): void => {
      rafRef.current = null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      clearCanvas(ctx, canvas);

      const current = optsRef.current;
      if (current.tool === "eraser") {
        const last = pointsRef.current[pointsRef.current.length - 1];
        if (last) renderEraserCursor(ctx, last, current.eraserRadius);
        return;
      }
      if (current.tool !== "pen" && current.tool !== "highlighter") return; // null or 'text' — nothing to preview here
      renderLiveStroke(ctx, current.tool, pointsRef.current, current.color, effectiveWidthDevice());
    };

    const scheduleRedraw = (): void => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(redraw);
    };

    const eraseAtPoint = (point: Pt): void => {
      const current = optsRef.current;
      if (!current.viewport) return;
      const pdfPoint = devicePointToPdfPoint(current.viewport, point.x, point.y, point.pressure);
      const pdfRadius = current.eraserRadius / current.viewport.scale;
      current.onEraseAt(current.pageIndex, pdfPoint, pdfRadius);
    };

    const handlePointerDown = (e: PointerEvent): void => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // A stroke is already in progress under a different pointer (a palm/second contact) —
      // reject this one outright rather than letting it hijack or reset the active stroke.
      if (drawingRef.current && e.pointerId !== activePointerIdRef.current) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      activePointerIdRef.current = e.pointerId;
      drawingRef.current = true;
      activeLineRef.current = null;

      const point = localPoint(e);
      pointsRef.current = [point];
      detectActiveLine(point);
      pointsRef.current = [snapToActiveLine(point)];

      if (optsRef.current.tool === "eraser") {
        optsRef.current.onEraseBegin(optsRef.current.pageIndex);
        eraseAtPoint(pointsRef.current[0]);
      }
      scheduleRedraw();
    };

    const handlePointerMove = (e: PointerEvent): void => {
      if (!drawingRef.current || e.pointerId !== activePointerIdRef.current) return;
      const point = localPoint(e);
      if (optsRef.current.tool === "eraser") {
        pointsRef.current.push(point);
        eraseAtPoint(point);
      } else {
        detectActiveLine(point);
        pointsRef.current.push(snapToActiveLine(point));
      }
      scheduleRedraw();
    };

    const finishStroke = (): void => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      activePointerIdRef.current = null;

      const points = pointsRef.current;
      const line = activeLineRef.current;
      pointsRef.current = [];
      activeLineRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const ctx = canvas.getContext("2d");
      if (ctx) clearCanvas(ctx, canvas);

      const current = optsRef.current;
      if (current.tool === "eraser") {
        current.onEraseEnd();
        return;
      }
      if (current.tool !== "pen" && current.tool !== "highlighter") return; // null or 'text' — this hook never draws those
      if (points.length === 0 || !current.viewport) return;

      const pdfPoints = points.map((p) => devicePointToPdfPoint(current.viewport as PageViewport, p.x, p.y, p.pressure));
      const pdfWidth = current.tool === "highlighter" && line ? line.heightPdf : current.width / current.viewport.scale;
      const object =
        current.tool === "pen"
          ? makeStrokeObject(current.pageIndex, pdfPoints, current.color, pdfWidth)
          : makeHighlightObject(current.pageIndex, pdfPoints, current.color, pdfWidth);
      current.onStrokeComplete(object);
    };

    const handlePointerUp = (e: PointerEvent): void => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      // A rejected second pointer (see handlePointerDown) still fires its own up/cancel — must
      // not be allowed to end the real stroke that's still in progress under a different id.
      if (e.pointerId !== activePointerIdRef.current) return;
      finishStroke();
    };

    const handlePointerCancel = (e: PointerEvent): void => {
      if (e.pointerId !== activePointerIdRef.current) return;
      finishStroke();
    };

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerCancel);

    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerCancel);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      canvas.style.touchAction = previousTouchAction;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.scratchCanvasRef, opts.enabled]);
}
