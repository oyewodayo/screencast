// utils/stage/stageEngine.ts
//
// Turns a scene's beats into motion. compileStage works out, once per edit, every moment an element
// is sent somewhere new (a retarget: its beat starting, plus its place in the stagger) and exactly
// where it is and how fast it's moving at that moment; sampleStage then gives any instant with one
// closed-form spring per property (springs.ts) - a frame costs the same at the scene's end as at its
// start, and scrubbing backwards, playing and exporting all see the same numbers.
//
// Each beat's state is laid out first (stageLayout.ts) - hugging text, stacks closing up round a
// hidden line - so the springs carry every element to where the layout put it.
//
// Rules the motion follows:
// - A beat arriving while an element is still moving retargets it from where it is, keeping its
//   velocity - motion carries on, it never snaps or restarts from rest.
// - Position, size, scale and rotation use the beat's spring (overshoot included); opacity, blur
//   and colour never overshoot (a bounce there reads as a flicker).
// - An element that appears comes in from its enter style (offset, blurred, transparent); one that
//   is hidden leaves where it is, fading and blurring out. One that reappears after being fully
//   hidden starts its entrance fresh at its new place rather than sliding over from where it left.
// - Anchor and an unparseable colour switch the moment the element's move begins (an element
//   leaving keeps what it showed).
// - A text whose wording changes morphs letter by letter (stageTextMorph.ts): words it keeps glide
//   to their new places, new words arrive one after another (the scene's word stagger), dropped
//   words fade out where they were. Each letter follows the same rules as an element.
import { SPRING_PRESETS, SpringCoeffs, SpringParams, SpringState, springCoeffs, springInto, springSettleTime, withoutOvershoot } from "./springs";
import { toOklab, oklabToRgb, rgbCss, Oklab } from "./stageColor";
import { MeasureCache, MeasuredText, StageMeasure, layoutBeat, measureCached } from "./stageLayout";
import { assignGlyphIds, graphemeOffsets, graphemes } from "./stageTextMorph";
import { GraphState, graphMoving } from "./stageGraph";
import { ShapeForm, formDefaults } from "./stageShapes";
import { StageChannel, channelCrossings, channelMoving, channelValue, fillTemplate, hasTemplate } from "./stageChannels";
import { CONNECTOR_ENTER, CONNECTOR_EXIT, DEFAULT_ENTER, DEFAULT_EXIT, DOTS_ENTER, StageBindableProp, StageCondition, StageElement, StagePath, StageProps, StageScene, StageTextReveal, StageTransitionStyle, StageWipe } from "./stageTypes";
import { loopsAt } from "./stageLoops";

// The springing channels, in this order.
const X = 0, Y = 1, W = 2, H = 3, SCALE = 4, ROT = 5, OPACITY = 6, BLUR = 7, L = 8, A = 9, B = 10, ALPHA = 11, DRAW = 12, RX = 13, RY = 14, Z = 15, RAD = 16, INNER = 17, SWEEP = 18;
const CHANNELS = 19;
// A state across the channels. Plain arrays, not Float64Arrays: V8 stores them as packed doubles just
// as fast to read, and allocating thousands of tiny typed arrays while compiling was the slow part.
type Vec = number[];
const zeros = (): Vec => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
// Geometric channels may overshoot (position, size, scale, rotation, tilt, depth, a shape's corners,
// inner ratio and sweep); the rest never do.
const GEOMETRIC_END = OPACITY;
const geometric = (c: number) => c < GEOMETRIC_END || c >= RX;
// Below these a channel counts as at rest (position/velocity) - well under a pixel or a step of 8-bit colour.
const REST = [0.02, 0.02, 0.02, 0.02, 1e-4, 0.01, 1 / 1024, 0.02, 1e-4, 1e-4, 1e-4, 1 / 1024, 1 / 1024, 0.01, 0.01, 0.02, 0.02, 1e-4, 0.01];
// An element fainter than this is fully gone - drawn as nothing, and re-entered fresh.
const GONE = 0.02;
// A new word's letters: from a little below, blurred, by these fractions of the font size.
const GLYPH_ENTER_DY = 0.18;
const GLYPH_BLUR = 0.35;
const DEFAULT_WORD_STAGGER = 0.06;

interface Discrete {
  text?: string;
  weightRuns?: StageProps["weightRuns"];
  // A morphing letter's weight.
  weight?: number;
  // The width the text wraps at (stage units).
  wrapWidth?: number;
  colorRuns?: StageProps["colorRuns"];
  anchorX: number;
  anchorY: number;
  // The colour as given when it can't be animated (not a hex/rgb() colour).
  rawColor?: string;
  hasColor: boolean;
  graph?: GraphState;
  form?: ShapeForm;
  sides?: number;
}

interface Segment {
  t: number;
  from: Vec;
  vel: Vec;
  target: Vec;
  spring: SpringParams;
  smooth: SpringParams;
  discrete: Discrete;
  // When the change this move belongs to began (a letter's word may start later, in its stagger).
  group: number;
  // Worked out once at compile time so a frame only evaluates what's moving: the two springs'
  // constants, the channels not already at rest, when every channel has come to rest (after which
  // the target is the answer), and the target colour as a string.
  geo: SpringCoeffs;
  soft: SpringCoeffs;
  active: number[];
  settleAt: number;
  // The target colour - worked out on first use (null until then).
  targetColor: ColorOut | null;
  // An equation rewritten while showing: what it was, and when the rewrite is done (stageMath).
  morphFrom?: string;
  morphUntil?: number;
  // A graph's state changed: what it was. And when its current state began (descents run from it).
  morphGraph?: GraphState;
  graphSince?: number;
  // A shape's form changed: the form it was (with its sides).
  morphShape?: { form: ShapeForm; sides?: number };
  // Moving along a bent route into this beat.
  path?: StagePath;
  // Its move is a leaving (hidden in this beat).
  leaving?: boolean;
}

interface Track {
  // The state before its first move (fully transparent).
  initial: Vec;
  initialDiscrete: Discrete;
  initialColor: ColorOut;
  segments: Segment[];
  // Outside [liveFrom, liveUntil) it draws nothing and nothing about it changes: before its first
  // move it waits transparent; after a final exit has settled it's gone for good.
  liveFrom: number;
  liveUntil: number;
}

interface GlyphTrack extends Track {
  text: string;
}

interface ElementTrack extends Track {
  element: StageElement;
  // The side a wipe sweeps toward, arriving and leaving.
  enterWipe?: StageWipe;
  exitWipe?: StageWipe;
  // Letter by letter, when its wording changes from beat to beat.
  glyphs: GlyphTrack[] | null;
  // Its text shows a channel's value somewhere.
  live: boolean;
}

export interface CompiledStage {
  scene: StageScene;
  duration: number;
  beatStarts: number[];
  tracks: ElementTrack[];
  channels: Map<string, StageChannel>;
}

// A letter of a morphing text, in its element's box.
export interface SampledGlyph {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  blur: number;
  color?: string;
  // The same colour as straight sRGB 0-1, for the renderer (no string to parse).
  rgba?: [number, number, number, number];
  weight?: number;
}

export interface SampledElement {
  id: string;
  kind: StageElement["kind"];
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  scale: number;
  rotation: number;
  opacity: number;
  blur: number;
  // How much of a connector is drawn, or a dot-revealed picture revealed (0..1).
  draw: number;
  rotateX: number;
  rotateY: number;
  z: number;
  color?: string;
  rgba?: [number, number, number, number];
  text?: string;
  colorRuns?: StageProps["colorRuns"];
  weightRuns?: StageProps["weightRuns"];
  // The width the text wraps at (its box may be springing to a new size meanwhile).
  wrapWidth?: number;
  // Set when the text is morphing: draw these letters instead of `text`.
  glyphs?: SampledGlyph[];
  // An equation mid-rewrite: the TeX it's coming from and how far along (0..1).
  morphFrom?: string;
  morph?: number;
  // A graph: its state, the state it's morphing from (with `morph`), and seconds this state has shown.
  graph?: GraphState;
  morphGraph?: GraphState;
  graphSince?: number;
  // A shape (or picture mask): its form and settings now, and the form it's morphing from (with
  // `morph`).
  form?: ShapeForm;
  sides?: number;
  radius?: number;
  inner?: number;
  sweep?: number;
  morphShape?: { form: ShapeForm; sides?: number };
  // Being wiped on or off (with `draw` how far): the side the edge sweeps toward.
  wipe?: StageWipe;
  // The text shows a channel's value (it changes as the scene plays); `template` is what was typed.
  live?: boolean;
  template?: string;
  // Still on its way somewhere - a frame later will differ.
  moving: boolean;
}

// Arriving or leaving with no movement of its own (opacity aside).
const STILL: StageTransitionStyle = { dx: 0, dy: 0, scale: 1, blur: 0 };

const sanitizeHold = (h: number) => (Number.isFinite(h) && h > 0 ? h : 0);
const sanitizeStagger = (s: number | undefined) => (s !== undefined && Number.isFinite(s) && s > 0 ? s : 0);

// An element's full state in each beat: its own props with every beat's changes up to it applied.
export function resolvedBeats(scene: StageScene, element: StageElement): StageProps[] {
  const out: StageProps[] = [];
  let cur: StageProps = { ...element.props };
  for (const beat of scene.beats) {
    const change = beat.changes[element.id];
    if (change) cur = { ...cur, ...change };
    out.push(cur);
  }
  return out;
}

function toVector(p: Pick<StageProps, "x" | "y" | "width" | "height" | "scale" | "rotation" | "opacity" | "blur" | "draw" | "rotateX" | "rotateY" | "z" | "radius" | "inner" | "sweep">, lab: Oklab): Vec {
  const v = zeros();
  v[X] = p.x;
  v[Y] = p.y;
  v[W] = p.width;
  v[H] = p.height;
  v[SCALE] = p.scale;
  v[ROT] = p.rotation;
  v[OPACITY] = p.opacity;
  v[BLUR] = p.blur;
  v[L] = lab[0];
  v[A] = lab[1];
  v[B] = lab[2];
  v[ALPHA] = lab[3];
  v[DRAW] = p.draw ?? 1;
  v[RX] = p.rotateX ?? 0;
  v[RY] = p.rotateY ?? 0;
  v[Z] = p.z ?? 0;
  v[RAD] = p.radius ?? 0;
  v[INNER] = p.inner ?? 0;
  v[SWEEP] = p.sweep ?? 360;
  return v;
}

// A shape's corners, inner ratio and sweep as they spring: given in the beat, or the element's own
// corners and its form's defaults - so changing form springs them to the new form's.
function withShapeDefaults(element: StageElement, p: StageProps): StageProps {
  if (element.kind !== "shape" && element.kind !== "image") return p;
  const d = formDefaults(p.form ?? "rect");
  return { ...p, radius: p.radius ?? element.shape?.radius ?? 0, inner: p.inner ?? d.inner, sweep: p.sweep ?? d.sweep, sides: p.sides ?? (d.sides || undefined) };
}

// `shown` moved by an enter/exit style and faded to nothing.
function transitioned(shown: Vec, style: StageTransitionStyle): Vec {
  const v = shown.slice();
  v[X] += style.dx;
  v[Y] += style.dy;
  v[SCALE] *= style.scale;
  v[BLUR] += style.blur;
  if (style.draw !== undefined) v[DRAW] = style.draw;
  if (style.rotate) v[ROT] += style.rotate;
  if (style.rotateX) v[RX] += style.rotateX;
  if (style.rotateY) v[RY] += style.rotateY;
  v[OPACITY] = style.opacity ?? 0;
  return v;
}

const sameDiscrete = (a: Discrete, b: Discrete) => a.graph === b.graph && a.form === b.form && a.sides === b.sides && a.text === b.text && a.weight === b.weight && a.weightRuns === b.weightRuns && a.wrapWidth === b.wrapWidth && a.colorRuns === b.colorRuns && a.anchorX === b.anchorX && a.anchorY === b.anchorY && a.rawColor === b.rawColor && a.hasColor === b.hasColor;
const sameVector = (a: Vec, b: Vec) => a.every((v, i) => v === b[i]);
const sameProps = (a: StageProps, b: StageProps) =>
  (Object.keys(a) as (keyof StageProps)[]).every((k) => a[k] === b[k]) && (Object.keys(b) as (keyof StageProps)[]).every((k) => a[k] === b[k]);

const springOut: SpringState = { x: 0, v: 0 };

// Position and velocity of every channel at `t` (fresh arrays - compile keeps them).
function stateAt(seg: Segment, t: number): { x: Vec; v: Vec } {
  const x = seg.target.slice();
  const v = zeros();
  if (t >= seg.settleAt) return { x, v };
  const dt = t - seg.t;
  for (const c of seg.active) {
    springInto(geometric(c) ? seg.geo : seg.soft, seg.from[c], seg.vel[c], seg.target[c], dt, springOut);
    x[c] = springOut.x;
    v[c] = springOut.v;
  }
  return { x, v };
}

// A move's constants (see Segment): which channels move at all, and a moment by which all of them
// are within REST of their target in both position and speed - bounded from above, never early.
function prepareMove(t: number, from: Vec, vel: Vec, target: Vec, spring: SpringParams) {
  const smooth = withoutOvershoot(spring);
  const geo = springCoeffs(spring);
  const soft = springCoeffs(smooth);
  const active: number[] = [];
  let settle = 0;
  for (let c = 0; c < CHANNELS; c++) {
    const d = Math.abs(from[c] - target[c]);
    const v = Math.abs(vel[c]);
    if (d === 0 && v === 0) continue;
    active.push(c);
    const params = geometric(c) ? spring : smooth;
    const w = geometric(c) ? geo.w : soft.w;
    // Speed is about w times the remaining swing, so the swing must shrink below REST/w as well.
    settle = Math.max(settle, springSettleTime(params, d + v / w, REST[c] * Math.min(1, 1 / w)));
  }
  return { smooth, geo, soft, active, settleAt: t + settle };
}

// One beat's goal for a track: where it should be (null = hidden there) and when its move starts.
interface Goal {
  t: number;
  shown: { vector: Vec; discrete: Discrete } | null;
  spring: SpringParams;
  // See Segment.group - defaults to `t`.
  group?: number;
  path?: StagePath;
}

// Springs a track through its goals, in time order, applying the rules at the top of this file.
// How long an equation takes to rewrite itself into the next (3Blue1Brown's own default).
export const MATH_MORPH_SECONDS = 1;
// A graph's change of view or function - a touch longer, a camera move.
export const GRAPH_MORPH_SECONDS = 1.2;
// A shape changing form - quick, like a spring settling.
export const SHAPE_MORPH_SECONDS = 0.7;

function buildTrack(initial: Vec, initialDiscrete: Discrete, goals: Goal[], enter: StageTransitionStyle, exit: StageTransitionStyle, morphText = false, morphGraph = false, morphShape = false): Track {
  const segments: Segment[] = [];
  let state = { x: initial, v: zeros() };
  let lastShown: Vec | null = null;
  let lastDiscrete = initialDiscrete;
  for (const goal of goals) {
    const prev = segments[segments.length - 1];
    // Sent where it's already going, with nothing else changing: no new move.
    if (prev && goal.shown && prev.t !== goal.t && sameVector(prev.target, goal.shown.vector) && sameDiscrete(prev.discrete, goal.shown.discrete) && prev.target[OPACITY] > 0) {
      lastShown = goal.shown.vector;
      lastDiscrete = goal.shown.discrete;
      continue;
    }
    if (prev) state = stateAt(prev, goal.t);
    let target: Vec;
    let discrete: Discrete;
    if (goal.shown) {
      target = goal.shown.vector;
      discrete = goal.shown.discrete;
      // Fully gone: start the entrance fresh where it's going, at rest.
      if (state.x[OPACITY] < GONE) state = { x: transitioned(target, enter), v: zeros() };
      lastShown = target;
      lastDiscrete = discrete;
    } else {
      // Leaving: fade out where it was last shown, keeping what it showed.
      target = transitioned(lastShown ?? state.x, exit);
      discrete = lastDiscrete;
    }
    const move = prepareMove(goal.t, state.x, state.v, target, goal.spring);
    const seg: Segment = { t: goal.t, from: state.x, vel: state.v, target, spring: goal.spring, discrete, group: goal.group ?? goal.t, ...move, targetColor: null };
    if (!goal.shown) seg.leaving = true;
    // A bent route only for a move between two shown places.
    else if (goal.path && goal.path.bend && state.x[OPACITY] >= GONE) seg.path = goal.path;
    // An equation already showing that's rewritten: it morphs from what it was over a fixed time.
    if (morphText && goal.shown && prev && state.x[OPACITY] >= GONE && prev.discrete.text !== discrete.text) {
      seg.morphFrom = prev.discrete.text;
      seg.morphUntil = goal.t + MATH_MORPH_SECONDS;
      seg.settleAt = Math.max(seg.settleAt, seg.morphUntil);
    }
    if (morphGraph) {
      const changed = !prev || prev.discrete.graph !== discrete.graph;
      seg.graphSince = changed ? goal.t : prev!.graphSince;
      if (changed && goal.shown && prev && state.x[OPACITY] >= GONE && prev.discrete.graph && discrete.graph) {
        seg.morphGraph = prev.discrete.graph;
        seg.morphUntil = goal.t + GRAPH_MORPH_SECONDS;
        seg.settleAt = Math.max(seg.settleAt, seg.morphUntil);
      }
    }
    // A shape showing that changes form (or number of sides) flows from the old outline into the new.
    if (morphShape && goal.shown && prev && state.x[OPACITY] >= GONE && ((prev.discrete.form ?? "rect") !== (discrete.form ?? "rect") || prev.discrete.sides !== discrete.sides)) {
      seg.morphShape = { form: prev.discrete.form ?? "rect", sides: prev.discrete.sides };
      seg.morphUntil = goal.t + SHAPE_MORPH_SECONDS;
      seg.settleAt = Math.max(seg.settleAt, seg.morphUntil);
    }
    // Two moves at the same moment (a zero-length beat): the later one wins.
    if (prev && prev.t === goal.t) segments[segments.length - 1] = seg;
    else if (!(prev && sameVector(prev.target, target) && sameDiscrete(prev.discrete, discrete))) segments.push(seg);
  }
  const last = segments[segments.length - 1];
  return {
    initial,
    initialDiscrete,
    initialColor: colorFromVector(initial, initialDiscrete),
    segments,
    liveFrom: initial[OPACITY] > 0 ? -Infinity : (segments[0]?.t ?? Infinity),
    liveUntil: last && last.target[OPACITY] === 0 ? last.settleAt : Infinity,
  };
}

const discreteOf = (p: StageProps, wrapWidth?: number): Discrete => {
  const parsed = toOklab(p.color);
  return { text: p.text, wrapWidth, colorRuns: p.colorRuns, weightRuns: p.weightRuns, anchorX: p.anchorX, anchorY: p.anchorY, rawColor: parsed || p.color === undefined ? undefined : p.color, hasColor: p.color !== undefined, graph: p.graph, form: p.form, sides: p.sides };
};

export function compileStage(scene: StageScene, measure?: StageMeasure): CompiledStage {
  const beats = scene.beats.length > 0 ? scene.beats : [{ id: "beat", hold: 0, changes: {} }];
  const sceneWithBeats = beats === scene.beats ? scene : { ...scene, beats };
  const beatStarts: number[] = [];
  let at = 0;
  for (const beat of beats) {
    beatStarts.push(at);
    at += sanitizeHold(beat.hold);
  }
  const duration = at;
  const cache: MeasureCache = new Map();
  const channels = new Map((scene.channels ?? []).map((c) => [c.id, c]));

  const raw = scene.elements.map((e) => resolvedBeats(sceneWithBeats, e));
  // laid[ei][b]: element ei in beat b, sized and placed.
  const perBeat = beats.map((_, b) => layoutBeat(scene.elements, raw.map((r) => r[b]), measure, cache, (text) => hasTemplate(text, channels)));
  const laid = scene.elements.map((_, ei) => perBeat.map((beatProps) => beatProps[ei]));

  const changedIn = (ei: number, b: number): boolean => {
    const cur = laid[ei][b];
    if (b === 0) return cur.visible;
    const prev = laid[ei][b - 1];
    if (!cur.visible && !prev.visible) return false;
    return !sameProps(cur, prev);
  };
  // Each element's place in each beat's stagger: its rank among the elements that move in that beat.
  const rank: number[][] = beats.map((_, b) => {
    let n = 0;
    return scene.elements.map((_e, ei) => (changedIn(ei, b) ? n++ : -1));
  });
  const springOf = (b: number, element: StageElement) => SPRING_PRESETS[beats[b].spring ?? element.spring ?? scene.spring] ?? SPRING_PRESETS.smooth;
  const moveStart = (ei: number, b: number) => beatStarts[b] + sanitizeStagger(beats[b].stagger ?? scene.stagger) * Math.max(0, rank[b][ei]);

  const tracks: ElementTrack[] = scene.elements.map((element, ei) => {
    const connector = element.kind === "connector";
    // A picture revealed by dots arrives whole, undrawn - the dots are its entrance.
    const dots = element.kind === "image" && element.image?.reveal === "dots";
    // A text revealed letter by letter arrives (and leaves) in place - its letters do the moving.
    const reveal = element.kind === "text" ? element.textReveal : undefined;
    const enter = reveal ? { ...STILL } : { ...(connector ? CONNECTOR_ENTER : dots ? DOTS_ENTER : DEFAULT_ENTER), ...element.enter };
    const exit = reveal?.exit ? { ...STILL } : { ...(connector ? CONNECTOR_EXIT : DEFAULT_EXIT), ...element.exit };
    let lab: Oklab = toOklab(element.props.color) ?? [0, 0, 0, 1];
    const firstShown = withShapeDefaults(element, withConditions(laid[ei].find((p) => p.visible) ?? laid[ei][0], element.when, channels, 0));
    // Moves: each beat it changes in (at its place in the stagger), and each moment a channel
    // crosses one of its thresholds.
    const events: { t: number; b: number; beat?: boolean }[] = [];
    for (let b = 0; b < beats.length; b++) if (changedIn(ei, b)) events.push({ t: moveStart(ei, b), b, beat: true });
    for (const t of conditionCrossings(element.when, channels, duration)) events.push({ t, b: beatAtTime(beatStarts, t) });
    events.sort((a, b) => a.t - b.t);
    // Text wraps where the layout wrapped it: a hugging text at its own width cap, a fixed box at its width.
    const wrapAt = (b: number) => (element.fit === "hug" ? raw[ei][b].width : laid[ei][b].width);
    const goals: Goal[] = [];
    let prevProps: StageProps | null = null;
    for (const ev of events) {
      // Just after the moment - a crossing's own side.
      const p = withShapeDefaults(element, withConditions(laid[ei][ev.b], element.when, channels, ev.t + 1e-6));
      if (prevProps && sameProps(p, prevProps)) continue;
      prevProps = p;
      lab = toOklab(p.color) ?? lab;
      goals.push({ t: ev.t, shown: p.visible ? { vector: toVector(p, lab), discrete: discreteOf(p, wrapAt(ev.b)) } : null, spring: springOf(ev.b, element), path: ev.beat ? beats[ev.b].paths?.[element.id] : undefined });
    }
    const firstBeat = Math.max(0, laid[ei].findIndex((p) => p.visible));
    const track = buildTrack(transitioned(toVector(firstShown, toOklab(firstShown.color) ?? lab), enter), discreteOf(firstShown, wrapAt(firstBeat)), goals, enter, exit, element.kind === "math", element.kind === "graph", element.kind === "shape" || element.kind === "image");
    // A text showing a live value changes every frame - drawn whole, never morphed.
    const live = laid[ei].some((p) => hasTemplate(p.text, channels));
    const glyphs = element.kind === "text" && measure && !live ? glyphTracks(scene, element, laid[ei], wrapAt, (b) => (changedIn(ei, b) ? moveStart(ei, b) : null), (b) => springOf(b, element), measure, cache) : null;
    return { ...track, element, glyphs, live, enterWipe: element.enter?.wipe, exitWipe: element.exit?.wipe };
  });

  return { scene: sceneWithBeats, duration, beatStarts, tracks, channels };
}

const beatAtTime = (beatStarts: number[], t: number) => {
  let b = 0;
  while (b + 1 < beatStarts.length && beatStarts[b + 1] <= t) b++;
  return b;
};

function conditionActive(c: StageCondition, channels: Map<string, StageChannel>, t: number): boolean {
  const ch = channels.get(c.channel);
  if (!ch) return false;
  const v = channelValue(ch, t);
  return (c.below === undefined || v < c.below) && (c.atOrAbove === undefined || v >= c.atOrAbove);
}

// `p` with the changes of every condition holding at `t`, in order.
function withConditions(p: StageProps, when: StageCondition[] | undefined, channels: Map<string, StageChannel>, t: number): StageProps {
  if (!when || when.length === 0) return p;
  let out = p;
  for (const c of when) if (conditionActive(c, channels, t)) out = { ...out, ...c.changes };
  return out;
}

function conditionCrossings(when: StageCondition[] | undefined, channels: Map<string, StageChannel>, duration: number): number[] {
  const out: number[] = [];
  for (const c of when ?? []) {
    const ch = channels.get(c.channel);
    if (!ch) continue;
    for (const threshold of [c.below, c.atOrAbove]) if (threshold !== undefined) out.push(...channelCrossings(ch, threshold, 0, duration));
  }
  return out;
}

// A text's letters as tracks of their own - when its wording differs between the beats it's shown
// in, or when it's revealed letter by letter, word by word or line by line (otherwise it's drawn
// whole).
function glyphTracks(
  scene: StageScene,
  element: StageElement,
  laid: StageProps[],
  wrapAt: (b: number) => number,
  moveStart: (b: number) => number | null,
  springOf: (b: number) => SpringParams,
  measure: StageMeasure,
  cache: MeasureCache
): GlyphTrack[] | null {
  const reveal = element.textReveal;
  const shownBeats = laid.map((p, b) => ({ p, b })).filter(({ p }) => p.visible);
  if (shownBeats.length === 0) return null;
  // Wording or part-colours changing need letters of their own; a whole-text colour change doesn't.
  const looks = new Set(shownBeats.map(({ p }) => `${p.text ?? ""}\u0000${JSON.stringify(p.colorRuns ?? null)}\u0000${JSON.stringify(p.weightRuns ?? null)}`));
  if (looks.size < 2 && !reveal) return null;
  // Hidden in some beat between two: it comes back in afresh.
  const hiddenBetween = (a: number, b: number) => laid.slice(a + 1, b).some((p) => !p.visible);
  // The texts in order, one per beat where the wording changes (or where it returns after hiding).
  const steps: { b: number; p: StageProps; text: string; m: MeasuredText; returning: boolean }[] = [];
  for (const { p, b } of shownBeats) {
    const text = p.text ?? "";
    const prev = steps[steps.length - 1];
    const returning = !!reveal && !!prev && hiddenBetween(prev.b, b);
    if (prev && !returning && prev.text === text && prev.p.width === p.width && prev.p.colorRuns === p.colorRuns && prev.p.weightRuns === p.weightRuns && prev.p.color === p.color) continue;
    steps.push({ b, p, text, m: measureCached(measure, cache, element, text, wrapAt(b), p.weightRuns), returning });
  }
  const { ids, fresh, tokens } = assignGlyphIds(steps.map((s) => s.text));
  const fontSize = element.textLook?.fontSize ?? 40;
  const enter: StageTransitionStyle = reveal ? revealStyle(reveal, fontSize) : { dx: 0, dy: GLYPH_ENTER_DY * fontSize, scale: 1, blur: GLYPH_BLUR * fontSize };
  const exit: StageTransitionStyle = reveal?.exit ? revealStyle(reveal, fontSize) : { dx: 0, dy: 0, scale: 1, blur: GLYPH_BLUR * fontSize };
  const wordStagger = sanitizeStagger(scene.wordStagger ?? DEFAULT_WORD_STAGGER);
  const unitStagger = reveal ? Math.max(0, reveal.stagger ?? REVEAL_STAGGER[reveal.by]) : 0;
  // A typewriter's letters snap on.
  const revealSpring = reveal?.style === "type" ? SPRING_PRESETS.snappy : null;

  // Each grapheme's place in the reveal order: its letter, word or line.
  const unitIndex = (k: number): Map<number, number> => {
    const out = new Map<number, number>();
    const gs = graphemes(steps[k].text);
    const lines = [...new Set(steps[k].m.glyphs.map((b) => (b ? Math.round(b.y) : 0)))].sort((a, b) => a - b);
    let letter = 0;
    tokens[k].forEach((tok, j) => {
      for (let g = tok.start; g < tok.end; g++) {
        const box = steps[k].m.glyphs[g];
        const idx = !reveal ? 0 : reveal.by === "word" ? j : reveal.by === "line" ? lines.indexOf(box ? Math.round(box.y) : 0) : letter;
        out.set(g, idx);
        if (gs[g].trim()) letter++;
      }
    });
    return out;
  };

  // Every glyph id, with its goal in each step.
  const goalsById = new Map<string, { text: string; goals: Goal[] }>();
  steps.forEach((step, k) => {
    const start = moveStart(step.b) ?? 0;
    const gs = graphemes(step.text);
    const offsets = graphemeOffsets(gs);
    const present = new Set<string>();
    // Revealed: the first wording, and a return after hiding, arrive unit by unit. Otherwise the
    // new words of a changed wording arrive one after another.
    const revealing = !!reveal && (k === 0 || step.returning);
    const units = revealing ? unitIndex(k) : null;
    let freshRank = 0;
    const freshDelay = new Map<number, number>();
    tokens[k].forEach((_tok, j) => {
      if (fresh[k][j] && k > 0 && !revealing) freshDelay.set(j, wordStagger * freshRank++);
    });
    const spring = revealSpring ?? springOf(step.b);
    tokens[k].forEach((tok, j) => {
      for (let g = tok.start; g < tok.end; g++) {
        const id = ids[k][g]!;
        present.add(id);
        const box = step.m.glyphs[g];
        if (!box) continue;
        const run = step.p.colorRuns?.find((r) => offsets[g] >= r.start && offsets[g] < r.end);
        const lab = toOklab(run?.color ?? step.p.color) ?? [0, 0, 0, 1];
        const vector = toVector({ x: box.x, y: box.y, width: box.width, height: box.height, scale: 1, rotation: 0, opacity: 1, blur: 0 }, lab);
        const entry = goalsById.get(id) ?? { text: gs[g], goals: [] };
        const delay = units ? (units.get(g) ?? 0) * unitStagger : freshDelay.get(j) ?? 0;
        entry.goals.push({ t: start + delay, shown: { vector, discrete: { anchorX: 0.5, anchorY: 0.5, hasColor: true, weight: box.weight } }, spring, group: start });
        goalsById.set(id, entry);
      }
    });
    // Letters of words this wording dropped leave now.
    for (const [id, entry] of goalsById) {
      if (!present.has(id) && entry.goals[entry.goals.length - 1].shown) entry.goals.push({ t: start, shown: null, spring, group: start });
    }
    // Hidden after this wording (before the next step): leaving unit by unit when it's to, else at once.
    const nextB = steps[k + 1]?.b ?? laid.length;
    const hideAt = laid.findIndex((p, b) => b > step.b && b < nextB && !p.visible);
    if (reveal && hideAt >= 0) {
      const h = moveStart(hideAt) ?? 0;
      const order = reveal?.exit ? unitIndex(k) : null;
      tokens[k].forEach((tok) => {
        for (let g = tok.start; g < tok.end; g++) {
          const entry = goalsById.get(ids[k][g]!);
          if (!entry || !entry.goals[entry.goals.length - 1].shown) continue;
          entry.goals.push({ t: h + (order ? (order.get(g) ?? 0) * unitStagger : 0), shown: null, spring: revealSpring ?? springOf(hideAt), group: h });
        }
      });
    }
  });

  return Array.from(goalsById.entries(), ([id, { text, goals }]) => {
    const first = goals.find((g) => g.shown)!.shown!;
    // A letter of the first wording is there from the start - its element's own entrance brings it
    // in. Revealed, every letter makes its own entrance.
    const fromStart = id.startsWith("0:") && !reveal;
    const initial = fromStart ? first.vector.slice() : transitioned(first.vector, enter);
    return { text, ...buildTrack(initial, first.discrete, fromStart ? goals.slice(1) : goals, enter, exit) };
  });
}

// Seconds between units of a reveal, by default.
const REVEAL_STAGGER: Record<StageTextReveal["by"], number> = { letter: 0.035, word: 0.09, line: 0.18 };

// Where a revealed unit comes from (or goes), for its style - in proportion to the type.
function revealStyle(r: StageTextReveal, fontSize: number): StageTransitionStyle {
  switch (r.style) {
    case "rise":
      return { dx: 0, dy: 0.45 * fontSize, scale: 1, blur: 0.2 * fontSize };
    case "drop":
      return { dx: 0, dy: -0.45 * fontSize, scale: 1, blur: 0.2 * fontSize };
    case "slide":
      return { dx: 0.6 * fontSize, dy: 0, scale: 1, blur: 0.15 * fontSize };
    case "pop":
      return { dx: 0, dy: 0, scale: 0.2, blur: 0 };
    case "zoom":
      return { dx: 0, dy: 0, scale: 2.2, blur: 0.35 * fontSize };
    case "blur":
      return { dx: 0, dy: 0, scale: 1, blur: 0.6 * fontSize };
    case "type":
    case "fade":
    default:
      return { dx: 0, dy: 0, scale: 1, blur: 0 };
  }
}

// The beat whose time `t` falls in.
export function stageBeatAt(c: CompiledStage, t: number): number {
  return beatAtTime(c.beatStarts, t);
}

// The last segment that has begun by `t`, or -1 before the first.
function segmentIndexAt(segments: Segment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// One sample's working buffer - read straight into the SampledElement before the next sample.
const scratch = zeros();

// A colour as the engine hands it out: CSS for anyone reading it, numbers for the renderer.
type ColorOut = { css: string; rgba: [number, number, number, number] | undefined } | undefined;

interface TrackSample {
  x: Vec;
  discrete: Discrete;
  moving: boolean;
  color: ColorOut;
  // Mid-rewrite (an equation): the text it's coming from, and how far along (0..1).
  morphFrom?: string;
  morph?: number;
  morphGraph?: GraphState;
  graphSince?: number;
  morphShape?: { form: ShapeForm; sides?: number };
  leaving?: boolean;
  // The opacity the current move began at and is going to.
  fromOpacity?: number;
  toOpacity?: number;
}

function trackAt(track: Track, t: number): TrackSample {
  const i = segmentIndexAt(track.segments, t);
  if (i < 0) return { x: track.initial, discrete: track.initialDiscrete, moving: false, color: track.initialColor };
  const seg = track.segments[i];
  // Settled: the target, with nothing to evaluate.
  if (t >= seg.settleAt)
    return { x: seg.target, discrete: seg.discrete, moving: false, color: targetColorOf(seg), leaving: seg.leaving, fromOpacity: seg.from[OPACITY], toOpacity: seg.target[OPACITY], ...(seg.graphSince !== undefined ? { graphSince: seg.graphSince } : {}) };
  for (let c = 0; c < CHANNELS; c++) scratch[c] = seg.target[c];
  const dt = t - seg.t;
  let moving = false;
  let colorMoving = false;
  for (const c of seg.active) {
    springInto(geometric(c) ? seg.geo : seg.soft, seg.from[c], seg.vel[c], seg.target[c], dt, springOut);
    scratch[c] = springOut.x;
    if (Math.abs(springOut.x - seg.target[c]) > REST[c] || Math.abs(springOut.v) > REST[c]) {
      moving = true;
      if (c >= L && c <= ALPHA) colorMoving = true;
    }
  }
  const morphing = seg.morphUntil !== undefined && t < seg.morphUntil;
  if (seg.path && moving) bendAlong(seg, scratch);
  return {
    leaving: seg.leaving,
    fromOpacity: seg.from[OPACITY],
    toOpacity: seg.target[OPACITY],
    x: scratch,
    discrete: seg.discrete,
    moving: moving || morphing,
    color: colorMoving ? colorFromVector(scratch, seg.discrete) : targetColorOf(seg),
    ...(morphing && seg.morphGraph
      ? { morphGraph: seg.morphGraph, morph: (t - seg.t) / GRAPH_MORPH_SECONDS }
      : morphing && seg.morphShape
        ? { morphShape: seg.morphShape, morph: (t - seg.t) / SHAPE_MORPH_SECONDS }
        : morphing
          ? { morphFrom: seg.morphFrom, morph: (t - seg.t) / MATH_MORPH_SECONDS }
          : {}),
    ...(seg.graphSince !== undefined ? { graphSince: seg.graphSince } : {}),
  };
}

// A move along a bent route: how far along the straight line it has come (its springs' progress,
// overshoot included) lifts it sideways on a parabola peaking at `bend` of the distance halfway;
// with `orient` it turns to face along the curve (level again where it lands).
function bendAlong(seg: Segment, x: Vec): void {
  const ax = seg.from[X], ay = seg.from[Y];
  const vx = seg.target[X] - ax, vy = seg.target[Y] - ay;
  const len = Math.hypot(vx, vy);
  if (len < 1 || !seg.path) return;
  const u = Math.max(0, Math.min(1, ((x[X] - ax) * vx + (x[Y] - ay) * vy) / (len * len)));
  const lift = seg.path.bend * len * 4 * u * (1 - u);
  // Sideways: to the left of the direction of travel (y down), so a positive bend arcs upward on a
  // left-to-right move.
  x[X] += (vy / len) * lift;
  x[Y] += (-vx / len) * lift;
  // Tilted into the curve, relative to the straight line (degrees clockwise).
  if (seg.path.orient) x[ROT] += (Math.atan(-seg.path.bend * 4 * (1 - 2 * u)) * 180) / Math.PI;
}

function targetColorOf(seg: Segment): ColorOut {
  if (seg.targetColor === null) seg.targetColor = colorFromVector(seg.target, seg.discrete);
  return seg.targetColor;
}

function colorFromVector(x: Vec, d: Discrete): ColorOut {
  if (d.rawColor) return { css: d.rawColor, rgba: undefined };
  if (!d.hasColor) return undefined;
  const c = oklabToRgb([x[L], x[A], x[B], x[ALPHA]]);
  return { css: rgbCss(c), rgba: [c[0] / 255, c[1] / 255, c[2] / 255, c[3]] };
}
const clampOpacity = (v: number) => Math.max(0, Math.min(1, v));

function sample(track: ElementTrack, t: number, channels: Map<string, StageChannel>, beatStarts: number[], duration: number): SampledElement {
  const { x, discrete, moving, color, morphFrom, morph, morphGraph, graphSince, morphShape, leaving, fromOpacity, toOpacity } = trackAt(track, t);
  const e = track.element;
  const out: SampledElement = {
    id: e.id,
    kind: e.kind,
    x: x[X],
    y: x[Y],
    width: Math.max(0, x[W]),
    height: Math.max(0, x[H]),
    anchorX: discrete.anchorX,
    anchorY: discrete.anchorY,
    scale: Math.max(0, x[SCALE]),
    rotation: x[ROT],
    opacity: clampOpacity(x[OPACITY]),
    blur: Math.max(0, x[BLUR]),
    draw: Math.max(0, Math.min(1, x[DRAW])),
    rotateX: x[RX],
    rotateY: x[RY],
    z: x[Z],
    color: color?.css,
    rgba: color?.rgba,
    text: discrete.text,
    colorRuns: discrete.colorRuns,
    weightRuns: discrete.weightRuns,
    wrapWidth: discrete.wrapWidth,
    moving,
    ...(morphFrom !== undefined ? { morphFrom, morph } : {}),
    ...(e.kind === "shape" || e.kind === "image"
      ? { form: discrete.form ?? "rect", sides: discrete.sides, radius: Math.max(0, x[RAD]), inner: x[INNER], sweep: x[SWEEP], ...(morphShape ? { morphShape, morph } : {}) }
      : {}),
    ...(discrete.graph ? { graph: discrete.graph, graphSince: t - (graphSince ?? 0), ...(morphGraph ? { morphGraph, morph } : {}) } : {}),
  };
  const wipe = leaving ? track.exitWipe : track.enterWipe;
  if (wipe && out.draw < 1) out.wipe = wipe;
  // A graph animating by itself: curves reading t or running values, a descent still rolling.
  if (out.graph && !out.moving && graphMoving(out.graph, channels, t, out.graphSince ?? 0)) out.moving = true;
  // Live values: bound properties follow their channels exactly; text shows theirs.
  for (const prop of Object.keys(e.bind ?? {}) as StageBindableProp[]) {
    const binding = e.bind![prop];
    const ch = binding && channels.get(binding.channel);
    if (!binding || !ch) continue;
    const [f0, f1] = binding.from;
    let u = f1 === f0 ? 0 : (channelValue(ch, t) - f0) / (f1 - f0);
    if (!binding.extrapolate) u = Math.max(0, Math.min(1, u));
    const v = binding.to[0] + (binding.to[1] - binding.to[0]) * u;
    out[prop] = prop === "opacity" ? clampOpacity(v) : prop === "width" || prop === "height" || prop === "scale" || prop === "radius" ? Math.max(0, v) : v;
    if (channelMoving(ch, t)) out.moving = true;
  }
  // A marching dashed outline changes every frame.
  if (e.shape?.stroke?.dash?.flow) out.moving = true;
  // Loops it keeps doing by itself, on top of where its springs put it.
  if (e.loops?.length) {
    const { delta, active } = loopsAt(e.loops, t, beatStarts, duration);
    if (active) {
      out.x += delta.dx;
      out.y += delta.dy;
      out.scale *= delta.scale;
      out.opacity = clampOpacity(out.opacity * delta.opacity);
      out.rotation += delta.rotation;
      out.rotateY += delta.rotateY;
      out.moving = true;
    }
  }
  if (track.live && out.text && hasTemplate(out.text, channels)) {
    const source = out.text;
    out.text = fillTemplate(source, channels, t);
    out.live = true;
    out.template = source;
    if ([...channels.values()].some((c) => source.includes("{" + c.id) && channelMoving(c, t))) out.moving = true;
  }
  if (track.glyphs) {
    const glyphs: SampledGlyph[] = [];
    let glyphsMoving = false;
    for (const g of track.glyphs) {
      if (t >= g.liveUntil) continue;
      if (t < g.liveFrom) {
        // A word of a change already under way, still waiting for its turn in the stagger.
        if (g.segments[0].group <= t) glyphsMoving = true;
        continue;
      }
      const s = trackAt(g, t);
      const next = g.segments[segmentIndexAt(g.segments, t) + 1];
      glyphsMoving ||= s.moving || (next !== undefined && next.group <= t);
      const opacity = clampOpacity(s.x[OPACITY]);
      if (opacity < 1 / 512) continue;
      // A letter's scale (a pop, a zoom) about its own centre.
      const sc = Math.max(0, s.x[SCALE]);
      const gw = Math.max(0, s.x[W]);
      const gh = Math.max(0, s.x[H]);
      glyphs.push({ text: g.text, x: s.x[X] + (gw * (1 - sc)) / 2, y: s.x[Y] + (gh * (1 - sc)) / 2, width: gw * sc, height: gh * sc, opacity, blur: Math.max(0, s.x[BLUR]), color: s.color?.css, rgba: s.color?.rgba, weight: s.discrete.weight });
    }
    // Settled letters draw the same as the whole text - only a morph in progress needs them.
    const reveal = track.element.textReveal;
    if (glyphsMoving) {
      out.glyphs = glyphs;
      out.moving = true;
      // Revealed unit by unit: the element stands at its shown opacity and the letters fade.
      if (reveal && !leaving && toOpacity !== undefined) out.opacity = clampOpacity(toOpacity);
    }
    // Leaving letter by letter: only its letters are drawn, until the last has gone.
    if (reveal?.exit && leaving) {
      out.glyphs = glyphs;
      out.opacity = clampOpacity(fromOpacity ?? 1);
    }
  }
  return out;
}

// Every element as it is `t` seconds into the scene, bottom to top - stacks and fully transparent
// elements left out.
export function sampleStage(c: CompiledStage, t: number): SampledElement[] {
  const out: SampledElement[] = [];
  for (const track of c.tracks) {
    if (track.element.kind === "stack") continue;
    const s = sample(track, t, c.channels, c.beatStarts, c.duration);
    // Under one step of 8-bit alpha draws nothing.
    if (s.opacity >= 1 / 512) out.push(s);
  }
  return out;
}

// Whether anything is moving at `t`, or will start to before `until` - the preview redraws only then.
export function stageIsMoving(c: CompiledStage, t: number, until = t): boolean {
  for (const track of c.tracks) {
    const pending = (tr: Track) => {
      const i = segmentIndexAt(tr.segments, t);
      return i + 1 < tr.segments.length && tr.segments[i + 1].t <= until;
    };
    if (pending(track) || track.glyphs?.some(pending)) return true;
    if (sample(track, t, c.channels, c.beatStarts, c.duration).moving) return true;
  }
  return false;
}

// Every text an element will show at rest over the scene (wording, part-colours, wrap width) - what
// the renderer lays out and draws before playback, so a beat starting never waits on text.
export interface StageTextState {
  text: string;
  colorRuns?: StageProps["colorRuns"];
  weightRuns?: StageProps["weightRuns"];
  wrapWidth?: number;
  // The colour it settles in (what the rest of the text is drawn in beside its runs).
  color?: string;
}

export function stageTextStates(c: CompiledStage): Map<string, StageTextState[]> {
  const out = new Map<string, StageTextState[]>();
  for (const track of c.tracks) {
    if (track.element.kind !== "text" || track.live) continue;
    const seen = new Set<string>();
    const states: StageTextState[] = [];
    const all = [{ d: track.initialDiscrete, color: track.initialColor?.css }, ...track.segments.map((s) => ({ d: s.discrete, color: targetColorOf(s)?.css }))];
    for (const { d, color } of all) {
      if (!d.text) continue;
      // With part-colours the base colour is drawn in, so it tells states apart; one colour is tinted.
      const key = `${d.text}\u0000${d.wrapWidth}\u0000${JSON.stringify(d.colorRuns ?? null)}\u0000${JSON.stringify(d.weightRuns ?? null)}\u0000${d.colorRuns?.length ? color : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      states.push({ text: d.text, colorRuns: d.colorRuns, weightRuns: d.weightRuns, wrapWidth: d.wrapWidth, color });
    }
    out.set(track.element.id, states);
  }
  return out;
}

// Every grapheme each morphing text draws letter by letter (its glyph atlas, built before playback)
// and how many letters it can draw at once (its instance buffer, sized before playback too).
export function stageGlyphSets(c: CompiledStage): Map<string, { graphemes: Set<string>; count: number }> {
  const out = new Map<string, { graphemes: Set<string>; count: number }>();
  for (const track of c.tracks) {
    if (!track.glyphs) continue;
    // Each letter in every weight it takes.
    const cells = new Set<string>();
    for (const g of track.glyphs) for (const d of [g.initialDiscrete, ...g.segments.map((s) => s.discrete)]) cells.add(`${d.weight ?? ""}\u0000${g.text}`);
    out.set(track.element.id, { graphemes: cells, count: track.glyphs.length });
  }
  return out;
}
