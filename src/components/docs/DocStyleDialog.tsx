// components/docs/DocStyleDialog.tsx
//
// Document style: the whole document's look in one place - a ready-made style to start from
// (docPaperStyles.ts), then the body text (font, size, leading, paragraph indent and spacing,
// justification, hyphenation), columns, caption numbering and citation style. Changes apply live,
// so the page behind the dialog shows each one as it's made.
import React, { useEffect, useMemo } from "react";
import type * as Y from "yjs";
import { IoClose } from "react-icons/io5";
import { writeLayout, type DocBodyStyle, type DocLayout } from "../../utils/docLayout";
import { CAPTION_STYLES, LATIN_MODERN_STACK, PAPER_STYLES, captionStyleId, type PaperStyle } from "../../utils/docPaperStyles";
import { FONT_LIBRARY, documentFontEntries, primaryFamily, type DocFontFace } from "../../utils/docFonts";
import { CITATION_STYLES } from "../../utils/docCitationStyles";
import type { BibliographyStore, CitationStyleId } from "../../utils/docBibliography";
import type { DocMargins } from "../../utils/docTypes";

interface DocStyleDialogProps {
  ydoc: Y.Doc;
  layout: DocLayout;
  bib: BibliographyStore;
  citationStyle: CitationStyleId;
  docFonts: DocFontFace[];
  onMargins: (margins: DocMargins | null) => void;
  onClose: () => void;
}

// The editor's own look, as starting values when a document first gets a body style.
const EDITOR_BODY: DocBodyStyle = { fontFamily: LATIN_MODERN_STACK, fontSize: 11, lineHeight: 1.2, blockSpacing: 0, paragraphIndent: 15, color: null, justify: true, hyphenate: true };

const field =
  "w-full px-2 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100";
const label = "block text-xs text-neutral-500 dark:text-neutral-400 mb-1";

const NumberField: React.FC<{ id: string; value: number | null; unit: string; step: number; min: number; max: number; onChange: (v: number) => void }> = ({ id, value, unit, step, min, max, onChange }) => (
  <div className="relative">
    <input
      id={id}
      type="number"
      step={step}
      min={min}
      max={max}
      value={value ?? ""}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
      }}
      className={`${field} pr-8 tabular-nums`}
    />
    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-neutral-400">{unit}</span>
  </div>
);

const DocStyleDialog: React.FC<DocStyleDialogProps> = ({ ydoc, layout, bib, citationStyle, docFonts, onMargins, onClose }) => {
  const numbering = bib.numbering();
  const body = layout.body;
  const fonts = useMemo(() => [...documentFontEntries(docFonts), ...FONT_LIBRARY.filter((f) => f.category !== "mono")], [docFonts]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setBody = (patch: Partial<DocBodyStyle>) => writeLayout(ydoc, { body: { ...(body ?? EDITOR_BODY), ...patch } });

  const applyPreset = (p: PaperStyle) => {
    ydoc.transact(() => {
      writeLayout(ydoc, { columns: p.columns, columnGap: p.columnGap, body: p.body });
      bib.setNumbering(p.numbering);
      bib.setStyle(p.citationStyle);
    });
    onMargins(p.margins);
  };

  const activePreset = PAPER_STYLES.find(
    (p) => p.columns === layout.columns && JSON.stringify(p.body) === JSON.stringify(body) && JSON.stringify(p.numbering) === JSON.stringify(numbering)
  )?.id;
  const currentFont = primaryFamily(body?.fontFamily);
  const captionId = captionStyleId(numbering);

  return (
    <div className="fixed inset-0 z-50 flex justify-end print:hidden" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="doc-style-title"
        className="h-full w-[360px] max-w-full overflow-y-auto bg-white dark:bg-neutral-900 border-l border-neutral-200 dark:border-neutral-800 shadow-[-8px_0_24px_rgba(0,0,0,0.08)]"
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-3 bg-white/95 dark:bg-neutral-900/95 backdrop-blur border-b border-neutral-200 dark:border-neutral-800">
          <h2 id="doc-style-title" className="flex-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Document style
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 -m-1 rounded-full text-neutral-500 hover:bg-black/[0.06] dark:hover:bg-white/10">
            <IoClose size={18} />
          </button>
        </div>

        <div className="p-4 space-y-5">
          <section>
            <h3 className={label}>Start from</h3>
            <div className="space-y-1.5">
              {PAPER_STYLES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  aria-pressed={activePreset === p.id}
                  className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                    activePreset === p.id
                      ? "border-blue-500 bg-blue-50/70 dark:bg-blue-500/10"
                      : "border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="inline-flex gap-[2px]" aria-hidden>
                      {Array.from({ length: p.columns }, (_, k) => (
                        <span key={k} className={`block h-4 ${p.columns === 1 ? "w-4" : "w-[7px]"} rounded-[1px] border border-current opacity-60`} />
                      ))}
                    </span>
                    <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{p.name}</span>
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-neutral-500 dark:text-neutral-400">{p.description}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Body text</h3>
            <div>
              <label className={label} htmlFor="style-font">
                Font
              </label>
              <select
                id="style-font"
                value={currentFont ?? ""}
                onChange={(e) => {
                  const f = fonts.find((x) => x.family === e.target.value);
                  if (f) setBody({ fontFamily: f.stack });
                }}
                className={field}
                style={{ fontFamily: body?.fontFamily ?? undefined }}
              >
                {!body && <option value="">Docs default</option>}
                {fonts.map((f) => (
                  <option key={f.family} value={f.family} style={{ fontFamily: f.stack }}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={label} htmlFor="style-size">
                  Size
                </label>
                <NumberField id="style-size" value={body?.fontSize ?? null} unit="pt" step={0.5} min={6} max={24} onChange={(v) => setBody({ fontSize: v })} />
              </div>
              <div>
                <label className={label} htmlFor="style-leading">
                  Line spacing
                </label>
                <NumberField id="style-leading" value={body?.lineHeight ?? null} unit="×" step={0.05} min={0.9} max={3} onChange={(v) => setBody({ lineHeight: Math.round(v * 100) / 100 })} />
              </div>
              <div>
                <label className={label} htmlFor="style-indent">
                  First-line indent
                </label>
                <NumberField id="style-indent" value={body?.paragraphIndent ?? null} unit="pt" step={1} min={0} max={72} onChange={(v) => setBody({ paragraphIndent: v })} />
              </div>
              <div>
                <label className={label} htmlFor="style-space">
                  Between paragraphs
                </label>
                <NumberField id="style-space" value={body?.blockSpacing ?? null} unit="pt" step={1} min={0} max={36} onChange={(v) => setBody({ blockSpacing: v })} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              {(
                [
                  ["justify", "Justify text"],
                  ["hyphenate", "Hyphenate long words at line ends"],
                ] as const
              ).map(([key, text]) => (
                <label key={key} className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                  <input type="checkbox" checked={!!body?.[key]} onChange={(e) => setBody({ [key]: e.target.checked })} className="accent-blue-600" />
                  {text}
                </label>
              ))}
            </div>
            {body && (
              <button type="button" onClick={() => writeLayout(ydoc, { body: null })} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                Use Docs' default text style
              </button>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Columns</h3>
            <div className="flex items-center gap-3">
              <div className="inline-flex rounded-md border border-neutral-300 dark:border-neutral-600 overflow-hidden" role="radiogroup" aria-label="Columns">
                {([1, 2] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={layout.columns === n}
                    onClick={() => writeLayout(ydoc, { columns: n })}
                    className={`px-3 py-1 text-xs ${n === 2 ? "border-l border-neutral-300 dark:border-neutral-600" : ""} ${
                      layout.columns === n ? "bg-blue-50 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200" : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    }`}
                  >
                    {n === 1 ? "One" : "Two"}
                  </button>
                ))}
              </div>
              {layout.columns === 2 && (
                <div className="w-28">
                  <NumberField id="style-gutter" value={layout.columnGap} unit="in" step={0.05} min={0} max={2} onChange={(v) => writeLayout(ydoc, { columnGap: v })} />
                </div>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Captions and references</h3>
            <div>
              <label className={label} htmlFor="style-captions">
                Caption numbering
              </label>
              <select
                id="style-captions"
                value={captionId ?? "custom"}
                onChange={(e) => {
                  const c = CAPTION_STYLES.find((x) => x.id === e.target.value);
                  // Keep the chapter setting - it's chosen separately below.
                  if (c) bib.setNumbering({ ...c.numbering, chapterLevel: numbering.chapterLevel });
                }}
                className={field}
              >
                {captionId === null && <option value="custom">This document's own style</option>}
                {CAPTION_STYLES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} - {c.example}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="style-chapters">
                Number within chapters
              </label>
              <select
                id="style-chapters"
                value={numbering.chapterLevel ?? 0}
                onChange={(e) => {
                  const level = Number(e.target.value);
                  bib.setNumbering({ ...numbering, chapterLevel: level > 0 ? level : null });
                }}
                className={field}
              >
                <option value={0}>Off - Figure 1, Table 1, (1)</option>
                <option value={1}>Chapters are Heading 1 - Figure 2.1, (2.1)</option>
                <option value={2}>Chapters are Heading 2 - Figure 2.1, (2.1)</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="style-cite">
                Citation style
              </label>
              <select id="style-cite" value={citationStyle} onChange={(e) => bib.setStyle(e.target.value as CitationStyleId)} className={field}>
                {CITATION_STYLES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default DocStyleDialog;
