// utils/docMathExtension.ts
//
// LaTeX equations for Docs - two atom nodes rendered with KaTeX (the same library the whiteboard's
// formula tool uses): `mathInline` sits inside a line of text, `mathBlock` is a centred display
// equation that can carry an equation number. The LaTeX source is the node's only state (the
// `latex` attribute); everything visible is derived from it by DocMathView.tsx's NodeView, so the
// Y.Doc, exports and copy/paste all carry plain source text. Schema-contributing, so it lives in
// getDocContentExtensions() alongside the other node types.
//
// Typing shortcuts: `$x^2$` (closing `$` typed last) becomes inline math, and `$$` followed by a
// space at the start of an empty line becomes a display equation, opened for editing.
import { InputRule, Node, mergeAttributes } from "@tiptap/core";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import DocMathView, { MATH_EDIT_EVENT } from "../components/docs/DocMathView";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docMath: {
      insertMathInline: (latex?: string) => ReturnType;
      insertMathBlock: (latex?: string) => ReturnType;
    };
  }
}

// The NodeView isn't mounted yet when an insert command's transaction applies, so opening the
// editor waits a frame for the DOM to exist.
function requestEditAt(view: import("@tiptap/pm/view").EditorView, pos: number): void {
  requestAnimationFrame(() => {
    dispatchEdit(view.nodeDOM(pos));
  });
}

// nodeDOM() is ReactNodeViewRenderer's outer element; DocMathView listens on its NodeViewWrapper
// inside it, and a dispatched event only bubbles up, never down.
function dispatchEdit(dom: globalThis.Node | null): boolean {
  if (!(dom instanceof HTMLElement)) return false;
  const target = dom.matches(".doc-math-block, .doc-math-inline") ? dom : dom.querySelector(".doc-math-block, .doc-math-inline");
  if (!target) return false;
  target.dispatchEvent(new CustomEvent(MATH_EDIT_EVENT));
  return true;
}

const latexAttribute = {
  latex: {
    default: "",
    parseHTML: (element: HTMLElement) => element.getAttribute("data-latex") ?? element.textContent ?? "",
    renderHTML: (attributes: Record<string, unknown>) => ({ "data-latex": attributes.latex as string }),
  },
};

// `$...$` with the closing `$` just typed. The body can't start or end with whitespace and the
// opening `$` can't follow a word character, `\` or another `$`, so prices ("$5 and $10") and
// escaped dollars don't turn into equations.
const INLINE_MATH_INPUT = /(?:^|[^\w\\$])(\$([^$\s](?:[^$]*[^$\s])?)\$)$/;

export const MathInline = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return latexAttribute;
  },
  parseHTML() {
    return [{ tag: "span[data-math-inline]" }];
  },
  // The source as text content too, so the HTML (clipboard, .html export before KaTeX swaps it)
  // never shows an empty gap where an equation was.
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-math-inline": "" }), node.attrs.latex as string];
  },
  renderText({ node }) {
    return `$${node.attrs.latex as string}$`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(DocMathView);
  },
  addCommands() {
    return {
      // With text selected, the selection becomes the equation's source - select "x^2", insert
      // inline equation, done.
      insertMathInline:
        (latex) =>
        ({ tr, state, dispatch, view }) => {
          const { from, to } = tr.selection;
          const source = latex ?? state.doc.textBetween(from, to, " ").trim();
          tr.replaceSelectionWith(this.type.create({ latex: source }), false);
          if (dispatch && !source) requestEditAt(view, from);
          return true;
        },
    };
  },
  addInputRules() {
    return [
      new InputRule({
        find: INLINE_MATH_INPUT,
        handler: ({ state, range, match }) => {
          // range spans match[0], which may begin with the boundary character before the `$`
          // (kept) and ends with the closing `$` still being typed (not in the doc yet).
          const start = range.from + (match[0].length - match[1].length);
          state.tr.replaceWith(start, range.to, this.type.create({ latex: match[2] }));
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => openSelectedMath(this.editor.view, this.name),
    };
  },
  addProseMirrorPlugins() {
    return [clickToEditPlugin(this.name)];
  },
});

export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      ...latexAttribute,
      // Display equations are numbered (1), (2), ... down the page by default, the way papers
      // expect - docMath.css counts them, and the exporters compute the same sequence.
      numbered: {
        default: true,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-numbered") !== "false",
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-numbered": attributes.numbered ? "true" : "false" }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-math-block]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-math-block": "" }), node.attrs.latex as string];
  },
  renderText({ node }) {
    return `$$${node.attrs.latex as string}$$`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(DocMathView);
  },
  addCommands() {
    return {
      // Replaces the current line when it's empty, otherwise goes in after the current block.
      // Works on `tr` alone (no view.state reads) so it composes inside a chain, e.g. the "$$"
      // input rule's deleteRange().insertMathBlock().
      insertMathBlock:
        (latex = "") =>
        ({ tr, dispatch, view }) => {
          const node = this.type.create({ latex });
          const { $from } = tr.selection;
          let pos: number;
          try {
            const parent = $from.depth > 0 ? $from.node(-1) : null;
            if (
              parent &&
              $from.parent.isTextblock &&
              $from.parent.content.size === 0 &&
              parent.canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type)
            ) {
              pos = $from.before();
              tr.replaceWith(pos, $from.after(), node);
            } else {
              pos = $from.depth > 0 ? $from.after() : $from.pos;
              tr.insert(pos, node);
            }
          } catch {
            return false; // no valid place for a block here (e.g. inside a code block)
          }
          tr.setSelection(NodeSelection.create(tr.doc, pos));
          if (dispatch && !latex) requestEditAt(view, pos);
          return true;
        },
    };
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range, chain }) => {
          const $from = state.doc.resolve(range.from);
          // Only a line that holds nothing but the "$$" (the space that triggered this isn't in
          // the doc yet).
          if ($from.parent.type.name !== "paragraph" || $from.parent.textContent !== "$$") return null;
          chain().deleteRange(range).insertMathBlock().run();
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => openSelectedMath(this.editor.view, this.name),
    };
  },
  addProseMirrorPlugins() {
    return [clickToEditPlugin(this.name)];
  },
});

// Clicking an equation opens its editor. Detected through ProseMirror's own click handling (it
// pairs mousedown/mouseup itself) rather than a React onClick: when the editor already has focus,
// ProseMirror's mousedown handling on an atom node leaves the browser without a native `click`.
function clickToEditPlugin(typeName: string): Plugin {
  return new Plugin({
    props: {
      handleClickOn: (view, _pos, node, nodePos, _event, direct) => {
        if (!direct || node.type.name !== typeName || !view.editable) return false;
        dispatchEdit(view.nodeDOM(nodePos));
        return false; // still let ProseMirror select the equation
      },
    },
  });
}

function openSelectedMath(view: import("@tiptap/pm/view").EditorView, typeName: string): boolean {
  const { selection } = view.state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== typeName || !view.editable) return false;
  return dispatchEdit(view.nodeDOM(selection.from));
}
