// utils/docLineSpacingExtension.ts
//
// No official Tiptap v2 line-spacing package exists, same situation docFontSizeExtension.ts's own
// header comment describes for font size - this mirrors @tiptap/extension-text-align's own source
// (node_modules/@tiptap/extension-text-align/dist/index.js) exactly, just targeting `paragraph`/
// `heading`'s own attributes directly instead of a mark: line spacing is a block-level property
// (Word/Docs apply it per-paragraph, not per character), so it belongs on the node itself the way
// textAlign already is, not folded into textStyle alongside fontSize/color the way a per-character
// property would be.
import { Extension } from "@tiptap/core";

export interface LineSpacingOptions {
  types: string[];
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    lineSpacing: {
      setLineSpacing: (value: number) => ReturnType;
      unsetLineSpacing: () => ReturnType;
    };
  }
}

const LineSpacing = Extension.create<LineSpacingOptions>({
  name: "lineSpacing",
  addOptions() {
    return {
      types: ["paragraph", "heading"],
    };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          lineSpacing: {
            default: null,
            parseHTML: (element) => {
              const value = element.style.lineHeight;
              return value ? parseFloat(value) : null;
            },
            renderHTML: (attributes) => {
              if (!attributes.lineSpacing) return {};
              return { style: `line-height: ${attributes.lineSpacing}` };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setLineSpacing:
        (value: number) =>
        ({ commands }) => {
          return this.options.types.map((type) => commands.updateAttributes(type, { lineSpacing: value })).every(Boolean);
        },
      unsetLineSpacing:
        () =>
        ({ commands }) => {
          return this.options.types.map((type) => commands.resetAttributes(type, "lineSpacing")).every(Boolean);
        },
    };
  },
});

export default LineSpacing;
