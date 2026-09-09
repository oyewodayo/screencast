// components/whiteboard/WhiteboardCanvas.tsx
//
// The Whiteboard feature's interactive surface - an infinite pan/zoom canvas built from real DOM
// nodes (each shape is a positioned <div>) plus one SVG layer for connectors, rather than a single
// <canvas> buffer like BoardCanvas.tsx. That split is deliberate: connectors need to track live
// node positions and re-route as shapes move, and inline double-click-to-edit text needs a real
// contentEditable element - both fall out for free with DOM nodes, at the cost of writing our own
// pan/zoom transform instead of relying on canvas's built-in scale.
//
// Renders exactly one WhiteboardPage at a time (the caller's currently active one) - never the
// whole multi-page document, same "one page is one independent canvas" model useWhiteboardStore.ts
// and whiteboardHandlers.ts's page-scoped functions already follow.
//
// Coordinate spaces: "doc space" is this page's own infinite coordinate plane (what every
// WhiteboardNode/Edge's x/y/width/height is expressed in); "screen space" is CSS pixels within
// this component's container. `pan`+`zoom` (owned by WhiteboardEditor) map one to the other:
// screenX = docX * zoom + pan.x. Everything that needs to look a constant size on screen regardless
// of zoom (resize handles, connection dots, stroke widths of UI chrome) divides by `zoom` even
// though it's rendered inside the zoomed/panned group - same reasoning as BoardCanvas.tsx's own
// HANDLE_DRAW_RADIUS/zoom convention, just applied to DOM/CSS sizes instead of canvas-buffer ones.
//
// Every drag gesture (move/resize/connector create-or-reattach/marquee/freehand stroke) stages its
// result in local React state and only commits to the store (one editNode/batchEditNodes/addEdge/
// editEdge/addNode call) on pointer release - the same "stage locally, commit once" discipline
// BoardCanvas.tsx's own liveImages uses, so a whole gesture is exactly one undo step.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  createDefaultWhiteboardEdge,
  createDefaultWhiteboardNode,
  createFreehandWhiteboardNode,
  WhiteboardAnchorSide,
  WhiteboardEdge,
  WhiteboardEndpoint,
  WhiteboardNode,
  WhiteboardPage,
  WhiteboardShapeType,
} from "../../utils/whiteboardTypes";
import {
  BoundsBox,
  buildEdgePath,
  CYLINDER_CAP_RATIO,
  nodeCenter,
  resolveAnchorPoint,
  resolveEdgeEndpoints,
  shapeOutlineFor,
} from "../../handlers/whiteboardHandlers";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const GRID_SIZE = 24;
const HANDLE_SCREEN_SIZE = 9;
const CONNECTION_DOT_SCREEN_SIZE = 9;
const HIT_STROKE_SCREEN_WIDTH = 14;
// Minimum on-screen movement (CSS px, pre-zoom-correction) between two recorded freehand points -
// keeps a slow stroke from recording hundreds of near-duplicate points that would otherwise bloat
// the saved document for no visible smoothness gain.
const FREEHAND_MIN_POINT_DISTANCE = 3;

type ResizeCorner = "nw" | "ne" | "sw" | "se";
const RESIZE_CORNERS: ResizeCorner[] = ["nw", "ne", "sw", "se"];
const ANCHOR_SIDES: Exclude<WhiteboardAnchorSide, "auto">[] = ["top", "right", "bottom", "left"];
// Shapes with a meaningful "attach a connector here" edge - freehand ink and free-floating text
// have no such natural anchor, so they don't show connection dots or accept connector drops aimed
// at their body (a connector can still end at a free point over them, same as empty canvas).
const CONNECTABLE_SHAPES = new Set<WhiteboardShapeType>(["rectangle", "ellipse", "diamond", "triangle", "hexagon", "parallelogram", "cylinder"]);

type Interaction =
  | { mode: "move"; ids: string[]; startClientX: number; startClientY: number; startNodes: WhiteboardNode[] }
  | { mode: "resize"; id: string; corner: ResizeCorner; startClientX: number; startClientY: number; startNode: WhiteboardNode }
  | { mode: "marquee"; startDocX: number; startDocY: number }
  | { mode: "pan"; startClientX: number; startClientY: number; startPan: { x: number; y: number } }
  | { mode: "freehand"; points: { x: number; y: number }[]; lastClientX: number; lastClientY: number }
  | {
      mode: "connector";
      // null edgeId = creating a brand new edge; otherwise reattaching an existing one's endpoint.
      // The rest of that edge's fields (color/style/arrows) come from page.edges.find(edgeId) at
      // commit time, not from here - this only needs to know which end is moving and where the
      // OTHER (fixed) end currently resolves to.
      edgeId: string | null;
      end: "source" | "target";
      fixed: WhiteboardEndpoint;
    };

export interface WhiteboardCanvasHandle {
  zoomBy: (factor: number) => void;
  resetView: () => void;
  fitToContent: (bounds: BoundsBox) => void;
}

interface WhiteboardCanvasProps {
  page: WhiteboardPage;
  showGrid: boolean;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  pan: { x: number; y: number };
  onPanChange: (pan: { x: number; y: number }) => void;
  selectedNodeIds: Set<string>;
  selectedEdgeIds: Set<string>;
  onSelectionChange: (nodeIds: Set<string>, edgeIds: Set<string>) => void;
  onAddNode: (node: WhiteboardNode) => void;
  onEditNode: (before: WhiteboardNode, after: WhiteboardNode) => void;
  onBatchEditNodes: (before: WhiteboardNode[], after: WhiteboardNode[]) => void;
  onDeleteNode: (node: WhiteboardNode) => void;
  onAddEdge: (edge: WhiteboardEdge) => void;
  onEditEdge: (before: WhiteboardEdge, after: WhiteboardEdge) => void;
  onDeleteEdge: (edge: WhiteboardEdge) => void;
  // Which shape the toolbar's palette has armed, if any - the next plain click on empty canvas
  // drops a new node of this type there. Cleared (via onShapePlaced) immediately after, EXCEPT for
  // "freehand": the pen tool stays armed across strokes (see handlePointerUp's freehand branch) so
  // sketching several strokes in a row doesn't need re-clicking the tool each time.
  armedShapeType: WhiteboardShapeType | null;
  onShapePlaced: () => void;
  // The edge-drawing tool's own armed state, kept separate from armedShapeType so a shape and the
  // connector tool can never both be "in progress" at once - see WhiteboardEditor's toolbar.
  connectorArmed: boolean;
  onConnectorPlaced: () => void;
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

// SVG <marker> content doesn't reliably inherit the stroking path's color across the WebView2
// versions this app targets (that needs `fill="context-stroke"`, a newer addition some installs
// won't have yet) - so instead of one shared marker, one is defined per distinct edge stroke color
// actually in use and referenced by a color-keyed id. Cheap in practice: a whiteboard has a
// handful of edge colors at most, not one per edge.
function markerIdForColor(color: string): string {
  return `wb-arrow-${color.replace(/[^a-zA-Z0-9]/g, "")}`;
}

// Builds a smoothed SVG path through a freehand stroke's LOCAL points (already denormalized to the
// node's own 0..width/0..height box) - quadratic curves through consecutive midpoints, same
// technique as whiteboardHandlers.ts's freehandPath (Canvas2D version), just emitting a `d` string
// instead of ctx calls so the PNG export and the live DOM view render identically.
function smoothedPathD(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y} L ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    d += ` Q ${points[i].x} ${points[i].y} ${mid.x} ${mid.y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

const WhiteboardCanvas = forwardRef<WhiteboardCanvasHandle, WhiteboardCanvasProps>(({
  page,
  showGrid,
  zoom,
  onZoomChange,
  pan,
  onPanChange,
  selectedNodeIds,
  selectedEdgeIds,
  onSelectionChange,
  onAddNode,
  onEditNode,
  onBatchEditNodes,
  onDeleteNode,
  onAddEdge,
  onEditEdge,
  onDeleteEdge,
  armedShapeType,
  onShapePlaced,
  connectorArmed,
  onConnectorPlaced,
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [liveNodes, setLiveNodes] = useState<WhiteboardNode[] | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [connectorPreview, setConnectorPreview] = useState<{ from: { x: number; y: number; side: "top" | "right" | "bottom" | "left" | null }; to: { x: number; y: number; side: "top" | "right" | "bottom" | "left" | null } } | null>(null);
  const [freehandPreview, setFreehandPreview] = useState<{ x: number; y: number }[] | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [connectorHoverNodeId, setConnectorHoverNodeId] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  const nodes = liveNodes ?? page.nodes;
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const clientToDoc = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
    },
    [pan, zoom]
  );

  // ---- Space-bar temporary pan tool (same convention as Figma/draw.io) ------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !editingNodeId) setSpaceHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [editingNodeId]);

  // Changes zoom while keeping the document point currently under (clientX, clientY) fixed on
  // screen - the standard "zoom towards the cursor" feel. Also used (with the viewport's own
  // center as the anchor) by the imperative handle below, so toolbar zoom buttons and fit-to-
  // content get the exact same math as wheel-zoom.
  const zoomAtClientPoint = useCallback(
    (newZoom: number, clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        onZoomChange(newZoom);
        return;
      }
      const clamped = clampZoom(newZoom);
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const docX = (localX - pan.x) / zoom;
      const docY = (localY - pan.y) / zoom;
      onPanChange({ x: localX - docX * clamped, y: localY - docY * clamped });
      onZoomChange(clamped);
    },
    [zoom, pan, onZoomChange, onPanChange]
  );

  // ---- Wheel: plain scroll pans, ctrl/cmd+scroll (or pinch, which browsers report as ctrlKey
  // wheel events) zooms centered on the pointer ------------------------------------------------
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        zoomAtClientPoint(zoom * factor, e.clientX, e.clientY);
      } else {
        onPanChange({ x: pan.x - e.deltaX, y: pan.y - e.deltaY });
      }
    },
    [zoom, pan, zoomAtClientPoint, onPanChange]
  );

  useImperativeHandle(
    ref,
    () => ({
      zoomBy: (factor: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const cx = rect ? rect.left + rect.width / 2 : 0;
        const cy = rect ? rect.top + rect.height / 2 : 0;
        zoomAtClientPoint(zoom * factor, cx, cy);
      },
      resetView: () => {
        onZoomChange(1);
        onPanChange({ x: 0, y: 0 });
      },
      fitToContent: (bounds: BoundsBox) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
        const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
        const nextZoom = clampZoom(Math.min(rect.width / contentWidth, rect.height / contentHeight));
        onZoomChange(nextZoom);
        onPanChange({
          x: (rect.width - contentWidth * nextZoom) / 2 - bounds.minX * nextZoom,
          y: (rect.height - contentHeight * nextZoom) / 2 - bounds.minY * nextZoom,
        });
      },
    }),
    [zoom, zoomAtClientPoint, onZoomChange, onPanChange]
  );

  // ---- Delete / Escape -------------------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const isTyping = active instanceof HTMLElement && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (isTyping) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return;
        e.preventDefault();
        for (const id of selectedEdgeIds) {
          const edge = page.edges.find((ed) => ed.id === id);
          if (edge) onDeleteEdge(edge);
        }
        for (const id of selectedNodeIds) {
          const node = page.nodes.find((n) => n.id === id);
          if (node) onDeleteNode(node);
        }
        onSelectionChange(new Set(), new Set());
      } else if (e.key === "Escape") {
        interactionRef.current = null;
        setConnectorPreview(null);
        setMarqueeRect(null);
        setFreehandPreview(null);
        onSelectionChange(new Set(), new Set());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedNodeIds, selectedEdgeIds, page.nodes, page.edges, onDeleteEdge, onDeleteNode, onSelectionChange]);

  // ---- Node move / resize ----------------------------------------------------------------------
  const beginMoveNode = useCallback(
    (node: WhiteboardNode, e: React.PointerEvent, additive: boolean) => {
      e.stopPropagation();
      let nextSelected = selectedNodeIds;
      if (additive) {
        nextSelected = new Set(selectedNodeIds);
        if (nextSelected.has(node.id)) nextSelected.delete(node.id);
        else nextSelected.add(node.id);
      } else if (!selectedNodeIds.has(node.id)) {
        nextSelected = new Set([node.id]);
      }
      onSelectionChange(nextSelected, additive ? selectedEdgeIds : new Set());
      const ids = nextSelected.has(node.id) ? Array.from(nextSelected) : [node.id];
      interactionRef.current = {
        mode: "move",
        ids,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startNodes: page.nodes.filter((n) => ids.includes(n.id)),
      };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [selectedNodeIds, selectedEdgeIds, onSelectionChange, page.nodes]
  );

  const beginResizeNode = useCallback(
    (node: WhiteboardNode, corner: ResizeCorner, e: React.PointerEvent) => {
      e.stopPropagation();
      onSelectionChange(new Set([node.id]), new Set());
      interactionRef.current = { mode: "resize", id: node.id, corner, startClientX: e.clientX, startClientY: e.clientY, startNode: node };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [onSelectionChange]
  );

  // ---- Connector create / reattach ---------------------------------------------------------------
  const beginConnectorFromNode = useCallback(
    (node: WhiteboardNode, side: WhiteboardAnchorSide, e: React.PointerEvent) => {
      e.stopPropagation();
      interactionRef.current = { mode: "connector", edgeId: null, end: "target", fixed: { nodeId: node.id, anchor: side } };
      const doc0 = clientToDoc(e.clientX, e.clientY);
      setConnectorPreview({ from: resolveAnchorPoint(node, side, doc0), to: { x: doc0.x, y: doc0.y, side: null } });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [clientToDoc]
  );

  const beginConnectorReattach = useCallback(
    (edge: WhiteboardEdge, end: "source" | "target", e: React.PointerEvent) => {
      e.stopPropagation();
      onSelectionChange(new Set(), new Set([edge.id]));
      const fixed = end === "source" ? edge.target : edge.source;
      interactionRef.current = { mode: "connector", edgeId: edge.id, end, fixed };
      const doc0 = clientToDoc(e.clientX, e.clientY);
      const fixedPoint = fixed.nodeId ? nodeCenter(nodesById.get(fixed.nodeId)!) : { x: fixed.x ?? 0, y: fixed.y ?? 0 };
      const fixedResolved = fixed.nodeId ? resolveAnchorPoint(nodesById.get(fixed.nodeId)!, fixed.anchor ?? "auto", doc0) : { ...fixedPoint, side: null };
      setConnectorPreview(end === "source" ? { from: { x: doc0.x, y: doc0.y, side: null }, to: fixedResolved } : { from: fixedResolved, to: { x: doc0.x, y: doc0.y, side: null } });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [onSelectionChange, clientToDoc, nodesById]
  );

  // ---- Pointer move / up on the container --------------------------------------------------------
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) return;

      if (interaction.mode === "pan") {
        onPanChange({ x: interaction.startPan.x + (e.clientX - interaction.startClientX), y: interaction.startPan.y + (e.clientY - interaction.startClientY) });
        return;
      }

      if (interaction.mode === "move") {
        const dx = (e.clientX - interaction.startClientX) / zoom;
        const dy = (e.clientY - interaction.startClientY) / zoom;
        const movedById = new Map(interaction.startNodes.map((n) => [n.id, { ...n, x: n.x + dx, y: n.y + dy }]));
        setLiveNodes(page.nodes.map((n) => movedById.get(n.id) ?? n));
        return;
      }

      if (interaction.mode === "resize") {
        const dx = (e.clientX - interaction.startClientX) / zoom;
        const dy = (e.clientY - interaction.startClientY) / zoom;
        const start = interaction.startNode;
        let { x, y, width, height } = start;
        if (interaction.corner.includes("w")) {
          width = Math.max(20, start.width - dx);
          x = start.x + (start.width - width);
        } else {
          width = Math.max(20, start.width + dx);
        }
        if (interaction.corner.includes("n")) {
          height = Math.max(20, start.height - dy);
          y = start.y + (start.height - height);
        } else {
          height = Math.max(20, start.height + dy);
        }
        const resized: WhiteboardNode = { ...start, x, y, width, height };
        setLiveNodes(page.nodes.map((n) => (n.id === start.id ? resized : n)));
        return;
      }

      if (interaction.mode === "marquee") {
        const cur = clientToDoc(e.clientX, e.clientY);
        setMarqueeRect({
          x: Math.min(interaction.startDocX, cur.x),
          y: Math.min(interaction.startDocY, cur.y),
          width: Math.abs(cur.x - interaction.startDocX),
          height: Math.abs(cur.y - interaction.startDocY),
        });
        return;
      }

      if (interaction.mode === "freehand") {
        // Throttle by on-screen distance (not doc distance, which would record fewer points at
        // low zoom and more at high zoom for the same physical mouse movement) - see this file's
        // FREEHAND_MIN_POINT_DISTANCE doc comment.
        const dx = e.clientX - interaction.lastClientX;
        const dy = e.clientY - interaction.lastClientY;
        if (Math.hypot(dx, dy) < FREEHAND_MIN_POINT_DISTANCE) return;
        const point = clientToDoc(e.clientX, e.clientY);
        interaction.points.push(point);
        interaction.lastClientX = e.clientX;
        interaction.lastClientY = e.clientY;
        setFreehandPreview([...interaction.points]);
        return;
      }

      if (interaction.mode === "connector") {
        const cur = clientToDoc(e.clientX, e.clientY);
        // Snap the dragged endpoint to whichever node the pointer is currently over (excluding the
        // fixed endpoint's own node, so a self-loop back onto the same shape isn't offered).
        const target = nodes.find(
          (n) => n.id !== interaction.fixed.nodeId && CONNECTABLE_SHAPES.has(n.shapeType) && cur.x >= n.x && cur.x <= n.x + n.width && cur.y >= n.y && cur.y <= n.y + n.height
        );
        setConnectorHoverNodeId(target?.id ?? null);
        const fixedPoint = interaction.fixed.nodeId ? nodeCenter(nodesById.get(interaction.fixed.nodeId)!) : { x: interaction.fixed.x ?? 0, y: interaction.fixed.y ?? 0 };
        const draggedResolved = target ? resolveAnchorPoint(target, "auto", fixedPoint) : { x: cur.x, y: cur.y, side: null };
        const fixedResolved = interaction.fixed.nodeId
          ? resolveAnchorPoint(nodesById.get(interaction.fixed.nodeId)!, interaction.fixed.anchor ?? "auto", draggedResolved)
          : { ...fixedPoint, side: null };
        setConnectorPreview(interaction.end === "target" ? { from: fixedResolved, to: draggedResolved } : { from: draggedResolved, to: fixedResolved });
      }
    },
    [zoom, page.nodes, clientToDoc, nodes, nodesById, onPanChange]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const interaction = interactionRef.current;
      interactionRef.current = null;
      if (!interaction) return;

      if (interaction.mode === "move" && liveNodes) {
        const idSet = new Set(interaction.ids);
        const after = liveNodes.filter((n) => idSet.has(n.id));
        if (after.length === 1) onEditNode(interaction.startNodes[0], after[0]);
        else onBatchEditNodes(interaction.startNodes, after);
        setLiveNodes(null);
      } else if (interaction.mode === "resize" && liveNodes) {
        const after = liveNodes.find((n) => n.id === interaction.id);
        if (after) onEditNode(interaction.startNode, after);
        setLiveNodes(null);
      } else if (interaction.mode === "marquee") {
        if (marqueeRect && (marqueeRect.width > 2 || marqueeRect.height > 2)) {
          const enclosed = page.nodes.filter(
            (n) =>
              n.x < marqueeRect.x + marqueeRect.width &&
              n.x + n.width > marqueeRect.x &&
              n.y < marqueeRect.y + marqueeRect.height &&
              n.y + n.height > marqueeRect.y
          );
          onSelectionChange(new Set(enclosed.map((n) => n.id)), new Set());
        } else {
          onSelectionChange(new Set(), new Set());
        }
        setMarqueeRect(null);
      } else if (interaction.mode === "freehand") {
        const finalPoint = clientToDoc(e.clientX, e.clientY);
        const points = [...interaction.points, finalPoint];
        setFreehandPreview(null);
        // A tap with (almost) no movement isn't a meaningful stroke - drop it rather than saving a
        // near-invisible dot, same "don't save a no-op gesture" spirit as marquee's width>2 check.
        if (points.length >= 2) {
          const node = createFreehandWhiteboardNode(crypto.randomUUID(), points);
          onAddNode(node);
          onSelectionChange(new Set([node.id]), new Set());
        }
        // Deliberately does NOT call onShapePlaced() - the pen tool stays armed across strokes
        // (see this file's own top comment and armedShapeType's doc comment on the props) so
        // sketching several strokes in a row doesn't need re-arming the tool each time.
      } else if (interaction.mode === "connector") {
        const cur = clientToDoc(e.clientX, e.clientY);
        const droppedOnNode = nodes.find(
          (n) => n.id !== interaction.fixed.nodeId && CONNECTABLE_SHAPES.has(n.shapeType) && cur.x >= n.x && cur.x <= n.x + n.width && cur.y >= n.y && cur.y <= n.y + n.height
        );
        const draggedEndpoint: WhiteboardEndpoint = droppedOnNode ? { nodeId: droppedOnNode.id, anchor: "auto" } : { x: cur.x, y: cur.y };

        if (interaction.edgeId === null) {
          // Only create a real connection if it actually landed on a node - dropping a brand new
          // connector into empty space is treated as "changed my mind", not a floating arrow, since
          // there was never a deliberate "draw a free-floating arrow" tool click to justify one.
          if (droppedOnNode) {
            const edge = createDefaultWhiteboardEdge(crypto.randomUUID(), interaction.fixed, draggedEndpoint);
            onAddEdge(edge);
            onSelectionChange(new Set(), new Set([edge.id]));
          }
        } else {
          const existing = page.edges.find((ed) => ed.id === interaction.edgeId);
          if (existing) {
            const after: WhiteboardEdge = interaction.end === "target" ? { ...existing, target: draggedEndpoint } : { ...existing, source: draggedEndpoint };
            onEditEdge(existing, after);
          }
        }
        setConnectorPreview(null);
        setConnectorHoverNodeId(null);
        if (connectorArmed) onConnectorPlaced();
      }
    },
    [liveNodes, marqueeRect, page.nodes, page.edges, onEditNode, onBatchEditNodes, onSelectionChange, clientToDoc, nodes, onAddNode, onAddEdge, onEditEdge, connectorArmed, onConnectorPlaced]
  );

  // ---- Background click: place armed shape, start a freehand stroke, start marquee, or pan --------
  const handleContainerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 1 || spaceHeld || (e.button === 0 && e.altKey)) {
        interactionRef.current = { mode: "pan", startClientX: e.clientX, startClientY: e.clientY, startPan: pan };
        return;
      }
      if (e.button !== 0) return;
      if (editingNodeId) setEditingNodeId(null);

      if (armedShapeType === "freehand") {
        const point = clientToDoc(e.clientX, e.clientY);
        interactionRef.current = { mode: "freehand", points: [point], lastClientX: e.clientX, lastClientY: e.clientY };
        setFreehandPreview([point]);
        (e.target as Element).setPointerCapture?.(e.pointerId);
        return;
      }

      if (armedShapeType) {
        const point = clientToDoc(e.clientX, e.clientY);
        const node = createDefaultWhiteboardNode(crypto.randomUUID(), armedShapeType, point.x, point.y);
        onAddNode(node);
        onSelectionChange(new Set([node.id]), new Set());
        onShapePlaced();
        if (armedShapeType === "text") setEditingNodeId(node.id);
        return;
      }

      const point = clientToDoc(e.clientX, e.clientY);
      interactionRef.current = { mode: "marquee", startDocX: point.x, startDocY: point.y };
      setMarqueeRect({ x: point.x, y: point.y, width: 0, height: 0 });
    },
    [spaceHeld, pan, editingNodeId, armedShapeType, clientToDoc, onAddNode, onSelectionChange, onShapePlaced]
  );

  // ---- Text editing ------------------------------------------------------------------------------
  const commitTextEdit = useCallback(
    (node: WhiteboardNode, text: string) => {
      const trimmed = text;
      if (trimmed !== node.text) onEditNode(node, { ...node, text: trimmed });
      setEditingNodeId(null);
    },
    [onEditNode]
  );

  useEffect(() => {
    if (!editingNodeId) return;
    // Deferred one frame: entering edit mode straight from the text tool (armedShapeType ===
    // "text") lands in the SAME commit as WhiteboardStylePanel mounting its own fresh DOM (it was
    // rendering nothing before this node existed to select) - focusing synchronously here can lose
    // a race with the browser's own post-commit focus handling for that newly-mounted subtree.
    // Double-click-to-edit on an already-selected node never hits this (the style panel is already
    // mounted), which is why only the create-and-immediately-type path needs the extra frame.
    const raf = requestAnimationFrame(() => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    return () => cancelAnimationFrame(raf);
  }, [editingNodeId]);

  const markerColors = useMemo(() => {
    const colors = new Set<string>(["#2563eb"]); // connector-preview color, always needed
    for (const edge of page.edges) if (edge.startArrow || edge.endArrow) colors.add(edge.strokeColor);
    return Array.from(colors);
  }, [page.edges]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden select-none"
      style={{
        backgroundColor: "var(--wb-bg, #f7f7f8)",
        backgroundImage: showGrid ? "radial-gradient(circle, rgba(120,120,130,0.35) 1px, transparent 1px)" : undefined,
        backgroundSize: showGrid ? `${GRID_SIZE * zoom}px ${GRID_SIZE * zoom}px` : undefined,
        backgroundPosition: showGrid ? `${pan.x}px ${pan.y}px` : undefined,
        cursor: spaceHeld ? "grab" : armedShapeType === "freehand" ? "crosshair" : "default",
      }}
      onWheel={handleWheel}
      onPointerDown={handleContainerPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div className="absolute top-0 left-0 w-0 h-0" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}>
        {/* Edges layer - one SVG so paths can overlap nodes correctly (drawn before nodes = behind
            them, matching draw.io's own connector-under-shape stacking). overflow visible since
            the svg itself has no intrinsic size; each path uses absolute doc-space coordinates. */}
        <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }} width={1} height={1}>
          <defs>
            {markerColors.map((color) => (
              <marker key={color} id={markerIdForColor(color)} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0,0 L8,4 L0,8 Z" fill={color} />
              </marker>
            ))}
          </defs>
          {page.edges.map((edge) => {
            const { source, target } = resolveEdgeEndpoints(edge, nodesById);
            const d = buildEdgePath(source, target, edge.routing);
            const selected = selectedEdgeIds.has(edge.id);
            return (
              <g key={edge.id}>
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={HIT_STROKE_SCREEN_WIDTH / zoom}
                  style={{ pointerEvents: "stroke", cursor: "pointer" }}
                  onPointerDown={(e) => {
                    // Same "let an armed tool's click through to the container" reasoning as the
                    // node div's own onPointerDown guard above - an edge's fat invisible hit-stroke
                    // is an easy, easy-to-hit-by-accident target for a click that was meant to
                    // place a new shape/text/stroke on top of it.
                    if (armedShapeType) return;
                    e.stopPropagation();
                    onSelectionChange(new Set(), new Set([edge.id]));
                  }}
                />
                {selected && <path d={d} fill="none" stroke="#2563eb" strokeWidth={(edge.strokeWidth + 5) / zoom} strokeLinecap="round" opacity={0.35} />}
                <path
                  d={d}
                  fill="none"
                  stroke={edge.strokeColor}
                  strokeWidth={edge.strokeWidth / zoom}
                  strokeDasharray={edge.strokeStyle === "dashed" ? `${8 / zoom},${6 / zoom}` : undefined}
                  markerEnd={edge.endArrow ? `url(#${markerIdForColor(edge.strokeColor)})` : undefined}
                  markerStart={edge.startArrow ? `url(#${markerIdForColor(edge.strokeColor)})` : undefined}
                  style={{ pointerEvents: "none" }}
                />
                {edge.label && (
                  <text x={(source.x + target.x) / 2} y={(source.y + target.y) / 2} fontSize={13 / zoom} fill="#374151" textAnchor="middle" style={{ pointerEvents: "none", paintOrder: "stroke" }} stroke="#f7f7f8" strokeWidth={3 / zoom}>
                    {edge.label}
                  </text>
                )}
                {selected && (
                  <>
                    <circle cx={source.x} cy={source.y} r={6 / zoom} fill="#ffffff" stroke="#2563eb" strokeWidth={2 / zoom} style={{ pointerEvents: "auto", cursor: "grab" }} onPointerDown={(e) => beginConnectorReattach(edge, "source", e)} />
                    <circle cx={target.x} cy={target.y} r={6 / zoom} fill="#ffffff" stroke="#2563eb" strokeWidth={2 / zoom} style={{ pointerEvents: "auto", cursor: "grab" }} onPointerDown={(e) => beginConnectorReattach(edge, "target", e)} />
                  </>
                )}
              </g>
            );
          })}
          {connectorPreview && (
            <path d={buildEdgePath(connectorPreview.from, connectorPreview.to, "orthogonal")} fill="none" stroke="#2563eb" strokeWidth={2 / zoom} strokeDasharray={`${6 / zoom},${4 / zoom}`} markerEnd={`url(#${markerIdForColor("#2563eb")})`} />
          )}
          {freehandPreview && freehandPreview.length > 1 && (
            <path d={smoothedPathD(freehandPreview)} fill="none" stroke="#111111" strokeWidth={2.5 / zoom} strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>

        {/* Nodes layer */}
        {nodes.map((node) => {
          const selected = selectedNodeIds.has(node.id);
          const isHovered = hoveredNodeId === node.id;
          const isConnectorTarget = connectorHoverNodeId === node.id;
          const isEditing = editingNodeId === node.id;
          const isConnectable = CONNECTABLE_SHAPES.has(node.shapeType);
          const showConnectionDots = isConnectable && (isHovered || selected || connectorArmed);
          const outline = shapeOutlineFor(node.shapeType, node.width, node.height);
          return (
            <div
              key={node.id}
              className="absolute"
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
              onPointerEnter={() => setHoveredNodeId(node.id)}
              onPointerLeave={() => setHoveredNodeId((prev) => (prev === node.id ? null : prev))}
              onPointerDown={(e) => {
                if (connectorArmed && isConnectable) {
                  beginConnectorFromNode(node, "auto", e);
                  return;
                }
                // A tool being armed (shape/text/freehand) means the next click anywhere should
                // place a new item there, even if it happens to land on top of an existing one -
                // returning without stopPropagation lets the event bubble up to the container's
                // handleContainerPointerDown, which owns that placement logic. Without this guard,
                // beginMoveNode's own stopPropagation would swallow the click first and move THIS
                // node instead, silently breaking every tool for any target that overlaps existing
                // content (easy to hit in practice: fit-to-content's own pan/zoom can put an
                // existing shape right under a click meant for empty canvas).
                if (armedShapeType) return;
                beginMoveNode(node, e, e.shiftKey);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (node.shapeType !== "freehand") setEditingNodeId(node.id);
              }}
            >
              {node.shapeType === "freehand" ? (
                <svg width="100%" height="100%" viewBox={`0 0 ${node.width} ${node.height}`} preserveAspectRatio="none" style={{ overflow: "visible" }}>
                  <path
                    d={smoothedPathD((node.points ?? []).map((p) => ({ x: p.x * node.width, y: p.y * node.height })))}
                    fill="none"
                    stroke={node.strokeColor}
                    strokeWidth={node.strokeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              ) : node.shapeType === "ellipse" ? (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    backgroundColor: node.fillColor ?? "transparent",
                    border: node.strokeWidth > 0 ? `${node.strokeWidth}px solid ${node.strokeColor}` : undefined,
                    borderRadius: "50%",
                    boxSizing: "border-box",
                  }}
                />
              ) : node.shapeType === "rectangle" ? (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    backgroundColor: node.fillColor ?? "transparent",
                    border: node.strokeWidth > 0 ? `${node.strokeWidth}px solid ${node.strokeColor}` : undefined,
                    borderRadius: node.cornerRadius ?? 0,
                    boxSizing: "border-box",
                  }}
                />
              ) : node.shapeType === "text" ? (
                isHovered || selected ? <div style={{ position: "absolute", inset: 0, border: "1px dashed #9ca3af" }} /> : null
              ) : outline.kind === "cylinder" ? (
                <svg width="100%" height="100%" viewBox={`0 0 ${node.width} ${node.height}`} preserveAspectRatio="none" style={{ overflow: "visible" }}>
                  <path
                    d={`M0,${node.height * CYLINDER_CAP_RATIO} L0,${node.height * (1 - CYLINDER_CAP_RATIO)} A${node.width / 2},${node.height * CYLINDER_CAP_RATIO} 0 0,0 ${node.width},${node.height * (1 - CYLINDER_CAP_RATIO)} L${node.width},${node.height * CYLINDER_CAP_RATIO} Z`}
                    fill={node.fillColor ?? "none"}
                    stroke={node.strokeColor}
                    strokeWidth={node.strokeWidth}
                  />
                  <ellipse
                    cx={node.width / 2}
                    cy={node.height * CYLINDER_CAP_RATIO}
                    rx={node.width / 2}
                    ry={node.height * CYLINDER_CAP_RATIO}
                    fill={node.fillColor ?? "none"}
                    stroke={node.strokeColor}
                    strokeWidth={node.strokeWidth}
                  />
                </svg>
              ) : outline.kind === "polygon" ? (
                <svg width="100%" height="100%" viewBox={`0 0 ${node.width} ${node.height}`} preserveAspectRatio="none" style={{ overflow: "visible" }}>
                  <polygon points={outline.points.map(([px, py]) => `${px},${py}`).join(" ")} fill={node.fillColor ?? "none"} stroke={node.strokeColor} strokeWidth={node.strokeWidth} strokeLinejoin="round" />
                </svg>
              ) : null}

              {!isEditing && node.text && (
                <div
                  className="absolute inset-0 flex px-2 overflow-hidden whitespace-pre-wrap break-words"
                  style={{
                    alignItems: node.verticalAlign === "top" ? "flex-start" : node.verticalAlign === "bottom" ? "flex-end" : "center",
                    justifyContent: node.textAlign === "left" ? "flex-start" : node.textAlign === "right" ? "flex-end" : "center",
                    textAlign: node.textAlign,
                    color: node.fontColor,
                    fontFamily: node.fontFamily,
                    fontSize: node.fontSize,
                    fontWeight: node.fontWeight,
                    fontStyle: node.fontStyle,
                    textDecoration: node.textDecoration,
                    pointerEvents: "none",
                  }}
                >
                  <span>{node.text}</span>
                </div>
              )}
              {!isEditing && !node.text && node.shapeType === "text" && (isHovered || selected) && (
                <div className="absolute inset-0 flex items-center justify-center text-neutral-400 text-xs pointer-events-none">Double-click to type</div>
              )}

              {isEditing && (
                <div
                  ref={editorRef}
                  contentEditable
                  suppressContentEditableWarning
                  className="absolute inset-0 px-2 outline-none whitespace-pre-wrap break-words overflow-hidden flex"
                  style={{
                    alignItems: node.verticalAlign === "top" ? "flex-start" : node.verticalAlign === "bottom" ? "flex-end" : "center",
                    justifyContent: node.textAlign === "left" ? "flex-start" : node.textAlign === "right" ? "flex-end" : "center",
                    textAlign: node.textAlign,
                    color: node.fontColor,
                    fontFamily: node.fontFamily,
                    fontSize: node.fontSize,
                    fontWeight: node.fontWeight,
                    fontStyle: node.fontStyle,
                    textDecoration: node.textDecoration,
                    cursor: "text",
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onBlur={(e) => commitTextEdit(node, e.currentTarget.innerText)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      (e.currentTarget as HTMLDivElement).blur();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      (e.currentTarget as HTMLDivElement).blur();
                    }
                  }}
                >
                  {node.text}
                </div>
              )}

              {isConnectorTarget && <div className="absolute inset-0 rounded-md ring-2 ring-blue-400 ring-offset-1 pointer-events-none" />}

              {selected && !connectorArmed && (
                <div className="absolute pointer-events-none" style={{ inset: -3 / zoom, border: `${1.5 / zoom}px dashed #2563eb` }} />
              )}

              {selected && selectedNodeIds.size === 1 && !connectorArmed &&
                RESIZE_CORNERS.map((corner) => {
                  const size = HANDLE_SCREEN_SIZE / zoom;
                  const left = corner.includes("w") ? -size / 2 : node.width - size / 2;
                  const top = corner.includes("n") ? -size / 2 : node.height - size / 2;
                  return (
                    <div
                      key={corner}
                      onPointerDown={(e) => beginResizeNode(node, corner, e)}
                      className="absolute bg-white border border-blue-600"
                      style={{ left, top, width: size, height: size, cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize" }}
                    />
                  );
                })}

              {showConnectionDots &&
                !connectorArmed &&
                ANCHOR_SIDES.map((side) => {
                  const p = resolveAnchorPoint(node, side, nodeCenter(node));
                  const size = CONNECTION_DOT_SCREEN_SIZE / zoom;
                  return (
                    <div
                      key={side}
                      onPointerDown={(e) => beginConnectorFromNode(node, side, e)}
                      className="absolute rounded-full bg-white border-2 border-blue-500 hover:bg-blue-500"
                      style={{ left: p.x - node.x - size / 2, top: p.y - node.y - size / 2, width: size, height: size, cursor: "crosshair" }}
                      title="Drag to connect"
                    />
                  );
                })}
            </div>
          );
        })}

        {marqueeRect && (
          <div
            className="absolute border border-blue-500 bg-blue-500/10 pointer-events-none"
            style={{ left: marqueeRect.x, top: marqueeRect.y, width: marqueeRect.width, height: marqueeRect.height }}
          />
        )}
      </div>
    </div>
  );
});

WhiteboardCanvas.displayName = "WhiteboardCanvas";

export default WhiteboardCanvas;
