// components/pdf/CommentsPanel.tsx
import React, { useMemo, useState } from "react";
import { IoChatbubblesOutline, IoSearch, IoClose } from "react-icons/io5";
import { CommentObject } from "../../utils/pdfAnnotationTypes";
import { relativeTime } from "./CommentLayer";

const FILTER_MIN_COMMENTS = 4;

interface CommentsPanelProps {
  comments: CommentObject[]; // already in reading order (see useAnnotationStore)
  currentPageIndices: number[]; // the page, or both pages of the spread, currently on screen
  onOpen: (comment: CommentObject) => void;
}

// Sidebar view listing every comment in the document, grouped by page like a table of contents.
// Picking one jumps to its page and opens it in place (PdfAnnotator -> PdfPage's focusComment).
const CommentsPanel: React.FC<CommentsPanelProps> = ({ comments, currentPageIndices, onOpen }) => {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = q ? comments.filter((c) => c.text.toLowerCase().includes(q) || c.quote.toLowerCase().includes(q)) : comments;
    const byPage: { pageIndex: number; items: CommentObject[] }[] = [];
    for (const c of visible) {
      const last = byPage[byPage.length - 1];
      if (last && last.pageIndex === c.pageIndex) last.items.push(c);
      else byPage.push({ pageIndex: c.pageIndex, items: [c] });
    }
    return byPage;
  }, [comments, query]);

  if (comments.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 text-neutral-400 dark:text-neutral-500 text-sm p-6 text-center">
        <IoChatbubblesOutline size={24} />
        <span className="font-medium text-neutral-500 dark:text-neutral-400">No comments yet</span>
        <span className="text-xs leading-relaxed">Select any text on a page and choose Comment — it'll be collected here.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">Comments</span>
          <span className="px-1.5 min-w-[20px] h-[18px] inline-flex items-center justify-center rounded-full bg-amber-400/20 text-amber-700 dark:text-amber-300 text-[11px] font-semibold tabular-nums">
            {comments.length}
          </span>
        </div>
        {comments.length >= FILTER_MIN_COMMENTS && (
          <div className="mt-2 relative">
            <IoSearch size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Filter comments"
              className="w-full h-7 pl-7 pr-7 rounded-md bg-black/[0.04] dark:bg-white/[0.06] text-[12px] text-neutral-800 dark:text-neutral-100 placeholder:text-neutral-400 outline-none focus:ring-2 focus:ring-amber-300/50"
            />
            {query && (
              <button type="button" aria-label="Clear filter" onClick={() => setQuery("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-neutral-400 hover:text-neutral-700">
                <IoClose size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {groups.length === 0 && <div className="text-xs text-neutral-400 italic px-2 py-4 text-center">No comments match “{query.trim()}”</div>}
        {groups.map(({ pageIndex, items }) => {
          const here = currentPageIndices.includes(pageIndex);
          return (
            <section key={pageIndex} className="mb-1">
              <div className="sticky top-0 z-10 flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-neutral-50/95 dark:bg-neutral-900/95 backdrop-blur text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                {here && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
                <span className={here ? "text-blue-600 dark:text-blue-400" : undefined}>Page {pageIndex + 1}</span>
                {items.length > 1 && <span className="font-normal normal-case tracking-normal">· {items.length}</span>}
              </div>
              {items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onOpen(c)}
                  className="group w-full text-left px-2 py-2 rounded-lg hover:bg-amber-400/[0.08] active:scale-[0.99] transition-[background-color,transform] duration-150"
                >
                  <div className="flex gap-2">
                    <div className="w-[3px] shrink-0 rounded-full bg-amber-400/70 group-hover:bg-amber-400 transition-colors" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11.5px] leading-[1.4] italic text-neutral-500 dark:text-neutral-400 line-clamp-2 break-words">{c.quote}</p>
                      <p className="mt-1 text-[12.5px] leading-[1.45] text-neutral-800 dark:text-neutral-100 line-clamp-3 break-words whitespace-pre-wrap">{c.text}</p>
                      <span className="mt-1 block text-[10.5px] text-neutral-400">{relativeTime(c.updatedAt)}</span>
                    </div>
                  </div>
                </button>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
};

export default CommentsPanel;
