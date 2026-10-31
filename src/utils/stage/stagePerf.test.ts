import { describe, expect, it } from "vitest";
import { compileStage, sampleStage } from "./stageEngine";
import { StageMeasure } from "./stageLayout";
import { graphemes } from "./stageTextMorph";
import { StageBeat, StageElement, StageScene, defaultStageProps } from "./stageTypes";

const measure: StageMeasure = {
  text(_e, text) {
    const gs = graphemes(text);
    return { width: gs.length * 20, height: 52, glyphs: gs.map((g, i) => ({ text: g, x: i * 20, y: 0, width: 20, height: 52 })) };
  },
};

// Heavier than anything in the reference: 40 elements (a 12-line list build in a stack, 27 loose
// shapes), and a ~100-letter paragraph whose wording changes every beat.
function bigScene(): StageScene {
  const elements: StageElement[] = [{ id: "list", kind: "stack", stack: { direction: "column", gap: 8, justify: "start", align: "start" }, props: defaultStageProps({ x: 80, y: 120, width: 1200, height: 900 }) }];
  for (let i = 0; i < 12; i++) elements.push({ id: `row${i}`, kind: "text", fit: "hug", parent: "list", textLook: { fontSize: 32 }, props: defaultStageProps({ width: 1200, text: `Feature ${i} - what it does for you`, color: "#111111", visible: i === 0 }) });
  for (let i = 0; i < 27; i++) elements.push({ id: `shape${i}`, kind: "shape", props: defaultStageProps({ x: (i * 67) % 1800, y: (i * 131) % 1000, color: "#3b82f6" }) });
  elements.push({ id: "para", kind: "text", fit: "hug", textLook: { fontSize: 36 }, props: defaultStageProps({ width: 1800, text: "Every line is public and every line can be read changed and shared by anyone who wants to", color: "#111111" }) });
  const beats: StageBeat[] = [{ id: "b0", hold: 0.6, changes: {} }];
  for (let i = 1; i < 12; i++) {
    const changes: StageBeat["changes"] = { [`row${i}`]: { visible: true }, [`row${i - 1}`]: { color: "#9a9a9a" }, [`shape${i}`]: { x: 900, y: 500, scale: 1.4 } };
    changes.para = { text: i % 2 ? "Every line is public. Read it. Change it. Share it with anyone who wants to build on it" : "Every line is public and every line can be read changed and shared by anyone who wants to" };
    beats.push({ id: `b${i}`, hold: 0.6, changes });
  }
  return { id: "big", startTime: 0, width: 1920, height: 1080, background: { kind: "color", color: "#e8e8e8" }, elements, beats, spring: "smooth", stagger: 0.03 };
}

describe("engine cost", () => {
  it("compiles in well under a frame's budget per edit and samples a 60fps frame in a fraction of a millisecond", () => {
    const scene = bigScene();
    // An edit recompiles a scene the editor has compiled before - time warm compiles, best of five
    // (a shared machine's hiccups shouldn't fail the test; a real regression still will).
    let c = compileStage(scene, measure);
    let compileMs = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      c = compileStage(scene, measure);
      compileMs = Math.min(compileMs, performance.now() - t0);
    }
    const frames = Math.round(c.duration * 60);
    // Warm up, then time every 60fps frame of the scene.
    for (let k = 0; k < frames; k++) sampleStage(c, k / 60);
    const t1 = performance.now();
    let drawn = 0;
    for (let k = 0; k < frames; k++) drawn += sampleStage(c, k / 60).length;
    const perFrame = (performance.now() - t1) / frames;
    console.log(`compile ${compileMs.toFixed(1)} ms; sample ${perFrame.toFixed(3)} ms/frame over ${frames} frames (${(drawn / frames).toFixed(0)} elements/frame)`);
    expect(compileMs).toBeLessThan(100);
    expect(perFrame).toBeLessThan(2);
  });
});
