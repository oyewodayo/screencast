// utils/boxResize.ts
//
// Eight-handle resizing for overlay boxes (pictures, shapes, blur regions): drag a corner or an
// edge and the OPPOSITE side stays exactly where it was - also on a rotated box, where the drag is
// read along the box's own axes rather than the screen's. Corners can keep the box's proportions;
// edges always stretch just their own side.

export type ResizeHandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface ResizeHandle {
  id: ResizeHandleId;
  // Which side the handle moves: -1 = left/top, 1 = right/bottom, 0 = neither.
  sx: -1 | 0 | 1;
  sy: -1 | 0 | 1;
  // CSS cursor for an unrotated box.
  cursor: string;
}

export const RESIZE_HANDLES: ResizeHandle[] = [
  { id: "nw", sx: -1, sy: -1, cursor: "nwse-resize" },
  { id: "n", sx: 0, sy: -1, cursor: "ns-resize" },
  { id: "ne", sx: 1, sy: -1, cursor: "nesw-resize" },
  { id: "e", sx: 1, sy: 0, cursor: "ew-resize" },
  { id: "se", sx: 1, sy: 1, cursor: "nwse-resize" },
  { id: "s", sx: 0, sy: 1, cursor: "ns-resize" },
  { id: "sw", sx: -1, sy: 1, cursor: "nesw-resize" },
  { id: "w", sx: -1, sy: 0, cursor: "ew-resize" },
];

export const isCornerHandle = (h: ResizeHandle) => h.sx !== 0 && h.sy !== 0;

export interface PxBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The box after dragging `handle` by (dx, dy) screen pixels. `box` is the unrotated box (top-left
// + size, as overlays store it) that `rotationDeg` spins about its centre.
export function resizeBoxFromHandle(box: PxBox, rotationDeg: number, handle: Pick<ResizeHandle, "sx" | "sy">, dx: number, dy: number, keepAspect: boolean, minPx = 12): PxBox {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // The drag in the box's own (rotated) axes.
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;

  let width = handle.sx !== 0 ? box.width + handle.sx * lx : box.width;
  let height = handle.sy !== 0 ? box.height + handle.sy * ly : box.height;

  if (keepAspect && handle.sx !== 0 && handle.sy !== 0 && box.width > 0 && box.height > 0) {
    // Follow whichever side the pointer is pulling hardest.
    const scale = Math.abs(width / box.width - 1) >= Math.abs(height / box.height - 1) ? width / box.width : height / box.height;
    const min = Math.max(minPx / box.width, minPx / box.height);
    const s = Math.max(min, scale);
    width = box.width * s;
    height = box.height * s;
  } else {
    width = Math.max(minPx, width);
    height = Math.max(minPx, height);
  }

  // Move the centre by half the growth toward the dragged side(s), in the box's own axes, so the
  // opposite side stays put.
  const cx = (handle.sx * (width - box.width)) / 2;
  const cy = (handle.sy * (height - box.height)) / 2;
  const centerX = box.x + box.width / 2 + cx * cos - cy * sin;
  const centerY = box.y + box.height / 2 + cx * sin + cy * cos;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

// Where to draw a handle (px from the box's top-left) so it stays grabbable: inside the visible
// frame - `reserveBottom` px kept clear for the player's controls - even when the box runs to or
// past the edge. Only for an unrotated box; a rotated one keeps its true corners.
export function reachableHandlePosition(handle: Pick<ResizeHandle, "sx" | "sy">, box: PxBox, frameWidth: number, frameHeight: number, reserveBottom: number, inset = 8): { left: number; top: number } {
  const left = ((handle.sx + 1) / 2) * box.width;
  const top = ((handle.sy + 1) / 2) * box.height;
  const minX = inset;
  const maxX = Math.max(minX, frameWidth - inset);
  const minY = inset;
  const maxY = Math.max(minY, frameHeight - reserveBottom - inset);
  return {
    left: Math.max(minX, Math.min(maxX, box.x + left)) - box.x,
    top: Math.max(minY, Math.min(maxY, box.y + top)) - box.y,
  };
}
