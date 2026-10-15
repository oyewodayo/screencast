// utils/reframeAnalysis.ts
//
// Runs auto-reframe's analysis for a timeline (analyze_subject_track per video clip, plus each
// recording's click sidecar) and solves the camera path (reframeTrack.ts). Results are memoised by
// everything they depend on, so the export preview and Save share one analysis - and the analysis
// itself is cached on disk by Rust, so reopening is instant too.
import { invoke } from "@tauri-apps/api/core";
import type { Clip } from "./videoEditTypes";
import { isImageClipPath } from "./videoEditTypes";
import { ClipEvidence, ReframeKnot, SubjectTrack, fillWindow, gatherEvidence, solveReframe, sourceWindow } from "./reframeTrack";

interface Size {
  width: number;
  height: number;
}

const memo = new Map<string, Promise<ReframeKnot[]>>();
const MEMO_LIMIT = 8;

function clipKey(c: Clip) {
  return [c.sourcePath, c.start, c.end, c.speed, JSON.stringify(c.speedRamp ?? null), JSON.stringify(c.kenBurns ?? null), JSON.stringify(c.crop ?? null), c.flipHorizontal ? 1 : 0, c.transitionIn?.duration ?? 0].join("|");
}

async function loadClicks(sourcePath: string): Promise<{ time: number; x: number; y: number }[]> {
  try {
    const json = await invoke<string | null>("load_click_sidecar", { videoPath: sourcePath });
    if (!json) return [];
    const raw: { elapsedSecs: number; xFraction: number; yFraction: number }[] = JSON.parse(json);
    return raw.filter((c) => Number.isFinite(c.elapsedSecs)).map((c) => ({ time: c.elapsedSecs, x: c.xFraction, y: c.yFraction }));
  } catch {
    return [];
  }
}

// The camera path for Fill into `out` following the subject, on the output timeline.
export function analyzeReframe(clips: Clip[], frame: Size, out: Size, onProgress?: (done: number, total: number) => void): Promise<ReframeKnot[]> {
  const key = JSON.stringify([frame.width, frame.height, out.width, out.height, clips.map(clipKey)]);
  const existing = memo.get(key);
  if (existing) return existing;
  const job = (async () => {
    const win = fillWindow(frame, out);
    const clickCache = new Map<string, Promise<{ time: number; x: number; y: number }[]>>();
    const evidence: ClipEvidence[] = [];
    let done = 0;
    onProgress?.(0, clips.length);
    // One clip at a time: each analysis already decodes as fast as the machine allows.
    for (const clip of clips) {
      let track: SubjectTrack | null = null;
      let clicks: { time: number; x: number; y: number }[] = [];
      if (!isImageClipPath(clip.sourcePath)) {
        const want = sourceWindow(clip, null, frame, win);
        track = await invoke<SubjectTrack>("analyze_subject_track", { sourcePath: clip.sourcePath, start: clip.start, end: clip.end, cropW: want.w, cropH: want.h });
        // Now that the source's size is known, ask again for the exact window if it differs
        // (instant - the profiles are cached).
        if (track.width > 0 && track.height > 0) {
          const exact = sourceWindow(clip, { width: track.width, height: track.height }, frame, win);
          if (Math.abs(exact.w - want.w) > 1e-3 || Math.abs(exact.h - want.h) > 1e-3) {
            track = await invoke<SubjectTrack>("analyze_subject_track", { sourcePath: clip.sourcePath, start: clip.start, end: clip.end, cropW: exact.w, cropH: exact.h });
          }
        }
        if (!clickCache.has(clip.sourcePath)) clickCache.set(clip.sourcePath, loadClicks(clip.sourcePath));
        clicks = await clickCache.get(clip.sourcePath)!;
      }
      evidence.push({ clip, track, clicks });
      onProgress?.(++done, clips.length);
    }
    const { points, boundaries, duration } = gatherEvidence(evidence, frame);
    return solveReframe(points, boundaries, duration, win);
  })();
  memo.set(key, job);
  job.catch(() => memo.delete(key));
  while (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value!);
  return job;
}

// Fill's fixed anchor as the same kind of path (one knot), for the preview.
export function anchorKnots(frame: Size, out: Size, anchor: { x: number; y: number }): ReframeKnot[] {
  const win = fillWindow(frame, out);
  return [{ t: 0, x: win.w / 2 + anchor.x * (1 - win.w), y: win.h / 2 + anchor.y * (1 - win.h) }];
}
