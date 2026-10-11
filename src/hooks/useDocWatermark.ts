// hooks/useDocWatermark.ts
//
// The open document's watermark (docWatermark.ts) as React state, updated on edits from any
// source - the Watermark panel, undo, a version restore or a collaborator.
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { docSettingsMap } from "../utils/docLayout";
import { readWatermark, sameWatermark, type DocWatermark } from "../utils/docWatermark";

export default function useDocWatermark(ydoc: Y.Doc | null): DocWatermark {
  const [watermark, setWatermark] = useState<DocWatermark>(() => readWatermark(ydoc));
  useEffect(() => {
    const sync = () =>
      setWatermark((prev) => {
        const next = readWatermark(ydoc);
        return sameWatermark(prev, next) ? prev : next;
      });
    sync();
    if (!ydoc) return;
    const map = docSettingsMap(ydoc);
    map.observeDeep(sync);
    return () => map.unobserveDeep(sync);
  }, [ydoc]);
  return watermark;
}
