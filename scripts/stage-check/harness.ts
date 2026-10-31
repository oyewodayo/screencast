// Headless-Edge harness: the reference's 19-38s sections as Stage scenes, rendered by the real
// StageRenderer. window.runStage() times every 60fps frame and returns chosen frames as PNGs.
import { compileStage, CompiledStage } from "../../src/utils/stage/stageEngine";
import { StageRenderer } from "../../src/utils/stage/stageRenderer";
import { canvasStageMeasure, loadStageFonts } from "../../src/utils/stage/stageMeasure";
import { loadStageImages } from "../../src/utils/stage/stageImages";
import { loadStageMath } from "../../src/utils/stage/stageMath";
import { GraphState, loadStageGraphs } from "../../src/utils/stage/stageGraph";
import { StageBeat, StageElement, StageScene, defaultStageProps } from "../../src/utils/stage/stageTypes";
import * as gate from "./insomnia";
import { SHOWCASE } from "./showcase";
import { SHAPE_PRESETS } from "../../src/utils/stage/stageShapes";

const OFF_WHITE = "#e8e8e6";
const INK = "#111111";
const DIM = "#9a9a9a";
const MAROON = "#7a1f3d";

const text = (id: string, t: string, size: number, extra: Partial<StageElement> = {}, props: Partial<StageElement["props"]> = {}): StageElement => ({
  id,
  kind: "text",
  fit: "hug",
  textLook: { fontFamily: "inter", fontSize: size, textAlign: "left" },
  props: defaultStageProps({ width: 1700, text: t, color: INK, ...props }),
  ...extra,
});
const scene = (id: string, elements: StageElement[], beats: StageBeat[], extra: Partial<StageScene> = {}): StageScene => ({
  id,
  startTime: 0,
  width: 1920,
  height: 1080,
  background: { kind: "color", color: OFF_WHITE },
  elements,
  beats,
  spring: "smooth",
  stagger: 0.04,
  ...extra,
});

// 1. "Keeping a Mac awake is easy." then the second line arrives; the first moves up and dims.
const second = "Keeping it alive on battery isn't.";
const onBattery = second.indexOf("on battery");
const headline = scene(
  "headline",
  [
    { id: "group", kind: "stack", stack: { direction: "column", gap: 6, justify: "center", align: "center" }, props: defaultStageProps({ x: 0, y: 0, width: 1920, height: 1080 }) },
    text("easy", "Keeping a Mac awake is easy.", 40, { parent: "group" }),
    text("battery", second, 40, { parent: "group" }, { visible: false, colorRuns: [{ start: onBattery, end: onBattery + 10, color: MAROON }] }),
  ],
  [
    { id: "h0", hold: 1.4, changes: {} },
    { id: "h1", hold: 2.0, changes: { easy: { color: DIM }, battery: { visible: true } } },
  ]
);

// 2. "More than awake": a rainbow heading settling to black, rows arriving, earlier rows fading back.
const heading = "More than awake";
const rainbow = ["#f59e9e", "#f5b78e", "#c4a7f0", "#8ec5f5", "#f5a3d0"];
const rainbowRuns = Array.from(heading, (_c, i) => ({ start: i, end: i + 1, color: rainbow[i % rainbow.length] }));
const rows = [
  ["Stays awake", "like any keep-awake app"],
  ["Pauses the apps you pick", "Slack, Messages, Discord"],
  ["Keeps your agents running", "Claude Code, Codex, terminal"],
  ["Low Power Mode", "the moment the lid closes"],
  ["Hops to your hotspot", "when the Wi-Fi drops"],
  ["Open source", "read it, change it"],
];
const rowText = (r: string[]) => `${r[0]}  –  ${r[1]}`;
const rowRuns = (r: string[], focused: boolean) => [{ start: r[0].length, end: rowText(r).length, color: focused ? "#8a8a8a" : "#c2c2c2" }];
// The label in medium, the description regular - the reference's hierarchy.
const rowWeights = (r: string[]) => [{ start: 0, end: r[0].length, weight: 500 }];
// Each row: a framed icon in the row's accent, then the text; a thin rule down the left grows as
// rows arrive.
const rowIcons: [string, string][] = [
  ["check", "#9a9a9a"],
  ["pause", "#d6338a"],
  ["terminal", "#f07a3a"],
  ["battery", "#e0a91a"],
  ["wifi", "#4a7cf0"],
  ["code", "#2fa36b"],
];
const ROW_GAP = 10;
const ROW_H = 29;
const shown = (i: number) => ({ [`row${i}`]: { visible: true }, [`rowIcon${i}`]: { visible: true }, [`rowText${i}`]: { visible: true } });
const list = scene(
  "list",
  [
    { id: "col", kind: "stack", stack: { direction: "column", gap: 14, justify: "start", align: "start" }, props: defaultStageProps({ x: 120, y: 300, width: 1400, height: 600 }) },
    text("heading", heading, 46, { parent: "col" }, { colorRuns: rainbowRuns }),
    { id: "body", kind: "stack", fit: "hug", parent: "col", stack: { direction: "row", gap: 14, justify: "start", align: "start" }, props: defaultStageProps({ width: 0, height: 0 }) },
    { id: "rule", kind: "shape", parent: "body", props: defaultStageProps({ width: 1.5, height: ROW_H, color: "#cfcfcf", visible: false }) },
    { id: "rows", kind: "stack", fit: "hug", parent: "body", stack: { direction: "column", gap: ROW_GAP, justify: "start", align: "start" }, props: defaultStageProps({ width: 0, height: 0 }) },
    ...rows.flatMap((r, i): StageElement[] => [
      { id: `row${i}`, kind: "stack", fit: "hug", parent: "rows", stack: { direction: "row", gap: 10, justify: "start", align: "center" }, props: defaultStageProps({ width: 0, height: 0, visible: false }) },
      { id: `rowIcon${i}`, kind: "icon", parent: `row${i}`, icon: { name: rowIcons[i][0], frame: { radius: 4.5, width: 1.6 } }, props: defaultStageProps({ width: 20, height: 20, color: rowIcons[i][1], visible: false }) },
      text(`rowText${i}`, rowText(r), 24, { parent: `row${i}` }, { visible: false, colorRuns: rowRuns(r, true), weightRuns: rowWeights(r) }),
    ]),
  ],
  [
    { id: "l0", hold: 0.9, changes: {} },
    { id: "l1", hold: 0.9, changes: { heading: { colorRuns: undefined }, rule: { visible: true }, ...shown(0) } },
    ...rows.slice(1).map((r, i) => ({
      id: `l${i + 2}`,
      hold: 0.9,
      changes: {
        ...shown(i + 1),
        rule: { height: (i + 2) * ROW_H + (i + 1) * ROW_GAP },
        [`rowText${i}`]: { color: "#b5b5b5", colorRuns: rowRuns(rows[i], false) },
        [`rowIcon${i}`]: { opacity: 0.45 },
      },
    })),
  ]
);

// 3. The battery race.
const night = (t: number) => 23 * 60 + (t / 5) * (7 * 60 + 58);
const deadAt = ((24 * 60 + 3 * 60 + 10 - 23 * 60) / (7 * 60 + 58)) * 5;
const bar = (id: string, y: number, color: string, channel: string, extra: Partial<StageElement> = {}): StageElement[] => [
  { id: `${id}Track`, kind: "shape", shape: { radius: 9, stroke: { color: "#1a1a1a", width: 2 } }, props: defaultStageProps({ x: 560, y, width: 800, height: 44, color: "#ffffff" }) },
  { id: `${id}Fill`, kind: "shape", shape: { radius: 7 }, props: defaultStageProps({ x: 564, y: y + 4, width: 792, height: 36, color }), bind: { width: { channel, from: [0, 100], to: [0, 792] } }, ...extra },
  // The battery's nub, past the right end.
  { id: `${id}Nub`, kind: "shape", shape: { radius: 2 }, props: defaultStageProps({ x: 1364, y: y + 13, width: 5, height: 18, color: "#1a1a1a" }), ...(id === "stock" ? { when: [{ channel: "stock", below: 0.5, changes: { color: "#f2b4b4" } }] } : {}) },
  { id: `${id}Pct`, kind: "text", fit: "hug", textLook: { fontFamily: "inter-medium", fontSize: 22, textAlign: "right", tabularNums: true }, props: defaultStageProps({ x: 1150, y: y + 8, width: 196, text: `{${channel}:pct}`, color: INK }), ...(id === "stock" ? { when: [{ channel: "stock", below: 0.5, changes: { color: "#dc2626" } }] } : {}) },
];
const DEAD = "#dc2626";
const DEAD_SOFT = "#f2b4b4";
const dead = (changes: Partial<StageElement["props"]>) => [{ channel: "stock", below: 0.5, changes }];
const race = scene(
  "race",
  [
    text("title", "Lid closed, on battery, overnight", 28, {}, { x: 560, y: 360 }),
    text("clock", "{clock:time}", 28, { textLook: { fontFamily: "inter", fontSize: 28, textAlign: "right", tabularNums: true } }, { x: 1060, y: 360, width: 300 }),
    text("cmd", "sudo pmset -a disablesleep 1", 18, { textLook: { fontFamily: "jetbrains-mono", fontSize: 18 }, when: dead({ color: "#b5b5b5" }) }, { x: 560, y: 420, color: "#333333" }),
    text("cmdNote", "Screen on, every app running", 14, { when: dead({ color: "#cfcfcf" }) }, { x: 890, y: 423, color: "#a0a0a0" }),
    ...bar("stock", 450, "#8c8c8c", "stock", { when: [{ channel: "stock", below: 20, changes: { color: "#ef4444" } }] }),
    // When it dies: the outline, nub and figure go soft red and the verdict sits inside the bar.
    { id: "stockDead", kind: "shape", shape: { radius: 9, stroke: { color: DEAD_SOFT, width: 2 } }, props: defaultStageProps({ x: 560, y: 450, width: 800, height: 44, color: "rgba(255,255,255,0)", opacity: 0 }), when: dead({ opacity: 1 }) },
    text("deadMsg", "Dead at 3:10 AM. Agents stopped.", 18, { when: dead({ opacity: 1 }) }, { x: 580, y: 460, color: DEAD, opacity: 0 }),
    { id: "insEye", kind: "icon", icon: { name: "eye" }, props: defaultStageProps({ x: 560, y: 541, width: 20, height: 20, color: INK }) },
    text("insomnia", "Insomnia  Only your agents running", 18, { textLook: { fontFamily: "inter", fontSize: 18, textAlign: "left" } }, { x: 588, y: 540, colorRuns: [{ start: 8, end: 36, color: "#9a9a9a" }], weightRuns: [{ start: 0, end: 8, weight: 600 }] }),
    ...bar("ins", 570, "#2fbf5b", "agents"),
    ...["code", "globe", "terminal"].map((name, i): StageElement => ({ id: `app${i}`, kind: "icon", icon: { name, frame: { radius: 4, width: 0, fill: "#1a1a1a" } }, props: defaultStageProps({ x: 560 + i * 26, y: 630, width: 20, height: 20, color: "#ffffff" }) })),
    text("still", "Still working", 15, { textLook: { fontFamily: "inter-medium", fontSize: 15, textAlign: "left" } }, { x: 644, y: 631 }),
    { id: "stillDot", kind: "shape", shape: { radius: 3 }, props: defaultStageProps({ x: 741, y: 637, width: 6, height: 6, color: "#2fbf5b" }) },
  ],
  [{ id: "r0", hold: 6.5, changes: {} }],
  {
    channels: [
      { id: "clock", keys: [{ t: 0.6, value: night(0) }, { t: 5.6, value: night(5) }] },
      { id: "stock", keys: [{ t: 0.6, value: 100 }, { t: 0.6 + deadAt, value: 0 }] },
      { id: "agents", keys: [{ t: 0.6, value: 100 }, { t: 5.6, value: 46 }] },
    ],
  }
);

// 4. Connectors: laptop to Wi-Fi to cloud; the Wi-Fi drops and the line hops to a hotspot.
const device = (id: string, icon: string, label: string, x: number, extra: Partial<StageElement["props"]> = {}): StageElement[] => [
  { id, kind: "icon", icon: { name: icon }, props: defaultStageProps({ x, y: 470, width: 96, height: 96, color: INK, ...extra }) },
  text(`${id}Label`, label, 22, { textLook: { fontFamily: "inter-medium", fontSize: 22, textAlign: "center" } }, { x: x - 102, y: 590, width: 300, color: "#555555", ...(extra.visible === undefined ? {} : { visible: extra.visible }) }),
];
const link = (id: string, from: string, to: string, color: string, extra: Partial<StageElement["props"]> = {}): StageElement => ({
  id,
  kind: "connector",
  connector: { from, to, style: "dots", thickness: 7, gap: 22, flow: 60 },
  props: defaultStageProps({ width: 0, height: 0, color, ...extra }),
});
const diagram = scene(
  "diagram",
  [
    ...device("laptop", "laptop", "Your Mac", 380),
    ...device("wifi", "wifi", "Wi-Fi", 912),
    ...device("phone", "phone", "Hotspot", 912, { y: 700, visible: false }),
    ...device("cloud", "cloud", "Your agents", 1444),
    link("l1", "laptop", "wifi", "#3b82f6", { visible: false }),
    link("l2", "wifi", "cloud", "#3b82f6", { visible: false }),
    link("h1", "laptop", "phone", "#2fbf5b", { visible: false }),
    link("h2", "phone", "cloud", "#2fbf5b", { visible: false }),
  ],
  [
    { id: "d0", hold: 0.8, changes: {} },
    { id: "d1", hold: 1.6, changes: { l1: { visible: true }, l2: { visible: true } } },
    { id: "d2", hold: 2.2, changes: { wifi: { color: "#ef4444", opacity: 0.35 }, wifiLabel: { text: "Wi-Fi dropped", color: "#ef4444" }, l1: { visible: false }, l2: { visible: false }, phone: { visible: true, y: 640 }, phoneLabel: { visible: true, y: 760 }, h1: { visible: true }, h2: { visible: true } } },
  ],
  { stagger: 0.08 }
);

// 5. Pictures: cover and contain, rounded, outlined and shadowed; the boxes spring and the crop follows.
const pic = (id: string, src: string, x: number, y: number, w: number, h: number, fit: "cover" | "contain", shape: StageElement["shape"], extra: Partial<StageElement["props"]> = {}): StageElement => ({
  id,
  kind: "image",
  image: { src: `${location.origin}/${src}`, fit },
  shape,
  props: defaultStageProps({ x, y, width: w, height: h, ...extra }),
});
const pictures = scene(
  "pictures",
  [
    pic("photo", "pic.jpg", 160, 240, 760, 480, "cover", { radius: 36, shadow: { color: "rgba(0,0,0,0.25)", blur: 60, y: 24 } }),
    pic("fit", "pic.jpg", 1000, 240, 380, 480, "contain", { radius: 20, stroke: { color: "#111111", width: 3 } }, { color: "#ffffff" }),
    pic("logo", "logo.png", 1460, 360, 240, 240, "contain", {}),
  ],
  [
    { id: "p0", hold: 1.2, changes: {} },
    { id: "p1", hold: 1.6, changes: { photo: { width: 420, height: 600, y: 200 }, fit: { x: 640, width: 700 }, logo: { scale: 1.2, rotation: 8 } } },
  ]
);

// 6. Equations: typeset TeX, coloured terms, and a rewrite from one form to the next (3Blue1Brown).
const BLUE = "#58c4dd";
const equations = scene(
  "equations",
  [
    { id: "eq", kind: "math", textLook: { fontSize: 72 }, props: defaultStageProps({ x: 160, y: 380, width: 1600, height: 320, color: "#ffffff", text: "w_1 a_1 + w_2 a_2 + \\cdots + w_n a_n" }) },
    { id: "cost", kind: "math", textLook: { fontSize: 60 }, props: defaultStageProps({ x: 160, y: 760, width: 1600, height: 200, color: "#ffffff", visible: false, text: "C(w_1, w_2, \\ldots, w_{13{,}002})" }) },
  ],
  [
    { id: "m0", hold: 1.2, changes: {} },
    { id: "m1", hold: 1.6, changes: { eq: { text: "\\sigma(\\textcolor{" + BLUE + "}{w_1} a_1 + \\textcolor{" + BLUE + "}{w_2} a_2 + \\cdots + \\textcolor{" + BLUE + "}{w_n} a_n + b)" } } },
    { id: "m2", hold: 1.6, changes: { eq: { text: "a_1^{(1)} = \\sigma\\left(\\textcolor{" + BLUE + "}{w_1} a_1 + \\cdots + \\textcolor{" + BLUE + "}{w_n} a_n + b\\right)" }, cost: { visible: true } } },
    { id: "m3", hold: 1.6, changes: { cost: { text: "\\frac{1}{n}\\sum_{i=1}^{n} \\left(a_i - y_i\\right)^2" } } },
  ],
  { background: { kind: "color", color: "#000000" } }
);

// 7. Graphs: the cost curve C(w), a ball rolling downhill, a function morphing with a zoom, an area,
// and a point riding the curve on a value (3Blue1Brown, gradient descent).
const COST = "0.08w^4 - 0.9w^2 + 0.35w + 3";
const costView = { xMin: -4.2, xMax: 4.2, yMin: 0, yMax: 6.5 };
const g0: GraphState = { view: costView, series: [{ id: "c", kind: "function", expr: COST.replace(/w/g, "x"), color: "#fc6255", width: 4 }], markers: [], axes: true, grid: false, ticks: true, xLabel: "w", yLabel: "C(w)" };
const g1: GraphState = { ...g0, markers: [{ id: "ball", kind: "descent", on: "c", color: "#ffff00", x0: 3.6, rate: 0.12, steps: 14, seconds: 3.2, tangent: true }] };
const g2: GraphState = {
  ...g0,
  view: { xMin: -1, xMax: 4, yMin: -1, yMax: 9 },
  series: [{ id: "c", kind: "function", expr: "0.5x^2 - x + 1", color: "#58c4dd", width: 4 }],
  markers: [{ id: "area", kind: "area", on: "c", color: "#58c4dd", from: 0.5, to: 3, readout: true }],
  grid: true,
};
const g3: GraphState = { ...g2, markers: [...g2.markers, { id: "p", kind: "point", on: "c", color: "#ffff00", x: { value: "w" }, tangent: true, drops: true, readout: true }] };
const graphs = scene(
  "graphs",
  [{ id: "g", kind: "graph", props: defaultStageProps({ x: 260, y: 140, width: 1400, height: 820, color: "#ffffff", graph: g0 }), enter: { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0, opacity: 1 }, spring: "slow" }],
  [
    { id: "k0", hold: 2.2, changes: {} },
    { id: "k1", hold: 3.8, changes: { g: { graph: g1 } } },
    { id: "k2", hold: 2.4, changes: { g: { graph: g2 } } },
    { id: "k3", hold: 3, changes: { g: { graph: g3 } } },
  ],
  { background: { kind: "color", color: "#000000" }, channels: [{ id: "w", keys: [{ t: 8.6, value: 0.2 }, { t: 11.2, value: 3.6 }] }] }
);

// 8. Shapes: every preset in the gallery, some outlined, graded or shadowed; in the second beat each
// morphs into another form, rings sweep, corners round.
const SHAPE_COLORS = ["#58c4dd", "#fc6255", "#83c167", "#ffff00", "#ff862f", "#9a72ac", "#e07a5f"];
const shapeEls: StageElement[] = SHAPE_PRESETS.map((pr, i) => {
  const col = i % 7;
  const row = Math.floor(i / 7);
  const box = 190;
  const k = Math.min(box / pr.w, box / pr.h);
  const w = pr.w * k;
  const h = pr.h * k;
  return {
    id: "sh" + i,
    kind: "shape",
    shape: {
      radius: (pr.round ?? 0) * Math.min(w, h),
      ...(i % 5 === 1 ? { stroke: { color: "#ffffff", width: 6, align: "center" as const } } : {}),
      ...(i % 6 === 2 ? { gradient: { to: "#1e3a8a", angle: 135 } } : {}),
      ...(i % 6 === 4 ? { gradient: { to: "#000000", type: "radial" as const } } : {}),
      ...(pr.id === "arc" ? { caps: "round" as const } : {}),
    },
    props: defaultStageProps({ x: 130 + col * 245 + (box - w) / 2, y: 90 + row * 245 + (box - h) / 2, width: w, height: h, color: SHAPE_COLORS[i % 7], form: pr.form, sides: pr.sides, inner: pr.inner, sweep: pr.sweep }),
  };
});
const MORPH_TO: Record<string, Partial<StageElement["props"]>> = {
  sh0: { form: "ellipse" },
  sh3: { form: "star", sides: 5, inner: 0.45 },
  sh5: { form: "polygon", sides: 8 },
  sh11: { form: "heart" },
  sh13: { form: "star", sides: 7, inner: 0.6 },
  sh15: { form: "chevron", inner: 0.4 },
  sh18: { sweep: 120 },
  sh19: { sweep: 40 },
  sh20: { sweep: 90 },
  sh1: { radius: 80 },
};
const shapes = scene("shapes", shapeEls, [
  { id: "s0", hold: 1.5, changes: {} },
  { id: "s1", hold: 2, changes: MORPH_TO },
], { background: { kind: "color", color: "#101114" }, stagger: 0.02 });

// 9. Motion: wipes four ways and from the centre, a spin and a flip arriving, dashed, dotted and
// marching outlines, loops, a bent path, and text revealed by letter and by word.
const W = (id: string, x: number, y: number, color: string, extra: Partial<StageElement> = {}, props: Partial<StageElement["props"]> = {}): StageElement => ({
  id,
  kind: "shape",
  shape: { radius: 18 },
  props: defaultStageProps({ x, y, width: 220, height: 140, color, ...props }),
  ...extra,
});
const wipeIn = (wipe: "right" | "left" | "up" | "down" | "centre") => ({ enter: { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0, opacity: 1, wipe } });
const motion = scene(
  "motion",
  [
    W("w1", 80, 60, "#58c4dd", wipeIn("right")),
    W("w2", 340, 60, "#fc6255", wipeIn("left")),
    W("w3", 600, 60, "#83c167", wipeIn("up")),
    W("w4", 860, 60, "#ffff00", wipeIn("down")),
    W("w5", 1120, 60, "#ff862f", wipeIn("centre")),
    W("spin", 1380, 60, "#9a72ac", { enter: { dx: 0, dy: 0, scale: 0.4, blur: 0, rotate: -180 } }),
    W("flip", 1640, 60, "#58c4dd", { enter: { dx: 0, dy: 0, scale: 1, blur: 0, rotateY: -90 } }),
    W("dash", 80, 300, "rgba(0,0,0,0)", { shape: { radius: 24, stroke: { color: "#ffffff", width: 5, dash: { style: "dash", length: 22, gap: 14 } } } }),
    W("dot", 340, 300, "rgba(0,0,0,0)", { shape: { stroke: { color: "#ffff00", width: 10, align: "center", dash: { style: "dot", length: 10, gap: 12 } } } }, { form: "ellipse" }),
    W("march", 600, 300, "#1e293b", { shape: { stroke: { color: "#58c4dd", width: 6, dash: { style: "dash", length: 30, gap: 18, flow: 60 } } } }, { form: "star", sides: 6, inner: 0.55, height: 220, width: 220 }),
    W("ringdash", 880, 300, "#83c167", { shape: { stroke: { color: "#ffffff", width: 4, align: "outside", dash: { style: "dot", length: 4, gap: 10 } } } }, { form: "ring", inner: 0.7, width: 200, height: 200 }),
    W("pulse", 1180, 320, "#fc6255", { loops: [{ kind: "pulse", amount: 18 }] }, { form: "heart", width: 160, height: 150 }),
    W("float", 1420, 320, "#58c4dd", { loops: [{ kind: "float", amount: 30 }, { kind: "sway", amount: 10 }] }, { width: 160, height: 120 }),
    W("spinloop", 1660, 300, "#ffff00", { loops: [{ kind: "spin", period: 2 }] }, { form: "star", sides: 5, inner: 0.45, width: 180, height: 180 }),
    W("arc", 80, 640, "#ff862f", {}, { form: "ellipse", width: 120, height: 120 }),
    text("t1", "Letters arrive one by one", 64, { textReveal: { by: "letter", style: "rise", stagger: 0.04 } }, { x: 360, y: 600, color: "#ffffff" }),
    text("t2", "Then word after word, popping in", 56, { textReveal: { by: "word", style: "pop", stagger: 0.12 } }, { x: 360, y: 720, color: "#ffff00" }),
    text("t3", "or typed out like this_", 48, { textReveal: { by: "letter", style: "type", stagger: 0.05 } }, { x: 360, y: 840, color: "#83c167" }),
  ],
  [
    { id: "m0", hold: 1.6, changes: {} },
    { id: "m1", hold: 2.6, changes: { arc: { x: 1700, y: 900 } }, paths: { arc: { bend: 0.35, orient: false } } },
  ],
  { background: { kind: "color", color: "#101114" }, stagger: 0.04 }
);

declare global {
  interface Window {
    runStage: (opts: { width: number; height: number; frames: Record<string, number[]>; only?: string[] }) => Promise<unknown>;
  }
}

window.runStage = async ({ width, height, frames, only }) => {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const renderer = new StageRenderer(canvas, width, height);
  const gl = renderer.renderer.getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const scenes: Record<string, StageScene> = { headline, list, race, diagram, pictures, equations, graphs, shapes, motion, ...Object.fromEntries(SHOWCASE.map((x) => [x.scene.id, x.scene])), gHeadline: gate.headline, gList: gate.list, gRace: gate.race, gWifi: gate.wifi, gCards: gate.cardsScene((n) => `${location.origin}/cards/${n}.png`) };
  const out: Record<string, unknown> = { gpu };
  for (const [run, name] of (only ?? Object.keys(scenes)).entries()) {
    const s = scenes[name];
    // A scene asked for twice reports twice (the second as name2).
    const key = (only ?? []).indexOf(name) < run ? `${name}2` : name;
    const t0 = performance.now();
    await loadStageFonts(s);
    await loadStageImages(s);
    await loadStageMath(s);
    await loadStageGraphs(s);
    const compiled: CompiledStage = compileStage(s, canvasStageMeasure);
    const compileMs = performance.now() - t0;
    // The editor prepares a scene when it loads - before anything plays.
    const p0 = performance.now();
    renderer.prepare(compiled);
    const prepareMs = performance.now() - p0;
    // With --js-flags=--expose-gc, garbage from earlier scenes is collected before timing starts.
    (window as unknown as { gc?: () => void }).gc?.();
    // Every 60fps frame, timed to the GPU finishing it.
    const times: number[] = [];
    const slow: string[] = [];
    const n = Math.round(compiled.duration * 60);
    for (let k = 0; k < n; k++) {
      renderer.stats.rasters = renderer.stats.atlases = 0;
      const a = performance.now();
      renderer.render(compiled, k / 60);
      const b = performance.now();
      gl.finish();
      const c = performance.now();
      times.push(c - a);
      if (c - a > 8) slow.push(`t=${(k / 60).toFixed(2)} js=${(b - a).toFixed(1)} gpu=${(c - b).toFixed(1)} calls=${renderer.renderer.info.render.calls} rasters=${renderer.stats.rasters} atlases=${renderer.stats.atlases} programs=${renderer.renderer.info.programs?.length} textures=${renderer.renderer.info.memory.textures} geoms=${renderer.renderer.info.memory.geometries}`);
    }
    out[key + "_slow"] = slow.slice(0, 4);
    times.sort((x, y) => x - y);
    const shots: Record<string, string> = {};
    for (const t of frames[name] ?? []) {
      renderer.render(compiled, t);
      shots[String(t)] = canvas.toDataURL("image/png");
    }
    const { sampleStage: sampleOnly } = await import("../../src/utils/stage/stageEngine");
    const s0 = performance.now();
    for (let k = 0; k < n; k++) sampleOnly(compiled, k / 60);
    out[key + "_sampleMs"] = (performance.now() - s0) / n;
    out[key] = { compileMs, prepareMs, frames: n, mean: times.reduce((x, y) => x + y, 0) / n, p95: times[Math.floor(n * 0.95)], max: times[n - 1], shots };
  }
  renderer.dispose();
  return out;
};

// Debug: what the engine samples for a scene at `t` (ids, opacity, text) - for when a frame looks wrong.
(window as unknown as { sampleAt: (name: string, t: number) => Promise<unknown> }).sampleAt = async (name, t) => {
  const scenes: Record<string, StageScene> = { headline, list, race, diagram, pictures, equations, graphs, shapes, motion, ...Object.fromEntries(SHOWCASE.map((x) => [x.scene.id, x.scene])), gHeadline: gate.headline, gList: gate.list, gRace: gate.race, gWifi: gate.wifi, gCards: gate.cardsScene((n) => `${location.origin}/cards/${n}.png`) };
  await loadStageFonts(scenes[name]);
  const { sampleStage } = await import("../../src/utils/stage/stageEngine");
  const c = compileStage(scenes[name], canvasStageMeasure);
  return sampleStage(c, t).map((s) => ({ id: s.id, op: +s.opacity.toFixed(3), x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.width), text: s.text, live: s.live, glyphs: s.glyphs?.length }));
};

// Debug: the renderer's own state for each element after drawing `t`.
(window as unknown as { gfxAt: (name: string, t: number) => Promise<unknown> }).gfxAt = async (name, t) => {
  const scenes: Record<string, StageScene> = { headline, list, race, diagram, pictures, equations, graphs, shapes, motion, ...Object.fromEntries(SHOWCASE.map((x) => [x.scene.id, x.scene])), gHeadline: gate.headline, gList: gate.list, gRace: gate.race, gWifi: gate.wifi, gCards: gate.cardsScene((n) => `${location.origin}/cards/${n}.png`) };
  await loadStageFonts(scenes[name]);
  const canvas = document.createElement("canvas");
  const r = new StageRenderer(canvas, 1920, 1080);
  const c = compileStage(scenes[name], canvasStageMeasure);
  r.render(c, t);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gfx = (r as any).gfx as Map<string, any>;
  const out = [...gfx].map(([id, g]) => ({
    id,
    text: g.text ? { visible: g.text.visible, opacity: g.text.material.uniforms.opacity.value, tex: g.text.material.uniforms.map.value?.image ? [g.text.material.uniforms.map.value.image.width, g.text.material.uniforms.map.value.image.height] : null, order: g.text.renderOrder, scaleX: +g.text.matrix.elements[0].toFixed(2) } : null,
    rasters: g.rasters.size,
    glyphs: g.glyphs ? { visible: g.glyphs.mesh.visible, n: g.glyphs.mesh.geometry.instanceCount } : null,
  }));
  r.dispose();
  return out;
};
