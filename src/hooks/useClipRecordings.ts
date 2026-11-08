// hooks/useClipRecordings.ts
//
// The pointer/shortcut recordings (pointerTrack.ts) of every file the timeline plays from, loaded
// once each - what the preview's pointer and key-chip layers and the Screen Style panel read.
import { useEffect, useState } from "react";
import type { Clip } from "../utils/videoEditTypes";
import { loadPointerRecording, type PointerRecording } from "../utils/pointerTrack";

export function useClipRecordings(clips: Clip[]): Map<string, PointerRecording | null> {
  const paths = [...new Set(clips.map((c) => c.sourcePath))].sort();
  const key = paths.join("\n");
  const [recordings, setRecordings] = useState<Map<string, PointerRecording | null>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void Promise.all(paths.map((p) => loadPointerRecording(p))).then((recs) => {
      if (!cancelled) setRecordings(new Map(paths.map((p, i) => [p, recs[i]])));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return recordings;
}
