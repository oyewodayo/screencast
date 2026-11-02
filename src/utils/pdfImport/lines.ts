// utils/pdfImport/lines.ts
//
// Glyphs -> text lines -> line segments. A "line" here is what a reader would call one: a run of
// glyphs on a common baseline, with its sub- and superscripts attached (a subscript sits ~0.1 em
// lower, a superscript ~0.35 em higher, both smaller) - but not a fraction's numerator or
// denominator, which are full-size and further away and belong to their own lines until the
// equation stage assembles them. Lines are then cut into segments at large horizontal gaps: the
// gutter between two columns, the space between table cells, the run of space before an
// equation number.
import type { Glyph } from "./glyphs";

export interface Segment {
  glyphs: Glyph[]; // sorted by x, spaces included
  x0: number; // pen extent of the visible glyphs
  x1: number;
  base: number; // main baseline
  size: number; // main font size
  top: number; // ink extent including scripts
  bottom: number;
  // Index of the baseline cluster this segment was cut from - segments of one visual line share it.
  lineId: number;
}

const visible = (g: Glyph) => !g.space;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface Cluster {
  glyphs: Glyph[];
  base: number;
  size: number; // dominant size (by visible glyph count)
  x0: number;
  x1: number;
}

function stats(glyphs: Glyph[]): Omit<Cluster, "glyphs"> {
  const vis = glyphs.filter(visible);
  const use = vis.length > 0 ? vis : glyphs;
  // The line's own size: the largest size with real presence. Not the most common one - in "H_ij"
  // the two subscript letters outnumber the H. Big operators (extension font) don't count.
  const counts = new Map<number, number>();
  for (const g of use) {
    if (g.font.role === "extension") continue;
    const s = Math.round(g.size * 10) / 10;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  if (counts.size === 0) for (const g of use) counts.set(Math.round(g.size * 10) / 10, 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  let size = 0;
  for (const [s, c] of counts) if (s > size && c >= Math.max(1, 0.15 * total)) size = s;
  if (size === 0) size = Math.max(...counts.keys());
  const main = use.filter((g) => Math.abs(g.size - size) < 0.05 * size);
  return {
    base: median(main.map((g) => g.base)),
    size,
    x0: Math.min(...use.map((g) => g.x)),
    x1: Math.max(...use.map((g) => g.x + g.adv)),
  };
}

export function buildSegments(glyphs: Glyph[]): Segment[] {
  const flowing = glyphs.filter((g) => g.adv > 0 || g.space);
  // 1. Runs: glyphs of one pdf.js item share a baseline and size.
  const runs = new Map<number, Glyph[]>();
  for (const g of flowing) {
    if (g.adv === 0 && g.space && !/\s/.test(g.ch)) continue; // rotated glyph
    const arr = runs.get(g.item) ?? [];
    arr.push(g);
    runs.set(g.item, arr);
  }
  // 2. Baseline clusters: runs on (nearly) the same baseline and size class, horizontally near.
  //    Runs are taken left to right and matched against every compatible cluster - baselines that
  //    are "equal" differ in the last decimals, so any ordering by baseline first would visit a
  //    line's pieces out of order and strand them in separate clusters.
  const compatible = (c: Omit<Cluster, "glyphs">, r: Omit<Cluster, "glyphs">) =>
    Math.abs(c.base - r.base) <= 0.22 * Math.min(c.size, r.size) && Math.abs(c.size - r.size) < 0.12 * Math.max(c.size, r.size);
  const gapBetween = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) => Math.max(a.x0 - b.x1, b.x0 - a.x1);
  const sortedRuns = [...runs.values()].filter((r) => r.length > 0).sort((a, b) => a[0].x - b[0].x);
  let clusters: Cluster[] = [];
  for (const run of sortedRuns) {
    const r = stats(run);
    let target: Cluster | null = null;
    let bestGap = Infinity;
    for (const c of clusters) {
      if (!compatible(c, r)) continue;
      const gap = gapBetween(c, r);
      if (gap < 3 * r.size && gap < bestGap) {
        bestGap = gap;
        target = c;
      }
    }
    if (target) {
      target.glyphs.push(...run);
      Object.assign(target, stats(target.glyphs));
    } else clusters.push({ glyphs: [...run], ...r });
  }
  // Join clusters that ended up side by side on one baseline.
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (compatible(clusters[i], clusters[j]) && gapBetween(clusters[i], clusters[j]) < 3 * clusters[i].size) {
          clusters[i].glyphs.push(...clusters[j].glyphs);
          Object.assign(clusters[i], stats(clusters[i].glyphs));
          clusters = clusters.filter((_, k) => k !== j);
          changed = true;
          break outer;
        }
      }
    }
  }
  // 3. Attach scripts: a smaller cluster next to a larger one, raised or lowered by script
  //    amounts, joins it. Repeat for scripts of scripts.
  let merged = true;
  while (merged) {
    merged = false;
    clusters.sort((a, b) => a.size - b.size);
    for (let i = 0; i < clusters.length && !merged; i++) {
      const s = clusters[i];
      let best: Cluster | null = null;
      let bestScore = Infinity;
      for (const c of clusters) {
        if (c === s || c.size < s.size * 1.15) continue;
        const dy = s.base - c.base; // >0: script below the base line
        if (dy < -0.62 * c.size || dy > 0.42 * c.size) continue;
        // Horizontally: overlapping, or abutting within half an em.
        const gap = Math.max(c.x0 - s.x1, s.x0 - c.x1);
        if (gap > 0.6 * c.size) continue;
        // The script must sit beside or after some glyph of the base cluster at its height.
        const score = Math.abs(dy) + Math.max(0, gap);
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (best) {
        best.glyphs.push(...s.glyphs);
        Object.assign(best, stats(best.glyphs));
        clusters.splice(clusters.indexOf(s), 1);
        merged = true;
      }
    }
  }
  // 3b. Accents set as separate glyphs (a macron over f, a hat over a vector) belong with the
  //     glyph they sit on, whatever their size: join an accent-only cluster to the cluster of the
  //     glyph just below it.
  //     The over-arrows of \overrightarrow / \overleftrightarrow (D⃡, D⃖) count too. One cluster can
  //     hold the accents of several letters along a line ("D⃡_ν ≡ D⃗_ν − D⃖_ν"), so each accent goes
  //     to the letter it sits on.
  const ACCENT = /^[¯ˉ‾ˆ^˜~˙¨ˇ´`˘→⃗←⃖↔⃡⟶⟵⟷⇀↼]$/;
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const vis = c.glyphs.filter(visible);
    // A long over-arrow is built from an arrowhead and extender rules ("←" + "−").
    const hasArrow = vis.some((g) => /[←→↔⟵⟶⟷⇀↼]/.test(g.ch));
    if (vis.length === 0 || !vis.every((g) => ACCENT.test(g.ch) || (hasArrow && /^[−-]$/.test(g.ch)))) continue;
    // The host: the nearest glyph right under the accent - a letter or symbol, never punctuation
    // (a hyphen sits low and would otherwise look closest).
    const hostOf = (a: Glyph) => {
      let best: Cluster | null = null;
      let bestGap = Infinity;
      for (const o of clusters) {
        if (o === c) continue;
        for (const g of o.glyphs) {
          if (g.space || ACCENT.test(g.ch) || /^[-‐–—.,;:'’]$/.test(g.ch)) continue;
          if (!(g.x < a.x + a.adv && g.x + g.adv > a.x)) continue;
          const gap = g.top - a.bottom;
          if (gap >= -1.5 && gap < 0.9 * g.size && gap < bestGap) {
            bestGap = gap;
            best = o;
          }
        }
      }
      return best;
    };
    const moved = new Set<Glyph>();
    for (const a of vis) {
      const host = hostOf(a);
      if (host) {
        host.glyphs.push(a);
        moved.add(a);
      }
    }
    if (moved.size === 0) continue;
    c.glyphs = c.glyphs.filter((g) => !moved.has(g));
    if (!c.glyphs.some(visible)) {
      clusters.splice(i, 1);
      i--;
    }
  }
  // 4. Segments: cut each cluster at large horizontal gaps between visible glyphs.
  const segments: Segment[] = [];
  clusters.sort((a, b) => a.base - b.base || a.x0 - b.x0);
  clusters.forEach((c, lineId) => {
    const gs = [...c.glyphs].sort((a, b) => a.x - b.x || a.base - b.base);
    let current: Glyph[] = [];
    let lastEnd = -Infinity;
    const flush = () => {
      const vis = current.filter(visible);
      if (vis.length === 0) {
        current = [];
        return;
      }
      // Trim leading/trailing spaces.
      while (current.length && current[0].space) current.shift();
      while (current.length && current[current.length - 1].space) current.pop();
      const st = stats(current);
      segments.push({
        glyphs: current,
        x0: Math.min(...vis.map((g) => g.x)),
        x1: Math.max(...vis.map((g) => g.x + g.adv)),
        base: st.base,
        size: st.size,
        top: Math.min(...vis.map((g) => g.top)),
        bottom: Math.max(...vis.map((g) => g.bottom)),
        lineId,
      });
      current = [];
    };
    const splitGap = Math.max(1.15 * c.size, 9);
    for (const g of gs) {
      if (!g.space && current.some(visible) && g.x - lastEnd > splitGap) flush();
      current.push(g);
      if (!g.space) lastEnd = Math.max(lastEnd, g.x + g.adv);
    }
    flush();
  });
  return segments.sort((a, b) => a.base - b.base || a.x0 - b.x0);
}

export function segmentText(seg: Segment): string {
  let out = "";
  let lastEnd: number | null = null;
  for (const g of seg.glyphs) {
    if (g.space) {
      if (!out.endsWith(" ")) out += " ";
      lastEnd = g.x + g.adv;
      continue;
    }
    if (lastEnd !== null && g.x - lastEnd > 0.18 * g.size && !out.endsWith(" ")) out += " ";
    out += g.ch;
    lastEnd = g.x + g.adv;
  }
  return out;
}
