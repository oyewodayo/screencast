// utils/pdfImport/ink.ts
//
// What the text layer doesn't explain. The page is rendered to a grayscale raster; every glyph's
// ink box is masked out; what's left is graphics: plots and photos, table rules, fraction bars,
// radical signs' overbars, footnote rules. This is independent of how the PDF drew them (paths,
// images, form XObjects, shading patterns), which makes it robust across LaTeX, Word and
// InDesign output alike.
import type { Glyph } from "./glyphs";

export interface Raster {
  width: number; // px
  height: number;
  scale: number; // px per pt
  gray: Uint8Array; // 0 = black, 255 = white; row-major, stride = width
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const INK = 200; // a pixel darker than this is ink (anti-aliasing included)

export function isInk(r: Raster, px: number, py: number): boolean {
  return r.gray[py * r.width + px] < INK;
}

// Tight box of the ink inside a region (pt), or null when it's blank.
export function inkBox(r: Raster, region: Box): Box | null {
  const px0 = Math.max(0, Math.floor(region.x0 * r.scale));
  const px1 = Math.min(r.width - 1, Math.ceil(region.x1 * r.scale));
  const py0 = Math.max(0, Math.floor(region.y0 * r.scale));
  const py1 = Math.min(r.height - 1, Math.ceil(region.y1 * r.scale));
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let y = py0; y <= py1; y++) {
    const row = y * r.width;
    for (let x = px0; x <= px1; x++) {
      if (r.gray[row + x] < INK) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x0: x0 / r.scale, y0: y0 / r.scale, x1: (x1 + 1) / r.scale, y1: (y1 + 1) / r.scale };
}

export interface InkComponent extends Box {
  cells: number; // ink cells - a measure of how much is drawn
  kind: "rule" | "figure" | "mark";
}

// Graphics on the page, as connected components of ink that no glyph accounts for. Cells are
// `cell` pt square; components are joined across gaps up to `join` pt so the pieces of one plot
// (axes, curves, ticks, legend swatches) come out as one figure.
export function graphicsComponents(r: Raster, glyphs: Glyph[], cell = 1.5, join = 4.5): InkComponent[] {
  const cols = Math.ceil(r.width / r.scale / cell);
  const rows = Math.ceil(r.height / r.scale / cell);
  const pxPerCell = cell * r.scale;
  const ink = new Uint8Array(cols * rows);
  // Text mask at pixel resolution from each glyph's exact outline box (plus anti-aliasing): a
  // fraction bar squeezed between a numerator and a denominator lies outside both and survives,
  // where a cell-level mask would erase it with them.
  const mask = new Uint8Array(r.width * r.height);
  const aa = 0.35;
  for (const g of glyphs) {
    if (g.space && g.adv > 0) continue;
    const px0 = Math.max(0, Math.floor((g.x0 - aa) * r.scale));
    const px1 = Math.min(r.width - 1, Math.ceil((g.x1 + aa) * r.scale));
    const py0 = Math.max(0, Math.floor((g.top - aa) * r.scale));
    const py1 = Math.min(r.height - 1, Math.ceil((g.bottom + aa) * r.scale));
    for (let y = py0; y <= py1; y++) mask.fill(1, y * r.width + px0, y * r.width + px1 + 1);
  }
  for (let y = 0; y < r.height; y++) {
    const cy = Math.floor(y / pxPerCell);
    const row = y * r.width;
    for (let x = 0; x < r.width; x++) {
      if (r.gray[row + x] < INK && !mask[row + x]) ink[cy * cols + Math.floor(x / pxPerCell)] = 1;
    }
  }
  const seen = new Uint8Array(cols * rows);
  const reach = Math.max(1, Math.round(join / cell));
  const out: InkComponent[] = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let cells = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      const cx = idx % cols;
      const cy = (idx - cx) / cols;
      cells++;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      for (let dy = -reach; dy <= reach; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= cols) continue;
          const n = ny * cols + nx;
          if (ink[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    let box = { x0: minX * cell, y0: minY * cell, x1: (maxX + 1) * cell, y1: (maxY + 1) * cell };
    // Small components: the cell grid overstates them (a 0.4pt fraction bar spans two cells), so
    // measure the unmasked ink exactly - its true shape decides rule versus mark.
    if (box.x1 - box.x0 < 40 && box.y1 - box.y0 < 12) {
      let tx0 = Infinity;
      let tx1 = -Infinity;
      let ty0 = Infinity;
      let ty1 = -Infinity;
      const px0 = Math.floor(box.x0 * r.scale);
      const px1 = Math.min(r.width - 1, Math.ceil(box.x1 * r.scale));
      const py0 = Math.floor(box.y0 * r.scale);
      const py1 = Math.min(r.height - 1, Math.ceil(box.y1 * r.scale));
      for (let y = py0; y <= py1; y++) {
        for (let x = px0; x <= px1; x++) {
          const k = y * r.width + x;
          if (r.gray[k] < INK && !mask[k]) {
            if (x < tx0) tx0 = x;
            if (x > tx1) tx1 = x;
            if (y < ty0) ty0 = y;
            if (y > ty1) ty1 = y;
          }
        }
      }
      if (Number.isFinite(tx0)) box = { x0: tx0 / r.scale, y0: ty0 / r.scale, x1: (tx1 + 1) / r.scale, y1: (ty1 + 1) / r.scale };
    }
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    // A rule is long and thin - judged by shape, so the 3pt bar of a text-size 1/2 counts too.
    const kind: InkComponent["kind"] = h <= 2.6 * cell && w >= 2.5 && w >= 2.2 * h ? "rule" : w >= 30 && h >= 24 ? "figure" : "mark";
    out.push({ ...box, cells, kind });
  }
  return out;
}

// Refines a rule's vertical position and thickness from the raster (the cell grid is coarse).
// A rule's line is the raster row with the most ink across its span - not its box centre, which a
// neighbouring stroke (a superscript, a plus sign) can drag off by a point or more.
export function ruleGeometry(r: Raster, c: Box): { y: number; thickness: number; x0: number; x1: number } {
  const tight = inkBox(r, { x0: c.x0, y0: c.y0 - 1, x1: c.x1, y1: c.y1 + 1 }) ?? c;
  const px0 = Math.max(0, Math.floor(tight.x0 * r.scale));
  const px1 = Math.min(r.width - 1, Math.ceil(tight.x1 * r.scale));
  const py0 = Math.max(0, Math.floor((c.y0 - 1) * r.scale));
  const py1 = Math.min(r.height - 1, Math.ceil((c.y1 + 1) * r.scale));
  let bestRow = -1;
  let bestCount = 0;
  const counts: number[] = [];
  for (let y = py0; y <= py1; y++) {
    let n = 0;
    for (let x = px0; x <= px1; x++) if (r.gray[y * r.width + x] < 200) n++;
    counts.push(n);
    if (n > bestCount) {
      bestCount = n;
      bestRow = y;
    }
  }
  if (bestRow < 0) return { y: (tight.y0 + tight.y1) / 2, thickness: tight.y1 - tight.y0, x0: tight.x0, x1: tight.x1 };
  // Thickness: the run of rows around the best one that are nearly as full.
  let top = bestRow;
  let bottom = bestRow;
  while (top - 1 >= py0 && counts[top - 1 - py0] >= 0.6 * bestCount) top--;
  while (bottom + 1 <= py1 && counts[bottom + 1 - py0] >= 0.6 * bestCount) bottom++;
  // Horizontal extent along the rule's own rows.
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let y = top; y <= bottom; y++) {
    for (let x = px0; x <= px1; x++) {
      if (r.gray[y * r.width + x] < 200) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  }
  return { y: (top + bottom + 1) / 2 / r.scale, thickness: (bottom - top + 1) / r.scale, x0: x0 / r.scale, x1: (x1 + 1) / r.scale };
}

// Pixel mask of every glyph's exact outline box (plus anti-aliasing).
export function glyphMask(r: Raster, glyphs: Glyph[], aa = 0.35): Uint8Array {
  const mask = new Uint8Array(r.width * r.height);
  for (const g of glyphs) {
    if (g.space && g.adv > 0) continue;
    const px0 = Math.max(0, Math.floor((g.x0 - aa) * r.scale));
    const px1 = Math.min(r.width - 1, Math.ceil((g.x1 + aa) * r.scale));
    const py0 = Math.max(0, Math.floor((g.top - aa) * r.scale));
    const py1 = Math.min(r.height - 1, Math.ceil((g.bottom + aa) * r.scale));
    for (let y = py0; y <= py1; y++) mask.fill(1, y * r.width + px0, y * r.width + px1 + 1);
  }
  return mask;
}

export interface Rule {
  x0: number;
  x1: number;
  y: number;
  thickness: number;
}

// Horizontal rules straight from the raster: runs of unmasked ink at least `minLength` pt long,
// stacked over at most `maxThickness` pt of consecutive rows. Fraction bars, radical overbars,
// table rules and footnote separators all come out here regardless of what ink sits near them.
export function horizontalRules(r: Raster, glyphs: Glyph[], minLength = 2.4, maxThickness = 1.6): Rule[] {
  const mask = glyphMask(r, glyphs, 0.2);
  const minRun = Math.max(3, Math.round(minLength * r.scale));
  // Runs per row.
  type Run = { y: number; x0: number; x1: number };
  const rows: Run[][] = [];
  for (let y = 0; y < r.height; y++) {
    const runs: Run[] = [];
    let start = -1;
    const base = y * r.width;
    for (let x = 0; x <= r.width; x++) {
      const on = x < r.width && r.gray[base + x] < 200 && !mask[base + x];
      if (on && start < 0) start = x;
      else if (!on && start >= 0) {
        if (x - start >= minRun) runs.push({ y, x0: start, x1: x - 1 });
        start = -1;
      }
    }
    rows.push(runs);
  }
  // Stack overlapping runs on consecutive rows into rules; a stack thicker than a rule is a
  // filled shape (a plot area, a box), not a rule.
  const out: Rule[] = [];
  const maxRows = Math.max(1, Math.round(maxThickness * r.scale));
  const used = rows.map((rs) => rs.map(() => false));
  for (let y = 0; y < r.height; y++) {
    rows[y].forEach((run, i) => {
      if (used[y][i]) return;
      used[y][i] = true;
      let x0 = run.x0;
      let x1 = run.x1;
      let yEnd = y;
      for (let ny = y + 1; ny < r.height && ny - y <= maxRows + 1; ny++) {
        const k = rows[ny].findIndex((o, j) => !used[ny][j] && o.x0 <= x1 && o.x1 >= x0 && Math.min(o.x1, x1) - Math.max(o.x0, x0) > 0.7 * Math.min(o.x1 - o.x0, x1 - x0));
        if (k < 0) break;
        used[ny][k] = true;
        x0 = Math.min(x0, rows[ny][k].x0);
        x1 = Math.max(x1, rows[ny][k].x1);
        yEnd = ny;
      }
      if (yEnd - y + 1 > maxRows) return;
      out.push({ x0: x0 / r.scale, x1: (x1 + 1) / r.scale, y: (y + yEnd + 1) / 2 / r.scale, thickness: (yEnd - y + 1) / r.scale });
    });
  }
  return out;
}
