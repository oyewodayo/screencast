// components/docker/ClipEffectsPopover.tsx
//
// The style/control surface for a selected CLIP's own effects (color grade, Ken Burns, a
// transition-in from the previous clip) - portal + useClampedPopoverPosition + outside-click-
// close, same shape as
// AudioOverlayPopover.tsx, just for a clip instead of an audio overlay. Deliberately a selection-
// driven popover (opened from the toolbar's Effects button once a clip is selected on the
// timeline), not the "armed placement" pattern text/image/blur tools use - these effects apply to
// footage you've already selected, not something you click-to-place on the video preview.
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { IoClose } from "react-icons/io5";
import { Clip, ColorFilterPreset, KenBurnsPreset, TransitionType } from "../../utils/videoEditTypes";
import { COLOR_FILTER_PRESETS, KEN_BURNS_PRESETS, TRANSITION_PRESETS } from "../../utils/videoColorFilters";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";

export type ClipEffectsPatch = Partial<Pick<Clip, "colorFilter" | "kenBurns" | "transitionIn" | "crop">>;

const DEFAULT_COLOR_INTENSITY = 0.7;
const DEFAULT_KEN_BURNS_INTENSITY = 0.5;
const DEFAULT_TRANSITION_DURATION = 0.5;

interface ClipEffectsPopoverProps {
  clip: Clip;
  hasPrecedingClip: boolean;
  anchor: { left: number; top: number };
  onUpdate: (patch: ClipEffectsPatch) => void;
  onClose: () => void;
  // Crop itself is edited directly on the video preview (ClipCropOverlay, armed/disarmed from
  // VideoTimelineDocker's own toolbar Crop button) - this popover only shows whether a crop is
  // active (None) and offers the same arm/disarm toggle for discoverability, it doesn't own any
  // crop UI of its own.
  isCropping: boolean;
  onToggleCropping: () => void;
}

const PresetRow: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="flex flex-wrap gap-1">{children}</div>;

const PresetButton: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-2 py-1 rounded text-[11px] transition-colors ${
      active ? "text-blue-400 bg-blue-500/10 ring-1 ring-blue-400/40" : "text-white/70 hover:text-white hover:bg-white/10"
    }`}
  >
    {children}
  </button>
);

const ClipEffectsPopover: React.FC<ClipEffectsPopoverProps> = ({ clip, hasPrecedingClip, anchor, onUpdate, onClose, isCropping, onToggleCropping }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-clip-effects-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  const colorPreset = clip.colorFilter?.preset ?? "none";
  const colorIntensity = clip.colorFilter?.intensity ?? DEFAULT_COLOR_INTENSITY;
  const setColorPreset = (preset: ColorFilterPreset) => {
    if (preset === "none") {
      onUpdate({ colorFilter: undefined });
    } else {
      onUpdate({ colorFilter: { preset, intensity: colorIntensity } });
    }
  };

  const kenBurnsPreset = clip.kenBurns?.preset ?? null;
  const kenBurnsIntensity = clip.kenBurns?.intensity ?? DEFAULT_KEN_BURNS_INTENSITY;
  const setKenBurnsPreset = (preset: KenBurnsPreset | null) => {
    onUpdate({ kenBurns: preset ? { preset, intensity: kenBurnsIntensity } : undefined });
  };

  const transitionType = clip.transitionIn?.type ?? null;
  const transitionDuration = clip.transitionIn?.duration ?? DEFAULT_TRANSITION_DURATION;
  const setTransitionType = (type: TransitionType | null) => {
    onUpdate({ transitionIn: type ? { type, duration: transitionDuration } : undefined });
  };

  return createPortal(
    <div
      ref={popoverRef}
      data-clip-effects-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-72 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Clip effects</span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Color</span>
        <PresetRow>
          {COLOR_FILTER_PRESETS.map((p) => (
            <PresetButton key={p.value} active={colorPreset === p.value} onClick={() => setColorPreset(p.value)}>
              {p.label}
            </PresetButton>
          ))}
        </PresetRow>
        {colorPreset !== "none" && (
          <label className="flex items-center gap-2 text-[11px] pt-0.5">
            <span className="w-12 shrink-0 text-white/60">Intensity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={colorIntensity}
              onChange={(e) => onUpdate({ colorFilter: { preset: colorPreset, intensity: Number(e.target.value) } })}
              className="flex-1 accent-blue-400"
            />
            <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(colorIntensity * 100)}%</span>
          </label>
        )}
      </div>

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Ken Burns</span>
        <PresetRow>
          <PresetButton active={kenBurnsPreset === null} onClick={() => setKenBurnsPreset(null)}>
            None
          </PresetButton>
          {KEN_BURNS_PRESETS.map((p) => (
            <PresetButton key={p.value} active={kenBurnsPreset === p.value} onClick={() => setKenBurnsPreset(p.value)}>
              {p.label}
            </PresetButton>
          ))}
        </PresetRow>
        {kenBurnsPreset !== null && (
          <label className="flex items-center gap-2 text-[11px] pt-0.5">
            <span className="w-12 shrink-0 text-white/60">Amount</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={kenBurnsIntensity}
              onChange={(e) => onUpdate({ kenBurns: { preset: kenBurnsPreset, intensity: Number(e.target.value) } })}
              className="flex-1 accent-blue-400"
            />
            <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(kenBurnsIntensity * 100)}%</span>
          </label>
        )}
      </div>

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Crop</span>
        <PresetRow>
          <PresetButton active={!clip.crop} onClick={() => onUpdate({ crop: undefined })}>
            None
          </PresetButton>
          <PresetButton active={isCropping} onClick={onToggleCropping}>
            {isCropping ? "Editing on preview…" : "Edit on preview"}
          </PresetButton>
        </PresetRow>
      </div>

      {hasPrecedingClip && (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10" title="Preview shows a hard cut here - the real transition only renders in the exported video">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Transition (with previous clip)</span>
          <PresetRow>
            <PresetButton active={transitionType === null} onClick={() => setTransitionType(null)}>
              None
            </PresetButton>
            {TRANSITION_PRESETS.map((p) => (
              <PresetButton key={p.value} active={transitionType === p.value} onClick={() => setTransitionType(p.value)}>
                {p.label}
              </PresetButton>
            ))}
          </PresetRow>
          {transitionType !== null && (
            <label className="flex items-center gap-2 text-[11px] pt-0.5">
              <span className="w-12 shrink-0 text-white/60">Duration</span>
              <input
                type="range"
                min={0.2}
                max={1.5}
                step={0.05}
                value={transitionDuration}
                onChange={(e) => onUpdate({ transitionIn: { type: transitionType, duration: Number(e.target.value) } })}
                className="flex-1 accent-blue-400"
              />
              <span className="w-10 shrink-0 text-right tabular-nums text-white/60">{transitionDuration.toFixed(2)}s</span>
            </label>
          )}
        </div>
      )}
    </div>,
    document.body
  );
};

export default ClipEffectsPopover;
