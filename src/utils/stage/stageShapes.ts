// utils/stage/stageShapes.ts
//
// The shapes a Stage shape (or a picture's mask) can take. Each is drawn on the GPU by its signed
// distance (stageRenderer's box shader): a rectangle with rounded corners, an ellipse, a ring or arc
// (round or flat ends), a pie slice or donut, or any outline given as a polygon - worked out here,
// at the box's exact size, so a triangle stretched wide is still exact at its edge, with corners
// rounded by insetting the outline and growing it back (convex corners round, concave ones stay
// crisp). Between beats the corner radius, the inner ratio (a star's depth, a ring's thickness, an
// arrow's shaft) and a ring's or pie's sweep spring like any number; a change of form morphs - the
// two distances blended, so a square flows into a circle into a star.
//
// The panel draws its thumbnails from the same outlines (formSvgPath), so what's picked is what's drawn.

export type ShapeForm =
  | "rect"
  | "ellipse"
  | "triangle"
  | "right-triangle"
  | "diamond"
  | "polygon"
  | "star"
  | "heart"
  | "plus"
  | "arrow"
  | "double-arrow"
  | "chevron"
  | "ring"
  | "pie"
  | "bubble"
  | "parallelogram"
  | "trapezoid";

// How the GPU draws a form: 0 rounded rectangle, 1 ellipse, 2 polygon, 3 ring/arc, 4 pie/donut.
export const FORM_KIND: Record<ShapeForm, 0 | 1 | 2 | 3 | 4> = {
  rect: 0,
  ellipse: 1,
  triangle: 2,
  "right-triangle": 2,
  diamond: 2,
  polygon: 2,
  star: 2,
  heart: 2,
  plus: 2,
  arrow: 2,
  "double-arrow": 2,
  chevron: 2,
  ring: 3,
  pie: 4,
  bubble: 2,
  parallelogram: 2,
  trapezoid: 2,
};

// The most points an outline may have (the shader's array size).
export const MAX_VERTS = 64;

// What `inner` means for a form, its default, and its range - and whether `sides` and `sweep` apply.
export interface FormInfo {
  inner?: { label: string; default: number; min: number; max: number; hint: string };
  sides?: { label: string; default: number; min: number; max: number };
  sweep?: boolean;
  corners?: boolean;
}

export const FORM_INFO: Record<ShapeForm, FormInfo> = {
  rect: { corners: true },
  ellipse: {},
  triangle: { corners: true },
  "right-triangle": { corners: true },
  diamond: { corners: true },
  polygon: { corners: true, sides: { label: "Sides", default: 6, min: 3, max: 24 } },
  star: { corners: true, sides: { label: "Points", default: 5, min: 3, max: 24 }, inner: { label: "Depth", default: 0.5, min: 0.1, max: 0.95, hint: "How far in the points go - low for a sharp star, high for a soft burst" } },
  heart: {},
  plus: { corners: true, inner: { label: "Thickness", default: 0.34, min: 0.06, max: 0.9, hint: "How thick its bars are" } },
  arrow: { corners: true, inner: { label: "Shaft", default: 0.45, min: 0.08, max: 1, hint: "How thick the shaft is, against the head" } },
  "double-arrow": { corners: true, inner: { label: "Shaft", default: 0.45, min: 0.08, max: 1, hint: "How thick the shaft is, against the heads" } },
  chevron: { corners: true, inner: { label: "Depth", default: 0.4, min: 0.05, max: 0.95, hint: "How deep its notch and point are" } },
  ring: { sweep: true, inner: { label: "Hole", default: 0.72, min: 0, max: 0.98, hint: "How big the hole is - its thickness is what's left" } },
  pie: { sweep: true, inner: { label: "Hole", default: 0, min: 0, max: 0.95, hint: "A hole in the middle makes a donut slice" } },
  bubble: { corners: true },
  parallelogram: { corners: true, inner: { label: "Slant", default: 0.25, min: 0, max: 0.9, hint: "How far it leans" } },
  trapezoid: { corners: true, inner: { label: "Taper", default: 0.25, min: 0, max: 0.95, hint: "How much narrower its top is" } },
};

// The gallery: named starting points (a form and its settings), in the order the panel shows them.
export interface ShapePreset {
  id: string;
  label: string;
  form: ShapeForm;
  sides?: number;
  inner?: number;
  sweep?: number;
  // Corner radius as a fraction of the shorter side (0.5: fully round ends).
  round?: number;
  // A good box for it, stage units.
  w: number;
  h: number;
}

export const SHAPE_PRESETS: ShapePreset[] = [
  { id: "rect", label: "Rectangle", form: "rect", w: 320, h: 200 },
  { id: "rounded", label: "Rounded", form: "rect", round: 0.14, w: 320, h: 200 },
  { id: "pill", label: "Pill", form: "rect", round: 0.5, w: 360, h: 110 },
  { id: "circle", label: "Circle", form: "ellipse", w: 220, h: 220 },
  { id: "ellipse", label: "Ellipse", form: "ellipse", w: 320, h: 200 },
  { id: "triangle", label: "Triangle", form: "triangle", w: 240, h: 210 },
  { id: "right-triangle", label: "Right triangle", form: "right-triangle", w: 240, h: 210 },
  { id: "diamond", label: "Diamond", form: "diamond", w: 220, h: 260 },
  { id: "pentagon", label: "Pentagon", form: "polygon", sides: 5, w: 230, h: 220 },
  { id: "hexagon", label: "Hexagon", form: "polygon", sides: 6, w: 250, h: 220 },
  { id: "octagon", label: "Octagon", form: "polygon", sides: 8, w: 230, h: 230 },
  { id: "star", label: "Star", form: "star", sides: 5, inner: 0.45, w: 240, h: 230 },
  { id: "burst", label: "Burst", form: "star", sides: 14, inner: 0.78, w: 240, h: 240 },
  { id: "heart", label: "Heart", form: "heart", w: 240, h: 220 },
  { id: "plus", label: "Plus", form: "plus", inner: 0.34, w: 200, h: 200 },
  { id: "arrow", label: "Arrow", form: "arrow", inner: 0.45, w: 320, h: 160 },
  { id: "double-arrow", label: "Double arrow", form: "double-arrow", inner: 0.45, w: 360, h: 150 },
  { id: "chevron", label: "Chevron", form: "chevron", inner: 0.4, w: 240, h: 200 },
  { id: "ring", label: "Ring", form: "ring", inner: 0.72, sweep: 360, w: 240, h: 240 },
  { id: "arc", label: "Progress arc", form: "ring", inner: 0.78, sweep: 270, w: 240, h: 240 },
  { id: "pie", label: "Pie slice", form: "pie", sweep: 270, w: 240, h: 240 },
  { id: "donut", label: "Donut slice", form: "pie", inner: 0.55, sweep: 240, w: 240, h: 240 },
  { id: "semicircle", label: "Half circle", form: "pie", sweep: 180, w: 240, h: 240 },
  { id: "bubble", label: "Speech bubble", form: "bubble", round: 0.16, w: 340, h: 230 },
  { id: "parallelogram", label: "Parallelogram", form: "parallelogram", inner: 0.25, w: 320, h: 180 },
  { id: "trapezoid", label: "Trapezoid", form: "trapezoid", inner: 0.3, w: 300, h: 190 },
];

export const formDefaults = (form: ShapeForm) => ({
  inner: FORM_INFO[form].inner?.default ?? 0,
  sides: FORM_INFO[form].sides?.default ?? 0,
  sweep: 360,
});

type Pt = [number, number];

// A regular outline (polygon or star) stretched to fill the w x h box exactly, centred.
function fitted(points: Pt[], w: number, h: number): Pt[] {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of points) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
  const sx = w / (x1 - x0 || 1);
  const sy = h / (y1 - y0 || 1);
  return points.map(([x, y]) => [(x - (x0 + x1) / 2) * sx, (y - (y0 + y1) / 2) * sy]);
}

// A form's outline, centred on the box's middle (y down), before rounding. Null for the forms the
// GPU draws directly (rect, ellipse, ring, pie).
export function formOutline(form: ShapeForm, w: number, h: number, sides: number, inner: number, opts: { flipX?: boolean; flipY?: boolean; tail?: number; round?: number } = {}): Pt[] | null {
  const hw = w / 2;
  const hh = h / 2;
  let pts: Pt[];
  switch (form) {
    case "triangle":
      pts = [[0, -hh], [hw, hh], [-hw, hh]];
      break;
    case "right-triangle":
      pts = [[-hw, -hh], [hw, hh], [-hw, hh]];
      break;
    case "diamond":
      pts = [[0, -hh], [hw, 0], [0, hh], [-hw, 0]];
      break;
    case "polygon": {
      const n = Math.max(3, Math.min(24, Math.round(sides || 6)));
      const unit: Pt[] = [];
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        unit.push([Math.cos(a), Math.sin(a)]);
      }
      pts = fitted(unit, w, h);
      break;
    }
    case "star": {
      const n = Math.max(3, Math.min(24, Math.round(sides || 5)));
      const unit: Pt[] = [];
      for (let i = 0; i < n * 2; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / n;
        const r = i % 2 === 0 ? 1 : Math.max(0.05, Math.min(0.98, inner));
        unit.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      pts = fitted(unit, w, h);
      break;
    }
    case "heart": {
      const unit: Pt[] = [];
      const n = 60;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * 2 * Math.PI;
        unit.push([16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);
      }
      pts = fitted(unit, w, h);
      break;
    }
    case "plus": {
      const tx = (Math.max(0.02, Math.min(0.98, inner)) * w) / 2;
      const ty = (Math.max(0.02, Math.min(0.98, inner)) * h) / 2;
      pts = [[-tx, -hh], [tx, -hh], [tx, -ty], [hw, -ty], [hw, ty], [tx, ty], [tx, hh], [-tx, hh], [-tx, ty], [-hw, ty], [-hw, -ty], [-tx, -ty]];
      break;
    }
    case "arrow": {
      const t = (Math.max(0.04, Math.min(1, inner)) * h) / 2;
      const head = Math.min(w * 0.55, h * 0.8);
      pts = [[-hw, -t], [hw - head, -t], [hw - head, -hh], [hw, 0], [hw - head, hh], [hw - head, t], [-hw, t]];
      break;
    }
    case "double-arrow": {
      const t = (Math.max(0.04, Math.min(1, inner)) * h) / 2;
      const head = Math.min(w * 0.3, h * 0.8);
      pts = [[-hw, 0], [-hw + head, -hh], [-hw + head, -t], [hw - head, -t], [hw - head, -hh], [hw, 0], [hw - head, hh], [hw - head, t], [-hw + head, t], [-hw + head, hh]];
      break;
    }
    case "chevron": {
      const d = Math.max(0.02, Math.min(0.98, inner)) * w * 0.5;
      pts = [[-hw, -hh], [hw - d, -hh], [hw, 0], [hw - d, hh], [-hw, hh], [-hw + d, 0]];
      break;
    }
    case "parallelogram": {
      const s = Math.max(0, Math.min(0.95, inner)) * w * 0.5;
      pts = [[-hw + s, -hh], [hw, -hh], [hw - s, hh], [-hw, hh]];
      break;
    }
    case "trapezoid": {
      const s = Math.max(0, Math.min(0.98, inner)) * w * 0.5;
      pts = [[-hw + s, -hh], [hw - s, -hh], [hw, hh], [-hw, hh]];
      break;
    }
    case "bubble": {
      // A rounded body over the bottom 78% less a tail, the tail's tip at the bottom.
      const bodyH = h * 0.78;
      const top = -hh;
      const bottom = top + bodyH;
      const r = Math.max(0, Math.min(opts.round ?? 0, bodyH / 2, hw));
      const tailX = -hw + w * Math.max(0.15, Math.min(0.85, opts.tail ?? 0.28));
      const tw = Math.min(w * 0.14, bodyH * 0.35);
      pts = [];
      const arc = (cx: number, cy: number, a0: number) => {
        const steps = r > 0 ? 6 : 0;
        if (!steps) return void pts.push([cx, cy]);
        for (let i = 0; i <= steps; i++) {
          const a = a0 + (i / steps) * (Math.PI / 2);
          pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
      };
      // Clockwise from the top-left corner (y down).
      arc(-hw + r, top + r, Math.PI);
      arc(hw - r, top + r, -Math.PI / 2);
      arc(hw - r, bottom - r, 0);
      pts.push([tailX + tw, bottom], [tailX - tw * 0.6, hh], [tailX - tw, bottom]);
      arc(-hw + r, bottom - r, Math.PI / 2);
      break;
    }
    default:
      return null;
  }
  if (opts.flipX) pts = pts.map(([x, y]) => [-x, y] as Pt).reverse();
  if (opts.flipY) pts = pts.map(([x, y]) => [x, -y] as Pt).reverse();
  return pts;
}

// The outline moved in by `r` along its edges' normals (mitred) - drawn back out by r on the GPU, it
// rounds every convex corner to radius r and leaves concave corners crisp. `r` is held below what
// the outline's shortest edge can take.
export function insetOutline(pts: Pt[], r: number): { pts: Pt[]; r: number } {
  const n = pts.length;
  if (n < 3 || r <= 0) return { pts, r: 0 };
  let area = 0;
  let minEdge = Infinity;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    area += x0 * y1 - x1 * y0;
    minEdge = Math.min(minEdge, Math.hypot(x1 - x0, y1 - y0));
  }
  const rr = Math.min(r, minEdge * 0.42);
  // Inward is to the right of each edge for a clockwise outline in y-down coordinates (area > 0).
  const sgn = area > 0 ? 1 : -1;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const n1 = normal(p0, p1, sgn);
    const n2 = normal(p1, p2, sgn);
    // The two edges, each moved in by rr, meet here.
    const a: Pt = [p0[0] + n1[0] * rr, p0[1] + n1[1] * rr];
    const b: Pt = [p1[0] + n1[0] * rr, p1[1] + n1[1] * rr];
    const c: Pt = [p1[0] + n2[0] * rr, p1[1] + n2[1] * rr];
    const d: Pt = [p2[0] + n2[0] * rr, p2[1] + n2[1] * rr];
    out.push(intersect(a, b, c, d) ?? c);
  }
  return { pts: out, r: rr };
}

function normal(a: Pt, b: Pt, sgn: number): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [(-dy / len) * sgn, (dx / len) * sgn];
}

function intersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r: Pt = [b[0] - a[0], b[1] - a[1]];
  const s: Pt = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  return [a[0] + r[0] * t, a[1] + r[1] * t];
}

// An SVG path of a preset in a w x h box (top-left origin) - the panel's thumbnails.
export function presetSvgPath(p: ShapePreset, w: number, h: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const round = (p.round ?? 0) * Math.min(w, h);
  const kind = FORM_KIND[p.form];
  if (kind === 0) {
    const r = Math.min(round, w / 2, h / 2);
    return `M${r},0H${w - r}A${r},${r} 0 0 1 ${w},${r}V${h - r}A${r},${r} 0 0 1 ${w - r},${h}H${r}A${r},${r} 0 0 1 0,${h - r}V${r}A${r},${r} 0 0 1 ${r},0Z`;
  }
  if (kind === 1) return `M0,${cy}A${cx},${cy} 0 1 0 ${w},${cy}A${cx},${cy} 0 1 0 0,${cy}Z`;
  if (kind === 3 || kind === 4) {
    const sweep = Math.min(359.9, p.sweep ?? 360);
    const inner = p.inner ?? 0;
    const at = (deg: number, k: number) => {
      const a = (deg * Math.PI) / 180;
      return `${(cx + Math.sin(a) * cx * k).toFixed(2)},${(cy - Math.cos(a) * cy * k).toFixed(2)}`;
    };
    const large = sweep > 180 ? 1 : 0;
    const outer = `M${at(0, 1)}A${cx},${cy} 0 ${large} 1 ${at(sweep, 1)}`;
    if (inner <= 0) return `M${cx},${cy}L${at(0, 1)}A${cx},${cy} 0 ${large} 1 ${at(sweep, 1)}Z`;
    return `${outer}L${at(sweep, inner)}A${cx * inner},${cy * inner} 0 ${large} 0 ${at(0, inner)}Z`;
  }
  const pts = formOutline(p.form, w, h, p.sides ?? 0, p.inner ?? formDefaults(p.form).inner, { round }) ?? [];
  return pts.map(([x, y], i) => `${i ? "L" : "M"}${(x + cx).toFixed(2)},${(y + cy).toFixed(2)}`).join("") + "Z";
}
