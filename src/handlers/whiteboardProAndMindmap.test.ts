import { describe, expect, it } from "vitest";
import {
  createDefaultWhiteboardEdge,
  createDefaultWhiteboardNode,
  createEmptyWhiteboardDocument,
  createEmptyWhiteboardPage,
} from "../utils/whiteboardTypes";
import { createStarterMindmapDocument } from "../utils/mindmapTemplate";
import {
  autoLayoutMindmap,
  buildMindmapBranch,
  buildMindmapSibling,
  computeMindmapProgressStats,
  convertMindmapDocumentToWhiteboardDocument,
  createMindmapWhiteboardDocument,
  getCollapsedState,
} from "./whiteboardMindmapHandlers";
import {
  alignNodes,
  applyStyleSnapshot,
  arrangeArtboardFrames,
  computeAutoTextBoxSize,
  cullVisibleItems,
  distributeNodes,
  extractStyleSnapshot,
  findContainedFrameItems,
  getOrderedArtboards,
  matchNodeSize,
  searchWhiteboardDocument,
  tidyUpNodes,
} from "./whiteboardProHandlers";
import { createWhiteboardFromTemplate, WHITEBOARD_TEMPLATES } from "../utils/whiteboardTemplates";
import {
  exportMindmapToMarkdown,
  exportWhiteboardToSvg,
  parseMarkdownToMindmap,
  parseMermaidToWhiteboard,
  switchNodesShapeType,
} from "./whiteboardInterchangeHandlers";
import { buildTaperedFreehandPathD } from "./whiteboardFreehand";
import { NODE_STYLE_PRESETS, resolveCanvasTheme, WHITEBOARD_CANVAS_THEMES } from "../utils/whiteboardThemes";

describe("whiteboardMindmapHandlers", () => {
  it("branches child and sibling nodes without overlapping existing nodes", () => {
    const root = createDefaultWhiteboardNode("root", "mindmapTopic", 400, 300);
    const first = buildMindmapBranch(root, "right", [root], "c1", "e1");
    expect(first.node.shapeType).toBe("mindmapSubtopic");
    expect(first.node.x).toBeGreaterThan(root.x + root.width);
    expect(first.edge.source.nodeId).toBe("root");
    expect(first.edge.target.nodeId).toBe("c1");

    const second = buildMindmapBranch(root, "right", [root, first.node], "c2", "e2");
    expect(second.node.y).not.toBe(first.node.y);

    const page = createEmptyWhiteboardPage("p1", "Page 1");
    page.nodes = [root, first.node];
    page.edges = [first.edge];
    const sibling = buildMindmapSibling(first.node, page, "c3", "e3");
    expect(sibling.edge.source.nodeId).toBe("root");
    expect(sibling.node.y).not.toBe(first.node.y);
  });

  it("computes collapsed descendants and handles cycles safely in O(V+E)", () => {
    const a = { ...createDefaultWhiteboardNode("a", "mindmapTopic", 0, 0), mindmapCollapsed: true };
    const b = createDefaultWhiteboardNode("b", "mindmapSubtopic", 200, 0);
    const c = createDefaultWhiteboardNode("c", "mindmapSubtopic", 400, 0);
    const e1 = createDefaultWhiteboardEdge("e1", { nodeId: "a" }, { nodeId: "b" });
    const e2 = createDefaultWhiteboardEdge("e2", { nodeId: "b" }, { nodeId: "c" });
    const cycle = createDefaultWhiteboardEdge("e3", { nodeId: "c" }, { nodeId: "a" });

    const state = getCollapsedState([a, b, c], [e1, e2, cycle]);
    expect(state.hiddenNodeIds.has("a")).toBe(false);
    expect(state.hiddenNodeIds.has("b")).toBe(true);
    expect(state.hiddenNodeIds.has("c")).toBe(true);
    expect(state.collapsedCountByNodeId.get("a")).toBe(2);
    expect(state.hiddenEdgeIds.size).toBe(3);
  });

  it("auto-layouts trees cleanly in right, balanced, and topDown modes", () => {
    const root = createDefaultWhiteboardNode("r", "mindmapTopic", 500, 300);
    const n1 = createDefaultWhiteboardNode("n1", "mindmapSubtopic", 500, 300);
    const n2 = createDefaultWhiteboardNode("n2", "mindmapSubtopic", 500, 300);
    const e1 = createDefaultWhiteboardEdge("e1", { nodeId: "r" }, { nodeId: "n1" });
    const e2 = createDefaultWhiteboardEdge("e2", { nodeId: "r" }, { nodeId: "n2" });

    const right = autoLayoutMindmap("r", [root, n1, n2], [e1, e2], "right");
    expect(right.after.length).toBe(2);
    expect(right.after.every((n) => n.x > root.x + root.width)).toBe(true);
    expect(right.after[0].y).not.toBe(right.after[1].y);

    const balanced = autoLayoutMindmap("r", [root, n1, n2], [e1, e2], "balanced");
    const balMap = new Map(balanced.after.map((n) => [n.id, n]));
    expect(balMap.get("n1")!.x).toBeGreaterThan(root.x);
    expect(balMap.get("n2")!.x).toBeLessThan(root.x);

    const topDown = autoLayoutMindmap("r", [root, n1, n2], [e1, e2], "topDown");
    expect(topDown.after.every((n) => n.y > root.y + root.height)).toBe(true);
    expect(topDown.after[0].x).not.toBe(topDown.after[1].x);
  });

  it("losslessly converts legacy MindmapDocument into a WhiteboardDocument", () => {
    const legacy = createStarterMindmapDocument("old-mm-1", "C++ Roadmap");
    const converted = convertMindmapDocumentToWhiteboardDocument(legacy, "mm-old-mm-1");
    expect(converted.id).toBe("mm-old-mm-1");
    expect(converted.name).toBe("C++ Roadmap");
    expect(converted.pages.length).toBe(1);
    expect(converted.pages[0].nodes.length).toBe(legacy.nodes.length);
    expect(converted.pages[0].edges.length).toBe(legacy.edges.length);

    const stats = computeMindmapProgressStats(converted.pages[0].nodes);
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.inProgress).toBe(1);

    const starter = createMindmapWhiteboardDocument("wb-1", "Brainstorm", "mindmap");
    expect(starter.pages[0].nodes.length).toBeGreaterThan(5);
    expect(starter.pages[0].edges.length).toBeGreaterThan(4);
  });
});

describe("whiteboardProHandlers", () => {
  it("aligns, distributes, matches size, and tidies up multi-selected nodes", () => {
    const a = { ...createDefaultWhiteboardNode("a", "rectangle", 100, 100), x: 0, y: 0, width: 100, height: 50 };
    const b = { ...createDefaultWhiteboardNode("b", "rectangle", 200, 200), x: 140, y: 90, width: 120, height: 80 };
    const c = { ...createDefaultWhiteboardNode("c", "rectangle", 400, 250), x: 400, y: 200, width: 100, height: 50 };

    const leftAligned = alignNodes([a, b, c], "left");
    expect(leftAligned.after.every((n) => n.x === 0)).toBe(true);

    const distributed = distributeNodes([a, b, c], "horizontal");
    expect(distributed.after.length).toBe(1);
    // Span = 500, totalW = 320, gap = 90 => b.x = 100 + 90 = 190
    expect(distributed.after[0].x).toBe(190);

    const matched = matchNodeSize([a, b, c], "both");
    expect(matched.after.every((n) => n.width === 120 && n.height === 80)).toBe(true);

    const tidied = tidyUpNodes([a, b, c], 20);
    expect(tidied.after.length).toBeGreaterThan(0);
  });

  it("finds contained nodes and free-floating edges inside artboard frames", () => {
    const frame = { ...createDefaultWhiteboardNode("f1", "artboard", 300, 200), x: 0, y: 0, width: 600, height: 400 };
    const inside = { ...createDefaultWhiteboardNode("n1", "rectangle", 100, 100), x: 50, y: 50, width: 100, height: 60 };
    const outside = { ...createDefaultWhiteboardNode("n2", "rectangle", 900, 900), x: 800, y: 800, width: 100, height: 60 };
    const freeEdge = createDefaultWhiteboardEdge("e1", { x: 120, y: 120 }, { x: 200, y: 200 });

    const contained = findContainedFrameItems([frame], [frame, inside, outside], [freeEdge]);
    expect(contained.nodeIds).toEqual(["n1"]);
    expect(contained.edgeIds).toEqual(["e1"]);
  });

  it("copies and applies visual styles with Format Painter without altering geometry or text", () => {
    const src = {
      ...createDefaultWhiteboardNode("src", "rectangle", 0, 0),
      text: "Source",
      fillColor: "#dbeafe",
      strokeColor: "#1d4ed8",
      strokeWidth: 4,
      cornerRadius: 14,
      fontWeight: "bold" as const,
      blendMode: "multiply" as const,
    };
    const tgt = {
      ...createDefaultWhiteboardNode("tgt", "ellipse", 300, 200),
      text: "Keep Me",
      width: 240,
      height: 120,
    };
    const snap = extractStyleSnapshot(src);
    const painted = applyStyleSnapshot(tgt, snap);
    expect(painted.text).toBe("Keep Me");
    expect(painted.shapeType).toBe("ellipse");
    expect(painted.width).toBe(240);
    expect(painted.fillColor).toBe("#dbeafe");
    expect(painted.strokeColor).toBe("#1d4ed8");
    expect(painted.strokeWidth).toBe(4);
    expect(painted.fontWeight).toBe("bold");
    expect(painted.blendMode).toBe("multiply");
  });

  it("searches text across all pages, tables, mindmap notes/resources, and edges", () => {
    const doc = createEmptyWhiteboardDocument("wb-s", "Search Test");
    const p2 = createEmptyWhiteboardPage("p2", "Architecture");
    const n1 = { ...createDefaultWhiteboardNode("n1", "mindmapTopic", 100, 100), text: "Quantum Gates", mindmapDescription: "Hadamard transform" };
    const n2 = { ...createDefaultWhiteboardNode("n2", "table", 200, 200), tableCellText: [["Qubit", "Hadamard"], ["0", "1"]] };
    const e1 = { ...createDefaultWhiteboardEdge("e1", { x: 0, y: 0 }, { x: 100, y: 100 }), label: "hadamard link" };
    doc.pages[0].nodes = [n1];
    p2.nodes = [n2];
    p2.edges = [e1];
    doc.pages.push(p2);

    const hits = searchWhiteboardDocument(doc, "hadamard");
    expect(hits.length).toBe(3);
    expect(hits.map((h) => h.itemId)).toEqual(["n1", "n2", "e1"]);
    expect(hits[1].pageName).toBe("Architecture");
  });

  it("orders artboard frames in top-to-bottom, left-to-right reading order", () => {
    const f3 = { ...createDefaultWhiteboardNode("f3", "artboard", 0, 0), x: 800, y: 600, width: 400, height: 300 };
    const f1 = { ...createDefaultWhiteboardNode("f1", "artboard", 0, 0), x: 0, y: 20, width: 400, height: 300 };
    const f2 = { ...createDefaultWhiteboardNode("f2", "artboard", 0, 0), x: 500, y: 0, width: 400, height: 300 };
    const rect = createDefaultWhiteboardNode("r1", "rectangle", 100, 100);
    const ordered = getOrderedArtboards([f3, rect, f2, f1]);
    expect(ordered.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("culls off-screen nodes above threshold while preserving selected and edge-anchored items", () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({
      ...createDefaultWhiteboardNode(`n${i}`, "rectangle", 0, 0),
      x: i * 400,
      y: 0,
      width: 120,
      height: 60,
    }));
    const edge = createDefaultWhiteboardEdge("e-far", { nodeId: "n55" }, { nodeId: "n56" });
    const res = cullVisibleItems(
      nodes,
      [edge],
      { minX: 0, minY: -100, maxX: 900, maxY: 500 },
      new Set(["n50"]),
      new Set(["e-far"])
    );
    expect(res.culledCount).toBeGreaterThan(40);
    const keptIds = new Set(res.nodes.map((n) => n.id));
    expect(keptIds.has("n0")).toBe(true);
    expect(keptIds.has("n50")).toBe(true); // alwaysKeepNodeIds
    expect(keptIds.has("n55")).toBe(true); // referenced by alwaysKeepEdgeIds
    expect(keptIds.has("n56")).toBe(true);
    expect(keptIds.has("n30")).toBe(false); // off-screen
  });

  it("auto-sizes text boxes to prevent multi-line clipping and expands width up to max wrap", () => {
    const short = computeAutoTextBoxSize("Hello", 16, "normal", 160, true);
    expect(short.width).toBeGreaterThanOrEqual(160);
    expect(short.height).toBeGreaterThanOrEqual(30);

    const multi = computeAutoTextBoxSize("Line one\nLine two\nLine three\nLine four", 20, "bold", 160, false);
    expect(multi.width).toBe(160);
    expect(multi.height).toBeGreaterThan(100);
  });

  it("builds every pro Whiteboard starter template cleanly", () => {
    for (const tpl of WHITEBOARD_TEMPLATES) {
      const doc = createWhiteboardFromTemplate(`doc-${tpl.id}`, tpl.name, tpl.id);
      expect(doc.pages.length).toBe(1);
      if (tpl.id !== "blank") {
        expect(doc.pages[0].nodes.length).toBeGreaterThan(0);
      }
      if (tpl.id === "slides") {
        expect(getOrderedArtboards(doc.pages[0].nodes).length).toBe(3);
      }
    }
  });
});

describe("whiteboardInterchangeHandlers", () => {
  it("exports valid standalone vector SVG with XML escaping and collapsed branch filtering", () => {
    const page = createEmptyWhiteboardPage("p-svg", "SVG Test");
    const root = { ...createDefaultWhiteboardNode("r", "mindmapTopic", 100, 100), text: "A & B <C>", mindmapCollapsed: true };
    const hiddenChild = { ...createDefaultWhiteboardNode("h", "mindmapSubtopic", 350, 100), text: "Secret Hidden" };
    const frame = { ...createDefaultWhiteboardNode("f", "artboard", 200, 200), text: "Slide 1" };
    const e1 = createDefaultWhiteboardEdge("e1", { nodeId: "r" }, { nodeId: "h" });
    page.nodes = [root, hiddenChild, frame];
    page.edges = [e1];

    const svg = exportWhiteboardToSvg(page);
    expect(svg).toContain("<svg xmlns=\"http://www.w3.org/2000/svg\"");
    expect(svg).toContain("A &amp; B &lt;C&gt;");
    expect(svg).toContain("Slide 1");
    expect(svg).not.toContain("Secret Hidden");
  });

  it("round-trips Markdown outline <-> Mind Map preserving checkboxes and inline resource links", () => {
    const md = `# Physics Study
- Quantum Mechanics
  - [x] Superposition ([MIT Notes](https://ocw.mit.edu))
  - [ ] Entanglement
- Relativity`;
    const built = parseMarkdownToMindmap(md, "balanced");
    expect(built.nodes.length).toBe(5);
    expect(built.edges.length).toBe(4);
    const superNode = built.nodes.find((n) => n.text.includes("Superposition"));
    expect(superNode?.mindmapProgress).toBe("done");
    expect(superNode?.mindmapResources?.[0]?.url).toBe("https://ocw.mit.edu");

    const page = createEmptyWhiteboardPage("p-md", "MD");
    page.nodes = built.nodes;
    page.edges = built.edges;
    const exported = exportMindmapToMarkdown(page);
    expect(exported).toContain("# Physics Study");
    expect(exported).toContain("[x] Superposition");
    expect(exported).toContain("[MIT Notes](https://ocw.mit.edu)");
  });

  it("parses Mermaid flowcharts with shapes, edge labels, dashed links, and subgraphs as artboards", () => {
    const mermaid = `flowchart LR
  subgraph API
    A([Start]) --> B{Valid?}
    B -->|Yes| C[(Database)]
    B -.->|No| D((Error))
  end`;
    const built = parseMermaidToWhiteboard(mermaid);
    const artboards = built.nodes.filter((n) => n.shapeType === "artboard");
    expect(artboards.length).toBe(1);
    expect(artboards[0].text).toBe("API");
    expect(built.nodes.some((n) => n.shapeType === "diamond" && n.text === "Valid?")).toBe(true);
    expect(built.nodes.some((n) => n.shapeType === "cylinder" && n.text === "Database")).toBe(true);
    expect(built.nodes.some((n) => n.shapeType === "ellipse" && n.text === "Error")).toBe(true);
    expect(built.edges.length).toBe(3);
    expect(built.edges.find((e) => e.label === "No")?.strokeStyle).toBe("dashed");
  });

  it("switches node shape types while preserving text and geometry", () => {
    const rect = { ...createDefaultWhiteboardNode("n1", "rectangle", 50, 60), text: "Keep Text", width: 200, height: 80 };
    const diff = switchNodesShapeType([rect], "diamond");
    expect(diff.after.length).toBe(1);
    expect(diff.after[0].shapeType).toBe("diamond");
    expect(diff.after[0].text).toBe("Keep Text");
    expect(diff.after[0].width).toBe(200);
  });

  it("builds tapered perfect-freehand ink and highlighter paths and respects canvas theme bg in SVG export", () => {
    const strokePts = [
      { x: 0, y: 0 },
      { x: 18, y: 8 },
      { x: 40, y: 22 },
      { x: 72, y: 18 },
    ];
    const penD = buildTaperedFreehandPathD(strokePts, 3, false);
    const hiD = buildTaperedFreehandPathD(strokePts, 10, true);
    expect(penD.startsWith("M")).toBe(true);
    expect(penD.endsWith("Z")).toBe(true);
    expect(hiD.startsWith("M")).toBe(true);
    expect(hiD).not.toBe(penD);
    expect(buildTaperedFreehandPathD([], 3, false)).toBe("");

    expect(WHITEBOARD_CANVAS_THEMES.length).toBe(4);
    expect(resolveCanvasTheme("blueprint").isDark).toBe(true);
    expect(resolveCanvasTheme("paper").bg).toBe("#faf6ee");
    expect(resolveCanvasTheme(undefined).id).toBe("light");
    expect(NODE_STYLE_PRESETS.length).toBeGreaterThanOrEqual(6);

    const page = createEmptyWhiteboardPage("p-ink", "Ink");
    const inkNode = createDefaultWhiteboardNode("ink-1", "freehand", 10, 10);
    inkNode.width = 100;
    inkNode.height = 50;
    inkNode.strokeColor = "#2563eb";
    inkNode.strokeWidth = 3;
    inkNode.points = [
      { x: 0, y: 0.2 },
      { x: 0.5, y: 0.8 },
      { x: 1, y: 0.4 },
    ];
    page.nodes = [inkNode];
    const svg = exportWhiteboardToSvg(page, resolveCanvasTheme("blueprint").bg);
    expect(svg).toContain(`fill="${resolveCanvasTheme("blueprint").bg}"`);
    expect(svg).toContain(`fill="#2563eb"`);
  });

  it("moves a newly dropped artboard to start or end without stealing overlapping Slide 1 children and matches slide size", () => {
    const s1 = { ...createDefaultWhiteboardNode("s1", "artboard", 0, 0), x: 80, y: 80, width: 960, height: 540, text: "Slide 1", createdAt: 1000 };
    const s2 = { ...createDefaultWhiteboardNode("s2", "artboard", 0, 0), x: 1136, y: 80, width: 960, height: 540, text: "Slide 2", createdAt: 1001 };
    const s3 = { ...createDefaultWhiteboardNode("s3", "artboard", 0, 0), x: 2192, y: 80, width: 960, height: 540, text: "Slide 3", createdAt: 1002 };
    const s1Logo = { ...createDefaultWhiteboardNode("logo", "rectangle", 0, 0), x: 110, y: 110, width: 120, height: 80, text: "CERN", createdAt: 1000 };
    const newFrame = { ...createDefaultWhiteboardNode("nf", "artboard", 0, 0), x: 60, y: 40, width: 640, height: 420, text: "Frame", createdAt: 2000 };

    const allNodes = [s1, s2, s3, s1Logo, newFrame];

    const toEnd = arrangeArtboardFrames(allNodes, [], { kind: "moveToEnd", frameId: "nf" });
    expect(toEnd.targetFrameAfter?.width).toBe(960);
    expect(toEnd.targetFrameAfter?.height).toBe(540);
    expect(toEnd.targetFrameAfter?.x).toBe(80);
    expect(toEnd.targetFrameAfter?.y).toBe(720);
    expect(toEnd.afterNodes.find((n) => n.id === "logo")).toBeUndefined();

    const toStart = arrangeArtboardFrames(allNodes, [], { kind: "moveToStart", frameId: "nf" });
    expect(toStart.targetFrameAfter?.x).toBe(80);
    expect(toStart.targetFrameAfter?.y).toBe(80);
    expect(toStart.targetFrameAfter?.width).toBe(960);
    const movedS1 = toStart.afterNodes.find((n) => n.id === "s1");
    const movedLogo = toStart.afterNodes.find((n) => n.id === "logo");
    expect(movedS1?.x).toBe(1136);
    expect(movedLogo?.x).toBe(110 + (1136 - 80));
  });
});
