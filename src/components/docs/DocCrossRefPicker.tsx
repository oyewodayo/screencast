// components/docs/DocCrossRefPicker.tsx
//
// Insert or retarget a cross-reference ("see Figure 3", "Eq. (2)"): figures, tables and numbered
// equations, each with its live number and caption (or a rendered preview of the equation). The
// reference stores only the target's id, so it follows the figure wherever it moves. Opened from
// the toolbar and, for an existing reference, anchored to it (with "Go to" and "Remove").
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { IoArrowForward, IoImageOutline } from "react-icons/io5";
import { TbMathFunction, TbTable } from "react-icons/tb";
import { getDocStructure, revealPos, crossRefLabel, type TargetKind } from "../../utils/docStructure";
import { renderLatex } from "./DocMathView";

export type CrossRefPickerMode = { kind: "insert" } | { kind: "edit"; pos: number; targetId: string | null };

interface Candidate {
  kind: TargetKind;
  number: number;
  label: string;
  text: string;
  pos: number;
  id: string | null;
}

const TABS: { kind: TargetKind; title: string; icon: React.ComponentType<{ size?: number }>; empty: string }[] = [
  { kind: "figure", title: "Figures", icon: IoImageOutline, empty: "No captioned figures yet. Select an image and choose Caption, or type /figure caption." },
  { kind: "table", title: "Tables", icon: TbTable, empty: "No captioned tables yet. Put the cursor in a table and choose Add caption from the table menu." },
  { kind: "equation", title: "Equations", icon: TbMathFunction, empty: "No numbered equations yet. Type $$ and a space on an empty line to add one." },
];

function candidates(editor: Editor): Candidate[] {
  const s = getDocStructure(editor.state);
  if (!s) return [];
  const out: Candidate[] = [];
  for (const [pos, t] of s.captionAt) out.push({ kind: t.kind, number: t.number, label: t.label, text: t.text, pos, id: t.id || null });
  for (const [pos, number] of s.equationAt) {
    const node = editor.state.doc.nodeAt(pos);
    out.push({ kind: "equation", number, label: crossRefLabel("equation", number), text: String(node?.attrs.latex ?? ""), pos, id: (node?.attrs.id as string | null) ?? null });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

const DocCrossRefPicker: React.FC<{ editor: Editor; mode: CrossRefPickerMode; onClose: () => void }> = ({ editor, mode, onClose }) => {
  const all = useMemo(() => candidates(editor), [editor]);
  const current = mode.kind === "edit" ? all.find((c) => c.id && c.id === mode.targetId) : undefined;
  const [tab, setTab] = useState<TargetKind>(current?.kind ?? TABS.find((t) => all.some((c) => c.kind === t.kind))?.kind ?? "figure");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const items = all.filter((c) => c.kind === tab);

  useEffect(() => {
    listRef.current?.focus();
  }, [tab]);
  useEffect(() => setActive(Math.max(0, current && current.kind === tab ? items.indexOf(current) : 0)), [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (c: Candidate) => {
    let id = c.id;
    const chain = editor.chain().focus();
    if (!id) {
      // Equations get their id the first time something points at them.
      id = crypto.randomUUID();
      const targetId = id;
      chain.command(({ tr }) => {
        const node = tr.doc.nodeAt(c.pos);
        if (!node) return false;
        tr.setNodeMarkup(c.pos, undefined, { ...node.attrs, id: targetId });
        return true;
      });
    }
    if (mode.kind === "edit") chain.updateCrossRefAt(mode.pos, id);
    else chain.insertCrossRef(id);
    chain.run();
    onClose();
  };

  const goTo = () => {
    if (!current) return;
    onClose();
    revealPos(editor.view, current.pos);
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const i = TABS.findIndex((t) => t.kind === tab);
      setTab(TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].kind);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[active]) choose(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="w-[24rem] max-w-[calc(100vw-2rem)]">
      {mode.kind === "edit" && (
        <div className="flex items-center gap-2 px-3 pt-3 pb-2.5 border-b border-neutral-200 dark:border-neutral-700">
          <div className="min-w-0 flex-1 text-[13px] text-neutral-600 dark:text-neutral-300">
            {current ? (
              <>
                Points to <b className="font-semibold text-neutral-900 dark:text-neutral-100">{current.label}</b>
              </>
            ) : (
              <span className="text-red-600 dark:text-red-400">Its target was deleted - pick a new one.</span>
            )}
          </div>
          {current && (
            <button type="button" onClick={goTo} className="shrink-0 h-7 px-2.5 inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/15">
              Go to <IoArrowForward size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().command(({ tr }) => {
                const node = tr.doc.nodeAt(mode.pos);
                if (node) tr.delete(mode.pos, mode.pos + node.nodeSize);
                return true;
              }).run();
              onClose();
            }}
            className="shrink-0 h-7 px-2.5 rounded-md text-[13px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
          >
            Remove
          </button>
        </div>
      )}
      <div className="flex gap-1 px-2.5 pt-2.5" role="tablist">
        {TABS.map((t) => {
          const count = all.filter((c) => c.kind === t.kind).length;
          const Icon = t.icon;
          return (
            <button
              key={t.kind}
              type="button"
              role="tab"
              aria-selected={tab === t.kind}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTab(t.kind)}
              className={`flex-1 h-8 inline-flex items-center justify-center gap-1.5 rounded-md text-[13px] transition-colors ${
                tab === t.kind ? "bg-blue-50 text-blue-700 font-medium dark:bg-blue-500/20 dark:text-blue-200" : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700/60"
              }`}
            >
              <Icon size={15} />
              {t.title}
              <span className="text-[11px] tabular-nums opacity-60">{count}</span>
            </button>
          );
        })}
      </div>
      <div ref={listRef} tabIndex={-1} onKeyDown={onKey} className="max-h-72 overflow-y-auto p-1.5 outline-none" role="listbox">
        {items.length === 0 ? (
          <p className="px-4 py-7 text-center text-xs leading-relaxed text-neutral-400">{TABS.find((t) => t.kind === tab)!.empty}</p>
        ) : (
          items.map((c, i) => (
            <div
              key={c.pos}
              role="option"
              aria-selected={current === c}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(c)}
              className={`flex items-center gap-3 px-2.5 py-2 rounded-lg cursor-pointer ${i === active ? "bg-neutral-100 dark:bg-neutral-700/60" : ""}`}
            >
              <span className={`shrink-0 min-w-[4.5rem] text-[13px] font-semibold tabular-nums ${current === c ? "text-blue-700 dark:text-blue-300" : "text-neutral-800 dark:text-neutral-100"}`}>{c.label}</span>
              {c.kind === "equation" ? (
                <span className="min-w-0 flex-1 overflow-hidden text-neutral-800 dark:text-neutral-100 doc-xref-eq-preview" dangerouslySetInnerHTML={{ __html: renderLatex(c.text, false).html }} />
              ) : (
                <span className={`min-w-0 flex-1 truncate text-[13px] ${c.text ? "text-neutral-600 dark:text-neutral-300" : "italic text-neutral-400"}`}>{c.text || "No caption text"}</span>
              )}
            </div>
          ))
        )}
      </div>
      <div className="px-3 py-2 border-t border-neutral-200 dark:border-neutral-700 text-[11.5px] text-neutral-400">
        Numbers update on their own when things move.
      </div>
    </div>
  );
};

export default DocCrossRefPicker;
