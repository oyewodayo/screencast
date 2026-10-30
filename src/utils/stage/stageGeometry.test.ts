import { describe, expect, it } from "vitest";
import { GeoBox, boxPoint, insideBox, resizeBox, turnBox } from "./stageGeometry";

const box = (o: Partial<GeoBox> = {}): GeoBox => ({ x: 100, y: 100, width: 200, height: 100, rotation: 0, scale: 1, anchorX: 0.5, anchorY: 0.5, ...o });

describe("resizing by a handle", () => {
  it("keeps the opposite corner where it was", () => {
    const r = resizeBox(box(), { sx: 1, sy: 1 }, 50, 20);
    expect(r).toEqual({ x: 100, y: 100, width: 250, height: 120 });
    const l = resizeBox(box(), { sx: -1, sy: -1 }, -50, -20);
    expect(l).toEqual({ x: 50, y: 80, width: 250, height: 120 });
  });

  it("a side handle pulls one side only", () => {
    expect(resizeBox(box(), { sx: 1, sy: 0 }, 40, 999)).toEqual({ x: 100, y: 100, width: 240, height: 100 });
    expect(resizeBox(box(), { sx: 0, sy: -1 }, 999, -30)).toEqual({ x: 100, y: 70, width: 200, height: 130 });
  });

  it("keeps proportions with Shift and grows about the centre with Alt", () => {
    const r = resizeBox(box(), { sx: 1, sy: 1 }, 100, 0, { keepAspect: true });
    expect(r.width / r.height).toBeCloseTo(2);
    expect(r.width).toBeCloseTo(300);
    const c = resizeBox(box(), { sx: 1, sy: 0 }, 20, 0, { fromCentre: true });
    expect(c).toEqual({ x: 80, y: 100, width: 240, height: 100 });
  });

  it("works on a rotated element: the opposite corner stays put on screen", () => {
    const b = box({ rotation: 30 });
    const before = boxPoint(b, 0, 0);
    // Dragged along the box's own x axis.
    const r = resizeBox(b, { sx: 1, sy: 1 }, Math.cos(Math.PI / 6) * 60, Math.sin(Math.PI / 6) * 60);
    expect(r.width).toBeCloseTo(260);
    expect(r.height).toBeCloseTo(100);
    const after = boxPoint({ ...b, ...r }, 0, 0);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("never collapses past the minimum", () => {
    const r = resizeBox(box(), { sx: 1, sy: 0 }, -500, 0);
    expect(r.width).toBe(4);
    expect(r.x).toBe(100);
  });
});

describe("turning and hit testing", () => {
  it("turns about the anchor, snapping to 15 degrees", () => {
    const b = box();
    // Centre is (200, 150): from straight right to straight below is +90.
    expect(turnBox(b, { x: 300, y: 150 }, { x: 200, y: 250 })).toBeCloseTo(90);
    expect(turnBox(b, { x: 300, y: 150 }, { x: 300, y: 160 }, true)).toBe(0);
  });

  it("knows what's inside a rotated box", () => {
    const b = box({ rotation: 90 });
    // Turned upright about (200, 150): 100 wide, 200 tall.
    expect(insideBox(b, 200, 60)).toBe(true);
    expect(insideBox(b, 110, 150)).toBe(false);
  });
});
