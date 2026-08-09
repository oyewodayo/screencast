// utils/boardImageCache.ts
//
// Decoded-image cache for the Board feature, independent of imageObjectCache.ts (same "preload
// once, render synchronously after" split that a hand-rolled Canvas 2D renderer always needs -
// canvas rendering needs a loaded HTMLImageElement, not a URL string, and decoding is async).

const cache = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement>>();

export function getCachedBoardImage(src: string): HTMLImageElement | null {
  return cache.get(src) ?? null;
}

export function preloadBoardImage(src: string): Promise<HTMLImageElement> {
  const existing = cache.get(src);
  if (existing) return Promise.resolve(existing);

  const inFlight = pending.get(src);
  if (inFlight) return inFlight;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    // See imageObjectCache.ts's preloadImage for why this matters: without it, drawing an
    // asset://-sourced image to a canvas taints that canvas, and toDataURL()/toBlob() (board
    // thumbnails, PNG export) throw a SecurityError instead of producing bytes.
    img.crossOrigin = "anonymous";
    img.onload = () => {
      cache.set(src, img);
      pending.delete(src);
      resolve(img);
    };
    img.onerror = () => {
      pending.delete(src);
      reject(new Error(`Failed to decode board image (${src.slice(0, 32)}…)`));
    };
    img.src = src;
  });

  pending.set(src, promise);
  return promise;
}

// Joins a Briefcast-relative board asset path using whichever separator the root path itself
// uses (backslash on Windows, forward slash elsewhere) - briefcast_dir() returns a native OS path
// string, and this needs to stay a valid path for Tauri's convertFileSrc to resolve.
export function boardAssetPath(briefcastDir: string, boardId: string, assetFileName: string): string {
  const sep = briefcastDir.includes("\\") ? "\\" : "/";
  const trimmedRoot = briefcastDir.replace(/[\\/]+$/, "");
  return [trimmedRoot, "Boards", boardId, "assets", assetFileName].join(sep);
}
