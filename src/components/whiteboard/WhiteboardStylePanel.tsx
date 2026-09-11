// components/whiteboard/WhiteboardStylePanel.tsx
//
// The Whiteboard feature's property-editing surface for whatever's currently selected - mirrors
// BoardStylePanel.tsx's role for Board, but over WhiteboardNode/WhiteboardEdge instead of
// BoardItem. Node edits apply to every selected node at once via batchEditNodes when more than one
// is selected (so multi-selecting three boxes and picking a fill color is one undo step, not
// three) - single-selection edits still go through editNode so BoardStylePanel's "just the one
// item" case isn't paying for a batch array it doesn't need.
import React from "react";
import { IoCopyOutline, IoTrashOutline } from "react-icons/io5";
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
import {
  ArrowheadType,
  CHART_DATA_SHAPES,
  CHART_LABEL_SHAPES,
  DEFAULT_CHART_DATA,
  DEFAULT_LATTICE_LINK_WIDTH,
  DEFAULT_LATTICE_SITE_RADIUS,
  DEFAULT_LATTICE_SITE_SPACING,
  DEFAULT_LATTICE_SIZE,
  FunctionPlotType,
  LINE_ONLY_SHAPES,
  MAX_LATTICE_LINK_WIDTH,
  MAX_LATTICE_SITE_RADIUS,
  MAX_LATTICE_SITE_SPACING,
  MAX_LATTICE_SIZE,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  MIN_LATTICE_LINK_WIDTH,
  MIN_LATTICE_SITE_RADIUS,
  MIN_LATTICE_SITE_SPACING,
  MIN_LATTICE_SIZE,
  MIN_TABLE_COLS,
  MIN_TABLE_ROWS,
  WhiteboardEdge,
  WhiteboardNode,
  insertTableFraction,
  removeTableFraction,
  resolveTableGrid,
} from "../../utils/whiteboardTypes";
import {
  DEFAULT_AMP_INPUT_LEAD_LENGTH,
  DEFAULT_AMP_OUTPUT_LEAD_LENGTH,
  DEFAULT_ANGLE_DEGREES,
  DEFAULT_ANGLE_RAY_LENGTH,
  DEFAULT_CURVE_BOW,
  DEFAULT_NUMBER_LINE_MAX,
  DEFAULT_PLOT_CYCLES,
  DEFAULT_PLOT_DOMAIN_SCALE,
  DEFAULT_WAVE_CYCLES,
  MAX_AMP_LEAD_LENGTH,
  MAX_ANGLE_DEGREES,
  MAX_ANGLE_RAY_LENGTH,
  MAX_NUMBER_LINE_MAX,
  MAX_PLOT_CYCLES,
  MAX_PLOT_DOMAIN_SCALE,
  MAX_WAVE_CYCLES,
  MIN_AMP_LEAD_LENGTH,
  MIN_ANGLE_DEGREES,
  MIN_ANGLE_RAY_LENGTH,
  MIN_NUMBER_LINE_MAX,
  MIN_PLOT_CYCLES,
  MIN_PLOT_DOMAIN_SCALE,
  MIN_WAVE_CYCLES,
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
  onBatchEditNodes: (before: WhiteboardNode[], after: WhiteboardNode[]) => void;
  onEditEdge: (before: WhiteboardEdge, after: WhiteboardEdge) => void;
  onDeleteNode: (node: WhiteboardNode) => void;
  onDeleteEdge: (edge: WhiteboardEdge) => void;
  onDuplicateNode: (node: WhiteboardNode) => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onGroup: () => void;
  onUngroup: () => void;
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-gray-600 dark:text-neutral-300">
      <span>{label}</span>
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
        <input type="checkbox" checked={node.tableHeaderRow ?? true} onChange={(e) => updateNodes({ tableHeaderRow: e.target.checked })} className="h-3.5 w-3.5" />
      </Field>
    </>
  );
}

const WhiteboardStylePanel: React.FC<WhiteboardStylePanelProps> = ({
  selectedNodes,
  selectedEdges,
  onBatchEditNodes,
  onEditEdge,
  onDeleteNode,
  onDeleteEdge,
  onDuplicateNode,
  onBringToFront,
  onSendToBack,
  onGroup,
  onUngroup,
}) => {
  const updateNodes = (patch: Partial<WhiteboardNode>) => {
    if (selectedNodes.length === 0) return;
    onBatchEditNodes(selectedNodes, selectedNodes.map((n) => ({ ...n, ...patch })));
  };

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
    <div className="absolute top-2 right-2 bottom-2 w-60 bg-white/95 dark:bg-neutral-900/95 border border-gray-200 dark:border-neutral-700 rounded-lg shadow-lg p-3 flex flex-col gap-3 overflow-y-auto text-neutral-800 dark:text-neutral-200">
      {selectedNodes.length > 0 && (
        <>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-neutral-500">
            {selectedNodes.length > 1 ? `${selectedNodes.length} shapes` : "Shape"}
          </p>

          {selectedNodes.length === 1 && (
            <>
              <Field label="X">
                <ClampedNumberField
                  key={selectedNodes[0].id}
                  initialValue={Math.round(selectedNodes[0].x)}
                  min={-100000}
                  max={100000}
                  onCommit={(n) => updateNodes({ x: n })}
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                />
              </Field>
              <Field label="Y">
                <ClampedNumberField
                  key={selectedNodes[0].id}
                  initialValue={Math.round(selectedNodes[0].y)}
                  min={-100000}
                  max={100000}
                  onCommit={(n) => updateNodes({ y: n })}
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                />
              </Field>
            </>
          )}
          <Field label="Nudge">
            {/* 1px per click, 10px with Shift held - same step sizes as the arrow-key shortcut
                (WhiteboardCanvas.tsx's keydown handler) so both controls move a selection by
                identical, predictable amounts. */}
            <div className="grid grid-cols-3 grid-rows-2 gap-0.5">
              <span />
              <button
                type="button"
                onClick={(e) => nudgeSelected(0, e.shiftKey ? -10 : -1)}
                title="Nudge up (↑, Shift for 10px)"
                className="h-6 w-6 flex items-center justify-center rounded border border-gray-200 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-xs leading-none"
              >
                ↑
              </button>
              <span />
              <button
                type="button"
                onClick={(e) => nudgeSelected(e.shiftKey ? -10 : -1, 0)}
                title="Nudge left (←, Shift for 10px)"
                className="h-6 w-6 flex items-center justify-center rounded border border-gray-200 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-xs leading-none"
              >
                ←
              </button>
              <button
                type="button"
                onClick={(e) => nudgeSelected(0, e.shiftKey ? 10 : 1)}
                title="Nudge down (↓, Shift for 10px)"
                className="h-6 w-6 flex items-center justify-center rounded border border-gray-200 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-xs leading-none"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={(e) => nudgeSelected(e.shiftKey ? 10 : 1, 0)}
                title="Nudge right (→, Shift for 10px)"
                className="h-6 w-6 flex items-center justify-center rounded border border-gray-200 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-xs leading-none"
              >
                →
              </button>
            </div>
          </Field>

          {selectedNodes.some((n) => n.shapeType !== "text" && n.shapeType !== "freehand" && !LINE_ONLY_SHAPES.has(n.shapeType)) && (
            <Field label="Fill">
              <input
                type="color"
                value={selectedNodes[0].fillColor ?? "#ffffff"}
                onChange={(e) => updateNodes({ fillColor: e.target.value })}
                className="w-8 h-6 rounded border border-gray-300 dark:border-neutral-600 bg-transparent"
              />
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType !== "latticeGauge") && (
            <>
              <Field label={selectedNodes.every((n) => n.shapeType === "freehand") ? "Ink color" : "Stroke color"}>
                <input type="color" value={selectedNodes[0].strokeColor} onChange={(e) => updateNodes({ strokeColor: e.target.value })} className="w-8 h-6 rounded border border-gray-300 dark:border-neutral-600 bg-transparent" />
              </Field>
              <Field label={selectedNodes.every((n) => n.shapeType === "freehand") ? "Ink width" : "Stroke width"}>
                <input
                  type="range"
                  min={selectedNodes.every((n) => n.shapeType === "freehand") ? 1 : 0}
                  max={12}
                  value={selectedNodes[0].strokeWidth}
                  onChange={(e) => updateNodes({ strokeWidth: Number(e.target.value) })}
                  className="w-28"
                />
              </Field>
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
              className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
          {selectedNodes.every((n) => n.shapeType === "rectangle" || n.shapeType === "equation") && (
            <Field label="Corner radius">
              <input
                type="range"
                min={0}
                max={Math.min(selectedNodes[0].width, selectedNodes[0].height) / 2}
                value={selectedNodes[0].cornerRadius ?? 0}
                onChange={(e) => updateNodes({ cornerRadius: Number(e.target.value) })}
                className="w-28"
              />
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "polygon") && (
            <Field label="Sides">
              <input
                type="number"
                min={3}
                max={12}
                value={selectedNodes[0].sides ?? 5}
                onChange={(e) => updateNodes({ sides: Math.max(3, Math.min(12, Number(e.target.value))) })}
                className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
                className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                />
              </Field>
              <Field label="Spikiness">
                <input
                  type="range"
                  min={0.15}
                  max={0.85}
                  step={0.05}
                  value={selectedNodes[0].starInnerRadiusRatio ?? 0.45}
                  onChange={(e) => updateNodes({ starInnerRadiusRatio: Number(e.target.value) })}
                  className="w-28"
                />
              </Field>
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
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
                    className="w-11 h-7 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                  />
                  <input
                    type="range"
                    min={MIN_ANGLE_RAY_LENGTH}
                    max={MAX_ANGLE_RAY_LENGTH}
                    step={0.05}
                    value={selectedNodes[0].angleRay1Length ?? DEFAULT_ANGLE_RAY_LENGTH}
                    onChange={(e) => updateNodes({ angleRay1Length: Number(e.target.value) })}
                    className="w-16"
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
                    className="w-11 h-7 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                  />
                  <input
                    type="range"
                    min={MIN_ANGLE_RAY_LENGTH}
                    max={MAX_ANGLE_RAY_LENGTH}
                    step={0.05}
                    value={selectedNodes[0].angleRay2Length ?? DEFAULT_ANGLE_RAY_LENGTH}
                    onChange={(e) => updateNodes({ angleRay2Length: Number(e.target.value) })}
                    className="w-16"
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
                className="w-32 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
              />
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "functionPlot") && (
            <Field label="Function">
              <select
                value={selectedNodes[0].plotFunction ?? "sine"}
                onChange={(e) => updateNodes({ plotFunction: e.target.value as FunctionPlotType })}
                className="w-32 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
                  className="w-11 h-7 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                />
                <input
                  type="range"
                  min={MIN_PLOT_DOMAIN_SCALE}
                  max={MAX_PLOT_DOMAIN_SCALE}
                  step={0.25}
                  value={selectedNodes[0].plotDomainScale ?? DEFAULT_PLOT_DOMAIN_SCALE}
                  onChange={(e) => updateNodes({ plotDomainScale: Number(e.target.value) })}
                  className="w-16"
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
                  className="w-11 h-7 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                />
                <input
                  type="range"
                  min={MIN_PLOT_CYCLES}
                  max={MAX_PLOT_CYCLES}
                  value={selectedNodes[0].plotCycles ?? DEFAULT_PLOT_CYCLES}
                  onChange={(e) => updateNodes({ plotCycles: Number(e.target.value) })}
                  className="w-16"
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
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
                className="h-3.5 w-3.5"
              />
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "functionPlot") && (
            <Field label="Show grid">
              <input
                type="checkbox"
                checked={selectedNodes[0].plotShowGrid ?? false}
                onChange={(e) => updateNodes({ plotShowGrid: e.target.checked })}
                className="h-3.5 w-3.5"
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
                  className="w-14 h-7 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                  title="Line spans -this to +this"
                />
                <input
                  type="range"
                  min={MIN_NUMBER_LINE_MAX}
                  max={100}
                  value={Math.min(100, selectedNodes[0].numberLineMax ?? DEFAULT_NUMBER_LINE_MAX)}
                  onChange={(e) => updateNodes({ numberLineMax: Number(e.target.value) })}
                  className="w-16"
                  title="Line spans -this to +this"
                />
              </div>
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "amplifier") && (
            <>
              <Field label="Swap +/-">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].ampInvertingOnTop ?? false}
                  onChange={(e) => updateNodes({ ampInvertingOnTop: e.target.checked })}
                  className="h-3.5 w-3.5"
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
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
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
                  className="w-32 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                >
                  <option value="free">Free explore</option>
                  <option value="plaquette">Plaquette loop U□</option>
                  <option value="gauge">Gauge transformation</option>
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
                    className="w-11 h-7 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                    title="Sites per edge (N) - the lattice is N x N x N"
                  />
                  <input
                    type="range"
                    min={MIN_LATTICE_SIZE}
                    max={MAX_LATTICE_SIZE}
                    step={1}
                    value={selectedNodes[0].latticeSize ?? DEFAULT_LATTICE_SIZE}
                    onChange={(e) => updateNodes({ latticeSize: Number(e.target.value) })}
                    className="w-16"
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
                    className="w-11 h-7 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                    title="3D-world distance between neighboring sites - purely a spread-out/compact look, unrelated to the shape's own on-canvas width/height"
                  />
                  <input
                    type="range"
                    min={MIN_LATTICE_SITE_SPACING}
                    max={MAX_LATTICE_SITE_SPACING}
                    step={0.1}
                    value={selectedNodes[0].latticeSiteSpacing ?? DEFAULT_LATTICE_SITE_SPACING}
                    onChange={(e) => updateNodes({ latticeSiteSpacing: Number(e.target.value) })}
                    className="w-16"
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
                    className="w-11 h-7 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                    title="Quark sphere radius, in world units - independent of site spacing"
                  />
                  <input
                    type="range"
                    min={MIN_LATTICE_SITE_RADIUS}
                    max={MAX_LATTICE_SITE_RADIUS}
                    step={0.01}
                    value={selectedNodes[0].latticeSiteRadius ?? DEFAULT_LATTICE_SITE_RADIUS}
                    onChange={(e) => updateNodes({ latticeSiteRadius: Number(e.target.value) })}
                    className="w-16"
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
                    className="w-11 h-7 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                    title="Gauge-link line weight (radius), in world units"
                  />
                  <input
                    type="range"
                    min={MIN_LATTICE_LINK_WIDTH}
                    max={MAX_LATTICE_LINK_WIDTH}
                    step={0.005}
                    value={selectedNodes[0].latticeLinkWidth ?? DEFAULT_LATTICE_LINK_WIDTH}
                    onChange={(e) => updateNodes({ latticeLinkWidth: Number(e.target.value) })}
                    className="w-16"
                  />
                </div>
              </Field>
              <Field label="Show quarks">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].latticeShowQuarks ?? true}
                  onChange={(e) => updateNodes({ latticeShowQuarks: e.target.checked })}
                  className="h-3.5 w-3.5"
                  title="Matter-field spheres on each site"
                />
              </Field>
              <Field label="Show gluons">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].latticeShowGluons ?? true}
                  onChange={(e) => updateNodes({ latticeShowGluons: e.target.checked })}
                  className="h-3.5 w-3.5"
                  title="Gauge-link lines between neighboring sites"
                />
              </Field>
              <Field label="Animate flux">
                <input
                  type="checkbox"
                  checked={selectedNodes[0].latticeAnimateFlux ?? true}
                  onChange={(e) => updateNodes({ latticeAnimateFlux: e.target.checked })}
                  className="h-3.5 w-3.5"
                  title="A traveling brightness pulse along every gauge link"
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

          {selectedNodes.some((n) => n.shapeType !== "freehand" && n.shapeType !== "latticeGauge") && (
            <div className="border-t border-gray-100 dark:border-neutral-700/70 pt-2 flex flex-col gap-2">
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
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                />
              </Field>
              <Field label="Font color">
                <input type="color" value={selectedNodes[0].fontColor} onChange={(e) => updateNodes({ fontColor: e.target.value })} className="w-8 h-6 rounded border border-gray-300 dark:border-neutral-600 bg-transparent" />
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
            </div>
          )}

          <div className="border-t border-gray-100 dark:border-neutral-700/70 pt-2 flex items-center gap-2">
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
          <Field label="Color">
            <input type="color" value={edge.strokeColor} onChange={(e) => updateEdge({ strokeColor: e.target.value })} className="w-8 h-6 rounded border border-gray-300 dark:border-neutral-600 bg-transparent" />
          </Field>
          <Field label="Width">
            <input type="range" min={1} max={8} value={edge.strokeWidth} onChange={(e) => updateEdge({ strokeWidth: Number(e.target.value) })} className="w-28" />
          </Field>
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
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={edge.curveBow ?? DEFAULT_CURVE_BOW}
                onChange={(e) => updateEdge({ curveBow: Number(e.target.value) })}
                className="w-28"
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
            className="w-full h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
          />
          <button
            type="button"
            onClick={() => onDeleteEdge(edge)}
            title="Delete"
            className="self-start p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-500/10 text-red-600 dark:text-red-400"
          >
            <IoTrashOutline size={16} />
          </button>
        </>
      )}
    </div>
  );
};

export default WhiteboardStylePanel;
