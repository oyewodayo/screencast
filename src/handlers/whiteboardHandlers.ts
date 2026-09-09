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

import {
  ArrowheadType,
  WhiteboardAnchorSide,
  WhiteboardCommand,
  WhiteboardEdge,
  WhiteboardEndpoint,
  WhiteboardNode,
  WhiteboardPage,
  WhiteboardShapeType,
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
  | { kind: "path"; d: string };

export interface ShapeOutlineOptions {
  sides?: number; // "polygon" only
  starPoints?: number; // "star" only
  starInnerRadiusRatio?: number; // "star" only
  waveStyle?: WhiteboardNode["waveStyle"]; // "wave" only
  waveCycles?: number; // "wave" only
  angleDegrees?: number; // "angle" only
  angleRay1Length?: number; // "angle" only
  angleRay2Length?: number; // "angle" only
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

export function shapeOutlineFor(shapeType: WhiteboardShapeType, w: number, h: number, opts?: ShapeOutlineOptions): ShapeOutline {
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
    case "rectangle":
    case "text":
    case "freehand":
    default:
      return { kind: "rect" };
  }
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
  const outline = shapeOutlineFor(node.shapeType, w, h, {
    sides: node.sides,
    starPoints: node.starPoints,
    starInnerRadiusRatio: node.starInnerRadiusRatio,
    waveStyle: node.waveStyle,
    waveCycles: node.waveCycles,
    angleDegrees: node.angleDegrees,
    angleRay1Length: node.angleRay1Length,
    angleRay2Length: node.angleRay2Length,
  });

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

function renderNode(ctx: CanvasRenderingContext2D, node: WhiteboardNode): void {
  ctx.save();
  ctx.translate(node.x, node.y);
  // Matches WhiteboardCanvas.tsx's own `transform: rotate(deg); transform-origin: center` - rotate
  // about the box's own center, then shift back so everything drawn below (all in node-local
  // 0,0-w,h space) doesn't need to know rotation happened at all.
  if (node.rotation) {
    ctx.translate(node.width / 2, node.height / 2);
    ctx.rotate((node.rotation * Math.PI) / 180);
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
export function renderWhiteboardToCanvas(page: WhiteboardPage, maxDimension?: number): HTMLCanvasElement {
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

  const nodesById = new Map(page.nodes.map((n) => [n.id, n]));
  for (const edge of page.edges) renderEdge(ctx, edge, nodesById);
  for (const node of page.nodes) renderNode(ctx, node);

  return canvas;
}
