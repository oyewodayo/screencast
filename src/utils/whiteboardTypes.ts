// utils/whiteboardTypes.ts
//
// The Whiteboard feature's object model - a diagramming surface (shapes + connectors) distinct
// from the Board feature (boardTypes.ts), which is an image-collage/moodboard tool. A whiteboard
// has two item kinds: WhiteboardNode (a shape, text label, or freehand stroke you drop on the
// canvas) and WhiteboardEdge (a connector between two nodes, or between a node and a free point) -
// modeled like draw.io/most flowchart tools rather than reusing Board's single-canvas-buffer
// approach, since connectors need to track live node positions and DOM-based rendering makes
// that, and inline text editing, straightforward (see WhiteboardCanvas.tsx).
//
// A whiteboard is one or more independent WhiteboardPages (see draw.io's own page tabs) - each
// page has its own nodes/edges and its own undo history (see useWhiteboardStore.ts's setActivePage
// doc comment for why undo is per-page rather than a single global stack).

import { ColormapName, colormapPalette, DEFAULT_COLORMAP } from "./colormaps";

export type WhiteboardShapeType =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "triangle"
  | "hexagon"
  | "parallelogram"
  | "cylinder"
  // "Complex" shapes added alongside the arrow-style work - see whiteboardHandlers.ts's
  // shapeOutlineFor for how each one's outline is actually built.
  | "polygon" // regular n-gon, n = WhiteboardNode.sides (pentagon/heptagon/octagon presets, etc.)
  | "star" // WhiteboardNode.starPoints/starInnerRadiusRatio
  | "trapezoid"
  | "cross"
  | "cube"
  | "cloud"
  | "document" // flowchart "document" - rectangle with a wavy bottom edge
  | "note" // sticky note with a folded corner
  | "callout" // speech-bubble rectangle with a tail
  | "step" // chevron/arrow-shaped process step
  | "wave" // periodic signal trace - WhiteboardNode.waveStyle picks sine/cosine/square/triangle/sawtooth
  // Science/diagram symbols - all fixed (non-parametric) glyphs, same reasoning as document/cloud
  // (a hand-tuned icon, not something with an obvious "how many sides" knob like polygon/star).
  | "resistor" // circuit zigzag
  | "capacitor" // circuit parallel-plate symbol
  | "spring" // physics coil/spring
  | "battery" // circuit single-cell symbol (long + short plate)
  | "flask" // chemistry Erlenmeyer flask
  | "beaker" // chemistry graduated beaker
  | "benzeneRing" // chemistry aromatic ring (hexagon + inscribed circle)
  | "axes" // math x/y coordinate axes
  | "angle" // math angle-with-arc marker
  // Physics vector arrow - a plain horizontal line capped with WhiteboardNode.startArrowType/
  // endArrowType (the SAME two fields "freehand" arrows already use, defaulting to
  // none/"triangle" here), reusing the node's own existing width (length = magnitude) and
  // rotation (direction) instead of inventing separate angle/magnitude fields - resize to change
  // magnitude, use the rotate handle to change direction, exactly like every other shape's own
  // resize/rotate already work. WhiteboardNode.text becomes an optional magnitude label (e.g. "10
  // N") drawn above the line by default (see its own default verticalAlign).
  | "vector"
  | "diode" // circuit diode - triangle + cathode bar (NOT line-only - the triangle is a real fillable region)
  | "inductor" // circuit inductor - a row of same-direction coil bumps (vs. "spring"'s alternating ones)
  | "ground" // circuit ground - three stacked bars of decreasing width below a lead
  // Op-amp - a triangle (NOT line-only, same "real fillable region" reasoning as "diode") with two
  // input leads marked +/- on its flat side and one output lead from its tip.
  | "amplifier"
  // Chemistry skeletal-formula primitive - a zigzag alkane-chain backbone, WhiteboardNode.sides
  // reused as the bond COUNT (same "reuse sides for the one number this shape needs" convention
  // "polygon" already sets) rather than a new field. Deliberately just this one flexible primitive
  // rather than a library of named-molecule presets - combine with the existing "hexagon"/"polygon"
  // ring shapes (cyclohexane, cyclopentane, ...) and "benzeneRing" for anything past a plain chain;
  // true arbitrary skeletal structures (branching, double bonds, ring-fusion) would need a real
  // molecule editor, well past what a single generic zigzag shape can cover.
  | "bondLine"
  | "unitCircle" // math reference diagram - circle + axes + tick marks at each 30 degrees
  // Math number line - reuses the "chart" kind's tick/label machinery (see barChart etc.'s own doc
  // comment on it) for its own evenly-spaced integer ticks, same as functionPlot's axes do.
  | "numberLine"
  // General-purpose glyphs (draw.io's own "General" shape palette) - fixed icons, same reasoning
  // as the science symbols above. "4-Point Star"/"8-Point Star" aren't their own shapeType - like
  // Pentagon/Octagon, they're just "star" at a different starPoints (see WhiteboardEditor.tsx's
  // GENERAL_SHAPE_PRESETS).
  | "hourglass"
  | "teardrop"
  | "lightningBolt"
  | "halfCircle"
  | "banner" // ribbon/banner with a notched bottom edge
  | "frame" // UML-style frame: rectangle + a small pentagon "tab" in the top-left corner
  | "tape" // flowchart tape symbol - wavy top AND bottom edges
  | "display" // flowchart display symbol - lens/eye-shaped
  | "predefinedProcess" // flowchart predefined-process - rectangle with two inset vertical bars
  | "manualInput" // flowchart manual-input - rectangle with a slanted top edge
  | "internalStorage" // flowchart internal-storage - rectangle with an inset corner cross
  // Graph plots - WhiteboardNode.chartData drives the first four (see its own doc comment for why
  // they all share one field); "functionPlot" instead picks a curve via WhiteboardNode.plotFunction.
  // All built from whiteboardHandlers.ts's shared "chart" ShapeOutline kind (multiple independently-
  // colored parts: bars/curve, axis lines, point markers, pie slices), since none of these are a
  // single flat-colored silhouette the way every other shape here is.
  | "barChart"
  | "lineChart"
  | "pieChart"
  | "scatterPlot"
  | "functionPlot"
  // A user-typed math expression graphed over an explicit, independently adjustable x/y window (see
  // WhiteboardNode.graphExpression's own doc comment) - the "graphing calculator" counterpart to
  // "functionPlot"'s curated preset list: any formula in terms of `x` (parsed by
  // whiteboardHandlers.ts's own small arithmetic expression parser, not `eval`/`new Function` - see
  // its compileGraphExpression doc comment for why), plotted with the same "chart" outline machinery
  // (axis lines, optional gridlines, tick labels) every other chart shape already shares.
  | "graph"
  // A stack of many independently-colored traces sharing one x-axis (WhiteboardNode.seriesData) -
  // the "waterfall"/"stacked spectra" plot a spectroscopy or time-series figure is built from, where
  // the point is comparing how a whole FAMILY of measurements evolves rather than reading one curve.
  // Deliberately its own shapeType rather than another chartData-driven variant: every other chart
  // shape here holds exactly one series in WhiteboardNode.chartData and takes its single color from
  // the node's own strokeColor, and neither of those generalizes to N series that each need their
  // own color. Setting seriesOffset to 0 collapses the stack into a plain overlaid multi-series line
  // chart (all traces on a shared baseline), so this one shapeType covers both layouts rather than
  // needing a separate "overlay" type - see seriesOffset's own doc comment.
  | "waterfallChart"
  // A typeset math formula (rendered via KaTeX - see whiteboardHandlers.ts's paintEquation and
  // WhiteboardCanvas.tsx's own KaTeX rendering) - reuses WhiteboardNode.text to hold the raw LaTeX
  // SOURCE (e.g. "E = mc^2"), the same field every other shape's label already lives in, rather than
  // a separate field: double-clicking to edit shows/edits the raw source exactly like editing any
  // other shape's label already works, and when not editing that same text renders as typeset math
  // instead of a plain string. Has no shape body at all - same treatment as "text" (no border/fill,
  // just the formula itself), not one of the "chart" shapes above.
  | "equation"
  // A live, interactive 3D lattice-gauge-theory teaching widget (quarks as colored spheres on
  // lattice sites, gluons as colored links between neighboring sites - orbit/zoom/pan via a real
  // WebGL scene, not a flat drawing) - see LatticeGaugeWidget.tsx, which owns everything about how
  // this shapeType actually renders; WhiteboardCanvas.tsx just mounts it in place of the usual
  // shapeOutlineFor-driven SVG/div body every other shapeType gets (see its own node-body branch).
  // shapeOutlineFor still returns a plain placeholder glyph for this shapeType (the toolbar preset
  // tile, and the Canvas2D PNG-export path, which has no way to capture a live WebGL frame - see
  // its own "latticeGauge" case).
  | "latticeGauge"
  // A grid of rows x columns with per-cell text - see WhiteboardTable.tsx, which owns this
  // shapeType's live rendering AND editing (cell text, row/column resize, insert/delete), same
  // "one file owns the whole shapeType's body" split WhiteboardCanvas.tsx already uses for
  // "latticeGauge"/LatticeGaugeWidget.tsx. Unlike latticeGauge, a table's content (grid lines +
  // cell text) IS representable as a flat drawing, so shapeOutlineFor still returns a real
  // (if simplified - no cell text) grid glyph for the toolbar tile/Canvas2D export, rather than
  // just a placeholder icon.
  | "table"
  // Arithmetic-sign glyphs (draw.io's own "Math" shape palette has the same set) - fixed icons,
  // same "hand-tuned glyph, no parametric knob" reasoning as the science symbols above. "+" is
  // deliberately NOT its own shapeType here - it's just "cross" (already the exact same plus-sign
  // silhouette) offered again under a math-specific label in WhiteboardEditor.tsx's own preset list.
  | "minusSign"
  | "multiplySign" // "x" - the same plus-sign silhouette as "cross", rotated 45 degrees
  | "divideSign" // a horizontal bar with a dot above and below
  | "equalsSign" // "=" - two stacked horizontal bars
  | "greaterThanSign"
  | "lessThanSign" // the same chevron as "greaterThanSign", mirrored
  | "greaterEqualSign" // the "greaterThanSign" chevron with a bar underneath
  | "lessEqualSign" // the "lessThanSign" chevron with a bar underneath
  // A photo/bitmap placed on the canvas - the source file is COPIED into this whiteboard's own
  // assets/ folder at import time (see WhiteboardNode.assetFileName), never referenced in place, so
  // a diagram keeps working after the original is moved, renamed or deleted. Gets every transform
  // (move/resize/rotate/flip/lock/group/z-order) for free from the shared node box, exactly like
  // every vector shape here; what's specific to it is how the bitmap is fitted into that box
  // (imageFit), what silhouette it's cut to (imageMask), and which part of the source is shown
  // (imageCrop*) - see each field's own doc comment.
  | "image"
  | "text"
  | "freehand";

// Shapes that render as an open/line-style glyph with no interior region to speak of (a circuit
// symbol, a coordinate-axes cross) - same treatment as freehand/text: default fillColor is null,
// and the style panel hides the Fill swatch for them. Kept as one shared set rather than repeating
// this shapeType list in whiteboardTypes.ts/WhiteboardStylePanel.tsx/WhiteboardEditor.tsx
// separately, so adding a future line-only shape only means updating it here.
export const LINE_ONLY_SHAPES: ReadonlySet<WhiteboardShapeType> = new Set<WhiteboardShapeType>([
  "wave",
  "resistor",
  "capacitor",
  "spring",
  "battery",
  "axes",
  "angle",
  // lineChart/scatterPlot: a stroked line/dot markers, nothing that reads as "the shape's own
  // fill region". pieChart: always multi-colored from its own fixed palette (see PIE_PALETTE),
  // so node.fillColor has no effect on it at all. functionPlot: axis lines + a stroked curve, same
  // reasoning as lineChart. barChart is deliberately NOT here - its bars DO use node.fillColor.
  "lineChart",
  "pieChart",
  "scatterPlot",
  "functionPlot",
  // "graph": same reasoning as "functionPlot" immediately above - axis lines + a stroked curve, no
  // fillable silhouette of its own.
  "graph",
  // "waterfallChart": every trace carries its own colormap-derived color (see
  // WhiteboardNode.seriesColormap), so node.fillColor has nothing to apply to - same reasoning as
  // "pieChart" above. Its optional under-trace shading (seriesFillUnder) tints each trace with that
  // trace's OWN color, not the node's fill.
  "waterfallChart",
  // "diode" is deliberately NOT here - its triangle is a real fillable region, same reasoning as
  // barChart's bars.
  "vector",
  "inductor",
  "ground",
  "bondLine",
  "unitCircle",
  "numberLine",
  // The widget paints its own dark scene, never node.fillColor - same reasoning as every other
  // shape here (nothing for the style panel's Fill swatch to actually apply to).
  "latticeGauge",
]);

// The built-in sample series a bar/line/pie/scatter chart starts with (and falls back to if
// chartData is ever emptied out entirely) - just enough points to look like a real chart immediately
// on placement rather than a blank box, picked with no particular meaning beyond "visually varied".
export const DEFAULT_CHART_DATA: number[] = [4, 7, 3, 9, 5];

// "latticeGauge" node fields (WhiteboardNode.latticeSize/latticeSiteSpacing/latticeSiteRadius/
// latticeLinkWidth) and their sliders' bounds in LatticeGaugeWidget.tsx / WhiteboardStylePanel.tsx
// - shared here (rather than living only in one of those files) so createDefaultWhiteboardNode's
// own defaults can never drift from what the sliders actually allow.
export const DEFAULT_LATTICE_SIZE = 5;
export const MIN_LATTICE_SIZE = 2;
// Not literally unbounded - the number of gluon links grows as ~3*N^3, and every one of them is a
// real instanced mesh whose transform gets recomputed on the JS main thread on every rebuild (see
// LatticeGaugeWidget.tsx's own geometry-rebuild effect); an actually-uncapped N risks freezing the
// tab (or exhausting GPU memory) on one accidental keystroke. 64 (262,144 sites, ~780K links) is
// generously past anything a teaching diagram needs while staying inside what a typical GPU/CPU
// can still build and render without locking up - well beyond the original cap of 8, which was
// needlessly conservative for a value that's otherwise entirely the user's own call.
export const MAX_LATTICE_SIZE = 64;
export const DEFAULT_LATTICE_SITE_SPACING = 1;
export const MIN_LATTICE_SITE_SPACING = 0.5;
export const MAX_LATTICE_SITE_SPACING = 2.5;
// The quark spheres' own radius, in world units - independent of site spacing (it used to be a
// fixed 0.16x-of-spacing multiplier with no control of its own; now spacing and "how big the
// spheres are" are two separate knobs, since tying them together left no way to make spheres
// bigger/smaller without also changing how far apart the sites sit).
export const DEFAULT_LATTICE_SITE_RADIUS = 0.16;
export const MIN_LATTICE_SITE_RADIUS = 0.02;
export const MAX_LATTICE_SITE_RADIUS = 0.6;
// The gluon links' own radius (their "line weight") - links render as real 3D cylinders, not GPU
// line primitives, specifically so this is adjustable at all: WebGL line width is stuck at ~1px on
// most platforms (ANGLE/Windows included), so a wide-line approach would render exactly as thin
// regardless of what this is set to. The old fixed-at-1px look is roughly what MIN reproduces;
// DEFAULT is deliberately much thicker than that (the whole point of adding this control).
export const DEFAULT_LATTICE_LINK_WIDTH = 0.035;
export const MIN_LATTICE_LINK_WIDTH = 0.005;
export const MAX_LATTICE_LINK_WIDTH = 0.25;
// Spin-arrow length, in world units - independent of latticeSiteRadius/latticeSiteSpacing, same
// "own knob, not tied to another field" reasoning those two get. DEFAULT sits comfortably inside
// one default-spacing (1) unit cell so neighboring arrows don't overlap out of the box.
export const DEFAULT_LATTICE_SPIN_ARROW_SIZE = 0.45;
export const MIN_LATTICE_SPIN_ARROW_SIZE = 0.1;
export const MAX_LATTICE_SPIN_ARROW_SIZE = 1.5;

// "table" node fields (WhiteboardNode.tableRows/tableCols/tableColWidths/tableRowHeights) - shared
// here (rather than living only in WhiteboardTable.tsx/WhiteboardStylePanel.tsx) so
// createDefaultWhiteboardNode's and resolveTableGrid's own defaults/clamps can never drift apart.
export const DEFAULT_TABLE_ROWS = 3;
export const DEFAULT_TABLE_COLS = 3;
export const MIN_TABLE_ROWS = 1;
export const MAX_TABLE_ROWS = 30;
export const MIN_TABLE_COLS = 1;
export const MAX_TABLE_COLS = 15;
// A dragged row/column divider can't shrink its row/column below this fraction of the table's own
// height/width - keeps a cell from being resized down to nothing (which would make it impossible to
// grab again to resize back) or crossing over a neighboring divider.
export const MIN_TABLE_CELL_FRACTION = 0.06;

// A rectangular block of merged table cells - see WhiteboardNode.tableMergedCells's own doc comment.
export interface TableMergedCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

// One side's line style, overriding the table's own uniform solid strokeColor/strokeWidth grid line
// for just that side of one cell - see WhiteboardNode.tableCellBorders's own doc comment.
export type TableBorderStyle = "solid" | "dashed" | "dotted" | "none";
export interface TableCellBorders {
  top?: TableBorderStyle;
  right?: TableBorderStyle;
  bottom?: TableBorderStyle;
  left?: TableBorderStyle;
}

// Which curve a "functionPlot" node traces (see whiteboardHandlers.ts's evalPlotFunction/
// FUNCTION_PLOT_DOMAINS) - a curated preset list rather than an arbitrary user-typed formula, same
// "fixed choices, not a formula parser" tradeoff WhiteboardNode.waveStyle makes for periodic shapes.
export type FunctionPlotType = "linear" | "quadratic" | "cubic" | "sine" | "cosine" | "exponential" | "sqrt" | "logarithm" | "absolute" | "normal";

// The four shapeTypes that read WhiteboardNode.chartData - shared by createDefaultWhiteboardNode
// (to seed it) and WhiteboardStylePanel.tsx (to show the data-editing field).
export const CHART_DATA_SHAPES: ReadonlySet<WhiteboardShapeType> = new Set<WhiteboardShapeType>(["barChart", "lineChart", "pieChart", "scatterPlot"]);

// The shapeTypes whose "chart" ShapeOutline can carry tick/value labels (see ChartLabel and
// WhiteboardNode.showChartLabels) - every chart type except pieChart, which has no axis at all to
// label (a pie's own "data" is communicated by slice size/color, not a scale).
export const CHART_LABEL_SHAPES: ReadonlySet<WhiteboardShapeType> = new Set<WhiteboardShapeType>([
  "barChart",
  "lineChart",
  "scatterPlot",
  "functionPlot",
  "numberLine",
  "graph",
  "waterfallChart",
]);

// The shapeTypes that can carry a chart title and x/y axis titles (WhiteboardNode.chartTitle/
// axisXTitle/axisYTitle) - every chart with a real labeled axis. pieChart is excluded for the same
// reason it's excluded from CHART_LABEL_SHAPES (no axis to title); numberLine takes only the x title
// in practice, but is included rather than special-cased since a y title on it simply resolves to
// nothing being drawn (see whiteboardHandlers.ts's chartTitleLabels).
//
// These exist so a subplot figure is built from self-contained chart nodes instead of a chart plus
// three separately-positioned "text" nodes that have to be re-nudged by hand every time the chart is
// moved or resized - the whole reason arranging a multi-panel figure used to be tedious.
export const CHART_AXIS_TITLE_SHAPES: ReadonlySet<WhiteboardShapeType> = new Set<WhiteboardShapeType>([
  "barChart",
  "lineChart",
  "scatterPlot",
  "functionPlot",
  "numberLine",
  "graph",
  "waterfallChart",
]);

// The shapeTypes that can carry data-space annotations (WhiteboardNode.chartAnnotations) - scoped to
// the two whose axes resolve to an explicit [min,max] window with no sampling involved, so an
// annotation's stored data coordinates map to one unambiguous pixel position and can be inverse-
// mapped back when dragged (see whiteboardHandlers.ts's graphCoordinateMapper/resolveGraphAxisRange).
// functionPlot is deliberately NOT here despite also having axes: its y-range auto-fits to whatever
// the sampled curve happens to span, so the same annotation would silently jump whenever the domain
// scale or cycle count changed - the identical mismatch resolveGraphAxisRange's own doc comment
// already describes for manual graph points.
export const CHART_ANNOTATION_SHAPES: ReadonlySet<WhiteboardShapeType> = new Set<WhiteboardShapeType>(["graph", "waterfallChart"]);

// One labeled point called out on a chart, positioned in the chart's own DATA space (an x/y value on
// its axes, not a pixel offset) - the same "store data coordinates, re-project at render time"
// convention WhiteboardNode.graphPoints already uses, and for the same reason: the callout stays
// attached to the feature it's marking when the axis range or the node's box changes.
//
// Deliberately a first-class field rather than "place a small ellipse next to a text node": those
// two are unrelated free-floating shapes that silently come apart the moment the chart is moved,
// resized, or rescaled, which is exactly what makes hand-annotating a figure tedious and fragile.
export interface ChartAnnotation {
  x: number;
  y: number;
  // Shown next to the marker - empty/absent draws the marker alone (a bare "this point" dot).
  text?: string;
  // Label offset from the marker, in PIXELS rather than data units - a callout sits a fixed visual
  // distance from its point regardless of how the axes are scaled, which is what keeps it clear of
  // the marker at every zoom level (a data-unit offset would collapse onto the dot as the range
  // widened). Absent - resolves to DEFAULT_ANNOTATION_LABEL_DX/DY.
  labelDx?: number;
  labelDy?: number;
  // Marker glyph and color. `color` absent - resolves to the node's own strokeColor, so an
  // un-customized annotation still matches the chart it's on. "none" draws the label with no marker
  // (a floating in-plot text note anchored to a data coordinate).
  marker?: "dot" | "ring" | "square" | "cross" | "none";
  color?: string;
  // Radius/half-size of the marker glyph in pixels. Absent - resolves to DEFAULT_ANNOTATION_MARKER_SIZE.
  size?: number;
  // Draws a thin leader line from the marker to the label - worth having whenever the label has to
  // sit far enough away to clear dense data. Absent - resolves to false.
  leader?: boolean;
}

export const DEFAULT_ANNOTATION_LABEL_DX = 8;
export const DEFAULT_ANNOTATION_LABEL_DY = -10;
export const DEFAULT_ANNOTATION_MARKER_SIZE = 4;

// ---- Multi-series ("waterfallChart") ------------------------------------------------------------

// Hard ceilings on what WhiteboardNode.seriesData can hold. These are not stylistic limits - every
// trace is a separate SVG <path> whose `d` string is rebuilt whenever the outline is recomputed, so
// an unbounded import (a stray 10,000-row CSV paste) would build megabytes of path text per frame
// and lock the canvas up mid-drag. MAX_SERIES_COUNT is generously past any readable stacked figure
// (a 200-trace waterfall is a solid block of ink long before it's a slow one); MAX_SERIES_POINTS is
// per trace, well past typical spectral resolution, and is a storage cap only - what actually keeps
// rendering cheap regardless of how many points are stored is the min/max decimation in
// whiteboardHandlers.ts's decimateSeries, which caps the DRAWN vertex count to roughly the plot's
// own pixel width no matter how dense the underlying data is.
export const MAX_SERIES_COUNT = 200;
export const MAX_SERIES_POINTS = 20000;

// WhiteboardNode.seriesOffset bounds - see its own doc comment for what the number means.
export const DEFAULT_SERIES_OFFSET = 0.55;
export const MIN_SERIES_OFFSET = 0;
export const MAX_SERIES_OFFSET = 5;

// Deterministic PRNG (mulberry32) - the sample data below has to be byte-identical every time this
// module loads, since a freshly placed waterfall node's data is written straight into the saved
// document: seeding it from Math.random would mean two users placing the "same" starting shape get
// different documents, and re-running it would silently change an existing figure.
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The sample stack a fresh "waterfallChart" starts with - a synthetic frequency comb whose mode
// envelope walks across the traces, which is what makes a stacked plot worth looking at in the first
// place (a family of measurements evolving) rather than N copies of one curve. Generated rather than
// written out as a literal purely for file size: the equivalent literal is ~4,000 numbers.
//
// This is decorative placeholder data with no physical meaning - it exists so a newly placed shape
// reads as a real figure immediately instead of an empty box, exactly like DEFAULT_CHART_DATA does
// for the single-series charts, and is meant to be replaced by the user's own measurements.
function buildDefaultWaterfallSeries(): number[][] {
  const traces = 18;
  const samples = 240;
  const rand = seededRandom(0x5eed);
  return Array.from({ length: traces }, (_, t) => {
    // Envelope center sweeps left-to-right across the stack; width breathes a little with it.
    const center = 0.34 + 0.3 * (t / (traces - 1));
    const envWidth = 0.1 + 0.05 * Math.sin((t / traces) * Math.PI);
    return Array.from({ length: samples }, (_, i) => {
      const u = i / (samples - 1);
      // A comb of evenly spaced modes under a Gaussian envelope - the shape a mode-locked spectrum
      // actually has, and the reason the traces read as "spectra" rather than generic wiggles.
      const comb = Math.pow(Math.abs(Math.cos(u * Math.PI * 46)), 26);
      const envelope = Math.exp(-((u - center) ** 2) / (2 * envWidth ** 2));
      const secondary = 0.35 * Math.exp(-((u - center + 0.16) ** 2) / (2 * (envWidth * 0.55) ** 2));
      return (comb * (envelope + secondary) + rand() * 0.012) * 100;
    });
  });
}

export const DEFAULT_WATERFALL_SERIES: number[][] = buildDefaultWaterfallSeries();

export interface ResolvedSeries {
  // Sanitized traces - every entry finite, every trace non-empty, count/length within the
  // MAX_SERIES_COUNT/MAX_SERIES_POINTS caps.
  series: number[][];
  // One color per trace, already resolving seriesColors overrides against the colormap.
  colors: string[];
  labels: string[];
  xMin: number;
  xMax: number;
  // The amplitude window ONE trace spans, before stacking.
  yMin: number;
  yMax: number;
  // Vertical gap between consecutive trace baselines, in the same y units as yMin/yMax (already
  // resolved from the relative seriesOffset multiplier).
  offsetStep: number;
  // The full stacked y-extent, what the y-axis actually has to span: yMin to yMax + (n-1)*offsetStep.
  stackedYMin: number;
  stackedYMax: number;
}

// The one place a "waterfallChart" node's series fields get resolved into a definitely-consistent
// plot description - every reader (the live SVG render, the Canvas2D export, the style panel's
// trace list) goes through this rather than reading seriesData/seriesColors/seriesOffset off the
// node directly, so malformed or stale data (a NaN from a bad CSV paste, a seriesColors array left
// longer than seriesData after traces were deleted, an all-identical trace with zero range) can
// never desync one reader from another, produce a divide-by-zero, or throw. Same "resolve absent/
// stale data at read time" convention resolveTableGrid already sets for tables.
// Structurally typed to just the fields it reads rather than a whole WhiteboardNode, so
// whiteboardHandlers.ts's ShapeOutlineOptions (which mirrors node fields one-by-one and has no real
// node behind it when previewing a toolbar tile) can be passed straight in.
export type SeriesSource = Pick<
  WhiteboardNode,
  "seriesData" | "seriesXMin" | "seriesXMax" | "seriesYMin" | "seriesYMax" | "seriesOffset" | "seriesColormap" | "seriesColorsReversed" | "seriesColors" | "seriesLabels"
>;

export function resolveSeriesData(node: SeriesSource): ResolvedSeries {
  const raw = node.seriesData && node.seriesData.length > 0 ? node.seriesData : DEFAULT_WATERFALL_SERIES;
  const series = raw
    .slice(0, MAX_SERIES_COUNT)
    .map((trace) => (Array.isArray(trace) ? trace.slice(0, MAX_SERIES_POINTS).filter((v) => Number.isFinite(v)) : []))
    .filter((trace) => trace.length > 0);
  // Every trace was empty or malformed - fall back rather than returning a zero-trace plot that
  // every downstream mapper would then have to special-case.
  const safe = series.length > 0 ? series : DEFAULT_WATERFALL_SERIES;

  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const trace of safe) {
    for (const v of trace) {
      if (v < dataMin) dataMin = v;
      if (v > dataMax) dataMax = v;
    }
  }
  let yMin = node.seriesYMin ?? dataMin;
  let yMax = node.seriesYMax ?? dataMax;
  // A perfectly flat trace (every sample identical) has zero range, which would make every
  // data-to-pixel division below a 0/0 - give it a nominal unit window instead so it draws as a
  // straight line at its own value rather than vanishing.
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMax <= yMin) {
    const mid = Number.isFinite(yMin) ? yMin : 0;
    yMin = mid - 0.5;
    yMax = mid + 0.5;
  }

  const longest = safe.reduce((m, t) => Math.max(m, t.length), 0);
  let xMin = node.seriesXMin ?? 0;
  let xMax = node.seriesXMax ?? Math.max(1, longest - 1);
  if (!Number.isFinite(xMin)) xMin = 0;
  if (!Number.isFinite(xMax) || xMax <= xMin) xMax = xMin + 1;

  const offsetMultiplier = Math.max(MIN_SERIES_OFFSET, Math.min(MAX_SERIES_OFFSET, node.seriesOffset ?? DEFAULT_SERIES_OFFSET));
  const offsetStep = (yMax - yMin) * offsetMultiplier;

  const colormap = node.seriesColormap ?? DEFAULT_COLORMAP;
  const palette = colormapPalette(colormap, safe.length, node.seriesColorsReversed ?? false);
  const colors = safe.map((_, i) => node.seriesColors?.[i] ?? palette[i]);
  const labels = safe.map((_, i) => node.seriesLabels?.[i] ?? `Series ${i + 1}`);

  return {
    series: safe,
    colors,
    labels,
    xMin,
    xMax,
    yMin,
    yMax,
    offsetStep,
    stackedYMin: yMin,
    stackedYMax: yMax + offsetStep * (safe.length - 1),
  };
}

interface WhiteboardItemBase {
  id: string;
  createdAt: number;
  updatedAt: number;
}

// Geometry is a plain axis-aligned x/y/width/height box - `rotation` (below) is purely a rendering
// transform layered on top of it, not a change to the box itself. That's a deliberate scope
// tradeoff: resolveAnchorPoint/resolveAutoSide in whiteboardHandlers.ts (what a connector's "auto"
// end anchors to) still work entirely in this unrotated box - correct for rotation 0, and still
// reasonable for a modest tilt, but a connector attached to a heavily-rotated shape won't hug its
// actual rotated outline. Resize handles, unlike that, DO account for rotation (see
// WhiteboardCanvas.tsx's cornerWorldPoint/rotateVector) - a dragged corner's screen-space delta is
// projected into the box's own rotated axes, and the opposite corner is solved to stay fixed in
// WORLD space rather than just this unrotated box's local space.
export interface WhiteboardNode extends WhiteboardItemBase {
  kind: "node";
  shapeType: WhiteboardShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  // Degrees, clockwise, about the box's own center - 0/undefined = unrotated. Purely a visual
  // transform (see this interface's own top comment for what that does and doesn't affect).
  rotation?: number;
  // Mirrors the shape about its own center's vertical/horizontal axis, applied BEFORE rotation (so
  // flipping then rotating some angle gives the same result a real object flipped-then-turned
  // would) - see WhiteboardCanvas.tsx's localToWorldVector for the exact composition, matched by
  // whiteboardHandlers.ts's Canvas2D export (ctx.rotate called before ctx.scale, same order). Same
  // scope as rotation above: purely a rendering transform - the underlying box and every geometry
  // function that builds a shape's outline from width/height never need to know a flip happened.
  // Absent/false - unflipped.
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  // Prevents this node from being moved (dragged by its body or its own Move handle, keyboard-
  // nudged, or resized/rotated via its own handles) until turned back off - a "don't disturb this
  // while I work around/on top of it" pin, most useful for a shape a user is manually annotating
  // in place (e.g. plotting points directly onto a "graph" node - see WhiteboardNode.graphPoints'
  // own doc comment) where an accidental drag would misalign everything already placed. Deliberately
  // scoped to ONLY the transform/position operations above - style edits (color, stroke, the
  // graph's own expression/range fields, ...), text editing, and delete all still work normally
  // while locked, since none of those risk silently shifting the shape out from under other content
  // anchored to its current position. Absent/false - unlocked (every node's original behavior).
  locked?: boolean;
  // Shared by every node in the same "Group" action (see WhiteboardEditor.tsx's handleGroup) -
  // clicking, selecting-via-marquee, or dragging any one member acts on every node sharing this id
  // (see WhiteboardCanvas.tsx's expandGroupSelection). Purely a selection/interaction convenience,
  // same "no new command type" reasoning batch-edit-nodes already covers everything grouping needs:
  // Group/Ungroup are just an ordinary batchEditNodes call that sets/clears this field, undo-tracked
  // for free the same way any other multi-node style edit already is. Absent = not in a group.
  groupId?: string;
  text: string;
  // Ignored for shapeType "text"/"freehand" (a label/ink stroke has no interior to fill) - null =
  // no fill, same "null = transparent" convention boardTypes.ts uses.
  fillColor: string | null;
  strokeColor: string;
  strokeWidth: number;
  // "rectangle" only - lets the same shapeType cover both a square-cornered box and a rounded one
  // (the toolbar's "Rounded Rectangle" quick-add is just this at a nonzero default), same
  // parameterized-shapeType convention boardTypes.ts's BoardShape uses for its polygon/star fields.
  cornerRadius?: number;
  // "polygon" only, 3-12 sides - a pentagon, heptagon, octagon etc. are all this one shapeType at
  // a different `sides`, not their own separate shapeType values (see boardTypes.ts's BoardShape
  // for the same convention). Absent on a node predating this field - resolves to 5 (pentagon).
  sides?: number;
  // "star" only, 3-12 points. Absent - resolves to 5.
  starPoints?: number;
  // "star" only, 0-1 - how far the inner (concave) vertices sit toward the center relative to the
  // outer points; smaller = spikier. Absent - resolves to 0.45. Named starPoints/starInnerRadiusRatio
  // rather than reusing BoardShape's bare `points`/`innerRadiusRatio` names because `points` on this
  // type already means something else entirely (see WhiteboardNode.points's own doc comment below).
  starInnerRadiusRatio?: number;
  // "wave" only - which periodic curve to trace across the node's box (see whiteboardHandlers.ts's
  // waveOutlineD). Absent - resolves to "sine".
  waveStyle?: "sine" | "cosine" | "square" | "triangle" | "sawtooth";
  // "wave" only - how many full periods to trace across the node's own width (see
  // whiteboardHandlers.ts's MIN/MAX_WAVE_CYCLES for the bounds). Absent - resolves to
  // DEFAULT_WAVE_CYCLES. Wider spacing (fewer cycles) vs. denser (more) is a look the shape needs
  // to hand over, same reasoning as star's points/polygon's sides being user-adjustable.
  waveCycles?: number;
  // "angle" only - the angle (degrees) between the two rays, and each ray's own length as a
  // fraction of its natural max (the horizontal ray's max is the node's own width; the angled
  // ray's max is min(width, height) - see whiteboardHandlers.ts's angleOutlineD). Absent - resolve
  // to DEFAULT_ANGLE_DEGREES/DEFAULT_ANGLE_RAY_LENGTH. Independently adjustable rather than a
  // single "size" knob so the glyph can actually represent a specific angle/side-length
  // relationship (e.g. sketching a real angle-side-angle construction) rather than just being a
  // fixed decorative icon like cloud/document.
  angleDegrees?: number;
  angleRay1Length?: number;
  angleRay2Length?: number;
  // "barChart"/"lineChart"/"pieChart"/"scatterPlot" only - the data series, edited in the style
  // panel as one comma-separated numbers field. Shared by all four chart shapeTypes rather than each
  // getting its own field, since they're all "the same series, drawn differently" - switching a
  // node's shapeType between them (not currently exposed in the UI, but nothing stops it) keeps the
  // data intact rather than losing it. Absent/empty - resolves to DEFAULT_CHART_DATA.
  chartData?: number[];
  // "functionPlot" only - which curve to trace (see whiteboardHandlers.ts's evalPlotFunction).
  // Absent - resolves to "sine".
  plotFunction?: FunctionPlotType;
  // "functionPlot" only, and only consulted for the 7 non-periodic functions (everything except
  // sine/cosine, which use plotCycles below instead) - multiplies the curve's own default x-domain
  // (see whiteboardHandlers.ts's FUNCTION_PLOT_DOMAINS). Below 1 zooms in, above 1 zooms out. Absent
  // - resolves to DEFAULT_PLOT_DOMAIN_SCALE (1, the function's own default window).
  plotDomainScale?: number;
  // "functionPlot" only, and only for plotFunction "sine"/"cosine" - how many full periods are
  // shown, domain = [-cycles*PI, cycles*PI] (a whole number of periods, same as WhiteboardNode's
  // own "wave" shapeType's waveCycles - a directly countable "how many waves" knob reads far more
  // naturally for a periodic curve than the abstract domain-scale multiplier plotDomainScale is for
  // the other 7 functions, which is why sine/cosine get this instead of that rather than in
  // addition to it). Absent - resolves to DEFAULT_PLOT_CYCLES (2).
  plotCycles?: number;
  // "functionPlot" only - draws faint gridlines across the whole plot at every tick position (both
  // axes), not just the tick marks themselves - the "graph paper" look, for reading values off the
  // curve more easily. Independent of showChartLabels below (you can have gridlines with no numbers,
  // or numbers with no gridlines). Absent - resolves to false (off by default, matching how the
  // shape looked before this field existed).
  plotShowGrid?: boolean;
  // "functionPlot" only - the spacing between consecutive tick numbers along each axis, in that
  // axis's own units (so an X interval that makes sense for sine's ~±6 radian domain is a very
  // different number from what makes sense for cubic's ~±2 domain - two separate fields rather than
  // one shared interval, since applying the same absolute spacing to both would leave whichever
  // axis has the smaller range with only one or two ticks, or none). Absent/0 - resolves to an
  // auto-picked interval that always yields 5 evenly-spaced ticks across whatever's currently in
  // view, same as before this field existed.
  plotXTickInterval?: number;
  plotYTickInterval?: number;
  // "barChart"/"lineChart"/"pieChart"/"scatterPlot"/"functionPlot" only - whether to draw the
  // axis/value tick numbers at all. Absent - resolves to true (shown by default).
  showChartLabels?: boolean;
  // "numberLine" only - the line spans [-numberLineMax, numberLineMax] (symmetric around 0, since
  // that's what every real use of a plain reference number line wants - there's no case for an
  // off-center range the way a function plot's domain can usefully be). Tick spacing auto-widens
  // past whatever integer step keeps the label count readable (see whiteboardHandlers.ts's
  // numberLineOutline), so cranking this up doesn't degrade into unreadable clutter. Absent -
  // resolves to DEFAULT_NUMBER_LINE_MAX (10, the line's original fixed range).
  numberLineMax?: number;
  // "graph" only - a formula in terms of `x` (e.g. "sin(x)", "x^2 - 3*x + 2", "1/x"), compiled by
  // whiteboardHandlers.ts's compileGraphExpression - a small hand-rolled arithmetic parser (numbers,
  // +-*/^%, parentheses, implicit multiplication like "2x", and a fixed table of functions/constants:
  // sin/cos/tan/asin/acos/atan/atan2/sinh/cosh/tanh/sqrt/abs/sign/exp/ln/log/log2/floor/ceil/round/
  // min/max/pow/pi/e), never `eval`/`new Function` - this is what lets "graph" cover any formula a
  // user can type rather than functionPlot's own curated preset list, with no way to express
  // anything past plain arithmetic (no loops, no access to anything outside the formula itself).
  // Absent/empty - resolves to DEFAULT_GRAPH_EXPRESSION. An expression that fails to parse (or
  // evaluates to non-finite everywhere) simply draws no curve - the axes/grid still render, and the
  // style panel's Expression field shows the parse error inline rather than the shape breaking.
  graphExpression?: string;
  // "graph" only - the plotted x-domain, unlike functionPlot's plotDomainScale multiplier this is an
  // explicit absolute [min, max] window (a user-typed formula has no single "natural" domain a
  // multiplier could scale) - independently adjustable in the style panel. Absent - resolves to
  // DEFAULT_GRAPH_X_MIN/DEFAULT_GRAPH_X_MAX.
  graphXMin?: number;
  graphXMax?: number;
  // "graph" only - an explicit y-domain override. Both absent (the default) - the y-axis auto-fits
  // to whatever the sampled curve's own range is (see whiteboardHandlers.ts's graphOutline, robust
  // against a near-asymptote sample or two dominating the scale), same as functionPlot's own
  // auto-fit; setting either one switches that axis to the explicit value instead, e.g. for lining
  // up two graph shapes on the same y-scale for comparison.
  graphYMin?: number;
  graphYMax?: number;
  // "graph" only - draws faint gridlines across the whole plot at every tick position (both axes),
  // same field/rendering as functionPlot's own plotShowGrid. Absent - resolves to true (unlike
  // functionPlot's off-by-default, a typed-formula graph reads more like reference graph paper by
  // default).
  graphShowGrid?: boolean;
  // "graph" only - explicit tick spacing per axis, same "0/absent picks an automatic 5-tick spacing"
  // convention as functionPlot's plotXTickInterval/plotYTickInterval.
  graphXTickInterval?: number;
  graphYTickInterval?: number;
  // "graph" only - manually-placed points, in the graph's own DATA-space coordinates (an actual
  // x/y value on its axes, e.g. {x: 2, y: 4} - NOT a pixel offset) rather than a fraction of the
  // node's box the way freehand's own `points` are, since a graph's own coordinate system already
  // has an origin and scale of its own to express positions against, and storing data-space values
  // keeps a manually-plotted curve meaningful even after the axis range (graphXMin/graphXMax/
  // graphYMin/graphYMax) or the node's box size changes - it re-projects onto the new scale exactly
  // like the formula curve already does, rather than needing to be re-drawn from scratch. Lets a
  // "graph" node work as a blank coordinate plane a user plots directly onto (see the "Blank Graph"
  // preset, which starts with graphExpression empty - no formula curve at all) instead of only ever
  // tracing a typed formula: 2+ points connect into a straight-segment polyline (see
  // whiteboardHandlers.ts's graphOutline), one point alone still shows as a single dot. Each point
  // gets its own small draggable handle when the node is selected (WhiteboardCanvas.tsx's own
  // "graphPoint" Interaction variant) - drag to reposition, double-click a blank part of the plot
  // to add a new one (inserted in x-ascending order, reading left-to-right like a real graph),
  // double-click an existing point's own handle to remove it. Absent/empty - no manual points, the
  // node falls back to tracing graphExpression's formula alone (if any).
  graphPoints?: { x: number; y: number }[];
  // "waterfallChart" only - the traces, seriesData[seriesIndex][sampleIndex] = a y value. Every
  // trace shares the one x-axis (see seriesXMin/seriesXMax), with sample i of a trace of length L
  // sitting at the fraction i/(L-1) across that axis - so traces of DIFFERENT lengths still line up
  // correctly end-to-end rather than needing to be resampled to a common grid first, which is what
  // lets measurements taken at different resolutions be stacked in one figure.
  //
  // A nested array rather than a flat array plus a stride: the ragged-length support above needs it,
  // and it also makes "delete trace 7" an ordinary splice instead of index arithmetic. Absent/empty
  // - resolves to DEFAULT_WATERFALL_SERIES (see resolveSeriesData, the single place every reader
  // goes through - same "resolve absent/stale data at read time" convention resolveTableGrid sets).
  seriesData?: number[][];
  // "waterfallChart" only - the x-axis window the samples span, in the measurement's own units
  // (wavenumber, delay, frequency, ...). Both absent - the axis is labeled by sample INDEX
  // (0 to longest-trace-length - 1), which is always self-consistent with whatever data is loaded
  // and is the only meaningful default before a user says what the x units actually are.
  seriesXMin?: number;
  seriesXMax?: number;
  // "waterfallChart" only - an explicit y-window override for the trace amplitudes, before stacking.
  // Both absent - auto-fits to the data's own global min/max across every trace (a SHARED scale, so
  // relative amplitudes between traces stay honest - per-trace normalization would make a weak
  // spectrum look as strong as an intense one).
  seriesYMin?: number;
  seriesYMax?: number;
  // "waterfallChart" only - the vertical stacking gap between consecutive traces, as a MULTIPLE of
  // one trace's own full amplitude range rather than an absolute y value: 1 means each trace's
  // baseline sits exactly one trace-height above the previous (no overlap at all), the default 0.55
  // lets neighbors overlap a little the way a real stacked-spectra figure does, and 0 collapses
  // every trace onto a shared baseline - a plain overlaid multi-series line chart. Relative rather
  // than absolute so the stack keeps its proportions when the underlying data is swapped for a
  // series with a completely different magnitude. Absent - resolves to DEFAULT_SERIES_OFFSET.
  seriesOffset?: number;
  // "waterfallChart" only - which color scale the per-trace colors are sampled from, evenly spaced
  // across however many traces there are (see colormaps.ts). Absent - resolves to DEFAULT_COLORMAP.
  seriesColormap?: ColormapName;
  // "waterfallChart" only - walks the colormap from its high end down to its low end instead. A
  // stack is drawn with trace 0 at the BOTTOM, so this is what puts a colormap's dark end at the
  // bottom of the figure rather than the top. Absent - resolves to false.
  seriesColorsReversed?: boolean;
  // "waterfallChart" only - per-trace color overrides, parallel to seriesData by index. An entry
  // that's null/absent (including a short array, the common case where only one trace was recolored)
  // falls back to that trace's own colormap color, so this only ever has to hold the traces a user
  // deliberately changed - the same "only store the deliberate deviations" convention
  // tableCellFill/tableCellBorders already use.
  seriesColors?: (string | null)[];
  // "waterfallChart" only - shades the region between each trace and its own baseline in that
  // trace's own color at low opacity. The "filled ridgeline/joyplot" look, which reads more clearly
  // than bare lines when traces overlap heavily. Absent - resolves to false.
  seriesFillUnder?: boolean;
  // "waterfallChart" only - draws a faint horizontal baseline under each trace at its own offset
  // level, marking that trace's own zero. Absent - resolves to false.
  seriesShowBaselines?: boolean;
  // "waterfallChart" only - per-trace names, parallel to seriesData by index. Used for the optional
  // legend (seriesShowLegend) and nothing else; a trace with no name falls back to "Series N".
  seriesLabels?: string[];
  // "waterfallChart" only - draws a small legend keying each trace's color to its seriesLabels name.
  // Off by default: a stacked figure with dozens of traces communicates via the colormap as a
  // continuous scale, where a 40-entry legend is noise rather than information.
  seriesShowLegend?: boolean;
  // "waterfallChart" only - faint gridlines at every tick, same field meaning as functionPlot's own
  // plotShowGrid. Absent - resolves to false.
  seriesShowGrid?: boolean;
  // "waterfallChart" only - explicit tick spacing per axis, same "0/absent picks an automatic 5-tick
  // spacing" convention as graphXTickInterval/graphYTickInterval.
  seriesXTickInterval?: number;
  seriesYTickInterval?: number;
  // Every CHART_AXIS_TITLE_SHAPES member - the figure's own title and axis captions (e.g.
  // "Wavenumber [cm^-1]"), drawn by the chart itself rather than as separately-placed "text" nodes
  // (see CHART_AXIS_TITLE_SHAPES' own doc comment for why). The y title renders rotated 90 degrees
  // up the left edge, the standard plotting convention. Each absent/empty - that caption simply
  // isn't drawn, and the space it would have taken is given back to the plot area.
  chartTitle?: string;
  axisXTitle?: string;
  axisYTitle?: string;
  // Every CHART_ANNOTATION_SHAPES member - labeled callouts pinned to data coordinates (see
  // ChartAnnotation). Each gets its own draggable handle when the node is selected, the same
  // interaction "graph"'s manual points already have. Absent/empty - none.
  chartAnnotations?: ChartAnnotation[];
  // ---- "image" only -----------------------------------------------------------------------------
  // Filename only, relative to this whiteboard's own Whiteboards/<id>/assets/ folder - never an
  // absolute path and never the original source file's path. Images are copied in at import time
  // (see whiteboards.rs's import_whiteboard_image/save_whiteboard_image), the same convention
  // boardTypes.ts's BoardImage.assetFileName already uses and for the same reason: a diagram that
  // silently breaks because someone tidied up their Downloads folder is not a diagram you can rely
  // on. An asset that has genuinely gone missing renders as a labeled placeholder rather than
  // breaking the node (see WhiteboardCanvas.tsx's own image branch).
  assetFileName?: string;
  // The source bitmap's own pixel dimensions, captured at import. Kept on the node (rather than
  // read off the decoded image every time) so aspect-ratio operations - the starting box, "reset to
  // natural size", aspect-locked resize - work synchronously and identically in every renderer,
  // including the Canvas2D export path, without waiting on a decode.
  naturalWidth?: number;
  naturalHeight?: number;
  // How the bitmap fills its box. "cover" crops to fill the whole box (no letterboxing, the usual
  // choice for a photo in a fixed frame); "contain" fits the whole image inside, showing the node's
  // own fillColor in the leftover margin; "fill" stretches to the box exactly, ignoring aspect
  // ratio. Absent - resolves to "cover".
  imageFit?: "cover" | "contain" | "fill";
  // The silhouette the image is cut to. "rect" is the plain box; "rounded" uses the node's own
  // cornerRadius (the same field a rectangle shape already has, rather than a second radius field);
  // "ellipse" inscribes an ellipse in the box, which on a square box is the circle a portrait/
  // micrograph callout wants. The node's strokeColor/strokeWidth draw as a ring following whichever
  // silhouette is active - that combination (ellipse mask + a thick colored stroke) is what makes
  // the circular ringed photo treatment a plain style setting rather than a special shape type.
  // Absent - resolves to "rect".
  imageMask?: "rect" | "rounded" | "ellipse";
  // Which rectangle of the SOURCE image is shown, as fractions (0-1) of its natural size - x/y are
  // the top-left corner, w/h the extent. Fractions rather than pixels so a crop survives the source
  // being swapped for a different-resolution version of the same picture, the same resize-safe
  // reasoning WhiteboardNode.points uses for freehand strokes. Absent - the whole image
  // (0,0,1,1). Note this composes with imageFit: the crop selects a sub-image, then that sub-image
  // is fitted into the box.
  imageCropX?: number;
  imageCropY?: number;
  imageCropW?: number;
  imageCropH?: number;
  // 0-1. Absent - resolves to 1 (fully opaque). Useful for a watermark/underlay a diagram is traced
  // over, which is otherwise impossible to draw on top of legibly.
  imageOpacity?: number;
  // Renders the image desaturated - the standard treatment for a reference figure reproduced
  // alongside new work, where color would compete with the annotation drawn over it. Absent -
  // resolves to false.
  imageGrayscale?: boolean;
  // "amplifier" only - each lead's own length in ABSOLUTE doc units (not a fraction of width - see
  // whiteboardHandlers.ts's MIN/MAX/DEFAULT_AMP_*_LEAD_LENGTH for why absolute is what lets dragging
  // one terminal lengthen/shorten JUST that wire). The two input leads are always independently
  // adjustable - own fields, no "linked" mode - matching a real op-amp's +/- inputs being two
  // unrelated wires with no reason to ever move together. Dragged directly via the small handles
  // WhiteboardCanvas.tsx shows on a selected amplifier's lead terminals (see its own
  // beginAmpLeadDrag) rather than through a style-panel field - a "grab the actual line" interaction
  // like diagrams.net's shape-specific handles, scoped to just this one shape for now to prove the
  // mechanism out before rolling it out to the rest of the circuit-symbol shapes. Absent - resolves
  // to the shape's original fixed proportions.
  ampInputTopLeadLength?: number;
  ampInputBottomLeadLength?: number;
  ampOutputLeadLength?: number;
  // "amplifier" only - each lead's terminal can also be dragged vertically, bending the wire into an
  // L-shape (a short jog right at the terminal, then a straight run to the body at its natural
  // height - see whiteboardHandlers.ts's amplifierOutlineParts) rather than a plain straight
  // horizontal line. Doc units, offset from the lead's own natural resting height - free to extend
  // well outside the node's own current height/bounding box (see
  // whiteboardHandlers.ts's AMP_LEAD_Y_OFFSET_BOUND), since routing a lead out to some other shape
  // isn't something the amplifier's own box size should ever get to veto; the box itself never
  // grows for this axis the way the length fields above grow it for theirs. Absent/0 - resolves to
  // a plain straight lead, pixel-identical to before this field existed.
  ampInputTopLeadYOffset?: number;
  ampInputBottomLeadYOffset?: number;
  ampOutputLeadYOffset?: number;
  // "amplifier" only - which input the "+"/"-" glyphs mark, purely a labeling swap (the physical
  // top/bottom leads themselves - their positions, drag handles, length/bend fields - never change,
  // only which glyph is drawn at which height). Real schematics draw the inverting input on
  // whichever side keeps its wire from crossing others, so this needs to be flippable per instance
  // rather than fixed. Absent/false - "+" on top, "-" on bottom (this shape's original layout).
  ampInvertingOnTop?: boolean;
  // "latticeGauge" only - persisted widget state (see LatticeGaugeWidget.tsx). Camera orbit/zoom/
  // pan is deliberately NOT here - that's a live view preference, not diagram content, same
  // "ephemeral" reasoning WhiteboardCanvas.tsx's own pan/zoom props get (they live on
  // WhiteboardEditor's view state, never in the document).
  //
  // The lattice's own edge length, sites per edge - N^3 total sites. Absent - resolves to
  // DEFAULT_LATTICE_SIZE.
  latticeSize?: number;
  // Doc-agnostic 3D world units between neighboring sites (purely a "how spread out" visual knob -
  // no relationship to the node's own width/height, which only ever scale the embedded widget's
  // 2D screen footprint, never its 3D content). Absent - resolves to DEFAULT_LATTICE_SITE_SPACING.
  latticeSiteSpacing?: number;
  // Show/hide the matter-field spheres and the gauge-link lines independently - each absent
  // resolves to true (both shown, matching the widget's own on-by-default toggle switches).
  latticeShowQuarks?: boolean;
  latticeShowGluons?: boolean;
  // Whether gauge links show a traveling brightness pulse (the "flux") or sit at flat color.
  // Absent - resolves to true.
  latticeAnimateFlux?: boolean;
  // Which of the three teaching-mode panels is active - "free" is plain exploration with no
  // highlight; "plaquette" highlights one elementary closed loop of 4 links (the smallest Wilson
  // loop, U_plaquette); "gauge" recolors each site with its own random "phase" and blends adjacent
  // links between their endpoints' phases, illustrating a local gauge transformation. Absent -
  // resolves to "free".
  latticeTeachingMode?: "free" | "plaquette" | "gauge";
  // "latticeGauge" only, "plaquette" mode only - which unit square is highlighted/explained: the
  // xy-plane loop anchored at lattice site (i,j,k) (its other 3 corners are (i+1,j,k), (i+1,j+1,k),
  // (i,j+1,k) - see LatticeGaugeWidget.tsx's plaquetteLoopSegments). Set by clicking a quark while
  // in plaquette mode (LatticeGaugeWidget.tsx's pickPlaquetteAnchor) rather than fixed, so a user
  // can walk the explanation across different faces of the lattice. Absent - resolves to {0,0,0}.
  // Out-of-range for the CURRENT latticeSize (e.g. after shrinking N) is clamped back on read
  // rather than eagerly corrected here, same "resolve at read time" treatment every other
  // absent/stale shape field on this type gets.
  latticePlaquetteAnchor?: { i: number; j: number; k: number };
  // Quark sphere radius and gluon link radius ("line weight"), both in absolute world units,
  // independent of latticeSiteSpacing (see DEFAULT_LATTICE_SITE_RADIUS/DEFAULT_LATTICE_LINK_WIDTH's
  // own doc comments in whiteboardTypes.ts for why they're decoupled from spacing). Absent -
  // resolves to those defaults.
  latticeSiteRadius?: number;
  latticeLinkWidth?: number;
  // Whether spin-direction arrows are drawn at each site - a separate visualization layer from the
  // quark spheres themselves (latticeShowQuarks), so an arrow can be shown with or without its
  // sphere. Absent - resolves to false (an existing lattice never sprouts arrows just because this
  // field was added).
  latticeShowSpins?: boolean;
  // Arrow length, in world units. Absent - resolves to DEFAULT_LATTICE_SPIN_ARROW_SIZE.
  latticeSpinArrowSize?: number;
  // Which spin model the per-site arrow directions illustrate (see LatticeGaugeWidget.tsx's
  // buildSpinDirections) - "ising" arrows point straight up or down (+y/-y), the classic two-state
  // spin; "xy" arrows lie flat in the lattice's own xz-plane at a random planar angle, a continuous
  // U(1) spin; "heisenberg" arrows point in a fully random 3D direction, a continuous O(3) spin.
  // Purely a display convention illustrating what each model's spins LOOK like - there's no actual
  // spin Hamiltonian, coupling, or energy being computed here, this is a teaching glyph, not a
  // simulation. Absent - resolves to "ising".
  latticeSpinModel?: "ising" | "xy" | "heisenberg";
  // Whether spin arrows continuously re-randomize a handful of sites at a time, suggesting live
  // thermal flip dynamics - a cheap illustrative animation (see LatticeGaugeWidget.tsx's spin-
  // animation effect), not an actual Metropolis/Monte-Carlo simulation. Absent - resolves to false.
  latticeAnimateSpins?: boolean;
  // "table" only - grid dimensions and content (see WhiteboardTable.tsx). Absent - resolves to
  // DEFAULT_TABLE_ROWS/DEFAULT_TABLE_COLS (see resolveTableGrid below, the single place every
  // reader of these fields - the live widget, the style panel, the Canvas2D export - resolves them,
  // so a stale/out-of-range value from before a row/column was added or removed can never crash or
  // silently desync one reader from another).
  tableRows?: number;
  tableCols?: number;
  // Each column's/row's own width/height as a fraction (0-1) of the node's own width/height,
  // summing to 1 - same resize-safe convention "freehand"'s `points` fractions use (see this
  // interface's own `points` doc comment below): resizing the table's box rescales the whole grid
  // for free instead of needing bespoke per-row/column resize math. Length should match
  // tableCols/tableRows; resolveTableGrid falls back to equal fractions if it doesn't (a stale
  // array left over from a since-changed row/column count).
  tableColWidths?: number[];
  tableRowHeights?: number[];
  // Per-cell text, tableCellText[row][col]. A cell past the array's own bounds (same staleness case
  // as above) resolves to "".
  tableCellText?: string[][];
  // Whether the first row renders bold with a subtly shaded background - the common "title row"
  // table convention (draw.io's own table insert offers the same toggle). Absent - resolves to
  // true (a fresh table looks like it has a header until deliberately turned off, since that's the
  // far more common case than a header-less data grid).
  tableHeaderRow?: boolean;
  // "table" only - cells merged into one (a rectangular block of the grid rendered/edited as a
  // single cell, anchored at its own top-left row/col). A cell "covered" by a merge (inside its
  // rowSpan x colSpan footprint but not the anchor itself) renders nothing of its own - its text is
  // not shown even if tableCellText still has a stray value there from before the merge. Absent/
  // empty - no merges (every cell its own 1x1). See resolveTableGrid for how a stale/out-of-range
  // entry (row/col/span no longer fitting the current tableRows/tableCols) gets clamped rather than
  // crashing, same "resolve at read time" treatment every other table field gets.
  tableMergedCells?: TableMergedCell[];
  // "table" only - per-cell background override, tableCellFill[row][col]. null/absent at a given
  // cell - that cell just shows the table's own fillColor, same as every cell already did before
  // this field existed. A merged cell's override (if any) lives at its own anchor position; a
  // covered cell's own entry, if any is somehow still there, is never read (same "covered cells
  // render nothing of their own" rule tableMergedCells's doc comment already sets).
  tableCellFill?: (string | null)[][];
  // "table" only - per-cell, per-side border override, tableCellBorders[row][col]. Any side absent
  // from a cell's own entry (or the cell having no entry at all) falls back to the table's ordinary
  // uniform grid line (strokeColor/strokeWidth, solid) - this only ever needs to hold the sides a
  // user has deliberately changed away from that default. "none" removes the line on that side
  // entirely (no border drawn there at all, not even a transparent one).
  tableCellBorders?: (TableCellBorders | null)[][];
  fontFamily: string;
  fontSize: number;
  fontColor: string;
  fontWeight: "normal" | "bold";
  fontStyle: "normal" | "italic";
  textDecoration: "none" | "underline";
  textAlign: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  // "freehand" only - the stroke's points, each a fraction (0-1) of this node's own width/height
  // rather than an absolute document-space coordinate. That's what lets a freehand node reuse
  // every other node kind's move/resize machinery for free: dragging the node just changes x/y
  // (the rendered points are always x + fx*width, y + fy*height), and resizing stretches the
  // drawing to fit the new box exactly like Board scales an image into its frame, rather than
  // needing a special "translate every point" or "rescale every point" code path of its own.
  points?: { x: number; y: number }[];
  // "freehand" only - an optional arrowhead capping the stroke's first/last point, oriented along
  // that end's own final tangent direction. What makes the "Freehand Arrow" toolbar preset (see
  // WhiteboardEditor.tsx's ARROW_PRESETS) a hand-drawn arrow rather than plain ink: same stroke,
  // same points, just with a marker on one end. Absent/"none" on a plain ink stroke.
  startArrowType?: ArrowheadType;
  endArrowType?: ArrowheadType;
}

// Which side of a node an edge attaches to - "auto" (the default for a new connection) means
// whiteboardHandlers.ts's resolveEndpointPoint recomputes the best side every render based on
// where the OTHER endpoint currently is, so an edge re-routes itself as nodes move instead of
// staying pinned to whatever side happened to face the target when it was first drawn.
export type WhiteboardAnchorSide = "top" | "right" | "bottom" | "left" | "auto";

// An edge endpoint is either attached to a node (nodeId set, x/y absent - the live point is
// derived every render) or floating at a fixed document-space point (nodeId absent, x/y set) -
// e.g. an arrow drawn from a shape out to empty canvas, annotating something with no node of its
// own. Never both: a node-attached endpoint always overrides whatever stale x/y it might carry
// from before it was attached.
export interface WhiteboardEndpoint {
  nodeId?: string;
  anchor?: WhiteboardAnchorSide;
  x?: number;
  y?: number;
}

// What decorates an edge's end - "none" leaves a bare line end, the rest are drawn at the
// endpoint pointing along the line's arrival direction (see whiteboardHandlers.ts's
// edgeEndAngleDeg). "triangle" is the classic filled arrowhead (draw.io's default); "triangleOpen"
// is the same silhouette but unfilled (just two stroked lines, no fill) - the "thin arrow" look;
// "block" is a wider filled triangle for more visual weight; "diamond" and "circle" are small
// filled markers, the UML-style "aggregation"/cardinality-dot look.
export type ArrowheadType = "none" | "triangle" | "triangleOpen" | "block" | "diamond" | "circle";

export interface WhiteboardEdge extends WhiteboardItemBase {
  kind: "edge";
  source: WhiteboardEndpoint;
  target: WhiteboardEndpoint;
  label: string;
  strokeColor: string;
  strokeWidth: number;
  strokeStyle: "solid" | "dashed" | "dotted";
  // "straight" draws one segment source->target; "orthogonal" (draw.io's default connector style)
  // routes it as one or two right-angle bends; "curved" is a smooth cubic-bezier route that still
  // leaves/arrives perpendicular to whichever side it's anchored on, just without the hard corners
  // - see whiteboardHandlers.ts's buildEdgePath for all three.
  routing: "straight" | "orthogonal" | "curved";
  // "curved" only, and only actually consulted for an end with no shape side to bow away from (a
  // free-floating point - see buildEdgePath/curveControlPoints) - which side the curve bows toward
  // and how far, roughly -1..1. Set once at creation time from the actual shape of the drag gesture
  // that drew it (see WhiteboardCanvas.tsx's computeCurveBowFromPath), so the curve bows the way it
  // was drawn instead of a fixed direction that ignores the gesture entirely. Absent on an edge
  // created with no such gesture to read (e.g. reattaching an existing edge's endpoint) - resolves
  // to whiteboardHandlers.ts's DEFAULT_CURVE_BOW.
  curveBow?: number;
  // Manually-added bend points, in order from source to target, absolute document-space
  // coordinates (edges aren't resizable boxes the way nodes are, so unlike WhiteboardNode.points
  // there's no box to express these as a fraction of). Absent/empty - the routing algorithm alone
  // decides the path, same as before this field existed. Dragging a point ON the rendered path
  // (see WhiteboardCanvas.tsx's beginNewWaypointDrag) inserts a new one here; dragging an existing
  // dot (beginWaypointDrag) moves it; double-clicking one removes it. "curved" routing smooths a
  // spline through source -> waypoints -> target (see whiteboardHandlers.ts's smoothPolylineD);
  // "straight"/"orthogonal" both fall back to sharp segments through the same points once any
  // waypoints exist - orthogonal's own auto right-angle-bend algorithm only applies when there are
  // none, since it and a user's own manual bends are two competing ways to shape the same line.
  waypoints?: { x: number; y: number }[];
  startArrowType: ArrowheadType;
  endArrowType: ArrowheadType;
}

export type WhiteboardItem = WhiteboardNode | WhiteboardEdge;

export type WhiteboardCommand =
  | { type: "add-node"; item: WhiteboardNode }
  // A node and one edge connecting it to an existing node, added together as ONE undo step - the
  // hover-arrow "quick clone + connect" gesture (see WhiteboardCanvas.tsx's HoverConnectArrows)
  // creates both at once and undoing it should be one step, not two. Unlike delete-node below, this
  // needs no special-casing in useWhiteboardStore's undo(): invertCommand can already express its
  // full inverse as an ordinary "delete-node" command (this node + this one edge), since both ids
  // are already right here on the command itself.
  | { type: "add-node-with-edge"; node: WhiteboardNode; edge: WhiteboardEdge }
  // Cascades: deleting a node also removes every edge attached to it, as ONE undo step - an edge
  // left pointing at a node id that no longer exists would have nothing left to resolve its
  // attached endpoint against.
  | { type: "delete-node"; item: WhiteboardNode; edges: WhiteboardEdge[] }
  | { type: "edit-node"; before: WhiteboardNode; after: WhiteboardNode }
  // Multiple nodes replaced at once as a single undo step - multi-selection drag/resize/style edit.
  | { type: "batch-edit-nodes"; before: WhiteboardNode[]; after: WhiteboardNode[] }
  | { type: "add-edge"; item: WhiteboardEdge }
  | { type: "delete-edge"; item: WhiteboardEdge }
  | { type: "edit-edge"; before: WhiteboardEdge; after: WhiteboardEdge }
  // Full replacement order for the whole nodes array - z-order (last = topmost), same convention
  // as boardTypes.ts's own 'reorder'. Used by "Bring to front" / "Send to back".
  | { type: "reorder-nodes"; before: WhiteboardNode[]; after: WhiteboardNode[] }
  // Clipboard paste - any number of nodes AND edges added together as ONE undo step (a multi-node
  // copy/paste, including whatever connectors ran between the copied nodes). Deliberately a
  // standalone pair with "delete-items" as its exact mirror (see invertCommand) rather than reusing
  // "delete-node"'s own node+edges shape the way undoDeleteNode does - that one is scoped to
  // exactly one node's own cascade-deleted edges, not an arbitrary set of both.
  | { type: "paste-items"; nodes: WhiteboardNode[]; edges: WhiteboardEdge[] }
  | { type: "delete-items"; nodes: WhiteboardNode[]; edges: WhiteboardEdge[] };

// One page's worth of diagram content - see this file's own top comment for why a whiteboard is a
// set of these rather than one flat nodes/edges pair.
export interface WhiteboardPage {
  id: string;
  name: string;
  // array order = z-order, last = topmost, same convention as boardTypes.ts's own `images`.
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
}

export const WHITEBOARD_SCHEMA_VERSION = 2 as const;

export interface WhiteboardDocument {
  version: typeof WHITEBOARD_SCHEMA_VERSION;
  id: string;
  name: string;
  showGrid: boolean;
  // Whether dragging/resizing a node, or dragging a free-floating connector endpoint/waypoint,
  // snaps to the same GRID_SIZE lattice showGrid's dots mark (see WhiteboardCanvas.tsx's
  // snapCoord/isSnapEnabled) - independent of showGrid itself, same "visibility vs. behavior are
  // two separate switches" convention draw.io's own Grid/Snap-to-Grid menu items use, so a user can
  // snap without the visual dots (a cleaner-looking export) or show the dots without snapping
  // (free-form sketching with just a visual reference). Absent on a document predating this field -
  // resolves to true (see useWhiteboardStore.ts's migrateDocument), matching showGrid's own
  // "on by default" treatment.
  snapToGrid: boolean;
  pages: WhiteboardPage[];
  // Not undo-tracked (see useWhiteboardStore.ts's setActivePage) - which page was open is a view
  // preference, not diagram content, same reasoning as showGrid.
  activePageId: string;
  createdAt: string;
  updatedAt: string;
}

// Frontend mirror of whiteboards.rs's WhiteboardSummary - snake_case to match the Rust struct's
// serde output exactly, same convention as boardTypes.ts's own BoardSummary.
export interface WhiteboardSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  thumbnail_path: string | null;
}

export function createEmptyWhiteboardPage(id: string, name: string): WhiteboardPage {
  return { id, name, nodes: [], edges: [] };
}

export function createEmptyWhiteboardDocument(id: string, name: string): WhiteboardDocument {
  const now = new Date().toISOString();
  const firstPage = createEmptyWhiteboardPage(crypto.randomUUID(), "Page 1");
  return {
    version: WHITEBOARD_SCHEMA_VERSION,
    id,
    name,
    showGrid: true,
    snapToGrid: true,
    pages: [firstPage],
    activePageId: firstPage.id,
    createdAt: now,
    updatedAt: now,
  };
}

const SHAPE_DEFAULT_SIZE: Record<WhiteboardShapeType, { width: number; height: number }> = {
  rectangle: { width: 160, height: 90 },
  ellipse: { width: 160, height: 100 },
  diamond: { width: 170, height: 110 },
  triangle: { width: 160, height: 130 },
  hexagon: { width: 180, height: 110 },
  parallelogram: { width: 180, height: 100 },
  cylinder: { width: 140, height: 130 },
  polygon: { width: 160, height: 150 },
  star: { width: 160, height: 150 },
  trapezoid: { width: 180, height: 100 },
  cross: { width: 140, height: 140 },
  cube: { width: 150, height: 150 },
  cloud: { width: 190, height: 120 },
  document: { width: 170, height: 110 },
  note: { width: 150, height: 130 },
  callout: { width: 170, height: 110 },
  step: { width: 190, height: 100 },
  wave: { width: 220, height: 90 },
  resistor: { width: 180, height: 60 },
  capacitor: { width: 140, height: 90 },
  spring: { width: 200, height: 70 },
  battery: { width: 140, height: 90 },
  flask: { width: 150, height: 170 },
  beaker: { width: 140, height: 150 },
  benzeneRing: { width: 160, height: 150 },
  axes: { width: 160, height: 160 },
  angle: { width: 170, height: 130 },
  hourglass: { width: 120, height: 140 },
  teardrop: { width: 120, height: 150 },
  lightningBolt: { width: 100, height: 160 },
  halfCircle: { width: 130, height: 130 },
  banner: { width: 180, height: 110 },
  frame: { width: 180, height: 140 },
  tape: { width: 180, height: 100 },
  display: { width: 180, height: 100 },
  predefinedProcess: { width: 170, height: 100 },
  manualInput: { width: 180, height: 110 },
  internalStorage: { width: 170, height: 120 },
  barChart: { width: 220, height: 160 },
  lineChart: { width: 220, height: 160 },
  pieChart: { width: 190, height: 190 },
  scatterPlot: { width: 220, height: 160 },
  functionPlot: { width: 200, height: 160 },
  graph: { width: 260, height: 200 },
  // Tall and wide - a stacked figure needs vertical room for the traces to separate and horizontal
  // room for the spectral detail, and starting it at another 220x160 chart tile would put 18 traces
  // in ~100px of plot area where they'd read as a solid block.
  waterfallChart: { width: 380, height: 420 },
  equation: { width: 220, height: 70 },
  vector: { width: 160, height: 40 },
  diode: { width: 160, height: 60 },
  inductor: { width: 180, height: 60 },
  ground: { width: 100, height: 90 },
  amplifier: { width: 160, height: 110 },
  // Wide - room for the 3D viewport AND its own side control panel side by side, matching the
  // reference layout (see LatticeGaugeWidget.tsx) - every other shape's default is sized for a
  // single glyph, not a two-pane app.
  latticeGauge: { width: 640, height: 460 },
  bondLine: { width: 200, height: 60 },
  unitCircle: { width: 200, height: 200 },
  numberLine: { width: 280, height: 60 },
  table: { width: 360, height: 180 },
  minusSign: { width: 140, height: 90 },
  multiplySign: { width: 140, height: 140 },
  divideSign: { width: 100, height: 140 },
  equalsSign: { width: 140, height: 100 },
  greaterThanSign: { width: 120, height: 140 },
  lessThanSign: { width: 120, height: 140 },
  greaterEqualSign: { width: 120, height: 170 },
  lessEqualSign: { width: 120, height: 170 },
  text: { width: 160, height: 40 },
  freehand: { width: 160, height: 160 },
  // Only a fallback - every real image node is created through createImageWhiteboardNode below,
  // which sizes the box to the source's own aspect ratio. This is what an "image" node would get if
  // one were ever created through the generic factory with no bitmap behind it (the toolbar preview
  // tile's placeholder glyph, for instance).
  image: { width: 240, height: 180 },
};

// The longest edge a freshly imported image's box starts at, in document units. A modern camera or
// screenshot is several thousand pixels across; dropping one in at its own natural size would place
// a node far larger than the visible canvas, leaving the user zoomed inside a wall of photo with no
// obvious way back out. Scaling the long edge down to this keeps the whole image on screen at a
// typical zoom while preserving its aspect ratio exactly - and since nothing is resampled, dragging
// a corner back out restores full detail.
export const DEFAULT_IMAGE_MAX_EDGE = 420;

export function createDefaultWhiteboardNode(
  id: string,
  shapeType: WhiteboardShapeType,
  x: number,
  y: number,
  overrides?: Partial<
    Pick<
      WhiteboardNode,
      | "sides"
      | "starPoints"
      | "starInnerRadiusRatio"
      | "waveStyle"
      | "waveCycles"
      | "angleDegrees"
      | "angleRay1Length"
      | "angleRay2Length"
      | "chartData"
      | "plotFunction"
      | "plotDomainScale"
      | "plotCycles"
      | "plotShowGrid"
      | "plotXTickInterval"
      | "plotYTickInterval"
      | "showChartLabels"
      | "numberLineMax"
      | "graphExpression"
      | "graphXMin"
      | "graphXMax"
      | "graphYMin"
      | "graphYMax"
      | "graphShowGrid"
      | "graphXTickInterval"
      | "graphYTickInterval"
      | "seriesData"
      | "seriesXMin"
      | "seriesXMax"
      | "seriesOffset"
      | "seriesColormap"
      | "seriesColorsReversed"
      | "seriesFillUnder"
      | "seriesShowBaselines"
      | "seriesShowGrid"
      | "chartTitle"
      | "axisXTitle"
      | "axisYTitle"
      | "tableRows"
      | "tableCols"
    >
  >
): WhiteboardNode {
  const now = Date.now();
  const size = SHAPE_DEFAULT_SIZE[shapeType];
  return {
    kind: "node",
    id,
    shapeType,
    x: x - size.width / 2,
    y: y - size.height / 2,
    width: size.width,
    height: size.height,
    // "equation" gets a real starting formula rather than blank - an empty math shape has nothing
    // to double-click-and-discover the way an empty text label's own placeholder hint already
    // covers, so showing something immediately is worth the (easily deleted) default text this is
    // the one shapeType where every other one intentionally starts blank.
    text: shapeType === "equation" ? "E = mc^2" : "",
    // "equation" keeps the SAME null/transparent fill every other blank-starting shape gets, but
    // (unlike them) its own body is actually rendered now (see WhiteboardCanvas.tsx's own div for
    // "rectangle"/"equation") - a card/background/corner-radius around the formula, entirely
    // opt-in via the style panel's Fill/Stroke/Corner radius fields.
    fillColor: shapeType === "text" || shapeType === "equation" || shapeType === "freehand" || LINE_ONLY_SHAPES.has(shapeType) ? null : "#ffffff",
    strokeColor: shapeType === "freehand" ? "#111111" : "#000000",
    // 0 rather than the usual 2 - a fresh equation should still look like just the formula (no
    // border) until the user deliberately turns Stroke width up in the style panel, not gain a
    // visible box around it the instant it becomes possible to have one.
    // A stacked figure draws dozens of overlapping traces - at the usual 2 they merge into a solid
    // block, so a waterfall starts at the thin line weight a real spectral figure uses.
    strokeWidth: shapeType === "equation" ? 0 : shapeType === "waterfallChart" ? 1.2 : 2,
    cornerRadius: 0,
    // "bondLine" reuses `sides` for its own one number (how many zigzag bonds/segments) - same
    // "no dedicated field for a shape that only needs one integer" convention "polygon" already
    // set for its own side count.
    sides: shapeType === "polygon" ? overrides?.sides ?? 5 : shapeType === "bondLine" ? overrides?.sides ?? 5 : undefined,
    starPoints: shapeType === "star" ? overrides?.starPoints ?? 5 : undefined,
    starInnerRadiusRatio: shapeType === "star" ? overrides?.starInnerRadiusRatio ?? 0.45 : undefined,
    waveStyle: shapeType === "wave" ? overrides?.waveStyle ?? "sine" : undefined,
    waveCycles: shapeType === "wave" ? overrides?.waveCycles ?? 2 : undefined,
    angleDegrees: shapeType === "angle" ? overrides?.angleDegrees ?? 50 : undefined,
    angleRay1Length: shapeType === "angle" ? overrides?.angleRay1Length ?? 1 : undefined,
    angleRay2Length: shapeType === "angle" ? overrides?.angleRay2Length ?? 1 : undefined,
    chartData: CHART_DATA_SHAPES.has(shapeType) ? overrides?.chartData ?? DEFAULT_CHART_DATA : undefined,
    plotFunction: shapeType === "functionPlot" ? overrides?.plotFunction ?? "sine" : undefined,
    plotDomainScale: shapeType === "functionPlot" ? overrides?.plotDomainScale ?? 1 : undefined,
    plotCycles: shapeType === "functionPlot" ? overrides?.plotCycles ?? 2 : undefined,
    plotShowGrid: shapeType === "functionPlot" ? overrides?.plotShowGrid ?? false : undefined,
    plotXTickInterval: shapeType === "functionPlot" ? overrides?.plotXTickInterval : undefined,
    plotYTickInterval: shapeType === "functionPlot" ? overrides?.plotYTickInterval : undefined,
    showChartLabels: CHART_LABEL_SHAPES.has(shapeType) ? overrides?.showChartLabels ?? true : undefined,
    numberLineMax: shapeType === "numberLine" ? overrides?.numberLineMax ?? 10 : undefined,
    // Literal defaults here (rather than importing whiteboardHandlers.ts's own
    // DEFAULT_GRAPH_EXPRESSION/DEFAULT_GRAPH_X_MIN/DEFAULT_GRAPH_X_MAX) match every other chart
    // field's own "hardcoded literal, not an imported constant" convention above (e.g.
    // plotFunction's "sine", numberLineMax's 10) - this file is imported BY whiteboardHandlers.ts,
    // so importing back from it would be circular.
    graphExpression: shapeType === "graph" ? overrides?.graphExpression ?? "sin(x)" : undefined,
    graphXMin: shapeType === "graph" ? overrides?.graphXMin ?? -10 : undefined,
    graphXMax: shapeType === "graph" ? overrides?.graphXMax ?? 10 : undefined,
    graphYMin: shapeType === "graph" ? overrides?.graphYMin : undefined,
    graphYMax: shapeType === "graph" ? overrides?.graphYMax : undefined,
    graphShowGrid: shapeType === "graph" ? overrides?.graphShowGrid ?? true : undefined,
    graphXTickInterval: shapeType === "graph" ? overrides?.graphXTickInterval : undefined,
    graphYTickInterval: shapeType === "graph" ? overrides?.graphYTickInterval : undefined,
    // Seeded with the sample stack (not left absent) so the node saves as a self-contained figure a
    // user can immediately edit trace-by-trace, rather than one that silently re-reads a module
    // constant every render and would change under them if that constant ever did.
    seriesData: shapeType === "waterfallChart" ? overrides?.seriesData ?? DEFAULT_WATERFALL_SERIES.map((t) => [...t]) : undefined,
    seriesXMin: shapeType === "waterfallChart" ? overrides?.seriesXMin : undefined,
    seriesXMax: shapeType === "waterfallChart" ? overrides?.seriesXMax : undefined,
    seriesOffset: shapeType === "waterfallChart" ? overrides?.seriesOffset ?? DEFAULT_SERIES_OFFSET : undefined,
    seriesColormap: shapeType === "waterfallChart" ? overrides?.seriesColormap ?? DEFAULT_COLORMAP : undefined,
    seriesColorsReversed: shapeType === "waterfallChart" ? overrides?.seriesColorsReversed ?? false : undefined,
    seriesFillUnder: shapeType === "waterfallChart" ? overrides?.seriesFillUnder ?? false : undefined,
    seriesShowBaselines: shapeType === "waterfallChart" ? overrides?.seriesShowBaselines ?? false : undefined,
    seriesShowGrid: shapeType === "waterfallChart" ? overrides?.seriesShowGrid ?? false : undefined,
    chartTitle: CHART_AXIS_TITLE_SHAPES.has(shapeType) ? overrides?.chartTitle : undefined,
    axisXTitle: CHART_AXIS_TITLE_SHAPES.has(shapeType) ? overrides?.axisXTitle : undefined,
    axisYTitle: CHART_AXIS_TITLE_SHAPES.has(shapeType) ? overrides?.axisYTitle : undefined,
    latticeSize: shapeType === "latticeGauge" ? DEFAULT_LATTICE_SIZE : undefined,
    latticeSiteSpacing: shapeType === "latticeGauge" ? DEFAULT_LATTICE_SITE_SPACING : undefined,
    latticeShowQuarks: shapeType === "latticeGauge" ? true : undefined,
    latticeShowGluons: shapeType === "latticeGauge" ? true : undefined,
    latticeAnimateFlux: shapeType === "latticeGauge" ? true : undefined,
    latticeTeachingMode: shapeType === "latticeGauge" ? "free" : undefined,
    tableRows: shapeType === "table" ? overrides?.tableRows ?? DEFAULT_TABLE_ROWS : undefined,
    tableCols: shapeType === "table" ? overrides?.tableCols ?? DEFAULT_TABLE_COLS : undefined,
    tableColWidths:
      shapeType === "table" ? Array(overrides?.tableCols ?? DEFAULT_TABLE_COLS).fill(1 / (overrides?.tableCols ?? DEFAULT_TABLE_COLS)) : undefined,
    tableRowHeights:
      shapeType === "table" ? Array(overrides?.tableRows ?? DEFAULT_TABLE_ROWS).fill(1 / (overrides?.tableRows ?? DEFAULT_TABLE_ROWS)) : undefined,
    tableCellText:
      shapeType === "table"
        ? Array.from({ length: overrides?.tableRows ?? DEFAULT_TABLE_ROWS }, () => Array(overrides?.tableCols ?? DEFAULT_TABLE_COLS).fill(""))
        : undefined,
    tableHeaderRow: shapeType === "table" ? true : undefined,
    fontFamily: "system-ui, sans-serif",
    // Tick numbers and axis captions on a dense multi-panel figure - 16 (every other shape's label
    // size) overwhelms a plot this size, where the text is scaffolding around the data rather than
    // the content itself.
    fontSize: shapeType === "waterfallChart" ? 11 : 16,
    fontColor: "#111111",
    fontWeight: "normal",
    fontStyle: "normal",
    textDecoration: "none",
    textAlign: "center",
    // "vector" defaults its optional magnitude label ABOVE the line rather than centered on/through
    // it - "middle" would visually collide with the arrow itself for the thin box a vector starts
    // at (see SHAPE_DEFAULT_SIZE).
    verticalAlign: shapeType === "vector" ? "top" : "middle",
    // Only "vector" sets these here - "freehand" gets its own via createFreehandWhiteboardNode, and
    // every other shapeType leaves them undefined (meaningless off a vector/freehand node).
    startArrowType: shapeType === "vector" ? "none" : undefined,
    endArrowType: shapeType === "vector" ? "triangle" : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

// Builds an image node centered on (x, y), with its box scaled to the source's own aspect ratio
// (capped at DEFAULT_IMAGE_MAX_EDGE on the long edge). Its own factory rather than an overrides
// argument to createDefaultWhiteboardNode, exactly like createFreehandWhiteboardNode: both derive
// their geometry from real content rather than a fixed per-shapeType default size, which is the one
// thing that generic factory can't express.
export function createImageWhiteboardNode(
  id: string,
  assetFileName: string,
  naturalWidth: number,
  naturalHeight: number,
  centerX: number,
  centerY: number
): WhiteboardNode {
  const now = Date.now();
  const safeW = Number.isFinite(naturalWidth) && naturalWidth > 0 ? naturalWidth : 1;
  const safeH = Number.isFinite(naturalHeight) && naturalHeight > 0 ? naturalHeight : 1;
  const scale = Math.min(1, DEFAULT_IMAGE_MAX_EDGE / Math.max(safeW, safeH));
  const width = Math.max(1, Math.round(safeW * scale));
  const height = Math.max(1, Math.round(safeH * scale));
  return {
    kind: "node",
    id,
    shapeType: "image",
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    text: "",
    assetFileName,
    naturalWidth: safeW,
    naturalHeight: safeH,
    imageFit: "cover",
    imageMask: "rect",
    imageOpacity: 1,
    // No ring and no matte out of the box - an imported photo should look like the photo, with the
    // border/mask treatments available in the style panel rather than applied uncommanded.
    fillColor: null,
    strokeColor: "#000000",
    strokeWidth: 0,
    cornerRadius: 0,
    fontFamily: "system-ui, sans-serif",
    fontSize: 16,
    fontColor: "#111111",
    fontWeight: "normal",
    fontStyle: "normal",
    textDecoration: "none",
    textAlign: "center",
    verticalAlign: "middle",
    createdAt: now,
    updatedAt: now,
  };
}

// The source rectangle an "image" node actually shows, resolved to safe fractions. Every reader
// (the live <img> transform, the Canvas2D export's drawImage source rect, the style panel's crop
// readout) goes through this rather than reading imageCropX/Y/W/H directly, so a malformed or stale
// crop - inverted, zero-sized, out of bounds, left over from a since-replaced source - can never
// produce a NaN transform or an exception inside drawImage. Same "resolve absent/stale data at read
// time" convention resolveTableGrid and resolveSeriesData already follow.
export function resolveImageCrop(node: WhiteboardNode): { x: number; y: number; w: number; h: number } {
  const clamp01 = (v: number | undefined, fallback: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v as number)) : fallback);
  const x = clamp01(node.imageCropX, 0);
  const y = clamp01(node.imageCropY, 0);
  // A crop can never extend past the source's own right/bottom edge, and can never be zero-width -
  // a zero-width source rect makes drawImage throw rather than draw nothing.
  const w = Math.max(0.001, Math.min(1 - x, clamp01(node.imageCropW, 1)));
  const h = Math.max(0.001, Math.min(1 - y, clamp01(node.imageCropH, 1)));
  return { x, y, w, h };
}

// Whether this node's crop is the whole image - lets the style panel show "Reset crop" only when
// there is actually a crop to reset.
export function hasImageCrop(node: WhiteboardNode): boolean {
  const c = resolveImageCrop(node);
  return c.x > 0 || c.y > 0 || c.w < 1 || c.h < 1;
}

// The node box that shows this image's CROPPED region at its natural pixel size - what "Reset to
// natural size" restores. Returns null for a node with no measured source (an asset that failed to
// decode), where there is no natural size to reset to.
export function naturalImageSize(node: WhiteboardNode): { width: number; height: number } | null {
  if (!node.naturalWidth || !node.naturalHeight) return null;
  const crop = resolveImageCrop(node);
  return { width: Math.max(1, Math.round(node.naturalWidth * crop.w)), height: Math.max(1, Math.round(node.naturalHeight * crop.h)) };
}

const FREEHAND_MIN_SIZE = 8;

// Builds a freehand node from a raw drag gesture's collected document-space points - computes the
// stroke's own bounding box for the node's x/y/width/height, then re-expresses every point as a
// 0-1 fraction of that box (see WhiteboardNode.points's own doc comment for why).
export function createFreehandWhiteboardNode(id: string, rawPoints: { x: number; y: number }[]): WhiteboardNode {
  const now = Date.now();
  const xs = rawPoints.map((p) => p.x);
  const ys = rawPoints.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(FREEHAND_MIN_SIZE, Math.max(...xs) - minX);
  const height = Math.max(FREEHAND_MIN_SIZE, Math.max(...ys) - minY);
  return {
    kind: "node",
    id,
    shapeType: "freehand",
    x: minX,
    y: minY,
    width,
    height,
    text: "",
    fillColor: null,
    strokeColor: "#111111",
    strokeWidth: 2.5,
    cornerRadius: 0,
    fontFamily: "system-ui, sans-serif",
    fontSize: 16,
    fontColor: "#111111",
    fontWeight: "normal",
    fontStyle: "normal",
    textDecoration: "none",
    textAlign: "center",
    verticalAlign: "middle",
    points: rawPoints.map((p) => ({ x: (p.x - minX) / width, y: (p.y - minY) / height })),
    startArrowType: "none",
    endArrowType: "none",
    createdAt: now,
    updatedAt: now,
  };
}

export interface ResolvedTableGrid {
  rows: number;
  cols: number;
  colWidths: number[]; // fractions of node.width, length === cols, sums to 1
  rowHeights: number[]; // fractions of node.height, length === rows, sums to 1
  cellText: string[][]; // [row][col], always exactly rows x cols
  mergedCells: TableMergedCell[]; // clamped to fit within [0,rows) x [0,cols)
  cellFill: (string | null)[][]; // [row][col], always exactly rows x cols; null = table's own fillColor
  cellBorders: TableCellBorders[][]; // [row][col], always exactly rows x cols; {} = every side default
}

// The one place a "table" node's own fields get resolved into a definitely-consistent grid - every
// reader (WhiteboardTable.tsx's live rendering/editing, WhiteboardStylePanel.tsx's row/column
// steppers, whiteboardHandlers.ts's Canvas2D export) goes through this rather than reading
// tableRows/tableColWidths/tableCellText off the node directly, so a stale/malformed array (missing
// entirely, wrong length after a row/column count changed some other way, a non-finite fraction)
// can never desync one reader from another or throw - it just falls back to an even split / an
// empty cell, the same "resolve absent/stale data at read time" convention every other optional
// field on this type already follows.
export function resolveTableGrid(node: WhiteboardNode): ResolvedTableGrid {
  const rows = Math.max(MIN_TABLE_ROWS, Math.min(MAX_TABLE_ROWS, Math.round(node.tableRows ?? DEFAULT_TABLE_ROWS)));
  const cols = Math.max(MIN_TABLE_COLS, Math.min(MAX_TABLE_COLS, Math.round(node.tableCols ?? DEFAULT_TABLE_COLS)));
  const normalize = (fractions: number[] | undefined, count: number): number[] => {
    const valid = fractions && fractions.length === count && fractions.every((f) => Number.isFinite(f) && f > 0);
    const source = valid ? fractions! : Array(count).fill(1 / count);
    const sum = source.reduce((a, b) => a + b, 0);
    return source.map((f) => f / sum);
  };
  const colWidths = normalize(node.tableColWidths, cols);
  const rowHeights = normalize(node.tableRowHeights, rows);
  const cellText = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => node.tableCellText?.[r]?.[c] ?? ""));
  // Clamped to valid bounds AND, beyond that, defensively de-overlapped: two merges can never
  // legally share a cell (each cell has exactly one anchor, or none), but a bug somewhere upstream
  // - or a hand-edited/imported document - could still leave two overlapping entries in
  // tableMergedCells on disk. Rather than let that corrupt the whole render (two merges both trying
  // to claim the same cell breaks the anchor/covered bookkeeping every reader of this grid depends
  // on), earlier entries win and any later entry that would claim an already-claimed cell is simply
  // dropped - same "resolve bad data at read time rather than crash or misrender" treatment every
  // other field on this type already gets. The very next structural edit through
  // WhiteboardTable.tsx's own commitEditState (which always writes back THIS function's own output)
  // permanently heals the stored data too, since it never re-reads the raw, unclamped node field.
  const claimedCells = new Set<string>();
  const mergedCells: TableMergedCell[] = [];
  for (const m of node.tableMergedCells ?? []) {
    const row = Math.max(0, Math.min(rows - 1, Math.round(m.row)));
    const col = Math.max(0, Math.min(cols - 1, Math.round(m.col)));
    const rowSpan = Math.max(1, Math.min(Math.round(m.rowSpan), rows - row));
    const colSpan = Math.max(1, Math.min(Math.round(m.colSpan), cols - col));
    if (rowSpan <= 1 && colSpan <= 1) continue;
    let conflict = false;
    for (let rr = row; rr < row + rowSpan && !conflict; rr++) for (let cc = col; cc < col + colSpan; cc++) if (claimedCells.has(`${rr}-${cc}`)) conflict = true;
    if (conflict) continue;
    for (let rr = row; rr < row + rowSpan; rr++) for (let cc = col; cc < col + colSpan; cc++) claimedCells.add(`${rr}-${cc}`);
    mergedCells.push({ row, col, rowSpan, colSpan });
  }
  const cellFill = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => node.tableCellFill?.[r]?.[c] ?? null));
  const cellBorders = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => node.tableCellBorders?.[r]?.[c] ?? {}));
  return { rows, cols, colWidths, rowHeights, cellText, mergedCells, cellFill, cellBorders };
}

// Shifts/grows every merged region when a new row/column is inserted at `index` - a region entirely
// AFTER the insertion point slides down/right by one; a region the insertion point falls INSIDE
// (splitting it) instead grows by one along that axis, so a merge stays intact around content
// that's now one row/column bigger, matching how a plain (unmerged) row/column's own width/height
// fraction array already grows via insertTableFraction. Regions entirely BEFORE are untouched.
export function adjustMergesForInsert(merges: TableMergedCell[], axis: "row" | "col", index: number): TableMergedCell[] {
  return merges.map((m) => {
    if (axis === "row") {
      if (index < m.row) return { ...m, row: m.row + 1 };
      if (index < m.row + m.rowSpan) return { ...m, rowSpan: m.rowSpan + 1 };
      return m;
    }
    if (index < m.col) return { ...m, col: m.col + 1 };
    if (index < m.col + m.colSpan) return { ...m, colSpan: m.colSpan + 1 };
    return m;
  });
}

// Inverse of adjustMergesForInsert - a region entirely AFTER the removed row/column slides back
// up/left by one; a region the removed row/column falls INSIDE shrinks by one along that axis
// (dropped entirely, via the caller's own resolveTableGrid/insert-remove plumbing, if that shrinks
// it down to a plain 1x1 "merge" - see this function's own filter removing exactly that case).
export function adjustMergesForRemove(merges: TableMergedCell[], axis: "row" | "col", index: number): TableMergedCell[] {
  return merges
    .map((m) => {
      if (axis === "row") {
        if (index < m.row) return { ...m, row: m.row - 1 };
        if (index < m.row + m.rowSpan) return { ...m, rowSpan: m.rowSpan - 1 };
        return m;
      }
      if (index < m.col) return { ...m, col: m.col - 1 };
      if (index < m.col + m.colSpan) return { ...m, colSpan: m.colSpan - 1 };
      return m;
    })
    .filter((m) => m.rowSpan > 0 && m.colSpan > 0 && (m.rowSpan > 1 || m.colSpan > 1));
}

// Replaces the background fill for every cell in `range` (inclusive row/col bounds) - shared by
// WhiteboardStylePanel.tsx's "Cell background" swatch (the only current caller: it lifts the
// active cell/row/column range up from WhiteboardTable.tsx - see that component's own onRangeChange
// prop - since the style panel has no selection concept of its own below "which node") and, in
// principle, any future caller that needs the same "paint this rectangle of cells" operation.
export function withRangeFill(node: WhiteboardNode, range: { r0: number; c0: number; r1: number; c1: number }, color: string | null): Partial<WhiteboardNode> {
  const grid = resolveTableGrid(node);
  const next = grid.cellFill.map((row) => [...row]);
  for (let r = range.r0; r <= range.r1; r++) for (let c = range.c0; c <= range.c1; c++) if (next[r]?.[c] !== undefined) next[r][c] = color;
  return { tableCellFill: next };
}

// Sets one border SIDE's line style for every cell in `range` - same "style panel acts on the range
// lifted up from WhiteboardTable.tsx" reasoning as withRangeFill above. Selecting a whole row/column
// via its own selector handle (see WhiteboardTable.tsx) before calling this is what lets "dash the
// bottom edge of this whole row" read as one action instead of per-cell fiddling.
export function withRangeBorderSide(
  node: WhiteboardNode,
  range: { r0: number; c0: number; r1: number; c1: number },
  side: "top" | "right" | "bottom" | "left",
  style: TableBorderStyle
): Partial<WhiteboardNode> {
  const grid = resolveTableGrid(node);
  const next = grid.cellBorders.map((row) => row.map((cell) => ({ ...cell })));
  for (let r = range.r0; r <= range.r1; r++) for (let c = range.c0; c <= range.c1; c++) if (next[r]?.[c]) next[r][c][side] = style;
  return { tableCellBorders: next };
}

// Inserts a new fraction at `index` sized to the average of the existing ones, rescaling the whole
// array (including the new entry) back down so it still sums to 1 - shared by WhiteboardTable.tsx
// (inserting a row/column at a specific position) and WhiteboardStylePanel.tsx (its rows/columns
// stepper, which always inserts/removes at the end) so a freshly inserted row/column starts a
// reasonable size instead of 0 (invisible) or 1 (crushing every other row/column to nothing).
export function insertTableFraction(fractions: number[], index: number): number[] {
  const avg = 1 / (fractions.length + 1);
  const next = [...fractions];
  next.splice(index, 0, avg);
  const sum = next.reduce((a, b) => a + b, 0);
  return next.map((f) => f / sum);
}

// Removes the fraction at `index`, redistributing its share proportionally across the rest (a wide
// column absorbs proportionally more of a deleted neighbor's width than a narrow one does) rather
// than resetting every remaining row/column to an equal split, which would throw away any
// deliberate resizing already done elsewhere in the table.
export function removeTableFraction(fractions: number[], index: number): number[] {
  const next = fractions.filter((_, i) => i !== index);
  const sum = next.reduce((a, b) => a + b, 0);
  return sum > 0 ? next.map((f) => f / sum) : next.map(() => 1 / next.length);
}

export function createDefaultWhiteboardEdge(id: string, source: WhiteboardEndpoint, target: WhiteboardEndpoint): WhiteboardEdge {
  const now = Date.now();
  return {
    kind: "edge",
    id,
    source,
    target,
    label: "",
    strokeColor: "#374151",
    strokeWidth: 2,
    strokeStyle: "solid",
    routing: "orthogonal",
    startArrowType: "none",
    endArrowType: "triangle",
    createdAt: now,
    updatedAt: now,
  };
}
