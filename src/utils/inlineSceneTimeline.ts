// utils/inlineSceneTimeline.ts
//
// Pure helpers that keep inline StageScenes synchronized side-by-side with media clips on the
// main video timeline:
// - When a Clip carries `sceneId`, its outputStart IS the linked StageScene's `startTime`, and
//   its [start, end) duration tracks `sceneDuration(scene)`.
// - Scenes without a linked Clip behave as overlay scenes (playing on top of media on the
//   dedicated scene overlay track) when the user explicitly chooses Overlay mode.

import { clipOutputDuration, outputOffsetToSource } from "./clipTiming";
import { sceneDuration } from "./stage/stageEditing";
import type { StageScene } from "./stage/stageTypes";
import type { Clip } from "./videoEditTypes";

const EDGE_SNAP_SEC = 0.5;
const MIN_SPLIT_PIECE_SEC = 0.25;

/**
 * Returns the exact output start time (in seconds) of the clip matching `sceneId`, or null if
 * that scene is an overlay scene (not inline on the main track).
 */
export function inlineSceneOutputStart(clips: Clip[], sceneId: string): number | null {
  let acc = 0;
  for (const clip of clips) {
    if (clip.sceneId === sceneId) return acc;
    acc += clipOutputDuration(clip);
  }
  return null;
}

/**
 * Synchronizes every inline Scene clip's duration with its StageScene and updates each inline
 * StageScene's `startTime` to match its exact sequential position on the main timeline.
 */
export function syncInlineScenes(
  clips: Clip[],
  scenes: StageScene[]
): { clips: Clip[]; scenes: StageScene[] } {
  if (clips.length === 0 || scenes.length === 0) return { clips, scenes };
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  let clipsChanged = false;
  const nextClips: Clip[] = [];
  const startBySceneId = new Map<string, number>();

  let acc = 0;
  for (const clip of clips) {
    if (clip.sceneId) {
      const sc = sceneById.get(clip.sceneId);
      if (sc) {
        const dur = Math.max(0.1, sceneDuration(sc));
        const targetEnd = clip.start + dur;
        const aligned =
          Math.abs(clip.end - targetEnd) > 1e-4 || clip.speed !== undefined
            ? { ...clip, end: targetEnd, speed: undefined }
            : clip;
        if (aligned !== clip) clipsChanged = true;
        startBySceneId.set(sc.id, acc);
        nextClips.push(aligned);
        acc += clipOutputDuration(aligned);
        continue;
      }
    }
    nextClips.push(clip);
    acc += clipOutputDuration(clip);
  }

  let scenesChanged = false;
  const nextScenes = scenes.map((sc) => {
    const start = startBySceneId.get(sc.id);
    if (start === undefined) return sc;
    if (Math.abs(sc.startTime - start) <= 1e-4) return sc;
    scenesChanged = true;
    return { ...sc, startTime: start };
  });

  return {
    clips: clipsChanged ? nextClips : clips,
    scenes: scenesChanged ? nextScenes : scenes,
  };
}

/**
 * Inserts a new inline Scene clip side-by-side on the main timeline at `playheadTime`:
 * - Empty timeline -> [sceneClip] at 0s
 * - Playhead at/near 0s (<= 0.5s) -> inserted BEFORE clip 0 (scene plays first, then media)
 * - Playhead at/near the end -> appended AFTER the last clip
 * - Playhead near a boundary between two clips -> inserted cleanly at that boundary
 * - Playhead inside a media clip -> splits that media clip so the scene plays between the two halves
 */
export function insertInlineSceneClip(
  clips: Clip[],
  playheadTime: number,
  sceneClip: Clip,
  makeSplitId: () => string
): { clips: Clip[]; startTime: number } {
  if (clips.length === 0) {
    return { clips: [sceneClip], startTime: 0 };
  }

  const starts: number[] = [];
  const durs: number[] = [];
  let total = 0;
  for (const c of clips) {
    starts.push(total);
    const d = clipOutputDuration(c);
    durs.push(d);
    total += d;
  }

  const t = Math.max(0, playheadTime);
  if (t <= EDGE_SNAP_SEC) {
    return { clips: [sceneClip, ...clips], startTime: 0 };
  }
  if (t >= total - EDGE_SNAP_SEC) {
    return { clips: [...clips, sceneClip], startTime: total };
  }

  // Locate the clip containing `t`.
  let idx = clips.length - 1;
  for (let i = 0; i < clips.length; i++) {
    if (t < starts[i] + durs[i] - 1e-6) {
      idx = i;
      break;
    }
  }

  const clip = clips[idx];
  const offsetInClip = t - starts[idx];
  const remainingInClip = durs[idx] - offsetInClip;

  // Near the start or end of this clip (or if this clip is itself a scene): insert adjacent without splitting.
  if (offsetInClip <= EDGE_SNAP_SEC) {
    const next = [...clips];
    next.splice(idx, 0, sceneClip);
    return { clips: next, startTime: starts[idx] };
  }
  if (remainingInClip <= EDGE_SNAP_SEC || clip.sceneId) {
    const next = [...clips];
    next.splice(idx + 1, 0, sceneClip);
    return { clips: next, startTime: starts[idx] + durs[idx] };
  }

  // Split the media clip cleanly so the scene sits side-by-side between both halves.
  const splitSourceTime = outputOffsetToSource(clip, offsetInClip);
  if (splitSourceTime - clip.start < MIN_SPLIT_PIECE_SEC || clip.end - splitSourceTime < MIN_SPLIT_PIECE_SEC) {
    const insertAt = offsetInClip < remainingInClip ? idx : idx + 1;
    const next = [...clips];
    next.splice(insertAt, 0, sceneClip);
    return { clips: next, startTime: insertAt === idx ? starts[idx] : starts[idx] + durs[idx] };
  }

  const firstHalf: Clip = { ...clip, end: splitSourceTime };
  const secondHalf: Clip = { ...clip, id: makeSplitId(), start: splitSourceTime, transitionIn: undefined, cutSound: undefined };
  const next = [...clips.slice(0, idx), firstHalf, sceneClip, secondHalf, ...clips.slice(idx + 1)];
  return { clips: next, startTime: starts[idx] + clipOutputDuration(firstHalf) };
}
