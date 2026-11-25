// handlers/whiteboardSlidesImport.ts
//
// Unified Slide Deck Import engine for Briefcast Whiteboard:
// 1. PowerPoint (.pptx) -> native editable Whiteboard objects (Containment Frames, text boxes,
//    shapes, connectors, embedded images, native tables, and optional speaker notes) using JSZip
//    + @xmldom/xmldom (zero external slide-conversion service, 100% offline).
// 2. PDF Slide Decks (.pdf) -> pixel-perfect 2x HiDPI locked slide images inside Containment
//    Frames via pdfjs-dist so users can present and annotate over complex Canva/Keynote/PPT decks.
// 3. Google Slides URL parser -> feeds directly into the Tauri `fetch_google_slides_export`
//    command (choosing either Editable .pptx or Pixel-Perfect .pdf).

import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { getDocument } from "pdfjs-dist";
import { ensureWorkerConfigured } from "../hooks/usePdfDocument";
import {
  ArrowheadType,
  createDefaultWhiteboardEdge,
  createDefaultWhiteboardNode,
  createEmptyWhiteboardPage,
  WhiteboardEdge,
  WhiteboardNode,
  WhiteboardPage,
  WhiteboardShapeType,
} from "../utils/whiteboardTypes";

const EMU_PER_PT = 12700;
const DEFAULT_SLIDE_CX = 12192000; // 13.333 in (16:9 widescreen)
const DEFAULT_SLIDE_CY = 6858000; // 7.5 in
const TARGET_SLIDE_WIDTH = 960;

/**
 * Creates a WhiteboardNode positioned strictly by its TOP-LEFT `(x, y)` and exact `(width, height)`.
 * `createDefaultWhiteboardNode` centers nodes on `(x, y)` using each shape's default dimensions,
 * which would misalign every element inside a slide by a different `-defaultW/2, -defaultH/2` offset.
 */
function makeSlideNode(
  shapeType: WhiteboardShapeType,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Partial<WhiteboardNode> = {}
): WhiteboardNode {
  return {
    ...createDefaultWhiteboardNode(crypto.randomUUID(), shapeType, 0, 0),
    ...extra,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(4, Math.round(width)),
    height: Math.max(4, Math.round(height)),
  };
}

function parseOoxmlImageCrop(blipFill: Element | null): Partial<WhiteboardNode> {
  const srcRect = firstChild(blipFill, "srcRect");
  if (!srcRect) return {};
  const clampFrac = (v: number) => Math.max(0, Math.min(0.95, v / 100000));
  const l = clampFrac(numAttr(srcRect, "l", 0));
  const t = clampFrac(numAttr(srcRect, "t", 0));
  const r = clampFrac(numAttr(srcRect, "r", 0));
  const b = clampFrac(numAttr(srcRect, "b", 0));
  if (l === 0 && t === 0 && r === 0 && b === 0) return {};
  const w = Math.max(0.02, 1 - l - r);
  const h = Math.max(0.02, 1 - t - b);
  return { imageCropX: l, imageCropY: t, imageCropW: w, imageCropH: h };
}

export type SlideImportPlacement = "frames" | "pages";
export type GoogleSlidesImportFormat = "pptx" | "pdf";

export type SlideImageSaver = (
  bytes: Uint8Array,
  mime: string
) => Promise<{ assetFileName: string; naturalWidth: number; naturalHeight: number }>;

export interface ImportedSlide {
  name: string;
  width: number;
  height: number;
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
}

export interface ImportedSlideDeck {
  title?: string;
  slides: ImportedSlide[];
}

export interface PptxImportOptions {
  saveImage?: SlideImageSaver;
  includeSpeakerNotes?: boolean;
  onProgress?: (current: number, total: number, label?: string) => void;
}

export interface PdfImportOptions {
  saveImage: SlideImageSaver;
  onProgress?: (current: number, total: number, label?: string) => void;
}

// ---- Google Slides URL parsing -----------------------------------------------------------------

export type GoogleSlidesParseResult =
  | { ok: true; presentationId: string }
  | { ok: false; error: string };

/**
 * Extracts a Google Slides presentation ID from any standard link or raw ID.
 */
export function parseGoogleSlidesInput(raw: string): GoogleSlidesParseResult {
  const input = raw.trim();
  if (!input) return { ok: false, error: "Paste a Google Slides link first." };

  if (/docs\.google\.com\/presentation\/d\/e\//i.test(input)) {
    return {
      ok: false,
      error:
        "Published web-embed links (/d/e/...) cannot be exported directly. Copy the standard Share link (/presentation/d/<ID>/edit) instead.",
    };
  }

  const urlMatch = /docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]{10,128})/i.exec(input);
  if (urlMatch) {
    return { ok: true, presentationId: urlMatch[1] };
  }

  if (/^[a-zA-Z0-9_-]{16,128}$/.test(input)) {
    return { ok: true, presentationId: input };
  }

  return {
    ok: false,
    error: "Unrecognized Google Slides link. Expected https://docs.google.com/presentation/d/<ID>/edit",
  };
}

// ---- Layout helper (Frames grid vs Separate Pages) ---------------------------------------------

export function layoutImportedSlides(
  deck: ImportedSlideDeck,
  placement: SlideImportPlacement,
  origin: { x: number; y: number } = { x: 80, y: 80 }
): { nodes: WhiteboardNode[]; edges: WhiteboardEdge[]; pages: WhiteboardPage[] } {
  if (placement === "pages") {
    const pages: WhiteboardPage[] = deck.slides.map((slide, idx) => {
      const offsetX = 80;
      const offsetY = 60;
      const nodes = slide.nodes.map((n) => ({ ...n, x: Math.round(n.x + offsetX), y: Math.round(n.y + offsetY) }));
      const edges = slide.edges.map((e) => ({
        ...e,
        source: e.source.nodeId
          ? e.source
          : { x: Math.round((e.source.x ?? 0) + offsetX), y: Math.round((e.source.y ?? 0) + offsetY) },
        target: e.target.nodeId
          ? e.target
          : { x: Math.round((e.target.x ?? 0) + offsetX), y: Math.round((e.target.y ?? 0) + offsetY) },
      }));
      const page = createEmptyWhiteboardPage(crypto.randomUUID(), slide.name || `Slide ${idx + 1}`);
      page.nodes = nodes;
      page.edges = edges;
      return page;
    });
    return { nodes: [], edges: [], pages };
  }

  // "frames" placement: neat grid (3 slides per row) on the current page so Present steps through them
  const cols = Math.min(3, Math.max(1, deck.slides.length));
  const gapX = 96;
  const gapY = 120;
  const maxW = Math.max(TARGET_SLIDE_WIDTH, ...deck.slides.map((s) => s.width));
  // Account for any speaker sticky note sitting below the frame
  const rowHeights: number[] = [];
  deck.slides.forEach((slide, idx) => {
    const row = Math.floor(idx / cols);
    const slideBottom = slide.nodes.reduce((m, n) => Math.max(m, n.y + n.height), slide.height);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, slideBottom);
  });

  const rowYOffsets: number[] = [];
  let accY = origin.y;
  for (let r = 0; r < rowHeights.length; r++) {
    rowYOffsets.push(accY);
    accY += rowHeights[r] + gapY;
  }

  const allNodes: WhiteboardNode[] = [];
  const allEdges: WhiteboardEdge[] = [];
  deck.slides.forEach((slide, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const ox = Math.round(origin.x + col * (maxW + gapX));
    const oy = Math.round(rowYOffsets[row]);
    for (const n of slide.nodes) {
      allNodes.push({ ...n, x: Math.round(n.x + ox), y: Math.round(n.y + oy) });
    }
    for (const e of slide.edges) {
      allEdges.push({
        ...e,
        source: e.source.nodeId
          ? e.source
          : { x: Math.round((e.source.x ?? 0) + ox), y: Math.round((e.source.y ?? 0) + oy) },
        target: e.target.nodeId
          ? e.target
          : { x: Math.round((e.target.x ?? 0) + ox), y: Math.round((e.target.y ?? 0) + oy) },
      });
    }
  });

  return { nodes: allNodes, edges: allEdges, pages: [] };
}

// ---- XML / OOXML helpers -----------------------------------------------------------------------

const xmlParser = new DOMParser();

function parseXml(text: string): Document {
  return xmlParser.parseFromString(text, "application/xml");
}

function localName(node: Node): string {
  const el = node as Element;
  if (el.localName) return el.localName;
  const name = el.nodeName || "";
  const idx = name.indexOf(":");
  return idx >= 0 ? name.slice(idx + 1) : name;
}

function childElements(parent: Node | null | undefined, matchLocalName?: string): Element[] {
  if (!parent || !parent.childNodes) return [];
  const out: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const ch = parent.childNodes[i];
    if (ch.nodeType === 1) {
      if (!matchLocalName || localName(ch) === matchLocalName) {
        out.push(ch as Element);
      }
    }
  }
  return out;
}

function firstChild(parent: Node | null | undefined, matchLocalName: string): Element | null {
  const list = childElements(parent, matchLocalName);
  return list.length > 0 ? list[0] : null;
}

function findDescendants(parent: Node | null | undefined, matchLocalName: string): Element[] {
  if (!parent || !parent.childNodes) return [];
  const out: Element[] = [];
  const stack: Node[] = [];
  for (let i = parent.childNodes.length - 1; i >= 0; i--) stack.push(parent.childNodes[i]);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.nodeType === 1) {
      if (localName(cur) === matchLocalName) out.push(cur as Element);
      for (let i = cur.childNodes.length - 1; i >= 0; i--) stack.push(cur.childNodes[i]);
    }
  }
  return out;
}

function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const direct = el.getAttribute(name);
  if (direct !== null && direct !== "") return direct;
  // Handle namespaced attributes like r:embed or r:id
  if (el.attributes) {
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      if (a.name === name || a.localName === name || a.name.endsWith(`:${name}`)) {
        return a.value;
      }
    }
  }
  return null;
}

function numAttr(el: Element | null | undefined, name: string, fallback = 0): number {
  const v = attr(el, name);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---- Theme colors & OOXML color transforms -----------------------------------------------------

type ThemeColors = Record<string, string>;

const DEFAULT_THEME_COLORS: ThemeColors = {
  dk1: "#111827",
  lt1: "#ffffff",
  dk2: "#1f2937",
  lt2: "#f3f4f6",
  tx1: "#111827",
  tx2: "#374151",
  bg1: "#ffffff",
  bg2: "#f3f4f6",
  accent1: "#2563eb",
  accent2: "#ea580c",
  accent3: "#64748b",
  accent4: "#eab308",
  accent5: "#0ea5e9",
  accent6: "#16a34a",
  hlink: "#2563eb",
  folHlink: "#7c3aed",
};

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return [17, 24, 39];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [clampByte(r), clampByte(g), clampByte(b)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = clampByte(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    clampByte(hue2rgb(p, q, h + 1 / 3) * 255),
    clampByte(hue2rgb(p, q, h) * 255),
    clampByte(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

function applyOoxmlColorTransforms(hex: string, colorEl: Element): { color: string; alpha?: number } {
  let [r, g, b] = hexToRgb(hex);
  let alpha: number | undefined;
  const children = childElements(colorEl);
  for (const mod of children) {
    const name = localName(mod);
    const val = numAttr(mod, "val", 100000) / 100000;
    if (name === "alpha") {
      alpha = Math.max(0, Math.min(1, val));
    } else if (name === "tint") {
      r = r * val + 255 * (1 - val);
      g = g * val + 255 * (1 - val);
      b = b * val + 255 * (1 - val);
    } else if (name === "shade") {
      r *= val;
      g *= val;
      b *= val;
    } else if (name === "lumMod" || name === "lumOff") {
      const [h, s, l] = rgbToHsl(r, g, b);
      const nextL = name === "lumMod" ? Math.max(0, Math.min(1, l * val)) : Math.max(0, Math.min(1, l + val));
      [r, g, b] = hslToRgb(h, s, nextL);
    }
  }
  return { color: rgbToHex(r, g, b), alpha };
}

function extractColorFromFillParent(parent: Element | null | undefined, theme: ThemeColors): { color: string; alpha?: number } | null {
  if (!parent) return null;
  const srgb = firstChild(parent, "srgbClr");
  if (srgb) {
    const raw = attr(srgb, "val");
    if (raw && /^[0-9a-fA-F]{6}$/.test(raw)) {
      return applyOoxmlColorTransforms(`#${raw.toLowerCase()}`, srgb);
    }
  }
  const scheme = firstChild(parent, "schemeClr");
  if (scheme) {
    const key = attr(scheme, "val") ?? "";
    const base = theme[key] ?? DEFAULT_THEME_COLORS[key];
    if (base) return applyOoxmlColorTransforms(base, scheme);
  }
  const sys = firstChild(parent, "sysClr");
  if (sys) {
    const last = attr(sys, "lastClr");
    if (last && /^[0-9a-fA-F]{6}$/.test(last)) {
      return applyOoxmlColorTransforms(`#${last.toLowerCase()}`, sys);
    }
  }
  return null;
}

function parseThemeColors(xml: Document): ThemeColors {
  const colors: ThemeColors = { ...DEFAULT_THEME_COLORS };
  const clrScheme = findDescendants(xml, "clrScheme")[0];
  if (!clrScheme) return colors;
  for (const child of childElements(clrScheme)) {
    const key = localName(child);
    const resolved = extractColorFromFillParent(child, colors);
    if (resolved) colors[key] = resolved.color;
  }
  colors.tx1 = colors.dk1;
  colors.bg1 = colors.lt1;
  colors.tx2 = colors.dk2;
  colors.bg2 = colors.lt2;
  return colors;
}

function parseRels(xmlText: string | null): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  if (!xmlText) return map;
  const doc = parseXml(xmlText);
  for (const rel of findDescendants(doc, "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    const type = attr(rel, "Type") ?? "";
    if (id && target) map.set(id, { target, type });
  }
  return map;
}

function resolveZipPath(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  const parts = `${baseDir}/${target}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function mimeFromExt(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

function mapPptxFont(rawFont: string | null | undefined): string {
  if (!rawFont) return "Inter, system-ui, sans-serif";
  const f = rawFont.toLowerCase();
  if (f.includes("poppins")) return "'Poppins', system-ui, sans-serif";
  if (f.includes("montserrat")) return "'Montserrat', system-ui, sans-serif";
  if (f.includes("space grotesk")) return "'Space Grotesk', system-ui, sans-serif";
  if (f.includes("ibm plex")) return "'IBM Plex Sans', system-ui, sans-serif";
  if (f.includes("fira sans")) return "'Fira Sans', system-ui, sans-serif";
  if (f.includes("playfair")) return "'Playfair Display', Georgia, serif";
  if (f.includes("garamond")) return "'EB Garamond', Georgia, serif";
  if (f.includes("georgia") || f.includes("times") || f.includes("cambria") || f.includes("serif")) {
    return "'Crimson Pro', Georgia, serif";
  }
  if (f.includes("consolas") || f.includes("courier") || f.includes("mono") || f.includes("fira code") || f.includes("jetbrains")) {
    return "'JetBrains Mono', monospace";
  }
  if (f.includes("oswald")) return "'Oswald', sans-serif";
  if (f.includes("bebas")) return "'Bebas Neue', sans-serif";
  if (f.includes("caveat") || f.includes("comic") || f.includes("hand")) return "'Caveat', cursive";
  return "'Inter', system-ui, sans-serif";
}

function mapOoxmlShapePreset(prst: string | null): {
  shapeType: WhiteboardShapeType;
  overrides?: Partial<WhiteboardNode>;
} {
  switch (prst) {
    case "roundRect":
    case "snip1Rect":
    case "snip2SameRect":
    case "round1Rect":
    case "round2SameRect":
      return { shapeType: "rectangle", overrides: { cornerRadius: 14 } };
    case "ellipse":
    case "oval":
      return { shapeType: "ellipse" };
    case "diamond":
    case "flowChartDecision":
      return { shapeType: "diamond" };
    case "triangle":
    case "rtTriangle":
      return { shapeType: "triangle" };
    case "parallelogram":
    case "flowChartInputOutput":
      return { shapeType: "parallelogram" };
    case "trapezoid":
      return { shapeType: "trapezoid" };
    case "hexagon":
      return { shapeType: "hexagon" };
    case "pentagon":
      return { shapeType: "polygon", overrides: { sides: 5 } };
    case "octagon":
      return { shapeType: "polygon", overrides: { sides: 8 } };
    case "star4":
      return { shapeType: "star", overrides: { starPoints: 4 } };
    case "star5":
    case "star6":
      return { shapeType: "star", overrides: { starPoints: 5 } };
    case "star8":
    case "star10":
    case "star12":
      return { shapeType: "star", overrides: { starPoints: 8 } };
    case "cloud":
    case "cloudCallout":
      return { shapeType: "cloud" };
    case "can":
    case "flowChartMagneticDisk":
      return { shapeType: "cylinder" };
    case "cube":
      return { shapeType: "cube" };
    case "plus":
    case "mathPlus":
      return { shapeType: "cross" };
    case "flowChartDocument":
      return { shapeType: "document" };
    case "foldedCorner":
      return { shapeType: "note" };
    case "wedgeRectCallout":
    case "wedgeRoundRectCallout":
    case "wedgeEllipseCallout":
    case "callout1":
    case "callout2":
    case "callout3":
      return { shapeType: "callout" };
    case "chevron":
    case "homePlate":
    case "rightArrow":
      return { shapeType: "step" };
    case "lightningBolt":
      return { shapeType: "lightningBolt" };
    case "teardrop":
      return { shapeType: "teardrop" };
    case "frame":
      return { shapeType: "frame" };
    default:
      return { shapeType: "rectangle" };
  }
}

function mapOoxmlArrowhead(type: string | null): ArrowheadType {
  switch (type) {
    case "triangle":
      return "triangle";
    case "stealth":
      return "block";
    case "arrow":
      return "triangleOpen";
    case "diamond":
      return "diamond";
    case "oval":
      return "circle";
    default:
      return "none";
  }
}

function isDarkHex(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.45;
}

interface CoordTransform {
  mapX: (emuX: number) => number;
  mapY: (emuY: number) => number;
  mapW: (emuW: number) => number;
  mapH: (emuH: number) => number;
  scaleX: number;
  scaleY: number;
}

function parseXfrm(xfrm: Element | null): {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
} | null {
  if (!xfrm) return null;
  const off = firstChild(xfrm, "off");
  const ext = firstChild(xfrm, "ext");
  if (!off || !ext) return null;
  const x = numAttr(off, "x", 0);
  const y = numAttr(off, "y", 0);
  const w = numAttr(ext, "cx", 0);
  const h = numAttr(ext, "cy", 0);
  const rotRaw = numAttr(xfrm, "rot", 0);
  const rot = ((Math.round(rotRaw / 60000) % 360) + 360) % 360;
  const flipH = attr(xfrm, "flipH") === "1" || attr(xfrm, "flipH") === "true";
  const flipV = attr(xfrm, "flipV") === "1" || attr(xfrm, "flipV") === "true";
  return { x, y, w, h, rot, flipH, flipV };
}

interface ExtractedTextInfo {
  text: string;
  fontSize: number;
  fontColor?: string;
  fontFamily?: string;
  fontWeight: "normal" | "bold";
  fontStyle: "normal" | "italic";
  textDecoration: "none" | "underline";
  textAlign: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
}

function extractTxBody(
  txBody: Element | null,
  theme: ThemeColors,
  pxPerPt: number,
  placeholderType: string | null
): ExtractedTextInfo {
  const isTitle = placeholderType === "title" || placeholderType === "ctrTitle";
  const isSubtitle = placeholderType === "subTitle";

  let verticalAlign: "top" | "middle" | "bottom" = isTitle ? "middle" : "top";
  const bodyPr = firstChild(txBody, "bodyPr");
  const anchor = attr(bodyPr, "anchor");
  if (anchor === "t") verticalAlign = "top";
  else if (anchor === "ctr") verticalAlign = "middle";
  else if (anchor === "b") verticalAlign = "bottom";

  // PowerPoint shrinks overflowing text via <a:normAutofit fontScale="85000"/> (in 1/1000ths of %)
  const normAutofit = firstChild(bodyPr, "normAutofit");
  const fontScale = normAutofit ? Math.max(0.5, Math.min(1, numAttr(normAutofit, "fontScale", 100000) / 100000)) : 1;

  const paragraphs = childElements(txBody, "p");
  const lines: string[] = [];
  const sizeWeights = new Map<number, number>();
  let firstSizePt: number | null = null;
  let dominantColor: string | undefined;
  let dominantFont: string | undefined;
  let boldChars = 0;
  let italicChars = 0;
  let underlineChars = 0;
  let totalChars = 0;
  let firstAlign: "left" | "center" | "right" | null = null;
  let autoNumIndex = 1;

  for (const p of paragraphs) {
    const pPr = firstChild(p, "pPr");
    const defRPr = firstChild(pPr, "defRPr");
    const algn = attr(pPr, "algn");
    if (!firstAlign && algn) {
      if (algn === "ctr") firstAlign = "center";
      else if (algn === "r") firstAlign = "right";
      else firstAlign = "left";
    }
    const buNone = firstChild(pPr, "buNone");
    const buChar = firstChild(pPr, "buChar");
    const buAutoNum = firstChild(pPr, "buAutoNum");
    const lvl = numAttr(pPr, "lvl", 0);

    let line = "";
    for (const child of childElements(p)) {
      const name = localName(child);
      if (name === "r" || name === "fld") {
        const rPr = firstChild(child, "rPr") ?? defRPr;
        const tEl = firstChild(child, "t");
        const txt = tEl?.textContent ?? "";
        if (!txt) continue;
        line += txt;
        const charLen = Math.max(1, txt.trim().length);
        totalChars += charLen;

        if (rPr) {
          const sz = numAttr(rPr, "sz", 0);
          if (sz > 0) {
            const ptVal = sz / 100;
            if (firstSizePt === null) firstSizePt = ptVal;
            sizeWeights.set(ptVal, (sizeWeights.get(ptVal) ?? 0) + charLen);
          }
          if (attr(rPr, "b") === "1" || attr(rPr, "b") === "true") boldChars += charLen;
          if (attr(rPr, "i") === "1" || attr(rPr, "i") === "true") italicChars += charLen;
          const u = attr(rPr, "u");
          if (u && u !== "none") underlineChars += charLen;
          if (!dominantColor) {
            const solidFill = firstChild(rPr, "solidFill");
            const col = extractColorFromFillParent(solidFill, theme);
            if (col) dominantColor = col.color;
          }
          if (!dominantFont) {
            const latin = firstChild(rPr, "latin");
            const tf = attr(latin, "typeface");
            if (tf && !tf.startsWith("+")) dominantFont = mapPptxFont(tf);
          }
        }
      } else if (name === "br") {
        line += "\n";
      }
    }

    const trimmedLine = line.replace(/\r/g, "");
    if (trimmedLine.trim().length > 0 && !buNone) {
      const indent = lvl > 0 ? "  ".repeat(Math.min(3, lvl)) : "";
      if (buChar) {
        const ch = attr(buChar, "char") || "•";
        lines.push(`${indent}${ch} ${trimmedLine}`);
      } else if (buAutoNum) {
        lines.push(`${indent}${autoNumIndex}. ${trimmedLine}`);
        autoNumIndex += 1;
      } else {
        lines.push(`${indent}${trimmedLine}`);
      }
    } else if (trimmedLine.trim().length > 0) {
      lines.push(trimmedLine);
    }
  }

  // Pick the font size covering the majority of characters in the box (prevents a 1-word bold
  // heading from blowing up an entire body paragraph, or a tiny superscript from shrinking a title).
  let dominantSizePt: number | null = firstSizePt;
  let bestWeight = -1;
  for (const [ptVal, w] of sizeWeights.entries()) {
    if (w > bestWeight) {
      bestWeight = w;
      dominantSizePt = ptVal;
    }
  }

  const defaultPt = isTitle ? 32 : isSubtitle ? 18 : 14;
  const pt = (dominantSizePt ?? defaultPt) * fontScale;
  const fontSize = Math.max(8, Math.min(96, Math.round(pt * pxPerPt)));

  return {
    text: lines.join("\n").trim(),
    fontSize,
    fontColor: dominantColor,
    fontFamily: dominantFont,
    fontWeight:
      (totalChars > 0 && boldChars >= totalChars * 0.5) || (isTitle && boldChars === 0 && dominantSizePt === null)
        ? "bold"
        : "normal",
    fontStyle: totalChars > 0 && italicChars >= totalChars * 0.5 ? "italic" : "normal",
    textDecoration: totalChars > 0 && underlineChars >= totalChars * 0.5 ? "underline" : "none",
    textAlign: firstAlign ?? (placeholderType === "ctrTitle" || placeholderType === "subTitle" ? "center" : "left"),
    verticalAlign,
  };
}

function extractFillAndStroke(
  spPr: Element | null,
  theme: ThemeColors,
  pxPerEmu: number
): {
  fillColor: string | null;
  fillOpacity?: number;
  strokeColor: string;
  strokeWidth: number;
  strokeStyle: "solid" | "dashed" | "dotted";
  strokeOpacity?: number;
} {
  let fillColor: string | null = null;
  let fillOpacity: number | undefined;
  let strokeColor = "#1f2937";
  let strokeWidth = 0;
  let strokeStyle: "solid" | "dashed" | "dotted" = "solid";
  let strokeOpacity: number | undefined;

  if (spPr) {
    const noFill = firstChild(spPr, "noFill");
    if (!noFill) {
      const solidFill = firstChild(spPr, "solidFill");
      if (solidFill) {
        const col = extractColorFromFillParent(solidFill, theme);
        if (col) {
          fillColor = col.color;
          fillOpacity = col.alpha;
        }
      } else {
        const gradFill = firstChild(spPr, "gradFill");
        if (gradFill) {
          const gs = findDescendants(gradFill, "gs")[0];
          const col = extractColorFromFillParent(gs, theme);
          if (col) {
            fillColor = col.color;
            fillOpacity = col.alpha;
          }
        }
      }
    }

    const ln = firstChild(spPr, "ln");
    if (ln && !firstChild(ln, "noFill")) {
      const lnFill = firstChild(ln, "solidFill");
      const col = extractColorFromFillParent(lnFill, theme);
      if (col) {
        strokeColor = col.color;
        strokeOpacity = col.alpha;
        const wEmu = numAttr(ln, "w", EMU_PER_PT);
        strokeWidth = Math.max(1, Math.min(16, Math.round(wEmu * pxPerEmu * 10) / 10));
      }
      const prstDash = firstChild(ln, "prstDash");
      const dashVal = attr(prstDash, "val") ?? "";
      if (dashVal.includes("dot") && !dashVal.includes("dash")) strokeStyle = "dotted";
      else if (dashVal && dashVal !== "solid") strokeStyle = "dashed";
    }
  }

  return { fillColor, fillOpacity, strokeColor, strokeWidth, strokeStyle, strokeOpacity };
}

/**
 * Parses a PowerPoint `.pptx` file into native, editable Whiteboard slides (frames, shapes,
 * text boxes, connectors, images, tables, and optional speaker notes).
 */
export async function importPptxSlides(
  bytes: ArrayBuffer | Uint8Array,
  options: PptxImportOptions = {}
): Promise<ImportedSlideDeck> {
  const zip = await JSZip.loadAsync(bytes);

  // 1. Parse theme colors
  const themeEntry =
    zip.file("ppt/theme/theme1.xml") ??
    Object.values(zip.files).find((f) => /^ppt\/theme\/theme\d+\.xml$/i.test(f.name));
  const themeColors = themeEntry ? parseThemeColors(parseXml(await themeEntry.async("string"))) : { ...DEFAULT_THEME_COLORS };

  // 2. Parse presentation.xml for slide dimensions & ordered slide list
  let slideCx = DEFAULT_SLIDE_CX;
  let slideCy = DEFAULT_SLIDE_CY;
  const slidePaths: string[] = [];

  const presEntry = zip.file("ppt/presentation.xml");
  if (presEntry) {
    const presDoc = parseXml(await presEntry.async("string"));
    const sldSz = findDescendants(presDoc, "sldSz")[0];
    if (sldSz) {
      const cx = numAttr(sldSz, "cx", 0);
      const cy = numAttr(sldSz, "cy", 0);
      if (cx > 0 && cy > 0) {
        slideCx = cx;
        slideCy = cy;
      }
    }
    const presRelsEntry = zip.file("ppt/_rels/presentation.xml.rels");
    const presRels = parseRels(presRelsEntry ? await presRelsEntry.async("string") : null);
    for (const sldId of findDescendants(presDoc, "sldId")) {
      const rId = attr(sldId, "id");
      if (rId && presRels.has(rId)) {
        slidePaths.push(resolveZipPath("ppt", presRels.get(rId)!.target));
      }
    }
  }

  // Fallback: enumerate ppt/slides/slideN.xml numerically
  if (slidePaths.length === 0) {
    const found = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((a, b) => {
        const na = Number(/slide(\d+)\.xml$/i.exec(a)?.[1] ?? 0);
        const nb = Number(/slide(\d+)\.xml$/i.exec(b)?.[1] ?? 0);
        return na - nb;
      });
    slidePaths.push(...found);
  }

  if (slidePaths.length === 0) {
    throw new Error("No slides were found inside this PowerPoint (.pptx) file.");
  }

  // Read optional slide master background fallback
  let masterBgColor = themeColors.bg1 || "#ffffff";
  const masterEntry = zip.file("ppt/slideMasters/slideMaster1.xml");
  if (masterEntry) {
    const masterDoc = parseXml(await masterEntry.async("string"));
    const bgPr = findDescendants(masterDoc, "bgPr")[0];
    const solid = firstChild(bgPr, "solidFill");
    const col = extractColorFromFillParent(solid, themeColors);
    if (col) masterBgColor = col.color;
  }

  const slideW = TARGET_SLIDE_WIDTH;
  const slideH = Math.max(240, Math.round((slideCy / slideCx) * slideW));
  const pxPerEmu = slideW / slideCx;
  // On a standard 16:9 widescreen slide (13.333 in = 960 pt), 1 pt maps to exactly 1.0 doc px.
  const pxPerPt = EMU_PER_PT * pxPerEmu;

  const rootTransform: CoordTransform = {
    mapX: (emuX) => emuX * pxPerEmu,
    mapY: (emuY) => emuY * pxPerEmu,
    mapW: (emuW) => emuW * pxPerEmu,
    mapH: (emuH) => emuH * pxPerEmu,
    scaleX: pxPerEmu,
    scaleY: pxPerEmu,
  };

  // Deduplicate saved media across slides (e.g. repeated logos)
  const savedMediaCache = new Map<string, { assetFileName: string; naturalWidth: number; naturalHeight: number }>();

  async function saveZipMedia(mediaPath: string): Promise<{ assetFileName: string; naturalWidth: number; naturalHeight: number } | null> {
    if (!options.saveImage) return null;
    if (savedMediaCache.has(mediaPath)) return savedMediaCache.get(mediaPath)!;
    const file = zip.file(mediaPath);
    if (!file) return null;
    const mime = mimeFromExt(mediaPath);
    if (!mime) return null;
    const data = await file.async("uint8array");
    const saved = await options.saveImage(data, mime);
    savedMediaCache.set(mediaPath, saved);
    return saved;
  }

  const slides: ImportedSlide[] = [];

  for (let sIdx = 0; sIdx < slidePaths.length; sIdx++) {
    const slidePath = slidePaths[sIdx];
    options.onProgress?.(sIdx + 1, slidePaths.length, `Importing slide ${sIdx + 1} of ${slidePaths.length}…`);
    const slideFile = zip.file(slidePath);
    if (!slideFile) continue;

    const slideXml = parseXml(await slideFile.async("string"));
    const baseDir = slidePath.slice(0, slidePath.lastIndexOf("/"));
    const fileName = slidePath.slice(slidePath.lastIndexOf("/") + 1);
    const relsEntry = zip.file(`${baseDir}/_rels/${fileName}.rels`);
    const slideRels = parseRels(relsEntry ? await relsEntry.async("string") : null);

    // Resolve slide background color / image
    let slideBgColor = masterBgColor;
    let slideBgImagePath: string | null = null;
    const bgEl = findDescendants(slideXml, "bg")[0];
    if (bgEl) {
      const bgPr = firstChild(bgEl, "bgPr");
      const bgRef = firstChild(bgEl, "bgRef");
      const solid = firstChild(bgPr, "solidFill");
      const grad = firstChild(bgPr, "gradFill");
      const blipFill = firstChild(bgPr, "blipFill");
      if (solid) {
        const col = extractColorFromFillParent(solid, themeColors);
        if (col) slideBgColor = col.color;
      } else if (grad) {
        const gs = findDescendants(grad, "gs")[0];
        const col = extractColorFromFillParent(gs, themeColors);
        if (col) slideBgColor = col.color;
      } else if (bgRef) {
        const col = extractColorFromFillParent(bgRef, themeColors);
        if (col) slideBgColor = col.color;
      }
      if (blipFill) {
        const blip = firstChild(blipFill, "blip");
        const rId = attr(blip, "embed");
        if (rId && slideRels.has(rId)) {
          slideBgImagePath = resolveZipPath(baseDir, slideRels.get(rId)!.target);
        }
      }
    }

    const slideNodes: WhiteboardNode[] = [];
    const slideEdges: WhiteboardEdge[] = [];
    let detectedTitle = "";

    // Slide Containment Frame (Artboard) — anchored strictly at top-left (0, 0)
    const frameNode = makeSlideNode("artboard", 0, 0, slideW, slideH, {
      fillColor: slideBgColor,
      strokeColor: isDarkHex(slideBgColor) ? "#334155" : "#cbd5e1",
      strokeWidth: 1.5,
      cornerRadius: 6,
      text: `Slide ${sIdx + 1}`,
    });
    slideNodes.push(frameNode);

    if (slideBgImagePath) {
      const savedBg = await saveZipMedia(slideBgImagePath);
      if (savedBg) {
        const bgImgNode = makeSlideNode("image", 0, 0, slideW, slideH, {
          assetFileName: savedBg.assetFileName,
          naturalWidth: savedBg.naturalWidth,
          naturalHeight: savedBg.naturalHeight,
          imageFit: "cover",
          strokeWidth: 0,
          fillColor: null,
          locked: true,
        });
        slideNodes.push(bgImgNode);
      }
    }

    const spTree = findDescendants(slideXml, "spTree")[0];

    async function processTree(container: Element, tr: CoordTransform): Promise<void> {
      for (const el of childElements(container)) {
        const tag = localName(el);

        if (tag === "grpSp") {
          const grpSpPr = firstChild(el, "grpSpPr");
          const xfrm = firstChild(grpSpPr, "xfrm");
          const off = firstChild(xfrm, "off");
          const ext = firstChild(xfrm, "ext");
          const chOff = firstChild(xfrm, "chOff");
          const chExt = firstChild(xfrm, "chExt");
          if (off && ext && chOff && chExt) {
            const ox = numAttr(off, "x", 0);
            const oy = numAttr(off, "y", 0);
            const ex = Math.max(1, numAttr(ext, "cx", 1));
            const ey = Math.max(1, numAttr(ext, "cy", 1));
            const cox = numAttr(chOff, "x", 0);
            const coy = numAttr(chOff, "y", 0);
            const cex = Math.max(1, numAttr(chExt, "cx", ex));
            const cey = Math.max(1, numAttr(chExt, "cy", ey));
            const sx = ex / cex;
            const sy = ey / cey;
            const childTr: CoordTransform = {
              mapX: (x) => tr.mapX(ox + (x - cox) * sx),
              mapY: (y) => tr.mapY(oy + (y - coy) * sy),
              mapW: (w) => tr.mapW(w * sx),
              mapH: (h) => tr.mapH(h * sy),
              scaleX: tr.scaleX * sx,
              scaleY: tr.scaleY * sy,
            };
            await processTree(el, childTr);
          } else {
            await processTree(el, tr);
          }
          continue;
        }

        if (tag === "sp") {
          const nvSpPr = firstChild(el, "nvSpPr");
          const nvPr = firstChild(nvSpPr, "nvPr");
          const ph = firstChild(nvPr, "ph");
          const phType = attr(ph, "type");
          const spPr = firstChild(el, "spPr");
          const xfrm = parseXfrm(firstChild(spPr, "xfrm"));

          // Placeholder boxes sometimes omit xfrm and inherit standard title/body positions
          let bx = 0;
          let by = 0;
          let bw = 0;
          let bh = 0;
          if (xfrm && (xfrm.w > 0 || xfrm.h > 0)) {
            bx = tr.mapX(xfrm.x);
            by = tr.mapY(xfrm.y);
            bw = Math.max(12, tr.mapW(xfrm.w));
            bh = Math.max(12, tr.mapH(xfrm.h));
          } else if (phType === "title" || phType === "ctrTitle") {
            bx = 56;
            by = phType === "ctrTitle" ? Math.round(slideH * 0.3) : 34;
            bw = slideW - 112;
            bh = 76;
          } else if (phType === "subTitle") {
            bx = 96;
            by = Math.round(slideH * 0.5);
            bw = slideW - 192;
            bh = 68;
          } else if (phType === "body" || phType === "obj") {
            bx = 56;
            by = 128;
            bw = slideW - 112;
            bh = slideH - 168;
          } else {
            continue;
          }

          const prstGeom = firstChild(spPr, "prstGeom");
          const prst = attr(prstGeom, "prst");
          const txBody = firstChild(el, "txBody");
          const textInfo = extractTxBody(txBody, themeColors, pxPerPt, phType);
          const style = extractFillAndStroke(spPr, themeColors, pxPerEmu);

          // Check shape-level style reference (<p:style><a:fillRef>/<a:lnRef>) for themed shapes
          const pStyle = firstChild(el, "style");
          if (pStyle && !firstChild(spPr, "noFill") && !style.fillColor && !phType) {
            const fillRef = firstChild(pStyle, "fillRef");
            if (fillRef && numAttr(fillRef, "idx", 0) > 0) {
              const col = extractColorFromFillParent(fillRef, themeColors);
              if (col) style.fillColor = col.color;
            }
          }
          if (pStyle && style.strokeWidth === 0 && !phType && !firstChild(firstChild(spPr, "ln"), "noFill")) {
            const lnRef = firstChild(pStyle, "lnRef");
            if (lnRef && numAttr(lnRef, "idx", 0) > 0) {
              const col = extractColorFromFillParent(lnRef, themeColors);
              if (col) {
                style.strokeColor = col.color;
                style.strokeWidth = 1.5;
              }
            }
          }

          if ((phType === "title" || phType === "ctrTitle") && textInfo.text && !detectedTitle) {
            detectedTitle = textInfo.text.split("\n")[0].slice(0, 48);
          }

          // Skip invisible empty placeholders (e.g. empty slide number/footer slots)
          if (!textInfo.text && !style.fillColor && style.strokeWidth === 0) continue;

          const isPureText =
            Boolean(textInfo.text) &&
            !style.fillColor &&
            style.strokeWidth === 0 &&
            (!prst || prst === "rect" || prst === "roundRect");

          const effectiveBg = style.fillColor ?? slideBgColor;
          const fontColor =
            textInfo.fontColor ?? (isDarkHex(effectiveBg) ? "#f8fafc" : "#111827");

          if (isPureText) {
            const textNode = makeSlideNode("text", bx, by, bw, bh, {
              text: textInfo.text,
              fontSize: textInfo.fontSize,
              fontFamily: textInfo.fontFamily ?? "'Inter', system-ui, sans-serif",
              fontColor,
              fontWeight: textInfo.fontWeight,
              fontStyle: textInfo.fontStyle,
              textDecoration: textInfo.textDecoration,
              textAlign: textInfo.textAlign,
              verticalAlign: textInfo.verticalAlign,
              rotation: xfrm?.rot ? xfrm.rot : undefined,
            });
            slideNodes.push(textNode);
          } else {
            const mapped = mapOoxmlShapePreset(prst);
            const node = makeSlideNode(mapped.shapeType, bx, by, bw, bh, {
              ...mapped.overrides,
              fillColor: style.fillColor,
              fillOpacity: style.fillOpacity,
              strokeColor: style.strokeColor,
              strokeWidth: style.strokeWidth,
              strokeStyle: style.strokeStyle,
              strokeOpacity: style.strokeOpacity,
              text: textInfo.text,
              fontSize: textInfo.fontSize,
              fontFamily: textInfo.fontFamily ?? "'Inter', system-ui, sans-serif",
              fontColor,
              fontWeight: textInfo.fontWeight,
              fontStyle: textInfo.fontStyle,
              textDecoration: textInfo.textDecoration,
              textAlign: textInfo.textAlign,
              verticalAlign: textInfo.text ? textInfo.verticalAlign : "middle",
              rotation: xfrm?.rot ? xfrm.rot : undefined,
              flipHorizontal: xfrm?.flipH || undefined,
              flipVertical: xfrm?.flipV || undefined,
            });
            slideNodes.push(node);
          }
          continue;
        }

        if (tag === "cxnSp") {
          const spPr = firstChild(el, "spPr");
          const xfrm = parseXfrm(firstChild(spPr, "xfrm"));
          if (!xfrm) continue;
          const x1 = tr.mapX(xfrm.flipH ? xfrm.x + xfrm.w : xfrm.x);
          const y1 = tr.mapY(xfrm.flipV ? xfrm.y + xfrm.h : xfrm.y);
          const x2 = tr.mapX(xfrm.flipH ? xfrm.x : xfrm.x + xfrm.w);
          const y2 = tr.mapY(xfrm.flipV ? xfrm.y : xfrm.y + xfrm.h);
          const style = extractFillAndStroke(spPr, themeColors, pxPerEmu);
          const ln = firstChild(spPr, "ln");
          const headEnd = firstChild(ln, "headEnd");
          const tailEnd = firstChild(ln, "tailEnd");
          const edge: WhiteboardEdge = {
            ...createDefaultWhiteboardEdge(
              crypto.randomUUID(),
              { x: Math.round(x1), y: Math.round(y1) },
              { x: Math.round(x2), y: Math.round(y2) }
            ),
            strokeColor: style.strokeColor || (isDarkHex(slideBgColor) ? "#e2e8f0" : "#374151"),
            strokeWidth: Math.max(1.5, style.strokeWidth || 2),
            strokeStyle: style.strokeStyle,
            startArrowType: mapOoxmlArrowhead(attr(headEnd, "type")),
            endArrowType: mapOoxmlArrowhead(attr(tailEnd, "type")),
            routing: "straight",
          };
          slideEdges.push(edge);
          continue;
        }

        if (tag === "pic") {
          const spPr = firstChild(el, "spPr");
          const xfrm = parseXfrm(firstChild(spPr, "xfrm"));
          const blipFill = firstChild(el, "blipFill");
          const blip = firstChild(blipFill, "blip");
          const rId = attr(blip, "embed");
          if (!xfrm || !rId || !slideRels.has(rId)) continue;
          const mediaPath = resolveZipPath(baseDir, slideRels.get(rId)!.target);
          const saved = await saveZipMedia(mediaPath);
          if (!saved) continue;
          const cropFields = parseOoxmlImageCrop(blipFill);
          const imgNode = makeSlideNode(
            "image",
            tr.mapX(xfrm.x),
            tr.mapY(xfrm.y),
            Math.max(16, tr.mapW(xfrm.w)),
            Math.max(16, tr.mapH(xfrm.h)),
            {
              assetFileName: saved.assetFileName,
              naturalWidth: saved.naturalWidth,
              naturalHeight: saved.naturalHeight,
              imageFit: "cover",
              ...cropFields,
              fillColor: null,
              strokeWidth: 0,
              rotation: xfrm.rot ? xfrm.rot : undefined,
              flipHorizontal: xfrm.flipH || undefined,
              flipVertical: xfrm.flipV || undefined,
            }
          );
          slideNodes.push(imgNode);
          continue;
        }

        if (tag === "graphicFrame") {
          const tbl = findDescendants(el, "tbl")[0];
          const xfrm = parseXfrm(firstChild(el, "xfrm"));
          if (!tbl || !xfrm) continue;
          const gridCols = findDescendants(tbl, "gridCol");
          const rows = childElements(tbl, "tr");
          if (rows.length === 0) continue;

          const colCount = Math.max(1, gridCols.length || childElements(rows[0], "tc").length);
          const rowCount = rows.length;
          const cellText: string[][] = [];
          const cellFill: (string | null)[][] = [];
          for (const trEl of rows) {
            const cells = childElements(trEl, "tc");
            const tRow: string[] = [];
            const fRow: (string | null)[] = [];
            for (let c = 0; c < colCount; c++) {
              const tc = cells[c];
              const tx = tc ? extractTxBody(firstChild(tc, "txBody"), themeColors, pxPerPt, null) : null;
              tRow.push(tx?.text ?? "");
              const tcPr = tc ? firstChild(tc, "tcPr") : null;
              const solid = firstChild(tcPr, "solidFill");
              const col = extractColorFromFillParent(solid, themeColors);
              fRow.push(col?.color ?? null);
            }
            cellText.push(tRow);
            cellFill.push(fRow);
          }

          const colWidthsRaw = gridCols.map((gc) => Math.max(1, numAttr(gc, "w", 1)));
          const totalColW = colWidthsRaw.reduce((a, b) => a + b, 0);
          const tableColWidths =
            colWidthsRaw.length === colCount && totalColW > 0
              ? colWidthsRaw.map((v) => v / totalColW)
              : undefined;

          const tableNode = makeSlideNode(
            "table",
            tr.mapX(xfrm.x),
            tr.mapY(xfrm.y),
            Math.max(120, tr.mapW(xfrm.w)),
            Math.max(60, tr.mapH(xfrm.h)),
            {
              tableRows: rowCount,
              tableCols: colCount,
              tableHeaderRow: true,
              tableCellText: cellText,
              tableCellFill: cellFill,
              tableColWidths,
              fontSize: 13,
            }
          );
          slideNodes.push(tableNode);
        }
      }
    }

    if (spTree) {
      await processTree(spTree, rootTransform);
    }

    // Update frame title with detected slide heading
    if (detectedTitle) {
      frameNode.text = `${sIdx + 1}. ${detectedTitle}`;
    }

    // Optional Speaker Notes -> neat yellow sticky note below slide frame
    if (options.includeSpeakerNotes) {
      for (const rel of slideRels.values()) {
        if (rel.type.toLowerCase().includes("notesslide")) {
          const notesPath = resolveZipPath(baseDir, rel.target);
          const notesEntry = zip.file(notesPath);
          if (notesEntry) {
            const notesDoc = parseXml(await notesEntry.async("string"));
            const bodyShapes = findDescendants(notesDoc, "sp").filter((sp) => {
              const ph = findDescendants(sp, "ph")[0];
              return attr(ph, "type") === "body";
            });
            const noteChunks = bodyShapes
              .map((sp) => extractTxBody(firstChild(sp, "txBody"), themeColors, pxPerPt, null).text)
              .filter(Boolean);
            const noteText = noteChunks.join("\n").trim();
            if (noteText) {
              const stickyH = Math.min(220, Math.max(96, Math.ceil(noteText.length / 44) * 20 + 36));
              const sticky = makeSlideNode("note", 0, slideH + 18, Math.min(slideW, 420), stickyH, {
                fillColor: "#fef08a",
                strokeColor: "#eab308",
                strokeWidth: 1.5,
                shadowEnabled: true,
                shadowBlur: 10,
                shadowOffsetY: 3,
                shadowOpacity: 0.14,
                fontSize: 12,
                textAlign: "left",
                verticalAlign: "top",
                text: `Speaker notes:\n${noteText}`,
              });
              slideNodes.push(sticky);
            }
          }
          break;
        }
      }
    }

    slides.push({
      name: frameNode.text,
      width: slideW,
      height: slideH,
      nodes: slideNodes,
      edges: slideEdges,
    });
  }

  return { slides };
}

// ---- PDF Slide Deck Pixel-Perfect Importer -----------------------------------------------------

/**
 * Renders every page of a PDF slide deck at crisp 2x HiDPI into locked slide images placed inside
 * ordered Containment Frames (ready for Presentation Mode + live Ink/Highlighter/Laser overlays).
 */
export async function importPdfSlides(
  bytes: ArrayBuffer | Uint8Array,
  options: PdfImportOptions
): Promise<ImportedSlideDeck> {
  ensureWorkerConfigured();
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const loadingTask = getDocument({ data });
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  if (numPages === 0) {
    throw new Error("This PDF has no pages.");
  }

  const slides: ImportedSlide[] = [];
  try {
    for (let i = 1; i <= numPages; i++) {
      options.onProgress?.(i, numPages, `Rendering slide ${i} of ${numPages}…`);
      const page = await pdf.getPage(i);
      const baseVp = page.getViewport({ scale: 1 });
      const displayW = TARGET_SLIDE_WIDTH;
      const displayH = Math.max(200, Math.round((baseVp.height / Math.max(1, baseVp.width)) * displayW));

      // Render at ~2x display width (1920px wide) for razor-sharp HiDPI projection & zooming
      const renderScale = Math.min(3, Math.max(1.25, (displayW * 2) / Math.max(1, baseVp.width)));
      const vp = page.getViewport({ scale: renderScale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Failed to acquire 2D canvas context for PDF slide rendering.");

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to encode PDF slide image."))), "image/png");
      });
      const pngBytes = new Uint8Array(await blob.arrayBuffer());
      const saved = await options.saveImage(pngBytes, "image/png");

      const frameNode = makeSlideNode("artboard", 0, 0, displayW, displayH, {
        fillColor: "#ffffff",
        strokeColor: "#cbd5e1",
        strokeWidth: 1.5,
        cornerRadius: 6,
        text: `Slide ${i}`,
      });
      const imgNode = makeSlideNode("image", 0, 0, displayW, displayH, {
        assetFileName: saved.assetFileName,
        naturalWidth: saved.naturalWidth,
        naturalHeight: saved.naturalHeight,
        imageFit: "cover",
        fillColor: null,
        strokeWidth: 0,
        locked: true,
      });

      slides.push({
        name: `Slide ${i}`,
        width: displayW,
        height: displayH,
        nodes: [frameNode, imgNode],
        edges: [],
      });
    }
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }

  return { slides };
}
