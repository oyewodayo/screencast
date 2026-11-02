import { describe, expect, it } from "vitest";
import { compileStage, resolvedBeats, sampleStage, stageBeatAt, stageIsMoving } from "./stageEngine";
import { StageBeat, StageElement, StageProps, StageScene, defaultStageProps } from "./stageTypes";
import { parseStageColor } from "./stageColor";

const el = (id: string, props: Partial<StageProps> = {}): StageElement => ({ id, kind: "text", props: defaultStageProps({ width: 600, height: 60, color: "#111111", ...props }) });
const beat = (hold: number, changes: StageBeat["changes"] = {}, extra: Partial<StageBeat> = {}): StageBeat => ({ id: `b${Math.random()}`, hold, changes, ...extra });
const scene = (elements: StageElement[], beats: StageBeat[], extra: Partial<StageScene> = {}): StageScene => ({
  id: "s",
  startTime: 0,
  width: 1920,
  height: 1080,
  background: { kind: "color", color: "#e8e8e8" },
  elements,
  beats,
  spring: "smooth",
  stagger: 0,
  ...extra,
});
const at = (s: StageScene, t: number, id: string) => sampleStage(compileStage(s), t).find((e) => e.id === id);

// The Insomnia headline beat: a line arrives, then moves up and dims as a second line comes in.
const headline = () =>
  scene(
    [el("easy", { x: 660, y: 500, text: "Keeping a Mac awake is easy." }), el("battery", { x: 660, y: 540, text: "Keeping it alive on battery isn't.", visible: false })],
    [beat(1.5), beat(2, { easy: { y: 470, color: "#9a9a9a" }, battery: { visible: true } })]
  );

describe("beats", () => {
  it("carry each change forward until a later beat changes it", () => {
    const s = scene([el("a", { x: 0 })], [beat(1, { a: { x: 10 } }), beat(1, { a: { opacity: 0.5 } }), beat(1, { a: { x: 30 } })]);
    const r = resolvedBeats(s, s.elements[0]);
    expect(r.map((p) => p.x)).toEqual([10, 10, 30]);
    expect(r.map((p) => p.opacity)).toEqual([1, 0.5, 0.5]);
  });

  it("time the scene by their holds", () => {
    const c = compileStage(headline());
    expect(c.duration).toBe(3.5);
    expect(c.beatStarts).toEqual([0, 1.5]);
    expect(stageBeatAt(c, 1.49)).toBe(0);
    expect(stageBeatAt(c, 1.5)).toBe(1);
  });
});

describe("entrances and exits", () => {
  it("brings a shown element in from below, blurred and transparent, to rest", () => {
    const s = headline();
    expect(at(s, 0, "easy")).toBeUndefined();
    const mid = at(s, 0.15, "easy")!;
    expect(mid.opacity).toBeGreaterThan(0);
    expect(mid.opacity).toBeLessThan(1);
    expect(mid.y).toBeGreaterThan(500);
    expect(mid.blur).toBeGreaterThan(0);
    const settled = at(s, 1.45, "easy")!;
    expect(settled.y).toBeCloseTo(500, 1);
    expect(settled.opacity).toBeCloseTo(1, 3);
    expect(settled.blur).toBeCloseTo(0, 2);
    expect(settled.moving).toBe(false);
  });

  it("keeps a hidden element out until its beat, then moves the first line up and dims it", () => {
    const s = headline();
    expect(at(s, 1.4, "battery")).toBeUndefined();
    const end = at(s, 3.4, "easy")!;
    expect(end.y).toBeCloseTo(470, 1);
    expect(parseStageColor(end.color)!.slice(0, 3)).toEqual([154, 154, 154]);
    expect(at(s, 3.4, "battery")!.opacity).toBeCloseTo(1, 3);
  });

  it("fades a hidden element out where it was, keeping its text", () => {
    const s = scene([el("a", { x: 100, text: "Lid closed." })], [beat(1), beat(1, { a: { visible: false, x: 900, text: "gone" } })]);
    const leaving = at(s, 1.1, "a")!;
    expect(leaving.x).toBeCloseTo(100, 6);
    expect(leaving.text).toBe("Lid closed.");
    expect(leaving.opacity).toBeLessThan(1);
    expect(at(s, 1.99, "a")).toBeUndefined();
  });

  it("re-enters fresh at its new place after it was fully gone - no slide from where it left", () => {
    const s = scene([el("a", { x: 100 })], [beat(1), beat(1, { a: { visible: false } }), beat(1, { a: { visible: true, x: 900 } })]);
    const back = at(s, 2.05, "a")!;
    expect(back.x).toBeCloseTo(900, 6);
  });
});

describe("motion", () => {
  it("staggers the elements that move in a beat, in stacking order", () => {
    const s = scene([el("a"), el("b"), el("c")], [beat(2)], { stagger: 0.1 });
    expect(at(s, 0.05, "a")).toBeDefined();
    expect(at(s, 0.05, "b")).toBeUndefined();
    expect(at(s, 0.15, "b")).toBeDefined();
    expect(at(s, 0.15, "c")).toBeUndefined();
  });

  it("carries an interrupted move on with the same position and velocity", () => {
    // Beat 2 arrives 0.1s into beat 1's move - long before it settles.
    const s = scene([el("a", { x: 0 })], [beat(1), beat(0.1, { a: { x: 1000 } }), beat(2, { a: { x: 0 } })]);
    const c = compileStage(s);
    const x = (t: number) => sampleStage(c, t).find((e) => e.id === "a")!.x;
    const t = 1.1;
    // No jump: a nanosecond either side of the new beat it's in the same place.
    expect(Math.abs(x(t + 1e-9) - x(t - 1e-9))).toBeLessThan(1e-3);
    const h = 1e-5;
    const vBefore = (x(t - h) - x(t - 2 * h)) / h;
    const vAfter = (x(t + 2 * h) - x(t + h)) / h;
    expect(vBefore).toBeGreaterThan(1000);
    expect(Math.abs(vAfter - vBefore) / vBefore).toBeLessThan(0.02);
  });

  it("lets geometry overshoot with a bouncy spring but never opacity or colour", () => {
    const s = scene([el("a", { x: 0, color: "#000000" })], [beat(1), beat(3, { a: { x: 100, color: "#ffffff" } })], { spring: "bouncy" });
    const c = compileStage(s);
    let maxX = 0;
    let maxOpacity = 0;
    let maxR = 0;
    for (let t = 0; t < 4; t += 0.01) {
      const e = sampleStage(c, t).find((x) => x.id === "a");
      if (!e) continue;
      maxX = Math.max(maxX, e.x);
      maxOpacity = Math.max(maxOpacity, e.opacity);
      maxR = Math.max(maxR, parseStageColor(e.color)![0]);
    }
    expect(maxX).toBeGreaterThan(105);
    expect(maxOpacity).toBeLessThanOrEqual(1);
    expect(maxR).toBeLessThanOrEqual(255);
  });

  it("gives the same frame however it is reached - scrubbing backwards matches playback", () => {
    const c = compileStage(headline());
    const forward = [0.3, 1.7, 2.2].map((t) => sampleStage(c, t));
    const backward = [2.2, 1.7, 0.3].map((t) => sampleStage(c, t)).reverse();
    expect(backward).toEqual(forward);
  });

  it("knows when nothing is moving, and when a beat is about to start something", () => {
    const c = compileStage(headline());
    expect(stageIsMoving(c, 0.2)).toBe(true);
    expect(stageIsMoving(c, 1.45)).toBe(false);
    expect(stageIsMoving(c, 1.45, 1.6)).toBe(true);
    expect(stageIsMoving(c, 3.45)).toBe(false);
  });

  it("switches text when its move begins and lets a zero-length beat be overtaken", () => {
    const s = scene([el("a", { text: "Lid closed." })], [beat(1), beat(0, { a: { text: "x", x: 50 } }), beat(1, { a: { text: "Lid closed. Still running.", x: 0 } })]);
    const e = at(s, 1.01, "a")!;
    expect(e.text).toBe("Lid closed. Still running.");
    expect(Math.abs(e.x)).toBeLessThan(1);
  });

  it("survives empty, negative and missing timings", () => {
    const s = scene([el("a")], [beat(-3), beat(Number.NaN)], { stagger: -1 });
    const c = compileStage(s);
    expect(c.duration).toBe(0);
    expect(() => sampleStage(c, 10)).not.toThrow();
    expect(compileStage(scene([el("a")], [])).duration).toBe(0);
  });
});

describe("connectors", () => {
  const line = (props: Partial<StageProps> = {}): StageElement => ({
    id: "line",
    kind: "connector",
    connector: { from: "a", to: "b", style: "dots", thickness: 6, gap: 10 },
    props: defaultStageProps({ width: 0, height: 0, color: "#3b82f6", ...props }),
  });
  const diagram = () =>
    scene([el("a", { x: 100, y: 100 }), el("b", { x: 1200, y: 100 }), line({ visible: false })], [beat(1), beat(2, { line: { visible: true } }), beat(1, { line: { visible: false } })]);

  it("draws itself on from nothing, unblurred and in place, never past its end", () => {
    const s = diagram();
    expect(at(s, 0.9, "line")).toBeUndefined();
    const samples = [1.02, 1.1, 1.2, 1.4, 1.8].map((t) => at(s, t, "line")!);
    for (let i = 1; i < samples.length; i++) expect(samples[i].draw).toBeGreaterThanOrEqual(samples[i - 1].draw);
    expect(samples[0].draw).toBeLessThan(0.5);
    for (const x of samples) {
      expect(x.draw).toBeLessThanOrEqual(1);
      expect(x.blur).toBe(0);
      expect(x.y).toBe(0);
    }
    expect(at(s, 2.9, "line")!.draw).toBeCloseTo(1, 3);
  });

  it("fades away whole when hidden, rather than undrawing", () => {
    const s = diagram();
    const leaving = at(s, 3.1, "line")!;
    expect(leaving.opacity).toBeLessThan(1);
    expect(leaving.draw).toBeCloseTo(1, 3);
  });

  it("springs a beat's drawn amount like any other channel, and other elements default to fully drawn", () => {
    const s = scene([el("a"), el("b"), line({ draw: 0.2 })], [beat(1), beat(2, { line: { draw: 1 } })]);
    expect(at(s, 0.95, "line")!.draw).toBeCloseTo(0.2, 2);
    const mid = at(s, 1.15, "line")!;
    expect(mid.draw).toBeGreaterThan(0.2);
    expect(mid.draw).toBeLessThan(1);
    expect(mid.moving).toBe(true);
    expect(at(s, 2.9, "line")!.draw).toBeCloseTo(1, 3);
    expect(at(s, 2.9, "a")!.draw).toBe(1);
  });
});

describe("depth and reveals", () => {
  it("springs tilt and depth like position, back to flat when a beat clears them", () => {
    const card = el("card", { rotateY: 0 });
    const s = scene([card], [beat(1), beat(1.5, { card: { rotateY: 30, z: -200 } }), beat(1.5, { card: { rotateY: 0, z: 0 } })]);
    expect(at(s, 0.9, "card")!.rotateY).toBe(0);
    const mid = at(s, 1.15, "card")!;
    expect(mid.rotateY).toBeGreaterThan(0);
    expect(mid.rotateY).toBeLessThan(30);
    expect(mid.z).toBeLessThan(0);
    expect(mid.moving).toBe(true);
    expect(at(s, 2.45, "card")!.rotateY).toBeCloseTo(30, 0);
    expect(at(s, 3.95, "card")!.z).toBeCloseTo(0, 0);
  });

  it("brings a dot-revealed picture in whole and undrawn, its reveal springing on", () => {
    const pic: StageElement = { id: "pic", kind: "image", image: { src: "x.png", reveal: "dots" }, props: defaultStageProps({ width: 300, height: 400, visible: false }) };
    const s = scene([pic], [beat(0.5), beat(3, { pic: { visible: true } })]);
    const first = at(s, 0.52, "pic")!;
    expect(first.opacity).toBeGreaterThan(0.9);
    expect(first.blur).toBe(0);
    expect(first.draw).toBeLessThan(0.2);
    expect(at(s, 3.4, "pic")!.draw).toBeCloseTo(1, 2);
  });

  it("settles a slow spring well after a gentle one", () => {
    const run = (spring: "slow" | "gentle") => at(scene([el("a", { x: 0 })], [beat(0.5), beat(3, { a: { x: 100 } })], { spring }), 1.0, "a")!.x;
    expect(run("gentle")).toBeGreaterThan(run("slow") + 10);
  });
});

describe("equations", () => {
  const eq = (text: string, props: Partial<StageProps> = {}): StageElement => ({ id: "eq", kind: "math", textLook: { fontSize: 64 }, props: defaultStageProps({ width: 400, height: 100, text, color: "#ffffff", ...props }) });

  it("rewrites itself over a second when its TeX changes in a beat - moving the whole time, the old TeX carried", () => {
    const s = scene([eq("a^2+b^2")], [beat(1), beat(2, { eq: { text: "a^2+b^2=c^2" } })]);
    const c = compileStage(s);
    expect(sampleStage(c, 0.95).find((e) => e.id === "eq")!.morphFrom).toBeUndefined();
    const mid = sampleStage(c, 1.5).find((e) => e.id === "eq")!;
    expect(mid.text).toBe("a^2+b^2=c^2");
    expect(mid.morphFrom).toBe("a^2+b^2");
    expect(mid.morph).toBeCloseTo(0.5, 2);
    expect(mid.moving).toBe(true);
    expect(stageIsMoving(c, 1.9)).toBe(true);
    const after = sampleStage(c, 2.1).find((e) => e.id === "eq")!;
    expect(after.morphFrom).toBeUndefined();
  });

  it("arrives fresh rather than morphing from nothing", () => {
    const s = scene([eq("x", { visible: false })], [beat(1), beat(2, { eq: { visible: true, text: "y" } })]);
    expect(sampleStage(compileStage(s), 1.3).find((e) => e.id === "eq")!.morphFrom).toBeUndefined();
  });
});
