// components/mindmap/MindmapLiveView.tsx
//
// The reader side of a mindmap - what roadmap.sh/cpp actually shows a learner, as opposed to the
// editor that built it. Read-only: the roadmap is laid out for following, not rearranging, and
// clicking a topic opens its resources in a drawer instead of selecting it for editing.
//
// The two things a reader can change are the two that are theirs, not the author's: which topic is
// open, and their own progress on each one. Everything else is deliberately inert - a reader who
// nudges a box out of place while trying to click it has damaged the document for no reason.

import React, { useMemo, useState } from "react";
import { IoClose, IoOpenOutline } from "react-icons/io5";
import {
  MINDMAP_CHECK_GLYPH,
  MINDMAP_FONT_PX,
  MINDMAP_PALETTE,
  MindmapDocument,
  MindmapNode,
  MindmapProgress,
  MindmapResourceType,
  TOPIC_NODE_TYPES,
  nodeItems,
  nodeResources,
  resolveCheckColor,
  resolveCheckStyle,
  resolveProgress,
} from "../../utils/mindmapTypes";
import { computeContentBounds, edgePath } from "../../handlers/mindmapHandlers";

// Colour per resource kind, so a learner can scan a list and tell a video from a reference page
// without reading every label - the same signal roadmap.sh's own badges carry.
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

const PROGRESS_STYLE: Record<MindmapProgress, { ring: string; fill: string }> = {
  pending: { ring: "transparent", fill: "transparent" },
  done: { ring: "#16a34a", fill: "rgba(22,163,74,0.20)" },
  "in-progress": { ring: "#eab308", fill: "rgba(234,179,8,0.20)" },
  skipped: { ring: "#9ca3af", fill: "rgba(156,163,175,0.22)" },
};

interface MindmapLiveViewProps {
  doc: MindmapDocument;
  // Progress is the one edit a reader makes, so it still routes through the store and is undoable
  // like any other change to the document.
  onSetProgress: (node: MindmapNode, progress: MindmapProgress) => void;
}

const MindmapLiveView: React.FC<MindmapLiveViewProps> = ({ doc, onSetProgress }) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const openNode = openId ? doc.nodes.find((n) => n.id === openId) ?? null : null;

  // The whole roadmap is scaled to fit its container rather than pan/zoomed: a reader wants to see
  // the shape of the subject at a glance, and navigating a canvas is a skill the editor asks for
  // that the reader shouldn't have to learn.
  const bounds = useMemo(() => computeContentBounds(doc), [doc]);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);

  const total = doc.nodes.filter((n) => TOPIC_NODE_TYPES.has(n.type)).length;
  const completed = doc.nodes.filter((n) => resolveProgress(n) === "done").length;

  return (
    <div className="relative w-full h-full overflow-auto bg-white dark:bg-neutral-950">
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2.5 border-b border-gray-200 dark:border-neutral-800 bg-white/90 dark:bg-neutral-950/90 backdrop-blur">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold truncate">{doc.name}</h1>
          {doc.description && <p className="text-[11px] text-gray-500 dark:text-neutral-400 truncate">{doc.description}</p>}
        </div>
        {total > 0 && (
          <div className="ml-auto flex items-center gap-2 text-[11px] text-gray-500 dark:text-neutral-400">
            <div className="w-28 h-1.5 rounded-full bg-gray-200 dark:bg-neutral-800 overflow-hidden">
              <div className="h-full bg-green-500 transition-all" style={{ width: `${(completed / total) * 100}%` }} />
            </div>
            {completed} / {total} done
          </div>
        )}
      </div>

      <div className="p-6 flex justify-center">
        <svg viewBox={`${bounds.minX} ${bounds.minY} ${width} ${height}`} style={{ width: "100%", maxWidth: 1100, height: "auto" }}>
          {doc.edges.map((edge) => {
            const s = doc.nodes.find((n) => n.id === edge.sourceId);
            const t = doc.nodes.find((n) => n.id === edge.targetId);
            if (!s || !t) return null;
            return <path key={edge.id} d={edgePath(s, edge.sourceSide, t, edge.targetSide)} fill="none" stroke="#2b7fff" strokeWidth={2.5} strokeDasharray={edge.style === "dashed" ? "1 7" : undefined} strokeLinecap="round" />;
          })}

          {doc.nodes.map((node) => {
            const palette = MINDMAP_PALETTE[node.colorKey];
            const fontPx = MINDMAP_FONT_PX[node.fontSize];
            const clickable = TOPIC_NODE_TYPES.has(node.type);
            const progress = resolveProgress(node);
            const progressStyle = PROGRESS_STYLE[progress];

            if (node.type === "horizontalLine" || node.type === "verticalLine") {
              return <rect key={node.id} x={node.x} y={node.y} width={node.width} height={node.height} fill={palette.border} />;
            }

            const boxed = node.type === "topic" || node.type === "subtopic" || node.type === "button";
            const isList = node.type === "checklist" || node.type === "linksGroup";
            const checkColor = resolveCheckColor(node);
            const checkGlyph = MINDMAP_CHECK_GLYPH[resolveCheckStyle(node)];
            return (
              <g
                key={node.id}
                style={{ cursor: clickable ? "pointer" : "default" }}
                onClick={() => {
                  if (clickable) setOpenId(node.id);
                }}
              >
                {boxed && <rect x={node.x} y={node.y} width={node.width} height={node.height} fill={palette.background} stroke={palette.border} strokeWidth={2} rx={node.type === "button" ? 6 : 3} />}
                {/* Progress wash over the node - a reader's own state has to be visible on the map
                    itself, not only inside the drawer, or "what have I actually done" needs a click
                    per topic to answer. */}
                {boxed && progress !== "pending" && (
                  <rect x={node.x} y={node.y} width={node.width} height={node.height} fill={progressStyle.fill} stroke={progressStyle.ring} strokeWidth={2.5} rx={node.type === "button" ? 6 : 3} />
                )}
                {/* A checklist/links group is a heading PLUS its rows. Drawing only the heading
                    (what this did before) silently dropped the actual content from the reader's
                    view, which is the one place the rows matter most. */}
                {isList ? (
                  <>
                    <text x={node.x} y={node.y + 14} fontSize={fontPx} fontWeight={700} fill={palette.text} style={{ pointerEvents: "none", userSelect: "none" }}>
                      {node.label}
                    </text>
                    {nodeItems(node).map((item, i) => {
                      const rowY = node.y + 14 + (i + 1) * (fontPx * 1.45);
                      return (
                        <g key={item.id} style={{ pointerEvents: "none", userSelect: "none" }}>
                          {node.type === "checklist" ? (
                            <>
                              <rect
                                x={node.x}
                                y={rowY - fontPx * 0.68}
                                width={fontPx * 0.8}
                                height={fontPx * 0.8}
                                rx={2}
                                fill="none"
                                stroke={item.checked ? checkColor : palette.border}
                                strokeWidth={1.5}
                              />
                              {item.checked && (
                                <text x={node.x + fontPx * 0.4} y={rowY - fontPx * 0.26} textAnchor="middle" dominantBaseline="middle" fontSize={fontPx * 0.7} fill={checkColor}>
                                  {checkGlyph}
                                </text>
                              )}
                            </>
                          ) : (
                            <text x={node.x} y={rowY} fontSize={fontPx} fill="#2b7fff">
                              &#8250;
                            </text>
                          )}
                          <text
                            x={node.x + fontPx * 1.3}
                            y={rowY}
                            fontSize={fontPx - 1}
                            fill={node.type === "linksGroup" ? "#2b7fff" : palette.text}
                            textDecoration={node.type === "linksGroup" ? "underline" : undefined}
                            opacity={node.type === "checklist" && item.checked ? 0.55 : 1}
                          >
                            {item.text}
                          </text>
                        </g>
                      );
                    })}
                  </>
                ) : (
                  <text
                    x={boxed ? node.x + node.width / 2 : node.x}
                    y={node.y + node.height / 2}
                    textAnchor={boxed ? "middle" : "start"}
                    dominantBaseline="middle"
                    fontSize={fontPx}
                    fontWeight={node.bold ? 700 : 400}
                    fontStyle={node.italic ? "italic" : "normal"}
                    fill={palette.text}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {node.label}
                  </text>
                )}
                {clickable && nodeResources(node).length > 0 && (
                  <circle cx={node.x + node.width - 6} cy={node.y + 6} r={4} fill="#2b7fff">
                    <title>{nodeResources(node).length} resources</title>
                  </circle>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Topic drawer - the reason a roadmap beats a flowchart. */}
      {openNode && (
        <>
          <div className="fixed inset-0 bg-black/20 z-20" onClick={() => setOpenId(null)} />
          <aside className="fixed top-0 right-0 bottom-0 w-[380px] max-w-[92vw] z-30 bg-white dark:bg-neutral-900 border-l border-gray-200 dark:border-neutral-800 shadow-2xl flex flex-col">
            <div className="flex items-start gap-2 p-4 border-b border-gray-100 dark:border-neutral-800">
              <h2 className="text-base font-semibold flex-1 min-w-0">{openNode.label}</h2>
              <button type="button" onClick={() => setOpenId(null)} className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-neutral-800" title="Close">
                <IoClose size={18} />
              </button>
            </div>

            <div className="p-4 flex flex-col gap-4 overflow-y-auto">
              <div className="flex flex-wrap gap-1.5">
                {(["done", "in-progress", "skipped", "pending"] as MindmapProgress[]).map((p) => {
                  const active = resolveProgress(openNode) === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => onSetProgress(openNode, p)}
                      className={`h-7 px-2.5 rounded-full text-[11px] font-medium border transition ${
                        active ? "border-violet-400 bg-violet-50 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300" : "border-gray-200 dark:border-neutral-700 hover:bg-gray-50 dark:hover:bg-neutral-800"
                      }`}
                    >
                      {p === "in-progress" ? "In progress" : p.charAt(0).toUpperCase() + p.slice(1)}
                    </button>
                  );
                })}
              </div>

              {openNode.description ? (
                <p className="text-[13px] leading-relaxed text-gray-700 dark:text-neutral-300 whitespace-pre-wrap">{openNode.description}</p>
              ) : (
                <p className="text-[12px] italic text-gray-400 dark:text-neutral-500">No description yet.</p>
              )}

              <div className="flex flex-col gap-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">Resources</h3>
                {nodeResources(openNode).length === 0 && <p className="text-[12px] text-gray-400 dark:text-neutral-500">No resources linked to this topic yet.</p>}
                {nodeResources(openNode).map((res) => {
                  const badge = RESOURCE_BADGE_STYLE[res.type];
                  const body = (
                    <>
                      <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: badge.bg, color: badge.fg }}>
                        {badge.label}
                      </span>
                      <span className="flex-1 min-w-0 truncate">{res.label || res.url || "Untitled resource"}</span>
                      {res.official && <span className="shrink-0 text-[10px] text-green-600 dark:text-green-400 font-medium">Official</span>}
                      {res.url && <IoOpenOutline size={13} className="shrink-0 opacity-50" />}
                    </>
                  );
                  // A resource with no URL yet is still listed (the author may be part-way through
                  // filling it in) but isn't a link, so it can't open a blank tab.
                  return res.url ? (
                    <a
                      key={res.id}
                      href={res.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-gray-200 dark:border-neutral-700 text-[12px] hover:border-violet-400 hover:bg-violet-50/40 dark:hover:bg-violet-500/10 transition"
                    >
                      {body}
                    </a>
                  ) : (
                    <div key={res.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-dashed border-gray-200 dark:border-neutral-700 text-[12px] opacity-70">
                      {body}
                    </div>
                  );
                })}
              </div>
            </div>
          </aside>
        </>
      )}
    </div>
  );
};

export default MindmapLiveView;
