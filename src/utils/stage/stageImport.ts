// utils/stage/stageImport.ts
//
// Converts Briefcast Whiteboard Mind Maps, Briefcast Docs, and pasted Markdown/bullet outlines
// directly into multi-beat animated Stage scenes with spring choreography, flowing connectors,
// and camera framing.
import { invoke } from "@tauri-apps/api/core";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type { WhiteboardDocument, WhiteboardNode, WhiteboardPage, WhiteboardSummary } from "../whiteboardTypes";
import type { DocSummary } from "../docTypes";
import { STAGE_HEIGHT, StageBeat, StageElement, StageScene, defaultStageProps } from "./stageTypes";

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `imp_${Math.random().toString(36).slice(2, 10)}`;

export interface StageImportOptions {
  width: number;
  startTime: number;
  id?: string;
  layer?: number;
  dark?: boolean;
}

export interface ParsedOutline {
  title: string;
  bullets: string[];
}

// Parses Markdown headings/bullets or plain multi-line text into a scene title + concise bullet items.
export function parseOutlineText(raw: string, fallbackTitle = "Key Takeaways"): ParsedOutline {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let title = fallbackTitle;
  const bullets: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch && i === 0) {
      title = headingMatch[1].trim();
      continue;
    }
    const bulletMatch = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (bulletMatch) {
      bullets.push(bulletMatch[1].trim());
    } else if (i === 0 && lines.length > 1 && line.length <= 72) {
      title = line;
    } else {
      bullets.push(line.replace(/^#{1,6}\s+/, "").trim());
    }
  }
  return {
    title: title.slice(0, 84) || fallbackTitle,
    bullets: bullets.filter(Boolean).slice(0, 6).map((b) => b.slice(0, 120)),
  };
}

// Builds a multi-beat Title + Progressive Bullet-Reveal scene from a heading and bullet list.
export function sceneFromOutline(title: string, bullets: string[], opts: StageImportOptions): StageScene {
  const w = opts.width;
  const narrow = w < 1000;
  const dark = opts.dark ?? true;
  const items = bullets.length > 0 ? bullets.slice(0, 6) : ["Point one", "Point two", "Point three"];
  const ink = dark ? "#f8fafc" : "#111827";
  const subInk = dark ? "#94a3b8" : "#475569";
  const accent = dark ? "#2dd4bf" : "#0d9488";
  const cardBg = dark ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.06)";

  const padX = narrow ? Math.round(w * 0.08) : Math.round(w * 0.11);
  const contentW = w - padX * 2;
  const titleSize = narrow ? 48 : 66;
  const itemSize = narrow ? 30 : 38;
  const rowH = narrow ? 96 : 104;
  const gapY = narrow ? 18 : 22;

  const titleEl: StageElement = {
    id: uid(),
    kind: "text",
    name: "Title",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: titleSize, textAlign: "left", lineHeight: 1.15 },
    textReveal: { by: "word", style: "rise", stagger: 0.06 },
    props: defaultStageProps({
      x: padX,
      y: Math.round(STAGE_HEIGHT * 0.38),
      width: contentW,
      height: titleSize * 1.4,
      text: title,
      color: ink,
    }),
  };

  const kickerEl: StageElement = {
    id: uid(),
    kind: "text",
    name: "Kicker",
    fit: "hug",
    textLook: { fontFamily: "inter-semibold", fontSize: narrow ? 20 : 24, textAlign: "left", letterSpacing: 0.12 },
    props: defaultStageProps({
      x: padX,
      y: Math.round(STAGE_HEIGHT * 0.32),
      width: contentW,
      height: 36,
      text: `${items.length} KEY POINTS`,
      color: accent,
    }),
  };

  const elements: StageElement[] = [kickerEl, titleEl];
  const rowCardIds: string[] = [];
  const rowBadgeIds: string[] = [];
  const rowTextIds: string[] = [];

  const listTop = narrow ? 245 : 260;
  const maxVisibleRows = Math.min(items.length, 6);
  const effectiveRowH = Math.min(rowH, Math.floor((STAGE_HEIGHT - listTop - 72 - gapY * (maxVisibleRows - 1)) / Math.max(1, maxVisibleRows)));

  items.forEach((text, idx) => {
    const y = listTop + idx * (effectiveRowH + gapY);
    const card: StageElement = {
      id: uid(),
      kind: "shape",
      name: `Card ${idx + 1}`,
      shape: {
        radius: 18,
        stroke: { color: dark ? "rgba(45,212,191,0.35)" : "rgba(13,148,136,0.28)", width: 2 },
      },
      enter: { dx: -28, dy: 0, scale: 0.98, blur: 6 },
      props: defaultStageProps({
        x: padX,
        y,
        width: contentW,
        height: effectiveRowH,
        color: cardBg,
        visible: false,
      }),
    };
    const badgeSize = Math.min(48, Math.round(effectiveRowH * 0.56));
    const badge: StageElement = {
      id: uid(),
      kind: "text",
      name: `Step ${idx + 1}`,
      textLook: {
        fontFamily: "inter-bold",
        fontSize: Math.round(badgeSize * 0.52),
        textAlign: "center",
        backgroundColor: accent,
        cornerStyle: "pill",
        paddingX: 12,
        paddingY: 6,
      },
      enter: { dx: -16, dy: 0, scale: 0.7, blur: 4 },
      props: defaultStageProps({
        x: padX + 20,
        y: Math.round(y + (effectiveRowH - badgeSize) / 2),
        width: badgeSize + 10,
        height: badgeSize,
        text: String(idx + 1),
        color: "#0b1120",
        visible: false,
      }),
    };
    const txt: StageElement = {
      id: uid(),
      kind: "text",
      name: `Point ${idx + 1}`,
      fit: "hug",
      textLook: { fontFamily: "inter-medium", fontSize: Math.min(itemSize, Math.round(effectiveRowH * 0.4)), textAlign: "left", lineHeight: 1.25 },
      enter: { dx: 24, dy: 0, scale: 1, blur: 6 },
      props: defaultStageProps({
        x: padX + badgeSize + 48,
        y: Math.round(y + (effectiveRowH - Math.min(itemSize, Math.round(effectiveRowH * 0.4)) * 1.25) / 2),
        width: contentW - badgeSize - 72,
        height: effectiveRowH - 16,
        text,
        color: ink,
        visible: false,
      }),
    };
    elements.push(card, badge, txt);
    rowCardIds.push(card.id);
    rowBadgeIds.push(badge.id);
    rowTextIds.push(txt.id);
  });

  // Beat 0: Hero title intro
  const beats: StageBeat[] = [
    {
      id: uid(),
      hold: 2.0,
      sound: "whoosh",
      changes: {},
    },
  ];

  // Beats 1..N: Title glides to top header; each bullet pops in while earlier bullets softly dim
  items.forEach((_, idx) => {
    const changes: StageBeat["changes"] = {};
    if (idx === 0) {
      changes[kickerEl.id] = { y: 78, opacity: 0.85 };
      changes[titleEl.id] = { y: 122, scale: 0.76, anchorX: 0, anchorY: 0 };
    }
    for (let j = 0; j < idx; j++) {
      changes[rowCardIds[j]] = { opacity: 0.45 };
      changes[rowBadgeIds[j]] = { opacity: 0.55 };
      changes[rowTextIds[j]] = { opacity: 0.58, color: subInk };
    }
    changes[rowCardIds[idx]] = { visible: true, opacity: 1 };
    changes[rowBadgeIds[idx]] = { visible: true, opacity: 1 };
    changes[rowTextIds[idx]] = { visible: true, opacity: 1, color: ink };
    beats.push({
      id: uid(),
      hold: 2.2,
      sound: "pop",
      changes,
    });
  });

  // Final beat: All bullets back to full brightness for summary view
  if (items.length > 1) {
    const summaryChanges: StageBeat["changes"] = {};
    for (let j = 0; j < items.length; j++) {
      summaryChanges[rowCardIds[j]] = { opacity: 0.92 };
      summaryChanges[rowBadgeIds[j]] = { opacity: 1 };
      summaryChanges[rowTextIds[j]] = { opacity: 1, color: ink };
    }
    beats.push({
      id: uid(),
      hold: 2.4,
      sound: "swoosh",
      changes: summaryChanges,
    });
  }

  return {
    id: opts.id ?? uid(),
    name: title.slice(0, 32),
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: dark
      ? { kind: "gradient", from: "#0f172a", to: "#1e1b4b", angle: 135, pattern: "dots" }
      : { kind: "gradient", from: "#f8fafc", to: "#e2e8f0", angle: 135, pattern: "dots" },
    elements,
    beats,
    spring: "smooth",
    stagger: 0.05,
    wordStagger: 0.05,
    beatSound: "pop",
  };
}

// Extracts root + top-level branches from a Whiteboard page for Mind Map animation.
function extractMindmapTree(page: WhiteboardPage): { root: WhiteboardNode; branches: { node: WhiteboardNode; children: string[] }[] } | null {
  const nodes = page.nodes.filter((n) => (n.text ?? "").trim().length > 0 || n.shapeType === "mindmapTopic" || n.shapeType === "mindmapSubtopic");
  if (nodes.length === 0) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outMap = new Map<string, string[]>();
  const inCount = new Map<string, number>();
  for (const e of page.edges) {
    const s = e.source.nodeId;
    const t = e.target.nodeId;
    if (!s || !t || s === t || !byId.has(s) || !byId.has(t)) continue;
    const list = outMap.get(s) ?? [];
    if (!list.includes(t)) list.push(t);
    outMap.set(s, list);
    inCount.set(t, (inCount.get(t) ?? 0) + 1);
  }
  // Pick root: prefer mindmapTopic with in-degree 0, then highest outgoing degree, then first node.
  const sorted = [...nodes].sort((a, b) => {
    const aTopic = a.shapeType === "mindmapTopic" ? 1 : 0;
    const bTopic = b.shapeType === "mindmapTopic" ? 1 : 0;
    const aZeroIn = (inCount.get(a.id) ?? 0) === 0 ? 1 : 0;
    const bZeroIn = (inCount.get(b.id) ?? 0) === 0 ? 1 : 0;
    if (aTopic + aZeroIn !== bTopic + bZeroIn) return bTopic + bZeroIn - (aTopic + aZeroIn);
    return (outMap.get(b.id)?.length ?? 0) - (outMap.get(a.id)?.length ?? 0);
  });
  const root = sorted[0];
  const directIds = (outMap.get(root.id) ?? []).filter((id) => id !== root.id);
  const branchNodes =
    directIds.length > 0
      ? directIds.map((id) => byId.get(id)!).filter(Boolean)
      : nodes.filter((n) => n.id !== root.id);

  const branches = branchNodes.slice(0, 6).map((node) => {
    const childTexts = (outMap.get(node.id) ?? [])
      .map((cid) => byId.get(cid)?.text?.trim())
      .filter((t): t is string => !!t)
      .slice(0, 3);
    return { node, children: childTexts };
  });
  return { root, branches };
}

const BRANCH_COLORS = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#2dd4bf"];

// Converts a saved Whiteboard Mind Map into an animated multi-beat radial reveal Scene with camera glides.
export function sceneFromWhiteboardMindmap(wb: WhiteboardDocument, opts: StageImportOptions & { pageId?: string }): StageScene {
  const page = wb.pages.find((p) => p.id === (opts.pageId ?? wb.activePageId)) ?? wb.pages[0];
  const tree = page ? extractMindmapTree(page) : null;
  if (!tree) {
    return sceneFromOutline(wb.name || "Mind Map", ["Topic 1", "Topic 2", "Topic 3"], opts);
  }

  const w = opts.width;
  const narrow = w < 1000;
  const cx = w / 2;
  const cy = STAGE_HEIGHT / 2;
  const rootW = narrow ? 360 : 440;
  const rootH = narrow ? 112 : 124;

  const rootBox: StageElement = {
    id: uid(),
    kind: "shape",
    name: "Central Topic Card",
    shape: {
      radius: 26,
      gradient: { to: "#2563eb", angle: 135 },
      stroke: { color: "rgba(255,255,255,0.28)", width: 2.5 },
      shadow: { color: "rgba(37,99,235,0.45)", blur: 36, y: 12 },
    },
    enter: { dx: 0, dy: 20, scale: 0.88, blur: 8 },
    props: defaultStageProps({
      x: Math.round(cx - rootW / 2),
      y: Math.round(cy - rootH / 2),
      width: rootW,
      height: rootH,
      color: "#0ea5e9",
    }),
  };

  const rootLabel: StageElement = {
    id: uid(),
    kind: "text",
    name: "Central Topic",
    fit: "hug",
    textLook: { fontFamily: "inter-bold", fontSize: narrow ? 34 : 42, textAlign: "center", lineHeight: 1.15 },
    props: defaultStageProps({
      x: Math.round(cx - (rootW - 48) / 2),
      y: Math.round(cy - (narrow ? 22 : 26)),
      width: rootW - 48,
      height: 60,
      text: (tree.root.text || wb.name || "Central Idea").trim().slice(0, 48),
      color: "#ffffff",
    }),
  };

  const elements: StageElement[] = [rootBox, rootLabel];
  const branchEntries: { cardId: string; textId: string; subId?: string; connId: string; x: number; y: number; w: number; h: number }[] = [];

  const count = tree.branches.length;
  const cardW = narrow ? Math.round(w * 0.42) : 390;
  const cardH = narrow ? 112 : 124;

  tree.branches.forEach((br, idx) => {
    const color = BRANCH_COLORS[idx % BRANCH_COLORS.length];
    // Balanced left/right placement in 16:9; alternating upper/lower fan in 9:16
    let bx: number;
    let by: number;
    if (narrow) {
      const topHalf = idx < Math.ceil(count / 2);
      const localIdx = topHalf ? idx : idx - Math.ceil(count / 2);
      const rowCount = topHalf ? Math.ceil(count / 2) : Math.floor(count / 2);
      const colSpan = w - 48;
      const colW = colSpan / Math.max(1, rowCount);
      bx = Math.round(24 + colW * localIdx + (colW - cardW) / 2);
      by = topHalf ? 120 + (localIdx % 2) * 124 : STAGE_HEIGHT - 240 - (localIdx % 2) * 124;
    } else {
      const rightSide = idx % 2 === 0;
      const sideIdx = Math.floor(idx / 2);
      const sideCount = Math.ceil((count - (rightSide ? 0 : 1)) / 2);
      const spanH = Math.min(760, sideCount * (cardH + 64));
      const startY = cy - spanH / 2 + (spanH / Math.max(1, sideCount)) * (sideIdx + 0.5) - cardH / 2;
      bx = rightSide ? Math.round(cx + rootW / 2 + 190) : Math.round(cx - rootW / 2 - 190 - cardW);
      by = Math.round(Math.max(76, Math.min(STAGE_HEIGHT - cardH - 76, startY)));
    }

    const card: StageElement = {
      id: uid(),
      kind: "shape",
      name: `Branch ${idx + 1}`,
      shape: {
        radius: 20,
        stroke: { color, width: 2.5 },
        shadow: { color: "rgba(0,0,0,0.35)", blur: 24, y: 8 },
      },
      enter: { dx: bx > cx ? -40 : 40, dy: 0, scale: 0.9, blur: 6 },
      props: defaultStageProps({
        x: bx,
        y: by,
        width: cardW,
        height: cardH,
        color: "#111827",
        visible: false,
      }),
    };

    const title = (br.node.text || `Topic ${idx + 1}`).trim().slice(0, 44);
    const hasSubs = br.children.length > 0;
    const labelEl: StageElement = {
      id: uid(),
      kind: "text",
      name: title,
      fit: "hug",
      textLook: { fontFamily: "inter-semibold", fontSize: narrow ? 24 : 28, textAlign: "center", lineHeight: 1.2 },
      enter: { dx: 0, dy: 10, scale: 1, blur: 4 },
      props: defaultStageProps({
        x: bx + 20,
        y: by + (hasSubs ? 22 : Math.round((cardH - 34) / 2)),
        width: cardW - 40,
        height: 40,
        text: title,
        color: "#f8fafc",
        visible: false,
      }),
    };

    let subEl: StageElement | undefined;
    if (hasSubs) {
      subEl = {
        id: uid(),
        kind: "text",
        name: `${title} notes`,
        fit: "hug",
        textLook: { fontFamily: "inter", fontSize: narrow ? 16 : 18, textAlign: "center", lineHeight: 1.25 },
        enter: { dx: 0, dy: 8, scale: 1, blur: 4 },
        props: defaultStageProps({
          x: bx + 20,
          y: by + 64,
          width: cardW - 40,
          height: 44,
          text: br.children.join(" · ").slice(0, 70),
          color: color,
          visible: false,
        }),
      };
    }

    const conn: StageElement = {
      id: uid(),
      kind: "connector",
      name: `Link ${idx + 1}`,
      connector: { from: rootBox.id, to: card.id, style: "dots", thickness: 5, gap: 16, flow: 45 },
      props: defaultStageProps({ x: 0, y: 0, width: 0, height: 0, color, visible: false }),
    };

    // Connectors sit underneath cards
    elements.unshift(conn);
    elements.push(card, labelEl);
    if (subEl) elements.push(subEl);
    branchEntries.push({ cardId: card.id, textId: labelEl.id, subId: subEl?.id, connId: conn.id, x: bx, y: by, w: cardW, h: cardH });
  });

  // Beat 0: Zoomed gently onto central topic
  const beats: StageBeat[] = [
    {
      id: uid(),
      hold: 2.0,
      sound: "whoosh",
      camera: { zoom: 1.22, panX: 0, panY: 0, tilt: 0 },
      changes: {},
    },
  ];

  // Beats 1..K: Reveal each branch with a gentle camera pan toward it
  branchEntries.forEach((b) => {
    const changes: StageBeat["changes"] = {
      [b.connId]: { visible: true },
      [b.cardId]: { visible: true },
      [b.textId]: { visible: true },
    };
    if (b.subId) changes[b.subId] = { visible: true };
    const focusX = (b.x + b.w / 2 - cx) * 0.35;
    const focusY = (b.y + b.h / 2 - cy) * 0.35;
    beats.push({
      id: uid(),
      hold: 2.0,
      sound: "pop",
      camera: { zoom: 1.12, panX: Math.round(focusX), panY: Math.round(focusY), tilt: 0 },
      changes,
    });
  });

  // Final beat: Pull back to full overview of the entire Mind Map
  if (branchEntries.length > 0) {
    beats.push({
      id: uid(),
      hold: 2.6,
      sound: "swoosh",
      camera: { zoom: 1, panX: 0, panY: 0, tilt: 0 },
      changes: {},
    });
  }

  return {
    id: opts.id ?? uid(),
    name: (wb.name || tree.root.text || "Mind Map").slice(0, 32),
    startTime: Math.max(0, opts.startTime),
    layer: opts.layer,
    width: w,
    height: STAGE_HEIGHT,
    background: { kind: "gradient", from: "#0b1120", to: "#172554", radial: true, pattern: "dots" },
    elements,
    beats,
    spring: "smooth",
    stagger: 0.05,
    wordStagger: 0.05,
    beatSound: "pop",
  };
}

// Extracts structured headings & bullet points from a Briefcast Doc's ProseMirror JSON.
interface PmNode {
  type?: string;
  text?: string;
  content?: PmNode[];
}
function pmText(node: PmNode): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(pmText).join("");
}

export async function listImportableWhiteboards(): Promise<WhiteboardSummary[]> {
  try {
    return await invoke<WhiteboardSummary[]>("list_whiteboards");
  } catch {
    return [];
  }
}

export async function importWhiteboardAsScene(id: string, opts: StageImportOptions): Promise<StageScene> {
  const json = await invoke<string>("load_whiteboard", { id });
  const wb = JSON.parse(json) as WhiteboardDocument;
  return sceneFromWhiteboardMindmap(wb, opts);
}

export async function listImportableDocs(): Promise<DocSummary[]> {
  try {
    return await invoke<DocSummary[]>("list_docs");
  } catch {
    return [];
  }
}

export async function importDocAsScene(id: string, docTitle: string, opts: StageImportOptions): Promise<StageScene> {
  const result = await invoke<{ bytes: number[] }>("load_doc", { id });
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, new Uint8Array(result.bytes));
    const json = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment("default")) as PmNode;
    let heading = docTitle;
    const bullets: string[] = [];
    const walk = (nodes: PmNode[] | undefined) => {
      for (const n of nodes ?? []) {
        if (n.type === "heading") {
          const t = pmText(n).trim();
          if (t) {
            if (heading === docTitle && bullets.length === 0) heading = t;
            else bullets.push(t);
          }
        } else if (n.type === "listItem" || n.type === "taskItem") {
          const t = pmText(n).trim();
          if (t) bullets.push(t);
        } else if (n.type === "bulletList" || n.type === "orderedList" || n.type === "taskList") {
          walk(n.content);
        } else if (n.type === "paragraph") {
          const t = pmText(n).trim();
          if (t && bullets.length < 6) bullets.push(t);
        }
      }
    };
    walk(json.content);
    return sceneFromOutline(heading || docTitle || "Document Summary", bullets.slice(0, 6), opts);
  } finally {
    ydoc.destroy();
  }
}
