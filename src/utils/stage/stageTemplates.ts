// utils/stage/stageTemplates.ts
//
// Studio-grade, responsive multi-beat Stage scene templates + curated GPU gradient presets.
// Every template adapts automatically to both 16:9 widescreen (1920x1080) and 9:16 vertical
// (607.5x1080) canvases, with zero external assets required.
import { STAGE_HEIGHT, StageBackground, StageBeat, StageElement, StageScene, defaultStageProps } from "./stageTypes";

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tpl_${Math.random().toString(36).slice(2, 10)}`;

export interface StudioGradientPreset {
  id: string;
  label: string;
  from: string;
  to: string;
  angle?: number;
  radial?: boolean;
}

export const STUDIO_GRADIENTS: StudioGradientPreset[] = [
  { id: "midnight-teal", label: "Midnight Teal", from: "#0f172a", to: "#134e4a", angle: 135 },
  { id: "deep-indigo", label: "Deep Indigo", from: "#0b1024", to: "#312e81", angle: 140 },
  { id: "studio-spotlight", label: "Studio Spotlight", from: "#1e293b", to: "#020617", radial: true },
  { id: "sunset-ember", label: "Sunset Ember", from: "#450a0a", to: "#9a3412", angle: 135 },
  { id: "violet-bloom", label: "Violet Bloom", from: "#2e1065", to: "#831843", angle: 130 },
  { id: "nordic-paper", label: "Nordic Paper", from: "#f8fafc", to: "#e2e8f0", angle: 160 },
  { id: "warm-cream", label: "Warm Cream", from: "#fffbeb", to: "#fde68a", radial: true },
  { id: "mint-mist", label: "Mint Mist", from: "#ecfdf5", to: "#cffafe", angle: 135 },
];

export interface StageTemplateMeta {
  id: string;
  name: string;
  category: "Pro" | "Intro" | "Explainer" | "Data" | "Social";
  description: string;
  previewFrom: string;
  previewTo: string;
  accent: string;
  beatCount: number;
  pro?: boolean;
  build: (opts: { width: number; startTime: number; id?: string; layer?: number }) => StageScene;
}

function makeKineticIntro(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const padX = narrow ? 52 : 180;
  const contentW = w - padX * 2;
  const badge: StageElement = {
    id: uid(),
    kind: "text",
    name: "Badge",
    fit: "hug",
    textLook: {
      fontFamily: "inter-semibold",
      fontSize: narrow ? 20 : 24,
      textAlign: "center",
      letterSpacing: 0.14,
      backgroundColor: "rgba(45,212,191,0.18)",
      cornerStyle: "pill",
      paddingX: 24,
      paddingY: 10,
    },
    enter: { dx: 0, dy: -20, scale: 0.9, blur: 6 },
    props: defaultStageProps({
      x: Math.round(w / 2 - 170),
      y: Math.round(STAGE_HEIGHT * 0.31),
      width: 340,
      height: 52,
      text: "CHAPTER 01",
      color: "#5eead4",
    }),
  };
  const title: StageElement = {
    id: uid(),
    kind: "text",
    name: "Hero Title",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 64 : 104, textAlign: "center", lineHeight: 1.08 },
    textReveal: { by: "word", style: "rise", stagger: 0.08 },
    props: defaultStageProps({
      x: padX,
      y: Math.round(STAGE_HEIGHT * 0.4),
      width: contentW,
      height: narrow ? 160 : 240,
      text: "Design that moves",
      color: "#f8fafc",
    }),
  };
  const subtitle: StageElement = {
    id: uid(),
    kind: "text",
    name: "Subtitle",
    fit: "hug",
    textLook: { fontFamily: "inter", fontSize: narrow ? 28 : 38, textAlign: "center", lineHeight: 1.35 },
    enter: { dx: 0, dy: 28, scale: 1, blur: 8 },
    props: defaultStageProps({
      x: padX,
      y: Math.round(STAGE_HEIGHT * (narrow ? 0.58 : 0.62)),
      width: contentW,
      height: 80,
      text: "Smooth motion, crisp typography, zero keyframes.",
      color: "#cbd5e1",
      visible: false,
    }),
  };
  const bar: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Accent Bar",
    shape: { radius: 4, gradient: { to: "#38bdf8", angle: 90 } },
    enter: { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0, opacity: 1, wipe: "right" },
    props: defaultStageProps({
      x: Math.round(w / 2 - (narrow ? 120 : 180)),
      y: Math.round(STAGE_HEIGHT * (narrow ? 0.54 : 0.57)),
      width: narrow ? 240 : 360,
      height: 6,
      color: "#2dd4bf",
      visible: false,
    }),
  };
  return {
    id: opts.id ?? uid(),
    name: "Kinetic Title Intro",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: { kind: "gradient", from: "#0f172a", to: "#134e4a", angle: 135, pattern: "dots" },
    elements: [badge, title, bar, subtitle],
    beats: [
      { id: uid(), hold: 1.8, sound: "whoosh", camera: { zoom: 1, panX: 0, panY: 0, tilt: 0 }, changes: {} },
      {
        id: uid(),
        hold: 2.4,
        sound: "pop",
        camera: { zoom: 1.07, panX: 0, panY: 16, tilt: 0 },
        changes: {
          [bar.id]: { visible: true },
          [subtitle.id]: { visible: true },
        },
      },
    ],
    spring: "smooth",
    stagger: 0.06,
    wordStagger: 0.06,
    beatSound: "whoosh",
  };
}

function makeThreeSteps(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const padX = narrow ? 48 : 220;
  const contentW = w - padX * 2;
  const heading: StageElement = {
    id: uid(),
    kind: "text",
    name: "Heading",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 44 : 60, textAlign: "left" },
    props: defaultStageProps({
      x: padX,
      y: 120,
      width: contentW,
      height: 78,
      text: "Three steps to ship faster",
      color: "#f8fafc",
    }),
  };
  const steps = [
    { num: "01", title: "Capture your screen & voice in one click", accent: "#38bdf8" },
    { num: "02", title: "Drop animated scenes right on the timeline", accent: "#2dd4bf" },
    { num: "03", title: "Export crisp 60fps video or send to phone", accent: "#a78bfa" },
  ];
  const elements: StageElement[] = [heading];
  const rows: { card: string; num: string; txt: string }[] = [];
  const startY = 270;
  const rowH = narrow ? 168 : 176;
  const gap = 30;
  steps.forEach((st, i) => {
    const y = startY + i * (rowH + gap);
    const card: StageElement = {
      id: uid(),
      kind: "shape",
      name: `Step ${i + 1} Card`,
      shape: {
        radius: 22,
        stroke: { color: st.accent, width: 2.5 },
        shadow: { color: "rgba(0,0,0,0.28)", blur: 24, y: 8 },
      },
      enter: { dx: -36, dy: 0, scale: 0.96, blur: 6 },
      props: defaultStageProps({
        x: padX,
        y,
        width: contentW,
        height: rowH,
        color: "rgba(15,23,42,0.72)",
        visible: false,
      }),
    };
    const numEl: StageElement = {
      id: uid(),
      kind: "text",
      name: `Number ${i + 1}`,
      textLook: {
        fontFamily: "inter-bold",
        fontSize: narrow ? 28 : 34,
        textAlign: "center",
        backgroundColor: st.accent,
        cornerStyle: "rounded",
        paddingX: 16,
        paddingY: 10,
      },
      enter: { dx: 0, dy: 12, scale: 0.75, blur: 4 },
      props: defaultStageProps({
        x: padX + 28,
        y: Math.round(y + (rowH - 64) / 2),
        width: 82,
        height: 64,
        text: st.num,
        color: "#090d16",
        visible: false,
      }),
    };
    const txt: StageElement = {
      id: uid(),
      kind: "text",
      name: `Step ${i + 1} Copy`,
      fit: "hug",
      textLook: { fontFamily: "inter-semibold", fontSize: narrow ? 28 : 38, textAlign: "left", lineHeight: 1.25 },
      enter: { dx: 24, dy: 0, scale: 1, blur: 6 },
      props: defaultStageProps({
        x: padX + 136,
        y: Math.round(y + (rowH - (narrow ? 68 : 48)) / 2),
        width: contentW - 168,
        height: rowH - 36,
        text: st.title,
        color: "#f8fafc",
        visible: false,
      }),
    };
    elements.push(card, numEl, txt);
    rows.push({ card: card.id, num: numEl.id, txt: txt.id });
  });

  const beats: StageBeat[] = steps.map((_, i) => {
    const changes: StageBeat["changes"] = {};
    for (let j = 0; j < i; j++) {
      changes[rows[j].card] = { opacity: 0.42 };
      changes[rows[j].num] = { opacity: 0.55 };
      changes[rows[j].txt] = { opacity: 0.55 };
    }
    changes[rows[i].card] = { visible: true, opacity: 1 };
    changes[rows[i].num] = { visible: true, opacity: 1 };
    changes[rows[i].txt] = { visible: true, opacity: 1 };
    return { id: uid(), hold: 2.0, sound: "pop", changes };
  });
  // Final summary beat lighting all 3 up
  const allOn: StageBeat["changes"] = {};
  for (const r of rows) {
    allOn[r.card] = { opacity: 0.95 };
    allOn[r.num] = { opacity: 1 };
    allOn[r.txt] = { opacity: 1 };
  }
  beats.push({ id: uid(), hold: 2.2, sound: "swoosh", changes: allOn });

  return {
    id: opts.id ?? uid(),
    name: "3-Step Bullet Reveal",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: { kind: "gradient", from: "#0b1024", to: "#1e293b", angle: 145, pattern: "grid" },
    elements,
    beats,
    spring: "smooth",
    stagger: 0.05,
    wordStagger: 0.05,
    beatSound: "pop",
  };
}

function makeKpiCounter(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const cardW = narrow ? Math.round(w * 0.86) : 1020;
  const cardH = narrow ? 460 : 520;
  const cx = Math.round((w - cardW) / 2);
  const cy = Math.round((STAGE_HEIGHT - cardH) / 2);

  const card: StageElement = {
    id: uid(),
    kind: "shape",
    name: "KPI Card",
    shape: {
      radius: 36,
      gradient: { to: "#0f172a", angle: 160 },
      stroke: { color: "rgba(56,189,248,0.45)", width: 2.5 },
      shadow: { color: "rgba(14,165,233,0.28)", blur: 64, y: 18 },
    },
    enter: { dx: 0, dy: 30, scale: 0.92, blur: 10 },
    props: defaultStageProps({ x: cx, y: cy, width: cardW, height: cardH, color: "#1e293b" }),
  };
  const label: StageElement = {
    id: uid(),
    kind: "text",
    name: "Metric Label",
    fit: "hug",
    textLook: { fontFamily: "inter-semibold", fontSize: narrow ? 24 : 30, textAlign: "center", letterSpacing: 0.12 },
    props: defaultStageProps({
      x: cx + 48,
      y: cy + 68,
      width: cardW - 96,
      height: 44,
      text: "MONTHLY ACTIVE CREATORS",
      color: "#94a3b8",
    }),
  };
  const metric: StageElement = {
    id: uid(),
    kind: "text",
    name: "Live Counter",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 92 : 148, textAlign: "center", tabularNums: true },
    props: defaultStageProps({
      x: cx + 32,
      y: cy + (narrow ? 160 : 168),
      width: cardW - 64,
      height: 170,
      text: "{users:int}+",
      color: "#f8fafc",
    }),
  };
  const delta: StageElement = {
    id: uid(),
    kind: "text",
    name: "Trend Pill",
    fit: "hug",
    textLook: {
      fontFamily: "inter-bold",
      fontSize: narrow ? 24 : 30,
      textAlign: "center",
      backgroundColor: "rgba(16,185,129,0.2)",
      cornerStyle: "pill",
      paddingX: 28,
      paddingY: 12,
    },
    enter: { dx: 0, dy: 16, scale: 0.85, blur: 6 },
    props: defaultStageProps({
      x: Math.round(w / 2 - 190),
      y: cy + cardH - 112,
      width: 380,
      height: 58,
      text: "▲ +248% this quarter",
      color: "#34d399",
      visible: false,
    }),
  };

  return {
    id: opts.id ?? uid(),
    name: "Big KPI Counter",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: { kind: "gradient", from: "#1e293b", to: "#020617", radial: true, pattern: "dots" },
    elements: [card, label, metric, delta],
    channels: [
      {
        id: "users",
        name: "Users",
        format: "int",
        keys: [
          { t: 0.25, value: 0, easing: "ease-out" },
          { t: 2.35, value: 124800, easing: "ease-out" },
        ],
      },
    ],
    beats: [
      { id: uid(), hold: 2.2, sound: "whoosh", camera: { zoom: 1, panX: 0, panY: 0, tilt: 0 }, changes: {} },
      {
        id: uid(),
        hold: 2.4,
        sound: "sparkle",
        camera: { zoom: 1.08, panX: 0, panY: 10, tilt: 0 },
        changes: { [delta.id]: { visible: true } },
      },
    ],
    spring: "smooth",
    stagger: 0.06,
    wordStagger: 0.05,
    beatSound: "sparkle",
  };
}

function makeBeforeAfter(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const cardW = narrow ? Math.round(w * 0.84) : 640;
  const cardH = narrow ? 320 : 540;
  const leftX = narrow ? Math.round((w - cardW) / 2) : Math.round(w / 2 - cardW - 110);
  const leftY = narrow ? 150 : Math.round((STAGE_HEIGHT - cardH) / 2 + 30);
  const rightX = narrow ? leftX : Math.round(w / 2 + 110);
  const rightY = narrow ? 600 : leftY;

  const heading: StageElement = {
    id: uid(),
    kind: "text",
    name: "Title",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 40 : 54, textAlign: "center" },
    props: defaultStageProps({ x: 64, y: 54, width: w - 128, height: 68, text: "Before vs. After", color: "#f8fafc" }),
  };
  const beforeCard: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Before Card",
    shape: { radius: 28, stroke: { color: "rgba(248,113,113,0.45)", width: 2.5 } },
    enter: { dx: -40, dy: 0, scale: 0.95, blur: 6 },
    props: defaultStageProps({ x: leftX, y: leftY, width: cardW, height: cardH, color: "rgba(127,29,29,0.28)" }),
  };
  const beforeTag: StageElement = {
    id: uid(),
    kind: "text",
    name: "Before Tag",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: 22, textAlign: "left", letterSpacing: 0.12 },
    props: defaultStageProps({ x: leftX + 40, y: leftY + 42, width: cardW - 80, height: 34, text: "BEFORE", color: "#fca5a5" }),
  };
  const beforeBody: StageElement = {
    id: uid(),
    kind: "text",
    name: "Before Copy",
    fit: "hug",
    textLook: { fontFamily: "inter-medium", fontSize: narrow ? 26 : 36, textAlign: "left", lineHeight: 1.4 },
    props: defaultStageProps({
      x: leftX + 40,
      y: leftY + (narrow ? 96 : 118),
      width: cardW - 80,
      height: cardH - 140,
      text: "• Hours of manual keyframing\n• Janky mismatched pacing\n• Static slides viewers skip",
      color: "#e2e8f0",
    }),
  };

  const afterCard: StageElement = {
    id: uid(),
    kind: "shape",
    name: "After Card",
    shape: {
      radius: 28,
      gradient: { to: "rgba(13,148,136,0.34)", angle: 145 },
      stroke: { color: "#2dd4bf", width: 3 },
      shadow: { color: "rgba(45,212,191,0.25)", blur: 40, y: 12 },
    },
    enter: { dx: 40, dy: 0, scale: 0.95, blur: 6 },
    props: defaultStageProps({ x: rightX, y: rightY, width: cardW, height: cardH, color: "rgba(15,23,42,0.8)", visible: false }),
  };
  const afterTag: StageElement = {
    id: uid(),
    kind: "text",
    name: "After Tag",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: 22, textAlign: "left", letterSpacing: 0.12 },
    props: defaultStageProps({ x: rightX + 40, y: rightY + 42, width: cardW - 80, height: 34, text: "AFTER", color: "#5eead4", visible: false }),
  };
  const afterBody: StageElement = {
    id: uid(),
    kind: "text",
    name: "After Copy",
    fit: "hug",
    textLook: { fontFamily: "inter-semibold", fontSize: narrow ? 26 : 36, textAlign: "left", lineHeight: 1.4 },
    props: defaultStageProps({
      x: rightX + 40,
      y: rightY + (narrow ? 96 : 118),
      width: cardW - 80,
      height: cardH - 140,
      text: "• 1-click studio templates\n• Spring physics + beat SFX\n• 60fps GPU preview & export",
      color: "#ffffff",
      visible: false,
    }),
  };

  const link: StageElement = {
    id: uid(),
    kind: "connector",
    name: "Flow Arrow",
    connector: { from: beforeCard.id, to: afterCard.id, style: "dots", thickness: 8, gap: 22, flow: 65, rhythm: 3 },
    props: defaultStageProps({ x: 0, y: 0, width: 0, height: 0, color: "#2dd4bf", visible: false }),
  };

  return {
    id: opts.id ?? uid(),
    name: "Before vs. After",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: { kind: "gradient", from: "#0f172a", to: "#1e1b4b", angle: 135, pattern: "dots" },
    elements: [heading, link, beforeCard, beforeTag, beforeBody, afterCard, afterTag, afterBody],
    beats: [
      { id: uid(), hold: 2.0, sound: "whoosh", changes: {} },
      {
        id: uid(),
        hold: 2.8,
        sound: "sparkle",
        camera: narrow ? { zoom: 1.05, panX: 0, panY: 80, tilt: 0 } : { zoom: 1.08, panX: 110, panY: 20, tilt: 0 },
        changes: {
          [beforeCard.id]: { opacity: 0.45 },
          [beforeTag.id]: { opacity: 0.5 },
          [beforeBody.id]: { opacity: 0.5 },
          [link.id]: { visible: true },
          [afterCard.id]: { visible: true },
          [afterTag.id]: { visible: true },
          [afterBody.id]: { visible: true },
        },
      },
    ],
    spring: "smooth",
    stagger: 0.05,
    wordStagger: 0.05,
    beatSound: "whoosh",
  };
}

function makeQuoteCard(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const padX = narrow ? 56 : 260;
  const contentW = w - padX * 2;
  const mark: StageElement = {
    id: uid(),
    kind: "text",
    name: "Quote Mark",
    fit: "hug",
    textLook: { fontFamily: "playfair-bold", fontSize: narrow ? 140 : 180, textAlign: "left", lineHeight: 0.8 },
    enter: { dx: 0, dy: -24, scale: 0.8, blur: 6 },
    props: defaultStageProps({ x: padX - 12, y: 200, width: 180, height: 140, text: "“", color: "#0d9488" }),
  };
  const quote: StageElement = {
    id: uid(),
    kind: "text",
    name: "Quote",
    fit: "hug",
    textLook: { fontFamily: "playfair", fontSize: narrow ? 44 : 64, italic: true, textAlign: "left", lineHeight: 1.28 },
    textReveal: { by: "word", style: "fade", stagger: 0.055 },
    props: defaultStageProps({
      x: padX,
      y: 330,
      width: contentW,
      height: 360,
      text: "Simplicity is about subtracting the obvious and adding the meaningful.",
      color: "#111827",
    }),
  };
  const author: StageElement = {
    id: uid(),
    kind: "text",
    name: "Attribution",
    fit: "hug",
    textLook: {
      fontFamily: "inter-semibold",
      fontSize: narrow ? 22 : 28,
      textAlign: "left",
      backgroundColor: "#111827",
      cornerStyle: "pill",
      paddingX: 26,
      paddingY: 12,
    },
    enter: { dx: -20, dy: 0, scale: 0.96, blur: 4 },
    props: defaultStageProps({
      x: padX,
      y: narrow ? 740 : 720,
      width: 360,
      height: 58,
      text: "— John Maeda",
      color: "#f8fafc",
      visible: false,
    }),
  };

  return {
    id: opts.id ?? uid(),
    name: "Quote Spotlight",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: { kind: "gradient", from: "#fafaf9", to: "#e7e5e4", angle: 150, pattern: "dots" },
    elements: [mark, quote, author],
    beats: [
      { id: uid(), hold: 2.2, sound: "swoosh", changes: {} },
      { id: uid(), hold: 2.4, sound: "click", changes: { [author.id]: { visible: true } } },
    ],
    spring: "gentle",
    stagger: 0.06,
    wordStagger: 0.05,
    beatSound: "swoosh",
  };
}

function makeFormulaWalkthrough(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const caption: StageElement = {
    id: uid(),
    kind: "text",
    name: "Step Caption",
    fit: "hug",
    textLook: { fontFamily: "inter-semibold", fontSize: narrow ? 26 : 34, textAlign: "center", letterSpacing: 0.04 },
    props: defaultStageProps({
      x: 64,
      y: 190,
      width: w - 128,
      height: 54,
      text: "Start with the quadratic equation",
      color: "#93c5fd",
    }),
  };
  const eq: StageElement = {
    id: uid(),
    kind: "math",
    name: "Equation",
    textLook: { fontSize: narrow ? 62 : 96 },
    props: defaultStageProps({
      x: Math.round(w / 2 - (narrow ? 250 : 480)),
      y: Math.round(STAGE_HEIGHT / 2 - 110),
      width: narrow ? 500 : 960,
      height: 220,
      text: "ax^2 + bx + c = 0",
      color: "#f8fafc",
    }),
  };
  const note: StageElement = {
    id: uid(),
    kind: "text",
    name: "Takeaway",
    fit: "hug",
    textLook: {
      fontFamily: "inter-medium",
      fontSize: narrow ? 22 : 28,
      textAlign: "center",
      backgroundColor: "rgba(59,130,246,0.22)",
      cornerStyle: "pill",
      paddingX: 28,
      paddingY: 12,
    },
    props: defaultStageProps({
      x: Math.round(w / 2 - 260),
      y: 780,
      width: 520,
      height: 58,
      text: "Complete the square to isolate x",
      color: "#bfdbfe",
      visible: false,
    }),
  };

  return {
    id: opts.id ?? uid(),
    name: "Formula Walkthrough",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: { kind: "gradient", from: "#0b1024", to: "#1e1b4b", angle: 140, pattern: "grid" },
    elements: [caption, eq, note],
    beats: [
      { id: uid(), hold: 2.0, sound: "swoosh", camera: { zoom: 1, panX: 0, panY: 0, tilt: 0 }, changes: {} },
      {
        id: uid(),
        hold: 2.2,
        sound: "pop",
        camera: { zoom: 1.08, panX: 0, panY: 0, tilt: 0 },
        changes: {
          [caption.id]: { text: "Divide through by a" },
          [eq.id]: { text: "x^2 + \\frac{b}{a}x + \\frac{c}{a} = 0" },
          [note.id]: { visible: true },
        },
      },
      {
        id: uid(),
        hold: 2.8,
        sound: "sparkle",
        camera: { zoom: 1.14, panX: 0, panY: 0, tilt: 0 },
        changes: {
          [caption.id]: { text: "The quadratic formula" },
          [eq.id]: { text: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}" },
          [note.id]: { text: "Exact roots for any a ≠ 0" },
        },
      },
    ],
    spring: "gentle",
    stagger: 0.05,
    wordStagger: 0.05,
    beatSound: "pop",
  };
}

function makeChapterBumper(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const left = narrow ? 48 : 140;
  const baseY = narrow ? 700 : 740;
  const accentBar: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Accent Strip",
    shape: { radius: 6, gradient: { to: "#38bdf8", angle: 180 } },
    enter: { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0, opacity: 1, wipe: "down" },
    props: defaultStageProps({ x: left, y: baseY, width: 12, height: 154, color: "#2dd4bf" }),
  };
  const backplate: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Lower-Third Plate",
    shape: {
      radius: 20,
      stroke: { color: "rgba(255,255,255,0.14)", width: 1.5 },
      shadow: { color: "rgba(0,0,0,0.45)", blur: 32, y: 12 },
    },
    enter: { dx: -40, dy: 0, scale: 0.98, blur: 6 },
    props: defaultStageProps({
      x: left + 26,
      y: baseY,
      width: narrow ? w - 122 : 840,
      height: 154,
      color: "rgba(15,23,42,0.88)",
    }),
  };
  const kicker: StageElement = {
    id: uid(),
    kind: "text",
    name: "Chapter Tag",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: 22, textAlign: "left", letterSpacing: 0.14 },
    props: defaultStageProps({
      x: left + 56,
      y: baseY + 26,
      width: narrow ? w - 180 : 760,
      height: 32,
      text: "PART 02 · WORKFLOW",
      color: "#5eead4",
    }),
  };
  const title: StageElement = {
    id: uid(),
    kind: "text",
    name: "Chapter Title",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 36 : 48, textAlign: "left" },
    textReveal: { by: "word", style: "slide", stagger: 0.06 },
    props: defaultStageProps({
      x: left + 56,
      y: baseY + 66,
      width: narrow ? w - 180 : 760,
      height: 64,
      text: "Polishing the final cut",
      color: "#ffffff",
    }),
  };

  return {
    id: opts.id ?? uid(),
    name: "Chapter Lower-Third",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: { kind: "gradient", from: "#0f172a", to: "#020617", angle: 135, pattern: "none" },
    elements: [accentBar, backplate, kicker, title],
    beats: [
      { id: uid(), hold: 2.8, sound: "swipe", changes: {} },
    ],
    spring: "snappy",
    stagger: 0.05,
    wordStagger: 0.05,
    beatSound: "swipe",
  };
}

function makeOutroCta(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const cardW = narrow ? Math.round(w * 0.86) : 980;
  const cardH = 440;
  const cx = Math.round((w - cardW) / 2);
  const cy = Math.round((STAGE_HEIGHT - cardH) / 2);

  const card: StageElement = {
    id: uid(),
    kind: "shape",
    name: "CTA Card",
    shape: {
      radius: 36,
      gradient: { to: "#1e1b4b", angle: 135 },
      stroke: { color: "rgba(167,139,250,0.45)", width: 2.5 },
      shadow: { color: "rgba(124,58,237,0.35)", blur: 60, y: 16 },
    },
    enter: { dx: 0, dy: 28, scale: 0.92, blur: 8 },
    props: defaultStageProps({ x: cx, y: cy, width: cardW, height: cardH, color: "#0f172a" }),
  };
  const headline: StageElement = {
    id: uid(),
    kind: "text",
    name: "Headline",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 52 : 76, textAlign: "center", lineHeight: 1.1 },
    textReveal: { by: "word", style: "pop", stagger: 0.07 },
    props: defaultStageProps({
      x: cx + 48,
      y: cy + 78,
      width: cardW - 96,
      height: 150,
      text: "Thanks for watching!",
      color: "#ffffff",
    }),
  };
  const sub: StageElement = {
    id: uid(),
    kind: "text",
    name: "Prompt",
    fit: "hug",
    textLook: { fontFamily: "inter", fontSize: narrow ? 24 : 32, textAlign: "center" },
    props: defaultStageProps({
      x: cx + 48,
      y: cy + 206,
      width: cardW - 96,
      height: 48,
      text: "Subscribe & drop your thoughts below",
      color: "#cbd5e1",
    }),
  };
  const handle: StageElement = {
    id: uid(),
    kind: "text",
    name: "Handle Pill",
    fit: "hug",
    textLook: {
      fontFamily: "inter-bold",
      fontSize: narrow ? 26 : 32,
      textAlign: "center",
      backgroundColor: "#2dd4bf",
      cornerStyle: "pill",
      paddingX: 36,
      paddingY: 14,
    },
    loops: [{ kind: "float", amount: 8, period: 2.8 }],
    enter: { dx: 0, dy: 24, scale: 0.85, blur: 4 },
    props: defaultStageProps({
      x: Math.round(w / 2 - 200),
      y: cy + 292,
      width: 400,
      height: 66,
      text: "@briefcast",
      color: "#090d16",
      visible: false,
    }),
  };

  return {
    id: opts.id ?? uid(),
    name: "Outro & Follow CTA",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: { kind: "gradient", from: "#2e1065", to: "#020617", radial: true, pattern: "dots" },
    elements: [card, headline, sub, handle],
    beats: [
      { id: uid(), hold: 1.6, sound: "whoosh", changes: {} },
      {
        id: uid(),
        hold: 2.8,
        sound: "sparkle",
        camera: { zoom: 1.06, panX: 0, panY: 0, tilt: 0 },
        changes: { [handle.id]: { visible: true } },
      },
    ],
    spring: "bouncy",
    stagger: 0.06,
    wordStagger: 0.05,
    beatSound: "sparkle",
  };
}

// ---------- POWER-USER SIGNATURE TEMPLATES ----------

function makeNeuralPipeline(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const cx = w / 2;
  const cy = STAGE_HEIGHT / 2 + 20;

  const headline: StageElement = {
    id: uid(),
    kind: "text",
    name: "Headline",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 44 : 62, textAlign: "center", letterSpacing: -0.02 },
    textReveal: { by: "word", style: "rise", stagger: 0.06 },
    props: defaultStageProps({ x: 48, y: 74, width: w - 96, height: 80, text: "Real-Time Neural Pipeline", color: "#f8fafc" }),
  };

  const statusPill: StageElement = {
    id: uid(),
    kind: "text",
    name: "Status Pill",
    fit: "hug",
    textLook: {
      fontFamily: "inter-bold",
      fontSize: narrow ? 18 : 22,
      textAlign: "center",
      letterSpacing: 0.12,
      backgroundColor: "rgba(56,189,248,0.18)",
      cornerStyle: "pill",
      paddingX: 24,
      paddingY: 8,
    },
    when: [
      { channel: "throughput", atOrAbove: 80, changes: { color: "#34d399", text: "● LOCKED · 60FPS GPU" } },
    ],
    props: defaultStageProps({
      x: Math.round(cx - 190),
      y: 164,
      width: 380,
      height: 44,
      text: "● WARMING UP PIPELINE",
      color: "#38bdf8",
    }),
  };

  // Concentric spinning halo & reactive sweep gauge at centre
  const outerHalo: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Orbit Halo",
    shape: {
      stroke: { color: "rgba(56,189,248,0.45)", width: 3, align: "center", dash: { style: "dash", length: 24, gap: 18, flow: 65 } },
    },
    loops: [{ kind: "spin", period: 18 }],
    props: defaultStageProps({
      x: Math.round(cx - 175),
      y: Math.round(cy - 175),
      width: 350,
      height: 350,
      color: "rgba(56,189,248,0.05)",
      form: "ellipse",
    }),
  };

  const progressRing: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Throughput Ring",
    shape: { start: 0, caps: "round", shadow: { color: "rgba(56,189,248,0.55)", blur: 28 } },
    bind: { sweep: { channel: "throughput", from: [0, 100], to: [12, 360] } },
    when: [{ channel: "throughput", atOrAbove: 80, changes: { color: "#34d399" } }],
    props: defaultStageProps({
      x: Math.round(cx - 142),
      y: Math.round(cy - 142),
      width: 284,
      height: 284,
      color: "#38bdf8",
      form: "ring",
      inner: 0.84,
      sweep: 24,
    }),
  };

  const coreCard: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Neural Core",
    shape: {
      radius: 112,
      gradient: { to: "#0f172a", angle: 145 },
      stroke: { color: "rgba(255,255,255,0.22)", width: 2 },
      shadow: { color: "rgba(14,165,233,0.45)", blur: 48, y: 12 },
    },
    props: defaultStageProps({
      x: Math.round(cx - 112),
      y: Math.round(cy - 112),
      width: 224,
      height: 224,
      color: "#1e293b",
      form: "ellipse",
    }),
  };

  const coreReadout: StageElement = {
    id: uid(),
    kind: "text",
    name: "Throughput %",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: 54, textAlign: "center", tabularNums: true },
    props: defaultStageProps({
      x: Math.round(cx - 104),
      y: Math.round(cy - 34),
      width: 208,
      height: 68,
      text: "{throughput:fixed1}%",
      color: "#ffffff",
    }),
  };

  const nodeW = narrow ? 240 : 340;
  const nodeH = narrow ? 132 : 164;
  const leftX = narrow ? 36 : Math.round(cx - 670);
  const leftY = narrow ? 240 : Math.round(cy - nodeH / 2);
  const rightX = narrow ? Math.round(w - nodeW - 36) : Math.round(cx + 330);
  const rightY = narrow ? 780 : Math.round(cy - nodeH / 2);

  const ingestNode: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Ingest Node",
    shape: {
      radius: 26,
      gradient: { to: "rgba(15,23,42,0.92)", angle: 150 },
      stroke: { color: "#818cf8", width: 2.5 },
      shadow: { color: "rgba(99,102,241,0.35)", blur: 36, y: 10 },
    },
    enter: { dx: 0, dy: 40, scale: 0.82, blur: 8 },
    props: defaultStageProps({
      x: Math.round(cx - nodeW / 2),
      y: Math.round(cy - nodeH / 2),
      width: nodeW,
      height: nodeH,
      color: "rgba(49,46,129,0.55)",
      rotateY: 16,
      visible: false,
    }),
  };

  const ingestText: StageElement = {
    id: uid(),
    kind: "text",
    name: "Ingest Label",
    fit: "hug",
    textLook: { fontFamily: "inter-semibold", fontSize: narrow ? 24 : 30, textAlign: "center", lineHeight: 1.3 },
    props: defaultStageProps({
      x: leftX + 20,
      y: leftY + Math.round((nodeH - 76) / 2),
      width: nodeW - 40,
      height: 80,
      text: "01 · INGEST\n4K Stream + Audio",
      color: "#e0e7ff",
      visible: false,
    }),
  };

  const outputNode: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Output Node",
    shape: {
      radius: 26,
      gradient: { to: "rgba(6,78,59,0.55)", angle: 150 },
      stroke: { color: "#34d399", width: 2.5 },
      shadow: { color: "rgba(16,185,129,0.38)", blur: 40, y: 12 },
    },
    loops: [{ kind: "float", amount: 8, period: 3.2, from: 2 }],
    enter: { dx: 0, dy: 40, scale: 0.82, blur: 8 },
    props: defaultStageProps({
      x: Math.round(cx - nodeW / 2),
      y: Math.round(cy - nodeH / 2),
      width: nodeW,
      height: nodeH,
      color: "rgba(15,23,42,0.88)",
      rotateY: -16,
      visible: false,
    }),
  };

  const outputText: StageElement = {
    id: uid(),
    kind: "text",
    name: "Output Label",
    fit: "hug",
    textLook: { fontFamily: "inter-semibold", fontSize: narrow ? 24 : 30, textAlign: "center", lineHeight: 1.3 },
    props: defaultStageProps({
      x: rightX + 20,
      y: rightY + Math.round((nodeH - 76) / 2),
      width: nodeW - 40,
      height: 80,
      text: "03 · RENDER\n60fps Master MP4",
      color: "#d1fae5",
      visible: false,
    }),
  };

  const linkIn: StageElement = {
    id: uid(),
    kind: "connector",
    name: "Ingest Link",
    connector: { from: ingestNode.id, to: coreCard.id, style: "dots", thickness: 7, gap: 22, flow: 95, rhythm: 3 },
    props: defaultStageProps({ x: 0, y: 0, width: 0, height: 0, color: "#818cf8", visible: false }),
  };

  const linkOut: StageElement = {
    id: uid(),
    kind: "connector",
    name: "Output Link",
    connector: { from: coreCard.id, to: outputNode.id, style: "dots", thickness: 7, gap: 22, flow: 95, rhythm: 3 },
    props: defaultStageProps({ x: 0, y: 0, width: 0, height: 0, color: "#34d399", visible: false }),
  };

  return {
    id: opts.id ?? uid(),
    name: "AI Pipeline Orbit",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    perspective: 1500,
    background: {
      kind: "gradient",
      from: "#0f172a",
      to: "#020617",
      radial: true,
      motion: 0.45,
      pattern: "grid",
      patternSize: 52,
      patternOpacity: 0.11,
      patternDrift: 16,
      vignette: 0.55,
      glow: 0.35,
      grain: 0.12,
    },
    channels: [
      {
        id: "throughput",
        name: "Throughput",
        format: "fixed1",
        keys: [
          { t: 0.4, value: 8.0, easing: "ease-out" },
          { t: 3.4, value: 64.0, easing: "ease-out" },
          { t: 5.4, value: 99.4, easing: "ease-out" },
        ],
      },
    ],
    elements: [headline, statusPill, linkIn, linkOut, outerHalo, progressRing, coreCard, coreReadout, ingestNode, ingestText, outputNode, outputText],
    beats: [
      {
        id: uid(),
        hold: 1.8,
        sound: "whoosh",
        camera: { zoom: 1.32, panX: 0, panY: 20, tilt: 0 },
        changes: {},
      },
      {
        id: uid(),
        hold: 2.2,
        sound: "pop",
        camera: { zoom: 1, panX: 0, panY: 0, tilt: -1.5 },
        paths: {
          [ingestNode.id]: { bend: 0.32 },
          [outputNode.id]: { bend: -0.32 },
        },
        changes: {
          [ingestNode.id]: { visible: true, x: leftX, y: leftY },
          [outputNode.id]: { visible: true, x: rightX, y: rightY },
          [ingestText.id]: { visible: true },
          [outputText.id]: { visible: true },
          [linkIn.id]: { visible: true },
          [linkOut.id]: { visible: true },
        },
      },
      {
        id: uid(),
        hold: 2.2,
        sound: "sparkle",
        camera: { zoom: 1.16, panX: narrow ? 0 : 280, panY: narrow ? 180 : 12, tilt: 1.5 },
        changes: {
          [ingestNode.id]: { rotateY: 24, opacity: 0.58 },
          [outputNode.id]: { rotateY: 0, scale: 1.08 },
        },
      },
      {
        id: uid(),
        hold: 2.0,
        sound: "swoosh",
        camera: { zoom: 1, panX: 0, panY: 0, tilt: 0 },
        changes: {
          [ingestNode.id]: { rotateY: 12, opacity: 1 },
          [outputNode.id]: { rotateY: -12, scale: 1 },
        },
      },
    ],
    spring: "smooth",
    stagger: 0.05,
    wordStagger: 0.05,
    beatSound: "whoosh",
  };
}

function make3b1bCalculusLab(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const graphW = narrow ? Math.round(w * 0.9) : 1320;
  const graphH = narrow ? 560 : 660;
  const gx = Math.round((w - graphW) / 2);
  const gy = narrow ? 310 : 280;

  const badge: StageElement = {
    id: uid(),
    kind: "text",
    name: "Lab Tag",
    fit: "hug",
    textLook: {
      fontFamily: "inter-bold",
      fontSize: 20,
      textAlign: "center",
      letterSpacing: 0.14,
      backgroundColor: "rgba(88,196,221,0.16)",
      cornerStyle: "pill",
      paddingX: 22,
      paddingY: 8,
    },
    props: defaultStageProps({ x: Math.round(w / 2 - 170), y: 54, width: 340, height: 42, text: "OPTIMIZATION LAB", color: "#58c4dd" }),
  };

  const formula: StageElement = {
    id: uid(),
    kind: "math",
    name: "Loss Equation",
    textLook: { fontSize: narrow ? 46 : 68 },
    props: defaultStageProps({
      x: Math.round(w / 2 - (narrow ? 260 : 460)),
      y: Math.round(STAGE_HEIGHT / 2 - 90),
      width: narrow ? 520 : 920,
      height: 160,
      text: "L(\\theta) = \\frac{\\theta^2}{4} + 0.7\\sin(2\\theta)",
      color: "#f8fafc",
    }),
  };

  const graphEl: StageElement = {
    id: uid(),
    kind: "graph",
    name: "Optimization Curve",
    spring: "slow",
    enter: { dx: 0, dy: 24, scale: 0.96, blur: 4, draw: 0, opacity: 1 },
    props: defaultStageProps({
      x: gx,
      y: gy,
      width: graphW,
      height: graphH,
      color: "#e2e8f0",
      visible: false,
      graph: {
        view: { xMin: -5, xMax: 5, yMin: -1.5, yMax: 6.5 },
        series: [
          { id: "loss", kind: "function", expr: "x^2 / 4 + 0.7 * sin(2 * x)", color: "#58c4dd", width: 5 },
          { id: "deriv", kind: "function", expr: "x / 2 + 1.4 * cos(2 * x)", color: "#fc6255", width: 2.5, dashed: true },
        ],
        markers: [
          { id: "probe", kind: "point", on: "loss", color: "#fbbf24", x: { value: "probeX" }, tangent: true, drops: true, readout: true },
        ],
        axes: true,
        grid: true,
        ticks: true,
        xLabel: "\\theta",
        yLabel: "L(\\theta)",
      },
    }),
  };

  const callout: StageElement = {
    id: uid(),
    kind: "text",
    name: "Converged Badge",
    fit: "hug",
    textLook: {
      fontFamily: "inter-bold",
      fontSize: narrow ? 22 : 28,
      textAlign: "center",
      backgroundColor: "rgba(52,211,153,0.22)",
      cornerStyle: "pill",
      paddingX: 28,
      paddingY: 12,
    },
    enter: { dx: 0, dy: 20, scale: 0.85, blur: 6 },
    props: defaultStageProps({
      x: Math.round(w / 2 - 220),
      y: STAGE_HEIGHT - 110,
      width: 440,
      height: 56,
      text: "✓ Global minimum reached",
      color: "#34d399",
      visible: false,
    }),
  };

  return {
    id: opts.id ?? uid(),
    name: "3B1B Calculus Lab",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: {
      kind: "gradient",
      from: "#090d1f",
      to: "#111c3a",
      angle: 145,
      motion: 0.25,
      pattern: "grid",
      patternSize: 64,
      patternOpacity: 0.08,
      vignette: 0.55,
      glow: 0.25,
      grain: 0.08,
    },
    channels: [
      {
        id: "probeX",
        name: "Theta",
        format: "fixed2",
        keys: [
          { t: 1.8, value: -3.6, easing: "ease-out" },
          { t: 4.5, value: 3.4, easing: "ease-out" },
        ],
      },
    ],
    elements: [badge, graphEl, formula, callout],
    beats: [
      {
        id: uid(),
        hold: 1.8,
        sound: "swoosh",
        camera: { zoom: 1.15, panX: 0, panY: 0, tilt: 0 },
        changes: {},
      },
      {
        id: uid(),
        hold: 2.8,
        sound: "whoosh",
        camera: { zoom: 1, panX: 0, panY: 0, tilt: 0 },
        changes: {
          [formula.id]: { y: 112, scale: 0.78 },
          [graphEl.id]: { visible: true },
        },
      },
      {
        id: uid(),
        hold: 3.0,
        sound: "pop",
        camera: { zoom: 1.12, panX: 0, panY: 60, tilt: 0 },
        changes: {
          [formula.id]: { text: "\\theta_{t+1} = \\theta_t - \\eta \\nabla L(\\theta_t)" },
          [graphEl.id]: {
            graph: {
              view: { xMin: -4.2, xMax: 4.4, yMin: -1.4, yMax: 5.5 },
              series: [
                { id: "loss", kind: "function", expr: "x^2 / 4 + 0.7 * sin(2 * x)", color: "#58c4dd", width: 5 },
              ],
              markers: [
                { id: "basin", kind: "area", on: "loss", color: "#34d399", from: -1.6, to: 0.2 },
                { id: "ball", kind: "descent", on: "loss", color: "#fc6255", x0: 3.4, rate: 0.18, steps: 22, seconds: 2.4 },
              ],
              axes: true,
              grid: true,
              ticks: true,
              xLabel: "\\theta",
              yLabel: "L(\\theta)",
            },
          },
        },
      },
      {
        id: uid(),
        hold: 2.0,
        sound: "sparkle",
        camera: { zoom: 1.24, panX: narrow ? -20 : -90, panY: 140, tilt: 0 },
        changes: {
          [callout.id]: { visible: true },
        },
      },
    ],
    spring: "gentle",
    stagger: 0.05,
    wordStagger: 0.05,
    beatSound: "swoosh",
  };
}

function make3dKeynoteStack(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const cardW = narrow ? 360 : 500;
  const cardH = narrow ? 420 : 520;
  const cx = w / 2;
  const cy = STAGE_HEIGHT / 2 + 40;

  const cardsSpec = [
    { name: "Card Left", title: "01 · SPEED", copy: "Native GPU shaders\nrender at 60fps.", from: "#1e1b4b", to: "#312e81", stroke: "#818cf8" },
    { name: "Card Center", title: "02 · PRECISION", copy: "Closed-form springs\nwith zero keyframes.", from: "#0f172a", to: "#134e4a", stroke: "#2dd4bf" },
    { name: "Card Right", title: "03 · IMPACT", copy: "Camera motion &\nbeat SFX built in.", from: "#3b0764", to: "#831843", stroke: "#f472b6" },
  ];

  const offsetX = narrow ? 155 : 460;
  const baseX = [Math.round(cx - cardW / 2 - offsetX), Math.round(cx - cardW / 2), Math.round(cx - cardW / 2 + offsetX)];
  const baseY = Math.round(cy - cardH / 2);

  const heroTitle: StageElement = {
    id: uid(),
    kind: "text",
    name: "Showcase Title",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 44 : 66, textAlign: "center", letterSpacing: -0.02 },
    textReveal: { by: "word", style: "pop", stagger: 0.07 },
    props: defaultStageProps({ x: 48, y: 70, width: w - 96, height: 84, text: "Built for Power Creators", color: "#ffffff" }),
  };

  const elements: StageElement[] = [heroTitle];
  const cardIds: string[] = [];
  const labelIds: string[] = [];
  const copyIds: string[] = [];

  cardsSpec.forEach((spec, i) => {
    const isMid = i === 1;
    const card: StageElement = {
      id: uid(),
      kind: "shape",
      name: spec.name,
      shape: {
        radius: 32,
        gradient: { to: spec.to, angle: 145 },
        stroke: { color: spec.stroke, width: 3 },
        shadow: { color: "rgba(0,0,0,0.55)", blur: 48, y: 20 },
      },
      enter: { dx: 0, dy: 80, scale: 0.85, blur: 10, rotateX: 18 },
      props: defaultStageProps({
        x: baseX[i],
        y: baseY,
        width: cardW,
        height: cardH,
        color: spec.from,
        rotateY: i === 0 ? 30 : i === 2 ? -30 : 0,
        z: isMid ? 90 : -140,
        opacity: isMid ? 1 : 0.78,
      }),
    };
    const tag: StageElement = {
      id: uid(),
      kind: "text",
      name: `${spec.name} Tag`,
      fit: "hug",
      textLook: { fontFamily: "inter-bold", fontSize: narrow ? 20 : 24, textAlign: "left", letterSpacing: 0.14 },
      props: defaultStageProps({
        x: baseX[i] + 38,
        y: baseY + 52,
        width: cardW - 76,
        height: 36,
        text: spec.title,
        color: spec.stroke,
        rotateY: i === 0 ? 30 : i === 2 ? -30 : 0,
        z: isMid ? 102 : -132,
        opacity: isMid ? 1 : 0.78,
      }),
    };
    const copy: StageElement = {
      id: uid(),
      kind: "text",
      name: `${spec.name} Copy`,
      fit: "hug",
      textLook: { fontFamily: "inter-semibold", fontSize: narrow ? 28 : 38, textAlign: "left", lineHeight: 1.32 },
      props: defaultStageProps({
        x: baseX[i] + 38,
        y: baseY + 132,
        width: cardW - 76,
        height: 220,
        text: spec.copy,
        color: "#f8fafc",
        rotateY: i === 0 ? 30 : i === 2 ? -30 : 0,
        z: isMid ? 102 : -132,
        opacity: isMid ? 1 : 0.78,
      }),
    };
    elements.push(card, tag, copy);
    cardIds.push(card.id);
    labelIds.push(tag.id);
    copyIds.push(copy.id);
  });

  const cardState = (focusIdx: number): StageBeat["changes"] => {
    const ch: StageBeat["changes"] = {};
    for (let i = 0; i < 3; i++) {
      const rel = i - focusIdx;
      const rotY = rel === 0 ? 0 : rel < 0 ? 32 : -32;
      const z = rel === 0 ? 120 : -150;
      const opacity = rel === 0 ? 1 : 0.55;
      const scale = rel === 0 ? 1.06 : 0.92;
      ch[cardIds[i]] = { rotateY: rotY, z, opacity, scale };
      ch[labelIds[i]] = { rotateY: rotY, z: z + 12, opacity, scale };
      ch[copyIds[i]] = { rotateY: rotY, z: z + 12, opacity, scale };
    }
    return ch;
  };

  const flatAll: StageBeat["changes"] = {};
  for (let i = 0; i < 3; i++) {
    flatAll[cardIds[i]] = { rotateY: 0, z: 0, opacity: 1, scale: 1 };
    flatAll[labelIds[i]] = { rotateY: 0, z: 8, opacity: 1, scale: 1 };
    flatAll[copyIds[i]] = { rotateY: 0, z: 8, opacity: 1, scale: 1 };
  }

  return {
    id: opts.id ?? uid(),
    name: "3D Keynote Showcase",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    perspective: 1350,
    background: {
      kind: "gradient",
      from: "#1e1b4b",
      to: "#09090b",
      radial: true,
      motion: 0.4,
      pattern: "dots",
      patternSize: 44,
      patternOpacity: 0.14,
      patternDrift: 14,
      vignette: 0.62,
      glow: 0.35,
      grain: 0.14,
    },
    elements,
    beats: [
      { id: uid(), hold: 1.8, sound: "boom", camera: { zoom: 1.04, panX: 0, panY: 0, tilt: 0 }, changes: {} },
      {
        id: uid(),
        hold: 2.0,
        sound: "whoosh",
        camera: { zoom: 1.12, panX: narrow ? -90 : -240, panY: 16, tilt: -2.2 },
        changes: cardState(0),
      },
      {
        id: uid(),
        hold: 2.0,
        sound: "whoosh",
        camera: { zoom: 1.12, panX: narrow ? 90 : 240, panY: 16, tilt: 2.2 },
        changes: cardState(2),
      },
      {
        id: uid(),
        hold: 2.2,
        sound: "sparkle",
        camera: { zoom: 1, panX: 0, panY: 0, tilt: 0 },
        changes: flatAll,
      },
    ],
    spring: "smooth",
    stagger: 0.04,
    wordStagger: 0.05,
    beatSound: "whoosh",
  };
}

function makeLiquidMorph(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const cx = w / 2;
  const shapeSize = narrow ? 320 : 400;
  const sy = narrow ? 250 : 230;

  const halo: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Marching Halo",
    shape: {
      stroke: { color: "rgba(255,255,255,0.28)", width: 3, align: "outside", dash: { style: "dash", length: 22, gap: 16, flow: 70 } },
    },
    loops: [{ kind: "spin", period: 22 }],
    props: defaultStageProps({
      x: Math.round(cx - shapeSize * 0.62),
      y: Math.round(sy - shapeSize * 0.12),
      width: Math.round(shapeSize * 1.24),
      height: Math.round(shapeSize * 1.24),
      color: "rgba(255,255,255,0.02)",
      form: "ellipse",
    }),
  };

  const heroShape: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Morphing Emblem",
    shape: {
      radius: 26,
      gradient: { to: "#6366f1", angle: 135 },
      shadow: { color: "rgba(56,189,248,0.45)", blur: 52, y: 14 },
      caps: "round",
    },
    loops: [{ kind: "breathe", amount: 0.04, period: 3.4 }],
    enter: { dx: 0, dy: 0, scale: 0.35, blur: 16, rotate: -45 },
    props: defaultStageProps({
      x: Math.round(cx - shapeSize / 2),
      y: sy,
      width: shapeSize,
      height: shapeSize,
      color: "#06b6d4",
      form: "polygon",
      sides: 6,
      radius: 24,
    }),
  };

  const sat1: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Orbit Dot 1",
    loops: [{ kind: "orbit", amount: narrow ? 185 : 245, period: 5.2, phase: 0 }],
    props: defaultStageProps({ x: Math.round(cx - 14), y: Math.round(sy + shapeSize / 2 - 14), width: 28, height: 28, color: "#38bdf8", form: "ellipse" }),
  };

  const sat2: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Orbit Dot 2",
    loops: [{ kind: "orbit", amount: narrow ? 185 : 245, period: 5.2, phase: 0.5 }],
    props: defaultStageProps({ x: Math.round(cx - 12), y: Math.round(sy + shapeSize / 2 - 12), width: 24, height: 24, color: "#f472b6", form: "ellipse" }),
  };

  const morphTitle: StageElement = {
    id: uid(),
    kind: "text",
    name: "Morphing Headline",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 52 : 82, textAlign: "center", letterSpacing: -0.02 },
    props: defaultStageProps({
      x: 48,
      y: sy + shapeSize + 92,
      width: w - 96,
      height: 110,
      text: "One raw idea",
      color: "#f8fafc",
    }),
  };

  const pctBadge: StageElement = {
    id: uid(),
    kind: "text",
    name: "Center Readout",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 48 : 66, textAlign: "center", tabularNums: true },
    props: defaultStageProps({
      x: Math.round(cx - 120),
      y: Math.round(sy + shapeSize / 2 - 40),
      width: 240,
      height: 80,
      text: "{impact:pct}",
      color: "#ffffff",
      visible: false,
    }),
  };

  return {
    id: opts.id ?? uid(),
    name: "Liquid Shape Morph",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: {
      kind: "gradient",
      from: "#0f172a",
      to: "#311042",
      angle: 135,
      motion: 0.55,
      pattern: "dots",
      patternSize: 38,
      patternOpacity: 0.16,
      patternDrift: 18,
      vignette: 0.52,
      glow: 0.35,
      grain: 0.12,
    },
    channels: [
      {
        id: "impact",
        name: "Impact",
        format: "pct",
        keys: [
          { t: 3.8, value: 0, easing: "ease-out" },
          { t: 5.8, value: 100, easing: "ease-out" },
        ],
      },
    ],
    elements: [halo, heroShape, sat1, sat2, pctBadge, morphTitle],
    beats: [
      { id: uid(), hold: 1.9, sound: "whoosh", camera: { zoom: 1, panX: 0, panY: 0, tilt: 0 }, changes: {} },
      {
        id: uid(),
        hold: 2.0,
        sound: "pop",
        camera: { zoom: 1.08, panX: 0, panY: -10, tilt: 2 },
        changes: {
          [heroShape.id]: { form: "star", sides: 5, inner: 0.48, radius: 14, color: "#ec4899", rotation: 18 },
          [morphTitle.id]: { text: "One viral story" },
        },
      },
      {
        id: uid(),
        hold: 2.2,
        sound: "sparkle",
        camera: { zoom: 1.12, panX: 0, panY: -20, tilt: -1.5 },
        changes: {
          [heroShape.id]: { form: "ring", inner: 0.72, sweep: 320, color: "#2dd4bf", rotation: 0 },
          [pctBadge.id]: { visible: true },
          [morphTitle.id]: { text: "One complete flow" },
        },
      },
      {
        id: uid(),
        hold: 2.0,
        sound: "boom",
        camera: { zoom: 1.18, panX: 0, panY: 0, tilt: 0 },
        changes: {
          [heroShape.id]: { form: "arrow", inner: 0.46, radius: 14, color: "#38bdf8", rotation: 0 },
          [pctBadge.id]: { visible: false },
          [morphTitle.id]: { text: "Ready to launch" },
        },
      },
    ],
    spring: "bouncy",
    stagger: 0.05,
    wordStagger: 0.05,
    beatSound: "pop",
  };
}

function makeTelemetryHud(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const padX = narrow ? 36 : 120;
  const contentW = w - padX * 2;
  const gaugeSize = narrow ? 156 : 230;
  const gaugeGap = Math.round((contentW - gaugeSize * 3) / 2);
  const gaugeY = narrow ? 175 : 190;

  const header: StageElement = {
    id: uid(),
    kind: "text",
    name: "HUD Header",
    fit: "hug",
    textLook: { fontFamily: "jetbrains-mono", fontSize: narrow ? 24 : 32, textAlign: "left", letterSpacing: 0.08 },
    props: defaultStageProps({ x: padX, y: 74, width: contentW, height: 46, text: "SYSTEM TELEMETRY // LIVE GPU", color: "#5eead4" }),
  };

  const statusTag: StageElement = {
    id: uid(),
    kind: "text",
    name: "System Status",
    fit: "hug",
    textLook: {
      fontFamily: "jetbrains-mono",
      fontSize: narrow ? 16 : 20,
      textAlign: "right",
      backgroundColor: "rgba(251,191,36,0.18)",
      cornerStyle: "pill",
      paddingX: 18,
      paddingY: 8,
    },
    when: [{ channel: "fps", atOrAbove: 58, changes: { color: "#34d399", text: "● ALL SYSTEMS OPTIMAL" } }],
    loops: [{ kind: "heartbeat", amount: 0.05, period: 1.8, from: 2 }],
    props: defaultStageProps({
      x: Math.round(w - padX - 320),
      y: 70,
      width: 320,
      height: 44,
      text: "● CALIBRATING…",
      color: "#fbbf24",
    }),
  };

  const gauges = [
    { ch: "fps", label: "FRAME RATE", token: "{fps:int}", color: "#2dd4bf", from: [0, 60] as [number, number] },
    { ch: "gpu", label: "GPU ACCEL", token: "{gpu:pct}", color: "#38bdf8", from: [0, 100] as [number, number] },
    { ch: "speed", label: "ENCODE X", token: "{speed:fixed1}x", color: "#a78bfa", from: [0, 12] as [number, number] },
  ];

  const elements: StageElement[] = [header, statusTag];
  gauges.forEach((g, idx) => {
    const gx = padX + idx * (gaugeSize + gaugeGap);
    const track: StageElement = {
      id: uid(),
      kind: "shape",
      name: `${g.label} Track`,
      props: defaultStageProps({
        x: gx,
        y: gaugeY,
        width: gaugeSize,
        height: gaugeSize,
        color: "rgba(255,255,255,0.08)",
        form: "ring",
        inner: 0.8,
        sweep: 360,
      }),
    };
    const ring: StageElement = {
      id: uid(),
      kind: "shape",
      name: `${g.label} Ring`,
      shape: { start: 0, caps: "round", shadow: { color: g.color, blur: 22 } },
      bind: { sweep: { channel: g.ch, from: g.from, to: [8, 340] } },
      props: defaultStageProps({
        x: gx,
        y: gaugeY,
        width: gaugeSize,
        height: gaugeSize,
        color: g.color,
        form: "ring",
        inner: 0.8,
        sweep: 12,
      }),
    };
    const val: StageElement = {
      id: uid(),
      kind: "text",
      name: `${g.label} Value`,
      fit: "hug",
      textLook: { fontFamily: "jetbrains-mono", fontSize: narrow ? 32 : 48, textAlign: "center", tabularNums: true, bold: true },
      props: defaultStageProps({
        x: gx + 12,
        y: gaugeY + Math.round(gaugeSize * 0.34),
        width: gaugeSize - 24,
        height: 60,
        text: g.token,
        color: "#ffffff",
      }),
    };
    const cap: StageElement = {
      id: uid(),
      kind: "text",
      name: `${g.label} Caption`,
      fit: "hug",
      textLook: { fontFamily: "inter-semibold", fontSize: narrow ? 13 : 16, textAlign: "center", letterSpacing: 0.14 },
      props: defaultStageProps({
        x: gx + 12,
        y: gaugeY + Math.round(gaugeSize * 0.62),
        width: gaugeSize - 24,
        height: 26,
        text: g.label,
        color: "#94a3b8",
      }),
    };
    elements.push(track, ring, val, cap);
  });

  const waveY = gaugeY + gaugeSize + 56;
  const waveH = STAGE_HEIGHT - waveY - 72;
  const waveFrame: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Signal Panel",
    shape: {
      radius: 24,
      stroke: { color: "rgba(45,212,191,0.3)", width: 2 },
    },
    enter: { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0, opacity: 1, wipe: "right" },
    props: defaultStageProps({
      x: padX,
      y: waveY,
      width: contentW,
      height: waveH,
      color: "rgba(2,6,23,0.68)",
    }),
  };

  const waveGraph: StageElement = {
    id: uid(),
    kind: "graph",
    name: "Live Signal Wave",
    props: defaultStageProps({
      x: padX + 20,
      y: waveY + 14,
      width: contentW - 40,
      height: waveH - 28,
      color: "#64748b",
      graph: {
        view: { xMin: -6, xMax: 6, yMin: -1.6, yMax: 1.6 },
        series: [
          { id: "sig1", kind: "function", expr: "sin(x * 1.3 - t * 3.8) * exp(-0.04 * x^2)", color: "#2dd4bf", width: 4 },
          { id: "sig2", kind: "function", expr: "0.55 * cos(x * 2.1 + t * 2.6) * exp(-0.06 * x^2)", color: "#38bdf8", width: 2.5, dashed: true },
        ],
        markers: [],
        axes: false,
        grid: true,
        ticks: false,
      },
    }),
  };

  elements.push(waveFrame, waveGraph);

  return {
    id: opts.id ?? uid(),
    name: "Live Telemetry HUD",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: {
      kind: "gradient",
      from: "#030712",
      to: "#042f2e",
      angle: 160,
      motion: 0.35,
      pattern: "grid",
      patternSize: 44,
      patternOpacity: 0.12,
      patternColor: "#2dd4bf",
      patternDrift: 22,
      vignette: 0.65,
      glow: 0.25,
      grain: 0.14,
    },
    channels: [
      { id: "fps", name: "FPS", format: "int", keys: [{ t: 0.2, value: 12, easing: "ease-out" }, { t: 2.6, value: 60, easing: "ease-out" }] },
      { id: "gpu", name: "GPU", format: "pct", keys: [{ t: 0.2, value: 14, easing: "ease-out" }, { t: 2.8, value: 96, easing: "ease-out" }] },
      { id: "speed", name: "Speed", format: "fixed1", keys: [{ t: 0.3, value: 1.0, easing: "ease-out" }, { t: 3.0, value: 11.4, easing: "ease-out" }] },
    ],
    elements,
    beats: [
      { id: uid(), hold: 2.2, sound: "click", camera: { zoom: 1, panX: 0, panY: 0, tilt: 0 }, changes: {} },
      { id: uid(), hold: 2.4, sound: "swoosh", camera: { zoom: 1.18, panX: 0, panY: 160, tilt: 0 }, changes: {} },
      { id: uid(), hold: 2.2, sound: "sparkle", camera: { zoom: 1, panX: 0, panY: 0, tilt: 0 }, changes: {} },
    ],
    spring: "snappy",
    stagger: 0.04,
    wordStagger: 0.04,
    beatSound: "click",
  };
}

function makeCinemaTrailer(opts: { width: number; startTime: number; id?: string; layer?: number }): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const cx = w / 2;
  const cy = STAGE_HEIGHT / 2;

  const topBar: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Letterbox Top",
    enter: { dx: 0, dy: -110, scale: 1, blur: 0, opacity: 1 },
    props: defaultStageProps({ x: 0, y: 0, width: w, height: 104, color: "#000000" }),
  };

  const botBar: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Letterbox Bottom",
    enter: { dx: 0, dy: 110, scale: 1, blur: 0, opacity: 1 },
    props: defaultStageProps({ x: 0, y: STAGE_HEIGHT - 104, width: w, height: 104, color: "#000000" }),
  };

  const beam: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Light Beam",
    shape: { radius: 4, gradient: { to: "#f97316", angle: 90 }, shadow: { color: "rgba(251,146,60,0.8)", blur: 32 } },
    enter: { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0, opacity: 1, wipe: "centre" },
    props: defaultStageProps({
      x: Math.round(cx - (narrow ? 220 : 460)),
      y: Math.round(cy + 88),
      width: narrow ? 440 : 920,
      height: 5,
      color: "#fbbf24",
      visible: false,
    }),
  };

  const emblem: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Cinema Emblem",
    shape: {
      stroke: { color: "rgba(251,191,36,0.5)", width: 3 },
      shadow: { color: "rgba(249,115,22,0.45)", blur: 60 },
    },
    loops: [{ kind: "pulse", amount: 0.05, period: 2.6 }],
    props: defaultStageProps({
      x: Math.round(cx - 210),
      y: Math.round(cy - 210),
      width: 420,
      height: 420,
      color: "rgba(249,115,22,0.12)",
      form: "diamond",
      rotation: 0,
      visible: false,
    }),
  };

  const hero: StageElement = {
    id: uid(),
    kind: "text",
    name: "Trailer Headline",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 62 : 118, textAlign: "center", letterSpacing: 0.08, lineHeight: 1.05 },
    textReveal: { by: "letter", style: "zoom", stagger: 0.032 },
    props: defaultStageProps({
      x: 48,
      y: Math.round(cy - (narrow ? 68 : 88)),
      width: w - 96,
      height: 180,
      text: "THE NEXT ERA",
      color: "#fff7ed",
    }),
  };

  const tagline: StageElement = {
    id: uid(),
    kind: "text",
    name: "Launch Tagline",
    fit: "hug",
    textLook: {
      fontFamily: "inter-semibold",
      fontSize: narrow ? 22 : 30,
      textAlign: "center",
      letterSpacing: 0.22,
    },
    enter: { dx: 0, dy: 24, scale: 1, blur: 10 },
    props: defaultStageProps({
      x: 64,
      y: Math.round(cy + 124),
      width: w - 128,
      height: 48,
      text: "AVAILABLE NOW · V0.1.8",
      color: "#fdba74",
      visible: false,
    }),
  };

  return {
    id: opts.id ?? uid(),
    name: "Cinema Trailer Reveal",
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: {
      kind: "gradient",
      from: "#451a03",
      to: "#09050a",
      radial: true,
      motion: 0.6,
      pattern: "none",
      vignette: 0.78,
      glow: 0.45,
      grain: 0.22,
    },
    elements: [emblem, beam, hero, tagline, topBar, botBar],
    beats: [
      {
        id: uid(),
        hold: 1.7,
        sound: "boom",
        camera: { zoom: 1.38, panX: 0, panY: 0, tilt: -3 },
        changes: {},
      },
      {
        id: uid(),
        hold: 1.7,
        sound: "whoosh",
        camera: { zoom: 1.08, panX: 0, panY: 0, tilt: 2 },
        changes: {
          [hero.id]: { text: "STARTS RIGHT NOW" },
          [beam.id]: { visible: true },
        },
      },
      {
        id: uid(),
        hold: 2.0,
        sound: "boom",
        camera: { zoom: 1, panX: 0, panY: 0, tilt: 0 },
        changes: {
          [emblem.id]: { visible: true, form: "ring", inner: 0.88, sweep: 360 },
          [hero.id]: { text: "BRIEFCAST PRO" },
        },
      },
      {
        id: uid(),
        hold: 2.2,
        sound: "sparkle",
        camera: { zoom: 1.12, panX: 0, panY: 14, tilt: 0 },
        changes: {
          [tagline.id]: { visible: true },
        },
      },
    ],
    spring: "snappy",
    stagger: 0.04,
    wordStagger: 0.04,
    beatSound: "boom",
  };
}

export const STAGE_TEMPLATES: StageTemplateMeta[] = [
  {
    id: "neural-pipeline",
    name: "AI Pipeline Orbit",
    category: "Pro",
    pro: true,
    description: "3D nodes arcing on Bezier paths, reactive throughput ring, threshold color flip & camera sweeps",
    previewFrom: "#0f172a",
    previewTo: "#020617",
    accent: "#38bdf8",
    beatCount: 4,
    build: makeNeuralPipeline,
  },
  {
    id: "3b1b-calculus-lab",
    name: "3B1B Calculus Lab",
    category: "Pro",
    pro: true,
    description: "Morphing LaTeX + live sliding tangent probe + animated gradient descent ball & integral shading",
    previewFrom: "#090d1f",
    previewTo: "#111c3a",
    accent: "#58c4dd",
    beatCount: 4,
    build: make3b1bCalculusLab,
  },
  {
    id: "3d-keynote-stack",
    name: "3D Keynote Stack",
    category: "Pro",
    pro: true,
    description: "True 3D depth card carousel with perspective rotation, camera roll & glowing radial backdrop",
    previewFrom: "#1e1b4b",
    previewTo: "#09090b",
    accent: "#f472b6",
    beatCount: 4,
    build: make3dKeynoteStack,
  },
  {
    id: "liquid-morph",
    name: "Liquid Shape Morph",
    category: "Pro",
    pro: true,
    description: "GPU SDF morph (Hexagon → Star → Ring → Arrow) with orbiting satellites & word-morphing headline",
    previewFrom: "#0f172a",
    previewTo: "#311042",
    accent: "#ec4899",
    beatCount: 4,
    build: makeLiquidMorph,
  },
  {
    id: "telemetry-hud",
    name: "Live Telemetry HUD",
    category: "Pro",
    pro: true,
    description: "3 live channel-bound radial gauges, 60fps real-time signal wave graph & threshold status alert",
    previewFrom: "#030712",
    previewTo: "#042f2e",
    accent: "#2dd4bf",
    beatCount: 3,
    build: makeTelemetryHud,
  },
  {
    id: "cinema-trailer",
    name: "Cinema Trailer",
    category: "Pro",
    pro: true,
    description: "Widescreen letterbox reveal, tilted whip-zoom camera, letter-zoom kinetic type & film grain",
    previewFrom: "#451a03",
    previewTo: "#09050a",
    accent: "#fbbf24",
    beatCount: 4,
    build: makeCinemaTrailer,
  },
  {
    id: "kinetic-intro",
    name: "Kinetic Title",
    category: "Intro",
    description: "Badge, word-reveal title, wiping bar & camera push",
    previewFrom: "#0f172a",
    previewTo: "#134e4a",
    accent: "#2dd4bf",
    beatCount: 2,
    build: makeKineticIntro,
  },
  {
    id: "three-steps",
    name: "3-Step Reveal",
    category: "Explainer",
    description: "Progressive 3-step cards with spotlight focus",
    previewFrom: "#0b1024",
    previewTo: "#1e293b",
    accent: "#38bdf8",
    beatCount: 4,
    build: makeThreeSteps,
  },
  {
    id: "kpi-counter",
    name: "Big KPI Counter",
    category: "Data",
    description: "Animated live counter 0 → 124,800+ & trend pill",
    previewFrom: "#1e293b",
    previewTo: "#020617",
    accent: "#34d399",
    beatCount: 2,
    build: makeKpiCounter,
  },
  {
    id: "before-after",
    name: "Before vs. After",
    category: "Explainer",
    description: "Split comparison cards with flowing connector",
    previewFrom: "#0f172a",
    previewTo: "#1e1b4b",
    accent: "#2dd4bf",
    beatCount: 2,
    build: makeBeforeAfter,
  },
  {
    id: "quote-card",
    name: "Quote Spotlight",
    category: "Social",
    description: "Editorial serif quote on dot-paper background",
    previewFrom: "#fafaf9",
    previewTo: "#e7e5e4",
    accent: "#0d9488",
    beatCount: 2,
    build: makeQuoteCard,
  },
  {
    id: "formula-walkthrough",
    name: "Formula Proof",
    category: "Explainer",
    description: "3-beat LaTeX equation morph on engineering grid",
    previewFrom: "#0b1024",
    previewTo: "#1e1b4b",
    accent: "#60a5fa",
    beatCount: 3,
    build: makeFormulaWalkthrough,
  },
  {
    id: "chapter-bumper",
    name: "Chapter Card",
    category: "Intro",
    description: "Snappy lower-third banner with wiping accent",
    previewFrom: "#0f172a",
    previewTo: "#020617",
    accent: "#5eead4",
    beatCount: 1,
    build: makeChapterBumper,
  },
  {
    id: "outro-cta",
    name: "Outro CTA",
    category: "Social",
    description: "Follow card with floating handle & sparkle SFX",
    previewFrom: "#2e1065",
    previewTo: "#020617",
    accent: "#a78bfa",
    beatCount: 2,
    build: makeOutroCta,
  },
];

// Applies a built-in template onto an existing scene while keeping its timeline ID, startTime, and aspect.
export function applyTemplateToScene(existing: StageScene, templateId: string): StageScene {
  const meta = STAGE_TEMPLATES.find((t) => t.id === templateId);
  if (!meta) return existing;
  return meta.build({
    id: existing.id,
    startTime: existing.startTime,
    layer: existing.layer,
    width: existing.width,
  });
}

// Helper for CSS preview swatches of any StageBackground (color or gradient).
export function stageBackgroundCss(bg: StageBackground): string {
  if (bg.kind === "none") return "transparent";
  if (bg.kind === "color") return bg.color;
  if (bg.radial) return `radial-gradient(circle at center, ${bg.from}, ${bg.to})`;
  return `linear-gradient(${bg.angle ?? 135}deg, ${bg.from}, ${bg.to})`;
}
