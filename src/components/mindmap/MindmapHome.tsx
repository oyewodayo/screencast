// components/mindmap/MindmapHome.tsx
//
// The mindmap picker - a grid of existing roadmaps plus "New mindmap". Same role WhiteboardHome and
// BoardHome play for their own features, and the same thumbnail-backed card layout, so moving
// between the three tools feels like one app rather than three.

import React, { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { IoAddOutline, IoCopyOutline, IoEllipsisHorizontal, IoTrashOutline } from "react-icons/io5";
import { MindmapSummary, createEmptyMindmapDocument } from "../../utils/mindmapTypes";
import { createStarterMindmapDocument } from "../../utils/mindmapTemplate";

interface MindmapHomeProps {
  onOpenMindmap: (id: string) => void;
}

const MindmapHome: React.FC<MindmapHomeProps> = ({ onOpenMindmap }) => {
  const [summaries, setSummaries] = useState<MindmapSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSummaries(await invoke<MindmapSummary[]>("list_mindmaps"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The template is the default, not an option buried behind a choice: an empty grid hides every
  // interaction this tool has, and "what does a roadmap even look like" is the hardest part of
  // starting one. Blank is still offered for someone who already knows what they're building.
  const handleCreate = useCallback(
    async (blank: boolean) => {
      const id = crypto.randomUUID();
      const doc = blank ? createEmptyMindmapDocument(id, "Untitled roadmap") : createStarterMindmapDocument(id, "Untitled roadmap");
      try {
        await invoke("create_mindmap", { id, name: doc.name, json: JSON.stringify(doc) });
        onOpenMindmap(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onOpenMindmap]
  );

  const handleDuplicate = useCallback(
    async (source: MindmapSummary) => {
      setMenuFor(null);
      const newId = crypto.randomUUID();
      try {
        await invoke("duplicate_mindmap", { sourceId: source.id, newId });
        // The copy still carries the original's id/name/timestamps inside its own JSON (the backend
        // deliberately doesn't rewrite document content - see duplicate_mindmap's doc comment), so
        // patch those here before it shows up in the list looking like a duplicate of the original.
        const json = await invoke<string>("load_mindmap", { id: newId });
        const parsed = JSON.parse(json);
        const now = new Date().toISOString();
        await invoke("save_mindmap", { id: newId, json: JSON.stringify({ ...parsed, id: newId, name: `${parsed.name} copy`, createdAt: now, updatedAt: now }) });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh]
  );

  const handleDelete = useCallback(
    async (summary: MindmapSummary) => {
      setMenuFor(null);
      try {
        await invoke("delete_mindmap", { id: summary.id });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh]
  );

  return (
    <div className="w-full h-full overflow-y-auto p-6 bg-white dark:bg-neutral-950" onClick={() => setMenuFor(null)}>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Mindmaps</h1>
          <p className="text-xs text-gray-500 dark:text-neutral-400">Build a learning roadmap: typed topics, connected paths, and curated resources behind each step.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleCreate(true)}
            className="h-9 px-3 rounded-lg border border-gray-200 dark:border-neutral-700 text-xs font-medium hover:bg-gray-50 dark:hover:bg-neutral-800 transition"
            title="Start from an empty canvas"
          >
            Start blank
          </button>
          <button
            type="button"
            onClick={() => void handleCreate(false)}
            className="h-9 px-3 rounded-lg bg-violet-600 text-white text-xs font-semibold flex items-center gap-1.5 hover:bg-violet-700 active:scale-[0.98] transition"
            title="Start from a template you can edit"
          >
            <IoAddOutline size={16} /> New mindmap
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : summaries.length === 0 ? (
        <div className="border border-dashed border-gray-300 dark:border-neutral-700 rounded-xl p-10 text-center">
          <p className="text-sm text-gray-500 dark:text-neutral-400">No mindmaps yet.</p>
          <p className="text-xs text-gray-400 dark:text-neutral-500 mt-1">New mindmaps start from an editable template that shows you the ropes.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">
          {summaries.map((summary) => (
            <div
              key={summary.id}
              onClick={() => onOpenMindmap(summary.id)}
              className="group relative rounded-xl border border-gray-200 dark:border-neutral-800 overflow-hidden cursor-pointer hover:border-violet-400 hover:shadow-md transition bg-white dark:bg-neutral-900"
            >
              <div className="h-28 bg-gray-50 dark:bg-neutral-800 flex items-center justify-center overflow-hidden">
                {summary.thumbnail_path ? (
                  <img src={convertFileSrc(summary.thumbnail_path)} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[11px] text-gray-400">No preview</span>
                )}
              </div>
              <div className="p-2.5">
                <p className="text-xs font-medium truncate text-neutral-800 dark:text-neutral-200">{summary.name}</p>
                <p className="text-[10px] text-gray-500 dark:text-neutral-400 truncate">{summary.description || `${summary.node_count} nodes`}</p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor((prev) => (prev === summary.id ? null : summary.id));
                }}
                className="absolute top-1.5 right-1.5 p-1 rounded-md bg-white/85 dark:bg-neutral-800/85 opacity-0 group-hover:opacity-100 transition"
                title="More"
              >
                <IoEllipsisHorizontal size={14} />
              </button>
              {menuFor === summary.id && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-8 right-1.5 z-10 w-36 rounded-lg border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg py-1 text-xs"
                >
                  <button type="button" onClick={() => handleDuplicate(summary)} className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700">
                    <IoCopyOutline size={13} /> Duplicate
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(summary)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                  >
                    <IoTrashOutline size={13} /> Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MindmapHome;
