// utils/beatSync.ts
//
// Beat sync: the beats found in music tracks (detect_beats, conversion.rs - stored on each
// AudioOverlay in its own file's seconds) placed on the output timeline, and fitting image clips
// to them so every cut lands on a beat. Pure functions only.
import type { AudioOverlay, Clip } from "./videoEditTypes";
import { clipOutputDuration } from "./clipTiming";
import { IMAGE_CLIP_MAX_SECONDS, isImageClipPath } from "./videoEditTypes";

// Every beat of every (unmuted) music track, as output-timeline seconds, sorted - only the beats
// inside the part of each track that's actually on the timeline.
export function beatOutputTimes(audioOverlays: AudioOverlay[]): number[] {
  const times: number[] = [];
  for (const o of audioOverlays) {
    if (!o.beats || o.muted) continue;
    const length = o.endTime - o.startTime;
    for (const b of o.beats) {
      const offset = b - o.trimStart;
      if (offset >= 0 && offset <= length) times.push(o.startTime + offset);
    }
  }
  return times.sort((a, b) => a - b);
}

// The shortest an image may be squeezed to when fitting it to the beat.
const MIN_IMAGE_SECONDS = 0.3;

// Lengthens or shortens each IMAGE clip so it ends exactly `everyBeats` beats after it starts -
// every cut on the beat. Video clips keep their length (cutting into footage is the user's call);
// the images after one realign to the next beat. Images past the last beat are left as they are.
export function fitImageClipsToBeats(clips: Clip[], beats: number[], everyBeats: number): Clip[] {
  if (beats.length === 0 || everyBeats < 1) return clips;
  let t = 0;
  let changed = false;
  const next = clips.map((clip) => {
    if (!isImageClipPath(clip.sourcePath) || clip.speedRamp) {
      t += clipOutputDuration(clip);
      return clip;
    }
    // The first beat at (or just after) this clip's start, then `everyBeats` beats on.
    const first = beats.findIndex((b) => b >= t - 0.05);
    const targetIndex = first === -1 ? -1 : first + everyBeats - (Math.abs(beats[first] - t) <= 0.05 ? 0 : 1);
    let target = targetIndex >= 0 && targetIndex < beats.length ? beats[targetIndex] : null;
    // Too short (the first beat was right after the start) - take one more beat.
    while (target !== null && target - t < MIN_IMAGE_SECONDS) {
      const i = beats.indexOf(target) + 1;
      target = i < beats.length ? beats[i] : null;
    }
    if (target === null) {
      t += clipOutputDuration(clip);
      return clip;
    }
    const length = Math.min(IMAGE_CLIP_MAX_SECONDS, target - t) * (clip.speed ?? 1);
    t = target;
    if (Math.abs(clip.end - clip.start - length) < 1e-4) return clip;
    changed = true;
    return { ...clip, end: clip.start + length };
  });
  return changed ? next : clips;
}
