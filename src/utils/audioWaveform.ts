// utils/audioWaveform.ts
//
// A file's waveform - its real peak levels, PEAKS_PER_SECOND of them a second - for the audio
// chips on the timeline, the audio panel and the player's audio view. Worked out by streaming the
// file through ffmpeg once (audio_peaks, audio_stream.rs) and cached on disk, so a five-hour file
// costs no more memory than a five-second one and is only ever read once; zoomed in, a long file's
// waveform is as sharp as a short one's.
import { invoke } from "@tauri-apps/api/core";

export const PEAKS_PER_SECOND = 50;

// Keyed by source path - two pieces of the same file share one read. Kept for the session; files on
// disk aren't expected to change under an open edit (and the disk cache is keyed by size and date).
const peaksCache = new Map<string, Promise<Float32Array>>();

// The whole file's peaks, PEAKS_PER_SECOND a second, each 0..1 - a typed array, since a day-long file
// has millions. Callers slice the stretch they show (sliceWaveformWindow) rather than asking per trim.
export function getWaveformPeaks(path: string): Promise<Float32Array> {
  let cached = peaksCache.get(path);
  if (!cached) {
    cached = invoke<ArrayBuffer>("audio_peaks", { path })
      .then((buffer) => new Float32Array(buffer))
      .catch((err) => {
        console.error("Failed to read the waveform of", path, err);
        peaksCache.delete(path);
        throw err;
      });
    peaksCache.set(path, cached);
  }
  return cached;
}

// The loudest peak in each of `buckets` equal stretches of `peaks` - a waveform drawn at any width
// keeps every loud moment, however many peaks fall into one bar.
export function downsamplePeaks(peaks: ArrayLike<number>, buckets: number, from = 0, to = peaks.length): number[] {
  const out: number[] = new Array(buckets).fill(0);
  const span = Math.max(0, to - from);
  if (span === 0) return out;
  for (let i = 0; i < buckets; i++) {
    const a = from + Math.floor((i / buckets) * span);
    const b = Math.max(a + 1, from + Math.floor(((i + 1) / buckets) * span));
    let max = 0;
    for (let j = Math.max(0, a); j < Math.min(peaks.length, b); j++) if (peaks[j] > max) max = peaks[j];
    out[i] = max;
  }
  return out;
}

// Slices the full-file peaks down to just the [trimStart, trimStart+duration) window, resampled
// to `outputBuckets` points - what the chip actually draws, so its waveform always reflects
// exactly the portion of the source that will actually play.
export function sliceWaveformWindow(fullPeaks: ArrayLike<number>, sourceDuration: number, trimStart: number, duration: number, outputBuckets: number): number[] {
  if (fullPeaks.length === 0 || sourceDuration <= 0) return new Array(outputBuckets).fill(0);
  const startIndex = Math.floor((trimStart / sourceDuration) * fullPeaks.length);
  const endIndex = Math.ceil(((trimStart + duration) / sourceDuration) * fullPeaks.length);
  return downsamplePeaks(fullPeaks, outputBuckets, startIndex, Math.max(startIndex + 1, endIndex));
}
