// components/docker/ColorGradeControls.tsx
//
// The clip's color grade (ClipGrade) inside the Effects panel: seven correction sliders, an
// imported .cube LUT, hold-to-compare, and a live RGB histogram. The grade is baked to one LUT
// (colorGrade.ts) that the preview's WebGL layer and the export both apply, so what's set here is
// exactly what renders.
import React, { useEffect, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IoClose, IoColorFilterOutline, IoRefresh } from "react-icons/io5";
import type { ClipGrade } from "../../utils/videoEditTypes";
import { GRADE_SLIDERS, GradeSlider, Lut3D, hasGrade, sampleLut } from "../../utils/colorGrade";
import { loadUserLut, useGradeLut } from "../../utils/gradeLuts";

// Held while "Compare" is pressed - GradeCanvas listens and shows the ungraded video meanwhile.
export const GRADE_BYPASS_EVENT = "briefcast:grade-bypass";

const SLIDERS: Record<GradeSlider, { label: string; min: number; max: number; format: (v: number) => string }> = {
  exposure: { label: "Exposure", min: -2, max: 2, format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} EV` },
  contrast: { label: "Contrast", min: -1, max: 1, format: (v) => `${Math.round(v * 100)}` },
  saturation: { label: "Saturation", min: -1, max: 1, format: (v) => `${Math.round(v * 100)}` },
  temperature: { label: "Temperature", min: -1, max: 1, format: (v) => `${Math.round(v * 100)}` },
  tint: { label: "Tint", min: -1, max: 1, format: (v) => `${Math.round(v * 100)}` },
  highlights: { label: "Highlights", min: -1, max: 1, format: (v) => `${Math.round(v * 100)}` },
  shadows: { label: "Shadows", min: -1, max: 1, format: (v) => `${Math.round(v * 100)}` },
};

// Track tints that hint at what each slider does.
const TRACK: Partial<Record<GradeSlider, string>> = {
  temperature: "linear-gradient(90deg, #5aa0ff, #c8c8c8, #ffb050)",
  tint: "linear-gradient(90deg, #5ad06a, #c8c8c8, #e070d0)",
  saturation: "linear-gradient(90deg, #8a8a8a, #ff5a5a 60%, #5aa0ff)",
};

interface ColorGradeControlsProps {
  grade: ClipGrade | undefined;
  onChange: (grade: ClipGrade | undefined) => void;
  // The histogram reads the frame on screen - only meaningful when that's this clip.
  isOnScreen: boolean;
}

const HIST_W = 160;
const HIST_H = 90;
const BINS = 64;

// RGB histogram of the on-screen frame as graded: the player's video, downscaled, each pixel put
// through the same baked LUT the preview and export use. Refreshes a few times a second.
const GradeHistogram: React.FC<{ lut: Lut3D | null }> = ({ lut }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lutRef = useRef(lut);
  lutRef.current = lut;
  useEffect(() => {
    const scratch = document.createElement("canvas");
    scratch.width = 96;
    scratch.height = 54;
    const sctx = scratch.getContext("2d", { willReadFrequently: true });
    const timer = window.setInterval(() => {
      const video = document.querySelector<HTMLVideoElement>(".video-container video");
      const out = canvasRef.current?.getContext("2d");
      if (!video || !sctx || !out || video.readyState < 2) return;
      sctx.drawImage(video, 0, 0, scratch.width, scratch.height);
      let pixels: Uint8ClampedArray;
      try {
        pixels = sctx.getImageData(0, 0, scratch.width, scratch.height).data;
      } catch {
        return;
      }
      const bins = [new Float32Array(BINS), new Float32Array(BINS), new Float32Array(BINS)];
      const current = lutRef.current;
      for (let i = 0; i < pixels.length; i += 4) {
        let r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255;
        if (current) [r, g, b] = sampleLut(current, r, g, b);
        bins[0][Math.min(BINS - 1, Math.floor(r * BINS))]++;
        bins[1][Math.min(BINS - 1, Math.floor(g * BINS))]++;
        bins[2][Math.min(BINS - 1, Math.floor(b * BINS))]++;
      }
      // Ignore the two end bins when scaling, so a frame with black bars doesn't flatten the rest.
      const peak = Math.max(1, ...bins.flatMap((ch) => Array.from(ch.slice(1, BINS - 1))));
      out.clearRect(0, 0, HIST_W, HIST_H);
      out.globalCompositeOperation = "lighter";
      ["rgba(255,70,70,0.55)", "rgba(70,230,90,0.55)", "rgba(80,140,255,0.6)"].forEach((color, ch) => {
        out.fillStyle = color;
        out.beginPath();
        out.moveTo(0, HIST_H);
        for (let k = 0; k < BINS; k++) out.lineTo((k / (BINS - 1)) * HIST_W, HIST_H - Math.min(1, bins[ch][k] / peak) * (HIST_H - 2));
        out.lineTo(HIST_W, HIST_H);
        out.closePath();
        out.fill();
      });
      out.globalCompositeOperation = "source-over";
    }, 250);
    return () => window.clearInterval(timer);
  }, []);
  return <canvas ref={canvasRef} width={HIST_W} height={HIST_H} className="w-full h-[72px] rounded bg-black/60 ring-1 ring-white/10" aria-label="RGB histogram" />;
};

const ColorGradeControls: React.FC<ColorGradeControlsProps> = ({ grade, onChange, isOnScreen }) => {
  const [lutError, setLutError] = useState<string | null>(null);
  const lut = useGradeLut(grade);
  const set = (patch: Partial<ClipGrade>) => {
    const next: ClipGrade = { ...(grade ?? {}), ...patch };
    // An all-zero grade with no LUT is no grade at all.
    const keep = !!next.lut || hasGrade(next);
    onChange(keep ? next : undefined);
  };

  const importLut = async () => {
    setLutError(null);
    const selected = await openFileDialog({ multiple: false, filters: [{ name: "3D LUT", extensions: ["cube"] }] });
    if (!selected || Array.isArray(selected)) return;
    try {
      await loadUserLut(selected); // validates it before it's applied
      set({ lut: { path: selected, name: selected.split(/[\\/]/).pop() ?? "LUT", intensity: 1 } });
    } catch (err) {
      setLutError(err instanceof Error ? err.message : String(err));
    }
  };

  const setBypass = (on: boolean) => window.dispatchEvent(new CustomEvent(GRADE_BYPASS_EVENT, { detail: on }));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Color grading</span>
        <div className="flex items-center gap-1">
          {hasGrade(grade) && (
            <button
              type="button"
              onPointerDown={() => setBypass(true)}
              onPointerUp={() => setBypass(false)}
              onPointerLeave={() => setBypass(false)}
              title="Hold to see the clip without its grade"
              className="px-1.5 py-0.5 rounded text-[10px] text-white/60 hover:text-white hover:bg-white/10 select-none"
            >
              Hold to compare
            </button>
          )}
          {grade && (
            <button type="button" onClick={() => onChange(undefined)} title="Reset the grade" className="p-0.5 rounded text-white/50 hover:text-white hover:bg-white/10">
              <IoRefresh size={12} />
            </button>
          )}
        </div>
      </div>

      {isOnScreen && <GradeHistogram lut={lut} />}

      {GRADE_SLIDERS.map((key) => {
        const spec = SLIDERS[key];
        const value = grade?.[key] ?? 0;
        return (
          <label key={key} className="flex items-center gap-2 text-[11px]" onDoubleClick={() => set({ [key]: 0 })} title="Double-click to reset">
            <span className={`w-[70px] shrink-0 ${value !== 0 ? "text-white" : "text-white/60"}`}>{spec.label}</span>
            <input
              type="range"
              min={spec.min}
              max={spec.max}
              step={0.01}
              value={value}
              onChange={(e) => set({ [key]: Number(e.target.value) })}
              className="flex-1 min-w-0 accent-blue-400"
              style={TRACK[key] ? { background: TRACK[key], height: 4, borderRadius: 2 } : undefined}
            />
            <span className="w-[54px] shrink-0 text-right tabular-nums text-white/60">{spec.format(value)}</span>
          </label>
        );
      })}

      <div className="flex flex-col gap-1 pt-1">
        {grade?.lut ? (
          <>
            <div className="flex items-center gap-1.5 text-[11px]">
              <IoColorFilterOutline size={13} className="shrink-0 text-blue-300" />
              <span className="flex-1 min-w-0 truncate" title={grade.lut.path}>
                {grade.lut.name}
              </span>
              <button type="button" onClick={() => set({ lut: undefined })} title="Remove LUT" className="p-0.5 rounded text-white/50 hover:text-red-400 hover:bg-white/10">
                <IoClose size={12} />
              </button>
            </div>
            <label className="flex items-center gap-2 text-[11px]">
              <span className="w-[70px] shrink-0 text-white/60">LUT amount</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={grade.lut.intensity}
                onChange={(e) => set({ lut: { ...grade.lut!, intensity: Number(e.target.value) } })}
                className="flex-1 min-w-0 accent-blue-400"
              />
              <span className="w-[54px] shrink-0 text-right tabular-nums text-white/60">{Math.round(grade.lut.intensity * 100)}%</span>
            </label>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void importLut()}
            title="Apply a 3D LUT (.cube) - camera log conversions, film looks, or your own grade from another app"
            className="self-start flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-white/70 hover:text-white hover:bg-white/10"
          >
            <IoColorFilterOutline size={13} />
            Import LUT (.cube)…
          </button>
        )}
        {lutError && <p className="text-[10px] leading-snug text-red-300">{lutError}</p>}
      </div>
    </div>
  );
};

export default ColorGradeControls;
