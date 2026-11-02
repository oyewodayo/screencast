// utils/stage/stageValues.ts
//
// Editing a scene's values (channels: numbers keyframed against the scene's time - a clock, a
// battery level, a score) and what follows them: an element's property bound to a value, live text
// showing one, a change when one crosses a threshold. Also the editor's grouping (stacks that lay
// their elements out in a row or column) and arrival/departure styles. Every function takes a scene
// and returns the next one - never mutated - so each edit is one undo step.
import type { SpringPreset } from "./springs";
import { StageChannel, StageChannelKey, StageValueFormat, channelValue, formatValue } from "./stageChannels";
import { StageBindableProp, StageBinding, StageCondition, StageElement, StageLoop, StagePath, StageScene, StageStack, StageTextReveal, StageTransitionStyle, defaultStageProps } from "./stageTypes";

// Keys this close (seconds) are the same key - setting one there replaces it.
const SAME_KEY = 1 / 120;

const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "value";

const replaceChannel = (s: StageScene, id: string, edit: (c: StageChannel) => StageChannel): StageScene => ({
  ...s,
  channels: (s.channels ?? []).map((c) => (c.id === id ? edit(c) : c)),
});
const replaceElement = (s: StageScene, id: string, edit: (e: StageElement) => StageElement): StageScene => ({
  ...s,
  elements: s.elements.map((e) => (e.id === id ? edit(e) : e)),
});
const sortKeys = (keys: StageChannelKey[]) => [...keys].sort((a, b) => a.t - b.t);

// A new value named `name` (its id - what live text refers to - made from the name, kept unique),
// running from `from` at the scene's start to `to` at its end.
export function addChannel(s: StageScene, name: string, opts: { format?: StageValueFormat; from?: number; to?: number; duration: number }): { scene: StageScene; id: string } {
  const taken = new Set((s.channels ?? []).map((c) => c.id));
  const base = slug(name);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  const channel: StageChannel = {
    id,
    name: name.trim() || id,
    format: opts.format,
    keys: [
      { t: 0, value: opts.from ?? 0 },
      { t: Math.max(0.1, opts.duration), value: opts.to ?? 100 },
    ],
  };
  return { scene: { ...s, channels: [...(s.channels ?? []), channel] }, id };
}

// Renamed - and its id (what live text writes, {battery}) renamed to match, every binding, rule and
// piece of live text that refers to it rewritten, so the text box always reads in the value's name.
export function renameChannel(s: StageScene, id: string, name: string): { scene: StageScene; id: string } {
  const label = name.trim();
  if (!label) return { scene: s, id };
  const taken = new Set((s.channels ?? []).filter((c) => c.id !== id).map((c) => c.id));
  const base = slug(label);
  let next = base;
  for (let n = 2; taken.has(next); n++) next = `${base}-${n}`;
  const renamed = replaceChannel(s, id, (c) => ({ ...c, id: next, name: label }));
  if (next === id) return { scene: renamed, id };
  const token = new RegExp(`\\{${id.replace(/[-]/g, "\\-")}(?=[}:])`, "g");
  const retext = (t: string | undefined) => (t === undefined ? t : t.replace(token, `{${next}`));
  const scene: StageScene = {
    ...renamed,
    elements: renamed.elements.map((e) => ({
      ...e,
      props: { ...e.props, text: retext(e.props.text) },
      bind: e.bind ? Object.fromEntries(Object.entries(e.bind).map(([k, b]) => [k, b && b.channel === id ? { ...b, channel: next } : b])) : undefined,
      when: e.when?.map((w) => ({ ...w, channel: w.channel === id ? next : w.channel, changes: w.changes.text !== undefined ? { ...w.changes, text: retext(w.changes.text) } : w.changes })),
    })),
    beats: renamed.beats.map((b) => ({
      ...b,
      changes: Object.fromEntries(Object.entries(b.changes).map(([eid, ch]) => [eid, ch.text !== undefined ? { ...ch, text: retext(ch.text) } : ch])),
    })),
  };
  return { scene, id: next };
}
export const setChannelFormat = (s: StageScene, id: string, format: StageValueFormat | undefined) => replaceChannel(s, id, (c) => ({ ...c, format }));

// Removes the value and everything that followed it (bindings, conditions); live text naming it
// shows the name as typed again.
export function deleteChannel(s: StageScene, id: string): StageScene {
  return {
    ...s,
    channels: (s.channels ?? []).filter((c) => c.id !== id),
    elements: s.elements.map((e) => {
      if (!e.bind && !e.when) return e;
      const bind = e.bind ? Object.fromEntries(Object.entries(e.bind).filter(([, b]) => b?.channel !== id)) : undefined;
      const when = e.when?.filter((w) => w.channel !== id);
      return { ...e, bind: bind && Object.keys(bind).length ? bind : undefined, when: when?.length ? when : undefined };
    }),
  };
}

// The value set to `value` at scene time `t` - a key there replaced, else a new one.
export function setChannelKey(s: StageScene, id: string, t: number, value: number): StageScene {
  if (!Number.isFinite(t) || !Number.isFinite(value)) return s;
  return replaceChannel(s, id, (c) => {
    const at = c.keys.findIndex((k) => Math.abs(k.t - t) < SAME_KEY);
    const keys = at >= 0 ? c.keys.map((k, i) => (i === at ? { ...k, value } : k)) : [...c.keys, { t: Math.max(0, t), value }];
    return { ...c, keys: sortKeys(keys) };
  });
}

// Key `index` (in time order) moved to `t`, `value` - kept between its neighbours so keys never pass.
export function moveChannelKey(s: StageScene, id: string, index: number, t: number, value: number): StageScene {
  return replaceChannel(s, id, (c) => {
    const keys = sortKeys(c.keys);
    if (!keys[index]) return c;
    const lo = index > 0 ? keys[index - 1].t + SAME_KEY : 0;
    const hi = index < keys.length - 1 ? keys[index + 1].t - SAME_KEY : Infinity;
    keys[index] = { ...keys[index], t: Math.min(hi, Math.max(lo, t)), value: Number.isFinite(value) ? value : keys[index].value };
    return { ...c, keys };
  });
}

// A value always keeps one key.
export function deleteChannelKey(s: StageScene, id: string, index: number): StageScene {
  return replaceChannel(s, id, (c) => {
    const keys = sortKeys(c.keys);
    return keys.length <= 1 ? c : { ...c, keys: keys.filter((_, i) => i !== index) };
  });
}

export function setKeyEasing(s: StageScene, id: string, index: number, easing: StageChannelKey["easing"]): StageScene {
  return replaceChannel(s, id, (c) => ({ ...c, keys: sortKeys(c.keys).map((k, i) => (i === index ? { ...k, easing } : k)) }));
}

// What someone typed, as a value in this format: "11:30 PM" or "23:30" as minutes after midnight for
// clocks, "1:02:03" or "2:03" as seconds for durations, "46%" as 46; null when it isn't a value.
export function parseValue(text: string, format: StageValueFormat | undefined): number | null {
  const t = text.trim();
  if (!t) return null;
  if (format === "time" || format === "clock24") {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i.exec(t);
    if (m) {
      let h = Number(m[1]);
      const min = Number(m[2] ?? 0);
      if (min > 59) return null;
      if (m[3]) {
        if (h < 1 || h > 12) return null;
        const pm = /^p/i.test(m[3]);
        h = (h % 12) + (pm ? 12 : 0);
      } else if (h > 23) return null;
      return h * 60 + min;
    }
  }
  if (format === "duration" && t.includes(":")) {
    const parts = t.split(":").map(Number);
    if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
    return parts.reduce((sum, p) => sum * 60 + p, 0);
  }
  const n = Number(t.replace(/%$/, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// The value at `t` as its format shows it - what the editor displays beside a value.
export const displayValue = (c: StageChannel, t: number) => formatValue(channelValue(c, t), c.format);

// The live-text token for a value: what goes into a text element to show it.
// (It shows in the value's own format, so the token is just its name.)
export const valueToken = (c: StageChannel) => `{${c.id}}`;

// ---- What follows a value ------------------------------------------------------------------------

export function bindProperty(s: StageScene, elementId: string, prop: StageBindableProp, binding: StageBinding | null): StageScene {
  return replaceElement(s, elementId, (e) => {
    const bind = { ...e.bind };
    if (binding) bind[prop] = binding;
    else delete bind[prop];
    return { ...e, bind: Object.keys(bind).length ? bind : undefined };
  });
}

export function setConditions(s: StageScene, elementId: string, when: StageCondition[]): StageScene {
  return replaceElement(s, elementId, (e) => ({ ...e, when: when.length ? when : undefined }));
}

// ---- Groups --------------------------------------------------------------------------------------

// The element put in a group: an existing one, or a new column/row made where the element is. A new
// group hugs what's in it, so it's as big as its contents and grows as they arrive.
export function groupElement(s: StageScene, elementId: string, target: string | "new-column" | "new-row"): { scene: StageScene; groupId: string | null } {
  const element = s.elements.find((e) => e.id === elementId);
  if (!element || element.kind === "stack") return { scene: s, groupId: null };
  if (target !== "new-column" && target !== "new-row") {
    if (!s.elements.some((e) => e.id === target && e.kind === "stack")) return { scene: s, groupId: null };
    return { scene: replaceElement(s, elementId, (e) => ({ ...e, parent: target })), groupId: target };
  }
  const groupId = `group-${Math.random().toString(36).slice(2, 8)}`;
  const stack: StageStack = { direction: target === "new-row" ? "row" : "column", gap: 24, justify: "start", align: target === "new-row" ? "center" : "start" };
  const group: StageElement = {
    id: groupId,
    kind: "stack",
    fit: "hug",
    parent: element.parent,
    stack,
    props: defaultStageProps({ x: element.props.x, y: element.props.y, width: 0, height: 0 }),
  };
  const at = s.elements.findIndex((e) => e.id === elementId);
  const elements = [...s.elements];
  elements.splice(at, 0, group);
  return { scene: { ...s, elements: elements.map((e) => (e.id === elementId ? { ...e, parent: groupId } : e)) }, groupId };
}

// Out of its group, keeping its place on the stage: it takes the group's position, so it doesn't
// jump to the corner. A group left empty goes with it.
export function ungroupElement(s: StageScene, elementId: string, at?: { x: number; y: number }): StageScene {
  const element = s.elements.find((e) => e.id === elementId);
  const groupId = element?.parent;
  if (!element || !groupId) return s;
  const group = s.elements.find((e) => e.id === groupId);
  // Out of the group it stays where the group had placed it - its place only; its own size (a text's
  // wrap width), colour and the rest are kept as they were.
  let next = replaceElement(s, elementId, (e) => ({ ...e, parent: group?.parent, props: { ...e.props, ...(at ? { x: at.x, y: at.y } : {}) } }));
  if (!next.elements.some((e) => e.parent === groupId)) next = { ...next, elements: next.elements.filter((e) => e.id !== groupId) };
  return next;
}

export function setGroupLayout(s: StageScene, groupId: string, patch: Partial<StageStack>): StageScene {
  return replaceElement(s, groupId, (e) => (e.stack ? { ...e, stack: { ...e.stack, ...patch } } : e));
}

// One step earlier or later among its group's elements - the order the group lays them out in.
export function moveInGroup(s: StageScene, elementId: string, step: -1 | 1): StageScene {
  const element = s.elements.find((e) => e.id === elementId);
  if (!element) return s;
  const siblings = s.elements.map((e, i) => ({ e, i })).filter(({ e }) => e.parent === element.parent && e.kind !== "connector");
  const me = siblings.findIndex(({ e }) => e.id === elementId);
  const other = siblings[me + step];
  if (me < 0 || !other) return s;
  const elements = [...s.elements];
  [elements[siblings[me].i], elements[other.i]] = [elements[other.i], elements[siblings[me].i]];
  return { ...s, elements };
}

// ---- Arriving and leaving ------------------------------------------------------------------------

export type TransitionPreset =
  | "rise"
  | "fade"
  | "drop"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "pop"
  | "grow"
  | "settle"
  | "blur"
  | "focus"
  | "spin"
  | "swing"
  | "flip"
  | "flip-up"
  | "tilt"
  | "wipe-right"
  | "wipe-left"
  | "wipe-up"
  | "wipe-down"
  | "open"
  | "none"
  | "draw";
// How an element arrives (or leaves): where from, in what state. `group` sorts the picker; `wipes`
// need a box to mask (not lines or graphs), `graphOnly` is the graph's draw-on.
export const TRANSITION_PRESETS: { id: TransitionPreset; label: string; group: "Move" | "Scale" | "Turn" | "Wipe" | "Other"; style: Partial<StageTransitionStyle>; graphOnly?: boolean }[] = [
  { id: "rise", label: "Rise", group: "Move", style: { dx: 0, dy: 24, scale: 1, blur: 10 } },
  { id: "drop", label: "Drop", group: "Move", style: { dx: 0, dy: -24, scale: 1, blur: 10 } },
  { id: "slide-up", label: "Slide up", group: "Move", style: { dx: 0, dy: 180, scale: 1, blur: 0 } },
  { id: "slide-down", label: "Slide down", group: "Move", style: { dx: 0, dy: -180, scale: 1, blur: 0 } },
  { id: "slide-left", label: "From right", group: "Move", style: { dx: 80, dy: 0, scale: 1, blur: 6 } },
  { id: "slide-right", label: "From left", group: "Move", style: { dx: -80, dy: 0, scale: 1, blur: 6 } },
  { id: "fade", label: "Fade", group: "Other", style: { dx: 0, dy: 0, scale: 1, blur: 0 } },
  { id: "blur", label: "Blur", group: "Other", style: { dx: 0, dy: 0, scale: 1, blur: 18 } },
  { id: "focus", label: "Focus", group: "Scale", style: { dx: 0, dy: 0, scale: 1.12, blur: 26 } },
  { id: "pop", label: "Pop", group: "Scale", style: { dx: 0, dy: 0, scale: 0.85, blur: 4 } },
  { id: "grow", label: "Grow", group: "Scale", style: { dx: 0, dy: 0, scale: 0.25, blur: 2 } },
  { id: "settle", label: "Settle", group: "Scale", style: { dx: 0, dy: 0, scale: 1.6, blur: 12 } },
  { id: "spin", label: "Spin", group: "Turn", style: { dx: 0, dy: 0, scale: 0.4, blur: 0, rotate: -180 } },
  { id: "swing", label: "Swing", group: "Turn", style: { dx: 0, dy: 20, scale: 1, blur: 4, rotate: -14 } },
  { id: "flip", label: "Flip", group: "Turn", style: { dx: 0, dy: 0, scale: 1, blur: 0, rotateY: -90 } },
  { id: "flip-up", label: "Flip up", group: "Turn", style: { dx: 0, dy: 0, scale: 1, blur: 0, rotateX: 90 } },
  { id: "tilt", label: "Tilt in", group: "Turn", style: { dx: 0, dy: 60, scale: 1, blur: 6, rotateX: 40 } },
  { id: "wipe-right", label: "Wipe right", group: "Wipe", style: { dx: 0, dy: 0, scale: 1, blur: 0, opacity: 1, draw: 0, wipe: "right" } },
  { id: "wipe-left", label: "Wipe left", group: "Wipe", style: { dx: 0, dy: 0, scale: 1, blur: 0, opacity: 1, draw: 0, wipe: "left" } },
  { id: "wipe-up", label: "Wipe up", group: "Wipe", style: { dx: 0, dy: 0, scale: 1, blur: 0, opacity: 1, draw: 0, wipe: "up" } },
  { id: "wipe-down", label: "Wipe down", group: "Wipe", style: { dx: 0, dy: 0, scale: 1, blur: 0, opacity: 1, draw: 0, wipe: "down" } },
  { id: "open", label: "Open", group: "Wipe", style: { dx: 0, dy: 0, scale: 1, blur: 0, opacity: 1, draw: 0, wipe: "centre" } },
  { id: "none", label: "Cut", group: "Other", style: { dx: 0, dy: 0, scale: 1, blur: 0, opacity: 1 } },
  // Graphs only: axes, then curves left to right, then what's on them.
  { id: "draw", label: "Draws itself on", group: "Other", style: { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0, opacity: 1 }, graphOnly: true },
];

// The presets that suit an element: wipes need a box to mask; the draw-on is a graph's.
export const presetsFor = (kind: StageElement["kind"]) =>
  TRANSITION_PRESETS.filter((p) => (p.graphOnly ? kind === "graph" : p.group !== "Wipe" || (kind !== "graph" && kind !== "connector")));

export function setTransition(s: StageScene, elementId: string, which: "enter" | "exit", preset: TransitionPreset | null): StageScene {
  const style = preset ? TRANSITION_PRESETS.find((p) => p.id === preset)?.style : undefined;
  return replaceElement(s, elementId, (e) => ({ ...e, [which]: style ? { ...style } : undefined }));
}

// Which preset an element's style is (null: the default, or one set some other way).
export function transitionPresetOf(style: Partial<StageTransitionStyle> | undefined): TransitionPreset | null {
  if (!style) return null;
  const same = (a: Partial<StageTransitionStyle>) =>
    (a.dx ?? 0) === (style.dx ?? 0) &&
    (a.dy ?? 0) === (style.dy ?? 0) &&
    (a.scale ?? 1) === (style.scale ?? 1) &&
    (a.blur ?? 0) === (style.blur ?? 0) &&
    (a.opacity ?? 0) === (style.opacity ?? 0) &&
    (a.draw ?? 1) === (style.draw ?? 1) &&
    (a.rotate ?? 0) === (style.rotate ?? 0) &&
    (a.rotateX ?? 0) === (style.rotateX ?? 0) &&
    (a.rotateY ?? 0) === (style.rotateY ?? 0) &&
    a.wipe === style.wipe;
  return TRANSITION_PRESETS.find((p) => same(p.style))?.id ?? null;
}

// ---- Loops, paths and reveals -----------------------------------------------------------------------

export function setLoops(s: StageScene, elementId: string, loops: StageLoop[]): StageScene {
  return replaceElement(s, elementId, (e) => ({ ...e, loops: loops.length ? loops : undefined }));
}

export function setTextReveal(s: StageScene, elementId: string, reveal: StageTextReveal | undefined): StageScene {
  return replaceElement(s, elementId, (e) => ({ ...e, textReveal: reveal }));
}

// The route an element takes into beat `b` (null: straight).
export function setPath(s: StageScene, b: number, elementId: string, path: StagePath | null): StageScene {
  const beats = s.beats.map((beat, i) => {
    if (i !== b) return beat;
    const paths = { ...beat.paths };
    if (path && path.bend) paths[elementId] = path;
    else delete paths[elementId];
    return { ...beat, paths: Object.keys(paths).length ? paths : undefined };
  });
  return { ...s, beats };
}

export const setElementSpring = (s: StageScene, elementId: string, spring: SpringPreset | undefined) => replaceElement(s, elementId, (e) => ({ ...e, spring }));
