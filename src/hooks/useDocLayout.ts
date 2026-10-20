// hooks/useDocLayout.ts
//
// The open document's layout settings (docLayout.ts) as React state, updated on edits from any
// source - the page setup popover, an import, undo, or a collaborator.
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { DEFAULT_LAYOUT, docSettingsMap, readLayout, sameLayout, type DocLayout } from "../utils/docLayout";

export default function useDocLayout(ydoc: Y.Doc | null): DocLayout {
  const [layout, setLayout] = useState<DocLayout>(() => readLayout(ydoc));
  useEffect(() => {
    if (!ydoc) {
      setLayout(DEFAULT_LAYOUT);
      return;
    }
    const map = docSettingsMap(ydoc);
    const sync = () => setLayout((prev) => {
      const next = readLayout(ydoc);
      return sameLayout(prev, next) ? prev : next;
    });
    sync();
    map.observeDeep(sync);
    return () => map.unobserveDeep(sync);
  }, [ydoc]);
  return layout;
}
