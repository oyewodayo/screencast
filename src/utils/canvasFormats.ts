// utils/canvasFormats.ts
//
// The canvas: the shape and size the edit is made in and exported at - the open video's own, a
// platform's (TikTok / Reels / Shorts, an Instagram post, square, YouTube) or a phone's whole
// screen. With one set, the timeline behaves exactly like a project's frame (videoEditTypes'
// VideoProjectFrame): every clip is fitted into it (letterboxed, never stretched - playerFraming in
// the preview, frame_fit_chain in export), its crop and Ken Burns work in the canvas, and every
// layer is laid out on it - so what the editor shows is what the file will be.
//
// Changing the canvas keeps the edit as it looks: the old frame lands in the new one the way a
// clip does (fitted, centred), and every layer goes with it - same shape, same place on the
// picture (remapLayers). Split screens are laid out afresh to fill the new shape instead
// (relayoutSplitGroups, splitGroups.ts).
import type { AdjustmentLayer, BlurOverlay, ImageOverlay, PipOverlay, TextOverlay } from "./videoEditTypes";
import type { OverlayKeyframe } from "./keyframes";

export interface CanvasFormat {
  // The preset it came from (CANVAS_PRESETS) - its name and phone outline.
  preset: string;
  width: number;
  height: number;
  // Around a clip that doesn't fill the canvas: a blurred copy of it, or black bars. Undefined =
  // black (canvases chosen before there was a choice).
  background?: CanvasBackground;
}

export type CanvasBackground = "blur" | "black";

export interface CanvasPreset {
  id: string;
  label: string;
  // What it's for, under the name.
  hint: string;
  group: "social" | "phone";
  width: number;
  height: number;
  // Vertical apps' buttons and captions sit over the picture - guides for where (PhonePreview).
  appUi?: boolean;
}

// Phone sizes are the screens' own pixels, so a video made for one fills it edge to edge.
export const CANVAS_PRESETS: CanvasPreset[] = [
  { id: "vertical", label: "TikTok · Reels · Shorts", hint: "9:16 · 1080×1920", group: "social", width: 1080, height: 1920, appUi: true },
  { id: "portrait", label: "Instagram post", hint: "4:5 · 1080×1350", group: "social", width: 1080, height: 1350 },
  { id: "square", label: "Square", hint: "1:1 · 1080×1080", group: "social", width: 1080, height: 1080 },
  { id: "landscape", label: "YouTube", hint: "16:9 · 1920×1080", group: "social", width: 1920, height: 1080 },
  { id: "iphone-17", label: "iPhone 17", hint: "6.3″ · 1206×2622", group: "phone", width: 1206, height: 2622, appUi: true },
  { id: "iphone-17-pro-max", label: "iPhone 17 Pro Max", hint: "6.9″ · 1320×2868", group: "phone", width: 1320, height: 2868, appUi: true },
  { id: "iphone-air", label: "iPhone Air", hint: "6.5″ · 1260×2736", group: "phone", width: 1260, height: 2736, appUi: true },
  { id: "galaxy-s25", label: "Galaxy S25", hint: "6.2″ · 1080×2340", group: "phone", width: 1080, height: 2340, appUi: true },
  { id: "pixel-10", label: "Pixel 10", hint: "6.3″ · 1080×2424", group: "phone", width: 1080, height: 2424, appUi: true },
];

export const canvasPreset = (id: string | undefined): CanvasPreset | undefined => CANVAS_PRESETS.find((p) => p.id === id);

// A new canvas fills around the picture with a blurred copy of it - how vertical video is usually
// seen; the current choice carries over when switching canvas.
export const canvasFromPreset = (preset: CanvasPreset, background: CanvasBackground = "blur"): CanvasFormat => ({ preset: preset.id, width: preset.width, height: preset.height, background });

// "9:16", "4:5", "19.5:9"... - the shape in the terms people know it by.
export function aspectLabel(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.round(width), Math.round(height));
  const w = Math.round(width) / g;
  const h = Math.round(height) / g;
  if (w <= 32 && h <= 32) return `${w}:${h}`;
  // Phone screens: as "x:9" against the short side.
  const r = Math.max(width, height) / Math.min(width, height);
  const long = (Math.round(r * 9 * 2) / 2).toString();
  return width < height ? `9:${long}` : `${long}:9`;
}

interface Size {
  width: number;
  height: number;
}

// Where the old frame sits in the new one - fitted and centred, the way a clip is.
export function frameMapping(from: Size, to: Size) {
  const k = Math.min(to.width / from.width, to.height / from.height);
  const offX = (to.width - from.width * k) / 2 / to.width;
  const offY = (to.height - from.height * k) / 2 / to.height;
  // Fractions of the old frame -> fractions of the new one, per axis; and how a height-relative
  // size (font, padding, corner radius) scales.
  const sx = (from.width * k) / to.width;
  const sy = (from.height * k) / to.height;
  return { x: (x: number) => offX + x * sx, y: (y: number) => offY + y * sy, w: (w: number) => w * sx, h: (h: number) => h * sy, heightScale: sy };
}

type Mapping = ReturnType<typeof frameMapping>;

const mapBox = <T extends { x: number; y: number; width: number; height: number }>(o: T, m: Mapping): T => ({ ...o, x: m.x(o.x), y: m.y(o.y), width: m.w(o.width), height: m.h(o.height) });
const mapKeyframes = (keyframes: OverlayKeyframe[] | undefined, m: Mapping) => keyframes?.map((k) => ({ ...k, x: m.x(k.x), y: m.y(k.y) }));
const scaled = (v: number | undefined, s: number) => (v === undefined ? undefined : v * s);

export interface CanvasLayers {
  textOverlays: TextOverlay[];
  imageOverlays: ImageOverlay[];
  blurOverlays: BlurOverlay[];
  pipOverlays: PipOverlay[];
  adjustmentLayers: AdjustmentLayer[];
}

// Every layer, moved from a `from`-sized frame into a `to`-sized one along with the picture: same
// shape, same spot on the picture, sizes measured against the frame's height rescaled to match.
// Split-screen members are left for relayoutSplitGroups.
export function remapLayers(layers: CanvasLayers, from: Size, to: Size): CanvasLayers {
  if (from.width === to.width && from.height === to.height) return layers;
  const m = frameMapping(from, to);
  const s = m.heightScale;
  return {
    textOverlays: layers.textOverlays.map((o) => ({
      ...mapBox(o, m),
      keyframes: mapKeyframes(o.keyframes, m),
      fontSize: o.fontSize * s,
      padding: scaled(o.padding, s),
      paddingX: scaled(o.paddingX, s),
      strokeWidth: scaled(o.strokeWidth, s),
      boxBorder: o.boxBorder ? { ...o.boxBorder, width: o.boxBorder.width * s } : undefined,
    })),
    imageOverlays: layers.imageOverlays.map((o) => (o.split ? o : { ...mapBox(o, m), keyframes: mapKeyframes(o.keyframes, m), cornerRadius: scaled(o.cornerRadius, s) })),
    blurOverlays: layers.blurOverlays.map((o) => ({ ...mapBox(o, m), keyframes: mapKeyframes(o.keyframes, m), cornerRadius: scaled(o.cornerRadius, s) })),
    pipOverlays: layers.pipOverlays.map((o) => (o.split ? o : mapBox(o, m))),
    adjustmentLayers: layers.adjustmentLayers.map((l) =>
      l.region ? { ...l, region: { ...mapBox(l.region, m), keyframes: mapKeyframes(l.region.keyframes, m) } } : l
    ),
  };
}
