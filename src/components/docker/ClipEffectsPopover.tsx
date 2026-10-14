// components/docker/ClipEffectsPopover.tsx
//
// The style/control surface for a selected CLIP's own effects (color grade, Ken Burns, a
// transition-in from the previous clip) - portal + useClampedPopoverPosition + outside-click-
// close, same shape as
// AudioOverlayPopover.tsx, just for a clip instead of an audio overlay. Deliberately a selection-
// driven popover (opened from the toolbar's Effects button once a clip is selected on the
// timeline), not the "armed placement" pattern text/image/blur tools use - these effects apply to
// footage you've already selected, not something you click-to-place on the video preview.
// Crop and Speed each have their own standalone toolbar button/popover (ClipCropOverlay's
// arm/disarm toggle and SpeedPopover, respectively) rather than living in here - both have enough
// of their own subfeatures to earn a dedicated surface instead of being one more section buried
// inside "Clip effects".
import React, { useEffect } from "react";
import TransitionLookControls, { transitionHasLook } from "./TransitionLookControls";
import { createPortal } from "react-dom";
import { IoClose } from "react-icons/io5";
import { Clip, ColorFilterPreset, KenBurnsPreset, TransitionType, isImageClipPath } from "../../utils/videoEditTypes";
import { COLOR_FILTER_PRESETS, KEN_BURNS_PRESETS, TRANSITION_PRESETS } from "../../utils/videoColorFilters";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, useToolPanelHost } from "./ToolPanelHost";
import ColorGradeControls from "./ColorGradeControls";

export type ClipEffectsPatch = Partial<Pick<Clip, "colorFilter" | "grade" | "stabilize" | "kenBurns" | "transitionIn" | "flipHorizontal" | "muted">>;

export const DEFAULT_STABILIZE_STRENGTH = 0.5;

export const DEFAULT_COLOR_INTENSITY = 0.7;
export const DEFAULT_KEN_BURNS_INTENSITY = 0.5;
export const DEFAULT_TRANSITION_DURATION = 0.5;

interface ClipEffectsPopoverProps {
  clip: Clip;
  hasPrecedingClip: boolean;
  // Whether this clip is the one in the preview right now (the grade's histogram reads the screen).
  isOnScreen: boolean;
  anchor: { left: number; top: number };
  onUpdate: (patch: ClipEffectsPatch) => void;
  onClose: () => void;
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

const ClipEffectsPopover: React.FC<ClipEffectsPopoverProps> = ({ clip, hasPrecedingClip, isOnScreen, anchor, onUpdate, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);
  // Docked into the sidebar's Tools tab when it's there - see ToolPanelHost.tsx.
  const dockHost = useToolPanelHost();

  useEffect(() => {
    // A docked panel stays open until its X / toolbar button closes it.
    if (dockHost) return;
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-clip-effects-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose, dockHost]);

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
    // A new move for this clip - keeps an auto-zoom's target, starts the move from its beginning.
    onUpdate({ kenBurns: preset ? { preset, intensity: kenBurnsIntensity, targetX: clip.kenBurns?.targetX, targetY: clip.kenBurns?.targetY } : undefined });
  };

  const transitionType = clip.transitionIn?.type ?? null;
  const transitionDuration = clip.transitionIn?.duration ?? DEFAULT_TRANSITION_DURATION;
  const transitionLook = clip.transitionIn?.look;
  const setTransitionType = (type: TransitionType | null) => {
    // The look carries over between transitions that understand it (a leak's colour to a flash...).
    onUpdate({ transitionIn: type ? { type, duration: transitionDuration, ...(transitionLook ? { look: transitionLook } : {}) } : undefined });
  };

  return createPortal(
    <div
      ref={popoverRef}
      data-clip-effects-popover
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={dockHost ? `${DOCKED_PANEL_CLASS} p-3 gap-3` : "w-72 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-3"}
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

      <div className="pt-1 border-t border-white/10">
        <ColorGradeControls grade={clip.grade} onChange={(grade) => onUpdate({ grade })} isOnScreen={isOnScreen} />
      </div>

      {!isImageClipPath(clip.sourcePath) && (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Stabilize</span>
          <PresetRow>
            <PresetButton active={!clip.stabilize} onClick={() => onUpdate({ stabilize: undefined })}>
              Off
            </PresetButton>
            <PresetButton active={!!clip.stabilize} onClick={() => onUpdate({ stabilize: { strength: clip.stabilize?.strength ?? DEFAULT_STABILIZE_STRENGTH } })}>
              Remove camera shake
            </PresetButton>
          </PresetRow>
          {clip.stabilize && (
            <>
              <label className="flex items-center gap-2 text-[11px] pt-0.5">
                <span className="w-12 shrink-0 text-white/60">Strength</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={clip.stabilize.strength}
                  onChange={(e) => onUpdate({ stabilize: { strength: Number(e.target.value) } })}
                  className="flex-1 accent-blue-400"
                />
                <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(clip.stabilize.strength * 100)}%</span>
              </label>
              <p className="text-[10px] leading-snug text-white/45">
                Applied when you save. Stronger is steadier but crops in a little more. Right-click the clip and choose View clip to preview it stabilized.
              </p>
            </>
          )}
        </div>
      )}

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
              onChange={(e) => onUpdate({ kenBurns: { ...clip.kenBurns, preset: kenBurnsPreset, intensity: Number(e.target.value) } })}
              className="flex-1 accent-blue-400"
            />
            <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(kenBurnsIntensity * 100)}%</span>
          </label>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-white/10 text-[11px]">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Clip sound</span>
        <button
          type="button"
          title={clip.muted ? "This clip plays silently - click to hear it" : "Silence just this clip (e.g. under music)"}
          onClick={() => onUpdate({ muted: clip.muted ? undefined : true })}
          className={`px-2 h-6 rounded transition-colors ${clip.muted ? "text-red-300 bg-red-500/15" : "text-white/70 bg-white/[0.06] hover:bg-white/10"}`}
        >
          {clip.muted ? "Muted" : "On"}
        </button>
      </div>

      {hasPrecedingClip && (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10" title="Plays over the start of this clip, from the previous clip's last frame - in the preview and the export alike">
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
                onChange={(e) => onUpdate({ transitionIn: { ...clip.transitionIn, type: transitionType, duration: Number(e.target.value) } })}
                className="flex-1 accent-blue-400"
              />
              <span className="w-10 shrink-0 text-right tabular-nums text-white/60">{transitionDuration.toFixed(2)}s</span>
            </label>
          )}
          {transitionType !== null && transitionHasLook(transitionType) && (
            <TransitionLookControls
              type={transitionType}
              look={transitionLook}
              onChange={(look) => onUpdate({ transitionIn: { type: transitionType, duration: transitionDuration, look } })}
            />
          )}
        </div>
      )}
    </div>,
    dockHost ?? document.body
  );
};

export default ClipEffectsPopover;
