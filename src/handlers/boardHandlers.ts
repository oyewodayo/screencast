// handlers/boardHandlers.ts
//
// Pure functions only - no React, no closures over component state. Independent implementation
// for the Board feature: technique-only overlap with imageEditHandlers.ts (same hand-rolled
// Canvas 2D approach - save/restore, translate/rotate, drawImage, rotation-aware hit-testing) but
// no shared code, per the Board feature's "build from scratch" requirement (the single-image
// editor's tools don't fit this feature's per-image padding/border/margin/radius needs).

import { BoardCommand, BoardDocument, BoardImage } from "../utils/boardTypes";

// ---- Geometry helpers -----------------------------------------------------------------------

// Rotates (x, y) by -radians around (cx, cy) - brings a query point into a box's own local
// (unrotated) frame, so hit-testing/resizing it is a plain axis-aligned check instead of a
// rotated-rectangle intersection.
function unrotatePoint(x: number, y: number, cx: number, cy: number, radians: number): { x: number; y: number } {
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// Inverse of unrotatePoint - takes a point from the box's local frame back into canvas space.
// Used to place resize-handle chrome at a rotated box's actual on-screen corners.
function rotatePoint(x: number, y: number, cx: number, cy: number, radians: number): { x: number; y: number } {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// "Cover" fit: scale the source image up just enough that it fills the destination box on both
// axes, then crop whichever axis overflows - matches how most collage/board tools fit a photo
// into a frame (no letterboxing). Returns a source-space crop rect for ctx.drawImage's 9-arg form.
export function coverFitRect(naturalWidth: number, naturalHeight: number, boxWidth: number, boxHeight: number): { sx: number; sy: number; sw: number; sh: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return { sx: 0, sy: 0, sw: naturalWidth, sh: naturalHeight };
  }
  const boxAspect = boxWidth / boxHeight;
  const srcAspect = naturalWidth / naturalHeight;
  let sw = naturalWidth;
  let sh = naturalHeight;
  if (srcAspect > boxAspect) {
    sw = naturalHeight * boxAspect; // source is relatively wider than the box - crop its sides
  } else {
    sh = naturalWidth / boxAspect; // source is relatively taller than the box - crop top/bottom
  }
  return { sx: (naturalWidth - sw) / 2, sy: (naturalHeight - sh) / 2, sw, sh };
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- Rendering --------------------------------------------------------------------------------

// Draws one image's frame (background box + border) and, inset by borderWidth+padding, the photo
// itself clipped to a matching rounded rect and cover-fit into the resulting content area. `img`
// is null while the asset is still decoding - the caller's preload effect redraws once it's ready
// (same "frame renders immediately, photo pops in" split the rest of this app already accepts).
function renderBoardImage(ctx: CanvasRenderingContext2D, image: BoardImage, img: HTMLImageElement | null): void {
  ctx.save();
  const cx = image.x + image.width / 2;
  const cy = image.y + image.height / 2;
  ctx.translate(cx, cy);
  ctx.rotate(image.rotation);
  ctx.translate(-cx, -cy);
  ctx.globalAlpha = image.opacity;

  if (image.shadow) {
    ctx.shadowBlur = image.shadow.blur;
    ctx.shadowOffsetX = image.shadow.offsetX;
    ctx.shadowOffsetY = image.shadow.offsetY;
    ctx.shadowColor = image.shadow.color;
  }

  roundedRectPath(ctx, image.x, image.y, image.width, image.height, image.cornerRadius);
  ctx.fillStyle = image.backgroundColor;
  ctx.fill();

  if (image.borderWidth > 0) {
    ctx.shadowColor = "transparent"; // shadow already applied by the fill above - don't double it on the stroke
    ctx.lineWidth = image.borderWidth;
    ctx.strokeStyle = image.borderColor;
    ctx.stroke();
  }

  const inset = image.borderWidth + image.padding;
  const contentX = image.x + inset;
  const contentY = image.y + inset;
  const contentWidth = Math.max(0, image.width - inset * 2);
  const contentHeight = Math.max(0, image.height - inset * 2);

  if (img && contentWidth > 0 && contentHeight > 0) {
    ctx.save();
    ctx.shadowColor = "transparent";
    const contentRadius = Math.max(0, image.cornerRadius - image.borderWidth);
    roundedRectPath(ctx, contentX, contentY, contentWidth, contentHeight, contentRadius);
    ctx.clip();
    const { sx, sy, sw, sh } = coverFitRect(image.naturalWidth, image.naturalHeight, contentWidth, contentHeight);
    ctx.drawImage(img, sx, sy, sw, sh, contentX, contentY, contentWidth, contentHeight);
    ctx.restore();
  }

  ctx.restore();
}

// Resolves doc.padding defensively (Number.isFinite guard - same reasoning safeGap used to have
// for the old gridlineWidth field: a board saved before `padding` existed loads it as `undefined`,
// which must never reach arithmetic as NaN - this exact bug already slipped through once, into the
// zoom-percentage readout, because paddedCanvasSize was the only place guarding it). Every place
// in this codebase that touches doc.padding for arithmetic - not just this file - must go through
// this function rather than reading doc.padding directly.
export function resolveBoardPadding(doc: BoardDocument): number {
  return Number.isFinite(doc.padding) ? Math.max(0, doc.padding) : 0;
}

// The actual buffer size a canvas needs to hold the board plus its mat/frame border on every side.
export function paddedCanvasSize(doc: BoardDocument): { width: number; height: number; padding: number } {
  const padding = resolveBoardPadding(doc);
  return { width: doc.canvasWidth + padding * 2, height: doc.canvasHeight + padding * 2, padding };
}

// Renders the full board: background fill (covering the padded mat border too), then every image
// in array order (last = topmost), inset by paddedCanvasSize's padding so image coordinates stay
// in the document's own unpadded space throughout (BoardImage.x/y never account for padding -
// callers doing hit-testing/pointer math against the same buffer must subtract padding back out,
// see BoardCanvas.tsx's pointerToCanvasSpace). `canvas` must already be sized to
// `paddedCanvasSize(doc).width * scale` / `.height * scale` by the caller (same split of
// responsibility as imageEditHandlers.ts's renderComposedCanvas) - `imageBitmaps` maps a
// BoardImage's assetFileName to its decoded HTMLImageElement.
export function renderBoardToCanvas(canvas: HTMLCanvasElement, doc: BoardDocument, imageBitmaps: Map<string, HTMLImageElement>, scale = 1): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height, padding } = paddedCanvasSize(doc);

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (doc.backgroundColor) {
    ctx.fillStyle = doc.backgroundColor;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.save();
  ctx.translate(padding, padding);
  for (const image of doc.images) {
    renderBoardImage(ctx, image, imageBitmaps.get(image.assetFileName) ?? null);
  }
  ctx.restore();
}

// ---- Hit-testing / interaction -----------------------------------------------------------------

// Click-to-select hit test, topmost (last-drawn) image first.
export function hitTestBoardImage(images: BoardImage[], x: number, y: number): BoardImage | null {
  for (let i = images.length - 1; i >= 0; i--) {
    const image = images[i];
    const cx = image.x + image.width / 2;
    const cy = image.y + image.height / 2;
    const local = unrotatePoint(x, y, cx, cy, image.rotation);
    if (local.x >= image.x && local.x <= image.x + image.width && local.y >= image.y && local.y <= image.y + image.height) {
      return image;
    }
  }
  return null;
}

export type ResizeCorner = "nw" | "ne" | "sw" | "se";

// On-screen (canvas-space) positions of an image's four resize-handle corners, accounting for its
// current rotation - what BoardCanvas draws handle chrome at and hit-tests drag starts against.
export function resizeHandlePoints(image: BoardImage): Record<ResizeCorner, { x: number; y: number }> {
  const cx = image.x + image.width / 2;
  const cy = image.y + image.height / 2;
  const local: Record<ResizeCorner, { x: number; y: number }> = {
    nw: { x: image.x, y: image.y },
    ne: { x: image.x + image.width, y: image.y },
    sw: { x: image.x, y: image.y + image.height },
    se: { x: image.x + image.width, y: image.y + image.height },
  };
  return {
    nw: rotatePoint(local.nw.x, local.nw.y, cx, cy, image.rotation),
    ne: rotatePoint(local.ne.x, local.ne.y, cx, cy, image.rotation),
    sw: rotatePoint(local.sw.x, local.sw.y, cx, cy, image.rotation),
    se: rotatePoint(local.se.x, local.se.y, cx, cy, image.rotation),
  };
}

// Canvas-space position of the rotate handle - a fixed offset above the box's local top edge,
// rotated along with the box, so it always sits just outside whichever edge is currently "up".
export function rotateHandlePoint(image: BoardImage, offset = 28): { x: number; y: number } {
  const cx = image.x + image.width / 2;
  const cy = image.y + image.height / 2;
  return rotatePoint(cx, image.y - offset, cx, cy, image.rotation);
}

export function applyMove(image: BoardImage, dx: number, dy: number): BoardImage {
  return { ...image, x: image.x + dx, y: image.y + dy, updatedAt: Date.now() };
}

// Resizes by dragging one corner, keeping the *opposite* corner fixed - pointer coordinates are
// first brought into the box's own local (unrotated) frame so this works the same regardless of
// the box's current rotation. `minSize` prevents the box collapsing to zero/negative.
export function applyResize(image: BoardImage, corner: ResizeCorner, pointerX: number, pointerY: number, minSize = 24): BoardImage {
  const cx = image.x + image.width / 2;
  const cy = image.y + image.height / 2;
  const local = unrotatePoint(pointerX, pointerY, cx, cy, image.rotation);

  const left = corner === "nw" || corner === "sw" ? local.x : image.x;
  const right = corner === "ne" || corner === "se" ? local.x : image.x + image.width;
  const top = corner === "nw" || corner === "ne" ? local.y : image.y;
  const bottom = corner === "sw" || corner === "se" ? local.y : image.y + image.height;

  const x = Math.min(left, right - minSize);
  const y = Math.min(top, bottom - minSize);
  return { ...image, x, y, width: Math.max(minSize, right - x), height: Math.max(minSize, bottom - y), updatedAt: Date.now() };
}

export function applyRotate(image: BoardImage, pointerX: number, pointerY: number): BoardImage {
  const cx = image.x + image.width / 2;
  const cy = image.y + image.height / 2;
  const rotation = Math.atan2(pointerY - cy, pointerX - cx) + Math.PI / 2;
  return { ...image, rotation, updatedAt: Date.now() };
}

// ---- Auto-layout ("arrange side by side") ---------------------------------------------------
//
// A one-shot toolbar action, not continuous/live layout - free drag/resize is the default
// interaction; this just gives "arrange side by side" a fast starting point. Not constrained by
// (or reading) the document's current canvasWidth/canvasHeight - a fixed size only ever meant
// squeezing rows shorter as more images got added, or leaving dead space on whichever side the
// content doesn't reach. Instead it reports back the width and height the row it just laid out
// actually needs; the caller (BoardEditor) applies that via a canvas-size command, so the board
// grows or shrinks to fit.
export interface AutoLayoutResult {
  images: BoardImage[];
  canvasWidth: number;
  canvasHeight: number;
}

// Lays every image left-to-right at a common row height (their average current height), wrapping
// to a new row when the next image would overflow `maxWidth`. Rotation resets to 0 - a tilted
// image in a tidy row would overhang its neighbors, defeating the point of arranging one.
//
// `gap` is the same value as the board's own `padding` (BoardDocument) - one spacing concept
// governing both the mat border around the whole board *and* the space between arranged images,
// rather than two different things both called "padding." Callers should pass
// `resolveBoardPadding(doc)`, not `doc.padding` directly; this function also re-guards it, the
// same defense-in-depth paddedCanvasSize already applies, since a bad gap here would collapse
// every image's position/size to NaN exactly like the old ungaurded gridlineWidth did.
//
// `startY` lets a caller lay out just a *subset* of the board's images (e.g. a freshly-imported
// batch) starting below whatever's already there, rather than always from the very top - see
// BoardEditor.tsx's handleAddImages, which is the only caller that isn't "Arrange in a row" itself.
export function layoutImagesInRow(images: BoardImage[], maxWidth: number, gap: number, startY?: number): AutoLayoutResult {
  if (images.length === 0) return { images, canvasWidth: 0, canvasHeight: 0 };
  const g = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  const rowHeight = images.reduce((sum, img) => sum + img.height, 0) / images.length;

  let x = g;
  let y = startY ?? g;
  let tallestInRow = 0;
  // Rightmost edge actually reached by the current row's images, tracked separately from `x`
  // (which includes the trailing gap toward whatever image *would* come next) - what lets the
  // returned canvasWidth hug the real content instead of always echoing back the `maxWidth` wrap
  // boundary, which is usually wider than any row actually fills.
  let rowRight = 0;
  let maxRowRight = 0;
  const now = Date.now();

  const placed = images.map((image) => {
    const aspect = image.width / Math.max(1, image.height);
    const height = rowHeight;
    const width = height * aspect;

    if (x !== g && x + width > maxWidth - g) {
      maxRowRight = Math.max(maxRowRight, rowRight);
      x = g;
      y += tallestInRow + g;
      tallestInRow = 0;
    }

    const placedImage: BoardImage = { ...image, x, y, width, height, rotation: 0, updatedAt: now };
    x += width + g;
    rowRight = x - g;
    tallestInRow = Math.max(tallestInRow, height);
    return placedImage;
  });
  maxRowRight = Math.max(maxRowRight, rowRight);

  return { images: placed, canvasWidth: maxRowRight + g, canvasHeight: y + tallestInRow + g };
}

// ---- Document mutation (pure) --------------------------------------------------------------------

export function applyCommand(doc: BoardDocument, command: BoardCommand): BoardDocument {
  const updatedAt = new Date().toISOString();
  switch (command.type) {
    case "add":
      return { ...doc, images: [...doc.images, command.image], updatedAt };
    case "delete":
      return { ...doc, images: doc.images.filter((img) => img.id !== command.image.id), updatedAt };
    case "edit":
      return { ...doc, images: doc.images.map((img) => (img.id === command.after.id ? command.after : img)), updatedAt };
    case "batch-edit": {
      const afterById = new Map(command.after.map((img) => [img.id, img]));
      return { ...doc, images: doc.images.map((img) => afterById.get(img.id) ?? img), updatedAt };
    }
    case "reorder":
      return { ...doc, images: command.after, updatedAt };
    case "background":
      return { ...doc, backgroundColor: command.after, updatedAt };
    case "canvas-size":
      return { ...doc, canvasWidth: command.after.width, canvasHeight: command.after.height, updatedAt };
    case "padding":
      return { ...doc, padding: command.after, updatedAt };
  }
}

export function invertCommand(command: BoardCommand): BoardCommand {
  switch (command.type) {
    case "add":
      return { type: "delete", image: command.image };
    case "delete":
      return { type: "add", image: command.image };
    case "edit":
      return { type: "edit", before: command.after, after: command.before };
    case "batch-edit":
      return { type: "batch-edit", before: command.after, after: command.before };
    case "reorder":
      return { type: "reorder", before: command.after, after: command.before };
    case "background":
      return { type: "background", before: command.after, after: command.before };
    case "canvas-size":
      return { type: "canvas-size", before: command.after, after: command.before };
    case "padding":
      return { type: "padding", before: command.after, after: command.before };
  }
}
