// components/board/BoardStylePanel.tsx
//
// Per-item style controls for the Board editor's current selection - the one property-editing
// surface for every board item (see BoardText's own doc comment in boardTypes.ts for why text
// content itself is edited here too, not in-canvas). Branches on item kind: an all-image selection
// gets the original padding/border/corner-radius/frame-color controls, an all-text selection gets
// font/alignment/color/background controls (plus a content textarea when exactly one text item is
// selected - editing shared text across several boxes at once doesn't mean anything), and a mixed
// selection falls back to just the kind-independent controls (opacity, front/back, delete). All
// fields commit immediately on change (no debounce/live-preview split like the image editor's
// brightness/contrast sliders use - these are discrete numeric/color fields, not a continuous drag
// gesture that needs its own pre-commit staging).
import React from "react";
import { IoTrashOutline } from "react-icons/io5";
import { BoardImage, BoardItem, BoardText } from "../../utils/boardTypes";

interface BoardStylePanelProps {
  items: BoardItem[]; // the full selected set - fields showing a mixed value across them just show the first one's
  onChange: (before: BoardItem[], after: BoardItem[]) => void;
  onDelete: (ids: Set<string>) => void;
  onBringToFront: (ids: Set<string>) => void;
  onSendToBack: (ids: Set<string>) => void;
}

const FIELD_LABEL = "text-xs text-neutral-500 dark:text-neutral-400 flex items-center justify-between gap-2";
const RANGE_INPUT = "w-full accent-blue-500";
const COLOR_INPUT = "w-8 h-8 rounded border border-neutral-300 dark:border-neutral-600 bg-transparent cursor-pointer";
const TOGGLE_BUTTON = "flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors";
const TOGGLE_BUTTON_ON = "bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400";
const TOGGLE_BUTTON_OFF = "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700";

const BoardStylePanel: React.FC<BoardStylePanelProps> = ({ items, onChange, onDelete, onBringToFront, onSendToBack }) => {
  if (items.length === 0) return null;
  const primary = items[0];
  const ids = new Set(items.map((item) => item.id));

  // Narrowed once here rather than re-filtering inline at each field below - also what lets
  // setImageField/setTextField stay fully typed against BoardImage/BoardText instead of casting.
  const imageItems = items.filter((item): item is BoardImage => item.kind === "image");
  const textItems = items.filter((item): item is BoardText => item.kind === "text");
  const allImages = imageItems.length === items.length;
  const allText = textItems.length === items.length;

  const setImageField = <K extends keyof BoardImage>(key: K, value: BoardImage[K]): void => {
    onChange(imageItems, imageItems.map((img) => ({ ...img, [key]: value, updatedAt: Date.now() })));
  };
  const setTextField = <K extends keyof BoardText>(key: K, value: BoardText[K]): void => {
    onChange(textItems, textItems.map((t) => ({ ...t, [key]: value, updatedAt: Date.now() })));
  };
  const setOpacity = (value: number): void => {
    onChange(items, items.map((item) => ({ ...item, opacity: value, updatedAt: Date.now() })));
  };

  return (
    <div className="w-64 shrink-0 h-full overflow-y-auto border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 flex flex-col gap-4">
      <div className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {items.length > 1 ? `${items.length} items selected` : allText ? "Text style" : "Image style"}
      </div>

      {allText && textItems.length === 1 && (
        <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          Text
          <textarea
            value={textItems[0].text}
            onChange={(e) => setTextField("text", e.target.value)}
            rows={3}
            placeholder="Type something..."
            className="w-full resize-none rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-400 dark:focus:border-blue-500"
          />
        </label>
      )}

      {allText && (
        <>
          <label className={FIELD_LABEL}>
            Font size ({textItems[0].fontSize}px)
            <input
              type="range"
              min={10}
              max={140}
              value={textItems[0].fontSize}
              onChange={(e) => setTextField("fontSize", Number(e.target.value))}
              className={RANGE_INPUT}
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              title="Bold"
              onClick={() => setTextField("fontWeight", textItems[0].fontWeight === "bold" ? "normal" : "bold")}
              className={`${TOGGLE_BUTTON} font-bold ${textItems[0].fontWeight === "bold" ? TOGGLE_BUTTON_ON : TOGGLE_BUTTON_OFF}`}
            >
              B
            </button>
            <button
              type="button"
              title="Italic"
              onClick={() => setTextField("fontStyle", textItems[0].fontStyle === "italic" ? "normal" : "italic")}
              className={`${TOGGLE_BUTTON} italic ${textItems[0].fontStyle === "italic" ? TOGGLE_BUTTON_ON : TOGGLE_BUTTON_OFF}`}
            >
              I
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {(["left", "center", "right"] as const).map((align) => (
              <button
                key={align}
                type="button"
                title={`Align ${align}`}
                onClick={() => setTextField("textAlign", align)}
                className={`${TOGGLE_BUTTON} capitalize ${textItems[0].textAlign === align ? TOGGLE_BUTTON_ON : TOGGLE_BUTTON_OFF}`}
              >
                {align}
              </button>
            ))}
          </div>

          <label className="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            Text color
            <input type="color" value={textItems[0].color} onChange={(e) => setTextField("color", e.target.value)} className={COLOR_INPUT} />
          </label>

          <div className="flex items-center gap-2">
            {/* Same "native color input can't represent no-fill" pattern the background panels
                (BoardEditor.tsx's board-background/grid controls) already use. */}
            <input
              type="color"
              value={textItems[0].backgroundColor ?? "#ffffff"}
              onChange={(e) => setTextField("backgroundColor", e.target.value)}
              className={`${COLOR_INPUT} ${textItems[0].backgroundColor === null ? "opacity-30" : ""}`}
            />
            <button
              type="button"
              onClick={() => setTextField("backgroundColor", textItems[0].backgroundColor === null ? "#ffffff" : null)}
              className="flex-1 px-2 py-1.5 rounded-md text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            >
              {textItems[0].backgroundColor === null ? "Add background" : "Remove background"}
            </button>
          </div>

          {textItems[0].backgroundColor !== null && (
            <label className={FIELD_LABEL}>
              Corner radius ({textItems[0].cornerRadius}px)
              <input
                type="range"
                min={0}
                max={100}
                value={textItems[0].cornerRadius}
                onChange={(e) => setTextField("cornerRadius", Number(e.target.value))}
                className={RANGE_INPUT}
              />
            </label>
          )}

          <label className={FIELD_LABEL}>
            Padding ({textItems[0].padding}px)
            <input
              type="range"
              min={0}
              max={60}
              value={textItems[0].padding}
              onChange={(e) => setTextField("padding", Number(e.target.value))}
              className={RANGE_INPUT}
            />
          </label>
        </>
      )}

      {allImages && (
        <>
          <label className={FIELD_LABEL}>
            Padding ({imageItems[0].padding}px)
            <input
              type="range"
              min={0}
              max={80}
              value={imageItems[0].padding}
              onChange={(e) => setImageField("padding", Number(e.target.value))}
              className={RANGE_INPUT}
            />
          </label>

          <label className={FIELD_LABEL}>
            Border width ({imageItems[0].borderWidth}px)
            <input
              type="range"
              min={0}
              max={40}
              value={imageItems[0].borderWidth}
              onChange={(e) => setImageField("borderWidth", Number(e.target.value))}
              className={RANGE_INPUT}
            />
          </label>

          <label className="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            Border color
            <input type="color" value={imageItems[0].borderColor} onChange={(e) => setImageField("borderColor", e.target.value)} className={COLOR_INPUT} />
          </label>

          <label className={FIELD_LABEL}>
            Corner radius ({imageItems[0].cornerRadius}px)
            <input
              type="range"
              min={0}
              max={200}
              value={imageItems[0].cornerRadius}
              onChange={(e) => setImageField("cornerRadius", Number(e.target.value))}
              className={RANGE_INPUT}
            />
          </label>

          <label className="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            Frame color
            <input type="color" value={imageItems[0].backgroundColor} onChange={(e) => setImageField("backgroundColor", e.target.value)} className={COLOR_INPUT} />
          </label>
        </>
      )}

      <label className={FIELD_LABEL}>
        Opacity ({Math.round(primary.opacity * 100)}%)
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={primary.opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
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
        <IoTrashOutline size={14} /> Delete {items.length > 1 ? "items" : allText ? "text" : "image"}
      </button>
    </div>
  );
};

export default BoardStylePanel;
