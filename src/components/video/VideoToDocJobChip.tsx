// components/video/VideoToDocJobChip.tsx
//
// Floating top-right progress / completion card shown whenever a "Turn video into Briefcast Doc"
// job is minimized to run in the background (mounted once in Dashboard's notification stack).
import React from "react";
import { IoAlertCircle, IoCheckmarkCircle, IoClose, IoDocumentTextOutline, IoOpenOutline } from "react-icons/io5";
import { openBriefcastDoc } from "../../utils/videoToDoc";
import {
  cancelVideoToDocJob,
  dismissVideoToDocJob,
  skipVideoToDocTranscription,
  useVideoToDocJob,
} from "../../utils/videoToDocJob";

const VideoToDocJobChip: React.FC = () => {
  const job = useVideoToDocJob();
  if (!job || !job.minimized) return null;

  const isRunning = job.status === "running";
  const isDone = job.status === "done" && !!job.result;
  const isError = job.status === "error";
  const pct = job.progress?.percent ?? null;
  const canSkipSpeech =
    isRunning &&
    job.captureScreenshots &&
    (job.progress?.stage === "transcribing" || job.progress?.stage === "downloading-model");

  return (
    <div className="w-[310px] max-w-[calc(100vw-2rem)] rounded-xl bg-neutral-900/95 backdrop-blur-md text-white/90 shadow-2xl ring-1 ring-white/12 p-3 flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 h-6 w-6 rounded-md flex items-center justify-center shrink-0 ${
            isError
              ? "bg-red-500/20 text-red-300"
              : isDone
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-emerald-500/15 text-emerald-300 animate-pulse"
          }`}
        >
          {isError ? (
            <IoAlertCircle size={15} />
          ) : isDone ? (
            <IoCheckmarkCircle size={15} />
          ) : (
            <IoDocumentTextOutline size={14} />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[11.5px] font-semibold text-white truncate" title={job.title}>
            {isDone ? "Briefcast Doc ready" : isError ? "Doc generation failed" : "Creating Briefcast Doc"}
          </div>
          <div className="text-[10.5px] text-white/55 truncate" title={job.title}>
            {job.title}
          </div>
        </div>
        <button
          type="button"
          title={isRunning ? "Stop & cancel" : "Dismiss"}
          onClick={() => (isRunning ? cancelVideoToDocJob() : dismissVideoToDocJob())}
          className="p-1 rounded-md text-white/45 hover:text-white hover:bg-white/10 transition-colors shrink-0"
        >
          <IoClose size={14} />
        </button>
      </div>

      {isRunning && job.progress && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-[10.5px] text-white/70">
            <span className="truncate">{job.progress.label}</span>
            {pct !== null && <span className="tabular-nums shrink-0">{Math.round(pct)}%</span>}
          </div>
          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className={`h-full bg-emerald-500 transition-[width] duration-300 ${pct === null ? "w-1/2 animate-pulse" : ""}`}
              style={pct !== null ? { width: `${Math.max(4, Math.min(100, pct))}%` } : undefined}
            />
          </div>
          <div className="flex items-center justify-between gap-2 pt-0.5">
            {canSkipSpeech ? (
              <button
                type="button"
                onClick={skipVideoToDocTranscription}
                className="text-[10px] text-white/55 hover:text-emerald-300 underline-offset-2 hover:underline"
              >
                Skip speech &amp; build visual doc
              </button>
            ) : (
              <span className="text-[10px] text-white/40">Running in background…</span>
            )}
            <button
              type="button"
              onClick={cancelVideoToDocJob}
              className="text-[10px] text-white/50 hover:text-red-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isDone && job.result && (
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span className="text-[10.5px] text-white/55 truncate">
            {job.result.wordCount.toLocaleString()} words
            {job.result.screenshotCount > 0 ? ` · ${job.result.screenshotCount} shots` : ""}
          </span>
          <button
            type="button"
            onClick={() => {
              const id = job.result!.id;
              dismissVideoToDocJob();
              openBriefcastDoc(id);
            }}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1 shrink-0 transition-colors"
          >
            <IoOpenOutline size={12} />
            Open Doc
          </button>
        </div>
      )}

      {isError && job.error && (
        <p className="text-[10.5px] text-red-300 leading-snug break-words">{job.error}</p>
      )}
    </div>
  );
};

export default VideoToDocJobChip;
