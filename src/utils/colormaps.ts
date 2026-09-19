// utils/colormaps.ts
//
// Perceptually-ordered color scales for mapping a scalar 0-1 to a color - the "color by series
// index" machinery behind the whiteboard's multi-series/waterfall plots (see whiteboardTypes.ts's
// WhiteboardNode.seriesColormap), and available anywhere else a run of related shapes needs to be
// colored as a progression rather than individually picked.
//
// Each map is stored as a short list of RGB anchor stops sampled off the real colormap's own
// definition, linearly interpolated between at lookup time - not the full 256-entry lookup tables
// matplotlib ships. That's a deliberate tradeoff: a 10-16 stop piecewise-linear approximation is
// visually indistinguishable from the real thing at the handful-of-traces-per-plot scale this is
// used at (the stops themselves are exact; only the blend between neighbors is approximated), while
// keeping this file small enough to read and diff. It is NOT accurate enough to publish as a
// quantitative color scale where exact luminance steps matter - anything reproducing a specific
// figure's colorbar values should sample the real table.
//
// viridis/plasma/inferno/magma/cividis are the perceptually-uniform, colorblind-safe family (safe
// defaults for encoding an ordered quantity); turbo/jet/spectral trade that uniformity for a wider,
// higher-contrast range (good for picking individual traces out of a dense stack, which is exactly
// what a waterfall plot needs); coolwarm is diverging (a signed quantity around a zero midpoint);
// grayscale is the print/mono fallback.

export type ColormapName =
  | "viridis"
  | "plasma"
  | "inferno"
  | "magma"
  | "cividis"
  | "turbo"
  | "spectral"
  | "jet"
  | "coolwarm"
  | "grayscale";

// Anchor stops, evenly spaced across 0-1 (index i sits at i/(n-1)) - every map below is defined at
// even spacing so the lookup can find the bracketing pair by plain arithmetic rather than a search.
const COLORMAP_STOPS: Record<ColormapName, string[]> = {
  viridis: ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"],
  plasma: ["#0d0887", "#46039f", "#7201a8", "#9c179e", "#bd3786", "#d8576b", "#ed7953", "#fb9f3a", "#fdca26", "#f0f921"],
  inferno: ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#f7d13d", "#fcffa4"],
  magma: ["#000004", "#180f3d", "#440f76", "#721f81", "#9e2f7f", "#cd4071", "#f1605d", "#fd9668", "#feca8d", "#fcfdbf"],
  cividis: ["#00224e", "#123570", "#3b496c", "#575d6d", "#707173", "#8a8678", "#a59c74", "#c3b369", "#e1cc55", "#fee838"],
  turbo: ["#30123b", "#4145ab", "#4675ed", "#39a2fc", "#1bcfd4", "#24eca6", "#61fc6c", "#a4fc3b", "#d1e834", "#f3c63a", "#fe9b2d", "#f36315", "#d93806", "#b11901", "#7a0402"],
  spectral: ["#9e0142", "#d53e4f", "#f46d43", "#fdae61", "#fee08b", "#ffffbf", "#e6f598", "#abdda4", "#66c2a5", "#3288bd", "#5e4fa2"],
  jet: ["#00007f", "#0000ff", "#007fff", "#00ffff", "#7fff7f", "#ffff00", "#ff7f00", "#ff0000", "#7f0000"],
  coolwarm: ["#3b4cc0", "#6788ee", "#9abbff", "#c9d7f0", "#edd1c2", "#f7a789", "#e26952", "#b40426"],
  grayscale: ["#111111", "#ffffff"],
};

export const COLORMAP_NAMES = Object.keys(COLORMAP_STOPS) as ColormapName[];

export const DEFAULT_COLORMAP: ColormapName = "spectral";

// Anchors pre-parsed to RGB triplets once at module load rather than re-parsing the hex string on
// every lookup - sampleColormap is called once per series per outline rebuild, which for a 60-trace
// waterfall being dragged is a few thousand calls a second.
const PARSED_STOPS: Record<ColormapName, [number, number, number][]> = Object.fromEntries(
  COLORMAP_NAMES.map((name) => [
    name,
    COLORMAP_STOPS[name].map((hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as [number, number, number]),
  ])
) as Record<ColormapName, [number, number, number][]>;

const toHex = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

// The color at position `t` (clamped to 0-1) along `name`. A non-finite t resolves to 0 rather than
// throwing - callers derive t from a series index over a count that can legitimately be 1 (giving
// 0/0), and a single-series plot taking the colormap's first color is the sensible reading of that.
export function sampleColormap(name: ColormapName, t: number): string {
  const stops = PARSED_STOPS[name] ?? PARSED_STOPS[DEFAULT_COLORMAP];
  const clamped = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const [r0, g0, b0] = stops[i];
  const [r1, g1, b1] = stops[i + 1];
  return `#${toHex(r0 + (r1 - r0) * f)}${toHex(g0 + (g1 - g0) * f)}${toHex(b0 + (b1 - b0) * f)}`;
}

// Evenly-spaced colors across the whole map - the per-series palette for a multi-series plot.
// `reverse` flips the direction (a waterfall drawn bottom-to-top often wants the map's dark end at
// the bottom, which is the opposite of the index order the traces are stored in). A count of 1
// takes the map's midpoint rather than its first stop: a lone trace colored with viridis's near
// black #440154 reads as "black line", losing the fact that a colormap is in play at all.
export function colormapPalette(name: ColormapName, count: number, reverse = false): string[] {
  if (count <= 0) return [];
  if (count === 1) return [sampleColormap(name, 0.5)];
  return Array.from({ length: count }, (_, i) => sampleColormap(name, reverse ? 1 - i / (count - 1) : i / (count - 1)));
}
