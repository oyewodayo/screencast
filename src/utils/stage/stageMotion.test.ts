import { describe, expect, it } from "vitest";
import { compileStage, sampleStage, stageIsMoving } from "./stageEngine";
import { loopsAt } from "./stageLoops";
import { StageMeasure } from "./stageLayout";
import { graphemes } from "./stageTextMorph";
import { StageElement, StageScene, defaultStageProps } from "./stageTypes";

// One line, every grapheme half the font size wide.
const measure: StageMeasure = {
  text(element, text) {
    const fs = element.textLook?.fontSize ?? 40;
    const gs = graphemes(text);
    return { width: gs.length * fs * 0.5, height: fs * 1.3, glyphs: gs.map((g, i) => ({ text: g, x: i * fs * 0.5, y: 0, width: fs * 0.5, height: fs * 1.3 })) };
  },
};

const scene = (elements: StageElement[], beats: StageScene["beats"]): StageScene => ({ id: "s", startTime: 0, width: 1920, height: 1080, background: { kind: "color", color: "#000" }, elements, beats, spring: "smooth", stagger: 0 });
const box = (extra: Partial<StageElement> = {}, props = {}): StageElement => ({ id: "a", kind: "shape", props: defaultStageProps({ x: 100, y: 100, width: 100, height: 100, color: "#fff", ...props }), ...extra });

describe("arriving and leaving", () => {
  it("can turn and tilt as it arrives, and wipe on", () => {
    const c = compileStage(scene([box({ enter: { dx: 0, dy: 0, scale: 1, blur: 0, rotate: -90, rotateY: 60, draw: 0, wipe: "right" } })], [{ id: "b", hold: 3, changes: {} }]));
    const early = sampleStage(c, 0.05).find((e) => e.id === "a")!;
    expect(early.rotation).toBeLessThan(-30);
    expect(early.rotateY).toBeGreaterThan(20);
    expect(early.wipe).toBe("right");
    expect(early.draw).toBeLessThan(1);
    const late = sampleStage(c, 2.9).find((e) => e.id === "a")!;
    expect(late.rotation).toBeCloseTo(0, 1);
    expect(late.wipe).toBeUndefined();
  });
});

describe("loops", () => {
  it("eases in, keeps going, and eases out at its last beat", () => {
    const starts = [0, 2, 4];
    const pulse = [{ kind: "pulse" as const, amount: 20, period: 1, from: 1, until: 2 }];
    expect(loopsAt(pulse, 1, starts, 6).active).toBe(false);
    expect(loopsAt(pulse, 2.5, starts, 6).delta.scale).toBeGreaterThan(1.05);
    expect(loopsAt(pulse, 4.1, starts, 6).active).toBe(false);
  });

  it("a spin comes to rest on a whole turn", () => {
    const starts = [0, 1, 3.3];
    const spin = [{ kind: "spin" as const, period: 0.9, from: 1, until: 2 }];
    const near = loopsAt(spin, 3.299, starts, 5).delta.rotation;
    expect(Math.abs(near % 360) < 1 || Math.abs((near % 360) - 360) < 1).toBe(true);
    expect(loopsAt(spin, 3.4, starts, 5).delta.rotation).toBe(0);
  });

  it("keeps the preview drawing while it runs", () => {
    const c = compileStage(scene([box({ loops: [{ kind: "float" }] })], [{ id: "b", hold: 4, changes: {} }]));
    expect(stageIsMoving(c, 3)).toBe(true);
    const a = sampleStage(c, 1).find((e) => e.id === "a")!;
    const b = sampleStage(c, 1.7).find((e) => e.id === "a")!;
    expect(a.y).not.toBeCloseTo(b.y, 1);
  });
});

describe("moving along a bent path", () => {
  it("arcs off the straight line halfway and lands exactly", () => {
    const c = compileStage(
      scene([box()], [
        { id: "b0", hold: 1, changes: {} },
        { id: "b1", hold: 3, changes: { a: { x: 900 } }, paths: { a: { bend: 0.3 } } },
      ])
    );
    let lift = 0;
    for (let t = 1; t < 2.5; t += 0.02) lift = Math.min(lift, sampleStage(c, t).find((e) => e.id === "a")!.y - 100);
    // A rightward move bent by 0.3 of 800 rises (y up) by up to ~240.
    expect(lift).toBeLessThan(-150);
    expect(sampleStage(c, 3.9).find((e) => e.id === "a")!.y).toBeCloseTo(100, 1);
  });
});

describe("text revealed unit by unit", () => {
  const text = (reveal: StageElement["textReveal"]): StageElement => ({ id: "a", kind: "text", textLook: { fontSize: 40 }, textReveal: reveal, props: defaultStageProps({ width: 800, height: 52, text: "one two", color: "#fff" }) });

  it("letters arrive one after another while the element stands still", () => {
    const c = compileStage(scene([text({ by: "letter", style: "rise", stagger: 0.1 })], [{ id: "b", hold: 3, changes: {} }]), measure);
    const s = sampleStage(c, 0.15).find((e) => e.id === "a")!;
    expect(s.glyphs).toBeDefined();
    // About two letters under way by 0.15 s - not all six.
    expect(s.glyphs!.length).toBeLessThan(5);
    expect(s.glyphs!.length).toBeGreaterThan(0);
    expect(s.opacity).toBe(1);
    expect(sampleStage(c, 2.9).find((e) => e.id === "a")!.glyphs).toBeUndefined();
  });

  it("word by word: a whole word's letters together", () => {
    const c = compileStage(scene([text({ by: "word", style: "fade", stagger: 0.5 })], [{ id: "b", hold: 3, changes: {} }]), measure);
    const s = sampleStage(c, 0.3).find((e) => e.id === "a")!;
    expect(s.glyphs!.length).toBe(3);
  });

  it("leaves letter by letter, and stays gone", () => {
    const el = text({ by: "letter", style: "fade", stagger: 0.05, exit: true });
    const c = compileStage(scene([el], [{ id: "b0", hold: 2, changes: {} }, { id: "b1", hold: 2, changes: { a: { visible: false } } }]), measure);
    const mid = sampleStage(c, 2.12).find((e) => e.id === "a")!;
    expect(mid.glyphs!.length).toBeGreaterThan(0);
    const gone = sampleStage(c, 3.9).find((e) => e.id === "a");
    expect(!gone || gone.glyphs?.length === 0).toBe(true);
  });
});
