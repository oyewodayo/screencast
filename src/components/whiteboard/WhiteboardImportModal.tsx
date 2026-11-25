// components/whiteboard/WhiteboardImportModal.tsx
//
// Pro Diagram & Slide Interchange modal:
// 1. Slides Import: PowerPoint (.pptx editable), PDF Slide Decks (.pdf pixel-perfect), and
//    Google Slides direct link import (Editable .pptx or Exact Visual .pdf)
// 2. Markdown Outline -> Mind Map generator (with Right / Balanced / Top-Down auto-layout)
// 3. Mermaid Flowchart/Graph -> Native Whiteboard diagram importer
// 4. Export active Mind Map -> clean Markdown outline (1-click copy for Briefcast Docs)

import React, { memo, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  IoCheckmark,
  IoClose,
  IoCloudDownloadOutline,
  IoCopyOutline,
  IoDocumentOutline,
  IoEaselOutline,
} from "react-icons/io5";
import { WhiteboardEdge, WhiteboardNode, WhiteboardPage } from "../../utils/whiteboardTypes";
import { MindmapLayoutMode } from "../../handlers/whiteboardMindmapHandlers";
import {
  exportMindmapToMarkdown,
  parseMarkdownToMindmap,
  parseMermaidToWhiteboard,
} from "../../handlers/whiteboardInterchangeHandlers";
import {
  GoogleSlidesImportFormat,
  importPdfSlides,
  importPptxSlides,
  layoutImportedSlides,
  parseGoogleSlidesInput,
  SlideImageSaver,
  SlideImportPlacement,
} from "../../handlers/whiteboardSlidesImport";

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

export type WhiteboardImportTabId = "slides" | "markdown" | "mermaid" | "exportMd";

interface WhiteboardImportModalProps {
  page: WhiteboardPage;
  initialTab?: WhiteboardImportTabId;
  onInsertItems: (nodes: WhiteboardNode[], edges: WhiteboardEdge[]) => void;
  onAppendPages?: (pages: WhiteboardPage[]) => void;
  onSaveSlideImage?: SlideImageSaver;
  onClose: () => void;
}

const WhiteboardImportModal: React.FC<WhiteboardImportModalProps> = memo(
  ({ page, initialTab = "slides", onInsertItems, onAppendPages, onSaveSlideImage, onClose }) => {
    const [tab, setTab] = useState<WhiteboardImportTabId>(initialTab);
    const [mdInput, setMdInput] = useState(SAMPLE_MARKDOWN);
    const [mdLayout, setMdLayout] = useState<MindmapLayoutMode>("balanced");
    const [mermaidInput, setMermaidInput] = useState(SAMPLE_MERMAID);
    const [copied, setCopied] = useState(false);

    // Slides import state
    const [googleUrl, setGoogleUrl] = useState("");
    const [googleFormat, setGoogleFormat] = useState<GoogleSlidesImportFormat>("pptx");
    const [placement, setPlacement] = useState<SlideImportPlacement>("frames");
    const [includeNotes, setIncludeNotes] = useState(false);
    const [slideBusyLabel, setSlideBusyLabel] = useState<string | null>(null);
    const [slideError, setSlideError] = useState<string | null>(null);

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

    const finalizeDeck = (deck: Awaited<ReturnType<typeof importPptxSlides>>) => {
      const laidOut = layoutImportedSlides(deck, placement);
      if (placement === "pages" && onAppendPages && laidOut.pages.length > 0) {
        onAppendPages(laidOut.pages);
      } else if (laidOut.nodes.length > 0 || laidOut.edges.length > 0) {
        onInsertItems(laidOut.nodes, laidOut.edges);
      }
      onClose();
    };

    const runSlidesBytesImport = async (bytes: ArrayBuffer | Uint8Array, kind: "pptx" | "pdf") => {
      if (kind === "pptx") {
        const deck = await importPptxSlides(bytes, {
          saveImage: onSaveSlideImage,
          includeSpeakerNotes: includeNotes,
          onProgress: (_cur, _tot, label) => setSlideBusyLabel(label ?? "Importing PowerPoint slides…"),
        });
        finalizeDeck(deck);
      } else {
        if (!onSaveSlideImage) throw new Error("Image storage is not ready yet. Please try again in a moment.");
        const deck = await importPdfSlides(bytes, {
          saveImage: onSaveSlideImage,
          onProgress: (_cur, _tot, label) => setSlideBusyLabel(label ?? "Rendering PDF slides…"),
        });
        finalizeDeck(deck);
      }
    };

    const handlePickSlideFile = async () => {
      if (slideBusyLabel) return;
      setSlideError(null);
      try {
        const picked = await openFileDialog({
          multiple: false,
          filters: [
            { name: "Presentations (PowerPoint & PDF)", extensions: ["pptx", "pdf"] },
            { name: "PowerPoint (.pptx)", extensions: ["pptx"] },
            { name: "PDF Slide Deck (.pdf)", extensions: ["pdf"] },
          ],
        });
        if (!picked || Array.isArray(picked)) return;
        const lower = picked.toLowerCase();
        const kind: "pptx" | "pdf" = lower.endsWith(".pdf") ? "pdf" : "pptx";
        setSlideBusyLabel(kind === "pptx" ? "Reading PowerPoint deck…" : "Reading PDF deck…");
        const buf = await invoke<ArrayBuffer>("read_file_bytes", { path: picked });
        await runSlidesBytesImport(buf, kind);
      } catch (err) {
        console.error("Failed to import slide file:", err);
        setSlideError(err instanceof Error ? err.message : String(err));
      } finally {
        setSlideBusyLabel(null);
      }
    };

    const handleImportGoogleSlides = async () => {
      if (slideBusyLabel) return;
      setSlideError(null);
      const parsed = parseGoogleSlidesInput(googleUrl);
      if (!parsed.ok) {
        setSlideError(parsed.error);
        return;
      }
      try {
        setSlideBusyLabel(
          googleFormat === "pptx"
            ? "Downloading editable Google Slides deck…"
            : "Downloading pixel-perfect Google Slides PDF…"
        );
        const buf = await invoke<ArrayBuffer>("fetch_google_slides_export", {
          presentationId: parsed.presentationId,
          format: googleFormat,
        });
        await runSlidesBytesImport(buf, googleFormat);
      } catch (err) {
        console.error("Failed to import Google Slides:", err);
        setSlideError(err instanceof Error ? err.message : String(err));
      } finally {
        setSlideBusyLabel(null);
      }
    };

    return (
      <div
        onPointerDown={(e) => {
          e.stopPropagation();
          if (!slideBusyLabel) onClose();
        }}
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
      >
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="w-[620px] max-w-[95vw] rounded-xl bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 shadow-2xl overflow-hidden flex flex-col"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-neutral-800 gap-2">
            <div className="flex items-center gap-1 bg-gray-100 dark:bg-neutral-800 p-0.5 rounded-lg overflow-x-auto">
              {(
                [
                  { id: "slides", label: "Slides (PPT / Google / PDF)" },
                  { id: "markdown", label: "Markdown" },
                  { id: "mermaid", label: "Mermaid" },
                  { id: "exportMd", label: "Export MD" },
                ] as { id: WhiteboardImportTabId; label: string }[]
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={Boolean(slideBusyLabel)}
                  onClick={() => setTab(t.id)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
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
              disabled={Boolean(slideBusyLabel)}
              onClick={onClose}
              className="p-1 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-40"
              title="Close"
            >
              <IoClose size={16} />
            </button>
          </div>

          <div className="p-4 flex flex-col gap-3.5">
            {tab === "slides" && (
              <>
                {/* Local File Import: .pptx or .pdf */}
                <div className="rounded-xl border border-gray-200 dark:border-neutral-700/80 bg-gray-50/70 dark:bg-neutral-800/40 p-3.5 flex flex-col gap-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-neutral-800 dark:text-neutral-100 flex items-center gap-1.5">
                        <IoEaselOutline size={15} className="text-indigo-500" />
                        PowerPoint (.pptx) or PDF Slide Deck (.pdf)
                      </p>
                      <p className="text-[11px] text-gray-500 dark:text-neutral-400 mt-0.5">
                        <b>.pptx</b> imports as editable text, shapes, tables, connectors &amp; images. <b>.pdf</b> imports as 100% pixel-perfect 2× slide frames ready for live Pen, Highlighter &amp; Laser annotations.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      disabled={Boolean(slideBusyLabel)}
                      onClick={() => void handlePickSlideFile()}
                      className="flex items-center gap-1.5 h-8 px-3.5 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-xs font-medium hover:opacity-90 disabled:opacity-40 transition"
                    >
                      <IoDocumentOutline size={14} />
                      Choose .pptx or .pdf file…
                    </button>
                    <span className="text-[11px] text-gray-400 dark:text-neutral-500">
                      Tip: You can also drag &amp; drop files directly onto the canvas
                    </span>
                  </div>
                </div>

                {/* Google Slides Direct Link */}
                <div className="rounded-xl border border-gray-200 dark:border-neutral-700/80 bg-gray-50/70 dark:bg-neutral-800/40 p-3.5 flex flex-col gap-2.5">
                  <div>
                    <p className="text-xs font-semibold text-neutral-800 dark:text-neutral-100 flex items-center gap-1.5">
                      <IoCloudDownloadOutline size={15} className="text-blue-500" />
                      Google Slides Link
                    </p>
                    <p className="text-[11px] text-gray-500 dark:text-neutral-400 mt-0.5">
                      Paste any Google Slides link shared as <i>&ldquo;Anyone with the link can view&rdquo;</i> (for private decks, use File → Download → .pptx or .pdf above).
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="url"
                      value={googleUrl}
                      disabled={Boolean(slideBusyLabel)}
                      onChange={(e) => {
                        setGoogleUrl(e.target.value);
                        if (slideError) setSlideError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && googleUrl.trim()) void handleImportGoogleSlides();
                      }}
                      placeholder="https://docs.google.com/presentation/d/…/edit"
                      className="flex-1 h-8 px-2.5 rounded-lg border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-xs text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-500"
                    />
                    <button
                      type="button"
                      disabled={!googleUrl.trim() || Boolean(slideBusyLabel)}
                      onClick={() => void handleImportGoogleSlides()}
                      className="h-8 px-3.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-40 transition shrink-0"
                    >
                      Import
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-neutral-400">
                    <span>Import mode:</span>
                    <div className="inline-flex rounded-md bg-gray-200/70 dark:bg-neutral-800 p-0.5">
                      <button
                        type="button"
                        disabled={Boolean(slideBusyLabel)}
                        onClick={() => setGoogleFormat("pptx")}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                          googleFormat === "pptx"
                            ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                            : "text-gray-500 dark:text-neutral-400"
                        }`}
                      >
                        Editable (.pptx)
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(slideBusyLabel)}
                        onClick={() => setGoogleFormat("pdf")}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                          googleFormat === "pdf"
                            ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                            : "text-gray-500 dark:text-neutral-400"
                        }`}
                      >
                        Pixel-Perfect (.pdf)
                      </button>
                    </div>
                  </div>
                </div>

                {/* Placement & Notes Options */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs text-neutral-600 dark:text-neutral-300">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-500 dark:text-neutral-400">Place slides as:</span>
                    <div className="inline-flex rounded-md bg-gray-100 dark:bg-neutral-800 p-0.5">
                      <button
                        type="button"
                        disabled={Boolean(slideBusyLabel)}
                        onClick={() => setPlacement("frames")}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                          placement === "frames"
                            ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                            : "text-gray-500 dark:text-neutral-400"
                        }`}
                      >
                        Frames on page
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(slideBusyLabel)}
                        onClick={() => setPlacement("pages")}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                          placement === "pages"
                            ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                            : "text-gray-500 dark:text-neutral-400"
                        }`}
                      >
                        Separate pages
                      </button>
                    </div>
                  </div>
                  <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-neutral-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={includeNotes}
                      disabled={Boolean(slideBusyLabel)}
                      onChange={(e) => setIncludeNotes(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    Speaker notes as sticky notes
                  </label>
                </div>

                {slideBusyLabel && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300 text-xs font-medium">
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin shrink-0" />
                    <span>{slideBusyLabel}</span>
                  </div>
                )}

                {slideError && (
                  <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300 text-xs leading-relaxed">
                    {slideError}
                  </div>
                )}
              </>
            )}

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
                    Will generate {mdPreview.nodes.length} topic{mdPreview.nodes.length === 1 ? "" : "s"} &amp; {mdPreview.edges.length} connection{mdPreview.edges.length === 1 ? "" : "s"}
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
                    Will generate {mermaidPreview.nodes.length} shape{mermaidPreview.nodes.length === 1 ? "" : "s"} &amp; {mermaidPreview.edges.length} connector{mermaidPreview.edges.length === 1 ? "" : "s"}
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
