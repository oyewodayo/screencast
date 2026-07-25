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
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { IoClose } from "react-icons/io5";
import { AudioOverlay } from "../../utils/videoEditTypes";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";

export type AudioOverlayContentPatch = Partial<Pick<AudioOverlay, "volume" | "fadeInSec" | "fadeOutSec" | "muted">>;

interface AudioOverlayPopoverProps {
  overlay: AudioOverlay;
  anchor: { left: number; top: number };
  onUpdate: (patch: AudioOverlayContentPatch) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const AudioOverlayPopover: React.FC<AudioOverlayPopoverProps> = ({ overlay, anchor, onUpdate, onDuplicate, onDelete, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      // Ignore the click that's still landing on the popover itself (or the chip that opened it -
      // that click already toggles selection on its own, this listener would otherwise immediately
      // re-close what it just opened).
      if (e.target instanceof Element && e.target.closest("[data-audio-overlay-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  const fileName = overlay.src.split(/[\\/]/).pop() ?? overlay.src;

  return createPortal(
    <div
      ref={popoverRef}
      data-audio-overlay-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-64 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
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
    document.body
  );
};

export default AudioOverlayPopover;
