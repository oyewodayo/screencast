// components/captions/useTranscriptGeneration.tsx
//
// Transcribing the timeline's source files with the offline speech engine (generate_caption_words,
// conversion.rs) - shared by the Captions tool (burned-in captions) and the Transcript panel (edit
// by transcript), which both work from the same word-timed transcripts. Owns the progress/model-
// download events, the "an interrupted run can resume" probe, and the error; hands the finished
// batch to `onGenerated` as one undoable step.
import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CaptionWord } from "../../utils/videoEditTypes";
import { trackEvent } from "../../utils/telemetry";

export interface GenerationProgress {
  index: number;
  total: number;
  progress: number;
  downloadingModel: boolean;
}

export function useTranscriptGeneration(options: {
  sourcePaths: string[];
  language: string;
  // Whether a transcript already exists - the resume probe only matters before the first one.
  hasTranscripts: boolean;
  onGenerated: (language: string, transcripts: Record<string, CaptionWord[]>) => void;
  telemetryEvent: string;
}) {
  const { sourcePaths, language, hasTranscripts, onGenerated, telemetryEvent } = options;
  const [generating, setGenerating] = useState<GenerationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // An interrupted generation (app closed mid-way) keeps its finished pieces - generate_caption_words
  // resumes from them. Shown on the button so "Generate" doesn't look like starting over.
  const [resumable, setResumable] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (hasTranscripts || generating) return;
    let cancelled = false;
    Promise.all(
      sourcePaths.map((p) =>
        invoke<{ done: number; total: number } | null>("caption_job_progress", { inputPath: p, language, words: true }).catch(() => null)
      )
    ).then((jobs) => {
      if (cancelled) return;
      const found = jobs.filter((j): j is { done: number; total: number } => !!j);
      setResumable(found.length > 0 ? { done: found.reduce((a, j) => a + j.done, 0), total: found.reduce((a, j) => a + j.total, 0) } : null);
    });
    return () => {
      cancelled = true;
    };
  }, [hasTranscripts, generating, sourcePaths, language]);

  const cancel = () => {
    cancelledRef.current = true;
    void invoke("cancel_transcription").catch(() => {});
  };

  // Transcribes each file in turn (whisper already uses every core but one, so in parallel would
  // only make each slower) and hands the whole batch over as one undoable step.
  const generate = async (paths: string[], lang: string) => {
    if (paths.length === 0 || generating) return;
    cancelledRef.current = false;
    setError(null);
    setGenerating({ index: 0, total: paths.length, progress: 0, downloadingModel: false });
    const unlisten = await listen<number>("captions-progress", (event) => {
      setGenerating((g) => (g ? { ...g, progress: event.payload, downloadingModel: false } : g));
    });
    const unlistenModel = await listen<{ downloaded: number; total: number }>("whisper-model-download", (event) => {
      const { downloaded, total } = event.payload;
      setGenerating((g) => (g ? { ...g, downloadingModel: downloaded < total, progress: downloaded < total ? (downloaded / total) * 100 : 0 } : g));
    });
    try {
      const transcripts: Record<string, CaptionWord[]> = {};
      for (let i = 0; i < paths.length; i++) {
        if (cancelledRef.current) return;
        setGenerating((g) => (g ? { ...g, index: i, progress: 0 } : g));
        // eslint-disable-next-line no-await-in-loop
        transcripts[paths[i]] = await invoke<CaptionWord[]>("generate_caption_words", { inputPath: paths[i], language: lang });
      }
      if (cancelledRef.current) return;
      onGenerated(lang, transcripts);
      trackEvent(telemetryEvent, { language: lang, files: paths.length });
    } catch (err) {
      if (cancelledRef.current || /cancel/i.test(String(err))) return;
      console.error("Transcription failed:", err);
      setError(String(err));
    } finally {
      unlisten();
      unlistenModel();
      setGenerating(null);
    }
  };

  return { generate, cancel, generating, error, setError, resumable };
}

export const GenerationProgressBar: React.FC<{ generating: GenerationProgress; onCancel?: () => void }> = ({ generating, onCancel }) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center justify-between gap-2 text-[10px] text-white/60">
      <span>
        {generating.downloadingModel
          ? "Downloading speech model (one time)…"
          : generating.total > 1
            ? `Transcribing file ${generating.index + 1} of ${generating.total}…`
            : "Transcribing…"}
      </span>
      <span className="flex items-center gap-2 shrink-0">
        <span className="tabular-nums">{Math.round(generating.progress)}%</span>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-white/55 hover:text-red-300 underline-offset-2 hover:underline">
            Cancel
          </button>
        )}
      </span>
    </div>
    <div className="h-1 rounded-full bg-white/10 overflow-hidden">
      <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${generating.progress}%` }} />
    </div>
  </div>
);
