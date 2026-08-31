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

// Border-box model: x/y/width/height describe the *outer* edge of the image's frame (background +
// border), pre-rotation - rotation is applied around the box's own center at render time, same
// convention imageEditTypes.ts's PlacedImageObject uses for the same reason (move/resize math
// never has to account for rotation). The actual photo is drawn inset from this box by
// `borderWidth + padding` on every side.
export interface BoardImage {
  id: string;
  // Filename only, relative to this board's own Boards/<boardId>/assets/ folder - never an
  // absolute path or the original source file's path. Images are copied in at import time (see
  // import_board_image) so the board keeps working even if the source is later moved, renamed, or
  // deleted elsewhere in the user's library.
  assetFileName: string;
  naturalWidth: number;
  naturalHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // radians, around the box's own center
  // Gap between the border and the photo itself - the background color shows through here.
  padding: number;
  borderWidth: number;
  borderColor: string;
  cornerRadius: number;
  backgroundColor: string;
  opacity: number;
  shadow?: BoardShadow;
  createdAt: number;
  updatedAt: number;
}

// Which of the three background renderers is active - see boardHandlers.ts's renderBoardToCanvas
// for how each one actually paints. Old boards saved before this existed simply lack the field on
// disk; every reader treats an absent backgroundMode as "color", so those boards keep rendering
// exactly as they did before this feature - no migration step needed.
export type BoardBackgroundMode = "color" | "grid" | "image";

export interface BoardGridBackground {
  spacing: number; // px between lines, in the board's own (unscaled) document space
  lineColor: string;
  // Fill color under the grid lines - same "null = transparent" convention as BoardDocument's own
  // backgroundColor, so a grid can sit on a transparent board (visible in an exported PNG's alpha)
  // exactly like a plain color background can.
  baseColor: string | null;
}

export type BoardCommand =
  | { type: "add"; image: BoardImage }
  | { type: "delete"; image: BoardImage }
  | { type: "edit"; before: BoardImage; after: BoardImage }
  // Multiple images replaced at once as a single undo step - multi-selection drag, "Arrange in a
  // row" - same before/after-pair shape as 'edit', just over an array. Matched by id.
  | { type: "batch-edit"; before: BoardImage[]; after: BoardImage[] }
  // Full replacement order for the whole images array - order is the document's only concept of
  // z-order/stacking (last = topmost), same convention imageEditTypes.ts's objects array uses.
  | { type: "reorder"; before: BoardImage[]; after: BoardImage[] }
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
  // Blank margin (px) added around the *outside* of canvasWidth/canvasHeight at render/export
  // time - a mat/frame border around the whole composed board, like a photo frame. Purely a
  // rendering-time inset: no BoardImage's x/y ever changes because of it, which is what makes it
  // safe to update live (see boardHandlers.ts's paddedCanvasSize) with no re-arrange step needed,
  // unlike the old per-arrangement gridline gap this replaced conceptually but not in code.
  padding: number;
  images: BoardImage[]; // array order = z-order, last = topmost
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
