// components/docs/DocCommentsSidebar.tsx
//
// Docked (not modal, unlike DocVersionHistoryPanel) right-side panel listing every comment on the
// open doc. A comment's anchor position is never trusted from storage - see docCommentMark.ts's own
// header comment - so findCommentRange below walks the *current* editor.state.doc for a mark
// carrying each comment's markId every render, which is what lets a comment keep tracking its text
// correctly even after unrelated edits elsewhere in the document shift ProseMirror positions.
import React, { useMemo } from "react";
import type { Editor } from "@tiptap/core";
import { IoCheckmarkCircleOutline, IoClose, IoRefreshOutline, IoTrashOutline } from "react-icons/io5";
import { DocComment } from "../../utils/docTypes";

interface DocCommentsSidebarProps {
  editor: Editor;
  comments: DocComment[];
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

function findCommentRange(editor: Editor, markId: string): { from: number; to: number } | null {
  let from: number | null = null;
  let to: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    const mark = node.marks.find((m) => m.type.name === "comment" && m.attrs.commentId === markId);
    if (mark) {
      if (from === null) from = pos;
      to = pos + node.nodeSize;
    }
  });
  if (from === null || to === null) return null;
  return { from, to };
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const DocCommentsSidebar: React.FC<DocCommentsSidebarProps> = ({ editor, comments, onResolve, onReopen, onDelete, onClose }) => {
  // Positioned by where each comment's anchor currently sits in the doc (reading order), not
  // creation time - an orphaned comment (its mark was somehow stripped without going through
  // deleteComment, e.g. a raw markdown/docx round trip) sorts last rather than disappearing.
  const withRanges = useMemo(
    () =>
      comments.map((comment) => ({
        comment,
        range: findCommentRange(editor, comment.mark_id),
      })),
    [comments, editor.state.doc]
  );
  const active = withRanges.filter((c) => !c.comment.resolved_at).sort((a, b) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity));
  const resolved = withRanges.filter((c) => c.comment.resolved_at);

  const handleClick = (range: { from: number; to: number } | null) => {
    if (!range) return;
    editor.chain().focus().setTextSelection(range).scrollIntoView().run();
  };

  const renderComment = (entry: (typeof withRanges)[number]) => {
    const { comment, range } = entry;
    const excerpt = range ? editor.state.doc.textBetween(range.from, range.to, " ").trim() : null;
    return (
      <div
        key={comment.id}
        role="button"
        tabIndex={0}
        onClick={() => handleClick(range)}
        className="rounded-md border border-neutral-200 dark:border-neutral-800 p-2.5 mb-2 cursor-pointer hover:border-blue-300 dark:hover:border-blue-600"
      >
        {excerpt ? (
          <p className="text-xs text-neutral-400 dark:text-neutral-500 truncate mb-1">"{excerpt}"</p>
        ) : (
          <p className="text-xs text-neutral-400 dark:text-neutral-500 italic mb-1">Original text no longer found</p>
        )}
        <p className="text-sm text-neutral-800 dark:text-neutral-100 whitespace-pre-wrap break-words">{comment.text}</p>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-xs text-neutral-400 dark:text-neutral-500">{formatRelative(comment.created_at)}</span>
          <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {comment.resolved_at ? (
              <button
                type="button"
                title="Reopen"
                onClick={() => onReopen(comment.id)}
                className="p-1 rounded text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <IoRefreshOutline size={14} />
              </button>
            ) : (
              <button
                type="button"
                title="Resolve"
                onClick={() => onResolve(comment.id)}
                className="p-1 rounded text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <IoCheckmarkCircleOutline size={14} />
              </button>
            )}
            <button
              type="button"
              title="Delete comment"
              onClick={() => onDelete(comment.id)}
              className="p-1 rounded text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
            >
              <IoTrashOutline size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="w-80 shrink-0 h-full border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex flex-col print:hidden">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-neutral-200 dark:border-neutral-800">
        <h2 className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Comments</h2>
        <button
          type="button"
          title="Close"
          onClick={onClose}
          className="ml-auto p-1.5 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <IoClose size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2.5">
        {active.length === 0 && resolved.length === 0 ? (
          <p className="text-xs text-neutral-400 dark:text-neutral-500 px-1 py-2">
            Select text and use the comment button in the toolbar to leave a note.
          </p>
        ) : (
          <>
            {active.map((entry) => renderComment(entry))}
            {resolved.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-neutral-400 dark:text-neutral-500 cursor-pointer px-1 py-1">
                  Resolved ({resolved.length})
                </summary>
                <div className="mt-1">{resolved.map((entry) => renderComment(entry))}</div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default DocCommentsSidebar;
