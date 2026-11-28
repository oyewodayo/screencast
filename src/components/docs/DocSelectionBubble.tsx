// components/docs/DocSelectionBubble.tsx
//
// Google-Docs / Notion-grade floating selection formatting bubble for Briefcast Docs.
// Appears smoothly above any non-empty text selection so formatting, highlighting, linking,
// heading conversion, and commenting never require trekking back up to the top toolbar.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import {
  MdCode,
  MdFormatBold,
  MdFormatClear,
  MdFormatItalic,
  MdFormatQuote,
  MdFormatStrikethrough,
  MdFormatUnderlined,
  MdHighlight,
  MdLink,
  MdOutlineAddComment,
} from "react-icons/md";
import { tipProps } from "./DocToolbar";

interface DocSelectionBubbleProps {
  editor: Editor;
  disabled?: boolean;
  onOpenLink: () => void;
  onAddComment?: (text: string) => void;
}

const BUBBLE_HEIGHT = 40;
const BUBBLE_MARGIN = 10;

const DocSelectionBubble: React.FC<DocSelectionBubbleProps> = ({
  editor,
  disabled = false,
  onOpenLink,
  onAddComment,
}) => {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const commentInputRef = useRef<HTMLInputElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [, setRenderTick] = useState(0);

  // Only treat pointer drags that start inside the editor surface as text-selection drags.
  // Listening blindly on window would hide and unmount the bubble on pointerdown before any
  // bubble button's click event could fire.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (bubbleRef.current?.contains(target)) return;
      if (editor.view?.dom?.contains(target)) {
        setDragging(true);
        setCommenting(false);
      } else {
        setCommenting(false);
      }
    };
    const onUp = () => setDragging(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [editor]);

  useEffect(() => {
    if (commenting) {
      requestAnimationFrame(() => commentInputRef.current?.focus());
    }
  }, [commenting]);

  useEffect(() => {
    const update = () => {
      if (disabled || dragging) {
        setPos(null);
        return;
      }
      const focusInsideBubble = !!bubbleRef.current && bubbleRef.current.contains(document.activeElement);
      if (!editor.isFocused && !commenting && !focusInsideBubble) {
        setPos(null);
        return;
      }
      const { selection } = editor.state;
      if (selection.empty || selection instanceof NodeSelection) {
        setPos(null);
        setCommenting(false);
        return;
      }
      const selectedText = editor.state.doc.textBetween(selection.from, selection.to, " ").trim();
      if (!selectedText) {
        setPos(null);
        setCommenting(false);
        return;
      }
      try {
        const start = editor.view.coordsAtPos(selection.from);
        const end = editor.view.coordsAtPos(selection.to);
        const midX = (start.left + end.right) / 2;
        const topY = Math.min(start.top, end.top) - BUBBLE_HEIGHT - BUBBLE_MARGIN;
        const bottomY = Math.max(start.bottom, end.bottom) + BUBBLE_MARGIN;
        const halfWidth = 200;
        const clampedLeft = Math.max(halfWidth, Math.min(window.innerWidth - halfWidth, midX));
        const finalTop = topY >= 56 ? topY : Math.min(window.innerHeight - BUBBLE_HEIGHT - 12, bottomY);
        setPos({ left: clampedLeft, top: finalTop });
        setRenderTick((n) => n + 1);
      } catch {
        setPos(null);
      }
    };

    const onBlur = () => {
      // Defer blur check one tick so clicking inside the bubble (e.g. quick-comment input)
      // does not prematurely hide the toolbar.
      requestAnimationFrame(update);
    };

    update();
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    editor.on("focus", update);
    editor.on("blur", onBlur);
    window.addEventListener("scroll", update, true);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
      editor.off("focus", update);
      editor.off("blur", onBlur);
      window.removeEventListener("scroll", update, true);
    };
  }, [editor, disabled, dragging, commenting]);

  if (!pos) return null;

  const btn = (active: boolean) =>
    `h-7 min-w-7 px-1.5 inline-flex items-center justify-center rounded-md text-xs transition-colors cursor-pointer ${
      active
        ? "bg-blue-600 text-white"
        : "text-neutral-200 hover:bg-white/15 hover:text-white"
    }`;

  // Preserve editor focus & selection whenever clicking toolbar buttons (but allow input focus).
  const keepSelection = (e: React.SyntheticEvent) => {
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onLink = editor.isActive("link");
  const linkUnderlineOff = editor.getAttributes("link").underlineOff === true;
  const underlineActive = onLink ? !linkUnderlineOff : editor.isActive("underline");

  const runCmd = (fn: () => void) => {
    fn();
    setRenderTick((n) => n + 1);
  };

  const submitQuickComment = () => {
    const trimmed = commentDraft.trim();
    if (!trimmed || !onAddComment) return;
    onAddComment(trimmed);
    setCommentDraft("");
    setCommenting(false);
    editor.commands.focus();
  };

  return createPortal(
    <div
      ref={bubbleRef}
      onMouseDown={keepSelection}
      onPointerDown={keepSelection}
      style={{ left: pos.left, top: pos.top, transform: "translateX(-50%)" }}
      className="fixed z-[70] flex items-center gap-0.5 px-1.5 py-1 rounded-xl bg-neutral-900/95 dark:bg-neutral-800/95 backdrop-blur-md text-white shadow-2xl ring-1 ring-white/15 select-none print:hidden"
    >
      {commenting ? (
        <form
          className="flex items-center gap-1.5 px-1"
          onSubmit={(e) => {
            e.preventDefault();
            submitQuickComment();
          }}
        >
          <input
            ref={commentInputRef}
            type="text"
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setCommenting(false);
                editor.commands.focus();
              }
            }}
            placeholder="Add a comment…"
            className="w-52 h-7 px-2 rounded-md bg-white/10 text-xs text-white placeholder:text-neutral-400 border border-white/15 outline-none focus:border-blue-400"
          />
          <button
            type="submit"
            disabled={!commentDraft.trim()}
            className="h-7 px-2.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-xs font-medium text-white transition-colors"
          >
            Comment
          </button>
          <button
            type="button"
            onClick={() => {
              setCommenting(false);
              editor.commands.focus();
            }}
            className="h-7 px-2 rounded-md text-xs text-neutral-300 hover:bg-white/10"
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            {...tipProps("Heading 2")}
            aria-label="Heading 2"
            onClick={() => runCmd(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}
            className={`${btn(editor.isActive("heading", { level: 2 }))} font-semibold text-[11px]`}
          >
            H2
          </button>
          <button
            type="button"
            {...tipProps("Heading 3")}
            aria-label="Heading 3"
            onClick={() => runCmd(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}
            className={`${btn(editor.isActive("heading", { level: 3 }))} font-semibold text-[11px]`}
          >
            H3
          </button>
          <span className="w-px h-4 bg-white/15 mx-0.5" />
          <button
            type="button"
            {...tipProps("Bold (Ctrl+B)")}
            aria-label="Bold"
            onClick={() => runCmd(() => editor.chain().focus().toggleBold().run())}
            className={btn(editor.isActive("bold"))}
          >
            <MdFormatBold size={16} />
          </button>
          <button
            type="button"
            {...tipProps("Italic (Ctrl+I)")}
            aria-label="Italic"
            onClick={() => runCmd(() => editor.chain().focus().toggleItalic().run())}
            className={btn(editor.isActive("italic"))}
          >
            <MdFormatItalic size={16} />
          </button>
          <button
            type="button"
            {...tipProps("Underline (Ctrl+U)")}
            aria-label="Underline"
            onClick={() =>
              runCmd(() =>
                onLink
                  ? editor.chain().focus().updateAttributes("link", { underlineOff: !linkUnderlineOff }).run()
                  : editor.chain().focus().toggleUnderline().run()
              )
            }
            className={btn(underlineActive)}
          >
            <MdFormatUnderlined size={16} />
          </button>
          <button
            type="button"
            {...tipProps("Strikethrough")}
            aria-label="Strikethrough"
            onClick={() => runCmd(() => editor.chain().focus().toggleStrike().run())}
            className={btn(editor.isActive("strike"))}
          >
            <MdFormatStrikethrough size={15} />
          </button>
          <button
            type="button"
            {...tipProps("Inline code")}
            aria-label="Inline code"
            onClick={() => runCmd(() => editor.chain().focus().toggleCode().run())}
            className={btn(editor.isActive("code"))}
          >
            <MdCode size={15} />
          </button>
          <button
            type="button"
            {...tipProps("Highlight")}
            aria-label="Highlight"
            onClick={() =>
              runCmd(() =>
                editor.isActive("highlight")
                  ? editor.chain().focus().unsetHighlight().run()
                  : editor.chain().focus().setHighlight({ color: "#fef08a" }).run()
              )
            }
            className={btn(editor.isActive("highlight"))}
          >
            <MdHighlight size={15} />
          </button>
          <span className="w-px h-4 bg-white/15 mx-0.5" />
          <button
            type="button"
            {...tipProps("Quote")}
            aria-label="Quote"
            onClick={() => runCmd(() => editor.chain().focus().toggleBlockquote().run())}
            className={btn(editor.isActive("blockquote"))}
          >
            <MdFormatQuote size={16} />
          </button>
          <button
            type="button"
            {...tipProps("Insert link (Ctrl+K)")}
            aria-label="Insert link"
            onClick={onOpenLink}
            className={btn(onLink)}
          >
            <MdLink size={16} />
          </button>
          {onAddComment && (
            <button
              type="button"
              {...tipProps("Add comment")}
              aria-label="Add comment"
              onClick={() => setCommenting(true)}
              className={btn(false)}
            >
              <MdOutlineAddComment size={15} />
            </button>
          )}
          <button
            type="button"
            {...tipProps("Clear formatting")}
            aria-label="Clear formatting"
            onClick={() => runCmd(() => editor.chain().focus().unsetAllMarks().clearNodes().run())}
            className={btn(false)}
          >
            <MdFormatClear size={15} />
          </button>
        </>
      )}
    </div>,
    document.body
  );
};

export default DocSelectionBubble;
