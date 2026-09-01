// components/docs/DocFindReplaceBar.tsx
//
// The Ctrl+F overlay bar - reads docFindReplace.ts's plugin state directly off `editor.state`
// rather than mirroring it into its own React state, since DocsEditor.tsx's useEditor already
// re-renders this component's parent on every transaction (see that extension's own header
// comment). Docked under the toolbar, not a floating popover, so it reads as "a mode the whole
// editor is in" the way a browser's own find bar does.
import React, { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { IoChevronDown, IoChevronUp, IoClose } from "react-icons/io5";
import { DocFindReplacePluginKey } from "../../utils/docFindReplace";

interface DocFindReplaceBarProps {
  editor: Editor;
  onClose: () => void;
}

const DocFindReplaceBar: React.FC<DocFindReplaceBarProps> = ({ editor, onClose }) => {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pluginState = DocFindReplacePluginKey.getState(editor.state);
  const [replaceValue, setReplaceValue] = React.useState("");
  const [showReplace, setShowReplace] = React.useState(false);

  useEffect(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, []);

  const query = pluginState?.query ?? "";
  const matchCount = pluginState?.matches.length ?? 0;
  const activeIndex = pluginState?.activeIndex ?? -1;

  const handleClose = () => {
    editor.commands.clearSearch();
    onClose();
  };

  return (
    <div
      className="shrink-0 flex flex-col gap-1.5 px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 print:hidden"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          handleClose();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <input
          ref={searchInputRef}
          value={query}
          onChange={(e) => editor.commands.setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) editor.commands.findPrevious();
              else editor.commands.findNext();
            }
          }}
          placeholder="Find in document"
          className="w-56 px-2 py-1 text-sm rounded border border-neutral-200 dark:border-neutral-700 bg-transparent outline-none text-neutral-800 dark:text-neutral-100"
        />
        <span className="text-xs text-neutral-400 dark:text-neutral-500 w-16 shrink-0 tabular-nums">
          {query.length === 0 ? "" : matchCount === 0 ? "0 of 0" : `${activeIndex + 1} of ${matchCount}`}
        </span>
        <button
          type="button"
          title="Previous match"
          disabled={matchCount === 0}
          onClick={() => editor.commands.findPrevious()}
          className="p-1.5 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
        >
          <IoChevronUp size={14} />
        </button>
        <button
          type="button"
          title="Next match"
          disabled={matchCount === 0}
          onClick={() => editor.commands.findNext()}
          className="p-1.5 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
        >
          <IoChevronDown size={14} />
        </button>
        <button
          type="button"
          onClick={() => setShowReplace((v) => !v)}
          className="text-xs text-neutral-500 dark:text-neutral-400 hover:underline"
        >
          {showReplace ? "Hide replace" : "Replace"}
        </button>
        <button
          type="button"
          title="Close (Esc)"
          onClick={handleClose}
          className="ml-auto p-1.5 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <IoClose size={16} />
        </button>
      </div>

      {showReplace && (
        <div className="flex items-center gap-2">
          <input
            value={replaceValue}
            onChange={(e) => setReplaceValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                editor.commands.replaceActive(replaceValue);
              }
            }}
            placeholder="Replace with"
            className="w-56 px-2 py-1 text-sm rounded border border-neutral-200 dark:border-neutral-700 bg-transparent outline-none text-neutral-800 dark:text-neutral-100"
          />
          <button
            type="button"
            disabled={activeIndex < 0}
            onClick={() => editor.commands.replaceActive(replaceValue)}
            className="px-2.5 py-1 text-xs rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
          >
            Replace
          </button>
          <button
            type="button"
            disabled={matchCount === 0}
            onClick={() => editor.commands.replaceAll(replaceValue)}
            className="px-2.5 py-1 text-xs rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
          >
            Replace all
          </button>
        </div>
      )}
    </div>
  );
};

export default DocFindReplaceBar;
