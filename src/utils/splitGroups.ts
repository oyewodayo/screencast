// utils/splitGroups.ts
//
// Rearranging a split screen after it's been made (see SplitMember, splitLayouts.ts): its layers
// laid out again for new settings (another layout, the divider moved, the gap or corners changed),
// with their shots moved round the cells, or for another frame shape (the canvas changed). Each
// shot keeps the framing it had - read back off its current crop (framingOfCrop) - so a hand-made
// crop survives a change of layout too.
import type { AdjustmentLayer, ClipCrop, ImageOverlay, PipOverlay } from "./videoEditTypes";
import { SPLIT_LAYOUTS, SplitGroupSettings, SplitMember, framingOfCrop, layoutSplitCell, splitCells, splitLayout } from "./splitLayouts";

// The layouts a split screen made before groups existed can have (all but the card, which came with them).
const SPLIT_LAYOUT_IDS = SPLIT_LAYOUTS.filter((l) => l.id !== "card").map((l) => l.id);
import { makeAdjustmentLayer } from "./adjustmentLayers";

// A split screen's backdrop: its gap colour over the whole frame, as an adjustment layer placed
// "under" - on the main video, beneath every video track - so the cells (picture-in-picture
// layers, which sit beneath pictures) show over it. A picture would cover them.
export function splitBackdrop(color: string, startTime: number, endTime: number, split?: SplitMember): AdjustmentLayer {
  return makeAdjustmentLayer(startTime, endTime, { name: "Split screen backdrop", fill: color, placement: "under", ...(split ? { split } : {}) });
}

// Edits saved while a split screen's backdrop was a full-frame colour picture (above its video
// cells, hiding them): those pictures become backdrops beneath the cells. One is recognised by its
// split membership, or - from before splits had one - as a full-frame rectangle running exactly
// as long as a picture-in-picture layer.
export function migrateSplitBackdrops(images: ImageOverlay[], pips: PipOverlay[], adjustments: AdjustmentLayer[]): { imageOverlays: ImageOverlay[]; adjustmentLayers: AdjustmentLayer[] } | null {
  const isBackdrop = (o: ImageOverlay) => {
    if (o.split) return o.split.cell < 0;
    const fullFrame = o.asset?.kind === "rectangle" && !o.src && o.x === 0 && o.y === 0 && o.width === 1 && o.height === 1;
    return fullFrame && pips.some((p) => Math.abs(p.startTime - o.startTime) < 1e-6 && Math.abs(p.endTime - o.endTime) < 1e-6);
  };
  const old = images.filter(isBackdrop);
  if (old.length === 0) return null;
  return {
    imageOverlays: images.filter((o) => !old.includes(o)),
    adjustmentLayers: [...old.map((o) => splitBackdrop(o.asset?.color ?? "#000000", o.startTime, o.endTime, o.split)), ...adjustments],
  };
}

export interface SplitChange {
  group: string;
  settings?: Partial<SplitGroupSettings>;
  // Every shot moves on one cell (the last to the first) - a swap, with two.
  rotate?: boolean;
}

const imageCrop = (o: ImageOverlay): ClipCrop | undefined =>
  o.cropWidth !== undefined && o.cropHeight !== undefined ? { x: o.cropX ?? 0, y: o.cropY ?? 0, width: o.cropWidth, height: o.cropHeight } : undefined;

// The members of each group, by group id.
export function splitGroupMembers(pips: PipOverlay[], images: ImageOverlay[], group: string): { pips: PipOverlay[]; images: ImageOverlay[]; cells: number; settings: SplitGroupSettings | null } {
  const p = pips.filter((o) => o.split?.group === group);
  const i = images.filter((o) => o.split?.group === group);
  const cells = [...p, ...i].filter((o) => (o.split?.cell ?? -1) >= 0).length;
  return { pips: p, images: i, cells, settings: (p[0] ?? i[0])?.split?.settings ?? null };
}

// Lays out again every group (or just `change.group`) for a frame `toAspect` wide - its layers were
// laid out for one `fromAspect` wide (the same unless the canvas changed).
export function relayoutSplitGroups(pips: PipOverlay[], images: ImageOverlay[], fromAspect: number, toAspect: number, change?: SplitChange): { pipOverlays: PipOverlay[]; imageOverlays: ImageOverlay[] } {
  const counts = new Map<string, number>();
  for (const o of [...pips, ...images]) if (o.split && o.split.cell >= 0) counts.set(o.split.group, (counts.get(o.split.group) ?? 0) + 1);
  const now = Date.now();
  const place = (split: SplitMember, box: { width: number; height: number }, crop: ClipCrop | undefined) => {
    const touched = !change || change.group === split.group;
    if (!touched || split.cell < 0) return null;
    const n = counts.get(split.group) ?? 1;
    const settings = { ...split.settings, ...(change?.settings ?? {}) };
    // A layout for a different number of shots can't take these - left as they are.
    if (splitLayout(settings.layout).cells !== n) return null;
    const cell = change?.rotate ? (split.cell + 1) % n : split.cell;
    const framing = framingOfCrop(split.shotAspect, (box.width / box.height) * fromAspect, crop);
    return { ...layoutSplitCell(settings, toAspect, cell, split.shotAspect, framing), split: { ...split, cell, settings } };
  };
  const pipOverlays = pips.map((o) => {
    if (!o.split) return o;
    const placed = place(o.split, o, o.crop);
    if (!placed) return o;
    const { rect, crop, mask, split } = placed;
    const corners = split.settings.corners;
    return {
      ...o,
      ...rect,
      crop,
      mask,
      shape: (corners > 0 ? "rounded" : "rectangle") as PipOverlay["shape"],
      cornerRadius: corners > 0 ? corners : undefined,
      split,
      updatedAt: now,
    };
  });
  const imageOverlays = images.map((o) => {
    if (!o.split) return o;
    // The backdrop: just the gap's colour.
    if (o.split.cell < 0) {
      if (change && change.group !== o.split.group) return o;
      const settings = { ...o.split.settings, ...(change?.settings ?? {}) };
      return { ...o, asset: o.asset ? { ...o.asset, color: settings.gapColor } : o.asset, split: { ...o.split, settings }, updatedAt: now };
    }
    const placed = place(o.split, o, imageCrop(o));
    if (!placed) return o;
    const { rect, crop, mask, split } = placed;
    const full = crop ?? { x: 0, y: 0, width: 1, height: 1 };
    return {
      ...o,
      ...rect,
      cropX: full.x,
      cropY: full.y,
      cropWidth: full.width,
      cropHeight: full.height,
      mask,
      // A picture's corner radius is a fraction of the frame's height, a cell's corners of its own.
      cornerRadius: split.settings.corners > 0 ? split.settings.corners * rect.height : undefined,
      split,
      updatedAt: now,
    };
  });
  return { pipOverlays, imageOverlays };
}

// ---- Timing: a split screen moves and trims as one ------------------------------------------

export interface SplitLayers {
  pipOverlays: PipOverlay[];
  imageOverlays: ImageOverlay[];
  adjustmentLayers: AdjustmentLayer[];
}

// After layer `id` was moved or trimmed on the timeline (`prev` -> `next`), the rest of its split
// screen - the other cells and the backdrop - get the same change: moved by as much, or trimmed at
// the same edge (a video cell trimming into its own source, as far as that source goes).
export function alignSplitTiming(prev: SplitLayers, next: SplitLayers, id: string): SplitLayers {
  const before = [...prev.pipOverlays, ...prev.imageOverlays].find((o) => o.id === id);
  const after = [...next.pipOverlays, ...next.imageOverlays].find((o) => o.id === id);
  if (!before?.split || before.split.cell < 0 || !after) return next;
  const group = before.split.group;
  const ds = after.startTime - before.startTime;
  const de = after.endTime - before.endTime;
  if (Math.abs(ds) < 1e-9 && Math.abs(de) < 1e-9) return next;
  const moved = Math.abs(ds - de) < 1e-9;
  const now = Date.now();
  const others = <T extends { id: string; split?: SplitMember }>(o: T) => o.id !== id && o.split?.group === group;
  return {
    pipOverlays: next.pipOverlays.map((o) => {
      if (!others(o)) return o;
      if (moved) return { ...o, startTime: o.startTime + ds, endTime: o.endTime + ds, updatedAt: now };
      // Trimmed: the start edge trims into the source (never before its beginning), the end edge
      // no further than the source has.
      const trimStart = Math.max(0, o.trimStart + ds);
      const startTime = o.startTime + (trimStart - o.trimStart);
      const endTime = Math.min(o.endTime + de, startTime + Math.max(0, o.sourceDuration - trimStart));
      return { ...o, startTime, endTime, trimStart, updatedAt: now };
    }),
    imageOverlays: next.imageOverlays.map((o) => (others(o) ? { ...o, startTime: o.startTime + ds, endTime: o.endTime + de, updatedAt: now } : o)),
    adjustmentLayers: next.adjustmentLayers.map((o) => (others(o) ? { ...o, startTime: o.startTime + ds, endTime: o.endTime + de, updatedAt: now } : o)),
  };
}

// A split screen with no cells left takes its backdrop with it.
export function dropOrphanBackdrops(layers: SplitLayers): SplitLayers {
  const live = new Set([...layers.pipOverlays, ...layers.imageOverlays].filter((o) => o.split && o.split.cell >= 0).map((o) => o.split!.group));
  const orphan = (o: { split?: SplitMember }) => !!o.split && o.split.cell < 0 && !live.has(o.split.group);
  if (!layers.adjustmentLayers.some(orphan) && !layers.imageOverlays.some(orphan)) return layers;
  return { ...layers, adjustmentLayers: layers.adjustmentLayers.filter((o) => !orphan(o)), imageOverlays: layers.imageOverlays.filter((o) => !orphan(o)) };
}

// ---- Split screens made before they could be rearranged -------------------------------------

// The shot's shape, read off the crop a cell shows it with (the crop has the cell's shape - see
// framingCrop); 0 when there's no crop to read it from (the layer then covers its cell centred,
// and keeps doing so - layoutSplitCell).
function shotAspectOf(crop: ClipCrop | undefined, cellAspect: number): number {
  return crop && crop.width > 0 && crop.height > 0 ? (cellAspect * crop.height) / crop.width : 0;
}

// Recognises split screens made before their layers carried a group: two to four picture-in-
// picture or picture layers running exactly as long as each other and lying exactly on the cells of
// one of the layouts (the backdrop - the colour beneath them - joining in). Returns the layers with
// their group filled in, or null when there's nothing to adopt. Only what matches a layout
// precisely, for a frame `frameAspect` wide, is taken - a set laid out for another frame shape is
// left alone.
export function adoptLegacySplits(layers: SplitLayers, frameAspect: number): SplitLayers | null {
  type Cell = PipOverlay | ImageOverlay;
  const key = (o: { startTime: number; endTime: number }) => `${o.startTime.toFixed(3)}|${o.endTime.toFixed(3)}`;
  const candidates: Cell[] = [...layers.pipOverlays.filter((o) => !o.split), ...layers.imageOverlays.filter((o) => !o.split && !!o.src && !o.asset)];
  const byTime = new Map<string, Cell[]>();
  for (const o of candidates) byTime.set(key(o), [...(byTime.get(key(o)) ?? []), o]);
  const shorter = Math.min(frameAspect, 1);
  const near = (a: number, b: number) => Math.abs(a - b) < 0.004;
  const isPip = (o: Cell): o is PipOverlay => "trimStart" in o;
  const cropOf = (o: Cell): ClipCrop | undefined =>
    isPip(o) ? o.crop : o.cropWidth !== undefined && o.cropHeight !== undefined ? { x: o.cropX ?? 0, y: o.cropY ?? 0, width: o.cropWidth, height: o.cropHeight } : undefined;
  const cornersOf = (o: Cell) => (isPip(o) ? (o.shape === "rounded" ? o.cornerRadius ?? 0.1 : 0) : o.cornerRadius ? o.cornerRadius / Math.max(1e-6, o.height) : 0);
  const adopted = new Map<string, SplitMember>();
  const backdrops = new Map<string, SplitMember>();
  for (const set of byTime.values()) {
    if (set.length < 2 || set.length > 4) continue;
    for (const layout of SPLIT_LAYOUT_IDS) {
      if (splitLayout(layout).cells !== set.length) continue;
      // The gap, from the outer margin (its width is gap * shorter side / frame width).
      const gap = Math.max(0, (Math.min(...set.map((o) => o.x)) * frameAspect) / shorter);
      const gy = gap * shorter;
      const gx = gy / frameAspect;
      // The divider, from the first cell's share of the room the gaps leave.
      const ratio =
        layout === "rows2"
          ? [...set].sort((a, b) => a.y - b.y)[0].height / (1 - 3 * gy)
          : layout === "cols2"
            ? [...set].sort((a, b) => a.x - b.x)[0].width / (1 - 3 * gx)
            : 0.5;
      const cells = splitCells(layout, frameAspect, gap, ratio);
      const cellOf = set.map((o) => cells.findIndex((c) => near(c.x, o.x) && near(c.y, o.y) && near(c.width, o.width) && near(c.height, o.height)));
      if (cellOf.some((c) => c < 0) || new Set(cellOf).size !== set.length) continue;
      const group = crypto.randomUUID();
      const backdrop = layers.adjustmentLayers.find((a) => !a.split && !!a.fill && key(a) === key(set[0]));
      const settings: SplitGroupSettings = {
        layout,
        ratio,
        gap,
        gapColor: backdrop?.fill ?? "#000000",
        corners: cornersOf(set[0]),
        feather: 0.06,
        cardSize: frameAspect < 1 ? 0.7 : 0.4,
        cardCentre: { x: 0.5, y: frameAspect < 1 ? 0.2 : 0.25 },
      };
      set.forEach((o, i) => adopted.set(o.id, { group, cell: cellOf[i], settings, shotAspect: shotAspectOf(cropOf(o), (o.width / o.height) * frameAspect) }));
      if (backdrop) backdrops.set(backdrop.id, { group, cell: -1, settings, shotAspect: 1 });
      break;
    }
  }
  if (adopted.size === 0) return null;
  return {
    pipOverlays: layers.pipOverlays.map((o) => (adopted.has(o.id) ? { ...o, split: adopted.get(o.id) } : o)),
    imageOverlays: layers.imageOverlays.map((o) => (adopted.has(o.id) ? { ...o, split: adopted.get(o.id) } : o)),
    adjustmentLayers: layers.adjustmentLayers.map((o) => (backdrops.has(o.id) ? { ...o, split: backdrops.get(o.id) } : o)),
  };
}
