// utils/screenStyle.ts
//
// The "Screen Studio" frame around a screen recording: the video shrunk into the frame with padding
// around it, on a wallpaper (gradient, colour or picture), with rounded corners and a soft shadow.
//
// Both renderers use ONE picture: the backdrop with a rounded hole where the video shows through
// (drawScreenBackdrop) - wallpaper, shadow and the hole's anti-aliased corners all in it. The
// preview lays it over the edited picture, which it lays out inside the hole (screenContentRect);
// the export scales and pads the composited picture the same way and overlays the same backdrop
// (screen_style_chain, conversion.rs). So the frame is identical in both, by construction.
//
// The frame goes around the WHOLE edited picture at the final frame's size - clips, video layers,
// blur regions, pictures, text and adjustment layers shrink into it together, so nothing placed on
// the video moves off what it covers when the style is turned on or the padding changes. Only the
// shortcut chips and captions sit on the frame itself.
import { invoke } from "@tauri-apps/api/core";
import { coverRect } from "./cutoutBackground";

export type ScreenBackground = { kind: "gradient"; preset: string } | { kind: "color"; color: string } | { kind: "image"; path: string };

export interface ScreenStyle {
  background: ScreenBackground;
  // Space around the video, as a fraction of the frame's shorter side (0..0.3).
  padding: number;
  // Corner radius, as a fraction of the frame's shorter side (0..0.1).
  radius: number;
  // Shadow strength 0..1.
  shadow: number;
}

export const DEFAULT_SCREEN_STYLE: ScreenStyle = {
  background: { kind: "gradient", preset: "dusk" },
  padding: 0.07,
  radius: 0.022,
  shadow: 0.6,
};

interface GradientSpec {
  id: string;
  label: string;
  // CSS linear-gradient angle (0 = up, 90 = right) and its colour stops.
  angle: number;
  stops: string[];
  // Soft glows over it: centre (fractions of the frame), radius (fraction of its longer side).
  glows?: { x: number; y: number; r: number; color: string; alpha: number }[];
}

export const SCREEN_GRADIENTS: GradientSpec[] = [
  { id: "dusk", label: "Dusk", angle: 135, stops: ["#312e81", "#7c3aed", "#db2777"], glows: [{ x: 0.15, y: 0.15, r: 0.55, color: "#60a5fa", alpha: 0.55 }, { x: 0.9, y: 0.95, r: 0.6, color: "#fb7185", alpha: 0.5 }] },
  { id: "ocean", label: "Ocean", angle: 160, stops: ["#0c4a6e", "#0891b2", "#34d399"], glows: [{ x: 0.85, y: 0.1, r: 0.5, color: "#a5f3fc", alpha: 0.45 }] },
  { id: "peach", label: "Peach", angle: 135, stops: ["#fed7aa", "#fda4af", "#c4b5fd"], glows: [{ x: 0.1, y: 0.9, r: 0.55, color: "#fef3c7", alpha: 0.6 }] },
  { id: "mint", label: "Mint", angle: 135, stops: ["#ecfccb", "#a7f3d0", "#67e8f9"], glows: [{ x: 0.85, y: 0.2, r: 0.45, color: "#ffffff", alpha: 0.4 }] },
  { id: "sunset", label: "Sunset", angle: 180, stops: ["#f97316", "#db2777", "#4c1d95"], glows: [{ x: 0.5, y: 0.0, r: 0.6, color: "#fde68a", alpha: 0.45 }] },
  { id: "aurora", label: "Aurora", angle: 120, stops: ["#022c22", "#065f46", "#0e7490"], glows: [{ x: 0.25, y: 0.25, r: 0.5, color: "#34d399", alpha: 0.45 }, { x: 0.8, y: 0.7, r: 0.5, color: "#818cf8", alpha: 0.45 }] },
  { id: "lavender", label: "Lavender", angle: 135, stops: ["#ede9fe", "#ddd6fe", "#fbcfe8"], glows: [{ x: 0.8, y: 0.85, r: 0.5, color: "#c4b5fd", alpha: 0.5 }] },
  { id: "sky", label: "Sky", angle: 180, stops: ["#7dd3fc", "#bae6fd", "#f0f9ff"] },
  { id: "citrus", label: "Citrus", angle: 135, stops: ["#fef08a", "#fb923c", "#f43f5e"] },
  { id: "forest", label: "Forest", angle: 150, stops: ["#052e16", "#166534", "#65a30d"], glows: [{ x: 0.85, y: 0.15, r: 0.45, color: "#bef264", alpha: 0.3 }] },
  { id: "graphite", label: "Graphite", angle: 145, stops: ["#0b0f19", "#1f2937", "#374151"], glows: [{ x: 0.5, y: 0.0, r: 0.7, color: "#64748b", alpha: 0.35 }] },
  { id: "midnight", label: "Midnight", angle: 135, stops: ["#020617", "#1e293b", "#312e81"], glows: [{ x: 0.85, y: 0.15, r: 0.5, color: "#6366f1", alpha: 0.4 }] },
];

export const SCREEN_COLOR_SWATCHES = ["#0f172a", "#f8fafc", "#e5e7eb", "#111827", "#1e3a8a", "#7c3aed", "#db2777", "#f59e0b", "#059669", "#0ea5e9"];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));

export interface ContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

// Where the video goes in a W x H frame, in whole pixels (even, as the export's 4:2:0 encode needs):
// the frame scaled down, centred, so the padding is at least `padding` on every side.
export function screenContentRect(W: number, H: number, style: ScreenStyle): ContentRect {
  const short = Math.min(W, H);
  const pad = clamp(style.padding, 0, 0.3) * short;
  const s = clamp(Math.min((W - 2 * pad) / W, (H - 2 * pad) / H), 0.1, 1);
  const width = Math.min(W, even(W * s));
  const height = Math.min(H, even(H * s));
  const x = Math.max(0, 2 * Math.round((W - width) / 4));
  const y = Math.max(0, 2 * Math.round((H - height) / 4));
  const radius = Math.min(clamp(style.radius, 0, 0.1) * short, width / 2, height / 2);
  return { x, y, width, height, radius };
}

const hexRgba = (hex: string, alpha: number): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0;
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
};

// A CSS linear-gradient's line for `angle` across a w x h box.
function gradientLine(angle: number, w: number, h: number): [number, number, number, number] {
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return [w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half];
}

export function paintGradient(ctx: CanvasRenderingContext2D, spec: GradientSpec, w: number, h: number): void {
  const g = ctx.createLinearGradient(...gradientLine(spec.angle, w, h));
  spec.stops.forEach((c, i) => g.addColorStop(spec.stops.length === 1 ? 0 : i / (spec.stops.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (const glow of spec.glows ?? []) {
    const r = glow.r * Math.max(w, h);
    const rg = ctx.createRadialGradient(glow.x * w, glow.y * h, 0, glow.x * w, glow.y * h, r);
    rg.addColorStop(0, hexRgba(glow.color, glow.alpha));
    rg.addColorStop(1, hexRgba(glow.color, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
}

export const gradientById = (id: string): GradientSpec => SCREEN_GRADIENTS.find((g) => g.id === id) ?? SCREEN_GRADIENTS[0];

// A picture background, loaded once per path (as a data URL, so canvases stay untainted).
const pictures = new Map<string, Promise<HTMLImageElement | null>>();
export function loadBackgroundPicture(path: string): Promise<HTMLImageElement | null> {
  let p = pictures.get(path);
  if (!p) {
    p = invoke<string>("read_image_data_url", { path })
      .then(
        (url) =>
          new Promise<HTMLImageElement | null>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = url;
          })
      )
      .catch(() => null);
    pictures.set(path, p);
  }
  return p;
}

// Paints the whole backdrop onto a canvas of exactly W x H: wallpaper, the content's shadow, and a
// transparent rounded hole where the video shows. `picture` is the loaded background picture for an
// image background (a missing one paints the default gradient).
export function drawScreenBackdrop(ctx: CanvasRenderingContext2D, W: number, H: number, style: ScreenStyle, picture: HTMLImageElement | null): void {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  const bg = style.background;
  if (bg.kind === "color") {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
  } else if (bg.kind === "image" && picture) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const r = coverRect(W, H, picture.naturalWidth, picture.naturalHeight);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(picture, r.left, r.top, r.width, r.height);
  } else {
    paintGradient(ctx, gradientById(bg.kind === "gradient" ? bg.preset : "dusk"), W, H);
  }
  const rect = screenContentRect(W, H, style);
  const short = Math.min(W, H);
  const k = clamp(style.shadow, 0, 1);
  if (k > 0) {
    // Only the shadow lands on the canvas: the shape itself is drawn far off to the left and the
    // shadow offset back by as much.
    const away = W + H + 1000;
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${(0.2 + 0.35 * k).toFixed(3)})`;
    ctx.shadowBlur = k * 0.07 * short;
    ctx.shadowOffsetX = away;
    ctx.shadowOffsetY = k * 0.02 * short;
    ctx.beginPath();
    ctx.roundRect(rect.x - away, rect.y, rect.width, rect.height, rect.radius);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
  }
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, rect.radius);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();
}

// What export_trimmed_video takes (ScreenStyleSpec): the backdrop at the timeline's size and where
// the video goes in it.
export async function screenStyleForExport(style: ScreenStyle, W: number, H: number): Promise<{ backdropBase64: string; x: number; y: number; width: number; height: number } | null> {
  if (!(W > 0 && H > 0)) return null;
  const picture = style.background.kind === "image" ? await loadBackgroundPicture(style.background.path) : null;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawScreenBackdrop(ctx, W, H, style, picture);
  const rect = screenContentRect(W, H, style);
  return { backdropBase64: canvas.toDataURL("image/png"), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
