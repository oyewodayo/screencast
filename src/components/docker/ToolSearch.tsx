// components/docker/ToolSearch.tsx
//
// "Find a tool": Ctrl+K (or the toolbar's search button) opens a box that searches every tool on
// the editor toolbar by its name and description, and runs the one picked - Enter or click. The
// list is read straight off the toolbar's own buttons (their titles) each time it opens, so every
// tool added to the toolbar is findable with no list to keep in sync, and a tool that's disabled
// right now shows as such.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoSearchOutline } from "react-icons/io5";

interface ToolEntry {
  title: string;
  button: HTMLButtonElement;
  disabled: boolean;
}

const isEditable = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");

// Every word of the query found somewhere in the title (any order), best matches first: a title
// starting with the query, then one with a word starting with it, then anything containing it.
function rank(entries: ToolEntry[], query: string): ToolEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const words = q.split(/\s+/);
  const scored: [number, ToolEntry][] = [];
  for (const e of entries) {
    const t = e.title.toLowerCase();
    if (!words.every((w) => t.includes(w))) continue;
    const score = t.startsWith(q) ? 0 : new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t) ? 1 : 2;
    scored.push([score, e]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, e]) => e);
}

const ToolSearch: React.FC<{ toolbarRef: React.RefObject<HTMLElement | null> }> = ({ toolbarRef }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [entries, setEntries] = useState<ToolEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const show = () => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const seen = new Set<string>();
    const found: ToolEntry[] = [];
    toolbar.querySelectorAll<HTMLButtonElement>("button[title]").forEach((button) => {
      const title = button.title.trim();
      if (!title || seen.has(title) || button.dataset.toolSearch !== undefined) return;
      seen.add(title);
      found.push({ title, button, disabled: button.disabled });
    });
    setEntries(found);
    setQuery("");
    setHighlight(0);
    setOpen(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k" && !isEditable(e.target)) {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const results = useMemo(() => rank(entries, query), [entries, query]);
  const run = (entry: ToolEntry | undefined) => {
    if (!entry || entry.disabled) return;
    setOpen(false);
    // After the box closes, so a tool that opens a popover anchors to its button undisturbed.
    requestAnimationFrame(() => entry.button.click());
  };

  return (
    <>
      <button
        type="button"
        data-tool-search
        title="Find a tool (Ctrl+K)"
        onClick={show}
        className="shrink-0 flex items-center justify-center w-7 h-7 rounded text-neutral-300 hover:bg-neutral-700"
      >
        <IoSearchOutline size={15} />
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-[10000] flex items-start justify-center pt-[15vh] bg-black/40" onPointerDown={() => setOpen(false)}>
            <div className="w-[420px] max-w-[calc(100vw-32px)] rounded-xl bg-neutral-900 ring-1 ring-white/10 shadow-2xl overflow-hidden" onPointerDown={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 px-3 h-11 border-b border-white/10">
                <IoSearchOutline size={16} className="text-white/50 shrink-0" />
                <input
                  ref={inputRef}
                  value={query}
                  placeholder="Find a tool - captions, crop, speed, music…"
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHighlight(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setOpen(false);
                    else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setHighlight((h) => Math.min(results.length - 1, h + 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setHighlight((h) => Math.max(0, h - 1));
                    } else if (e.key === "Enter") run(results[highlight]);
                  }}
                  className="flex-1 min-w-0 bg-transparent text-[13px] text-white placeholder:text-white/35 outline-none"
                />
                <kbd className="text-[10px] text-white/40 px-1.5 py-0.5 rounded bg-white/[0.06]">Esc</kbd>
              </div>
              <div className="max-h-[50vh] overflow-y-auto py-1">
                {results.length === 0 && <div className="px-4 py-3 text-[12px] text-white/45">No tool matches "{query}".</div>}
                {results.map((entry, i) => (
                  <button
                    key={entry.title}
                    type="button"
                    disabled={entry.disabled}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => run(entry)}
                    className={`w-full text-left px-4 py-1.5 text-[12px] ${i === highlight ? "bg-blue-500/20 text-white" : "text-white/75"} disabled:text-white/30`}
                  >
                    {entry.title}
                    {entry.disabled && <span className="ml-2 text-[10px] text-white/30">not available right now</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

export default ToolSearch;
