import { describe, expect, it } from "vitest";
import { createDefaultWhiteboardNode, nodeHasFill, resolveFillType, resolveGradientStops, WhiteboardNode } from "../utils/whiteboardTypes";
import {
  dashArrayFor,
  fillImageRect,
  fillPatternTile,
  hexToRgba,
  linearGradientPoints,
  nodeDropShadowCSS,
  roundedPolygonD,
  shapeOutlineFor,
  supportsCornerRadius,
} from "./whiteboardHandlers";

function node(shapeType: WhiteboardNode["shapeType"], overrides: Partial<WhiteboardNode> = {}): WhiteboardNode {
  return { ...createDefaultWhiteboardNode("n1", shapeType, 0, 0), ...overrides };
}

// Every "x,y" coordinate pair in a path string.
function coords(d: string): [number, number][] {
  return [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe("corner radius", () => {
  it("leaves a polygon's outline untouched at radius 0", () => {
    expect(shapeOutlineFor("triangle", 160, 130, { cornerRadius: 0 }).kind).toBe("polygon");
  });

  it("turns a polygon into a rounded path that stays inside the box", () => {
    const outline = shapeOutlineFor("triangle", 160, 130, { cornerRadius: 20 });
    expect(outline.kind).toBe("path");
    if (outline.kind !== "path") return;
    expect(outline.d).toContain("Q");
    for (const [x, y] of coords(outline.d)) {
      expect(x).toBeGreaterThanOrEqual(-0.01);
      expect(x).toBeLessThanOrEqual(160.01);
      expect(y).toBeGreaterThanOrEqual(-0.01);
      expect(y).toBeLessThanOrEqual(130.01);
    }
  });

  it("never cuts back further than half an edge, even at a huge radius", () => {
    // A unit square at radius 1000: every corner's cut-back clamps to 0.5, so the fillet endpoints
    // are the edge midpoints - a circle-ish shape, not a self-intersecting one.
    const d = roundedPolygonD([[0, 0], [1, 0], [1, 1], [0, 1]], 1000);
    const pts = coords(d);
    const onGrid = pts.every(([x, y]) => [0, 0.5, 1].includes(x) && [0, 0.5, 1].includes(y));
    expect(onGrid).toBe(true);
  });

  it("is offered for plain polygons but not for outlines with inner strokes", () => {
    expect(supportsCornerRadius(node("hexagon"))).toBe(true);
    expect(supportsCornerRadius(node("star"))).toBe(true);
    expect(supportsCornerRadius(node("rectangle"))).toBe(true);
    expect(supportsCornerRadius(node("cube"))).toBe(false);
    expect(supportsCornerRadius(node("ellipse"))).toBe(false);
    expect(supportsCornerRadius(node("table"))).toBe(false);
  });

  it("does not round a cube's outline out from under its spokes", () => {
    expect(shapeOutlineFor("cube", 100, 100, { cornerRadius: 20 }).kind).toBe("polygon");
  });
});

describe("fill paint", () => {
  it("degrades an image fill with no asset to solid", () => {
    expect(resolveFillType({ fillType: "image" })).toBe("solid");
    expect(resolveFillType({ fillType: "image", fillImageAsset: "a.png" })).toBe("image");
  });

  it("sorts and clamps gradient stops, and seeds a ramp from fillColor", () => {
    expect(resolveGradientStops({ fillColor: "#ff0000", fillGradientStops: [{ offset: 1.4, color: "#000" }, { offset: -1, color: "#fff" }] })).toEqual([
      { offset: 0, color: "#fff" },
      { offset: 1, color: "#000" },
    ]);
    expect(resolveGradientStops({ fillColor: "#ff0000" })[0].color).toBe("#ff0000");
  });

  it("counts a pattern on its own as a fill", () => {
    expect(nodeHasFill({ fillColor: null, fillPattern: "grid" })).toBe(true);
    expect(nodeHasFill({ fillColor: null })).toBe(false);
  });

  it("spans a linear gradient corner to corner like CSS", () => {
    expect(linearGradientPoints(200, 100, 0)).toEqual({ x1: 0, y1: 50, x2: 200, y2: 50 });
    const diag = linearGradientPoints(100, 100, 45);
    expect(diag.x1).toBeCloseTo(0);
    expect(diag.y1).toBeCloseTo(0);
    expect(diag.x2).toBeCloseTo(100);
    expect(diag.y2).toBeCloseTo(100);
  });

  it("fits an image fill by cover/contain/fill", () => {
    expect(fillImageRect("cover", 100, 100, 200, 100)).toEqual({ x: -50, y: 0, w: 200, h: 100 });
    expect(fillImageRect("contain", 100, 100, 200, 100)).toEqual({ x: 0, y: 25, w: 100, h: 50 });
    expect(fillImageRect("fill", 100, 100, 200, 100)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it("builds a non-empty tile for every pattern", () => {
    for (const p of ["grid", "dots", "lines", "diagonal"] as const) expect(fillPatternTile(p, 16).d.length).toBeGreaterThan(0);
    expect(fillPatternTile("none", 16).d).toBe("");
  });
});

describe("shadow and stroke helpers", () => {
  it("formats hexToRgba accurately with clamped opacity", () => {
    expect(hexToRgba("#000000", 0.5)).toBe("rgba(0,0,0,0.5)");
    expect(hexToRgba("#ff0000", 1)).toBe("rgba(255,0,0,1)");
    expect(hexToRgba("#3b82f6", 0)).toBe("rgba(59,130,246,0)");
  });

  it("produces drop-shadow CSS only when shadowEnabled is true with non-zero opacity", () => {
    expect(nodeDropShadowCSS({ shadowEnabled: false } as WhiteboardNode)).toBeUndefined();
    expect(nodeDropShadowCSS({ shadowEnabled: true, shadowOpacity: 0 } as WhiteboardNode)).toBeUndefined();
    expect(
      nodeDropShadowCSS({
        shadowEnabled: true,
        shadowColor: "#000000",
        shadowOpacity: 0.25,
        shadowBlur: 12,
        shadowOffsetX: 0,
        shadowOffsetY: 4,
      } as WhiteboardNode)
    ).toBe("drop-shadow(0px 4px 12px rgba(0,0,0,0.25))");
  });

  it("computes stroke dasharray based on style and strokeWidth", () => {
    expect(dashArrayFor("solid", 2)).toBeUndefined();
    expect(dashArrayFor(undefined, 2)).toBeUndefined();
    expect(dashArrayFor("dashed", 2)).toBe("8,6");
    expect(dashArrayFor("dotted", 2)).toBe("1,6.2");
  });
});
