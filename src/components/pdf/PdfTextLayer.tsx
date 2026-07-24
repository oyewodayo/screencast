// components/pdf/PdfTextLayer.tsx
import React, { useEffect, useRef } from "react";
import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import "./pdfTextLayer.css";

interface PdfTextLayerProps {
  pdfDoc: PDFDocumentProxy;
  pageIndex: number; // 0-based
  viewport: PageViewport;
  // Native browser text selection only makes sense while no drawing tool is capturing the
  // pointer for its own gesture (pen/highlighter/eraser drag, text-note place/move) — see
  // PdfPage's scratchCanvas, which is the thing actually on top and pointer-events:auto whenever
  // this is false. Toggling this off doesn't unmount the layer, just steps it out of the way.
  selectable: boolean;
}

// Overlays pdf.js's own TextLayer — invisible text spans positioned pixel-for-pixel over the
// glyphs the page's canvas already painted — so dragging over a page selects real text exactly
// like a native PDF viewer, with copy/native-selection-tint/double-click-word/etc. all coming
// from the browser's own selection engine for free rather than being reimplemented here.
const PdfTextLayer: React.FC<PdfTextLayerProps> = ({ pdfDoc, pageIndex, viewport, selectable }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Cheap to just always rebuild from scratch on any viewport change (zoom or page nav) rather
    // than using TextLayer's own incremental `.update()` — this only ever runs for the one or two
    // pages actually on screen, and pdf.js caches the parsed page/text content internally, so a
    // rebuild here isn't re-parsing the PDF.
    container.replaceChildren();
    container.style.setProperty("--total-scale-factor", String(viewport.scale));
    // setLayerDimensions (called inside the TextLayer constructor below) sizes this container via
    // a `--total-scale-factor`-driven calc() — explicit px here is simpler to reason about and
    // guaranteed to match the sibling page/overlay/scratch canvases exactly, which all size
    // themselves the same way (see PdfPage's cache.getPage effect).
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;

    let cancelled = false;
    let textLayer: TextLayer | null = null;

    pdfDoc.getPage(pageIndex + 1).then((page) => {
      if (cancelled) return;
      textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
      // setLayerDimensions runs synchronously in the constructor above and may have just
      // overwritten width/height with its own calc() — reassert the explicit values.
      container.style.width = `${viewport.width}px`;
      container.style.height = `${viewport.height}px`;
      textLayer.render().catch(() => {
        // Rejects on cancel() (page nav / unmount mid-render) — not a real failure.
      });
    });

    return () => {
      cancelled = true;
      textLayer?.cancel();
    };
  }, [pdfDoc, pageIndex, viewport]);

  return <div ref={containerRef} className="pdfTextLayer" style={{ pointerEvents: selectable ? "auto" : "none" }} />;
};

export default PdfTextLayer;
