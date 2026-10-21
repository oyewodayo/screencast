// components/docker/EffectPreviewGrids.tsx
//
// Live pickers for a clip's look and motion: every choice is a tile showing the clip's OWN frame
// with that effect on it - colour presets as the preview filter them, Ken Burns motions moving on a
// loop through the same window maths the player and the export use (clipFrameAffine,
// videoColorFilters.ts). Same tile language as the transition picker (TransitionGrid).
import React, { useEffect, useRef, useState } from "react";
import { Clip, ClipFxKind, ColorFilterPreset, GradeLookName, KenBurnsPreset } from "../../utils/videoEditTypes";
import { CLIP_FX, DEFAULT_CLIP_FX_INTENSITY, drawClipFx } from "../../utils/clipFx";
import { GRADE_LOOKS, applyLook } from "../../utils/gradeLooks";
import { COLOR_FILTER_PRESETS, KEN_BURNS_PRESETS, affineCssTransform, clipFrameAffine, cssFilterForColorPreset, vignetteBackground } from "../../utils/videoColorFilters";
import { clipStill, placeholderStills } from "../../utils/clipStill";

// A still of the clip a little way in (its first frame is often a fade or a blink).
function useClipStill(clip: Clip): string {
  const [still, setStill] = useState<string>(() => placeholderStills()[0]);
  useEffect(() => {
    let cancelled = false;
    const at = clip.start + Math.min(1, (clip.end - clip.start) / 3);
    clipStill(clip.sourcePath, at)
      .then((url) => !cancelled && setStill(url))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [clip.sourcePath, clip.start, clip.end]);
  return still;
}

const Tile: React.FC<{ label: string; hint?: string; active: boolean; onClick: () => void; children: React.ReactNode }> = ({ label, hint, active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    title={hint ? `${label} - ${hint}` : label}
    className={`group flex flex-col gap-1 min-w-0 rounded-md p-1 text-left transition-colors ${active ? "bg-blue-500/15 ring-1 ring-blue-400/60" : "hover:bg-white/[0.06]"}`}
  >
    <div className="relative w-full aspect-video overflow-hidden rounded bg-black">{children}</div>
    <span className={`block w-full truncate text-center text-[10.5px] leading-tight ${active ? "text-blue-300" : "text-white/70 group-hover:text-white"}`}>{label}</span>
  </button>
);

// One animation clock for a grid of moving tiles; idles while the grid is off screen or hidden.
// `paint(t)` gets seconds since the grid appeared.
function useGridClock(gridRef: React.RefObject<HTMLElement | null>, paint: (t: number) => void): void {
  const paintRef = useRef(paint);
  paintRef.current = paint;
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let visible = true;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      paintRef.current((now - start) / 1000);
      raf = requestAnimationFrame(tick);
    };
    const resume = () => {
      if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      resume();
    });
    observer.observe(grid);
    document.addEventListener("visibilitychange", resume);
    resume();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", resume);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [gridRef]);
}

// Each motion plays over this many seconds, then starts again.
const MOTION_LOOP_SEC = 3.5;

export const MotionGrid: React.FC<{
  clip: Clip;
  value: KenBurnsPreset | null;
  intensity: number;
  onChange: (preset: KenBurnsPreset | null) => void;
}> = ({ clip, value, intensity, onChange }) => {
  const still = useClipStill(clip);
  const gridRef = useRef<HTMLDivElement>(null);
  const images = useRef(new Map<KenBurnsPreset, HTMLImageElement>());
  useGridClock(gridRef, (t) => {
    const progress = (t % MOTION_LOOP_SEC) / MOTION_LOOP_SEC;
    images.current.forEach((img, preset) => {
      // The tile IS the frame, so the transform's offsets are in % of it.
      img.style.transform = affineCssTransform(clipFrameAffine({ kenBurns: { preset, intensity }, start: 0, end: MOTION_LOOP_SEC }, progress));
    });
  });
  return (
    <div ref={gridRef} className="grid grid-cols-3 gap-1">
      <Tile label="None" active={value === null} onClick={() => onChange(null)}>
        <img src={still} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover" />
      </Tile>
      {KEN_BURNS_PRESETS.map((p) => (
        <Tile key={p.value} label={p.label} hint={p.hint} active={value === p.value} onClick={() => onChange(p.value)}>
          <img
            ref={(el) => {
              if (el) images.current.set(p.value, el);
              else images.current.delete(p.value);
            }}
            src={still}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full object-cover will-change-transform"
          />
        </Tile>
      ))}
    </div>
  );
};

export const ColorGrid: React.FC<{
  clip: Clip;
  value: ColorFilterPreset;
  intensity: number;
  onChange: (preset: ColorFilterPreset) => void;
}> = ({ clip, value, intensity, onChange }) => {
  const still = useClipStill(clip);
  return (
    <div className="grid grid-cols-3 gap-1">
      {COLOR_FILTER_PRESETS.map((p) => (
        <Tile key={p.value} label={p.label} active={value === p.value} onClick={() => onChange(p.value)}>
          <img
            src={still}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full object-cover"
            style={{ filter: p.value === "none" ? undefined : cssFilterForColorPreset({ preset: p.value, intensity }) || undefined }}
          />
          {p.value === "vignette" && <div className="absolute inset-0" style={{ background: vignetteBackground(intensity) }} />}
        </Tile>
      ))}
    </div>
  );
};

// Built-in looks (gradeLooks.ts), each tile the clip's frame through the look - the same per-pixel
// function the grade LUT bakes, so a tile is what the clip will look like.
const LOOK_TILE_W = 160;
const LOOK_TILE_H = 90;

const LookTileCanvas: React.FC<{ still: string; look: GradeLookName | null; intensity: number }> = ({ still, look, intensity }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = ref.current;
      const ctx = canvas?.getContext("2d", { willReadFrequently: true });
      if (cancelled || !canvas || !ctx) return;
      ctx.drawImage(img, 0, 0, LOOK_TILE_W, LOOK_TILE_H);
      if (!look) return;
      let data: ImageData;
      try {
        data = ctx.getImageData(0, 0, LOOK_TILE_W, LOOK_TILE_H);
      } catch {
        return; // can't read this still back - the tile shows it as it is
      }
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const [r, g, b] = applyLook(look, intensity, px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
        px[i] = r * 255;
        px[i + 1] = g * 255;
        px[i + 2] = b * 255;
      }
      ctx.putImageData(data, 0, 0);
    };
    img.src = still;
    return () => {
      cancelled = true;
    };
  }, [still, look, intensity]);
  return <canvas ref={ref} width={LOOK_TILE_W} height={LOOK_TILE_H} className="absolute inset-0 w-full h-full" />;
};

export const LookGrid: React.FC<{ clip: Clip; value: GradeLookName | null; intensity: number; onChange: (look: GradeLookName | null) => void }> = ({ clip, value, intensity, onChange }) => {
  const still = useClipStill(clip);
  return (
    <div className="grid grid-cols-3 gap-1">
      <Tile label="None" active={value === null} onClick={() => onChange(null)}>
        <LookTileCanvas still={still} look={null} intensity={0} />
      </Tile>
      {GRADE_LOOKS.map((l) => (
        <Tile key={l.value} label={l.label} hint={l.title} active={value === l.value} onClick={() => onChange(l.value)}>
          <LookTileCanvas still={still} look={l.value} intensity={value === l.value ? intensity : 0.85} />
        </Tile>
      ))}
    </div>
  );
};

// Clip effects (clipFx.ts), each tile the clip's frame through the effect on a loop - drawn by the
// same drawClipFx the player uses.
const FX_LOOP_SEC = 2.4;

export const FxGrid: React.FC<{ clip: Clip; value: ClipFxKind | null; intensity: number; onChange: (kind: ClipFxKind | null) => void }> = ({ clip, value, intensity, onChange }) => {
  const still = useClipStill(clip);
  const gridRef = useRef<HTMLDivElement>(null);
  const canvases = useRef(new Map<ClipFxKind, HTMLCanvasElement>());
  const imgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => (imgRef.current = img);
    img.src = still;
  }, [still]);
  useGridClock(gridRef, (t) => {
    const img = imgRef.current;
    if (!img) return;
    canvases.current.forEach((canvas, kind) => {
      const w = canvas.width;
      const h = canvas.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      drawClipFx(ctx, { kind, intensity: value === kind ? intensity : DEFAULT_CLIP_FX_INTENSITY }, img, t % FX_LOOP_SEC, w, h, w, h, 1);
    });
  });
  return (
    <div ref={gridRef} className="grid grid-cols-3 gap-1">
      <Tile label="None" active={value === null} onClick={() => onChange(null)}>
        <img src={still} alt="" draggable={false} className="absolute inset-0 w-full h-full" />
      </Tile>
      {CLIP_FX.map((f) => (
        <Tile key={f.value} label={f.label} hint={f.title} active={value === f.value} onClick={() => onChange(f.value)}>
          <canvas
            ref={(el) => {
              if (el) canvases.current.set(f.value, el);
              else canvases.current.delete(f.value);
            }}
            width={160}
            height={90}
            className="absolute inset-0 w-full h-full"
          />
        </Tile>
      ))}
    </div>
  );
};
