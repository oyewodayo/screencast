import { describe, expect, it } from "vitest";
import { revealBoxAt, revealKeyframes, revealPicturePlacement, revealStartingMask, type LayerMask } from "./layerMask";
import { regionAt } from "./adjustmentLayers";

const mask = (reveal: LayerMask["reveal"]): LayerMask => ({ shape: "rectangle", x: 0.1, y: 0.2, width: 0.6, height: 0.5, feather: 0.02, invert: false, reveal });

describe("mask reveals", () => {
  it("opens an iris from the mask's centre to the mask", () => {
    const m = mask({ style: "iris", duration: 1 });
    expect(revealBoxAt(m, 0, 5)).toEqual({ x: 0.4, y: 0.45, width: 0, height: 0 });
    const done = revealBoxAt(m, 1.5, 5);
    expect(done.x).toBeCloseTo(0.1);
    expect(done.width).toBeCloseTo(0.6);
    const mid = revealBoxAt(m, 0.5, 5);
    expect(mid.width).toBeGreaterThan(0.3); // ease-out: past halfway at half time
    expect(mid.x + mid.width / 2).toBeCloseTo(0.4);
  });

  it("wipes keep the starting edge and close again at the end", () => {
    const m = mask({ style: "wipe-left", duration: 1, exit: true });
    const ks = revealKeyframes(m, 4);
    expect(ks.map((k) => k.time)).toEqual([0, 1, 3, 4]);
    const start = revealBoxAt(m, 0, 4);
    expect(start.x).toBeCloseTo(0.7);
    expect(start.width).toBe(0);
    expect(revealBoxAt(m, 2, 4).width).toBeCloseTo(0.6);
    expect(revealBoxAt(m, 4, 4).width).toBeCloseTo(0);
  });

  it("fits a short layer and has no keyframes without a reveal", () => {
    expect(revealKeyframes(mask(undefined), 5)).toEqual([]);
    const ks = revealKeyframes(mask({ style: "iris", duration: 3, exit: true }), 2);
    expect(ks[1].time).toBeCloseTo(1);
    expect(ks[3].time).toBeCloseTo(2);
  });

  it("places the picture with its soft-edge room scaled like the mask", () => {
    const pic = { mw: 600, mh: 300, pad: 10 };
    const at = revealPicturePlacement(pic, { x: 0.1, y: 0.2, width: 0.3, height: 0.25 }, 1000, 600);
    // Half the open size: the room halves too.
    expect(at).toEqual({ x: 95, y: 115, width: 310, height: 160 });
  });

  it("starts from a mask that covers the whole layer once open", () => {
    const iris = revealStartingMask("iris");
    // The ellipse contains the box's corners.
    const rx = iris.width / 2;
    const ry = iris.height / 2;
    expect(((0.5 - iris.x - rx) ** 2) / rx ** 2 + ((0.5 - iris.y - ry) ** 2) / ry ** 2).toBeLessThan(1);
    expect((0.5 / rx) ** 2 + (0.5 / ry) ** 2).toBeLessThan(1);
    const wipe = revealStartingMask("wipe-up");
    expect(wipe.x).toBeLessThan(0);
    expect(wipe.x + wipe.width).toBeGreaterThan(1);
  });
});

describe("followed adjustment regions", () => {
  it("moves the region along its keyframes and stays put without them", () => {
    const region = { x: 0.1, y: 0.1, width: 0.2, height: 0.2, shape: "ellipse" as const, feather: 0.3, invert: true };
    expect(regionAt(region, 3)).toBe(region);
    const followed = { ...region, keyframes: [{ time: 0, x: 0, y: 0, scale: 1, opacity: 1, easing: "linear" as const }, { time: 2, x: 0.4, y: 0.2, scale: 1, opacity: 1, easing: "linear" as const }] };
    const at = regionAt(followed, 1);
    expect(at.x).toBeCloseTo(0.2);
    expect(at.y).toBeCloseTo(0.1);
    expect(at.width).toBe(0.2);
    expect(at.invert).toBe(true);
  });
});

describe("picture reveal frames", () => {
  it("draws each distinct moment once: the opening frames, then one settled picture", async () => {
    const { revealCoverageKey } = await import("./layerMask");
    const m: LayerMask = { shape: "ellipse", x: 0, y: 0, width: 1, height: 1, feather: 0.03, invert: false, reveal: { style: "iris", duration: 0.8 } };
    const keys = new Set(Array.from({ length: 150 }, (_, k) => revealCoverageKey(m, k / 30, 5, 400, 300)));
    // 0.8 s at 30 fps opening (frame 24 is already open) + the open state.
    expect(keys.size).toBe(25);
    const closing = { ...m, reveal: { ...m.reveal!, exit: true } };
    const both = new Set(Array.from({ length: 150 }, (_, k) => revealCoverageKey(closing, k / 30, 5, 400, 300)));
    // Closing mirrors opening, so most closing frames reuse an opening frame's picture.
    expect(both.size).toBeGreaterThanOrEqual(25);
    expect(both.size).toBeLessThanOrEqual(50);
  });
});
