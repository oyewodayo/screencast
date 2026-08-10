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
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TextAlign from "@tiptap/extension-text-align";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";

export function getDocContentExtensions(): AnyExtension[] {
  return [
    // Collaboration's own history (Yjs UndoManager) replaces StarterKit's plain history in the
    // live editor - history is irrelevant to a standalone schema, but disabled here too so the
    // node/mark set matches exactly regardless of which context reads this list.
    StarterKit.configure({ history: false }),
    Underline,
    Link.configure({ openOnClick: false, autolink: false }),
    Image.configure({ inline: false }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    TextStyle,
    Color,
  ];
}
