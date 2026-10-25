// utils/pdfImport/assemble.ts
//
// Page elements in reading order -> the document's blocks. Lines become paragraphs (continuing
// across column and page breaks, split at indents, short last lines, blank space, size changes);
// paragraphs are classified (title, section headings, captions, footnotes, the reference list);
// and every paragraph's glyphs become inline content: styled text runs in the PDF's own fonts and
// sizes, with sub/superscripts and links, and inline math rebuilt as LaTeX.
import type { FontMeta, Glyph } from "./glyphs";
import { isMathAlphanumeric } from "./glyphs";
import { glyphsToLatex } from "./math";
import type { DocBlock, FlowLine, PageElement, ParagraphStyle, Span, TocEntryElement } from "./model";
import type { PageAnalysis } from "./layout";

export interface LinkArea {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  url: string;
}

export type Inline =
  | { kind: "text"; text: string; font: FontMeta; size: number; script: "sup" | "sub" | null; link: string | null }
  | { kind: "math"; latex: string; confidence: number; glyphs: Glyph[] }
  | { kind: "break" };

const MATH_ROLES = new Set(["mathItalic", "boldMathItalic", "symbol", "extension", "blackboard", "fraktur", "unicodeMath"]);
// "FIG. 3.", "TABLE IV.", "Figure 4.6:", "Table A.2." - and then caption text: "Table 2.2 groups
// the sixteen..." is a sentence, "...listed in / Table 4.1." the end of one.
const CAPTION = /^(FIG\.|Fig\.|Figure|FIGURE|TABLE|Table|Tab\.)\s*([IVXLC]+|[A-Z]\.\d+|\d+(?:\.\d+)*)\s*([.:|])(?!\d)(?=\s*\S)/;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const visible = (gs: Glyph[]) => gs.filter((g) => !g.space);

export function lineText(line: FlowLine): string {
  let out = "";
  let lastEnd: number | null = null;
  for (const g of line.glyphs) {
    if (g.space) {
      if (!out.endsWith(" ")) out += " ";
      lastEnd = g.x + g.adv;
      continue;
    }
    if (lastEnd !== null && g.x - lastEnd > 0.18 * g.size && !out.endsWith(" ")) out += " ";
    out += g.ch;
    lastEnd = g.x + g.adv;
  }
  return out.trim();
}

// Bold text, and bold math (CMMIB, CMBX) in a heading like "B. b_μ".
const isBold = (g: Glyph) => g.font.bold || g.font.role === "boldMathItalic";
const majorityBold = (line: FlowLine) => {
  // Judged on the text letters when there are any: in "B. b_μ" the math letter follows math
  // conventions, not the heading's weight.
  const letters = visible(line.glyphs).filter((g) => /\p{L}/u.test(g.ch) && g.size > 0.8 * line.size);
  const textLetters = letters.filter((g) => g.font.role === "text" || g.font.role === "roman");
  const vis = textLetters.length > 0 ? textLetters : letters;
  return vis.length > 0 && vis.filter(isBold).length >= 0.7 * vis.length;
};
const majorityItalic = (line: FlowLine) => {
  const vis = visible(line.glyphs).filter((g) => /\p{L}/u.test(g.ch) && g.font.role === "text");
  return vis.length > 0 && vis.filter((g) => g.font.italic).length >= 0.7 * vis.length;
};
const upperRatio = (text: string) => {
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length === 0 ? 0 : letters.replace(/[^\p{Lu}]/gu, "").length / letters.length;
};

function isCentred(line: FlowLine): boolean {
  const w = line.colX1 - line.colX0;
  const left = line.x0 - line.colX0;
  const right = line.colX1 - line.x1;
  return left > 0.05 * w && Math.abs(left - right) < Math.max(4, 0.03 * w, 0.6 * line.size);
}

// ----------------------------------------------------------------------------------------------
// Paragraph building

const flowKey = (l: { page: number; span: Span }) => `${l.page}:${l.span}`;

function endsSentence(line: FlowLine): boolean {
  return /[.!?:)\]]\s*$/.test(lineText(line));
}

function startsNew(prev: FlowLine, cur: FlowLine, bodySize: number, first?: FlowLine): boolean {
  const curText = lineText(cur);
  // Inside a reference entry ("[3] L. Cong, …" with a hanging indent), every line that doesn't
  // open the next entry continues it.
  if (first && /^\[\d+\]/.test(lineText(first)) && !/^\[\d+\]/.test(curText) && Math.abs(cur.size - prev.size) < 0.5 && cur.base - prev.base < 1.6 * cur.size + (flowKey(prev) === flowKey(cur) ? 0 : 1e6)) return false;
  const prevText = lineText(prev);
  if (CAPTION.test(curText) || /^\[\d+\]\s/.test(curText)) return true;
  if (Math.abs(cur.size - prev.size) > 0.09 * Math.max(cur.size, prev.size)) return true;
  const sameFlow = flowKey(prev) === flowKey(cur);
  // Lines of one style at tight leading continue one block (a title broken over lines, however
  // each line happens to sit), unless the italic changes (affiliation then date).
  const tight = sameFlow && cur.base - prev.base < 1.35 * cur.size;
  if (majorityItalic(cur) !== majorityItalic(prev) && (isCentred(cur) || isCentred(prev))) return true;
  if (tight && majorityBold(cur) === majorityBold(prev) && majorityBold(cur) && !endsSentence(prev)) return false;
  // Lines that keep the paragraph's left edge (a justified block indented on both sides) don't
  // switch between centred and not.
  const sameLeft = Math.abs(cur.x0 - prev.x0) < 1.5;
  const indent = cur.x0 - cur.colX0;
  const prevIndent = prev.x0 - prev.colX0;
  const w = cur.colX1 - cur.colX0;
  if (majorityBold(cur) !== majorityBold(prev) && (isCentred(cur) || curText.length < 80)) return true;
  if (!sameLeft && isCentred(cur) !== isCentred(prev) && (isCentred(cur) || isCentred(prev)) && !(sameFlow && cur.base - prev.base < 1.4 * cur.size && isCentred(prev) && isCentred(cur))) return true;
  if (sameFlow) {
    const leading = cur.base - prev.base;
    if (leading > 1.62 * cur.size) return true;
  }
  // A first-line indent starts a paragraph; a short line before it ends one.
  if (indent > 0.6 * cur.size && indent < 0.25 * w && Math.abs(indent - prevIndent) > 0.4 * cur.size && !isCentred(cur)) return true;
  const prevShort = prev.x1 < prev.colX1 - Math.max(2.2 * prev.size, 0.1 * (prev.colX1 - prev.colX0));
  if (prevShort && !isCentred(prev) && endsSentence(prev)) return true;
  if (!sameFlow && endsSentence(prev) && indent > 0.6 * cur.size) return true;
  void bodySize;
  void prevText;
  return false;
}

// ----------------------------------------------------------------------------------------------
// Inline content

function scriptOf(g: Glyph, lineBase: number, lineSize: number): "sup" | "sub" | null {
  if (g.size > 0.86 * lineSize) return null;
  if (g.base < lineBase - 0.12 * lineSize) return "sup";
  if (g.base > lineBase + 0.06 * lineSize) return "sub";
  return null;
}

function linkAt(g: Glyph, page: number, links: LinkArea[]): string | null {
  const cx = g.x + g.adv / 2;
  const cy = (g.top + g.bottom) / 2;
  const hit = links.find((l) => l.page === page && cx >= l.x0 - 0.5 && cx <= l.x1 + 0.5 && cy >= l.y0 - 1 && cy <= l.y1 + 1);
  return hit?.url ?? null;
}

// Words seen whole in the document - the evidence for undoing TeX's end-of-line hyphenation.
export function wordCounts(lines: FlowLine[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of lines) {
    for (const w of lineText(l).toLowerCase().split(/[^\p{L}-]+/u)) {
      if (w.length < 3) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return counts;
}

interface GlyphStreamItem {
  g: Glyph;
  line: FlowLine;
  // A space to emit before this glyph (inter-word, or a line join).
  spaceBefore: boolean;
}

function streamOf(lines: FlowLine[], words: Map<string, number>): GlyphStreamItem[] {
  const out: GlyphStreamItem[] = [];
  // When a line ends in a hyphenated word, the next line's first glyph attaches with no space.
  let attachNext = false;
  lines.forEach((line, li) => {
    let lastEnd: number | null = null;
    let pendingSpace = li > 0 && !attachNext;
    attachNext = false;
    for (const g of line.glyphs) {
      if (g.space) {
        pendingSpace = out.length > 0;
        lastEnd = g.x + g.adv;
        continue;
      }
      if (lastEnd !== null && g.x - lastEnd > 0.18 * g.size) pendingSpace = true;
      out.push({ g, line, spaceBefore: pendingSpace });
      pendingSpace = false;
      lastEnd = g.x + g.adv;
    }
    // End-of-line hyphenation: TeX's discretionary "non-|relativistic" loses its hyphen; a real
    // compound "spin-|dependent" keeps it. The rest of the document decides which this is.
    const next = lines[li + 1];
    const last = out[out.length - 1];
    const nextFirst = next?.glyphs.find((g) => !g.space);
    // A line ending in a dash or a hyphen before a digit/capital joins the next with no space
    // ("matter–|antimatter", "spin-|1").
    if (next && last && last.line === line && /^[–—/]$/.test(last.g.ch)) attachNext = true;
    if (next && last && last.line === line && last.g.ch === "-" && last.g.font.role === "text" && nextFirst && !/\p{Ll}/u.test(nextFirst.ch)) attachNext = true;
    if (next && last && last.line === line && last.g.ch === "-" && last.g.font.role === "text" && nextFirst && /\p{Ll}/u.test(nextFirst.ch)) {
      const tail: string[] = [];
      for (let k = out.length - 2; k >= 0 && out[k].line === line && /\p{L}/u.test(out[k].g.ch); k--) {
        tail.unshift(out[k].g.ch);
        if (out[k].spaceBefore) break;
      }
      const head: string[] = [];
      for (const g of next.glyphs) {
        if (g.space || !/\p{L}/u.test(g.ch)) break;
        head.push(g.ch);
      }
      const left = tail.join("").toLowerCase();
      const right = head.join("").toLowerCase();
      // Evidence first (either form written whole elsewhere); otherwise a compound's halves are
      // words of their own ("spin-based"), a discretionary break's are not ("approxi-mately").
      const asCompound = words.get(`${left}-${right}`) ?? 0;
      const asWord = words.get(left + right) ?? 0;
      const keepHyphen = asCompound > asWord || (asCompound === asWord && (words.get(left) ?? 0) > 0 && (words.get(right) ?? 0) > 0 && left.length > 2);
      if (!keepHyphen) out.pop();
      attachNext = true;
    }
  });
  return out;
}

function isMathGlyph(item: GlyphStreamItem, textIsRoman: boolean): boolean {
  const g = item.g;
  if (MATH_ROLES.has(g.font.role) || isMathAlphanumeric(g.ch)) return true;
  if (g.font.role === "roman" && !textIsRoman) return true;
  return false;
}

export interface PageRule {
  page: number;
  x0: number;
  x1: number;
  y: number;
  thickness: number;
}

export function inlineContent(lines: FlowLine[], words: Map<string, number>, links: LinkArea[], textIsRoman: boolean, rules: PageRule[] = []): Inline[] {
  const stream = streamOf(lines, words);
  const out: Inline[] = [];
  let i = 0;
  const lineSize = (l: FlowLine) => l.size;
  while (i < stream.length) {
    const item = stream[i];
    if (isMathGlyph(item, textIsRoman) || (scriptOf(item.g, item.line.base, lineSize(item.line)) && MATH_ROLES.has(stream[i - 1]?.g.font.role ?? ""))) {
      // A math span: math glyphs, their scripts, and text-font glyphs wedged between math glyphs
      // with no space (digits and parentheses in math are often set in the text font).
      let j = i;
      const glyphs: Glyph[] = [];
      while (j < stream.length) {
        const it = stream[j];
        const math = isMathGlyph(it, textIsRoman);
        const script = scriptOf(it.g, it.line.base, lineSize(it.line)) !== null;
        if (j > i && it.line !== stream[j - 1].line) break;
        if (math || (script && glyphs.length > 0)) {
          glyphs.push(it.g);
          j++;
          continue;
        }
        // Text glyph: part of the span only when attached on both sides.
        const next = stream[j + 1];
        if (!it.spaceBefore && next && !next.spaceBefore && isMathGlyph(next, textIsRoman) && /^[0-9()[\]=+,]$/.test(it.g.ch)) {
          glyphs.push(it.g);
          j++;
          continue;
        }
        break;
      }
      // Trailing punctuation belongs to the sentence, not the formula.
      while (glyphs.length > 1 && /^[,.;:]$/.test(glyphs[glyphs.length - 1].ch) && glyphs[glyphs.length - 1].font.role === "text") {
        glyphs.pop();
        j--;
      }
      if (item.spaceBefore && out.length) appendText(out, " ", item);
      // Bars of inline fractions (½ in running text) that lie within the span.
      const page = item.line.page;
      const sx0 = Math.min(...glyphs.map((g) => g.x));
      const sx1 = Math.max(...glyphs.map((g) => g.x + g.adv));
      const sy0 = Math.min(...glyphs.map((g) => g.top));
      const sy1 = Math.max(...glyphs.map((g) => g.bottom));
      const bars = rules.filter((r) => r.page === page && r.x0 >= sx0 - 1 && r.x1 <= sx1 + 1 && r.y > sy0 && r.y < sy1);
      const result = glyphsToLatex(glyphs, bars);
      const raisedMarker = glyphs.length === 1 && /^[∗*†‡§¶]$/.test(glyphs[0].ch) && scriptOf(glyphs[0], item.line.base, lineSize(item.line)) === "sup";
      if (raisedMarker || /^[0-9]+([.,][0-9]+)?$/.test(result.latex)) {
        // A footnote mark, or a bare number set in math digits: plain text in the original font.
        for (const g of glyphs) appendText(out, g.ch, stream.find((s) => s.g === g)!, raisedMarker ? "sup" : null);
      } else out.push({ kind: "math", latex: result.latex, confidence: result.confidence, glyphs });
      i = j;
      continue;
    }
    // No space between a formula and the punctuation after it ("$d_{\mu\nu}$,"): the gap there is
    // the formula's italic correction, not a word space.
    const punctAfterMath = /^[,.;:)\]]$/.test(item.g.ch) && out[out.length - 1]?.kind === "math";
    if (item.spaceBefore && out.length && !punctAfterMath) appendText(out, " ", item);
    const script = scriptOf(item.g, item.line.base, lineSize(item.line));
    appendText(out, item.g.ch, item, script, linkAt(item.g, item.line.page, links));
    i++;
  }
  return mergeRuns(out);
}

function appendText(out: Inline[], text: string, item: GlyphStreamItem, script: "sup" | "sub" | null = null, link: string | null = null): void {
  const g = item.g;
  const last = out[out.length - 1];
  // A space takes the style of the text before it.
  if (text === " " && last && last.kind === "text") {
    if (last.script) out.push({ kind: "text", text: " ", font: last.font, size: item.line.size, script: null, link: null });
    else last.text += " ";
    return;
  }
  const size = script ? item.line.size : Math.round(g.size * 2) / 2;
  if (last && last.kind === "text" && last.font.id === g.font.id && last.script === script && last.link === link && Math.abs(last.size - size) < 0.3) last.text += text;
  else out.push({ kind: "text", text, font: g.font, size, script, link });
}

function mergeRuns(items: Inline[]): Inline[] {
  // NFKC for ligatures only (ﬁ ﬂ ﬀ ﬃ ﬄ) - full NFKC would also flatten superscript digits etc.
  return items.map((it) => (it.kind === "text" ? { ...it, text: it.text.replace(/[ﬀ-ﬆ]/g, (c) => c.normalize("NFKC")) } : it));
}

// ----------------------------------------------------------------------------------------------
// Paragraph style

function styleOf(lines: FlowLine[], spaceBefore: number): ParagraphStyle {
  const first = lines[0];
  const size = median(lines.map((l) => l.size));
  const leadings: number[] = [];
  for (let k = 1; k < lines.length; k++) if (flowKey(lines[k]) === flowKey(lines[k - 1])) leadings.push(lines[k].base - lines[k - 1].base);
  const leading = leadings.length ? median(leadings) : size * 1.2;
  // Centred text is ragged on both sides; a justified block indented equally on both sides is not.
  const lefts = lines.map((l) => l.x0);
  const ragged = Math.max(...lefts) - Math.min(...lefts) > 2;
  // Centred: every line has equal margins both sides; several lines must also be ragged (a
  // justified block indented equally on both sides is not centred).
  const symmetric = (l: FlowLine) => Math.abs(l.x0 - l.colX0 - (l.colX1 - l.x1)) < Math.max(4, 0.6 * l.size);
  const centred = lines.length === 1 ? isCentred(lines[0]) : ragged && lines.every(symmetric);
  const inner = lines.length >= 2 ? lines.slice(0, -1) : lines;
  // Justified: every line but the last reaches its column's text edge (or the paragraph's own,
  // when it is indented on both sides like an abstract). Judged per line, since a paragraph can
  // run from one column into the next.
  const restLeft = lines.length > 1 ? median(lines.slice(1).map((l) => l.x0 - l.colX0)) : first.x0 - first.colX0;
  const indented = restLeft > 2;
  const tol = Math.max(2.5, 0.3 * first.size);
  const edgeFor = (l: FlowLine) => (indented ? l.colX1 - restLeft : l.colX1);
  const justified = lines.length >= 2 && inner.every((l) => l.x1 >= edgeFor(l) - tol);
  const widest = Math.max(...lines.map((l) => l.x1 - l.colX1));
  const rightMargins = indented && -widest >= restLeft - tol ? restLeft : 0;
  // Left indent of the paragraph body (a one-line paragraph has only a first-line indent).
  const restX0 = lines.length > 1 ? restLeft : 0;
  return {
    align: centred ? "center" : justified ? "justify" : "left",
    indentFirst: centred ? 0 : Math.round((first.x0 - first.colX0 - restX0) * 10) / 10,
    indentLeft: centred ? 0 : Math.max(0, Math.round(restX0 * 10) / 10),
    indentRight: centred ? 0 : Math.max(0, Math.round(rightMargins * 10) / 10),
    spaceBefore: Math.max(0, Math.round(spaceBefore * 10) / 10),
    size,
    leading,
  };
}

// ----------------------------------------------------------------------------------------------
// Contents-style lists (table of contents, list of figures / tables)
//
// An entry ends on a line that runs out in leader dots to a page number at the margin; it starts
// on the line that opens with its label ("4.1", "A.2", "III."), and lines between continue its
// text under a hanging indent. Read as ordinary text these lists fall apart - the hanging indent
// looks like a new paragraph and the page numbers run into the next entry - so they are taken
// out of the flow first and rebuilt as entries.

// Leader dots: full stops in LaTeX and most tools; middle dots and ellipses in some.
const LEADER_DOT = /^[.·⋅∙‧…]$/;
const LABEL = /^(?:(?:[A-Z]\.)?\d+(?:\.\d+)*\.?|[IVXLC]+\.|[A-Z]\.?)$/;

// The label at the start of a line - its glyphs and where the text after it begins - if the line
// opens with one followed by a gap. Only ever asked of lines already known to be in a contents
// list, so a word-sized gap is enough: LaTeX lets a wide label ("4.10") push its text right until
// only a word space is left. Measured on the glyphs - a PDF often has no space character there.
function splitLabel(line: FlowLine): { label: string; count: number; textX: number } | null {
  const gs = line.glyphs;
  let i = 0;
  while (i < gs.length && gs[i].space) i++;
  let label = "";
  let end = -Infinity;
  for (; i < gs.length; i++) {
    const g = gs[i];
    if (g.space) break;
    if (label && g.x - end > 0.25 * line.size) break;
    label += g.ch;
    end = g.x + g.adv;
  }
  let j = i;
  while (j < gs.length && gs[j].space) j++;
  if (!label || j >= gs.length || !LABEL.test(label)) return null;
  if (gs[j].x - end < 0.2 * line.size) return null;
  return { label, count: j, textX: gs[j].x };
}

// The leader line's text glyphs: the page number and the dots before it taken off, but not a
// full stop set tight against the last word ("ten.").
function stripLeader(line: FlowLine): { glyphs: FlowLine["glyphs"]; pageRef: string } | null {
  const gs = [...line.glyphs];
  let k = gs.length - 1;
  while (k >= 0 && gs[k].space) k--;
  let page = "";
  while (k >= 0 && !gs[k].space && /[0-9ivxlcdm]/i.test(gs[k].ch)) page = gs[k--].ch + page;
  if (!page) return null;
  let dots = 0;
  for (;;) {
    while (k >= 0 && gs[k].space) k--;
    if (k < 0 || !LEADER_DOT.test(gs[k].ch)) break;
    const prev = gs[k - 1];
    // A dot attached to a letter or digit (no space, no gap) ends the sentence: keep it.
    if (prev && !prev.space && !LEADER_DOT.test(prev.ch) && gs[k].x - (prev.x + prev.adv) < 0.12 * line.size) break;
    k--;
    dots++;
  }
  while (k >= 0 && gs[k].space) k--;
  // Three leader dots or more - or, where the text all but fills the line, fewer or none, as long
  // as the page number stands apart at the column's right edge.
  if (dots < 3) {
    const numberStart = Math.min(...gs.slice(k + 1).filter((g) => !g.space && /[0-9ivxlcdm]/i.test(g.ch)).map((g) => g.x));
    const textEnd = k >= 0 ? gs[k].x + gs[k].adv : -Infinity;
    const flushRight = line.colX1 - line.x1 < 2;
    if (!flushRight || numberStart - textEnd < 0.9 * line.size) return null;
  }
  return { glyphs: gs.slice(0, k + 1), pageRef: page };
}

function lineFrom(line: FlowLine, glyphs: FlowLine["glyphs"]): FlowLine {
  const vis = glyphs.filter((g) => !g.space);
  if (vis.length === 0) return { ...line, glyphs };
  return { ...line, glyphs, x0: Math.min(...vis.map((g) => g.x)), x1: Math.max(...vis.map((g) => g.x + g.adv)) };
}

export function extractTocEntries(pages: PageAnalysis[]): void {
  let pending: { page: PageAnalysis; el: Extract<PageElement, { kind: "line" }> }[] = [];
  for (const page of pages) {
    const out: PageElement[] = [];
    for (const el of page.elements) {
      if (el.kind !== "line") {
        pending = [];
        out.push(el);
        continue;
      }
      const text = lineText(el.line);
      const tail = /(\d+|[ivxlcdm]+)\s*$/i.test(text) ? stripLeader(el.line) : null;
      if (!tail) {
        pending.push({ page, el });
        if (pending.length > 12) pending.shift();
        out.push(el);
        continue;
      }
      // Walk back to the entry's first line: continuation lines share the last line's left
      // edge; the first line opens with the label.
      const own = splitLabel(el.line);
      const members: { page: PageAnalysis; el: Extract<PageElement, { kind: "line" }> }[] = [];
      if (!own) {
        for (let j = pending.length - 1; j >= 0; j--) {
          const p = pending[j];
          if (Math.abs(p.el.line.size - el.line.size) > 0.1 * el.line.size) break;
          const lab = splitLabel(p.el.line);
          // The first line starts left of the hanging indent the rest of the entry keeps.
          if (lab && p.el.line.x0 < el.line.x0 - 2) {
            members.unshift(p);
            break;
          }
          if (Math.abs(p.el.line.x0 - el.line.x0) < 2.5 && !lab) {
            members.unshift(p);
            continue;
          }
          break;
        }
        // Unlabelled entries ("Abstract . . . ii") stand alone unless a labelled first line was found.
        if (members.length && !splitLabel(members[0].el.line)) members.length = 0;
      }
      const first = members[0]?.el.line ?? el.line;
      const lab = splitLabel(first);
      const lines: FlowLine[] = [];
      [...members.map((m) => m.el.line), el.line].forEach((ln, idx, arr) => {
        let glyphs = ln.glyphs;
        if (idx === arr.length - 1) glyphs = tail.glyphs;
        if (idx === 0 && lab) glyphs = glyphs.slice(lab.count);
        if (glyphs.some((g) => !g.space)) lines.push(lineFrom(ln, glyphs));
      });
      // Take the member lines back out of this page's output (and the previous page's, for an
      // entry that began there).
      for (const m of members) {
        const list = m.page === page ? out : m.page.elements;
        const at = list.indexOf(m.el);
        if (at >= 0) list.splice(at, 1);
      }
      pending = [];
      const entryPage = members[0]?.page ?? page;
      const entry: TocEntryElement = {
        kind: "tocEntry",
        page: entryPage.page,
        span: el.span,
        label: lab?.label ?? "",
        lines,
        pageRef: tail.pageRef,
        indent: Math.max(0, first.x0 - first.colX0),
        textIndent: lab ? Math.max(0, lab.textX - first.x0) : 0,
        y0: members[0]?.el.y0 ?? el.y0,
        y1: el.y1,
      };
      if (entryPage === page) out.push(entry);
      else entryPage.elements.push(entry);
    }
    page.elements = out;
  }
}

// ----------------------------------------------------------------------------------------------
// The whole document

export interface AssembledDoc {
  blocks: DocBlock[];
  inline: Map<FlowLine[], Inline[]>;
  bodySize: number;
}

export function assemble(pages: PageAnalysis[]): { blocks: DocBlock[]; bodySize: number; allLines: FlowLine[] } {
  extractTocEntries(pages);
  const bodySize = median(pages.map((p) => p.bodySize));
  const blocks: DocBlock[] = [];
  let para: FlowLine[] = [];
  let paraSpace = 0;
  let lastBottom: { key: string; base: number; bottom: number; size: number } | null = null;
  const allLines: FlowLine[] = [];

  const spaceFrom = (key: string, base: number, size: number): number => {
    if (!lastBottom || lastBottom.key !== key) return 0;
    // Extra space beyond normal leading, in pt.
    return base - lastBottom.base - 1.2 * size;
  };
  // Footnotes step aside: the paragraph they interrupt continues in the next column, and they
  // follow it once it ends.
  let notes: FlowLine[][] = [];
  const flush = () => {
    if (para.length > 0) blocks.push(classify(para, paraSpace, bodySize, blocks));
    para = [];
    for (const n of notes) blocks.push(classify(n, 6, bodySize, blocks));
    notes = [];
  };

  for (const page of pages) {
    for (const el of page.elements) {
      if (el.kind === "line") {
        const line = el.line;
        allLines.push(line);
        const isNote =
          line.size < 0.9 * bodySize &&
          line.top > 0.75 * page.height &&
          (notes.length > 0 || !lastBottom || lastBottom.key !== flowKey(line) || line.top - lastBottom.bottom > 1.2 * bodySize);
        if (isNote) {
          const open = notes[notes.length - 1];
          const prevNote = open?.[open.length - 1];
          if (prevNote && line.base - prevNote.base < 1.35 * line.size && !/^[∗*†‡§¶\d]/.test(lineText(line))) open.push(line);
          else notes.push([line]);
          continue;
        }
        const prev = para[para.length - 1];
        if (prev && startsNew(prev, line, bodySize, para[0])) flush();
        if (para.length === 0) paraSpace = spaceFrom(flowKey(line), line.base, line.size);
        para.push(line);
        lastBottom = { key: flowKey(line), base: line.base, bottom: line.bottom, size: line.size };
        continue;
      }
      flush();
      if (el.kind === "tocEntry") {
        allLines.push(...el.lines);
        const last = blocks[blocks.length - 1];
        if (last?.kind === "toc") last.entries.push(el);
        else blocks.push({ kind: "toc", entries: [el], span: el.span });
        lastBottom = { key: `${el.page}:${el.span}`, base: el.y1, bottom: el.y1, size: bodySize };
        continue;
      }
      const key = `${el.page}:${el.span}`;
      const space = lastBottom && lastBottom.key === key ? el.y0 - lastBottom.bottom : 0;
      if (el.kind === "equation") blocks.push({ kind: "equation", block: el, spaceBefore: space });
      else if (el.kind === "figure") blocks.push({ kind: "figure", block: el, spaceBefore: space });
      else if (el.kind === "table") blocks.push({ kind: "table", block: el, spaceBefore: space });
      // Text after a display continues at normal leading from the display's last line.
      lastBottom = { key, base: el.y1, bottom: el.y1, size: bodySize };
    }
  }
  flush();
  return { blocks: groupReferences(joinChapterHeadings(blocks)), bodySize, allLines };
}

function classify(lines: FlowLine[], spaceBefore: number, bodySize: number, before: DocBlock[]): DocBlock {
  const text = lines.map(lineText).join(" ");
  const style = styleOf(lines, spaceBefore);
  const span = lines[0].span;
  const cap = text.match(CAPTION);
  if (cap) {
    const prefix = cap[1];
    const kind = /^t/i.test(prefix) ? "table" : "figure";
    const numbering = /^[IVXLC]+$/.test(cap[2]) ? "roman" : "arabic";
    const labelLength = cap[0].replace(/\s+/g, "").length;
    return { kind: "caption", captionKind: kind, prefix, numbering, number: cap[2], separator: cap[3], lines, style, span, labelGlyphCount: labelLength };
  }
  const page = lines[0].page;
  const short = lines.length <= 3 && text.length < 160;
  const bigger = style.size >= 1.15 * bodySize;
  // Front matter ends at the first section heading (the title doesn't count).
  const firstHeadingSeen = before.some((b) => b.kind === "heading" && b.level > 1);
  // The title: the first large text on page 1 (titles run long - up to four lines).
  if (bigger && page === 1 && !firstHeadingSeen && lines.length <= 4 && text.length < 320) return { kind: "heading", level: 1, lines, style, span };
  const bold = lines.every(majorityBold);
  const caps = upperRatio(text) > 0.85 && /\p{L}{3}/u.test(text);
  // Not headings, however bold or short: a line of maths (bold vectors make it look bold), a row
  // of a table spread across the page, or a line opening with a bare 0 ("0 Gap").
  // A section title that is maths ("D. d_μν") still opens with its section label.
  const labelled = /^((?:[IVXLC]+|[A-Z]|\d+(?:\.\d+)*)\.?)\s+\S/.test(text);
  const notHeading = lines.some((l) => (mathShare(l) > 0.35 && !labelled) || widestGap(l) > 2.5 * l.size) || /^0\s/.test(text);
  const sectionNumber = text.match(/^((?:[IVXLC]+|[A-Z]|\d+(?:\.\d+)*)\.?)\s+\S/);
  if (short && !notHeading && !/[.:;,]$/.test(text.trim()) && (bold || caps || bigger) && text.length < 120) {
    let level: 2 | 3 | 4 = 2;
    if (sectionNumber) {
      const n = sectionNumber[1];
      if (/^\d+\.\d+\.\d+/.test(n)) level = 4;
      else if (/^\d+\.\d+/.test(n) || (/^[A-Z]\.?$/.test(n) && !/^[IVX]\.?$/.test(n))) level = 3;
      else level = 2;
    } else if (!caps && !bigger) level = 3;
    return { kind: "heading", level, lines, style, span };
  }
  const small = style.size < 0.92 * bodySize;
  const role = page === 1 && !firstHeadingSeen ? (style.align === "center" ? "front" : small ? "abstract" : "front") : small && lines[0].top > 0.75 * 792 ? "footnote" : "body";
  return { kind: "paragraph", lines, style, span, role };
}

// Share of a line's visible glyphs set in maths.
function mathShare(line: FlowLine): number {
  const vis = visible(line.glyphs);
  if (vis.length === 0) return 0;
  return vis.filter((g) => MATH_ROLES.has(g.font.role) || isMathAlphanumeric(g.ch)).length / vis.length;
}

// The widest gap between neighbouring glyphs of a line (table cells sit far apart).
function widestGap(line: FlowLine): number {
  const vis = [...visible(line.glyphs)].sort((a, b) => a.x - b.x);
  let gap = 0;
  for (let i = 1; i < vis.length; i++) gap = Math.max(gap, vis[i].x - (vis[i - 1].x + vis[i - 1].adv));
  return gap;
}

// A chapter heading set on two lines - "CHAPTER 2" over "LITERATURE REVIEW", "APPENDIX A" over
// its title - is one heading with a line break, not two.
function joinChapterHeadings(blocks: DocBlock[]): DocBlock[] {
  const out: DocBlock[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (
      b.kind === "heading" &&
      prev?.kind === "heading" &&
      prev.level === b.level &&
      prev.lines.length === 1 &&
      /^(CHAPTER|Chapter|PART|Part|APPENDIX|Appendix)\s+\S+$/.test(lineText(prev.lines[0])) &&
      b.lines[0].page === prev.lines[0].page &&
      b.lines[0].base - prev.lines[prev.lines.length - 1].base < 3.5 * b.style.size
    ) {
      out[out.length - 1] = { ...prev, lines: [...prev.lines, ...b.lines], breaks: [...(prev.breaks ?? []), prev.lines.length - 1] };
      continue;
    }
    out.push(b);
  }
  return out;
}

// Runs of paragraphs that start with [1], [2], ... are the reference list.
function groupReferences(blocks: DocBlock[]): DocBlock[] {
  const out: DocBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const label = b.kind === "paragraph" ? lineText(b.lines[0]).match(/^\[(\d+)\]/) : null;
    if (!label) {
      out.push(b);
      continue;
    }
    const entries: { label: string; lines: FlowLine[] }[] = [];
    let j = i;
    while (j < blocks.length) {
      const c = blocks[j];
      const m = c.kind === "paragraph" ? lineText(c.lines[0]).match(/^\[(\d+)\]/) : null;
      if (!m || c.kind !== "paragraph") break;
      entries.push({ label: m[1], lines: c.lines });
      j++;
    }
    if (entries.length >= 3) {
      const first = blocks[i] as Extract<DocBlock, { kind: "paragraph" }>;
      out.push({ kind: "references", entries, style: first.style, span: first.span });
      i = j - 1;
    } else out.push(b);
  }
  return out;
}

export type { PageElement };
