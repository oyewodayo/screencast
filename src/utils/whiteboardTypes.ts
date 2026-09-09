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
  | "wave" // periodic signal trace - WhiteboardNode.waveStyle picks sine/cosine/square/triangle/sawtooth
  // Science/diagram symbols - all fixed (non-parametric) glyphs, same reasoning as document/cloud
  // (a hand-tuned icon, not something with an obvious "how many sides" knob like polygon/star).
  | "resistor" // circuit zigzag
  | "capacitor" // circuit parallel-plate symbol
  | "spring" // physics coil/spring
  | "battery" // circuit single-cell symbol (long + short plate)
  | "flask" // chemistry Erlenmeyer flask
  | "beaker" // chemistry graduated beaker
  | "benzeneRing" // chemistry aromatic ring (hexagon + inscribed circle)
  | "axes" // math x/y coordinate axes
  | "angle" // math angle-with-arc marker
  // General-purpose glyphs (draw.io's own "General" shape palette) - fixed icons, same reasoning
  // as the science symbols above. "4-Point Star"/"8-Point Star" aren't their own shapeType - like
  // Pentagon/Octagon, they're just "star" at a different starPoints (see WhiteboardEditor.tsx's
  // GENERAL_SHAPE_PRESETS).
  | "hourglass"
  | "teardrop"
  | "lightningBolt"
  | "halfCircle"
  | "banner" // ribbon/banner with a notched bottom edge
  | "frame" // UML-style frame: rectangle + a small pentagon "tab" in the top-left corner
  | "tape" // flowchart tape symbol - wavy top AND bottom edges
  | "display" // flowchart display symbol - lens/eye-shaped
  | "predefinedProcess" // flowchart predefined-process - rectangle with two inset vertical bars
  | "manualInput" // flowchart manual-input - rectangle with a slanted top edge
  | "internalStorage" // flowchart internal-storage - rectangle with an inset corner cross
  | "text"
  | "freehand";

// Shapes that render as an open/line-style glyph with no interior region to speak of (a circuit
// symbol, a coordinate-axes cross) - same treatment as freehand/text: default fillColor is null,
// and the style panel hides the Fill swatch for them. Kept as one shared set rather than repeating
// this shapeType list in whiteboardTypes.ts/WhiteboardStylePanel.tsx/WhiteboardEditor.tsx
// separately, so adding a future line-only shape only means updating it here.
export const LINE_ONLY_SHAPES: ReadonlySet<WhiteboardShapeType> = new Set<WhiteboardShapeType>([
  "wave",
  "resistor",
  "capacitor",
  "spring",
  "battery",
  "axes",
  "angle",
]);

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
  // "wave" only - which periodic curve to trace across the node's box (see whiteboardHandlers.ts's
  // waveOutlineD). Absent - resolves to "sine".
  waveStyle?: "sine" | "cosine" | "square" | "triangle" | "sawtooth";
  // "wave" only - how many full periods to trace across the node's own width (see
  // whiteboardHandlers.ts's MIN/MAX_WAVE_CYCLES for the bounds). Absent - resolves to
  // DEFAULT_WAVE_CYCLES. Wider spacing (fewer cycles) vs. denser (more) is a look the shape needs
  // to hand over, same reasoning as star's points/polygon's sides being user-adjustable.
  waveCycles?: number;
  // "angle" only - the angle (degrees) between the two rays, and each ray's own length as a
  // fraction of its natural max (the horizontal ray's max is the node's own width; the angled
  // ray's max is min(width, height) - see whiteboardHandlers.ts's angleOutlineD). Absent - resolve
  // to DEFAULT_ANGLE_DEGREES/DEFAULT_ANGLE_RAY_LENGTH. Independently adjustable rather than a
  // single "size" knob so the glyph can actually represent a specific angle/side-length
  // relationship (e.g. sketching a real angle-side-angle construction) rather than just being a
  // fixed decorative icon like cloud/document.
  angleDegrees?: number;
  angleRay1Length?: number;
  angleRay2Length?: number;
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
  // "freehand" only - an optional arrowhead capping the stroke's first/last point, oriented along
  // that end's own final tangent direction. What makes the "Freehand Arrow" toolbar preset (see
  // WhiteboardEditor.tsx's ARROW_PRESETS) a hand-drawn arrow rather than plain ink: same stroke,
  // same points, just with a marker on one end. Absent/"none" on a plain ink stroke.
  startArrowType?: ArrowheadType;
  endArrowType?: ArrowheadType;
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
  // "curved" only, and only actually consulted for an end with no shape side to bow away from (a
  // free-floating point - see buildEdgePath/curveControlPoints) - which side the curve bows toward
  // and how far, roughly -1..1. Set once at creation time from the actual shape of the drag gesture
  // that drew it (see WhiteboardCanvas.tsx's computeCurveBowFromPath), so the curve bows the way it
  // was drawn instead of a fixed direction that ignores the gesture entirely. Absent on an edge
  // created with no such gesture to read (e.g. reattaching an existing edge's endpoint) - resolves
  // to whiteboardHandlers.ts's DEFAULT_CURVE_BOW.
  curveBow?: number;
  // Manually-added bend points, in order from source to target, absolute document-space
  // coordinates (edges aren't resizable boxes the way nodes are, so unlike WhiteboardNode.points
  // there's no box to express these as a fraction of). Absent/empty - the routing algorithm alone
  // decides the path, same as before this field existed. Dragging a point ON the rendered path
  // (see WhiteboardCanvas.tsx's beginNewWaypointDrag) inserts a new one here; dragging an existing
  // dot (beginWaypointDrag) moves it; double-clicking one removes it. "curved" routing smooths a
  // spline through source -> waypoints -> target (see whiteboardHandlers.ts's smoothPolylineD);
  // "straight"/"orthogonal" both fall back to sharp segments through the same points once any
  // waypoints exist - orthogonal's own auto right-angle-bend algorithm only applies when there are
  // none, since it and a user's own manual bends are two competing ways to shape the same line.
  waypoints?: { x: number; y: number }[];
  startArrowType: ArrowheadType;
  endArrowType: ArrowheadType;
}

export type WhiteboardItem = WhiteboardNode | WhiteboardEdge;

export type WhiteboardCommand =
  | { type: "add-node"; item: WhiteboardNode }
  // A node and one edge connecting it to an existing node, added together as ONE undo step - the
  // hover-arrow "quick clone + connect" gesture (see WhiteboardCanvas.tsx's HoverConnectArrows)
  // creates both at once and undoing it should be one step, not two. Unlike delete-node below, this
  // needs no special-casing in useWhiteboardStore's undo(): invertCommand can already express its
  // full inverse as an ordinary "delete-node" command (this node + this one edge), since both ids
  // are already right here on the command itself.
  | { type: "add-node-with-edge"; node: WhiteboardNode; edge: WhiteboardEdge }
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
  wave: { width: 220, height: 90 },
  resistor: { width: 180, height: 60 },
  capacitor: { width: 140, height: 90 },
  spring: { width: 200, height: 70 },
  battery: { width: 140, height: 90 },
  flask: { width: 150, height: 170 },
  beaker: { width: 140, height: 150 },
  benzeneRing: { width: 160, height: 150 },
  axes: { width: 160, height: 160 },
  angle: { width: 170, height: 130 },
  hourglass: { width: 120, height: 140 },
  teardrop: { width: 120, height: 150 },
  lightningBolt: { width: 100, height: 160 },
  halfCircle: { width: 130, height: 130 },
  banner: { width: 180, height: 110 },
  frame: { width: 180, height: 140 },
  tape: { width: 180, height: 100 },
  display: { width: 180, height: 100 },
  predefinedProcess: { width: 170, height: 100 },
  manualInput: { width: 180, height: 110 },
  internalStorage: { width: 170, height: 120 },
  text: { width: 160, height: 40 },
  freehand: { width: 160, height: 160 },
};

export function createDefaultWhiteboardNode(
  id: string,
  shapeType: WhiteboardShapeType,
  x: number,
  y: number,
  overrides?: Partial<Pick<WhiteboardNode, "sides" | "starPoints" | "starInnerRadiusRatio" | "waveStyle" | "waveCycles" | "angleDegrees" | "angleRay1Length" | "angleRay2Length">>
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
    fillColor: shapeType === "text" || shapeType === "freehand" || LINE_ONLY_SHAPES.has(shapeType) ? null : "#dbeafe",
    strokeColor: shapeType === "freehand" ? "#111111" : "#2563eb",
    strokeWidth: 2,
    cornerRadius: 0,
    sides: shapeType === "polygon" ? overrides?.sides ?? 5 : undefined,
    starPoints: shapeType === "star" ? overrides?.starPoints ?? 5 : undefined,
    starInnerRadiusRatio: shapeType === "star" ? overrides?.starInnerRadiusRatio ?? 0.45 : undefined,
    waveStyle: shapeType === "wave" ? overrides?.waveStyle ?? "sine" : undefined,
    waveCycles: shapeType === "wave" ? overrides?.waveCycles ?? 2 : undefined,
    angleDegrees: shapeType === "angle" ? overrides?.angleDegrees ?? 50 : undefined,
    angleRay1Length: shapeType === "angle" ? overrides?.angleRay1Length ?? 1 : undefined,
    angleRay2Length: shapeType === "angle" ? overrides?.angleRay2Length ?? 1 : undefined,
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
    startArrowType: "none",
    endArrowType: "none",
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
