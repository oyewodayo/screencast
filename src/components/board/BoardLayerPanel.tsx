// components/board/BoardLayerPanel.tsx
//
// Docked left-side panel listing every item on the board in paint (z-)order, front-to-back top-to-
// bottom - the same convention Figma/Photoshop use, and the inverse of doc.images's own order
// (last element = drawn last = frontmost, so this just renders [...items].reverse()). Lets the user
// see and manage stacking order without relying on "click the exact overlapping tile" on the canvas,
// and click a row to select that item directly - handy once several items overlap and picking the
// right one by clicking the canvas gets fiddly.
import React from "react";
import { IoChevronDown, IoChevronUp, IoCloseOutline, IoImageOutline, IoText } from "react-icons/io5";
import { TbBlur } from "react-icons/tb";
import { BoardItem } from "../../utils/boardTypes";

interface BoardLayerPanelProps {
  items: BoardItem[]; // doc.images, in paint order (back to front)
  selectedIds: Set<string>;
  onSelect: (ids: Set<string>) => void;
  // Swaps the item one step toward the front ("forward") or back ("backward") with whichever
  // neighbor currently sits there - see BoardEditor.tsx's handleStepReorder. A no-op at either end
  // of the stack; the row's own chevron buttons disable themselves in that case.
  onStepReorder: (id: string, direction: "forward" | "backward") => void;
  onClose: () => void;
}

const KIND_ICON: Record<BoardItem["kind"], React.ReactNode> = {
  image: <IoImageOutline size={14} />,
  text: <IoText size={14} />,
  blur: <TbBlur size={14} />,
};

function layerLabel(item: BoardItem): string {
  if (item.kind === "text") return item.text.trim() || "Text";
  if (item.kind === "blur") return "Blur";
  return "Image";
}

const BoardLayerPanel: React.FC<BoardLayerPanelProps> = ({ items, selectedIds, onSelect, onStepReorder, onClose }) => {
  // Front-to-back for display; each row still knows its own true index in `items` (the array
  // BoardEditor.tsx and onStepReorder both work in) via `items.length - 1 - displayIndex`.
  const frontToBack = [...items].reverse();

  return (
    <div className="w-64 shrink-0 flex flex-col border-l border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <div className="shrink-0 flex items-center justify-between px-3.5 py-3 border-b border-neutral-200/80 dark:border-neutral-800">
        <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Layers</span>
        <button
          type="button"
          onClick={onClose}
          title="Hide layers panel"
          className="w-6 h-6 flex items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
        >
          <IoCloseOutline size={16} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {frontToBack.length === 0 && <div className="px-2 py-6 text-center text-xs text-neutral-400 dark:text-neutral-500">Nothing on the board yet</div>}
        {frontToBack.map((item, displayIndex) => {
          const trueIndex = items.length - 1 - displayIndex;
          const isSelected = selectedIds.has(item.id);
          return (
            <div
              key={item.id}
              onClick={(e) => {
                if (e.shiftKey) {
                  const next = new Set(selectedIds);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  onSelect(next);
                } else {
                  onSelect(new Set([item.id]));
                }
              }}
              className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
                isSelected
                  ? "bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300"
                  : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              <span className={`shrink-0 ${isSelected ? "text-blue-500" : "text-neutral-400 dark:text-neutral-500"}`}>{KIND_ICON[item.kind]}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{layerLabel(item)}</span>
              <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
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
