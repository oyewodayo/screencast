// components/video/transitionCanvas.ts
//
// The transitions that move BOTH pictures - the incoming clip slides, spins, folds round a cube or
// arrives as a wall of tiles, not just the outgoing one leaving over it. They're composited whole on
// the transition's fx canvas from two pictures (TransitionPictures: the outgoing and incoming
// frames exactly as the player shows them - see paintDisplayedPicture), so the preview, the picker
// tiles and the export (transition_window_graph, conversion.rs, which builds the same geometry from
// ffmpeg overlays, crops and `perspective`) all follow the functions in this file.
//
// Every curve is a function of the transition progress p (0..1) and the frame size W x H, in frame
// pixels; the export evaluates the same formulas per frame at the output size.
import type { IrisShape, LeakDirection, TransitionLook, TransitionType } from "../../utils/videoEditTypes";

export type CanvasTransition = "blocks" | "mosaic" | "split" | "slider" | "strips" | "beam" | "iris" | "spin" | "glitch" | "slice" | "push" | "cube" | "flip" | "tiles";

const CANVAS_TRANSITIONS = new Set<string>(["blocks", "mosaic", "split", "slider", "strips", "beam", "iris", "spin", "glitch", "slice", "push", "cube", "flip", "tiles"]);

export const isCanvasTransition = (type: TransitionType | null): type is CanvasTransition => !!type && CANVAS_TRANSITIONS.has(type);

// The two pictures a canvas transition is drawn from, each the whole frame.
export interface TransitionPictures {
  old: CanvasImageSource;
  next: CanvasImageSource;
}

// ---------- shared curves (mirrored in conversion.rs) ----------

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const smooth = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
export const easeInOutCubic = (x: number) => {
  const c = clamp01(x);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(2 - 2 * c, 3) / 2;
};
const easeIn3 = (x: number) => Math.pow(clamp01(x), 3);
const easeOut3 = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);

// Per-cell pseudo-random in [0,1) - the dissolve's hash, so ffmpeg's geq computes the same value.
export const cellHash = (c: number, r: number) => {
  const s = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
// Per-index pseudo-random in [0,1) (the asset/text-reveal hash).
export const indexHash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// Blocks / mosaic: a grid of roughly square cells, four across the frame's short side.
export function gridSize(W: number, H: number): [number, number] {
  const cell = Math.min(W, H) / 4;
  return [Math.max(2, Math.round(W / cell)), Math.max(2, Math.round(H / cell))];
}
// When a cell switches to the new clip.
export const blockThreshold = (c: number, r: number) => 0.08 + 0.84 * cellHash(c, r);
export const mosaicThreshold = (c: number, r: number, cols: number, rows: number) =>
  0.12 + 0.76 * (0.55 * ((c / (cols - 1) + r / (rows - 1)) / 2) + 0.45 * cellHash(c, r));
// The mosaic's grid lines: in over the first 15%, out over the last.
export const mosaicLineAlpha = (p: number) => 0.85 * Math.max(0, Math.min(1, p / 0.15, (1 - p) / 0.15));
export const mosaicLineWidth = (W: number, H: number) => Math.max(1, Math.min(W, H) * 0.005);

// Split: the four quarters of the old picture leave one after another (top-left up, top-right
// right, bottom-right down, bottom-left left), then the new picture's quarters arrive from the same
// sides, with black gutters between them.
export const SPLIT_DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
export const splitOldStart = (k: number) => 0.1 + 0.06 * k;
export const SPLIT_OLD_DUR = 0.3;
export const splitNewStart = (k: number) => 0.46 + 0.06 * k;
export const SPLIT_NEW_DUR = 0.32;
export const splitGutter = (W: number, H: number) => Math.max(2, Math.min(W, H) * 0.014);
export const splitLineAlpha = (p: number) => Math.max(0, Math.min(1, p / 0.1, (1 - p) / 0.1));
// How far quarter k has moved from home, as a fraction of its travel (0 = home, 1 = gone).
export const splitOldAway = (p: number, k: number) => easeIn3((p - splitOldStart(k)) / SPLIT_OLD_DUR);
export const splitNewAway = (p: number, k: number) => 1 - easeOut3((p - splitNewStart(k)) / SPLIT_NEW_DUR);

// Slider: a before/after divider sweeping across, the new clip behind it.
export const sliderMargin = (W: number, H: number) => 0.06 * Math.min(W, H);
export const sliderX = (p: number, W: number, H: number) => -sliderMargin(W, H) + (W + 2 * sliderMargin(W, H)) * smooth(p);

// Strips: six bands, each pushing the old picture out and the new one in, alternately down and up,
// left to right.
export const STRIP_COUNT = 6;
export const STRIP_STAGGER = 0.3;
export const STRIP_DUR = 0.7;
export const stripTravel = (p: number, k: number) => easeInOutCubic((p - (STRIP_STAGGER * k) / (STRIP_COUNT - 1)) / STRIP_DUR);

// Light beam: a glowing bar sweeping across, the new clip behind it.
export const DEFAULT_BEAM_COLOR = "#fff1d6";
export const beamX = (p: number, W: number) => -0.15 * W + 1.3 * W * smooth(p);
export const beamGlow = (dx: number, W: number) => 0.9 * Math.exp(-Math.pow(dx / (0.01 * W), 2)) + 0.5 * Math.exp(-Math.pow(dx / (0.06 * W), 2));
export const BEAM_REACH = 0.25; // of W either side - the glow is ~0 past it

// Iris: the new clip opening out of a shape, in units of half the frame's short side.
export const STAR_INNER = 0.5;
export const HEART_LIFT = 0.1;
export const IRIS_INRADIUS: Record<IrisShape, number> = { triangle: 0.5, diamond: Math.SQRT1_2, hexagon: Math.sqrt(3) / 2, star: STAR_INNER, heart: 0.8 };
export const irisShapeOf = (look: TransitionLook): IrisShape =>
  look.shape === "diamond" || look.shape === "hexagon" || look.shape === "star" || look.shape === "heart" ? look.shape : "triangle";
export function irisScale(shape: IrisShape, p: number, W: number, H: number): number {
  const m = Math.min(W, H) / 2;
  const corner = Math.hypot(W, H) / 2 / m;
  return (corner / IRIS_INRADIUS[shape]) * 1.02 * p * p;
}
// The heart: (x^2 + y^2 - 1)^3 - x^2 y^3 <= 0 with y up, lifted so it sits centred.
export const heartInside = (x: number, y: number) => {
  const hy = -y + HEART_LIFT;
  return Math.pow(x * x + hy * hy - 1, 3) - x * x * Math.pow(hy, 3) <= 0;
};
// The shape's outline, unit size, y down (centre at 0,0).
const outlineCache = new Map<IrisShape, [number, number][]>();
export function irisOutline(shape: IrisShape): [number, number][] {
  let pts = outlineCache.get(shape);
  if (pts) return pts;
  const r3 = Math.sqrt(3);
  switch (shape) {
    case "triangle":
      pts = [
        [0, 1],
        [-r3 / 2, -0.5],
        [r3 / 2, -0.5],
      ];
      break;
    case "diamond":
      pts = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ];
      break;
    case "hexagon":
      pts = Array.from({ length: 6 }, (_, i) => [Math.cos((i * Math.PI) / 3), Math.sin((i * Math.PI) / 3)] as [number, number]);
      break;
    case "star":
      pts = Array.from({ length: 10 }, (_, i) => {
        const r = i % 2 === 0 ? 1 : STAR_INNER;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        return [Math.cos(a) * r, Math.sin(a) * r] as [number, number];
      });
      break;
    default: {
      // The heart is star-shaped about the origin: its edge along each ray, by bisection.
      pts = Array.from({ length: 240 }, (_, i) => {
        const a = (i / 240) * Math.PI * 2;
        let lo = 0;
        let hi = 2;
        for (let k = 0; k < 30; k++) {
          const mid = (lo + hi) / 2;
          if (heartInside(Math.cos(a) * mid, Math.sin(a) * mid)) lo = mid;
          else hi = mid;
        }
        return [Math.cos(a) * lo, Math.sin(a) * lo] as [number, number];
      });
    }
  }
  outlineCache.set(shape, pts);
  return pts;
}

// Spin: the old picture spins away a quarter turn while blurring, the new one spins in from the
// opposite quarter - each zoomed just enough to keep the frame covered.
export function spinState(p: number, W: number, H: number, direction: LeakDirection | undefined): { old: boolean; angle: number; zoom: number; blur: number } {
  const old = p < 0.5;
  const q = old ? 2 * p : 2 * p - 1;
  const deg = old ? 90 * Math.pow(clamp01(q), 3) : -90 * Math.pow(1 - clamp01(q), 3);
  const angle = ((direction === "left" ? -1 : 1) * deg * Math.PI) / 180;
  const zoom = Math.abs(Math.cos(angle)) + Math.max(W / H, H / W) * Math.abs(Math.sin(angle));
  return { old, angle, zoom, blur: 0.03 * Math.min(W, H) * Math.pow(Math.sin(Math.PI * p), 2) };
}

// Glitch: torn horizontal slices and a red/blue split, cutting to the new clip halfway. The tear
// pattern changes GLITCH_STEPS times over the transition.
export const GLITCH_STEPS = 10;
export const GLITCH_SLICES = 5;
export const glitchStep = (p: number) => Math.min(GLITCH_STEPS - 1, Math.floor(p * GLITCH_STEPS));
export const glitchShift = (p: number, W: number) => Math.round(0.02 * W * Math.sin(Math.PI * p));
export const glitchSliceHeight = (j: number, H: number) => H * (0.04 + 0.08 * indexHash(j * 7.3));
export const glitchSliceY = (j: number, k: number, H: number) => (H - glitchSliceHeight(j, H)) * indexHash(j * 3.1 + k * 1.7);
export const glitchSliceDx = (j: number, k: number, p: number, W: number) => (indexHash(j * 5.9 + k * 2.3) - 0.5) * 0.2 * W * Math.sin(Math.PI * p);

// Slice: the old picture cut on a 60° diagonal through the centre, the halves sliding apart along
// the cut. n is the cut's normal, d its direction (up and to the right).
export const SLICE_N: [number, number] = [Math.sin(Math.PI / 3), Math.cos(Math.PI / 3)];
export const SLICE_D: [number, number] = [Math.cos(Math.PI / 3), -Math.sin(Math.PI / 3)];
export const sliceTravel = (p: number, W: number, H: number) => easeInOutCubic(p) * Math.hypot(W, H);

// Push: both pictures move together, the new one pushing the old one out.
export const pushTravel = (p: number) => easeInOutCubic(p);

// Cube / flip: faces of a box turning about the frame's centre line, seen in perspective.
// `along` is the screen coordinate along the turning direction (x for left/right, y for up/down);
// `k` the perspective scale across it.
export interface FaceGeometry {
  // Screen position along the axis and scale across it of the face's source line u (0..1).
  at: (u: number) => { along: number; k: number };
  // Brightness 0..1 (the face darkens as it turns away).
  shade: number;
}
const DEG1 = Math.PI / 180;
const isVerticalDir = (direction: LeakDirection | undefined) => direction === "up" || direction === "down";
const isMirroredDir = (direction: LeakDirection | undefined) => direction === "right" || direction === "down";

export function cubeFaces(p: number, W: number, H: number, direction: LeakDirection | undefined): { old: FaceGeometry | null; next: FaceGeometry | null } {
  const S = isVerticalDir(direction) ? H : W;
  const sgn = isMirroredDir(direction) ? -1 : 1;
  const phi = (Math.PI / 2) * easeInOutCubic(p);
  const D = 2.2 * S;
  const recess = 0.25 * S * Math.sin(2 * phi);
  const project = (xp: number, zp: number) => {
    const k = D / (D - (zp - S / 2 - recess));
    return { along: S / 2 + sgn * xp * k, k };
  };
  const X = (u: number) => sgn * (u - 0.5) * S;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  return {
    old: phi <= Math.PI / 2 - DEG1 ? { at: (u) => project(X(u) * c - (S / 2) * s, X(u) * s + (S / 2) * c), shade: 0.6 + 0.4 * c } : null,
    next: phi >= DEG1 ? { at: (u) => project((S / 2) * c + X(u) * s, (S / 2) * s - X(u) * c), shade: 0.6 + 0.4 * s } : null,
  };
}

export function flipFace(p: number, W: number, H: number, direction: LeakDirection | undefined): { old: boolean; face: FaceGeometry | null } {
  const S = isVerticalDir(direction) ? H : W;
  const sgn = isMirroredDir(direction) ? -1 : 1;
  const e = easeInOutCubic(p);
  const phi = Math.PI * e;
  const old = phi < Math.PI / 2;
  const theta = old ? phi : phi - Math.PI;
  const D = 2.5 * S;
  const recess = 0.2 * S * Math.sin(Math.PI * e);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  if (Math.abs(c) < Math.sin(DEG1)) return { old, face: null };
  return {
    old,
    face: {
      at: (u) => {
        const X = sgn * (u - 0.5) * S;
        const k = D / (D - (-X * s - recess));
        return { along: S / 2 + sgn * X * c * k, k };
      },
      shade: 0.6 + 0.4 * Math.abs(c),
    },
  };
}

// Tiles: the new clip arrives as a tilted wall of mirrored, rounded tiles that zooms into its
// centre tile, whose corners square off over the last 20% so it lands exactly on the frame.
// Sizes in frame px; `gap` and `radius` are on screen (both scale with the wall).
export const TILE_GAP = 0.05; // of the short side, at full size
export function tilesState(p: number, W: number, H: number): { scale: number; angle: number; gap: number; radius: number; alpha: number; square: number } {
  const e = easeInOutCubic(p);
  const scale = 0.34 + 0.66 * e;
  const m = Math.min(W, H);
  return { scale, angle: (-10 * (1 - e) * Math.PI) / 180, gap: TILE_GAP * m * scale, radius: 0.05 * m * scale, alpha: Math.min(1, p / 0.12), square: clamp01((p - 0.8) / 0.2) };
}

// ---------- drawing ----------

function sourceSize(src: CanvasImageSource): [number, number] {
  if (src instanceof HTMLVideoElement) return [src.videoWidth || 1, src.videoHeight || 1];
  if (src instanceof HTMLImageElement) return [src.naturalWidth || 1, src.naturalHeight || 1];
  const s = src as { width: number; height: number };
  return [Number(s.width) || 1, Number(s.height) || 1];
}

// The part (u0,v0)-(u1,v1) of a picture (fractions of it) drawn into a rect.
function part(ctx: CanvasRenderingContext2D, src: CanvasImageSource, u0: number, v0: number, u1: number, v1: number, dx: number, dy: number, dw: number, dh: number) {
  if (dw <= 0 || dh <= 0 || u1 <= u0 || v1 <= v0) return;
  const [sw, sh] = sourceSize(src);
  ctx.drawImage(src, u0 * sw, v0 * sh, (u1 - u0) * sw, (v1 - v0) * sh, dx, dy, dw, dh);
}

const full = (ctx: CanvasRenderingContext2D, src: CanvasImageSource, W: number, H: number) => ctx.drawImage(src, 0, 0, W, H);

// Scratch canvases (the glitch's composite and colour channels), reused across frames.
const scratch: HTMLCanvasElement[] = [];
function scratchCanvas(i: number, w: number, h: number): CanvasRenderingContext2D {
  scratch[i] ??= document.createElement("canvas");
  const c = scratch[i];
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

// `src` (w x h device px) with its red channel moved `shift` px left and its blue `shift` px right,
// each smearing its edge column into the gap - ffmpeg's rgbashift (rh=-shift, bh=shift). `ctx` is
// in device px with no transform.
export function drawRgbSplit(ctx: CanvasRenderingContext2D, src: CanvasImageSource, shift: number, w: number, h: number): void {
  if (shift < 0.5) {
    ctx.drawImage(src, 0, 0, w, h);
    return;
  }
  const channels: [string, number][] = [
    ["#ff0000", -shift],
    ["#00ff00", 0],
    ["#0000ff", shift],
  ];
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  channels.forEach(([color, dx], i) => {
    const ch = scratchCanvas(i + 1, w, h);
    ch.drawImage(src, 0, 0, w, h);
    ch.globalCompositeOperation = "multiply";
    ch.fillStyle = color;
    ch.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(ch.canvas, dx, 0);
    if (dx < 0) ctx.drawImage(ch.canvas, w - 1, 0, 1, h, w + dx, 0, -dx, h);
    if (dx > 0) ctx.drawImage(ch.canvas, 0, 0, 1, h, 0, 0, dx, h);
  });
  ctx.restore();
}

// A face of the cube / flip: the picture cut into thin bands across the turning axis, each placed
// and scaled where the perspective puts it (exact for a turn about one axis), then shaded.
function drawFace(ctx: CanvasRenderingContext2D, src: CanvasImageSource, face: FaceGeometry, vertical: boolean, W: number, H: number, dpr: number) {
  const P = vertical ? W : H;
  const a0 = face.at(0);
  const a1 = face.at(1);
  const span = Math.abs(a1.along - a0.along) * dpr;
  const n = Math.max(8, Math.min(720, Math.ceil(span / 1.5)));
  const [sw, sh] = sourceSize(src);
  const overlap = 0.6 / dpr;
  for (let i = 0; i < n; i++) {
    const u0 = i / n;
    const u1 = (i + 1) / n;
    const b0 = face.at(u0).along;
    const b1 = face.at(u1).along;
    if (b1 <= b0) continue;
    const k = face.at((u0 + u1) / 2).k;
    const across0 = P / 2 - (P / 2) * k;
    if (vertical) ctx.drawImage(src, 0, u0 * sh, sw, (u1 - u0) * sh, across0, b0, P * k, b1 - b0 + overlap);
    else ctx.drawImage(src, u0 * sw, 0, (u1 - u0) * sw, sh, b0, across0, b1 - b0 + overlap, P * k);
  }
  if (face.shade < 1) {
    const corners = [
      [a0.along, P / 2 - (P / 2) * a0.k],
      [a1.along, P / 2 - (P / 2) * a1.k],
      [a1.along, P / 2 + (P / 2) * a1.k],
      [a0.along, P / 2 + (P / 2) * a0.k],
    ];
    ctx.fillStyle = `rgba(0,0,0,${1 - face.shade})`;
    ctx.beginPath();
    corners.forEach(([al, ac], i) => {
      const x = vertical ? ac : al;
      const y = vertical ? al : ac;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  }
}

const parseHex = (hex: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Draws one moment of a canvas transition over the whole frame (W x H frame px, `ctx` already
// scaled to them; `dpr` device pixels per frame px).
export function drawCanvasTransition(ctx: CanvasRenderingContext2D, type: CanvasTransition, look: TransitionLook, p: number, pics: TransitionPictures, W: number, H: number, dpr = 1): void {
  const { old, next } = pics;
  // Device-pixel snapping for edges that butt against each other (no hairline seams).
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  switch (type) {
    case "blocks":
    case "mosaic": {
      const [cols, rows] = gridSize(W, H);
      full(ctx, next, W, H);
      ctx.save();
      ctx.beginPath();
      let any = false;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const th = type === "blocks" ? blockThreshold(c, r) : mosaicThreshold(c, r, cols, rows);
          if (p >= th) continue;
          const x0 = snap((c * W) / cols);
          const y0 = snap((r * H) / rows);
          ctx.rect(x0, y0, snap(((c + 1) * W) / cols) - x0, snap(((r + 1) * H) / rows) - y0);
          any = true;
        }
      if (any) {
        ctx.clip();
        full(ctx, old, W, H);
      }
      ctx.restore();
      if (type === "mosaic") {
        const a = mosaicLineAlpha(p);
        if (a > 0) {
          const lw = mosaicLineWidth(W, H);
          ctx.fillStyle = `rgba(0,0,0,${a})`;
          for (let c = 1; c < cols; c++) ctx.fillRect((c * W) / cols - lw / 2, 0, lw, H);
          for (let r = 1; r < rows; r++) ctx.fillRect(0, (r * H) / rows - lw / 2, W, lw);
        }
      }
      break;
    }
    case "split": {
      const X = snap(W / 2);
      const Y = snap(H / 2);
      const quads: [number, number, number, number][] = [
        [0, 0, X, Y],
        [X, 0, W, Y],
        [X, Y, W, H],
        [0, Y, X, H],
      ];
      const drawQuads = (src: CanvasImageSource, away: (k: number) => number) =>
        quads.forEach(([x0, y0, x1, y1], k) => {
          const f = away(k);
          if (f >= 1) return;
          const [dx, dy] = SPLIT_DIRS[k];
          const ox = dx * f * (W / 2);
          const oy = dy * f * (H / 2);
          part(ctx, src, x0 / W, y0 / H, x1 / W, y1 / H, x0 + ox, y0 + oy, x1 - x0, y1 - y0);
        });
      drawQuads(old, (k) => splitOldAway(p, k));
      drawQuads(next, (k) => splitNewAway(p, k));
      const a = splitLineAlpha(p);
      if (a > 0) {
        const g = splitGutter(W, H);
        ctx.fillStyle = `rgba(0,0,0,${a})`;
        ctx.fillRect(X - g / 2, 0, g, H);
        ctx.fillRect(0, Y - g / 2, W, g);
      }
      break;
    }
    case "slider": {
      const mirrored = look.direction === "left";
      const x = sliderX(p, W, H);
      const at = mirrored ? W - x : x;
      full(ctx, old, W, H);
      ctx.save();
      ctx.beginPath();
      if (mirrored) ctx.rect(at, 0, W - at, H);
      else ctx.rect(0, 0, at, H);
      ctx.clip();
      full(ctx, next, W, H);
      ctx.restore();
      const m = Math.min(W, H);
      const lw = Math.max(2, 0.006 * m);
      const a = 0.03 * m;
      const gap = 0.016 * m;
      const cy = H / 2;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(at - lw / 2, 0, lw, H);
      ctx.beginPath();
      ctx.moveTo(at - gap, cy - a);
      ctx.lineTo(at - gap, cy + a);
      ctx.lineTo(at - gap - a * 1.2, cy);
      ctx.closePath();
      ctx.moveTo(at + gap, cy - a);
      ctx.lineTo(at + gap, cy + a);
      ctx.lineTo(at + gap + a * 1.2, cy);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "strips": {
      const rows = look.orientation === "horizontal";
      for (let k = 0; k < STRIP_COUNT; k++) {
        const e = stripTravel(p, k);
        const dir = k % 2 === 0 ? 1 : -1;
        const a0 = k / STRIP_COUNT;
        const a1 = (k + 1) / STRIP_COUNT;
        if (rows) {
          const y0 = snap(a0 * H);
          const y1 = snap(a1 * H);
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, y0, W, y1 - y0);
          ctx.clip();
          if (e < 1) part(ctx, old, 0, a0, 1, a1, dir * e * W, y0, W, y1 - y0);
          if (e > 0) part(ctx, next, 0, a0, 1, a1, dir * (e - 1) * W, y0, W, y1 - y0);
          ctx.restore();
        } else {
          const x0 = snap(a0 * W);
          const x1 = snap(a1 * W);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, 0, x1 - x0, H);
          ctx.clip();
          if (e < 1) part(ctx, old, a0, 0, a1, 1, x0, dir * e * H, x1 - x0, H);
          if (e > 0) part(ctx, next, a0, 0, a1, 1, x0, dir * (e - 1) * H, x1 - x0, H);
          ctx.restore();
        }
      }
      break;
    }
    case "beam": {
      const mirrored = look.direction === "left";
      const xb = beamX(p, W);
      const at = mirrored ? W - xb : xb;
      full(ctx, old, W, H);
      ctx.save();
      ctx.beginPath();
      if (mirrored) ctx.rect(at, 0, W - at, H);
      else ctx.rect(0, 0, at, H);
      ctx.clip();
      full(ctx, next, W, H);
      ctx.restore();
      const k = Math.max(0.1, Math.min(1.5, look.intensity ?? 1));
      const [r, g, b] = parseHex(look.color ?? DEFAULT_BEAM_COLOR) ?? [255, 241, 214];
      const reach = BEAM_REACH * W;
      const grad = ctx.createLinearGradient(at - reach, 0, at + reach, 0);
      const STOPS = 64;
      for (let i = 0; i <= STOPS; i++) {
        const f = i / STOPS;
        const alpha = Math.min(1, k * beamGlow((f * 2 - 1) * reach, W));
        grad.addColorStop(f, `rgba(${r},${g},${b},${alpha})`);
      }
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = grad;
      ctx.fillRect(at - reach, 0, 2 * reach, H);
      break;
    }
    case "iris": {
      const shape = irisShapeOf(look);
      const s = irisScale(shape, p, W, H) * (Math.min(W, H) / 2);
      full(ctx, old, W, H);
      if (s > 0) {
        ctx.save();
        ctx.beginPath();
        irisOutline(shape).forEach(([x, y], i) => (i ? ctx.lineTo(W / 2 + x * s, H / 2 + y * s) : ctx.moveTo(W / 2 + x * s, H / 2 + y * s)));
        ctx.closePath();
        ctx.clip();
        full(ctx, next, W, H);
        ctx.restore();
      }
      break;
    }
    case "spin": {
      const st = spinState(p, W, H, look.direction);
      ctx.translate(W / 2, H / 2);
      ctx.rotate(st.angle);
      ctx.scale(st.zoom, st.zoom);
      if (st.blur > 0.05) ctx.filter = `blur(${st.blur * dpr}px)`;
      ctx.drawImage(st.old ? old : next, -W / 2, -H / 2, W, H);
      break;
    }
    case "glitch": {
      const w = Math.max(1, Math.round(W * dpr));
      const h = Math.max(1, Math.round(H * dpr));
      const base = p < 0.5 ? old : next;
      const comp = scratchCanvas(0, w, h);
      comp.drawImage(base, 0, 0, w, h);
      const k = glitchStep(p);
      for (let j = 0; j < GLITCH_SLICES; j++) {
        const sh = glitchSliceHeight(j, H);
        const y = glitchSliceY(j, k, H);
        part(comp, base, 0, y / H, 1, (y + sh) / H, glitchSliceDx(j, k, p, W) * dpr, y * dpr, w, sh * dpr);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawRgbSplit(ctx, comp.canvas, glitchShift(p, W) * dpr, w, h);
      break;
    }
    case "slice": {
      full(ctx, next, W, H);
      const L = sliceTravel(p, W, H);
      const [nx, ny] = SLICE_N;
      const [dx, dy] = SLICE_D;
      // Half A: n . (P - C) <= 0 (top-left of the cut), moving along +d; half B the rest, along -d.
      const halfPoly = (sign: number): [number, number][] => {
        const corners: [number, number][] = [
          [0, 0],
          [W, 0],
          [W, H],
          [0, H],
        ];
        const out: [number, number][] = [];
        const f = ([x, y]: [number, number]) => sign * ((x - W / 2) * nx + (y - H / 2) * ny);
        for (let i = 0; i < 4; i++) {
          const a = corners[i];
          const b = corners[(i + 1) % 4];
          const fa = f(a);
          const fb = f(b);
          if (fa <= 0) out.push(a);
          if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
            const t = fa / (fa - fb);
            out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
          }
        }
        return out;
      };
      for (const sign of [1, -1]) {
        const ox = sign * L * dx;
        const oy = sign * L * dy;
        const poly = halfPoly(sign);
        if (poly.length < 3) continue;
        ctx.save();
        ctx.beginPath();
        poly.forEach(([x, y], i) => (i ? ctx.lineTo(x + ox, y + oy) : ctx.moveTo(x + ox, y + oy)));
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(old, ox, oy, W, H);
        ctx.restore();
      }
      break;
    }
    case "push": {
      const e = pushTravel(p);
      const dir = look.direction;
      const vertical = dir === "up" || dir === "down";
      const sign = dir === "right" || dir === "down" ? 1 : -1;
      const S = vertical ? H : W;
      const oOld = sign * e * S;
      const oNew = sign * (e - 1) * S;
      if (vertical) {
        ctx.drawImage(old, 0, oOld, W, H);
        ctx.drawImage(next, 0, oNew, W, H);
      } else {
        ctx.drawImage(old, oOld, 0, W, H);
        ctx.drawImage(next, oNew, 0, W, H);
      }
      break;
    }
    case "cube": {
      const vertical = look.direction === "up" || look.direction === "down";
      const faces = cubeFaces(p, W, H, look.direction);
      if (faces.old) drawFace(ctx, old, faces.old, vertical, W, H, dpr);
      if (faces.next) drawFace(ctx, next, faces.next, vertical, W, H, dpr);
      break;
    }
    case "flip": {
      const vertical = look.direction === "up" || look.direction === "down";
      const { old: isOld, face } = flipFace(p, W, H, look.direction);
      if (face) drawFace(ctx, isOld ? old : next, face, vertical, W, H, dpr);
      break;
    }
    case "tiles": {
      full(ctx, old, W, H);
      const st = tilesState(p, W, H);
      const tw = W * st.scale;
      const th = H * st.scale;
      ctx.translate(W / 2, H / 2);
      ctx.rotate(st.angle);
      ctx.globalAlpha = st.alpha;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const radius = i === 0 && j === 0 ? st.radius * (1 - st.square) : st.radius;
          ctx.save();
          ctx.translate(i * (tw + st.gap), j * (th + st.gap));
          ctx.beginPath();
          if (radius > 0.01) ctx.roundRect(-tw / 2, -th / 2, tw, th, radius);
          else ctx.rect(-tw / 2, -th / 2, tw, th);
          ctx.clip();
          ctx.scale(i % 2 ? -1 : 1, j % 2 ? -1 : 1);
          ctx.drawImage(next, -tw / 2, -th / 2, tw, th);
          ctx.restore();
        }
      break;
    }
  }
  ctx.restore();
}

// ---------- the preview's pictures ----------

// Parses a CSS transform-origin ("12px 30px", "50% 50%", "0 0", "") against a box; empty = centre.
function parseOrigin(origin: string, w: number, h: number): [number, number] {
  const parts = origin.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [w / 2, h / 2];
  const len = (v: string | undefined, size: number) => {
    if (!v || v === "center") return size / 2;
    if (v === "left" || v === "top") return 0;
    if (v === "right" || v === "bottom") return size;
    if (v.endsWith("%")) return (parseFloat(v) / 100) * size;
    return parseFloat(v) || 0;
  };
  return [len(parts[0], w), len(parts[1] ?? "center", h)];
}

// Paints a picture element (a <video>, a canvas) the way the page shows it into `ctx` (frame px):
// laid out in `box` (frame px, the element's own layout box relative to the frame's top-left) with
// object-fit: contain, then its CSS `transform` about `origin`, through its CSS `filter`.
export function paintDisplayedPicture(
  ctx: CanvasRenderingContext2D,
  el: HTMLVideoElement | HTMLCanvasElement,
  box: { x: number; y: number; w: number; h: number },
  transform: string,
  origin: string,
  filter: string
): boolean {
  const [sw, sh] = el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : [el.width, el.height];
  if (!sw || !sh || box.w <= 0 || box.h <= 0) return false;
  const fit = Math.min(box.w / sw, box.h / sh);
  const dw = sw * fit;
  const dh = sh * fit;
  const [ox, oy] = parseOrigin(origin, box.w, box.h);
  ctx.save();
  ctx.translate(box.x + ox, box.y + oy);
  if (transform && transform !== "none") {
    try {
      const m = new DOMMatrix(transform);
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    } catch {
      // An unparseable transform: draw it untransformed rather than not at all.
    }
  }
  ctx.translate(-ox, -oy);
  ctx.filter = filter && filter !== "none" ? filter : "none";
  ctx.drawImage(el, (box.w - dw) / 2, (box.h - dh) / 2, dw, dh);
  ctx.restore();
  return true;
}
