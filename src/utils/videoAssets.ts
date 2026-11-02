// utils/videoAssets.ts
//
// Shapes and animated elements for the video editor - stars, arrows, speech bubbles, hand-drawn
// circles, confetti, countdowns, progress bars... Each one lives on the timeline as an
// ImageOverlay carrying an `asset` (so moving, resizing, rotating, keyframing, retiming, undo and
// z-order all work exactly as they do for pictures), and is drawn by ONE function, drawAssetFrame,
// used by both the live preview (AssetCanvas, every animation frame) and export (renderAssetFrames,
// a PNG frame sequence burned in by export_trimmed_video) - so what plays in the editor is what
// lands in the file.
//
// Time inside an element is seconds from its own start. Everything that loops does so on periods
// dividing LOOP_PERIOD_SEC, which is what lets export send one loop's worth of frames for an
// element of any length (see assetFrameKey).

import { STICKER_COLORS, StickerFill, StickerIcon, drawSticker, isStickerKind, loadStickerResources } from "./stickerAssets";

export type AssetKind =
  // shapes
  | "rectangle"
  | "rounded"
  | "circle"
  | "triangle"
  | "diamond"
  | "hexagon"
  | "star"
  | "heart"
  | "blob"
  | "neon"
  | "guides"
  // callouts
  | "arrow"
  | "pointer"
  | "scribble"
  | "underline"
  | "highlight"
  | "speech"
  | "burst"
  | "check"
  | "cross"
  | "lower-third"
  | "subscribe"
  | "badge"
  | "pin"
  | "cursor"
  | "chevrons"
  | "bell"
  // animated
  | "sparkles"
  | "confetti"
  | "like"
  | "ping"
  | "spinner"
  | "equalizer"
  | "typing"
  | "rec"
  | "progress"
  | "countdown"
  | "timer"
  | "halo"
  // full-frame overlays
  | "viewfinder"
  | "reveal"
  | "letterbox"
  | "vignette"
  | "bokeh"
  | "snow"
  | "filmstrip"
  | "film35"
  | "retro"
  | "polaroid"
  | "lightleak"
  | "grain"
  | "twinkle"
  // stickers (stickerAssets.ts)
  | "chip"
  | "name-tag"
  | "stat"
  | "card"
  | "place"
  | "disc"
  | "title"
  | "milestone"
  | "icon"
  | "emoji"
  | "quote"
  | "profile"
  | "rating"
  | "meter"
  | "checklist"
  | "price"
  | "message"
  | "versus"
  | "date";

export type AssetEntrance = "none" | "pop" | "draw" | "zoom" | "spin" | "drop" | "wipe" | "glitch" | "flip";
export type AssetLoop = "none" | "pulse" | "float" | "spin" | "wiggle" | "glow" | "shimmer" | "hue";
// How a countdown spends its time: one number per second (then holds the last), or the numbers
// spread evenly over the element's whole length.
export type CountPace = "second" | "fit";

export interface OverlayAsset {
  kind: AssetKind;
  color: string;
  // Second colour: a gradient's end stop on shapes, the accent on multi-part elements. Undefined
  // means a solid colour.
  color2?: string;
  // Stroke-only instead of filled - shapes only (assetSupportsOutline).
  outline?: boolean;
  entrance: AssetEntrance;
  // Leave with the entrance played backwards.
  exit: boolean;
  loop: AssetLoop;
  glow?: boolean;
  // Words on elements that carry them (assetEntry(kind).text names the fields).
  text?: string;
  subtext?: string;
  // Countdown: counts countFrom -> countTo. Timer: counts up from countFrom seconds.
  countFrom?: number;
  countTo?: number;
  countPace?: CountPace;
  // Stickers (stickerAssets.ts): the style switches - Solid / Outline / No background, a border,
  // the 3D edge (on unless false) - an icon or a picture (a file path) where the icon goes, a
  // third line of words (corner tag / kicker / pill) and a third colour for inner pieces. `color2`
  // is a sticker's edge and its words on light surfaces.
  fill?: StickerFill;
  border?: boolean;
  lip?: boolean;
  icon?: StickerIcon;
  image?: string;
  tag?: string;
  accent?: string;
  // A chat bubble's side: the other person's on the left (the default), yours on the right.
  side?: "left" | "right";
}

// How an element changes over its life once it has entered - decides how many distinct frames
// export has to render (assetFrameKey).
type AssetMotion = "static" | "periodic" | "timed";

export type AssetCategory = "Stickers" | "Shapes" | "Callouts" | "Animated" | "Overlays";

export interface AssetCatalogEntry {
  kind: AssetKind;
  label: string;
  category: AssetCategory;
  // Natural width/height in pixels - the box it's placed with.
  aspect: number;
  motion: AssetMotion;
  defaults: Omit<OverlayAsset, "kind">;
  // Covers the whole frame when added (letterbox, vignette...) and draws nothing past its box.
  fullFrame?: boolean;
  // Labels for the text fields the panel offers ([text, subtext]).
  text?: [string, string?];
  // Seconds of one-off motion after the entrance (a button being clicked) before the element
  // settles into its static/periodic self - every frame until then is rendered for export.
  settleSec?: number;
  // A cheaper identity for a settled frame than "every frame in the loop" - frames with the same
  // key look the same (a blinking dot is on or off, a clock shows a whole second).
  idleKey?: (asset: OverlayAsset, t: number, duration: number) => string;
  // How tall it's added, as a fraction of the frame's height (default: a third of it).
  frameHeight?: number;
}

const fx = (entrance: AssetEntrance, loop: AssetLoop = "none", exit = true) => ({ entrance, loop, exit });

// REC-style blinking: on for the first half of every 1.2s.
const blinkOn = (t: number) => t % 1.2 < 0.7;

const sticker = { lip: true, fill: "solid" as const, color2: STICKER_COLORS.navy, ...fx("pop") };

export const ASSET_CATALOG: AssetCatalogEntry[] = [
  { kind: "chip", label: "Label", category: "Stickers", aspect: 3, motion: "static", frameHeight: 0.07, text: ["Label"], defaults: { ...sticker, color: STICKER_COLORS.amber, icon: "users", text: "Trained" } },
  {
    kind: "name-tag",
    label: "Name tag",
    category: "Stickers",
    aspect: 3.2,
    motion: "static",
    frameHeight: 0.2,
    text: ["Name", "Title"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.blue, text: "Daniel Adeyemi", subtext: "CEO, Brightpath Academy", tag: "NEW" },
  },
  {
    kind: "stat",
    label: "Stat counter",
    category: "Stickers",
    aspect: 2,
    motion: "static",
    // Counting up: every frame differs until the figure lands.
    settleSec: 2.4,
    frameHeight: 0.24,
    text: ["Line", "After the number"],
    defaults: { ...sticker, color: STICKER_COLORS.blue, text: "people in our network", subtext: "+", countFrom: 0, countTo: 200000 },
  },
  { kind: "card", label: "Info card", category: "Stickers", aspect: 2.6, motion: "static", frameHeight: 0.15, text: ["Headline", "Line under"], defaults: { ...sticker, color: STICKER_COLORS.blue, icon: "doc", tag: "Use your", text: "transcript", subtext: "" } },
  {
    kind: "place",
    label: "Place card",
    category: "Stickers",
    aspect: 2.1,
    motion: "static",
    frameHeight: 0.17,
    text: ["Name", "Location"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.blue, text: "Oxford Open University of London", subtext: "England" },
  },
  { kind: "disc", label: "Icon disc", category: "Stickers", aspect: 1, motion: "static", frameHeight: 0.14, defaults: { ...sticker, color: STICKER_COLORS.amber, accent: STICKER_COLORS.plum, icon: "cap", tag: "NEW" } },
  {
    kind: "title",
    label: "Title",
    category: "Stickers",
    aspect: 3,
    motion: "static",
    frameHeight: 0.3,
    text: ["Headline", "Byline"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.amber, icon: "cap", tag: "Introducing", text: "Degrees", subtext: "by Brightpath Academy" },
  },
  {
    kind: "milestone",
    label: "Milestone",
    category: "Stickers",
    aspect: 2.4,
    motion: "static",
    frameHeight: 0.26,
    text: ["Figure", "Word"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.amber, text: "5", subtext: "years", tag: "Anniversary" },
  },
  { kind: "icon", label: "Icon", category: "Stickers", aspect: 1, motion: "static", frameHeight: 0.14, defaults: { ...sticker, fill: "none", color: STICKER_COLORS.amber, icon: "star" } },
  { kind: "emoji", label: "Emoji", category: "Stickers", aspect: 1, motion: "static", frameHeight: 0.16, text: ["Emoji"], defaults: { ...sticker, fill: "none", lip: false, color: STICKER_COLORS.white, text: "\u{1F525}" } },
  {
    kind: "quote",
    label: "Quote",
    category: "Stickers",
    aspect: 2.2,
    motion: "static",
    frameHeight: 0.3,
    text: ["Quote", "Name"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.blue, text: "This changed how our whole team works. We ship twice as fast now.", subtext: "Ada Okafor", tag: "Head of Product" },
  },
  {
    kind: "profile",
    label: "Profile",
    category: "Stickers",
    aspect: 3.4,
    motion: "static",
    frameHeight: 0.13,
    text: ["Name", "Handle"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.blue, icon: "check", text: "Your Name", subtext: "@yourhandle", tag: "Follow" },
  },
  {
    kind: "rating",
    label: "Rating",
    category: "Stickers",
    aspect: 2.6,
    motion: "static",
    // The stars fill in after the entrance.
    settleSec: 2,
    frameHeight: 0.15,
    text: ["Line"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.amber, text: "from 2,400 reviews", countTo: 4.9 },
  },
  {
    kind: "meter",
    label: "Meter",
    category: "Stickers",
    aspect: 4,
    motion: "static",
    settleSec: 2.2,
    frameHeight: 0.12,
    text: ["Label"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.teal, text: "Course completed", countTo: 78 },
  },
  {
    kind: "checklist",
    label: "Checklist",
    category: "Stickers",
    aspect: 1.7,
    motion: "static",
    // Up to six items ticking in one after another.
    settleSec: 3.2,
    frameHeight: 0.3,
    text: ["Items (; between)"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.teal, tag: "You'll learn", text: "Plan your shoot; Record in one take; Edit in minutes" },
  },
  {
    kind: "price",
    label: "Price",
    category: "Stickers",
    aspect: 1.7,
    motion: "static",
    frameHeight: 0.2,
    text: ["Price", "Per"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.red, tag: "$99", text: "$49", subtext: "/month" },
  },
  {
    kind: "message",
    label: "Chat bubble",
    category: "Stickers",
    aspect: 2.6,
    motion: "static",
    // Typing dots, then the words.
    settleSec: 1.8,
    frameHeight: 0.16,
    text: ["Message"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.blue, tag: "Sam", text: "Wait, you made this in Briefcast?!" },
  },
  {
    kind: "versus",
    label: "Versus",
    category: "Stickers",
    aspect: 3.6,
    motion: "static",
    frameHeight: 0.12,
    text: ["Left", "Right"],
    defaults: { ...sticker, color: STICKER_COLORS.blue, accent: STICKER_COLORS.amber, text: "Before", subtext: "After" },
  },
  {
    kind: "date",
    label: "Date",
    category: "Stickers",
    aspect: 3,
    motion: "static",
    frameHeight: 0.17,
    text: ["Event", "Time & place"],
    defaults: { ...sticker, color: STICKER_COLORS.white, accent: STICKER_COLORS.red, tag: "Mar 14", text: "Launch livestream", subtext: "7 PM WAT · Online" },
  },

  { kind: "rectangle", label: "Rectangle", category: "Shapes", aspect: 1.6, motion: "static", defaults: { color: "#3b82f6", color2: "#8b5cf6", ...fx("pop") } },
  { kind: "rounded", label: "Rounded", category: "Shapes", aspect: 1.6, motion: "static", defaults: { color: "#f43f5e", color2: "#f59e0b", ...fx("pop") } },
  { kind: "circle", label: "Circle", category: "Shapes", aspect: 1, motion: "static", defaults: { color: "#22d3ee", color2: "#3b82f6", ...fx("pop") } },
  { kind: "triangle", label: "Triangle", category: "Shapes", aspect: 1.1, motion: "static", defaults: { color: "#facc15", color2: "#f97316", ...fx("spin") } },
  { kind: "diamond", label: "Diamond", category: "Shapes", aspect: 0.8, motion: "static", defaults: { color: "#a855f7", color2: "#ec4899", ...fx("zoom", "float") } },
  { kind: "hexagon", label: "Hexagon", category: "Shapes", aspect: 1.15, motion: "static", defaults: { color: "#10b981", color2: "#06b6d4", ...fx("spin") } },
  { kind: "star", label: "Star", category: "Shapes", aspect: 1, motion: "static", defaults: { color: "#fde047", color2: "#f59e0b", glow: true, ...fx("spin", "pulse") } },
  { kind: "heart", label: "Heart", category: "Shapes", aspect: 1.1, motion: "static", defaults: { color: "#f43f5e", color2: "#ec4899", ...fx("pop", "pulse") } },
  { kind: "blob", label: "Blob", category: "Shapes", aspect: 1, motion: "periodic", defaults: { color: "#8b5cf6", color2: "#22d3ee", ...fx("zoom") } },
  // A glowing neon-tube outline - draws itself on.
  // Thin construction lines drawing a frame whose edges run on past its corners - layout guides.
  { kind: "guides", label: "Guide lines", category: "Shapes", aspect: 1.6, motion: "static", defaults: { color: "#ffffff", ...fx("draw") } },
  { kind: "neon", label: "Neon frame", category: "Shapes", aspect: 1.25, motion: "static", defaults: { color: "#facc15", color2: "#ffffff", ...fx("draw", "glow") } },

  { kind: "subscribe", label: "Subscribe", category: "Callouts", aspect: 3.6, motion: "static", settleSec: 2.2, text: ["Button", "Clicked"], defaults: { color: "#ef4444", text: "SUBSCRIBE", subtext: "SUBSCRIBED", ...fx("pop") } },
  { kind: "lower-third", label: "Lower third", category: "Callouts", aspect: 5, motion: "static", text: ["Name", "Title"], defaults: { color: "#111827", color2: "#3b82f6", text: "Your Name", subtext: "Title · Company", ...fx("wipe", "shimmer") } },
  { kind: "badge", label: "Badge", category: "Callouts", aspect: 2.4, motion: "static", text: ["Label"], defaults: { color: "#f43f5e", color2: "#f59e0b", text: "NEW", ...fx("pop", "shimmer") } },
  { kind: "pin", label: "Location", category: "Callouts", aspect: 2.8, motion: "static", text: ["Place"], defaults: { color: "#ef4444", text: "Lagos, Nigeria", ...fx("drop") } },
  { kind: "cursor", label: "Click", category: "Callouts", aspect: 1, motion: "periodic", defaults: { color: "#3b82f6", ...fx("zoom") } },
  { kind: "arrow", label: "Arrow", category: "Callouts", aspect: 2.2, motion: "static", defaults: { color: "#facc15", ...fx("wipe", "float") } },
  { kind: "chevrons", label: "Swipe", category: "Callouts", aspect: 2, motion: "periodic", defaults: { color: "#ffffff", ...fx("wipe") } },
  { kind: "pointer", label: "Hand arrow", category: "Callouts", aspect: 1.3, motion: "static", defaults: { color: "#ef4444", ...fx("draw") } },
  { kind: "scribble", label: "Circle it", category: "Callouts", aspect: 1.6, motion: "static", defaults: { color: "#ef4444", ...fx("draw") } },
  { kind: "underline", label: "Swoosh", category: "Callouts", aspect: 5, motion: "static", defaults: { color: "#facc15", ...fx("draw") } },
  { kind: "highlight", label: "Highlighter", category: "Callouts", aspect: 4, motion: "static", defaults: { color: "#fde047", ...fx("wipe") } },
  { kind: "speech", label: "Speech", category: "Callouts", aspect: 1.4, motion: "static", defaults: { color: "#ffffff", ...fx("pop", "wiggle") } },
  { kind: "burst", label: "Burst", category: "Callouts", aspect: 1, motion: "static", defaults: { color: "#ef4444", color2: "#f59e0b", ...fx("pop", "spin") } },
  { kind: "bell", label: "Bell", category: "Callouts", aspect: 1, motion: "periodic", defaults: { color: "#facc15", ...fx("pop") } },
  { kind: "check", label: "Check", category: "Callouts", aspect: 1, motion: "static", defaults: { color: "#22c55e", ...fx("pop") } },
  { kind: "cross", label: "Cross", category: "Callouts", aspect: 1, motion: "static", defaults: { color: "#ef4444", ...fx("pop") } },

  { kind: "countdown", label: "Countdown", category: "Animated", aspect: 1, motion: "timed", defaults: { color: "#f43f5e", color2: "#ffffff", countFrom: 3, countTo: 1, countPace: "second", ...fx("pop", "none", false) } },
  {
    kind: "timer",
    label: "Timer",
    category: "Animated",
    aspect: 2.6,
    motion: "timed",
    defaults: { color: "#111827", color2: "#ffffff", countFrom: 0, ...fx("pop") },
    idleKey: (asset, t) => `s${Math.floor(t + (asset.countFrom ?? 0))}`,
  },
  { kind: "rec", label: "REC", category: "Animated", aspect: 2.4, motion: "periodic", text: ["Label"], defaults: { color: "#ef4444", text: "REC", ...fx("zoom") }, idleKey: (_a, t) => (blinkOn(t) ? "on" : "off") },
  { kind: "sparkles", label: "Sparkles", category: "Animated", aspect: 1.2, motion: "periodic", defaults: { color: "#fde047", color2: "#ffffff", glow: true, ...fx("zoom") } },
  { kind: "confetti", label: "Confetti", category: "Animated", aspect: 1.4, motion: "periodic", defaults: { color: "#f43f5e", color2: "#3b82f6", ...fx("none") } },
  { kind: "like", label: "Like burst", category: "Animated", aspect: 1, motion: "periodic", defaults: { color: "#f43f5e", color2: "#facc15", ...fx("pop") } },
  { kind: "ping", label: "Attention", category: "Animated", aspect: 1, motion: "periodic", defaults: { color: "#f43f5e", ...fx("pop") } },
  { kind: "typing", label: "Typing…", category: "Animated", aspect: 1.6, motion: "periodic", defaults: { color: "#e5e7eb", color2: "#6b7280", ...fx("pop") } },
  { kind: "spinner", label: "Loader", category: "Animated", aspect: 1, motion: "periodic", defaults: { color: "#3b82f6", color2: "#22d3ee", ...fx("zoom") } },
  { kind: "equalizer", label: "Equalizer", category: "Animated", aspect: 1.4, motion: "periodic", defaults: { color: "#22d3ee", color2: "#a855f7", ...fx("wipe") } },
  { kind: "progress", label: "Progress", category: "Animated", aspect: 8, motion: "timed", defaults: { color: "#22c55e", color2: "#3b82f6", ...fx("wipe", "none", false) } },
  // A glowing ring on the floor / around a subject, a highlight running round it.
  { kind: "halo", label: "Halo ring", category: "Animated", aspect: 2.4, motion: "periodic", defaults: { color: "#ffffff", color2: "#fde68a", ...fx("zoom") } },

  {
    kind: "viewfinder",
    label: "Viewfinder",
    category: "Overlays",
    aspect: 16 / 9,
    motion: "periodic",
    fullFrame: true,
    text: ["Corner label"],
    defaults: { color: "#ffffff", color2: "#ef4444", text: "4K · 60fps", ...fx("zoom") },
    idleKey: (_a, t) => (blinkOn(t) ? "on" : "off"),
  },
  // Opens the picture out of a horizontal line - an intro from black (or a closing, with exit on).
  { kind: "reveal", label: "Bar reveal", category: "Overlays", aspect: 16 / 9, motion: "static", fullFrame: true, defaults: { color: "#000000", ...fx("draw", "none", false) } },
  { kind: "letterbox", label: "Cinema bars", category: "Overlays", aspect: 16 / 9, motion: "static", fullFrame: true, defaults: { color: "#000000", ...fx("draw") } },
  { kind: "vignette", label: "Vignette", category: "Overlays", aspect: 16 / 9, motion: "static", fullFrame: true, defaults: { color: "#000000", ...fx("none") } },
  { kind: "bokeh", label: "Bokeh", category: "Overlays", aspect: 16 / 9, motion: "periodic", fullFrame: true, defaults: { color: "#fbbf24", color2: "#f472b6", ...fx("none") } },
  { kind: "snow", label: "Snow", category: "Overlays", aspect: 16 / 9, motion: "periodic", fullFrame: true, defaults: { color: "#ffffff", ...fx("none") } },
  // Film: perforated strips down the sides (rolling), a 35mm negative's frame, an old rounded
  // slide/TV frame, a polaroid border, warm light leaks, grain and dust, glints twinkling.
  { kind: "filmstrip", label: "Film strip", category: "Overlays", aspect: 16 / 9, motion: "periodic", fullFrame: true, text: ["Edge print"], defaults: { color: "#0b0b0b", color2: "#ecebe6", text: "FILM 400", ...fx("none", "none", false) } },
  { kind: "film35", label: "35mm frame", category: "Overlays", aspect: 16 / 9, motion: "static", fullFrame: true, text: ["Edge print"], defaults: { color: "#0d0d0d", color2: "#f59e0b", text: "FILM 400  ▸ 24A", ...fx("none", "none", false) } },
  { kind: "retro", label: "Retro frame", category: "Overlays", aspect: 16 / 9, motion: "static", fullFrame: true, defaults: { color: "#000000", ...fx("none", "none", false) } },
  { kind: "polaroid", label: "Polaroid", category: "Overlays", aspect: 16 / 9, motion: "static", fullFrame: true, text: ["Caption"], defaults: { color: "#f7f5f0", color2: "#3f3f46", text: "", ...fx("none", "none", false) } },
  { kind: "lightleak", label: "Light leaks", category: "Overlays", aspect: 16 / 9, motion: "periodic", fullFrame: true, defaults: { color: "#ff5a1f", color2: "#ffc53d", ...fx("none") } },
  {
    kind: "grain",
    label: "Film grain",
    category: "Overlays",
    aspect: 16 / 9,
    motion: "periodic",
    fullFrame: true,
    defaults: { color: "#000000", ...fx("none", "none", false) },
    // The grain re-rolls 12 times a second through GRAIN_FRAMES patterns.
    idleKey: (_a, t) => `g${grainFrame(t)}`,
  },
  { kind: "twinkle", label: "Twinkles", category: "Overlays", aspect: 16 / 9, motion: "periodic", fullFrame: true, defaults: { color: "#ffffff", color2: "#fde68a", ...fx("none") } },
];

// Film grain: GRAIN_FRAMES fixed patterns, re-rolled GRAIN_FPS times a second.
const GRAIN_FRAMES = 8;
const GRAIN_FPS = 12;
const grainFrame = (t: number) => Math.floor(t * GRAIN_FPS) % GRAIN_FRAMES;

export const ASSET_CATEGORIES: AssetCategory[] = ["Stickers", "Shapes", "Callouts", "Animated", "Overlays"];

export const assetEntry = (kind: AssetKind): AssetCatalogEntry => ASSET_CATALOG.find((e) => e.kind === kind) ?? ASSET_CATALOG[0];

export const makeAsset = (kind: AssetKind): OverlayAsset => ({ kind, ...assetEntry(kind).defaults });

const POLY_SHAPES = new Set<AssetKind>(["rectangle", "rounded", "circle", "triangle", "diamond", "hexagon", "star", "heart", "blob", "arrow", "speech", "burst"]);
const STROKE_SHAPES = new Set<AssetKind>(["pointer", "scribble", "underline"]);

export const assetSupportsOutline = (kind: AssetKind): boolean => POLY_SHAPES.has(kind) && kind !== "speech";
// Elements made of a second colour (gradient end or accent) - the panel's second swatch.
export const assetUsesColor2 = (kind: AssetKind): boolean =>
  !STROKE_SHAPES.has(kind) &&
  !["highlight", "speech", "check", "cross", "ping", "subscribe", "pin", "cursor", "chevrons", "bell", "rec", "reveal", "letterbox", "vignette", "snow", "retro", "grain"].includes(kind);

export const ASSET_ENTRANCES: { value: AssetEntrance; label: string }[] = [
  { value: "none", label: "None" },
  { value: "pop", label: "Pop" },
  { value: "draw", label: "Draw" },
  { value: "zoom", label: "Zoom" },
  { value: "spin", label: "Spin" },
  { value: "drop", label: "Drop" },
  { value: "wipe", label: "Wipe" },
  { value: "glitch", label: "Glitch" },
  { value: "flip", label: "Flip" },
];

export const ASSET_LOOPS: { value: AssetLoop; label: string }[] = [
  { value: "none", label: "None" },
  { value: "pulse", label: "Pulse" },
  { value: "float", label: "Float" },
  { value: "spin", label: "Spin" },
  { value: "wiggle", label: "Wiggle" },
  { value: "glow", label: "Glow" },
  { value: "shimmer", label: "Shimmer" },
  { value: "hue", label: "Rainbow" },
];

// Every loop's period divides this, so frame k and frame k + LOOP_PERIOD_SEC*fps look the same.
export const LOOP_PERIOD_SEC = 4.8;
export const ASSET_FPS = 30;
const TAU = Math.PI * 2;

// Room drawn around the element's box for what spills past it (glow, a pop's overshoot, a drop's
// fall, spinning corners) - the same on screen and in export, in pixels of the drawn box. None for
// a full-frame overlay: there's nothing past the frame to show.
export const assetMarginPx = (w: number, h: number, kind?: AssetKind): number =>
  kind && assetEntry(kind).fullFrame ? 0 : 0.45 * Math.min(w, h) + 0.12 * Math.max(w, h);

// A countdown's numbers and how long each shows. "second" pace shows each for a second and then
// holds the last; "fit" spreads them over the whole element.
export function countdownPlan(asset: OverlayAsset, duration: number): { from: number; to: number; steps: number; stepSec: number } {
  const from = Math.round(asset.countFrom ?? Math.max(1, Math.round(duration)));
  const to = Math.round(asset.countTo ?? 1);
  const steps = Math.abs(from - to) + 1;
  const stepSec = asset.countPace === "fit" ? Math.max(1e-3, duration / steps) : 1;
  return { from, to, steps, stepSec };
}

export const entranceSeconds = (asset: OverlayAsset, duration: number): number => {
  if (asset.entrance === "none") return 0;
  const base = asset.entrance === "draw" ? 0.9 : asset.entrance === "drop" || asset.entrance === "flip" ? 0.8 : 0.6;
  return Math.max(0, Math.min(base, duration * 0.35));
};

// ---------- easing ----------

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const easeOutBounce = (t: number) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};
// Deterministic pseudo-random in [0,1) - same element, same "random" particles, every frame and
// every export.
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// ---------- geometry (centred on 0,0; w x h box) ----------

type Pt = [number, number];

const ellipsePts = (rx: number, ry: number, n = 96): Pt[] => Array.from({ length: n + 1 }, (_, i) => [Math.cos((i / n) * TAU - Math.PI / 2) * rx, Math.sin((i / n) * TAU - Math.PI / 2) * ry]);

const roundedRectPts = (w: number, h: number, r: number): Pt[] => {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const pts: Pt[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (i / 8) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
  };
  corner(w / 2 - rr, -h / 2 + rr, -Math.PI / 2);
  corner(w / 2 - rr, h / 2 - rr, 0);
  corner(-w / 2 + rr, h / 2 - rr, Math.PI / 2);
  corner(-w / 2 + rr, -h / 2 + rr, Math.PI);
  pts.push(pts[0]);
  return pts;
};

const regularPts = (n: number, rx: number, ry: number, rot = -Math.PI / 2): Pt[] => {
  const pts: Pt[] = Array.from({ length: n }, (_, i) => [Math.cos(rot + (i / n) * TAU) * rx, Math.sin(rot + (i / n) * TAU) * ry]);
  pts.push(pts[0]);
  return pts;
};

const starPts = (spikes: number, rx: number, ry: number, inner: number): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? 1 : inner;
    const a = -Math.PI / 2 + (i / (spikes * 2)) * TAU;
    pts.push([Math.cos(a) * rx * r, Math.sin(a) * ry * r]);
  }
  pts.push(pts[0]);
  return pts;
};

const heartPts = (w: number, h: number): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * TAU;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    pts.push([(x / 34) * w, ((y + 2.5) / 31) * h]);
  }
  return pts;
};

const blobPts = (w: number, h: number, t: number): Pt[] => {
  const a = (t / LOOP_PERIOD_SEC) * TAU;
  return Array.from({ length: 97 }, (_, i) => {
    const th = (i / 96) * TAU;
    const r = 0.86 + 0.07 * Math.sin(3 * th + a) + 0.05 * Math.sin(5 * th - 2 * a) + 0.03 * Math.cos(2 * th + 3 * a);
    return [Math.cos(th) * r * (w / 2), Math.sin(th) * r * (h / 2)] as Pt;
  });
};

const arrowPts = (w: number, h: number): Pt[] => {
  const shaft = h * 0.22;
  const headX = w / 2 - h * 0.62;
  return [
    [-w / 2, -shaft],
    [headX, -shaft],
    [headX, -h / 2],
    [w / 2, 0],
    [headX, h / 2],
    [headX, shaft],
    [-w / 2, shaft],
    [-w / 2, -shaft],
  ];
};

const speechPts = (w: number, h: number): Pt[] => {
  const bodyH = h * 0.78;
  const top = -h / 2;
  const r = Math.min(w, bodyH) * 0.28;
  const body = roundedRectPts(w, bodyH, r).map(([x, y]) => [x, y + top + bodyH / 2] as Pt);
  // Splice a tail into the bottom edge, between the bottom-right and bottom-left corners.
  const bottom = top + bodyH;
  const cut = body.findIndex(([x, y]) => Math.abs(y - bottom) < 1e-6 && x < w / 2 - r + 1e-6);
  const tail: Pt[] = [
    [-w * 0.05, bottom],
    [-w * 0.22, h / 2],
    [-w * 0.24, bottom],
  ];
  return cut >= 0 ? [...body.slice(0, cut + 1), ...tail, ...body.slice(cut + 1)] : body;
};

// Hand-drawn strokes - a little deterministic wobble so they read as a marker, not a vector.
const scribblePts = (w: number, h: number): Pt[] => {
  const pts: Pt[] = [];
  const turns = 1.18;
  for (let i = 0; i <= 140; i++) {
    const u = i / 140;
    const th = -Math.PI * 0.75 + u * turns * TAU;
    const wob = 1 + 0.035 * Math.sin(u * 23) + 0.02 * Math.sin(u * 51 + 1);
    const grow = 0.92 + 0.08 * u;
    pts.push([Math.cos(th) * (w / 2) * 0.9 * wob * grow, Math.sin(th) * (h / 2) * 0.86 * wob * grow]);
  }
  return pts;
};

const pointerPts = (w: number, h: number): Pt[] => {
  // A curve from bottom-left sweeping up to the top-right.
  const p0: Pt = [-w * 0.42, h * 0.36];
  const c: Pt = [-w * 0.3, -h * 0.4];
  const p1: Pt = [w * 0.36, -h * 0.3];
  return Array.from({ length: 61 }, (_, i) => {
    const t = i / 60;
    const x = (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0];
    const y = (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1];
    return [x, y + Math.sin(t * 9) * h * 0.008] as Pt;
  });
};

const underlinePts = (w: number, h: number): Pt[] =>
  Array.from({ length: 81 }, (_, i) => {
    const t = i / 80;
    return [(-0.47 + t * 0.94) * w, h * (0.12 - 0.34 * Math.sin(t * Math.PI) * (0.6 + 0.4 * t)) + Math.sin(t * 17) * h * 0.02] as Pt;
  });

function shapePoints(kind: AssetKind, w: number, h: number, t: number): Pt[] {
  switch (kind) {
    case "rectangle":
      return roundedRectPts(w, h, 0);
    case "rounded":
      return roundedRectPts(w, h, Math.min(w, h) * 0.22);
    case "circle":
      return ellipsePts(w / 2, h / 2);
    case "triangle":
      return [[0, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [0, -h / 2]];
    case "diamond":
      return [[0, -h / 2], [w / 2, 0], [0, h / 2], [-w / 2, 0], [0, -h / 2]];
    case "hexagon":
      return regularPts(6, w / 2, h / 2, 0);
    case "star":
      return starPts(5, w / 2, h / 2 * 1.05, 0.45).map(([x, y]) => [x, y + h * 0.04] as Pt);
    case "heart":
      return heartPts(w, h);
    case "blob":
      return blobPts(w, h, t);
    case "arrow":
      return arrowPts(w, h);
    case "speech":
      return speechPts(w, h);
    case "burst":
      return starPts(14, w / 2, h / 2, 0.72);
    case "scribble":
      return scribblePts(w, h);
    case "pointer":
      return pointerPts(w, h);
    case "underline":
      return underlinePts(w, h);
    default:
      return roundedRectPts(w, h, 0);
  }
}

const tracePath = (ctx: CanvasRenderingContext2D, pts: Pt[]) => {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
};

// The first `fraction` of a polyline, by length - what a "draw" entrance reveals.
const partialPts = (pts: Pt[], fraction: number): Pt[] => {
  if (fraction >= 1) return pts;
  if (fraction <= 0 || pts.length < 2) return [];
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let remaining = total * fraction;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (remaining >= seg[i - 1]) {
      out.push(pts[i]);
      remaining -= seg[i - 1];
    } else {
      const f = seg[i - 1] > 0 ? remaining / seg[i - 1] : 0;
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]);
      break;
    }
  }
  return out;
};

const paintFor = (ctx: CanvasRenderingContext2D, asset: OverlayAsset, w: number, h: number): string | CanvasGradient => {
  if (!asset.color2 || !assetUsesColor2(asset.kind)) return asset.color;
  const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
  g.addColorStop(0, asset.color);
  g.addColorStop(1, asset.color2);
  return g;
};

const FONT_STACK = `"Inter", "Segoe UI", system-ui, sans-serif`;

// Sets ctx.font to the largest size up to maxH at which `text` fits maxW.
const fitFont = (ctx: CanvasRenderingContext2D, text: string, maxW: number, maxH: number, weight: number): void => {
  ctx.font = `${weight} ${maxH}px ${FONT_STACK}`;
  const measured = ctx.measureText(text).width;
  if (measured > maxW && measured > 0) ctx.font = `${weight} ${Math.max(4, (maxH * maxW) / measured)}px ${FONT_STACK}`;
};

const pillPath = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  else ctx.rect(x, y, w, h);
};

const parseHex = (color: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
};

const withAlpha = (color: string, alpha: number): string => {
  const rgb = parseHex(color);
  return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` : color;
};

const isDark = (color: string): boolean => {
  const rgb = parseHex(color);
  return !rgb || 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 150;
};

// A classic arrow mouse pointer with its tip at (x, y).
function drawCursorArrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const pts: Pt[] = [[0, 0], [0, 0.8], [0.21, 0.62], [0.36, 0.95], [0.49, 0.89], [0.34, 0.57], [0.6, 0.57]];
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px * size, py * size) : ctx.lineTo(px * size, py * size)));
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = size * 0.12;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = Math.max(1, size * 0.05);
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
}

// ---------- the elements ----------

// Draws one element, already transformed so its box is centred on 0,0. `reveal` is how far a
// "draw" entrance has got (1 = fully drawn).
function drawElement(ctx: CanvasRenderingContext2D, asset: OverlayAsset, w: number, h: number, t: number, duration: number, reveal: number): void {
  if (isStickerKind(asset.kind)) {
    ctx.save();
    ctx.translate(-w / 2, -h / 2);
    drawSticker(ctx, asset, w, h, t, entranceSeconds(asset, duration));
    ctx.restore();
    return;
  }
  const unit = Math.min(w, h);
  const kind = asset.kind;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (POLY_SHAPES.has(kind)) {
    const pts = shapePoints(kind, w, h, t);
    const paint = paintFor(ctx, asset, w, h);
    const strokeW = Math.max(2, unit * 0.06);
    if (asset.outline && assetSupportsOutline(kind)) {
      // Inset by half the stroke so the outline stays inside the box.
      const inner = shapePoints(kind, Math.max(1, w - strokeW), Math.max(1, h - strokeW), t);
      ctx.strokeStyle = paint;
      ctx.lineWidth = strokeW;
      tracePath(ctx, partialPts(inner, reveal));
      ctx.stroke();
      return;
    }
    if (reveal < 1) {
      // Draw-on: the outline traces round, then the fill floods in behind it.
      ctx.strokeStyle = paint;
      ctx.lineWidth = strokeW;
      tracePath(ctx, partialPts(pts, Math.min(1, reveal / 0.7)));
      ctx.stroke();
      const fillAlpha = clamp01((reveal - 0.55) / 0.45);
      if (fillAlpha <= 0) return;
      ctx.save();
      ctx.globalAlpha *= fillAlpha;
    }
    tracePath(ctx, pts);
    ctx.closePath();
    ctx.fillStyle = paint;
    ctx.fill();
    if (kind === "speech") {
      // A bubble needs an edge to read on white footage.
      ctx.strokeStyle = "rgba(0,0,0,0.18)";
      ctx.lineWidth = Math.max(1, unit * 0.015);
      ctx.stroke();
    }
    if (kind === "burst") {
      tracePath(ctx, starPts(14, (w / 2) * 0.82, (h / 2) * 0.82, 0.74));
      ctx.closePath();
      ctx.strokeStyle = "rgba(255,255,255,0.65)";
      ctx.lineWidth = Math.max(1.5, unit * 0.025);
      ctx.stroke();
    }
    if (reveal < 1) ctx.restore();
    return;
  }

  if (STROKE_SHAPES.has(kind)) {
    const pts = shapePoints(kind, w, h, t);
    const strokeW = Math.max(3, unit * (kind === "underline" ? 0.32 : kind === "pointer" ? 0.075 : 0.07));
    // Inset the stroke so its round caps stay inside the box.
    const sx = Math.max(0.1, (w - strokeW) / w);
    const sy = Math.max(0.1, (h - strokeW) / h);
    const scaled = pts.map(([x, y]) => [x * sx, y * sy] as Pt);
    const shown = partialPts(scaled, Math.min(1, reveal / (kind === "pointer" ? 0.8 : 1)));
    ctx.strokeStyle = asset.color;
    ctx.lineWidth = strokeW;
    tracePath(ctx, shown);
    ctx.stroke();
    if (kind === "pointer" && reveal > 0.8) {
      // Arrowhead, flicked on once the shaft arrives.
      const head = clamp01((reveal - 0.8) / 0.2);
      const [ex, ey] = scaled[scaled.length - 1];
      const [px, py] = scaled[scaled.length - 6];
      const ang = Math.atan2(ey - py, ex - px);
      const len = unit * 0.26 * easeOutBack(head);
      ctx.beginPath();
      ctx.moveTo(ex + Math.cos(ang + 2.55) * len, ey + Math.sin(ang + 2.55) * len);
      ctx.lineTo(ex, ey);
      ctx.lineTo(ex + Math.cos(ang - 2.55) * len, ey + Math.sin(ang - 2.55) * len);
      ctx.stroke();
    }
    return;
  }

  switch (kind) {
    case "highlight": {
      // Marker stroke: slanted ends, translucent ink.
      ctx.globalAlpha *= 0.5;
      ctx.fillStyle = asset.color;
      const sk = h * 0.18;
      ctx.beginPath();
      ctx.moveTo(-w / 2 + sk, -h / 2);
      ctx.lineTo(w / 2, -h / 2 + h * 0.06);
      ctx.lineTo(w / 2 - sk, h / 2);
      ctx.lineTo(-w / 2, h / 2 - h * 0.06);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case "check":
    case "cross": {
      const r = unit / 2;
      ctx.fillStyle = asset.color;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
      // The mark draws itself in after the disc lands.
      const mark = clamp01((reveal - 0.25) / 0.75);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = unit * 0.1;
      if (kind === "check") {
        const pts: Pt[] = [[-r * 0.42, r * 0.02], [-r * 0.1, r * 0.32], [r * 0.45, -r * 0.3]];
        tracePath(ctx, partialPts(pts, mark));
        ctx.stroke();
      } else {
        const a = r * 0.36;
        tracePath(ctx, partialPts([[-a, -a], [a, a]], clamp01(mark * 2)));
        ctx.stroke();
        tracePath(ctx, partialPts([[a, -a], [-a, a]], clamp01(mark * 2 - 1)));
        ctx.stroke();
      }
      return;
    }
    case "lower-third": {
      const barH = h * 0.62;
      const accentH = h * 0.24;
      const mainW = w * clamp01(reveal * 1.4);
      const accentW = w * 0.62 * clamp01(reveal * 1.4 - 0.25);
      ctx.fillStyle = asset.color2 ?? "#3b82f6";
      ctx.fillRect(-w / 2, -h / 2, accentW, accentH);
      ctx.fillStyle = asset.color;
      ctx.fillRect(-w / 2, -h / 2 + accentH + h * 0.06, mainW, barH);
      ctx.fillStyle = asset.color2 ?? "#3b82f6";
      ctx.fillRect(-w / 2, -h / 2 + accentH + h * 0.06, Math.min(mainW, h * 0.1), barH);
      if (asset.text || asset.subtext) {
        const top = -h / 2 + accentH + h * 0.06;
        const tx = -w / 2 + h * 0.3;
        ctx.save();
        ctx.beginPath();
        ctx.rect(-w / 2, top, mainW, barH);
        ctx.clip();
        ctx.fillStyle = isDark(asset.color) ? "#ffffff" : "#111827";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const hasSub = !!asset.subtext;
        if (asset.text) {
          fitFont(ctx, asset.text, w - h * 0.6, barH * (hasSub ? 0.42 : 0.55), 700);
          ctx.fillText(asset.text, tx, top + barH * (hasSub ? 0.36 : 0.52));
        }
        if (asset.subtext) {
          ctx.globalAlpha *= 0.75;
          fitFont(ctx, asset.subtext, w - h * 0.6, barH * 0.26, 500);
          ctx.fillText(asset.subtext, tx, top + barH * 0.74);
        }
        ctx.restore();
      }
      return;
    }
    case "sparkles": {
      const spots: [number, number, number][] = [
        [-0.32, -0.22, 1],
        [0.28, -0.3, 0.7],
        [0.05, 0.05, 1.15],
        [-0.18, 0.32, 0.6],
        [0.36, 0.26, 0.8],
        [-0.42, 0.06, 0.45],
        [0.14, -0.42, 0.5],
      ];
      spots.forEach(([x, y, s], i) => {
        const phase = (t / 2.4 + hash(i)) * TAU;
        const tw = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(phase), 2);
        const size = unit * 0.2 * s * tw;
        ctx.save();
        ctx.translate(x * w, y * h);
        ctx.rotate(((t / 4.8) * TAU) * (i % 2 ? 1 : -1));
        ctx.fillStyle = i % 3 === 1 ? asset.color2 ?? "#ffffff" : asset.color;
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * TAU;
          const rr = k % 2 === 0 ? size : size * 0.22;
          ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });
      return;
    }
    case "confetti": {
      const palette = [asset.color, asset.color2 ?? "#3b82f6", "#facc15", "#22c55e", "#a855f7", "#ffffff"];
      for (let i = 0; i < 46; i++) {
        const cycles = 1 + (i % 2);
        const fall = (((t / LOOP_PERIOD_SEC) * cycles + hash(i * 3.1)) % 1 + 1) % 1;
        const x = (hash(i * 7.7) - 0.5) * w + Math.sin(fall * TAU * 2 + i) * unit * 0.05;
        const y = (fall - 0.5) * h * 1.05;
        const fade = Math.min(1, fall * 8, (1 - fall) * 6);
        ctx.save();
        ctx.globalAlpha *= fade;
        ctx.translate(x, y);
        ctx.rotate((t / LOOP_PERIOD_SEC) * TAU * (i % 3 === 0 ? 2 : -1) + hash(i) * TAU);
        const flip = Math.cos((t / LOOP_PERIOD_SEC) * TAU * 3 + i);
        ctx.scale(1, Math.abs(flip) * 0.9 + 0.1);
        ctx.fillStyle = palette[i % palette.length];
        const s = unit * (0.035 + hash(i * 1.3) * 0.03);
        if (i % 4 === 0) {
          ctx.beginPath();
          ctx.arc(0, 0, s * 0.6, 0, TAU);
          ctx.fill();
        } else {
          ctx.fillRect(-s, -s * 0.45, s * 2, s * 0.9);
        }
        ctx.restore();
      }
      return;
    }
    case "ping": {
      const r = unit / 2;
      for (let k = 0; k < 3; k++) {
        const p = ((t / 1.6 + k / 3) % 1 + 1) % 1;
        ctx.strokeStyle = asset.color;
        ctx.save();
        ctx.globalAlpha *= (1 - p) * 0.9;
        ctx.lineWidth = unit * 0.05 * (1 - p) + 1;
        ctx.beginPath();
        ctx.arc(0, 0, r * (0.25 + 0.72 * easeOutCubic(p)), 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
      const beat = 1 + 0.08 * Math.max(0, Math.sin((t / 1.6) * TAU));
      ctx.fillStyle = asset.color;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.22 * beat, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.arc(-r * 0.06, -r * 0.06, r * 0.07 * beat, 0, TAU);
      ctx.fill();
      return;
    }
    case "spinner": {
      const r = unit * 0.4;
      ctx.lineWidth = unit * 0.1;
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
      const head = (t / 1.2) * TAU;
      const sweep = Math.PI * (0.35 + 0.55 * (0.5 + 0.5 * Math.sin((t / 2.4) * TAU)));
      const g = ctx.createConicGradient ? ctx.createConicGradient(head - sweep, 0, 0) : null;
      if (g) {
        g.addColorStop(0, asset.color2 ?? asset.color);
        g.addColorStop(sweep / TAU, asset.color);
        g.addColorStop(Math.min(1, sweep / TAU + 0.001), "rgba(0,0,0,0)");
      }
      ctx.strokeStyle = g ?? asset.color;
      ctx.beginPath();
      ctx.arc(0, 0, r, head - sweep, head);
      ctx.stroke();
      return;
    }
    case "equalizer": {
      const bars = 7;
      const gap = w * 0.035;
      const bw = (w - gap * (bars - 1)) / bars;
      const paint = paintFor(ctx, asset, w, h);
      for (let i = 0; i < bars; i++) {
        const v =
          0.5 +
          0.22 * Math.sin((t / 1.2) * TAU + i * 1.3) +
          0.16 * Math.sin((t / 0.6) * TAU + i * 2.1) +
          0.1 * Math.sin((t / 2.4) * TAU + i * 0.7);
        const bh = Math.max(bw * 0.6, h * clamp01(v) * reveal);
        const x = -w / 2 + i * (bw + gap);
        ctx.fillStyle = paint;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") ctx.roundRect(x, h / 2 - bh, bw, bh, bw / 2);
        else ctx.rect(x, h / 2 - bh, bw, bh);
        ctx.fill();
      }
      return;
    }
    case "progress": {
      const r = h / 2;
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(-w / 2, -h / 2, w, h, r);
      else ctx.rect(-w / 2, -h / 2, w, h);
      ctx.fill();
      const p = easeInOut(clamp01(duration > 0 ? t / duration : 1));
      const fw = Math.max(h, w * p);
      ctx.save();
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(-w / 2, -h / 2, fw, h, r);
      else ctx.rect(-w / 2, -h / 2, fw, h);
      ctx.clip();
      const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
      g.addColorStop(0, asset.color);
      g.addColorStop(1, asset.color2 ?? asset.color);
      ctx.fillStyle = g;
      ctx.fillRect(-w / 2, -h / 2, fw, h);
      // Moving barber stripes.
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      const stripe = h * 1.2;
      const off = ((t * h * 2) % (stripe * 2)) - stripe * 2;
      for (let x = -w / 2 + off; x < -w / 2 + fw + stripe; x += stripe * 2) {
        ctx.beginPath();
        ctx.moveTo(x, h / 2);
        ctx.lineTo(x + stripe, h / 2);
        ctx.lineTo(x + stripe * 2, -h / 2);
        ctx.lineTo(x + stripe, -h / 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    case "countdown": {
      const r = unit * 0.46;
      const { from, to, steps, stepSec } = countdownPlan(asset, duration);
      const idx = Math.min(steps - 1, Math.max(0, Math.floor(t / stepSec)));
      const n = from + Math.sign(to - from) * idx;
      const done = t >= steps * stepSec;
      const into = t - idx * stepSec;
      const within = done ? 1 : clamp01(into / stepSec);
      ctx.fillStyle = "rgba(17,24,39,0.82)";
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
      ctx.lineWidth = unit * 0.06;
      ctx.strokeStyle = asset.color;
      ctx.beginPath();
      ctx.arc(0, 0, r - unit * 0.03, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - within));
      ctx.stroke();
      // Each new number pops in over a quarter second, whatever the pace.
      const pop = !done && into < 0.25 ? Math.max(0, easeOutBack(into / 0.25)) : 1;
      ctx.save();
      ctx.scale(pop, pop);
      ctx.fillStyle = asset.color2 ?? "#ffffff";
      fitFont(ctx, String(n), r * 1.45, unit * 0.5, 800);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(n), 0, unit * 0.03);
      ctx.restore();
      return;
    }
    case "timer": {
      const secs = Math.max(0, Math.floor(t + (asset.countFrom ?? 0)));
      const hh = Math.floor(secs / 3600);
      const mm = Math.floor((secs % 3600) / 60);
      const ss = secs % 60;
      const pad = (v: number) => String(v).padStart(2, "0");
      const label = hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
      pillPath(ctx, -w / 2, -h / 2, w, h, h / 2);
      ctx.fillStyle = withAlpha(asset.color, 0.88);
      ctx.fill();
      // Stopwatch glyph.
      const cx = -w / 2 + h * 0.5;
      ctx.strokeStyle = asset.color2 ?? "#ffffff";
      ctx.lineWidth = h * 0.07;
      ctx.beginPath();
      ctx.arc(cx, h * 0.03, h * 0.22, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, -h * 0.3);
      ctx.lineTo(cx, -h * 0.24);
      ctx.moveTo(cx, h * 0.03);
      const hand = (secs / 60) * TAU - Math.PI / 2;
      ctx.lineTo(cx + Math.cos(hand) * h * 0.15, h * 0.03 + Math.sin(hand) * h * 0.15);
      ctx.stroke();
      ctx.fillStyle = asset.color2 ?? "#ffffff";
      fitFont(ctx, label, w - h * 1.25, h * 0.5, 700);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, -w / 2 + h * 0.92, h * 0.03);
      return;
    }
    case "subscribe": {
      const pressAt = entranceSeconds(asset, duration) + 1.1;
      const pressed = t >= pressAt && duration > pressAt + 0.4;
      const dip = t >= pressAt && t < pressAt + 0.25 ? 1 - 0.08 * Math.sin(((t - pressAt) / 0.25) * Math.PI) : 1;
      ctx.save();
      ctx.scale(dip, dip);
      pillPath(ctx, -w / 2, -h / 2, w, h, h * 0.22);
      ctx.fillStyle = pressed ? "#3f3f46" : asset.color;
      ctx.fill();
      const iconX = -w / 2 + h * 0.55;
      if (pressed) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = h * 0.09;
        tracePath(ctx, partialPts([[iconX - h * 0.17, 0], [iconX - h * 0.04, h * 0.13], [iconX + h * 0.2, -h * 0.14]], clamp01((t - pressAt) / 0.3)));
        ctx.stroke();
      } else {
        ctx.fillStyle = "#ffffff";
        pillPath(ctx, iconX - h * 0.24, -h * 0.17, h * 0.48, h * 0.34, h * 0.09);
        ctx.fill();
        ctx.fillStyle = asset.color;
        ctx.beginPath();
        ctx.moveTo(iconX - h * 0.06, -h * 0.09);
        ctx.lineTo(iconX + h * 0.1, 0);
        ctx.lineTo(iconX - h * 0.06, h * 0.09);
        ctx.closePath();
        ctx.fill();
      }
      const label = (pressed ? asset.subtext : asset.text) ?? "";
      ctx.fillStyle = "#ffffff";
      fitFont(ctx, label, w - h * 1.25, h * 0.4, 700);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, -w / 2 + h * 0.98, h * 0.02);
      ctx.restore();
      // A cursor glides in and clicks it.
      const arrive = clamp01((t - (pressAt - 0.6)) / 0.6);
      const leave = clamp01((t - (pressAt + 0.5)) / 0.4);
      if (arrive > 0 && leave < 1 && duration > pressAt + 0.4) {
        const e = easeOutCubic(arrive);
        ctx.save();
        ctx.globalAlpha *= 1 - leave;
        drawCursorArrow(ctx, w * 0.45 - (w * 0.45 - w * 0.1) * e, h * 0.9 - h * 0.9 * e + h * 0.05, h * 0.55 * (t >= pressAt && t < pressAt + 0.2 ? 0.88 : 1));
        ctx.restore();
      }
      return;
    }
    case "badge": {
      pillPath(ctx, -w / 2, -h / 2, w, h, h * 0.3);
      ctx.fillStyle = paintFor(ctx, asset, w, h);
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fillRect(-w / 2, -h / 2, w, h * 0.45);
      ctx.restore();
      const label = asset.text ?? "";
      ctx.fillStyle = "#ffffff";
      fitFont(ctx, label, w * 0.8, h * 0.55, 900);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 0, h * 0.03);
      return;
    }
    case "pin": {
      const label = asset.text ?? "";
      const pinW = Math.min(h * 0.8, w);
      const cx = label ? -w / 2 + pinW / 2 : 0;
      const head = pinW * 0.42;
      const cy = -h / 2 + head + h * 0.04;
      ctx.fillStyle = asset.color;
      ctx.beginPath();
      ctx.arc(cx, cy, head, Math.PI * 0.8, Math.PI * 2.2);
      ctx.lineTo(cx, h / 2 - h * 0.04);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, head * 0.4, 0, TAU);
      ctx.fill();
      if (label) {
        const lx = -w / 2 + pinW + h * 0.08;
        const lw = w / 2 - lx;
        const lh = h * 0.46;
        // The label unrolls from the pin once it has landed.
        const unroll = clamp01(reveal * 1.6 - 0.6);
        if (unroll > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(lx, -h / 2, lw * easeOutCubic(unroll), h);
          ctx.clip();
          pillPath(ctx, lx, cy - lh / 2, lw, lh, lh / 2);
          ctx.fillStyle = "rgba(255,255,255,0.96)";
          ctx.fill();
          ctx.fillStyle = "#111827";
          fitFont(ctx, label, lw - lh * 0.8, lh * 0.5, 700);
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(label, lx + lh * 0.4, cy + lh * 0.03);
          ctx.restore();
        }
      }
      return;
    }
    case "cursor": {
      const p = (t % 2.4) / 2.4;
      if (p > 0.45) {
        const q = clamp01((p - 0.45) / 0.45);
        ctx.save();
        ctx.globalAlpha *= 1 - q;
        ctx.fillStyle = withAlpha(asset.color, 0.35);
        ctx.beginPath();
        ctx.arc(0, 0, unit * 0.22 * easeOutCubic(q), 0, TAU);
        ctx.fill();
        ctx.strokeStyle = asset.color;
        ctx.lineWidth = unit * 0.035;
        ctx.beginPath();
        ctx.arc(0, 0, unit * 0.46 * easeOutCubic(q), 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
      const approach = easeInOut(clamp01(p / 0.42));
      const back = easeInOut(clamp01((p - 0.8) / 0.2));
      const off = unit * 0.16 * (1 - approach + back);
      const press = p > 0.43 && p < 0.53 ? 0.85 : 1;
      drawCursorArrow(ctx, off, off, unit * 0.42 * press);
      return;
    }
    case "chevrons": {
      for (let i = 0; i < 3; i++) {
        const phase = ((((t / 1.2 - i / 3) % 1) + 1) % 1);
        const a = 0.25 + 0.75 * Math.pow(Math.max(0, Math.cos(phase * TAU)), 3);
        const cx = -w / 2 + (w * (i + 0.5)) / 3;
        ctx.save();
        ctx.globalAlpha *= a * clamp01(reveal * 3 - i);
        ctx.strokeStyle = asset.color;
        ctx.lineWidth = unit * 0.14;
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.07, -h * 0.34);
        ctx.lineTo(cx + w * 0.07, 0);
        ctx.lineTo(cx - w * 0.07, h * 0.34);
        ctx.stroke();
        ctx.restore();
      }
      return;
    }
    case "bell": {
      const s = unit / 2;
      const p = t % 2.4;
      const swing = p < 0.8 ? Math.sin((p / 0.8) * TAU * 3) * 0.32 * (1 - p / 0.8) : 0;
      ctx.save();
      ctx.translate(0, -0.6 * s);
      ctx.rotate(swing);
      ctx.translate(0, 0.6 * s);
      ctx.fillStyle = asset.color;
      ctx.beginPath();
      ctx.moveTo(-0.66 * s, 0.4 * s);
      ctx.quadraticCurveTo(-0.5 * s, 0.26 * s, -0.5 * s, -0.04 * s);
      ctx.bezierCurveTo(-0.5 * s, -0.6 * s, 0.5 * s, -0.6 * s, 0.5 * s, -0.04 * s);
      ctx.quadraticCurveTo(0.5 * s, 0.26 * s, 0.66 * s, 0.4 * s);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(swing * -0.4 * s, 0.53 * s, 0.13 * s, 0, TAU);
      ctx.arc(0, -0.6 * s, 0.09 * s, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = "#ef4444";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 0.06 * s;
      ctx.beginPath();
      ctx.arc(0.46 * s, -0.46 * s, 0.17 * s, 0, TAU);
      ctx.fill();
      ctx.stroke();
      return;
    }
    case "like": {
      const p = (t % 2.4) / 2.4;
      const q = clamp01((p - 0.06) / 0.5);
      if (q > 0 && q < 1) {
        ctx.save();
        ctx.globalAlpha *= 1 - q;
        ctx.strokeStyle = asset.color2 ?? asset.color;
        ctx.lineWidth = unit * 0.03 * (1 - q) + 1;
        ctx.beginPath();
        ctx.arc(0, 0, unit * (0.22 + 0.26 * easeOutCubic(q)), 0, TAU);
        ctx.stroke();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * TAU + 0.3;
          const rr = unit * (0.26 + 0.22 * easeOutCubic(q));
          ctx.fillStyle = i % 2 ? asset.color : asset.color2 ?? asset.color;
          ctx.beginPath();
          ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr, unit * 0.035 * (1 - q) + 0.5, 0, TAU);
          ctx.fill();
        }
        ctx.restore();
      }
      const beat = p < 0.2 ? 0.7 + 0.3 * easeOutBack(p / 0.2) : 1;
      const hs = unit * 0.56 * beat;
      tracePath(ctx, heartPts(hs, hs));
      ctx.closePath();
      ctx.fillStyle = asset.color;
      ctx.fill();
      return;
    }
    case "typing": {
      const bh = h * 0.82;
      pillPath(ctx, -w / 2, -h / 2, w, bh, bh / 2);
      ctx.fillStyle = asset.color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(-w / 2 + bh * 0.2, h / 2 - h * 0.08, h * 0.08, 0, TAU);
      ctx.fill();
      ctx.fillStyle = asset.color2 ?? "#6b7280";
      for (let i = 0; i < 3; i++) {
        const lift = Math.max(0, Math.sin((t / 1.2 - i * 0.15) * TAU));
        ctx.beginPath();
        ctx.arc((i - 1) * w * 0.2, -h / 2 + bh / 2 - bh * 0.18 * lift, bh * 0.11, 0, TAU);
        ctx.fill();
      }
      return;
    }
    case "rec": {
      pillPath(ctx, -w / 2, -h / 2, w, h, h / 2);
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fill();
      if (blinkOn(t)) {
        ctx.fillStyle = asset.color;
        ctx.beginPath();
        ctx.arc(-w / 2 + h * 0.5, 0, h * 0.2, 0, TAU);
        ctx.fill();
      }
      const label = asset.text ?? "";
      ctx.fillStyle = "#ffffff";
      fitFont(ctx, label, w - h * 1.2, h * 0.46, 800);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, -w / 2 + h * 0.88, h * 0.03);
      return;
    }
    case "viewfinder": {
      const inset = unit * 0.07;
      const len = unit * 0.12;
      const x0 = -w / 2 + inset;
      const y0 = -h / 2 + inset;
      const x1 = w / 2 - inset;
      const y1 = h / 2 - inset;
      ctx.strokeStyle = asset.color;
      ctx.lineWidth = Math.max(2, unit * 0.008);
      ctx.lineCap = "square";
      ctx.beginPath();
      for (const [cx, cy, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
        ctx.moveTo(cx, cy + dy * len);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + dx * len, cy);
      }
      const c = unit * 0.03;
      ctx.moveTo(-c, 0);
      ctx.lineTo(c, 0);
      ctx.moveTo(0, -c);
      ctx.lineTo(0, c);
      ctx.stroke();
      const fs = unit * 0.045;
      ctx.font = `700 ${fs}px ${FONT_STACK}`;
      ctx.textBaseline = "middle";
      if (blinkOn(t)) {
        ctx.fillStyle = asset.color2 ?? "#ef4444";
        ctx.beginPath();
        ctx.arc(x0 + len * 0.3 + fs * 0.4, y0 + len * 0.45, fs * 0.36, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = asset.color;
      ctx.textAlign = "left";
      ctx.fillText("REC", x0 + len * 0.3 + fs * 1.05, y0 + len * 0.45);
      if (asset.text) {
        ctx.textAlign = "right";
        ctx.fillText(asset.text, x1 - len * 0.3, y0 + len * 0.45);
      }
      return;
    }
    case "reveal": {
      // Two black curtains parting from the middle line.
      const band = easeInOut(reveal) * (h / 2);
      ctx.fillStyle = asset.color;
      ctx.fillRect(-w / 2, -h / 2, w, h / 2 - band);
      ctx.fillRect(-w / 2, band, w, h / 2 - band);
      return;
    }
    case "letterbox": {
      const bar = Math.max(h * 0.06, (h - w / 2.39) / 2) * easeInOut(reveal);
      ctx.fillStyle = asset.color;
      ctx.fillRect(-w / 2, -h / 2, w, bar);
      ctx.fillRect(-w / 2, h / 2 - bar, w, bar);
      return;
    }
    case "vignette": {
      const g = ctx.createRadialGradient(0, 0, Math.min(w, h) * 0.32, 0, 0, Math.hypot(w, h) / 2);
      g.addColorStop(0, withAlpha(asset.color, 0));
      g.addColorStop(0.55, withAlpha(asset.color, 0.35));
      g.addColorStop(1, withAlpha(asset.color, 0.9));
      ctx.fillStyle = g;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      return;
    }
    case "bokeh": {
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 22; i++) {
        const rise = ((((t / LOOP_PERIOD_SEC) + hash(i * 2.3)) % 1) + 1) % 1;
        const x = (hash(i * 5.1) - 0.5) * w * 1.05 + Math.sin((t / LOOP_PERIOD_SEC) * TAU + i) * w * 0.03;
        const y = (0.5 - rise) * h * 1.2;
        const r = unit * (0.04 + hash(i * 3.7) * 0.1);
        const tw = 0.55 + 0.45 * Math.sin((t / 2.4) * TAU + i * 1.7);
        const col = i % 2 ? asset.color : asset.color2 ?? asset.color;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, withAlpha(col, 0.42 * tw));
        g.addColorStop(0.7, withAlpha(col, 0.28 * tw));
        g.addColorStop(1, withAlpha(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = prev;
      return;
    }
    case "snow": {
      ctx.fillStyle = asset.color;
      for (let i = 0; i < 120; i++) {
        const depth = hash(i * 1.9);
        const cycles = 1 + (i % 3);
        const fall = ((((t / LOOP_PERIOD_SEC) * cycles + hash(i * 5.3)) % 1) + 1) % 1;
        const x = (hash(i * 9.7) - 0.5) * w * 1.04 + Math.sin((t / LOOP_PERIOD_SEC) * TAU * 2 + i) * unit * 0.02 * (1 + depth);
        const y = (fall - 0.5) * h * 1.04;
        ctx.save();
        ctx.globalAlpha *= 0.45 + 0.55 * depth;
        ctx.beginPath();
        ctx.arc(x, y, unit * (0.002 + 0.007 * depth), 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      return;
    }
    case "guides": {
      // Four edges, each running on past its corners, drawn one after another.
      const over = unit * 0.12;
      const x0 = -w / 2 + over;
      const y0 = -h / 2 + over;
      const x1 = w / 2 - over;
      const y1 = h / 2 - over;
      const lines: [Pt, Pt][] = [
        [[x0 - over, y0], [x1 + over * 0.4, y0]],
        [[x1, y0 - over], [x1, y1 + over * 0.4]],
        [[x1 + over, y1], [x0 - over * 0.4, y1]],
        [[x0, y1 + over], [x0, y0 - over * 0.4]],
      ];
      ctx.strokeStyle = asset.color;
      ctx.lineWidth = Math.max(1.5, unit * 0.007);
      ctx.lineCap = "square";
      lines.forEach(([[ax, ay], [bx, by]], k) => {
        const f = clamp01(reveal * 4 - k * 0.75);
        if (f <= 0) return;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax + (bx - ax) * f, ay + (by - ay) * f);
        ctx.stroke();
      });
      return;
    }
    case "neon": {
      // A neon tube: a wide soft glow, the coloured tube, a near-white core - drawing itself on.
      const inset = unit * 0.09;
      const pts = roundedRectPts(w - 2 * inset, h - 2 * inset, unit * 0.14);
      const shown = partialPts(pts, reveal);
      if (shown.length < 2) return;
      const tube = Math.max(2, unit * 0.035);
      ctx.save();
      ctx.shadowColor = asset.color;
      ctx.shadowBlur = unit * 0.12;
      ctx.strokeStyle = asset.color;
      ctx.lineWidth = tube;
      tracePath(ctx, shown);
      ctx.stroke();
      ctx.shadowBlur = unit * 0.04;
      tracePath(ctx, shown);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = withAlpha(asset.color2 ?? "#ffffff", 0.9);
      ctx.lineWidth = Math.max(1, tube * 0.35);
      tracePath(ctx, shown);
      ctx.stroke();
      return;
    }
    case "halo": {
      // A glowing ellipse with a bright arc running round it.
      const rx = w * 0.42;
      const ry = h * 0.36;
      const lw = Math.max(2, unit * 0.06);
      ctx.save();
      ctx.shadowColor = asset.color;
      ctx.shadowBlur = unit * 0.25;
      ctx.strokeStyle = withAlpha(asset.color, 0.85);
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, -Math.PI / 2, -Math.PI / 2 + TAU * reveal);
      ctx.stroke();
      ctx.restore();
      if (reveal >= 1) {
        const a = (t / 2.4) * TAU;
        ctx.save();
        ctx.shadowColor = asset.color2 ?? asset.color;
        ctx.shadowBlur = unit * 0.2;
        ctx.strokeStyle = asset.color2 ?? "#ffffff";
        ctx.lineWidth = lw * 1.4;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, a, a + 0.9);
        ctx.stroke();
        ctx.restore();
      }
      return;
    }
    case "filmstrip": {
      // Perforated strips down the long sides (across the top and bottom of a wide frame), the
      // holes rolling through, an amber edge print.
      const tall = h >= w;
      const along = tall ? h : w;
      const across = tall ? w : h;
      const sw = Math.max(w, h) * 0.05;
      const holeW = sw * 0.42;
      const holeL = sw * 0.6;
      const pitch = sw * 1.15;
      // Two pitches per 2.4s - a whole number of holes per loop, so it loops seamlessly.
      const roll = ((t / 2.4) % 1) * pitch * 2;
      for (const side of [-1, 1]) {
        ctx.save();
        // In this frame the strip runs top to bottom at x = cx.
        if (!tall) ctx.rotate(Math.PI / 2);
        const cx = side * (across / 2 - sw / 2);
        ctx.fillStyle = asset.color;
        ctx.fillRect(cx - sw / 2, -along / 2, sw, along);
        ctx.fillStyle = asset.color2 ?? "#ecebe6";
        const hx = cx - holeW / 2 + side * sw * 0.12;
        for (let y = -along / 2 - pitch * 2 + roll; y < along / 2 + pitch; y += pitch) {
          pillPath(ctx, hx, y, holeW, holeL, holeW * 0.22);
          ctx.fill();
        }
        if (asset.text) {
          ctx.save();
          ctx.translate(cx - side * sw * 0.3, 0);
          ctx.rotate((side * Math.PI) / 2);
          ctx.font = `600 ${sw * 0.2}px ${FONT_STACK}`;
          ctx.fillStyle = "rgba(245,158,11,0.75)";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const label = `${asset.text}   ▸ ${side > 0 ? 13 : 12}`;
          // Repeats along the strip, rolling with the holes (a whole number of repeats per loop).
          const step = along / Math.max(1, Math.round(along / Math.max(ctx.measureText(label).width * 2.2, along * 0.3)));
          const shift = ((t / 2.4) % 1) * step;
          for (let q = -along / 2 - step; q < along / 2 + step; q += step) ctx.fillText(label, side * (q + shift), 0);
          ctx.restore();
        }
        ctx.restore();
      }
      return;
    }
    case "film35": {
      // A 35mm negative's frame: a black surround with a rounded window, sprocket holes along the
      // long edges, edge print in amber.
      const tall = h >= w;
      const band = Math.min(w, h) * 0.11;
      const side = Math.min(w, h) * 0.045;
      const winW = w - 2 * (tall ? band : side);
      const winH = h - 2 * (tall ? side : band);
      ctx.fillStyle = asset.color;
      ctx.beginPath();
      ctx.rect(-w / 2, -h / 2, w, h);
      if (typeof ctx.roundRect === "function") ctx.roundRect(-winW / 2, -winH / 2, winW, winH, Math.min(winW, winH) * 0.025);
      else ctx.rect(-winW / 2, -winH / 2, winW, winH);
      ctx.fill("evenodd");
      const along = tall ? h : w;
      const holeA = band * 0.3;
      const holeB = band * 0.2;
      const pitch = band * 0.55;
      ctx.fillStyle = "#e7e5df";
      for (const s2 of [-1, 1]) {
        const c = s2 * ((tall ? w : h) / 2 - band * 0.3);
        for (let a = -along / 2 + pitch / 2; a < along / 2; a += pitch) {
          if (tall) pillPath(ctx, c - holeB / 2, a, holeB, holeA, holeB * 0.25);
          else pillPath(ctx, a, c - holeB / 2, holeA, holeB, holeB * 0.25);
          ctx.fill();
        }
      }
      if (asset.text) {
        ctx.save();
        ctx.fillStyle = withAlpha(asset.color2 ?? "#f59e0b", 0.9);
        ctx.font = `700 ${band * 0.17}px ${FONT_STACK}`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        if (tall) {
          ctx.translate(-w / 2 + band * 0.72, 0);
          ctx.rotate(-Math.PI / 2);
        } else ctx.translate(0, -h / 2 + band * 0.72);
        ctx.fillText(asset.text, -along * 0.22, 0);
        ctx.fillText(asset.text.replace(/\d+/, (n) => String(Number(n) + 1)), along * 0.25, 0);
        ctx.restore();
      }
      return;
    }
    case "retro": {
      // An old slide / TV frame: rounded window, dark surround, edges falling off into it.
      const inset = unit * 0.035;
      const ww2 = w - 2 * inset;
      const hh2 = h - 2 * inset;
      const r = unit * 0.09;
      const windowPath = (grow = 0) => {
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") ctx.roundRect(-ww2 / 2 - grow, -hh2 / 2 - grow, ww2 + 2 * grow, hh2 + 2 * grow, r);
        else ctx.rect(-ww2 / 2 - grow, -hh2 / 2 - grow, ww2 + 2 * grow, hh2 + 2 * grow);
      };
      ctx.fillStyle = asset.color;
      windowPath();
      ctx.rect(-w / 2, -h / 2, w, h);
      ctx.fill("evenodd");
      // The inner falloff: the window's edge shadowed inwards, the corners darker.
      ctx.save();
      windowPath();
      ctx.clip();
      ctx.shadowColor = withAlpha(asset.color, 0.85);
      ctx.shadowBlur = unit * 0.08;
      ctx.lineWidth = unit * 0.05;
      ctx.strokeStyle = asset.color;
      windowPath(unit * 0.025);
      ctx.stroke();
      ctx.shadowColor = "transparent";
      const g = ctx.createRadialGradient(0, 0, Math.min(ww2, hh2) * 0.45, 0, 0, Math.hypot(ww2, hh2) / 2);
      g.addColorStop(0, withAlpha(asset.color, 0));
      g.addColorStop(1, withAlpha(asset.color, 0.45));
      ctx.fillStyle = g;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
      return;
    }
    case "polaroid": {
      const side = unit * 0.055;
      const bottom = unit * 0.2;
      const winW = w - 2 * side;
      const winH = h - side - bottom;
      const top = -h / 2 + side;
      ctx.fillStyle = asset.color;
      ctx.beginPath();
      ctx.rect(-w / 2, -h / 2, w, h);
      ctx.rect(-winW / 2, top, winW, winH);
      ctx.fill("evenodd");
      // A faint inner edge where the print meets the border.
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.lineWidth = Math.max(1, unit * 0.004);
      ctx.strokeRect(-winW / 2, top, winW, winH);
      if (asset.text) {
        ctx.fillStyle = asset.color2 ?? "#3f3f46";
        ctx.font = `400 ${bottom * 0.34}px "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(asset.text, 0, h / 2 - bottom / 2, winW * 0.9);
      }
      return;
    }
    case "lightleak": {
      // Warm leaks breathing in from the edges - soft blobs drifting along them, added on.
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = "lighter";
      // edge angle (rad), turns per loop, size, second colour?, phase
      const blobs: [number, number, number, boolean, number][] = [
        [Math.PI * 0.95, 1, 0.75, false, 0],
        [Math.PI * 0.1, 1, 0.6, true, 0.33],
        [Math.PI * 1.55, 2, 0.5, false, 0.66],
        [Math.PI * 0.55, 1, 0.45, true, 0.2],
      ];
      for (const [base, speed, size, second, phase] of blobs) {
        const u = (t / LOOP_PERIOD_SEC) * speed + phase;
        const a = base + Math.sin(u * TAU) * 0.35;
        const x = Math.cos(a) * w * 0.55;
        const y = Math.sin(a) * h * 0.55;
        const r = Math.max(w, h) * size;
        const breathe = 0.55 + 0.45 * Math.sin((u + 0.25) * TAU);
        const col = second ? asset.color2 ?? asset.color : asset.color;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, withAlpha(col, 0.55 * breathe));
        g.addColorStop(0.35, withAlpha(col, 0.28 * breathe));
        g.addColorStop(1, withAlpha(col, 0));
        ctx.fillStyle = g;
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }
      ctx.globalCompositeOperation = prev;
      return;
    }
    case "grain": {
      ctx.drawImage(grainCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), grainFrame(t)), -w / 2, -h / 2, w, h);
      return;
    }
    case "twinkle": {
      // Glints across the frame, each flaring and fading on its own beat.
      for (let i = 0; i < 34; i++) {
        const x = (hash(i * 4.7) - 0.5) * w * 0.96;
        const y = (hash(i * 9.1 + 2) - 0.5) * h * 0.96;
        const period = [1.2, 1.6, 2.4][i % 3];
        const ph = (t / period + hash(i * 1.3)) % 1;
        const flare = Math.pow(Math.max(0, Math.sin(ph * Math.PI)), 3);
        if (flare < 0.02) continue;
        const r = unit * (0.012 + 0.03 * hash(i * 6.1)) * (0.4 + 0.6 * flare);
        const col = i % 4 === 0 ? asset.color2 ?? asset.color : asset.color;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ph * 0.6);
        ctx.globalAlpha *= flare;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.6);
        g.addColorStop(0, withAlpha(col, 0.9));
        g.addColorStop(1, withAlpha(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.6, 0, TAU);
        ctx.fill();
        // A four-point star.
        ctx.fillStyle = col;
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const rr = k % 2 === 0 ? r * 2.2 : r * 0.22;
          const ang = (k * Math.PI) / 4;
          ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      return;
    }
    default:
      return;
  }
}

// Film grain patterns, by size and frame: light and dark specks at random, a few dust motes and now
// and then a scratch - drawn once per pattern and reused.
const grainCache = new Map<string, HTMLCanvasElement>();
function grainCanvas(w: number, h: number, frame: number): HTMLCanvasElement {
  const key = `${w}x${h}#${frame}`;
  const cached = grainCache.get(key);
  if (cached) return cached;
  // Grain a couple of pixels across at 1080p, whatever the size.
  const cell = Math.max(1, Math.round(Math.min(w, h) / 540));
  const gw = Math.max(1, Math.ceil(w / cell));
  const gh = Math.max(1, Math.ceil(h / cell));
  const small = document.createElement("canvas");
  small.width = gw;
  small.height = gh;
  const ctx = small.getContext("2d")!;
  const img = ctx.createImageData(gw, gh);
  // xorshift, seeded by the pattern number - the same grain every time.
  let seed = ((frame + 1) * 2654435761) >>> 0 || 1;
  const rand = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < gw * gh; i++) {
    const v = rand();
    const c = v > 0.5 ? 255 : 0;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = c;
    img.data[i * 4 + 3] = Math.round(Math.abs(v - 0.5) * 2 * 34);
  }
  ctx.putImageData(img, 0, 0);
  for (let k = 0; k < 6; k++) {
    ctx.fillStyle = rand() > 0.5 ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.arc(rand() * gw, rand() * gh, 0.6 + rand() * 1.6, 0, TAU);
    ctx.fill();
  }
  if (frame % 3 === 0) {
    const x = rand() * gw;
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + (rand() - 0.5) * 6, gh);
    ctx.stroke();
  }
  // Scaled up without smoothing, so the grain stays crisp.
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d")!;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(small, 0, 0, w, h);
  grainCache.set(key, out);
  if (grainCache.size > GRAIN_FRAMES * 2) grainCache.delete(grainCache.keys().next().value!);
  return out;
}

// ---------- effects ----------

interface EffectState {
  alpha: number;
  scale: number;
  // Horizontal squash on top of `scale` (a flip turning edge-on; negative shows its back).
  scaleX: number;
  rotate: number;
  dx: number;
  dy: number;
  reveal: number; // draw-on progress
  wipe: number; // 1 = fully uncovered
  glitch: number; // 0..1 strength
}

function effectState(asset: OverlayAsset, w: number, h: number, t: number, duration: number): EffectState {
  const unit = Math.min(w, h);
  const s: EffectState = { alpha: 1, scale: 1, scaleX: 1, rotate: 0, dx: 0, dy: 0, reveal: 1, wipe: 1, glitch: 0 };
  const e = entranceSeconds(asset, duration);
  // How far "in" the element is: 0 -> 1 entering, 1 -> 0 leaving (when exit is on).
  let r = e > 0 ? clamp01(t / e) : 1;
  if (asset.exit && e > 0) r = Math.min(r, clamp01((duration - t) / e));

  // Some elements build themselves even with no chosen entrance.
  const selfDrawn = ["check", "cross", "lower-third", "equalizer", "pin", "chevrons", "letterbox", "reveal"].includes(asset.kind) || STROKE_SHAPES.has(asset.kind);

  switch (asset.entrance) {
    case "pop":
      s.scale = r >= 1 ? 1 : Math.max(0, easeOutBack(r));
      s.alpha = clamp01(r * 4);
      if (selfDrawn) s.reveal = r;
      break;
    case "draw":
      s.reveal = easeInOut(r);
      break;
    case "zoom":
      s.scale = 2.4 - 1.4 * easeOutCubic(r);
      s.alpha = easeOutCubic(r);
      if (selfDrawn) s.reveal = r;
      break;
    case "spin":
      s.scale = easeOutBack(r);
      s.rotate = (1 - easeOutCubic(r)) * -Math.PI * 1.5;
      s.alpha = clamp01(r * 3);
      if (selfDrawn) s.reveal = r;
      break;
    case "drop":
      s.dy = -(1 - easeOutBounce(r)) * unit * 0.6;
      s.alpha = clamp01(r * 5);
      if (selfDrawn) s.reveal = r;
      break;
    case "wipe":
      s.wipe = easeInOut(r);
      if (selfDrawn) s.reveal = easeOutCubic(r);
      break;
    case "flip":
      // A coin toss: one and a half turns about the vertical axis, landing face up, a little
      // overshoot in size as it lands.
      s.scaleX = Math.cos((1 - easeOutCubic(r)) * Math.PI * 3);
      s.scale = r >= 1 ? 1 : Math.max(0, easeOutBack(r));
      s.alpha = clamp01(r * 4);
      if (selfDrawn) s.reveal = r;
      break;
    case "glitch":
      s.glitch = r >= 1 ? 0 : 1 - r;
      s.alpha = r < 1 ? (hash(Math.floor(t * 30)) > 0.25 + 0.6 * (1 - r) ? 1 : 0.25) : 1;
      if (selfDrawn) s.reveal = r;
      break;
    default:
      break;
  }

  // Loops - every period divides LOOP_PERIOD_SEC.
  switch (asset.loop) {
    case "pulse":
      s.scale *= 1 + 0.07 * Math.sin((t / 1.2) * TAU);
      break;
    case "float":
      s.dy += Math.sin((t / 2.4) * TAU) * unit * 0.06;
      s.rotate += Math.sin((t / 4.8) * TAU) * 0.05;
      break;
    case "spin":
      s.rotate += (t / 4.8) * TAU;
      break;
    case "wiggle": {
      const p = (t % 2.4) / 2.4;
      s.rotate += p < 0.3 ? Math.sin((p / 0.3) * TAU * 2) * 0.12 * (1 - p / 0.3) : 0;
      break;
    }
    default:
      break;
  }
  return s;
}

export interface AssetDrawOptions {
  rotationDeg?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  shadow?: boolean;
}

// Draws the element at `t` seconds into its life onto `ctx`, whose origin is already at the box's
// centre, box w x h in pixels. Shared by preview and export - see this file's header.
export function drawAssetFrame(ctx: CanvasRenderingContext2D, asset: OverlayAsset, w: number, h: number, t: number, duration: number, opts: AssetDrawOptions = {}): void {
  if (w <= 0 || h <= 0) return;
  const unit = Math.min(w, h);
  const s = effectState(asset, w, h, t, duration);
  if (s.alpha <= 0 || s.scale <= 0.001 || Math.abs(s.scale * s.scaleX) <= 0.001) return;

  ctx.save();
  if (opts.rotationDeg) ctx.rotate((opts.rotationDeg * Math.PI) / 180);
  ctx.translate(s.dx, s.dy);
  if (s.glitch > 0) ctx.translate((hash(Math.floor(t * 30) * 1.7) - 0.5) * unit * 0.18 * s.glitch, 0);
  ctx.rotate(s.rotate);
  ctx.scale(s.scale * s.scaleX * (opts.flipHorizontal ? -1 : 1), s.scale * (opts.flipVertical ? -1 : 1));
  ctx.globalAlpha *= s.alpha;

  if (s.wipe < 1) {
    const m = assetMarginPx(w, h, asset.kind);
    ctx.beginPath();
    ctx.rect(-w / 2 - m, -h / 2 - m, (w + 2 * m) * s.wipe, h + 2 * m);
    ctx.clip();
  }

  const filters: string[] = [];
  if (asset.loop === "hue") filters.push(`hue-rotate(${Math.round((t / LOOP_PERIOD_SEC) * 360)}deg)`);
  if (filters.length) ctx.filter = filters.join(" ");

  const glowPulse = asset.loop === "glow" ? 0.5 + 0.5 * Math.sin((t / 1.6) * TAU) : 0;
  if (asset.glow || asset.loop === "glow") {
    ctx.shadowColor = asset.color;
    ctx.shadowBlur = unit * (asset.glow ? 0.18 : 0.08) + unit * 0.22 * glowPulse;
  } else if (opts.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = Math.max(6, unit * 0.08);
    ctx.shadowOffsetY = Math.max(3, unit * 0.03);
  }

  if (s.glitch > 0) {
    // RGB-split ghosts behind the real thing while glitching in.
    const split = unit * 0.06 * s.glitch;
    for (const [color, off] of [["rgba(255,0,80,0.55)", -split], ["rgba(0,230,255,0.55)", split]] as const) {
      ctx.save();
      ctx.translate(off, 0);
      ctx.globalAlpha *= 0.8;
      drawElement(ctx, { ...asset, color, color2: undefined }, w, h, t, duration, s.reveal);
      ctx.restore();
    }
  }

  drawElement(ctx, asset, w, h, t, duration, s.reveal);
  ctx.shadowColor = "transparent";
  ctx.filter = "none";

  if (asset.loop === "shimmer") {
    // A bright band sweeping across whatever was just drawn (source-atop keeps it on the element).
    const p = ((t % 2.4) / 2.4) * 1.8 - 0.4;
    const bx = -w / 2 + p * w;
    const band = Math.max(w, h) * 0.35;
    const g = ctx.createLinearGradient(bx - band, -h / 2, bx + band, h / 2);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = g;
    const m = assetMarginPx(w, h, asset.kind);
    ctx.fillRect(-w / 2 - m, -h / 2 - m, w + 2 * m, h + 2 * m);
    ctx.globalCompositeOperation = prev;
  }

  if (s.glitch > 0.15) {
    // Tear a couple of horizontal slices sideways.
    const canvas = ctx.canvas;
    const k = Math.floor(t * 30);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < 3; i++) {
      const sh = Math.max(2, Math.floor(canvas.height * 0.05 * hash(k + i * 9.1)));
      const sy = Math.floor(canvas.height * hash(k * 2.3 + i));
      const shift = Math.round((hash(k * 5.7 + i) - 0.5) * unit * 0.4 * s.glitch);
      if (sy + sh > canvas.height) continue;
      try {
        const slice = ctx.getImageData(0, sy, canvas.width, sh);
        ctx.clearRect(0, sy, canvas.width, sh);
        ctx.putImageData(slice, shift, sy);
      } catch {
        // Ignore - a tainted or zero-size canvas just skips the tear.
      }
    }
  }
  ctx.restore();
}

// ---------- export ----------

// Which distinct picture frame k (of `total`) is - equal keys mean identical frames, so export
// only renders and ships each key once. Entering/leaving frames are always unique; after that a
// still element is one frame, a looping one repeats every LOOP_PERIOD_SEC, and a timed one
// (progress, countdown) is different every frame. `fps`: the rate frames are drawn at.
export function assetFrameKey(asset: OverlayAsset, k: number, total: number, duration: number, fps = ASSET_FPS): string {
  const entry = assetEntry(asset.kind);
  const e = Math.ceil(entranceSeconds(asset, duration) * fps);
  const x = asset.exit ? e : 0;
  const settled = Math.max(e, Math.ceil((entry.settleSec ?? 0) * fps));
  if (k < settled || k >= total - x) return `f${k}`;
  // A glitch's tear reads pixels from the canvas, so it can't be keyed - but it only runs while entering.
  if (entry.idleKey && asset.loop === "none") return `i${entry.idleKey(asset, k / fps, duration)}`;
  const motion = entry.motion;
  const loops = asset.loop !== "none" || motion === "periodic";
  if (motion === "timed") return `f${k}`;
  if (!loops) return "still";
  return `p${k % Math.round(LOOP_PERIOD_SEC * fps)}`;
}

export interface RenderedAssetFrames {
  unique: string[];
  sequence: number[];
  // Top-left of every frame in output pixels (each frame is the box plus its margin, rotated).
  xPx: number;
  yPx: number;
}

// Renders an asset overlay to the PNG frame sequence export_trimmed_video burns in (OverlayFrames,
// conversion.rs). The box's own opacity is baked in here; fade/slide animation and keyframes are
// applied on top by ffmpeg exactly as for a picture.
export async function renderAssetFrames(
  overlay: { asset?: OverlayAsset; x: number; y: number; width: number; height: number; opacity: number; rotation?: number; flipHorizontal?: boolean; flipVertical?: boolean; shadow?: boolean; startTime: number; endTime: number },
  framePixelWidth: number,
  framePixelHeight: number,
  // The export's overlay rate (get_export_frame_rate).
  fps = ASSET_FPS
): Promise<RenderedAssetFrames | null> {
  const asset = overlay.asset;
  if (!asset) return null;
  const w = overlay.width * framePixelWidth;
  const h = overlay.height * framePixelHeight;
  const duration = overlay.endTime - overlay.startTime;
  if (w <= 0 || h <= 0 || duration <= 0) return null;

  const m = assetMarginPx(w, h, asset.kind);
  const rad = ((overlay.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const bw = w + 2 * m;
  const bh = h + 2 * m;
  // Even dimensions keep ffmpeg's yuv420 overlay maths happy.
  const cw = Math.max(2, Math.ceil((bw * cos + bh * sin) / 2) * 2);
  const ch = Math.max(2, Math.ceil((bw * sin + bh * cos) / 2) * 2);

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: asset.entrance === "glitch" });
  if (!ctx) return null;

  // A sticker's face and picture have to be in before the first frame is drawn.
  if (isStickerKind(asset.kind)) await loadStickerResources(asset);
  const total = Math.max(1, Math.ceil(duration * fps));
  const keyIndex = new Map<string, number>();
  const unique: string[] = [];
  const sequence: number[] = [];
  for (let k = 0; k < total; k++) {
    const key = assetFrameKey(asset, k, total, duration, fps);
    let idx = keyIndex.get(key);
    if (idx === undefined) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.translate(cw / 2, ch / 2);
      ctx.globalAlpha = overlay.opacity;
      drawAssetFrame(ctx, asset, w, h, k / fps, duration, {
        rotationDeg: overlay.rotation,
        flipHorizontal: overlay.flipHorizontal,
        flipVertical: overlay.flipVertical,
        shadow: overlay.shadow,
      });
      idx = unique.length;
      unique.push(canvas.toDataURL("image/png"));
      keyIndex.set(key, idx);
      // Let the UI breathe during long renders.
      // eslint-disable-next-line no-await-in-loop
      if (idx % 12 === 11) await new Promise((r) => setTimeout(r, 0));
    }
    sequence.push(idx);
  }

  const centerX = overlay.x * framePixelWidth + w / 2;
  const centerY = overlay.y * framePixelHeight + h / 2;
  return { unique, sequence, xPx: Math.round(centerX - cw / 2), yPx: Math.round(centerY - ch / 2) };
}
