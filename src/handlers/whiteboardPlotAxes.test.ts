import { describe, expect, it } from "vitest";
import { annotationCoordinateMapper, ChartLabel, shapeOutlineFor, ShapeOutlineOptions } from "./whiteboardHandlers";

function chart(opts: ShapeOutlineOptions, w = 300, h = 240) {
  const outline = shapeOutlineFor("graph", w, h, { fontSize: 16, ...opts });
  if (outline.kind !== "chart") throw new Error("expected a chart outline");
  return outline;
}
const isNumber = (l: ChartLabel) => /^-?[\d.]+$/.test(l.text);

describe("plot axes", () => {
  it("labels an auto-fit axis with round numbers", () => {
    const labels = chart({ graphExpression: "sin(x)*x/3" }).labels!.filter(isNumber);
    for (const l of labels) expect(Number(l.text) % 0.5).toBeCloseTo(0);
  });

  it("puts edge-placement x numbers below the plot box and inside the node", () => {
    const outline = chart({ graphExpression: "", axisPlacement: "edge" });
    const mapper = annotationCoordinateMapper("graph", 300, 240, { graphExpression: "", axisPlacement: "edge", fontSize: 16 });
    const xLabels = outline.labels!.filter((l) => l.anchor === "middle");
    expect(xLabels.length).toBeGreaterThan(0);
    for (const l of xLabels) {
      expect(l.y).toBeGreaterThan(mapper.padY + mapper.plotH);
      expect(l.y + 8).toBeLessThanOrEqual(240);
    }
  });

  it("puts right-side y numbers to the right of the plot box", () => {
    const outline = chart({ graphExpression: "", axisPlacement: "box", yLabelSide: "right" });
    const mapper = annotationCoordinateMapper("graph", 300, 240, { graphExpression: "", axisPlacement: "box", yLabelSide: "right", fontSize: 16 });
    const yLabels = outline.labels!.filter((l) => l.anchor === "start");
    expect(yLabels.length).toBeGreaterThan(0);
    for (const l of yLabels) expect(l.x).toBeGreaterThan(mapper.padX + mapper.plotW);
  });

  it("thins crowded tick numbers so neighbors never overlap", () => {
    const outline = chart({ graphExpression: "", graphXTickInterval: 1.5, graphYMin: -9, graphYMax: 9 }, 288, 240);
    const xs = outline.labels!.filter((l) => l.anchor === "middle").map((l) => l.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThan(30);
  });

  it("carries grid color and opacity on the grid part", () => {
    const grid = chart({ graphExpression: "", gridColor: "#ff0000", gridOpacity: 0.3 }).parts.find((p) => p.role === "grid");
    expect(grid).toMatchObject({ color: "#ff0000", opacity: 0.3 });
  });

  it("leaves the default origin layout without gutters", () => {
    const mapper = annotationCoordinateMapper("graph", 300, 240, { graphExpression: "", fontSize: 16 });
    expect(mapper.padX).toBeCloseTo(300 * 0.08);
    expect(mapper.padY).toBeCloseTo(240 * 0.08);
  });
});
