// utils/docPageGeometry.ts
//
// Single source of truth for page dimensions, shared by DocsEditor.tsx (the live "page" card's own
// size/padding), docAutoPaginate.ts (the live-pagination math needs to measure against the exact
// same content-area width/height that's actually rendered, or its page-break points would be wrong
// relative to what the eye sees), DocRuler.tsx and docDocx.ts. Margins are per document now
// (useDocsEditStore's `margins`, null = DEFAULT_MARGINS); every helper takes them explicitly.
import { DocMargins, DocPageSize } from "./docTypes";

export const DEFAULT_MARGINS: DocMargins = { top: 1, right: 1, bottom: 1, left: 1 };

// Canvas strip between two sheets in the live page view (Google Docs uses about this much).
export const PAGE_GAP_PX = 14;

// Smallest text column / text block the margin handles will leave.
export const MIN_CONTENT_IN = 1;

export const PAGE_DIMENSIONS_IN: Record<DocPageSize, { width: number; height: number; cssSize: string }> = {
  letter: { width: 8.5, height: 11, cssSize: "letter" },
  a4: { width: 8.27, height: 11.69, cssSize: "a4" },
  legal: { width: 8.5, height: 14, cssSize: "legal" },
};

// The CSS "reference pixel" definition (CSS Values spec) - 1in always resolves to exactly 96 CSS
// px in getBoundingClientRect()/offsetHeight/etc, independent of the browser's page-zoom level
// (zoom scales how CSS pixels map to physical screen pixels, not the CSS pixel values JS measures),
// so this is safe to hardcode rather than measure at runtime.
export const PX_PER_IN = 96;

export function inToPx(inches: number): number {
  return inches * PX_PER_IN;
}

export function resolveMargins(margins: DocMargins | null | undefined): DocMargins {
  return margins ?? DEFAULT_MARGINS;
}

export function pageWidthPx(size: DocPageSize): number {
  return inToPx(PAGE_DIMENSIONS_IN[size].width);
}

export function pageHeightPx(size: DocPageSize): number {
  return inToPx(PAGE_DIMENSIONS_IN[size].height);
}

// The usable area within the margins - what content actually has to fit inside per page.
export function pageContentHeightPx(size: DocPageSize, margins: DocMargins | null | undefined): number {
  const m = resolveMargins(margins);
  return pageHeightPx(size) - inToPx(m.top + m.bottom);
}

export function pageContentWidthPx(size: DocPageSize, margins: DocMargins | null | undefined): number {
  const m = resolveMargins(margins);
  return pageWidthPx(size) - inToPx(m.left + m.right);
}

// Keeps a margin edit physically possible: 0..(page - opposite margin - MIN_CONTENT_IN).
export function clampMargin(size: DocPageSize, margins: DocMargins, side: keyof DocMargins, value: number): number {
  const page = PAGE_DIMENSIONS_IN[size];
  const opposite = { top: margins.bottom, bottom: margins.top, left: margins.right, right: margins.left }[side];
  const extent = side === "left" || side === "right" ? page.width : page.height;
  return Math.max(0, Math.min(value, extent - opposite - MIN_CONTENT_IN));
}
