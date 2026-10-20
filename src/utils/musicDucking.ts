// utils/musicDucking.ts
//
// Music ducking in the editor: a music track marked duckUnderSpeech dips while someone talks and
// comes back up in the pauses. Speech is found the same way Trim silence finds dead air (ffmpeg's
// silencedetect, detect_silence in conversion.rs) - everything that isn't silence in the video's own
// sound, or in a detached Voice track, counts - and mapped onto the output timeline once, so the
// live preview (VideoTimelineDocker's audio sync) and the export (DuckEnvelope in conversion.rs)
// apply the identical curve: what you hear is what you get.
//
// The envelope looks ahead: it starts easing down DUCK_ATTACK_SEC before the first word, which
// real-time sidechain compressors can't do, so the voice never lands on full-volume music. Short
// pauses between phrases are bridged so the music doesn't pump up between every sentence.
import { invoke } from "@tauri-apps/api/core";
import { clipOutputDuration, sourceToOutputOffset } from "./clipTiming";
import { AudioOverlay, Clip, isImageClipPath } from "./videoEditTypes";

export type TimeRange = [number, number];

export const DEFAULT_DUCK_LEVEL = 0.25; // about -12 dB
export const DUCK_ATTACK_SEC = 0.25;
export const DUCK_RELEASE_SEC = 0.6;
// Speech separated by less than this is treated as one stretch.
const BRIDGE_GAP_SEC = 0.9;
// Silences shorter than this are gaps between words, not pauses.
const MIN_PAUSE_SEC = 0.4;

// A detached Voice track is speech to duck under, never something to duck itself.
export function isSpeechOverlay(o: AudioOverlay): boolean {
  return o.detached === true && /voice/i.test(o.label ?? "");
}

export function isDucked(o: AudioOverlay): boolean {
  return o.duckUnderSpeech === true && !o.muted && !isSpeechOverlay(o);
}

// Source files don't change during a session, so each is scanned once (and the scan shared between
// the preview and any number of exports).
const silenceCache = new Map<string, Promise<TimeRange[]>>();
export function getSilentRanges(path: string): Promise<TimeRange[]> {
  let cached = silenceCache.get(path);
  if (!cached) {
    cached = invoke<{ start: number; end: number }[]>("detect_silence", { inputPath: path, minDuration: MIN_PAUSE_SEC })
      .then((ranges) => ranges.map((r) => [r.start, r.end] as TimeRange))
      .catch((err) => {
        silenceCache.delete(path);
        throw err;
      });
    silenceCache.set(path, cached);
  }
  return cached;
}

// The non-silent parts of [from, to).
export function invertRanges(silent: TimeRange[], from: number, to: number): TimeRange[] {
  const out: TimeRange[] = [];
  let at = from;
  for (const [s, e] of [...silent].sort((a, b) => a[0] - b[0])) {
    if (e <= at) continue;
    if (s >= to) break;
    if (s > at) out.push([at, Math.min(s, to)]);
    at = Math.max(at, e);
  }
  if (at < to) out.push([at, to]);
  return out;
}

export function mergeRanges(ranges: TimeRange[], bridge = 0): TimeRange[] {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: TimeRange[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s - last[1] <= bridge) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

interface SpeechSources {
  clips: Clip[];
  videoAudioMuted: boolean;
  audioOverlays: AudioOverlay[];
}

// Every file whose speech matters for ducking.
export function speechSourcePaths({ clips, videoAudioMuted, audioOverlays }: SpeechSources): string[] {
  const paths = new Set<string>();
  if (!videoAudioMuted) clips.forEach((c) => !c.muted && !isImageClipPath(c.sourcePath) && paths.add(c.sourcePath));
  audioOverlays.forEach((o) => isSpeechOverlay(o) && !o.muted && paths.add(o.src));
  return [...paths];
}

// Speech on the output timeline, from each source's silences (a missing entry - not scanned yet,
// or the scan failed - contributes nothing).
export function speechTimeline({ clips, videoAudioMuted, audioOverlays }: SpeechSources, silences: Map<string, TimeRange[]>): TimeRange[] {
  const ranges: TimeRange[] = [];
  let outputStart = 0;
  for (const clip of clips) {
    const silent = silences.get(clip.sourcePath);
    if (!videoAudioMuted && !clip.muted && silent && !isImageClipPath(clip.sourcePath)) {
      for (const [a, b] of invertRanges(silent, clip.start, clip.end)) {
        ranges.push([outputStart + sourceToOutputOffset(clip, a), outputStart + sourceToOutputOffset(clip, b)]);
      }
    }
    outputStart += clipOutputDuration(clip);
  }
  for (const o of audioOverlays) {
    const silent = silences.get(o.src);
    if (!isSpeechOverlay(o) || o.muted || !silent) continue;
    const trimEnd = o.trimStart + (o.endTime - o.startTime);
    for (const [a, b] of invertRanges(silent, o.trimStart, trimEnd)) ranges.push([o.startTime + (a - o.trimStart), o.startTime + (b - o.trimStart)]);
  }
  return mergeRanges(ranges, BRIDGE_GAP_SEC);
}

export async function computeSpeechTimeline(sources: SpeechSources): Promise<TimeRange[]> {
  const silences = new Map<string, TimeRange[]>();
  await Promise.all(
    speechSourcePaths(sources).map((p) =>
      getSilentRanges(p)
        .then((r) => silences.set(p, r))
        .catch((err) => console.warn("Speech detection failed for", p, err))
    )
  );
  return speechTimeline(sources, silences);
}

const ramp = (t: number, [s, e]: TimeRange) =>
  Math.max(0, Math.min(1, (t - (s - DUCK_ATTACK_SEC)) / DUCK_ATTACK_SEC)) * Math.max(0, Math.min(1, (e + DUCK_RELEASE_SEC - t) / DUCK_RELEASE_SEC));

// The duck gain (level..1) at output time t - the same curve duck_volume_filter builds for export.
// `ranges` must be sorted and merged (speechTimeline's output); binary search keeps this cheap enough
// to run every preview tick on an hour of speech.
export function duckGainAt(ranges: TimeRange[], t: number, level = DEFAULT_DUCK_LEVEL): number {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid][1] + DUCK_RELEASE_SEC <= t) lo = mid + 1;
    else hi = mid;
  }
  let k = 0;
  for (let i = lo; i < ranges.length && ranges[i][0] - DUCK_ATTACK_SEC < t; i++) k += ramp(t, ranges[i]);
  return 1 - (1 - level) * Math.min(1, k);
}

// What export_trimmed_video needs for one overlay: only the ranges that can touch it.
export function duckEnvelopeFor(o: AudioOverlay, ranges: TimeRange[]) {
  if (!isDucked(o)) return undefined;
  const near = ranges.filter(([s, e]) => e + DUCK_RELEASE_SEC > o.startTime && s - DUCK_ATTACK_SEC < o.endTime);
  if (near.length === 0) return undefined;
  return { level: o.duckLevel ?? DEFAULT_DUCK_LEVEL, attack: DUCK_ATTACK_SEC, release: DUCK_RELEASE_SEC, ranges: near };
}
