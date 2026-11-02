import { describe, expect, it } from "vitest";
import { GraphState, defaultGraph, descentAt, descentPath, graphMoving, integrate, niceTicks, sampleCurve, tickLabel } from "./stageGraph";
import { compileStage, sampleStage, stageIsMoving } from "./stageEngine";
import { StageChannel } from "./stageChannels";
import { StageElement, StageScene, defaultStageProps } from "./stageTypes";

describe("graph numbers", () => {
  it("picks ticks a person would: 1, 2 or 5 times a power of ten", () => {
    expect(niceTicks(-6, 6, 6)).toEqual([-6, -4, -2, 0, 2, 4, 6]);
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1].map((v) => expect.closeTo(v, 9)));
    expect(niceTicks(-0.03, 0.03, 6).includes(0)).toBe(true);
    expect(tickLabel(-2, 2)).toBe("−2");
    expect(tickLabel(0.25, 0.05)).toBe("0.25");
  });

  it("breaks a curve at its asymptotes instead of joining them with a false line", () => {
    const runs = sampleCurve(Math.tan, -3, 3, 600, -4, 4);
    // tan has asymptotes at ±pi/2 inside [-3, 3]: three separate pieces.
    expect(runs.length).toBe(3);
    const runsInv = sampleCurve((x) => 1 / x, -2, 2, 401, -5, 5);
    expect(runsInv.length).toBe(2);
  });

  it("rolls downhill to the minimum, slowing as the slope flattens, never overshooting", () => {
    const path = descentPath((x) => (x - 1) * (x - 1), -3, 0.3, 40, -6, 6);
    expect(path[path.length - 1]).toBeCloseTo(1, 3);
    for (let i = 1; i < path.length; i++) expect(path[i]).toBeGreaterThanOrEqual(path[i - 1] - 1e-9);
    // The ball's position over time: at the start, partway, and arrived.
    expect(descentAt(path, 0, 4).x).toBeCloseTo(-3);
    expect(descentAt(path, 4.5, 4).done).toBe(true);
  });

  it("finds a basin's local minimum on a bumpy curve - the one it starts in", () => {
    const bumpy = (x: number) => x * x * x * x - 3 * x * x + 0.5 * x;
    const left = descentPath(bumpy, -2, 0.05, 200, -3, 3);
    const right = descentPath(bumpy, 2, 0.05, 200, -3, 3);
    expect(left[left.length - 1]).toBeLessThan(0);
    expect(right[right.length - 1]).toBeGreaterThan(0);
  });

  it("integrates accurately", () => {
    expect(integrate((x) => x * x, 0, 3)).toBeCloseTo(9, 8);
    expect(integrate(Math.sin, 0, Math.PI)).toBeCloseTo(2, 8);
  });

  it("knows when a graph animates by itself", () => {
    const channels = new Map<string, StageChannel>([["a", { id: "a", keys: [{ t: 0, value: 0 }, { t: 2, value: 1 }] }]]);
    const g = defaultGraph();
    expect(graphMoving(g, channels, 1, 10)).toBe(false);
    expect(graphMoving({ ...g, series: [{ ...g.series[0], expr: "sin(x - t)" }] }, channels, 1, 10)).toBe(true);
    expect(graphMoving({ ...g, series: [{ ...g.series[0], expr: "a x^2" }] }, channels, 1, 10)).toBe(true);
    expect(graphMoving({ ...g, series: [{ ...g.series[0], expr: "a x^2" }] }, channels, 3, 10)).toBe(false);
    const rolling: GraphState = { ...g, markers: [{ id: "d", kind: "descent", on: "f", color: "#fff", seconds: 4 }] };
    expect(graphMoving(rolling, channels, 0, 2)).toBe(true);
    expect(graphMoving(rolling, channels, 0, 5)).toBe(false);
  });
});

describe("graphs in a scene", () => {
  const graph = (state: GraphState): StageElement => ({ id: "g", kind: "graph", props: defaultStageProps({ width: 900, height: 560, color: "#ffffff", graph: state }) });
  const scene = (el: StageElement, beats: StageScene["beats"]): StageScene => ({ id: "s", startTime: 0, width: 1920, height: 1080, background: { kind: "color", color: "#000" }, elements: [el], beats, spring: "smooth", stagger: 0 });

  it("morphs from one state to the next over 1.2 s and carries the earlier state", () => {
    const a = defaultGraph();
    const b: GraphState = { ...a, view: { xMin: -2, xMax: 2, yMin: -1, yMax: 1 }, series: [{ ...a.series[0], expr: "x^2" }] };
    const s = scene(graph(a), [{ id: "b0", hold: 1, changes: {} }, { id: "b1", hold: 2, changes: { g: { graph: b } } }]);
    const c = compileStage(s);
    const mid = sampleStage(c, 1.6).find((e) => e.id === "g")!;
    expect(mid.graph).toBe(b);
    expect(mid.morphGraph).toBe(a);
    expect(mid.morph).toBeCloseTo(0.5, 2);
    expect(stageIsMoving(c, 2.1)).toBe(true);
    expect(sampleStage(c, 2.4).find((e) => e.id === "g")!.morphGraph).toBeUndefined();
  });

  it("times a descent from when its state appeared, and keeps playback rendering while it rolls", () => {
    const a = defaultGraph();
    const b: GraphState = { ...a, markers: [{ id: "d", kind: "descent", on: "f", color: "#fff", x0: -2, rate: 0.3, steps: 10, seconds: 3 }] };
    const s = scene(graph(a), [{ id: "b0", hold: 1, changes: {} }, { id: "b1", hold: 4, changes: { g: { graph: b } } }]);
    const c = compileStage(s);
    expect(sampleStage(c, 2).find((e) => e.id === "g")!.graphSince).toBeCloseTo(1, 6);
    expect(stageIsMoving(c, 3.5)).toBe(true);
    expect(stageIsMoving(c, 4.6)).toBe(false);
  });
});
