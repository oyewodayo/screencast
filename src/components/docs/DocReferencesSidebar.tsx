// components/docs/DocReferencesSidebar.tsx
//
// Docked right panel for the document's reference library: choose the citation style, add works
// (DOI, arXiv, BibTeX, .bib file), see which are cited and under what number, cite one at the
// cursor, copy its BibTeX, open it, or remove it. Sits in the same slot as the Comments panel.
import React, { useMemo, useState } from "react";
import type { Editor } from "@tiptap/core";
import { IoAdd, IoChevronDown, IoClose, IoCloudDownloadOutline, IoCopyOutline, IoOpenOutline, IoSearch, IoTrashOutline } from "react-icons/io5";
import { TbQuote } from "react-icons/tb";
import { toBibtex, type BibEntry, type BibliographyStore, type CitationStyleId } from "../../utils/docBibliography";
import { CITATION_STYLES, styleInfo } from "../../utils/docCitationStyles";
import { addReferencesFromInput, importBibFile } from "../../utils/docReferenceImport";
import { getDocStructure } from "../../utils/docStructure";
import { ReferenceRow } from "./DocCitePicker";
import { openLink } from "./DocReferenceText";

interface DocReferencesSidebarProps {
  editor: Editor;
  store: BibliographyStore;
  entries: BibEntry[];
  style: CitationStyleId;
  onClose: () => void;
}

const iconButton = "p-1.5 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-800 dark:hover:text-neutral-100";

const DocReferencesSidebar: React.FC<DocReferencesSidebarProps> = ({ editor, store, entries, style, onClose }) => {
  const [styleOpen, setStyleOpen] = useState(false);
  const [addText, setAddText] = useState("");
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<{ message: string; error: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const structure = getDocStructure(editor.state);
  const info = styleInfo(style);
  const citeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of structure?.citations ?? []) for (const id of c.refIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, [structure]);
  const hasBibliography = useMemo(() => {
    let found = false;
    editor.state.doc.descendants((n) => {
      if (n.type.name === "bibliography") found = true;
      return !found;
    });
    return found;
  }, [editor.state.doc]);

  // Cited works first, in reference-list order; uncited ones after, newest first.
  const ordered = useMemo(() => {
    const order = new Map((structure?.context.ordered ?? []).map((e, i) => [e.id, i]));
    const q = filter.trim().toLowerCase();
    return entries
      .filter((e) => !q || `${e.title ?? ""} ${(e.author ?? []).map((a) => a.family ?? a.literal).join(" ")} ${e["container-title"] ?? ""} ${e.DOI ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => (order.get(a.id) ?? 1e6 - (a.addedAt ?? 0) / 1e13) - (order.get(b.id) ?? 1e6 - (b.addedAt ?? 0) / 1e13));
  }, [entries, structure, filter]);

  const runAdd = async () => {
    if (!addText.trim() || adding) return;
    setAdding(true);
    setResult(null);
    const r = await addReferencesFromInput(store, addText);
    setAdding(false);
    setResult(r);
    if (!r.error) setAddText("");
  };

  const copyBibtex = (entry: BibEntry) => {
    void navigator.clipboard.writeText(toBibtex(entry)).then(() => {
      setCopied(entry.id);
      window.setTimeout(() => setCopied((c) => (c === entry.id ? null : c)), 1400);
    });
  };

  const removeEntry = (entry: BibEntry) => {
    if ((citeCounts.get(entry.id) ?? 0) > 0 && confirmDelete !== entry.id) {
      setConfirmDelete(entry.id);
      return;
    }
    store.remove(entry.id);
    setConfirmDelete(null);
  };

  const label = (id: string) => {
    const n = structure?.context.numbers.get(id);
    if (!n) return null;
    return info.superscript ? `${n}` : `[${n}]`;
  };

  const isBibtex = /^\s*@/.test(addText);

  return (
    <div className="w-[22rem] shrink-0 h-full border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex flex-col print:hidden">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-neutral-200 dark:border-neutral-800">
        <h2 className="text-sm font-medium text-neutral-800 dark:text-neutral-100">References</h2>
        {entries.length > 0 && (
          <span className="text-xs text-neutral-400 tabular-nums">
            {entries.length} · {structure?.citedIds.length ?? 0} cited
          </span>
        )}
        <button type="button" data-tip="Close" onClick={onClose} className={`ml-auto ${iconButton}`}>
          <IoClose size={16} />
        </button>
      </div>

      <div className="shrink-0 px-3 pt-3 space-y-3">
        {/* Citation style */}
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800">
          <button type="button" onClick={() => setStyleOpen((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">Citation style</span>
            <span className="ml-auto text-[13px] font-medium text-neutral-800 dark:text-neutral-100">{info.name}</span>
            <IoChevronDown size={14} className={`text-neutral-400 transition-transform ${styleOpen ? "rotate-180" : ""}`} />
          </button>
          {styleOpen && (
            <div className="border-t border-neutral-200 dark:border-neutral-800 p-1">
              {CITATION_STYLES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    store.setStyle(s.id);
                    setStyleOpen(false);
                  }}
                  className={`w-full text-left px-2.5 py-2 rounded-md ${s.id === style ? "bg-blue-50 dark:bg-blue-500/15" : "hover:bg-neutral-50 dark:hover:bg-neutral-800"}`}
                >
                  <div className={`text-[13px] ${s.id === style ? "font-medium text-blue-700 dark:text-blue-200" : "text-neutral-800 dark:text-neutral-100"}`}>{s.name}</div>
                  <div className="text-[11.5px] text-neutral-500 dark:text-neutral-400 truncate">{s.example}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Add */}
        <div>
          <div className="flex items-start gap-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 p-1">
            <textarea
              value={addText}
              rows={isBibtex ? 5 : 1}
              spellCheck={false}
              onChange={(e) => {
                setAddText(e.target.value);
                setResult(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (!isBibtex || e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void runAdd();
                }
              }}
              placeholder="DOI, arXiv ID, or BibTeX"
              className={`flex-1 min-w-0 px-2 py-1.5 text-[13px] bg-transparent outline-none resize-none text-neutral-800 dark:text-neutral-100 placeholder:text-neutral-400 ${isBibtex ? "font-mono text-[12px]" : ""}`}
            />
            <button
              type="button"
              disabled={!addText.trim() || adding}
              onClick={() => void runAdd()}
              className="shrink-0 h-8 px-3 inline-flex items-center gap-1 rounded-md text-[13px] font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:hover:bg-blue-600"
            >
              {adding ? <span className="doc-spinner doc-spinner-light" /> : <IoAdd size={16} />}
              Add
            </button>
          </div>
          <div className="flex items-center gap-2 mt-1.5 px-0.5 text-[11.5px] min-h-[1rem]">
            {result ? (
              <span className={`flex-1 min-w-0 ${result.error ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}>{result.message}</span>
            ) : (
              <span className="flex-1 min-w-0 text-neutral-400">{isBibtex ? "Ctrl+Enter to add every entry" : "Looks up DOIs and arXiv IDs at doi.org"}</span>
            )}
            <button
              type="button"
              onClick={() => void importBibFile(store).then((r) => r && setResult(r))}
              className="shrink-0 inline-flex items-center gap-1 text-neutral-500 dark:text-neutral-400 hover:text-blue-600 dark:hover:text-blue-300"
            >
              <IoCloudDownloadOutline size={13} /> Import .bib
            </button>
          </div>
        </div>

        {entries.length > 6 && (
          <div className="relative">
            <IoSearch size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter references"
              className="w-full h-8 pl-8 pr-2 text-[13px] rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100"
            />
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
        {entries.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="mx-auto mb-3 w-10 h-10 rounded-full bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300 flex items-center justify-center">
              <TbQuote size={20} />
            </div>
            <p className="text-[13px] font-medium text-neutral-700 dark:text-neutral-200">No references yet</p>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
              Add a paper by its DOI or arXiv ID, paste BibTeX, or import a .bib file from Zotero, Mendeley or JabRef.
            </p>
          </div>
        ) : (
          ordered.map((entry) => {
            const count = citeCounts.get(entry.id) ?? 0;
            const url = entry.DOI ? `https://doi.org/${entry.DOI}` : entry.arxiv ? `https://arxiv.org/abs/${entry.arxiv}` : entry.URL;
            return (
              <div key={entry.id} className="group relative rounded-lg px-2.5 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800/60">
                <ReferenceRow
                  entry={entry}
                  badge={label(entry.id)}
                  trailing={count === 0 ? <span className="ml-auto shrink-0 pl-2 text-[11px] text-neutral-400">Not cited</span> : null}
                />
                {/* Actions unfold on hover/focus (grid-rows 0fr -> 1fr), so a resting list stays compact. */}
                <div
                  className={`grid transition-[grid-template-rows,opacity] duration-150 ease-out ${
                    confirmDelete === entry.id ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 group-hover:grid-rows-[1fr] group-hover:opacity-100 group-focus-within:grid-rows-[1fr] group-focus-within:opacity-100"
                  }`}
                >
                <div className="overflow-hidden">
                <div className="flex items-center gap-0.5 pt-1.5 h-[34px]">
                  <button
                    type="button"
                    onClick={() => editor.chain().focus().insertCitation([entry.id]).run()}
                    className="h-7 px-2 inline-flex items-center gap-1 rounded-md text-[12px] font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/15"
                  >
                    <TbQuote size={14} /> Cite here
                  </button>
                  <button type="button" data-tip={copied === entry.id ? "Copied" : "Copy BibTeX"} onClick={() => copyBibtex(entry)} className={iconButton}>
                    <IoCopyOutline size={14} />
                  </button>
                  {url && (
                    <button type="button" data-tip="Open in browser" onClick={() => openLink(url)} className={iconButton}>
                      <IoOpenOutline size={14} />
                    </button>
                  )}
                  {count > 0 && <span className="ml-1 text-[11px] text-neutral-400">Cited {count}×</span>}
                  <div className="flex-1" />
                  {confirmDelete === entry.id ? (
                    <button type="button" onClick={() => removeEntry(entry)} onBlur={() => setConfirmDelete(null)} className="h-7 px-2 rounded-md text-[12px] font-medium text-white bg-red-600 hover:bg-red-700">
                      Remove · it’s cited {count}×
                    </button>
                  ) : (
                    <button type="button" data-tip="Remove from document" onClick={() => removeEntry(entry)} className={`${iconButton} hover:!text-red-600`}>
                      <IoTrashOutline size={14} />
                    </button>
                  )}
                </div>
                </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {entries.length > 0 && !hasBibliography && (
        <div className="shrink-0 p-3 border-t border-neutral-200 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => editor.chain().focus().insertBibliography().run()}
            className="w-full h-9 rounded-lg text-[13px] font-medium text-blue-700 dark:text-blue-200 bg-blue-50 dark:bg-blue-500/15 hover:bg-blue-100 dark:hover:bg-blue-500/25"
          >
            Insert reference list at cursor
          </button>
        </div>
      )}
    </div>
  );
};

export default DocReferencesSidebar;
