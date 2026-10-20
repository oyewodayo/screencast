// components/docker/SpeedPopover.tsx
//
// Standalone playback-speed surface for the toolbar's own Speed button, split out of
// ClipEffectsPopover (which now only covers color grade/Ken Burns/transition) - speed has enough
// of its own subfeatures (presets, fine slider, a duration readout, and room to grow: reverse,
// ramping, etc.) to earn its own button rather than being one more section buried inside "Clip
// effects", the same reasoning Crop already got its own standalone toolbar button for. Same portal
// + useClampedPopoverPosition + outside-click-close shape as ClipEffectsPopover/SilenceDetectionPopover.
import React from "react";
import { createPortal } from "react-dom";
import { IoClose, IoSpeedometerOutline } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, SelectionCountBadge, useToolPanelHost, useDockSnap, useFloatingDismiss } from "./ToolPanelHost";
import Slider from "./Slider";
import NumberStepper from "./NumberStepper";
import { ClipSpeedRamp, SPEED_RAMP_PRESETS, clipOutputDuration, clipSpeedSteps } from "../../utils/clipTiming";

// Same range export_trimmed_video's own atempo_chain (conversion.rs) is built to handle cleanly -
// see that function's own doc comment for why arbitrarily large factors aren't offered here.
const MIN_SPEED = 0.25;
// Up to 16x (the browser's own playback limit) for very short, punchy cuts; the slider itself stops
// at 4x so it stays fine-grained where most edits live - the field and Duration go the rest of the way.
const MAX_SPEED = 16;
const SLIDER_MAX_SPEED = 4;
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
  // >1 while a multi-selection is being sped up together - each keeps its own length, so the one-
  // clip Duration field (which solves for a speed from THIS clip's length) is hidden then.
  selectedCount?: number;
  onUpdate: (speed: number | undefined) => void;
  // Speed ramp - a curve on top of `speed` (clipTiming.ts).
  ramp?: ClipSpeedRamp;
  onRampChange: (ramp: ClipSpeedRamp | undefined) => void;
  onClose: () => void;
}

const DEFAULT_RAMP_AMOUNT = 0.6;

// The ramp's actual steps as a small bar graph (speed per step, 1x marked) - what plays, exactly.
const RampGraph: React.FC<{ speed: number; ramp: ClipSpeedRamp }> = ({ speed, ramp }) => {
  const steps = clipSpeedSteps({ start: 0, end: 1, speed, speedRamp: ramp });
  const max = Math.max(1.5, ...steps.map((s) => s.speed));
  const h = 36;
  const y = (v: number) => h - (Math.log2(v / 0.25) / Math.log2(max / 0.25)) * (h - 2);
  return (
    <svg viewBox={`0 0 ${steps.length} ${h}`} preserveAspectRatio="none" className="w-full h-9 rounded bg-black/40" aria-hidden>
      <line x1={0} x2={steps.length} y1={y(1)} y2={y(1)} stroke="rgba(255,255,255,0.25)" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
      {steps.map((s, i) => (
        <rect key={i} x={i + 0.1} width={0.8} y={y(s.speed)} height={h - y(s.speed)} fill={s.speed < 1 ? "rgba(96,165,250,0.8)" : "rgba(45,212,191,0.8)"} />
      ))}
    </svg>
  );
};

const SpeedPopover: React.FC<SpeedPopoverProps> = ({ speed, sourceDuration, anchor, selectedCount, onUpdate, ramp, onRampChange, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);
  // Docked into the sidebar's Tools tab when it's there - see ToolPanelHost.tsx.
  const dockHost = useToolPanelHost();

  // A click elsewhere closes it - unless that click opened the sidebar, which docks it instead,
  // gliding into place. Docked, it stays open until its X / toolbar button closes it.
  useFloatingDismiss("[data-speed-popover]", onClose, !!dockHost);
  useDockSnap(popoverRef, !!dockHost);

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
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={dockHost ? `${DOCKED_PANEL_CLASS} p-3 gap-2.5` : "w-64 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <IoSpeedometerOutline size={13} />
          Speed
          <SelectionCountBadge count={selectedCount} />
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
        <Slider value={Math.min(speed, SLIDER_MAX_SPEED)} min={MIN_SPEED} max={SLIDER_MAX_SPEED} step={SPEED_STEP} marks={SPEED_PRESETS} onChange={setSpeed} />
        <NumberStepper value={speed} min={MIN_SPEED} max={MAX_SPEED} step={SPEED_STEP} decimals={2} suffix="x" onChange={setSpeed} />
      </div>

      {(selectedCount ?? 1) <= 1 && (
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
      )}

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Speed ramp</span>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => onRampChange(undefined)}
            className={`px-2 py-1 rounded text-[11px] ${!ramp ? "text-blue-400 bg-blue-500/10 ring-1 ring-blue-400/40" : "text-white/70 hover:text-white hover:bg-white/10"}`}
          >
            None
          </button>
          {SPEED_RAMP_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              title={p.hint}
              onClick={() => onRampChange({ preset: p.value, amount: ramp?.amount ?? DEFAULT_RAMP_AMOUNT })}
              className={`px-2 py-1 rounded text-[11px] ${ramp?.preset === p.value ? "text-blue-400 bg-blue-500/10 ring-1 ring-blue-400/40" : "text-white/70 hover:text-white hover:bg-white/10"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {ramp && (
          <>
            <RampGraph speed={speed} ramp={ramp} />
            <label className="flex items-center gap-2 text-[11px]">
              <span className="w-12 shrink-0 text-white/60">Amount</span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.01}
                value={ramp.amount}
                onChange={(e) => onRampChange({ ...ramp, amount: Number(e.target.value) })}
                className="flex-1 accent-blue-400"
              />
              <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(ramp.amount * 100)}%</span>
            </label>
            <p className="text-[10px] leading-snug text-white/45">
              Now {clipOutputDuration({ start: 0, end: sourceDuration, speed, speedRamp: ramp }).toFixed(1)}s long. Plays live, exactly as it exports.
            </p>
          </>
        )}
      </div>
    </div>,
    dockHost ?? document.body
  );
};

export default SpeedPopover;
