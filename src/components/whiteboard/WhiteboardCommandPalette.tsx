// components/whiteboard/WhiteboardCommandPalette.tsx
//
// Instant Ctrl+K command palette for power users — search and run any Whiteboard tool, template,
// auto-layout, view toggle, presentation mode, or export in two keystrokes.

import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { IoSearchOutline } from "react-icons/io5";

export interface WhiteboardCommandItem {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  keywords?: string;
  run: () => void;
}

interface WhiteboardCommandPaletteProps {
  commands: WhiteboardCommandItem[];
  onClose: () => void;
}

const WhiteboardCommandPalette: React.FC<WhiteboardCommandPaletteProps> = memo(({ commands, onClose }) => {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q) ||
        (c.keywords && c.keywords.toLowerCase().includes(q))
    );
  }, [commands, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const execute = (item: WhiteboardCommandItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        onClose();
      }}
      className="fixed inset-0 z-40 flex items-start justify-center pt-[14vh] bg-black/25"
    >
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="w-[460px] max-w-[92vw] rounded-xl bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-100 dark:border-neutral-800">
          <IoSearchOutline size={16} className="text-gray-400 dark:text-neutral-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => (filtered.length > 0 ? (i + 1) % filtered.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => (filtered.length > 0 ? (i - 1 + filtered.length) % filtered.length : 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                execute(filtered[activeIndex]);
              }
            }}
            placeholder="Type a command, tool, or template…"
            className="flex-1 bg-transparent text-sm text-neutral-800 dark:text-neutral-100 outline-none placeholder:text-gray-400"
          />
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-neutral-800 text-gray-400">Esc</span>
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-gray-400 dark:text-neutral-500">No matching commands</p>
          ) : (
            filtered.map((cmd, idx) => (
              <button
                key={cmd.id}
                type="button"
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => execute(cmd)}
                className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-xs transition-colors ${
                  idx === activeIndex
                    ? "bg-blue-600 text-white"
                    : "text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800"
                }`}
              >
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wide w-20 shrink-0 truncate ${
                    idx === activeIndex ? "text-blue-100" : "text-gray-400 dark:text-neutral-500"
                  }`}
                >
                  {cmd.category}
                </span>
                <span className="flex-1 truncate font-medium">{cmd.label}</span>
                {cmd.shortcut && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 ${
                      idx === activeIndex
                        ? "bg-white/20 text-white"
                        : "bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400"
                    }`}
                  >
                    {cmd.shortcut}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
});

WhiteboardCommandPalette.displayName = "WhiteboardCommandPalette";

export default WhiteboardCommandPalette;
