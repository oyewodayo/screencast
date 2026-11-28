// components/whiteboard/WhiteboardSearchBar.tsx
//
// Floating Ctrl+F search overlay searching node labels, equations, table cells, mindmap notes,
// checklists, resources, and connector labels across ALL pages of the active whiteboard.

import React, { memo, useEffect, useRef } from "react";
import { IoChevronDown, IoChevronUp, IoClose, IoSearchOutline } from "react-icons/io5";
import { WhiteboardSearchMatch } from "../../handlers/whiteboardProHandlers";

interface WhiteboardSearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  matches: WhiteboardSearchMatch[];
  activeIndex: number;
  activePageId: string;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

const WhiteboardSearchBar: React.FC<WhiteboardSearchBarProps> = memo(
  ({ query, onQueryChange, matches, activeIndex, activePageId, onNext, onPrev, onClose }) => {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, []);

    const current = matches[activeIndex] ?? null;

    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute top-3 right-3 z-30 w-[300px] rounded-lg bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 shadow-xl p-1.5 flex flex-col gap-1"
      >
        <div className="flex items-center gap-1.5">
          <IoSearchOutline size={14} className="ml-1.5 text-gray-400 dark:text-neutral-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) onPrev();
                else onNext();
              }
            }}
            placeholder="Find text across pages…"
            className="flex-1 min-w-0 h-7 bg-transparent text-xs text-neutral-800 dark:text-neutral-100 outline-none placeholder:text-gray-400"
          />
          {query.trim() && (
            <span className="text-[10px] tabular-nums text-gray-400 dark:text-neutral-500 shrink-0">
              {matches.length > 0 ? `${activeIndex + 1}/${matches.length}` : "0/0"}
            </span>
          )}
          <button
            type="button"
            disabled={matches.length === 0}
            onClick={onPrev}
            title="Previous match (Shift+Enter)"
            className="w-6 h-6 rounded flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 disabled:opacity-35"
          >
            <IoChevronUp size={13} />
          </button>
          <button
            type="button"
            disabled={matches.length === 0}
            onClick={onNext}
            title="Next match (Enter)"
            className="w-6 h-6 rounded flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 disabled:opacity-35"
          >
            <IoChevronDown size={13} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="w-6 h-6 rounded flex items-center justify-center text-neutral-500 hover:bg-gray-100 dark:hover:bg-neutral-700"
          >
            <IoClose size={14} />
          </button>
        </div>

        {current && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-gray-50 dark:bg-neutral-900/70 text-[11px] text-neutral-600 dark:text-neutral-300">
            <span className="truncate flex-1">{current.snippet}</span>
            {current.pageId !== activePageId && (
              <span className="shrink-0 px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 text-[10px] font-medium">
                {current.pageName}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }
);

WhiteboardSearchBar.displayName = "WhiteboardSearchBar";

export default WhiteboardSearchBar;
