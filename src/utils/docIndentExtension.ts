// utils/docIndentExtension.ts
//
// Paragraph indent (Word/Docs' "Increase/Decrease Indent" buttons) - same addGlobalAttributes
// pattern as docLineSpacingExtension.ts, an integer level (0-8) on paragraph/heading rendered as
// margin-left. No official Tiptap indent extension exists for v2 either.
import { Extension } from "@tiptap/core";

export interface IndentOptions {
  types: string[];
  minLevel: number;
  maxLevel: number;
  emPerLevel: number;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType;
      outdent: () => ReturnType;
    };
  }
}

const DocIndent = Extension.create<IndentOptions>({
  name: "indent",
  addOptions() {
    return {
      types: ["paragraph", "heading"],
      minLevel: 0,
      maxLevel: 8,
      emPerLevel: 2,
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
              const value = parseFloat(element.style.marginLeft || "0");
              return value > 0 ? Math.round(value / this.options.emPerLevel) : 0;
            },
            renderHTML: (attributes) => {
              const level = attributes.indentLevel as number;
              if (!level) return {};
              return { style: `margin-left: ${level * this.options.emPerLevel}em` };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    // Returns a Command (the `(props) => boolean` ProseMirror commands actually run), not a plain
    // `() => boolean` - addCommands()'s own properties are factories that produce a Command, one
    // extra call layer up from what actually executes.
    const step = (delta: number) => () => () => {
      const { types, minLevel, maxLevel } = this.options;
      let applied = false;
      for (const type of types) {
        // Only the block the selection is actually in has its own indentLevel read here -
        // updateAttributes below applies to whichever node(s) the selection spans, same as any
        // other node-attribute command in this editor (e.g. setTextAlign).
        const currentLevel = (this.editor.getAttributes(type).indentLevel as number | undefined) ?? 0;
        const nextLevel = Math.min(maxLevel, Math.max(minLevel, currentLevel + delta));
        if (nextLevel === currentLevel) continue;
        applied = this.editor.commands.updateAttributes(type, { indentLevel: nextLevel }) || applied;
      }
      return applied;
    };
    return {
      indent: step(1),
      outdent: step(-1),
    };
  },
});

export default DocIndent;
