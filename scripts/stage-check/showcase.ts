// The 20-second Stage showcase: six scenes, end to end, each showing a part of what the editor does -
// text revealed letter by letter, shapes morphing, an equation rewriting itself, a graph drawn from
// a typed formula with gradient descent rolling down it, a live value driving a progress ring, and
// an outro of everything at once. Rendered by the harness (headless) and written as a real project
// by make-showcase-project.mjs, which the app exports.
import type { GraphState } from "../../src/utils/stage/stageGraph";
import { StageBeat, StageElement, StageScene, defaultStageProps } from "../../src/utils/stage/stageTypes";

const BG = "#0b0d12";
const INK = "#f5f5f4";
const DIM = "#8b93a7";
const TEAL = "#2dd4bf";
const BLUE = "#58c4dd";
const CORAL = "#fc6255";
const YELLOW = "#ffd23f";
const VIOLET = "#a78bfa";

const scene = (id: string, name: string, elements: StageElement[], beats: StageBeat[], extra: Partial<StageScene> = {}): StageScene => ({
  id,
  name,
  startTime: 0,
  width: 1920,
  height: 1080,
  background: { kind: "color", color: BG },
  elements,
  beats,
  spring: "smooth",
  stagger: 0.05,
  ...extra,
});

const text = (id: string, t: string, size: number, font: string, props: Partial<StageElement["props"]>, extra: Partial<StageElement> = {}, align: "left" | "center" | "right" = "center"): StageElement => ({
  id,
  kind: "text",
  fit: "hug",
  textLook: { fontFamily: font, fontSize: size, textAlign: align },
  props: defaultStageProps({ x: 160, width: 1600, text: t, color: INK, ...props }),
  ...extra,
});

// A small heading, top left, the same in every scene.
const heading = (id: string, t: string, kicker: string): StageElement[] => [
  text(id + "K", kicker, 22, "inter-semibold", { x: 120, y: 92, width: 900, color: TEAL }, { textReveal: { by: "letter", style: "fade", stagger: 0.02 } }, "left"),
  text(id, t, 52, "inter-semibold", { x: 120, y: 126, width: 1200 }, { textReveal: { by: "word", style: "rise", stagger: 0.07, exit: true } }, "left"),
];

// Everything in a scene hidden - its last beat, so each scene leaves cleanly before the next.
const hideAll = (els: StageElement[], id: string, hold: number): StageBeat => ({ id, hold, changes: Object.fromEntries(els.map((e) => [e.id, { visible: false }])) });

// ---- 1. Intro ------------------------------------------------------------------------------------
const introEls: StageElement[] = [
  // A soft glow behind the title, breathing.
  { id: "glow", kind: "shape", shape: { gradient: { to: BG, type: "radial" } }, loops: [{ kind: "breathe", amount: 30, period: 3.2 }], enter: { dx: 0, dy: 0, scale: 0.6, blur: 40 }, spring: "slow", props: defaultStageProps({ x: 260, y: 120, width: 1400, height: 840, color: "#123a40", form: "ellipse" }) },
  text("title", "Briefcast Stage", 150, "inter-bold", { y: 360 }, { textReveal: { by: "letter", style: "rise", stagger: 0.04, exit: true } }),
  text("sub", "Videos that explain themselves.", 48, "instrument-serif-italic", { y: 610, color: DIM, visible: false }, { textReveal: { by: "word", style: "pop", stagger: 0.1 } }),
  { id: "bar", kind: "shape", shape: { radius: 4 }, enter: { dx: 0, dy: 0, scale: 1, blur: 0, opacity: 1, draw: 0, wipe: "centre" }, props: defaultStageProps({ x: 760, y: 584, width: 400, height: 6, color: TEAL, visible: false }) },
  { id: "orb", kind: "shape", loops: [{ kind: "orbit", amount: 26, period: 3 }], enter: { dx: 0, dy: 0, scale: 0.2, blur: 0 }, props: defaultStageProps({ x: 1500, y: 300, width: 22, height: 22, color: YELLOW, form: "ellipse", visible: false }) },
  { id: "orb2", kind: "shape", loops: [{ kind: "orbit", amount: 18, period: 2.4, phase: 0.5 }], enter: { dx: 0, dy: 0, scale: 0.2, blur: 0 }, props: defaultStageProps({ x: 380, y: 700, width: 16, height: 16, color: CORAL, form: "ellipse", visible: false }) },
];
const intro = scene("sc-intro", "Intro", introEls, [
  { id: "i0", hold: 1.1, changes: {} },
  { id: "i1", hold: 1.8, changes: { sub: { visible: true }, bar: { visible: true }, orb: { visible: true }, orb2: { visible: true } } },
  hideAll(introEls, "i2", 0.5),
]);

// ---- 2. Shapes that morph ------------------------------------------------------------------------
const SH = { x: 780, y: 330, width: 360, height: 360 };
const shapeEls: StageElement[] = [
  ...heading("h2", "Shapes that morph", "26 FORMS · ANY SIZE · ANY BEAT"),
  { id: "halo", kind: "shape", shape: { stroke: { color: "#3b4252", width: 3, align: "center", dash: { style: "dash", length: 18, gap: 12, flow: 50 } } }, loops: [{ kind: "spin", period: 14 }], enter: { dx: 0, dy: 0, scale: 0.6, blur: 0, rotate: -90 }, props: defaultStageProps({ x: 700, y: 250, width: 520, height: 520, color: "rgba(0,0,0,0)", form: "ellipse" }) },
  { id: "morph", kind: "shape", shape: { radius: 56, shadow: { color: "rgba(255,255,255,0.14)", blur: 80, x: 0, y: 0 } }, spring: "bouncy", enter: { dx: 0, dy: 0, scale: 0.3, blur: 0 }, props: defaultStageProps({ ...SH, color: TEAL }) },
  text("shapeName", "Square", 40, "inter-medium", { y: 790, color: DIM }),
];
const shapes = scene("sc-shapes", "Shapes", shapeEls, [
  { id: "s0", hold: 0.95, changes: {} },
  { id: "s1", hold: 0.85, changes: { morph: { form: "ellipse", color: BLUE }, shapeName: { text: "Circle" } } },
  { id: "s2", hold: 0.85, changes: { morph: { form: "star", sides: 5, inner: 0.46, color: YELLOW, rotation: 36 }, shapeName: { text: "Star" } } },
  { id: "s3", hold: 0.95, changes: { morph: { form: "heart", color: CORAL, rotation: 0 }, shapeName: { text: "Heart" } } },
  hideAll(shapeEls, "s4", 0.6),
]);

// ---- 3. Maths that rewrites itself ---------------------------------------------------------------
const mathEls: StageElement[] = [
  ...heading("h3", "Maths that rewrites itself", "TYPESET TEX · TERMS GLIDE INTO PLACE"),
  { id: "eq", kind: "math", textLook: { fontSize: 120 }, enter: { dx: 0, dy: 30, scale: 1, blur: 12 }, props: defaultStageProps({ x: 160, y: 400, width: 1600, height: 280, color: INK, text: "(a+b)^2" }) },
  text("eqNote", "Type it once. Change it in the next beat.", 32, "inter-medium", { y: 760, color: DIM, visible: false }, { textReveal: { by: "word", style: "fade", stagger: 0.06 } }),
];
const maths = scene("sc-maths", "Maths", mathEls, [
  { id: "m0", hold: 0.95, changes: {} },
  { id: "m1", hold: 1.0, changes: { eq: { text: "(a+b)(a+b)" }, eqNote: { visible: true } } },
  { id: "m2", hold: 1.0, changes: { eq: { text: "a^2+\\textcolor{" + YELLOW + "}{2ab}+b^2" } } },
  hideAll(mathEls, "m3", 0.45),
]);

// ---- 4. Graphs from a typed formula --------------------------------------------------------------
const COST = "0.07x^4 - 0.8x^2 + 0.3x + 3.2";
const g0: GraphState = { view: { xMin: -4, xMax: 4, yMin: 0, yMax: 7 }, series: [{ id: "c", kind: "function", expr: COST, color: CORAL, width: 5 }], markers: [], axes: true, grid: false, ticks: true, xLabel: "w", yLabel: "C(w)" };
const g1: GraphState = {
  ...g0,
  markers: [
    { id: "ball", kind: "descent", on: "c", color: YELLOW, x0: 3.55, rate: 0.12, steps: 18, seconds: 2.2, tangent: true },
    { id: "ball2", kind: "descent", on: "c", color: BLUE, x0: -3.7, rate: 0.12, steps: 18, seconds: 2.2, tangent: true },
  ],
};
const graphEls: StageElement[] = [
  ...heading("h4", "Graphs from a typed formula", "FUNCTIONS · DATA · GRADIENT DESCENT"),
  { id: "graph", kind: "graph", spring: "slow", enter: { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0, opacity: 1 }, props: defaultStageProps({ x: 300, y: 250, width: 1320, height: 700, color: INK, graph: g0 }) },
  text("formula", "C(w) = " + COST.replace(/x/g, "w"), 24, "jetbrains-mono", { x: 120, y: 200, width: 900, color: DIM }, { enter: { dx: 0, dy: 0, scale: 1, blur: 0, opacity: 1, draw: 0, wipe: "right" } }, "left"),
  text("gNote", "Two balls, two valleys - real gradient descent.", 30, "inter-medium", { y: 975, color: DIM, visible: false }, { textReveal: { by: "word", style: "rise", stagger: 0.05 } }),
];
const graph = scene("sc-graph", "Graph", graphEls, [
  { id: "g0", hold: 1.4, changes: {} },
  { id: "g1", hold: 2.6, changes: { graph: { graph: g1 }, gNote: { visible: true } } },
  hideAll(graphEls, "g2", 0.6),
]);

// ---- 5. Live values ------------------------------------------------------------------------------
const valueEls: StageElement[] = [
  ...heading("h5", "Live values drive anything", "A VALUE · A RING · A RULE"),
  { id: "track", kind: "shape", props: defaultStageProps({ x: 760, y: 330, width: 400, height: 400, color: "#1c212b", form: "ring", inner: 0.84 }) },
  {
    id: "ring",
    kind: "shape",
    shape: { caps: "round", shadow: { color: "rgba(255,255,255,0.12)", blur: 44, x: 0, y: 0 } },
    bind: { sweep: { channel: "level", from: [0, 100], to: [0, 360] } },
    when: [{ channel: "level", below: 60, changes: { color: CORAL } }],
    props: defaultStageProps({ x: 760, y: 330, width: 400, height: 400, color: TEAL, form: "ring", inner: 0.84, sweep: 0 }),
  },
  text("pct", "{level:pct}", 96, "inter-bold", { x: 760, y: 470, width: 400 }, { textLook: { fontFamily: "inter-bold", fontSize: 96, textAlign: "center", tabularNums: true } }),
  text("cap", "Charging", 30, "inter-medium", { y: 780, color: DIM }, { when: [{ channel: "level", atOrAbove: 99.5, changes: { text: "Fully charged", color: TEAL } }] }),
];
const values = scene(
  "sc-values",
  "Values",
  valueEls,
  [
    { id: "v0", hold: 2.1, changes: {} },
    hideAll(valueEls, "v1", 0.5),
  ],
  { channels: [{ id: "level", format: "pct", keys: [{ t: 0.25, value: 3 }, { t: 1.95, value: 100, easing: "ease-out" }] }] }
);

// ---- 6. Outro ------------------------------------------------------------------------------------
const icon = (id: string, form: StageElement["props"]["form"], x: number, y: number, color: string, extra: Partial<StageElement["props"]> = {}, loop: StageElement["loops"] = [{ kind: "float", amount: 14 }]): StageElement => ({
  id,
  kind: "shape",
  shape: { radius: 14 },
  loops: loop,
  enter: { dx: 0, dy: 0, scale: 0.2, blur: 0, rotate: -120 },
  spring: "bouncy",
  props: defaultStageProps({ x, y, width: 90, height: 90, color, form, ...extra }),
});
const outroEls: StageElement[] = [
  icon("o1", "ellipse", 420, 300, BLUE),
  { ...icon("o2", "star", 1420, 270, YELLOW, { sides: 5, inner: 0.46 }, [{ kind: "spin", period: 6 }, { kind: "float", amount: 10 }]), shape: { radius: 3 } },
  icon("o3", "heart", 1480, 700, CORAL, {}, [{ kind: "heartbeat", amount: 12 }]),
  icon("o4", "triangle", 360, 690, VIOLET, {}, [{ kind: "sway", amount: 10 }, { kind: "float", amount: 12, phase: 0.4 }]),
  text("logo", "Briefcast", 170, "inter-bold", { y: 390 }, { textReveal: { by: "letter", style: "zoom", stagger: 0.035 } }),
  { id: "pill", kind: "shape", shape: { radius: 40, gradient: { to: "#0ea5e9", angle: 90 } }, enter: { dx: 0, dy: 0, scale: 1, blur: 0, opacity: 1, draw: 0, wipe: "centre" }, props: defaultStageProps({ x: 610, y: 640, width: 700, height: 80, color: TEAL }) },
  text("pillText", "Made entirely in Briefcast Stage", 34, "inter-semibold", { x: 610, y: 659, width: 700, color: "#06281f" }, { textReveal: { by: "word", style: "rise", stagger: 0.06 } }),
];
const outro = scene("sc-outro", "Outro", outroEls, [{ id: "o0", hold: 1.8, changes: {} }], { stagger: 0.06 });

// Where each scene sits in the 20 seconds.
export const SHOWCASE: { scene: StageScene; at: number }[] = [
  { scene: intro, at: 0 },
  { scene: shapes, at: 3.4 },
  { scene: maths, at: 7.6 },
  { scene: graph, at: 11.0 },
  { scene: values, at: 15.6 },
  { scene: outro, at: 18.2 },
];
