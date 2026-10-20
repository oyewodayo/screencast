import { describe, expect, it } from "vitest";
import { adjustmentBackdropFilter, adjustmentColorOps, adjustmentPixelBox, fadeEnvelope, featherPx, makeAdjustmentLayer, regionAlpha, regionMaskStyle } from "./adjustmentLayers";
import type { AdjustmentRegion } from "./videoEditTypes";

describe("adjustment layers", () => {
  it("lists colour functions in the preview's order: look, then the sliders", () => {
    const layer = makeAdjustmentLayer(0, 5, { look: { preset: "bw", intensity: 1 }, brightness: 0.8, saturation: 1.5, hue: 20, contrast: 1 });
    expect(adjustmentColorOps(layer)).toEqual([
      { op: "grayscale", value: 1 },
      { op: "brightness", value: 0.8 },
      { op: "saturate", value: 1.5 },
      { op: "hue-rotate", value: 20 },
    ]);
    // Blur comes first in the backdrop-filter, as export blurs before it grades.
    expect(adjustmentBackdropFilter({ ...layer, blur: 0.01 }, 1000)).toBe("blur(10px) grayscale(1) brightness(0.8) saturate(1.5) hue-rotate(20deg)");
    expect(adjustmentBackdropFilter(makeAdjustmentLayer(0, 1), 1000)).toBe("opacity(1)");
  });

  it("fades linearly in and out, never past half the layer", () => {
    const layer = makeAdjustmentLayer(10, 14, { fadeIn: 1, fadeOut: 3, opacity: 0.8 });
    expect(fadeEnvelope(layer, 10)).toBe(0);
    expect(fadeEnvelope(layer, 10.5)).toBeCloseTo(0.4);
    expect(fadeEnvelope(layer, 11.5)).toBeCloseTo(0.8);
    // The 3 s fade-out is clamped to 2 s (half of 4).
    expect(fadeEnvelope(layer, 13)).toBeCloseTo(0.4);
    expect(fadeEnvelope(layer, 14)).toBe(0);
  });

  const W = 1000;
  const H = 500;
  const rect: AdjustmentRegion = { x: 0.1, y: 0.2, width: 0.4, height: 0.4, shape: "rectangle", feather: 0.5, invert: false };

  it("feathers a rectangle as horizontal times vertical ramps", () => {
    const f = featherPx(rect, W, H); // 0.5 * min(400, 200) / 2 = 50
    expect(f).toBe(50);
    expect(regionAlpha(rect, W, H, 300, 200)).toBe(1); // centre
    expect(regionAlpha(rect, W, H, 125, 200)).toBeCloseTo(0.5); // 25 px in from the left
    expect(regionAlpha(rect, W, H, 125, 125)).toBeCloseTo(0.25); // and 25 px down: 0.5 * 0.5
    expect(regionAlpha(rect, W, H, 50, 200)).toBe(0);
  });

  it("feathers an ellipse along its normalised radius", () => {
    const e: AdjustmentRegion = { ...rect, shape: "ellipse" };
    expect(regionAlpha(e, W, H, 300, 200)).toBe(1);
    // Half way out along x: r = 0.5, m = 100 (shorter radius), f = 50: (1 - 0.5) * 100 / 50 = 1.
    expect(regionAlpha(e, W, H, 400, 200)).toBe(1);
    // r = 0.75 -> 0.5
    expect(regionAlpha(e, W, H, 450, 200)).toBeCloseTo(0.5);
    expect(regionAlpha(e, W, H, 500, 200)).toBe(0);
    // CSS: the black stop sits where the ramp starts - 1 - f/m.
    expect(String(regionMaskStyle(e, W, H).maskImage)).toContain("black 50%");
  });

  it("composes the inverted mask as 1 - region", () => {
    const style = regionMaskStyle({ ...rect, invert: true }, W, H);
    expect(String(style.maskComposite)).toBe("exclude, intersect, add");
    expect(String(style.maskImage).startsWith("linear-gradient(black, black)")).toBe(true);
  });

  it("crops on even pixels inside the frame", () => {
    const box = adjustmentPixelBox({ ...rect, x: 0.1013, y: 0.2011, width: 0.3, height: 0.31 }, 1919, 1081);
    expect(box.x % 2).toBe(0);
    expect(box.y % 2).toBe(0);
    expect(box.width % 2 === 0 || box.x + box.width === 1919).toBe(true);
    expect(box.x + box.width).toBeLessThanOrEqual(1919);
    expect(adjustmentPixelBox({ ...rect, invert: true }, 1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });
});
