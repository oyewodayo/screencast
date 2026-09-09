// utils/whiteboardTypes.ts
//
// The Whiteboard feature's object model - a diagramming surface (shapes + connectors) distinct
// from the Board feature (boardTypes.ts), which is an image-collage/moodboard tool. A whiteboard
// has two item kinds: WhiteboardNode (a shape or text label you drop on the canvas) and
// WhiteboardEdge (a connector between two nodes, or between a node and a free point) - modeled
// like draw.io/most flowchart tools rather than reusing Board's single-canvas-buffer approach,
// since connectors need to track live node positions and DOM-based rendering makes that, and
// inline text editing, straightforward (see WhiteboardCanvas.tsx).

export type WhiteboardShapeType = "rectangle" | "ellipse" | "diamond" | "text";

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
  // Ignored for shapeType "text" (a label has no box to fill) - null = no fill, same "null =
  // transparent" convention boardTypes.ts uses.
  fillColor: string | null;
  strokeColor: string;
  strokeWidth: number;
  fontSize: number;
  fontColor: string;
  fontWeight: "normal" | "bold";
  textAlign: "left" | "center" | "right";
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

export interface WhiteboardEdge extends WhiteboardItemBase {
  kind: "edge";
  source: WhiteboardEndpoint;
  target: WhiteboardEndpoint;
  label: string;
  strokeColor: string;
  strokeWidth: number;
  strokeStyle: "solid" | "dashed";
  // "straight" draws one segment source->target; "orthogonal" (draw.io's default connector style)
  // routes it as one or two right-angle bends - see whiteboardHandlers.ts's buildEdgePath.
  routing: "straight" | "orthogonal";
  startArrow: boolean;
  endArrow: boolean;
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

export const WHITEBOARD_SCHEMA_VERSION = 1 as const;

export interface WhiteboardDocument {
  version: typeof WHITEBOARD_SCHEMA_VERSION;
  id: string;
  name: string;
  showGrid: boolean;
  // array order = z-order, last = topmost, same convention as boardTypes.ts's own `images`.
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
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

export function createEmptyWhiteboardDocument(id: string, name: string): WhiteboardDocument {
  const now = new Date().toISOString();
  return {
    version: WHITEBOARD_SCHEMA_VERSION,
    id,
    name,
    showGrid: true,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  };
}

const SHAPE_DEFAULT_SIZE: Record<WhiteboardShapeType, { width: number; height: number }> = {
  rectangle: { width: 160, height: 90 },
  ellipse: { width: 160, height: 100 },
  diamond: { width: 170, height: 110 },
  text: { width: 160, height: 40 },
};

export function createDefaultWhiteboardNode(id: string, shapeType: WhiteboardShapeType, x: number, y: number): WhiteboardNode {
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
    fillColor: shapeType === "text" ? null : "#dbeafe",
    strokeColor: "#2563eb",
    strokeWidth: 2,
    fontSize: 16,
    fontColor: "#111111",
    fontWeight: "normal",
    textAlign: "center",
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
    startArrow: false,
    endArrow: true,
    createdAt: now,
    updatedAt: now,
  };
}
