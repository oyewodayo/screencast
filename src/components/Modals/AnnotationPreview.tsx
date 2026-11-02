// components/Modals/AnnotationPreview.tsx
//
// Settings > Annotation's live sample: a circle and an underline drawn with drawAnnotationInk -
// the exact code the overlay uses - over a dark "slide", so what you pick is what you'll see.
import { useEffect, useRef } from "react";
import { AnnotationInk, AnnotationStrokePoint, AnnotationStyle, drawAnnotationInk } from "../../utils/annotationStyles";

interface AnnotationPreviewProps {
  color: string;
  width: number;
  style: AnnotationStyle;
  shadow: boolean;
}

const HEIGHT = 120;

// A loose hand-drawn ellipse around the sample text, then a wavy underline beneath it - pressure
// swells mid-stroke so Pen's taper shows.
const samplePaths = (w: number): AnnotationStrokePoint[][] => {
  const cx = w * 0.3;
  const circle: AnnotationStrokePoint[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * Math.PI * 2.15 - 0.4;
    circle.push({
      x: cx + Math.cos(t) * (w * 0.17 + i * 0.12),
      y: HEIGHT / 2 + Math.sin(t) * (30 - i * 0.05),
      pressure: 0.35 + 0.5 * Math.sin((i / 64) * Math.PI),
    });
  }
  const underline: AnnotationStrokePoint[] = [];
  for (let i = 0; i <= 48; i++) {
    const x = w * 0.58 + (i / 48) * w * 0.34;
    underline.push({
      x,
      y: HEIGHT * 0.66 + Math.sin(i / 4) * 3,
      pressure: 0.3 + 0.55 * Math.sin((i / 48) * Math.PI),
    });
  }
  return [circle, underline];
};

const AnnotationPreview: React.FC<AnnotationPreviewProps> = ({ color, width, style, shadow }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, HEIGHT);

    // Stand-in slide content for the ink to sit on.
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Key result", w * 0.3, HEIGHT / 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillText("Look here", w * 0.75, HEIGHT * 0.5);

    for (const points of samplePaths(w)) {
      const ink: AnnotationInk = { points, color, width, style, shadow };
      drawAnnotationInk(ctx, ink, 1);
    }
  }, [color, width, style, shadow]);

  return (
    <canvas
      ref={canvasRef}
      style={{ height: HEIGHT }}
      className="w-full rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 ring-1 ring-black/10 dark:ring-white/10"
    />
  );
};

export default AnnotationPreview;
