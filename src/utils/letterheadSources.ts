// utils/letterheadSources.ts
//
// Everything a letterhead can come from, turned into a DocLetterhead (docLetterhead.ts):
//   - a Word document or template (.docx/.dotx): its header and footer, drawn faithfully by
//     docxLetterhead.ts, with Word's own text-safe area
//   - a PDF: page 1 (and page 2 as the continuation sheet, when there is one), rendered by pdf.js
//   - a picture: a whole sheet when it has a page's proportions, else a banner across the top (or
//     bottom) edge
//   - the designer (DocLetterheadDialog.tsx): company name, logo, address and contact lines in
//     one of a few house layouts, drawn here as SVG
// For pictures and PDFs the text-safe area is read from the ink itself (detectSafeArea): where the
// top band of the letterhead ends and the bottom band begins, ignoring full-height side strips
// (which become a side margin instead).
import JSZip from "jszip";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { renderDocxLetterhead, type DocxLetterhead } from "./docxLetterhead";
import { brandColorOf, type DocLetterhead } from "./docLetterhead";

export const SHEETS = {
  a4: { widthPx: 793.7, heightPx: 1122.5 },
  letter: { widthPx: 816, heightPx: 1056 },
} as const;

const blankLetterhead = (name: string, widthPx: number, heightPx: number): Omit<DocLetterhead, "first"> => ({
  name,
  rest: null,
  widthPx,
  heightPx,
  firstTopIn: 1,
  restTopIn: 1,
  bottomIn: 1,
  leftIn: null,
  rightIn: null,
  previousMargins: null,
  brandColor: null,
});

const imageSheet = (href: string, w: number, h: number, x = 0, y = 0, sw = w, sh = h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}" viewBox="0 0 ${sw} ${sh}"><image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none"/></svg>`;

// ------------------------------------------------------------------------------------------------
// Ink analysis

export interface SafeArea {
  topIn: number;
  bottomIn: number;
  leftIn: number | null;
  rightIn: number | null;
}

// Where body text can go on a letterhead sheet drawn on `canvas` (any scale; sheet px = canvas px /
// `scale`). Rows and columns count as inked when they hold anything darker or more colourful than
// paper; full-height side strips are left out of the row test and returned as side margins.
export function detectSafeArea(canvas: HTMLCanvasElement, scale: number): SafeArea {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { width: W, height: H } = canvas;
  const { data } = ctx.getImageData(0, 0, W, H);
  const inked = (i: number) => {
    if (data[i + 3] < 40) return false;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    return Math.min(r, g, b) < 225 || Math.max(r, g, b) - Math.min(r, g, b) > 30;
  };
  const colInk = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = 0; y < H; y += 2) if (inked((y * W + x) * 4)) c++;
    colInk[x] = c / (H / 2);
  }
  // Side strips: runs of columns from either edge inked down most of the page.
  let left = 0;
  while (left < W * 0.3 && colInk[left] > 0.6) left++;
  let right = W - 1;
  while (right > W * 0.7 && colInk[right] > 0.6) right--;
  const rowInk = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = left; x <= right; x++) if (inked((y * W + x) * 4)) c++;
    rowInk[y] = c > Math.max(1, (right - left) * 0.002) ? 1 : 0;
  }
  const gap = Math.round(H * 0.025);
  const px = (v: number) => v / scale / 96;
  // Top band: inked rows from the top until a clear gap; only counts if it ends in the top 45%.
  let topEnd = 0;
  let blank = 0;
  for (let y = 0; y < H * 0.45; y++) {
    if (rowInk[y]) {
      topEnd = y + 1;
      blank = 0;
    } else if (++blank > gap && topEnd > 0) break;
  }
  let bottomStart = H;
  blank = 0;
  for (let y = H - 1; y > H * 0.6; y--) {
    if (rowInk[y]) {
      bottomStart = y;
      blank = 0;
    } else if (++blank > gap && bottomStart < H) break;
  }
  const topIn = topEnd > 0 ? px(topEnd) + 0.3 : 1;
  const bottomIn = bottomStart < H ? px(H - bottomStart) + 0.25 : 1;
  return {
    topIn: Math.max(0.6, Math.round(topIn * 100) / 100),
    bottomIn: Math.max(0.6, Math.round(bottomIn * 100) / 100),
    leftIn: left > 2 ? Math.round((px(left) + 0.35) * 100) / 100 : null,
    rightIn: right < W - 3 ? Math.round((px(W - right) + 0.35) * 100) / 100 : null,
  };
}

const canvasPng = (c: HTMLCanvasElement) => c.toDataURL("image/png");

// ------------------------------------------------------------------------------------------------
// Sources

export async function letterheadFromDocx(bytes: ArrayBuffer, name: string): Promise<DocLetterhead | null> {
  const lh = await renderDocxLetterhead(await JSZip.loadAsync(bytes));
  return lh ? fromRenderedDocx(lh, name) : null;
}

export async function fromRenderedDocx(lh: DocxLetterhead, name: string): Promise<DocLetterhead> {
  const out: DocLetterhead = {
    ...blankLetterhead(name, lh.widthPx, lh.heightPx),
    first: lh.first.svg,
    rest: lh.differentFirst ? (lh.rest.hasContent ? lh.rest.svg : null) : lh.first.svg,
    firstTopIn: lh.first.topIn,
    restTopIn: lh.differentFirst ? lh.rest.topIn : lh.first.topIn,
    bottomIn: Math.max(lh.first.bottomIn, lh.rest.bottomIn),
    leftIn: lh.margins.left,
    rightIn: lh.margins.right,
  };
  out.brandColor = await brandColorOf(out.first, out.widthPx, out.heightPx).catch(() => null);
  return out;
}

export async function letterheadFromPdf(bytes: ArrayBuffer, name: string, usePage2ForRest: boolean): Promise<{ letterhead: DocLetterhead; pages: number } | null> {
  if (!GlobalWorkerOptions.workerSrc) GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const task = getDocument({ data: new Uint8Array(bytes.slice(0)) });
  const pdf = await task.promise;
  try {
    const render = async (index: number) => {
      const page = await pdf.getPage(index);
      const base = page.getViewport({ scale: 96 / 72 });
      const scale = 2.5;
      const vp = page.getViewport({ scale: (96 / 72) * scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
      return { canvas, scale, w: base.width, h: base.height };
    };
    const p1 = await render(1);
    const safe1 = detectSafeArea(p1.canvas, p1.scale);
    const first = imageSheet(canvasPng(p1.canvas), p1.w, p1.h);
    let rest: string | null = first;
    let restTop = safe1.topIn;
    if (pdf.numPages > 1 && usePage2ForRest) {
      const p2 = await render(2);
      const safe2 = detectSafeArea(p2.canvas, p2.scale);
      rest = imageSheet(canvasPng(p2.canvas), p2.w, p2.h);
      restTop = safe2.topIn;
    }
    const letterhead: DocLetterhead = {
      ...blankLetterhead(name, p1.w, p1.h),
      first,
      rest,
      firstTopIn: safe1.topIn,
      restTopIn: restTop,
      bottomIn: safe1.bottomIn,
      leftIn: safe1.leftIn,
      rightIn: safe1.rightIn,
    };
    letterhead.brandColor = await brandColorOf(first, p1.w, p1.h).catch(() => null);
    return { letterhead, pages: pdf.numPages };
  } finally {
    void task.destroy();
  }
}

export type ImagePlacement = "sheet" | "top" | "bottom";

export async function letterheadFromImage(blob: Blob, name: string, placement: ImagePlacement | "auto", sheet: { widthPx: number; heightPx: number }): Promise<{ letterhead: DocLetterhead; placement: ImagePlacement }> {
  const bmp = await createImageBitmap(blob);
  const aspect = bmp.width / bmp.height;
  const sheetAspect = sheet.widthPx / sheet.heightPx;
  const resolved: ImagePlacement = placement !== "auto" ? placement : Math.abs(aspect / sheetAspect - 1) < 0.08 ? "sheet" : "top";
  // Re-encode at a sensible size: a whole sheet at ~200 dpi, a banner at twice the sheet width.
  const maxW = resolved === "sheet" ? sheet.widthPx * 2.2 : sheet.widthPx * 2;
  const s = Math.min(1, maxW / bmp.width);
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const href = canvasPng(c);
  const { widthPx: W, heightPx: H } = sheet;
  let first: string;
  if (resolved === "sheet") first = imageSheet(href, W, H, 0, 0, W, H);
  else {
    const bh = W / aspect;
    first = imageSheet(href, W, bh, 0, resolved === "top" ? 0 : H - bh, W, H);
  }
  // Read the safe area from the composed sheet.
  const probe = document.createElement("canvas");
  const ps = 0.5;
  probe.width = Math.round(W * ps);
  probe.height = Math.round(H * ps);
  const pctx = probe.getContext("2d")!;
  pctx.fillStyle = "#fff";
  pctx.fillRect(0, 0, probe.width, probe.height);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(first)}`;
  await img.decode();
  pctx.drawImage(img, 0, 0, probe.width, probe.height);
  const safe = detectSafeArea(probe, ps);
  const letterhead: DocLetterhead = {
    ...blankLetterhead(name, W, H),
    first,
    rest: first,
    firstTopIn: resolved === "bottom" ? 1 : safe.topIn,
    restTopIn: resolved === "bottom" ? 1 : safe.topIn,
    bottomIn: resolved === "top" ? 1 : safe.bottomIn,
    leftIn: resolved === "sheet" ? safe.leftIn : null,
    rightIn: resolved === "sheet" ? safe.rightIn : null,
  };
  letterhead.brandColor = await brandColorOf(first, W, H).catch(() => null);
  return { letterhead, placement: resolved };
}

// ------------------------------------------------------------------------------------------------
// Designer

export type DesignStyle = "classic" | "modern" | "band" | "minimal";

export interface LetterheadDesign {
  style: DesignStyle;
  company: string;
  tagline: string;
  address: string; // lines
  contact: string; // lines: phone, email, website
  logo: string | null; // data URL
  logoAspect: number;
  color: string;
  font: "sans" | "serif";
}

export const DEFAULT_DESIGN: LetterheadDesign = {
  style: "modern",
  company: "",
  tagline: "",
  address: "",
  contact: "",
  logo: null,
  logoAspect: 1,
  color: "#1f3a5f",
  font: "sans",
};

const xmlText = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// The designed letterhead as page-1 / later-page SVGs with their safe areas. Fonts are system
// faces so the sheet draws the same in print and in Word.
export function designLetterhead(d: LetterheadDesign, sheet: { widthPx: number; heightPx: number }): DocLetterhead {
  const W = sheet.widthPx;
  const H = sheet.heightPx;
  const M = 72; // 0.75in side margins
  const family = d.font === "serif" ? "Georgia, 'Times New Roman', serif" : "'Segoe UI', Calibri, Arial, sans-serif";
  const ink = "#1f2937";
  const muted = "#6b7280";
  const c = d.color;
  const company = xmlText(d.company || "Your Company");
  const tagline = xmlText(d.tagline);
  const addr = lines(d.address).map(xmlText);
  const contact = lines(d.contact).map(xmlText);
  const text = (x: number, y: number, s: string, size: number, opts: { fill?: string; weight?: number; anchor?: "start" | "middle" | "end"; spacing?: number } = {}) =>
    `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${opts.weight ?? 400}" fill="${opts.fill ?? ink}" text-anchor="${opts.anchor ?? "start"}"${opts.spacing ? ` letter-spacing="${opts.spacing}"` : ""}>${s}</text>`;
  const logo = (x: number, y: number, h: number) => (d.logo ? `<image href="${d.logo}" x="${x}" y="${y}" width="${h * d.logoAspect}" height="${h}" preserveAspectRatio="xMidYMid meet"/>` : "");
  const logoW = (h: number) => (d.logo ? h * d.logoAspect : 0);
  let head = "";
  let foot = "";
  let restHead = "";
  let top = 1.5;
  let restTop = 1;
  let bottom = 1;
  const footLine = [...addr, ...contact].join("   ·   ");

  switch (d.style) {
    case "classic": {
      const lh = 64;
      const y0 = 44;
      head += logo(W / 2 - logoW(lh) / 2, y0, lh);
      const ty = y0 + (d.logo ? lh + 30 : 34);
      head += text(W / 2, ty, company, 22, { weight: 600, anchor: "middle", fill: c, spacing: 1 });
      if (tagline) head += text(W / 2, ty + 18, tagline.toUpperCase(), 9, { anchor: "middle", fill: muted, spacing: 2.4 });
      const ry = ty + (tagline ? 32 : 18);
      head += `<rect x="${M}" y="${ry}" width="${W - 2 * M}" height="1.2" fill="${c}"/>`;
      top = (ry + 34) / 96;
      foot += `<rect x="${M}" y="${H - 64}" width="${W - 2 * M}" height="0.8" fill="${muted}" opacity="0.6"/>`;
      if (footLine) foot += text(W / 2, H - 44, footLine, 8.5, { anchor: "middle", fill: muted });
      bottom = 0.95;
      restHead = text(W / 2, 48, company, 11, { anchor: "middle", fill: c, weight: 600, spacing: 1 }) + `<rect x="${M}" y="58" width="${W - 2 * M}" height="0.8" fill="${c}" opacity="0.6"/>`;
      restTop = 0.95;
      break;
    }
    case "band": {
      const bandH = 108;
      head += `<rect x="0" y="0" width="${W}" height="${bandH}" fill="${c}"/>`;
      const lh = 56;
      head += logo(M, (bandH - lh) / 2, lh);
      const tx = M + (d.logo ? logoW(lh) + 18 : 0);
      head += text(tx, bandH / 2 + (tagline ? 0 : 8), company, 24, { weight: 600, fill: "#ffffff" });
      if (tagline) head += text(tx, bandH / 2 + 20, tagline, 10, { fill: "#ffffff", spacing: 0.6 });
      contact.forEach((l, i) => (head += text(W - M, bandH / 2 - 12 + i * 14, l, 9, { anchor: "end", fill: "#ffffff" })));
      top = (bandH + 52) / 96;
      foot += `<rect x="0" y="${H - 34}" width="${W}" height="34" fill="${c}"/>`;
      if (addr.length) foot += text(W / 2, H - 13, addr.join("   ·   "), 9, { anchor: "middle", fill: "#ffffff" });
      bottom = 0.85;
      restHead = `<rect x="0" y="0" width="${W}" height="14" fill="${c}"/>`;
      restTop = 0.9;
      break;
    }
    case "minimal": {
      head += text(M, 70, company, 20, { weight: 600, fill: c });
      if (tagline) head += text(M, 88, tagline, 9.5, { fill: muted });
      [...addr, ...contact].forEach((l, i) => (head += text(W - M, 56 + i * 13, l, 8.5, { anchor: "end", fill: muted })));
      const ry = Math.max(100, 56 + Math.max(0, addr.length + contact.length - 1) * 13 + 14);
      head += `<rect x="${M}" y="${ry}" width="${W - 2 * M}" height="0.8" fill="${ink}" opacity="0.25"/>`;
      top = (ry + 36) / 96;
      bottom = 0.9;
      restTop = 0.9;
      break;
    }
    default: {
      // modern: logo + name on the left, address block on the right, a brand rule; contact strip
      // along the foot.
      const lh = 58;
      const y0 = 46;
      head += logo(M, y0, lh);
      const tx = M + (d.logo ? logoW(lh) + 16 : 0);
      head += text(tx, y0 + (tagline ? 26 : 36), company, 21, { weight: 700, fill: c });
      if (tagline) head += text(tx, y0 + 44, tagline, 9.5, { fill: muted, spacing: 0.4 });
      addr.forEach((l, i) => (head += text(W - M, y0 + 12 + i * 13.5, l, 8.5, { anchor: "end", fill: muted })));
      const ry = Math.max(y0 + lh + 16, y0 + 12 + addr.length * 13.5 + 10);
      head += `<rect x="${M}" y="${ry}" width="${W - 2 * M}" height="2" fill="${c}"/>`;
      top = (ry + 36) / 96;
      foot += `<rect x="0" y="${H - 8}" width="${W}" height="8" fill="${c}"/>`;
      if (contact.length) foot += text(W / 2, H - 30, contact.join("     "), 8.5, { anchor: "middle", fill: muted });
      bottom = 0.9;
      restHead = `<rect x="${M}" y="52" width="40" height="3" fill="${c}"/>` + text(M + 50, 57, company, 9, { fill: muted, weight: 600 });
      restTop = 0.9;
      break;
    }
  }
  const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
  return {
    ...blankLetterhead(d.company || "Letterhead", W, H),
    first: svg(head + foot),
    rest: svg(restHead + foot),
    firstTopIn: Math.round(top * 100) / 100,
    restTopIn: restTop,
    bottomIn: bottom,
    leftIn: 0.75,
    rightIn: 0.75,
    brandColor: c,
  };
}
