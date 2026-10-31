import { describe, expect, it } from "vitest";
import { compileStage, sampleStage } from "./stageEngine";
import { addChannel, bindProperty, renameChannel, deleteChannel, deleteChannelKey, groupElement, moveChannelKey, moveInGroup, parseValue, setChannelKey, setConditions, setTransition, transitionPresetOf, ungroupElement, valueToken } from "./stageValues";
import { StageElement, StageScene, defaultStageProps } from "./stageTypes";
import { makeStageScene } from "./stageEditing";

const el = (id: string, props = {}): StageElement => ({ id, kind: "shape", props: defaultStageProps({ x: 100, y: 100, width: 200, height: 40, color: "#111111", ...props }) });
const scene = (elements: StageElement[]): StageScene => ({ id: "s", startTime: 0, width: 1920, height: 1080, background: { kind: "color", color: "#eeeeee" }, elements, beats: [{ id: "b", hold: 4, changes: {} }], spring: "smooth", stagger: 0 });

describe("values", () => {
  it("names a new value with a unique id and runs it across the scene", () => {
    const a = addChannel(scene([]), "Battery level", { duration: 4 });
    const b = addChannel(a.scene, "Battery level", { duration: 4 });
    expect(a.id).toBe("battery-level");
    expect(b.id).toBe("battery-level-2");
    expect(b.scene.channels![0].keys).toEqual([{ t: 0, value: 0 }, { t: 4, value: 100 }]);
  });

  it("sets a value at the playhead, replacing a key already there, keeping keys in order", () => {
    let { scene: s, id } = addChannel(scene([]), "v", { duration: 4 });
    s = setChannelKey(s, id, 2, 30);
    s = setChannelKey(s, id, 2.004, 40);
    expect(s.channels![0].keys.map((k) => [k.t, k.value])).toEqual([[0, 0], [2, 40], [4, 100]]);
  });

  it("never lets a dragged key pass its neighbours, and keeps at least one key", () => {
    let { scene: s, id } = addChannel(scene([]), "v", { duration: 4 });
    s = setChannelKey(s, id, 2, 50);
    s = moveChannelKey(s, id, 1, 10, 60);
    expect(s.channels![0].keys[1].t).toBeLessThan(4);
    expect(s.channels![0].keys[1].value).toBe(60);
    s = deleteChannelKey(deleteChannelKey(deleteChannelKey(s, id, 0), id, 0), id, 0);
    expect(s.channels![0].keys).toHaveLength(1);
  });

  it("reads typed values in the value's own format", () => {
    expect(parseValue("11:30 PM", "time")).toBe(23 * 60 + 30);
    expect(parseValue("12:05 am", "time")).toBe(5);
    expect(parseValue("23:30", "clock24")).toBe(23 * 60 + 30);
    expect(parseValue("1:02:03", "duration")).toBe(3723);
    expect(parseValue("46%", "pct")).toBe(46);
    expect(parseValue("1,250", undefined)).toBe(1250);
    expect(parseValue("13 PM", "time")).toBeNull();
    expect(parseValue("soon", undefined)).toBeNull();
  });

  it("drives a bar's width, live text and a colour change - the battery race, from the editor", () => {
    let { scene: s, id } = addChannel(scene([el("bar"), { ...el("pct"), kind: "text", props: defaultStageProps({ x: 0, y: 0, width: 200, text: "x" }) }]), "Battery", { duration: 4, from: 100, to: 0, format: "pct" });
    s = bindProperty(s, "bar", "width", { channel: id, from: [0, 100], to: [0, 800] });
    s = { ...s, elements: s.elements.map((e) => (e.id === "pct" ? { ...e, props: { ...e.props, text: valueToken(s.channels![0]) } } : e)) };
    s = setConditions(s, "bar", [{ channel: id, below: 20, changes: { color: "#ef4444" } }]);
    const c = compileStage(s);
    const at = (t: number, eid: string) => sampleStage(c, t).find((x) => x.id === eid)!;
    expect(at(2, "bar").width).toBeCloseTo(400, 0);
    expect(at(2, "pct").text).toBe("50%");
    expect(at(3.9, "bar").color).not.toBe("#111111");
  });

  it("renames a value's id with it, rewriting live text, bindings and rules", () => {
    let { scene: s, id } = addChannel(scene([el("bar"), { ...el("pct"), kind: "text", props: defaultStageProps({ text: "Level {value-1} now" }) }]), "Value 1", { duration: 4 });
    s = bindProperty(s, "bar", "width", { channel: id, from: [0, 100], to: [0, 800] });
    s = setConditions(s, "bar", [{ channel: id, below: 20, changes: { opacity: 0.5 } }]);
    const r = renameChannel(s, id, "Battery level");
    expect(r.id).toBe("battery-level");
    expect(r.scene.elements.find((e) => e.id === "pct")!.props.text).toBe("Level {battery-level} now");
    expect(r.scene.elements[0].bind!.width!.channel).toBe("battery-level");
    expect(r.scene.elements[0].when![0].channel).toBe("battery-level");
  });

  it("takes bindings and conditions with a deleted value", () => {
    let { scene: s, id } = addChannel(scene([el("bar")]), "v", { duration: 4 });
    s = bindProperty(s, "bar", "width", { channel: id, from: [0, 100], to: [0, 800] });
    s = setConditions(s, "bar", [{ channel: id, below: 20, changes: { opacity: 0.5 } }]);
    s = deleteChannel(s, id);
    expect(s.elements[0].bind).toBeUndefined();
    expect(s.elements[0].when).toBeUndefined();
  });
});

describe("groups and transitions", () => {
  it("makes a column where the element is, adds to it, reorders, and lets go", () => {
    let s = scene([el("a"), el("b", { x: 500 })]);
    const g = groupElement(s, "a", "new-column");
    s = groupElement(g.scene, "b", g.groupId!).scene;
    const group = s.elements.find((e) => e.id === g.groupId)!;
    expect(group.kind).toBe("stack");
    expect(group.props.x).toBe(100);
    expect(s.elements.filter((e) => e.parent === g.groupId).map((e) => e.id)).toEqual(["a", "b"]);
    s = moveInGroup(s, "b", -1);
    expect(s.elements.filter((e) => e.parent === g.groupId).map((e) => e.id)).toEqual(["b", "a"]);
    s = ungroupElement(ungroupElement(s, "a", { x: 10, y: 10 }), "b");
    expect(s.elements.some((e) => e.id === g.groupId)).toBe(false);
    expect(s.elements.find((e) => e.id === "a")!.props.x).toBe(10);
  });

  it("sets and recognises arrival styles", () => {
    const s = setTransition(scene([el("a")]), "a", "enter", "pop");
    expect(transitionPresetOf(s.elements[0].enter)).toBe("pop");
    expect(transitionPresetOf(setTransition(s, "a", "enter", null).elements[0].enter)).toBeNull();
  });
});

describe("leaving a group", () => {
  it("keeps only its place - not the live sample's colour or measured width", () => {
    const s = makeStageScene({ startTime: 0, frameWidth: 1920, frameHeight: 1080 });
    const title = s.elements.find((e) => e.kind === "text")!;
    const sampled = { ...title.props, x: 300, y: 420, width: 610, color: "rgba(17, 17, 17, 1)" };
    const out = ungroupElement(s, title.id, sampled);
    const t = out.elements.find((e) => e.id === title.id)!;
    expect(t.parent).toBeUndefined();
    expect([t.props.x, t.props.y]).toEqual([300, 420]);
    expect(t.props.width).toBe(title.props.width);
    expect(t.props.color).toBe(title.props.color);
  });
});
