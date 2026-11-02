// utils/docxStyleResolver.ts
//
// Resolves paragraph, character-run, table, image-dimension, and page-setup formatting from a
// .docx archive's XML parts (`word/document.xml`, `word/styles.xml`, `word/theme/theme1.xml`,
// `word/numbering.xml`).
//
// Why this exists: mammoth is deliberately a semantic-only converter — it maps style names to HTML
// tags (Heading 1 -> <h1>) and inline B/I/U runs to <strong>/<em>/<u>, and drops everything else:
// font family, font size, text color, line spacing, paragraph space before/after, indents, custom
// bullets, heading un-bold overrides (<w:b w:val="0"/>), image extents (<wp:extent>), table borders
// & shading, and page margins/size. Without resolving the OOXML style hierarchy (run -> character
// style -> paragraph direct rPr -> paragraph style -> basedOn chain -> docDefaults + theme1.xml),
// imported documents lose their typography and pagination.
//
// Crucially, mammoth also drops empty <w:p> elements (`ignoreEmptyParagraphs: true`). This resolver
// mirrors mammoth's exact paragraph-filtering rules so resolved ParagraphStyle entries never shift
// out of alignment with mammoth's emitted DOM blocks, and folds the vertical height of skipped
// empty <w:p> spacer paragraphs into the next emitted block's `spaceBeforePt`.
import JSZip from "jszip";
import { DOMParser as XmlDOMParser } from "@xmldom/xmldom";
import type { DocMargins, DocOrientation, DocPageSize } from "./docTypes";
import type { DocPageChrome } from "./docPageChrome";
import { resolveDocxPageChrome } from "./docxHeaderFooter";

export interface RunStyle {
  text: string;
  fontFamily: string | null;
  fontSize: string | null; // e.g. "11pt"
  fontSizePt: number | null;
  color: string | null; // "#rrggbb"
  bold: boolean | null;
  italic: boolean | null;
  underline: boolean | null;
  fontWeight: "normal" | null;
  fontStyle: "normal" | null;
  tabAlign: "right" | null;
  letterSpacingPt: number | null; // w:spacing (character spacing): expanded > 0, condensed < 0
  caps: boolean | null;
  smallCaps: boolean | null;
  highlight: string | null; // "#rrggbb" from w:highlight or run shading
}

export interface ParagraphStyle {
  fontFamily: string | null;
  fontSize: string | null; // e.g. "12pt"
  fontSizePt: number | null;
  color: string | null; // "#rrggbb"
  bold: boolean | null;
  italic: boolean | null;
  underline: boolean | null;
  lineSpacing: number | null; // unitless multiplier: 1.0, 1.15, 1.5, 2.0
  spaceBeforePt: number | null;
  spaceAfterPt: number | null;
  textAlign: "left" | "center" | "right" | "justify" | null;
  indentLeftIn: number | null;
  indentRightIn: number | null;
  indentFirstIn: number | null;
  borderBottom: string | null;
  borderTop: string | null;
  borderLeft: string | null;
  borderRight: string | null;
  shading: string | null; // "#rrggbb" paragraph background
  pageBreakBefore: boolean; // a page break (w:br type=page / pageBreakBefore / next-page section) precedes this block
  bulletMarker: string | null;
  listIndentLeftIn: number | null;
  isListItem: boolean;
  runs: RunStyle[];
  textPreview: string;
}

export interface DocxTableCellMeta {
  background: string | null;
  colwidth: number | null;
  verticalAlign: "top" | "middle" | "bottom" | null;
  // Each edge as CSS ("0.5pt solid #000000" / "none"), resolved from the cell's own borders, then
  // the table's (outer edges vs inside lines), then the table style's. null = the editor's grid.
  borders: CellBorders | null;
}

export interface CellBorders {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

export interface DocxTableMeta {
  isSingleColumnLayoutWrapper: boolean;
  rules: "none" | "booktabs" | null;
  colWidthsPx: number[];
  cells: DocxTableCellMeta[][];
}

export interface DocxPageSetup {
  pageSize: DocPageSize;
  orientation: DocOrientation;
  margins: DocMargins;
  columns: 1 | 2;
  columnGapIn: number;
  pageColor: string | null;
}

export interface DocxDocumentMetadata {
  paragraphs: ParagraphStyle[];
  pageSetup: DocxPageSetup | null;
  imageSizes: Array<{ width: number; height: number } | null>;
  tables: DocxTableMeta[];
  images: DocxImageMeta[];
  // Running header/footer and page numbers (docxHeaderFooter.ts), null when there are none.
  pageChrome: DocPageChrome | null;
}

// A picture's size and placement (wp:inline or wp:anchor), in document order.
export interface DocxImageMeta {
  width: number;
  height: number;
  layout: "inline" | "block" | "wrapLeft" | "wrapRight" | "front" | "behind";
  align: "left" | "center" | "right";
  x: number; // px from the anchor paragraph's left (front/behind)
  y: number; // px from the anchor paragraph's top
  rotation: number; // degrees, clockwise
  // Placed relative to the page itself (Word's "relative to Page/Margin" vertically): the exact
  // spot on its page, px from the sheet's top-left. The editor settles x/y from it once the pages
  // are laid out (DocImageView.tsx), since only then is the anchor paragraph's page known.
  pageX: number | null;
  pageY: number | null;
  alt: string | null;
}

export interface RawRPr {
  rStyle?: string;
  fontFamily?: string;
  fontTheme?: string;
  fontSizePt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  spacingTwips?: number;
  caps?: boolean;
  smallCaps?: boolean;
  highlight?: string;
}

export interface RawPPr {
  pStyle?: string;
  spaceBeforePt?: number | null;
  spaceAfterPt?: number | null;
  lineTwips?: number;
  lineRule?: string;
  textAlign?: "left" | "center" | "right" | "justify";
  indentLeftIn?: number;
  indentRightIn?: number;
  indentFirstIn?: number;
  borderBottom?: string;
  borderTop?: string;
  borderLeft?: string;
  borderRight?: string;
  shading?: string;
  pageBreakBefore?: boolean;
  hasRightTab?: boolean;
  tabs?: TabStop[];
  numId?: string;
  ilvl?: string;
  rPr?: RawRPr;
}

// A tab stop: position in twips from the text's left edge, alignment ("clear" removes an
// inherited stop at that position).
export interface TabStop {
  pos: number;
  val: string;
}

export interface RawStyleDef {
  styleId: string;
  type: string;
  name: string;
  basedOn?: string;
  isDefault: boolean;
  pPr: RawPPr;
  rPr: RawRPr;
}

export interface ThemeData {
  colors: Record<string, string>;
  majorFont: string | null;
  minorFont: string | null;
}

export interface NumLevelDef {
  numFmt: string;
  lvlText: string;
  leftTwips: number | null;
  hangingTwips: number | null;
  rPr: RawRPr;
}

const HEX6 = /^[0-9a-fA-F]{6}$/;
export const EMU_PER_PX = 9525; // 914400 EMU/inch / 96 CSS px/inch
export const TWIPS_PER_IN = 1440;
const TWIPS_PER_PT = 20;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function localTag(el: Element): string {
  return el.localName || el.tagName.replace(/^.*:/, "");
}

export function elementChildren(parent: Element | null | undefined): Element[] {
  if (!parent || !parent.childNodes) return [];
  const out: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const c = parent.childNodes[i];
    if (c.nodeType === 1) out.push(c as Element);
  }
  return out;
}

export function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  if (el.hasAttribute(name)) return el.getAttribute(name);
  const bare = name.replace(/^.*:/, "");
  if (bare !== name && el.hasAttribute(bare)) return el.getAttribute(bare);
  return null;
}

export function directChild(parent: Element | null | undefined, localName: string): Element | null {
  if (!parent || !parent.childNodes) return null;
  const prefixed = `w:${localName}`;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const c = parent.childNodes[i];
    if (c.nodeType !== 1) continue;
    const el = c as Element;
    if (el.tagName === prefixed || localTag(el) === localName) return el;
  }
  return null;
}

export function directChildren(parent: Element | null | undefined, localName: string): Element[] {
  if (!parent || !parent.childNodes) return [];
  const prefixed = `w:${localName}`;
  const out: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const c = parent.childNodes[i];
    if (c.nodeType !== 1) continue;
    const el = c as Element;
    if (el.tagName === prefixed || localTag(el) === localName) out.push(el);
  }
  return out;
}

function readBoolElement(el: Element | null): boolean | undefined {
  if (!el) return undefined;
  const val = attr(el, "w:val");
  if (val === null || val === "") return true;
  const v = val.toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "none";
}

function applyTintShade(hex: string, tintHex: string | null, shadeHex: string | null): string {
  const clean = hex.replace(/^#/, "");
  if (!HEX6.test(clean)) return `#${clean.toLowerCase()}`;
  let r = parseInt(clean.slice(0, 2), 16);
  let g = parseInt(clean.slice(2, 4), 16);
  let b = parseInt(clean.slice(4, 6), 16);
  if (tintHex && /^[0-9a-fA-F]{1,2}$/.test(tintHex)) {
    const t = parseInt(tintHex, 16) / 255;
    r = Math.round(r * t + 255 * (1 - t));
    g = Math.round(g * t + 255 * (1 - t));
    b = Math.round(b * t + 255 * (1 - t));
  } else if (shadeHex && /^[0-9a-fA-F]{1,2}$/.test(shadeHex)) {
    const s = parseInt(shadeHex, 16) / 255;
    r = Math.round(r * s);
    g = Math.round(g * s);
    b = Math.round(b * s);
  }
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function parseThemeXml(xmlText: string | null, parser: XmlDOMParser): ThemeData {
  const theme: ThemeData = { colors: {}, majorFont: null, minorFont: null };
  if (!xmlText) return theme;
  const doc = parser.parseFromString(xmlText, "text/xml");

  const clrScheme = doc.getElementsByTagName("a:clrScheme")[0] ?? doc.getElementsByTagName("clrScheme")[0];
  if (clrScheme) {
    for (const slot of elementChildren(clrScheme)) {
      const name = localTag(slot);
      const srgb = slot.getElementsByTagName("a:srgbClr")[0] ?? slot.getElementsByTagName("srgbClr")[0];
      const sys = slot.getElementsByTagName("a:sysClr")[0] ?? slot.getElementsByTagName("sysClr")[0];
      const raw = attr(srgb, "val") ?? attr(sys, "lastClr") ?? attr(sys, "val");
      if (raw && HEX6.test(raw)) {
        theme.colors[name] = `#${raw.toLowerCase()}`;
      }
    }
    const aliases: Record<string, string> = {
      dark1: "dk1",
      light1: "lt1",
      dark2: "dk2",
      light2: "lt2",
      text1: "dk1",
      background1: "lt1",
      text2: "dk2",
      background2: "lt2",
      hyperlink: "hlink",
      followedHyperlink: "folHlink",
    };
    for (const [alias, target] of Object.entries(aliases)) {
      if (theme.colors[target] && !theme.colors[alias]) {
        theme.colors[alias] = theme.colors[target];
      }
    }
  }

  const majorFontEl = doc.getElementsByTagName("a:majorFont")[0] ?? doc.getElementsByTagName("majorFont")[0];
  const minorFontEl = doc.getElementsByTagName("a:minorFont")[0] ?? doc.getElementsByTagName("minorFont")[0];
  const majorLatin = majorFontEl?.getElementsByTagName("a:latin")[0] ?? majorFontEl?.getElementsByTagName("latin")[0];
  const minorLatin = minorFontEl?.getElementsByTagName("a:latin")[0] ?? minorFontEl?.getElementsByTagName("latin")[0];
  if (attr(majorLatin, "typeface")) theme.majorFont = attr(majorLatin, "typeface");
  if (attr(minorLatin, "typeface")) theme.minorFont = attr(minorLatin, "typeface");

  return theme;
}

export function resolveColorAttr(el: Element | null, theme: ThemeData, attrName = "w:val"): string | undefined {
  if (!el) return undefined;
  const val = attr(el, attrName);
  if (val && HEX6.test(val)) return `#${val.toLowerCase()}`;
  const themeColor = attr(el, "w:themeColor");
  if (themeColor && theme.colors[themeColor]) {
    const tint = attr(el, "w:themeTint");
    const shade = attr(el, "w:themeShade");
    return applyTintShade(theme.colors[themeColor], tint, shade);
  }
  return undefined;
}

function resolveThemeFont(themeAttr: string | null | undefined, theme: ThemeData): string | undefined {
  if (!themeAttr) return undefined;
  if (themeAttr.startsWith("major") && theme.majorFont) return theme.majorFont;
  if (themeAttr.startsWith("minor") && theme.minorFont) return theme.minorFont;
  return undefined;
}

export function extractRPr(rPr: Element | null, theme: ThemeData): RawRPr {
  if (!rPr) return {};
  const out: RawRPr = {};

  const rStyle = attr(directChild(rPr, "rStyle"), "w:val");
  if (rStyle) out.rStyle = rStyle;

  const rFonts = directChild(rPr, "rFonts");
  if (rFonts) {
    const font =
      attr(rFonts, "w:ascii") ||
      attr(rFonts, "w:hAnsi") ||
      attr(rFonts, "w:cs") ||
      resolveThemeFont(attr(rFonts, "w:asciiTheme") || attr(rFonts, "w:hAnsiTheme"), theme);
    if (font) out.fontFamily = font;
  }

  // w:sz is in half-points (24 = 12pt). Prefer w:sz over w:szCs.
  const sz = attr(directChild(rPr, "sz"), "w:val") ?? attr(directChild(rPr, "szCs"), "w:val");
  if (sz) {
    const halfPts = parseInt(sz, 10);
    if (Number.isFinite(halfPts) && halfPts > 0) out.fontSizePt = halfPts / 2;
  }

  const color = resolveColorAttr(directChild(rPr, "color"), theme);
  if (color) out.color = color;

  const bEl = directChild(rPr, "b");
  const bVal = readBoolElement(bEl);
  if (bVal !== undefined) out.bold = bVal;

  const iEl = directChild(rPr, "i");
  const iVal = readBoolElement(iEl);
  if (iVal !== undefined) out.italic = iVal;

  const uEl = directChild(rPr, "u");
  if (uEl) {
    const uVal = attr(uEl, "w:val");
    out.underline = uVal === null || (uVal !== "none" && uVal !== "0" && uVal !== "false");
  }

  const spacing = attr(directChild(rPr, "spacing"), "w:val");
  if (spacing !== null) {
    const twips = parseInt(spacing, 10);
    if (Number.isFinite(twips)) out.spacingTwips = twips;
  }
  const caps = readBoolElement(directChild(rPr, "caps"));
  if (caps !== undefined) out.caps = caps;
  const smallCaps = readBoolElement(directChild(rPr, "smallCaps"));
  if (smallCaps !== undefined) out.smallCaps = smallCaps;

  // Highlighter pen (a named colour), else run shading (Google Docs' text background colour).
  const hl = attr(directChild(rPr, "highlight"), "w:val");
  if (hl && hl !== "none" && HIGHLIGHT_COLORS[hl]) out.highlight = HIGHLIGHT_COLORS[hl];
  else {
    const fill = resolveColorAttr(directChild(rPr, "shd"), theme, "w:fill");
    if (fill && fill !== "#ffffff") out.highlight = fill;
  }

  return out;
}

// w:highlight's named colours (ST_HighlightColor).
const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  blue: "#0000ff",
  red: "#ff0000",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#c0c0c0",
  black: "#000000",
  white: "#ffffff",
};

// A border element (w:top/w:left/... in pBdr, tcBorders, tblBorders) as CSS; "none" when it's
// explicitly off; undefined when absent.
export function borderCss(el: Element | null, theme: ThemeData): string | undefined {
  if (!el) return undefined;
  const val = attr(el, "w:val");
  const sz = parseInt(attr(el, "w:sz") ?? "4", 10);
  if (!val || val === "none" || val === "nil" || !(sz > 0)) return "none";
  // w:sz is in eighths of a point.
  const pt = round2(Math.max(0.5, Math.min(6, sz / 8)));
  const color = resolveColorAttr(el, theme, "w:color") ?? "#000000";
  const style = val === "dotted" ? "dotted" : val === "dashed" || val.startsWith("dash") ? "dashed" : val === "double" ? "double" : "solid";
  return `${style === "double" ? Math.max(pt, 2.25) : pt}pt ${style} ${color}`;
}

export function mergeRPr(base: RawRPr, over: RawRPr | undefined): RawRPr {
  if (!over) return { ...base };
  return {
    rStyle: over.rStyle ?? base.rStyle,
    fontFamily: over.fontFamily ?? base.fontFamily,
    fontSizePt: over.fontSizePt ?? base.fontSizePt,
    color: over.color ?? base.color,
    bold: over.bold !== undefined ? over.bold : base.bold,
    italic: over.italic !== undefined ? over.italic : base.italic,
    underline: over.underline !== undefined ? over.underline : base.underline,
    spacingTwips: over.spacingTwips ?? base.spacingTwips,
    caps: over.caps !== undefined ? over.caps : base.caps,
    smallCaps: over.smallCaps !== undefined ? over.smallCaps : base.smallCaps,
    highlight: over.highlight ?? base.highlight,
  };
}

export function extractPPr(pPr: Element | null, theme: ThemeData): RawPPr {
  if (!pPr) return {};
  const out: RawPPr = {};

  const pStyle = attr(directChild(pPr, "pStyle"), "w:val");
  if (pStyle) out.pStyle = pStyle;

  const spacing = directChild(pPr, "spacing");
  if (spacing) {
    const beforeAuto = attr(spacing, "w:beforeAutospacing");
    const before = attr(spacing, "w:before");
    if (beforeAuto === "1" || beforeAuto === "true") {
      out.spaceBeforePt = null;
    } else if (before !== null) {
      const twips = parseInt(before, 10);
      if (Number.isFinite(twips) && twips >= 0) out.spaceBeforePt = round2(twips / TWIPS_PER_PT);
    }

    const afterAuto = attr(spacing, "w:afterAutospacing");
    const after = attr(spacing, "w:after");
    if (afterAuto === "1" || afterAuto === "true") {
      out.spaceAfterPt = null;
    } else if (after !== null) {
      const twips = parseInt(after, 10);
      if (Number.isFinite(twips) && twips >= 0) out.spaceAfterPt = round2(twips / TWIPS_PER_PT);
    }

    const line = attr(spacing, "w:line");
    if (line !== null) {
      const n = parseInt(line, 10);
      if (Number.isFinite(n) && n > 0) {
        out.lineTwips = n;
        out.lineRule = attr(spacing, "w:lineRule") ?? "auto";
      }
    }
  }

  const jc = attr(directChild(pPr, "jc"), "w:val");
  if (jc) {
    if (jc === "center") out.textAlign = "center";
    else if (jc === "right" || jc === "end") out.textAlign = "right";
    else if (jc === "both" || jc === "distribute") out.textAlign = "justify";
    else if (jc === "left" || jc === "start") out.textAlign = "left";
  }

  const ind = directChild(pPr, "ind");
  if (ind) {
    const left = attr(ind, "w:left") ?? attr(ind, "w:start");
    if (left !== null) {
      const twips = parseInt(left, 10);
      if (Number.isFinite(twips)) out.indentLeftIn = round2(twips / TWIPS_PER_IN);
    }
    const right = attr(ind, "w:right") ?? attr(ind, "w:end");
    if (right !== null) {
      const twips = parseInt(right, 10);
      if (Number.isFinite(twips)) out.indentRightIn = round2(twips / TWIPS_PER_IN);
    }
    const hanging = attr(ind, "w:hanging");
    const firstLine = attr(ind, "w:firstLine");
    if (hanging !== null) {
      const twips = parseInt(hanging, 10);
      if (Number.isFinite(twips)) out.indentFirstIn = round2(-twips / TWIPS_PER_IN);
    } else if (firstLine !== null) {
      const twips = parseInt(firstLine, 10);
      if (Number.isFinite(twips)) out.indentFirstIn = round2(twips / TWIPS_PER_IN);
    }
  }

  const pBdr = directChild(pPr, "pBdr");
  if (pBdr) {
    // "" = explicitly no border (overriding a style's), so the merged result can switch one off.
    const side = (name: string): string | undefined => {
      const css = borderCss(directChild(pBdr, name), theme);
      return css === undefined ? undefined : css === "none" ? "" : css;
    };
    const bottom = side("bottom");
    if (bottom !== undefined) out.borderBottom = bottom;
    const top = side("top");
    if (top !== undefined) out.borderTop = top;
    const left = side("left") ?? side("start");
    if (left !== undefined) out.borderLeft = left;
    const right = side("right") ?? side("end");
    if (right !== undefined) out.borderRight = right;
  }

  const shd = directChild(pPr, "shd");
  if (shd) {
    const fill = resolveColorAttr(shd, theme, "w:fill");
    out.shading = fill && fill !== "#ffffff" ? fill : "";
  }

  const pbb = readBoolElement(directChild(pPr, "pageBreakBefore"));
  if (pbb !== undefined) out.pageBreakBefore = pbb;

  const tabs = directChild(pPr, "tabs");
  if (tabs) {
    const tabEls = directChildren(tabs, "tab");
    if (tabEls.some((t) => attr(t, "w:val") === "right")) {
      out.hasRightTab = true;
    }
    out.tabs = tabEls
      .map((t) => ({ pos: parseInt(attr(t, "w:pos") ?? "", 10), val: attr(t, "w:val") ?? "left" }))
      .filter((t) => Number.isFinite(t.pos));
  }

  const numPr = directChild(pPr, "numPr");
  if (numPr) {
    const numId = attr(directChild(numPr, "numId"), "w:val");
    const ilvl = attr(directChild(numPr, "ilvl"), "w:val") ?? "0";
    if (numId) {
      out.numId = numId;
      out.ilvl = ilvl;
    }
  }

  const rPr = directChild(pPr, "rPr");
  if (rPr) out.rPr = extractRPr(rPr, theme);

  return out;
}

export function mergePPr(base: RawPPr, over: RawPPr | undefined): RawPPr {
  if (!over) return { ...base, rPr: base.rPr ? { ...base.rPr } : undefined };
  return {
    pStyle: over.pStyle ?? base.pStyle,
    spaceBeforePt: over.spaceBeforePt !== undefined ? over.spaceBeforePt : base.spaceBeforePt,
    spaceAfterPt: over.spaceAfterPt !== undefined ? over.spaceAfterPt : base.spaceAfterPt,
    lineTwips: over.lineTwips ?? base.lineTwips,
    lineRule: over.lineRule ?? base.lineRule,
    textAlign: over.textAlign ?? base.textAlign,
    indentLeftIn: over.indentLeftIn ?? base.indentLeftIn,
    indentRightIn: over.indentRightIn ?? base.indentRightIn,
    indentFirstIn: over.indentFirstIn ?? base.indentFirstIn,
    borderBottom: over.borderBottom !== undefined ? over.borderBottom : base.borderBottom,
    borderTop: over.borderTop !== undefined ? over.borderTop : base.borderTop,
    borderLeft: over.borderLeft !== undefined ? over.borderLeft : base.borderLeft,
    borderRight: over.borderRight !== undefined ? over.borderRight : base.borderRight,
    shading: over.shading !== undefined ? over.shading : base.shading,
    pageBreakBefore: over.pageBreakBefore ?? base.pageBreakBefore,
    hasRightTab: over.hasRightTab ?? base.hasRightTab,
    // Tab stops accumulate down the style chain; "clear" removes an inherited one.
    tabs: over.tabs
      ? [...(base.tabs ?? []).filter((b) => !over.tabs!.some((o) => o.pos === b.pos)), ...over.tabs.filter((o) => o.val !== "clear")].sort((a, b) => a.pos - b.pos)
      : base.tabs,
    numId: over.numId ?? base.numId,
    ilvl: over.ilvl ?? base.ilvl,
    rPr: mergeRPr(base.rPr ?? {}, over.rPr),
  };
}

function parseNumberingXml(xmlText: string | null, parser: XmlDOMParser, theme: ThemeData): (numId: string, ilvl: string) => NumLevelDef | null {
  if (!xmlText) return () => null;
  const doc = parser.parseFromString(xmlText, "text/xml");
  const abstractNums = new Map<string, Map<string, NumLevelDef>>();

  const abstractEls = doc.getElementsByTagName("w:abstractNum");
  for (let i = 0; i < abstractEls.length; i++) {
    const absEl = abstractEls[i];
    const absId = attr(absEl, "w:abstractNumId");
    if (!absId) continue;
    const levels = new Map<string, NumLevelDef>();
    const lvlEls = directChildren(absEl, "lvl");
    for (const lvlEl of lvlEls) {
      const ilvl = attr(lvlEl, "w:ilvl") ?? "0";
      const numFmt = attr(directChild(lvlEl, "numFmt"), "w:val") ?? "bullet";
      const lvlText = attr(directChild(lvlEl, "lvlText"), "w:val") ?? "";
      const pPr = directChild(lvlEl, "pPr");
      const ind = directChild(pPr, "ind");
      const leftRaw = attr(ind, "w:left") ?? attr(ind, "w:start");
      const hangRaw = attr(ind, "w:hanging");
      const leftTwips = leftRaw ? parseInt(leftRaw, 10) : null;
      const hangingTwips = hangRaw ? parseInt(hangRaw, 10) : null;
      const rPr = extractRPr(directChild(lvlEl, "rPr"), theme);
      levels.set(ilvl, { numFmt, lvlText, leftTwips, hangingTwips, rPr });
    }
    abstractNums.set(absId, levels);
  }

  const numToAbstract = new Map<string, string>();
  const numEls = doc.getElementsByTagName("w:num");
  for (let i = 0; i < numEls.length; i++) {
    const numEl = numEls[i];
    const numId = attr(numEl, "w:numId");
    const absId = attr(directChild(numEl, "abstractNumId"), "w:val");
    if (numId && absId) numToAbstract.set(numId, absId);
  }

  return (numId: string, ilvl: string): NumLevelDef | null => {
    if (!numId || numId === "0") return null;
    const absId = numToAbstract.get(numId);
    if (!absId) return null;
    return abstractNums.get(absId)?.get(ilvl || "0") ?? null;
  };
}

function mapBulletMarker(lvl: NumLevelDef | null): string | null {
  if (!lvl || lvl.numFmt === "decimal" || lvl.numFmt === "lowerLetter" || lvl.numFmt === "upperLetter" || lvl.numFmt === "lowerRoman" || lvl.numFmt === "upperRoman") {
    return null;
  }
  if (lvl.numFmt === "none") return "none";
  const t = lvl.lvlText.trim();
  if (t === "-") return "-";
  if (t === "\u2013" || t === "\u2014") return "–";
  if (t === "o" || t === "\u25e6" || t === "\u25cb") return "◦";
  if (t === "\uf0a7" || t === "\u25aa" || t === "\u25a0") return "▪";
  return null;
}

function isHeadingStyle(styleId: string | undefined, styleName: string | undefined): boolean {
  if (styleId && (/^Heading[1-6]$/i.test(styleId) || /^Title$/i.test(styleId) || /^Subtitle$/i.test(styleId))) return true;
  if (styleName && (/^heading\s*[1-6]$/i.test(styleName) || /^title$/i.test(styleName) || /^subtitle$/i.test(styleName))) return true;
  return false;
}

function parsePageSetup(docXml: Document, theme: ThemeData): DocxPageSetup | null {
  const sectPrs = docXml.getElementsByTagName("w:sectPr");
  if (sectPrs.length === 0) return null;
  const sectPr = sectPrs[sectPrs.length - 1];

  let pageSize: DocPageSize = "letter";
  let orientation: DocOrientation = "portrait";
  const pgSz = directChild(sectPr, "pgSz");
  if (pgSz) {
    const wTwips = parseInt(attr(pgSz, "w:w") ?? "12240", 10);
    const hTwips = parseInt(attr(pgSz, "w:h") ?? "15840", 10);
    const orientAttr = attr(pgSz, "w:orient");
    if (orientAttr === "landscape" || (Number.isFinite(wTwips) && Number.isFinite(hTwips) && wTwips > hTwips)) {
      orientation = "landscape";
    }
    const shortSide = Math.min(wTwips, hTwips);
    const longSide = Math.max(wTwips, hTwips);
    if (Math.abs(shortSide - 11906) < 250 && Math.abs(longSide - 16838) < 250) {
      pageSize = "a4";
    } else if (Math.abs(longSide - 20160) < 300) {
      pageSize = "legal";
    } else {
      pageSize = "letter";
    }
  }

  const margins: DocMargins = { top: 1, right: 1, bottom: 1, left: 1 };
  const pgMar = directChild(sectPr, "pgMar");
  if (pgMar) {
    const parseMar = (attrName: string, fallback: number): number => {
      const raw = attr(pgMar, attrName);
      if (raw === null) return fallback;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? round2(Math.max(0, Math.min(4, n / TWIPS_PER_IN))) : fallback;
    };
    margins.top = parseMar("w:top", 1);
    margins.right = parseMar("w:right", 1);
    margins.bottom = parseMar("w:bottom", 1);
    margins.left = parseMar("w:left", 1);
  }

  let columns: 1 | 2 = 1;
  let columnGapIn = 0.25;
  const cols = directChild(sectPr, "cols");
  if (cols) {
    const num = parseInt(attr(cols, "w:num") ?? "1", 10);
    if (num === 2) columns = 2;
    const space = parseInt(attr(cols, "w:space") ?? "360", 10);
    if (Number.isFinite(space) && space >= 0) columnGapIn = round2(space / TWIPS_PER_IN);
  }

  let pageColor: string | null = null;
  const bg = docXml.getElementsByTagName("w:background")[0];
  if (bg) {
    const c = resolveColorAttr(bg, theme, "w:color");
    if (c && c !== "#ffffff") pageColor = c;
  }

  return { pageSize, orientation, margins, columns, columnGapIn, pageColor };
}

// Pictures in document order - the same order mammoth emits its <img> elements - with Word's wrap
// setting mapped onto the editor's picture layouts (docImageLayout.ts).
function parseImages(docXml: Document, content: { widthPx: number; marginLeftPx: number; marginTopPx: number; heightPx: number; marginBottomPx: number }): DocxImageMeta[] {
  const out: DocxImageMeta[] = [];
  const drawings = docXml.getElementsByTagName("w:drawing");
  const first = (el: Element | null | undefined, name: string): Element | null =>
    (el?.getElementsByTagName(`wp:${name}`)[0] as Element | undefined) ?? (el?.getElementsByTagName(name)[0] as Element | undefined) ?? null;
  const text = (el: Element | null, name: string): string | null => {
    const c = first(el, name);
    return c ? (c.textContent ?? "").trim() : null;
  };
  for (let i = 0; i < drawings.length; i++) {
    const drawing = drawings[i];
    const hasBlip = drawing.getElementsByTagName("a:blip").length > 0 || drawing.getElementsByTagName("blip").length > 0;
    if (!hasBlip) continue;
    const extent = first(drawing, "extent");
    const cx = parseInt(attr(extent, "cx") ?? "0", 10);
    const cy = parseInt(attr(extent, "cy") ?? "0", 10);
    const width = cx > 0 ? Math.max(1, Math.round(cx / EMU_PER_PX)) : 0;
    const height = cy > 0 ? Math.max(1, Math.round(cy / EMU_PER_PX)) : 0;
    const docPr = first(drawing, "docPr");
    const alt = attr(docPr, "descr") || attr(docPr, "title") || null;
    const anchor = first(drawing, "anchor");
    // a:xfrm rot is in 60000ths of a degree.
    const xfrm = (drawing.getElementsByTagName("a:xfrm")[0] as Element | undefined) ?? null;
    const rot = parseInt(attr(xfrm, "rot") ?? "0", 10) / 60000;
    const rotation = Number.isFinite(rot) && rot ? Math.round((((rot + 180) % 360) - 180) * 10) / 10 : 0;
    const meta: DocxImageMeta = { width, height, layout: "inline", align: "center", x: 0, y: 0, rotation, pageX: null, pageY: null, alt };
    if (anchor) {
      const posH = first(anchor, "positionH");
      const posV = first(anchor, "positionV");
      const hAlign = text(posH, "align");
      const hOffset = parseInt(text(posH, "posOffset") ?? "0", 10) / EMU_PER_PX;
      const hRel = attr(posH, "relativeFrom") ?? "column";
      const vAlign = text(posV, "align");
      const vOffset = parseInt(text(posV, "posOffset") ?? "0", 10) / EMU_PER_PX;
      const vRel = attr(posV, "relativeFrom") ?? "paragraph";
      // x from the text column's left edge.
      let x = hRel === "page" ? hOffset - content.marginLeftPx : hRel === "leftMargin" ? hOffset - content.marginLeftPx : hOffset;
      if (hAlign) x = hAlign === "center" ? (content.widthPx - width) / 2 : hAlign === "right" || hAlign === "outside" ? content.widthPx - width : 0;
      // y from the anchor paragraph's top; page/margin-relative offsets are approximated as if the
      // paragraph started at the top of the text area (exact for headers' first paragraph, the
      // common case: letterheads, logos).
      let y = vRel === "page" ? vOffset - content.marginTopPx : vRel === "paragraph" || vRel === "line" ? vOffset : vRel === "topMargin" ? vOffset - content.marginTopPx : vOffset;
      if (vAlign) y = 0;
      const third = content.widthPx / 3;
      const centre = x + width / 2;
      const align: "left" | "center" | "right" = hAlign === "center" ? "center" : hAlign === "right" || hAlign === "outside" ? "right" : hAlign ? "left" : centre < third ? "left" : centre > third * 2 ? "right" : "center";
      const wrap = ["wrapNone", "wrapSquare", "wrapTight", "wrapThrough", "wrapTopAndBottom"].find((w) => first(anchor, w));
      const behind = attr(anchor, "behindDoc") === "1" || attr(anchor, "behindDoc") === "true";
      if (wrap === "wrapTopAndBottom") Object.assign(meta, { layout: "block", align });
      else if (wrap === "wrapSquare" || wrap === "wrapTight" || wrap === "wrapThrough")
        Object.assign(meta, { layout: align === "center" ? "block" : align === "right" ? "wrapRight" : "wrapLeft", align });
      else {
        Object.assign(meta, { layout: behind ? "behind" : "front", align, x: Math.round(x), y: Math.round(y) });
        const pageY =
          vRel === "page" ? vOffset : vRel === "margin" ? content.marginTopPx + vOffset : vRel === "topMargin" ? vOffset : vRel === "bottomMargin" ? content.heightPx - content.marginBottomPx + vOffset : null;
        if (pageY !== null) {
          const vAlignPage = vAlign && vRel === "page" ? (vAlign === "center" ? (content.heightPx - height) / 2 : vAlign === "bottom" ? content.heightPx - height : 0) : null;
          meta.pageY = Math.round(vAlignPage ?? pageY);
          meta.pageX = Math.round(content.marginLeftPx + x);
        }
      }
    }
    out.push(meta);
  }
  return out;
}

function hasVisibleBorder(bdrEl: Element | null): boolean {
  if (!bdrEl) return false;
  const val = attr(bdrEl, "w:val");
  const sz = parseInt(attr(bdrEl, "w:sz") ?? "4", 10);
  return Boolean(val && val !== "none" && val !== "nil" && sz > 0);
}

function parseTableMeta(tbl: Element, theme: ThemeData, styleBorders: (styleId: string | null) => Element | null): DocxTableMeta {
  const tblPr = directChild(tbl, "tblPr");
  // The table's own borders, else its table style's (Word's "Table Grid" keeps them there).
  const tblBorders = directChild(tblPr, "tblBorders") ?? styleBorders(attr(directChild(tblPr, "tblStyle"), "w:val"));

  let topOrBottomVisible = false;
  let insideVOrSideVisible = false;
  let anyBorderSpecified = false;

  const checkBorders = (bordersEl: Element | null) => {
    if (!bordersEl) return;
    anyBorderSpecified = true;
    if (hasVisibleBorder(directChild(bordersEl, "top")) || hasVisibleBorder(directChild(bordersEl, "bottom")) || hasVisibleBorder(directChild(bordersEl, "insideH"))) {
      topOrBottomVisible = true;
    }
    if (hasVisibleBorder(directChild(bordersEl, "left")) || hasVisibleBorder(directChild(bordersEl, "right")) || hasVisibleBorder(directChild(bordersEl, "insideV"))) {
      insideVOrSideVisible = true;
    }
  };

  checkBorders(tblBorders);

  const tblGrid = directChild(tbl, "tblGrid");
  const colWidthsPx: number[] = [];
  if (tblGrid) {
    for (const gridCol of directChildren(tblGrid, "gridCol")) {
      const w = parseInt(attr(gridCol, "w:w") ?? "0", 10);
      if (w > 0) colWidthsPx.push(Math.max(20, Math.round((w / TWIPS_PER_IN) * 96)));
    }
  }

  const rows = directChildren(tbl, "tr").filter((tr) => !directChild(directChild(tr, "trPr"), "del"));
  const cells: DocxTableCellMeta[][] = [];
  const colHasContent: boolean[] = [];
  const gridCols = Math.max(1, colWidthsPx.length);
  // An edge's CSS: the cell's own border, else the table's outer edge or inside line. No border
  // anywhere means none - Word draws no grid a document didn't ask for.
  const edge = (tcBorders: Element | null, own: string[], table: string): string =>
    borderCss(own.map((n) => directChild(tcBorders, n)).find(Boolean) ?? null, theme) ?? borderCss(directChild(tblBorders, table), theme) ?? "none";

  rows.forEach((tr, rowIdx) => {
    const rowMeta: DocxTableCellMeta[] = [];
    const tcs = directChildren(tr, "tc");
    let gridCol = 0;
    tcs.forEach((tc, colIdx) => {
      const tcPr = directChild(tc, "tcPr");
      const span = Math.max(1, parseInt(attr(directChild(tcPr, "gridSpan"), "w:val") ?? "1", 10) || 1);
      const firstCol = gridCol === 0;
      gridCol += span;
      const lastCol = gridCol >= gridCols;
      const vMerge = directChild(tcPr, "vMerge");
      // Mammoth drops vMerge continuation cells (where w:val is absent or "continue").
      if (vMerge && (attr(vMerge, "w:val") ?? "continue") !== "restart") {
        return;
      }
      const tcBorders = directChild(tcPr, "tcBorders");
      const lastRow = rowIdx === rows.length - 1;
      const borders: CellBorders = {
        top: edge(tcBorders, ["top"], rowIdx === 0 ? "top" : "insideH"),
        bottom: edge(tcBorders, ["bottom"], lastRow ? "bottom" : "insideH"),
        left: edge(tcBorders, ["left", "start"], firstCol ? "left" : "insideV"),
        right: edge(tcBorders, ["right", "end"], lastCol ? "right" : "insideV"),
      };
      const vAlignVal = attr(directChild(tcPr, "vAlign"), "w:val");
      const verticalAlign = vAlignVal === "center" ? "middle" : vAlignVal === "bottom" ? "bottom" : vAlignVal === "top" ? "top" : null;
      checkBorders(directChild(tcPr, "tcBorders"));
      const shd = directChild(tcPr, "shd");
      const fill = resolveColorAttr(shd, theme, "w:fill") ?? null;
      const tcW = directChild(tcPr, "tcW");
      let colwidth: number | null = colWidthsPx[colIdx] ?? null;
      if (tcW && (attr(tcW, "w:type") === "dxa" || !attr(tcW, "w:type"))) {
        const w = parseInt(attr(tcW, "w:w") ?? "0", 10);
        if (w > 0) colwidth = Math.max(20, Math.round((w / TWIPS_PER_IN) * 96));
      }
      rowMeta.push({
        background: fill && fill !== "#ffffff" ? fill : null,
        colwidth,
        verticalAlign,
        borders,
      });
      const text = (tc.textContent ?? "").trim();
      const hasImg = tc.getElementsByTagName("a:blip").length > 0 || tc.getElementsByTagName("v:imagedata").length > 0;
      if (text.length > 0 || hasImg) {
        colHasContent[colIdx] = true;
      }
    });
    cells.push(rowMeta);
  });

  let rules: "none" | "booktabs" | null = null;
  if (anyBorderSpecified) {
    if (!topOrBottomVisible && !insideVOrSideVisible) rules = "none";
    else if (topOrBottomVisible && !insideVOrSideVisible) rules = "booktabs";
  }

  const nonEmptyCols = colHasContent.filter(Boolean).length;
  const hasAnyShading = cells.some((r) => r.some((c) => c.background !== null));
  const isSingleColumnLayoutWrapper = rules === "none" && !hasAnyShading && rows.length <= 2 && nonEmptyCols <= 1;

  return {
    isSingleColumnLayoutWrapper,
    rules,
    colWidthsPx,
    cells,
  };
}

// The document's styles, theme and numbering, resolved into the lookups every reader of a .docx
// part needs: a paragraph style's merged pPr/rPr (basedOn chain + docDefaults) and a character
// style's rPr. Shared by resolveDocxMetadata (the body) and docxLetterhead.ts (headers/footers).
export interface DocxStyleContext {
  parser: XmlDOMParser;
  theme: ThemeData;
  resolveNumLevel: (numId: string, ilvl: string) => NumLevelDef | null;
  docDefaultRPr: RawRPr;
  docDefaultPPr: RawPPr;
  styles: Map<string, RawStyleDef>;
  tableStyleBorders: Map<string, { borders: Element | null; basedOn?: string }>;
  resolveParagraphStyleChain: (styleId: string | null | undefined) => { pPr: RawPPr; rPr: RawRPr; isHeading: boolean };
  resolveCharacterStyleChain: (styleId: string | undefined) => RawRPr;
}

export async function loadStyleContext(zip: JSZip): Promise<DocxStyleContext> {
  const stylesXmlText = (await zip.file("word/styles.xml")?.async("string")) ?? null;
  const themeXmlText = (await zip.file("word/theme/theme1.xml")?.async("string")) ?? null;
  const numberingXmlText = (await zip.file("word/numbering.xml")?.async("string")) ?? null;

  const parser = new XmlDOMParser();
  const theme = parseThemeXml(themeXmlText, parser);
  const resolveNumLevel = parseNumberingXml(numberingXmlText, parser, theme);

  let docDefaultRPr: RawRPr = { fontSizePt: 11 };
  let docDefaultPPr: RawPPr = { spaceBeforePt: 0, spaceAfterPt: 0, lineTwips: 240, lineRule: "auto" };
  const styles = new Map<string, RawStyleDef>();
  // Table styles' borders (w:style w:type="table" > w:tblPr > w:tblBorders), by style id.
  const tableStyleBorders = new Map<string, { borders: Element | null; basedOn?: string }>();
  let defaultParagraphStyleId: string | null = null;

  if (stylesXmlText) {
    const stylesDoc = parser.parseFromString(stylesXmlText, "text/xml");
    const docDefaults = stylesDoc.getElementsByTagName("w:docDefaults")[0];
    if (docDefaults) {
      const rPrDefault = directChild(directChild(docDefaults, "rPrDefault"), "rPr");
      const pPrDefault = directChild(directChild(docDefaults, "pPrDefault"), "pPr");
      docDefaultRPr = mergeRPr(docDefaultRPr, extractRPr(rPrDefault, theme));
      docDefaultPPr = mergePPr(docDefaultPPr, extractPPr(pPrDefault, theme));
    }

    const styleEls = stylesDoc.getElementsByTagName("w:style");
    for (let i = 0; i < styleEls.length; i++) {
      const s = styleEls[i];
      const styleId = attr(s, "w:styleId");
      if (!styleId) continue;
      const type = attr(s, "w:type") ?? "paragraph";
      const name = attr(directChild(s, "name"), "w:val") ?? styleId;
      const basedOn = attr(directChild(s, "basedOn"), "w:val") ?? undefined;
      const isDefault = attr(s, "w:default") === "1" || attr(s, "w:default") === "true";
      if (isDefault && type === "paragraph") defaultParagraphStyleId = styleId;
      if (type === "table") tableStyleBorders.set(styleId, { borders: directChild(directChild(s, "tblPr"), "tblBorders"), basedOn });
      styles.set(styleId, {
        styleId,
        type,
        name,
        basedOn,
        isDefault,
        pPr: extractPPr(directChild(s, "pPr"), theme),
        rPr: extractRPr(directChild(s, "rPr"), theme),
      });
    }
  }

  const resolveParagraphStyleChain = (styleId: string | null | undefined): { pPr: RawPPr; rPr: RawRPr; isHeading: boolean } => {
    const chain: RawStyleDef[] = [];
    const seen = new Set<string>();
    let cur = styleId ?? defaultParagraphStyleId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const def = styles.get(cur);
      if (!def) break;
      chain.unshift(def);
      cur = def.basedOn ?? null;
    }
    let pPr: RawPPr = { ...docDefaultPPr };
    let rPr: RawRPr = { ...docDefaultRPr };
    let isHeading = false;
    for (const def of chain) {
      pPr = mergePPr(pPr, def.pPr);
      rPr = mergeRPr(rPr, def.rPr);
      if (isHeadingStyle(def.styleId, def.name)) isHeading = true;
    }
    return { pPr, rPr, isHeading };
  };

  const resolveCharacterStyleChain = (styleId: string | undefined): RawRPr => {
    if (!styleId) return {};
    const chain: RawStyleDef[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = styleId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const def = styles.get(cur);
      if (!def) break;
      chain.unshift(def);
      cur = def.basedOn;
    }
    let rPr: RawRPr = {};
    for (const def of chain) {
      rPr = mergeRPr(rPr, def.rPr);
    }
    return rPr;
  };

  return { parser, theme, resolveNumLevel, docDefaultRPr, docDefaultPPr, styles, tableStyleBorders, resolveParagraphStyleChain, resolveCharacterStyleChain };
}

export async function resolveDocxMetadata(bytes: Uint8Array): Promise<DocxDocumentMetadata> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlText = await zip.file("word/document.xml")?.async("string");
    if (!docXmlText) return { paragraphs: [], pageSetup: null, imageSizes: [], tables: [], images: [], pageChrome: null };

    const ctx = await loadStyleContext(zip);
    const { parser, theme, resolveNumLevel, docDefaultRPr, tableStyleBorders, resolveParagraphStyleChain, resolveCharacterStyleChain } = ctx;

    const docXml = parser.parseFromString(docXmlText, "text/xml");
    const pageSetup = parsePageSetup(docXml, theme);
    const pgSz = directChild(docXml.getElementsByTagName("w:sectPr")[docXml.getElementsByTagName("w:sectPr").length - 1] ?? null, "pgSz");
    const pageWidthPx = (parseInt(attr(pgSz, "w:w") ?? "12240", 10) / TWIPS_PER_IN) * 96;
    const margins = pageSetup?.margins ?? { top: 1, right: 1, bottom: 1, left: 1 };
    const pageHeightPx = (parseInt(attr(pgSz, "w:h") ?? "15840", 10) / TWIPS_PER_IN) * 96;
    const images = parseImages(docXml, {
      widthPx: pageWidthPx - (margins.left + margins.right) * 96,
      marginLeftPx: margins.left * 96,
      marginTopPx: margins.top * 96,
      heightPx: pageHeightPx,
      marginBottomPx: margins.bottom * 96,
    });
    const imageSizes = images.map((im) => (im.width && im.height ? { width: im.width, height: im.height } : null));
    const styleBorders = (styleId: string | null): Element | null => {
      const seen = new Set<string>();
      let cur = styleId ?? undefined;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const def = tableStyleBorders.get(cur);
        if (!def) return null;
        if (def.borders) return def.borders;
        cur = def.basedOn;
      }
      return null;
    };
    const tables: DocxTableMeta[] = [];
    const paragraphs: ParagraphStyle[] = [];

    // Accumulates the vertical height (in pt) of empty <w:p> spacer paragraphs skipped by mammoth so
    // the next non-empty paragraph preserves the exact visual blank space from Word / Google Docs.
    let pendingEmptySpacePt = 0;
    // A page break seen after the last emitted paragraph's text: the next emitted block starts a page.
    let pendingPageBreak = false;

    const processParagraph = (p: Element, forceEmitIfEmpty: boolean) => {
      const directPPrEl = directChild(p, "pPr");
      // Mammoth skips paragraphs whose pPr > rPr contains w:del.
      if (directChild(directChild(directPPrEl, "rPr"), "del")) return;

      const directPPr = extractPPr(directPPrEl, theme);
      const styleChain = resolveParagraphStyleChain(directPPr.pStyle);
      const mergedPPr = mergePPr(styleChain.pPr, directPPr);

      const numLevel = mergedPPr.numId && !styleChain.isHeading ? resolveNumLevel(mergedPPr.numId, mergedPPr.ilvl ?? "0") : null;
      const isListItem = numLevel !== null;

      const paraBaseRPr = styleChain.rPr;
      const pilcrowRPr = mergeRPr(paraBaseRPr, directPPr.rPr);

      let afterRightTab = false;
      let hasNonTextInlineContent = false;
      const rawRuns: RunStyle[] = [];
      let breakBefore = pendingPageBreak || !!mergedPPr.pageBreakBefore;
      let breakAfter = false;

      const collectRunsFromContainer = (container: Element) => {
        for (const child of elementChildren(container)) {
          const local = localTag(child);
          if (local === "pPr" || local === "del" || local === "moveFrom" || local === "bookmarkStart" || local === "bookmarkEnd") {
            continue;
          }
          if (local === "hyperlink" || local === "smartTag" || local === "ins" || local === "fldSimple") {
            collectRunsFromContainer(child);
            continue;
          }
          if (local === "sdt") {
            const sdtContent = directChild(child, "sdtContent");
            if (sdtContent) collectRunsFromContainer(sdtContent);
            continue;
          }
          if (local === "r") {
            if (directChild(child, "del")) continue;
            const runRPrEl = directChild(child, "rPr");
            const directRunRPr = extractRPr(runRPrEl, theme);
            const charStyleRPr = resolveCharacterStyleChain(directRunRPr.rStyle);
            const resolvedRun = mergeRPr(mergeRPr(paraBaseRPr, charStyleRPr), directRunRPr);

            let currentText = "";
            let currentTabAlign: "right" | null = afterRightTab ? "right" : null;

            const flushRunSegment = () => {
              if (!currentText) return;
              const fontSizePt = resolvedRun.fontSizePt ?? paraBaseRPr.fontSizePt ?? null;
              const boldVal = resolvedRun.bold ?? null;
              const italicVal = resolvedRun.italic ?? null;
              rawRuns.push({
                text: currentText,
                fontFamily: resolvedRun.fontFamily ?? null,
                fontSize: fontSizePt ? `${fontSizePt}pt` : null,
                fontSizePt,
                color: resolvedRun.color ?? null,
                bold: boldVal,
                italic: italicVal,
                underline: resolvedRun.underline ?? null,
                fontWeight: styleChain.isHeading && boldVal === false ? "normal" : null,
                fontStyle: italicVal === false ? "normal" : null,
                tabAlign: currentTabAlign,
                letterSpacingPt: resolvedRun.spacingTwips ? round2(resolvedRun.spacingTwips / TWIPS_PER_PT) : null,
                caps: resolvedRun.caps ?? null,
                smallCaps: resolvedRun.smallCaps ?? null,
                highlight: resolvedRun.highlight ?? null,
              });
              currentText = "";
            };

            for (const rc of elementChildren(child)) {
              const rLocal = localTag(rc);
              if (rLocal === "t") {
                currentText += rc.textContent ?? "";
              } else if (rLocal === "noBreakHyphen") {
                currentText += "\u2011";
              } else if (rLocal === "softHyphen") {
                currentText += "\u00ad";
              } else if (rLocal === "tab") {
                if (mergedPPr.hasRightTab && !afterRightTab) {
                  flushRunSegment();
                  afterRightTab = true;
                  currentTabAlign = "right";
                  currentText += "\u00a0";
                } else {
                  currentText += "\u00a0";
                }
              } else if (rLocal === "br") {
                const brType = attr(rc, "w:type");
                if (!brType || brType === "textWrapping") {
                  hasNonTextInlineContent = true;
                } else if (brType === "page") {
                  // Before any text: this paragraph starts the new page; after text: the next one.
                  if (rawRuns.length === 0 && !currentText) breakBefore = true;
                  else breakAfter = true;
                }
              } else if (
                rLocal === "drawing" ||
                rLocal === "pict" ||
                rLocal === "object" ||
                rLocal === "footnoteReference" ||
                rLocal === "endnoteReference" ||
                rLocal === "commentReference"
              ) {
                hasNonTextInlineContent = true;
              }
            }
            flushRunSegment();
          }
        }
      };

      collectRunsFromContainer(p);
      // A section break that starts a new page ends this paragraph's page.
      const sectPr = directChild(directPPrEl, "sectPr");
      if (sectPr) {
        const sectType = attr(directChild(sectPr, "type"), "w:val");
        if (sectType !== "continuous") breakAfter = true;
      }

      const fullText = rawRuns.map((r) => r.text).join("");
      const isEmpty = fullText.length === 0 && !hasNonTextInlineContent;

      const lineMultiplier = (() => {
        if (!mergedPPr.lineTwips) return null;
        if (mergedPPr.lineRule === "exact" || mergedPPr.lineRule === "atLeast") {
          const linePt = mergedPPr.lineTwips / TWIPS_PER_PT;
          const baseFontPt = pilcrowRPr.fontSizePt ?? 11;
          return round2(Math.max(1, linePt / baseFontPt));
        }
        return round2(mergedPPr.lineTwips / 240);
      })();

      if (isEmpty && !forceEmitIfEmpty) {
        // A paragraph holding only a page break: the break carries to the next block, and its
        // empty line isn't blank space on the new page.
        if (breakBefore || breakAfter) {
          pendingPageBreak = true;
          pendingEmptySpacePt = 0;
          return;
        }
        const emptyFontPt = pilcrowRPr.fontSizePt ?? docDefaultRPr.fontSizePt ?? 11;
        const emptyLine = lineMultiplier ?? 1.15;
        const beforePt = mergedPPr.spaceBeforePt ?? 0;
        const afterPt = mergedPPr.spaceAfterPt ?? 0;
        pendingEmptySpacePt = round2(pendingEmptySpacePt + emptyFontPt * emptyLine + beforePt + afterPt);
        return;
      }

      const primaryRun = rawRuns.find((r) => r.text.trim().length > 0) ?? rawRuns[0];
      const fontFamily = primaryRun?.fontFamily ?? paraBaseRPr.fontFamily ?? null;
      const fontSizePt = primaryRun?.fontSizePt ?? paraBaseRPr.fontSizePt ?? null;
      const fontSize = fontSizePt ? `${fontSizePt}pt` : null;
      const color = primaryRun?.color ?? paraBaseRPr.color ?? null;
      const bold = styleChain.isHeading ? (paraBaseRPr.bold ?? null) : (primaryRun?.bold ?? paraBaseRPr.bold ?? null);
      const italic = primaryRun?.italic ?? paraBaseRPr.italic ?? null;
      const underline = primaryRun?.underline ?? paraBaseRPr.underline ?? null;

      const rawBefore = mergedPPr.spaceBeforePt ?? 0;
      const spaceBeforePt = round2(rawBefore + pendingEmptySpacePt);
      pendingEmptySpacePt = 0;
      pendingPageBreak = breakAfter;
      const spaceAfterPt = mergedPPr.spaceAfterPt ?? 0;

      let listIndentLeftIn: number | null = null;
      if (isListItem && numLevel?.leftTwips != null && numLevel.leftTwips > 720) {
        listIndentLeftIn = round2(numLevel.leftTwips / TWIPS_PER_IN);
      }

      paragraphs.push({
        fontFamily,
        fontSize,
        fontSizePt,
        color,
        bold,
        italic,
        underline,
        lineSpacing: lineMultiplier,
        spaceBeforePt,
        spaceAfterPt,
        textAlign: mergedPPr.textAlign ?? null,
        indentLeftIn: isListItem ? null : (mergedPPr.indentLeftIn ?? null),
        indentRightIn: isListItem ? null : (mergedPPr.indentRightIn ?? null),
        indentFirstIn: isListItem ? null : (mergedPPr.indentFirstIn ?? null),
        borderBottom: mergedPPr.borderBottom || null,
        borderTop: mergedPPr.borderTop || null,
        borderLeft: mergedPPr.borderLeft || null,
        borderRight: mergedPPr.borderRight || null,
        shading: mergedPPr.shading || null,
        pageBreakBefore: breakBefore,
        bulletMarker: isListItem ? mapBulletMarker(numLevel) : null,
        listIndentLeftIn,
        isListItem,
        runs: rawRuns,
        textPreview: fullText.replace(/\s+/g, " ").trim().slice(0, 80),
      });
    };

    const walkBlockContainer = (container: Element, isTableCell: boolean) => {
      const childParagraphs = isTableCell ? directChildren(container, "p") : [];
      const cellHasAnyNonEmptyP =
        isTableCell &&
        childParagraphs.some((cp) => {
          const text = (cp.textContent ?? "").trim();
          const hasDrawing = cp.getElementsByTagName("w:drawing").length > 0 || cp.getElementsByTagName("w:pict").length > 0;
          return text.length > 0 || hasDrawing;
        });

      let emittedCellFallbackP = false;
      for (const el of elementChildren(container)) {
        const local = localTag(el);
        if (local === "p") {
          const forceEmit = isTableCell && !cellHasAnyNonEmptyP && !emittedCellFallbackP;
          if (forceEmit) emittedCellFallbackP = true;
          processParagraph(el, forceEmit);
        } else if (local === "tbl") {
          const tblMeta = parseTableMeta(el, theme, styleBorders);
          tables.push(tblMeta);
          const rows = directChildren(el, "tr").filter((tr) => !directChild(directChild(tr, "trPr"), "del"));
          for (const tr of rows) {
            const tcs = directChildren(tr, "tc");
            for (const tc of tcs) {
              const tcPr = directChild(tc, "tcPr");
              const vMerge = directChild(tcPr, "vMerge");
              if (vMerge && (attr(vMerge, "w:val") ?? "continue") !== "restart") {
                continue;
              }
              if (tblMeta.isSingleColumnLayoutWrapper) {
                const hasAnyContent = (tc.textContent ?? "").trim().length > 0 || tc.getElementsByTagName("a:blip").length > 0;
                if (!hasAnyContent) continue;
                walkBlockContainer(tc, false);
              } else {
                walkBlockContainer(tc, true);
              }
            }
          }
        } else if (local === "sdt") {
          const sdtContent = directChild(el, "sdtContent");
          if (sdtContent) walkBlockContainer(sdtContent, isTableCell);
        }
      }
    };

    const body = docXml.getElementsByTagName("w:body")[0];
    if (body) walkBlockContainer(body, false);

    return {
      paragraphs,
      pageSetup,
      imageSizes,
      tables,
      images,
      pageChrome: await resolveDocxPageChrome(zip, docXml).catch((err) => {
        console.error("Failed to read the .docx header/footer:", err);
        return null;
      }),
    };
  } catch (err) {
    console.error("Failed to resolve docx metadata:", err);
    return { paragraphs: [], pageSetup: null, imageSizes: [], tables: [], images: [], pageChrome: null };
  }
}

export async function resolveDocxParagraphStyles(bytes: Uint8Array): Promise<ParagraphStyle[]> {
  const meta = await resolveDocxMetadata(bytes);
  return meta.paragraphs;
}
