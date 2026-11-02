// Covers utils/keyframes.ts - the keyframe curve the preview draws (export builds the same one).
import { describe, expect, it } from "vitest";
import { easeKeyframe, keyframeAt, keyframeStateAt, removeKeyframeAt, upsertKeyframe, OverlayKeyframe } from "./keyframes";

const kf = (time: number, x: number, extra: Partial<OverlayKeyframe> = {}): OverlayKeyframe => ({ time, x, y: 0, scale: 1, opacity: 1, easing: "linear", ...extra });

describe("keyframeStateAt", () => {
  it("holds before the first and after the last keyframe, and interpolates between", () => {
    const kfs = [kf(2, 0.8), kf(0, 0.2)];
    expect(keyframeStateAt(kfs, -1)?.x).toBeCloseTo(0.2);
    expect(keyframeStateAt(kfs, 1)?.x).toBeCloseTo(0.5);
    expect(keyframeStateAt(kfs, 5)?.x).toBeCloseTo(0.8);
    expect(keyframeStateAt(undefined, 1)).toBeNull();
  });

  it("eases by the starting keyframe's easing", () => {
    expect(keyframeStateAt([kf(0, 0, { easing: "ease" }), kf(1, 1)], 0.25)?.x).toBeCloseTo(easeKeyframe("ease", 0.25));
    expect(keyframeStateAt([kf(0, 0, { easing: "hold" }), kf(1, 1)], 0.99)?.x).toBe(0);
    expect(keyframeStateAt([kf(0, 0, { scale: 1, opacity: 1 }), kf(1, 0, { scale: 2, opacity: 0 })], 0.5)).toMatchObject({ scale: 1.5, opacity: 0.5 });
  });
});

describe("editing keyframes", () => {
  it("replaces a keyframe at the same moment instead of stacking a second one", () => {
    let kfs = upsertKeyframe(undefined, kf(1, 0.1));
    kfs = upsertKeyframe(kfs, kf(1.01, 0.4));
    kfs = upsertKeyframe(kfs, kf(0, 0));
    expect(kfs.map((k) => [k.time, k.x])).toEqual([[0, 0], [1.01, 0.4]]);
    expect(keyframeAt(kfs, 1)?.x).toBe(0.4);
    expect(removeKeyframeAt(kfs, 1)).toHaveLength(1);
  });
});
