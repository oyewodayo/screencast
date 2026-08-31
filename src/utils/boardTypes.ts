// utils/boardTypes.ts
//
// The Board feature's own object model - a workspace for arranging several images into one
// composed layout (padding/border/margin/corner-radius per image), independent of the single-
// image editor's model (imageEditTypes.ts's ImageAnnotationObject/PlacedImageObject). No shared
// unions with that file on purpose: a board image needs its own on-disk asset reference (see
// BoardImage.assetFileName) and its own style fields that don't map onto anything the image
// editor's placed-image object has.

export interface BoardShadow {
  blur: number;
  offsetX: number;
  offsetY: number;
  color: string;
}

// Fields every board item - image or text - shares: geometry (the same border-box model
// imageEditTypes.ts's PlacedImageObject uses - x/y/width/height describe the outer edge
// pre-rotation, rotation applied around the box's own center at render time, so move/resize math
// never has to account for rotation), stacking-independent style (opacity), and bookkeeping.
// boardHandlers.ts's geometry helpers (applyMove/applyResize/applyRotate/hitTestBoardItem/
// resizeHandlePoints/rotateHandlePoint) are written generically against exactly this shape, which
// is what lets a text item get full move/resize/rotate/select parity with an image for free.
interface BoardItemBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // radians, around the box's own center
  opacity: number;
  // Absent/false on every item created before this existed, same "missing = off" convention as
  // BoardDocument.backgroundMode. A locked item can't be hit-tested (clicked, marquee-enclosed) on
  // the canvas - see boardHandlers.ts's hitTestBoardItem and BoardCanvas.tsx's marquee filter - so
  // it can't be accidentally dragged/resized/rotated; it's still fully manageable (select, unlock,
  // reorder, delete) from BoardLayerPanel, which selects by id rather than by hit-testing.
  locked?: boolean;
  createdAt: number;
  updatedAt: number;
}

// The actual photo is drawn inset from the border-box by `borderWidth + padding` on every side.
export interface BoardImage extends BoardItemBase {
  kind: "image";
  // Filename only, relative to this board's own Boards/<boardId>/assets/ folder - never an
  // absolute path or the original source file's path. Images are copied in at import time (see
  // import_board_image) so the board keeps working even if the source is later moved, renamed, or
  // deleted elsewhere in the user's library.
  assetFileName: string;
  naturalWidth: number;
  naturalHeight: number;
  // Gap between the border and the photo itself - the background color shows through here.
  padding: number;
  borderWidth: number;
  borderColor: string;
  cornerRadius: number;
  backgroundColor: string;
  shadow?: BoardShadow;
}

// A free-floating text box - the Board feature's second item kind alongside BoardImage (see
// BoardItem below). Deliberately edited through BoardStylePanel's own text section rather than an
// in-canvas contentEditable overlay: the whole board is one <canvas> element, not per-item DOM
// nodes, so there's nothing to make contentEditable without building a second, rotation-aware
// overlay system - the side panel already IS this app's one property-editing surface for every
// other per-item field (image padding/border/corner radius included), so text content joins it
// instead of inventing a second interaction model just for itself.
export interface BoardText extends BoardItemBase {
  kind: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: "normal" | "bold";
  fontStyle: "normal" | "italic";
  textAlign: "left" | "center" | "right";
  color: string;
  // Fill behind the text, inset by `padding` from the text itself - null = no box, just the text
  // floating directly on whatever's behind it. Same "null = transparent" convention as
  // BoardDocument.backgroundColor/BoardGridBackground.baseColor.
  backgroundColor: string | null;
  cornerRadius: number; // rounds the background box, when backgroundColor isn't null
  padding: number;
}

// A free-floating blur region - the Board feature's third item kind, for obscuring something in a
// photo underneath (a face, a license plate, whatever) without editing the photo itself. Unlike
// BoardImage/BoardText, this kind draws nothing of its own - boardHandlers.ts's renderBoardBlur
// instead re-samples whatever's already been composited beneath it (in z-order) through a blurred,
// clipped copy of the canvas so far. `shape` controls the clip outline (a plain rect, a rounded
// rect using `cornerRadius`, or an ellipse inscribed in the box) - independent of `strength`, the
// blur radius in doc-space px, which is what BoardStylePanel's "Blur" section actually calls
// strength.
export interface BoardBlur extends BoardItemBase {
  kind: "blur";
  shape: "rect" | "rounded" | "ellipse";
  cornerRadius: number; // only used when shape is "rounded"
  // Blurred (soft, still somewhat legible at low strength) or pixelated (hard mosaic blocks, the
  // "redacted" look) - two different renderers in boardHandlers.ts's renderBoardBlur sharing this
  // one item kind since everything else about them (shape, opacity, geometry) is identical. Absent
  // on a blur item created before this existed - resolves to "blur", its original/only behavior.
  mode?: "blur" | "pixelate";
  // Meaning depends on `mode`: blur radius in doc-space px when "blur" (the original behavior),
  // or mosaic block size in doc-space px when "pixelate" - one field rather than two so switching
  // modes keeps whatever intensity was already dialed in instead of resetting it.
  strength: number;
}

export type BoardItem = BoardImage | BoardText | BoardBlur;

// Which of the four background renderers is active - see boardHandlers.ts's renderBoardToCanvas
// for how each one actually paints. Old boards saved before "grid"/"image"/"gradient" existed
// simply lack the field on disk; every reader treats an absent backgroundMode as "color", so those
// boards keep rendering exactly as they did before this feature - no migration step needed.
export type BoardBackgroundMode = "color" | "grid" | "image" | "gradient";

export interface BoardGridBackground {
  spacing: number; // px between lines, in the board's own (unscaled) document space
  lineColor: string;
  // Fill color under the grid lines - same "null = transparent" convention as BoardDocument's own
  // backgroundColor, so a grid can sit on a transparent board (visible in an exported PNG's alpha)
  // exactly like a plain color background can.
  baseColor: string | null;
}

export interface BoardGradientBackground {
  from: string;
  to: string;
  angleDeg: number; // 0 = left-to-right, 90 = top-to-bottom, matching CSS linear-gradient's own angle direction
}

export type BoardCommand =
  | { type: "add"; item: BoardItem }
  | { type: "delete"; item: BoardItem }
  | { type: "edit"; before: BoardItem; after: BoardItem }
  // Multiple items replaced at once as a single undo step - multi-selection drag, "Arrange in a
  // row" (images only - see BoardEditor.tsx's handleArrange). Same before/after-pair shape as
  // 'edit', just over an array. Matched by id.
  | { type: "batch-edit"; before: BoardItem[]; after: BoardItem[] }
  // Several items added/removed at once as ONE undo step - "Duplicate" on a multi-selection, and
  // bulk delete (see BoardEditor.tsx's handleDuplicateSelected/handleDeleteSelected). Kept distinct
  // from plain 'add'/'delete' (rather than dispatching one of those per item) specifically so
  // undoing a 5-item duplicate or delete takes one Ctrl+Z, not five.
  | { type: "add-batch"; items: BoardItem[] }
  | { type: "delete-batch"; items: BoardItem[] }
  // Full replacement order for the whole images array - order is the document's only concept of
  // z-order/stacking (last = topmost), same convention imageEditTypes.ts's objects array uses.
  | { type: "reorder"; before: BoardItem[]; after: BoardItem[] }
  // `null` = no fill, the canvas stays transparent there (visible in the exported PNG's alpha).
  // Only actually painted when backgroundMode is "color" (or absent, for an old board) - see
  // BoardBackgroundMode above - but kept as its own field/command rather than folded into a
  // discriminated union so switching *to* grid/image and back to color never loses whatever color
  // was last chosen.
  | { type: "background"; before: string | null; after: string | null }
  | { type: "background-mode"; before: BoardBackgroundMode; after: BoardBackgroundMode }
  | { type: "background-grid"; before: BoardGridBackground; after: BoardGridBackground }
  // Asset filename (this board's own assets/ folder, same convention as BoardImage.assetFileName)
  // or null for "no image chosen yet" - only actually painted when backgroundMode is "image".
  | { type: "background-image"; before: string | null; after: string | null }
  | { type: "background-gradient"; before: BoardGradientBackground; after: BoardGradientBackground }
  | { type: "canvas-size"; before: { width: number; height: number }; after: { width: number; height: number } }
  | { type: "padding"; before: number; after: number };

export const BOARD_SCHEMA_VERSION = 1 as const;

export interface BoardDocument {
  version: typeof BOARD_SCHEMA_VERSION;
  id: string;
  name: string;
  canvasWidth: number;
  canvasHeight: number;
  // `null` = transparent - see renderBoardToCanvas (boardHandlers.ts), which simply skips the
  // background fill in that case rather than treating null as "some particular color." Only
  // actually painted while backgroundMode below is "color" (or absent).
  backgroundColor: string | null;
  // All three optional/absent on an old board (or a new one that's never touched the background
  // mode picker) - see BoardBackgroundMode's own doc comment for why absent always means "color."
  backgroundMode?: BoardBackgroundMode;
  backgroundGrid?: BoardGridBackground;
  backgroundImage?: string | null;
  backgroundGradient?: BoardGradientBackground;
  // Blank margin (px) added around the *outside* of canvasWidth/canvasHeight at render/export
  // time - a mat/frame border around the whole composed board, like a photo frame. Purely a
  // rendering-time inset: no BoardImage's x/y ever changes because of it, which is what makes it
  // safe to update live (see boardHandlers.ts's paddedCanvasSize) with no re-arrange step needed,
  // unlike the old per-arrangement gridline gap this replaced conceptually but not in code.
  padding: number;
  // array order = z-order, last = topmost. Still named "images" despite now holding BoardText
  // items too - kept for on-disk compatibility (renaming the JSON key would silently orphan every
  // image already saved on an existing board) rather than for accuracy; every reader/writer in
  // this codebase treats it as BoardItem[]. An entry with no `kind` field at all is an image saved
  // before BoardText existed - see useBoardStore.ts's load effect for where that gets normalized.
  images: BoardItem[];
  createdAt: string;
  updatedAt: string;
}

// Frontend mirror of boards.rs's BoardSummary - snake_case to match the Rust struct's serde
// output exactly (same convention this codebase already uses for other Rust-returned DTOs).
export interface BoardSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  thumbnail_path: string | null;
}

export const DEFAULT_BOARD_WIDTH = 1600;
export const DEFAULT_BOARD_HEIGHT = 1000;

// Largest either side of a freshly-imported image starts at - keeps several images imported in a
// row from immediately overlapping edge-to-edge, without forcing the user to resize each one
// before they can see the board at a glance.
const DEFAULT_IMAGE_MAX_DIMENSION = 360;

export function createEmptyBoardDocument(id: string, name: string): BoardDocument {
  const now = new Date().toISOString();
  return {
    version: BOARD_SCHEMA_VERSION,
    id,
    name,
    canvasWidth: DEFAULT_BOARD_WIDTH,
    canvasHeight: DEFAULT_BOARD_HEIGHT,
    backgroundColor: "#f5f5f5",
    padding: 0,
    images: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefaultBoardImage(
  id: string,
  assetFileName: string,
  naturalWidth: number,
  naturalHeight: number,
  x: number,
  y: number
): BoardImage {
  const longestSide = Math.max(naturalWidth, naturalHeight, 1);
  const scale = Math.min(1, DEFAULT_IMAGE_MAX_DIMENSION / longestSide);
  const now = Date.now();
  return {
    kind: "image",
    id,
    assetFileName,
    naturalWidth,
    naturalHeight,
    x,
    y,
    width: Math.round(naturalWidth * scale),
    height: Math.round(naturalHeight * scale),
    rotation: 0,
    padding: 0,
    borderWidth: 0,
    borderColor: "#000000",
    cornerRadius: 0,
    backgroundColor: "#ffffff",
    opacity: 1,
    createdAt: now,
    updatedAt: now,
  };
}

const DEFAULT_TEXT_WIDTH = 260;
const DEFAULT_TEXT_HEIGHT = 90;

export function createDefaultBoardText(id: string, x: number, y: number): BoardText {
  const now = Date.now();
  return {
    kind: "text",
    id,
    text: "Your text here",
    x,
    y,
    width: DEFAULT_TEXT_WIDTH,
    height: DEFAULT_TEXT_HEIGHT,
    rotation: 0,
    fontFamily: "system-ui, sans-serif",
    fontSize: 28,
    fontWeight: "normal",
    fontStyle: "normal",
    textAlign: "left",
    color: "#111111",
    backgroundColor: null,
    cornerRadius: 0,
    padding: 8,
    opacity: 1,
    createdAt: now,
    updatedAt: now,
  };
}

const DEFAULT_BLUR_SIZE = 180;

export function createDefaultBoardBlur(id: string, x: number, y: number): BoardBlur {
  const now = Date.now();
  return {
    kind: "blur",
    id,
    x,
    y,
    width: DEFAULT_BLUR_SIZE,
    height: DEFAULT_BLUR_SIZE,
    rotation: 0,
    // Ellipse by default - the common "blur out a face" case reads more naturally as a soft oval
    // than a hard-edged rectangle; either is one click away in the style panel.
    shape: "ellipse",
    mode: "blur",
    cornerRadius: 0,
    strength: 18,
    opacity: 1,
    createdAt: now,
    updatedAt: now,
  };
}
