// utils/docLetterhead.ts
//
// The document's letterhead: company stationery under every page. Kept in the Y.Doc's
// "docSettings" map beside the watermark and page chrome (docLayout.ts), so it syncs, undoes and
// comes back with a restored version.
//
// A letterhead is two sheet-sized SVGs - page 1 and the pages after it ("continuation", often a
// smaller mark or plain paper) - plus the text-safe area each leaves: where body text starts on
// page 1, on later pages, and how far above the bottom edge it must stop. However it was made
// (a Word letterhead - docxLetterhead.ts; a PDF or picture of one; or designed here -
// letterheadSources.ts), it ends up as these SVGs, so one renderer feeds every output, as the
// watermark does (docWatermark.ts):
//   - on screen, an overlay on each drawn sheet (DocLetterheadOverlay.tsx)
//   - in print/PDF, the @page background - page 1 through @page :first - with page 1's own top
//     margin (stationeryPrintCss)
//   - in Word, rasterised (letterheadPngBytes) and anchored behind the text in the first-page and
//     default headers, with a spacer that holds page 1's text below the letterhead (docDocx.ts)
// Page 1 can have a deeper top margin than the rest: the live pagination (docAutoPaginate.ts)
// gives page 1 its own text height for that.
import * as Y from "yjs";
import { docSettingsMap } from "./docLayout";
import type { DocMargins } from "./docTypes";
import { sheetBackground, svgDataUrl, type DocWatermark, type SheetGeometry } from "./docWatermark";

export interface DocLetterhead {
  name: string;
  first: string; // sheet SVG for page 1
  rest: string | null; // pages 2+; null = plain paper
  widthPx: number; // the sheet the SVGs were drawn for
  heightPx: number;
  firstTopIn: number; // body text starts here on page 1
  restTopIn: number; // ...and here on later pages
  bottomIn: number; // body text stops this far above the bottom edge
  leftIn: number | null; // the letterhead's own side margins, when it came with any
  rightIn: number | null;
  // The page margins before the letterhead was applied - restored when it's removed.
  previousMargins: DocMargins | null;
  // The colour the letterhead is built around (for "match the brand" touches), or null.
  brandColor: string | null;
}

const KEY = "letterhead";

const num = (v: unknown, def: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);
const isSvg = (v: unknown): v is string => typeof v === "string" && v.trimStart().startsWith("<svg");

export function normalizeLetterhead(v: unknown): DocLetterhead | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isSvg(o.first)) return null;
  const margins = (m: unknown): DocMargins | null => {
    if (!m || typeof m !== "object") return null;
    const r = m as Record<string, unknown>;
    return { top: num(r.top, 1, 0, 4), right: num(r.right, 1, 0, 4), bottom: num(r.bottom, 1, 0, 4), left: num(r.left, 1, 0, 4) };
  };
  return {
    name: typeof o.name === "string" ? o.name.slice(0, 120) : "Letterhead",
    first: o.first,
    rest: isSvg(o.rest) ? o.rest : null,
    widthPx: num(o.widthPx, 816, 100, 3000),
    heightPx: num(o.heightPx, 1056, 100, 4000),
    firstTopIn: num(o.firstTopIn, 1, 0, 8),
    restTopIn: num(o.restTopIn, 1, 0, 8),
    bottomIn: num(o.bottomIn, 1, 0, 8),
    leftIn: typeof o.leftIn === "number" ? num(o.leftIn, 1, 0, 4) : null,
    rightIn: typeof o.rightIn === "number" ? num(o.rightIn, 1, 0, 4) : null,
    previousMargins: margins(o.previousMargins),
    brandColor: typeof o.brandColor === "string" && /^#[0-9a-f]{6}$/i.test(o.brandColor) ? o.brandColor : null,
  };
}

export function readLetterhead(ydoc: Y.Doc | null): DocLetterhead | null {
  return ydoc ? normalizeLetterhead(docSettingsMap(ydoc).get(KEY)) : null;
}

export function writeLetterhead(ydoc: Y.Doc, lh: DocLetterhead | null): void {
  const m = docSettingsMap(ydoc);
  if (!lh) m.delete(KEY);
  else m.set(KEY, JSON.parse(JSON.stringify(lh)));
}

// The page margins a letterhead asks for: its text-safe area, with page 1's deeper top handled
// separately (firstTopIn). Sides come from the letterhead when it had its own, else stay as they are.
export function letterheadMargins(lh: DocLetterhead, current: DocMargins): DocMargins {
  return {
    top: Math.round(lh.restTopIn * 100) / 100,
    bottom: Math.round(lh.bottomIn * 100) / 100,
    left: lh.leftIn ?? current.left,
    right: lh.rightIn ?? current.right,
  };
}

// Page 1's top margin when it differs from the rest (null when it doesn't).
export function firstPageTop(lh: DocLetterhead | null, margins: DocMargins): number | null {
  if (!lh) return null;
  const t = Math.round(lh.firstTopIn * 100) / 100;
  return Math.abs(t - margins.top) > 0.005 ? t : null;
}

export const letterheadUrl = (svg: string | null) => (svg ? svgDataUrl(svg) : "");

// @page backgrounds for print: the watermark (if any) over the letterhead, page 1 with its own
// letterhead and top margin. Replaces printWatermarkCss when a letterhead is on.
export function stationeryPrintCss(
  wm: DocWatermark,
  wmUrl: string,
  lh: DocLetterhead | null,
  urls: { first: string; rest: string },
  firstTop: number | null,
  sheet: SheetGeometry
): string {
  const layers = (letterhead: string, withMark: boolean, top: number) => {
    const imgs = [withMark && wmUrl ? `url("${wmUrl}")` : "", letterhead ? `url("${letterhead}")` : ""].filter(Boolean);
    return imgs.length ? `background-image: ${imgs.join(", ")}; ${sheetBackground(sheet, top)}` : "background-image: none;";
  };
  if (!lh) return "";
  return [
    `@page { ${layers(urls.rest, !!wmUrl, sheet.top)} }`,
    `@page :first { ${layers(urls.first, !!wmUrl && !wm.skipFirstPage, firstTop ?? sheet.top)}${firstTop !== null ? ` margin-top: ${firstTop}in;` : ""} }`,
  ].join(" ");
}

// A letterhead sheet as PNG, for Word (and thumbnails). `scale` device px per CSS px.
export async function letterheadPngBytes(svg: string, widthPx: number, heightPx: number, scale = 2): Promise<Uint8Array | null> {
  const canvas = await letterheadCanvas(svg, widthPx, heightPx, scale);
  if (!canvas) return null;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

export async function letterheadCanvas(svg: string, widthPx: number, heightPx: number, scale: number): Promise<HTMLCanvasElement | null> {
  const img = new Image();
  img.src = svgDataUrl(svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(widthPx * scale);
  canvas.height = Math.round(heightPx * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// The most saturated, reasonably dark colour drawn in the letterhead - its brand colour, for
// offering to match headings to it. null for a black-and-white letterhead.
export async function brandColorOf(svg: string, widthPx: number, heightPx: number): Promise<string | null> {
  const canvas = await letterheadCanvas(svg, widthPx, heightPx, 0.25).catch(() => null);
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return null;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 40 || max > 245 || max < 40) continue; // greys, paper, near-black
    const key = `${r >> 5},${g >> 5},${b >> 5}`;
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += r;
    e.g += g;
    e.b += b;
    buckets.set(key, e);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
  if (!best || best.n < 6) return null;
  const hex = (v: number) => Math.round(v / best!.n).toString(16).padStart(2, "0");
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}
