// utils/whiteboardTypes.ts
//
// The Whiteboard feature's object model - a diagramming surface (shapes + connectors) distinct
// from the Board feature (boardTypes.ts), which is an image-collage/moodboard tool. A whiteboard
// has two item kinds: WhiteboardNode (a shape, text label, or freehand stroke you drop on the
// canvas) and WhiteboardEdge (a connector between two nodes, or between a node and a free point) -
// modeled like draw.io/most flowchart tools rather than reusing Board's single-canvas-buffer
// approach, since connectors need to track live node positions and DOM-based rendering makes
// that, and inline text editing, straightforward (see WhiteboardCanvas.tsx).
//
// A whiteboard is one or more independent WhiteboardPages (see draw.io's own page tabs) - each
// page has its own nodes/edges and its own undo history (see useWhiteboardStore.ts's setActivePage
// doc comment for why undo is per-page rather than a single global stack).

export type WhiteboardShapeType =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "triangle"
  | "hexagon"
  | "parallelogram"
  | "cylinder"
  // "Complex" shapes added alongside the arrow-style work - see whiteboardHandlers.ts's
  // shapeOutlineFor for how each one's outline is actually built.
  | "polygon" // regular n-gon, n = WhiteboardNode.sides (pentagon/heptagon/octagon presets, etc.)
  | "star" // WhiteboardNode.starPoints/starInnerRadiusRatio
  | "trapezoid"
  | "cross"
  | "cube"
  | "cloud"
  | "document" // flowchart "document" - rectangle with a wavy bottom edge
  | "note" // sticky note with a folded corner
  | "callout" // speech-bubble rectangle with a tail
  | "step" // chevron/arrow-shaped process step
  | "text"
  | "freehand";

interface WhiteboardItemBase {
  id: string;
  createdAt: number;
  updatedAt: number;
}

// Geometry is a plain axis-aligned box in document space - no rotation (unlike BoardItem), which
// keeps anchor-point math for connectors (resolveAnchorPoint in whiteboardHandlers.ts) simple:
// the four side midpoints are always just x/y/width/height arithmetic.
export interface WhiteboardNode extends WhiteboardItemBase {
  kind: "node";
  shapeType: WhiteboardShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  // Ignored for shapeType "text"/"freehand" (a label/ink stroke has no interior to fill) - null =
  // no fill, same "null = transparent" convention boardTypes.ts uses.
  fillColor: string | null;
  strokeColor: string;
  strokeWidth: number;
  // "rectangle" only - lets the same shapeType cover both a square-cornered box and a rounded one
  // (the toolbar's "Rounded Rectangle" quick-add is just this at a nonzero default), same
  // parameterized-shapeType convention boardTypes.ts's BoardShape uses for its polygon/star fields.
  cornerRadius?: number;
  // "polygon" only, 3-12 sides - a pentagon, heptagon, octagon etc. are all this one shapeType at
  // a different `sides`, not their own separate shapeType values (see boardTypes.ts's BoardShape
  // for the same convention). Absent on a node predating this field - resolves to 5 (pentagon).
  sides?: number;
  // "star" only, 3-12 points. Absent - resolves to 5.
  starPoints?: number;
  // "star" only, 0-1 - how far the inner (concave) vertices sit toward the center relative to the
  // outer points; smaller = spikier. Absent - resolves to 0.45. Named starPoints/starInnerRadiusRatio
  // rather than reusing BoardShape's bare `points`/`innerRadiusRatio` names because `points` on this
  // type already means something else entirely (see WhiteboardNode.points's own doc comment below).
  starInnerRadiusRatio?: number;
  fontFamily: string;
  fontSize: number;
  fontColor: string;
  fontWeight: "normal" | "bold";
  fontStyle: "normal" | "italic";
  textDecoration: "none" | "underline";
  textAlign: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  // "freehand" only - the stroke's points, each a fraction (0-1) of this node's own width/height
  // rather than an absolute document-space coordinate. That's what lets a freehand node reuse
  // every other node kind's move/resize machinery for free: dragging the node just changes x/y
  // (the rendered points are always x + fx*width, y + fy*height), and resizing stretches the
  // drawing to fit the new box exactly like Board scales an image into its frame, rather than
  // needing a special "translate every point" or "rescale every point" code path of its own.
  points?: { x: number; y: number }[];
}

// Which side of a node an edge attaches to - "auto" (the default for a new connection) means
// whiteboardHandlers.ts's resolveEndpointPoint recomputes the best side every render based on
// where the OTHER endpoint currently is, so an edge re-routes itself as nodes move instead of
// staying pinned to whatever side happened to face the target when it was first drawn.
export type WhiteboardAnchorSide = "top" | "right" | "bottom" | "left" | "auto";

// An edge endpoint is either attached to a node (nodeId set, x/y absent - the live point is
// derived every render) or floating at a fixed document-space point (nodeId absent, x/y set) -
// e.g. an arrow drawn from a shape out to empty canvas, annotating something with no node of its
// own. Never both: a node-attached endpoint always overrides whatever stale x/y it might carry
// from before it was attached.
export interface WhiteboardEndpoint {
  nodeId?: string;
  anchor?: WhiteboardAnchorSide;
  x?: number;
  y?: number;
}

// What decorates an edge's end - "none" leaves a bare line end, the rest are drawn at the
// endpoint pointing along the line's arrival direction (see whiteboardHandlers.ts's
// edgeEndAngleDeg). "triangle" is the classic filled arrowhead (draw.io's default); "triangleOpen"
// is the same silhouette but unfilled (just two stroked lines, no fill) - the "thin arrow" look;
// "block" is a wider filled triangle for more visual weight; "diamond" and "circle" are small
// filled markers, the UML-style "aggregation"/cardinality-dot look.
export type ArrowheadType = "none" | "triangle" | "triangleOpen" | "block" | "diamond" | "circle";

export interface WhiteboardEdge extends WhiteboardItemBase {
  kind: "edge";
  source: WhiteboardEndpoint;
  target: WhiteboardEndpoint;
  label: string;
  strokeColor: string;
  strokeWidth: number;
  strokeStyle: "solid" | "dashed" | "dotted";
  // "straight" draws one segment source->target; "orthogonal" (draw.io's default connector style)
  // routes it as one or two right-angle bends; "curved" is a smooth cubic-bezier route that still
  // leaves/arrives perpendicular to whichever side it's anchored on, just without the hard corners
  // - see whiteboardHandlers.ts's buildEdgePath for all three.
  routing: "straight" | "orthogonal" | "curved";
  startArrowType: ArrowheadType;
  endArrowType: ArrowheadType;
}

export type WhiteboardItem = WhiteboardNode | WhiteboardEdge;

export type WhiteboardCommand =
  | { type: "add-node"; item: WhiteboardNode }
  // Cascades: deleting a node also removes every edge attached to it, as ONE undo step - an edge
  // left pointing at a node id that no longer exists would have nothing left to resolve its
  // attached endpoint against.
  | { type: "delete-node"; item: WhiteboardNode; edges: WhiteboardEdge[] }
  | { type: "edit-node"; before: WhiteboardNode; after: WhiteboardNode }
  // Multiple nodes replaced at once as a single undo step - multi-selection drag/resize/style edit.
  | { type: "batch-edit-nodes"; before: WhiteboardNode[]; after: WhiteboardNode[] }
  | { type: "add-edge"; item: WhiteboardEdge }
  | { type: "delete-edge"; item: WhiteboardEdge }
  | { type: "edit-edge"; before: WhiteboardEdge; after: WhiteboardEdge }
  // Full replacement order for the whole nodes array - z-order (last = topmost), same convention
  // as boardTypes.ts's own 'reorder'. Used by "Bring to front" / "Send to back".
  | { type: "reorder-nodes"; before: WhiteboardNode[]; after: WhiteboardNode[] };

// One page's worth of diagram content - see this file's own top comment for why a whiteboard is a
// set of these rather than one flat nodes/edges pair.
export interface WhiteboardPage {
  id: string;
  name: string;
  // array order = z-order, last = topmost, same convention as boardTypes.ts's own `images`.
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
}

export const WHITEBOARD_SCHEMA_VERSION = 2 as const;

export interface WhiteboardDocument {
  version: typeof WHITEBOARD_SCHEMA_VERSION;
  id: string;
  name: string;
  showGrid: boolean;
  pages: WhiteboardPage[];
  // Not undo-tracked (see useWhiteboardStore.ts's setActivePage) - which page was open is a view
  // preference, not diagram content, same reasoning as showGrid.
  activePageId: string;
  createdAt: string;
  updatedAt: string;
}

// Frontend mirror of whiteboards.rs's WhiteboardSummary - snake_case to match the Rust struct's
// serde output exactly, same convention as boardTypes.ts's own BoardSummary.
export interface WhiteboardSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  thumbnail_path: string | null;
}

export function createEmptyWhiteboardPage(id: string, name: string): WhiteboardPage {
  return { id, name, nodes: [], edges: [] };
}

export function createEmptyWhiteboardDocument(id: string, name: string): WhiteboardDocument {
  const now = new Date().toISOString();
  const firstPage = createEmptyWhiteboardPage(crypto.randomUUID(), "Page 1");
  return {
    version: WHITEBOARD_SCHEMA_VERSION,
    id,
    name,
    showGrid: true,
    pages: [firstPage],
    activePageId: firstPage.id,
    createdAt: now,
    updatedAt: now,
  };
}

const SHAPE_DEFAULT_SIZE: Record<WhiteboardShapeType, { width: number; height: number }> = {
  rectangle: { width: 160, height: 90 },
  ellipse: { width: 160, height: 100 },
  diamond: { width: 170, height: 110 },
  triangle: { width: 160, height: 130 },
  hexagon: { width: 180, height: 110 },
  parallelogram: { width: 180, height: 100 },
  cylinder: { width: 140, height: 130 },
  polygon: { width: 160, height: 150 },
  star: { width: 160, height: 150 },
  trapezoid: { width: 180, height: 100 },
  cross: { width: 140, height: 140 },
  cube: { width: 150, height: 150 },
  cloud: { width: 190, height: 120 },
  document: { width: 170, height: 110 },
  note: { width: 150, height: 130 },
  callout: { width: 170, height: 110 },
  step: { width: 190, height: 100 },
  text: { width: 160, height: 40 },
  freehand: { width: 160, height: 160 },
};

export function createDefaultWhiteboardNode(
  id: string,
  shapeType: WhiteboardShapeType,
  x: number,
  y: number,
  overrides?: Partial<Pick<WhiteboardNode, "sides" | "starPoints" | "starInnerRadiusRatio">>
): WhiteboardNode {
  const now = Date.now();
  const size = SHAPE_DEFAULT_SIZE[shapeType];
  return {
    kind: "node",
    id,
    shapeType,
    x: x - size.width / 2,
    y: y - size.height / 2,
    width: size.width,
    height: size.height,
    text: "",
    fillColor: shapeType === "text" || shapeType === "freehand" ? null : "#dbeafe",
    strokeColor: shapeType === "freehand" ? "#111111" : "#2563eb",
    strokeWidth: 2,
    cornerRadius: 0,
    sides: shapeType === "polygon" ? overrides?.sides ?? 5 : undefined,
    starPoints: shapeType === "star" ? overrides?.starPoints ?? 5 : undefined,
    starInnerRadiusRatio: shapeType === "star" ? overrides?.starInnerRadiusRatio ?? 0.45 : undefined,
    fontFamily: "system-ui, sans-serif",
    fontSize: 16,
    fontColor: "#111111",
    fontWeight: "normal",
    fontStyle: "normal",
    textDecoration: "none",
    textAlign: "center",
    verticalAlign: "middle",
    createdAt: now,
    updatedAt: now,
  };
}

const FREEHAND_MIN_SIZE = 8;

// Builds a freehand node from a raw drag gesture's collected document-space points - computes the
// stroke's own bounding box for the node's x/y/width/height, then re-expresses every point as a
// 0-1 fraction of that box (see WhiteboardNode.points's own doc comment for why).
export function createFreehandWhiteboardNode(id: string, rawPoints: { x: number; y: number }[]): WhiteboardNode {
  const now = Date.now();
  const xs = rawPoints.map((p) => p.x);
  const ys = rawPoints.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(FREEHAND_MIN_SIZE, Math.max(...xs) - minX);
  const height = Math.max(FREEHAND_MIN_SIZE, Math.max(...ys) - minY);
  return {
    kind: "node",
    id,
    shapeType: "freehand",
    x: minX,
    y: minY,
    width,
    height,
    text: "",
    fillColor: null,
    strokeColor: "#111111",
    strokeWidth: 2.5,
    cornerRadius: 0,
    fontFamily: "system-ui, sans-serif",
    fontSize: 16,
    fontColor: "#111111",
    fontWeight: "normal",
    fontStyle: "normal",
    textDecoration: "none",
    textAlign: "center",
    verticalAlign: "middle",
    points: rawPoints.map((p) => ({ x: (p.x - minX) / width, y: (p.y - minY) / height })),
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefaultWhiteboardEdge(id: string, source: WhiteboardEndpoint, target: WhiteboardEndpoint): WhiteboardEdge {
  const now = Date.now();
  return {
    kind: "edge",
    id,
    source,
    target,
    label: "",
    strokeColor: "#374151",
    strokeWidth: 2,
    strokeStyle: "solid",
    routing: "orthogonal",
    startArrowType: "none",
    endArrowType: "triangle",
    createdAt: now,
    updatedAt: now,
  };
}
