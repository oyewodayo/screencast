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

const Tile: React.FC<{
  label: string;
  hint?: string;
  active: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: React.ReactNode;
}> = ({ label, hint, active, onClick, onMouseEnter, onMouseLeave, children }) => (
  <button
    type="button"
    onClick={onClick}
    onMouseEnter={onMouseEnter}
    onMouseLeave={onMouseLeave}
    title={hint ? `${label} - ${hint}` : label}
    className={`group flex flex-col gap-1 min-w-0 rounded-md p-1 text-left transition-colors ${active ? "bg-blue-500/15 ring-1 ring-blue-400/60" : "hover:bg-white/[0.06]"}`}
  >
    <div className="relative w-full aspect-video overflow-hidden rounded bg-black">{children}</div>
    <span className={`block w-full truncate text-center text-[10.5px] leading-tight ${active ? "text-blue-300" : "text-white/70 group-hover:text-white"}`}>{label}</span>
  </button>
);

// Each motion plays over this many seconds, then starts again.
const MOTION_LOOP_SEC = 3.5;
const MOTION_STATIC_PROGRESS = 0.65;

export const MotionGrid: React.FC<{
  clip: Clip;
  value: KenBurnsPreset | null;
  intensity: number;
  onChange: (preset: KenBurnsPreset | null) => void;
}> = ({ clip, value, intensity, onChange }) => {
  const still = useClipStill(clip);
  const [hovered, setHovered] = useState<KenBurnsPreset | null>(null);
  const images = useRef(new Map<KenBurnsPreset, HTMLImageElement>());

  useEffect(() => {
    if (!hovered) return;
    const img = images.current.get(hovered);
    if (!img) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = (((now - start) / 1000) % MOTION_LOOP_SEC) / MOTION_LOOP_SEC;
      const amt = value === hovered ? intensity : 0.5;
      img.style.transform = affineCssTransform(clipFrameAffine({ kenBurns: { preset: hovered, intensity: amt }, start: 0, end: MOTION_LOOP_SEC }, progress));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      const amt = value === hovered ? intensity : 0.5;
      img.style.transform = affineCssTransform(clipFrameAffine({ kenBurns: { preset: hovered, intensity: amt }, start: 0, end: MOTION_LOOP_SEC }, MOTION_STATIC_PROGRESS));
    };
  }, [hovered, value, intensity]);

  return (
    <div className="grid grid-cols-3 gap-1">
      <Tile label="None" active={value === null} onClick={() => onChange(null)}>
        <img src={still} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover" />
      </Tile>
      {KEN_BURNS_PRESETS.map((p) => {
        const amt = value === p.value ? intensity : 0.5;
        const staticTransform = affineCssTransform(clipFrameAffine({ kenBurns: { preset: p.value, intensity: amt }, start: 0, end: MOTION_LOOP_SEC }, MOTION_STATIC_PROGRESS));
        return (
          <Tile
            key={p.value}
            label={p.label}
            hint={p.hint}
            active={value === p.value}
            onClick={() => onChange(p.value)}
            onMouseEnter={() => setHovered(p.value)}
            onMouseLeave={() => setHovered((prev) => (prev === p.value ? null : prev))}
          >
            <img
              ref={(el) => {
                if (el) images.current.set(p.value, el);
                else images.current.delete(p.value);
              }}
              src={still}
              alt=""
              draggable={false}
              style={{ transform: staticTransform }}
              className="absolute inset-0 w-full h-full object-cover"
            />
          </Tile>
        );
      })}
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
const LOOK_TILE_W = 128;
const LOOK_TILE_H = 72;

const LookTileCanvas: React.FC<{
  basePixels: Uint8ClampedArray | null;
  still: string;
  look: GradeLookName | null;
  intensity: number;
}> = React.memo(({ basePixels, still, look, intensity }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !look || !basePixels) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const out = ctx.createImageData(LOOK_TILE_W, LOOK_TILE_H);
    const dst = out.data;
    for (let i = 0; i < basePixels.length; i += 4) {
      const [r, g, b] = applyLook(look, intensity, basePixels[i] / 255, basePixels[i + 1] / 255, basePixels[i + 2] / 255);
      dst[i] = r * 255;
      dst[i + 1] = g * 255;
      dst[i + 2] = b * 255;
      dst[i + 3] = basePixels[i + 3];
    }
    ctx.putImageData(out, 0, 0);
  }, [basePixels, look, intensity]);

  if (!look || !basePixels) {
    return <img src={still} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover" />;
  }
  return <canvas ref={ref} width={LOOK_TILE_W} height={LOOK_TILE_H} className="absolute inset-0 w-full h-full" />;
});

export const LookGrid: React.FC<{ clip: Clip; value: GradeLookName | null; intensity: number; onChange: (look: GradeLookName | null) => void }> = ({ clip, value, intensity, onChange }) => {
  const still = useClipStill(clip);
  const [basePixels, setBasePixels] = useState<Uint8ClampedArray | null>(null);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const scratch = document.createElement("canvas");
      scratch.width = LOOK_TILE_W;
      scratch.height = LOOK_TILE_H;
      const ctx = scratch.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, LOOK_TILE_W, LOOK_TILE_H);
      try {
        const data = ctx.getImageData(0, 0, LOOK_TILE_W, LOOK_TILE_H);
        setBasePixels(data.data);
      } catch {
        setBasePixels(null);
      }
    };
    img.src = still;
    return () => {
      cancelled = true;
    };
  }, [still]);

  return (
    <div className="grid grid-cols-3 gap-1">
      <Tile label="None" active={value === null} onClick={() => onChange(null)}>
        <LookTileCanvas basePixels={basePixels} still={still} look={null} intensity={0} />
      </Tile>
      {GRADE_LOOKS.map((l) => (
        <Tile key={l.value} label={l.label} hint={l.title} active={value === l.value} onClick={() => onChange(l.value)}>
          <LookTileCanvas basePixels={basePixels} still={still} look={l.value} intensity={value === l.value ? intensity : 0.85} />
        </Tile>
      ))}
    </div>
  );
};

// Clip effects (clipFx.ts), each tile the clip's frame through the effect on a loop - drawn by the
// same drawClipFx the player uses.
const FX_LOOP_SEC = 2.4;

function representativeFxTime(kind: ClipFxKind): number {
  return kind === "focus" || kind === "colorin" ? 0.2 : 0.38;
}

export const FxGrid: React.FC<{ clip: Clip; value: ClipFxKind | null; intensity: number; onChange: (kind: ClipFxKind | null) => void }> = ({ clip, value, intensity, onChange }) => {
  const still = useClipStill(clip);
  const canvases = useRef(new Map<ClipFxKind, HTMLCanvasElement>());
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [hovered, setHovered] = useState<ClipFxKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    const next = new Image();
    next.onload = () => {
      if (!cancelled) setImg(next);
    };
    next.src = still;
    return () => {
      cancelled = true;
    };
  }, [still]);

  // Paint all tiles once statically whenever the source image or active effect/intensity changes.
  useEffect(() => {
    if (!img) return;
    canvases.current.forEach((canvas, kind) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      drawClipFx(
        ctx,
        { kind, intensity: value === kind ? intensity : DEFAULT_CLIP_FX_INTENSITY },
        img,
        representativeFxTime(kind),
        w,
        h,
        w,
        h,
        1
      );
    });
  }, [img, value, intensity]);

  // Animate only the hovered tile at 30fps so scrolling and popover open stay instant.
  useEffect(() => {
    if (!hovered || !img) return;
    const canvas = canvases.current.get(hovered);
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    let raf = 0;
    let lastPaint = 0;
    const start = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastPaint < 33) return;
      lastPaint = now;
      const t = ((now - start) / 1000) % FX_LOOP_SEC;
      drawClipFx(ctx, { kind: hovered, intensity: value === hovered ? intensity : DEFAULT_CLIP_FX_INTENSITY }, img, t, w, h, w, h, 1);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      drawClipFx(
        ctx,
        { kind: hovered, intensity: value === hovered ? intensity : DEFAULT_CLIP_FX_INTENSITY },
        img,
        representativeFxTime(hovered),
        w,
        h,
        w,
        h,
        1
      );
    };
  }, [hovered, img, value, intensity]);

  return (
    <div className="grid grid-cols-3 gap-1">
      <Tile label="None" active={value === null} onClick={() => onChange(null)}>
        <img src={still} alt="" draggable={false} className="absolute inset-0 w-full h-full" />
      </Tile>
      {CLIP_FX.map((f) => (
        <Tile
          key={f.value}
          label={f.label}
          hint={f.title}
          active={value === f.value}
          onClick={() => onChange(f.value)}
          onMouseEnter={() => setHovered(f.value)}
          onMouseLeave={() => setHovered((prev) => (prev === f.value ? null : prev))}
        >
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
