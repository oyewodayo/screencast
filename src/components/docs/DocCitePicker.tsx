// components/docs/DocCitePicker.tsx
//
// Insert or edit a citation: search the document's library, tick one or more works, optionally
// add a locator ("p. 12"), and cite. A DOI, arXiv ID or BibTeX snippet can be added right here
// without leaving the picker - the new reference comes back ticked, so "find paper, cite paper"
// is one flow. Rendered inside the toolbar's Cite dropdown and, for an existing citation, in a
// floating panel anchored to it (DocsEditor.tsx).
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { IoAdd, IoCheckmark, IoCloudDownloadOutline, IoSearch } from "react-icons/io5";
import type { BibEntry, BibliographyStore } from "../../utils/docBibliography";
import { referenceSummary, styleInfo } from "../../utils/docCitationStyles";
import { addReferencesFromInput, importBibFile } from "../../utils/docReferenceImport";
import { getDocStructure } from "../../utils/docStructure";

export type CitePickerMode = { kind: "insert" } | { kind: "edit"; pos: number; refIds: string[]; locator: string | null };

interface DocCitePickerProps {
  editor: Editor;
  store: BibliographyStore;
  entries: BibEntry[];
  mode: CitePickerMode;
  onClose: () => void;
}

function matches(entry: BibEntry, query: string): boolean {
  if (!query) return true;
  const s = referenceSummary(entry);
  const haystack = [s.title, s.venue, s.year, ...(entry.author ?? []).map((a) => `${a.given ?? ""} ${a.family ?? a.literal ?? ""}`), entry.DOI ?? "", entry.citationKey ?? ""]
    .join(" ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return query
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/\s+/)
    .every((token) => haystack.includes(token));
}

export const ReferenceRow: React.FC<{ entry: BibEntry; badge?: string | null; trailing?: React.ReactNode }> = ({ entry, badge, trailing }) => {
  const s = referenceSummary(entry);
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-1.5 min-w-0 text-[12.5px] text-neutral-500 dark:text-neutral-400">
        <span className="font-medium text-neutral-700 dark:text-neutral-200 truncate">{s.authors || "Unknown author"}</span>
        <span className="shrink-0">· {s.year}</span>
        {s.venue && <span className="truncate italic">· {s.venue}</span>}
        {badge && <span className="ml-auto shrink-0 pl-2 text-[11px] font-semibold tabular-nums text-blue-600 dark:text-blue-300">{badge}</span>}
        {trailing}
      </div>
      <div className="text-[13px] leading-snug text-neutral-900 dark:text-neutral-100 line-clamp-2">{s.title}</div>
    </div>
  );
};

const DocCitePicker: React.FC<DocCitePickerProps> = ({ editor, store, entries, mode, onClose }) => {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>(mode.kind === "edit" ? mode.refIds : []);
  const [locator, setLocator] = useState(mode.kind === "edit" ? (mode.locator ?? "") : "");
  const [active, setActive] = useState(0);
  const [addText, setAddText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<{ message: string; error: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const structure = getDocStructure(editor.state);
  const info = styleInfo(store.style());
  const filtered = useMemo(() => entries.filter((e) => matches(e, query.trim())), [entries, query]);
  const isBibtex = /^\s*@/.test(addText);

  useEffect(() => {
    (entries.length === 0 ? addRef : searchRef).current?.focus();
    // Focus once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const commit = (ids = selected) => {
    if (mode.kind === "edit") {
      editor.chain().focus().updateCitationAt(mode.pos, ids, locator.trim() || null).run();
    } else if (ids.length > 0) {
      editor.chain().focus().insertCitation(ids, locator.trim() || null).run();
    }
    onClose();
  };

  const runAdd = async () => {
    if (!addText.trim() || adding) return;
    setAdding(true);
    setAddResult(null);
    const result = await addReferencesFromInput(store, addText);
    setAdding(false);
    setAddResult(result);
    if (!result.error) {
      setAddText("");
      setQuery("");
      setSelected((cur) => [...cur, ...result.ids.filter((id) => !cur.includes(id))]);
      searchRef.current?.focus();
    }
  };

  const runImport = async () => {
    const result = await importBibFile(store);
    if (result) setAddResult(result);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === " " && e.target === listRef.current) {
      e.preventDefault();
      if (filtered[active]) toggle(filtered[active].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Enter with nothing ticked cites the highlighted reference - the fastest single citation.
      if (selected.length === 0 && filtered[active]) commit([filtered[active].id]);
      else commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const numberOf = (id: string) => {
    const n = structure?.context.numbers.get(id);
    return n ? (info.superscript ? `${n}` : `[${n}]`) : null;
  };

  return (
    <div className="w-[26rem] max-w-[calc(100vw-2rem)] flex flex-col" onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div className="relative flex-1">
          <IoSearch size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onListKey}
            placeholder={entries.length ? `Search ${entries.length} reference${entries.length === 1 ? "" : "s"}…` : "No references yet"}
            disabled={entries.length === 0}
            className="w-full h-9 pl-8 pr-3 text-sm rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 text-neutral-800 dark:text-neutral-100 disabled:opacity-60"
          />
        </div>
      </div>

      {entries.length > 0 && (
        <div ref={listRef} tabIndex={-1} onKeyDown={onListKey} className="max-h-64 overflow-y-auto px-1.5 pb-1 outline-none" role="listbox" aria-multiselectable>
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-neutral-400">Nothing in this document’s references matches “{query}”.</p>
          ) : (
            filtered.map((entry, i) => {
              const isSelected = selected.includes(entry.id);
              return (
                <div
                  key={entry.id}
                  data-index={i}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggle(entry.id)}
                  onDoubleClick={() => commit(isSelected ? selected : [...selected, entry.id])}
                  className={`flex items-start gap-2.5 px-2 py-2 rounded-lg cursor-pointer ${i === active ? "bg-neutral-100 dark:bg-neutral-700/60" : ""}`}
                >
                  <span
                    className={`mt-0.5 shrink-0 w-4 h-4 rounded-[5px] border flex items-center justify-center transition-colors ${
                      isSelected ? "bg-blue-600 border-blue-600 text-white" : "border-neutral-300 dark:border-neutral-500"
                    }`}
                  >
                    {isSelected && <IoCheckmark size={12} />}
                  </span>
                  <ReferenceRow entry={entry} badge={numberOf(entry.id)} />
                </div>
              );
            })
          )}
        </div>
      )}

      <div className="mx-3 mt-1 mb-2 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-600 p-2">
        <div className="flex items-start gap-1.5">
          <textarea
            ref={addRef}
            value={addText}
            rows={isBibtex ? 4 : 1}
            onChange={(e) => {
              setAddText(e.target.value);
              setAddResult(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (!isBibtex || e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void runAdd();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            spellCheck={false}
            placeholder="Add by DOI, arXiv ID, or paste BibTeX"
            className={`flex-1 min-w-0 px-2 py-1.5 text-[13px] rounded-md bg-transparent outline-none text-neutral-800 dark:text-neutral-100 placeholder:text-neutral-400 resize-none ${isBibtex ? "font-mono text-[12px]" : ""}`}
          />
          <button
            type="button"
            onClick={() => void runAdd()}
            disabled={!addText.trim() || adding}
            className="shrink-0 h-8 px-2.5 inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/15 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {adding ? <span className="doc-spinner" /> : <IoAdd size={16} />}
            {adding ? "Looking up…" : "Add"}
          </button>
        </div>
        <div className="flex items-center gap-2 px-2 pt-1 text-[11.5px]">
          {addResult ? (
            <span className={`min-w-0 flex-1 ${addResult.error ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}>{addResult.message}</span>
          ) : (
            <span className="min-w-0 flex-1 text-neutral-400">{isBibtex ? "Ctrl+Enter to add" : "e.g. 10.1038/s41586-021-03585-1 or 2603.20372"}</span>
          )}
          <button type="button" onClick={() => void runImport()} className="shrink-0 inline-flex items-center gap-1 text-neutral-500 dark:text-neutral-400 hover:text-blue-600 dark:hover:text-blue-300">
            <IoCloudDownloadOutline size={13} /> Import .bib
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-2.5 border-t border-neutral-200 dark:border-neutral-700">
        <input
          value={locator}
          onChange={(e) => setLocator(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") onClose();
          }}
          placeholder="Page or section (optional)"
          className="w-40 h-8 px-2 text-[13px] rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100 placeholder:text-neutral-400"
        />
        <div className="flex-1" />
        {mode.kind === "edit" && (
          <button type="button" onClick={() => commit([])} className="h-8 px-2.5 text-[13px] rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10">
            Remove
          </button>
        )}
        <button type="button" onClick={onClose} className="h-8 px-3 text-[13px] rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
          Cancel
        </button>
        <button
          type="button"
          disabled={selected.length === 0}
          onClick={() => commit()}
          className="h-8 px-3.5 text-[13px] font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:hover:bg-blue-600"
        >
          {mode.kind === "edit" ? "Update" : selected.length > 1 ? `Cite ${selected.length}` : "Cite"}
        </button>
      </div>
    </div>
  );
};

export default DocCitePicker;
