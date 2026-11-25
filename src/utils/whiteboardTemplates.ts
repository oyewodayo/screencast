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
    const colW = 240;
    const colH = 380;
    const gap = 36;
    const todo = makeArtboard("To Do", 0, 0, colW, colH, "#f8fafc", "#cbd5e1");
    const doing = makeArtboard("In Progress", colW + gap, 0, colW, colH, "#eff6ff", "#93c5fd");
    const done = makeArtboard("Done", (colW + gap) * 2, 0, colW, colH, "#f0fdf4", "#86efac");
    nodes.push(todo, doing, done);

    nodes.push(
      makeSticky("Define acceptance criteria", 22, 28, "#fef08a", "#eab308"),
      makeSticky("Draft user walkthrough", 22, 130, "#fef08a", "#eab308"),
      makeSticky("Optimize render pipeline", colW + gap + 22, 28, "#bfdbfe", "#3b82f6"),
      makeSticky("Ship release notes v0.1.7", (colW + gap) * 2 + 22, 28, "#bbf7d0", "#16a34a")
    );
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
