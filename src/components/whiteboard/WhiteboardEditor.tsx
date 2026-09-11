// components/whiteboard/WhiteboardEditor.tsx
//
// Top-level Whiteboard editing surface - the Whiteboard feature's counterpart to BoardEditor.tsx.
// Owns the useWhiteboardStore instance, selection state, and view state (zoom/pan - Board has no
// pan since its canvas is a fixed-size buffer, but an infinite diagramming canvas needs one); wires
// the toolbar, the page tab strip, WhiteboardCanvas, and WhiteboardStylePanel together, and runs
// the two IO actions that aren't part of the store's own load/edit/autosave lifecycle: exporting a
// flattened PNG of the current page and saving the home-grid thumbnail on the way back out.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
// Global (loaded once for the whole whiteboard feature, not per-node) - the math glyph fonts/spacing
// rules "equation" nodes need, in both WhiteboardCanvas.tsx's live KaTeX rendering and
// whiteboardHandlers.ts's PNG-export rasterization (which relies on this already being loaded in the
// document by the time it runs - see paintEquation's own doc comment).
import "katex/dist/katex.min.css";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import {
  IoAdd,
  IoArrowBack,
  IoArrowRedo,
  IoArrowUndo,
  IoCalculatorOutline,
  IoChevronBack,
  IoChevronDown,
  IoChevronForward,
  IoContractOutline,
  IoCopyOutline,
  IoDownloadOutline,
  IoGitNetworkOutline,
  IoGridOutline,
  IoImageOutline,
  IoMagnetOutline,
  IoPencilOutline,
  IoRemove,
  IoShapesOutline,
  IoTrashOutline,
} from "react-icons/io5";
import { TbPointer } from "react-icons/tb";
import useWhiteboardStore from "../../hooks/useWhiteboardStore";
import { ArrowheadType, LINE_ONLY_SHAPES, WhiteboardAnchorSide, WhiteboardEdge, WhiteboardNode, WhiteboardPage, WhiteboardShapeType } from "../../utils/whiteboardTypes";
import { canvasToPngBytes } from "../../handlers/pdfExportHandlers";
import { computeContentBounds, renderWhiteboardToCanvas, shapeOutlineFor, CYLINDER_CAP_RATIO } from "../../handlers/whiteboardHandlers";
import WhiteboardCanvas, { WhiteboardCanvasHandle } from "./WhiteboardCanvas";
import WhiteboardStylePanel from "./WhiteboardStylePanel";

const THUMBNAIL_MAX_DIMENSION = 480;

interface WhiteboardEditorProps {
  whiteboardId: string;
  onBack: () => void;
}

interface ShapePreset {
  type: WhiteboardShapeType;
  label: string;
  overrides?: Partial<WhiteboardNode>;
}

// One tile per palette entry - shown in the toolbar's "Shapes" popover, grouped into labeled
// sections (SHAPE_PRESET_GROUPS below) rather than one long flat grid, now that the palette has
// grown past basic flowchart shapes. "Rounded Rectangle" is not its own shapeType (see
// whiteboardTypes.ts's WhiteboardNode.cornerRadius doc comment) - it's a plain rectangle with a
// nonzero cornerRadius override applied at creation time; "Pentagon"/"Octagon" are likewise just
// "polygon" at a different `sides`.
const BASIC_SHAPE_PRESETS: ShapePreset[] = [
  { type: "rectangle", label: "Rectangle" },
  { type: "rectangle", label: "Rounded", overrides: { cornerRadius: 16 } },
  { type: "ellipse", label: "Ellipse" },
  { type: "diamond", label: "Diamond" },
  { type: "triangle", label: "Triangle" },
  { type: "hexagon", label: "Hexagon" },
  { type: "polygon", label: "Pentagon", overrides: { sides: 5 } },
  { type: "polygon", label: "Octagon", overrides: { sides: 8 } },
  { type: "star", label: "Star" },
  { type: "parallelogram", label: "Parallelogram" },
  { type: "trapezoid", label: "Trapezoid" },
  { type: "cross", label: "Cross" },
  { type: "cylinder", label: "Cylinder" },
  { type: "cube", label: "Cube" },
  { type: "cloud", label: "Cloud" },
  { type: "document", label: "Document" },
  { type: "note", label: "Note" },
  { type: "callout", label: "Callout" },
  { type: "step", label: "Step" },
];

const WAVE_SHAPE_PRESETS: ShapePreset[] = [
  { type: "wave", label: "Sine Wave", overrides: { waveStyle: "sine" } },
  { type: "wave", label: "Cosine Wave", overrides: { waveStyle: "cosine" } },
  { type: "wave", label: "Square Wave", overrides: { waveStyle: "square" } },
  { type: "wave", label: "Triangle Wave", overrides: { waveStyle: "triangle" } },
  { type: "wave", label: "Sawtooth Wave", overrides: { waveStyle: "sawtooth" } },
];

const SCIENCE_SHAPE_PRESETS: ShapePreset[] = [
  { type: "resistor", label: "Resistor" },
  { type: "capacitor", label: "Capacitor" },
  { type: "battery", label: "Battery" },
  { type: "diode", label: "Diode" },
  { type: "inductor", label: "Inductor" },
  { type: "ground", label: "Ground" },
  { type: "amplifier", label: "Amplifier" },
  { type: "spring", label: "Spring/Coil" },
  { type: "flask", label: "Flask" },
  { type: "beaker", label: "Beaker" },
  { type: "benzeneRing", label: "Benzene Ring" },
  { type: "bondLine", label: "Bond-Line Chain", overrides: { sides: 5 } },
  { type: "axes", label: "Axes" },
  { type: "angle", label: "Angle" },
  { type: "vector", label: "Vector Arrow" },
  { type: "unitCircle", label: "Unit Circle" },
  { type: "numberLine", label: "Number Line" },
];

const GENERAL_SHAPE_PRESETS: ShapePreset[] = [
  { type: "star", label: "4-Point Star", overrides: { starPoints: 4 } },
  { type: "star", label: "8-Point Star", overrides: { starPoints: 8 } },
  { type: "hourglass", label: "Hourglass" },
  { type: "teardrop", label: "Teardrop" },
  { type: "lightningBolt", label: "Lightning Bolt" },
  { type: "halfCircle", label: "Half Circle" },
  { type: "banner", label: "Banner" },
  { type: "frame", label: "Frame" },
  { type: "tape", label: "Tape" },
  { type: "display", label: "Display" },
  { type: "predefinedProcess", label: "Predefined Process" },
  { type: "manualInput", label: "Manual Input" },
  { type: "internalStorage", label: "Internal Storage" },
];

const CHART_SHAPE_PRESETS: ShapePreset[] = [
  { type: "barChart", label: "Bar Chart" },
  { type: "lineChart", label: "Line Chart" },
  { type: "pieChart", label: "Pie Chart" },
  { type: "scatterPlot", label: "Scatter Plot" },
  { type: "functionPlot", label: "Linear Plot", overrides: { plotFunction: "linear" } },
  { type: "functionPlot", label: "Quadratic Plot", overrides: { plotFunction: "quadratic" } },
  { type: "functionPlot", label: "Cubic Plot", overrides: { plotFunction: "cubic" } },
  { type: "functionPlot", label: "Sine Plot", overrides: { plotFunction: "sine" } },
  { type: "functionPlot", label: "Cosine Plot", overrides: { plotFunction: "cosine" } },
  { type: "functionPlot", label: "Exponential Plot", overrides: { plotFunction: "exponential" } },
  { type: "functionPlot", label: "Square Root Plot", overrides: { plotFunction: "sqrt" } },
  { type: "functionPlot", label: "Logarithm Plot", overrides: { plotFunction: "logarithm" } },
  { type: "functionPlot", label: "Absolute Value Plot", overrides: { plotFunction: "absolute" } },
  { type: "functionPlot", label: "Normal Distribution", overrides: { plotFunction: "normal" } },
];

// Just the one preset for now - unlike every other group, a "latticeGauge" node has no size/style
// variants worth offering as separate tiles (its own on-canvas control panel is where N, spacing,
// and every other knob actually live - see LatticeGaugeWidget.tsx).
const PHYSICS_3D_SHAPE_PRESETS: ShapePreset[] = [{ type: "latticeGauge", label: "Lattice Gauge Theory" }];

const SHAPE_PRESET_GROUPS: { label: string; presets: ShapePreset[] }[] = [
  { label: "Basic", presets: BASIC_SHAPE_PRESETS },
  { label: "General", presets: GENERAL_SHAPE_PRESETS },
  { label: "Waveforms", presets: WAVE_SHAPE_PRESETS },
  { label: "Science", presets: SCIENCE_SHAPE_PRESETS },
  { label: "Charts & Plots", presets: CHART_SHAPE_PRESETS },
  { label: "Physics 3D", presets: PHYSICS_3D_SHAPE_PRESETS },
];

const TILE_W = 44;
const TILE_H = 32;

// Renders a small preview of a shape preset using the exact same geometry decision
// (shapeOutlineFor) the real canvas draws with, rather than a hand-picked icon that could drift
// out of sync with what clicking the tile actually produces.
function ShapePresetPreview({ preset }: { preset: ShapePreset }) {
  const w = TILE_W - 4;
  const h = TILE_H - 4;
  const outline = shapeOutlineFor(preset.type, w, h, {
    sides: preset.overrides?.sides,
    starPoints: preset.overrides?.starPoints,
    starInnerRadiusRatio: preset.overrides?.starInnerRadiusRatio,
    waveStyle: preset.overrides?.waveStyle,
    waveCycles: preset.overrides?.waveCycles,
    angleDegrees: preset.overrides?.angleDegrees,
    angleRay1Length: preset.overrides?.angleRay1Length,
    angleRay2Length: preset.overrides?.angleRay2Length,
    chartData: preset.overrides?.chartData,
    plotFunction: preset.overrides?.plotFunction,
    plotDomainScale: preset.overrides?.plotDomainScale,
    plotCycles: preset.overrides?.plotCycles,
    plotShowGrid: preset.overrides?.plotShowGrid,
    numberLineMax: preset.overrides?.numberLineMax,
  });
  // Line-only shapes (waves, circuit symbols, axes...) render as an open trace, not a filled
  // silhouette (matches their own default fillColor: null) - filling the preview swatch would shade
  // the implicit-close area under the trace instead of just showing the line shape the tile places.
  // Fill is a light gray rather than the real default (white - see createDefaultWhiteboardNode)
  // purely so the swatch stays visible against this popover's own white background; the stroke
  // does match the real black default, since that's the part actually worth previewing accurately.
  const fill = LINE_ONLY_SHAPES.has(preset.type) ? "none" : "#f3f4f6";
  const stroke = "#000000";
  // Thinner and miter-jointed (sharp corners) rather than the real canvas's own strokeWidth/round
  // joins - at this tile's ~40x28px size a 2px round-jointed stroke reads as a heavy, bulbous
  // outline (a plain triangle looks like it has rounded corners purely from the stroke thickness),
  // out of proportion to how the shape actually renders once placed at normal size.
  const sw = 1.25;
  return (
    <svg width={TILE_W} height={TILE_H} viewBox={`0 0 ${TILE_W} ${TILE_H}`}>
      <g transform="translate(2,2)">
        {outline.kind === "rect" && <rect x={0} y={0} width={w} height={h} rx={preset.overrides?.cornerRadius ?? 0} fill={fill} stroke={stroke} strokeWidth={sw} />}
        {outline.kind === "ellipse" && <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={sw} />}
        {outline.kind === "polygon" && (
          <>
            <polygon points={outline.points.map(([x, y]) => `${x},${y}`).join(" ")} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="miter" />
            {outline.innerLines?.map((line, i) => (
              <polyline key={i} points={line.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
            ))}
            {outline.innerCircle && <circle cx={outline.innerCircle.cx} cy={outline.innerCircle.cy} r={outline.innerCircle.r} fill="none" stroke={stroke} strokeWidth={sw} />}
          </>
        )}
        {outline.kind === "path" && <path d={outline.d} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="miter" />}
        {outline.kind === "cylinder" && (
          <>
            <path
              d={`M0,${h * CYLINDER_CAP_RATIO} L0,${h * (1 - CYLINDER_CAP_RATIO)} A${w / 2},${h * CYLINDER_CAP_RATIO} 0 0,0 ${w},${h * (1 - CYLINDER_CAP_RATIO)} L${w},${h * CYLINDER_CAP_RATIO} Z`}
              fill={fill}
              stroke={stroke}
              strokeWidth={sw}
            />
            <ellipse cx={w / 2} cy={h * CYLINDER_CAP_RATIO} rx={w / 2} ry={h * CYLINDER_CAP_RATIO} fill={fill} stroke={stroke} strokeWidth={sw} />
          </>
        )}
        {outline.kind === "chart" &&
          outline.parts.map((part, i) =>
            part.role === "fill" ? (
              <path key={i} d={part.d} fill={fill} stroke="none" />
            ) : part.role === "marker" ? (
              <path key={i} d={part.d} fill={stroke} stroke="none" />
            ) : part.role === "slice" ? (
              <path key={i} d={part.d} fill={part.color} stroke="#ffffff" strokeWidth={sw} />
            ) : part.role === "axis" ? (
              <path key={i} d={part.d} fill="none" stroke="#9ca3af" strokeWidth={sw} />
            ) : part.role === "grid" ? (
              <path key={i} d={part.d} fill="none" stroke="#e5e7eb" strokeWidth={sw * 0.75} />
            ) : (
              <path key={i} d={part.d} fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
            )
          )}
      </g>
    </svg>
  );
}

// One tile per palette entry - shown in the toolbar's "Arrows" popover. "connector" presets draw a
// real edge (attaches to shapes it starts/ends on, re-routes as they move, editable afterward in
// the style panel); "freehand" is the one exception - a hand-drawn stroke capped with an arrowhead
// (see WhiteboardCanvas.tsx's freehand-drawing gesture and whiteboardTypes.ts's
// WhiteboardNode.endArrowType), armed the same way the Pen tool is rather than through
// connectorArmed, since it follows the pointer's actual path instead of a single drag start->end.
type ArrowPreset =
  | { kind: "connector"; label: string; overrides: Partial<WhiteboardEdge> }
  | { kind: "freehand"; label: string; endArrowType: ArrowheadType; startArrowType?: ArrowheadType };

const ARROW_PRESETS: ArrowPreset[] = [
  { kind: "connector", label: "Arrow", overrides: { endArrowType: "triangle", startArrowType: "none", strokeStyle: "solid", routing: "straight" } },
  { kind: "connector", label: "Bidirectional", overrides: { endArrowType: "triangle", startArrowType: "triangle", strokeStyle: "solid", routing: "straight" } },
  { kind: "connector", label: "Orthogonal", overrides: { endArrowType: "triangle", startArrowType: "none", strokeStyle: "solid", routing: "orthogonal" } },
  { kind: "connector", label: "Curved", overrides: { endArrowType: "triangle", startArrowType: "none", strokeStyle: "solid", routing: "curved" } },
  { kind: "connector", label: "Open Arrow", overrides: { endArrowType: "triangleOpen", startArrowType: "none", strokeStyle: "solid", routing: "straight" } },
  { kind: "connector", label: "Block Arrow", overrides: { endArrowType: "block", startArrowType: "none", strokeStyle: "solid", routing: "straight" } },
  { kind: "connector", label: "Plain Line", overrides: { endArrowType: "none", startArrowType: "none", strokeStyle: "solid", routing: "straight" } },
  { kind: "connector", label: "Dashed Arrow", overrides: { endArrowType: "triangle", startArrowType: "none", strokeStyle: "dashed", routing: "straight" } },
  { kind: "connector", label: "Dashed Line", overrides: { endArrowType: "none", startArrowType: "none", strokeStyle: "dashed", routing: "straight" } },
  { kind: "connector", label: "Dotted Arrow", overrides: { endArrowType: "triangle", startArrowType: "none", strokeStyle: "dotted", routing: "straight" } },
  { kind: "connector", label: "Dotted Line", overrides: { endArrowType: "none", startArrowType: "none", strokeStyle: "dotted", routing: "straight" } },
  { kind: "freehand", label: "Freehand Arrow", endArrowType: "triangle" },
];

const ARROW_TILE_W = 56;
const ARROW_TILE_H = 28;

// A small stand-alone arrowhead glyph for the popover previews - deliberately not the same code
// WhiteboardCanvas.tsx's SVG <marker> defs use (those need a shared marker-per-edge id scheme this
// static preview has no reason to participate in); close enough in proportion to be recognizable,
// not meant to be pixel-identical.
function ArrowTip({ type, x, y, angleDeg, color }: { type: ArrowheadType; x: number; y: number; angleDeg: number; color: string }) {
  if (type === "none") return null;
  const s = 7;
  return (
    <g transform={`translate(${x},${y}) rotate(${angleDeg})`}>
      {type === "triangle" && <path d={`M0,0 L${-s},${s * 0.55} L${-s},${-s * 0.55} Z`} fill={color} />}
      {type === "block" && <path d={`M0,0 L${-s * 1.15},${s * 0.6} L${-s * 0.8},0 L${-s * 1.15},${-s * 0.6} Z`} fill={color} />}
      {type === "triangleOpen" && <path d={`M${-s},${s * 0.55} L0,0 L${-s},${-s * 0.55}`} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />}
      {type === "diamond" && <path d={`M0,0 L${-s * 0.6},${s * 0.4} L${-s * 1.2},0 L${-s * 0.6},${-s * 0.4} Z`} fill={color} />}
      {type === "circle" && <circle cx={-s * 0.5} cy={0} r={s * 0.45} fill={color} />}
    </g>
  );
}

function ArrowPresetPreview({ preset }: { preset: ArrowPreset }) {
  const y = ARROW_TILE_H / 2;
  if (preset.kind === "freehand") {
    return (
      <svg width={ARROW_TILE_W} height={ARROW_TILE_H} viewBox={`0 0 ${ARROW_TILE_W} ${ARROW_TILE_H}`}>
        <path d={`M6,${ARROW_TILE_H - 4} C16,6 26,${ARROW_TILE_H - 2} 36,10`} fill="none" stroke="#111111" strokeWidth={2} strokeLinecap="round" />
        <ArrowTip type={preset.endArrowType} x={36} y={10} angleDeg={-52} color="#111111" />
      </svg>
    );
  }
  const { strokeStyle, endArrowType, startArrowType, strokeColor = "#374151" } = preset.overrides;
  const dash = strokeStyle === "dashed" ? "6,4" : strokeStyle === "dotted" ? "1.2,3.5" : undefined;
  const x1 = 8;
  const x2 = ARROW_TILE_W - 8;
  return (
    <svg width={ARROW_TILE_W} height={ARROW_TILE_H} viewBox={`0 0 ${ARROW_TILE_W} ${ARROW_TILE_H}`}>
      <line x1={x1} y1={y} x2={x2} y2={y} stroke={strokeColor} strokeWidth={2} strokeDasharray={dash} strokeLinecap={strokeStyle === "dotted" ? "round" : "butt"} />
      {endArrowType && <ArrowTip type={endArrowType} x={x2} y={y} angleDeg={0} color={strokeColor} />}
      {startArrowType && <ArrowTip type={startArrowType} x={x1} y={y} angleDeg={180} color={strokeColor} />}
    </svg>
  );
}

function ToolbarButton({ active, disabled, onClick, title, children }: { active?: boolean; disabled?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`p-2 rounded-md text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800"
      }`}
    >
      {children}
    </button>
  );
}

interface PageTabProps {
  page: WhiteboardPage;
  active: boolean;
  canDelete: boolean;
  // Undefined when this page is already at that end of the tab strip - lets the menu just hide the
  // button instead of showing a control that would do nothing.
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

// One page tab - mirrors draw.io's own Page-1/Page-2 tab strip. Double-click to rename inline;
// a small "..." menu (shown once active, since that's the only tab with room/reason to act on
// right now) offers rename/move/duplicate/delete, the last behind a two-step confirm (same
// convention as BoardHome's card menu) since deleting a page is permanent and NOT undo-tracked.
function PageTab({ page, active, canDelete, onMoveLeft, onMoveRight, onSelect, onRename, onDelete, onDuplicate }: PageTabProps) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(page.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Where the portaled menu anchors, in VIEWPORT coordinates (captured from the chevron button's
  // own rect at the moment it's clicked) - see the menu's own doc comment below for why it's a
  // portal at all rather than a plain absolutely-positioned child.
  const [menuAnchor, setMenuAnchor] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => {
      setMenuOpen(false);
      setConfirmDelete(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);

  if (renaming) {
    return (
      <input
        autoFocus
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        onBlur={() => {
          setRenaming(false);
          if (draftName.trim()) onRename(draftName.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraftName(page.name);
            setRenaming(false);
          }
        }}
        className="h-7 w-24 px-1.5 rounded border border-blue-400 bg-white dark:bg-neutral-800 text-xs outline-none"
      />
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={() => {
        setDraftName(page.name);
        setRenaming(true);
      }}
      className={`relative flex items-center gap-1 h-7 px-3 rounded-t-md text-xs cursor-pointer select-none ${
        active ? "bg-white dark:bg-neutral-950 text-neutral-800 dark:text-neutral-100 border border-b-0 border-gray-200 dark:border-neutral-800" : "text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
      }`}
    >
      <span className="max-w-[120px] truncate">{page.name}</span>
      {active && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDelete(false);
            const rect = e.currentTarget.getBoundingClientRect();
            setMenuAnchor({ left: rect.left, bottom: window.innerHeight - rect.top });
            setMenuOpen((prev) => !prev);
          }}
          className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700"
        >
          <IoChevronDown size={11} />
        </button>
      )}
      {menuOpen &&
        menuAnchor &&
        createPortal(
          <div
            onClick={(e) => e.stopPropagation()}
            // A PORTAL into document.body, `position: fixed` anchored to the chevron button's own
            // viewport rect (captured on click, above) - not a plain absolutely-positioned child of
            // this tab. The tab strip's own row needs `overflow-x-auto` (many pages scroll
            // horizontally), and per the CSS spec, setting only one overflow axis forces the OTHER
            // axis to auto too - silently clipping anything that tries to extend past this row's own
            // top edge, including a plain "opens upward" dropdown. Escaping via a portal sidesteps
            // that entirely. Anchored via `bottom` (not `top`) - measured up from the button's own
            // top edge - so the menu still opens upward and never needs to know its own rendered
            // height in advance to position correctly.
            style={{ position: "fixed", left: menuAnchor.left, bottom: menuAnchor.bottom + 4 }}
            className="w-40 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg overflow-hidden z-50"
          >
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setDraftName(page.name);
                setRenaming(true);
              }}
              className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-xs text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700"
            >
              <IoPencilOutline size={13} /> Rename page
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onDuplicate();
              }}
              className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-xs text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700"
            >
              <IoCopyOutline size={13} /> Duplicate page
            </button>
            {(onMoveLeft || onMoveRight) && <div className="my-1 border-t border-gray-100 dark:border-neutral-700/70" />}
            {onMoveLeft && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onMoveLeft();
                }}
                className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-xs text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700"
              >
                <IoChevronBack size={13} /> Move left
              </button>
            )}
            {onMoveRight && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onMoveRight();
                }}
                className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-xs text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700"
              >
                <IoChevronForward size={13} /> Move right
              </button>
            )}
            {canDelete && <div className="my-1 border-t border-gray-100 dark:border-neutral-700/70" />}
            {canDelete && (
              <button
                type="button"
                onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
                className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
              >
                <IoTrashOutline size={13} /> {confirmDelete ? "Confirm delete?" : "Delete page"}
              </button>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

const WhiteboardEditor: React.FC<WhiteboardEditorProps> = ({ whiteboardId, onBack }) => {
  const store = useWhiteboardStore(whiteboardId);
  const canvasRef = useRef<WhiteboardCanvasHandle>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<string>>(new Set());
  const [armedShapeType, setArmedShapeType] = useState<WhiteboardShapeType | null>(null);
  const [armedNodeOverrides, setArmedNodeOverrides] = useState<Partial<WhiteboardNode> | undefined>(undefined);
  const [connectorArmed, setConnectorArmed] = useState(false);
  const [armedConnectorOverrides, setArmedConnectorOverrides] = useState<Partial<WhiteboardEdge> | undefined>(undefined);
  const [laserArmed, setLaserArmed] = useState(false);
  // The shape-picker popover that opens after clicking one of a node's hover arrows (see
  // WhiteboardCanvas.tsx's HoverConnectArrows) - lets you choose WHICH shape to add and connect,
  // rather than always cloning the hovered node's own shape type. `x`/`y` are viewport (client)
  // coordinates from the click that opened it, so the popover can anchor itself near the arrow
  // regardless of where on the (possibly panned/zoomed) canvas it was.
  const [quickConnectPicker, setQuickConnectPicker] = useState<{ nodeId: string; side: Exclude<WhiteboardAnchorSide, "auto">; x: number; y: number } | null>(null);
  // Right-click context menu (export selection as PNG, delete) - opened by WhiteboardCanvas.tsx's
  // onItemContextMenu once a node/edge right-click has already updated the selection to match.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeIds: Set<string>; edgeIds: Set<string> } | null>(null);
  const [exportingSelection, setExportingSelection] = useState(false);
  const [shapesMenuOpen, setShapesMenuOpen] = useState(false);
  const [arrowsMenuOpen, setArrowsMenuOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Drops back to plain selection mode - clears every armed tool (shape/text/equation/freehand/
  // connector/laser) at once. Exists as its own dedicated toolbar button rather than relying solely
  // on Escape (see the keydown handler below) because Escape doesn't exist on a touchscreen - a
  // tablet/touch user arming the pen tool had no way at all to get back out of it before this.
  const deselectTools = useCallback(() => {
    setArmedShapeType(null);
    setArmedNodeOverrides(undefined);
    setConnectorArmed(false);
    setArmedConnectorOverrides(undefined);
    setLaserArmed(false);
    setShapesMenuOpen(false);
    setArrowsMenuOpen(false);
  }, []);

  const doc = store.doc;
  const page = store.activePage;

  // While any node-editing drag is in progress (move/resize/rotate/amplifier-lead), WhiteboardCanvas
  // reports its own in-progress liveNodes array here purely for display (see its own
  // onLiveNodesChange doc comment) - the drag itself doesn't commit to the store (and isn't
  // undo-tracked) until pointer-up, but the style panel's numeric fields (Rotation, X/Y, amplifier
  // lead lengths, ...) should still track the shape changing in real time rather than sitting stale
  // until release.
  const [liveNodesOverride, setLiveNodesOverride] = useState<WhiteboardNode[] | null>(null);

  const selectedNodes = useMemo(() => {
    const list = page ? page.nodes.filter((n) => selectedNodeIds.has(n.id)) : [];
    if (!liveNodesOverride) return list;
    const liveById = new Map(liveNodesOverride.map((n) => [n.id, n]));
    return list.map((n) => liveById.get(n.id) ?? n);
  }, [page, selectedNodeIds, liveNodesOverride]);
  const selectedEdges = useMemo(() => (page ? page.edges.filter((e) => selectedEdgeIds.has(e.id)) : []), [page, selectedEdgeIds]);

  useEffect(() => {
    if (!shapesMenuOpen) return;
    const close = () => setShapesMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [shapesMenuOpen]);

  useEffect(() => {
    if (!arrowsMenuOpen) return;
    const close = () => setArrowsMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [arrowsMenuOpen]);

  useEffect(() => {
    if (!quickConnectPicker) return;
    const close = () => setQuickConnectPicker(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [quickConnectPicker]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [contextMenu]);

  // Fits the view to whichever page is active, every time it changes - covers both "a whiteboard
  // just finished loading" and "the user switched pages" in one code path, since either way the
  // canvas's previous pan/zoom has no reason to still make sense for different content. Keyed on
  // just the id (not the whole page object, which changes on every edit) so this never re-fires
  // mid-edit and stomps the user's own pan/zoom or clears their selection out from under them.
  useEffect(() => {
    if (!page) return;
    setSelectedNodeIds(new Set());
    setSelectedEdgeIds(new Set());
    if (page.nodes.length > 0 || page.edges.length > 0) canvasRef.current?.fitToContent(computeContentBounds(page));
    else canvasRef.current?.resetView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.id]);

  // ---- Keyboard shortcuts: undo/redo (Delete/Escape live inside WhiteboardCanvas, which owns
  // selection-adjacent state that undo/redo doesn't need) -----------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const isTyping = active instanceof HTMLElement && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (isTyping) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        store.redo();
      } else if (e.key === "Escape" && (armedShapeType || connectorArmed || laserArmed)) {
        deselectTools();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, armedShapeType, connectorArmed, laserArmed, deselectTools]);

  const handleReorder = useCallback(
    (toFront: boolean) => {
      if (!page || selectedNodeIds.size === 0) return;
      const selected = page.nodes.filter((n) => selectedNodeIds.has(n.id));
      const rest = page.nodes.filter((n) => !selectedNodeIds.has(n.id));
      store.reorderNodes(toFront ? [...rest, ...selected] : [...selected, ...rest]);
    },
    [page, selectedNodeIds, store]
  );

  // Group/Ungroup are plain batchEditNodes calls that set/clear WhiteboardNode.groupId - no
  // dedicated command type needed (see that field's own doc comment), which also means they're
  // undo-tracked for free the same way any other multi-node style edit already is.
  const handleGroup = useCallback(() => {
    if (selectedNodes.length < 2) return;
    const groupId = crypto.randomUUID();
    store.batchEditNodes(selectedNodes, selectedNodes.map((n) => ({ ...n, groupId })));
  }, [selectedNodes, store]);

  const handleUngroup = useCallback(() => {
    const grouped = selectedNodes.filter((n) => n.groupId);
    if (grouped.length === 0) return;
    store.batchEditNodes(grouped, grouped.map((n) => ({ ...n, groupId: undefined })));
  }, [selectedNodes, store]);

  const handleDuplicateNode = useCallback(
    (node: WhiteboardNode) => {
      const copy: WhiteboardNode = { ...node, id: crypto.randomUUID(), x: node.x + 24, y: node.y + 24, createdAt: Date.now(), updatedAt: Date.now() };
      store.addNode(copy);
      setSelectedNodeIds(new Set([copy.id]));
      setSelectedEdgeIds(new Set());
    },
    [store]
  );

  const handleSelectionChange = useCallback((nodeIds: Set<string>, edgeIds: Set<string>) => {
    setSelectedNodeIds(nodeIds);
    setSelectedEdgeIds(edgeIds);
  }, []);

  const handleExport = useCallback(async () => {
    if (!doc || !page) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const canvas = await renderWhiteboardToCanvas(page);
      const bytes = await canvasToPngBytes(canvas);
      await invoke<string>("export_whiteboard_png", { whiteboardName: doc.name, bytes: Array.from(bytes) });
    } catch (err) {
      console.error("Failed to export whiteboard:", err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  }, [doc, page]);

  const handleSaveAs = useCallback(async () => {
    if (!doc || !page) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const canvas = await renderWhiteboardToCanvas(page);
      const bytes = await canvasToPngBytes(canvas);
      const safeName = doc.name.trim().replace(/[^a-zA-Z0-9 _-]/g, "_") || "Whiteboard";
      const destPath = await saveFileDialog({ defaultPath: `${safeName}.png`, filters: [{ name: "PNG Image", extensions: ["png"] }] });
      if (!destPath) return;
      await invoke("export_whiteboard_png_to_path", { destPath, bytes: Array.from(bytes) });
    } catch (err) {
      console.error("Failed to save whiteboard:", err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  }, [doc, page]);

  const handleBack = useCallback(async () => {
    store.flushSave();
    if (page) {
      try {
        const thumb = await renderWhiteboardToCanvas(page, THUMBNAIL_MAX_DIMENSION);
        const bytes = await canvasToPngBytes(thumb);
        await invoke("save_whiteboard_thumbnail", { whiteboardId, bytes: Array.from(bytes) });
      } catch (err) {
        console.error("Failed to save whiteboard thumbnail:", err);
      }
    }
    onBack();
  }, [store, page, whiteboardId, onBack]);

  // Right-click "Export selection as PNG" - builds a throwaway WhiteboardPage containing only the
  // right-clicked node(s)/edge(s) (plus, for a selected edge, whichever of its own endpoint nodes
  // weren't ALSO selected - otherwise resolveEdgeEndpoints would have nothing to resolve that
  // endpoint against and the edge would collapse to a point) and reuses renderWhiteboardToCanvas
  // completely unchanged - it only ever reads page.nodes/page.edges, so it can't tell this apart
  // from a real page. Same save-dialog + export_whiteboard_png_to_path plumbing handleSaveAs above
  // already uses for the whole board.
  const handleExportSelection = useCallback(
    async (nodeIds: Set<string>, edgeIds: Set<string>) => {
      if (!doc || !page || (nodeIds.size === 0 && edgeIds.size === 0)) return;
      setContextMenu(null);
      setExportingSelection(true);
      setExportError(null);
      try {
        const referencedNodeIds = new Set<string>();
        for (const edge of page.edges) {
          if (!edgeIds.has(edge.id)) continue;
          if (edge.source.nodeId) referencedNodeIds.add(edge.source.nodeId);
          if (edge.target.nodeId) referencedNodeIds.add(edge.target.nodeId);
        }
        const selectionPage: WhiteboardPage = {
          ...page,
          nodes: page.nodes.filter((n) => nodeIds.has(n.id) || referencedNodeIds.has(n.id)),
          edges: page.edges.filter((e) => edgeIds.has(e.id)),
        };
        if (selectionPage.nodes.length === 0 && selectionPage.edges.length === 0) return;
        const canvas = await renderWhiteboardToCanvas(selectionPage);
        const bytes = await canvasToPngBytes(canvas);
        const safeName = doc.name.trim().replace(/[^a-zA-Z0-9 _-]/g, "_") || "Whiteboard";
        const destPath = await saveFileDialog({ defaultPath: `${safeName} - selection.png`, filters: [{ name: "PNG Image", extensions: ["png"] }] });
        if (!destPath) return;
        await invoke("export_whiteboard_png_to_path", { destPath, bytes: Array.from(bytes) });
      } catch (err) {
        console.error("Failed to export selection:", err);
        setExportError(err instanceof Error ? err.message : String(err));
      } finally {
        setExportingSelection(false);
      }
    },
    [doc, page]
  );

  // Right-click "Delete" - same edges-then-nodes order WhiteboardCanvas.tsx's own keyboard Delete
  // handler uses (deleting a node cascades its own attached edges - see store.deleteNode - so
  // clearing explicitly-selected edges first avoids any ambiguity about which delete "owns" them).
  const handleDeleteSelection = useCallback(
    (nodeIds: Set<string>, edgeIds: Set<string>) => {
      if (!page) return;
      for (const id of edgeIds) {
        const edge = page.edges.find((e) => e.id === id);
        if (edge) store.deleteEdge(edge);
      }
      for (const id of nodeIds) {
        const node = page.nodes.find((n) => n.id === id);
        if (node) store.deleteNode(node);
      }
      setSelectedNodeIds(new Set());
      setSelectedEdgeIds(new Set());
      setContextMenu(null);
    },
    [page, store]
  );

  const armShape = useCallback((preset: ShapePreset) => {
    setLaserArmed(false);
    setConnectorArmed(false);
    setArmedConnectorOverrides(undefined);
    setShapesMenuOpen(false);
    setArmedShapeType((prev) => {
      const isSame = prev === preset.type && JSON.stringify(armedNodeOverrides) === JSON.stringify(preset.overrides);
      return isSame ? null : preset.type;
    });
    setArmedNodeOverrides(preset.overrides);
  }, [armedNodeOverrides]);

  const armArrow = useCallback(
    (preset: ArrowPreset) => {
      setLaserArmed(false);
      setArrowsMenuOpen(false);
      if (preset.kind === "freehand") {
        setConnectorArmed(false);
        setArmedConnectorOverrides(undefined);
        const startType = preset.startArrowType ?? "none";
        const isSame = armedShapeType === "freehand" && armedNodeOverrides?.endArrowType === preset.endArrowType && armedNodeOverrides?.startArrowType === startType;
        setArmedShapeType(isSame ? null : "freehand");
        setArmedNodeOverrides(isSame ? undefined : { endArrowType: preset.endArrowType, startArrowType: startType });
        return;
      }
      setArmedShapeType(null);
      setArmedNodeOverrides(undefined);
      const isSame = connectorArmed && JSON.stringify(armedConnectorOverrides) === JSON.stringify(preset.overrides);
      setConnectorArmed(!isSame);
      setArmedConnectorOverrides(isSame ? undefined : preset.overrides);
    },
    [armedShapeType, armedNodeOverrides, connectorArmed, armedConnectorOverrides]
  );

  if (store.loading || !doc || !page) {
    return (
      <div className="flex items-center justify-center w-full h-full text-gray-400 dark:text-neutral-500 text-sm">
        {store.loadError ? `Failed to load whiteboard: ${store.loadError}` : "Loading whiteboard…"}
      </div>
    );
  }

  return (
    // pb tracks --docker-height (published by BottomDocker's own ResizeObserver - see
    // BoardStylePanel.tsx's identical comment on the same pattern) PLUS a fixed 16px buffer on top
    // of that, so the page tab strip's own controls (its chevron menu button, in particular) always
    // clear the app's fixed bottom icon bar with real margin to spare - sitting them exactly flush
    // (zero gap) left the tab strip's bottom edge one ResizeObserver tick / sub-pixel DPI-rounding
    // away from actually being covered by the docker's own click-intercepting drag-region strip,
    // making the chevron unclickable.
    <div className="flex flex-col w-full h-full bg-white dark:bg-neutral-950 pb-[calc(var(--docker-height,64px)+16px)]">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-200 dark:border-neutral-800 flex-wrap">
        <ToolbarButton title="Back to whiteboards" onClick={() => void handleBack()}>
          <IoArrowBack size={18} />
        </ToolbarButton>
        <input
          type="text"
          value={doc.name}
          onChange={(e) => store.renameWhiteboard(e.target.value)}
          className="ml-1 mr-2 h-8 px-2 rounded-md border border-transparent hover:border-gray-200 dark:hover:border-neutral-700 focus:border-blue-400 dark:focus:border-blue-500 bg-transparent text-sm font-medium text-neutral-800 dark:text-neutral-100 outline-none max-w-[220px]"
        />
        <div className="w-px h-6 bg-gray-200 dark:bg-neutral-700 mx-1" />
        <ToolbarButton title="Undo" disabled={!store.canUndo} onClick={store.undo}>
          <IoArrowUndo size={18} />
        </ToolbarButton>
        <ToolbarButton title="Redo" disabled={!store.canRedo} onClick={store.redo}>
          <IoArrowRedo size={18} />
        </ToolbarButton>
        <div className="w-px h-6 bg-gray-200 dark:bg-neutral-700 mx-1" />
        <ToolbarButton
          title="Select"
          active={armedShapeType === null && !connectorArmed && !laserArmed}
          onClick={deselectTools}
        >
          <TbPointer size={18} />
        </ToolbarButton>
        <div className="relative">
          <ToolbarButton
            title="Shapes"
            active={armedShapeType !== null && armedShapeType !== "text" && armedShapeType !== "freehand"}
            onClick={(e?: any) => {
              e?.stopPropagation?.();
              setShapesMenuOpen((prev) => {
                const next = !prev;
                if (next) {
                  setArrowsMenuOpen(false);
                  setLaserArmed(false);
                }
                return next;
              });
            }}
          >
            <span className="flex items-center gap-0.5">
              <IoShapesOutline size={18} />
              <IoChevronDown size={11} />
            </span>
          </ToolbarButton>
          {shapesMenuOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute left-0 top-full mt-1 w-[280px] max-h-[70vh] overflow-y-auto bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-lg shadow-xl p-2 grid grid-cols-3 gap-1 z-20"
            >
              {SHAPE_PRESET_GROUPS.map((group) => (
                <React.Fragment key={group.label}>
                  <p className="col-span-3 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-neutral-500 px-1 pt-1 first:pt-0">{group.label}</p>
                  {group.presets.map((preset) => {
                    const active = armedShapeType === preset.type && JSON.stringify(armedNodeOverrides) === JSON.stringify(preset.overrides);
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => armShape(preset)}
                        className={`flex flex-col items-center gap-0.5 p-1.5 rounded-md ${active ? "bg-blue-100 dark:bg-blue-500/30" : "hover:bg-gray-100 dark:hover:bg-neutral-700"}`}
                      >
                        <ShapePresetPreview preset={preset} />
                        <span className="text-[10px] text-gray-500 dark:text-neutral-400">{preset.label}</span>
                      </button>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
        <ToolbarButton
          title="Text"
          active={armedShapeType === "text"}
          onClick={() => {
            setLaserArmed(false);
            setShapesMenuOpen(false);
            setArrowsMenuOpen(false);
            setConnectorArmed(false);
            setArmedConnectorOverrides(undefined);
            setArmedNodeOverrides(undefined);
            setArmedShapeType((prev) => (prev === "text" ? null : "text"));
          }}
        >
          <span className="font-semibold text-sm">A</span>
        </ToolbarButton>
        <ToolbarButton
          title="Equation (LaTeX)"
          active={armedShapeType === "equation"}
          onClick={() => {
            setLaserArmed(false);
            setShapesMenuOpen(false);
            setArrowsMenuOpen(false);
            setConnectorArmed(false);
            setArmedConnectorOverrides(undefined);
            setArmedNodeOverrides(undefined);
            setArmedShapeType((prev) => (prev === "equation" ? null : "equation"));
          }}
        >
          <IoCalculatorOutline size={18} />
        </ToolbarButton>
        <ToolbarButton
          title="Pen (freehand)"
          active={armedShapeType === "freehand" && !armedNodeOverrides?.endArrowType}
          onClick={() => {
            setLaserArmed(false);
            setShapesMenuOpen(false);
            setArrowsMenuOpen(false);
            setConnectorArmed(false);
            setArmedConnectorOverrides(undefined);
            setArmedNodeOverrides(undefined);
            setArmedShapeType((prev) => (prev === "freehand" ? null : "freehand"));
          }}
        >
          <IoPencilOutline size={18} />
        </ToolbarButton>
        <ToolbarButton
          title="Laser pointer"
          active={laserArmed}
          onClick={() => {
            setShapesMenuOpen(false);
            setArrowsMenuOpen(false);
            setConnectorArmed(false);
            setArmedConnectorOverrides(undefined);
            setArmedNodeOverrides(undefined);
            setArmedShapeType(null);
            setLaserArmed((prev) => !prev);
          }}
        >
          <span className="relative flex items-center justify-center w-[18px] h-[18px]">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
            <span className="absolute inset-0 rounded-full border border-red-400 opacity-60" />
          </span>
        </ToolbarButton>
        <div className="relative">
          <ToolbarButton
            title="Arrows"
            active={connectorArmed || (armedShapeType === "freehand" && !!armedNodeOverrides?.endArrowType)}
            onClick={(e?: any) => {
              e?.stopPropagation?.();
              setArrowsMenuOpen((prev) => {
                const next = !prev;
                if (next) {
                  setShapesMenuOpen(false);
                  setLaserArmed(false);
                }
                return next;
              });
            }}
          >
            <span className="flex items-center gap-0.5">
              <IoGitNetworkOutline size={18} />
              <IoChevronDown size={11} />
            </span>
          </ToolbarButton>
          {arrowsMenuOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute left-0 top-full mt-1 w-[240px] max-h-[70vh] overflow-y-auto bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-lg shadow-xl p-2 flex flex-col gap-0.5 z-20"
            >
              {ARROW_PRESETS.map((preset) => {
                const active =
                  preset.kind === "freehand"
                    ? armedShapeType === "freehand" && armedNodeOverrides?.endArrowType === preset.endArrowType && (armedNodeOverrides?.startArrowType ?? "none") === (preset.startArrowType ?? "none")
                    : connectorArmed && JSON.stringify(armedConnectorOverrides) === JSON.stringify(preset.overrides);
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => armArrow(preset)}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md ${active ? "bg-blue-100 dark:bg-blue-500/30" : "hover:bg-gray-100 dark:hover:bg-neutral-700"}`}
                  >
                    <ArrowPresetPreview preset={preset} />
                    <span className="text-xs text-gray-600 dark:text-neutral-300">{preset.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="w-px h-6 bg-gray-200 dark:bg-neutral-700 mx-1" />
        <ToolbarButton title="Zoom out" onClick={() => canvasRef.current?.zoomBy(1 / 1.25)}>
          <IoRemove size={18} />
        </ToolbarButton>
        <span className="text-xs text-gray-500 dark:text-neutral-400 w-11 text-center select-none">{Math.round(zoom * 100)}%</span>
        <ToolbarButton title="Zoom in" onClick={() => canvasRef.current?.zoomBy(1.25)}>
          <IoAdd size={18} />
        </ToolbarButton>
        <ToolbarButton title="Fit to content" onClick={() => canvasRef.current?.fitToContent(computeContentBounds(page))}>
          <IoContractOutline size={18} />
        </ToolbarButton>
        <ToolbarButton title={doc.showGrid ? "Hide grid" : "Show grid"} active={doc.showGrid} onClick={() => store.setShowGrid(!doc.showGrid)}>
          <IoGridOutline size={18} />
        </ToolbarButton>
        <ToolbarButton
          title={doc.snapToGrid ? "Snap to grid on (hold Alt to move freely)" : "Snap to grid off (hold Alt to snap)"}
          active={doc.snapToGrid}
          onClick={() => store.setSnapToGrid(!doc.snapToGrid)}
        >
          <IoMagnetOutline size={18} />
        </ToolbarButton>
        <div className="flex-1" />
        {store.isSaving && <span className="text-xs text-gray-400 dark:text-neutral-500 mr-2">Saving…</span>}
        {exportError && <span className="text-xs text-red-500 dark:text-red-400 mr-2">{exportError}</span>}
        <ToolbarButton title="Save As PNG…" disabled={isExporting} onClick={() => void handleSaveAs()}>
          <IoDownloadOutline size={18} />
        </ToolbarButton>
        <button
          type="button"
          disabled={isExporting}
          onClick={() => void handleExport()}
          className="ml-1 flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isExporting ? "Exporting…" : "Export PNG"}
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        <WhiteboardCanvas
          ref={canvasRef}
          page={page}
          showGrid={doc.showGrid}
          snapToGrid={doc.snapToGrid}
          zoom={zoom}
          onZoomChange={setZoom}
          pan={pan}
          onPanChange={setPan}
          selectedNodeIds={selectedNodeIds}
          selectedEdgeIds={selectedEdgeIds}
          onSelectionChange={handleSelectionChange}
          onAddNode={(node) => store.addNode(armedNodeOverrides ? { ...node, ...armedNodeOverrides } : node)}
          onAddNodeWithEdge={store.addNodeWithEdge}
          onEditNode={store.editNode}
          onBatchEditNodes={store.batchEditNodes}
          onLiveNodesChange={setLiveNodesOverride}
          onDeleteNode={(node) => {
            store.deleteNode(node);
            setSelectedNodeIds((prev) => {
              if (!prev.has(node.id)) return prev;
              const next = new Set(prev);
              next.delete(node.id);
              return next;
            });
          }}
          onAddEdge={store.addEdge}
          onEditEdge={store.editEdge}
          onDeleteEdge={(edge) => {
            store.deleteEdge(edge);
            setSelectedEdgeIds((prev) => {
              if (!prev.has(edge.id)) return prev;
              const next = new Set(prev);
              next.delete(edge.id);
              return next;
            });
          }}
          armedShapeType={armedShapeType}
          onShapePlaced={() => {
            setArmedShapeType(null);
            setArmedNodeOverrides(undefined);
          }}
          connectorArmed={connectorArmed}
          armedConnectorOverrides={armedConnectorOverrides}
          laserArmed={laserArmed}
          onQuickConnectArrowClick={(nodeId, side, point) => setQuickConnectPicker({ nodeId, side, x: point.x, y: point.y })}
          onItemContextMenu={(nodeIds, edgeIds, point) => setContextMenu({ x: point.x, y: point.y, nodeIds, edgeIds })}
        />
        <WhiteboardStylePanel
          selectedNodes={selectedNodes}
          selectedEdges={selectedEdges}
          onBatchEditNodes={store.batchEditNodes}
          onEditEdge={store.editEdge}
          onDeleteNode={(node: WhiteboardNode) => {
            store.deleteNode(node);
            setSelectedNodeIds(new Set());
          }}
          onDeleteEdge={(edge: WhiteboardEdge) => {
            store.deleteEdge(edge);
            setSelectedEdgeIds(new Set());
          }}
          onDuplicateNode={handleDuplicateNode}
          onBringToFront={() => handleReorder(true)}
          onSendToBack={() => handleReorder(false)}
          onGroup={handleGroup}
          onUngroup={handleUngroup}
        />
      </div>

      {/* Quick-connect shape picker - opens after clicking one of a node's hover arrows (see
          WhiteboardCanvas.tsx's HoverConnectArrows), anchored near the click via `fixed` viewport
          coordinates rather than the toolbar's own popover positioning since it can open anywhere
          on the canvas, not just under a toolbar button. Reuses the exact same preset groups/preview
          the Shapes toolbar popover does, so "what shapes are offered" never has to be kept in sync
          across two separate lists. */}
      {quickConnectPicker && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="fixed z-30 w-[280px] overflow-y-auto bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-lg shadow-xl p-2 grid grid-cols-3 gap-1"
          style={{
            left: Math.max(8, Math.min(quickConnectPicker.x, window.innerWidth - 290)),
            // maxHeight and the top clamp both read the SAME window.innerHeight * 0.7 expression
            // (rather than one carrying it in a "max-h-[70vh]" Tailwind class while the other
            // guessed a plain pixel number, which is what this used to do) - those two drifted
            // apart once already: a hardcoded "the popover is about 340px tall" guess here was
            // never updated as the shape palette grew past that over time, so the actual (taller)
            // popover's own top could still land low enough to push most of it below the real
            // window edge - outside the OS window entirely, not just clipped by overflow-y-auto
            // (which only helps for content taller than a box that's actually fully on-screen),
            // with no way to scroll down to whatever fell past it.
            top: Math.max(8, Math.min(quickConnectPicker.y, window.innerHeight - window.innerHeight * 0.7 - 8)),
            maxHeight: window.innerHeight * 0.7,
          }}
        >
          {SHAPE_PRESET_GROUPS.map((group) => (
            <React.Fragment key={group.label}>
              <p className="col-span-3 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-neutral-500 px-1 pt-1 first:pt-0">{group.label}</p>
              {group.presets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    canvasRef.current?.placeConnectedShape(quickConnectPicker.nodeId, quickConnectPicker.side, preset.type, preset.overrides);
                    setQuickConnectPicker(null);
                  }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-neutral-700"
                >
                  <ShapePresetPreview preset={preset} />
                  <span className="text-[10px] text-gray-500 dark:text-neutral-400">{preset.label}</span>
                </button>
              ))}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Right-click context menu on a node/edge - see WhiteboardCanvas.tsx's onContextMenu
          handlers on each node/edge for the "select if not already selected, then open here"
          gesture this responds to. Same fixed-viewport-coordinate anchoring as the quick-connect
          picker above, for the same reason (can open anywhere on the canvas). */}
      {contextMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="fixed z-30 w-52 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-lg shadow-xl py-1 text-xs text-neutral-700 dark:text-neutral-200"
          style={{
            left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 216)),
            top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 100)),
          }}
        >
          <button
            type="button"
            disabled={exportingSelection}
            onClick={() => handleExportSelection(contextMenu.nodeIds, contextMenu.edgeIds)}
            className="w-full flex items-center gap-2 text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700 disabled:opacity-50"
          >
            <IoImageOutline size={14} /> {exportingSelection ? "Exporting…" : "Export selection as PNG"}
          </button>
          <div className="my-1 border-t border-gray-100 dark:border-neutral-700/70" />
          <button
            type="button"
            onClick={() => handleDeleteSelection(contextMenu.nodeIds, contextMenu.edgeIds)}
            className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
          >
            <IoTrashOutline size={14} /> Delete
          </button>
        </div>
      )}

      {/* Page tab strip - draw.io's own Page-1/Page-2/+ bar. Always shown, even with just one page,
          so "Add page" is always discoverable rather than appearing only once a second page exists.
          pb-2 gives its own controls (the active tab's chevron menu, in particular) a real gap
          below them on top of the outer container's own pb buffer - see that pb's own doc comment
          for why touching-but-not-overlapping the fixed bottom docker isn't safe to rely on. */}
      <div className="flex items-end gap-0.5 px-2 pt-1 pb-2 bg-gray-50 dark:bg-neutral-900 border-t border-gray-200 dark:border-neutral-800 overflow-x-auto">
        {doc.pages.map((p, index) => (
          <PageTab
            key={p.id}
            page={p}
            active={p.id === doc.activePageId}
            canDelete={doc.pages.length > 1}
            onSelect={() => store.setActivePage(p.id)}
            onRename={(name) => store.renamePage(p.id, name)}
            onDelete={() => store.deletePage(p.id)}
            onDuplicate={() => store.duplicatePage(p.id)}
            onMoveLeft={
              index > 0
                ? () => {
                    const next = [...doc.pages];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    store.reorderPages(next);
                  }
                : undefined
            }
            onMoveRight={
              index < doc.pages.length - 1
                ? () => {
                    const next = [...doc.pages];
                    [next[index], next[index + 1]] = [next[index + 1], next[index]];
                    store.reorderPages(next);
                  }
                : undefined
            }
          />
        ))}
        <button type="button" title="Add page" onClick={store.addPage} className="p-1.5 mb-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-500 dark:text-neutral-400">
          <IoAdd size={16} />
        </button>
      </div>
    </div>
  );
};

export default WhiteboardEditor;
