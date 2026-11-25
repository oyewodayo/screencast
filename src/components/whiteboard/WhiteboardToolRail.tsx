// components/whiteboard/WhiteboardToolRail.tsx
//
// Floating vertical creation dock on the left edge of the Whiteboard canvas (Figma / Miro /
// FigJam spatial model). De-crowds the top bar and promotes Sticky Note, Mind Map Topic,
// Hand/Pan, Pen & Highlighter, and Containment Frame to first-class 1-click tools.

import React, { memo } from "react";
import {
  IoBrushOutline,
  IoCalculatorOutline,
  IoGitNetworkOutline,
  IoHandLeftOutline,
  IoImageOutline,
  IoMapOutline,
  IoPencilOutline,
  IoShapesOutline,
} from "react-icons/io5";
import { TbFrame, TbHighlight, TbNote, TbPointer } from "react-icons/tb";
import { WhiteboardShapeType } from "../../utils/whiteboardTypes";
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
  onInsertImage: () => void;
  onArmEquation: () => void;
  onToggleFormatPainter: () => void;
  onToggleLaser: () => void;
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
    className={`relative flex items-center justify-center w-9 h-9 rounded-lg transition-colors disabled:opacity-35 disabled:pointer-events-none ${
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
    onInsertImage,
    onArmEquation,
    onToggleFormatPainter,
    onToggleLaser,
  }) => {
    const isSelectActive =
      !handArmed && !armedShapeType && !connectorArmed && !laserArmed && !formatPainterArmed;
    const isPenMode = armedShapeType === "freehand" && !armedNodeIsFreehandArrow;
    const isGenericShapeArmed =
      armedShapeType !== null &&
      armedShapeType !== "text" &&
      armedShapeType !== "equation" &&
      armedShapeType !== "freehand" &&
      armedShapeType !== "artboard" &&
      armedShapeType !== "mindmapTopic" &&
      !armedNodeIsSticky;

    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute left-3 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-0.5 p-1 rounded-xl bg-white dark:bg-neutral-900 border border-gray-200/90 dark:border-neutral-700/90 shadow-lg select-none"
      >
        <RailBtn title="Select (V)" active={isSelectActive} onClick={onSelectTool}>
          <TbPointer size={18} />
        </RailBtn>
        <RailBtn title="Hand / Pan (H · or hold Space)" active={handArmed} onClick={onToggleHand}>
          <IoHandLeftOutline size={17} />
        </RailBtn>

        <Divider />

        <div className="relative">
          <RailBtn title="Shapes (R · O · D)" active={isGenericShapeArmed || shapesMenuOpen} onClick={onToggleShapesMenu}>
            <IoShapesOutline size={18} />
          </RailBtn>
          {shapesMenuOpen && shapesPopover}
        </div>

        <RailBtn title="Sticky Note (S)" active={armedNodeIsSticky} onClick={onArmSticky}>
          <TbNote size={18} />
        </RailBtn>
        <RailBtn title="Text (T)" active={armedShapeType === "text"} onClick={onArmText}>
          <span className="font-semibold text-[15px] leading-none">T</span>
        </RailBtn>
        <RailBtn title="Mind Map Topic (M)" active={armedShapeType === "mindmapTopic"} onClick={onArmMindmapTopic}>
          <IoMapOutline size={17} />
        </RailBtn>

        <div className="relative">
          <RailBtn
            title="Connector / Arrow (L)"
            active={connectorArmed || armedNodeIsFreehandArrow || arrowsMenuOpen}
            onClick={onToggleArrowsMenu}
          >
            <IoGitNetworkOutline size={17} />
          </RailBtn>
          {arrowsMenuOpen && arrowsPopover}
        </div>

        <div className="relative">
          <RailBtn
            title={penHighlighter ? "Highlighter (P)" : "Tapered Pen (P)"}
            active={isPenMode}
            onClick={() => onArmPen(penHighlighter)}
          >
            {penHighlighter ? <TbHighlight size={18} /> : <IoPencilOutline size={17} />}
          </RailBtn>
          {isPenMode && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute left-full top-0 ml-2 w-[214px] bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 rounded-xl shadow-xl p-2.5 z-30 flex flex-col gap-2.5"
            >
              {/* Pen vs Highlighter toggle */}
              <div className="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-gray-100 dark:bg-neutral-800">
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
          <TbFrame size={18} />
        </RailBtn>

        <Divider />

        <RailBtn title="Insert Image" onClick={onInsertImage}>
          <IoImageOutline size={17} />
        </RailBtn>
        <RailBtn title="Equation (LaTeX)" active={armedShapeType === "equation"} onClick={onArmEquation}>
          <IoCalculatorOutline size={17} />
        </RailBtn>
        <RailBtn
          title={formatPainterArmed ? "Click a shape to paste copied style (Esc to cancel)" : "Format Painter (Ctrl+Alt+C / V)"}
          active={formatPainterArmed}
          disabled={!canFormatPaint && !formatPainterArmed}
          onClick={onToggleFormatPainter}
        >
          <IoBrushOutline size={16} />
        </RailBtn>
        <RailBtn title="Laser Pointer" active={laserArmed} onClick={onToggleLaser}>
          <span className="relative flex items-center justify-center w-4 h-4">
            <span className={`w-2 h-2 rounded-full ${laserArmed ? "bg-white" : "bg-red-500"}`} />
            <span className={`absolute inset-0 rounded-full border ${laserArmed ? "border-white/70" : "border-red-400/70"}`} />
          </span>
        </RailBtn>
      </div>
    );
  }
);

WhiteboardToolRail.displayName = "WhiteboardToolRail";

export default WhiteboardToolRail;
