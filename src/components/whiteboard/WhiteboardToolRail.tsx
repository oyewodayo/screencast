// components/whiteboard/WhiteboardToolRail.tsx
//
// Floating vertical creation dock on the left edge of the Whiteboard canvas (Figma / Miro /
// FigJam spatial model). Includes Shapes, Sticky Note, Text, Mind Map Topic, Connector/Arrow,
// Tapered Pen & Highlighter, Containment Frame, Searchable Vector Icons, Emojis, Maths (LaTeX),
// Image, Format Painter, Laser Pointer, and a 1-click Hide Rail collapse toggle.

import React, { memo, useMemo, useState } from "react";
import {
  IoBrushOutline,
  IoChevronBack,
  IoGitNetworkOutline,
  IoHandLeftOutline,
  IoHappyOutline,
  IoImageOutline,
  IoMapOutline,
  IoPencilOutline,
  IoShapesOutline,
  IoSparklesOutline,
} from "react-icons/io5";
import { TbFrame, TbHighlight, TbNote, TbPointer, TbSum } from "react-icons/tb";
import { WhiteboardShapeType } from "../../utils/whiteboardTypes";
import { searchIcons, StickerIcon } from "../../utils/stickerIcons";
import { EMOJI_CATEGORIES, searchEmoji } from "../../utils/stickerEmoji";
import WhiteboardIconGlyph from "./WhiteboardIconGlyph";
import ColorInput from "../common/ColorInput";

const PEN_COLORS = ["#111111", "#ef4444", "#f97316", "#eab308", "#22c55e", "#2563eb", "#7c3aed", "#ffffff"];
const HIGHLIGHTER_COLORS = ["#fde047", "#86efac", "#93c5fd", "#f9a8d4", "#fdba74", "#c4b5fd"];

interface WhiteboardToolRailProps {
  armedShapeType: WhiteboardShapeType | null;
  armedNodeIsSticky: boolean;
  armedNodeIsFreehandArrow: boolean;
  handArmed: boolean;
  connectorArmed: boolean;
  laserArmed: boolean;
  formatPainterArmed: boolean;
  canFormatPaint: boolean;
  penHighlighter: boolean;
  penColor: string;
  penWidth: number;
  shapesMenuOpen: boolean;
  arrowsMenuOpen: boolean;
  iconsMenuOpen: boolean;
  emojisMenuOpen: boolean;
  shapesPopover: React.ReactNode;
  arrowsPopover: React.ReactNode;
  onSelectTool: () => void;
  onToggleHand: () => void;
  onToggleShapesMenu: (e: React.MouseEvent) => void;
  onArmSticky: () => void;
  onArmText: () => void;
  onArmMindmapTopic: () => void;
  onToggleArrowsMenu: (e: React.MouseEvent) => void;
  onArmPen: (highlighter: boolean) => void;
  onPenColorChange: (color: string) => void;
  onPenWidthChange: (width: number) => void;
  onArmFrame: () => void;
  onToggleIconsMenu: (e: React.MouseEvent) => void;
  onInsertIcon: (icon: StickerIcon) => void;
  onToggleEmojisMenu: (e: React.MouseEvent) => void;
  onInsertEmoji: (emoji: string) => void;
  onInsertImage: () => void;
  onInsertEquation: () => void;
  onToggleFormatPainter: () => void;
  onToggleLaser: () => void;
  onHideRail?: () => void;
}

const RailBtn: React.FC<{
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}> = ({ title, active, disabled, onClick, children }) => (
  <button
    type="button"
    title={title}
    disabled={disabled}
    onClick={onClick}
    className={`relative flex items-center justify-center w-9 h-8 rounded-lg transition-colors disabled:opacity-35 disabled:pointer-events-none ${
      active
        ? "bg-blue-600 text-white shadow-sm"
        : "text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800"
    }`}
  >
    {children}
  </button>
);

const Divider = () => <div className="w-5 h-px bg-gray-200 dark:bg-neutral-700/80 my-0.5 self-center" />;

const WhiteboardToolRail: React.FC<WhiteboardToolRailProps> = memo(
  ({
    armedShapeType,
    armedNodeIsSticky,
    armedNodeIsFreehandArrow,
    handArmed,
    connectorArmed,
    laserArmed,
    formatPainterArmed,
    canFormatPaint,
    penHighlighter,
    penColor,
    penWidth,
    shapesMenuOpen,
    arrowsMenuOpen,
    iconsMenuOpen,
    emojisMenuOpen,
    shapesPopover,
    arrowsPopover,
    onSelectTool,
    onToggleHand,
    onToggleShapesMenu,
    onArmSticky,
    onArmText,
    onArmMindmapTopic,
    onToggleArrowsMenu,
    onArmPen,
    onPenColorChange,
    onPenWidthChange,
    onArmFrame,
    onToggleIconsMenu,
    onInsertIcon,
    onToggleEmojisMenu,
    onInsertEmoji,
    onInsertImage,
    onInsertEquation,
    onToggleFormatPainter,
    onToggleLaser,
    onHideRail,
  }) => {
    const [iconQuery, setIconQuery] = useState("");
    const [emojiQuery, setEmojiQuery] = useState("");
    const [emojiCat, setEmojiCat] = useState(0);

    const filteredIcons = useMemo(
      () => (iconsMenuOpen ? searchIcons(iconQuery).filter((i) => i.value !== "none") : []),
      [iconsMenuOpen, iconQuery]
    );

    const filteredEmojis = useMemo(() => {
      if (!emojisMenuOpen) return [];
      if (emojiQuery.trim()) return searchEmoji(emojiQuery);
      return EMOJI_CATEGORIES[emojiCat]?.items ?? [];
    }, [emojisMenuOpen, emojiQuery, emojiCat]);

    const selectActive =
      armedShapeType === null &&
      !handArmed &&
      !connectorArmed &&
      !laserArmed &&
      !formatPainterArmed &&
      !shapesMenuOpen &&
      !arrowsMenuOpen &&
      !iconsMenuOpen &&
      !emojisMenuOpen;

    const penActive = armedShapeType === "freehand" && !armedNodeIsFreehandArrow;
    const shapesActive =
      shapesMenuOpen ||
      (armedShapeType !== null &&
        armedShapeType !== "text" &&
        armedShapeType !== "freehand" &&
        armedShapeType !== "artboard" &&
        armedShapeType !== "equation" &&
        armedShapeType !== "mindmapTopic" &&
        armedShapeType !== "icon" &&
        !armedNodeIsSticky);

    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute left-3 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-0.5 p-1 rounded-xl bg-white dark:bg-neutral-900 border border-gray-200/90 dark:border-neutral-700/90 shadow-lg select-none"
      >
        <RailBtn title="Select (V)" active={selectActive} onClick={onSelectTool}>
          <TbPointer size={17} />
        </RailBtn>
        <RailBtn title="Hand / Pan (H or Space)" active={handArmed} onClick={onToggleHand}>
          <IoHandLeftOutline size={16} />
        </RailBtn>

        <Divider />

        <div className="relative">
          <RailBtn title="Shapes (R, O, D)" active={shapesActive} onClick={onToggleShapesMenu}>
            <IoShapesOutline size={17} />
          </RailBtn>
          {shapesMenuOpen && shapesPopover}
        </div>
        <RailBtn title="Sticky Note (S)" active={armedNodeIsSticky} onClick={onArmSticky}>
          <TbNote size={17} />
        </RailBtn>
        <RailBtn title="Text (T)" active={armedShapeType === "text"} onClick={onArmText}>
          <span className="font-semibold text-[14px] leading-none">T</span>
        </RailBtn>
        <RailBtn title="Mind Map Topic (M)" active={armedShapeType === "mindmapTopic"} onClick={onArmMindmapTopic}>
          <IoMapOutline size={17} />
        </RailBtn>
        <div className="relative">
          <RailBtn
            title="Connector / Arrow (L)"
            active={arrowsMenuOpen || connectorArmed || armedNodeIsFreehandArrow}
            onClick={onToggleArrowsMenu}
          >
            <IoGitNetworkOutline size={17} />
          </RailBtn>
          {arrowsMenuOpen && arrowsPopover}
        </div>

        <div className="relative">
          <RailBtn
            title={penHighlighter ? "Highlighter (P)" : "Pen (P)"}
            active={penActive}
            onClick={() => onArmPen(penHighlighter)}
          >
            {penHighlighter ? <TbHighlight size={17} /> : <IoPencilOutline size={16} />}
            <span
              className="absolute bottom-1 right-1 w-2 h-2 rounded-full ring-1 ring-white dark:ring-neutral-900"
              style={{ backgroundColor: penColor }}
            />
          </RailBtn>
          {penActive && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute left-full top-0 ml-2 w-[212px] bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-xl shadow-xl p-2.5 z-30 flex flex-col gap-2.5"
            >
              <div className="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-gray-100 dark:bg-neutral-900">
                <button
                  type="button"
                  onClick={() => onArmPen(false)}
                  className={`flex items-center justify-center gap-1 h-7 rounded-md text-xs font-medium transition-colors ${
                    !penHighlighter
                      ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                      : "text-gray-500 dark:text-neutral-400"
                  }`}
                >
                  <IoPencilOutline size={13} /> Pen
                </button>
                <button
                  type="button"
                  onClick={() => onArmPen(true)}
                  className={`flex items-center justify-center gap-1 h-7 rounded-md text-xs font-medium transition-colors ${
                    penHighlighter
                      ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                      : "text-gray-500 dark:text-neutral-400"
                  }`}
                >
                  <TbHighlight size={14} /> Marker
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(penHighlighter ? HIGHLIGHTER_COLORS : PEN_COLORS).map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    onClick={() => onPenColorChange(c)}
                    className={`w-5 h-5 rounded-full ring-1 ring-inset ring-black/15 ${
                      penColor.toLowerCase() === c ? "outline outline-2 outline-offset-1 outline-blue-500" : ""
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <label
                  className="relative w-5 h-5 rounded-full overflow-hidden ring-1 ring-inset ring-black/15 cursor-pointer"
                  title="Custom ink color"
                  style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}
                >
                  <ColorInput
                    value={penColor}
                    onChange={(e) => onPenColorChange(e.target.value)}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                </label>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-neutral-400">
                <span>Size</span>
                <input
                  type="range"
                  min={penHighlighter ? 10 : 1.5}
                  max={penHighlighter ? 36 : 16}
                  step={0.5}
                  value={penWidth}
                  onChange={(e) => onPenWidthChange(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="w-6 text-right tabular-nums">{penWidth}</span>
              </div>
            </div>
          )}
        </div>

        <RailBtn title="Containment Frame / Slide (F)" active={armedShapeType === "artboard"} onClick={onArmFrame}>
          <TbFrame size={17} />
        </RailBtn>

        <Divider />

        {/* Vector Icons Picker */}
        <div className="relative">
          <RailBtn title="Icons" active={iconsMenuOpen} onClick={onToggleIconsMenu}>
            <IoSparklesOutline size={16} />
          </RailBtn>
          {iconsMenuOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute left-full top-1/2 -translate-y-1/2 ml-2 w-[272px] bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 rounded-xl shadow-2xl p-2.5 z-30 flex flex-col gap-2"
            >
              <input
                autoFocus
                type="text"
                value={iconQuery}
                onChange={(e) => setIconQuery(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && filteredIcons.length > 0) {
                    onInsertIcon(filteredIcons[0].value as StickerIcon);
                    setIconQuery("");
                  }
                }}
                placeholder="Find an icon — Enter adds the first"
                className="w-full h-8 px-2.5 rounded-lg border border-blue-400/70 bg-gray-50 dark:bg-neutral-800 text-xs text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-500"
              />
              <div className="grid grid-cols-6 gap-1 max-h-[260px] overflow-y-auto [scrollbar-width:thin] pr-0.5">
                {filteredIcons.map((ic) => (
                  <button
                    key={ic.value}
                    type="button"
                    title={ic.label}
                    onClick={() => {
                      onInsertIcon(ic.value as StickerIcon);
                      setIconQuery("");
                    }}
                    className="h-9 rounded-lg flex items-center justify-center p-2 bg-gray-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-blue-600 hover:text-white transition-colors"
                  >
                    <WhiteboardIconGlyph icon={ic.value} size={18} />
                  </button>
                ))}
                {filteredIcons.length === 0 && (
                  <p className="col-span-6 py-4 text-center text-xs text-gray-400">No matching icons</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Emojis Picker */}
        <div className="relative">
          <RailBtn title="Emojis" active={emojisMenuOpen} onClick={onToggleEmojisMenu}>
            <IoHappyOutline size={17} />
          </RailBtn>
          {emojisMenuOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute left-full top-1/2 -translate-y-1/2 ml-2 w-[288px] bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 rounded-xl shadow-2xl p-2.5 z-30 flex flex-col gap-2"
            >
              <input
                autoFocus
                type="text"
                value={emojiQuery}
                onChange={(e) => setEmojiQuery(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && filteredEmojis.length > 0) {
                    onInsertEmoji(filteredEmojis[0].char);
                    setEmojiQuery("");
                  }
                }}
                placeholder="Search emoji — Enter adds the first"
                className="w-full h-8 px-2.5 rounded-lg border border-blue-400/70 bg-gray-50 dark:bg-neutral-800 text-xs text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-500"
              />
              {!emojiQuery.trim() && (
                <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] pb-0.5">
                  {EMOJI_CATEGORIES.map((cat, idx) => (
                    <button
                      key={cat.label}
                      type="button"
                      onClick={() => setEmojiCat(idx)}
                      className={`px-2 py-0.5 rounded-md text-[10px] font-medium shrink-0 transition-colors ${
                        emojiCat === idx
                          ? "bg-blue-600 text-white"
                          : "bg-gray-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700"
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-7 gap-1 max-h-[240px] overflow-y-auto [scrollbar-width:thin] pr-0.5">
                {filteredEmojis.map((em) => (
                  <button
                    key={em.char + em.words}
                    type="button"
                    title={em.words}
                    onClick={() => {
                      onInsertEmoji(em.char);
                      setEmojiQuery("");
                    }}
                    className="h-9 rounded-lg flex items-center justify-center text-[20px] hover:bg-gray-100 dark:hover:bg-neutral-800 active:scale-90 transition-transform"
                  >
                    {em.char}
                  </button>
                ))}
                {filteredEmojis.length === 0 && (
                  <p className="col-span-7 py-4 text-center text-xs text-gray-400">No matching emojis</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Rich Maths (LaTeX) Equation */}
        <RailBtn title="Maths / Equation (LaTeX) — renders live as you type" active={armedShapeType === "equation"} onClick={onInsertEquation}>
          <TbSum size={18} />
        </RailBtn>

        <RailBtn title="Insert Image" onClick={onInsertImage}>
          <IoImageOutline size={16} />
        </RailBtn>
        <RailBtn
          title={formatPainterArmed ? "Click a shape to paste copied style (Esc to cancel)" : "Format Painter (Ctrl+Alt+C / V)"}
          active={formatPainterArmed}
          disabled={!canFormatPaint && !formatPainterArmed}
          onClick={onToggleFormatPainter}
        >
          <IoBrushOutline size={15} />
        </RailBtn>
        <RailBtn title="Laser Pointer" active={laserArmed} onClick={onToggleLaser}>
          <span className="relative flex items-center justify-center w-4 h-4">
            <span className={`w-2 h-2 rounded-full ${laserArmed ? "bg-white" : "bg-red-500"}`} />
            <span className={`absolute inset-0 rounded-full border ${laserArmed ? "border-white/70" : "border-red-400/70"}`} />
          </span>
        </RailBtn>

        {onHideRail && (
          <>
            <Divider />
            <button
              type="button"
              title="Hide tools (Ctrl+\)"
              onClick={onHideRail}
              className="flex items-center justify-center w-9 h-6 rounded-lg text-neutral-400 dark:text-neutral-500 hover:bg-gray-100 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
            >
              <IoChevronBack size={14} />
            </button>
          </>
        )}
      </div>
    );
  }
);

WhiteboardToolRail.displayName = "WhiteboardToolRail";

export default WhiteboardToolRail;
