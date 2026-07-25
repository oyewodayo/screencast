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
import { invoke } from "@tauri-apps/api/tauri";
import { ImageOverlay, TextOverlay, TextOverlayCornerStyle } from "./videoEditTypes";
import { TEXT_FONT_FAMILY, measureTextBlock } from "../handlers/pdfAnnotationHandlers";

export interface RenderedOverlayPng {
  dataUrl: string;
  xPx: number;
  yPx: number;
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
export function renderTextOverlayToPng(overlay: TextOverlay, framePixelWidth: number, framePixelHeight: number): RenderedOverlayPng | null {
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
  const canvasHeight = Math.max(1, Math.ceil(textHeightPx + padding * 2));

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const baseFont = `${fontSizePx}px ${TEXT_FONT_FAMILY}`;
  ctx.font = baseFont;
  ctx.textBaseline = "top";

  if (overlay.backgroundColor) {
    ctx.fillStyle = overlay.backgroundColor;
    roundedRectPath(ctx, 0, 0, canvasWidth, canvasHeight, cornerRadiusPx(overlay.cornerStyle, canvasHeight));
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

  const drawSegment = (segment: string, x: number, y: number, font: string, fillColor: string): number => {
    ctx.font = font;
    if (hasStroke) {
      ctx.lineWidth = overlay.strokeWidth!;
      ctx.strokeStyle = overlay.strokeColor!;
      ctx.strokeText(segment, x, y);
    }
    ctx.fillStyle = fillColor;
    ctx.fillText(segment, x, y);
    return ctx.measureText(segment).width;
  };

  lines.forEach((line, i) => {
    const y = padding + i * lineHeight;

    if (!hasFormatting) {
      ctx.font = baseFont;
      const lineWidth = ctx.measureText(line.text).width;
      const xOffset = align === "center" ? (maxWidthPx - lineWidth) / 2 : align === "right" ? maxWidthPx - lineWidth : 0;
      drawSegment(line.text, padding + xOffset, y, baseFont, overlay.color);
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
    const segments: { text: string; font: string; color: string; width: number }[] = [];
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
      segments.push({ text: segment, font, color: coveringColor?.color ?? overlay.color, width });
      naturalWidth += width;
    }

    const xOffset = align === "center" ? (maxWidthPx - naturalWidth) / 2 : align === "right" ? maxWidthPx - naturalWidth : 0;
    let x = padding + xOffset;
    for (const seg of segments) {
      x += drawSegment(seg.text, x, y, seg.font, seg.color);
    }
  });

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
  const w = overlay.width * framePixelWidth;
  const h = overlay.height * framePixelHeight;
  if (w <= 0 || h <= 0) return null;

  // Loaded via a data: URL (read_image_data_url, Rust-side) rather than convertFileSrc's asset://
  // protocol + plain <img src> - that works fine for on-screen display, but the browser treats
  // asset:// as cross-origin, and drawing a cross-origin image into a canvas taints it, which
  // makes the toDataURL() call below throw ("Tainted canvases may not be exported"). A data: URL
  // has no origin of its own, so it never triggers that.
  let dataUrl: string;
  try {
    dataUrl = await invoke<string>("read_image_data_url", { path: overlay.src });
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
  if (!loaded) return null;

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
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
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
