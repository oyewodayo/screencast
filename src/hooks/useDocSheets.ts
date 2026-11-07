// hooks/useDocSheets.ts
//
// Where each sheet of a document actually is on screen, for the overlays drawn per page (header and
// footer, watermark, letterhead). Read from the page itself: each page-break gap (docAutoPaginate.ts)
// has a canvas strip between two sheets, so sheet k runs from the strip above it to the strip below.
//
// Placing sheets by arithmetic (sheet k at k * (page height + gap)) assumed every sheet is exactly
// one page tall - but a block taller than a page (a long table) overflows its sheet rather than
// splitting, and every overlay from there down landed mid-text. The two-column view draws fixed
// sheets (.doc-sheet) with no gap widgets, so arithmetic is right there and is the fallback - as it
// is for the moment a layout pass hasn't settled into one strip per break yet.
import { useLayoutEffect, useState } from "react";
import { PAGE_GAP_PX, pageHeightPx, type PageFormat } from "../utils/docPageGeometry";

export interface Sheet {
  top: number;
  bottom: number;
}

function measure(root: HTMLElement, pageCount: number): Sheet[] | null {
  const host = root.parentElement;
  if (!host || pageCount < 1) return null;
  const strips = host.querySelectorAll<HTMLElement>(".doc-page-gap-canvas");
  if (strips.length !== pageCount - 1) return null;
  const box = root.getBoundingClientRect();
  // Page zoom scales client rects but not the px the overlays are positioned in.
  const scale = box.height > 0 ? root.offsetHeight / box.height : 1;
  const edges = [...strips].map((el) => {
    const r = el.getBoundingClientRect();
    return { top: (r.top - box.top) * scale, bottom: (r.bottom - box.top) * scale };
  });
  return Array.from({ length: pageCount }, (_, k) => ({
    top: k === 0 ? 0 : edges[k - 1].bottom,
    bottom: k === pageCount - 1 ? root.offsetHeight : edges[k].top,
  }));
}

const same = (a: Sheet[] | null, b: Sheet[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((s, i) => Math.abs(s.top - b[i].top) < 0.5 && Math.abs(s.bottom - b[i].bottom) < 0.5));

// `ref` goes on the overlay's own absolutely-positioned box (inset-0 over the page card) - a callback
// ref, so an overlay that renders nothing at first (no watermark yet) is picked up once it appears.
export default function useDocSheets(pageCount: number, page: PageFormat): { sheets: Sheet[]; ref: (el: HTMLElement | null) => void } {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [measured, setMeasured] = useState<Sheet[] | null>(null);

  // Re-read whenever the page's size or its gaps change (typing, an image loading, a break moving).
  useLayoutEffect(() => {
    const host = root?.parentElement;
    if (!root || !host) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = measure(root, pageCount);
        setMeasured((prev) => (same(prev, next) ? prev : next));
      });
    };
    update();
    const resize = new ResizeObserver(update);
    resize.observe(host);
    const mutations = new MutationObserver(update);
    mutations.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [root, pageCount, page]);

  if (measured && measured.length === pageCount) return { sheets: measured, ref: setRoot };
  const height = pageHeightPx(page);
  return { sheets: Array.from({ length: pageCount }, (_, k) => ({ top: k * (height + PAGE_GAP_PX), bottom: k * (height + PAGE_GAP_PX) + height })), ref: setRoot };
}
