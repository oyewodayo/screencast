// hooks/useDocLetterhead.ts
//
// The open document's letterhead (docLetterhead.ts) as React state, updated on edits from any
// source - the Letterhead panel, undo, a version restore or a collaborator.
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { docSettingsMap } from "../utils/docLayout";
import { readLetterhead, type DocLetterhead } from "../utils/docLetterhead";

const same = (a: DocLetterhead | null, b: DocLetterhead | null) => (!a && !b) || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));

export default function useDocLetterhead(ydoc: Y.Doc | null): DocLetterhead | null {
  const [letterhead, setLetterhead] = useState<DocLetterhead | null>(() => readLetterhead(ydoc));
  useEffect(() => {
    const sync = () =>
      setLetterhead((prev) => {
        const next = readLetterhead(ydoc);
        return same(prev, next) ? prev : next;
      });
    sync();
    if (!ydoc) return;
    const map = docSettingsMap(ydoc);
    map.observeDeep(sync);
    return () => map.unobserveDeep(sync);
  }, [ydoc]);
  return letterhead;
}
