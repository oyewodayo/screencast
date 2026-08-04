// components/board/BoardStylePanel.tsx
//
// Per-image style controls for the Board editor's current selection - padding, border, corner
// radius, background, opacity, plus front/back/delete. All fields commit immediately on change
// (no debounce/live-preview split like the image editor's brightness/contrast sliders use -
// these are discrete numeric/color fields, not a continuous drag gesture that needs its own
// pre-commit staging).
import React from "react";
import { IoTrashOutline } from "react-icons/io5";
import { BoardImage } from "../../utils/boardTypes";

interface BoardStylePanelProps {
  images: BoardImage[]; // the full selected set - fields showing a mixed value across them just show the first one's
  onChange: (before: BoardImage[], after: BoardImage[]) => void;
  onDelete: (ids: Set<string>) => void;
  onBringToFront: (ids: Set<string>) => void;
  onSendToBack: (ids: Set<string>) => void;
}

const FIELD_LABEL = "text-xs text-neutral-500 dark:text-neutral-400 flex items-center justify-between gap-2";
const RANGE_INPUT = "w-full accent-blue-500";
const COLOR_INPUT = "w-8 h-8 rounded border border-neutral-300 dark:border-neutral-600 bg-transparent cursor-pointer";

const BoardStylePanel: React.FC<BoardStylePanelProps> = ({ images, onChange, onDelete, onBringToFront, onSendToBack }) => {
  if (images.length === 0) return null;
  const primary = images[0];
  const ids = new Set(images.map((img) => img.id));

  const setField = <K extends keyof BoardImage>(key: K, value: BoardImage[K]): void => {
    onChange(
      images,
      images.map((img) => ({ ...img, [key]: value, updatedAt: Date.now() }))
    );
  };

  return (
    <div className="w-64 shrink-0 h-full overflow-y-auto border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 flex flex-col gap-4">
      <div className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {images.length > 1 ? `${images.length} images selected` : "Image style"}
      </div>

      <label className={FIELD_LABEL}>
        Padding ({primary.padding}px)
        <input
          type="range"
          min={0}
          max={80}
          value={primary.padding}
          onChange={(e) => setField("padding", Number(e.target.value))}
          className={RANGE_INPUT}
        />
      </label>

      <label className={FIELD_LABEL}>
        Border width ({primary.borderWidth}px)
        <input
          type="range"
          min={0}
          max={40}
          value={primary.borderWidth}
          onChange={(e) => setField("borderWidth", Number(e.target.value))}
          className={RANGE_INPUT}
        />
      </label>

      <label className="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        Border color
        <input type="color" value={primary.borderColor} onChange={(e) => setField("borderColor", e.target.value)} className={COLOR_INPUT} />
      </label>

      <label className={FIELD_LABEL}>
        Corner radius ({primary.cornerRadius}px)
        <input
          type="range"
          min={0}
          max={200}
          value={primary.cornerRadius}
          onChange={(e) => setField("cornerRadius", Number(e.target.value))}
          className={RANGE_INPUT}
        />
      </label>

      <label className="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        Frame color
        <input type="color" value={primary.backgroundColor} onChange={(e) => setField("backgroundColor", e.target.value)} className={COLOR_INPUT} />
      </label>

      <label className={FIELD_LABEL}>
        Opacity ({Math.round(primary.opacity * 100)}%)
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={primary.opacity}
          onChange={(e) => setField("opacity", Number(e.target.value))}
          className={RANGE_INPUT}
        />
      </label>

      <div className="flex gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => onSendToBack(ids)}
          className="flex-1 px-2 py-1.5 rounded-md text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >
          Send to back
        </button>
        <button
          type="button"
          onClick={() => onBringToFront(ids)}
          className="flex-1 px-2 py-1.5 rounded-md text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >
          Bring to front
        </button>
      </div>

      <button
        type="button"
        onClick={() => onDelete(ids)}
        className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
      >
        <IoTrashOutline size={14} /> Delete {images.length > 1 ? "images" : "image"}
      </button>
    </div>
  );
};

export default BoardStylePanel;
