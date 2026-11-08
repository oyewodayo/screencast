import { describe, expect, it } from "vitest";
import { CANVAS_PRESETS, aspectLabel, frameMapping, remapLayers } from "./canvasFormats";
import { migrateSplitBackdrops, relayoutSplitGroups } from "./splitGroups";
import { SplitGroupSettings, splitCells } from "./splitLayouts";
import type { ImageOverlay, PipOverlay, TextOverlay } from "./videoEditTypes";

const HD = { width: 1920, height: 1080 };
const VERTICAL = { width: 1080, height: 1920 };

const pip = (over: Partial<PipOverlay>): PipOverlay =>
  ({ id: "p", sourcePath: "a.mp4", x: 0.1, y: 0.1, width: 0.3, height: 0.3, shape: "rectangle", trimStart: 0, sourceDuration: 10, startTime: 0, endTime: 5, volume: 1, createdAt: 0, updatedAt: 0, ...over }) as PipOverlay;

describe("canvas presets", () => {
  it("are all even-sized (yuv420 needs it) and named by their shape", () => {
    for (const p of CANVAS_PRESETS) {
      expect(p.width % 2).toBe(0);
      expect(p.height % 2).toBe(0);
    }
    expect(aspectLabel(1080, 1920)).toBe("9:16");
    expect(aspectLabel(1080, 1350)).toBe("4:5");
    expect(aspectLabel(1206, 2622)).toBe("9:19.5");
  });
});

describe("remapLayers", () => {
  it("keeps a layer's shape and its place on the picture", () => {
    const box = { x: 0.6, y: 0.2, width: 0.25, height: 0.4 };
    const { pipOverlays } = remapLayers({ textOverlays: [], imageOverlays: [], blurOverlays: [], pipOverlays: [pip(box)], adjustmentLayers: [] }, HD, VERTICAL);
    const o = pipOverlays[0];
    // Same pixel shape.
    expect((o.width * VERTICAL.width) / (o.height * VERTICAL.height)).toBeCloseTo((box.width * HD.width) / (box.height * HD.height));
    // Same spot on the (fitted) picture.
    const m = frameMapping(HD, VERTICAL);
    expect(o.x).toBeCloseTo(m.x(0.6));
    expect(o.y).toBeCloseTo(m.y(0.2));
    // Inside the new frame.
    expect(o.x + o.width).toBeLessThanOrEqual(1);
  });

  it("scales text by the picture's height", () => {
    const text = { id: "t", text: "Hi", color: "#fff", x: 0.1, y: 0.1, width: 0.5, height: 0.1, fontSize: 0.08, startTime: 0, endTime: 1, createdAt: 0, updatedAt: 0 } as TextOverlay;
    const { textOverlays } = remapLayers({ textOverlays: [text], imageOverlays: [], blurOverlays: [], pipOverlays: [], adjustmentLayers: [] }, HD, VERTICAL);
    // 16:9 picture fitted into 9:16: it's (1080 * 9/16) / 1920 of the new height.
    expect(textOverlays[0].fontSize).toBeCloseTo(0.08 * ((1080 * 9) / 16 / 1920));
  });

  it("leaves split-screen layers for the relayout", () => {
    const member = pip({ split: { group: "g", cell: 0, shotAspect: 16 / 9, settings: {} as SplitGroupSettings } });
    const { pipOverlays } = remapLayers({ textOverlays: [], imageOverlays: [], blurOverlays: [], pipOverlays: [member], adjustmentLayers: [] }, HD, VERTICAL);
    expect(pipOverlays[0]).toBe(member);
  });
});

describe("relayoutSplitGroups", () => {
  const settings: SplitGroupSettings = { layout: "cols2", ratio: 0.5, gap: 0, gapColor: "#000", corners: 0, feather: 0, cardSize: 0.5, cardCentre: { x: 0.5, y: 0.5 } };
  const members = () => {
    const [a, b] = splitCells("cols2", 16 / 9, 0, 0.5);
    return [
      pip({ id: "a", ...a, split: { group: "g", cell: 0, shotAspect: 16 / 9, settings } }),
      pip({ id: "b", ...b, split: { group: "g", cell: 1, shotAspect: 16 / 9, settings } }),
    ];
  };

  it("re-flows to fill a new canvas shape", () => {
    const { pipOverlays } = relayoutSplitGroups(members(), [], 16 / 9, 9 / 16);
    const [a, b] = pipOverlays;
    expect(a.height).toBeCloseTo(1);
    expect(a.width + b.width).toBeCloseTo(1);
  });

  it("switches layout and swaps shots in one go", () => {
    const { pipOverlays } = relayoutSplitGroups(members(), [], 16 / 9, 16 / 9, { group: "g", settings: { layout: "rows2" }, rotate: true });
    const [a, b] = pipOverlays;
    expect(a.split!.cell).toBe(1);
    expect(b.split!.cell).toBe(0);
    expect(a.y).toBeGreaterThan(b.y);
    expect(a.width).toBeCloseTo(1);
    expect(a.split!.settings.layout).toBe("rows2");
  });

  it("keeps a hand-made framing", () => {
    const [a, b] = members();
    const panned = { ...a, crop: { x: 0, y: 0, width: 0.25, height: 0.5 } };
    const { pipOverlays } = relayoutSplitGroups([panned, b], [], 16 / 9, 16 / 9, { group: "g", settings: { ratio: 0.5 } });
    expect(pipOverlays[0].crop).toEqual({ x: 0, y: 0, width: 0.25, height: 0.5 });
  });

  it("ignores a layout for a different number of shots", () => {
    const before = members();
    const { pipOverlays } = relayoutSplitGroups(before, [] as ImageOverlay[], 16 / 9, 16 / 9, { group: "g", settings: { layout: "grid4" } });
    expect(pipOverlays).toEqual(before);
  });
});

describe("migrateSplitBackdrops", () => {
  const rect = (over: Partial<ImageOverlay>) =>
    ({ id: "r", src: "", asset: { kind: "rectangle", color: "#112233", entrance: "none", exit: false, loop: "none" }, x: 0, y: 0, width: 1, height: 1, opacity: 1, startTime: 2, endTime: 7, createdAt: 0, updatedAt: 0, ...over }) as ImageOverlay;

  it("moves a split's picture backdrop beneath its video cells", () => {
    const out = migrateSplitBackdrops([rect({ split: { group: "g", cell: -1, shotAspect: 1, settings: {} as SplitGroupSettings } })], [], [])!;
    expect(out.imageOverlays).toHaveLength(0);
    expect(out.adjustmentLayers[0]).toMatchObject({ placement: "under", fill: "#112233", startTime: 2, endTime: 7 });
    expect(out.adjustmentLayers[0].split?.group).toBe("g");
  });

  it("recognises an older split's backdrop by its PiP's exact timing, and nothing else", () => {
    const out = migrateSplitBackdrops([rect({}), rect({ id: "other", startTime: 3 })], [pip({ startTime: 2, endTime: 7 })], [])!;
    expect(out.imageOverlays.map((o) => o.id)).toEqual(["other"]);
    expect(migrateSplitBackdrops([rect({ startTime: 3 })], [pip({ startTime: 2, endTime: 7 })], [])).toBeNull();
  });
});
