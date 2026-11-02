// components/video/KeystrokeLayer.tsx
//
// Keyboard-shortcut chips (keystrokes.ts) over the preview, on the output timeline - painted every
// animation frame by drawKeyChip, the painter the export's chip sprites come from.
import React, { useEffect, useRef } from "react";
import type { FrameRect } from "../../utils/videoFrameRect";
import { chipAt, drawKeyChip, keyChipCentre, keyChipSize, type KeyChip, type KeystrokeStyle } from "../../utils/keystrokes";

interface Props {
  frameRect: FrameRect;
  chips: KeyChip[];
  style: KeystrokeStyle;
  getOutputTime: () => number | null;
  fallbackTime: number;
}

const KeystrokeLayer: React.FC<Props> = ({ frameRect, chips, style, getOutputTime, fallbackTime }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ chips, style, frameRect, fallbackTime });
  live.current = { chips, style, frameRect, fallbackTime };
  const active = style.show && chips.length > 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    let raf = 0;
    const paint = () => {
      raf = requestAnimationFrame(paint);
      const { chips: cs, style: st, frameRect: box, fallbackTime: fallback } = live.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(box.width * dpr));
      const h = Math.max(1, Math.round(box.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      const on = chipAt(cs, getOutputTime() ?? fallback);
      if (!on) return;
      const size = keyChipSize(on.chip, h, st);
      const centre = keyChipCentre(w, h, size.height, st);
      drawKeyChip(ctx, on.chip, centre.x, centre.y, h, st, on.alpha, on.scale);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [active, getOutputTime]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
};

export default KeystrokeLayer;
