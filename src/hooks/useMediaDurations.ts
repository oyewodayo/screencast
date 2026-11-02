import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Durations (in seconds) for a handful of media files, read via the backend's ffprobe-backed
// get_conversion_info (off the UI thread - see services/responsiveness.rs). Cached for the session
// keyed by path+size, so revisiting the home screen doesn't re-probe, while a file that was
// re-recorded/overwritten at the same path (different size) does get probed again. Files that
// can't be probed simply have no entry.
const cache = new Map<string, number | null>();
const keyOf = (path: string, size: number) => `${path}\u0000${size}`;

export function useMediaDurations(files: { path: string; size: number }[]): Map<string, number> {
  const [, setVersion] = useState(0);
  const signature = files.map((f) => keyOf(f.path, f.size)).join("\n");

  useEffect(() => {
    let cancelled = false;
    const missing = files.filter((f) => !cache.has(keyOf(f.path, f.size)));
    if (missing.length === 0) return;
    Promise.all(
      missing.map(async (f) => {
        try {
          const info = await invoke<Record<string, string>>("get_conversion_info", { inputPath: f.path });
          const seconds = parseFloat(info.duration ?? "");
          cache.set(keyOf(f.path, f.size), Number.isFinite(seconds) ? seconds : null);
        } catch {
          cache.set(keyOf(f.path, f.size), null);
        }
      })
    ).then(() => {
      if (!cancelled) setVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const result = new Map<string, number>();
  for (const f of files) {
    const seconds = cache.get(keyOf(f.path, f.size));
    if (seconds != null) result.set(f.path, seconds);
  }
  return result;
}
