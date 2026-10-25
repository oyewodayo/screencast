import { describe, expect, it } from "vitest";
import { SPRING_PRESETS, SpringParams, springAt, springSettleTime, withoutOvershoot } from "./springs";

const numericVelocity = (p: SpringParams, x0: number, v0: number, target: number, t: number) => {
  const h = 1e-5;
  return (springAt(p, x0, v0, target, t + h).x - springAt(p, x0, v0, target, t - h).x) / (2 * h);
};

describe("springAt", () => {
  const cases: [string, SpringParams][] = [
    ["underdamped", { response: 0.5, damping: 0.6 }],
    ["critical", { response: 0.5, damping: 1 }],
    ["overdamped", { response: 0.5, damping: 1.6 }],
  ];

  for (const [name, p] of cases) {
    it(`${name}: starts where it is, ends at the target, and reports its true velocity`, () => {
      expect(springAt(p, 10, 3, 100, 0)).toEqual({ x: 10, v: 3 });
      const end = springAt(p, 10, 3, 100, 20);
      expect(end.x).toBeCloseTo(100, 6);
      expect(end.v).toBeCloseTo(0, 6);
      for (const t of [0.01, 0.1, 0.25, 0.6, 1.3]) {
        expect(springAt(p, 10, 3, 100, t).v).toBeCloseTo(numericVelocity(p, 10, 3, 100, t), 3);
      }
    });
  }

  it("leaves with the velocity it was given - an interrupted move carries on", () => {
    const p = SPRING_PRESETS.smooth;
    const h = 1e-7;
    expect(springAt(p, 0, 400, 0, h).x / h).toBeCloseTo(400, 1);
    expect(springAt(p, 0, 400, 0, h).v).toBeCloseTo(400, 1);
  });

  it("overshoots only below critical damping", () => {
    const peak = (p: SpringParams) => Math.max(...Array.from({ length: 400 }, (_, i) => springAt(p, 0, 0, 1, i / 100).x));
    expect(peak(SPRING_PRESETS.bouncy)).toBeGreaterThan(1.05);
    expect(peak(SPRING_PRESETS.gentle)).toBeLessThanOrEqual(1 + 1e-9);
    expect(peak(withoutOvershoot(SPRING_PRESETS.bouncy))).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("is a pure function of time - the same moment always gives the same value", () => {
    const p = SPRING_PRESETS.bouncy;
    const a = springAt(p, 3, -7, 50, 0.4321);
    springAt(p, 3, -7, 50, 1.2);
    expect(springAt(p, 3, -7, 50, 0.4321)).toEqual(a);
  });
});

describe("springSettleTime", () => {
  it("bounds the time after which the move stays within tolerance", () => {
    for (const p of Object.values(SPRING_PRESETS)) {
      const ts = springSettleTime(p, 100, 0.05);
      for (let t = ts; t < ts + 3; t += 0.01) expect(Math.abs(springAt(p, 0, 0, 100, t).x - 100)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(ts).toBeLessThan(5);
    }
    expect(springSettleTime(SPRING_PRESETS.smooth, 0.01, 0.05)).toBe(0);
  });
});
