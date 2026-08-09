// components/docs/DocsHome.tsx
//
// The Docs feature's landing screen - shown whenever the sidebar's Docs icon is clicked, mirrors
// BoardHome.tsx's list/create/delete UX closely (including its two-step delete confirm and
// click-outside-closes-menu handling) since Docs and Board are both per-item project folders under
// briefcast_dir(), just with a Y.Doc instead of a canvas as the content.
import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { IoAdd, IoClose, IoDocumentTextOutline, IoEllipsisVertical, IoPin, IoSearch, IoTrashOutline } from "react-icons/io5";
import * as Y from "yjs";
import { DocSummary } from "../../utils/docTypes";
import { getPinnedDocIds, toggleDocPin, forgetDocPin } from "../../utils/docLibraryHistory";

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
  // Body-text cache for search, keyed by doc id - list_docs only ever reads meta.json (title/dates),
  // never doc.bin, so searching body text means decoding each doc's Yjs bytes client-side once and
  // caching the result. This is a deliberate full-corpus decode on every DocsHome visit, not a
  // persistent index - acceptable at desktop/local doc-count scale, not meant to scale past that.
  const [bodyCache, setBodyCache] = useState<Record<string, string>>({});

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

  // Deferred until the user actually types into search (not eagerly on every DocsHome mount) -
  // indexing means one load_doc round trip + a Yjs decode per doc, a real cost not worth paying
  // just for landing on this screen, especially as the doc count grows. Once triggered, the
  // missing docs are indexed in parallel rather than one invoke at a time.
  useEffect(() => {
    if (searchQuery.trim().length === 0 || !docs || docs.length === 0) return;
    const missing = docs.filter((d) => !(d.id in bodyCache));
    if (missing.length === 0) return;
    let cancelled = false;

    Promise.all(
      missing.map(async (doc) => {
        try {
          const result = await invoke<{ bytes: number[] }>("load_doc", { id: doc.id });
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, new Uint8Array(result.bytes));
          const text = ydoc.getXmlFragment("default").toString().toLowerCase();
          ydoc.destroy();
          return [doc.id, text] as const;
        } catch (err) {
          // One doc failing to decode shouldn't block indexing the rest - same fail-soft posture
          // as list_docs skipping a corrupt folder.
          console.error(`Failed to index document ${doc.id} for search:`, err);
          return null;
        }
      })
    ).then((results) => {
      if (cancelled) return;
      const decoded = results.filter((r): r is readonly [string, string] => r !== null);
      if (decoded.length === 0) return;
      setBodyCache((prev) => {
        const next = { ...prev };
        for (const [id, text] of decoded) next[id] = text;
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [searchQuery, docs, bodyCache]);

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
      await invoke("create_doc", { id, title, bytes });
      onOpenDoc(id);
    } catch (err) {
      console.error("Failed to create document:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  }, [docs, onOpenDoc]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;
  const filteredDocs = docs?.filter(
    (d) => !isSearching || d.title.toLowerCase().includes(normalizedQuery) || (bodyCache[d.id] ?? "").includes(normalizedQuery)
  );
  const pinnedDocs = filteredDocs?.filter((d) => pinnedIds.includes(d.id)) ?? [];

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
      className="group relative flex flex-col rounded-md bg-white/90 dark:bg-neutral-900/90 border border-gray-200 dark:border-neutral-800 hover:border-blue-400 dark:hover:border-blue-500 text-left transition-colors cursor-pointer"
    >
      <div className="absolute top-1.5 right-1.5 z-10">
        <button
          type="button"
          title="Document options"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDeleteId(null);
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
            className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg overflow-hidden"
          >
            <button
              type="button"
              onClick={() => {
                setPinnedIds(toggleDocPin(doc.id));
                setOpenMenuId(null);
              }}
              className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-50 dark:hover:bg-neutral-700"
            >
              <IoPin size={14} />
              {pinnedIds.includes(doc.id) ? "Unpin document" : "Pin document"}
            </button>
            <button
              type="button"
              onClick={() => (confirmDeleteId === doc.id ? void handleDeleteDoc(doc.id) : setConfirmDeleteId(doc.id))}
              className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
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
    <div className="relative flex flex-col items-center justify-start h-full w-full gap-6 px-8 py-10 overflow-y-auto">
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

          <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-2 text-center">Your documents</p>
          {filteredDocs && filteredDocs.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">{filteredDocs.map(renderCard)}</div>
          ) : (
            <p className="text-center text-sm text-gray-400 dark:text-neutral-500">No documents match "{searchQuery}"</p>
          )}
        </div>
      )}
    </div>
  );
};

export default DocsHome;
