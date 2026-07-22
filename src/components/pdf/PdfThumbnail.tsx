// components/pdf/PdfThumbnail.tsx
import React, { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

const THUMBNAIL_WIDTH = 150;
const PLACEHOLDER_ASPECT = 1.294; // US Letter height/width, used before the real page size is known

interface PdfThumbnailProps {
  pdfDoc: PDFDocumentProxy;
  pageIndex: number; // 0-based
  isActive: boolean;
  onSelect: (pageIndex: number) => void;
}

// One page's thumbnail in the sidebar. Rendered lazily via IntersectionObserver — only once
// scrolled near the viewport — and independent of the main page render cache in
// usePageRenderCache (that one is keyed by zoom and capped at 6 entries for full-size pages;
// thumbnails are tiny/cheap enough to render once and keep for the document's lifetime instead).
const PdfThumbnail: React.FC<PdfThumbnailProps> = ({ pdfDoc, pageIndex, isActive, onSelect }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [aspect, setAspect] = useState(PLACEHOLDER_ASPECT);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || visible) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    (async () => {
      const page = await pdfDoc.getPage(pageIndex + 1);
      if (cancelled) return;
      const baseViewport = page.getViewport({ scale: 1 });
      setAspect(baseViewport.height / baseViewport.width);

      const scale = THUMBNAIL_WIDTH / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(viewport.width * dpr));
      canvas.height = Math.max(1, Math.round(viewport.height * dpr));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx || cancelled) return;
      ctx.scale(dpr, dpr);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    })().catch((err) => {
      if (!cancelled) console.error(`Failed to render thumbnail for page ${pageIndex + 1}:`, err);
    });

    return () => {
      cancelled = true;
    };
  }, [visible, pdfDoc, pageIndex]);

  return (
    <button
      type="button"
      onClick={() => onSelect(pageIndex)}
      className={`flex flex-col items-center gap-1.5 w-full px-2 py-2 rounded-lg transition-colors ${
        isActive ? "bg-blue-500/10 ring-1 ring-blue-400" : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      }`}
    >
      <div
        ref={containerRef}
        style={{ width: THUMBNAIL_WIDTH, aspectRatio: `1 / ${aspect}` }}
        className="relative bg-white shadow-sm ring-1 ring-black/[0.08] shrink-0"
      >
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      </div>
      <span
        className={`text-[11px] tabular-nums ${
          isActive ? "text-blue-600 dark:text-blue-400 font-medium" : "text-neutral-500 dark:text-neutral-400"
        }`}
      >
        {pageIndex + 1}
      </span>
    </button>
  );
};

export default PdfThumbnail;
