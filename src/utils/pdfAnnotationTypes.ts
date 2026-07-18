// utils/pdfAnnotationTypes.ts

export const ANNOTATION_SCHEMA_VERSION = 1 as const;

// Points are stored in PDF page-space (unscaled, unrotated, scale: 1) so ink stays
// pixel-aligned with page content across zoom/pan/resize/DPI. Device-pixel conversion
// happens only at render/capture time via pdf.js's viewport.convertTo*Point helpers.
export interface Pt {
  x: number;
  y: number;
  pressure: number;
}

interface BaseObject {
  id: string;
  pageIndex: number;
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

// A jotted note: a fixed-width, word-wrapped text block anchored at its top-left corner.
// `x`/`y` and `width` are PDF page-space units (zoom-independent), matching Pt's convention —
// `y` is the TOP edge, and since PDF space is y-up while screen space is y-down, the block
// occupies [y - height, y] in PDF-space (see pdfAnnotationHandlers.ts's rendering/hit-testing).
// `height` is measured once at commit time (via measureTextBlock) from the actual wrapped line
// count, rather than re-derived ad hoc wherever it's needed — keeps rendering and hit-testing
// (click-to-edit, eraser) reading from a single source of truth instead of two slightly
// different wrap calculations drifting apart.
export interface TextObject extends BaseObject {
  type: "text";
  text: string;
  color: string;
  fontSize: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Discriminated union. Phase 2 still has room for 'shape'/'note' (sticky-note) variants beyond
// this — purely additive, no migration needed as long as readers skip unknown types.
export type AnnotationObject = StrokeObject | HighlightObject | TextObject;

export interface PdfAnnotationPage {
  pageIndex: number;
  objects: AnnotationObject[];
}

export interface PdfAnnotationDocument {
  version: typeof ANNOTATION_SCHEMA_VERSION;
  sourceFileName: string;
  pages: PdfAnnotationPage[];
  createdAt: string;
  updatedAt: string;
}

export type AnnotationTool = "pen" | "highlighter" | "eraser" | "text";

// Undo/redo command stack. Each entry is reversible without needing full-document snapshots.
// 'edit' covers in-place text edits (retyping an existing note) — everything else only ever
// adds or bulk-removes whole objects.
export type AnnotationCommand =
  | { type: "add"; object: AnnotationObject }
  | { type: "erase"; pageIndex: number; removed: AnnotationObject[] }
  | { type: "edit"; pageIndex: number; before: AnnotationObject; after: AnnotationObject };

export function createEmptyDocument(sourceFileName: string): PdfAnnotationDocument {
  const now = new Date().toISOString();
  return {
    version: ANNOTATION_SCHEMA_VERSION,
    sourceFileName,
    pages: [],
    createdAt: now,
    updatedAt: now,
  };
}
