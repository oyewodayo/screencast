// components/video/transitionFrame.ts
//
// Draws one moment of a transition: the outgoing clip's frozen frame (`mover`) animated out over
// whatever sits beneath it (the incoming clip), plus the synthetic layers some transitions add on
// top - a black dip, a coloured glow, a pixelated copy, and an `fx` canvas for the drawn ones (a
// colour sweep's panels). Shared by the player's live preview
// (TransitionPreviewLayer) and the animated tiles in the transition picker (TransitionGrid), so a
// tile shows exactly what the preview - and the export (transition_fold_step, conversion.rs),
// which mirrors the same maths - will do.
import { LeakDirection, TransitionLook, TransitionType } from "../../utils/videoEditTypes";
import { TransitionPictures, drawCanvasTransition, isCanvasTransition } from "./transitionCanvas";

export interface TransitionElements {
  // The outgoing frame, filling the whole container box.
  mover: HTMLElement;
  // Frame-rect overlays.
  black: HTMLElement;
  glow: HTMLElement;
  // Inside the mover, at the frame rect: the pixelize transition's coarse copy.
  pixel: HTMLCanvasElement | null;
  // Over everything, at the frame rect: drawn transition layers.
  fx: HTMLCanvasElement | null;
  // The outgoing frame itself, for the pixelize copy.
  source: CanvasImageSource;
  // Both pictures as the frame shows them, for the transitions that move both (transitionCanvas.ts) -
  // asked for only by those, once per drawn frame. Null while they aren't ready: the outgoing
  // picture then just holds.
  pictures?: () => TransitionPictures | null;
}

// The frame rect (the picture) inside the container box the mover fills.
export interface TransitionGeometry {
  L: number;
  T: number;
  W: number;
  H: number;
  containerW: number;
  containerH: number;
}

// Pixelize's coarsest block, as a fraction of the frame width (times look.size; export:
// transition_window_graph).
const PIXELIZE_MAX_BLOCK_FRACTION = 1 / 24;
// Dissolve grain / pixelize block size.
const lookSize = (look: TransitionLook) => Math.max(0.3, Math.min(3, look.size ?? 1));
// Soft edges (look.softness 0..1): a wipe's, as a fraction of the frame width; a circle's, of its
// diagonal; a clock wipe's, in degrees.
const softness = (look: TransitionLook) => Math.max(0, Math.min(1, look.softness ?? 0));
const wipeSoftness = (look: TransitionLook) => 0.3 * softness(look);
const circleSoftness = (look: TransitionLook) => 0.15 * softness(look);
const radialSoftness = (look: TransitionLook) => 60 * softness(look);

// Dissolve's grain: a fixed noise field DISSOLVE_COLS / look.size cells across (rows to the frame's aspect),
// each cell switching to the new clip once the progress passes its value - the same hash, grid
// and bilinear upscale as the export's mask (transition_window_graph, conversion.rs).
const DISSOLVE_COLS = 160;
const noiseFields = new Map<string, Float32Array>();
function noiseField(cols: number, rows: number): Float32Array {
  const key = `${cols}x${rows}`;
  let field = noiseFields.get(key);
  if (!field) {
    field = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        field[y * cols + x] = s - Math.floor(s);
      }
    noiseFields.set(key, field);
  }
  return field;
}
let dissolveCanvas: HTMLCanvasElement | null = null;
// The outgoing picture's dissolve mask at progress p, as a data URL (opaque = still showing).
function dissolveMask(W: number, H: number, p: number, cols: number): string {
  const rows = Math.max(1, Math.round((cols * H) / W));
  const field = noiseField(cols, rows);
  dissolveCanvas ??= document.createElement("canvas");
  if (dissolveCanvas.width !== cols || dissolveCanvas.height !== rows) {
    dissolveCanvas.width = cols;
    dissolveCanvas.height = rows;
  }
  const ctx = dissolveCanvas.getContext("2d")!;
  const image = ctx.createImageData(cols, rows);
  for (let i = 0; i < field.length; i++) image.data[i * 4 + 3] = field[i] >= p ? 255 : 0;
  ctx.putImageData(image, 0, 0);
  return dissolveCanvas.toDataURL();
}

// Colour sweep: the lighter band at the panel's edges, as a fraction of the frame.
export const SWEEP_ACCENT = 0.08;
export const DEFAULT_SWEEP_COLOR = "#ffb020";

// A light leak's hot spot at progress p, as fractions of the frame - the same path
// transition_glow_filter (conversion.rs) gives ffmpeg.
function leakSpot(direction: LeakDirection | undefined, p: number): [number, number] {
  const sweep = -0.2 + 1.4 * p;
  switch (direction) {
    case "left":
      return [1.2 - 1.4 * p, 0.35];
    case "down":
      return [0.4, sweep];
    case "up":
      return [0.4, 1.2 - 1.4 * p];
    case "diagonal":
      return [sweep, sweep];
    case "center":
      return [0.5, 0.5];
    default:
      return [sweep, 0.35];
  }
}

export const withAlpha = (hex: string, alpha: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

// `hex` mixed toward white by `t`.
export const lighten = (hex: string, t: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
};

const smoothstep = (x: number) => {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
};

// The sweep's travel coordinate g (0 where it starts, 1 where it leaves) for a point (u, v).
const sweepAxis = (direction: LeakDirection | undefined): "up" | "down" | "left" | "right" =>
  direction === "down" || direction === "left" || direction === "right" ? direction : "up";

// Sizes the fx canvas to the frame (device pixels) and returns a context in frame CSS px.
function fxContext(fx: HTMLCanvasElement, W: number, H: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(W * dpr));
  const h = Math.max(1, Math.round(H * dpr));
  if (fx.width !== w || fx.height !== h) {
    fx.width = w;
    fx.height = h;
  }
  const ctx = fx.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return ctx;
}

export function renderTransitionFrame(type: TransitionType | null, look: TransitionLook, p: number, els: TransitionElements, g: TransitionGeometry): void {
  const { mover, black, glow, pixel, fx } = els;
  const { L, T, W, H, containerW, containerH } = g;
  const R = containerW - L - W;
  const B = containerH - T - H;
  const cx = L + W / 2;
  const cy = T + H / 2;
  const strength = Math.max(0.1, Math.min(1.5, look.intensity ?? 1));

  mover.style.opacity = "1";
  mover.style.transform = "";
  mover.style.transformOrigin = "";
  mover.style.clipPath = "";
  for (const prefix of ["", "-webkit-"]) for (const prop of ["mask-image", "mask-size", "mask-position", "mask-repeat"]) mover.style.setProperty(prefix + prop, "");
  mover.style.filter = "";
  black.style.opacity = "0";
  glow.style.opacity = "0";
  glow.style.mixBlendMode = "screen";
  if (pixel) pixel.style.display = "none";
  if (fx) fx.style.display = "none";

  if (isCanvasTransition(type)) {
    // Composited whole from both pictures on the fx canvas, which covers the frame.
    const pics = els.pictures?.() ?? null;
    const ctx = pics && fx ? fxContext(fx, W, H) : null;
    if (!pics || !fx || !ctx) return;
    fx.style.display = "block";
    mover.style.opacity = "0";
    drawCanvasTransition(ctx, type, look, p, pics, W, H, window.devicePixelRatio || 1);
    return;
  }

  switch (type) {
    case null:
      // No transition: a straight cut halfway through (the picker's "None" tile).
      mover.style.opacity = p < 0.5 ? "1" : "0";
      break;
    case "fadeblack":
      // Out to black over the first half, black out over the second (xfade fadeblack).
      if (p < 0.5) black.style.opacity = String(p * 2);
      else {
        mover.style.opacity = "0";
        black.style.opacity = String(2 - p * 2);
      }
      break;
    case "fadewhite": {
      const color = look.color ?? "#ffffff";
      if (color.toLowerCase() === "#ffffff" && look.intensity === undefined) {
        // Out to white over the first half, white out over the second (xfade fadewhite).
        glow.style.background = "#ffffff";
        if (p < 0.5) glow.style.opacity = String(p * 2);
        else {
          mover.style.opacity = "0";
          glow.style.opacity = String(2 - p * 2);
        }
      } else {
        // Crossfade washed in the flash colour at its peak (the export's glow pass).
        mover.style.opacity = String(1 - p);
        glow.style.background = color;
        glow.style.mixBlendMode = color.toLowerCase() === "#000000" ? "normal" : "screen";
        glow.style.opacity = String(Math.min(1, strength * Math.sin(Math.PI * p)));
      }
      break;
    }
    case "lightleak": {
      // Crossfade under a coloured burn whose hot spot travels across, white-hot at its peak.
      mover.style.opacity = String(1 - p);
      const [sx, sy] = leakSpot(look.direction, p);
      const size = Math.max(0.3, Math.min(2.5, look.size ?? 1));
      const color = look.color ?? "#ff7a2e";
      glow.style.background = [
        `radial-gradient(ellipse ${0.83 * size * W}px ${0.83 * size * H}px at ${sx * 100}% ${sy * 100}%, rgba(255,252,240,1) 0%, ${withAlpha(color, 0.95)} 35%, ${withAlpha(color, 0)} 100%)`,
        `linear-gradient(${withAlpha(color, 0.5)}, ${withAlpha(color, 0.5)})`,
      ].join(", ");
      glow.style.opacity = String(Math.min(1, Math.sin(Math.PI * p) * 1.15 * strength));
      break;
    }
    case "whip": {
      // A sideways smear through a white flash.
      mover.style.opacity = String(1 - p);
      mover.style.transform = `translateX(${-W * 0.3 * p}px)`;
      mover.style.filter = `blur(${Math.sin(Math.PI * p) * W * 0.03}px)`;
      glow.style.background = "#ffffff";
      glow.style.opacity = String(Math.min(1, 0.8 * strength * Math.sin(Math.PI * p) ** 2));
      break;
    }
    case "zoomblur": {
      // The outgoing frame rushes at the camera, smeared, through a soft white flash - and the new
      // clip is already there behind it. (Export blurs by mixing successive zoom steps, so the
      // smear grows with the zoom's speed.)
      const z = 1 + 1.6 * p * p;
      mover.style.transformOrigin = `${cx}px ${cy}px`;
      mover.style.transform = `scale(${z})`;
      mover.style.filter = `blur(${p * W * 0.012 * strength}px)`;
      mover.style.opacity = String(1 - p);
      glow.style.background = "#ffffff";
      glow.style.opacity = String(Math.min(1, 0.35 * strength * Math.sin(Math.PI * p) ** 2));
      break;
    }
    case "colorsweep": {
      // A colour panel slides across - one frame plus a lighter band at each end long, so its
      // leading edge has covered the old clip by the midpoint and its trailing edge uncovers the
      // new one after. Travel coordinate g runs 0..1 in the sweep's direction.
      const a = SWEEP_ACCENT;
      const lead = (2 + 2 * a) * smoothstep(p);
      const trail = lead - 1 - 2 * a;
      if (p >= 0.5) mover.style.opacity = "0";
      const ctx = fx && fxContext(fx, W, H);
      if (!fx || !ctx) break;
      fx.style.display = "block";
      const color = look.color ?? DEFAULT_SWEEP_COLOR;
      const accent = lighten(color, 0.55);
      const axis = sweepAxis(look.direction);
      // A band [g0, g1] of the travel axis -> a rect in frame px.
      const band = (g0: number, g1: number, style: string) => {
        const lo = Math.max(0, g0);
        const hi = Math.min(1, g1);
        if (hi <= lo) return;
        ctx.fillStyle = style;
        if (axis === "up") ctx.fillRect(0, H * (1 - hi), W, H * (hi - lo));
        else if (axis === "down") ctx.fillRect(0, H * lo, W, H * (hi - lo));
        else if (axis === "right") ctx.fillRect(W * lo, 0, W * (hi - lo), H);
        else ctx.fillRect(W * (1 - hi), 0, W * (hi - lo), H);
      };
      band(trail, trail + a, accent);
      band(trail + a, lead - a, color);
      band(lead - a, lead, accent);
      break;
    }
    case "horzopen": {
      // The incoming clip opens out of a line through the middle - horizontal, or vertical (doors).
      const vertical = look.orientation === "vertical";
      const span = vertical ? W : H;
      const mid = vertical ? cx : cy;
      const soft = span * 0.04;
      const band = p * (span / 2 + soft);
      const a = mid - band;
      const b = mid + band;
      const mask = `linear-gradient(to ${vertical ? "right" : "bottom"}, #000 ${a}px, transparent ${a + soft}px, transparent ${Math.max(a + soft, b - soft)}px, #000 ${b}px)`;
      mover.style.setProperty("mask-image", mask);
      mover.style.setProperty("-webkit-mask-image", mask);
      break;
    }
    case "wipeleft":
    case "wiperight": {
      const left = type === "wipeleft";
      const S = wipeSoftness(look) * W;
      if (S < 0.5) {
        mover.style.clipPath = left ? `inset(${T}px ${R + W * p}px ${B}px ${L}px)` : `inset(${T}px ${R}px ${B}px ${L + W * p}px)`;
        break;
      }
      // A soft edge S wide, travelling far enough to clear the frame at both ends.
      const e = L + (left ? (1 - p) * (W + S) : p * (W + S)) - S / 2;
      const mask = left
        ? `linear-gradient(to right, #000 ${e - S / 2}px, transparent ${e + S / 2}px)`
        : `linear-gradient(to right, transparent ${e - S / 2}px, #000 ${e + S / 2}px)`;
      mover.style.clipPath = `inset(${T}px ${R}px ${B}px ${L}px)`;
      mover.style.setProperty("mask-image", mask);
      mover.style.setProperty("-webkit-mask-image", mask);
      break;
    }
    case "slideleft":
      mover.style.transform = `translateX(${-W * p}px)`;
      break;
    case "slideright":
      mover.style.transform = `translateX(${W * p}px)`;
      break;
    case "circleopen": {
      const S = circleSoftness(look) * Math.hypot(W, H);
      const radius = p * (Math.hypot(W, H) / 2 + S) - S / 2;
      const mask = `radial-gradient(circle at ${cx}px ${cy}px, transparent ${radius - S / 2}px, #000 ${radius + Math.max(1, S / 2)}px)`;
      mover.style.setProperty("mask-image", mask);
      mover.style.setProperty("-webkit-mask-image", mask);
      break;
    }
    case "radial": {
      // A clock hand sweeping round from 12 o'clock, its edge A degrees soft.
      const A = radialSoftness(look);
      const angle = p * (360 + A) - A / 2;
      const mask =
        look.direction === "left"
          ? `conic-gradient(from 0deg at ${cx}px ${cy}px, #000 ${360 - angle - A / 2}deg, transparent ${360 - angle + A / 2}deg)`
          : `conic-gradient(from 0deg at ${cx}px ${cy}px, transparent ${angle - A / 2}deg, #000 ${angle + A / 2}deg)`;
      mover.style.setProperty("mask-image", mask);
      mover.style.setProperty("-webkit-mask-image", mask);
      break;
    }
    case "zoomin":
      mover.style.transformOrigin = `${cx}px ${cy}px`;
      mover.style.transform = `scale(${1 + p})`;
      mover.style.opacity = String(1 - p);
      break;
    case "pixelize": {
      // Coarsens toward the midpoint, then hands over to the new clip.
      if (p >= 0.5 || !pixel) {
        mover.style.opacity = "0";
        break;
      }
      const block = 1 + (Math.max(2, W * PIXELIZE_MAX_BLOCK_FRACTION * lookSize(look)) - 1) * Math.min(1, p * 2);
      const w = Math.max(1, Math.round(W / block));
      const h = Math.max(1, Math.round(H / block));
      if (pixel.width !== w || pixel.height !== h) {
        pixel.width = w;
        pixel.height = h;
      }
      const ctx = pixel.getContext("2d");
      if (ctx) {
        // Block averages, like ffmpeg's pixelize - not a single nearest sample.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(els.source, 0, 0, w, h);
      }
      pixel.style.display = "block";
      break;
    }
    case "dissolve": {
      const mask = `url(${dissolveMask(W, H, p, Math.round(DISSOLVE_COLS / lookSize(look)))})`;
      mover.style.setProperty("mask-image", mask);
      mover.style.setProperty("-webkit-mask-image", mask);
      for (const prefix of ["", "-webkit-"]) {
        mover.style.setProperty(`${prefix}mask-size`, `${W}px ${H}px`);
        mover.style.setProperty(`${prefix}mask-position`, `${L}px ${T}px`);
        mover.style.setProperty(`${prefix}mask-repeat`, "no-repeat");
      }
      break;
    }
    default:
      // fade
      mover.style.opacity = String(1 - p);
  }
}
