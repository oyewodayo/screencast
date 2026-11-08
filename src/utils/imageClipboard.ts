// utils/imageClipboard.ts
//
// "Copy image" for the folder gallery's context menu and the sidebar's file menu. Draws the resolved
// image into an offscreen canvas and copies that as a PNG - same approach ImageEditor.tsx's own
// "Copy to clipboard" uses. preloadImage sets crossOrigin="anonymous" on the asset:// source, which
// is what keeps the canvas untainted (a plain <img> would throw a SecurityError on toBlob) - see
// imageObjectCache.ts's doc comment for the concrete history.

import { preloadImage } from "./imageObjectCache";

export async function copyImageUrlToClipboard(url: string): Promise<void> {
  const img = await preloadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported");
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to encode image as PNG"))), "image/png");
  });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
