// handlers/whiteboardProHandlers.ts
//
// Pure, allocation-light handlers for Phase 2 Pro Whiteboard controls:
// - Multi-select Alignment (left/centerH/right/top/middleV/bottom)
// - Multi-select Distribution (horizontal / vertical equal-gap spacing)
// - Match Size (width / height / both)
// - 1-click Tidy Up (row, column, or evenly-spaced grid)
// - True Containment Frames ("artboard") — moving a frame carries nodes/edges inside its bounds
// - Format Painter — copy & apply visual styling without altering geometry or text
// - Cross-page Canvas Search & Jump (Ctrl+F)

import {
  isArtboardNode,
  WhiteboardDocument,
  WhiteboardEdge,
  WhiteboardNode,
} from "../utils/whiteboardTypes";

export type AlignMode = "left" | "centerH" | "right" | "top" | "middleV" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";
export type MatchSizeDimension = "width" | "height" | "both";

export interface NodeBatchDiff {
  before: WhiteboardNode[];
  after: WhiteboardNode[];
}

/**
 * Aligns 2+ unlocked nodes to the collective bounding edge or center of the selection.
 */
export function alignNodes(nodes: WhiteboardNode[], mode: AlignMode): NodeBatchDiff {
  const movable = nodes.filter((n) => !n.locked);
  if (movable.length < 2) return { before: [], after: [] };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of movable) {
    if (n.x < minX) minX = n.x;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y < minY) minY = n.y;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  const before: WhiteboardNode[] = [];
  const after: WhiteboardNode[] = [];
  for (const n of movable) {
    let nx = n.x;
    let ny = n.y;
    switch (mode) {
      case "left":
        nx = minX;
        break;
      case "centerH":
        nx = midX - n.width / 2;
        break;
      case "right":
        nx = maxX - n.width;
        break;
      case "top":
        ny = minY;
        break;
      case "middleV":
        ny = midY - n.height / 2;
        break;
      case "bottom":
        ny = maxY - n.height;
        break;
    }
    nx = Math.round(nx * 100) / 100;
    ny = Math.round(ny * 100) / 100;
    if (nx !== n.x || ny !== n.y) {
      before.push(n);
      after.push({ ...n, x: nx, y: ny });
    }
  }
  return { before, after };
}

/**
 * Evenly distributes the gaps between 3+ unlocked nodes along `axis`, keeping the outermost two
 * nodes anchored in place.
 */
export function distributeNodes(nodes: WhiteboardNode[], axis: DistributeAxis): NodeBatchDiff {
  const movable = nodes.filter((n) => !n.locked);
  if (movable.length < 3) return { before: [], after: [] };

  const sorted = [...movable].sort((a, b) =>
    axis === "horizontal"
      ? a.x + a.width / 2 - (b.x + b.width / 2)
      : a.y + a.height / 2 - (b.y + b.height / 2)
  );

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const before: WhiteboardNode[] = [];
  const after: WhiteboardNode[] = [];

  if (axis === "horizontal") {
    const span = last.x + last.width - first.x;
    const totalW = sorted.reduce((sum, n) => sum + n.width, 0);
    const gap = (span - totalW) / (sorted.length - 1);
    let cursor = first.x + first.width + gap;
    for (let i = 1; i < sorted.length - 1; i++) {
      const n = sorted[i];
      const nx = Math.round(cursor * 100) / 100;
      if (nx !== n.x) {
        before.push(n);
        after.push({ ...n, x: nx });
      }
      cursor += n.width + gap;
    }
  } else {
    const span = last.y + last.height - first.y;
    const totalH = sorted.reduce((sum, n) => sum + n.height, 0);
    const gap = (span - totalH) / (sorted.length - 1);
    let cursor = first.y + first.height + gap;
    for (let i = 1; i < sorted.length - 1; i++) {
      const n = sorted[i];
      const ny = Math.round(cursor * 100) / 100;
      if (ny !== n.y) {
        before.push(n);
        after.push({ ...n, y: ny });
      }
      cursor += n.height + gap;
    }
  }
  return { before, after };
}

/**
 * Matches width, height, or both across 2+ unlocked nodes to the largest dimension in the selection
 * (preserves each node's center so matching size never shifts items awkwardly).
 */
export function matchNodeSize(nodes: WhiteboardNode[], dim: MatchSizeDimension): NodeBatchDiff {
  const movable = nodes.filter((n) => !n.locked);
  if (movable.length < 2) return { before: [], after: [] };

  const targetW = Math.max(...movable.map((n) => n.width));
  const targetH = Math.max(...movable.map((n) => n.height));
  const before: WhiteboardNode[] = [];
  const after: WhiteboardNode[] = [];

  for (const n of movable) {
    const nw = dim === "width" || dim === "both" ? targetW : n.width;
    const nh = dim === "height" || dim === "both" ? targetH : n.height;
    if (nw !== n.width || nh !== n.height) {
      const dx = (nw - n.width) / 2;
      const dy = (nh - n.height) / 2;
      before.push(n);
      after.push({ ...n, x: Math.round((n.x - dx) * 100) / 100, y: Math.round((n.y - dy) * 100) / 100, width: nw, height: nh });
    }
  }
  return { before, after };
}

/**
 * 1-click Grid Tidy Up: arranges 2+ unlocked nodes into a crisp evenly-spaced row, column, or grid
 * anchored at the selection's top-left corner, preserving reading order (top-to-bottom, left-to-right).
 */
export function tidyUpNodes(nodes: WhiteboardNode[], gap = 28): NodeBatchDiff {
  const movable = nodes.filter((n) => !n.locked);
  if (movable.length < 2) return { before: [], after: [] };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of movable) {
    if (n.x < minX) minX = n.x;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y < minY) minY = n.y;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }

  const avgH = movable.reduce((s, n) => s + n.height, 0) / movable.length;
  const spanX = maxX - minX;
  const spanY = maxY - minY;

  // Decide column count: single row if clearly horizontal, single col if clearly vertical, else sqrt grid.
  let cols: number;
  if (spanX > spanY * 2.2 && movable.length <= 6) cols = movable.length;
  else if (spanY > spanX * 2.2 && movable.length <= 6) cols = 1;
  else cols = Math.ceil(Math.sqrt(movable.length));

  // Reading-order sort: bucket roughly by row bands of avgH * 0.6 so slightly misaligned rows stay together.
  const band = Math.max(24, avgH * 0.6);
  const ordered = [...movable].sort((a, b) => {
    const rowDiff = Math.round((a.y - minY) / band) - Math.round((b.y - minY) / band);
    return rowDiff !== 0 ? rowDiff : a.x - b.x;
  });

  const rowsCount = Math.ceil(ordered.length / cols);
  const colWidths = Array<number>(cols).fill(0);
  const rowHeights = Array<number>(rowsCount).fill(0);

  ordered.forEach((n, idx) => {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    if (n.width > colWidths[c]) colWidths[c] = n.width;
    if (n.height > rowHeights[r]) rowHeights[r] = n.height;
  });

  const colOffsets: number[] = [];
  let cx = minX;
  for (let c = 0; c < cols; c++) {
    colOffsets.push(cx);
    cx += colWidths[c] + gap;
  }
  const rowOffsets: number[] = [];
  let cy = minY;
  for (let r = 0; r < rowsCount; r++) {
    rowOffsets.push(cy);
    cy += rowHeights[r] + gap;
  }

  const before: WhiteboardNode[] = [];
  const after: WhiteboardNode[] = [];
  ordered.forEach((n, idx) => {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const nx = Math.round((colOffsets[c] + (colWidths[c] - n.width) / 2) * 100) / 100;
    const ny = Math.round((rowOffsets[r] + (rowHeights[r] - n.height) / 2) * 100) / 100;
    if (nx !== n.x || ny !== n.y) {
      before.push(n);
      after.push({ ...n, x: nx, y: ny });
    }
  });

  return { before, after };
}

/**
 * Finds all non-locked nodes whose centers sit inside any of `selectedArtboards` (excluding the
 * artboards themselves and excluding larger enclosing artboards). Also finds free-floating edges
 * whose floating endpoints sit inside those artboards so moving a Frame carries its entire contents.
 */
export function findContainedFrameItems(
  selectedNodes: WhiteboardNode[],
  allNodes: WhiteboardNode[],
  allEdges: WhiteboardEdge[]
): { nodeIds: string[]; edgeIds: string[] } {
  const artboards = selectedNodes.filter((n) => isArtboardNode(n) && !n.locked);
  if (artboards.length === 0) return { nodeIds: [], edgeIds: [] };

  const alreadySelected = new Set(selectedNodes.map((n) => n.id));
  const extraNodeIds: string[] = [];

  const pointInAnyArtboard = (px: number, py: number, excludeId?: string, area?: number): boolean => {
    for (const ab of artboards) {
      if (ab.id === excludeId) continue;
      if (area !== undefined && ab.width * ab.height <= area) continue;
      if (px >= ab.x && px <= ab.x + ab.width && py >= ab.y && py <= ab.y + ab.height) return true;
    }
    return false;
  };

  for (const n of allNodes) {
    if (n.locked || alreadySelected.has(n.id)) continue;
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const area = isArtboardNode(n) ? n.width * n.height : undefined;
    if (pointInAnyArtboard(cx, cy, n.id, area)) {
      extraNodeIds.push(n.id);
    }
  }

  const extraEdgeIds: string[] = [];
  for (const e of allEdges) {
    if (e.locked) continue;
    const srcFreeInside = !e.source.nodeId && e.source.x !== undefined && e.source.y !== undefined && pointInAnyArtboard(e.source.x, e.source.y);
    const tgtFreeInside = !e.target.nodeId && e.target.x !== undefined && e.target.y !== undefined && pointInAnyArtboard(e.target.x, e.target.y);
    if (srcFreeInside || tgtFreeInside) {
      extraEdgeIds.push(e.id);
    }
  }

  return { nodeIds: extraNodeIds, edgeIds: extraEdgeIds };
}

export type FrameArrangeAction =
  | { kind: "moveToStart"; frameId: string }
  | { kind: "moveToEnd"; frameId: string }
  | { kind: "moveEarlier"; frameId: string }
  | { kind: "moveLater"; frameId: string }
  | { kind: "arrangeAll" };

export interface FrameArrangeDiff {
  beforeNodes: WhiteboardNode[];
  afterNodes: WhiteboardNode[];
  beforeEdges: WhiteboardEdge[];
  afterEdges: WhiteboardEdge[];
  targetFrameAfter: WhiteboardNode | null;
}

/**
 * Reorders a Containment Frame (Artboard) to the start, end, earlier, or later position — or
 * arranges all frames neatly into an evenly spaced slide grid starting at the existing slides'
 * top-left origin.
 *
 * Key safeguards:
 * - Every child node is assigned to AT MOST ONE owning frame (preferring full enclosure, then older
 *   `createdAt`), so dropping a brand-new empty Frame on top of Slide 1 and moving it to the end
 *   never steals Slide 1's logo/text!
 * - An empty moved frame automatically adopts the existing deck's dominant slide dimensions (e.g.
 *   960x540) so it matches neighboring slides cleanly.
 * - Moves all owned child nodes, free-floating endpoints, and internal edge waypoints in one undo step.
 */
export function arrangeArtboardFrames(
  allNodes: WhiteboardNode[],
  allEdges: WhiteboardEdge[],
  action: FrameArrangeAction
): FrameArrangeDiff {
  const ordered = getOrderedArtboards(allNodes);
  if (ordered.length === 0) {
    return { beforeNodes: [], afterNodes: [], beforeEdges: [], afterEdges: [], targetFrameAfter: null };
  }
  if (action.kind !== "arrangeAll" && ordered.length < 2) {
    return { beforeNodes: [], afterNodes: [], beforeEdges: [], afterEdges: [], targetFrameAfter: null };
  }

  const targetId = action.kind === "arrangeAll" ? null : action.frameId;
  const targetIdx = targetId ? ordered.findIndex((f) => f.id === targetId) : -1;
  if (targetId && targetIdx < 0) {
    return { beforeNodes: [], afterNodes: [], beforeEdges: [], afterEdges: [], targetFrameAfter: null };
  }

  // 1. Resolve unique frame ownership for every non-artboard node
  const ownedNodesByFrame = new Map<string, WhiteboardNode[]>();
  const ownerFrameOfNode = new Map<string, string>();
  for (const f of ordered) ownedNodesByFrame.set(f.id, []);

  const pickOwnerForPoint = (
    px: number,
    py: number,
    nodeBox?: { x: number; y: number; w: number; h: number }
  ): WhiteboardNode | null => {
    const candidates = ordered.filter(
      (ab) => px >= ab.x - 2 && px <= ab.x + ab.width + 2 && py >= ab.y - 2 && py <= ab.y + ab.height + 2
    );
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    candidates.sort((a, b) => {
      if (nodeBox) {
        const aEncloses =
          nodeBox.x >= a.x - 4 &&
          nodeBox.y >= a.y - 4 &&
          nodeBox.x + nodeBox.w <= a.x + a.width + 4 &&
          nodeBox.y + nodeBox.h <= a.y + a.height + 4;
        const bEncloses =
          nodeBox.x >= b.x - 4 &&
          nodeBox.y >= b.y - 4 &&
          nodeBox.x + nodeBox.w <= b.x + b.width + 4 &&
          nodeBox.y + nodeBox.h <= b.y + b.height + 4;
        if (aEncloses !== bEncloses) return aEncloses ? -1 : 1;
      }
      // Older frame keeps its existing contents when a brand-new frame is dropped overlapping it
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.width * a.height - b.width * b.height;
    });
    return candidates[0];
  };

  for (const n of allNodes) {
    if (isArtboardNode(n)) continue;
    const owner = pickOwnerForPoint(n.x + n.width / 2, n.y + n.height / 2, {
      x: n.x,
      y: n.y,
      w: n.width,
      h: n.height,
    });
    if (owner) {
      ownedNodesByFrame.get(owner.id)!.push(n);
      ownerFrameOfNode.set(n.id, owner.id);
    }
  }

  // 2. Measure existing slide grid geometry from reference frames (excluding the newly moved frame so
  //    dropping a frame slightly above/left of Slide 1 doesn't shift the whole deck's origin!)
  const refFrames = targetId ? ordered.filter((f) => f.id !== targetId) : ordered;
  const originX = Math.round(Math.min(...refFrames.map((f) => f.x)));
  const originY = Math.round(Math.min(...refFrames.map((f) => f.y)));

  // Dominant slide dimensions (mode of width x height among reference frames)
  const sizeCounts = new Map<string, { w: number; h: number; count: number }>();
  for (const f of refFrames) {
    const key = `${Math.round(f.width)}x${Math.round(f.height)}`;
    const prev = sizeCounts.get(key);
    sizeCounts.set(key, { w: Math.round(f.width), h: Math.round(f.height), count: (prev?.count ?? 0) + 1 });
  }
  let dominantW = Math.round(refFrames[0].width);
  let dominantH = Math.round(refFrames[0].height);
  let bestSizeCount = -1;
  for (const entry of sizeCounts.values()) {
    if (entry.count > bestSizeCount) {
      bestSizeCount = entry.count;
      dominantW = entry.w;
      dominantH = entry.h;
    }
  }

  // Detect column count from reference frames' first row band
  const firstRowCount = refFrames.filter((f) => Math.abs(f.y - originY) < Math.max(40, dominantH * 0.45)).length;
  const cols =
    refFrames.length >= 2 && firstRowCount >= 1 && firstRowCount <= 6
      ? Math.min(ordered.length, Math.max(firstRowCount, refFrames.length >= 3 ? firstRowCount : Math.min(3, ordered.length)))
      : Math.min(3, ordered.length);

  // Detect horizontal/vertical spacing from existing grid, falling back to clean 96x100 defaults
  const firstRowSorted = refFrames
    .filter((f) => Math.abs(f.y - originY) < Math.max(40, dominantH * 0.45))
    .sort((a, b) => a.x - b.x);
  let gapX = 96;
  if (firstRowSorted.length >= 2) {
    const measuredGapX = firstRowSorted[1].x - (firstRowSorted[0].x + firstRowSorted[0].width);
    if (measuredGapX >= 24 && measuredGapX <= 240) gapX = Math.round(measuredGapX);
  }
  const secondRowFrames = refFrames
    .filter((f) => f.y - originY >= Math.max(40, dominantH * 0.45))
    .sort((a, b) => a.y - b.y);
  let gapY = 100;
  if (secondRowFrames.length >= 1) {
    const measuredGapY = secondRowFrames[0].y - (originY + dominantH);
    if (measuredGapY >= 32 && measuredGapY <= 260) gapY = Math.round(measuredGapY);
  }

  // 3. Build desired frame order
  const nextOrder = [...ordered];
  if (action.kind === "moveToStart" && targetIdx > 0) {
    const [moved] = nextOrder.splice(targetIdx, 1);
    nextOrder.unshift(moved);
  } else if (action.kind === "moveToEnd" && targetIdx >= 0 && targetIdx < nextOrder.length - 1) {
    const [moved] = nextOrder.splice(targetIdx, 1);
    nextOrder.push(moved);
  } else if (action.kind === "moveEarlier" && targetIdx > 0) {
    [nextOrder[targetIdx - 1], nextOrder[targetIdx]] = [nextOrder[targetIdx], nextOrder[targetIdx - 1]];
  } else if (action.kind === "moveLater" && targetIdx >= 0 && targetIdx < nextOrder.length - 1) {
    [nextOrder[targetIdx], nextOrder[targetIdx + 1]] = [nextOrder[targetIdx + 1], nextOrder[targetIdx]];
  }

  // 4. Determine each frame's target width/height (empty moved frame matches existing slide size)
  const targetDims = new Map<string, { w: number; h: number }>();
  for (const f of nextOrder) {
    const isMovedEmpty = targetId === f.id && (ownedNodesByFrame.get(f.id)?.length ?? 0) === 0;
    targetDims.set(f.id, isMovedEmpty ? { w: dominantW, h: dominantH } : { w: f.width, h: f.height });
  }

  // 5. Compute neat grid coordinates
  const cellW = Math.max(...nextOrder.map((f) => targetDims.get(f.id)!.w));
  const rowCount = Math.ceil(nextOrder.length / cols);
  const rowHeights = Array<number>(rowCount).fill(0);
  nextOrder.forEach((f, idx) => {
    const r = Math.floor(idx / cols);
    rowHeights[r] = Math.max(rowHeights[r], targetDims.get(f.id)!.h);
  });
  const rowYOffsets: number[] = [];
  let accY = originY;
  for (let r = 0; r < rowCount; r++) {
    rowYOffsets.push(accY);
    accY += rowHeights[r] + gapY;
  }

  const frameDeltas = new Map<string, { dx: number; dy: number }>();
  const beforeNodes: WhiteboardNode[] = [];
  const afterNodes: WhiteboardNode[] = [];
  let targetFrameAfter: WhiteboardNode | null = null;

  nextOrder.forEach((f, idx) => {
    const c = idx % cols;
    const r = Math.floor(idx / cols);
    const dims = targetDims.get(f.id)!;
    const nx = Math.round(originX + c * (cellW + gapX));
    const ny = Math.round(rowYOffsets[r]);
    const dx = nx - f.x;
    const dy = ny - f.y;
    frameDeltas.set(f.id, { dx, dy });

    const changed = dx !== 0 || dy !== 0 || dims.w !== f.width || dims.h !== f.height;
    const updatedFrame: WhiteboardNode = changed
      ? { ...f, x: nx, y: ny, width: dims.w, height: dims.h, updatedAt: Date.now() }
      : f;
    if (f.id === targetId) targetFrameAfter = updatedFrame;
    if (changed) {
      beforeNodes.push(f);
      afterNodes.push(updatedFrame);
    }

    if (dx !== 0 || dy !== 0) {
      for (const child of ownedNodesByFrame.get(f.id) ?? []) {
        beforeNodes.push(child);
        afterNodes.push({ ...child, x: Math.round(child.x + dx), y: Math.round(child.y + dy) });
      }
    }
  });

  // 6. Shift free-floating edge endpoints & internal waypoints belonging to moved frames
  const beforeEdges: WhiteboardEdge[] = [];
  const afterEdges: WhiteboardEdge[] = [];
  for (const e of allEdges) {
    const srcOwner = e.source.nodeId
      ? ownerFrameOfNode.get(e.source.nodeId) ?? null
      : e.source.x !== undefined && e.source.y !== undefined
      ? pickOwnerForPoint(e.source.x, e.source.y)?.id ?? null
      : null;
    const tgtOwner = e.target.nodeId
      ? ownerFrameOfNode.get(e.target.nodeId) ?? null
      : e.target.x !== undefined && e.target.y !== undefined
      ? pickOwnerForPoint(e.target.x, e.target.y)?.id ?? null
      : null;

    const srcDelta = !e.source.nodeId && srcOwner ? frameDeltas.get(srcOwner) : undefined;
    const tgtDelta = !e.target.nodeId && tgtOwner ? frameDeltas.get(tgtOwner) : undefined;
    const wpDelta = srcOwner && srcOwner === tgtOwner ? frameDeltas.get(srcOwner) : undefined;

    const moveSrc = Boolean(srcDelta && (srcDelta.dx !== 0 || srcDelta.dy !== 0));
    const moveTgt = Boolean(tgtDelta && (tgtDelta.dx !== 0 || tgtDelta.dy !== 0));
    const moveWp = Boolean(wpDelta && (wpDelta.dx !== 0 || wpDelta.dy !== 0) && e.waypoints && e.waypoints.length > 0);
    if (!moveSrc && !moveTgt && !moveWp) continue;

    beforeEdges.push(e);
    afterEdges.push({
      ...e,
      source: moveSrc && srcDelta ? { x: Math.round((e.source.x ?? 0) + srcDelta.dx), y: Math.round((e.source.y ?? 0) + srcDelta.dy) } : e.source,
      target: moveTgt && tgtDelta ? { x: Math.round((e.target.x ?? 0) + tgtDelta.dx), y: Math.round((e.target.y ?? 0) + tgtDelta.dy) } : e.target,
      waypoints: moveWp && wpDelta ? e.waypoints!.map((wp) => ({ x: Math.round(wp.x + wpDelta.dx), y: Math.round(wp.y + wpDelta.dy) })) : e.waypoints,
    });
  }

  return { beforeNodes, afterNodes, beforeEdges, afterEdges, targetFrameAfter };
}

// ---- Format Painter ----------------------------------------------------------------------------

export interface WhiteboardStyleSnapshot {
  fillColor: string | null;
  fillOpacity?: number;
  fillType?: WhiteboardNode["fillType"];
  fillGradientAngle?: number;
  fillGradientStops?: WhiteboardNode["fillGradientStops"];
  fillPattern?: WhiteboardNode["fillPattern"];
  fillPatternColor?: string;
  fillPatternSpacing?: number;
  fillPatternOpacity?: number;
  strokeColor: string;
  strokeWidth: number;
  strokeStyle?: WhiteboardNode["strokeStyle"];
  strokeOpacity?: number;
  opacity?: number;
  blendMode?: WhiteboardNode["blendMode"];
  cornerRadius?: number;
  cornerRadii?: WhiteboardNode["cornerRadii"];
  shadowEnabled?: boolean;
  shadowColor?: string;
  shadowOpacity?: number;
  shadowBlur?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  fontFamily: string;
  fontSize: number;
  fontColor: string;
  fontWeight: WhiteboardNode["fontWeight"];
  fontStyle: WhiteboardNode["fontStyle"];
  textDecoration: WhiteboardNode["textDecoration"];
  textAlign: WhiteboardNode["textAlign"];
  verticalAlign: WhiteboardNode["verticalAlign"];
  mindmapColorKey?: WhiteboardNode["mindmapColorKey"];
}

export function extractStyleSnapshot(node: WhiteboardNode): WhiteboardStyleSnapshot {
  return {
    fillColor: node.fillColor,
    fillOpacity: node.fillOpacity,
    fillType: node.fillType,
    fillGradientAngle: node.fillGradientAngle,
    fillGradientStops: node.fillGradientStops ? node.fillGradientStops.map((s) => ({ ...s })) : undefined,
    fillPattern: node.fillPattern,
    fillPatternColor: node.fillPatternColor,
    fillPatternSpacing: node.fillPatternSpacing,
    fillPatternOpacity: node.fillPatternOpacity,
    strokeColor: node.strokeColor,
    strokeWidth: node.strokeWidth,
    strokeStyle: node.strokeStyle,
    strokeOpacity: node.strokeOpacity,
    opacity: node.opacity,
    blendMode: node.blendMode,
    cornerRadius: node.cornerRadius,
    cornerRadii: node.cornerRadii ? { ...node.cornerRadii } : undefined,
    shadowEnabled: node.shadowEnabled,
    shadowColor: node.shadowColor,
    shadowOpacity: node.shadowOpacity,
    shadowBlur: node.shadowBlur,
    shadowOffsetX: node.shadowOffsetX,
    shadowOffsetY: node.shadowOffsetY,
    fontFamily: node.fontFamily,
    fontSize: node.fontSize,
    fontColor: node.fontColor,
    fontWeight: node.fontWeight,
    fontStyle: node.fontStyle,
    textDecoration: node.textDecoration,
    textAlign: node.textAlign,
    verticalAlign: node.verticalAlign,
    mindmapColorKey: node.mindmapColorKey,
  };
}

export function applyStyleSnapshot(target: WhiteboardNode, snapshot: WhiteboardStyleSnapshot): WhiteboardNode {
  return {
    ...target,
    ...snapshot,
    fillGradientStops: snapshot.fillGradientStops ? snapshot.fillGradientStops.map((s) => ({ ...s })) : undefined,
    cornerRadii: snapshot.cornerRadii ? { ...snapshot.cornerRadii } : undefined,
    updatedAt: Date.now(),
  };
}

// ---- Cross-page Canvas Search (Ctrl+F) ---------------------------------------------------------

export interface WhiteboardSearchMatch {
  pageId: string;
  pageName: string;
  itemKind: "node" | "edge";
  itemId: string;
  snippet: string;
  x: number;
  y: number;
}

export function searchWhiteboardDocument(doc: WhiteboardDocument, rawQuery: string): WhiteboardSearchMatch[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const results: WhiteboardSearchMatch[] = [];
  for (const page of doc.pages) {
    const nodesById = new Map(page.nodes.map((n) => [n.id, n]));
    for (const node of page.nodes) {
      const haystacks: string[] = [];
      if (node.text) haystacks.push(node.text);
      if (node.mindmapDescription) haystacks.push(node.mindmapDescription);
      if (node.chartTitle) haystacks.push(node.chartTitle);
      if (node.mindmapItems) {
        for (const item of node.mindmapItems) {
          if (item.text) haystacks.push(item.text);
        }
      }
      if (node.mindmapResources) {
        for (const res of node.mindmapResources) {
          if (res.label) haystacks.push(res.label);
        }
      }
      if (node.tableCellText) {
        for (const row of node.tableCellText) {
          for (const cell of row) {
            if (cell) haystacks.push(cell);
          }
        }
      }

      const matched = haystacks.find((s) => s.toLowerCase().includes(query));
      if (matched) {
        const clean = matched.replace(/\s+/g, " ").trim();
        results.push({
          pageId: page.id,
          pageName: page.name,
          itemKind: "node",
          itemId: node.id,
          snippet: clean.length > 60 ? `${clean.slice(0, 57)}…` : clean,
          x: node.x + node.width / 2,
          y: node.y + node.height / 2,
        });
      }
    }

    for (const edge of page.edges) {
      if (!edge.label || !edge.label.toLowerCase().includes(query)) continue;
      const srcNode = edge.source.nodeId ? nodesById.get(edge.source.nodeId) : undefined;
      const tgtNode = edge.target.nodeId ? nodesById.get(edge.target.nodeId) : undefined;
      const sx = srcNode ? srcNode.x + srcNode.width / 2 : edge.source.x ?? 0;
      const sy = srcNode ? srcNode.y + srcNode.height / 2 : edge.source.y ?? 0;
      const tx = tgtNode ? tgtNode.x + tgtNode.width / 2 : edge.target.x ?? sx;
      const ty = tgtNode ? tgtNode.y + tgtNode.height / 2 : edge.target.y ?? sy;
      results.push({
        pageId: page.id,
        pageName: page.name,
        itemKind: "edge",
        itemId: edge.id,
        snippet: edge.label.trim(),
        x: (sx + tx) / 2,
        y: (sy + ty) / 2,
      });
    }
  }
  return results;
}

// ---- Ordered Presentation Frames (Artboards) ---------------------------------------------------

/**
 * Returns all `artboard` Containment Frames on a page sorted cleanly in reading order
 * (row bands top-to-bottom, then left-to-right within each row) for Presentation Mode,
 * the Frame Navigator, and Multi-Frame Slide Deck PDF export.
 */
export function getOrderedArtboards(nodes: WhiteboardNode[]): WhiteboardNode[] {
  const frames = nodes.filter((n) => isArtboardNode(n));
  if (frames.length <= 1) return frames;
  const avgH = frames.reduce((s, f) => s + f.height, 0) / frames.length;
  const rowBand = Math.max(80, avgH * 0.5);
  const minY = Math.min(...frames.map((f) => f.y));
  return [...frames].sort((a, b) => {
    const rowDiff = Math.round((a.y - minY) / rowBand) - Math.round((b.y - minY) / rowBand);
    return rowDiff !== 0 ? rowDiff : a.x - b.x;
  });
}

// ---- Viewport Frustum Culling for Large Canvases (Phase 4 Performance) -------------------------

export interface DocViewportRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const VIEWPORT_CULL_NODE_THRESHOLD = 40;

/**
 * O(N + E) frustum culling for large whiteboards. Below `threshold` nodes it returns the input
 * arrays untouched (zero overhead on small/medium diagrams). Above `threshold`, it filters out
 * off-screen nodes/edges outside `viewport` (expanded by `margin`), while ALWAYS retaining
 * selected, hovered, editing, or edge-referenced nodes so live drags and connectors never pop.
 */
export function cullVisibleItems(
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[],
  viewport: DocViewportRect | null,
  alwaysKeepNodeIds: ReadonlySet<string>,
  alwaysKeepEdgeIds: ReadonlySet<string>,
  threshold = VIEWPORT_CULL_NODE_THRESHOLD,
  margin = 220
): { nodes: WhiteboardNode[]; edges: WhiteboardEdge[]; culledCount: number } {
  if (!viewport || nodes.length <= threshold) {
    return { nodes, edges, culledCount: 0 };
  }

  const vx0 = viewport.minX - margin;
  const vy0 = viewport.minY - margin;
  const vx1 = viewport.maxX + margin;
  const vy1 = viewport.maxY + margin;

  const inView = (x0: number, y0: number, x1: number, y1: number) =>
    x1 >= vx0 && x0 <= vx1 && y1 >= vy0 && y0 <= vy1;

  const nodesById = new Map<string, WhiteboardNode>();
  const keptNodeIds = new Set<string>();

  for (const n of nodes) {
    nodesById.set(n.id, n);
    if (alwaysKeepNodeIds.has(n.id) || inView(n.x, n.y, n.x + n.width, n.y + n.height)) {
      keptNodeIds.add(n.id);
    }
  }

  const keptEdges: WhiteboardEdge[] = [];
  for (const e of edges) {
    if (alwaysKeepEdgeIds.has(e.id)) {
      keptEdges.push(e);
      if (e.source.nodeId) keptNodeIds.add(e.source.nodeId);
      if (e.target.nodeId) keptNodeIds.add(e.target.nodeId);
      continue;
    }
    const srcNode = e.source.nodeId ? nodesById.get(e.source.nodeId) : undefined;
    const tgtNode = e.target.nodeId ? nodesById.get(e.target.nodeId) : undefined;
    const sx = srcNode ? srcNode.x + srcNode.width / 2 : e.source.x ?? 0;
    const sy = srcNode ? srcNode.y + srcNode.height / 2 : e.source.y ?? 0;
    const tx = tgtNode ? tgtNode.x + tgtNode.width / 2 : e.target.x ?? sx;
    const ty = tgtNode ? tgtNode.y + tgtNode.height / 2 : e.target.y ?? sy;
    const ex0 = Math.min(sx, tx);
    const ey0 = Math.min(sy, ty);
    const ex1 = Math.max(sx, tx);
    const ey1 = Math.max(sy, ty);

    if (
      (e.source.nodeId && keptNodeIds.has(e.source.nodeId)) ||
      (e.target.nodeId && keptNodeIds.has(e.target.nodeId)) ||
      inView(ex0, ey0, ex1, ey1)
    ) {
      keptEdges.push(e);
    }
  }

  const keptNodes = nodes.filter((n) => keptNodeIds.has(n.id));
  return {
    nodes: keptNodes,
    edges: keptEdges,
    culledCount: nodes.length - keptNodes.length,
  };
}

// ---- Text Box Auto-Sizing & Reflow -------------------------------------------------------------

const TEXT_PAD_X = 16;
const TEXT_PAD_Y = 12;
const TEXT_MAX_AUTO_WIDTH = 520;
const TEXT_MIN_WIDTH = 64;

/**
 * Computes a clean bounding box `{ width, height }` for a `"text"` node given its content,
 * font size, weight, and current width. Never clips multi-line content, expands width smoothly up
 * to `TEXT_MAX_AUTO_WIDTH` when `allowWidthGrow` is true, and always ensures height fits all
 * wrapped lines cleanly. Pure & Canvas2D-optional so it works both in the browser and in Vitest.
 */
export function computeAutoTextBoxSize(
  text: string,
  fontSize: number,
  fontWeight: "normal" | "bold",
  currentWidth: number,
  allowWidthGrow = true,
  fontFamily = "system-ui, sans-serif"
): { width: number; height: number } {
  const safeFont = Math.max(8, fontSize || 16);
  const lineH = Math.ceil(safeFont * 1.38);
  const paragraphs = (text || "").split(/\r?\n/);

  // Measure line widths via an offscreen 2D canvas when available, falling back to an accurate
  // character-width heuristic in headless test environments.
  let measureStr = (s: string): number => s.length * safeFont * (fontWeight === "bold" ? 0.62 : 0.56);
  if (typeof document !== "undefined") {
    try {
      const c = document.createElement("canvas");
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.font = `${fontWeight === "bold" ? "700 " : ""}${safeFont}px ${fontFamily}`;
        const testW = ctx.measureText("M").width;
        if (testW > 0) {
          measureStr = (s: string) => ctx.measureText(s).width;
        }
      }
    } catch {
      // keep heuristic fallback
    }
  }

  let maxLineW = 0;
  for (const p of paragraphs) {
    const w = measureStr(p);
    if (w > maxLineW) maxLineW = w;
  }

  const targetWidth = allowWidthGrow
    ? Math.max(TEXT_MIN_WIDTH, Math.min(TEXT_MAX_AUTO_WIDTH, Math.max(currentWidth, Math.ceil(maxLineW + TEXT_PAD_X + 6))))
    : Math.max(TEXT_MIN_WIDTH, currentWidth);

  const innerW = Math.max(24, targetWidth - TEXT_PAD_X);
  let totalLines = 0;
  for (const p of paragraphs) {
    if (!p) {
      totalLines += 1;
      continue;
    }
    const words = p.split(/(\s+)/);
    let lineW = 0;
    let linesInPara = 1;
    for (const token of words) {
      const tw = measureStr(token);
      if (lineW > 0 && lineW + tw > innerW) {
        linesInPara += 1;
        lineW = token.trim() ? tw : 0;
      } else {
        lineW += tw;
      }
      // Handle very long single unbroken tokens
      if (lineW > innerW && token.trim().length > 1) {
        const extra = Math.floor(lineW / innerW);
        if (extra > 0) {
          linesInPara += extra;
          lineW = lineW % innerW;
        }
      }
    }
    totalLines += linesInPara;
  }

  const height = Math.max(lineH + TEXT_PAD_Y, totalLines * lineH + TEXT_PAD_Y);
  return { width: Math.round(targetWidth), height: Math.round(height) };
}

