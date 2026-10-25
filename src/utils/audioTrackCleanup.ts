// utils/audioTrackCleanup.ts
//
// Noise clean-up on an audio track (AudioOverlay.noiseReduction/audioCleanup - the same Reduce /
// Remove modes and extra stages a clip's sound has). The whole file is rendered once through the
// export's own ffmpeg chain (clean_audio_track, conversion.rs) and the track then simply plays that
// file - in the preview and in the export - so what is heard while editing is exactly what is saved,
// and trims, fades, automation and effects all apply on top as usual.
import { invoke } from "@tauri-apps/api/core";
import { hasAudioCleanup, type AudioOverlay } from "./videoEditTypes";

type Cleanable = Pick<AudioOverlay, "src" | "sourceDuration" | "noiseReduction" | "audioCleanup">;

export const isCleaned = (o: Cleanable): boolean => hasAudioCleanup(o);

// What identifies one rendering - the file and every setting that changes the sound.
export const cleanupKey = (o: Cleanable): string => JSON.stringify([o.src, o.noiseReduction ?? 0, o.audioCleanup ?? null]);

// One render per key for the session: pieces of the same track (or a repeat request) share it.
const renders = new Map<string, Promise<string>>();

export function cleanedTrackPath(o: Cleanable): Promise<string> {
  const key = cleanupKey(o);
  let pending = renders.get(key);
  if (!pending) {
    pending = invoke<string>("clean_audio_track", {
      sourcePath: o.src,
      sourceDuration: o.sourceDuration,
      noiseReduction: o.noiseReduction ?? null,
      audioCleanup: o.audioCleanup ?? null,
    });
    pending.catch(() => renders.delete(key)); // a failed render may be retried
    renders.set(key, pending);
  }
  return pending;
}
