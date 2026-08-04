// components/image/ImageEditorCanvas.tsx
//
// The image editor's drawing surface. Two stacked full-resolution canvases (natural image pixels,
// CSS-scaled to the current zoom% for on-screen display - same "offscreen full-res, CSS-scaled"
// split ImageOverlayCropPanel.tsx/PdfPage.tsx already use) plus a DOM interaction layer on top:
//
// - `canvasRef` always holds exactly renderComposedCanvas's output (base photo + adjustments +
//   every committed annotation object) and nothing else - this is the canvas getWorkingCanvas()
//   exposes to the parent for crop/rotate/flip snapshots and the final Save. Selection chrome is
//   never drawn onto it, so it's always safe to read back as-is.
// - `previewCanvasRef` is a transparent overlay cleared and redrawn each pointermove with only the
//   in-progress gesture (a freehand stroke being drawn, a shape's rubber-band drag) - discarded
//   once the gesture commits (the object then appears on the real canvas via the store round-trip).
// - Selection outline/resize handles/the crop rect are plain positioned DOM elements (mirrors
//   ImageAnnotationEditor.tsx/ImageOverlayCropPanel.tsx's own selection-chrome convention), not
//   canvas-drawn, so they never risk leaking into an exported frame.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  ImageAdjustments,
  ImageAnnotationObject,
  ImageEditDocument,
  ImageEditTool,
  Pt,
} from "../../utils/imageEditTypes";
import {
  Bounds,
  ResizeCorner,
  findObjectAt,
  getObjectBounds,
  makeArrowObject,
  makeBlurObject,
  makeEllipseObject,
  makeHighlightObject,
  makeRectObject,
  makeStrokeObject,
  makeTextObject,
  renderComposedCanvas,
  renderLiveStroke,
  resizeBoxObject,
  translateObject,
} from "../../handlers/imageEditHandlers";
import { getCachedImage, preloadImage } from "../../utils/imageObjectCache";
import ImageAnnotationEditor from "../pdf/ImageAnnotationEditor";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageEditorCanvasHandle {
  getWorkingCanvas: () => HTMLCanvasElement | null;
  getCropRect: () => CropRect | null;
}

interface ImageEditorCanvasProps {
  doc: ImageEditDocument;
  baseImageSrc: string;
  adjustments: ImageAdjustments;
  tool: ImageEditTool;
  color: string;
  strokeWidth: number;
  fontSize: number;
  zoom: number;
  selectedObjectId: string | null;
  onSelectObject: (id: string | null) => void;
  onAddObject: (object: ImageAnnotationObject) => void;
  onEditObject: (before: ImageAnnotationObject, after: ImageAnnotationObject) => void;
  onDeleteObject: (object: ImageAnnotationObject) => void;
}

const HANDLE_SIZE = 12; // CSS px, independent of zoom - matches ImageAnnotationEditor's HANDLE_SIZE feel
const HANDLE_HIT_PADDING = 6;

type DragState =
  | { kind: "freehand"; tool: "pen" | "highlighter"; points: Pt[] }
  | { kind: "shape"; tool: "arrow" | "rect" | "ellipse" | "blur"; startX: number; startY: number; curX: number; curY: number }
  | { kind: "move"; object: ImageAnnotationObject; startX: number; startY: number; curX: number; curY: number }
  | { kind: "resize"; object: ImageAnnotationObject; corner: ResizeCorner; curX: number; curY: number }
  | { kind: "arrow-endpoint"; object: ImageAnnotationObject; endpoint: "start" | "end"; curX: number; curY: number }
  | { kind: "crop"; startX: number; startY: number; curX: number; curY: number };

interface TextEditorState {
  mode: "create" | "edit";
  x: number;
  y: number;
  value: string;
  original?: Extract<ImageAnnotationObject, { type: "text" }>;
}

const ImageEditorCanvas = forwardRef<ImageEditorCanvasHandle, ImageEditorCanvasProps>(function ImageEditorCanvas(
  { doc, baseImageSrc, adjustments, tool, color, strokeWidth, fontSize, zoom, selectedObjectId, onSelectObject, onAddObject, onEditObject, onDeleteObject },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const baseImageElRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);

  const [liveObject, setLiveObject] = useState<ImageAnnotationObject | null>(null);
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);

  const { baseWidth, baseHeight, objects } = doc;

  // Resets whenever crop mode is (re-)entered, so switching tools away and back always starts
  // from "the whole image" rather than remembering a stale rect from a cancelled attempt.
  useEffect(() => {
    if (tool === "crop") setCropRect({ x: 0, y: 0, w: baseWidth, h: baseHeight });
    else setCropRect(null);
  }, [tool, baseWidth, baseHeight]);

  useEffect(() => {
    let cancelled = false;
    preloadImage(baseImageSrc).then(
      (img) => {
        if (cancelled) return;
        baseImageElRef.current = img;
        redraw();
      },
      (err) => console.error("Failed to decode image for editing:", err)
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseImageSrc]);

  // Placed (inserted) images embed their own src directly on the object (see PlacedImageObject's
  // doc comment) rather than going through baseImageSrc above - decodes any that aren't already in
  // the shared cache (a freshly-inserted one already is, by the time it's added; this mainly
  // covers reopening a document - undo/redo, or a fresh load - that already has some) and redraws
  // once each resolves.
  useEffect(() => {
    let cancelled = false;
    const missing = objects.filter((o): o is Extract<ImageAnnotationObject, { type: "placed-image" }> => o.type === "placed-image" && !getCachedImage(o.src));
    Promise.all(missing.map((o) => preloadImage(o.src))).then(
      () => {
        if (!cancelled && missing.length > 0) redraw();
      },
      (err) => console.error("Failed to decode placed image:", err)
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objects]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const displayObjects = liveObject ? objects.map((o) => (o.id === liveObject.id ? liveObject : o)) : objects;
    renderComposedCanvas(canvas, baseImageElRef.current, baseWidth, baseHeight, adjustments, displayObjects);
  }, [objects, baseWidth, baseHeight, adjustments, liveObject]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const clearPreview = (): void => {
    const canvas = previewCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  useImperativeHandle(
    ref,
    () => ({
      getWorkingCanvas: () => canvasRef.current,
      getCropRect: () => cropRect,
    }),
    [cropRect]
  );

  const toNaturalPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  };

  const selectedObject = selectedObjectId ? objects.find((o) => o.id === selectedObjectId) ?? null : null;

  const getHandles = (object: ImageAnnotationObject): { id: string; x: number; y: number; cursor: string }[] => {
    if (object.type === "arrow") {
      return [
        { id: "start", x: object.x1, y: object.y1, cursor: "move" },
        { id: "end", x: object.x2, y: object.y2, cursor: "move" },
      ];
    }
    const bounds = getObjectBounds(object);
    if (!bounds || object.type === "text") return [];
    const corners: { id: ResizeCorner; cursor: string }[] = [
      { id: "nw", cursor: "nwse-resize" },
      { id: "ne", cursor: "nesw-resize" },
      { id: "sw", cursor: "nesw-resize" },
      { id: "se", cursor: "nwse-resize" },
    ];
    return corners.map((c) => ({
      id: c.id,
      cursor: c.cursor,
      x: c.id.includes("w") ? bounds.x : bounds.x + bounds.w,
      y: c.id.includes("n") ? bounds.y : bounds.y + bounds.h,
    }));
  };

  const scheduleLiveRedraw = (compute: () => void): void => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      compute();
    });
  };

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const commitTextEditor = (): void => {
    const state = textEditor;
    setTextEditor(null);
    if (!state) return;
    const text = state.value.trim();
    if (!text) return;
    if (state.mode === "create") {
      onAddObject(makeTextObject(state.x, state.y, text, color, fontSize));
    } else if (state.original) {
      onEditObject(state.original, { ...state.original, text, updatedAt: Date.now() });
    }
  };

  const openTextEditorAt = (x: number, y: number): void => setTextEditor({ mode: "create", x, y, value: "" });

  const beginEditExistingText = (object: Extract<ImageAnnotationObject, { type: "text" }>): void => {
    setTextEditor({ mode: "edit", x: object.x, y: object.y, value: object.text, original: object });
  };

  const handlePointerDown = (e: React.PointerEvent): void => {
    if (textEditor) return; // let the inline input's own blur/Enter commit first
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const { x, y } = toNaturalPoint(e.clientX, e.clientY);

    if (tool === "crop") {
      dragRef.current = { kind: "crop", startX: x, startY: y, curX: x, curY: y };
      return;
    }

    if (tool === "text") {
      openTextEditorAt(x, y);
      return;
    }

    if (tool === "pen" || tool === "highlighter") {
      dragRef.current = { kind: "freehand", tool, points: [{ x, y, pressure: e.pressure || 0.5 }] };
      return;
    }

    if (tool === "arrow" || tool === "rect" || tool === "ellipse" || tool === "blur") {
      dragRef.current = { kind: "shape", tool, startX: x, startY: y, curX: x, curY: y };
      return;
    }

    // tool === "select"
    if (selectedObject) {
      const hitRadius = HANDLE_HIT_PADDING / zoom + HANDLE_SIZE / 2 / zoom;
      const handle = getHandles(selectedObject).find((h) => Math.hypot(h.x - x, h.y - y) <= hitRadius);
      if (handle) {
        dragRef.current =
          selectedObject.type === "arrow"
            ? { kind: "arrow-endpoint", object: selectedObject, endpoint: handle.id as "start" | "end", curX: x, curY: y }
            : { kind: "resize", object: selectedObject, corner: handle.id as ResizeCorner, curX: x, curY: y };
        return;
      }
    }

    const hit = findObjectAt(objects, x, y);
    if (hit) {
      onSelectObject(hit.id);
      dragRef.current = { kind: "move", object: hit, startX: x, startY: y, curX: x, curY: y };
    } else {
      onSelectObject(null);
    }
  };

  const handlePointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = toNaturalPoint(e.clientX, e.clientY);

    if (drag.kind === "freehand") {
      drag.points.push({ x, y, pressure: e.pressure || 0.5 });
      const canvas = previewCanvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        renderLiveStroke(ctx, drag.tool, drag.points, color, strokeWidth);
      }
      return;
    }

    if (drag.kind === "shape") {
      drag.curX = x;
      drag.curY = y;
      scheduleLiveRedraw(() => {
        const canvas = previewCanvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const nx = Math.min(drag.startX, drag.curX);
        const ny = Math.min(drag.startY, drag.curY);
        const nw = Math.abs(drag.curX - drag.startX);
        const nh = Math.abs(drag.curY - drag.startY);
        if (drag.tool === "arrow") {
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = strokeWidth;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(drag.startX, drag.startY);
          ctx.lineTo(drag.curX, drag.curY);
          ctx.stroke();
          ctx.restore();
        } else if (drag.tool === "blur") {
          ctx.save();
          ctx.strokeStyle = "rgba(255,255,255,0.9)";
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 2;
          ctx.strokeRect(nx, ny, nw, nh);
          ctx.restore();
        } else {
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = strokeWidth;
          if (drag.tool === "rect") ctx.strokeRect(nx, ny, nw, nh);
          else {
            ctx.beginPath();
            ctx.ellipse(nx + nw / 2, ny + nh / 2, nw / 2, nh / 2, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
      });
      return;
    }

    if (drag.kind === "crop") {
      drag.curX = x;
      drag.curY = y;
      scheduleLiveRedraw(() => {
        const nx = Math.max(0, Math.min(baseWidth, Math.min(drag.startX, drag.curX)));
        const ny = Math.max(0, Math.min(baseHeight, Math.min(drag.startY, drag.curY)));
        const fx = Math.max(0, Math.min(baseWidth, Math.max(drag.startX, drag.curX)));
        const fy = Math.max(0, Math.min(baseHeight, Math.max(drag.startY, drag.curY)));
        setCropRect({ x: nx, y: ny, w: Math.max(1, fx - nx), h: Math.max(1, fy - ny) });
      });
      return;
    }

    if (drag.kind === "move") {
      drag.curX = x;
      drag.curY = y;
      scheduleLiveRedraw(() => setLiveObject(translateObject(drag.object, drag.curX - drag.startX, drag.curY - drag.startY)));
      return;
    }

    if (drag.kind === "resize") {
      drag.curX = x;
      drag.curY = y;
      scheduleLiveRedraw(() => {
        const object = drag.object;
        if (object.type === "rect" || object.type === "ellipse" || object.type === "blur") {
          setLiveObject(resizeBoxObject(object, drag.corner, drag.curX, drag.curY));
        }
      });
      return;
    }

    if (drag.kind === "arrow-endpoint") {
      drag.curX = x;
      drag.curY = y;
      scheduleLiveRedraw(() => {
        const object = drag.object;
        if (object.type !== "arrow") return;
        setLiveObject(
          drag.endpoint === "start" ? { ...object, x1: drag.curX, y1: drag.curY } : { ...object, x2: drag.curX, y2: drag.curY }
        );
      });
      return;
    }
  };

  const handlePointerUp = (): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    clearPreview();
    if (!drag) return;

    if (drag.kind === "freehand") {
      if (drag.points.length > 1) {
        onAddObject(drag.tool === "pen" ? makeStrokeObject(drag.points, color, strokeWidth) : makeHighlightObject(drag.points, color, strokeWidth));
      }
      return;
    }

    if (drag.kind === "shape") {
      const nx = Math.min(drag.startX, drag.curX);
      const ny = Math.min(drag.startY, drag.curY);
      const nw = Math.abs(drag.curX - drag.startX);
      const nh = Math.abs(drag.curY - drag.startY);
      if (drag.tool === "arrow") {
        if (Math.hypot(drag.curX - drag.startX, drag.curY - drag.startY) > 2) {
          onAddObject(makeArrowObject(drag.startX, drag.startY, drag.curX, drag.curY, color, strokeWidth));
        }
      } else if (nw > 2 && nh > 2) {
        if (drag.tool === "rect") onAddObject(makeRectObject(nx, ny, nw, nh, color, strokeWidth));
        else if (drag.tool === "ellipse") onAddObject(makeEllipseObject(nx, ny, nw, nh, color, strokeWidth));
        else onAddObject(makeBlurObject(nx, ny, nw, nh));
      }
      return;
    }

    if (drag.kind === "move") {
      setLiveObject(null);
      if (drag.curX !== drag.startX || drag.curY !== drag.startY) {
        onEditObject(drag.object, translateObject(drag.object, drag.curX - drag.startX, drag.curY - drag.startY));
      }
      return;
    }

    if (drag.kind === "resize") {
      setLiveObject(null);
      const object = drag.object;
      if (object.type === "rect" || object.type === "ellipse" || object.type === "blur") {
        onEditObject(object, resizeBoxObject(object, drag.corner, drag.curX, drag.curY));
      }
      return;
    }

    if (drag.kind === "arrow-endpoint") {
      setLiveObject(null);
      const object = drag.object;
      if (object.type === "arrow") {
        onEditObject(object, drag.endpoint === "start" ? { ...object, x1: drag.curX, y1: drag.curY } : { ...object, x2: drag.curX, y2: drag.curY });
      }
      return;
    }
    // "crop" needs no per-gesture commit - cropRect state just stays as the drag left it, read
    // later by the parent via getCropRect() when the user clicks Apply.
  };

  const displaySize = { width: baseWidth * zoom, height: baseHeight * zoom };
  const selectionBounds: Bounds | null = selectedObject ? getObjectBounds(liveObject ?? selectedObject) : null;
  const cursorForTool: React.CSSProperties["cursor"] =
    tool === "select" ? "default" : tool === "crop" ? "crosshair" : tool === "text" ? "text" : "crosshair";

  return (
    <div ref={containerRef} className="relative" style={{ width: displaySize.width, height: displaySize.height }}>
      <canvas ref={canvasRef} width={baseWidth} height={baseHeight} style={{ width: "100%", height: "100%", position: "absolute", inset: 0 }} />
      <canvas
        ref={previewCanvasRef}
        width={baseWidth}
        height={baseHeight}
        style={{ width: "100%", height: "100%", position: "absolute", inset: 0, pointerEvents: "none" }}
      />

      <div
        className="absolute inset-0"
        style={{ cursor: cursorForTool }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={(e) => {
          if (tool !== "select") return;
          const { x, y } = toNaturalPoint(e.clientX, e.clientY);
          const hit = findObjectAt(objects, x, y);
          if (hit?.type === "text") beginEditExistingText(hit);
        }}
      >
        {selectionBounds && tool === "select" && (
          <div
            className="absolute border-2 border-dashed border-blue-400 pointer-events-none"
            style={{
              left: selectionBounds.x * zoom,
              top: selectionBounds.y * zoom,
              width: selectionBounds.w * zoom,
              height: selectionBounds.h * zoom,
            }}
          />
        )}

        {selectedObject &&
          tool === "select" &&
          getHandles(liveObject ?? selectedObject).map((h) => (
            <div
              key={h.id}
              onPointerDown={(e) => {
                e.stopPropagation();
                handlePointerDown(e);
              }}
              className="absolute rounded-full bg-white border-2 border-blue-500 shadow-sm"
              style={{
                left: h.x * zoom - HANDLE_SIZE / 2,
                top: h.y * zoom - HANDLE_SIZE / 2,
                width: HANDLE_SIZE,
                height: HANDLE_SIZE,
                cursor: h.cursor,
              }}
            />
          ))}

        {/* Placed (inserted) images get their own dedicated move/resize/rotate chrome - reused
            directly from the PDF annotator rather than this canvas's generic axis-aligned
            handles, since it already supports rotation-aware, center-anchored resize (see
            PlacedImageObject's own doc comment). `liveObject ?? selectedObject` (not just
            selectedObject) so this tracks correctly even if it mounts mid-gesture, during the
            very first click-and-drag that both selects a not-yet-selected placed image and moves
            it via this canvas's own generic "move" drag kind - every *subsequent* gesture is
            handled entirely inside ImageAnnotationEditor itself, which manages its own live drag
            feedback independent of this component's liveObject state. */}
        {selectedObject?.type === "placed-image" &&
          tool === "select" &&
          (() => {
            const display = liveObject?.type === "placed-image" ? liveObject : selectedObject;
            return (
              <ImageAnnotationEditor
                left={display.x * zoom}
                top={display.y * zoom}
                width={display.width * zoom}
                height={display.height * zoom}
                rotation={display.rotation}
                src={selectedObject.src}
                onMoveEnd={(newLeft, newTop) => onEditObject(selectedObject, { ...selectedObject, x: newLeft / zoom, y: newTop / zoom })}
                onResizeEnd={(newWidth, newHeight, newLeft, newTop) =>
                  onEditObject(selectedObject, { ...selectedObject, width: newWidth / zoom, height: newHeight / zoom, x: newLeft / zoom, y: newTop / zoom })
                }
                onRotateEnd={(newRotation) => onEditObject(selectedObject, { ...selectedObject, rotation: newRotation })}
                onDelete={() => onDeleteObject(selectedObject)}
              />
            );
          })()}

        {tool === "crop" && cropRect && (
          <>
            <div className="absolute bg-black/60 pointer-events-none" style={{ left: 0, top: 0, right: 0, height: cropRect.y * zoom }} />
            <div
              className="absolute bg-black/60 pointer-events-none"
              style={{ left: 0, top: (cropRect.y + cropRect.h) * zoom, right: 0, bottom: 0 }}
            />
            <div
              className="absolute bg-black/60 pointer-events-none"
              style={{ left: 0, top: cropRect.y * zoom, width: cropRect.x * zoom, height: cropRect.h * zoom }}
            />
            <div
              className="absolute bg-black/60 pointer-events-none"
              style={{ left: (cropRect.x + cropRect.w) * zoom, top: cropRect.y * zoom, right: 0, height: cropRect.h * zoom }}
            />
            <div
              className="absolute outline outline-2 outline-white pointer-events-none"
              style={{ left: cropRect.x * zoom, top: cropRect.y * zoom, width: cropRect.w * zoom, height: cropRect.h * zoom }}
            />
          </>
        )}
      </div>

      {textEditor && (
        <input
          type="text"
          autoFocus
          value={textEditor.value}
          onChange={(e) => setTextEditor((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setTextEditor(null);
            }
          }}
          onBlur={commitTextEditor}
          className="absolute bg-transparent outline-none ring-2 ring-blue-400 rounded px-0.5"
          style={{
            left: textEditor.x * zoom,
            top: textEditor.y * zoom,
            fontSize: fontSize * zoom,
            fontFamily: "system-ui, -apple-system, sans-serif",
            color,
            minWidth: 40,
          }}
        />
      )}
    </div>
  );
});

export default ImageEditorCanvas;
