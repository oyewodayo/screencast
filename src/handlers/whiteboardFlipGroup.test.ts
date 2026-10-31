import { describe, expect, it } from "vitest";
import { createDefaultWhiteboardEdge, createDefaultWhiteboardNode, createEmptyWhiteboardPage, WhiteboardNode } from "../utils/whiteboardTypes";
import { applyCommand, flipItems, invertCommand } from "./whiteboardHandlers";

function node(id: string, x: number, y: number, w: number, h: number, overrides: Partial<WhiteboardNode> = {}): WhiteboardNode {
  return { ...createDefaultWhiteboardNode(id, "rectangle", 0, 0), x, y, width: w, height: h, ...overrides };
}

describe("flipItems", () => {
  it("mirrors a single shape in place, toggling its flip flag", () => {
    const n = node("a", 10, 20, 100, 50, { shapeType: "triangle" });
    const h = flipItems([n], [], "horizontal", new Map()).nodes[0];
    expect(h).toMatchObject({ x: 10, y: 20, flipHorizontal: true });
    const back = flipItems([h], [], "horizontal", new Map()).nodes[0];
    expect(back.flipHorizontal).toBeUndefined();
    const v = flipItems([n], [], "vertical", new Map()).nodes[0];
    expect(v).toMatchObject({ x: 10, y: 20, flipVertical: true });
  });

  it("reflects each shape's position across the selection's center", () => {
    const a = node("a", 0, 0, 100, 100);
    const b = node("b", 300, 200, 50, 50);
    const [ha, hb] = flipItems([a, b], [], "horizontal", new Map()).nodes;
    // Bounds x 0..350 - a (left edge) lands at the right edge, b at the left.
    expect(ha.x).toBe(250);
    expect(hb.x).toBe(0);
    expect([ha.y, hb.y]).toEqual([0, 200]);
    const [va, vb] = flipItems([a, b], [], "vertical", new Map()).nodes;
    // Bounds y 0..250.
    expect(va.y).toBe(150);
    expect(vb.y).toBe(0);
  });

  it("negates rotation so a rotated shape is mirrored on screen", () => {
    const n = node("a", 0, 0, 100, 50, { rotation: 30 });
    expect(flipItems([n], [], "horizontal", new Map()).nodes[0].rotation).toBe(330);
    expect(flipItems([{ ...n, rotation: undefined }], [], "vertical", new Map()).nodes[0].rotation).toBeUndefined();
  });

  it("mirrors a free connector across the whole selection's center, not its own", () => {
    const a = node("a", 0, 0, 100, 100);
    const line = createDefaultWhiteboardEdge("e", { x: 300, y: 0 }, { x: 300, y: 100 });
    const { nodes, edges } = flipItems([a], [line], "horizontal", new Map());
    // Bounds x 0..300: the line jumps to the left edge, the shape to the right.
    expect(nodes[0].x).toBe(200);
    expect(edges[0].source).toMatchObject({ x: 0, y: 0 });
    expect(edges[0].target).toMatchObject({ x: 0, y: 100 });
  });
});

describe("batch-edit-items command", () => {
  it("applies node and edge edits together and undoes them together", () => {
    const a = node("a", 0, 0, 10, 10);
    const e = createDefaultWhiteboardEdge("e", { x: 0, y: 0 }, { x: 5, y: 5 });
    const page = { ...createEmptyWhiteboardPage("p", "Page 1"), nodes: [a], edges: [e] };
    const cmd = { type: "batch-edit-items" as const, beforeNodes: [a], afterNodes: [{ ...a, groupId: "g" }], beforeEdges: [e], afterEdges: [{ ...e, groupId: "g" }] };
    const grouped = applyCommand(page, cmd);
    expect(grouped.nodes[0].groupId).toBe("g");
    expect(grouped.edges[0].groupId).toBe("g");
    const undone = applyCommand(grouped, invertCommand(cmd));
    expect(undone.nodes[0].groupId).toBeUndefined();
    expect(undone.edges[0].groupId).toBeUndefined();
  });
});
