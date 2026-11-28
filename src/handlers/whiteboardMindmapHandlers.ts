// handlers/whiteboardMindmapHandlers.ts
//
// Pure, zero-DOM handlers powering native Mind Map & Learning Roadmap workflows inside Whiteboard:
// - 1-keystroke branching (Tab = add child, Enter = add sibling) and 4-direction quick-add with
//   non-overlapping sibling fan-out
// - O(V + E) subtree collapse/expand visibility computation (+N descendant badges)
// - 1-click Auto-Layout (Right Tree, Balanced Left/Right Radial, Top-Down Org/Roadmap)
// - Starter templates (Mind Map & Learning Roadmap)
// - Lossless MindmapDocument -> WhiteboardDocument converter so existing saved mindmaps open
//   directly in Whiteboard without losing topics, resources, progress, checklists, or links.

import {
  MINDMAP_FONT_PX,
  MINDMAP_PALETTE,
  MindmapColorKey,
  MindmapDocument,
  MindmapNode,
  MindmapProgress,
} from "../utils/mindmapTypes";
import {
  createDefaultWhiteboardEdge,
  createDefaultWhiteboardNode,
  createEmptyWhiteboardPage,
  isMindmapTopicNode,
  WHITEBOARD_SCHEMA_VERSION,
  WhiteboardAnchorSide,
  WhiteboardDocument,
  WhiteboardEdge,
  WhiteboardNode,
  WhiteboardPage,
  WhiteboardShapeType,
} from "../utils/whiteboardTypes";

export type MindmapLayoutMode = "right" | "balanced" | "topDown";
export type CardinalSide = Exclude<WhiteboardAnchorSide, "auto">;

const BRANCH_GAP_X = 76;
const BRANCH_GAP_Y = 58;
const FAN_STEP = 14;
const MAX_FAN_STEPS = 24;

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  pad = 10
): boolean {
  return (
    a.x < b.x + b.width + pad &&
    a.x + a.width + pad > b.x &&
    a.y < b.y + b.height + pad &&
    a.y + a.height + pad > b.y
  );
}

export function oppositeSide(side: CardinalSide): CardinalSide {
  switch (side) {
    case "left":
      return "right";
    case "right":
      return "left";
    case "top":
      return "bottom";
    case "bottom":
      return "top";
  }
}

/**
 * Applies a coherent Mind Map palette key ("A".."H") to a WhiteboardNode's fill/stroke/text colors
 * while recording `mindmapColorKey` so the swatch picker stays in sync.
 */
export function applyMindmapPaletteKey(node: WhiteboardNode, colorKey: MindmapColorKey): WhiteboardNode {
  const entry = MINDMAP_PALETTE[colorKey];
  return {
    ...node,
    mindmapColorKey: colorKey,
    fillColor: entry.background,
    strokeColor: entry.border,
    fontColor: entry.text,
  };
}

/**
 * Builds a connected child/branch node off `parent` in `side`'s direction, fanning out to avoid
 * overlapping any existing node on the page. Returns `{ node, edge }` ready for `addNodeWithEdge`.
 */
export function buildMindmapBranch(
  parent: WhiteboardNode,
  side: CardinalSide,
  existingNodes: WhiteboardNode[],
  newNodeId: string,
  newEdgeId: string,
  opts?: { shapeType?: WhiteboardShapeType; text?: string; colorKey?: MindmapColorKey }
): { node: WhiteboardNode; edge: WhiteboardEdge } {
  const isVerticalSpine = side === "top" || side === "bottom";
  const childType: WhiteboardShapeType =
    opts?.shapeType ??
    (parent.shapeType === "mindmapTopic"
      ? isVerticalSpine
        ? "mindmapTopic"
        : "mindmapSubtopic"
      : parent.shapeType === "mindmapSubtopic"
      ? "mindmapSubtopic"
      : "mindmapSubtopic");

  let node = createDefaultWhiteboardNode(newNodeId, childType, 0, 0);
  if (opts?.text !== undefined) {
    node = { ...node, text: opts.text };
  } else {
    node = { ...node, text: childType === "mindmapTopic" ? "New topic" : "New subtopic" };
  }
  if (opts?.colorKey) {
    node = applyMindmapPaletteKey(node, opts.colorKey);
  } else if (parent.mindmapColorKey && childType === parent.shapeType) {
    node = applyMindmapPaletteKey(node, parent.mindmapColorKey);
  }

  const pCx = parent.x + parent.width / 2;
  const pCy = parent.y + parent.height / 2;
  const baseX =
    side === "right"
      ? parent.x + parent.width + BRANCH_GAP_X
      : side === "left"
      ? parent.x - BRANCH_GAP_X - node.width
      : pCx - node.width / 2;
  const baseY =
    side === "bottom"
      ? parent.y + parent.height + BRANCH_GAP_Y
      : side === "top"
      ? parent.y - BRANCH_GAP_Y - node.height
      : pCy - node.height / 2;

  const isHorizontalBranch = side === "left" || side === "right";
  const stepDist = isHorizontalBranch ? node.height + FAN_STEP : node.width + FAN_STEP;

  let chosenX = baseX;
  let chosenY = baseY;
  for (let i = 0; i <= MAX_FAN_STEPS; i++) {
    const offset = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * stepDist;
    const candX = isHorizontalBranch ? baseX : baseX + offset;
    const candY = isHorizontalBranch ? baseY + offset : baseY;
    const cand = { x: candX, y: candY, width: node.width, height: node.height };
    const collides = existingNodes.some((n) => n.shapeType !== "artboard" && rectsOverlap(cand, n));
    if (!collides) {
      chosenX = candX;
      chosenY = candY;
      break;
    }
  }

  node = { ...node, x: Math.round(chosenX), y: Math.round(chosenY) };
  const isSubBranch = childType === "mindmapSubtopic";
  const edge: WhiteboardEdge = {
    ...createDefaultWhiteboardEdge(
      newEdgeId,
      { nodeId: parent.id, anchor: side },
      { nodeId: node.id, anchor: oppositeSide(side) }
    ),
    routing: "curved",
    strokeColor: "#2b7fff",
    strokeWidth: isSubBranch ? 2 : 2.5,
    strokeStyle: isSubBranch ? "dashed" : "solid",
    startArrowType: "none",
    endArrowType: "none",
  };

  return { node, edge };
}

/**
 * Infers which side `child` sits on relative to `parent`, falling back to the edge anchor or "right".
 */
function inferBranchSide(parent: WhiteboardNode, child: WhiteboardNode, edge?: WhiteboardEdge): CardinalSide {
  if (edge?.source.anchor && edge.source.anchor !== "auto") return edge.source.anchor;
  const dx = child.x + child.width / 2 - (parent.x + parent.width / 2);
  const dy = child.y + child.height / 2 - (parent.y + parent.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/**
 * Powers the `Enter` keystroke on a selected Mind Map node:
 * - If `node` has an incoming parent edge, adds a sibling connected to that parent on the same side.
 * - Otherwise (root node), spawns a peer topic directly below it connected via the vertical spine.
 */
export function buildMindmapSibling(
  node: WhiteboardNode,
  page: WhiteboardPage,
  newNodeId: string,
  newEdgeId: string
): { node: WhiteboardNode; edge: WhiteboardEdge } {
  const incoming = page.edges.find((e) => e.target.nodeId === node.id && e.source.nodeId);
  if (incoming?.source.nodeId) {
    const parent = page.nodes.find((n) => n.id === incoming.source.nodeId);
    if (parent) {
      const side = inferBranchSide(parent, node, incoming);
      return buildMindmapBranch(parent, side, page.nodes, newNodeId, newEdgeId, {
        shapeType: node.shapeType,
        colorKey: node.mindmapColorKey,
      });
    }
  }
  return buildMindmapBranch(node, "bottom", page.nodes, newNodeId, newEdgeId, {
    shapeType: node.shapeType,
    colorKey: node.mindmapColorKey,
  });
}

export interface CollapsedGraphState {
  hiddenNodeIds: Set<string>;
  hiddenEdgeIds: Set<string>;
  /** For any node with `mindmapCollapsed: true`, the count of hidden descendant nodes under it. */
  collapsedCountByNodeId: Map<string, number>;
  /** Direct outgoing child IDs per node (for showing the collapse/expand pill on branch parents). */
  childrenByParent: Map<string, string[]>;
}

/**
 * Single-pass O(V + E) visibility computation for collapsed Mind Map branches.
 * Handles arbitrary graphs/cycles safely via a visited set.
 */
export function getCollapsedState(nodes: WhiteboardNode[], edges: WhiteboardEdge[]): CollapsedGraphState {
  const childrenByParent = new Map<string, string[]>();
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    const src = edge.source.nodeId;
    const tgt = edge.target.nodeId;
    if (!src || !tgt || src === tgt || !nodeIds.has(src) || !nodeIds.has(tgt)) continue;
    let list = childrenByParent.get(src);
    if (!list) {
      list = [];
      childrenByParent.set(src, list);
    }
    if (!list.includes(tgt)) list.push(tgt);
  }

  const hiddenNodeIds = new Set<string>();
  const collapsedCountByNodeId = new Map<string, number>();

  for (const node of nodes) {
    if (!node.mindmapCollapsed) continue;
    const direct = childrenByParent.get(node.id);
    if (!direct || direct.length === 0) continue;
    const visited = new Set<string>([node.id]);
    const queue: string[] = [...direct];
    let count = 0;
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (visited.has(curr)) continue;
      visited.add(curr);
      hiddenNodeIds.add(curr);
      count++;
      const nextChildren = childrenByParent.get(curr);
      if (nextChildren) {
        for (const c of nextChildren) {
          if (!visited.has(c)) queue.push(c);
        }
      }
    }
    if (count > 0) collapsedCountByNodeId.set(node.id, count);
  }

  const hiddenEdgeIds = new Set<string>();
  if (hiddenNodeIds.size > 0) {
    for (const edge of edges) {
      if (
        (edge.source.nodeId && hiddenNodeIds.has(edge.source.nodeId)) ||
        (edge.target.nodeId && hiddenNodeIds.has(edge.target.nodeId))
      ) {
        hiddenEdgeIds.add(edge.id);
      }
    }
  }

  return { hiddenNodeIds, hiddenEdgeIds, collapsedCountByNodeId, childrenByParent };
}

/**
 * 1-click Auto-Layout for Mind Map / Org / Roadmap trees.
 * Computes non-overlapping subtree spans in O(V + E) anchored at `rootId` (kept stationary so the
 * viewport doesn't jump away), returning `{ before, after }` for a single undoable `batchEditNodes`.
 */
export function autoLayoutMindmap(
  rootId: string,
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[],
  mode: MindmapLayoutMode
): { before: WhiteboardNode[]; after: WhiteboardNode[]; beforeEdges: WhiteboardEdge[]; afterEdges: WhiteboardEdge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = byId.get(rootId);
  if (!root) return { before: [], after: [], beforeEdges: [], afterEdges: [] };

  // Build spanning tree rooted at rootId using outgoing edges first, falling back to undirected
  // neighbors so mindmaps with mixed edge directions still lay out cleanly.
  const outgoing = new Map<string, string[]>();
  const undirected = new Map<string, string[]>();
  for (const e of edges) {
    const s = e.source.nodeId;
    const t = e.target.nodeId;
    if (!s || !t || s === t || !byId.has(s) || !byId.has(t)) continue;
    if (!outgoing.has(s)) outgoing.set(s, []);
    outgoing.get(s)!.push(t);
    if (!undirected.has(s)) undirected.set(s, []);
    if (!undirected.has(t)) undirected.set(t, []);
    undirected.get(s)!.push(t);
    undirected.get(t)!.push(s);
  }

  const visited = new Set<string>([rootId]);
  const treeChildren = new Map<string, string[]>();
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    const out = outgoing.get(curr) ?? [];
    const fallback = out.length > 0 ? out : undirected.get(curr) ?? [];
    const kids: string[] = [];
    for (const next of fallback) {
      if (visited.has(next)) continue;
      visited.add(next);
      kids.push(next);
      queue.push(next);
    }
    treeChildren.set(curr, kids);
  }

  if (visited.size <= 1) return { before: [], after: [], beforeEdges: [], afterEdges: [] };

  const GAP_H = 84;
  const GAP_V = 26;
  const TOPDOWN_GAP_X = 36;
  const TOPDOWN_GAP_Y = 74;

  const newPos = new Map<string, { x: number; y: number }>();
  const edgeAnchors = new Map<string, { src: CardinalSide; tgt: CardinalSide }>();

  if (mode === "topDown") {
    const subtreeW = new Map<string, number>();
    const measure = (id: string): number => {
      const n = byId.get(id)!;
      const kids = treeChildren.get(id) ?? [];
      if (kids.length === 0) {
        subtreeW.set(id, n.width);
        return n.width;
      }
      const sum = kids.reduce((acc, k) => acc + measure(k), 0) + TOPDOWN_GAP_X * (kids.length - 1);
      const w = Math.max(n.width, sum);
      subtreeW.set(id, w);
      return w;
    };
    measure(rootId);

    const place = (id: string, centerX: number, topY: number) => {
      const n = byId.get(id)!;
      newPos.set(id, { x: Math.round(centerX - n.width / 2), y: Math.round(topY) });
      const kids = treeChildren.get(id) ?? [];
      if (kids.length === 0) return;
      const totalKidsW = kids.reduce((acc, k) => acc + (subtreeW.get(k) ?? 160), 0) + TOPDOWN_GAP_X * (kids.length - 1);
      let cursorX = centerX - totalKidsW / 2;
      const childTopY = topY + n.height + TOPDOWN_GAP_Y;
      for (const k of kids) {
        const kw = subtreeW.get(k) ?? 160;
        place(k, cursorX + kw / 2, childTopY);
        edgeAnchors.set(`${id}->${k}`, { src: "bottom", tgt: "top" });
        cursorX += kw + TOPDOWN_GAP_X;
      }
    };
    place(rootId, root.x + root.width / 2, root.y);
  } else {
    const subtreeH = new Map<string, number>();
    const measureH = (id: string): number => {
      const n = byId.get(id)!;
      const kids = treeChildren.get(id) ?? [];
      if (kids.length === 0) {
        subtreeH.set(id, n.height);
        return n.height;
      }
      const sum = kids.reduce((acc, k) => acc + measureH(k), 0) + GAP_V * (kids.length - 1);
      const h = Math.max(n.height, sum);
      subtreeH.set(id, h);
      return h;
    };
    measureH(rootId);

    const placeHorizontal = (id: string, x: number, centerY: number, dir: 1 | -1) => {
      const n = byId.get(id)!;
      newPos.set(id, { x: Math.round(x), y: Math.round(centerY - n.height / 2) });
      const kids = treeChildren.get(id) ?? [];
      if (kids.length === 0) return;
      const totalH = kids.reduce((acc, k) => acc + (subtreeH.get(k) ?? 48), 0) + GAP_V * (kids.length - 1);
      let cursorY = centerY - totalH / 2;
      for (const k of kids) {
        const kn = byId.get(k)!;
        const kh = subtreeH.get(k) ?? kn.height;
        const childX = dir === 1 ? x + n.width + GAP_H : x - GAP_H - kn.width;
        placeHorizontal(k, childX, cursorY + kh / 2, dir);
        edgeAnchors.set(`${id}->${k}`, { src: dir === 1 ? "right" : "left", tgt: dir === 1 ? "left" : "right" });
        cursorY += kh + GAP_V;
      }
    };

    const rootKids = treeChildren.get(rootId) ?? [];
    newPos.set(rootId, { x: Math.round(root.x), y: Math.round(root.y) });
    const rootCy = root.y + root.height / 2;

    if (mode === "right") {
      placeHorizontal(rootId, root.x, rootCy, 1);
    } else {
      // Balanced: split root children evenly between right and left wings.
      const rightKids: string[] = [];
      const leftKids: string[] = [];
      rootKids.forEach((k, idx) => {
        if (idx % 2 === 0) rightKids.push(k);
        else leftKids.push(k);
      });

      const placeWing = (kids: string[], dir: 1 | -1) => {
        if (kids.length === 0) return;
        const totalH = kids.reduce((acc, k) => acc + (subtreeH.get(k) ?? 48), 0) + GAP_V * (kids.length - 1);
        let cursorY = rootCy - totalH / 2;
        for (const k of kids) {
          const kn = byId.get(k)!;
          const kh = subtreeH.get(k) ?? kn.height;
          const childX = dir === 1 ? root.x + root.width + GAP_H : root.x - GAP_H - kn.width;
          placeHorizontal(k, childX, cursorY + kh / 2, dir);
          edgeAnchors.set(`${rootId}->${k}`, { src: dir === 1 ? "right" : "left", tgt: dir === 1 ? "left" : "right" });
          cursorY += kh + GAP_V;
        }
      };

      placeWing(rightKids, 1);
      placeWing(leftKids, -1);
    }
  }

  const before: WhiteboardNode[] = [];
  const after: WhiteboardNode[] = [];
  for (const [id, pos] of newPos.entries()) {
    const orig = byId.get(id);
    if (!orig || orig.locked) continue;
    if (orig.x !== pos.x || orig.y !== pos.y) {
      before.push(orig);
      after.push({ ...orig, x: pos.x, y: pos.y });
    }
  }

  const beforeEdges: WhiteboardEdge[] = [];
  const afterEdges: WhiteboardEdge[] = [];
  for (const e of edges) {
    if (e.locked || !e.source.nodeId || !e.target.nodeId) continue;
    const direct = edgeAnchors.get(`${e.source.nodeId}->${e.target.nodeId}`);
    const reversed = edgeAnchors.get(`${e.target.nodeId}->${e.source.nodeId}`);
    const match = direct ? { src: direct.src, tgt: direct.tgt } : reversed ? { src: reversed.tgt, tgt: reversed.src } : null;
    if (!match) continue;
    if (e.source.anchor !== match.src || e.target.anchor !== match.tgt) {
      beforeEdges.push(e);
      afterEdges.push({
        ...e,
        source: { ...e.source, anchor: match.src },
        target: { ...e.target, anchor: match.tgt },
      });
    }
  }

  return { before, after, beforeEdges, afterEdges };
}

/**
 * Finds the best Mind Map root node on a page (preferring selected node, else a mindmapTopic with
 * zero incoming edges, else the first mindmapTopic).
 */
export function findMindmapRootId(nodes: WhiteboardNode[], edges: WhiteboardEdge[], preferredId?: string | null): string | null {
  if (preferredId && nodes.some((n) => n.id === preferredId)) return preferredId;
  const incomingTargets = new Set(edges.map((e) => e.target.nodeId).filter(Boolean));
  const topicNodes = nodes.filter((n) => isMindmapTopicNode(n));
  const rootTopic = topicNodes.find((n) => !incomingTargets.has(n.id));
  if (rootTopic) return rootTopic.id;
  if (topicNodes.length > 0) return topicNodes[0].id;
  return nodes[0]?.id ?? null;
}

/**
 * Counts learner progress across all Mind Map topic/subtopic nodes on a page.
 */
export function computeMindmapProgressStats(nodes: WhiteboardNode[]): { total: number; done: number; inProgress: number } {
  let total = 0;
  let done = 0;
  let inProgress = 0;
  for (const n of nodes) {
    if (!isMindmapTopicNode(n)) continue;
    total++;
    const p: MindmapProgress = n.mindmapProgress ?? "pending";
    if (p === "done") done++;
    else if (p === "in-progress") inProgress++;
  }
  return { total, done, inProgress };
}

/**
 * Creates a Mind Map or Learning Roadmap starter WhiteboardDocument.
 */
export function createMindmapWhiteboardDocument(
  id: string,
  name: string,
  variant: "mindmap" | "roadmap"
): WhiteboardDocument {
  const now = new Date().toISOString();
  const page = createEmptyWhiteboardPage(crypto.randomUUID(), variant === "roadmap" ? "Roadmap" : "Mind Map");
  const nodes: WhiteboardNode[] = [];
  const edges: WhiteboardEdge[] = [];

  const connect = (
    from: WhiteboardNode,
    fromSide: CardinalSide,
    to: WhiteboardNode,
    toSide: CardinalSide,
    dashed = false
  ) => {
    edges.push({
      ...createDefaultWhiteboardEdge(
        crypto.randomUUID(),
        { nodeId: from.id, anchor: fromSide },
        { nodeId: to.id, anchor: toSide }
      ),
      routing: "curved",
      strokeColor: "#2b7fff",
      strokeWidth: dashed ? 2 : 2.5,
      strokeStyle: dashed ? "dashed" : "solid",
      startArrowType: "none",
      endArrowType: "none",
    });
  };

  if (variant === "mindmap") {
    const center = applyMindmapPaletteKey(
      {
        ...createDefaultWhiteboardNode(crypto.randomUUID(), "mindmapTopic", 640, 360),
        text: "Central Idea",
        width: 210,
        height: 56,
        fontSize: 17,
        mindmapDescription: "Press Tab to add a child branch, Enter to add a sibling, or click the arrows around any topic.",
      },
      "B"
    );
    nodes.push(center);

    const makeBranch = (label: string, colorKey: MindmapColorKey, x: number, y: number, side: CardinalSide, subs: string[]) => {
      const branch = applyMindmapPaletteKey(
        {
          ...createDefaultWhiteboardNode(crypto.randomUUID(), "mindmapTopic", x, y),
          text: label,
          width: 170,
          height: 44,
        },
        colorKey
      );
      nodes.push(branch);
      connect(center, side, branch, oppositeSide(side), false);

      subs.forEach((subLabel, idx) => {
        const offsetY = (idx - (subs.length - 1) / 2) * 58;
        const subX = side === "right" ? x + 230 : x - 230;
        const sub = applyMindmapPaletteKey(
          {
            ...createDefaultWhiteboardNode(crypto.randomUUID(), "mindmapSubtopic", subX, y + offsetY),
            text: subLabel,
            width: 152,
            height: 38,
          },
          colorKey
        );
        nodes.push(sub);
        connect(branch, side, sub, oppositeSide(side), true);
      });
    };

    makeBranch("Goals & Scope", "E", 930, 240, "right", ["Core outcome", "Key milestones"]);
    makeBranch("Architecture", "D", 930, 480, "right", ["Components", "Data flow"]);
    makeBranch("Research", "H", 350, 240, "left", ["References", "Open questions"]);
    makeBranch("Next Actions", "C", 350, 480, "left", ["Quick wins", "Blockers"]);
  } else {
    // Learning Roadmap template (vertical spine + left/right subtopics + checklist + links)
    const checklist = createDefaultWhiteboardNode(crypto.randomUUID(), "mindmapChecklist", 240, 240, {
      mindmapItems: [
        { id: crypto.randomUUID(), text: "Set your learning goal", checked: true },
        { id: crypto.randomUUID(), text: "Click any topic for resources", checked: false },
        { id: crypto.randomUUID(), text: "Switch to Study Mode to track progress", checked: false },
      ],
    });
    checklist.text = "Getting started";
    checklist.width = 250;
    checklist.height = 148;
    nodes.push(checklist);

    const links = createDefaultWhiteboardNode(crypto.randomUUID(), "mindmapLinksGroup", 240, 430, {
      mindmapItems: [
        { id: crypto.randomUUID(), text: "Official documentation", url: "" },
        { id: crypto.randomUUID(), text: "Community handbook", url: "" },
      ],
    });
    links.text = "Reference links";
    links.width = 250;
    links.height = 116;
    nodes.push(links);

    const spineX = 720;
    const foundations = applyMindmapPaletteKey(
      {
        ...createDefaultWhiteboardNode(crypto.randomUUID(), "mindmapTopic", spineX, 170),
        text: "Foundations",
        mindmapProgress: "in-progress",
        mindmapDescription: "The core concepts everything else builds on. Edit this description and attach videos, docs, or articles in the Topic Details drawer.",
        mindmapResources: [
          { id: crypto.randomUUID(), type: "article", label: "Introductory overview", url: "", official: true },
          { id: crypto.randomUUID(), type: "video", label: "Quick walkthrough video", url: "" },
        ],
      },
      "B"
    );
    const core = applyMindmapPaletteKey(
      { ...createDefaultWhiteboardNode(crypto.randomUUID(), "mindmapTopic", spineX, 340), text: "Core Concepts" },
      "B"
    );
    const practice = applyMindmapPaletteKey(
      { ...createDefaultWhiteboardNode(crypto.randomUUID(), "mindmapTopic", spineX, 510), text: "Practice & Projects" },
      "B"
    );
    nodes.push(foundations, core, practice);
    connect(foundations, "bottom", core, "top", false);
    connect(core, "bottom", practice, "top", false);

    const addSubs = (parent: WhiteboardNode, side: "left" | "right", labels: string[]) => {
      labels.forEach((label, idx) => {
        const offsetY = (idx - (labels.length - 1) / 2) * 52;
        const subX = side === "right" ? parent.x + parent.width + 165 : parent.x - 165;
        const sub = applyMindmapPaletteKey(
          {
            ...createDefaultWhiteboardNode(crypto.randomUUID(), "mindmapSubtopic", subX, parent.y + parent.height / 2 + offsetY),
            text: label,
          },
          "C"
        );
        nodes.push(sub);
        connect(parent, side, sub, oppositeSide(side), true);
      });
    };

    addSubs(foundations, "right", ["Mental model", "Key terminology", "Tooling setup"]);
    addSubs(core, "left", ["Core pattern A", "Core pattern B"]);
    addSubs(practice, "right", ["Mini project", "Capstone build"]);
  }

  page.nodes = nodes;
  page.edges = edges;

  return {
    version: WHITEBOARD_SCHEMA_VERSION,
    id,
    name,
    showGrid: true,
    snapToGrid: true,
    pages: [page],
    activePageId: page.id,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Lossless converter turning any legacy saved MindmapDocument into a native WhiteboardDocument.
 */
export function convertMindmapDocumentToWhiteboardDocument(
  mindmapDoc: MindmapDocument,
  newWhiteboardId: string
): WhiteboardDocument {
  const now = new Date().toISOString();
  const page = createEmptyWhiteboardPage(crypto.randomUUID(), mindmapDoc.name || "Mind Map");

  const convertedNodes: WhiteboardNode[] = mindmapDoc.nodes.map((mn: MindmapNode) => {
    const palette = MINDMAP_PALETTE[mn.colorKey] ?? MINDMAP_PALETTE.A;
    const fontPx = MINDMAP_FONT_PX[mn.fontSize] ?? 14;
    let shapeType: WhiteboardShapeType;
    switch (mn.type) {
      case "title":
      case "topic":
        shapeType = "mindmapTopic";
        break;
      case "subtopic":
      case "button":
        shapeType = "mindmapSubtopic";
        break;
      case "checklist":
        shapeType = "mindmapChecklist";
        break;
      case "linksGroup":
        shapeType = "mindmapLinksGroup";
        break;
      case "section":
        shapeType = "artboard";
        break;
      case "paragraph":
      case "label":
        shapeType = "text";
        break;
      case "horizontalLine":
      case "verticalLine":
        shapeType = "rectangle";
        break;
      case "image":
        shapeType = "rectangle";
        break;
      default:
        shapeType = "mindmapSubtopic";
    }

    const base = createDefaultWhiteboardNode(mn.id, shapeType, mn.x + mn.width / 2, mn.y + mn.height / 2);
    const isLine = mn.type === "horizontalLine" || mn.type === "verticalLine";
    const isTextOnly = mn.type === "paragraph" || mn.type === "label";
    return {
      ...base,
      id: mn.id,
      x: mn.x,
      y: mn.y,
      width: Math.max(isLine ? 2 : 24, mn.width),
      height: Math.max(isLine ? 2 : 24, mn.height),
      text: isLine ? "" : mn.label,
      fillColor: isTextOnly ? null : isLine ? palette.border : mn.type === "section" ? `${palette.background}` : palette.background,
      fillOpacity: mn.type === "section" ? 0.35 : 1,
      strokeColor: isTextOnly ? "transparent" : palette.border,
      strokeWidth: isTextOnly || isLine ? 0 : 2,
      strokeStyle: mn.type === "section" ? "dashed" : "solid",
      cornerRadius: mn.type === "title" || mn.type === "topic" ? 8 : mn.type === "subtopic" || mn.type === "button" ? 6 : mn.type === "section" ? 10 : 4,
      fontSize: fontPx,
      fontColor: palette.text,
      fontWeight: mn.bold || mn.type === "title" ? "bold" : "normal",
      fontStyle: mn.italic ? "italic" : "normal",
      textAlign: mn.type === "paragraph" || mn.type === "label" || mn.type === "checklist" || mn.type === "linksGroup" ? "left" : "center",
      verticalAlign: mn.type === "paragraph" || mn.type === "checklist" || mn.type === "linksGroup" ? "top" : "middle",
      mindmapColorKey: mn.colorKey,
      mindmapDescription: mn.description,
      mindmapProgress: mn.progress,
      mindmapResources: mn.resources,
      mindmapItems: mn.items,
      mindmapCheckStyle: mn.checkStyle,
      mindmapCheckColor: mn.checkColor,
    };
  });

  // Sort artboards/sections to the back so topics sit cleanly on top.
  convertedNodes.sort((a, b) => (a.shapeType === "artboard" ? -1 : 0) - (b.shapeType === "artboard" ? -1 : 0));

  const convertedEdges: WhiteboardEdge[] = mindmapDoc.edges.map((me) => ({
    ...createDefaultWhiteboardEdge(
      me.id,
      { nodeId: me.sourceId, anchor: me.sourceSide },
      { nodeId: me.targetId, anchor: me.targetSide }
    ),
    routing: "curved",
    strokeColor: "#2b7fff",
    strokeWidth: me.style === "dashed" ? 2 : 2.5,
    strokeStyle: me.style === "dashed" ? "dashed" : "solid",
    startArrowType: "none",
    endArrowType: "none",
  }));

  page.nodes = convertedNodes;
  page.edges = convertedEdges;

  return {
    version: WHITEBOARD_SCHEMA_VERSION,
    id: newWhiteboardId,
    name: mindmapDoc.name || "Imported Mind Map",
    showGrid: mindmapDoc.showGrid ?? true,
    snapToGrid: mindmapDoc.snapToGrid ?? true,
    pages: [page],
    activePageId: page.id,
    createdAt: mindmapDoc.createdAt || now,
    updatedAt: now,
  };
}

// ===============================================================================================
// Pro Mind Map Operations (Smart Directional Branching, Subtree Selection/Recolor/Delete,
// Sibling Reordering, Insert Parent, Expand/Collapse All, and Outline -> Briefcast Doc Export)
// ===============================================================================================

/**
 * Walks incoming parent edges up to the root of the Mind Map tree containing `nodeId`
 * (cycle-safe). Lets Auto-Layout, Expand/Collapse All, and Doc Export work cleanly regardless
 * of which branch node the user currently has selected.
 */
export function findMindmapRoot(nodeId: string, nodes: WhiteboardNode[], edges: WhiteboardEdge[]): string {
  const byId = new Set(nodes.map((n) => n.id));
  if (!byId.has(nodeId)) return nodeId;
  let curr = nodeId;
  const visited = new Set<string>([curr]);
  while (true) {
    const incoming = edges.find((e) => e.target.nodeId === curr && e.source.nodeId && byId.has(e.source.nodeId));
    if (!incoming?.source.nodeId || visited.has(incoming.source.nodeId)) break;
    curr = incoming.source.nodeId;
    visited.add(curr);
  }
  return curr;
}

/**
 * Picks the natural outward side when pressing `Tab` (Add Child) on a Mind Map node:
 *   - Non-root left-branch nodes keep expanding `"left"` instead of crashing back through the root.
 *   - Non-root right-branch nodes expand `"right"`; top/bottom spine nodes expand outward.
 *   - Root nodes automatically balance left vs. right children so balanced mind maps stay symmetric.
 */
export function inferMindmapChildSide(node: WhiteboardNode, page: WhiteboardPage): CardinalSide {
  const incoming = page.edges.find((e) => e.target.nodeId === node.id && e.source.nodeId);
  if (incoming?.source.nodeId) {
    const parent = page.nodes.find((n) => n.id === incoming.source.nodeId);
    if (parent) {
      return inferBranchSide(parent, node, incoming);
    }
  }
  // Root node: balance right vs left outgoing branches.
  let leftCount = 0;
  let rightCount = 0;
  for (const e of page.edges) {
    if (e.source.nodeId !== node.id || !e.target.nodeId) continue;
    const child = page.nodes.find((n) => n.id === e.target.nodeId);
    if (!child) continue;
    const side = inferBranchSide(node, child, e);
    if (side === "left") leftCount++;
    else if (side === "right") rightCount++;
  }
  return leftCount < rightCount ? "left" : "right";
}

/**
 * Collects `rootId` and every descendant node + all edges touching that subtree.
 * Powers Select Subtree, Delete Subtree, Move Subtree, and Branch Recoloring.
 */
export function getMindmapSubtree(
  rootId: string,
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[]
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeSet = new Set(nodes.map((n) => n.id));
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  if (!nodeSet.has(rootId)) return { nodeIds, edgeIds };

  const outgoing = new Map<string, WhiteboardEdge[]>();
  for (const e of edges) {
    if (!e.source.nodeId || !e.target.nodeId || e.source.nodeId === e.target.nodeId) continue;
    if (!nodeSet.has(e.source.nodeId) || !nodeSet.has(e.target.nodeId)) continue;
    let list = outgoing.get(e.source.nodeId);
    if (!list) {
      list = [];
      outgoing.set(e.source.nodeId, list);
    }
    list.push(e);
  }

  const queue: string[] = [rootId];
  nodeIds.add(rootId);
  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const e of outgoing.get(curr) ?? []) {
      edgeIds.add(e.id);
      const child = e.target.nodeId!;
      if (!nodeIds.has(child)) {
        nodeIds.add(child);
        queue.push(child);
      }
    }
  }

  return { nodeIds, edgeIds };
}

/**
 * Applies a Mind Map palette color key harmonically to `rootId`, all of its descendants, and the
 * internal connectors linking them, returning an undoable `{ before, after, beforeEdges, afterEdges }`.
 */
export function recolorMindmapBranch(
  rootId: string,
  colorKey: MindmapColorKey,
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[]
): {
  before: WhiteboardNode[];
  after: WhiteboardNode[];
  beforeEdges: WhiteboardEdge[];
  afterEdges: WhiteboardEdge[];
} {
  const { nodeIds, edgeIds } = getMindmapSubtree(rootId, nodes, edges);
  const entry = MINDMAP_PALETTE[colorKey];
  const before: WhiteboardNode[] = [];
  const after: WhiteboardNode[] = [];
  const now = Date.now();
  for (const n of nodes) {
    if (!nodeIds.has(n.id) || n.locked) continue;
    before.push(n);
    after.push({ ...applyMindmapPaletteKey(n, colorKey), updatedAt: now });
  }
  const beforeEdges: WhiteboardEdge[] = [];
  const afterEdges: WhiteboardEdge[] = [];
  for (const e of edges) {
    if (!edgeIds.has(e.id) || e.locked) continue;
    beforeEdges.push(e);
    afterEdges.push({ ...e, strokeColor: entry.border, updatedAt: now });
  }
  return { before, after, beforeEdges, afterEdges };
}

/**
 * Sets `mindmapCollapsed` across all branch-parent nodes in the tree containing `nodeId`
 * (keeping the root itself expanded when collapsing so the main topics remain visible).
 */
export function setAllMindmapCollapsed(
  nodeId: string,
  collapsed: boolean,
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[]
): { before: WhiteboardNode[]; after: WhiteboardNode[] } {
  const rootId = findMindmapRoot(nodeId, nodes, edges);
  const { nodeIds } = getMindmapSubtree(rootId, nodes, edges);
  const { childrenByParent } = getCollapsedState(nodes, edges);
  const before: WhiteboardNode[] = [];
  const after: WhiteboardNode[] = [];
  const now = Date.now();

  for (const n of nodes) {
    if (!nodeIds.has(n.id) || n.locked) continue;
    const hasKids = (childrenByParent.get(n.id)?.length ?? 0) > 0;
    if (!hasKids) continue;
    const targetState = collapsed ? n.id !== rootId : false;
    if (Boolean(n.mindmapCollapsed) !== targetState) {
      before.push(n);
      after.push({ ...n, mindmapCollapsed: targetState, updatedAt: now });
    }
  }
  return { before, after };
}

/**
 * Reorders a Mind Map sibling branch up or down relative to its peers on the same side of their
 * shared parent, shifting each sibling's entire subtree cleanly by the swapped vertical delta.
 */
export function reorderMindmapSibling(
  nodeId: string,
  direction: "up" | "down",
  page: WhiteboardPage
): { before: WhiteboardNode[]; after: WhiteboardNode[] } {
  const incoming = page.edges.find((e) => e.target.nodeId === nodeId && e.source.nodeId);
  if (!incoming?.source.nodeId) return { before: [], after: [] };
  const parent = page.nodes.find((n) => n.id === incoming.source.nodeId);
  const target = page.nodes.find((n) => n.id === nodeId);
  if (!parent || !target) return { before: [], after: [] };

  const targetSide = inferBranchSide(parent, target, incoming);
  const siblings: WhiteboardNode[] = [];
  for (const e of page.edges) {
    if (e.source.nodeId !== parent.id || !e.target.nodeId) continue;
    const child = page.nodes.find((n) => n.id === e.target.nodeId);
    if (!child) continue;
    if (inferBranchSide(parent, child, e) === targetSide) siblings.push(child);
  }
  const isHorizontal = targetSide === "left" || targetSide === "right";
  siblings.sort((a, b) => (isHorizontal ? a.y - b.y : a.x - b.x));

  const idx = siblings.findIndex((s) => s.id === nodeId);
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return { before: [], after: [] };

  const a = siblings[idx];
  const b = siblings[swapIdx];
  const dxA = isHorizontal ? 0 : b.x - a.x;
  const dyA = isHorizontal ? b.y - a.y : 0;
  const dxB = -dxA;
  const dyB = -dyA;

  const subA = getMindmapSubtree(a.id, page.nodes, page.edges).nodeIds;
  const subB = getMindmapSubtree(b.id, page.nodes, page.edges).nodeIds;
  const before: WhiteboardNode[] = [];
  const after: WhiteboardNode[] = [];
  const now = Date.now();

  for (const n of page.nodes) {
    if (n.locked) continue;
    if (subA.has(n.id) && !subB.has(n.id)) {
      before.push(n);
      after.push({ ...n, x: Math.round(n.x + dxA), y: Math.round(n.y + dyA), updatedAt: now });
    } else if (subB.has(n.id) && !subA.has(n.id)) {
      before.push(n);
      after.push({ ...n, x: Math.round(n.x + dxB), y: Math.round(n.y + dyB), updatedAt: now });
    }
  }
  return { before, after };
}

/**
 * Inserts a new grouping parent topic between `node` and its existing parent (if any), shifting
 * `node`'s subtree slightly outward so the new parent fits cleanly without overlap.
 */
export function buildMindmapInsertedParent(
  node: WhiteboardNode,
  page: WhiteboardPage,
  newNodeId: string,
  newEdgeId: string
): {
  newParent: WhiteboardNode;
  newEdge: WhiteboardEdge;
  updatedIncomingEdge?: { before: WhiteboardEdge; after: WhiteboardEdge };
  shiftedNodes: { before: WhiteboardNode[]; after: WhiteboardNode[] };
} {
  const incoming = page.edges.find((e) => e.target.nodeId === node.id && e.source.nodeId);
  const oldParent = incoming?.source.nodeId ? page.nodes.find((n) => n.id === incoming.source.nodeId) : undefined;
  const side: CardinalSide = oldParent ? inferBranchSide(oldParent, node, incoming) : "right";

  let newParent = createDefaultWhiteboardNode(newNodeId, "mindmapTopic", 0, 0);
  newParent = {
    ...newParent,
    text: "Group topic",
    x: Math.round(node.x),
    y: Math.round(node.y),
  };
  if (node.mindmapColorKey) {
    newParent = applyMindmapPaletteKey(newParent, node.mindmapColorKey);
  }

  const shiftX = side === "right" ? newParent.width + BRANCH_GAP_X : side === "left" ? -(newParent.width + BRANCH_GAP_X) : 0;
  const shiftY = side === "bottom" ? newParent.height + BRANCH_GAP_Y : side === "top" ? -(newParent.height + BRANCH_GAP_Y) : 0;

  const { nodeIds } = getMindmapSubtree(node.id, page.nodes, page.edges);
  const before: WhiteboardNode[] = [];
  const after: WhiteboardNode[] = [];
  const now = Date.now();
  for (const n of page.nodes) {
    if (!nodeIds.has(n.id) || n.locked) continue;
    before.push(n);
    after.push({ ...n, x: Math.round(n.x + shiftX), y: Math.round(n.y + shiftY), updatedAt: now });
  }

  const newEdge: WhiteboardEdge = {
    ...createDefaultWhiteboardEdge(
      newEdgeId,
      { nodeId: newParent.id, anchor: side },
      { nodeId: node.id, anchor: oppositeSide(side) }
    ),
    routing: "curved",
    strokeColor: incoming?.strokeColor ?? "#2b7fff",
    strokeWidth: 2,
    strokeStyle: "dashed",
    startArrowType: "none",
    endArrowType: "none",
  };

  const updatedIncomingEdge = incoming
    ? {
        before: incoming,
        after: {
          ...incoming,
          target: { nodeId: newParent.id, anchor: oppositeSide(side) },
          updatedAt: now,
        },
      }
    : undefined;

  return {
    newParent,
    newEdge,
    updatedIncomingEdge,
    shiftedNodes: { before, after },
  };
}

/**
 * Exports the Mind Map tree rooted at `rootId` into clean, structured Markdown (Title + H2 main
 * branches + nested bullet subtopics + descriptions/checklists) ready for clipboard or Briefcast Docs.
 */
export function exportMindmapToOutlineMarkdown(
  nodeId: string,
  nodes: WhiteboardNode[],
  edges: WhiteboardEdge[]
): { title: string; markdown: string } {
  const rootId = findMindmapRoot(nodeId, nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = byId.get(rootId);
  if (!root) return { title: "Mind Map", markdown: "" };

  const { childrenByParent } = getCollapsedState(nodes, edges);
  const title = root.text.trim() || "Mind Map";
  const lines: string[] = [`# ${title}`, ""];
  if (root.mindmapDescription?.trim()) {
    lines.push(root.mindmapDescription.trim(), "");
  }

  const visited = new Set<string>([rootId]);
  const sortKids = (ids: string[]) =>
    ids
      .map((id) => byId.get(id))
      .filter((n): n is WhiteboardNode => !!n)
      .sort((a, b) => a.y - b.y || a.x - b.x);

  const renderBranch = (node: WhiteboardNode, depth: number) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const label = node.text.trim() || "Untitled topic";
    if (depth === 1) {
      lines.push(`## ${label}`);
      if (node.mindmapDescription?.trim()) {
        lines.push("", node.mindmapDescription.trim());
      }
      lines.push("");
    } else {
      const indent = "  ".repeat(Math.max(0, depth - 2));
      lines.push(`${indent}- **${label}**`);
      if (node.mindmapDescription?.trim()) {
        lines.push(`${indent}  ${node.mindmapDescription.trim()}`);
      }
    }
    if (node.mindmapItems && node.mindmapItems.length > 0) {
      const indent = depth === 1 ? "" : "  ".repeat(Math.max(0, depth - 1));
      for (const item of node.mindmapItems) {
        lines.push(`${indent}- [${item.checked ? "x" : " "}] ${item.text}`);
      }
    }
    const kids = sortKids(childrenByParent.get(node.id) ?? []);
    for (const kid of kids) {
      renderBranch(kid, depth + 1);
    }
    if (depth === 1) lines.push("");
  };

  for (const mainBranch of sortKids(childrenByParent.get(rootId) ?? [])) {
    renderBranch(mainBranch, 1);
  }

  return {
    title,
    markdown: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}
