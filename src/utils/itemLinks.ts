// utils/itemLinks.ts
//
// Types and pure helpers for cross-links between library items (see services/links.rs). A link is
// undirected; docs.rs's older single `linked_to` ("this doc is notes for that recording") is folded
// in here as a read-only edge so every viewer shows one merged list.

export type ItemKind = "file" | "doc" | "whiteboard" | "mindmap";

export interface ItemRef {
  kind: ItemKind;
  id: string; // file path for "file", project id for the rest
}

export interface ItemLinkRecord {
  id: string;
  a: ItemRef;
  b: ItemRef;
  createdAt: string;
}

export type FileFamily = "video" | "audio" | "image" | "pdf" | "document" | "other";

// One row in a viewer's "Linked" list: the *other* end of an edge, resolved to something displayable.
export interface ResolvedLink {
  key: string;
  // Exactly one of these removes the edge: a links.rs id, or the doc whose own `linked_to` it is.
  linkId?: string;
  legacyDocId?: string;
  ref: ItemRef;
  title: string;
  family: FileFamily | "doc" | "whiteboard" | "mindmap";
}

export const refKey = (ref: ItemRef): string => `${ref.kind}:${ref.id}`;
export const sameRef = (a: ItemRef, b: ItemRef): boolean => a.kind === b.kind && a.id === b.id;

export const KIND_LABEL: Record<ResolvedLink["family"], string> = {
  video: "Video",
  audio: "Audio",
  image: "Image",
  pdf: "PDF",
  document: "File",
  other: "File",
  doc: "Note",
  whiteboard: "Whiteboard",
  mindmap: "Mind map",
};

// Normalises Windows path separators/case so "C:\a\b.pdf" and "c:/a/b.pdf" compare equal.
export const normalizePath = (path: string): string => path.replace(/\\/g, "/").toLowerCase();

export const fileRef = (path: string): ItemRef => ({ kind: "file", id: path });

// Edges touching `self`, other end first. Legacy doc->file edges come from `docs`.
export function edgesFor(
  self: ItemRef,
  links: ItemLinkRecord[],
  docs: { id: string; linked_to: string | null }[],
): { other: ItemRef; linkId?: string; legacyDocId?: string }[] {
  const out: { other: ItemRef; linkId?: string; legacyDocId?: string }[] = [];
  const selfIsFile = self.kind === "file";
  const selfPath = selfIsFile ? normalizePath(self.id) : "";
  const same = (a: ItemRef, b: ItemRef) => (a.kind === "file" && b.kind === "file" ? normalizePath(a.id) === normalizePath(b.id) : sameRef(a, b));

  for (const link of links) {
    if (same(link.a, self)) out.push({ other: link.b, linkId: link.id });
    else if (same(link.b, self)) out.push({ other: link.a, linkId: link.id });
  }
  for (const doc of docs) {
    if (!doc.linked_to) continue;
    if (self.kind === "doc" && self.id === doc.id) out.push({ other: fileRef(doc.linked_to), legacyDocId: doc.id });
    else if (selfIsFile && normalizePath(doc.linked_to) === selfPath) out.push({ other: { kind: "doc", id: doc.id }, legacyDocId: doc.id });
  }
  // The same pair can exist as both a links.rs edge and a legacy one; show it once.
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = e.other.kind === "file" ? `file:${normalizePath(e.other.id)}` : refKey(e.other);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
