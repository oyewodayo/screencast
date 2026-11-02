import { describe, expect, it } from "vitest";
import { hasShapeOrMask, pathBounds, placeMask, simplifyPath, DEFAULT_MASK, type LayerMask } from "./layerMask";

describe("layer masks", () => {
  it("needs a mask picture only for a shape or a mask", () => {
    expect(hasShapeOrMask({ shape: "rectangle" })).toBe(false);
    expect(hasShapeOrMask({})).toBe(false);
    expect(hasShapeOrMask({ shape: "circle" })).toBe(true);
    expect(hasShapeOrMask({ shape: "rectangle", mask: DEFAULT_MASK })).toBe(true);
  });

  it("simplifies a drawn outline to the points that shape it", () => {
    // A square drawn with many points along each side.
    const pts = [];
    for (let i = 0; i <= 10; i++) pts.push({ x: i / 10, y: 0 });
    for (let i = 1; i <= 10; i++) pts.push({ x: 1, y: i / 10 });
    for (let i = 1; i <= 10; i++) pts.push({ x: 1 - i / 10, y: 1 });
    const out = simplifyPath(pts, 0.01);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    expect(pathBounds(out)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("moves a path's points with its box", () => {
    const m: LayerMask = { shape: "path", x: 0.2, y: 0.2, width: 0.2, height: 0.4, points: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.6 }, { x: 0.3, y: 0.4 }], feather: 0, invert: false };
    const moved = placeMask(m, { x: 0.5, y: 0, width: 0.4, height: 0.4 });
    [
      { x: 0.5, y: 0 },
      { x: 0.9, y: 0.4 },
      { x: 0.7, y: 0.2 },
    ].forEach((want, i) => {
      expect(moved.points![i].x).toBeCloseTo(want.x, 12);
      expect(moved.points![i].y).toBeCloseTo(want.y, 12);
    });
    expect(placeMask(DEFAULT_MASK, { x: 0, y: 0, width: 1, height: 1 })).toMatchObject({ x: 0, y: 0, width: 1, height: 1, shape: "ellipse" });
  });
});
