// utils/stage/stageGraph.ts
//
// Graphs in Stage scenes: axes, grid and ticks; functions typed as maths (stageExpr) and data series;
// and things that live on a curve - a point (with its tangent, drop lines and readout), a shaded area
// (with its integral), a ball rolling downhill by gradient descent. A graph's state can differ beat
// to beat; between two states it morphs - the view zooms and pans, a function flows into the next,
// markers glide - from the engine's morph progress, so every frame is a function of time alone and
// the export matches the preview.
//
// Everything is drawn into a 2D canvas at the output's resolution (the renderer uploads it), and only
// when something about it changed - a still graph costs nothing per frame.
import { ExprError, ExprVars, compileExpr, slopeAt } from "./stageExpr";
import { StageChannel, channelMoving, channelValue } from "./stageChannels";
import { MATH_INK, drawMath, loadMath, mathLayout } from "./stageMath";
import type { StageScene } from "./stageTypes";

export interface GraphView {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}
// A number, or one of the scene's values (so it moves as the value runs).
export type GraphAmount = number | { value: string };

export interface GraphSeries {
  id: string;
  kind: "function" | "data";
  // A function of x (and t, and the scene's values).
  expr?: string;
  points?: [number, number][];
  color: string;
  width: number;
  style?: "line" | "points" | "both";
  dashed?: boolean;
  hidden?: boolean;
}

export interface GraphMarker {
  id: string;
  kind: "point" | "area" | "descent";
  // The series it belongs to.
  on: string;
  color: string;
  // point: where along x.
  x?: GraphAmount;
  tangent?: boolean;
  drops?: boolean;
  readout?: boolean;
  // area: between these x.
  from?: GraphAmount;
  to?: GraphAmount;
  // descent: start, step size (learning rate), steps, and how long it takes.
  x0?: number;
  rate?: number;
  steps?: number;
  seconds?: number;
}

export interface GraphState {
  view: GraphView;
  series: GraphSeries[];
  markers: GraphMarker[];
  axes: boolean;
  grid: boolean;
  ticks: boolean;
  // TeX, drawn at the axes' ends.
  xLabel?: string;
  yLabel?: string;
}

export const GRAPH_COLORS = ["#58c4dd", "#fc6255", "#83c167", "#ffff00", "#ff862f", "#9a72ac", "#e07a5f", "#3b82f6"];

export function defaultGraph(): GraphState {
  return {
    view: { xMin: -6, xMax: 6, yMin: -3, yMax: 3 },
    series: [{ id: "f", kind: "function", expr: "sin(x)", color: GRAPH_COLORS[0], width: 4 }],
    markers: [],
    axes: true,
    grid: true,
    ticks: true,
    xLabel: "x",
    yLabel: "y",
  };
}

// ---- Numbers ---------------------------------------------------------------------------------------

// Tick values a person would choose: steps of 1, 2 or 5 times a power of ten, about `count` of them.
export function niceTicks(min: number, max: number, count = 8): number[] {
  if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return [];
  const raw = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

// A tick label: as few digits as tell ticks apart, minus signs typeset properly.
export function tickLabel(v: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v.toFixed(Math.min(decimals, 6)).replace("-", "−");
}

export function resolveAmount(a: GraphAmount | undefined, channels: Map<string, StageChannel>, t: number, fallback = 0): number {
  if (a === undefined) return fallback;
  if (typeof a === "number") return a;
  const c = channels.get(a.value);
  return c ? channelValue(c, t) : fallback;
}

// The variables a graph's expressions see at scene time `t`: t itself and every value.
export function graphVars(channels: Map<string, StageChannel>, t: number): ExprVars {
  const vars: ExprVars = { t };
  for (const [id, c] of channels) vars[id] = channelValue(c, t);
  return vars;
}

type Fn = (x: number) => number;
function seriesFn(s: GraphSeries, names: string[], vars: ExprVars): Fn | null {
  if (s.kind === "data") {
    const pts = [...(s.points ?? [])].sort((a, b) => a[0] - b[0]);
    if (pts.length === 0) return null;
    // Data read between points as straight lines (what's drawn).
    return (x) => {
      if (x <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        if (x <= pts[i][0]) {
          const [x0, y0] = pts[i - 1];
          const [x1, y1] = pts[i];
          return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
        }
      }
      return pts[pts.length - 1][1];
    };
  }
  const p = compileExpr(s.expr ?? "", names);
  if (p instanceof ExprError) return null;
  return (x) => p.fn({ ...vars, x });
}

// The function's error for the panel, if it has one.
export function seriesError(s: GraphSeries, names: string[]): string | null {
  if (s.kind !== "function") return null;
  const p = compileExpr(s.expr ?? "", names);
  return p instanceof ExprError ? p.message : null;
}

// The curve across [xMin, xMax] as polylines, broken where it isn't defined or leaps off the plot
// (tan(x) at its asymptotes, 1/x at 0) - never a false vertical line joining the two sides.
export function sampleCurve(f: Fn, xMin: number, xMax: number, samples: number, yMin: number, yMax: number): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  const span = yMax - yMin;
  let prev: number | null = null;
  for (let i = 0; i <= samples; i++) {
    const x = xMin + ((xMax - xMin) * i) / samples;
    const y = f(x);
    const ok = Number.isFinite(y);
    // A jump of more than a few plot-heights between neighbours is a discontinuity, not a slope.
    if (!ok || (prev !== null && Math.abs(y - prev) > span * 4)) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
    if (ok) run.push([x, y]);
    prev = ok ? y : null;
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

// Gradient descent from x0: each step moves against the slope by `rate` times it - the positions it
// visits (stopping early once it's settled), kept inside [lo, hi].
export function descentPath(f: Fn, x0: number, rate: number, steps: number, lo: number, hi: number): number[] {
  const xs = [x0];
  let x = x0;
  for (let k = 0; k < steps; k++) {
    const g = slopeAt((v) => f(v.x), {}, x);
    if (!Number.isFinite(g)) break;
    const next = Math.min(hi, Math.max(lo, x - rate * g));
    xs.push(next);
    if (Math.abs(next - x) < 1e-6 * Math.max(1, Math.abs(x))) break;
    x = next;
  }
  return xs;
}

// Where a descent's ball is `since` seconds in: step k of the path, eased into each step as a rolling
// ball settles, never overshooting.
export function descentAt(path: number[], since: number, seconds: number): { x: number; step: number; done: boolean } {
  if (path.length < 2) return { x: path[0] ?? 0, step: 0, done: true };
  const per = Math.max(1e-3, seconds) / (path.length - 1);
  const u = Math.max(0, since) / per;
  const k = Math.min(path.length - 1, Math.floor(u));
  if (k >= path.length - 1) return { x: path[path.length - 1], step: path.length - 1, done: true };
  const f = u - k;
  const e = 1 - Math.pow(1 - f, 3);
  return { x: path[k] + (path[k + 1] - path[k]) * e, step: k, done: false };
}

// The integral of f over [a, b] by Simpson's rule - signed, as the shading shows it.
export function integrate(f: Fn, a: number, b: number, n = 400): number {
  if (a === b) return 0;
  const m = n % 2 === 0 ? n : n + 1;
  const h = (b - a) / m;
  let s = f(a) + f(b);
  for (let i = 1; i < m; i++) s += f(a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

// Whether the graph changes at scene time t without its state changing: a curve reading t or a
// running value, a marker on a running value, a descent still rolling.
export function graphMoving(g: GraphState, channels: Map<string, StageChannel>, t: number, since: number): boolean {
  const names = [...channels.keys()];
  const running = (id: string) => {
    const c = channels.get(id);
    return !!c && channelMoving(c, t);
  };
  for (const s of g.series) {
    if (s.kind !== "function" || s.hidden) continue;
    const p = compileExpr(s.expr ?? "", names);
    if (p instanceof ExprError) continue;
    for (const n of p.names) if (n === "t" || running(n)) return true;
  }
  for (const m of g.markers) {
    for (const a of [m.x, m.from, m.to]) if (a && typeof a === "object" && running(a.value)) return true;
    if (m.kind === "descent" && since < (m.seconds ?? 4)) return true;
  }
  return false;
}

// ---- Drawing -------------------------------------------------------------------------------------

// The graph's type size (stage units) for its box, and its axis labels' - rounded, so the label laid
// out ahead of time is the one asked for when drawing.
export const graphFontSize = (w: number, h: number) => Math.round(Math.max(11, Math.min(w, h) * 0.036));
export const graphLabelSize = (fs: number) => Math.round(fs * 1.25);

export interface GraphDraw {
  // Device pixels per stage unit, and the box in stage units.
  scale: number;
  width: number;
  height: number;
  // Axes, grid, ticks and labels.
  ink: string;
  // How much has drawn itself on (0..1): axes first, then curves left to right, then markers.
  draw: number;
  t: number;
  // Seconds the current state has been showing (descents run from then).
  since: number;
  channels: Map<string, StageChannel>;
  // Mid-morph: the state it's coming from and how far along (0..1).
  from?: GraphState;
  progress?: number;
}

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const withAlpha = (css: string, a: number) => {
  const m = /^#([0-9a-f]{6})$/i.exec(css);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const r = /^rgba?\(([^)]+)\)$/i.exec(css);
  if (r) {
    const [cr, cg, cb] = r[1].split(/[\s,/]+/).map(Number);
    return `rgba(${cr}, ${cg}, ${cb}, ${a})`;
  }
  return css;
};

// Draws the graph into `ctx` (already cleared), its box at (ox, oy) device pixels.
export function drawGraph(ctx: CanvasRenderingContext2D, g: GraphState, o: GraphDraw, ox: number, oy: number): void {
  const k = o.scale;
  const p = o.from ? ease(o.progress ?? 1) : 1;
  const view: GraphView = o.from
    ? { xMin: lerp(o.from.view.xMin, g.view.xMin, p), xMax: lerp(o.from.view.xMax, g.view.xMax, p), yMin: lerp(o.from.view.yMin, g.view.yMin, p), yMax: lerp(o.from.view.yMax, g.view.yMax, p) }
    : g.view;
  if (!(view.xMax > view.xMin) || !(view.yMax > view.yMin)) return;
  const W = o.width * k;
  const H = o.height * k;
  // Room for tick labels, scaled with the graph.
  const fsStage = graphFontSize(o.width, o.height);
  const fs = fsStage * k;
  const padL = g.ticks ? fs * 3.2 : fs;
  const padB = g.ticks ? fs * 2.2 : fs;
  const padT = fs * (g.yLabel ? 2.2 : 1);
  const padR = fs * (g.xLabel ? 2.6 : 1);
  const L = ox + padL;
  const T = oy + padT;
  const PW = W - padL - padR;
  const PH = H - padT - padB;
  if (PW <= 4 || PH <= 4) return;
  const X = (x: number) => L + ((x - view.xMin) / (view.xMax - view.xMin)) * PW;
  const Y = (y: number) => T + ((view.yMax - y) / (view.yMax - view.yMin)) * PH;
  const axesIn = ease(o.draw / 0.3);
  const curvesIn = Math.max(0, Math.min(1, (o.draw - 0.2) / 0.7));
  const markersIn = ease((o.draw - 0.85) / 0.15);
  const names = [...o.channels.keys()];
  const vars = graphVars(o.channels, o.t);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const xTicks = niceTicks(view.xMin, view.xMax, Math.max(3, Math.round(PW / (fs * 6))));
  const yTicks = niceTicks(view.yMin, view.yMax, Math.max(3, Math.round(PH / (fs * 4))));
  const xStep = xTicks.length > 1 ? xTicks[1] - xTicks[0] : 1;
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1;
  // Where the axes cross: at zero when it's in view, else along the nearest edge.
  const ax = view.yMin <= 0 && view.yMax >= 0 ? Y(0) : view.yMin > 0 ? T + PH : T;
  const ay = view.xMin <= 0 && view.xMax >= 0 ? X(0) : view.xMin > 0 ? L : L + PW;

  if (g.grid && axesIn > 0) {
    ctx.strokeStyle = withAlpha(o.ink, 0.13 * axesIn);
    ctx.lineWidth = Math.max(1, 1.2 * k);
    ctx.beginPath();
    for (const v of xTicks) {
      const x = Math.round(X(v)) + 0.5;
      ctx.moveTo(x, T);
      ctx.lineTo(x, T + PH);
    }
    for (const v of yTicks) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.moveTo(L, y);
      ctx.lineTo(L + PW, y);
    }
    ctx.stroke();
  }
  if (g.axes && axesIn > 0) {
    ctx.strokeStyle = withAlpha(o.ink, 0.9 * axesIn);
    ctx.fillStyle = withAlpha(o.ink, 0.9 * axesIn);
    ctx.lineWidth = 2.2 * k;
    const head = 9 * k;
    ctx.beginPath();
    ctx.moveTo(L - fs * 0.4, ax);
    ctx.lineTo(L + PW + fs * 0.6, ax);
    ctx.moveTo(ay, T + PH + fs * 0.4);
    ctx.lineTo(ay, T - fs * 0.6);
    ctx.stroke();
    // Arrowheads at the positive ends.
    ctx.beginPath();
    ctx.moveTo(L + PW + fs * 0.6 + head, ax);
    ctx.lineTo(L + PW + fs * 0.6, ax - head * 0.55);
    ctx.lineTo(L + PW + fs * 0.6, ax + head * 0.55);
    ctx.moveTo(ay, T - fs * 0.6 - head);
    ctx.lineTo(ay - head * 0.55, T - fs * 0.6);
    ctx.lineTo(ay + head * 0.55, T - fs * 0.6);
    ctx.fill();
    if (g.ticks) {
      ctx.lineWidth = 1.6 * k;
      ctx.beginPath();
      for (const v of xTicks) {
        const x = X(v);
        ctx.moveTo(x, ax - 5 * k);
        ctx.lineTo(x, ax + 5 * k);
      }
      for (const v of yTicks) {
        const y = Y(v);
        ctx.moveTo(ay - 5 * k, y);
        ctx.lineTo(ay + 5 * k, y);
      }
      ctx.stroke();
      ctx.font = `${fs}px KaTeX_Main, "Times New Roman", serif`;
      ctx.fillStyle = withAlpha(o.ink, 0.78 * axesIn);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const v of xTicks) if (v !== 0 || ay < L || ay > L + PW) ctx.fillText(tickLabel(v, xStep), X(v), Math.min(ax + fs * 0.5, T + PH + fs * 0.5));
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const v of yTicks) if (v !== 0 || ax < T || ax > T + PH) ctx.fillText(tickLabel(v, yStep), Math.max(ay - fs * 0.5, L - fs * 0.5), Y(v));
      // One 0 at the origin.
      if (view.xMin < 0 && view.xMax > 0 && view.yMin < 0 && view.yMax > 0) {
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText("0", ay - fs * 0.35, ax + fs * 0.35);
      }
    }
    // TeX axis labels at the arrow tips.
    const label = (tex: string | undefined, x: number, y: number, alignX: number, alignY: number) => {
      if (!tex) return;
      const l = mathLayout(tex, graphLabelSize(fsStage), MATH_INK);
      if (!l) return;
      drawMath(ctx, l, k, (x - l.width * k * alignX) / k, (y - l.height * k * alignY) / k, o.ink, axesIn);
    };
    label(g.xLabel, L + PW + fs * 0.8 + head, ax, 0, 0.5);
    label(g.yLabel, ay + fs * 0.4, T - fs * 0.8 - head, 0, 1);
  }

  // Curves, clipped to the plot and drawn on from the left.
  ctx.save();
  ctx.beginPath();
  ctx.rect(L, T, PW * curvesIn, PH);
  ctx.clip();
  const samples = Math.min(2400, Math.max(200, Math.round(PW / 1.5)));
  const fnFor = (s: GraphSeries) => seriesFn(s, names, vars);
  const fromSeries = new Map((o.from?.series ?? []).map((s) => [s.id, s]));
  const toIds = new Set(g.series.map((s) => s.id));
  const strokeRuns = (runs: [number, number][][], s: GraphSeries, alpha: number) => {
    ctx.strokeStyle = withAlpha(s.color, alpha);
    ctx.lineWidth = s.width * k;
    ctx.setLineDash(s.dashed ? [s.width * 3 * k, s.width * 2.2 * k] : []);
    ctx.beginPath();
    for (const run of runs) {
      run.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const drawSeries = (s: GraphSeries, f: Fn, alpha: number) => {
    if (s.kind === "data" && s.style !== "line") {
      ctx.fillStyle = withAlpha(s.color, alpha);
      for (const [x, y] of s.points ?? []) {
        ctx.beginPath();
        ctx.arc(X(x), Y(y), Math.max(3, s.width * 1.4) * k, 0, Math.PI * 2);
        ctx.fill();
      }
      if (s.style === "points") return;
    }
    if (s.kind === "data") {
      const pts = [...(s.points ?? [])].sort((a, b) => a[0] - b[0]);
      strokeRuns([pts], s, alpha);
      return;
    }
    strokeRuns(sampleCurve(f, view.xMin, view.xMax, samples, view.yMin, view.yMax), s, alpha);
  };
  for (const s of g.series) {
    if (s.hidden) continue;
    const f = fnFor(s);
    if (!f) continue;
    const prev = fromSeries.get(s.id);
    const pf = prev && !prev.hidden ? fnFor(prev) : null;
    if (o.from && prev && pf && s.kind === "function" && prev.kind === "function") {
      // The function flowing into the next: y blended at every x, colour and width too.
      const blend: GraphSeries = { ...s, color: p < 0.5 ? prev.color : s.color, width: lerp(prev.width, s.width, p) };
      drawSeries(blend, (x) => lerp(pf(x), f(x), p), 1);
    } else drawSeries(s, f, o.from && !prev ? p : 1);
  }
  // Series leaving.
  if (o.from) for (const s of o.from.series) if (!toIds.has(s.id) && !s.hidden) {
    const f = fnFor(s);
    if (f) drawSeries(s, f, 1 - p);
  }
  ctx.restore();

  // Markers.
  if (markersIn > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(L - 2 * k, T - 2 * k, PW + 4 * k, PH + 4 * k);
    ctx.clip();
    const fromMarkers = new Map((o.from?.markers ?? []).map((m) => [m.id, m]));
    for (const m of g.markers) {
      const series = g.series.find((s) => s.id === m.on);
      const f = series && !series.hidden ? fnFor(series) : null;
      if (!f) continue;
      const prev = fromMarkers.get(m.id);
      const alpha = markersIn * (o.from && !prev ? p : 1);
      drawMarker(ctx, m, prev, p, f, view, { X, Y, L, T, PW, PH, k, fs, alpha, ink: o.ink, t: o.t, since: o.since, channels: o.channels });
    }
    ctx.restore();
  }
  ctx.restore();
}

interface MarkerEnv {
  X: (x: number) => number;
  Y: (y: number) => number;
  L: number;
  T: number;
  PW: number;
  PH: number;
  k: number;
  fs: number;
  alpha: number;
  ink: string;
  t: number;
  since: number;
  channels: Map<string, StageChannel>;
}

// Whether a colour is light (a dark chip goes behind its text) or dark (a light one).
function isLight(css: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(css);
  let r = 255, g = 255, b = 255;
  if (m) {
    const n = parseInt(m[1], 16);
    r = (n >> 16) & 255;
    g = (n >> 8) & 255;
    b = n & 255;
  } else {
    const p = /^rgba?\(([^)]+)\)$/i.exec(css);
    if (p) [r, g, b] = p[1].split(/[\s,/]+/).map(Number);
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)).replace("-", "−");

function drawMarker(ctx: CanvasRenderingContext2D, m: GraphMarker, prev: GraphMarker | undefined, p: number, f: Fn, view: GraphView, e: MarkerEnv): void {
  const { X, Y, k, fs, alpha } = e;
  const amount = (a: GraphAmount | undefined, fb: number) => resolveAmount(a, e.channels, e.t, fb);
  const dot = (x: number, y: number, color: string, r = 9) => {
    ctx.fillStyle = withAlpha(color, alpha);
    ctx.strokeStyle = withAlpha("#ffffff", 0.9 * alpha);
    ctx.lineWidth = 2.5 * k;
    ctx.beginPath();
    ctx.arc(X(x), Y(y), r * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  };
  const tangentAt = (x: number, color: string) => {
    const y = f(x);
    const s = slopeAt((v) => f(v.x), {}, x);
    if (!Number.isFinite(s) || !Number.isFinite(y)) return s;
    // A fixed on-screen length, whatever the slope.
    const dxPx = Math.cos(Math.atan2(-s * (e.PH / (view.yMax - view.yMin)), e.PW / (view.xMax - view.xMin))) * e.PW * 0.16;
    const dx = (dxPx / e.PW) * (view.xMax - view.xMin);
    ctx.strokeStyle = withAlpha(color, 0.95 * alpha);
    ctx.lineWidth = 3 * k;
    ctx.beginPath();
    ctx.moveTo(X(x - dx), Y(y - s * dx));
    ctx.lineTo(X(x + dx), Y(y + s * dx));
    ctx.stroke();
    return s;
  };
  // A readout on a soft chip in the ink's opposite, so it reads over curves and shading; kept inside
  // the plot (it flips left near the right edge).
  const readout = (x: number, y: number, lines: string[]) => {
    ctx.font = `${fs * 0.92}px Inter, system-ui, sans-serif`;
    const lh = fs * 1.2;
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + fs * 0.9;
    const h = lines.length * lh + fs * 0.5;
    const right = X(x) + 16 * k + w < e.L + e.PW;
    const bx = right ? X(x) + 16 * k : X(x) - 16 * k - w;
    const by = Math.max(e.T, Math.min(e.T + e.PH - h, Y(y) - 14 * k - h));
    chip(bx, by, w, h);
    ctx.fillStyle = withAlpha(e.ink, 0.95 * alpha);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    lines.forEach((line, i) => ctx.fillText(line, bx + fs * 0.45, by + fs * 0.25 + lh * (i + 0.5)));
  };
  function chip(x: number, y: number, w: number, h: number) {
    const light = isLight(e.ink);
    ctx.fillStyle = light ? `rgba(0, 0, 0, ${0.62 * alpha})` : `rgba(255, 255, 255, ${0.8 * alpha})`;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, fs * 0.35);
    else ctx.rect(x, y, w, h);
    ctx.fill();
  }

  if (m.kind === "point") {
    const x = lerp(prev?.kind === "point" ? amount(prev.x, 0) : amount(m.x, 0), amount(m.x, 0), prev ? p : 1);
    const y = f(x);
    if (!Number.isFinite(y)) return;
    if (m.drops) {
      ctx.strokeStyle = withAlpha(m.color, 0.7 * alpha);
      ctx.lineWidth = 2 * k;
      ctx.setLineDash([6 * k, 6 * k]);
      const y0 = view.yMin <= 0 && view.yMax >= 0 ? 0 : view.yMin;
      const x0 = view.xMin <= 0 && view.xMax >= 0 ? 0 : view.xMin;
      ctx.beginPath();
      ctx.moveTo(X(x), Y(y));
      ctx.lineTo(X(x), Y(y0));
      ctx.moveTo(X(x), Y(y));
      ctx.lineTo(X(x0), Y(y));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const slope = m.tangent ? tangentAt(x, m.color) : slopeAt((v) => f(v.x), {}, x);
    dot(x, y, m.color);
    if (m.readout) readout(x, y, [`x = ${fmt(x)}`, `f(x) = ${fmt(y)}`, ...(m.tangent ? [`slope = ${fmt(slope)}`] : [])]);
  } else if (m.kind === "area") {
    const a = amount(m.from, view.xMin);
    const b = amount(m.to, view.xMax);
    const lo = Math.max(view.xMin, Math.min(a, b));
    const hi = Math.min(view.xMax, Math.max(a, b));
    if (hi <= lo) return;
    const y0 = Math.min(view.yMax, Math.max(view.yMin, 0));
    const n = Math.max(40, Math.round(((hi - lo) / (view.xMax - view.xMin)) * e.PW / 2));
    ctx.fillStyle = withAlpha(m.color, 0.38 * alpha);
    ctx.beginPath();
    ctx.moveTo(X(lo), Y(y0));
    for (let i = 0; i <= n; i++) {
      const x = lo + ((hi - lo) * i) / n;
      const y = f(x);
      ctx.lineTo(X(x), Y(Number.isFinite(y) ? Math.min(view.yMax * 4, Math.max(view.yMin * 4, y)) : y0));
    }
    ctx.lineTo(X(hi), Y(y0));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = withAlpha(m.color, 0.9 * alpha);
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.moveTo(X(lo), Y(y0));
    ctx.lineTo(X(lo), Y(f(lo)));
    ctx.moveTo(X(hi), Y(y0));
    ctx.lineTo(X(hi), Y(f(hi)));
    ctx.stroke();
    if (m.readout) {
      const area = integrate(f, lo, hi);
      const mid = (lo + hi) / 2;
      const text = `area = ${fmt(area)}`;
      ctx.font = `${fs * 0.92}px Inter, system-ui, sans-serif`;
      const w = ctx.measureText(text).width + fs * 0.9;
      const h = fs * 1.5;
      const cx = X(mid);
      const cy = Y((f(mid) + y0) / 2);
      chip(cx - w / 2, cy - h / 2, w, h);
      ctx.fillStyle = withAlpha(e.ink, 0.95 * alpha);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, cx, cy);
    }
  } else if (m.kind === "descent") {
    const path = descentPath(f, m.x0 ?? view.xMin + (view.xMax - view.xMin) * 0.15, m.rate ?? 0.3, m.steps ?? 12, view.xMin, view.xMax);
    const at = descentAt(path, e.since, m.seconds ?? 4);
    // Where it has been: fading footprints.
    for (let i = 0; i <= at.step && i < path.length; i++) {
      const y = f(path[i]);
      if (!Number.isFinite(y)) continue;
      ctx.fillStyle = withAlpha(m.color, (0.25 + (0.35 * i) / Math.max(1, at.step)) * alpha);
      ctx.beginPath();
      ctx.arc(X(path[i]), Y(y), 4 * k, 0, Math.PI * 2);
      ctx.fill();
    }
    const y = f(at.x);
    if (!Number.isFinite(y)) return;
    const slope = m.tangent ? tangentAt(at.x, m.color) : slopeAt((v) => f(v.x), {}, at.x);
    // The step it's about to take: an arrow along the axis, against the slope (3Blue1Brown's).
    if (!at.done && Number.isFinite(slope) && Math.abs(slope) > 1e-6) {
      const dir = -Math.sign(slope);
      const len = Math.min(e.PW * 0.12, Math.abs(slope) * (m.rate ?? 0.3) * (e.PW / (view.xMax - view.xMin)));
      const yAxis = Y(Math.min(view.yMax, Math.max(view.yMin, 0)));
      const x0 = X(at.x);
      ctx.strokeStyle = withAlpha(m.color, 0.95 * alpha);
      ctx.fillStyle = withAlpha(m.color, 0.95 * alpha);
      ctx.lineWidth = 3 * k;
      ctx.beginPath();
      ctx.moveTo(x0, yAxis);
      ctx.lineTo(x0 + dir * len, yAxis);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x0 + dir * (len + 10 * k), yAxis);
      ctx.lineTo(x0 + dir * len, yAxis - 6 * k);
      ctx.lineTo(x0 + dir * len, yAxis + 6 * k);
      ctx.fill();
    }
    dot(at.x, y, m.color, 11);
    if (m.readout) readout(at.x, y, [`step ${at.step}`, `slope = ${fmt(slope)}`]);
  }
}

// ---- Loading -------------------------------------------------------------------------------------

// A graph's faces and TeX labels, ready before it's drawn (stageLive.whenCompiled, stageExport).
export async function loadStageGraphs(scene: StageScene): Promise<void> {
  const graphs = scene.elements.filter((e) => e.kind === "graph");
  if (graphs.length === 0) return;
  const jobs: Promise<unknown>[] = [document.fonts.load("20px KaTeX_Main").catch(() => []), document.fonts.load("20px Inter").catch(() => [])];
  for (const e of graphs) {
    const states = [e.props.graph, ...scene.beats.map((b) => b.changes[e.id]?.graph)].filter((g): g is GraphState => !!g);
    const size = graphLabelSize(graphFontSize(e.props.width, e.props.height));
    for (const g of states) for (const tex of [g.xLabel, g.yLabel]) if (tex) jobs.push(loadMath(tex, size, MATH_INK));
  }
  await Promise.all(jobs);
}
