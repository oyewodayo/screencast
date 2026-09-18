// handlers/whiteboardHandlers.ts
//
// Pure functions only - no React, no closures over component state. Independent implementation
// for the Whiteboard feature, same "build from scratch" separation boardHandlers.ts's own top
// comment describes for Board: geometry here is axis-aligned (no rotation) and centered on
// connector routing, neither of which the Board/image-editor geometry helpers have any use for.
//
// Every function below that reads/writes node or edge arrays operates on one WhiteboardPage at a
// time (never the whole WhiteboardDocument) - a command always targets whichever page is currently
// active (see useWhiteboardStore.ts), and export/bounds/undo are all naturally per-page too since
// draw.io-style pages are independent canvases, not one shared coordinate space.

import katex from "katex";
import {
  ArrowheadType,
  ChartAnnotation,
  CHART_ANNOTATION_SHAPES,
  CHART_AXIS_TITLE_SHAPES,
  DEFAULT_ANNOTATION_LABEL_DX,
  DEFAULT_ANNOTATION_LABEL_DY,
  DEFAULT_ANNOTATION_MARKER_SIZE,
  DEFAULT_CHART_DATA,
  DEFAULT_TABLE_COLS,
  DEFAULT_TABLE_ROWS,
  FunctionPlotType,
  ResolvedSeries,
  WhiteboardAnchorSide,
  WhiteboardCommand,
  WhiteboardEdge,
  WhiteboardEndpoint,
  WhiteboardNode,
  WhiteboardPage,
  WhiteboardShapeType,
  TableBorderStyle,
  TableMergedCell,
  resolveImageCrop,
  resolveSeriesData,
  resolveTableGrid,
} from "../utils/whiteboardTypes";
import { getCachedWhiteboardImage, preloadWhiteboardImage } from "../utils/whiteboardImageCache";
// Not a component import in spirit - latticeRenderOnDemand is a plain module-level Map, not React
// state or a hook, used purely as a side-channel to force one fresh WebGL frame immediately before
// the "latticeGauge" branch below reads the canvas (see LatticeGaugeWidget.tsx's own doc comment
// on why its renderer no longer keeps every past frame's buffer around via preserveDrawingBuffer).
import { latticeRenderOnDemand } from "../components/whiteboard/LatticeGaugeWidget";

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
// from, needed by buildEdgePath's orthogonal/curved routing). `towardPoint` is the OTHER
// endpoint's own resolved reference point (its node's center, or its free x/y) - what an "auto"
// anchor picks a side relative to.
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

export type EdgeRouting = "straight" | "orthogonal" | "curved";
type ResolvedPoint = { x: number; y: number; side: "top" | "right" | "bottom" | "left" | null };

// Shifts an edge by (dx, dy) in document space - translates every FREE-FLOATING endpoint (no
// nodeId) and every waypoint by the same delta; an endpoint anchored to a shape is left untouched,
// since its position is derived from that shape rather than something the edge itself can move
// (same reasoning WhiteboardCanvas.tsx's "moveEdge" Interaction variant already follows for a
// body-drag). Shared by the keyboard arrow-key nudge and the style panel's own Nudge buttons so
// both stay in exact agreement rather than two independent implementations drifting apart.
export function nudgeEdgeBy(edge: WhiteboardEdge, dx: number, dy: number): WhiteboardEdge {
  const nudgeEndpoint = (ep: WhiteboardEndpoint): WhiteboardEndpoint => (ep.nodeId ? ep : { ...ep, x: (ep.x ?? 0) + dx, y: (ep.y ?? 0) + dy });
  return {
    ...edge,
    source: nudgeEndpoint(edge.source),
    target: nudgeEndpoint(edge.target),
    waypoints: edge.waypoints?.map((wp) => ({ x: wp.x + dx, y: wp.y + dy })),
  };
}

// Squared distance from `point` to the closest point on segment a->b - squared (not the real
// distance) since every caller only ever COMPARES distances against each other to find the
// nearest segment, so the monotonic sqrt is pure wasted work.
function squaredDistanceToSegment(point: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lenSq)) : 0;
  const closestX = a.x + t * abx;
  const closestY = a.y + t * aby;
  const dx = point.x - closestX;
  const dy = point.y - closestY;
  return dx * dx + dy * dy;
}

// Which segment of an edge's own point sequence (source -> waypoints -> target) a new bend point
// double-clicked at `point` should be inserted into - the index (into `waypoints`, not
// `fullSequence`) of whichever segment's straight line lies closest to `point`, so a double-click
// near the middle of a long multi-bend edge lands the new point in the right place along the
// sequence rather than always at the very end. Returns the insertion index for
// `waypoints.splice(index, 0, point)`.
export function nearestSegmentInsertIndex(point: { x: number; y: number }, source: { x: number; y: number }, target: { x: number; y: number }, waypoints: { x: number; y: number }[]): number {
  const fullSequence = [source, ...waypoints, target];
  let bestIndex = 0;
  let bestDistSq = Infinity;
  for (let i = 0; i < fullSequence.length - 1; i++) {
    const distSq = squaredDistanceToSegment(point, fullSequence[i], fullSequence[i + 1]);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// How far a curved edge's control point extends outward from its endpoint, along that endpoint's
// own side-normal, before bending toward the other end - large enough that the curve visibly
// leaves perpendicular to the shape (rather than looking like a barely-bent straight line) but
// clamped so two very close nodes don't produce a control point that overshoots past the other end.
function curveControlDistance(source: { x: number; y: number }, target: { x: number; y: number }): number {
  return Math.min(120, Math.max(30, Math.hypot(target.x - source.x, target.y - source.y) / 2));
}

// The outward unit normal for a given side - which direction a curve (or the initial/final leg of
// an orthogonal route) travels immediately after leaving that side.
function sideNormal(side: "top" | "right" | "bottom" | "left"): { x: number; y: number } {
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

// Default bow strength (as a fraction of curveControlDistance) for a free-floating curve end with
// no drawn-gesture-derived WhiteboardEdge.curveBow to consult - e.g. the live drag preview before
// a direction has been decided, or an edge whose curveBow is absent (see its own doc comment).
export const DEFAULT_CURVE_BOW = 0.6;

// The two cubic-bezier control points for a "curved" edge between two resolved endpoints - shared
// by buildEdgePath (which draws the curve) and edgeEndAngleDeg (which needs the same points to
// compute each end's real tangent direction for its arrowhead, rather than the straight
// source->target line, which is wrong once the curve actually bows away from it). Each control
// point sits out along that end's own side-normal when it's anchored to a shape, so the line
// leaves/arrives perpendicular to whichever side it's on; an end with nothing to be perpendicular
// TO (a free-floating point - the common case for a stand-alone arrow drawn straight onto empty
// canvas, not attached to anything) instead bows out along the perpendicular of the source->target
// line, scaled by `bow` (sign picks which side, magnitude how far - see WhiteboardEdge.curveBow's
// own doc comment for where this number actually comes from) - the SAME bow for both free ends, so
// a fully free-floating arrow curves into one clean, single arc rather than an S-curve.
function curveControlPoints(source: ResolvedPoint, target: ResolvedPoint, bow: number): { c1: { x: number; y: number }; c2: { x: number; y: number } } {
  const dist = curveControlDistance(source, target);
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const len = Math.hypot(dx, dy) || 1;
  const perp = { x: -dy / len, y: dx / len };
  const c1 = source.side
    ? { x: source.x + sideNormal(source.side).x * dist, y: source.y + sideNormal(source.side).y * dist }
    : { x: source.x + perp.x * dist * bow, y: source.y + perp.y * dist * bow };
  const c2 = target.side
    ? { x: target.x + sideNormal(target.side).x * dist, y: target.y + sideNormal(target.side).y * dist }
    : { x: target.x + perp.x * dist * bow, y: target.y + perp.y * dist * bow };
  return { c1, c2 };
}

// The document-space bounding box that's guaranteed to contain everything buildEdgePath actually
// draws for this edge - source/target/waypoints always lie ON the drawn path, and (for "curved"
// routing with no waypoints) the two bezier control points don't lie on the curve itself, but a
// cubic bezier is always contained within the convex hull of its endpoints and control points, so
// including them still yields a valid bound. Used by WhiteboardCanvas.tsx's marquee-select so a
// rubber-band drag can actually catch a curved edge that bows well outside its own straight-line
// source->target box - without this, a curve bowed out from the marquee's own rectangle looks
// "inside" it (visually) but the edge never gets included in the resulting selection.
export function edgeBoundingBox(
  source: ResolvedPoint,
  target: ResolvedPoint,
  routing: EdgeRouting,
  bow: number = DEFAULT_CURVE_BOW,
  waypoints: { x: number; y: number }[] = []
): { x: number; y: number; width: number; height: number } {
  const points: { x: number; y: number }[] = [source, target, ...waypoints];
  if (routing === "curved" && waypoints.length === 0) {
    const { c1, c2 } = curveControlPoints(source, target, bow);
    points.push(c1, c2);
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Below this signed perpendicular distance (doc px) from the straight start->end line, a drag
// gesture is treated as "didn't deliberately curve" - a quick, fairly direct drag still gets a
// visibly curved connector (DEFAULT_CURVE_BOW's fixed direction) rather than an almost-straight
// line just because the mouse wobbled a couple pixels off-axis.
const CURVE_BOW_DEVIATION_THRESHOLD = 8;

// The magnitude range a deliberately-curved drag's bow is mapped into (see
// computeCurveBowFromPath) - MIN so even a gentle, barely-past-the-threshold wiggle still reads as
// "yes, curved" rather than vanishing back toward a straight line; MAX so an extreme swoop doesn't
// push the control points so far out the curve starts looping back on itself.
const MIN_CURVE_BOW_MAGNITUDE = 0.28;
const MAX_CURVE_BOW_MAGNITUDE = 0.95;

// Derives a WhiteboardEdge.curveBow value from the actual path a "Curved" connector was dragged
// through - WhiteboardCanvas.tsx records this path purely to feed this function (it's never saved
// to the document; only the resulting single scalar is). The SIGN comes from the path's AVERAGE
// signed deviation from the straight start->end line (robust to one noisy/jittery point, unlike
// picking a single sample) - a curve drawn arcing left bows left, one arced right bows right,
// matching the gesture instead of an arbitrary fixed rotation. The MAGNITUDE separately comes from
// the single point of GREATEST deviation, scaled relative to how far apart start/end are and
// clamped into [MIN_CURVE_BOW_MAGNITUDE, MAX_CURVE_BOW_MAGNITUDE] - so a gentle curve renders
// gently and a dramatic swoop renders dramatically, instead of every deliberately-curved drag
// producing the exact same fixed-strength arc regardless of how much it actually bowed. A path
// with no meaningful deviation (a fairly direct drag) falls back to DEFAULT_CURVE_BOW entirely,
// same as an edge with no curveBow at all.
export function computeCurveBowFromPath(start: { x: number; y: number }, end: { x: number; y: number }, path: { x: number; y: number }[]): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  let sumSignedDist = 0;
  let maxAbsDist = 0;
  for (const p of path) {
    // Signed 2D cross product of (end-start) and (p-start), normalized by length - positive means
    // p sits on the same side as `perp` in curveControlPoints (same (-dy,dx) rotation), so this
    // sign is directly usable as-is for the bow multiplier there.
    const cross = dx * (p.y - start.y) - dy * (p.x - start.x);
    const dist = cross / len;
    sumSignedDist += dist;
    maxAbsDist = Math.max(maxAbsDist, Math.abs(dist));
  }
  if (maxAbsDist < CURVE_BOW_DEVIATION_THRESHOLD) return DEFAULT_CURVE_BOW;
  const avgSignedDist = path.length > 0 ? sumSignedDist / path.length : 0;
  const sign = avgSignedDist >= 0 ? 1 : -1;
  const ratio = Math.min(1, maxAbsDist / curveControlDistance(start, end));
  const magnitude = MIN_CURVE_BOW_MAGNITUDE + ratio * (MAX_CURVE_BOW_MAGNITUDE - MIN_CURVE_BOW_MAGNITUDE);
  return sign * magnitude;
}

// Smooths a polyline into one open path `d` string - each interior point becomes a quadratic
// curve's control point, arriving at the midpoint of it and the NEXT point (the standard cheap
// "smooth a polyline" trick, same technique WhiteboardCanvas.tsx's own smoothedPathD and this
// file's freehandPath2D use for freehand ink) - kept as an independent copy rather than shared with
// those two so a future change to one (say, freehand ink wanting a different smoothing feel) can't
// silently affect edge waypoints too.
function smoothPolylineD(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length < 3) return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    d += ` Q ${points[i].x} ${points[i].y} ${mid.x} ${mid.y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

// Builds the SVG path `d` string for an edge between two resolved endpoints. `waypoints` (manual
// bend points a user dragged onto the line - see WhiteboardEdge.waypoints's own doc comment) take
// priority when present: "curved" smooths a spline through source->waypoints->target,
// straight/orthogonal both connect them with sharp segments - orthogonal's own auto right-angle
// routing below only runs when there are none. Otherwise: "straight" is a single segment;
// "orthogonal" (draw.io's default connector look) inserts one or two right-angle bends depending
// on which sides the two ends leave from; "curved" is a cubic bezier through curveControlPoints -
// see its own doc comment for why it always actually curves, never silently degrading to a
// straight line when neither end is anchored to a shape. `bow` (only consulted when at least one
// end is free-floating AND there are no waypoints) defaults to DEFAULT_CURVE_BOW's fixed direction
// when omitted; pass the edge's own WhiteboardEdge.curveBow to bow the curve the way it was
// actually drawn instead.
export function buildEdgePath(source: ResolvedPoint, target: ResolvedPoint, routing: EdgeRouting, bow: number = DEFAULT_CURVE_BOW, waypoints: { x: number; y: number }[] = []): string {
  if (waypoints.length > 0) {
    const points = [{ x: source.x, y: source.y }, ...waypoints, { x: target.x, y: target.y }];
    if (routing === "curved") return smoothPolylineD(points);
    return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  }

  if (routing === "curved") {
    const { c1, c2 } = curveControlPoints(source, target, bow);
    return `M ${source.x} ${source.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${target.x} ${target.y}`;
  }

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
// rather than the straight source->target direction (wrong for an orthogonal/curved path's last
// leg). "curved" uses the exact same cubic-bezier control points buildEdgePath drew the curve
// through (see curveControlPoints) to find each end's real tangent direction - using the straight
// source->target direction instead (as this used to) is only correct when the curve doesn't
// actually bow away from that line, which free-floating ends now deliberately do. "orthogonal"
// leaves/arrives along the anchored side's own normal; only "straight" (or an orthogonal edge with
// neither end anchored, which buildEdgePath already renders as a plain line) falls back to the
// literal source->target direction.
export function edgeEndAngleDeg(
  source: { x: number; y: number },
  target: { x: number; y: number },
  routing: EdgeRouting,
  sourceSide: "top" | "right" | "bottom" | "left" | null,
  targetSide: "top" | "right" | "bottom" | "left" | null,
  bow: number = DEFAULT_CURVE_BOW,
  waypoints: { x: number; y: number }[] = []
): { startDeg: number; endDeg: number } {
  if (waypoints.length > 0) {
    // Approximates each end's tangent as the direction from its nearest waypoint - exact for the
    // straight/orthogonal (sharp-segment) case, a reasonable stand-in for "curved" (the true
    // tangent at a quadratic spline's very end point is this same direction anyway).
    const nearStart = waypoints[0];
    const nearEnd = waypoints[waypoints.length - 1];
    const startDeg = (Math.atan2(source.y - nearStart.y, source.x - nearStart.x) * 180) / Math.PI;
    const endDeg = (Math.atan2(target.y - nearEnd.y, target.x - nearEnd.x) * 180) / Math.PI;
    return { startDeg, endDeg };
  }
  if (routing === "curved") {
    const { c1, c2 } = curveControlPoints({ ...source, side: sourceSide }, { ...target, side: targetSide }, bow);
    const endDeg = (Math.atan2(target.y - c2.y, target.x - c2.x) * 180) / Math.PI;
    const startDeg = (Math.atan2(source.y - c1.y, source.x - c1.x) * 180) / Math.PI;
    return { startDeg, endDeg };
  }
  if (routing === "orthogonal" && (sourceSide || targetSide)) {
    const sideDeg = (side: "top" | "right" | "bottom" | "left") => (side === "left" ? 180 : side === "right" ? 0 : side === "top" ? -90 : 90);
    // A marker-end arrow points in the direction of travel AT arrival, i.e. the side's outward
    // normal reversed (arriving INTO the shape) - so target uses sideDeg+180, while a marker-start
    // arrow (pointing back out along departure) uses the source side's own outward angle directly.
    const endDeg = targetSide ? sideDeg(targetSide) + 180 : (Math.atan2(target.y - source.y, target.x - source.x) * 180) / Math.PI;
    const startDeg = sourceSide ? sideDeg(sourceSide) : (Math.atan2(source.y - target.y, source.x - target.x) * 180) / Math.PI;
    return { startDeg, endDeg };
  }
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return { startDeg: deg + 180, endDeg: deg };
}

// ---- Shape outlines -----------------------------------------------------------------------------
//
// Shared geometry for every shape beyond plain rectangle/ellipse - both the DOM canvas
// (WhiteboardCanvas.tsx, building an SVG <polygon>/<path>) and the PNG export renderer (renderNode
// below, building Canvas2D paths) branch on this same description so the two stay visually
// identical rather than drifting apart as two independent hand-written implementations. Every
// coordinate here is node-LOCAL (0,0 at the node's own top-left, (w,h) at its bottom-right) - the
// DOM renderer applies this inside a div already positioned at the node's x/y, and the Canvas2D
// renderer ctx.translate(node.x, node.y) first, so neither has to re-derive absolute coordinates.
export type ShapeOutline =
  | { kind: "rect" } // rectangle/text - rendered via the node's own div border/background, not built here
  | { kind: "ellipse" }
  // innerLines: extra stroke-only (no fill) line segments drawn after the main outline - e.g.
  // cube's 3D edge lines, note's folded-corner crease. Each entry is one polyline's points.
  // innerCircle: an extra stroke-only (no fill) circle drawn after innerLines - benzeneRing's
  // inscribed ring denoting the aromatic bond, the one case so far that needs a circle rather than
  // a polyline nested inside a polygon outline.
  | { kind: "polygon"; points: [number, number][]; innerLines?: [number, number][][]; innerCircle?: { cx: number; cy: number; r: number } }
  | { kind: "cylinder" }
  // A hand-built SVG path `d` string for outlines a simple point list can't express (currently
  // just the curved ones: document's wavy edge, cloud's bumps).
  | { kind: "path"; d: string }
  // The graph-plot shapes (bar/line/pie/scatter charts, function plots) - unlike every kind above,
  // these are never one flat-colored silhouette, so each part carries its OWN role deciding how
  // it's colored at render time (see ChartPartRole's own doc comment) rather than the node's plain
  // fillColor/strokeColor pair covering the whole shape.
  // `labels` - small text annotations (axis scale numbers, per-bar values) neither Path2D nor an
  // SVG <path> can express, so they're kept as plain position+text objects the renderer draws with
  // <text>/ctx.fillText instead - see ChartLabel's own doc comment.
  // `inset` shifts `parts`/`labels` (which are built in the PLOT box's own coordinates) to their
  // real position inside the node, making room in the margins for the title captions in
  // `overlayLabels` (which are already in node-local coordinates and are NOT shifted). Splitting it
  // this way means every chart-outline builder below still works in a plain 0,0-to-w,h plot box and
  // knows nothing about titles - the alternative, re-parsing and translating each built SVG path `d`
  // string, would mean every builder either threading a margin through all of its own math or having
  // its output rewritten by a path parser. Absent - no margins, nothing shifted.
  | { kind: "chart"; parts: ChartPart[]; labels?: ChartLabel[]; inset?: { dx: number; dy: number }; overlayLabels?: ChartLabel[] };

// One small text annotation on a "chart" shape - axis tick numbers/values, styled with the node's
// own Font/Font size/Font color/Bold/Italic/Underline style-panel fields (the same ones any other
// shape's own WhiteboardNode.text obeys - see paintNodeText), since the style panel already shows
// those controls for every CHART_LABEL_SHAPES member and a control that visibly does nothing is
// worse than not showing it at all. `anchor` matches SVG's own text-anchor/Canvas2D's textAlign
// values directly, so both renderers can pass it straight through with no translation.
export interface ChartLabel {
  x: number;
  y: number;
  text: string;
  anchor: "start" | "middle" | "end";
  // Degrees, clockwise, about this label's own (x, y) - what draws a y-axis caption reading bottom-
  // to-top up the left edge (rotate: -90), the standard plotting convention. Absent/0 - horizontal.
  rotate?: number;
  // Overrides the node's own fontColor for just this label - a series legend entry keyed to its own
  // trace color, an annotation callout matching its marker. Absent - the node's fontColor.
  color?: string;
  // Multiplies the node's own fontSize for just this label - a chart title reads larger than the
  // tick numbers around it without needing a second font-size field on the node. Absent - 1.
  fontScale?: number;
  // Overrides the node's own fontWeight. Absent - the node's own.
  weight?: "normal" | "bold";
}

// How one piece of a "chart" ShapeOutline gets colored - resolved by the renderer (both
// WhiteboardCanvas.tsx's SVG and this file's own Canvas2D paintShapeBody), not baked into the outline
// itself, so a chart shape still respects the node's own fillColor/strokeColor the same way every
// other shape does wherever that's meaningful:
//   "fill"   - node.fillColor (bar-chart bars) - fill only, no stroke.
//   "stroke" - node.strokeColor (a line-chart's connecting line, a function plot's curve) - stroke
//              only, no fill (filling an open, possibly-zigzagging line would shade a meaningless
//              region under it).
//   "marker" - node.strokeColor, filled solid (line/scatter point dots - small closed circles, so
//              filling them is exactly what makes them read as dots rather than rings).
//   "axis"   - a fixed neutral gray, thin stroke, regardless of the node's own colors - a chart's
//              axis/baseline is scaffolding, not data, so it stays visually recessive even if the
//              node's stroke color is something bold.
//   "grid"   - functionPlot's optional graph-paper gridlines (WhiteboardNode.plotShowGrid) - an even
//              fainter, thinner gray than "axis", so the axis lines themselves still read as the
//              more prominent x=0/y=0 reference even with the full grid turned on.
//   "slice"  - `color` is REQUIRED and used as-is (a pie chart's per-slice palette color - see
//              PIE_PALETTE) - the one role where node.fillColor/strokeColor play no part at all.
//   "series" - `color` REQUIRED, stroked (not filled) at `width` - one trace of a multi-series plot,
//              colored from its own colormap position rather than the node's single strokeColor
//              (see whiteboardTypes.ts's resolveSeriesData). Same "the node's own color pair can't
//              express N independently-colored parts" reasoning as "slice", just stroked instead of
//              filled.
//   "seriesFill" - `color` REQUIRED, filled at low opacity - the optional shading between a trace
//              and its own baseline (WhiteboardNode.seriesFillUnder). Its own role rather than
//              reusing "slice" so the renderers can apply the opacity in one place.
//   "annotation" - `color` REQUIRED, filled solid - a data-space callout's marker glyph (see
//              whiteboardTypes.ts's ChartAnnotation), which carries its own color independent of
//              both the node's stroke and any series palette.
export type ChartPart =
  | { d: string; role: "fill" | "stroke" | "axis" | "marker" | "grid" }
  | { d: string; role: "slice"; color: string }
  | { d: string; role: "series"; color: string; width: number }
  | { d: string; role: "seriesFill"; color: string }
  | { d: string; role: "annotation"; color: string };

// Opacity the "seriesFill" role shades with - low enough that traces stacked on top of each other
// stay individually readable through the shading, which is the whole reason the fill is optional.
export const SERIES_FILL_OPACITY = 0.35;

export interface ShapeOutlineOptions {
  sides?: number; // "polygon" only
  starPoints?: number; // "star" only
  starInnerRadiusRatio?: number; // "star" only
  waveStyle?: WhiteboardNode["waveStyle"]; // "wave" only
  waveCycles?: number; // "wave" only
  angleDegrees?: number; // "angle" only
  angleRay1Length?: number; // "angle" only
  angleRay2Length?: number; // "angle" only
  chartData?: number[]; // "barChart"/"lineChart"/"pieChart"/"scatterPlot" only
  plotFunction?: FunctionPlotType; // "functionPlot" only
  plotDomainScale?: number; // "functionPlot" only
  plotCycles?: number; // "functionPlot" only (sine/cosine)
  plotShowGrid?: boolean; // "functionPlot" only
  plotXTickInterval?: number; // "functionPlot" only
  plotYTickInterval?: number; // "functionPlot" only
  showChartLabels?: boolean; // "barChart"/"lineChart"/"scatterPlot"/"functionPlot"/"graph" only
  numberLineMax?: number; // "numberLine" only
  graphExpression?: string; // "graph" only
  graphXMin?: number; // "graph" only
  graphXMax?: number; // "graph" only
  graphYMin?: number; // "graph" only
  graphYMax?: number; // "graph" only
  graphShowGrid?: boolean; // "graph" only
  graphXTickInterval?: number; // "graph" only
  graphYTickInterval?: number; // "graph" only
  graphPoints?: { x: number; y: number }[]; // "graph" only
  // "waterfallChart" only - named to match WhiteboardNode's own fields exactly so this options
  // object structurally satisfies whiteboardTypes.ts's SeriesSource and can be handed straight to
  // resolveSeriesData, rather than being copied field-by-field into a second object first.
  seriesData?: number[][];
  seriesXMin?: number;
  seriesXMax?: number;
  seriesYMin?: number;
  seriesYMax?: number;
  seriesOffset?: number;
  seriesColormap?: WhiteboardNode["seriesColormap"];
  seriesColorsReversed?: boolean;
  seriesColors?: (string | null)[];
  seriesLabels?: string[];
  seriesFillUnder?: boolean;
  seriesShowBaselines?: boolean;
  seriesShowLegend?: boolean;
  seriesShowGrid?: boolean;
  seriesXTickInterval?: number;
  seriesYTickInterval?: number;
  // Every CHART_AXIS_TITLE_SHAPES member - see chartTitleLayout. `fontSize` is only consulted to
  // size the margins those titles reserve (the renderers apply the real font themselves).
  chartTitle?: string;
  axisXTitle?: string;
  axisYTitle?: string;
  fontSize?: number;
  // Every CHART_ANNOTATION_SHAPES member. `strokeColor` is the fallback an annotation with no color
  // of its own takes.
  chartAnnotations?: ChartAnnotation[];
  strokeColor?: string;
  // "waterfallChart" only - the per-trace line weight, taken from the node's own strokeWidth (the
  // "series" ChartPart role carries its own width rather than the renderer applying node.strokeWidth,
  // since a legend swatch or a future per-trace weight needs to differ from it).
  strokeWidth?: number;
  ampInputTopLeadLength?: number; // "amplifier" only
  ampInputBottomLeadLength?: number; // "amplifier" only
  ampOutputLeadLength?: number; // "amplifier" only
  ampInputTopLeadYOffset?: number; // "amplifier" only
  ampInputBottomLeadYOffset?: number; // "amplifier" only
  ampOutputLeadYOffset?: number; // "amplifier" only
  ampInvertingOnTop?: boolean; // "amplifier" only
  tableRows?: number; // "table" only
  tableCols?: number; // "table" only
  tableColWidths?: number[]; // "table" only - fractions, length === tableCols
  tableRowHeights?: number[]; // "table" only - fractions, length === tableRows
}

// A regular n-gon inscribed in the w×h box, flat vertex at top (angle -90°) - standard parametric
// construction, shared by shapeOutlineFor's "polygon" (n = sides) and "star" (outer ring) cases.
function regularPolygonPoints(w: number, h: number, sides: number): [number, number][] {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const points: [number, number][] = [];
  for (let i = 0; i < sides; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
    points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return points;
}

function starPoints(w: number, h: number, points: number, innerRatio: number): [number, number][] {
  const cx = w / 2;
  const cy = h / 2;
  const outerRx = w / 2;
  const outerRy = h / 2;
  const innerRx = outerRx * innerRatio;
  const innerRy = outerRy * innerRatio;
  const result: [number, number][] = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / points;
    const outer = i % 2 === 0;
    result.push([cx + (outer ? outerRx : innerRx) * Math.cos(angle), cy + (outer ? outerRy : innerRy) * Math.sin(angle)]);
  }
  return result;
}

// Bounds for WhiteboardNode.waveCycles - below 1 the shape stops reading as periodic at all; the
// upper bound is just a sanity cap (sample count scales with cycles below, so quality doesn't
// degrade as this grows - it's there only to keep a wildly out-of-range typed value from building
// an absurdly long path string).
export const MIN_WAVE_CYCLES = 1;
export const MAX_WAVE_CYCLES = 60;
export const DEFAULT_WAVE_CYCLES = 2;

// ---- Science/diagram symbol outlines -------------------------------------------------------------
//
// Fixed (non-parametric) glyphs - like document/cloud above, these are hand-tuned single shapes,
// not built from a user-adjustable parameter the way polygon/star/wave are. Each returns a `d`
// string built from one or more independent M-started subpaths (no trailing Z on the line-only
// ones), which is exactly what makes a plain multi-segment circuit symbol expressible as a single
// ShapeOutline "path" - see this file's ShapeOutline doc comment: fillAndStroke/the DOM renderer
// only fill when the node actually has a fillColor (LINE_ONLY_SHAPES in whiteboardTypes.ts keeps
// these at fillColor: null by default), so an open, unfilled multi-subpath `d` just draws as the
// bare line art it looks like.

// Classic zigzag resistor symbol: flat leads in/out, a symmetric triangle-wave zigzag between.
function resistorOutlineD(w: number, h: number): string {
  const midY = h / 2;
  const leadIn = w * 0.12;
  const leadOut = w * 0.88;
  const peaks = 6;
  const amp = h * 0.32;
  const points: [number, number][] = [[0, midY], [leadIn, midY]];
  for (let i = 0; i < peaks; i++) {
    const x = leadIn + ((leadOut - leadIn) * (i + 0.5)) / peaks;
    points.push([x, i % 2 === 0 ? midY - amp : midY + amp]);
  }
  points.push([leadOut, midY], [w, midY]);
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

// Two parallel plates with leads - the standard capacitor symbol.
function capacitorOutlineD(w: number, h: number): string {
  const midY = h / 2;
  const gap = w * 0.14;
  const x1 = w / 2 - gap / 2;
  const x2 = w / 2 + gap / 2;
  const halfH = h * 0.38;
  return [`M0,${midY} L${x1.toFixed(2)},${midY}`, `M${x1.toFixed(2)},${(midY - halfH).toFixed(2)} L${x1.toFixed(2)},${(midY + halfH).toFixed(2)}`, `M${x2.toFixed(2)},${(midY - halfH).toFixed(2)} L${x2.toFixed(2)},${(midY + halfH).toFixed(2)}`, `M${x2.toFixed(2)},${midY} L${w},${midY}`].join(
    " "
  );
}

// Same two-plate idea as the capacitor but one plate long/thin and the other short - the standard
// single-cell battery symbol, distinguishing it at a glance from a capacitor.
function batteryOutlineD(w: number, h: number): string {
  const midY = h / 2;
  const gap = w * 0.12;
  const longX = w / 2 - gap / 2;
  const shortX = w / 2 + gap / 2;
  const longHalf = h * 0.38;
  const shortHalf = h * 0.18;
  return [
    `M0,${midY} L${longX.toFixed(2)},${midY}`,
    `M${longX.toFixed(2)},${(midY - longHalf).toFixed(2)} L${longX.toFixed(2)},${(midY + longHalf).toFixed(2)}`,
    `M${shortX.toFixed(2)},${(midY - shortHalf).toFixed(2)} L${shortX.toFixed(2)},${(midY + shortHalf).toFixed(2)}`,
    `M${shortX.toFixed(2)},${midY} L${w},${midY}`,
  ].join(" ");
}

// A row of alternating-bulge semicircular arcs between two flat leads - reads as a coil/spring
// viewed from the side (physics) as readily as an inductor (circuits), so it's left generically
// named "spring" rather than picking one domain.
function springOutlineD(w: number, h: number): string {
  const midY = h / 2;
  const leadIn = w * 0.1;
  const leadOut = w * 0.1;
  const coilW = w - leadIn - leadOut;
  const loops = 5;
  const r = coilW / (loops * 2);
  const parts = [`M0,${midY.toFixed(2)}`, `L${leadIn.toFixed(2)},${midY.toFixed(2)}`];
  let x = leadIn;
  for (let i = 0; i < loops; i++) {
    const nx = x + 2 * r;
    parts.push(`A${r.toFixed(2)},${r.toFixed(2)} 0 0,${i % 2 === 0 ? 1 : 0} ${nx.toFixed(2)},${midY.toFixed(2)}`);
    x = nx;
  }
  parts.push(`L${w},${midY.toFixed(2)}`);
  return parts.join(" ");
}

// Same construction as springOutlineD, but every bump bulges the SAME direction (a constant sweep
// flag instead of alternating) - the conventional circuit-schematic "row of loops" inductor coil,
// distinct from "spring"'s side-view-of-a-physical-spring look.
function inductorOutlineD(w: number, h: number): string {
  const midY = h / 2;
  const leadIn = w * 0.1;
  const leadOut = w * 0.1;
  const coilW = w - leadIn - leadOut;
  const loops = 4;
  const r = coilW / (loops * 2);
  const parts = [`M0,${midY.toFixed(2)}`, `L${leadIn.toFixed(2)},${midY.toFixed(2)}`];
  let x = leadIn;
  for (let i = 0; i < loops; i++) {
    const nx = x + 2 * r;
    parts.push(`A${r.toFixed(2)},${r.toFixed(2)} 0 1,1 ${nx.toFixed(2)},${midY.toFixed(2)}`);
    x = nx;
  }
  parts.push(`L${w},${midY.toFixed(2)}`);
  return parts.join(" ");
}

// Circuit diode - a lead in, a triangle pointing at the cathode bar, the bar itself, a lead out.
// Unlike resistor/capacitor/etc., the triangle subpath IS closed (has a Z) - a diode's triangle is
// a real fillable region (see LINE_ONLY_SHAPES's own doc comment on why this one's excluded from
// it), the leads/bar stay open zero-area subpaths the same way frameOutlineD already mixes open and
// closed subpaths in one `d`.
function diodeOutlineD(w: number, h: number): string {
  const midY = h / 2;
  const amp = h * 0.32;
  const baseX = w * 0.38;
  const tipX = w * 0.62;
  return [
    `M0,${midY.toFixed(2)} L${baseX.toFixed(2)},${midY.toFixed(2)}`,
    `M${baseX.toFixed(2)},${(midY - amp).toFixed(2)} L${tipX.toFixed(2)},${midY.toFixed(2)} L${baseX.toFixed(2)},${(midY + amp).toFixed(2)} Z`,
    `M${tipX.toFixed(2)},${(midY - amp).toFixed(2)} L${tipX.toFixed(2)},${(midY + amp).toFixed(2)}`,
    `M${tipX.toFixed(2)},${midY.toFixed(2)} L${w},${midY.toFixed(2)}`,
  ].join(" ");
}

// Circuit ground - a short lead down to three horizontal bars of decreasing width, the standard
// "signal ground" symbol.
function groundOutlineD(w: number, h: number): string {
  const midX = w / 2;
  const leadBottomY = h * 0.4;
  const bars: [number, number][] = [
    [w * 0.35, h * 0.4],
    [w * 0.22, h * 0.62],
    [w * 0.1, h * 0.84],
  ];
  const parts = [`M${midX.toFixed(2)},0 L${midX.toFixed(2)},${leadBottomY.toFixed(2)}`];
  for (const [halfW, y] of bars) {
    parts.push(`M${(midX - halfW).toFixed(2)},${y.toFixed(2)} L${(midX + halfW).toFixed(2)},${y.toFixed(2)}`);
  }
  return parts.join(" ");
}

// Bounds for WhiteboardNode.ampInputTopLeadLength/ampInputBottomLeadLength/ampOutputLeadLength
// ("amplifier" only) - each lead's own length in absolute doc units (NOT a fraction of width -
// unlike every other per-node "how big is this part" field in this file, these are deliberately
// absolute so dragging a lead's own terminal handle can lengthen/shorten JUST that wire, leaving
// the triangle body and the opposite lead untouched, the same way dragging one edge of a rotated
// box leaves the opposite edge fixed in world space - see WhiteboardCanvas.tsx's beginAmpLeadDrag
// and its "ampLead" pointer-move branch, which grows/shrinks the node's own width right along
// with the dragged lead so the terminal actually tracks the cursor). A fraction-of-width field
// couldn't do this: changing it while resizing the box to match would always rescale the OTHER
// lead and the triangle too (they all read the same width), losing the "only this one wire
// changed" feel entirely.
export const MIN_AMP_LEAD_LENGTH = 5;
export const MAX_AMP_LEAD_LENGTH = 1000;
export const DEFAULT_AMP_INPUT_LEAD_LENGTH = 35;
export const DEFAULT_AMP_OUTPUT_LEAD_LENGTH = 29;
// The op-amp triangle always keeps at least this much width (see amplifierOutlineParts's own
// degenerate-guard below) - a normal corner-resize shrinking the node way down while the lead
// lengths stay at whatever absolute value they were last dragged to would otherwise invert or
// collapse the triangle entirely.
const AMP_MIN_TRIANGLE_WIDTH = 24;
// Vertical position of the input leads/+-glyphs (before any WhiteboardNode.ampInput*LeadYOffset
// bend), as a fraction of node height - shared by amplifierOutlineParts (the actual geometry) and
// WhiteboardCanvas.tsx's terminal-handle placement, so the handles always sit exactly on the
// rendered leads.
export const AMP_PLUS_Y_FRAC = 0.28;
export const AMP_MINUS_Y_FRAC = 0.72;
// Bound for a lead's yOffset - deliberately the SAME generous, height-INDEPENDENT range the length
// fields use (MIN/MAX_AMP_LEAD_LENGTH's own scale) rather than clamped to the node's own current
// height, so a bend can freely route well outside the shape's own bounding box (the node div's SVG
// already renders with overflow: visible, so there's nothing stopping that visually) - routing a
// lead down to some other shape far below the amplifier, say, isn't something the amplifier's own
// height should ever get to veto.
const AMP_LEAD_Y_OFFSET_BOUND = MAX_AMP_LEAD_LENGTH;
// Half-size of the +/- glyph marks, in FIXED absolute doc units - deliberately NOT a fraction of
// node width the way most of this shape's other proportions are, so dragging a lead terminal
// (which changes the node's own width to grow/shrink that lead - see WhiteboardCanvas.tsx's
// beginAmpLeadDrag) can never make the glyphs themselves grow or shrink as a side effect. A normal
// whole-shape corner-resize doesn't rescale them either, for the same reason: their only job is to
// stay legibly sized "+"/"-" marks, not to track the body's own proportions.
const AMP_GLYPH_HALF = 7;

export interface AmplifierLeadGeometry {
  topLeadLength?: number;
  bottomLeadLength?: number;
  outputLeadLength?: number;
  topLeadYOffset?: number;
  bottomLeadYOffset?: number;
  outputLeadYOffset?: number;
  invertingOnTop?: boolean;
}

// Clamps a lead's own yOffset to AMP_LEAD_Y_OFFSET_BOUND and adds it to naturalY - shared by
// amplifierOutlineParts (the geometry) and WhiteboardCanvas.tsx's terminal-handle placement, so a
// handle always renders exactly on top of its own rendered wire.
export function clampAmpLeadTerminalY(naturalY: number, yOffset: number | undefined): number {
  return naturalY + Math.max(-AMP_LEAD_Y_OFFSET_BOUND, Math.min(AMP_LEAD_Y_OFFSET_BOUND, yOffset ?? 0));
}

// Op-amp - a triangle with two input leads on its flat left side (marked +/- with small open-line
// glyphs) and one output lead from its tip. Unlike every other circuit-symbol glyph in this file
// (diode, ground, ...), this one is a "chart"-kind ShapeOutline (multiple independently-colored
// parts) rather than a single filled+stroked "path" - see the return statement's own doc comment
// for why a shape with a DRAGGABLE, potentially-bent lead needs that split.
//
// The triangle body is ALWAYS a plain, undistorted shape - a vertical left edge at ONE shared x
// (bodyAttachX, below) - regardless of how different the two input lead lengths are. An earlier
// version tried to slant the body's own edge to reach each lead's own length directly (a straight
// or "ears + diagonal" line from (topLen,0) to (bottomLen,h)); once the two lengths differed by
// much, that line's own geometry could fold back on itself into a self-intersecting dart/bowtie
// shape instead of a triangle. Attaching both leads to ONE shared point per height instead sidesteps
// that entirely: bodyAttachX = whichever lead is currently LONGER (matching the box-growth math in
// WhiteboardCanvas.tsx's "ampLead" pointer-move branch, which already grows the node's own width to
// fit whichever input lead is longer), and the SHORTER lead's terminal simply sits INSET from the
// box's own left edge by the difference between the two lengths - still a perfectly straight
// horizontal run at its own height, just not reaching all the way to x=0. The two input leads are
// always independently adjustable (own lengths, no "linked" mode - matching a real op-amp's +/-
// inputs being two unrelated wires); each can also be dragged vertically (yOffset) into an L-shaped
// bend - see clampAmpLeadTerminalY's own doc comment. A lead with no offset AND equal to the other
// lead's length renders as the exact same plain straight-edged triangle this shape always had, so
// this whole feature is backward-compatible with every amplifier placed before it existed.
// Resolves every position an amplifier's geometry needs from its raw fields - shared by
// amplifierOutlineParts (the actual outline) and WhiteboardCanvas.tsx's terminal-handle placement,
// so the handles always sit exactly on the rendered wires (including the degenerate-guard scaling
// and the Y-offset clamping, both of which the handles need to mirror exactly or they'd drift off
// the line they're supposed to be sitting on).
export function resolveAmplifierGeometry(w: number, h: number, geo?: AmplifierLeadGeometry) {
  let topLen = Math.max(MIN_AMP_LEAD_LENGTH, Math.min(MAX_AMP_LEAD_LENGTH, geo?.topLeadLength ?? DEFAULT_AMP_INPUT_LEAD_LENGTH));
  let bottomLen = Math.max(MIN_AMP_LEAD_LENGTH, Math.min(MAX_AMP_LEAD_LENGTH, geo?.bottomLeadLength ?? DEFAULT_AMP_INPUT_LEAD_LENGTH));
  let outputLen = Math.max(MIN_AMP_LEAD_LENGTH, Math.min(MAX_AMP_LEAD_LENGTH, geo?.outputLeadLength ?? DEFAULT_AMP_OUTPUT_LEAD_LENGTH));
  // Degenerate guard: if the (independently-clamped, absolute) lead lengths would together eat
  // more than the box has room for - e.g. after a normal corner-resize shrinks `w` without
  // touching any lead - scale ALL THREE down proportionally rather than letting the triangle
  // invert. Uses the LONGER of the two input leads (whichever one actually reaches furthest into
  // the box) rather than their sum, matching how the two leads share one triangle edge instead of
  // stacking end to end the way an input lead and the output lead do.
  const available = Math.max(AMP_MIN_TRIANGLE_WIDTH, w - AMP_MIN_TRIANGLE_WIDTH);
  const totalSpan = Math.max(topLen, bottomLen) + outputLen;
  if (totalSpan > available) {
    const scale = available / totalSpan;
    topLen *= scale;
    bottomLen *= scale;
    outputLen *= scale;
  }
  const bodyAttachX = Math.max(topLen, bottomLen);
  const topTerminalX = bodyAttachX - topLen;
  const bottomTerminalX = bodyAttachX - bottomLen;
  const tipX = w - outputLen;
  const plusY = h * AMP_PLUS_Y_FRAC;
  const minusY = h * AMP_MINUS_Y_FRAC;
  const midY = h / 2;
  const topTerminalY = clampAmpLeadTerminalY(plusY, geo?.topLeadYOffset);
  const bottomTerminalY = clampAmpLeadTerminalY(minusY, geo?.bottomLeadYOffset);
  const outputTerminalY = clampAmpLeadTerminalY(midY, geo?.outputLeadYOffset);
  return { bodyAttachX, topTerminalX, bottomTerminalX, tipX, plusY, minusY, midY, topTerminalY, bottomTerminalY, outputTerminalY };
}

function amplifierOutlineParts(w: number, h: number, geo?: AmplifierLeadGeometry): ChartPart[] {
  const { bodyAttachX, topTerminalX, bottomTerminalX, tipX, plusY, minusY, midY, topTerminalY, bottomTerminalY, outputTerminalY } = resolveAmplifierGeometry(w, h, geo);
  // Proportional inset from the shared body attach point (not a fixed fraction of the whole node
  // width) so the +/- marks stay sensibly placed inside the triangle body regardless of how long
  // either lead currently is.
  const glyphX = bodyAttachX + (tipX - bodyAttachX) * 0.15;
  const glyphHalf = AMP_GLYPH_HALF;
  // Which height gets the "+" (horizontal + vertical stroke) vs the "-" (horizontal stroke only) -
  // a pure label swap (see WhiteboardNode.ampInvertingOnTop's own doc comment): the physical
  // top/bottom lead geometry above never changes, only which glyph is drawn at which of the two
  // already-computed heights.
  const plusGlyphY = geo?.invertingOnTop ? minusY : plusY;
  const minusGlyphY = geo?.invertingOnTop ? plusY : minusY;
  const triangleD = `M${bodyAttachX.toFixed(2)},0 L${bodyAttachX.toFixed(2)},${h.toFixed(2)} L${tipX.toFixed(2)},${midY.toFixed(2)} Z`;
  // Each lead: a short vertical jog RIGHT AT THE TERMINAL (only when yOffset !== 0 - collapses to a
  // plain single-segment line whenever the jog's start/end Y coincide) to reach its own natural
  // height, then a straight horizontal run the rest of the way to bodyAttachX. The bend sits at the
  // terminal deliberately - that's the end the user is actually dragging, so the direction change
  // should happen right there, not sprung on the fixed body end the user never touched.
  const linesD = [
    `M${topTerminalX.toFixed(2)},${topTerminalY.toFixed(2)} L${topTerminalX.toFixed(2)},${plusY.toFixed(2)} L${bodyAttachX.toFixed(2)},${plusY.toFixed(2)}`,
    `M${bottomTerminalX.toFixed(2)},${bottomTerminalY.toFixed(2)} L${bottomTerminalX.toFixed(2)},${minusY.toFixed(2)} L${bodyAttachX.toFixed(2)},${minusY.toFixed(2)}`,
    // Output lead: mirrors the input leads' own "jog right at the terminal" pattern.
    `M${tipX.toFixed(2)},${midY.toFixed(2)} L${w},${midY.toFixed(2)} L${w},${outputTerminalY.toFixed(2)}`,
    `M${(glyphX - glyphHalf).toFixed(2)},${plusGlyphY.toFixed(2)} L${(glyphX + glyphHalf).toFixed(2)},${plusGlyphY.toFixed(2)}`,
    `M${glyphX.toFixed(2)},${(plusGlyphY - glyphHalf).toFixed(2)} L${glyphX.toFixed(2)},${(plusGlyphY + glyphHalf).toFixed(2)}`,
    `M${(glyphX - glyphHalf).toFixed(2)},${minusGlyphY.toFixed(2)} L${(glyphX + glyphHalf).toFixed(2)},${minusGlyphY.toFixed(2)}`,
  ].join(" ");
  // The triangle is its OWN two parts (one "fill", one "stroke", same `d`) rather than one
  // filled+stroked "path" outline the way diode/ground/etc.'s single-piece glyphs work - a bent
  // lead's 3-point L-shaped subpath (topTerminalY !== plusY, e.g.) is an OPEN path, and SVG/Canvas2D
  // both implicitly close an open subpath with a straight line back to its start FOR FILL PURPOSES
  // ONLY (never for the stroke) - mixed into one shared filled `d` the way the straight-line-only
  // version of this shape used to work, that implicit closing line would fill in a phantom
  // triangular sliver alongside the real triangle body. Keeping the leads/glyphs on their own
  // "stroke"-only part (see ChartPart's own role union) sidesteps the whole issue: they're never
  // filled at all, so an open subpath among them is always exactly as harmless as it looks.
  return [
    { d: triangleD, role: "fill" },
    { d: triangleD, role: "stroke" },
    { d: linesD, role: "stroke" },
  ];
}

// A zigzag chain of `segments` bonds - the skeletal-formula alkane-chain backbone (see the
// "bondLine" shapeType's own doc comment). Points alternate between a "low" and "high" y so the
// chain reads as the usual up-down carbon backbone, evenly spaced across the full width.
function bondLineOutlineD(w: number, h: number, segments: number): string {
  const n = Math.max(1, Math.round(segments));
  const highY = h * 0.25;
  const lowY = h * 0.75;
  const points: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = (w * i) / n;
    const y = i % 2 === 0 ? lowY : highY;
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return points.join(" ");
}

// Circle + x/y axes through the center + a short tick every 30 degrees - the standard "unit circle"
// reference diagram (see the shapeType's own doc comment on why this deliberately stops short of
// labeling each tick with its coordinate/radian value).
function unitCircleOutlineD(w: number, h: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const r = (Math.min(w, h) / 2) * 0.82;
  const circle = `M${(cx + r).toFixed(2)},${cy.toFixed(2)} A${r.toFixed(2)},${r.toFixed(2)} 0 1,0 ${(cx - r).toFixed(2)},${cy.toFixed(2)} A${r.toFixed(2)},${r.toFixed(2)} 0 1,0 ${(cx + r).toFixed(2)},${cy.toFixed(2)}`;
  const axisReach = r * 1.15;
  const axes = `M${(cx - axisReach).toFixed(2)},${cy.toFixed(2)} L${(cx + axisReach).toFixed(2)},${cy.toFixed(2)} M${cx.toFixed(2)},${(cy - axisReach).toFixed(2)} L${cx.toFixed(2)},${(cy + axisReach).toFixed(2)}`;
  const tickLen = Math.min(w, h) * 0.035;
  const ticks: string[] = [];
  for (let deg = 0; deg < 360; deg += 30) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const x1 = cx + r * cos;
    const y1 = cy - r * sin;
    const x2 = cx + (r + tickLen) * cos;
    const y2 = cy - (r + tickLen) * sin;
    ticks.push(`M${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)}`);
  }
  return [circle, axes, ...ticks].join(" ");
}

// Narrow neck flaring straight down to a flat, gently-rounded-corner base - the Erlenmeyer flask
// silhouette. Closed (has a Z), so - unlike the line-only symbols above - this one's meant to take
// a fill (e.g. shading in "liquid").
function flaskOutlineD(w: number, h: number): string {
  const neckHalfW = w * 0.11;
  const neckX0 = w / 2 - neckHalfW;
  const neckX1 = w / 2 + neckHalfW;
  const shoulderY = h * 0.32;
  const bottomY = h * 0.92;
  const baseHalfW = w * 0.46;
  const cornerHalfW = baseHalfW * 0.7;
  return [
    `M${neckX0.toFixed(2)},0`,
    `L${neckX0.toFixed(2)},${shoulderY.toFixed(2)}`,
    `L${(w / 2 - baseHalfW).toFixed(2)},${bottomY.toFixed(2)}`,
    `Q${(w / 2 - baseHalfW).toFixed(2)},${h} ${(w / 2 - cornerHalfW).toFixed(2)},${h}`,
    `L${(w / 2 + cornerHalfW).toFixed(2)},${h}`,
    `Q${(w / 2 + baseHalfW).toFixed(2)},${h} ${(w / 2 + baseHalfW).toFixed(2)},${bottomY.toFixed(2)}`,
    `L${neckX1.toFixed(2)},${shoulderY.toFixed(2)}`,
    `L${neckX1.toFixed(2)},0`,
    `Z`,
  ].join(" ");
}

// Slightly flared straight sides + a rounded-corner flat bottom, deliberately left open at the top
// (no closing segment back across the rim) plus a few short graduation-mark ticks on the left wall.
// Left open rather than Z-closed so a stroke never draws a line across the mouth, while an implicit
// fill-close still lets a fillColor shade the "contents" up to a flat waterline at the rim - see
// this section's own doc comment.
function beakerOutlineD(w: number, h: number): string {
  const leftTop = w * 0.1;
  const rightTop = w * 0.9;
  const leftBottom = w * 0.16;
  const rightBottom = w * 0.84;
  const cornerR = w * 0.06;
  const body = [
    `M${leftTop.toFixed(2)},0`,
    `L${leftBottom.toFixed(2)},${(h - cornerR).toFixed(2)}`,
    `Q${leftBottom.toFixed(2)},${h} ${(leftBottom + cornerR).toFixed(2)},${h}`,
    `L${(rightBottom - cornerR).toFixed(2)},${h}`,
    `Q${rightBottom.toFixed(2)},${h} ${rightBottom.toFixed(2)},${(h - cornerR).toFixed(2)}`,
    `L${rightTop.toFixed(2)},0`,
  ].join(" ");
  const tickLen = w * 0.09;
  const tickInset = w * 0.03;
  const ticks = [0.45, 0.62, 0.79]
    .map((f) => {
      const y = h * f;
      const xWall = leftTop + (leftBottom - leftTop) * f;
      const x0 = xWall + tickInset;
      return `M${x0.toFixed(2)},${y.toFixed(2)} L${(x0 + tickLen).toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return `${body} ${ticks}`;
}

// A "+"-shaped cross with a chevron arrowhead on the +x and +y ends only (x pointing right, y
// pointing up - standard math convention) - two independent line subpaths plus two independent
// two-segment chevron subpaths, all open.
function axesOutlineD(w: number, h: number): string {
  const midX = w / 2;
  const midY = h / 2;
  const s = Math.min(w, h) * 0.07;
  return [
    `M0,${midY} L${w},${midY}`,
    `M${midX},${h} L${midX},0`,
    `M${(w - s).toFixed(2)},${(midY - s).toFixed(2)} L${w},${midY} L${(w - s).toFixed(2)},${(midY + s).toFixed(2)}`,
    `M${(midX - s).toFixed(2)},${s.toFixed(2)} L${midX},0 L${(midX + s).toFixed(2)},${s.toFixed(2)}`,
  ].join(" ");
}

// Bounds for WhiteboardNode.angleDegrees/angleRay1Length/angleRay2Length. Degrees stops short of
// 0/180 so the two rays never fully overlap (an angle glyph showing no angle at all); ray lengths
// stop short of 0 for the same reason (a ray you can't see isn't a side you can measure). The
// default (1) lands each ray exactly at its box edge, but the max goes well past that (2.5x) rather
// than stopping there - 1.0 being the ceiling made the length sliders default to fully maxed-out
// with nowhere to go but shorter, which read as "stuck"/fixed rather than as an adjustable length.
// The node's own SVG layers render with `overflow: visible` (see WhiteboardCanvas.tsx), so a ray
// past 1.0 genuinely draws outside the node's bounding box instead of getting clipped.
export const MIN_ANGLE_DEGREES = 5;
export const MAX_ANGLE_DEGREES = 175;
export const DEFAULT_ANGLE_DEGREES = 50;
export const MIN_ANGLE_RAY_LENGTH = 0.2;
export const MAX_ANGLE_RAY_LENGTH = 2.5;
export const DEFAULT_ANGLE_RAY_LENGTH = 1;

// Two rays from a shared vertex (bottom-left corner) - one flat along the bottom (ray 1), one at
// the given angle measured counterclockwise from it (ray 2) - plus a short arc near the vertex
// marking the angle between them, the standard geometry "angle" glyph. Ray 1's own natural max
// length is the node's width, ray 2's is min(width, height) - each `rayFrac` scales its ray
// independently off that, so shortening one doesn't also shrink the other. The arc radius is
// clamped to whichever ray ends up shorter so it never overshoots a shortened ray.
function angleOutlineD(w: number, h: number, degrees: number, ray1Frac: number, ray2Frac: number): string {
  const vx = 0;
  const vy = h;
  const theta = (degrees * Math.PI) / 180;
  const ray1Len = w * ray1Frac;
  const ray2Len = Math.min(w, h) * ray2Frac;
  const ray2x = vx + ray2Len * Math.cos(theta);
  const ray2y = vy - ray2Len * Math.sin(theta);
  const arcR = Math.min(Math.min(w, h) * 0.28, ray1Len * 0.9, ray2Len * 0.9);
  const arcStartX = vx + arcR;
  const arcEndX = vx + arcR * Math.cos(theta);
  const arcEndY = vy - arcR * Math.sin(theta);
  return [
    `M${vx},${vy} L${(vx + ray1Len).toFixed(2)},${vy}`,
    `M${vx},${vy} L${ray2x.toFixed(2)},${ray2y.toFixed(2)}`,
    `M${arcStartX.toFixed(2)},${vy} A${arcR.toFixed(2)},${arcR.toFixed(2)} 0 0,0 ${arcEndX.toFixed(2)},${arcEndY.toFixed(2)}`,
  ].join(" ");
}

// ---- General-purpose glyph outlines (draw.io's own "General" shape palette) -----------------------
//
// Fixed (non-parametric) icons, same reasoning/conventions as the science symbols above - closed
// shapes, so (unlike those) they keep the normal default fillColor rather than being in
// LINE_ONLY_SHAPES.

// ---- Arithmetic-sign glyphs (draw.io's own "Math" shape palette) ---------------------------------
//
// "+" is deliberately not among these - it's the exact same plus-sign silhouette "cross" already
// draws, just offered again under a math-specific label (see WhiteboardEditor.tsx's own preset
// list). These three keep the same "closed shape, normal default fillColor" treatment as the
// general-purpose glyphs above.

// The "x" glyph as the same 12-point plus-sign silhouette "cross" uses, rotated 45 degrees about
// its own center and rescaled so the rotated shape still touches this shape's own w x h bounding
// box (rotating first would overflow it, since a square's diagonal is longer than its side) - kept
// as its own helper rather than parameterizing "cross" itself, to avoid any risk of shifting that
// already-shipped shape's established look.
function multiplySignPoints(w: number, h: number): [number, number][] {
  const ht = 0.32; // arm half-thickness, as a fraction of the unit shape's own half-extent (1)
  const unit: [number, number][] = [
    [-ht, -1], [ht, -1], [ht, -ht], [1, -ht], [1, ht], [ht, ht],
    [ht, 1], [-ht, 1], [-ht, ht], [-1, ht], [-1, -ht], [-ht, -ht],
  ];
  const cos45 = Math.SQRT1_2;
  const rotated = unit.map(([x, y]): [number, number] => [(x - y) * cos45, (x + y) * cos45]);
  const maxAbs = Math.max(...rotated.flat().map(Math.abs));
  const scale = Math.min(w, h) / 2 / maxAbs;
  const cx = w / 2;
  const cy = h / 2;
  return rotated.map(([x, y]): [number, number] => [cx + x * scale, cy + y * scale]);
}

// The division-sign glyph - a horizontal bar plus a small filled dot above and below it. Two disjoint rect/
// circle subpaths in one "path" outline (rather than "polygon", which is a single closed ring) -
// SVG fills each subpath independently, so the gaps between the bar and the dots stay unfilled.
function divideSignOutlineD(w: number, h: number): string {
  const barT = h * 0.16;
  const cy = h / 2;
  const dotR = h * 0.09;
  const dotOffset = h * 0.28;
  const cx = w / 2;
  const circle = (ccx: number, ccy: number, r: number) => `M${ccx - r},${ccy} A${r},${r} 0 1,0 ${ccx + r},${ccy} A${r},${r} 0 1,0 ${ccx - r},${ccy} Z`;
  return [
    `M0,${cy - barT / 2} L${w},${cy - barT / 2} L${w},${cy + barT / 2} L0,${cy + barT / 2} Z`,
    circle(cx, cy - dotOffset, dotR),
    circle(cx, cy + dotOffset, dotR),
  ].join(" ");
}

// The "=" glyph - two stacked horizontal bars, as two disjoint rect subpaths in one "path" outline
// (same reasoning as divideSignOutlineD's own doc comment).
function equalsSignOutlineD(w: number, h: number): string {
  const t = h * 0.18;
  const gap = h * 0.22;
  const cy = h / 2;
  const topCenter = cy - gap / 2 - t / 2;
  const bottomCenter = cy + gap / 2 + t / 2;
  const bar = (c: number) => `M0,${c - t / 2} L${w},${c - t / 2} L${w},${c + t / 2} L0,${c + t / 2} Z`;
  return [bar(topCenter), bar(bottomCenter)].join(" ");
}

// The ">" glyph - a 4-point "dart": two outer corners (top-left, bottom-left) and the tip (right)
// trace the familiar chevron silhouette, and the 4th point (pulled back left from the tip, at
// vertical center) cuts a concave notch into it that gives the chevron its arm thickness - the same
// simple closed-quadrilateral construction as any other filled "arrow/chevron" icon (e.g. Font
// Awesome's solid chevrons). `mirrored` flips it into "<" by swapping which side the tip is on.
function chevronPoints(w: number, h: number, mirrored: boolean): [number, number][] {
  const insetX = w * 0.42; // how far the notch cuts back from the tip - controls arm thickness
  const outerX = mirrored ? w : 0;
  const tipX = mirrored ? 0 : w;
  const notchX = mirrored ? w - insetX : insetX;
  return [[outerX, 0], [tipX, h / 2], [outerX, h], [notchX, h / 2]];
}

// The "≥"/"≤" glyph - the same chevron as chevronPoints, compressed into the upper portion of the
// box, plus a single horizontal bar underneath with a small gap - two disjoint subpaths in one
// "path" outline (same technique as divideSignOutlineD/equalsSignOutlineD; "polygon" can only trace
// one closed ring, and the chevron and the bar are two separate fillable regions).
function chevronBarOutlineD(w: number, h: number, mirrored: boolean): string {
  const chevronH = h * 0.58;
  const gap = h * 0.1;
  const barT = h * 0.16;
  const insetX = w * 0.42;
  const outerX = mirrored ? w : 0;
  const tipX = mirrored ? 0 : w;
  const notchX = mirrored ? w - insetX : insetX;
  const chevron = `M${outerX},0 L${tipX},${(chevronH / 2).toFixed(2)} L${outerX},${chevronH.toFixed(2)} L${notchX.toFixed(2)},${(chevronH / 2).toFixed(2)} Z`;
  const barCy = chevronH + gap + barT / 2;
  const bar = `M0,${(barCy - barT / 2).toFixed(2)} L${w},${(barCy - barT / 2).toFixed(2)} L${w},${(barCy + barT / 2).toFixed(2)} L0,${(barCy + barT / 2).toFixed(2)} Z`;
  return `${chevron} ${bar}`;
}

// Two triangles meeting at the center - traced as one continuous polygon that touches itself at
// that shared vertex rather than crossing through it, which is what keeps this a clean bowtie
// silhouette instead of a self-intersecting mess.
function hourglassPolygonPoints(w: number, h: number): [number, number][] {
  return [[0, 0], [w, 0], [w / 2, h / 2], [w, h], [0, h], [w / 2, h / 2]];
}

// A rounded drop with a point at the top - two cubic beziers from the tip out to the sides of a
// circle, then one semicircular arc around the bottom connecting them.
function teardropOutlineD(w: number, h: number): string {
  const cx = w / 2;
  const r = Math.min(w, h * 0.76) / 2;
  const circleCy = h - r;
  return [
    `M${cx.toFixed(2)},0`,
    `C${(cx + r * 1.1).toFixed(2)},${(r * 0.3).toFixed(2)} ${(cx + r).toFixed(2)},${(circleCy - r * 0.7).toFixed(2)} ${(cx + r).toFixed(2)},${circleCy.toFixed(2)}`,
    `A${r.toFixed(2)},${r.toFixed(2)} 0 0,1 ${(cx - r).toFixed(2)},${circleCy.toFixed(2)}`,
    `C${(cx - r).toFixed(2)},${(circleCy - r * 0.7).toFixed(2)} ${(cx - r * 1.1).toFixed(2)},${(r * 0.3).toFixed(2)} ${cx.toFixed(2)},0`,
    `Z`,
  ].join(" ");
}

// The Material Design "bolt" icon's own point list (its 24x24 path M7,2v11h3v9l7-12h-4l4-8H7z,
// unrolled into absolute points and normalized to 0-1) - reused rather than hand-tuned since it's
// already a well-proportioned, widely-recognized lightning-bolt silhouette.
function lightningBoltPolygonPoints(w: number, h: number): [number, number][] {
  const fractions: [number, number][] = [
    [7 / 24, 2 / 24],
    [7 / 24, 13 / 24],
    [10 / 24, 13 / 24],
    [10 / 24, 22 / 24],
    [17 / 24, 10 / 24],
    [13 / 24, 10 / 24],
    [17 / 24, 2 / 24],
  ];
  return fractions.map(([fx, fy]) => [fx * w, fy * h]);
}

// A "D" - flat left edge, semicircular bulge to the right. The radius (w) and the flat edge's own
// half-length (h/2) are independent, so this isn't a true half-circle unless w === h/2, but it
// reads as one at any reasonable box proportions.
function halfCircleOutlineD(w: number, h: number): string {
  return `M0,0 L0,${h} A${w.toFixed(2)},${(h / 2).toFixed(2)} 0 0,0 0,0 Z`;
}

// A rectangle with a triangular notch cut inward from each half of the bottom edge - the
// swallowtail ribbon/banner look.
function bannerPolygonPoints(w: number, h: number): [number, number][] {
  return [[0, 0], [w, 0], [w, h], [w * 0.75, h * 0.7], [w * 0.5, h], [w * 0.25, h * 0.7], [0, h]];
}

// UML "Frame" notation - an outer rectangle plus a small pentagon "tab" (a rectangle with its
// top-right corner clipped) overlapping the top-left corner, where a frame's name/label would go.
// Two independent closed subpaths in one `d`, same multi-subpath convention the circuit symbols use.
function frameOutlineD(w: number, h: number): string {
  const tabW = w * 0.4;
  const tabH = h * 0.22;
  const notch = tabH * 0.4;
  return [
    `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
    `M0,0 L${tabW.toFixed(2)},0 L${tabW.toFixed(2)},${(tabH - notch).toFixed(2)} L${(tabW - notch).toFixed(2)},${tabH.toFixed(2)} L0,${tabH.toFixed(2)} Z`,
  ].join(" ");
}

// A rectangle with both its top and bottom edges replaced by a shallow S-curve - the flowchart
// "tape" symbol, mirroring document's own wavy-bottom-edge technique onto both edges.
function tapeOutlineD(w: number, h: number): string {
  const waveH = h * 0.12;
  return [
    `M0,${waveH.toFixed(2)}`,
    `C${(w * 0.25).toFixed(2)},0 ${(w * 0.75).toFixed(2)},${(waveH * 2).toFixed(2)} ${w},${waveH.toFixed(2)}`,
    `L${w},${(h - waveH).toFixed(2)}`,
    `C${(w * 0.75).toFixed(2)},${h} ${(w * 0.25).toFixed(2)},${(h - waveH * 2).toFixed(2)} 0,${(h - waveH).toFixed(2)}`,
    `Z`,
  ].join(" ");
}

// The flowchart "Display" symbol - a lens/eye silhouette (points at the left/right, curved top and
// bottom) rather than the true asymmetric display glyph, for a cleaner, more symmetric icon.
function displayOutlineD(w: number, h: number): string {
  return [
    `M0,${(h / 2).toFixed(2)}`,
    `C0,${(h * 0.2).toFixed(2)} ${(w * 0.2).toFixed(2)},0 ${(w * 0.4).toFixed(2)},0`,
    `L${(w * 0.7).toFixed(2)},0`,
    `C${(w * 0.9).toFixed(2)},0 ${w},${(h * 0.2).toFixed(2)} ${w},${(h / 2).toFixed(2)}`,
    `C${w},${(h * 0.8).toFixed(2)} ${(w * 0.9).toFixed(2)},${h} ${(w * 0.7).toFixed(2)},${h}`,
    `L${(w * 0.4).toFixed(2)},${h}`,
    `C${(w * 0.2).toFixed(2)},${h} 0,${(h * 0.8).toFixed(2)} 0,${(h / 2).toFixed(2)}`,
    `Z`,
  ].join(" ");
}

// Flowchart "Manual Input" - a rectangle whose top edge is a single upward slant instead of flat.
function manualInputPolygonPoints(w: number, h: number): [number, number][] {
  return [[0, h * 0.25], [w, 0], [w, h], [0, h]];
}

// ---- Graph plots (bar/line/pie/scatter charts, function plots) ----------------------------------
//
// All built from the "chart" ShapeOutline kind's independently-colored `parts` (see ChartPart's own
// doc comment) rather than one flat silhouette. A path built with `openPathD` below is always a
// single M-started, un-closed polyline - correct for "stroke"/"axis" roles (no fill happens either
// way) and for "marker" dots too (each is its own tiny closed loop via two arcs, so it fills as a
// solid dot regardless of the overall path being "open").

function openPathD(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

// A small filled dot at (cx, cy) - two arcs forming a closed circle, the same "two semicircle arcs"
// trick teardropOutlineD/halfCircleOutlineD already use, just closed into a full loop this time.
function dotPathD(cx: number, cy: number, r: number): string {
  return `M${(cx - r).toFixed(2)},${cy.toFixed(2)} A${r.toFixed(2)},${r.toFixed(2)} 0 1,0 ${(cx + r).toFixed(2)},${cy.toFixed(2)} A${r.toFixed(2)},${r.toFixed(2)} 0 1,0 ${(cx - r).toFixed(2)},${cy.toFixed(2)}`;
}

// A hollow ring as ONE fillable path - the outer circle and the inner circle wound in OPPOSITE
// directions (arc sweep flag 0 vs 1), which is what makes the default nonzero fill rule cancel the
// middle out. Two same-wound circles (what dotPathD twice would give) fill as a solid disc instead,
// since their winding numbers add rather than cancel. Built as a filled path rather than a stroked
// circle so it can share the "annotation" ChartPart role with the solid marker glyphs, which both
// renderers fill.
function ringPathD(cx: number, cy: number, rOuter: number, rInner: number): string {
  const outer = `M${(cx - rOuter).toFixed(2)},${cy.toFixed(2)} A${rOuter.toFixed(2)},${rOuter.toFixed(2)} 0 1,0 ${(cx + rOuter).toFixed(2)},${cy.toFixed(2)} A${rOuter.toFixed(2)},${rOuter.toFixed(2)} 0 1,0 ${(cx - rOuter).toFixed(2)},${cy.toFixed(2)} Z`;
  const inner = `M${(cx - rInner).toFixed(2)},${cy.toFixed(2)} A${rInner.toFixed(2)},${rInner.toFixed(2)} 0 1,1 ${(cx + rInner).toFixed(2)},${cy.toFixed(2)} A${rInner.toFixed(2)},${rInner.toFixed(2)} 0 1,1 ${(cx - rInner).toFixed(2)},${cy.toFixed(2)} Z`;
  return `${outer} ${inner}`;
}

// Formats a tick/data-value number for display: rounds to 2 decimal places (clears float noise like
// 1.4999999999998) then drops a trailing ".00"/trailing zero so whole numbers print as "5", not
// "5.00" - every axis/value label on every chart type goes through this one function.
function formatTick(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

// Shared x-axis layout for bar/line/scatter (pie has no axis at all): a baseline near the bottom,
// N evenly-spaced columns above it scaled to the series' own max value - `columnX`/`baselineY`/
// `valueToY` are exposed so each chart type only has to describe what it draws AT each column, not
// re-derive the shared layout. `max` is exposed too so callers can build matching Y-axis tick labels.
// Exported (not just used internally by barChartOutline/lineChartOutline/scatterPlotOutline below)
// so WhiteboardCanvas.tsx's own interactive drag handles (beginChartDataDrag - click a bar/point/dot
// and drag it to change that one value live) can compute the exact same column positions and
// pixels-per-unit scale the static render already used, rather than reimplementing this layout a
// second time and risking the two drifting apart.
export function chartColumnLayout(w: number, h: number, values: number[]) {
  const n = Math.max(1, values.length);
  const baselineY = h * 0.88;
  const topY = h * 0.08;
  const max = Math.max(...values, 1e-6);
  const columnX = (i: number) => (n === 1 ? w / 2 : (w * (i + 0.5)) / n);
  const valueToY = (v: number) => baselineY - (Math.max(0, v) / max) * (baselineY - topY);
  return { baselineY, topY, columnX, valueToY, max };
}

// The "0" / max-value labels every bar/line/scatter chart plants near its baseline and top - kept
// INSIDE the box (a couple px in from the left edge, not out past x=0) so they never bleed into
// whatever's placed next to the chart on the canvas - one shared helper so the three chart types
// can't drift out of sync on where/how this is placed.
function chartYAxisLabels(baselineY: number, topY: number, max: number): ChartLabel[] {
  return [
    { x: 2, y: baselineY - 6, text: "0", anchor: "start" },
    { x: 2, y: topY + 8, text: formatTick(max), anchor: "start" },
  ];
}

function barChartOutline(w: number, h: number, data?: number[], showLabels = true): { parts: ChartPart[]; labels: ChartLabel[] } {
  const values = data && data.length > 0 ? data : DEFAULT_CHART_DATA;
  const { baselineY, topY, columnX, valueToY, max } = chartColumnLayout(w, h, values);
  const barW = (w / values.length) * 0.6;
  const bars = values.map((v, i) => {
    const cx = columnX(i);
    const y = valueToY(v);
    return `M${(cx - barW / 2).toFixed(2)},${baselineY.toFixed(2)} L${(cx - barW / 2).toFixed(2)},${y.toFixed(2)} L${(cx + barW / 2).toFixed(2)},${y.toFixed(2)} L${(cx + barW / 2).toFixed(2)},${baselineY.toFixed(2)} Z`;
  });
  const parts: ChartPart[] = [
    { d: bars.join(" "), role: "fill" },
    { d: openPathD([{ x: 0, y: baselineY }, { x: w, y: baselineY }]), role: "axis" },
  ];
  if (!showLabels) return { parts, labels: [] };
  // Each bar's own value printed just above it, in addition to the shared Y-axis min/max - a bar
  // chart's bars are spaced out enough (unlike line/scatter's tighter points) that per-bar labels
  // stay readable rather than overlapping.
  const valueLabels: ChartLabel[] = values.map((v, i) => ({ x: columnX(i), y: Math.max(10, valueToY(v) - 6), text: formatTick(v), anchor: "middle" }));
  return { parts, labels: [...chartYAxisLabels(baselineY, topY, max), ...valueLabels] };
}

function lineChartOutline(w: number, h: number, data?: number[], showLabels = true): { parts: ChartPart[]; labels: ChartLabel[] } {
  const values = data && data.length > 0 ? data : DEFAULT_CHART_DATA;
  const { baselineY, topY, columnX, valueToY, max } = chartColumnLayout(w, h, values);
  const points = values.map((v, i) => ({ x: columnX(i), y: valueToY(v) }));
  const dotR = Math.min(w, h) * 0.02 + 2;
  const parts: ChartPart[] = [
    { d: openPathD(points), role: "stroke" },
    { d: points.map((p) => dotPathD(p.x, p.y, dotR)).join(" "), role: "marker" },
    { d: openPathD([{ x: 0, y: baselineY }, { x: w, y: baselineY }]), role: "axis" },
  ];
  return { parts, labels: showLabels ? chartYAxisLabels(baselineY, topY, max) : [] };
}

function scatterPlotOutline(w: number, h: number, data?: number[], showLabels = true): { parts: ChartPart[]; labels: ChartLabel[] } {
  const values = data && data.length > 0 ? data : DEFAULT_CHART_DATA;
  const { baselineY, topY, columnX, valueToY, max } = chartColumnLayout(w, h, values);
  const dotR = Math.min(w, h) * 0.025 + 2;
  const dots = values.map((v, i) => dotPathD(columnX(i), valueToY(v), dotR));
  const parts: ChartPart[] = [
    { d: dots.join(" "), role: "marker" },
    { d: openPathD([{ x: 0, y: baselineY }, { x: w, y: baselineY }]), role: "axis" },
  ];
  return { parts, labels: showLabels ? chartYAxisLabels(baselineY, topY, max) : [] };
}

// Bounds for WhiteboardNode.numberLineMax - the line always spans [-max, max]. Floor allows as
// tight a range as [-1, 1]; ceiling is arbitrary but generous (tick spacing auto-widens well before
// this via tickValuesByInterval, so even the largest range stays readable).
export const MIN_NUMBER_LINE_MAX = 1;
export const MAX_NUMBER_LINE_MAX = 1000;
export const DEFAULT_NUMBER_LINE_MAX = 10;

// A symmetric [-max, max] integer number line - a horizontal "stroke" line plus a short tick at
// every whole number (or a coarser multiple once max grows past what tickValuesByInterval's own
// MAX_INTERVAL_TICKS cap allows at a spacing of 1 - same auto-widening a function plot's own tick
// interval gets, so cranking the range up doesn't degrade into unreadable clutter), with the number
// itself labeled below when showLabels is on.
function numberLineOutline(w: number, h: number, showLabels = true, maxInput?: number): { parts: ChartPart[]; labels: ChartLabel[] } {
  const max = Math.max(MIN_NUMBER_LINE_MAX, Math.min(MAX_NUMBER_LINE_MAX, Math.round(maxInput ?? DEFAULT_NUMBER_LINE_MAX)));
  const min = -max;
  const midY = h * 0.4;
  const padX = w * 0.03;
  const mapX = (v: number) => padX + ((v - min) / (max - min)) * (w - padX * 2);
  const lines = [openPathD([{ x: padX, y: midY }, { x: w - padX, y: midY }])];
  const labels: ChartLabel[] = [];
  for (const v of tickValuesByInterval(min, max, 1)) {
    const x = mapX(v);
    lines.push(openPathD([{ x, y: midY - 5 }, { x, y: midY + 5 }]));
    if (showLabels) labels.push({ x, y: midY + 16, text: formatTick(v), anchor: "middle" });
  }
  return { parts: [{ d: lines.join(" "), role: "stroke" }], labels };
}

// Cycled for however many slices a pie chart has - distinct, readable hues rather than shades of one
// color, since (unlike bar/line/scatter) a pie chart's whole point is telling slices apart.
const PIE_PALETTE = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

function pieChartParts(w: number, h: number, data?: number[]): ChartPart[] {
  const raw = data && data.length > 0 ? data : DEFAULT_CHART_DATA;
  const values = raw.map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.42;
  if (total <= 0) return [];
  // A slice at (or past, from float error) the full circle can't be expressed as one wedge arc -
  // its start/end points coincide, which SVG treats as a zero-length (invisible) arc. Draw it as a
  // plain closed circle instead - visually identical to a "wedge" that happens to be the whole pie.
  const fullIndex = values.findIndex((v) => v / total >= 0.999999);
  if (fullIndex !== -1) {
    return [{ d: dotPathD(cx, cy, r), role: "slice", color: PIE_PALETTE[fullIndex % PIE_PALETTE.length] }];
  }
  let angle = -Math.PI / 2;
  const parts: ChartPart[] = [];
  values.forEach((v, i) => {
    if (v <= 0) return;
    const sweep = (v / total) * Math.PI * 2;
    const endAngle = angle + sweep;
    const x0 = cx + r * Math.cos(angle);
    const y0 = cy + r * Math.sin(angle);
    const x1 = cx + r * Math.cos(endAngle);
    const y1 = cy + r * Math.sin(endAngle);
    const largeArc = sweep > Math.PI ? 1 : 0;
    const d = `M${cx.toFixed(2)},${cy.toFixed(2)} L${x0.toFixed(2)},${y0.toFixed(2)} A${r.toFixed(2)},${r.toFixed(2)} 0 ${largeArc},1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
    parts.push({ d, role: "slice", color: PIE_PALETTE[i % PIE_PALETTE.length] });
    angle = endAngle;
  });
  return parts;
}

// The x-domain each function is sampled over - picked per-function so the interesting part of its
// shape (a full period for sine/cosine, a reasonable growth range for exponential, the defined
// x>=0 half for sqrt/logarithm) actually lands in view rather than an arbitrary fixed window.
const FUNCTION_PLOT_DOMAINS: Record<FunctionPlotType, [number, number]> = {
  linear: [-3, 3],
  quadratic: [-3, 3],
  cubic: [-2, 2],
  sine: [-2 * Math.PI, 2 * Math.PI],
  cosine: [-2 * Math.PI, 2 * Math.PI],
  exponential: [-2, 2],
  sqrt: [0, 6],
  logarithm: [0.1, 6],
  absolute: [-3, 3],
  normal: [-4, 4], // the standard normal's tails are already visually flat past +-4
};

export function evalPlotFunction(type: FunctionPlotType, x: number): number {
  switch (type) {
    case "linear":
      return x;
    case "quadratic":
      return x * x;
    case "cubic":
      return x * x * x;
    case "sine":
      return Math.sin(x);
    case "cosine":
      return Math.cos(x);
    case "exponential":
      return Math.exp(x);
    case "sqrt":
      return Math.sqrt(x);
    case "logarithm":
      return Math.log(x);
    case "absolute":
      return Math.abs(x);
    case "normal":
      // The standard normal PDF (mean 0, variance 1) - (1/sqrt(2*pi)) * e^(-x^2/2).
      return Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
  }
}

// Bounds for WhiteboardNode.plotDomainScale - multiplies FUNCTION_PLOT_DOMAINS' own window (see its
// doc comment). Kept well away from 0 (a near-zero domain has almost no visible curve left to show)
// and capped so the sampled curve doesn't get so stretched-thin relative to its sample count that it
// visibly facets.
export const MIN_PLOT_DOMAIN_SCALE = 0.25;
export const MAX_PLOT_DOMAIN_SCALE = 4;
export const DEFAULT_PLOT_DOMAIN_SCALE = 1;

// Bounds for WhiteboardNode.plotCycles (sine/cosine only - see its own doc comment for why these two
// get a direct cycle count instead of plotDomainScale's abstract multiplier). Matches the "wave"
// shapeType's own MIN/MAX_WAVE_CYCLES reasoning, just a smaller ceiling - a function plot's box is
// typically narrower than a dedicated wave shape, so cramming in as many as 60 would just look like
// visual noise well before that limit.
export const MIN_PLOT_CYCLES = 1;
export const MAX_PLOT_CYCLES = 20;
export const DEFAULT_PLOT_CYCLES = 2;

// Picks N "nice-ish" evenly-spaced tick positions between lo and hi INCLUSIVE of both ends (an axis
// reads oddly without its own start/end labeled) - the auto-interval fallback when no explicit
// WhiteboardNode.plotXTickInterval/plotYTickInterval is set.
function tickValues(lo: number, hi: number, count: number): number[] {
  if (count <= 1) return [lo];
  const step = (hi - lo) / (count - 1);
  return Array.from({ length: count }, (_, i) => lo + step * i);
}

// Safety cap on how many ticks a user-typed interval can ever produce - a very small interval over
// a wide (zoomed-out) domain would otherwise generate hundreds of overlapping, unreadable labels.
const MAX_INTERVAL_TICKS = 40;

// Ticks at every multiple of `interval` that falls within [lo, hi] - the explicit-interval
// counterpart to tickValues' fixed-count spacing (see WhiteboardNode.plotXTickInterval/
// plotYTickInterval's own doc comment for why this is two separate functions rather than one that
// takes "either a count or an interval").
function tickValuesByInterval(lo: number, hi: number, interval: number): number[] {
  if (!Number.isFinite(interval) || interval <= 0) return [];
  // A stale small interval left over from before the domain grew (e.g. Cycles turned up after the
  // interval was set for a much narrower window) would otherwise need far more than
  // MAX_INTERVAL_TICKS ticks to cover [lo, hi] - cutting the loop off at the cap then truncates
  // ticks from ONE end only, leaving the rest of the domain (and however much of the curve sits
  // there) completely unlabeled instead of just coarser. Widening the interval by a whole multiple
  // instead keeps ticks evenly spaced across the FULL domain, just less dense than asked for.
  const neededTicks = Math.floor((hi - lo) / interval) + 1;
  const effectiveInterval = neededTicks > MAX_INTERVAL_TICKS ? interval * Math.ceil(neededTicks / MAX_INTERVAL_TICKS) : interval;
  const start = Math.ceil(lo / effectiveInterval) * effectiveInterval;
  const ticks: number[] = [];
  for (let v = start; v <= hi + 1e-9; v += effectiveInterval) {
    ticks.push(Math.abs(v) < 1e-9 ? 0 : v);
  }
  return ticks;
}

// Picks tickValuesByInterval when the node has an explicit interval set, else falls back to the
// auto 5-evenly-spaced-ticks behavior.
function functionPlotTicks(lo: number, hi: number, intervalInput: number | undefined): number[] {
  return intervalInput && intervalInput > 0 ? tickValuesByInterval(lo, hi, intervalInput) : tickValues(lo, hi, 5);
}

// Sine/cosine get a direct "how many periods" domain (see WhiteboardNode.plotCycles's own doc
// comment); every other function keeps using plotDomainScale as a plain multiplier on its own
// FUNCTION_PLOT_DOMAINS window.
function functionPlotDomain(type: FunctionPlotType, domainScaleInput?: number, cyclesInput?: number): [number, number] {
  if (type === "sine" || type === "cosine") {
    const cycles = Math.max(MIN_PLOT_CYCLES, Math.min(MAX_PLOT_CYCLES, Math.round(cyclesInput ?? DEFAULT_PLOT_CYCLES)));
    return [-cycles * Math.PI, cycles * Math.PI];
  }
  const domainScale = Math.max(MIN_PLOT_DOMAIN_SCALE, Math.min(MAX_PLOT_DOMAIN_SCALE, domainScaleInput ?? DEFAULT_PLOT_DOMAIN_SCALE));
  const [baseMin, baseMax] = FUNCTION_PLOT_DOMAINS[type];
  return [baseMin * domainScale, baseMax * domainScale];
}

// Samples `type` densely across functionPlotDomain's window, auto-fits the sampled Y range to the
// box (so e.g. cubic's much taller range and sine's -1..1 range both fill the plot equally well
// instead of one looking cramped), draws x=0/y=0 axis lines wherever those actually fall inside the
// plotted window (falling back to the left/bottom edge when they don't, e.g. sqrt's domain never
// goes negative), optionally (`showGrid`) fills the whole plot with faint gridlines at every tick,
// and optionally (`showLabels`) labels both axes with their own tick values, positioned right beside
// wherever the axis line ITSELF actually sits - not the box edge - so a tick reads as "this number
// belongs to this line" the way a real graph's does. The two toggles are independent of each other.
function functionPlotOutline(
  w: number,
  h: number,
  type: FunctionPlotType,
  domainScaleInput?: number,
  xTickInterval?: number,
  yTickInterval?: number,
  showLabels = true,
  cyclesInput?: number,
  showGrid = false
): { parts: ChartPart[]; labels: ChartLabel[] } {
  const [xMin, xMax] = functionPlotDomain(type, domainScaleInput, cyclesInput);
  // More samples for a wider (zoomed-out) domain, same "keep point density roughly constant"
  // reasoning waveOutlineD's own cycles-scaled sample count uses.
  const domainScale = (xMax - xMin) / (FUNCTION_PLOT_DOMAINS[type][1] - FUNCTION_PLOT_DOMAINS[type][0] || 1);
  const samples = Math.round(80 * Math.max(1, domainScale));
  const raw: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = xMin + ((xMax - xMin) * i) / samples;
    raw.push({ x, y: evalPlotFunction(type, x) });
  }
  const yMin = Math.min(...raw.map((p) => p.y));
  const yMax = Math.max(...raw.map((p) => p.y));
  const yRange = Math.max(yMax - yMin, 1e-6);
  const padX = w * 0.08;
  const padY = h * 0.08;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;
  const mapX = (x: number) => padX + ((x - xMin) / (xMax - xMin)) * plotW;
  const mapY = (y: number) => padY + plotH - ((y - yMin) / yRange) * plotH;
  const curve = raw.map((p) => ({ x: mapX(p.x), y: mapY(p.y) }));
  const yAxisY = yMin <= 0 && yMax >= 0 ? mapY(0) : padY + plotH;
  const xAxisX = xMin <= 0 && xMax >= 0 ? mapX(0) : padX;
  const parts: ChartPart[] = [];
  // Grid drawn BEFORE the axis/curve so it always sits visually behind them, not on top.
  if (showGrid) {
    const gridXTicks = functionPlotTicks(xMin, xMax, xTickInterval);
    const gridYTicks = functionPlotTicks(yMin, yMax, yTickInterval);
    const gridLines = [
      ...gridXTicks.map((tx) => openPathD([{ x: mapX(tx), y: padY }, { x: mapX(tx), y: padY + plotH }])),
      ...gridYTicks.map((ty) => openPathD([{ x: padX, y: mapY(ty) }, { x: padX + plotW, y: mapY(ty) }])),
    ];
    if (gridLines.length > 0) parts.push({ d: gridLines.join(" "), role: "grid" });
  }
  parts.push(
    { d: openPathD(curve), role: "stroke" },
    {
      d: [
        openPathD([{ x: padX, y: yAxisY }, { x: padX + plotW, y: yAxisY }]),
        openPathD([{ x: xAxisX, y: padY }, { x: xAxisX, y: padY + plotH }]),
      ].join(" "),
      role: "axis",
    }
  );
  if (!showLabels) return { parts, labels: [] };
  // Each axis's numbers sit on whichever side of its own line has room, flipping to the other side
  // rather than running off the box when the line itself sits near an edge (e.g. sqrt/logarithm,
  // whose domain never goes negative, put the y-axis right at the plot's left edge).
  const xLabelY = yAxisY < padY + plotH - 20 ? yAxisY + 12 : yAxisY - 8;
  const yLabelNearLeft = xAxisX > padX + 20;
  const yLabelX = yLabelNearLeft ? xAxisX - 4 : xAxisX + 4;
  const yLabelAnchor: ChartLabel["anchor"] = yLabelNearLeft ? "end" : "start";
  // Both axes crossing through the plotted window means their "0" ticks land on the exact same
  // point (the origin) - keep only the y-axis's copy so the origin isn't double-labeled.
  const originVisible = xMin <= 0 && xMax >= 0 && yMin <= 0 && yMax >= 0;
  const xTicks = functionPlotTicks(xMin, xMax, xTickInterval).filter((t) => !originVisible || Math.abs(t) > 1e-9);
  const yTicks = functionPlotTicks(yMin, yMax, yTickInterval);
  const labels: ChartLabel[] = [
    ...xTicks.map((tx) => ({ x: mapX(tx), y: Math.max(2, Math.min(xLabelY, h - 2)), text: formatTick(tx), anchor: "middle" as const })),
    ...yTicks.map((ty) => ({ x: Math.max(2, Math.min(yLabelX, w - 2)), y: mapY(ty), text: formatTick(ty), anchor: yLabelAnchor })),
  ];
  return { parts, labels };
}

// ---- "graph" shape - a user-typed formula, plotted over an explicit x/y window --------------------
//
// Unlike "functionPlot"'s curated FunctionPlotType preset list, "graph" lets a user type any formula
// in terms of `x` (WhiteboardNode.graphExpression). Compiling that into something callable needs
// EITHER `eval`/`new Function` (executes arbitrary JS - can reach `window`/`document`, spin forever,
// or otherwise do anything JS can do, for what should only ever be an arithmetic formula) OR a real
// (if tiny) parser whose grammar makes anything beyond arithmetic simply inexpressible. This is the
// latter: a hand-rolled tokenizer + recursive-descent parser producing a plain `(x: number) => number`
// closure, restricted to number literals, `x`, the constants below, the four arithmetic operators
// (+ - * / %), `^` (power, right-associative), parentheses, implicit multiplication (e.g. "2x",
// "3sin(x)", "x(x+1)"), and calls into the fixed GRAPH_FUNCTIONS table - there is no way to express a
// loop, a statement, or any identifier/property access outside that fixed table.

const GRAPH_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  abs: Math.abs,
  sign: Math.sign,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};

const GRAPH_CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type GraphToken = { type: "num"; value: number } | { type: "ident"; value: string } | { type: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" } | { type: "lparen" } | { type: "rparen" } | { type: "comma" };

function tokenizeGraphExpression(src: string): GraphToken[] {
  const tokens: GraphToken[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const numStr = src.slice(i, j);
      if (!/^\d*\.?\d+$|^\d+\.?$/.test(numStr)) throw new Error(`Invalid number "${numStr}"`);
      tokens.push({ type: "num", value: Number(numStr) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z_0-9]/.test(src[j])) j++;
      tokens.push({ type: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "%" || c === "^") {
      tokens.push({ type: "op", value: c });
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }
    if (c === ",") {
      tokens.push({ type: "comma" });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${c}"`);
  }
  return tokens;
}

// Recursive-descent parser over GraphToken[] - standard precedence climbing (+/- lowest, then
// implicit-and-explicit */÷/%, then unary +/-, then ^ highest, right-associative). Each production
// returns a closure directly (rather than building an intermediate AST node type) since nothing here
// needs to inspect the parsed structure afterward - only ever call it with a value for `x`.
function parseGraphExpression(tokens: GraphToken[]): (x: number) => number {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  // Reads the operator character off a token if (and only if) it IS one - "" (a value that matches
  // none of the operator comparisons below) otherwise. Every caller below compares this plain string
  // return value instead of re-narrowing the GraphToken union's "op" variant itself repeatedly -
  // simpler, and safe under strict-null-checks without needing a fresh type guard per call site
  // (TypeScript can't assume two separate `peek()` calls return the same token, so narrowing done on
  // one call's result doesn't carry over to a later independent call).
  const opValue = (tok: GraphToken | undefined): string => (tok && tok.type === "op" ? tok.value : "");
  const startsFactor = (tok: GraphToken | undefined): boolean => !!tok && (tok.type === "num" || tok.type === "ident" || tok.type === "lparen");

  function parseExpression(): (x: number) => number {
    let left = parseTerm();
    for (let op = opValue(peek()); op === "+" || op === "-"; op = opValue(peek())) {
      next();
      const right = parseTerm();
      const prevLeft = left;
      left = op === "+" ? (x) => prevLeft(x) + right(x) : (x) => prevLeft(x) - right(x);
    }
    return left;
  }
  function parseTerm(): (x: number) => number {
    let left = parseUnary();
    for (;;) {
      const tok = peek();
      const op = opValue(tok);
      if (op === "*" || op === "/" || op === "%") {
        next();
        const right = parseUnary();
        const prevLeft = left;
        if (op === "*") left = (x) => prevLeft(x) * right(x);
        else if (op === "/") left = (x) => prevLeft(x) / right(x);
        else left = (x) => prevLeft(x) % right(x);
      } else if (startsFactor(tok)) {
        // "2x", "3sin(x)", "x(x+1)" - implicit multiplication, the way a real graphing
        // calculator/textbook reads a factor immediately following another with no operator between.
        const right = parseUnary();
        const prevLeft = left;
        left = (x) => prevLeft(x) * right(x);
      } else {
        break;
      }
    }
    return left;
  }
  function parseUnary(): (x: number) => number {
    const op = opValue(peek());
    if (op === "-" || op === "+") {
      next();
      const operand = parseUnary();
      return op === "-" ? (x) => -operand(x) : operand;
    }
    return parsePower();
  }
  function parsePower(): (x: number) => number {
    const base = parsePrimary();
    if (opValue(peek()) === "^") {
      next();
      const exponent = parseUnary(); // right-associative: x^2^3 === x^(2^3)
      return (x) => Math.pow(base(x), exponent(x));
    }
    return base;
  }
  function parsePrimary(): (x: number) => number {
    const tok = peek();
    if (!tok) throw new Error("Unexpected end of expression");
    if (tok.type === "num") {
      next();
      const v = tok.value;
      return () => v;
    }
    if (tok.type === "lparen") {
      next();
      const inner = parseExpression();
      const closeTok = peek();
      if (!closeTok || closeTok.type !== "rparen") throw new Error('Expected ")"');
      next();
      return inner;
    }
    if (tok.type === "ident") {
      next();
      const name = tok.value.toLowerCase();
      const afterName = peek();
      // Only treat "name(" as a function call when `name` is actually a known function - otherwise
      // (e.g. "x(x+1)") the "(" starts an implicit-multiplication factor instead (see parseTerm).
      if (afterName && afterName.type === "lparen" && GRAPH_FUNCTIONS[name]) {
        next();
        const args: ((x: number) => number)[] = [];
        const maybeCloseTok = peek();
        if (!maybeCloseTok || maybeCloseTok.type !== "rparen") {
          args.push(parseExpression());
          for (let sep = peek(); sep && sep.type === "comma"; sep = peek()) {
            next();
            args.push(parseExpression());
          }
        }
        const closeTok = peek();
        if (!closeTok || closeTok.type !== "rparen") throw new Error('Expected ")"');
        next();
        const fn = GRAPH_FUNCTIONS[name];
        return (x) => fn(...args.map((a) => a(x)));
      }
      if (name === "x") return (x) => x;
      if (name in GRAPH_CONSTANTS) {
        const v = GRAPH_CONSTANTS[name];
        return () => v;
      }
      throw new Error(`Unknown identifier "${tok.value}"`);
    }
    throw new Error("Unexpected token");
  }

  if (tokens.length === 0) throw new Error("Empty expression");
  const result = parseExpression();
  if (pos !== tokens.length) throw new Error("Unexpected trailing input");
  return result;
}

// The one entry point every caller (graphOutline below, WhiteboardStylePanel.tsx's own inline error
// display) uses to turn WhiteboardNode.graphExpression's raw text into something plottable - never
// throws, always returns either a working evaluator or a human-readable parse error message.
export type CompiledGraphExpression = { evaluate: (x: number) => number; error: null } | { evaluate: null; error: string };

export function compileGraphExpression(source: string): CompiledGraphExpression {
  try {
    const fn = parseGraphExpression(tokenizeGraphExpression(source.trim() === "" ? "0" : source));
    return { evaluate: fn, error: null };
  } catch (err) {
    return { evaluate: null, error: err instanceof Error ? err.message : "Invalid expression" };
  }
}

// Bounds/defaults for WhiteboardNode.graphXMin/graphXMax/graphYMin/graphYMax - generous enough for
// almost any diagram (a whiteboard, not a scientific plotting tool) while keeping the sampled domain
// from growing so wide the curve degrades into a nearly-straight-line-per-sample facet at
// GRAPH_SAMPLE_COUNT's fixed resolution.
export const MIN_GRAPH_DOMAIN = -1000;
export const MAX_GRAPH_DOMAIN = 1000;
export const DEFAULT_GRAPH_EXPRESSION = "sin(x)";
export const DEFAULT_GRAPH_X_MIN = -10;
export const DEFAULT_GRAPH_X_MAX = 10;
export const DEFAULT_GRAPH_Y_MIN = -10;
export const DEFAULT_GRAPH_Y_MAX = 10;
const GRAPH_SAMPLE_COUNT = 300;

// Robust (percentile-based, not plain min/max) auto y-range for a sampled curve - a single sample
// near a real asymptote (tan(x), 1/x, ln(x) as x->0, ...) can be enormous despite being finite, and a
// plain min/max fit would let that one point flatten the entire rest of the curve to a hairline.
// Clips to the 2nd-98th percentile instead, then pads it a bit so the curve doesn't touch the box's
// own top/bottom edge.
function robustGraphYRange(values: number[]): [number, number] {
  if (values.length === 0) return [-1, 1];
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1))))];
  const lo = at(0.02);
  const hi = at(0.98);
  if (hi - lo < 1e-9) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.1;
  return [lo - pad, hi + pad];
}

// The screen<->data-space mapping for a "graph" node's own plot area - shared by graphOutline
// (building every static SVG path) and WhiteboardCanvas.tsx's own live interactive point handles
// (rendering WhiteboardNode.graphPoints' current pixel position, and inverse-mapping a drag/
// double-click pixel back into data-space) so both always agree on exactly where a given data
// point sits, with no risk of two independent reimplementations of the same formula drifting apart.
export function graphCoordinateMapper(w: number, h: number, xMin: number, xMax: number, yMin: number, yMax: number) {
  const padX = w * 0.08;
  const padY = h * 0.08;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const mapX = (x: number) => padX + ((x - xMin) / xRange) * plotW;
  const mapY = (y: number) => padY + plotH - ((y - yMin) / yRange) * plotH;
  const invMapX = (px: number) => xMin + ((px - padX) / plotW) * xRange;
  const invMapY = (py: number) => yMin + (1 - (py - padY) / plotH) * yRange;
  return { padX, padY, plotW, plotH, mapX, mapY, invMapX, invMapY };
}

// The x/y-range WhiteboardCanvas.tsx's own manual-point handles resolve a "graph" node's axes to -
// deliberately NOT the same as graphOutline's own y-range (which, with no explicit graphYMin/
// graphYMax, auto-fits to the sampled FORMULA curve's values, expensive to recompute on every
// pointermove of a point drag and moot anyway for the primary manual-plotting use case: a "Blank
// Graph" has no formula to sample at all). Manual points instead always resolve against the
// explicit graphYMin/graphYMax, or DEFAULT_GRAPH_Y_MIN/MAX absent those - exactly what graphOutline
// ALSO falls back to whenever there's no formula curve to auto-fit from (see its own hasExpression
// branch below), so the two stay pixel-consistent for the common "blank graph, manual points only"
// case. Combining manual points with an auto-fit-Y formula curve at the same time is the one
// scenario these can visibly disagree in - turning Auto Y range off (or using Blank Graph, which
// never has a curve to auto-fit from) keeps them exactly in sync.
export function resolveGraphAxisRange(node: { graphXMin?: number; graphXMax?: number; graphYMin?: number; graphYMax?: number }): { xMin: number; xMax: number; yMin: number; yMax: number } {
  let xMin = node.graphXMin ?? DEFAULT_GRAPH_X_MIN;
  let xMax = node.graphXMax ?? DEFAULT_GRAPH_X_MAX;
  if (xMax <= xMin) xMax = xMin + 1;
  let yMin = node.graphYMin ?? DEFAULT_GRAPH_Y_MIN;
  let yMax = node.graphYMax ?? DEFAULT_GRAPH_Y_MAX;
  if (yMax <= yMin) yMax = yMin + 1;
  return { xMin, xMax, yMin, yMax };
}

// Samples the compiled expression (if any - an empty/blank `expression`, the "Blank Graph" preset's
// own starting state, draws no formula curve at all, just axes/grid/manual points) densely across
// [xMin, xMax], auto-fitting (or, if explicitly set, using) the y-range, then traces the curve as
// one or more SEPARATE subpaths - split wherever a sample is non-finite (NaN/Infinity - e.g. sqrt of
// a negative number, log of zero) or jumps by more than a few multiples of the plotted y-range
// between consecutive samples (a real discontinuity/asymptote, e.g. tan(x) or 1/x crossing x=0) - a
// single path straight through either case would draw a spurious near-vertical line connecting the
// two sides, which isn't part of the actual graph. `manualPoints` (WhiteboardNode.graphPoints, data-
// space) draw as their OWN additional straight-segment polyline (2+ points) or a single dot (exactly
// 1) - independent of, and layered on top of, the formula curve. Otherwise mirrors
// functionPlotOutline's own axis-line/grid/tick-label layout exactly.
function graphOutline(
  w: number,
  h: number,
  expression: string,
  xMinInput: number | undefined,
  xMaxInput: number | undefined,
  yMinInput: number | undefined,
  yMaxInput: number | undefined,
  xTickInterval: number | undefined,
  yTickInterval: number | undefined,
  showLabels = true,
  showGrid = true,
  manualPoints: { x: number; y: number }[] = []
): { parts: ChartPart[]; labels: ChartLabel[] } {
  let xMin = xMinInput ?? DEFAULT_GRAPH_X_MIN;
  let xMax = xMaxInput ?? DEFAULT_GRAPH_X_MAX;
  if (xMax <= xMin) xMax = xMin + 1;
  const hasExpression = expression.trim() !== "";
  const compiled = hasExpression ? compileGraphExpression(expression) : null;
  const raw: { x: number; y: number }[] = [];
  if (hasExpression) {
    for (let i = 0; i <= GRAPH_SAMPLE_COUNT; i++) {
      const x = xMin + ((xMax - xMin) * i) / GRAPH_SAMPLE_COUNT;
      const y = compiled?.evaluate ? compiled.evaluate(x) : NaN;
      raw.push({ x, y: Number.isFinite(y) ? y : NaN });
    }
  }
  const finiteYs = [...raw.map((p) => p.y).filter((y) => Number.isFinite(y)), ...manualPoints.map((p) => p.y)];
  let yMin: number;
  let yMax: number;
  if (hasExpression) {
    const [autoYMin, autoYMax] = robustGraphYRange(finiteYs);
    yMin = yMinInput ?? autoYMin;
    yMax = yMaxInput ?? autoYMax;
  } else {
    yMin = yMinInput ?? DEFAULT_GRAPH_Y_MIN;
    yMax = yMaxInput ?? DEFAULT_GRAPH_Y_MAX;
  }
  if (yMax <= yMin) yMax = yMin + 1;
  const yRange = yMax - yMin;
  const { padX, padY, plotW, plotH, mapX, mapY } = graphCoordinateMapper(w, h, xMin, xMax, yMin, yMax);

  let curveD = "";
  if (hasExpression) {
    const jumpThreshold = yRange * 2.5;
    const subpaths: { x: number; y: number }[][] = [];
    let current: { x: number; y: number }[] = [];
    let prevRawY: number | null = null;
    for (const p of raw) {
      if (!Number.isFinite(p.y)) {
        if (current.length > 1) subpaths.push(current);
        current = [];
        prevRawY = null;
        continue;
      }
      if (prevRawY !== null && Math.abs(p.y - prevRawY) > jumpThreshold) {
        if (current.length > 1) subpaths.push(current);
        current = [];
      }
      const clampedY = Math.max(yMin - yRange, Math.min(yMax + yRange, p.y));
      current.push({ x: mapX(p.x), y: mapY(clampedY) });
      prevRawY = p.y;
    }
    if (current.length > 1) subpaths.push(current);
    curveD = subpaths.map((pts) => openPathD(pts)).join(" ");
  }

  const yAxisY = yMin <= 0 && yMax >= 0 ? mapY(0) : padY + plotH;
  const xAxisX = xMin <= 0 && xMax >= 0 ? mapX(0) : padX;
  const xTicksFor = (interval: number | undefined, lo: number, hi: number) => (interval && interval > 0 ? tickValuesByInterval(lo, hi, interval) : tickValues(lo, hi, 5));
  const parts: ChartPart[] = [];
  if (showGrid) {
    const gridXTicks = xTicksFor(xTickInterval, xMin, xMax);
    const gridYTicks = xTicksFor(yTickInterval, yMin, yMax);
    const gridLines = [
      ...gridXTicks.map((tx) => openPathD([{ x: mapX(tx), y: padY }, { x: mapX(tx), y: padY + plotH }])),
      ...gridYTicks.map((ty) => openPathD([{ x: padX, y: mapY(ty) }, { x: padX + plotW, y: mapY(ty) }])),
    ];
    if (gridLines.length > 0) parts.push({ d: gridLines.join(" "), role: "grid" });
  }
  if (curveD) parts.push({ d: curveD, role: "stroke" });
  if (manualPoints.length >= 2) {
    parts.push({ d: openPathD(manualPoints.map((p) => ({ x: mapX(p.x), y: mapY(p.y) }))), role: "stroke" });
  } else if (manualPoints.length === 1) {
    parts.push({ d: dotPathD(mapX(manualPoints[0].x), mapY(manualPoints[0].y), 3.5), role: "marker" });
  }
  parts.push({
    d: [
      openPathD([{ x: padX, y: yAxisY }, { x: padX + plotW, y: yAxisY }]),
      openPathD([{ x: xAxisX, y: padY }, { x: xAxisX, y: padY + plotH }]),
    ].join(" "),
    role: "axis",
  });
  if (!showLabels) return { parts, labels: [] };
  const xLabelY = yAxisY < padY + plotH - 20 ? yAxisY + 12 : yAxisY - 8;
  const yLabelNearLeft = xAxisX > padX + 20;
  const yLabelX = yLabelNearLeft ? xAxisX - 4 : xAxisX + 4;
  const yLabelAnchor: ChartLabel["anchor"] = yLabelNearLeft ? "end" : "start";
  const originVisible = xMin <= 0 && xMax >= 0 && yMin <= 0 && yMax >= 0;
  const xTicks = xTicksFor(xTickInterval, xMin, xMax).filter((t) => !originVisible || Math.abs(t) > 1e-9);
  const yTicks = xTicksFor(yTickInterval, yMin, yMax);
  const labels: ChartLabel[] = [
    ...xTicks.map((tx) => ({ x: mapX(tx), y: Math.max(2, Math.min(xLabelY, h - 2)), text: formatTick(tx), anchor: "middle" as const })),
    ...yTicks.map((ty) => ({ x: Math.max(2, Math.min(yLabelX, w - 2)), y: mapY(ty), text: formatTick(ty), anchor: yLabelAnchor })),
  ];
  return { parts, labels };
}

// ---- Multi-series / waterfall -------------------------------------------------------------------

// Peak-preserving decimation: reduces a trace to at most ~2 points per horizontal pixel by splitting
// it into `buckets` equal spans and emitting each span's MINIMUM and MAXIMUM sample (in whichever
// order they occur), rather than every Nth sample.
//
// Stride sampling would be simpler and is what most naive plotters do, but it is wrong for exactly
// the data this shape exists for: a spectral line one or two samples wide sits BETWEEN two strides
// and disappears entirely, silently deleting the feature a spectroscopist is looking at. Emitting
// each bucket's min and max instead reproduces the drawn envelope pixel-for-pixel - a peak that
// reaches a given height still reaches it - while capping the vertex count at roughly the plot's own
// pixel width no matter how dense the source data is. That cap is what keeps a 60-trace x 20,000-
// point figure interactive: without it the SVG path strings alone would be tens of megabytes per
// rebuild.
//
// Returns the ORIGINAL array when it is already short enough, so the common small-data case pays
// nothing (not even a copy).
function decimateSeries(values: number[], buckets: number): number[] | { i: number; v: number }[] {
  if (buckets <= 0 || values.length <= buckets * 2) return values;
  const out: { i: number; v: number }[] = [];
  const span = values.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * span);
    const end = Math.min(values.length, Math.floor((b + 1) * span));
    if (end <= start) continue;
    let minI = start;
    let maxI = start;
    for (let i = start + 1; i < end; i++) {
      if (values[i] < values[minI]) minI = i;
      if (values[i] > values[maxI]) maxI = i;
    }
    // Emitted in the order they actually occur in the source, so the drawn line still travels in the
    // direction the data does within the bucket rather than zigzagging backwards.
    if (minI <= maxI) out.push({ i: minI, v: values[minI] }, { i: maxI, v: values[maxI] });
    else out.push({ i: maxI, v: values[maxI] }, { i: minI, v: values[minI] });
  }
  return out;
}

// A stack of N independently-colored traces over one shared x-axis - see WhiteboardNode.seriesData.
// Trace 0 draws at the BOTTOM of the stack (baseline offset 0) and each subsequent trace is lifted
// another `offsetStep` in data units, matching how a stacked-spectra figure is conventionally read
// (earliest/lowest parameter value at the bottom). With seriesOffset 0 every trace shares one
// baseline and this degenerates into a plain overlaid multi-series line chart, deliberately - see
// that field's own doc comment.
function waterfallOutline(
  w: number,
  h: number,
  resolved: ResolvedSeries,
  opts: {
    showLabels: boolean;
    showGrid: boolean;
    fillUnder: boolean;
    showBaselines: boolean;
    showLegend: boolean;
    xTickInterval?: number;
    yTickInterval?: number;
    strokeWidth: number;
    fontSize: number;
  }
): { parts: ChartPart[]; labels: ChartLabel[] } {
  const { series, colors, labels: seriesNames, xMin, xMax, yMin, offsetStep, stackedYMin, stackedYMax } = resolved;
  const { padX, padY, plotW, plotH, mapX, mapY } = graphCoordinateMapper(w, h, xMin, xMax, stackedYMin, stackedYMax);

  // One bucket per ~half pixel of plot width - the Nyquist-ish limit past which extra vertices are
  // invisible at the current on-screen size but still cost full path-string and rasterization time.
  const buckets = Math.max(16, Math.round(plotW * 2));

  // How many ticks actually FIT, rather than a fixed five. A stacked plot's numbers are wide (the y
  // axis sums every trace beneath it; the x axis carries real measurement units), so five of them
  // across a narrow panel overlap into an unreadable smear - which is precisely the size a panel
  // ends up at once several are arranged into a subplot grid. Width is estimated from the widest
  // ENDPOINT label, since the extremes are the longest numbers in a linear tick sequence.
  const widestXLabel = Math.max(estimatedTextWidth(formatTick(xMin), opts.fontSize), estimatedTextWidth(formatTick(xMax), opts.fontSize));
  const maxXTicks = Math.max(2, Math.min(5, Math.floor(plotW / (widestXLabel + 10))));
  const maxYTicks = Math.max(2, Math.min(5, Math.floor(plotH / (opts.fontSize * 1.8))));
  const xTicksFor = () => (opts.xTickInterval && opts.xTickInterval > 0 ? tickValuesByInterval(xMin, xMax, opts.xTickInterval) : tickValues(xMin, xMax, maxXTicks));
  const yTicksFor = () =>
    opts.yTickInterval && opts.yTickInterval > 0 ? tickValuesByInterval(stackedYMin, stackedYMax, opts.yTickInterval) : tickValues(stackedYMin, stackedYMax, maxYTicks);

  const parts: ChartPart[] = [];
  if (opts.showGrid) {
    const gridX = xTicksFor();
    const gridY = yTicksFor();
    const gridLines = [
      ...gridX.map((tx) => openPathD([{ x: mapX(tx), y: padY }, { x: mapX(tx), y: padY + plotH }])),
      ...gridY.map((ty) => openPathD([{ x: padX, y: mapY(ty) }, { x: padX + plotW, y: mapY(ty) }])),
    ];
    if (gridLines.length > 0) parts.push({ d: gridLines.join(" "), role: "grid" });
  }

  if (opts.showBaselines) {
    const baselines = series.map((_, s) => openPathD([{ x: padX, y: mapY(yMin + offsetStep * s) }, { x: padX + plotW, y: mapY(yMin + offsetStep * s) }]));
    if (baselines.length > 0) parts.push({ d: baselines.join(" "), role: "grid" });
  }

  // Drawn back-to-front (topmost trace LAST) so a higher trace overlaps the one behind it, the way a
  // real stacked figure occludes - with negative-space overlap that ordering is what makes the stack
  // read as depth rather than as a tangle.
  for (let s = 0; s < series.length; s++) {
    const trace = series[s];
    const lift = offsetStep * s;
    const denom = trace.length > 1 ? trace.length - 1 : 1;
    const decimated = decimateSeries(trace, buckets);
    const pts: { x: number; y: number }[] =
      typeof decimated[0] === "number"
        ? (decimated as number[]).map((v, i) => ({ x: mapX(xMin + ((xMax - xMin) * i) / denom), y: mapY(v + lift) }))
        : (decimated as { i: number; v: number }[]).map((p) => ({ x: mapX(xMin + ((xMax - xMin) * p.i) / denom), y: mapY(p.v + lift) }));
    if (pts.length === 0) continue;
    if (opts.fillUnder) {
      const base = mapY(yMin + lift);
      parts.push({
        d: `${openPathD(pts)} L${pts[pts.length - 1].x.toFixed(2)},${base.toFixed(2)} L${pts[0].x.toFixed(2)},${base.toFixed(2)} Z`,
        role: "seriesFill",
        color: colors[s],
      });
    }
    parts.push({ d: openPathD(pts), role: "series", color: colors[s], width: opts.strokeWidth });
  }

  parts.push({
    d: [
      openPathD([{ x: padX, y: padY + plotH }, { x: padX + plotW, y: padY + plotH }]),
      openPathD([{ x: padX, y: padY }, { x: padX, y: padY + plotH }]),
    ].join(" "),
    role: "axis",
  });

  const labels: ChartLabel[] = [];
  if (opts.showLabels) {
    const xTicks = xTicksFor();
    const yTicks = yTicksFor();
    labels.push(
      ...xTicks.map((tx) => ({ x: mapX(tx), y: Math.min(h - 2, padY + plotH + 12), text: formatTick(tx), anchor: "middle" as const })),
      ...yTicks.map((ty) => ({ x: Math.max(2, padX - 4), y: mapY(ty), text: formatTick(ty), anchor: "end" as const }))
    );
  }
  if (opts.showLegend) {
    // Top-right of the plot area, one row per trace in its own trace color - the swatch IS the
    // colored text rather than a separate square, which keeps a many-entry legend from eating the
    // plot area it sits on top of.
    const rowH = 12;
    labels.push(
      ...series.map((_, s) => ({
        x: padX + plotW - 4,
        y: padY + 8 + s * rowH,
        text: seriesNames[s],
        anchor: "end" as const,
        color: colors[s],
        fontScale: 0.85,
      }))
    );
  }
  return { parts, labels };
}

// ---- Chart titles and data-space annotations ----------------------------------------------------

// How much room each title caption reserves around the plot box, as a multiple of the node's own
// fontSize - a caption needs its own line height plus a little breathing room from the tick numbers
// it sits outside of.
const TITLE_MARGIN_SCALE = 1.7;
const CHART_TITLE_FONT_SCALE = 1.15;

// Rough width of a string at a given font size. There is no text metrics API available here (this
// module is pure and runs with no canvas or DOM), so this approximates with an average glyph
// advance. 0.58em is a deliberate slight OVER-estimate for the digit-and-decimal-point strings this
// is used on, since reserving a few pixels too many merely shifts the plot over a touch, while
// under-reserving clips the label - the failure this exists to prevent.
function estimatedTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.58;
}

// A waterfall's y tick numbers are the stacked totals of every trace beneath them, so they run much
// larger (and wider) than a normal plot's - a stack of 18 traces peaking at 100 labels its top tick
// "1090.83". Those labels are drawn to the LEFT of the axis, so without a gutter sized to the widest
// of them they simply run off the node's left edge and get clipped, which is exactly what happened
// before this existed. Capped at 40% of the width so a pathological label can't squeeze the plot
// itself down to nothing.
function waterfallYTickGutter(resolved: ResolvedSeries, fontSize: number, yTickInterval?: number): number {
  const ticks =
    yTickInterval && yTickInterval > 0 ? tickValuesByInterval(resolved.stackedYMin, resolved.stackedYMax, yTickInterval) : tickValues(resolved.stackedYMin, resolved.stackedYMax, 5);
  if (ticks.length === 0) return 0;
  const widest = Math.max(...ticks.map((t) => estimatedTextWidth(formatTick(t), fontSize)));
  return widest + 6;
}

// Every margin a chart reserves around its own plot box, and the caption labels that live in them.
// The ONE place this is computed - shapeOutlineFor (laying the plot out) and
// annotationCoordinateMapper (placing draggable handles over it) both call this rather than deriving
// margins separately, since a disagreement between them shows up as handles that don't sit on the
// data they belong to.
//
// Returns all-zero margins and no labels for a chart with no titles and no oversized tick labels, so
// such a chart is laid out (and rendered) byte-identically to before any of this existed.
function chartMargins(shapeType: WhiteboardShapeType, w: number, h: number, opts: ShapeOutlineOptions): { left: number; top: number; bottom: number; labels: ChartLabel[] } {
  const fontSize = opts.fontSize ?? 16;
  const title = opts.chartTitle?.trim() ?? "";
  const xTitle = opts.axisXTitle?.trim() ?? "";
  const yTitle = opts.axisYTitle?.trim() ?? "";
  const unit = fontSize * TITLE_MARGIN_SCALE;
  const tickGutter = shapeType === "waterfallChart" && (opts.showChartLabels ?? true) ? waterfallYTickGutter(resolveSeriesData(opts), fontSize, opts.seriesYTickInterval) : 0;
  const left = Math.min(w * 0.4, (yTitle ? unit : 0) + tickGutter);
  const top = title ? unit * CHART_TITLE_FONT_SCALE : 0;
  const bottom = xTitle ? unit : 0;
  const innerW = Math.max(1, w - left);
  const innerH = Math.max(1, h - top - bottom);
  const labels: ChartLabel[] = [];
  if (title) labels.push({ x: left + innerW / 2, y: top / 2, text: title, anchor: "middle", fontScale: CHART_TITLE_FONT_SCALE, weight: "bold" });
  if (xTitle) labels.push({ x: left + innerW / 2, y: h - bottom / 2, text: xTitle, anchor: "middle" });
  // Rotated -90 about its own anchor point. Sits in the y-title's own share of the left margin -
  // OUTSIDE the tick-number gutter, so the caption and the numbers it describes never overlap.
  if (yTitle) labels.push({ x: Math.max(1, left - tickGutter) / 2, y: top + innerH / 2, text: yTitle, anchor: "middle", rotate: -90 });
  return { left, top, bottom, labels };
}

// Where a chart's data-space annotations map to in node-local pixels, and back. Exported and shared
// by BOTH the outline builder (placing each marker) and WhiteboardCanvas.tsx's own drag handles
// (rendering a handle at that marker and inverse-mapping a drag back into data space) - the same
// "one function owns this layout so two readers can't drift apart" reasoning graphCoordinateMapper's
// own doc comment gives.
//
// `offsetX`/`offsetY` are the title margins: annotations are positioned inside the PLOT box, which
// title captions shift down/right from the node's own top-left corner. The outline builder gets that
// shift for free from the ShapeOutline `inset` group it is already drawn inside; the canvas's drag
// handles are NOT inside that group, so they add it themselves.
export function annotationCoordinateMapper(shapeType: WhiteboardShapeType, w: number, h: number, opts: ShapeOutlineOptions) {
  const margins = chartMargins(shapeType, w, h, opts);
  const innerW = Math.max(1, w - margins.left);
  const innerH = Math.max(1, h - margins.top - margins.bottom);
  const range =
    shapeType === "waterfallChart"
      ? (() => {
          const r = resolveSeriesData(opts);
          return { xMin: r.xMin, xMax: r.xMax, yMin: r.stackedYMin, yMax: r.stackedYMax };
        })()
      : resolveGraphAxisRange(opts);
  return { ...graphCoordinateMapper(innerW, innerH, range.xMin, range.xMax, range.yMin, range.yMax), offsetX: margins.left, offsetY: margins.top };
}

// The marker glyph + label for each data-space callout on a chart (see whiteboardTypes.ts's
// ChartAnnotation), projected through the same mapper the chart's own data already went through -
// which is what keeps a callout pinned to its feature when the axis range or the node's box changes.
function annotationOutline(
  annotations: ChartAnnotation[],
  mapX: (x: number) => number,
  mapY: (y: number) => number,
  fallbackColor: string
): { parts: ChartPart[]; labels: ChartLabel[] } {
  const parts: ChartPart[] = [];
  const labels: ChartLabel[] = [];
  for (const a of annotations) {
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
    const px = mapX(a.x);
    const py = mapY(a.y);
    const color = a.color ?? fallbackColor;
    const r = a.size ?? DEFAULT_ANNOTATION_MARKER_SIZE;
    const marker = a.marker ?? "dot";
    if (marker === "dot") {
      parts.push({ d: dotPathD(px, py, r), role: "annotation", color });
    } else if (marker === "ring") {
      parts.push({ d: ringPathD(px, py, r, Math.max(0.4, r - 1.5)), role: "annotation", color });
    } else if (marker === "square") {
      parts.push({ d: `M${(px - r).toFixed(2)},${(py - r).toFixed(2)} L${(px + r).toFixed(2)},${(py - r).toFixed(2)} L${(px + r).toFixed(2)},${(py + r).toFixed(2)} L${(px - r).toFixed(2)},${(py + r).toFixed(2)} Z`, role: "annotation", color });
    } else if (marker === "cross") {
      const t = Math.max(0.6, r * 0.32);
      parts.push({
        d: [
          `M${(px - r).toFixed(2)},${(py - t).toFixed(2)} L${(px + r).toFixed(2)},${(py - t).toFixed(2)} L${(px + r).toFixed(2)},${(py + t).toFixed(2)} L${(px - r).toFixed(2)},${(py + t).toFixed(2)} Z`,
          `M${(px - t).toFixed(2)},${(py - r).toFixed(2)} L${(px + t).toFixed(2)},${(py - r).toFixed(2)} L${(px + t).toFixed(2)},${(py + r).toFixed(2)} L${(px - t).toFixed(2)},${(py + r).toFixed(2)} Z`,
        ].join(" "),
        role: "annotation",
        color,
      });
    }
    const text = a.text?.trim() ?? "";
    if (!text) continue;
    const dx = a.labelDx ?? DEFAULT_ANNOTATION_LABEL_DX;
    const dy = a.labelDy ?? DEFAULT_ANNOTATION_LABEL_DY;
    if (a.leader) parts.push({ d: openPathD([{ x: px, y: py }, { x: px + dx, y: py + dy }]), role: "annotation", color });
    labels.push({ x: px + dx, y: py + dy, text, anchor: dx < 0 ? "end" : "start", color });
  }
  return { parts, labels };
}

// Builds one continuous open-path `d` string tracing the given periodic waveform across a w×h box,
// vertically centered (amplitude = 35% of h either side of the midline), repeated `cycles` times.
// Square/triangle/sawtooth are piecewise-linear so their breakpoints are computed exactly (no
// sampling needed - that's also what gives square/sawtooth their genuinely vertical edges);
// sine/cosine are true curves, so they're densely sampled into a polyline instead - smooth enough
// at typical shape sizes without needing a bezier-approximation formula. All four/five share one
// moveTo-then-lineTo builder (`toD`) so the result is always a single unclosed path -
// fillAndStroke/the DOM renderer both already treat an unfilled ("fillColor: null") node as
// stroke-only, so leaving this open just draws the trace itself rather than an implicitly-closed
// silhouette.
export function waveOutlineD(w: number, h: number, style: NonNullable<WhiteboardNode["waveStyle"]>, cyclesInput?: number): string {
  const cycles = Math.max(MIN_WAVE_CYCLES, Math.min(MAX_WAVE_CYCLES, Math.round(cyclesInput ?? DEFAULT_WAVE_CYCLES)));
  const amp = h * 0.35;
  const midY = h / 2;
  const toD = (points: [number, number][]) => points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

  if (style === "square") {
    const half = w / (cycles * 2);
    const points: [number, number][] = [];
    for (let i = 0; i < cycles * 2; i++) {
      const y = i % 2 === 0 ? midY - amp : midY + amp;
      points.push([i * half, y], [(i + 1) * half, y]);
    }
    return toD(points);
  }
  if (style === "sawtooth") {
    const period = w / cycles;
    const points: [number, number][] = [];
    for (let i = 0; i < cycles; i++) {
      const x0 = i * period;
      points.push([x0, midY + amp], [x0 + period, midY - amp], [x0 + period, midY + amp]);
    }
    points.pop(); // end at the last ramp's peak, not dropped back to baseline
    return toD(points);
  }
  if (style === "triangle") {
    const quarter = w / (cycles * 4);
    const valuePattern = [0, 1, 0, -1]; // matches sine's phase: 0 -> peak -> 0 -> trough -> 0
    const points: [number, number][] = [];
    for (let i = 0; i <= cycles * 4; i++) {
      points.push([i * quarter, midY - amp * valuePattern[i % 4]]);
    }
    return toD(points);
  }
  // sine/cosine: dense sample of the true curve - samples scale with cycles so each period keeps a
  // roughly constant point density instead of getting choppier as more cycles are packed in.
  const samples = 48 * cycles;
  const points: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const angle = 2 * Math.PI * cycles * t;
    const v = style === "cosine" ? Math.cos(angle) : Math.sin(angle);
    points.push([t * w, midY - amp * v]);
  }
  return toD(points);
}

// The internal grid-divider lines for a "table" shape's outline - shared by shapeOutlineFor's own
// "table" case (the toolbar tile preview, and the Canvas2D export's fallback if paintTable ever
// can't run) below. Column dividers first, then row dividers, matching no particular reader's
// expectation - both draw every line in the returned list identically regardless of order.
function tableGridInnerLines(w: number, h: number, colWidths: number[], rowHeights: number[]): [number, number][][] {
  const lines: [number, number][][] = [];
  let x = 0;
  for (let i = 0; i < colWidths.length - 1; i++) {
    x += colWidths[i] * w;
    lines.push([[x, 0], [x, h]]);
  }
  let y = 0;
  for (let i = 0; i < rowHeights.length - 1; i++) {
    y += rowHeights[i] * h;
    lines.push([[0, y], [w, y]]);
  }
  return lines;
}

// The raw per-shapeType geometry, built in a plain 0,0-to-w,h box that knows nothing about title
// margins or data-space annotations - shapeOutlineFor below is what layers those on. Split out so
// every chart builder in this file can keep working in its own full box (see the ShapeOutline
// "chart" variant's own `inset` doc comment for why that split beats threading margins through).
function baseShapeOutline(shapeType: WhiteboardShapeType, w: number, h: number, opts?: ShapeOutlineOptions): ShapeOutline {
  switch (shapeType) {
    case "ellipse":
      return { kind: "ellipse" };
    case "diamond":
      return { kind: "polygon", points: [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]] };
    case "triangle":
      return { kind: "polygon", points: [[w / 2, 0], [w, h], [0, h]] };
    case "hexagon":
      return { kind: "polygon", points: [[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]] };
    case "parallelogram":
      return { kind: "polygon", points: [[w * 0.25, 0], [w, 0], [w * 0.75, h], [0, h]] };
    case "cylinder":
      return { kind: "cylinder" };
    case "polygon":
      return { kind: "polygon", points: regularPolygonPoints(w, h, Math.max(3, Math.min(12, opts?.sides ?? 5))) };
    case "star":
      return { kind: "polygon", points: starPoints(w, h, Math.max(3, Math.min(12, opts?.starPoints ?? 5)), opts?.starInnerRadiusRatio ?? 0.45) };
    case "trapezoid":
      return { kind: "polygon", points: [[w * 0.2, 0], [w * 0.8, 0], [w, h], [0, h]] };
    case "cross": {
      // Classic 12-point plus-sign, arm thickness = 35% of the shorter side, centered.
      const t = Math.min(w, h) * 0.35;
      const cx = w / 2;
      const cy = h / 2;
      const half = t / 2;
      return {
        kind: "polygon",
        points: [
          [cx - half, 0], [cx + half, 0], [cx + half, cy - half], [w, cy - half],
          [w, cy + half], [cx + half, cy + half], [cx + half, h], [cx - half, h],
          [cx - half, cy + half], [0, cy + half], [0, cy - half], [cx - half, cy - half],
        ],
      };
    }
    case "cube": {
      // A regular hexagon (flat vertex at top) with 3 spokes from center to alternating vertices -
      // the classic "isometric cube" icon (reads as 3 visible faces meeting at the center point).
      const hex = regularPolygonPoints(w, h, 6);
      const center: [number, number] = [w / 2, h / 2];
      return { kind: "polygon", points: hex, innerLines: [[center, hex[0]], [center, hex[2]], [center, hex[4]]] };
    }
    case "note": {
      // A rectangle with the top-right corner cut diagonally (the folded-corner sticky-note look),
      // plus a crease line tracing the fold so the cut doesn't just look like a chamfered rectangle.
      const fold = Math.min(w, h) * 0.28;
      return {
        kind: "polygon",
        points: [[0, 0], [w - fold, 0], [w, fold], [w, h], [0, h]],
        innerLines: [[[w - fold, 0], [w - fold, fold], [w, fold]]],
      };
    }
    case "callout": {
      // A rectangle with a small triangular tail poking out of the bottom-left area - the
      // speech-bubble look, built as one outline (no separate tail piece to layer/align).
      const tailW = w * 0.18;
      const tailX = w * 0.18;
      const tailH = h * 0.22;
      const bodyH = h - tailH;
      return {
        kind: "polygon",
        points: [[0, 0], [w, 0], [w, bodyH], [tailX + tailW, bodyH], [tailX, h], [tailX, bodyH], [0, bodyH]],
      };
    }
    case "step": {
      // A chevron/arrow pointing right with a matching notch on the left, for process-flow steps.
      const notch = w * 0.22;
      return { kind: "polygon", points: [[0, 0], [w - notch, 0], [w, h / 2], [w - notch, h], [0, h], [notch, h / 2]] };
    }
    case "document":
      // A rectangle with a single wavy bottom edge (cubic bezier "S" curve) - the flowchart
      // "document" shape.
      return { kind: "path", d: `M0,0 L${w},0 L${w},${h * 0.82} C${w * 0.75},${h} ${w * 0.25},${h * 0.68} 0,${h * 0.82} Z` };
    case "cloud": {
      // Five overlapping cubic-bezier bumps forming a closed cloud silhouette. Hand-tuned control
      // points rather than a geometric circle-union (which needs real curve-intersection math) -
      // verified by eye against the toolbar's shape-preset preview, same as every other shape here.
      const d = [
        `M ${w * 0.28},${h * 0.78}`,
        `C ${w * 0.08},${h * 0.78} ${w * -0.02},${h * 0.55} ${w * 0.12},${h * 0.42}`,
        `C ${w * 0.04},${h * 0.22} ${w * 0.24},${h * 0.02} ${w * 0.42},${h * 0.14}`,
        `C ${w * 0.5},${h * 0.0} ${w * 0.72},${h * 0.0} ${w * 0.8},${h * 0.18}`,
        `C ${w * 0.94},${h * 0.12} ${w * 1.08},${h * 0.32} ${w * 0.92},${h * 0.46}`,
        `C ${w * 1.04},${h * 0.56} ${w * 0.98},${h * 0.78} ${w * 0.82},${h * 0.78}`,
        `Z`,
      ].join(" ");
      return { kind: "path", d };
    }
    case "wave":
      return { kind: "path", d: waveOutlineD(w, h, opts?.waveStyle ?? "sine", opts?.waveCycles) };
    case "resistor":
      return { kind: "path", d: resistorOutlineD(w, h) };
    case "capacitor":
      return { kind: "path", d: capacitorOutlineD(w, h) };
    case "spring":
      return { kind: "path", d: springOutlineD(w, h) };
    case "battery":
      return { kind: "path", d: batteryOutlineD(w, h) };
    case "flask":
      return { kind: "path", d: flaskOutlineD(w, h) };
    case "beaker":
      return { kind: "path", d: beakerOutlineD(w, h) };
    case "benzeneRing": {
      const hex = regularPolygonPoints(w, h, 6);
      return { kind: "polygon", points: hex, innerCircle: { cx: w / 2, cy: h / 2, r: Math.min(w, h) * 0.28 } };
    }
    case "axes":
      return { kind: "path", d: axesOutlineD(w, h) };
    case "angle":
      return {
        kind: "path",
        d: angleOutlineD(w, h, opts?.angleDegrees ?? DEFAULT_ANGLE_DEGREES, opts?.angleRay1Length ?? DEFAULT_ANGLE_RAY_LENGTH, opts?.angleRay2Length ?? DEFAULT_ANGLE_RAY_LENGTH),
      };
    // A plain horizontal line - just enough for the toolbar preview swatch to show SOMETHING
    // recognizable. The real placed shape never actually consults this: it gets its own dedicated
    // rendering (with a real arrowhead marker) in both WhiteboardCanvas.tsx and this file's own
    // renderNode, the same way "freehand" bypasses shapeOutlineFor entirely.
    case "vector":
      return { kind: "path", d: `M0,${(h / 2).toFixed(2)} L${w},${(h / 2).toFixed(2)}` };
    case "diode":
      return { kind: "path", d: diodeOutlineD(w, h) };
    case "inductor":
      return { kind: "path", d: inductorOutlineD(w, h) };
    case "ground":
      return { kind: "path", d: groundOutlineD(w, h) };
    case "amplifier":
      return {
        kind: "chart",
        parts: amplifierOutlineParts(w, h, {
          topLeadLength: opts?.ampInputTopLeadLength,
          bottomLeadLength: opts?.ampInputBottomLeadLength,
          outputLeadLength: opts?.ampOutputLeadLength,
          topLeadYOffset: opts?.ampInputTopLeadYOffset,
          bottomLeadYOffset: opts?.ampInputBottomLeadYOffset,
          outputLeadYOffset: opts?.ampOutputLeadYOffset,
          invertingOnTop: opts?.ampInvertingOnTop,
        }),
      };
    // "latticeGauge" has no flat-drawing form of its own at all - the live shape is a real WebGL
    // scene (see whiteboardTypes.ts's own doc comment on this shapeType), which neither the SVG
    // outline system nor the Canvas2D PNG-export path (renderWhiteboardToCanvas below) can capture
    // a frame of. This is just a recognizable placeholder glyph for both of those - the same
    // isometric-cube icon "cube" uses, plus a center dot standing in for a lattice site - not an
    // attempt at a miniature of the actual widget.
    case "latticeGauge": {
      const hex = regularPolygonPoints(w, h, 6);
      const center: [number, number] = [w / 2, h / 2];
      return { kind: "polygon", points: hex, innerLines: [[center, hex[0]], [center, hex[2]], [center, hex[4]]], innerCircle: { cx: w / 2, cy: h / 2, r: Math.min(w, h) * 0.09 } };
    }
    case "bondLine":
      return { kind: "path", d: bondLineOutlineD(w, h, opts?.sides ?? 5) };
    case "unitCircle":
      return { kind: "path", d: unitCircleOutlineD(w, h) };
    case "hourglass":
      return { kind: "polygon", points: hourglassPolygonPoints(w, h) };
    case "teardrop":
      return { kind: "path", d: teardropOutlineD(w, h) };
    case "lightningBolt":
      return { kind: "polygon", points: lightningBoltPolygonPoints(w, h) };
    case "halfCircle":
      return { kind: "path", d: halfCircleOutlineD(w, h) };
    case "banner":
      return { kind: "polygon", points: bannerPolygonPoints(w, h) };
    case "frame":
      return { kind: "path", d: frameOutlineD(w, h) };
    case "tape":
      return { kind: "path", d: tapeOutlineD(w, h) };
    case "display":
      return { kind: "path", d: displayOutlineD(w, h) };
    case "predefinedProcess":
      return {
        kind: "polygon",
        points: [[0, 0], [w, 0], [w, h], [0, h]],
        innerLines: [[[w * 0.15, 0], [w * 0.15, h]], [[w * 0.85, 0], [w * 0.85, h]]],
      };
    case "manualInput":
      return { kind: "polygon", points: manualInputPolygonPoints(w, h) };
    case "internalStorage":
      return {
        kind: "polygon",
        points: [[0, 0], [w, 0], [w, h], [0, h]],
        innerLines: [[[w * 0.15, 0], [w * 0.15, h]], [[0, h * 0.15], [w, h * 0.15]]],
      };
    case "barChart":
      return { kind: "chart", ...barChartOutline(w, h, opts?.chartData, opts?.showChartLabels ?? true) };
    case "lineChart":
      return { kind: "chart", ...lineChartOutline(w, h, opts?.chartData, opts?.showChartLabels ?? true) };
    case "pieChart":
      return { kind: "chart", parts: pieChartParts(w, h, opts?.chartData) };
    case "scatterPlot":
      return { kind: "chart", ...scatterPlotOutline(w, h, opts?.chartData, opts?.showChartLabels ?? true) };
    case "numberLine":
      return { kind: "chart", ...numberLineOutline(w, h, opts?.showChartLabels ?? true, opts?.numberLineMax) };
    case "functionPlot":
      return {
        kind: "chart",
        ...functionPlotOutline(
          w,
          h,
          opts?.plotFunction ?? "sine",
          opts?.plotDomainScale,
          opts?.plotXTickInterval,
          opts?.plotYTickInterval,
          opts?.showChartLabels ?? true,
          opts?.plotCycles,
          opts?.plotShowGrid ?? false
        ),
      };
    case "graph":
      return {
        kind: "chart",
        ...graphOutline(
          w,
          h,
          opts?.graphExpression ?? DEFAULT_GRAPH_EXPRESSION,
          opts?.graphXMin,
          opts?.graphXMax,
          opts?.graphYMin,
          opts?.graphYMax,
          opts?.graphXTickInterval,
          opts?.graphYTickInterval,
          opts?.showChartLabels ?? true,
          opts?.graphShowGrid ?? true,
          opts?.graphPoints ?? []
        ),
      };
    case "waterfallChart":
      // `opts` is handed straight to resolveSeriesData rather than copied field-by-field - see
      // ShapeOutlineOptions' own series-field doc comment for why the names match exactly.
      return {
        kind: "chart",
        ...waterfallOutline(w, h, resolveSeriesData(opts ?? {}), {
          showLabels: opts?.showChartLabels ?? true,
          showGrid: opts?.seriesShowGrid ?? false,
          fillUnder: opts?.seriesFillUnder ?? false,
          showBaselines: opts?.seriesShowBaselines ?? false,
          showLegend: opts?.seriesShowLegend ?? false,
          xTickInterval: opts?.seriesXTickInterval,
          yTickInterval: opts?.seriesYTickInterval,
          strokeWidth: opts?.strokeWidth ?? 1.2,
          fontSize: opts?.fontSize ?? 11,
        }),
      };
    case "minusSign": {
      const t = h * 0.28;
      const cy = h / 2;
      return { kind: "polygon", points: [[0, cy - t / 2], [w, cy - t / 2], [w, cy + t / 2], [0, cy + t / 2]] };
    }
    case "multiplySign":
      return { kind: "polygon", points: multiplySignPoints(w, h) };
    case "divideSign":
      return { kind: "path", d: divideSignOutlineD(w, h) };
    case "equalsSign":
      return { kind: "path", d: equalsSignOutlineD(w, h) };
    case "greaterThanSign":
      return { kind: "polygon", points: chevronPoints(w, h, false) };
    case "lessThanSign":
      return { kind: "polygon", points: chevronPoints(w, h, true) };
    case "greaterEqualSign":
      return { kind: "path", d: chevronBarOutlineD(w, h, false) };
    case "lessEqualSign":
      return { kind: "path", d: chevronBarOutlineD(w, h, true) };
    case "table": {
      const cols = Math.max(1, opts?.tableCols ?? DEFAULT_TABLE_COLS);
      const rows = Math.max(1, opts?.tableRows ?? DEFAULT_TABLE_ROWS);
      const colWidths = opts?.tableColWidths && opts.tableColWidths.length === cols ? opts.tableColWidths : Array(cols).fill(1 / cols);
      const rowHeights = opts?.tableRowHeights && opts.tableRowHeights.length === rows ? opts.tableRowHeights : Array(rows).fill(1 / rows);
      return { kind: "polygon", points: [[0, 0], [w, 0], [w, h], [0, h]], innerLines: tableGridInnerLines(w, h, colWidths, rowHeights) };
    }
    case "rectangle":
    case "text":
    case "freehand":
    default:
      return { kind: "rect" };
  }
}

// Every shape's outline, in node-local coordinates. For the chart shapes this additionally reserves
// margins for whatever title captions are set (shrinking the plot box to fit, rather than letting a
// caption overlap the data) and projects any data-space annotations through the same coordinate
// mapper the chart's own data used.
//
// A non-chart shape, or a chart with no titles and no annotations, returns baseShapeOutline's result
// unchanged - byte-identical to what this function returned before either feature existed, so
// nothing about an existing diagram shifts by a pixel.
export function shapeOutlineFor(shapeType: WhiteboardShapeType, w: number, h: number, opts?: ShapeOutlineOptions): ShapeOutline {
  const annotations = CHART_ANNOTATION_SHAPES.has(shapeType) ? opts?.chartAnnotations ?? [] : [];
  const margins = CHART_AXIS_TITLE_SHAPES.has(shapeType) ? chartMargins(shapeType, w, h, opts ?? {}) : { left: 0, top: 0, bottom: 0, labels: [] as ChartLabel[] };
  const hasMargins = margins.left > 0 || margins.top > 0 || margins.bottom > 0;
  if (!hasMargins && annotations.length === 0) return baseShapeOutline(shapeType, w, h, opts);

  const innerW = Math.max(1, w - margins.left);
  const innerH = Math.max(1, h - margins.top - margins.bottom);
  const outline = baseShapeOutline(shapeType, innerW, innerH, opts);
  // Margins/annotations are only meaningful on a "chart"-kind outline (every CHART_AXIS_TITLE_SHAPES
  // member produces one); anything else falls back to its plain full-size outline rather than
  // silently rendering a caption with no plot to caption.
  if (outline.kind !== "chart") return baseShapeOutline(shapeType, w, h, opts);

  const parts = [...outline.parts];
  const labels = [...(outline.labels ?? [])];
  if (annotations.length > 0) {
    // Annotations map through the SAME axis window the shape's own data did - resolveGraphAxisRange
    // for "graph", the stacked series extent for "waterfallChart" - so a callout lands exactly on
    // the feature it names rather than on a second, independently-derived scale.
    const { mapX, mapY } = annotationCoordinateMapper(shapeType, w, h, opts ?? {});
    const built = annotationOutline(annotations, mapX, mapY, opts?.strokeColor ?? "#111111");
    parts.push(...built.parts);
    labels.push(...built.labels);
  }
  return {
    kind: "chart",
    parts,
    labels,
    inset: margins.left || margins.top ? { dx: margins.left, dy: margins.top } : undefined,
    overlayLabels: margins.labels.length > 0 ? margins.labels : undefined,
  };
}

// Every shape-specific field a node carries, as the options object shapeOutlineFor reads. One
// shared builder because THREE separate callers need the identical mapping - the live SVG canvas
// (WhiteboardCanvas.tsx), the Canvas2D/PNG export (paintShapeBody below), and the toolbar's shape-
// preset preview tiles (WhiteboardEditor.tsx) - and each one hand-listing ~40 fields meant a field
// added for one renderer was silently missing from the others until someone noticed the two drawing
// the same shape differently. Adding a shape field now means adding it here once.
export function outlineOptionsFor(node: WhiteboardNode): ShapeOutlineOptions {
  return {
    sides: node.sides,
    starPoints: node.starPoints,
    starInnerRadiusRatio: node.starInnerRadiusRatio,
    waveStyle: node.waveStyle,
    waveCycles: node.waveCycles,
    angleDegrees: node.angleDegrees,
    angleRay1Length: node.angleRay1Length,
    angleRay2Length: node.angleRay2Length,
    chartData: node.chartData,
    plotFunction: node.plotFunction,
    plotDomainScale: node.plotDomainScale,
    plotCycles: node.plotCycles,
    plotShowGrid: node.plotShowGrid,
    plotXTickInterval: node.plotXTickInterval,
    plotYTickInterval: node.plotYTickInterval,
    showChartLabels: node.showChartLabels,
    numberLineMax: node.numberLineMax,
    graphExpression: node.graphExpression,
    graphXMin: node.graphXMin,
    graphXMax: node.graphXMax,
    graphYMin: node.graphYMin,
    graphYMax: node.graphYMax,
    graphShowGrid: node.graphShowGrid,
    graphXTickInterval: node.graphXTickInterval,
    graphYTickInterval: node.graphYTickInterval,
    graphPoints: node.graphPoints,
    seriesData: node.seriesData,
    seriesXMin: node.seriesXMin,
    seriesXMax: node.seriesXMax,
    seriesYMin: node.seriesYMin,
    seriesYMax: node.seriesYMax,
    seriesOffset: node.seriesOffset,
    seriesColormap: node.seriesColormap,
    seriesColorsReversed: node.seriesColorsReversed,
    seriesColors: node.seriesColors,
    seriesLabels: node.seriesLabels,
    seriesFillUnder: node.seriesFillUnder,
    seriesShowBaselines: node.seriesShowBaselines,
    seriesShowLegend: node.seriesShowLegend,
    seriesShowGrid: node.seriesShowGrid,
    seriesXTickInterval: node.seriesXTickInterval,
    seriesYTickInterval: node.seriesYTickInterval,
    chartTitle: node.chartTitle,
    axisXTitle: node.axisXTitle,
    axisYTitle: node.axisYTitle,
    chartAnnotations: node.chartAnnotations,
    fontSize: node.fontSize,
    strokeColor: node.strokeColor,
    strokeWidth: node.strokeWidth,
    ampInputTopLeadLength: node.ampInputTopLeadLength,
    ampInputBottomLeadLength: node.ampInputBottomLeadLength,
    ampOutputLeadLength: node.ampOutputLeadLength,
    ampInputTopLeadYOffset: node.ampInputTopLeadYOffset,
    ampInputBottomLeadYOffset: node.ampInputBottomLeadYOffset,
    ampOutputLeadYOffset: node.ampOutputLeadYOffset,
    ampInvertingOnTop: node.ampInvertingOnTop,
    tableRows: node.tableRows,
    tableCols: node.tableCols,
    tableColWidths: node.tableColWidths,
    tableRowHeights: node.tableRowHeights,
  };
}

// The cylinder's cap ellipse height, as a fraction of the node's own height - shared by both
// renderers so the SVG version and the PNG-export Canvas2D version draw the exact same shape.
export const CYLINDER_CAP_RATIO = 0.18;

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
export function computeContentBounds(page: WhiteboardPage): BoundsBox {
  if (page.nodes.length === 0 && page.edges.length === 0) {
    return { minX: -EMPTY_BOUNDS_PADDING, minY: -EMPTY_BOUNDS_PADDING, maxX: EMPTY_BOUNDS_PADDING, maxY: EMPTY_BOUNDS_PADDING };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of page.nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  const nodesById = new Map(page.nodes.map((n) => [n.id, n]));
  for (const edge of page.edges) {
    const { source, target } = resolveEdgeEndpoints(edge, nodesById);
    minX = Math.min(minX, source.x, target.x);
    minY = Math.min(minY, source.y, target.y);
    maxX = Math.max(maxX, source.x, target.x);
    maxY = Math.max(maxY, source.y, target.y);
    for (const wp of edge.waypoints ?? []) {
      minX = Math.min(minX, wp.x);
      minY = Math.min(minY, wp.y);
      maxX = Math.max(maxX, wp.x);
      maxY = Math.max(maxY, wp.y);
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: -EMPTY_BOUNDS_PADDING, minY: -EMPTY_BOUNDS_PADDING, maxX: EMPTY_BOUNDS_PADDING, maxY: EMPTY_BOUNDS_PADDING };
  }
  const pad = 60;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

// ---- Image nodes ---------------------------------------------------------------------------------

// Where the (already cropped) source bitmap lands inside the node's box, in node-local pixels, for
// a given fit mode. The ONE place this is decided - the live <img> (via an object-fit/object-position
// equivalent), the Canvas2D export's drawImage destination rect, and the crop overlay all read it -
// so the exported PNG can't frame a photo differently from what the canvas showed.
//
// "cover" scales to the LARGER ratio so the box is fully covered and the overflow is clipped away;
// "contain" scales to the smaller so the whole image fits and the node's fillColor shows through the
// leftover margin; "fill" ignores aspect entirely. Both centered, matching CSS object-position's own
// default of 50% 50%.
export function imageDestRect(
  node: WhiteboardNode,
  sourceW: number,
  sourceH: number
): { x: number; y: number; width: number; height: number } {
  const fit = node.imageFit ?? "cover";
  const boxW = node.width;
  const boxH = node.height;
  if (fit === "fill" || sourceW <= 0 || sourceH <= 0) return { x: 0, y: 0, width: boxW, height: boxH };
  const scale = fit === "cover" ? Math.max(boxW / sourceW, boxH / sourceH) : Math.min(boxW / sourceW, boxH / sourceH);
  const width = sourceW * scale;
  const height = sourceH * scale;
  return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height };
}

// The mask silhouette an image is cut to, as a Path2D in node-local coordinates - shared by the
// export's clip region and its ring stroke so the two can never disagree about where the edge is.
// The live DOM renderer expresses the same three shapes as a CSS border-radius instead (see
// WhiteboardCanvas.tsx's own image branch), since clipping an <img> that way is free there.
function imageMaskPath(node: WhiteboardNode): Path2D {
  const path = new Path2D();
  const mask = node.imageMask ?? "rect";
  const { width: w, height: h } = node;
  if (mask === "ellipse") {
    path.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return path;
  }
  if (mask === "rounded") {
    // Clamped to half the shorter side - a radius past that is geometrically meaningless and
    // renders as a malformed path rather than a rounder box.
    const r = Math.max(0, Math.min(node.cornerRadius ?? 0, Math.min(w, h) / 2));
    path.roundRect(0, 0, w, h, r);
    return path;
  }
  path.rect(0, 0, w, h);
  return path;
}

// Paints an image node into the export canvas: the node's own fill as a matte behind it (visible
// only where a "contain" fit leaves margin), the cropped bitmap clipped to the mask, then the ring
// stroke along that same mask edge.
//
// `image` is null when the asset is missing or hasn't decoded - the node then draws the same dashed
// placeholder box the live canvas shows, rather than silently exporting a hole where a photo was.
export function paintImageNode(ctx: CanvasRenderingContext2D, node: WhiteboardNode, image: CanvasImageSource | null, sourceW: number, sourceH: number): void {
  const maskPath = imageMaskPath(node);

  if (node.fillColor) {
    ctx.save();
    ctx.clip(maskPath);
    ctx.fillStyle = node.fillColor;
    ctx.fillRect(0, 0, node.width, node.height);
    ctx.restore();
  }

  if (image && sourceW > 0 && sourceH > 0) {
    const crop = resolveImageCrop(node);
    const sx = crop.x * sourceW;
    const sy = crop.y * sourceH;
    const sw = crop.w * sourceW;
    const sh = crop.h * sourceH;
    const dest = imageDestRect(node, sw, sh);
    ctx.save();
    ctx.clip(maskPath);
    ctx.globalAlpha = Math.max(0, Math.min(1, node.imageOpacity ?? 1));
    // Canvas2D has no per-drawImage color filter, so grayscale goes through ctx.filter. It is
    // widely supported but not universally, and a browser that ignores it simply draws the image in
    // full color - a cosmetic difference, never a failed export, so no fallback path is warranted.
    if (node.imageGrayscale) ctx.filter = "grayscale(1)";
    ctx.drawImage(image, sx, sy, sw, sh, dest.x, dest.y, dest.width, dest.height);
    ctx.filter = "none";
    ctx.restore();
  } else {
    // Missing-asset placeholder - a dashed outline plus a caption, matching the live canvas.
    ctx.save();
    ctx.clip(maskPath);
    ctx.fillStyle = "#f3f4f6";
    ctx.fillRect(0, 0, node.width, node.height);
    ctx.restore();
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1.5;
    ctx.stroke(maskPath);
    ctx.fillStyle = "#6b7280";
    ctx.font = `12px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Image missing", node.width / 2, node.height / 2);
    ctx.restore();
  }

  if (node.strokeWidth > 0) {
    ctx.save();
    // The ring is centered on the mask edge, so half of it would spill outside the node's box.
    // Clipping to the mask keeps it flush with the silhouette - the same inset ring the live
    // renderer's own `box-shadow: inset` produces.
    ctx.clip(maskPath);
    ctx.lineWidth = node.strokeWidth * 2;
    ctx.strokeStyle = node.strokeColor;
    ctx.stroke(maskPath);
    ctx.restore();
  }
}

// ---- Figure layout (grid / align / distribute) --------------------------------------------------
//
// Pure "given these nodes, where should each one end up" functions. Every one returns a NEW array of
// updated nodes and mutates nothing, so the caller commits the result as an ordinary
// "batch-edit-nodes" command - which means undo/redo works for free and no new command type is
// needed, the same reasoning grouping already relies on (see WhiteboardNode.groupId).
//
// A locked node (WhiteboardNode.locked) is never moved or resized by any of these - it is skipped
// and, in the grid case, does not consume a cell either. Lock exists precisely so a user can pin
// the thing they are arranging other content around, and having "Arrange" quietly shove it aside
// would defeat that.

export interface GridArrangeOptions {
  columns: number;
  gapX: number;
  gapY: number;
  // "uniform" resizes every panel to the largest one's box - what a real multi-panel figure wants,
  // since panels of different sizes read as an accident rather than a comparison. "keep" preserves
  // each node's own size and only repositions, for arranging mixed content (a chart beside a note
  // beside an equation) where forcing one size would be wrong.
  sizing: "uniform" | "keep";
}

export const DEFAULT_GRID_GAP = 24;

// Row-major placement into `columns` columns, in the nodes' own current reading order (top-to-bottom,
// then left-to-right) rather than z-order or selection order - so "arrange these into 2 columns"
// keeps roughly the arrangement the user already had in mind instead of shuffling panels to wherever
// they happen to sit in the document array.
//
// Each row is as tall as its own tallest member and each column as wide as its own widest, so a grid
// of differently-sized panels still lines up on both axes. The whole block is anchored at the
// selection's existing top-left corner, keeping the result where the content already was.
export function arrangeNodesInGrid(nodes: WhiteboardNode[], opts: GridArrangeOptions): WhiteboardNode[] {
  const movable = nodes.filter((n) => !n.locked);
  if (movable.length === 0) return [];
  const columns = Math.max(1, Math.min(movable.length, Math.round(opts.columns)));
  const originX = Math.min(...movable.map((n) => n.x));
  const originY = Math.min(...movable.map((n) => n.y));

  // Reading order, with a row tolerance so panels that are roughly side by side (never pixel-exact
  // after hand placement) sort left-to-right rather than by a few pixels of vertical jitter.
  const rowTolerance = Math.max(...movable.map((n) => n.height)) * 0.5;
  const ordered = [...movable].sort((a, b) => (Math.abs(a.y - b.y) > rowTolerance ? a.y - b.y : a.x - b.x));

  const uniformW = opts.sizing === "uniform" ? Math.max(...ordered.map((n) => n.width)) : 0;
  const uniformH = opts.sizing === "uniform" ? Math.max(...ordered.map((n) => n.height)) : 0;
  const cellW = (n: WhiteboardNode) => (opts.sizing === "uniform" ? uniformW : n.width);
  const cellH = (n: WhiteboardNode) => (opts.sizing === "uniform" ? uniformH : n.height);

  const rows = Math.ceil(ordered.length / columns);
  const colWidths = Array.from({ length: columns }, (_, c) => {
    let max = 0;
    for (let r = 0; r < rows; r++) {
      const n = ordered[r * columns + c];
      if (n) max = Math.max(max, cellW(n));
    }
    return max;
  });
  const rowHeights = Array.from({ length: rows }, (_, r) => {
    let max = 0;
    for (let c = 0; c < columns; c++) {
      const n = ordered[r * columns + c];
      if (n) max = Math.max(max, cellH(n));
    }
    return max;
  });

  const colX: number[] = [];
  let runningX = originX;
  for (let c = 0; c < columns; c++) {
    colX.push(runningX);
    runningX += colWidths[c] + opts.gapX;
  }
  const rowY: number[] = [];
  let runningY = originY;
  for (let r = 0; r < rows; r++) {
    rowY.push(runningY);
    runningY += rowHeights[r] + opts.gapY;
  }

  const now = Date.now();
  return ordered.map((node, i) => {
    const r = Math.floor(i / columns);
    const c = i % columns;
    const width = opts.sizing === "uniform" ? uniformW : node.width;
    const height = opts.sizing === "uniform" ? uniformH : node.height;
    // Centered within its cell, so a "keep"-sized node smaller than its row/column still sits
    // visually balanced rather than jammed into the corner.
    return {
      ...node,
      x: colX[c] + (colWidths[c] - width) / 2,
      y: rowY[r] + (rowHeights[r] - height) / 2,
      width,
      height,
      updatedAt: now,
    };
  });
}

export type AlignEdge = "left" | "right" | "top" | "bottom" | "centerX" | "centerY";

// Aligns every node to the selection's own extreme edge (the leftmost node's left edge, etc.) rather
// than to the first-selected or the largest node - the extreme is what "align left" means everywhere
// else and needs no selection-order convention to explain.
export function alignNodes(nodes: WhiteboardNode[], edge: AlignEdge): WhiteboardNode[] {
  const movable = nodes.filter((n) => !n.locked);
  if (movable.length < 2) return [];
  const now = Date.now();
  const left = Math.min(...movable.map((n) => n.x));
  const right = Math.max(...movable.map((n) => n.x + n.width));
  const top = Math.min(...movable.map((n) => n.y));
  const bottom = Math.max(...movable.map((n) => n.y + n.height));
  return movable.map((n) => {
    switch (edge) {
      case "left":
        return { ...n, x: left, updatedAt: now };
      case "right":
        return { ...n, x: right - n.width, updatedAt: now };
      case "top":
        return { ...n, y: top, updatedAt: now };
      case "bottom":
        return { ...n, y: bottom - n.height, updatedAt: now };
      case "centerX":
        return { ...n, x: (left + right) / 2 - n.width / 2, updatedAt: now };
      case "centerY":
        return { ...n, y: (top + bottom) / 2 - n.height / 2, updatedAt: now };
    }
  });
}

// Equalizes the GAPS between consecutive nodes along one axis, keeping the two extreme nodes exactly
// where they are. Spacing gaps rather than centers is what keeps differently-sized panels looking
// evenly placed - equal center spacing would visually crowd a wide panel against its neighbors.
export function distributeNodes(nodes: WhiteboardNode[], axis: "horizontal" | "vertical"): WhiteboardNode[] {
  const movable = nodes.filter((n) => !n.locked);
  if (movable.length < 3) return [];
  const now = Date.now();
  const pos = (n: WhiteboardNode) => (axis === "horizontal" ? n.x : n.y);
  const size = (n: WhiteboardNode) => (axis === "horizontal" ? n.width : n.height);
  const ordered = [...movable].sort((a, b) => pos(a) - pos(b));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const span = pos(last) + size(last) - pos(first);
  const totalSize = ordered.reduce((sum, n) => sum + size(n), 0);
  const gap = (span - totalSize) / (ordered.length - 1);
  let cursor = pos(first);
  return ordered.map((n) => {
    const placed = axis === "horizontal" ? { ...n, x: cursor, updatedAt: now } : { ...n, y: cursor, updatedAt: now };
    cursor += size(n) + gap;
    return placed;
  });
}

// ---- Command apply/invert (scoped to one page) ---------------------------------------------------

export function applyCommand(page: WhiteboardPage, command: WhiteboardCommand): WhiteboardPage {
  switch (command.type) {
    case "add-node":
      return { ...page, nodes: [...page.nodes, command.item] };
    case "add-node-with-edge":
      return { ...page, nodes: [...page.nodes, command.node], edges: [...page.edges, command.edge] };
    case "delete-node": {
      const removedEdgeIds = new Set(command.edges.map((e) => e.id));
      return {
        ...page,
        nodes: page.nodes.filter((n) => n.id !== command.item.id),
        edges: page.edges.filter((e) => !removedEdgeIds.has(e.id)),
      };
    }
    case "edit-node":
      return { ...page, nodes: page.nodes.map((n) => (n.id === command.after.id ? command.after : n)) };
    case "batch-edit-nodes": {
      const afterById = new Map(command.after.map((n) => [n.id, n]));
      return { ...page, nodes: page.nodes.map((n) => afterById.get(n.id) ?? n) };
    }
    case "add-edge":
      return { ...page, edges: [...page.edges, command.item] };
    case "delete-edge":
      return { ...page, edges: page.edges.filter((e) => e.id !== command.item.id) };
    case "edit-edge":
      return { ...page, edges: page.edges.map((e) => (e.id === command.after.id ? command.after : e)) };
    case "reorder-nodes":
      return { ...page, nodes: command.after };
    case "paste-items":
      return { ...page, nodes: [...page.nodes, ...command.nodes], edges: [...page.edges, ...command.edges] };
    case "delete-items": {
      const nodeIds = new Set(command.nodes.map((n) => n.id));
      const edgeIds = new Set(command.edges.map((e) => e.id));
      return { ...page, nodes: page.nodes.filter((n) => !nodeIds.has(n.id)), edges: page.edges.filter((e) => !edgeIds.has(e.id)) };
    }
  }
}

export function invertCommand(command: WhiteboardCommand): WhiteboardCommand {
  switch (command.type) {
    case "add-node":
      return { type: "delete-node", item: command.item, edges: [] };
    // Unlike plain "add-node", this DOES have everything needed to invert cleanly: delete-node's
    // own `edges` cascade array is exactly "the edges to remove alongside this node," and here
    // that's just the one edge this command added - no special-casing needed in useWhiteboardStore.
    case "add-node-with-edge":
      return { type: "delete-node", item: command.node, edges: [command.edge] };
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
    // Exact mirror of each other - no special-casing needed in useWhiteboardStore's undo()/redo()
    // the way "delete-node" needs (see undoDeleteNode's own doc comment): both directions of a
    // paste/un-paste are already fully expressible as one one of these two command types.
    case "paste-items":
      return { type: "delete-items", nodes: command.nodes, edges: command.edges };
    case "delete-items":
      return { type: "paste-items", nodes: command.nodes, edges: command.edges };
  }
}

// Re-adds a deleted node's cascade-deleted edges too, in one shot - invertCommand alone can't
// express "add-node AND add-edge (several)" as a single WhiteboardCommand (the command union has
// no such combined type), so useWhiteboardStore's undo calls this instead of invertCommand for a
// "delete-node" specifically, applying the node re-add and each edge re-add as one page update.
export function undoDeleteNode(page: WhiteboardPage, command: Extract<WhiteboardCommand, { type: "delete-node" }>): WhiteboardPage {
  return { ...page, nodes: [...page.nodes, command.item], edges: [...page.edges, ...command.edges] };
}

// ---- Export rendering (flattened PNG) ------------------------------------------------------------

// Draws a freehand stroke through its (fraction-of-box) points as a smooth curve - each segment is
// a quadratic curve through the midpoint of two consecutive points, the standard cheap "smooth a
// polyline" trick (avoids the visibly faceted look plain line-to-line segments would have for a
// hand-drawn ink stroke). Node-local coordinates (see this file's ShapeOutline doc comment) -
// caller has already ctx.translate(node.x, node.y).
function freehandPath2D(node: WhiteboardNode): Path2D {
  const pts = (node.points ?? []).map((p) => ({ x: p.x * node.width, y: p.y * node.height }));
  const path = new Path2D();
  if (pts.length === 0) return path;
  if (pts.length === 1) {
    path.arc(pts[0].x, pts[0].y, Math.max(1, node.strokeWidth / 2), 0, Math.PI * 2);
    return path;
  }
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    path.quadraticCurveTo(pts[i].x, pts[i].y, mid.x, mid.y);
  }
  path.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  return path;
}

function roundedRectPath2D(w: number, h: number, radius: number): Path2D {
  const path = new Path2D();
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r <= 0) {
    path.rect(0, 0, w, h);
    return path;
  }
  path.moveTo(r, 0);
  path.arcTo(w, 0, w, h, r);
  path.arcTo(w, h, 0, h, r);
  path.arcTo(0, h, 0, 0, r);
  path.arcTo(0, 0, w, 0, r);
  path.closePath();
  return path;
}

function polygonPath2D(points: [number, number][]): Path2D {
  const path = new Path2D();
  points.forEach(([px, py], i) => (i === 0 ? path.moveTo(px, py) : path.lineTo(px, py)));
  path.closePath();
  return path;
}

// Fills+strokes one node's shape body in the ctx's CURRENT coordinate space - callers
// ctx.translate(node.x, node.y) first, matching shapeOutlineFor's node-local convention (see this
// file's own ShapeOutline doc comment), so nothing here ever touches node.x/y again.
function paintShapeBody(ctx: CanvasRenderingContext2D, node: WhiteboardNode): void {
  const { width: w, height: h } = node;
  const outline = shapeOutlineFor(node.shapeType, w, h, outlineOptionsFor(node));

  const fillAndStroke = (path: Path2D) => {
    if (node.fillColor) {
      ctx.fillStyle = node.fillColor;
      ctx.fill(path);
    }
    if (node.strokeWidth > 0) {
      ctx.lineWidth = node.strokeWidth;
      ctx.strokeStyle = node.strokeColor;
      ctx.stroke(path);
    }
  };

  switch (outline.kind) {
    case "rect":
      fillAndStroke(roundedRectPath2D(w, h, node.cornerRadius ?? 0));
      return;
    case "ellipse": {
      const p = new Path2D();
      p.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      fillAndStroke(p);
      return;
    }
    case "polygon": {
      fillAndStroke(polygonPath2D(outline.points));
      if (outline.innerLines && node.strokeWidth > 0) {
        ctx.lineWidth = node.strokeWidth;
        ctx.strokeStyle = node.strokeColor;
        for (const line of outline.innerLines) ctx.stroke(polylineOpenPath2D(line));
      }
      if (outline.innerCircle && node.strokeWidth > 0) {
        ctx.lineWidth = node.strokeWidth;
        ctx.strokeStyle = node.strokeColor;
        const circle = new Path2D();
        circle.ellipse(outline.innerCircle.cx, outline.innerCircle.cy, outline.innerCircle.r, outline.innerCircle.r, 0, 0, Math.PI * 2);
        ctx.stroke(circle);
      }
      return;
    }
    case "cylinder": {
      const ry = h * CYLINDER_CAP_RATIO;
      const body = new Path2D();
      body.moveTo(0, ry);
      body.lineTo(0, h - ry);
      body.ellipse(w / 2, h - ry, w / 2, ry, 0, Math.PI, 0, true);
      body.lineTo(w, ry);
      body.closePath();
      fillAndStroke(body);
      // Cap ellipse drawn AFTER the body so its own outline paints on top of (and hides) the flat
      // seam where the body path's top edge sits - matches WhiteboardCanvas.tsx's DOM rendering,
      // where the cap is a second <ellipse> element placed after the body path in the DOM.
      const cap = new Path2D();
      cap.ellipse(w / 2, ry, w / 2, ry, 0, 0, Math.PI * 2);
      fillAndStroke(cap);
      return;
    }
    case "path":
      fillAndStroke(new Path2D(outline.d));
      return;
    case "chart": {
      // One shared label painter for both the in-plot labels (drawn inside the inset translate) and
      // the title captions (drawn outside it) - see the ShapeOutline "chart" variant's own `inset`
      // doc comment for why those are two separate lists.
      const paintChartLabels = (labels: ChartLabel[]) => {
        const labelFontStyle = node.fontStyle === "italic" ? "italic " : "";
        ctx.textBaseline = "middle";
        for (const label of labels) {
          const size = node.fontSize * (label.fontScale ?? 1);
          const weight = (label.weight ?? node.fontWeight) === "bold" ? "bold " : "";
          ctx.font = `${labelFontStyle}${weight}${size}px ${node.fontFamily || "system-ui, sans-serif"}`;
          ctx.fillStyle = label.color ?? node.fontColor;
          // SVG's text-anchor="middle" is Canvas2D's textAlign="center" - everything else lines up.
          ctx.textAlign = label.anchor === "middle" ? "center" : label.anchor;
          // A rotated label (the y-axis caption) is drawn about its own anchor point, matching the
          // SVG renderer's rotate(deg, x, y): translate there, rotate, then draw at the origin.
          const rotated = Boolean(label.rotate);
          if (rotated) {
            ctx.save();
            ctx.translate(label.x, label.y);
            ctx.rotate((label.rotate! * Math.PI) / 180);
          }
          const tx = rotated ? 0 : label.x;
          const ty = rotated ? 0 : label.y;
          ctx.fillText(label.text, tx, ty);
          if (node.textDecoration === "underline") {
            const metrics = ctx.measureText(label.text);
            const underlineY = ty + size * 0.35;
            const startX = label.anchor === "start" ? tx : label.anchor === "end" ? tx - metrics.width : tx - metrics.width / 2;
            ctx.save();
            ctx.strokeStyle = label.color ?? node.fontColor;
            ctx.lineWidth = Math.max(1, size / 16);
            ctx.beginPath();
            ctx.moveTo(startX, underlineY);
            ctx.lineTo(startX + metrics.width, underlineY);
            ctx.stroke();
            ctx.restore();
          }
          if (rotated) ctx.restore();
        }
      };

      ctx.save();
      if (outline.inset) ctx.translate(outline.inset.dx, outline.inset.dy);
      for (const part of outline.parts) {
        const path = new Path2D(part.d);
        if (part.role === "fill") {
          if (node.fillColor) {
            ctx.fillStyle = node.fillColor;
            ctx.fill(path);
          }
        } else if (part.role === "marker") {
          ctx.fillStyle = node.strokeColor;
          ctx.fill(path);
        } else if (part.role === "slice") {
          ctx.fillStyle = part.color;
          ctx.fill(path);
          ctx.lineWidth = 1;
          ctx.strokeStyle = "#ffffff";
          ctx.stroke(path);
        } else if (part.role === "series") {
          ctx.lineWidth = Math.max(0.5, part.width);
          ctx.strokeStyle = part.color;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.stroke(path);
        } else if (part.role === "seriesFill") {
          ctx.save();
          ctx.globalAlpha = SERIES_FILL_OPACITY;
          ctx.fillStyle = part.color;
          ctx.fill(path);
          ctx.restore();
        } else if (part.role === "annotation") {
          // Filled for the marker glyphs, and stroked too so a leader line (a degenerate,
          // zero-area path that would fill to nothing) still shows.
          ctx.fillStyle = part.color;
          ctx.fill(path);
          ctx.lineWidth = 1;
          ctx.strokeStyle = part.color;
          ctx.stroke(path);
        } else if (part.role === "grid") {
          ctx.lineWidth = 0.5;
          ctx.strokeStyle = "#e5e7eb";
          ctx.stroke(path);
        } else {
          // "stroke" and "axis"
          ctx.lineWidth = part.role === "axis" ? 1 : Math.max(1, node.strokeWidth);
          ctx.strokeStyle = part.role === "axis" ? "#9ca3af" : node.strokeColor;
          ctx.stroke(path);
        }
      }
      if (outline.labels && outline.labels.length > 0) paintChartLabels(outline.labels);
      ctx.restore();
      if (outline.overlayLabels && outline.overlayLabels.length > 0) paintChartLabels(outline.overlayLabels);
      return;
    }
  }
}

function polylineOpenPath2D(points: [number, number][]): Path2D {
  const path = new Path2D();
  points.forEach(([px, py], i) => (i === 0 ? path.moveTo(px, py) : path.lineTo(px, py)));
  return path;
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

// Renders text in node-local coordinates (0,0 at top-left) - caller has already
// ctx.translate(node.x, node.y), same convention as paintShapeBody above.
function paintNodeText(ctx: CanvasRenderingContext2D, node: WhiteboardNode): void {
  if (!node.text) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, node.width, node.height);
  ctx.clip();
  ctx.fillStyle = node.fontColor;
  const fontStyle = node.fontStyle === "italic" ? "italic " : "";
  const fontWeight = node.fontWeight === "bold" ? "bold " : "";
  ctx.font = `${fontStyle}${fontWeight}${node.fontSize}px ${node.fontFamily || "system-ui, sans-serif"}`;
  ctx.textAlign = node.textAlign;
  ctx.textBaseline = "middle";
  const paddingX = 8;
  const lines = wrapText(ctx, node.text, node.width - paddingX * 2);
  const lineHeight = node.fontSize * 1.25;
  const totalHeight = lines.length * lineHeight;
  const startY =
    node.verticalAlign === "top"
      ? lineHeight / 2 + 4
      : node.verticalAlign === "bottom"
      ? node.height - totalHeight + lineHeight / 2 - 4
      : node.height / 2 - totalHeight / 2 + lineHeight / 2;
  const textX = node.textAlign === "left" ? paddingX : node.textAlign === "right" ? node.width - paddingX : node.width / 2;
  lines.forEach((line, i) => {
    const lineY = startY + i * lineHeight;
    ctx.fillText(line, textX, lineY);
    if (node.textDecoration === "underline") {
      const metrics = ctx.measureText(line);
      const underlineY = lineY + node.fontSize * 0.35;
      const startX = node.textAlign === "left" ? textX : node.textAlign === "right" ? textX - metrics.width : textX - metrics.width / 2;
      ctx.save();
      ctx.strokeStyle = node.fontColor;
      ctx.lineWidth = Math.max(1, node.fontSize / 16);
      ctx.beginPath();
      ctx.moveTo(startX, underlineY);
      ctx.lineTo(startX + metrics.width, underlineY);
      ctx.stroke();
      ctx.restore();
    }
  });
  ctx.restore();
}

// Builds a rasterized image of `node`'s KaTeX-typeset formula (WhiteboardNode.text, holding the raw
// LaTeX source - see the "equation" shapeType's own doc comment) via an SVG <foreignObject>, the
// standard way to get real HTML/CSS layout (which is how KaTeX itself renders - not SVG paths, not
// something Path2D/ctx.fillText could reproduce) into a Canvas2D bitmap: serialize an SVG wrapping
// the KaTeX HTML output, load it as an <img> (an inherently async step - there is no synchronous way
// to rasterize SVG/HTML in a browser), then this is just ctx.drawImage like any other image. Relies
// on katex/dist/katex.min.css already being loaded in the document (see WhiteboardEditor.tsx's own
// import of it) for the math fonts to resolve correctly - the one place in this whole file that
// depends on something outside its own node-local drawing calls.
async function paintEquation(ctx: CanvasRenderingContext2D, node: WhiteboardNode): Promise<void> {
  const source = node.text?.trim();
  if (!source) return;
  let html: string;
  try {
    html = katex.renderToString(source, { throwOnError: false, displayMode: true, output: "html" });
  } catch {
    return; // throwOnError:false already covers malformed LaTeX; this only guards a truly unexpected throw
  }
  const justify = node.textAlign === "left" ? "flex-start" : node.textAlign === "right" ? "flex-end" : "center";
  const align = node.verticalAlign === "top" ? "flex-start" : node.verticalAlign === "bottom" ? "flex-end" : "center";
  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${node.width}" height="${node.height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;display:flex;align-items:${align};justify-content:${justify};box-sizing:border-box;padding:0 8px;font-size:${node.fontSize}px;color:${node.fontColor};overflow:visible;">${html}</div></foreignObject></svg>`;
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
  const img = new Image();
  await new Promise<void>((resolve) => {
    img.onload = () => resolve();
    // A single malformed export shouldn't hang the whole PNG - drawImage below just no-ops on a
    // never-loaded image.
    img.onerror = () => resolve();
    img.src = dataUrl;
  });
  ctx.drawImage(img, 0, 0, node.width, node.height);
}

// Draws a "table" node's full content (background, header shading, grid lines, per-cell text) for
// PNG export - unlike "latticeGauge" (a live WebGL scene with no flat-drawing equivalent to fall
// back to except a live DOM canvas grab), everything a table shows on-screen IS representable in
// Canvas2D, so this reproduces WhiteboardTable.tsx's own layout exactly rather than settling for
// shapeOutlineFor's simplified grid-lines-only glyph.
function paintTable(ctx: CanvasRenderingContext2D, node: WhiteboardNode): void {
  const grid = resolveTableGrid(node);
  const { width: w, height: h } = node;
  const colBounds = [0];
  for (const f of grid.colWidths) colBounds.push(colBounds[colBounds.length - 1] + f * w);
  const rowBounds = [0];
  for (const f of grid.rowHeights) rowBounds.push(rowBounds[rowBounds.length - 1] + f * h);
  const headerRow = node.tableHeaderRow ?? true;

  // Same anchor/covered bookkeeping as WhiteboardTable.tsx's own render loop (see its doc comment) -
  // a merged region draws (and gets clicked/edited) as one cell stretched over its neighbors, so
  // the export has to skip both the interior grid lines and the covered cells' own (possibly stale)
  // text the same way the live view does.
  const mergeAt = new Map<string, TableMergedCell>();
  const covered = new Set<string>();
  for (const m of grid.mergedCells) {
    mergeAt.set(`${m.row}-${m.col}`, m);
    for (let rr = m.row; rr < m.row + m.rowSpan; rr++)
      for (let cc = m.col; cc < m.col + m.colSpan; cc++) if (!(rr === m.row && cc === m.col)) covered.add(`${rr}-${cc}`);
  }

  // Background - per-cell override (WhiteboardNode.tableCellFill) falling back to the table's own
  // fillColor, same as WhiteboardTable.tsx's own per-cell backgroundColor.
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      if (covered.has(`${r}-${c}`)) continue;
      const merge = mergeAt.get(`${r}-${c}`);
      const spanRows = merge?.rowSpan ?? 1;
      const spanCols = merge?.colSpan ?? 1;
      const fill = grid.cellFill[r][c] ?? node.fillColor;
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(colBounds[c], rowBounds[r], colBounds[c + spanCols] - colBounds[c], rowBounds[r + spanRows] - rowBounds[r]);
      }
    }
  }
  if (headerRow && grid.rows > 0) {
    ctx.fillStyle = "rgba(0,0,0,0.06)";
    ctx.fillRect(0, 0, w, rowBounds[1]);
  }
  // The table's own outer edges - always the plain uniform stroke (same limitation
  // WhiteboardTable.tsx's own dedicated outer-border overlay div has: a per-cell override on an
  // OUTER edge can still ADD a dashed/dotted line on top of this, but can't erase it via "none" -
  // see this function's own per-cell pass below).
  if (node.strokeWidth > 0) {
    ctx.lineWidth = node.strokeWidth;
    ctx.strokeStyle = node.strokeColor;
    ctx.setLineDash([]);
    ctx.strokeRect(0, 0, w, h);
  }
  // Per-cell interior grid lines - each honoring its own tableCellBorders override where present
  // (dashed/dotted line style, or "none" to remove an interior line entirely), else the ordinary
  // uniform solid stroke. Only right/bottom draw by DEFAULT (the near edge is always some other
  // cell's own far edge, or the outer rect above - same "each cell draws its own right/bottom only"
  // convention WhiteboardTable.tsx's CSS borders use); top/left only ever draw when explicitly
  // overridden to something visibly different from that invisible default.
  const dashFor = (style: TableBorderStyle): number[] => (style === "dashed" ? [6, 4] : style === "dotted" ? [1.5, 3] : []);
  const strokeSide = (style: TableBorderStyle, x1: number, y1: number, x2: number, y2: number) => {
    if (style === "none") return;
    ctx.lineWidth = node.strokeWidth > 0 ? node.strokeWidth : 1;
    ctx.strokeStyle = node.strokeColor;
    ctx.setLineDash(dashFor(style));
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      if (covered.has(`${r}-${c}`)) continue;
      const merge = mergeAt.get(`${r}-${c}`);
      const spanRows = merge?.rowSpan ?? 1;
      const spanCols = merge?.colSpan ?? 1;
      const right = colBounds[c + spanCols];
      const bottom = rowBounds[r + spanRows];
      const overrides = grid.cellBorders[r][c];
      // A boundary has two owners - this cell's own right/bottom (default side) and the touching
      // neighbor's left/top (override-only, per the comment above). If that neighbor already claims
      // the boundary via an explicit override, this cell's own default must NOT also draw it, or the
      // export doubles up a solid line right alongside the neighbor's dashed/dotted one - same fix as
      // WhiteboardTable.tsx's own sideBorder().
      const neighborOverride = (nr: number, nc: number, side: "top" | "left"): TableBorderStyle | undefined => {
        if (covered.has(`${nr}-${nc}`)) return undefined;
        const o = grid.cellBorders[nr]?.[nc]?.[side];
        return o && o !== "solid" ? o : undefined;
      };
      const rightStyle =
        overrides.right ?? (c + spanCols < grid.cols && node.strokeWidth > 0 && !neighborOverride(r, c + spanCols, "left") ? "solid" : "none");
      strokeSide(rightStyle, right, rowBounds[r], right, bottom);
      const bottomStyle =
        overrides.bottom ?? (r + spanRows < grid.rows && node.strokeWidth > 0 && !neighborOverride(r + spanRows, c, "top") ? "solid" : "none");
      strokeSide(bottomStyle, colBounds[c], bottom, right, bottom);
      if (overrides.top === "dashed" || overrides.top === "dotted") strokeSide(overrides.top, colBounds[c], rowBounds[r], right, rowBounds[r]);
      if (overrides.left === "dashed" || overrides.left === "dotted") strokeSide(overrides.left, colBounds[c], rowBounds[r], colBounds[c], bottom);
    }
  }
  ctx.setLineDash([]);

  ctx.fillStyle = node.fontColor;
  ctx.textBaseline = "middle";
  ctx.textAlign = node.textAlign;
  const paddingX = 6;
  for (let r = 0; r < grid.rows; r++) {
    const isHeaderRow = headerRow && r === 0;
    const fontStyle = node.fontStyle === "italic" ? "italic " : "";
    const fontWeight = isHeaderRow || node.fontWeight === "bold" ? "bold " : "";
    ctx.font = `${fontStyle}${fontWeight}${node.fontSize}px ${node.fontFamily || "system-ui, sans-serif"}`;
    for (let c = 0; c < grid.cols; c++) {
      if (covered.has(`${r}-${c}`)) continue;
      const text = grid.cellText[r][c];
      if (!text) continue;
      const merge = mergeAt.get(`${r}-${c}`);
      const spanRows = merge?.rowSpan ?? 1;
      const spanCols = merge?.colSpan ?? 1;
      const cellW = colBounds[c + spanCols] - colBounds[c];
      const cellH = rowBounds[r + spanRows] - rowBounds[r];
      ctx.save();
      ctx.beginPath();
      ctx.rect(colBounds[c], rowBounds[r], cellW, cellH);
      ctx.clip();
      const x = node.textAlign === "left" ? colBounds[c] + paddingX : node.textAlign === "right" ? colBounds[c] + cellW - paddingX : colBounds[c] + cellW / 2;
      const lineHeight = node.fontSize * 1.25;
      const lines = wrapText(ctx, text, cellW - paddingX * 2);
      const totalHeight = lines.length * lineHeight;
      const startY =
        node.verticalAlign === "top"
          ? rowBounds[r] + lineHeight / 2 + 2
          : node.verticalAlign === "bottom"
          ? rowBounds[r] + cellH - totalHeight + lineHeight / 2 - 2
          : rowBounds[r] + cellH / 2 - totalHeight / 2 + lineHeight / 2;
      lines.forEach((line, i) => ctx.fillText(line, x, startY + i * lineHeight));
      ctx.restore();
    }
  }
}

async function renderNode(ctx: CanvasRenderingContext2D, node: WhiteboardNode, imageSrcFor?: ImageSrcResolver): Promise<void> {
  ctx.save();
  ctx.translate(node.x, node.y);
  // Matches WhiteboardCanvas.tsx's own `transform: rotate(deg) scaleX(-1) scaleY(-1); transform-
  // origin: center` - rotate then flip about the box's own center (ctx.rotate called BEFORE
  // ctx.scale, so - per how Canvas2D composes transforms - the flip applies to local points first,
  // rotation second, the same order that CSS transform list produces), then shift back so
  // everything drawn below (all in node-local 0,0-w,h space) doesn't need to know either happened.
  if (node.rotation || node.flipHorizontal || node.flipVertical) {
    ctx.translate(node.width / 2, node.height / 2);
    if (node.rotation) ctx.rotate((node.rotation * Math.PI) / 180);
    if (node.flipHorizontal || node.flipVertical) ctx.scale(node.flipHorizontal ? -1 : 1, node.flipVertical ? -1 : 1);
    ctx.translate(-node.width / 2, -node.height / 2);
  }
  if (node.shapeType === "freehand") {
    const path = freehandPath2D(node);
    ctx.lineWidth = node.strokeWidth;
    ctx.strokeStyle = node.strokeColor;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(path);
    // A "Freehand Arrow" (see whiteboardTypes.ts's WhiteboardNode.endArrowType doc comment) caps
    // one or both ends with a marker, angled off the stroke's own final two points (a close-enough
    // stand-in for the smoothed curve's true end tangent - freehandPath2D's own last segment is a
    // plain line to that final point anyway, so this matches exactly).
    const pts = (node.points ?? []).map((p) => ({ x: p.x * node.width, y: p.y * node.height }));
    if (pts.length >= 2) {
      const last = pts[pts.length - 1];
      const beforeLast = pts[pts.length - 2];
      const endDeg = (Math.atan2(last.y - beforeLast.y, last.x - beforeLast.x) * 180) / Math.PI;
      drawArrowhead(ctx, node.endArrowType ?? "none", last.x, last.y, endDeg, node.strokeColor, node.strokeWidth);
      const first = pts[0];
      const afterFirst = pts[1];
      const startDeg = (Math.atan2(first.y - afterFirst.y, first.x - afterFirst.x) * 180) / Math.PI;
      drawArrowhead(ctx, node.startArrowType ?? "none", first.x, first.y, startDeg, node.strokeColor, node.strokeWidth);
    }
  } else if (node.shapeType === "equation") {
    // Card/background/border first (shapeOutlineFor already resolves "equation" to the same plain
    // "rect" kind as "rectangle"/"text" - see its own doc comment), THEN the typeset formula drawn
    // on top - matches WhiteboardCanvas.tsx's own div-then-EquationDisplay stacking order.
    paintShapeBody(ctx, node);
    await paintEquation(ctx, node);
  } else if (node.shapeType === "vector") {
    // A plain horizontal line spanning the node's own width (length = magnitude - see the
    // shapeType's own doc comment) capped with real arrowhead markers, matching
    // WhiteboardCanvas.tsx's own <marker>-based rendering. 0deg/180deg (not computed) since the
    // line is always exactly horizontal in local space - direction comes entirely from the
    // rotation ctx.rotate already applied above.
    const midY = node.height / 2;
    ctx.lineWidth = node.strokeWidth;
    ctx.strokeStyle = node.strokeColor;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(node.width, midY);
    ctx.stroke();
    drawArrowhead(ctx, node.endArrowType ?? "none", node.width, midY, 0, node.strokeColor, node.strokeWidth);
    drawArrowhead(ctx, node.startArrowType ?? "none", 0, midY, 180, node.strokeColor, node.strokeWidth);
    paintNodeText(ctx, node);
  } else if (node.shapeType === "latticeGauge") {
    // Not just shapeOutlineFor's own placeholder glyph (a static, doesn't-look-like-anything-real
    // icon) when this node's widget is actually mounted live in the page being exported - grab an
    // ACTUAL frame of its WebGL canvas instead. LatticeGaugeWidget.tsx tags its own canvas element
    // with this exact attribute for precisely this lookup. Its renderer does NOT keep
    // `preserveDrawingBuffer: true` (that would mean paying to retain every past frame's buffer
    // forever, just for this occasional read - see its own doc comment), so a stale/blank buffer
    // this long after its animation loop's own last render() is called for here instead: forcing
    // exactly one fresh render() synchronously, in the same tick as the drawImage read right below
    // it, via latticeRenderOnDemand's callback for this node. Falls back to the placeholder glyph
    // if no live canvas exists to read (this page isn't the one currently open, or WebGL failed) -
    // same DOM-reachability caveat every other export/thumbnail call site already has (they only
    // ever run against the page actually open in the editor, so this lookup succeeds in the cases
    // that matter).
    const liveCanvas = document.querySelector<HTMLCanvasElement>(`canvas[data-lattice-node-id="${node.id}"]`);
    if (liveCanvas && liveCanvas.width > 0 && liveCanvas.height > 0) {
      latticeRenderOnDemand.get(node.id)?.();
      ctx.drawImage(liveCanvas, 0, 0, node.width, node.height);
    } else {
      paintShapeBody(ctx, node);
    }
  } else if (node.shapeType === "table") {
    paintTable(ctx, node);
  } else if (node.shapeType === "image") {
    // renderWhiteboardToCanvas has already awaited every image node's decode before reaching here,
    // so this cache lookup is a hit for any asset that exists; anything still missing (deleted from
    // disk, corrupt) draws paintImageNode's placeholder rather than failing the whole export.
    const src = imageSrcFor?.(node) ?? null;
    const decoded = src ? getCachedWhiteboardImage(src) : null;
    paintImageNode(ctx, node, decoded, decoded?.naturalWidth ?? 0, decoded?.naturalHeight ?? 0);
  } else {
    if (node.shapeType !== "text") paintShapeBody(ctx, node);
    paintNodeText(ctx, node);
  }
  ctx.restore();
}

// Renders one arrowhead marker at (x, y), oriented along angleDeg (0 = pointing +x, matching
// edgeEndAngleDeg's convention) - see whiteboardTypes.ts's ArrowheadType doc comment for what each
// type looks like. Geometry here is hand-tuned to visually match the SVG <marker> defs
// WhiteboardCanvas.tsx builds for the same types (see its markerContentFor), so the live view and
// the exported PNG show the same arrowheads.
function drawArrowhead(ctx: CanvasRenderingContext2D, type: ArrowheadType, x: number, y: number, angleDeg: number, color: string, edgeStrokeWidth: number): void {
  if (type === "none") return;
  const rad = (angleDeg * Math.PI) / 180;
  const size = 8 + Math.min(10, edgeStrokeWidth * 1.5);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rad);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  switch (type) {
    case "triangle": {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-size, size * 0.5);
      ctx.lineTo(-size, -size * 0.5);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "block": {
      const s = size * 1.15;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-s, s * 0.55);
      ctx.lineTo(-s * 0.7, 0);
      ctx.lineTo(-s, -s * 0.55);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "triangleOpen": {
      ctx.beginPath();
      ctx.moveTo(-size, size * 0.55);
      ctx.lineTo(0, 0);
      ctx.lineTo(-size, -size * 0.55);
      ctx.lineWidth = Math.max(1.5, edgeStrokeWidth);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      break;
    }
    case "diamond": {
      const s = size * 0.55;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-s, s * 0.65);
      ctx.lineTo(-2 * s, 0);
      ctx.lineTo(-s, -s * 0.65);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "circle": {
      const r = size * 0.42;
      ctx.beginPath();
      ctx.arc(-r, 0, r, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

const DASH_PATTERNS: Record<WhiteboardEdge["strokeStyle"], number[]> = {
  solid: [],
  dashed: [8, 6],
  dotted: [1.5, 5],
};

function renderEdge(ctx: CanvasRenderingContext2D, edge: WhiteboardEdge, nodesById: Map<string, WhiteboardNode>): void {
  const { source, target } = resolveEdgeEndpoints(edge, nodesById);
  const bow = edge.curveBow ?? DEFAULT_CURVE_BOW;
  const waypoints = edge.waypoints ?? [];
  const path = new Path2D(buildEdgePath(source, target, edge.routing, bow, waypoints));
  ctx.lineWidth = edge.strokeWidth;
  ctx.strokeStyle = edge.strokeColor;
  ctx.lineCap = edge.strokeStyle === "dotted" ? "round" : "butt";
  const pattern = DASH_PATTERNS[edge.strokeStyle];
  ctx.setLineDash(edge.strokeStyle === "dotted" ? pattern.map((n) => n * (edge.strokeWidth / 2 || 1)) : pattern);
  ctx.stroke(path);
  ctx.setLineDash([]);
  ctx.lineCap = "butt";

  const { startDeg, endDeg } = edgeEndAngleDeg(source, target, edge.routing, source.side, target.side, bow, waypoints);
  drawArrowhead(ctx, edge.endArrowType, target.x, target.y, endDeg, edge.strokeColor, edge.strokeWidth);
  drawArrowhead(ctx, edge.startArrowType, source.x, source.y, startDeg, edge.strokeColor, edge.strokeWidth);
}

// Flattens one page onto an offscreen canvas sized to its content bounds (see computeContentBounds)
// - the Whiteboard equivalent of boardHandlers.ts's renderBoardToCanvas, used by WhiteboardEditor's
// "Export PNG" action (current page only) and (with `maxDimension` set) its home-grid thumbnail,
// same "one renderer, two call sites" convention as BoardEditor.tsx's own renderOffscreen.
// Async only because of "equation" nodes (see paintEquation's own doc comment for why rasterizing
// typeset math has no synchronous path) - every existing caller already awaits this inside an async
// handler (export/save-as/thumbnail), so this didn't need to change anything at those call sites
// beyond adding `await`.
// Maps an "image" node to the URL its asset is served from. Supplied by the caller rather than
// derived here because it needs the Briefcast library root and the whiteboard's own id - neither of
// which this pure module knows, and neither of which it should have to learn just to draw a photo.
// Omitting it (the thumbnail path for a whiteboard with no images, say) simply renders every image
// node as its missing-asset placeholder.
export type ImageSrcResolver = (node: WhiteboardNode) => string | null;

export async function renderWhiteboardToCanvas(page: WhiteboardPage, maxDimension?: number, imageSrcFor?: ImageSrcResolver): Promise<HTMLCanvasElement> {
  const bounds = computeContentBounds(page);
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

  // Decode every image asset BEFORE painting anything. renderNode is synchronous once it reaches a
  // given node's draw call, so an undecoded bitmap there would export as a placeholder - doing it
  // here (rather than leaving it to each caller) means no export path can forget to, and unlike the
  // per-node rendering below these genuinely are independent, so they run concurrently. A rejection
  // is swallowed deliberately: a single missing asset should cost that one node its placeholder, not
  // fail the whole export.
  if (imageSrcFor) {
    const srcs = new Set<string>();
    for (const node of page.nodes) {
      if (node.shapeType !== "image") continue;
      const src = imageSrcFor(node);
      if (src) srcs.add(src);
    }
    await Promise.all([...srcs].map((src) => preloadWhiteboardImage(src).catch(() => null)));
  }

  const nodesById = new Map(page.nodes.map((n) => [n.id, n]));
  for (const edge of page.edges) renderEdge(ctx, edge, nodesById);
  // Sequential awaits, not Promise.all - every node shares this one ctx (save/translate/restore),
  // so two renderNode calls running concurrently would interleave their transform stacks.
  for (const node of page.nodes) await renderNode(ctx, node, imageSrcFor);

  return canvas;
}
