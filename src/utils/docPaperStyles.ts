// utils/docPaperStyles.ts
//
// Ready-made document styles (DocStyleDialog.tsx): one click sets the page, columns, body text,
// caption naming and citation style of a common kind of document, the way choosing a LaTeX
// document class does. Every value stays adjustable afterwards.
import type { CitationStyleId } from "./docBibliography";
import type { DocBodyStyle } from "./docLayout";
import { DEFAULT_NUMBERING, type NumberingStyle } from "./docNumbering";
import type { DocMargins } from "./docTypes";

export const LATIN_MODERN_STACK = `"Latin Modern Roman", KaTeX_Main, Georgia, serif`;

export interface PaperStyle {
  id: "standard" | "article" | "journal";
  name: string;
  description: string;
  columns: 1 | 2;
  columnGap: number; // in
  margins: DocMargins | null; // null = the 1in default
  body: DocBodyStyle | null; // null = the editor's own defaults
  numbering: NumberingStyle;
  citationStyle: CitationStyleId;
}

// The numbering conventions offered for captions and cross-references.
export const CAPTION_STYLES: { id: string; name: string; example: string; numbering: NumberingStyle }[] = [
  { id: "docs", name: "Docs / Word", example: "Figure 1. · Table 1.", numbering: DEFAULT_NUMBERING },
  {
    id: "aps",
    name: "APS / RevTeX",
    example: "FIG. 1. · TABLE I.",
    numbering: {
      figure: { caption: "FIG.", ref: "Fig.", numerals: "arabic" },
      table: { caption: "TABLE", ref: "Table", numerals: "upper-roman" },
      equation: { ref: "Eq." },
      captionSeparator: ".",
      boldCaptionLabel: false,
      chapterLevel: null,
    },
  },
  {
    id: "ieee",
    name: "IEEE",
    example: "Fig. 1. · TABLE I",
    numbering: {
      figure: { caption: "Fig.", ref: "Fig.", numerals: "arabic" },
      table: { caption: "TABLE", ref: "Table", numerals: "upper-roman" },
      equation: { ref: "Eq." },
      captionSeparator: ".",
      boldCaptionLabel: false,
      chapterLevel: null,
    },
  },
  {
    id: "article",
    name: "LaTeX article",
    example: "Figure 1: · Table 1:",
    numbering: {
      figure: { caption: "Figure", ref: "Figure", numerals: "arabic" },
      table: { caption: "Table", ref: "Table", numerals: "arabic" },
      equation: { ref: "Eq." },
      captionSeparator: ":",
      boldCaptionLabel: false,
      chapterLevel: null,
    },
  },
];

export function captionStyleId(n: NumberingStyle): string | null {
  // Chapter numbering is its own choice (Document style), not part of a caption style.
  const same = (a: NumberingStyle, b: NumberingStyle) => JSON.stringify({ ...a, chapterLevel: null }) === JSON.stringify({ ...b, chapterLevel: null });
  return CAPTION_STYLES.find((c) => same(c.numbering, n))?.id ?? null;
}

export const PAPER_STYLES: PaperStyle[] = [
  {
    id: "standard",
    name: "Standard",
    description: "Docs' own style: one column, Arial-like text, space between paragraphs.",
    columns: 1,
    columnGap: 0.25,
    margins: null,
    body: null,
    numbering: DEFAULT_NUMBERING,
    citationStyle: "nature",
  },
  {
    id: "article",
    name: "Article",
    description: "A LaTeX article: one column of 11pt Latin Modern, indented paragraphs, justified.",
    columns: 1,
    columnGap: 0.25,
    margins: { top: 1, right: 1.25, bottom: 1, left: 1.25 },
    body: { fontFamily: LATIN_MODERN_STACK, fontSize: 11, lineHeight: 1.2, blockSpacing: 0, paragraphIndent: 15, color: null, justify: true, hyphenate: true },
    numbering: CAPTION_STYLES[3].numbering,
    citationStyle: "ieee",
  },
  {
    id: "journal",
    name: "Journal, two columns",
    description: "A Physical Review-style paper: two columns of 10pt Latin Modern, APS captions and references.",
    columns: 2,
    columnGap: 0.25,
    margins: { top: 0.75, right: 0.7, bottom: 0.9, left: 0.7 },
    body: { fontFamily: LATIN_MODERN_STACK, fontSize: 10, lineHeight: 1.15, blockSpacing: 0, paragraphIndent: 10, color: null, justify: true, hyphenate: true },
    numbering: CAPTION_STYLES[1].numbering,
    citationStyle: "aps",
  },
];
