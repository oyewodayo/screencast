// components/whiteboard/WhiteboardHome.tsx
//
// The Whiteboard feature's landing screen - shown whenever the sidebar's Whiteboard icon is
// clicked, listing saved whiteboards plus a "New whiteboard" tile. Mirrors BoardHome.tsx's own
// layout/interaction conventions (card grid, 3-dot menu with duplicate/two-step delete confirm,
// search once there's enough cards to search) minus the template/size picker Board's "New board"
// button has - a fresh whiteboard has nothing analogous to pick (no background/size presets yet).
import React, { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { IoAdd, IoCopyOutline, IoEllipsisVertical, IoGitNetworkOutline, IoSearchOutline, IoTrashOutline } from "react-icons/io5";
import { createEmptyWhiteboardDocument, WhiteboardSummary } from "../../utils/whiteboardTypes";

interface WhiteboardHomeProps {
  onOpenWhiteboard: (id: string) => void;
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const WhiteboardHome: React.FC<WhiteboardHomeProps> = ({ onOpenWhiteboard }) => {
  const [whiteboards, setWhiteboards] = useState<WhiteboardSummary[] | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which card's 3-dot menu is open, if any - and, within that menu, whether "Delete" has already
  // been clicked once (turning it into "Confirm delete?"). Same two-step confirm as BoardHome's
  // own menu, since whiteboard deletion is permanent (unlike regular file deletion, which goes to
  // Trash first).
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<WhiteboardSummary[]>("list_whiteboards")
      .then(setWhiteboards)
      .catch((err) => {
        console.error("Failed to list whiteboards:", err);
        setError(err instanceof Error ? err.message : String(err));
        setWhiteboards([]);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Closes an open card menu (and drops any pending delete confirmation with it) on any click
  // outside it - see BoardHome.tsx's own identical effect for why this listens on "click", not
  // "mousedown".
  useEffect(() => {
    if (!openMenuId) return;
    const handleClickOutside = (): void => {
      setOpenMenuId(null);
      setConfirmDeleteId(null);
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [openMenuId]);

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    try {
      const id = crypto.randomUUID();
      const existingCount = whiteboards?.length ?? 0;
      const doc = createEmptyWhiteboardDocument(id, `Whiteboard ${existingCount + 1}`);
      await invoke("create_whiteboard", { id, name: doc.name, json: JSON.stringify(doc) });
      onOpenWhiteboard(id);
    } catch (err) {
      console.error("Failed to create whiteboard:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  }, [whiteboards, onOpenWhiteboard]);

  const handleDeleteWhiteboard = useCallback(async (id: string): Promise<void> => {
    try {
      await invoke("delete_whiteboard", { id });
      setOpenMenuId(null);
      setConfirmDeleteId(null);
      setWhiteboards((prev) => prev?.filter((b) => b.id !== id) ?? prev);
    } catch (err) {
      console.error("Failed to delete whiteboard:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleDuplicateWhiteboard = useCallback(
    async (whiteboard: WhiteboardSummary): Promise<void> => {
      setDuplicatingId(whiteboard.id);
      setOpenMenuId(null);
      setConfirmDeleteId(null);
      try {
        const newId = crypto.randomUUID();
        // duplicate_whiteboard (Rust) only copies files verbatim - load the copy back and patch
        // id/name/timestamps ourselves here, same division of labor as BoardHome's own
        // handleDuplicateBoard.
        await invoke("duplicate_whiteboard", { sourceId: whiteboard.id, newId });
        const json = await invoke<string>("load_whiteboard", { id: newId });
        const doc = JSON.parse(json);
        doc.id = newId;
        doc.name = `${whiteboard.name || "Untitled whiteboard"} copy`;
        const now = new Date().toISOString();
        doc.createdAt = now;
        doc.updatedAt = now;
        await invoke("save_whiteboard", { id: newId, json: JSON.stringify(doc) });
        refresh();
      } catch (err) {
        console.error("Failed to duplicate whiteboard:", err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setDuplicatingId(null);
      }
    },
    [refresh]
  );

  return (
    <div className="relative flex flex-col items-center justify-start h-full w-full gap-6 px-8 py-10 overflow-y-auto">
      <div className="relative flex flex-col items-center gap-3 text-center">
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-gray-200 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
          <IoGitNetworkOutline size={28} />
        </div>
        <div>
          <p className="text-gray-700 dark:text-neutral-200 font-medium">Whiteboards</p>
          <p className="text-gray-500 dark:text-neutral-400 text-sm mt-1">
            Sketch flowcharts and diagrams with shapes and connectors, on an infinite canvas.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={isCreating}
          className="mt-1 flex items-center gap-1.5 px-4 py-2 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <IoAdd size={16} /> {isCreating ? "Creating…" : "New whiteboard"}
        </button>
        {error && <p className="text-red-500 dark:text-red-400 text-xs">{error}</p>}
      </div>

      {whiteboards && whiteboards.length > 0 && (
        <div className="relative w-full max-w-3xl">
          <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-2 text-center">Your whiteboards</p>
          {whiteboards.length > 6 && (
            <div className="relative max-w-xs mx-auto mb-3">
              <IoSearchOutline size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search whiteboards..."
                className="w-full h-8 pl-8 pr-2.5 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-sm text-gray-700 dark:text-neutral-200 outline-none focus:border-blue-400 dark:focus:border-blue-500 transition-colors"
              />
            </div>
          )}
          {(() => {
            const query = searchQuery.trim().toLowerCase();
            const filtered = query ? whiteboards.filter((w) => (w.name || "Untitled whiteboard").toLowerCase().includes(query)) : whiteboards;
            if (filtered.length === 0) {
              return <p className="text-center text-sm text-gray-400 dark:text-neutral-500 py-6">No whiteboards match "{searchQuery.trim()}"</p>;
            }
            return (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {filtered.map((whiteboard) => (
                  // A plain div (not <button>) - it needs to contain the 3-dot menu's own <button>,
                  // and nested interactive elements aren't valid HTML/accessible; role="button" +
                  // tabIndex + onKeyDown keep it keyboard-operable instead.
                  <div
                    key={whiteboard.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenWhiteboard(whiteboard.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenWhiteboard(whiteboard.id);
                      }
                    }}
                    className="group relative flex flex-col rounded-md bg-white/90 dark:bg-neutral-900/90 border border-gray-200 dark:border-neutral-800 hover:border-blue-400 dark:hover:border-blue-500 text-left transition-colors cursor-pointer"
                  >
                    <div className="absolute top-1.5 right-1.5 z-10">
                      <button
                        type="button"
                        title="Whiteboard options"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                          setOpenMenuId((prev) => (prev === whiteboard.id ? null : whiteboard.id));
                        }}
                        className={`p-1 rounded-md bg-black/40 hover:bg-black/60 text-white transition-opacity ${
                          openMenuId === whiteboard.id ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        }`}
                      >
                        <IoEllipsisVertical size={14} />
                      </button>

                      {openMenuId === whiteboard.id && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="absolute right-0 top-full mt-1 w-40 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg overflow-hidden"
                        >
                          <button
                            type="button"
                            onClick={() => void handleDuplicateWhiteboard(whiteboard)}
                            disabled={duplicatingId === whiteboard.id}
                            className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 disabled:opacity-50"
                          >
                            <IoCopyOutline size={14} />
                            {duplicatingId === whiteboard.id ? "Duplicating…" : "Duplicate whiteboard"}
                          </button>
                          <div className="border-t border-gray-100 dark:border-neutral-700/70" />
                          <button
                            type="button"
                            onClick={() => (confirmDeleteId === whiteboard.id ? void handleDeleteWhiteboard(whiteboard.id) : setConfirmDeleteId(whiteboard.id))}
                            className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                          >
                            <IoTrashOutline size={14} />
                            {confirmDeleteId === whiteboard.id ? "Confirm delete?" : "Delete whiteboard"}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="aspect-video rounded-t-md overflow-hidden bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
                      {whiteboard.thumbnail_path ? (
                        <img src={convertFileSrc(whiteboard.thumbnail_path)} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <IoGitNetworkOutline size={22} className="text-gray-300 dark:text-neutral-600" />
                      )}
                    </div>
                    <div className="px-2.5 py-2">
                      <p className="text-sm text-gray-700 dark:text-neutral-200 truncate">{whiteboard.name || "Untitled whiteboard"}</p>
                      <p className="text-xs text-gray-400 dark:text-neutral-500">{formatUpdatedAt(whiteboard.updated_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};

export default WhiteboardHome;
