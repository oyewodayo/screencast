// utils/pdfImport/layout.ts
//
// One page of a PDF -> its content in reading order: text lines, display equations, tables and
// figures, each tagged with the column it belongs to (left, right, or spanning the page). The
// analysis is geometric and typographic, not tied to one producer: columns from where line
// segments never cross, equations from math fonts, centring and numbers at the margin, tables from
// cells that line up row after row, figures from ink that no glyph explains.
import type { Glyph } from "./glyphs";
import { isMathAlphanumeric } from "./glyphs";
import { buildSegments, segmentText, type Segment } from "./lines";
import { graphicsComponents, horizontalRules, inkBox, isInk, type Box, type InkComponent, type Raster } from "./ink";
import type { EquationBlock, FigureBlock, FlowLine, LineBlock, PageElement, Span, TableBlock, TableCellModel } from "./model";

export interface ColumnModel {
  twoColumn: boolean;
  gutter: number; // x of the gutter centre (two-column) or page centre
  left: [number, number];
  right: [number, number];
  full: [number, number];
}

export interface PageAnalysis {
  page: number;
  width: number;
  height: number;
  columns: ColumnModel;
  elements: PageElement[];
  bodySize: number;
  // Text that sat in the top/bottom margins (page numbers, running heads) - removed from the
  // flow, kept so the document pass can recognise headers repeated across pages.
  marginal: { text: string; top: boolean }[];
  // Horizontal rules on the page (fraction bars of inline math are among them).
  rules: { x0: number; x1: number; y: number; thickness: number }[];
}

const MATH_ROLES = new Set(["mathItalic", "boldMathItalic", "symbol", "extension", "blackboard", "fraktur", "unicodeMath"]);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

const visibleGlyphs = (gs: Glyph[]) => gs.filter((g) => !g.space);

export function detectColumns(segs: Segment[], width: number): ColumnModel {
  // Columns are read from prose: equation numbers at the margin and pieces of displayed maths sit
  // beside each other too, and on a single-column page full of equations they'd fake a gutter.
  const textual = segs.filter(
    (s) => visibleGlyphs(s.glyphs).length >= 4 && !EQ_NUMBER.test(segmentText(s).trim()) && mathFraction(s.glyphs, false) < 0.5
  );
  const full: [number, number] = [percentile(textual.map((s) => s.x0), 0.03), percentile(textual.map((s) => s.x1), 0.97)];
  let bestX = width / 2;
  let bestCross = Infinity;
  for (let x = Math.round(width * 0.3); x <= width * 0.7; x += 1) {
    const cross = textual.filter((s) => s.x0 < x - 1.5 && s.x1 > x + 1.5).length;
    if (cross < bestCross || (cross === bestCross && Math.abs(x - width / 2) < Math.abs(bestX - width / 2))) {
      bestCross = cross;
      bestX = x;
    }
  }
  const left = textual.filter((s) => s.x1 <= bestX + 1.5);
  const right = textual.filter((s) => s.x0 >= bestX - 1.5);
  // Two columns show as lines side by side: a left-column line with a right-column line at about
  // the same height. Counting crossings alone fails on a first page whose title and abstract run
  // full width above the columns.
  const sideBySide = left.filter((l) => right.some((r) => Math.abs(r.base - l.base) < 1.6 * l.size)).length;
  // ...and real columns hold lines of running text on both sides.
  const lines = (list: Segment[]) => list.filter((s) => s.x1 - s.x0 > 0.25 * width).length;
  const twoColumn =
    left.length >= 5 && right.length >= 5 && sideBySide >= Math.min(5, 0.4 * Math.min(left.length, right.length)) && lines(left) >= 3 && lines(right) >= 3;
  if (!twoColumn) return { twoColumn: false, gutter: width / 2, left: full, right: full, full };
  // Column edges from substantial lines only: short pieces (equation fragments, a heading, a
  // paragraph's last line) don't mark where the column ends.
  const long = (list: Segment[]) => {
    const maxW = Math.max(...list.map((s) => s.x1 - s.x0));
    const l = list.filter((s) => s.x1 - s.x0 > 0.7 * maxW);
    return l.length >= 3 ? l : list;
  };
  const leftLong = long(left);
  const rightLong = long(right);
  const leftCol: [number, number] = [percentile(leftLong.map((s) => s.x0), 0.1), percentile(leftLong.map((s) => s.x1), 0.9)];
  const rightCol: [number, number] = [percentile(rightLong.map((s) => s.x0), 0.1), percentile(rightLong.map((s) => s.x1), 0.9)];
  return { twoColumn: true, gutter: (leftCol[1] + rightCol[0]) / 2, left: leftCol, right: rightCol, full: [Math.min(leftCol[0], full[0]), Math.max(rightCol[1], full[1])] };
}

function spanOf(box: { x0: number; x1: number }, cols: ColumnModel): Span {
  if (!cols.twoColumn) return "F";
  if (box.x1 <= cols.gutter + 2) return "L";
  if (box.x0 >= cols.gutter - 2) return "R";
  return "F";
}

function spanBounds(span: Span, cols: ColumnModel): [number, number] {
  return span === "L" ? cols.left : span === "R" ? cols.right : cols.full;
}

const overlaps = (a: Box, b: Box, pad = 0) => a.x0 - pad < b.x1 && b.x0 - pad < a.x1 && a.y0 - pad < b.y1 && b.y0 - pad < a.y1;
const segBox = (s: Segment): Box => ({ x0: s.x0, y0: s.top, x1: s.x1, y1: s.bottom });

const CAPTION_START = /^(FIG\.|Fig\.|Figure|FIGURE|TABLE|Table|Tab\.)\s*([IVXLC]+|\d+)\s*[.:|]/;
// An equation number: (12), (12a), (A3), within chapters (2.7), (4.12a), appendices (A.3).
const EQ_NUM_CORE = String.raw`(?:\d+[a-z]?|[A-Z]\.?\d+(?:\.\d+)?[a-z]?|\d+\.\d+[a-z]?)`;
const EQ_NUMBER = new RegExp(String.raw`^\((${EQ_NUM_CORE})\)$`);
const EQ_NUMBER_TAIL = new RegExp(String.raw`\(${EQ_NUM_CORE}\)\s*$`);
const EQ_REF_TAIL = new RegExp(String.raw`(Eqs?\.|Ref\.|Refs\.|Fig\.|Sec\.)\s*\(${EQ_NUM_CORE}\)\s*$`);

function mathFraction(glyphs: Glyph[], textIsRoman: boolean): number {
  const vis = visibleGlyphs(glyphs);
  if (vis.length === 0) return 0;
  const math = vis.filter((g) => MATH_ROLES.has(g.font.role) || isMathAlphanumeric(g.ch) || (!textIsRoman && g.font.role === "roman")).length;
  return math / vis.length;
}

export function analysePage(pageNo: number, width: number, height: number, glyphs: Glyph[], raster: Raster | null, textIsRoman: boolean): PageAnalysis {
  let segs = buildSegments(glyphs);
  const bodySize = (() => {
    const counts = new Map<number, number>();
    for (const s of segs) {
      const n = visibleGlyphs(s.glyphs).length;
      const k = Math.round(s.size * 2) / 2;
      counts.set(k, (counts.get(k) ?? 0) + n);
    }
    let best = 10;
    let bestN = -1;
    for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n];
    return best;
  })();

  // Page numbers and running heads: short text alone in the top or bottom margin band.
  const textTop = percentile(segs.map((s) => s.top), 0.02);
  const marginal: PageAnalysis["marginal"] = [];
  segs = segs.filter((s) => {
    const text = segmentText(s).trim();
    const inTop = s.bottom < height * 0.075 && s.top <= textTop + 2;
    const inBottom = s.top > height * 0.93;
    const pageNumberLike = /^[-–—\s]*(\d{1,4}|[ivxlc]{1,6}|page \d+( of \d+)?)[-–—\s]*$/i.test(text);
    if ((inTop || inBottom) && (pageNumberLike || text.length < 90)) {
      const otherNear = segs.some((o) => o !== s && Math.abs(o.base - s.base) < 2 && !/^\d+$/.test(segmentText(o).trim()));
      if (pageNumberLike || !otherNear) {
        marginal.push({ text, top: inTop });
        return false;
      }
    }
    return true;
  });

  const cols = detectColumns(segs, width);
  const consumed = new Set<Segment>();
  const elements: PageElement[] = [];

  // --------------------------------------------------------------------------------------------
  // Figures: graphics ink, plus the labels drawn around and inside it.
  const comps: InkComponent[] = raster ? graphicsComponents(raster, glyphs) : [];
  let figBoxes: Box[] = comps.filter((c) => c.kind === "figure").map((c) => ({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }));
  // Merge pieces of one figure (panels, colour bars, legends).
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < figBoxes.length; i++) {
      for (let j = i + 1; j < figBoxes.length; j++) {
        const a = figBoxes[i];
        const b = figBoxes[j];
        const vOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        const near = overlaps(a, b, 10) || (vOverlap > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0) && Math.max(a.x0 - b.x1, b.x0 - a.x1) < 40 && spanOf(a, cols) === spanOf(b, cols));
        if (near) {
          figBoxes[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          figBoxes = figBoxes.filter((_, k) => k !== j);
          changed = true;
          break outer;
        }
      }
    }
  }
  for (const fig of figBoxes) {
    const box = { ...fig };
    // Rotated glyphs (axis titles) never form lines; pull them in directly.
    for (const g of glyphs) if (g.adv === 0 && g.space && !/\s/.test(g.ch) && overlaps(box, { x0: g.x0, y0: g.top, x1: g.x1, y1: g.bottom }, 16)) Object.assign(box, { x0: Math.min(box.x0, g.x0), y0: Math.min(box.y0, g.top), x1: Math.max(box.x1, g.x1), y1: Math.max(box.y1, g.bottom) });
    for (let pass = 0; pass < 4; pass++) {
      for (const s of segs) {
        if (consumed.has(s)) continue;
        const text = segmentText(s).trim();
        if (CAPTION_START.test(text)) continue;
        const [cx0, cx1] = spanBounds(spanOf(box, cols), cols);
        const colW = cx1 - cx0;
        const isBodyLine = s.size >= bodySize * 0.95 && s.x1 - s.x0 > 0.72 * colW && text.split(/\s+/).length > 6;
        if (isBodyLine) continue;
        if (overlaps(box, segBox(s), 14)) {
          consumed.add(s);
          Object.assign(box, { x0: Math.min(box.x0, s.x0), y0: Math.min(box.y0, s.top), x1: Math.max(box.x1, s.x1), y1: Math.max(box.y1, s.bottom) });
        }
      }
    }
    const tight = raster ? (inkBox(raster, { x0: box.x0 - 3, y0: box.y0 - 3, x1: box.x1 + 3, y1: box.y1 + 3 }) ?? box) : box;
    const span = spanOf(tight, cols);
    const block: FigureBlock = { kind: "figure", page: pageNo, span, region: { page: pageNo, x0: tight.x0 - 2, y0: tight.y0 - 2, x1: tight.x1 + 2, y1: tight.y1 + 2 }, y0: tight.y0, y1: tight.y1 };
    elements.push(block);
  }
  // Panels that only met once their labels were pulled in (stacked plots) are one figure.
  for (let changed = true; changed; ) {
    changed = false;
    const figs = elements.filter((e): e is FigureBlock => e.kind === "figure");
    outer: for (let i = 0; i < figs.length; i++) {
      for (let j = i + 1; j < figs.length; j++) {
        if (overlaps(figs[i].region, figs[j].region, 4)) {
          const a = figs[i].region;
          const b = figs[j].region;
          const merged = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          Object.assign(figs[i], { region: { page: pageNo, ...merged }, y0: merged.y0 + 2, y1: merged.y1 - 2, span: spanOf(merged, cols) });
          elements.splice(elements.indexOf(figs[j]), 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  const insideFigure = (s: Segment) => elements.some((e) => e.kind === "figure" && overlaps(e.region, segBox(s), -1));
  for (const s of segs) if (insideFigure(s)) consumed.add(s);

  // --------------------------------------------------------------------------------------------
  // Rules (table rules, fraction bars, footnote separators), merged when collinear.
  // Rules from the raster directly (fraction bars, radical overbars, table rules), except the
  // axes and grid lines inside figures.
  const figureRegions = elements.filter((e): e is FigureBlock => e.kind === "figure").map((e) => e.region);
  const rules = (raster
    ? horizontalRules(raster, glyphs)
    : comps.filter((c) => c.kind === "rule").map((c) => ({ y: (c.y0 + c.y1) / 2, thickness: c.y1 - c.y0, x0: c.x0, x1: c.x1 }))
  )
    .filter((r) => !figureRegions.some((f) => r.y > f.y0 && r.y < f.y1 && r.x0 >= f.x0 - 2 && r.x1 <= f.x1 + 2))
    .sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const mergedRules: typeof rules = [];
  // Two collinear pieces are one rule when the raster shows unbroken ink between them: a long
  // fraction bar can be cut where a denominator's superscript (σ²) touches it and its glyph mask
  // erases that stretch.
  const continuousInk = (y: number, xa: number, xb: number): boolean => {
    if (!raster || xb <= xa) return xb <= xa;
    const py = Math.round(y * raster.scale);
    let dark = 0;
    let total = 0;
    for (let px = Math.round(xa * raster.scale); px <= Math.round(xb * raster.scale); px++) {
      total++;
      let hit = false;
      for (let dy = -1; dy <= 1 && !hit; dy++) if (isInk(raster, px, py + dy)) hit = true;
      if (hit) dark++;
    }
    return total > 0 && dark / total > 0.92;
  };
  for (const r of rules) {
    const prev = mergedRules.find((m) => Math.abs(m.y - r.y) < 1 && ((r.x0 - m.x1 < 8 && m.x0 - r.x1 < 8) || (r.x0 > m.x1 && r.x0 - m.x1 < 40 && continuousInk((m.y + r.y) / 2, m.x1, r.x0))));
    if (prev) {
      prev.x0 = Math.min(prev.x0, r.x0);
      prev.x1 = Math.max(prev.x1, r.x1);
    } else mergedRules.push({ ...r });
  }

  // --------------------------------------------------------------------------------------------
  // Tables: three or more consecutive rows of short cells whose left edges line up, usually framed
  // by rules. Rows are read across the whole page (a full-width table's cells sit on both sides of
  // the gutter without crossing it), ignoring column body text that shares a row with a
  // single-column table.
  const live = () => segs.filter((s) => !consumed.has(s));
  const colW = cols.left[1] - cols.left[0] || cols.full[1] - cols.full[0];
  const isBodyText = (s: Segment) => s.x1 - s.x0 > 0.55 * colW && segmentText(s).trim().split(/\s+/).length >= 6;
  const pageRows: Segment[][] = [];
  for (const sg of [...live()].sort((a, b) => a.base - b.base || a.x0 - b.x0)) {
    const row = pageRows.find((r) => Math.abs(r[0].base - sg.base) < 0.35 * sg.size);
    if (row) row.push(sg);
    else pageRows.push([sg]);
  }
  const cellsOf = (row: Segment[]) => row.filter((sg) => !isBodyText(sg) && !CAPTION_START.test(segmentText(sg).trim())).sort((a, b) => a.x0 - b.x0);
  const isGridRow = (row: Segment[]) => {
    const cells = cellsOf(row);
    if (cells.length < 2) return false;
    if (cells.length === 2 && EQ_NUMBER.test(segmentText(cells[1]).trim())) return false;
    return true;
  };
  // In a two-column page a table lives on one side unless its rows really span both: a short line
  // in the other column (a paragraph's last line, an equation) can share a baseline with a row.
  const sideCells = (cells: Segment[], side: Span) =>
    side === "F" || !cols.twoColumn ? cells : cells.filter((sg) => (side === "L" ? sg.x1 <= cols.gutter + 2 : sg.x0 >= cols.gutter - 2));
  for (let i = 0; i < pageRows.length; i++) {
    if (!isGridRow(pageRows[i])) continue;
    const seedCells = cellsOf(pageRows[i]);
    let side: Span = "F";
    if (cols.twoColumn) {
      const l = sideCells(seedCells, "L").length;
      const r = sideCells(seedCells, "R").length;
      const crossing = seedCells.some((sg) => sg.x0 < cols.gutter - 2 && sg.x1 > cols.gutter + 2);
      if (!crossing) side = l >= 2 && r >= 2 ? "F" : l >= r ? "L" : "R";
    }
    // Decide F only if most rows below also have cells on both sides.
    if (side === "F" && cols.twoColumn) {
      const following = pageRows.slice(i, i + 8).map(cellsOf).filter((c) => c.length > 0);
      const both = following.filter((c) => sideCells(c, "L").length > 0 && sideCells(c, "R").length > 0).length;
      if (both < 0.6 * following.length) side = sideCells(seedCells, "L").length >= sideCells(seedCells, "R").length ? "L" : "R";
    }
    const group: Segment[][] = [sideCells(seedCells, side)];
    if (group[0].length < 2) continue;
    let j = i;
    // Rows interleave with the other column's lines at different baselines: only what sits under
    // the table so far counts, and a row with nothing there is the other column - skip it.
    const hx0 = Math.min(...group[0].map((sg) => sg.x0));
    const hx1 = Math.max(...group[0].map((sg) => sg.x1));
    let k = j + 1;
    while (k < pageRows.length) {
      const next = sideCells(cellsOf(pageRows[k]), side).filter((sg) => sg.x0 > hx0 - 20 && sg.x1 < hx1 + 20);
      const prevBase = group[group.length - 1][0].base;
      if (next.length === 0) {
        if (pageRows[k][0].base - prevBase > 2.4 * pageRows[k][0].size) break;
        k++;
        continue;
      }
      const gap = next[0].base - prevBase;
      if (gap > 2.4 * next[0].size) break;
      group.push(next);
      j = k;
      k++;
    }
    const gridRows = group.filter((r) => r.length >= 2).length;
    if (gridRows < 3) continue;
    // Left edges shared across rows: at least two anchors used by most rows.
    const anchors: number[] = [];
    for (const sg of group.flat()) if (!anchors.some((a) => Math.abs(a - sg.x0) < 4)) anchors.push(sg.x0);
    const shared = anchors.filter((a) => group.filter((r) => r.some((sg) => Math.abs(sg.x0 - a) < 4 || (sg.x0 < a && sg.x1 > a + 4))).length >= 0.6 * group.length);
    const gx0 = Math.min(...group.flat().map((sg) => sg.x0));
    const gx1 = Math.max(...group.flat().map((sg) => sg.x1));
    const gy0 = Math.min(...group.flat().map((sg) => sg.top));
    const gy1 = Math.max(...group.flat().map((sg) => sg.bottom));
    const framed = mergedRules.some((r) => r.x1 - r.x0 > 0.8 * (gx1 - gx0) && r.y < gy0 + 2 && r.y > gy0 - 3 * group[0][0].size) || mergedRules.some((r) => r.x1 - r.x0 > 0.8 * (gx1 - gx0) && r.y > gy1 - 2 && r.y < gy1 + 2 * group[0][0].size);
    const mathy = mathFraction(group.flat().flatMap((sg) => sg.glyphs), textIsRoman);
    if (shared.length < 2 || (!framed && mathy > 0.6)) continue;
    const span = spanOf({ x0: gx0, x1: gx1 }, cols);
    const table = buildTable(pageNo, group, span, cols, mergedRules, raster);
    if (!table) continue;
    group.flat().forEach((sg) => consumed.add(sg));
    elements.push(table);
    i = j;
  }
  const spans = assignSpans(live(), cols);

  // --------------------------------------------------------------------------------------------
  // Display equations.
  const lineGroups = groupLines(live(), cols, spans);
  const eqLines: { segs: Segment[]; number: string | null }[] = [];
  for (const lg of lineGroups) {
    const all = lg.segs.flatMap((s) => s.glyphs);
    const text = lg.segs.map(segmentText).join(" ").trim();
    if (CAPTION_START.test(text)) continue;
    // Section headings that contain math ("D. d_μν") are headings, not displays.
    if (/^([A-Z]|[IVX]+|\d+(\.\d+)*)\.\s/.test(text) && lg.segs[0].glyphs.slice(0, 2).every((g) => g.font.role === "text" || g.font.role === "roman")) continue;
    let segsOfLine = lg.segs;
    const [cx0, cx1] = spanBounds(lg.span, cols);
    // A display that fills its column leaves no gap before its number: split "(17)" off the end
    // when it sits at the margin after math (and isn't "…in Eq. (17)" in running text).
    {
      const lastSeg = segsOfLine[segsOfLine.length - 1];
      const tailMatch = segmentText(lastSeg).match(EQ_NUMBER_TAIL);
      if (tailMatch && lastSeg.x1 > cx1 - 2 * lastSeg.size && !EQ_REF_TAIL.test(segmentText(lastSeg))) {
        const vis = lastSeg.glyphs.filter((g) => !g.space);
        const numGlyphs = vis.slice(vis.length - tailMatch[0].trim().length);
        const head = lastSeg.glyphs.filter((g) => !numGlyphs.includes(g));
        if (mathFraction(head, textIsRoman) >= 0.35 && head.length > 0) {
          const mk = (gs: Glyph[]): Segment => ({ ...lastSeg, glyphs: gs, x0: Math.min(...gs.filter((g) => !g.space).map((g) => g.x)), x1: Math.max(...gs.filter((g) => !g.space).map((g) => g.x + g.adv)) });
          const a = mk(head);
          const b = mk(numGlyphs);
          segs.splice(segs.indexOf(lastSeg), 1, a, b);
          spans.set(a, spans.get(lastSeg) ?? lg.span);
          spans.set(b, spans.get(lastSeg) ?? lg.span);
          segsOfLine = [...segsOfLine.slice(0, -1), a, b];
          lg.segs = segsOfLine;
        }
      }
    }
    const last = segsOfLine[segsOfLine.length - 1];
    const colW = cx1 - cx0;
    const numberText = segmentText(last).trim();
    const hasNumber = segsOfLine.length >= 2 && EQ_NUMBER.test(numberText) && last.x1 > cx1 - 2.5 * last.size;
    const body = hasNumber ? segsOfLine.slice(0, -1) : segsOfLine;
    const bodyGlyphs = body.flatMap((s) => s.glyphs);
    const mf = mathFraction(bodyGlyphs, textIsRoman);
    const x0 = Math.min(...body.map((s) => s.x0));
    const x1 = Math.max(...body.map((s) => s.x1));
    const indent = x0 - cx0;
    const rightGap = cx1 - x1;
    const centred = indent > 0.06 * colW && (hasNumber || rightGap > 0.04 * colW) && Math.abs(indent - (hasNumber ? indent : rightGap)) < 0.35 * colW;
    const bigOps = all.some((g) => g.font.role === "extension");
    const words = segmentText({ ...body[0], glyphs: bodyGlyphs.filter((g) => g.font.role === "text") } as Segment).split(/\s+/).filter((w) => w.length > 2).length;
    // Three glyphs or fewer with no number is a fragment (a numerator, a limit), not a display:
    // it joins the display it belongs to.
    const fragment = !hasNumber && !bigOps && visibleGlyphs(bodyGlyphs).length <= 3;
    if (!fragment && ((hasNumber && mf >= 0.25) || (centred && mf >= 0.45 && words <= 4) || (bigOps && centred))) {
      eqLines.push({ segs: lg.segs, number: hasNumber ? numberText.slice(1, -1) : null });
    }
  }
  // A display too wide for its number on the same line puts it alone at the margin underneath:
  // the math line just above takes it.
  for (const lg of lineGroups) {
    if (lg.segs.length !== 1) continue;
    const only = lg.segs[0];
    const t = segmentText(only).trim();
    const [, cx1] = spanBounds(lg.span, cols);
    if (!EQ_NUMBER.test(t) || only.x1 < cx1 - 2.5 * only.size || eqLines.some((e) => e.segs.includes(only))) continue;
    // The math on the number's own baseline (a display whose number sits far out at the margin, in
    // a line group of its own), else the line just above it.
    const above = lineGroups
      .filter((o) => {
        if (o === lg || o.span !== lg.span) return false;
        const dist = only.base - o.segs[0].base;
        // A number set underneath a display too wide for it sits up to ~3 lines below the display's
        // main line (fraction denominators come between).
        return dist > -0.3 * only.size && dist < 3.2 * only.size;
      })
      // Never a line that already carries a number of its own.
      .filter((o) => !o.segs.some((sg) => EQ_NUMBER.test(segmentText(sg).trim())))
      .sort((a, b) => {
        // On the number's own baseline first; then a line with a relation (=, <, ≈, ...) - a
        // display's main line, not the row of denominators hanging just over the number - and of
        // those the nearest.
        const sameA = Math.abs(only.base - a.segs[0].base) < 0.3 * only.size ? 0 : 1;
        const sameB = Math.abs(only.base - b.segs[0].base) < 0.3 * only.size ? 0 : 1;
        if (sameA !== sameB) return sameA - sameB;
        const relation = (lg2: typeof a) => (lg2.segs.some((sg) => /[=<>≤≥≈≃≡∝∼≪≫→⟶⇒⟹]/.test(segmentText(sg))) ? 0 : 1);
        if (relation(a) !== relation(b)) return relation(a) - relation(b);
        return Math.abs(only.base - a.segs[0].base) - Math.abs(only.base - b.segs[0].base);
      })[0];
    if (!above) continue;
    const existing = eqLines.find((e) => e.segs.some((sg) => above.segs.includes(sg)));
    const aboveGlyphs = above.segs.flatMap((sg) => sg.glyphs);
    if (existing) {
      if (!existing.number) {
        existing.number = t.slice(1, -1);
        existing.segs.push(only);
      }
    } else if (mathFraction(aboveGlyphs, textIsRoman) >= 0.5) {
      eqLines.push({ segs: [...above.segs, only], number: t.slice(1, -1) });
    }
  }
  // Aligned stacks: numbered rows set one under another (an align environment - "V1 = ...  (2.9)",
  // "V2 = ...  (2.10)", ...). Their numerators and denominators reach into each other's space, so
  // growing each row outwards hands pieces to the wrong row. As TeX sets them, each row owns the band
  // around its own baseline, halfway to the next row's: split the stack there and build every row
  // from exactly its band.
  {
    const isNumberSeg = (sg: Segment) => EQ_NUMBER.test(segmentText(sg).trim());
    const mathBase = (e: (typeof eqLines)[number]) => {
      const body = e.segs.filter((sg) => !isNumberSeg(sg));
      const big = Math.max(...body.map((sg) => sg.size));
      const main = body.filter((sg) => sg.size >= 0.9 * big).sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0));
      return main[0]?.base ?? e.segs[0].base;
    };
    // Running text: several words in the text font - or a line of text alone at the column's left
    // edge, however short ("Define", "whereas", "then" between two displays).
    const isProse = (sg: Segment) => {
      if (mathFraction(sg.glyphs, textIsRoman) >= 0.3) return false;
      const words = segmentText({ ...sg, glyphs: sg.glyphs.filter((g) => g.font.role === "text") }).split(/\s+/).filter((w) => w.length >= 3).length;
      const [lx0] = spanBounds(spans.get(sg) ?? "F", cols);
      return words >= 3 || (words >= 1 && sg.x0 - lx0 < 1.5 * sg.size);
    };
    const numbered = eqLines
      .filter((e) => e.number)
      .map((e) => ({ e, base: mathBase(e), span: spans.get(e.segs[0]) ?? "F", size: Math.max(...e.segs.map((sg) => sg.size)) }))
      .sort((a, b) => a.base - b.base);
    const groups: (typeof numbered)[] = [];
    for (const row of numbered) {
      const g = groups[groups.length - 1];
      const prev = g?.[g.length - 1];
      const close = prev && prev.span === row.span && row.base - prev.base < 4.8 * row.size;
      // No running text between the two rows.
      const proseBetween =
        close && live().some((sg) => (spans.get(sg) ?? "F") === row.span && sg.base > prev.base + 0.5 * row.size && sg.base < row.base - 0.5 * row.size && isProse(sg));
      if (close && !proseBetween) g.push(row);
      else groups.push([row]);
    }
    for (const g of groups) {
      if (g.length < 2) continue;
      const [cx0, cx1] = spanBounds(g[0].span, cols);
      const gaps = g.slice(1).map((r, k) => r.base - g[k].base);
      const bands = g.map((r, k) => ({
        row: r,
        top: r.base - (k > 0 ? gaps[k - 1] / 2 : Math.min(gaps[0] / 2, 2.2 * r.size)),
        bottom: r.base + (k < gaps.length ? gaps[k] / 2 : Math.min(gaps[gaps.length - 1] / 2, 2.2 * r.size)),
        segs: [] as Segment[],
      }));
      const used = new Set(g.flatMap((r) => r.e.segs));
      // Every piece of maths in the stack's extent (not prose, not another display's number) goes
      // to the band its middle falls in; each row keeps its own number.
      for (const sg of live()) {
        if ((spans.get(sg) ?? "F") !== g[0].span || sg.x1 < cx0 - 2 || sg.x0 > cx1 + 2) continue;
        const inGroup = used.has(sg);
        // Pieces another numbered display owns stay there; unnumbered fragments inside the stack
        // (a bracket row, a lone denominator that seeded a display of its own) are the stack's.
        if (!inGroup && (isProse(sg) || isNumberSeg(sg) || eqLines.some((e) => e.number && !g.some((r) => r.e === e) && e.segs.includes(sg)))) continue;
        if (inGroup && isNumberSeg(sg)) continue;
        const mid = (sg.top + sg.bottom) / 2;
        const band = bands.find((bd) => mid >= bd.top && mid < bd.bottom);
        if (band) band.segs.push(sg);
      }
      for (const bd of bands) {
        const numberSeg = bd.row.e.segs.find(isNumberSeg);
        const members = [...bd.segs, ...(numberSeg ? [numberSeg] : [])];
        const glyphsOf = bd.segs.flatMap((sg) => sg.glyphs);
        if (glyphsOf.length === 0) continue;
        const b = { x0: Math.min(...bd.segs.map((sg) => sg.x0)), y0: Math.min(...bd.segs.map((sg) => sg.top)), x1: Math.max(...bd.segs.map((sg) => sg.x1)), y1: Math.max(...bd.segs.map((sg) => sg.bottom)) };
        const bars = mergedRules.filter((r) => r.y > bd.top && r.y < bd.bottom && r.x0 >= cx0 - 2 && r.x1 <= cx1 + 2 && r.x1 - r.x0 < (cx1 - cx0) * 0.95);
        const ink = raster ? (inkBox(raster, { x0: cx0, y0: b.y0 - 2, x1: cx1 + 2, y1: b.y1 + 2 }) ?? b) : b;
        elements.push({
          kind: "equation",
          page: pageNo,
          span: g[0].span,
          glyphs: glyphsOf,
          bars: bars.map((r) => ({ x0: r.x0, x1: r.x1, y: r.y, thickness: r.thickness })),
          number: bd.row.e.number,
          region: { page: pageNo, x0: cx0, y0: Math.max(bd.top, Math.min(ink.y0, b.y0)) - 1.5, x1: cx1, y1: Math.min(bd.bottom, Math.max(ink.y1, b.y1)) + 1.5 },
          colX0: cx0,
          colX1: cx1,
          y0: b.y0,
          y1: b.y1,
          stacked: true,
        });
        for (const m of members) consumed.add(m);
      }
      // These rows are built: take them, and the fragments they took in, out of the general pass.
      for (const r of g) eqLines.splice(eqLines.indexOf(r.e), 1);
      for (let k = eqLines.length - 1; k >= 0; k--) if (!eqLines[k].number && eqLines[k].segs.every((sg) => consumed.has(sg))) eqLines.splice(k, 1);
    }
  }
  // A numerator or denominator sits directly on a fraction bar, and the bar belongs to the display
  // whose row it lies in: settle those fragments first, so a neighbouring display can't claim them.
  const fragmentOwner = new Map<Segment, (typeof eqLines)[number]>();
  for (const sg of live()) {
    if (eqLines.some((e) => e.segs.includes(sg))) continue;
    const midX = (sg.x0 + sg.x1) / 2;
    const bar = mergedRules.find((r) => midX > r.x0 - 0.5 && midX < r.x1 + 0.5 && r.x1 - r.x0 < 0.95 * colW && (Math.abs(r.y - sg.bottom) < 0.6 * sg.size || Math.abs(sg.top - r.y) < 0.6 * sg.size));
    if (!bar) continue;
    const owner = eqLines.find((e) => e.segs.some((x) => x.top - 1 <= bar.y && x.bottom + 1 >= bar.y && Math.max(x.x0 - bar.x1, bar.x0 - x.x1) < 2 * sg.size));
    if (owner) fragmentOwner.set(sg, owner);
  }
  // Grow each equation line into its block: fraction numerators/denominators, limits, and further
  // lines of a multi-line display that sit tight above or below.
  const eqUsed = new Set<Segment>();
  // When a line merges into another line's block, what it owns goes with it.
  const absorbedInto = new Map<(typeof eqLines)[number], (typeof eqLines)[number]>();
  const resolveOwner = (e: (typeof eqLines)[number] | undefined) => {
    let cur = e;
    for (let k = 0; cur && absorbedInto.has(cur) && k < 50; k++) cur = absorbedInto.get(cur);
    return cur;
  };
  for (const eq of eqLines) {
    if (eq.segs.some((s) => eqUsed.has(s) || consumed.has(s))) continue;
    const members = [...eq.segs];
    let number = eq.number;
    // Which numbered line the block's number came from: the rest of that line still belongs here.
    let numberFrom: (typeof eqLines)[number] | null = eq.number ? eq : null;
    // A display grows only within its own column (or across the page when it is full-width).
    const seedSpan = spans.get(eq.segs[0]) ?? "F";
    const cx0Of = (sp: Span) => spanBounds(sp, cols)[0];
    const cx1Of = (sp: Span) => spanBounds(sp, cols)[1];
    const box = () => ({ x0: Math.min(...members.map((s) => s.x0)), y0: Math.min(...members.map((s) => s.top)), x1: Math.max(...members.map((s) => s.x1)), y1: Math.max(...members.map((s) => s.bottom)) });
    for (let pass = 0; pass < 6; pass++) {
      const b = box();
      for (const s of live()) {
        if (members.includes(s) || eqUsed.has(s) || consumed.has(s)) continue;
        if ((spans.get(s) ?? "F") !== seedSpan) continue;
        const sb = segBox(s);
        const vGap = Math.max(sb.y0 - b.y1, b.y0 - sb.y1);
        const hOverlap = Math.min(sb.x1, b.x1) - Math.max(sb.x0, b.x0);
        const text = segmentText(s).trim();
        const isNumber = EQ_NUMBER.test(text);
        const mf = mathFraction(s.glyphs, textIsRoman);
        const other = eqLines.find((e) => e !== eq && e.segs.includes(s));
        const owner = resolveOwner(fragmentOwner.get(s));
        if (owner && owner !== eq) continue;
        // A loose fragment (numerator, limit) belongs to the nearest display, not the first one
        // that reaches it.
        if (!other && owner !== eq) {
          // Only displays in the same column that the fragment sits under or over compete.
          const closer = eqLines.some((e) => {
            if (e === eq || e.segs.some((x) => eqUsed.has(x)) || (spans.get(e.segs[0]) ?? "F") !== seedSpan) return false;
            const eb = { x0: Math.min(...e.segs.map((x) => x.x0)), x1: Math.max(...e.segs.map((x) => x.x1)), y0: Math.min(...e.segs.map((x) => x.top)), y1: Math.max(...e.segs.map((x) => x.bottom)) };
            if (Math.min(eb.x1, sb.x1) - Math.max(eb.x0, sb.x0) <= 0) return false;
            const d = Math.max(sb.y0 - eb.y1, eb.y0 - sb.y1);
            return d < vGap - 0.5;
          });
          if (closer) continue;
        }
        if (other) {
          // Rows that overlap vertically are one display (a fraction beside its "A ="). A separate
          // line below joins only when at most one of the two carries a number - aligned
          // equations share one number; two numbered lines are two equations.
          // Two lines that each carry a number are two equations, however close.
          if ((number && other.number && other !== numberFrom) || (vGap >= 0 && vGap > 0.6 * s.size)) continue;
          if (other.number && !number) {
            number = other.number;
            numberFrom = other;
          }
          absorbedInto.set(other, eq);
        }
        const hGap = -hOverlap;
        const beside = vGap < 0 && hGap < 3 * s.size; // same display row, left or right of the block
        // A centred row stacked tight against the display belongs to it (a diagram of text rows
        // joined by arrows, a "where" clause set as part of the display).
        const sIndent = s.x0 - cx0Of(seedSpan);
        const sRight = cx1Of(seedSpan) - s.x1;
        const centredRow = s.x1 - s.x0 < 0.7 * (cx1Of(seedSpan) - cx0Of(seedSpan)) && sIndent > 0.1 * (cx1Of(seedSpan) - cx0Of(seedSpan)) && Math.abs(sIndent - sRight) < 0.22 * (cx1Of(seedSpan) - cx0Of(seedSpan)) && vGap < 0.75 * s.size && hOverlap > 0;
        // Running text (several words in the text font) is never part of a display.
        const textWords = segmentText({ ...s, glyphs: s.glyphs.filter((g) => g.font.role === "text") }).split(/\s+/).filter((w) => w.length >= 3).length;
        if (textWords >= 3 && !centredRow && !other) continue;
        if (vGap < 0.55 * s.size && (hOverlap > 0 || beside || (isNumber && Math.abs(s.base - (b.y0 + b.y1) / 2) < 1.2 * s.size)) && (mf >= 0.3 || isNumber || visibleGlyphs(s.glyphs).length <= 3 || centredRow)) {
          if (isNumber && !number) number = text.slice(1, -1);
          else if (isNumber && text.slice(1, -1) !== number) continue;
          members.push(s);
        }
      }
    }
    members.forEach((s) => eqUsed.add(s));
    const glyphsOf = members.filter((s) => !EQ_NUMBER.test(segmentText(s).trim())).flatMap((s) => s.glyphs);
    const b = box();
    const span: Span = members.some((m) => spans.get(m) === "F") ? "F" : spanOf(b, cols);
    const [cx0, cx1] = spanBounds(span, cols);
    const bars = mergedRules.filter((r) => r.y > b.y0 - 2 && r.y < b.y1 + 2 && r.x0 >= cx0 - 2 && r.x1 <= cx1 + 2 && r.x1 - r.x0 < (cx1 - cx0) * 0.95);
    const ink = raster ? (inkBox(raster, { x0: cx0, y0: b.y0 - 2, x1: cx1 + 2, y1: b.y1 + 2 }) ?? b) : b;
    const block: EquationBlock = {
      kind: "equation",
      page: pageNo,
      span,
      glyphs: glyphsOf,
      bars: bars.map((r) => ({ x0: r.x0, x1: r.x1, y: r.y, thickness: r.thickness })),
      number,
      region: { page: pageNo, x0: cx0, y0: Math.min(ink.y0, b.y0) - 1.5, x1: cx1, y1: Math.max(ink.y1, b.y1) + 1.5 },
      colX0: cx0,
      colX1: cx1,
      y0: b.y0,
      y1: b.y1,
    };
    elements.push(block);
  }
  for (const s of eqUsed) consumed.add(s);
  // Consolidate: displays built from different seed lines that touch (an arrow diagram's rows, a
  // fraction whose pieces seeded separately) are one display when at most one carries a number.
  for (let changed = true; changed; ) {
    changed = false;
    const eqs = elements.filter((e): e is EquationBlock => e.kind === "equation");
    outer: for (let i = 0; i < eqs.length; i++) {
      for (let j = 0; j < eqs.length; j++) {
        const a = eqs[i];
        const b = eqs[j];
        if (i === j || a.span !== b.span || (a.number && b.number && a.number !== b.number)) continue;
        // Rows of an aligned stack are complete as built.
        if (a.stacked || b.stacked) continue;
        const size = Math.max(...a.glyphs.map((g) => g.size), ...b.glyphs.map((g) => g.size));
        const vGap = Math.max(b.y0 - a.y1, a.y0 - b.y1);
        const ax0 = Math.min(...a.glyphs.map((g) => g.x));
        const ax1 = Math.max(...a.glyphs.map((g) => g.x + g.adv));
        const bx0 = Math.min(...b.glyphs.map((g) => g.x));
        const bx1 = Math.max(...b.glyphs.map((g) => g.x + g.adv));
        if (vGap > 0.65 * size || Math.min(ax1, bx1) - Math.max(ax0, bx0) <= 0) continue;
        const merged: EquationBlock = {
          ...a,
          glyphs: [...a.glyphs, ...b.glyphs],
          bars: [...a.bars, ...b.bars],
          number: a.number ?? b.number,
          region: { page: pageNo, x0: Math.min(a.region.x0, b.region.x0), y0: Math.min(a.region.y0, b.region.y0), x1: Math.max(a.region.x1, b.region.x1), y1: Math.max(a.region.y1, b.region.y1) },
          y0: Math.min(a.y0, b.y0),
          y1: Math.max(a.y1, b.y1),
        };
        elements.splice(elements.indexOf(a), 1, merged);
        elements.splice(elements.indexOf(b), 1);
        changed = true;
        break outer;
      }
    }
  }

  // --------------------------------------------------------------------------------------------
  // Remaining text: one FlowLine per visual line per column.
  for (const lg of groupLines(live(), cols, spans)) {
    const glyphsOf = lg.segs.flatMap((s, i) => (i === 0 ? s.glyphs : [{ ...s.glyphs[0], ch: " ", space: true, x: lg.segs[i - 1].x1, adv: s.x0 - lg.segs[i - 1].x1 }, ...s.glyphs]));
    const [cx0, cx1] = spanBounds(lg.span, cols);
    const line: FlowLine = {
      page: pageNo,
      span: lg.span,
      glyphs: glyphsOf as Glyph[],
      x0: Math.min(...lg.segs.map((s) => s.x0)),
      x1: Math.max(...lg.segs.map((s) => s.x1)),
      base: lg.segs[0].base,
      size: Math.max(...lg.segs.map((s) => s.size)),
      top: Math.min(...lg.segs.map((s) => s.top)),
      bottom: Math.max(...lg.segs.map((s) => s.bottom)),
      colX0: cx0,
      colX1: cx1,
    };
    const block: LineBlock = { kind: "line", line, y0: line.top, y1: line.bottom, span: lg.span, page: pageNo };
    elements.push(block);
  }

  return { page: pageNo, width, height, columns: cols, elements: orderElements(elements, cols), bodySize, marginal, rules: mergedRules };
}

// Which column each text segment belongs to. Decided per row and from context, not per segment:
// a centred display equation straddling the gutter in a full-width abstract has pieces on both
// sides of it, and the short last line of a full-width paragraph sits entirely on one side.
export function assignSpans(segs: Segment[], cols: ColumnModel): Map<Segment, Span> {
  const spans = new Map<Segment, Span>();
  if (!cols.twoColumn) {
    segs.forEach((s) => spans.set(s, "F"));
    return spans;
  }
  const colW = cols.left[1] - cols.left[0];
  const rows: Segment[][] = [];
  for (const s of [...segs].sort((a, b) => a.base - b.base || a.x0 - b.x0)) {
    const row = rows.find((r) => Math.abs(r[0].base - s.base) < 0.3 * s.size);
    if (row) row.push(s);
    else rows.push([s]);
  }
  // Pass 1: a row with a segment crossing the gutter is full-width; everything else goes by side.
  const crossing = new Set<Segment[]>();
  for (const row of rows) {
    if (row.some((s) => s.x0 < cols.gutter - 1.5 && s.x1 > cols.gutter + 1.5)) {
      crossing.add(row);
      row.forEach((s) => spans.set(s, "F"));
    } else row.forEach((s) => spans.set(s, s.x1 <= cols.gutter + 1.5 ? "L" : "R"));
  }
  // Pass 2: rows sandwiched between full-width rows, with no real column text between them, are
  // inside a full-width zone - a display equation centred in an abstract straddles the gutter
  // without crossing it.
  const isColumnText = (s: Segment) => s.x1 - s.x0 > 0.6 * colW && segmentText(s).split(/\s+/).length >= 5;
  for (const row of rows) {
    if (crossing.has(row)) continue;
    const size = row[0].size;
    const above = rows.filter((r) => crossing.has(r) && r[0].base < row[0].base && row[0].base - r[0].base < 4 * size);
    const below = rows.filter((r) => crossing.has(r) && r[0].base > row[0].base && r[0].base - row[0].base < 4 * size);
    if (above.length === 0 || below.length === 0) continue;
    const top = Math.max(...above.map((r) => r[0].base));
    const bottom = Math.min(...below.map((r) => r[0].base));
    const columnTextBetween = rows.some((r) => !crossing.has(r) && r[0].base > top && r[0].base < bottom && r.some(isColumnText));
    if (!columnTextBetween) row.forEach((s) => spans.set(s, "F"));
  }
  // One-sided lines that continue a full-width paragraph (tight below or above a full-width line,
  // starting at its left edge or inside it) are full-width too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of segs) {
      if (spans.get(s) === "F") continue;
      const partner = segs.some((o) => o !== s && spans.get(o) !== "F" && spans.get(o) !== spans.get(s) && Math.abs(o.base - s.base) < 1.6 * s.size);
      if (partner) continue;
      const neighbour = segs.find(
        (o) =>
          spans.get(o) === "F" &&
          Math.max(o.top - s.bottom, s.top - o.bottom) < 0.9 * s.size &&
          Math.abs(o.size - s.size) < 0.15 * s.size &&
          (Math.abs(o.x0 - s.x0) < 3 || (s.x0 >= o.x0 - 3 && s.x1 <= o.x1 + 3 && o.x1 - o.x0 > 0.6 * (cols.full[1] - cols.full[0])))
      );
      if (neighbour) {
        spans.set(s, "F");
        changed = true;
      }
    }
  }
  return spans;
}

// Segments of one visual line within one column (a justified line can be split by a wide space).
function groupLines(segs: Segment[], cols: ColumnModel, spans?: Map<Segment, Span>): { segs: Segment[]; span: Span }[] {
  const groups: { segs: Segment[]; span: Span }[] = [];
  for (const s of [...segs].sort((a, b) => a.base - b.base || a.x0 - b.x0)) {
    const span = spans?.get(s) ?? spanOf(s, cols);
    const g = groups.find((x) => x.span === span && Math.abs(x.segs[0].base - s.base) < 0.3 * s.size);
    if (g) g.segs.push(s);
    else groups.push({ segs: [s], span });
  }
  // A line that crosses the gutter makes the whole row full-width.
  for (const g of groups) g.segs.sort((a, b) => a.x0 - b.x0);
  return groups;
}

// Reading order: full-width elements cut the page into bands; within a band, the left column
// is read top to bottom, then the right.
export function orderElements(elements: PageElement[], cols: ColumnModel): PageElement[] {
  const byTop = (a: PageElement, b: PageElement) => a.y0 - b.y0 || (a.kind === "line" && b.kind === "line" ? a.line.x0 - b.line.x0 : 0);
  if (!cols.twoColumn) return [...elements].sort(byTop);
  const full = elements.filter((e) => e.span === "F").sort(byTop);
  const colEls = elements.filter((e) => e.span !== "F");
  const out: PageElement[] = [];
  let bandTop = -Infinity;
  const emitBand = (bottom: number) => {
    const inBand = colEls.filter((e) => (e.y0 + e.y1) / 2 >= bandTop && (e.y0 + e.y1) / 2 < bottom);
    out.push(...inBand.filter((e) => e.span === "L").sort(byTop), ...inBand.filter((e) => e.span === "R").sort(byTop));
  };
  for (const f of full) {
    emitBand(f.y0);
    out.push(f);
    bandTop = f.y1;
  }
  emitBand(Infinity);
  return out;
}

// ----------------------------------------------------------------------------------------------
// Tables

function buildTable(page: number, rows: Segment[][], span: Span, cols: ColumnModel, rules: { y: number; thickness: number; x0: number; x1: number }[], raster: Raster | null): TableBlock | null {
  const segs = rows.flat();
  // Column anchors: cluster cell left edges and centres; a column is a run of x where cells sit.
  const intervals = segs.map((s) => [s.x0, s.x1] as [number, number]).sort((a, b) => a[0] - b[0]);
  const columns: { x0: number; x1: number }[] = [];
  for (const [a, b] of intervals) {
    const c = columns.find((col) => a < col.x1 + 4 && b > col.x0 - 4);
    if (c) {
      c.x0 = Math.min(c.x0, a);
      c.x1 = Math.max(c.x1, b);
    } else columns.push({ x0: a, x1: b });
  }
  // Merge columns that now overlap after growth.
  columns.sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i + 1 < columns.length; i++) {
    if (columns[i + 1].x0 < columns[i].x1 + 2) {
      columns[i].x1 = Math.max(columns[i].x1, columns[i + 1].x1);
      columns.splice(i + 1, 1);
      i--;
    }
  }
  if (columns.length < 2) return null;
  // Alignment per column, from how the cells' edges line up.
  const aligned = columns.map((col) => {
    const cells = segs.filter((s) => s.x0 >= col.x0 - 1 && s.x1 <= col.x1 + 1);
    const spread = (vals: number[]) => Math.max(...vals) - Math.min(...vals);
    const l = spread(cells.map((s) => s.x0));
    const r = spread(cells.map((s) => s.x1));
    const c = spread(cells.map((s) => (s.x0 + s.x1) / 2));
    const align: "left" | "center" | "right" = l <= c && l <= r ? "left" : r < c ? "right" : "center";
    return { ...col, align };
  });
  // Rows: lines whose cells only sit in lower rows of a multi-line cell are merged up later by the
  // assembler; here every baseline is a row.
  const modelRows: TableCellModel[][] = rows.map((row) =>
    row.map((s) => {
      const colStart = aligned.findIndex((c) => s.x0 >= c.x0 - 1 && s.x0 <= c.x1);
      let colEnd = colStart + 1;
      while (colEnd < aligned.length && s.x1 > aligned[colEnd].x0 + 2) colEnd++;
      return { glyphs: s.glyphs, x0: s.x0, x1: s.x1, colStart: Math.max(0, colStart), colEnd };
    })
  );
  const y0 = Math.min(...segs.map((s) => s.top));
  const y1 = Math.max(...segs.map((s) => s.bottom));
  const size = segs[0]?.size ?? 10;
  const xs0 = Math.min(...segs.map((s) => s.x0));
  const xs1 = Math.max(...segs.map((s) => s.x1));
  const frame = rules.filter((r) => r.y > y0 - 2.2 * size && r.y < y1 + 1.6 * size && r.x0 < xs0 + 20 && r.x1 > xs1 - 20);
  // A double rule is two thin rules within ~3pt.
  const ruleModel: TableBlock["rules"] = [];
  for (const r of frame) {
    const prev = ruleModel[ruleModel.length - 1];
    if (prev && Math.abs(r.y - prev.y) < 3.5) prev.double = true;
    else ruleModel.push({ y: r.y, thickness: r.thickness, double: false });
  }
  // Header rows: rows above the first inner rule (booktabs midrule), when there is one.
  const inner = ruleModel.filter((r) => r.y > y0 + 1 && r.y < y1 - 1);
  const headerRows = inner.length > 0 ? rows.filter((r) => r[0].base < inner[0].y).length : 0;
  const top = Math.min(y0, ...frame.map((r) => r.y)) - 1;
  const bottom = Math.max(y1, ...frame.map((r) => r.y)) + 1;
  const region = raster ? (inkBox(raster, { x0: xs0 - 4, y0: top - 2, x1: xs1 + 4, y1: bottom + 2 }) ?? { x0: xs0, y0: top, x1: xs1, y1: bottom }) : { x0: xs0, y0: top, x1: xs1, y1: bottom };
  void cols;
  return { kind: "table", page, span, rows: modelRows, columns: aligned, headerRows, rules: ruleModel, region: { page, ...region }, y0: top, y1: bottom };
}
