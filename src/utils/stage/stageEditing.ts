// utils/stage/stageEditing.ts
//
// Edits to a Stage scene, as pure functions from one scene to the next - what the editor's canvas,
// panel and timeline call, and undo snapshots. The rule they keep: a beat records only what changes
// in it. Editing an element "in beat b" changes how it looks from b on, until a later beat changes
// that same property itself; a value set back to what the element already looks like there stops
// being a change at all. Removing a beat folds its changes into the beat after, so every later beat
// still looks exactly as it did.
import { resolvedBeats } from "./stageEngine";
import { StageBeat, StageElement, StageProps, StageScene, STAGE_HEIGHT, defaultStageProps } from "./stageTypes";

export const MIN_BEAT_HOLD = 0.1;
export const MAX_BEAT_HOLD = 600;
const DEFAULT_HOLD = 2;
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `id${Math.random().toString(36).slice(2)}`);

// The stage's width in stage units for a frame of this aspect (height is always 1080).
export const stageWidthFor = (frameWidth: number, frameHeight: number) => (frameHeight > 0 ? Math.round((STAGE_HEIGHT * frameWidth * 1000) / frameHeight) / 1000 : 1920);

// A new scene: a light stage, one centred title in a centring stack, one beat.
export function makeStageScene(opts: { startTime: number; frameWidth: number; frameHeight: number }): StageScene {
  const width = stageWidthFor(opts.frameWidth, opts.frameHeight);
  const centre: StageElement = {
    id: newId(),
    kind: "stack",
    name: "Centre",
    stack: { direction: "column", gap: 12, justify: "center", align: "center" },
    props: defaultStageProps({ x: 0, y: 0, width, height: STAGE_HEIGHT }),
  };
  const title = makeTextElement(width, { text: "Your title", fontSize: 72, fontFamily: "inter-semibold", parent: centre.id });
  return {
    id: newId(),
    startTime: Math.max(0, opts.startTime),
    width,
    height: STAGE_HEIGHT,
    background: { kind: "color", color: "#f2f1ee" },
    elements: [centre, title],
    beats: [{ id: newId(), hold: 3, changes: {} }],
    spring: "smooth",
    stagger: 0.05,
    wordStagger: 0.06,
  };
}

export function makeTextElement(stageWidth: number, opts: { text?: string; fontSize?: number; fontFamily?: string; parent?: string; x?: number; y?: number; color?: string } = {}): StageElement {
  const fontSize = opts.fontSize ?? 44;
  return {
    id: newId(),
    kind: "text",
    fit: "hug",
    parent: opts.parent,
    textLook: { fontFamily: opts.fontFamily ?? "inter", fontSize, textAlign: "center" },
    props: defaultStageProps({ x: opts.x ?? stageWidth * 0.2, y: opts.y ?? STAGE_HEIGHT * 0.45, width: stageWidth * 0.6, height: fontSize * 1.3, text: opts.text ?? "Text", color: opts.color ?? "#111111" }),
  };
}

export function makeShapeElement(opts: { x: number; y: number; width?: number; height?: number; color?: string; radius?: number }): StageElement {
  return {
    id: newId(),
    kind: "shape",
    shape: { radius: opts.radius ?? 12 },
    props: defaultStageProps({ x: opts.x, y: opts.y, width: opts.width ?? 240, height: opts.height ?? 140, color: opts.color ?? "#3b82f6" }),
  };
}

const sanitizeHold = (h: number) => (Number.isFinite(h) && h > 0 ? h : 0);

export const sceneDuration = (s: StageScene): number => s.beats.reduce((sum, b) => sum + sanitizeHold(b.hold), 0);
export const sceneEnd = (s: StageScene): number => s.startTime + sceneDuration(s);

export function beatStarts(s: StageScene): number[] {
  const out: number[] = [];
  let at = 0;
  for (const b of s.beats) {
    out.push(at);
    at += sanitizeHold(b.hold);
  }
  return out;
}

// The beat whose stretch `local` (seconds into the scene) falls in.
export function beatIndexAt(s: StageScene, local: number): number {
  const starts = beatStarts(s);
  let b = 0;
  while (b + 1 < starts.length && starts[b + 1] <= local) b++;
  return b;
}

// Where to park the playhead to see beat `b` at rest - its moves are settled well within a second
// and a half, but never past the end of the beat itself.
export function beatRestTime(s: StageScene, b: number): number {
  const starts = beatStarts(s);
  const hold = sanitizeHold(s.beats[b]?.hold ?? 0);
  return s.startTime + (starts[b] ?? 0) + Math.max(0, Math.min(1.5, hold - 1 / 60));
}

// An element as it looks in beat `b` (before layout).
export function elementInBeat(s: StageScene, b: number, id: string): StageProps | null {
  const e = s.elements.find((x) => x.id === id);
  if (!e) return null;
  return resolvedBeats(s, e)[Math.max(0, Math.min(b, s.beats.length - 1))] ?? null;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

// `patch` applied to element `id` from beat `b` on (carried forward until a later beat sets the same
// property). In beat 0 it changes the element itself; later, a value equal to how the element
// already looks there is dropped rather than recorded.
export function setElementProps(s: StageScene, b: number, id: string, patch: Partial<StageProps>): StageScene {
  const element = s.elements.find((e) => e.id === id);
  if (!element || b < 0 || b >= s.beats.length) return s;
  if (b === 0) {
    const beat0 = s.beats[0].changes[id];
    const rest = beat0 ? Object.fromEntries(Object.entries(beat0).filter(([k]) => !(k in patch))) : undefined;
    return {
      ...s,
      elements: s.elements.map((e) => (e.id === id ? { ...e, props: { ...e.props, ...patch } } : e)),
      beats: beat0 ? s.beats.map((bt, i) => (i === 0 ? { ...bt, changes: withChange(bt.changes, id, rest!) } : bt)) : s.beats,
    };
  }
  const before = resolvedBeats(s, element)[b - 1];
  const own: Partial<StageProps> = { ...(s.beats[b].changes[id] ?? {}) };
  for (const [k, v] of Object.entries(patch) as [keyof StageProps, unknown][]) {
    if (same(before[k], v)) delete own[k];
    else (own as Record<string, unknown>)[k] = v;
  }
  return { ...s, beats: s.beats.map((bt, i) => (i === b ? { ...bt, changes: withChange(bt.changes, id, own) } : bt)) };
}

function withChange(changes: StageBeat["changes"], id: string, change: Partial<StageProps>): StageBeat["changes"] {
  const out = { ...changes };
  if (Object.keys(change).length > 0) out[id] = change;
  else delete out[id];
  return out;
}

// A new element arriving in beat `b` (hidden before it), placed last on top.
export function addElement(s: StageScene, b: number, element: StageElement): StageScene {
  const at = Math.max(0, Math.min(b, s.beats.length - 1));
  const shown = element.props.visible;
  const placed: StageElement = { ...element, props: { ...element.props, visible: at === 0 ? shown : false } };
  const next = { ...s, elements: [...s.elements, placed] };
  return at === 0 || !shown ? next : setElementProps(next, at, element.id, { visible: true });
}

// The element and everything it holds gone from the scene, with every beat's changes to them.
export function deleteElement(s: StageScene, id: string): StageScene {
  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of s.elements) if (e.parent && doomed.has(e.parent) && !doomed.has(e.id)) {
      doomed.add(e.id);
      grew = true;
    }
  }
  return {
    ...s,
    elements: s.elements.filter((e) => !doomed.has(e.id)),
    beats: s.beats.map((bt) => ({ ...bt, changes: Object.fromEntries(Object.entries(bt.changes).filter(([k]) => !doomed.has(k))) })),
  };
}

// A new beat right after `after`, looking exactly like it to begin with (it records no changes).
export function addBeat(s: StageScene, after: number, hold = DEFAULT_HOLD): { scene: StageScene; index: number } {
  const index = Math.max(0, Math.min(after, s.beats.length - 1)) + 1;
  const beats = [...s.beats];
  beats.splice(index, 0, { id: newId(), hold: clampHold(hold), changes: {} });
  return { scene: { ...s, beats }, index };
}

// Beat `b` removed. Its changes fold into the beat after (where that beat doesn't set the same
// thing), or into the elements themselves for the first beat - every later beat looks as before.
export function deleteBeat(s: StageScene, b: number): StageScene {
  if (s.beats.length <= 1 || b < 0 || b >= s.beats.length) return s;
  const gone = s.beats[b];
  if (b === 0) {
    return {
      ...s,
      elements: s.elements.map((e) => (gone.changes[e.id] ? { ...e, props: { ...e.props, ...gone.changes[e.id] } } : e)),
      beats: s.beats.slice(1),
    };
  }
  const beats = s.beats.filter((_, i) => i !== b);
  if (b < s.beats.length - 1) {
    const next = s.beats[b + 1];
    const merged: StageBeat["changes"] = { ...next.changes };
    for (const [id, change] of Object.entries(gone.changes)) merged[id] = { ...change, ...(next.changes[id] ?? {}) };
    beats[b] = { ...next, changes: merged };
  }
  return { ...s, beats };
}

const clampHold = (h: number) => Math.max(MIN_BEAT_HOLD, Math.min(MAX_BEAT_HOLD, Number.isFinite(h) ? h : DEFAULT_HOLD));

export function setBeatHold(s: StageScene, b: number, hold: number): StageScene {
  if (b < 0 || b >= s.beats.length) return s;
  return { ...s, beats: s.beats.map((bt, i) => (i === b ? { ...bt, hold: clampHold(hold) } : bt)) };
}

// The scene stretched or shortened to `duration` by its last beat's hold (never below the minimum).
export function setSceneDuration(s: StageScene, duration: number): StageScene {
  const last = s.beats.length - 1;
  const others = sceneDuration(s) - sanitizeHold(s.beats[last].hold);
  return setBeatHold(s, last, duration - others);
}

// A copy with fresh ids throughout (elements keep their stacking and parents; beats their changes).
export function duplicateScene(s: StageScene, startTime: number): StageScene {
  const ids = new Map(s.elements.map((e) => [e.id, newId()]));
  return {
    ...s,
    id: newId(),
    startTime,
    elements: s.elements.map((e) => ({ ...e, id: ids.get(e.id)!, parent: e.parent ? ids.get(e.parent) ?? e.parent : undefined })),
    beats: s.beats.map((bt) => ({ ...bt, id: newId(), changes: Object.fromEntries(Object.entries(bt.changes).map(([k, v]) => [ids.get(k) ?? k, v])) })),
  };
}

// An icon from the shared set, filling a square box.
export function makeIconElement(opts: { x: number; y: number; size?: number; name?: string; color?: string }): StageElement {
  const size = opts.size ?? 72;
  return { id: newId(), kind: "icon", icon: { name: opts.name ?? "star" }, props: defaultStageProps({ x: opts.x, y: opts.y, width: size, height: size, color: opts.color ?? "#111111" }) };
}

// A dotted line from one element to another - it draws itself on when it arrives and follows both.
export function makeConnectorElement(from: string, to: string, opts: { color?: string; style?: "solid" | "dots" | "dashes" } = {}): StageElement {
  return {
    id: newId(),
    kind: "connector",
    connector: { from, to, style: opts.style ?? "dots", thickness: 6, gap: 18, flow: 40 },
    props: defaultStageProps({ x: 0, y: 0, width: 0, height: 0, color: opts.color ?? "#3b82f6" }),
  };
}

// A picture at its own proportions, at most `longest` on its long side, centred on the stage.
export function makeImageElement(stageWidth: number, src: string, natural: { width: number; height: number }, longest = 720): StageElement {
  const k = longest / Math.max(natural.width, natural.height, 1);
  const width = Math.round(natural.width * k);
  const height = Math.round(natural.height * k);
  return {
    id: newId(),
    kind: "image",
    image: { src, fit: "cover" },
    shape: { radius: 24 },
    props: defaultStageProps({ x: Math.round(stageWidth / 2 - width / 2), y: Math.round(STAGE_HEIGHT / 2 - height / 2), width, height }),
  };
}
