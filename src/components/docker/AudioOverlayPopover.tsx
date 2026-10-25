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
import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoPause, IoPlay } from "react-icons/io5";
import { AudioOverlay } from "../../utils/videoEditTypes";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, useDockSnap, useFloatingDismiss, useToolPanelHost } from "./ToolPanelHost";
import { creditLine, needsCredit } from "../../utils/musicLibrary";
import { DEFAULT_DUCK_LEVEL, isSpeechOverlay } from "../../utils/musicDucking";
import { channelAnalyser, routeElement, syncElementFx } from "../../utils/mixerGraph";
import { getWaveformPeaks, sliceWaveformWindow } from "../../utils/audioWaveform";
import LiveScope from "./LiveScope";
import { describeProgress, formatTimeLeft, useJobProgress } from "../../utils/jobProgress";
import { claimPlayback, readShowPlayingLine, registerPlayback, saveShowPlayingLine, setPreviewHead } from "../../utils/previewHead";
import KnobSlider from "./KnobSlider";

export type AudioOverlayContentPatch = Partial<Pick<AudioOverlay, "volume" | "fadeInSec" | "fadeOutSec" | "muted" | "bpm" | "beats" | "trimStart" | "endTime" | "duckUnderSpeech" | "duckLevel" | "fx" | "gain" | "noiseReduction" | "audioCleanup" | "src" | "bleed">>;

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
  // Opens the mixer at this track's strip (EQ, compressor, balance).
  onOpenMixer?: () => void;
  // Opens (or closes) its volume line on the timeline (AutomationLine), and whether it's open.
  onDrawVolume?: () => void;
  volumeLineOpen?: boolean;
  // Noise clean-up - this track's alone: where its render is ("calibrating" while the cleaned file
  // is being made), why it failed, whether to open with the section expanded (the right-click
  // menu's noise entry), and the hold-to-compare with the original.
  cleanupStatus?: "idle" | "calibrating" | "active";
  cleanupError?: string;
  noiseFocus?: boolean;
  onHearOriginal?: (hold: boolean) => void;
  // Playback bleed (utils/bleed): the run in progress (or its outcome when nothing was found), and
  // starting, cancelling and undoing it.
  bleedJob?: { stage: string; progress: number; secondsLeft?: number | null; noneFound?: boolean; error?: string } | null;
  onFindBleed?: (strength: "gentle" | "normal" | "strong") => void;
  onCancelBleed?: () => void;
  onRestoreBleed?: () => void;
  onClose: () => void;
}

const AudioOverlayPopover: React.FC<AudioOverlayPopoverProps> = ({ overlay, anchor, onUpdate, onDuplicate, onDelete, videoEnd, onSplitAtPlayhead, onPreviewStart, timelinePlaying, hasImageClips, onCutImagesOnBeat, onOpenMixer, onDrawVolume, volumeLineOpen, cleanupStatus, cleanupError, noiseFocus, onHearOriginal, bleedJob, onFindBleed, onCancelBleed, onRestoreBleed, onClose }) => {
  const [noiseExtrasOpen, setNoiseExtrasOpen] = useState(!!noiseFocus);
  useEffect(() => {
    if (noiseFocus) setNoiseExtrasOpen(true);
  }, [noiseFocus]);
  const [holding, setHolding] = useState(false);
  const cleanup = overlay.audioCleanup ?? {};
  // One extra stage on or off - an all-default clean-up is stored as none at all.
  const setExtra = (patch: Partial<NonNullable<AudioOverlay["audioCleanup"]>>) => {
    const next: Record<string, unknown> = { ...cleanup, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === false) delete next[k];
    onUpdate({ audioCleanup: Object.keys(next).length > 0 ? (next as AudioOverlay["audioCleanup"]) : undefined });
  };
  const extrasOn = [cleanup.lowCut, cleanup.hum, cleanup.gate, cleanup.level].filter(Boolean).length;
  // Off / Reduce / Remove, the same modes a clip's sound has.
  const noiseOn = (overlay.noiseReduction ?? 0) > 0;
  const noiseMode: "off" | "reduce" | "remove" = !noiseOn ? "off" : overlay.audioCleanup?.mode === "remove" ? "remove" : "reduce";
  const setNoiseMode = (mode: "off" | "reduce" | "remove") => {
    if (mode === "off") {
      onUpdate({ noiseReduction: undefined, audioCleanup: overlay.audioCleanup?.mode ? { ...overlay.audioCleanup, mode: undefined } : overlay.audioCleanup });
      return;
    }
    const strength = noiseOn ? overlay.noiseReduction : 0.5;
    const rest = { ...overlay.audioCleanup };
    delete rest.mode;
    onUpdate({ noiseReduction: strength, audioCleanup: mode === "remove" ? { ...rest, mode: "remove" } : Object.keys(rest).length > 0 ? rest : undefined });
  };
  const [beatState, setBeatState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  // How far along the long jobs are - a long file takes a while, and says how long.
  const beatProgress = useJobProgress({ job: `beats:${overlay.src}` }, beatState.busy);
  const cleaningProgress = useJobProgress({ conversionOf: overlay.src }, cleanupStatus === "calibrating");
  const speechProgress = useJobProgress({ jobPrefix: "silence:" }, !!overlay.duckUnderSpeech);
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
  // The playing line on this track's chip (PreviewHeadLine): where the preview is, every frame while
  // it plays and held where it paused - so a moment heard here can be found on the timeline.
  const [showLine, setShowLine] = useState(readShowPlayingLine);
  useEffect(() => {
    const audio = previewRef.current;
    if (!audio) return;
    const seek = (t: number) => {
      audio.currentTime = Math.max(partFrom, Math.min(partTo - 0.05, t));
      setPreviewAt(audio.currentTime);
    };
    const write = () =>
      setPreviewHead(overlay.id, previewing || audio.currentTime > partFrom ? { at: audio.currentTime, playing: previewing, visible: showLine, leads: true, seek } : null);
    write();
    if (!previewing) return;
    let raf = 0;
    const tick = () => {
      write();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [previewing, showLine, overlay.id, partFrom, partTo, previewAt]);
  useEffect(() => () => setPreviewHead(overlay.id, null), [overlay.id]);
  // One player at a time: the timeline or the mixer starting stops this preview.
  useEffect(() => registerPlayback("panel", () => previewRef.current?.pause()), []);
  const togglePreview = () => {
    const audio = previewRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    onPreviewStart?.();
    claimPlayback("panel");
    // Through the mixer, so the preview has the track's effects too - and its scope a signal to read.
    void routeElement(audio, `preview:${overlay.id}`, overlay.fx);
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
  useEffect(() => {
    const audio = previewRef.current;
    if (audio) syncElementFx(audio, `preview:${overlay.id}`, overlay.fx, false);
  }, [overlay.fx, overlay.id]);
  // The part's shape for the scope at rest.
  const [songPeaks, setSongPeaks] = useState<Float32Array | null>(null);
  useEffect(() => {
    let cancelled = false;
    getWaveformPeaks(overlay.src)
      .then((p) => !cancelled && setSongPeaks(p))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [overlay.src]);
  const partPeaks = useMemo(
    () => (songPeaks ? sliceWaveformWindow(songPeaks, overlay.sourceDuration, partFrom, partTo - partFrom, 96) : null),
    [songPeaks, overlay.sourceDuration, partFrom, partTo]
  );

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
          // Lets Web Audio read its samples (the mixer, the scope) - asset:// answers CORS.
          crossOrigin="anonymous"
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

      {/* What this piece sounds like right now - from the timeline as it plays, or the preview. */}
      <LiveScope
        getAnalyser={() => channelAnalyser(previewing ? `preview:${overlay.id}` : `audio:${overlay.id}`)}
        active={previewing || !!timelinePlaying}
        idlePeaks={partPeaks}
        progress={previewing || previewAt > partFrom ? Math.max(0, Math.min(1, (previewAt - partFrom) / Math.max(0.01, partTo - partFrom))) : null}
      />
      <label className="-mt-1 flex items-center gap-2 text-[10px] text-white/55 cursor-pointer" title="A line on this track in the timeline follows what's playing here - click the track to jump there">
        <input
          type="checkbox"
          checked={showLine}
          onChange={(e) => {
            setShowLine(e.target.checked);
            saveShowPlayingLine(e.target.checked);
          }}
          className="accent-amber-300"
        />
        Show playing line on the track
      </label>

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
        <KnobSlider min={0} max={1} step={0.01} value={overlay.volume} onChange={(v) => onUpdate({ volume: v })} resetTo={1} />
        <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(overlay.volume * 100)}%</span>
      </label>
      {onOpenMixer && (
        <button
          type="button"
          onClick={onOpenMixer}
          title="EQ, compressor and balance - shared by every piece of this track"
          className="self-start -mt-1 px-2 py-1 rounded text-[11px] text-white/80 bg-white/5 hover:bg-white/10"
        >
          Mixer &amp; effects…{overlay.fx ? " (on)" : ""}
        </button>
      )}
      {onDrawVolume && (
        <button
          type="button"
          onClick={onDrawVolume}
          title={volumeLineOpen ? "Put the line away (Esc)" : "Ride the level over time - draw points on a line over the waveform"}
          className={`self-start -mt-1 px-2 py-1 rounded text-[11px] ${volumeLineOpen ? "text-black bg-amber-400 hover:bg-amber-300" : "text-amber-200/90 bg-amber-400/10 hover:bg-amber-400/20"}`}
        >
          {volumeLineOpen
            ? "Done drawing"
            : overlay.gain?.length
              ? `Volume line · ${overlay.gain.length} point${overlay.gain.length === 1 ? "" : "s"}`
              : "Draw volume line"}
        </button>
      )}

      {/* Noise clean-up - rendered once through the export's own chain, then played in place. */}
      <div className="flex flex-col gap-1.5 py-1.5 border-y border-white/10">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-12 shrink-0 text-white/60">Noise</span>
          <div className="flex p-0.5 rounded-md bg-white/5 flex-1">
            {(
              [
                ["off", "Off", "Leave the sound as it is"],
                ["reduce", "Reduce", "Turns hiss, hum and room tone down - keeps a natural bit of air. Safe on music"],
                ["remove", "Remove", "Keeps only the voice - strips everything else (AI voice isolation). For speech"],
              ] as const
            ).map(([m, label, hint]) => (
              <button
                key={m}
                type="button"
                title={hint}
                onClick={() => setNoiseMode(m)}
                className={`flex-1 px-1.5 py-0.5 rounded text-[11px] ${noiseMode === m ? (m === "off" ? "bg-white/15 text-white" : "bg-teal-500/25 text-teal-100 ring-1 ring-teal-400/40") : "text-white/55 hover:text-white"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {noiseOn && (
          <label className="flex items-center gap-2 text-[11px]">
            <span className="w-12 shrink-0 text-white/60">Strength</span>
            <KnobSlider min={0.05} max={1} step={0.05} value={overlay.noiseReduction ?? 0.5} onChange={(v) => onUpdate({ noiseReduction: v })} resetTo={0.5} />
            <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round((overlay.noiseReduction ?? 0) * 100)}%</span>
          </label>
        )}
        {noiseExtrasOpen && (
          <div className="flex flex-col gap-0.5 pl-1">
            {(
              [
                ["lowCut", "Cut rumble & wind", "Low thumps, handling noise, wind"],
                ["gate", "Silence gaps", "Mutes leftover noise between phrases"],
                ["level", "Even out loudness", "Levels quiet and loud passages to -16 LUFS"],
              ] as const
            ).map(([key, label, hint]) => (
              <label key={key} className="flex items-center gap-2 py-0.5 text-[11px] cursor-pointer" title={hint}>
                <input type="checkbox" checked={!!cleanup[key]} onChange={(e) => setExtra({ [key]: e.target.checked })} className="accent-teal-400" />
                <span className="text-white/80">{label}</span>
                <span className="text-[10px] text-white/35 truncate">{hint}</span>
              </label>
            ))}
            <div className="flex items-center gap-2 py-0.5 text-[11px]" title="Electrical buzz from mains power - 50 Hz in Europe, Africa and most of Asia, 60 Hz in the Americas">
              <span className="text-white/80">Remove hum</span>
              <div className="flex p-0.5 rounded bg-white/5 ml-auto">
                {([undefined, 50, 60] as const).map((hz) => (
                  <button
                    key={hz ?? "off"}
                    type="button"
                    onClick={() => setExtra({ hum: hz })}
                    className={`px-1.5 rounded text-[10px] ${cleanup.hum === hz ? "bg-white/15 text-white" : "text-white/55 hover:text-white"}`}
                  >
                    {hz ? `${hz} Hz` : "Off"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 text-[10px]">
          <span className={`flex-1 min-w-0 truncate ${cleanupError ? "text-red-300/90" : "text-white/40"}`} title={cleanupError}>
            {cleanupError
              ? `Couldn't clean it: ${cleanupError}`
              : cleanupStatus === "calibrating"
                ? cleaningProgress
                  ? `Cleaning this track… ${describeProgress(cleaningProgress)}`
                  : "Cleaning this track… plays as it is until then"
                : cleanupStatus === "active"
                  ? holding
                    ? "Hearing the original"
                    : "Playing cleaned - saved the same way"
                  : "Only this track - hiss, hum, room, wind"}
          </span>
          {cleanupStatus === "active" && onHearOriginal && (
            <button
              type="button"
              onPointerDown={() => {
                setHolding(true);
                onHearOriginal(true);
              }}
              onPointerUp={() => {
                setHolding(false);
                onHearOriginal(false);
              }}
              onPointerLeave={() => {
                if (!holding) return;
                setHolding(false);
                onHearOriginal(false);
              }}
              title="Hold to hear this track without its clean-up"
              className={`shrink-0 px-1.5 py-0.5 rounded ${holding ? "bg-amber-400 text-black" : "bg-white/5 hover:bg-white/10 text-white/70 hover:text-white"}`}
            >
              Hold: original
            </button>
          )}
          <button
            type="button"
            onClick={() => setNoiseExtrasOpen((v) => !v)}
            className="shrink-0 px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-white/70 hover:text-white"
            title="Rumble, hum, gaps and loudness - for this track"
          >
            Extras{extrasOn > 0 ? ` · ${extrasOn}` : ""} {noiseExtrasOpen ? "▴" : "▾"}
          </button>
        </div>
      </div>

      {(overlay.recorded || overlay.bleed) && onFindBleed && (
        <BleedSection
          overlay={overlay}
          job={bleedJob ?? null}
          onFind={onFindBleed}
          onCancel={onCancelBleed}
          onRestore={onRestoreBleed}
          onHearOriginal={onHearOriginal}
        />
      )}

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
          {overlay.duckUnderSpeech && speechProgress && (
            <p className="text-[10px] text-white/45">Listening for speech… {describeProgress(speechProgress)}</p>
          )}
          {overlay.duckUnderSpeech && (
            <label className="flex items-center gap-2 text-[11px]">
              <span className="w-12 shrink-0 text-white/60">Dips to</span>
              <KnobSlider min={0} max={0.8} step={0.05} value={overlay.duckLevel ?? DEFAULT_DUCK_LEVEL} onChange={(v) => onUpdate({ duckLevel: v })} resetTo={DEFAULT_DUCK_LEVEL} />
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
            {beatState.busy ? `Listening for the beat…${beatProgress ? ` ${describeProgress(beatProgress)}` : ""}` : "Find beats"}
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

// Playback bleed: the video's own sound, picked up by the mic while recording over it and heard back
// as an echo - found and taken out against exactly what the timeline played (utils/bleed).
const BLEED_STAGES: Record<string, string> = {
  render: "Rendering what was playing…",
  delay: "Finding how late it arrives…",
  learn: "Learning the speakers and the room…",
  remove: "Taking it out…",
  save: "Saving…",
};
const STRENGTH_LABELS = [
  ["gentle", "Gentle", "Leaves a trace of the room - safest on a voice that's quiet against the bleed"],
  ["normal", "Normal", "Removes the bleed and its echo"],
  ["strong", "Strong", "Also clears the faintest leftovers - for very loud speakers"],
] as const;

const BleedSection: React.FC<{
  overlay: AudioOverlay;
  job: { stage: string; progress: number; secondsLeft?: number | null; noneFound?: boolean; error?: string } | null;
  onFind: (strength: "gentle" | "normal" | "strong") => void;
  onCancel?: () => void;
  onRestore?: () => void;
  onHearOriginal?: (hold: boolean) => void;
}> = ({ overlay, job, onFind, onCancel, onRestore, onHearOriginal }) => {
  const [holding, setHolding] = useState(false);
  const bleed = overlay.bleed;
  const running = !!job && !job.noneFound && !job.error && job.progress < 1;
  const hold = (on: boolean) => {
    setHolding(on);
    onHearOriginal?.(on);
  };
  const late = bleed && bleed.delaysMs.length > 0 ? Math.round(bleed.delaysMs[0]) : null;
  return (
    <div className="flex flex-col gap-1.5 py-1.5 border-b border-white/10">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-white/60">Playback bleed</span>
        <span className="text-[10px] text-white/35 truncate">the video's sound, caught by the mic</span>
      </div>

      {running ? (
        <div className="flex flex-col gap-1">
          <div className="relative h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-teal-400 to-amber-300 transition-[width] duration-200" style={{ width: `${Math.round(job!.progress * 100)}%` }} />
          </div>
          <div className="flex items-center gap-2 text-[10px] text-white/55">
            <span className="flex-1 truncate">{BLEED_STAGES[job!.stage] ?? "Working…"}</span>
            <span className="tabular-nums">
              {Math.round(job!.progress * 100)}%{job!.secondsLeft != null ? ` · ${formatTimeLeft(job!.secondsLeft)}` : ""}
            </span>
            {onCancel && (
              <button type="button" onClick={onCancel} className="px-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
                Cancel
              </button>
            )}
          </div>
        </div>
      ) : bleed ? (
        <div className="flex flex-col gap-1.5 p-2 rounded-md bg-teal-500/10 ring-1 ring-teal-400/20">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-teal-100 tabular-nums">−{Math.max(0, Math.round(bleed.removedDb))} dB</span>
            <span className="text-[10px] text-teal-100/70">of bleed removed</span>
          </div>
          <div className="text-[10px] leading-snug text-white/55">
            Found in {bleed.regions.length} {bleed.regions.length === 1 ? "place" : "places"}
            {late !== null ? `, arriving ${late} ms after the picture` : ""}
            {bleed.delaysMs.length > 1 ? ` (playback hiccuped ${bleed.delaysMs.length - 1}×, followed)` : ""}. Marked on the track.
          </div>
          <div className="flex items-center gap-1">
            {STRENGTH_LABELS.map(([s, label, hint]) => (
              <button
                key={s}
                type="button"
                title={hint}
                onClick={() => s !== bleed.strength && onFind(s)}
                className={`px-1.5 py-0.5 rounded text-[10px] ${bleed.strength === s ? "bg-white/15 text-white" : "text-white/55 hover:text-white hover:bg-white/5"}`}
              >
                {label}
              </button>
            ))}
            <span className="flex-1" />
            {onHearOriginal && (
              <button
                type="button"
                onPointerDown={() => hold(true)}
                onPointerUp={() => hold(false)}
                onPointerLeave={() => holding && hold(false)}
                title="Hold to hear the take as it was recorded"
                className={`px-1.5 py-0.5 rounded text-[10px] ${holding ? "bg-amber-400 text-black" : "bg-white/5 hover:bg-white/10 text-white/70"}`}
              >
                Hold: before
              </button>
            )}
            {onRestore && (
              <button type="button" onClick={onRestore} title="Go back to the take as recorded" className="px-1.5 py-0.5 rounded text-[10px] text-white/55 hover:text-white hover:bg-white/5">
                Restore
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onFind("normal")}
            className="px-2 py-1 rounded text-[11px] font-medium text-black bg-gradient-to-r from-teal-300 to-amber-200 hover:brightness-110"
            title="Finds the video's own sound in this take - however late it arrived - and takes it out"
          >
            Find & remove bleed
          </button>
          <span className="text-[10px] leading-snug text-white/40">
            {job?.noneFound ? "None found - this take is clean." : job?.error ? <span className="text-red-300/90">{job.error}</span> : "Recorded with speakers on? This takes the echo out."}
          </span>
        </div>
      )}
    </div>
  );
};

export default AudioOverlayPopover;
