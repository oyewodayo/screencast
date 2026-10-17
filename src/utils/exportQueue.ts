// utils/exportQueue.ts
//
// The background export queue: Save snapshots the timeline into a job (prepareExport,
// useVideoEditStore.ts - every overlay already rendered, every setting fixed) and goes straight
// back to editing while jobs render one after another. Each job runs export_trimmed_video with
// its own id, which gives it (conversion.rs) its own cancel state, progress events keyed
// "export-job:<id>", a live preview frame of what it's rendering (export-job-preview) and a
// below-normal CPU priority so the editor stays smooth meanwhile.
//
// Module-level so the queue outlives whichever file is open: switch files, open a doc, come back -
// the jobs keep going. React reads it through useExportQueue (useSyncExternalStore).

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export interface ExportJobPayload {
  // export_trimmed_video's arguments, minus jobId.
  args: Record<string, unknown>;
  sourcePath: string;
  durationSec: number;
  share: ShareMeta;
}

// What sharing a finished export starts from (SharePanel): taken from the timeline when it was
// exported, so it matches the file whatever has been edited since.
export interface ShareMeta {
  title: string;
  // Output seconds, as embedded in the file.
  chapters: { time: number; label: string }[];
  // The captions as .srt, when the timeline had any.
  srt: string | null;
  language: string | null;
}

export type ExportJobStatus = "queued" | "rendering" | "done" | "failed" | "cancelled";

export interface ExportJob {
  id: string;
  title: string;
  // e.g. "9:16 · High" - what makes this job different from another export of the same video.
  detail: string;
  sourcePath: string;
  durationSec: number;
  status: ExportJobStatus;
  progress: number; // 0..100
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  etaSec?: number;
  previewUrl?: string;
  resultPath?: string;
  error?: string;
  share: ShareMeta;
}

interface Entry {
  job: ExportJob;
  // Kept until the job succeeds, so a failed or cancelled one can be retried as it was.
  payload: ExportJobPayload | null;
  cancelRequested: boolean;
}

let entries: Entry[] = [];
let snapshot: ExportJob[] = [];
const listeners = new Set<() => void>();
const finishedListeners = new Set<(job: ExportJob) => void>();

function emit() {
  snapshot = entries.map((e) => e.job);
  listeners.forEach((l) => l());
}

function patch(id: string, p: Partial<ExportJob>) {
  const e = entries.find((x) => x.job.id === id);
  if (!e) return;
  e.job = { ...e.job, ...p };
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getJobs = (): ExportJob[] => snapshot;

export function useExportQueue(): ExportJob[] {
  return useSyncExternalStore(subscribe, getJobs, getJobs);
}

// Called with each job that finishes successfully (Dashboard refreshes the library then).
export function onJobFinished(fn: (job: ExportJob) => void): () => void {
  finishedListeners.add(fn);
  return () => finishedListeners.delete(fn);
}

export const isActive = (job: ExportJob) => job.status === "queued" || job.status === "rendering";
export const hasActiveJobs = () => entries.some((e) => isActive(e.job));

export function enqueue(payload: ExportJobPayload, title: string, detail: string): string {
  ensureListeners();
  const id = crypto.randomUUID();
  entries = [...entries, { job: { id, title, detail, sourcePath: payload.sourcePath, durationSec: payload.durationSec, status: "queued", progress: 0, createdAt: Date.now(), share: payload.share }, payload, cancelRequested: false }];
  emit();
  void pump();
  return id;
}

export async function cancel(id: string) {
  const e = entries.find((x) => x.job.id === id);
  if (!e) return;
  if (e.job.status === "queued") {
    patch(id, { status: "cancelled", finishedAt: Date.now() });
    return;
  }
  if (e.job.status === "rendering") {
    e.cancelRequested = true;
    await invoke("cancel_export_job", { jobId: id }).catch((err) => console.error("Couldn't cancel the export:", err));
  }
}

export async function cancelAll() {
  await Promise.all(entries.filter((e) => isActive(e.job)).map((e) => cancel(e.job.id)));
}

export function remove(id: string) {
  const e = entries.find((x) => x.job.id === id);
  if (!e || isActive(e.job)) return;
  entries = entries.filter((x) => x !== e);
  emit();
}

export function clearFinished() {
  entries = entries.filter((e) => isActive(e.job));
  emit();
}

export function retry(id: string) {
  const e = entries.find((x) => x.job.id === id);
  if (!e || !e.payload || isActive(e.job)) return;
  e.cancelRequested = false;
  e.job = { ...e.job, status: "queued", progress: 0, error: undefined, etaSec: undefined, startedAt: undefined, finishedAt: undefined, previewUrl: undefined };
  emit();
  void pump();
}

let running = false;
async function pump() {
  if (running) return;
  const next = entries.find((e) => e.job.status === "queued");
  if (!next || !next.payload) return;
  running = true;
  const id = next.job.id;
  patch(id, { status: "rendering", startedAt: Date.now(), progress: 0 });
  try {
    const resultPath = await invoke<string>("export_trimmed_video", { ...next.payload.args, jobId: id });
    patch(id, { status: "done", progress: 100, resultPath, finishedAt: Date.now(), etaSec: 0 });
    next.payload = null;
    const job = entries.find((e) => e.job.id === id)?.job;
    if (job) finishedListeners.forEach((fn) => fn(job));
  } catch (err) {
    const cancelled = entries.find((e) => e.job.id === id)?.cancelRequested;
    patch(id, { status: cancelled ? "cancelled" : "failed", error: cancelled ? undefined : err instanceof Error ? err.message : String(err), finishedAt: Date.now() });
  } finally {
    running = false;
    void pump();
  }
}

// Progress and preview frames arrive as events for whichever job is rendering.
let listening = false;
function ensureListeners() {
  if (listening) return;
  listening = true;
  void listen<{ input_path: string; progress: number; status: string }>("conversion-progress", (event) => {
    const key = event.payload.input_path;
    if (!key.startsWith("export-job:")) return;
    const id = key.slice("export-job:".length);
    const e = entries.find((x) => x.job.id === id);
    if (!e || e.job.status !== "rendering") return;
    const progress = Math.max(e.job.progress, Math.min(99.5, event.payload.progress));
    const elapsed = (Date.now() - (e.job.startedAt ?? Date.now())) / 1000;
    // Time left from the rate so far, smoothed so it doesn't jitter second to second.
    let etaSec = e.job.etaSec;
    if (progress > 2 && elapsed > 2) {
      const raw = (elapsed * (100 - progress)) / progress;
      etaSec = etaSec === undefined ? raw : etaSec * 0.8 + raw * 0.2;
    }
    patch(id, { progress, etaSec });
  });
  void listen<{ jobId: string; dataUrl: string }>("export-job-preview", (event) => {
    const e = entries.find((x) => x.job.id === event.payload.jobId);
    if (e && e.job.status === "rendering") patch(e.job.id, { previewUrl: event.payload.dataUrl });
  });
}

// Closing the app mid-export would kill the render and leave a broken file. The video editor's own
// close guard asks about this itself (and saves the timeline); everywhere else this one does.
let editorGuards = 0;
export function setEditorCloseGuard(active: boolean) {
  editorGuards = Math.max(0, editorGuards + (active ? 1 : -1));
}

export async function confirmCloseWithActiveExports(): Promise<boolean> {
  if (!hasActiveJobs()) return true;
  const n = entries.filter((e) => isActive(e.job)).length;
  const ok = await ask(`${n === 1 ? "An export is" : `${n} exports are`} still rendering. Closing now cancels ${n === 1 ? "it" : "them"} and leaves no file behind.`, {
    title: "Exports in progress",
    kind: "warning",
    okLabel: "Cancel exports and close",
    cancelLabel: "Keep Briefcast open",
  });
  if (ok) await cancelAll();
  return ok;
}

let globalGuardInstalled = false;
export function installGlobalCloseGuard() {
  if (globalGuardInstalled) return;
  globalGuardInstalled = true;
  const appWindow = getCurrentWebviewWindow();
  let closing = false;
  void appWindow.onCloseRequested(async (event) => {
    if (closing || editorGuards > 0 || !hasActiveJobs()) return;
    event.preventDefault();
    if (await confirmCloseWithActiveExports()) {
      closing = true;
      await appWindow.close();
    }
  });
}

// "4:12" / "1:02:09" / "<1 min"-style countdown text.
export function formatEta(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return "";
  if (sec < 1) return "almost done";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return `${h > 0 ? `${h}:${String(m).padStart(2, "0")}` : m}:${r} left`;
}
