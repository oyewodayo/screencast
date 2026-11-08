// components/docs/DocMathView.tsx
//
// NodeView for both equation nodes (docMathExtension.ts) - renders the `latex` attribute with KaTeX
// and owns the source editor: click an equation (or press Enter on a selected one) and a popover
// opens under it with the LaTeX source and a live preview. The doc only changes on commit (Enter /
// Done / clicking away), not per keystroke, so typing a long formula doesn't flood the Y.Doc and
// undo history with half-typed states. Committing an empty source deletes the equation, the way
// clearing an image's crop or a comment's text removes it elsewhere in Docs.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeViewWrapper, NodeViewProps } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import katex from "katex";
import "katex/dist/katex.min.css";
import "./docMath.css";
import { openLink } from "./DocReferenceText";

// Dispatched on a math node's DOM to open its source editor - how the keyboard (Enter on a
// selected equation) and docMathExtension.ts's insert commands reach this NodeView's React state.
export const MATH_EDIT_EVENT = "doc-math-edit";

interface Rendered {
  html: string;
  error: string | null;
}

// throwOnError: true first, purely to get a readable message for the popover; the fallback render
// (throwOnError: false) still shows everything KaTeX could parse, with the bad part in red.
export function renderLatex(latex: string, displayMode: boolean): Rendered {
  const options = { displayMode, output: "html" as const, strict: "ignore" as const, trust: false };
  try {
    return { html: katex.renderToString(latex, { ...options, throwOnError: true }), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(/^KaTeX parse error:\s*/, "") : String(err);
    try {
      return { html: katex.renderToString(latex, { ...options, throwOnError: false }), error: message };
    } catch {
      return { html: "", error: message };
    }
  }
}

const POPOVER_WIDTH = 420;

// The equation's number, delivered by docStructure.ts as a node decoration.
function equationNumber(decorations: NodeViewProps["decorations"]): string | null {
  for (const d of decorations) {
    const n = (d.spec as { eqNumber?: string | null }).eqNumber;
    if (typeof n === "string" && n) return n;
  }
  return null;
}

const DocMathView: React.FC<NodeViewProps> = ({ node, editor, getPos, selected, decorations, updateAttributes, deleteNode }) => {
  const isBlock = node.type.name === "mathBlock";
  const latex = (node.attrs.latex as string) ?? "";
  const numbered = isBlock && node.attrs.numbered !== false;

  const wrapperRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(latex);
  const [draftNumbered, setDraftNumbered] = useState(numbered);
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number } | null>(null);

  const rendered = useMemo(() => (latex ? renderLatex(latex, isBlock) : null), [latex, isBlock]);
  const preview = useMemo(() => (editing && draft.trim() ? renderLatex(draft, isBlock) : null), [editing, draft, isBlock]);

  const open = useCallback(() => {
    if (!editor.isEditable || editing) return;
    setDraft((node.attrs.latex as string) ?? "");
    setDraftNumbered(node.attrs.numbered !== false);
    setEditing(true);
  }, [editor, node, editing]);

  // A display equation wider than its column (a two-column page) is set smaller to fit, the way a
  // journal sets a long equation, instead of scrolling sideways.
  useLayoutEffect(() => {
    if (!isBlock) return;
    const wrapper = wrapperRef.current;
    const render = wrapper?.querySelector<HTMLElement>(".doc-math-render");
    if (!wrapper || !render) return;
    const fit = () => {
      render.style.fontSize = "";
      const math = render.querySelector<HTMLElement>(".katex");
      if (!math) return;
      const cs = getComputedStyle(wrapper);
      const available = wrapper.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const natural = math.scrollWidth;
      if (available > 0 && natural > available + 1) render.style.fontSize = `${Math.max(0.6, available / natural)}em`;
    };
    fit();
    // KaTeX's fonts may still be loading on first render, which changes the formula's width.
    let alive = true;
    void document.fonts.ready.then(() => alive && fit());
    const observer = new ResizeObserver(fit);
    observer.observe(wrapper);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [isBlock, rendered]);

  // Keyboard (Enter on a selected equation) and the insert commands open the editor through a DOM
  // event on this NodeView's root - see docMathExtension.ts.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onEdit = () => open();
    el.addEventListener(MATH_EDIT_EVENT, onEdit);
    return () => el.removeEventListener(MATH_EDIT_EVENT, onEdit);
  }, [open]);

  // Where the cursor goes after closing: just past the equation (so typing continues), or back on
  // the equation itself after a cancel.
  const refocus = useCallback(
    (selectNode: boolean) => {
      const pos = typeof getPos === "function" ? getPos() : undefined;
      if (typeof pos !== "number") return;
      if (selectNode) {
        editor.chain().focus().command(({ tr }) => {
          tr.setSelection(NodeSelection.create(tr.doc, pos));
          return true;
        }).run();
      } else {
        editor.chain().focus().setTextSelection(pos + node.nodeSize).run();
      }
    },
    [editor, getPos, node.nodeSize]
  );

  const commit = useCallback(() => {
    setEditing(false);
    const source = draft.trim();
    if (!source) {
      deleteNode();
      editor.commands.focus();
      return;
    }
    if (source !== latex || (isBlock && draftNumbered !== numbered)) {
      updateAttributes(isBlock ? { latex: source, numbered: draftNumbered } : { latex: source });
    }
    refocus(false);
  }, [draft, latex, isBlock, draftNumbered, numbered, updateAttributes, deleteNode, editor, refocus]);

  const cancel = useCallback(() => {
    setEditing(false);
    // A brand-new equation that was never given any source isn't worth keeping.
    if (!latex) {
      deleteNode();
      editor.commands.focus();
      return;
    }
    refocus(true);
  }, [latex, deleteNode, editor, refocus]);

  // Fixed-position under the equation, flipped above it near the bottom of the window, and kept
  // in place while the page scrolls underneath (capture: the doc scroller isn't the window).
  useLayoutEffect(() => {
    if (!editing) return;
    const place = () => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const height = popoverRef.current?.offsetHeight ?? 220;
      const anchorLeft = isBlock ? rect.left + rect.width / 2 - POPOVER_WIDTH / 2 : rect.left;
      const left = Math.min(Math.max(8, anchorLeft), window.innerWidth - POPOVER_WIDTH - 8);
      const below = rect.bottom + 6;
      const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
      setPopoverPos({ left, top });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [editing, isBlock, preview]);

  useEffect(() => {
    if (!editing) return;
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, [editing]);

  // Clicking anywhere outside the popover (including back in the doc) commits, like Docs' own
  // equation editor - losing a typed formula to a stray click would be worse than keeping it.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as globalThis.Node;
      if (popoverRef.current?.contains(target) || wrapperRef.current?.contains(target)) return;
      commit();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [editing, commit]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation(); // keep Docs' own shortcuts (Ctrl+F, Ctrl+K, ...) out of the source box
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && (!e.shiftKey || e.ctrlKey || e.metaKey)) {
      // Shift+Enter is a newline - long display equations (aligned, cases) are easier to edit
      // over several lines.
      e.preventDefault();
      commit();
    }
  };

  const body = rendered ? (
    <span className="doc-math-render" dangerouslySetInnerHTML={{ __html: rendered.html }} />
  ) : (
    <span className="doc-math-empty">{isBlock ? "Empty equation" : "Equation"}</span>
  );

  const popover =
    editing &&
    createPortal(
      <div
        ref={popoverRef}
        style={{ left: popoverPos?.left ?? -9999, top: popoverPos?.top ?? -9999, width: POPOVER_WIDTH }}
        className="fixed z-[60] rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg p-2.5 print:hidden"
        // React bubbles portal events through the component tree, not the DOM - without this a
        // click in the popover would reach the equation's own onClick below.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{isBlock ? "Display equation" : "Inline equation"} · LaTeX</span>
          <button type="button" onClick={() => openLink("https://katex.org/docs/supported.html")} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
            Supported commands
          </button>
        </div>
        <textarea
          ref={textareaRef}
          rows={isBlock ? 3 : 2}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isBlock ? "E = mc^2" : "x^2"}
          className="w-full px-2.5 py-1.5 font-mono text-[13px] leading-relaxed rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100 resize-y"
        />
        <div className="mt-2 min-h-[44px] max-h-48 overflow-auto rounded-md bg-neutral-50 dark:bg-neutral-900/60 px-3 py-2 flex items-center justify-center text-neutral-900 dark:text-neutral-100">
          {preview ? (
            <span dangerouslySetInnerHTML={{ __html: preview.html }} />
          ) : (
            <span className="text-xs text-neutral-400">Preview</span>
          )}
        </div>
        {preview?.error && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400 break-words">{preview.error}</p>}
        <div className="flex items-center gap-1.5 mt-2">
          {isBlock && (
            <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300 select-none cursor-pointer">
              <input type="checkbox" checked={draftNumbered} onChange={(e) => setDraftNumbered(e.target.checked)} className="accent-blue-600" />
              Number this equation
            </label>
          )}
          <div className="flex-1" />
          <button type="button" onClick={cancel} className="px-3 py-1 text-sm rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
            Cancel
          </button>
          <button type="button" onClick={commit} className="px-3 py-1 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700">
            Done
          </button>
        </div>
      </div>,
      document.body
    );

  const stateClass = `${selected || editing ? "doc-math-selected" : ""} ${rendered?.error ? "doc-math-error" : ""}`;

  if (isBlock) {
    return (
      <NodeViewWrapper
        ref={wrapperRef}
        as="div"
        className={`doc-math-block ${stateClass}`}
        data-numbered={numbered ? "true" : "false"}
        contentEditable={false}
      >
        {body}
        {numbered && equationNumber(decorations) !== null && <span className="doc-math-number">({equationNumber(decorations)})</span>}
        {popover}
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper ref={wrapperRef} as="span" className={`doc-math-inline ${stateClass}`} contentEditable={false}>
      {body}
      {popover}
    </NodeViewWrapper>
  );
};

export default DocMathView;
