// components/docker/ExtractAudioPopover.tsx
//
// Standalone "extract this clip's audio to its own file" surface for the toolbar's own button -
// same portal + useClampedPopoverPosition + outside-click-close shape as SpeedPopover/
// NoiseReductionPopover. Picking a format immediately opens the native save dialog (handled by
// the caller via onExtract) rather than adding a second "now click Extract" step - there's nothing
// else to configure here, unlike Speed/Reduce noise's own sliders.
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoSyncOutline, IoDownloadOutline, IoGitBranchOutline } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";

const FORMATS = [
  { id: "mp3", label: "MP3", hint: "Smaller file, most compatible" },
  { id: "wav", label: "WAV", hint: "Uncompressed, largest file" },
  { id: "aac", label: "AAC", hint: "Smaller file, good quality" },
] as const;

export type DetachMode = "streams" | "voice-music";

// Mirrors audio_tracks.rs's SeparationEngineStatus.
export interface SeparationEngineStatus {
  installed: string | null;
  downloadBytes: number | null;
}

interface ExtractAudioPopoverProps {
  anchor: { left: number; top: number };
  isExtracting: boolean;
  onExtract: (format: "mp3" | "wav" | "aac") => void;
  // Unlinks the whole video's sound onto the audio lane (see handleDetachAudio, VideoTimelineDocker):
  // "streams" = one lane row per audio stream the file really has; "voice-music" = AI-split the
  // mixed sound into a voice stem and a music stem.
  onDetach: (mode: DetachMode) => void;
  // null while probing.
  streamCount: number | null;
  // What get_separation_engine reported; undefined = still checking.
  separationEngine: SeparationEngineStatus | undefined;
  // Live status line while a detach runs ("Separating voice and music (clip 1 of 2)…").
  detachStatus: string | null;
  // Set while a cancellable step (engine download or separation) runs, so the status line can
  // offer Cancel.
  onCancel: (() => void) | null;
  onClose: () => void;
}

const ExtractAudioPopover: React.FC<ExtractAudioPopoverProps> = ({ anchor, isExtracting, onExtract, onDetach, streamCount, separationEngine, detachStatus, onCancel, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);
  // Default to whichever mode actually splits something: several real streams if the file has
  // them, otherwise AI separation when an engine is installed.
  const [mode, setMode] = useState<DetachMode | null>(null);
  const engineInstalled = !!separationEngine?.installed;
  // Available = already installed, or a one-time download exists for this platform.
  const separationAvailable = engineInstalled || !!separationEngine?.downloadBytes;
  const effectiveMode: DetachMode = mode ?? ((streamCount ?? 1) > 1 || !engineInstalled ? "streams" : "voice-music");
  const needsDownload = effectiveMode === "voice-music" && !engineInstalled;
  const downloadMb = Math.round((separationEngine?.downloadBytes ?? 0) / 1_000_000);

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
      className="w-72 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <IoDownloadOutline size={14} />
          Extract audio
        </span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5 p-2 rounded-md bg-white/5 ring-1 ring-white/10">
        <span className="text-[11px] font-medium flex items-center gap-1.5">
          <IoGitBranchOutline size={13} />
          Detach audio to timeline
        </span>
        <label className="flex items-start gap-2 text-[11px] cursor-pointer">
          <input type="radio" className="mt-0.5 accent-teal-500" checked={effectiveMode === "streams"} onChange={() => setMode("streams")} disabled={isExtracting} />
          <span className="flex flex-col">
            <span>Each audio track separately</span>
            <span className="text-[10px] text-white/40">
              {streamCount == null
                ? "Checking tracks…"
                : streamCount === 0
                  ? "This file has no audio"
                  : streamCount === 1
                    ? "This file has 1 track - anything mixed into it stays together"
                    : `${streamCount} tracks found - one row each`}
            </span>
          </span>
        </label>
        <label className={`flex items-start gap-2 text-[11px] ${separationAvailable ? "cursor-pointer" : "opacity-60"}`}>
          <input
            type="radio"
            className="mt-0.5 accent-teal-500"
            checked={effectiveMode === "voice-music"}
            onChange={() => setMode("voice-music")}
            disabled={isExtracting || !separationAvailable}
          />
          <span className="flex flex-col">
            <span>Voice and music (AI separation)</span>
            <span className="text-[10px] text-white/40">
              {separationEngine === undefined
                ? "Checking for Demucs…"
                : engineInstalled
                  ? `Splits mixed sound into Voice + Music rows using ${separationEngine.installed}. Takes several times the video length on a typical laptop.`
                  : separationAvailable
                    ? `Splits mixed sound into Voice + Music rows. First use downloads the AI audio engine (~${downloadMb} MB, one time); separating takes several times the video length on a typical laptop.`
                    : String.raw`Needs Demucs: run "pip install demucs", or put demucs.cpp and its htdemucs-4s model in %LOCALAPPDATA%\com.briefscan.app\demucs, then reopen this.`}
            </span>
          </span>
        </label>
        <button
          type="button"
          disabled={isExtracting || streamCount === 0 || (effectiveMode === "voice-music" && !separationAvailable)}
          onClick={() => onDetach(effectiveMode)}
          className="mt-0.5 px-2 py-1.5 rounded text-[11px] font-medium text-white bg-teal-600/80 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-default transition-colors"
        >
          {needsDownload ? `Download engine (~${downloadMb} MB) and detach` : "Detach and mute original"}
        </button>
      </div>

      <p className="text-[10px] leading-snug text-white/40">
        Or save this clip's trimmed audio (speed and noise reduction included) to its own file.
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
          <IoSyncOutline size={11} className="animate-spin shrink-0" />
          <span className="flex-1">{detachStatus ?? "Extracting…"}</span>
          {onCancel && (
            <button type="button" onClick={onCancel} className="shrink-0 px-1.5 py-0.5 rounded text-white/70 hover:text-white hover:bg-white/10">
              Cancel
            </button>
          )}
        </p>
      )}
    </div>,
    document.body
  );
};

export default ExtractAudioPopover;
