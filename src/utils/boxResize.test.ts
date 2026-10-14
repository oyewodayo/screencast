import { describe, expect, it } from "vitest";
import { RESIZE_HANDLES, reachableHandlePosition, resizeBoxFromHandle } from "./boxResize";

const handle = (id: string) => RESIZE_HANDLES.find((h) => h.id === id)!;
const box = { x: 100, y: 100, width: 200, height: 100 };

describe("resizeBoxFromHandle", () => {
  it("right edge stretches width only, left side fixed", () => {
    expect(resizeBoxFromHandle(box, 0, handle("e"), 50, 30, false)).toEqual({ x: 100, y: 100, width: 250, height: 100 });
  });

  it("left edge keeps the right side fixed", () => {
    const r = resizeBoxFromHandle(box, 0, handle("w"), 40, 0, false);
    expect(r.x + r.width).toBeCloseTo(300);
    expect(r.width).toBeCloseTo(160);
  });

  it("top-left corner keeps the bottom-right corner fixed and the proportions", () => {
    const r = resizeBoxFromHandle(box, 0, handle("nw"), -100, -10, true);
    expect(r.x + r.width).toBeCloseTo(300);
    expect(r.y + r.height).toBeCloseTo(200);
    expect(r.width / r.height).toBeCloseTo(2);
    expect(r.width).toBeCloseTo(300);
  });

  it("free corner resizes each side by its own drag", () => {
    expect(resizeBoxFromHandle(box, 0, handle("se"), 20, 40, false)).toEqual({ x: 100, y: 100, width: 220, height: 140 });
  });

  it("on a rotated box, the opposite side stays put on screen", () => {
    const rot = 90;
    // Rotated 90deg clockwise: the box's own "right" edge points down on screen.
    const r = resizeBoxFromHandle(box, rot, handle("e"), 0, 50, false);
    expect(r.width).toBeCloseTo(250);
    // The box's left edge midpoint (local (-w/2, 0)) maps to screen centre + (0, -w/2).
    const leftMid = (b: typeof box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 - b.width / 2 });
    expect(leftMid(r).x).toBeCloseTo(leftMid(box).x);
    expect(leftMid(r).y).toBeCloseTo(leftMid(box).y);
  });

  it("never shrinks below the minimum", () => {
    const r = resizeBoxFromHandle(box, 0, handle("e"), -500, 0, false);
    expect(r.width).toBe(12);
    expect(r.x).toBe(100);
  });
});

describe("reachableHandlePosition", () => {
  it("pulls handles of a full-frame box inside the frame and above the controls", () => {
    const full = { x: 0, y: 0, width: 1000, height: 560 };
    const se = reachableHandlePosition(handle("se"), full, 1000, 560, 60);
    expect(se.left).toBe(992);
    expect(se.top).toBe(560 - 60 - 8);
    const nw = reachableHandlePosition(handle("nw"), full, 1000, 560, 60);
    expect(nw).toEqual({ left: 8, top: 8 });
  });

  it("leaves a comfortably placed box's handles on its corners", () => {
    expect(reachableHandlePosition(handle("se"), box, 1000, 560, 60)).toEqual({ left: 200, top: 100 });
  });
});
