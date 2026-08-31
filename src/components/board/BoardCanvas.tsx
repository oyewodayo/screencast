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
import { createPortal } from "react-dom";
import { IoSwapHorizontalOutline, IoTrashOutline } from "react-icons/io5";
import { TbStackBack, TbStackFront } from "react-icons/tb";
import { BoardDocument, BoardImage, BoardItem } from "../../utils/boardTypes";
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

// All three below are CSS-pixel sizes, not canvas-buffer ones - the buffer stays at
// doc.canvasWidth/canvasHeight regardless of zoom (see this file's own top comment), so a fixed
// buffer-space radius would shrink to almost nothing on screen at a low zoom (a corner handle that
// reads fine at 100% all but disappears at the 27% this got reported at) and balloon at a high one.
// Every use of these below divides by `zoom` to convert back into buffer space, so the actual
// on-screen size - both what's drawn and what's clickable - stays constant no matter the zoom
// level. Bumped from the previous 10/5px buffer-space values (which were already the effective
// on-screen size at 100% zoom) to comfortably-sized targets in their own right, not just
// zoom-corrected versions of numbers that were already on the small side.
const HANDLE_HIT_RADIUS = 14;
const HANDLE_DRAW_RADIUS = 7;
const ROTATE_HANDLE_OFFSET = 32;

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
  // Right-click menu on a single item tile (see the contextMenu state below) - "Replace image"
  // only ever offered for an image (text has no source photo to swap); the rest apply to either
  // kind. All four are the exact same actions BoardStylePanel's own buttons already call; this is
  // just a faster, no-side-panel-required path to them, and also what stops WebView2's native
  // "Save image as / Copy image / Inspect" context menu from appearing over board tiles at all.
  onReplaceImage: (image: BoardImage) => void;
  onBringToFront: (ids: Set<string>) => void;
  onSendToBack: (ids: Set<string>) => void;
  onDeleteItem: (item: BoardItem) => void;
}

const BoardCanvas: React.FC<BoardCanvasProps> = ({
  doc,
  zoom,
  imageBitmaps,
  selectedIds,
  onSelect,
  onEditImage,
  onBatchEditImages,
  onReplaceImage,
  onBringToFront,
  onSendToBack,
  onDeleteItem,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [liveImages, setLiveImages] = useState<BoardItem[] | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [contextMenu, setContextMenu] = useState<{ item: BoardItem; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [contextMenu]);

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
      drawSelectionChrome(ctx, image, selectedIds.size === 1, zoom);
    }
    ctx.restore();
  }, [doc, displayImages, imageBitmaps, selectedIds, zoom]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Converts a client-space (clientX/clientY) point into the board's own unpadded document space -
  // the same space item.x/y, hitTestBoardItem, applyMove/Resize/Rotate, and resizeHandlePoints all
  // work in. canvas.width/rect.width first undoes any zoom (CSS size vs. buffer size), then padding
  // is subtracted back out since the buffer itself is padding pixels bigger than the document on
  // every side (see paddedCanvasSize). Takes plain coordinates rather than a specific event type so
  // both the pointer handlers below AND handleContextMenu (a MouseEvent, not a PointerEvent) can
  // share it.
  const clientToCanvasSpace = (clientX: number, clientY: number): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const { padding } = paddedCanvasSize(doc);
    return { x: (clientX - rect.left) * scaleX - padding, y: (clientY - rect.top) * scaleY - padding };
  };
  const pointerToCanvasSpace = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => clientToCanvasSpace(e.clientX, e.clientY);

  // Right-click on a tile selects it (single-select, replacing whatever else was selected - a
  // context menu acting on a multi-selection would be ambiguous about which item's photo "Replace"
  // even means) and opens the custom menu instead of WebView2's native one (see onReplaceImage/
  // onDeleteItem props' own doc comment). Right-clicking empty canvas space just suppresses the
  // native menu with nothing to replace it - there's no board-level action to offer there today.
  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    e.preventDefault();
    const { x, y } = clientToCanvasSpace(e.clientX, e.clientY);
    const hit = hitTestBoardItem(doc.images, x, y);
    if (!hit) {
      setContextMenu(null);
      return;
    }
    onSelect(new Set([hit.id]));
    setContextMenu({ item: hit, x: e.clientX, y: e.clientY });
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const { x, y } = pointerToCanvasSpace(e);

    if (selectedIds.size === 1) {
      const image = doc.images.find((img) => selectedIds.has(img.id));
      if (image) {
        // /zoom converts the CSS-pixel constants above back into buffer space - see their own doc
        // comment. Matches exactly what drawSelectionChrome renders below, so the clickable area
        // always lines up with what's actually drawn on screen.
        const hitRadius = HANDLE_HIT_RADIUS / zoom;
        const handles = resizeHandlePoints(image);
        for (const corner of Object.keys(handles) as ResizeCorner[]) {
          if (Math.hypot(x - handles[corner].x, y - handles[corner].y) <= hitRadius) {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { mode: "resize", ids: selectedIds, corner, startX: x, startY: y, startImages: doc.images };
            return;
          }
        }
        const rotateHandle = rotateHandlePoint(image, ROTATE_HANDLE_OFFSET / zoom);
        if (Math.hypot(x - rotateHandle.x, y - rotateHandle.y) <= hitRadius) {
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
    <>
      <canvas
        ref={canvasRef}
        style={{
          width: bufferWidth * zoom,
          height: bufferHeight * zoom,
          // Always-on checkerboard sitting behind the canvas's own pixels - invisible wherever the
          // board has an opaque background (a color, a grid with a base fill, or a chosen image),
          // but shows through cleanly wherever that background is transparent - color mode's
          // backgroundColor null, grid mode's baseColor null, or image mode with nothing chosen
          // yet - or an image's own opacity is under 100%, the same "see-through" convention every
          // other image editor uses. See boardHandlers.ts's renderBoardToCanvas for which of the
          // three background modes is actually responsible for what gets drawn into the pixels
          // this sits behind.
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
        onContextMenu={handleContextMenu}
      />

      {contextMenu &&
        createPortal(
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: "fixed", top: contextMenu.y, left: contextMenu.x }}
            className="w-44 py-1 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-md border border-neutral-200/80 dark:border-neutral-700/80 shadow-xl ring-1 ring-black/5 z-[9999]"
          >
            {contextMenu.item.kind === "image" && (
              <button
                type="button"
                onClick={() => {
                  onReplaceImage(contextMenu.item as BoardImage);
                  setContextMenu(null);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/70 transition-colors"
              >
                <IoSwapHorizontalOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                Replace image
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onBringToFront(new Set([contextMenu.item.id]));
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/70 transition-colors"
            >
              <TbStackFront size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
              Bring to front
            </button>
            <button
              type="button"
              onClick={() => {
                onSendToBack(new Set([contextMenu.item.id]));
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/70 transition-colors"
            >
              <TbStackBack size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
              Send to back
            </button>
            <div className="my-1 border-t border-neutral-100 dark:border-neutral-700/70" />
            <button
              type="button"
              onClick={() => {
                onDeleteItem(contextMenu.item);
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
            >
              <IoTrashOutline size={15} className="shrink-0" />
              Delete {contextMenu.item.kind === "text" ? "text" : "image"}
            </button>
          </div>,
          document.body
        )}
    </>
  );
};


function drawSelectionChrome(ctx: CanvasRenderingContext2D, image: BoardItem, showHandles: boolean, zoom: number): void {
  ctx.save();
  const cx = image.x + image.width / 2;
  const cy = image.y + image.height / 2;
  ctx.translate(cx, cy);
  ctx.rotate(image.rotation);
  ctx.translate(-cx, -cy);

  // Every size/offset below divides by `zoom` to convert this file's CSS-pixel constants
  // (HANDLE_DRAW_RADIUS/ROTATE_HANDLE_OFFSET) back into buffer space, so the selection outline and
  // handles hold a constant on-screen size at any zoom level - see those constants' own doc
  // comment, and handlePointerDown's hitRadius which this must stay in visual sync with.
  const lineWidth = 2 / zoom;
  const handleRadius = HANDLE_DRAW_RADIUS / zoom;
  const rotateOffset = ROTATE_HANDLE_OFFSET / zoom;

  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([]);
  ctx.strokeRect(image.x, image.y, image.width, image.height);

  if (showHandles) {
    const drawHandle = (hx: number, hy: number): void => {
      ctx.beginPath();
      ctx.arc(hx, hy, handleRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#3b82f6";
      ctx.fill();
      // A white ring around each dot - without it a blue handle sitting on top of a blue-ish or
      // dark photo can all but disappear; the ring keeps it visible against any photo underneath.
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    };

    for (const [hx, hy] of [
      [image.x, image.y],
      [image.x + image.width, image.y],
      [image.x, image.y + image.height],
      [image.x + image.width, image.y + image.height],
    ]) {
      drawHandle(hx, hy);
    }

    ctx.beginPath();
    ctx.moveTo(cx, image.y);
    ctx.lineTo(cx, image.y - rotateOffset);
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    drawHandle(cx, image.y - rotateOffset);
  }

  ctx.restore();
}

export default BoardCanvas;
