// components/mindmap/MindmapPanel.tsx
//
// The Mindmap editor's right-hand inspector, in two tabs:
//
//   Properties     - what the node looks like and where it sits (label, type, geometry, colour,
//                    font step, layering) plus the directional Add Topic control.
//   Content & Links- what the node MEANS to a reader: its description and its curated resource
//                    list, plus the progress state. This tab is the reason the feature exists -
//                    a roadmap without resources behind its topics is just a flowchart.
//
// The Content tab is only meaningful for TOPIC_NODE_TYPES; for anything else it says so rather than
// offering controls that would write fields nothing ever reads.

import React from "react";
import { IoAddOutline, IoTrashOutline } from "react-icons/io5";
import { TbStackBack, TbStackFront } from "react-icons/tb";
import {
  MINDMAP_CHECK_GLYPH,
  MINDMAP_CHECK_STYLES,
  MINDMAP_COLOR_KEYS,
  MINDMAP_FONT_SIZES,
  MINDMAP_PALETTE,
  MINDMAP_TYPE_LABEL,
  MindmapColorKey,
  MindmapFontSize,
  MindmapNode,
  MindmapNodeType,
  MindmapProgress,
  MindmapResource,
  MindmapResourceType,
  MindmapSide,
  MindmapCheckStyle,
  MindmapListItem,
  TOPIC_NODE_TYPES,
  nodeItems,
  nodeResources,
  resolveCheckColor,
  resolveCheckStyle,
  resolveProgress,
} from "../../utils/mindmapTypes";
import { canAutoSize } from "../../handlers/mindmapHandlers";

const INPUT_CLASS =
  "w-full h-8 px-2 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20 transition";
const NUM_CLASS =
  "w-full h-7 px-2 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs tabular-nums outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20 transition";
const BTN_CLASS =
  "h-7 px-2 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs font-medium hover:bg-gray-50 dark:hover:bg-neutral-700 active:scale-[0.98] disabled:opacity-40 transition";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500 select-none">{children}</h3>;
}

const RESOURCE_TYPES: MindmapResourceType[] = ["article", "video", "course", "docs", "book", "tool", "feed", "opensource"];

// Short badge text per resource type - roadmap.sh leads with this so a learner can see at a glance
// whether a link is a two-minute read or a twelve-hour course before committing to it.
const RESOURCE_BADGE: Record<MindmapResourceType, string> = {
  article: "Article",
  video: "Video",
  course: "Course",
  docs: "Docs",
  book: "Book",
  tool: "Tool",
  feed: "Feed",
  opensource: "Open Source",
};

const PROGRESS_OPTIONS: { value: MindmapProgress; label: string; color: string }[] = [
  { value: "pending", label: "Pending", color: "#9ca3af" },
  { value: "in-progress", label: "In progress", color: "#eab308" },
  { value: "done", label: "Done", color: "#16a34a" },
  { value: "skipped", label: "Skipped", color: "#6b7280" },
];

interface MindmapPanelProps {
  selected: MindmapNode[];
  onUpdate: (patch: Partial<MindmapNode>) => void;
  onAddTopic: (parent: MindmapNode, side: MindmapSide) => void;
  onAutoSize: (node: MindmapNode) => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDelete: () => void;
  // Opens a file picker and imports the chosen image into this mindmap's assets folder. Owned by the
  // editor, which has the mindmap id and the store.
  onChooseImage?: (node: MindmapNode) => void;
}

const MindmapPanel: React.FC<MindmapPanelProps> = ({ selected, onUpdate, onAddTopic, onAutoSize, onBringToFront, onSendToBack, onDelete, onChooseImage }) => {
  const [tab, setTab] = React.useState<"properties" | "content">("properties");
  if (selected.length === 0) return null;
  const node = selected[0];
  const single = selected.length === 1;
  const isTopic = TOPIC_NODE_TYPES.has(node.type);
  // A divider is a coloured rule with no text of its own - Label, Auto-Size and the whole font block
  // would all be controls that either do nothing or, in Auto-Size's case, actively break it (it has
  // no text to size to, and its height IS its thickness).
  const isLine = !canAutoSize(node);
  const isList = node.type === "checklist" || node.type === "linksGroup";
  const items = nodeItems(node);
  const resources = nodeResources(node);

  const updateResources = (next: MindmapResource[]) => onUpdate({ resources: next });

  return (
    <div className="absolute top-3 right-3 bottom-3 w-72 bg-white/90 dark:bg-neutral-900/90 backdrop-blur-xl border border-gray-200/80 dark:border-neutral-700/80 rounded-xl shadow-xl shadow-black/5 flex flex-col overflow-hidden text-neutral-800 dark:text-neutral-200">
      <div className="shrink-0 flex items-center gap-1 p-1.5 border-b border-gray-100 dark:border-neutral-800">
        {(["properties", "content"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex-1 h-7 rounded-lg text-xs font-medium transition ${
              tab === t ? "bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300" : "text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
            }`}
          >
            {t === "properties" ? "Properties" : "Content & Links"}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
        {tab === "properties" ? (
          <>
            {!single && <p className="text-xs text-gray-500 dark:text-neutral-400">{selected.length} nodes selected — colour, font and layering apply to all.</p>}

            {single && !isLine && (
              <div className="flex flex-col gap-1.5">
                <SectionLabel>Label</SectionLabel>
                <input type="text" value={node.label} onChange={(e) => onUpdate({ label: e.target.value })} className={INPUT_CLASS} />
              </div>
            )}

            {single && (
              <div className="flex flex-col gap-1.5">
                <SectionLabel>Type</SectionLabel>
                <select value={node.type} onChange={(e) => onUpdate({ type: e.target.value as MindmapNodeType })} className={INPUT_CLASS}>
                  {(Object.keys(MINDMAP_TYPE_LABEL) as MindmapNodeType[]).map((t) => (
                    <option key={t} value={t}>
                      {MINDMAP_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {single && (
              <div className="flex flex-col gap-1.5">
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["X", Math.round(node.x), (v: number) => onUpdate({ x: v })],
                      ["Y", Math.round(node.y), (v: number) => onUpdate({ y: v })],
                      ["W", Math.round(node.width), (v: number) => onUpdate({ width: Math.max(20, v) })],
                      ["H", Math.round(node.height), (v: number) => onUpdate({ height: Math.max(2, v) })],
                    ] as [string, number, (v: number) => void][]
                  ).map(([label, value, apply]) => (
                    <label key={label} className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-neutral-400">
                      <span className="w-3">{label}</span>
                      <input
                        type="number"
                        value={value}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) apply(n);
                        }}
                        className={NUM_CLASS}
                      />
                    </label>
                  ))}
                </div>
                {!isLine && (
                  <button type="button" onClick={() => onAutoSize(node)} className={`${BTN_CLASS} w-full`} title="Shrink or grow the box to fit its own text">
                    ↔ Auto-Size
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <SectionLabel>Layering</SectionLabel>
              <div className="flex items-center gap-1">
                <button type="button" onClick={onBringToFront} className={`${BTN_CLASS} flex-1 flex items-center justify-center gap-1`} title="Bring to front">
                  <TbStackFront size={14} /> Front
                </button>
                <button type="button" onClick={onSendToBack} className={`${BTN_CLASS} flex-1 flex items-center justify-center gap-1`} title="Send to back">
                  <TbStackBack size={14} /> Back
                </button>
              </div>
            </div>

            {!isLine && (
            <div className="flex flex-col gap-1.5">
              <SectionLabel>Font size</SectionLabel>
              <div className="flex items-center gap-1">
                {MINDMAP_FONT_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => onUpdate({ fontSize: size as MindmapFontSize })}
                    className={`flex-1 h-7 rounded-md border text-[11px] font-medium transition ${
                      node.fontSize === size
                        ? "border-violet-400 bg-violet-50 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300"
                        : "border-gray-200 dark:border-neutral-700 hover:bg-gray-50 dark:hover:bg-neutral-800"
                    }`}
                  >
                    {size}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onUpdate({ bold: !node.bold })}
                  className={`${BTN_CLASS} flex-1 font-bold ${node.bold ? "bg-violet-50 dark:bg-violet-500/20 border-violet-400" : ""}`}
                >
                  B
                </button>
                <button
                  type="button"
                  onClick={() => onUpdate({ italic: !node.italic })}
                  className={`${BTN_CLASS} flex-1 italic ${node.italic ? "bg-violet-50 dark:bg-violet-500/20 border-violet-400" : ""}`}
                >
                  I
                </button>
              </div>
            </div>
            )}

            <div className="flex flex-col gap-1.5">
              <SectionLabel>{isLine ? "Line colour" : "Node colour"}</SectionLabel>
              {/* Eight fixed palette keys rather than a colour picker - see MindmapColorKey's own
                  doc comment for why a roadmap's coherence depends on that constraint. */}
              <div className="grid grid-cols-8 gap-1">
                {MINDMAP_COLOR_KEYS.map((key) => {
                  const entry = MINDMAP_PALETTE[key as MindmapColorKey];
                  const active = node.colorKey === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => onUpdate({ colorKey: key as MindmapColorKey })}
                      title={entry.name}
                      className={`h-7 rounded-md text-[10px] font-semibold transition ${active ? "ring-2 ring-violet-500 ring-offset-1 dark:ring-offset-neutral-900" : ""}`}
                      style={{ background: entry.background, border: `1.5px solid ${entry.border}`, color: entry.text }}
                    >
                      {key}
                    </button>
                  );
                })}
              </div>
            </div>

            {single && node.type === "image" && (
              <div className="flex flex-col gap-1.5">
                <SectionLabel>Image</SectionLabel>
                <button
                  type="button"
                  onClick={() => onChooseImage?.(node)}
                  disabled={!onChooseImage}
                  className="w-full h-8 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-gray-300 dark:border-neutral-600 text-xs font-medium text-gray-600 dark:text-neutral-300 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50/50 dark:hover:bg-violet-500/10 transition disabled:opacity-40"
                >
                  {node.assetFileName ? "Replace image…" : "Choose image…"}
                </button>
                {node.assetFileName && <p className="text-[10px] text-gray-400 dark:text-neutral-500 truncate">Imported into this roadmap.</p>}
                <label className="flex flex-col gap-1 text-[11px] text-gray-500 dark:text-neutral-400">
                  Link URL
                  <input
                    type="url"
                    value={node.linkUrl ?? ""}
                    placeholder="Opens when clicked in Live View"
                    onChange={(e) => onUpdate({ linkUrl: e.target.value })}
                    className={INPUT_CLASS}
                  />
                </label>
              </div>
            )}

            {single && isList && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <SectionLabel>{node.type === "checklist" ? "Checklist items" : "Links"}</SectionLabel>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdate({
                        items: [
                          ...items,
                          {
                            id: crypto.randomUUID(),
                            text: node.type === "checklist" ? "New item" : "New link",
                            ...(node.type === "linksGroup" ? { url: "" } : { checked: false }),
                          },
                        ],
                      })
                    }
                    className={`${BTN_CLASS} flex items-center gap-1`}
                  >
                    <IoAddOutline size={13} /> Add
                  </button>
                </div>
                {items.length === 0 && <p className="text-[10px] text-gray-400 dark:text-neutral-500">No rows yet.</p>}
                {items.map((item, i) => {
                  const patch = (next: Partial<MindmapListItem>) => onUpdate({ items: items.map((it, j) => (i === j ? { ...it, ...next } : it)) });
                  const move = (delta: number) => {
                    const target = i + delta;
                    if (target < 0 || target >= items.length) return;
                    const next = [...items];
                    [next[i], next[target]] = [next[target], next[i]];
                    onUpdate({ items: next });
                  };
                  return (
                    <div key={item.id} className="flex flex-col gap-1 rounded-lg border border-gray-200 dark:border-neutral-700/80 bg-gray-50/60 dark:bg-neutral-800/40 p-1.5">
                      <div className="flex items-center gap-1">
                        {node.type === "checklist" && (
                          <input
                            type="checkbox"
                            checked={item.checked ?? false}
                            onChange={(e) => patch({ checked: e.target.checked })}
                            className="h-3.5 w-3.5 accent-violet-600 shrink-0"
                            title={item.checked ? "Uncheck" : "Check"}
                          />
                        )}
                        <input
                          type="text"
                          value={item.text}
                          onChange={(e) => patch({ text: e.target.value })}
                          className="flex-1 min-w-0 h-6 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[11px]"
                        />
                        {/* Order matters in a checklist - it is a sequence of steps, not a set. */}
                        <button type="button" onClick={() => move(-1)} disabled={i === 0} className="px-1 h-6 rounded text-[10px] border border-gray-200 dark:border-neutral-700 disabled:opacity-30" title="Move up">
                          &#8593;
                        </button>
                        <button
                          type="button"
                          onClick={() => move(1)}
                          disabled={i === items.length - 1}
                          className="px-1 h-6 rounded text-[10px] border border-gray-200 dark:border-neutral-700 disabled:opacity-30"
                          title="Move down"
                        >
                          &#8595;
                        </button>
                        <button
                          type="button"
                          onClick={() => onUpdate({ items: items.filter((_, j) => j !== i) })}
                          className="px-1.5 h-6 rounded text-[10px] border border-gray-200 dark:border-neutral-700 text-red-600 dark:text-red-400"
                          title="Remove row"
                        >
                          &#10005;
                        </button>
                      </div>
                      {node.type === "linksGroup" && (
                        <input
                          type="url"
                          value={item.url ?? ""}
                          placeholder="https://..."
                          onChange={(e) => patch({ url: e.target.value })}
                          className="h-6 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[11px]"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Checkmark appearance. Per-node because one roadmap often carries several checklists
                meaning different things - a green tick and a red cross say opposite things about the
                same row. */}
            {single && node.type === "checklist" && (
              <div className="flex flex-col gap-1.5">
                <SectionLabel>Checkmark</SectionLabel>
                <div className="flex items-center gap-1">
                  {MINDMAP_CHECK_STYLES.map((style) => {
                    const active = resolveCheckStyle(node) === style;
                    return (
                      <button
                        key={style}
                        type="button"
                        onClick={() => onUpdate({ checkStyle: style as MindmapCheckStyle })}
                        title={style}
                        className={`flex-1 h-7 rounded-md border text-xs transition ${
                          active ? "border-violet-400 bg-violet-50 dark:bg-violet-500/20" : "border-gray-200 dark:border-neutral-700 hover:bg-gray-50 dark:hover:bg-neutral-800"
                        }`}
                        style={{ color: resolveCheckColor(node) }}
                      >
                        {MINDMAP_CHECK_GLYPH[style]}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between text-xs text-gray-600 dark:text-neutral-300">
                  <span>Check colour</span>
                  <input
                    type="color"
                    value={resolveCheckColor(node)}
                    onChange={(e) => onUpdate({ checkColor: e.target.value })}
                    className="w-8 h-7 rounded-md border border-gray-200 dark:border-neutral-700 bg-transparent cursor-pointer p-0.5"
                  />
                </div>
              </div>
            )}

            {single && isTopic && (
              <div className="flex flex-col gap-1.5">
                <SectionLabel>Add topic</SectionLabel>
                {/* The same directional add the canvas offers on a selected node, mirrored here so
                    it's discoverable without knowing to look at the node's own arrows. */}
                <div className="grid grid-cols-4 gap-1">
                  {(
                    [
                      ["top", "↑"],
                      ["bottom", "↓"],
                      ["left", "←"],
                      ["right", "→"],
                    ] as [MindmapSide, string][]
                  ).map(([side, glyph]) => (
                    <button key={side} type="button" onClick={() => onAddTopic(node, side)} className={BTN_CLASS} title={`Add a connected topic (${side})`}>
                      {glyph}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="border-t border-gray-100 dark:border-neutral-800 pt-3 flex items-center gap-1">
              <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-neutral-300">
                <input type="checkbox" checked={node.locked ?? false} onChange={(e) => onUpdate({ locked: e.target.checked })} className="h-3.5 w-3.5 accent-violet-600" />
                Locked
              </label>
              <button type="button" onClick={onDelete} className="ml-auto p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-500/10 text-red-600 dark:text-red-400 transition" title="Delete">
                <IoTrashOutline size={16} />
              </button>
            </div>
          </>
        ) : !isTopic ? (
          <p className="text-xs text-gray-500 dark:text-neutral-400">
            Only Title, Topic and Sub Topic nodes carry content and resources — those are the entries a reader actually works through. Change this node's type on the Properties tab to give it
            content.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <SectionLabel>Progress</SectionLabel>
              <div className="grid grid-cols-2 gap-1">
                {PROGRESS_OPTIONS.map((opt) => {
                  const active = resolveProgress(node) === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => onUpdate({ progress: opt.value })}
                      className={`h-7 rounded-md border text-[11px] font-medium flex items-center justify-center gap-1.5 transition ${
                        active ? "border-violet-400 bg-violet-50 dark:bg-violet-500/20" : "border-gray-200 dark:border-neutral-700 hover:bg-gray-50 dark:hover:bg-neutral-800"
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full" style={{ background: opt.color }} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <SectionLabel>Description</SectionLabel>
              <textarea
                value={node.description ?? ""}
                onChange={(e) => onUpdate({ description: e.target.value })}
                rows={5}
                placeholder="What this topic covers, and why it matters…"
                className="w-full px-2 py-1.5 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs leading-relaxed resize-y outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20 transition"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <SectionLabel>Resources</SectionLabel>
                <button
                  type="button"
                  onClick={() => updateResources([...resources, { id: crypto.randomUUID(), type: "article", label: "", url: "" }])}
                  className={`${BTN_CLASS} flex items-center gap-1`}
                >
                  <IoAddOutline size={13} /> Add
                </button>
              </div>
              {resources.length === 0 && <p className="text-[10px] text-gray-400 dark:text-neutral-500">No resources yet. These are what a reader opens when they click this topic.</p>}
              {resources.map((res, i) => (
                <div key={res.id} className="flex flex-col gap-1 rounded-lg border border-gray-200 dark:border-neutral-700/80 bg-gray-50/60 dark:bg-neutral-800/40 p-2">
                  <div className="flex items-center gap-1">
                    <select
                      value={res.type}
                      onChange={(e) => updateResources(resources.map((r, j) => (i === j ? { ...r, type: e.target.value as MindmapResourceType } : r)))}
                      className="h-6 px-1 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[11px]"
                    >
                      {RESOURCE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {RESOURCE_BADGE[t]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => updateResources(resources.filter((_, j) => j !== i))}
                      className="ml-auto px-1.5 h-6 rounded text-[10px] border border-gray-200 dark:border-neutral-700 text-red-600 dark:text-red-400"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                  <input
                    type="text"
                    value={res.label}
                    placeholder="Title"
                    onChange={(e) => updateResources(resources.map((r, j) => (i === j ? { ...r, label: e.target.value } : r)))}
                    className="h-6 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[11px]"
                  />
                  <input
                    type="url"
                    value={res.url}
                    placeholder="https://…"
                    onChange={(e) => updateResources(resources.map((r, j) => (i === j ? { ...r, url: e.target.value } : r)))}
                    className="h-6 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[11px]"
                  />
                  <label className="flex items-center gap-1.5 text-[10px] text-gray-600 dark:text-neutral-300">
                    <input
                      type="checkbox"
                      checked={res.official ?? false}
                      onChange={(e) => updateResources(resources.map((r, j) => (i === j ? { ...r, official: e.target.checked } : r)))}
                      className="h-3 w-3 accent-violet-600"
                    />
                    Official resource
                  </label>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default MindmapPanel;
