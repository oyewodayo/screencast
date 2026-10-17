// utils/adjustmentLayers.ts
//
// Adjustment layers (AdjustmentLayer, videoEditTypes.ts): one grade/blur applied to everything
// beneath it for a stretch of the timeline. Everything that decides how one looks lives here and
// is shared by both renderers, so they can't drift apart:
//   - the filter list (adjustmentColorOps + blur): the preview's backdrop-filter and export's
//     colour matrix + Gaussian (adjustment_layer_chain, conversion.rs) are built from it;
//   - the region's soft-edged mask (regionAlpha): the preview draws it with CSS mask gradients,
//     export with a mask image rendered from the very same formula, pixel by pixel;
//   - the fades (fadeEnvelope): linear in both, as ffmpeg's `fade` is.

import type { CSSProperties } from "react";
import type { AdjustmentLayer, AdjustmentRegion } from "./videoEditTypes";
import { CssColorOp, colorPresetOps, cssFilterFromOps, vignetteBackground } from "./videoColorFilters";

export const DEFAULT_ADJUSTMENT_SECONDS = 5;
// Blur slider's top end, as a fraction of the frame's height (~43 px of sigma at 1080p).
export const MAX_ADJUSTMENT_BLUR = 0.04;
// Feather below this many pixels is a hard edge (avoids dividing by ~0).
const MIN_FEATHER_PX = 0.75;

export function makeAdjustmentLayer(startTime: number, endTime: number, patch: Partial<AdjustmentLayer> = {}): AdjustmentLayer {
  const now = Date.now();
  return { id: crypto.randomUUID(), startTime, endTime, placement: "under", opacity: 1, createdAt: now, updatedAt: now, ...patch };
}

// The colour filter functions in the order the preview applies them: the look preset's own list,
// then the sliders.
export function adjustmentColorOps(layer: AdjustmentLayer): CssColorOp[] {
  const ops: CssColorOp[] = layer.look && layer.look.preset !== "none" && layer.look.preset !== "vignette" ? colorPresetOps(layer.look) : [];
  const near = (v: number | undefined, at: number) => v === undefined || Math.abs(v - at) < 1e-3;
  if (!near(layer.brightness, 1)) ops.push({ op: "brightness", value: layer.brightness! });
  if (!near(layer.contrast, 1)) ops.push({ op: "contrast", value: layer.contrast! });
  if (!near(layer.saturation, 1)) ops.push({ op: "saturate", value: layer.saturation! });
  if (!near(layer.hue, 0)) ops.push({ op: "hue-rotate", value: layer.hue! });
  return ops;
}

// The vignette strength: its own slider, or a "vignette" look.
export const adjustmentVignette = (layer: AdjustmentLayer): number =>
  layer.vignette ?? (layer.look?.preset === "vignette" ? layer.look.intensity : 0);

// Whether the layer changes anything at all.
export const adjustmentIsActive = (layer: AdjustmentLayer): boolean =>
  (layer.blur ?? 0) > 1e-4 || adjustmentColorOps(layer).length > 0 || adjustmentVignette(layer) > 1e-3;

// The preview's backdrop-filter: blur first, then colour - the order export applies them in.
export function adjustmentBackdropFilter(layer: AdjustmentLayer, frameHeightPx: number): string {
  const blur = (layer.blur ?? 0) * frameHeightPx;
  const parts = [blur > 0.05 ? `blur(${blur}px)` : "", cssFilterFromOps(adjustmentColorOps(layer))].filter(Boolean);
  // A backdrop-filter of "none" would also skip the vignette/mask layers below - keep a no-op.
  return parts.length ? parts.join(" ") : "opacity(1)";
}

// Opacity at output time `t`: the layer's own, ramped linearly in and out over its fades.
export function fadeEnvelope(layer: AdjustmentLayer, t: number): number {
  const span = Math.max(0.01, layer.endTime - layer.startTime);
  const fadeIn = Math.min(layer.fadeIn ?? 0, span / 2);
  const fadeOut = Math.min(layer.fadeOut ?? 0, span / 2);
  let k = 1;
  if (fadeIn > 0.01 && t < layer.startTime + fadeIn) k = Math.max(0, (t - layer.startTime) / fadeIn);
  if (fadeOut > 0.01 && t > layer.endTime - fadeOut) k = Math.min(k, Math.max(0, (layer.endTime - t) / fadeOut));
  return Math.max(0, Math.min(1, layer.opacity ?? 1)) * k;
}

// ---- Region mask ---------------------------------------------------------------------------
//
// alpha (0..1, before `invert`) of the frame point (px, py) in pixels, for a region on a W x H
// frame. Rectangle: a linear ramp of `feather` px in from each edge, horizontal times vertical
// (what two intersected CSS gradients give). Ellipse: linear in the ellipse's normalised radius
// over the last `feather` px of its shorter radius (what a CSS radial-gradient gives).
export function featherPx(region: AdjustmentRegion, W: number, H: number): number {
  return Math.max(MIN_FEATHER_PX, Math.max(0, Math.min(1, region.feather)) * Math.min(region.width * W, region.height * H) / 2);
}

export function regionAlpha(region: AdjustmentRegion, W: number, H: number, px: number, py: number): number {
  const x0 = region.x * W;
  const y0 = region.y * H;
  const w = region.width * W;
  const h = region.height * H;
  const f = featherPx(region, W, H);
  if (region.shape === "ellipse") {
    const rx = w / 2;
    const ry = h / 2;
    if (rx <= 0 || ry <= 0) return 0;
    const r = Math.hypot((px - x0 - rx) / rx, (py - y0 - ry) / ry);
    return Math.max(0, Math.min(1, ((1 - r) * Math.min(rx, ry)) / f));
  }
  const dx = Math.min(px - x0, x0 + w - px);
  const dy = Math.min(py - y0, y0 + h - py);
  return Math.max(0, Math.min(1, dx / f)) * Math.max(0, Math.min(1, dy / f));
}

// The preview's mask for the layer's element (which covers the region's box, or the whole frame
// when inverted - see adjustmentElementBox): CSS gradients that are regionAlpha exactly.
export function regionMaskStyle(region: AdjustmentRegion, frameW: number, frameH: number): CSSProperties {
  const w = region.width * frameW;
  const h = region.height * frameH;
  const f = featherPx(region, frameW, frameH);
  // The region's layers sit at the region's own box within the element.
  const box = region.invert ? { left: region.x * frameW, top: region.y * frameH } : { left: 0, top: 0 };
  let layers: string[];
  let sizes: string[];
  let positions: string[];
  if (region.shape === "ellipse") {
    const stop = Math.max(0, 1 - f / Math.max(1e-6, Math.min(w, h) / 2)) * 100;
    layers = [`radial-gradient(closest-side, black ${stop}%, transparent 100%)`];
    sizes = [`${w}px ${h}px`];
    positions = [`${box.left}px ${box.top}px`];
  } else {
    const fx = Math.min(f, w / 2);
    const fy = Math.min(f, h / 2);
    layers = [
      `linear-gradient(to right, transparent 0px, black ${fx}px, black ${w - fx}px, transparent ${w}px)`,
      `linear-gradient(to bottom, transparent 0px, black ${fy}px, black ${h - fy}px, transparent ${h}px)`,
    ];
    sizes = [`${w}px ${h}px`, `${w}px ${h}px`];
    positions = [`${box.left}px ${box.top}px`, `${box.left}px ${box.top}px`];
  }
  // Composited bottom-up: the region's layers intersect; inverted, a full layer on top excludes
  // them (1 - alpha).
  const composite = region.shape === "ellipse" ? ["add"] : ["intersect", "add"];
  if (region.invert) {
    layers = ["linear-gradient(black, black)", ...layers];
    sizes = ["100% 100%", ...sizes];
    positions = ["0px 0px", ...positions];
    composite.unshift("exclude");
  }
  return {
    maskImage: layers.join(", "),
    WebkitMaskImage: layers.join(", "),
    maskSize: sizes.join(", "),
    WebkitMaskSize: sizes.join(", "),
    maskPosition: positions.join(", "),
    WebkitMaskPosition: positions.join(", "),
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskComposite: composite.join(", "),
  } as CSSProperties;
}

// The pixel box (in a W x H frame) the effect covers: the region's box on even edges inside the
// frame (export crops 4:2:0 video, which only splits on even pixels), or the whole frame for a
// full-frame or inverted layer.
export function adjustmentPixelBox(region: AdjustmentRegion | undefined, W: number, H: number): { x: number; y: number; width: number; height: number } {
  if (!region || region.invert) return { x: 0, y: 0, width: W, height: H };
  const even = (v: number) => Math.floor(v / 2) * 2;
  const x0 = Math.max(0, Math.min(W - 2, even(Math.floor(region.x * W))));
  const y0 = Math.max(0, Math.min(H - 2, even(Math.floor(region.y * H))));
  const x1 = Math.min(W, Math.max(x0 + 2, even(Math.ceil((region.x + region.width) * W) + 1)));
  const y1 = Math.min(H, Math.max(y0 + 2, even(Math.ceil((region.y + region.height) * H) + 1)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// The element box (fractions of the frame) the preview draws the layer in - the region's own box,
// or the whole frame when there's no region or it's inverted.
export function adjustmentElementBox(layer: AdjustmentLayer): { x: number; y: number; width: number; height: number } {
  const r = layer.region;
  return !r || r.invert ? { x: 0, y: 0, width: 1, height: 1 } : { x: r.x, y: r.y, width: r.width, height: r.height };
}

// Export's mask image for a region: grey levels = regionAlpha at each pixel centre (inverted for
// an inverted region), over adjustmentPixelBox. Null for a full-frame layer.
export function renderAdjustmentMask(region: AdjustmentRegion | undefined, W: number, H: number): { dataUrl: string; x: number; y: number } | null {
  if (!region) return null;
  const box = adjustmentPixelBox(region, W, H);
  const canvas = document.createElement("canvas");
  canvas.width = box.width;
  canvas.height = box.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(box.width, box.height);
  const data = image.data;
  for (let j = 0; j < box.height; j++) {
    for (let i = 0; i < box.width; i++) {
      let a = regionAlpha(region, W, H, box.x + i + 0.5, box.y + j + 0.5);
      if (region.invert) a = 1 - a;
      const v = Math.round(a * 255);
      const k = (j * box.width + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = v;
      data[k + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { dataUrl: canvas.toDataURL("image/png"), x: box.x, y: box.y };
}

// What export_trimmed_video's AdjustmentLayerSpec needs, at the final W x H frame.
export interface AdjustmentLayerExport {
  startTime: number;
  endTime: number;
  placement: "under" | "over";
  colorOps: CssColorOp[];
  blurSigma?: number;
  vignette?: number;
  opacity: number;
  fadeIn: number;
  fadeOut: number;
  maskDataBase64?: string;
  maskX: number;
  maskY: number;
}

export function adjustmentLayerExport(layer: AdjustmentLayer, W: number, H: number): AdjustmentLayerExport | null {
  if (!adjustmentIsActive(layer) || (layer.opacity ?? 1) <= 0.001) return null;
  const mask = renderAdjustmentMask(layer.region, W, H);
  const vignette = adjustmentVignette(layer);
  const blur = (layer.blur ?? 0) * H;
  return {
    startTime: layer.startTime,
    endTime: layer.endTime,
    placement: layer.placement,
    colorOps: adjustmentColorOps(layer),
    blurSigma: blur > 0.05 ? blur : undefined,
    vignette: vignette > 1e-3 ? vignette : undefined,
    opacity: Math.max(0, Math.min(1, layer.opacity ?? 1)),
    fadeIn: layer.fadeIn ?? 0,
    fadeOut: layer.fadeOut ?? 0,
    maskDataBase64: mask?.dataUrl,
    maskX: mask?.x ?? 0,
    maskY: mask?.y ?? 0,
  };
}

// The vignette's CSS (drawn on the layer's element, over its filtered backdrop).
export const adjustmentVignetteBackground = (layer: AdjustmentLayer): string | undefined => {
  const v = adjustmentVignette(layer);
  return v > 1e-3 ? vignetteBackground(v) : undefined;
};
