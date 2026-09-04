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
  // Which DocFolder node (below) this doc is filed under - null means "unfiled" / shown under
  // DocsHome's root "All Documents" view.
  folder_id: string | null;
}

// Frontend mirror of docs.rs's DocFolder. Folders are a flat manifest (Docs/folders.json) with
// parent_id pointers, not real nested directories - DocFolderSidebar builds the tree from this
// list rather than the backend ever returning an already-nested shape, so the tree-building logic
// only has to exist in one place.
export interface DocFolder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
}

// Custom dataTransfer MIME type used to drag a doc card (DocsHome.tsx) onto a folder row
// (DocFolderSidebar.tsx) - shared here so the two files can't drift on the exact string.
export const DOC_DRAG_MIME = "application/x-briefcast-doc-id";

// "letter"/"a4"/"legal" - kept as a plain string union (not an enum) since it round-trips straight
// through docs.rs's DocMeta.page_size with no translation needed.
export type DocPageSize = "letter" | "a4" | "legal";

// Frontend mirror of docs.rs's DocComment - see its own header comment on why the anchored text
// range is never stored here, only `mark_id` (looked up live against the current document).
export interface DocComment {
  id: string;
  mark_id: string;
  text: string;
  created_at: string;
  resolved_at: string | null;
}

// Frontend mirror of docs.rs's DocVersionSummary - a single point-in-time snapshot of a doc's
// content, listed by useDocsEditStore.ts's `versions` and shown in DocVersionHistoryPanel.tsx.
export interface DocVersionSummary {
  id: string;
  created_at: string;
}

// Depth-first, parent-before-children flattening of the folder list - shared by DocFolderSidebar's
// recursive tree render and DocsHome's flat "Move to ▸" menu (which needs indentation but not
// expand/collapse), so the tree-walking logic only exists once. `excludeSubtreeOf` drops a folder
// and its own descendants from the result - used by the "Move to" menu on a *folder* row so it
// never offers to move a folder into itself or one of its own children (docs.rs's move_doc_folder
// rejects that server-side too, this just keeps the menu from offering an option that would fail).
export function flattenFolderTree(folders: DocFolder[], excludeSubtreeOf?: string): { folder: DocFolder; depth: number }[] {
  const excluded = new Set<string>();
  if (excludeSubtreeOf) {
    excluded.add(excludeSubtreeOf);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parent_id && excluded.has(f.parent_id) && !excluded.has(f.id)) {
          excluded.add(f.id);
          grew = true;
        }
      }
    }
  }

  const result: { folder: DocFolder; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    folders
      .filter((f) => f.parent_id === parentId && !excluded.has(f.id))
      .forEach((f) => {
        result.push({ folder: f, depth });
        visit(f.id, depth + 1);
      });
  };
  visit(null, 0);
  return result;
}

// Structurally identical to Dashboard.tsx's own (unexported) FileEntry - defined here instead of
// imported from a page component so Docs' components don't reverse-depend on Dashboard.tsx.
export interface LibraryFileEntry {
  name: string;
  path: string;
}
