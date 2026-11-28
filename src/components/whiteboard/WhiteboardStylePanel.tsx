// components/whiteboard/WhiteboardStylePanel.tsx
//
// The Whiteboard feature's property-editing surface for whatever's currently selected - mirrors
// BoardStylePanel.tsx's role for Board, but over WhiteboardNode/WhiteboardEdge instead of
// BoardItem. Node edits apply to every selected node at once via batchEditNodes when more than one
// is selected (so multi-selecting three boxes and picking a fill color is one undo step, not
// three) - single-selection edits still go through editNode so BoardStylePanel's "just the one
// item" case isn't paying for a batch array it doesn't need.
import React from "react";
import { IoChevronDown, IoCopyOutline, IoTrashOutline } from "react-icons/io5";
import {
  TbAlignCenter,
  TbAlignLeft,
  TbAlignRight,
  TbArrowDown,
  TbArrowsExchange,
  TbArrowUp,
  TbBold,
  TbLock,
  TbLockOpen,
  TbTextSize,
  TbComponents,
  TbComponentsOff,
  TbFlipHorizontal,
  TbFlipVertical,
  TbItalic,
  TbLayoutAlignBottom,
  TbLayoutAlignMiddle,
  TbLayoutAlignTop,
  TbShadow,
  TbShadowOff,
  TbStackBack,
  TbStackFront,
  TbUnderline,
} from "react-icons/tb";
import { ColormapName, COLORMAP_NAMES, DEFAULT_COLORMAP } from "../../utils/colormaps";
import { NODE_STYLE_PRESETS } from "../../utils/whiteboardThemes";
import { searchIcons, StickerIcon } from "../../utils/stickerIcons";
import WhiteboardIconGlyph from "./WhiteboardIconGlyph";
import WhiteboardMathEditor from "./WhiteboardMathEditor";
import {
  ArrowheadType,
  CHART_ANNOTATION_SHAPES,
  CHART_AXIS_TITLE_SHAPES,
  CHART_DATA_SHAPES,
  CHART_LABEL_SHAPES,
  DEFAULT_CHART_DATA,
  DEFAULT_SERIES_OFFSET,
  MAX_SERIES_OFFSET,
  MIN_SERIES_OFFSET,
  DEFAULT_LATTICE_LINK_WIDTH,
  DEFAULT_LATTICE_SITE_RADIUS,
  DEFAULT_LATTICE_SITE_SPACING,
  DEFAULT_LATTICE_SIZE,
  DEFAULT_LATTICE_SPIN_ARROW_SIZE,
  FunctionPlotType,
  LINE_ONLY_SHAPES,
  MAX_LATTICE_LINK_WIDTH,
  MAX_LATTICE_SITE_RADIUS,
  MAX_LATTICE_SITE_SPACING,
  MAX_LATTICE_SIZE,
  MAX_LATTICE_SPIN_ARROW_SIZE,
  MIN_LATTICE_LINK_WIDTH,
  MIN_LATTICE_SITE_RADIUS,
  MIN_LATTICE_SITE_SPACING,
  MIN_LATTICE_SIZE,
  MIN_LATTICE_SPIN_ARROW_SIZE,
  WhiteboardBlendMode,
  WHITEBOARD_BLEND_MODES,
  WhiteboardEdge,
  WhiteboardNode,
} from "../../utils/whiteboardTypes";
import {
  DEFAULT_AMP_INPUT_LEAD_LENGTH,
  DEFAULT_AMP_OUTPUT_LEAD_LENGTH,
  DEFAULT_ANGLE_DEGREES,
  DEFAULT_ANGLE_RAY_LENGTH,
  DEFAULT_CURVE_BOW,
  DEFAULT_GRAPH_EXPRESSION,
  DEFAULT_GRAPH_X_MAX,
  DEFAULT_GRAPH_X_MIN,
  DEFAULT_GRAPH_Y_MAX,
  DEFAULT_GRAPH_Y_MIN,
  DEFAULT_NUMBER_LINE_MAX,
  DEFAULT_PLOT_CYCLES,
  DEFAULT_PLOT_DOMAIN_SCALE,
  DEFAULT_WAVE_CYCLES,
  MAX_AMP_LEAD_LENGTH,
  MAX_ANGLE_DEGREES,
  MAX_ANGLE_RAY_LENGTH,
  MAX_GRAPH_DOMAIN,
  MAX_NUMBER_LINE_MAX,
  MAX_PLOT_CYCLES,
  MAX_PLOT_DOMAIN_SCALE,
  MAX_WAVE_CYCLES,
  MIN_AMP_LEAD_LENGTH,
  MIN_ANGLE_DEGREES,
  MIN_ANGLE_RAY_LENGTH,
  MIN_GRAPH_DOMAIN,
  MIN_NUMBER_LINE_MAX,
  MIN_PLOT_CYCLES,
  MIN_PLOT_DOMAIN_SCALE,
  MIN_WAVE_CYCLES,
  compileGraphExpression,
  DEFAULT_SHADOW_BLUR,
  DEFAULT_SHADOW_COLOR,
  DEFAULT_SHADOW_OFFSET_X,
  DEFAULT_SHADOW_OFFSET_Y,
  DEFAULT_SHADOW_OPACITY,
  detectShapeCorners,
  flipEdge,
  flipItems,
  nudgeEdgeBy,
  resolveEdgeEndpoints,
  reverseEdgeDirection,
  scaleEdgeLength,
  supportsCornerRadius,
} from "../../handlers/whiteboardHandlers";
import WhiteboardFontPicker from "./WhiteboardFontPicker";

const ARROWHEAD_OPTIONS: { value: ArrowheadType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "triangle", label: "Triangle" },
  { value: "triangleOpen", label: "Open" },
  { value: "block", label: "Block" },
  { value: "diamond", label: "Diamond" },
  { value: "circle", label: "Circle" },
];

const WAVE_STYLE_OPTIONS: { value: NonNullable<WhiteboardNode["waveStyle"]>; label: string }[] = [
  { value: "sine", label: "Sine" },
  { value: "cosine", label: "Cosine" },
  { value: "square", label: "Square" },
  { value: "triangle", label: "Triangle" },
  { value: "sawtooth", label: "Sawtooth" },
];

const FUNCTION_PLOT_OPTIONS: { value: FunctionPlotType; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "quadratic", label: "Quadratic" },
  { value: "cubic", label: "Cubic" },
  { value: "sine", label: "Sine" },
  { value: "cosine", label: "Cosine" },
  { value: "exponential", label: "Exponential" },
  { value: "sqrt", label: "Square Root" },
  { value: "logarithm", label: "Logarithm" },
  { value: "absolute", label: "Absolute Value" },
];

// Quick-start formulas for a "graph" node's Expression field (see WhiteboardNode.graphExpression's
// own doc comment) - picking one just fills the text field with that formula, it's still freely
// editable afterward. Not an exhaustive/enforced list the way FUNCTION_PLOT_OPTIONS is for
// "functionPlot" - "graph" accepts any formula compileGraphExpression can parse, this is only a
// convenience starting point for the common ones.
const GRAPH_EXPRESSION_PRESETS: { value: string; label: string }[] = [
  { value: "x", label: "Linear: x" },
  { value: "x^2", label: "Quadratic: x^2" },
  { value: "x^3", label: "Cubic: x^3" },
  { value: "sin(x)", label: "Sine: sin(x)" },
  { value: "cos(x)", label: "Cosine: cos(x)" },
  { value: "tan(x)", label: "Tangent: tan(x)" },
  { value: "exp(x)", label: "Exponential: e^x" },
  { value: "ln(x)", label: "Natural log: ln(x)" },
  { value: "sqrt(x)", label: "Square root: sqrt(x)" },
  { value: "abs(x)", label: "Absolute value: abs(x)" },
  { value: "1/x", label: "Reciprocal: 1/x" },
];

const LINE_STYLE_OPTIONS: { value: WhiteboardEdge["strokeStyle"]; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

const ROUTING_OPTIONS: { value: WhiteboardEdge["routing"]; label: string }[] = [
  { value: "straight", label: "Straight" },
  { value: "orthogonal", label: "Orthogonal" },
  { value: "curved", label: "Curved" },
];

type ShadowStylePatch = Pick<
  WhiteboardNode,
  "shadowEnabled" | "shadowColor" | "shadowOpacity" | "shadowBlur" | "shadowOffsetX" | "shadowOffsetY"
>;

const SHADOW_PRESETS: {
  name: string;
  config?: ShadowStylePatch;
  makeConfig?: (n: { strokeColor?: string; fillColor?: string | null }) => ShadowStylePatch;
}[] = [
  { name: "Soft", config: { shadowEnabled: true, shadowColor: "#000000", shadowOpacity: 0.18, shadowBlur: 12, shadowOffsetX: 0, shadowOffsetY: 4 } },
  { name: "Medium", config: { shadowEnabled: true, shadowColor: "#000000", shadowOpacity: 0.28, shadowBlur: 20, shadowOffsetX: 0, shadowOffsetY: 8 } },
  { name: "Floating", config: { shadowEnabled: true, shadowColor: "#000000", shadowOpacity: 0.35, shadowBlur: 32, shadowOffsetX: 0, shadowOffsetY: 16 } },
  {
    name: "Glow",
    makeConfig: (n) => ({
      shadowEnabled: true,
      shadowColor:
        n.strokeColor && n.strokeColor !== "#000000" && n.strokeColor !== "#111111"
          ? n.strokeColor
          : n.fillColor && n.fillColor !== "#ffffff"
          ? n.fillColor
          : "#3b82f6",
      shadowOpacity: 0.55,
      shadowBlur: 18,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    }),
  },
  { name: "Retro", config: { shadowEnabled: true, shadowColor: "#000000", shadowOpacity: 0.85, shadowBlur: 0, shadowOffsetX: 5, shadowOffsetY: 5 } },
];

interface WhiteboardStylePanelProps {
  selectedNodes: WhiteboardNode[];
  selectedEdges: WhiteboardEdge[];
  pageNodes?: WhiteboardNode[];
  // The active cell/row/column range within a selected "table" node (or null) - lifted up from
  // WhiteboardTable.tsx via WhiteboardCanvas.tsx/WhiteboardEditor.tsx (see their own doc comments on
  // this same field). Only acted on below when it names the SAME node currently selected here - a
  // stale range left over from a table that's no longer selected shouldn't resurrect its own "Cell"
  // controls.
  tableRangeSelection: { nodeId: string; range: { r0: number; c0: number; r1: number; c1: number } } | null;
  onBatchEditNodes: (before: WhiteboardNode[], after: WhiteboardNode[]) => void;
  onEditEdge: (before: WhiteboardEdge, after: WhiteboardEdge) => void;
  onBatchEditEdges?: (before: WhiteboardEdge[], after: WhiteboardEdge[]) => void;
  // Shapes and connectors edited together as one undo step - flipping/nudging a mixed selection.
  onBatchEditItems?: (beforeNodes: WhiteboardNode[], afterNodes: WhiteboardNode[], beforeEdges: WhiteboardEdge[], afterEdges: WhiteboardEdge[]) => void;
  onDeleteNode: (node: WhiteboardNode) => void;
  onDeleteEdge: (edge: WhiteboardEdge) => void;
  onDuplicateNode: (node: WhiteboardNode) => void;
  onDuplicateEdge?: (edge: WhiteboardEdge) => void;
  onBringToFront: () => void;
  onBringForward?: () => void;
  onSendBackward?: () => void;
  onSendToBack: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  // Swaps the bitmap behind an existing "image" node, keeping its box, crop and styling. Owned by
  // WhiteboardEditor (it has the file dialog and the whiteboard id this asset is imported into);
  // absent simply hides the "Replace image…" button rather than showing one that can't work.
  onReplaceImage?: (node: WhiteboardNode) => void;
  onRemoveBackground?: (node: WhiteboardNode) => void;
  isRemovingBackground?: boolean;
  // Crop mode, owned by WhiteboardEditor so this panel's Crop button and the canvas's own
  // double-click gesture drive the same state rather than each having their own.
  croppingNodeId?: string | null;
  onToggleCrop?: (node: WhiteboardNode) => void;
  // Display-only preview of a patch applied to the current selection, for sliders to update the
  // canvas in real time mid-drag. null clears it. Never reaches the store, so a whole drag still
  // commits as one undo step - see LiveRangeSlider's own doc comment for why that split is
  // load-bearing rather than a nicety.
  onPreviewNodes?: (patch: Partial<WhiteboardNode> | null) => void;
  onPreviewEdges?: (patch: Partial<WhiteboardEdge> | null) => void;
  // Opens the image picker for an "image" fill and imports the choice into this whiteboard's
  // assets/ folder, resolving to the stored asset file name (null if cancelled). Owned by
  // WhiteboardEditor for the same reason onReplaceImage is.
  onPickFillImage?: () => Promise<string | null>;
  // Resolves an asset file name to a displayable URL - the image-fill thumbnail in the Fill section.
  assetUrlFor?: (fileName: string) => string | null;
  // Saves an exported lattice loop through a native save dialog; resolves false if cancelled.
  onSaveExport?: (bytes: Uint8Array, extension: "mp4" | "gif") => Promise<boolean>;
  // Offsets panel to make room for an open WhiteboardLayerPanel beside it
  offsetRight?: boolean;
}

// A plain `value={n}`-controlled number input re-clamps AND redraws its own text on every
// keystroke, which fights typing a multi-digit value: e.g. typing "12" over a clamped-to-8 field
// commits "1" then immediately force-overwrites the field's own text back to "8" before the second
// digit ever lands. This instead tracks the raw typed text locally and never rewrites it out from
// under the user mid-edit (only a fully separate node selection - via the `key={selectedNodes[0].id}`
// callers pass - resets it); every keystroke that already parses to a valid number still commits
// immediately (clamped) so the canvas updates live as you type, same as every other field in this
// panel (Stroke width, Sides, Font size, ...) already does on every change. Only an unparsable or
// empty in-progress value (a bare "-", a cleared field) skips committing until it resolves; blur/
// Enter then normalizes the visible text to whatever finally committed. Also re-syncs its displayed
// text from `initialValue` whenever that changes from OUTSIDE this field (e.g. a paired range
// slider driving the same value, like the angle-length sliders) - but only while unfocused, so that
// external sync never fights the in-progress typing the paragraph above protects.
import {
  ChartDataField,
  CHECKBOX_CLASS,
  ClampedNumberField,
  ColorField,
  Field,
  FIELD_INPUT_CLASS,
  FOOTER_BUTTON_CLASS,
  HexColorInput,
  INPUT_SURFACE_CLASS,
  LiveRangeSlider,
  MAX_STROKE_WIDTH,
  MINI_BUTTON_CLASS,
  NudgeBar,
  NUMBER_INPUT_CLASS,
  PrefixedNumber,
  SegmentButton,
  Segmented,
  SELECT_CLASS,
  SLIDER_CLASS,
  SliderField,
  TransformBlock,
} from "./WhiteboardStylePrimitives";
import { FillControls } from "./WhiteboardFillControls";

const SHAPE_DISPLAY_NAME: Partial<Record<WhiteboardNode["shapeType"], string>> = {
  waterfallChart: "Waterfall plot",
  barChart: "Bar chart",
  lineChart: "Line chart",
  pieChart: "Pie chart",
  scatterPlot: "Scatter plot",
  functionPlot: "Function plot",
  numberLine: "Number line",
  latticeGauge: "Lattice gauge",
  bondLine: "Bond-line chain",
  unitCircle: "Unit circle",
  benzeneRing: "Benzene ring",
  predefinedProcess: "Predefined process",
  manualInput: "Manual input",
  internalStorage: "Internal storage",
  lightningBolt: "Lightning bolt",
  halfCircle: "Half circle",
  minusSign: "Minus",
  multiplySign: "Multiply",
  divideSign: "Divide",
  equalsSign: "Equals",
  greaterThanSign: "Greater than",
  lessThanSign: "Less than",
  greaterEqualSign: "Greater or equal",
  lessEqualSign: "Less or equal",
  equation: "Maths (LaTeX)",
  icon: "Icon",
  folder: "Folder",
  freehand: "Ink stroke",
  image: "Image",
};

function shapeLabel(shapeType: WhiteboardNode["shapeType"]): string {
  const named = SHAPE_DISPLAY_NAME[shapeType];
  if (named) return named;
  const words = shapeType.replace(/([A-Z])/g, " $1").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// A titled group of related rows. Sections are what turn a long scroll of controls into something
// skimmable - without them every field competes equally for attention regardless of how often it's
// actually reached for. Titled sections collapse on a click of their header, and remember that per
// title across selections and sessions: a researcher who never touches Text styling on their plots
// folds it away once instead of scrolling past it on every shape forever.
const COLLAPSED_SECTIONS_KEY = "whiteboard.panel.collapsed";
function readCollapsedSections(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function Section({ title, children, dense, action }: { title?: string; children: React.ReactNode; dense?: boolean; action?: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(() => (title ? readCollapsedSections().has(title) : false));
  const toggle = () => {
    if (!title) return;
    setCollapsed((prev) => {
      const next = !prev;
      try {
        const set = readCollapsedSections();
        if (next) set.add(title);
        else set.delete(title);
        localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...set]));
      } catch {
        // Storage unavailable - the fold still works for this session.
      }
      return next;
    });
  };
  return (
    // :has() hides a section whose children all rendered nothing (a "Shape" section for a plain
    // ellipse) - cheaper and less fragile than predicting at every call site which controls apply.
    <section className="flex flex-col px-3 py-2.5 border-b border-black/[0.05] dark:border-white/[0.06] last:border-b-0 [&:not(:has(.wb-section-body>*))]:hidden">
      {title && (
        <div className="flex items-center h-6 -mx-1 mb-1">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            className="group flex flex-1 min-w-0 items-center gap-1 px-1 h-6 rounded text-[11px] font-semibold text-neutral-800 dark:text-neutral-100 select-none hover:text-neutral-950 dark:hover:text-white"
          >
            <IoChevronDown size={11} className={`shrink-0 text-gray-400 dark:text-neutral-500 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`} />
            <span className="truncate">{title}</span>
          </button>
          {action && !collapsed && <div className="shrink-0 flex items-center">{action}</div>}
        </div>
      )}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"}`}
      >
        <div className={`wb-section-body min-h-0 flex flex-col ${dense ? "gap-1.5" : "gap-2"} ${collapsed ? "overflow-hidden" : ""}`}>{children}</div>
      </div>
    </section>
  );
}

import {
  AnnotationFields,
  ChartTitleFields,
  ColormapSwatch,
  FigureLayoutFields,
  LatticeLabelFields,
  LatticeMotionFields,
  PlotAxesFields,
  SeriesColorList,
  SeriesDataField,
  TableCellFields,
  TableStructureFields,
} from "./WhiteboardScientificFields";
import { EdgeRotateField, ImageFields } from "./WhiteboardImageAndEdgeFields";

const WhiteboardStylePanel: React.FC<WhiteboardStylePanelProps> = ({
  selectedNodes,
  selectedEdges,
  pageNodes = [],
  tableRangeSelection,
  onBatchEditNodes,
  onEditEdge,
  onBatchEditEdges,
  onBatchEditItems,
  onDeleteNode,
  onDeleteEdge,
  onDuplicateNode,
  onDuplicateEdge,
  onBringToFront,
  onBringForward,
  onSendBackward,
  onSendToBack,
  onGroup,
  onUngroup,
  onReplaceImage,
  onRemoveBackground,
  isRemovingBackground,
  croppingNodeId,
  onToggleCrop,
  onPreviewNodes,
  onPreviewEdges,
  onPickFillImage,
  assetUrlFor,
  onSaveExport,
  offsetRight,
}) => {
  const updateNodes = (patch: Partial<WhiteboardNode>) => {
    if (selectedNodes.length === 0) return;
    onBatchEditNodes(selectedNodes, selectedNodes.map((n) => ({ ...n, ...patch })));
  };

  // Mirrors the whole selection - shapes AND any selected connectors - across its combined bounding
  // box center (see flipItems), as one undo step.
  const flipSelected = (axis: "horizontal" | "vertical") => {
    if (selectedNodes.length === 0 && selectedEdges.length === 0) return;
    const flipped = flipItems(selectedNodes, selectedEdges, axis, nodesById);
    if (selectedEdges.length > 0 && onBatchEditItems) onBatchEditItems(selectedNodes, flipped.nodes, selectedEdges, flipped.edges);
    else onBatchEditNodes(selectedNodes, flipped.nodes);
  };

  // Builds the live-preview callback for one node field - every slider gets one, so dragging updates
  // the shape on the canvas immediately while still committing exactly once on release.
  const previewField = (key: keyof WhiteboardNode) => (n: number | null) =>
    onPreviewNodes?.(n === null ? null : ({ [key]: n } as Partial<WhiteboardNode>));

  // Shifts every selected node by the same (dx, dy) in document space - the manual on-panel
  // counterpart to WhiteboardCanvas.tsx's arrow-key nudge (same 1px/10px-with-Shift step sizing),
  // for when a mouse/trackpad is more convenient than reaching for the keyboard, or for
  // sub-pixel-precision alignment work where holding an arrow key's repeat rate is too coarse to
  // stop exactly where intended. A relative shift (not an absolute position) so it stays meaningful
  // for a multi-selection of nodes that don't share one position.
  const nudgeSelected = (dx: number, dy: number) => {
    if (selectedNodes.length === 0) return;
    const movedNodes = selectedNodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy }));
    if (selectedEdges.length > 0 && onBatchEditItems) onBatchEditItems(selectedNodes, movedNodes, selectedEdges, selectedEdges.map((e) => nudgeEdgeBy(e, dx, dy)));
    else onBatchEditNodes(selectedNodes, movedNodes);
  };

  const edge = selectedEdges.length === 1 ? selectedEdges[0] : null;
  const firstEdge = selectedEdges[0] ?? null;
  const edgeIds = selectedEdges.map((e) => e.id).join(",");
  const nodesById = React.useMemo(() => new Map(pageNodes.map((n) => [n.id, n])), [pageNodes]);
  const edgeEndpoints = edge ? resolveEdgeEndpoints(edge, nodesById) : null;
  const edgeLength = edgeEndpoints
    ? Math.round(Math.hypot(edgeEndpoints.target.x - edgeEndpoints.source.x, edgeEndpoints.target.y - edgeEndpoints.source.y))
    : 0;

  const updateEdge = (patch: Partial<WhiteboardEdge>) => {
    if (selectedEdges.length === 0) return;
    if (selectedEdges.length === 1) {
      onEditEdge(selectedEdges[0], { ...selectedEdges[0], ...patch });
    } else if (onBatchEditEdges) {
      onBatchEditEdges(selectedEdges, selectedEdges.map((e) => ({ ...e, ...patch })));
    } else {
      selectedEdges.forEach((e) => onEditEdge(e, { ...e, ...patch }));
    }
  };

  const transformEdges = (fn: (e: WhiteboardEdge) => WhiteboardEdge) => {
    if (selectedEdges.length === 0) return;
    if (selectedEdges.length === 1) {
      onEditEdge(selectedEdges[0], fn(selectedEdges[0]));
    } else if (onBatchEditEdges) {
      onBatchEditEdges(selectedEdges, selectedEdges.map(fn));
    } else {
      selectedEdges.forEach((e) => onEditEdge(e, fn(e)));
    }
  };

  const previewEdgeField = (key: keyof WhiteboardEdge) => (n: number | null) =>
    onPreviewEdges?.(n === null ? null : ({ [key]: n } as Partial<WhiteboardEdge>));

  const singleIcon = selectedNodes.length === 1 && selectedNodes[0].shapeType === "icon";
  const [iconQuery, setIconQuery] = React.useState("");
  const matchingIcons = React.useMemo(
    () => (singleIcon ? searchIcons(iconQuery).filter((i) => i.value !== "none") : []),
    [singleIcon, iconQuery]
  );

  if (selectedNodes.length === 0 && selectedEdges.length === 0) return null;

  // Freehand ink and the lattice widget carry no text, so the Text group only shows when some
  // selected shape can show text.
  const hasText = selectedNodes.some((n) => n.shapeType !== "freehand" && n.shapeType !== "latticeGauge" && n.shapeType !== "icon");
  const allText = selectedNodes.length > 0 && selectedNodes.every((n) => n.shapeType === "text");
  const singleEquation = selectedNodes.length === 1 && selectedNodes[0].shapeType === "equation";

  // Shapes whose interior takes the full fill paint (gradient/image/pattern). Charts, tables and
  // images keep the plain color well: their "fill" is bar color / cell background / letterbox matte,
  // where a gradient or a photo has no sensible meaning.
  const canPaintFill = (n: WhiteboardNode) =>
    !["text", "freehand", "image", "table", "latticeGauge", "icon"].includes(n.shapeType) && !LINE_ONLY_SHAPES.has(n.shapeType) && !CHART_DATA_SHAPES.has(n.shapeType);
  const hasFill = selectedNodes.some((n) => n.shapeType !== "freehand" && !LINE_ONLY_SHAPES.has(n.shapeType));
  const ids = selectedNodes.map((n) => n.id).join(",");
  const allLocked =
    selectedNodes.length > 0
      ? selectedNodes.every((n) => n.locked ?? false)
      : selectedEdges.length > 0 && selectedEdges.every((e) => e.locked ?? false);

  const canShowStylePresets =
    selectedNodes.length > 0 &&
    !allText &&
    !singleEquation &&
    !singleIcon &&
    selectedNodes.every(canPaintFill) &&
    selectedNodes.every((n) => n.shapeType !== "artboard");

  const hasMindmapTopic = selectedNodes.some(
    (n) => n.shapeType === "mindmapTopic" || n.shapeType === "mindmapSubtopic"
  );
  const showDoneBadgeSection = hasMindmapTopic || selectedNodes.some((n) => n.mindmapProgress === "done");
  const allShowDoneBadge = selectedNodes.length > 0 && selectedNodes.every((n) => n.mindmapShowDoneBadge !== false);

  return (
    <div className={`absolute top-3 ${offsetRight ? "right-[278px]" : "right-3"} bottom-3 w-[300px] bg-white dark:bg-neutral-900 ring-1 ring-black/[0.07] dark:ring-white/[0.08] rounded-2xl shadow-[0_12px_40px_-12px_rgba(0,0,0,0.18),0_2px_6px_-2px_rgba(0,0,0,0.06)] flex flex-col overflow-hidden text-neutral-800 dark:text-neutral-200 transition-all duration-200 animate-[wbPanelIn_180ms_ease-out]`}>
      <style>{"@keyframes wbPanelIn{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}"}</style>
      {/* Sticky header - a long panel scrolls well past its own top, and without this there's no
          persistent indication of WHAT the controls below are acting on. */}
      <div className="shrink-0 px-3 h-11 flex items-center gap-2 border-b border-black/[0.05] dark:border-white/[0.06]">
        <p className="text-[13px] font-semibold tracking-tight truncate">
          {selectedNodes.length > 0 && selectedEdges.length > 0
            ? `${selectedNodes.length} ${selectedNodes.length === 1 ? "shape" : "shapes"} + ${selectedEdges.length} ${selectedEdges.length === 1 ? "connector" : "connectors"}`
            : selectedNodes.length > 1
            ? `${selectedNodes.length} shapes`
            : selectedNodes.length === 1
              ? shapeLabel(selectedNodes[0].shapeType)
              : selectedEdges.length > 1
                ? `${selectedEdges.length} connectors`
                : "Connector"}
        </p>
        {selectedNodes.length === 1 && (
          <span className="ml-auto shrink-0 px-1.5 h-5 flex items-center rounded bg-black/[0.04] dark:bg-white/[0.06] text-[10px] font-medium tabular-nums text-neutral-500 dark:text-neutral-400">
            {Math.round(selectedNodes[0].width)} × {Math.round(selectedNodes[0].height)}
          </span>
        )}
        {selectedNodes.length === 0 && edge && (
          <span className="ml-auto shrink-0 px-1.5 h-5 flex items-center rounded bg-black/[0.04] dark:bg-white/[0.06] text-[10px] font-medium tabular-nums text-neutral-500 dark:text-neutral-400">
            {edgeLength} px
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col [scrollbar-width:thin]">
      {/* Mind Map Progress & Done Badge toggle */}
      {showDoneBadgeSection && (
        <Section title="Progress & Badge" dense>
          {hasMindmapTopic && (
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ["done", "Done", "border-emerald-500 bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"],
                  ["in-progress", "In progress", "border-amber-500 bg-amber-50 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300"],
                  ["skipped", "Skipped", "border-neutral-400 bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200"],
                  ["pending", "Pending", "border-blue-500 bg-blue-50 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300"],
                ] as const
              ).map(([value, label, activeClass]) => {
                const active = selectedNodes.every((n) => (n.mindmapProgress ?? "pending") === value);
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => updateNodes({ mindmapProgress: value })}
                    className={`h-6 px-2 rounded-full text-[11px] font-medium border transition ${
                      active
                        ? activeClass
                        : "border-black/[0.08] dark:border-white/[0.1] text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <span className="text-[11px] text-neutral-600 dark:text-neutral-300">Show Done badge</span>
            <button
              type="button"
              role="switch"
              aria-checked={allShowDoneBadge}
              onClick={() => updateNodes({ mindmapShowDoneBadge: !allShowDoneBadge })}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                allShowDoneBadge ? "bg-emerald-500" : "bg-neutral-200 dark:bg-neutral-700"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                  allShowDoneBadge ? "translate-x-[18px]" : "translate-x-[3px]"
                }`}
              />
            </button>
          </div>
        </Section>
      )}
      {/* Realtime LaTeX Maths editor at the top of the panel when an Equation is selected */}
      {singleEquation && (
        <Section title="Equation (LaTeX)" dense>
          <WhiteboardMathEditor
            node={selectedNodes[0]}
            onCommit={updateNodes}
            onPreview={onPreviewNodes}
          />
          <div className="flex items-center gap-1.5 pt-1 border-t border-black/[0.05] dark:border-white/[0.06]">
            <div className="flex-1">
              <ColorField label="Ink" value={selectedNodes[0].fontColor} onChange={(fontColor) => updateNodes({ fontColor })} />
            </div>
            <div className="w-[78px] shrink-0">
              <PrefixedNumber
                prefix={<TbTextSize size={12} />}
                title="Equation size - drag the icon to scrub"
                resetKey={`${ids}-eqfs`}
                value={selectedNodes[0].fontSize}
                min={10}
                max={240}
                onCommit={(fontSize) => updateNodes({ fontSize })}
              />
            </div>
          </div>
        </Section>
      )}
      {/* Searchable Icon switcher at the top of the panel when a vector Icon node is selected */}
      {singleIcon && (
        <Section title="Icon" dense>
          <input
            type="text"
            value={iconQuery}
            onChange={(e) => setIconQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && matchingIcons.length > 0) {
                updateNodes({ iconName: matchingIcons[0].value as StickerIcon });
              }
            }}
            placeholder="Find an icon…"
            className={`w-full h-7 px-2 ${INPUT_SURFACE_CLASS} text-[12px]`}
          />
          <div className="grid grid-cols-6 gap-1 max-h-36 overflow-y-auto [scrollbar-width:thin] pr-0.5">
            {matchingIcons.map((ic) => {
              const active = selectedNodes[0].iconName === ic.value;
              return (
                <button
                  key={ic.value}
                  type="button"
                  title={ic.label}
                  onClick={() => updateNodes({ iconName: ic.value as StickerIcon })}
                  className={`h-8 rounded-md flex items-center justify-center p-1.5 transition-colors ${
                    active
                      ? "bg-blue-600 text-white"
                      : "bg-black/[0.04] dark:bg-white/[0.06] text-neutral-700 dark:text-neutral-200 hover:bg-blue-500/15 hover:text-blue-600"
                  }`}
                >
                  <WhiteboardIconGlyph icon={ic.value} size={16} />
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[11px] text-neutral-500 dark:text-neutral-400">Badge background</span>
            {selectedNodes[0].fillColor ? (
              <button
                type="button"
                onClick={() => updateNodes({ fillColor: null })}
                className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
              >
                Clear
              </button>
            ) : (
              <button
                type="button"
                onClick={() => updateNodes({ fillColor: "#eff6ff", strokeColor: "#2563eb", cornerRadius: 16 })}
                className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
              >
                Add badge
              </button>
            )}
          </div>
        </Section>
      )}
      {/* Visual-first top section: 1-click designer Style Presets for fillable shapes */}
      {canShowStylePresets && (
        <Section title="Presets" dense>
          <div className="grid grid-cols-6 gap-1.5">
            {NODE_STYLE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={`Apply ${preset.label} style`}
                onClick={() => updateNodes(preset.patch)}
                className="h-7 rounded-md text-[10px] font-semibold flex items-center justify-center transition-transform hover:scale-105 active:scale-95 shadow-sm"
                style={{
                  backgroundColor: preset.patch.fillColor ?? "#ffffff",
                  border: `1.5px solid ${preset.patch.strokeColor ?? "#cbd5e1"}`,
                  color: preset.patch.fontColor ?? "#0f172a",
                }}
              >
                Aa
              </button>
            ))}
          </div>
        </Section>
      )}
      {/* When editing pure Text nodes, put Typography FIRST at the top of the panel instead of
          burying it below Arrange/Stroke/Shadow. */}
      {allText && (
        <Section title="Text" dense>
          <div className="flex items-center gap-1.5">
            <div className="flex-1 min-w-0">
              <WhiteboardFontPicker value={selectedNodes[0].fontFamily} onChange={(fontFamily) => updateNodes({ fontFamily })} />
            </div>
            <div className="w-[76px] shrink-0 ml-auto">
              <PrefixedNumber
                prefix={<TbTextSize size={12} />}
                title="Font size - drag the icon to scrub"
                resetKey={`${ids}-fs-top`}
                value={selectedNodes[0].fontSize}
                min={6}
                max={400}
                onCommit={(fontSize) => updateNodes({ fontSize })}
              />
            </div>
          </div>
          <ColorField label="Color" value={selectedNodes[0].fontColor} onChange={(fontColor) => updateNodes({ fontColor })} />
          <div className="flex items-center justify-between gap-1.5">
            <Segmented>
              <SegmentButton
                active={selectedNodes[0].fontWeight === "bold"}
                onClick={() => updateNodes({ fontWeight: selectedNodes[0].fontWeight === "bold" ? "normal" : "bold" })}
                title="Bold (Ctrl+B)"
              >
                <TbBold size={13} />
              </SegmentButton>
              <SegmentButton
                active={selectedNodes[0].fontStyle === "italic"}
                onClick={() => updateNodes({ fontStyle: selectedNodes[0].fontStyle === "italic" ? "normal" : "italic" })}
                title="Italic (Ctrl+I)"
              >
                <TbItalic size={13} />
              </SegmentButton>
              <SegmentButton
                active={selectedNodes[0].textDecoration === "underline"}
                onClick={() => updateNodes({ textDecoration: selectedNodes[0].textDecoration === "underline" ? "none" : "underline" })}
                title="Underline (Ctrl+U)"
              >
                <TbUnderline size={13} />
              </SegmentButton>
            </Segmented>
            <Segmented>
              {(["left", "center", "right"] as const).map((align) => (
                <SegmentButton key={align} active={selectedNodes[0].textAlign === align} onClick={() => updateNodes({ textAlign: align })} title={`Align ${align}`}>
                  {align === "left" ? <TbAlignLeft size={13} /> : align === "center" ? <TbAlignCenter size={13} /> : <TbAlignRight size={13} />}
                </SegmentButton>
              ))}
            </Segmented>
          </div>
          <Field label="Vertical">
            <Segmented>
              {(["top", "middle", "bottom"] as const).map((align) => (
                <SegmentButton key={align} active={selectedNodes[0].verticalAlign === align} onClick={() => updateNodes({ verticalAlign: align })} title={`Align ${align}`}>
                  {align === "top" ? <TbLayoutAlignTop size={13} /> : align === "middle" ? <TbLayoutAlignMiddle size={13} /> : <TbLayoutAlignBottom size={13} />}
                </SegmentButton>
              ))}
            </Segmented>
          </Field>
          <Field label="Blend">
            <select
              value={selectedNodes[0].blendMode ?? "normal"}
              onChange={(e) => {
                const v = e.target.value as WhiteboardBlendMode;
                updateNodes({ blendMode: v === "normal" ? undefined : v });
              }}
              className={`w-[144px] shrink-0 h-7 pl-2 pr-1 ${INPUT_SURFACE_CLASS} text-[12px] cursor-pointer`}
              title="How this text blends with layers underneath it (e.g. Multiply, Screen, Overlay, Difference)"
            >
              {WHITEBOARD_BLEND_MODES.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
        </Section>
      )}

      {selectedNodes.length === 1 && selectedNodes[0].shapeType === "image" && (
        <Section title="Image" dense>
          <ImageFields
            node={selectedNodes[0]}
            updateNodes={updateNodes}
            onReplace={onReplaceImage ? () => onReplaceImage(selectedNodes[0]) : () => {}}
            onRemoveBackground={onRemoveBackground ? () => onRemoveBackground(selectedNodes[0]) : undefined}
            isRemovingBackground={isRemovingBackground}
            cropping={croppingNodeId === selectedNodes[0].id}
            onToggleCrop={onToggleCrop ? () => onToggleCrop(selectedNodes[0]) : undefined}
            previewField={previewField}
            onPreviewNodes={onPreviewNodes}
          />
        </Section>
      )}

      {selectedNodes.length > 0 && hasFill && (
        <Section title={allText ? "Background" : "Fill"} dense>
          {allText ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-neutral-500 dark:text-neutral-400">Highlight pill</span>
                {selectedNodes[0].fillColor ? (
                  <button
                    type="button"
                    onClick={() => updateNodes({ fillColor: null })}
                    className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Clear
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => updateNodes({ fillColor: "#fef08a", cornerRadius: selectedNodes[0].cornerRadius || 6 })}
                    className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Add background
                  </button>
                )}
              </div>
              {selectedNodes[0].fillColor && (
                <ColorField label="Color" value={selectedNodes[0].fillColor} onChange={(fillColor) => updateNodes({ fillColor })} />
              )}
              {(selectedNodes[0].fillColor || selectedNodes[0].strokeWidth > 0) && (
                <SliderField
                  label="Radius"
                  resetKey={`tr-${ids}`}
                  value={selectedNodes[0].cornerRadius ?? 6}
                  min={0}
                  max={32}
                  step={1}
                  onCommit={(cornerRadius) => updateNodes({ cornerRadius })}
                  onPreview={previewField("cornerRadius")}
                  title="Corner radius for text background / outline box"
                />
              )}
            </>
          ) : selectedNodes.every(canPaintFill) ? (
            <FillControls nodes={selectedNodes} updateNodes={updateNodes} onPreviewNodes={onPreviewNodes} onPickFillImage={onPickFillImage} assetUrlFor={assetUrlFor} />
          ) : (
            <>
              <ColorField label="Color" value={selectedNodes[0].fillColor ?? "#ffffff"} onChange={(fillColor) => updateNodes({ fillColor })} />
              <SliderField
                label="Opacity"
                resetKey={`fo-${ids}`}
                value={Math.round((selectedNodes[0].fillOpacity ?? 1) * 100)}
                min={0}
                max={100}
                step={1}
                onCommit={(n) => updateNodes({ fillOpacity: n >= 100 ? undefined : n / 100, fillColor: selectedNodes[0].fillColor ?? "#ffffff" })}
                onPreview={(n) => onPreviewNodes?.(n === null ? null : { fillOpacity: n / 100, fillColor: selectedNodes[0].fillColor ?? "#ffffff" })}
                title="100% is a solid fill, 0% fully see-through - the outline and text are unaffected"
              />
            </>
          )}
        </Section>
      )}

      {selectedNodes.length > 0 && selectedNodes.every((n) => n.shapeType !== "latticeGauge") && (
        <Section
          title={selectedNodes.every((n) => n.shapeType === "freehand") ? "Ink" : allText ? "Stroke / Outline" : "Stroke"}
          dense
          action={
            allText && selectedNodes[0].strokeWidth > 0 ? (
              <button
                type="button"
                onClick={() => updateNodes({ strokeWidth: 0 })}
                className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
              >
                None
              </button>
            ) : allText ? (
              <button
                type="button"
                onClick={() => updateNodes({ strokeWidth: 1.5, cornerRadius: selectedNodes[0].cornerRadius || 6 })}
                className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
              >
                Add outline
              </button>
            ) : undefined
          }
        >
          <ColorField label="Color" value={selectedNodes[0].strokeColor} onChange={(strokeColor) => updateNodes({ strokeColor })} />
          {/* The slider's top end scales with the shape itself. A fixed max of 12 is right for a
              flowchart box, but meaningless on a 3000px-wide imported screenshot, where a 12px
              ring is a hairline - the control looked like it was doing nothing. Quarter of the
              shorter side is the point past which a ring stops reading as a border and starts
              eating the shape. The numeric field beside it accepts any value regardless, so the
              slider's range is a convenience, never a ceiling. */}
          {(() => {
            const minWidth = selectedNodes.every((n) => n.shapeType === "freehand") ? 1 : 0;
            const shortestSide = Math.min(...selectedNodes.map((n) => Math.min(n.width, n.height)));
            const sliderMax = Math.max(12, Math.round(shortestSide / 4));
            return (
              <SliderField
                label="Width"
                resetKey={`sw-${ids}`}
                value={selectedNodes[0].strokeWidth}
                min={minWidth}
                max={MAX_STROKE_WIDTH}
                sliderMax={sliderMax}
                step={sliderMax > 40 ? 1 : 0.5}
                onCommit={(n) => updateNodes({ strokeWidth: n })}
                onPreview={previewField("strokeWidth")}
                title="Exact width in document units - type any value; the slider beside it is only a convenience range"
              />
            );
          })()}
          {!selectedNodes.every((n) => n.shapeType === "freehand") && (
            <Field label="Style">
              <Segmented>
                {LINE_STYLE_OPTIONS.map((opt) => (
                  <SegmentButton
                    key={opt.value}
                    active={(selectedNodes[0].strokeStyle ?? "solid") === opt.value}
                    onClick={() => updateNodes({ strokeStyle: opt.value })}
                    title={opt.label}
                  >
                    <svg width={18} height={8} viewBox="0 0 18 8">
                      <line
                        x1={1}
                        y1={4}
                        x2={17}
                        y2={4}
                        stroke="currentColor"
                        strokeWidth={1.75}
                        strokeLinecap="round"
                        strokeDasharray={opt.value === "dashed" ? "4 3" : opt.value === "dotted" ? "0.1 3.5" : undefined}
                      />
                    </svg>
                  </SegmentButton>
                ))}
              </Segmented>
            </Field>
          )}
          <SliderField
            label="Opacity"
            resetKey={`so-${ids}`}
            value={Math.round((selectedNodes[0].strokeOpacity ?? 1) * 100)}
            min={0}
            max={100}
            step={1}
            onCommit={(n) => updateNodes({ strokeOpacity: n >= 100 ? undefined : n / 100 })}
            onPreview={(n) => onPreviewNodes?.(n === null ? null : { strokeOpacity: n / 100 })}
            title="Stroke opacity (100% solid, 0% invisible border)"
          />
        </Section>
      )}

      {selectedNodes.length > 0 && selectedNodes.every((n) => n.shapeType !== "latticeGauge") && (
        <Section
          title="Shadow"
          dense
          action={
            <button
              type="button"
              onClick={() => {
                const isEnabled = selectedNodes[0].shadowEnabled ?? false;
                const next = !isEnabled;
                updateNodes({
                  shadowEnabled: next,
                  ...(next && selectedNodes[0].shadowBlur === undefined
                    ? {
                        shadowColor: DEFAULT_SHADOW_COLOR,
                        shadowOpacity: DEFAULT_SHADOW_OPACITY,
                        shadowBlur: DEFAULT_SHADOW_BLUR,
                        shadowOffsetX: DEFAULT_SHADOW_OFFSET_X,
                        shadowOffsetY: DEFAULT_SHADOW_OFFSET_Y,
                      }
                    : {}),
                });
              }}
              className={`p-1 rounded transition ${
                selectedNodes[0].shadowEnabled
                  ? "text-blue-600 dark:text-blue-400 hover:bg-blue-500/10"
                  : "text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              }`}
              title={selectedNodes[0].shadowEnabled ? "Disable shadow" : "Enable shadow"}
            >
              {selectedNodes[0].shadowEnabled ? <TbShadow size={15} /> : <TbShadowOff size={15} />}
            </button>
          }
        >
          {selectedNodes[0].shadowEnabled ? (
            <>
              <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] py-0.5">
                {SHADOW_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => {
                      const patch = "makeConfig" in preset && preset.makeConfig ? preset.makeConfig(selectedNodes[0]) : preset.config ?? {};
                      updateNodes(patch);
                    }}
                    className="px-2 py-0.5 shrink-0 rounded text-[11px] font-medium bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.1] text-neutral-600 dark:text-neutral-300 transition active:scale-95"
                    title={`Apply ${preset.name} shadow preset`}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>

              <ColorField
                label="Color"
                value={selectedNodes[0].shadowColor ?? DEFAULT_SHADOW_COLOR}
                onChange={(shadowColor) => updateNodes({ shadowColor })}
              />

              <SliderField
                label="Opacity"
                resetKey={`sho-${ids}`}
                value={Math.round((selectedNodes[0].shadowOpacity ?? DEFAULT_SHADOW_OPACITY) * 100)}
                min={0}
                max={100}
                step={1}
                onCommit={(n) => updateNodes({ shadowOpacity: n / 100 })}
                onPreview={(n) => onPreviewNodes?.(n === null ? null : { shadowOpacity: n / 100 })}
                title="Shadow opacity (0% to 100%)"
              />

              <SliderField
                label="Blur"
                resetKey={`shb-${ids}`}
                value={selectedNodes[0].shadowBlur ?? DEFAULT_SHADOW_BLUR}
                min={0}
                max={64}
                step={1}
                onCommit={(n) => updateNodes({ shadowBlur: n })}
                onPreview={previewField("shadowBlur")}
                title="Shadow blur radius in pixels"
              />

              <Field label="Offset">
                <div className="grid grid-cols-2 gap-1.5 w-full">
                  <PrefixedNumber
                    prefix="X"
                    title="Horizontal shadow offset - drag to scrub"
                    resetKey={`shx-${ids}`}
                    value={selectedNodes[0].shadowOffsetX ?? DEFAULT_SHADOW_OFFSET_X}
                    min={-100}
                    max={100}
                    onCommit={(x) => updateNodes({ shadowOffsetX: x })}
                  />
                  <PrefixedNumber
                    prefix="Y"
                    title="Vertical shadow offset - drag to scrub"
                    resetKey={`shy-${ids}`}
                    value={selectedNodes[0].shadowOffsetY ?? DEFAULT_SHADOW_OFFSET_Y}
                    min={-100}
                    max={100}
                    onCommit={(y) => updateNodes({ shadowOffsetY: y })}
                  />
                </div>
              </Field>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                updateNodes({
                  shadowEnabled: true,
                  shadowColor: selectedNodes[0].shadowColor ?? DEFAULT_SHADOW_COLOR,
                  shadowOpacity: selectedNodes[0].shadowOpacity ?? DEFAULT_SHADOW_OPACITY,
                  shadowBlur: selectedNodes[0].shadowBlur ?? DEFAULT_SHADOW_BLUR,
                  shadowOffsetX: selectedNodes[0].shadowOffsetX ?? DEFAULT_SHADOW_OFFSET_X,
                  shadowOffsetY: selectedNodes[0].shadowOffsetY ?? DEFAULT_SHADOW_OFFSET_Y,
                });
              }}
              className="w-full h-7 rounded-md border border-dashed border-black/15 dark:border-white/15 text-[12px] font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:border-black/30 dark:hover:border-white/30 transition flex items-center justify-center gap-1.5"
            >
              <TbShadow size={14} />
              <span>Add Shadow</span>
            </button>
          )}
        </Section>
      )}

      {selectedNodes.length > 0 && (
        <>
          <Section title="Shape" dense>
          {/* Every straight-edged outline rounds (see whiteboardHandlers.ts's supportsCornerRadius);
              an image only when its mask is "rounded" - showing the slider anywhere else would be a
              control with no visible effect. */}
          {!(selectedNodes.length === 1 && selectedNodes[0].shapeType === "image") && selectedNodes.every(supportsCornerRadius) && (() => {
            const maxRadius = Math.max(1, Math.round(Math.min(selectedNodes[0].width, selectedNodes[0].height) / 2));
            const corners = detectShapeCorners(selectedNodes[0]);
            const buildCornerRadii = (node: WhiteboardNode, cornerIndex: number, nextRadius: number): (number | null)[] => {
              const nodeCorners = detectShapeCorners(node);
              const len = Math.max(nodeCorners.length, cornerIndex + 1);
              return Array.from({ length: len }, (_, i) => (i === cornerIndex ? nextRadius : (node.cornerRadii?.[i] ?? null)));
            };
            return (
              <>
                <SliderField
                  label="Corner radius"
                  resetKey={`cr-${ids}`}
                  value={selectedNodes[0].cornerRadius ?? 0}
                  min={0}
                  max={maxRadius}
                  step={1}
                  onCommit={(n) => updateNodes({ cornerRadius: n, cornerRadii: undefined })}
                  onPreview={(n) => onPreviewNodes?.(n === null ? null : { cornerRadius: n, cornerRadii: undefined })}
                />
                {corners.map((corner) => {
                  const val = selectedNodes[0].cornerRadii?.[corner.index] ?? selectedNodes[0].cornerRadius ?? 0;
                  return (
                    <SliderField
                      key={`${selectedNodes[0].shapeType}-${corner.index}-${corner.label}`}
                      label={corner.label}
                      resetKey={`cr-${ids}-${corner.index}-${selectedNodes[0].cornerRadius ?? 0}`}
                      value={val}
                      min={0}
                      max={maxRadius}
                      step={1}
                      onCommit={(n) => updateNodes({ cornerRadii: buildCornerRadii(selectedNodes[0], corner.index, n) })}
                      onPreview={(n) =>
                        onPreviewNodes?.(
                          n === null ? null : { cornerRadii: buildCornerRadii(selectedNodes[0], corner.index, n) }
                        )
                      }
                    />
                  );
                })}
              </>
            );
          })()}
          {selectedNodes.every((n) => n.shapeType === "polygon") && (
            <Field label="Sides">
              <input
                type="number"
                min={3}
                max={12}
                value={selectedNodes[0].sides ?? 5}
                onChange={(e) => updateNodes({ sides: Math.max(3, Math.min(12, Number(e.target.value))) })}
                className={NUMBER_INPUT_CLASS}
              />
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "bondLine") && (
            <Field label="Bonds">
              <input
                type="number"
                min={1}
                max={20}
                value={selectedNodes[0].sides ?? 5}
                onChange={(e) => updateNodes({ sides: Math.max(1, Math.min(20, Number(e.target.value))) })}
                className={NUMBER_INPUT_CLASS}
              />
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "star") && (
            <>
              <Field label="Points">
                <input
                  type="number"
                  min={3}
                  max={12}
                  value={selectedNodes[0].starPoints ?? 5}
                  onChange={(e) => updateNodes({ starPoints: Math.max(3, Math.min(12, Number(e.target.value))) })}
                  className={NUMBER_INPUT_CLASS}
                />
              </Field>
              <SliderField
                label="Spikiness"
                resetKey={`sp-${selectedNodes.map((n) => n.id).join(",")}`}
                value={selectedNodes[0].starInnerRadiusRatio ?? 0.45}
                min={0.15}
                max={0.85}
                step={0.05}
                onCommit={(n) => updateNodes({ starInnerRadiusRatio: n })}
                onPreview={previewField("starInnerRadiusRatio")}
              />
            </>
          )}
          {selectedNodes.every((n) => n.shapeType === "wave") && (
            <>
              <Field label="Wave">
                <select
                  value={selectedNodes[0].waveStyle ?? "sine"}
                  onChange={(e) => updateNodes({ waveStyle: e.target.value as WhiteboardNode["waveStyle"] })}
                  className={`w-28 h-7 pl-2 pr-1 ${INPUT_SURFACE_CLASS} text-[12px] cursor-pointer`}
                >
                  {WAVE_STYLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Cycles">
                <ClampedNumberField
                  key={selectedNodes[0].id}
                  initialValue={selectedNodes[0].waveCycles ?? DEFAULT_WAVE_CYCLES}
                  min={MIN_WAVE_CYCLES}
                  max={MAX_WAVE_CYCLES}
                  onCommit={(n) => updateNodes({ waveCycles: n })}
                  className={NUMBER_INPUT_CLASS}
                />
              </Field>
            </>
          )}
          {selectedNodes.every((n) => n.shapeType === "angle") && (
            <>
              <Field label="Angle (°)">
                <ClampedNumberField
                  key={selectedNodes[0].id}
                  initialValue={selectedNodes[0].angleDegrees ?? DEFAULT_ANGLE_DEGREES}
                  min={MIN_ANGLE_DEGREES}
                  max={MAX_ANGLE_DEGREES}
                  onCommit={(n) => updateNodes({ angleDegrees: n })}
                  className={NUMBER_INPUT_CLASS}
                />
              </Field>
              <Field label="Side 1">
                <div className="flex items-center gap-1.5">
                  <ClampedNumberField
                    key={selectedNodes[0].id}
                    initialValue={selectedNodes[0].angleRay1Length ?? DEFAULT_ANGLE_RAY_LENGTH}
                    min={MIN_ANGLE_RAY_LENGTH}
                    max={MAX_ANGLE_RAY_LENGTH}
                    step={0.05}
                    integer={false}
                    onCommit={(n) => updateNodes({ angleRay1Length: n })}
                    className={NUMBER_INPUT_CLASS}
                  />
                  <LiveRangeSlider
                    min={MIN_ANGLE_RAY_LENGTH}
                    max={MAX_ANGLE_RAY_LENGTH}
                    step={0.05}
                    value={selectedNodes[0].angleRay1Length ?? DEFAULT_ANGLE_RAY_LENGTH}
                    onCommit={(n) => updateNodes({ angleRay1Length: n })}
                  onPreview={previewField("angleRay1Length")}
                    className={SLIDER_CLASS}
                  />
                </div>
              </Field>
              <Field label="Side 2">
                <div className="flex items-center gap-1.5">
                  <ClampedNumberField
                    key={selectedNodes[0].id}
                    initialValue={selectedNodes[0].angleRay2Length ?? DEFAULT_ANGLE_RAY_LENGTH}
                    min={MIN_ANGLE_RAY_LENGTH}
                    max={MAX_ANGLE_RAY_LENGTH}
                    step={0.05}
                    integer={false}
                    onCommit={(n) => updateNodes({ angleRay2Length: n })}
                    className={NUMBER_INPUT_CLASS}
                  />
                  <LiveRangeSlider
                    min={MIN_ANGLE_RAY_LENGTH}
                    max={MAX_ANGLE_RAY_LENGTH}
                    step={0.05}
                    value={selectedNodes[0].angleRay2Length ?? DEFAULT_ANGLE_RAY_LENGTH}
                    onCommit={(n) => updateNodes({ angleRay2Length: n })}
                  onPreview={previewField("angleRay2Length")}
                    className={SLIDER_CLASS}
                  />
                </div>
              </Field>
            </>
          )}
          {selectedNodes.every((n) => CHART_DATA_SHAPES.has(n.shapeType)) && (
            <Field label="Data">
              <ChartDataField
                key={selectedNodes.map((n) => n.id).join(",")}
                initialValue={selectedNodes[0].chartData ?? DEFAULT_CHART_DATA}
                onCommit={(values) => updateNodes({ chartData: values })}
                className={SELECT_CLASS}
              />
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "functionPlot") && (
            <Field label="Function">
              <select
                value={selectedNodes[0].plotFunction ?? "sine"}
                onChange={(e) => updateNodes({ plotFunction: e.target.value as FunctionPlotType })}
                className={SELECT_CLASS}
              >
                {FUNCTION_PLOT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "functionPlot" && n.plotFunction !== "sine" && n.plotFunction !== "cosine") && (
            <Field label="Zoom">
              <div className="flex items-center gap-1.5">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].plotDomainScale ?? DEFAULT_PLOT_DOMAIN_SCALE}
                  min={MIN_PLOT_DOMAIN_SCALE}
                  max={MAX_PLOT_DOMAIN_SCALE}
                  step={0.25}
                  integer={false}
                  onCommit={(n) => updateNodes({ plotDomainScale: n })}
                  className={NUMBER_INPUT_CLASS}
                />
                <LiveRangeSlider
                  min={MIN_PLOT_DOMAIN_SCALE}
                  max={MAX_PLOT_DOMAIN_SCALE}
                  step={0.25}
                  value={selectedNodes[0].plotDomainScale ?? DEFAULT_PLOT_DOMAIN_SCALE}
                  onCommit={(n) => updateNodes({ plotDomainScale: n })}
                  onPreview={previewField("plotDomainScale")}
                  className={SLIDER_CLASS}
                  title="How much of the x-axis is shown - below 1 zooms in, above 1 zooms out"
                />
              </div>
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "functionPlot" && (n.plotFunction === "sine" || n.plotFunction === "cosine")) && (
            <Field label="Cycles">
              <div className="flex items-center gap-1.5">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].plotCycles ?? DEFAULT_PLOT_CYCLES}
                  min={MIN_PLOT_CYCLES}
                  max={MAX_PLOT_CYCLES}
                  onCommit={(n) => updateNodes({ plotCycles: n })}
                  className={NUMBER_INPUT_CLASS}
                />
                <LiveRangeSlider
                  min={MIN_PLOT_CYCLES}
                  max={MAX_PLOT_CYCLES}
                  value={selectedNodes[0].plotCycles ?? DEFAULT_PLOT_CYCLES}
                  onCommit={(n) => updateNodes({ plotCycles: n })}
                  onPreview={previewField("plotCycles")}
                  className={SLIDER_CLASS}
                  title="How many full wave periods are shown"
                />
              </div>
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "functionPlot") && (
            <>
              <Field label="X interval">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].plotXTickInterval ?? 0}
                  min={0}
                  max={100}
                  step={0.1}
                  integer={false}
                  onCommit={(n) => updateNodes({ plotXTickInterval: n <= 0 ? undefined : n })}
                  className={NUMBER_INPUT_CLASS}
                  title="Spacing between x-axis tick numbers, in this plot's own x units - 0 picks it automatically"
                />
              </Field>
              <Field label="Y interval">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].plotYTickInterval ?? 0}
                  min={0}
                  max={100}
                  step={0.1}
                  integer={false}
                  onCommit={(n) => updateNodes({ plotYTickInterval: n <= 0 ? undefined : n })}
                  className={NUMBER_INPUT_CLASS}
                  title="Spacing between y-axis tick numbers, in this plot's own y units - 0 picks it automatically"
                />
              </Field>
            </>
          )}
          {selectedNodes.every((n) => CHART_LABEL_SHAPES.has(n.shapeType)) && (
            <Field label="Show numbers">
              <input
                type="checkbox"
                checked={selectedNodes[0].showChartLabels ?? true}
                onChange={(e) => updateNodes({ showChartLabels: e.target.checked })}
                className={CHECKBOX_CLASS}
              />
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "numberLine") && (
            <Field label="Range">
              <div className="flex items-center gap-1.5">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].numberLineMax ?? DEFAULT_NUMBER_LINE_MAX}
                  min={MIN_NUMBER_LINE_MAX}
                  max={MAX_NUMBER_LINE_MAX}
                  onCommit={(n) => updateNodes({ numberLineMax: n })}
                  className={NUMBER_INPUT_CLASS}
                  title="Line spans -this to +this"
                />
                <LiveRangeSlider
                  min={MIN_NUMBER_LINE_MAX}
                  max={100}
                  value={Math.min(100, selectedNodes[0].numberLineMax ?? DEFAULT_NUMBER_LINE_MAX)}
                  onCommit={(n) => updateNodes({ numberLineMax: n })}
                  onPreview={previewField("numberLineMax")}
                  className={SLIDER_CLASS}
                  title="Line spans -this to +this"
                />
              </div>
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "graph") && (
            <>
              <Field label="Preset">
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) updateNodes({ graphExpression: e.target.value });
                  }}
                  className={SELECT_CLASS}
                  title="Fills the Expression field below with a common formula - still freely editable afterward"
                >
                  <option value="">Choose a preset…</option>
                  {GRAPH_EXPRESSION_PRESETS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Expression">
                <input
                  type="text"
                  value={selectedNodes[0].graphExpression ?? DEFAULT_GRAPH_EXPRESSION}
                  onChange={(e) => updateNodes({ graphExpression: e.target.value })}
                  placeholder="e.g. sin(x), x^2 - 3*x + 2"
                  spellCheck={false}
                  className={`w-32 h-7 px-2 ${INPUT_SURFACE_CLASS} text-[12px] font-mono`}
                  title="A formula in terms of x - +-*/^%, parentheses, implicit multiplication (2x), and sin/cos/tan/asin/acos/atan/atan2/sinh/cosh/tanh/sqrt/abs/sign/exp/ln/log/log2/floor/ceil/round/min/max/pow, pi, e"
                />
              </Field>
              {(() => {
                const error = compileGraphExpression(selectedNodes[0].graphExpression ?? DEFAULT_GRAPH_EXPRESSION).error;
                return error ? <p className="text-[11px] text-red-500 dark:text-red-400 leading-snug">{error}</p> : null;
              })()}
              <Field label="X min">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].graphXMin ?? DEFAULT_GRAPH_X_MIN}
                  min={MIN_GRAPH_DOMAIN}
                  max={MAX_GRAPH_DOMAIN}
                  integer={false}
                  onCommit={(n) => updateNodes({ graphXMin: n })}
                  className={NUMBER_INPUT_CLASS}
                />
              </Field>
              <Field label="X max">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].graphXMax ?? DEFAULT_GRAPH_X_MAX}
                  min={MIN_GRAPH_DOMAIN}
                  max={MAX_GRAPH_DOMAIN}
                  integer={false}
                  onCommit={(n) => updateNodes({ graphXMax: n })}
                  className={NUMBER_INPUT_CLASS}
                />
              </Field>
              <Field label="Auto Y range">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].graphYMin === undefined && selectedNodes[0].graphYMax === undefined}
                  onChange={(e) => updateNodes(e.target.checked ? { graphYMin: undefined, graphYMax: undefined } : { graphYMin: DEFAULT_GRAPH_Y_MIN, graphYMax: DEFAULT_GRAPH_Y_MAX })}
                  className={CHECKBOX_CLASS}
                  title="Fit the y-axis to the curve automatically, or set an explicit range below"
                />
              </Field>
              {selectedNodes.every((n) => n.graphYMin !== undefined || n.graphYMax !== undefined) && (
                <>
                  <Field label="Y min">
                    <ClampedNumberField
                      key={selectedNodes.map((n) => n.id).join(",")}
                      initialValue={selectedNodes[0].graphYMin ?? DEFAULT_GRAPH_Y_MIN}
                      min={MIN_GRAPH_DOMAIN}
                      max={MAX_GRAPH_DOMAIN}
                      integer={false}
                      onCommit={(n) => updateNodes({ graphYMin: n })}
                      className={NUMBER_INPUT_CLASS}
                    />
                  </Field>
                  <Field label="Y max">
                    <ClampedNumberField
                      key={selectedNodes.map((n) => n.id).join(",")}
                      initialValue={selectedNodes[0].graphYMax ?? DEFAULT_GRAPH_Y_MAX}
                      min={MIN_GRAPH_DOMAIN}
                      max={MAX_GRAPH_DOMAIN}
                      integer={false}
                      onCommit={(n) => updateNodes({ graphYMax: n })}
                      className={NUMBER_INPUT_CLASS}
                    />
                  </Field>
                </>
              )}
              <Field label="X interval">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].graphXTickInterval ?? 0}
                  min={0}
                  max={100}
                  step={0.1}
                  integer={false}
                  onCommit={(n) => updateNodes({ graphXTickInterval: n <= 0 ? undefined : n })}
                  className={NUMBER_INPUT_CLASS}
                  title="Spacing between x-axis tick numbers, in this graph's own x units - 0 picks it automatically"
                />
              </Field>
              <Field label="Y interval">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].graphYTickInterval ?? 0}
                  min={0}
                  max={100}
                  step={0.1}
                  integer={false}
                  onCommit={(n) => updateNodes({ graphYTickInterval: n <= 0 ? undefined : n })}
                  className={NUMBER_INPUT_CLASS}
                  title="Spacing between y-axis tick numbers, in this graph's own y units - 0 picks it automatically"
                />
              </Field>
              {selectedNodes.length === 1 && (selectedNodes[0].graphPoints?.length ?? 0) > 0 && (
                <Field label="Manual points">
                  <button
                    type="button"
                    onClick={() => updateNodes({ graphPoints: [] })}
                    className={MINI_BUTTON_CLASS}
                    title="Removes every manually-plotted point - the same points double-clicking the plot area (to add) or one of their own handles (to remove) edits directly on the canvas"
                  >
                    Clear ({selectedNodes[0].graphPoints?.length ?? 0})
                  </button>
                </Field>
              )}
            </>
          )}

          {selectedNodes.every((n) => n.shapeType === "waterfallChart") && (
            <>
              <Field label="Colormap">
                <select
                  value={selectedNodes[0].seriesColormap ?? DEFAULT_COLORMAP}
                  onChange={(e) => updateNodes({ seriesColormap: e.target.value as ColormapName })}
                  className={FIELD_INPUT_CLASS}
                  title="Colors every trace by its position in the stack - perceptually uniform maps (viridis, cividis) are the colorblind-safe choices"
                >
                  {COLORMAP_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
              <ColormapSwatch name={selectedNodes[0].seriesColormap ?? DEFAULT_COLORMAP} reversed={selectedNodes[0].seriesColorsReversed ?? false} />
              <Field label="Reverse colors">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].seriesColorsReversed ?? false}
                  onChange={(e) => updateNodes({ seriesColorsReversed: e.target.checked })}
                  className={CHECKBOX_CLASS}
                  title="Walks the colormap from its high end down - puts a dark end at the bottom of the stack"
                />
              </Field>
              <Field label="Trace spacing">
                <div className="flex items-center gap-1.5">
                  <ClampedNumberField
                    key={`off-${selectedNodes.map((n) => n.id).join(",")}`}
                    initialValue={selectedNodes[0].seriesOffset ?? DEFAULT_SERIES_OFFSET}
                    min={MIN_SERIES_OFFSET}
                    max={MAX_SERIES_OFFSET}
                    step={0.05}
                    integer={false}
                    onCommit={(n) => updateNodes({ seriesOffset: n })}
                    className={NUMBER_INPUT_CLASS}
                    title="Gap between traces, as a multiple of one trace's own height - 0 overlays them all on a shared baseline"
                  />
                  <LiveRangeSlider
                    min={MIN_SERIES_OFFSET}
                    max={2}
                    step={0.05}
                    value={Math.min(2, selectedNodes[0].seriesOffset ?? DEFAULT_SERIES_OFFSET)}
                    onCommit={(n) => updateNodes({ seriesOffset: n })}
                  onPreview={previewField("seriesOffset")}
                    className={SLIDER_CLASS}
                    title="0 overlays every trace; 1 stacks them with no overlap"
                  />
                </div>
              </Field>
              <Field label="X range">
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={selectedNodes[0].seriesXMin ?? ""}
                    placeholder="auto"
                    onChange={(e) => updateNodes({ seriesXMin: e.target.value === "" ? undefined : Number(e.target.value) })}
                    className={NUMBER_INPUT_CLASS}
                    title="Left edge of the x-axis in your own units - empty labels the axis by sample index"
                  />
                  <span className="text-[10px] text-gray-400">to</span>
                  <input
                    type="number"
                    value={selectedNodes[0].seriesXMax ?? ""}
                    placeholder="auto"
                    onChange={(e) => updateNodes({ seriesXMax: e.target.value === "" ? undefined : Number(e.target.value) })}
                    className={NUMBER_INPUT_CLASS}
                  />
                </div>
              </Field>
              <Field label="Fill under">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].seriesFillUnder ?? false}
                  onChange={(e) => updateNodes({ seriesFillUnder: e.target.checked })}
                  className={CHECKBOX_CLASS}
                  title="Shades each trace down to its own baseline - the filled ridgeline/joyplot look"
                />
              </Field>
              <Field label="Baselines">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].seriesShowBaselines ?? false}
                  onChange={(e) => updateNodes({ seriesShowBaselines: e.target.checked })}
                  className={CHECKBOX_CLASS}
                  title="A faint zero line under each trace"
                />
              </Field>
              <Field label="Show grid">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].seriesShowGrid ?? false}
                  onChange={(e) => updateNodes({ seriesShowGrid: e.target.checked })}
                  className={CHECKBOX_CLASS}
                />
              </Field>
              <Field label="Legend">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].seriesShowLegend ?? false}
                  onChange={(e) => updateNodes({ seriesShowLegend: e.target.checked })}
                  className={CHECKBOX_CLASS}
                  title="Keys each trace's name to its color - best kept off for a many-trace stack, where the colormap itself is the scale"
                />
              </Field>
              {selectedNodes.length === 1 && (
                <>
                  <SeriesDataField node={selectedNodes[0]} updateNodes={updateNodes} />
                  <SeriesColorList node={selectedNodes[0]} updateNodes={updateNodes} />
                </>
              )}
            </>
          )}
          {/* Titles and callouts sit AFTER each chart type's own data fields - they're the finishing
              pass on a figure whose data is already set up, and every chart type shares them. */}
          {selectedNodes.every((n) => CHART_AXIS_TITLE_SHAPES.has(n.shapeType)) && selectedNodes.length === 1 && (
            <ChartTitleFields node={selectedNodes[0]} updateNodes={updateNodes} />
          )}
          {selectedNodes.every((n) => CHART_ANNOTATION_SHAPES.has(n.shapeType)) && selectedNodes.length === 1 && (
            <AnnotationFields node={selectedNodes[0]} updateNodes={updateNodes} />
          )}
          {selectedNodes.every((n) => n.shapeType === "amplifier") && (
            <>
              <Field label="Swap +/-">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].ampInvertingOnTop ?? false}
                  onChange={(e) => updateNodes({ ampInvertingOnTop: e.target.checked })}
                  className={CHECKBOX_CLASS}
                  title="Draw the inverting (-) input on top and the non-inverting (+) input on bottom, instead of the usual + on top / - on bottom - a pure label swap, the leads themselves don't move"
                />
              </Field>
              <Field label="Input 1 length">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].ampInputTopLeadLength ?? DEFAULT_AMP_INPUT_LEAD_LENGTH}
                  min={MIN_AMP_LEAD_LENGTH}
                  max={MAX_AMP_LEAD_LENGTH}
                  onCommit={(n) => updateNodes({ ampInputTopLeadLength: n })}
                  className={NUMBER_INPUT_CLASS}
                  title="Length of the top input lead - same value the diamond handle on the canvas drags"
                />
              </Field>
              <Field label="Input 2 length">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].ampInputBottomLeadLength ?? DEFAULT_AMP_INPUT_LEAD_LENGTH}
                  min={MIN_AMP_LEAD_LENGTH}
                  max={MAX_AMP_LEAD_LENGTH}
                  onCommit={(n) => updateNodes({ ampInputBottomLeadLength: n })}
                  className={NUMBER_INPUT_CLASS}
                  title="Length of the bottom input lead - same value the diamond handle on the canvas drags"
                />
              </Field>
              <Field label="Output length">
                <ClampedNumberField
                  key={selectedNodes.map((n) => n.id).join(",")}
                  initialValue={selectedNodes[0].ampOutputLeadLength ?? DEFAULT_AMP_OUTPUT_LEAD_LENGTH}
                  min={MIN_AMP_LEAD_LENGTH}
                  max={MAX_AMP_LEAD_LENGTH}
                  onCommit={(n) => updateNodes({ ampOutputLeadLength: n })}
                  className={NUMBER_INPUT_CLASS}
                  title="Length of the output lead - same value the diamond handle on the canvas drags"
                />
              </Field>
              <Field label="Lead shape">
                <button
                  type="button"
                  onClick={() =>
                    updateNodes({
                      ampInputTopLeadLength: undefined,
                      ampInputBottomLeadLength: undefined,
                      ampOutputLeadLength: undefined,
                      ampInputTopLeadYOffset: undefined,
                      ampInputBottomLeadYOffset: undefined,
                      ampOutputLeadYOffset: undefined,
                    })
                  }
                  className={MINI_BUTTON_CLASS}
                  title="Undo every length change and bend on all three leads, back to the shape's original straight, symmetric layout"
                >
                  Reset leads
                </button>
              </Field>
            </>
          )}
          {selectedNodes.every((n) => n.shapeType === "latticeGauge") && (
            <>
              <Field label="Teaching mode">
                <select
                  value={selectedNodes[0].latticeTeachingMode ?? "free"}
                  onChange={(e) => updateNodes({ latticeTeachingMode: e.target.value as "free" | "plaquette" | "gauge" })}
                  className={SELECT_CLASS}
                >
                  <option value="free">Free explore</option>
                  <option value="plaquette">Plaquette loop U□</option>
                  <option value="gauge">Gauge transformation</option>
                </select>
              </Field>
              <Field label="Spin model">
                <select
                  value={selectedNodes[0].latticeSpinModel ?? "ising"}
                  onChange={(e) => updateNodes({ latticeSpinModel: e.target.value as "ising" | "xy" | "heisenberg" })}
                  className={SELECT_CLASS}
                  title="What each site's spin arrow represents - only visible while Show spins is on"
                >
                  <option value="ising">Ising (up/down)</option>
                  <option value="xy">XY (planar angle)</option>
                  <option value="heisenberg">Heisenberg (3D)</option>
                </select>
              </Field>
              <Field label="Lattice size">
                <div className="flex items-center gap-1.5">
                  <ClampedNumberField
                    key={selectedNodes.map((n) => n.id).join(",")}
                    initialValue={selectedNodes[0].latticeSize ?? DEFAULT_LATTICE_SIZE}
                    min={MIN_LATTICE_SIZE}
                    max={MAX_LATTICE_SIZE}
                    onCommit={(n) => updateNodes({ latticeSize: n })}
                    className={NUMBER_INPUT_CLASS}
                    title="Sites per edge (N) - the lattice is N x N x N"
                  />
                  <LiveRangeSlider
                    min={MIN_LATTICE_SIZE}
                    max={MAX_LATTICE_SIZE}
                    step={1}
                    value={selectedNodes[0].latticeSize ?? DEFAULT_LATTICE_SIZE}
                    onCommit={(n) => updateNodes({ latticeSize: n })}
                  onPreview={previewField("latticeSize")}
                    className={SLIDER_CLASS}
                    title="Sites per edge (N) - the lattice is N x N x N"
                  />
                </div>
              </Field>
              <Field label="Site spacing">
                <div className="flex items-center gap-1.5">
                  <ClampedNumberField
                    key={selectedNodes.map((n) => n.id).join(",")}
                    initialValue={selectedNodes[0].latticeSiteSpacing ?? DEFAULT_LATTICE_SITE_SPACING}
                    min={MIN_LATTICE_SITE_SPACING}
                    max={MAX_LATTICE_SITE_SPACING}
                    step={0.1}
                    integer={false}
                    onCommit={(n) => updateNodes({ latticeSiteSpacing: n })}
                    className={NUMBER_INPUT_CLASS}
                    title="3D-world distance between neighboring sites - purely a spread-out/compact look, unrelated to the shape's own on-canvas width/height"
                  />
                  <LiveRangeSlider
                    min={MIN_LATTICE_SITE_SPACING}
                    max={MAX_LATTICE_SITE_SPACING}
                    step={0.1}
                    value={selectedNodes[0].latticeSiteSpacing ?? DEFAULT_LATTICE_SITE_SPACING}
                    onCommit={(n) => updateNodes({ latticeSiteSpacing: n })}
                  onPreview={previewField("latticeSiteSpacing")}
                    className={SLIDER_CLASS}
                  />
                </div>
              </Field>
              <Field label="Quark size">
                <div className="flex items-center gap-1.5">
                  <ClampedNumberField
                    key={selectedNodes.map((n) => n.id).join(",")}
                    initialValue={selectedNodes[0].latticeSiteRadius ?? DEFAULT_LATTICE_SITE_RADIUS}
                    min={MIN_LATTICE_SITE_RADIUS}
                    max={MAX_LATTICE_SITE_RADIUS}
                    step={0.01}
                    integer={false}
                    onCommit={(n) => updateNodes({ latticeSiteRadius: n })}
                    className={NUMBER_INPUT_CLASS}
                    title="Quark sphere radius, in world units - independent of site spacing"
                  />
                  <LiveRangeSlider
                    min={MIN_LATTICE_SITE_RADIUS}
                    max={MAX_LATTICE_SITE_RADIUS}
                    step={0.01}
                    value={selectedNodes[0].latticeSiteRadius ?? DEFAULT_LATTICE_SITE_RADIUS}
                    onCommit={(n) => updateNodes({ latticeSiteRadius: n })}
                  onPreview={previewField("latticeSiteRadius")}
                    className={SLIDER_CLASS}
                  />
                </div>
              </Field>
              <Field label="Gluon width">
                <div className="flex items-center gap-1.5">
                  <ClampedNumberField
                    key={selectedNodes.map((n) => n.id).join(",")}
                    initialValue={selectedNodes[0].latticeLinkWidth ?? DEFAULT_LATTICE_LINK_WIDTH}
                    min={MIN_LATTICE_LINK_WIDTH}
                    max={MAX_LATTICE_LINK_WIDTH}
                    step={0.005}
                    integer={false}
                    onCommit={(n) => updateNodes({ latticeLinkWidth: n })}
                    className={NUMBER_INPUT_CLASS}
                    title="Gauge-link line weight (radius), in world units"
                  />
                  <LiveRangeSlider
                    min={MIN_LATTICE_LINK_WIDTH}
                    max={MAX_LATTICE_LINK_WIDTH}
                    step={0.005}
                    value={selectedNodes[0].latticeLinkWidth ?? DEFAULT_LATTICE_LINK_WIDTH}
                    onCommit={(n) => updateNodes({ latticeLinkWidth: n })}
                  onPreview={previewField("latticeLinkWidth")}
                    className={SLIDER_CLASS}
                  />
                </div>
              </Field>
              <Field label="Spin arrow size">
                <div className="flex items-center gap-1.5">
                  <ClampedNumberField
                    key={selectedNodes.map((n) => n.id).join(",")}
                    initialValue={selectedNodes[0].latticeSpinArrowSize ?? DEFAULT_LATTICE_SPIN_ARROW_SIZE}
                    min={MIN_LATTICE_SPIN_ARROW_SIZE}
                    max={MAX_LATTICE_SPIN_ARROW_SIZE}
                    step={0.01}
                    integer={false}
                    onCommit={(n) => updateNodes({ latticeSpinArrowSize: n })}
                    className={NUMBER_INPUT_CLASS}
                    title="Spin-arrow length, in world units - only visible while Show spins is on"
                  />
                  <LiveRangeSlider
                    min={MIN_LATTICE_SPIN_ARROW_SIZE}
                    max={MAX_LATTICE_SPIN_ARROW_SIZE}
                    step={0.01}
                    value={selectedNodes[0].latticeSpinArrowSize ?? DEFAULT_LATTICE_SPIN_ARROW_SIZE}
                    onCommit={(n) => updateNodes({ latticeSpinArrowSize: n })}
                  onPreview={previewField("latticeSpinArrowSize")}
                    className={SLIDER_CLASS}
                  />
                </div>
              </Field>
              <Field label="Show quarks">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].latticeShowQuarks ?? true}
                  onChange={(e) => updateNodes({ latticeShowQuarks: e.target.checked })}
                  className={CHECKBOX_CLASS}
                  title="Matter-field spheres on each site"
                />
              </Field>
              <Field label="Show gluons">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].latticeShowGluons ?? true}
                  onChange={(e) => updateNodes({ latticeShowGluons: e.target.checked })}
                  className={CHECKBOX_CLASS}
                  title="Gauge-link lines between neighboring sites"
                />
              </Field>
              <Field label="Show spins">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].latticeShowSpins ?? false}
                  onChange={(e) => updateNodes({ latticeShowSpins: e.target.checked })}
                  className={CHECKBOX_CLASS}
                  title="Spin-direction arrows on each site, per the Spin model above"
                />
              </Field>
              <Field label="Animate flux">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].latticeAnimateFlux ?? true}
                  onChange={(e) => updateNodes({ latticeAnimateFlux: e.target.checked })}
                  className={CHECKBOX_CLASS}
                  title="A traveling brightness pulse along every gauge link"
                />
              </Field>
              <Field label="Animate spins">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].latticeAnimateSpins ?? false}
                  onChange={(e) => updateNodes({ latticeAnimateSpins: e.target.checked })}
                  className={CHECKBOX_CLASS}
                  title="Continuously re-randomizes a handful of spins at a time, suggesting live flip dynamics (illustrative only, not an actual simulation)"
                />
              </Field>
            </>
          )}
          {/* "table" structure - rows/columns/header toggle. Row/column count only edits ONE node
              at a time (unlike every other field in this panel, which applies the same patch to
              every selected node uniformly) - a rows/cols change also has to grow/shrink the
              node's own tableRowHeights/tableColWidths/tableCellText arrays, and those are only
              meaningful computed against THAT one node's own current grid (see resolveTableGrid) -
              applying one node's freshly-computed arrays onto a DIFFERENT table with its own,
              likely different, row/column count would corrupt it. Cell text/resize/insert-at-a-
              specific-position all live in WhiteboardTable.tsx instead (see its own top comment). */}
          {selectedNodes.length === 1 && selectedNodes[0].shapeType === "table" && (
            <TableStructureFields node={selectedNodes[0]} updateNodes={updateNodes} />
          )}
          {selectedNodes.length === 1 && selectedNodes[0].shapeType === "table" && tableRangeSelection?.nodeId === selectedNodes[0].id && (
            <TableCellFields node={selectedNodes[0]} range={tableRangeSelection.range} updateNodes={updateNodes} />
          )}
          {selectedNodes.every((n) => n.shapeType === "freehand") && (
            <div className="border-t border-gray-100 dark:border-neutral-700/70 pt-2 flex flex-col gap-2">
              <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-neutral-500">Arrowheads</p>
              <Field label="Start">
                <select
                  value={selectedNodes[0].startArrowType ?? "none"}
                  onChange={(e) => updateNodes({ startArrowType: e.target.value as ArrowheadType })}
                  className={`w-28 h-7 pl-2 pr-1 ${INPUT_SURFACE_CLASS} text-[12px] cursor-pointer`}
                >
                  {ARROWHEAD_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="End">
                <select
                  value={selectedNodes[0].endArrowType ?? "none"}
                  onChange={(e) => updateNodes({ endArrowType: e.target.value as ArrowheadType })}
                  className={`w-28 h-7 pl-2 pr-1 ${INPUT_SURFACE_CLASS} text-[12px] cursor-pointer`}
                >
                  {ARROWHEAD_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}

          </Section>
        </>
      )}

      {selectedNodes.length === 1 && selectedNodes[0].shapeType === "latticeGauge" && (
        <>
          <Section title="Label" dense>
            <LatticeLabelFields node={selectedNodes[0]} updateNodes={updateNodes} />
          </Section>
          <Section title="Motion" dense>
            <LatticeMotionFields node={selectedNodes[0]} updateNodes={updateNodes} onSaveExport={onSaveExport} />
          </Section>
        </>
      )}

      {selectedNodes.length > 0 && selectedNodes.every((n) => n.shapeType === "graph" || n.shapeType === "functionPlot") && (
        <Section title="Axes & grid" dense>
          <PlotAxesFields nodes={selectedNodes} updateNodes={updateNodes} onPreviewNodes={onPreviewNodes} />
        </Section>
      )}

      {selectedNodes.length > 0 && hasText && !allText && !singleEquation && (
        <Section title="Text" dense>
          {/* Font family/Bold/Italic/Underline are meaningless for "equation" - KaTeX typesets with its
              own math font regardless, so these controls would sit there doing nothing visible if
              shown. Font size/color and Align DO still apply (see EquationDisplay/paintEquation), so
              only those stay visible for it. */}
          <div className="flex items-center gap-1.5">
            {selectedNodes.every((n) => n.shapeType !== "equation") && (
              <div className="flex-1 min-w-0">
                <WhiteboardFontPicker value={selectedNodes[0].fontFamily} onChange={(fontFamily) => updateNodes({ fontFamily })} />
              </div>
            )}
            <div className="w-[76px] shrink-0 ml-auto">
              <PrefixedNumber
                prefix={<TbTextSize size={12} />}
                title="Font size - drag the icon to scrub"
                resetKey={`${ids}-fs`}
                value={selectedNodes[0].fontSize}
                min={6}
                max={400}
                onCommit={(fontSize) => updateNodes({ fontSize })}
              />
            </div>
          </div>
          <ColorField label="Color" value={selectedNodes[0].fontColor} onChange={(fontColor) => updateNodes({ fontColor })} />
          <div className="flex items-center justify-between gap-1.5">
            {selectedNodes.every((n) => n.shapeType !== "equation") && (
              <Segmented>
                <SegmentButton
                  active={selectedNodes[0].fontWeight === "bold"}
                  onClick={() => updateNodes({ fontWeight: selectedNodes[0].fontWeight === "bold" ? "normal" : "bold" })}
                  title="Bold"
                >
                  <TbBold size={13} />
                </SegmentButton>
                <SegmentButton
                  active={selectedNodes[0].fontStyle === "italic"}
                  onClick={() => updateNodes({ fontStyle: selectedNodes[0].fontStyle === "italic" ? "normal" : "italic" })}
                  title="Italic"
                >
                  <TbItalic size={13} />
                </SegmentButton>
                <SegmentButton
                  active={selectedNodes[0].textDecoration === "underline"}
                  onClick={() => updateNodes({ textDecoration: selectedNodes[0].textDecoration === "underline" ? "none" : "underline" })}
                  title="Underline"
                >
                  <TbUnderline size={13} />
                </SegmentButton>
              </Segmented>
            )}
            <Segmented>
              {(["left", "center", "right"] as const).map((align) => (
                <SegmentButton key={align} active={selectedNodes[0].textAlign === align} onClick={() => updateNodes({ textAlign: align })} title={`Align ${align}`}>
                  {align === "left" ? <TbAlignLeft size={13} /> : align === "center" ? <TbAlignCenter size={13} /> : <TbAlignRight size={13} />}
                </SegmentButton>
              ))}
            </Segmented>
          </div>
          <Field label="Vertical">
            <Segmented>
              {(["top", "middle", "bottom"] as const).map((align) => (
                <SegmentButton key={align} active={selectedNodes[0].verticalAlign === align} onClick={() => updateNodes({ verticalAlign: align })} title={`Align ${align}`}>
                  {align === "top" ? <TbLayoutAlignTop size={13} /> : align === "middle" ? <TbLayoutAlignMiddle size={13} /> : <TbLayoutAlignBottom size={13} />}
                </SegmentButton>
              ))}
            </Segmented>
          </Field>
          <Field label="Blend">
            <select
              value={selectedNodes[0].blendMode ?? "normal"}
              onChange={(e) => {
                const v = e.target.value as WhiteboardBlendMode;
                updateNodes({ blendMode: v === "normal" ? undefined : v });
              }}
              className={`w-[144px] shrink-0 h-7 pl-2 pr-1 ${INPUT_SURFACE_CLASS} text-[12px] cursor-pointer`}
              title="How this text blends with layers underneath it (e.g. Multiply, Screen, Overlay, Difference)"
            >
              {WHITEBOARD_BLEND_MODES.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
        </Section>
      )}

      {selectedNodes.length > 0 && (
        <>
          <Section title="Arrange" dense>
            <TransformBlock nodes={selectedNodes} onCommit={updateNodes} onFlip={flipSelected} />
            <SliderField
              label="Opacity"
              resetKey={`lyo-${ids}`}
              value={Math.round((selectedNodes[0].opacity ?? 1) * 100)}
              min={0}
              max={100}
              step={1}
              onCommit={(n) => updateNodes({ opacity: n >= 100 ? undefined : n / 100 })}
              onPreview={(n) => onPreviewNodes?.(n === null ? null : { opacity: n / 100 })}
              title="Overall layer opacity - fades the entire shape including fill, stroke and shadow"
            />
            {!allText && !hasText && (
              <Field label="Blend">
                <select
                  value={selectedNodes[0].blendMode ?? "normal"}
                  onChange={(e) => {
                    const v = e.target.value as WhiteboardBlendMode;
                    updateNodes({ blendMode: v === "normal" ? undefined : v });
                  }}
                  className={`w-[144px] shrink-0 h-7 pl-2 pr-1 ${INPUT_SURFACE_CLASS} text-[12px] cursor-pointer`}
                  title="Layer blend mode against elements underneath"
                >
                  {WHITEBOARD_BLEND_MODES.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <NudgeBar onNudge={nudgeSelected} />
              <Segmented>
                <SegmentButton active={false} onClick={onBringToFront} title="Bring to front">
                  <TbStackFront size={14} />
                </SegmentButton>
                {onBringForward && (
                  <SegmentButton active={false} onClick={onBringForward} title="Bring forward">
                    <TbArrowUp size={13} />
                  </SegmentButton>
                )}
                {onSendBackward && (
                  <SegmentButton active={false} onClick={onSendBackward} title="Send backward">
                    <TbArrowDown size={13} />
                  </SegmentButton>
                )}
                <SegmentButton active={false} onClick={onSendToBack} title="Send to back">
                  <TbStackBack size={14} />
                </SegmentButton>
                {selectedNodes.length + selectedEdges.length >= 2 && (
                  <SegmentButton active={false} onClick={onGroup} title="Group (Ctrl+G)">
                    <TbComponents size={14} />
                  </SegmentButton>
                )}
                {(selectedNodes.some((n) => n.groupId) || selectedEdges.some((e) => e.groupId)) && (
                  <SegmentButton active={false} onClick={onUngroup} title="Ungroup (Ctrl+Shift+G)">
                    <TbComponentsOff size={14} />
                  </SegmentButton>
                )}
              </Segmented>
            </div>
          </Section>

          {selectedNodes.length > 1 && (
            <Section title="Align & distribute" dense>
              <FigureLayoutFields nodes={selectedNodes} onBatchEditNodes={onBatchEditNodes} />
            </Section>
          )}
        </>
      )}

      {selectedNodes.length === 0 && firstEdge && (
        <>
          <Section title="Arrange" dense>
            {edge && edgeEndpoints && !edge.source.nodeId && !edge.target.nodeId && (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  <PrefixedNumber
                    resetKey={`ex-${edge.id}`}
                    prefix="X"
                    title="Horizontal position of the connector's left bound in document units - drag the label to scrub"
                    value={Math.round(Math.min(edgeEndpoints.source.x, edgeEndpoints.target.x))}
                    min={-100000}
                    max={100000}
                    onCommit={(x) => {
                      const curMinX = Math.min(edgeEndpoints.source.x, edgeEndpoints.target.x);
                      updateEdge(nudgeEdgeBy(edge, x - curMinX, 0));
                    }}
                  />
                  <PrefixedNumber
                    resetKey={`ey-${edge.id}`}
                    prefix="Y"
                    title="Vertical position of the connector's top bound in document units - drag the label to scrub"
                    value={Math.round(Math.min(edgeEndpoints.source.y, edgeEndpoints.target.y))}
                    min={-100000}
                    max={100000}
                    onCommit={(y) => {
                      const curMinY = Math.min(edgeEndpoints.source.y, edgeEndpoints.target.y);
                      updateEdge(nudgeEdgeBy(edge, 0, y - curMinY));
                    }}
                  />
                  <PrefixedNumber
                    resetKey={`el-${edge.id}`}
                    prefix="L"
                    title="End-to-end length in document units (scales symmetrically around the midpoint)"
                    value={Math.max(1, edgeLength)}
                    min={4}
                    max={100000}
                    onCommit={(len) => updateEdge(scaleEdgeLength(edge, len))}
                  />
                  <Segmented stretch>
                    <SegmentButton
                      active={false}
                      onClick={() => transformEdges((e) => flipEdge(e, "horizontal", nodesById))}
                      title="Flip Horizontal (mirror left to right)"
                    >
                      <TbFlipHorizontal size={14} />
                    </SegmentButton>
                    <SegmentButton
                      active={false}
                      onClick={() => transformEdges((e) => flipEdge(e, "vertical", nodesById))}
                      title="Flip Vertical (mirror top to bottom)"
                    >
                      <TbFlipVertical size={14} />
                    </SegmentButton>
                  </Segmented>
                </div>
                <EdgeRotateField key={edge.id} edge={edge} onCommit={updateEdge} />
              </>
            )}
            {(!edge || edge.source.nodeId || edge.target.nodeId) && (
              <Segmented stretch>
                <SegmentButton
                  active={false}
                  onClick={() => transformEdges((e) => flipEdge(e, "horizontal", nodesById))}
                  title="Flip Horizontal (mirror free endpoints and bend points left to right)"
                >
                  <TbFlipHorizontal size={14} />
                </SegmentButton>
                <SegmentButton
                  active={false}
                  onClick={() => transformEdges((e) => flipEdge(e, "vertical", nodesById))}
                  title="Flip Vertical (mirror free endpoints and bend points top to bottom)"
                >
                  <TbFlipVertical size={14} />
                </SegmentButton>
              </Segmented>
            )}
            <SliderField
              label="Opacity"
              resetKey={`eo-${edgeIds}`}
              value={Math.round((firstEdge.opacity ?? 1) * 100)}
              min={0}
              max={100}
              step={1}
              onCommit={(n) => updateEdge({ opacity: n >= 100 ? undefined : n / 100 })}
              onPreview={(n) => onPreviewEdges?.(n === null ? null : { opacity: n / 100 })}
              title="Overall connector opacity (100% solid, 0% fully transparent - affects line, arrowheads, and label)"
            />
            <div className="flex items-center justify-between gap-1.5">
              <NudgeBar onNudge={(dx, dy) => transformEdges((e) => nudgeEdgeBy(e, dx, dy))} />
              <Segmented>
                <SegmentButton active={false} onClick={onBringToFront} title="Bring to front">
                  <TbStackFront size={14} />
                </SegmentButton>
                {onBringForward && (
                  <SegmentButton active={false} onClick={onBringForward} title="Bring forward one layer">
                    <TbArrowUp size={13} />
                  </SegmentButton>
                )}
                {onSendBackward && (
                  <SegmentButton active={false} onClick={onSendBackward} title="Send backward one layer">
                    <TbArrowDown size={13} />
                  </SegmentButton>
                )}
                <SegmentButton active={false} onClick={onSendToBack} title="Send to back">
                  <TbStackBack size={14} />
                </SegmentButton>
              </Segmented>
            </div>
          </Section>

          <Section title="Line" dense>
            <ColorField label="Color" value={firstEdge.strokeColor} onChange={(strokeColor) => updateEdge({ strokeColor })} />
            <SliderField
              label="Width"
              resetKey={`ew-${edgeIds}`}
              value={firstEdge.strokeWidth}
              min={0.5}
              max={64}
              sliderMax={16}
              step={0.5}
              onCommit={(n) => updateEdge({ strokeWidth: n })}
              onPreview={previewEdgeField("strokeWidth")}
            />
            <SliderField
              label="Opacity"
              resetKey={`eso-${edgeIds}`}
              value={Math.round((firstEdge.strokeOpacity ?? 1) * 100)}
              min={0}
              max={100}
              step={1}
              onCommit={(n) => updateEdge({ strokeOpacity: n >= 100 ? undefined : n / 100 })}
              onPreview={(n) => onPreviewEdges?.(n === null ? null : { strokeOpacity: n / 100 })}
              title="Line stroke opacity (leaves label opacity untouched)"
            />
            <Field label="Style">
              <Segmented>
                {LINE_STYLE_OPTIONS.map((opt) => (
                  <SegmentButton key={opt.value} active={firstEdge.strokeStyle === opt.value} onClick={() => updateEdge({ strokeStyle: opt.value })} title={opt.label}>
                    <svg width={18} height={8} viewBox="0 0 18 8">
                      <line
                        x1={1}
                        y1={4}
                        x2={17}
                        y2={4}
                        stroke="currentColor"
                        strokeWidth={1.75}
                        strokeLinecap="round"
                        strokeDasharray={opt.value === "dashed" ? "4 3" : opt.value === "dotted" ? "0.1 3.5" : undefined}
                      />
                    </svg>
                  </SegmentButton>
                ))}
              </Segmented>
            </Field>
            {firstEdge.strokeStyle !== "dotted" && (
              <Field label="Cap">
                <Segmented>
                  {([
                    { value: "butt", label: "Flat cap" },
                    { value: "round", label: "Round cap" },
                    { value: "square", label: "Square cap" },
                  ] as const).map((cap) => (
                    <SegmentButton
                      key={cap.value}
                      active={(firstEdge.strokeCap ?? "round") === cap.value}
                      onClick={() => updateEdge({ strokeCap: cap.value })}
                      title={cap.label}
                    >
                      <span className="px-1 text-[10px] capitalize">{cap.value}</span>
                    </SegmentButton>
                  ))}
                </Segmented>
              </Field>
            )}
            <Field label="Routing">
              <Segmented>
                {ROUTING_OPTIONS.map((opt) => (
                  <SegmentButton key={opt.value} active={firstEdge.routing === opt.value} onClick={() => updateEdge({ routing: opt.value })} title={opt.label}>
                    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                      {opt.value === "straight" ? <path d="M2,12 L12,2" /> : opt.value === "orthogonal" ? <path d="M2,12 V7 H12 V2" /> : <path d="M2,12 C2,4 12,10 12,2" />}
                    </svg>
                  </SegmentButton>
                ))}
              </Segmented>
            </Field>
            {firstEdge.routing === "curved" && !(firstEdge.waypoints && firstEdge.waypoints.length > 0) && (
              <Field label="Curve bow">
                <LiveRangeSlider
                  min={-1}
                  max={1}
                  step={0.05}
                  value={firstEdge.curveBow ?? DEFAULT_CURVE_BOW}
                  onCommit={(n) => updateEdge({ curveBow: n })}
                  onPreview={previewEdgeField("curveBow")}
                  className={SLIDER_CLASS}
                  title="Which way (and how far) a free-floating end of this curve bows - only matters where the curve has no shape side to bow away from"
                />
              </Field>
            )}
            {(firstEdge.routing === "orthogonal" || (firstEdge.waypoints && firstEdge.waypoints.length > 0)) && (
              <SliderField
                label="Corner radius"
                resetKey={`ecr-${edgeIds}`}
                value={firstEdge.cornerRadius ?? 0}
                min={0}
                max={120}
                sliderMax={48}
                step={1}
                onCommit={(n) => updateEdge({ cornerRadius: n <= 0 ? undefined : n })}
                onPreview={previewEdgeField("cornerRadius")}
                title="Rounds the sharp 90° turns and manual bend points along this connector"
              />
            )}
            {firstEdge.waypoints && firstEdge.waypoints.length > 0 && (
              <Field label="Bend points">
                <button
                  type="button"
                  onClick={() => updateEdge({ waypoints: [] })}
                  className={MINI_BUTTON_CLASS}
                  title="Remove every manually-dragged bend point on this connector, letting the routing style alone decide its path again"
                >
                  Clear ({firstEdge.waypoints.length})
                </button>
              </Field>
            )}
          </Section>

          <Section
            title="Arrows"
            dense
            action={
              <button
                type="button"
                onClick={() => transformEdges((e) => reverseEdgeDirection(e))}
                className="p-1 rounded text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition"
                title="Swap start & end arrowheads and reverse connector direction"
              >
                <TbArrowsExchange size={14} />
              </button>
            }
          >
            <Field label="Start">
              <select value={firstEdge.startArrowType} onChange={(e) => updateEdge({ startArrowType: e.target.value as ArrowheadType })} className={`w-28 h-7 pl-2 pr-1 ${INPUT_SURFACE_CLASS} text-[12px] cursor-pointer`}>
                {ARROWHEAD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="End">
              <select value={firstEdge.endArrowType} onChange={(e) => updateEdge({ endArrowType: e.target.value as ArrowheadType })} className={`w-28 h-7 pl-2 pr-1 ${INPUT_SURFACE_CLASS} text-[12px] cursor-pointer`}>
                {ARROWHEAD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>
          </Section>

          <Section
            title="Shadow"
            dense
            action={
              <button
                type="button"
                onClick={() => {
                  const isEnabled = firstEdge.shadowEnabled ?? false;
                  const next = !isEnabled;
                  updateEdge({
                    shadowEnabled: next,
                    ...(next && firstEdge.shadowBlur === undefined
                      ? {
                          shadowColor: DEFAULT_SHADOW_COLOR,
                          shadowOpacity: DEFAULT_SHADOW_OPACITY,
                          shadowBlur: DEFAULT_SHADOW_BLUR,
                          shadowOffsetX: DEFAULT_SHADOW_OFFSET_X,
                          shadowOffsetY: DEFAULT_SHADOW_OFFSET_Y,
                        }
                      : {}),
                  });
                }}
                className={`p-1 rounded transition ${
                  firstEdge.shadowEnabled
                    ? "text-blue-600 dark:text-blue-400 hover:bg-blue-500/10"
                    : "text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                }`}
                title={firstEdge.shadowEnabled ? "Disable shadow" : "Enable shadow"}
              >
                {firstEdge.shadowEnabled ? <TbShadow size={15} /> : <TbShadowOff size={15} />}
              </button>
            }
          >
            {firstEdge.shadowEnabled ? (
              <>
                <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] py-0.5">
                  {SHADOW_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() => {
                        const patch =
                          "makeConfig" in preset && preset.makeConfig
                            ? preset.makeConfig({ strokeColor: firstEdge.strokeColor, fillColor: firstEdge.strokeColor })
                            : preset.config ?? {};
                        updateEdge(patch);
                      }}
                      className="px-2 py-0.5 shrink-0 rounded text-[11px] font-medium bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.1] text-neutral-600 dark:text-neutral-300 transition active:scale-95"
                      title={`Apply ${preset.name} shadow preset`}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
                <ColorField
                  label="Color"
                  value={firstEdge.shadowColor ?? DEFAULT_SHADOW_COLOR}
                  onChange={(shadowColor) => updateEdge({ shadowColor })}
                />
                <SliderField
                  label="Opacity"
                  resetKey={`esho-${edgeIds}`}
                  value={Math.round((firstEdge.shadowOpacity ?? DEFAULT_SHADOW_OPACITY) * 100)}
                  min={0}
                  max={100}
                  step={1}
                  onCommit={(n) => updateEdge({ shadowOpacity: n / 100 })}
                  onPreview={(n) => onPreviewEdges?.(n === null ? null : { shadowOpacity: n / 100 })}
                />
                <SliderField
                  label="Blur"
                  resetKey={`eshb-${edgeIds}`}
                  value={firstEdge.shadowBlur ?? DEFAULT_SHADOW_BLUR}
                  min={0}
                  max={64}
                  step={1}
                  onCommit={(n) => updateEdge({ shadowBlur: n })}
                  onPreview={previewEdgeField("shadowBlur")}
                />
                <Field label="Offset">
                  <div className="grid grid-cols-2 gap-1.5 w-full">
                    <PrefixedNumber
                      resetKey={`eshx-${edgeIds}`}
                      prefix="X"
                      title="Horizontal shadow offset in pixels"
                      value={firstEdge.shadowOffsetX ?? DEFAULT_SHADOW_OFFSET_X}
                      min={-100}
                      max={100}
                      onCommit={(x) => updateEdge({ shadowOffsetX: x })}
                    />
                    <PrefixedNumber
                      resetKey={`eshy-${edgeIds}`}
                      prefix="Y"
                      title="Vertical shadow offset in pixels"
                      value={firstEdge.shadowOffsetY ?? DEFAULT_SHADOW_OFFSET_Y}
                      min={-100}
                      max={100}
                      onCommit={(y) => updateEdge({ shadowOffsetY: y })}
                    />
                  </div>
                </Field>
              </>
            ) : (
              <button
                type="button"
                onClick={() =>
                  updateEdge({
                    shadowEnabled: true,
                    ...(firstEdge.shadowBlur === undefined
                      ? {
                          shadowColor: DEFAULT_SHADOW_COLOR,
                          shadowOpacity: DEFAULT_SHADOW_OPACITY,
                          shadowBlur: DEFAULT_SHADOW_BLUR,
                          shadowOffsetX: DEFAULT_SHADOW_OFFSET_X,
                          shadowOffsetY: DEFAULT_SHADOW_OFFSET_Y,
                        }
                      : {}),
                  })
                }
                className="w-full h-7 rounded-md bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-[11px] text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 transition flex items-center justify-center gap-1.5"
              >
                <TbShadow size={13} />
                <span>Add Shadow</span>
              </button>
            )}
          </Section>

          <Section title="Label" dense>
            <input
              type="text"
              value={firstEdge.label}
              placeholder="Text shown on the line"
              onChange={(e) => updateEdge({ label: e.target.value })}
              className={`w-full h-7 px-2 ${INPUT_SURFACE_CLASS} text-[12px]`}
            />
            {firstEdge.label.trim().length > 0 && (
              <>
                <div className="flex items-center gap-1.5">
                  <div className="w-24 shrink-0">
                    <PrefixedNumber
                      resetKey={`elfs-${edgeIds}`}
                      prefix={<TbTextSize size={12} />}
                      title="Label font size in pixels"
                      value={firstEdge.labelFontSize ?? 12}
                      min={8}
                      max={72}
                      onCommit={(n) => updateEdge({ labelFontSize: n })}
                    />
                  </div>
                  <Segmented>
                    <SegmentButton
                      active={Boolean(firstEdge.labelBold)}
                      onClick={() => updateEdge({ labelBold: !firstEdge.labelBold })}
                      title="Bold label"
                    >
                      <TbBold size={13} />
                    </SegmentButton>
                    <SegmentButton
                      active={Boolean(firstEdge.labelItalic)}
                      onClick={() => updateEdge({ labelItalic: !firstEdge.labelItalic })}
                      title="Italic label"
                    >
                      <TbItalic size={13} />
                    </SegmentButton>
                  </Segmented>
                </div>
                <ColorField
                  label="Color"
                  value={firstEdge.labelColor ?? "#1f2937"}
                  onChange={(labelColor) => updateEdge({ labelColor })}
                />
                <SliderField
                  label="Position"
                  resetKey={`elp-${edgeIds}`}
                  value={Math.round((firstEdge.labelPosition ?? 0.5) * 100)}
                  min={0}
                  max={100}
                  step={1}
                  onCommit={(n) => updateEdge({ labelPosition: n / 100 })}
                  onPreview={(n) => onPreviewEdges?.(n === null ? null : { labelPosition: n / 100 })}
                  title="Position along the line from Start (0%) to End (100%)"
                />
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={firstEdge.labelShowBackground ?? true}
                      onChange={(e) => updateEdge({ labelShowBackground: e.target.checked })}
                      className="rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span>Pill background</span>
                  </label>
                  {(firstEdge.labelShowBackground ?? true) && (
                    <div className="w-28">
                      <HexColorInput
                        value={firstEdge.labelBackgroundColor ?? "#ffffff"}
                        onChange={(labelBackgroundColor) => updateEdge({ labelBackgroundColor })}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </Section>
        </>
      )}
      </div>

      {/* Pinned rather than at the end of the scroll, as in the Mindmap inspector: lock, duplicate and
          delete are the actions reached for most, and on a chart's long Style tab they used to be a
          scroll away. */}
      {(selectedNodes.length > 0 || selectedEdges.length > 0) && (
        <div className="shrink-0 flex items-center gap-0.5 px-2 h-11 border-t border-black/[0.05] dark:border-white/[0.06]">
          <button
            type="button"
            onClick={() => (selectedNodes.length > 0 ? updateNodes({ locked: !allLocked }) : updateEdge({ locked: !allLocked }))}
            aria-pressed={allLocked}
            title="Prevents dragging, resizing, rotating, or nudging this item until unlocked again - handy while manually plotting onto a graph, or annotating around a shape or line you don't want to bump"
            className={`h-7 px-2 flex items-center gap-1.5 rounded-md text-[12px] font-medium transition active:scale-[0.97] ${
              allLocked ? "bg-amber-500/12 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20" : "text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-neutral-900 dark:hover:text-neutral-100"
            }`}
          >
            {allLocked ? <TbLock size={14} /> : <TbLockOpen size={14} />}
            {allLocked ? "Locked" : "Lock"}
          </button>
          <div className="ml-auto flex items-center gap-0.5">
            {selectedNodes.length === 1 && (
              <button type="button" onClick={() => onDuplicateNode(selectedNodes[0])} title="Duplicate (Ctrl+D)" className={FOOTER_BUTTON_CLASS}>
                <IoCopyOutline size={15} />
              </button>
            )}
            {selectedNodes.length === 0 && edge && onDuplicateEdge && (
              <button type="button" onClick={() => onDuplicateEdge(edge)} title="Duplicate (Ctrl+D)" className={FOOTER_BUTTON_CLASS}>
                <IoCopyOutline size={15} />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (selectedNodes.length > 0) selectedNodes.forEach((n) => onDeleteNode(n));
                if (selectedEdges.length > 0) selectedEdges.forEach((e) => onDeleteEdge(e));
              }}
              title="Delete"
              className={`${FOOTER_BUTTON_CLASS} hover:!text-red-600 dark:hover:!text-red-400 hover:!bg-red-500/10`}
            >
              <IoTrashOutline size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default WhiteboardStylePanel;
