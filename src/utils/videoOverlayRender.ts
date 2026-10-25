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
import { drawLayerMask, drawRevealCoverage, revealCoverageKey, revealMaskCanvas } from "./layerMask";
import { invoke } from "@tauri-apps/api/core";
import { BlurOverlay, ImageOverlay, TextOverlay, TextOverlayCornerStyle } from "./videoEditTypes";
import { measureTextBlock } from "../handlers/pdfAnnotationHandlers";
import { titleFontCss } from "./titleFonts";
import { CANVAS_TEXT_REVEALS, TextRevealState, isTextReveal, textRevealFrameKey, textRevealState } from "./textReveal";
import { IMAGE_REVEAL_FPS, ImageRevealSettings, ImageRevealState, imageRevealState, wipeAxis } from "./imageReveal";

// A text overlay with a title reveal (textReveal.ts) as the PNG frame sequence export burns in
// (OverlayFrames, conversion.rs) - each distinct moment once, the fully-typed title once.
// `fps`: the export's overlay rate (get_export_frame_rate).
export async function renderTextRevealFrames(
  overlay: TextOverlay,
  framePixelWidth: number,
  framePixelHeight: number,
  fps = 30
): Promise<{ unique: string[]; sequence: number[]; xPx: number; yPx: number } | null> {
  if (!isTextReveal(overlay.animation)) return null;
  const kind = overlay.animation;
  const duration = overlay.endTime - overlay.startTime;
  if (duration <= 0) return null;
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

// A text box's corner radius, in the same px as its box and font. "Rounded" is a share of the font
// size, so the curve keeps its shape from the small preview to a 4K export (and on any screen
// density); the canvas clamps it to half the box, as CSS does.
const ROUNDED_CORNER_EM = 0.3;
export function textCornerRadiusPx(style: TextOverlayCornerStyle | undefined, boxHeightPx: number, fontSizePx: number): number {
  if (style === "pill") return boxHeightPx / 2;
  if (style === "rounded") return Math.min(boxHeightPx / 2, fontSizePx * ROUNDED_CORNER_EM);
  return 0;
}

// A gradient's ends across a w x h box at `angle` (0 = top to bottom, 90 = left to right) - the
// same gradient line CSS's linear-gradient draws, so canvas and DOM boxes match.
function gradientLine(w: number, h: number, angle: number): [number, number, number, number] {
  const a = (angle * Math.PI) / 180;
  const half = (Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * h) / 2;
  return [w / 2 - Math.sin(a) * half, h / 2 - Math.cos(a) * half, w / 2 + Math.sin(a) * half, h / 2 + Math.cos(a) * half];
}

// The box's fill as CSS (the DOM preview and the editor) - a gradient when it has one.
export const textBoxBackgroundCss = (o: Pick<TextOverlay, "boxFill" | "backgroundColor">): string =>
  o.boxFill ? `linear-gradient(${180 - (o.boxFill.angle ?? 0)}deg, ${o.boxFill.from}, ${o.boxFill.to})` : o.backgroundColor ?? "transparent";

// The box's border as CSS: an inset ring, so it never changes the box's size or the text's wrap.
export const textBoxBorderCss = (o: Pick<TextOverlay, "boxBorder">, frameHeightPx: number): string | undefined =>
  o.boxBorder && o.boxBorder.width > 0 ? `inset 0 0 0 ${textStrokePx(o.boxBorder.width, frameHeightPx)}px ${o.boxBorder.color}` : undefined;

// A text stroke's width in pixels on a frame `frameHeightPx` tall - TextOverlay.strokeWidth is
// pixels at 1080 tall, so an outline keeps its weight from the small preview to a 4K export.
export const textStrokePx = (strokeWidth: number, frameHeightPx: number): number => (strokeWidth * frameHeightPx) / 1080;

// Whether the live preview draws this overlay with drawTextOverlay rather than as DOM text: its
// face, tracking, gradient, glow, shadow or a scaling/masking reveal only exist there.
export const usesCanvasText = (o: TextOverlay): boolean =>
  !!(o.fontFamily || o.letterSpacing || o.fill || o.glow || o.shadow || o.rotation) || (!!o.animation && CANVAS_TEXT_REVEALS.has(o.animation));

export interface DrawnTextOverlay {
  canvas: HTMLCanvasElement;
  // Where the canvas's top-left sits in the frame, in frame pixels.
  xPx: number;
  yPx: number;
}

// Draws a text overlay as the preview shows it - face (titleFonts.ts), tracking, gradient fill,
// glow, drop shadow, stroke, background box with its corner shape, per-character colour/bold/
// italic, alignment - onto a canvas sized to just its box plus room for effects that spill past it.
// `reveal` draws one moment of a letter-by-letter title reveal (textReveal.ts) - letters at their
// own opacity/offset/scale/turn/mask, plus the typewriter caret - instead of the finished text.
// `into` reuses a canvas (the live preview redraws every frame). A rotated title comes back turned
// about its box's centre, on a canvas big enough for it - unless `level`, for a preview that turns
// the box itself. "justify" falls back to left, as pdfAnnotationHandlers.ts's renderTextObject does.
export function drawTextOverlay(
  overlay: TextOverlay,
  framePixelWidth: number,
  framePixelHeight: number,
  reveal?: TextRevealState,
  into?: HTMLCanvasElement,
  level = false
): DrawnTextOverlay | null {
  const turn = level ? 0 : ((overlay.rotation ?? 0) % 360) * (Math.PI / 180);
  const drawn = drawLevelText(overlay, framePixelWidth, framePixelHeight, reveal, turn ? levelCanvasFor(into) : into);
  if (!drawn || !turn) return drawn;
  // Turned about the centre of what was drawn (the box, with room round it on every side).
  const src = drawn.canvas;
  const cos = Math.abs(Math.cos(turn));
  const sin = Math.abs(Math.sin(turn));
  const bw = Math.ceil(src.width * cos + src.height * sin);
  const bh = Math.ceil(src.width * sin + src.height * cos);
  const out = into ?? document.createElement("canvas");
  if (out.width !== bw || out.height !== bh) {
    out.width = bw;
    out.height = bh;
  }
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bw, bh);
  ctx.translate(bw / 2, bh / 2);
  ctx.rotate(turn);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas: out, xPx: Math.round(drawn.xPx + src.width / 2 - bw / 2), yPx: Math.round(drawn.yPx + src.height / 2 - bh / 2) };
}

// The level drawing a turned title is made from - one per reused output canvas.
const levelCanvases = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
function levelCanvasFor(into: HTMLCanvasElement | undefined): HTMLCanvasElement | undefined {
  if (!into) return undefined;
  let c = levelCanvases.get(into);
  if (!c) levelCanvases.set(into, (c = document.createElement("canvas")));
  return c;
}

// Line spacing as a multiple of the font size (TextOverlay.lineHeight).
export const DEFAULT_TEXT_LINE_HEIGHT = 1.3;
export const textLineHeight = (o: Pick<TextOverlay, "lineHeight">): number => o.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT;

// The text as shown (TextOverlay.textCase). Letter for letter - a capital that would be two letters
// (ß) keeps its own - so colour/bold runs and reveal states, which index letters, still line up.
export function caseText(text: string, textCase: TextOverlay["textCase"]): string {
  if (textCase !== "upper") return text;
  let out = "";
  for (const ch of text) {
    const up = ch.toUpperCase();
    out += up.length === ch.length ? up : ch;
  }
  return out;
}

// A text overlay's box padding in px - `y` top/bottom, `x` left/right. Undefined padding is the
// pre-existing fixed 2px look; see TextOverlay.padding / paddingX.
export function textPaddingPx(overlay: Pick<TextOverlay, "padding" | "paddingX">, framePixelHeight: number): { x: number; y: number } {
  const y = overlay.padding !== undefined ? overlay.padding * framePixelHeight : 2;
  return { x: overlay.paddingX !== undefined ? overlay.paddingX * framePixelHeight : y, y };
}

function drawLevelText(overlay: TextOverlay, framePixelWidth: number, framePixelHeight: number, reveal?: TextRevealState, into?: HTMLCanvasElement): DrawnTextOverlay | null {
  const text = overlay.text.trim();
  if (!text) return null;

  const fontSizePx = overlay.fontSize * framePixelHeight;
  // overlay.width is the whole box, padding included (the DOM preview's border-box): the letters
  // wrap inside it, less the side padding.
  const { x: padX, y: padding } = textPaddingPx(overlay, framePixelHeight);
  const boxWidthPx = overlay.width * framePixelWidth;
  // Padding wider than the box leaves a sliver, not nothing - text then wraps a letter a line, as CSS does.
  const maxWidthPx = Math.max(1, boxWidthPx - padX * 2);
  const fontFor = (run: { bold?: boolean; italic?: boolean } = {}) => titleFontCss(overlay.fontFamily, fontSizePx, run);
  const baseFont = fontFor();
  const spacingPx = (overlay.letterSpacing ?? 0) * fontSizePx;
  const shownText = caseText(overlay.text, overlay.textCase);
  const { lines, lineHeight, height: textHeightPx } = measureTextBlock(shownText, fontSizePx, maxWidthPx, { font: baseFont, letterSpacing: spacingPx, lineHeight: textLineHeight(overlay) });
  if (boxWidthPx <= 0 || textHeightPx <= 0) return null;

  const canvasWidth = Math.max(1, Math.ceil(boxWidthPx));
  const boxHeight = Math.max(1, Math.ceil(textHeightPx + padding * 2));
  // Room below the box for a reveal's accent underline (it hangs just under the box - RevealText).
  const underlineColor = reveal && overlay.reveal?.underline;
  const canvasHeight = underlineColor ? Math.ceil(boxHeight + fontSizePx * 0.25) : boxHeight;

  // Letters travel outside the box as they come in (scatter, drop, rise, zoom), and glow, shadows
  // and outlines spill past it - room for all of it all round.
  const strokePx = overlay.strokeColor && overlay.strokeWidth ? textStrokePx(overlay.strokeWidth, framePixelHeight) : 0;
  const bleed = Math.ceil(
    Math.max(
      reveal ? fontSizePx * (overlay.animation && CANVAS_TEXT_REVEALS.has(overlay.animation) ? 2.5 : 1.5) : 0,
      overlay.glow ? overlay.glow.size * fontSizePx * 2.5 : 0,
      overlay.shadow ? (Math.max(Math.abs(overlay.shadow.x), Math.abs(overlay.shadow.y)) + overlay.shadow.blur * 2) * fontSizePx : 0,
      strokePx
    )
  );
  const canvas = into ?? document.createElement("canvas");
  const cw = canvasWidth + 2 * bleed;
  const ch = canvasHeight + 2 * bleed;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const out = canvas.getContext("2d");
  if (!out) return null;
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalAlpha = 1;
  out.clearRect(0, 0, cw, ch);
  const boxRadius = textCornerRadiusPx(overlay.cornerStyle, boxHeight, fontSizePx);
  if (overlay.boxFill || overlay.backgroundColor) {
    out.globalAlpha = reveal ? reveal.fade : 1;
    out.translate(bleed, bleed);
    if (overlay.boxFill) {
      const g = out.createLinearGradient(...gradientLine(canvasWidth, boxHeight, overlay.boxFill.angle ?? 0));
      g.addColorStop(0, overlay.boxFill.from);
      g.addColorStop(1, overlay.boxFill.to);
      out.fillStyle = g;
    } else out.fillStyle = overlay.backgroundColor!;
    roundedRectPath(out, 0, 0, canvasWidth, boxHeight, boxRadius);
    out.fill();
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.globalAlpha = 1;
  }
  // The border, just inside the box's edge (CSS's inset ring) - its outer edge follows the corners.
  const borderPx = overlay.boxBorder ? textStrokePx(overlay.boxBorder.width, framePixelHeight) : 0;
  if (overlay.boxBorder && borderPx > 0) {
    out.globalAlpha = reveal ? reveal.fade : 1;
    out.translate(bleed, bleed);
    out.strokeStyle = overlay.boxBorder.color;
    out.lineWidth = borderPx;
    roundedRectPath(out, borderPx / 2, borderPx / 2, canvasWidth - borderPx, boxHeight - borderPx, Math.max(0, boxRadius - borderPx / 2));
    out.stroke();
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.globalAlpha = 1;
  }

  // The letters (outline and fill) go onto a layer of their own; shadow and glow are then cast by
  // that whole layer at once - a few blurs per frame however many letters are moving, not a few
  // per letter.
  const layer = glyphLayer(canvas, cw, ch);
  const ctx = layer.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, cw, ch);
  ctx.translate(bleed, bleed);

  ctx.font = baseFont;
  ctx.letterSpacing = `${spacingPx}px`;
  ctx.textBaseline = "top";
  if (reveal) ctx.globalAlpha = reveal.fade;
  // Where the letters sit in each line, exactly as CSS places them (the DOM preview, and the box
  // the text is measured into): the font's ascent-to-descent band centred in the line height, the
  // leftover leading split evenly above and below. Drawing from the line's top edge instead left
  // all of the leading underneath, so text sat visibly high in its box.
  // (Measured against the "top" baseline the letters are drawn from.)
  const faceMetrics = ctx.measureText("Hg");
  const faceAscent = faceMetrics.fontBoundingBoxAscent ?? 0;
  const faceDescent = faceMetrics.fontBoundingBoxDescent ?? fontSizePx;
  const glyphTop = (lineHeight - (faceAscent + faceDescent)) / 2 + faceAscent;

  const colorRuns = overlay.colorRuns ?? [];
  const boldRuns = overlay.boldRuns ?? [];
  const italicRuns = overlay.italicRuns ?? [];
  const hasFormatting = colorRuns.length > 0 || boldRuns.length > 0 || italicRuns.length > 0;
  const align = overlay.textAlign === "justify" ? "left" : overlay.textAlign ?? "left";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  // The gradient runs across the whole text block, so every letter takes its colour from where it
  // sits - letters revealed one at a time still read as one gradient.
  let gradient: CanvasGradient | null = null;
  if (overlay.fill) {
    const a = ((overlay.fill.angle ?? 0) * Math.PI) / 180;
    const gx = canvasWidth / 2;
    const gy = padding + textHeightPx / 2;
    const half = Math.abs(Math.sin(a)) * (maxWidthPx / 2) + Math.abs(Math.cos(a)) * (textHeightPx / 2);
    gradient = ctx.createLinearGradient(gx - Math.sin(a) * half, gy - Math.cos(a) * half, gx + Math.sin(a) * half, gy + Math.cos(a) * half);
    gradient.addColorStop(0, overlay.fill.from);
    gradient.addColorStop(1, overlay.fill.to);
  }

  // The outline, then the letters on top of it.
  const drawPlain = (segment: string, x: number, y: number, fillColor: string): void => {
    const fill = gradient && fillColor === overlay.color ? gradient : fillColor;
    if (strokePx) {
      ctx.lineWidth = strokePx;
      ctx.strokeStyle = overlay.strokeColor!;
      ctx.strokeText(segment, x, y);
    }
    ctx.fillStyle = fill;
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
      const w = ctx.measureText(ch).width;
      const { opacity, dy, dx = 0, blur = 0, scale = 1, rotate = 0, clip = false, glyph } = reveal.char(absStart + j);
      if (opacity > 0 && scale > 0.001) {
        ctx.save();
        ctx.globalAlpha = fade * opacity;
        if (clip) {
          // Hidden below the line it belongs to - the letter rises out of that edge.
          ctx.beginPath();
          ctx.rect(cx - fontSizePx, y - lineHeight, w + 2 * fontSizePx, lineHeight + (lineHeight + fontSizePx) / 2);
          ctx.clip();
        }
        if (blur > 0.001) ctx.filter = `blur(${blur * fontSizePx}px)`;
        if (scale !== 1 || rotate) {
          const ox = cx + w / 2;
          const oy = y + fontSizePx * 0.55;
          ctx.translate(ox, oy);
          if (rotate) ctx.rotate((rotate * Math.PI) / 180);
          ctx.scale(scale, scale);
          ctx.translate(-ox, -oy);
        }
        // A rolling stand-in is centred in the real letter's room.
        const shown = glyph ?? ch;
        const off = glyph ? (w - ctx.measureText(glyph).width) / 2 : 0;
        drawPlain(shown, cx + off + dx * fontSizePx, y + dy * fontSizePx, fillColor);
        ctx.restore();
      }
      cx += w;
    }
    if (reveal.caretAt === overlay.text.length && absStart + segment.length === overlay.text.length) drawCaret(cx, y, fillColor);
    return cx - x;
  };

  lines.forEach((line, i) => {
    const y = padding + i * lineHeight + glyphTop;

    if (!hasFormatting) {
      ctx.font = baseFont;
      // Tracking adds space after the last letter too - leave it out when centring.
      const lineWidth = Math.max(0, ctx.measureText(line.text).width - (line.text ? spacingPx : 0));
      const xOffset = align === "center" ? (maxWidthPx - lineWidth) / 2 : align === "right" ? maxWidthPx - lineWidth : 0;
      drawSegment(line.text, padX + xOffset, y, baseFont, overlay.color, line.startOffset);
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
      const font = fontFor({ bold: isBold, italic: isItalic });
      ctx.font = font;
      const width = ctx.measureText(segment).width;
      segments.push({ text: segment, font, color: coveringColor?.color ?? overlay.color, width, start: absoluteStart });
      naturalWidth += width;
    }
    if (line.text) naturalWidth -= spacingPx;

    const xOffset = align === "center" ? (maxWidthPx - naturalWidth) / 2 : align === "right" ? maxWidthPx - naturalWidth : 0;
    let x = padX + xOffset;
    for (const seg of segments) {
      x += drawSegment(seg.text, x, y, seg.font, seg.color, seg.start);
    }
  });

  if (underlineColor && reveal.underline > 0) {
    ctx.globalAlpha = reveal.fade;
    ctx.fillStyle = underlineColor;
    roundedRectPath(ctx, padX, boxHeight + fontSizePx * 0.08, maxWidthPx * reveal.underline, fontSizePx * 0.09, fontSizePx * 0.05);
    ctx.fill();
  }
  ctx.letterSpacing = "0px";

  // Shadow, then glow (a wide soft halo and a tight bright one - a neon tube's light, not a
  // smudge), then the letters. Each pass draws the layer far off the canvas and moves only its
  // shadow back into place, so the pass leaves just the shadow.
  const OFF = cw + ch + 1000;
  const cast = (color: string, blur: number, dx: number, dy: number) => {
    out.save();
    out.shadowColor = color;
    out.shadowBlur = blur;
    out.shadowOffsetX = dx + OFF;
    out.shadowOffsetY = dy;
    out.drawImage(layer, -OFF, 0);
    out.restore();
  };
  if (overlay.shadow) cast(overlay.shadow.color, overlay.shadow.blur * fontSizePx, overlay.shadow.x * fontSizePx, overlay.shadow.y * fontSizePx);
  if (overlay.glow) for (const k of [1, 0.35]) cast(overlay.glow.color, overlay.glow.size * fontSizePx * k, 0, 0);
  out.drawImage(layer, 0, 0);

  // The box's top-left is the overlay's x/y, padding inside it - as the preview lays it out.
  return {
    canvas,
    xPx: Math.round(overlay.x * framePixelWidth) - bleed,
    yPx: Math.round(overlay.y * framePixelHeight) - bleed,
  };
}

// The letters' own layer for drawTextOverlay - one per output canvas, reused frame to frame.
const glyphLayers = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
function glyphLayer(canvas: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  let layer = glyphLayers.get(canvas);
  if (!layer) glyphLayers.set(canvas, (layer = document.createElement("canvas")));
  if (layer.width !== w || layer.height !== h) {
    layer.width = w;
    layer.height = h;
  }
  return layer;
}

// drawTextOverlay as a standalone transparent PNG, for export burn-in. Export first makes sure the
// overlays' faces are loaded (loadTitleFonts) - a canvas draws the fallback face otherwise.
export function renderTextOverlayToPng(overlay: TextOverlay, framePixelWidth: number, framePixelHeight: number, reveal?: TextRevealState): RenderedOverlayPng | null {
  const drawn = drawTextOverlay(overlay, framePixelWidth, framePixelHeight, reveal);
  return drawn ? { dataUrl: drawn.canvas.toDataURL("image/png"), xPx: drawn.xPx, yPx: drawn.yPx } : null;
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

// Whether a picture overlay changes over its time on screen - a reveal (imageReveal.ts) or a mask
// that opens (layerMask.ts reveals) - and so exports as a frame sequence.
export const imageOverlayAnimates = (o: ImageOverlay): boolean => !!o.reveal || (!o.asset && !!o.mask?.reveal);

// A picture overlay's reveal (imageReveal.ts) and/or opening mask, as the PNG frame sequence export
// burns in - the image decoded once, each distinct moment drawn once (the settled picture, and each
// shine phase, are shared by every frame that shows them).
export async function renderImageRevealFrames(
  overlay: ImageOverlay,
  framePixelWidth: number,
  framePixelHeight: number,
  fps = IMAGE_REVEAL_FPS
): Promise<{ unique: string[]; sequence: number[]; xPx: number; yPx: number } | null> {
  const settings = overlay.reveal;
  const duration = overlay.endTime - overlay.startTime;
  if (!imageOverlayAnimates(overlay) || duration <= 0) return null;
  const img = await loadOverlayImage(overlay.src);
  if (!img) return null;
  // An opening mask: its picture drawn once at the box's export size, placed per frame.
  const mask = !overlay.asset && overlay.mask?.reveal ? overlay.mask : null;
  const boxW = Math.max(1, Math.round(overlay.width * framePixelWidth));
  const boxH = Math.max(1, Math.round(overlay.height * framePixelHeight));
  const pic = mask ? revealMaskCanvas(mask, boxW, boxH, false) : null;
  const total = Math.max(1, Math.ceil(duration * fps));
  const unique: string[] = [];
  const sequence: number[] = [];
  const keyIndex = new Map<string, number>();
  let origin: { xPx: number; yPx: number } | null = null;
  for (let k = 0; k < total; k++) {
    const t = k / fps;
    const state = settings ? imageRevealState(settings, t, duration, fps) : undefined;
    const key = `${state?.key ?? "still"}|${mask ? revealCoverageKey(mask, t, duration, boxW, boxH) : ""}`;
    let idx = keyIndex.get(key);
    if (idx === undefined) {
      const rendered = drawImageOverlayPng(overlay, img, framePixelWidth, framePixelHeight, state, mask && pic ? { pic, local: t, span: duration } : undefined);
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

// Draws a picture overlay - at one moment of its reveal when `reveal` is given, and of its opening
// mask when `maskReveal` is - to its own PNG.
function drawImageOverlayPng(
  overlay: ImageOverlay,
  img: HTMLImageElement,
  framePixelWidth: number,
  framePixelHeight: number,
  reveal?: ImageRevealState,
  maskReveal?: { pic: ReturnType<typeof revealMaskCanvas>; local: number; span: number }
): RenderedOverlayPng | null {
  const w = overlay.width * framePixelWidth;
  const h = overlay.height * framePixelHeight;
  if (w <= 0 || h <= 0) return null;

  const rotationRad = ((overlay.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rotationRad));
  const sin = Math.abs(Math.sin(rotationRad));
  // A thick frame sits outside the box, and a shadow spills past it - room for both all round.
  const framePx = overlay.borderColor && overlay.borderWidth ? overlay.borderWidth * framePixelHeight : 0;
  const pad = Math.ceil(framePx + (overlay.shadow && framePx ? 28 : 0));
  const boundingWidth = Math.max(1, Math.ceil(w * cos + h * sin)) + 2 * pad;
  const boundingHeight = Math.max(1, Math.ceil(w * sin + h * cos)) + 2 * pad;

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
    roundedRectPath(ctx, -w / 2 - framePx, -h / 2 - framePx, w + 2 * framePx, h + 2 * framePx, radius);
    ctx.fill();
    ctx.restore();
  }
  if (framePx) {
    ctx.save();
    ctx.globalAlpha = overlay.opacity;
    ctx.fillStyle = overlay.borderColor!;
    roundedRectPath(ctx, -w / 2 - framePx, -h / 2 - framePx, w + 2 * framePx, h + 2 * framePx, radius);
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
  if (overlay.mask) {
    // Masked (layerMask.ts): the picture on its own box-sized canvas, cut by the same mask picture
    // the preview masks with, then placed - border and shadow stay whole, as in the preview.
    ctx.restore();
    const pw = Math.max(1, Math.round(w));
    const ph = Math.max(1, Math.round(h));
    const pic = document.createElement("canvas");
    pic.width = pw;
    pic.height = ph;
    const p = pic.getContext("2d");
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = pw;
    maskCanvas.height = ph;
    const m = maskCanvas.getContext("2d");
    if (p && m) {
      roundedRectPath(p, 0, 0, pw, ph, radius);
      p.clip();
      p.translate(pw / 2, ph / 2);
      if (overlay.flipHorizontal || overlay.flipVertical) p.scale(overlay.flipHorizontal ? -1 : 1, overlay.flipVertical ? -1 : 1);
      p.drawImage(img, sx, sy, sWidth, sHeight, -pw / 2, -ph / 2, pw, ph);
      if (maskReveal) drawRevealCoverage(m, overlay.mask, maskReveal.pic, maskReveal.local, maskReveal.span, pw, ph);
      else drawLayerMask(m, { mask: overlay.mask }, pw, ph);
      p.setTransform(1, 0, 0, 1, 0, 0);
      p.globalCompositeOperation = "destination-in";
      p.drawImage(maskCanvas, 0, 0);
      ctx.save();
      ctx.globalAlpha = overlay.opacity;
      ctx.drawImage(pic, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
  } else {
    ctx.drawImage(img, sx, sy, sWidth, sHeight, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  if (overlay.borderColor && !framePx) {
    ctx.save();
    ctx.globalAlpha = overlay.opacity;
    ctx.strokeStyle = overlay.borderColor;
    ctx.lineWidth = 3;
    roundedRectPath(ctx, -w / 2 + 1.5, -h / 2 + 1.5, w - 3, h - 3, radius);
    ctx.stroke();
    ctx.restore();
  }

  if (reveal && overlay.reveal) applyImageReveal(ctx, canvas, reveal, overlay.reveal, w, h);

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
