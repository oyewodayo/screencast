// utils/photoFillWorker.ts
//
// Makes one photo's filled still (photoFill.ts) entirely off the page's main thread: reads the file
// from its asset URL, decodes it (upright, by its EXIF orientation - as an <img> shows it), draws the
// fill on an OffscreenCanvas and encodes the JPEG. What used to block the page for about a second per
// phone photo - decode, a full-size blur, a synchronous toDataURL - now runs on several cores at once
// while the "Making your video" screen keeps animating.
import { drawPhotoFillScaledBackdrop, needsPhotoFill } from "./photoFillDraw";

interface Job {
  id: number;
  url: string;
  width: number;
  height: number;
}

// Workers only (the project's TypeScript lib is the page's): reads a Blob synchronously, natively.
declare const FileReaderSync: { new (): { readAsDataURL(blob: Blob): string } };

export type FillReply ={ id: number; jpegBase64: string | null } | { id: number; error: string };

const reply = (message: FillReply) => (self as unknown as Worker).postMessage(message);

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, url, width, height } = e.data;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: "from-image" });
    try {
      if (!needsPhotoFill(bitmap.width / bitmap.height, { width, height })) return reply({ id, jpegBase64: null });
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx || !drawPhotoFillScaledBackdrop(ctx, bitmap, width, height)) throw new Error("This canvas can't draw the fill here");
      const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.93 });
      const dataUrl = new FileReaderSync().readAsDataURL(jpeg);
      reply({ id, jpegBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) });
    } finally {
      bitmap.close();
    }
  } catch (err) {
    reply({ id, error: err instanceof Error ? err.message : String(err) });
  }
};

export {};
