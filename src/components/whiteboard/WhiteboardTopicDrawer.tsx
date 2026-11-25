// components/whiteboard/WhiteboardTopicDrawer.tsx
//
// Compact floating drawer for Mind Map / Roadmap nodes inside Whiteboard.
// Supports both Edit Mode (edit description, add/edit/remove typed resource links, toggle palette
// color, edit checklist/links items, change progress) and Study Mode (read-only description +
// clickable resource links + learner progress pills).

import React, { memo, useCallback, useState } from "react";
import { IoAdd, IoCheckmark, IoClose, IoOpenOutline, IoTrashOutline } from "react-icons/io5";
import {
  MINDMAP_COLOR_KEYS,
  MINDMAP_PALETTE,
  MindmapColorKey,
  MindmapListItem,
  MindmapProgress,
  MindmapResource,
  MindmapResourceType,
} from "../../utils/mindmapTypes";
import { WhiteboardNode } from "../../utils/whiteboardTypes";
import { applyMindmapPaletteKey } from "../../handlers/whiteboardMindmapHandlers";

const RESOURCE_TYPES: MindmapResourceType[] = [
  "article",
  "video",
  "course",
  "docs",
  "book",
  "tool",
  "feed",
  "opensource",
];

const RESOURCE_BADGE_STYLE: Record<MindmapResourceType, { label: string; bg: string; fg: string }> = {
  article: { label: "Article", bg: "#dbeafe", fg: "#1d4ed8" },
  video: { label: "Video", bg: "#fee2e2", fg: "#b91c1c" },
  course: { label: "Course", bg: "#ede9fe", fg: "#6d28d9" },
  docs: { label: "Docs", bg: "#dcfce7", fg: "#15803d" },
  book: { label: "Book", bg: "#fef3c7", fg: "#b45309" },
  tool: { label: "Tool", bg: "#e0f2fe", fg: "#0369a1" },
  feed: { label: "Feed", bg: "#fae8ff", fg: "#a21caf" },
  opensource: { label: "Open Source", bg: "#f1f5f9", fg: "#334155" },
};

const PROGRESS_OPTIONS: { value: MindmapProgress; label: string; activeClass: string }[] = [
  { value: "done", label: "Done", activeClass: "border-emerald-500 bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300" },
  { value: "in-progress", label: "In progress", activeClass: "border-amber-500 bg-amber-50 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300" },
  { value: "skipped", label: "Skipped", activeClass: "border-neutral-400 bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200" },
  { value: "pending", label: "Pending", activeClass: "border-blue-500 bg-blue-50 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300" },
];

interface WhiteboardTopicDrawerProps {
  node: WhiteboardNode;
  studyMode: boolean;
  onUpdateNode: (before: WhiteboardNode, after: WhiteboardNode) => void;
  onClose: () => void;
}

const WhiteboardTopicDrawer: React.FC<WhiteboardTopicDrawerProps> = memo(({ node, studyMode, onUpdateNode, onClose }) => {
  const [newResType, setNewResType] = useState<MindmapResourceType>("article");
  const [newResLabel, setNewResLabel] = useState("");
  const [newResUrl, setNewResUrl] = useState("");
  const [newItemText, setNewItemText] = useState("");
  const [newItemUrl, setNewItemUrl] = useState("");

  const isTopic = node.shapeType === "mindmapTopic" || node.shapeType === "mindmapSubtopic";
  const isChecklist = node.shapeType === "mindmapChecklist";
  const isLinksGroup = node.shapeType === "mindmapLinksGroup";

  const currentProgress: MindmapProgress = node.mindmapProgress ?? "pending";
  const resources = node.mindmapResources ?? [];
  const items = node.mindmapItems ?? [];

  const handleSetProgress = useCallback(
    (progress: MindmapProgress) => {
      onUpdateNode(node, { ...node, mindmapProgress: progress, updatedAt: Date.now() });
    },
    [node, onUpdateNode]
  );

  const handleSetPalette = useCallback(
    (key: MindmapColorKey) => {
      onUpdateNode(node, { ...applyMindmapPaletteKey(node, key), updatedAt: Date.now() });
    },
    [node, onUpdateNode]
  );

  const handleAddResource = useCallback(() => {
    const label = newResLabel.trim();
    const url = newResUrl.trim();
    if (!label && !url) return;
    const next: MindmapResource = {
      id: crypto.randomUUID(),
      type: newResType,
      label: label || url,
      url,
    };
    onUpdateNode(node, { ...node, mindmapResources: [...resources, next], updatedAt: Date.now() });
    setNewResLabel("");
    setNewResUrl("");
  }, [newResLabel, newResUrl, newResType, node, onUpdateNode, resources]);

  const handleDeleteResource = useCallback(
    (id: string) => {
      onUpdateNode(node, {
        ...node,
        mindmapResources: resources.filter((r) => r.id !== id),
        updatedAt: Date.now(),
      });
    },
    [node, onUpdateNode, resources]
  );

  const handleToggleOfficial = useCallback(
    (id: string) => {
      onUpdateNode(node, {
        ...node,
        mindmapResources: resources.map((r) => (r.id === id ? { ...r, official: !r.official } : r)),
        updatedAt: Date.now(),
      });
    },
    [node, onUpdateNode, resources]
  );

  const handleAddListItem = useCallback(() => {
    const text = newItemText.trim();
    if (!text) return;
    const next: MindmapListItem = isChecklist
      ? { id: crypto.randomUUID(), text, checked: false }
      : { id: crypto.randomUUID(), text, url: newItemUrl.trim() };
    onUpdateNode(node, { ...node, mindmapItems: [...items, next], updatedAt: Date.now() });
    setNewItemText("");
    setNewItemUrl("");
  }, [isChecklist, items, newItemText, newItemUrl, node, onUpdateNode]);

  const handleToggleChecklistItem = useCallback(
    (id: string) => {
      onUpdateNode(node, {
        ...node,
        mindmapItems: items.map((it) => (it.id === id ? { ...it, checked: !it.checked } : it)),
        updatedAt: Date.now(),
      });
    },
    [items, node, onUpdateNode]
  );

  const handleDeleteListItem = useCallback(
    (id: string) => {
      onUpdateNode(node, {
        ...node,
        mindmapItems: items.filter((it) => it.id !== id),
        updatedAt: Date.now(),
      });
    },
    [items, node, onUpdateNode]
  );

  return (
    <aside
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute top-3 right-3 bottom-3 z-30 w-[340px] max-w-[90vw] rounded-xl bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 shadow-2xl flex flex-col overflow-hidden"
    >
      <div className="flex items-start gap-2 px-4 py-3 border-b border-gray-100 dark:border-neutral-800">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">
            {studyMode ? "Study Mode" : isChecklist ? "Checklist" : isLinksGroup ? "Links Group" : "Topic Details"}
          </p>
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate mt-0.5">
            {node.text || "Untitled topic"}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800"
          title="Close"
        >
          <IoClose size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {/* Progress pills for topic/subtopic nodes */}
        {isTopic && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500 mb-1.5">Progress</p>
            <div className="flex flex-wrap gap-1.5">
              {PROGRESS_OPTIONS.map((opt) => {
                const active = currentProgress === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSetProgress(opt.value)}
                    className={`h-7 px-2.5 rounded-full text-[11px] font-medium border transition ${
                      active
                        ? opt.activeClass
                        : "border-gray-200 dark:border-neutral-700 text-gray-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-800"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Palette swatches in edit mode */}
        {!studyMode && isTopic && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500 mb-1.5">Topic Color</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {MINDMAP_COLOR_KEYS.map((key) => {
                const pal = MINDMAP_PALETTE[key];
                const active = node.mindmapColorKey === key;
                return (
                  <button
                    key={key}
                    type="button"
                    title={pal.name}
                    onClick={() => handleSetPalette(key)}
                    className={`w-6 h-6 rounded-md border flex items-center justify-center transition ${
                      active ? "ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-neutral-900" : "hover:scale-105"
                    }`}
                    style={{ backgroundColor: pal.background, borderColor: pal.border }}
                  >
                    {active && <IoCheckmark size={12} style={{ color: pal.text }} />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Description / Notes */}
        {isTopic && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500 mb-1.5">Notes & Description</p>
            {studyMode ? (
              node.mindmapDescription ? (
                <p className="text-[13px] leading-relaxed text-gray-700 dark:text-neutral-300 whitespace-pre-wrap">{node.mindmapDescription}</p>
              ) : (
                <p className="text-xs italic text-gray-400 dark:text-neutral-500">No description yet.</p>
              )
            ) : (
              <textarea
                value={node.mindmapDescription ?? ""}
                onChange={(e) => onUpdateNode(node, { ...node, mindmapDescription: e.target.value, updatedAt: Date.now() })}
                rows={4}
                placeholder="Write a summary, key concepts, or study notes for this topic…"
                className="w-full rounded-lg border border-gray-200 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800/70 px-2.5 py-2 text-xs text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-400 dark:focus:border-blue-500 resize-y"
              />
            )}
          </div>
        )}

        {/* Topic Resources */}
        {isTopic && (
          <div className="flex flex-col gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">
              Resources ({resources.length})
            </p>
            {resources.length === 0 && (
              <p className="text-xs text-gray-400 dark:text-neutral-500">No resources attached yet.</p>
            )}
            {resources.map((res) => {
              const badge = RESOURCE_BADGE_STYLE[res.type] ?? RESOURCE_BADGE_STYLE.article;
              return (
                <div
                  key={res.id}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-gray-200 dark:border-neutral-700 text-xs bg-white dark:bg-neutral-800/50"
                >
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ backgroundColor: badge.bg, color: badge.fg }}>
                    {badge.label}
                  </span>
                  {res.url ? (
                    <a
                      href={res.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 min-w-0 truncate text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                    >
                      <span className="truncate">{res.label || res.url}</span>
                      <IoOpenOutline size={12} className="shrink-0 opacity-60" />
                    </a>
                  ) : (
                    <span className="flex-1 min-w-0 truncate text-neutral-700 dark:text-neutral-200">{res.label || "Untitled"}</span>
                  )}
                  {res.official && (
                    <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">Official</span>
                  )}
                  {!studyMode && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleToggleOfficial(res.id)}
                        className="shrink-0 text-[10px] px-1 py-0.5 rounded text-gray-400 hover:text-emerald-600 hover:bg-gray-100 dark:hover:bg-neutral-700"
                        title="Toggle Official badge"
                      >
                        ★
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteResource(res.id)}
                        className="shrink-0 p-0.5 text-gray-400 hover:text-red-500"
                        title="Remove resource"
                      >
                        <IoTrashOutline size={13} />
                      </button>
                    </>
                  )}
                </div>
              );
            })}

            {!studyMode && (
              <div className="mt-1 p-2.5 rounded-lg bg-gray-50 dark:bg-neutral-800/70 border border-gray-200/80 dark:border-neutral-700/80 flex flex-col gap-1.5">
                <div className="flex gap-1.5">
                  <select
                    value={newResType}
                    onChange={(e) => setNewResType(e.target.value as MindmapResourceType)}
                    className="h-7 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-1.5 text-[11px] text-neutral-700 dark:text-neutral-200 outline-none"
                  >
                    {RESOURCE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {RESOURCE_BADGE_STYLE[t].label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={newResLabel}
                    onChange={(e) => setNewResLabel(e.target.value)}
                    placeholder="Title"
                    className="flex-1 min-w-0 h-7 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 text-xs text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-400"
                  />
                </div>
                <div className="flex gap-1.5">
                  <input
                    type="url"
                    value={newResUrl}
                    onChange={(e) => setNewResUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddResource();
                      }
                    }}
                    placeholder="https://…"
                    className="flex-1 min-w-0 h-7 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 text-xs text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-400"
                  />
                  <button
                    type="button"
                    onClick={handleAddResource}
                    className="h-7 px-2.5 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[11px] font-medium flex items-center gap-1 hover:opacity-90"
                  >
                    <IoAdd size={13} /> Add
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Checklist / LinksGroup item editor */}
        {(isChecklist || isLinksGroup) && (
          <div className="flex flex-col gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">
              {isChecklist ? "Checklist Items" : "Links"} ({items.length})
            </p>
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-neutral-700 text-xs">
                {isChecklist && (
                  <input
                    type="checkbox"
                    checked={Boolean(item.checked)}
                    onChange={() => handleToggleChecklistItem(item.id)}
                    className="rounded accent-emerald-600 cursor-pointer"
                  />
                )}
                {isLinksGroup && item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer" className="flex-1 truncate text-blue-600 dark:text-blue-400 hover:underline">
                    {item.text}
                  </a>
                ) : (
                  <span className={`flex-1 truncate ${item.checked ? "line-through opacity-55" : ""}`}>{item.text}</span>
                )}
                {!studyMode && (
                  <button
                    type="button"
                    onClick={() => handleDeleteListItem(item.id)}
                    className="p-0.5 text-gray-400 hover:text-red-500"
                    title="Delete item"
                  >
                    <IoTrashOutline size={13} />
                  </button>
                )}
              </div>
            ))}
            {!studyMode && (
              <div className="flex flex-col gap-1.5 mt-1 p-2.5 rounded-lg bg-gray-50 dark:bg-neutral-800/70 border border-gray-200/80 dark:border-neutral-700/80">
                <input
                  type="text"
                  value={newItemText}
                  onChange={(e) => setNewItemText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddListItem();
                    }
                  }}
                  placeholder={isChecklist ? "Add checklist item…" : "Link label…"}
                  className="h-7 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 text-xs outline-none focus:border-blue-400"
                />
                {isLinksGroup && (
                  <input
                    type="url"
                    value={newItemUrl}
                    onChange={(e) => setNewItemUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddListItem();
                      }
                    }}
                    placeholder="https://…"
                    className="h-7 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 text-xs outline-none focus:border-blue-400"
                  />
                )}
                <button
                  type="button"
                  onClick={handleAddListItem}
                  className="self-end h-7 px-2.5 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[11px] font-medium flex items-center gap-1 hover:opacity-90"
                >
                  <IoAdd size={13} /> Add item
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
});

WhiteboardTopicDrawer.displayName = "WhiteboardTopicDrawer";

export default WhiteboardTopicDrawer;
