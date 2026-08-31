// components/board/BoardCanvas.tsx
//
// The Board feature's interactive <canvas>: renders the composed layout (via
// boardHandlers.ts's renderBoardToCanvas) and handles pointer-driven select/move/resize/rotate.
// The canvas's own pixel buffer always stays at doc.canvasWidth/canvasHeight (renderBoardToCanvas
// draws at scale 1) so it's crisp at any zoom - only its CSS size is scaled by the `zoom` prop
// (BoardEditor owns that state, including fit-to-window). All the pointer/hit-test math below
// works in canvas-buffer space throughout; only pointerToCanvasSpace's canvas.width/rect.width
// ratio needs to know a CSS/buffer size mismatch can exist.
//
// Live drag/resize/rotate updates are staged locally (liveImages) and only committed to the store
// as a single edit/batch-edit on pointer release - a "stage locally, commit once" discipline that
// keeps a whole drag gesture to exactly one undo step.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { BoardDocument, BoardItem } from "../../utils/boardTypes";
import {
  ResizeCorner,
  applyMove,
  applyResize,
  applyRotate,
  hitTestBoardItem,
  paddedCanvasSize,
  renderBoardToCanvas,
  resizeHandlePoints,
  rotateHandlePoint,
} from "../../handlers/boardHandlers";

const HANDLE_HIT_RADIUS = 10;
const HANDLE_DRAW_RADIUS = 5;

type DragMode = "move" | "resize" | "rotate";

interface DragState {
  mode: DragMode;
  ids: Set<string>;
  corner?: ResizeCorner;
  startX: number;
  startY: number;
  startImages: BoardItem[]; // full doc.images snapshot at drag start
}

interface BoardCanvasProps {
  doc: BoardDocument;
  // CSS-only display scale - the canvas's own pixel buffer always stays at doc.canvasWidth/Height
  // (renderBoardToCanvas keeps drawing at scale 1 into it) for crisp rendering; only style width/
  // height shrink or grow to fit the viewport. pointerToCanvasSpace's canvas.width/rect.width ratio
  // already generically handles the CSS/buffer size mismatch this introduces, so no other pointer
  // math below needs to know zoom exists.
  zoom: number;
  imageBitmaps: Map<string, HTMLImageElement>;
  selectedIds: Set<string>;
  onSelect: (ids: Set<string>) => void;
  onEditImage: (before: BoardItem, after: BoardItem) => void;
  onBatchEditImages: (before: BoardItem[], after: BoardItem[]) => void;
}

const BoardCanvas: React.FC<BoardCanvasProps> = ({ doc, zoom, imageBitmaps, selectedIds, onSelect, onEditImage, onBatchEditImages }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [liveImages, setLiveImages] = useState<BoardItem[] | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const displayImages = liveImages ?? doc.images;

  const draw = useCallback((): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height, padding } = paddedCanvasSize(doc);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    renderBoardToCanvas(canvas, { ...doc, images: displayImages }, imageBitmaps, 1);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Selection chrome is drawn in the same unpadded document space item.x/y already are
    // (matching hitTestBoardItem/applyMove etc.) - offset by the same padding
    // renderBoardToCanvas insets its own image drawing by, so the outline/handles land exactly on
    // top of the images they belong to regardless of the board's current padding.
    ctx.save();
    ctx.translate(padding, padding);
    for (const image of displayImages) {
      if (!selectedIds.has(image.id)) continue;
      drawSelectionChrome(ctx, image, selectedIds.size === 1);
    }
    ctx.restore();
  }, [doc, displayImages, imageBitmaps, selectedIds]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Converts a pointer event into the board's own unpadded document space - the same space
  // item.x/y, hitTestBoardItem, applyMove/Resize/Rotate, and resizeHandlePoints all work in.
  // canvas.width/rect.width first undoes any zoom (CSS size vs. buffer size), then padding is
  // subtracted back out since the buffer itself is padding pixels bigger than the document on
  // every side (see paddedCanvasSize).
  const pointerToCanvasSpace = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const { padding } = paddedCanvasSize(doc);
    return { x: (e.clientX - rect.left) * scaleX - padding, y: (e.clientY - rect.top) * scaleY - padding };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const { x, y } = pointerToCanvasSpace(e);

    if (selectedIds.size === 1) {
      const image = doc.images.find((img) => selectedIds.has(img.id));
      if (image) {
        const handles = resizeHandlePoints(image);
        for (const corner of Object.keys(handles) as ResizeCorner[]) {
          if (Math.hypot(x - handles[corner].x, y - handles[corner].y) <= HANDLE_HIT_RADIUS) {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { mode: "resize", ids: selectedIds, corner, startX: x, startY: y, startImages: doc.images };
            return;
          }
        }
        const rotateHandle = rotateHandlePoint(image);
        if (Math.hypot(x - rotateHandle.x, y - rotateHandle.y) <= HANDLE_HIT_RADIUS) {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { mode: "rotate", ids: selectedIds, startX: x, startY: y, startImages: doc.images };
          return;
        }
      }
    }

    const hit = hitTestBoardItem(doc.images, x, y);
    if (!hit) {
      if (!e.shiftKey) onSelect(new Set());
      return;
    }

    let nextSelection: Set<string>;
    if (e.shiftKey) {
      nextSelection = new Set(selectedIds);
      if (nextSelection.has(hit.id)) nextSelection.delete(hit.id);
      else nextSelection.add(hit.id);
    } else {
      nextSelection = selectedIds.has(hit.id) ? selectedIds : new Set([hit.id]);
    }
    onSelect(nextSelection);

    if (nextSelection.has(hit.id)) {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { mode: "move", ids: nextSelection, startX: x, startY: y, startImages: doc.images };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = pointerToCanvasSpace(e);
    const dx = x - drag.startX;
    const dy = y - drag.startY;

    setLiveImages(
      drag.startImages.map((image) => {
        if (!drag.ids.has(image.id)) return image;
        if (drag.mode === "move") return applyMove(image, dx, dy);
        if (drag.mode === "resize" && drag.corner) return applyResize(image, drag.corner, x, y);
        if (drag.mode === "rotate") return applyRotate(image, x, y);
        return image;
      })
    );
  };

  const endDrag = (): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !liveImages) {
      setLiveImages(null);
      return;
    }

    const beforeById = new Map(drag.startImages.map((img) => [img.id, img]));
    const afterById = new Map(liveImages.map((img) => [img.id, img]));
    const before = [...drag.ids].map((id) => beforeById.get(id)).filter((img): img is BoardItem => !!img);
    const after = [...drag.ids].map((id) => afterById.get(id)).filter((img): img is BoardItem => !!img);

    setLiveImages(null);
    if (before.length === 0 || after.length === 0) return;
    const changed = before.some((img, i) => JSON.stringify(img) !== JSON.stringify(after[i]));
    if (!changed) return;
    if (before.length === 1) onEditImage(before[0], after[0]);
    else onBatchEditImages(before, after);
  };

  const { width: bufferWidth, height: bufferHeight } = paddedCanvasSize(doc);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: bufferWidth * zoom,
        height: bufferHeight * zoom,
        // Always-on checkerboard sitting behind the canvas's own pixels - invisible wherever the
        // board has an opaque background (a color, a grid with a base fill, or a chosen image), but
        // shows through cleanly wherever that background is transparent - color mode's
        // backgroundColor null, grid mode's baseColor null, or image mode with nothing chosen yet -
        // or an image's own opacity is under 100%, the same "see-through" convention every other
        // image editor uses. See boardHandlers.ts's renderBoardToCanvas for which of the three
        // background modes is actually responsible for what gets drawn into the pixels this sits
        // behind.
        backgroundImage:
          "repeating-conic-gradient(#0000000f 0% 25%, transparent 0% 50%), repeating-conic-gradient(#0000000f 0% 25%, transparent 0% 50%)",
        backgroundSize: "20px 20px",
        backgroundPosition: "0 0, 10px 10px",
      }}
      className="shrink-0 rounded-sm shadow-lg cursor-default touch-none bg-white dark:bg-neutral-700"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
};

function drawSelectionChrome(ctx: CanvasRenderingContext2D, image: BoardItem, showHandles: boolean): void {
  ctx.save();
  const cx = image.x + image.width / 2;
  const cy = image.y + image.height / 2;
  ctx.translate(cx, cy);
  ctx.rotate(image.rotation);
  ctx.translate(-cx, -cy);

  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(image.x, image.y, image.width, image.height);

  if (showHandles) {
    ctx.fillStyle = "#3b82f6";
    for (const [hx, hy] of [
      [image.x, image.y],
      [image.x + image.width, image.y],
      [image.x, image.y + image.height],
      [image.x + image.width, image.y + image.height],
    ]) {
      ctx.beginPath();
      ctx.arc(hx, hy, HANDLE_DRAW_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(cx, image.y);
    ctx.lineTo(cx, image.y - 28);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, image.y - 28, HANDLE_DRAW_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

export default BoardCanvas;
