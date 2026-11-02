// utils/signatureInk.ts
//
// Ink for drawn signatures (DocSignatureStudio.tsx): turns raw pointer samples into strokes that
// look written with a pen, not traced with a 1px line.
//   - streamlining pulls each sample a little towards the previous one, so a shaky hand or a
//     coarse mouse still gives a smooth curve
//   - width follows pen pressure on a stylus; with a mouse or finger it follows speed instead -
//     slow strokes pool ink and swell, fast flicks thin out, the way a real nib behaves
//   - strokes taper in and out at their ends
// Each stroke is drawn as one filled outline (left edge, round end cap, right edge back, round
// start cap) smoothed with quadratic curves through edge midpoints - no visible joints or beads.
// Pure geometry plus a canvas renderer; no DOM beyond the 2D context it's handed.

export interface InkPoint {
  x: number;
  y: number;
  t: number; // ms
  p: number; // pen pressure 0..1 (0.5 when the device has none)
}

export interface InkStroke {
  points: InkPoint[];
  pen: boolean; // pressure-sensitive device: width follows pressure rather than speed
}

export interface InkStyle {
  size: number; // nominal nib width, px
  color: string;
}

const STREAMLINE = 0.42;
const MIN_STEP = 0.6;

interface Sample {
  x: number;
  y: number;
  r: number;
  len: number; // running length from the stroke's start
}

// Smoothed centre line with a radius per sample. `done` tapers the end too (a finished stroke).
export function strokeSamples(stroke: InkStroke, size: number, done = true): Sample[] {
  const pts = stroke.points;
  if (pts.length === 0) return [];
  const out: Sample[] = [];
  let sx = pts[0].x;
  let sy = pts[0].y;
  let pressure = stroke.pen ? pts[0].p : 0.62;
  let len = 0;
  let prevT = pts[0].t;
  out.push({ x: sx, y: sy, r: 0, len: 0 });
  const radii: number[] = [pressure];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const nx = sx + (p.x - sx) * (1 - STREAMLINE);
    const ny = sy + (p.y - sy) * (1 - STREAMLINE);
    const step = Math.hypot(nx - sx, ny - sy);
    if (step < MIN_STEP && i < pts.length - 1) continue;
    const dt = Math.max(1, p.t - prevT);
    prevT = p.t;
    let target: number;
    if (stroke.pen) target = Math.max(0.05, p.p);
    else {
      // px/ms: ~0.2 is a slow deliberate stroke, ~2.5 a fast flick.
      const v = step / dt;
      target = Math.min(1, Math.max(0.18, 1.05 - v * 0.38));
    }
    pressure += (target - pressure) * (stroke.pen ? 0.5 : 0.22);
    len += step;
    sx = nx;
    sy = ny;
    out.push({ x: sx, y: sy, r: 0, len });
    radii.push(pressure);
  }
  const total = len;
  const half = size / 2;
  const taperIn = Math.min(size * 2.2, total * 0.3);
  const taperOut = done ? Math.min(size * 2.6, total * 0.3) : 0;
  for (let i = 0; i < out.length; i++) {
    let r = half * (0.28 + 0.72 * radii[i]);
    const s = out[i];
    if (taperIn > 0 && s.len < taperIn) r *= 0.45 + 0.55 * Math.sqrt(s.len / taperIn);
    const fromEnd = total - s.len;
    if (taperOut > 0 && fromEnd < taperOut) r *= 0.3 + 0.7 * Math.sqrt(fromEnd / taperOut);
    s.r = Math.max(0.35, r);
  }
  return out;
}

// The filled outline of a stroke as a closed polygon.
export function strokeOutline(samples: Sample[]): [number, number][] {
  const n = samples.length;
  if (n === 0) return [];
  if (n === 1) {
    const { x, y, r } = samples[0];
    const ring: [number, number][] = [];
    for (let k = 0; k < 12; k++) ring.push([x + Math.cos((k / 12) * Math.PI * 2) * r * 1.4, y + Math.sin((k / 12) * Math.PI * 2) * r * 1.4]);
    return ring;
  }
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const s = samples[i];
    left.push([s.x - ty * s.r, s.y + tx * s.r]);
    right.push([s.x + ty * s.r, s.y - tx * s.r]);
  }
  const cap = (c: Sample, from: [number, number], dirSign: 1 | -1): [number, number][] => {
    // Half-circle round cap around c, starting at `from`.
    const pts: [number, number][] = [];
    const a0 = Math.atan2(from[1] - c.y, from[0] - c.x);
    for (let k = 1; k < 6; k++) {
      const a = a0 + dirSign * (k / 6) * Math.PI;
      pts.push([c.x + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r]);
    }
    return pts;
  };
  const endCap = cap(samples[n - 1], left[n - 1], -1);
  const startCap = cap(samples[0], right[0], -1);
  return [...left, ...endCap, ...right.reverse(), ...startCap];
}

function fillSmooth(ctx: CanvasRenderingContext2D, poly: [number, number][]) {
  if (poly.length < 3) return;
  ctx.beginPath();
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const first = mid(poly[poly.length - 1], poly[0]);
  ctx.moveTo(first[0], first[1]);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const m = mid(p, poly[(i + 1) % poly.length]);
    ctx.quadraticCurveTo(p[0], p[1], m[0], m[1]);
  }
  ctx.closePath();
  ctx.fill();
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke, style: InkStyle, done = true) {
  ctx.fillStyle = style.color;
  fillSmooth(ctx, strokeOutline(strokeSamples(stroke, style.size, done)));
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: InkStroke[], style: InkStyle) {
  for (const s of strokes) drawStroke(ctx, s, style, true);
}

export interface InkBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function strokesBounds(strokes: InkStroke[], size: number): InkBounds | null {
  let b: InkBounds | null = null;
  for (const s of strokes)
    for (const p of s.points) {
      if (!b) b = { left: p.x, top: p.y, right: p.x, bottom: p.y };
      else {
        b.left = Math.min(b.left, p.x);
        b.top = Math.min(b.top, p.y);
        b.right = Math.max(b.right, p.x);
        b.bottom = Math.max(b.bottom, p.y);
      }
    }
  if (!b) return null;
  const pad = size * 1.5;
  return { left: b.left - pad, top: b.top - pad, right: b.right + pad, bottom: b.bottom + pad };
}

// The strokes as a tightly cropped transparent PNG at `scale`x, plus its size in CSS px.
export async function strokesToPng(strokes: InkStroke[], style: InkStyle, scale = 3): Promise<{ blob: Blob; width: number; height: number } | null> {
  const b = strokesBounds(strokes, style.size);
  if (!b) return null;
  const w = Math.max(1, Math.ceil(b.right - b.left));
  const h = Math.max(1, Math.ceil(b.bottom - b.top));
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.translate(-b.left, -b.top);
  drawStrokes(ctx, strokes, style);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  return blob ? { blob, width: w, height: h } : null;
}
