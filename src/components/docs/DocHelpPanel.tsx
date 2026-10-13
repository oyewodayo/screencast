// components/docs/DocHelpPanel.tsx
//
// The "?" guide beside the document: how to write a two-column paper from scratch (the same
// docs/two-column-papers.md the website shows), with a contents strip to jump between sections
// and buttons that do the first steps for you.
import React, { useMemo, useRef } from "react";
import { IoClose } from "react-icons/io5";
import { TbColumns2, TbTypography } from "react-icons/tb";
import guide from "../../../docs/two-column-papers.md?raw";
import DocHelpMarkdown, { parseBlocks, slugify } from "./DocHelpMarkdown";
import "./docHelp.css";

interface DocHelpPanelProps {
  // The document already uses the journal style (nothing to apply).
  isJournal: boolean;
  onApplyJournal: () => void;
  onOpenStyle: () => void;
  onClose: () => void;
}

const DocHelpPanel: React.FC<DocHelpPanelProps> = ({ isJournal, onApplyJournal, onOpenStyle, onClose }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const source = guide;
  const sections = useMemo(() => parseBlocks(source).filter((b): b is Extract<typeof b, { kind: "heading" }> => b.kind === "heading" && b.level === 2), [source]);

  const jump = (slug: string) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`#help-${CSS.escape(slug)}`);
    if (el && bodyRef.current) bodyRef.current.scrollTo({ top: el.offsetTop - 8, behavior: "smooth" });
  };

  return (
    <div className="w-[24rem] shrink-0 h-full border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex flex-col print:hidden" role="complementary" aria-label="Guide">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-neutral-200 dark:border-neutral-800">
        <h2 className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Writing a two-column paper</h2>
        <button type="button" data-tip="Close" aria-label="Close guide" onClick={onClose} className="ml-auto p-1.5 rounded-full text-neutral-500 hover:bg-black/[0.06] dark:hover:bg-white/10">
          <IoClose size={16} />
        </button>
      </div>
      <div className="shrink-0 flex gap-1 overflow-x-auto px-3 py-2 border-b border-neutral-100 dark:border-neutral-800 [scrollbar-width:none]">
        {sections.map((s) => (
          <button
            key={s.text}
            type="button"
            onClick={() => jump(slugify(s.text))}
            className="shrink-0 rounded-full border border-neutral-200 dark:border-neutral-700 px-2.5 py-0.5 text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {s.text.replace(/^\d+\.\s*/, "")}
          </button>
        ))}
      </div>
      <div ref={bodyRef} className="relative flex-1 min-h-0 overflow-y-auto px-4 pb-10">
        <div className="mt-3 rounded-xl border border-blue-200 dark:border-blue-500/30 bg-blue-50/60 dark:bg-blue-500/10 p-3">
          <p className="text-[13px] leading-snug text-neutral-700 dark:text-neutral-200">
            {isJournal ? "This document already uses the two-column journal style." : "Start by giving this document the two-column journal style. You can change any part of it afterwards."}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {!isJournal && (
              <button type="button" onClick={onApplyJournal} className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                <TbColumns2 size={15} /> Make this a journal paper
              </button>
            )}
            <button
              type="button"
              onClick={onOpenStyle}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-200 hover:bg-white dark:hover:bg-neutral-800"
            >
              <TbTypography size={15} /> Document style…
            </button>
          </div>
        </div>
        <DocHelpMarkdown source={source} onLink={(href) => href.startsWith("#") && jump(href.slice(1))} />
      </div>
    </div>
  );
};

export default DocHelpPanel;
