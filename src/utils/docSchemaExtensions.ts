// utils/docSchemaExtensions.ts
//
// The schema-relevant subset of DocsEditor.tsx's Tiptap extensions - i.e. everything that
// contributes a node or mark type, excluding Collaboration (binds to a Y.Doc, doesn't touch the
// schema), Placeholder (a decoration-only extension), and the doc-image-paste extension (a
// ProseMirror plugin, not a schema contribution). Pulled out into its own file so DocsEditor.tsx's
// live editor and docxImport.ts's headless schema builder (see its own header comment) can never
// silently drift apart - both call this function rather than each keeping their own copy of the
// list, which would otherwise be an easy thing to update in one place and forget in the other.
import type { AnyExtension } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image, { ImageOptions } from "@tiptap/extension-image";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TextAlign from "@tiptap/extension-text-align";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import DocImageView from "../components/docs/DocImageView";
import FontSize from "./docFontSizeExtension";

// Adds width/height (set by DocImageView.tsx's resize handles) and a NodeView with interactive
// resize/crop/drag-reorder UI on top of the plain Image extension. Only affects live-editor
// rendering - getSchema() (docxImport.ts's headless path) never invokes addNodeView(), since that
// only happens inside a live EditorView, so this is safe to share between both contexts.
//
// No custom renderHTML is needed for width/height: since the NodeView fully owns live rendering,
// the node's own renderHTML() is only ever consulted for getHTML()/copy-paste serialization, not
// live display - Tiptap's default per-attribute behavior (an attribute with no renderHTML is
// emitted as a plain HTML attribute) already produces a valid `<img width height>` for that. The
// only real gap is parseHTML: the default reads it back as a string, so it needs an explicit
// parseHTML converting it to a number.
const DocImage = Image.extend<ImageOptions & { docId: string | null }>({
  addOptions() {
    return {
      ...this.parent?.(),
      docId: null as string | null,
    };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute("width");
          return value ? parseInt(value, 10) : null;
        },
      },
      height: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute("height");
          return value ? parseInt(value, 10) : null;
        },
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(DocImageView);
  },
});

// docId is only meaningful for the live editor (DocImageView's crop tool needs it to know which
// doc's assets/ folder to save into) - docxImport.ts's headless schema builder passes none, which
// is harmless since no NodeView ever mounts there.
export function getDocContentExtensions(docId?: string): AnyExtension[] {
  return [
    // Collaboration's own history (Yjs UndoManager) replaces StarterKit's plain history in the
    // live editor - history is irrelevant to a standalone schema, but disabled here too so the
    // node/mark set matches exactly regardless of which context reads this list.
    StarterKit.configure({ history: false }),
    Underline,
    Link.configure({ openOnClick: false, autolink: false }),
    // inline: true - images can sit anywhere within a line of text, not just as their own block
    // between paragraphs. Image.extend()'s own group() ("inline" ? 'inline' : 'block') is
    // inherited unchanged from the parent extension via Tiptap's extension-chain resolution, so
    // this single option flip is all that's needed to change the node's schema group.
    DocImage.configure({ inline: true, docId: docId ?? null }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
  ];
}
