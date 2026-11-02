// components/video/TitleLookTile.tsx
//
// A small picture of a title look (titleStyles.ts) - drawn by export's own text renderer
// (drawTextOverlay), so a gallery tile shows exactly what picking it will put on the video: the
// face, gradient, outline, glow and shadow, not an approximation in CSS. The sample shrinks until
// it fits on one line. Optionally plays a letter reveal on a loop (style templates' cards).
import React, { useEffect, useRef } from "react";
import { loadTitleFonts, titleFontCss } from "../../utils/titleFonts";
import type { TitleLook } from "../../utils/titleStyles";
import { isTextReveal, textRevealState } from "../../utils/textReveal";
import { drawTextOverlay } from "../../utils/videoOverlayRender";
import type { OverlayAnimation, TextOverlay } from "../../utils/videoEditTypes";

interface TitleLookTileProps {
  look: TitleLook;
  text: string;
  width: number;
  height: number;
  // Loops this animation when set (seconds on screen per loop: `loopSec`).
  animation?: OverlayAnimation;
  loopSec?: number;
  className?: string;
}

// The overlay a tile draws: the look, at the largest size (up to `maxFont` of the tile's height)
// that fits on one line, centred.
export function tileOverlay(look: TitleLook, text: string, w: number, h: number, maxFont = 0.42): TextOverlay {
  const padFrac = look.padding ?? 0;
  const widthFrac = 0.86;
  let fontSize = maxFont;
  for (let i = 0; i < 24; i++) {
    if (measureLine(text, look, fontSize * h) <= widthFrac * w - 2 * padFrac * h) break;
    fontSize *= 0.9;
  }
  const boxH = fontSize * 1.3 + 2 * padFrac;
  return {
    id: "tile",
    text,
    ...look,
    color: look.color ?? "#ffffff",
    textAlign: "center",
    // The whole box, padding included (TextOverlay.width), centred in the tile.
    x: (1 - widthFrac) / 2,
    y: 0.5 - boxH / 2,
    width: widthFrac,
    height: boxH,
    fontSize,
    startTime: 0,
    endTime: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measureLine(text: string, look: TitleLook, px: number): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = titleFontCss(look.fontFamily, px);
  measureCtx.letterSpacing = `${(look.letterSpacing ?? 0) * px}px`;
  return measureCtx.measureText(text).width;
}

const TitleLookTile: React.FC<TitleLookTileProps> = ({ look, text, width, height, animation, loopSec = 2.4, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(width * dpr);
    const H = Math.round(height * dpr);
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const scratch = document.createElement("canvas");
    let raf = 0;
    let cancelled = false;
    const start = performance.now();
    const draw = (t: number) => {
      if (!ctx) return;
      const o = { ...tileOverlay(look, text, W, H), ...(animation ? { animation, endTime: loopSec } : {}) };
      const kind = isTextReveal(o.animation) ? o.animation : null;
      const local = t % (loopSec + 0.5);
      ctx.clearRect(0, 0, W, H);
      if (kind && local > loopSec) return;
      const drawn = drawTextOverlay(o, W, H, kind ? textRevealState(o.text, kind, local, loopSec, { exit: "fade" }) : undefined, scratch);
      if (drawn) ctx.drawImage(drawn.canvas, drawn.xPx, drawn.yPx);
    };
    void loadTitleFonts([look.fontFamily]).then(() => {
      if (cancelled) return;
      if (!animation) return draw(0);
      const tick = () => {
        raf = requestAnimationFrame(tick);
        draw((performance.now() - start) / 1000);
      };
      tick();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [look, text, width, height, animation, loopSec]);
  return <canvas ref={canvasRef} className={className} style={{ width, height }} />;
};

export default TitleLookTile;
