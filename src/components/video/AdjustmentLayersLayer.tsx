// components/video/AdjustmentLayersLayer.tsx
//
// Adjustment layers on the player (AdjustmentLayer, videoEditTypes.ts). Each active layer is an
// empty element with a backdrop-filter - it grades/blurs whatever has been painted beneath it -
// confined and feathered by a CSS mask, faded by its opacity, vignetted by its background. Mounted
// three times by Dashboard, matching export's stacking (conversion.rs):
//   "under"    - right above the video (and transition preview), beneath blur regions and every
//                overlay: what export applies before blur regions;
//   "over"     - above every overlay and picture-in-picture, beneath captions;
//   "controls" - on top of everything: the selected layer's area editor and its settings panel.
// The filter list, mask and fades all come from adjustmentLayers.ts, which export also uses.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoColorFilterOutline } from "react-icons/io5";
import { AdjustmentLayer } from "../../utils/videoEditTypes";
import { FrameRect } from "../../utils/videoFrameRect";
import {
  adjustmentBackdropFilter,
  adjustmentElementBox,
  adjustmentIsActive,
  adjustmentVignetteBackground,
  fadeEnvelope,
  regionMaskStyle,
} from "../../utils/adjustmentLayers";
import { DOCKED_PANEL_CLASS, useToolPanelHost } from "../docker/ToolPanelHost";
import { AdjustmentDockedPanel } from "./OverlayDockedPanels";

interface Props {
  mode: "under" | "over" | "controls";
  frameRect: FrameRect;
  layers: AdjustmentLayer[];
  currentOutputTime: number;
  getOutputTime?: () => number | null;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onUpdate?: (id: string, patch: Partial<AdjustmentLayer>) => void;
  onSetTime?: (id: string, edge: "start" | "end", time: number) => void;
  onDuplicate?: (id: string) => void;
  onDelete?: (id: string) => void;
}

const isOn = (l: AdjustmentLayer, t: number) => t >= l.startTime && t < l.endTime;
const hasFades = (l: AdjustmentLayer) => (l.fadeIn ?? 0) > 0.01 || (l.fadeOut ?? 0) > 0.01;

const AdjustmentLayersLayer: React.FC<Props> = (props) => (props.mode === "controls" ? <Controls {...props} /> : <Layers {...props} />);

const Layers: React.FC<Props> = ({ mode, frameRect, layers, currentOutputTime, getOutputTime }) => {
  const active = layers.filter((l) => l.placement === mode && isOn(l, currentOutputTime) && adjustmentIsActive(l));
  // Fades follow the player's exact time every frame (currentOutputTime only ticks a few times a
  // second); export ramps the same envelope linearly.
  const fadingRef = useRef<AdjustmentLayer[]>([]);
  fadingRef.current = active.filter(hasFades);
  const anyFading = fadingRef.current.length > 0;
  useEffect(() => {
    if (!anyFading) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = getOutputTime?.();
      if (now === null || now === undefined) return;
      for (const l of fadingRef.current) {
        document.querySelectorAll<HTMLElement>(`[data-adj-layer="${l.id}"]`).forEach((el) => {
          el.style.opacity = String(fadeEnvelope(l, now));
        });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anyFading, getOutputTime]);

  return (
    <>
      {active.map((l) => {
        const box = adjustmentElementBox(l);
        const filter = adjustmentBackdropFilter(l, frameRect.height);
        return (
          <div
            key={l.id}
            data-adj-layer={l.id}
            className="absolute pointer-events-none"
            style={{
              left: box.x * frameRect.width,
              top: box.y * frameRect.height,
              width: box.width * frameRect.width,
              height: box.height * frameRect.height,
              backdropFilter: filter,
              WebkitBackdropFilter: filter,
              background: adjustmentVignetteBackground(l),
              opacity: fadeEnvelope(l, currentOutputTime),
              ...(l.region ? regionMaskStyle(l.region, frameRect.width, frameRect.height) : {}),
            }}
          />
        );
      })}
    </>
  );
};

type Drag = { kind: "move" | "nw" | "ne" | "sw" | "se"; startX: number; startY: number; box: { x: number; y: number; width: number; height: number } };
const MIN_REGION = 0.03;

const Controls: React.FC<Props> = ({ frameRect, layers, currentOutputTime, selectedId, onSelect, onUpdate, onSetTime, onDuplicate, onDelete }) => {
  const host = useToolPanelHost();
  const layer = layers.find((l) => l.id === selectedId) ?? null;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [live, setLive] = useState<Drag["box"] | null>(null);
  if (!layer || !onUpdate) return null;
  const region = layer.region;
  const box = live ?? (region ? { x: region.x, y: region.y, width: region.width, height: region.height } : null);

  const begin = (kind: Drag["kind"]) => (e: React.PointerEvent) => {
    if (!box) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind, startX: e.clientX, startY: e.clientY, box });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag || frameRect.width <= 0 || frameRect.height <= 0) return;
    const dx = (e.clientX - drag.startX) / frameRect.width;
    const dy = (e.clientY - drag.startY) / frameRect.height;
    const b = drag.box;
    let next = { ...b };
    if (drag.kind === "move") next = { ...b, x: b.x + dx, y: b.y + dy };
    else {
      const left = drag.kind === "nw" || drag.kind === "sw";
      const top = drag.kind === "nw" || drag.kind === "ne";
      const x0 = left ? Math.min(b.x + b.width - MIN_REGION, b.x + dx) : b.x;
      const x1 = left ? b.x + b.width : Math.max(b.x + MIN_REGION, b.x + b.width + dx);
      const y0 = top ? Math.min(b.y + b.height - MIN_REGION, b.y + dy) : b.y;
      const y1 = top ? b.y + b.height : Math.max(b.y + MIN_REGION, b.y + b.height + dy);
      next = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    setLive(next);
  };
  const end = () => {
    if (drag && live && region) onUpdate(layer.id, { region: { ...region, ...live } });
    setDrag(null);
    setLive(null);
  };

  const handle = (kind: "nw" | "ne" | "sw" | "se", left: number, top: number) => (
    <div
      key={kind}
      onPointerDown={begin(kind)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      className="absolute w-3.5 h-3.5 rounded-full bg-violet-400 ring-2 ring-white/80 shadow"
      style={{ left: left - 7, top: top - 7, cursor: kind === "nw" || kind === "se" ? "nwse-resize" : "nesw-resize", pointerEvents: "auto" }}
    />
  );

  const panel = (
    <AdjustmentDockedPanel
      layer={layer}
      playhead={currentOutputTime}
      onChange={(patch) => onUpdate(layer.id, patch)}
      onSetTime={onSetTime ? (edge, time) => onSetTime(layer.id, edge, time) : undefined}
      onDuplicate={() => onDuplicate?.(layer.id)}
      onDelete={() => {
        onDelete?.(layer.id);
        onSelect?.(null);
      }}
    />
  );
  const header = (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[13px] font-semibold flex items-center gap-2">
        <IoColorFilterOutline size={15} />
        Adjustment layer
      </span>
      <button type="button" title="Done" onClick={() => onSelect?.(null)} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
        <IoClose size={14} />
      </button>
    </div>
  );

  const px = box && { left: box.x * frameRect.width, top: box.y * frameRect.height, width: box.width * frameRect.width, height: box.height * frameRect.height };
  return (
    <>
      {px && (
        <>
          <div
            onPointerDown={begin("move")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            title={region?.invert ? "Everything outside this area is adjusted - drag to move it" : "The adjusted area - drag to move it"}
            className={`absolute outline outline-2 outline-dashed outline-violet-300/90 cursor-move ${region?.shape === "ellipse" ? "rounded-[50%]" : ""}`}
            style={{ ...px, pointerEvents: "auto", background: "rgba(167,139,250,0.06)" }}
          />
          {handle("nw", px.left, px.top)}
          {handle("ne", px.left + px.width, px.top)}
          {handle("sw", px.left, px.top + px.height)}
          {handle("se", px.left + px.width, px.top + px.height)}
        </>
      )}
      {!isOn(layer, currentOutputTime) && (
        <span className="absolute left-1/2 top-2 -translate-x-1/2 px-2 py-0.5 rounded bg-violet-500/90 text-white text-xs pointer-events-none">
          Move the playhead into the adjustment layer to see it
        </span>
      )}
      {host
        ? createPortal(
            <div className={`${DOCKED_PANEL_CLASS} p-3.5 gap-4`}>
              {header}
              {panel}
            </div>,
            host
          )
        : (
            <div
              className={`${DOCKED_PANEL_CLASS} absolute p-3 gap-3 overflow-y-auto`}
              style={{ right: 8, top: 8, width: 270, maxHeight: Math.max(160, frameRect.height - 16), pointerEvents: "auto", zIndex: 30 }}
            >
              {header}
              {panel}
            </div>
          )}
    </>
  );
};

export default AdjustmentLayersLayer;
