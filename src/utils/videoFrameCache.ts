// utils/videoFrameCache.ts
//
// Filmstrip frames for a video clip that ISN'T the timeline's primary file - one inserted from
// elsewhere ("Insert videos or images...", a drag from the library). VideoTimelineDocker's own
// frame cache only ever decodes the primary file, so those clips used to pick their tiles out of
// the primary's frames - an inserted talk showed the slideshow it was dropped into.
//
// Same capture recipe as the primary's cache (a hidden <video> seeked slot by slot, each frame
// drawn downscaled to a canvas, coarse-to-fine so the strip fills fast and then sharpens), but
// kept per source path for the whole session, and run one source at a time: several inserted
// videos never decode in parallel and fight the visible player for the decoder.
import { convertFileSrc } from "@tauri-apps/api/core";
import { getPlayableUrl, isPictureless } from "./playableVideo";

export interface CachedFrame {
  time: number; // source time this frame was captured at
  src: string;
}

const STEP_SEC = 0.5;
const MAX_FRAMES = 240;
const CAPTURE_HEIGHT = 90;
// A seek that never lands (a corrupt stretch of file) skips its slot instead of stalling the queue.
const SEEK_TIMEOUT_MS = 4000;
const FLUSH_MS = 250;

interface Entry {
  frames: CachedFrame[];
  listeners: Set<(frames: CachedFrame[]) => void>;
}

const entries = new Map<string, Entry>();
const queue: string[] = [];
let running = false;

const notify = (entry: Entry) => {
  const snapshot = [...entry.frames].sort((a, b) => a.time - b.time);
  entry.frames = snapshot;
  entry.listeners.forEach((l) => l(snapshot));
};

// Slot indices in coarse-to-fine order: every 16th, then 8th, 4th, 2nd, then the rest.
const coarseToFine = (count: number): number[] => {
  const order: number[] = [];
  const seen = new Set<number>();
  for (let stride = 16; stride >= 1; stride /= 2) {
    for (let i = 0; i < count; i += stride) {
      if (!seen.has(i)) {
        seen.add(i);
        order.push(i);
      }
    }
  }
  return order;
};

const captureSource = (sourcePath: string, entry: Entry): Promise<void> =>
  new Promise((done) => {
    const video = document.createElement("video");
    // Required for the canvas draw below to stay exportable (see the primary capture rig's note).
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const finish = () => {
      video.removeAttribute("src");
      video.load();
      done();
    };

    const captureAt = (time: number): Promise<string | null> =>
      new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          video.removeEventListener("seeked", onSeeked);
          resolve(null);
        }, SEEK_TIMEOUT_MS);
        const onSeeked = () => {
          window.clearTimeout(timer);
          video.removeEventListener("seeked", onSeeked);
          if (!ctx || video.videoWidth === 0) return resolve(null);
          const scale = Math.min(1, CAPTURE_HEIGHT / video.videoHeight);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", 0.7));
          } catch {
            resolve(null);
          }
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = time;
      });

    // A file the webview can't show (an .avi errors, an HEVC .MOV loads with no picture) is
    // captured from its playable copy instead - tried once per capture.
    let swapped = false;
    const usePlayableCopy = () => {
      if (swapped) return finish();
      swapped = true;
      getPlayableUrl(sourcePath)
        .then((url) => {
          video.src = url;
        })
        .catch(finish);
    };
    video.addEventListener("error", usePlayableCopy);
    const onMetadata = async () => {
      if (isPictureless(video)) return usePlayableCopy();
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("error", usePlayableCopy);
      const total = video.duration;
      if (!Number.isFinite(total) || total <= 0) return finish();
      const count = Math.max(2, Math.min(MAX_FRAMES, Math.ceil(total / STEP_SEC)));
      const slotTime = (i: number) => Math.min(total - 0.01, ((i + 0.5) / count) * total);
      let lastFlush = performance.now();
      for (const slot of coarseToFine(count)) {
        // Nobody is showing this source any more (clip deleted, file closed) - stop early; a
        // later subscriber requeues it and keeps the frames already captured.
        if (entry.listeners.size === 0) break;
        const time = slotTime(slot);
        if (entry.frames.some((f) => f.time === time)) continue;
        const src = await captureAt(time);
        if (src) entry.frames.push({ time, src });
        if (performance.now() - lastFlush > FLUSH_MS) {
          lastFlush = performance.now();
          notify(entry);
        }
      }
      notify(entry);
      finish();
    };
    video.addEventListener("loadedmetadata", onMetadata);
    video.src = convertFileSrc(sourcePath);
  });

const pump = async () => {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const path = queue.shift()!;
    const entry = entries.get(path);
    if (entry && entry.listeners.size > 0) await captureSource(path, entry);
  }
  running = false;
};

// Calls `listener` with this source's frames (sorted by time) now and as more are captured.
// Returns the unsubscribe.
export const subscribeVideoFrames = (sourcePath: string, listener: (frames: CachedFrame[]) => void): (() => void) => {
  let entry = entries.get(sourcePath);
  const isNew = !entry;
  if (!entry) {
    entry = { frames: [], listeners: new Set() };
    entries.set(sourcePath, entry);
  }
  const wasIdle = entry.listeners.size === 0;
  entry.listeners.add(listener);
  if (entry.frames.length > 0) listener(entry.frames);
  if ((isNew || wasIdle) && !queue.includes(sourcePath)) {
    queue.push(sourcePath);
    void pump();
  }
  const own = entry;
  return () => {
    own.listeners.delete(listener);
  };
};
