// components/video/CanvasTextOverlay.tsx
//
// A text overlay drawn for the live preview by the same function export burns in with
// (drawTextOverlay, videoOverlayRender.ts) - used for titles whose face, tracking, gradient, glow,
// shadow or scaling/masking reveal DOM text can't match exactly (usesCanvasText). Sits inside the
// overlay's own positioned box (which keeps handling selection, animation and keyframes), drawn at
// the screen's pixel density so it stays crisp. A reveal redraws every animation frame from
// `getTime` until it settles; a still title redraws only when it changes or its face loads.
import React, { useEffect, useRef } from "react";
import type { TextOverlay } from "../../utils/videoEditTypes";
import { drawTextOverlay } from "../../utils/videoOverlayRender";
import { isTextReveal, textRevealState } from "../../utils/textReveal";
import { loadTitleFonts } from "../../utils/titleFonts";

interface CanvasTextOverlayProps {
  overlay: TextOverlay;
  // The letterboxed frame's size on screen.
  frameWidth: number;
  frameHeight: number;
  // Seconds into the overlay's life right now.
  getTime: () => number;
}

const CanvasTextOverlay: React.FC<CanvasTextOverlayProps> = ({ overlay, frameWidth, frameHeight, getTime }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getTimeRef = useRef(getTime);
  getTimeRef.current = getTime;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const kind = isTextReveal(overlay.animation) ? overlay.animation : null;
    const duration = overlay.endTime - overlay.startTime;
    let raf = 0;
    let lastKey = "";
    let cancelled = false;
    const draw = () => {
      const state = kind ? textRevealState(overlay.text, kind, getTimeRef.current(), duration, overlay.reveal) : undefined;
      // Level - the box it sits in is what's turned.
      const drawn = drawTextOverlay(overlay, frameWidth * dpr, frameHeight * dpr, state, canvas, true);
      if (!drawn) {
        canvas.style.display = "none";
        return;
      }
      canvas.style.display = "block";
      canvas.style.width = `${drawn.canvas.width / dpr}px`;
      canvas.style.height = `${drawn.canvas.height / dpr}px`;
      canvas.style.left = `${drawn.xPx / dpr - overlay.x * frameWidth}px`;
      canvas.style.top = `${drawn.yPx / dpr - overlay.y * frameHeight}px`;
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = getTimeRef.current();
      const s = kind ? textRevealState(overlay.text, kind, t, duration, overlay.reveal) : null;
      // Two moments that look the same are drawn once.
      const key = !s || s.settled ? "still" : s.blink !== null ? `blink${s.blink}` : `t${Math.round(t * 120)}`;
      if (key === lastKey) return;
      lastKey = key;
      draw();
    };
    draw();
    if (kind) raf = requestAnimationFrame(tick);
    // Canvas text doesn't wait for a web font - redraw once the face is in.
    void loadTitleFonts([overlay.fontFamily]).then(() => {
      if (cancelled) return;
      lastKey = "";
      draw();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [overlay, frameWidth, frameHeight]);

  return <canvas ref={canvasRef} className="absolute pointer-events-none" />;
};

export default CanvasTextOverlay;
