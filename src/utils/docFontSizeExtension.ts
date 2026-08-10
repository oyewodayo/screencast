// utils/docFontSizeExtension.ts
//
// No official Tiptap v2 font-size package exists - font-size was folded directly into
// @tiptap/extension-text-style's own core starting in Tiptap v3, and this project is pinned to
// v2.27.2 (see package.json). This mirrors @tiptap/extension-font-family's own source exactly
// (node_modules/@tiptap/extension-font-family/dist/index.js) - same addGlobalAttributes shape
// targeting the "textStyle" mark, same setX/unsetX command pattern - just for `fontSize` instead
// of `fontFamily`, so the two extensions behave identically from the editor's point of view.
import { Extension } from "@tiptap/core";

// Stored in points (matching how a user would naturally think of "10pt", "12pt", etc., and how
// docDocx.ts's export walker already expects to read it) - converted to the OOXML half-point
// convention only at the docx-export boundary (docDocx.ts), not here.
export interface FontSizeOptions {
  types: string[];
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (fontSize: number) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

const FontSize = Extension.create<FontSizeOptions>({
  name: "fontSize",
  addOptions() {
    return {
      types: ["textStyle"],
    };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => {
              const value = element.style.fontSize;
              return value ? parseFloat(value) : null;
            },
            renderHTML: (attributes) => {
              if (!attributes.fontSize) return {};
              return { style: `font-size: ${attributes.fontSize}pt` };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (fontSize: number) =>
        ({ chain }) => {
          return chain().setMark("textStyle", { fontSize }).run();
        },
      unsetFontSize:
        () =>
        ({ chain }) => {
          return chain().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run();
        },
    };
  },
});

export default FontSize;
