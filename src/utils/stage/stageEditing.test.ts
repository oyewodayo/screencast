import { describe, expect, it } from "vitest";
import { resolvedBeats } from "./stageEngine";
import { addBeat, addElement, beatIndexAt, beatRestTime, deleteBeat, deleteElement, duplicateScene, elementInBeat, makeShapeElement, makeStageScene, sceneDuration, setBeatHold, setElementProps, setSceneDuration, stageWidthFor } from "./stageEditing";
import { StageScene } from "./stageTypes";

// Three beats, the title's text and colour changed along the way.
function threeBeats(): { s: StageScene; title: string } {
  let s = makeStageScene({ startTime: 2, frameWidth: 1920, frameHeight: 1080 });
  const title = s.elements.find((e) => e.kind === "text")!.id;
  s = addBeat(s, 0).scene;
  s = addBeat(s, 1).scene;
  return { s, title };
}
const states = (s: StageScene, id: string) => resolvedBeats(s, s.elements.find((e) => e.id === id)!);

describe("a new scene", () => {
  it("fits the frame's shape and starts with a centred title in one beat", () => {
    const s = makeStageScene({ startTime: 1.5, frameWidth: 1080, frameHeight: 1920 });
    expect(s.width).toBeCloseTo(607.5, 3);
    expect(stageWidthFor(1920, 1080)).toBe(1920);
    expect(s.beats).toHaveLength(1);
    const title = s.elements.find((e) => e.kind === "text")!;
    expect(title.parent).toBe(s.elements[0].id);
    expect(sceneDuration(s)).toBe(3);
  });
});

describe("editing in a beat", () => {
  it("carries a change forward until a later beat changes the same thing", () => {
    let { s, title } = threeBeats();
    s = setElementProps(s, 2, title, { color: "#ff0000" });
    s = setElementProps(s, 1, title, { color: "#999999", text: "Changed" });
    const r = states(s, title);
    expect(r.map((p) => p.color)).toEqual(["#111111", "#999999", "#ff0000"]);
    expect(r.map((p) => p.text)).toEqual(["Your title", "Changed", "Changed"]);
  });

  it("records nothing when a value is set back to how the element already looks there", () => {
    let { s, title } = threeBeats();
    s = setElementProps(s, 1, title, { color: "#999999" });
    s = setElementProps(s, 1, title, { color: "#111111" });
    expect(s.beats[1].changes[title]).toBeUndefined();
    expect(Object.keys(s.beats[1].changes)).toHaveLength(0);
  });

  it("changes the element itself in the first beat", () => {
    let { s, title } = threeBeats();
    s = setElementProps(s, 0, title, { text: "Hello" });
    expect(s.elements.find((e) => e.id === title)!.props.text).toBe("Hello");
    expect(states(s, title).map((p) => p.text)).toEqual(["Hello", "Hello", "Hello"]);
  });

  it("brings a new element in at the beat it's added in, hidden before", () => {
    let { s } = threeBeats();
    const box = makeShapeElement({ x: 10, y: 10 });
    s = addElement(s, 1, box);
    expect(states(s, box.id).map((p) => p.visible)).toEqual([false, true, true]);
    const first = makeShapeElement({ x: 0, y: 0 });
    s = addElement(s, 0, first);
    expect(states(s, first.id).every((p) => p.visible)).toBe(true);
  });

  it("deletes an element with everything inside it and every beat's changes to them", () => {
    let { s, title } = threeBeats();
    s = setElementProps(s, 1, title, { color: "#999999" });
    const stack = s.elements[0].id;
    s = deleteElement(s, stack);
    expect(s.elements).toHaveLength(0);
    expect(s.beats.every((b) => Object.keys(b.changes).length === 0)).toBe(true);
  });
});

describe("beats", () => {
  it("inserts a beat that starts out looking like the one before", () => {
    let { s, title } = threeBeats();
    s = setElementProps(s, 1, title, { text: "Two" });
    const { scene, index } = addBeat(s, 1);
    expect(index).toBe(2);
    expect(states(scene, title).map((p) => p.text)).toEqual(["Your title", "Two", "Two", "Two"]);
  });

  it("removes a beat without changing how any later beat looks", () => {
    let { s, title } = threeBeats();
    s = setElementProps(s, 1, title, { text: "Two", color: "#999999" });
    s = setElementProps(s, 2, title, { color: "#ff0000" });
    const later = states(s, title)[2];
    const removed = deleteBeat(s, 1);
    expect(removed.beats).toHaveLength(2);
    expect(states(removed, title)[1]).toEqual(later);
    // The first beat: its changes become the elements' own.
    const first = deleteBeat(setElementProps(s, 0, title, { text: "Zero" }), 0);
    expect(states(first, title)[0].text).toBe("Two");
    expect(deleteBeat(makeStageScene({ startTime: 0, frameWidth: 16, frameHeight: 9 }), 0).beats).toHaveLength(1);
  });

  it("times beats by their holds, clamped to sensible lengths", () => {
    let { s } = threeBeats();
    s = setBeatHold(s, 0, 1);
    s = setBeatHold(s, 1, -5);
    expect(s.beats[1].hold).toBe(0.1);
    expect(beatIndexAt(s, 0.5)).toBe(0);
    expect(beatIndexAt(s, 1.05)).toBe(1);
    expect(beatIndexAt(s, 99)).toBe(2);
    expect(beatRestTime(s, 1)).toBeCloseTo(2 + 1 + 0.1 - 1 / 60, 9);
    s = setSceneDuration(s, 10);
    expect(sceneDuration(s)).toBeCloseTo(10, 9);
  });

  it("duplicates with fresh ids that still point at each other", () => {
    const { s, title } = threeBeats();
    const withChange = setElementProps(s, 1, title, { text: "Two" });
    const copy = duplicateScene(withChange, 9);
    expect(copy.id).not.toBe(s.id);
    const copiedTitle = copy.elements.find((e) => e.kind === "text")!;
    expect(copiedTitle.id).not.toBe(title);
    expect(copiedTitle.parent).toBe(copy.elements[0].id);
    expect(elementInBeat(copy, 1, copiedTitle.id)!.text).toBe("Two");
  });
});
