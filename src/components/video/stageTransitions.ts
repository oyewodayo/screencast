// components/video/stageTransitions.ts
//
// One moment of a transition between two whole pictures on a canvas - for the "Create a video"
// stage (NewVideoProjectDialog), which plays a style before any project exists. The transitions
// that move both pictures are transitionCanvas.ts's own drawing; the ones the player draws with
// DOM layers (transitionFrame.ts) - flashes, light leak, whip, zoom blur, slides, wipes - follow
// the same maths here on canvas, so the stage shows what the editor and export will do.
import type { TransitionType } from "../../utils/videoEditTypes";
import { drawCanvasTransition, isCanvasTransition } from "./transitionCanvas";

// Transitions the stage can draw.
const STAGE_TRANSITIONS = new Set<string>(["fade", "fadeblack", "fadewhite", "whip", "zoomblur", "lightleak", "slideleft", "slideright", "wipeleft", "wiperight"]);
export const stageCanDraw = (type: TransitionType): boolean => isCanvasTransition(type) || STAGE_TRANSITIONS.has(type);

const smooth = (x: number) => x * x * (3 - 2 * x);

// `ctx` is untransformed and W x H device pixels; `dpr` scales the canvas-transition drawing.
export function drawStageTransition(ctx: CanvasRenderingContext2D, type: TransitionType, p: number, old: HTMLCanvasElement, next: HTMLCanvasElement, W: number, H: number, dpr: number): void {
  if (isCanvasTransition(type)) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCanvasTransition(ctx, type, {}, p, { old, next }, W / dpr, H / dpr, dpr);
    ctx.restore();
    return;
  }
  const flash = (color: string, alpha: number, blend: GlobalCompositeOperation = "source-over") => {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = blend;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  };
  const fadeOver = (alpha: number) => {
    ctx.drawImage(next, 0, 0);
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.drawImage(old, 0, 0);
    ctx.globalAlpha = 1;
  };
  switch (type) {
    case "fadeblack":
    case "fadewhite": {
      // Out to the colour over the first half, the colour out over the second (xfade).
      ctx.drawImage(p < 0.5 ? old : next, 0, 0);
      flash(type === "fadeblack" ? "#000000" : "#ffffff", p < 0.5 ? p * 2 : 2 - p * 2);
      return;
    }
    case "whip": {
      // A sideways smear through a white flash.
      ctx.drawImage(next, 0, 0);
      ctx.save();
      ctx.globalAlpha = 1 - p;
      ctx.filter = `blur(${Math.sin(Math.PI * p) * W * 0.03}px)`;
      ctx.drawImage(old, -W * 0.3 * p, 0);
      ctx.restore();
      flash("#ffffff", 0.8 * Math.sin(Math.PI * p) ** 2);
      return;
    }
    case "zoomblur": {
      // The outgoing picture rushes at the camera, smeared, through a soft flash.
      ctx.drawImage(next, 0, 0);
      const z = 1 + 1.6 * p * p;
      ctx.save();
      ctx.globalAlpha = 1 - p;
      ctx.filter = `blur(${p * W * 0.012}px)`;
      ctx.translate(W / 2, H / 2);
      ctx.scale(z, z);
      ctx.drawImage(old, -W / 2, -H / 2);
      ctx.restore();
      flash("#ffffff", 0.35 * Math.sin(Math.PI * p) ** 2);
      return;
    }
    case "lightleak": {
      // A crossfade under a warm burn whose hot spot travels across, white-hot at its peak.
      fadeOver(1 - p);
      const a = Math.min(1, Math.sin(Math.PI * p) * 1.15);
      if (a <= 0) return;
      const sx = (-0.2 + 1.4 * p) * W;
      const sy = 0.35 * H;
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = a;
      ctx.fillStyle = "rgba(255,122,46,0.5)";
      ctx.fillRect(0, 0, W, H);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 0.83 * Math.max(W, H));
      g.addColorStop(0, "rgba(255,252,240,1)");
      g.addColorStop(0.35, "rgba(255,122,46,0.95)");
      g.addColorStop(1, "rgba(255,122,46,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      return;
    }
    case "slideleft":
    case "slideright": {
      const d = type === "slideleft" ? -1 : 1;
      const x = smooth(p) * W * d;
      ctx.drawImage(old, x, 0);
      ctx.drawImage(next, x - d * W, 0);
      return;
    }
    case "wipeleft":
    case "wiperight": {
      ctx.drawImage(old, 0, 0);
      const w = p * W;
      ctx.save();
      ctx.beginPath();
      if (type === "wipeleft") ctx.rect(W - w, 0, w, H);
      else ctx.rect(0, 0, w, H);
      ctx.clip();
      ctx.drawImage(next, 0, 0);
      ctx.restore();
      return;
    }
    default:
      fadeOver(1 - p);
  }
}
