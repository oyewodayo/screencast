// components/docker/NoiseReductionPopover.tsx
//
// Standalone background-noise-reduction surface for the toolbar's own "Reduce noise" button -
// same reasoning Speed/Crop already got their own standalone buttons for (ClipEffectsPopover is
// for color grade/Ken Burns/transition only), and same portal + useClampedPopoverPosition +
// outside-click-close + Slider/NumberStepper shape as SpeedPopover. Unlike a CSS-only effect
// (color/crop), turning this on genuinely takes a moment - VideoPlayer.tsx wires up a real Web
// Audio graph (an AudioWorkletNode running noise-reduction-processor.js) the first time it's used,
// which needs to both load and learn a noise profile from a moment of this clip's own audio before
// the real effect kicks in. `status` (threaded down from VideoPlayer via Dashboard/
// VideoTimelineDocker - see noiseReductionStatus's own doc comment there) reflects that honestly
// rather than pretending it's instant.
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoSyncOutline } from "react-icons/io5";
import { MdOutlineNoiseControlOff } from "react-icons/md";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import Slider from "./Slider";
import NumberStepper from "./NumberStepper";

const STRENGTH_STEP = 0.01;
// Mirrors the words afftdn's own strength range maps onto (see segment_noise_reduction_db,
// conversion.rs) - "Off" clears the field entirely (undefined, not 0) so a clip that's never
// touched this feature stays byte-for-byte identical to before it existed.
const STRENGTH_PRESETS = [
  { label: "Off", value: 0 },
  { label: "Light", value: 0.25 },
  { label: "Medium", value: 0.5 },
  { label: "Strong", value: 0.85 },
] as const;

interface NoiseReductionPopoverProps {
  strength: number; // 0..1, 0 meaning off
  status: "idle" | "calibrating" | "active";
  anchor: { left: number; top: number };
  onUpdate: (strength: number | undefined) => void;
  onClose: () => void;
}

const NoiseReductionPopover: React.FC<NoiseReductionPopoverProps> = ({ strength, status, anchor, onUpdate, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-noise-reduction-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  const setStrength = (next: number) => onUpdate(next <= 0 ? undefined : Math.max(0, Math.min(1, next)));

  return createPortal(
    <div
      ref={popoverRef}
      data-noise-reduction-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-64 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <MdOutlineNoiseControlOff size={14} />
          Reduce noise
        </span>
        <div className="flex items-center gap-1.5">
          {strength > 0 && (
            <span className={`flex items-center gap-1 text-[10px] ${status === "calibrating" ? "text-blue-400" : "text-white/40"}`}>
              {status === "calibrating" && <IoSyncOutline size={11} className="animate-spin" />}
              {status === "calibrating" ? "Calibrating…" : status === "active" ? "Live" : ""}
            </span>
          )}
          <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
            <IoClose size={14} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {STRENGTH_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => setStrength(p.value)}
            className={`px-2 py-1 rounded text-[11px] transition-colors ${
              Math.abs(strength - p.value) < 0.005
                ? "text-blue-400 bg-blue-500/10 ring-1 ring-blue-400/40"
                : "text-white/70 hover:text-white hover:bg-white/10"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 text-[11px]">
        <span className="w-12 shrink-0 text-white/60">Strength</span>
        <Slider value={strength} min={0} max={1} step={STRENGTH_STEP} marks={STRENGTH_PRESETS.map((p) => p.value)} onChange={setStrength} />
        <NumberStepper value={strength * 100} min={0} max={100} step={STRENGTH_STEP * 100} decimals={0} suffix="%" onChange={(pct) => setStrength(pct / 100)} />
      </div>

      <p className="text-[10px] leading-snug text-white/40 pt-1 border-t border-white/10">
        {status === "calibrating"
          ? "Learning this clip's background noise from what's playing right now - takes under a second, keep playing."
          : "Hear it live as you adjust it - listens for a moment of this clip's own background noise the first time it turns on."}
      </p>
    </div>,
    document.body
  );
};

export default NoiseReductionPopover;
