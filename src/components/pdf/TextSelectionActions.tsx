// components/pdf/TextSelectionActions.tsx
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IoChatbubbleEllipsesOutline, IoCheckmark, IoCopyOutline } from "react-icons/io5";
import type { LocalRect, PageTextSelection } from "../../hooks/usePdfTextSelection";

const EDGE_MARGIN_PX = 8;
const MENU_GAP_PX = 8;
const COMPOSER_WIDTH_PX = 300;
const COPIED_FLASH_MS = 1100;

// Writes to the clipboard, falling back to the legacy copy command (which PdfTextLayer's own copy
// listener cleans up the same way) if the async Clipboard API is unavailable or refused.
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    document.execCommand("copy");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

const isEditableTarget = (el: Element | null): boolean =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");

// Per-line tint for a selection whose native highlight is gone (focus moved into the composer) —
// keeps "what am I commenting on" visible the whole time the note is being written.
export const PendingTint: React.FC<{ rects: LocalRect[]; strong?: boolean }> = ({ rects, strong }) => (
  <>
    {rects.map((r, i) => (
      <div
        key={i}
        className="absolute pointer-events-none rounded-[2px] transition-[background-color,box-shadow] duration-150"
        style={{
          left: r.left - 1,
          top: r.top - 1,
          width: r.width + 2,
          height: r.height + 2,
          zIndex: 15,
          backgroundColor: strong ? "rgba(255,176,32,0.26)" : "rgba(255,176,32,0.18)",
          boxShadow: strong ? "inset 0 -2px 0 rgba(230,140,0,0.9)" : "inset 0 -1.5px 0 rgba(230,140,0,0.7)",
        }}
      />
    ))}
  </>
);

interface SelectionMenuProps {
  selection: PageTextSelection;
  pageWidth: number;
  onComment: () => void;
  onDismiss: () => void;
}

// The small dark pill that appears over a finished selection: Comment, Copy. Sits centered above
// the selection (below it when there's no room above), clamped inside the page.
export const SelectionMenu: React.FC<SelectionMenuProps> = ({ selection, pageWidth, onComment, onDismiss }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [copied, setCopied] = useState(false);
  const { bounds } = selection;

  useLayoutEffect(() => {
    if (ref.current) setWidth(ref.current.offsetWidth);
  }, [copied]);

  // A new selection resets the "Copied" confirmation.
  useEffect(() => setCopied(false), [selection]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    return () => window.clearTimeout(id);
  }, [copied]);

  // "C" comments on the current selection without reaching for the mouse; Escape drops it.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onDismiss();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "c" || isEditableTarget(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      onComment();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onComment, onDismiss]);

  const handleCopy = (): void => {
    copyText(selection.text);
    setCopied(true);
  };

  const menuHeight = 34;
  const above = bounds.top - menuHeight - MENU_GAP_PX >= EDGE_MARGIN_PX;
  const top = above ? bounds.top - menuHeight - MENU_GAP_PX : bounds.bottom + MENU_GAP_PX;
  const center = (bounds.left + bounds.right) / 2;
  const left = clamp(center - width / 2, EDGE_MARGIN_PX, pageWidth - width - EDGE_MARGIN_PX);

  return (
    <div
      ref={ref}
      data-annotation-editor=""
      role="toolbar"
      aria-label="Selected text actions"
      // Keeps the press from collapsing the very selection the buttons act on.
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.preventDefault()}
      className="pdfPopIn absolute flex items-center h-[34px] p-[3px] rounded-[10px] bg-neutral-900/95 text-white shadow-[0_8px_24px_rgba(0,0,0,0.28)] ring-1 ring-white/10 backdrop-blur select-none"
      style={{ left, top, zIndex: 30, transformOrigin: above ? "50% 100%" : "50% 0%" }}
    >
      <button
        type="button"
        onClick={onComment}
        data-tip="Add comment"
        data-tip-kbd="C"
        className="flex items-center gap-1.5 h-full px-2.5 rounded-[7px] text-[12.5px] font-medium hover:bg-white/15 active:bg-white/20 transition-colors"
      >
        <IoChatbubbleEllipsesOutline className="text-[15px] text-amber-300" />
        Comment
      </button>
      <div className="w-px h-4 bg-white/15 mx-0.5" />
      <button
        type="button"
        onClick={handleCopy}
        data-tip={copied ? undefined : "Copy text"}
        data-tip-kbd={copied ? undefined : "Ctrl+C"}
        className="flex items-center gap-1.5 h-full px-2.5 rounded-[7px] text-[12.5px] font-medium hover:bg-white/15 active:bg-white/20 transition-colors"
      >
        {copied ? <IoCheckmark className="text-[15px] text-emerald-400 pdfPopIn" /> : <IoCopyOutline className="text-[14px]" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
};

interface CommentFieldProps {
  initialText?: string;
  submitLabel: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

// Auto-growing textarea + Cancel/submit row, shared by the new-comment composer and in-place edit.
// Enter posts, Shift+Enter breaks a line, Escape backs out.
export const CommentField: React.FC<CommentFieldProps> = ({ initialText = "", submitLabel, onSubmit, onCancel }) => {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = text.trim().length > 0;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Measured size is set synchronously before paint (this is a layout effect), so the first frame
    // the user sees is already the right size. scrollHeight excludes the border; add it back or the
    // box comes up 2px short and grows a scrollbar.
    el.style.height = "auto";
    const border = el.offsetHeight - el.clientHeight;
    const height = el.scrollHeight + border;
    el.style.height = `${Math.min(height, 160)}px`;
    el.style.overflowY = height > 160 ? "auto" : "hidden";
  }, [text]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSubmit) onSubmit(text.trim());
    }
  };

  return (
    <div>
      <textarea
        ref={textareaRef}
        value={text}
        rows={1}
        placeholder="Add a comment…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        className="block w-full resize-none rounded-lg border border-black/10 bg-neutral-50 px-2.5 py-2 text-[13px] leading-[1.45] text-neutral-900 placeholder:text-neutral-400 outline-none focus:border-amber-400 focus:bg-white focus:ring-[3px] focus:ring-amber-300/30 transition-[border-color,box-shadow,background-color]"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10.5px] text-neutral-400 truncate" title="Enter to post · Shift+Enter for a new line">
          ⏎ to {submitLabel === "Save" ? "save" : "post"}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={onCancel} className="h-7 px-2.5 rounded-md text-[12px] text-neutral-600 hover:bg-black/5 transition-colors">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onSubmit(text.trim())}
            className="h-7 px-3 rounded-md text-[12px] font-medium bg-neutral-900 text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400 transition-colors"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export const QuoteSnippet: React.FC<{ text: string }> = ({ text }) => (
  <div className="flex gap-2 mb-2">
    <div className="w-[3px] shrink-0 rounded-full bg-amber-400" />
    <p className="text-[12px] leading-[1.4] italic text-neutral-500 line-clamp-2 break-words">{text}</p>
  </div>
);

interface CommentComposerProps {
  draft: PageTextSelection;
  pageWidth: number;
  pageHeight: number;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

// The new-comment card: anchored just under the selection's last line (above its first if the page
// runs out below), with the pending text kept tinted underneath it.
export const CommentComposer: React.FC<CommentComposerProps> = ({ draft, pageWidth, pageHeight, onSubmit, onCancel }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    if (ref.current) setHeight(ref.current.offsetHeight);
  });

  // Pressing anywhere outside the card backs out — an empty or abandoned draft never lingers.
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent): void => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onCancel();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [onCancel]);

  const { bounds } = draft;
  const last = draft.lineRects[draft.lineRects.length - 1];
  const fitsBelow = bounds.bottom + MENU_GAP_PX + height <= pageHeight - EDGE_MARGIN_PX;
  const top = fitsBelow ? bounds.bottom + MENU_GAP_PX : Math.max(EDGE_MARGIN_PX, bounds.top - MENU_GAP_PX - height);
  const left = clamp(last.left, EDGE_MARGIN_PX, pageWidth - COMPOSER_WIDTH_PX - EDGE_MARGIN_PX);

  return (
    <>
      <PendingTint rects={draft.lineRects} strong />
      <div
        ref={ref}
        data-annotation-editor=""
        onPointerDown={(e) => e.stopPropagation()}
        className="pdfPopIn absolute rounded-xl bg-white p-3 shadow-[0_12px_36px_rgba(0,0,0,0.18)] ring-1 ring-black/[0.08]"
        style={{ left, top, width: COMPOSER_WIDTH_PX, zIndex: 30, transformOrigin: fitsBelow ? "0 0" : "0 100%" }}
      >
        <QuoteSnippet text={draft.text} />
        <CommentField submitLabel="Comment" onSubmit={onSubmit} onCancel={onCancel} />
      </div>
    </>
  );
};
