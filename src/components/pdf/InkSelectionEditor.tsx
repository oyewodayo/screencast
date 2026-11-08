// components/pdf/InkSelectionEditor.tsx
import React, { useEffect, useMemo, useRef } from "react";
import type { PageViewport } from "pdfjs-dist";
import { HighlightObject, StrokeObject } from "../../utils/pdfAnnotationTypes";
import { pdfPointToDevicePoint, renderObject } from "../../handlers/pdfAnnotationHandlers";

const SELECTION_PADDING_PX = 8;
const MOVE_THRESHOLD_PX = 2; // below this a press is just a tap on the selection, not a move

interface InkSelectionEditorProps {
  object: StrokeObject | HighlightObject;
  viewport: PageViewport;
  // Device-px offset the selection was dragged by.
  onMoveEnd: (dx: number, dy: number) => void;
  onDelete: () => void;
}

// A selected pen stroke / highlight: a dashed box around it that drags to move it. The overlay
// canvas leaves the selected object out (PdfPage's redraw skips the selected id), so the stroke is
// drawn here instead, on a canvas sized to its own bounds - which is what lets the drag preview
// move the actual ink, via a plain CSS transform with no canvas redraws mid-drag (same "mutate
// style during pointermove, report once on release" pattern as ImageAnnotationEditor).
const InkSelectionEditor: React.FC<InkSelectionEditorProps> = ({ object, viewport, onMoveEnd, onDelete }) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const bounds = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of object.points) {
      const d = pdfPointToDevicePoint(viewport, p);
      minX = Math.min(minX, d.x);
      minY = Math.min(minY, d.y);
      maxX = Math.max(maxX, d.x);
      maxY = Math.max(maxY, d.y);
    }
    const pad = (object.width * viewport.scale) / 2 + SELECTION_PADDING_PX;
    return { left: minX - pad, top: minY - pad, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad };
  }, [object, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // The committed move has just landed in `bounds` - drop the drag preview's offset, or it would
    // be applied a second time on top of the new position.
    if (wrapperRef.current) wrapperRef.current.style.transform = "";
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(bounds.width * dpr));
    canvas.height = Math.max(1, Math.round(bounds.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(-bounds.left, -bounds.top);
    renderObject(ctx, object, viewport, viewport.scale);
  }, [object, viewport, bounds]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    let dx = 0;
    let dy = 0;

    const handleMove = (moveEvent: PointerEvent): void => {
      dx = moveEvent.clientX - startX;
      dy = moveEvent.clientY - startY;
      wrapper.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const finish = (endEvent: PointerEvent): void => {
      if (target.hasPointerCapture(endEvent.pointerId)) target.releasePointerCapture(endEvent.pointerId);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (Math.hypot(dx, dy) >= MOVE_THRESHOLD_PX) onMoveEnd(dx, dy);
      else wrapper.style.transform = "";
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  return (
    <div
      ref={wrapperRef}
      data-annotation-editor=""
      className="absolute"
      style={{ ...bounds, zIndex: 20, touchAction: "none" }}
    >
      <div
        onPointerDown={handlePointerDown}
        data-tip="Drag to move · Delete to remove"
        className="absolute inset-0 rounded-md outline-dashed outline-[1.5px] outline-blue-500 bg-blue-500/[0.04]"
        style={{ cursor: "move" }}
      >
        <canvas ref={canvasRef} className="block w-full h-full pointer-events-none" />
      </div>
      <button
        type="button"
        aria-label="Delete"
        data-tip="Delete"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onDelete}
        className="absolute -top-3 -right-3 w-6 h-6 flex items-center justify-center rounded-full bg-white border border-black/10 shadow-sm text-neutral-600 hover:text-red-600 hover:border-red-300 text-xs leading-none"
      >
        ×
      </button>
    </div>
  );
};

export default InkSelectionEditor;
