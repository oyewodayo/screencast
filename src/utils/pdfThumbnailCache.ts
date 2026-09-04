// utils/pdfThumbnailCache.ts
//
// Session-lived cache for rendered PDF first-page thumbnails (PdfFolderGallery.tsx). Unlike the
// image/video gallery thumbnails, there's no Rust-side disk cache backing these - rendering a PDF
// page is pure pdf.js/canvas work in the browser, nothing to hand off to a backend command for.
// A small in-memory Map is enough: each entry is just a compact JPEG data URL, and revisiting the
// same PDF folder within one session is instant instead of re-parsing/re-rendering every file
// again. Doesn't survive a restart, unlike get_image_thumbnail/get_video_thumbnail's caches - an
// acceptable gap given a PDF's first page renders in well under what a fresh video frame extract
// or full-res photo decode costs.
const cache = new Map<string, string>();

export function getCachedPdfThumbnail(path: string): string | undefined {
  return cache.get(path);
}

export function setCachedPdfThumbnail(path: string, dataUrl: string): void {
  cache.set(path, dataUrl);
}
