// utils/docIndentExtension.ts
//
// Paragraph indents on paragraph/heading - same addGlobalAttributes pattern as
// docLineSpacingExtension.ts. No official Tiptap indent extension exists for v2.
//
// Three precise values in inches, the ones the ruler (DocRuler.tsx) drags, matching Word/Docs:
//   indentLeft   - margin-left of the whole paragraph
//   indentRight  - margin-right
//   indentFirst  - text-indent of the first line, relative to indentLeft (negative = hanging)
// The older `indentLevel` (an integer rendered as 2em steps) is still read so existing documents
// look the same; any precise edit replaces it with indentLeft.
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

export interface IndentOptions {
  types: string[];
  // Increase/Decrease indent step, as in Google Docs.
  stepIn: number;
  maxLeftIn: number;
}

export interface ParagraphIndentPatch {
  left?: number | null;
  right?: number | null;
  first?: number | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType;
      outdent: () => ReturnType;
      setParagraphIndent: (patch: ParagraphIndentPatch) => ReturnType;
    };
  }
}

const LEGACY_EM_PER_LEVEL = 2;
// What a legacy level is worth when converted to inches (2em of ~10.5pt body text ≈ 0.29in).
const LEGACY_IN_PER_LEVEL = 0.29;

// CSS length -> inches; null for relative units (em/%) that have no fixed size.
export function cssLengthToIn(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = value.trim().match(/^(-?[\d.]+)(in|px|pt|cm|mm)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const perIn = { in: 1, px: 96, pt: 72, cm: 2.54, mm: 25.4 }[(m[2] ?? "px") as "in"];
  return n / perIn;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// The paragraph's left indent in inches, whichever attribute it currently comes from.
export function effectiveLeftIn(node: PMNode): number {
  const left = node.attrs.indentLeft as number | null | undefined;
  if (typeof left === "number") return left;
  return ((node.attrs.indentLevel as number | undefined) ?? 0) * LEGACY_IN_PER_LEVEL;
}

const DocIndent = Extension.create<IndentOptions>({
  name: "indent",
  addOptions() {
    return {
      types: ["paragraph", "heading"],
      stepIn: 0.5,
      maxLeftIn: 6,
    };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          indentLevel: {
            default: 0,
            parseHTML: (element) => {
              if (!/em$/.test(element.style.marginLeft)) return 0;
              const value = parseFloat(element.style.marginLeft || "0");
              return value > 0 ? Math.round(value / LEGACY_EM_PER_LEVEL) : 0;
            },
            renderHTML: (attributes) => {
              const level = attributes.indentLevel as number;
              if (!level || typeof attributes.indentLeft === "number") return {};
              return { style: `margin-left: ${level * LEGACY_EM_PER_LEVEL}em` };
            },
          },
          indentLeft: {
            default: null,
            parseHTML: (element) => cssLengthToIn(element.style.marginLeft),
            renderHTML: (attributes) =>
              typeof attributes.indentLeft === "number" && attributes.indentLeft !== 0 ? { style: `margin-left: ${attributes.indentLeft}in` } : {},
          },
          indentRight: {
            default: null,
            parseHTML: (element) => cssLengthToIn(element.style.marginRight),
            renderHTML: (attributes) =>
              typeof attributes.indentRight === "number" && attributes.indentRight !== 0 ? { style: `margin-right: ${attributes.indentRight}in` } : {},
          },
          indentFirst: {
            default: null,
            parseHTML: (element) => cssLengthToIn(element.style.textIndent),
            renderHTML: (attributes) =>
              typeof attributes.indentFirst === "number" && attributes.indentFirst !== 0 ? { style: `text-indent: ${attributes.indentFirst}in` } : {},
          },
        },
      },
    ];
  },
  // Google Docs' own bindings.
  addKeyboardShortcuts() {
    return {
      "Mod-]": () => this.editor.commands.indent(),
      "Mod-[": () => this.editor.commands.outdent(),
    };
  },
  addCommands() {
    const { types, stepIn, maxLeftIn } = this.options;

    // Every paragraph/heading the selection touches, each updated from its *own* current values -
    // a multi-paragraph selection with mixed indents steps each one rather than flattening them.
    const forEachBlock =
      (update: (node: PMNode) => Record<string, unknown> | null) =>
      ({ tr, state, dispatch }: { tr: Transaction; state: EditorState; dispatch?: unknown }) => {
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!types.includes(node.type.name)) return true;
          const attrs = update(node);
          if (attrs) {
            if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
            changed = true;
          }
          return false;
        });
        return changed;
      };

    // Snaps to the step grid the way Docs does: from 0.3in, Increase goes to 0.5 (not 0.8).
    const step = (dir: 1 | -1) => () =>
      forEachBlock((node) => {
        const current = effectiveLeftIn(node);
        const next = dir > 0 ? Math.floor(current / stepIn + 1e-6) * stepIn + stepIn : Math.ceil(current / stepIn - 1e-6) * stepIn - stepIn;
        const clamped = round2(Math.max(0, Math.min(maxLeftIn, next)));
        if (Math.abs(clamped - current) < 1e-6) return null;
        return { indentLeft: clamped || null, indentLevel: 0 };
      });

    return {
      indent: step(1),
      outdent: step(-1),
      setParagraphIndent: (patch: ParagraphIndentPatch) =>
        forEachBlock(() => {
          const attrs: Record<string, unknown> = {};
          if (patch.left !== undefined) {
            attrs.indentLeft = patch.left === null ? null : round2(Math.max(0, patch.left)) || null;
            attrs.indentLevel = 0;
          }
          if (patch.right !== undefined) attrs.indentRight = patch.right === null ? null : round2(Math.max(0, patch.right)) || null;
          if (patch.first !== undefined) attrs.indentFirst = patch.first === null ? null : round2(patch.first) || null;
          return attrs;
        }),
    };
  },
});

export default DocIndent;
