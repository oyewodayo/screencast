// utils/thumbnailLayers.ts
//
// Text and logo/image layers on top of a video thumbnail (ThumbnailPicker's editor), plus the one
// canvas renderer that turns them into the final picture. Every measurement is a fraction of the
// base picture - position as its centre in 0..1 of width/height, text size as a fraction of its
// height, an image's width as a fraction of its width - so the on-screen preview (CSS, at whatever
// size the dialog is) and the saved image (canvas, at the picture's real size) are the same layout.
// textBoxStyle() and drawText() are the two halves of that contract and must stay in step.
import type React from "react";

export const THUMB_FONTS = [
  { label: "Clean", family: '"Segoe UI", system-ui, sans-serif' },
  { label: "Heavy", family: '"Arial Black", "Segoe UI Black", sans-serif' },
  { label: "Impact", family: 'Impact, "Arial Narrow Bold", sans-serif' },
  { label: "Modern", family: 'Bahnschrift, "Segoe UI", sans-serif' },
  { label: "Serif", family: 'Georgia, "Times New Roman", serif' },
  { label: "Mono", family: 'Consolas, "Courier New", monospace' },
  { label: "Script", family: '"Segoe Script", "Brush Script MT", cursive' },
] as const;

export interface TextLayer {
  id: string;
  kind: "text";
  text: string;
  x: number;
  y: number;
  size: number; // font size as a fraction of the picture's height
  font: string; // a THUMB_FONTS family
  color: string;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  align: "left" | "center" | "right";
  outline: string | null; // outline colour, or none
  shadow: boolean;
  background: string | null; // a pill behind the text, or none
}

export interface ImageLayer {
  id: string;
  kind: "image";
  src: string; // loadable URL (asset://)
  name: string;
  x: number;
  y: number;
  width: number; // fraction of the picture's width
  aspect: number; // natural height / width
  opacity: number;
  rounded: boolean;
}

export type ThumbLayer = TextLayer | ImageLayer;

const LINE_HEIGHT = 1.15;
const OUTLINE = 0.16; // stroke width vs font size (half of it shows - drawn under the fill)
const SHADOW_BLUR = 0.18;
const SHADOW_Y = 0.06;
const PAD_X = 0.45;
const PAD_Y = 0.2;
const RADIUS = 0.25;
const IMAGE_RADIUS = 0.08; // of the image's own width

export const newTextLayer = (patch: Partial<TextLayer> = {}): TextLayer => ({
  id: crypto.randomUUID(),
  kind: "text",
  text: "Your title",
  x: 0.5,
  y: 0.5,
  size: 0.12,
  font: THUMB_FONTS[1].family,
  color: "#ffffff",
  bold: true,
  italic: false,
  uppercase: false,
  align: "center",
  outline: "#000000",
  shadow: true,
  background: null,
  ...patch,
});

// One-click starting points - each a complete look, tuned to read at gallery-tile size.
export const TEXT_PRESETS: { label: string; hint: string; make: () => TextLayer }[] = [
  { label: "Bold title", hint: "Big, outlined - reads at any size", make: () => newTextLayer({ text: "YOUR TITLE", uppercase: true, font: THUMB_FONTS[2].family, size: 0.16, y: 0.22 }) },
  { label: "Subtitle", hint: "Smaller line under a title", make: () => newTextLayer({ text: "Subtitle", bold: false, font: THUMB_FONTS[0].family, size: 0.07, y: 0.36, outline: null }) },
  { label: "Caption bar", hint: "White on a dark bar, near the bottom", make: () => newTextLayer({ text: "Caption", font: THUMB_FONTS[0].family, size: 0.07, y: 0.85, outline: null, shadow: false, background: "rgba(0,0,0,0.72)" }) },
  { label: "Badge", hint: "A small coloured label (NEW, PART 2...)", make: () => newTextLayer({ text: "NEW", uppercase: true, font: THUMB_FONTS[3].family, size: 0.065, x: 0.12, y: 0.12, outline: null, shadow: false, background: "#ef4444" }) },
];

export const SWATCHES = ["#ffffff", "#000000", "#facc15", "#ef4444", "#22c55e", "#3b82f6", "#a855f7", "#f97316"];

const shownText = (l: TextLayer) => (l.uppercase ? l.text.toUpperCase() : l.text);

// CSS for a text layer drawn over a preview `stageHeight` px tall - mirrors drawText exactly.
export const textBoxStyle = (l: TextLayer, stageHeight: number): React.CSSProperties => {
  const px = l.size * stageHeight;
  return {
    fontFamily: l.font,
    fontSize: px,
    fontWeight: l.bold ? 800 : 400,
    fontStyle: l.italic ? "italic" : "normal",
    color: l.color,
    lineHeight: LINE_HEIGHT,
    textAlign: l.align,
    whiteSpace: "pre",
    padding: l.background ? `${PAD_Y * px}px ${PAD_X * px}px` : 0,
    background: l.background ?? undefined,
    borderRadius: l.background ? RADIUS * px : undefined,
    WebkitTextStroke: l.outline ? `${OUTLINE * px}px ${l.outline}` : undefined,
    paintOrder: "stroke fill",
    textShadow: l.shadow ? `0 ${SHADOW_Y * px}px ${SHADOW_BLUR * px}px rgba(0,0,0,0.55)` : undefined,
  };
};

export const shownTextOf = shownText;

const drawText = (ctx: CanvasRenderingContext2D, l: TextLayer, W: number, H: number) => {
  const px = l.size * H;
  ctx.save();
  ctx.font = `${l.italic ? "italic " : ""}${l.bold ? 800 : 400} ${px}px ${l.font}`;
  const lines = shownText(l).split("\n");
  const widths = lines.map((line) => ctx.measureText(line).width);
  const lineH = px * LINE_HEIGHT;
  const padX = l.background ? PAD_X * px : 0;
  const padY = l.background ? PAD_Y * px : 0;
  const boxW = Math.max(0, ...widths) + padX * 2;
  const boxH = lines.length * lineH + padY * 2;
  const left = l.x * W - boxW / 2;
  const top = l.y * H - boxH / 2;
  if (l.background) {
    ctx.fillStyle = l.background;
    ctx.beginPath();
    ctx.roundRect(left, top, boxW, boxH, RADIUS * px);
    ctx.fill();
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = l.align;
  const xFor = l.align === "left" ? left + padX : l.align === "right" ? left + boxW - padX : left + boxW / 2;
  lines.forEach((line, i) => {
    const y = top + padY + (i + 0.5) * lineH;
    if (l.shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur = SHADOW_BLUR * px;
      ctx.shadowOffsetY = SHADOW_Y * px;
    }
    if (l.outline) {
      ctx.lineJoin = "round";
      ctx.lineWidth = OUTLINE * px;
      ctx.strokeStyle = l.outline;
      ctx.strokeText(line, xFor, y);
      ctx.shadowColor = "transparent"; // one shadow, under the outline - not a second over it
    }
    ctx.fillStyle = l.color;
    ctx.fillText(line, xFor, y);
  });
  ctx.restore();
};

export const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    // Required to export the canvas afterwards (asset:// images taint it otherwise).
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't load ${src}`));
    img.src = src;
  });

// The finished thumbnail: base picture + every layer, as JPEG bytes. Capped at 1920 wide - the
// backend stores covers at up to 1280, so anything larger is just a bigger IPC payload.
export const composeThumbnail = async (baseSrc: string, layers: ThumbLayer[]): Promise<number[]> => {
  await document.fonts.ready;
  const base = await loadImage(baseSrc);
  const scale = Math.min(1, 1920 / base.naturalWidth);
  const W = Math.round(base.naturalWidth * scale);
  const H = Math.round(base.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(base, 0, 0, W, H);
  for (const l of layers) {
    if (l.kind === "text") {
      drawText(ctx, l, W, H);
      continue;
    }
    const img = await loadImage(l.src);
    const w = l.width * W;
    const h = w * l.aspect;
    ctx.save();
    ctx.globalAlpha = l.opacity;
    if (l.rounded) {
      ctx.beginPath();
      ctx.roundRect(l.x * W - w / 2, l.y * H - h / 2, w, h, IMAGE_RADIUS * w);
      ctx.clip();
    }
    ctx.drawImage(img, l.x * W - w / 2, l.y * H - h / 2, w, h);
    ctx.restore();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) throw new Error("Couldn't encode the thumbnail");
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
};

export const imageRadiusFraction = IMAGE_RADIUS;
