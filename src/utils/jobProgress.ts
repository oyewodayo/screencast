// utils/jobProgress.ts
//
// Progress of the long audio jobs - finding beats, listening for speech, cleaning a track,
// extracting and separating sound - as the panels show it: how far along, and roughly how long is
// left. A five-hour file is a wait worth knowing the length of; a spinner alone isn't.
//
// The backend reports two ways: "audio-job-progress" {key, fraction 0..1} (beats "beats:<path>",
// speech "silence:<path>" - conversion.rs) and the converter's "conversion-progress"
// {input_path, progress 0..100} (a cleaned track, an extracted clip). Both come out here the same.

import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

export interface JobProgress {
  fraction: number;
  // null until there's enough to go on (a few seconds in, a little done).
  secondsLeft: number | null;
}

// Time left from how fast it's gone so far.
export function etaTracker() {
  const startedAt = performance.now();
  return (fraction: number): number | null => {
    const elapsed = (performance.now() - startedAt) / 1000;
    if (fraction <= 0.02 || elapsed < 3) return null;
    return (elapsed / fraction) * (1 - fraction);
  };
}

// "under a minute left", "about 4 min left", "about 2 h 10 min left".
export const formatTimeLeft = (sec: number): string =>
  sec < 60 ? "under a minute left" : sec < 3600 ? `about ${Math.round(sec / 60)} min left` : `about ${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min left`;

// "42% · about 4 min left" (just "42%" while the time left is still unknown).
export const describeProgress = (p: JobProgress): string => `${Math.floor(p.fraction * 100)}%${p.secondsLeft !== null ? ` · ${formatTimeLeft(p.secondsLeft)}` : ""}`;

// One job by key, any job whose key starts with a prefix (every file a scan reads), or a file
// being converted.
type Match = { job: string } | { jobPrefix: string } | { conversionOf: string };

// Every progress report for jobs matching `match` (an audio job key, or a file being converted),
// until the returned function is called.
export async function listenJobProgress(match: Match, onProgress: (p: JobProgress) => void): Promise<() => void> {
  const eta = etaTracker();
  const report = (fraction: number) => onProgress({ fraction, secondsLeft: eta(fraction) });
  if ("job" in match || "jobPrefix" in match) {
    return listen<{ key: string; fraction: number }>("audio-job-progress", (e) => {
      const hit = "job" in match ? e.payload.key === match.job : e.payload.key.startsWith(match.jobPrefix);
      if (hit) report(Math.max(0, Math.min(1, e.payload.fraction)));
    });
  }
  return listen<{ input_path: string; progress: number }>("conversion-progress", (e) => {
    if (e.payload.input_path === match.conversionOf) report(Math.max(0, Math.min(1, e.payload.progress / 100)));
  });
}

// The progress of a job while `active` - null when it isn't running or hasn't reported yet.
export function useJobProgress(match: Match | null, active: boolean): JobProgress | null {
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const key = match ? JSON.stringify(match) : "";
  const matchRef = useRef(match);
  matchRef.current = match;
  useEffect(() => {
    setProgress(null);
    if (!active || !matchRef.current) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void listenJobProgress(matchRef.current, (p) => !cancelled && setProgress(p.fraction >= 1 ? null : p)).then((u) => {
      if (cancelled) u();
      else stop = u;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [key, active]);
  return progress;
}
