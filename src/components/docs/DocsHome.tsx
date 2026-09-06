// components/docs/DocsHome.tsx
//
// The Docs feature's landing screen - shown whenever the sidebar's Docs icon is clicked, mirrors
// BoardHome.tsx's list/create/delete UX closely (including its two-step delete confirm and
// click-outside-closes-menu handling) since Docs and Board are both per-item project folders under
// briefcast_dir(), just with a Y.Doc instead of a canvas as the content.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog, message as showMessageDialog } from "@tauri-apps/plugin-dialog";
import { IoAdd, IoClose, IoDocumentTextOutline, IoEllipsisVertical, IoFolderOutline, IoPin, IoSearch, IoTrashOutline } from "react-icons/io5";
import { MdFileUpload } from "react-icons/md";
import * as Y from "yjs";
import { DOC_DRAG_MIME, DocFolder, DocSummary, flattenFolderTree } from "../../utils/docTypes";
import { getPinnedDocIds, toggleDocPin, forgetDocPin } from "../../utils/docLibraryHistory";
import { importDocxFile } from "../../utils/docxImport";
import { extractPlainText } from "../../utils/docYjsText";
import DocFolderSidebar from "./DocFolderSidebar";

interface DocsHomeProps {
  onOpenDoc: (id: string) => void;
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const DocsHome: React.FC<DocsHomeProps> = ({ onOpenDoc }) => {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which card's 3-dot menu is open, if any - and, within that menu, whether "Delete" has already
  // been clicked once (turning it into "Confirm delete?"). Same two-step-confirm-in-menu UX as
  // BoardHome, for the same reason: deletion here is permanent, unlike the Trash-first flow
  // regular files get.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => getPinnedDocIds());
  const [searchQuery, setSearchQuery] = useState("");
  // Trash: deleting a doc is a soft-delete now (services/docs.rs's delete_doc moves the folder
  // into Docs/.trash/ instead of removing it), matching the rest of the app's recoverable-delete
  // convention instead of Docs being the one place an accidental click was unrecoverable.
  const [showTrash, setShowTrash] = useState(false);
  const [trashedDocs, setTrashedDocs] = useState<DocSummary[] | null>(null);
  const [confirmPermanentDeleteId, setConfirmPermanentDeleteId] = useState<string | null>(null);
  // Search now goes through docs_search.rs's SQLite FTS5 index rather than decoding every doc's
  // Yjs bytes into memory on every search keystroke - null means "not currently searching" (as
  // opposed to an empty Set, which means "searched, nothing matched").
  const [searchMatchIds, setSearchMatchIds] = useState<Set<string> | null>(null);

  // Folder tree - see docTypes.ts's DocFolder/flattenFolderTree comments. null selection means
  // DocFolderSidebar's "All Documents" root, not "no folders exist yet".
  const [folders, setFolders] = useState<DocFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  // Which doc card's "Move to ▸" submenu is open (nested inside that card's own 3-dot menu).
  const [moveMenuDocId, setMoveMenuDocId] = useState<string | null>(null);

  const refreshFolders = useCallback(() => {
    invoke<DocFolder[]>("list_doc_folders")
      .then(setFolders)
      .catch((err) => console.error("Failed to list document folders:", err));
  }, []);

  useEffect(() => {
    refreshFolders();
  }, [refreshFolders]);

  // A folder (or one of its ancestors) can disappear out from under the current selection -
  // deleted via its own menu, or in a future multi-window scenario - so if the selected id no
  // longer resolves to a real folder, fall back to "All Documents" rather than showing an empty
  // grid with no obvious way back.
  useEffect(() => {
    if (selectedFolderId && !folders.some((f) => f.id === selectedFolderId)) {
      setSelectedFolderId(null);
    }
  }, [folders, selectedFolderId]);

  const handleCreateFolder = useCallback(
    (parentId: string | null, name: string) => {
      invoke<DocFolder>("create_doc_folder", { id: crypto.randomUUID(), name, parentId })
        .then((folder) => setFolders((prev) => [...prev, folder]))
        .catch((err) => {
          console.error("Failed to create folder:", err);
          setError(err instanceof Error ? err.message : String(err));
        });
    },
    []
  );

  const handleRenameFolder = useCallback((id: string, name: string) => {
    invoke<DocFolder>("rename_doc_folder", { id, name })
      .then((updated) => setFolders((prev) => prev.map((f) => (f.id === id ? updated : f))))
      .catch((err) => {
        console.error("Failed to rename folder:", err);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const handleDeleteFolder = useCallback((id: string) => {
    invoke("delete_doc_folder", { id })
      .then(() => {
        refreshFolders();
        // Deleting un-files (doesn't delete) any doc that was filed under this folder or a
        // descendant of it - re-list so those docs' folder_id updates reflect that immediately.
        refresh();
      })
      .catch((err) => {
        console.error("Failed to delete folder:", err);
        setError(err instanceof Error ? err.message : String(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMoveDocToFolder = useCallback((docId: string, folderId: string | null) => {
    invoke<DocSummary>("set_doc_folder", { id: docId, folderId })
      .then((updated) => setDocs((prev) => prev?.map((d) => (d.id === docId ? updated : d)) ?? prev))
      .catch((err) => {
        console.error("Failed to move document:", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setMoveMenuDocId(null);
        setOpenMenuId(null);
      });
  }, []);

  const refresh = useCallback(() => {
    invoke<DocSummary[]>("list_docs")
      .then(setDocs)
      .catch((err) => {
        console.error("Failed to list documents:", err);
        setError(err instanceof Error ? err.message : String(err));
        setDocs([]);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Runs the actual search against docs_search.rs's FTS5 index on every query change - fast
  // enough (a local SQLite query) that this isn't debounced. Resets to null (not searching) for an
  // empty query.
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchMatchIds(null);
      return;
    }
    let cancelled = false;
    invoke<string[]>("search_docs", { query })
      .then((ids) => {
        if (!cancelled) setSearchMatchIds(new Set(ids));
      })
      .catch((err) => {
        console.error("Failed to search documents:", err);
        if (!cancelled) setSearchMatchIds(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [searchQuery]);

  // Lazily backfills the search index for any doc that isn't in it yet - a doc created before this
  // index existed, or one just restored from trash, has no row there until it's next opened/saved
  // (useDocsEditStore.ts indexes on both). Runs whenever the doc list changes (not just once on
  // mount), so a freshly-created doc that hasn't been opened yet still gets picked up here rather
  // than staying unsearchable until its first real edit. One load_doc round trip + a Yjs decode per
  // missing doc, done in parallel and entirely in the background - never blocks the UI, and a
  // single doc failing to decode doesn't block indexing the rest (same fail-soft posture list_docs
  // itself already uses for a corrupt folder).
  useEffect(() => {
    if (!docs || docs.length === 0) return;
    let cancelled = false;

    invoke<string[]>("list_indexed_doc_ids")
      .then((indexedIds) => {
        if (cancelled) return null;
        const indexed = new Set(indexedIds);
        const missing = docs.filter((d) => !indexed.has(d.id));
        if (missing.length === 0) return null;
        return Promise.all(
          missing.map(async (doc) => {
            try {
              const result = await invoke<{ bytes: number[] }>("load_doc", { id: doc.id });
              const ydoc = new Y.Doc();
              Y.applyUpdate(ydoc, new Uint8Array(result.bytes));
              const body = extractPlainText(ydoc.getXmlFragment("default"));
              ydoc.destroy();
              await invoke("index_doc_content", { id: doc.id, title: doc.title, body });
            } catch (err) {
              console.error(`Failed to backfill search index for document ${doc.id}:`, err);
            }
          })
        );
      })
      .catch((err) => console.error("Failed to check search index state:", err));

    return () => {
      cancelled = true;
    };
  }, [docs]);

  // Closes an open card menu (and drops any pending delete confirmation) on any click outside it -
  // must be "click", not "mousedown", for the same ordering reason documented in BoardHome.tsx:
  // mousedown fires before click for the same tap, so listening on mousedown here would close the
  // menu (and wipe confirmDeleteId) before a click on "Delete document"/"Confirm delete?" - whose
  // stopPropagation is on *click* - ever got a chance to run.
  useEffect(() => {
    if (!openMenuId) return;
    const handleClickOutside = (): void => {
      setOpenMenuId(null);
      setConfirmDeleteId(null);
      setMoveMenuDocId(null);
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [openMenuId]);

  const handleDeleteDoc = useCallback(async (id: string): Promise<void> => {
    try {
      // Soft delete - services/docs.rs moves the folder into Docs/.trash/ rather than removing
      // it, so this just needs to drop the doc out of the normal list, same as before.
      await invoke("delete_doc", { id });
      setOpenMenuId(null);
      setConfirmDeleteId(null);
      setDocs((prev) => prev?.filter((d) => d.id !== id) ?? prev);
      setPinnedIds(forgetDocPin(id));
      // Best-effort - a trashed doc lingering in the search index a little longer isn't a
      // correctness problem (list_docs already excludes it from the normal list this filters
      // against), so a failure here isn't worth surfacing as an error to the user.
      invoke("remove_doc_from_index", { id }).catch((err) => console.error("Failed to remove document from search index:", err));
    } catch (err) {
      console.error("Failed to delete document:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshTrash = useCallback(() => {
    invoke<DocSummary[]>("list_trashed_docs")
      .then(setTrashedDocs)
      .catch((err) => {
        console.error("Failed to list trashed documents:", err);
        setError(err instanceof Error ? err.message : String(err));
        setTrashedDocs([]);
      });
  }, []);

  useEffect(() => {
    if (showTrash) refreshTrash();
  }, [showTrash, refreshTrash]);

  const handleRestoreDoc = useCallback(
    async (id: string): Promise<void> => {
      try {
        await invoke("restore_doc", { id });
        setTrashedDocs((prev) => prev?.filter((d) => d.id !== id) ?? prev);
        refresh();
      } catch (err) {
        console.error("Failed to restore document:", err);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh]
  );

  const handleDeleteForever = useCallback(async (id: string): Promise<void> => {
    try {
      await invoke("delete_doc_permanently", { id });
      setTrashedDocs((prev) => prev?.filter((d) => d.id !== id) ?? prev);
      setConfirmPermanentDeleteId(null);
    } catch (err) {
      console.error("Failed to permanently delete document:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    try {
      const id = crypto.randomUUID();
      const existingCount = docs?.length ?? 0;
      const title = `Untitled document ${existingCount + 1}`;
      const bytes = Array.from(Y.encodeStateAsUpdate(new Y.Doc()));
      // Files into whichever folder is currently being browsed - so clicking "New document" while
      // inside a folder lands the doc there immediately instead of leaving it unfiled.
      await invoke("create_doc", { id, title, bytes, folderId: selectedFolderId });
      onOpenDoc(id);
    } catch (err) {
      console.error("Failed to create document:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  }, [docs, selectedFolderId, onOpenDoc]);

  const handleImportDocx = useCallback(async () => {
    setError(null);
    // Both extensions listed so a .doc file is actually pickable - hiding it from the dialog
    // entirely would just look like a bug ("why can't I even select my file?"), whereas showing a
    // clear message once it's picked explains the real limitation (no import path exists for the
    // legacy binary format - see utils/docxImport.ts's own header comment for why mammoth.js,
    // which does the actual .docx -> HTML conversion, only supports the modern OOXML format).
    const selected = await openFileDialog({ multiple: false, filters: [{ name: "Word Document", extensions: ["docx", "doc"] }] });
    if (!selected || Array.isArray(selected)) return;
    const name = selected.split(/[\\/]/).pop() ?? selected;

    if (!/\.docx$/i.test(name)) {
      await showMessageDialog(
        "This looks like an older .doc file. Please save it as .docx (in Word, Google Docs, or LibreOffice) and import again.",
        { title: "Unsupported file", kind: "warning" }
      );
      return;
    }

    setIsImporting(true);
    try {
      const { id } = await importDocxFile(selected, name);
      onOpenDoc(id);
    } catch (err) {
      console.error("Failed to import document:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsImporting(false);
    }
  }, [onOpenDoc]);

  const isSearching = searchQuery.trim().length > 0;
  // Search deliberately ignores the selected folder (searches every doc) - folder selection only
  // scopes the plain browse view, so switching into a folder never hides a search result that
  // happens to live elsewhere.
  const folderScopedDocs = docs?.filter((d) => d.folder_id === selectedFolderId);
  // searchMatchIds already covers both title and body (both are indexed columns in docs_search.rs)
  // - no separate client-side title check needed anymore.
  const filteredDocs = (isSearching ? docs : folderScopedDocs)?.filter((d) => !isSearching || searchMatchIds?.has(d.id) === true);
  const pinnedDocs = filteredDocs?.filter((d) => pinnedIds.includes(d.id)) ?? [];
  const moveTargets = useMemo(() => flattenFolderTree(folders), [folders]);

  const renderCard = (doc: DocSummary) => (
    // A plain div (not <button>) - it needs to contain the 3-dot menu's own <button>, and nested
    // interactive elements aren't valid HTML/accessible; role="button" + tabIndex + onKeyDown keep
    // it keyboard-operable instead.
    <div
      key={doc.id}
      role="button"
      tabIndex={0}
      onClick={() => onOpenDoc(doc.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDoc(doc.id);
        }
      }}
      // Additive on top of the "Move to ▸" menu (kept as-is for keyboard/precision use) - both
      // paths end at the same handleMoveDocToFolder call, so there's exactly one place that
      // actually invokes set_doc_folder.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DOC_DRAG_MIME, doc.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className="group relative flex flex-col rounded-md bg-white/90 dark:bg-neutral-900/90 border border-gray-200 dark:border-neutral-800 hover:border-blue-400 dark:hover:border-blue-500 text-left transition-colors cursor-pointer"
    >
      <div className="absolute top-1.5 right-1.5 z-10">
        <button
          type="button"
          title="Document options"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDeleteId(null);
            setMoveMenuDocId(null);
            setOpenMenuId((prev) => (prev === doc.id ? null : doc.id));
          }}
          className={`p-1 rounded-md bg-black/40 hover:bg-black/60 text-white transition-opacity ${
            openMenuId === doc.id ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          }`}
        >
          <IoEllipsisVertical size={14} />
        </button>

        {openMenuId === doc.id && (
          <div
            onClick={(e) => e.stopPropagation()}
            // No `overflow-hidden` here (unlike DocFolderSidebar's own menu) - the "Move to ▸"
            // flyout below deliberately escapes this container's bounds via `right-full`, and
            // overflow-hidden clips a positioned descendant to its ancestor's box regardless of
            // what it's positioned *relative to*, which made the flyout render but never be
            // visible. rounded-t-md/rounded-b-md on the first/last row keep the corners looking
            // right without it.
            className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg"
          >
            <button
              type="button"
              onClick={() => {
                setPinnedIds(toggleDocPin(doc.id));
                setOpenMenuId(null);
              }}
              className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-50 dark:hover:bg-neutral-700 rounded-t-md"
            >
              <IoPin size={14} />
              {pinnedIds.includes(doc.id) ? "Unpin document" : "Pin document"}
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() => setMoveMenuDocId((prev) => (prev === doc.id ? null : doc.id))}
                className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-50 dark:hover:bg-neutral-700"
              >
                <IoFolderOutline size={14} />
                Move to…
              </button>
              {moveMenuDocId === doc.id && (
                <div className="absolute right-full top-0 mr-1 w-48 max-h-60 overflow-y-auto bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg py-1">
                  <button
                    type="button"
                    onClick={() => handleMoveDocToFolder(doc.id, null)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-neutral-700 ${
                      doc.folder_id === null ? "text-blue-600 dark:text-blue-400 font-medium" : "text-gray-700 dark:text-neutral-200"
                    }`}
                  >
                    All Documents (unfiled)
                  </button>
                  {moveTargets.length === 0 ? (
                    <p className="px-3 py-1.5 text-xs text-gray-400 dark:text-neutral-500">No folders yet</p>
                  ) : (
                    moveTargets.map(({ folder, depth }) => (
                      <button
                        key={folder.id}
                        type="button"
                        onClick={() => handleMoveDocToFolder(doc.id, folder.id)}
                        style={{ paddingLeft: `${12 + depth * 14}px` }}
                        className={`w-full text-left pr-3 py-1.5 text-sm truncate hover:bg-gray-50 dark:hover:bg-neutral-700 ${
                          doc.folder_id === folder.id ? "text-blue-600 dark:text-blue-400 font-medium" : "text-gray-700 dark:text-neutral-200"
                        }`}
                      >
                        {folder.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => (confirmDeleteId === doc.id ? void handleDeleteDoc(doc.id) : setConfirmDeleteId(doc.id))}
              className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-b-md"
            >
              <IoTrashOutline size={14} />
              {confirmDeleteId === doc.id ? "Confirm delete?" : "Delete document"}
            </button>
          </div>
        )}
      </div>

      {pinnedIds.includes(doc.id) && (
        <div className="absolute top-1.5 left-1.5 z-10 p-1 rounded-md bg-black/40 text-white" title="Pinned">
          <IoPin size={12} />
        </div>
      )}

      <div className="aspect-video rounded-t-md overflow-hidden bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
        <IoDocumentTextOutline size={22} className="text-gray-300 dark:text-neutral-600" />
      </div>
      <div className="px-2.5 py-2">
        <p className="text-sm text-gray-700 dark:text-neutral-200 truncate">{doc.title || "Untitled document"}</p>
        <p className="text-xs text-gray-400 dark:text-neutral-500">{formatUpdatedAt(doc.updated_at)}</p>
      </div>
    </div>
  );

  return (
    <div className="flex h-full w-full">
      {!showTrash && (
        <DocFolderSidebar
          folders={folders}
          selectedFolderId={selectedFolderId}
          onSelectFolder={setSelectedFolderId}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          onDropDoc={handleMoveDocToFolder}
        />
      )}
      <div className="relative flex-1 min-w-0 flex flex-col items-center justify-start h-full gap-6 px-8 py-10 overflow-y-auto">
      <div className="relative flex flex-col items-center gap-3 text-center">
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-gray-200 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
          <IoDocumentTextOutline size={28} />
        </div>
        <div>
          <p className="text-gray-700 dark:text-neutral-200 font-medium">Docs</p>
          <p className="text-gray-500 dark:text-neutral-400 text-sm mt-1">
            Write and edit documents right inside Briefcast.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={isCreating}
          className="mt-1 flex items-center gap-1.5 px-4 py-2 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <IoAdd size={16} /> New document
        </button>
        <button
          type="button"
          onClick={() => void handleImportDocx()}
          disabled={isImporting}
          className="flex items-center gap-1.5 px-4 py-2 rounded-md border border-gray-300 dark:border-neutral-700 text-gray-700 dark:text-neutral-200 text-sm font-medium hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
        >
          <MdFileUpload size={16} /> {isImporting ? "Importing…" : "Import .docx"}
        </button>
        <button
          type="button"
          onClick={() => setShowTrash((v) => !v)}
          className="text-xs text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300 hover:underline"
        >
          {showTrash ? "Back to documents" : "Trash"}
        </button>
        {error && <p className="text-red-500 dark:text-red-400 text-xs">{error}</p>}
      </div>

      {showTrash && (
        <div className="relative w-full max-w-3xl">
          <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-2 text-center">
            Trash - deleted documents are kept here until permanently deleted
          </p>
          {trashedDocs === null ? (
            <p className="text-center text-sm text-gray-400 dark:text-neutral-500">Loading…</p>
          ) : trashedDocs.length === 0 ? (
            <p className="text-center text-sm text-gray-400 dark:text-neutral-500">Trash is empty</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {trashedDocs.map((doc) => (
                <div
                  key={doc.id}
                  className="flex flex-col rounded-md bg-white/90 dark:bg-neutral-900/90 border border-gray-200 dark:border-neutral-800"
                >
                  <div className="aspect-video rounded-t-md overflow-hidden bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
                    <IoDocumentTextOutline size={22} className="text-gray-300 dark:text-neutral-600" />
                  </div>
                  <div className="px-2.5 py-2">
                    <p className="text-sm text-gray-700 dark:text-neutral-200 truncate">{doc.title || "Untitled document"}</p>
                    <p className="text-xs text-gray-400 dark:text-neutral-500">Deleted {formatUpdatedAt(doc.deleted_at ?? doc.updated_at)}</p>
                  </div>
                  <div className="flex border-t border-gray-100 dark:border-neutral-800">
                    <button
                      type="button"
                      onClick={() => void handleRestoreDoc(doc.id)}
                      className="flex-1 px-2 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10"
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        confirmPermanentDeleteId === doc.id ? void handleDeleteForever(doc.id) : setConfirmPermanentDeleteId(doc.id)
                      }
                      className="flex-1 px-2 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 border-l border-gray-100 dark:border-neutral-800"
                    >
                      {confirmPermanentDeleteId === doc.id ? "Confirm?" : "Delete forever"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!showTrash && docs && docs.length > 0 && (
        <div className="relative w-full max-w-3xl">
          <div className="relative mb-4">
            <IoSearch size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search documents"
              className="w-full pl-7 pr-7 py-1.5 rounded-md text-xs bg-gray-100 dark:bg-neutral-800 border border-transparent focus:border-blue-400 dark:focus:border-blue-500 outline-none text-neutral-800 dark:text-neutral-100 placeholder:text-gray-400 dark:placeholder:text-neutral-500"
            />
            {searchQuery && (
              <button
                type="button"
                title="Clear search"
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700"
              >
                <IoClose size={13} />
              </button>
            )}
          </div>

          {pinnedDocs.length > 0 && (
            <div className="mb-4">
              <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-2 text-center">Pinned</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">{pinnedDocs.map(renderCard)}</div>
            </div>
          )}

          <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-2 text-center">
            {isSearching ? "Search results" : selectedFolderId ? folders.find((f) => f.id === selectedFolderId)?.name ?? "Folder" : "Your documents"}
          </p>
          {filteredDocs && filteredDocs.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">{filteredDocs.map(renderCard)}</div>
          ) : isSearching ? (
            <p className="text-center text-sm text-gray-400 dark:text-neutral-500">No documents match "{searchQuery}"</p>
          ) : (
            <p className="text-center text-sm text-gray-400 dark:text-neutral-500">
              {selectedFolderId ? "No documents in this folder yet" : "No unfiled documents - everything is organized into folders"}
            </p>
          )}
        </div>
      )}
      </div>
    </div>
  );
};

export default DocsHome;
