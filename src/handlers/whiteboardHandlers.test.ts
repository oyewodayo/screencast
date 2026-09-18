import { describe, expect, it } from "vitest";
import { colormapPalette, sampleColormap, COLORMAP_NAMES } from "../utils/colormaps";
import {
  createDefaultWhiteboardNode,
  createImageWhiteboardNode,
  hasImageCrop,
  naturalImageSize,
  resolveImageCrop,
  resolveSeriesData,
  DEFAULT_IMAGE_MAX_EDGE,
  DEFAULT_SERIES_OFFSET,
  MAX_SERIES_COUNT,
  WhiteboardNode,
} from "../utils/whiteboardTypes";
import { alignNodes, arrangeNodesInGrid, distributeNodes, imageDestRect, shapeOutlineFor } from "./whiteboardHandlers";

// Pulls every (x, y) coordinate pair out of an SVG path `d` string of the "M x,y L x,y ..." form
// every chart outline in whiteboardHandlers builds.
function pathPoints(d: string): { x: number; y: number }[] {
  return [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
}

function makeNode(overrides: Partial<WhiteboardNode> = {}): WhiteboardNode {
  return { ...createDefaultWhiteboardNode("n1", "waterfallChart", 0, 0), ...overrides };
}

describe("colormaps", () => {
  it("returns a hex color at both ends and in between for every map", () => {
    for (const name of COLORMAP_NAMES) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        expect(sampleColormap(name, t)).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("clamps out-of-range and non-finite positions instead of throwing", () => {
    expect(sampleColormap("viridis", -5)).toBe(sampleColormap("viridis", 0));
    expect(sampleColormap("viridis", 5)).toBe(sampleColormap("viridis", 1));
    expect(sampleColormap("viridis", NaN)).toBe(sampleColormap("viridis", 0));
  });

  it("gives a single-series palette the map's midpoint, not its dark first stop", () => {
    expect(colormapPalette("viridis", 1)).toEqual([sampleColormap("viridis", 0.5)]);
  });

  it("reverses end to end", () => {
    const forward = colormapPalette("turbo", 5);
    const reversed = colormapPalette("turbo", 5, true);
    expect(reversed).toEqual([...forward].reverse());
  });
});

describe("resolveSeriesData", () => {
  it("drops non-finite samples and empty traces", () => {
    const resolved = resolveSeriesData({ seriesData: [[1, NaN, 3], [], [Infinity, 2]] });
    expect(resolved.series).toEqual([[1, 3], [2]]);
  });

  it("falls back to the sample stack when every trace is unusable", () => {
    const resolved = resolveSeriesData({ seriesData: [[], [NaN]] });
    expect(resolved.series.length).toBeGreaterThan(1);
  });

  it("gives a completely flat trace a nominal window rather than a zero-height one", () => {
    const resolved = resolveSeriesData({ seriesData: [[5, 5, 5]] });
    expect(resolved.yMax).toBeGreaterThan(resolved.yMin);
  });

  it("stacks by a multiple of one trace's own amplitude", () => {
    const resolved = resolveSeriesData({ seriesData: [[0, 10], [0, 10], [0, 10]], seriesOffset: 1 });
    expect(resolved.offsetStep).toBe(10);
    // Three traces: the top one's baseline is lifted 2 full amplitudes above the bottom one's.
    expect(resolved.stackedYMax).toBe(30);
    expect(resolved.stackedYMin).toBe(0);
  });

  it("collapses to a shared baseline at offset 0", () => {
    const resolved = resolveSeriesData({ seriesData: [[0, 10], [0, 4]], seriesOffset: 0 });
    expect(resolved.offsetStep).toBe(0);
    expect(resolved.stackedYMax).toBe(resolved.yMax);
  });

  it("keeps relative amplitudes honest by scaling every trace against one shared range", () => {
    const resolved = resolveSeriesData({ seriesData: [[0, 100], [0, 1]] });
    expect(resolved.yMin).toBe(0);
    expect(resolved.yMax).toBe(100);
  });

  it("caps the trace count", () => {
    const tooMany = Array.from({ length: MAX_SERIES_COUNT + 50 }, () => [1, 2, 3]);
    expect(resolveSeriesData({ seriesData: tooMany }).series.length).toBe(MAX_SERIES_COUNT);
  });

  it("labels the x axis by sample index when no units are given", () => {
    const resolved = resolveSeriesData({ seriesData: [[1, 2, 3, 4, 5]] });
    expect(resolved.xMin).toBe(0);
    expect(resolved.xMax).toBe(4);
  });

  it("uses per-trace color overrides but falls back to the colormap for the rest", () => {
    const resolved = resolveSeriesData({ seriesData: [[1], [2], [3]], seriesColors: [null, "#ff0000"] });
    expect(resolved.colors[1]).toBe("#ff0000");
    expect(resolved.colors[0]).toMatch(/^#[0-9a-f]{6}$/);
    expect(resolved.colors[2]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("defaults the offset when absent", () => {
    const resolved = resolveSeriesData({ seriesData: [[0, 1], [0, 1]] });
    expect(resolved.offsetStep).toBeCloseTo(DEFAULT_SERIES_OFFSET, 10);
  });
});

describe("waterfall outline decimation", () => {
  // The property that justifies min/max decimation over plain stride sampling: a spectral line only
  // a couple of samples wide must still reach its true height after decimation. Stride sampling
  // drops it entirely whenever the spike falls between two strides, which is exactly the feature a
  // spectroscopist is looking at.
  it("preserves a one-sample spike that stride sampling would skip", () => {
    const trace = Array.from({ length: 10000 }, () => 0);
    trace[5001] = 100;
    const outline = shapeOutlineFor("waterfallChart", 300, 200, {
      seriesData: [trace],
      seriesOffset: 0,
      showChartLabels: false,
    });
    expect(outline.kind).toBe("chart");
    if (outline.kind !== "chart") return;
    const series = outline.parts.filter((p) => p.role === "series");
    expect(series).toHaveLength(1);
    const ys = pathPoints(series[0].d).map((p) => p.y);
    const baselineY = Math.max(...ys);
    const peakY = Math.min(...ys);
    // The peak maps to a SMALLER y pixel than the baseline (screen y grows downward), and must span
    // essentially the whole plot height since the data is 0 everywhere except the spike.
    expect(baselineY - peakY).toBeGreaterThan(150);
  });

  it("caps the drawn vertex count regardless of how dense the source data is", () => {
    const dense = Array.from({ length: 20000 }, (_, i) => Math.sin(i / 50));
    const outline = shapeOutlineFor("waterfallChart", 300, 200, { seriesData: [dense], seriesOffset: 0, showChartLabels: false });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    const series = outline.parts.find((p) => p.role === "series");
    expect(series).toBeDefined();
    // Roughly two vertices per half-pixel of plot width - far below the 20,000 source samples.
    expect(pathPoints(series!.d).length).toBeLessThan(2000);
  });

  it("leaves a short trace undecimated", () => {
    const short = [0, 5, 2, 8, 1];
    const outline = shapeOutlineFor("waterfallChart", 300, 200, { seriesData: [short], seriesOffset: 0, showChartLabels: false });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    const series = outline.parts.find((p) => p.role === "series");
    expect(pathPoints(series!.d)).toHaveLength(short.length);
  });

  it("gives each trace its own color and draws the bottom trace first", () => {
    const outline = shapeOutlineFor("waterfallChart", 300, 200, { seriesData: [[0, 1], [0, 1], [0, 1]], showChartLabels: false });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    const series = outline.parts.filter((p): p is Extract<typeof p, { role: "series" }> => p.role === "series");
    expect(series).toHaveLength(3);
    expect(new Set(series.map((s) => s.color)).size).toBe(3);
    // Trace 0 sits at the bottom of the stack, so its points have the LARGEST y pixels.
    const firstY = Math.max(...pathPoints(series[0].d).map((p) => p.y));
    const lastY = Math.max(...pathPoints(series[2].d).map((p) => p.y));
    expect(firstY).toBeGreaterThan(lastY);
  });
});

describe("adaptive tick density", () => {
  const xTickCount = (w: number, h: number) => {
    const outline = shapeOutlineFor("waterfallChart", w, h, {
      seriesData: [[0, 100]],
      seriesXMin: 0,
      seriesXMax: 2000,
      fontSize: 11,
    });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    // x tick labels are the ones anchored "middle"; y ticks are anchored "end".
    return (outline.labels ?? []).filter((l) => l.anchor === "middle").length;
  };

  // Five wide numbers ("1499.25") across a narrow panel overlap into an unreadable smear - exactly
  // the size a panel ends up at once several are arranged into a subplot grid.
  it("thins x ticks on a narrow plot and restores them on a wide one", () => {
    const narrow = xTickCount(220, 300);
    const wide = xTickCount(1000, 300);
    expect(narrow).toBeLessThan(wide);
    expect(narrow).toBeGreaterThanOrEqual(2);
    expect(wide).toBe(5);
  });

  it("thins y ticks on a short plot", () => {
    const short = shapeOutlineFor("waterfallChart", 400, 70, { seriesData: [[0, 100]], fontSize: 11 });
    const tall = shapeOutlineFor("waterfallChart", 400, 400, { seriesData: [[0, 100]], fontSize: 11 });
    if (short.kind !== "chart" || tall.kind !== "chart") throw new Error("expected chart outlines");
    const yCount = (o: typeof short) => (o.kind === "chart" ? (o.labels ?? []).filter((l) => l.anchor === "end").length : 0);
    expect(yCount(short)).toBeLessThan(yCount(tall));
  });

  it("still honours an explicitly set tick interval", () => {
    const outline = shapeOutlineFor("waterfallChart", 220, 300, { seriesData: [[0, 100]], seriesXMin: 0, seriesXMax: 10, seriesXTickInterval: 1, fontSize: 11 });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    expect((outline.labels ?? []).filter((l) => l.anchor === "middle").length).toBe(11);
  });
});

describe("chart titles and annotations", () => {
  it("leaves an untitled chart with no oversized tick labels unshifted", () => {
    const outline = shapeOutlineFor("graph", 300, 200, {});
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    expect(outline.inset).toBeUndefined();
    expect(outline.overlayLabels).toBeUndefined();
  });

  // A waterfall's y ticks are stacked totals, so they get wide ("1090.83") and are drawn to the LEFT
  // of the axis - without a gutter sized to them they run off the node's left edge and clip.
  it("reserves a left gutter wide enough for a waterfall's own y tick numbers", () => {
    const big = Array.from({ length: 20 }, () => [0, 100]);
    const outline = shapeOutlineFor("waterfallChart", 300, 200, { seriesData: big, fontSize: 11 });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    expect(outline.inset?.dx ?? 0).toBeGreaterThan(20);
    // No captions were set, so the gutter is the ONLY margin - nothing is reserved top or bottom.
    expect(outline.inset?.dy ?? 0).toBe(0);
    expect(outline.overlayLabels).toBeUndefined();
  });

  it("drops the tick gutter when the numbers are turned off", () => {
    const big = Array.from({ length: 20 }, () => [0, 100]);
    const outline = shapeOutlineFor("waterfallChart", 300, 200, { seriesData: big, fontSize: 11, showChartLabels: false });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    expect(outline.inset).toBeUndefined();
  });

  it("keeps the y caption clear of the tick numbers it describes", () => {
    const big = Array.from({ length: 20 }, () => [0, 100]);
    const outline = shapeOutlineFor("waterfallChart", 400, 260, { seriesData: big, fontSize: 11, axisYTitle: "Intensity" });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    const caption = outline.overlayLabels?.find((l) => l.text === "Intensity");
    expect(caption).toBeDefined();
    // The caption sits in its own share of the margin, left of where the tick numbers end.
    expect(caption!.x).toBeLessThan(outline.inset!.dx);
  });

  it("reserves margins and emits title captions when titles are set", () => {
    const outline = shapeOutlineFor("waterfallChart", 300, 200, {
      seriesData: [[0, 1]],
      chartTitle: "Measurement",
      axisXTitle: "Wavenumber",
      axisYTitle: "Intensity",
      fontSize: 10,
    });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    expect(outline.inset?.dx).toBeGreaterThan(0);
    expect(outline.inset?.dy).toBeGreaterThan(0);
    const texts = outline.overlayLabels?.map((l) => l.text) ?? [];
    expect(texts).toContain("Measurement");
    expect(texts).toContain("Wavenumber");
    expect(texts).toContain("Intensity");
    // The y caption reads bottom-to-top up the left edge.
    expect(outline.overlayLabels?.find((l) => l.text === "Intensity")?.rotate).toBe(-90);
  });

  it("only reserves a margin for the titles that are actually set", () => {
    const outline = shapeOutlineFor("graph", 300, 200, { axisXTitle: "t", fontSize: 10 });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    // An x caption takes room off the BOTTOM only - nothing is shifted down or right.
    expect(outline.inset).toBeUndefined();
    expect(outline.overlayLabels).toHaveLength(1);
  });

  it("places annotation markers and labels in the plot", () => {
    const outline = shapeOutlineFor("graph", 300, 200, {
      graphExpression: "",
      graphXMin: 0,
      graphXMax: 10,
      graphYMin: 0,
      graphYMax: 10,
      chartAnnotations: [{ x: 5, y: 5, text: "peak", color: "#ff0000", marker: "dot" }],
    });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    const marker = outline.parts.find((p) => p.role === "annotation");
    expect(marker).toBeDefined();
    expect(outline.labels?.some((l) => l.text === "peak" && l.color === "#ff0000")).toBe(true);
  });

  it("ignores annotations on shape types that have no stable data space", () => {
    const outline = shapeOutlineFor("functionPlot", 300, 200, { chartAnnotations: [{ x: 1, y: 1, text: "nope" }] });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    expect(outline.parts.some((p) => p.role === "annotation")).toBe(false);
  });

  it("skips a non-finite annotation rather than emitting a NaN path", () => {
    const outline = shapeOutlineFor("graph", 300, 200, { chartAnnotations: [{ x: NaN, y: 1, text: "bad" }] });
    if (outline.kind !== "chart") throw new Error("expected chart outline");
    expect(outline.parts.some((p) => p.role === "annotation")).toBe(false);
  });
});

describe("figure layout", () => {
  const box = (id: string, x: number, y: number, width = 100, height = 60): WhiteboardNode =>
    ({ ...createDefaultWhiteboardNode(id, "rectangle", 0, 0), id, x, y, width, height });

  it("arranges into rows of the requested column count, anchored at the current top-left", () => {
    const nodes = [box("a", 10, 10), box("b", 500, 12), box("c", 8, 400), box("d", 520, 410)];
    const out = arrangeNodesInGrid(nodes, { columns: 2, gapX: 20, gapY: 20, sizing: "keep" });
    expect(out).toHaveLength(4);
    const byId = Object.fromEntries(out.map((n) => [n.id, n]));
    expect(byId.a.x).toBe(8);
    expect(byId.a.y).toBe(10);
    expect(byId.b.x).toBe(8 + 100 + 20);
    expect(byId.b.y).toBe(10);
    expect(byId.c.y).toBe(10 + 60 + 20);
  });

  it("equalizes panel sizes when asked", () => {
    const out = arrangeNodesInGrid([box("a", 0, 0, 100, 60), box("b", 200, 0, 300, 90)], { columns: 2, gapX: 10, gapY: 10, sizing: "uniform" });
    expect(out.every((n) => n.width === 300 && n.height === 90)).toBe(true);
  });

  it("never moves a locked node, and does not give it a cell", () => {
    const locked = { ...box("locked", 999, 999), locked: true };
    const out = arrangeNodesInGrid([box("a", 0, 0), locked, box("b", 200, 0)], { columns: 2, gapX: 10, gapY: 10, sizing: "keep" });
    expect(out.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  it("aligns to the selection's extreme edge", () => {
    const out = alignNodes([box("a", 10, 0), box("b", 50, 0), box("c", 30, 0)], "left");
    expect(out.every((n) => n.x === 10)).toBe(true);
  });

  it("aligns right edges, accounting for differing widths", () => {
    const out = alignNodes([box("a", 0, 0, 100), box("b", 10, 0, 40)], "right");
    const byId = Object.fromEntries(out.map((n) => [n.id, n]));
    expect(byId.a.x + byId.a.width).toBe(100);
    expect(byId.b.x + byId.b.width).toBe(100);
  });

  it("needs at least two nodes to align", () => {
    expect(alignNodes([box("a", 0, 0)], "left")).toEqual([]);
  });

  it("equalizes gaps while pinning the outermost nodes", () => {
    const out = distributeNodes([box("a", 0, 0, 100), box("b", 150, 0, 50), box("c", 400, 0, 100)], "horizontal");
    const byId = Object.fromEntries(out.map((n) => [n.id, n]));
    expect(byId.a.x).toBe(0);
    expect(byId.c.x).toBe(400);
    // Gap a->b equals gap b->c.
    expect(byId.b.x - (byId.a.x + byId.a.width)).toBeCloseTo(byId.c.x - (byId.b.x + byId.b.width), 6);
  });

  it("needs at least three nodes to distribute", () => {
    expect(distributeNodes([box("a", 0, 0), box("b", 100, 0)], "horizontal")).toEqual([]);
  });
});

describe("image nodes", () => {
  const imageNode = (overrides: Partial<WhiteboardNode> = {}): WhiteboardNode => ({
    ...createImageWhiteboardNode("img1", "a.png", 1600, 1200, 0, 0),
    ...overrides,
  });

  it("starts at the source's aspect ratio, capped on the long edge", () => {
    const node = createImageWhiteboardNode("i", "a.png", 4000, 3000, 0, 0);
    expect(Math.max(node.width, node.height)).toBe(DEFAULT_IMAGE_MAX_EDGE);
    expect(node.width / node.height).toBeCloseTo(4000 / 3000, 5);
  });

  it("does not upscale a small source", () => {
    const node = createImageWhiteboardNode("i", "a.png", 80, 40, 0, 0);
    expect(node.width).toBe(80);
    expect(node.height).toBe(40);
  });

  it("centers the box on the requested point", () => {
    const node = createImageWhiteboardNode("i", "a.png", 200, 100, 500, 300);
    expect(node.x + node.width / 2).toBeCloseTo(500, 6);
    expect(node.y + node.height / 2).toBeCloseTo(300, 6);
  });

  it("survives a degenerate source size rather than producing NaN geometry", () => {
    const node = createImageWhiteboardNode("i", "a.png", 0, -5, 0, 0);
    expect(Number.isFinite(node.width)).toBe(true);
    expect(node.width).toBeGreaterThan(0);
    expect(node.height).toBeGreaterThan(0);
  });

  describe("crop resolution", () => {
    it("defaults to the whole image", () => {
      expect(resolveImageCrop(imageNode())).toEqual({ x: 0, y: 0, w: 1, h: 1 });
      expect(hasImageCrop(imageNode())).toBe(false);
    });

    it("clamps a crop that would run past the source's edge", () => {
      const c = resolveImageCrop(imageNode({ imageCropX: 0.8, imageCropW: 0.9 }));
      expect(c.x + c.w).toBeLessThanOrEqual(1.0000001);
    });

    it("never returns a zero-width region, which would make drawImage throw", () => {
      const c = resolveImageCrop(imageNode({ imageCropW: 0, imageCropH: 0 }));
      expect(c.w).toBeGreaterThan(0);
      expect(c.h).toBeGreaterThan(0);
    });

    it("falls back on non-finite values instead of propagating NaN", () => {
      const c = resolveImageCrop(imageNode({ imageCropX: NaN, imageCropW: Infinity }));
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.w)).toBe(true);
    });

    it("reports a real crop as one", () => {
      expect(hasImageCrop(imageNode({ imageCropW: 0.5 }))).toBe(true);
    });
  });

  describe("fit modes", () => {
    // A 200x100 box holding a 100x100 source: cover scales to 2x (fills width, overflows height);
    // contain scales to 1x (fits height, letterboxes width); fill ignores aspect entirely.
    const box = imageNode({ width: 200, height: 100 });

    it("cover fills the box and overflows the short axis", () => {
      const r = imageDestRect({ ...box, imageFit: "cover" }, 100, 100);
      expect(r.width).toBeCloseTo(200, 6);
      expect(r.height).toBeCloseTo(200, 6);
      // Centered, so the overflow is split evenly above and below.
      expect(r.y).toBeCloseTo(-50, 6);
    });

    it("contain fits the whole image inside and centers the leftover margin", () => {
      const r = imageDestRect({ ...box, imageFit: "contain" }, 100, 100);
      expect(r.width).toBeCloseTo(100, 6);
      expect(r.height).toBeCloseTo(100, 6);
      expect(r.x).toBeCloseTo(50, 6);
      expect(r.y).toBeCloseTo(0, 6);
    });

    it("fill stretches to the box exactly", () => {
      const r = imageDestRect({ ...box, imageFit: "fill" }, 100, 100);
      expect(r).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    });

    it("degrades to the plain box for a degenerate source rather than dividing by zero", () => {
      const r = imageDestRect({ ...box, imageFit: "cover" }, 0, 0);
      expect(Number.isFinite(r.width) && Number.isFinite(r.height)).toBe(true);
    });
  });

  describe("natural size", () => {
    it("is the source's own pixel size when uncropped", () => {
      expect(naturalImageSize(imageNode())).toEqual({ width: 1600, height: 1200 });
    });

    it("accounts for the crop, so it restores what is actually visible", () => {
      expect(naturalImageSize(imageNode({ imageCropW: 0.5, imageCropH: 0.25 }))).toEqual({ width: 800, height: 300 });
    });

    it("is null when the source was never measured", () => {
      expect(naturalImageSize(imageNode({ naturalWidth: undefined, naturalHeight: undefined }))).toBeNull();
    });
  });
});

describe("waterfall node defaults", () => {
  it("starts with real sample data so a fresh shape reads as a figure", () => {
    const node = makeNode();
    const resolved = resolveSeriesData(node);
    expect(resolved.series.length).toBeGreaterThan(5);
    expect(node.seriesData).toBeDefined();
  });

  it("starts with a thin line weight so stacked traces stay separable", () => {
    expect(makeNode().strokeWidth).toBeLessThan(2);
  });

  it("produces identical sample data on every call", () => {
    expect(createDefaultWhiteboardNode("x", "waterfallChart", 0, 0).seriesData).toEqual(
      createDefaultWhiteboardNode("y", "waterfallChart", 0, 0).seriesData
    );
  });
});
