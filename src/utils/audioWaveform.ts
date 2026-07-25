// utils/audioWaveform.ts
//
// Decodes an audio file's real peak amplitudes for the audio-overlay timeline chip's waveform -
// confirmed with the user as a real decode (Web Audio API), not a decorative placeholder. No Rust
// involvement needed: Tauri's asset:// protocol already serves plain fetchable bytes, and unlike
// the tainted-canvas bug fixed for image overlay export (videoOverlayRender.ts), decoding audio
// into peak numbers never touches a <canvas> at all, so there's no tainting concern here either.
import { convertFileSrc } from "@tauri-apps/api/tauri";

// Keyed by source path, not overlay id - two overlays pointing at the same file (e.g. one
// duplicated from the other) share one decode. Cached forever for the life of the app session;
// audio files on disk aren't expected to change out from under an open editing session.
const peaksCache = new Map<string, Promise<number[]>>();

// One shared AudioContext rather than one per decode - browsers cap how many can exist at once,
// and decodeAudioData doesn't need a dedicated context per call.
let sharedAudioContext: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (!sharedAudioContext) sharedAudioContext = new AudioContext();
  return sharedAudioContext;
}

async function decode(path: string, buckets: number): Promise<number[]> {
  const response = await fetch(convertFileSrc(path));
  const arrayBuffer = await response.arrayBuffer();
  // decodeAudioData detaches/consumes the buffer, and some engines mutate it in place - slice()
  // isn't needed here since this ArrayBuffer isn't reused for anything else afterward.
  const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer);

  const channelCount = audioBuffer.numberOfChannels;
  const samplesPerBucket = Math.max(1, Math.floor(audioBuffer.length / buckets));
  const peaks: number[] = new Array(buckets).fill(0);

  for (let channel = 0; channel < channelCount; channel++) {
    const data = audioBuffer.getChannelData(channel);
    for (let bucket = 0; bucket < buckets; bucket++) {
      const start = bucket * samplesPerBucket;
      const end = Math.min(data.length, start + samplesPerBucket);
      let max = 0;
      for (let i = start; i < end; i++) {
        const abs = Math.abs(data[i]);
        if (abs > max) max = abs;
      }
      // Averaged across channels rather than taking the max of both - a waveform meant to
      // represent "the sound", not exaggerate whichever channel happens to be louder at each
      // instant.
      peaks[bucket] += max / channelCount;
    }
  }

  return peaks;
}

// Returns (and caches) the full-file peak amplitudes, one per bucket, each 0..1. Callers slice
// this according to whichever sub-window of the source is actually in play (an AudioOverlay's own
// trimStart/duration) rather than re-decoding per-trim - see AudioOverlayPopover/the timeline
// chip's own waveform-slicing logic.
export function getWaveformPeaks(path: string, buckets = 400): Promise<number[]> {
  const cacheKey = `${path}::${buckets}`;
  let cached = peaksCache.get(cacheKey);
  if (!cached) {
    cached = decode(path, buckets).catch((err) => {
      console.error("Failed to decode waveform for", path, err);
      peaksCache.delete(cacheKey);
      throw err;
    });
    peaksCache.set(cacheKey, cached);
  }
  return cached;
}

// Slices the full-file peaks down to just the [trimStart, trimStart+duration) window, resampled
// to `outputBuckets` points - what the chip actually draws, so its waveform always reflects
// exactly the portion of the source that will actually play.
export function sliceWaveformWindow(fullPeaks: number[], sourceDuration: number, trimStart: number, duration: number, outputBuckets: number): number[] {
  if (fullPeaks.length === 0 || sourceDuration <= 0) return new Array(outputBuckets).fill(0);
  const startIndex = Math.floor((trimStart / sourceDuration) * fullPeaks.length);
  const endIndex = Math.ceil(((trimStart + duration) / sourceDuration) * fullPeaks.length);
  const windowLength = Math.max(1, endIndex - startIndex);

  const result: number[] = new Array(outputBuckets);
  for (let i = 0; i < outputBuckets; i++) {
    const sourceIndex = startIndex + Math.floor((i / outputBuckets) * windowLength);
    result[i] = fullPeaks[Math.min(fullPeaks.length - 1, Math.max(0, sourceIndex))] ?? 0;
  }
  return result;
}
