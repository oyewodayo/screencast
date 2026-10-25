// components/video/ElementsGallery.tsx
//
// The video editor's "Elements" picker - every shape, callout and animated element in
// videoAssets.ts's catalog, each tile playing its own entrance/loop/exit on repeat so you can see
// what it does before adding it. Picking one hands its kind back; the caller places it.
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose } from "react-icons/io5";
import AssetCanvas from "./AssetCanvas";
import { ASSET_CATALOG, ASSET_CATEGORIES, AssetCatalogEntry, AssetKind, makeAsset } from "../../utils/videoAssets";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";

// Each tile replays a 3.2s life: in, a beat of its loop, out.
const TILE_LIFE_SEC = 3.2;
const TILE_W = 52;
const TILE_H = 34;

const tileTime = () => (performance.now() / 1000) % TILE_LIFE_SEC;

const Tile: React.FC<{ entry: AssetCatalogEntry; onPick: () => void }> = ({ entry, onPick }) => {
  const asset = useMemo(() => makeAsset(entry.kind), [entry.kind]);
  // Fit the element's own proportions inside the tile.
  const fit = Math.min(TILE_W / entry.aspect, TILE_H);
  const w = fit * entry.aspect;
  const h = fit;
  return (
    <button
      type="button"
      onClick={onPick}
      title={`Add ${entry.label.toLowerCase()}`}
      className="group flex flex-col items-center gap-1 rounded-lg p-1.5 bg-white/[0.04] hover:bg-white/[0.1] ring-1 ring-transparent hover:ring-blue-400/50 transition-colors outline-none focus-visible:ring-blue-400"
    >
      <span className="relative flex items-center justify-center rounded-md bg-[radial-gradient(circle_at_30%_20%,#2a3346,#11151d)] overflow-hidden" style={{ width: 80, height: 58 }}>
        <span className="relative block" style={{ width: w, height: h }}>
          <AssetCanvas asset={asset} widthPx={w} heightPx={h} duration={TILE_LIFE_SEC} getTime={tileTime} />
        </span>
      </span>
      <span className="text-[10px] text-white/65 group-hover:text-white truncate max-w-[80px]">{entry.label}</span>
    </button>
  );
};

interface ElementsGalleryProps {
  anchor: PopoverAnchor;
  onPick: (kind: AssetKind) => void;
  onClose: () => void;
}

const ElementsGallery: React.FC<ElementsGalleryProps> = ({ anchor, onPick, onClose }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  const [category, setCategory] = useState<AssetCatalogEntry["category"]>("Shapes");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (ref.current && target && !ref.current.contains(target) && !target.closest("[data-elements-trigger]")) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [onClose, ref]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Elements"
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-[392px] p-3 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium">Elements</span>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1 -m-1 rounded text-white/50 hover:text-white hover:bg-white/10">
          <IoClose size={14} />
        </button>
      </div>
      <div className="grid grid-cols-4 gap-0.5 rounded-lg bg-white/[0.06] p-0.5">
        {ASSET_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            className={`h-7 rounded-md text-[11px] transition-colors ${category === c ? "bg-white/15 text-white shadow-sm" : "text-white/55 hover:text-white hover:bg-white/5"}`}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-1.5 max-h-[340px] overflow-y-auto pr-0.5">
        {ASSET_CATALOG.filter((e) => e.category === category).map((entry) => (
          <Tile key={entry.kind} entry={entry} onPick={() => onPick(entry.kind)} />
        ))}
      </div>
      <p className="text-[10px] leading-snug text-white/40">
        Added at the playhead. Change colours and effects in the element's settings. Move, resize, rotate and keyframe it like any overlay.
      </p>
    </div>,
    document.body
  );
};

export default ElementsGallery;
