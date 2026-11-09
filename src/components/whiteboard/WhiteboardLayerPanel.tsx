// components/whiteboard/WhiteboardLayerPanel.tsx
//
// Floating layers panel for Whiteboard listing every shape, text box, image, and connector on the
// active page in visual stack (z-) order, front-to-back (topmost element on canvas is at the top of
// the list - the same convention Photoshop, Figma, and BoardLayerPanel use). Lets users select
// elements that were sent backward and covered by other shapes, reorder them via drag-and-drop or
// chevron buttons, and lock/delete them directly.
import React, { useRef, useState } from "react";
import {
  IoChevronDown,
  IoChevronUp,
  IoCloseOutline,
  IoImageOutline,
  IoLockClosed,
  IoLockOpenOutline,
  IoShapesOutline,
  IoText,
  IoTrashOutline,
} from "react-icons/io5";
import {
  TbArrowRight,
  TbFrame,
  TbGripVertical,
  TbNote,
  TbPencil,
  TbTable,
} from "react-icons/tb";
import { resolvePageLayerOrder } from "../../handlers/whiteboardHandlers";
import { WhiteboardEdge, WhiteboardNode, WhiteboardPage } from "../../utils/whiteboardTypes";

interface WhiteboardLayerPanelProps {
  page: WhiteboardPage;
  selectedNodeIds: Set<string>;
  selectedEdgeIds: Set<string>;
  onSelectItem: (id: string, kind: "node" | "edge", multi: boolean) => void;
  onStepReorder: (id: string, direction: "forward" | "backward") => void;
  onReorder: (draggedId: string, targetId: string) => void;
  onToggleLock: (id: string, kind: "node" | "edge") => void;
  onDelete: (id: string, kind: "node" | "edge") => void;
  onClose: () => void;
}

type TaggedItem =
  | { kind: "node"; item: WhiteboardNode }
  | { kind: "edge"; item: WhiteboardEdge };

function getNodeIcon(node: WhiteboardNode): React.ReactNode {
  switch (node.shapeType) {
    case "image":
      return <IoImageOutline size={14} className="text-blue-500 shrink-0" />;
    case "text":
      return <IoText size={14} className="text-amber-500 shrink-0" />;
    case "table":
      return <TbTable size={14} className="text-emerald-500 shrink-0" />;
    case "note":
      return <TbNote size={14} className="text-yellow-500 shrink-0" />;
    case "freehand":
      return <TbPencil size={14} className="text-purple-500 shrink-0" />;
    case "frame":
      return <TbFrame size={14} className="text-indigo-500 shrink-0" />;
    default:
      return <IoShapesOutline size={14} className="text-neutral-500 dark:text-neutral-400 shrink-0" />;
  }
}

function getNodeLabel(node: WhiteboardNode): string {
  const text = (node.text ?? "").trim();
  if (node.shapeType === "text") {
    return text || "Text";
  }
  if (node.shapeType === "image") {
    if (text) return `Image: ${text}`;
    if (node.assetFileName) {
      const fileName = node.assetFileName.split(/[/\\]/).pop();
      if (fileName) return `Image (${fileName})`;
    }
    return "Image";
  }
  if (node.shapeType === "note") {
    return text ? `Note: "${text}"` : "Sticky note";
  }
  if (node.shapeType === "table") {
    return text ? `Table: "${text}"` : "Table";
  }
  if (node.shapeType === "freehand") {
    return "Drawing";
  }
  if (node.shapeType === "frame") {
    return text ? `Frame: "${text}"` : "Frame";
  }
  const shapeName = node.shapeType
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
  return text ? `${shapeName}: "${text}"` : shapeName;
}

function getEdgeLabel(edge: WhiteboardEdge): string {
  const label = (edge.label ?? "").trim();
  return label ? `Connector: "${label}"` : "Connector";
}

const WhiteboardLayerPanel: React.FC<WhiteboardLayerPanelProps> = ({
  page,
  selectedNodeIds,
  selectedEdgeIds,
  onSelectItem,
  onStepReorder,
  onReorder,
  onToggleLock,
  onDelete,
  onClose,
}) => {
  const ranks = resolvePageLayerOrder(page);
  const unified: TaggedItem[] = [
    ...page.nodes.map((item): TaggedItem => ({ kind: "node", item })),
    ...page.edges.map((item): TaggedItem => ({ kind: "edge", item })),
  ].sort((a, b) => (ranks.get(a.item.id) ?? 0) - (ranks.get(b.item.id) ?? 0));

  // Front-to-back display order (top row = frontmost item on canvas)
  const frontToBack = [...unified].reverse();

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Pointer-driven drag tracking - immune to WebView2 / Tauri HTML5 drag interception
  const pointerDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    isDragging: boolean;
  } | null>(null);

  const handlePointerDown = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    pointerDragRef.current = {
      id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
    };
  };

  const handlePointerMove = (id: string, e: React.PointerEvent) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.id !== id) return;

    if (!drag.isDragging) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= 4) {
        drag.isDragging = true;
        setDraggingId(id);
      } else {
        return;
      }
    }

    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    const targetEl = elements.find(
      (el) => el.getAttribute("data-layer-id") && el.getAttribute("data-layer-id") !== id
    );
    const targetId = targetEl ? targetEl.getAttribute("data-layer-id") : null;
    setDragOverId(targetId);
  };

  const handlePointerUp = (id: string, e: React.PointerEvent) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.id !== id) return;

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(drag.pointerId);
    } catch (_) {}

    if (drag.isDragging) {
      if (dragOverId && dragOverId !== id) {
        onReorder(id, dragOverId);
      }
    } else {
      const isMulti = e.shiftKey || e.ctrlKey || e.metaKey;
      const item = frontToBack.find((x) => x.item.id === id);
      if (item) onSelectItem(id, item.kind, isMulti);
    }

    pointerDragRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
  };

  const handlePointerCancel = (id: string, e: React.PointerEvent) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.id !== id) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(drag.pointerId);
    } catch (_) {}
    pointerDragRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
  };

  return (
    <div className="absolute top-3 right-3 bottom-3 w-64 bg-white/95 dark:bg-neutral-900/95 backdrop-blur-xl ring-1 ring-black/[0.07] dark:ring-white/[0.08] rounded-2xl shadow-[0_12px_40px_-12px_rgba(0,0,0,0.18),0_2px_6px_-2px_rgba(0,0,0,0.06)] flex flex-col overflow-hidden text-neutral-800 dark:text-neutral-200 z-20 animate-[wbPanelIn_180ms_ease-out]">
      <style>{"@keyframes wbPanelIn{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}"}</style>

      {/* Header */}
      <div className="shrink-0 px-3.5 h-11 flex items-center justify-between border-b border-black/[0.05] dark:border-white/[0.06]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-100">Layers</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 font-mono">
            {frontToBack.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close layers panel"
          className="w-6 h-6 flex items-center justify-center rounded-md text-neutral-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
        >
          <IoCloseOutline size={16} />
        </button>
      </div>

      {/* Layers List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        {frontToBack.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-4 text-center text-xs text-neutral-400 dark:text-neutral-500">
            No items on this page
          </div>
        ) : (
          frontToBack.map((item, displayIndex) => {
            const id = item.item.id;
            const isSelected = item.kind === "node" ? selectedNodeIds.has(id) : selectedEdgeIds.has(id);
            const isLocked = Boolean(item.item.locked);
            const isDragOver = dragOverId === id && draggingId !== null && draggingId !== id;
            const isDragging = draggingId === id;

            const icon = item.kind === "node" ? getNodeIcon(item.item) : <TbArrowRight size={14} className="text-neutral-400 shrink-0" />;
            const label = item.kind === "node" ? getNodeLabel(item.item) : getEdgeLabel(item.item);
            const fillColor = item.kind === "node" && item.item.fillColor && item.item.fillColor !== "transparent" ? item.item.fillColor : null;

            return (
              <div
                key={id}
                data-layer-id={id}
                onPointerDown={(e) => handlePointerDown(id, e)}
                onPointerMove={(e) => handlePointerMove(id, e)}
                onPointerUp={(e) => handlePointerUp(id, e)}
                onPointerCancel={(e) => handlePointerCancel(id, e)}
                className={`group relative flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer transition-all border-t-2 select-none text-xs touch-none ${
                  isDragOver ? "border-t-blue-500 bg-blue-500/10 dark:bg-blue-500/20 shadow-sm" : "border-t-transparent"
                } ${
                  isDragging
                    ? "opacity-35 scale-[0.98] bg-neutral-100 dark:bg-neutral-800"
                    : isSelected
                    ? "bg-blue-500/10 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 ring-1 ring-blue-500/30"
                    : "text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                }`}
              >
                {/* Drag handle */}
                <div
                  className="shrink-0 p-0.5 cursor-grab active:cursor-grabbing text-neutral-300 dark:text-neutral-600 group-hover:text-neutral-500 transition-colors"
                  title="Drag up or down to reorder"
                >
                  <TbGripVertical size={13} className="pointer-events-none" />
                </div>

                {/* Kind / Shape icon */}
                <div className="shrink-0 flex items-center justify-center w-4 h-4 pointer-events-none">
                  {icon}
                </div>

                {/* Optional fill color dot */}
                {fillColor && (
                  <span
                    className="shrink-0 w-2 h-2 rounded-full border border-black/10 dark:border-white/10 pointer-events-none"
                    style={{ backgroundColor: fillColor }}
                  />
                )}

                {/* Label */}
                <span className={`min-w-0 flex-1 truncate pointer-events-none ${isLocked ? "italic opacity-60" : ""}`} title={label}>
                  {label}
                </span>

                {/* Hover / Status actions */}
                <div
                  className="shrink-0 flex items-center gap-0.5"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Lock button */}
                  <button
                    type="button"
                    title={isLocked ? "Unlock" : "Lock"}
                    onClick={() => onToggleLock(id, item.kind)}
                    className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${
                      isLocked
                        ? "text-amber-500 hover:bg-amber-100 dark:hover:bg-amber-500/20"
                        : "text-neutral-400 opacity-0 group-hover:opacity-100 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
                    }`}
                  >
                    {isLocked ? <IoLockClosed size={12} /> : <IoLockOpenOutline size={12} />}
                  </button>

                  {/* Move Up (Forward) */}
                  <button
                    type="button"
                    title="Bring forward one level"
                    disabled={displayIndex === 0}
                    onClick={() => onStepReorder(id, "forward")}
                    className="w-5 h-5 flex items-center justify-center rounded text-neutral-400 opacity-0 group-hover:opacity-100 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-0 transition-opacity"
                  >
                    <IoChevronUp size={12} />
                  </button>

                  {/* Move Down (Backward) */}
                  <button
                    type="button"
                    title="Send backward one level"
                    disabled={displayIndex === frontToBack.length - 1}
                    onClick={() => onStepReorder(id, "backward")}
                    className="w-5 h-5 flex items-center justify-center rounded text-neutral-400 opacity-0 group-hover:opacity-100 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-0 transition-opacity"
                  >
                    <IoChevronDown size={12} />
                  </button>

                  {/* Delete button */}
                  <button
                    type="button"
                    title="Delete item"
                    onClick={() => onDelete(id, item.kind)}
                    className="w-5 h-5 flex items-center justify-center rounded text-neutral-400 opacity-0 group-hover:opacity-100 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-500 transition-all"
                  >
                    <IoTrashOutline size={12} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default WhiteboardLayerPanel;
