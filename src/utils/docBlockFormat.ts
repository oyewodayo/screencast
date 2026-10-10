// utils/docBlockFormat.ts
//
// Block-level typesetting attributes beyond alignment, indents and line spacing:
//   span         - "all": the block spans every text column of a two-column page (title, author
//                  list, abstract, a wide table or equation), as LaTeX's figure*/\twocolumn[...]
//   spaceBefore  - pt above the block, replacing the document's block spacing
//   spaceAfter   - pt below it
//   noIndent     - suppresses the body style's first-line indent (LaTeX's \noindent; also every
//                  paragraph right after a heading, as LaTeX does by default)
// and on tables:
//   rules        - "booktabs" (top/bottom rules, one under the header) or "doubled" (the double
//                  rules of APS/RevTeX tables); null keeps the editor's full grid
//   fit          - true sizes the table to its content and centres it, as a typeset table is,
//                  instead of stretching it over the text width
//
// Several of these nodes render through React node views (equations, captions, the reference
// list), where renderHTML attributes never reach the DOM - so the live editor applies everything
// with node decorations, which do reach a node view's outer element. renderHTML still emits the
// same values, for copy/paste and HTML export.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docBlockFormat: {
      // Spans the top-level block at the cursor across both columns, or returns it to one.
      toggleSpanColumns: () => ReturnType;
      // The rule style of the table at the cursor: null = the editor's full grid.
      setTableRules: (rules: TableRules | null) => ReturnType;
      // Sizes the table at the cursor to its content and centres it, or back to full width.
      toggleTableFit: () => ReturnType;
      // LaTeX's \noindent for the paragraphs in the selection (typeset documents indent paragraphs).
      toggleNoIndent: () => ReturnType;
    };
  }
}

// The top-level block holding the selection (a selected equation or image paragraph included).
export function topBlockAt(state: EditorState): { node: PMNode; pos: number } | null {
  const { $from } = state.selection;
  if ($from.depth === 0) {
    const node = state.doc.nodeAt($from.pos);
    return node ? { node, pos: $from.pos } : null;
  }
  const pos = $from.before(1);
  return { node: state.doc.nodeAt(pos)!, pos };
}

function tableAt(state: EditorState): { node: PMNode; pos: number } | null {
  const top = topBlockAt(state);
  return top && top.node.type.name === "table" ? top : null;
}

export const BLOCK_FORMAT_TYPES = [
  "paragraph",
  "heading",
  "caption",
  "mathBlock",
  "bibliography",
  "tableOfContents",
  "blockquote",
  "bulletList",
  "orderedList",
  "codeBlock",
  "table",
  "horizontalRule",
];

// "leaders": a contents list (label | text | page) with dot leaders and no rules.
export type TableRules = "booktabs" | "doubled" | "leaders";

const ptAttr = (name: "spaceBefore" | "spaceAfter", css: string) => ({
  default: null,
  parseHTML: (el: HTMLElement) => {
    const v = el.getAttribute(`data-${name === "spaceBefore" ? "space-before" : "space-after"}`);
    return v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
  },
  renderHTML: (attrs: Record<string, unknown>) =>
    typeof attrs[name] === "number"
      ? { [`data-${name === "spaceBefore" ? "space-before" : "space-after"}`]: String(attrs[name]), style: `${css}: ${attrs[name]}pt` }
      : {},
});

function decorationAttrs(node: PMNode): Record<string, string> | null {
  const a = node.attrs as Record<string, unknown>;
  const out: Record<string, string> = {};
  const style: string[] = [];
  if (a.span === "all") out["data-span"] = "all";
  if (typeof a.spaceBefore === "number") style.push(`margin-top: ${a.spaceBefore}pt !important`);
  if (typeof a.spaceAfter === "number") style.push(`margin-bottom: ${a.spaceAfter}pt !important`);
  if (a.noIndent === true) out["data-no-indent"] = "";
  if (node.type.name === "table") {
    if (a.rules === "booktabs" || a.rules === "doubled" || a.rules === "leaders") out["data-rules"] = a.rules;
    if (a.fit === true) out["data-fit"] = "";
  }
  if (style.length) out.style = style.join("; ");
  return Object.keys(out).length ? out : null;
}

const key = new PluginKey<DecorationSet>("docBlockFormat");

function build(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  // Top-level blocks only: columns, spacing and indents are properties of the page flow. (Table
  // cells hold paragraphs too, which never span columns.)
  doc.forEach((node, offset) => {
    const attrs = decorationAttrs(node);
    if (attrs) decos.push(Decoration.node(offset, offset + node.nodeSize, attrs));
  });
  return DecorationSet.create(doc, decos);
}

const DocBlockFormat = Extension.create({
  name: "docBlockFormat",

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_FORMAT_TYPES,
        attributes: {
          span: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.getAttribute("data-span") === "all" ? "all" : null),
            renderHTML: (attrs: Record<string, unknown>) => (attrs.span === "all" ? { "data-span": "all" } : {}),
          },
          spaceBefore: ptAttr("spaceBefore", "margin-top"),
          spaceAfter: ptAttr("spaceAfter", "margin-bottom"),
        },
      },
      {
        types: ["paragraph"],
        attributes: {
          noIndent: {
            default: false,
            parseHTML: (el: HTMLElement) => el.hasAttribute("data-no-indent"),
            renderHTML: (attrs: Record<string, unknown>) => (attrs.noIndent ? { "data-no-indent": "" } : {}),
          },
        },
      },
      {
        types: ["table"],
        attributes: {
          rules: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = el.getAttribute("data-rules");
              return v === "booktabs" || v === "doubled" || v === "leaders" ? v : null;
            },
            renderHTML: (attrs: Record<string, unknown>) => (attrs.rules ? { "data-rules": String(attrs.rules) } : {}),
          },
          fit: {
            default: false,
            parseHTML: (el: HTMLElement) => el.hasAttribute("data-fit"),
            renderHTML: (attrs: Record<string, unknown>) => (attrs.fit ? { "data-fit": "" } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      toggleSpanColumns:
        () =>
        ({ state, tr, dispatch }) => {
          const top = topBlockAt(state);
          if (!top || !BLOCK_FORMAT_TYPES.includes(top.node.type.name)) return false;
          if (dispatch) tr.setNodeMarkup(top.pos, undefined, { ...top.node.attrs, span: top.node.attrs.span === "all" ? null : "all" });
          return true;
        },
      setTableRules:
        (rules) =>
        ({ state, tr, dispatch }) => {
          const t = tableAt(state);
          if (!t) return false;
          if (dispatch) tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, rules });
          return true;
        },
      toggleNoIndent:
        () =>
        ({ state, tr, dispatch }) => {
          const { from, to } = state.selection;
          const paragraphs: { pos: number; node: PMNode }[] = [];
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name === "paragraph") paragraphs.push({ pos, node });
          });
          if (paragraphs.length === 0) return false;
          const value = !paragraphs.every((p) => p.node.attrs.noIndent);
          if (dispatch) for (const p of paragraphs) tr.setNodeMarkup(p.pos, undefined, { ...p.node.attrs, noIndent: value });
          return true;
        },
      toggleTableFit:
        () =>
        ({ state, tr, dispatch }) => {
          const t = tableAt(state);
          if (!t) return false;
          if (dispatch) tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, fit: !t.node.attrs.fit });
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, prev) => (tr.docChanged ? build(tr.doc) : prev),
        },
        props: {
          decorations: (state) => key.getState(state),
        },
      }),
    ];
  },
});

export default DocBlockFormat;
