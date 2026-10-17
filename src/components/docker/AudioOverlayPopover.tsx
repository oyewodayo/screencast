// components/docker/AudioOverlayPopover.tsx
//
// The style/control surface for a selected audio overlay - which part of the song plays, volume,
// fade in/out, cut, mute, duplicate, delete. Portal-rendered and positioned from the timeline chip's own getBoundingClientRect()
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
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoPause, IoPlay } from "react-icons/io5";
import { AudioOverlay } from "../../utils/videoEditTypes";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, useDockSnap, useFloatingDismiss, useToolPanelHost } from "./ToolPanelHost";
import { creditLine, needsCredit } from "../../utils/musicLibrary";
import { DEFAULT_DUCK_LEVEL, isSpeechOverlay } from "../../utils/musicDucking";

export type AudioOverlayContentPatch = Partial<Pick<AudioOverlay, "volume" | "fadeInSec" | "fadeOutSec" | "muted" | "bpm" | "beats" | "trimStart" | "endTime" | "duckUnderSpeech" | "duckLevel">>;

const MIN_PART_SEC = 0.1;
const FIT_FADE_OUT_SEC = 2;
const formatSec = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;

interface AudioOverlayPopoverProps {
  overlay: AudioOverlay;
  anchor: { left: number; top: number };
  onUpdate: (patch: AudioOverlayContentPatch) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  // Where the video (and so the export) ends on the output timeline - audio past it isn't exported.
  videoEnd: number;
  // Cut this audio at the playhead; null when the playhead isn't inside it.
  onSplitAtPlayhead: (() => void) | null;
  // Called as the song preview starts, so the timeline isn't playing underneath it.
  onPreviewStart?: () => void;
  // Whether the timeline itself is playing - starting it stops the preview.
  timelinePlaying?: boolean;
  // Beat sync - fit every image clip to this (and any other) track's beats.
  hasImageClips: boolean;
  onCutImagesOnBeat: (everyBeats: number) => void;
  onClose: () => void;
}

const AudioOverlayPopover: React.FC<AudioOverlayPopoverProps> = ({ overlay, anchor, onUpdate, onDuplicate, onDelete, videoEnd, onSplitAtPlayhead, onPreviewStart, timelinePlaying, hasImageClips, onCutImagesOnBeat, onClose }) => {
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

  // A click elsewhere closes it (not the chip that opened it - that click toggles selection on its
  // own) - unless that click opened the sidebar, which docks it instead, gliding into place.
  useFloatingDismiss("[data-audio-overlay-popover], [data-audio-chip]", onClose, !!dockHost);
  useDockSnap(popoverRef, !!dockHost);

  const fileName = overlay.src.split(/[\\/]/).pop() ?? overlay.src;
  const library = overlay.library;
  const credit = library && needsCredit(library) ? creditLine(library) : null;
  const [creditCopied, setCreditCopied] = useState(false);
  const copyCredit = () => {
    if (!credit) return;
    void navigator.clipboard.writeText(credit).then(() => {
      setCreditCopied(true);
      window.setTimeout(() => setCreditCopied(false), 1500);
    });
  };

  // The part of the song that plays, in seconds into the file. It always plays at 1x, so its length
  // on the timeline is (to - from) and only the end moves when either changes.
  const partFrom = overlay.trimStart;
  const partTo = overlay.trimStart + (overlay.endTime - overlay.startTime);
  const setPart = (from: number, to: number) => {
    const f = Math.max(0, Math.min(from, overlay.sourceDuration - MIN_PART_SEC));
    const t = Math.max(f + MIN_PART_SEC, Math.min(to, overlay.sourceDuration));
    onUpdate({ trimStart: f, endTime: overlay.startTime + (t - f) });
  };
  const pastVideoEnd = Math.max(0, overlay.endTime - Math.max(overlay.startTime, videoEnd));
  // Ends it exactly where the video does (never longer than what's left of the song).
  const fitToVideo = (fadeOut: boolean) => {
    const t = Math.max(partFrom + MIN_PART_SEC, Math.min(partFrom + (videoEnd - overlay.startTime), overlay.sourceDuration));
    onUpdate({ endTime: overlay.startTime + (t - partFrom), ...(fadeOut ? { fadeOutSec: FIT_FADE_OUT_SEC } : {}) });
  };
  // Preview: plays just this part of the song on its own (its own <audio>, not the timeline's), at
  // the chip's volume, from where it was paused - back to the part's start once it reaches the end.
  const previewRef = useRef<HTMLAudioElement>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewAt, setPreviewAt] = useState(partFrom);
  const togglePreview = () => {
    const audio = previewRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    onPreviewStart?.();
    if (audio.currentTime < partFrom || audio.currentTime >= partTo - 0.05) audio.currentTime = partFrom;
    audio.volume = overlay.muted ? 0 : Math.max(0, Math.min(1, overlay.volume));
    audio.play().catch((err) => console.error("Song preview failed to play:", overlay.src, err));
  };
  useEffect(() => {
    const audio = previewRef.current;
    if (audio) audio.volume = overlay.muted ? 0 : Math.max(0, Math.min(1, overlay.volume));
  }, [overlay.volume, overlay.muted]);
  useEffect(() => {
    const audio = previewRef.current;
    return () => audio?.pause(); // closing the panel stops the preview
  }, []);
  useEffect(() => {
    if (timelinePlaying) previewRef.current?.pause();
  }, [timelinePlaying]);

  const partButtonClass = "px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/15 text-white/80 disabled:opacity-40 disabled:hover:bg-white/5";

  return createPortal(
    <div
      ref={popoverRef}
      data-audio-overlay-popover
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={dockHost ? `${DOCKED_PANEL_CLASS} p-3 gap-2.5` : "w-64 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={togglePreview}
          title={previewing ? "Pause the song" : "Play this part of the song on its own"}
          className="shrink-0 h-6 w-6 flex items-center justify-center rounded-full bg-teal-500 hover:bg-teal-400 text-white"
        >
          {previewing ? <IoPause size={12} /> : <IoPlay size={12} className="ml-px" />}
        </button>
        {library ? (
          <span className="flex-1 min-w-0 leading-tight" title={`${library.title} - ${library.artist}`}>
            <span className="block text-xs font-medium truncate">{library.title}</span>
            <span className="block text-[10px] text-white/45 truncate">{library.artist}</span>
          </span>
        ) : (
          <span className="flex-1 min-w-0 text-xs font-medium truncate" title={fileName}>
            {fileName}
          </span>
        )}
        <span className="shrink-0 text-[10px] tabular-nums text-white/45" title="Preview position in this part">
          {formatSec(Math.max(0, Math.min(previewAt, partTo) - partFrom))}
        </span>
        <audio
          ref={previewRef}
          src={convertFileSrc(overlay.src)}
          preload="metadata"
          onPlay={() => setPreviewing(true)}
          onPause={() => setPreviewing(false)}
          onTimeUpdate={(e) => {
            const audio = e.currentTarget;
            setPreviewAt(audio.currentTime);
            if (audio.currentTime >= partTo) {
              audio.pause();
              audio.currentTime = partFrom;
            }
          }}
        />
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5 pb-1 border-b border-white/10">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Part of the song</span>
          <span className="text-[10px] tabular-nums text-white/45" title="Length used / whole file">
            {formatSec(partTo - partFrom)} / {formatSec(overlay.sourceDuration)}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-12 shrink-0 text-white/60">From</span>
          <input
            type="number"
            min={0}
            max={overlay.sourceDuration}
            step={0.1}
            value={Number(partFrom.toFixed(1))}
            onChange={(e) => setPart(Number(e.target.value) || 0, partTo)}
            title="Where in the song this starts (seconds)"
            className="w-16 px-1.5 py-0.5 rounded bg-white/10 text-white text-right outline-none focus:ring-1 focus:ring-teal-400"
          />
          <span className="text-white/60">to</span>
          <input
            type="number"
            min={0}
            max={overlay.sourceDuration}
            step={0.1}
            value={Number(partTo.toFixed(1))}
            onChange={(e) => setPart(partFrom, Number(e.target.value) || 0)}
            title="Where in the song this stops (seconds)"
            className="w-16 px-1.5 py-0.5 rounded bg-white/10 text-white text-right outline-none focus:ring-1 focus:ring-teal-400"
          />
        </div>
        {pastVideoEnd > 0.05 && (
          <p className="text-[10px] leading-snug text-amber-300/90">{formatSec(pastVideoEnd)} runs past the end of the video and won't be exported.</p>
        )}
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <button type="button" onClick={() => fitToVideo(false)} title="End this audio exactly where the video ends" className={partButtonClass}>
            Fit to video
          </button>
          <button type="button" onClick={() => fitToVideo(true)} title={`Fit to the video and fade out over its last ${FIT_FADE_OUT_SEC}s`} className={partButtonClass}>
            Fit & fade out
          </button>
          <button type="button" onClick={() => setPart(partFrom, overlay.sourceDuration)} title="Play on to the end of the song" className={partButtonClass}>
            Full song
          </button>
          <button
            type="button"
            disabled={!onSplitAtPlayhead}
            onClick={() => onSplitAtPlayhead?.()}
            title={onSplitAtPlayhead ? "Cut in two at the playhead - then delete the piece you don't want" : "Move the playhead inside this audio to cut it there"}
            className={partButtonClass}
          >
            Cut at playhead
          </button>
        </div>
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

      {!isSpeechOverlay(overlay) && (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
          <label className="flex items-center justify-between gap-2 text-[11px] cursor-pointer" title="Dips this track while someone is speaking - in the preview and the saved video alike">
            <span className="text-white/80">Lower under speech</span>
            <input type="checkbox" checked={!!overlay.duckUnderSpeech} onChange={(e) => onUpdate({ duckUnderSpeech: e.target.checked })} className="accent-teal-400" />
          </label>
          {overlay.duckUnderSpeech && (
            <label className="flex items-center gap-2 text-[11px]">
              <span className="w-12 shrink-0 text-white/60">Dips to</span>
              <input
                type="range"
                min={0}
                max={0.8}
                step={0.05}
                value={overlay.duckLevel ?? DEFAULT_DUCK_LEVEL}
                onChange={(e) => onUpdate({ duckLevel: Number(e.target.value) })}
                className="flex-1 accent-teal-400"
              />
              <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round((overlay.duckLevel ?? DEFAULT_DUCK_LEVEL) * 100)}%</span>
            </label>
          )}
        </div>
      )}

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

      {library && (
        <div className="flex flex-col gap-1 pt-1 border-t border-white/10">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-white/40">Licence</span>
            <span className="text-[10px] text-white/50" title={library.licenseUrl}>
              {library.license.replace(/-/g, " ")}
            </span>
          </div>
          {credit ? (
            <>
              <p className="text-[10px] leading-snug text-white/55">Free to use - put this credit in your video's description:</p>
              <div className="flex items-start gap-1.5">
                <code className="flex-1 min-w-0 px-1.5 py-1 rounded bg-white/5 text-[10px] leading-snug text-white/75 break-words">{credit}</code>
                <button type="button" onClick={copyCredit} className="shrink-0 px-1.5 py-1 rounded text-[10px] bg-white/10 hover:bg-white/15 text-white/80">
                  {creditCopied ? "Copied" : "Copy"}
                </button>
              </div>
            </>
          ) : (
            <p className="text-[10px] leading-snug text-white/45">Free to use, no credit needed.</p>
          )}
        </div>
      )}

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
