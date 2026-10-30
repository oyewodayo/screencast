import { describe, expect, it } from "vitest";
import { resolvedBeats } from "./stageEngine";
import { addBeat, addElement, beatIndexAt, beatRestTime, deleteBeat, deleteElement, duplicateScene, elementInBeat, makeGraphElement, makeShapeElement, makeStageScene, reinkScene, duplicateElement, renameElement, sceneDuration, setBeatHold, setElementProps, setSceneDuration, stageWidthFor } from "./stageEditing";
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

describe("changing the background between light and dark", () => {
  it("moves the automatic inks across and leaves chosen colours alone", () => {
    let s = makeStageScene({ startTime: 0, frameWidth: 1920, frameHeight: 1080 });
    const title = s.elements.find((e) => e.kind === "text")!.id;
    const graph = makeGraphElement({ x: 0, y: 0, color: "#111111", curve: "#2563eb" });
    s = addElement(s, 0, graph);
    s = addBeat(s, 0).scene;
    s = setElementProps(s, 1, title, { color: "#ef4444" });
    const dark = reinkScene(s, true);
    expect(elementInBeat(dark, 0, title)!.color).toBe("#f5f5f4");
    expect(elementInBeat(dark, 1, title)!.color).toBe("#ef4444");
    expect(elementInBeat(dark, 0, graph.id)!.color).toBe("#f5f5f4");
    expect(elementInBeat(dark, 0, graph.id)!.graph!.series[0].color).toBe("#58c4dd");
    expect(elementInBeat(reinkScene(dark, false), 0, title)!.color).toBe("#111111");
  });
});

describe("inks written any way", () => {
  it("swaps an automatic ink however its colour is spelled", () => {
    let s = makeStageScene({ startTime: 0, frameWidth: 1920, frameHeight: 1080 });
    const title = s.elements.find((e) => e.kind === "text")!.id;
    s = setElementProps(s, 0, title, { color: "rgba(17, 17, 17, 1)" });
    expect(elementInBeat(reinkScene(s, true), 0, title)!.color).toBe("#f5f5f4");
  });
});

describe("a new scene after another", () => {
  it("takes the scene before's background and motion, its title inked to match", () => {
    const dark = { ...makeStageScene({ startTime: 0, frameWidth: 1920, frameHeight: 1080 }), background: { kind: "color" as const, color: "#0b0d12" }, spring: "bouncy" as const };
    const next = makeStageScene({ startTime: 3, frameWidth: 1920, frameHeight: 1080, like: dark });
    expect(next.background).toEqual(dark.background);
    expect(next.spring).toBe("bouncy");
    expect(next.elements.find((e) => e.kind === "text")!.props.color).toBe("#f5f5f4");
  });
});

describe("duplicating and naming", () => {
  it("copies an element with its beat changes, offset, and numbers its name", () => {
    let s = makeStageScene({ startTime: 0, frameWidth: 1920, frameHeight: 1080 });
    s = addElement(s, 0, { ...makeShapeElement({ x: 100, y: 200 }), id: "n1", name: "Neuron 1" });
    s = addBeat(s, 0).scene;
    s = setElementProps(s, 1, "n1", { color: "#ff0000", x: 300 });
    const { scene, id } = duplicateElement(s, "n1", 30);
    const copy = scene.elements.find((e) => e.id === id)!;
    expect(copy.name).toBe("Neuron 2");
    expect([copy.props.x, copy.props.y]).toEqual([130, 230]);
    expect(elementInBeat(scene, 1, id)!.color).toBe("#ff0000");
    expect(elementInBeat(scene, 1, id)!.x).toBe(330);
    expect(scene.elements.findIndex((e) => e.id === id)).toBe(scene.elements.findIndex((e) => e.id === "n1") + 1);
    expect(renameElement(scene, id, "Output").elements.find((e) => e.id === id)!.name).toBe("Output");
  });
});
