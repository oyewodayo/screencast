// utils/docStructureNodes.ts
//
// The schema side of docStructure.ts: figure/table captions, cross-references, citations, the
// reference list and the table of contents. Every number these show is computed by the structure
// plugin and delivered as a node decoration - the nodes themselves store only what can't be
// derived (a caption's kind and stable id, a cross-reference's target id, a citation's reference
// ids and locator), so nothing goes stale when the document is reordered.
import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { Decoration } from "@tiptap/pm/view";
import { ReactNodeViewRenderer } from "@tiptap/react";
import DocBibliographyView from "../components/docs/DocBibliographyView";
import DocTocView from "../components/docs/DocTocView";
import { crossRefText, getDocStructure, type CaptionKind } from "./docStructure";
import { citationSpaceBefore } from "./docCitationStyles";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docStructure: {
      insertCaption: (kind: CaptionKind) => ReturnType;
      insertCrossRef: (targetId: string, form?: "label" | "number") => ReturnType;
      insertCitation: (refIds: string[], locator?: string | null) => ReturnType;
      updateCitationAt: (pos: number, refIds: string[], locator?: string | null) => ReturnType;
      updateCrossRefAt: (pos: number, targetId: string, form?: "label" | "number") => ReturnType;
      insertBibliography: () => ReturnType;
      insertTableOfContents: () => ReturnType;
    };
  }
}

// Events the inline label nodes raise on the editor DOM when clicked - DocsEditor.tsx opens the
// matching editor (citation picker, cross-reference popover) anchored to the node.
export const CITATION_EDIT_EVENT = "doc-citation-edit";
export const CROSSREF_EDIT_EVENT = "doc-crossref-edit";

// Opens the insert-mode citation or cross-reference picker at a screen rect (slash menu, toolbar).
export const OPEN_PICKER_EVENT = "doc-open-picker";

export interface OpenPickerDetail {
  kind: "cite" | "xref";
  rect: DOMRect;
}

export interface InlineEditDetail {
  pos: number;
  rect: DOMRect;
}

// Blocks go where the cursor is: replacing the current line when it's empty, otherwise after the
// block the cursor is in. Returns the position the first inserted node landed at.
function insertBlocksAtCursor(tr: Transaction, nodes: PmNode[]): number | null {
  const { $from } = tr.selection;
  if ($from.depth === 0) {
    tr.insert($from.pos, nodes);
    return $from.pos;
  }
  const parent = $from.node(-1);
  const isEmpty = $from.parent.isTextblock && $from.parent.content.size === 0;
  try {
    if (isEmpty && parent.canReplace($from.index(-1), $from.indexAfter(-1), Fragment.from(nodes))) {
      const pos = $from.before();
      tr.replaceWith(pos, $from.after(), nodes);
      return pos;
    }
  } catch {
    // fall through to inserting after the block
  }
  const pos = $from.after();
  try {
    tr.insert(pos, nodes);
    return pos;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------------------------
// Caption

export const Caption = Node.create({
  name: "caption",
  group: "block",
  content: "inline*",
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: "figure",
        parseHTML: (el: HTMLElement) => (el.getAttribute("data-caption") === "table" || el.tagName === "CAPTION" ? "table" : "figure"),
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-caption": attrs.kind as string }),
      },
      id: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-caption-id"),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.id ? { "data-caption-id": attrs.id as string } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "p[data-caption]" }, { tag: "figcaption" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["p", mergeAttributes(HTMLAttributes, { class: "doc-caption" }), 0];
  },

  addCommands() {
    return {
      // A figure caption goes under the image the selection is on (or the line the cursor is
      // in); a table caption goes above the table the cursor is in - the usual conventions. If
      // that spot already has a caption of the same kind, the cursor just moves into it.
      insertCaption:
        (kind) =>
        ({ tr, state, dispatch }) => {
          const { selection } = tr;
          const $pos = selection.$from;
          const make = () => state.schema.nodes.caption.create({ kind, id: crypto.randomUUID() });
          let insertAt: number | null = null;
          let existing: number | null = null;

          if (kind === "table") {
            for (let d = $pos.depth; d > 0; d--) {
              if ($pos.node(d).type.name === "table") {
                const tablePos = $pos.before(d);
                const $table = state.doc.resolve(tablePos);
                const before = $table.nodeBefore;
                if (before?.type.name === "caption" && before.attrs.kind === "table") existing = tablePos - before.nodeSize;
                else insertAt = tablePos;
                break;
              }
            }
          } else {
            // The textblock holding the image (inline images live inside paragraphs).
            const node = selection instanceof NodeSelection ? selection.node : null;
            if ($pos.depth > 0) {
              const after = $pos.after();
              const next = state.doc.resolve(after).nodeAfter;
              if (next?.type.name === "caption" && next.attrs.kind === "figure" && node?.type.name === "image") existing = after;
              else if (node?.type.name === "image" || $pos.parent.content.size > 0) insertAt = after;
            }
          }

          if (existing !== null) {
            if (dispatch) tr.setSelection(TextSelection.create(tr.doc, existing + 1 + state.doc.nodeAt(existing)!.content.size)).scrollIntoView();
            return true;
          }
          let pos: number | null;
          if (insertAt !== null) {
            try {
              tr.insert(insertAt, make());
              pos = insertAt;
            } catch {
              pos = null;
            }
          } else {
            pos = insertBlocksAtCursor(tr, [make()]);
          }
          if (pos === null) return false;
          if (dispatch) tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView();
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      // Enter at the end of a caption continues with ordinary text, never a second caption.
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== "caption" || $from.parentOffset !== $from.parent.content.size) return false;
        const after = $from.after();
        return editor
          .chain()
          .insertContentAt(after, { type: "paragraph" })
          .command(({ tr }) => {
            tr.setSelection(TextSelection.create(tr.doc, after + 1));
            return true;
          })
          .run();
      },
    };
  },
});

// ----------------------------------------------------------------------------------------------
// Inline label nodes: cross-reference and citation

type LabelKind = "xref" | "cite";

function labelFrom(kind: LabelKind, decorations: readonly Decoration[]) {
  for (const d of decorations) {
    const spec = d.spec as { label?: string; missing?: boolean; cite?: { text: string; superscript: boolean; missing: boolean }; space?: string; kind?: string };
    if (kind === "cite" && spec.cite) return { text: spec.cite.text, space: spec.space ?? "", missing: spec.cite.missing, superscript: spec.cite.superscript, targetKind: undefined };
    if (kind === "xref" && spec.label !== undefined) return { text: spec.label, space: "", missing: !!spec.missing, superscript: false, targetKind: spec.kind };
  }
  return { text: kind === "cite" ? "[?]" : "??", space: "", missing: true, superscript: false, targetKind: undefined };
}

// A plain (non-React) NodeView: these sit inline in running text, often dozens per page, and only
// ever show a short label - a React root each would be wasted weight.
function labelNodeView(kind: LabelKind) {
  return ({ node, decorations }: { node: PmNode; decorations: readonly Decoration[] }) => {
    // The space before a bracketed citation sits outside the tinted label, so the highlight hugs
    // the citation itself.
    const dom = document.createElement("span");
    dom.contentEditable = "false";
    dom.className = "doc-label-wrap";
    const spaceEl = dom.appendChild(document.createElement("span"));
    const labelEl = dom.appendChild(document.createElement("span"));
    labelEl.className = kind === "cite" ? "doc-cite" : "doc-xref";
    const render = (decos: readonly Decoration[]) => {
      const label = labelFrom(kind, decos);
      spaceEl.textContent = label.space;
      labelEl.textContent = label.text;
      labelEl.classList.toggle("doc-label-missing", label.missing);
      labelEl.classList.toggle("doc-cite-sup", label.superscript);
      labelEl.title = label.missing
        ? kind === "cite"
          ? "Reference missing from this document’s library"
          : "The figure, table or equation this pointed to was deleted"
        : kind === "cite"
          ? "Citation · click to edit"
          : `Cross-reference to ${label.text} · click for options`;
    };
    render(decorations);
    return {
      dom,
      update: (updated: PmNode, decos: readonly Decoration[]) => {
        if (updated.type !== node.type) return false;
        render(decos);
        return true;
      },
      ignoreMutation: () => true,
    };
  };
}

// Click opens the node's editor; detected through ProseMirror's own click handling (see
// docMathExtension.ts for why not a DOM click listener).
function clickToEditPlugin(typeName: string, eventName: string): Plugin {
  return new Plugin({
    props: {
      handleClickOn: (view, _pos, node, nodePos, _event, direct) => {
        if (!direct || node.type.name !== typeName || !view.editable) return false;
        const dom = view.nodeDOM(nodePos);
        if (!(dom instanceof HTMLElement)) return false;
        view.dom.dispatchEvent(new CustomEvent<InlineEditDetail>(eventName, { detail: { pos: nodePos, rect: dom.getBoundingClientRect() } }));
        return false;
      },
    },
  });
}

function editorLabel(editor: Editor | undefined, pos: number | undefined, kind: LabelKind): string | null {
  if (!editor || pos === undefined) return null;
  const s = getDocStructure(editor.state);
  if (!s) return null;
  if (kind === "cite") return s.citationAt.get(pos)?.text ?? null;
  const node = editor.state.doc.nodeAt(pos);
  const target = s.targets.get(String(node?.attrs.targetId ?? ""));
  return target ? crossRefText(target, node?.attrs.form) : null;
}

export const CrossRef = Node.create({
  name: "crossRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      targetId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-xref"),
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-xref": (attrs.targetId as string) ?? "" }),
      },
      // "label" reads "Fig. 3"; "number" just "3" (or "(2)" for an equation), for "Figs. 2 and 3".
      form: {
        default: "label",
        parseHTML: (el: HTMLElement) => (el.getAttribute("data-xref-form") === "number" ? "number" : "label"),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.form === "number" ? { "data-xref-form": "number" } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-xref]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "doc-xref" })];
  },
  renderText({ node, pos }) {
    return editorLabel(this.editor, pos, "xref") ?? (node.attrs.targetId ? "??" : "");
  },
  addNodeView() {
    return labelNodeView("xref") as never;
  },
  addCommands() {
    return {
      insertCrossRef:
        (targetId, form = "label") =>
        ({ tr, state, dispatch }) => {
          if (dispatch) tr.replaceSelectionWith(state.schema.nodes.crossRef.create({ targetId, form }), false).scrollIntoView();
          return true;
        },
      updateCrossRefAt:
        (pos, targetId, form) =>
        ({ tr, state }) => {
          const node = state.doc.nodeAt(pos);
          if (node?.type.name !== "crossRef") return false;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, targetId, ...(form ? { form } : {}) });
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    return [clickToEditPlugin(this.name, CROSSREF_EDIT_EVENT)];
  },
});

export const Citation = Node.create({
  name: "citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      refIds: {
        default: [],
        parseHTML: (el: HTMLElement) => (el.getAttribute("data-cite") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-cite": ((attrs.refIds as string[]) ?? []).join(",") }),
      },
      locator: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-locator"),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.locator ? { "data-locator": attrs.locator as string } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-cite]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "doc-cite" })];
  },
  renderText({ pos, parent, index }) {
    const label = editorLabel(this.editor, pos, "cite") ?? "[?]";
    const s = this.editor ? getDocStructure(this.editor.state) : null;
    const before = parent && index > 0 ? parent.child(index - 1) : null;
    const previousChar = before ? (before.isText ? (before.text ?? "").slice(-1) : "x") : "";
    return citationSpaceBefore(previousChar, !!s?.citationAt.get(pos)?.superscript) + label;
  },
  addNodeView() {
    return labelNodeView("cite") as never;
  },
  addCommands() {
    return {
      insertCitation:
        (refIds, locator = null) =>
        ({ tr, state, dispatch }) => {
          if (refIds.length === 0) return false;
          if (dispatch) {
            tr.replaceSelectionWith(state.schema.nodes.citation.create({ refIds, locator: locator || null }), false).scrollIntoView();
          }
          return true;
        },
      updateCitationAt:
        (pos, refIds, locator = null) =>
        ({ tr, state }) => {
          const node = state.doc.nodeAt(pos);
          if (node?.type.name !== "citation") return false;
          if (refIds.length === 0) tr.delete(pos, pos + node.nodeSize);
          else tr.setNodeMarkup(pos, undefined, { ...node.attrs, refIds, locator: locator || null });
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    return [clickToEditPlugin(this.name, CITATION_EDIT_EVENT)];
  },
});

// ----------------------------------------------------------------------------------------------
// Generated blocks: reference list and table of contents

export const Bibliography = Node.create({
  name: "bibliography",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [{ tag: "div[data-bibliography]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-bibliography": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DocBibliographyView);
  },
  addCommands() {
    return {
      // A "References" heading and the list under it, the way every paper ends.
      insertBibliography:
        () =>
        ({ tr, state, dispatch }) => {
          const { schema } = state;
          const nodes = [schema.nodes.heading.create({ level: 2 }, schema.text("References")), schema.nodes.bibliography.create()];
          const pos = insertBlocksAtCursor(tr, nodes);
          if (pos === null) return false;
          if (dispatch) tr.setSelection(NodeSelection.create(tr.doc, pos + nodes[0].nodeSize)).scrollIntoView();
          return true;
        },
    };
  },
});

export const TableOfContents = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      // Deepest heading level listed (H1-H3 by default, like Word's own default TOC).
      maxLevel: {
        default: 3,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-max-level")) || 3,
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-max-level": String(attrs.maxLevel ?? 3) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-toc]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-toc": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DocTocView);
  },
  addCommands() {
    return {
      insertTableOfContents:
        () =>
        ({ tr, state, dispatch }) => {
          const node = state.schema.nodes.tableOfContents.create();
          const pos = insertBlocksAtCursor(tr, [node]);
          if (pos === null) return false;
          if (dispatch) tr.setSelection(NodeSelection.create(tr.doc, pos)).scrollIntoView();
          return true;
        },
    };
  },
});
