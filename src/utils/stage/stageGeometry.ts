// utils/stage/stageGeometry.ts
//
// Resizing and turning an element's box by its handles, the way design tools do: the edge or
// corner opposite the one dragged stays exactly where it is on screen - also when the element is
// rotated or scaled - Shift keeps the proportions, Alt grows it about its centre. Pure functions,
// shared by the stage's handles and the panel's fields.

export interface GeoBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scale: number;
  anchorX: number;
  anchorY: number;
}

// Which handle: -1 / 0 / 1 along each axis of the box (left/centre/right, top/middle/bottom).
export interface Handle {
  sx: -1 | 0 | 1;
  sy: -1 | 0 | 1;
}

export const HANDLES: (Handle & { id: string; cursor: string })[] = [
  { id: "nw", sx: -1, sy: -1, cursor: "nwse-resize" },
  { id: "n", sx: 0, sy: -1, cursor: "ns-resize" },
  { id: "ne", sx: 1, sy: -1, cursor: "nesw-resize" },
  { id: "e", sx: 1, sy: 0, cursor: "ew-resize" },
  { id: "se", sx: 1, sy: 1, cursor: "nwse-resize" },
  { id: "s", sx: 0, sy: 1, cursor: "ns-resize" },
  { id: "sw", sx: -1, sy: 1, cursor: "nesw-resize" },
  { id: "w", sx: -1, sy: 0, cursor: "ew-resize" },
];

const rad = (deg: number) => (deg * Math.PI) / 180;

// Where a point of the box (u, v from its top-left, unscaled box units) is on the stage.
export function boxPoint(b: GeoBox, u: number, v: number): { x: number; y: number } {
  const ax = b.anchorX * b.width;
  const ay = b.anchorY * b.height;
  const c = Math.cos(rad(b.rotation));
  const s = Math.sin(rad(b.rotation));
  const lx = (u - ax) * b.scale;
  const ly = (v - ay) * b.scale;
  return { x: b.x + ax + lx * c - ly * s, y: b.y + ay + lx * s + ly * c };
}

// The box resized by dragging `handle` by (dx, dy) stage units.
export function resizeBox(
  b: GeoBox,
  handle: Handle,
  dx: number,
  dy: number,
  opts: { keepAspect?: boolean; fromCentre?: boolean; minSize?: number } = {}
): { x: number; y: number; width: number; height: number } {
  const min = opts.minSize ?? 4;
  const c = Math.cos(rad(b.rotation));
  const s = Math.sin(rad(b.rotation));
  // The drag in the box's own axes, in its unscaled units.
  const lx = (dx * c + dy * s) / (b.scale || 1);
  const ly = (-dx * s + dy * c) / (b.scale || 1);
  const grow = opts.fromCentre ? 2 : 1;
  let w = b.width + handle.sx * lx * grow;
  let h = b.height + handle.sy * ly * grow;
  if (opts.keepAspect && b.width > 0 && b.height > 0) {
    const aspect = b.width / b.height;
    if (handle.sx !== 0 && handle.sy !== 0) {
      // A corner: whichever side was pulled further (relatively) leads.
      const fw = w / b.width;
      const fh = h / b.height;
      const f = Math.abs(fw - 1) >= Math.abs(fh - 1) ? fw : fh;
      w = b.width * f;
      h = b.height * f;
    } else if (handle.sx !== 0) h = w / aspect;
    else w = h * aspect;
  }
  if (w < min) {
    if (opts.keepAspect && b.height > 0) h = (min * b.height) / b.width;
    w = min;
  }
  if (h < min) {
    if (opts.keepAspect && b.width > 0) w = Math.max(min, (min * b.width) / b.height);
    h = min;
  }
  // The point that stays put: the centre, or the side/corner opposite the handle (across the axis a
  // side handle doesn't pull, its middle).
  const fixed = (side: -1 | 0 | 1, size: number) => (opts.fromCentre || side === 0 ? size / 2 : side === 1 ? 0 : size);
  const was = boxPoint(b, fixed(handle.sx, b.width), fixed(handle.sy, b.height));
  const next = { ...b, width: w, height: h };
  const now = boxPoint(next, fixed(handle.sx, w), fixed(handle.sy, h));
  return { x: b.x + was.x - now.x, y: b.y + was.y - now.y, width: w, height: h };
}

// The rotation after turning by the pointer from `start` to `now` about the box's anchor; with
// `snap`, to the nearest 15 degrees.
export function turnBox(b: GeoBox, start: { x: number; y: number }, now: { x: number; y: number }, snap = false): number {
  const pivot = { x: b.x + b.anchorX * b.width, y: b.y + b.anchorY * b.height };
  const a0 = Math.atan2(start.y - pivot.y, start.x - pivot.x);
  const a1 = Math.atan2(now.y - pivot.y, now.x - pivot.x);
  let r = b.rotation + ((a1 - a0) * 180) / Math.PI;
  if (snap) r = Math.round(r / 15) * 15;
  // Kept near the old value's turn so a spring between beats doesn't take the long way round.
  while (r - b.rotation > 180) r -= 360;
  while (r - b.rotation < -180) r += 360;
  return Math.round(r * 10) / 10;
}

// The box's four corners on the stage (for drawing a rotated selection, and hit testing).
export function boxCorners(b: GeoBox): { x: number; y: number }[] {
  return [boxPoint(b, 0, 0), boxPoint(b, b.width, 0), boxPoint(b, b.width, b.height), boxPoint(b, 0, b.height)];
}

// Whether a stage point is inside the (rotated, scaled) box.
export function insideBox(b: GeoBox, x: number, y: number): boolean {
  const ax = b.x + b.anchorX * b.width;
  const ay = b.y + b.anchorY * b.height;
  const c = Math.cos(rad(-b.rotation));
  const s = Math.sin(rad(-b.rotation));
  const lx = ((x - ax) * c - (y - ay) * s) / (b.scale || 1) + b.anchorX * b.width;
  const ly = ((x - ax) * s + (y - ay) * c) / (b.scale || 1) + b.anchorY * b.height;
  return lx >= 0 && lx <= b.width && ly >= 0 && ly <= b.height;
}
