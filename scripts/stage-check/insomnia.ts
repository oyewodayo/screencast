// The phase-1 gate: the Insomnia launch film's 19-38.5s rebuilt as Stage scenes, at the sizes and
// timings measured off the reference (1920x1080 stage units; times relative to each scene). The
// 31-35.5s card fan is 3D (phase 3) and isn't here. Used by the headless harness and by
// make-gate-project.ts, which puts them on a project's timeline at the reference's times.
import { StageBeat, StageElement, StageScene, defaultStageProps } from "../../src/utils/stage/stageTypes";

const PAPER = "#e8e8e6";
const INK = "#111111";
const GREY = "#9a9a9a";
const MAROON = "#8a2a4f";
const TIGHT = -0.02;

type Props = Partial<StageElement["props"]>;
const text = (id: string, t: string, font: string, size: number, props: Props = {}, extra: Partial<StageElement> = {}): StageElement => ({
  id,
  kind: "text",
  fit: "hug",
  ...extra,
  textLook: { fontFamily: font, fontSize: size, textAlign: "left", letterSpacing: TIGHT, ...extra.textLook },
  props: defaultStageProps({ width: 1700, text: t, color: INK, ...props }),
});
const shape = (id: string, props: Props, s: StageElement["shape"] = {}, extra: Partial<StageElement> = {}): StageElement => ({ id, kind: "shape", shape: s, props: defaultStageProps(props), ...extra });
const icon = (id: string, name: string, size: number, props: Props, frame?: NonNullable<StageElement["icon"]>["frame"], extra: Partial<StageElement> = {}): StageElement => ({
  id,
  kind: "icon",
  icon: { name, frame },
  props: defaultStageProps({ width: size, height: size, color: INK, ...props }),
  ...extra,
});
const scene = (id: string, name: string, elements: StageElement[], beats: StageBeat[], extra: Partial<StageScene> = {}): StageScene => ({
  id,
  name,
  startTime: 0,
  width: 1920,
  height: 1080,
  background: { kind: "color", color: PAPER },
  elements,
  beats,
  spring: "smooth",
  stagger: 0.04,
  ...extra,
});
// Everything in the scene hidden - its last beat, so it leaves the way things leave.
const allHidden = (elements: StageElement[]) => Object.fromEntries(elements.filter((e) => e.kind !== "stack").map((e) => [e.id, { visible: false }]));

// 19.0-21.3: one line, then the second arrives and the first steps back.
const second = "Keeping it alive on battery isn’t.";
const at = second.indexOf("on battery");
const headlineElements: StageElement[] = [
  { id: "hGroup", kind: "stack", stack: { direction: "column", gap: 49, justify: "center", align: "center" }, props: defaultStageProps({ x: 0, y: 0, width: 1920, height: 1080 }) },
  text("easy", "Keeping a Mac awake is easy.", "inter-semibold", 78, {}, { parent: "hGroup" }),
  text("battery", second, "inter-semibold", 78, { visible: false, colorRuns: [{ start: at, end: at + 10, color: MAROON }] }, { parent: "hGroup" }),
];
export const headline = scene("gate-headline", "Keeping a Mac awake", headlineElements, [
  { id: "h0", hold: 1.0, changes: {} },
  { id: "h1", hold: 1.0, changes: { easy: { color: GREY }, battery: { visible: true } } },
  { id: "h2", hold: 0.35, changes: allHidden(headlineElements) },
]);

// 21.0-27.35: a rainbow heading settling to ink, then a row at a time down a thin rule.
const heading = "More than awake";
const rainbow = ["#f59e9e", "#f5b78e", "#c4a7f0", "#8ec5f5", "#f5a3d0"];
const rows: [string, string, string, string][] = [
  ["Stays awake", "like any keep-awake app", "check", "#a8a8a8"],
  ["Pauses the apps you pick", "Slack, Messages, Discord", "pause", "#d6338a"],
  ["Keeps your agents running", "Claude Code, Codex, terminal", "terminal", "#e2683a"],
  ["Low Power Mode", "the moment the lid closes", "battery", "#d9a514"],
  ["Hops to your hotspot", "when the Wi-Fi drops", "wifi", "#3b7cf0"],
  ["Open source", "read it, change it", "code", "#2f9e6a"],
];
const rowText = (r: string[]) => `${r[0]}  –  ${r[1]}`;
const ROW_PITCH = 100;
const rowArrives = [0.5, 1.4, 2.0, 2.9, 3.9, 4.9];
const listElements: StageElement[] = [
  text("heading", heading, "inter-semibold", 96, { x: 330, y: 128, colorRuns: Array.from(heading, (_c, i) => ({ start: i, end: i + 1, color: rainbow[i % rainbow.length] })) }),
  shape("rule", { x: 340, y: 290, width: 2, height: ROW_PITCH - 30, color: "#cfcfcf", visible: false }),
  { id: "rows", kind: "stack", fit: "hug", stack: { direction: "column", gap: 40, justify: "start", align: "start" }, props: defaultStageProps({ x: 378, y: 300, width: 0, height: 0 }) },
  ...rows.flatMap(([label, , name, color], i): StageElement[] => [
    { id: `row${i}`, kind: "stack", fit: "hug", parent: "rows", stack: { direction: "row", gap: 28, justify: "start", align: "center" }, props: defaultStageProps({ width: 0, height: 0, visible: false }) },
    icon(`rowIcon${i}`, name, 52, { color, visible: false }, { radius: 11, width: 3 }, { parent: `row${i}` }),
    text(`rowText${i}`, rowText(rows[i]), "inter", 46, { visible: false, colorRuns: [{ start: label.length, end: rowText(rows[i]).length, color: GREY }], weightRuns: [{ start: 0, end: label.length, weight: 600 }] }, { parent: `row${i}` }),
  ]),
];
const rowShown = (i: number) => ({ [`row${i}`]: { visible: true }, [`rowIcon${i}`]: { visible: true }, [`rowText${i}`]: { visible: true } });
const listBeats: StageBeat[] = [{ id: "l0", hold: rowArrives[0], changes: {} }];
rows.forEach((_r, i) => {
  const next = rowArrives[i + 1] ?? 6.0;
  const changes: StageBeat["changes"] = { ...rowShown(i), rule: { visible: true, height: (i + 1) * ROW_PITCH - 30 } };
  // An empty list, not undefined - undefined in a beat means "unchanged".
  if (i === 0) changes.heading = { colorRuns: [] };
  // The generic feature steps back once the first real one arrives.
  if (i === 1) {
    changes.rowText0 = { color: "#c4c4c4", colorRuns: [] };
    changes.rowIcon0 = { color: "#cdcdcd" };
  }
  listBeats.push({ id: `l${i + 1}`, hold: next - rowArrives[i], changes });
});
listBeats.push({ id: "lx", hold: 0.35, changes: allHidden(listElements) });
export const list = scene("gate-list", "More than awake", listElements, listBeats, { stagger: 0.05 });

// 27.0-31.35: the same night on two batteries - one dies at 3:10, Insomnia's keeps going.
const night = (h: number, m: number) => ((h < 12 ? h + 24 : h) - 23) * 60 + m + 23 * 60;
const DEAD = "#dc2626";
const DEAD_SOFT = "#f0b3b3";
const dead = (changes: Props) => [{ channel: "stock", below: 0.5, changes }];
const battery = (id: string, y: number, color: string, channel: string, dies: boolean): StageElement[] => [
  shape(`${id}Track`, { x: 200, y, width: 1340, height: 120, color: "#fbfbfa" }, { radius: 26, stroke: { color: INK, width: 4 } }),
  shape(`${id}Fill`, { x: 210, y: y + 10, width: 1320, height: 100, color }, { radius: 17 }, {
    bind: { width: { channel, from: [0, 100], to: [0, 1320] } },
    ...(dies ? { when: [{ channel, below: 20, changes: { color: "#ef4444" } }] } : {}),
  }),
  ...(dies ? [shape(`${id}Dead`, { x: 200, y, width: 1340, height: 120, color: "rgba(255,255,255,0)", opacity: 0 }, { radius: 26, stroke: { color: DEAD_SOFT, width: 4 } }, { when: dead({ opacity: 1 }) })] : []),
  shape(`${id}Nub`, { x: 1548, y: y + 38, width: 14, height: 45, color: INK }, { radius: 4 }, dies ? { when: dead({ color: DEAD_SOFT }) } : {}),
  text(`${id}Pct`, `{${channel}:pct}`, "inter-semibold", 52, { x: 1205, y: y + 26, width: 300 }, { textLook: { fontFamily: "inter-semibold", fontSize: 52, textAlign: "right", tabularNums: true }, ...(dies ? { when: dead({ color: DEAD }) } : {}) }),
];
const raceElements: StageElement[] = [
  text("title", "Lid closed, on battery, overnight", "inter-semibold", 56, { x: 200, y: 114 }),
  text("clock", "{clock:time}", "inter-semibold", 56, { x: 1160, y: 114, width: 400 }, { textLook: { fontFamily: "inter-semibold", fontSize: 56, textAlign: "right", tabularNums: true } }),
  text("cmd", "sudo pmset -a disablesleep 1", "jetbrains-mono", 40, { x: 200, y: 270 }, { textLook: { fontFamily: "jetbrains-mono", fontSize: 40, letterSpacing: 0 }, when: dead({ color: "#b8b8b8" }) }),
  text("cmdNote", "Screen on, every app running", "inter", 34, { x: 905, y: 278, color: GREY }, { when: dead({ color: "#cccccc" }) }),
  ...battery("stock", 350, "#8e8e8a", "stock", true),
  text("deadMsg", "Dead at 3:10 AM. Agents stopped.", "inter-medium", 42, { x: 236, y: 383, color: DEAD, opacity: 0 }, { when: dead({ opacity: 1 }) }),
  icon("insEye", "awake", 56, { x: 202, y: 610 }),
  text("insomnia", "Insomnia", "inter-bold", 46, { x: 276, y: 610 }),
  text("insNote", "Only your agents running", "inter", 36, { x: 500, y: 619, color: GREY }),
  ...battery("ins", 690, "#2fbf5b", "agents", false),
  icon("app0", "sparkle", 52, { x: 200, y: 844, color: "#e07a5f" }, { radius: 11, width: 0, fill: "#1c1c1c" }),
  icon("app1", "globe", 52, { x: 272, y: 844, color: INK }, { radius: 11, width: 0, fill: "#ffffff" }),
  icon("app2", "terminal", 52, { x: 344, y: 844, color: "#ffffff" }, { radius: 11, width: 0, fill: "#111111" }),
  { id: "stillRow", kind: "stack", fit: "hug", stack: { direction: "row", gap: 18, justify: "start", align: "center" }, props: defaultStageProps({ x: 436, y: 847, width: 0, height: 0 }) },
  text("still", "Still working", "inter-semibold", 36, {}, { parent: "stillRow" }),
  shape("stillDot", { width: 16, height: 16, color: "#7ed6a0" }, { radius: 8 }, { parent: "stillRow" }),
];
export const race = scene(
  "gate-race",
  "Overnight on battery",
  raceElements,
  [
    { id: "r0", hold: 4.0, changes: {} },
    { id: "rx", hold: 0.35, changes: allHidden(raceElements) },
  ],
  {
    stagger: 0.02,
    channels: [
      { id: "clock", keys: [{ t: 0.0, value: night(23, 0) }, { t: 0.5, value: night(23, 1) }, { t: 1.0, value: night(23, 18) }, { t: 1.5, value: night(1, 27) }, { t: 2.0, value: night(3, 31) }, { t: 2.5, value: night(5, 27) }, { t: 3.0, value: night(6, 44) }, { t: 3.4, value: night(7, 0) }] },
      { id: "stock", keys: [{ t: 0.0, value: 100 }, { t: 0.5, value: 99 }, { t: 1.0, value: 93 }, { t: 1.5, value: 41 }, { t: 1.9, value: 0 }] },
      { id: "agents", keys: [{ t: 0.0, value: 100 }, { t: 0.5, value: 100 }, { t: 1.0, value: 98 }, { t: 1.5, value: 83 }, { t: 2.0, value: 69 }, { t: 2.5, value: 56 }, { t: 3.0, value: 48 }, { t: 3.4, value: 46 }] },
    ],
  }
);

// 35.5-38.85: the office Wi-Fi feeding the Mac drops; Insomnia hops to the phone's hotspot.
const dotted = (id: string, from: string, to: string, visible = false): StageElement => ({
  id,
  kind: "connector",
  connector: { from, to, style: "dots", thickness: 14, gap: 45, flow: 70, rhythm: 3 },
  props: defaultStageProps({ width: 0, height: 0, color: "#3b7cf0", visible }),
});
// The phone arrives from off the right edge.
const SLIDE_IN = { dx: 320, dy: 0, scale: 1, blur: 8 };
const wifiElements: StageElement[] = [
  // An invisible box round the Wi-Fi icon and its label - the line runs from it, at mid height.
  shape("wifiAnchor", { x: 180, y: 250, width: 200, height: 380, color: "rgba(0,0,0,0)" }),
  icon("wifi", "wifi", 210, { x: 175, y: 225, color: "#3b7cf0" }),
  text("wifiLabel", "Office Wi-Fi", "inter-semibold", 44, { x: 80, y: 540, width: 400 }, { textLook: { fontFamily: "inter-semibold", fontSize: 44, textAlign: "center" } }),
  icon("timerEye", "awake", 72, { x: 794, y: 134 }),
  text("timer", "{left:duration}", "inter-semibold", 72, { x: 893, y: 125, width: 400 }, { textLook: { fontFamily: "inter-semibold", fontSize: 72, tabularNums: true } }),
  shape("laptop", { x: 670, y: 243, width: 580, height: 394, color: "#dfe0e3" }, { radius: 28, stroke: { color: "#f6f6f7", width: 3 }, gradient: { to: "#b6b9be", angle: 135 }, shadow: { color: "rgba(0,0,0,0.16)", blur: 70, y: 26 } }),
  shape("hinge", { x: 700, y: 252, width: 522, height: 3, color: "#a4a7ac" }, { radius: 1.5 }),
  icon("laptopEye", "awake", 104, { x: 908, y: 385, color: "#7c7f85" }),
  ...["sparkle", "globe", "terminal", "cloud"].flatMap((name, i): StageElement[] => [
    icon(`agent${i}`, name, 64, { x: 808 + i * 80, y: 666, color: i === 1 ? INK : "#ffffff" }, { radius: 13, width: 0, fill: ["#1c1c1c", "#ffffff", "#111111", "#1d63ed"][i] }),
    shape(`agentDot${i}`, { x: 862 + i * 80, y: 662, width: 14, height: 14, color: "#34c759" }, { radius: 7 }),
  ]),
  dotted("wifiLine", "wifiAnchor", "laptop", true),
  shape("phone", { x: 1548, y: 252, width: 184, height: 376, color: "#3f7ef4", visible: false }, { radius: 38, stroke: { color: INK, width: 7 }, gradient: { to: "#1f58dc", angle: 180 }, shadow: { color: "rgba(0,0,0,0.14)", blur: 40, y: 16 } }, { enter: SLIDE_IN }),
  shape("notch", { x: 1610, y: 266, width: 60, height: 14, color: INK, visible: false }, { radius: 7 }, { enter: SLIDE_IN }),
  icon("phoneLink", "link", 84, { x: 1598, y: 398, color: "#ffffff", visible: false }, undefined, { enter: SLIDE_IN }),
  text("phoneLabel", "iPhone hotspot", "inter-medium", 44, { x: 1440, y: 656, width: 400, visible: false }, { textLook: { fontFamily: "inter-medium", fontSize: 44, textAlign: "center" }, enter: SLIDE_IN }),
  dotted("phoneLine", "laptop", "phone"),
  text("caption", "Wi-Fi drops.", "inter-semibold", 72, { x: 0, y: 883, width: 1920, visible: false }, { textLook: { fontFamily: "inter-semibold", fontSize: 72, textAlign: "center" } }),
];
export const wifi = scene(
  "gate-wifi",
  "Wi-Fi drops",
  wifiElements,
  [
    { id: "w0", hold: 1.0, changes: {} },
    { id: "w1", hold: 0.5, changes: { caption: { visible: true }, wifi: { opacity: 0.22, x: -15 }, wifiLabel: { opacity: 0.22, x: -110 }, wifiAnchor: { x: -10 }, wifiLine: { visible: false } } },
    { id: "w2", hold: 0.5, changes: { phone: { visible: true }, notch: { visible: true }, phoneLink: { visible: true }, phoneLabel: { visible: true } } },
    { id: "w3", hold: 1.35, changes: { caption: { text: "Insomnia hops to your hotspot." }, phoneLine: { visible: true } } },
    { id: "wx", hold: 0.35, changes: allHidden(wifiElements) },
  ],
  { stagger: 0.03, channels: [{ id: "left", keys: [{ t: 0, value: 6 * 3600 + 12 * 60 + 41 }, { t: 3.35, value: 6 * 3600 + 12 * 60 + 37.65 }] }] }
);

// 31.1-35.5: the dead battery dissolves into a card built from coloured dots, and the agents' windows
// fan out behind it in depth - "keeps ... working". `card` gives each picture's source (a URL in the
// harness, a file in the gate project).
export const CARD_NAMES = ["agent", "codex", "docker", "browser", "terminal"];
export function cardsScene(card: (name: string) => string): StageScene {
  const W = 380;
  const H = 480;
  const X = 780;
  const Y = 300;
  const front = CARD_NAMES[0];
  // Behind the front card to its left, each turned to face it and a step further back.
  const behind = CARD_NAMES.slice(1).reverse();
  const elements: StageElement[] = [
    ...behind.map((name, i): StageElement => ({
      id: `card${name}`,
      kind: "image",
      image: { src: card(name), fit: "cover" },
      shape: { radius: 10, shadow: { color: "rgba(0,0,0,0.18)", blur: 30, y: 10 } },
      // From behind the front card, sliding out to its place in the fan.
      enter: { dx: (behind.length - i) * 190, dy: 0, scale: 1, blur: 6 },
      props: defaultStageProps({ x: X + 260 - (behind.length - i) * 190, y: Y, width: W, height: H, rotateY: 28, z: -(behind.length - i) * 90, visible: false }),
    })),
    {
      id: `card${front}`,
      kind: "image",
      image: { src: card(front), fit: "cover", reveal: "dots" },
      shape: { radius: 10, shadow: { color: "rgba(0,0,0,0.2)", blur: 36, y: 12 } },
      spring: "slow",
      props: defaultStageProps({ x: X, y: Y, width: W, height: H }),
    },
    text("keeps", "keeps", "inter-medium", 46, { x: X + W - 150, y: Y - 64, width: 150, visible: false }, { textLook: { fontFamily: "inter-medium", fontSize: 46, textAlign: "right" } }),
    text("working", "working", "inter-medium", 46, { x: X + W - 170, y: Y + H + 4, width: 170, visible: false }, { textLook: { fontFamily: "inter-medium", fontSize: 46, textAlign: "right" } }),
  ];
  const fan = (shift: number, dx: number) => Object.fromEntries(behind.map((name, i) => [`card${name}`, { visible: true, x: X + shift - (behind.length - i) * dx }]));
  return scene(
    "gate-cards",
    "Keeps working",
    elements,
    [
      { id: "c0", hold: 1.3, changes: {} },
      { id: "c1", hold: 0.6, changes: { ...fan(90, 80), [`card${front}`]: { x: X + 90, rotateY: 10 } } },
      { id: "c2", hold: 2.0, changes: { ...fan(260, 190), keeps: { visible: true, x: X + 260 + W - 150 }, working: { visible: true, x: X + 260 + W - 170 }, [`card${front}`]: { x: X + 260, rotateY: 24 } } },
      { id: "cx", hold: 0.35, changes: allHidden(elements) },
    ],
    { stagger: 0.05, perspective: 1600 }
  );
}

// Where each scene starts on the reference's clock (and so in the gate project, from 19.0s).
export const GATE: { scene: StageScene; at: number }[] = [
  { scene: headline, at: 19.0 },
  { scene: list, at: 21.0 },
  { scene: race, at: 27.0 },
  { scene: wifi, at: 35.5 },
];
