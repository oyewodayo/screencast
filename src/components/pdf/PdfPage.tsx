// components/pdf/PdfPage.tsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import { AnnotationObject, AnnotationTool, Pt, TextObject } from "../../utils/pdfAnnotationTypes";
import {
  clearCanvas,
  devicePointToPdfPoint,
  findTextObjectAt,
  makeTextObject,
  measureTextBlock,
  pdfPointToDevicePoint,
  renderObject,
  renderPageObjects,
  TextLine,
} from "../../handlers/pdfAnnotationHandlers";
import useStrokeCapture from "../../hooks/useStrokeCapture";
import { PageRenderCache } from "../../hooks/usePageRenderCache";
import TextNoteEditor from "./TextNoteEditor";

const TEXT_NOTE_DEFAULT_WIDTH_PDF = 160;
const DRAG_THRESHOLD_DEVICE_PX = 5; // below this, a pointerdown+up on a note is a tap (edit), not a drag (move)

interface PdfPageProps {
  pdfDoc: PDFDocumentProxy;
  pageIndex: number; // 0-based
  numPages: number;
  zoom: number;
  cache: PageRenderCache;
  objects: AnnotationObject[];
  tool: AnnotationTool | null;
  color: string;
  width: number;
  textFontSize: number;
  eraserRadius: number;
  interactive: boolean;
  onStrokeComplete: (object: AnnotationObject) => void;
  onObjectEdit: (before: AnnotationObject, after: AnnotationObject) => void;
  onObjectDelete: (object: AnnotationObject) => void;
  onEraseBegin: (pageIndex: number) => void;
  onEraseAt: (pageIndex: number, point: Pt, radiusInPdfUnits: number) => void;
  onEraseEnd: () => void;
}

// Local, not-yet-persisted state for the text note currently being typed/edited on this page.
// Nothing is written to the annotation store until the session resolves (commit or cancel) —
// see commitEditingText below.
interface EditingTextState {
  id: string;
  isNew: boolean;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  color: string;
  text: string;
}

// One page = three stacked, identically-sized canvases: the pdf.js render target (bottom),
// the committed ink overlay (middle, redrawn from `objects`), and a scratch canvas for the
// in-progress stroke (top, owned by useStrokeCapture). All three get the exact same
// DPR-aware sizing recipe so ink stays pixel-aligned with page content.
//
// This component does NOT remount per page (no `key` on it in PdfAnnotator) — the page/overlay/
// scratch canvases persist across navigation, and the actual bitmap comes from `cache` (a
// LRU-capped render cache shared for the whole document's lifetime) rather than a fresh
// `page.render()` every time. Flipping back to an already-visited page is a synchronous
// `drawImage` instead of a full re-rasterize.
const PdfPage: React.FC<PdfPageProps> = ({
  pdfDoc,
  pageIndex,
  numPages,
  zoom,
  cache,
  objects,
  tool,
  color,
  width,
  textFontSize,
  eraserRadius,
  interactive,
  onStrokeComplete,
  onObjectEdit,
  onObjectDelete,
  onEraseBegin,
  onEraseAt,
  onEraseEnd,
}) => {
  const pageCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement>(null);

  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [textLines, setTextLines] = useState<TextLine[] | null>(null);
  const [editingText, setEditingText] = useState<EditingTextState | null>(null);
  // Set for the duration of a note drag so the overlay redraw (below) can exclude it — the live,
  // cursor-following position is drawn on the scratch canvas instead, same "only redraw what's
  // actually moving" approach useStrokeCapture uses for in-progress strokes.
  const [draggingTextId, setDraggingTextId] = useState<string | null>(null);

  // Read by the click handler / commit logic below without needing to be effect dependencies —
  // both change far more often than "is the text-tool click listener even attached" should.
  const objectsRef = useRef(objects);
  const editingTextRef = useRef(editingText);
  useEffect(() => {
    objectsRef.current = objects;
  }, [objects]);
  useEffect(() => {
    editingTextRef.current = editingText;
  }, [editingText]);

  // The *live* typed content of whatever note is being edited. TextNoteEditor keeps keystrokes
  // out of React state entirely for performance (see its onChange), so this ref — updated via
  // onTextChange on every keystroke — is the only place that content exists until commit. Commit
  // must read from here, never from `editingText.text`/session.text, which is only ever the
  // value the session *started* with and is never updated as the user types.
  const liveTextRef = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    setViewport(null);
    setRenderError(null);

    cache
      .getPage(pdfDoc, pageIndex, zoom)
      .then(({ canvas: srcCanvas, viewport: vp, dpr }) => {
        if (cancelled) return;

        // The overlay/scratch canvases need CSS-pixel-space drawing (matching viewport units) for
        // ink math, so they get the usual scale(dpr, dpr) transform. The page canvas is just a
        // one-shot blit target for the cached bitmap and is sized identically but left at the
        // identity transform so drawImage below copies pixels 1:1, with no extra scaling.
        for (const canvas of [overlayCanvasRef.current, scratchCanvasRef.current]) {
          if (!canvas) continue;
          canvas.width = srcCanvas.width;
          canvas.height = srcCanvas.height;
          canvas.style.width = `${vp.width}px`;
          canvas.style.height = `${vp.height}px`;
          const ctx = canvas.getContext("2d");
          ctx?.setTransform(1, 0, 0, 1, 0, 0);
          ctx?.scale(dpr, dpr);
        }

        const pageCanvas = pageCanvasRef.current;
        if (pageCanvas) {
          pageCanvas.width = srcCanvas.width;
          pageCanvas.height = srcCanvas.height;
          pageCanvas.style.width = `${vp.width}px`;
          pageCanvas.style.height = `${vp.height}px`;
          const pageCtx = pageCanvas.getContext("2d");
          pageCtx?.setTransform(1, 0, 0, 1, 0, 0);
          pageCtx?.drawImage(srcCanvas, 0, 0);
        }

        setViewport(vp);
        cache.prefetchNeighbors(pdfDoc, pageIndex, zoom, numPages);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to render PDF page:", err);
        setRenderError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageIndex, zoom, numPages, cache]);

  // Text geometry for the highlighter's auto-height snapping. Deliberately a separate effect
  // keyed only on [pdfDoc, pageIndex] (not zoom) — text positions are already in zoom-independent
  // PDF page-space, so there's no need to re-extract them every time the user zooms. `cache`
  // itself already avoids re-extracting on revisits; this just wires the result into state.
  useEffect(() => {
    let cancelled = false;
    setTextLines(null);
    cache
      .getTextLines(pdfDoc, pageIndex)
      .then((lines) => {
        if (!cancelled) setTextLines(lines);
      })
      .catch((err) => {
        console.error("Failed to extract PDF text content:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageIndex, cache]);

  // Redraw the committed ink overlay whenever the page's stored objects or viewport change
  // (e.g. after a stroke, an undo/redo, an erase, or a text note being added/edited/moved).
  // The object currently being dragged is excluded — its live position is drawn on the scratch
  // canvas instead, so it doesn't appear twice (once frozen at its old spot, once following
  // the cursor) while a drag is in progress.
  useEffect(() => {
    if (!viewport) return;
    const canvas = overlayCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;
    clearCanvas(ctx, canvas);
    const visibleObjects = draggingTextId ? objects.filter((o) => o.id !== draggingTextId) : objects;
    renderPageObjects(ctx, visibleObjects, viewport, viewport.scale);
  }, [viewport, objects, draggingTextId]);

  // Resolves whatever text session is currently open: commits it to the store (add / edit /
  // delete-if-cleared-to-empty) or discards it if nothing meaningful changed. Nothing is written
  // to the store while typing — only here, once the session actually ends. Position/font-size
  // (from the move/resize handles) are staged in `editingText` state the same way text is staged
  // in liveTextRef, and only land in the store here too — so a drag mid-creation, before the note
  // even exists yet, works for free instead of needing its own persistence path.
  const commitEditingText = useCallback((): void => {
    const session = editingTextRef.current;
    if (!session) return;
    // Synchronous guard, not just the setEditingText(null) below: two effects (tool-change and
    // page-change cleanup) can both call this in the same tick, before a re-render has had a
    // chance to flow the null back into editingTextRef via its own sync effect. Without this,
    // the second call would still see the "old" session and commit it a second time.
    editingTextRef.current = null;
    setEditingText(null);

    const text = liveTextRef.current;
    const isEmpty = text.trim().length === 0;

    if (session.isNew) {
      if (isEmpty) return; // never existed — nothing to do
      const { height } = measureTextBlock(text, session.fontSize, session.width);
      const object = makeTextObject(pageIndex, session.x, session.y, text, session.color, session.fontSize, session.width, height);
      onStrokeComplete(object);
      return;
    }

    const original = objectsRef.current.find((o): o is TextObject => o.type === "text" && o.id === session.id);
    if (!original) return;

    if (isEmpty) {
      onObjectDelete(original);
      return;
    }

    const moved = session.x !== original.x || session.y !== original.y;
    const resized = session.fontSize !== original.fontSize || session.width !== original.width;
    if (text !== original.text || moved || resized) {
      const { height } = measureTextBlock(text, session.fontSize, session.width);
      onObjectEdit(original, {
        ...original,
        text,
        x: session.x,
        y: session.y,
        fontSize: session.fontSize,
        width: session.width,
        height,
        updatedAt: Date.now(),
      });
    }
  }, [pageIndex, onStrokeComplete, onObjectEdit, onObjectDelete]);

  const cancelEditingText = useCallback((): void => {
    setEditingText(null); // nothing was ever written to the store, so cancelling is just this
  }, []);

  const handleNoteTextChange = useCallback((text: string): void => {
    liveTextRef.current = text;
  }, []);

  // Live position/size updates from the editor's drag/resize handles land in `editingText` state
  // (not the store) — see the commitEditingText doc comment above for why.
  const handleNoteMoveEnd = useCallback(
    (newLeftDevicePx: number, newTopDevicePx: number): void => {
      if (!viewport) return;
      const pdfPoint = devicePointToPdfPoint(viewport, newLeftDevicePx, newTopDevicePx, 1);
      setEditingText((prev) => (prev ? { ...prev, x: pdfPoint.x, y: pdfPoint.y } : prev));
    },
    [viewport]
  );

  const handleNoteResizeEnd = useCallback(
    (newFontSizeDevicePx: number): void => {
      if (!viewport) return;
      setEditingText((prev) => (prev ? { ...prev, fontSize: newFontSizeDevicePx / viewport.scale } : prev));
    },
    [viewport]
  );

  const handleNoteWidthResizeEnd = useCallback(
    (newWidthDevicePx: number): void => {
      if (!viewport) return;
      setEditingText((prev) => (prev ? { ...prev, width: newWidthDevicePx / viewport.scale } : prev));
    },
    [viewport]
  );

  // Text tool: tap an existing note to edit it, tap empty space to place a new one, or press
  // and drag an existing note to move it. All three share one pointer-based state machine
  // (rather than the native `click` event) because dragging needs an explicit, measured
  // tap-vs-drag threshold — relying on the browser's own click-suppression heuristic wouldn't
  // give us the in-progress drag position needed for the live preview below.
  useEffect(() => {
    const canvas = scratchCanvasRef.current;
    if (!canvas || tool !== "text" || !interactive || !viewport) return;

    let phase: "idle" | "pending" | "dragging" = "idle";
    let pointerId: number | null = null;
    let hitObject: TextObject | null = null; // the note under the initial pointerdown, if any
    let grabOffset = { dx: 0, dy: 0 }; // pointerdown position minus the note's x,y, in PDF space
    let startClientPoint = { x: 0, y: 0 };
    let lastPdfPoint: Pt = { x: 0, y: 0, pressure: 1 };
    let rafId: number | null = null;

    const localToPdf = (e: PointerEvent): Pt => {
      const rect = canvas.getBoundingClientRect();
      return devicePointToPdfPoint(viewport, e.clientX - rect.left, e.clientY - rect.top, 1);
    };

    const drawDragPreview = (): void => {
      rafId = null;
      const ctx = canvas.getContext("2d");
      if (!ctx || !hitObject) return;
      clearCanvas(ctx, canvas);
      const preview: TextObject = { ...hitObject, x: lastPdfPoint.x - grabOffset.dx, y: lastPdfPoint.y - grabOffset.dy };
      renderObject(ctx, preview, viewport, viewport.scale);
    };

    const scheduleDragRedraw = (): void => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(drawDragPreview);
    };

    // A tap that didn't turn into a drag: open the note that was under the pointer, or start a
    // new one if there wasn't one. (Any previously-open session was already resolved back in
    // handlePointerDown, before tap-vs-drag was even decided.)
    const openEditorAt = (pdfPoint: Pt, existing: TextObject | null): void => {
      if (existing) {
        liveTextRef.current = existing.text;
        setEditingText({
          id: existing.id,
          isNew: false,
          x: existing.x,
          y: existing.y,
          width: existing.width,
          fontSize: existing.fontSize,
          color: existing.color,
          text: existing.text,
        });
      } else {
        liveTextRef.current = "";
        setEditingText({
          id: crypto.randomUUID(),
          isNew: true,
          x: pdfPoint.x,
          y: pdfPoint.y,
          width: TEXT_NOTE_DEFAULT_WIDTH_PDF,
          fontSize: textFontSize,
          color,
          text: "",
        });
      }
    };

    const handlePointerDown = (e: PointerEvent): void => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // Deliberately no preventDefault() here — this used to call it unconditionally, which (for
      // mouse input) can suppress the browser's default "blur the currently focused element"
      // behavior, meaning a currently-open note's textarea wouldn't blur when clicking elsewhere
      // to place/select another note. Not needed anyway: it's only useful once a drag is
      // confirmed (see handlePointerMove), to stop incidental text selection during the drag.
      //
      // Resolve any note already open for editing before starting a new tap/drag on a
      // *different* note — otherwise dragging note B while note A is still mid-edit would
      // leave A's editor open and untouched through the whole gesture.
      commitEditingText();
      const pdfPoint = localToPdf(e);
      hitObject = findTextObjectAt(objectsRef.current, pdfPoint);
      grabOffset = hitObject ? { dx: pdfPoint.x - hitObject.x, dy: pdfPoint.y - hitObject.y } : { dx: 0, dy: 0 };
      lastPdfPoint = pdfPoint;
      startClientPoint = { x: e.clientX, y: e.clientY };
      phase = "pending";
      pointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: PointerEvent): void => {
      if (phase === "idle" || e.pointerId !== pointerId) return;
      lastPdfPoint = localToPdf(e);

      if (phase === "pending") {
        const movedPx = Math.hypot(e.clientX - startClientPoint.x, e.clientY - startClientPoint.y);
        if (movedPx < DRAG_THRESHOLD_DEVICE_PX) return;
        if (!hitObject) return; // dragging empty space isn't a thing here — stay pending, then no-op on release
        phase = "dragging";
        e.preventDefault(); // now that it's a confirmed drag, stop incidental text selection etc.
        setDraggingTextId(hitObject.id);
      }

      scheduleDragRedraw();
    };

    const finishGesture = (): void => {
      if (pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }

      if (phase === "dragging" && hitObject) {
        const ctx = canvas.getContext("2d");
        if (ctx) clearCanvas(ctx, canvas);
        const moved: TextObject = {
          ...hitObject,
          x: lastPdfPoint.x - grabOffset.dx,
          y: lastPdfPoint.y - grabOffset.dy,
          updatedAt: Date.now(),
        };
        onObjectEdit(hitObject, moved);
        setDraggingTextId(null);
      } else if (phase === "pending") {
        openEditorAt(lastPdfPoint, hitObject);
      }

      phase = "idle";
      hitObject = null;
      pointerId = null;
    };

    // A cancelled gesture (e.g. the OS interrupts it) aborts rather than commits — just clear
    // whatever the live preview drew, don't touch the store.
    const abortGesture = (): void => {
      if (pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      const ctx = canvas.getContext("2d");
      if (ctx) clearCanvas(ctx, canvas);
      setDraggingTextId(null);
      phase = "idle";
      hitObject = null;
      pointerId = null;
    };

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", finishGesture);
    canvas.addEventListener("pointercancel", abortGesture);
    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", finishGesture);
      canvas.removeEventListener("pointercancel", abortGesture);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [tool, interactive, viewport, pageIndex, color, textFontSize, commitEditingText, onObjectEdit]);

  // Leaving the text tool (or the page) with a session still open commits it rather than
  // silently dropping whatever was typed.
  useEffect(() => {
    if (tool !== "text") commitEditingText();
  }, [tool, commitEditingText]);
  useEffect(() => {
    return () => commitEditingText();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex]);

  useStrokeCapture({
    scratchCanvasRef,
    enabled: interactive && viewport !== null && tool !== null && tool !== "text",
    tool,
    color,
    width,
    eraserRadius,
    pageIndex,
    viewport,
    textLines,
    onStrokeComplete,
    onEraseBegin,
    onEraseAt,
    onEraseEnd,
  });

  const editorPosition = editingText && viewport ? pdfPointToDevicePoint(viewport, { x: editingText.x, y: editingText.y, pressure: 1 }) : null;

  return (
    <div className="relative inline-block bg-white shadow-[0_12px_40px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.06]">
      <canvas ref={pageCanvasRef} className="block" style={{ position: "relative" }} />
      <canvas ref={overlayCanvasRef} className="absolute top-0 left-0 pointer-events-none" />
      <canvas
        ref={scratchCanvasRef}
        className="absolute top-0 left-0"
        style={{ cursor: tool === "eraser" ? "cell" : tool === "text" ? "text" : tool ? "crosshair" : "default" }}
      />
      {editingText && editorPosition && viewport && (
        <TextNoteEditor
          key={editingText.id}
          left={editorPosition.x}
          top={editorPosition.y}
          width={editingText.width * viewport.scale}
          fontSize={editingText.fontSize * viewport.scale}
          color={editingText.color}
          initialText={editingText.text}
          onTextChange={handleNoteTextChange}
          onCommit={commitEditingText}
          onCancel={cancelEditingText}
          onMoveEnd={handleNoteMoveEnd}
          onResizeEnd={handleNoteResizeEnd}
          onResizeWidthEnd={handleNoteWidthResizeEnd}
        />
      )}
      {renderError && (
        <div className="absolute inset-0 flex items-center justify-center bg-white text-red-600 text-sm p-4">
          Failed to render page: {renderError}
        </div>
      )}
    </div>
  );
};

export default PdfPage;
