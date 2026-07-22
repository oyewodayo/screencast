// utils/imageObjectCache.ts
//
// Support utilities for image annotations. Two independent concerns live here:
// 1. A decoded-image cache — canvas rendering needs a loaded HTMLImageElement, not a raw data
//    URL string, and decoding is async, so callers preload once and render synchronously after.
// 2. A downscale-on-insert helper shared by both the toolbar "insert image" action and paste, so
//    a full-resolution screenshot/photo doesn't get embedded as-is into the JSON sidecar (which
//    is saved on every edit via useAnnotationStore's autosave).

const cache = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement>>();

export function getCachedImage(src: string): HTMLImageElement | null {
  return cache.get(src) ?? null;
}

export function preloadImage(src: string): Promise<HTMLImageElement> {
  const existing = cache.get(src);
  if (existing) return Promise.resolve(existing);

  const inFlight = pending.get(src);
  if (inFlight) return inFlight;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      cache.set(src, img);
      pending.delete(src);
      resolve(img);
    };
    img.onerror = () => {
      pending.delete(src);
      reject(new Error(`Failed to decode image (${src.slice(0, 32)}…)`));
    };
    img.src = src;
  });

  pending.set(src, promise);
  return promise;
}

export interface LoadedImageFile {
  dataUrl: string;
  width: number;
  height: number;
}

// Reads a File/Blob (from a file input or a paste event) into a data URL, downscaling first if
// either dimension exceeds `maxDimensionPx` — keeps the sidecar JSON and autosave payload small
// for large screenshots/photos without needing a separate asset file on disk.
export function fileToDataUrl(file: File | Blob, maxDimensionPx: number): Promise<LoadedImageFile> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      const { naturalWidth: width, naturalHeight: height } = img;
      const longestSide = Math.max(width, height);

      if (longestSide <= maxDimensionPx) {
        const reader = new FileReader();
        reader.onload = () => {
          URL.revokeObjectURL(objectUrl);
          resolve({ dataUrl: reader.result as string, width, height });
        };
        reader.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("Failed to read image file"));
        };
        reader.readAsDataURL(file);
        return;
      }

      const scale = maxDimensionPx / longestSide;
      const targetWidth = Math.round(width * scale);
      const targetHeight = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(objectUrl);
      if (!ctx) {
        reject(new Error("Failed to acquire 2D context for image downscale"));
        return;
      }
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
      resolve({ dataUrl: canvas.toDataURL("image/png"), width: targetWidth, height: targetHeight });
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to decode image file"));
    };

    img.src = objectUrl;
  });
}
