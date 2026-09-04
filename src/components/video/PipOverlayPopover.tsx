// components/video/PipOverlayPopover.tsx
//
// Position/size/shape controls for a selected PipOverlay - same portal + useClampedPopoverPosition
// + outside-click-close shape as ClipEffectsPopover/AudioOverlayPopover. Position can also be
// dragged directly on the video itself (PipOverlayLayer.tsx) - the X/Y sliders here are a precise/
// keyboard-friendly alternative, not the only way to move it. Size/shape have no on-canvas
// equivalent yet (no resize handle), so these sliders are still the only way to change those - a
// smaller, simpler control surface than ImageOverlay/BlurOverlay get, in exchange for not
// duplicating VideoOverlayLayer.tsx's much larger resize/rotate machinery for a first version of
// this feature.
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoTrashOutline } from "react-icons/io5";
import { PipOverlay, PipShape } from "../../utils/videoEditTypes";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";

export type PipOverlayPatch = Partial<Pick<PipOverlay, "x" | "y" | "width" | "height" | "shape" | "cornerRadius" | "volume" | "muted">>;

const SHAPE_OPTIONS: { value: PipShape; label: string }[] = [
  { value: "circle", label: "Circle" },
  { value: "rounded", label: "Rounded" },
  { value: "rectangle", label: "Rectangle" },
];

interface PipOverlayPopoverProps {
  overlay: PipOverlay;
  anchor: { left: number; top: number };
  onUpdate: (patch: PipOverlayPatch) => void;
  onDelete: () => void;
  onClose: () => void;
}

const Slider: React.FC<{ label: string; value: number; onChange: (v: number) => void; max?: number }> = ({ label, value, onChange, max = 1 }) => (
  <label className="flex items-center gap-2 text-[11px]">
    <span className="w-10 shrink-0 text-white/60">{label}</span>
    <input type="range" min={0} max={max} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 accent-blue-400" />
    <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round((value / max) * 100)}%</span>
  </label>
);

const PipOverlayPopover: React.FC<PipOverlayPopoverProps> = ({ overlay, anchor, onUpdate, onDelete, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-pip-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      data-pip-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-64 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Picture-in-picture</span>
        <div className="flex items-center gap-1">
          <button type="button" title="Delete" onClick={onDelete} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-red-400">
            <IoTrashOutline size={14} />
          </button>
          <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
            <IoClose size={14} />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Position &amp; size</span>
        <Slider label="X" value={overlay.x} onChange={(x) => onUpdate({ x: Math.max(0, Math.min(1 - overlay.width, x)) })} />
        <Slider label="Y" value={overlay.y} onChange={(y) => onUpdate({ y: Math.max(0, Math.min(1 - overlay.height, y)) })} />
        <Slider label="Width" value={overlay.width} onChange={(width) => onUpdate({ width: Math.max(0.05, Math.min(1 - overlay.x, width)) })} />
        <Slider label="Height" value={overlay.height} onChange={(height) => onUpdate({ height: Math.max(0.05, Math.min(1 - overlay.y, height)) })} />
      </div>

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Shape</span>
        <div className="flex flex-wrap gap-1">
          {SHAPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onUpdate({ shape: opt.value })}
              className={`px-2 py-1 rounded text-[11px] transition-colors ${
                overlay.shape === opt.value ? "text-blue-400 bg-blue-500/10 ring-1 ring-blue-400/40" : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {overlay.shape === "rounded" && (
          <Slider label="Radius" value={overlay.cornerRadius ?? 0.08} onChange={(cornerRadius) => onUpdate({ cornerRadius })} max={0.3} />
        )}
      </div>

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Audio</span>
        <label className="flex items-center gap-2 text-[11px]">
          {/* overlay.muted === false (not just falsy) - a pip saved before this field existed
              loads back with muted:undefined, which the export path (useVideoEditStore.ts)
              already treats as muted; showing this checked for that same data would silently
              disagree with what actually plays. */}
          <input type="checkbox" checked={overlay.muted === false} onChange={(e) => onUpdate({ muted: !e.target.checked })} />
          <span className="text-white/70">Play this clip's own audio</span>
        </label>
        {overlay.muted === false && (
          <Slider label="Volume" value={Number.isFinite(overlay.volume) ? overlay.volume : 1} onChange={(volume) => onUpdate({ volume })} />
        )}
      </div>
    </div>,
    document.body
  );
};

export default PipOverlayPopover;
