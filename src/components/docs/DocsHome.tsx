// components/docs/DocsHome.tsx
//
// The Docs feature's landing screen - shown whenever the sidebar's Docs icon is clicked, mirrors
// BoardHome.tsx's list/create/delete UX closely (including its two-step delete confirm and
// click-outside-closes-menu handling) since Docs and Board are both per-item project folders under
// briefcast_dir(), just with a Y.Doc instead of a canvas as the content.
import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { IoAdd, IoDocumentTextOutline, IoEllipsisVertical, IoTrashOutline } from "react-icons/io5";
import * as Y from "yjs";
import { DocSummary } from "../../utils/docTypes";

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
      await invoke("delete_doc", { id });
      setOpenMenuId(null);
      setConfirmDeleteId(null);
      setDocs((prev) => prev?.filter((d) => d.id !== id) ?? prev);
    } catch (err) {
      console.error("Failed to delete document:", err);
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
        {error && <p className="text-red-500 dark:text-red-400 text-xs">{error}</p>}
      </div>

      {docs && docs.length > 0 && (
        <div className="relative w-full max-w-3xl">
          <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-2 text-center">Your documents</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {docs.map((doc) => (
              // A plain div (not <button>) - it needs to contain the 3-dot menu's own <button>,
              // and nested interactive elements aren't valid HTML/accessible; role="button" +
              // tabIndex + onKeyDown keep it keyboard-operable instead.
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
                      className="absolute right-0 top-full mt-1 w-40 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg overflow-hidden"
                    >
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

                <div className="aspect-video rounded-t-md overflow-hidden bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
                  <IoDocumentTextOutline size={22} className="text-gray-300 dark:text-neutral-600" />
                </div>
                <div className="px-2.5 py-2">
                  <p className="text-sm text-gray-700 dark:text-neutral-200 truncate">{doc.title || "Untitled document"}</p>
                  <p className="text-xs text-gray-400 dark:text-neutral-500">{formatUpdatedAt(doc.updated_at)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default DocsHome;
