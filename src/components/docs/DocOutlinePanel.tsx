// components/docs/DocOutlinePanel.tsx
//
// Docked left panel listing the document's headings as an indented outline - the Google Docs
// "Document outline". The heading being read is highlighted as the page scrolls; clicking one
// jumps there. A footer counts what the structure plugin numbers (figures, tables, equations,
// cited works) so a long paper's inventory is visible at a glance.
import React, { useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { IoClose, IoImageOutline } from "react-icons/io5";
import { TbMathFunction, TbQuote, TbTable } from "react-icons/tb";
import { getDocStructure, revealPos } from "../../utils/docStructure";

interface DocOutlinePanelProps {
  editor: Editor;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

const DocOutlinePanel: React.FC<DocOutlinePanelProps> = ({ editor, scrollerRef, onClose }) => {
  const structure = getDocStructure(editor.state);
  const headings = useMemo(() => (structure?.headings ?? []).filter((h) => h.text), [structure]);
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6);
  const [activePos, setActivePos] = useState<number | null>(null);

  // The active heading is the last one whose top has scrolled above a line a little below the
  // top of the visible page.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const line = scroller.getBoundingClientRect().top + 120;
        let current: number | null = null;
        for (const h of headings) {
          const dom = editor.view.nodeDOM(h.pos);
          if (!(dom instanceof HTMLElement)) continue;
          if (dom.getBoundingClientRect().top <= line) current = h.pos;
          else break;
        }
        setActivePos(current ?? headings[0]?.pos ?? null);
      });
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", update);
    };
  }, [editor, headings, scrollerRef]);

  const go = (pos: number) => {
    const { view } = editor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.min(pos + 1, view.state.doc.content.size))));
    view.focus();
    revealPos(view, pos);
  };

  const counts = [
    { icon: IoImageOutline, n: [...(structure?.captionAt.values() ?? [])].filter((t) => t.kind === "figure").length, word: "figure" },
    { icon: TbTable, n: [...(structure?.captionAt.values() ?? [])].filter((t) => t.kind === "table").length, word: "table" },
    { icon: TbMathFunction, n: structure?.equationAt.size ?? 0, word: "equation" },
    { icon: TbQuote, n: structure?.citedIds.length ?? 0, word: "reference" },
  ].filter((c) => c.n > 0);

  return (
    <nav aria-label="Document outline" className="w-64 shrink-0 h-full border-r border-neutral-200 dark:border-neutral-800 bg-[var(--doc-canvas)] flex flex-col print:hidden">
      <div className="shrink-0 flex items-center gap-2 pl-4 pr-2 py-2.5">
        <h2 className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Outline</h2>
        <button
          type="button"
          data-tip="Close outline"
          onClick={onClose}
          className="ml-auto p-1.5 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.05] dark:hover:bg-white/10"
        >
          <IoClose size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto pl-2 pr-2 pb-3">
        {headings.length === 0 ? (
          <p className="px-2.5 py-2 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            Headings you add to the document appear here. Use <b className="font-medium">Heading 1–3</b> from the style menu, or type <b className="font-medium">/</b>.
          </p>
        ) : (
          <ol>
            {headings.map((h) => {
              const active = h.pos === activePos;
              const depth = h.level - minLevel;
              return (
                <li key={h.pos}>
                  <button
                    type="button"
                    onClick={() => go(h.pos)}
                    style={{ paddingLeft: `${10 + depth * 14}px` }}
                    className={`relative w-full text-left pr-2 py-[5px] rounded-md text-[13px] leading-snug transition-colors ${
                      active
                        ? "text-blue-700 dark:text-blue-200 font-medium bg-blue-50/80 dark:bg-blue-500/15"
                        : depth === 0
                          ? "text-neutral-800 dark:text-neutral-100 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                          : "text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    }`}
                  >
                    {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-blue-600 dark:bg-blue-400" />}
                    <span className="line-clamp-2">{h.text}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {counts.length > 0 && (
        <div className="shrink-0 px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 flex flex-wrap gap-x-3 gap-y-1.5 text-[11.5px] text-neutral-500 dark:text-neutral-400">
          {counts.map(({ icon: Icon, n, word }) => (
            <span key={word} className="inline-flex items-center gap-1 tabular-nums">
              <Icon size={13} /> {n} {word}
              {n === 1 ? "" : "s"}
            </span>
          ))}
        </div>
      )}
    </nav>
  );
};

export default DocOutlinePanel;
