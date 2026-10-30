// components/video/StageGraphPanel.tsx
//
// Editing a graph element: functions typed as maths (an error said plainly the moment it's wrong),
// data pasted from anywhere, things that live on a curve - a point (on a value, with its tangent and
// readout), a shaded area with its integral, a ball rolling downhill by gradient descent - and the
// view. Every edit lands in the beat under the playhead; "change in the next beat" makes the graph
// morph - zoom, pan, a function flowing into the next.
import React, { useMemo, useState } from "react";
import { IoAdd, IoArrowForward, IoEyeOffOutline, IoEyeOutline, IoTrashOutline } from "react-icons/io5";
import { SliderRow, Swatches } from "./OverlayDockedPanels";
import { IconButton, STAGE_INKS, Segmented, Toggle, field } from "./StagePanelParts";
import { GRAPH_COLORS, GraphAmount, GraphMarker, GraphSeries, GraphState, defaultGraph, graphVars, niceTicks, sampleCurve, seriesError } from "../../utils/stage/stageGraph";
import { compileExpr, ExprError } from "../../utils/stage/stageExpr";
import { setElementProps } from "../../utils/stage/stageEditing";
import type { StageElement, StageProps, StageScene } from "../../utils/stage/stageTypes";

type Update = (edit: (s: StageScene) => StageScene) => void;

const PRESETS: { label: string; expr: string }[] = [
  { label: "x²", expr: "x^2" },
  { label: "sin x", expr: "sin(x)" },
  { label: "eˣ", expr: "e^x" },
  { label: "1/x", expr: "1/x" },
  { label: "σ(x)", expr: "sigmoid(x)" },
  { label: "|x|", expr: "abs(x)" },
  { label: "wave", expr: "sin(2x - 2t)" },
];

const newId = () => Math.random().toString(36).slice(2, 8);
// What a point, area or rolling ball can be coloured: the bright yellow first (what reads best on a
// curve), then the graph colours.
const MARKER_COLORS = ["#ffff00", ...GRAPH_COLORS.filter((c) => c !== "#ffff00"), "#ffffff"];

// A field that holds what's typed until Enter or leaving it, then hands it over.
const DraftInput: React.FC<{ value: string; onCommit: (v: string) => void; placeholder?: string; className?: string; mono?: boolean; title?: string }> = ({ value, onCommit, placeholder, className, mono, title }) => {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      title={title}
      value={draft ?? value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(null);
      }}
      className={`${field} ${mono ? "font-mono" : ""} ${className ?? ""}`}
    />
  );
};

const NumberIn: React.FC<{ value: number; onCommit: (v: number) => void; title?: string }> = ({ value, onCommit, title }) => (
  <DraftInput
    title={title}
    value={String(Math.round(value * 1000) / 1000)}
    onCommit={(v) => {
      const n = Number(v.replace(/[−–]/g, "-"));
      if (Number.isFinite(n)) onCommit(n);
    }}
    className="text-center tabular-nums px-1"
  />
);

// A number, or one of the scene's values (so it moves as the value runs).
const AmountIn: React.FC<{ value: GraphAmount | undefined; fallback: number; values: string[]; onCommit: (v: GraphAmount) => void }> = ({ value, fallback, values, onCommit }) => {
  const isValue = typeof value === "object";
  return (
    <div className="flex gap-1 min-w-0">
      {isValue ? (
        <select value={value.value} onChange={(e) => onCommit({ value: e.target.value })} className="flex-1 min-w-0 rounded-md bg-black/30 ring-1 ring-teal-400/40 px-1.5 py-1 text-teal-100 text-[11px] outline-none">
          {values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <NumberIn value={typeof value === "number" ? value : fallback} onCommit={onCommit} />
      )}
      {values.length > 0 && (
        <button
          type="button"
          title={isValue ? "Use a fixed number" : "Follow one of the scene's values - it moves as the value runs"}
          onClick={() => onCommit(isValue ? fallback : { value: values[0] })}
          className={`shrink-0 rounded-md px-1.5 text-[10px] ${isValue ? "bg-teal-500/30 text-teal-50" : "bg-white/[0.06] text-white/60 hover:text-white"}`}
        >
          {isValue ? "value" : "fixed"}
        </button>
      )}
    </div>
  );
};

// Pasted data: "x, y" or "x y" lines, CSV with a header, or a single column (taken as y at 1, 2, 3...).
function parseData(text: string): [number, number][] {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/[,\t; ]+/).map((c) => Number(c.replace(/[−–]/g, "-"))));
  const numeric = rows.filter((r) => r.length > 0 && r.every(Number.isFinite));
  if (numeric.length === 0) return [];
  if (numeric.every((r) => r.length === 1)) return numeric.map((r, i) => [i + 1, r[0]]);
  return numeric.filter((r) => r.length >= 2).map((r) => [r[0], r[1]]);
}

export const GraphEditor: React.FC<{
  scene: StageScene;
  beat: number;
  element: StageElement;
  here: StageProps;
  onUpdate: Update;
  onNextBeat: () => void;
}> = ({ scene, beat, element, here, onUpdate, onNextBeat }) => {
  const g = here.graph ?? defaultGraph();
  const values = useMemo(() => (scene.channels ?? []).map((c) => c.id), [scene.channels]);
  const set = (next: GraphState) => onUpdate((s) => setElementProps(s, beat, element.id, { graph: next }));
  const setSeries = (id: string, patch: Partial<GraphSeries>) => set({ ...g, series: g.series.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const setMarker = (id: string, patch: Partial<GraphMarker>) => set({ ...g, markers: g.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const [pasting, setPasting] = useState<string | null>(null);
  const nextColor = GRAPH_COLORS[g.series.length % GRAPH_COLORS.length];
  const firstCurve = g.series.find((s) => !s.hidden)?.id ?? g.series[0]?.id;
  const laterBeats = scene.beats.length - 1 - beat;

  // The y range fitted to what's drawn across the x range, with room above and below.
  const fitY = () => {
    const vars = graphVars(new Map((scene.channels ?? []).map((c) => [c.id, c])), 0);
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of g.series) {
      if (s.hidden) continue;
      if (s.kind === "data") for (const [, y] of s.points ?? []) (lo = Math.min(lo, y)), (hi = Math.max(hi, y));
      else {
        const p = compileExpr(s.expr ?? "", values);
        if (p instanceof ExprError) continue;
        for (const run of sampleCurve((x) => p.fn({ ...vars, x }), g.view.xMin, g.view.xMax, 400, -1e6, 1e6)) for (const [, y] of run) (lo = Math.min(lo, y)), (hi = Math.max(hi, y));
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    if (hi - lo < 1e-9) (lo -= 1), (hi += 1);
    const pad = (hi - lo) * 0.12;
    // Snapped to a fine step - tidy numbers without wasting the plot on empty space.
    const ticks = niceTicks(lo - pad, hi + pad, 14);
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    set({ ...g, view: { ...g.view, yMin: Math.floor((lo - pad) / step) * step, yMax: Math.ceil((hi + pad) / step) * step } });
  };

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-white/60">Functions</span>
        {g.series.map((s) => {
          const err = seriesError(s, values);
          return (
            <div key={s.id} className="flex flex-col gap-1 rounded-md bg-white/[0.04] p-1.5">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  title="Its colour - click for the next"
                  onClick={() => setSeries(s.id, { color: GRAPH_COLORS[(GRAPH_COLORS.indexOf(s.color) + 1) % GRAPH_COLORS.length] })}
                  className="shrink-0 w-4 h-4 rounded-full ring-1 ring-white/30"
                  style={{ background: s.color }}
                />
                {s.kind === "function" ? (
                  <>
                    <span className="shrink-0 text-[11px] text-white/50 font-serif italic">f(x) =</span>
                    <DraftInput value={s.expr ?? ""} onCommit={(v) => setSeries(s.id, { expr: v })} mono placeholder="e.g. x^2 - 2x" className="flex-1 min-w-0 py-1" />
                  </>
                ) : (
                  <span className="flex-1 text-[11px] text-white/70">Data · {s.points?.length ?? 0} points</span>
                )}
                <IconButton title={s.hidden ? "Show" : "Hide"} onClick={() => setSeries(s.id, { hidden: !s.hidden })}>
                  {s.hidden ? <IoEyeOffOutline size={12} /> : <IoEyeOutline size={12} />}
                </IconButton>
                <IconButton title="Remove" danger onClick={() => set({ ...g, series: g.series.filter((x) => x.id !== s.id), markers: g.markers.filter((m) => m.on !== s.id) })}>
                  <IoTrashOutline size={12} />
                </IconButton>
              </div>
              {err && <span className="text-[10px] text-red-300 pl-6">{err}</span>}
              {s.kind === "data" && (
                <Segmented
                  value={s.style ?? "both"}
                  onChange={(v) => setSeries(s.id, { style: v })}
                  options={[
                    { value: "line", label: "Line" },
                    { value: "points", label: "Points" },
                    { value: "both", label: "Both" },
                  ]}
                />
              )}
              <SliderRow label="Weight" value={s.width} min={1} max={12} step={0.5} format={(v) => `${v}`} onChange={(v) => setSeries(s.id, { width: v })} />
              {s.kind === "function" && <Toggle label="Dashed" value={!!s.dashed} onChange={(v) => setSeries(s.id, { dashed: v })} />}
            </div>
          );
        })}
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              title={`Add f(x) = ${p.expr}`}
              onClick={() => set({ ...g, series: [...g.series, { id: newId(), kind: "function", expr: p.expr, color: nextColor, width: 4 }] })}
              className="rounded-full bg-white/[0.06] hover:bg-teal-500/30 px-2 py-0.5 text-[11px] text-white/80 font-serif"
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button type="button" onClick={() => set({ ...g, series: [...g.series, { id: newId(), kind: "function", expr: "x", color: nextColor, width: 4 }] })} className="flex items-center justify-center gap-1 rounded-md bg-white/[0.06] hover:bg-white/10 py-1.5 text-[11px] text-white/80">
            <IoAdd size={12} /> Function
          </button>
          <button type="button" onClick={() => setPasting(pasting === null ? "" : null)} className={`flex items-center justify-center gap-1 rounded-md py-1.5 text-[11px] ${pasting !== null ? "bg-teal-500/30 text-white" : "bg-white/[0.06] hover:bg-white/10 text-white/80"}`}>
            <IoAdd size={12} /> Data
          </button>
        </div>
        {pasting !== null && (
          <div className="flex flex-col gap-1">
            <textarea
              autoFocus
              rows={4}
              value={pasting}
              onChange={(e) => setPasting(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={"Paste x, y pairs - from a spreadsheet, CSV, or typed:\n1, 3.2\n2, 4.1\n3, 5.9"}
              className={`${field} font-mono resize-y`}
            />
            <button
              type="button"
              disabled={parseData(pasting).length === 0}
              onClick={() => {
                const points = parseData(pasting);
                const xs = points.map((p) => p[0]);
                const ys = points.map((p) => p[1]);
                const view = points.length ? { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(0, ...ys), yMax: Math.max(...ys) * 1.12 } : g.view;
                set({ ...g, view: g.series.length === 0 ? view : g.view, series: [...g.series, { id: newId(), kind: "data", points, color: nextColor, width: 3, style: "both" }] });
                setPasting(null);
              }}
              className="rounded-md bg-teal-500/30 hover:bg-teal-500/45 py-1.5 text-[11px] text-white disabled:opacity-40"
            >
              Add {parseData(pasting).length} points
            </button>
          </div>
        )}
        {values.length > 0 && <span className="text-[10px] text-white/40">Use your values by name - {values.join(", ")} - and t for time: the curve moves as they run.</span>}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-white/60">On the curve</span>
        {g.markers.map((m) => (
          <div key={m.id} className="flex flex-col gap-1.5 rounded-md bg-white/[0.04] p-1.5">
            <div className="flex items-center gap-1.5 text-[11px] text-white/80">
              <button
                type="button"
                title="Its colour - click for the next"
                onClick={() => setMarker(m.id, { color: MARKER_COLORS[(MARKER_COLORS.indexOf(m.color) + 1) % MARKER_COLORS.length] })}
                className="w-3.5 h-3.5 rounded-full shrink-0 ring-1 ring-white/30 hover:scale-110 transition-transform"
                style={{ background: m.color }}
              />
              <span className="font-medium">{m.kind === "point" ? "Point" : m.kind === "area" ? "Area" : "Rolling downhill"}</span>
              <span className="text-white/40">on</span>
              <select value={m.on} onChange={(e) => setMarker(m.id, { on: e.target.value })} className="min-w-0 flex-1 rounded bg-black/30 ring-1 ring-white/10 px-1 py-0.5 text-white text-[11px] outline-none">
                {g.series.map((s, i) => (
                  <option key={s.id} value={s.id}>
                    {s.kind === "function" ? s.expr : `data ${i + 1}`}
                  </option>
                ))}
              </select>
              <IconButton title="Remove" danger onClick={() => set({ ...g, markers: g.markers.filter((x) => x.id !== m.id) })}>
                <IoTrashOutline size={12} />
              </IconButton>
            </div>
            {m.kind === "point" && (
              <>
                <label className="grid grid-cols-[1.2rem_1fr] items-center gap-1.5 text-[11px] text-white/50">
                  <span className="font-serif italic">x</span>
                  <AmountIn value={m.x} fallback={0} values={values} onCommit={(v) => setMarker(m.id, { x: v })} />
                </label>
                <div className="grid grid-cols-3 gap-1">
                  <Toggle label="Tangent" value={!!m.tangent} onChange={(v) => setMarker(m.id, { tangent: v })} />
                  <Toggle label="Drops" value={!!m.drops} onChange={(v) => setMarker(m.id, { drops: v })} />
                  <Toggle label="Readout" value={!!m.readout} onChange={(v) => setMarker(m.id, { readout: v })} />
                </div>
              </>
            )}
            {m.kind === "area" && (
              <>
                <div className="grid grid-cols-[2rem_1fr] items-center gap-x-1.5 gap-y-1 text-[11px] text-white/50">
                  <span>from</span>
                  <AmountIn value={m.from} fallback={g.view.xMin} values={values} onCommit={(v) => setMarker(m.id, { from: v })} />
                  <span>to</span>
                  <AmountIn value={m.to} fallback={g.view.xMax} values={values} onCommit={(v) => setMarker(m.id, { to: v })} />
                </div>
                <Toggle label="Show its area" value={!!m.readout} onChange={(v) => setMarker(m.id, { readout: v })} />
              </>
            )}
            {m.kind === "descent" && (
              <>
                <label className="grid grid-cols-[3.2rem_1fr] items-center gap-1.5 text-[11px] text-white/50">
                  <span>Starts at</span>
                  <NumberIn value={m.x0 ?? 0} onCommit={(v) => setMarker(m.id, { x0: v })} title="Where on x the ball starts" />
                </label>
                <SliderRow label="Step size" value={m.rate ?? 0.3} min={0.01} max={1.5} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => setMarker(m.id, { rate: v })} />
                <SliderRow label="Steps" value={m.steps ?? 12} min={1} max={80} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => setMarker(m.id, { steps: Math.round(v) })} />
                <SliderRow label="Takes" value={m.seconds ?? 4} min={0.5} max={20} step={0.1} format={(v) => `${v.toFixed(1)}s`} onChange={(v) => setMarker(m.id, { seconds: v })} />
                <div className="grid grid-cols-2 gap-1">
                  <Toggle label="Tangent" value={!!m.tangent} onChange={(v) => setMarker(m.id, { tangent: v })} />
                  <Toggle label="Readout" value={!!m.readout} onChange={(v) => setMarker(m.id, { readout: v })} />
                </div>
                <span className="text-[10px] text-white/35">Each step moves against the slope by the step size times it - real gradient descent, settling into whichever valley it starts in.</span>
              </>
            )}
          </div>
        ))}
        <div className="grid grid-cols-3 gap-1">
          {(
            [
              { kind: "point", label: "Point", title: "A point on the curve - fixed, or riding one of your values - with its tangent and readout" },
              { kind: "area", label: "Area", title: "Shade the area under the curve between two x - its integral shown" },
              { kind: "descent", label: "Roll down", title: "A ball rolling downhill by gradient descent - it finds the valley it starts in" },
            ] as const
          ).map((b) => (
            <button
              key={b.kind}
              type="button"
              title={b.title}
              disabled={!firstCurve}
              onClick={() => {
                const span = g.view.xMax - g.view.xMin;
                const base = { id: newId(), on: firstCurve!, color: "#ffff00" };
                const marker: GraphMarker =
                  b.kind === "point"
                    ? { ...base, kind: "point", x: values[0] ? { value: values[0] } : g.view.xMin + span * 0.6, tangent: true, readout: true }
                    : b.kind === "area"
                      ? { ...base, kind: "area", color: g.series.find((x) => x.id === firstCurve)?.color ?? GRAPH_COLORS[0], from: g.view.xMin + span * 0.3, to: g.view.xMin + span * 0.6, readout: true }
                      : { ...base, kind: "descent", x0: g.view.xMin + span * 0.9, rate: 0.2, steps: 16, seconds: 4, tangent: true };
                set({ ...g, markers: [...g.markers, marker] });
              }}
              className="flex items-center justify-center gap-1 rounded-md bg-white/[0.06] hover:bg-white/10 py-1.5 text-[11px] text-white/80 disabled:opacity-35"
            >
              <IoAdd size={12} /> {b.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-white/60">View</span>
        <div className="grid grid-cols-[1rem_1fr_auto_1fr] items-center gap-1 text-[11px] text-white/50">
          <span className="font-serif italic">x</span>
          <NumberIn value={g.view.xMin} onCommit={(v) => v < g.view.xMax && set({ ...g, view: { ...g.view, xMin: v } })} />
          <span>to</span>
          <NumberIn value={g.view.xMax} onCommit={(v) => v > g.view.xMin && set({ ...g, view: { ...g.view, xMax: v } })} />
          <span className="font-serif italic">y</span>
          <NumberIn value={g.view.yMin} onCommit={(v) => v < g.view.yMax && set({ ...g, view: { ...g.view, yMin: v } })} />
          <span>to</span>
          <NumberIn value={g.view.yMax} onCommit={(v) => v > g.view.yMin && set({ ...g, view: { ...g.view, yMax: v } })} />
        </div>
        <button type="button" onClick={fitY} title="Set the y range to fit the curves across this x range" className="rounded-md bg-white/[0.06] hover:bg-white/10 py-1.5 text-[11px] text-white/80">
          Fit y to the curves
        </button>
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-white/50 w-[3.5rem]">Ink</span>
          <Swatches colors={STAGE_INKS} value={here.color} onPick={(c) => c && onUpdate((s) => setElementProps(s, beat, element.id, { color: c }))} custom />
        </div>
        <div className="grid grid-cols-3 gap-1">
          <Toggle label="Axes" value={g.axes} onChange={(v) => set({ ...g, axes: v })} />
          <Toggle label="Grid" value={g.grid} onChange={(v) => set({ ...g, grid: v })} />
          <Toggle label="Ticks" value={g.ticks} onChange={(v) => set({ ...g, ticks: v })} />
        </div>
        <div className="grid grid-cols-[3.5rem_1fr] items-center gap-x-1.5 gap-y-1 text-[11px] text-white/50">
          <span>x label</span>
          <DraftInput value={g.xLabel ?? ""} onCommit={(v) => set({ ...g, xLabel: v || undefined })} mono placeholder="TeX - e.g. w" className="py-1" />
          <span>y label</span>
          <DraftInput value={g.yLabel ?? ""} onCommit={(v) => set({ ...g, yLabel: v || undefined })} mono placeholder="TeX - e.g. C(w)" className="py-1" />
        </div>
      </div>

      <button
        type="button"
        onClick={onNextBeat}
        title="Go to the next beat (adding one if needed): change the function, view or markers there and the graph morphs into it - zooming, panning, curves flowing"
        className="flex items-center justify-center gap-1.5 rounded-md bg-teal-500/20 hover:bg-teal-500/35 px-2 py-2 text-[12px] text-teal-50"
      >
        Change it in {laterBeats > 0 ? `beat ${beat + 2}` : "a new beat"} <IoArrowForward size={13} />
      </button>
    </>
  );
};
