// components/docker/NoiseReductionPopover.tsx
//
// The toolbar's "Clean up audio" surface for one clip - same portal + useClampedPopoverPosition +
// outside-click-close + Slider/NumberStepper shape as SpeedPopover. Everything here is heard live
// (VideoPlayer.tsx's Web Audio graph) and exported with the matching ffmpeg chain
// (conversion.rs's audio_cleanup_filters):
//
//   Mode      "Reduce" - spectral suppression (afftdn), keeps a natural bit of room tone.
//             "Remove" - RNNoise voice isolation (arnndn), strips everything that isn't voice.
//   Strength  Clip.noiseReduction, 0..1 - the denoiser's depth (Reduce) or wet/dry mix (Remove).
//   Extras    low-cut (rumble/wind), mains hum notches (50/60Hz), gate (silence between phrases).
//
// `status` (threaded down from VideoPlayer via Dashboard/VideoTimelineDocker) reflects the live
// graph honestly: "calibrating" while it's loading, RNNoise is downloading its model, or a "Learn
// noise from here" capture is running.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoSyncOutline, IoEarOutline, IoLocateOutline, IoCopyOutline, IoSparkles, IoPlay, IoPause } from "react-icons/io5";
import { MdOutlineNoiseControlOff } from "react-icons/md";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { AudioCleanup } from "../../utils/videoEditTypes";
import Slider from "./Slider";
import NumberStepper from "./NumberStepper";

const STRENGTH_STEP = 0.01;
// "Off" clears the field entirely (undefined, not 0) so a clip that's never touched this feature
// stays byte-for-byte identical to before it existed.
const STRENGTH_PRESETS = [
  { label: "Off", value: 0 },
  { label: "Light", value: 0.25 },
  { label: "Medium", value: 0.5 },
  { label: "Strong", value: 0.85 },
  { label: "Max", value: 1 },
] as const;

export interface AudioCleanupPatch {
  noiseReduction?: number;
  audioCleanup?: AudioCleanup;
}

interface NoiseReductionPopoverProps {
  strength: number; // 0..1, 0 meaning off
  cleanup: AudioCleanup | undefined;
  status: "idle" | "calibrating" | "active";
  anchor: { left: number; top: number };
  // How many clips "Apply to all" would touch - the button is hidden for a single-clip timeline.
  clipCount: number;
  onUpdate: (patch: AudioCleanupPatch) => void;
  onApplyToAll: (patch: AudioCleanupPatch) => void;
  onClose: () => void;
  // Captures a fixed noise profile from what's playing right now ("Reduce" mode) - see
  // VideoPlayerHandle.recalibrateNoiseReduction.
  onRecalibrate?: () => void;
  // A/B compare - true while "Hold to hear original" is held down.
  onPreviewOriginal?: (bypass: boolean) => void;
  // Timeline transport, so the clip can be auditioned without leaving the popover.
  isPlaying: boolean;
  onTogglePlay: () => void;
}

// Drops default/off fields so an untouched clip keeps `audioCleanup: undefined` in its sidecar.
const normalizeCleanup = (c: AudioCleanup): AudioCleanup | undefined => {
  const out: AudioCleanup = {};
  if (c.mode === "remove") out.mode = "remove";
  if (c.lowCut) out.lowCut = true;
  if (c.hum) out.hum = c.hum;
  if (c.gate) out.gate = true;
  return Object.keys(out).length > 0 ? out : undefined;
};

const Toggle: React.FC<{ checked: boolean; onChange: (next: boolean) => void; label: string; hint: string }> = ({ checked, onChange, label, hint }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className="flex items-center justify-between gap-3 w-full px-2 py-1.5 rounded-md text-left hover:bg-white/5 transition-colors"
  >
    <span className="min-w-0">
      <span className="block text-[11px] text-white/85">{label}</span>
      <span className="block text-[10px] text-white/40 leading-tight">{hint}</span>
    </span>
    <span className={`relative shrink-0 w-7 h-4 rounded-full transition-colors ${checked ? "bg-blue-500" : "bg-white/15"}`}>
      <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-3" : ""}`} />
    </span>
  </button>
);

const NoiseReductionPopover: React.FC<NoiseReductionPopoverProps> = ({
  strength,
  cleanup,
  status,
  anchor,
  clipCount,
  onUpdate,
  onApplyToAll,
  onClose,
  onRecalibrate,
  onPreviewOriginal,
  isPlaying,
  onTogglePlay,
}) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);
  const [comparing, setComparing] = useState(false);
  const [appliedToAll, setAppliedToAll] = useState(false);
  const mode = cleanup?.mode ?? "reduce";
  const anythingOn = strength > 0 || !!cleanup?.lowCut || !!cleanup?.hum || !!cleanup?.gate;

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-noise-reduction-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  // Never leave the player stuck on the original if the popover closes mid-compare. Via a ref so
  // a new callback identity on re-render doesn't fire the cleanup mid-hold.
  const onPreviewOriginalRef = useRef(onPreviewOriginal);
  onPreviewOriginalRef.current = onPreviewOriginal;
  useEffect(() => () => onPreviewOriginalRef.current?.(false), []);

  const setStrength = (next: number) => {
    setAppliedToAll(false);
    onUpdate({ noiseReduction: next <= 0 ? undefined : Math.max(0, Math.min(1, next)), audioCleanup: cleanup });
  };
  const setCleanup = (patch: Partial<AudioCleanup>) => {
    setAppliedToAll(false);
    onUpdate({ noiseReduction: strength > 0 ? strength : undefined, audioCleanup: normalizeCleanup({ ...cleanup, ...patch }) });
  };
  const setMode = (next: "reduce" | "remove") => {
    setAppliedToAll(false);
    // Picking a mode with the denoiser off would do nothing audible - start it at a sensible level.
    const nextStrength = strength > 0 ? strength : next === "remove" ? 1 : 0.5;
    onUpdate({ noiseReduction: nextStrength, audioCleanup: normalizeCleanup({ ...cleanup, mode: next }) });
  };

  const startCompare = () => {
    setComparing(true);
    onPreviewOriginal?.(true);
  };
  const stopCompare = () => {
    if (!comparing) return;
    setComparing(false);
    onPreviewOriginal?.(false);
  };

  const statusLabel =
    !anythingOn ? null : status === "calibrating" ? (mode === "remove" ? "Loading AI…" : "Learning…") : status === "active" ? "Live" : null;

  return createPortal(
    <div
      ref={popoverRef}
      data-noise-reduction-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-72 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 text-white/90 flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <span className="text-xs font-semibold flex items-center gap-1.5">
          <MdOutlineNoiseControlOff size={15} className="text-blue-400" />
          Clean up audio
        </span>
        <div className="flex items-center gap-1.5">
          {statusLabel && (
            <span
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] ${
                status === "calibrating" ? "text-blue-300 bg-blue-500/15" : "text-emerald-300 bg-emerald-500/15"
              }`}
            >
              {status === "calibrating" ? <IoSyncOutline size={10} className="animate-spin" /> : <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
              {statusLabel}
            </span>
          )}
          <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
            <IoClose size={14} />
          </button>
        </div>
      </div>

      <div className="px-3 pb-3 flex flex-col gap-3">
        {/* Mode */}
        <div className="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-white/5">
          {([
            { id: "reduce", label: "Reduce noise", hint: "Natural, keeps some ambience" },
            { id: "remove", label: "Remove noise", hint: "AI voice isolation" },
          ] as const).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={`flex flex-col items-start px-2 py-1.5 rounded-md text-left transition-colors ${
                mode === m.id && strength > 0 ? "bg-blue-500/20 ring-1 ring-blue-400/50" : "hover:bg-white/5"
              }`}
            >
              <span className={`flex items-center gap-1 text-[11px] font-medium ${mode === m.id && strength > 0 ? "text-blue-300" : "text-white/80"}`}>
                {m.label}
                {m.id === "remove" && <IoSparkles size={10} className="text-amber-300" />}
              </span>
              <span className="text-[10px] text-white/40 leading-tight">{m.hint}</span>
            </button>
          ))}
        </div>

        {/* Strength */}
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1">
            {STRENGTH_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setStrength(p.value)}
                className={`flex-1 py-1 rounded text-[10px] transition-colors ${
                  Math.abs(strength - p.value) < 0.005
                    ? "text-blue-300 bg-blue-500/15 ring-1 ring-blue-400/40"
                    : "text-white/60 hover:text-white hover:bg-white/10"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="w-14 shrink-0 text-white/50">{mode === "remove" ? "Amount" : "Strength"}</span>
            <Slider value={strength} min={0} max={1} step={STRENGTH_STEP} marks={STRENGTH_PRESETS.map((p) => p.value)} onChange={setStrength} />
            <NumberStepper value={strength * 100} min={0} max={100} step={STRENGTH_STEP * 100} decimals={0} suffix="%" onChange={(pct) => setStrength(pct / 100)} />
          </div>
        </div>

        {/* Extra cleanup */}
        <div className="flex flex-col gap-0.5 pt-2 border-t border-white/10">
          <span className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/35">Extra cleanup</span>
          <Toggle
            checked={!!cleanup?.lowCut}
            onChange={(lowCut) => setCleanup({ lowCut })}
            label="Cut rumble & wind"
            hint="Removes low thumps, handling noise, wind"
          />
          <div className="flex items-center justify-between gap-3 px-2 py-1.5">
            <span className="min-w-0">
              <span className="block text-[11px] text-white/85">Remove hum</span>
              <span className="block text-[10px] text-white/40 leading-tight">Electrical buzz from mains power</span>
            </span>
            <div className="flex shrink-0 p-0.5 rounded-md bg-white/5">
              {([undefined, 50, 60] as const).map((hz) => (
                <button
                  key={hz ?? "off"}
                  type="button"
                  onClick={() => setCleanup({ hum: hz })}
                  className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                    cleanup?.hum === hz ? "bg-blue-500/25 text-blue-300" : "text-white/55 hover:text-white"
                  }`}
                >
                  {hz ? `${hz}Hz` : "Off"}
                </button>
              ))}
            </div>
          </div>
          <Toggle
            checked={!!cleanup?.gate}
            onChange={(gate) => setCleanup({ gate })}
            label="Silence gaps"
            hint="Mutes leftover noise between phrases"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onTogglePlay}
            title={isPlaying ? "Pause" : "Play"}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="shrink-0 flex items-center justify-center w-9 rounded-md bg-blue-500 hover:bg-blue-400 text-white transition-colors"
          >
            {isPlaying ? <IoPause size={14} /> : <IoPlay size={14} className="translate-x-px" />}
          </button>
          {anythingOn && (
            <button
              type="button"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                startCompare();
              }}
              onPointerUp={stopCompare}
              onPointerCancel={stopCompare}
              onLostPointerCapture={stopCompare}
              title="Hold to hear the original audio, release to hear the cleaned version"
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] transition-colors select-none ${
                comparing ? "bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/40" : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
              }`}
            >
              <IoEarOutline size={13} />
              {comparing ? "Original" : "Hold to compare"}
            </button>
          )}
          {anythingOn && mode === "reduce" && strength > 0 && (
            <button
              type="button"
              onClick={onRecalibrate}
              title="Play a moment with only background noise (no speech), then click to learn exactly that noise"
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] bg-white/5 text-white/70 hover:bg-white/10 hover:text-white transition-colors"
            >
              <IoLocateOutline size={13} />
              Learn noise here
            </button>
          )}
          {!anythingOn && <span className="flex-1 flex items-center text-[10px] text-white/40">Play the clip to hear changes live</span>}
        </div>

        {clipCount > 1 && anythingOn && (
          <button
            type="button"
            onClick={() => {
              onApplyToAll({ noiseReduction: strength > 0 ? strength : undefined, audioCleanup: cleanup });
              setAppliedToAll(true);
            }}
            className="flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] text-blue-300 hover:text-blue-200 hover:bg-blue-500/10 transition-colors"
          >
            <IoCopyOutline size={12} />
            {appliedToAll ? `Applied to all ${clipCount} clips` : `Apply to all ${clipCount} clips`}
          </button>
        )}

        <p className="text-[10px] leading-snug text-white/40 pt-2 border-t border-white/10">
          {!anythingOn
            ? "Pick a mode to start - you hear changes live while the clip plays."
            : mode === "remove" && strength > 0
            ? "Keeps only voices. Great for talks and interviews; turn it down or use Reduce if music or ambience matters."
            : status === "calibrating"
            ? "Learning this clip's noise from what's playing - keep it playing for a moment."
            : strength > 0
            ? "Adapts to the noise automatically. For steady noise, play a noise-only moment and hit “Learn noise here”."
            : "Extra cleanup works on its own, or together with a denoise mode above."}
        </p>
      </div>
    </div>,
    document.body
  );
};

export default NoiseReductionPopover;
