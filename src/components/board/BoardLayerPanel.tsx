// components/board/BoardLayerPanel.tsx
//
// Docked left-side panel listing every item on the board in paint (z-)order, front-to-back top-to-
// bottom - the same convention Figma/Photoshop use, and the inverse of doc.images's own order
// (last element = drawn last = frontmost, so this just renders [...items].reverse()). Lets the user
// see and manage stacking order without relying on "click the exact overlapping tile" on the canvas,
// and click a row to select that item directly - handy once several items overlap and picking the
// right one by clicking the canvas gets fiddly.
import React, { useRef, useState } from "react";
import { IoChevronDown, IoChevronUp, IoCloseOutline, IoImageOutline, IoLockClosed, IoLockOpenOutline, IoShapesOutline, IoText } from "react-icons/io5";
import { TbBlur, TbGripVertical } from "react-icons/tb";
import { BoardItem, BoardShape } from "../../utils/boardTypes";

interface BoardLayerPanelProps {
  items: BoardItem[]; // doc.images, in paint order (back to front)
  selectedIds: Set<string>;
  onSelect: (ids: Set<string>) => void;
  // Swaps the item one step toward the front ("forward") or back ("backward") with whichever
  // neighbor currently sits there - see BoardEditor.tsx's handleStepReorder. A no-op at either end
  // of the stack; the row's own chevron buttons disable themselves in that case.
  onStepReorder: (id: string, direction: "forward" | "backward") => void;
  // Free (not just one-step) reorder via dragging a row onto another - see BoardEditor.tsx's
  // handleReorderLayer. Drops the dragged item into the target's current stacking position.
  onReorder: (draggedId: string, targetId: string) => void;
  // Toggles BoardItemBase.locked - see its own doc comment in boardTypes.ts for what locking does
  // (blocks canvas hit-testing/dragging; this panel remains the one place a locked item can still
  // be selected, unlocked, reordered, or deleted).
  onToggleLock: (id: string) => void;
  onClose: () => void;
}

const KIND_ICON: Record<BoardItem["kind"], React.ReactNode> = {
  image: <IoImageOutline size={14} />,
  text: <IoText size={14} />,
  blur: <TbBlur size={14} />,
  shape: <IoShapesOutline size={14} />,
};

// "polygon"/"star" show their own sides/points count (matching what the style panel's shape-type
// grid actually named it - a "polygon" with sides:3 IS a triangle, not a generic "Polygon") rather
// than the raw shapeType string, which would otherwise be the one kind whose layer-list label
// doesn't match what the user actually picked.
function shapeLayerLabel(item: BoardShape): string {
  if (item.shapeType === "polygon") {
    const sides = item.sides ?? 5;
    return sides === 3 ? "Triangle" : sides === 5 ? "Pentagon" : sides === 6 ? "Hexagon" : sides === 8 ? "Octagon" : `${sides}-gon`;
  }
  if (item.shapeType === "star") return "Star";
  if (item.shapeType === "block-arrow") return "Block arrow";
  return item.shapeType[0].toUpperCase() + item.shapeType.slice(1);
}

function layerLabel(item: BoardItem): string {
  if (item.kind === "text") return item.text.trim() || "Text";
  if (item.kind === "blur") return "Blur";
  if (item.kind === "shape") return shapeLayerLabel(item);
  return "Image";
}

const BoardLayerPanel: React.FC<BoardLayerPanelProps> = ({ items, selectedIds, onSelect, onStepReorder, onReorder, onToggleLock, onClose }) => {
  // Front-to-back for display; each row still knows its own true index in `items` (the array
  // BoardEditor.tsx and onStepReorder both work in) via `items.length - 1 - displayIndex`.
  const frontToBack = [...items].reverse();

  // Drag-and-drop reorder state powered by pointer events so it works seamlessly inside WebView2 / Tauri.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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
      (el) => el.getAttribute("data-board-layer-id") && el.getAttribute("data-board-layer-id") !== id
    );
    const targetId = targetEl ? targetEl.getAttribute("data-board-layer-id") : null;
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
      if (e.shiftKey) {
        const next = new Set(selectedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        onSelect(next);
      } else {
        onSelect(new Set([id]));
      }
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
    <div className="absolute top-3 right-3 bottom-[calc(var(--docker-height,60px)+10px)] w-64 bg-white/95 dark:bg-neutral-900/95 backdrop-blur-xl ring-1 ring-black/[0.07] dark:ring-white/[0.08] rounded-2xl shadow-[0_12px_40px_-12px_rgba(0,0,0,0.18),0_2px_6px_-2px_rgba(0,0,0,0.06)] flex flex-col overflow-hidden text-neutral-800 dark:text-neutral-200 z-30 animate-[boardPanelIn_180ms_ease-out]">
      <style>{"@keyframes boardPanelIn{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}"}</style>
      <div className="shrink-0 flex items-center justify-between px-3.5 h-11 border-b border-black/[0.05] dark:border-white/[0.06]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-100">Layers</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 font-mono">
            {frontToBack.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Hide layers panel"
          className="w-6 h-6 flex items-center justify-center rounded-md text-neutral-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
        >
          <IoCloseOutline size={16} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {frontToBack.length === 0 && <div className="px-2 py-6 text-center text-xs text-neutral-400 dark:text-neutral-500">Nothing on the board yet</div>}
        {frontToBack.map((item, displayIndex) => {
          const trueIndex = items.length - 1 - displayIndex;
          const isSelected = selectedIds.has(item.id);
          const isDragOver = dragOverId === item.id && draggingId !== null && draggingId !== item.id;
          return (
            <div
              key={item.id}
              data-board-layer-id={item.id}
              onPointerDown={(e) => handlePointerDown(item.id, e)}
              onPointerMove={(e) => handlePointerMove(item.id, e)}
              onPointerUp={(e) => handlePointerUp(item.id, e)}
              onPointerCancel={(e) => handlePointerCancel(item.id, e)}
              className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer transition-colors border-t-2 touch-none ${
                isDragOver ? "border-t-blue-500 bg-blue-500/5 dark:bg-blue-500/10" : "border-t-transparent"
              } ${
                draggingId === item.id
                  ? "opacity-35 scale-[0.98] bg-neutral-100 dark:bg-neutral-800"
                  : isSelected
                    ? "bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300"
                    : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              <div
                className="shrink-0 p-0.5 cursor-grab active:cursor-grabbing text-neutral-300 dark:text-neutral-600 group-hover:text-neutral-500 transition-colors"
                title="Drag up or down to reorder"
              >
                <TbGripVertical size={13} className="pointer-events-none" />
              </div>
              <span className={`shrink-0 pointer-events-none ${isSelected ? "text-blue-500" : "text-neutral-400 dark:text-neutral-500"}`}>{KIND_ICON[item.kind]}</span>
              <span className={`min-w-0 flex-1 truncate text-sm pointer-events-none ${item.locked ? "italic text-neutral-400 dark:text-neutral-500" : ""}`}>{layerLabel(item)}</span>
              <button
                type="button"
                title={item.locked ? "Unlock - re-enables dragging/resizing on the canvas" : "Lock - can't be clicked, dragged, or resized on the canvas until unlocked"}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleLock(item.id);
                }}
                className={`shrink-0 w-5 h-5 flex items-center justify-center rounded transition-colors ${
                  item.locked
                    ? "text-amber-500 hover:bg-amber-100 dark:hover:bg-amber-500/10"
                    : "text-neutral-300 dark:text-neutral-600 opacity-0 group-hover:opacity-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-600 dark:hover:text-neutral-300"
                }`}
              >
                {item.locked ? <IoLockClosed size={12} /> : <IoLockOpenOutline size={12} />}
              </button>
              <div
                onPointerDown={(e) => e.stopPropagation()}
                className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
              >
                <button
                  type="button"
                  title="Move forward one"
                  disabled={trueIndex >= items.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStepReorder(item.id, "forward");
                  }}
                  className="w-5 h-5 flex items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                >
                  <IoChevronUp size={12} />
                </button>
                <button
                  type="button"
                  title="Move back one"
                  disabled={trueIndex <= 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStepReorder(item.id, "backward");
                  }}
                  className="w-5 h-5 flex items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                >
                  <IoChevronDown size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default BoardLayerPanel;
