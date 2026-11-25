// handlers/whiteboardInterchangeHandlers.ts
//
// Pure, zero-DOM interchange & diagram conversion handlers for Phase 5:
// - Vector SVG export (resolution-independent standalone .svg matching Canvas2D export)
// - Markdown outline -> Mind Map generator (supports headings, indented bullets, [x] checkboxes,
//   and inline [label](url) resource links + automatic layout)
// - Mind Map -> Markdown outline exporter (for pasting straight into Briefcast Docs)
// - Mermaid flowchart/graph -> Native Whiteboard importer (shapes, edge labels/styles, subgraphs
//   as Containment Frames, and layered topological layout)
// - 1-click Switch Shape type conversion preserving text, geometry, and connections

import { MINDMAP_PALETTE, MindmapColorKey, MindmapResource } from "../utils/mindmapTypes";
import {
  ArrowheadType,
  createDefaultWhiteboardEdge,
  createDefaultWhiteboardNode,
  isArtboardNode,
  isMindmapTopicNode,
  resolveNodeFill,
  WhiteboardEdge,
  WhiteboardNode,
  WhiteboardPage,
  WhiteboardShapeType,
} from "../utils/whiteboardTypes";
import {
  buildEdgePath,
  computeContentBounds,
  CYLINDER_CAP_RATIO,
  dashArrayFor,
  DEFAULT_CURVE_BOW,
  edgePointAtFraction,
  outlineOptionsFor,
  resolveEdgeEndpoints,
  resolvePageLayerOrder,
  SERIES_FILL_OPACITY,
  shapeOutlineFor,
} from "./whiteboardHandlers";
import {
  applyMindmapPaletteKey,
  autoLayoutMindmap,
  getCollapsedState,
  MindmapLayoutMode,
} from "./whiteboardMindmapHandlers";
import { buildTaperedFreehandPathD } from "./whiteboardFreehand";

// ---- XML / SVG helpers -------------------------------------------------------------------------

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function svgMarkerId(type: Exclude<ArrowheadType, "none">, color: string): string {
  return `m-${type}-${color.replace(/[^a-zA-Z0-9]/g, "")}`;
}

function svgMarkerDef(type: Exclude<ArrowheadType, "none">, color: string): string {
  const id = svgMarkerId(type, color);
  let body = "";
  let refX = 8.5;
  switch (type) {
    case "triangle":
      body = `<path d="M0,0 L10,5 L0,10 Z" fill="${escXml(color)}"/>`;
      break;
    case "block":
      body = `<path d="M0,0 L10,5 L0,10 L3,5 Z" fill="${escXml(color)}"/>`;
      break;
    case "triangleOpen":
      body = `<path d="M2,0 L10,5 L2,10" fill="none" stroke="${escXml(color)}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case "diamond":
      refX = 9;
      body = `<path d="M0,5 L5,1.5 L10,5 L5,8.5 Z" fill="${escXml(color)}"/>`;
      break;
    case "circle":
      refX = 9;
      body = `<circle cx="6" cy="5" r="4" fill="${escXml(color)}"/>`;
      break;
  }
  return `<marker id="${id}" markerWidth="10" markerHeight="10" refX="${refX}" refY="5" orient="auto" markerUnits="userSpaceOnUse">${body}</marker>`;
}

function wrapSimpleLines(text: string, maxChars: number): string[] {
  const limit = Math.max(6, Math.floor(maxChars));
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      if (!line) {
        line = w;
      } else if (line.length + 1 + w.length <= limit) {
        line += " " + w;
      } else {
        out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function renderNodeSvg(node: WhiteboardNode): string {
  const parts: string[] = [];
  const transforms: string[] = [`translate(${node.x.toFixed(2)},${node.y.toFixed(2)})`];
  if (node.rotation || node.flipHorizontal || node.flipVertical) {
    const cx = node.width / 2;
    const cy = node.height / 2;
    transforms.push(`translate(${cx.toFixed(2)},${cy.toFixed(2)})`);
    if (node.rotation) transforms.push(`rotate(${node.rotation})`);
    if (node.flipHorizontal || node.flipVertical) {
      transforms.push(`scale(${node.flipHorizontal ? -1 : 1},${node.flipVertical ? -1 : 1})`);
    }
    transforms.push(`translate(${(-cx).toFixed(2)},${(-cy).toFixed(2)})`);
  }

  const fill = resolveNodeFill(node) ?? "none";
  const stroke = node.strokeWidth > 0 ? node.strokeColor : "none";
  const sw = node.strokeWidth;
  const dash = dashArrayFor(node.strokeStyle, sw);
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
  const strokeOpacityAttr = node.strokeOpacity !== undefined && node.strokeOpacity < 1 ? ` stroke-opacity="${node.strokeOpacity}"` : "";
  const opacityAttr = node.opacity !== undefined && node.opacity < 1 ? ` opacity="${node.opacity}"` : "";
  const blendAttr = node.blendMode && node.blendMode !== "normal" ? ` style="mix-blend-mode:${node.blendMode}"` : "";

  parts.push(`<g transform="${transforms.join(" ")}"${opacityAttr}${blendAttr}>`);

  if (node.shapeType === "freehand") {
    const pts = (node.points ?? []).map((p) => ({ x: p.x * node.width, y: p.y * node.height }));
    const hasArrows =
      (node.endArrowType !== undefined && node.endArrowType !== "none") ||
      (node.startArrowType !== undefined && node.startArrowType !== "none");
    const useTapered = !hasArrows && node.strokeStyle !== "dashed" && node.strokeStyle !== "dotted" && pts.length >= 2;
    if (useTapered) {
      const taperedD = buildTaperedFreehandPathD(pts, sw, Boolean(node.freehandHighlighter));
      const fillOpacityAttr = node.strokeOpacity !== undefined && node.strokeOpacity < 1 ? ` fill-opacity="${node.strokeOpacity}"` : "";
      if (taperedD) {
        parts.push(`<path d="${taperedD}" fill="${escXml(node.strokeColor)}"${fillOpacityAttr}/>`);
      }
    } else if (pts.length > 0) {
      let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
      const mEnd = node.endArrowType && node.endArrowType !== "none" ? ` marker-end="url(#${svgMarkerId(node.endArrowType, node.strokeColor)})"` : "";
      const mStart = node.startArrowType && node.startArrowType !== "none" ? ` marker-start="url(#${svgMarkerId(node.startArrowType, node.strokeColor)})"` : "";
      parts.push(`<path d="${d}" fill="none" stroke="${escXml(node.strokeColor)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dashAttr}${strokeOpacityAttr}${mStart}${mEnd}/>`);
    }
  } else if (node.shapeType === "vector") {
    const midY = node.height / 2;
    const mEnd = node.endArrowType && node.endArrowType !== "none" ? ` marker-end="url(#${svgMarkerId(node.endArrowType, node.strokeColor)})"` : "";
    const mStart = node.startArrowType && node.startArrowType !== "none" ? ` marker-start="url(#${svgMarkerId(node.startArrowType, node.strokeColor)})"` : "";
    parts.push(`<line x1="0" y1="${midY}" x2="${node.width}" y2="${midY}" stroke="${escXml(node.strokeColor)}" stroke-width="${sw}" stroke-linecap="round"${dashAttr}${mStart}${mEnd}/>`);
  } else if (node.shapeType !== "text" || node.fillColor || node.strokeWidth > 0) {
    const outline = shapeOutlineFor(node.shapeType, node.width, node.height, outlineOptionsFor(node));
    if (outline.kind === "rect") {
      const rx = Math.max(0, node.cornerRadius ?? 0);
      parts.push(`<rect x="0" y="0" width="${node.width}" height="${node.height}" rx="${rx}" ry="${rx}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="${sw}"${dashAttr}${strokeOpacityAttr}/>`);
    } else if (outline.kind === "ellipse") {
      parts.push(`<ellipse cx="${node.width / 2}" cy="${node.height / 2}" rx="${node.width / 2}" ry="${node.height / 2}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="${sw}"${dashAttr}${strokeOpacityAttr}/>`);
    } else if (outline.kind === "polygon") {
      const ptsStr = outline.points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
      parts.push(`<polygon points="${ptsStr}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="${sw}" stroke-linejoin="round"${dashAttr}${strokeOpacityAttr}/>`);
      if (outline.innerLines) {
        for (const line of outline.innerLines) {
          const lp = line.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
          parts.push(`<polyline points="${lp}" fill="none" stroke="${escXml(stroke)}" stroke-width="${sw}" stroke-linecap="round"/>`);
        }
      }
      if (outline.innerCircle) {
        parts.push(`<circle cx="${outline.innerCircle.cx}" cy="${outline.innerCircle.cy}" r="${outline.innerCircle.r}" fill="none" stroke="${escXml(stroke)}" stroke-width="${sw}"/>`);
      }
    } else if (outline.kind === "path") {
      parts.push(`<path d="${outline.d}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="${sw}" stroke-linejoin="round"${dashAttr}${strokeOpacityAttr}/>`);
    } else if (outline.kind === "cylinder") {
      const cap = node.height * CYLINDER_CAP_RATIO;
      const bodyD = `M0,${cap} L0,${node.height - cap} A${node.width / 2},${cap} 0 0,0 ${node.width},${node.height - cap} L${node.width},${cap} Z`;
      parts.push(`<path d="${bodyD}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="${sw}"/>`);
      parts.push(`<ellipse cx="${node.width / 2}" cy="${cap}" rx="${node.width / 2}" ry="${cap}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="${sw}"/>`);
    } else if (outline.kind === "chart") {
      const tx = outline.inset ? ` transform="translate(${outline.inset.dx},${outline.inset.dy})"` : "";
      parts.push(`<g${tx}>`);
      for (const part of outline.parts) {
        if (part.role === "fill") parts.push(`<path d="${part.d}" fill="${escXml(fill)}"/>`);
        else if (part.role === "marker") parts.push(`<path d="${part.d}" fill="${escXml(node.strokeColor)}"/>`);
        else if (part.role === "slice") parts.push(`<path d="${part.d}" fill="${escXml(part.color)}" stroke="#ffffff" stroke-width="1"/>`);
        else if (part.role === "series") parts.push(`<path d="${part.d}" fill="none" stroke="${escXml(part.color)}" stroke-width="${Math.max(0.5, part.width)}"/>`);
        else if (part.role === "seriesFill") parts.push(`<path d="${part.d}" fill="${escXml(part.color)}" fill-opacity="${SERIES_FILL_OPACITY}"/>`);
        else if (part.role === "axis") parts.push(`<path d="${part.d}" fill="none" stroke="${escXml(part.color ?? "#9ca3af")}" stroke-width="${part.width ?? 1}"/>`);
        else if (part.role === "grid") parts.push(`<path d="${part.d}" fill="none" stroke="${escXml(part.color ?? "#e5e7eb")}" stroke-width="0.75"/>`);
        else parts.push(`<path d="${part.d}" fill="none" stroke="${escXml(node.strokeColor)}" stroke-width="${Math.max(1, sw)}"/>`);
      }
      parts.push(`</g>`);
    }
  }

  // Progress overlay ring for Mind Map topic/subtopic
  if (isMindmapTopicNode(node) && node.mindmapProgress && node.mindmapProgress !== "pending") {
    const pFill =
      node.mindmapProgress === "done"
        ? "rgba(22,163,74,0.16)"
        : node.mindmapProgress === "in-progress"
        ? "rgba(234,179,8,0.18)"
        : "rgba(156,163,175,0.22)";
    const pStroke =
      node.mindmapProgress === "done"
        ? "#16a34a"
        : node.mindmapProgress === "in-progress"
        ? "#eab308"
        : "#9ca3af";
    const rx = node.cornerRadius || 6;
    parts.push(`<rect x="0" y="0" width="${node.width}" height="${node.height}" rx="${rx}" ry="${rx}" fill="${pFill}" stroke="${pStroke}" stroke-width="2"/>`);
  }

  // Artboard title header above top-left corner
  if (node.shapeType === "artboard" && node.text) {
    parts.push(
      `<text x="4" y="-7" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#4b5563">${escXml(node.text)}</text>`
    );
  } else if (node.shapeType === "mindmapChecklist" || node.shapeType === "mindmapLinksGroup") {
    const pad = 10;
    const title = node.text || (node.shapeType === "mindmapChecklist" ? "Checklist" : "Resources");
    parts.push(`<text x="${pad}" y="${pad + 11}" font-family="${escXml(node.fontFamily)}" font-size="12" font-weight="600" fill="${escXml(node.fontColor)}">${escXml(title)}</text>`);
    parts.push(`<line x1="${pad}" y1="${pad + 18}" x2="${node.width - pad}" y2="${pad + 18}" stroke="rgba(0,0,0,0.12)" stroke-width="1"/>`);
    let y = pad + 32;
    for (const item of node.mindmapItems ?? []) {
      if (y > node.height - 6) break;
      if (node.shapeType === "mindmapChecklist") {
        const mark = item.checked ? "☑" : "☐";
        const col = item.checked ? "#9ca3af" : node.fontColor;
        parts.push(`<text x="${pad}" y="${y}" font-family="${escXml(node.fontFamily)}" font-size="12" fill="${escXml(col)}">${mark} ${escXml(item.text)}</text>`);
      } else {
        parts.push(`<text x="${pad}" y="${y}" font-family="${escXml(node.fontFamily)}" font-size="12" fill="#2563eb">› ${escXml(item.text)}</text>`);
      }
      y += 18;
    }
  } else if (node.text && node.shapeType !== "table") {
    const fontSize = node.fontSize || 14;
    const charsPerLine = Math.max(8, (node.width - 16) / (fontSize * 0.56));
    const lines = wrapSimpleLines(node.text, charsPerLine);
    const lineH = fontSize * 1.28;
    const totalH = lines.length * lineH;
    const anchor = node.textAlign === "left" ? "start" : node.textAlign === "right" ? "end" : "middle";
    const tx = node.textAlign === "left" ? 10 : node.textAlign === "right" ? node.width - 10 : node.width / 2;
    const firstY =
      node.verticalAlign === "top"
        ? 10 + fontSize * 0.85
        : node.verticalAlign === "bottom"
        ? node.height - 10 - totalH + fontSize * 0.85
        : node.height / 2 - totalH / 2 + fontSize * 0.85;
    const weight = node.fontWeight === "bold" ? ` font-weight="700"` : "";
    const style = node.fontStyle === "italic" ? ` font-style="italic"` : "";
    parts.push(
      `<text x="${tx.toFixed(1)}" y="${firstY.toFixed(1)}" text-anchor="${anchor}" font-family="${escXml(node.fontFamily || "system-ui, sans-serif")}" font-size="${fontSize}" fill="${escXml(node.fontColor)}"${weight}${style}>`
    );
    lines.forEach((line, idx) => {
      parts.push(`<tspan x="${tx.toFixed(1)}" dy="${idx === 0 ? 0 : lineH.toFixed(1)}">${escXml(line)}</tspan>`);
    });
    parts.push(`</text>`);
  }

  parts.push(`</g>`);
  return parts.join("");
}

/**
 * Exports a WhiteboardPage as a clean, standalone, resolution-independent vector SVG string.
 * Respects collapsed Mind Map branches and z-ordering (with artboard Containment Frames behind).
 */
export function exportWhiteboardToSvg(page: WhiteboardPage, bgColor = "#ffffff"): string {
  const collapsed = getCollapsedState(page.nodes, page.edges);
  const nodes = collapsed.hiddenNodeIds.size === 0 ? page.nodes : page.nodes.filter((n) => !collapsed.hiddenNodeIds.has(n.id));
  const edges = collapsed.hiddenEdgeIds.size === 0 ? page.edges : page.edges.filter((e) => !collapsed.hiddenEdgeIds.has(e.id));

  const bounds = computeContentBounds({ ...page, nodes, edges });
  const pad = 28;
  const minX = Math.floor(bounds.minX - pad);
  const minY = Math.floor(bounds.minY - pad);
  const width = Math.max(100, Math.ceil(bounds.maxX - bounds.minX + pad * 2));
  const height = Math.max(100, Math.ceil(bounds.maxY - bounds.minY + pad * 2));

  // Collect all distinct arrowhead markers
  const markers = new Map<string, string>();
  const addMarker = (type: ArrowheadType | undefined, color: string) => {
    if (!type || type === "none") return;
    const id = svgMarkerId(type, color);
    if (!markers.has(id)) markers.set(id, svgMarkerDef(type, color));
  };
  for (const e of edges) {
    addMarker(e.startArrowType, e.strokeColor);
    addMarker(e.endArrowType, e.strokeColor);
  }
  for (const n of nodes) {
    if (n.shapeType === "freehand" || n.shapeType === "vector") {
      addMarker(n.startArrowType, n.strokeColor);
      addMarker(n.endArrowType, n.strokeColor);
    }
  }

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const layerOrder = resolvePageLayerOrder({ nodes, edges });
  type Entry = { kind: "node"; item: WhiteboardNode } | { kind: "edge"; item: WhiteboardEdge };
  const ordered: Entry[] = [
    ...nodes.map((item): Entry => ({ kind: "node", item })),
    ...edges.map((item): Entry => ({ kind: "edge", item })),
  ].sort((a, b) => {
    const aOff = a.kind === "node" && a.item.shapeType === "artboard" ? -10000 : 0;
    const bOff = b.kind === "node" && b.item.shapeType === "artboard" ? -10000 : 0;
    return aOff + (layerOrder.get(a.item.id) ?? 0) - (bOff + (layerOrder.get(b.item.id) ?? 0));
  });

  const body: string[] = [];
  for (const entry of ordered) {
    if (entry.kind === "node") {
      body.push(renderNodeSvg(entry.item));
    } else {
      const edge = entry.item;
      const { source, target } = resolveEdgeEndpoints(edge, nodesById);
      const waypoints = edge.waypoints ?? [];
      const d = buildEdgePath(source, target, edge.routing, edge.curveBow ?? DEFAULT_CURVE_BOW, waypoints, edge.cornerRadius ?? 0);
      const dash = dashArrayFor(edge.strokeStyle, edge.strokeWidth);
      const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
      const mStart = edge.startArrowType !== "none" ? ` marker-start="url(#${svgMarkerId(edge.startArrowType, edge.strokeColor)})"` : "";
      const mEnd = edge.endArrowType !== "none" ? ` marker-end="url(#${svgMarkerId(edge.endArrowType, edge.strokeColor)})"` : "";
      const opAttr = edge.opacity !== undefined && edge.opacity < 1 ? ` opacity="${edge.opacity}"` : "";
      body.push(`<g${opAttr}><path d="${d}" fill="none" stroke="${escXml(edge.strokeColor)}" stroke-width="${edge.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${dashAttr}${mStart}${mEnd}/>`);
      if (edge.label) {
        const pt = edgePointAtFraction(source, target, edge.routing, edge.curveBow ?? DEFAULT_CURVE_BOW, waypoints, edge.labelPosition ?? 0.5);
        const fs = edge.labelFontSize ?? 13;
        const bw = Math.max(24, edge.label.length * fs * 0.6 + 12);
        const bh = fs + 6;
        body.push(`<rect x="${(pt.x - bw / 2).toFixed(1)}" y="${(pt.y - bh / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="4" fill="${escXml(edge.labelBackgroundColor ?? "#ffffff")}" stroke="#e5e7eb" stroke-width="1"/>`);
        body.push(`<text x="${pt.x.toFixed(1)}" y="${(pt.y + fs * 0.35).toFixed(1)}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${fs}" fill="${escXml(edge.labelColor ?? "#374151")}">${escXml(edge.label)}</text>`);
      }
      body.push(`</g>`);
    }
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="${width}" height="${height}">`,
    `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${escXml(bgColor)}"/>`,
    markers.size > 0 ? `<defs>${Array.from(markers.values()).join("")}</defs>` : "",
    body.join("\n"),
    `</svg>`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- Markdown Outline <-> Mind Map -------------------------------------------------------------

const BRANCH_PALETTE_CYCLE: MindmapColorKey[] = ["E", "D", "H", "C", "G", "A"];

/**
 * Parses an indented Markdown bullet list or `# / ## / ###` heading outline into a laid-out
 * Mind Map (`nodes` + `edges`). Supports `[x]`/`[ ]` progress checkboxes and inline `[Label](url)`
 * resource links.
 */
export function parseMarkdownToMindmap(
  markdown: string,
  layoutMode: MindmapLayoutMode = "balanced",
  originX = 480,
  originY = 300
): { nodes: WhiteboardNode[]; edges: WhiteboardEdge[] } {
  interface ParsedLine {
    depth: number;
    text: string;
    done: boolean;
    resources: MindmapResource[];
  }

  const lines = markdown.split(/\r?\n/);
  const parsed: ParsedLine[] = [];

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let depth = 0;
    let body = trimmed;

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      depth = headingMatch[1].length - 1;
      body = headingMatch[2].trim();
    } else {
      const bulletMatch = /^(\s*)(?:[-*+]|\d+\.)\s+(.+)$/.exec(raw);
      if (bulletMatch) {
        const indentSpaces = bulletMatch[1].replace(/\t/g, "  ").length;
        depth = Math.floor(indentSpaces / 2) + (parsed.some((p) => p.depth === 0) && /^#/.test(lines.find((l) => l.trim())?.trim() ?? "") ? 1 : 0);
        body = bulletMatch[2].trim();
      } else {
        // Plain top-level line
        depth = parsed.length === 0 ? 0 : 1;
        body = trimmed;
      }
    }

    let done = false;
    const checkMatch = /^\[(x|X| )\]\s+(.+)$/.exec(body);
    if (checkMatch) {
      done = checkMatch[1].toLowerCase() === "x";
      body = checkMatch[2].trim();
    }

    // Extract inline Markdown links [Title](https://...) as attached topic resources
    const resources: MindmapResource[] = [];
    const cleanText = body
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_m, label: string, url: string) => {
        resources.push({ id: crypto.randomUUID(), type: "article", label: label.trim(), url: url.trim() });
        return label.trim();
      })
      .trim();

    parsed.push({ depth, text: cleanText || "Topic", done, resources });
  }

  if (parsed.length === 0) return { nodes: [], edges: [] };

  // Normalize min depth to 0; if multiple depth-0 items exist, synthesize a single root wrapper.
  const minDepth = Math.min(...parsed.map((p) => p.depth));
  const normalized = parsed.map((p) => ({ ...p, depth: p.depth - minDepth }));
  const topCount = normalized.filter((p) => p.depth === 0).length;
  const entries: ParsedLine[] =
    topCount > 1
      ? [{ depth: 0, text: "Mind Map", done: false, resources: [] }, ...normalized.map((p) => ({ ...p, depth: p.depth + 1 }))]
      : normalized;

  const nodes: WhiteboardNode[] = [];
  const edges: WhiteboardEdge[] = [];
  const stack: { depth: number; node: WhiteboardNode; colorKey: MindmapColorKey }[] = [];
  let branchColorIdx = 0;

  for (const item of entries) {
    while (stack.length > 0 && stack[stack.length - 1].depth >= item.depth) {
      stack.pop();
    }
    const parentEntry = stack[stack.length - 1];
    const isRoot = !parentEntry;
    const isPrimary = !isRoot && parentEntry.depth === 0;
    const shapeType: WhiteboardShapeType = isRoot || isPrimary ? "mindmapTopic" : "mindmapSubtopic";
    const colorKey: MindmapColorKey = isRoot
      ? "B"
      : isPrimary
      ? BRANCH_PALETTE_CYCLE[branchColorIdx++ % BRANCH_PALETTE_CYCLE.length]
      : parentEntry.colorKey;

    const width = Math.min(260, Math.max(isRoot ? 190 : 148, item.text.length * 8.2 + 34));
    const height = isRoot ? 52 : isPrimary ? 44 : 38;
    let node = applyMindmapPaletteKey(
      {
        ...createDefaultWhiteboardNode(crypto.randomUUID(), shapeType, originX, originY),
        width: Math.round(width),
        height,
        text: item.text,
        fontSize: isRoot ? 16 : isPrimary ? 14 : 13,
        mindmapProgress: item.done ? "done" : undefined,
        mindmapResources: item.resources.length > 0 ? item.resources : undefined,
      },
      colorKey
    );
    nodes.push(node);

    if (parentEntry) {
      edges.push({
        ...createDefaultWhiteboardEdge(
          crypto.randomUUID(),
          { nodeId: parentEntry.node.id, anchor: "right" },
          { nodeId: node.id, anchor: "left" }
        ),
        routing: "curved",
        strokeColor: "#2b7fff",
        strokeWidth: isPrimary ? 2.5 : 2,
        strokeStyle: isPrimary ? "solid" : "dashed",
        startArrowType: "none",
        endArrowType: "none",
      });
    }

    stack.push({ depth: item.depth, node, colorKey });
  }

  // Run auto-layout from the root so every node is positioned cleanly with zero overlaps.
  const rootId = nodes[0].id;
  const layout = autoLayoutMindmap(rootId, nodes, edges, layoutMode);
  const posById = new Map(layout.after.map((n) => [n.id, n]));
  const edgeById = new Map(layout.afterEdges.map((e) => [e.id, e]));

  return {
    nodes: nodes.map((n) => posById.get(n.id) ?? n),
    edges: edges.map((e) => edgeById.get(e.id) ?? e),
  };
}

/**
 * Exports Mind Map / connected nodes on a WhiteboardPage as a clean indented Markdown outline
 * (preserving `[x]` progress checkboxes and resource links).
 */
export function exportMindmapToMarkdown(page: WhiteboardPage): string {
  const topics = page.nodes.filter((n) => isMindmapTopicNode(n));
  const targetNodes = topics.length > 0 ? topics : page.nodes.filter((n) => !isArtboardNode(n) && n.text.trim());
  if (targetNodes.length === 0) return "";

  const nodeById = new Map(targetNodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  const hasIncoming = new Set<string>();

  for (const e of page.edges) {
    const s = e.source.nodeId;
    const t = e.target.nodeId;
    if (!s || !t || !nodeById.has(s) || !nodeById.has(t) || s === t) continue;
    if (!children.has(s)) children.set(s, []);
    if (!children.get(s)!.includes(t)) children.get(s)!.push(t);
    hasIncoming.add(t);
  }

  const roots = targetNodes.filter((n) => !hasIncoming.has(n.id));
  const startNodes = roots.length > 0 ? roots : [targetNodes[0]];

  const visited = new Set<string>();
  const out: string[] = [];

  const visit = (id: string, depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    const n = nodeById.get(id);
    if (!n) return;
    const indent = "  ".repeat(depth);
    const check = n.mindmapProgress === "done" ? "[x] " : n.mindmapProgress === "in-progress" ? "[ ] " : "";
    const prefix = depth === 0 ? "# " : `${indent}- ${check}`;
    out.push(`${prefix}${n.text.trim() || "Untitled"}`);
    if (n.mindmapResources && n.mindmapResources.length > 0) {
      for (const res of n.mindmapResources) {
        if (res.url) out.push(`${indent}  - [${res.label || res.url}](${res.url})`);
      }
    }
    for (const cid of children.get(id) ?? []) {
      visit(cid, depth + 1);
    }
  };

  for (const r of startNodes) visit(r.id, 0);
  // Append any disconnected remaining nodes
  for (const n of targetNodes) {
    if (!visited.has(n.id)) visit(n.id, 0);
  }

  return out.join("\n");
}

// ---- Mermaid Flowchart / Graph -> Native Whiteboard --------------------------------------------

interface MermaidNodeSpec {
  key: string;
  label: string;
  shapeType: WhiteboardShapeType;
  cornerRadius?: number;
  fillColor?: string;
  strokeColor?: string;
  subgraphId?: string;
}

interface MermaidEdgeSpec {
  from: string;
  to: string;
  label: string;
  strokeStyle: WhiteboardEdge["strokeStyle"];
  strokeWidth: number;
  startArrow: ArrowheadType;
  endArrow: ArrowheadType;
}

function parseMermaidNodeToken(rawToken: string): { key: string; spec?: Omit<MermaidNodeSpec, "key"> } {
  const token = rawToken.trim();
  const patterns: { re: RegExp; shapeType: WhiteboardShapeType; cornerRadius?: number; fillColor?: string; strokeColor?: string }[] = [
    { re: /^([A-Za-z0-9_-]+)\(\[(.+)\]\)$/, shapeType: "rectangle", cornerRadius: 26, fillColor: "#dcfce7", strokeColor: "#16a34a" },
    { re: /^([A-Za-z0-9_-]+)\[\((.+)\)\]$/, shapeType: "cylinder", fillColor: "#fef3c7", strokeColor: "#d97706" },
    { re: /^([A-Za-z0-9_-]+)\(\((.+)\)\)$/, shapeType: "ellipse", fillColor: "#ede9fe", strokeColor: "#7c3aed" },
    { re: /^([A-Za-z0-9_-]+)\{\{(.+)\}\}$/, shapeType: "hexagon", fillColor: "#e0f2fe", strokeColor: "#0284c7" },
    { re: /^([A-Za-z0-9_-]+)\{(.+)\}$/, shapeType: "diamond", fillColor: "#fef3c7", strokeColor: "#d97706" },
    { re: /^([A-Za-z0-9_-]+)\[\/(.+)\/\]$/, shapeType: "parallelogram", fillColor: "#f3e8ff", strokeColor: "#9333ea" },
    { re: /^([A-Za-z0-9_-]+)\((.+)\)$/, shapeType: "rectangle", cornerRadius: 12, fillColor: "#dbeafe", strokeColor: "#2563eb" },
    { re: /^([A-Za-z0-9_-]+)\[(.+)\]$/, shapeType: "rectangle", cornerRadius: 6, fillColor: "#ffffff", strokeColor: "#334155" },
  ];

  for (const p of patterns) {
    const m = p.re.exec(token);
    if (m) {
      const label = m[2].trim().replace(/^["']|["']$/g, "");
      return {
        key: m[1],
        spec: {
          label,
          shapeType: p.shapeType,
          cornerRadius: p.cornerRadius,
          fillColor: p.fillColor,
          strokeColor: p.strokeColor,
        },
      };
    }
  }
  const plain = /^([A-Za-z0-9_-]+)$/.exec(token);
  return { key: plain ? plain[1] : token };
}

/**
 * Parses Mermaid `flowchart` / `graph` syntax into native editable Whiteboard shapes, connectors,
 * and Containment Frames (for `subgraph ... end`), cleanly laid out in TD or LR order.
 */
export function parseMermaidToWhiteboard(
  source: string,
  originX = 120,
  originY = 100
): { nodes: WhiteboardNode[]; edges: WhiteboardEdge[] } {
  const lines = source.split(/\r?\n/);
  let direction: "TD" | "LR" = "TD";
  const nodeSpecs = new Map<string, MermaidNodeSpec>();
  const edgeSpecs: MermaidEdgeSpec[] = [];
  const subgraphs: { id: string; title: string; memberKeys: string[] }[] = [];
  const activeSubgraphStack: string[] = [];

  const ensureNode = (rawToken: string): string => {
    const parsed = parseMermaidNodeToken(rawToken);
    const currentSub = activeSubgraphStack[activeSubgraphStack.length - 1];
    const existing = nodeSpecs.get(parsed.key);
    if (!existing) {
      nodeSpecs.set(parsed.key, {
        key: parsed.key,
        label: parsed.spec?.label ?? parsed.key,
        shapeType: parsed.spec?.shapeType ?? "rectangle",
        cornerRadius: parsed.spec?.cornerRadius ?? 8,
        fillColor: parsed.spec?.fillColor ?? "#ffffff",
        strokeColor: parsed.spec?.strokeColor ?? "#334155",
        subgraphId: currentSub,
      });
    } else if (parsed.spec) {
      existing.label = parsed.spec.label;
      existing.shapeType = parsed.spec.shapeType;
      existing.cornerRadius = parsed.spec.cornerRadius;
      existing.fillColor = parsed.spec.fillColor;
      existing.strokeColor = parsed.spec.strokeColor;
    }
    if (currentSub) {
      const sg = subgraphs.find((s) => s.id === currentSub);
      if (sg && !sg.memberKeys.includes(parsed.key)) sg.memberKeys.push(parsed.key);
    }
    return parsed.key;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/%%.*$/, "").trim();
    if (!line) continue;

    const headerMatch = /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i.exec(line);
    if (headerMatch) {
      const dir = headerMatch[1].toUpperCase();
      direction = dir === "LR" || dir === "RL" ? "LR" : "TD";
      continue;
    }

    const subMatch = /^subgraph\s+(.+)$/i.exec(line);
    if (subMatch) {
      const title = subMatch[1].trim().replace(/^["']|["']$/g, "");
      const id = `sg-${subgraphs.length + 1}`;
      subgraphs.push({ id, title, memberKeys: [] });
      activeSubgraphStack.push(id);
      continue;
    }

    if (/^end$/i.test(line)) {
      activeSubgraphStack.pop();
      continue;
    }

    // Parse edge statements: A -->|label| B, A -- label --> B, A -.-> B, A ==> B, A --- B
    const edgeRe = /^(.+?)\s+(<-->|-->|-\.->|==>|---|-\.-|--\s+([^->]+?)\s+-->)\s*(?:\|([^|]+)\|)?\s*(.+)$/;
    const em = edgeRe.exec(line);
    if (em) {
      const fromKey = ensureNode(em[1]);
      const op = em[2].trim();
      const label = (em[4] ?? em[3] ?? "").trim();
      const toKey = ensureNode(em[5]);
      edgeSpecs.push({
        from: fromKey,
        to: toKey,
        label,
        strokeStyle: op.includes(".") ? "dashed" : "solid",
        strokeWidth: op.startsWith("==") ? 3 : 2,
        startArrow: op.startsWith("<") ? "triangle" : "none",
        endArrow: op.endsWith(">") ? "triangle" : "none",
      });
      continue;
    }

    // Standalone node declaration inside graph/subgraph
    if (/^[A-Za-z0-9_-]+[\[\(\{]/.test(line)) {
      ensureNode(line);
    }
  }

  if (nodeSpecs.size === 0) return { nodes: [], edges: [] };

  // Topological BFS layering
  const keys = Array.from(nodeSpecs.keys());
  const inDegree = new Map<string, number>(keys.map((k) => [k, 0]));
  const adj = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const e of edgeSpecs) {
    if (e.from !== e.to) {
      adj.get(e.from)?.push(e.to);
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }

  const layerOf = new Map<string, number>();
  const queue = keys.filter((k) => (inDegree.get(k) ?? 0) === 0);
  if (queue.length === 0) queue.push(keys[0]);
  for (const k of queue) layerOf.set(k, 0);

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currLayer = layerOf.get(curr) ?? 0;
    for (const next of adj.get(curr) ?? []) {
      const nextLayer = currLayer + 1;
      if ((layerOf.get(next) ?? -1) < nextLayer && nextLayer < keys.length) {
        layerOf.set(next, nextLayer);
        queue.push(next);
      }
    }
  }
  for (const k of keys) {
    if (!layerOf.has(k)) layerOf.set(k, 0);
  }

  // Bucket nodes per layer
  const layers = new Map<number, string[]>();
  for (const k of keys) {
    const l = layerOf.get(k) ?? 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(k);
  }

  const GAP_PRIMARY = direction === "LR" ? 240 : 140;
  const GAP_CROSS = direction === "LR" ? 116 : 210;

  const createdByKey = new Map<string, WhiteboardNode>();
  const sortedLayerNums = Array.from(layers.keys()).sort((a, b) => a - b);

  for (const l of sortedLayerNums) {
    const members = layers.get(l)!;
    members.forEach((key, idx) => {
      const spec = nodeSpecs.get(key)!;
      const w = spec.shapeType === "diamond" ? 150 : Math.min(220, Math.max(148, spec.label.length * 8 + 36));
      const h = spec.shapeType === "diamond" ? 96 : spec.shapeType === "cylinder" ? 74 : 58;
      const x = direction === "LR" ? originX + l * GAP_PRIMARY : originX + idx * GAP_CROSS;
      const y = direction === "LR" ? originY + idx * GAP_CROSS : originY + l * GAP_PRIMARY;
      const base = createDefaultWhiteboardNode(crypto.randomUUID(), spec.shapeType, 0, 0);
      const node: WhiteboardNode = {
        ...base,
        x,
        y,
        width: Math.round(w),
        height: h,
        text: spec.label,
        fillColor: spec.fillColor ?? "#ffffff",
        strokeColor: spec.strokeColor ?? "#334155",
        strokeWidth: 2,
        cornerRadius: spec.cornerRadius ?? 8,
        fontSize: 13,
        fontWeight: "bold",
        fontColor: "#0f172a",
      };
      createdByKey.set(key, node);
    });
  }

  // Wrap subgraphs in Containment Frames ("artboard") sized neatly around their members
  const artboards: WhiteboardNode[] = [];
  for (const sg of subgraphs) {
    const members = sg.memberKeys.map((k) => createdByKey.get(k)).filter((n): n is WhiteboardNode => Boolean(n));
    if (members.length === 0) continue;
    const pad = 28;
    const minX = Math.min(...members.map((n) => n.x)) - pad;
    const minY = Math.min(...members.map((n) => n.y)) - pad;
    const maxX = Math.max(...members.map((n) => n.x + n.width)) + pad;
    const maxY = Math.max(...members.map((n) => n.y + n.height)) + pad;
    const frame = createDefaultWhiteboardNode(crypto.randomUUID(), "artboard", 0, 0);
    artboards.push({
      ...frame,
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      text: sg.title,
      fillColor: "#f8fafc",
      strokeColor: "#94a3b8",
    });
  }

  const edges: WhiteboardEdge[] = [];
  for (const e of edgeSpecs) {
    const src = createdByKey.get(e.from);
    const tgt = createdByKey.get(e.to);
    if (!src || !tgt) continue;
    edges.push({
      ...createDefaultWhiteboardEdge(
        crypto.randomUUID(),
        { nodeId: src.id, anchor: "auto" },
        { nodeId: tgt.id, anchor: "auto" }
      ),
      label: e.label,
      routing: "orthogonal",
      strokeColor: "#475569",
      strokeStyle: e.strokeStyle,
      strokeWidth: e.strokeWidth,
      startArrowType: e.startArrow,
      endArrowType: e.endArrow,
    });
  }

  return {
    nodes: [...artboards, ...Array.from(createdByKey.values())],
    edges,
  };
}

// ---- 1-Click Switch Shape Conversion -----------------------------------------------------------

export function switchNodesShapeType(
  nodes: WhiteboardNode[],
  targetShape: WhiteboardShapeType,
  overrides?: Partial<WhiteboardNode>
): { before: WhiteboardNode[]; after: WhiteboardNode[] } {
  const unlocked = nodes.filter((n) => !n.locked && n.shapeType !== "image" && n.shapeType !== "freehand" && n.shapeType !== "latticeGauge");
  if (unlocked.length === 0) return { before: [], after: [] };

  const after = unlocked.map((n) => {
    let next: WhiteboardNode = {
      ...n,
      shapeType: targetShape,
      updatedAt: Date.now(),
    };
    if (targetShape === "mindmapTopic") {
      const pal = MINDMAP_PALETTE[n.mindmapColorKey ?? "B"];
      next = { ...next, fillColor: pal.background, strokeColor: pal.border, fontColor: pal.text, cornerRadius: 8, fontWeight: "bold", mindmapColorKey: n.mindmapColorKey ?? "B" };
    } else if (targetShape === "mindmapSubtopic") {
      const pal = MINDMAP_PALETTE[n.mindmapColorKey ?? "C"];
      next = { ...next, fillColor: pal.background, strokeColor: pal.border, fontColor: pal.text, cornerRadius: 6, mindmapColorKey: n.mindmapColorKey ?? "C" };
    }
    if (overrides) {
      next = { ...next, ...overrides };
    }
    return next;
  });

  return { before: unlocked, after };
}
