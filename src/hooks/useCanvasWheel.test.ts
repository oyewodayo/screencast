// hooks/useCanvasWheel.test.ts
//
// The wheel/pinch math only. The listener wiring itself is verified by driving the real app (a
// jsdom wheel event can't tell you whether WebView2 would have zoomed itself instead).
import { describe, expect, it } from "vitest";
import { pixelDelta, wheelZoomFactor } from "./useCanvasWheel";

describe("pixelDelta", () => {
  it("passes pixel deltas (DOM_DELTA_PIXEL) through untouched", () => {
    expect(pixelDelta(-4, 0, 800)).toBe(-4);
    expect(pixelDelta(100, 0, 800)).toBe(100);
  });

  it("converts line deltas (DOM_DELTA_LINE) to pixels", () => {
    expect(pixelDelta(3, 1, 800)).toBe(48);
  });

  it("converts page deltas (DOM_DELTA_PAGE) using the viewport size", () => {
    expect(pixelDelta(1, 2, 800)).toBe(800);
    expect(pixelDelta(-2, 2, 500)).toBe(-1000);
  });
});

describe("wheelZoomFactor", () => {
  it("magnifies on negative delta and shrinks on positive", () => {
    expect(wheelZoomFactor(-4)).toBeGreaterThan(1);
    expect(wheelZoomFactor(4)).toBeLessThan(1);
  });

  it("is exactly reciprocal, so zooming out undoes zooming in", () => {
    expect(wheelZoomFactor(-7) * wheelZoomFactor(7)).toBeCloseTo(1, 12);
  });

  it("keeps a trackpad pinch event small enough to feel continuous", () => {
    // A pinch emits a stream of ~1-10px deltas; any single one must be a nudge, not a jump.
    expect(wheelZoomFactor(-4)).toBeLessThan(1.05);
    expect(wheelZoomFactor(-10)).toBeLessThan(1.05);
  });

  it("makes one mouse notch a usable step rather than a lurch", () => {
    // A notch is ~100px, which the clamp caps. Regression guard for the original `zoom * 1.1`-per-
    // event code, where a pinch burst rocketed through the whole zoom range.
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1.1);
    expect(wheelZoomFactor(-100)).toBeLessThan(1.3);
  });

  it("clamps absurd deltas to the same step as a full notch", () => {
    expect(wheelZoomFactor(-100000)).toBe(wheelZoomFactor(-60));
  });

  it("compounds geometrically, so a burst of pinch events adds up", () => {
    const twenty = Math.pow(wheelZoomFactor(-4), 20);
    expect(twenty).toBeCloseTo(1.294, 2);
  });
});
