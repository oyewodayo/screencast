// components/video/ElementsGallery.tsx
//
// The video editor's "Elements" picker - every shape, callout and animated element in
// videoAssets.ts's catalog, the designed stickers (stickerSets.ts) and sets of them, each tile
// playing its own entrance/loop/exit on repeat so you can see what it does before adding it.
// Picking one hands the element (or the set) back; the caller places it.
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose } from "react-icons/io5";
import AssetCanvas from "./AssetCanvas";
import { ASSET_CATALOG, ASSET_CATEGORIES, AssetCatalogEntry, OverlayAsset, assetEntry, makeAsset } from "../../utils/videoAssets";
import { loadStickerResources, stickerAspect, stickerResourceVersion } from "../../utils/stickerAssets";
import { STICKER_PRESETS, STICKER_SETS, StickerSet, placeStickerSet } from "../../utils/stickerSets";
import { EmojiPicker, IconPicker } from "./StickerPickers";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";

// Each tile replays a 3.2s life: in, a beat of its loop, out.
const TILE_LIFE_SEC = 3.2;
const TILE_W = 52;
const TILE_H = 34;

const tileTime = () => (performance.now() / 1000) % TILE_LIFE_SEC;
// One asset per catalog element, so a tile's canvas isn't rebuilt on every render.
const CATALOG_ASSETS = new Map(ASSET_CATALOG.map((e) => [e.kind, makeAsset(e.kind)]));

const Tile: React.FC<{ asset: OverlayAsset; label: string; onPick: () => void }> = ({ asset, label, onPick }) => {
  // Fit the element's own proportions (a sticker's, its words') inside the tile.
  const aspect = stickerAspect(asset) ?? assetEntry(asset.kind).aspect;
  const fit = Math.min(TILE_W / aspect, TILE_H);
  const w = fit * aspect;
  const h = fit;
  return (
    <button
      type="button"
      onClick={onPick}
      title={`Add ${label.toLowerCase()}`}
      className="group flex flex-col items-center gap-1 rounded-lg p-1.5 bg-white/[0.04] hover:bg-white/[0.1] ring-1 ring-transparent hover:ring-blue-400/50 transition-colors outline-none focus-visible:ring-blue-400"
    >
      <span className="relative flex items-center justify-center rounded-md bg-[radial-gradient(circle_at_30%_20%,#2a3346,#11151d)] overflow-hidden" style={{ width: 80, height: 58 }}>
        <span className="relative block" style={{ width: w, height: h }}>
          <AssetCanvas asset={asset} widthPx={w} heightPx={h} duration={TILE_LIFE_SEC} getTime={tileTime} />
        </span>
      </span>
      <span className="text-[10px] text-white/65 group-hover:text-white truncate max-w-[80px]">{label}</span>
    </button>
  );
};

// A set played in a little 16:9 frame - every piece at its own place and delay.
const SET_TILE_W = 168;
const SET_TILE_H = 94.5;
const SetTile: React.FC<{ set: StickerSet; onPick: () => void }> = ({ set, onPick }) => {
  const life = set.length + 0.8;
  // Laid out exactly as adding it would (rows of chips follow their words).
  // Measured again once the sticker face is in.
  const fontsVersion = stickerResourceVersion();
  const placed = useMemo(() => placeStickerSet(set, 16 / 9, 0, set.length), [set, fontsVersion]);
  return (
    <button
      type="button"
      onClick={onPick}
      title={`Add the ${set.label.toLowerCase()} set`}
      className="group flex flex-col items-center gap-1 rounded-lg p-1.5 bg-white/[0.04] hover:bg-white/[0.1] ring-1 ring-transparent hover:ring-blue-400/50 transition-colors outline-none focus-visible:ring-blue-400"
    >
      <span className="relative block rounded-md overflow-hidden bg-[linear-gradient(160deg,#5b6476,#2a303c)]" style={{ width: SET_TILE_W, height: SET_TILE_H }}>
        {placed.map((o, i) => {
          const w = o.width * SET_TILE_W;
          const h = o.height * SET_TILE_H;
          return (
            <span
              key={i}
              className="absolute block"
              style={{ left: o.x * SET_TILE_W, top: o.y * SET_TILE_H, width: w, height: h, transform: o.rotation ? `rotate(${o.rotation}deg)` : undefined }}
            >
              <AssetCanvas asset={o.asset!} widthPx={w} heightPx={h} duration={o.endTime - o.startTime} getTime={() => ((performance.now() / 1000) % life) - o.startTime} />
            </span>
          );
        })}
      </span>
      <span className="text-[10px] text-white/65 group-hover:text-white">{set.label}</span>
    </button>
  );
};

interface ElementsGalleryProps {
  anchor: PopoverAnchor;
  onPick: (asset: OverlayAsset) => void;
  onPickSet: (set: StickerSet) => void;
  onClose: () => void;
}

type GalleryTab = AssetCatalogEntry["category"] | "Sets" | "Icons" | "Emoji";
const TABS: GalleryTab[] = [ASSET_CATEGORIES[0], "Sets", "Icons", "Emoji", ...ASSET_CATEGORIES.slice(1)];

// How an icon or emoji is added - remembered for the next one.
type AddAs = "bare" | "tile" | "ring";
const ADD_AS_KEY = "briefcast.elements.addAs";
const readAddAs = (): AddAs => {
  try {
    const v = localStorage.getItem(ADD_AS_KEY);
    return v === "tile" || v === "ring" ? v : "bare";
  } catch {
    return "bare";
  }
};
const fillFor = (addAs: AddAs) => (addAs === "tile" ? "solid" : addAs === "ring" ? "outline" : "none");

const ElementsGallery: React.FC<ElementsGalleryProps> = ({ anchor, onPick, onPickSet, onClose }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  const [category, setCategory] = useState<GalleryTab>("Stickers");
  const [addAs, setAddAsState] = useState<AddAs>(readAddAs);
  const setAddAs = (v: AddAs) => {
    setAddAsState(v);
    try {
      localStorage.setItem(ADD_AS_KEY, v);
    } catch {
      // Not remembered - fine.
    }
  };
  const addAsRow = (emoji: boolean) => (
    <div className="flex items-center gap-2">
      <span className="text-[10.5px] text-white/45">Add as</span>
      <div className="flex gap-0.5 rounded-lg bg-white/[0.06] p-0.5">
        {(
          [
            ["bare", emoji ? "Just the emoji" : "Just the icon"],
            ["tile", emoji ? "On a bubble" : "On a tile"],
            ["ring", emoji ? "In a ring" : "In a ring"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setAddAs(v)}
            className={`h-6 px-2 rounded-md text-[10.5px] transition-colors ${addAs === v ? "bg-white/15 text-white" : "text-white/55 hover:text-white"}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
  // Stickers measure their words to size their tiles - in their own face, once it's in.
  const [, setFontsIn] = useState(0);
  useEffect(() => {
    void loadStickerResources(makeAsset("chip")).then(() => setFontsIn((n) => n + 1));
  }, []);

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
      className="w-[420px] p-3 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium">Elements</span>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1 -m-1 rounded text-white/50 hover:text-white hover:bg-white/10">
          <IoClose size={14} />
        </button>
      </div>
      <div className="grid grid-cols-4 gap-0.5 rounded-lg bg-white/[0.06] p-0.5">
        {TABS.map((c) => (
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
      {category === "Icons" ? (
        <div className="flex flex-col gap-2">
          {addAsRow(false)}
          <IconPicker
            allowNone={false}
            columns={8}
            tile={40}
            maxHeight={300}
            onPick={(icon) =>
              onPick({ ...makeAsset("icon"), icon, fill: fillFor(addAs), ...(addAs === "bare" ? {} : { color: "#1463f3" }) })
            }
          />
        </div>
      ) : category === "Emoji" ? (
        <div className="flex flex-col gap-2">
          {addAsRow(true)}
          <EmojiPicker
            columns={9}
            maxHeight={300}
            onPick={(text) => onPick({ ...makeAsset("emoji"), text, fill: fillFor(addAs), lip: addAs !== "bare" })}
          />
        </div>
      ) : category === "Sets" ? (
        <div className="grid grid-cols-2 gap-1.5 max-h-[340px] overflow-y-auto pr-0.5">
          {STICKER_SETS.map((set) => (
            <SetTile key={set.id} set={set} onPick={() => onPickSet(set)} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-1.5 max-h-[340px] overflow-y-auto pr-0.5">
          {category === "Stickers"
            ? STICKER_PRESETS.map((preset) => <Tile key={preset.id} asset={preset.asset} label={preset.label} onPick={() => onPick(preset.asset)} />)
            : ASSET_CATALOG.filter((e) => e.category === category).map((entry) => (
                <Tile key={entry.kind} asset={CATALOG_ASSETS.get(entry.kind)!} label={entry.label} onPick={() => onPick(makeAsset(entry.kind))} />
              ))}
        </div>
      )}
      <p className="text-[10px] leading-snug text-white/40">
        {category === "Stickers"
          ? "Change words, colours, style (solid, outline, no background, border, 3D edge), the icon - or put your own picture in it - in its settings."
          : category === "Sets"
            ? "A set adds every piece at the playhead, timed to come in one after another. Edit, move or delete any piece on its own."
            : category === "Icons" || category === "Emoji"
              ? "Added at the playhead with a pop. Change it, its colour and style any time in its settings."
              : "Added at the playhead. Change colours and effects in the element's settings. Move, resize, rotate and keyframe it like any overlay."}
      </p>
    </div>,
    document.body
  );
};

export default ElementsGallery;
