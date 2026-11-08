// hooks/usePdfTextSelection.ts
//
// Tracks the browser's native text selection *within one page's text layer* and turns it into
// something the page can act on: cleaned text, one merged box per selected line (page-local CSS
// px, for drawing), and the same boxes in PDF page-space (zoom-independent, for storing).
//
// The selection is only read once a gesture settles (pointerup, or a shift+arrow keyup) — never
// on every selectionchange mid-drag — so the action menu doesn't chase the cursor while the user
// is still dragging, and the whole getClientRects/merge pass runs once per selection rather than
// per mouse move. selectionchange is still watched, but only to *hide* the menu the moment the
// selection collapses or moves off this page.
import { RefObject, useCallback, useEffect, useState } from "react";
import type { PageViewport } from "pdfjs-dist";
import { PdfRect } from "../utils/pdfAnnotationTypes";
import { cleanSelectedPdfText } from "../handlers/pdfAnnotationHandlers";

export interface LocalRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageTextSelection {
  text: string;
  lineRects: LocalRect[];
  pdfRects: PdfRect[];
  bounds: { left: number; top: number; right: number; bottom: number };
}

// Range.getClientRects() returns one box per text-layer span (several per line, often slightly
// overlapping, plus zero-size boxes for the layer's <br>s). Folds them into one box per visual line
// by grouping boxes whose vertical centers sit within half a line of each other.
function mergeIntoLines(rects: LocalRect[]): LocalRect[] {
  const sorted = rects.filter((r) => r.width >= 1 && r.height >= 1).sort((a, b) => a.top - b.top || a.left - b.left);
  if (sorted.length === 0) return [];
  // A selection dragged past the last glyph can include a box spanning the whole layer — anything
  // far taller than a typical line isn't text and would paint a page-sized block.
  const heights = sorted.map((r) => r.height).sort((a, b) => a - b);
  const maxLineHeight = heights[Math.floor(heights.length / 2)] * 3;

  const lines: LocalRect[] = [];
  for (const r of sorted) {
    if (r.height > maxLineHeight) continue;
    const center = r.top + r.height / 2;
    const line = lines.find((l) => Math.abs(l.top + l.height / 2 - center) < Math.min(l.height, r.height) / 2);
    if (!line) {
      lines.push({ ...r });
      continue;
    }
    const right = Math.max(line.left + line.width, r.left + r.width);
    const bottom = Math.max(line.top + line.height, r.top + r.height);
    line.left = Math.min(line.left, r.left);
    line.top = Math.min(line.top, r.top);
    line.width = right - line.left;
    line.height = bottom - line.top;
  }
  return lines;
}

function readSelection(wrapper: HTMLElement, viewport: PageViewport): PageTextSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const layer = wrapper.querySelector(".pdfTextLayer");
  if (!layer || !layer.contains(range.commonAncestorContainer)) return null;

  const text = cleanSelectedPdfText(selection.toString());
  if (!text) return null;

  // Client rects are in (possibly CSS-scaled) screen space; normalize back into the wrapper's own
  // unscaled px so they line up with the viewport the canvases were rendered at.
  const origin = wrapper.getBoundingClientRect();
  const k = wrapper.offsetWidth > 0 ? origin.width / wrapper.offsetWidth : 1;
  const local = Array.from(range.getClientRects(), (r) => ({
    left: (r.left - origin.left) / k,
    top: (r.top - origin.top) / k,
    width: r.width / k,
    height: r.height / k,
  }));
  const lineRects = mergeIntoLines(local);
  if (lineRects.length === 0) return null;

  const pdfRects = lineRects.map((r) => {
    const [ax, ay] = viewport.convertToPdfPoint(r.left, r.top);
    const [bx, by] = viewport.convertToPdfPoint(r.left + r.width, r.top + r.height);
    return { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) };
  });
  const bounds = {
    left: Math.min(...lineRects.map((r) => r.left)),
    top: Math.min(...lineRects.map((r) => r.top)),
    right: Math.max(...lineRects.map((r) => r.left + r.width)),
    bottom: Math.max(...lineRects.map((r) => r.top + r.height)),
  };
  return { text, lineRects, pdfRects, bounds };
}

export default function usePdfTextSelection(
  wrapperRef: RefObject<HTMLDivElement | null>,
  viewport: PageViewport | null,
  enabled: boolean
): [PageTextSelection | null, () => void] {
  const [selection, setSelection] = useState<PageTextSelection | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !viewport || !enabled) {
      setSelection(null);
      return;
    }

    let rafId: number | null = null;
    let dragging = false;
    const settle = (): void => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      // One frame later: a double/triple-click word/line selection is only finalized after the
      // pointerup that triggered it has finished dispatching.
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setSelection(readSelection(wrapper, viewport));
      });
    };

    const handlePointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Element && e.target.closest("[data-annotation-editor]")) return;
      dragging = true;
      setSelection(null);
    };
    const handlePointerUp = (): void => {
      if (!dragging) return;
      dragging = false;
      settle();
    };
    const handleKeyUp = (e: KeyboardEvent): void => {
      if (e.shiftKey || e.key === "Shift" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a")) settle();
    };
    const handleSelectionChange = (): void => {
      if (dragging) return;
      const current = window.getSelection();
      if (!current || current.isCollapsed || current.rangeCount === 0 || !wrapper.contains(current.getRangeAt(0).commonAncestorContainer)) {
        setSelection((prev) => (prev ? null : prev));
      }
    };

    wrapper.addEventListener("pointerdown", handlePointerDown);
    // On window, not the wrapper: a drag that started on this page commonly ends outside it.
    window.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("keyup", handleKeyUp);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      wrapper.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("keyup", handleKeyUp);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [wrapperRef, viewport, enabled]);

  const clear = useCallback((): void => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, []);

  return [selection, clear];
}
