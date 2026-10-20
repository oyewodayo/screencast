// utils/speechLoudness.ts
//
// How loud the speech is across the timeline, for Make it a Short (shortsFinder.ts's
// LoudnessProbe): louder-than-usual stretches are where a speaker gets animated. Reads each source's
// loudness contour with audio_cleanup_waveform (conversion.rs - with no cleanup set, its first
// channel is just the file's own envelope), in dB relative to that file's typical speech level, and
// lays it out on the output timeline so any range's average is two lookups.
import { invoke } from "@tauri-apps/api/core";
import type { Clip } from "./videoEditTypes";
import { isImageClipPath } from "./videoEditTypes";
import { clipOutputDuration, outputOffsetToSource } from "./clipTiming";
import type { LoudnessProbe } from "./shortsFinder";

const STEP_SEC = 0.25;
const MAX_BUCKETS = 4000;
// Quieter than this is not speech (room tone, pauses).
const SPEECH_FLOOR_DB = -45;

interface Contour {
  stepSec: number;
  db: Float32Array; // relative to the file's median speech level; NaN where not speech
}

const contours = new Map<string, Promise<Contour>>();

function loadContour(path: string, durationSec: number): Promise<Contour> {
  const key = `${path}|${durationSec.toFixed(1)}`;
  let cached = contours.get(key);
  if (!cached) {
    cached = (async () => {
      const buckets = Math.max(16, Math.min(MAX_BUCKETS, Math.ceil(durationSec / STEP_SEC)));
      const buf = await invoke<ArrayBuffer>("audio_cleanup_waveform", { sourcePath: path, start: 0, end: durationSec, noiseReduction: null, audioCleanup: null, buckets });
      const pairs = new Float32Array(buf);
      const db = new Float32Array(buckets);
      const speech: number[] = [];
      for (let b = 0; b < buckets; b++) {
        const v = 20 * Math.log10(Math.max(1e-6, pairs[b * 2] ?? 0));
        db[b] = v;
        if (v > SPEECH_FLOOR_DB) speech.push(v);
      }
      speech.sort((x, y) => x - y);
      const median = speech.length ? speech[Math.floor(speech.length / 2)] : 0;
      for (let b = 0; b < buckets; b++) db[b] = db[b] > SPEECH_FLOOR_DB ? db[b] - median : NaN;
      return { stepSec: durationSec / buckets, db };
    })();
    cached.catch(() => contours.delete(key));
    contours.set(key, cached);
  }
  return cached;
}

// A probe over the timeline's output seconds, or null when no source's loudness could be read.
export async function speechLoudnessProbe(clips: Clip[], sourceDuration: (path: string) => number | null): Promise<LoudnessProbe | null> {
  const paths = Array.from(new Set(clips.filter((c) => !isImageClipPath(c.sourcePath)).map((c) => c.sourcePath)));
  const loaded = new Map<string, Contour>();
  await Promise.all(
    paths.map(async (p) => {
      const duration = sourceDuration(p) ?? Math.max(...clips.filter((c) => c.sourcePath === p).map((c) => c.end));
      try {
        loaded.set(p, await loadContour(p, duration));
      } catch (err) {
        console.warn("Couldn't read the loudness of", p, err);
      }
    })
  );
  if (loaded.size === 0) return null;

  // The output timeline in STEP_SEC steps: running sum and count of speech loudness.
  const total = clips.reduce((sum, c) => sum + clipOutputDuration(c), 0);
  const steps = Math.ceil(total / STEP_SEC) + 1;
  const sum = new Float64Array(steps + 1);
  const count = new Float64Array(steps + 1);
  let at = 0;
  let k = 0;
  for (const clip of clips) {
    const d = clipOutputDuration(clip);
    const contour = loaded.get(clip.sourcePath);
    for (; k < steps && k * STEP_SEC < at + d; k++) {
      let v = NaN;
      if (contour) {
        const src = outputOffsetToSource(clip, k * STEP_SEC - at);
        v = contour.db[Math.min(contour.db.length - 1, Math.max(0, Math.floor(src / contour.stepSec)))];
      }
      sum[k + 1] = sum[k] + (Number.isNaN(v) ? 0 : v);
      count[k + 1] = count[k] + (Number.isNaN(v) ? 0 : 1);
    }
    at += d;
  }
  for (; k < steps; k++) {
    sum[k + 1] = sum[k];
    count[k + 1] = count[k];
  }
  return (start, end) => {
    const a = Math.max(0, Math.min(steps, Math.floor(start / STEP_SEC)));
    const b = Math.max(a, Math.min(steps, Math.ceil(end / STEP_SEC)));
    const n = count[b] - count[a];
    return n > 0 ? (sum[b] - sum[a]) / n : null;
  };
}
