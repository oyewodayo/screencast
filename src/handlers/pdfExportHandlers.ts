// handlers/pdfExportHandlers.ts
//
// Flattens every page (its original PDF.js-rendered bitmap plus the ink/highlight/text/image
// overlay, exactly as shown on screen) into a brand-new, standalone PDF via pdf-lib — the
// annotations sidecar JSON only this app can read becomes a real PDF any viewer can open.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { PDFDocument } from "pdf-lib";
import { AnnotationObject } from "../utils/pdfAnnotationTypes";
import { renderPageObjects } from "./pdfAnnotationHandlers";
import { preloadImage } from "../utils/imageObjectCache";

// Device-independent render scale for the flattened output — high enough to stay crisp when
// printed or zoomed in a PDF viewer, without ballooning file size/export time the way matching
// a high-DPR screen's pixel ratio would (unlike the on-screen page cache, this never needs to
// match any particular display).
const EXPORT_SCALE = 2;

// Exported for reuse by the image editor's own "Save a copy" flow (imageEditHandlers.ts /
// ImageEditor.tsx) - same canvas-to-PNG-bytes encode, no PDF-specific behavior in here.
export function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to encode page as PNG"));
        return;
      }
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, "image/png");
  });
}

// Wraps one already-rendered canvas in a single-page PDF sized exactly to it. Shared by any feature
// that can draw itself to a canvas and wants a PDF rather than a PNG (the Mindmap and Whiteboard
// exports) - so "export as PDF" never means reimplementing a second renderer, just re-wrapping the
// one that already produces the PNG.
//
// The page is sized in POINTS at 1px = 1pt, which keeps the drawing's own aspect ratio exactly and
// gives a sensibly-sized page for the diagram dimensions this app produces. Deliberately not scaled
// to fit A4: a wide roadmap letterboxed onto portrait A4 wastes most of the page, and a diagram has
// no inherent reason to match a paper size the way a text document does.
export async function canvasToPdfBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const pngBytes = await canvasToPngBytes(canvas);
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(pngBytes);
  const page = pdf.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return pdf.save();
}

// Renders one page's bitmap + its annotation objects onto a single offscreen canvas, PNG-encoded
// — `widthPts`/`heightPts` are the page's actual PDF-space size (1 unit = 1/72in), which is what
// pdf-lib needs to size the corresponding output page so the flattened image isn't stretched.
async function rasterizeAnnotatedPage(
  pdfDoc: PDFDocumentProxy,
  pageIndex: number,
  objects: AnnotationObject[]
): Promise<{ pngBytes: Uint8Array; widthPts: number; heightPts: number }> {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const basePageViewport = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: EXPORT_SCALE });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to acquire 2D context for PDF export");

  await page.render({ canvas, canvasContext: ctx, viewport }).promise;

  // Image annotations render synchronously from imageObjectCache's decoded-image cache — a page
  // that was never actually visited on screen (e.g. exporting straight after opening a long
  // document) may not have decoded its images yet, so every image object gets preloaded first.
  await Promise.all(objects.filter((o): o is Extract<AnnotationObject, { type: "image" }> => o.type === "image").map((o) => preloadImage(o.src)));
  renderPageObjects(ctx, objects, viewport, EXPORT_SCALE);

  const pngBytes = await canvasToPngBytes(canvas);
  return { pngBytes, widthPts: basePageViewport.width, heightPts: basePageViewport.height };
}

// Builds the full flattened PDF, page by page (sequentially — keeping only one rasterized page
// in memory at a time matters for long documents), reporting 1-based progress as it goes.
export async function exportAnnotatedPdf(
  pdfDoc: PDFDocumentProxy,
  numPages: number,
  getPageObjects: (pageIndex: number) => AnnotationObject[],
  onProgress?: (completed: number, total: number) => void
): Promise<Uint8Array> {
  const outDoc = await PDFDocument.create();

  for (let pageIndex = 0; pageIndex < numPages; pageIndex++) {
    const { pngBytes, widthPts, heightPts } = await rasterizeAnnotatedPage(pdfDoc, pageIndex, getPageObjects(pageIndex));
    const embeddedPng = await outDoc.embedPng(pngBytes);
    const outPage = outDoc.addPage([widthPts, heightPts]);
    outPage.drawImage(embeddedPng, { x: 0, y: 0, width: widthPts, height: heightPts });
    onProgress?.(pageIndex + 1, numPages);
  }

  return outDoc.save();
}
