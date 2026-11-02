// utils/pdfImport/model.ts
//
// The importer's intermediate document model: what the layout analysis found on the pages, in
// reading order, before it becomes ProseMirror content. Kept separate from both the PDF side and
// the editor side so each stage can be tested on its own.
import type { Glyph } from "./glyphs";
import type { Box } from "./ink";

export type Span = "L" | "R" | "F"; // left column, right column, full width

export interface RegionRef extends Box {
  page: number; // 1-based
}

// A typeset line ready for paragraph assembly: glyphs in order, with its geometry and column.
export interface FlowLine {
  page: number;
  span: Span;
  glyphs: Glyph[];
  x0: number;
  x1: number;
  base: number;
  size: number;
  top: number;
  bottom: number;
  colX0: number; // the column (or text block) this line sits in
  colX1: number;
}

export interface EquationBlock {
  kind: "equation";
  page: number;
  span: Span;
  glyphs: Glyph[];
  bars: { x0: number; x1: number; y: number; thickness: number }[];
  number: string | null; // "(12)" -> "12"
  region: RegionRef; // for the exact-crop fallback
  colX0: number;
  colX1: number;
  y0: number;
  y1: number;
  // A row of an aligned stack (layout.ts): already exactly one equation, never merged with others.
  stacked?: boolean;
}

export interface FigureBlock {
  kind: "figure";
  page: number;
  span: Span;
  region: RegionRef;
  y0: number;
  y1: number;
}

export interface TableCellModel {
  glyphs: Glyph[];
  x0: number;
  x1: number;
  colStart: number;
  colEnd: number; // exclusive; > colStart + 1 for spanning cells
}

export interface TableBlock {
  kind: "table";
  page: number;
  span: Span;
  rows: TableCellModel[][];
  columns: { x0: number; x1: number; align: "left" | "center" | "right" }[];
  headerRows: number;
  rules: { y: number; thickness: number; double: boolean }[];
  region: RegionRef;
  y0: number;
  y1: number;
}

export interface LineBlock {
  kind: "line";
  line: FlowLine;
  y0: number;
  y1: number;
  span: Span;
  page: number;
}

// One entry of a contents-style list (table of contents, list of figures/tables): a label
// ("4.1"), text that may wrap with a hanging indent, dot leaders and a page number at the margin.
export interface TocEntryElement {
  kind: "tocEntry";
  page: number;
  span: Span;
  label: string;
  lines: FlowLine[]; // the entry's text only: label, leaders and page number taken out
  pageRef: string; // the page number as printed ("29", "iv")
  indent: number; // pt from the column's left edge to the label
  textIndent: number; // pt from the label to the text (the hanging indent)
  y0: number;
  y1: number;
}

export type PageElement = LineBlock | EquationBlock | FigureBlock | TableBlock | TocEntryElement;

// ---------------------------------------------------------------------------------------------
// Output blocks (after paragraph assembly)

export type InlinePiece =
  | { kind: "text"; glyphs: Glyph[] }
  | { kind: "math"; glyphs: Glyph[] }
  | { kind: "break" };

export interface ParagraphStyle {
  align: "left" | "center" | "right" | "justify";
  indentFirst: number; // pt (negative = hanging)
  indentLeft: number; // pt
  indentRight: number; // pt
  spaceBefore: number; // pt
  size: number; // dominant size, pt
  leading: number; // baseline-to-baseline, pt
}

export type DocBlock =
  // breaks: indices of lines after which the heading breaks its line ("CHAPTER 2" / "LITERATURE REVIEW").
  | { kind: "heading"; level: 1 | 2 | 3 | 4; lines: FlowLine[]; style: ParagraphStyle; span: Span; breaks?: number[] }
  | { kind: "paragraph"; lines: FlowLine[]; style: ParagraphStyle; span: Span; role: "body" | "abstract" | "footnote" | "front" }
  | { kind: "caption"; captionKind: "figure" | "table"; prefix: string; numbering: "arabic" | "roman"; number: string; separator: string; lines: FlowLine[]; style: ParagraphStyle; span: Span; labelGlyphCount: number }
  | { kind: "equation"; block: EquationBlock; spaceBefore: number }
  | { kind: "figure"; block: FigureBlock; spaceBefore: number }
  | { kind: "table"; block: TableBlock; spaceBefore: number }
  | { kind: "references"; entries: { label: string; lines: FlowLine[] }[]; style: ParagraphStyle; span: Span }
  | { kind: "toc"; entries: TocEntryElement[]; span: Span };

export interface PageGeometry {
  width: number;
  height: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  columns: 1 | 2;
  gutter: number; // pt between columns
}
