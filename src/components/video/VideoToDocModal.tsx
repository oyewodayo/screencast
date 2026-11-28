// components/video/VideoToDocModal.tsx
//
// Interactive modal for "Turn into Briefcast Doc": lets the user name the doc, choose whether to
// transcribe offline automatically (if no captions exist yet), capture keyframe chapter
// screenshots, and include the full cleaned transcript — with live step-by-step progress AND
// Minimize-to-background support via videoToDocJob.ts so long videos never block your workflow.
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IoCheckmarkCircle, IoClose, IoDocumentTextOutline, IoImagesOutline, IoRemove, IoSparkles } from "react-icons/io5";
import { CAPTIONS_LANGUAGE_OPTIONS } from "../../utils/videoUtils";
import {
  humanizeVideoTitle,
  type VideoDocChapter,
  type VideoTranscriptLine,
} from "../../utils/videoToDoc";
import {
  cancelVideoToDocJob,
  dismissVideoToDocJob,
  expandVideoToDocJob,
  minimizeVideoToDocJob,
  skipVideoToDocTranscription,
  startVideoToDocJob,
  useVideoToDocJob,
} from "../../utils/videoToDocJob";
import type { CaptionTrack, CaptionWord, Clip } from "../../utils/videoEditTypes";
import { loadStudyNotes, type StudyNote } from "../../utils/videoStudyNotes";

interface VideoToDocModalProps {
  sourceVideoPath: string;
  fileName: string;
  durationSec: number;
  clips?: Clip[];
  captions?: CaptionTrack | null;
  sourcePaths?: string[];
  chapters?: VideoDocChapter[];
  lines?: VideoTranscriptLine[];
  studyNotes?: StudyNote[];
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
  studyNotes: initialStudyNotes,
  watchUrl,
  onTranscriptGenerated,
  onClose,
}) => {
  const [title, setTitle] = useState(() => humanizeVideoTitle(fileName));
  const [language, setLanguage] = useState<string>(captions?.language ?? "auto");
  const [autoTranscribe, setAutoTranscribe] = useState(true);
  const [captureScreenshots, setCaptureScreenshots] = useState(true);
  const [includeTranscript, setIncludeTranscript] = useState(true);
  const [resolvedStudyNotes, setResolvedStudyNotes] = useState<StudyNote[]>(initialStudyNotes ?? []);

  const job = useVideoToDocJob();
  const busy = job?.status === "running";
  const progress = busy ? job.progress : null;
  const error = job?.status === "error" ? job.error ?? null : null;

  // If the user re-opens this modal while a job is already running in the background, bring it back
  // into expanded view so the modal owns its progress display cleanly.
  useEffect(() => {
    if (job?.status === "running" && job.minimized) {
      expandVideoToDocJob();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialStudyNotes && initialStudyNotes.length > 0) {
      setResolvedStudyNotes(initialStudyNotes);
      return;
    }
    let cancelled = false;
    void loadStudyNotes(sourceVideoPath).then((sidecar) => {
      if (!cancelled) setResolvedStudyNotes(sidecar.notes);
    });
    return () => {
      cancelled = true;
    };
  }, [sourceVideoPath, initialStudyNotes]);

  const hasTranscript = lines.length > 0;
  const wordCount = lines.reduce((sum, l) => sum + l.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const slideSnapCount = resolvedStudyNotes.filter((n) => !!n.snapshotDataUrl).length;

  const handleMinimize = () => {
    if (busy) {
      minimizeVideoToDocJob();
    }
    onClose();
  };

  const handleCancel = () => {
    if (busy) {
      cancelVideoToDocJob();
      return;
    }
    if (job?.status === "error") dismissVideoToDocJob();
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (busy) handleMinimize();
        else handleCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, onClose]);

  const handleGenerate = () => {
    if (busy) return;
    void startVideoToDocJob(
      sourceVideoPath,
      {
        fileName,
        title: title.trim() || humanizeVideoTitle(fileName),
        durationSec,
        clips,
        captions,
        sourcePaths,
        chapters,
        lines,
        studyNotes: resolvedStudyNotes,
        watchUrl,
        autoTranscribe: !hasTranscript && autoTranscribe,
        language,
        captureScreenshots,
        includeTranscript,
        onTranscriptGenerated,
      },
      { onFinishedWhileOpen: onClose }
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/55 backdrop-blur-xs"
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (busy) handleMinimize();
        else handleCancel();
      }}
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
          {busy && (
            <button
              type="button"
              title="Minimize and keep running in the background"
              onClick={handleMinimize}
              className="p-1 rounded-md text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            >
              <IoRemove size={16} />
            </button>
          )}
          <button
            type="button"
            title={busy ? "Minimize to background" : "Close"}
            onClick={busy ? handleMinimize : handleCancel}
            className="p-1 rounded-md text-white/55 hover:text-white hover:bg-white/10 transition-colors"
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

        {/* Study notes readiness badge (if notes exist from Study Mode) */}
        {resolvedStudyNotes.length > 0 && (
          <div className="rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/25 px-3 py-2 flex items-center gap-2 text-xs text-emerald-200">
            <IoCheckmarkCircle size={15} className="shrink-0 text-emerald-400" />
            <span>
              <strong>{resolvedStudyNotes.length}</strong> study {resolvedStudyNotes.length === 1 ? "note" : "notes"}
              {slideSnapCount > 0 ? ` & ${slideSnapCount} captured ${slideSnapCount === 1 ? "slide" : "slides"}` : ""} will be embedded at the top of your Doc.
            </span>
          </div>
        )}

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
            {(progress.stage === "transcribing" || progress.stage === "downloading-model") && (job?.captureScreenshots ?? captureScreenshots) && (
              <button
                type="button"
                onClick={skipVideoToDocTranscription}
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
          {busy ? (
            <button
              type="button"
              onClick={handleMinimize}
              title="Close this popup and let the doc finish in the background"
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-semibold transition-colors"
            >
              <IoRemove size={14} />
              Run in background
            </button>
          ) : (
            <button
              type="button"
              disabled={!title.trim()}
              onClick={handleGenerate}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold disabled:opacity-40 transition-colors"
            >
              <IoSparkles size={13} />
              {!hasTranscript && autoTranscribe ? "Transcribe & Create Doc" : "Create Briefcast Doc"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default VideoToDocModal;
