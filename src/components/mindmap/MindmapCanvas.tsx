// components/mindmap/MindmapCanvas.tsx
//
// The Mindmap feature's canvas: pan/zoom, selection, drag, resize, inline label editing, and the
// hover "add a connected topic in this direction" arrows that are the point of the whole tool.
//
// Nodes are DOM elements rather than a single <canvas>, same reasoning WhiteboardCanvas.tsx gives:
// connectors have to track live node positions, and inline text editing on a canvas would mean
// rebuilding a text editor. Connectors are one SVG layer beneath the nodes.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IoTrashOutline } from "react-icons/io5";
import { TbGripVertical } from "react-icons/tb";
import {
  MINDMAP_CHECK_GLYPH,
  MINDMAP_FONT_PX,
  MINDMAP_PALETTE,
  MindmapDocument,
  MindmapEdge,
  MindmapNode,
  MindmapSide,
  TOPIC_NODE_TYPES,
  nodeItems,
  resolveCheckColor,
  resolveCheckStyle,
  resolveProgress,
} from "../../utils/mindmapTypes";
import { edgePath, nodeCenter } from "../../handlers/mindmapHandlers";

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const GRID_SIZE = 20;
// On-screen size (CSS px, pre-zoom) of a resize handle and of the directional add-topic arrows.
const HANDLE_SCREEN_SIZE = 8;
const ADD_ARROW_SCREEN_SIZE = 22;
// Below this drag distance a pointer-down is treated as a click, not a move - keeps a plain
// selection click from committing a one-pixel position change as an undo step.
const DRAG_DEAD_ZONE = 3;
// Height of the selected-node chrome (delete + drag grip), in screen px.
const CHROME_SCREEN_HEIGHT = 20;
// Extra grab band around a divider line, in screen px per side - a 2px line is otherwise almost
// impossible to hit.
const LINE_HIT_PADDING = 7;
// The app's fixed bottom docker overlays the canvas rather than taking layout space, so the
// container's own height counts pixels the user can't actually see into. Fit-to-content subtracts
// this or the bottom of the diagram lands underneath the docker every time.
const DOCKER_OVERLAY_HEIGHT = 72;

type Interaction =
  | { mode: "pan"; startClientX: number; startClientY: number; startPan: { x: number; y: number } }
  | { mode: "marquee"; startDoc: { x: number; y: number } }
  | { mode: "move"; startClientX: number; startClientY: number; startNodes: MindmapNode[]; moved: boolean }
  | { mode: "resize"; startClientX: number; startClientY: number; startNode: MindmapNode; corner: "nw" | "ne" | "sw" | "se" }
  // Dragging from one node's side dot to another node, drawing a connector by hand (the
  // roadmap.sh "hover a node, drag one of the dots" gesture).
  | { mode: "connect"; sourceId: string; sourceSide: MindmapSide; pointer: { x: number; y: number } };

export interface MindmapCanvasHandle {
  zoomBy: (factor: number) => void;
  resetView: () => void;
  fitToContent: () => void;
}

interface MindmapCanvasProps {
  doc: MindmapDocument;
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onEditNodes: (before: MindmapNode[], after: MindmapNode[]) => void;
  onAddEdge: (edge: MindmapEdge) => void;
  onDeleteSelection: () => void;
  // Fired by the directional arrows on a hovered/selected node - the editor owns id generation and
  // the actual add (it has the store), this just reports which node and which way.
  onAddTopic: (parent: MindmapNode, side: MindmapSide) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  pan: { x: number; y: number };
  onPanChange: (pan: { x: number; y: number }) => void;
}

const MindmapCanvas = React.forwardRef<MindmapCanvasHandle, MindmapCanvasProps>(function MindmapCanvas(
  { doc, selectedIds, onSelectionChange, onEditNodes, onAddEdge, onDeleteSelection, onAddTopic, zoom, onZoomChange, pan, onPanChange },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  // Nodes staged mid-drag: rendered instead of the document's own, never committed until pointer-up,
  // so a whole drag is one undo step. Same display-only channel WhiteboardCanvas.tsx uses.
  const [liveNodes, setLiveNodes] = useState<MindmapNode[] | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [connectPreview, setConnectPreview] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const nodes = liveNodes ?? doc.nodes;
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const clientToDoc = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
    },
    [pan, zoom]
  );

  const snap = useCallback((v: number) => (doc.snapToGrid ? Math.round(v / GRID_SIZE) * GRID_SIZE : Math.round(v)), [doc.snapToGrid]);

  React.useImperativeHandle(
    ref,
    () => ({
      zoomBy: (factor) => onZoomChange(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor))),
      resetView: () => {
        onZoomChange(1);
        onPanChange({ x: 0, y: 0 });
      },
      fitToContent: () => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect || doc.nodes.length === 0) return;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const n of doc.nodes) {
          minX = Math.min(minX, n.x);
          minY = Math.min(minY, n.y);
          maxX = Math.max(maxX, n.x + n.width);
          maxY = Math.max(maxY, n.y + n.height);
        }
        const pad = 60;
        const usableHeight = Math.max(80, rect.height - DOCKER_OVERLAY_HEIGHT);
        const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(rect.width / (maxX - minX + pad * 2), usableHeight / (maxY - minY + pad * 2))));
        onZoomChange(nextZoom);
        // Centred on the USABLE area, not the full container, so the diagram sits above the docker
        // rather than straddling it.
        onPanChange({ x: rect.width / 2 - ((minX + maxX) / 2) * nextZoom, y: usableHeight / 2 - ((minY + maxY) / 2) * nextZoom });
      },
    }),
    [zoom, doc.nodes, onZoomChange, onPanChange]
  );

  // Space-to-pan, and Delete to remove the selection - both suppressed while a text field or the
  // inline label editor has focus, or typing a space would pan the canvas mid-word.
  useEffect(() => {
    const isTyping = () => {
      const a = document.activeElement;
      return a instanceof HTMLElement && (a.isContentEditable || a.tagName === "INPUT" || a.tagName === "TEXTAREA");
    };
    const down = (e: KeyboardEvent) => {
      if (isTyping()) return;
      if (e.code === "Space") {
        e.preventDefault();
        setSpaceHeld(true);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIds.size > 0) {
          e.preventDefault();
          onDeleteSelection();
        }
      } else if (e.key === "Escape") {
        onSelectionChange(new Set());
        setEditingId(null);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [selectedIds, onDeleteSelection, onSelectionChange]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      // Ctrl/Cmd+wheel zooms about the pointer; plain wheel pans, matching every other canvas in
      // this app and the platform convention for a document surface.
      if (e.ctrlKey || e.metaKey) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
        // Keep whatever is under the cursor pinned there as the scale changes.
        onPanChange({ x: px - ((px - pan.x) / zoom) * next, y: py - ((py - pan.y) / zoom) * next });
        onZoomChange(next);
      } else {
        onPanChange({ x: pan.x - e.deltaX, y: pan.y - e.deltaY });
      }
    },
    [zoom, pan, onZoomChange, onPanChange]
  );

  const beginMove = useCallback(
    (node: MindmapNode, e: React.PointerEvent) => {
      if (node.locked) return;
      e.stopPropagation();
      const additive = e.shiftKey;
      let nextSelection = selectedIds;
      if (!selectedIds.has(node.id)) {
        nextSelection = additive ? new Set([...selectedIds, node.id]) : new Set([node.id]);
        onSelectionChange(nextSelection);
      } else if (additive) {
        nextSelection = new Set([...selectedIds]);
        nextSelection.delete(node.id);
        onSelectionChange(nextSelection);
        return;
      }
      const moving = doc.nodes.filter((n) => nextSelection.has(n.id) && !n.locked);
      interactionRef.current = { mode: "move", startClientX: e.clientX, startClientY: e.clientY, startNodes: moving, moved: false };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [selectedIds, onSelectionChange, doc.nodes]
  );

  const beginResize = useCallback(
    (node: MindmapNode, corner: "nw" | "ne" | "sw" | "se", e: React.PointerEvent) => {
      if (node.locked) return;
      e.stopPropagation();
      interactionRef.current = { mode: "resize", startClientX: e.clientX, startClientY: e.clientY, startNode: node, corner };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    []
  );

  const beginConnect = useCallback(
    (node: MindmapNode, side: MindmapSide, e: React.PointerEvent) => {
      e.stopPropagation();
      const point = clientToDoc(e.clientX, e.clientY);
      interactionRef.current = { mode: "connect", sourceId: node.id, sourceSide: side, pointer: point };
      setConnectPreview({ from: point, to: point });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [clientToDoc]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 1 || spaceHeld) {
        interactionRef.current = { mode: "pan", startClientX: e.clientX, startClientY: e.clientY, startPan: pan };
        return;
      }
      if (e.button !== 0) return;
      // Empty canvas: start a marquee and clear the selection unless extending it.
      if (!e.shiftKey) onSelectionChange(new Set());
      setEditingId(null);
      interactionRef.current = { mode: "marquee", startDoc: clientToDoc(e.clientX, e.clientY) };
    },
    [spaceHeld, pan, clientToDoc, onSelectionChange]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) return;

      if (interaction.mode === "pan") {
        onPanChange({ x: interaction.startPan.x + (e.clientX - interaction.startClientX), y: interaction.startPan.y + (e.clientY - interaction.startClientY) });
        return;
      }
      if (interaction.mode === "marquee") {
        const cur = clientToDoc(e.clientX, e.clientY);
        const start = interaction.startDoc;
        setMarquee({ x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) });
        return;
      }
      if (interaction.mode === "move") {
        const dx = (e.clientX - interaction.startClientX) / zoom;
        const dy = (e.clientY - interaction.startClientY) / zoom;
        if (!interaction.moved && Math.hypot(e.clientX - interaction.startClientX, e.clientY - interaction.startClientY) < DRAG_DEAD_ZONE) return;
        interaction.moved = true;
        const movedById = new Map(interaction.startNodes.map((n) => [n.id, { ...n, x: snap(n.x + dx), y: snap(n.y + dy) }]));
        setLiveNodes(doc.nodes.map((n) => movedById.get(n.id) ?? n));
        return;
      }
      if (interaction.mode === "resize") {
        const dx = (e.clientX - interaction.startClientX) / zoom;
        const dy = (e.clientY - interaction.startClientY) / zoom;
        const s = interaction.startNode;
        // The dragged corner moves; the opposite corner stays pinned - so a resize never also
        // translates the node, which is what makes it feel like resizing rather than a shove.
        let { x, y, width, height } = s;
        const MIN = 40;
        if (interaction.corner === "se") {
          width = Math.max(MIN, s.width + dx);
          height = Math.max(MIN, s.height + dy);
        } else if (interaction.corner === "sw") {
          width = Math.max(MIN, s.width - dx);
          height = Math.max(MIN, s.height + dy);
          x = s.x + (s.width - width);
        } else if (interaction.corner === "ne") {
          width = Math.max(MIN, s.width + dx);
          height = Math.max(MIN, s.height - dy);
          y = s.y + (s.height - height);
        } else {
          width = Math.max(MIN, s.width - dx);
          height = Math.max(MIN, s.height - dy);
          x = s.x + (s.width - width);
          y = s.y + (s.height - height);
        }
        const resized = { ...s, x: snap(x), y: snap(y), width: Math.round(width), height: Math.round(height) };
        setLiveNodes(doc.nodes.map((n) => (n.id === s.id ? resized : n)));
        return;
      }
      if (interaction.mode === "connect") {
        const cur = clientToDoc(e.clientX, e.clientY);
        setConnectPreview((prev) => (prev ? { ...prev, to: cur } : prev));
        return;
      }
    },
    [zoom, doc.nodes, clientToDoc, onPanChange, snap]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const interaction = interactionRef.current;
      interactionRef.current = null;
      if (!interaction) return;

      if (interaction.mode === "marquee") {
        if (marquee && (marquee.w > 4 || marquee.h > 4)) {
          const hit = doc.nodes.filter((n) => n.x < marquee.x + marquee.w && n.x + n.width > marquee.x && n.y < marquee.y + marquee.h && n.y + n.height > marquee.y);
          onSelectionChange(new Set(hit.map((n) => n.id)));
        }
        setMarquee(null);
        return;
      }
      if ((interaction.mode === "move" || interaction.mode === "resize") && liveNodes) {
        const before = interaction.mode === "move" ? interaction.startNodes : [interaction.startNode];
        const beforeIds = new Set(before.map((n) => n.id));
        const after = liveNodes.filter((n) => beforeIds.has(n.id));
        // A click that never passed the dead zone commits nothing.
        const changed = after.some((a) => {
          const b = before.find((x) => x.id === a.id);
          return !b || b.x !== a.x || b.y !== a.y || b.width !== a.width || b.height !== a.height;
        });
        if (changed) onEditNodes(before, after);
        setLiveNodes(null);
        return;
      }
      if (interaction.mode === "connect") {
        // Landed on a node? Wire them up. Released over empty canvas is a cancelled gesture - a
        // roadmap connector always joins two real topics, so there's nothing sensible to create.
        const point = clientToDoc(e.clientX, e.clientY);
        const target = [...doc.nodes].reverse().find((n) => point.x >= n.x && point.x <= n.x + n.width && point.y >= n.y && point.y <= n.y + n.height);
        if (target && target.id !== interaction.sourceId) {
          const source = nodesById.get(interaction.sourceId);
          if (source) {
            // Attach on whichever of the target's sides faces the source, so the curve arrives from
            // the natural direction instead of looping around the box.
            const sc = nodeCenter(source);
            const tc = nodeCenter(target);
            const dx = sc.x - tc.x;
            const dy = sc.y - tc.y;
            const targetSide: MindmapSide = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
            onAddEdge({
              id: crypto.randomUUID(),
              sourceId: interaction.sourceId,
              sourceSide: interaction.sourceSide,
              targetId: target.id,
              targetSide,
              style: target.type === "subtopic" ? "dashed" : "solid",
            });
          }
        }
        setConnectPreview(null);
        return;
      }
    },
    [marquee, liveNodes, doc.nodes, nodesById, clientToDoc, onSelectionChange, onEditNodes, onAddEdge]
  );

  const commitLabel = useCallback(
    (node: MindmapNode, text: string) => {
      setEditingId(null);
      if (text === node.label) return;
      onEditNodes([node], [{ ...node, label: text }]);
    },
    [onEditNodes]
  );

  // Ticking a row is an ordinary node edit, so it goes through the same commit path as any other -
  // one undo step, saved like everything else.
  const toggleItem = useCallback(
    (node: MindmapNode, itemId: string) => {
      const items = nodeItems(node);
      if (items.length === 0) return;
      onEditNodes([node], [{ ...node, items: items.map((i) => (i.id === itemId ? { ...i, checked: !i.checked } : i)) }]);
    },
    [onEditNodes]
  );

  const handleSize = HANDLE_SCREEN_SIZE / zoom;
  const arrowSize = ADD_ARROW_SCREEN_SIZE / zoom;
  const singleSelected = selectedIds.size === 1 ? nodesById.get([...selectedIds][0]) ?? null : null;

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden select-none"
      style={{
        backgroundColor: "var(--mm-bg, #fafafa)",
        backgroundImage: doc.showGrid ? "radial-gradient(circle, rgba(120,120,130,0.30) 1px, transparent 1px)" : undefined,
        backgroundSize: doc.showGrid ? `${GRID_SIZE * zoom}px ${GRID_SIZE * zoom}px` : undefined,
        backgroundPosition: doc.showGrid ? `${pan.x}px ${pan.y}px` : undefined,
        cursor: spaceHeld ? "grab" : "default",
        touchAction: "none",
      }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="absolute top-0 left-0 w-0 h-0" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}>
        {/* Connector layer, drawn before the nodes so lines pass behind boxes. */}
        <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }} width={1} height={1}>
          {doc.edges.map((edge) => {
            const source = nodesById.get(edge.sourceId);
            const target = nodesById.get(edge.targetId);
            if (!source || !target) return null;
            return (
              <path
                key={edge.id}
                d={edgePath(source, edge.sourceSide, target, edge.targetSide)}
                fill="none"
                stroke="#2b7fff"
                strokeWidth={2.5}
                strokeDasharray={edge.style === "dashed" ? "1 7" : undefined}
                strokeLinecap="round"
              />
            );
          })}
          {connectPreview && (
            <path
              d={`M${connectPreview.from.x},${connectPreview.from.y} L${connectPreview.to.x},${connectPreview.to.y}`}
              fill="none"
              stroke="#2b7fff"
              strokeWidth={2}
              strokeDasharray="4 4"
            />
          )}
          {marquee && <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill="rgba(43,127,255,0.08)" stroke="#2b7fff" strokeWidth={1 / zoom} />}
        </svg>

        {nodes.map((node) => {
          const selected = selectedIds.has(node.id);
          const hovered = hoveredId === node.id;
          const isLine = node.type === "horizontalLine" || node.type === "verticalLine";
          const progress = resolveProgress(node);
          return (
            <div
              key={node.id}
              className="absolute"
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                // A grab cursor is the affordance that says "this moves" - without it a node reads
                // as static decoration, which is exactly how the line types felt.
                cursor: node.locked ? "default" : "grab",
              }}
              onPointerEnter={() => setHoveredId(node.id)}
              onPointerLeave={() => setHoveredId((p) => (p === node.id ? null : p))}
              onPointerDown={(e) => beginMove(node, e)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!isLine && !node.locked) setEditingId(node.id);
              }}
            >
              {/* A divider is 2px thick, which is far too thin to reliably hit with a pointer - this
                  invisible strip gives it a consistent ~14px grab band without changing how the
                  line itself draws or where connectors attach. */}
              {isLine && (
                <div
                  style={{
                    position: "absolute",
                    left: node.type === "verticalLine" ? -LINE_HIT_PADDING / zoom : 0,
                    top: node.type === "horizontalLine" ? -LINE_HIT_PADDING / zoom : 0,
                    width: node.type === "verticalLine" ? node.width + (LINE_HIT_PADDING * 2) / zoom : node.width,
                    height: node.type === "horizontalLine" ? node.height + (LINE_HIT_PADDING * 2) / zoom : node.height,
                  }}
                />
              )}

              <MindmapNodeBody node={node} editing={editingId === node.id} onCommitLabel={(text) => commitLabel(node, text)} onToggleItem={(itemId) => toggleItem(node, itemId)} />

              {/* Progress tick - only topic-ish nodes carry one, and only when it's been set, so an
                  untouched roadmap isn't covered in empty checkboxes. */}
              {TOPIC_NODE_TYPES.has(node.type) && progress !== "pending" && (
                <div
                  className="absolute rounded-full flex items-center justify-center"
                  style={{
                    right: -7 / zoom,
                    top: -7 / zoom,
                    width: 16 / zoom,
                    height: 16 / zoom,
                    fontSize: 10 / zoom,
                    background: progress === "done" ? "#16a34a" : progress === "in-progress" ? "#eab308" : "#9ca3af",
                    color: "#fff",
                  }}
                  title={progress}
                >
                  {progress === "done" ? "✓" : progress === "in-progress" ? "•" : "–"}
                </div>
              )}

              {/* Selection outline. Lines get one too (unlike before) - a selected 2px divider was
                  otherwise indistinguishable from an unselected one. */}
              {(selected || hovered) && (
                <div
                  className="absolute"
                  style={{
                    inset: isLine ? -4 / zoom : -2 / zoom,
                    border: `${(selected ? 2 : 1) / zoom}px solid ${selected ? "#7c3aed" : "#c4b5fd"}`,
                    borderRadius: 4 / zoom,
                    pointerEvents: "none",
                  }}
                />
              )}

              {/* Delete + drag chrome, pinned just above the node's top-right corner. The drag grip
                  is what makes a thin or fully-covered node movable at all: its own body may be a
                  2px line, or sit under an inline editor, and a handle outside the box is always
                  reachable. Sized in screen pixels so it stays usable at any zoom. */}
              {selected && singleSelected?.id === node.id && !node.locked && (
                <div
                  className="absolute flex items-center overflow-hidden"
                  style={{
                    right: 0,
                    top: -(CHROME_SCREEN_HEIGHT + 6) / zoom,
                    height: CHROME_SCREEN_HEIGHT / zoom,
                    borderRadius: 4 / zoom,
                    border: `${1 / zoom}px solid #d4d4d8`,
                    background: "#ffffff",
                    boxShadow: `0 ${1 / zoom}px ${4 / zoom}px rgba(0,0,0,0.15)`,
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSelection();
                    }}
                    style={{
                      width: CHROME_SCREEN_HEIGHT / zoom,
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12 / zoom,
                      color: "#dc2626",
                      cursor: "pointer",
                      background: "transparent",
                      border: "none",
                      padding: 0,
                    }}
                  >
                    <IoTrashOutline />
                  </button>
                  <div style={{ width: 1 / zoom, height: "70%", background: "#e4e4e7" }} />
                  <div
                    title="Drag to move"
                    onPointerDown={(e) => {
                      // Reuses the node's own move gesture, so dragging by the grip and dragging by
                      // the body are the same interaction and produce the same single undo step.
                      e.stopPropagation();
                      beginMove(node, e);
                    }}
                    style={{
                      width: CHROME_SCREEN_HEIGHT / zoom,
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12 / zoom,
                      color: "#52525b",
                      cursor: "grab",
                    }}
                  >
                    <TbGripVertical />
                  </div>
                </div>
              )}

              {/* Side dots: hover a node and drag one to draw a connector by hand. */}
              {(hovered || selected) &&
                !isLine &&
                (["top", "right", "bottom", "left"] as MindmapSide[]).map((side) => {
                  const pos: React.CSSProperties = { position: "absolute", width: handleSize, height: handleSize, borderRadius: "50%", background: "#2b7fff", cursor: "crosshair" };
                  if (side === "top") Object.assign(pos, { left: node.width / 2 - handleSize / 2, top: -handleSize / 2 });
                  if (side === "bottom") Object.assign(pos, { left: node.width / 2 - handleSize / 2, top: node.height - handleSize / 2 });
                  if (side === "left") Object.assign(pos, { left: -handleSize / 2, top: node.height / 2 - handleSize / 2 });
                  if (side === "right") Object.assign(pos, { left: node.width - handleSize / 2, top: node.height / 2 - handleSize / 2 });
                  return <div key={side} style={pos} onPointerDown={(e) => beginConnect(node, side, e)} />;
                })}

              {/* Corner resize handles, on the single selected node only - showing eight handles on
                  every member of a multi-selection is noise, since resize acts on one node here. */}
              {selected && singleSelected?.id === node.id && !node.locked && (
                <>
                  {(["nw", "ne", "sw", "se"] as const).map((corner) => {
                    const style: React.CSSProperties = {
                      position: "absolute",
                      width: handleSize,
                      height: handleSize,
                      background: "#ffffff",
                      border: `${1 / zoom}px solid #7c3aed`,
                      cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                    };
                    if (corner === "nw") Object.assign(style, { left: -handleSize / 2, top: -handleSize / 2 });
                    if (corner === "ne") Object.assign(style, { left: node.width - handleSize / 2, top: -handleSize / 2 });
                    if (corner === "sw") Object.assign(style, { left: -handleSize / 2, top: node.height - handleSize / 2 });
                    if (corner === "se") Object.assign(style, { left: node.width - handleSize / 2, top: node.height - handleSize / 2 });
                    return <div key={corner} style={style} onPointerDown={(e) => beginResize(node, corner, e)} />;
                  })}
                </>
              )}

              {/* The directional add-topic arrows - the interaction the whole tool is built around.
                  Shown just outside each side of the single selected node; one click adds a
                  connected child in that direction. */}
              {selected && singleSelected?.id === node.id && TOPIC_NODE_TYPES.has(node.type) && (
                <>
                  {(["top", "right", "bottom", "left"] as MindmapSide[]).map((side) => {
                    const gap = 14 / zoom;
                    const style: React.CSSProperties = {
                      position: "absolute",
                      width: arrowSize,
                      height: arrowSize,
                      borderRadius: 4 / zoom,
                      background: "#7c3aed",
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 13 / zoom,
                      lineHeight: 1,
                      cursor: "pointer",
                      boxShadow: `0 ${1 / zoom}px ${3 / zoom}px rgba(0,0,0,0.25)`,
                    };
                    if (side === "top") Object.assign(style, { left: node.width / 2 - arrowSize / 2, top: -arrowSize - gap });
                    if (side === "bottom") Object.assign(style, { left: node.width / 2 - arrowSize / 2, top: node.height + gap });
                    if (side === "left") Object.assign(style, { left: -arrowSize - gap, top: node.height / 2 - arrowSize / 2 });
                    if (side === "right") Object.assign(style, { left: node.width + gap, top: node.height / 2 - arrowSize / 2 });
                    const glyph = side === "top" ? "↑" : side === "bottom" ? "↓" : side === "left" ? "←" : "→";
                    return (
                      <div
                        key={`add-${side}`}
                        style={style}
                        title={`Add a connected topic ${side === "top" ? "above" : side === "bottom" ? "below" : side === "left" ? "to the left" : "to the right"}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddTopic(node, side);
                        }}
                      >
                        {glyph}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

// One node's visible body. Split out so the appearance rules for each type live in one place rather
// than inline in the canvas's already-dense node loop.
function MindmapNodeBody({
  node,
  editing,
  onCommitLabel,
  onToggleItem,
}: {
  node: MindmapNode;
  editing: boolean;
  onCommitLabel: (text: string) => void;
  onToggleItem?: (itemId: string) => void;
}) {
  const palette = MINDMAP_PALETTE[node.colorKey];
  const fontPx = MINDMAP_FONT_PX[node.fontSize];

  if (node.type === "horizontalLine" || node.type === "verticalLine") {
    return <div style={{ position: "absolute", inset: 0, background: palette.border }} />;
  }

  const base: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: node.type === "paragraph" || node.type === "checklist" || node.type === "linksGroup" ? "flex-start" : "center",
    padding: node.type === "paragraph" || node.type === "checklist" || node.type === "linksGroup" ? "8px 10px" : "4px 10px",
    fontSize: fontPx,
    fontWeight: node.bold ? 700 : 400,
    fontStyle: node.italic ? "italic" : "normal",
    color: palette.text,
    textAlign: node.type === "paragraph" ? "left" : "center",
    lineHeight: 1.3,
    overflow: "hidden",
    wordBreak: "break-word",
  };

  // "title", "label" and "paragraph" are bare text on the canvas - no box, no border. A title is a
  // section HEADING, not a step a reader works through; giving it the same filled, bordered
  // treatment as a topic makes the roadmap read as if everything on it were clickable.
  if (node.type === "title" || node.type === "label" || node.type === "paragraph") {
    return (
      <div style={{ ...base, alignItems: node.type === "paragraph" ? "flex-start" : "center", background: "transparent" }}>
        {editing ? <InlineEditor value={node.label} fontPx={fontPx} onCommit={onCommitLabel} /> : node.label}
      </div>
    );
  }

  if (node.type === "checklist" || node.type === "linksGroup") {
    const checkColor = resolveCheckColor(node);
    const glyph = MINDMAP_CHECK_GLYPH[resolveCheckStyle(node)];
    return (
      <div style={{ ...base, flexDirection: "column", alignItems: "stretch", gap: 4, background: "transparent" }}>
        <div style={{ fontWeight: 700, fontSize: fontPx }}>{editing ? <InlineEditor value={node.label} fontPx={fontPx} onCommit={onCommitLabel} /> : node.label}</div>
        {nodeItems(node).map((item) => (
          <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: fontPx - 1, opacity: 0.85 }}>
            {node.type === "checklist" ? (
              // Tickable directly on the canvas - a checklist you can only tick from a side panel
              // isn't a checklist. pointerDown is stopped so ticking a row never also starts
              // dragging the node out from under the cursor.
              <span
                role="checkbox"
                aria-checked={item.checked ?? false}
                title={item.checked ? "Uncheck" : "Check"}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleItem?.(item.id);
                }}
                style={{
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                  border: `1.5px solid ${item.checked ? checkColor : palette.border}`,
                  borderRadius: 3,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 9,
                  lineHeight: 1,
                  color: checkColor,
                  cursor: "pointer",
                }}
              >
                {item.checked ? glyph : ""}
              </span>
            ) : (
              <span style={{ color: "#2b7fff", flexShrink: 0 }}>›</span>
            )}
            <span
              style={{
                textDecoration: node.type === "linksGroup" ? "underline" : undefined,
                color: node.type === "linksGroup" ? "#2b7fff" : undefined,
                // A ticked row reads as struck through, the way a paper list does.
                opacity: node.type === "checklist" && item.checked ? 0.55 : 1,
              }}
            >
              {item.text}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // topic / subtopic / button - the filled, bordered boxes.
  return (
    <div
      style={{
        ...base,
        background: palette.background,
        border: `2px solid ${palette.border}`,
        borderRadius: node.type === "button" ? 6 : 3,
        boxShadow: node.type === "topic" ? "2px 2px 0 rgba(0,0,0,0.18)" : undefined,
      }}
    >
      {editing ? <InlineEditor value={node.label} fontPx={fontPx} onCommit={onCommitLabel} /> : node.label}
    </div>
  );
}

// Double-click-to-edit label field. Commits on blur or Enter, discards on Escape - the same contract
// the whiteboard's own inline text editor uses, so the two canvases behave identically.
function InlineEditor({ value, fontPx, onCommit }: { value: string; fontPx: number; onCommit: (text: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(value);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <textarea
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onCommit(text);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCommit(value);
        }
      }}
      style={{
        width: "100%",
        height: "100%",
        resize: "none",
        border: "none",
        outline: "none",
        background: "transparent",
        font: "inherit",
        fontSize: fontPx,
        textAlign: "inherit",
        color: "inherit",
        padding: 0,
      }}
    />
  );
}

export default MindmapCanvas;
