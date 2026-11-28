// Scientific, chart, plot-axes, lattice, and table inspector controls extracted from WhiteboardStylePanel.tsx.
import React from "react";
import { IoCloseOutline } from "react-icons/io5";
import { TbMovie, TbPlayerPause } from "react-icons/tb";
import { ColormapName, colormapPalette } from "../../utils/colormaps";
import {
  type AxisPlacement,
  type ChartAnnotation,
  DEFAULT_LATTICE_LABEL_BODY,
  DEFAULT_LATTICE_LABEL_TITLE,
  DEFAULT_LATTICE_ROTATE_SPEED,
  DEFAULT_LATTICE_SIZE,
  insertTableFraction,
  MAX_LATTICE_ROTATE_SPEED,
  MAX_SERIES_COUNT,
  MAX_SERIES_POINTS,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  MIN_TABLE_COLS,
  MIN_TABLE_ROWS,
  removeTableFraction,
  resolveSeriesData,
  resolveTableGrid,
  type TableBorderStyle,
  type WhiteboardNode,
  withRangeBorderSide,
  withRangeFill,
} from "../../utils/whiteboardTypes";
import {
  alignNodes,
  type AlignEdge,
  annotationCoordinateMapper,
  arrangeNodesInGrid,
  DEFAULT_GRID_GAP,
  distributeNodes,
  outlineOptionsFor,
  resolvePlotAxisStyle,
} from "../../handlers/whiteboardHandlers";
import { exportLatticeLoop } from "../../handlers/latticeLoopExport";
import ColorInput from "../common/ColorInput";
import {
  Card,
  CHECKBOX_CLASS,
  ClampedNumberField,
  ColorField,
  Field,
  FIELD_INPUT_CLASS,
  FOOTER_BUTTON_CLASS,
  INPUT_SURFACE_CLASS,
  MINI_BUTTON_CLASS,
  NUMBER_INPUT_CLASS,
  SegmentButton,
  Segmented,
  SliderField,
  SWATCH_CLASS,
} from "./WhiteboardStylePrimitives";

export function ChartTitleFields({ node, updateNodes }: { node: WhiteboardNode; updateNodes: (patch: Partial<WhiteboardNode>) => void }) {
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
export function SeriesDataField({ node, updateNodes }: { node: WhiteboardNode; updateNodes: (patch: Partial<WhiteboardNode>) => void }) {
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
      <div className="flex items-center justify-between text-[12px] text-neutral-500 dark:text-neutral-400">
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
        className={`w-full px-2 py-1.5 ${INPUT_SURFACE_CLASS} text-[11px] font-mono resize-y`}
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

export function SeriesColorList({ node, updateNodes }: { node: WhiteboardNode; updateNodes: (patch: Partial<WhiteboardNode>) => void }) {
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
          <ColorInput
            value={resolved.colors[i]}
            onChange={(e) => setColor(i, e.target.value)}
            className="h-6 w-8 rounded-md cursor-pointer bg-transparent"
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
            className={`flex-1 min-w-0 h-6 px-1.5 ${INPUT_SURFACE_CLASS} text-[11px]`}
          />
          <button
            type="button"
            onClick={() => setColor(i, null)}
            disabled={!node.seriesColors?.[i]}
            className="px-1.5 h-6 rounded-md text-[10px] bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] disabled:opacity-30"
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
export function ColormapSwatch({ name, reversed }: { name: ColormapName; reversed: boolean }) {
  const stops = colormapPalette(name, 24, reversed);
  return (
    <div className="flex h-3 w-full overflow-hidden rounded ring-1 ring-inset ring-black/10 dark:ring-white/10">
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
export function AnnotationFields({ node, updateNodes }: { node: WhiteboardNode; updateNodes: (patch: Partial<WhiteboardNode>) => void }) {
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
      <div className="flex items-center justify-between text-[12px] text-neutral-500 dark:text-neutral-400">
        <span>Annotations</span>
        <button type="button" onClick={add} className={MINI_BUTTON_CLASS}>
          + Add
        </button>
      </div>
      {annotations.length === 0 && <span className="text-[10px] text-gray-400 dark:text-neutral-500">None. Add one, then drag its ring on the canvas to place it.</span>}
      {annotations.map((a, i) => (
        <div key={i} className="flex flex-col gap-1 rounded-lg bg-black/[0.025] dark:bg-white/[0.04] ring-1 ring-inset ring-black/[0.05] dark:ring-white/[0.06] p-2">
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={a.text ?? ""}
              placeholder="(marker only)"
              onChange={(e) => update(i, { text: e.target.value })}
              className={`flex-1 min-w-0 h-6 px-1.5 ${INPUT_SURFACE_CLASS} text-[11px]`}
            />
            <button
              type="button"
              onClick={() => updateNodes({ chartAnnotations: annotations.filter((_, j) => j !== i) })}
              className="px-1.5 h-6 rounded-md text-[10px] bg-black/[0.04] dark:bg-white/[0.06] hover:bg-red-500/10 text-red-600 dark:text-red-400"
              title="Remove this annotation"
            >
              ✕
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={a.marker ?? "dot"}
              onChange={(e) => update(i, { marker: e.target.value as NonNullable<ChartAnnotation["marker"]> })}
              className={`h-6 px-1.5 ${INPUT_SURFACE_CLASS} text-[11px]`}
            >
              <option value="dot">Dot</option>
              <option value="ring">Ring</option>
              <option value="square">Square</option>
              <option value="cross">Cross</option>
              <option value="none">No marker</option>
            </select>
            <ColorInput
              value={a.color ?? node.strokeColor}
              onChange={(e) => update(i, { color: e.target.value })}
              className="h-6 w-8 rounded-md cursor-pointer bg-transparent"
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
export function FigureLayoutFields({
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
          <button key={b.edge} type="button" onClick={() => apply(alignNodes(nodes, b.edge))} className="h-7 rounded-md bg-black/[0.04] dark:bg-white/[0.06] text-[12px] hover:bg-black/[0.08] dark:hover:bg-white/[0.1] active:scale-95 transition" title={b.title}>
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

// ---- Plot axes ----------------------------------------------------------------------------------

// Each axis layout drawn as a tiny plot of itself - the picker reads at a glance as "math class",
// "journal figure", "framed" and "bare" without needing those words.
function AxisPlacementGlyph({ placement }: { placement: AxisPlacement }) {
  return (
    <svg width={18} height={14} viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeLinecap="round">
      <path d="M2.5,11 C6,2 9,2 15.5,4" strokeWidth={1.4} opacity={0.55} />
      {placement === "origin" && <path d="M1,7.5 H17 M9,1 V13" strokeWidth={1.2} />}
      {placement === "edge" && <path d="M2,1 V12.5 H17" strokeWidth={1.2} />}
      {placement === "box" && <rect x={2} y={1} width={15} height={11.5} rx={0.5} strokeWidth={1.2} />}
      {placement === "none" && <path d="M2,12.5 H3 M6,12.5 H7 M10,12.5 H11 M14,12.5 H15" strokeWidth={1.2} opacity={0.6} />}
    </svg>
  );
}

const AXIS_PLACEMENT_OPTIONS: { value: AxisPlacement; title: string }[] = [
  { value: "origin", title: "Axes through the origin" },
  { value: "edge", title: "Axes along the left and bottom edges (journal style)" },
  { value: "box", title: "Framed plot" },
  { value: "none", title: "No axis lines" },
];

// Axis placement, where the numbers sit, tick marks, axis color and the gridlines - for "graph" and
// "functionPlot", which share one axis renderer (whiteboardHandlers.ts's plotAxisDecorations).
export function PlotAxesFields({
  nodes,
  updateNodes,
  onPreviewNodes,
}: {
  nodes: WhiteboardNode[];
  updateNodes: (patch: Partial<WhiteboardNode>) => void;
  onPreviewNodes?: (patch: Partial<WhiteboardNode> | null) => void;
}) {
  const node = nodes[0];
  const ids = nodes.map((n) => n.id).join(",");
  const style = resolvePlotAxisStyle(outlineOptionsFor(node));
  const isGraph = node.shapeType === "graph";
  const showGrid = isGraph ? node.graphShowGrid ?? true : node.plotShowGrid ?? false;
  const xSide = node.xLabelSide ?? "auto";
  const ySide = node.yLabelSide ?? "auto";
  return (
    <>
      <Segmented stretch>
        {AXIS_PLACEMENT_OPTIONS.map((opt) => (
          <SegmentButton
            key={opt.value}
            active={style.placement === opt.value}
            // Switching layout resets the label sides and ticks to that layout's own defaults - a
            // "top" label row chosen for a framed plot rarely makes sense once axes cross the origin.
            onClick={() => updateNodes({ axisPlacement: opt.value === "origin" ? undefined : opt.value, xLabelSide: undefined, yLabelSide: undefined, tickMarks: undefined, axisColor: undefined })}
            title={opt.title}
          >
            <AxisPlacementGlyph placement={opt.value} />
          </SegmentButton>
        ))}
      </Segmented>
      <Field label="X numbers">
        <Segmented>
          {(["auto", "bottom", "top"] as const).map((side) => (
            <SegmentButton key={side} active={xSide === side} onClick={() => updateNodes({ xLabelSide: side === "auto" ? undefined : side })} title={side === "auto" ? "Follow the axis line" : `Pinned to the ${side} edge`}>
              {side === "auto" ? "Axis" : side === "bottom" ? "Bottom" : "Top"}
            </SegmentButton>
          ))}
        </Segmented>
      </Field>
      <Field label="Y numbers">
        <Segmented>
          {(["auto", "left", "right"] as const).map((side) => (
            <SegmentButton key={side} active={ySide === side} onClick={() => updateNodes({ yLabelSide: side === "auto" ? undefined : side })} title={side === "auto" ? "Follow the axis line" : `Pinned to the ${side} edge`}>
              {side === "auto" ? "Axis" : side === "left" ? "Left" : "Right"}
            </SegmentButton>
          ))}
        </Segmented>
      </Field>
      <Field label="Tick marks">
        <Segmented>
          {(["none", "outside", "inside"] as const).map((t) => (
            <SegmentButton key={t} active={style.tickMarks === t} onClick={() => updateNodes({ tickMarks: t })} title={t === "none" ? "No tick marks" : `Ticks point ${t === "outside" ? "away from" : "into"} the plot`}>
              {t === "none" ? "None" : t === "outside" ? "Out" : "In"}
            </SegmentButton>
          ))}
        </Segmented>
      </Field>
      {style.placement !== "none" && <ColorField label="Axis color" value={style.axisColor} onChange={(axisColor) => updateNodes({ axisColor })} />}
      <Field label="Gridlines">
        <input
          type="checkbox"
          checked={showGrid}
          onChange={(e) => updateNodes(isGraph ? { graphShowGrid: e.target.checked } : { plotShowGrid: e.target.checked })}
          className={CHECKBOX_CLASS}
          title="Gridlines across the whole plot at every tick"
        />
      </Field>
      {showGrid && (
        <>
          <ColorField label="Grid color" value={style.gridColor} onChange={(gridColor) => updateNodes({ gridColor })} />
          <SliderField
            label="Grid opacity"
            resetKey={`go-${ids}`}
            value={Math.round(style.gridOpacity * 100)}
            min={0}
            max={100}
            onCommit={(n) => updateNodes({ gridOpacity: n >= 100 ? undefined : n / 100 })}
            onPreview={(n) => onPreviewNodes?.(n === null ? null : { gridOpacity: n / 100 })}
          />
        </>
      )}
    </>
  );
}

// ---- Lattice label / motion / loop export -------------------------------------------------------

// The caption card's on/off, heading and body - editable because the same lattice teaches crystal
// structures, spin models and unit cells as often as gauge theory (see WhiteboardNode.latticeShowLabel).
export function LatticeLabelFields({ node, updateNodes }: { node: WhiteboardNode; updateNodes: (patch: Partial<WhiteboardNode>) => void }) {
  const show = node.latticeShowLabel ?? true;
  const edited = node.latticeLabelTitle !== undefined || node.latticeLabelBody !== undefined;
  return (
    <>
      <Field label="Show label">
        <input type="checkbox" checked={show} onChange={(e) => updateNodes({ latticeShowLabel: e.target.checked })} className={CHECKBOX_CLASS} />
      </Field>
      {show && (
        <>
          <input
            type="text"
            value={node.latticeLabelTitle ?? DEFAULT_LATTICE_LABEL_TITLE}
            placeholder="Heading"
            onChange={(e) => updateNodes({ latticeLabelTitle: e.target.value })}
            className={`w-full h-7 px-2 ${INPUT_SURFACE_CLASS} text-[12px] font-mono font-semibold text-teal-700 dark:text-teal-400`}
            title="Heading line of the caption"
          />
          <textarea
            value={node.latticeLabelBody ?? DEFAULT_LATTICE_LABEL_BODY}
            placeholder="Body text - explain the concept on display"
            onChange={(e) => updateNodes({ latticeLabelBody: e.target.value })}
            rows={3}
            className={`w-full px-2 py-1.5 ${INPUT_SURFACE_CLASS} text-[11px] font-mono leading-relaxed resize-y`}
            title="Body text of the caption - new lines are kept"
          />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-[12px] text-neutral-500 dark:text-neutral-400 cursor-pointer">
              <input type="checkbox" checked={node.latticeLabelShowStats ?? true} onChange={(e) => updateNodes({ latticeLabelShowStats: e.target.checked })} className={CHECKBOX_CLASS} />
              Size &amp; site count
            </label>
            {edited && (
              <button type="button" className={MINI_BUTTON_CLASS} onClick={() => updateNodes({ latticeLabelTitle: undefined, latticeLabelBody: undefined })} title="Back to the original heading and hint">
                Reset text
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

const AUTO_ROTATE_OPTIONS: { value: NonNullable<WhiteboardNode["latticeAutoRotate"]>; label: string; title: string }[] = [
  { value: "off", label: "Off", title: "No auto-rotation" },
  { value: "x", label: "X", title: "Rotate about the X axis" },
  { value: "y", label: "Y", title: "Rotate about the Y axis" },
  { value: "z", label: "Z", title: "Rotate about the Z axis" },
  { value: "tumble", label: "XYZ", title: "Tumble about all three axes at once" },
];

// Auto-rotation plus "export the loop as a video/GIF". The export renders frames offline (see
// latticeLoopExport.ts), so the loop length here is independent of the live speed: whatever length
// is picked, the clip holds exactly one full cycle and loops seamlessly.
export function LatticeMotionFields({
  node,
  updateNodes,
  onSaveExport,
}: {
  node: WhiteboardNode;
  updateNodes: (patch: Partial<WhiteboardNode>) => void;
  onSaveExport?: (bytes: Uint8Array, extension: "mp4" | "gif") => Promise<boolean>;
}) {
  const mode = node.latticeAutoRotate ?? "off";
  const speed = node.latticeRotateSpeed ?? DEFAULT_LATTICE_ROTATE_SPEED;
  const naturalSeconds = Math.round((360 * (mode === "tumble" ? 2 : 1)) / Math.max(1, Math.abs(speed)));
  const [format, setFormat] = React.useState<"mp4" | "gif">("mp4");
  const [seconds, setSeconds] = React.useState<number | null>(null);
  const [size, setSize] = React.useState<number | null>(null);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [message, setMessage] = React.useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const loopSeconds = Math.max(1, Math.min(60, seconds ?? Math.min(30, Math.max(3, naturalSeconds))));
  const longSide = size ?? (format === "gif" ? 480 : 1080);

  const runExport = async () => {
    if (!onSaveExport) return;
    const aspect = node.height / node.width;
    const width = aspect <= 1 ? longSide : Math.round(longSide / aspect);
    const height = aspect <= 1 ? Math.round(longSide * aspect) : longSide;
    const showLabel = node.latticeShowLabel ?? true;
    const n = node.latticeSize ?? DEFAULT_LATTICE_SIZE;
    const stats = (node.latticeLabelShowStats ?? true) ? `${n}×${n}×${n} · ${n * n * n} sites` : "";
    const title = [node.latticeLabelTitle ?? DEFAULT_LATTICE_LABEL_TITLE, stats].filter(Boolean).join(" · ");
    const controller = new AbortController();
    abortRef.current = controller;
    setMessage(null);
    setProgress(0);
    try {
      const bytes = await exportLatticeLoop(
        node.id,
        {
          format,
          seconds: loopSeconds,
          width,
          height,
          fps: format === "gif" ? 20 : 30,
          background: "#ffffff",
          caption: showLabel ? { title, body: node.latticeLabelBody ?? DEFAULT_LATTICE_LABEL_BODY } : null,
        },
        setProgress,
        controller.signal
      );
      setProgress(null);
      const saved = await onSaveExport(bytes, format);
      if (saved) setMessage({ kind: "ok", text: `Saved ${format.toUpperCase()} · ${(bytes.length / 1048576).toFixed(1)} MB` });
    } catch (err) {
      setProgress(null);
      if ((err as Error)?.name !== "AbortError") setMessage({ kind: "error", text: err instanceof Error ? err.message : "Export failed" });
    } finally {
      abortRef.current = null;
    }
  };

  return (
    <>
      <Segmented stretch>
        {AUTO_ROTATE_OPTIONS.map((opt) => (
          <SegmentButton key={opt.value} active={mode === opt.value} onClick={() => updateNodes({ latticeAutoRotate: opt.value === "off" ? undefined : opt.value })} title={opt.title}>
            {opt.value === "off" ? <TbPlayerPause size={13} /> : opt.label}
          </SegmentButton>
        ))}
      </Segmented>
      {mode !== "off" && (
        <SliderField
          label="Speed (°/s)"
          resetKey={`rs-${node.id}`}
          value={speed}
          min={-MAX_LATTICE_ROTATE_SPEED}
          max={MAX_LATTICE_ROTATE_SPEED}
          step={1}
          integer
          onCommit={(n) => updateNodes({ latticeRotateSpeed: n })}
          title="Degrees per second - negative spins the other way. Dragging the lattice pauses rotation while you hold it."
        />
      )}

      <Card>
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-neutral-700 dark:text-neutral-200">Export loop</span>
          <Segmented>
            {(["mp4", "gif"] as const).map((f) => (
              <SegmentButton
                key={f}
                active={format === f}
                onClick={() => {
                  setFormat(f);
                  setSize(null);
                }}
                title={f === "mp4" ? "H.264 video - small file, full color" : "Animated GIF - plays anywhere, loops forever"}
              >
                {f.toUpperCase()}
              </SegmentButton>
            ))}
          </Segmented>
        </div>
        <Field label="Loop length (s)">
          <ClampedNumberField key={`ls-${node.id}-${naturalSeconds}`} initialValue={loopSeconds} min={1} max={60} onCommit={(n) => setSeconds(n)} className={NUMBER_INPUT_CLASS} title="One full rotation fills the clip exactly, so it loops without a jump" />
        </Field>
        <Field label="Size">
          <Segmented>
            {(format === "gif" ? [320, 480, 720] : [720, 1080, 1440]).map((s) => (
              <SegmentButton key={s} active={longSide === s} onClick={() => setSize(s)} title={`${s}px on the long side`}>
                {s}
              </SegmentButton>
            ))}
          </Segmented>
        </Field>
        {progress !== null ? (
          <div className="flex items-center gap-2 h-7">
            <div className="relative flex-1 h-1.5 rounded-full bg-black/[0.07] dark:bg-white/10 overflow-hidden">
              <div className="absolute inset-y-0 left-0 rounded-full bg-blue-500 transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span className="w-8 text-right text-[11px] tabular-nums text-neutral-500">{Math.round(progress * 100)}%</span>
            <button type="button" className={FOOTER_BUTTON_CLASS} title="Cancel export" onClick={() => abortRef.current?.abort()}>
              <IoCloseOutline size={15} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={!onSaveExport}
            onClick={() => void runExport()}
            className="h-8 w-full flex items-center justify-center gap-1.5 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[12px] font-medium hover:opacity-90 active:scale-[0.98] transition disabled:opacity-40"
          >
            <TbMovie size={14} />
            Export {format.toUpperCase()}…
          </button>
        )}
        {message && <span className={`text-[11px] ${message.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{message.text}</span>}
      </Card>
    </>
  );
}

// Rows/Columns steppers + header-row toggle for a single selected "table" node - see this block's
// own call site (in the main component below) for why row/column count can't go through the
// generic multi-node `updateNodes` the way every other field in this panel does. Always
// adds/removes at the END (the last row/column) - inserting/deleting at an arbitrary position is a
// WhiteboardTable.tsx affordance instead (hover a specific row/column while it's selected).
export function TableStructureFields({ node, updateNodes }: { node: WhiteboardNode; updateNodes: (patch: Partial<WhiteboardNode>) => void }) {
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
  const stepperButtonClass = "h-6 w-6 flex items-center justify-center rounded-md bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.1] text-xs leading-none disabled:opacity-30 disabled:pointer-events-none transition";
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
export function TableCellFields({
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
        className={`w-28 h-7 pl-2 pr-1 ${INPUT_SURFACE_CLASS} text-[12px] cursor-pointer`}
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
          <ColorInput
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

