// utils/docTextOverrides.ts
//
// Direct formatting that switches a style's weight or slant off: text in a heading (bold by its
// style) or in an imported paper's italic caption can be made regular, the way Word lets you
// un-bold part of a heading. Stored on the textStyle mark next to font, size and colour:
//   fontWeight: "normal" - not bold, whatever the block's style says
//   fontStyle:  "normal" - not italic
// The toolbar's Bold and Italic buttons use these when the bold or italic comes from the style
// rather than from a bold/italic mark (DocToolbar.tsx).
import { Extension } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docTextOverrides: {
      // Bold on/off for the selection, whether the bold comes from a mark or from the block style.
      toggleRenderedBold: (renderedBold: boolean, styleBold: boolean) => ReturnType;
      toggleRenderedItalic: (renderedItalic: boolean, styleItalic: boolean) => ReturnType;
    };
  }
}

const DocTextOverrides = Extension.create({
  name: "docTextOverrides",

  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontWeight: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.style.fontWeight === "normal" || el.style.fontWeight === "400" ? "normal" : null),
            renderHTML: (attrs: Record<string, unknown>) => (attrs.fontWeight === "normal" ? { style: "font-weight: normal" } : {}),
          },
          fontStyle: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.style.fontStyle === "normal" ? "normal" : null),
            renderHTML: (attrs: Record<string, unknown>) => (attrs.fontStyle === "normal" ? { style: "font-style: normal" } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    // renderedX: the text at the cursor is drawn bold/italic now; styleX: its block's style alone
    // makes it so (a heading, a typeset caption) - then only an override can switch it off.
    const toggle =
      (mark: "bold" | "italic", attr: "fontWeight" | "fontStyle") =>
      (rendered: boolean, fromStyle: boolean) =>
      ({ editor, chain }: { editor: import("@tiptap/core").Editor; chain: () => import("@tiptap/core").ChainedCommands }) => {
        const hasMark = editor.isActive(mark);
        const overridden = editor.getAttributes("textStyle")[attr] === "normal";
        if (rendered) {
          // Switch off: drop the mark, and override the style if it would still apply.
          let c = chain();
          if (hasMark) c = c.unsetMark(mark);
          if (fromStyle) c = c.setMark("textStyle", { [attr]: "normal" });
          return c.run();
        }
        // Switch on: lift an override if that's what is keeping it off, otherwise add the mark.
        if (overridden) return chain().setMark("textStyle", { [attr]: null }).removeEmptyTextStyle().run();
        return chain().setMark(mark).run();
      };
    return {
      toggleRenderedBold: (rendered, fromStyle) => toggle("bold", "fontWeight")(rendered, fromStyle),
      toggleRenderedItalic: (rendered, fromStyle) => toggle("italic", "fontStyle")(rendered, fromStyle),
    };
  },
});

export default DocTextOverrides;
