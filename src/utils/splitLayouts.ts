// utils/splitLayouts.ts
//
// Split-screen layouts - several shots playing at once in stacked rows, columns or a grid. Each
// cell becomes an ordinary picture-in-picture layer (PipOverlay, cover-fitted to its cell), so a
// split screen previews, exports, retimes and undoes exactly like any PiP - this file only works
// out where the cells go.
//
// Rects are fractions of the frame (x/y top-left, like every overlay). The gap is a fraction of
// the frame's SHORTER side, so it looks the same width horizontally and vertically on any shape
// of frame.

export type SplitLayoutId = "rows2" | "rows3" | "cols2" | "cols3" | "grid4" | "feature" | "feature3";

export interface SplitLayout {
  id: SplitLayoutId;
  label: string;
  cells: number;
}

export const SPLIT_LAYOUTS: SplitLayout[] = [
  { id: "rows2", label: "2 stacked", cells: 2 },
  { id: "rows3", label: "3 stacked", cells: 3 },
  { id: "cols2", label: "Side by side", cells: 2 },
  { id: "cols3", label: "3 columns", cells: 3 },
  { id: "grid4", label: "Grid", cells: 4 },
  { id: "feature", label: "Feature + 2", cells: 3 },
  { id: "feature3", label: "Feature + 3", cells: 4 },
];

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Splits [0,1] into `n` equal spans separated (and edged) by `gap`.
const spans = (n: number, gap: number, start = 0, end = 1): [number, number][] => {
  const size = (end - start - gap * (n + 1)) / n;
  return Array.from({ length: n }, (_, i) => [start + gap + i * (size + gap), size]);
};

// The cells of `layout` for a frame `frameAspect` (width/height) wide, `gap` apart.
export function splitCells(layout: SplitLayoutId, frameAspect: number, gap: number): CellRect[] {
  const shorter = Math.min(frameAspect, 1);
  // The gap in each axis's own fractions: gap * shorter side, over that axis's length.
  const gx = (gap * shorter) / frameAspect;
  const gy = gap * shorter;
  const portrait = frameAspect < 1;
  const rows = (n: number) => spans(n, gy).map(([y, h]) => ({ x: gx, y, width: 1 - 2 * gx, height: h }));
  const cols = (n: number) => spans(n, gx).map(([x, w]) => ({ x, y: gy, width: w, height: 1 - 2 * gy }));
  switch (layout) {
    case "rows2":
      return rows(2);
    case "rows3":
      return rows(3);
    case "cols2":
      return cols(2);
    case "cols3":
      return cols(3);
    case "grid4": {
      const xs = spans(2, gx);
      const ys = spans(2, gy);
      return ys.flatMap(([y, h]) => xs.map(([x, w]) => ({ x, y, width: w, height: h })));
    }
    case "feature":
    case "feature3": {
      // One big shot (two thirds) and the rest in a strip beside it - below it on a tall frame.
      const others = layout === "feature" ? 2 : 3;
      if (portrait) {
        const split = gy + (1 - 3 * gy) * (2 / 3);
        const strip = spans(others, gx).map(([x, w]) => ({ x, y: split + gy, width: w, height: 1 - split - 2 * gy }));
        return [{ x: gx, y: gy, width: 1 - 2 * gx, height: split - gy }, ...strip];
      }
      const split = gx + (1 - 3 * gx) * (2 / 3);
      const strip = spans(others, gy).map(([y, h]) => ({ x: split + gx, y, width: 1 - split - 2 * gx, height: h }));
      return [{ x: gx, y: gy, width: split - gx, height: 1 - 2 * gy }, ...strip];
    }
  }
}

// A sensible first layout for the frame's shape and number of shots.
export function defaultSplitLayout(frameAspect: number, shots: number): SplitLayoutId {
  if (shots >= 4) return "grid4";
  if (frameAspect < 1) return shots >= 3 ? "rows3" : "rows2";
  return shots >= 3 ? "cols3" : "cols2";
}
