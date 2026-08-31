// handlers/boardHandlers.ts
//
// Pure functions only - no React, no closures over component state. Independent implementation
// for the Board feature: technique-only overlap with imageEditHandlers.ts (same hand-rolled
// Canvas 2D approach - save/restore, translate/rotate, drawImage, rotation-aware hit-testing) but
// no shared code, per the Board feature's "build from scratch" requirement (the single-image
// editor's tools don't fit this feature's per-image padding/border/margin/radius needs).

import { BoardBackgroundMode, BoardCommand, BoardDocument, BoardGridBackground, BoardImage, BoardItem, BoardText } from "../utils/boardTypes";

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

// Greedy word-wrap: splits on explicit newlines first (a deliberate paragraph break the user
// typed), then wraps each paragraph's words to fit `maxWidth`, measured against whatever font is
// already set on `ctx` - callers must set ctx.font before calling this. A single word wider than
// maxWidth is still placed on its own line rather than split mid-word (this is a text box, not a
// terminal - breaking a word is worse than letting one line overflow slightly).
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (maxWidth > 0 && current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

// Draws one text item's background box (if any) and its word-wrapped content, clipped to the box
// so an overflowing paragraph is cropped rather than spilling onto whatever's next to it - the
// text-editing UI (BoardStylePanel) has no live "does this fit" preview, so silently cropping is
// safer than an unreadable overlap. `padding` insets the text from the box on every side, same
// convention renderBoardImage's own borderWidth+padding inset uses for the photo inside its frame.
function renderBoardText(ctx: CanvasRenderingContext2D, item: BoardText): void {
  ctx.save();
  const cx = item.x + item.width / 2;
  const cy = item.y + item.height / 2;
  ctx.translate(cx, cy);
  ctx.rotate(item.rotation);
  ctx.translate(-cx, -cy);
  ctx.globalAlpha = item.opacity;

  if (item.backgroundColor) {
    roundedRectPath(ctx, item.x, item.y, item.width, item.height, item.cornerRadius);
    ctx.fillStyle = item.backgroundColor;
    ctx.fill();
  }

  const contentX = item.x + item.padding;
  const contentY = item.y + item.padding;
  const contentWidth = Math.max(0, item.width - item.padding * 2);
  const contentHeight = Math.max(0, item.height - item.padding * 2);

  if (contentWidth > 0 && contentHeight > 0 && item.text) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(contentX, contentY, contentWidth, contentHeight);
    ctx.clip();

    ctx.fillStyle = item.color;
    ctx.font = `${item.fontStyle} ${item.fontWeight} ${item.fontSize}px ${item.fontFamily}`;
    ctx.textBaseline = "top";
    ctx.textAlign = item.textAlign;

    const anchorX = item.textAlign === "center" ? contentX + contentWidth / 2 : item.textAlign === "right" ? contentX + contentWidth : contentX;
    const lineHeight = item.fontSize * 1.25;
    wrapText(ctx, item.text, contentWidth).forEach((line, i) => {
      ctx.fillText(line, anchorX, contentY + i * lineHeight);
    });
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

// ---- Background --------------------------------------------------------------------------------
//
// Three interchangeable renderers, switched on doc.backgroundMode (BoardBackgroundMode) - a solid
// fill (the original/default), a repeating gridline pattern (spacing/line color/optional base
// fill), or a full-bleed photo. All three cover the FULL padded buffer, including the mat/frame
// border area - same as the original solid-fill behavior this replaced, so switching modes never
// changes what area gets covered, only what's drawn into it.

// Plain 6-digit hex (no alpha) for lineColor/baseColor - both are edited via a plain HTML
// <input type="color">, which silently rejects/ignores an 8-digit #rrggbbaa value, so an alpha
// channel here would be uneditable from the background panel even though it'd render fine.
export const DEFAULT_BOARD_GRID: BoardGridBackground = { spacing: 40, lineColor: "#d9d9d9", baseColor: "#ffffff" };

// Same defensive-default reasoning as resolveBoardPadding above: a board that's never touched the
// grid background (backgroundMode always something else, or this whole feature didn't exist yet
// when it was saved) simply has no backgroundGrid on disk. Guarded on spacing specifically since
// that's the one field a bad/zero value would turn into an infinite or divide-by-zero draw loop.
export function resolveBoardGrid(doc: BoardDocument): BoardGridBackground {
  const grid = doc.backgroundGrid;
  if (!grid || !Number.isFinite(grid.spacing) || grid.spacing <= 0) return DEFAULT_BOARD_GRID;
  return grid;
}

// Same reasoning as resolveBoardPadding/resolveBoardGrid - an old board's JSON simply predates this
// field, so "absent" must resolve to the one behavior every existing board already had: a plain
// color fill.
export function resolveBackgroundMode(doc: BoardDocument): BoardBackgroundMode {
  return doc.backgroundMode ?? "color";
}

function drawGridBackground(ctx: CanvasRenderingContext2D, width: number, height: number, grid: BoardGridBackground): void {
  if (grid.baseColor) {
    ctx.fillStyle = grid.baseColor;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.save();
  ctx.strokeStyle = grid.lineColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // +0.5 lands each 1px line on a pixel boundary rather than straddling two (the standard canvas
  // crisp-hairline trick) - without it every line renders as a blurry 2px band instead of a sharp
  // 1px one.
  for (let x = 0; x <= width; x += grid.spacing) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
  }
  for (let y = 0; y <= height; y += grid.spacing) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

// Renders the full board: background (see the three-renderer comment above), then every item
// (image or text) in array order (last = topmost), inset by paddedCanvasSize's padding so item
// coordinates stay in the document's own unpadded space throughout (BoardItem.x/y never account
// for padding - callers
// doing hit-testing/pointer math against the same buffer must subtract padding back out, see
// BoardCanvas.tsx's pointerToCanvasSpace). `canvas` must already be sized to
// `paddedCanvasSize(doc).width * scale` / `.height * scale` by the caller (same split of
// responsibility as imageEditHandlers.ts's renderComposedCanvas) - `imageBitmaps` maps a
// BoardImage's assetFileName to its decoded HTMLImageElement, and doubles as the source for
// doc.backgroundImage's own decoded bitmap (same map, same assets/ folder, no separate cache
// needed - a background image is decoded/cached exactly like a placed one).
export function renderBoardToCanvas(canvas: HTMLCanvasElement, doc: BoardDocument, imageBitmaps: Map<string, HTMLImageElement>, scale = 1): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height, padding } = paddedCanvasSize(doc);

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const mode = resolveBackgroundMode(doc);
  if (mode === "grid") {
    drawGridBackground(ctx, width, height, resolveBoardGrid(doc));
  } else if (mode === "image" && doc.backgroundImage) {
    const bg = imageBitmaps.get(doc.backgroundImage);
    // Left blank (transparent) until decoded - same "frame renders immediately, photo pops in
    // once ready" split renderBoardImage already accepts for placed images.
    if (bg) {
      const { sx, sy, sw, sh } = coverFitRect(bg.naturalWidth, bg.naturalHeight, width, height);
      ctx.drawImage(bg, sx, sy, sw, sh, 0, 0, width, height);
    }
  } else if (doc.backgroundColor) {
    ctx.fillStyle = doc.backgroundColor;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.save();
  ctx.translate(padding, padding);
  for (const item of doc.images) {
    if (item.kind === "text") renderBoardText(ctx, item);
    else renderBoardImage(ctx, item, imageBitmaps.get(item.assetFileName) ?? null);
  }
  ctx.restore();
}

// ---- Hit-testing / interaction -----------------------------------------------------------------

// Click-to-select hit test, topmost (last-drawn) item first - works identically for an image or a
// text item since both are BoardItem's shared border-box geometry (see BoardItemBase's own doc
// comment in boardTypes.ts).
export function hitTestBoardItem(items: BoardItem[], x: number, y: number): BoardItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    const local = unrotatePoint(x, y, cx, cy, item.rotation);
    if (local.x >= item.x && local.x <= item.x + item.width && local.y >= item.y && local.y <= item.y + item.height) {
      return item;
    }
  }
  return null;
}

export type ResizeCorner = "nw" | "ne" | "sw" | "se";

// On-screen (canvas-space) positions of an item's four resize-handle corners, accounting for its
// current rotation - what BoardCanvas draws handle chrome at and hit-tests drag starts against.
export function resizeHandlePoints(item: BoardItem): Record<ResizeCorner, { x: number; y: number }> {
  const cx = item.x + item.width / 2;
  const cy = item.y + item.height / 2;
  const local: Record<ResizeCorner, { x: number; y: number }> = {
    nw: { x: item.x, y: item.y },
    ne: { x: item.x + item.width, y: item.y },
    sw: { x: item.x, y: item.y + item.height },
    se: { x: item.x + item.width, y: item.y + item.height },
  };
  return {
    nw: rotatePoint(local.nw.x, local.nw.y, cx, cy, item.rotation),
    ne: rotatePoint(local.ne.x, local.ne.y, cx, cy, item.rotation),
    sw: rotatePoint(local.sw.x, local.sw.y, cx, cy, item.rotation),
    se: rotatePoint(local.se.x, local.se.y, cx, cy, item.rotation),
  };
}

// Canvas-space position of the rotate handle - a fixed offset above the box's local top edge,
// rotated along with the box, so it always sits just outside whichever edge is currently "up".
export function rotateHandlePoint(item: BoardItem, offset = 28): { x: number; y: number } {
  const cx = item.x + item.width / 2;
  const cy = item.y + item.height / 2;
  return rotatePoint(cx, item.y - offset, cx, cy, item.rotation);
}

// Generic over T so a BoardImage stays a BoardImage and a BoardText stays a BoardText through the
// operation (a plain BoardItem param/return would collapse the result back to the union, forcing
// every caller to re-narrow by `.kind` even when they already know which one they started with).
export function applyMove<T extends BoardItem>(item: T, dx: number, dy: number): T {
  return { ...item, x: item.x + dx, y: item.y + dy, updatedAt: Date.now() };
}

// Resizes by dragging one corner, keeping the *opposite* corner fixed - pointer coordinates are
// first brought into the box's own local (unrotated) frame so this works the same regardless of
// the box's current rotation. `minSize` prevents the box collapsing to zero/negative.
export function applyResize<T extends BoardItem>(image: T, corner: ResizeCorner, pointerX: number, pointerY: number, minSize = 24): T {
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

export function applyRotate<T extends BoardItem>(image: T, pointerX: number, pointerY: number): T {
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

// A single common "footprint" size for every image in an auto-layout that deliberately normalizes
// size (grid/circle/fan - unlike layoutImagesInRow, which preserves each image's own aspect ratio
// at a shared row height). Geometric mean of each image's current width/height, averaged across the
// batch, then rounded - keeps the new layout's overall scale in the same ballpark as whatever the
// images were before, rather than snapping to an arbitrary fixed constant that'd feel disconnected
// from a board someone already has images placed on.
function commonFootprint(images: BoardImage[]): number {
  const avg = images.reduce((sum, img) => sum + Math.sqrt(Math.max(1, img.width) * Math.max(1, img.height)), 0) / images.length;
  return Math.max(60, Math.round(avg));
}

// Lays every image into a uniform square grid (Instagram-style) - equal-size cells regardless of
// each photo's own aspect ratio, relying on renderBoardImage's existing cover-fit to crop each
// photo to fill its cell rather than letterboxing it. Columns = ceil(sqrt(n)), which keeps the
// overall shape roughly square for any image count. Rotation resets to 0, same reasoning
// layoutImagesInRow gives for why a tidy arrangement and per-image tilt don't mix.
export function layoutImagesInGrid(images: BoardImage[], gap: number): AutoLayoutResult {
  if (images.length === 0) return { images, canvasWidth: 0, canvasHeight: 0 };
  const g = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  const cell = commonFootprint(images);
  const columns = Math.max(1, Math.ceil(Math.sqrt(images.length)));
  const rows = Math.ceil(images.length / columns);
  const now = Date.now();

  const placed = images.map((image, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    return { ...image, x: g + col * (cell + g), y: g + row * (cell + g), width: cell, height: cell, rotation: 0, updatedAt: now };
  });

  return { images: placed, canvasWidth: columns * cell + (columns + 1) * g, canvasHeight: rows * cell + (rows + 1) * g };
}

// Evenly spaces every image, same uniform size as layoutImagesInGrid, around the circumference of
// a ring - a clean rosette/wreath look. Radius is derived from how much circumference `images.length`
// cells of size `cell` (plus a gap between each) actually need, so the ring never looks over- or
// under-crowded regardless of image count; MIN_RADIUS_FACTOR keeps 2-3 images from collapsing to a
// tiny, huddled circle. Every image stays upright (rotation 0) rather than rotated to face outward -
// reads as a deliberate wreath rather than a spinning pinwheel. Each tile's own cornerRadius is set
// to exactly half its (square) side, which renderBoardImage's roundedRectPath already clamps to
// min(radius, w/2, h/2) - so this turns every tile into a true circular photo, matching the ring
// shape they're arranged in, rather than square photos merely positioned along a circular path.
const MIN_RADIUS_FACTOR = 1.6;

function ringRadius(count: number, cell: number, gap: number): number {
  const circumferenceNeeded = count * (cell + gap);
  return Math.max((cell / 2) * MIN_RADIUS_FACTOR, circumferenceNeeded / (2 * Math.PI));
}

export function layoutImagesInCircle(images: BoardImage[], gap: number): AutoLayoutResult {
  if (images.length === 0) return { images, canvasWidth: 0, canvasHeight: 0 };
  const g = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  const cell = commonFootprint(images);
  const radius = ringRadius(images.length, cell, g);
  const canvasSize = radius * 2 + cell + g * 2;
  const center = canvasSize / 2;
  const now = Date.now();

  const placed = images.map((image, i) => {
    // Starts at 12 o'clock (angle = -90deg) and goes clockwise, matching a clock face - an
    // arbitrary but predictable starting point rather than 3 o'clock (angle 0), which would put
    // the first image at an unremarkable side position instead of "up top."
    const angle = (i / images.length) * Math.PI * 2 - Math.PI / 2;
    const cx = center + radius * Math.cos(angle);
    const cy = center + radius * Math.sin(angle);
    return { ...image, x: cx - cell / 2, y: cy - cell / 2, width: cell, height: cell, cornerRadius: cell / 2, rotation: 0, updatedAt: now };
  });

  return { images: placed, canvasWidth: canvasSize, canvasHeight: canvasSize };
}

// Same wreath as layoutImagesInCircle, except one image (`heroId` if it's actually in this batch,
// else the first image) sits large in the middle and everyone else forms the ring around it - a
// "featured photo" layout. The ring's radius is widened (heroCell/2 + gap on top of the usual
// ringRadius) whenever that's larger than what the ring images alone would need, so the hero's own
// footprint never overlaps the ring - relevant for small rings (2-3 photos) where the plain
// circumference-based radius would otherwise land inside the hero.
export function layoutImagesInCircleWithCenter(images: BoardImage[], gap: number, heroId?: string): AutoLayoutResult {
  if (images.length === 0) return { images, canvasWidth: 0, canvasHeight: 0 };
  if (images.length === 1) return layoutImagesInGrid(images, gap); // nothing to ring around a lone image
  const g = Number.isFinite(gap) ? Math.max(0, gap) : 0;

  const heroIndex = Math.max(0, images.findIndex((img) => img.id === heroId));
  const hero = images[heroIndex];
  const ringImages = images.filter((_, i) => i !== heroIndex);

  const ringCell = commonFootprint(ringImages);
  const heroCell = commonFootprint([hero]) * 1.8;
  const radius = Math.max(ringRadius(ringImages.length, ringCell, g), heroCell / 2 + g + ringCell / 2);
  const canvasSize = radius * 2 + ringCell + g * 2;
  const center = canvasSize / 2;
  const now = Date.now();

  // Both hero and ring get their own cornerRadius = half their (square) side - same "true circle,
  // not just a circular path" reasoning as layoutImagesInCircle above, applied at each tile's own
  // size so the larger hero circle and the smaller ring circles both render perfectly round.
  const placedHero: BoardImage = {
    ...hero,
    x: center - heroCell / 2,
    y: center - heroCell / 2,
    width: heroCell,
    height: heroCell,
    cornerRadius: heroCell / 2,
    rotation: 0,
    updatedAt: now,
  };
  const placedRing = ringImages.map((image, i) => {
    const angle = (i / ringImages.length) * Math.PI * 2 - Math.PI / 2;
    const cx = center + radius * Math.cos(angle);
    const cy = center + radius * Math.sin(angle);
    return { ...image, x: cx - ringCell / 2, y: cy - ringCell / 2, width: ringCell, height: ringCell, cornerRadius: ringCell / 2, rotation: 0, updatedAt: now };
  });

  // Hero drawn first (bottom of z-order) so every ring image's border/shadow reads as sitting
  // slightly on top of it if the two ever touch - a hero that visually "hosts" the ring rather
  // than the reverse.
  return { images: [placedHero, ...placedRing], canvasWidth: canvasSize, canvasHeight: canvasSize };
}

// Loose, overlapping "photos scattered on a table" layout - each image at a common size, heavily
// overlapping its neighbor (OVERLAP_FACTOR), with a deterministic per-slot tilt/vertical-offset
// pulled from a small repeating pattern rather than real randomness: re-running this on the exact
// same images always produces the exact same board (this file's own "pure functions only" rule at
// top - randomness would make the result unreproducible and, worse, different on every undo/redo
// replay). Later images sit on top (z-order = array order, last = topmost), so the fan reads
// left-to-right the same way a hand of cards does.
const FAN_TILT_DEGREES = [-8, 5, -6, 7, -4, 8, -5, 6];
const FAN_VERTICAL_OFFSET_FACTOR = [0.18, -0.12, 0.22, -0.2, 0.1, -0.16, 0.24, -0.1];
const OVERLAP_FACTOR = 0.55;

export function layoutImagesInFan(images: BoardImage[], gap: number): AutoLayoutResult {
  if (images.length === 0) return { images, canvasWidth: 0, canvasHeight: 0 };
  const g = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  const cell = commonFootprint(images);
  const step = cell * OVERLAP_FACTOR;
  const maxVerticalOffset = cell * Math.max(...FAN_VERTICAL_OFFSET_FACTOR.map(Math.abs));
  // A tilted square's axis-aligned bounding box is wider/taller than the square itself
  // (cell * (|cos| + |sin|)) - without accounting for that, a corner of the first/last/tallest-
  // tilted image would poke past canvasWidth/canvasHeight and get clipped, since the canvas element
  // is sized exactly to those dimensions (see renderBoardToCanvas/paddedCanvasSize). Computed once
  // from the whole fixed tilt set (not per-image) since `cell` is common to every image here.
  const maxTiltMargin = Math.max(
    ...FAN_TILT_DEGREES.map((deg) => {
      const rad = (deg * Math.PI) / 180;
      return (cell * (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad))) - cell) / 2;
    })
  );
  const now = Date.now();

  const placed = images.map((image, i) => {
    const tilt = (FAN_TILT_DEGREES[i % FAN_TILT_DEGREES.length] * Math.PI) / 180;
    const verticalOffset = cell * FAN_VERTICAL_OFFSET_FACTOR[i % FAN_VERTICAL_OFFSET_FACTOR.length];
    return {
      ...image,
      x: g + maxTiltMargin + i * step,
      y: g + maxTiltMargin + maxVerticalOffset + verticalOffset,
      width: cell,
      height: cell,
      rotation: tilt,
      updatedAt: now,
    };
  });

  const canvasWidth = g * 2 + maxTiltMargin * 2 + (images.length - 1) * step + cell;
  const canvasHeight = g * 2 + maxTiltMargin * 2 + maxVerticalOffset * 2 + cell;
  return { images: placed, canvasWidth, canvasHeight };
}

// ---- Document mutation (pure) --------------------------------------------------------------------

export function applyCommand(doc: BoardDocument, command: BoardCommand): BoardDocument {
  const updatedAt = new Date().toISOString();
  switch (command.type) {
    case "add":
      return { ...doc, images: [...doc.images, command.item], updatedAt };
    case "delete":
      return { ...doc, images: doc.images.filter((img) => img.id !== command.item.id), updatedAt };
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
    case "background-mode":
      return { ...doc, backgroundMode: command.after, updatedAt };
    case "background-grid":
      return { ...doc, backgroundGrid: command.after, updatedAt };
    case "background-image":
      return { ...doc, backgroundImage: command.after, updatedAt };
    case "canvas-size":
      return { ...doc, canvasWidth: command.after.width, canvasHeight: command.after.height, updatedAt };
    case "padding":
      return { ...doc, padding: command.after, updatedAt };
  }
}

export function invertCommand(command: BoardCommand): BoardCommand {
  switch (command.type) {
    case "add":
      return { type: "delete", item: command.item };
    case "delete":
      return { type: "add", item: command.item };
    case "edit":
      return { type: "edit", before: command.after, after: command.before };
    case "batch-edit":
      return { type: "batch-edit", before: command.after, after: command.before };
    case "reorder":
      return { type: "reorder", before: command.after, after: command.before };
    case "background":
      return { type: "background", before: command.after, after: command.before };
    case "background-mode":
      return { type: "background-mode", before: command.after, after: command.before };
    case "background-grid":
      return { type: "background-grid", before: command.after, after: command.before };
    case "background-image":
      return { type: "background-image", before: command.after, after: command.before };
    case "canvas-size":
      return { type: "canvas-size", before: command.after, after: command.before };
    case "padding":
      return { type: "padding", before: command.after, after: command.before };
  }
}
