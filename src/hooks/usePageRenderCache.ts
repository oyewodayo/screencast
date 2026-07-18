// hooks/usePageRenderCache.ts
import { useMemo, useRef } from "react";
import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import { getPageTextLines, TextLine } from "../handlers/pdfAnnotationHandlers";

// Caps memory regardless of document length — the whole reason pagination was chosen over
// continuous scroll in the first place. Each cached canvas at a typical page size and 2x DPR
// is roughly 10-15MB, so 6 entries is a reasonable ceiling (~60-90MB) for "flip back and forth
// a few pages feels instant" without the cache itself becoming a memory problem on a 400+ page
// document.
const MAX_CACHED_PAGES = 6;

export interface RenderedPage {
  canvas: HTMLCanvasElement; // detached — never attached to the DOM itself, only drawImage'd from
  viewport: PageViewport;
  dpr: number;
}

function renderCacheKey(pageIndex: number, zoom: number, dpr: number): string {
  // Rounding avoids float-precision cache misses (e.g. 1.2500000000000002 vs 1.25).
  return `${pageIndex}:${Math.round(zoom * 1000)}:${dpr}`;
}

function scheduleIdle(fn: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(fn, { timeout: 1000 });
  } else {
    setTimeout(fn, 200);
  }
}

export interface PageRenderCache {
  getPage: (pdfDoc: PDFDocumentProxy, pageIndex: number, zoom: number) => Promise<RenderedPage>;
  getTextLines: (pdfDoc: PDFDocumentProxy, pageIndex: number) => Promise<TextLine[]>;
  // Fire-and-forget: renders the pages just before/after `pageIndex` at `zoom` in the background
  // (idle time) so flipping to them is a cache hit instead of a fresh render.
  prefetchNeighbors: (pdfDoc: PDFDocumentProxy, pageIndex: number, zoom: number, numPages: number) => void;
}

// Scoped to a single PdfAnnotator instance (one per open PDF — Dashboard remounts it wholesale
// via `key={selectedFile.path}` when switching files), so the cache never needs explicit
// invalidation: a new document naturally gets fresh, empty Maps.
export default function usePageRenderCache(): PageRenderCache {
  const renderCacheRef = useRef<Map<string, RenderedPage>>(new Map());
  const renderInFlightRef = useRef<Map<string, Promise<RenderedPage>>>(new Map());
  const textCacheRef = useRef<Map<number, TextLine[]>>(new Map());
  const textInFlightRef = useRef<Map<number, Promise<TextLine[]>>>(new Map());

  const rememberRendered = (key: string, value: RenderedPage): void => {
    const cache = renderCacheRef.current;
    // Delete-then-set moves the key to the end of Map's iteration order, marking it
    // most-recently-used — that's what makes evicting `.keys().next()` an LRU eviction.
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > MAX_CACHED_PAGES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  };

  const getPage = async (pdfDoc: PDFDocumentProxy, pageIndex: number, zoom: number): Promise<RenderedPage> => {
    const dpr = window.devicePixelRatio || 1;
    const key = renderCacheKey(pageIndex, zoom, dpr);

    const cached = renderCacheRef.current.get(key);
    if (cached) {
      rememberRendered(key, cached); // touch: refresh its LRU position
      return cached;
    }

    const inFlight = renderInFlightRef.current.get(key);
    if (inFlight) return inFlight;

    const promise = (async (): Promise<RenderedPage> => {
      const page = await pdfDoc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: zoom });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width * dpr));
      canvas.height = Math.max(1, Math.round(viewport.height * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Failed to acquire 2D context for page render cache");
      ctx.scale(dpr, dpr);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const result: RenderedPage = { canvas, viewport, dpr };
      rememberRendered(key, result);
      return result;
    })();

    renderInFlightRef.current.set(key, promise);
    try {
      return await promise;
    } finally {
      renderInFlightRef.current.delete(key);
    }
  };

  // Zoom-independent (text lives in the page's own default coordinate space), so this cache is
  // keyed only on page index — revisiting a page at a *different* zoom still skips re-extraction.
  const getTextLines = async (pdfDoc: PDFDocumentProxy, pageIndex: number): Promise<TextLine[]> => {
    const cached = textCacheRef.current.get(pageIndex);
    if (cached) return cached;

    const inFlight = textInFlightRef.current.get(pageIndex);
    if (inFlight) return inFlight;

    const promise = (async (): Promise<TextLine[]> => {
      const page = await pdfDoc.getPage(pageIndex + 1);
      const lines = await getPageTextLines(page);
      textCacheRef.current.set(pageIndex, lines);
      return lines;
    })();

    textInFlightRef.current.set(pageIndex, promise);
    try {
      return await promise;
    } finally {
      textInFlightRef.current.delete(pageIndex);
    }
  };

  const prefetchNeighbors = (pdfDoc: PDFDocumentProxy, pageIndex: number, zoom: number, numPages: number): void => {
    for (const neighbor of [pageIndex + 1, pageIndex - 1]) {
      if (neighbor < 0 || neighbor >= numPages) continue;
      scheduleIdle(() => {
        getPage(pdfDoc, neighbor, zoom).catch(() => {});
        getTextLines(pdfDoc, neighbor).catch(() => {});
      });
    }
  };

  // Memoized to a stable reference (created once, empty dep array) rather than a fresh object
  // every render: this object sits in effect dependency arrays in PdfPage, so a new identity on
  // every PdfAnnotator re-render (e.g. from unrelated state like stroke color) would re-trigger
  // those effects constantly, defeating the cache entirely. Safe to freeze at first render since
  // getPage/getTextLines/prefetchNeighbors only close over the useRef-backed maps above, which
  // are themselves stable and always reflect current contents regardless of which render's
  // closure is calling them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ getPage, getTextLines, prefetchNeighbors }), []);
}
