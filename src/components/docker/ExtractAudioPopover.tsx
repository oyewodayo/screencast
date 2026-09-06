// components/docker/ExtractAudioPopover.tsx
//
// Standalone "extract this clip's audio to its own file" surface for the toolbar's own button -
// same portal + useClampedPopoverPosition + outside-click-close shape as SpeedPopover/
// NoiseReductionPopover. Picking a format immediately opens the native save dialog (handled by
// the caller via onExtract) rather than adding a second "now click Extract" step - there's nothing
// else to configure here, unlike Speed/Reduce noise's own sliders.
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoSyncOutline, IoMusicalNotesOutline } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";

const FORMATS = [
  { id: "mp3", label: "MP3", hint: "Smaller file, most compatible" },
  { id: "wav", label: "WAV", hint: "Uncompressed, largest file" },
  { id: "aac", label: "AAC", hint: "Smaller file, good quality" },
] as const;

interface ExtractAudioPopoverProps {
  anchor: { left: number; top: number };
  isExtracting: boolean;
  onExtract: (format: "mp3" | "wav" | "aac") => void;
  onClose: () => void;
}

const ExtractAudioPopover: React.FC<ExtractAudioPopoverProps> = ({ anchor, isExtracting, onExtract, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-extract-audio-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      data-extract-audio-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-60 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <IoMusicalNotesOutline size={14} />
          Extract audio
        </span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      <p className="text-[10px] leading-snug text-white/40">
        Saves this clip's trimmed audio (speed and noise reduction included) to its own file.
      </p>

      <div className="flex flex-col gap-1">
        {FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            disabled={isExtracting}
            onClick={() => onExtract(f.id)}
            className="flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left text-[11px] text-white/70 hover:text-white bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-default transition-colors"
          >
            <span className="font-medium">{f.label}</span>
            <span className="text-white/40">{f.hint}</span>
          </button>
        ))}
      </div>

      {isExtracting && (
        <p className="flex items-center gap-1.5 text-[10px] text-blue-400 pt-1 border-t border-white/10">
          <IoSyncOutline size={11} className="animate-spin" />
          Extracting…
        </p>
      )}
    </div>,
    document.body
  );
};

export default ExtractAudioPopover;
