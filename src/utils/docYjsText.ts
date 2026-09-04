// utils/docYjsText.ts
//
// Extracts a Y.Doc's plain readable text - shared by DocsHome.tsx (used to, decoding every doc's
// full Yjs bytes into memory on every search keystroke - see that file's own former comment) and
// now useDocsEditStore.ts, which computes this on load/save to hand over to docs_search.rs's FTS5
// index (this Rust backend has no Yjs decoder of its own, so the plain text has to originate here,
// client-side, before it can be indexed).
import * as Y from "yjs";

// Y.XmlFragment/Y.XmlElement's own .toString() embeds tag and formatting-attribute names in the
// output (e.g. "<paragraph><bold>Hello world</bold></paragraph>" - verified directly against the
// installed yjs version), which would make search/indexing false-positive match on "bold"/"table"/
// "link" etc. regardless of a document's actual text. Walk the tree and concatenate only
// Y.XmlText nodes' real inserted text (via .toDelta(), which separates the plain string from its
// formatting attributes) instead.
export function extractPlainText(node: Y.XmlFragment | Y.XmlElement): string {
  let text = "";
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta()) {
        if (typeof op.insert === "string") text += op.insert;
      }
    } else if (child instanceof Y.XmlElement) {
      text += extractPlainText(child) + " ";
    }
  }
  return text;
}
