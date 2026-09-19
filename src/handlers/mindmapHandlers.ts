// handlers/mindmapHandlers.ts
//
// Pure functions only - no React, no closures over component state. Geometry, layout and command
// application for the Mindmap feature (src/components/mindmap/*).
//
// Deliberately NOT built on whiteboardHandlers.ts's connector system despite the surface
// similarity. That system solves a harder problem than this one has: arbitrary rotated shapes,
// free-floating endpoints, auto-re-anchoring sides, orthogonal routing with manual waypoints. A
// mindmap edge is always box-side to box-side between two existing nodes, which collapses to a
// single cubic bezier - and reusing the general machinery would mean carrying all of its
// configuration surface into a feature that has no use for any of it.

import {
  MindmapDocument,
  MindmapEdge,
  MindmapNode,
  MindmapSide,
  createMindmapEdge,
  createMindmapNode,
} from "../utils/mindmapTypes";

// ---- Geometry -----------------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface BoundsBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function nodeCenter(node: MindmapNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

// Where on a node's outline a connector attaches, given which side it uses. Always the midpoint of
// that side - a roadmap's lines read as a deliberate diagram, and endpoints sliding along an edge
// as boxes resize would make the composition feel unstable.
export function sidePoint(node: MindmapNode, side: MindmapSide): Point {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

// The outward normal of a side, used to push a bezier's control point away from the box so the
// curve leaves perpendicular rather than cutting across the node it just left.
function sideNormal(side: MindmapSide): Point {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
}

// How far a control point is pushed out along its side's normal, as a fraction of the distance
// between the two endpoints - so a short hop bends gently and a long run across the canvas bows
// enough to stay clear of whatever is between. Clamped at both ends: too little and the curve
// leaves at a visibly wrong angle, too much and it loops out into a spiral.
const CURVE_MIN_REACH = 30;
const CURVE_MAX_REACH = 180;
const CURVE_REACH_RATIO = 0.42;

// One cubic bezier from source side to target side. Used identically by the live SVG canvas and the
// Canvas2D export, so the two can never render a different line.
export function edgePath(source: MindmapNode, sourceSide: MindmapSide, target: MindmapNode, targetSide: MindmapSide): string {
  const a = sidePoint(source, sourceSide);
  const b = sidePoint(target, targetSide);
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const reach = Math.max(CURVE_MIN_REACH, Math.min(CURVE_MAX_REACH, dist * CURVE_REACH_RATIO));
  const an = sideNormal(sourceSide);
  const bn = sideNormal(targetSide);
  const c1 = { x: a.x + an.x * reach, y: a.y + an.y * reach };
  const c2 = { x: b.x + bn.x * reach, y: b.y + bn.y * reach };
  return `M${a.x.toFixed(2)},${a.y.toFixed(2)} C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
}

// ---- Directional "add topic" --------------------------------------------------------------------
//
// The defining interaction of a roadmap editor: with a node selected, press one of four arrows and
// a connected child appears on that side, already wired up. It is what makes building a hundred-node
// roadmap a sequence of single keystrokes rather than a place-drag-connect cycle per node - and why
// the editor is worth having at all over drawing the same boxes on a whiteboard.

// Gap between a parent's edge and its new child's edge.
export const ADD_TOPIC_GAP = 70;

// A new child on a given side sits beyond that side, centered on the parent's own axis. The
// opposite sides are paired for the connector (a child placed to the right attaches on its own LEFT
// side), which is what makes the connecting curve run straight out and straight in.
const OPPOSITE: Record<MindmapSide, MindmapSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };

export interface AddTopicResult {
  node: MindmapNode;
  edge: MindmapEdge;
}

// Builds the child node and its connector. `existing` is consulted to nudge the placement along the
// perpendicular axis when the natural spot is already occupied - pressing "add below" three times
// should give three siblings side by side, not three nodes stacked exactly on top of each other.
export function buildAddTopic(
  parent: MindmapNode,
  side: MindmapSide,
  childType: MindmapNode["type"],
  existing: MindmapNode[],
  newNodeId: string,
  newEdgeId: string
): AddTopicResult {
  const parentCenter = nodeCenter(parent);
  const probe = createMindmapNode(newNodeId, childType, 0, 0);

  // Natural position: directly beyond `side`, centered on the parent.
  let cx = parentCenter.x;
  let cy = parentCenter.y;
  if (side === "top") cy = parent.y - ADD_TOPIC_GAP - probe.height / 2;
  else if (side === "bottom") cy = parent.y + parent.height + ADD_TOPIC_GAP + probe.height / 2;
  else if (side === "left") cx = parent.x - ADD_TOPIC_GAP - probe.width / 2;
  else cx = parent.x + parent.width + ADD_TOPIC_GAP + probe.width / 2;

  // Slide along the perpendicular axis until the slot is free. Vertical sides shift horizontally and
  // vice versa, so repeated adds fan out in the direction that reads as "siblings" rather than
  // marching further away from the parent.
  const horizontalSide = side === "left" || side === "right";
  const step = horizontalSide ? probe.height + 24 : probe.width + 24;
  const overlaps = (x: number, y: number) =>
    existing.some((n) => {
      const nx = n.x + n.width / 2;
      const ny = n.y + n.height / 2;
      return Math.abs(nx - x) < (n.width + probe.width) / 2 - 4 && Math.abs(ny - y) < (n.height + probe.height) / 2 - 4;
    });
  // Alternates below/above (or right/left) of the natural line rather than always pushing one way,
  // so a fan of siblings stays centered on its parent instead of drifting off in one direction.
  for (let attempt = 1; attempt <= 24 && overlaps(cx, cy); attempt++) {
    const magnitude = Math.ceil(attempt / 2) * step;
    const direction = attempt % 2 === 1 ? 1 : -1;
    if (horizontalSide) cy = parentCenter.y + magnitude * direction;
    else cx = parentCenter.x + magnitude * direction;
  }

  const node = createMindmapNode(newNodeId, childType, cx, cy);
  // Subtopics hang off their parent with the dashed "belongs to" line; anything else gets the solid
  // "then this" line - see MindmapEdge.style's own doc comment.
  const edge = createMindmapEdge(newEdgeId, parent.id, side, node.id, OPPOSITE[side], childType === "subtopic" ? "dashed" : "solid");
  return { node, edge };
}

// ---- Auto-size ----------------------------------------------------------------------------------

// Padding around a node's text when auto-sizing, per axis.
const AUTOSIZE_PAD_X = 28;
const AUTOSIZE_PAD_Y = 18;
const AUTOSIZE_MIN_WIDTH = 80;
const AUTOSIZE_MIN_HEIGHT = 32;

// Whether auto-size means anything for this node. A divider has no text to fit and its height IS
// its thickness, so running it through the text path forced it up to the labelled-box minimum and
// turned a 2px rule into a filled rectangle. Shared by the editor (which performs the operation) and
// the panel (which hides the button) so the two can't disagree about when it's offered.
export function canAutoSize(node: MindmapNode): boolean {
  return node.type !== "horizontalLine" && node.type !== "verticalLine";
}

// Fits a node's box to its own label. Measuring needs real text metrics, which this pure module has
// no access to - so the caller (which does have a canvas or a DOM) passes the measured text size in
// and this applies the padding and minimums. Splitting it that way keeps the sizing rules in one
// place instead of half here and half in whichever component happened to call it.
export function autoSizedBox(textWidth: number, textHeight: number): { width: number; height: number } {
  return {
    width: Math.max(AUTOSIZE_MIN_WIDTH, Math.round(textWidth + AUTOSIZE_PAD_X)),
    height: Math.max(AUTOSIZE_MIN_HEIGHT, Math.round(textHeight + AUTOSIZE_PAD_Y)),
  };
}

// ---- Bounds -------------------------------------------------------------------------------------

const EMPTY_BOUNDS_PADDING = 200;
const CONTENT_BOUNDS_PADDING = 48;

export function computeContentBounds(doc: Pick<MindmapDocument, "nodes">): BoundsBox {
  if (doc.nodes.length === 0) {
    return { minX: -EMPTY_BOUNDS_PADDING, minY: -EMPTY_BOUNDS_PADDING, maxX: EMPTY_BOUNDS_PADDING, maxY: EMPTY_BOUNDS_PADDING };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of doc.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return {
    minX: minX - CONTENT_BOUNDS_PADDING,
    minY: minY - CONTENT_BOUNDS_PADDING,
    maxX: maxX + CONTENT_BOUNDS_PADDING,
    maxY: maxY + CONTENT_BOUNDS_PADDING,
  };
}

// ---- Commands (undo/redo) -----------------------------------------------------------------------
//
// Same command/invert shape as the whiteboard's own store: every mutation is expressed as a value
// that can be applied forward or inverted, so undo needs no snapshots of the whole document.

export type MindmapCommand =
  // `indices` restores each node to the exact array position it came from. Array order IS z-order
  // here, so without it, undoing a delete would put the node back on top of whatever it used to sit
  // behind - an undo that changes something it wasn't asked to change. Absent (a plain add) appends,
  // which is correct for a genuinely new node.
  | { type: "add-nodes"; nodes: MindmapNode[]; edges: MindmapEdge[]; indices?: number[] }
  | { type: "delete-nodes"; nodes: MindmapNode[]; edges: MindmapEdge[]; indices?: number[] }
  | { type: "edit-nodes"; before: MindmapNode[]; after: MindmapNode[] }
  | { type: "add-edge"; edge: MindmapEdge }
  | { type: "delete-edge"; edge: MindmapEdge }
  | { type: "edit-edge"; before: MindmapEdge; after: MindmapEdge }
  // Full replacement of the nodes array - z-order is array order (last = topmost), same convention
  // the whiteboard and board features both use.
  | { type: "reorder-nodes"; before: MindmapNode[]; after: MindmapNode[] }
  | { type: "edit-doc"; before: Pick<MindmapDocument, "name" | "description">; after: Pick<MindmapDocument, "name" | "description"> };

export function applyMindmapCommand(doc: MindmapDocument, command: MindmapCommand): MindmapDocument {
  switch (command.type) {
    case "add-nodes": {
      let nodes: MindmapNode[];
      if (command.indices && command.indices.length === command.nodes.length) {
        // Ascending order matters: inserting a later index first would shift the positions the
        // earlier ones were recorded against.
        const pairs = command.nodes.map((node, i) => ({ node, index: command.indices![i] })).sort((a, b) => a.index - b.index);
        nodes = [...doc.nodes];
        for (const { node, index } of pairs) nodes.splice(Math.max(0, Math.min(nodes.length, index)), 0, node);
      } else {
        nodes = [...doc.nodes, ...command.nodes];
      }
      return { ...doc, nodes, edges: [...doc.edges, ...command.edges] };
    }
    case "delete-nodes": {
      const nodeIds = new Set(command.nodes.map((n) => n.id));
      const edgeIds = new Set(command.edges.map((e) => e.id));
      return { ...doc, nodes: doc.nodes.filter((n) => !nodeIds.has(n.id)), edges: doc.edges.filter((e) => !edgeIds.has(e.id)) };
    }
    case "edit-nodes": {
      const byId = new Map(command.after.map((n) => [n.id, n]));
      return { ...doc, nodes: doc.nodes.map((n) => byId.get(n.id) ?? n) };
    }
    case "add-edge":
      return { ...doc, edges: [...doc.edges, command.edge] };
    case "delete-edge":
      return { ...doc, edges: doc.edges.filter((e) => e.id !== command.edge.id) };
    case "edit-edge":
      return { ...doc, edges: doc.edges.map((e) => (e.id === command.after.id ? command.after : e)) };
    case "reorder-nodes":
      return { ...doc, nodes: command.after };
    case "edit-doc":
      return { ...doc, name: command.after.name, description: command.after.description };
  }
}

export function invertMindmapCommand(command: MindmapCommand): MindmapCommand {
  switch (command.type) {
    // Exact mirrors of each other, which is what lets "add a topic and its connector" undo as one
    // step without a dedicated combined command the way the whiteboard needed for its own cascade.
    case "add-nodes":
      return { type: "delete-nodes", nodes: command.nodes, edges: command.edges, indices: command.indices };
    case "delete-nodes":
      return { type: "add-nodes", nodes: command.nodes, edges: command.edges, indices: command.indices };
    case "edit-nodes":
      return { type: "edit-nodes", before: command.after, after: command.before };
    case "add-edge":
      return { type: "delete-edge", edge: command.edge };
    case "delete-edge":
      return { type: "add-edge", edge: command.edge };
    case "edit-edge":
      return { type: "edit-edge", before: command.after, after: command.before };
    case "reorder-nodes":
      return { type: "reorder-nodes", before: command.after, after: command.before };
    case "edit-doc":
      return { type: "edit-doc", before: command.after, after: command.before };
  }
}

// Every edge touching any of `nodeIds` - deleting a node has to take its connectors with it, or an
// edge would be left pointing at an id that no longer resolves to anything.
export function edgesTouching(edges: MindmapEdge[], nodeIds: Set<string>): MindmapEdge[] {
  return edges.filter((e) => nodeIds.has(e.sourceId) || nodeIds.has(e.targetId));
}
