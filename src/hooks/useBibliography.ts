// hooks/useBibliography.ts
//
// The open document's reference library (docBibliography.ts's BibliographyStore over its Y.Doc)
// as React state: one stable store per Y.Doc, plus a revision that bumps whenever references or
// the citation style change, so panels re-render on edits made anywhere.
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { BibliographyStore, DEFAULT_CITATION_STYLE, type BibEntry, type CitationStyleId } from "../utils/docBibliography";

export interface UseBibliographyResult {
  store: BibliographyStore | null;
  entries: BibEntry[];
  style: CitationStyleId;
  revision: number;
}

export default function useBibliography(ydoc: Y.Doc | null): UseBibliographyResult {
  const store = useMemo(() => (ydoc ? new BibliographyStore(ydoc) : null), [ydoc]);
  const [revision, setRevision] = useState(0);
  useEffect(() => store?.subscribe(() => setRevision((r) => r + 1)), [store]);
  return {
    store,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    entries: useMemo(() => store?.all() ?? [], [store, revision]),
    style: store?.style() ?? DEFAULT_CITATION_STYLE,
    revision,
  };
}
