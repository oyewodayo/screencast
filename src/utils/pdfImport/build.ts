// utils/pdfImport/build.ts
//
// The assembled blocks (assemble.ts) -> a Docs document: ProseMirror JSON plus the document
// settings that make it look like the paper - page size and margins, two columns, the body style
// (font, size, leading, indent), the caption naming ("FIG. 3.", "TABLE IV."), and the reference
// library. Everything stays live and editable:
//   - text runs keep the PDF's fonts, sizes, bold/italic, sub/superscripts and links
//   - inline and display math become LaTeX math nodes; numbered equations are numbered by Docs
//   - "[12]" becomes a citation of reference 12, "Eq. (5)" / "Fig. 3" / "Table IV" become
//     cross-references (the number is the live part; the word stays as written)
//   - tables become real tables with the paper's rules and header rows
//   - figures become images cropped from the page
//   - the reference list becomes the document's library, printed exactly as in the paper
import type { JSONContent } from "@tiptap/core";
import katex from "katex";
import type { FontMeta, Glyph } from "./glyphs";
import { inlineContent, lineText, wordCounts, type Inline, type LinkArea, type PageRule } from "./assemble";
import { glyphsToLatex } from "./math";
import type { PageAnalysis } from "./layout";
import type { DocBlock, EquationBlock, FigureBlock, FlowLine, ParagraphStyle, Span, TableBlock, TocEntryElement } from "./model";
import type { BibEntry } from "../docBibliography";
import { latexToUnicode } from "../docBibliography";
import type { Segment } from "../docCitationStyles";
import type { DocBodyStyle, DocLayout } from "../docLayout";
import { DEFAULT_NUMBERING, parseNumeral, type LabelStyle, type NumberingStyle } from "../docNumbering";
import type { DocMargins, DocPageSize } from "../docTypes";

export interface BuildAssets {
  // CSS font-family stack for a PDF font (its own embedded face or a bundled equivalent).
  fontStack(font: FontMeta): string;
  // An image cropped from the page for a figure: src for the image node and its size in pt.
  figure(block: FigureBlock): { src: string; widthPt: number; heightPt: number } | null;
  // Exact image of an equation, used only when its LaTeX can't be rebuilt.
  equation(block: EquationBlock): { src: string; widthPt: number; heightPt: number } | null;
}

export interface BuildInput {
  pages: PageAnalysis[];
  blocks: DocBlock[];
  bodySize: number;
  allLines: FlowLine[];
  links: LinkArea[];
  textIsRoman: boolean;
  assets: BuildAssets;
}

export interface BuildResult {
  doc: JSONContent;
  title: string;
  pageSize: DocPageSize;
  margins: DocMargins;
  layout: DocLayout;
  numbering: NumberingStyle;
  references: BibEntry[];
  stats: { paragraphs: number; equations: number; inlineMath: number; tables: number; figures: number; citations: number; crossRefs: number; references: number; imageEquations: number };
}

type Mark = { type: string; attrs?: Record<string, unknown> };

const round = (v: number, step = 0.1) => Math.round(v / step) * step;
const toIn = (pt: number) => Math.round((pt / 72) * 1000) / 1000;
const PX_PER_PT = 96 / 72;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function mostCommon<T>(items: T[], key: (t: T) => string): T | null {
  const counts = new Map<string, { item: T; n: number }>();
  for (const it of items) {
    const k = key(it);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { item: it, n: 1 });
  }
  let best: { item: T; n: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.item ?? null;
}

function validLatex(latex: string, display: boolean): boolean {
  try {
    katex.renderToString(latex, { throwOnError: true, displayMode: display, strict: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------------------------
// Page setup

function pageSetup(pages: PageAnalysis[], lines: FlowLine[]): { pageSize: DocPageSize; margins: DocMargins; columns: 1 | 2; gutterIn: number } {
  const w = median(pages.map((p) => p.width));
  const h = median(pages.map((p) => p.height));
  const pageSize: DocPageSize = Math.abs(w - 595) < 12 && Math.abs(h - 842) < 12 ? "a4" : Math.abs(h - 1008) < 12 ? "legal" : "letter";
  const twoCol = pages.filter((p) => p.columns.twoColumn);
  const columns: 1 | 2 = twoCol.length >= Math.max(1, pages.length / 2) ? 2 : 1;
  const left = median(pages.map((p) => p.columns.full[0]));
  const right = median(pages.map((p) => p.width - p.columns.full[1]));
  // Top and bottom from where text actually starts and ends on full pages: the first line's ink
  // top less the room its own line box takes above the ink, so the first baseline lands where it
  // does in the PDF.
  const tops: number[] = [];
  const bottoms: number[] = [];
  for (const p of pages) {
    const ls = lines.filter((l) => l.page === p.page);
    if (ls.length < 10) continue;
    const first = ls.reduce((a, b) => (b.base < a.base ? b : a));
    const last = ls.reduce((a, b) => (b.base > a.base ? b : a));
    tops.push(first.base - 0.95 * first.size);
    bottoms.push(p.height - (last.base + 0.3 * last.size));
  }
  const top = tops.length ? Math.min(...tops) : 72;
  const bottom = bottoms.length ? median(bottoms) : 72;
  const gutter = twoCol.length ? median(twoCol.map((p) => p.columns.right[0] - p.columns.left[1])) : 18;
  const clampIn = (pt: number) => Math.max(0.25, Math.min(2.5, toIn(pt)));
  return { pageSize, margins: { top: clampIn(top), bottom: clampIn(bottom), left: clampIn(left), right: clampIn(right) }, columns, gutterIn: toIn(Math.max(6, gutter)) };
}

// ----------------------------------------------------------------------------------------------
// Inline content -> JSON

interface InlineContext {
  bodySize: number;
  bodyStack: string;
  assets: BuildAssets;
  // number as printed ("12") -> reference id
  refs: Map<string, string>;
  // "eq:5" / "fig:3" / "tab:IV" -> target id
  targets: Map<string, string>;
  stats: BuildResult["stats"];
  // Running text of the paragraph only: front matter keeps "[1]" etc. as typed.
  linkify: boolean;
}

function textMarks(run: Extract<Inline, { kind: "text" }>, ctx: InlineContext, opts: { baseBold?: boolean; baseSize?: number } = {}): Mark[] {
  const marks: Mark[] = [];
  if (run.link) marks.push({ type: "link", attrs: { href: run.link, target: "_blank", rel: "noopener noreferrer nofollow" } });
  const textual = run.font.role === "text" || run.font.role === "roman" || run.font.role === "mono" || run.font.role === "sans";
  if ((run.font.bold || run.font.role === "boldMathItalic") && !opts.baseBold) marks.push({ type: "bold" });
  if (run.font.italic && textual) marks.push({ type: "italic" });
  if (run.script === "sup") marks.push({ type: "superscript" });
  if (run.script === "sub") marks.push({ type: "subscript" });
  const style: Record<string, unknown> = {};
  const stack = ctx.assets.fontStack(run.font);
  if (stack && stack !== ctx.bodyStack) style.fontFamily = stack;
  const base = opts.baseSize ?? ctx.bodySize;
  if (!run.script && Math.abs(run.size - base) >= 0.25) style.fontSize = round(run.size, 0.5);
  if (Object.keys(style).length) marks.push({ type: "textStyle", attrs: { fontFamily: null, fontSize: null, color: null, ...style } });
  return marks;
}

const CITE = /\[(\d+(?:\s*[–-]\s*\d+)?(?:\s*,\s*\d+(?:\s*[–-]\s*\d+)?)*)\]/g;
// The word stays text; each number becomes a live cross-reference (number form).
// A number as papers and theses print it: "3", "IV", "4.6", "A.2".
const NUM = String.raw`(?:[A-Z]\.)?\d+(?:\.\d+)?`;
const LIST_SEP = String.raw`\s*(?:,|and|to|–|-|,\s*and)\s*`;
// The word stays text; each number becomes a live cross-reference. form: how the reference prints
// - "number" ("(5)", "3", "IV"), or "bare" for an equation number written without parentheses.
const XREFS: { re: RegExp; kind: "eq" | "fig" | "tab"; token: RegExp; form: "number" | "bare" }[] = [
  { re: new RegExp(String.raw`\b(Eqs?\.|Equations?|Eq)(\s*)(\(${NUM}\)(?:${LIST_SEP}\(${NUM}\))*)`, "g"), kind: "eq", token: new RegExp(String.raw`\((${NUM})\)`), form: "number" },
  { re: new RegExp(String.raw`\b(Eqs?\.|Equations?)(\s+)(${NUM}(?:${LIST_SEP}${NUM})*)(?![\d(])`, "g"), kind: "eq", token: new RegExp(`(${NUM})`), form: "bare" },
  { re: new RegExp(String.raw`\b(Figs?\.|Figures?|FIGS?\.)(\s*)(${NUM}(?:${LIST_SEP}${NUM})*)`, "g"), kind: "fig", token: new RegExp(`(${NUM})`), form: "number" },
  { re: new RegExp(String.raw`\b(Tables?|TABLES?)(\s*)((?:[IVXLC]+|${NUM})(?:${LIST_SEP}(?:[IVXLC]+|${NUM}))*)\b`, "g"), kind: "tab", token: new RegExp(`([IVXLC]+|${NUM})`), form: "number" },
];

function expandRange(spec: string): string[] {
  const out: string[] = [];
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)\s*[–-]\s*(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (b >= a && b - a < 60) for (let k = a; k <= b; k++) out.push(String(k));
    } else if (part.trim()) out.push(part.trim());
  }
  return out;
}

// Splits one text run into text, citation and cross-reference nodes.
function linkifyText(text: string, marks: Mark[], ctx: InlineContext): JSONContent[] {
  const nodes: JSONContent[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    nodes.push(marks.length ? { type: "text", text: t, marks } : { type: "text", text: t });
  };
  if (!ctx.linkify || marks.some((m) => m.type === "superscript" || m.type === "subscript" || m.type === "link")) {
    pushText(text);
    return nodes;
  }
  // Inline atoms keep only the formatting marks that make sense on them.
  const atomMarks = marks.filter((m) => m.type === "bold" || m.type === "italic" || m.type === "textStyle");
  const atom = (type: string, attrs: Record<string, unknown>): JSONContent => (atomMarks.length ? { type, attrs, marks: atomMarks } : { type, attrs });
  interface Hit {
    start: number;
    end: number;
    nodes: JSONContent[];
  }
  const hits: Hit[] = [];
  if (ctx.refs.size) {
    for (const m of text.matchAll(CITE)) {
      const nums = expandRange(m[1]);
      const ids = nums.map((n) => ctx.refs.get(n));
      if (ids.length === 0 || ids.some((id) => !id)) continue;
      hits.push({ start: m.index!, end: m.index! + m[0].length, nodes: [atom("citation", { refIds: ids, locator: null })] });
      ctx.stats.citations++;
    }
  }
  for (const x of XREFS) {
    for (const m of text.matchAll(x.re)) {
      const [, word, gap, list] = m;
      const out: JSONContent[] = [...textNode(word + gap, marks)];
      let rest = list;
      let ok = false;
      while (rest.length) {
        const t = rest.match(x.token);
        if (!t || t.index === undefined) {
          out.push(...textNode(rest, marks));
          break;
        }
        out.push(...textNode(rest.slice(0, t.index), marks));
        const id = ctx.targets.get(`${x.kind}:${t[1]}`);
        if (id) {
          out.push(atom("crossRef", { targetId: id, form: x.form }));
          ctx.stats.crossRefs++;
          ok = true;
        } else out.push(...textNode(t[0], marks));
        rest = rest.slice(t.index + t[0].length);
      }
      if (ok) hits.push({ start: m.index!, end: m.index! + m[0].length, nodes: out });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue;
    pushText(text.slice(at, h.start));
    nodes.push(...h.nodes);
    at = h.end;
  }
  pushText(text.slice(at));
  return nodes;
}

function textNode(t: string, marks: Mark[]): JSONContent[] {
  if (!t) return [];
  return [marks.length ? { type: "text", text: t, marks } : { type: "text", text: t }];
}

function inlineToJson(items: Inline[], ctx: InlineContext, opts: { baseBold?: boolean; baseSize?: number } = {}): JSONContent[] {
  const out: JSONContent[] = [];
  for (const it of items) {
    if (it.kind === "break") out.push({ type: "hardBreak" });
    else if (it.kind === "math") {
      ctx.stats.inlineMath++;
      if (validLatex(it.latex, false)) out.push({ type: "mathInline", attrs: { latex: it.latex } });
      else out.push(...textNode(it.glyphs.map((g) => g.ch).join(""), []));
    } else out.push(...linkifyText(it.text, textMarks(it, ctx, opts), ctx));
  }
  // No leading/trailing whitespace, no empty text nodes.
  while (out.length && out[0].type === "text" && !(out[0].text ?? "").trim()) out.shift();
  if (out[0]?.type === "text") out[0] = { ...out[0], text: (out[0].text ?? "").replace(/^\s+/, "") };
  const last = out.length - 1;
  if (out[last]?.type === "text") out[last] = { ...out[last], text: (out[last].text ?? "").replace(/\s+$/, "") };
  return out.filter((n) => n.type !== "text" || (n.text ?? "") !== "");
}

// Drops the first `count` visible characters (a caption's "FIG. 3." label) from inline content.
function dropLeadingChars(items: Inline[], count: number): Inline[] {
  let left = count;
  const out: Inline[] = [];
  for (const it of items) {
    if (left <= 0) {
      out.push(it);
      continue;
    }
    if (it.kind === "math") {
      left -= it.glyphs.length;
      continue;
    }
    if (it.kind === "break") continue;
    let k = 0;
    while (k < it.text.length && left > 0) {
      if (!/\s/.test(it.text[k])) left--;
      k++;
    }
    const rest = it.text.slice(k).replace(/^\s+/, "");
    if (rest) out.push({ ...it, text: rest });
  }
  return out;
}

// ----------------------------------------------------------------------------------------------
// Blocks

function blockAttrs(style: ParagraphStyle, span: Span, body: DocBodyStyle, twoColumns: boolean, kind: "paragraph" | "heading", lineCount: number): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (twoColumns && span === "F") attrs.span = "all";
  if (style.align === "center") attrs.textAlign = "center";
  else if (style.align === "right") attrs.textAlign = "right";
  else if (style.align === "justify" && !body.justify) attrs.textAlign = "justify";
  else if (style.align === "left" && body.justify && lineCount >= 2) attrs.textAlign = "left";
  if (style.spaceBefore > 1.5) attrs.spaceBefore = round(style.spaceBefore, 0.5);
  if (style.indentLeft > 1) attrs.indentLeft = toIn(style.indentLeft);
  if (style.indentRight > 1) attrs.indentRight = toIn(style.indentRight);
  if (kind === "paragraph" && style.align !== "center") {
    const parIndent = body.paragraphIndent ?? 0;
    if (Math.abs(style.indentFirst) < 1) attrs.noIndent = true;
    else if (Math.abs(style.indentFirst - parIndent) > 1) attrs.indentFirst = toIn(style.indentFirst);
  }
  const leading = style.leading / (body.fontSize ?? style.size);
  if (body.lineHeight && lineCount >= 2 && Math.abs(leading - body.lineHeight) > 0.04) attrs.lineSpacing = Math.round(leading * 100) / 100;
  return attrs;
}

// Pseudo flow lines for a table cell's glyphs: grouped by baseline.
function cellLines(glyphs: Glyph[], table: TableBlock): FlowLine[] {
  const vis = glyphs.filter((g) => !g.space);
  if (vis.length === 0) return [];
  const sorted = [...glyphs].sort((a, b) => a.base - b.base);
  const groups: Glyph[][] = [];
  for (const g of sorted) {
    const big = Math.max(...vis.map((v) => v.size));
    const grp = groups.find((gr) => Math.abs(gr[0].base - g.base) < 0.6 * big);
    if (grp) grp.push(g);
    else groups.push([g]);
  }
  // Scripts sit off their baseline: merge small groups into the nearest full-size line.
  const lines: FlowLine[] = [];
  for (const gr of groups.sort((a, b) => a[0].base - b[0].base)) {
    const v = gr.filter((g) => !g.space);
    if (v.length === 0) continue;
    const size = Math.max(...v.map((g) => g.size));
    const gs = gr.sort((a, b) => a.x - b.x);
    lines.push({
      page: table.page,
      span: table.span,
      glyphs: gs,
      x0: Math.min(...v.map((g) => g.x)),
      x1: Math.max(...v.map((g) => g.x + g.adv)),
      base: median(v.filter((g) => g.size >= 0.9 * size).map((g) => g.base)),
      size,
      top: Math.min(...v.map((g) => g.top)),
      bottom: Math.max(...v.map((g) => g.bottom)),
      colX0: table.region.x0,
      colX1: table.region.x1,
    });
  }
  // Fold script-only lines (smaller than their neighbour, within a script offset) into it.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const host = lines.find((o) => o !== l && o.size > 1.15 * l.size && Math.abs(o.base - l.base) < 0.7 * o.size);
    if (host) {
      host.glyphs = [...host.glyphs, ...l.glyphs].sort((a, b) => a.x - b.x);
      host.top = Math.min(host.top, l.top);
      host.bottom = Math.max(host.bottom, l.bottom);
      lines.splice(i, 1);
      i--;
    }
  }
  return lines;
}

function captionLabelStyle(prefix: string, numbering: "arabic" | "roman"): LabelStyle {
  const upper = prefix === prefix.toUpperCase();
  const isTable = /^t/i.test(prefix);
  const ref = isTable ? "Table" : /^fig\.?$/i.test(prefix) ? "Fig." : upper ? "Fig." : "Figure";
  return { caption: prefix, ref, numerals: numbering === "roman" ? "upper-roman" : "arabic" };
}

// Reference entry text -> fields for the picker and other citation styles (best effort; the
// printed text is what the reference list shows).
function parseReference(text: string): Partial<BibEntry> {
  const out: Partial<BibEntry> = {};
  const year = text.match(/\((?:[A-Za-z.]+\s)?(1[89]\d\d|20\d\d)\)/) ?? text.match(/\b(1[89]\d\d|20\d\d)\b/);
  if (year) out.issued = { "date-parts": [[parseInt(year[1], 10)]] };
  const doi = text.match(/\b(10\.\d{4,9}\/[^\s,;]+[^\s,;.)])/);
  if (doi) out.DOI = doi[1];
  const arxiv = text.match(/arXiv:\s*(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i);
  if (arxiv) out.arxiv = arxiv[1];
  // Leading author list: "P. Scholl, M. Schuler, and A. Browaeys, ..." (initials then family).
  const NAME = /^\s*(?:and\s+)?((?:\p{Lu}\.(?:\s?-?\p{Lu}\.)*\s+)+)((?:(?:van|von|de|der|da|di|le|la)\s+)*[\p{Lu}][\p{L}'’-]+(?:\s+(?:Jr\.|Sr\.|III|II))?)\s*(,|\s+and(?=\s)|\set al\.|$)/u;
  let rest = text;
  const authors: { family: string; given: string }[] = [];
  for (let k = 0; k < 40; k++) {
    const m = rest.match(NAME);
    if (!m) break;
    authors.push({ given: m[1].trim(), family: m[2].trim() });
    rest = rest.slice(m[0].length);
    if (m[3] !== "," && !/and$/.test(m[3])) break;
  }
  if (authors.length) out.author = authors;
  // A quoted title (IEEE/APS with titles).
  const title = text.match(/[“"]([^”"]{8,})[,.]?[”"]/);
  if (title) out.title = title[1].replace(/[,.]$/, "");
  return out;
}

function segmentsOf(items: Inline[]): Segment[] {
  const segs: Segment[] = [];
  for (const it of items) {
    if (it.kind === "break") continue;
    const seg: Segment =
      it.kind === "math"
        ? { text: latexToUnicode(`$${it.latex}$`) }
        : { text: it.text, ...(it.font.italic && it.font.role === "text" ? { italic: true } : {}), ...(it.font.bold ? { bold: true } : {}), ...(it.link ? { link: it.link } : {}) };
    const last = segs[segs.length - 1];
    if (last && !!last.italic === !!seg.italic && !!last.bold === !!seg.bold && last.link === seg.link) last.text += seg.text;
    else segs.push(seg);
  }
  if (segs.length) {
    segs[0].text = segs[0].text.replace(/^\s+/, "");
    segs[segs.length - 1].text = segs[segs.length - 1].text.replace(/\s+$/, "");
  }
  return segs.filter((s) => s.text);
}

export function buildDocument(input: BuildInput): BuildResult {
  const { pages, blocks, bodySize, allLines, links, textIsRoman, assets } = input;
  const words = wordCounts(allLines);
  const rules: PageRule[] = pages.flatMap((p) => p.rules.map((r) => ({ ...r, page: p.page })));
  const setup = pageSetup(pages, allLines);
  const twoColumns = setup.columns === 2;
  const stats: BuildResult["stats"] = { paragraphs: 0, equations: 0, inlineMath: 0, tables: 0, figures: 0, citations: 0, crossRefs: 0, references: 0, imageEquations: 0 };

  // ---- Body style: the running text of body paragraphs.
  const bodyBlocks = blocks.filter((b): b is Extract<DocBlock, { kind: "paragraph" }> => b.kind === "paragraph" && b.role === "body");
  const bodyGlyphs = bodyBlocks.flatMap((b) => b.lines.flatMap((l) => l.glyphs)).filter((g) => !g.space && (g.font.role === "text" || (textIsRoman && g.font.role === "roman")) && !g.font.bold && !g.font.italic);
  const bodyFont = mostCommon(bodyGlyphs, (g) => g.font.id)?.font ?? null;
  const bodyStack = bodyFont ? assets.fontStack(bodyFont) : "";
  const bodyLeading = median(bodyBlocks.filter((b) => b.lines.length >= 3).map((b) => b.style.leading)) || bodySize * 1.2;
  const indents = bodyBlocks.map((b) => b.style.indentFirst).filter((v) => v > 1);
  const justified = bodyBlocks.filter((b) => b.lines.length >= 3);
  const body: DocBodyStyle = {
    fontFamily: bodyStack || null,
    fontSize: round(bodySize, 0.5),
    lineHeight: Math.round((bodyLeading / bodySize) * 100) / 100,
    blockSpacing: 0,
    paragraphIndent: indents.length ? round(median(indents), 0.5) : 0,
    color: null,
    justify: justified.length > 0 && justified.filter((b) => b.style.align === "justify").length >= 0.6 * justified.length,
    hyphenate: true,
  };

  // ---- Numbering: caption naming from the first caption of each kind.
  const numbering: NumberingStyle = { ...DEFAULT_NUMBERING, figure: { ...DEFAULT_NUMBERING.figure }, table: { ...DEFAULT_NUMBERING.table } };
  const captions = blocks.filter((b): b is Extract<DocBlock, { kind: "caption" }> => b.kind === "caption");
  for (const kind of ["figure", "table"] as const) {
    const first = captions.find((c) => c.captionKind === kind);
    if (first) numbering[kind] = captionLabelStyle(first.prefix, first.numbering);
  }
  // Numbered within chapters ("Figure 4.6", "(2.1)"): the chapter headings' level starts chapters.
  const chapterNumbered =
    captions.some((c) => /^(?:[A-Z]|\d+)\.\d+$/.test(c.number)) ||
    blocks.some((b) => b.kind === "equation" && /^(?:[A-Z]|\d+)\.\d+$/.test(b.block.number ?? ""));
  if (chapterNumbered) {
    const levels = new Map<number, number>();
    for (const b of blocks) {
      if (b.kind !== "heading" || b.level === 1) continue;
      const text = b.lines.map(lineText).join(" ");
      if (/^(chapter|appendix|part)\s/i.test(text) || /^\d+\.?\s+\p{L}/u.test(text)) levels.set(b.level, (levels.get(b.level) ?? 0) + 1);
    }
    const level = [...levels.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    numbering.chapterLevel = level ?? 2;
  }
  if (captions.length) {
    numbering.captionSeparator = captions[0].separator === ":" ? ":" : ".";
    const labelGlyph = captions[0].lines[0].glyphs.find((g) => !g.space);
    numbering.boldCaptionLabel = !!labelGlyph?.font.bold;
  }

  // ---- Targets and references, before any text is converted.
  const targets = new Map<string, string>();
  const ids = new Map<object, string>();
  let eqCounter = 0;
  for (const b of blocks) {
    if (b.kind === "equation" && b.block.number) {
      const id = `eq-${b.block.number}-${++eqCounter}`;
      ids.set(b, id);
      if (!targets.has(`eq:${b.block.number}`)) targets.set(`eq:${b.block.number}`, id);
    } else if (b.kind === "caption") {
      const n = parseNumeral(b.number);
      const key = `${b.captionKind === "table" ? "tab" : "fig"}:${b.number}`;
      const id = `${b.captionKind}-${n?.n ?? b.number}-${crypto.randomUUID().slice(0, 8)}`;
      ids.set(b, id);
      if (!targets.has(key)) targets.set(key, id);
    }
  }
  const refs = new Map<string, string>();
  const references: BibEntry[] = [];
  const refBlock = blocks.find((b): b is Extract<DocBlock, { kind: "references" }> => b.kind === "references");
  const ctxBase: InlineContext = { bodySize, bodyStack, assets, refs, targets, stats, linkify: false };
  if (refBlock) {
    const baseTime = Date.now();
    refBlock.entries.forEach((e, k) => {
      const items = dropLeadingChars(inlineContent(e.lines, words, links, textIsRoman, rules), `[${e.label}]`.length);
      const printed = segmentsOf(items);
      const id = crypto.randomUUID();
      refs.set(e.label, id);
      const text = printed.map((s) => s.text).join("");
      const parsed = parseReference(text);
      references.push({ id, type: parsed.arxiv && !parsed.DOI ? "article" : "article-journal", ...parsed, printed, printedStyle: "aps", addedAt: baseTime + k });
    });
    stats.references = references.length;
  }

  // ---- Blocks
  const content: JSONContent[] = [];
  let title = "";
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    switch (b.kind) {
      case "heading": {
        // A heading set on several lines on purpose ("CHAPTER 2" / "LITERATURE REVIEW") keeps its
        // line breaks; one that merely wrapped flows as one line.
        const groups: FlowLine[][] = [];
        b.lines.forEach((l, k) => {
          if (k === 0 || (b.breaks ?? []).includes(k - 1)) groups.push([l]);
          else groups[groups.length - 1].push(l);
        });
        const nodes: JSONContent[] = [];
        groups.forEach((g, k) => {
          if (k > 0) nodes.push({ type: "hardBreak" });
          nodes.push(...inlineToJson(inlineContent(g, words, links, textIsRoman, rules), { ...ctxBase, linkify: false }, { baseBold: b.level <= 2 }));
        });
        if (!title && b.level === 1) title = b.lines.map(lineText).join(" ").replace(/\s+/g, " ").trim();
        const attrs = blockAttrs(b.style, b.span, body, twoColumns, "heading", b.lines.length);
        // A section heading's own spacing (LaTeX's \section skips), never less than half a line.
        attrs.spaceBefore = Math.max(Number(attrs.spaceBefore ?? 0), b.level === 1 ? 0 : round(0.9 * bodySize, 0.5));
        attrs.spaceAfter = b.level === 1 ? undefined : round(0.5 * bodySize, 0.5);
        if (attrs.spaceAfter === undefined) delete attrs.spaceAfter;
        content.push({ type: "heading", attrs: { level: Math.min(4, b.level), ...attrs }, content: nodes.length ? nodes : undefined });
        break;
      }
      case "paragraph": {
        const items = inlineContent(b.lines, words, links, textIsRoman, rules);
        const nodes = inlineToJson(items, { ...ctxBase, linkify: b.role === "body" || b.role === "abstract" });
        const attrs = blockAttrs(b.style, b.span, body, twoColumns, "paragraph", b.lines.length);
        content.push({ type: "paragraph", attrs, content: nodes.length ? nodes : undefined });
        stats.paragraphs++;
        break;
      }
      case "caption": {
        const items = dropLeadingChars(inlineContent(b.lines, words, links, textIsRoman, rules), b.labelGlyphCount);
        const nodes = inlineToJson(items, { ...ctxBase, linkify: true });
        const attrs: Record<string, unknown> = { kind: b.captionKind, id: ids.get(b) ?? null };
        if (twoColumns && b.span === "F") attrs.span = "all";
        attrs.textAlign = b.style.align === "justify" ? "justify" : b.style.align === "center" ? "center" : "left";
        attrs.spaceBefore = round(Math.max(2, Math.min(10, b.style.spaceBefore || 4)), 0.5);
        attrs.spaceAfter = b.captionKind === "figure" ? round(0.8 * bodySize, 0.5) : 3;
        content.push({ type: "caption", attrs, content: nodes.length ? nodes : undefined });
        break;
      }
      case "equation": {
        const eq = b.block;
        const result = glyphsToLatex(eq.glyphs, eq.bars);
        const span = twoColumns && eq.span === "F" ? { span: "all" } : {};
        const spacing = { spaceBefore: round(Math.max(3, Math.min(14, b.spaceBefore)), 0.5), spaceAfter: 4 };
        if (validLatex(result.latex, true) && result.confidence >= 0.6) {
          content.push({ type: "mathBlock", attrs: { latex: result.latex, numbered: !!eq.number, id: ids.get(b) ?? null, ...span, ...spacing } });
        } else {
          // Rare: math that can't be rebuilt keeps an exact image, still in its place.
          const img = assets.equation(eq);
          stats.imageEquations++;
          if (img) content.push({ type: "paragraph", attrs: { textAlign: "center", noIndent: true, ...span, ...spacing }, content: [{ type: "image", attrs: { src: img.src, width: Math.round(img.widthPt * PX_PER_PT) } }] });
        }
        stats.equations++;
        break;
      }
      case "figure": {
        const img = assets.figure(b.block);
        if (!img) break;
        const span = twoColumns && b.block.span === "F" ? { span: "all" } : {};
        content.push({
          type: "paragraph",
          attrs: { textAlign: "center", noIndent: true, spaceBefore: round(Math.max(4, Math.min(16, b.spaceBefore)), 0.5), ...span },
          content: [{ type: "image", attrs: { src: img.src, alt: "", width: Math.round(img.widthPt * PX_PER_PT) } }],
        });
        stats.figures++;
        break;
      }
      case "table": {
        content.push(buildTable(b.block, b.spaceBefore, twoColumns, { ...ctxBase, linkify: true }, words, links, textIsRoman, rules));
        stats.tables++;
        break;
      }
      case "toc": {
        content.push(buildTocTable(b.entries, twoColumns && b.span === "F", { ...ctxBase, linkify: false }, words, links, textIsRoman, rules));
        break;
      }
      case "references": {
        content.push({ type: "bibliography", attrs: twoColumns && b.span === "F" ? { span: "all" } : {} });
        break;
      }
    }
  }
  if (content.length === 0) content.push({ type: "paragraph" });

  const layout: DocLayout = { columns: setup.columns, columnGap: setup.gutterIn, body };
  return { doc: { type: "doc", content }, title: title || "Imported PDF", pageSize: setup.pageSize, margins: setup.margins, layout, numbering, references, stats };
}

// A contents list as a rule-less three-column table - label, text, page - drawn with dot leaders
// (docLayout.css, rules "leaders"). Nested entries keep their indent on the label.
function buildTocTable(entries: TocEntryElement[], span: boolean, ctx: InlineContext, words: Map<string, number>, links: LinkArea[], textIsRoman: boolean, rules: PageRule[]): JSONContent {
  const base = Math.min(...entries.map((e) => e.indent));
  const cell = (content: JSONContent[] | undefined, attrs: Record<string, unknown> = {}): JSONContent => ({
    type: "tableCell",
    attrs: { colspan: 1, rowspan: 1, colwidth: null },
    content: [{ type: "paragraph", attrs: { noIndent: true, ...attrs }, content: content?.length ? content : undefined }],
  });
  const rows = entries.map((e) => {
    const text = inlineToJson(inlineContent(e.lines, words, links, textIsRoman, rules), ctx);
    const indent = e.indent - base;
    return {
      type: "tableRow",
      content: [
        cell(e.label ? [{ type: "text", text: e.label }] : undefined, indent > 2 ? { indentLeft: toIn(indent) } : {}),
        cell(text),
        cell([{ type: "text", text: e.pageRef }], { textAlign: "right" }),
      ],
    };
  });
  return { type: "table", attrs: { rules: "leaders", fit: false, ...(span ? { span: "all" } : {}) }, content: rows };
}

function buildTable(t: TableBlock, spaceBefore: number, twoColumns: boolean, ctx: InlineContext, words: Map<string, number>, links: LinkArea[], textIsRoman: boolean, rules: PageRule[]): JSONContent {
  const rowsJson: JSONContent[] = [];
  const ncols = t.columns.length;
  t.rows.forEach((row, r) => {
    const header = r < t.headerRows;
    const cells: JSONContent[] = [];
    let col = 0;
    const sorted = [...row].sort((a, b) => a.colStart - b.colStart);
    for (const cell of sorted) {
      // Empty grid positions before this cell.
      while (col < cell.colStart) {
        cells.push({ type: header ? "tableHeader" : "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", attrs: { noIndent: true } }] });
        col++;
      }
      const span = Math.max(1, cell.colEnd - cell.colStart);
      const lines = cellLines(cell.glyphs, t);
      const items = lines.length ? inlineContent(lines, words, links, textIsRoman, rules) : [];
      const nodes = inlineToJson(items, ctx);
      const align = span > 1 ? "center" : (t.columns[cell.colStart]?.align ?? "left");
      cells.push({
        type: header ? "tableHeader" : "tableCell",
        attrs: { colspan: span, rowspan: 1, colwidth: null },
        content: [{ type: "paragraph", attrs: { textAlign: align, noIndent: true }, content: nodes.length ? nodes : undefined }],
      });
      col = cell.colStart + span;
    }
    while (col < ncols) {
      cells.push({ type: header ? "tableHeader" : "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", attrs: { noIndent: true } }] });
      col++;
    }
    rowsJson.push({ type: "tableRow", content: cells });
  });
  const doubled = t.rules.some((r) => r.double);
  return {
    type: "table",
    attrs: { rules: doubled ? "doubled" : "booktabs", fit: true, ...(twoColumns && t.span === "F" ? { span: "all" } : {}), spaceBefore: round(Math.max(2, Math.min(10, spaceBefore)), 0.5) },
    content: rowsJson,
  };
}
