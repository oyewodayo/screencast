// components/video/AssetFloatingControls.tsx
//
// The shape/element part of the one-row settings strip VideoOverlayLayer floats over the video
// when there's no sidebar to dock into - colours plus the element's entrance and loop. The full
// set (style, glow, exit) lives in the docked panel (OverlayDockedPanels' AssetSettingsSections).
import React from "react";
import ColorSwatchPicker from "../pdf/ColorSwatchPicker";
import { ASSET_ENTRANCES, ASSET_LOOPS, AssetEntrance, AssetLoop, OverlayAsset, assetUsesColor2 } from "../../utils/videoAssets";

const selectClass = "h-5 rounded bg-white/10 px-1 text-[10px] text-white outline-none focus:ring-1 focus:ring-blue-400";

const AssetFloatingControls: React.FC<{ asset: OverlayAsset; onAsset: (patch: Partial<OverlayAsset>) => void }> = ({ asset, onAsset }) => (
  <>
    <div onMouseDown={(e) => e.preventDefault()} title="Colour">
      <ColorSwatchPicker color={asset.color} onChange={(color) => onAsset({ color })} size="sm" />
    </div>
    {assetUsesColor2(asset.kind) && asset.color2 && (
      <div onMouseDown={(e) => e.preventDefault()} title="Second colour">
        <ColorSwatchPicker color={asset.color2} onChange={(color2) => onAsset({ color2 })} size="sm" />
      </div>
    )}
    <select title="Entrance" value={asset.entrance} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => onAsset({ entrance: e.target.value as AssetEntrance })} className={selectClass}>
      {ASSET_ENTRANCES.map((a) => (
        <option key={a.value} value={a.value} className="bg-neutral-800">
          In: {a.label}
        </option>
      ))}
    </select>
    <select title="Loop" value={asset.loop} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => onAsset({ loop: e.target.value as AssetLoop })} className={selectClass}>
      {ASSET_LOOPS.map((a) => (
        <option key={a.value} value={a.value} className="bg-neutral-800">
          Loop: {a.label}
        </option>
      ))}
    </select>
  </>
);

export default AssetFloatingControls;
