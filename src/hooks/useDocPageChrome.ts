// hooks/useDocPageChrome.ts
//
// The open document's header/footer/page number settings (docPageChrome.ts) as React state,
// updated on edits from any source - the editor panel, undo, a version restore or a collaborator.
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { docSettingsMap } from "../utils/docLayout";
import { readPageChrome, samePageChrome, type DocPageChrome } from "../utils/docPageChrome";

export default function useDocPageChrome(ydoc: Y.Doc | null, legacyHeader: string | null, legacyFooter: string | null): DocPageChrome {
  const [chrome, setChrome] = useState<DocPageChrome>(() => readPageChrome(ydoc, legacyHeader, legacyFooter));
  useEffect(() => {
    const sync = () =>
      setChrome((prev) => {
        const next = readPageChrome(ydoc, legacyHeader, legacyFooter);
        return samePageChrome(prev, next) ? prev : next;
      });
    sync();
    if (!ydoc) return;
    const map = docSettingsMap(ydoc);
    map.observeDeep(sync);
    return () => map.unobserveDeep(sync);
  }, [ydoc, legacyHeader, legacyFooter]);
  return chrome;
}
