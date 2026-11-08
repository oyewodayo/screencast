import { describe, expect, it } from "vitest";
import { fillWindow, gatherEvidence, reframeWindowAt, solveReframe, type TrackPoint } from "./reframeTrack";
import type { Clip } from "./videoEditTypes";

const win = fillWindow({ width: 1920, height: 1080 }, { width: 1080, height: 1920 });
const series = (from: number, to: number, x: (t: number) => number, weight = 1): TrackPoint[] =>
  Array.from({ length: Math.round((to - from) * 6) }, (_, i) => {
    const t = from + i / 6;
    return { t, x: x(t), y: 0.5, weight };
  });

describe("fillWindow", () => {
  it("is the output's shape inside the frame", () => {
    expect(win.w).toBeCloseTo(9 / 16 / (16 / 9), 9);
    expect(win.h).toBe(1);
    expect(fillWindow({ width: 1080, height: 1920 }, { width: 1080, height: 1080 })).toEqual({ w: 1, h: 1080 / 1920 });
  });
});

describe("solveReframe - a camera operator, not a tracker", () => {
  it("holds still on a subject that stays put, even with jitter", () => {
    const points = series(0, 10, (t) => 0.3 + 0.01 * Math.sin(t * 9));
    const knots = solveReframe(points, [], 10, win);
    const xs = new Set(knots.map((k) => k.x.toFixed(4)));
    expect(xs.size).toBe(1);
    expect(knots[0].x).toBeCloseTo(0.3, 1);
  });

  it("makes one eased, anticipated move when the subject relocates", () => {
    const points = series(0, 10, (t) => (t < 5 ? 0.3 : 0.7));
    const knots = solveReframe(points, [], 10, win);
    expect(knots).toHaveLength(3);
    const [, from, to] = knots;
    expect(from.t).toBeLessThan(5); // starts as it leaves - known in advance
    expect(from.t).toBeGreaterThan(4.5);
    expect(to.x).toBeCloseTo(0.7, 2);
    expect(to.t - from.t).toBeGreaterThanOrEqual(0.5);
    expect(to.t - from.t).toBeLessThanOrEqual(1.5);
  });

  it("ignores a brief glance away", () => {
    const points = series(0, 10, (t) => (t > 4 && t < 4.25 ? 0.85 : 0.3));
    const knots = solveReframe(points, [], 10, win);
    expect(new Set(knots.map((k) => k.x.toFixed(4))).size).toBe(1);
  });

  it("cuts at a shot boundary, and eases across a transition", () => {
    const points = [...series(0, 5, () => 0.25), ...series(5, 10, () => 0.75)];
    const cut = solveReframe(points, [{ t: 5, blend: 0 }], 10, win);
    const before = reframeWindowAt(cut, 4.98); // the cut fits between frames at 24-60fps
    const after = reframeWindowAt(cut, 5);
    expect(before.x).toBeCloseTo(0.25, 1);
    expect(after.x).toBeCloseTo(0.75, 1);
    const eased = solveReframe(points, [{ t: 5, blend: 1 }], 10, win);
    expect(reframeWindowAt(eased, 5.5).x).toBeGreaterThan(0.3);
    expect(reframeWindowAt(eased, 5.5).x).toBeLessThan(0.7);
    expect(reframeWindowAt(eased, 6).x).toBeCloseTo(0.75, 1);
  });

  it("keeps the window inside the frame", () => {
    const knots = solveReframe(series(0, 4, () => 0.02), [], 4, win);
    expect(knots[0].x).toBeCloseTo(win.w / 2, 9);
  });

  it("centres when there's nothing to follow", () => {
    expect(solveReframe([], [], 5, win)).toEqual([{ t: 0, x: 0.5, y: 0.5 }]);
  });
});

describe("gatherEvidence", () => {
  const clip = (id: string, start: number, end: number, extra: Partial<Clip> = {}): Clip => ({ id, sourcePath: `${id}.mp4`, start, end, ...extra });

  it("places evidence on the output timeline and makes clip boundaries shot boundaries", () => {
    const a = clip("a", 10, 14);
    const b = clip("b", 0, 4, { speed: 2, transitionIn: { type: "fade", duration: 0.5 } });
    const { points, boundaries, duration } = gatherEvidence(
      [
        { clip: a, track: { width: 1920, height: 1080, samples: [{ t: 12, x: 0.4, y: 0.5, confidence: 1, cut: false }] }, clicks: [] },
        { clip: b, track: { width: 1920, height: 1080, samples: [{ t: 2, x: 0.6, y: 0.5, confidence: 1, cut: false }] }, clicks: [] },
      ],
      { width: 1920, height: 1080 }
    );
    expect(duration).toBeCloseTo(6, 9);
    expect(points.map((p) => p.t)).toEqual([2, 5]); // b's source 2s at 2x = 1s into b, which starts at 4
    expect(boundaries).toEqual([{ t: 4, blend: 0.5 }]);
  });

  it("maps through the clip's own framing (a mirrored clip's left is the frame's right)", () => {
    const { points } = gatherEvidence(
      [{ clip: clip("a", 0, 4, { flipHorizontal: true }), track: { width: 1920, height: 1080, samples: [{ t: 1, x: 0.2, y: 0.5, confidence: 1, cut: false }] }, clicks: [] }],
      { width: 1920, height: 1080 }
    );
    expect(points[0].x).toBeCloseTo(0.8, 9);
  });

  it("weights a recorded click well above a frame's motion", () => {
    const { points } = gatherEvidence(
      [{ clip: clip("a", 0, 4), track: null, clicks: [{ time: 2, x: 0.9, y: 0.1 }] }],
      { width: 1920, height: 1080 }
    );
    expect(points).toHaveLength(3);
    expect(points.every((p) => p.weight > 1 && p.x === 0.9)).toBe(true);
  });
});
