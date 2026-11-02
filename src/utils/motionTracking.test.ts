import { describe, expect, it } from "vitest";
import { simplifyTimed } from "./motionTracking";

describe("motion tracking keyframes", () => {
  it("keeps a straight move as two keyframes", () => {
    const points = Array.from({ length: 31 }, (_, i) => ({ time: i / 30, x: i * 2 }));
    expect(simplifyTimed(points, (p) => [p.x], 0.3)).toEqual([points[0], points[30]]);
  });

  it("stays within the tolerance of every sampled frame", () => {
    // A wobbly path: what a handheld track looks like.
    const points = Array.from({ length: 300 }, (_, i) => {
      const t = i / 30;
      return { time: t, x: 400 + 120 * Math.sin(t * 1.3) + 3 * Math.sin(t * 17), y: 200 + 60 * Math.cos(t * 0.7) };
    });
    const tol = 0.35;
    const kept = simplifyTimed(points, (p) => [p.x, p.y], tol);
    expect(kept.length).toBeLessThan(points.length);
    // Re-interpolate linearly between the kept keyframes: never more than tol off.
    for (const p of points) {
      const j = kept.findIndex((k) => k.time >= p.time);
      if (j <= 0) continue;
      const a = kept[j - 1];
      const b = kept[j];
      const f = (p.time - a.time) / (b.time - a.time);
      expect(Math.abs(a.x + (b.x - a.x) * f - p.x)).toBeLessThanOrEqual(tol + 1e-9);
      expect(Math.abs(a.y + (b.y - a.y) * f - p.y)).toBeLessThanOrEqual(tol + 1e-9);
    }
  });
});
