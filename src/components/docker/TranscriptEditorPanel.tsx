// components/docker/TranscriptEditorPanel.tsx
//
// Edit by transcript: the timeline's speech as text, where removing words removes them from the
// video. Select words (click, drag, or Shift+click) and press Delete; or clean up the whole
// timeline in one click - filler sounds ("um", "uh"), stutters ("the the") and long pauses. Each
// cut is one undo step and only ever changes the clips (cutClipRanges), so captions and the
// remaining transcript follow along with no re-transcribing. Works from the same word-timed
// transcripts as the Captions tool; transcribing here leaves burned-in captions off.
//
// Docks into the sidebar's Tools tab like the Captions panel (ToolPanelHost.tsx), floating only
// when there's no sidebar to dock into.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoCutOutline, IoDocumentTextOutline, IoPauseOutline } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, useToolPanelHost, useDockSnap, useFloatingDismiss } from "./ToolPanelHost";
import { CaptionTrack, CaptionWord, Clip } from "../../utils/videoEditTypes";
import {
  ClipCut,
  TranscriptToken,
  buildTranscriptTokens,
  cutsDuration,
  cutsForLongPauses,
  cutsForTokens,
  fillerKeys,
  repeatKeys,
  withDetectedPauses,
} from "../../utils/transcriptEdit";
import { invoke } from "@tauri-apps/api/core";
import { CAPTIONS_LANGUAGE_OPTIONS } from "../../utils/videoUtils";
import { trackEvent } from "../../utils/telemetry";
import { GenerationProgressBar, useTranscriptGeneration } from "../captions/useTranscriptGeneration";

interface TranscriptEditorPanelProps {
  anchor: { left: number; top: number };
  captions: CaptionTrack | null;
  clips: Clip[];
  // Source files on the timeline that can have speech (image clips excluded).
  sourcePaths: string[];
  currentOutputTime: number;
  onGenerated: (language: string, transcripts: Record<string, CaptionWord[]>) => void;
  onCut: (cuts: ClipCut[]) => void;
  onSeek: (token: TranscriptToken) => void;
  onClose: () => void;
}

const PAUSE_OPTIONS = [0.75, 1, 1.5, 2];
// What a shortened pause keeps - enough to breathe, short enough to feel tight.
const PAUSE_KEEP_SEC = 0.3;
// Pauses at least this long are marked in the text.
const PAUSE_MARK_SEC = 0.75;

const formatSeconds = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`);

type Preview = { kind: "words"; keys: Set<string> } | { kind: "pauses"; min: number } | null;

const TranscriptEditorPanel: React.FC<TranscriptEditorPanelProps> = ({ anchor, captions, clips, sourcePaths, currentOutputTime, onGenerated, onCut, onSeek, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);
  const dockHost = useToolPanelHost();
  const [language, setLanguage] = useState<string>(captions?.language ?? "auto");
  const [pauseMin, setPauseMin] = useState(1);
  const [preview, setPreview] = useState<Preview>(null);

  const { generate, generating, error, resumable } = useTranscriptGeneration({
    sourcePaths,
    language,
    hasTranscripts: !!captions,
    // Transcribing to edit by doesn't switch on burned-in captions.
    onGenerated,
    telemetryEvent: "editor_transcript_generated",
  });

  // A click elsewhere closes it - unless that click opened the sidebar, which docks it instead,
  // gliding into place. Docked, it stays open until its X / toolbar button closes it.
  useFloatingDismiss("[data-transcript-panel]", onClose, !!dockHost);
  useDockSnap(popoverRef, !!dockHost);

  // The real silences in each source's audio (detect_silence - the same scan Trim silence uses),
  // so pauses are measured rather than guessed from word timings. Once per file per panel open;
  // until it's back (or if it fails), pauses come from the gaps between words.
  const [silences, setSilences] = useState<Record<string, { start: number; end: number }[]>>({});
  const sourcesKey = sourcePaths.join("|");
  useEffect(() => {
    let cancelled = false;
    sourcePaths.forEach((path) => {
      invoke<{ start: number; end: number }[]>("detect_silence", { inputPath: path, minDuration: 0.4 })
        .then((ranges) => !cancelled && setSilences((prev) => ({ ...prev, [path]: ranges })))
        .catch((err) => console.warn("Pause detection failed for", path, err));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesKey]);

  const tokens = useMemo(() => withDetectedPauses(buildTranscriptTokens(clips, captions), silences), [clips, captions, silences]);
  const indexByKey = useMemo(() => new Map(tokens.map((t, i) => [t.key, i])), [tokens]);
  const missingSources = sourcePaths.filter((p) => !captions?.transcripts[p]);

  // ---- Selection -----------------------------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorKeyRef = useRef<string | null>(null);
  const draggingRef = useRef(false);
  const draggedRef = useRef(false);
  // Drop keys whose words were cut (or whose clip changed) - a stale key can't be cut twice.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => indexByKey.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [indexByKey]);
  const selectRange = (fromKey: string, toKey: string) => {
    const a = indexByKey.get(fromKey);
    const b = indexByKey.get(toKey);
    if (a === undefined || b === undefined) return;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    setSelected(new Set(tokens.slice(lo, hi + 1).map((t) => t.key)));
  };
  useEffect(() => {
    const stop = () => {
      draggingRef.current = false;
    };
    document.addEventListener("pointerup", stop);
    return () => document.removeEventListener("pointerup", stop);
  }, []);

  const selectedCuts = useMemo(() => cutsForTokens(tokens, selected, clips), [tokens, selected, clips]);
  const cutSelection = () => {
    if (selectedCuts.length === 0) return;
    onCut(selectedCuts);
    trackEvent("editor_transcript_cut", { words: selected.size });
    setSelected(new Set());
  };

  // ---- One-click cleanups --------------------------------------------------------------------
  const fillers = useMemo(() => fillerKeys(tokens), [tokens]);
  const repeats = useMemo(() => repeatKeys(tokens), [tokens]);
  const fillerCuts = useMemo(() => cutsForTokens(tokens, fillers, clips), [tokens, fillers, clips]);
  const repeatCuts = useMemo(() => cutsForTokens(tokens, repeats, clips), [tokens, repeats, clips]);
  const pauseCuts = useMemo(() => cutsForLongPauses(tokens, pauseMin, PAUSE_KEEP_SEC), [tokens, pauseMin]);
  const applyCleanup = (cuts: ClipCut[], kind: string) => {
    if (cuts.length === 0) return;
    onCut(cuts);
    setPreview(null);
    trackEvent("editor_transcript_cleanup", { kind, cuts: cuts.length });
  };

  // ---- Following playback --------------------------------------------------------------------
  const activeIndex = useMemo(() => {
    let found = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].outputStart <= currentOutputTime + 0.01) found = i;
      else break;
    }
    return found >= 0 && currentOutputTime <= tokens[found].outputEnd + 1.5 ? found : -1;
  }, [tokens, currentOutputTime]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastUserScrollRef = useRef(0);
  useEffect(() => {
    if (activeIndex < 0 || draggingRef.current || Date.now() - lastUserScrollRef.current < 3000) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-token-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selected.size > 0) {
      e.preventDefault();
      e.stopPropagation(); // not also the timeline's "delete selected clip"
      cutSelection();
    } else if (e.key === "Escape" && selected.size > 0) {
      e.stopPropagation();
      setSelected(new Set());
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      e.stopPropagation(); // all the words, not also every clip on the timeline
      setSelected(new Set(tokens.map((t) => t.key)));
    }
  };

  const isPreviewed = (token: TranscriptToken) => preview?.kind === "words" && preview.keys.has(token.key);
  const isPausePreviewed = (token: TranscriptToken) => preview?.kind === "pauses" && token.pauseBefore > preview.min;

  const cleanupButton = (label: string, count: number, cuts: ClipCut[], previewValue: Preview, kind: string, title: string) => (
    <button
      type="button"
      disabled={cuts.length === 0}
      onMouseEnter={() => setPreview(previewValue)}
      onMouseLeave={() => setPreview(null)}
      onFocus={() => setPreview(previewValue)}
      onBlur={() => setPreview(null)}
      onClick={() => applyCleanup(cuts, kind)}
      title={title}
      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-white/5 hover:bg-white/10 text-[11px] text-left disabled:opacity-40 disabled:hover:bg-white/5"
    >
      <span>{label}</span>
      <span className="tabular-nums text-white/50">
        {count > 0 ? `${count} · −${formatSeconds(cutsDuration(cuts, clips))}` : "none"}
      </span>
    </button>
  );

  const selectionDuration = cutsDuration(selectedCuts, clips);
  const hasTokens = tokens.length > 0;

  return createPortal(
    <div
      ref={popoverRef}
      data-transcript-panel
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={
        dockHost
          ? `${DOCKED_PANEL_CLASS} p-3 gap-3`
          : "w-96 max-h-[calc(100vh-16px)] overflow-hidden p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <IoDocumentTextOutline size={14} />
          Edit by transcript
        </span>
        <button type="button" onClick={onClose} title="Close" className="p-0.5 rounded text-white/50 hover:text-white hover:bg-white/10">
          <IoClose size={14} />
        </button>
      </div>

      {sourcePaths.length === 0 ? (
        <p className="text-[11px] leading-snug text-white/60">There's no speech on this timeline to edit - it only has images. Add a video with sound to edit it by its transcript.</p>
      ) : !hasTokens && !generating ? (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] leading-snug text-white/60">
            {captions
              ? "No speech was found in what's left on the timeline."
              : "Transcribe the video to edit it like a document: delete words to cut them out, and remove filler words, stutters and long pauses in one click. Runs on your computer - nothing is uploaded."}
          </p>
          {!captions && (
            <div className="flex items-center gap-2">
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="flex-1 min-w-0 px-2 py-1 rounded bg-white/10 text-[11px] text-white outline-none focus:ring-1 focus:ring-blue-400/60"
              >
                {CAPTIONS_LANGUAGE_OPTIONS.map(([code, name]) => (
                  <option key={code} value={code} className="bg-neutral-900">
                    {name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void generate(sourcePaths, language)}
                className="shrink-0 px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-[11px] font-medium text-white"
              >
                {resumable ? `Resume (${Math.round((resumable.done / Math.max(1, resumable.total)) * 100)}%)` : "Transcribe"}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {generating && <GenerationProgressBar generating={generating} />}

      {hasTokens && missingSources.length > 0 && !generating && (
        <button
          type="button"
          onClick={() => void generate(missingSources, captions?.language ?? language)}
          className="self-start text-[11px] text-blue-300 hover:text-blue-200 underline underline-offset-2"
        >
          {missingSources.length === 1 ? "1 clip isn't transcribed yet" : `${missingSources.length} clips aren't transcribed yet`} - transcribe
        </button>
      )}

      {hasTokens && (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-white/40">Clean up</span>
            {cleanupButton("Remove filler words", fillers.size, fillerCuts, { kind: "words", keys: fillers }, "fillers", "Um, uh, erm, hmm… (speech recognition sometimes leaves these out)")}
            {cleanupButton("Remove repeated words", repeats.size, repeatCuts, { kind: "words", keys: repeats }, "repeats", "Stutters like \"the the\" - keeps the second")}
            <div className="flex items-center gap-1">
              <div className="flex-1 min-w-0">
                {cleanupButton("Shorten long pauses", pauseCuts.length, pauseCuts, { kind: "pauses", min: pauseMin }, "pauses", `Every pause over ${pauseMin}s becomes ${PAUSE_KEEP_SEC}s`)}
              </div>
              <select
                value={pauseMin}
                onChange={(e) => setPauseMin(Number(e.target.value))}
                title="Pauses longer than this"
                className="shrink-0 px-1 py-1.5 rounded bg-white/10 text-[11px] text-white outline-none"
              >
                {PAUSE_OPTIONS.map((s) => (
                  <option key={s} value={s} className="bg-neutral-900">
                    &gt; {s}s
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div
            ref={bodyRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onWheel={() => (lastUserScrollRef.current = Date.now())}
            className="min-h-[160px] max-h-[48vh] overflow-y-auto rounded bg-black/30 px-2.5 py-2 text-[13px] leading-[1.9] text-white/85 outline-none focus:ring-1 focus:ring-blue-400/40 select-none"
          >
            {tokens.map((token, i) => {
              const newClip = i === 0 || tokens[i - 1].clipId !== token.clipId;
              const isSelected = selected.has(token.key);
              const isActive = i === activeIndex;
              const pause = !newClip && token.pauseBefore >= PAUSE_MARK_SEC ? token.pauseBefore : 0;
              return (
                <React.Fragment key={token.key}>
                  {newClip && (
                    <div className={`flex items-center gap-2 text-[9px] uppercase tracking-wide text-white/30 ${i === 0 ? "" : "mt-2"}`}>
                      <span>Clip {token.clipIndex + 1}</span>
                      <span className="flex-1 border-t border-white/10" />
                    </div>
                  )}
                  {pause > 0 && (
                    <button
                      type="button"
                      title={`${pause.toFixed(1)}s pause - click to shorten it to ${PAUSE_KEEP_SEC}s`}
                      onClick={() => onCut(cutsForLongPauses([tokens[i - 1], token], 0, PAUSE_KEEP_SEC))}
                      className={`mx-0.5 inline-flex items-center gap-0.5 px-1 rounded text-[10px] leading-4 align-middle ${
                        isPausePreviewed(token) ? "bg-red-500/30 text-red-200" : "bg-white/10 text-white/45 hover:bg-white/20 hover:text-white/80"
                      }`}
                    >
                      <IoPauseOutline size={9} />
                      {pause.toFixed(1)}s
                    </button>
                  )}
                  <span
                    data-token-index={i}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      bodyRef.current?.focus();
                      draggedRef.current = false;
                      if (e.shiftKey && anchorKeyRef.current) {
                        selectRange(anchorKeyRef.current, token.key);
                        return;
                      }
                      draggingRef.current = true;
                      anchorKeyRef.current = token.key;
                      setSelected(new Set([token.key]));
                    }}
                    onPointerEnter={() => {
                      if (!draggingRef.current || !anchorKeyRef.current) return;
                      draggedRef.current = true;
                      selectRange(anchorKeyRef.current, token.key);
                    }}
                    onClick={(e) => {
                      // A plain click (no drag) also moves the playhead to the word.
                      if (!draggedRef.current && !e.shiftKey) onSeek(token);
                    }}
                    title={`${formatSeconds(token.outputStart)}`}
                    className={`cursor-text rounded-sm px-[1px] ${
                      isSelected
                        ? "bg-blue-500/60 text-white"
                        : isPreviewed(token)
                          ? "bg-red-500/30 text-red-200 line-through"
                          : token.isFiller
                            ? "text-amber-300/80"
                            : ""
                    } ${isActive && !isSelected ? "underline decoration-teal-400 decoration-2 underline-offset-4 text-white" : ""}`}
                  >
                    {token.text}
                  </span>{" "}
                </React.Fragment>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <span className="flex-1 min-w-0 text-[10px] leading-snug text-white/45">
              {selected.size > 0
                ? `${selected.size} word${selected.size === 1 ? "" : "s"} selected · ${formatSeconds(selectionDuration)}`
                : "Click a word to jump to it. Drag or Shift+click to select, then press Delete to cut. Ctrl+Z undoes."}
            </span>
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={cutSelection}
              className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded bg-red-500/80 hover:bg-red-500 text-[11px] font-medium text-white disabled:opacity-30 disabled:hover:bg-red-500/80"
            >
              <IoCutOutline size={12} />
              Cut
            </button>
          </div>
        </>
      )}

      {error && <p className="text-[11px] leading-snug text-red-300 break-words">{error}</p>}
    </div>,
    dockHost ?? document.body
  );
};

export default TranscriptEditorPanel;
