// components/whiteboard/WhiteboardImportModal.tsx
//
// Pro Diagram Interchange modal:
// 1. Markdown Outline -> Mind Map generator (with Right / Balanced / Top-Down auto-layout)
// 2. Mermaid Flowchart/Graph -> Native Whiteboard diagram importer
// 3. Export active Mind Map -> clean Markdown outline (1-click copy for Briefcast Docs)

import React, { memo, useMemo, useState } from "react";
import { IoCheckmark, IoClose, IoCopyOutline } from "react-icons/io5";
import { WhiteboardEdge, WhiteboardNode, WhiteboardPage } from "../../utils/whiteboardTypes";
import { MindmapLayoutMode } from "../../handlers/whiteboardMindmapHandlers";
import {
  exportMindmapToMarkdown,
  parseMarkdownToMindmap,
  parseMermaidToWhiteboard,
} from "../../handlers/whiteboardInterchangeHandlers";

const SAMPLE_MARKDOWN = `# Product Launch Plan
- Research & Positioning
  - [x] User interviews
  - [ ] Competitive matrix
- Engineering
  - Core engine optimization
  - Cross-platform QA
- Marketing
  - Launch video ([Briefcast Docs](https://briefcast.app))
  - Release notes v0.1.7`;

const SAMPLE_MERMAID = `flowchart LR
  subgraph Client
    A([User Action]) --> B[UI Surface]
  end
  subgraph Backend
    B --> C{Cached?}
    C -->|Yes| D[(Fast Cache)]
    C -->|No| E[Compute Worker]
    E --> F[(Primary DB)]
  end`;

type TabId = "markdown" | "mermaid" | "exportMd";

interface WhiteboardImportModalProps {
  page: WhiteboardPage;
  initialTab?: TabId;
  onInsertItems: (nodes: WhiteboardNode[], edges: WhiteboardEdge[]) => void;
  onClose: () => void;
}

const WhiteboardImportModal: React.FC<WhiteboardImportModalProps> = memo(
  ({ page, initialTab = "markdown", onInsertItems, onClose }) => {
    const [tab, setTab] = useState<TabId>(initialTab);
    const [mdInput, setMdInput] = useState(SAMPLE_MARKDOWN);
    const [mdLayout, setMdLayout] = useState<MindmapLayoutMode>("balanced");
    const [mermaidInput, setMermaidInput] = useState(SAMPLE_MERMAID);
    const [copied, setCopied] = useState(false);

    const mdPreview = useMemo(() => parseMarkdownToMindmap(mdInput, mdLayout), [mdInput, mdLayout]);
    const mermaidPreview = useMemo(() => parseMermaidToWhiteboard(mermaidInput), [mermaidInput]);
    const exportedMarkdown = useMemo(() => (tab === "exportMd" ? exportMindmapToMarkdown(page) : ""), [tab, page]);

    const handleInsert = () => {
      const built = tab === "markdown" ? mdPreview : mermaidPreview;
      if (built.nodes.length === 0) return;
      onInsertItems(built.nodes, built.edges);
      onClose();
    };

    const handleCopyMarkdown = () => {
      if (!exportedMarkdown) return;
      void navigator.clipboard.writeText(exportedMarkdown).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      });
    };

    return (
      <div
        onPointerDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
      >
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="w-[560px] max-w-[94vw] rounded-xl bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 shadow-2xl overflow-hidden flex flex-col"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-neutral-800">
            <div className="flex items-center gap-1 bg-gray-100 dark:bg-neutral-800 p-0.5 rounded-lg">
              {(
                [
                  { id: "markdown", label: "Markdown → Mind Map" },
                  { id: "mermaid", label: "Mermaid → Diagram" },
                  { id: "exportMd", label: "Export Markdown" },
                ] as { id: TabId; label: string }[]
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    tab === t.id
                      ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                      : "text-gray-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                  }`}
                >
                  {t.label}
                </button>
              ))}
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

          <div className="p-4 flex flex-col gap-3">
            {tab === "markdown" && (
              <>
                <div className="flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-neutral-400">
                  <span>Paste indented bullets, headings, `[x]` tasks, or `[title](url)` links:</span>
                  <select
                    value={mdLayout}
                    onChange={(e) => setMdLayout(e.target.value as MindmapLayoutMode)}
                    className="h-7 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 text-xs text-neutral-700 dark:text-neutral-200 outline-none"
                  >
                    <option value="balanced">Balanced Radial</option>
                    <option value="right">Right Tree</option>
                    <option value="topDown">Top-Down Org</option>
                  </select>
                </div>
                <textarea
                  value={mdInput}
                  onChange={(e) => setMdInput(e.target.value)}
                  rows={10}
                  spellCheck={false}
                  className="w-full rounded-lg border border-gray-200 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-950 p-3 font-mono text-xs text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-400 resize-none"
                />
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-400 dark:text-neutral-500">
                    Will generate {mdPreview.nodes.length} topic{mdPreview.nodes.length === 1 ? "" : "s"} & {mdPreview.edges.length} connection{mdPreview.edges.length === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    disabled={mdPreview.nodes.length === 0}
                    onClick={handleInsert}
                    className="h-8 px-3.5 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-xs font-medium hover:opacity-90 disabled:opacity-40"
                  >
                    Generate Mind Map
                  </button>
                </div>
              </>
            )}

            {tab === "mermaid" && (
              <>
                <p className="text-xs text-gray-500 dark:text-neutral-400">
                  Paste Mermaid `flowchart` / `graph` code (supports shapes, labels, dashed links, and `subgraph` frames):
                </p>
                <textarea
                  value={mermaidInput}
                  onChange={(e) => setMermaidInput(e.target.value)}
                  rows={10}
                  spellCheck={false}
                  className="w-full rounded-lg border border-gray-200 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-950 p-3 font-mono text-xs text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-400 resize-none"
                />
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-400 dark:text-neutral-500">
                    Will generate {mermaidPreview.nodes.length} shape{mermaidPreview.nodes.length === 1 ? "" : "s"} & {mermaidPreview.edges.length} connector{mermaidPreview.edges.length === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    disabled={mermaidPreview.nodes.length === 0}
                    onClick={handleInsert}
                    className="h-8 px-3.5 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-xs font-medium hover:opacity-90 disabled:opacity-40"
                  >
                    Generate Diagram
                  </button>
                </div>
              </>
            )}

            {tab === "exportMd" && (
              <>
                <p className="text-xs text-gray-500 dark:text-neutral-400">
                  Clean indented Markdown outline of the current page (ready to paste into Briefcast Docs):
                </p>
                <textarea
                  readOnly
                  value={exportedMarkdown || "No topics or labeled nodes on this page yet."}
                  rows={10}
                  className="w-full rounded-lg border border-gray-200 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-950 p-3 font-mono text-xs text-neutral-800 dark:text-neutral-100 outline-none resize-none"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={!exportedMarkdown}
                    onClick={handleCopyMarkdown}
                    className="flex items-center gap-1.5 h-8 px-3.5 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-xs font-medium hover:opacity-90 disabled:opacity-40"
                  >
                    {copied ? <IoCheckmark size={14} /> : <IoCopyOutline size={14} />}
                    {copied ? "Copied!" : "Copy Markdown"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
);

WhiteboardImportModal.displayName = "WhiteboardImportModal";

export default WhiteboardImportModal;
