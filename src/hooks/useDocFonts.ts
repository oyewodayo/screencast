// hooks/useDocFonts.ts
//
// The fonts stored with the open document (uploaded font files, fonts embedded in an imported
// PDF): registers each as a FontFace so text set in it renders, and keeps the list current as
// faces are added - from this window or, later, a collaborator.
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { docFontsMap, registerDocFont, type DocFontFace } from "../utils/docFonts";

export default function useDocFonts(ydoc: Y.Doc | null): DocFontFace[] {
  const [faces, setFaces] = useState<DocFontFace[]>([]);
  useEffect(() => {
    if (!ydoc) {
      setFaces([]);
      return;
    }
    const map = docFontsMap(ydoc);
    const sync = () => {
      const list = [...map.values()];
      list.forEach((f) => void registerDocFont(f));
      setFaces(list);
    };
    sync();
    map.observe(sync);
    return () => map.unobserve(sync);
  }, [ydoc]);
  return faces;
}
