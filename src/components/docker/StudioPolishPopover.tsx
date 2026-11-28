// components/docker/StudioPolishPopover.tsx
//
// 1-Click Studio Polish: bundles Briefcast's separate polish tools — Screen Style frame,
// Make it Sound Pro (RNNoise + Clear Voice EQ + Podcast compressor + limiter + -14 LUFS),
// Trim Silence, Click-tracked Auto-Zoom, and Editable Pointer/Shortcuts — into a single
// toggleable pass with live progress ticks and a direct "Turn into Briefcast Doc" next step.
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  IoCheckmarkCircle,
  IoClose,
  IoDocumentTextOutline,
  IoEllipseOutline,
  IoImageOutline,
  IoSparkles,
  IoTrashOutline,
  IoWarningOutline,
} from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, useDockSnap, useFloatingDismiss, useToolPanelHost } from "./ToolPanelHost";
import ColorInput from "../common/ColorInput";
import type { SoundProPatch } from "../../hooks/useVideoEditStore";
import type { AutoZoomClick } from "../../handlers/videoEditHandlers";
import { planSoundPro, type SoundProInput } from "../../utils/soundPro";
import type { ScreenStyle } from "../../utils/screenStyle";
import type { PointerStyle } from "../../utils/pointerTrack";
import type { KeystrokeStyle } from "../../utils/keystrokes";
import { IMAGE_CLIP_EXTENSIONS, type Clip } from "../../utils/videoEditTypes";
import {
  buildStudioColorScreenStyle,
  buildStudioImageScreenStyle,
  buildStudioScreenStyle,
  defaultStudioPolishOptions,
  filterClicksForClip,
  filterSilentRangesForClip,
  STUDIO_POLISH_THEMES,
  totalRangeDuration,
  type StudioPolishOptions,
  type StudioPolishStepResult,
} from "../../utils/studioPolish";
import { trackEvent } from "../../utils/telemetry";

interface StudioPolishPopoverProps {
  anchor: { left: number; top: number };
  clips: Clip[];
  primarySourcePath: string;
  screenStyle: ScreenStyle | null;
  onScreenStyle: (style: ScreenStyle | null) => void;
  soundProInput: SoundProInput;
  applySoundPro: (patch: SoundProPatch) => void;
  onLoudnessChange: (lufs: number | null) => void;
  onTrimSilence: (clipId: string, ranges: { start: number; end: number }[]) => void;
  onApplyAutoZoom: (clipId: string, clicks: AutoZoomClick[]) => void;
  hasEditablePointer: boolean;
  shortcutCount: number;
  onPointerStyle: (patch: Partial<PointerStyle>) => void;
  onKeystrokeStyle: (patch: Partial<KeystrokeStyle>) => void;
  onOpenScreenStyle?: () => void;
  onTurnIntoDoc?: () => Promise<void> | void;
  onClose: () => void;
}

const StudioPolishPopover: React.FC<StudioPolishPopoverProps> = ({
  anchor,
  clips,
  primarySourcePath,
  screenStyle,
  onScreenStyle,
  soundProInput,
  applySoundPro,
  onLoudnessChange,
  onTrimSilence,
  onApplyAutoZoom,
  hasEditablePointer,
  shortcutCount,
  onPointerStyle,
  onKeystrokeStyle,
  onOpenScreenStyle,
  onTurnIntoDoc,
  onClose,
}) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  const dockHost = useToolPanelHost();
  const [hasClickSidecar, setHasClickSidecar] = useState(false);
  const [sidecarChecked, setSidecarChecked] = useState(false);
  const [rawClicks, setRawClicks] = useState<{ elapsedSecs: number; xFraction: number; yFraction: number }[]>([]);

  const existingThemeId = screenStyle?.background.kind === "gradient" ? screenStyle.background.preset : null;
  const activeImagePath = screenStyle?.background.kind === "image" ? screenStyle.background.path : null;
  const activeColor = screenStyle?.background.kind === "color" ? screenStyle.background.color : null;
  const soundPlan = useMemo(() => planSoundPro(soundProInput, "youtube"), [soundProInput]);
  const hasSound = soundPlan.sources.length > 0;

  const [options, setOptions] = useState<StudioPolishOptions>(() =>
    defaultStudioPolishOptions({
      hasExistingFrame: !!screenStyle,
      existingThemeId,
      hasSound,
      hasClickSidecar: false,
      hasEditablePointer,
      shortcutCount,
    })
  );
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<StudioPolishStepResult[] | null>(null);
  const [creatingDoc, setCreatingDoc] = useState(false);

  // Docks smoothly into the left sidebar's Tools tab when open; otherwise floats with outside-click dismiss.
  useFloatingDismiss("[data-studio-polish-popover], [data-studio-polish-button]", () => !running && onClose(), !!dockHost);
  useDockSnap(ref, !!dockHost);

  // Probe click sidecar once so Auto-Zoom is pre-checked when click data exists.
  useEffect(() => {
    let live = true;
    invoke<string | null>("load_click_sidecar", { videoPath: primarySourcePath })
      .then((json) => {
        if (!live) return;
        if (json) {
          const parsed = JSON.parse(json) as { elapsedSecs: number; xFraction: number; yFraction: number }[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            setRawClicks(parsed);
            setHasClickSidecar(true);
            setOptions((prev) => ({ ...prev, autoZoom: true }));
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (live) setSidecarChecked(true);
      });
    return () => {
      live = false;
    };
  }, [primarySourcePath]);

  const pickBackdropImage = async () => {
    if (running) return;
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: IMAGE_CLIP_EXTENSIONS.filter((e) => !["heic", "heif"].includes(e)) }],
    });
    if (typeof selected === "string") {
      setOptions((o) => ({ ...o, frame: true }));
      onScreenStyle(buildStudioImageScreenStyle(selected, screenStyle));
    }
  };

  const removeBackdrop = () => {
    if (running) return;
    setOptions((o) => ({ ...o, frame: false }));
    onScreenStyle(null);
  };

  const anySelected =
    options.frame || options.soundPro || options.trimSilence || (options.autoZoom && hasClickSidecar) || (options.pointerAndKeys && (hasEditablePointer || shortcutCount > 0));

  const runPolish = async () => {
    if (running || !anySelected) return;
    setRunning(true);
    const stepResults: StudioPolishStepResult[] = [];
    const primaryClip = clips[0] ?? null;

    // 1. Framed Screen Style (may already be live-applied from swatch/color/image/toggle interaction)
    if (options.frame) {
      const imgBg = screenStyle?.background.kind === "image" ? screenStyle.background : null;
      const colorBg = screenStyle?.background.kind === "color" ? screenStyle.background : null;
      const alreadyAppliedGradient =
        screenStyle?.background.kind === "gradient" && screenStyle.background.preset === options.themeId;
      if (!imgBg && !colorBg && !alreadyAppliedGradient) {
        onScreenStyle(buildStudioScreenStyle(options.themeId, screenStyle));
      }
      const themeName = imgBg
        ? imgBg.path.split(/[\\/]/).pop() ?? "Custom image"
        : colorBg
          ? colorBg.color.toUpperCase()
          : STUDIO_POLISH_THEMES.find((t) => t.id === options.themeId)?.label ?? options.themeId;
      stepResults.push({
        key: "frame",
        label: "Framed screen style",
        detail: `${themeName} backdrop, rounded corners & soft shadow`,
        status: "done",
      });
    }

    // 2. Pro Voice Audio (Sound Pro)
    if (options.soundPro && hasSound) {
      const freshPlan = planSoundPro(soundProInput, "youtube");
      if (freshPlan.changesEdit) {
        applySoundPro({
          clips: freshPlan.clips,
          audioOverlays: freshPlan.audioOverlays,
          master: freshPlan.master,
          videoAudioFx: freshPlan.videoAudioFx,
        });
      }
      onLoudnessChange(freshPlan.loudnessLufs);
      stepResults.push({
        key: "sound",
        label: "Pro voice audio",
        detail: freshPlan.changesEdit ? "RNNoise voice cleanup, EQ, compressor & -14 LUFS" : "Audio already polished (-14 LUFS)",
        status: "done",
      });
    }

    // 3. Editable Cursor & Shortcut Chips
    if (options.pointerAndKeys && (hasEditablePointer || shortcutCount > 0)) {
      if (hasEditablePointer) onPointerStyle({ show: true, ripples: true });
      if (shortcutCount > 0) onKeystrokeStyle({ show: true });
      stepResults.push({
        key: "pointer",
        label: "Cursor & shortcut chips",
        detail: [hasEditablePointer ? "click ripples" : null, shortcutCount > 0 ? `${shortcutCount} shortcuts` : null].filter(Boolean).join(" + "),
        status: "done",
      });
    }

    // 4. Auto-Zoom on Clicks (before silence removal shifts clip boundaries)
    if (options.autoZoom && hasClickSidecar && primaryClip) {
      const clicks = filterClicksForClip(primaryClip, rawClicks);
      if (clicks.length > 0) {
        onApplyAutoZoom(primaryClip.id, clicks);
        stepResults.push({
          key: "zoom",
          label: "Auto-zoom on clicks",
          detail: `Zoomed in on ${clicks.length} recorded ${clicks.length === 1 ? "click" : "clicks"}`,
          status: "done",
        });
      } else {
        stepResults.push({
          key: "zoom",
          label: "Auto-zoom on clicks",
          detail: "No clicks fell inside the current clip trim",
          status: "skipped",
        });
      }
    }

    // 5. Trim Dead Air (Silence Detection)
    if (options.trimSilence && primaryClip) {
      try {
        const allRanges = await invoke<{ start: number; end: number }[]>("detect_silence", {
          inputPath: primaryClip.sourcePath,
        });
        const withinClip = filterSilentRangesForClip(primaryClip, allRanges);
        if (withinClip.length > 0) {
          onTrimSilence(primaryClip.id, withinClip);
          stepResults.push({
            key: "silence",
            label: "Trimmed dead air",
            detail: `Removed ${withinClip.length} silent ${withinClip.length === 1 ? "gap" : "gaps"} (${totalRangeDuration(withinClip).toFixed(1)}s)`,
            status: "done",
          });
        } else {
          stepResults.push({
            key: "silence",
            label: "Trim dead air",
            detail: "No long silent gaps detected",
            status: "skipped",
          });
        }
      } catch (err) {
        stepResults.push({
          key: "silence",
          label: "Trim dead air",
          detail: err instanceof Error ? err.message : String(err),
          status: "error",
        });
      }
    }

    trackEvent("studio_polish_applied", {
      frame: options.frame,
      sound: options.soundPro,
      silence: options.trimSilence,
      zoom: options.autoZoom && hasClickSidecar,
    });
    setResults(stepResults);
    setRunning(false);
  };

  const handleCreateDoc = async () => {
    if (!onTurnIntoDoc || creatingDoc) return;
    setCreatingDoc(true);
    try {
      await onTurnIntoDoc();
      onClose();
    } finally {
      setCreatingDoc(false);
    }
  };

  const activeBackdropLabel = activeImagePath
    ? activeImagePath.split(/[\\/]/).pop() ?? "Image"
    : activeColor
      ? activeColor.toUpperCase()
      : STUDIO_POLISH_THEMES.find((t) => t.id === options.themeId)?.label ?? options.themeId;

  return createPortal(
    <div
      ref={ref}
      data-studio-polish-popover
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={
        dockHost
          ? `${DOCKED_PANEL_CLASS} p-3.5 gap-3`
          : "w-80 max-h-[calc(100vh-16px)] overflow-y-auto overscroll-contain p-3.5 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
      }
    >
      <div className="flex items-center gap-2">
        <span className="h-6 w-6 rounded-md bg-amber-400/15 text-amber-300 flex items-center justify-center shrink-0">
          <IoSparkles size={13} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-white">Studio Polish</div>
          <div className="text-[10px] text-white/45">Frame, pro audio, silence trim & zooms in one click</div>
        </div>
        <button
          type="button"
          title="Close"
          disabled={running}
          onClick={onClose}
          className="shrink-0 p-1 rounded hover:bg-white/10 text-white/60 hover:text-white disabled:opacity-40"
        >
          <IoClose size={14} />
        </button>
      </div>

      {!results ? (
        <>
          <div className="flex flex-col gap-2">
            {/* 1. Screen Style Frame (updates live on toggle / swatch click / image pick) */}
            <div className="rounded-lg bg-white/[0.04] p-2.5 flex flex-col gap-2 min-w-0">
              <label className="flex items-start gap-2 text-[11px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.frame}
                  disabled={running}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setOptions((o) => ({ ...o, frame: checked }));
                    onScreenStyle(checked ? buildStudioScreenStyle(options.themeId, screenStyle) : null);
                  }}
                  className="mt-0.5 accent-amber-400"
                />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium text-white/90">Framed screen backdrop</span>
                    {options.frame && (
                      <span className="text-[10px] text-amber-300/80 truncate max-w-[100px]" title={activeBackdropLabel}>
                        {activeBackdropLabel}
                      </span>
                    )}
                  </span>
                  <span className="block text-[10px] text-white/50">Rounded corners, soft drop shadow &amp; wallpaper</span>
                </span>
              </label>

              {options.frame && (
                <div className="flex flex-col gap-2 pl-5 min-w-0">
                  {/* Horizontally scrollable studio gradient swatch strip (generous top/side padding so ring-2 never clips) */}
                  <div className="flex items-center gap-2 overflow-x-auto pt-1.5 pb-1.5 px-1.5 -mx-1 [scrollbar-width:thin]">
                    {STUDIO_POLISH_THEMES.map((t) => {
                      const active = !activeImagePath && !activeColor && options.themeId === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          disabled={running}
                          title={t.label}
                          onClick={() => {
                            setOptions((o) => ({ ...o, frame: true, themeId: t.id }));
                            onScreenStyle(buildStudioScreenStyle(t.id, screenStyle));
                          }}
                          className="shrink-0 flex flex-col items-center gap-1 group"
                        >
                          <span
                            style={{ background: t.swatch }}
                            className={`block h-6 w-10 rounded-md transition-all ${
                              active
                                ? "ring-2 ring-amber-300 ring-offset-1 ring-offset-neutral-900"
                                : "ring-1 ring-white/20 opacity-80 group-hover:opacity-100"
                            }`}
                          />
                          <span className={`text-[9.5px] leading-tight ${active ? "text-amber-200 font-medium" : "text-white/45 group-hover:text-white/75"}`}>
                            {t.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Image backdrop preview */}
                  {activeImagePath && (
                    <div className="flex items-center gap-2 rounded-md bg-white/[0.05] px-2 py-1">
                      <img
                        src={convertFileSrc(activeImagePath)}
                        alt=""
                        className="h-6 w-9 rounded object-cover ring-1 ring-white/15 shrink-0"
                      />
                      <span className="flex-1 min-w-0 truncate text-[10.5px] text-white/75" title={activeImagePath}>
                        {activeImagePath.split(/[\\/]/).pop()}
                      </span>
                    </div>
                  )}

                  {/* Custom color picker + Image picker + Remove backdrop actions */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <label
                      title="Pick any solid color backdrop"
                      className={`relative flex items-center gap-1.5 px-2 py-1 rounded-md text-[10.5px] font-medium cursor-pointer transition-colors ${
                        activeColor
                          ? "bg-amber-500/20 text-amber-200 ring-1 ring-amber-300/50"
                          : "bg-white/[0.07] hover:bg-white/[0.13] text-white/85"
                      } ${running ? "opacity-40 pointer-events-none" : ""}`}
                    >
                      <span
                        className="w-3.5 h-3.5 rounded-full ring-1 ring-white/30 shrink-0"
                        style={{
                          background: activeColor ?? "conic-gradient(#ef4444,#f59e0b,#10b981,#06b6d4,#6366f1,#ec4899,#ef4444)",
                        }}
                      />
                      <span>{activeColor ? activeColor.toUpperCase() : "Color"}</span>
                      <ColorInput
                        value={activeColor ?? "#0f172a"}
                        onChange={(e) => {
                          setOptions((o) => ({ ...o, frame: true }));
                          onScreenStyle(buildStudioColorScreenStyle(e.target.value, screenStyle));
                        }}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={running}
                      onClick={() => void pickBackdropImage()}
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/[0.07] hover:bg-white/[0.13] text-[10.5px] font-medium text-white/85 disabled:opacity-40 transition-colors"
                    >
                      <IoImageOutline size={12} />
                      {activeImagePath ? "Change image…" : "Image…"}
                    </button>
                    {screenStyle && onOpenScreenStyle && (
                      <button
                        type="button"
                        disabled={running}
                        title="Adjust padding, corner radius & shadow strength"
                        onClick={onOpenScreenStyle}
                        className="px-2 py-1 rounded-md text-[10.5px] text-amber-200/85 hover:text-amber-200 hover:bg-amber-500/10 disabled:opacity-40 transition-colors"
                      >
                        Fine-tune…
                      </button>
                    )}
                    {screenStyle && (
                      <button
                        type="button"
                        disabled={running}
                        onClick={removeBackdrop}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] text-white/55 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                      >
                        <IoTrashOutline size={11} />
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 2. Pro Voice Audio */}
            <label className={`flex items-start gap-2 rounded-lg bg-white/[0.04] p-2.5 text-[11px] ${hasSound ? "cursor-pointer" : "opacity-45"}`}>
              <input
                type="checkbox"
                checked={options.soundPro && hasSound}
                disabled={running || !hasSound}
                onChange={(e) => setOptions((o) => ({ ...o, soundPro: e.target.checked }))}
                className="mt-0.5 accent-amber-400"
              />
              <span className="flex-1">
                <span className="font-medium text-white/90">Pro voice audio</span>
                <span className="block text-[10px] text-white/50">
                  {hasSound ? "RNNoise voice isolation, Clear Voice EQ, limiter & -14 LUFS" : "No audio track detected"}
                </span>
              </span>
            </label>

            {/* 3. Trim Dead Air */}
            <label className={`flex items-start gap-2 rounded-lg bg-white/[0.04] p-2.5 text-[11px] ${hasSound ? "cursor-pointer" : "opacity-45"}`}>
              <input
                type="checkbox"
                checked={options.trimSilence && hasSound}
                disabled={running || !hasSound}
                onChange={(e) => setOptions((o) => ({ ...o, trimSilence: e.target.checked }))}
                className="mt-0.5 accent-amber-400"
              />
              <span className="flex-1">
                <span className="font-medium text-white/90">Trim dead air</span>
                <span className="block text-[10px] text-white/50">Automatically detect & cut silent pauses</span>
              </span>
            </label>

            {/* 4. Auto-Zoom on Clicks */}
            <label className={`flex items-start gap-2 rounded-lg bg-white/[0.04] p-2.5 text-[11px] ${hasClickSidecar ? "cursor-pointer" : "opacity-50"}`}>
              <input
                type="checkbox"
                checked={options.autoZoom && hasClickSidecar}
                disabled={running || !hasClickSidecar}
                onChange={(e) => setOptions((o) => ({ ...o, autoZoom: e.target.checked }))}
                className="mt-0.5 accent-amber-400"
              />
              <span className="flex-1">
                <span className="font-medium text-white/90">Auto-zoom on clicks</span>
                <span className="block text-[10px] text-white/50">
                  {!sidecarChecked
                    ? "Checking for recorded click data…"
                    : hasClickSidecar
                      ? `${rawClicks.length} recorded clicks ready for smooth zoom-ins`
                      : "No click data (enable Track Clicks before recording)"}
                </span>
              </span>
            </label>

            {/* 5. Cursor & Shortcut Chips (only shown when recording captured them) */}
            {(hasEditablePointer || shortcutCount > 0) && (
              <label className="flex items-start gap-2 rounded-lg bg-white/[0.04] p-2.5 text-[11px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.pointerAndKeys}
                  disabled={running}
                  onChange={(e) => setOptions((o) => ({ ...o, pointerAndKeys: e.target.checked }))}
                  className="mt-0.5 accent-amber-400"
                />
                <span className="flex-1">
                  <span className="font-medium text-white/90">Cursor ripples & keystrokes</span>
                  <span className="block text-[10px] text-white/50">Highlight clicks and recorded keyboard shortcuts</span>
                </span>
              </label>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[10px] text-white/40">Every step is undoable (Ctrl+Z)</span>
            <button
              type="button"
              disabled={running || !anySelected}
              onClick={() => void runPolish()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-neutral-950 text-xs font-semibold disabled:opacity-40 transition-colors"
            >
              <IoSparkles size={13} />
              {running ? "Polishing…" : "Polish video"}
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {results.map((r) => (
              <li key={r.key} className="flex items-start gap-2 text-[11px]">
                {r.status === "done" ? (
                  <IoCheckmarkCircle size={15} className="shrink-0 text-emerald-400 mt-0.5" />
                ) : r.status === "error" ? (
                  <IoWarningOutline size={15} className="shrink-0 text-amber-400 mt-0.5" />
                ) : (
                  <IoEllipseOutline size={14} className="shrink-0 text-white/30 mt-0.5" />
                )}
                <div className="min-w-0">
                  <div className="font-medium text-white/90">{r.label}</div>
                  <div className="text-[10px] text-white/50">{r.detail}</div>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/10">
            {onTurnIntoDoc ? (
              <button
                type="button"
                disabled={creatingDoc}
                onClick={() => void handleCreateDoc()}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white text-[11px] font-medium disabled:opacity-40 transition-colors"
              >
                <IoDocumentTextOutline size={13} />
                {creatingDoc ? "Creating doc…" : "Turn into Doc"}
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>,
    dockHost ?? document.body
  );
};

export default StudioPolishPopover;
