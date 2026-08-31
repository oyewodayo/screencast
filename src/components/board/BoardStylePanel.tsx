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
import React, { ReactNode, useState } from "react";
import {
  IoChevronBack,
  IoChevronDown,
  IoChevronForward,
  IoChevronUp,
  IoColorFillOutline,
  IoContrastOutline,
  IoCopyOutline,
  IoImageOutline,
  IoEllipseOutline,
  IoLockClosed,
  IoLockOpenOutline,
  IoOptionsOutline,
  IoShapesOutline,
  IoSquareOutline,
  IoSwapHorizontalOutline,
  IoText,
  IoTrashOutline,
} from "react-icons/io5";
import { TbArrowBigRight, TbArrowsMove, TbArrowUpRight, TbBlur, TbHexagon, TbLine, TbOctagon, TbPentagon, TbStar, TbTriangle } from "react-icons/tb";
import { BoardBlur, BoardImage, BoardItem, BoardShadow, BoardShape, BoardText } from "../../utils/boardTypes";
import { BOARD_FONT_GROUPS, BOARD_FONT_OPTIONS } from "../../utils/boardFonts";
import { growTextItemToFitContent } from "../../handlers/boardHandlers";

const DEFAULT_SHADOW: BoardShadow = { blur: 16, offsetX: 0, offsetY: 6, color: "rgba(0,0,0,0.35)" };

// Same shapeType/sides/points parameterization as BoardEditor.tsx's SHAPE_ADD_PRESETS (Triangle/
// Pentagon/Hexagon/Octagon all share the "polygon" shapeType at a different `sides` - see
// BoardShape's own doc comment in boardTypes.ts), but this list SWITCHES the current selection's
// type rather than creating a new item, so it only needs the icon/title/target fields, not a label
// or add-menu group.
const SHAPE_TYPE_PICKS: { icon: ReactNode; title: string; shapeType: BoardShape["shapeType"]; sides?: number; points?: number }[] = [
  { icon: <IoSquareOutline size={14} />, title: "Rectangle", shapeType: "rectangle" },
  { icon: <IoEllipseOutline size={14} />, title: "Ellipse", shapeType: "ellipse" },
  { icon: <TbTriangle size={14} />, title: "Triangle", shapeType: "polygon", sides: 3 },
  { icon: <TbPentagon size={14} />, title: "Pentagon", shapeType: "polygon", sides: 5 },
  { icon: <TbHexagon size={14} />, title: "Hexagon", shapeType: "polygon", sides: 6 },
  { icon: <TbOctagon size={14} />, title: "Octagon", shapeType: "polygon", sides: 8 },
  { icon: <TbStar size={14} />, title: "Star", shapeType: "star", points: 5 },
  { icon: <TbLine size={14} />, title: "Line", shapeType: "line" },
  { icon: <TbArrowUpRight size={14} />, title: "Arrow", shapeType: "arrow" },
  { icon: <TbArrowBigRight size={14} />, title: "Block arrow", shapeType: "block-arrow" },
];

// Which shapeTypes have an interior worth filling - a straight line/arrow has none (see BoardShape's
// own doc comment), everything else does.
const SHAPE_FILL_TYPES: BoardShape["shapeType"][] = ["rectangle", "ellipse", "polygon", "star", "block-arrow"];

// A native <input type="color"> only ever accepts/reports a 6-digit hex - it silently rejects an
// rgba() string outright, which is how DEFAULT_SHADOW's own color (and any shadow color set some
// other way) is stored. Converts just enough to seed the swatch's displayed value; editing through
// the swatch itself then writes back a plain opaque hex, same "no alpha via a plain color input"
// limitation every other ColorField in this panel already has.
function rgbaToHex(color: string): string {
  const match = color.match(/rgba?\(([^)]+)\)/i);
  if (match) {
    const [r, g, b] = match[1].split(",").map((part) => parseFloat(part.trim()));
    if ([r, g, b].every((n) => Number.isFinite(n))) {
      const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }
  }
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#000000";
}

interface BoardStylePanelProps {
  items: BoardItem[]; // the full selected set - fields showing a mixed value across them just show the first one's
  onChange: (before: BoardItem[], after: BoardItem[]) => void;
  onDelete: (ids: Set<string>) => void;
  // Copies every selected item (offset slightly, selects the copies) - see BoardEditor.tsx's
  // handleDuplicateSelected. Also reachable via Ctrl+D and BoardCanvas.tsx's own right-click menu;
  // all three just call this same handler.
  onDuplicate: (ids: Set<string>) => void;
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
  onApplyStyleToAllBlurs: (source: BoardBlur) => void;
  onApplyStyleToAllShapes: (source: BoardShape) => void;
  boardImageCount: number;
  boardTextCount: number;
  boardBlurCount: number;
  boardShapeCount: number;
  // Swaps the selected image's underlying photo, keeping its position/size/rotation/style exactly
  // as they are (see BoardEditor.tsx's handleReplaceImage) - single-image selection only, same
  // reasoning as onApplyStyleToAllImages above. Also reachable from BoardCanvas.tsx's own
  // right-click menu on a single image tile - this button and that menu item both just call this
  // same prop.
  onReplaceImage: (image: BoardImage) => void;
  isReplacingImage: boolean;
  // Moves every selected item by (dx, dy) * step - the same function the keyboard arrow-key handler
  // calls (see BoardEditor.tsx's handleNudge), so a click here and pressing an arrow key always
  // agree on what "nudge" means. Works for any selection regardless of kind - position is the one
  // thing every board item shares, unlike the kind-specific cards below.
  onNudge: (dx: number, dy: number, step: number) => void;
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

// The value badge (e.g. "36px") doubles as a click-to-edit number field - dragging the slider isn't
// precise enough to land on an exact value, so typing one directly is the other half of this
// control, not a separate feature. `isEditingValue`/`draftValue` are local UI state (which mode this
// one field is in right now), not the field's actual value - that still comes from `value`/
// `onChange` same as the slider itself, and both fire on every keystroke for the same real-time
// effect the slider already has, only clamping to [min, max] on commit (blur/Enter) so a value
// typed mid-edit (e.g. "1" on the way to "12") isn't force-clamped before the user finishes typing.
const SliderField: React.FC<{ label: string; value: number; display: string; min: number; max: number; step?: number; onChange: (v: number) => void }> = ({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}) => {
  const [isEditingValue, setIsEditingValue] = useState(false);
  const [draftValue, setDraftValue] = useState("");

  const commit = (raw: string): void => {
    const parsed = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
    setIsEditingValue(false);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
        {isEditingValue ? (
          <input
            type="number"
            autoFocus
            value={draftValue}
            min={min}
            max={max}
            step={step ?? 1}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              setDraftValue(e.target.value);
              const parsed = Number(e.target.value);
              if (e.target.value.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
            }}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.preventDefault();
                setIsEditingValue(false);
              }
            }}
            className="w-14 text-[11px] font-semibold tabular-nums text-neutral-700 dark:text-neutral-200 bg-white dark:bg-neutral-900 border border-blue-300 dark:border-blue-500/50 rounded-md px-1.5 py-0.5 text-right outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraftValue(String(value));
              setIsEditingValue(true);
            }}
            title="Click to type an exact value"
            className="text-[11px] font-semibold tabular-nums text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 px-1.5 py-0.5 rounded-md transition-colors"
          >
            {display}
          </button>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-blue-500" />
    </div>
  );
};

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
  onDuplicate,
  onBringToFront,
  onSendToBack,
  onApplyStyleToAllImages,
  onApplyStyleToAllTexts,
  onApplyStyleToAllBlurs,
  onApplyStyleToAllShapes,
  boardImageCount,
  boardTextCount,
  boardBlurCount,
  boardShapeCount,
  onReplaceImage,
  isReplacingImage,
  onNudge,
}) => {
  if (items.length === 0) return null;
  const primary = items[0];
  const ids = new Set(items.map((item) => item.id));

  // Narrowed once here rather than re-filtering inline at each field below - also what lets
  // setImageField/setTextField/setBlurField/setShapeField stay fully typed against
  // BoardImage/BoardText/BoardBlur/BoardShape instead of casting.
  const imageItems = items.filter((item): item is BoardImage => item.kind === "image");
  const textItems = items.filter((item): item is BoardText => item.kind === "text");
  const blurItems = items.filter((item): item is BoardBlur => item.kind === "blur");
  const shapeItems = items.filter((item): item is BoardShape => item.kind === "shape");
  const allImages = imageItems.length === items.length;
  const allText = textItems.length === items.length;
  const allBlur = blurItems.length === items.length;
  const allShapes = shapeItems.length === items.length;
  const allLocked = items.every((item) => item.locked);
  const kindLabel = allText ? "text" : allBlur ? "blur" : allShapes ? "shape" : "image";

  const setImageField = <K extends keyof BoardImage>(key: K, value: BoardImage[K]): void => {
    onChange(imageItems, imageItems.map((img) => ({ ...img, [key]: value, updatedAt: Date.now() })));
  };
  // growTextItemToFitContent after every field change (not just text/fontSize) - harmless for a
  // field that doesn't affect wrapping (its own grow-only check just finds nothing to grow), and
  // means every path that could make wrapped content taller - font size, font family/weight/style,
  // padding - grows the box automatically without needing its own separate special-cased setter.
  const setTextField = <K extends keyof BoardText>(key: K, value: BoardText[K]): void => {
    onChange(textItems, textItems.map((t) => growTextItemToFitContent({ ...t, [key]: value, updatedAt: Date.now() })));
  };
  const setBlurField = <K extends keyof BoardBlur>(key: K, value: BoardBlur[K]): void => {
    onChange(blurItems, blurItems.map((b) => ({ ...b, [key]: value, updatedAt: Date.now() })));
  };
  const setShapeField = <K extends keyof BoardShape>(key: K, value: BoardShape[K]): void => {
    onChange(shapeItems, shapeItems.map((s) => ({ ...s, [key]: value, updatedAt: Date.now() })));
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
            allText
              ? "bg-gradient-to-br from-purple-500 to-fuchsia-600"
              : allImages
              ? "bg-gradient-to-br from-blue-500 to-indigo-600"
              : allBlur
              ? "bg-gradient-to-br from-slate-500 to-slate-700"
              : allShapes
              ? "bg-gradient-to-br from-emerald-500 to-teal-600"
              : "bg-gradient-to-br from-neutral-500 to-neutral-700"
          }`}
        >
          {allText ? <IoText size={16} /> : allBlur ? <TbBlur size={17} /> : allShapes ? <IoShapesOutline size={16} /> : <IoImageOutline size={16} />}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100 truncate">
            {items.length > 1 ? `${items.length} items selected` : allText ? "Text" : allBlur ? "Blur" : allShapes ? "Shape" : "Image"}
          </p>
          <p className="text-[11px] text-neutral-400 dark:text-neutral-500">Style &amp; layout</p>
        </div>
      </div>

      <div className={CARD}>
        <SectionHeader icon={<TbArrowsMove size={12} />} label="Position" />
        <div className="grid grid-cols-3 grid-rows-3 gap-1 w-28 mx-auto">
          <div />
          <button
            type="button"
            title="Move up (Shift = 10px)"
            onClick={(e) => onNudge(0, -1, e.shiftKey ? 10 : 1)}
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-blue-50 dark:hover:bg-blue-500/15 hover:text-blue-600 dark:hover:text-blue-400 active:scale-95 transition-colors"
          >
            <IoChevronUp size={16} />
          </button>
          <div />

          <button
            type="button"
            title="Move left (Shift = 10px)"
            onClick={(e) => onNudge(-1, 0, e.shiftKey ? 10 : 1)}
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-blue-50 dark:hover:bg-blue-500/15 hover:text-blue-600 dark:hover:text-blue-400 active:scale-95 transition-colors"
          >
            <IoChevronBack size={16} />
          </button>
          <div className="flex items-center justify-center text-neutral-300 dark:text-neutral-700">
            <TbArrowsMove size={14} />
          </div>
          <button
            type="button"
            title="Move right (Shift = 10px)"
            onClick={(e) => onNudge(1, 0, e.shiftKey ? 10 : 1)}
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-blue-50 dark:hover:bg-blue-500/15 hover:text-blue-600 dark:hover:text-blue-400 active:scale-95 transition-colors"
          >
            <IoChevronForward size={16} />
          </button>

          <div />
          <button
            type="button"
            title="Move down (Shift = 10px)"
            onClick={(e) => onNudge(0, 1, e.shiftKey ? 10 : 1)}
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-blue-50 dark:hover:bg-blue-500/15 hover:text-blue-600 dark:hover:text-blue-400 active:scale-95 transition-colors"
          >
            <IoChevronDown size={16} />
          </button>
          <div />
        </div>
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 text-center -mt-1">Hold Shift for 10px steps</p>
      </div>

      {allImages && imageItems.length === 1 && (
        <button
          type="button"
          onClick={() => onReplaceImage(imageItems[0])}
          disabled={isReplacingImage}
          className="flex items-center justify-center gap-1.5 h-10 py-1.5 rounded-xl text-sm font-semibold tracking-tight text-white bg-gradient-to-b from-blue-500 to-blue-600 shadow-[0_1px_2px_rgba(37,99,235,0.35),0_0_0_1px_rgba(37,99,235,0.15)] hover:from-blue-600 hover:to-blue-700 hover:shadow-[0_2px_6px_rgba(37,99,235,0.4)] transition-all disabled:opacity-50 disabled:shadow-none"
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

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Font</span>
            <select
              value={textItems[0].fontFamily}
              onChange={(e) => setTextField("fontFamily", e.target.value)}
              className="w-full h-9 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950/60 text-sm text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-400 dark:focus:border-blue-500 transition-colors"
              style={{ fontFamily: textItems[0].fontFamily }}
            >
              {/* A saved fontFamily string with no matching option (an older board, or edited some
                  other way) still shows as a selectable, selected entry - see boardFonts.ts's
                  boardFontLabel for the same fallback reasoning applied to its label. */}
              {!BOARD_FONT_OPTIONS.some((option) => option.value === textItems[0].fontFamily) && (
                <option value={textItems[0].fontFamily}>{textItems[0].fontFamily}</option>
              )}
              {BOARD_FONT_GROUPS.map((group) => (
                <optgroup key={group} label={group}>
                  {BOARD_FONT_OPTIONS.filter((option) => option.group === group).map((option) => (
                    <option key={option.id} value={option.value} style={{ fontFamily: option.value }}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

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

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setImageField("shadow", imageItems[0].shadow ? undefined : DEFAULT_SHADOW)}
              className={`flex-1 ${GHOST_BUTTON}`}
            >
              {imageItems[0].shadow ? "Remove shadow" : "Add shadow"}
            </button>
          </div>

          {imageItems[0].shadow && (
            <>
              <SliderField
                label="Shadow blur"
                display={`${imageItems[0].shadow.blur}px`}
                min={0}
                max={80}
                value={imageItems[0].shadow.blur}
                onChange={(v) => setImageField("shadow", { ...(imageItems[0].shadow ?? DEFAULT_SHADOW), blur: v })}
              />
              <SliderField
                label="Shadow offset X"
                display={`${imageItems[0].shadow.offsetX}px`}
                min={-60}
                max={60}
                value={imageItems[0].shadow.offsetX}
                onChange={(v) => setImageField("shadow", { ...(imageItems[0].shadow ?? DEFAULT_SHADOW), offsetX: v })}
              />
              <SliderField
                label="Shadow offset Y"
                display={`${imageItems[0].shadow.offsetY}px`}
                min={-60}
                max={60}
                value={imageItems[0].shadow.offsetY}
                onChange={(v) => setImageField("shadow", { ...(imageItems[0].shadow ?? DEFAULT_SHADOW), offsetY: v })}
              />
              <label className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Shadow color</span>
                <input
                  type="color"
                  value={rgbaToHex(imageItems[0].shadow.color)}
                  onChange={(e) => setImageField("shadow", { ...(imageItems[0].shadow ?? DEFAULT_SHADOW), color: e.target.value })}
                  className={SWATCH}
                />
              </label>
            </>
          )}

          {imageItems.length === 1 && boardImageCount > 1 && (
            <button type="button" onClick={() => onApplyStyleToAllImages(imageItems[0])} className={GHOST_BUTTON}>
              Apply style to all images
            </button>
          )}
        </div>
      )}

      {allBlur && (
        <div className={CARD}>
          <SectionHeader icon={<TbBlur size={12} />} label="Blur" />

          <div className="inline-flex items-center h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden divide-x divide-neutral-200 dark:divide-neutral-700">
            {(["blur", "pixelate"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                title={mode === "blur" ? "Soft blur - still somewhat legible underneath" : "Pixelate - hard mosaic blocks, fully obscured"}
                onClick={() => setBlurField("mode", mode)}
                className={`flex-1 h-full flex items-center justify-center text-[11px] font-medium capitalize transition-colors ${
                  (blurItems[0].mode ?? "blur") === mode ? SEGMENT_ON : SEGMENT_OFF
                }`}
              >
                {mode}
              </button>
            ))}
          </div>

          <div className="inline-flex items-center h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden divide-x divide-neutral-200 dark:divide-neutral-700">
            {(["rect", "rounded", "ellipse"] as const).map((shape) => (
              <button
                key={shape}
                type="button"
                title={shape === "rect" ? "Rectangle" : shape === "rounded" ? "Rounded rectangle" : "Ellipse"}
                onClick={() => setBlurField("shape", shape)}
                className={`flex-1 h-full flex items-center justify-center text-[11px] font-medium capitalize transition-colors ${blurItems[0].shape === shape ? SEGMENT_ON : SEGMENT_OFF}`}
              >
                {shape}
              </button>
            ))}
          </div>

          {blurItems[0].shape === "rounded" && (
            <SliderField
              label="Corner radius"
              display={`${blurItems[0].cornerRadius}px`}
              min={0}
              max={200}
              value={blurItems[0].cornerRadius}
              onChange={(v) => setBlurField("cornerRadius", v)}
            />
          )}

          <SliderField
            label={(blurItems[0].mode ?? "blur") === "pixelate" ? "Block size" : "Strength"}
            display={`${blurItems[0].strength}px`}
            min={(blurItems[0].mode ?? "blur") === "pixelate" ? 2 : 0}
            max={(blurItems[0].mode ?? "blur") === "pixelate" ? 80 : 60}
            value={blurItems[0].strength}
            onChange={(v) => setBlurField("strength", v)}
          />

          {blurItems.length === 1 && boardBlurCount > 1 && (
            <button type="button" onClick={() => onApplyStyleToAllBlurs(blurItems[0])} className={GHOST_BUTTON}>
              Apply style to all blur regions
            </button>
          )}
        </div>
      )}

      {allShapes && (
        <div className={CARD}>
          <SectionHeader icon={<IoShapesOutline size={12} />} label="Shape" />

          <div className="grid grid-cols-5 gap-1">
            {SHAPE_TYPE_PICKS.map((pick) => {
              const isActive =
                shapeItems[0].shapeType === pick.shapeType &&
                (pick.sides === undefined || (shapeItems[0].sides ?? 5) === pick.sides) &&
                (pick.points === undefined || (shapeItems[0].points ?? 5) === pick.points);
              return (
                <button
                  key={pick.title}
                  type="button"
                  title={pick.title}
                  onClick={() =>
                    onChange(
                      shapeItems,
                      shapeItems.map((s) => ({
                        ...s,
                        shapeType: pick.shapeType,
                        sides: pick.sides ?? s.sides,
                        points: pick.points ?? s.points,
                        updatedAt: Date.now(),
                      }))
                    )
                  }
                  className={`h-9 flex items-center justify-center rounded-lg border transition-colors ${
                    isActive
                      ? "border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                      : "border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  }`}
                >
                  {pick.icon}
                </button>
              );
            })}
          </div>

          {SHAPE_FILL_TYPES.includes(shapeItems[0].shapeType) && (
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={shapeItems[0].fillColor ?? "#93c5fd"}
                onChange={(e) => setShapeField("fillColor", e.target.value)}
                className={`${SWATCH} ${shapeItems[0].fillColor === null ? "opacity-30" : ""}`}
              />
              <button type="button" onClick={() => setShapeField("fillColor", shapeItems[0].fillColor === null ? "#93c5fd" : null)} className={`flex-1 ${GHOST_BUTTON}`}>
                {shapeItems[0].fillColor === null ? "Add fill" : "Remove fill"}
              </button>
            </div>
          )}

          {shapeItems[0].shapeType === "rectangle" && (
            <SliderField
              label="Corner radius"
              display={`${shapeItems[0].cornerRadius}px`}
              min={0}
              max={200}
              value={shapeItems[0].cornerRadius}
              onChange={(v) => setShapeField("cornerRadius", v)}
            />
          )}

          {shapeItems[0].shapeType === "polygon" && (
            <SliderField label="Sides" display={`${shapeItems[0].sides ?? 5}`} min={3} max={12} value={shapeItems[0].sides ?? 5} onChange={(v) => setShapeField("sides", v)} />
          )}

          {shapeItems[0].shapeType === "star" && (
            <>
              <SliderField label="Points" display={`${shapeItems[0].points ?? 5}`} min={3} max={12} value={shapeItems[0].points ?? 5} onChange={(v) => setShapeField("points", v)} />
              <SliderField
                label="Spike sharpness"
                display={`${Math.round((shapeItems[0].innerRadiusRatio ?? 0.45) * 100)}%`}
                min={0.15}
                max={0.85}
                step={0.01}
                value={shapeItems[0].innerRadiusRatio ?? 0.45}
                onChange={(v) => setShapeField("innerRadiusRatio", v)}
              />
            </>
          )}

          <ColorField label="Stroke color" value={shapeItems[0].strokeColor} onChange={(v) => setShapeField("strokeColor", v)} />
          <SliderField
            label="Stroke width"
            display={`${shapeItems[0].strokeWidth}px`}
            min={0}
            max={40}
            value={shapeItems[0].strokeWidth}
            onChange={(v) => setShapeField("strokeWidth", v)}
          />

          <div className="inline-flex items-center h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden divide-x divide-neutral-200 dark:divide-neutral-700">
            {(["solid", "dashed", "dotted"] as const).map((style) => (
              <button
                key={style}
                type="button"
                onClick={() => setShapeField("strokeStyle", style)}
                className={`flex-1 h-full flex items-center justify-center text-[11px] font-medium capitalize transition-colors ${
                  (shapeItems[0].strokeStyle ?? "solid") === style ? SEGMENT_ON : SEGMENT_OFF
                }`}
              >
                {style}
              </button>
            ))}
          </div>

          {shapeItems.length === 1 && boardShapeCount > 1 && (
            <button type="button" onClick={() => onApplyStyleToAllShapes(shapeItems[0])} className={GHOST_BUTTON}>
              Apply style to all shapes
            </button>
          )}
        </div>
      )}

      <div className={CARD}>
        <SectionHeader icon={<IoContrastOutline size={12} />} label="Appearance" />
        <SliderField label="Opacity" display={`${Math.round(primary.opacity * 100)}%`} min={0.1} max={1} step={0.05} value={primary.opacity} onChange={setOpacity} />
      </div>

      <button
        type="button"
        onClick={() => onChange(items, items.map((item) => ({ ...item, locked: !allLocked, updatedAt: Date.now() })))}
        className={`flex items-center justify-center gap-1.5 ${GHOST_BUTTON}`}
      >
        {allLocked ? <IoLockClosed size={14} /> : <IoLockOpenOutline size={14} />}
        {allLocked ? `Unlock ${items.length > 1 ? "items" : "item"}` : `Lock ${items.length > 1 ? "items" : "item"}`}
      </button>

      <button type="button" onClick={() => onDuplicate(ids)} className={`flex items-center justify-center gap-1.5 ${GHOST_BUTTON}`}>
        <IoCopyOutline size={14} /> Duplicate {items.length > 1 ? "items" : kindLabel}
      </button>

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
        <IoTrashOutline size={14} /> Delete {items.length > 1 ? "items" : kindLabel}
      </button>
    </div>
  );
};

export default BoardStylePanel;
