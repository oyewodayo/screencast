// utils/clipFx.ts
//
// Clip effects - what happens to a clip's whole picture over its life, on top of its look: echo
// (blurred ghost copies swaying either side), RGB split, colour cycle (the hue stepping round on a
// beat), focus in (opens out of a blur), colour in (black and white flowing into colour), flicker
// (old-projector brightness). One definition per effect, drawn here for the live preview
// (ClipFxLayer, and transitions that paint the clip) and mirrored filter for filter by export
// (services/clip_fx.rs) - every curve below is that file's too.
//
// Time `t` is seconds since the clip started, on the output timeline (the clip's own speed applied).
import type { ClipFx, ClipFxKind } from "./videoEditTypes";
import { drawRgbSplit, indexHash, smooth } from "../components/video/transitionCanvas";

export const CLIP_FX: { value: ClipFxKind; label: string; title: string }[] = [
  { value: "echo", label: "Echo", title: "Soft ghost copies swaying either side" },
  { value: "rgbsplit", label: "RGB split", title: "Red and blue pulled apart - chromatic aberration" },
  { value: "huecycle", label: "Colour cycle", title: "The colours step round the wheel on a beat" },
  { value: "focus", label: "Focus in", title: "Opens out of a blur as the clip starts" },
  { value: "colorin", label: "Colour in", title: "Black and white flowing into colour" },
  { value: "flicker", label: "Flicker", title: "Old-projector brightness flicker" },
];

export const DEFAULT_CLIP_FX_INTENSITY = 0.6;

export const hasClipFx = (fx: ClipFx | undefined): fx is ClipFx => !!fx && fx.intensity > 0 && CLIP_FX.some((f) => f.value === fx.kind);

const k01 = (fx: ClipFx) => Math.max(0, Math.min(1, fx.intensity));

// ---------- curves (mirrored in clip_fx.rs) ----------

export const echoOffset = (t: number, W: number, k: number) => W * (0.06 + 0.06 * k) * (1 + 0.25 * Math.sin((2 * Math.PI * t) / 1.6));
export const echoBlur = (W: number, H: number) => 0.012 * Math.min(W, H);
export const echoAlpha = (k: number) => 0.22 + 0.2 * k;
export const rgbSplitShift = (W: number, k: number) => Math.round((0.004 + 0.012 * k) * W);
export const HUE_STEP_SEC = 0.3;
export const hueStepAngle = (t: number) => (Math.floor(Math.max(0, t) / HUE_STEP_SEC) * 60) % 360;
export const HUE_SATURATE = 1.25;
export const FOCUS_SEC = 0.8;
export const focusBlur = (t: number, W: number, H: number, k: number) => 0.035 * Math.min(W, H) * (0.4 + 0.6 * k) * (1 - smooth(t / FOCUS_SEC));
export const colorInSeconds = (k: number) => 0.6 + 1.0 * k;
export const colorInGray = (t: number, k: number) => 1 - smooth(t / colorInSeconds(k));
export const FLICKER_FPS = 12;
export const flickerBrightness = (t: number, k: number) => {
  const step = Math.floor(Math.max(0, t) * FLICKER_FPS);
  const dip = indexHash(step * 3.7) > 0.92 ? 0.15 * k : 0;
  return 1 + 0.12 * k * (indexHash(step) - 0.5) * 2 - dip;
};

// ---------- drawing ----------

const scratch: HTMLCanvasElement[] = [];
function scratchCanvas(i: number, w: number, h: number): HTMLCanvasElement {
  scratch[i] ??= document.createElement("canvas");
  const c = scratch[i];
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

// Draws `pic` (the clip's picture, w x h device px) through `fx` at `t` into `ctx` (device px, no
// transform). W, H: the frame in frame px (what sizes are measured against); dpr: device px per
// frame px.
export function drawClipFx(ctx: CanvasRenderingContext2D, fx: ClipFx, pic: CanvasImageSource, t: number, w: number, h: number, W: number, H: number, dpr: number): void {
  const k = k01(fx);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.drawImage(pic, 0, 0, w, h);
  switch (fx.kind as ClipFxKind) {
    case "echo": {
      const dx = echoOffset(t, W, k) * dpr;
      ctx.globalAlpha = echoAlpha(k);
      ctx.filter = `blur(${echoBlur(W, H) * dpr}px)`;
      ctx.drawImage(pic, dx, 0, w, h);
      ctx.drawImage(pic, -dx, 0, w, h);
      break;
    }
    case "rgbsplit": {
      const copy = scratchCanvas(0, w, h);
      copy.getContext("2d")!.drawImage(pic, 0, 0, w, h);
      drawRgbSplit(ctx, copy, rgbSplitShift(W, k) * dpr, w, h);
      break;
    }
    case "huecycle": {
      // The cycled picture mixed over the original by the intensity (export: the same mix of the
      // two colour matrices).
      ctx.globalAlpha = k;
      ctx.filter = `hue-rotate(${hueStepAngle(t)}deg) saturate(${HUE_SATURATE})`;
      ctx.drawImage(pic, 0, 0, w, h);
      break;
    }
    case "focus": {
      const blur = focusBlur(t, W, H, k);
      if (blur > 0.05) {
        // Blurred over an opaque copy, so the edges don't go see-through.
        ctx.filter = `blur(${blur * dpr}px)`;
        ctx.drawImage(pic, 0, 0, w, h);
      }
      break;
    }
    case "colorin": {
      const g = colorInGray(t, k);
      if (g > 0.001) {
        ctx.filter = `grayscale(${g})`;
        ctx.drawImage(pic, 0, 0, w, h);
      }
      break;
    }
    case "flicker": {
      ctx.filter = `brightness(${flickerBrightness(t, k)})`;
      ctx.drawImage(pic, 0, 0, w, h);
      break;
    }
  }
  ctx.restore();
}

// The "vignette" colour preset's layer (vignetteBackground, videoColorFilters.ts) drawn on a canvas:
// an ellipse through the corners, clear to (40 - 15i)%, then darkening to 0.6i black at the corners.
export function drawVignette(ctx: CanvasRenderingContext2D, intensity: number, w: number, h: number): void {
  const t = Math.max(0, Math.min(1, intensity));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(w / 2, h / 2);
  ctx.scale(1, h / w);
  const r = (w / 2) * Math.SQRT2;
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(Math.max(0, (40 - 15 * t) / 100), "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${0.6 * t})`);
  ctx.fillStyle = g;
  ctx.fillRect(-w / 2, -w / 2, w, w);
  ctx.restore();
}
