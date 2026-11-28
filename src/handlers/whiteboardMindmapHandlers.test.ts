import { describe, expect, it } from "vitest";
import {
  buildMindmapBranch,
  buildMindmapInsertedParent,
  exportMindmapToOutlineMarkdown,
  findMindmapRoot,
  getMindmapSubtree,
  inferMindmapChildSide,
  recolorMindmapBranch,
  reorderMindmapSibling,
  setAllMindmapCollapsed,
} from "./whiteboardMindmapHandlers";
import { createDefaultWhiteboardNode, createEmptyWhiteboardPage } from "../utils/whiteboardTypes";

function makeSampleMap() {
  const page = createEmptyWhiteboardPage("p1", "Page 1");
  const root = { ...createDefaultWhiteboardNode("root", "mindmapTopic", 400, 300), text: "Central Idea" };
  page.nodes.push(root);

  const r1 = buildMindmapBranch(root, "right", page.nodes, "r1", "er1", { text: "Goals" });
  page.nodes.push(r1.node);
  page.edges.push(r1.edge);

  const l1 = buildMindmapBranch(root, "left", page.nodes, "l1", "el1", { text: "Research" });
  page.nodes.push(l1.node);
  page.edges.push(l1.edge);

  const r2 = buildMindmapBranch(root, "right", page.nodes, "r2", "er2", { text: "Architecture" });
  r2.node.y = r1.node.y + 120;
  page.nodes.push(r2.node);
  page.edges.push(r2.edge);

  const l1a = buildMindmapBranch(l1.node, "left", page.nodes, "l1a", "el1a", { text: "References" });
  page.nodes.push(l1a.node);
  page.edges.push(l1a.edge);

  return page;
}

describe("whiteboardMindmapHandlers pro operations", () => {
  it("walks up to the Mind Map root from any deep leaf", () => {
    const page = makeSampleMap();
    expect(findMindmapRoot("l1a", page.nodes, page.edges)).toBe("root");
    expect(findMindmapRoot("r2", page.nodes, page.edges)).toBe("root");
  });

  it("grows left branches leftward, right branches rightward, and balances roots", () => {
    const page = makeSampleMap();
    const l1 = page.nodes.find((n) => n.id === "l1")!;
    const r1 = page.nodes.find((n) => n.id === "r1")!;
    const root = page.nodes.find((n) => n.id === "root")!;
    expect(inferMindmapChildSide(l1, page)).toBe("left");
    expect(inferMindmapChildSide(r1, page)).toBe("right");
    // Root currently has 2 right branches and 1 left branch -> balances left!
    expect(inferMindmapChildSide(root, page)).toBe("left");
  });

  it("collects subtree nodes and edges and recolors the full branch", () => {
    const page = makeSampleMap();
    const sub = getMindmapSubtree("l1", page.nodes, page.edges);
    expect(Array.from(sub.nodeIds).sort()).toEqual(["l1", "l1a"]);
    expect(Array.from(sub.edgeIds)).toEqual(["el1a"]);

    const diff = recolorMindmapBranch("l1", "C", page.nodes, page.edges);
    expect(diff.after).toHaveLength(2);
    expect(diff.after.every((n) => n.mindmapColorKey === "C")).toBe(true);
    expect(diff.afterEdges).toHaveLength(1);
  });

  it("collapses all non-root branch parents and expands all cleanly", () => {
    const page = makeSampleMap();
    const col = setAllMindmapCollapsed("l1a", true, page.nodes, page.edges);
    expect(col.after.map((n) => n.id)).toEqual(["l1"]);
    expect(col.after[0].mindmapCollapsed).toBe(true);
  });

  it("reorders sibling branches up/down without corrupting positions", () => {
    const page = makeSampleMap();
    const r1Before = page.nodes.find((n) => n.id === "r1")!.y;
    const r2Before = page.nodes.find((n) => n.id === "r2")!.y;
    const diff = reorderMindmapSibling("r2", "up", page);
    const r1After = diff.after.find((n) => n.id === "r1")!.y;
    const r2After = diff.after.find((n) => n.id === "r2")!.y;
    expect(r2After).toBe(r1Before);
    expect(r1After).toBe(r2Before);
  });

  it("inserts a grouping parent cleanly between parent and child", () => {
    const page = makeSampleMap();
    const l1 = page.nodes.find((n) => n.id === "l1")!;
    const res = buildMindmapInsertedParent(l1, page, "grp", "egrp");
    expect(res.updatedIncomingEdge?.after.target.nodeId).toBe("grp");
    expect(res.newEdge.source.nodeId).toBe("grp");
    expect(res.newEdge.target.nodeId).toBe("l1");
    expect(res.shiftedNodes.after.map((n) => n.id).sort()).toEqual(["l1", "l1a"]);
  });

  it("exports structured Markdown outline for Briefcast Docs", () => {
    const page = makeSampleMap();
    const { title, markdown } = exportMindmapToOutlineMarkdown("l1a", page.nodes, page.edges);
    expect(title).toBe("Central Idea");
    expect(markdown).toContain("# Central Idea");
    expect(markdown).toContain("## Research");
    expect(markdown).toContain("- **References**");
    expect(markdown).toContain("## Goals");
  });
});
