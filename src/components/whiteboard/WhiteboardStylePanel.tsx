// components/whiteboard/WhiteboardStylePanel.tsx
//
// The Whiteboard feature's property-editing surface for whatever's currently selected - mirrors
// BoardStylePanel.tsx's role for Board, but over WhiteboardNode/WhiteboardEdge instead of
// BoardItem. Node edits apply to every selected node at once via batchEditNodes when more than one
// is selected (so multi-selecting three boxes and picking a fill color is one undo step, not
// three) - single-selection edits still go through editNode so BoardStylePanel's "just the one
// item" case isn't paying for a batch array it doesn't need.
import React from "react";
import { IoCopyOutline, IoSwapHorizontalOutline, IoTrashOutline } from "react-icons/io5";
import {
  TbComponents,
  TbComponentsOff,
  TbFlipHorizontal,
  TbFlipVertical,
  TbItalic,
  TbLayoutAlignBottom,
  TbLayoutAlignCenter,
  TbLayoutAlignLeft,
  TbLayoutAlignMiddle,
  TbLayoutAlignRight,
  TbLayoutAlignTop,
  TbStackBack,
  TbStackFront,
  TbUnderline,
} from "react-icons/tb";
import { ColormapName, COLORMAP_NAMES, colormapPalette, DEFAULT_COLORMAP } from "../../utils/colormaps";
import {
  ArrowheadType,
  ChartAnnotation,
  CHART_ANNOTATION_SHAPES,
  CHART_AXIS_TITLE_SHAPES,
  CHART_DATA_SHAPES,
  CHART_LABEL_SHAPES,
  DEFAULT_CHART_DATA,
  DEFAULT_SERIES_OFFSET,
  MAX_SERIES_COUNT,
  MAX_SERIES_POINTS,
  MAX_SERIES_OFFSET,
  MIN_SERIES_OFFSET,
  hasImageCrop,
  naturalImageSize,
  resolveImageCrop,
  resolveSeriesData,
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
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  MIN_LATTICE_LINK_WIDTH,
  MIN_LATTICE_SITE_RADIUS,
  MIN_LATTICE_SITE_SPACING,
  MIN_LATTICE_SIZE,
  MIN_LATTICE_SPIN_ARROW_SIZE,
  MIN_TABLE_COLS,
  MIN_TABLE_ROWS,
  TableBorderStyle,
  WhiteboardEdge,
  WhiteboardNode,
  insertTableFraction,
  removeTableFraction,
  resolveTableGrid,
  withRangeBorderSide,
  withRangeFill,
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
  alignNodes,
  AlignEdge,
  annotationCoordinateMapper,
  arrangeNodesInGrid,
  compileGraphExpression,
  DEFAULT_GRID_GAP,
  distributeNodes,
  nudgeEdgeBy,
  outlineOptionsFor,
} from "../../handlers/whiteboardHandlers";

const FONT_FAMILY_OPTIONS: { label: string; value: string }[] = [
  { label: "Sans", value: "system-ui, sans-serif" },
  { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "Monospace", value: "'Courier New', monospace" },
  { label: "Rounded", value: "'Trebuchet MS', sans-serif" },
  { label: "Casual", value: "'Comic Sans MS', cursive" },
];

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

interface WhiteboardStylePanelProps {
  selectedNodes: WhiteboardNode[];
  selectedEdges: WhiteboardEdge[];
  // The active cell/row/column range within a selected "table" node (or null) - lifted up from
  // WhiteboardTable.tsx via WhiteboardCanvas.tsx/WhiteboardEditor.tsx (see their own doc comments on
  // this same field). Only acted on below when it names the SAME node currently selected here - a
  // stale range left over from a table that's no longer selected shouldn't resurrect its own "Cell"
  // controls.
  tableRangeSelection: { nodeId: string; range: { r0: number; c0: number; r1: number; c1: number } } | null;
  onBatchEditNodes: (before: WhiteboardNode[], after: WhiteboardNode[]) => void;
  onEditEdge: (before: WhiteboardEdge, after: WhiteboardEdge) => void;
  onDeleteNode: (node: WhiteboardNode) => void;
  onDeleteEdge: (edge: WhiteboardEdge) => void;
  onDuplicateNode: (node: WhiteboardNode) => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  // Swaps the bitmap behind an existing "image" node, keeping its box, crop and styling. Owned by
  // WhiteboardEditor (it has the file dialog and the whiteboard id this asset is imported into);
  // absent simply hides the "Replace image…" button rather than showing one that can't work.
  onReplaceImage?: (node: WhiteboardNode) => void;
  // Crop mode, owned by WhiteboardEditor so this panel's Crop button and the canvas's own
  // double-click gesture drive the same state rather than each having their own.
  croppingNodeId?: string | null;
  onToggleCrop?: (node: WhiteboardNode) => void;
  // Display-only preview of a patch applied to the current selection, for sliders to update the
  // canvas in real time mid-drag. null clears it. Never reaches the store, so a whole drag still
  // commits as one undo step - see LiveRangeSlider's own doc comment for why that split is
  // load-bearing rather than a nicety.
  onPreviewNodes?: (patch: Partial<WhiteboardNode> | null) => void;
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
function ClampedNumberField({
  initialValue,
  min,
  max,
  step,
  integer = true,
  onCommit,
  className,
  title,
}: {
  initialValue: number;
  min: number;
  max: number;
  step?: number;
  integer?: boolean; // false keeps typed decimals (e.g. a 0.05-step fraction) instead of rounding to a whole number
  onCommit: (n: number) => void;
  className: string;
  title?: string;
}) {
  const [text, setText] = React.useState(String(initialValue));
  const [focused, setFocused] = React.useState(false);
  // Tracks what was last actually dispatched (as opposed to `initialValue`, a mount-time snapshot),
  // so blur doesn't re-dispatch an identical value on top of the live commit that already fired for
  // the same keystroke - each edit becomes exactly one undo step.
  const lastCommittedRef = React.useRef(initialValue);
  React.useEffect(() => {
    lastCommittedRef.current = initialValue;
    if (!focused) setText(String(initialValue));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `focused` deliberately excluded: a
    // focus change alone shouldn't re-sync text, only a genuinely new initialValue while unfocused.
  }, [initialValue]);
  const parseClamped = (raw: string): number | null => {
    if (raw.trim() === "") return null;
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    const parsed = integer ? Math.round(num) : num;
    return Math.max(min, Math.min(max, parsed));
  };
  const commitIfChanged = (clamped: number) => {
    if (clamped === lastCommittedRef.current) return;
    lastCommittedRef.current = clamped;
    onCommit(clamped);
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step ?? (integer ? 1 : "any")}
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const clamped = parseClamped(raw);
        if (clamped !== null) commitIfChanged(clamped);
      }}
      onBlur={() => {
        setFocused(false);
        const clamped = parseClamped(text) ?? initialValue;
        setText(String(clamped));
        commitIfChanged(clamped);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
      className={className}
      title={title}
    />
  );
}

// Same "stage locally, commit once per gesture" discipline WhiteboardCanvas.tsx's own canvas
// drags already use (see its top-of-file comment: a whole drag becomes exactly one undo step) -
// a plain onChange on a <input type="range"> fires on every native `input` event mid-drag, and
// every commit here goes through onBatchEditNodes/onEditEdge, which pushes a new undo-stack entry
// AND triggers a full page re-render (or, for the lattice fields specifically, LatticeGaugeWidget's
// own full 3D mesh dispose+rebuild) on EVERY tick. A single drag sweep across a slider's range can
// fire dozens of those in well under a second - severe enough for the lattice-size slider in
// particular (disposing/rebuilding up to tens of thousands of meshes per tick) to freeze the whole
// app while a screen recording's own GDI capture was also active (see
// RECORDING_UPGRADE_NOTES.md). This keeps the thumb tracking the drag in real time via local
// `liveValue` state, but only calls `onCommit` once the gesture actually ends - pointer release, a
// keyboard nudge, or focus leaving the control - so a whole drag becomes exactly one undo step and
// one rebuild, not one per pixel of travel.
// `onPreview` is what makes the shape itself track the drag in real time WITHOUT paying the cost
// above: it renders through the canvas's display-only preview channel (see WhiteboardCanvas's
// previewNodes prop) and never touches the store or the undo stack, so the whole drag still commits
// exactly once on release. A slider given no onPreview keeps the original behavior - thumb tracks,
// shape updates at the end.
function LiveRangeSlider({
  value,
  min,
  max,
  step,
  onCommit,
  onPreview,
  className,
  title,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (n: number) => void;
  onPreview?: (n: number | null) => void;
  className?: string;
  title?: string;
}) {
  const [liveValue, setLiveValue] = React.useState(value);
  // Tracks what was last actually committed, same "don't re-dispatch an identical value" guard
  // ClampedNumberField's own lastCommittedRef uses - onPointerUp/onKeyUp/onBlur can otherwise all
  // fire for the same single gesture (e.g. a mouse drag that ends by tabbing away).
  const lastCommittedRef = React.useRef(value);
  // True between the first input event of a drag and its commit. Needed because `value` FLOWS BACK
  // during a live preview: the preview re-renders the selection, so this component's own `value`
  // prop becomes the previewed number mid-drag. Without this guard the resync effect below would
  // then record that previewed number as "last committed", and the real commit on release would see
  // n === lastCommittedRef and skip - the drag would preview correctly and then silently snap back.
  const draggingRef = React.useRef(false);

  // Resync when the committed value changes from elsewhere (undo/redo, another edit path) -
  // otherwise this slider would keep showing a stale drag-in-progress value forever. Skipped while
  // dragging, for the reason above.
  React.useEffect(() => {
    if (draggingRef.current) return;
    setLiveValue(value);
    lastCommittedRef.current = value;
  }, [value]);

  const commit = (n: number) => {
    // The preview always has to be torn down, even when the value ended up unchanged - otherwise a
    // drag that returns to where it started would leave the canvas pinned to a preview forever.
    draggingRef.current = false;
    onPreview?.(null);
    if (n === lastCommittedRef.current) return;
    lastCommittedRef.current = n;
    onCommit(n);
  };

  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={liveValue}
      onChange={(e) => {
        const next = Number(e.target.value);
        draggingRef.current = true;
        setLiveValue(next);
        onPreview?.(next);
      }}
      onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
      onBlur={(e) => commit(Number((e.target as HTMLInputElement).value))}
      className={className ?? SLIDER_CLASS}
      title={title}
    />
  );
}

// A slider paired with a numeric box, the standard control shape for every numeric setting in this
// panel. The box is not a nicety: a slider's range is a convenience for the common case, and without
// a place to type an exact value, anything outside that range (or any precise figure) is simply
// unreachable. Both halves drive the same commit path, and the slider previews live while dragged.
function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  integer = false,
  sliderMax,
  onCommit,
  onPreview,
  title,
  resetKey,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  // Lets the slider cover a narrower, more useful span than the field accepts - e.g. stroke width
  // sliding over a sensible range while the box still takes any value up to the hard cap.
  sliderMax?: number;
  onCommit: (n: number) => void;
  onPreview?: (n: number | null) => void;
  title?: string;
  // Forces the numeric box to re-seed from `value` - pass the selection's identity so switching
  // shapes reloads the field rather than leaving the previous shape's text in it.
  resetKey?: string;
}) {
  const topOfSlider = sliderMax ?? max;
  return (
    <Field label={label}>
      <div className="flex items-center gap-1.5">
        <ClampedNumberField
          key={resetKey}
          initialValue={value}
          min={min}
          max={max}
          step={step}
          integer={integer}
          onCommit={onCommit}
          className={NUMBER_INPUT_CLASS}
          title={title}
        />
        <LiveRangeSlider min={min} max={topOfSlider} step={step} value={Math.min(topOfSlider, Math.max(min, value))} onCommit={onCommit} onPreview={onPreview} title={title} />
      </div>
    </Field>
  );
}

// Same "track raw typed text locally, commit a parsed value, never fight mid-edit" discipline as
// ClampedNumberField above, just parsing a comma-separated number LIST instead of one number -
// commits on every keystroke that currently parses to at least one valid number (so the chart
// updates live as you type, same as every other field here), tolerating trailing junk like "3, 5,"
// while you're still typing the next value rather than dropping the whole edit.
function ChartDataField({ initialValue, onCommit, className }: { initialValue: number[]; onCommit: (values: number[]) => void; className: string }) {
  const [text, setText] = React.useState(initialValue.join(", "));
  const lastCommittedKey = React.useRef(text);
  const parse = (raw: string): number[] =>
    raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  return (
    <input
      type="text"
      value={text}
      placeholder="3, 7, 5, 9"
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const values = parse(raw);
        if (values.length === 0) return;
        const key = values.join(",");
        if (key === lastCommittedKey.current) return;
        lastCommittedKey.current = key;
        onCommit(values);
      }}
      onBlur={() => {
        const values = parse(text);
        if (values.length > 0) setText(values.join(", "));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
      className={className}
    />
  );
}

const FIELD_INPUT_CLASS = "w-32 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs";
// Ceiling for a node's stroke/ink width. Not a design limit - purely a guard against a typo (an
// accidental extra zero) producing a ring so thick it swallows the shape and leaves nothing visible
// to click back onto in order to undo it.
const MAX_STROKE_WIDTH = 400;

// ---- Panel design tokens -------------------------------------------------------------------------
//
// One place for every control's appearance, so the panel reads as a single designed surface rather
// than a pile of independently-styled inputs. Anything added here should reuse these rather than
// spelling out its own border/height/radius - that drift is exactly what made the panel look
// assembled rather than designed.
const NUMBER_INPUT_CLASS =
  "w-14 h-7 px-2 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs tabular-nums outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 transition";
const SELECT_CLASS =
  "w-36 h-7 px-2 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 transition";
const TEXT_INPUT_CLASS =
  "w-36 h-7 px-2 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 transition";
const SLIDER_CLASS = "w-[72px] accent-blue-600 cursor-pointer";
const SWATCH_CLASS = "w-7 h-7 rounded-md border border-gray-200 dark:border-neutral-700 bg-transparent cursor-pointer p-0.5";
const CHECKBOX_CLASS = "h-4 w-4 rounded accent-blue-600 cursor-pointer";

// Readable names for the header. Only the shapeTypes whose raw identifier doesn't already read as a
// name need an entry - everything else falls back to its own camelCase split into words, which is
// correct for "rectangle", "ellipse", "hexagon" and the rest without listing all seventy of them.
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
  equation: "Equation",
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
// actually reached for.
function Section({ title, children, dense }: { title?: string; children: React.ReactNode; dense?: boolean }) {
  return (
    <section className={`flex flex-col ${dense ? "gap-1.5" : "gap-2"}`}>
      {title && <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500 select-none">{title}</h3>}
      {children}
    </section>
  );
}

// A bordered sub-panel for a cluster that needs to read as one unit (crop, figure layout, one
// annotation's settings) rather than as loose rows in its parent section.
function Card({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-1.5 rounded-lg border border-gray-200 dark:border-neutral-700/80 bg-gray-50/60 dark:bg-neutral-800/40 p-2">{children}</div>;
}

const MINI_BUTTON_CLASS =
  "px-2.5 h-7 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs font-medium hover:bg-gray-50 dark:hover:bg-neutral-700 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition";

// The chart title / x-axis / y-axis caption inputs. Committed on every keystroke (rather than on
// blur) to match how the "graph" Expression field next to it already behaves - a caption is short
// enough that the per-keystroke re-render costs nothing, and seeing it appear as you type is the
// point.
function ChartTitleFields({ node, updateNodes }: { node: WhiteboardNode; updateNodes: (patch: Partial<WhiteboardNode>) => void }) {
  return (
    <>
      <Field label="Title">
        <input
          type="text"
          value={node.chartTitle ?? ""}
          placeholder="(none)"
          onChange={(e) => updateNodes({ chartTitle: e.target.value })}
          className={FIELD_INPUT_CLASS}
          title="Drawn above the plot - leave empty for no title"
        />
      </Field>
      <Field label="X axis label">
        <input
          type="text"
          value={node.axisXTitle ?? ""}
          placeholder="e.g. Wavenumber [cm⁻¹]"
          onChange={(e) => updateNodes({ axisXTitle: e.target.value })}
          className={FIELD_INPUT_CLASS}
        />
      </Field>
      <Field label="Y axis label">
        <input
          type="text"
          value={node.axisYTitle ?? ""}
          placeholder="e.g. Intensity [norm.]"
          onChange={(e) => updateNodes({ axisYTitle: e.target.value })}
          className={FIELD_INPUT_CLASS}
          title="Drawn rotated up the plot's left edge"
        />
      </Field>
    </>
  );
}

// The multi-series data editor for a "waterfallChart" - one trace per line, values separated by
// commas or whitespace, which is what pasting a column-per-trace export or a row of readings out of
// any analysis tool actually looks like.
//
// Unlike every other field in this panel, this one commits on an explicit Apply (or blur) rather
// than per keystroke: a realistic paste here is thousands of numbers, and re-parsing all of them
// plus rebuilding every trace's path on each keystroke is exactly the kind of work that makes a
// panel feel stuck. Local text state also means a half-typed line can't blank out the figure.
function SeriesDataField({ node, updateNodes }: { node: WhiteboardNode; updateNodes: (patch: Partial<WhiteboardNode>) => void }) {
  const resolved = resolveSeriesData(node);
  const toText = React.useCallback((series: number[][]) => series.map((t) => t.join(", ")).join("\n"), []);
  const [text, setText] = React.useState(() => toText(resolved.series));
  const [error, setError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);

  // Resync from the node whenever its data changes from somewhere else (undo/redo, a colormap
  // preset, another panel field) - but never while the user has unapplied edits in the box, which
  // would throw their typing away mid-edit.
  const nodeText = toText(resolved.series);
  const lastNodeTextRef = React.useRef(nodeText);
  React.useEffect(() => {
    if (nodeText !== lastNodeTextRef.current) {
      lastNodeTextRef.current = nodeText;
      if (!dirty) setText(nodeText);
    }
  }, [nodeText, dirty]);

  const apply = () => {
    const parsed = text
      .split("\n")
      .map((line) => line.split(/[,\s]+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)))
      .filter((t) => t.length > 0);
    if (parsed.length === 0) {
      setError("No numbers found - one trace per line, values separated by commas or spaces.");
      return;
    }
    if (parsed.length > MAX_SERIES_COUNT) {
      setError(`Too many traces (${parsed.length}); the limit is ${MAX_SERIES_COUNT}.`);
      return;
    }
    const tooLong = parsed.find((t) => t.length > MAX_SERIES_POINTS);
    if (tooLong) {
      setError(`A trace has ${tooLong.length} points; the limit is ${MAX_SERIES_POINTS}.`);
      return;
    }
    setError(null);
    setDirty(false);
    lastNodeTextRef.current = toText(parsed);
    // Per-trace color overrides are indexed positionally, so a replacement with a different trace
    // count would leave them pointing at the wrong traces - dropping them re-derives every color
    // from the colormap, which is the only interpretation that can't be silently wrong.
    updateNodes(parsed.length === resolved.series.length ? { seriesData: parsed } : { seriesData: parsed, seriesColors: undefined });
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-gray-600 dark:text-neutral-300">
        <span>Data</span>
        <span className="text-[10px] text-gray-400 dark:text-neutral-500">
          {resolved.series.length} traces × {resolved.series.reduce((m, t) => Math.max(m, t.length), 0)} pts
        </span>
      </div>
      <textarea
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        onBlur={apply}
        rows={5}
        className="w-full px-1.5 py-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[11px] font-mono resize-y"
        placeholder={"1, 4, 9, 4, 1\n2, 6, 12, 6, 2"}
        title="One trace per line; values separated by commas or spaces"
      />
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={apply} disabled={!dirty} className={MINI_BUTTON_CLASS}>
          Apply
        </button>
        {dirty && <span className="text-[10px] text-amber-600 dark:text-amber-400">unapplied edits</span>}
      </div>
      {error && <span className="text-[10px] text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}

// Per-trace color overrides. Only rendered for a manageable number of traces - past that the
// colormap IS the encoding (a continuous scale you read as a progression), and a 100-row swatch list
// would be both unusable and a lot of DOM for no benefit.
const MAX_TRACE_COLOR_ROWS = 24;

function SeriesColorList({ node, updateNodes }: { node: WhiteboardNode; updateNodes: (patch: Partial<WhiteboardNode>) => void }) {
  const resolved = resolveSeriesData(node);
  if (resolved.series.length > MAX_TRACE_COLOR_ROWS) {
    return (
      <div className="text-[10px] text-gray-400 dark:text-neutral-500">
        {resolved.series.length} traces - per-trace colors are only editable up to {MAX_TRACE_COLOR_ROWS}. Use the colormap above.
      </div>
    );
  }
  const setColor = (index: number, color: string | null) => {
    const next = Array.from({ length: resolved.series.length }, (_, i) => node.seriesColors?.[i] ?? null);
    next[index] = color;
    // All overrides cleared - drop the array entirely rather than storing a row of nulls, so the
    // node goes back to looking exactly like one that never had an override set.
    updateNodes({ seriesColors: next.every((c) => c === null) ? undefined : next });
  };
  return (
    <div className="flex flex-col gap-1 max-h-40 overflow-y-auto pr-1">
      {resolved.series.map((_, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="color"
            value={resolved.colors[i]}
            onChange={(e) => setColor(i, e.target.value)}
            className="h-6 w-8 rounded border border-gray-200 dark:border-neutral-700 bg-transparent"
            title={`Trace ${i + 1} color`}
          />
          <input
            type="text"
            value={node.seriesLabels?.[i] ?? ""}
            placeholder={`Series ${i + 1}`}
            onChange={(e) => {
              const next = Array.from({ length: resolved.series.length }, (_, j) => node.seriesLabels?.[j] ?? "");
              next[i] = e.target.value;
              updateNodes({ seriesLabels: next });
            }}
            className="flex-1 min-w-0 h-6 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[11px]"
          />
          <button
            type="button"
            onClick={() => setColor(i, null)}
            disabled={!node.seriesColors?.[i]}
            className="px-1 h-6 rounded text-[10px] border border-gray-200 dark:border-neutral-700 disabled:opacity-30"
            title="Back to this trace's colormap color"
          >
            ↺
          </button>
        </div>
      ))}
    </div>
  );
}

// A small preview strip of a colormap, so the dropdown is picked by eye rather than by remembering
// what "cividis" looks like. Built from the same sampler the traces themselves use, so the swatch
// can never show colors the plot won't.
function ColormapSwatch({ name, reversed }: { name: ColormapName; reversed: boolean }) {
  const stops = colormapPalette(name, 24, reversed);
  return (
    <div className="flex h-3 w-full overflow-hidden rounded border border-gray-200 dark:border-neutral-700">
      {stops.map((c, i) => (
        <div key={i} className="flex-1" style={{ backgroundColor: c }} />
      ))}
    </div>
  );
}

// The data-space callout list (see whiteboardTypes.ts's ChartAnnotation). Each row edits one
// callout's text/marker/color; its POSITION is set by dragging its handle on the canvas rather than
// by typing coordinates here, which is both faster and the only way to place one accurately against
// the data it is marking.
function AnnotationFields({ node, updateNodes }: { node: WhiteboardNode; updateNodes: (patch: Partial<WhiteboardNode>) => void }) {
  const annotations = node.chartAnnotations ?? [];
  const update = (index: number, patch: Partial<ChartAnnotation>) =>
    updateNodes({ chartAnnotations: annotations.map((a, i) => (i === index ? { ...a, ...patch } : a)) });
  const add = () => {
    // Placed at the middle of the current axis window rather than at the origin, which for a plot
    // whose range doesn't include 0 would drop the new callout off-screen where it can't be grabbed.
    const mapper = annotationCoordinateMapper(node.shapeType, node.width, node.height, outlineOptionsFor(node));
    updateNodes({
      chartAnnotations: [
        ...annotations,
        { x: mapper.invMapX(mapper.padX + mapper.plotW / 2), y: mapper.invMapY(mapper.padY + mapper.plotH / 2), text: "Label", marker: "dot", color: node.strokeColor },
      ],
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs text-gray-600 dark:text-neutral-300">
        <span>Annotations</span>
        <button type="button" onClick={add} className={MINI_BUTTON_CLASS}>
          + Add
        </button>
      </div>
      {annotations.length === 0 && <span className="text-[10px] text-gray-400 dark:text-neutral-500">None. Add one, then drag its ring on the canvas to place it.</span>}
      {annotations.map((a, i) => (
        <div key={i} className="flex flex-col gap-1 rounded-lg border border-gray-200 dark:border-neutral-700/80 bg-gray-50/60 dark:bg-neutral-800/40 p-2">
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={a.text ?? ""}
              placeholder="(marker only)"
              onChange={(e) => update(i, { text: e.target.value })}
              className="flex-1 min-w-0 h-6 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[11px]"
            />
            <button
              type="button"
              onClick={() => updateNodes({ chartAnnotations: annotations.filter((_, j) => j !== i) })}
              className="px-1.5 h-6 rounded text-[10px] border border-gray-200 dark:border-neutral-700 text-red-600 dark:text-red-400"
              title="Remove this annotation"
            >
              ✕
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={a.marker ?? "dot"}
              onChange={(e) => update(i, { marker: e.target.value as NonNullable<ChartAnnotation["marker"]> })}
              className="h-6 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[11px]"
            >
              <option value="dot">Dot</option>
              <option value="ring">Ring</option>
              <option value="square">Square</option>
              <option value="cross">Cross</option>
              <option value="none">No marker</option>
            </select>
            <input
              type="color"
              value={a.color ?? node.strokeColor}
              onChange={(e) => update(i, { color: e.target.value })}
              className="h-6 w-8 rounded border border-gray-200 dark:border-neutral-700 bg-transparent"
              title="Marker and label color"
            />
            <label className="flex items-center gap-1 text-[10px] text-gray-600 dark:text-neutral-300" title="Draw a thin line from the marker to its label">
              <input type="checkbox" checked={a.leader ?? false} onChange={(e) => update(i, { leader: e.target.checked })} className="h-3 w-3" />
              Leader
            </label>
          </div>
        </div>
      ))}
    </div>
  );
}

// Align / distribute / arrange-into-a-grid for a multi-node selection - the "make these panels into
// a figure" controls. Every action routes through the existing batchEditNodes path, so each one is a
// single undo step and needs no command type of its own (see whiteboardHandlers.ts's own figure-
// layout section for the pure functions behind these buttons).
function FigureLayoutFields({
  nodes,
  onBatchEditNodes,
}: {
  nodes: WhiteboardNode[];
  onBatchEditNodes: (before: WhiteboardNode[], after: WhiteboardNode[]) => void;
}) {
  const [columns, setColumns] = React.useState(2);
  const [gap, setGap] = React.useState(DEFAULT_GRID_GAP);
  const [uniform, setUniform] = React.useState(true);

  // The layout functions return only the nodes they actually moved (locked ones are skipped), so the
  // matching `before` array has to be looked up by id rather than assumed to be the whole selection.
  const apply = (after: WhiteboardNode[]) => {
    if (after.length === 0) return;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const before = after.map((n) => byId.get(n.id)).filter((n): n is WhiteboardNode => Boolean(n));
    if (before.length !== after.length) return;
    onBatchEditNodes(before, after);
  };

  const alignButtons: { edge: AlignEdge; label: string; title: string }[] = [
    { edge: "left", label: "⇤", title: "Align left edges" },
    { edge: "centerX", label: "⇹", title: "Align horizontal centers" },
    { edge: "right", label: "⇥", title: "Align right edges" },
    { edge: "top", label: "⤒", title: "Align top edges" },
    { edge: "centerY", label: "⇳", title: "Align vertical centers" },
    { edge: "bottom", label: "⤓", title: "Align bottom edges" },
  ];

  return (
    <Card>
      <span className="text-xs font-medium text-gray-600 dark:text-neutral-300">Figure layout</span>
      <div className="grid grid-cols-6 gap-1">
        {alignButtons.map((b) => (
          <button key={b.edge} type="button" onClick={() => apply(alignNodes(nodes, b.edge))} className="h-7 rounded border border-gray-200 dark:border-neutral-700 text-xs hover:bg-gray-50 dark:hover:bg-neutral-700" title={b.title}>
            {b.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => apply(distributeNodes(nodes, "horizontal"))}
          disabled={nodes.length < 3}
          className={`flex-1 ${MINI_BUTTON_CLASS}`}
          title="Equalize the horizontal gaps, keeping the outermost two shapes where they are (needs 3+)"
        >
          Spread H
        </button>
        <button
          type="button"
          onClick={() => apply(distributeNodes(nodes, "vertical"))}
          disabled={nodes.length < 3}
          className={`flex-1 ${MINI_BUTTON_CLASS}`}
          title="Equalize the vertical gaps, keeping the outermost two shapes where they are (needs 3+)"
        >
          Spread V
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <label className="flex items-center gap-1 text-[10px] text-gray-600 dark:text-neutral-300">
          Cols
          <input
            type="number"
            min={1}
            max={nodes.length}
            value={columns}
            onChange={(e) => setColumns(Math.max(1, Math.min(nodes.length, Number(e.target.value) || 1)))}
            className={NUMBER_INPUT_CLASS}
          />
        </label>
        <label className="flex items-center gap-1 text-[10px] text-gray-600 dark:text-neutral-300">
          Gap
          <input
            type="number"
            min={0}
            max={400}
            value={gap}
            onChange={(e) => setGap(Math.max(0, Math.min(400, Number(e.target.value) || 0)))}
            className={NUMBER_INPUT_CLASS}
          />
        </label>
      </div>
      <label className="flex items-center gap-1.5 text-[10px] text-gray-600 dark:text-neutral-300" title="Resize every panel to the largest one, so the subplots match">
        <input type="checkbox" checked={uniform} onChange={(e) => setUniform(e.target.checked)} className="h-3 w-3" />
        Equal panel sizes
      </label>
      <button
        type="button"
        onClick={() => apply(arrangeNodesInGrid(nodes, { columns, gapX: gap, gapY: gap, sizing: uniform ? "uniform" : "keep" }))}
        className={MINI_BUTTON_CLASS}
        title="Lays the selected shapes out row by row into a subplot grid, anchored at their current top-left"
      >
        Arrange in grid
      </button>
    </Card>
  );
}

// Everything specific to an "image" node. The ring border and the matte behind a "contain" fit are
// deliberately NOT here - those are the node's ordinary Stroke and Fill controls, which already
// appear above for every shape; an image reusing them (rather than getting its own duplicate pair)
// is what makes "circular photo with a thick orange ring" a two-control change instead of a
// dedicated shape type.
function ImageFields({
  node,
  updateNodes,
  onReplace,
  cropping,
  onToggleCrop,
  previewField,
}: {
  node: WhiteboardNode;
  updateNodes: (patch: Partial<WhiteboardNode>) => void;
  onReplace: () => void;
  cropping: boolean;
  onToggleCrop?: () => void;
  previewField: (key: keyof WhiteboardNode) => (n: number | null) => void;
}) {
  const crop = resolveImageCrop(node);
  const natural = naturalImageSize(node);
  // Percent, because a crop reads far more naturally as "trim 10% off the left" than as 0.1 - and
  // the four values are stored as fractions precisely so they survive a source swap (see
  // WhiteboardNode.imageCropX's own doc comment).
  const pct = (v: number) => Math.round(v * 1000) / 10;
  const setCrop = (patch: Partial<{ x: number; y: number; w: number; h: number }>) => {
    const next = { ...crop, ...patch };
    updateNodes({ imageCropX: next.x, imageCropY: next.y, imageCropW: next.w, imageCropH: next.h });
  };
  return (
    <>
      <Field label="Fit">
        <select
          value={node.imageFit ?? "cover"}
          onChange={(e) => updateNodes({ imageFit: e.target.value as NonNullable<WhiteboardNode["imageFit"]> })}
          className={FIELD_INPUT_CLASS}
          title="Cover fills the box and crops the overflow; Contain fits the whole image inside, showing Fill in the margin; Stretch ignores aspect ratio"
        >
          <option value="cover">Cover (crop to fill)</option>
          <option value="contain">Contain (fit inside)</option>
          <option value="fill">Stretch</option>
        </select>
      </Field>
      <Field label="Shape">
        <select
          value={node.imageMask ?? "rect"}
          onChange={(e) => updateNodes({ imageMask: e.target.value as NonNullable<WhiteboardNode["imageMask"]> })}
          className={FIELD_INPUT_CLASS}
          title="The silhouette the photo is cut to - the Stroke controls above then draw a ring following that same edge"
        >
          <option value="rect">Rectangle</option>
          <option value="rounded">Rounded</option>
          <option value="ellipse">Circle / ellipse</option>
        </select>
      </Field>
      <SliderField
        label="Opacity"
        resetKey={`op-${node.id}`}
        value={node.imageOpacity ?? 1}
        min={0}
        max={1}
        step={0.05}
        onCommit={(n) => updateNodes({ imageOpacity: n })}
        onPreview={previewField("imageOpacity")}
      />
      <Field label="Grayscale">
        <input
          type="checkbox"
          checked={node.imageGrayscale ?? false}
          onChange={(e) => updateNodes({ imageGrayscale: e.target.checked })}
          className={CHECKBOX_CLASS}
          title="Desaturates the photo - keeps a reference figure from competing with annotation drawn over it"
        />
      </Field>

      <Card>
        <div className="flex items-center justify-between text-xs text-gray-600 dark:text-neutral-300">
          <span className="font-medium">Crop (%)</span>
          <button
            type="button"
            onClick={() => updateNodes({ imageCropX: undefined, imageCropY: undefined, imageCropW: undefined, imageCropH: undefined })}
            disabled={!hasImageCrop(node)}
            className={MINI_BUTTON_CLASS}
            title="Show the whole image again"
          >
            Reset
          </button>
        </div>
        <button
          type="button"
          onClick={onToggleCrop}
          disabled={!onToggleCrop || node.locked}
          className={`${MINI_BUTTON_CLASS} ${cropping ? "ring-1 ring-blue-500 bg-blue-50 dark:bg-blue-500/20" : ""}`}
          title="Shows the whole picture with a draggable crop rectangle - drag its corners to crop at any angle, or drag inside it to reframe"
        >
          {cropping ? "Done cropping" : "Crop image"}
        </button>
        <span className="text-[10px] text-gray-400 dark:text-neutral-500">Drag the corners to crop freely, or inside the box to reframe. Double-clicking the image does the same.</span>
        <div className="grid grid-cols-2 gap-1">
          {([
            ["Left", crop.x, (v: number) => setCrop({ x: Math.min(v, crop.x + crop.w - 0.01), w: crop.w + (crop.x - Math.min(v, crop.x + crop.w - 0.01)) })],
            ["Top", crop.y, (v: number) => setCrop({ y: Math.min(v, crop.y + crop.h - 0.01), h: crop.h + (crop.y - Math.min(v, crop.y + crop.h - 0.01)) })],
            ["Width", crop.w, (v: number) => setCrop({ w: Math.max(0.01, Math.min(v, 1 - crop.x)) })],
            ["Height", crop.h, (v: number) => setCrop({ h: Math.max(0.01, Math.min(v, 1 - crop.y)) })],
          ] as [string, number, (v: number) => void][]).map(([label, value, apply]) => (
            <label key={label} className="flex items-center gap-1 text-[10px] text-gray-600 dark:text-neutral-300">
              {label}
              <ClampedNumberField
                key={`${label}-${node.id}-${Math.round(value * 1000)}`}
                initialValue={pct(value)}
                min={0}
                max={100}
                step={1}
                integer={false}
                onCommit={(n) => apply(n / 100)}
                className="w-12 h-6 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[11px]"
              />
            </label>
          ))}
        </div>
      </Card>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            if (natural) updateNodes({ width: natural.width, height: natural.height });
          }}
          disabled={!natural}
          className={`flex-1 ${MINI_BUTTON_CLASS}`}
          title={natural ? `Resize the box to ${natural.width} x ${natural.height} px - the cropped image's own pixel size` : "Source size unknown"}
        >
          Natural size
        </button>
        <button
          type="button"
          onClick={() => {
            // Height follows width, so the box matches the cropped source's aspect ratio without
            // changing how big the node currently is on the canvas.
            if (!natural) return;
            updateNodes({ height: Math.max(1, Math.round((node.width * natural.height) / natural.width)) });
          }}
          disabled={!natural}
          className={`flex-1 ${MINI_BUTTON_CLASS}`}
          title="Adjust the height so the box matches the image's aspect ratio, keeping the current width"
        >
          Fix aspect
        </button>
      </div>
      {/* Full-width with an icon rather than another plain text button: this is the one action in
          the image section that opens a file dialog and swaps the underlying asset, so it should
          read as a distinct, deliberate action rather than another small toggle in the row above. */}
      <button
        type="button"
        onClick={onReplace}
        title="Swap in a different picture, keeping this node's size, crop and styling"
        className="w-full h-8 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-gray-300 dark:border-neutral-600 text-xs font-medium text-gray-600 dark:text-neutral-300 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-500/10 active:scale-[0.99] transition"
      >
        <IoSwapHorizontalOutline size={14} />
        Replace image
      </button>
    </>
  );
}

// The 4-direction nudge button grid - shared by the node section's own "Nudge" field and the
// connector section's (see nudgeEdgeBy's own doc comment for why an edge can be nudged too, not
// just moved by dragging its body). 1px per click, 10px with Shift held - same step sizes as the
// arrow-key shortcut (WhiteboardCanvas.tsx's keydown handler) so both controls move a selection by
// identical, predictable amounts.
function NudgeGrid({ onNudge }: { onNudge: (dx: number, dy: number) => void }) {
  return (
    <div className="grid grid-cols-3 grid-rows-2 gap-0.5">
      <span />
      <button
        type="button"
        onClick={(e) => onNudge(0, e.shiftKey ? -10 : -1)}
        title="Nudge up (↑, Shift for 10px)"
        className="h-6 w-6 flex items-center justify-center rounded border border-gray-200 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-xs leading-none"
      >
        ↑
      </button>
      <span />
      <button
        type="button"
        onClick={(e) => onNudge(e.shiftKey ? -10 : -1, 0)}
        title="Nudge left (←, Shift for 10px)"
        className="h-6 w-6 flex items-center justify-center rounded border border-gray-200 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-xs leading-none"
      >
        ←
      </button>
      <button
        type="button"
        onClick={(e) => onNudge(0, e.shiftKey ? 10 : 1)}
        title="Nudge down (↓, Shift for 10px)"
        className="h-6 w-6 flex items-center justify-center rounded border border-gray-200 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-xs leading-none"
      >
        ↓
      </button>
      <button
        type="button"
        onClick={(e) => onNudge(e.shiftKey ? 10 : 1, 0)}
        title="Nudge right (→, Shift for 10px)"
        className="h-6 w-6 flex items-center justify-center rounded border border-gray-200 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-xs leading-none"
      >
        →
      </button>
    </div>
  );
}

// Rotates a fully free-floating edge (both ends unattached to any shape - see this field's own
// call site for the `bothFree` gate) around the bounding-box center of its own CURRENT point set -
// an edge has no persisted `rotation` field the way a WhiteboardNode does (nothing else about an
// edge's rendering needs one, and its "shape" IS its point coordinates, not a box with a transform
// layered on top), so this field tracks the angle typed so far in local state and, on every change,
// rotates the LIVE `edge` prop (never a cached gesture-start snapshot) by the DELTA since the last
// commit. Rotating from the live prop every time - rather than a fixed original-geometry snapshot
// captured once at mount - matters because this field stays mounted across unrelated edits to the
// SAME edge (e.g. double-clicking the line to add a bend point while the panel is open): a
// fixed-snapshot version would silently discard any such edit the next time rotation changed,
// overwriting it with a fresh rotation of the now-stale snapshot. The tradeoff is the usual
// incremental-rotation one (many small adjustments can compound tiny floating-point drift) - much
// less costly than losing an edit. `key={edge.id}` at the call site remounts this (resetting the
// angle back to 0) whenever the selection moves to a DIFFERENT edge.
function EdgeRotateField({ edge, onCommit }: { edge: WhiteboardEdge; onCommit: (patch: Partial<WhiteboardEdge>) => void }) {
  const [angle, setAngle] = React.useState(0);
  const lastAngleRef = React.useRef(0);
  const applyRotation = (deg: number) => {
    const delta = deg - lastAngleRef.current;
    lastAngleRef.current = deg;
    setAngle(deg);
    const waypoints = edge.waypoints ?? [];
    const points = [
      { x: edge.source.x ?? 0, y: edge.source.y ?? 0 },
      ...waypoints,
      { x: edge.target.x ?? 0, y: edge.target.y ?? 0 },
    ];
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const rad = (delta * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rotate = (p: { x: number; y: number }) => ({ x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos });
    const newSource = rotate(points[0]);
    const newTarget = rotate(points[points.length - 1]);
    const newWaypoints = waypoints.map((wp) => rotate(wp));
    onCommit({ source: { x: newSource.x, y: newSource.y }, target: { x: newTarget.x, y: newTarget.y }, waypoints: newWaypoints });
  };
  return (
    <Field label="Rotation (°)">
      <ClampedNumberField
        initialValue={angle}
        min={-360}
        max={360}
        onCommit={applyRotation}
        className={NUMBER_INPUT_CLASS}
        title="Rotates the whole line around its own center - only available while both ends are free-floating"
      />
    </Field>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 min-h-[28px] text-xs text-gray-600 dark:text-neutral-300">
      {/* The label truncates rather than wrapping: a two-line label would break the even row rhythm
          that makes a long panel scannable, and the full text is still reachable on hover. */}
      <span className="truncate" title={label}>
        {label}
      </span>
      {children}
    </label>
  );
}

// Rows/Columns steppers + header-row toggle for a single selected "table" node - see this block's
// own call site (in the main component below) for why row/column count can't go through the
// generic multi-node `updateNodes` the way every other field in this panel does. Always
// adds/removes at the END (the last row/column) - inserting/deleting at an arbitrary position is a
// WhiteboardTable.tsx affordance instead (hover a specific row/column while it's selected).
function TableStructureFields({ node, updateNodes }: { node: WhiteboardNode; updateNodes: (patch: Partial<WhiteboardNode>) => void }) {
  const grid = resolveTableGrid(node);
  const addRow = () => {
    if (grid.rows >= MAX_TABLE_ROWS) return;
    updateNodes({
      tableRows: grid.rows + 1,
      tableRowHeights: insertTableFraction(grid.rowHeights, grid.rows),
      tableCellText: [...grid.cellText.map((r) => [...r]), Array(grid.cols).fill("")],
    });
  };
  const removeRow = () => {
    if (grid.rows <= MIN_TABLE_ROWS) return;
    updateNodes({ tableRows: grid.rows - 1, tableRowHeights: removeTableFraction(grid.rowHeights, grid.rows - 1), tableCellText: grid.cellText.slice(0, -1) });
  };
  const addCol = () => {
    if (grid.cols >= MAX_TABLE_COLS) return;
    updateNodes({ tableCols: grid.cols + 1, tableColWidths: insertTableFraction(grid.colWidths, grid.cols), tableCellText: grid.cellText.map((r) => [...r, ""]) });
  };
  const removeCol = () => {
    if (grid.cols <= MIN_TABLE_COLS) return;
    updateNodes({ tableCols: grid.cols - 1, tableColWidths: removeTableFraction(grid.colWidths, grid.cols - 1), tableCellText: grid.cellText.map((r) => r.slice(0, -1)) });
  };
  const stepperButtonClass = "h-6 w-6 flex items-center justify-center rounded border border-gray-200 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-xs leading-none disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <>
      <Field label="Rows">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={removeRow} disabled={grid.rows <= MIN_TABLE_ROWS} className={stepperButtonClass} title="Remove last row">
            −
          </button>
          <span className="w-4 text-center">{grid.rows}</span>
          <button type="button" onClick={addRow} disabled={grid.rows >= MAX_TABLE_ROWS} className={stepperButtonClass} title="Add row">
            +
          </button>
        </div>
      </Field>
      <Field label="Columns">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={removeCol} disabled={grid.cols <= MIN_TABLE_COLS} className={stepperButtonClass} title="Remove last column">
            −
          </button>
          <span className="w-4 text-center">{grid.cols}</span>
          <button type="button" onClick={addCol} disabled={grid.cols >= MAX_TABLE_COLS} className={stepperButtonClass} title="Add column">
            +
          </button>
        </div>
      </Field>
      <Field label="Header row">
        <input type="checkbox" checked={node.tableHeaderRow ?? true} onChange={(e) => updateNodes({ tableHeaderRow: e.target.checked })} className={CHECKBOX_CLASS} />
      </Field>
    </>
  );
}

// Background + per-side border-style controls for whatever cell/row/column range is currently
// selected INSIDE a table (see WhiteboardTableProps.onRangeChange's own doc comment for how that
// range gets here) - a separate block from TableStructureFields above because these act on a
// RECTANGLE of cells the table itself is tracking, not on the table node as a whole the way every
// other field in this panel does. `updateNodes` still works unmodified as the commit path here:
// this block only ever renders while exactly one table node is selected, so applying the same patch
// "to every selected node" is applying it to just that one, same as TableStructureFields.
function TableCellFields({
  node,
  range,
  updateNodes,
}: {
  node: WhiteboardNode;
  range: { r0: number; c0: number; r1: number; c1: number };
  updateNodes: (patch: Partial<WhiteboardNode>) => void;
}) {
  const grid = resolveTableGrid(node);
  // `range` is lifted up from WhiteboardTable.tsx's own live state (see this component's own doc
  // comment) rather than derived fresh from `node` here, so it can go briefly stale relative to
  // THIS render's grid - e.g. a row/column just got deleted (shrinking rows/cols) in the same tick
  // that this panel re-renders with the OLD range still pointing past the new bounds, before that
  // component's own onRangeChange effect has caught up and reported the clamped range back. Clamp
  // defensively here too rather than indexing straight off a stale row/col - the CommonJS ??-chained
  // read that follows never throws, but an un-clamped `grid.cellFill[range.r0]` could be `undefined`
  // for an out-of-range row, and indexing INTO that for `[range.c0]` (or anchorBorders[side] below)
  // would crash the whole style panel instead of just showing a one-tick-stale value.
  const anchorRow = Math.min(range.r0, grid.rows - 1);
  const anchorCol = Math.min(range.c0, grid.cols - 1);
  const anchorFill = grid.cellFill[anchorRow][anchorCol];
  const anchorBorders = grid.cellBorders[anchorRow][anchorCol];
  const sideField = (label: string, side: "top" | "right" | "bottom" | "left") => (
    <Field label={label}>
      <select
        value={anchorBorders[side] ?? "solid"}
        onChange={(e) => updateNodes(withRangeBorderSide(node, range, side, e.target.value as TableBorderStyle))}
        className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
      >
        <option value="solid">Solid</option>
        <option value="dashed">Dashed</option>
        <option value="dotted">Dotted</option>
        <option value="none">None</option>
      </select>
    </Field>
  );
  return (
    <div className="border-t border-gray-100 dark:border-neutral-700/70 pt-2 flex flex-col gap-2">
      <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-neutral-500">
        {range.r0 === range.r1 && range.c0 === range.c1 ? "Cell" : "Cells"}
      </p>
      <Field label="Background">
        <div className="flex items-center gap-1.5">
          <input
            type="color"
            value={anchorFill ?? node.fillColor ?? "#ffffff"}
            onChange={(e) => updateNodes(withRangeFill(node, range, e.target.value))}
            className={SWATCH_CLASS}
          />
          <button
            type="button"
            onClick={() => updateNodes(withRangeFill(node, range, null))}
            disabled={!anchorFill}
            className="text-[10px] text-gray-500 hover:text-gray-700 dark:text-neutral-400 dark:hover:text-neutral-200 disabled:opacity-30"
            title="Clear override - back to the table's own background"
          >
            Clear
          </button>
        </div>
      </Field>
      {sideField("Top line", "top")}
      {sideField("Right line", "right")}
      {sideField("Bottom line", "bottom")}
      {sideField("Left line", "left")}
    </div>
  );
}

const WhiteboardStylePanel: React.FC<WhiteboardStylePanelProps> = ({
  selectedNodes,
  selectedEdges,
  tableRangeSelection,
  onBatchEditNodes,
  onEditEdge,
  onDeleteNode,
  onDeleteEdge,
  onDuplicateNode,
  onBringToFront,
  onSendToBack,
  onGroup,
  onUngroup,
  onReplaceImage,
  croppingNodeId,
  onToggleCrop,
  onPreviewNodes,
}) => {
  const updateNodes = (patch: Partial<WhiteboardNode>) => {
    if (selectedNodes.length === 0) return;
    onBatchEditNodes(selectedNodes, selectedNodes.map((n) => ({ ...n, ...patch })));
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
    onBatchEditNodes(selectedNodes, selectedNodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })));
  };

  const edge = selectedEdges.length === 1 ? selectedEdges[0] : null;
  const updateEdge = (patch: Partial<WhiteboardEdge>) => {
    if (!edge) return;
    onEditEdge(edge, { ...edge, ...patch });
  };

  if (selectedNodes.length === 0 && selectedEdges.length === 0) return null;

  return (
    <div className="absolute top-3 right-3 bottom-3 w-72 bg-white/90 dark:bg-neutral-900/90 backdrop-blur-xl border border-gray-200/80 dark:border-neutral-700/80 rounded-xl shadow-xl shadow-black/5 flex flex-col overflow-hidden text-neutral-800 dark:text-neutral-200">
      {/* Sticky header - a long panel scrolls well past its own top, and without this there's no
          persistent indication of WHAT the controls below are acting on. */}
      <div className="shrink-0 px-3 py-2.5 border-b border-gray-100 dark:border-neutral-800 bg-white/70 dark:bg-neutral-900/70">
        <p className="text-xs font-semibold tracking-tight">
          {selectedNodes.length > 1
            ? `${selectedNodes.length} shapes selected`
            : selectedNodes.length === 1
              ? shapeLabel(selectedNodes[0].shapeType)
              : selectedEdges.length > 1
                ? `${selectedEdges.length} connectors`
                : "Connector"}
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
      {selectedNodes.length > 0 && (
        <>
          <Section title="Position" dense>
          {selectedNodes.length === 1 && (
            <>
              <Field label="X">
                <ClampedNumberField
                  key={selectedNodes[0].id}
                  initialValue={Math.round(selectedNodes[0].x)}
                  min={-100000}
                  max={100000}
                  onCommit={(n) => updateNodes({ x: n })}
                  className={NUMBER_INPUT_CLASS}
                />
              </Field>
              <Field label="Y">
                <ClampedNumberField
                  key={selectedNodes[0].id}
                  initialValue={Math.round(selectedNodes[0].y)}
                  min={-100000}
                  max={100000}
                  onCommit={(n) => updateNodes({ y: n })}
                  className={NUMBER_INPUT_CLASS}
                />
              </Field>
            </>
          )}
          <Field label="Nudge">
            <NudgeGrid onNudge={nudgeSelected} />
          </Field>

          {selectedNodes.length > 1 && <FigureLayoutFields nodes={selectedNodes} onBatchEditNodes={onBatchEditNodes} />}
          </Section>

          <Section title="Appearance" dense>
          {selectedNodes.some((n) => n.shapeType !== "text" && n.shapeType !== "freehand" && !LINE_ONLY_SHAPES.has(n.shapeType)) && (
            <Field label="Fill">
              <input
                type="color"
                value={selectedNodes[0].fillColor ?? "#ffffff"}
                onChange={(e) => updateNodes({ fillColor: e.target.value })}
                className={SWATCH_CLASS}
              />
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType !== "latticeGauge") && (
            <>
              <Field label={selectedNodes.every((n) => n.shapeType === "freehand") ? "Ink color" : "Stroke color"}>
                <input type="color" value={selectedNodes[0].strokeColor} onChange={(e) => updateNodes({ strokeColor: e.target.value })} className={SWATCH_CLASS} />
              </Field>
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
                    label={selectedNodes.every((n) => n.shapeType === "freehand") ? "Ink width" : "Stroke width"}
                    resetKey={`sw-${selectedNodes.map((n) => n.id).join(",")}`}
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
            </>
          )}
          <Field label="Rotation (°)">
            <ClampedNumberField
              key={selectedNodes.map((n) => n.id).join(",")}
              initialValue={selectedNodes[0].rotation ?? 0}
              min={0}
              max={360}
              // 360 is visually identical to 0 (no rotation) - normalize both to "unset" rather than
              // clamping a typed 360 down to 359, which read as an arbitrary, unexplained cap.
              onCommit={(n) => updateNodes({ rotation: n === 0 || n === 360 ? undefined : n })}
              className={NUMBER_INPUT_CLASS}
            />
          </Field>
          <Field label="Locked">
            <input
              type="checkbox"
              checked={selectedNodes.every((n) => n.locked ?? false)}
              onChange={(e) => updateNodes({ locked: e.target.checked })}
              className={CHECKBOX_CLASS}
              title="Prevents dragging, resizing, rotating, or nudging this shape until unlocked again - handy while manually plotting onto a graph, or annotating around a shape you don't want to bump"
            />
          </Field>
          <Field label="Flip">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => updateNodes({ flipHorizontal: !(selectedNodes[0].flipHorizontal ?? false) })}
                title="Flip horizontal"
                className={`p-1.5 rounded ${selectedNodes[0].flipHorizontal ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
              >
                <TbFlipHorizontal size={16} />
              </button>
              <button
                type="button"
                onClick={() => updateNodes({ flipVertical: !(selectedNodes[0].flipVertical ?? false) })}
                title="Flip vertical"
                className={`p-1.5 rounded ${selectedNodes[0].flipVertical ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
              >
                <TbFlipVertical size={16} />
              </button>
            </div>
          </Field>
          {/* An image only uses cornerRadius when its mask is "rounded" - showing the slider for a
              rect/ellipse-masked image would be a control with no visible effect. */}
          {selectedNodes.every(
            (n) => n.shapeType === "rectangle" || n.shapeType === "equation" || (n.shapeType === "image" && (n.imageMask ?? "rect") === "rounded")
          ) && (
            <SliderField
              label="Corner radius"
              resetKey={`cr-${selectedNodes.map((n) => n.id).join(",")}`}
              value={selectedNodes[0].cornerRadius ?? 0}
              min={0}
              max={Math.min(selectedNodes[0].width, selectedNodes[0].height) / 2}
              step={1}
              onCommit={(n) => updateNodes({ cornerRadius: n })}
              onPreview={previewField("cornerRadius")}
            />
          )}
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
                  className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
          {selectedNodes.every((n) => n.shapeType === "functionPlot") && (
            <Field label="Show grid">
              <input
                type="checkbox"
                checked={selectedNodes[0].plotShowGrid ?? false}
                onChange={(e) => updateNodes({ plotShowGrid: e.target.checked })}
                className={CHECKBOX_CLASS}
                title="Faint gridlines across the whole plot at every tick, not just the axis tick marks"
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
                  className="w-32 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs font-mono"
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
              <Field label="Show grid">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].graphShowGrid ?? true}
                  onChange={(e) => updateNodes({ graphShowGrid: e.target.checked })}
                  className={CHECKBOX_CLASS}
                  title="Faint gridlines across the whole plot at every tick, not just the axis tick marks"
                />
              </Field>
              {selectedNodes.length === 1 && (selectedNodes[0].graphPoints?.length ?? 0) > 0 && (
                <Field label="Manual points">
                  <button
                    type="button"
                    onClick={() => updateNodes({ graphPoints: [] })}
                    className="h-7 px-2 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs hover:bg-gray-50 dark:hover:bg-neutral-700"
                    title="Removes every manually-plotted point - the same points double-clicking the plot area (to add) or one of their own handles (to remove) edits directly on the canvas"
                  >
                    Clear ({selectedNodes[0].graphPoints?.length ?? 0})
                  </button>
                </Field>
              )}
            </>
          )}
          {selectedNodes.every((n) => n.shapeType === "image") && selectedNodes.length === 1 && onReplaceImage && (
            <ImageFields
              node={selectedNodes[0]}
              updateNodes={updateNodes}
              onReplace={() => onReplaceImage(selectedNodes[0])}
              cropping={croppingNodeId === selectedNodes[0].id}
              onToggleCrop={onToggleCrop ? () => onToggleCrop(selectedNodes[0]) : undefined}
              previewField={previewField}
            />
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
                  className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800"
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
                  className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
                  className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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

          {selectedNodes.some((n) => n.shapeType !== "freehand" && n.shapeType !== "latticeGauge") && (
            <Section title="Text" dense>
              {/* Font family/Bold/Italic/Underline are meaningless for "equation" - KaTeX typesets
                  with its own math font regardless, so these controls would sit there doing nothing
                  visible if shown. Font size/color and Align DO still apply (see EquationDisplay/
                  paintEquation), so only those stay visible for it. */}
              {selectedNodes.every((n) => n.shapeType !== "equation") && (
                <Field label="Font">
                  <select
                    value={selectedNodes[0].fontFamily}
                    onChange={(e) => updateNodes({ fontFamily: e.target.value })}
                    className="w-28 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                  >
                    {FONT_FAMILY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Font size">
                <input
                  type="number"
                  min={8}
                  max={96}
                  value={selectedNodes[0].fontSize}
                  onChange={(e) => updateNodes({ fontSize: Number(e.target.value) })}
                  className={NUMBER_INPUT_CLASS}
                />
              </Field>
              <Field label="Font color">
                <input type="color" value={selectedNodes[0].fontColor} onChange={(e) => updateNodes({ fontColor: e.target.value })} className={SWATCH_CLASS} />
              </Field>
              {selectedNodes.every((n) => n.shapeType !== "equation") && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-600 dark:text-neutral-300">Style</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => updateNodes({ fontWeight: selectedNodes[0].fontWeight === "bold" ? "normal" : "bold" })}
                      className={`px-2 py-1 rounded font-bold text-xs ${selectedNodes[0].fontWeight === "bold" ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
                    >
                      B
                    </button>
                    <button
                      type="button"
                      onClick={() => updateNodes({ fontStyle: selectedNodes[0].fontStyle === "italic" ? "normal" : "italic" })}
                      className={`p-1.5 rounded ${selectedNodes[0].fontStyle === "italic" ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
                    >
                      <TbItalic size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => updateNodes({ textDecoration: selectedNodes[0].textDecoration === "underline" ? "none" : "underline" })}
                      className={`p-1.5 rounded ${selectedNodes[0].textDecoration === "underline" ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
                    >
                      <TbUnderline size={14} />
                    </button>
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-600 dark:text-neutral-300">Align</span>
                <div className="flex gap-1">
                  {(["left", "center", "right"] as const).map((align) => (
                    <button
                      key={align}
                      type="button"
                      onClick={() => updateNodes({ textAlign: align })}
                      className={`p-1.5 rounded ${selectedNodes[0].textAlign === align ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
                    >
                      {align === "left" ? <TbLayoutAlignLeft size={14} /> : align === "center" ? <TbLayoutAlignCenter size={14} /> : <TbLayoutAlignRight size={14} />}
                    </button>
                  ))}
                  {(["top", "middle", "bottom"] as const).map((align) => (
                    <button
                      key={align}
                      type="button"
                      onClick={() => updateNodes({ verticalAlign: align })}
                      className={`p-1.5 rounded ${selectedNodes[0].verticalAlign === align ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
                    >
                      {align === "top" ? <TbLayoutAlignTop size={14} /> : align === "middle" ? <TbLayoutAlignMiddle size={14} /> : <TbLayoutAlignBottom size={14} />}
                    </button>
                  ))}
                </div>
              </div>
            </Section>
          )}

          <div className="border-t border-gray-100 dark:border-neutral-800 pt-3 flex items-center gap-1">
            <button type="button" onClick={onBringToFront} title="Bring to front" className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-neutral-800">
              <TbStackFront size={16} />
            </button>
            <button type="button" onClick={onSendToBack} title="Send to back" className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-neutral-800">
              <TbStackBack size={16} />
            </button>
            {selectedNodes.length >= 2 && (
              <button type="button" onClick={onGroup} title="Group" className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-neutral-800">
                <TbComponents size={16} />
              </button>
            )}
            {selectedNodes.some((n) => n.groupId) && (
              <button type="button" onClick={onUngroup} title="Ungroup" className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-neutral-800">
                <TbComponentsOff size={16} />
              </button>
            )}
            {selectedNodes.length === 1 && (
              <button type="button" onClick={() => onDuplicateNode(selectedNodes[0])} title="Duplicate" className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-neutral-800">
                <IoCopyOutline size={16} />
              </button>
            )}
            <button
              type="button"
              onClick={() => selectedNodes.forEach((n) => onDeleteNode(n))}
              title="Delete"
              className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-500/10 text-red-600 dark:text-red-400 ml-auto"
            >
              <IoTrashOutline size={16} />
            </button>
          </div>
        </>
      )}

      {edge && (
        <>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-neutral-500">Connector</p>
          <Field label="Nudge">
            <NudgeGrid onNudge={(dx, dy) => updateEdge(nudgeEdgeBy(edge, dx, dy))} />
          </Field>
          {!edge.source.nodeId && !edge.target.nodeId && <EdgeRotateField key={edge.id} edge={edge} onCommit={updateEdge} />}
          <Field label="Color">
            <input type="color" value={edge.strokeColor} onChange={(e) => updateEdge({ strokeColor: e.target.value })} className={SWATCH_CLASS} />
          </Field>
          {/* No live preview here: previewNodes only replaces NODES, and an edge's width isn't part
              of that channel. The thumb still tracks the drag, and the width commits on release. */}
          <SliderField label="Width" resetKey={edge.id} value={edge.strokeWidth} min={0.5} max={40} sliderMax={12} step={0.5} onCommit={(n) => updateEdge({ strokeWidth: n })} />
          <Field label="Line">
            <select
              value={edge.strokeStyle}
              onChange={(e) => updateEdge({ strokeStyle: e.target.value as WhiteboardEdge["strokeStyle"] })}
              className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
            >
              {LINE_STYLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Routing">
            <select
              value={edge.routing}
              onChange={(e) => updateEdge({ routing: e.target.value as WhiteboardEdge["routing"] })}
              className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
            >
              {ROUTING_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
          {edge.routing === "curved" && !(edge.waypoints && edge.waypoints.length > 0) && (
            <Field label="Curve bow">
              <LiveRangeSlider
                min={-1}
                max={1}
                step={0.05}
                value={edge.curveBow ?? DEFAULT_CURVE_BOW}
                onCommit={(n) => updateEdge({ curveBow: n })}
                className={SLIDER_CLASS}
                title="Which way (and how far) a free-floating end of this curve bows - only matters where the curve has no shape side to bow away from"
              />
            </Field>
          )}
          {edge.waypoints && edge.waypoints.length > 0 && (
            <Field label="Bend points">
              <button
                type="button"
                onClick={() => updateEdge({ waypoints: [] })}
                className="h-7 px-2 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs hover:bg-gray-50 dark:hover:bg-neutral-700"
                title="Remove every manually-dragged bend point on this connector, letting the routing style alone decide its path again"
              >
                Clear ({edge.waypoints.length})
              </button>
            </Field>
          )}
          <Field label="Start arrow">
            <select
              value={edge.startArrowType}
              onChange={(e) => updateEdge({ startArrowType: e.target.value as ArrowheadType })}
              className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
            >
              {ARROWHEAD_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="End arrow">
            <select
              value={edge.endArrowType}
              onChange={(e) => updateEdge({ endArrowType: e.target.value as ArrowheadType })}
              className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
            >
              {ARROWHEAD_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
          <input
            type="text"
            value={edge.label}
            placeholder="Label"
            onChange={(e) => updateEdge({ label: e.target.value })}
            className={`w-full ${TEXT_INPUT_CLASS}`}
          />
          <button
            type="button"
            onClick={() => onDeleteEdge(edge)}
            title="Delete"
            className="self-start p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-500/10 text-red-600 dark:text-red-400 transition"
          >
            <IoTrashOutline size={16} />
          </button>
        </>
      )}
      </div>
    </div>
  );
};

export default WhiteboardStylePanel;
