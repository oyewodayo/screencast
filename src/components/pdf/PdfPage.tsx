// components/pdf/PdfPage.tsx
import React, { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import { AnnotationObject, AnnotationTool, Pt } from "../../utils/pdfAnnotationTypes";
import { clearCanvas, renderPageObjects, TextLine } from "../../handlers/pdfAnnotationHandlers";
import useStrokeCapture from "../../hooks/useStrokeCapture";
import { PageRenderCache } from "../../hooks/usePageRenderCache";

interface PdfPageProps {
  pdfDoc: PDFDocumentProxy;
  pageIndex: number; // 0-based
  numPages: number;
  zoom: number;
  cache: PageRenderCache;
  objects: AnnotationObject[];
  tool: AnnotationTool | null;
  color: string;
  width: number;
  eraserRadius: number;
  interactive: boolean;
  onStrokeComplete: (object: AnnotationObject) => void;
  onEraseBegin: (pageIndex: number) => void;
  onEraseAt: (pageIndex: number, point: Pt, radiusInPdfUnits: number) => void;
  onEraseEnd: () => void;
}

// One page = three stacked, identically-sized canvases: the pdf.js render target (bottom),
// the committed ink overlay (middle, redrawn from `objects`), and a scratch canvas for the
// in-progress stroke (top, owned by useStrokeCapture). All three get the exact same
// DPR-aware sizing recipe so ink stays pixel-aligned with page content.
//
// This component does NOT remount per page (no `key` on it in PdfAnnotator) — the page/overlay/
// scratch canvases persist across navigation, and the actual bitmap comes from `cache` (a
// LRU-capped render cache shared for the whole document's lifetime) rather than a fresh
// `page.render()` every time. Flipping back to an already-visited page is a synchronous
// `drawImage` instead of a full re-rasterize.
const PdfPage: React.FC<PdfPageProps> = ({
  pdfDoc,
  pageIndex,
  numPages,
  zoom,
  cache,
  objects,
  tool,
  color,
  width,
  eraserRadius,
  interactive,
  onStrokeComplete,
  onEraseBegin,
  onEraseAt,
  onEraseEnd,
}) => {
  const pageCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement>(null);

  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [textLines, setTextLines] = useState<TextLine[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setViewport(null);
    setRenderError(null);

    cache
      .getPage(pdfDoc, pageIndex, zoom)
      .then(({ canvas: srcCanvas, viewport: vp, dpr }) => {
        if (cancelled) return;

        // The overlay/scratch canvases need CSS-pixel-space drawing (matching viewport units) for
        // ink math, so they get the usual scale(dpr, dpr) transform. The page canvas is just a
        // one-shot blit target for the cached bitmap and is sized identically but left at the
        // identity transform so drawImage below copies pixels 1:1, with no extra scaling.
        for (const canvas of [overlayCanvasRef.current, scratchCanvasRef.current]) {
          if (!canvas) continue;
          canvas.width = srcCanvas.width;
          canvas.height = srcCanvas.height;
          canvas.style.width = `${vp.width}px`;
          canvas.style.height = `${vp.height}px`;
          const ctx = canvas.getContext("2d");
          ctx?.setTransform(1, 0, 0, 1, 0, 0);
          ctx?.scale(dpr, dpr);
        }

        const pageCanvas = pageCanvasRef.current;
        if (pageCanvas) {
          pageCanvas.width = srcCanvas.width;
          pageCanvas.height = srcCanvas.height;
          pageCanvas.style.width = `${vp.width}px`;
          pageCanvas.style.height = `${vp.height}px`;
          const pageCtx = pageCanvas.getContext("2d");
          pageCtx?.setTransform(1, 0, 0, 1, 0, 0);
          pageCtx?.drawImage(srcCanvas, 0, 0);
        }

        setViewport(vp);
        cache.prefetchNeighbors(pdfDoc, pageIndex, zoom, numPages);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to render PDF page:", err);
        setRenderError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageIndex, zoom, numPages, cache]);

  // Text geometry for the highlighter's auto-height snapping. Deliberately a separate effect
  // keyed only on [pdfDoc, pageIndex] (not zoom) — text positions are already in zoom-independent
  // PDF page-space, so there's no need to re-extract them every time the user zooms. `cache`
  // itself already avoids re-extracting on revisits; this just wires the result into state.
  useEffect(() => {
    let cancelled = false;
    setTextLines(null);
    cache
      .getTextLines(pdfDoc, pageIndex)
      .then((lines) => {
        if (!cancelled) setTextLines(lines);
      })
      .catch((err) => {
        console.error("Failed to extract PDF text content:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageIndex, cache]);

  // Redraw the committed ink overlay whenever the page's stored objects or viewport change
  // (e.g. after a stroke, an undo/redo, or an erase).
  useEffect(() => {
    if (!viewport) return;
    const canvas = overlayCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;
    clearCanvas(ctx, canvas);
    renderPageObjects(ctx, objects, viewport, viewport.scale);
  }, [viewport, objects]);

  useStrokeCapture({
    scratchCanvasRef,
    enabled: interactive && viewport !== null && tool !== null,
    tool,
    color,
    width,
    eraserRadius,
    pageIndex,
    viewport,
    textLines,
    onStrokeComplete,
    onEraseBegin,
    onEraseAt,
    onEraseEnd,
  });

  return (
    <div className="relative inline-block bg-white shadow-[0_12px_40px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.06]">
      <canvas ref={pageCanvasRef} className="block" style={{ position: "relative" }} />
      <canvas ref={overlayCanvasRef} className="absolute top-0 left-0 pointer-events-none" />
      <canvas
        ref={scratchCanvasRef}
        className="absolute top-0 left-0"
        style={{ cursor: tool === "eraser" ? "cell" : tool ? "crosshair" : "default" }}
      />
      {renderError && (
        <div className="absolute inset-0 flex items-center justify-center bg-white text-red-600 text-sm p-4">
          Failed to render page: {renderError}
        </div>
      )}
    </div>
  );
};

export default PdfPage;
