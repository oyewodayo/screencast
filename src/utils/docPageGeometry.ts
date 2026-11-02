// utils/docPageGeometry.ts
//
// Single source of truth for page dimensions, shared by DocsEditor.tsx (the live "page" card's own
// size/padding), docAutoPaginate.ts (the live-pagination math needs to measure against the exact
// same content-area width/height that's actually rendered, or its page-break points would be wrong
// relative to what the eye sees), DocRuler.tsx and docDocx.ts. Margins are per document now
// (useDocsEditStore's `margins`, null = DEFAULT_MARGINS); every helper takes them explicitly.
//
// A page is a PageFormat - paper size plus orientation - rather than a bare size, so no caller can
// compute a landscape page's geometry from its portrait dimensions by forgetting an argument.
import { DocMargins, DocOrientation, DocPageSize } from "./docTypes";

export const DEFAULT_MARGINS: DocMargins = { top: 1, right: 1, bottom: 1, left: 1 };

// Canvas strip between two sheets in the live page view (Google Docs uses about this much).
export const PAGE_GAP_PX = 14;

// Smallest text column / text block the margin handles will leave.
export const MIN_CONTENT_IN = 1;

// Portrait dimensions; pageDimensionsIn() swaps them for landscape.
export const PAGE_DIMENSIONS_IN: Record<DocPageSize, { width: number; height: number; cssSize: string }> = {
  letter: { width: 8.5, height: 11, cssSize: "letter" },
  a4: { width: 8.27, height: 11.69, cssSize: "a4" },
  legal: { width: 8.5, height: 14, cssSize: "legal" },
};

export interface PageFormat {
  size: DocPageSize;
  orientation: DocOrientation;
}

export const DEFAULT_PAGE: PageFormat = { size: "letter", orientation: "portrait" };

export function pageFormat(size: DocPageSize | null | undefined, orientation: DocOrientation | null | undefined): PageFormat {
  return { size: size ?? "letter", orientation: orientation ?? "portrait" };
}

// The closest page format to a page measured in PDF points (1/72 in) - PDF import. A page wider
// than it is tall is landscape; the paper is recognised from its long and short sides.
export function pageFormatForPoints(widthPt: number, heightPt: number): PageFormat {
  const long = Math.max(widthPt, heightPt);
  const short = Math.min(widthPt, heightPt);
  const size: DocPageSize = Math.abs(short - 595) < 12 && Math.abs(long - 842) < 12 ? "a4" : Math.abs(long - 1008) < 12 ? "legal" : "letter";
  return { size, orientation: widthPt > heightPt + 1 ? "landscape" : "portrait" };
}

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

// The page as laid out and printed: width and height in inches, swapped for landscape.
export function pageDimensionsIn(page: PageFormat): { width: number; height: number } {
  const { width, height } = PAGE_DIMENSIONS_IN[page.size];
  return page.orientation === "landscape" ? { width: height, height: width } : { width, height };
}

// CSS @page size, e.g. "a4 landscape".
export function cssPageSize(page: PageFormat): string {
  return `${PAGE_DIMENSIONS_IN[page.size].cssSize} ${page.orientation}`;
}

export function pageWidthPx(page: PageFormat): number {
  return inToPx(pageDimensionsIn(page).width);
}

export function pageHeightPx(page: PageFormat): number {
  return inToPx(pageDimensionsIn(page).height);
}

// The usable area within the margins - what content actually has to fit inside per page.
export function pageContentHeightPx(page: PageFormat, margins: DocMargins | null | undefined): number {
  const m = resolveMargins(margins);
  return pageHeightPx(page) - inToPx(m.top + m.bottom);
}

export function pageContentWidthPx(page: PageFormat, margins: DocMargins | null | undefined): number {
  const m = resolveMargins(margins);
  return pageWidthPx(page) - inToPx(m.left + m.right);
}

// Keeps a margin edit physically possible: 0..(page - opposite margin - MIN_CONTENT_IN).
export function clampMargin(page: PageFormat, margins: DocMargins, side: keyof DocMargins, value: number): number {
  const dims = pageDimensionsIn(page);
  const opposite = { top: margins.bottom, bottom: margins.top, left: margins.right, right: margins.left }[side];
  const extent = side === "left" || side === "right" ? dims.width : dims.height;
  return Math.max(0, Math.min(value, extent - opposite - MIN_CONTENT_IN));
}

// Margins that no longer fit after the page changed shape (e.g. turning a page with 4in side
// margins to portrait) are scaled down proportionally, the way the backend sanitizes them, so the
// page never ends up with less than MIN_CONTENT_IN of text area in either direction.
export function fitMarginsToPage(page: PageFormat, margins: DocMargins): DocMargins {
  const dims = pageDimensionsIn(page);
  const fit = (a: number, b: number, extent: number): [number, number] => {
    const max = extent - MIN_CONTENT_IN;
    return a + b > max ? [(a * max) / (a + b), (b * max) / (a + b)] : [a, b];
  };
  const [left, right] = fit(margins.left, margins.right, dims.width);
  const [top, bottom] = fit(margins.top, margins.bottom, dims.height);
  return { top, right, bottom, left };
}

// ---------------------------------------------------------------------------------------------
// Page colour

// Google Docs' page-colour palette: white, light tints, then a few deeper shades.
export const PAGE_COLORS: { label: string; value: string }[] = [
  { label: "White", value: "#ffffff" },
  { label: "Ivory", value: "#fffdf5" },
  { label: "Cream", value: "#fff8e1" },
  { label: "Light yellow", value: "#fef9c3" },
  { label: "Light orange", value: "#ffedd5" },
  { label: "Light red", value: "#fee2e2" },
  { label: "Light pink", value: "#fce7f3" },
  { label: "Light purple", value: "#ede9fe" },
  { label: "Light blue", value: "#dbeafe" },
  { label: "Light cyan", value: "#cffafe" },
  { label: "Light green", value: "#dcfce7" },
  { label: "Light grey", value: "#f3f4f6" },
  { label: "Grey", value: "#d1d5db" },
  { label: "Slate", value: "#334155" },
  { label: "Navy", value: "#1e293b" },
  { label: "Black", value: "#111111" },
];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// null for white/absent/malformed - white is the default, stored as no colour at all.
export function normalizePageColor(color: string | null | undefined): string | null {
  if (!color || !HEX_COLOR.test(color.trim())) return null;
  const c = color.trim().toLowerCase();
  return c === "#ffffff" ? null : c;
}

// Dark paper needs light text: perceived brightness below the midpoint.
export function isDarkPageColor(color: string | null | undefined): boolean {
  const c = normalizePageColor(color);
  if (!c) return false;
  const n = parseInt(c.slice(1), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128;
}
