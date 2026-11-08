// utils/backgroundRemoval.ts
//
// "Remove background" on a video-track layer: the first time, the engine downloads (~40 MB, once);
// then the person is cut out of the layer's video (remove_video_background, background_removal.rs)
// into a derived video with transparency, which the layer then shows instead of its source - in
// the preview and the export alike (PipOverlay.cutout).
//
// Jobs can take minutes, so they live here rather than in a panel: closing the panel or selecting
// something else leaves them running, and the layer picks the result up when it's done.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClipCrop } from "./videoEditTypes";

export type BackgroundJob =
  | { phase: "download"; progress: number }
  | { phase: "cutting"; progress: number }
  | { phase: "error"; message: string };

let jobs: ReadonlyMap<string, BackgroundJob> = new Map();
const listeners = new Set<() => void>();
const setJob = (id: string, job: BackgroundJob | null) => {
  const next = new Map(jobs);
  if (job) next.set(id, job);
  else next.delete(id);
  jobs = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useBackgroundJob = (layerId: string): BackgroundJob | undefined => useSyncExternalStore(subscribe, () => jobs.get(layerId));

export interface BackgroundRemovalStatus {
  state: "ready" | "needs-download" | "unsupported";
  downloadMb: number;
}

export const backgroundRemovalStatus = (): Promise<BackgroundRemovalStatus> => invoke<BackgroundRemovalStatus>("background_removal_status");

const CANCELLED = ["BACKGROUND_REMOVAL_CANCELLED", "BACKGROUND_REMOVAL_DOWNLOAD_CANCELLED"];
const cancelled = new Set<string>();

async function downloadEngine(layerId: string) {
  setJob(layerId, { phase: "download", progress: 0 });
  const unlisten = await listen<{ downloaded: number; total: number }>("background-removal-download", (e) => {
    if (jobs.get(layerId)?.phase === "download") setJob(layerId, { phase: "download", progress: e.payload.total > 0 ? e.payload.downloaded / e.payload.total : 0 });
  });
  try {
    await invoke("download_background_removal");
  } finally {
    unlisten();
  }
}

// Fetches the background-removal engine (once) on its own - for the live camera background, which
// needs it before anything is recorded. `onProgress` gets 0..1.
export async function downloadBackgroundEngine(onProgress: (fraction: number) => void): Promise<void> {
  const unlisten = await listen<{ downloaded: number; total: number }>("background-removal-download", (e) => onProgress(e.payload.total > 0 ? e.payload.downloaded / e.payload.total : 0));
  try {
    await invoke("download_background_removal");
  } finally {
    unlisten();
  }
}

// Cuts the person out of `sourcePath` - or out of just `region` of it - for layer `layerId`;
// `onDone` gets the cut-out's path.
export async function removeBackground(layerId: string, sourcePath: string, onDone: (cutoutPath: string) => void, region?: ClipCrop): Promise<void> {
  if (jobs.get(layerId) && jobs.get(layerId)!.phase !== "error") return;
  cancelled.delete(layerId);
  try {
    const status = await backgroundRemovalStatus();
    if (status.state === "unsupported") throw new Error("Background removal isn't available on this computer yet.");
    if (status.state === "needs-download") await downloadEngine(layerId);
    if (cancelled.has(layerId)) return;
    setJob(layerId, { phase: "cutting", progress: 0 });
    const unlisten = await listen<{ jobId: string; progress: number }>("background-removal-progress", (e) => {
      if (e.payload.jobId === layerId) setJob(layerId, { phase: "cutting", progress: e.payload.progress });
    });
    let path: string;
    try {
      path = await invoke<string>("remove_video_background", { sourcePath, jobId: layerId, region: region ?? null });
    } catch (err) {
      // The engine went missing since the status check - fetch it and go again, once.
      if (String(err).includes("ENGINE_MISSING")) {
        await downloadEngine(layerId);
        setJob(layerId, { phase: "cutting", progress: 0 });
        path = await invoke<string>("remove_video_background", { sourcePath, jobId: layerId, region: region ?? null });
      } else {
        throw err;
      }
    } finally {
      unlisten();
    }
    setJob(layerId, null);
    onDone(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (CANCELLED.some((c) => message.includes(c)) || cancelled.has(layerId)) setJob(layerId, null);
    else setJob(layerId, { phase: "error", message });
  }
}

export function cancelBackgroundRemoval(layerId: string) {
  const job = jobs.get(layerId);
  cancelled.add(layerId);
  if (job?.phase === "download") void invoke("cancel_background_removal_download");
  else if (job?.phase === "cutting") void invoke("cancel_background_removal", { jobId: layerId });
  else setJob(layerId, null);
}

export const dismissBackgroundError = (layerId: string) => setJob(layerId, null);
