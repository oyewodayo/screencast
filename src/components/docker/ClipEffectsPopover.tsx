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
import { builtinSfxFile } from "../../utils/builtinSfx";
import { convertFileSrc } from "@tauri-apps/api/core";
import { CUT_SOUND_CHOICES, autoCutSound, cutSoundLabel, type CutSounds } from "../../utils/cutSounds";
import { hasGrade } from "../../utils/colorGrade";
import TransitionLookControls, { transitionHasLook } from "./TransitionLookControls";
import { createPortal } from "react-dom";
import { IoClose, IoVolumeHighOutline } from "react-icons/io5";
import { Clip, ClipFxKind, ClipGrade, ClipTransitionIn, ColorFilterPreset, EdgeTransitions, GradeLookName, KenBurnsPreset, TransitionEdge, isImageClipPath } from "../../utils/videoEditTypes";
import TransitionGrid, { BLACK } from "./TransitionGrid";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, SelectionCountBadge, useToolPanelHost, useDockSnap, useFloatingDismiss } from "./ToolPanelHost";
import ColorGradeControls from "./ColorGradeControls";

export type ClipEffectsPatch = Partial<Pick<Clip, "colorFilter" | "grade" | "stabilize" | "kenBurns" | "transitionIn" | "cutSound" | "flipHorizontal" | "muted" | "fx">>;

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
  // Sound on every cut (cutSounds.ts): the video's setting (null = off) and its switch / changes.
  cutSounds?: CutSounds | null;
  onSetCutSounds?: (patch: Partial<CutSounds> | null) => void;
  // The intro's / outro's own cut sound (undefined = automatic, null = none).
  onSetEdgeSound?: (edge: TransitionEdge, sound: string | null | undefined) => void;
  // How many cuts have a sound now (the switch's summary).
  cutCount?: number;
  // Where this clip sits: first and/or last on the timeline - the edges the video's intro / outro
  // play at (EdgeTransitions), offered on the Transition tab for a single selected clip there.
  atEdges?: { first: boolean; last: boolean };
  edgeTransitions?: EdgeTransitions;
  onSetEdgeTransition?: (edge: TransitionEdge, transition: ClipTransitionIn | null) => void;
  onClose: () => void;
}

// Plays a cut sound once, as it's picked - so choosing one is by ear.
let soundPreview: HTMLAudioElement | null = null;
function previewCutSound(id: string): void {
  builtinSfxFile(id)
    .then((path) => {
      soundPreview?.pause();
      soundPreview = new Audio(convertFileSrc(path));
      soundPreview.volume = 0.8;
      return soundPreview.play();
    })
    .catch(() => {
      // just not heard this time
    });
}

// The whole video's switch: a matching sound at every change of picture.
const CutSoundsCard: React.FC<{ settings: CutSounds | null; cuts: number; onChange: (patch: Partial<CutSounds> | null) => void }> = ({ settings, cuts, onChange }) => (
  <div className={`flex flex-col gap-2 p-2 rounded-md ring-1 ${settings ? "bg-amber-400/[0.07] ring-amber-300/30" : "bg-white/[0.04] ring-white/10"}`}>
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <IoVolumeHighOutline size={15} className={`shrink-0 ${settings ? "text-amber-300" : "text-white/50"}`} />
      <span className="flex-1 min-w-0">
        <span className="block text-[12px] font-medium text-white/90">Sound on every cut</span>
        <span className="block text-[10px] leading-snug text-white/45">
          {settings ? `${cuts} cut${cuts === 1 ? "" : "s"} - each sound matches its transition and moves with it` : "A matching whoosh, swoosh or flash wherever the picture changes - for the whole video"}
        </span>
      </span>
      <input type="checkbox" role="switch" checked={!!settings} onChange={(e) => onChange(e.target.checked ? {} : null)} className="sr-only" />
      <span className={`relative w-8 h-[18px] shrink-0 rounded-full transition-colors ${settings ? "bg-amber-400" : "bg-white/20"}`}>
        <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-[left] duration-150 ${settings ? "left-[16px]" : "left-[2px]"}`} />
      </span>
    </label>
    {settings && (
      <>
        <label className="flex items-center gap-2 text-[11px] text-white/70 cursor-pointer select-none" title="Cuts with no transition get a sound too">
          <input type="checkbox" checked={settings.plainCuts} onChange={(e) => onChange({ plainCuts: e.target.checked })} className="accent-amber-400" />
          Plain cuts too
        </label>
        <label className="flex items-center gap-2 text-[11px]">
          <span className="w-12 shrink-0 text-white/60">Volume</span>
          <input type="range" min={0} max={1} step={0.01} value={settings.volume} onChange={(e) => onChange({ volume: Number(e.target.value) })} className="flex-1 accent-amber-400" />
          <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(settings.volume * 100)}%</span>
        </label>
      </>
    )}
  </div>
);

// One cut's sound: the automatic one (named), any of the cut sounds, or none.
const CutSoundRow: React.FC<{ value: string | null | undefined; auto: string | null; onChange: (sound: string | null | undefined) => void }> = ({ value, auto, onChange }) => {
  const chip = (key: string, label: string, active: boolean, pick: () => void, title?: string) => (
    <button
      key={key}
      type="button"
      title={title}
      onClick={pick}
      className={`h-6 px-1.5 rounded text-[11px] transition-colors ${active ? "text-amber-200 bg-amber-400/15 ring-1 ring-amber-300/50" : "text-white/70 bg-white/[0.06] hover:text-white hover:bg-white/10"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-start gap-2 text-[11px] pt-1">
      <span className="w-12 shrink-0 pt-1 text-white/60">Sound</span>
      <div className="flex-1 min-w-0 flex flex-wrap gap-1">
        {chip(
          "auto",
          auto ? `Auto - ${cutSoundLabel(auto)}` : "Auto - none",
          value === undefined,
          () => {
            onChange(undefined);
            if (auto) previewCutSound(auto);
          },
          "The sound that matches this transition"
        )}
        {CUT_SOUND_CHOICES.map((c) =>
          chip(c.id, c.label, value === c.id, () => {
            onChange(c.id);
            previewCutSound(c.id);
          })
        )}
        {chip("none", "None", value === null, () => onChange(null), "No sound on this cut")}
      </div>
    </div>
  );
};

// An intro / outro can run longer than a cut between clips - a slow fade in, a long sweep.
export const EDGE_TRANSITION_MAX_SECONDS = 3;
export const DEFAULT_EDGE_TRANSITION_DURATION = 1;

// One transition's picker: live tiles, then its duration and look once one is chosen. `children`:
// extra rows under it (the cut's sounds).
const TransitionPicker: React.FC<{
  heading: string;
  hint: string;
  value: ClipTransitionIn | undefined;
  outgoing: Clip | typeof BLACK | undefined;
  incoming: Clip | typeof BLACK;
  maxDuration: number;
  defaultDuration?: number;
  onChange: (transition: ClipTransitionIn | undefined) => void;
  children?: React.ReactNode;
}> = ({ heading, hint, value, outgoing, incoming, maxDuration, defaultDuration = DEFAULT_TRANSITION_DURATION, onChange, children }) => {
  const type = value?.type ?? null;
  const duration = value?.duration ?? defaultDuration;
  const look = value?.look;
  return (
    <div className="flex flex-col gap-1.5" title={hint}>
      <span className="text-[10px] uppercase tracking-wide text-white/40">{heading}</span>
      {/* The look carries over between transitions that understand it (a leak's colour to a flash...). */}
      <TransitionGrid value={type} look={look} outgoing={outgoing} incoming={incoming} onChange={(t) => onChange(t ? { type: t, duration, ...(look ? { look } : {}) } : undefined)} />
      {type !== null && (
        <label className="flex items-center gap-2 text-[11px] pt-0.5">
          <span className="w-12 shrink-0 text-white/60">Duration</span>
          <input
            type="range"
            min={0.2}
            max={maxDuration}
            step={0.05}
            value={Math.min(duration, maxDuration)}
            onChange={(e) => onChange({ ...value, type, duration: Number(e.target.value) })}
            className="flex-1 accent-blue-400"
          />
          <span className="w-10 shrink-0 text-right tabular-nums text-white/60">{duration.toFixed(2)}s</span>
        </label>
      )}
      {type !== null && transitionHasLook(type) && <TransitionLookControls type={type} look={look} onChange={(next) => onChange({ type, duration, look: next })} />}
      {children}
    </div>
  );
};

type EffectsTab = "look" | "motion" | "fx" | "sound" | "transition";
const TABS: { value: EffectsTab; label: string; title: string }[] = [
  { value: "look", label: "Look", title: "Looks, colour presets and grading" },
  { value: "motion", label: "Motion", title: "Camera moves and stabilizing" },
  { value: "fx", label: "Effects", title: "Echo, RGB split, colour cycle, focus in..." },
  { value: "sound", label: "Sound", title: "This clip's own sound" },
  { value: "transition", label: "Transition", title: "How this clip comes in from the one before" },
];
const TAB_STORAGE_KEY = "briefcast.clipEffects.tab";

// Opens the popover on its Transition tab next time it mounts (a timeline intro/outro marker).
export function rememberTransitionTab(): void {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, "transition");
  } catch {
    // storage unavailable - it opens on its default tab
  }
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

const ClipEffectsPopover: React.FC<ClipEffectsPopoverProps> = ({
  clip,
  hasPrecedingClip,
  previousClip,
  isOnScreen,
  anchor,
  selectedCount,
  onUpdate,
  cutSounds,
  onSetCutSounds,
  onSetEdgeSound,
  cutCount,
  atEdges,
  edgeTransitions,
  onSetEdgeTransition,
  onClose,
}) => {
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
  // The video's intro / outro, on the clip at that edge - one clip at a time (a multi-selection's
  // edits land on every clip, and the intro isn't any one clip's).
  const single = (selectedCount ?? 1) <= 1 && !!onSetEdgeTransition;
  const showIntro = single && !!atEdges?.first;
  const showOutro = single && !!atEdges?.last;
  // Which tabs hold something switched on for this clip.
  const active: Record<EffectsTab, boolean> = {
    look: (clip.colorFilter?.preset ?? "none") !== "none" || hasGrade(clip.grade),
    motion: !!clip.kenBurns || !!clip.stabilize,
    fx: !!clip.fx,
    sound: !!clip.muted,
    transition: (!!clip.transitionIn && hasPrecedingClip) || (showIntro && !!edgeTransitions?.intro) || (showOutro && !!edgeTransitions?.outro),
  };

  return createPortal(
    <div
      ref={popoverRef}
      data-clip-effects-popover
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={dockHost ? `${DOCKED_PANEL_CLASS} p-3 gap-3` : "w-72 max-h-[calc(100vh-24px)] overflow-y-auto overscroll-contain p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-3"}
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

      {tab === "transition" && (
        <div className="flex flex-col gap-3">
          {onSetCutSounds && <CutSoundsCard settings={cutSounds ?? null} cuts={cutCount ?? 0} onChange={onSetCutSounds} />}
          {hasPrecedingClip && (
            <TransitionPicker
              heading="Transition (with previous clip)"
              hint="Plays over the start of this clip, as the previous clip keeps playing out - in the preview and the export alike"
              value={clip.transitionIn}
              outgoing={previousClip}
              incoming={clip}
              maxDuration={1.5}
              onChange={(transitionIn) => onUpdate({ transitionIn })}
            >
              {cutSounds && (
                <CutSoundRow
                  value={clip.cutSound}
                  auto={clip.transitionIn ? autoCutSound(clip.transitionIn.type) : cutSounds.plainCuts ? autoCutSound(null) : null}
                  onChange={(cutSound) => onUpdate({ cutSound })}
                />
              )}
            </TransitionPicker>
          )}
          {showIntro && (
            <div className={hasPrecedingClip ? "pt-2 border-t border-white/10" : undefined}>
              <TransitionPicker
                heading="Intro (in from black)"
                hint="How the video starts: this clip comes in from black. It stays at the start of the video whichever clip is first."
                value={edgeTransitions?.intro}
                outgoing={BLACK}
                incoming={clip}
                maxDuration={EDGE_TRANSITION_MAX_SECONDS}
                defaultDuration={DEFAULT_EDGE_TRANSITION_DURATION}
                onChange={(t) => onSetEdgeTransition?.("intro", t ?? null)}
              >
                {cutSounds && edgeTransitions?.intro && (
                  <CutSoundRow value={edgeTransitions.sounds?.intro} auto={autoCutSound(edgeTransitions.intro.type)} onChange={(sound) => onSetEdgeSound?.("intro", sound)} />
                )}
              </TransitionPicker>
            </div>
          )}
          {showOutro && (
            <div className={showIntro || hasPrecedingClip ? "pt-2 border-t border-white/10" : undefined}>
              <TransitionPicker
                heading="Outro (out to black)"
                hint="How the video ends: this clip goes out to black. It stays at the end of the video whichever clip is last."
                value={edgeTransitions?.outro}
                outgoing={clip}
                incoming={BLACK}
                maxDuration={EDGE_TRANSITION_MAX_SECONDS}
                defaultDuration={DEFAULT_EDGE_TRANSITION_DURATION}
                onChange={(t) => onSetEdgeTransition?.("outro", t ?? null)}
              >
                {cutSounds && edgeTransitions?.outro && (
                  <CutSoundRow value={edgeTransitions.sounds?.outro} auto={autoCutSound(edgeTransitions.outro.type)} onChange={(sound) => onSetEdgeSound?.("outro", sound)} />
                )}
              </TransitionPicker>
            </div>
          )}
        </div>
      )}
    </div>,
    dockHost ?? document.body
  );
};

export default ClipEffectsPopover;
