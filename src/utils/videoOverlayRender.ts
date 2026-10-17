// utils/videoOverlayRender.ts
//
// Renders a TextOverlay/ImageOverlay to a standalone transparent PNG for export burn-in
// (useVideoEditStore's exportEdited, composited by the Rust side via ffmpeg's `overlay` filter -
// see OverlayImage/write_temp_overlay_png in conversion.rs). Deliberately separate from both
// TextNoteEditor's DOM rendering (used for the live preview) and pdfAnnotationHandlers.ts's
// renderTextObject (PDF's own canvas bake, coupled to a PDF viewport) - this file owns matching
// the *video* preview's CSS look (stroke, corner-radius background/pill, rotation, border,
// shadow) via canvas primitives, independent of either.
//
// Each render targets a canvas sized to just the overlay's own box (not the whole video frame) -
// far cheaper than a full-frame canvas per overlay, and ffmpeg positions it via the returned
// xPx/yPx either way.
import { invoke } from "@tauri-apps/api/core";
import { BlurOverlay, ImageOverlay, TextOverlay, TextOverlayCornerStyle } from "./videoEditTypes";
import { TEXT_FONT_FAMILY, measureTextBlock } from "../handlers/pdfAnnotationHandlers";
import { TextRevealState, isTextReveal, textRevealFrameKey, textRevealState } from "./textReveal";
import { IMAGE_REVEAL_FPS, ImageRevealSettings, ImageRevealState, imageRevealState, wipeAxis } from "./imageReveal";

// A text overlay with a title reveal (textReveal.ts) as the PNG frame sequence export burns in
// (OverlayFrames, conversion.rs) - each distinct moment once, the fully-typed title once.
export async function renderTextRevealFrames(
  overlay: TextOverlay,
  framePixelWidth: number,
  framePixelHeight: number
): Promise<{ unique: string[]; sequence: number[]; xPx: number; yPx: number } | null> {
  if (!isTextReveal(overlay.animation)) return null;
  const kind = overlay.animation;
  const duration = overlay.endTime - overlay.startTime;
  if (duration <= 0) return null;
  const fps = 30;
  const total = Math.max(1, Math.ceil(duration * fps));
  const unique: string[] = [];
  const sequence: number[] = [];
  const keyIndex = new Map<string, number>();
  let origin: { xPx: number; yPx: number } | null = null;
  for (let k = 0; k < total; k++) {
    const state = textRevealState(overlay.text, kind, k / fps, duration, overlay.reveal);
    const key = textRevealFrameKey(state, k);
    let idx = keyIndex.get(key);
    if (idx === undefined) {
      const rendered = renderTextOverlayToPng(overlay, framePixelWidth, framePixelHeight, state);
      if (!rendered) return null;
      origin = origin ?? { xPx: rendered.xPx, yPx: rendered.yPx };
      idx = unique.length;
      unique.push(rendered.dataUrl);
      keyIndex.set(key, idx);
      // eslint-disable-next-line no-await-in-loop
      if (idx % 12 === 11) await new Promise((r) => setTimeout(r, 0));
    }
    sequence.push(idx);
  }
  return origin ? { unique, sequence, ...origin } : null;
}

export interface RenderedOverlayPng {
  dataUrl: string;
  xPx: number;
  yPx: number;
}

// Same shape as RenderedOverlayPng, plus the mask's own bounding-box size - a blur mask (unlike a
// text/image overlay PNG) needs its width/height told to Rust explicitly, since export_trimmed_video
// crops that exact region out of the *live video* stream (a completely different ffmpeg input than
// the mask PNG itself), so it can't just read the crop size off the decoded PNG the way `overlay`
// implicitly sizes itself off an image input.
export interface RenderedBlurMaskPng extends RenderedOverlayPng {
  widthPx: number;
  heightPx: number;
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  // Manual fallback for engines without native roundRect - same shape via arcs.
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function cornerRadiusPx(style: TextOverlayCornerStyle | undefined, heightPx: number): number {
  if (style === "pill") return heightPx / 2;
  if (style === "rounded") return 8;
  return 0;
}

// Mirrors VideoOverlayLayer's read-only text rendering (stroke, background+corner-radius,
// per-character color/bold/italic, textAlign) as closely as canvas primitives allow. "justify" has
// no simple canvas equivalent - same documented fallback-to-left as pdfAnnotationHandlers.ts's own
// renderTextObject, for the same reason (would need to redistribute space between words per line,
// which the per-formatting-segment draw loop below isn't built for).
// `reveal` draws one moment of a letter-by-letter title reveal (textReveal.ts) - characters one at
// a time at their own opacity/offset, plus the typewriter caret - instead of the finished text.
export function renderTextOverlayToPng(overlay: TextOverlay, framePixelWidth: number, framePixelHeight: number, reveal?: TextRevealState): RenderedOverlayPng | null {
  const text = overlay.text.trim();
  if (!text) return null;

  const fontSizePx = overlay.fontSize * framePixelHeight;
  const maxWidthPx = overlay.width * framePixelWidth;
  const { lines, lineHeight, height: textHeightPx } = measureTextBlock(overlay.text, fontSizePx, maxWidthPx);
  if (maxWidthPx <= 0 || textHeightPx <= 0) return null;

  // Mirrors VideoOverlayLayer's own read-only render: undefined means the pre-existing fixed 2px
  // look, otherwise a frameRect.height fraction (same basis as fontSize) - see TextOverlay.padding's
  // own doc comment.
  const padding = overlay.padding !== undefined ? overlay.padding * framePixelHeight : 2;
  const canvasWidth = Math.max(1, Math.ceil(maxWidthPx + padding * 2));
  const boxHeight = Math.max(1, Math.ceil(textHeightPx + padding * 2));
  // Room below the box for a reveal's accent underline (it hangs just under the box - RevealText).
  const underlineColor = reveal && overlay.reveal?.underline;
  const canvasHeight = underlineColor ? Math.ceil(boxHeight + fontSizePx * 0.25) : boxHeight;

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const baseFont = `${fontSizePx}px ${TEXT_FONT_FAMILY}`;
  ctx.font = baseFont;
  ctx.textBaseline = "top";
  if (reveal) ctx.globalAlpha = reveal.fade;

  if (overlay.backgroundColor) {
    ctx.fillStyle = overlay.backgroundColor;
    roundedRectPath(ctx, 0, 0, canvasWidth, boxHeight, cornerRadiusPx(overlay.cornerStyle, boxHeight));
    ctx.fill();
  }

  const colorRuns = overlay.colorRuns ?? [];
  const boldRuns = overlay.boldRuns ?? [];
  const italicRuns = overlay.italicRuns ?? [];
  const hasFormatting = colorRuns.length > 0 || boldRuns.length > 0 || italicRuns.length > 0;
  const align = overlay.textAlign === "justify" ? "left" : overlay.textAlign ?? "left";
  const hasStroke = !!(overlay.strokeColor && overlay.strokeWidth);
  if (hasStroke) {
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
  }

  const drawPlain = (segment: string, x: number, y: number, fillColor: string): void => {
    if (hasStroke) {
      ctx.lineWidth = overlay.strokeWidth!;
      ctx.strokeStyle = overlay.strokeColor!;
      ctx.strokeText(segment, x, y);
    }
    ctx.fillStyle = fillColor;
    ctx.fillText(segment, x, y);
  };
  // Same shapes as the preview's Caret (textFormatting.tsx).
  const drawCaret = (x: number, y: number, color: string): void => {
    ctx.save();
    ctx.fillStyle = color;
    const f = fontSizePx;
    const style = overlay.reveal?.caretStyle ?? "bar";
    if (style === "block") {
      ctx.globalAlpha *= 0.8;
      ctx.fillRect(x, y, f * 0.55, f);
    } else if (style === "underscore") ctx.fillRect(x, y + f * 0.85, f * 0.55, f * 0.1);
    else ctx.fillRect(x - Math.max(0.75, f * 0.04), y, Math.max(1.5, f * 0.08), f);
    ctx.restore();
  };
  // `absStart` is the segment's first character's index in overlay.text - what reveal states key on.
  const drawSegment = (segment: string, x: number, y: number, font: string, fillColor: string, absStart: number): number => {
    ctx.font = font;
    if (!reveal) {
      drawPlain(segment, x, y, fillColor);
      return ctx.measureText(segment).width;
    }
    const fade = reveal.fade;
    let cx = x;
    for (let j = 0; j < segment.length; j++) {
      if (reveal.caretAt === absStart + j) drawCaret(cx, y, fillColor);
      const ch = segment[j];
      const { opacity, dy } = reveal.char(absStart + j);
      if (opacity > 0) {
        ctx.globalAlpha = fade * opacity;
        drawPlain(ch, cx, y + dy * fontSizePx, fillColor);
        ctx.globalAlpha = fade;
      }
      cx += ctx.measureText(ch).width;
    }
    if (reveal.caretAt === overlay.text.length && absStart + segment.length === overlay.text.length) drawCaret(cx, y, fillColor);
    return cx - x;
  };

  lines.forEach((line, i) => {
    const y = padding + i * lineHeight;

    if (!hasFormatting) {
      ctx.font = baseFont;
      const lineWidth = ctx.measureText(line.text).width;
      const xOffset = align === "center" ? (maxWidthPx - lineWidth) / 2 : align === "right" ? maxWidthPx - lineWidth : 0;
      drawSegment(line.text, padding + xOffset, y, baseFont, overlay.color, line.startOffset);
      return;
    }

    const lineStart = line.startOffset;
    const lineEnd = line.startOffset + line.text.length;
    const cutSet = new Set<number>([0, line.text.length]);
    const addBoundaries = (ranges: { start: number; end: number }[]): void => {
      for (const range of ranges) {
        if (range.end <= lineStart || range.start >= lineEnd) continue;
        cutSet.add(Math.max(0, range.start - lineStart));
        cutSet.add(Math.min(line.text.length, range.end - lineStart));
      }
    };
    addBoundaries(colorRuns);
    addBoundaries(boldRuns);
    addBoundaries(italicRuns);
    const cuts = Array.from(cutSet).sort((a, b) => a - b);

    // Two passes: measure the line's natural width first (center/right need it before drawing
    // starts), then draw - same shape as pdfAnnotationHandlers.ts's renderTextObject.
    const segments: { text: string; font: string; color: string; width: number; start: number }[] = [];
    let naturalWidth = 0;
    for (let s = 0; s < cuts.length - 1; s++) {
      const segStart = cuts[s];
      const segEnd = cuts[s + 1];
      if (segEnd <= segStart) continue;
      const segment = line.text.slice(segStart, segEnd);
      const absoluteStart = lineStart + segStart;
      const absoluteEnd = lineStart + segEnd;
      const coveringColor = colorRuns.find((run) => run.start <= absoluteStart && run.end >= absoluteEnd);
      const isBold = boldRuns.some((run) => run.start <= absoluteStart && run.end >= absoluteEnd);
      const isItalic = italicRuns.some((run) => run.start <= absoluteStart && run.end >= absoluteEnd);
      const font = `${isItalic ? "italic " : ""}${isBold ? "bold " : ""}${baseFont}`;
      ctx.font = font;
      const width = ctx.measureText(segment).width;
      segments.push({ text: segment, font, color: coveringColor?.color ?? overlay.color, width, start: absoluteStart });
      naturalWidth += width;
    }

    const xOffset = align === "center" ? (maxWidthPx - naturalWidth) / 2 : align === "right" ? maxWidthPx - naturalWidth : 0;
    let x = padding + xOffset;
    for (const seg of segments) {
      x += drawSegment(seg.text, x, y, seg.font, seg.color, seg.start);
    }
  });

  if (underlineColor && reveal.underline > 0) {
    ctx.globalAlpha = reveal.fade;
    ctx.fillStyle = underlineColor;
    roundedRectPath(ctx, padding, boxHeight + fontSizePx * 0.08, maxWidthPx * reveal.underline, fontSizePx * 0.09, fontSizePx * 0.05);
    ctx.fill();
  }

  return {
    dataUrl: canvas.toDataURL("image/png"),
    xPx: Math.round(overlay.x * framePixelWidth - padding),
    yPx: Math.round(overlay.y * framePixelHeight - padding),
  };
}

// Mirrors VideoOverlayLayer's image rendering (rotation, corner-radius clip, border, drop shadow,
// opacity). Rotation needs a canvas sized to the *rotated* bounding box (larger than the plain
// w*h box whenever rotation isn't a multiple of 180), so xPx/yPx are recentered to keep the same
// visual center the unrotated box would have had - ffmpeg's overlay=x:y positions this PNG's own
// top-left, not its center.
export async function renderImageOverlayToPng(overlay: ImageOverlay, framePixelWidth: number, framePixelHeight: number): Promise<RenderedOverlayPng | null> {
  const img = await loadOverlayImage(overlay.src);
  return img ? drawImageOverlayPng(overlay, img, framePixelWidth, framePixelHeight) : null;
}

// A picture overlay's reveal (imageReveal.ts) as the PNG frame sequence export burns in - the image
// decoded once, each distinct moment drawn once (the settled picture, and each shine phase, are
// shared by every frame that shows them).
export async function renderImageRevealFrames(
  overlay: ImageOverlay,
  framePixelWidth: number,
  framePixelHeight: number
): Promise<{ unique: string[]; sequence: number[]; xPx: number; yPx: number } | null> {
  const settings = overlay.reveal;
  const duration = overlay.endTime - overlay.startTime;
  if (!settings || duration <= 0) return null;
  const img = await loadOverlayImage(overlay.src);
  if (!img) return null;
  const total = Math.max(1, Math.ceil(duration * IMAGE_REVEAL_FPS));
  const unique: string[] = [];
  const sequence: number[] = [];
  const keyIndex = new Map<string, number>();
  let origin: { xPx: number; yPx: number } | null = null;
  for (let k = 0; k < total; k++) {
    const state = imageRevealState(settings, k / IMAGE_REVEAL_FPS, duration);
    let idx = keyIndex.get(state.key);
    if (idx === undefined) {
      const rendered = drawImageOverlayPng(overlay, img, framePixelWidth, framePixelHeight, state);
      if (!rendered) return null;
      origin = origin ?? { xPx: rendered.xPx, yPx: rendered.yPx };
      idx = unique.length;
      unique.push(rendered.dataUrl);
      keyIndex.set(state.key, idx);
      // eslint-disable-next-line no-await-in-loop
      if (idx % 12 === 11) await new Promise((r) => setTimeout(r, 0));
    }
    sequence.push(idx);
  }
  return origin ? { unique, sequence, ...origin } : null;
}

async function loadOverlayImage(src: string): Promise<HTMLImageElement | null> {
  // Loaded via a data: URL (read_image_data_url, Rust-side) rather than convertFileSrc's asset://
  // protocol + plain <img src> - that works fine for on-screen display, but the browser treats
  // asset:// as cross-origin, and drawing a cross-origin image into a canvas taints it, which
  // makes the toDataURL() call below throw ("Tainted canvases may not be exported"). A data: URL
  // has no origin of its own, so it never triggers that.
  let dataUrl: string;
  try {
    dataUrl = await invoke<string>("read_image_data_url", { path: src });
  } catch (err) {
    console.error("Failed to read image overlay for export:", err);
    return null;
  }

  const img = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
  return loaded ? img : null;
}

// Draws a picture overlay - at one moment of its reveal when `reveal` is given - to its own PNG.
function drawImageOverlayPng(overlay: ImageOverlay, img: HTMLImageElement, framePixelWidth: number, framePixelHeight: number, reveal?: ImageRevealState): RenderedOverlayPng | null {
  const w = overlay.width * framePixelWidth;
  const h = overlay.height * framePixelHeight;
  if (w <= 0 || h <= 0) return null;

  const rotationRad = ((overlay.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rotationRad));
  const sin = Math.abs(Math.sin(rotationRad));
  const boundingWidth = Math.max(1, Math.ceil(w * cos + h * sin));
  const boundingHeight = Math.max(1, Math.ceil(w * sin + h * cos));

  const canvas = document.createElement("canvas");
  canvas.width = boundingWidth;
  canvas.height = boundingHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const centerX = boundingWidth / 2;
  const centerY = boundingHeight / 2;
  const radius = (overlay.cornerRadius ?? 0) * framePixelHeight;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(rotationRad);

  if (overlay.shadow) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = "#000000";
    roundedRectPath(ctx, -w / 2, -h / 2, w, h, radius);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  ctx.globalAlpha = overlay.opacity;
  roundedRectPath(ctx, -w / 2, -h / 2, w, h, radius);
  ctx.clip();
  // Flip only affects the drawImage call, not the shadow/border shapes just above/below (which
  // are symmetric rectangles a mirror wouldn't visibly change anyway) - matches the preview, where
  // flip lives on the <img> itself rather than its container (see VideoOverlayLayer's own comment
  // on that same split).
  if (overlay.flipHorizontal || overlay.flipVertical) ctx.scale(overlay.flipHorizontal ? -1 : 1, overlay.flipVertical ? -1 : 1);
  // Source rect (sx/sy/sWidth/sHeight) is the cropped sub-region set via ImageOverlayCropPanel, in
  // the source image's own natural pixel space (see ImageOverlay.cropX's own doc comment) -
  // defaults to the whole image when never cropped, same as the always-full-image drawImage call
  // this replaced. drawImage always fills the dest rect (w x h) regardless of the source rect's own
  // aspect ratio - matches this function's own pre-existing stretch-to-fill behavior, just now
  // reading from the cropped sub-region instead of the whole picture.
  const sx = (overlay.cropX ?? 0) * img.naturalWidth;
  const sy = (overlay.cropY ?? 0) * img.naturalHeight;
  const sWidth = (overlay.cropWidth ?? 1) * img.naturalWidth;
  const sHeight = (overlay.cropHeight ?? 1) * img.naturalHeight;
  ctx.drawImage(img, sx, sy, sWidth, sHeight, -w / 2, -h / 2, w, h);
  ctx.restore();

  if (overlay.borderColor) {
    ctx.save();
    ctx.globalAlpha = overlay.opacity;
    ctx.strokeStyle = overlay.borderColor;
    ctx.lineWidth = 3;
    roundedRectPath(ctx, -w / 2 + 1.5, -h / 2 + 1.5, w - 3, h - 3, radius);
    ctx.stroke();
    ctx.restore();
  }

  if (reveal) applyImageReveal(ctx, canvas, reveal, overlay.reveal!, w, h);

  ctx.restore();

  // Recentered so the rotated (larger) canvas still lines up on the overlay's original center -
  // ffmpeg composites this PNG at its own top-left, so that center has to be computed explicitly.
  const centerXPx = overlay.x * framePixelWidth + w / 2;
  const centerYPx = overlay.y * framePixelHeight + h / 2;

  return {
    dataUrl: canvas.toDataURL("image/png"),
    xPx: Math.round(centerXPx - boundingWidth / 2),
    yPx: Math.round(centerYPx - boundingHeight / 2),
  };
}

// Applies one moment of a picture reveal to what's already drawn on `ctx` (whose transform is the
// box's own centred, rotated frame): the wipe's soft-edged mask, the light streak (only on the
// picture's own pixels), and the focus pull's blur/scale and fade. Same geometry as the preview's
// CSS (wipeMaskCss / ImageRevealWrap), so the two line up.
function applyImageReveal(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, state: ImageRevealState, settings: ImageRevealSettings, w: number, h: number): void {
  if (state.wipe < 1) {
    const { length, dx, dy } = wipeAxis(settings.direction, w, h);
    const s = state.soft * length;
    const edge = -s + (length + s) * state.wipe;
    // The gradient line starts at the box centre minus half its length along the direction.
    const sx = (-dx * length) / 2;
    const sy = (-dy * length) / 2;
    const g = ctx.createLinearGradient(sx + dx * edge, sy + dy * edge, sx + dx * (edge + s), sy + dy * (edge + s));
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = state.wipe <= 0 ? "rgba(0,0,0,0)" : g;
    ctx.fillRect(-w, -h, w * 2, h * 2);
    ctx.restore();
  }
  if (state.shine !== null) {
    // Along the box diagonal from its top-left corner, like the preview's CSS gradient.
    const L = Math.hypot(w, h);
    const ux = w / L;
    const uy = h / L;
    const band = 0.22 * L;
    const at = -band + (L + 2 * band) * state.shine;
    const ox = -w / 2;
    const oy = -h / 2;
    const g = ctx.createLinearGradient(ox + ux * (at - band), oy + uy * (at - band), ox + ux * (at + band), oy + uy * (at + band));
    const color = settings.shineColor ?? "#ffffff";
    g.addColorStop(0, withAlphaHex(color, 0));
    g.addColorStop(0.5, withAlphaHex(color, 0.85));
    g.addColorStop(1, withAlphaHex(color, 0));
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = g;
    ctx.fillRect(-w, -h, w * 2, h * 2);
    ctx.restore();
  }
  if (state.blur > 0 || state.scale !== 1 || state.opacity < 1) {
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext("2d")!.drawImage(canvas, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = state.opacity;
    if (state.blur > 0) ctx.filter = `blur(${state.blur * Math.min(w, h)}px)`;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(state.scale, state.scale);
    ctx.drawImage(copy, -canvas.width / 2, -canvas.height / 2);
    ctx.restore();
  }
}

const withAlphaHex = (hex: string, alpha: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(255,255,255,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

// A blur region's strength as its Gaussian's standard deviation, per unit of intensity, as a
// fraction of the frame's height - the preview's CSS blur() radius (VideoOverlayLayer) and the
// export's Gaussian (gaussian_blur_chain, conversion.rs) both use it, so they blur the same.
export const BLUR_SIGMA_FRACTION = 0.12;

// A plain axis-aligned rectangle (the common case) needs no mask at all - export_trimmed_video's
// crop+boxblur+overlay chain already produces exactly that shape on its own. Ellipse, rounded
// corners, and rotation can't be expressed as ffmpeg filter *parameters* the way a plain crop can,
// so they share one real solution instead of three: render the shape as a black/white mask
// (renderBlurMaskToPng below) and apply it via ffmpeg's alphamerge - this predicate is just "does
// this overlay actually need that".
export function blurNeedsMask(o: BlurOverlay): boolean {
  return o.shape === "ellipse" || !!(o.cornerRadius && o.cornerRadius > 0) || !!(o.rotation && o.rotation !== 0);
}

// Renders a BlurOverlay's shape as a solid-white-on-transparent mask PNG, sized/positioned to just
// the shape's own (rotation-aware) bounding box (same "canvas per overlay, not per frame" economy
// as renderTextOverlayToPng/renderImageOverlayToPng) - export_trimmed_video crops that same
// bounding box out of the live video, blurs it, and uses this mask's luma as its alpha channel
// (ffmpeg's `alphamerge`) before compositing back, so only the masked-in shape stays blurred and
// the rest of the crop reverts to the original (unblurred) pixels via the underlying `overlay`.
// Never called for a plain rectangle (see blurNeedsMask) - only exists to answer "what non-
// rectangular region, in pixels, does this overlay's current shape actually cover". Same rotation-
// aware bounding-box + translate/rotate-around-center technique as renderImageOverlayToPng above
// (see its own comment for why the canvas has to be sized to the *rotated* bounding box, and why
// xPx/yPx get recentered afterward).
export function renderBlurMaskToPng(overlay: BlurOverlay, framePixelWidth: number, framePixelHeight: number): RenderedBlurMaskPng | null {
  const w = overlay.width * framePixelWidth;
  const h = overlay.height * framePixelHeight;
  if (w <= 0 || h <= 0) return null;

  const rotationRad = ((overlay.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rotationRad));
  const sin = Math.abs(Math.sin(rotationRad));
  const boundingWidth = Math.max(1, Math.ceil(w * cos + h * sin));
  const boundingHeight = Math.max(1, Math.ceil(w * sin + h * cos));

  const canvas = document.createElement("canvas");
  canvas.width = boundingWidth;
  canvas.height = boundingHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.save();
  ctx.translate(boundingWidth / 2, boundingHeight / 2);
  ctx.rotate(rotationRad);
  ctx.fillStyle = "#ffffff";
  if (overlay.shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    roundedRectPath(ctx, -w / 2, -h / 2, w, h, (overlay.cornerRadius ?? 0) * framePixelHeight);
    ctx.fill();
  }
  ctx.restore();

  const centerXPx = overlay.x * framePixelWidth + w / 2;
  const centerYPx = overlay.y * framePixelHeight + h / 2;

  return {
    dataUrl: canvas.toDataURL("image/png"),
    xPx: Math.round(centerXPx - boundingWidth / 2),
    yPx: Math.round(centerYPx - boundingHeight / 2),
    widthPx: boundingWidth,
    heightPx: boundingHeight,
  };
}
