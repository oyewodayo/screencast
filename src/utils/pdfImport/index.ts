// utils/pdfImport/index.ts
//
// Imports a PDF as a new document, in one of two ways the user chooses:
//
//   "editable" - the paper rebuilt as a live Docs document: two columns, its fonts and sizes,
//                LaTeX equations, real tables, figures, numbered captions, citations and
//                cross-references, the reference list as the document's library. The analysis
//                (glyphs.ts -> lines.ts -> layout.ts -> assemble.ts -> build.ts) reads the PDF's
//                text layer with exact glyph geometry and a grayscale render of each page for the
//                rules and graphics the text layer doesn't describe.
//   "exact"    - every page kept pixel-exact as a page image with a selectable text layer
//                (docPdfPage.ts), for documents where appearance is everything.
//
// Both create the document the way the .docx import does (docxImport.ts): reserve the doc,
// save assets into its folder, build the Y.Doc, save it, set its page setup.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { getDocument, OPS, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import { prosemirrorToYDoc } from "y-prosemirror";
import * as Y from "yjs";
import { ensureWorkerConfigured } from "../../hooks/usePdfDocument";
import { getDocContentExtensions } from "../docSchemaExtensions";
import { docFontsMap, registerDocFont, type DocFontFace } from "../docFonts";
import { docSettingsMap, writeLayout } from "../docLayout";
import type { DocMargins, DocPageSize } from "../docTypes";
import type { PdfTextRun } from "../docPdfPage";
import { readOtf } from "./otf";
import { classifyFont, collectFontChars, extractGlyphs, type FontMeta, type RawTextItem } from "./glyphs";
import { analysePage, type PageAnalysis } from "./layout";
import { assemble, type LinkArea } from "./assemble";
import { buildDocument, type BuildResult } from "./build";
import type { Raster } from "./ink";
import { bundledFamily, embeddedFamilyName, embeddedLabel, isMathFont, libraryStack } from "./fonts";

export type PdfImportMode = "editable" | "exact";

export interface PdfImportProgress {
  stage: "reading" | "analysing" | "building" | "saving";
  current: number;
  total: number;
}

// Where a document came from: the original PDF, saved in its assets folder.
export interface PdfSource {
  kind: "pdf";
  asset: string;
  name: string;
  mode: PdfImportMode;
}

export interface PdfImportResult {
  id: string;
  title: string;
  stats: BuildResult["stats"] | null;
}

// Raster resolution for analysis and figure crops: 3 px per pt (216 dpi).
const SCALE = 3;
// Exact pages are rendered at 2.5 px per pt (180 dpi) - sharp on a high-DPI screen and in print,
// without making a long PDF's document heavy.
const EXACT_SCALE = 2.5;

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function pageSizeFor(width: number, height: number): DocPageSize {
  if (Math.abs(width - 595) < 12 && Math.abs(height - 842) < 12) return "a4";
  if (Math.abs(height - 1008) < 12) return "legal";
  return "letter";
}

async function renderPage(page: PDFPageProxy, scale: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

function rasterOf(canvas: HTMLCanvasElement): Raster {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) gray[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  return { width: canvas.width, height: canvas.height, scale: SCALE, gray };
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error("Could not encode image"))), "image/png")
  );
}

// A region of a rendered page (pt box) as PNG bytes.
async function cropPng(canvas: HTMLCanvasElement, scale: number, box: { x0: number; y0: number; x1: number; y1: number }, pad = 2): Promise<{ bytes: Uint8Array; widthPt: number; heightPt: number }> {
  const x0 = Math.max(0, Math.floor((box.x0 - pad) * scale));
  const y0 = Math.max(0, Math.floor((box.y0 - pad) * scale));
  const x1 = Math.min(canvas.width, Math.ceil((box.x1 + pad) * scale));
  const y1 = Math.min(canvas.height, Math.ceil((box.y1 + pad) * scale));
  const out = document.createElement("canvas");
  out.width = Math.max(1, x1 - x0);
  out.height = Math.max(1, y1 - y0);
  out.getContext("2d")!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { bytes: await canvasPng(out), widthPt: out.width / scale, heightPt: out.height / scale };
}

async function saveAsset(docId: string, extension: string, bytes: Uint8Array): Promise<string> {
  return invoke<string>("save_doc_image", { id: docId, assetId: crypto.randomUUID(), extension, bytes: Array.from(bytes) });
}

interface LoadedFont {
  meta: FontMeta;
  data: Uint8Array | null;
}

async function pageFonts(page: PDFPageProxy, styles: Record<string, unknown>, cache: Map<string, LoadedFont>): Promise<Map<string, FontMeta>> {
  // The operator list makes pdf.js load every font the page uses into commonObjs - and pairs each
  // character's text with the glyph actually drawn.
  const opList = await page.getOperatorList();
  const drawn = collectFontChars(opList, OPS);
  const fonts = new Map<string, FontMeta>();
  for (const id of Object.keys(styles)) {
    let loaded = cache.get(id);
    if (!loaded) {
      let data: Uint8Array | null = null;
      let name = id;
      try {
        const f = page.commonObjs.get(id) as { data?: Uint8Array; name?: string } | undefined;
        data = f?.data ?? null;
        name = f?.name ?? id;
      } catch {
        // A font pdf.js couldn't load (or a standard font with no data): still classified by name.
      }
      const otf = data ? readOtf(data) : null;
      loaded = { meta: classifyFont(id, otf?.postscriptName || name, otf), data };
      cache.set(id, loaded);
    }
    // Per page: a font's drawn characters can differ between pages (subsets, re-encodings).
    fonts.set(id, { ...loaded.meta, fontChars: drawn.get(id) });
  }
  return fonts;
}

async function linkAreas(page: PDFPageProxy, pageNo: number, height: number): Promise<LinkArea[]> {
  const out: LinkArea[] = [];
  for (const a of (await page.getAnnotations()) as { subtype?: string; url?: string; rect?: number[] }[]) {
    if (a.subtype !== "Link" || !a.url || !a.rect) continue;
    out.push({ page: pageNo, x0: a.rect[0], x1: a.rect[2], y0: height - a.rect[3], y1: height - a.rect[1], url: a.url });
  }
  return out;
}

async function createShell(title: string): Promise<string> {
  const id = crypto.randomUUID();
  await invoke("create_doc", { id, title, bytes: Array.from(Y.encodeStateAsUpdate(new Y.Doc())) });
  return id;
}

async function finishDoc(id: string, title: string, ydoc: Y.Doc, pageSize: DocPageSize, margins: DocMargins): Promise<void> {
  await invoke("save_doc", { id, bytes: Array.from(Y.encodeStateAsUpdate(ydoc)), title });
  await invoke("set_doc_page_setup", { id, pageSize, headerText: null, footerText: null, margins });
}

export async function importPdfFile(path: string, fileName: string, mode: PdfImportMode, onProgress: (p: PdfImportProgress) => void): Promise<PdfImportResult> {
  ensureWorkerConfigured();
  onProgress({ stage: "reading", current: 0, total: 1 });
  const fileBytes = new Uint8Array(await invoke<ArrayBuffer>("read_file_bytes", { path }));
  // pdf.js takes ownership of the buffer it's given; keep the original for the document's assets.
  const task = getDocument({ data: fileBytes.slice(), fontExtraProperties: true });
  const pdf: PDFDocumentProxy = await task.promise;
  const baseTitle = fileName.replace(/\.pdf$/i, "");
  const id = await createShell(baseTitle);
  try {
    // The original travels with the document (docSettings "source").
    const asset = await saveAsset(id, "pdf", fileBytes);
    const source: PdfSource = { kind: "pdf", asset, name: fileName, mode };
    return mode === "exact" ? await importExact(pdf, id, baseTitle, source, onProgress) : await importEditable(pdf, id, baseTitle, source, onProgress);
  } catch (err) {
    try {
      await invoke("delete_doc", { id });
    } catch (cleanupErr) {
      console.error("Failed to clean up placeholder doc after a failed PDF import:", cleanupErr);
    }
    throw err;
  } finally {
    void task.destroy();
  }
}

async function importEditable(pdf: PDFDocumentProxy, id: string, baseTitle: string, source: PdfSource, onProgress: (p: PdfImportProgress) => void): Promise<PdfImportResult> {
  const total = pdf.numPages;
  const fontCache = new Map<string, LoadedFont>();
  const analyses: PageAnalysis[] = [];
  const links: LinkArea[] = [];
  const pageGlyphs: { n: number; width: number; height: number; glyphs: ReturnType<typeof extractGlyphs>; raster: Raster }[] = [];
  let textGlyphs = 0;
  let romanGlyphs = 0;

  // Pass 1: glyphs and rasters for every page.
  for (let n = 1; n <= total; n++) {
    onProgress({ stage: "reading", current: n - 1, total });
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const fonts = await pageFonts(page, content.styles as Record<string, unknown>, fontCache);
    const items = (content.items as RawTextItem[]).filter((i) => "str" in i);
    const glyphs = extractGlyphs(items, fonts, viewport.height);
    for (const g of glyphs) {
      if (g.space) continue;
      if (g.font.role === "text") textGlyphs++;
      else if (g.font.role === "roman") romanGlyphs++;
    }
    const canvas = await renderPage(page, SCALE);
    pageGlyphs.push({ n, width: viewport.width, height: viewport.height, glyphs, raster: rasterOf(canvas) });
    links.push(...(await linkAreas(page, n, viewport.height)));
    // Only the grayscale raster is kept; figures are cropped later from a fresh render of just the
    // pages that have them, so a long PDF never holds every page's full-colour canvas at once.
    canvas.width = canvas.height = 0;
    page.cleanup();
    await yieldToUi();
  }
  // A document set entirely in Computer Modern has its running text in the "math roman" font.
  const textIsRoman = textGlyphs < 0.2 * romanGlyphs;

  // Pass 2: layout analysis.
  for (const p of pageGlyphs) {
    onProgress({ stage: "analysing", current: p.n - 1, total });
    analyses.push(analysePage(p.n, p.width, p.height, p.glyphs, p.raster, textIsRoman));
    await yieldToUi();
  }
  pageGlyphs.length = 0;

  onProgress({ stage: "building", current: 0, total: 1 });
  const assembled = assemble(analyses);

  // Fonts: the bundled full font when the PDF's is one Docs ships, the embedded face otherwise.
  const faces = new Map<string, DocFontFace>();
  const pendingFonts: Promise<void>[] = [];
  const stackFor = new Map<string, string>();
  const fontStack = (font: FontMeta): string => {
    const known = stackFor.get(font.id);
    if (known !== undefined) return known;
    let stack = "";
    const bundled = bundledFamily(font.ps);
    if (bundled) stack = libraryStack(bundled) ?? `"${bundled}", ${font.fallback}`;
    else if (isMathFont(font)) stack = "";
    else {
      const data = fontCache.get(font.id)?.data;
      if (data) {
        const family = embeddedFamilyName(font.ps);
        stack = `"${family}", ${font.fallback}`;
        const key = `${family}|${font.bold ? 700 : 400}|${font.italic ? "italic" : "normal"}`;
        if (!faces.has(key)) {
          const face: DocFontFace = { family, label: embeddedLabel(font.ps), asset: "", weight: font.bold ? 700 : 400, style: font.italic ? "italic" : "normal", origin: "pdf", stack };
          faces.set(key, face);
          pendingFonts.push(
            saveAsset(id, "otf", data).then((asset) => {
              face.asset = asset;
            })
          );
        }
      } else stack = font.fallback;
    }
    stackFor.set(font.id, stack);
    return stack;
  };

  // Figure and fallback-equation crops: the builder gets a placeholder src for each, and the crops
  // are rendered and saved once the document is built - one render per page that needs any.
  const crops: { marker: string; page: number; box: { x0: number; y0: number; x1: number; y1: number } }[] = [];
  const pad = 2;
  const imageAsset = (page: number, box: { x0: number; y0: number; x1: number; y1: number }) => {
    const marker = `pdfimport-asset:${crypto.randomUUID()}`;
    crops.push({ marker, page, box });
    return { src: marker, widthPt: box.x1 - box.x0 + 2 * pad, heightPt: box.y1 - box.y0 + 2 * pad };
  };

  const built = buildDocument({
    pages: analyses,
    blocks: assembled.blocks,
    bodySize: assembled.bodySize,
    allLines: assembled.allLines,
    links,
    textIsRoman,
    assets: {
      fontStack,
      figure: (b) => imageAsset(b.page, b.region),
      equation: (b) => imageAsset(b.page, b.region),
    },
  });

  onProgress({ stage: "saving", current: 0, total: 1 });
  await Promise.all(pendingFonts);
  // Render, crop and save, then swap the placeholders for the saved assets' URLs.
  const urls = new Map<string, string>();
  for (const pageNo of [...new Set(crops.map((c) => c.page))]) {
    const page = await pdf.getPage(pageNo);
    const canvas = await renderPage(page, SCALE);
    for (const c of crops.filter((k) => k.page === pageNo)) {
      const { bytes } = await cropPng(canvas, SCALE, c.box, pad);
      urls.set(c.marker, convertFileSrc(await saveAsset(id, "png", bytes)));
    }
    canvas.width = canvas.height = 0;
    page.cleanup();
  }
  const fixImages = (node: import("@tiptap/core").JSONContent) => {
    if (node.type === "image" && typeof node.attrs?.src === "string" && urls.has(node.attrs.src)) node.attrs = { ...node.attrs, src: urls.get(node.attrs.src) };
    node.content?.forEach(fixImages);
  };
  fixImages(built.doc);

  const schema = getSchema(getDocContentExtensions());
  const node = PMNode.fromJSON(schema, built.doc);
  node.check();
  const ydoc = prosemirrorToYDoc(node, "default");
  ydoc.transact(() => {
    writeLayout(ydoc, built.layout);
    const settings = docSettingsMap(ydoc);
    settings.set("numbering", built.numbering);
    settings.set("citationStyle", "aps");
    settings.set("referenceOrder", "list");
    settings.set("source", source);
    const library = ydoc.getMap("bibliography");
    for (const ref of built.references) library.set(ref.id, ref);
    const fonts = docFontsMap(ydoc);
    for (const [key, face] of faces) if (face.asset) fonts.set(key, face);
  });
  for (const face of faces.values()) if (face.asset) void registerDocFont(face);
  const title = built.title || baseTitle;
  await finishDoc(id, title, ydoc, built.pageSize, built.margins);
  return { id, title, stats: built.stats };
}

async function importExact(pdf: PDFDocumentProxy, id: string, baseTitle: string, source: PdfSource, onProgress: (p: PdfImportProgress) => void): Promise<PdfImportResult> {
  const total = pdf.numPages;
  const content: import("@tiptap/core").JSONContent[] = [];
  let first: { width: number; height: number } | null = null;
  let title = "";
  for (let n = 1; n <= total; n++) {
    onProgress({ stage: "reading", current: n - 1, total });
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    first ??= { width: viewport.width, height: viewport.height };
    const canvas = await renderPage(page, EXACT_SCALE);
    const src = convertFileSrc(await saveAsset(id, "png", await canvasPng(canvas)));
    const text: PdfTextRun[] = [];
    const tc = await page.getTextContent();
    let biggest = 0;
    for (const item of tc.items as RawTextItem[]) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [a, b, c, d, e, f] = item.transform;
      if (Math.abs(b) > 0.1 * Math.abs(a)) continue; // rotated text stays image-only
      const size = Math.hypot(c, d);
      text.push([item.str, Math.round(e * 100) / 100, Math.round((viewport.height - f) * 100) / 100, Math.round(size * 100) / 100, Math.round(item.width * 100) / 100]);
      if (n === 1 && size > biggest + 0.5) {
        biggest = size;
        title = item.str.trim();
      } else if (n === 1 && Math.abs(size - biggest) <= 0.5 && title.length < 120) title += ` ${item.str.trim()}`;
    }
    content.push({ type: "pdfPage", attrs: { src, page: n, width: Math.round(viewport.width * 100) / 100, height: Math.round(viewport.height * 100) / 100, text } });
    page.cleanup();
    await yieldToUi();
  }
  onProgress({ stage: "saving", current: 0, total: 1 });
  const schema = getSchema(getDocContentExtensions());
  const node = PMNode.fromJSON(schema, { type: "doc", content: content.length ? content : [{ type: "paragraph" }] });
  const ydoc = prosemirrorToYDoc(node, "default");
  docSettingsMap(ydoc).set("source", source);
  writeLayout(ydoc, { columns: 1, body: { fontFamily: null, fontSize: null, lineHeight: null, blockSpacing: 0, paragraphIndent: null, color: null, justify: false, hyphenate: false } });
  const finalTitle = title.replace(/\s+/g, " ").trim().slice(0, 160) || baseTitle;
  const size = first ? pageSizeFor(first.width, first.height) : "letter";
  await finishDoc(id, finalTitle, ydoc, size, { top: 0, right: 0, bottom: 0, left: 0 });
  return { id, title: finalTitle, stats: null };
}
