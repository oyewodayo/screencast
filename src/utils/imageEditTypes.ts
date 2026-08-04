// utils/imageEditTypes.ts
//
// The standalone image editor's object model. Deliberately parallels pdfAnnotationTypes.ts's
// shape (discriminated union of objects + a document + an undo/redo command type), but in plain
// canvas-pixel space - there's no PDF viewport/page-space conversion to do here, every coordinate
// below is already in the working canvas's own natural (unzoomed) pixel space.

// Carries pressure (as perfect-freehand's getStroke expects - see imageEditHandlers.ts's
// strokeToOutline) even though most pointer devices are a plain mouse (pressure fixed at 0.5,
// same convention pdfAnnotationTypes.ts's Pt uses for the same reason).
export interface Pt {
  x: number;
  y: number;
  pressure: number;
}

interface BaseObject {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export interface StrokeObject extends BaseObject {
  type: "stroke";
  color: string;
  width: number;
  opacity: number;
  points: Pt[];
}

export interface HighlightObject extends BaseObject {
  type: "highlight";
  color: string;
  width: number;
  opacity: number;
  points: Pt[];
  blend?: "multiply";
}

export interface ArrowObject extends BaseObject {
  type: "arrow";
  color: string;
  width: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// Rect/ellipse share the same top-left+size box shape (and therefore the same move/resize math)
// - only their renderer differs.
export interface RectObject extends BaseObject {
  type: "rect";
  color: string;
  width: number;
  x: number;
  y: number;
  w: number;
  h: number;
  filled: boolean;
}

export interface EllipseObject extends BaseObject {
  type: "ellipse";
  color: string;
  width: number;
  x: number;
  y: number;
  w: number;
  h: number;
  filled: boolean;
}

// Single-line label - no PDF-TextObject-style wrapping/rich formatting (bold/italic/colorRuns).
// Screenshot annotations ("①", "click here") are short; multi-line rich text isn't worth the
// added complexity for this editor.
export interface TextObject extends BaseObject {
  type: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
}

// A rectangular region of the *base* photo (post-adjustments, pre-other-annotations - see
// renderComposedCanvas's draw-order comment in imageEditHandlers.ts) redrawn blurred - the
// privacy/redaction tool.
export interface BlurRegionObject extends BaseObject {
  type: "blur";
  x: number;
  y: number;
  w: number;
  h: number;
  blurRadius: number;
}

// Another image placed on top of the working canvas - the "join/collage" building block: insert
// a second (third, ...) photo, then move/resize/rotate it into place freeform, the same way
// PDF annotations let you insert and arrange an image on a page (pdfAnnotationTypes.ts's
// ImageObject - this mirrors its shape exactly). `src` is a base64 data URL embedded directly in
// this document (same as PDF's ImageObject.src), not a filesystem path, so the doc/sidecar stays
// fully self-contained. Stored top-left anchored *before* rotation (matches TextObject/RectObject's
// convention); rotation is applied around the box's center at render time, so x/y/width/height
// never change just because the object is rotated - only the move/resize chrome
// (ImageAnnotationEditor.tsx, reused as-is from the PDF annotator) touches those directly.
export interface PlacedImageObject extends BaseObject {
  type: "placed-image";
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // radians
}

export type ImageAnnotationObject =
  | StrokeObject
  | HighlightObject
  | ArrowObject
  | RectObject
  | EllipseObject
  | TextObject
  | BlurRegionObject
  | PlacedImageObject;

export type ImageEditTool = "select" | "pen" | "highlighter" | "arrow" | "rect" | "ellipse" | "text" | "blur" | "crop";

// Neutral = 1 for every field, matching the CSS filter functions they map to 1:1
// (brightness()/contrast()/saturate()) - see imageEditHandlers.ts's cssFilterForAdjustments.
export interface ImageAdjustments {
  brightness: number;
  contrast: number;
  saturation: number;
}

export const NEUTRAL_ADJUSTMENTS: ImageAdjustments = { brightness: 1, contrast: 1, saturation: 1 };

export const ANNOTATION_SCHEMA_VERSION = 1 as const;

// A geometry op (crop/rotate/flip) rasterizes the *entire* current composition - base image,
// adjustments, and every annotation object so far - into a new base bitmap, then clears the
// objects list and resets adjustments to neutral (they're now baked into the new base's pixels).
// See imageEditHandlers.ts's rasterizeGeometry and this file's own module doc comment for why
// vector annotation coordinates are never transformed through a rotation/crop instead.
export interface GeometrySnapshot {
  baseImageOverride: string;
  baseWidth: number;
  baseHeight: number;
  adjustments: ImageAdjustments;
  objects: ImageAnnotationObject[];
}

// Undo/redo command stack. 'edit' covers both move and resize (and text content edits) - both are
// just "replace this object with a new version of itself with different fields", same as
// pdfAnnotationTypes.ts's 'edit' command for retyped text notes.
export type ImageEditCommand =
  | { type: "add"; object: ImageAnnotationObject }
  | { type: "delete"; object: ImageAnnotationObject }
  | { type: "edit"; before: ImageAnnotationObject; after: ImageAnnotationObject }
  // Multiple objects replaced at once as a single undo step - e.g. "Arrange as grid" repositioning
  // every placed image in one action. Same before/after-pair shape as 'edit', just over an array;
  // unlike 'geometry' this only ever touches the listed objects; everything else in the document
  // (including any *other* objects not part of the arrangement) is untouched.
  | { type: "batch-edit"; before: ImageAnnotationObject[]; after: ImageAnnotationObject[] }
  // The whole objects array reordered (drag-to-reorder in the collage docker's thumbnail strip) -
  // stores the full before/after array rather than a single moved id, since that's the simplest
  // representation that's still trivially invertible (swap before/after) and array order *is* the
  // document's only concept of stacking/z-order.
  | { type: "reorder"; before: ImageAnnotationObject[]; after: ImageAnnotationObject[] }
  | { type: "geometry"; before: GeometrySnapshot; after: GeometrySnapshot }
  | { type: "adjustments"; before: ImageAdjustments; after: ImageAdjustments };

export interface ImageEditDocument {
  version: typeof ANNOTATION_SCHEMA_VERSION;
  // Data URL of the current working bitmap - undefined until the first geometry op runs, in which
  // case the editor renders straight from the source file on disk instead (so simply opening an
  // image to add a couple of annotations never has to base64-encode the whole photo).
  baseImageOverride?: string;
  baseWidth: number;
  baseHeight: number;
  adjustments: ImageAdjustments;
  objects: ImageAnnotationObject[];
  createdAt: string;
  updatedAt: string;
}

export function createEmptyDocument(baseWidth: number, baseHeight: number): ImageEditDocument {
  const now = new Date().toISOString();
  return {
    version: ANNOTATION_SCHEMA_VERSION,
    baseWidth,
    baseHeight,
    adjustments: { ...NEUTRAL_ADJUSTMENTS },
    objects: [],
    createdAt: now,
    updatedAt: now,
  };
}
