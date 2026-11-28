// utils/stage/stageEditing.ts
//
// Edits to a Stage scene, as pure functions from one scene to the next - what the editor's canvas,
// panel and timeline call, and undo snapshots. The rule they keep: a beat records only what changes
// in it. Editing an element "in beat b" changes how it looks from b on, until a later beat changes
// that same property itself; a value set back to what the element already looks like there stops
// being a change at all. Removing a beat folds its changes into the beat after, so every later beat
// still looks exactly as it did.
import { parseStageColor } from "./stageColor";
import { defaultGraph } from "./stageGraph";
import type { ShapeForm } from "./stageShapes";
import { resolvedBeats } from "./stageEngine";
import { StageBackground, StageBeat, StageBeatSound, StageCamera, StageElement, StageProps, StageScene, STAGE_HEIGHT, defaultStageProps } from "./stageTypes";

// True when a scene background is light enough to take dark ink (supports solid & gradient).
export function isLightStageBackground(bg: StageBackground): boolean {
  if (bg.kind === "none") return false;
  const lum = (css: string) => {
    const rgb = parseStageColor(css);
    return rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 : 0;
  };
  if (bg.kind === "color") return lum(bg.color) > 0.55;
  return (lum(bg.from) + lum(bg.to)) * 0.5 > 0.55;
}

export const MIN_BEAT_HOLD = 0.1;
export const MAX_BEAT_HOLD = 600;
const DEFAULT_HOLD = 2;
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `id${Math.random().toString(36).slice(2)}`);

// The stage's width in stage units for a frame of this aspect (height is always 1080).
export const stageWidthFor = (frameWidth: number, frameHeight: number) => (frameHeight > 0 ? Math.round((STAGE_HEIGHT * frameWidth * 1000) / frameHeight) / 1000 : 1920);

// A new scene: a light stage, one centred title in a centring stack, one beat.
// A new scene; `like` (the scene before it) lends it its background, motion and depth - and its title
// takes the matching ink - so a run of scenes reads as one piece.
export function makeStageScene(opts: { startTime: number; frameWidth: number; frameHeight: number; like?: StageScene }): StageScene {
  const width = stageWidthFor(opts.frameWidth, opts.frameHeight);
  const centre: StageElement = {
    id: newId(),
    kind: "stack",
    name: "Centre",
    stack: { direction: "column", gap: 12, justify: "center", align: "center" },
    props: defaultStageProps({ x: 0, y: 0, width, height: STAGE_HEIGHT }),
  };
  const title = makeTextElement(width, { text: "Your title", fontSize: 72, fontFamily: "inter-semibold", parent: centre.id });
  const fresh: StageScene = {
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
  const like = opts.like;
  if (!like) return fresh;
  const inherited: StageScene = { ...fresh, background: like.background, spring: like.spring, stagger: like.stagger, wordStagger: like.wordStagger, perspective: like.perspective, beatSound: like.beatSound };
  return isLightStageBackground(fresh.background) === isLightStageBackground(inherited.background)
    ? inherited
    : reinkScene(inherited, !isLightStageBackground(inherited.background));
}

// The scene a new one at `t` follows: the latest that starts at or before it.
export function sceneBefore(scenes: StageScene[] | undefined, t: number): StageScene | undefined {
  let best: StageScene | undefined;
  for (const sc of scenes ?? []) if (sc.startTime <= t + 1e-6 && (!best || sc.startTime > best.startTime)) best = sc;
  return best;
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

export function makeShapeElement(opts: { x: number; y: number; width?: number; height?: number; color?: string; radius?: number; form?: ShapeForm; sides?: number; inner?: number; sweep?: number }): StageElement {
  const form = opts.form && opts.form !== "rect" ? { form: opts.form, ...(opts.sides ? { sides: opts.sides } : {}), ...(opts.inner !== undefined ? { inner: opts.inner } : {}), ...(opts.sweep !== undefined && opts.sweep < 360 ? { sweep: opts.sweep } : {}) } : {};
  return {
    id: newId(),
    kind: "shape",
    shape: { radius: opts.radius ?? 12 },
    props: defaultStageProps({ x: opts.x, y: opts.y, width: opts.width ?? 240, height: opts.height ?? 140, color: opts.color ?? "#3b82f6", ...form }),
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
// A copy of an element - its look, motion, loops, rules and every beat's changes - placed `offset`
// stage units down and right (in every beat it moves in), just above the original, named after it.
// Returns the scene and the copy's id. A line's copy keeps its ends and style (pick its new end after);
// groups aren't copied this way.
export function duplicateElement(s: StageScene, id: string, offset = 24): { scene: StageScene; id: string } {
  const i = s.elements.findIndex((e) => e.id === id);
  const e = s.elements[i];
  if (!e || e.kind === "stack") return { scene: s, id };
  if (e.kind === "connector") offset = 0;
  const copyId = newId();
  const inGroup = !!e.parent && s.elements.find((x) => x.id === e.parent)?.kind === "stack";
  const shift = (p: Partial<StageProps>): Partial<StageProps> => (inGroup ? p : { ...p, ...(p.x !== undefined ? { x: p.x + offset } : {}), ...(p.y !== undefined ? { y: p.y + offset } : {}) });
  const base = (e.name ?? "").replace(/\s+\d+$/, "");
  const taken = new Set(s.elements.map((x) => x.name));
  let name: string | undefined;
  if (base) for (let n = 2; !name; n++) if (!taken.has(`${base} ${n}`)) name = `${base} ${n}`;
  const copy: StageElement = { ...structuredClone(e), id: copyId, name, props: shift(e.props) as StageProps };
  const elements = [...s.elements.slice(0, i + 1), copy, ...s.elements.slice(i + 1)];
  const beats = s.beats.map((b) => (b.changes[id] ? { ...b, changes: { ...b.changes, [copyId]: shift(structuredClone(b.changes[id])) } } : b));
  return { scene: { ...s, elements, beats }, id: copyId };
}

export function renameElement(s: StageScene, id: string, name: string): StageScene {
  return { ...s, elements: s.elements.map((e) => (e.id === id ? { ...e, name: name.trim() || undefined } : e)) };
}

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

// An equation (TeX), its box fitted once it's typeset (StageMathPanel).
// The inks chosen for a light background and their partners on a dark one. When a scene's
// background flips between light and dark, whatever still wears the old automatic ink - text,
// equations, shapes, a graph's axes and first curve - takes the new one, so nothing vanishes.
export const AUTO_INKS: [light: string, dark: string][] = [
  ["#111111", "#f5f5f4"],
  ["#2563eb", "#58c4dd"],
];

export function reinkScene(s: StageScene, toDark: boolean): StageScene {
  // By colour, not by spelling: #111111, rgb(17,17,17) and rgba(17, 17, 17, 1) are the same ink.
  const key = (c: string) => {
    const p = parseStageColor(c);
    return p && p[3] > 0.99 ? `${p[0]},${p[1]},${p[2]}` : null;
  };
  const map = new Map(AUTO_INKS.map(([l, d]) => (toDark ? [key(l), d] : [key(d), l])));
  const swap = (c: string | undefined) => {
    const k = c ? key(c) : null;
    return (k && map.get(k)) ?? c;
  };
  const props = (p: Partial<StageProps>): Partial<StageProps> => {
    let out = p;
    if (p.color !== undefined && swap(p.color) !== p.color) out = { ...out, color: swap(p.color) };
    if (p.graph) {
      const series = p.graph.series.map((x) => (swap(x.color) !== x.color ? { ...x, color: swap(x.color)! } : x));
      if (series.some((x, i) => x !== p.graph!.series[i])) out = { ...out, graph: { ...p.graph, series } };
    }
    return out;
  };
  return {
    ...s,
    elements: s.elements.map((e) => ({ ...e, props: props(e.props) as StageProps })),
    beats: s.beats.map((b) => ({ ...b, changes: Object.fromEntries(Object.entries(b.changes).map(([id, c]) => [id, props(c)])) })),
  };
}

// A graph: axes and a first curve that draw themselves on, slowly enough to follow.
export function makeGraphElement(opts: { x: number; y: number; width?: number; height?: number; color?: string; curve?: string }): StageElement {
  const graph = defaultGraph();
  if (opts.curve) graph.series[0].color = opts.curve;
  return {
    id: newId(),
    kind: "graph",
    spring: "slow",
    enter: { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0, opacity: 1 },
    props: defaultStageProps({ x: opts.x, y: opts.y, width: opts.width ?? 1000, height: opts.height ?? 620, color: opts.color ?? "#111111", graph }),
  };
}

export function makeMathElement(opts: { x: number; y: number; tex?: string; size?: number; color?: string }): StageElement {
  return {
    id: newId(),
    kind: "math",
    textLook: { fontSize: opts.size ?? 72 },
    props: defaultStageProps({ x: opts.x, y: opts.y, width: 480, height: 140, text: opts.tex ?? "y = mx + b", color: opts.color ?? "#111111" }),
  };
}

export const NEUTRAL_CAMERA: Required<StageCamera> = { zoom: 1, panX: 0, panY: 0, tilt: 0 };

// Resolved virtual camera in beat `b`: inherits from earlier beats until a beat overrides it.
export function resolvedBeatCamera(s: StageScene, b: number): Required<StageCamera> {
  const cur: Required<StageCamera> = { ...NEUTRAL_CAMERA };
  const last = Math.max(0, Math.min(b, s.beats.length - 1));
  for (let i = 0; i <= last; i++) {
    const cam = s.beats[i]?.camera;
    if (!cam) continue;
    if (cam.zoom !== undefined) cur.zoom = cam.zoom;
    if (cam.panX !== undefined) cur.panX = cam.panX;
    if (cam.panY !== undefined) cur.panY = cam.panY;
    if (cam.tilt !== undefined) cur.tilt = cam.tilt;
  }
  return cur;
}

const clampNum = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

// Updates beat `b`'s virtual camera (`null` resets this beat back to neutral framing).
export function setBeatCamera(s: StageScene, b: number, patch: Partial<StageCamera> | null): StageScene {
  if (b < 0 || b >= s.beats.length) return s;
  const prev = b > 0 ? resolvedBeatCamera(s, b - 1) : NEUTRAL_CAMERA;
  const base = patch === null ? NEUTRAL_CAMERA : { ...resolvedBeatCamera(s, b), ...patch };
  const next: Required<StageCamera> = {
    zoom: Math.round(clampNum(base.zoom, 0.4, 4) * 100) / 100,
    panX: Math.round(clampNum(base.panX, -3000, 3000)),
    panY: Math.round(clampNum(base.panY, -2000, 2000)),
    tilt: Math.round(clampNum(base.tilt, -25, 25) * 10) / 10,
  };
  const sameAsPrev =
    Math.abs(next.zoom - prev.zoom) < 1e-4 &&
    Math.abs(next.panX - prev.panX) < 1e-4 &&
    Math.abs(next.panY - prev.panY) < 1e-4 &&
    Math.abs(next.tilt - prev.tilt) < 1e-4;
  return {
    ...s,
    beats: s.beats.map((bt, i) => {
      if (i !== b) return bt;
      if (sameAsPrev) {
        const { camera: _drop, ...rest } = bt;
        return rest;
      }
      return { ...bt, camera: next };
    }),
  };
}

// Computes camera framing that smoothly zooms & pans to spotlight `rect` with clean breathing room.
export function frameElementCamera(
  scene: StageScene,
  rect: { x: number; y: number; width: number; height: number },
  padding = 1.45
): Required<StageCamera> {
  const safeW = Math.max(40, rect.width);
  const safeH = Math.max(40, rect.height);
  const zoom = clampNum(Math.min(scene.width / (safeW * padding), STAGE_HEIGHT / (safeH * padding)), 1.05, 2.8);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return {
    zoom: Math.round(zoom * 100) / 100,
    panX: Math.round(cx - scene.width / 2),
    panY: Math.round(cy - STAGE_HEIGHT / 2),
    tilt: 0,
  };
}

export function setBeatSound(s: StageScene, b: number, sound: StageBeatSound | undefined): StageScene {
  if (b < 0 || b >= s.beats.length) return s;
  return {
    ...s,
    beats: s.beats.map((bt, i) => {
      if (i !== b) return bt;
      if (sound === undefined) {
        const { sound: _drop, ...rest } = bt;
        return rest;
      }
      return { ...bt, sound };
    }),
  };
}

// Fits a free element proportionally inside the stage with uniform breathing margin and centres it.
export function fitElementToStage(s: StageScene, b: number, id: string, margin = 72): StageScene {
  const el = s.elements.find((e) => e.id === id);
  const p = elementInBeat(s, b, id);
  if (!el || !p || el.kind === "connector") return s;
  const availW = Math.max(64, s.width - margin * 2);
  const availH = Math.max(64, STAGE_HEIGHT - margin * 2);
  const ratio = Math.min(availW / Math.max(1, p.width), availH / Math.max(1, p.height));
  const width = Math.max(8, Math.round(p.width * ratio));
  const height = Math.max(8, Math.round(p.height * ratio));
  return setElementProps(s, b, id, {
    x: Math.round((s.width - width) / 2),
    y: Math.round((STAGE_HEIGHT - height) / 2),
    width,
    height,
  });
}

// Evenly spaces all visible free (non-stacked, non-connector) elements in beat `b` along `axis`.
export function distributeElements(s: StageScene, b: number, axis: "x" | "y"): StageScene {
  const free = s.elements
    .filter((e) => !e.parent && e.kind !== "stack" && e.kind !== "connector")
    .map((e) => ({ id: e.id, p: elementInBeat(s, b, e.id) }))
    .filter((item): item is { id: string; p: StageProps } => !!item.p && item.p.visible);
  if (free.length < 3) return s;
  const posKey = axis;
  const sizeKey = axis === "x" ? "width" : "height";
  const sorted = [...free].sort((a, c) => a.p[posKey] - c.p[posKey]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last.p[posKey] + last.p[sizeKey] - first.p[posKey];
  const totalSize = sorted.reduce((sum, item) => sum + item.p[sizeKey], 0);
  const gap = (span - totalSize) / (sorted.length - 1);
  let cursor = first.p[posKey] + first.p[sizeKey] + gap;
  let out = s;
  for (let i = 1; i < sorted.length - 1; i++) {
    const item = sorted[i];
    out = setElementProps(out, b, item.id, { [posKey]: Math.round(cursor) } as Partial<StageProps>);
    cursor += item.p[sizeKey] + gap;
  }
  return out;
}
