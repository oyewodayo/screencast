// utils/docCommentMark.ts
//
// The `comment` mark anchoring a DocComment (docTypes.ts) to a range of text - schema-contributing
// (a real mark type, parsed/serialized like any other), so it lives in getDocContentExtensions()
// alongside Highlight/Link rather than with the interaction-only extensions (docSlashCommand.tsx
// etc). Deliberately carries only `commentId` - no comment text, author, or resolved state lives on
// the mark itself, all of that is docs.rs's comments.json, looked up by this id. That split is what
// lets a comment's anchor be found again after edits shift ProseMirror positions: walk the current
// doc for a mark with this commentId, rather than trusting a stored from/to that would go stale the
// moment anything upstream of it changed.
import { Mark, mergeAttributes } from "@tiptap/core";

export interface CommentMarkOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    comment: {
      setComment: (commentId: string) => ReturnType;
      unsetComment: (commentId: string) => ReturnType;
    };
  }
}

const CommentMark = Mark.create<CommentMarkOptions>({
  name: "comment",
  addOptions() {
    return { HTMLAttributes: {} };
  },
  // Multiple comments can't overlap on the exact same run of text in this v1 (excludeSame default
  // behavior isn't enough on its own to prevent that, but nothing in the UI ever offers a second
  // "Add comment" on already-marked text anyway - see DocCommentsSidebar.tsx/toolbar wiring).
  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-comment-id"),
        renderHTML: (attributes) => {
          if (!attributes.commentId) return {};
          return { "data-comment-id": attributes.commentId };
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
  addCommands() {
    return {
      setComment:
        (commentId: string) =>
        ({ chain }) => {
          return chain().setMark(this.name, { commentId }).run();
        },
      // Removing a comment's mark isn't a plain unsetMark (that would strip every comment mark in
      // the selection, not just this one) - walks the doc for the range(s) actually carrying this
      // commentId and clears only those.
      unsetComment:
        (commentId: string) =>
        ({ tr, dispatch }) => {
          let found = false;
          tr.doc.descendants((node, pos) => {
            const mark = node.marks.find((m) => m.type.name === "comment" && m.attrs.commentId === commentId);
            if (mark) {
              found = true;
              if (dispatch) tr.removeMark(pos, pos + node.nodeSize, mark.type);
            }
          });
          if (found && dispatch) dispatch(tr);
          return found;
        },
    };
  },
});

export default CommentMark;
