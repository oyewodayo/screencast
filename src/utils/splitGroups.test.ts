import { describe, expect, it } from "vitest";
import { adoptLegacySplits, alignSplitTiming, dropOrphanBackdrops, relayoutSplitGroups, splitBackdrop, type SplitLayers } from "./splitGroups";
import { SplitGroupSettings, SplitMember, splitCells } from "./splitLayouts";
import type { ImageOverlay, PipOverlay } from "./videoEditTypes";

const settings: SplitGroupSettings = { layout: "rows2", ratio: 0.4, gap: 0.01, gapColor: "#000000", corners: 0, feather: 0.06, cardSize: 0.7, cardCentre: { x: 0.5, y: 0.2 } };
const member = (cell: number): SplitMember => ({ group: "g", cell, settings, shotAspect: 16 / 9 });
const pip = (over: Partial<PipOverlay>): PipOverlay =>
  ({ id: "p", sourcePath: "a.mp4", x: 0, y: 0, width: 1, height: 0.5, shape: "rectangle", trimStart: 10, sourceDuration: 20, startTime: 5, endTime: 10, volume: 1, createdAt: 0, updatedAt: 0, ...over }) as PipOverlay;
const picture = (over: Partial<ImageOverlay>): ImageOverlay => ({ id: "i", src: "b.jpg", x: 0, y: 0.5, width: 1, height: 0.5, opacity: 1, startTime: 5, endTime: 10, createdAt: 0, updatedAt: 0, ...over }) as ImageOverlay;

const split = (): SplitLayers => ({
  pipOverlays: [pip({ id: "a", split: member(0) }), pip({ id: "other", startTime: 5, endTime: 10 })],
  imageOverlays: [picture({ id: "b", split: member(1) })],
  adjustmentLayers: [{ ...splitBackdrop("#000000", 5, 10, member(-1)), id: "bg" }],
});

describe("alignSplitTiming", () => {
  it("moves the whole split screen with one of its cells", () => {
    const prev = split();
    const next = { ...prev, imageOverlays: prev.imageOverlays.map((o) => ({ ...o, startTime: 8, endTime: 13 })) };
    const out = alignSplitTiming(prev, next, "b");
    expect(out.pipOverlays.find((o) => o.id === "a")).toMatchObject({ startTime: 8, endTime: 13, trimStart: 10 });
    expect(out.adjustmentLayers[0]).toMatchObject({ startTime: 8, endTime: 13 });
    // Not in the split screen: left where it was.
    expect(out.pipOverlays.find((o) => o.id === "other")).toMatchObject({ startTime: 5, endTime: 10 });
  });

  it("trims the start edge into every video cell's source", () => {
    const prev = split();
    const next = { ...prev, imageOverlays: prev.imageOverlays.map((o) => ({ ...o, startTime: 7 })) };
    const out = alignSplitTiming(prev, next, "b");
    expect(out.pipOverlays.find((o) => o.id === "a")).toMatchObject({ startTime: 7, endTime: 10, trimStart: 12 });
    expect(out.adjustmentLayers[0]).toMatchObject({ startTime: 7, endTime: 10 });
  });

  it("stretches the end no further than a video cell's source has", () => {
    const prev = split();
    const next = { ...prev, imageOverlays: prev.imageOverlays.map((o) => ({ ...o, endTime: 30 })) };
    const out = alignSplitTiming(prev, next, "b");
    // trimStart 10 of a 20 s source: 10 s of it from its start at 5.
    expect(out.pipOverlays.find((o) => o.id === "a")!.endTime).toBe(15);
  });
});

describe("dropOrphanBackdrops", () => {
  it("drops a backdrop once its split screen has no cells", () => {
    const layers = split();
    expect(dropOrphanBackdrops({ ...layers, pipOverlays: layers.pipOverlays.filter((o) => o.id !== "a") }).adjustmentLayers).toHaveLength(1);
    expect(dropOrphanBackdrops({ ...layers, pipOverlays: [], imageOverlays: [] }).adjustmentLayers).toHaveLength(0);
  });
});

describe("adoptLegacySplits", () => {
  const aspect = 16 / 9;
  it("recognises an old side-by-side split and its backdrop, then lets it be rearranged", () => {
    const [l, r] = splitCells("cols2", aspect, 0.012, 0.5);
    const layers: SplitLayers = {
      pipOverlays: [pip({ id: "l", ...l, crop: { x: 0.25, y: 0, width: 0.5, height: 1 } }), pip({ id: "r", ...r })],
      imageOverlays: [],
      adjustmentLayers: [{ ...splitBackdrop("#ffffff", 5, 10), id: "bg" }],
    };
    const out = adoptLegacySplits(layers, aspect)!;
    const [a, b] = out.pipOverlays;
    expect(a.split).toMatchObject({ cell: 0, settings: { layout: "cols2", gapColor: "#ffffff" } });
    expect(a.split!.settings.gap).toBeCloseTo(0.012);
    // The shape read back off its crop; none to read for the other.
    expect(a.split!.shotAspect).toBeCloseTo(aspect, 1);
    expect(b.split).toMatchObject({ cell: 1, shotAspect: 0 });
    expect(out.adjustmentLayers[0].split).toMatchObject({ cell: -1, group: a.split!.group });
    // Now it rearranges like any split screen: the shot of unknown shape just covers its cell.
    const swapped = relayoutSplitGroups(out.pipOverlays, [], aspect, aspect, { group: a.split!.group, settings: { layout: "rows2" } }).pipOverlays;
    expect(swapped[0].width).toBeCloseTo(1 - 2 * ((0.012 * 1) / aspect));
    expect(swapped[1].crop).toBeUndefined();
  });

  it("leaves layers that don't sit on a layout's cells", () => {
    const layers: SplitLayers = { pipOverlays: [pip({ id: "x", x: 0.1, y: 0.1, width: 0.3, height: 0.3 }), pip({ id: "y", x: 0.5, y: 0.5, width: 0.3, height: 0.3 })], imageOverlays: [], adjustmentLayers: [] };
    expect(adoptLegacySplits(layers, aspect)).toBeNull();
  });
});
