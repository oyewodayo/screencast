// components/video/ReframePreviewLayer.tsx
//
// While Export is set to Fill another shape, shows on the player which part of the frame the export
// keeps: everything outside the window dimmed, the window following its path (reframeTrack.ts -
// the same eased curve export renders) at the player's exact output time, every animation frame.
import React, { useEffect, useRef } from "react";
import { ReframeKnot, reframeWindowAt } from "../../utils/reframeTrack";

export interface ReframePreview {
  window: { w: number; h: number };
  knots: ReframeKnot[];
  label: string;
}

interface ReframePreviewLayerProps {
  preview: ReframePreview;
  getOutputTime: () => number | null;
  fallbackTime: number;
}

const ReframePreviewLayer: React.FC<ReframePreviewLayerProps> = ({ preview, getOutputTime, fallbackTime }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef(fallbackTime);
  fallbackRef.current = fallbackTime;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const box = boxRef.current;
      if (!box) return;
      const { x, y } = reframeWindowAt(preview.knots, getOutputTime() ?? fallbackRef.current);
      box.style.left = `${(x - preview.window.w / 2) * 100}%`;
      box.style.top = `${(y - preview.window.h / 2) * 100}%`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [preview, getOutputTime]);

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 80 }}>
      <div
        ref={boxRef}
        className="absolute ring-1 ring-white/80"
        style={{ width: `${preview.window.w * 100}%`, height: `${preview.window.h * 100}%`, boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)" }}
      >
        <span className="absolute left-1/2 top-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white/90">{preview.label}</span>
      </div>
    </div>
  );
};

export default ReframePreviewLayer;
