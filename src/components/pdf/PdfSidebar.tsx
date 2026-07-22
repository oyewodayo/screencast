// components/pdf/PdfSidebar.tsx
import React, { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { IoDocumentTextOutline } from "react-icons/io5";
import { IoIosArrowForward } from "react-icons/io";
import PdfThumbnail from "./PdfThumbnail";

export type PdfSidebarView = "thumbnails" | "outline";

interface OutlineNode {
  title: string;
  pageIndex: number | null;
  items: OutlineNode[];
}

// pdf.js's outline items are dynamically shaped (dest may be a name string, an explicit
// destination array, or absent when the item points at an external `url` instead) — there's no
// exported type for the raw node, so this is intentionally loose rather than fighting the lib.
async function resolveOutline(pdfDoc: PDFDocumentProxy, rawItems: any[]): Promise<OutlineNode[]> {
  const nodes: OutlineNode[] = [];
  for (const item of rawItems) {
    let pageIndex: number | null = null;
    try {
      let explicitDest = item.dest;
      if (typeof explicitDest === "string") {
        explicitDest = await pdfDoc.getDestination(explicitDest);
      }
      if (Array.isArray(explicitDest)) {
        pageIndex = await pdfDoc.getPageIndex(explicitDest[0]);
      }
    } catch {
      pageIndex = null; // unresolvable dest (e.g. a broken link) — still show the title, just not clickable
    }
    const children = item.items?.length ? await resolveOutline(pdfDoc, item.items) : [];
    nodes.push({ title: item.title, pageIndex, items: children });
  }
  return nodes;
}

const OutlineRow: React.FC<{
  node: OutlineNode;
  depth: number;
  currentPageIndex: number;
  onPageChange: (pageIndex: number) => void;
}> = ({ node, depth, currentPageIndex, onPageChange }) => {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.items.length > 0;
  const isActive = node.pageIndex !== null && node.pageIndex === currentPageIndex;

  return (
    <div>
      <div
        role="button"
        style={{ paddingLeft: 8 + depth * 16 }}
        className={`flex items-center gap-1 pr-2 py-1.5 rounded-lg cursor-pointer text-sm ${
          isActive
            ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium"
            : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06] text-neutral-700 dark:text-neutral-300"
        } ${node.pageIndex === null ? "opacity-50 cursor-default" : ""}`}
        onClick={() => node.pageIndex !== null && onPageChange(node.pageIndex)}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="shrink-0 flex items-center justify-center w-4 h-4 text-neutral-400"
          >
            <IoIosArrowForward size={10} className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="truncate">{node.title}</span>
      </div>
      {hasChildren && expanded && (
        <div>
          {node.items.map((child, i) => (
            <OutlineRow key={i} node={child} depth={depth + 1} currentPageIndex={currentPageIndex} onPageChange={onPageChange} />
          ))}
        </div>
      )}
    </div>
  );
};

interface PdfSidebarProps {
  pdfDoc: PDFDocumentProxy;
  numPages: number;
  currentPageIndex: number;
  onPageChange: (pageIndex: number) => void;
  view: PdfSidebarView;
}

// Left-docked panel for the two "find my way around a long document" views: a scrollable grid of
// page thumbnails, and the PDF's own table of contents (its "outline", in pdf.js terms) if it has
// one. Scoped to the PdfAnnotator instance currently mounted for `pdfDoc` — Dashboard remounts
// PdfAnnotator wholesale on file switch, so this never needs to invalidate its own outline cache.
const PdfSidebar: React.FC<PdfSidebarProps> = ({ pdfDoc, numPages, currentPageIndex, onPageChange, view }) => {
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [outlineLoading, setOutlineLoading] = useState(false);

  useEffect(() => {
    if (view !== "outline" || outline !== null) return;
    let cancelled = false;
    setOutlineLoading(true);
    pdfDoc
      .getOutline()
      .then(async (raw) => {
        const resolved = raw && raw.length > 0 ? await resolveOutline(pdfDoc, raw) : [];
        if (!cancelled) setOutline(resolved);
      })
      .catch((err) => {
        console.error("Failed to load PDF outline:", err);
        if (!cancelled) setOutline([]);
      })
      .finally(() => {
        if (!cancelled) setOutlineLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, pdfDoc, outline]);

  return (
    <div className="w-56 shrink-0 h-full flex flex-col bg-white/70 dark:bg-neutral-900/70 backdrop-blur-xl border-r border-black/[0.06] dark:border-white/[0.08]">
      {view === "thumbnails" ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col items-center gap-1">
          {Array.from({ length: numPages }, (_, i) => (
            <PdfThumbnail key={i} pdfDoc={pdfDoc} pageIndex={i} isActive={i === currentPageIndex} onSelect={onPageChange} />
          ))}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {outlineLoading ? (
            <div className="text-sm text-neutral-400 dark:text-neutral-500 italic p-3">Loading contents…</div>
          ) : !outline || outline.length === 0 ? (
            <div className="flex flex-col items-center gap-2 text-neutral-400 dark:text-neutral-500 text-sm p-6 text-center">
              <IoDocumentTextOutline size={22} />
              No table of contents
            </div>
          ) : (
            outline.map((node, i) => (
              <OutlineRow key={i} node={node} depth={0} currentPageIndex={currentPageIndex} onPageChange={onPageChange} />
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default PdfSidebar;
