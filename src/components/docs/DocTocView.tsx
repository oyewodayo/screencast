// components/docs/DocTocView.tsx
//
// NodeView for the table of contents (docStructureNodes.ts's `tableOfContents`): every heading up
// to the chosen level, with dot leaders and the page it falls on. Page numbers come from the live
// pagination (docAutoPaginate.ts's page-gap widgets), and print/PDF break pages at those same
// points (docPageLayout.css), so the numbers shown here are the numbers on paper.
import React, { useEffect, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { IoTrashOutline } from "react-icons/io5";
import { getDocStructure, revealPos, type HeadingEntry } from "../../utils/docStructure";
import { pageAtPos } from "../../utils/docAutoPaginate";

interface TocEntry extends HeadingEntry {
  page: number;
}

function sameEntries(a: TocEntry[], b: TocEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.pos === b[i].pos && e.page === b[i].page && e.text === b[i].text && e.level === b[i].level);
}

const LEVELS = [1, 2, 3, 4];

const DocTocView: React.FC<NodeViewProps> = ({ editor, node, selected, updateAttributes, deleteNode }) => {
  const maxLevel = Number(node.attrs.maxLevel ?? 3);
  const [entries, setEntries] = useState<TocEntry[]>([]);

  // Pagination settles a frame or two after an edit (and again whenever it re-measures), so page
  // numbers are re-read after every transaction rather than only when headings change.
  useEffect(() => {
    let frame = 0;
    const recompute = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        const headings = (getDocStructure(editor.state)?.headings ?? []).filter((h) => h.level <= maxLevel && h.text);
        const next = headings.map((h) => ({ ...h, page: pageAtPos(editor.view, h.pos) }));
        setEntries((prev) => (sameEntries(prev, next) ? prev : next));
      });
    };
    recompute();
    editor.on("transaction", recompute);
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", recompute);
    };
  }, [editor, maxLevel]);

  const go = (pos: number) => {
    const { view } = editor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.min(pos + 1, view.state.doc.content.size))));
    view.focus();
    revealPos(view, pos);
  };

  const minLevel = entries.reduce((m, e) => Math.min(m, e.level), 6);

  return (
    <NodeViewWrapper as="div" contentEditable={false} className={`doc-toc ${selected ? "doc-block-selected" : ""}`}>
      {selected && editor.isEditable && (
        <div className="doc-block-toolbar print:hidden" onMouseDown={(e) => e.preventDefault()}>
          <span className="doc-block-toolbar-label">Show headings</span>
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`doc-block-toolbar-chip ${level === maxLevel ? "is-active" : ""}`}
              onClick={() => updateAttributes({ maxLevel: level })}
              data-tip={level === 1 ? "Heading 1 only" : `Headings 1–${level}`}
            >
              {level === 1 ? "H1" : `H1–${level}`}
            </button>
          ))}
          <span className="doc-block-toolbar-sep" />
          <button type="button" className="doc-block-toolbar-icon" onClick={() => deleteNode()} data-tip="Remove table of contents">
            <IoTrashOutline size={14} />
          </button>
        </div>
      )}
      <div className="doc-toc-title">Contents</div>
      {entries.length === 0 ? (
        <div className="doc-generated-empty">Headings you add (Heading 1{maxLevel > 1 ? `–${maxLevel}` : ""}) are listed here with their page numbers.</div>
      ) : (
        <ol className="doc-toc-list">
          {entries.map((entry) => (
            <li key={entry.pos} className="doc-toc-entry" data-depth={entry.level - minLevel}>
              <button type="button" onClick={() => go(entry.pos)} className="doc-toc-link">
                <span className="doc-toc-text">{entry.text}</span>
                <span className="doc-toc-leader" aria-hidden />
                <span className="doc-toc-page">{entry.page}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </NodeViewWrapper>
  );
};

export default DocTocView;
