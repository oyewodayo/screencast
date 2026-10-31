import { describe, expect, it } from "vitest";
import { createDefaultWhiteboardEdge, createDefaultWhiteboardNode, nodeHasFill, resolveFillType, resolveGradientStops, WhiteboardNode, WhiteboardPage } from "../utils/whiteboardTypes";
import {
  buildEdgePath,
  dashArrayFor,
  detectShapeCorners,
  edgePointAtFraction,
  fillImageRect,
  fillPatternTile,
  flipEdge,
  hexToRgba,
  linearGradientPoints,
  nodeDropShadowCSS,
  reorderPageItems,
  resolveBoxCornerRadii,
  resolvePageLayerOrder,
  reverseEdgeDirection,
  roundedPolygonD,
  scaleEdgeLength,
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

  it("detects corners with directional labels across shapes", () => {
    expect(detectShapeCorners(node("triangle")).map((c) => c.label)).toEqual(["Top", "Bottom-right", "Bottom-left"]);
    expect(detectShapeCorners(node("triangle", { flipVertical: true })).map((c) => c.label)).toEqual(["Bottom", "Top-right", "Top-left"]);
    expect(detectShapeCorners(node("rectangle")).map((c) => c.label)).toEqual(["Top-left", "Top-right", "Bottom-right", "Bottom-left"]);
    expect(detectShapeCorners(node("diamond")).map((c) => c.label)).toEqual(["Top", "Right", "Bottom", "Left"]);
    expect(detectShapeCorners(node("hexagon")).map((c) => c.label)).toEqual(["Top-left", "Top-right", "Right", "Bottom-right", "Bottom-left", "Left"]);
    expect(detectShapeCorners(node("polygon", { sides: 5 })).map((c) => c.label)).toEqual(["Top", "Top-right", "Bottom-right", "Bottom-left", "Top-left"]);
    expect(detectShapeCorners(node("ellipse"))).toEqual([]);
  });

  it("rounds only the targeted corner when cornerRadii is set", () => {
    // Round only the Top corner (index 0) of a triangle; bottom corners stay sharp.
    const outline = shapeOutlineFor("triangle", 160, 130, { cornerRadius: 0, cornerRadii: [20, null, null] });
    expect(outline.kind).toBe("path");
    if (outline.kind !== "path") return;
    expect(outline.d.match(/Q/g)?.length).toBe(1);
    expect(outline.d).toContain("L160,130");
    expect(outline.d).toContain("L0,130");
  });

  it("resolves per-corner box radii with fallback to cornerRadius", () => {
    expect(resolveBoxCornerRadii({ width: 100, height: 80, cornerRadius: 10, cornerRadii: [25, null, 0, null] })).toEqual([25, 10, 0, 10]);
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

  it("fits an image fill by cover/contain/fill and applies pan/zoom offsets", () => {
    expect(fillImageRect("cover", 100, 100, 200, 100)).toEqual({ x: -50, y: 0, w: 200, h: 100 });
    expect(fillImageRect("contain", 100, 100, 200, 100)).toEqual({ x: 0, y: 25, w: 100, h: 50 });
    expect(fillImageRect("fill", 100, 100, 200, 100)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(fillImageRect("cover", 100, 100, 200, 100, 0.25, -0.1, 1.5)).toEqual({ x: -75, y: -35, w: 300, h: 150 });
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

describe("connector transforms, routing, and unified layer ordering", () => {
  it("flips a free-floating connector horizontally and vertically around its bounds", () => {
    const e = createDefaultWhiteboardEdge("e1", { x: 100, y: 50 }, { x: 200, y: 150 });
    const hFlipped = flipEdge(e, "horizontal", new Map());
    expect(hFlipped.source).toEqual({ x: 200, y: 50 });
    expect(hFlipped.target).toEqual({ x: 100, y: 150 });

    const vFlipped = flipEdge(e, "vertical", new Map());
    expect(vFlipped.source).toEqual({ x: 100, y: 150 });
    expect(vFlipped.target).toEqual({ x: 200, y: 50 });
  });

  it("reverses a connector's direction, keeping each arrowhead on its own end of the path", () => {
    const e = {
      ...createDefaultWhiteboardEdge("e1", { x: 10, y: 20 }, { x: 110, y: 20 }),
      startArrowType: "none" as const,
      endArrowType: "triangle" as const,
      waypoints: [{ x: 40, y: 10 }, { x: 80, y: 30 }],
      curveBow: 0.4,
    };
    const rev = reverseEdgeDirection(e);
    expect(rev.source).toEqual({ x: 110, y: 20 });
    expect(rev.target).toEqual({ x: 10, y: 20 });
    // Arrowheads stay on the path's own start/end, so after the endpoints swap the head lands on
    // the opposite physical end - that is what makes the connector visibly point the other way.
    expect(rev.startArrowType).toBe("none");
    expect(rev.endArrowType).toBe("triangle");
    expect(rev.waypoints).toEqual([{ x: 80, y: 30 }, { x: 40, y: 10 }]);
    expect(rev.curveBow).toBeCloseTo(-0.4);
  });

  it("scales a free-floating connector's length symmetrically around its midpoint", () => {
    const e = createDefaultWhiteboardEdge("e1", { x: 100, y: 50 }, { x: 200, y: 50 });
    const scaled = scaleEdgeLength(e, 200);
    expect(scaled.source.x).toBeCloseTo(50);
    expect(scaled.target.x).toBeCloseTo(250);
    expect(scaled.source.y).toBeCloseTo(50);
    expect(scaled.target.y).toBeCloseTo(50);
  });

  it("routes an orthogonal free-floating connector with rounded corners when cornerRadius > 0", () => {
    const path = buildEdgePath({ x: 0, y: 0, side: null }, { x: 100, y: 80, side: null }, "orthogonal", undefined, undefined, 12);
    expect(path).toContain("Q");
  });

  it("interpolates edgePointAtFraction along a straight connector", () => {
    const from = { x: 0, y: 0, side: null };
    const to = { x: 100, y: 0, side: null };
    expect(edgePointAtFraction(from, to, "straight", undefined, undefined, 0.25)).toEqual({ x: 25, y: 0 });
    expect(edgePointAtFraction(from, to, "straight", undefined, undefined, 0.75)).toEqual({ x: 75, y: 0 });
  });

  it("orders and reorders nodes and connectors in a unified layer stack (front, back, forward, backward)", () => {
    const n1 = createDefaultWhiteboardNode("n1", "rectangle", 0, 0);
    const n2 = createDefaultWhiteboardNode("n2", "ellipse", 50, 50);
    const e1 = createDefaultWhiteboardEdge("e1", { x: 0, y: 0 }, { x: 100, y: 100 });
    const page: WhiteboardPage = { id: "p1", name: "Page 1", nodes: [n1, n2], edges: [e1] };

    // resolvePageLayerOrder maps each id to its rank; read the stack back bottom-to-top.
    const stackOrder = (p: WhiteboardPage) =>
      [...resolvePageLayerOrder(p).entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);

    // Default order: nodes first (n1, n2), then edges (e1)
    expect(stackOrder(page)).toEqual(["n1", "n2", "e1"]);

    // Send e1 to back -> e1 should now be behind n1 and n2
    const sentBack = reorderPageItems(page, new Set(["e1"]), "back");
    const pageAfterBack: WhiteboardPage = { ...page, nodes: sentBack.nodes, edges: sentBack.edges };
    expect(stackOrder(pageAfterBack)).toEqual(["e1", "n1", "n2"]);

    // Bring e1 forward one step -> between n1 and n2
    const forward = reorderPageItems(pageAfterBack, new Set(["e1"]), "forward");
    const pageAfterForward: WhiteboardPage = { ...page, nodes: forward.nodes, edges: forward.edges };
    expect(stackOrder(pageAfterForward)).toEqual(["n1", "e1", "n2"]);

    // Bring n1 to front -> n1 on top of everything
    const front = reorderPageItems(pageAfterForward, new Set(["n1"]), "front");
    const pageAfterFront: WhiteboardPage = { ...page, nodes: front.nodes, edges: front.edges };
    expect(stackOrder(pageAfterFront)).toEqual(["e1", "n2", "n1"]);
  });
});
