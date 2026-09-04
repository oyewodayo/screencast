// utils/docPageBreakExtension.ts
//
// A manual page break (Word's Ctrl+Enter) - an atomic block node rendered in the live editor as a
// dashed "Page break" label, and as `break-after: page` under @media print so Chromium's print
// engine actually starts a new page there. Schema-contributing, so it lives in
// getDocContentExtensions() alongside the other node/mark types.
import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: {
      setPageBreak: () => ReturnType;
    };
  }
}

const DocPageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: "div[data-page-break]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-page-break": "" })];
  },
  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ chain }) => {
          return chain().insertContent({ type: this.name }).run();
        },
    };
  },
});

export default DocPageBreak;
