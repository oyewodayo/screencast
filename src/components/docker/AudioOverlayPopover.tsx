// components/docker/AudioOverlayPopover.tsx
//
// The style/control surface for a selected audio overlay - volume, fade in/out, mute, duplicate,
// delete. Portal-rendered and positioned from the timeline chip's own getBoundingClientRect()
// (computed by the caller, VideoTimelineDocker, at click time), the same technique AnimationPicker
// in VideoOverlayLayer.tsx already uses for the identical "don't get clipped by a bounded/
// scrolling ancestor" problem. Unlike that file's own panels, plain native <input type="range">/
// <input type="number"> are safe here - nothing in this docker has a focus-stealing-sensitive
// textarea to protect (no TextNoteEditor involved), so none of VideoOverlayLayer's scrub/stepper
// workarounds are needed.
//
// The raw anchor alone isn't enough, though: the audio-overlay lane sits close to the bottom of
// the whole window, so a popover anchored just below its chip (rect.bottom + 6) routinely had
// nowhere near enough room to actually fit - it rendered starting near the very bottom edge, and
// everything past the title row (the volume slider, both fade fields, the whole mute/duplicate/
// delete row) was pushed past the window and effectively invisible/unreachable. See
// useClampedPopoverPosition for the fix - it measures the popover's real rendered size and nudges
// it back on-screen after layout.
import { invoke } from "@tauri-apps/api/core";
import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { IoClose } from "react-icons/io5";
import { AudioOverlay } from "../../utils/videoEditTypes";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, useToolPanelHost } from "./ToolPanelHost";

export type AudioOverlayContentPatch = Partial<Pick<AudioOverlay, "volume" | "fadeInSec" | "fadeOutSec" | "muted" | "bpm" | "beats">>;

interface AudioOverlayPopoverProps {
  overlay: AudioOverlay;
  anchor: { left: number; top: number };
  onUpdate: (patch: AudioOverlayContentPatch) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  // Beat sync - fit every image clip to this (and any other) track's beats.
  hasImageClips: boolean;
  onCutImagesOnBeat: (everyBeats: number) => void;
  onClose: () => void;
}

const AudioOverlayPopover: React.FC<AudioOverlayPopoverProps> = ({ overlay, anchor, onUpdate, onDuplicate, onDelete, hasImageClips, onCutImagesOnBeat, onClose }) => {
  const [beatState, setBeatState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const findBeats = () => {
    setBeatState({ busy: true });
    invoke<{ bpm: number; beats: number[] }>("detect_beats", { sourcePath: overlay.src })
      .then((r) => {
        onUpdate({ bpm: r.bpm, beats: r.beats });
        setBeatState({ busy: false });
      })
      .catch((err) => setBeatState({ busy: false, error: String(err) }));
  };
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);
  // Docked into the sidebar's Tools tab when it's there - see ToolPanelHost.tsx.
  const dockHost = useToolPanelHost();

  useEffect(() => {
    // A docked panel stays open until its X / toolbar button closes it.
    if (dockHost) return;
    const close = (e: PointerEvent) => {
      // Ignore the click that's still landing on the popover itself (or the chip that opened it -
      // that click already toggles selection on its own, this listener would otherwise immediately
      // re-close what it just opened).
      if (e.target instanceof Element && e.target.closest("[data-audio-overlay-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose, dockHost]);

  const fileName = overlay.src.split(/[\\/]/).pop() ?? overlay.src;

  return createPortal(
    <div
      ref={popoverRef}
      data-audio-overlay-popover
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={dockHost ? `${DOCKED_PANEL_CLASS} p-3 gap-2.5` : "w-64 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium truncate" title={fileName}>
          {fileName}
        </span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      <label className="flex items-center gap-2 text-[11px]">
        <span className="w-12 shrink-0 text-white/60">Volume</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={overlay.volume}
          onChange={(e) => onUpdate({ volume: Number(e.target.value) })}
          className="flex-1 accent-teal-400"
        />
        <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(overlay.volume * 100)}%</span>
      </label>

      <label className="flex items-center gap-2 text-[11px]">
        <span className="w-12 shrink-0 text-white/60">Fade in</span>
        <input
          type="number"
          min={0}
          max={10}
          step={0.1}
          value={overlay.fadeInSec ?? 0}
          onChange={(e) => onUpdate({ fadeInSec: Math.max(0, Number(e.target.value) || 0) })}
          className="w-16 px-1.5 py-0.5 rounded bg-white/10 text-white text-right outline-none focus:ring-1 focus:ring-teal-400"
        />
        <span className="text-white/60">sec</span>
      </label>

      <label className="flex items-center gap-2 text-[11px]">
        <span className="w-12 shrink-0 text-white/60">Fade out</span>
        <input
          type="number"
          min={0}
          max={10}
          step={0.1}
          value={overlay.fadeOutSec ?? 0}
          onChange={(e) => onUpdate({ fadeOutSec: Math.max(0, Number(e.target.value) || 0) })}
          className="w-16 px-1.5 py-0.5 rounded bg-white/10 text-white text-right outline-none focus:ring-1 focus:ring-teal-400"
        />
        <span className="text-white/60">sec</span>
      </label>

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Beats</span>
          {overlay.beats ? (
            <span className="text-[10px] tabular-nums text-amber-300/90">
              {overlay.bpm} BPM · {overlay.beats.length} beats
            </span>
          ) : null}
        </div>
        {!overlay.beats ? (
          <button
            type="button"
            disabled={beatState.busy}
            onClick={findBeats}
            title="Find the tempo and every beat - they show on the timeline, and dragging snaps to them"
            className="self-start px-2 py-1 rounded text-[11px] text-white/80 bg-white/5 hover:bg-white/10 disabled:opacity-50"
          >
            {beatState.busy ? "Listening for the beat…" : "Find beats"}
          </button>
        ) : (
          <div className="flex flex-col gap-1">
            {hasImageClips && (
              <div className="flex items-center gap-1 text-[11px]">
                <span className="text-white/60 mr-1">Cut images on the beat:</span>
                {[1, 2, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => onCutImagesOnBeat(n)}
                    title={`Every image ends exactly ${n} beat${n === 1 ? "" : "s"} after it starts`}
                    className="px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/15 text-white/80 tabular-nums"
                  >
                    {n === 1 ? "every beat" : `every ${n}`}
                  </button>
                ))}
              </div>
            )}
            <button type="button" onClick={() => onUpdate({ beats: undefined, bpm: undefined })} className="self-start text-[10px] text-white/45 hover:text-white/80">
              Hide beats
            </button>
          </div>
        )}
        {beatState.error && <p className="text-[10px] leading-snug text-red-300">{beatState.error}</p>}
      </div>

      <div className="flex items-center justify-between pt-1 border-t border-white/10">
        <button
          type="button"
          onClick={() => onUpdate({ muted: !overlay.muted })}
          className={`px-2 py-1 rounded text-[11px] transition-colors ${
            overlay.muted ? "text-teal-400 bg-teal-500/10" : "text-white/70 hover:text-white hover:bg-white/10"
          }`}
        >
          {overlay.muted ? "Muted" : "Mute"}
        </button>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onDuplicate} className="px-2 py-1 rounded text-[11px] text-white/70 hover:text-white hover:bg-white/10">
            Duplicate
          </button>
          <button type="button" onClick={onDelete} className="px-2 py-1 rounded text-[11px] text-red-400 hover:bg-red-500/10">
            Delete
          </button>
        </div>
      </div>
    </div>,
    dockHost ?? document.body
  );
};

export default AudioOverlayPopover;
