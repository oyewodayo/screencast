// components/docker/SpeedPopover.tsx
//
// Standalone playback-speed surface for the toolbar's own Speed button, split out of
// ClipEffectsPopover (which now only covers color grade/Ken Burns/transition) - speed has enough
// of its own subfeatures (presets, fine slider, a duration readout, and room to grow: reverse,
// ramping, etc.) to earn its own button rather than being one more section buried inside "Clip
// effects", the same reasoning Crop already got its own standalone toolbar button for. Same portal
// + useClampedPopoverPosition + outside-click-close shape as ClipEffectsPopover/SilenceDetectionPopover.
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IoChevronDown, IoChevronUp, IoClose, IoSpeedometerOutline } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import Slider from "./Slider";

// Same range export_trimmed_video's own atempo_chain (conversion.rs) is built to handle cleanly -
// see that function's own doc comment for why arbitrarily large factors aren't offered here.
const MIN_SPEED = 0.25;
const MAX_SPEED = 4;
const SPEED_PRESETS = [0.5, 1, 1.5, 2] as const;
const SPEED_STEP = 0.05;
const DURATION_STEP = 0.1;

interface SpeedPopoverProps {
  speed: number;
  // This clip's own trimmed source-range length in seconds, at 1x - i.e. (clip.end - clip.start),
  // speed-invariant by construction. Needed to show/edit the resulting OUTPUT duration
  // (sourceDuration / speed) alongside the speed factor itself, the way a duration field and a
  // speed field are just two views of the same underlying value.
  sourceDuration: number;
  anchor: { left: number; top: number };
  onUpdate: (speed: number | undefined) => void;
  onClose: () => void;
}

// A speed/duration field editable three ways at once: type a value directly, click the up/down
// steppers, or (for speed) drag the slider next to it - all three just call the same onChange.
// Shows a formatted (suffixed, fixed-precision) string while not focused, and the raw editable
// number while it is, so a mid-edit value like "1." isn't fought over by re-formatting on every
// keystroke.
const NumberStepper: React.FC<{
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
  suffix: string;
  onChange: (next: number) => void;
}> = ({ value, min, max, step, decimals, suffix, onChange }) => {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) onChange(Math.max(min, Math.min(max, parsed)));
    setDraft(null);
  };
  const nudge = (delta: number) => onChange(Math.max(min, Math.min(max, value + delta)));

  return (
    <div className="flex items-center shrink-0 rounded bg-black/40 ring-1 ring-white/10 overflow-hidden">
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? `${value.toFixed(decimals)}${suffix}`}
        onFocus={() => setDraft(value.toFixed(decimals))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setDraft(null);
        }}
        className="w-14 bg-transparent pl-1.5 py-1 text-[11px] text-right tabular-nums text-white/90 outline-none"
      />
      <div className="flex flex-col border-l border-white/10">
        <button
          type="button"
          tabIndex={-1}
          title="Increase"
          onClick={() => nudge(step)}
          className="px-1 h-3.5 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10"
        >
          <IoChevronUp size={9} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          title="Decrease"
          onClick={() => nudge(-step)}
          className="px-1 h-3.5 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 border-t border-white/10"
        >
          <IoChevronDown size={9} />
        </button>
      </div>
    </div>
  );
};

const SpeedPopover: React.FC<SpeedPopoverProps> = ({ speed, sourceDuration, anchor, onUpdate, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-speed-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  const setSpeed = (next: number) => onUpdate(Math.abs(next - 1) < 0.001 ? undefined : Math.max(MIN_SPEED, Math.min(MAX_SPEED, next)));
  // Duration is just 1/speed scaled by sourceDuration - editing it directly sets speed to
  // whatever factor reproduces that duration, same clamping/reset-to-1x rules as setSpeed itself.
  const setDuration = (nextDuration: number) => {
    if (sourceDuration <= 0 || nextDuration <= 0) return;
    setSpeed(sourceDuration / nextDuration);
  };
  const outputDuration = sourceDuration > 0 ? sourceDuration / speed : 0;
  // Bounds run in the opposite direction from speed's own (max speed -> shortest duration).
  const durationMin = sourceDuration / MAX_SPEED;
  const durationMax = sourceDuration / MIN_SPEED;

  return createPortal(
    <div
      ref={popoverRef}
      data-speed-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-64 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <IoSpeedometerOutline size={13} />
          Speed
        </span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1">
        {SPEED_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setSpeed(p)}
            className={`px-2 py-1 rounded text-[11px] transition-colors ${
              Math.abs(speed - p) < 0.001 ? "text-blue-400 bg-blue-500/10 ring-1 ring-blue-400/40" : "text-white/70 hover:text-white hover:bg-white/10"
            }`}
          >
            {p}x
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="w-12 shrink-0 text-white/60">Speed</span>
        <Slider value={speed} min={MIN_SPEED} max={MAX_SPEED} step={SPEED_STEP} marks={SPEED_PRESETS} onChange={setSpeed} />
        <NumberStepper value={speed} min={MIN_SPEED} max={MAX_SPEED} step={SPEED_STEP} decimals={2} suffix="x" onChange={setSpeed} />
      </div>

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Duration</span>
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-white/50">{sourceDuration.toFixed(1)}s at 1x</span>
          <NumberStepper
            value={outputDuration}
            min={durationMin}
            max={durationMax}
            step={DURATION_STEP}
            decimals={1}
            suffix="s"
            onChange={setDuration}
          />
        </div>
      </div>
    </div>,
    document.body
  );
};

export default SpeedPopover;
