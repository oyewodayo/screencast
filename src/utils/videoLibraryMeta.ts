// utils/videoLibraryMeta.ts
//
// What the Video Editor's home shows about each video beyond its name: how long it is, its shape,
// and - for one edited before - what the edit holds (its sidecar, useVideoEditStore's saved state):
// how long it now runs, its split screens, titles, captions and canvas, and when it was last
// touched. Read lazily (a tile asks once it's on screen), one at a time per kind through the
// shared limiter, and remembered per file version (path + size + modified) - in memory, and the
// cheap parts (duration, shape) on disk too, so the grid fills in at once on the next visit.
import { invoke } from "@tauri-apps/api/core";
import { thumbnailLimiter } from "./concurrencyLimiter";
import { clipOutputDuration } from "./clipTiming";
import { canvasPreset } from "./canvasFormats";
import type { VideoEditState } from "./videoEditTypes";

export interface VideoProbe {
  duration: number | null;
  width: number | null;
  height: number | null;
}

export interface EditSummary {
  // Seconds the edit runs for, and the source it was made from.
  outputDuration: number;
  sourceDuration: number;
  clips: number;
  splitScreens: number;
  titles: number;
  layers: number;
  captions: boolean;
  // The canvas's name ("TikTok · Reels · Shorts", "iPhone 17"...) and shape, when one was chosen.
  canvasLabel: string | null;
  canvasAspect: number | null;
  // ms since epoch.
  updatedAt: number | null;
}

interface FileVersion {
  path: string;
  size: number;
  modified?: number;
}

const versionKey = (f: FileVersion) => `${f.path}|${f.size}|${f.modified ?? 0}`;

const PROBE_STORE = "briefcast.videoProbe.v1";
const probeDisk: Record<string, VideoProbe> = (() => {
  try {
    return JSON.parse(localStorage.getItem(PROBE_STORE) ?? "{}");
  } catch {
    return {};
  }
})();
let saveTimer = 0;
const persistProbes = () => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      // Keep the newest few thousand - an entry is a few dozen bytes.
      const entries = Object.entries(probeDisk).slice(-3000);
      localStorage.setItem(PROBE_STORE, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // Not remembered across visits - still shown this time.
    }
  }, 800);
};

const probes = new Map<string, Promise<VideoProbe>>();
export function probeVideo(file: FileVersion): Promise<VideoProbe> {
  const key = versionKey(file);
  const known = probeDisk[key];
  if (known) return Promise.resolve(known);
  let pending = probes.get(key);
  if (!pending) {
    pending = thumbnailLimiter(() => invoke<Record<string, string>>("get_conversion_info", { inputPath: file.path })).then((info) => {
      const seconds = parseFloat(info.duration?.match(/[\d.]+/)?.[0] ?? "");
      const size = info.resolution?.match(/^(\d+)x(\d+)$/);
      const probe: VideoProbe = {
        duration: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
      };
      probeDisk[key] = probe;
      persistProbes();
      return probe;
    });
    pending.catch(() => probes.delete(key));
    probes.set(key, pending);
  }
  return pending;
}

// Edits change while the app runs, so these are kept per session and re-read when asked to.
const summaries = new Map<string, Promise<EditSummary | null>>();
export function readEditSummary(path: string, fresh = false): Promise<EditSummary | null> {
  let pending = fresh ? undefined : summaries.get(path);
  if (!pending) {
    pending = thumbnailLimiter(() => invoke<string | null>("load_video_edit_state", { videoPath: path })).then((json) => (json ? summarize(JSON.parse(json)) : null));
    pending.catch(() => summaries.delete(path));
    summaries.set(path, pending);
  }
  return pending;
}

function summarize(state: Partial<VideoEditState>): EditSummary | null {
  const clips = state.clips ?? [];
  if (clips.length === 0 && !(state.scenes?.length || state.audioOverlays?.length)) return null;
  const groups = new Set([...(state.pipOverlays ?? []), ...(state.imageOverlays ?? [])].flatMap((o) => (o.split ? [o.split.group] : [])));
  const canvas = state.canvas ?? null;
  const updated = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
  return {
    outputDuration: clips.reduce((sum, c) => sum + clipOutputDuration(c), 0),
    sourceDuration: state.duration ?? 0,
    clips: clips.length,
    splitScreens: groups.size,
    titles: state.textOverlays?.length ?? 0,
    layers: (state.imageOverlays?.filter((o) => !o.split).length ?? 0) + (state.pipOverlays?.filter((o) => !o.split).length ?? 0),
    captions: !!state.captions?.settings?.enabled,
    canvasLabel: canvas ? canvasPreset(canvas.preset)?.label ?? `${canvas.width}×${canvas.height}` : null,
    canvasAspect: canvas ? canvas.width / canvas.height : null,
    updatedAt: Number.isFinite(updated) ? updated : null,
  };
}

// "4 clips · 2 split screens · captions" - the parts worth naming, most telling first.
export function describeEdit(s: EditSummary): string[] {
  const parts: string[] = [];
  if (s.splitScreens) parts.push(`${s.splitScreens} split screen${s.splitScreens > 1 ? "s" : ""}`);
  if (s.clips > 1) parts.push(`${s.clips} clips`);
  if (s.titles) parts.push(`${s.titles} title${s.titles > 1 ? "s" : ""}`);
  if (s.layers) parts.push(`${s.layers} layer${s.layers > 1 ? "s" : ""}`);
  if (s.captions) parts.push("captions");
  return parts;
}

// A saved export of `path` in `files`, newest first: in the library's Exports folder as
// "<name> - v2.mp4" (export_output_path, conversion.rs), or - from before that - next to its video
// as "<name> (edited).mp4" / "(share-ready)".
const EXPORT_SUFFIX = /(\s\((edited|share-ready)\)(\s\(\d+\))?|\s-\sv\d+)+$/i;
const stem = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, "");
const inExportsFolder = (p: string) => /[\\/]Exports[\\/][^\\/]+$/i.test(p);
export const isExportName = (path: string) => EXPORT_SUFFIX.test(stem(path)) || inExportsFolder(path);
// The name an export (or its source) goes by without export suffixes or extension, lowercased -
// what groups a video with its exports wherever each sits.
export const exportBase = (path: string) => stem(path).replace(EXPORT_SUFFIX, "").toLowerCase();

// How an export is told apart from its siblings: "v2", or for older ones "edited" / "share-ready".
export function exportLabel(path: string): string {
  const s = stem(path);
  const version = s.match(/\s-\sv(\d+)$/i);
  if (version) return `v${version[1]}`;
  return /share-ready/i.test(s) ? "share-ready" : "edited";
}

export function exportsOf<T extends FileVersion>(path: string, files: T[]): T[] {
  const base = stem(path);
  return files.filter((f) => f.path !== path && isExportName(f.path) && stem(f.path).replace(EXPORT_SUFFIX, "") === base).sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
}
