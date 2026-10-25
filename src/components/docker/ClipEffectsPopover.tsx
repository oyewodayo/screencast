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
import React, { useState } from "react";
import { ColorGrid, FxGrid, LookGrid, MotionGrid } from "./EffectPreviewGrids";
import { DEFAULT_CLIP_FX_INTENSITY } from "../../utils/clipFx";
import { TRANSITION_SOUNDS } from "../../utils/builtinSfx";
import { hasGrade } from "../../utils/colorGrade";
import TransitionLookControls, { transitionHasLook } from "./TransitionLookControls";
import { createPortal } from "react-dom";
import { IoClose } from "react-icons/io5";
import { Clip, ClipFxKind, ClipGrade, ColorFilterPreset, GradeLookName, KenBurnsPreset, TransitionType, isImageClipPath } from "../../utils/videoEditTypes";
import TransitionGrid from "./TransitionGrid";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, SelectionCountBadge, useToolPanelHost, useDockSnap, useFloatingDismiss } from "./ToolPanelHost";
import ColorGradeControls from "./ColorGradeControls";

export type ClipEffectsPatch = Partial<Pick<Clip, "colorFilter" | "grade" | "stabilize" | "kenBurns" | "transitionIn" | "flipHorizontal" | "muted" | "fx">>;

export const DEFAULT_STABILIZE_STRENGTH = 0.5;

export const DEFAULT_COLOR_INTENSITY = 0.7;
export const DEFAULT_LOOK_INTENSITY = 0.85;
export const DEFAULT_KEN_BURNS_INTENSITY = 0.5;
export const DEFAULT_TRANSITION_DURATION = 0.5;

interface ClipEffectsPopoverProps {
  clip: Clip;
  hasPrecedingClip: boolean;
  // The clip before this one, whose last frame the transition tiles play out of.
  previousClip?: Clip;
  // Whether this clip is the one in the preview right now (the grade's histogram reads the screen).
  isOnScreen: boolean;
  anchor: { left: number; top: number };
  // How many clips the edits land on (a Ctrl/Shift-click multi-selection) - the controls show this
  // `clip`'s values, and every change is applied to all of them.
  selectedCount?: number;
  onUpdate: (patch: ClipEffectsPatch) => void;
  // Puts a built-in sound (TRANSITION_SOUNDS) on the timeline at this clip's cut.
  onAddTransitionSound?: (soundId: string) => void;
  onClose: () => void;
}

type EffectsTab = "look" | "motion" | "fx" | "sound" | "transition";
const TABS: { value: EffectsTab; label: string; title: string }[] = [
  { value: "look", label: "Look", title: "Looks, colour presets and grading" },
  { value: "motion", label: "Motion", title: "Camera moves and stabilizing" },
  { value: "fx", label: "Effects", title: "Echo, RGB split, colour cycle, focus in..." },
  { value: "sound", label: "Sound", title: "This clip's own sound" },
  { value: "transition", label: "Transition", title: "How this clip comes in from the one before" },
];
const TAB_STORAGE_KEY = "briefcast.clipEffects.tab";

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

const ClipEffectsPopover: React.FC<ClipEffectsPopoverProps> = ({ clip, hasPrecedingClip, previousClip, isOnScreen, anchor, selectedCount, onUpdate, onAddTransitionSound, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);
  // Docked into the sidebar's Tools tab when it's there - see ToolPanelHost.tsx.
  const dockHost = useToolPanelHost();

  // A click elsewhere closes it - unless that click opened the sidebar, which docks it instead,
  // gliding into place. Docked, it stays open until its X / toolbar button closes it.
  useFloatingDismiss("[data-clip-effects-popover]", onClose, !!dockHost);
  useDockSnap(popoverRef, !!dockHost);

  const colorPreset = clip.colorFilter?.preset ?? "none";
  const colorIntensity = clip.colorFilter?.intensity ?? DEFAULT_COLOR_INTENSITY;
  const setColorPreset = (preset: ColorFilterPreset) => {
    if (preset === "none") {
      onUpdate({ colorFilter: undefined });
    } else {
      onUpdate({ colorFilter: { preset, intensity: colorIntensity } });
    }
  };

  // A built-in look rides on the grade (it's baked into the same LUT).
  const lookName = clip.grade?.look?.name ?? null;
  const lookIntensity = clip.grade?.look?.intensity ?? DEFAULT_LOOK_INTENSITY;
  const setLook = (name: GradeLookName | null, intensity = lookIntensity) => {
    const next: ClipGrade = { ...(clip.grade ?? {}), look: name ? { name, intensity } : undefined };
    if (!name) delete next.look;
    onUpdate({ grade: !!next.lut || hasGrade(next) ? next : undefined });
  };

  const kenBurnsPreset = clip.kenBurns?.preset ?? null;
  const kenBurnsIntensity = clip.kenBurns?.intensity ?? DEFAULT_KEN_BURNS_INTENSITY;
  const setKenBurnsPreset = (preset: KenBurnsPreset | null) => {
    // A new move for this clip - keeps an auto-zoom's target, starts the move from its beginning.
    onUpdate({ kenBurns: preset ? { preset, intensity: kenBurnsIntensity, targetX: clip.kenBurns?.targetX, targetY: clip.kenBurns?.targetY } : undefined });
  };

  const [tab, setTab] = useState<EffectsTab>(() => {
    try {
      const saved = localStorage.getItem(TAB_STORAGE_KEY);
      if (TABS.some((t) => t.value === saved)) return saved as EffectsTab;
    } catch {
      // storage unavailable - the default tab is fine
    }
    return "look";
  });
  const chooseTab = (next: EffectsTab) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      // not remembered this time
    }
  };
  // Which tabs hold something switched on for this clip.
  const active: Record<EffectsTab, boolean> = {
    look: (clip.colorFilter?.preset ?? "none") !== "none" || hasGrade(clip.grade),
    motion: !!clip.kenBurns || !!clip.stabilize,
    fx: !!clip.fx,
    sound: !!clip.muted,
    transition: !!clip.transitionIn && hasPrecedingClip,
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
        <span className="text-xs font-medium flex items-center gap-1.5">
          Clip effects
          <SelectionCountBadge count={selectedCount} />
        </span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      <div role="tablist" className="grid grid-cols-5 gap-0.5 p-0.5 rounded-md bg-white/[0.05]">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            title={t.title}
            onClick={() => chooseTab(t.value)}
            className={`relative h-7 rounded text-[11px] font-medium transition-colors ${tab === t.value ? "bg-white/[0.12] text-white" : "text-white/55 hover:text-white hover:bg-white/[0.06]"}`}
          >
            {t.label}
            {active[t.value] && <span className="absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full bg-blue-400" title="In use on this clip" />}
          </button>
        ))}
      </div>

      {tab === "look" && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-white/40">Looks</span>
            <LookGrid clip={clip} value={lookName} intensity={lookIntensity} onChange={(name) => setLook(name)} />
            {lookName && (
              <label className="flex items-center gap-2 text-[11px] pt-0.5">
                <span className="w-12 shrink-0 text-white/60">Amount</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={lookIntensity}
                  onChange={(e) => setLook(lookName, Number(e.target.value))}
                  className="flex-1 accent-blue-400"
                />
                <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(lookIntensity * 100)}%</span>
              </label>
            )}
          </div>
          <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
            <span className="text-[10px] uppercase tracking-wide text-white/40">Color</span>
            <ColorGrid clip={clip} value={colorPreset} intensity={colorIntensity} onChange={setColorPreset} />
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
        </>
      )}

      {tab === "motion" && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-white/40">Camera motion</span>
            <MotionGrid clip={clip} value={kenBurnsPreset} intensity={kenBurnsIntensity} onChange={setKenBurnsPreset} />
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
        </>
      )}

      {tab === "fx" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Clip effect</span>
          <FxGrid
            clip={clip}
            value={clip.fx?.kind ?? null}
            intensity={clip.fx?.intensity ?? DEFAULT_CLIP_FX_INTENSITY}
            onChange={(kind: ClipFxKind | null) => onUpdate({ fx: kind ? { kind, intensity: clip.fx?.intensity ?? DEFAULT_CLIP_FX_INTENSITY } : undefined })}
          />
          {clip.fx && (
            <label className="flex items-center gap-2 text-[11px] pt-0.5">
              <span className="w-12 shrink-0 text-white/60">Amount</span>
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.01}
                value={clip.fx.intensity}
                onChange={(e) => onUpdate({ fx: { kind: clip.fx!.kind, intensity: Number(e.target.value) } })}
                className="flex-1 accent-blue-400"
              />
              <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(clip.fx.intensity * 100)}%</span>
            </label>
          )}
        </div>
      )}

      {tab === "sound" && (
        <div className="flex items-center justify-between gap-2 text-[11px]">
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
      )}

      {tab === "transition" &&
        (hasPrecedingClip ? (
          <div className="flex flex-col gap-1.5" title="Plays over the start of this clip, as the previous clip keeps playing out - in the preview and the export alike">
            <span className="text-[10px] uppercase tracking-wide text-white/40">Transition (with previous clip)</span>
            <TransitionGrid value={transitionType} look={transitionLook} outgoing={previousClip} incoming={clip} onChange={setTransitionType} />
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
            {onAddTransitionSound && (
              <div className="flex items-start gap-2 text-[11px] pt-1">
                <span className="w-12 shrink-0 pt-1 text-white/60">Sound</span>
                <div className="flex-1 min-w-0 flex flex-wrap gap-1">
                  {TRANSITION_SOUNDS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      title={`Add a ${s.label.toLowerCase()} timed to this cut (as its own audio track)`}
                      onClick={() => onAddTransitionSound(s.id)}
                      className="h-6 px-1.5 rounded text-[11px] bg-white/[0.06] text-white/70 hover:text-white hover:bg-white/10"
                    >
                      ＋ {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-[11px] leading-snug text-white/50">This is the first clip - there's nothing before it to transition from. Select a later clip to set how it comes in.</p>
        ))}
    </div>,
    dockHost ?? document.body
  );
};

export default ClipEffectsPopover;
