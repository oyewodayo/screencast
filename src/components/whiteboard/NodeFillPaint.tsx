// components/whiteboard/NodeFillPaint.tsx
//
// The live-canvas side of a node's fill paint - gradients, image fills and pattern overlays (see
// whiteboardTypes.ts's WhiteboardNode.fillType/fillPattern). Each paint becomes an SVG paint server
// (<linearGradient>/<radialGradient>/<pattern>) referenced by url(#id) from the shape's own
// element, so it is clipped to whatever outline the shape has - polygon, rounded path, cylinder -
// with no clip-path bookkeeping of our own. Every coordinate comes from the same helpers the
// Canvas2D export uses (whiteboardHandlers.ts's linearGradientPoints/fillPatternTile/
// fillImageRect), which is what keeps an exported PNG pixel-matched to the canvas.
//
// A plain solid fill with no pattern - every node predating this feature, and still the common
// case - takes none of this: nodeFillPaint returns the bare color and renders no <defs> at all, so
// a board of hundreds of ordinary shapes pays nothing for the feature existing.
import React from "react";
import {
  DEFAULT_FILL_PATTERN_OPACITY,
  DEFAULT_FILL_PATTERN_SPACING,
  DEFAULT_GRADIENT_ANGLE,
  WhiteboardNode,
  resolveFillType,
  resolveGradientStops,
  resolveNodeFill,
} from "../../utils/whiteboardTypes";
import { fillPatternTile, linearGradientPoints } from "../../handlers/whiteboardHandlers";

export interface FillPaint {
  fill: string;
  fillOpacity?: number;
  // Pattern overlay paint (url(#...)) and its opacity, or null for no pattern.
  overlay: string | null;
  overlayOpacity: number;
  defs: React.ReactNode | null;
}

const IMAGE_ASPECT: Record<NonNullable<WhiteboardNode["fillImageFit"]>, string> = {
  cover: "xMidYMid slice",
  contain: "xMidYMid meet",
  fill: "none",
};

export function nodeFillPaint(node: WhiteboardNode, imageSrc: string | null): FillPaint {
  const type = resolveFillType(node);
  const pattern = node.fillPattern ?? "none";
  if (type === "solid" && pattern === "none") {
    return { fill: resolveNodeFill(node) ?? "none", overlay: null, overlayOpacity: 0, defs: null };
  }

  const { width: w, height: h } = node;
  const fillId = `wbfill-${node.id}`;
  const patternId = `wbpat-${node.id}`;
  const opacity = Math.max(0, Math.min(1, node.fillOpacity ?? 1));
  let fill = resolveNodeFill(node) ?? "none";
  let fillOpacity: number | undefined;
  let fillDef: React.ReactNode = null;

  if (type === "linear" || type === "radial") {
    const stops = resolveGradientStops(node).map((s, i) => <stop key={i} offset={s.offset} stopColor={s.color} />);
    if (type === "linear") {
      const p = linearGradientPoints(w, h, node.fillGradientAngle ?? DEFAULT_GRADIENT_ANGLE);
      fillDef = (
        <linearGradient id={fillId} gradientUnits="userSpaceOnUse" x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2}>
          {stops}
        </linearGradient>
      );
    } else {
      // Unit circle scaled to the box - an ellipse fitted to the node's sides regardless of the
      // outline's own bounding box (objectBoundingBox would fit a triangle's bbox, not the node's).
      fillDef = (
        <radialGradient id={fillId} gradientUnits="userSpaceOnUse" cx={0} cy={0} r={1} gradientTransform={`translate(${w / 2},${h / 2}) scale(${Math.max(w, 1e-3) / 2},${Math.max(h, 1e-3) / 2})`}>
          {stops}
        </radialGradient>
      );
    }
    fill = `url(#${fillId})`;
    fillOpacity = opacity;
  } else if (type === "image") {
    const fit = node.fillImageFit ?? "cover";
    fillDef = (
      <pattern id={fillId} patternUnits="userSpaceOnUse" x={0} y={0} width={w} height={h}>
        {fit === "contain" && node.fillColor && <rect width={w} height={h} fill={node.fillColor} />}
        {imageSrc ? (
          <image href={imageSrc} x={0} y={0} width={w} height={h} preserveAspectRatio={IMAGE_ASPECT[fit]} />
        ) : (
          <rect width={w} height={h} fill={node.fillColor ?? "#f3f4f6"} />
        )}
      </pattern>
    );
    fill = `url(#${fillId})`;
    fillOpacity = opacity;
  }

  let patternDef: React.ReactNode = null;
  if (pattern !== "none") {
    const spacing = Math.max(4, node.fillPatternSpacing ?? DEFAULT_FILL_PATTERN_SPACING);
    const tile = fillPatternTile(pattern, spacing);
    const color = node.fillPatternColor ?? node.strokeColor;
    patternDef = (
      <pattern id={patternId} patternUnits="userSpaceOnUse" x={0} y={0} width={spacing} height={spacing}>
        {tile.dots ? <path d={tile.d} fill={color} /> : <path d={tile.d} fill="none" stroke={color} strokeWidth={1} />}
      </pattern>
    );
  }

  return {
    fill,
    fillOpacity,
    overlay: pattern !== "none" ? `url(#${patternId})` : null,
    overlayOpacity: Math.max(0, Math.min(1, node.fillPatternOpacity ?? DEFAULT_FILL_PATTERN_OPACITY)),
    defs: (
      <defs>
        {fillDef}
        {patternDef}
      </defs>
    ),
  };
}

type ShapeDrawProps = { fill: string; fillOpacity?: number; opacity?: number; stroke?: string; strokeWidth?: number };

// Draws one shape element with its fill paint and stroke. With a pattern overlay the single element
// splits into three passes - fill, pattern, then the stroke alone on top - so the faint pattern never
// tints the inner half of the outline the way drawing it last over a stroked element would.
export function PaintedShape({
  paint,
  stroke,
  strokeWidth,
  draw,
}: {
  paint: FillPaint;
  stroke: string;
  strokeWidth: number;
  draw: (props: ShapeDrawProps) => React.ReactElement;
}) {
  if (!paint.overlay) return draw({ fill: paint.fill, fillOpacity: paint.fillOpacity, stroke, strokeWidth });
  return (
    <>
      {draw({ fill: paint.fill, fillOpacity: paint.fillOpacity, stroke: "none" })}
      {draw({ fill: paint.overlay, opacity: paint.overlayOpacity, stroke: "none" })}
      {draw({ fill: "none", stroke, strokeWidth })}
    </>
  );
}
