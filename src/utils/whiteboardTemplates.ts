// utils/whiteboardTemplates.ts
//
// Pro starter templates for WhiteboardHome (new document creation) and WhiteboardEditor (insert
// onto current page via Ctrl+K or Templates menu). Built purely from native WhiteboardNode &
// WhiteboardEdge primitives (including Containment Frames / artboards and Mind Map topics).

import {
  createDefaultWhiteboardEdge,
  createDefaultWhiteboardNode,
  createEmptyWhiteboardDocument,
  createEmptyWhiteboardPage,
  WHITEBOARD_SCHEMA_VERSION,
  WhiteboardDocument,
  WhiteboardEdge,
  WhiteboardNode,
} from "./whiteboardTypes";
import { createMindmapWhiteboardDocument } from "../handlers/whiteboardMindmapHandlers";

export type WhiteboardTemplateId =
  | "blank"
  | "mindmap"
  | "roadmap"
  | "slides"
  | "architecture"
  | "flowchart"
  | "kanban"
  | "swot";

export interface WhiteboardTemplateMeta {
  id: WhiteboardTemplateId;
  name: string;
  tagline: string;
  accent: string;
  badge?: string;
}

export const WHITEBOARD_TEMPLATES: WhiteboardTemplateMeta[] = [
  { id: "blank", name: "Blank Whiteboard", tagline: "Infinite canvas for diagrams & sketches", accent: "#3b82f6" },
  { id: "mindmap", name: "Mind Map", tagline: "Radial brainstorming with Tab/Enter branching", accent: "#eab308", badge: "Mind Map" },
  { id: "roadmap", name: "Learning Roadmap", tagline: "Topics, resources, checklists & Study Mode", accent: "#10b981", badge: "Study" },
  { id: "slides", name: "Slide Deck (3 Frames)", tagline: "16:9 frames ready for Present Mode & PDF", accent: "#6366f1", badge: "Present" },
  { id: "architecture", name: "System Architecture", tagline: "Layered client, API, cache & DB blueprint", accent: "#0ea5e9" },
  { id: "flowchart", name: "Decision Flowchart", tagline: "Process flow with branching decision paths", accent: "#8b5cf6" },
  { id: "kanban", name: "Kanban Sprint Board", tagline: "3 framed columns with sticky task cards", accent: "#f59e0b" },
  { id: "swot", name: "SWOT 2×2 Matrix", tagline: "Four-quadrant strategic analysis frames", accent: "#ec4899" },
];

function makeArtboard(
  title: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fillColor = "#ffffff",
  strokeColor = "#cbd5e1"
): WhiteboardNode {
  const base = createDefaultWhiteboardNode(crypto.randomUUID(), "artboard", 0, 0);
  return {
    ...base,
    x,
    y,
    width,
    height,
    text: title,
    fillColor,
    strokeColor,
    strokeWidth: 1.5,
    cornerRadius: 12,
  };
}

function makeSticky(text: string, x: number, y: number, fillColor = "#fef08a", strokeColor = "#eab308"): WhiteboardNode {
  const base = createDefaultWhiteboardNode(crypto.randomUUID(), "note", 0, 0);
  return {
    ...base,
    x,
    y,
    width: 196,
    height: 82,
    text,
    fillColor,
    strokeColor,
    strokeWidth: 1.5,
    fontSize: 13,
    fontColor: "#1f2937",
    shadowEnabled: true,
    shadowBlur: 10,
    shadowOffsetY: 3,
    shadowOpacity: 0.12,
  };
}

function makeBox(
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fillColor: string,
  strokeColor: string,
  shapeType: WhiteboardNode["shapeType"] = "rectangle",
  cornerRadius = 10
): WhiteboardNode {
  const base = createDefaultWhiteboardNode(crypto.randomUUID(), shapeType, 0, 0);
  return {
    ...base,
    x,
    y,
    width,
    height,
    text,
    fillColor,
    strokeColor,
    strokeWidth: 2,
    cornerRadius,
    fontSize: 14,
    fontWeight: "bold",
    fontColor: "#0f172a",
  };
}

function connectNodes(
  from: WhiteboardNode,
  to: WhiteboardNode,
  label = "",
  routing: WhiteboardEdge["routing"] = "orthogonal"
): WhiteboardEdge {
  return {
    ...createDefaultWhiteboardEdge(
      crypto.randomUUID(),
      { nodeId: from.id, anchor: "auto" },
      { nodeId: to.id, anchor: "auto" }
    ),
    label,
    routing,
    strokeColor: "#475569",
    strokeWidth: 2,
    endArrowType: "triangle",
  };
}

/**
 * Builds the nodes and edges for any template (shifted by optional `offsetX`/`offsetY`), suitable
 * for both new-document creation and inserting a template onto an existing page.
 */
export function buildTemplatePageContent(
  templateId: WhiteboardTemplateId,
  offsetX = 0,
  offsetY = 0
): { nodes: WhiteboardNode[]; edges: WhiteboardEdge[] } {
  if (templateId === "blank") return { nodes: [], edges: [] };

  if (templateId === "mindmap" || templateId === "roadmap") {
    const tmp = createMindmapWhiteboardDocument(crypto.randomUUID(), "Template", templateId);
    const page = tmp.pages[0];
    return {
      nodes: page.nodes.map((n) => ({ ...n, x: n.x + offsetX, y: n.y + offsetY })),
      edges: page.edges,
    };
  }

  const nodes: WhiteboardNode[] = [];
  const edges: WhiteboardEdge[] = [];

  if (templateId === "slides") {
    const slideW = 960;
    const slideH = 540;
    const gap = 80;
    const s1 = makeArtboard("1 · Title Slide", 0, 0, slideW, slideH, "#ffffff", "#94a3b8");
    const s2 = makeArtboard("2 · Core Architecture", slideW + gap, 0, slideW, slideH, "#ffffff", "#94a3b8");
    const s3 = makeArtboard("3 · Key Takeaways", (slideW + gap) * 2, 0, slideW, slideH, "#ffffff", "#94a3b8");
    nodes.push(s1, s2, s3);

    // Slide 1 content
    nodes.push({
      ...createDefaultWhiteboardNode(crypto.randomUUID(), "text", 0, 0),
      x: 100,
      y: 170,
      width: 760,
      height: 70,
      text: "Presentation Title",
      fontSize: 40,
      fontWeight: "bold",
      fontColor: "#0f172a",
    });
    nodes.push({
      ...createDefaultWhiteboardNode(crypto.randomUUID(), "text", 0, 0),
      x: 140,
      y: 260,
      width: 680,
      height: 50,
      text: "Press Present in the toolbar to step smoothly through every frame · Use ← / → and Laser Pointer (L)",
      fontSize: 16,
      fontColor: "#64748b",
    });

    // Slide 2 content
    const bx = slideW + gap;
    const a = makeBox("Input / Capture", bx + 90, 210, 210, 96, "#dbeafe", "#2563eb");
    const b = makeBox("Processing Engine", bx + 375, 210, 210, 96, "#dcfce7", "#16a34a");
    const c = makeBox("Delivery / Export", bx + 660, 210, 210, 96, "#ede9fe", "#7c3aed");
    nodes.push(a, b, c);
    edges.push(connectNodes(a, b), connectNodes(b, c));

    // Slide 3 content
    const cx = (slideW + gap) * 2;
    nodes.push(makeSticky("1. Fast visual storytelling", cx + 90, 190, "#fef08a", "#eab308"));
    nodes.push(makeSticky("2. Live annotations & laser", cx + 380, 190, "#bbf7d0", "#16a34a"));
    nodes.push(makeSticky("3. Export all frames to PDF", cx + 670, 190, "#bfdbfe", "#2563eb"));
  } else if (templateId === "architecture") {
    const fClient = makeArtboard("Client Layer", 0, 0, 240, 340, "#f8fafc", "#94a3b8");
    const fApp = makeArtboard("Application Services", 300, 0, 340, 340, "#f0f9ff", "#38bdf8");
    const fData = makeArtboard("Data & Storage", 700, 0, 240, 340, "#f0fdf4", "#4ade80");
    nodes.push(fClient, fApp, fData);

    const web = makeBox("Desktop / Web App", 30, 70, 180, 68, "#ffffff", "#2563eb");
    const mobile = makeBox("Mobile Companion", 30, 190, 180, 68, "#ffffff", "#2563eb");
    const gw = makeBox("API Gateway", 340, 130, 120, 76, "#dbeafe", "#1d4ed8");
    const svcA = makeBox("Core Worker", 500, 70, 120, 68, "#e0f2fe", "#0284c7");
    const svcB = makeBox("Media Pipeline", 500, 190, 120, 68, "#e0f2fe", "#0284c7");
    const cache = makeBox("Redis Cache", 730, 70, 180, 68, "#fef3c7", "#d97706", "cylinder");
    const db = makeBox("Primary Database", 730, 190, 180, 78, "#dcfce7", "#15803d", "cylinder");

    nodes.push(web, mobile, gw, svcA, svcB, cache, db);
    edges.push(
      connectNodes(web, gw, "HTTPS"),
      connectNodes(mobile, gw, "WS"),
      connectNodes(gw, svcA),
      connectNodes(gw, svcB),
      connectNodes(svcA, cache),
      connectNodes(svcA, db),
      connectNodes(svcB, db)
    );
  } else if (templateId === "flowchart") {
    const start = makeBox("Start Request", 300, 0, 180, 56, "#dcfce7", "#16a34a", "rectangle", 28);
    const validate = makeBox("Validate Input", 300, 110, 180, 64, "#dbeafe", "#2563eb");
    const decision = makeBox("Valid?", 315, 225, 150, 96, "#fef3c7", "#d97706", "diamond", 0);
    const reject = makeBox("Return Error", 60, 241, 165, 64, "#fee2e2", "#dc2626");
    const execute = makeBox("Process Action", 300, 380, 180, 64, "#ede9fe", "#7c3aed");
    const done = makeBox("Complete", 300, 495, 180, 56, "#dcfce7", "#16a34a", "rectangle", 28);

    nodes.push(start, validate, decision, reject, execute, done);
    edges.push(
      connectNodes(start, validate),
      connectNodes(validate, decision),
      connectNodes(decision, reject, "No"),
      connectNodes(decision, execute, "Yes"),
      connectNodes(execute, done)
    );
  } else if (templateId === "kanban") {
    const colW = 280;
    const colH = 520;
    const gap = 28;
    const boardW = colW * 4 + gap * 3;
    const colTop = 128;

    // 1. Top Sprint Summary Banner
    const banner: WhiteboardNode = {
      ...createDefaultWhiteboardNode(crypto.randomUUID(), "rectangle", 0, 0),
      x: 0,
      y: 0,
      width: boardW,
      height: 100,
      fillColor: "#0f172a",
      strokeColor: "#1e293b",
      strokeWidth: 1.5,
      cornerRadius: 16,
      shadowEnabled: true,
      shadowBlur: 18,
      shadowOffsetY: 6,
      shadowOpacity: 0.14,
      text: "",
    };
    const rocketIcon: WhiteboardNode = {
      ...createDefaultWhiteboardNode(crypto.randomUUID(), "icon", 0, 0, { iconName: "rocket" }),
      x: 24,
      y: 26,
      width: 48,
      height: 48,
      fillColor: "#1e3a8a",
      strokeColor: "#93c5fd",
      strokeWidth: 2,
      cornerRadius: 12,
    };
    const sprintTitle: WhiteboardNode = {
      ...createDefaultWhiteboardNode(crypto.randomUUID(), "text", 0, 0),
      x: 86,
      y: 18,
      width: 520,
      height: 36,
      text: "Sprint 14 · Q4 Product Launch",
      fontSize: 22,
      fontFamily: "'Poppins', system-ui, sans-serif",
      fontWeight: "bold",
      fontColor: "#f8fafc",
      textAlign: "left",
      verticalAlign: "middle",
    };
    const sprintGoal: WhiteboardNode = {
      ...createDefaultWhiteboardNode(crypto.randomUUID(), "text", 0, 0),
      x: 86,
      y: 54,
      width: 600,
      height: 28,
      text: "Goal: Ship unified Pro Whiteboard, Slide Importer & 60fps Studio Engine",
      fontSize: 13,
      fontColor: "#94a3b8",
      textAlign: "left",
      verticalAlign: "middle",
    };
    const makeKpiPill = (label: string, x: number, bg: string, stroke: string, color: string): WhiteboardNode => ({
      ...createDefaultWhiteboardNode(crypto.randomUUID(), "rectangle", 0, 0),
      x,
      y: 30,
      width: 132,
      height: 38,
      fillColor: bg,
      strokeColor: stroke,
      strokeWidth: 1,
      cornerRadius: 19,
      text: label,
      fontSize: 12,
      fontWeight: "bold",
      fontColor: color,
    });
    nodes.push(
      banner,
      rocketIcon,
      sprintTitle,
      sprintGoal,
      makeKpiPill("Velocity: 34 pts", boardW - 432, "#1e293b", "#334155", "#e2e8f0"),
      makeKpiPill("75% Complete", boardW - 288, "#064e3b", "#059669", "#6ee7b7"),
      makeKpiPill("Status: On Track", boardW - 144, "#1e3a8a", "#2563eb", "#bfdbfe")
    );

    // 2. Four Color-Coded Sprint Columns (Containment Frames)
    const columns: {
      title: string;
      badge: string;
      bg: string;
      border: string;
      headerBg: string;
      headerColor: string;
    }[] = [
      { title: "Backlog", badge: "Backlog · 3", bg: "#f8fafc", border: "#cbd5e1", headerBg: "#e2e8f0", headerColor: "#334155" },
      { title: "To Do", badge: "To Do · 3", bg: "#fffbeb", border: "#fcd34d", headerBg: "#fef3c7", headerColor: "#92400e" },
      { title: "In Progress", badge: "In Progress · 2", bg: "#eff6ff", border: "#93c5fd", headerBg: "#dbeafe", headerColor: "#1e40af" },
      { title: "Done", badge: "Done · 3", bg: "#f0fdf4", border: "#86efac", headerBg: "#dcfce7", headerColor: "#166534" },
    ];

    columns.forEach((col, i) => {
      const cx = i * (colW + gap);
      nodes.push(makeArtboard(col.title, cx, colTop, colW, colH, col.bg, col.border));
      nodes.push({
        ...createDefaultWhiteboardNode(crypto.randomUUID(), "rectangle", 0, 0),
        x: cx + 14,
        y: colTop + 14,
        width: colW - 28,
        height: 32,
        fillColor: col.headerBg,
        strokeColor: col.border,
        strokeWidth: 1,
        cornerRadius: 8,
        text: col.badge,
        fontSize: 12,
        fontWeight: "bold",
        fontColor: col.headerColor,
        textAlign: "left",
      });
    });

    // Helper for elevated designer Sprint Task Cards
    const makeTaskCard = (
      colIndex: number,
      yOffset: number,
      tag: string,
      tagBg: string,
      tagColor: string,
      title: string,
      meta: string,
      accentBorder = "#e2e8f0"
    ) => {
      const x = colIndex * (colW + gap) + 14;
      const y = colTop + yOffset;
      const w = colW - 28;
      const h = 112;
      const card: WhiteboardNode = {
        ...createDefaultWhiteboardNode(crypto.randomUUID(), "rectangle", 0, 0),
        x,
        y,
        width: w,
        height: h,
        fillColor: "#ffffff",
        strokeColor: accentBorder,
        strokeWidth: 1.25,
        cornerRadius: 12,
        shadowEnabled: true,
        shadowBlur: 12,
        shadowOffsetY: 3,
        shadowOpacity: 0.08,
        text: "",
      };
      const pill: WhiteboardNode = {
        ...createDefaultWhiteboardNode(crypto.randomUUID(), "rectangle", 0, 0),
        x: x + 12,
        y: y + 11,
        width: Math.min(130, Math.max(76, tag.length * 7 + 16)),
        height: 20,
        fillColor: tagBg,
        strokeColor: tagBg,
        strokeWidth: 0,
        cornerRadius: 10,
        text: tag,
        fontSize: 10,
        fontWeight: "bold",
        fontColor: tagColor,
      };
      const titleNode: WhiteboardNode = {
        ...createDefaultWhiteboardNode(crypto.randomUUID(), "text", 0, 0),
        x: x + 8,
        y: y + 34,
        width: w - 16,
        height: 44,
        text: title,
        fontSize: 13,
        fontWeight: "bold",
        fontColor: "#0f172a",
        textAlign: "left",
        verticalAlign: "top",
      };
      const metaNode: WhiteboardNode = {
        ...createDefaultWhiteboardNode(crypto.randomUUID(), "text", 0, 0),
        x: x + 8,
        y: y + 80,
        width: w - 16,
        height: 24,
        text: meta,
        fontSize: 11,
        fontColor: "#64748b",
        textAlign: "left",
        verticalAlign: "middle",
      };
      nodes.push(card, pill, titleNode, metaNode);
    };

    // Backlog cards + Sprint Assets Folder
    makeTaskCard(0, 58, "RESEARCH", "#f1f5f9", "#475569", "Benchmark 4K WebGL canvas zoom", "3 pts · @alex");
    makeTaskCard(0, 184, "DESIGN", "#f3e8ff", "#7e22ce", "Dark Studio theme icon polish", "2 pts · @maya");
    nodes.push({
      ...createDefaultWhiteboardNode(crypto.randomUUID(), "folder", 0, 0),
      x: 42,
      y: colTop + 322,
      width: 196,
      height: 144,
      fillColor: "#3b82f6",
      strokeColor: "#1d4ed8",
      strokeWidth: 1.25,
      cornerRadius: 12,
      shadowEnabled: true,
      shadowBlur: 12,
      shadowOffsetY: 4,
      shadowOpacity: 0.16,
      text: "Sprint Assets",
      fontSize: 14,
      fontWeight: "bold",
      fontColor: "#ffffff",
    });

    // To Do cards + Rounded Sticky Note
    makeTaskCard(1, 58, "HIGH · CORE", "#fee2e2", "#b91c1c", "Add multi-page PDF deck export", "5 pts · @sam", "#fca5a5");
    makeTaskCard(1, 184, "UX POLISH", "#fef3c7", "#b45309", "Draft interactive user walkthrough", "3 pts · @maya", "#fcd34d");
    nodes.push({
      ...makeSticky("Remember: test dark canvas contrast before Friday demo!", colW + gap + 22, colTop + 320, "#fef08a", "#eab308"),
      width: colW - 44,
      height: 118,
      cornerRadius: 10,
      fontSize: 13,
      textAlign: "left",
      verticalAlign: "top",
    });

    // In Progress cards + Interactive Definition of Done Checklist
    makeTaskCard(2, 58, "IN FLIGHT", "#dbeafe", "#1d4ed8", "Optimize tapered ink & render loop", "8 pts · @dev", "#93c5fd");
    makeTaskCard(2, 184, "INTEGRATION", "#e0e7ff", "#4338ca", "PowerPoint & Google Slides parser", "5 pts · @alex", "#a5b4fc");
    nodes.push({
      ...createDefaultWhiteboardNode(crypto.randomUUID(), "mindmapChecklist", 0, 0, {
        mindmapItems: [
          { id: crypto.randomUUID(), text: "TypeScript 0 errors", checked: true },
          { id: crypto.randomUUID(), text: "Unit tests passing", checked: true },
          { id: crypto.randomUUID(), text: "Cross-platform QA", checked: false },
          { id: crypto.randomUUID(), text: "Record demo clip", checked: false },
        ],
      }),
      x: (colW + gap) * 2 + 14,
      y: colTop + 314,
      width: colW - 28,
      height: 146,
      text: "Definition of Done",
      fillColor: "#ffffff",
      strokeColor: "#93c5fd",
      cornerRadius: 12,
    });

    // Done cards
    makeTaskCard(3, 58, "SHIPPED", "#dcfce7", "#15803d", "Floating Studio tool rail & themes", "5 pts · @maya", "#86efac");
    makeTaskCard(3, 184, "SHIPPED", "#dcfce7", "#15803d", "Realtime LaTeX Maths & Vector Icons", "5 pts · @dev", "#86efac");
    makeTaskCard(3, 310, "SHIPPED", "#dcfce7", "#15803d", "Release notes v0.1.7 published", "2 pts · @sam", "#86efac");
  } else if (templateId === "swot") {
    const qW = 340;
    const qH = 240;
    const gap = 28;
    const s = makeArtboard("Strengths", 0, 0, qW, qH, "#f0fdf4", "#22c55e");
    const w = makeArtboard("Weaknesses", qW + gap, 0, qW, qH, "#fef2f2", "#ef4444");
    const o = makeArtboard("Opportunities", 0, qH + gap, qW, qH, "#eff6ff", "#3b82f6");
    const t = makeArtboard("Threats", qW + gap, qH + gap, qW, qH, "#fffbeb", "#f59e0b");
    nodes.push(s, w, o, t);

    nodes.push(
      makeSticky("Fast local-first desktop speed", 28, 32, "#dcfce7", "#16a34a"),
      makeSticky("Add team sync options", qW + gap + 28, 32, "#fee2e2", "#dc2626"),
      makeSticky("All-in-one recording + diagrams", 28, qH + gap + 32, "#dbeafe", "#2563eb"),
      makeSticky("Crowded SaaS whiteboard market", qW + gap + 28, qH + gap + 32, "#fef3c7", "#d97706")
    );
  }

  return {
    nodes: nodes.map((n) => ({ ...n, x: n.x + offsetX, y: n.y + offsetY })),
    edges,
  };
}

export function createWhiteboardFromTemplate(
  id: string,
  name: string,
  templateId: WhiteboardTemplateId
): WhiteboardDocument {
  if (templateId === "blank") return createEmptyWhiteboardDocument(id, name);
  if (templateId === "mindmap" || templateId === "roadmap") {
    return createMindmapWhiteboardDocument(id, name, templateId);
  }
  const now = new Date().toISOString();
  const meta = WHITEBOARD_TEMPLATES.find((t) => t.id === templateId);
  const page = createEmptyWhiteboardPage(crypto.randomUUID(), meta?.name ?? "Page 1");
  const built = buildTemplatePageContent(templateId, 120, 100);
  page.nodes = built.nodes;
  page.edges = built.edges;
  return {
    version: WHITEBOARD_SCHEMA_VERSION,
    id,
    name,
    showGrid: true,
    snapToGrid: true,
    pages: [page],
    activePageId: page.id,
    createdAt: now,
    updatedAt: now,
  };
}
