// utils/docxLetterhead.ts
//
// A Word letterhead - the header and footer parts of a .docx - drawn as a sheet-sized SVG, the
// stationery layer docLetterhead.ts puts on every page. Real letterheads aren't text: they're
// DrawingML shapes (bands, swooshes drawn as custom paths), groups, text boxes holding the company
// name and address, and logos placed relative to the page edge - none of which mammoth reads. So
// this renders them itself:
//   - shapes and pictures become SVG (preset and custom geometry, solid/gradient/picture fills,
//     outlines, theme colours with their lum/tint/shade/alpha modifiers, rotation and flips),
//     positioned by Word's own frames (page, margin, column, paragraph, the margins themselves,
//     alignment or offset or percentage)
//   - text - the band's flowing paragraphs, text boxes, table cells - becomes XHTML inside
//     <foreignObject>, styled inline from the resolved Word styles (docxStyleResolver.ts) so it
//     wraps and sizes as Word sets it, tab stops included
//   - legacy VML (w:pict, and the fallbacks inside mc:AlternateContent) is read when that's all
//     there is
// The flow text is laid out in a hidden live container first: its height gives the text-safe area
// by Word's rule (the body starts below max(top margin, header distance + header text height),
// anchored shapes never push it), and paragraph positions place paragraph-anchored shapes.
// Page-number fields are left out - the page chrome draws live numbers (docPageChrome.ts).
import type JSZip from "jszip";
import {
  attr,
  borderCss,
  directChild,
  directChildren,
  elementChildren,
  EMU_PER_PX,
  extractPPr,
  extractRPr,
  loadStyleContext,
  localTag,
  mergePPr,
  mergeRPr,
  resolveColorAttr,
  TWIPS_PER_IN,
  type DocxStyleContext,
  type RawPPr,
  type RawRPr,
  type ThemeData,
} from "./docxStyleResolver";

const PX_PER_TWIP = 96 / TWIPS_PER_IN;
const XHTML = "http://www.w3.org/1999/xhtml";

export interface LetterheadBands {
  svg: string; // the whole sheet, CSS px
  topIn: number; // where body text can start, by Word's rule
  bottomIn: number; // how far above the bottom edge body text must stop
  hasContent: boolean;
}

export interface DocxLetterhead {
  widthPx: number;
  heightPx: number;
  first: LetterheadBands;
  rest: LetterheadBands; // the same as first unless the document has a different first page
  differentFirst: boolean;
  margins: { top: number; right: number; bottom: number; left: number }; // the document's own, inches
  // Whether the bands hold more than plain text (pictures, shapes, text boxes, tables) - only then
  // is a letterhead the right home for them rather than the editable text header/footer.
  rich: boolean;
}

// ------------------------------------------------------------------------------------------------
// Colours

const PRESET_COLORS: Record<string, string> = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080", darkGray: "A9A9A9", lightGray: "D3D3D3", navy: "000080", orange: "FFA500" };

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

interface Paint {
  color: string; // #rrggbb
  opacity: number;
}

// A DrawingML colour element (a:srgbClr, a:schemeClr, ...) with its modifiers.
function readColor(el: Element | null, theme: ThemeData, placeholder?: Paint): Paint | null {
  if (!el) return null;
  const kind = localTag(el);
  let hex: string | null = null;
  if (kind === "srgbClr") hex = attr(el, "val");
  else if (kind === "sysClr") hex = attr(el, "lastClr") ?? (attr(el, "val") === "window" ? "FFFFFF" : "000000");
  else if (kind === "prstClr") hex = PRESET_COLORS[attr(el, "val") ?? ""] ?? null;
  else if (kind === "scrgbClr") {
    const c = (n: string) => Math.round((parseInt(attr(el, n) ?? "0", 10) / 100000) * 255);
    hex = [c("r"), c("g"), c("b")].map((v) => v.toString(16).padStart(2, "0")).join("");
  } else if (kind === "schemeClr") {
    const v = attr(el, "val") ?? "";
    if (v === "phClr" && placeholder) hex = placeholder.color.slice(1);
    else {
      const alias: Record<string, string> = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };
      const c = theme.colors[alias[v] ?? v] ?? theme.colors[v];
      hex = c ? c.slice(1) : null;
    }
  }
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  let r = parseInt(hex.slice(0, 2), 16);
  let g = parseInt(hex.slice(2, 4), 16);
  let b = parseInt(hex.slice(4, 6), 16);
  let opacity = 1;
  for (const m of elementChildren(el)) {
    const v = parseInt(attr(m, "val") ?? "0", 10) / 100000;
    switch (localTag(m)) {
      case "lumMod":
      case "lumOff": {
        const [h, s, l] = rgbToHsl(r, g, b);
        const nl = localTag(m) === "lumMod" ? l * v : l + v;
        [r, g, b] = hslToRgb(h, s, Math.min(1, Math.max(0, nl)));
        break;
      }
      case "satMod": {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h, Math.min(1, s * v), l);
        break;
      }
      case "tint":
        r = r * v + 255 * (1 - v);
        g = g * v + 255 * (1 - v);
        b = b * v + 255 * (1 - v);
        break;
      case "shade":
        r *= v;
        g *= v;
        b *= v;
        break;
      case "alpha":
        opacity = v;
        break;
    }
  }
  const to = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return { color: `#${to(r)}${to(g)}${to(b)}`, opacity };
}

const firstColor = (parent: Element | null, theme: ThemeData, ph?: Paint): Paint | null => {
  if (!parent) return null;
  for (const c of elementChildren(parent)) {
    const p = readColor(c, theme, ph);
    if (p) return p;
  }
  return null;
};

const n = (v: number) => (Math.round(v * 100) / 100).toString();

// ------------------------------------------------------------------------------------------------
// Rendering context

interface PartCtx {
  style: DocxStyleContext;
  theme: ThemeData;
  images: Map<string, string>; // rId -> data: URL
  page: { w: number; h: number; mL: number; mR: number; mT: number; mB: number };
  defs: string[];
  idSeq: { n: number };
  hasRich: { v: boolean };
}

// An anchored object waiting for layout: everything but its paragraph-relative y is known.
interface Floating {
  z: number;
  behind: boolean;
  // Absolute position, or relative to its paragraph's top (resolved after measuring the flow).
  x: number;
  y: number;
  yFromParagraph: HTMLElement | null;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  body: (x: number, y: number) => string; // SVG for the object at its final top-left
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff" };

async function partImages(zip: JSZip, partPath: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const relsPath = partPath.replace(/([^/]+)$/, "_rels/$1.rels");
  const relsXml = await zip.file(relsPath)?.async("string");
  if (!relsXml) return out;
  const ids = Array.from(relsXml.matchAll(/<Relationship\b[^>]*>/g)).map((m) => m[0]);
  for (const rel of ids) {
    const id = rel.match(/\bId="([^"]+)"/)?.[1];
    const target = rel.match(/\bTarget="([^"]+)"/)?.[1];
    const type = rel.match(/\bType="([^"]+)"/)?.[1] ?? "";
    if (!id || !target || !/\/image$/.test(type)) continue;
    const path = target.startsWith("/") ? target.slice(1) : `word/${target.replace(/^\.\//, "")}`.replace(/word\/\.\.\//, "");
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME[ext];
    const file = zip.file(path);
    if (!mime || !file) continue; // EMF/WMF can't be drawn in a browser
    out.set(id, `data:${mime};base64,${await file.async("base64")}`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Text (XHTML)

const FONT_FALLBACK = (font: string) => {
  const serif = /times|cambria|georgia|garamond|book|serif|palatino|minion/i.test(font);
  return `"${font.replace(/"/g, "")}", ${serif ? '"Times New Roman", serif' : "Calibri, Arial, sans-serif"}`;
};

function runCss(r: RawRPr, el: Element | null): string {
  const css: string[] = [];
  if (r.fontFamily) css.push(`font-family:${FONT_FALLBACK(r.fontFamily)}`);
  if (r.fontSizePt) css.push(`font-size:${r.fontSizePt}pt`);
  if (r.bold) css.push("font-weight:700");
  if (r.italic) css.push("font-style:italic");
  const strike = el && directChild(directChild(el, "rPr"), "strike");
  const deco = [r.underline ? "underline" : "", strike && attr(strike, "w:val") !== "0" && attr(strike, "w:val") !== "false" ? "line-through" : ""].filter(Boolean);
  if (deco.length) css.push(`text-decoration:${deco.join(" ")}`);
  if (r.color) css.push(`color:${r.color}`);
  if (r.caps) css.push("text-transform:uppercase");
  if (r.smallCaps) css.push("font-variant:small-caps");
  // Character scale (w:w, Word's "Scale" - 105% etc.) as extra letter spacing: about half an em
  // per character per unit of scale, close enough that lines break where Word breaks them.
  const scale = parseInt(attr(directChild(directChild(el, "rPr"), "w"), "w:val") ?? "100", 10);
  const scaleEm = Number.isFinite(scale) && scale !== 100 ? ((scale - 100) / 100) * 0.55 : 0;
  if (r.spacingTwips || scaleEm) css.push(`letter-spacing:calc(${(r.spacingTwips ?? 0) / 20}pt + ${n(scaleEm)}em)`);
  if (r.highlight) css.push(`background:${r.highlight}`);
  const va = attr(directChild(directChild(el, "rPr"), "vertAlign"), "w:val");
  if (va === "superscript") css.push("vertical-align:super;font-size:0.7em");
  if (va === "subscript") css.push("vertical-align:sub;font-size:0.7em");
  return css.join(";");
}

function xh(tag: string, style?: string, text?: string): HTMLElement {
  const el = document.createElementNS(XHTML, tag) as HTMLElement;
  if (style) el.setAttribute("style", style);
  if (text !== undefined) el.textContent = text;
  return el;
}

const PAGE_FIELDS = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i;

interface Segment {
  nodes: HTMLElement[];
}

// One paragraph as XHTML. Anchored drawings inside it are collected into `floats` with this
// paragraph as their vertical frame where they ask for one.
function renderParagraph(p: Element, ctx: PartCtx, floats: Floating[]): HTMLElement {
  const directPPr = extractPPr(directChild(p, "pPr"), ctx.theme);
  const chain = ctx.style.resolveParagraphStyleChain(directPPr.pStyle);
  const pPr: RawPPr = mergePPr(chain.pPr, directPPr);
  const markRPr = mergeRPr(chain.rPr, directPPr.rPr);
  const div = xh("div");
  const segments: Segment[] = [{ nodes: [] }];
  let inField: "instr" | "result" | null = null;
  let instr = "";
  let hideResult = false;
  let maxFontPt = markRPr.fontSizePt ?? 11;

  const pushRun = (r: Element) => {
    const directR = extractRPr(directChild(r, "rPr"), ctx.theme);
    const rPr = mergeRPr(mergeRPr(chain.rPr, ctx.style.resolveCharacterStyleChain(directR.rStyle)), directR);
    if (rPr.fontSizePt) maxFontPt = Math.max(maxFontPt, rPr.fontSizePt);
    const css = runCss(rPr, r);
    for (const c of elementChildren(r)) {
      const t = localTag(c);
      if (t === "fldChar") {
        const ft = attr(c, "w:fldCharType");
        if (ft === "begin") {
          inField = "instr";
          instr = "";
        } else if (ft === "separate") {
          inField = "result";
          hideResult = PAGE_FIELDS.test(instr);
        } else if (ft === "end") {
          inField = null;
          hideResult = false;
        }
        continue;
      }
      if (t === "instrText") {
        if (inField === "instr") instr += c.textContent ?? "";
        continue;
      }
      if (inField === "instr" || (inField === "result" && hideResult)) continue;
      if (t === "t") segments[segments.length - 1].nodes.push(xh("span", css, c.textContent ?? ""));
      else if (t === "tab" || t === "ptab") segments.push({ nodes: [] });
      else if (t === "br") segments[segments.length - 1].nodes.push(xh("br"));
      else if (t === "noBreakHyphen") segments[segments.length - 1].nodes.push(xh("span", css, "‑"));
      else if (t === "sym") {
        const code = parseInt(attr(c, "w:char") ?? "", 16);
        if (Number.isFinite(code)) segments[segments.length - 1].nodes.push(xh("span", `${css};font-family:"${attr(c, "w:font") ?? "Symbol"}"`, String.fromCodePoint(code >= 0xf000 ? code - 0xf000 : code)));
      } else if (t === "drawing") handleDrawing(c, ctx, floats, div, segments[segments.length - 1]);
      else if (t === "pict") handleVml(c, ctx, floats, div);
      else if (t === "AlternateContent") {
        const choice = directChild(c, "Choice");
        const drawing = choice && directChild(choice, "drawing");
        if (drawing) handleDrawing(drawing, ctx, floats, div, segments[segments.length - 1]);
        else {
          const fb = directChild(c, "Fallback");
          const pict = fb && directChild(fb, "pict");
          if (pict) handleVml(pict, ctx, floats, div);
        }
      }
    }
  };

  const walk = (el: Element) => {
    for (const c of elementChildren(el)) {
      const t = localTag(c);
      if (t === "r") pushRun(c);
      else if (t === "fldSimple") {
        if (!PAGE_FIELDS.test(attr(c, "w:instr") ?? "")) walk(c);
      } else if (t === "hyperlink" || t === "smartTag" || t === "ins" || t === "sdtContent" || t === "customXml") walk(c);
      else if (t === "sdt") {
        const content = directChild(c, "sdtContent");
        if (content) walk(content);
      }
    }
  };
  walk(p);

  // Paragraph box.
  const css: string[] = ["position:relative", "margin:0"];
  if (pPr.textAlign) css.push(`text-align:${pPr.textAlign}`);
  if (pPr.spaceBeforePt) css.push(`padding-top:${pPr.spaceBeforePt}pt`);
  if (pPr.spaceAfterPt) css.push(`padding-bottom:${pPr.spaceAfterPt}pt`);
  if (pPr.indentLeftIn) css.push(`margin-left:${pPr.indentLeftIn}in`);
  if (pPr.indentRightIn) css.push(`margin-right:${pPr.indentRightIn}in`);
  if (pPr.indentFirstIn) css.push(`text-indent:${pPr.indentFirstIn}in`);
  const lineCss = (() => {
    if (!pPr.lineTwips) return "line-height:1.17";
    if (pPr.lineRule === "exact") return `line-height:${pPr.lineTwips / 20}pt`;
    if (pPr.lineRule === "atLeast") return `line-height:max(1.17em, ${pPr.lineTwips / 20}pt)`;
    return `line-height:${n((pPr.lineTwips / 240) * 1.17)}`;
  })();
  css.push(lineCss);
  if (pPr.borderBottom) css.push(`border-bottom:${pPr.borderBottom}`);
  if (pPr.borderTop) css.push(`border-top:${pPr.borderTop}`);
  if (pPr.shading) css.push(`background:${pPr.shading}`);
  const base = runCss(markRPr, null);
  div.setAttribute("style", [base, ...css].join(";"));

  const empty = segments.every((s) => s.nodes.length === 0);
  if (segments.length === 1 || empty) {
    for (const node of segments[0].nodes) div.appendChild(node);
    // An empty paragraph still takes a line at its mark's size, as in Word.
    if (empty || !div.textContent) div.appendChild(xh("span", runCss(markRPr, null), "​"));
    return div;
  }

  // Tab stops: each later segment sits at the next stop, aligned as the stop says. Without stops,
  // Word's defaults every half inch.
  const stops = (pPr.tabs ?? []).filter((t) => t.val !== "clear" && t.val !== "bar");
  const lineH = Math.round(maxFontPt * 1.17 * (96 / 72));
  const row = xh("div", `position:relative;height:${lineH}px;white-space:nowrap;text-indent:0`);
  let lastPos = (pPr.indentLeftIn ?? 0) * TWIPS_PER_IN;
  segments.forEach((seg, i) => {
    const span = xh("span", "position:absolute;top:0;white-space:nowrap");
    for (const node of seg.nodes) span.appendChild(node);
    if (i === 0) {
      span.style.left = "0";
    } else {
      const stop = stops.find((s) => s.pos > lastPos + 1) ?? { pos: (Math.floor(lastPos / 720) + 1) * 720, val: "left" };
      lastPos = stop.pos;
      const x = stop.pos * PX_PER_TWIP - (pPr.indentLeftIn ?? 0) * 96;
      span.style.left = `${n(x)}px`;
      if (stop.val === "center") span.style.transform = "translateX(-50%)";
      else if (stop.val === "right" || stop.val === "end" || stop.val === "decimal") span.style.transform = "translateX(-100%)";
    }
    row.appendChild(span);
  });
  div.appendChild(row);
  return div;
}

function renderTable(tbl: Element, ctx: PartCtx, floats: Floating[]): HTMLElement {
  const table = xh("table", "border-collapse:collapse;table-layout:fixed");
  const grid = directChildren(directChild(tbl, "tblGrid"), "gridCol").map((g) => parseInt(attr(g, "w:w") ?? "0", 10) * PX_PER_TWIP);
  if (grid.length) table.style.width = `${n(grid.reduce((a, b) => a + b, 0))}px`;
  const jc = attr(directChild(directChild(tbl, "tblPr"), "jc"), "w:val");
  if (jc === "center") table.style.margin = "0 auto";
  else if (jc === "right" || jc === "end") table.style.marginLeft = "auto";
  const tb = directChild(directChild(tbl, "tblPr"), "tblBorders");
  const rows = directChildren(tbl, "tr");
  rows.forEach((tr, ri) => {
    const row = xh("tr");
    let col = 0;
    directChildren(tr, "tc").forEach((tc) => {
      const tcPr = directChild(tc, "tcPr");
      const span = Math.max(1, parseInt(attr(directChild(tcPr, "gridSpan"), "w:val") ?? "1", 10) || 1);
      const td = xh("td", "padding:0 5.4pt;vertical-align:top");
      if (span > 1) td.setAttribute("colspan", String(span));
      const width = grid.slice(col, col + span).reduce((a, b) => a + b, 0);
      if (width) td.style.width = `${n(width)}px`;
      const first = col === 0;
      col += span;
      const last = col >= grid.length;
      const cb = directChild(tcPr, "tcBorders");
      const edge = (own: string, outer: string, inner: string, isOuter: boolean) =>
        borderCss(directChild(cb, own), ctx.theme) ?? borderCss(directChild(tb, isOuter ? outer : inner), ctx.theme) ?? "none";
      td.style.borderTop = edge("top", "top", "insideH", ri === 0);
      td.style.borderBottom = edge("bottom", "bottom", "insideH", ri === rows.length - 1);
      td.style.borderLeft = edge("left", "left", "insideV", first);
      td.style.borderRight = edge("right", "right", "insideV", last);
      const fill = resolveColorAttr(directChild(tcPr, "shd"), ctx.theme, "w:fill");
      if (fill) td.style.background = fill;
      const va = attr(directChild(tcPr, "vAlign"), "w:val");
      if (va === "center") td.style.verticalAlign = "middle";
      else if (va === "bottom") td.style.verticalAlign = "bottom";
      renderBlocks(tc, ctx, floats).forEach((b) => td.appendChild(b));
      row.appendChild(td);
    });
    table.appendChild(row);
  });
  return table;
}

function renderBlocks(container: Element, ctx: PartCtx, floats: Floating[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of elementChildren(container)) {
    const t = localTag(el);
    if (t === "p") out.push(renderParagraph(el, ctx, floats));
    else if (t === "tbl") {
      ctx.hasRich.v = true;
      out.push(renderTable(el, ctx, floats));
    } else if (t === "sdt") {
      const c = directChild(el, "sdtContent");
      if (c) out.push(...renderBlocks(c, ctx, floats));
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// DrawingML

const emu = (v: string | null | undefined) => (parseInt(v ?? "0", 10) || 0) / EMU_PER_PX;

interface Xfrm {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  chX?: number;
  chY?: number;
  chW?: number;
  chH?: number;
}

function readXfrm(el: Element | null): Xfrm | null {
  if (!el) return null;
  const off = directChild(el, "off");
  const ext = directChild(el, "ext");
  const chOff = directChild(el, "chOff");
  const chExt = directChild(el, "chExt");
  return {
    x: emu(attr(off, "x")),
    y: emu(attr(off, "y")),
    w: emu(attr(ext, "cx")),
    h: emu(attr(ext, "cy")),
    rot: (parseInt(attr(el, "rot") ?? "0", 10) || 0) / 60000,
    flipH: attr(el, "flipH") === "1",
    flipV: attr(el, "flipV") === "1",
    ...(chOff || chExt ? { chX: emu(attr(chOff, "x")), chY: emu(attr(chOff, "y")), chW: emu(attr(chExt, "cx")), chH: emu(attr(chExt, "cy")) } : {}),
  };
}

const first = (el: Element | null, name: string): Element | null => {
  if (!el) return null;
  const all = el.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) if (localTag(all[i]) === name) return all[i];
  return null;
};

function geometryPath(spPr: Element | null, w: number, h: number): string {
  const prst = directChild(spPr, "prstGeom");
  if (prst) {
    const kind = attr(prst, "prst") ?? "rect";
    const adj = (() => {
      const gd = first(prst, "gd");
      const v = gd ? parseInt((attr(gd, "fmla") ?? "").replace(/^val\s+/, ""), 10) : NaN;
      return Number.isFinite(v) ? v / 100000 : null;
    })();
    switch (kind) {
      case "roundRect": {
        const r = Math.min(w, h) * (adj ?? 0.16667);
        return `M${n(r)} 0H${n(w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(w)} ${n(r)}V${n(h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(w - r)} ${n(h)}H${n(r)}A${n(r)} ${n(r)} 0 0 1 0 ${n(h - r)}V${n(r)}A${n(r)} ${n(r)} 0 0 1 ${n(r)} 0Z`;
      }
      case "ellipse":
      case "flowChartConnector":
        return `M0 ${n(h / 2)}A${n(w / 2)} ${n(h / 2)} 0 1 0 ${n(w)} ${n(h / 2)}A${n(w / 2)} ${n(h / 2)} 0 1 0 0 ${n(h / 2)}Z`;
      case "line":
      case "straightConnector1":
        return `M0 0L${n(w)} ${n(h)}`;
      case "triangle":
        return `M${n(w * (adj ?? 0.5))} 0L${n(w)} ${n(h)}H0Z`;
      case "rtTriangle":
        return `M0 0L${n(w)} ${n(h)}H0Z`;
      case "diamond":
        return `M${n(w / 2)} 0L${n(w)} ${n(h / 2)}L${n(w / 2)} ${n(h)}L0 ${n(h / 2)}Z`;
      case "parallelogram": {
        const o = Math.min(w, h) * (adj ?? 0.25);
        return `M${n(o)} 0H${n(w)}L${n(w - o)} ${n(h)}H0Z`;
      }
      case "trapezoid": {
        const o = Math.min(w, h) * (adj ?? 0.25);
        return `M${n(o)} 0H${n(w - o)}L${n(w)} ${n(h)}H0Z`;
      }
      case "hexagon": {
        const o = Math.min(w, h) * (adj ?? 0.25);
        return `M${n(o)} 0H${n(w - o)}L${n(w)} ${n(h / 2)}L${n(w - o)} ${n(h)}H${n(o)}L0 ${n(h / 2)}Z`;
      }
      case "homePlate": {
        const o = Math.min(w, h) * (adj ?? 0.5);
        return `M0 0H${n(w - o)}L${n(w)} ${n(h / 2)}L${n(w - o)} ${n(h)}H0Z`;
      }
      case "chevron": {
        const o = Math.min(w, h) * (adj ?? 0.5);
        return `M0 0H${n(w - o)}L${n(w)} ${n(h / 2)}L${n(w - o)} ${n(h)}H0L${n(o)} ${n(h / 2)}Z`;
      }
      default:
        return `M0 0H${n(w)}V${n(h)}H0Z`;
    }
  }
  const cust = directChild(spPr, "custGeom");
  const pathLst = directChild(cust, "pathLst");
  if (!pathLst) return `M0 0H${n(w)}V${n(h)}H0Z`;
  const out: string[] = [];
  for (const path of directChildren(pathLst, "path")) {
    const pw = parseInt(attr(path, "w") ?? "0", 10) || 0;
    const ph = parseInt(attr(path, "h") ?? "0", 10) || 0;
    const sx = pw ? w / pw : 1 / EMU_PER_PX;
    const sy = ph ? h / ph : 1 / EMU_PER_PX;
    const pt = (el: Element | null): [number, number] => [(parseInt(attr(el, "x") ?? "0", 10) || 0) * sx, (parseInt(attr(el, "y") ?? "0", 10) || 0) * sy];
    let cur: [number, number] = [0, 0];
    for (const cmd of elementChildren(path)) {
      const pts = directChildren(cmd, "pt").map(pt);
      switch (localTag(cmd)) {
        case "moveTo":
          cur = pts[0];
          out.push(`M${n(cur[0])} ${n(cur[1])}`);
          break;
        case "lnTo":
          cur = pts[0];
          out.push(`L${n(cur[0])} ${n(cur[1])}`);
          break;
        case "cubicBezTo":
          if (pts.length === 3) {
            out.push(`C${pts.map((p) => `${n(p[0])} ${n(p[1])}`).join(" ")}`);
            cur = pts[2];
          }
          break;
        case "quadBezTo":
          if (pts.length === 2) {
            out.push(`Q${pts.map((p) => `${n(p[0])} ${n(p[1])}`).join(" ")}`);
            cur = pts[1];
          }
          break;
        case "arcTo": {
          const wR = (parseInt(attr(cmd, "wR") ?? "0", 10) || 0) * sx;
          const hR = (parseInt(attr(cmd, "hR") ?? "0", 10) || 0) * sy;
          const st = ((parseInt(attr(cmd, "stAng") ?? "0", 10) || 0) / 60000) * (Math.PI / 180);
          const sw = ((parseInt(attr(cmd, "swAng") ?? "0", 10) || 0) / 60000) * (Math.PI / 180);
          const cx = cur[0] - wR * Math.cos(st);
          const cy = cur[1] - hR * Math.sin(st);
          const end: [number, number] = [cx + wR * Math.cos(st + sw), cy + hR * Math.sin(st + sw)];
          out.push(`A${n(wR)} ${n(hR)} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${n(end[0])} ${n(end[1])}`);
          cur = end;
          break;
        }
        case "close":
          out.push("Z");
          break;
      }
    }
  }
  return out.join("");
}

// fill="..." stroke="..." attributes for a shape, from spPr and the shape style's references.
function paintAttrs(spPr: Element | null, styleEl: Element | null, ctx: PartCtx, box: { w: number; h: number }): { fill: string; stroke: string; text?: Paint } {
  const fillRef = directChild(styleEl, "fillRef");
  const lnRef = directChild(styleEl, "lnRef");
  const refFill = fillRef && attr(fillRef, "idx") !== "0" ? firstColor(fillRef, ctx.theme) : null;
  const refLine = lnRef && attr(lnRef, "idx") !== "0" ? firstColor(lnRef, ctx.theme) : null;

  let fill = "none";
  const solid = directChild(spPr, "solidFill");
  const grad = directChild(spPr, "gradFill");
  const blip = directChild(spPr, "blipFill");
  const patt = directChild(spPr, "pattFill");
  if (directChild(spPr, "noFill")) fill = 'fill="none"';
  else if (solid) {
    const p = firstColor(solid, ctx.theme, refFill ?? undefined);
    fill = p ? `fill="${p.color}"${p.opacity < 1 ? ` fill-opacity="${n(p.opacity)}"` : ""}` : 'fill="none"';
  } else if (grad) {
    const id = `g${ctx.idSeq.n++}`;
    const stops = directChildren(directChild(grad, "gsLst"), "gs")
      .map((gs) => ({ pos: (parseInt(attr(gs, "pos") ?? "0", 10) || 0) / 1000, paint: firstColor(gs, ctx.theme) }))
      .filter((s) => s.paint);
    const lin = directChild(grad, "lin");
    const ang = ((parseInt(attr(lin, "ang") ?? "0", 10) || 0) / 60000) * (Math.PI / 180);
    const dx = Math.cos(ang) / 2;
    const dy = Math.sin(ang) / 2;
    ctx.defs.push(
      `<linearGradient id="${id}" x1="${n(0.5 - dx)}" y1="${n(0.5 - dy)}" x2="${n(0.5 + dx)}" y2="${n(0.5 + dy)}">${stops
        .map((s) => `<stop offset="${n(s.pos)}%" stop-color="${s.paint!.color}" stop-opacity="${n(s.paint!.opacity)}"/>`)
        .join("")}</linearGradient>`
    );
    fill = `fill="url(#${id})"`;
  } else if (blip) {
    const id = attr(directChild(blip, "blip"), "r:embed");
    const src = id ? ctx.images.get(id) : undefined;
    if (src) {
      const pid = `p${ctx.idSeq.n++}`;
      ctx.defs.push(`<pattern id="${pid}" patternUnits="objectBoundingBox" width="1" height="1"><image href="${src}" width="${n(box.w)}" height="${n(box.h)}" preserveAspectRatio="none"/></pattern>`);
      fill = `fill="url(#${pid})"`;
    }
  } else if (patt) {
    const p = firstColor(directChild(patt, "fgClr"), ctx.theme);
    fill = p ? `fill="${p.color}"` : 'fill="none"';
  } else if (refFill) fill = `fill="${refFill.color}"`;
  else fill = 'fill="none"';

  let stroke = 'stroke="none"';
  const ln = directChild(spPr, "ln");
  if (ln && !directChild(ln, "noFill")) {
    const p = firstColor(directChild(ln, "solidFill"), ctx.theme, refLine ?? undefined) ?? firstColor(directChild(directChild(ln, "gradFill"), "gsLst")?.getElementsByTagName("a:gs")[0] ?? null, ctx.theme) ?? refLine;
    const w = Math.max(0.5, emu(attr(ln, "w")) || 1);
    const dash = attr(directChild(ln, "prstDash"), "val");
    const dasharray = dash === "dash" || dash === "lgDash" ? ` stroke-dasharray="${n(w * 4)} ${n(w * 3)}"` : dash === "dot" || dash === "sysDot" ? ` stroke-dasharray="${n(w)} ${n(w * 2)}"` : "";
    if (p) stroke = `stroke="${p.color}" stroke-width="${n(w)}"${p.opacity < 1 ? ` stroke-opacity="${n(p.opacity)}"` : ""}${dasharray}`;
  } else if (!ln && refLine) stroke = `stroke="${refLine.color}" stroke-width="1"`;
  return { fill, stroke };
}

function picture(pic: Element, ctx: PartCtx, w: number, h: number): string {
  const blipFill = first(pic, "blipFill");
  const blip = directChild(blipFill, "blip") ?? first(pic, "blip");
  const id = attr(blip, "r:embed");
  const src = id ? ctx.images.get(id) : undefined;
  if (!src) return "";
  ctx.hasRich.v = true;
  const rect = directChild(blipFill, "srcRect");
  const l = (parseInt(attr(rect, "l") ?? "0", 10) || 0) / 100000;
  const t = (parseInt(attr(rect, "t") ?? "0", 10) || 0) / 100000;
  const r = (parseInt(attr(rect, "r") ?? "0", 10) || 0) / 100000;
  const b = (parseInt(attr(rect, "b") ?? "0", 10) || 0) / 100000;
  if (!l && !t && !r && !b) return `<image href="${src}" x="0" y="0" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"/>`;
  // Cropped: the full picture scaled so the kept part fills the box, clipped to the box.
  const fw = w / Math.max(0.01, 1 - l - r);
  const fh = h / Math.max(0.01, 1 - t - b);
  return `<svg x="0" y="0" width="${n(w)}" height="${n(h)}" overflow="hidden"><image href="${src}" x="${n(-l * fw)}" y="${n(-t * fh)}" width="${n(fw)}" height="${n(fh)}" preserveAspectRatio="none"/></svg>`;
}

// A shape's text box as an XHTML block inside a foreignObject over the shape's box.
function textBox(txbx: Element | null, bodyPr: Element | null, ctx: PartCtx, w: number, h: number): string {
  const content = first(txbx, "txbxContent");
  if (!content) return "";
  const floats: Floating[] = [];
  const blocks = renderBlocks(content, ctx, floats);
  const ins = (name: string, def: number) => (attr(bodyPr, name) !== null ? emu(attr(bodyPr, name)) : def / EMU_PER_PX);
  const l = ins("lIns", 91440);
  const r = ins("rIns", 91440);
  const t = ins("tIns", 45720);
  const b = ins("bIns", 45720);
  const anchor = attr(bodyPr, "anchor");
  // Word's font metrics run a little narrower than Chromium's for the same face: a few percent of
  // slack keeps a text box's lines breaking where Word breaks them instead of one word early.
  const slack = Math.max(3, (w - l - r) * 0.02);
  const noWrap = attr(bodyPr, "wrap") === "none";
  const box = xh("div", `${noWrap ? "white-space:nowrap;" : ""}width:${n(Math.max(0, w - l - r) + slack)}px;height:${n(Math.max(0, h - t - b))}px;display:flex;flex-direction:column;justify-content:${anchor === "ctr" ? "center" : anchor === "b" ? "flex-end" : "flex-start"};overflow:visible`);
  blocks.forEach((bl) => box.appendChild(bl));
  return `<foreignObject x="${n(l)}" y="${n(t)}" width="${n(Math.max(1, w - l - r) + slack)}" height="${n(Math.max(1, h - t - b) + 400)}" overflow="visible">${serialize(box)}</foreignObject>`;
}

function serialize(el: HTMLElement): string {
  return new XMLSerializer().serializeToString(el);
}

// One DrawingML object (shape, picture, group) at its box, local coordinates (0,0)-(w,h).
function graphicBody(node: Element, ctx: PartCtx, w: number, h: number): string {
  const kind = localTag(node);
  if (kind === "pic") return picture(node, ctx, w, h);
  if (kind === "wsp") {
    ctx.hasRich.v = true;
    const spPr = directChild(node, "spPr");
    const style = directChild(node, "style");
    const { fill, stroke } = paintAttrs(spPr, style, ctx, { w, h });
    const d = geometryPath(spPr, w, h);
    const shape = fill === 'fill="none"' && stroke === 'stroke="none"' ? "" : `<path d="${d}" ${fill} ${stroke}/>`;
    return shape + textBox(directChild(node, "txbx"), directChild(node, "bodyPr"), ctx, w, h);
  }
  if (kind === "wgp" || kind === "grpSp") {
    const grpSpPr = directChild(node, "grpSpPr") ?? directChild(node, "grpSpPr");
    const xf = readXfrm(directChild(grpSpPr, "xfrm"));
    const chX = xf?.chX ?? 0;
    const chY = xf?.chY ?? 0;
    const sx = xf?.chW ? w / xf.chW : 1;
    const sy = xf?.chH ? h / xf.chH : 1;
    let out = "";
    for (const child of elementChildren(node)) {
      const ck = localTag(child);
      if (ck !== "wsp" && ck !== "pic" && ck !== "grpSp" && ck !== "graphicFrame") continue;
      const cxf = readXfrm(directChild(directChild(child, ck === "grpSp" ? "grpSpPr" : "spPr"), "xfrm")) ?? readXfrm(first(child, "xfrm"));
      if (!cxf) continue;
      const x = (cxf.x - chX) * sx;
      const y = (cxf.y - chY) * sy;
      const cw = cxf.w * sx;
      const chh = cxf.h * sy;
      out += placed(x, y, cw, chh, cxf.rot, cxf.flipH, cxf.flipV, graphicBody(child, ctx, cw, chh));
    }
    return out;
  }
  return "";
}

function placed(x: number, y: number, w: number, h: number, rot: number, flipH: boolean, flipV: boolean, body: string): string {
  if (!body) return "";
  const t: string[] = [`translate(${n(x)} ${n(y)})`];
  if (rot) t.push(`rotate(${n(rot)} ${n(w / 2)} ${n(h / 2)})`);
  if (flipH || flipV) t.push(`translate(${flipH ? n(w) : 0} ${flipV ? n(h) : 0}) scale(${flipH ? -1 : 1} ${flipV ? -1 : 1})`);
  return `<g transform="${t.join(" ")}">${body}</g>`;
}

function handleDrawing(drawing: Element, ctx: PartCtx, floats: Floating[], paragraph: HTMLElement, segment: Segment) {
  const inline = directChild(drawing, "inline");
  const anchor = directChild(drawing, "anchor");
  const holder = inline ?? anchor;
  if (!holder) return;
  const ext = directChild(holder, "extent");
  const w = emu(attr(ext, "cx"));
  const hh = emu(attr(ext, "cy"));
  const data = first(holder, "graphicData");
  const node = data ? elementChildren(data)[0] : null;
  if (!node) return;
  const xf = readXfrm(first(node, "xfrm"));
  const rot = xf?.rot ?? 0;

  if (inline) {
    // In the line: a picture as <img>, anything else as an inline SVG of its own.
    if (localTag(node) === "pic") {
      const id = attr(first(node, "blip"), "r:embed");
      const src = id ? ctx.images.get(id) : undefined;
      if (!src) return;
      ctx.hasRich.v = true;
      const img = xh("img", `width:${n(w)}px;height:${n(hh)}px;vertical-align:bottom${rot ? `;transform:rotate(${n(rot)}deg)` : ""}`);
      img.setAttribute("src", src);
      segment.nodes.push(img);
    } else {
      const body = graphicBody(node, ctx, w, hh);
      if (!body) return;
      const span = xh("span", `display:inline-block;width:${n(w)}px;height:${n(hh)}px;vertical-align:bottom`);
      span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(hh)}" overflow="visible">${body}</svg>`;
      segment.nodes.push(span);
    }
    return;
  }

  ctx.hasRich.v = true;
  const { page } = ctx;
  const posH = directChild(anchor, "positionH");
  const posV = directChild(anchor, "positionV");
  const hFrame = (rel: string | null): [number, number] => {
    switch (rel) {
      case "page":
        return [0, page.w];
      case "leftMargin":
      case "insideMargin":
        return [0, page.mL];
      case "rightMargin":
      case "outsideMargin":
        return [page.w - page.mR, page.mR];
      default:
        return [page.mL, page.w - page.mL - page.mR];
    }
  };
  const vFrame = (rel: string | null): [number, number] | null => {
    switch (rel) {
      case "page":
        return [0, page.h];
      case "margin":
        return [page.mT, page.h - page.mT - page.mB];
      case "topMargin":
      case "insideMargin":
        return [0, page.mT];
      case "bottomMargin":
      case "outsideMargin":
        return [page.h - page.mB, page.mB];
      default:
        return null; // paragraph / line: resolved after layout
    }
  };
  const axis = (pos: Element | null, frame: [number, number] | null, size: number, pctName: string): { v: number; rel: boolean } => {
    const al = directChild(pos, "align")?.textContent?.trim();
    const off = directChild(pos, "posOffset")?.textContent;
    const pct = first(pos, pctName)?.textContent ?? first(anchor, pctName)?.textContent;
    const [f0, fs] = frame ?? [0, 0];
    if (al) {
      const v = al === "center" ? f0 + (fs - size) / 2 : al === "right" || al === "bottom" || al === "outside" ? f0 + fs - size : f0;
      return { v, rel: !frame };
    }
    if (pct && frame) return { v: f0 + (parseInt(pct, 10) / 100000) * fs, rel: false };
    return { v: f0 + emu(off), rel: !frame };
  };
  const hRel = attr(posH, "relativeFrom");
  const vRel = attr(posV, "relativeFrom");
  const x = axis(posH, hFrame(hRel), w, "pctPosHOffset").v;
  const vf = vFrame(vRel);
  const yr = axis(posV, vf, hh, "pctPosVOffset");
  const body = graphicBody(node, ctx, w, hh);
  if (!body) return;
  floats.push({
    z: parseInt(attr(anchor, "relativeHeight") ?? "0", 10) || 0,
    behind: attr(anchor, "behindDoc") === "1",
    x,
    y: yr.v,
    yFromParagraph: yr.rel ? paragraph : null,
    w,
    h: hh,
    rot,
    flipH: !!xf?.flipH,
    flipV: !!xf?.flipV,
    body: () => body,
  });
}

// ------------------------------------------------------------------------------------------------
// VML (legacy shapes, text boxes and pictures)

const unit = (v: string | undefined): number => {
  if (!v) return 0;
  const m = v.trim().match(/^(-?[\d.]+)\s*(pt|in|cm|mm|px|em)?$/);
  if (!m) return 0;
  const x = parseFloat(m[1]);
  switch (m[2]) {
    case "pt":
      return (x * 96) / 72;
    case "in":
      return x * 96;
    case "cm":
      return (x * 96) / 2.54;
    case "mm":
      return (x * 96) / 25.4;
    case "em":
      return x * 16;
    case "px":
      return x;
    default:
      return x / EMU_PER_PX > 2000 ? x / EMU_PER_PX : (x * 96) / 72;
  }
};

const vmlColor = (v: string | null): string | null => {
  if (!v) return null;
  const c = v.split(/\s/)[0];
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  const named = PRESET_COLORS[c];
  return named ? `#${named}` : null;
};

function handleVml(pict: Element, ctx: PartCtx, floats: Floating[], paragraph: HTMLElement) {
  for (const shape of elementChildren(pict)) {
    const kind = localTag(shape);
    if (!["shape", "rect", "roundrect", "oval", "line", "group"].includes(kind)) continue;
    const style = Object.fromEntries((attr(shape, "style") ?? "").split(";").map((kv) => kv.split(":").map((s) => s.trim())).filter((kv) => kv.length === 2)) as Record<string, string>;
    const w = unit(style.width);
    const hh = unit(style.height);
    if (!w || !hh) continue;
    ctx.hasRich.v = true;
    const { page } = ctx;
    const hRel = style["mso-position-horizontal-relative"];
    const vRel = style["mso-position-vertical-relative"];
    const hAlign = style["mso-position-horizontal"];
    const x0 = hRel === "page" ? 0 : hRel === "left-margin-area" ? 0 : page.mL;
    const fw = hRel === "page" ? page.w : page.w - page.mL - page.mR;
    let x = x0 + unit(style["margin-left"] ?? style.left);
    if (hAlign === "center") x = x0 + (fw - w) / 2;
    else if (hAlign === "right") x = x0 + fw - w;
    const vAbs = vRel === "page" || vRel === "margin" || vRel === "top-margin-area";
    const y = (vRel === "page" ? 0 : vRel === "margin" ? page.mT : 0) + unit(style["margin-top"] ?? style.top);
    const fill = attr(shape, "filled") === "f" ? "none" : vmlColor(attr(shape, "fillcolor") ?? attr(directChild(shape, "fill"), "color")) ?? (kind === "shape" ? "none" : "#ffffff");
    const strokeColor = attr(shape, "stroked") === "f" ? null : vmlColor(attr(shape, "strokecolor")) ?? (kind === "shape" && !attr(shape, "strokecolor") ? null : "#000000");
    const sw = unit(attr(shape, "strokeweight") ?? "0.75pt") || 1;
    let body = "";
    const img = directChild(shape, "imagedata");
    const imgId = attr(img, "r:id");
    if (imgId && ctx.images.get(imgId)) body += `<image href="${ctx.images.get(imgId)}" width="${n(w)}" height="${n(hh)}" preserveAspectRatio="none"/>`;
    else if (fill !== "none" || strokeColor) {
      const geom = kind === "oval" ? `<ellipse cx="${n(w / 2)}" cy="${n(hh / 2)}" rx="${n(w / 2)}" ry="${n(hh / 2)}"` : kind === "line" ? `<line x1="0" y1="0" x2="${n(w)}" y2="${n(hh)}"` : `<rect width="${n(w)}" height="${n(hh)}"${kind === "roundrect" ? ` rx="${n(Math.min(w, hh) * 0.1)}"` : ""}`;
      body += `${geom} fill="${fill}" stroke="${strokeColor ?? "none"}" stroke-width="${n(sw)}"/>`;
    }
    const tb = directChild(shape, "textbox");
    if (tb) body += textBox(tb, null, ctx, w, hh);
    if (!body) continue;
    floats.push({
      z: parseInt(style["z-index"] ?? "0", 10) || 0,
      behind: parseInt(style["z-index"] ?? "0", 10) < 0,
      x,
      y,
      yFromParagraph: vAbs ? null : paragraph,
      w,
      h: hh,
      rot: parseFloat(style.rotation ?? "0") || 0,
      flipH: /x/.test(style.flip ?? ""),
      flipV: /y/.test(style.flip ?? ""),
      body: () => body,
    });
  }
}

// ------------------------------------------------------------------------------------------------
// Bands

interface BandParts {
  header: Element | null;
  footer: Element | null;
  headerImages: Map<string, string>;
  footerImages: Map<string, string>;
}

// Lays out both bands of one page variant in a hidden live container (for measurements), then
// emits the sheet as SVG.
function renderSheet(parts: BandParts, style: DocxStyleContext, page: PartCtx["page"], dist: { header: number; footer: number }): LetterheadBands {
  const defs: string[] = [];
  const idSeq = { n: 0 };
  const hasRich = { v: false };
  const floats: Floating[] = [];
  const contentW = page.w - page.mL - page.mR;

  const host = document.createElement("div");
  host.setAttribute("style", `position:fixed;left:-100000px;top:0;width:${page.w}px;height:${page.h}px;visibility:hidden;pointer-events:none;contain:layout`);
  const baseCss = `margin:0;padding:0;color:#000;${runCss(style.docDefaultRPr, null)};line-height:1.17;word-wrap:break-word`;
  const bands: { el: HTMLElement; kind: "header" | "footer" }[] = [];
  for (const kind of ["header", "footer"] as const) {
    const root = parts[kind];
    if (!root) continue;
    const ctx: PartCtx = { style, theme: style.theme, images: kind === "header" ? parts.headerImages : parts.footerImages, page, defs, idSeq, hasRich };
    const el = xh("div", `${baseCss};position:absolute;left:${page.mL}px;width:${contentW}px;${kind === "header" ? `top:${dist.header}px` : `bottom:${dist.footer}px`}`);
    renderBlocks(root, ctx, floats).forEach((b) => el.appendChild(b));
    host.appendChild(el);
    bands.push({ el, kind });
  }
  document.body.appendChild(host);
  const flows: string[] = [];
  let topPx = 0;
  let bottomPx = 0;
  let textContent = false;
  try {
    const hostTop = host.getBoundingClientRect().top;
    for (const { el, kind } of bands) {
      const r = el.getBoundingClientRect();
      const y = r.top - hostTop;
      const height = r.height;
      if ((el.textContent ?? "").replace(/​/g, "").trim()) textContent = true;
      if (kind === "header") topPx = dist.header + height;
      else bottomPx = dist.footer + height;
      flows.push(`<foreignObject x="${n(page.mL)}" y="${n(y)}" width="${n(contentW)}" height="${n(height + 2)}" overflow="visible">${serialize(el.cloneNode(true) as HTMLElement).replace(/position:absolute;left:[^;]+;width:[^;]+;(top|bottom):[^;"]+;?/, "")}</foreignObject>`);
    }
    for (const f of floats) {
      if (f.yFromParagraph) f.y += f.yFromParagraph.getBoundingClientRect().top - hostTop;
    }
  } finally {
    host.remove();
  }

  const svgFloat = (f: Floating) => placed(f.x, f.y, f.w, f.h, f.rot, f.flipH, f.flipV, f.body(f.x, f.y));
  const behind = floats.filter((f) => f.behind).sort((a, b) => a.z - b.z);
  const front = floats.filter((f) => !f.behind).sort((a, b) => a.z - b.z);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(page.w)}" height="${n(page.h)}" viewBox="0 0 ${n(page.w)} ${n(page.h)}">` +
    (defs.length ? `<defs>${defs.join("")}</defs>` : "") +
    behind.map(svgFloat).join("") +
    flows.join("") +
    front.map(svgFloat).join("") +
    `</svg>`;
  return {
    svg,
    topIn: Math.max(page.mT, topPx) / 96,
    bottomIn: Math.max(page.mB, bottomPx) / 96,
    hasContent: floats.length > 0 || textContent || hasRich.v,
  };
}

async function loadPart(zip: JSZip, path: string | null, parser: DocxStyleContext["parser"]): Promise<{ root: Element | null; images: Map<string, string> }> {
  if (!path) return { root: null, images: new Map() };
  const xml = await zip.file(path)?.async("string");
  if (!xml) return { root: null, images: new Map() };
  const doc = parser.parseFromString(xml, "text/xml") as unknown as Document;
  return { root: doc.documentElement, images: await partImages(zip, path) };
}

// The letterhead of a .docx: its last section's header and footer (looking back through earlier
// sections for any it inherits), first-page variant included. null when there are no bands.
export async function renderDocxLetterhead(zip: JSZip): Promise<DocxLetterhead | null> {
  const docXml = await zip.file("word/document.xml")?.async("string");
  const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string");
  if (!docXml || !relsXml) return null;
  const style = await loadStyleContext(zip);
  const doc = style.parser.parseFromString(docXml, "text/xml") as unknown as Document;
  const sectPrs = Array.from(doc.getElementsByTagName("w:sectPr"));
  const sectPr = sectPrs[sectPrs.length - 1];
  if (!sectPr) return null;
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels.set(id, `word/${target.replace(/^\/?word\//, "").replace(/^\//, "")}`);
  }
  const partFor = (band: "header" | "footer", type: "default" | "first"): string | null => {
    for (let i = sectPrs.length - 1; i >= 0; i--) {
      const refs = Array.from(sectPrs[i].getElementsByTagName(band === "header" ? "w:headerReference" : "w:footerReference"));
      const ref = refs.find((r) => (attr(r, "w:type") ?? "default") === type);
      const id = ref ? attr(ref, "r:id") : null;
      if (id && rels.get(id)) return rels.get(id)!;
    }
    return null;
  };

  const pgSz = directChild(sectPr, "pgSz");
  const pgMar = directChild(sectPr, "pgMar");
  const tw = (el: Element | null, name: string, def: number) => {
    const v = parseInt(attr(el, name) ?? "", 10);
    return Number.isFinite(v) ? v : def;
  };
  const page = {
    w: tw(pgSz, "w:w", 12240) * PX_PER_TWIP,
    h: tw(pgSz, "w:h", 15840) * PX_PER_TWIP,
    mL: tw(pgMar, "w:left", 1440) * PX_PER_TWIP,
    mR: tw(pgMar, "w:right", 1440) * PX_PER_TWIP,
    mT: Math.abs(tw(pgMar, "w:top", 1440)) * PX_PER_TWIP,
    mB: Math.abs(tw(pgMar, "w:bottom", 1440)) * PX_PER_TWIP,
  };
  const dist = { header: tw(pgMar, "w:header", 720) * PX_PER_TWIP, footer: tw(pgMar, "w:footer", 720) * PX_PER_TWIP };
  const titlePg = Array.from(sectPr.getElementsByTagName("w:titlePg")).some((t) => attr(t, "w:val") !== "0" && attr(t, "w:val") !== "false");

  const variant = async (type: "default" | "first"): Promise<LetterheadBands> => {
    const hp = await loadPart(zip, partFor("header", type), style.parser);
    const fp = await loadPart(zip, partFor("footer", type), style.parser);
    return renderSheet({ header: hp.root, footer: fp.root, headerImages: hp.images, footerImages: fp.images }, style, page, dist);
  };
  const rest = await variant("default");
  const firstBands = titlePg ? await variant("first") : rest;
  if (!rest.hasContent && !firstBands.hasContent) return null;
  // Rich: anything beyond plain text lines - decided on the raw parts, so a text-only header stays
  // an editable text header.
  const richRe = /<w:drawing|<w:pict|<w:tbl\b|<mc:AlternateContent/;
  const partXml = async (p: string | null) => (p ? ((await zip.file(p)?.async("string")) ?? "") : "");
  const all = [partFor("header", "default"), partFor("footer", "default"), titlePg ? partFor("header", "first") : null, titlePg ? partFor("footer", "first") : null];
  let rich = false;
  for (const p of all) if (richRe.test(await partXml(p))) rich = true;
  return {
    widthPx: page.w,
    heightPx: page.h,
    first: firstBands,
    rest,
    differentFirst: titlePg,
    margins: { top: page.mT / 96, right: page.mR / 96, bottom: page.mB / 96, left: page.mL / 96 },
    rich,
  };
}
