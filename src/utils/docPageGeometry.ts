// utils/docPageGeometry.ts
//
// Single source of truth for page dimensions, shared by DocsEditor.tsx (the live "page" card's own
// size/padding) and docAutoPaginate.ts (the live-pagination math needs to measure against the exact
// same content-area width/height that's actually rendered, or its page-break points would be wrong
// relative to what the eye sees). Previously these lived as local consts directly in DocsEditor.tsx.
import { DocPageSize } from "./docTypes";

export const PAGE_MARGIN_IN = 1;

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

export function marginPx(): number {
  return inToPx(PAGE_MARGIN_IN);
}

export function pageWidthPx(size: DocPageSize): number {
  return inToPx(PAGE_DIMENSIONS_IN[size].width);
}

export function pageHeightPx(size: DocPageSize): number {
  return inToPx(PAGE_DIMENSIONS_IN[size].height);
}

// The usable area within the margins - what content actually has to fit inside per page.
export function pageContentHeightPx(size: DocPageSize): number {
  return pageHeightPx(size) - 2 * marginPx();
}
