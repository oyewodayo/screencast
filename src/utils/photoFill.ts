// utils/photoFill.ts
//
// A photo that isn't the video frame's shape fills the frame the way template editors do it: the
// whole photo, fitted, over a blurred, dimmed copy of itself stretched to cover - instead of black
// bars. Drawn here once at the frame's full resolution and stored as a still in the derived-media
// cache (store_derived_still, derived_images.rs), so it then previews, keyframes and exports like
// any other picture clip. The same drawing (drawPhotoFill) is what the Create dialog's stage shows.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getFileExtension } from "./fileCategory";
import type { VideoProjectFrame } from "./videoEditTypes";

// Bump when the look changes, so stored stills are made again.
const FILL_VERSION = 1;
// Photos within this much of the frame's shape just fill it - no backdrop worth drawing.
const SAME_SHAPE = 0.03;

export const needsPhotoFill = (photoAspect: number, frame: VideoProjectFrame): boolean =>
  Math.abs(photoAspect / (frame.width / frame.height) - 1) > SAME_SHAPE;

// The photo fitted into a w x h canvas over its own blurred cover copy.
export function drawPhotoFill(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, w: number, h: number): void {
  const iw = img.width;
  const ih = img.height;
  const cover = Math.max(w / iw, h / ih) * 1.08;
  const fit = Math.min(w / iw, h / ih);
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  // Blur in proportion to the frame, so a 4K still and the small stage look alike.
  ctx.filter = `blur(${Math.round(Math.max(w, h) * 0.025)}px) brightness(0.62) saturate(1.15)`;
  ctx.drawImage(img, (w - iw * cover) / 2, (h - ih * cover) / 2, iw * cover, ih * cover);
  ctx.filter = "none";
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (w - iw * fit) / 2, (h - ih * fit) / 2, iw * fit, ih * fit);
  ctx.restore();
}

// The photo, decoded from the file itself (HEIC through its cached preview). `direct`: straight from
// its asset URL, read cross-origin so the canvas stays readable - instead of a data URL, which turned
// a phone photo (20 MB) into a ~27 MB base64 string carried across IPC and parsed on the page's main
// thread before decoding could even start. The data URL remains as the fallback.
async function loadFullPhoto(path: string, direct: boolean): Promise<HTMLImageElement> {
  const source = ["heic", "heif"].includes(getFileExtension(path)) ? await invoke<string>("get_heic_preview", { inputPath: path }) : path;
  const url = direct ? convertFileSrc(source) : await invoke<string>("read_image_data_url", { path: source });
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't open ${path}`));
    img.src = url;
  });
}

// The fill drawn at the frame's size, as JPEG base64 - null when the photo needs none. Throws if the
// canvas can't be read (a photo the browser treats as foreign), which the caller retries via a data URL.
async function renderFill(path: string, frame: VideoProjectFrame, direct: boolean): Promise<string | null> {
  const img = await loadFullPhoto(path, direct);
  if (!needsPhotoFill(img.naturalWidth / img.naturalHeight, frame)) return null;
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawPhotoFill(ctx, img, frame.width, frame.height);
  return canvas.toDataURL("image/jpeg", 0.93).split(",")[1];
}

// A still of `path` filling `frame` (made once, then found in the cache) - or `path` itself when
// the photo is already the frame's shape. `aspect` (when known) skips opening photos that fit.
export async function photoFillPath(path: string, frame: VideoProjectFrame, aspect?: number): Promise<string> {
  if (aspect !== undefined && !needsPhotoFill(aspect, frame)) return path;
  const key = `${frame.width}x${frame.height}|v${FILL_VERSION}`;
  const stored = await invoke<string | null>("store_derived_still", { sourcePath: path, kind: "fill", key, jpegBase64: null });
  if (stored) return stored;
  let jpeg: string | null;
  try {
    jpeg = await renderFill(path, frame, true);
  } catch {
    // The direct load failed or left the canvas unreadable - the slower data URL always works.
    jpeg = await renderFill(path, frame, false);
  }
  if (!jpeg) return path;
  return (await invoke<string | null>("store_derived_still", { sourcePath: path, kind: "fill", key, jpegBase64: jpeg })) ?? path;
}
