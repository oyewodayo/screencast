import { describe, expect, it } from "vitest";
import { FORM_KIND, MAX_VERTS, SHAPE_PRESETS, formOutline, insetOutline, presetSvgPath } from "./stageShapes";
import { compileStage, sampleStage, stageIsMoving } from "./stageEngine";
import { StageScene, defaultStageProps } from "./stageTypes";

const bounds = (pts: [number, number][]) => ({
  x0: Math.min(...pts.map((p) => p[0])),
  x1: Math.max(...pts.map((p) => p[0])),
  y0: Math.min(...pts.map((p) => p[1])),
  y1: Math.max(...pts.map((p) => p[1])),
});

describe("shape outlines", () => {
  it("every outline fills its box exactly and fits the shader", () => {
    for (const p of SHAPE_PRESETS) {
      if (FORM_KIND[p.form] !== 2) continue;
      const pts = formOutline(p.form, 300, 200, p.sides ?? 0, p.inner ?? 0.4, { round: 20 })!;
      expect(pts.length).toBeLessThanOrEqual(MAX_VERTS);
      const b = bounds(pts);
      expect(b.x1 - b.x0).toBeCloseTo(300, 0);
      expect(b.y1 - b.y0).toBeCloseTo(200, 0);
      // Every preset has a thumbnail.
      expect(presetSvgPath(p, 24, 24)).toMatch(/^M.*Z$/);
    }
  });

  it("insets an outline so rounding keeps the shape's size, and caps the radius at short edges", () => {
    const tri = formOutline("triangle", 200, 200, 0, 0)!;
    const { pts, r } = insetOutline(tri, 20);
    expect(r).toBe(20);
    const b = bounds(pts);
    expect(b.x1 - b.x0).toBeLessThan(200);
    expect(b.y0).toBeGreaterThan(-100);
    const tiny = insetOutline(formOutline("diamond", 20, 20, 0, 0)!, 50);
    expect(tiny.r).toBeLessThan(10);
  });

  it("mirrors and flips", () => {
    const right = formOutline("right-triangle", 100, 100, 0, 0)!;
    const mirrored = formOutline("right-triangle", 100, 100, 0, 0, { flipX: true })!;
    expect(right.some(([x, y]) => x === -50 && y === -50)).toBe(true);
    expect(mirrored.some(([x, y]) => x === 50 && y === -50)).toBe(true);
  });
});

describe("shapes in a scene", () => {
  const scene = (beats: StageScene["beats"]): StageScene => ({
    id: "s",
    startTime: 0,
    width: 1920,
    height: 1080,
    background: { kind: "color", color: "#000" },
    elements: [{ id: "a", kind: "shape", shape: { radius: 10 }, props: defaultStageProps({ width: 200, height: 200, color: "#fff", form: "ring", inner: 0.7, sweep: 90 }) }],
    beats,
    spring: "smooth",
    stagger: 0,
  });

  it("springs a ring's sweep between beats - a progress ring filling", () => {
    const c = compileStage(scene([{ id: "b0", hold: 1, changes: {} }, { id: "b1", hold: 3, changes: { a: { sweep: 300 } } }]));
    const at = (t: number) => sampleStage(c, t).find((e) => e.id === "a")!;
    expect(at(0.9).sweep).toBeCloseTo(90, 0);
    const mid = at(1.25).sweep!;
    expect(mid).toBeGreaterThan(90);
    expect(mid).toBeLessThan(300);
    expect(at(3.9).sweep).toBeCloseTo(300, 0);
  });

  it("morphs from one form to the next, springing the new form's defaults", () => {
    const c = compileStage(scene([{ id: "b0", hold: 1, changes: {} }, { id: "b1", hold: 2, changes: { a: { form: "star", sides: 5, inner: undefined, sweep: undefined } } }]));
    const mid = sampleStage(c, 1.3).find((e) => e.id === "a")!;
    expect(mid.form).toBe("star");
    expect(mid.morphShape?.form).toBe("ring");
    expect(mid.morph).toBeGreaterThan(0);
    expect(mid.morph).toBeLessThan(1);
    expect(stageIsMoving(c, 1.3)).toBe(true);
    const end = sampleStage(c, 2.9).find((e) => e.id === "a")!;
    expect(end.morphShape).toBeUndefined();
    // The star's default depth, and the element's own corners.
    expect(end.inner).toBeCloseTo(0.5, 2);
    expect(end.radius).toBeCloseTo(10, 1);
  });
});
