// utils/photoFillDraw.ts
//
// The drawing behind photoFill.ts - a photo fitted into the frame over a blurred, dimmed copy of
// itself stretched to cover - with no app imports, so the fill worker (photoFillWorker.ts) can run
// it off the main thread as well as the page.
import type { VideoProjectFrame } from "./videoEditTypes";

// Photos within this much of the frame's shape just fill it - no backdrop worth drawing.
const SAME_SHAPE = 0.03;

export const needsPhotoFill = (photoAspect: number, frame: Pick<VideoProjectFrame, "width" | "height">): boolean =>
  Math.abs(photoAspect / (frame.width / frame.height) - 1) > SAME_SHAPE;

type Picture = CanvasImageSource & { width: number; height: number };
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// Blur in proportion to the frame, so a 4K still and the small stage look alike.
const blurRadius = (w: number, h: number) => Math.max(w, h) * 0.025;
const BACKDROP_LOOK = "brightness(0.62) saturate(1.15)";
// The backdrop overshoots the frame a little, so the blur never pulls dark edges in.
const COVER_OVERSHOOT = 1.08;

// The photo fitted into a w x h canvas over its own blurred cover copy, drawn at full size (the
// Create dialog's stage, a few hundred pixels across).
export function drawPhotoFill(ctx: Context2D, img: Picture, w: number, h: number): void {
  const iw = img.width;
  const ih = img.height;
  const cover = Math.max(w / iw, h / ih) * COVER_OVERSHOOT;
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.filter = `blur(${Math.round(blurRadius(w, h))}px) ${BACKDROP_LOOK}`;
  ctx.drawImage(img, (w - iw * cover) / 2, (h - ih * cover) / 2, iw * cover, ih * cover);
  ctx.filter = "none";
  drawFitted(ctx, img, w, h);
  ctx.restore();
}

// The same picture for a full-resolution still: the backdrop blurred at a quarter of the size and
// scaled up - a blur this wide has no detail a quarter-size copy loses, and it's a sixteenth of the
// pixels to blur (export's "Blur" canvas background does the same, frame_fit_blur_chain). Returns
// false when this context can't filter (the caller then draws it another way).
export function drawPhotoFillScaledBackdrop(ctx: OffscreenCanvasRenderingContext2D, img: Picture, w: number, h: number): boolean {
  const scale = 4;
  const bw = Math.max(2, Math.ceil(w / scale));
  const bh = Math.max(2, Math.ceil(h / scale));
  const small = new OffscreenCanvas(bw, bh);
  const sctx = small.getContext("2d");
  if (!sctx) return false;
  const filter = `blur(${(blurRadius(w, h) / scale).toFixed(2)}px) ${BACKDROP_LOOK}`;
  sctx.filter = filter;
  if (sctx.filter === "none" || !sctx.filter) return false;
  sctx.fillStyle = "#000";
  sctx.fillRect(0, 0, bw, bh);
  const cover = Math.max(bw / img.width, bh / img.height) * COVER_OVERSHOOT;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(img, (bw - img.width * cover) / 2, (bh - img.height * cover) / 2, img.width * cover, img.height * cover);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small, 0, 0, w, h);
  drawFitted(ctx, img, w, h);
  ctx.restore();
  return true;
}

function drawFitted(ctx: Context2D, img: Picture, w: number, h: number): void {
  const fit = Math.min(w / img.width, h / img.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (w - img.width * fit) / 2, (h - img.height * fit) / 2, img.width * fit, img.height * fit);
}
