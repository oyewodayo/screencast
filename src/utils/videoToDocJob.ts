// utils/videoToDocJob.ts
//
// Global singleton background runner for "Turn video into Briefcast Doc".
// Living outside VideoToDocModal means minimizing the modal — or even switching videos, opening
// another doc, or returning Home — never cancels or loses an in-progress transcription/doc build.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  createDocFromVideo,
  humanizeVideoTitle,
  openBriefcastDoc,
  type CreateDocFromVideoOptions,
  type VideoToDocProgress,
} from "./videoToDoc";

export interface VideoToDocJobResult {
  id: string;
  title: string;
  wordCount: number;
  chapterCount: number;
  screenshotCount: number;
}

export interface VideoToDocJobState {
  id: string;
  sourceVideoPath: string;
  title: string;
  status: "running" | "done" | "error";
  minimized: boolean;
  captureScreenshots: boolean;
  progress: VideoToDocProgress | null;
  result?: VideoToDocJobResult;
  error?: string;
}

let currentJob: VideoToDocJobState | null = null;
let currentAbort: AbortController | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setJob(next: VideoToDocJobState | null) {
  currentJob = next;
  emit();
}

export function getVideoToDocJob(): VideoToDocJobState | null {
  return currentJob;
}

export function subscribeVideoToDocJob(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useVideoToDocJob(): VideoToDocJobState | null {
  return useSyncExternalStore(subscribeVideoToDocJob, getVideoToDocJob, getVideoToDocJob);
}

export function minimizeVideoToDocJob(): void {
  if (!currentJob) return;
  setJob({ ...currentJob, minimized: true });
}

export function expandVideoToDocJob(): void {
  if (!currentJob) return;
  setJob({ ...currentJob, minimized: false });
}

export function skipVideoToDocTranscription(): void {
  void invoke("cancel_transcription").catch(() => {});
}

export function cancelVideoToDocJob(): void {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
  void invoke("cancel_transcription").catch(() => {});
  setJob(null);
}

export function dismissVideoToDocJob(): void {
  if (currentJob?.status === "running") return;
  setJob(null);
}

export async function startVideoToDocJob(
  sourceVideoPath: string,
  options: CreateDocFromVideoOptions,
  callbacks?: { onFinishedWhileOpen?: () => void }
): Promise<void> {
  if (currentJob?.status === "running") return;
  const controller = new AbortController();
  currentAbort = controller;
  const jobId = crypto.randomUUID();
  const title = (options.title?.trim() || humanizeVideoTitle(options.fileName)).slice(0, 140);

  setJob({
    id: jobId,
    sourceVideoPath,
    title,
    status: "running",
    minimized: false,
    captureScreenshots: options.captureScreenshots !== false,
    progress: { stage: "analyzing", label: "Starting…", percent: null },
  });

  try {
    const result = await createDocFromVideo(sourceVideoPath, {
      ...options,
      title,
      signal: controller.signal,
      onProgress: (progress) => {
        if (controller.signal.aborted || currentJob?.id !== jobId) return;
        setJob({ ...currentJob, progress });
      },
    });
    if (controller.signal.aborted || currentJob?.id !== jobId) return;
    const wasMinimized = currentJob.minimized;
    if (wasMinimized) {
      setJob({
        ...currentJob,
        status: "done",
        progress: { stage: "saving", label: "Briefcast Doc ready", percent: 100 },
        result,
      });
    } else {
      setJob(null);
      openBriefcastDoc(result.id);
      callbacks?.onFinishedWhileOpen?.();
    }
  } catch (err) {
    if (controller.signal.aborted || currentJob?.id !== jobId) return;
    setJob({
      ...currentJob,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (currentAbort === controller) currentAbort = null;
  }
}
