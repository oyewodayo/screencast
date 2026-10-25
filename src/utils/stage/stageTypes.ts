// utils/stage/stageTypes.ts
//
// A Stage scene: elements on a stage, and beats - the states the scene moves through, Keynote
// Magic Move style. Each beat records only what changes in it; an element's state in beat b is its
// own base state with every change from beats 0..b applied in turn, so an edit made in one beat
// carries forward through the beats after it until one of them changes that property itself.
// The engine (stageEngine.ts) springs every element from beat to beat.
//
// Positions and sizes are in stage units: pixels of the frame at 1080 tall (a 16:9 stage is
// 1920 x 1080 units, a 9:16 one 607.5 x 1080), so layout gaps and type sizes keep their proportions
// at any export resolution. Times are seconds from the scene's own start.
import type { SpringPreset } from "./springs";
import type { StageChannel } from "./stageChannels";

// A stack draws nothing itself: it lays out the elements whose `parent` it is (stageLayout.ts). An
// icon is a line icon from the shared set (stickerIcons.ts) filling its box. A connector is a line
// between two other elements, following them wherever they go.
export type StageElementKind = "text" | "shape" | "image" | "stack" | "icon" | "connector";

// What a beat can set on an element. The numbers and `color` spring from beat to beat; the rest
// switch when the element's move into the beat begins.
export interface StageProps {
  // Top-left of the box, and its size.
  x: number;
  y: number;
  width: number;
  height: number;
  // The point scale and rotation turn about, as fractions of the box (0.5, 0.5 = its centre).
  anchorX: number;
  anchorY: number;
  scale: number;
  // Degrees clockwise.
  rotation: number;
  // Tilt in depth (degrees; positive rotateY turns the right edge away, rotateX the top away) and
  // distance toward the viewer (stage units) - seen through the scene's perspective.
  rotateX?: number;
  rotateY?: number;
  z?: number;
  opacity: number;
  // Gaussian blur radius in stage units.
  blur: number;
  visible: boolean;
  // Text colour, or a shape's fill.
  color?: string;
  text?: string;
  // How much of a connector is drawn, from its start (0..1; undefined = all of it). Springs, without
  // overshoot - a line drawing itself on.
  draw?: number;
  // Colours for parts of the text - character ranges of `text` [start, end).
  colorRuns?: StageColorRun[];
  // Font weights for parts of the text (a medium label beside a regular description), same ranges.
  weightRuns?: StageWeightRun[];
}

export interface StageWeightRun {
  start: number;
  end: number;
  weight: number;
}

export interface StageColorRun {
  start: number;
  end: number;
  color: string;
}

// How a text element looks. Sizes are stage units; the rest means what it does on a TextOverlay.
export interface StageTextLook {
  fontFamily?: string;
  fontSize: number;
  bold?: boolean;
  italic?: boolean;
  lineHeight?: number;
  // Fraction of the font size.
  letterSpacing?: number;
  textAlign?: "left" | "center" | "right";
  // Room between the text and its box, in stage units.
  paddingX?: number;
  paddingY?: number;
  backgroundColor?: string;
  cornerStyle?: "square" | "rounded" | "pill";
  // Every digit as wide as the widest - a ticking clock or counter doesn't jitter.
  tabularNums?: boolean;
}

// Lays out its children one after another along `direction`, `gap` apart, inside its own box:
// `justify` places the run along the direction, `align` places each child across it. Hidden
// children take no room - the others close up around them.
export interface StageStack {
  direction: "column" | "row";
  gap: number;
  justify: "start" | "center" | "end";
  align: "start" | "center" | "end";
}

// A property following a channel (stageChannels.ts): the channel's `from` range mapped onto `to`,
// held at the ends unless `extrapolate`. It follows the value exactly - no spring.
export type StageBindableProp = "x" | "y" | "width" | "height" | "scale" | "rotation" | "opacity";
export interface StageBinding {
  channel: string;
  from: [number, number];
  to: [number, number];
  extrapolate?: boolean;
}

// Changes an element takes on while a channel is below / at or above a threshold (both set: inside
// the range). The engine springs into and out of them at the exact moment the channel crosses.
export interface StageCondition {
  channel: string;
  below?: number;
  atOrAbove?: number;
  changes: Partial<StageProps>;
}

// How an element arrives when it appears and leaves when it's hidden: offsets from where it is
// shown, faded from/to nothing - and for a connector, how much of it is drawn then.
export interface StageTransitionStyle {
  dx: number;
  dy: number;
  scale: number;
  blur: number;
  draw?: number;
  // Opacity it arrives from (default 0 - faded in).
  opacity?: number;
}

// A line between two elements, from the edge of one toward the other, `gap` short of each.
export interface StageConnector {
  from: string;
  to: string;
  style: "solid" | "dots" | "dashes";
  // Stage units.
  thickness: number;
  gap: number;
  // Dots or dashes travelling along it, stage units a second (negative runs backwards; 0 = still).
  flow?: number;
  // Dots in a beat: every rhythm-th dot full size, the ones between small (and closer together).
  rhythm?: number;
}

export interface StageElement {
  id: string;
  kind: StageElementKind;
  name?: string;
  // Its state before any beat changes it.
  props: StageProps;
  // The stack laying it out (its own x/y are then ignored).
  parent?: string;
  // "hug": its size is its content's (a text's measured box; a stack's laid-out children) - width
  // still caps how wide text may run before it wraps. Default: the size in props.
  fit?: "hug";
  textLook?: StageTextLook;
  stack?: StageStack;
  // A shape's corners (stage units; half its height makes a pill) and an outline just inside its edge.
  // A gradient runs from the element's colour to `to`, at a CSS angle (180 = top to bottom); a
  // shadow is CSS's box-shadow: offset, blur radius (stage units), colour.
  shape?: {
    radius?: number;
    stroke?: { color: string; width: number };
    gradient?: { to: string; angle?: number };
    shadow?: { color: string; blur: number; x?: number; y?: number };
  };
  // An icon's name in the shared set (stickerIcons.ts). With a frame, it sits smaller inside a
  // rounded outline of its own colour (stage units), on `fill` if given.
  icon?: { name: string; frame?: { radius: number; width: number; fill?: string } };
  connector?: StageConnector;
  // A picture filling the box (cover: cropped to fill it; contain: all of it, letterboxed on the
  // element's colour). Its corners, outline and shadow are `shape`'s.
  image?: {
    src: string;
    fit?: "cover" | "contain";
    // Arrives as a grid of coloured dots that take on the picture's colours and merge into it.
    reveal?: "dots";
    dots?: { cell?: number; palette?: string[] };
  };
  bind?: Partial<Record<StageBindableProp, StageBinding>>;
  when?: StageCondition[];
  // Overrides the scene's spring for this element's own moves.
  spring?: SpringPreset;
  enter?: Partial<StageTransitionStyle>;
  exit?: Partial<StageTransitionStyle>;
}

export interface StageBeat {
  id: string;
  // Seconds from this beat's start to the next one's (the last beat's runs to the scene's end).
  hold: number;
  // Overrides the scene's spring and stagger for the moves into this beat.
  spring?: SpringPreset;
  stagger?: number;
  // Element id -> what changes in this beat.
  changes: Record<string, Partial<StageProps>>;
}

export type StageBackground = { kind: "none" } | { kind: "color"; color: string };

export interface StageScene {
  id: string;
  name?: string;
  // Output-timeline seconds - where the scene sits among the clips.
  startTime: number;
  layer?: number;
  // The stage's size in stage units (height is always 1080).
  width: number;
  height: number;
  background: StageBackground;
  // Bottom to top.
  elements: StageElement[];
  beats: StageBeat[];
  spring: SpringPreset;
  // How far the viewer stands from the stage, for elements tilted or moved in depth (stage units;
  // default 2000 - about a 30 degree view across a 1080 stage).
  perspective?: number;
  // Seconds between one element starting its move and the next, in stacking order.
  stagger: number;
  // Seconds between one new word of a text arriving and the next.
  wordStagger?: number;
  channels?: StageChannel[];
}

export const STAGE_HEIGHT = 1080;

export const DEFAULT_ENTER: StageTransitionStyle = { dx: 0, dy: 24, scale: 1, blur: 10 };
export const DEFAULT_EXIT: StageTransitionStyle = { dx: 0, dy: 0, scale: 1, blur: 10 };
// A connector draws itself on and fades away, unblurred.
export const CONNECTOR_ENTER: StageTransitionStyle = { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0 };
export const CONNECTOR_EXIT: StageTransitionStyle = { dx: 0, dy: 0, scale: 1, blur: 0 };
// A dot-revealed picture: there at once, its dots doing the arriving.
export const DOTS_ENTER: StageTransitionStyle = { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0, opacity: 1 };

export function defaultStageProps(overrides: Partial<StageProps> = {}): StageProps {
  return { x: 0, y: 0, width: 100, height: 100, anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, opacity: 1, blur: 0, visible: true, ...overrides };
}
