// handlers/whiteboardHandlers.ts
//
// Pure functions only - no React, no closures over component state. Independent implementation
// for the Whiteboard feature, same "build from scratch" separation boardHandlers.ts's own top
// comment describes for Board: geometry here is axis-aligned (no rotation) and centered on
// connector routing, neither of which the Board/image-editor geometry helpers have any use for.

import {
  WhiteboardAnchorSide,
  WhiteboardCommand,
  WhiteboardDocument,
  WhiteboardEdge,
  WhiteboardEndpoint,
  WhiteboardNode,
} from "../utils/whiteboardTypes";

// ---- Node geometry ----------------------------------------------------------------------------

export function nodeCenter(node: WhiteboardNode): { x: number; y: number } {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

// Picks whichever side of `node` faces `towardPoint` most directly, comparing how far outside
// the node's box `towardPoint` sits on each axis - the larger overhang wins. Ties (a point exactly
// on a diagonal) resolve to the horizontal side, an arbitrary but stable choice.
function resolveAutoSide(node: WhiteboardNode, towardPoint: { x: number; y: number }): "top" | "right" | "bottom" | "left" {
  const center = nodeCenter(node);
  const dx = towardPoint.x - center.x;
  const dy = towardPoint.y - center.y;
  const halfW = node.width / 2 || 1;
  const halfH = node.height / 2 || 1;
  // Normalize by half-extent so a wide-but-short node doesn't always prefer left/right just
  // because dx tends to be numerically larger than dy.
  const nx = Math.abs(dx) / halfW;
  const ny = Math.abs(dy) / halfH;
  if (nx >= ny) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

// The point on `node`'s chosen side closest to `towardPoint`, projecting the other endpoint's
// coordinate onto that side (clamped to the node's own extent) rather than always the side's
// midpoint - two boxes connected side-by-side get a straight perpendicular line instead of a
// dog-legged one, the same "floating connection" look draw.io uses for auto-anchored edges.
export function resolveAnchorPoint(node: WhiteboardNode, side: WhiteboardAnchorSide, towardPoint: { x: number; y: number }): { x: number; y: number; side: "top" | "right" | "bottom" | "left" } {
  const resolvedSide = side === "auto" || !side ? resolveAutoSide(node, towardPoint) : side;
  if (resolvedSide === "left" || resolvedSide === "right") {
    const y = Math.min(node.y + node.height, Math.max(node.y, towardPoint.y));
    return { x: resolvedSide === "left" ? node.x : node.x + node.width, y, side: resolvedSide };
  }
  const x = Math.min(node.x + node.width, Math.max(node.x, towardPoint.x));
  return { x, y: resolvedSide === "top" ? node.y : node.y + node.height, side: resolvedSide };
}

// Resolves one endpoint of an edge to a live document-space point (+ which side it's leaving
// from, needed by buildEdgePath's orthogonal routing). `towardPoint` is the OTHER endpoint's own
// resolved reference point (its node's center, or its free x/y) - what an "auto" anchor picks a
// side relative to.
export function resolveEndpointPoint(
  endpoint: WhiteboardEndpoint,
  nodesById: Map<string, WhiteboardNode>,
  towardPoint: { x: number; y: number }
): { x: number; y: number; side: "top" | "right" | "bottom" | "left" | null } {
  if (endpoint.nodeId) {
    const node = nodesById.get(endpoint.nodeId);
    if (!node) return { x: towardPoint.x, y: towardPoint.y, side: null };
    const resolved = resolveAnchorPoint(node, endpoint.anchor ?? "auto", towardPoint);
    return resolved;
  }
  return { x: endpoint.x ?? 0, y: endpoint.y ?? 0, side: null };
}

// The reference point used to decide the OTHER endpoint's auto-anchor side: a node's own center
// (so the far endpoint picks the side facing the middle of this shape, not one specific edge
// point - avoids feedback where each side's choice depends on the other's already-resolved point).
export function endpointReferencePoint(endpoint: WhiteboardEndpoint, nodesById: Map<string, WhiteboardNode>): { x: number; y: number } {
  if (endpoint.nodeId) {
    const node = nodesById.get(endpoint.nodeId);
    if (node) return nodeCenter(node);
  }
  return { x: endpoint.x ?? 0, y: endpoint.y ?? 0 };
}

export interface ResolvedEdgeEndpoints {
  source: { x: number; y: number; side: "top" | "right" | "bottom" | "left" | null };
  target: { x: number; y: number; side: "top" | "right" | "bottom" | "left" | null };
}

export function resolveEdgeEndpoints(edge: WhiteboardEdge, nodesById: Map<string, WhiteboardNode>): ResolvedEdgeEndpoints {
  const targetRef = endpointReferencePoint(edge.target, nodesById);
  const sourceRef = endpointReferencePoint(edge.source, nodesById);
  const source = resolveEndpointPoint(edge.source, nodesById, targetRef);
  const target = resolveEndpointPoint(edge.target, nodesById, sourceRef);
  return { source, target };
}

// Builds the SVG path `d` string for an edge between two resolved endpoints. "straight" is a
// single segment; "orthogonal" (draw.io's default connector look) inserts one or two right-angle
// bends depending on which sides the two ends leave from - a clean flowchart-style route without
// needing real obstacle-avoidance routing.
export function buildEdgePath(source: { x: number; y: number; side: "top" | "right" | "bottom" | "left" | null }, target: { x: number; y: number; side: "top" | "right" | "bottom" | "left" | null }, routing: "straight" | "orthogonal"): string {
  if (routing === "straight" || !source.side || !target.side) {
    return `M ${source.x} ${source.y} L ${target.x} ${target.y}`;
  }
  const sourceHorizontal = source.side === "left" || source.side === "right";
  const targetHorizontal = target.side === "left" || target.side === "right";

  if (sourceHorizontal && targetHorizontal) {
    const midX = (source.x + target.x) / 2;
    return `M ${source.x} ${source.y} L ${midX} ${source.y} L ${midX} ${target.y} L ${target.x} ${target.y}`;
  }
  if (!sourceHorizontal && !targetHorizontal) {
    const midY = (source.y + target.y) / 2;
    return `M ${source.x} ${source.y} L ${source.x} ${midY} L ${target.x} ${midY} L ${target.x} ${target.y}`;
  }
  // Mixed: one leaves horizontally, the other vertically - a single bend at the corner that keeps
  // each end perpendicular to the side it left from.
  if (sourceHorizontal) {
    return `M ${source.x} ${source.y} L ${target.x} ${source.y} L ${target.x} ${target.y}`;
  }
  return `M ${source.x} ${source.y} L ${source.x} ${target.y} L ${target.x} ${target.y}`;
}

// The path's final segment direction, in degrees (SVG marker-friendly: 0 = pointing +x) - what an
// arrowhead marker's orient should follow so it points the way the line is actually arriving,
// rather than the straight source->target direction (wrong for an orthogonal path's last leg).
export function edgeEndAngleDeg(source: { x: number; y: number }, target: { x: number; y: number }, routing: "straight" | "orthogonal", sourceSide: "top" | "right" | "bottom" | "left" | null, targetSide: "top" | "right" | "bottom" | "left" | null): { startDeg: number; endDeg: number } {
  if (routing === "orthogonal" && targetSide) {
    const endDeg = targetSide === "left" ? 0 : targetSide === "right" ? 180 : targetSide === "top" ? 90 : -90;
    const startDeg = sourceSide === "left" ? 180 : sourceSide === "right" ? 0 : sourceSide === "top" ? -90 : 90;
    return { startDeg, endDeg };
  }
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return { startDeg: deg + 180, endDeg: deg };
}

// ---- Bounding box / content fit -----------------------------------------------------------------

export interface BoundsBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const EMPTY_BOUNDS_PADDING = 400;

// Bounding box of every node (edges never extend past the box their endpoints already live in,
// node-attached or free) - used both by "fit to content" (WhiteboardEditor's zoom-to-fit) and PNG
// export (renderWhiteboardToCanvas below), padded so shapes/strokes never touch the crop edge.
export function computeContentBounds(doc: WhiteboardDocument): BoundsBox {
  if (doc.nodes.length === 0 && doc.edges.length === 0) {
    return { minX: -EMPTY_BOUNDS_PADDING, minY: -EMPTY_BOUNDS_PADDING, maxX: EMPTY_BOUNDS_PADDING, maxY: EMPTY_BOUNDS_PADDING };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of doc.nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  const nodesById = new Map(doc.nodes.map((n) => [n.id, n]));
  for (const edge of doc.edges) {
    const { source, target } = resolveEdgeEndpoints(edge, nodesById);
    minX = Math.min(minX, source.x, target.x);
    minY = Math.min(minY, source.y, target.y);
    maxX = Math.max(maxX, source.x, target.x);
    maxY = Math.max(maxY, source.y, target.y);
  }
  if (!Number.isFinite(minX)) {
    return { minX: -EMPTY_BOUNDS_PADDING, minY: -EMPTY_BOUNDS_PADDING, maxX: EMPTY_BOUNDS_PADDING, maxY: EMPTY_BOUNDS_PADDING };
  }
  const pad = 60;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

// ---- Command apply/invert ----------------------------------------------------------------------

export function applyCommand(doc: WhiteboardDocument, command: WhiteboardCommand): WhiteboardDocument {
  const updatedAt = new Date().toISOString();
  switch (command.type) {
    case "add-node":
      return { ...doc, nodes: [...doc.nodes, command.item], updatedAt };
    case "delete-node": {
      const removedEdgeIds = new Set(command.edges.map((e) => e.id));
      return {
        ...doc,
        nodes: doc.nodes.filter((n) => n.id !== command.item.id),
        edges: doc.edges.filter((e) => !removedEdgeIds.has(e.id)),
        updatedAt,
      };
    }
    case "edit-node":
      return { ...doc, nodes: doc.nodes.map((n) => (n.id === command.after.id ? command.after : n)), updatedAt };
    case "batch-edit-nodes": {
      const afterById = new Map(command.after.map((n) => [n.id, n]));
      return { ...doc, nodes: doc.nodes.map((n) => afterById.get(n.id) ?? n), updatedAt };
    }
    case "add-edge":
      return { ...doc, edges: [...doc.edges, command.item], updatedAt };
    case "delete-edge":
      return { ...doc, edges: doc.edges.filter((e) => e.id !== command.item.id), updatedAt };
    case "edit-edge":
      return { ...doc, edges: doc.edges.map((e) => (e.id === command.after.id ? command.after : e)), updatedAt };
    case "reorder-nodes":
      return { ...doc, nodes: command.after, updatedAt };
  }
}

export function invertCommand(command: WhiteboardCommand): WhiteboardCommand {
  switch (command.type) {
    case "add-node":
      return { type: "delete-node", item: command.item, edges: [] };
    // Deliberately drops command.edges - this alone can't express "add-node AND re-add several
    // edges" as one WhiteboardCommand. useWhiteboardStore's undo() special-cases "delete-node" and
    // calls undoDeleteNode directly instead of going through invertCommand for it; this branch only
    // exists so the switch stays exhaustive over WhiteboardCommand's `type` union.
    case "delete-node":
      return { type: "add-node", item: command.item };
    case "edit-node":
      return { type: "edit-node", before: command.after, after: command.before };
    case "batch-edit-nodes":
      return { type: "batch-edit-nodes", before: command.after, after: command.before };
    case "add-edge":
      return { type: "delete-edge", item: command.item };
    case "delete-edge":
      return { type: "add-edge", item: command.item };
    case "edit-edge":
      return { type: "edit-edge", before: command.after, after: command.before };
    case "reorder-nodes":
      return { type: "reorder-nodes", before: command.after, after: command.before };
  }
}

// Re-adds a deleted node's cascade-deleted edges too, in one shot - invertCommand alone can't
// express "add-node AND add-edge (several)" as a single WhiteboardCommand (the command union has
// no such combined type), so useWhiteboardStore's undo calls this instead of invertCommand for a
// "delete-node" specifically, applying the node re-add and each edge re-add as one doc update.
export function undoDeleteNode(doc: WhiteboardDocument, command: Extract<WhiteboardCommand, { type: "delete-node" }>): WhiteboardDocument {
  const updatedAt = new Date().toISOString();
  return { ...doc, nodes: [...doc.nodes, command.item], edges: [...doc.edges, ...command.edges], updatedAt };
}

// ---- Export rendering (flattened PNG) ------------------------------------------------------------

function shapePath(ctx: CanvasRenderingContext2D, node: WhiteboardNode): void {
  const { x, y, width, height } = node;
  ctx.beginPath();
  switch (node.shapeType) {
    case "rectangle":
    case "text":
      ctx.rect(x, y, width, height);
      break;
    case "ellipse":
      ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      break;
    case "diamond":
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x + width, y + height / 2);
      ctx.lineTo(x + width / 2, y + height);
      ctx.lineTo(x, y + height / 2);
      ctx.closePath();
      break;
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    const words = rawLine.split(" ");
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

function renderNode(ctx: CanvasRenderingContext2D, node: WhiteboardNode): void {
  if (node.shapeType !== "text") {
    shapePath(ctx, node);
    if (node.fillColor) {
      ctx.fillStyle = node.fillColor;
      ctx.fill();
    }
    if (node.strokeWidth > 0) {
      ctx.lineWidth = node.strokeWidth;
      ctx.strokeStyle = node.strokeColor;
      ctx.stroke();
    }
  }
  if (node.text) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(node.x, node.y, node.width, node.height);
    ctx.clip();
    ctx.fillStyle = node.fontColor;
    ctx.font = `${node.fontWeight === "bold" ? "bold " : ""}${node.fontSize}px system-ui, sans-serif`;
    ctx.textAlign = node.textAlign;
    ctx.textBaseline = "middle";
    const paddingX = 8;
    const lines = wrapText(ctx, node.text, node.width - paddingX * 2);
    const lineHeight = node.fontSize * 1.25;
    const totalHeight = lines.length * lineHeight;
    const startY = node.y + node.height / 2 - totalHeight / 2 + lineHeight / 2;
    const textX = node.textAlign === "left" ? node.x + paddingX : node.textAlign === "right" ? node.x + node.width - paddingX : node.x + node.width / 2;
    lines.forEach((line, i) => ctx.fillText(line, textX, startY + i * lineHeight));
    ctx.restore();
  }
}

function drawArrowhead(ctx: CanvasRenderingContext2D, x: number, y: number, angleDeg: number, color: string): void {
  const size = 10;
  const rad = (angleDeg * Math.PI) / 180;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rad);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, size / 2);
  ctx.lineTo(-size, -size / 2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function renderEdge(ctx: CanvasRenderingContext2D, edge: WhiteboardEdge, nodesById: Map<string, WhiteboardNode>): void {
  const { source, target } = resolveEdgeEndpoints(edge, nodesById);
  const path = buildEdgePath(source, target, edge.routing);
  const p2d = new Path2D(path);
  ctx.lineWidth = edge.strokeWidth;
  ctx.strokeStyle = edge.strokeColor;
  ctx.setLineDash(edge.strokeStyle === "dashed" ? [8, 6] : []);
  ctx.stroke(p2d);
  ctx.setLineDash([]);

  const { startDeg, endDeg } = edgeEndAngleDeg(source, target, edge.routing, source.side, target.side);
  if (edge.endArrow) drawArrowhead(ctx, target.x, target.y, endDeg, edge.strokeColor);
  if (edge.startArrow) drawArrowhead(ctx, source.x, source.y, startDeg, edge.strokeColor);
}

// Flattens the whole document onto an offscreen canvas sized to its content bounds (see
// computeContentBounds) - the Whiteboard equivalent of boardHandlers.ts's renderBoardToCanvas,
// used by WhiteboardEditor's "Export PNG" action and (with `maxDimension` set) its home-grid
// thumbnail, same "one renderer, two call sites" convention as BoardEditor.tsx's own renderOffscreen.
export function renderWhiteboardToCanvas(doc: WhiteboardDocument, maxDimension?: number): HTMLCanvasElement {
  const bounds = computeContentBounds(doc);
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = maxDimension ? Math.min(1, maxDimension / Math.max(contentWidth, contentHeight)) : 1;
  const width = Math.max(1, Math.round(contentWidth * scale));
  const height = Math.max(1, Math.round(contentHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.scale(scale, scale);
  ctx.translate(-bounds.minX, -bounds.minY);

  const nodesById = new Map(doc.nodes.map((n) => [n.id, n]));
  for (const edge of doc.edges) renderEdge(ctx, edge, nodesById);
  for (const node of doc.nodes) renderNode(ctx, node);

  return canvas;
}
