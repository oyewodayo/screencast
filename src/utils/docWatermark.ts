// utils/docWatermark.ts
//
// The page watermark - a word ("DRAFT", "CONFIDENTIAL"...) or an image (a logo, a seal) faintly
// across every page. Kept in the Y.Doc's "docSettings" map (docLayout.ts) beside the page chrome,
// so it syncs, undoes and comes back with a restored version.
//
// One renderer feeds all three outputs: watermarkSvg draws the whole sheet as an SVG, which is
//   - on screen, the background of an overlay on each drawn sheet (DocWatermarkOverlay.tsx),
//   - in print/PDF, the @page background (printWatermarkCss) - Chromium paints it on every sheet,
//     behind the text, and @page :first can leave the title page out,
//   - in Word, rasterised to a PNG (watermarkPngBytes) and anchored behind the text in the
//     page header, which Word repeats on every page.
// The SVG is drawn standalone (an image, not part of the page), so it can only use fonts the system
// has - hence the fixed font stacks below rather than the document's own face.
import * as Y from "yjs";
import { docSettingsMap } from "./docLayout";

export type WatermarkKind = "none" | "text" | "image";
export type WatermarkFont = "sans" | "serif";
export type WatermarkLayout = "diagonal" | "horizontal";
export type WatermarkSize = "fit" | "large" | "medium" | "small";

export interface DocWatermark {
  kind: WatermarkKind;
  text: string;
  font: WatermarkFont;
  bold: boolean;
  size: WatermarkSize;
  layout: WatermarkLayout;
  color: string; // #rrggbb
  opacity: number; // 0.03-1
  image: string | null; // data: URL
  imageAspect: number; // width / height
  imageScale: number; // fraction of the page width, 0.1-1
  washout: boolean; // greyscale, as Word's "Washout"
  skipFirstPage: boolean;
}

export const DEFAULT_WATERMARK: DocWatermark = {
  kind: "none",
  text: "DRAFT",
  font: "sans",
  bold: true,
  size: "fit",
  layout: "diagonal",
  color: "#9e9e9e",
  opacity: 0.3,
  image: null,
  imageAspect: 1,
  imageScale: 0.6,
  washout: true,
  skipFirstPage: false,
};

export const WATERMARK_PRESETS = ["DRAFT", "CONFIDENTIAL", "DO NOT COPY", "SAMPLE", "URGENT", "APPROVED", "PRELIMINARY"];

export const WATERMARK_COLORS: { value: string; label: string }[] = [
  { value: "#9e9e9e", label: "Grey" },
  { value: "#d32f2f", label: "Red" },
  { value: "#1565c0", label: "Blue" },
  { value: "#2e7d32", label: "Green" },
  { value: "#ef6c00", label: "Orange" },
  { value: "#212121", label: "Black" },
];

const FONT_STACK: Record<WatermarkFont, string> = {
  sans: "Arial, Helvetica, 'Segoe UI', sans-serif",
  serif: "'Times New Roman', Georgia, serif",
};

const SIZE_FACTOR: Record<WatermarkSize, number> = { fit: 1, large: 0.75, medium: 0.55, small: 0.38 };

const KEY = "watermark";
// A watermark image is downscaled before it's stored (see the dialog); this is the hard ceiling.
const MAX_IMAGE_CHARS = 3_000_000;

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

export function normalizeWatermark(v: unknown): DocWatermark {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const d = DEFAULT_WATERMARK;
  const image = typeof o.image === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(o.image) && o.image.length <= MAX_IMAGE_CHARS ? o.image : null;
  const kind = oneOf<WatermarkKind>(o.kind, ["none", "text", "image"], "none");
  return {
    kind: kind === "image" && !image ? "none" : kind,
    text: typeof o.text === "string" ? o.text.slice(0, 60) : d.text,
    font: oneOf<WatermarkFont>(o.font, ["sans", "serif"], d.font),
    bold: typeof o.bold === "boolean" ? o.bold : d.bold,
    size: oneOf<WatermarkSize>(o.size, ["fit", "large", "medium", "small"], d.size),
    layout: oneOf<WatermarkLayout>(o.layout, ["diagonal", "horizontal"], d.layout),
    color: typeof o.color === "string" && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color.toLowerCase() : d.color,
    opacity: clamp(o.opacity, 0.03, 1, d.opacity),
    image,
    imageAspect: clamp(o.imageAspect, 0.05, 20, 1),
    imageScale: clamp(o.imageScale, 0.1, 1, d.imageScale),
    washout: typeof o.washout === "boolean" ? o.washout : d.washout,
    skipFirstPage: o.skipFirstPage === true,
  };
}

export function readWatermark(ydoc: Y.Doc | null): DocWatermark {
  return ydoc ? normalizeWatermark(docSettingsMap(ydoc).get(KEY)) : DEFAULT_WATERMARK;
}

export function writeWatermark(ydoc: Y.Doc, wm: DocWatermark): void {
  const m = docSettingsMap(ydoc);
  // Settings are kept while switched off, so turning it back on restores the last design.
  m.set(KEY, { ...wm });
}

export function hasWatermark(wm: DocWatermark): boolean {
  return (wm.kind === "text" && wm.text.trim() !== "") || (wm.kind === "image" && !!wm.image);
}

export function sameWatermark(a: DocWatermark, b: DocWatermark): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function xml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

// The whole sheet, width x height px (CSS pixels), with the watermark centred on it. Empty string
// when there's nothing to draw.
export function watermarkSvg(wm: DocWatermark, width: number, height: number): string {
  if (!hasWatermark(wm)) return "";
  const cx = width / 2;
  const cy = height / 2;
  let body: string;
  if (wm.kind === "text") {
    const text = wm.text.trim();
    const diagonal = wm.layout === "diagonal";
    const angle = diagonal ? -(Math.atan2(height, width) * 180) / Math.PI : 0;
    // Fit: the word runs ~75% of the diagonal (or 80% of the width), as Word's "Auto" size does,
    // estimated from an average capital's advance; never taller than a quarter of the page.
    const span = diagonal ? Math.hypot(width, height) * 0.75 : width * 0.8;
    const advance = wm.bold ? 0.68 : 0.62;
    const fit = Math.min(span / (Math.max(1, [...text].length) * advance), height * 0.25);
    const size = Math.round(fit * SIZE_FACTOR[wm.size] * 10) / 10;
    body =
      `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="${xml(FONT_STACK[wm.font])}" ` +
      `font-weight="${wm.bold ? 700 : 400}" font-size="${size}" fill="${wm.color}" fill-opacity="${wm.opacity}" ` +
      `transform="rotate(${angle.toFixed(2)} ${cx} ${cy})">${xml(text)}</text>`;
  } else {
    const w = width * wm.imageScale;
    let h = w / wm.imageAspect;
    let iw = w;
    if (h > height * 0.9) {
      h = height * 0.9;
      iw = h * wm.imageAspect;
    }
    const filter = wm.washout ? `<filter id="w"><feColorMatrix type="saturate" values="0"/></filter>` : "";
    body =
      `${filter}<image href="${wm.image}" x="${(cx - iw / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${iw.toFixed(1)}" height="${h.toFixed(1)}" ` +
      `opacity="${wm.opacity}" preserveAspectRatio="xMidYMid meet"${wm.washout ? ' filter="url(#w)"' : ""}/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// The @page background for print. Comes after the page's own @page rule (DocsEditor.tsx), whose
// background shorthand carries the page colour; this rule only adds the image on top of it.
export function printWatermarkCss(wm: DocWatermark, dataUrl: string): string {
  if (!dataUrl) return "";
  const rule = `@page { background-image: url("${dataUrl}"); background-position: center; background-size: 100% 100%; background-repeat: no-repeat; }`;
  return wm.skipFirstPage ? `${rule}\n@page :first { background-image: none; }` : rule;
}

// The watermark as a PNG of the whole sheet, for Word (which can't take an SVG watermark).
// `scale` is device pixels per CSS pixel - 1.5 is 144 dpi.
export async function watermarkPngBytes(wm: DocWatermark, width: number, height: number, scale = 1.5): Promise<Uint8Array | null> {
  const svg = watermarkSvg(wm, width, height);
  if (!svg) return null;
  const img = new Image();
  img.src = svgDataUrl(svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

// A picked image file, downscaled so the document stays light (the image lives in the Y.Doc):
// at most 1600px on its long side, PNG to keep transparency. Resolves to the data URL and aspect.
export async function prepareWatermarkImage(file: Blob): Promise<{ image: string; aspect: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    let image = canvas.toDataURL("image/png");
    // A large photo can still be heavy as PNG; JPEG then (a photo rarely needs transparency).
    if (image.length > 1_500_000) image = canvas.toDataURL("image/jpeg", 0.85);
    return { image, aspect: canvas.width / canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
