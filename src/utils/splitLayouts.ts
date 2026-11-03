// utils/splitLayouts.ts
//
// Split-screen layouts - several shots playing at once in stacked rows, columns or a grid, or one
// shot floating as a card over the main video. Each cell becomes an ordinary picture-in-picture
// layer (PipOverlay, cover-fitted to its cell), so a split screen previews, exports, retimes and
// undoes exactly like any PiP - this file only works out where the cells go and which part of
// each shot they show.
//
// Rects are fractions of the frame (x/y top-left, like every overlay). The gap is a fraction of
// the frame's SHORTER side, so it looks the same width horizontally and vertically on any shape
// of frame.
import type { ClipCrop } from "./videoEditTypes";
import type { LayerMask } from "./layerMask";

export type SplitLayoutId = "rows2" | "cols2" | "card" | "rows3" | "cols3" | "grid4" | "feature" | "feature3";

export interface SplitLayout {
  id: SplitLayoutId;
  label: string;
  cells: number;
  // The cell the clip under the playhead fills (the speaker, kept in sync with the main video's
  // sound); -1 when the main video plays behind the cells instead (card).
  main: number;
  // Two cells with a divider that can be dragged (how much of the frame the first one gets).
  divider?: "row" | "col";
}

export const SPLIT_LAYOUTS: SplitLayout[] = [
  { id: "rows2", label: "Top & bottom", cells: 2, main: 1, divider: "row" },
  { id: "cols2", label: "Side by side", cells: 2, main: 0, divider: "col" },
  { id: "card", label: "Card on top", cells: 1, main: -1 },
  { id: "rows3", label: "3 stacked", cells: 3, main: 0 },
  { id: "cols3", label: "3 columns", cells: 3, main: 0 },
  { id: "grid4", label: "Grid", cells: 4, main: 0 },
  { id: "feature", label: "Feature + 2", cells: 3, main: 0 },
  { id: "feature3", label: "Feature + 3", cells: 4, main: 0 },
];

export const splitLayout = (id: SplitLayoutId): SplitLayout => SPLIT_LAYOUTS.find((l) => l.id === id)!;

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Where a dragged divider settles when it's let go near one of these.
export const DIVIDER_SNAPS = [1 / 3, 1 / 2, 2 / 3];
export const snapRatio = (ratio: number, within = 0.025): number => {
  const near = DIVIDER_SNAPS.find((s) => Math.abs(s - ratio) < within);
  return near ?? Math.min(0.8, Math.max(0.2, ratio));
};

// The first divider position for a frame: on a tall frame the top shot (the media over the
// speaker) gets a little under half, the way vertical commentary videos frame it.
export const defaultRatio = (layout: SplitLayoutId, frameAspect: number): number => (layout === "rows2" && frameAspect < 1 ? 0.4 : 0.5);

// Splits [0,1] into `n` equal spans separated (and edged) by `gap`.
const spans = (n: number, gap: number, start = 0, end = 1): [number, number][] => {
  const size = (end - start - gap * (n + 1)) / n;
  return Array.from({ length: n }, (_, i) => [start + gap + i * (size + gap), size]);
};

// Two spans, the first `ratio` of what the gaps leave.
const twoSpans = (gap: number, ratio: number): [number, number][] => {
  const room = 1 - 3 * gap;
  return [
    [gap, room * ratio],
    [2 * gap + room * ratio, room * (1 - ratio)],
  ];
};

// The cells of `layout` for a frame `frameAspect` (width/height) wide, `gap` apart; `ratio` is the
// divider's position for the two-cell layouts. The card's own rect is cardCell's - this gives a
// typical one, for the layout's thumbnail.
export function splitCells(layout: SplitLayoutId, frameAspect: number, gap: number, ratio = 0.5): CellRect[] {
  const shorter = Math.min(frameAspect, 1);
  // The gap in each axis's own fractions: gap * shorter side, over that axis's length.
  const gx = (gap * shorter) / frameAspect;
  const gy = gap * shorter;
  const portrait = frameAspect < 1;
  const rows = (n: number) => spans(n, gy).map(([y, h]) => ({ x: gx, y, width: 1 - 2 * gx, height: h }));
  const cols = (n: number) => spans(n, gx).map(([x, w]) => ({ x, y: gy, width: w, height: 1 - 2 * gy }));
  switch (layout) {
    case "rows2":
      return twoSpans(gy, ratio).map(([y, h]) => ({ x: gx, y, width: 1 - 2 * gx, height: h }));
    case "cols2":
      return twoSpans(gx, ratio).map(([x, w]) => ({ x, y: gy, width: w, height: 1 - 2 * gy }));
    case "card":
      return [cardCell(frameAspect, 16 / 9, portrait ? 0.7 : 0.4, { x: 0.5, y: portrait ? 0.2 : 0.25 })];
    case "rows3":
      return rows(3);
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

// A card: the whole shot (its own shape, nothing cropped) `size` of the frame wide, centred on
// `centre` and kept inside the frame. Shrinks to fit when the shot is too tall for that width.
export function cardCell(frameAspect: number, shotAspect: number, size: number, centre: { x: number; y: number }): CellRect {
  let width = size;
  let height = (width * frameAspect) / shotAspect;
  if (height > 0.9) {
    width *= 0.9 / height;
    height = 0.9;
  }
  const clamp = (v: number, span: number) => Math.min(1 - span, Math.max(0, v - span / 2));
  return { x: clamp(centre.x, width), y: clamp(centre.y, height), width, height };
}

// A layout for the frame's shape and number of shots: the speaker under the media on a tall frame,
// beside it on a wide one.
export function defaultSplitLayout(frameAspect: number, shots: number): SplitLayoutId {
  if (shots >= 4) return "grid4";
  if (frameAspect < 1) return shots >= 3 ? "rows3" : "rows2";
  return shots >= 3 ? "cols3" : "cols2";
}

// How a shot sits in its cell: the point of the shot (fractions of it) at the cell's centre, and
// how far it's zoomed in past just covering the cell.
export interface CellFraming {
  cx: number;
  cy: number;
  zoom: number;
}

export const CENTRED: CellFraming = { cx: 0.5, cy: 0.5, zoom: 1 };
export const MAX_CELL_ZOOM = 4;

// The share of a shot (shotAspect = its width/height) a cell (cellAspect, in pixels) shows when
// the shot covers it at `zoom` - fractions of the shot's width and height.
export function coverWindow(shotAspect: number, cellAspect: number, zoom = 1): { w: number; h: number } {
  const w = shotAspect > cellAspect ? cellAspect / shotAspect : 1;
  const h = shotAspect > cellAspect ? 1 : shotAspect / cellAspect;
  return { w: w / zoom, h: h / zoom };
}

// The part of the shot the cell shows (a crop with the cell's own shape, so the layer's cover-fit
// then leaves it as is), centred on the framing's point as far as the shot's edges allow.
export function framingCrop(shotAspect: number, cellAspect: number, framing: CellFraming): ClipCrop {
  const { w, h } = coverWindow(shotAspect, cellAspect, Math.min(MAX_CELL_ZOOM, Math.max(1, framing.zoom)));
  const x = Math.min(1 - w, Math.max(0, framing.cx - w / 2));
  const y = Math.min(1 - h, Math.max(0, framing.cy - h / 2));
  return { x, y, width: w, height: h };
}

// Soft edges for a card: a rectangle mask inset so its Gaussian fade (`feather` of the box's
// shorter side, layerMask.ts) has finished before the box's own edge - no hard line left there.
export function featherMask(boxWidthPx: number, boxHeightPx: number, feather: number): LayerMask {
  const shorter = Math.min(boxWidthPx, boxHeightPx);
  const ix = Math.min(0.3, (1.5 * feather * shorter) / Math.max(1, boxWidthPx));
  const iy = Math.min(0.3, (1.5 * feather * shorter) / Math.max(1, boxHeightPx));
  return { shape: "rectangle", x: ix, y: iy, width: 1 - 2 * ix, height: 1 - 2 * iy, feather, invert: false };
}

// ---- Split screens after they're made -------------------------------------------------------
//
// Every layer of a split screen remembers the group it belongs to, its cell, the group's settings
// and its shot's shape, so the whole thing can be rearranged at any time - another layout, shots
// swapped round, the divider moved, the canvas changed (splitGroups.ts) - with each shot keeping
// the framing it was given.

export interface SplitGroupSettings {
  layout: SplitLayoutId;
  // The divider's position (two-cell layouts).
  ratio: number;
  gap: number;
  gapColor: string;
  // Fraction of a cell's own height.
  corners: number;
  // The card's soft edges, size (fraction of the frame's width) and centre.
  feather: number;
  cardSize: number;
  cardCentre: { x: number; y: number };
}

export interface SplitMember {
  group: string;
  // The cell it fills; -1 = the colour backdrop behind the cells.
  cell: number;
  settings: SplitGroupSettings;
  // Its shot's width / height (what its cell crops it to); unused by the backdrop.
  shotAspect: number;
}

// Where cell `cell` of a group goes and what it shows of a shot `shotAspect` wide, framed at
// `framing` - for a frame `frameAspect` wide.
export function layoutSplitCell(settings: SplitGroupSettings, frameAspect: number, cell: number, shotAspect: number, framing: CellFraming): { rect: CellRect; crop?: ClipCrop; mask?: LayerMask } {
  if (settings.layout === "card") {
    const rect = cardCell(frameAspect, shotAspect, settings.cardSize, settings.cardCentre);
    return { rect, mask: settings.feather > 0 ? featherMask(rect.width * frameAspect, rect.height, settings.feather) : undefined };
  }
  const rect = splitCells(settings.layout, frameAspect, settings.gap, settings.ratio)[cell];
  // A shot of unknown shape (a split screen adopted from before groups) just covers its cell, centred.
  if (!(shotAspect > 0)) return { rect };
  return { rect, crop: framingCrop(shotAspect, (rect.width / rect.height) * frameAspect, framing) };
}

// The framing a crop amounts to in a cell `cellAspect` wide (the inverse of framingCrop) - so a
// shot re-laid out keeps showing what it showed, however it was framed (in the split-screen
// panel, or with its own crop tool afterwards).
export function framingOfCrop(shotAspect: number, cellAspect: number, crop: ClipCrop | undefined): CellFraming {
  if (!crop || !(shotAspect > 0)) return CENTRED;
  const base = coverWindow(shotAspect, cellAspect);
  const zoom = Math.max(1, Math.min(MAX_CELL_ZOOM, Math.max(base.w / Math.max(1e-6, crop.width), base.h / Math.max(1e-6, crop.height))));
  return { cx: crop.x + crop.width / 2, cy: crop.y + crop.height / 2, zoom };
}
