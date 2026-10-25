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
//
// On a long video the overview is minutes apart, so the tiles in view also ask for their own frames
// (wantVideoFrames) - served before the overview's remaining slots, and a source that had finished
// is opened again for them. Up to MAX_DETAIL_FRAMES of those per source, oldest dropped first.
import { convertFileSrc } from "@tauri-apps/api/core";
import { getPlayableUrl, isPictureless } from "./playableVideo";

export interface CachedFrame {
  time: number; // source time this frame was captured at
  src: string;
}

const STEP_SEC = 0.5;
const MAX_FRAMES = 240;
const MAX_DETAIL_FRAMES = 1000;
const CAPTURE_HEIGHT = 90;
// A seek that never lands (a corrupt stretch of file) skips its slot instead of stalling the queue.
const SEEK_TIMEOUT_MS = 4000;
const FLUSH_MS = 250;

// A tile's ask: a frame within `tolerance` seconds of `time` (source time).
export interface FrameWant {
  time: number;
  tolerance: number;
}

interface Entry {
  // In time order.
  frames: CachedFrame[];
  listeners: Set<(frames: CachedFrame[]) => void>;
  // Each showing clip's asks (nearest the middle of the view first), and them merged to work through.
  wants: Map<object, FrameWant[]>;
  pending: FrameWant[];
  detailTimes: number[];
  overviewDone: boolean;
}

const entries = new Map<string, Entry>();
const queue: string[] = [];
let running = false;
// The source being captured right now - new asks for it are picked up by its running loop.
let current: string | null = null;

const notify = (entry: Entry) => {
  const snapshot = [...entry.frames];
  entry.listeners.forEach((l) => l(snapshot));
};

// Where `time` goes in the time-ordered frames.
const indexOf = (frames: CachedFrame[], time: number): number => {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const covered = (frames: CachedFrame[], w: FrameWant): boolean => {
  const i = indexOf(frames, w.time);
  return (i < frames.length && frames[i].time - w.time <= w.tolerance) || (i > 0 && w.time - frames[i - 1].time <= w.tolerance);
};

// The next ask the frames don't answer yet, or null.
const nextWant = (entry: Entry): number | null => {
  while (entry.pending.length > 0) {
    const w = entry.pending.shift()!;
    if (!covered(entry.frames, w)) return w.time;
  }
  return null;
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
      const slots = entry.overviewDone ? [] : coarseToFine(count);
      let lastFlush = performance.now();
      for (;;) {
        // Nobody is showing this source any more (clip deleted, file closed) - stop early; a
        // later subscriber requeues it and keeps the frames already captured.
        if (entry.listeners.size === 0) break;
        let time = nextWant(entry);
        const isDetail = time !== null;
        // An overview slot already captured, or covered by a tile's frame, is skipped.
        while (time === null && slots.length > 0) {
          const slot = slotTime(slots.shift()!);
          if (!covered(entry.frames, { time: slot, tolerance: total / count / 2 })) time = slot;
        }
        if (time === null) {
          entry.overviewDone = true;
          break;
        }
        const src = await captureAt(Math.min(total - 0.01, Math.max(0, time)));
        if (src) {
          entry.frames.splice(indexOf(entry.frames, time), 0, { time, src });
          if (isDetail) {
            entry.detailTimes.push(time);
            if (entry.detailTimes.length > MAX_DETAIL_FRAMES) {
              const oldest = entry.detailTimes.shift()!;
              const i = indexOf(entry.frames, oldest);
              if (entry.frames[i]?.time === oldest) entry.frames.splice(i, 1);
            }
          }
        }
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
    current = path;
    if (entry && entry.listeners.size > 0) await captureSource(path, entry);
    current = null;
    // Asks that came in as it closed - open it again for them.
    if (entry && entry.listeners.size > 0 && entry.pending.length > 0 && !queue.includes(path)) queue.push(path);
  }
  running = false;
};

const enqueue = (sourcePath: string) => {
  if (!queue.includes(sourcePath)) queue.push(sourcePath);
  void pump();
};

// The frames `owner` (one clip on the timeline) wants of this source right now - replacing what it
// asked before; [] withdraws them. Asks the cache already answers cost nothing.
export const wantVideoFrames = (sourcePath: string, owner: object, wants: FrameWant[]): void => {
  const entry = entries.get(sourcePath);
  if (!entry) return;
  if (wants.length > 0) entry.wants.set(owner, wants);
  else entry.wants.delete(owner);
  // Each clip's asks in turn, so two clips in view both sharpen from their middles out.
  const lists = [...entry.wants.values()];
  const merged: FrameWant[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) merged.push(l[i]);
  entry.pending = merged;
  if (current !== sourcePath && merged.some((w) => !covered(entry.frames, w)) && entry.listeners.size > 0) enqueue(sourcePath);
};

// Calls `listener` with this source's frames (sorted by time) now and as more are captured.
// Returns the unsubscribe.
export const subscribeVideoFrames = (sourcePath: string, listener: (frames: CachedFrame[]) => void): (() => void) => {
  let entry = entries.get(sourcePath);
  const isNew = !entry;
  if (!entry) {
    entry = { frames: [], listeners: new Set(), wants: new Map(), pending: [], detailTimes: [], overviewDone: false };
    entries.set(sourcePath, entry);
  }
  const wasIdle = entry.listeners.size === 0;
  entry.listeners.add(listener);
  if (entry.frames.length > 0) listener(entry.frames);
  if (isNew || wasIdle) enqueue(sourcePath);
  const own = entry;
  return () => {
    own.listeners.delete(listener);
  };
};
