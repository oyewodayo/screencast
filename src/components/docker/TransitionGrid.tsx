// components/docker/TransitionGrid.tsx
//
// The transition picker in Clip effects: a grid of live tiles, each playing its transition on a
// loop - from the previous clip's last frame into this clip's opening frame when those can be
// captured, from two drawn stand-in pictures until then. Every tile is drawn by the same
// renderTransitionFrame the player's preview uses (with this clip's current look - colour,
// strength, direction), so what a tile shows is what the clip will do.
//
// One requestAnimationFrame loop drives all tiles from a shared clock (they play in step), writing
// styles straight to each tile's DOM rather than through React state, and it idles whenever the
// grid is scrolled out of view or the window is hidden.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Clip, TransitionLook, TransitionType } from "../../utils/videoEditTypes";
import { TRANSITION_PRESETS } from "../../utils/videoColorFilters";
import { clipStill, placeholderStills } from "../../utils/clipStill";
import { renderTransitionFrame, TransitionElements } from "../video/transitionFrame";

// One loop: the old picture, the transition, the new picture.
const HOLD_BEFORE = 0.45;
const PLAY = 1.2;
const HOLD_AFTER = 0.65;
const CYCLE = HOLD_BEFORE + PLAY + HOLD_AFTER;

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
  onClick: () => void;
}> = ({ type, label, active, stills, register, onClick }) => {
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
      title={label}
      className={`group flex flex-col gap-1 min-w-0 rounded-md p-1 text-left transition-colors ${active ? "bg-blue-500/15 ring-1 ring-blue-400/60" : "hover:bg-white/[0.06]"}`}
    >
      <div ref={boxRef} className="relative w-full aspect-video overflow-hidden rounded bg-black isolate">
        <img ref={newImgRef} src={stills[1]} alt="" draggable={false} className="absolute inset-0 w-full h-full" />
        <div ref={moverRef} className="absolute inset-0">
          <img ref={oldImgRef} src={stills[0]} alt="" draggable={false} className="absolute inset-0 w-full h-full" />
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
  const register = useMemo(
    () => (type: TransitionType | null, refs: TileRefs | null) => {
      if (refs) tiles.current.set(type, refs);
      else tiles.current.delete(type);
    },
    []
  );

  const lookRef = useRef<TransitionLook>(look ?? {});
  lookRef.current = look ?? {};

  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let visible = true;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      const t = ((now - start) / 1000) % CYCLE;
      const p = Math.max(0, Math.min(1, (t - HOLD_BEFORE) / PLAY));
      tiles.current.forEach(({ type, box, els }) => {
        const W = box.clientWidth;
        const H = box.clientHeight;
        if (W === 0 || H === 0) return;
        renderTransitionFrame(type, lookRef.current, p, els, { L: 0, T: 0, W, H, containerW: W, containerH: H });
      });
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
  }, []);

  return (
    <div ref={gridRef} className="grid grid-cols-3 gap-1">
      <Tile type={null} label="None" active={value === null} stills={stills} register={register} onClick={() => onChange(null)} />
      {TRANSITION_PRESETS.map((p) => (
        <Tile key={p.value} type={p.value} label={p.label} active={value === p.value} stills={stills} register={register} onClick={() => onChange(p.value)} />
      ))}
    </div>
  );
};

export default TransitionGrid;
