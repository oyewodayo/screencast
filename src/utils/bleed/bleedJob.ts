// utils/bleed/bleedJob.ts
//
// "Remove playback bleed" on one audio track, end to end. The work is native (src-tauri
// services/bleed.rs, commands/bleed_removal.rs): the take is worked through a stretch at a time on
// every core, read from its file beside what the timeline played over that same stretch, and the
// cleaned take written straight to a new file - for a take of any length, five minutes or thirty
// hours, in a stretch's worth of memory. All this side says is what was playing: every clip's sound,
// every other track, every audible picture-in-picture - not the take itself nor the other mics of
// its recording pass, which are the speaker, not the playback. The track's own file is never
// touched - the result is a new file it plays instead, and the original stays to go back to.

import { invoke } from "@tauri-apps/api/core";
import type { AudioOverlay, Clip, PipOverlay } from "../videoEditTypes";
import { isImageClipPath } from "../videoEditTypes";
import { clipOutputDuration } from "../clipTiming";
import { listenJobProgress } from "../jobProgress";

export type BleedStrength = "gentle" | "normal" | "strong";
export type BleedJobStage = "render" | "delay" | "learn" | "remove" | "save";

export interface DelaySegment {
  from: number; // seconds into the take
  delay: number;
}

// As services/bleed.rs works through a take.
const SEGMENT_SEC = 45;

interface TimelineSound {
  clips: Clip[];
  videoAudioMuted: boolean;
  videoAudioVolume: number;
  audioOverlays: AudioOverlay[];
  pipOverlays: PipOverlay[];
}

interface Piece {
  sourcePath: string;
  sourceStart: number;
  sourceEnd: number;
  at: number;
  speed: number;
  volume: number;
}

// Where the take's file starts on the timeline - its sample 0 - and how long it runs.
const takeSpan = (take: AudioOverlay) => ({ start: take.startTime - take.trimStart, length: take.sourceDuration });

// Everything that was sounding over the take's file seconds [from, from + length), placed relative
// to `from`.
export function referencePieces(state: TimelineSound, take: AudioOverlay, from = 0, length = take.sourceDuration): Piece[] {
  const a0 = takeSpan(take).start + from;
  const b0 = a0 + length;
  const pieces: Piece[] = [];
  const place = (sourcePath: string, startTime: number, endTime: number, sourceAtStart: number, speed: number, volume: number) => {
    const a = Math.max(startTime, a0);
    const b = Math.min(endTime, b0);
    if (b - a < 0.01 || volume <= 0) return;
    pieces.push({ sourcePath, sourceStart: sourceAtStart + (a - startTime) * speed, sourceEnd: sourceAtStart + (b - startTime) * speed, at: a - a0, speed, volume });
  };
  // The video's own sound, clip by clip along the output timeline.
  if (!state.videoAudioMuted) {
    let at = 0;
    for (const clip of state.clips) {
      const length = clipOutputDuration(clip);
      if (!clip.muted && !isImageClipPath(clip.sourcePath)) place(clip.sourcePath, at, at + length, clip.start, clip.speed ?? 1, state.videoAudioVolume);
      at += length;
    }
  }
  // Other tracks - not this take, nor another mic of the same pass (its file starts at the same moment).
  const fileStart = takeSpan(take).start;
  for (const o of state.audioOverlays) {
    if (o.id === take.id || o.muted) continue;
    if (o.recorded && Math.abs(o.startTime - o.trimStart - fileStart) < 0.05) continue;
    place(o.src, o.startTime, o.endTime, o.trimStart, 1, o.volume);
  }
  for (const p of state.pipOverlays) {
    if (p.muted !== false) continue;
    place(p.sourcePath, p.startTime, p.endTime, p.trimStart, 1, Number.isFinite(p.volume) ? p.volume : 1);
  }
  return pieces;
}

export interface BleedJobResult {
  // The cleaned take's file, or null when there was no bleed to remove.
  path: string | null;
  segments: DelaySegment[];
  regions: [number, number][];
  bleedDb: number;
  removedDb: number;
}

export interface BleedJob {
  promise: Promise<BleedJobResult>;
  cancel: () => void;
}

// `overall` 0..1, and roughly how many seconds are left once there's enough to tell.
export type BleedProgress = (stage: BleedJobStage, overall: number, secondsLeft: number | null) => void;

let nextJob = 1;

export function startBleedRemoval(state: TimelineSound, take: AudioOverlay, strength: BleedStrength, onProgress: BleedProgress): BleedJob {
  const job = `${take.id}-${nextJob++}`;
  let cancelled = false;
  // A short take is one stretch, and its stages can be told apart; a long one is many, each going
  // through all of them in seconds - there it's just "taking it out".
  const single = take.sourceDuration <= SEGMENT_SEC;
  const stageAt = (f: number): BleedJobStage => (f >= 0.995 ? "save" : !single ? "remove" : f < 0.1 ? "delay" : f < 0.7 ? "learn" : "remove");
  const promise = (async (): Promise<BleedJobResult> => {
    onProgress("render", 0, null);
    const stop = await listenJobProgress({ job: `bleed:${job}` }, (p) => onProgress(stageAt(p.fraction), p.fraction, p.secondsLeft));
    try {
      if (cancelled) throw new Error("Cancelled");
      const result = await invoke<Omit<BleedJobResult, "bleedDb"> & { bleedDb: number | null }>("remove_bleed", {
        request: {
          job,
          // The take as it was recorded - a second run starts from the original, not the last result.
          source: take.bleed?.originalSrc ?? take.src,
          length: take.sourceDuration,
          name: take.label ?? "Voice-over",
          strength,
          pieces: referencePieces(state, take),
        },
      });
      return { ...result, bleedDb: result.bleedDb ?? -Infinity };
    } catch (err) {
      throw new Error(cancelled ? "Cancelled" : err instanceof Error ? err.message : String(err));
    } finally {
      stop();
    }
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      void invoke("cancel_bleed", { job }).catch(() => {});
    },
  };
}
