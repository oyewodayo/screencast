import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECK_COLOR,
  MINDMAP_CHECK_GLYPH,
  MINDMAP_CHECK_STYLES,
  MINDMAP_TYPE_DEFAULTS,
  MindmapNode,
  createEmptyMindmapDocument,
  createMindmapNode,
  nodeItems,
  nodeResources,
  resolveCheckColor,
  resolveCheckStyle,
  resolveProgress,
} from "../utils/mindmapTypes";
import { createStarterMindmapDocument } from "../utils/mindmapTemplate";
import type { MindmapCommand } from "./mindmapHandlers";
import {
  ADD_TOPIC_GAP,
  applyMindmapCommand,
  autoSizedBox,
  buildAddTopic,
  canAutoSize,
  computeContentBounds,
  edgePath,
  edgesTouching,
  invertMindmapCommand,
  nodeCenter,
  sidePoint,
} from "./mindmapHandlers";

const topic = (overrides: Partial<MindmapNode> = {}): MindmapNode => ({
  ...createMindmapNode("p", "topic", 500, 500),
  ...overrides,
});

describe("node factory", () => {
  it("centers a new node on the requested point", () => {
    const n = createMindmapNode("a", "topic", 300, 200);
    expect(n.x + n.width / 2).toBeCloseTo(300, 6);
    expect(n.y + n.height / 2).toBeCloseTo(200, 6);
  });

  it("applies the type's own defaults", () => {
    const n = createMindmapNode("a", "subtopic", 0, 0);
    const d = MINDMAP_TYPE_DEFAULTS.subtopic;
    expect(n.width).toBe(d.width);
    expect(n.colorKey).toBe(d.colorKey);
    expect(n.fontSize).toBe(d.fontSize);
  });

  it("seeds list types with placeholder rows so their purpose is legible on drop", () => {
    expect(createMindmapNode("a", "checklist", 0, 0).items?.length).toBeGreaterThan(0);
    expect(createMindmapNode("a", "linksGroup", 0, 0).items?.length).toBeGreaterThan(0);
    expect(createMindmapNode("a", "topic", 0, 0).items).toBeUndefined();
  });
});

describe("progress and resources are topic-only", () => {
  it("reports pending for a non-topic node even if a stale value is stored", () => {
    expect(resolveProgress(createMindmapNode("a", "paragraph", 0, 0))).toBe("pending");
    expect(resolveProgress({ ...createMindmapNode("a", "paragraph", 0, 0), progress: "done" })).toBe("pending");
  });

  it("honours progress on a topic node", () => {
    expect(resolveProgress({ ...topic(), progress: "done" })).toBe("done");
  });

  it("hides resources on a non-topic node", () => {
    const res = [{ id: "r", type: "article" as const, label: "x", url: "u" }];
    expect(nodeResources({ ...createMindmapNode("a", "label", 0, 0), resources: res })).toEqual([]);
    expect(nodeResources({ ...topic(), resources: res })).toEqual(res);
  });
});

describe("geometry", () => {
  it("anchors a connector at the midpoint of the named side", () => {
    const n = topic({ x: 100, y: 200, width: 200, height: 50 });
    expect(sidePoint(n, "top")).toEqual({ x: 200, y: 200 });
    expect(sidePoint(n, "bottom")).toEqual({ x: 200, y: 250 });
    expect(sidePoint(n, "left")).toEqual({ x: 100, y: 225 });
    expect(sidePoint(n, "right")).toEqual({ x: 300, y: 225 });
  });

  it("builds a cubic bezier that starts and ends on the two side points", () => {
    const a = topic({ id: "a", x: 0, y: 0, width: 100, height: 40 });
    const b = topic({ id: "b", x: 300, y: 0, width: 100, height: 40 });
    const d = edgePath(a, "right", b, "left");
    expect(d.startsWith("M100.00,20.00")).toBe(true);
    expect(d).toContain("C");
    expect(d.endsWith("300.00,20.00")).toBe(true);
  });

  it("pads the content bounds around the nodes", () => {
    const bounds = computeContentBounds({ nodes: [topic({ x: 0, y: 0, width: 100, height: 100 })] });
    expect(bounds.minX).toBeLessThan(0);
    expect(bounds.maxX).toBeGreaterThan(100);
  });

  it("gives an empty document a usable window rather than an inverted one", () => {
    const bounds = computeContentBounds({ nodes: [] });
    expect(bounds.maxX).toBeGreaterThan(bounds.minX);
    expect(bounds.maxY).toBeGreaterThan(bounds.minY);
  });
});

describe("directional add topic", () => {
  const parent = topic({ id: "parent", x: 500, y: 500, width: 200, height: 50 });

  it("places the child beyond the chosen side, centered on the parent", () => {
    const { node } = buildAddTopic(parent, "bottom", "subtopic", [parent], "n1", "e1");
    expect(node.y).toBeGreaterThanOrEqual(parent.y + parent.height + ADD_TOPIC_GAP - 1);
    expect(node.x + node.width / 2).toBeCloseTo(nodeCenter(parent).x, 6);
  });

  it("places a left child to the left and a right child to the right", () => {
    const left = buildAddTopic(parent, "left", "subtopic", [parent], "n1", "e1").node;
    const right = buildAddTopic(parent, "right", "subtopic", [parent], "n2", "e2").node;
    expect(left.x + left.width).toBeLessThanOrEqual(parent.x);
    expect(right.x).toBeGreaterThanOrEqual(parent.x + parent.width);
  });

  it("connects the child on the side facing its parent, so the curve runs straight", () => {
    const { edge } = buildAddTopic(parent, "right", "subtopic", [parent], "n1", "e1");
    expect(edge.sourceSide).toBe("right");
    expect(edge.targetSide).toBe("left");
    expect(edge.sourceId).toBe("parent");
    expect(edge.targetId).toBe("n1");
  });

  // The behaviour that makes repeated adds usable: three "add below" presses must produce three
  // visible siblings, not three nodes hidden on top of each other.
  it("fans repeated siblings out instead of stacking them", () => {
    let existing = [parent];
    const placed: MindmapNode[] = [];
    for (let i = 0; i < 3; i++) {
      const { node } = buildAddTopic(parent, "bottom", "subtopic", existing, `n${i}`, `e${i}`);
      placed.push(node);
      existing = [...existing, node];
    }
    const centers = placed.map((n) => n.x + n.width / 2);
    expect(new Set(centers.map((c) => Math.round(c))).size).toBe(3);
  });

  it("uses a dashed connector for a subtopic and a solid one otherwise", () => {
    expect(buildAddTopic(parent, "bottom", "subtopic", [parent], "n", "e").edge.style).toBe("dashed");
    expect(buildAddTopic(parent, "bottom", "topic", [parent], "n", "e").edge.style).toBe("solid");
  });
});

describe("auto-size", () => {
  // Regression: auto-sizing a divider forced it up to the labelled-box minimum (80x32), turning a
  // 220x2 rule into a filled black rectangle, because a line's height IS its thickness.
  it("refuses to auto-size a divider", () => {
    expect(canAutoSize(createMindmapNode("a", "horizontalLine", 0, 0))).toBe(false);
    expect(canAutoSize(createMindmapNode("a", "verticalLine", 0, 0))).toBe(false);
  });

  it("allows auto-size for every type that actually has text", () => {
    for (const type of ["title", "topic", "subtopic", "paragraph", "label", "button", "checklist", "linksGroup"] as const) {
      expect(canAutoSize(createMindmapNode("a", type, 0, 0))).toBe(true);
    }
  });

  it("adds padding around the measured text", () => {
    const box = autoSizedBox(100, 20);
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(20);
  });

  it("never collapses below a clickable minimum", () => {
    const box = autoSizedBox(0, 0);
    expect(box.width).toBeGreaterThanOrEqual(80);
    expect(box.height).toBeGreaterThanOrEqual(32);
  });
});

describe("commands", () => {
  const base = () => {
    const doc = createEmptyMindmapDocument("d", "Doc");
    return { ...doc, nodes: [topic({ id: "a" }), topic({ id: "b" })], edges: [{ id: "e1", sourceId: "a", sourceSide: "right" as const, targetId: "b", targetSide: "left" as const, style: "solid" as const }] };
  };

  it("round-trips every command through its own inverse", () => {
    const doc = base();
    const commands = [
      { type: "add-nodes", nodes: [topic({ id: "c" })], edges: [] },
      { type: "delete-nodes", nodes: [doc.nodes[0]], edges: doc.edges, indices: [0] },
      { type: "edit-nodes", before: [doc.nodes[0]], after: [{ ...doc.nodes[0], label: "changed" }] },
      { type: "edit-edge", before: doc.edges[0], after: { ...doc.edges[0], style: "dashed" as const } },
      { type: "reorder-nodes", before: doc.nodes, after: [...doc.nodes].reverse() },
      { type: "edit-doc", before: { name: "Doc", description: "" }, after: { name: "New", description: "d" } },
    ] satisfies MindmapCommand[];
    for (const command of commands) {
      const applied = applyMindmapCommand(doc, command);
      const reverted = applyMindmapCommand(applied, invertMindmapCommand(command));
      expect(reverted.nodes).toEqual(doc.nodes);
      expect(reverted.edges).toEqual(doc.edges);
      expect(reverted.name).toEqual(doc.name);
    }
  });

  it("deleting a node takes its connectors with it", () => {
    const doc = base();
    const touching = edgesTouching(doc.edges, new Set(["a"]));
    expect(touching).toHaveLength(1);
    const after = applyMindmapCommand(doc, { type: "delete-nodes", nodes: [doc.nodes[0]], edges: touching });
    expect(after.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(after.edges).toHaveLength(0);
  });

  // Array order is z-order, so undoing a delete has to restore the node's original position, not
  // append it on top of whatever it used to sit behind.
  it("restores z-order when a delete is undone", () => {
    const doc = base();
    const removed = doc.nodes[0];
    const command = { type: "delete-nodes" as const, nodes: [removed], edges: edgesTouching(doc.edges, new Set([removed.id])), indices: [0] };
    const after = applyMindmapCommand(doc, command);
    const restored = applyMindmapCommand(after, invertMindmapCommand(command));
    expect(restored.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("adds a node and its connector as one command", () => {
    const doc = base();
    const child = topic({ id: "c" });
    const edge = { id: "e2", sourceId: "a", sourceSide: "bottom" as const, targetId: "c", targetSide: "top" as const, style: "dashed" as const };
    const after = applyMindmapCommand(doc, { type: "add-nodes", nodes: [child], edges: [edge] });
    expect(after.nodes).toHaveLength(3);
    expect(after.edges).toHaveLength(2);
    // And one undo removes both, which is the whole point of them sharing a command.
    const undone = applyMindmapCommand(after, invertMindmapCommand({ type: "add-nodes", nodes: [child], edges: [edge] }));
    expect(undone.nodes).toHaveLength(2);
    expect(undone.edges).toHaveLength(1);
  });
});

describe("starter template", () => {
  const doc = createStarterMindmapDocument("d", "Test roadmap");

  it("is not empty - a blank canvas hides every interaction this tool has", () => {
    expect(doc.nodes.length).toBeGreaterThan(10);
    expect(doc.edges.length).toBeGreaterThan(5);
  });

  it("gives every node a unique id, and every edge two endpoints that resolve", () => {
    const ids = new Set(doc.nodes.map((n) => n.id));
    expect(ids.size).toBe(doc.nodes.length);
    for (const edge of doc.edges) {
      expect(ids.has(edge.sourceId)).toBe(true);
      expect(ids.has(edge.targetId)).toBe(true);
    }
  });

  it("generates fresh ids per call, so two mindmaps never share nodes", () => {
    const other = createStarterMindmapDocument("e", "Another");
    const overlap = new Set(doc.nodes.map((n) => n.id));
    expect(other.nodes.some((n) => overlap.has(n.id))).toBe(false);
  });

  it("shows the shape of a roadmap: a spine of topics with subtopics branching off", () => {
    expect(doc.nodes.filter((n) => n.type === "topic").length).toBeGreaterThanOrEqual(3);
    expect(doc.nodes.filter((n) => n.type === "subtopic").length).toBeGreaterThanOrEqual(5);
    expect(doc.nodes.some((n) => n.type === "title")).toBe(true);
    // Solid connectors sequence the spine; dashed ones hang subtopics off it.
    expect(doc.edges.some((e) => e.style === "solid")).toBe(true);
    expect(doc.edges.some((e) => e.style === "dashed")).toBe(true);
  });

  it("seeds one topic with content, so Content & Links isn't empty the first time it's opened", () => {
    const withResources = doc.nodes.find((n) => (n.resources?.length ?? 0) > 0);
    expect(withResources).toBeDefined();
    expect(withResources!.description).toBeTruthy();
    expect(doc.nodes.some((n) => n.progress && n.progress !== "pending")).toBe(true);
  });

  it("explains this app's own gestures rather than leaving them to be discovered", () => {
    const prose = doc.nodes.map((n) => n.label).join("\n");
    for (const hint of ["Live View", "Content & Links", "double-click", "sidebar"]) {
      expect(prose.toLowerCase()).toContain(hint.toLowerCase());
    }
  });

  it("centres a size-overridden node on the point it was given", () => {
    // Regression: createMindmapNode used to derive x/y from the TYPE's default size and only then
    // apply overrides, leaving any custom-sized node off-centre from its requested point.
    const wide = createMindmapNode("w", "paragraph", 500, 300, { width: 340, height: 400 });
    expect(wide.x + wide.width / 2).toBeCloseTo(500, 6);
    expect(wide.y + wide.height / 2).toBeCloseTo(300, 6);
  });
});

describe("checklist items", () => {
  it("only reports rows for types that actually own them", () => {
    expect(nodeItems(createMindmapNode("a", "checklist", 0, 0)).length).toBeGreaterThan(0);
    expect(nodeItems(createMindmapNode("a", "linksGroup", 0, 0)).length).toBeGreaterThan(0);
    // A stale items array left over from a type change must not render on a topic.
    expect(nodeItems({ ...createMindmapNode("a", "topic", 0, 0), items: [{ id: "x", text: "stale" }] })).toEqual([]);
  });

  it("defaults the checkmark to a green tick, and honours an override", () => {
    const node = createMindmapNode("a", "checklist", 0, 0);
    expect(resolveCheckStyle(node)).toBe("tick");
    expect(resolveCheckColor(node)).toBe(DEFAULT_CHECK_COLOR);
    expect(resolveCheckStyle({ ...node, checkStyle: "cross" })).toBe("cross");
    expect(resolveCheckColor({ ...node, checkColor: "#ff0000" })).toBe("#ff0000");
  });

  it("has a glyph for every style, so a style can never render blank", () => {
    for (const style of MINDMAP_CHECK_STYLES) {
      expect(MINDMAP_CHECK_GLYPH[style]).toBeTruthy();
    }
  });
});
