// components/board/BoardStylePanel.tsx
//
// Per-item style controls for the Board editor's current selection - the one property-editing
// surface for every board item (see BoardText's own doc comment in boardTypes.ts for why text
// content itself is edited here too, not in-canvas). Branches on item kind: an all-image selection
// gets the original padding/border/corner-radius/frame-color controls (plus Replace image / Apply
// style to all), an all-text selection gets font/alignment/color/background controls (plus a
// content textarea when exactly one text item is selected - editing shared text across several
// boxes at once doesn't mean anything), and a mixed selection falls back to just the
// kind-independent controls (opacity, front/back, delete).
//
// Visual language: white cards floating on a tinted page background (not everything the same flat
// white BoardEditor.tsx's own toolbar sits on), one restrained neutral icon treatment per section
// header rather than a different accent per card (color stays reserved for what it's actually
// signaling - the kind badge up top, primary actions, destructive ones), and every slider as a
// two-row field (label + value badge, then a full-width track) rather than cramming both onto one
// line - the same "considered system, not just grouped boxes" bar the toolbar redesign set. All
// fields commit immediately on change (no debounce/live-preview split like the image editor's
// brightness/contrast sliders use - these are discrete numeric/color fields, not a continuous drag
// gesture that needs its own pre-commit staging).
import React, { ReactNode } from "react";
import { IoColorFillOutline, IoContrastOutline, IoImageOutline, IoOptionsOutline, IoSwapHorizontalOutline, IoText, IoTrashOutline } from "react-icons/io5";
import { BoardImage, BoardItem, BoardText } from "../../utils/boardTypes";

interface BoardStylePanelProps {
  items: BoardItem[]; // the full selected set - fields showing a mixed value across them just show the first one's
  onChange: (before: BoardItem[], after: BoardItem[]) => void;
  onDelete: (ids: Set<string>) => void;
  onBringToFront: (ids: Set<string>) => void;
  onSendToBack: (ids: Set<string>) => void;
  // "Apply this image's/text's style to every other image/text on the board" - copies everything
  // this panel edits EXCEPT geometry/identity/content onto every other item of the same kind,
  // regardless of selection (see BoardEditor.tsx's handleApplyImageStyleToAll/
  // handleApplyTextStyleToAll for exactly what counts as "style"). Only offered for a single-item
  // selection - "apply THIS one's style" stops meaning anything once several are already selected
  // with potentially different values of their own. `boardImageCount`/`boardTextCount` are the
  // WHOLE board's totals (not just the selection) so the button can hide itself when there's
  // nothing else on the board to apply to.
  onApplyStyleToAllImages: (source: BoardImage) => void;
  onApplyStyleToAllTexts: (source: BoardText) => void;
  boardImageCount: number;
  boardTextCount: number;
  // Swaps the selected image's underlying photo, keeping its position/size/rotation/style exactly
  // as they are (see BoardEditor.tsx's handleReplaceImage) - single-image selection only, same
  // reasoning as onApplyStyleToAllImages above. Also reachable from BoardCanvas.tsx's own
  // right-click menu on a single image tile - this button and that menu item both just call this
  // same prop.
  onReplaceImage: (image: BoardImage) => void;
  isReplacingImage: boolean;
}

// ---- Shared field primitives -------------------------------------------------------------------
// Small building blocks so every card below renders the exact same field shape rather than each
// hand-rolling its own label/value/input markup - what makes the panel read as one system.

// Deliberately no shadow (a shadow on top of an already-tinted page background read as the card
// "bulging out" rather than sitting in it) - just a hairline border a shade lighter than the panel
// background's own tint, enough to separate one section from the next without the card looking
// like a sticker pasted on top.
const CARD = "rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200/60 dark:border-neutral-800/80 p-3.5 flex flex-col gap-3.5";
const SWATCH = "w-8 h-8 rounded-lg cursor-pointer border-2 border-white dark:border-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-700 shadow-sm shrink-0";
const GHOST_BUTTON =
  "px-2.5 py-2 rounded-lg text-xs font-semibold text-neutral-600 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors disabled:opacity-50 disabled:pointer-events-none";
const SEGMENT_ON = "bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400";
const SEGMENT_OFF = "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800";

const SectionHeader: React.FC<{ icon: ReactNode; label: string }> = ({ icon, label }) => (
  <div className="flex items-center gap-2">
    <div className="w-5 h-5 rounded-md flex items-center justify-center bg-neutral-100 dark:bg-neutral-800 text-neutral-400 dark:text-neutral-500">{icon}</div>
    <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">{label}</span>
  </div>
);

const SliderField: React.FC<{ label: string; value: number; display: string; min: number; max: number; step?: number; onChange: (v: number) => void }> = ({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}) => (
  <div className="flex flex-col gap-1.5">
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
      <span className="text-[11px] font-semibold tabular-nums text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded-md">{display}</span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-blue-500" />
  </div>
);

const ColorField: React.FC<{ label: string; value: string; onChange: (v: string) => void; dimmed?: boolean }> = ({ label, value, onChange, dimmed }) => (
  <label className="flex items-center justify-between gap-2">
    <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
    <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className={`${SWATCH} ${dimmed ? "opacity-30" : ""}`} />
  </label>
);

const BoardStylePanel: React.FC<BoardStylePanelProps> = ({
  items,
  onChange,
  onDelete,
  onBringToFront,
  onSendToBack,
  onApplyStyleToAllImages,
  onApplyStyleToAllTexts,
  boardImageCount,
  boardTextCount,
  onReplaceImage,
  isReplacingImage,
}) => {
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
    // pb tracks --docker-height (published by BottomDocker's own ResizeObserver - see
    // Dashboard.tsx's sidebar file list for the same pattern) so the last button (Delete) always
    // scrolls clear of the fixed bottom icon bar instead of rendering underneath it, unclickable -
    // this panel previously had no bottom padding at all, so a selection long enough to need
    // scrolling left Delete permanently hidden behind that bar.
    <div className="w-72 shrink-0 h-full overflow-y-auto overscroll-contain border-l border-neutral-200 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-950/40 p-3.5 pb-[var(--docker-height,64px)] flex flex-col gap-3.5">
      <div className="flex items-center gap-2.5 px-0.5">
        <div
          className={`flex items-center justify-center w-9 h-9 rounded-xl shrink-0 text-white shadow-sm ${
            allText ? "bg-gradient-to-br from-purple-500 to-fuchsia-600" : allImages ? "bg-gradient-to-br from-blue-500 to-indigo-600" : "bg-gradient-to-br from-neutral-500 to-neutral-700"
          }`}
        >
          {allText ? <IoText size={16} /> : <IoImageOutline size={16} />}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100 truncate">
            {items.length > 1 ? `${items.length} items selected` : allText ? "Text" : "Image"}
          </p>
          <p className="text-[11px] text-neutral-400 dark:text-neutral-500">Style &amp; layout</p>
        </div>
      </div>

      {allImages && imageItems.length === 1 && (
        <button
          type="button"
          onClick={() => onReplaceImage(imageItems[0])}
          disabled={isReplacingImage}
          className="flex items-center justify-center gap-1.5 h-10 rounded-xl text-sm font-semibold tracking-tight text-white bg-gradient-to-b from-blue-500 to-blue-600 shadow-[0_1px_2px_rgba(37,99,235,0.35),0_0_0_1px_rgba(37,99,235,0.15)] hover:from-blue-600 hover:to-blue-700 hover:shadow-[0_2px_6px_rgba(37,99,235,0.4)] transition-all disabled:opacity-50 disabled:shadow-none"
        >
          <IoSwapHorizontalOutline size={15} /> {isReplacingImage ? "Replacing…" : "Replace image"}
        </button>
      )}

      {allText && textItems.length === 1 && (
        <div className={CARD}>
          <SectionHeader icon={<IoText size={12} />} label="Content" />
          <textarea
            value={textItems[0].text}
            onChange={(e) => setTextField("text", e.target.value)}
            rows={3}
            placeholder="Type something..."
            className="w-full resize-none rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950/60 px-2.5 py-2 text-sm text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-400 dark:focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 transition-colors"
          />
        </div>
      )}

      {allText && (
        <div className={CARD}>
          <SectionHeader icon={<IoOptionsOutline size={12} />} label="Typography" />

          <SliderField label="Font size" display={`${textItems[0].fontSize}px`} min={10} max={140} value={textItems[0].fontSize} onChange={(v) => setTextField("fontSize", v)} />

          <div className="flex items-center gap-2">
            <div className="inline-flex items-center h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden divide-x divide-neutral-200 dark:divide-neutral-700">
              <button
                type="button"
                title="Bold"
                onClick={() => setTextField("fontWeight", textItems[0].fontWeight === "bold" ? "normal" : "bold")}
                className={`w-9 h-full flex items-center justify-center text-sm font-bold transition-colors ${textItems[0].fontWeight === "bold" ? SEGMENT_ON : SEGMENT_OFF}`}
              >
                B
              </button>
              <button
                type="button"
                title="Italic"
                onClick={() => setTextField("fontStyle", textItems[0].fontStyle === "italic" ? "normal" : "italic")}
                className={`w-9 h-full flex items-center justify-center text-sm italic transition-colors ${textItems[0].fontStyle === "italic" ? SEGMENT_ON : SEGMENT_OFF}`}
              >
                I
              </button>
            </div>

            <div className="inline-flex items-center h-8 flex-1 rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden divide-x divide-neutral-200 dark:divide-neutral-700">
              {(["left", "center", "right"] as const).map((align) => (
                <button
                  key={align}
                  type="button"
                  title={`Align ${align}`}
                  onClick={() => setTextField("textAlign", align)}
                  className={`flex-1 h-full flex items-center justify-center text-[11px] font-medium capitalize transition-colors ${textItems[0].textAlign === align ? SEGMENT_ON : SEGMENT_OFF}`}
                >
                  {align}
                </button>
              ))}
            </div>
          </div>

          <ColorField label="Text color" value={textItems[0].color} onChange={(v) => setTextField("color", v)} />
        </div>
      )}

      {allText && (
        <div className={CARD}>
          <SectionHeader icon={<IoColorFillOutline size={12} />} label="Background" />

          <div className="flex items-center gap-2">
            {/* Same "native color input can't represent no-fill" pattern the board-background/grid
                controls (BoardEditor.tsx) already use. */}
            <input
              type="color"
              value={textItems[0].backgroundColor ?? "#ffffff"}
              onChange={(e) => setTextField("backgroundColor", e.target.value)}
              className={`${SWATCH} ${textItems[0].backgroundColor === null ? "opacity-30" : ""}`}
            />
            <button type="button" onClick={() => setTextField("backgroundColor", textItems[0].backgroundColor === null ? "#ffffff" : null)} className={`flex-1 ${GHOST_BUTTON}`}>
              {textItems[0].backgroundColor === null ? "Add background" : "Remove background"}
            </button>
          </div>

          {textItems[0].backgroundColor !== null && (
            <SliderField
              label="Corner radius"
              display={`${textItems[0].cornerRadius}px`}
              min={0}
              max={100}
              value={textItems[0].cornerRadius}
              onChange={(v) => setTextField("cornerRadius", v)}
            />
          )}

          <SliderField label="Padding" display={`${textItems[0].padding}px`} min={0} max={60} value={textItems[0].padding} onChange={(v) => setTextField("padding", v)} />

          {textItems.length === 1 && boardTextCount > 1 && (
            <button type="button" onClick={() => onApplyStyleToAllTexts(textItems[0])} className={GHOST_BUTTON}>
              Apply style to all text
            </button>
          )}
        </div>
      )}

      {allImages && (
        <div className={CARD}>
          <SectionHeader icon={<IoOptionsOutline size={12} />} label="Frame" />

          <SliderField label="Padding" display={`${imageItems[0].padding}px`} min={0} max={80} value={imageItems[0].padding} onChange={(v) => setImageField("padding", v)} />
          <SliderField label="Border width" display={`${imageItems[0].borderWidth}px`} min={0} max={40} value={imageItems[0].borderWidth} onChange={(v) => setImageField("borderWidth", v)} />
          <ColorField label="Border color" value={imageItems[0].borderColor} onChange={(v) => setImageField("borderColor", v)} />
          <SliderField
            label="Corner radius"
            display={`${imageItems[0].cornerRadius}px`}
            min={0}
            max={200}
            value={imageItems[0].cornerRadius}
            onChange={(v) => setImageField("cornerRadius", v)}
          />
          <ColorField label="Frame color" value={imageItems[0].backgroundColor} onChange={(v) => setImageField("backgroundColor", v)} />

          {imageItems.length === 1 && boardImageCount > 1 && (
            <button type="button" onClick={() => onApplyStyleToAllImages(imageItems[0])} className={GHOST_BUTTON}>
              Apply style to all images
            </button>
          )}
        </div>
      )}

      <div className={CARD}>
        <SectionHeader icon={<IoContrastOutline size={12} />} label="Appearance" />
        <SliderField label="Opacity" display={`${Math.round(primary.opacity * 100)}%`} min={0.1} max={1} step={0.05} value={primary.opacity} onChange={setOpacity} />
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={() => onSendToBack(ids)} className={`flex-1 ${GHOST_BUTTON}`}>
          Send to back
        </button>
        <button type="button" onClick={() => onBringToFront(ids)} className={`flex-1 ${GHOST_BUTTON}`}>
          Bring to front
        </button>
      </div>

      <button
        type="button"
        onClick={() => onDelete(ids)}
        className="flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold text-red-600 dark:text-red-400 border border-red-200 dark:border-red-500/30 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
      >
        <IoTrashOutline size={14} /> Delete {items.length > 1 ? "items" : allText ? "text" : "image"}
      </button>
    </div>
  );
};

export default BoardStylePanel;
