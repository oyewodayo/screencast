// utils/docTypes.ts
//
// Frontend mirror of docs.rs's DocSummary. No document-shape type exists here (unlike
// boardTypes.ts's BoardDocument) because a doc's actual content lives entirely inside its Y.Doc -
// it's never serialized to a plain TS interface, only to/from the opaque doc.bin bytes.
export interface DocSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  linked_to: string | null;
  // Set only on a doc returned by list_trashed_docs - null for every doc in the normal list.
  deleted_at: string | null;
}

// Structurally identical to Dashboard.tsx's own (unexported) FileEntry - defined here instead of
// imported from a page component so Docs' components don't reverse-depend on Dashboard.tsx.
export interface LibraryFileEntry {
  name: string;
  path: string;
}
