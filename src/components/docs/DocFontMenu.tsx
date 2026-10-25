// components/docs/DocFontMenu.tsx
//
// The font picker: search, the document's own fonts first, then the bundled library by category,
// each name drawn in its own face with a line on what it's for. "Add a font file…" stores any
// TTF/OTF/WOFF with the document (utils/docFonts.ts).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { MdAdd, MdCheck, MdSearch } from "react-icons/md";
import { FONT_CATEGORIES, FONT_LIBRARY, documentFontEntries, primaryFamily, type DocFontFace, type FontEntry } from "../../utils/docFonts";

interface DocFontMenuProps {
  current: string | null; // the selection's font-family value
  // The face text without an explicit font is drawn in ("Latin Modern Roman"), for the Default row.
  defaultLabel?: string | null;
  docFonts: DocFontFace[];
  onPick: (entry: FontEntry | null) => void;
  onAddFont?: () => void;
}

const DocFontMenu: React.FC<DocFontMenuProps> = ({ current, defaultLabel, docFonts, onPick, onAddFont }) => {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const active = primaryFamily(current);

  const groups = useMemo(() => {
    const all = [...documentFontEntries(docFonts), ...FONT_LIBRARY];
    const q = query.trim().toLowerCase();
    const shown = q ? all.filter((f) => `${f.label} ${f.note ?? ""}`.toLowerCase().includes(q)) : all;
    return FONT_CATEGORIES.map((c) => ({ ...c, fonts: shown.filter((f) => f.category === c.id) })).filter((g) => g.fonts.length > 0);
  }, [docFonts, query]);

  return (
    <div className="w-72 flex flex-col max-h-[26rem]" onKeyDown={(e) => e.stopPropagation()}>
      <div className="p-2 pb-1.5">
        <div className="relative">
          <MdSearch size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const first = groups[0]?.fonts[0];
                if (first) onPick(first);
              }
            }}
            placeholder="Search fonts"
            className="w-full h-8 pl-8 pr-2 text-[13px] rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100"
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto pb-1.5">
        {!query && (
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(null)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/70">
            <span className="w-4 shrink-0">{active === null && <MdCheck size={16} />}</span>
            <span className="min-w-0 truncate">
              Document font{defaultLabel && <span className="text-neutral-500 dark:text-neutral-400"> ({defaultLabel})</span>}
            </span>
          </button>
        )}
        {groups.map((group) => (
          <div key={group.id}>
            <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{group.title}</div>
            {group.fonts.map((font) => (
              <button
                key={font.family}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(font)}
                className="w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700/70"
              >
                <span className="w-4 shrink-0 pt-0.5 text-blue-600 dark:text-blue-300">{active === font.family && <MdCheck size={16} />}</span>
                <span className="min-w-0">
                  <span className="block text-[15px] leading-tight text-neutral-900 dark:text-neutral-100 truncate" style={{ fontFamily: font.stack }}>
                    {font.label}
                  </span>
                  {font.note && <span className="block text-[11px] leading-snug text-neutral-500 dark:text-neutral-400 truncate">{font.note}</span>}
                </span>
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && <p className="px-3 py-4 text-xs text-neutral-400">No font matches “{query}”.</p>}
      </div>
      {onAddFont && (
        <div className="border-t border-neutral-200 dark:border-neutral-700 p-1.5">
          <button type="button" onClick={onAddFont} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/15">
            <MdAdd size={17} /> Add a font file…
            <span className="ml-auto text-[11px] text-neutral-400">TTF, OTF, WOFF</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default DocFontMenu;
