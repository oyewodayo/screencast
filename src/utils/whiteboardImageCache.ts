// utils/whiteboardImageCache.ts
//
// Decoded-image cache + asset import helpers for image nodes on the Whiteboard (see
// whiteboardTypes.ts's "image" shapeType). Deliberately its own module rather than reusing
// boardImageCache.ts: the two features store assets under different project folders, and sharing
// one cache keyed by URL would work only by accident - the moment either feature needed a
// per-feature eviction or preload policy the shared map would have to be split anyway.
//
// The live canvas renders images as ordinary <img> elements (the browser decodes those itself), so
// this cache exists for the OTHER renderer: whiteboardHandlers.ts's Canvas2D PNG export, which is
// synchronous and needs an already-decoded HTMLImageElement rather than a URL. Same "preload once,
// render synchronously after" split boardImageCache.ts's own doc comment describes.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const cache = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement>>();
// Sources whose decode has already failed once. Without this a missing/corrupt asset would be
// retried on every single export and every preload pass, each attempt logging its own failure -
// the node renders its "missing image" placeholder instead, which is a stable end state, not
// something a retry can fix.
const failed = new Set<string>();

export function getCachedWhiteboardImage(src: string): HTMLImageElement | null {
  return cache.get(src) ?? null;
}

export function whiteboardImageFailed(src: string): boolean {
  return failed.has(src);
}

export function preloadWhiteboardImage(src: string): Promise<HTMLImageElement> {
  const existing = cache.get(src);
  if (existing) return Promise.resolve(existing);
  if (failed.has(src)) return Promise.reject(new Error("Image previously failed to decode"));

  const inFlight = pending.get(src);
  if (inFlight) return inFlight;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    // Without this, drawing an asset://-sourced image to a canvas taints it, and the
    // toDataURL()/toBlob() behind whiteboard thumbnails and PNG export throw a SecurityError
    // instead of producing bytes - same reasoning as boardImageCache.ts's own crossOrigin line.
    img.crossOrigin = "anonymous";
    img.onload = () => {
      cache.set(src, img);
      pending.delete(src);
      resolve(img);
    };
    img.onerror = () => {
      pending.delete(src);
      failed.add(src);
      reject(new Error(`Failed to decode whiteboard image (${src.slice(0, 48)}…)`));
    };
    img.src = src;
  });

  pending.set(src, promise);
  return promise;
}

// Joins a Briefcast-relative whiteboard asset path using whichever separator the root path itself
// uses (backslash on Windows, forward slash elsewhere) - briefcast_dir() returns a native OS path
// string, and this has to stay a valid path for Tauri's convertFileSrc to resolve.
export function whiteboardAssetPath(briefcastDir: string, whiteboardId: string, assetFileName: string): string {
  const sep = briefcastDir.includes("\\") ? "\\" : "/";
  const trimmedRoot = briefcastDir.replace(/[\\/]+$/, "");
  return [trimmedRoot, "Whiteboards", whiteboardId, "assets", assetFileName].join(sep);
}

export function whiteboardAssetUrl(briefcastDir: string, whiteboardId: string, assetFileName: string): string {
  return convertFileSrc(whiteboardAssetPath(briefcastDir, whiteboardId, assetFileName));
}

// Clipboard/drag-drop MIME type to the file extension the asset is stored under. Kept in step with
// whiteboards.rs's own ALLOWED_IMAGE_EXTENSIONS - "image/jpg" is a non-standard MIME some tools
// still emit for a JPEG, mapped alongside the standard "image/jpeg" (same note docImagePaste.ts
// makes about its own copy of this map).
export const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

// Natural pixel dimensions of an image, needed before a node can be created for it (the node's
// starting box preserves the source's aspect ratio - see createImageWhiteboardNode). Resolves via
// the same cache the export path uses, so the decode is paid for once rather than twice.
export async function measureImage(src: string): Promise<{ width: number; height: number }> {
  const img = await preloadWhiteboardImage(src);
  return { width: img.naturalWidth || 1, height: img.naturalHeight || 1 };
}

// Copies a file already on disk (picked through the native file dialog) into this whiteboard's
// assets/ folder. Returns the stored asset FILE NAME, which is what the node persists.
export async function importImageFromPath(whiteboardId: string, sourcePath: string): Promise<string> {
  return invoke<string>("import_whiteboard_image", { whiteboardId, sourcePath, assetId: crypto.randomUUID() });
}

// In-memory counterpart for a clipboard paste or a drag-and-drop, where the bytes never existed as
// a file the backend could copy. Throws (rather than returning null) on an unsupported type so the
// caller's own error path surfaces a real message instead of the paste silently doing nothing -
// same reasoning docImagePaste.ts's uploadImage gives.
export async function importImageFromBlob(whiteboardId: string, file: File | Blob, typeHint?: string): Promise<string> {
  const mime = typeHint ?? file.type;
  const extension = EXTENSION_BY_MIME[mime];
  if (!extension) throw new Error(`Unsupported image type: "${mime || "unknown"}"`);
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  return invoke<string>("save_whiteboard_image", { whiteboardId, assetId: crypto.randomUUID(), extension, bytes });
}
