// components/Modals/AnnotationPreview.tsx
//
// Interactive live preview for Settings > Annotate & Shield:
// - Draws sample ink strokes with drawAnnotationInk (exact match with the live overlay)
// - Shows the selected Pointer / Hand style & size right on the slide, and tracks your cursor live
//   when you hover over the preview so you can feel the exact size & responsiveness before saving.
import React, { useEffect, useRef, useState } from "react";
import {
  AnnotationHandStyle,
  AnnotationInk,
  AnnotationPointer,
  AnnotationStrokePoint,
  AnnotationStyle,
  DEFAULT_HAND_STYLE,
  DEFAULT_POINTER_SCALE,
  drawAnnotationInk,
} from "../../utils/annotationStyles";
import { HandGraphic, resolvePointer } from "../AnnotationPointer";

interface AnnotationPreviewProps {
  color: string;
  width: number;
  style: AnnotationStyle;
  shadow: boolean;
  pointer?: AnnotationPointer;
  handStyle?: AnnotationHandStyle;
  pointerScale?: number;
  pointerImage?: string;
}

const HEIGHT = 128;

const HAND_TILT: Record<AnnotationHandStyle, number> = {
  minimal: -18,
  classic: -24,
  wand: -28,
  stylus: -32,
};

const samplePaths = (w: number): AnnotationStrokePoint[][] => {
  const cx = w * 0.28;
  const circle: AnnotationStrokePoint[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * Math.PI * 2.15 - 0.4;
    circle.push({
      x: cx + Math.cos(t) * (w * 0.16 + i * 0.1),
      y: HEIGHT / 2 + Math.sin(t) * (30 - i * 0.05),
      pressure: 0.35 + 0.5 * Math.sin((i / 64) * Math.PI),
    });
  }
  const underline: AnnotationStrokePoint[] = [];
  for (let i = 0; i <= 48; i++) {
    const x = w * 0.55 + (i / 48) * w * 0.32;
    underline.push({
      x,
      y: HEIGHT * 0.64 + Math.sin(i / 4) * 3,
      pressure: 0.3 + 0.55 * Math.sin((i / 48) * Math.PI),
    });
  }
  return [circle, underline];
};

const AnnotationPreview: React.FC<AnnotationPreviewProps> = ({
  color,
  width,
  style,
  shadow,
  pointer = "hand",
  handStyle = DEFAULT_HAND_STYLE,
  pointerScale = DEFAULT_POINTER_SCALE,
  pointerImage = "",
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerElRef = useRef<HTMLDivElement>(null);
  const [lightSlide, setLightSlide] = useState(false);
  const [hovering, setHovering] = useState(false);
  const resolved = resolvePointer(pointer, pointerImage);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    if (w <= 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, HEIGHT);

    ctx.fillStyle = lightSlide ? "rgba(15, 23, 42, 0.88)" : "rgba(255, 255, 255, 0.9)";
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Key result", w * 0.28, HEIGHT / 2);

    ctx.fillStyle = lightSlide ? "rgba(15, 23, 42, 0.55)" : "rgba(255, 255, 255, 0.6)";
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillText("Look here", w * 0.71, HEIGHT * 0.48);

    for (const points of samplePaths(w)) {
      const ink: AnnotationInk = { points, color, width, style, shadow };
      drawAnnotationInk(ctx, ink, 1);
    }
  }, [color, width, style, shadow, lightSlide]);

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = pointerElRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    el.style.left = `${e.clientX - rect.left}px`;
    el.style.top = `${e.clientY - rect.top}px`;
  };

  return (
    <div
      onPointerEnter={(e) => {
        setHovering(true);
        handleMove(e);
      }}
      onPointerMove={handleMove}
      onPointerLeave={() => {
        setHovering(false);
        const el = pointerElRef.current;
        if (el) {
          el.style.left = "87%";
          el.style.top = "64%";
        }
      }}
      style={{ height: HEIGHT, cursor: resolved === "system" ? "crosshair" : "none" }}
      className={`relative w-full rounded-xl overflow-hidden select-none ring-1 transition-colors ${
        lightSlide
          ? "bg-gradient-to-br from-slate-50 to-slate-200 ring-black/10"
          : "bg-gradient-to-br from-slate-800 via-slate-900 to-slate-950 ring-black/10 dark:ring-white/10"
      }`}
    >
      <canvas ref={canvasRef} style={{ height: HEIGHT }} className="w-full block pointer-events-none" />

      {/* Live pointer preview (follows cursor on hover, rests at the underline tip otherwise) */}
      {resolved !== "system" && (
        <div
          ref={pointerElRef}
          className="absolute pointer-events-none"
          style={{ left: "87%", top: "64%", zIndex: 10 }}
        >
          {resolved === "hand" && (
            <div style={{ transform: `rotate(${HAND_TILT[handStyle]}deg) scale(${pointerScale})`, transformOrigin: "0 0" }}>
              <HandGraphic color={color} handStyle={handStyle} stick={handStyle !== "minimal" && handStyle !== "stylus"} />
            </div>
          )}
          {resolved === "dot" && (
            <div
              style={{
                width: Math.round(14 * pointerScale),
                height: Math.round(14 * pointerScale),
                marginLeft: -Math.round(7 * pointerScale),
                marginTop: -Math.round(7 * pointerScale),
                borderRadius: 9999,
                background: color,
                border: "2px solid rgba(255,255,255,0.92)",
                boxShadow: `0 0 10px 2px ${color}`,
              }}
            />
          )}
          {resolved === "custom" && pointerImage && (
            <img
              src={pointerImage}
              alt=""
              draggable={false}
              style={{ height: Math.round(48 * pointerScale), width: "auto", transform: "translateX(-50%)" }}
            />
          )}
        </div>
      )}

      {/* Subtle corner controls: Dark/Light slide toggle + hover hint */}
      <div
        className="absolute top-2 right-2 flex items-center gap-1.5 z-20"
        onPointerEnter={(e) => e.stopPropagation()}
        style={{ cursor: "default" }}
      >
        {!hovering && (
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium pointer-events-none ${
              lightSlide ? "bg-black/8 text-slate-600" : "bg-white/10 text-white/60"
            }`}
          >
            Hover to test pointer
          </span>
        )}
        <button
          type="button"
          onClick={() => setLightSlide((v) => !v)}
          className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
            lightSlide
              ? "bg-slate-900/10 hover:bg-slate-900/20 text-slate-700"
              : "bg-white/10 hover:bg-white/20 text-white/80"
          }`}
        >
          {lightSlide ? "Dark slide" : "Light slide"}
        </button>
      </div>
    </div>
  );
};

export default AnnotationPreview;
