// components/video/VideoToDocModal.tsx
//
// Interactive modal for "Turn into Briefcast Doc": lets the user name the doc, choose whether to
// transcribe offline automatically (if no captions exist yet), capture keyframe chapter
// screenshots, and include the full cleaned transcript — with live step-by-step progress.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { IoCheckmarkCircle, IoClose, IoDocumentTextOutline, IoImagesOutline, IoSparkles } from "react-icons/io5";
import { CAPTIONS_LANGUAGE_OPTIONS } from "../../utils/videoUtils";
import {
  createDocFromVideo,
  humanizeVideoTitle,
  openBriefcastDoc,
  type VideoDocChapter,
  type VideoToDocProgress,
  type VideoTranscriptLine,
} from "../../utils/videoToDoc";
import type { CaptionTrack, CaptionWord, Clip } from "../../utils/videoEditTypes";

interface VideoToDocModalProps {
  sourceVideoPath: string;
  fileName: string;
  durationSec: number;
  clips?: Clip[];
  captions?: CaptionTrack | null;
  sourcePaths?: string[];
  chapters?: VideoDocChapter[];
  lines?: VideoTranscriptLine[];
  watchUrl?: string | null;
  onTranscriptGenerated?: (language: string, transcripts: Record<string, CaptionWord[]>) => void;
  onClose: () => void;
}

const VideoToDocModal: React.FC<VideoToDocModalProps> = ({
  sourceVideoPath,
  fileName,
  durationSec,
  clips,
  captions,
  sourcePaths,
  chapters = [],
  lines = [],
  watchUrl,
  onTranscriptGenerated,
  onClose,
}) => {
  const [title, setTitle] = useState(() => humanizeVideoTitle(fileName));
  const [language, setLanguage] = useState<string>(captions?.language ?? "auto");
  const [autoTranscribe, setAutoTranscribe] = useState(true);
  const [captureScreenshots, setCaptureScreenshots] = useState(true);
  const [includeTranscript, setIncludeTranscript] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<VideoToDocProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const hasTranscript = lines.length > 0;
  const wordCount = lines.reduce((sum, l) => sum + l.text.trim().split(/\s+/).filter(Boolean).length, 0);

  const handleCancel = () => {
    if (busy) {
      abortRef.current?.abort();
      void invoke("cancel_transcription").catch(() => {});
      setBusy(false);
      setProgress(null);
      return;
    }
    onClose();
  };

  const handleSkipTranscription = () => {
    void invoke("cancel_transcription").catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const handleGenerate = async () => {
    if (busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setProgress({ stage: "analyzing", label: "Starting…", percent: null });
    try {
      const result = await createDocFromVideo(sourceVideoPath, {
        fileName,
        title: title.trim() || humanizeVideoTitle(fileName),
        durationSec,
        clips,
        captions,
        sourcePaths,
        chapters,
        lines,
        watchUrl,
        autoTranscribe: !hasTranscript && autoTranscribe,
        language,
        captureScreenshots,
        includeTranscript,
        signal: controller.signal,
        onProgress: setProgress,
        onTranscriptGenerated,
      });
      if (controller.signal.aborted) return;
      openBriefcastDoc(result.id);
      onClose();
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      setProgress(null);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/55 backdrop-blur-xs"
      onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="w-[440px] max-w-[94vw] rounded-2xl bg-neutral-900 ring-1 ring-white/10 shadow-2xl text-white/90 p-5 flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <span className="h-8 w-8 rounded-lg bg-emerald-500/15 text-emerald-300 flex items-center justify-center shrink-0">
            <IoDocumentTextOutline size={18} />
          </span>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-white">Turn video into Briefcast Doc</h2>
            <p className="text-[11px] text-white/50 truncate" title={fileName}>
              {fileName}
            </p>
          </div>
          <button
            type="button"
            title="Close"
            disabled={busy}
            onClick={onClose}
            className="p-1 rounded-md text-white/55 hover:text-white hover:bg-white/10 disabled:opacity-30"
          >
            <IoClose size={16} />
          </button>
        </div>

        <label className="flex flex-col gap-1 text-[11px] text-white/60">
          Document title
          <input
            type="text"
            value={title}
            disabled={busy}
            maxLength={140}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-lg bg-white/[0.07] px-3 py-2 text-xs text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400/60"
          />
        </label>

        {/* Transcript readiness status */}
        <div className="rounded-xl bg-white/[0.04] p-3 flex flex-col gap-2">
          {hasTranscript ? (
            <div className="flex items-center gap-2 text-xs text-emerald-300">
              <IoCheckmarkCircle size={15} className="shrink-0" />
              <span>Transcript ready ({wordCount.toLocaleString()} words) — summary &amp; chapters will be extracted automatically.</span>
            </div>
          ) : (
            <>
              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoTranscribe}
                  disabled={busy}
                  onChange={(e) => setAutoTranscribe(e.target.checked)}
                  className="mt-0.5 accent-emerald-400"
                />
                <span className="flex-1">
                  <span className="font-medium text-white/90">Transcribe speech offline first</span>
                  <span className="block text-[11px] text-white/50">
                    Runs Briefcast's offline speech engine to build a real summary, auto-detected chapters, key takeaways &amp; transcript.
                  </span>
                </span>
              </label>
              {autoTranscribe && (
                <div className="flex items-center gap-2 pl-5 text-[11px]">
                  <span className="text-white/55 shrink-0">Speech language</span>
                  <select
                    value={language}
                    disabled={busy}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="flex-1 min-w-0 rounded-md bg-white/10 px-2 py-1 text-[11px] text-white outline-none"
                  >
                    {CAPTIONS_LANGUAGE_OPTIONS.map(([code, name]) => (
                      <option key={code} value={code} className="bg-neutral-900">
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={captureScreenshots}
              disabled={busy}
              onChange={(e) => setCaptureScreenshots(e.target.checked)}
              className="mt-0.5 accent-emerald-400"
            />
            <span className="flex-1">
              <span className="flex items-center gap-1.5 font-medium text-white/90">
                <IoImagesOutline size={13} className="text-emerald-300" />
                Embed video screenshots at each chapter
              </span>
              <span className="block text-[11px] text-white/50">Captures still frames from key moments directly into the document.</span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={includeTranscript}
              disabled={busy || (!hasTranscript && !autoTranscribe)}
              onChange={(e) => setIncludeTranscript(e.target.checked)}
              className="mt-0.5 accent-emerald-400"
            />
            <span className="flex-1">
              <span className="font-medium text-white/90">Include full cleaned transcript</span>
              <span className="block text-[11px] text-white/50">Grouped into readable paragraphs under each chapter heading.</span>
            </span>
          </label>
        </div>

        {busy && progress && (
          <div className="rounded-xl bg-white/[0.05] p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[11px] text-white/75">
              <span>{progress.label}</span>
              {progress.percent !== null && <span className="tabular-nums">{Math.round(progress.percent)}%</span>}
            </div>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className={`h-full bg-emerald-500 transition-[width] duration-300 ${progress.percent === null ? "w-1/2 animate-pulse" : ""}`}
                style={progress.percent !== null ? { width: `${Math.max(4, Math.min(100, progress.percent))}%` } : undefined}
              />
            </div>
            {(progress.stage === "transcribing" || progress.stage === "downloading-model") && captureScreenshots && (
              <button
                type="button"
                onClick={handleSkipTranscription}
                className="self-end text-[10.5px] text-white/55 hover:text-emerald-300 underline-offset-2 hover:underline"
              >
                Skip transcription &amp; build visual doc now
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-950/60 ring-1 ring-red-800 px-3 py-2 text-[11px] text-red-200 break-words">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={handleCancel}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white/70 hover:text-white hover:bg-white/10"
          >
            {busy ? "Stop & Cancel" : "Cancel"}
          </button>
          <button
            type="button"
            disabled={busy || !title.trim()}
            onClick={() => void handleGenerate()}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold disabled:opacity-40 transition-colors"
          >
            <IoSparkles size={13} />
            {busy ? "Generating…" : !hasTranscript && autoTranscribe ? "Transcribe & Create Doc" : "Create Briefcast Doc"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default VideoToDocModal;
