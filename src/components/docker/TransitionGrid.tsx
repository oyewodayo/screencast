// components/docker/TransitionGrid.tsx
//
// The transition picker in Clip effects: a grid of live tiles, each playing its transition on a
// loop - from the previous clip's last frame into this clip's opening frame when those can be
// captured, from two drawn stand-in pictures until then. Every tile is drawn by the same
// renderTransitionFrame the player's preview uses (with this clip's current look - colour,
// strength, direction), so what a tile shows is what the clip will do.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Clip, TransitionLook, TransitionType } from "../../utils/videoEditTypes";
import { TRANSITION_PRESETS } from "../../utils/videoColorFilters";
import { clipStill, placeholderStills } from "../../utils/clipStill";
import { renderTransitionFrame, TransitionElements } from "../video/transitionFrame";

// One loop: the old picture, the transition, the new picture.
const HOLD_BEFORE = 0.45;
const PLAY = 1.2;
const HOLD_AFTER = 0.65;
const CYCLE = HOLD_BEFORE + PLAY + HOLD_AFTER;
const STATIC_PREVIEW_P = 0.45;

interface TileRefs {
  type: TransitionType | null;
  box: HTMLDivElement;
  els: TransitionElements;
}

const Tile: React.FC<{
  type: TransitionType | null;
  label: string;
  active: boolean;
  stills: [string, string];
  register: (type: TransitionType | null, refs: TileRefs | null) => void;
  onImageLoad: (type: TransitionType | null) => void;
  onHoverChange: (type: TransitionType | null, entered: boolean) => void;
  onClick: () => void;
}> = ({ type, label, active, stills, register, onImageLoad, onHoverChange, onClick }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const moverRef = useRef<HTMLDivElement>(null);
  const oldImgRef = useRef<HTMLImageElement>(null);
  const newImgRef = useRef<HTMLImageElement>(null);
  const pixelRef = useRef<HTMLCanvasElement>(null);
  const blackRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    const mover = moverRef.current;
    const old = oldImgRef.current;
    const black = blackRef.current;
    const glow = glowRef.current;
    if (!box || !mover || !old || !black || !glow) return;
    const loaded = (img: HTMLImageElement | null): img is HTMLImageElement => !!img && img.complete && img.naturalWidth > 0;
    const pictures = () => {
      const next = newImgRef.current;
      return loaded(old) && loaded(next) ? { old, next } : null;
    };
    register(type, { type, box, els: { mover, black, glow, pixel: pixelRef.current, fx: fxRef.current, source: old, pictures } });
    return () => register(type, null);
  }, [type, register]);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => onHoverChange(type, true)}
      onMouseLeave={() => onHoverChange(type, false)}
      title={label}
      className={`group flex flex-col gap-1 min-w-0 rounded-md p-1 text-left transition-colors ${active ? "bg-blue-500/15 ring-1 ring-blue-400/60" : "hover:bg-white/[0.06]"}`}
    >
      <div ref={boxRef} className="relative w-full aspect-video overflow-hidden rounded bg-black isolate">
        <img ref={newImgRef} src={stills[1]} onLoad={() => onImageLoad(type)} alt="" draggable={false} className="absolute inset-0 w-full h-full" />
        <div ref={moverRef} className="absolute inset-0">
          <img ref={oldImgRef} src={stills[0]} onLoad={() => onImageLoad(type)} alt="" draggable={false} className="absolute inset-0 w-full h-full" />
          <canvas ref={pixelRef} className="absolute inset-0 w-full h-full" style={{ imageRendering: "pixelated", display: "none" }} />
        </div>
        <div ref={blackRef} className="absolute inset-0 bg-black" style={{ opacity: 0 }} />
        <div ref={glowRef} className="absolute inset-0" style={{ opacity: 0, mixBlendMode: "screen" }} />
        <canvas ref={fxRef} className="absolute inset-0 w-full h-full" style={{ display: "none" }} />
      </div>
      <span className={`block w-full truncate text-center text-[10.5px] leading-tight ${active ? "text-blue-300" : "text-white/70 group-hover:text-white"}`}>{label}</span>
    </button>
  );
};

interface TransitionGridProps {
  value: TransitionType | null;
  look: TransitionLook | undefined;
  // The clip the transition comes from (its last frame) and the one it leads into.
  outgoing: Clip | undefined;
  incoming: Clip;
  onChange: (type: TransitionType | null) => void;
}

const TransitionGrid: React.FC<TransitionGridProps> = ({ value, look, outgoing, incoming, onChange }) => {
  const [stills, setStills] = useState<[string, string]>(placeholderStills);
  const [hoveredType, setHoveredType] = useState<TransitionType | null>(null);

  const outgoingKey = outgoing ? `${outgoing.sourcePath}|${outgoing.end}` : "";
  const incomingKey = `${incoming.sourcePath}|${incoming.start}`;
  useEffect(() => {
    let cancelled = false;
    const [oldFallback, newFallback] = placeholderStills();
    const before = outgoing ? clipStill(outgoing.sourcePath, Math.max(outgoing.start, outgoing.end - 1 / 30)).catch(() => oldFallback) : Promise.resolve(oldFallback);
    const after = clipStill(incoming.sourcePath, incoming.start + Math.min(0.3, (incoming.end - incoming.start) / 4)).catch(() => newFallback);
    Promise.all([before, after]).then((pair) => !cancelled && setStills(pair));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outgoingKey, incomingKey]);

  const tiles = useRef(new Map<TransitionType | null, TileRefs>());
  const lookRef = useRef<TransitionLook>(look ?? {});
  lookRef.current = look ?? {};

  const paintTile = useCallback((entry: TileRefs, p: number) => {
    const W = entry.box.clientWidth || 80;
    const H = entry.box.clientHeight || 45;
    if (W === 0 || H === 0) return;
    renderTransitionFrame(entry.type, lookRef.current, entry.type === null ? 0 : p, entry.els, { L: 0, T: 0, W, H, containerW: W, containerH: H });
  }, []);

  const register = useCallback(
    (type: TransitionType | null, refs: TileRefs | null) => {
      if (refs) {
        tiles.current.set(type, refs);
        paintTile(refs, STATIC_PREVIEW_P);
      } else {
        tiles.current.delete(type);
      }
    },
    [paintTile]
  );

  const handleImageLoad = useCallback(
    (type: TransitionType | null) => {
      const entry = tiles.current.get(type);
      if (entry) paintTile(entry, STATIC_PREVIEW_P);
    },
    [paintTile]
  );

  const handleHoverChange = useCallback((type: TransitionType | null, entered: boolean) => {
    if (!type) return;
    setHoveredType((prev) => (entered ? type : prev === type ? null : prev));
  }, []);

  // Re-paint static previews whenever stills or look settings change.
  const lookKey = JSON.stringify(look ?? null);
  useEffect(() => {
    tiles.current.forEach((entry) => paintTile(entry, STATIC_PREVIEW_P));
  }, [stills, lookKey, paintTile]);

  // Animate only the hovered tile so opening and scrolling the grid of 33 transitions stays effortless.
  useEffect(() => {
    if (!hoveredType) return;
    const entry = tiles.current.get(hoveredType);
    if (!entry) return;
    let raf = 0;
    const start = performance.now();
    const W = entry.box.clientWidth || 80;
    const H = entry.box.clientHeight || 45;
    const tick = (now: number) => {
      const t = ((now - start) / 1000) % CYCLE;
      const p = Math.max(0, Math.min(1, (t - HOLD_BEFORE) / PLAY));
      renderTransitionFrame(entry.type, lookRef.current, p, entry.els, { L: 0, T: 0, W, H, containerW: W, containerH: H });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      paintTile(entry, STATIC_PREVIEW_P);
    };
  }, [hoveredType, paintTile]);

  return (
    <div className="grid grid-cols-3 gap-1">
      <Tile
        type={null}
        label="None"
        active={value === null}
        stills={stills}
        register={register}
        onImageLoad={handleImageLoad}
        onHoverChange={handleHoverChange}
        onClick={() => onChange(null)}
      />
      {TRANSITION_PRESETS.map((p) => (
        <Tile
          key={p.value}
          type={p.value}
          label={p.label}
          active={value === p.value}
          stills={stills}
          register={register}
          onImageLoad={handleImageLoad}
          onHoverChange={handleHoverChange}
          onClick={() => onChange(p.value)}
        />
      ))}
    </div>
  );
};

export default TransitionGrid;
