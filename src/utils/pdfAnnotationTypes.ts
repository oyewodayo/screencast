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

// Discriminated union kept deliberately narrow for v1. Phase 2 adds 'shape' | 'text' | 'note'
// variants here — purely additive, no migration needed as long as readers skip unknown types.
export type AnnotationObject = StrokeObject | HighlightObject;

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

export type AnnotationTool = "pen" | "highlighter" | "eraser";

// Undo/redo command stack. Each entry is reversible without needing full-document snapshots,
// since v1 only ever adds or bulk-removes whole objects (no move/resize until Phase 2).
export type AnnotationCommand =
  | { type: "add"; object: AnnotationObject }
  | { type: "erase"; pageIndex: number; removed: AnnotationObject[] };

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
