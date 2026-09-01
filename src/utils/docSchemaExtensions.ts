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
import Highlight from "@tiptap/extension-highlight";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import DocImageView from "../components/docs/DocImageView";
import FontSize from "./docFontSizeExtension";

// `common` (not `all`) - covers every mainstream language (JS/TS, Python, Rust, Go, JSON, etc.)
// without bundling lowlight's full ~190-grammar set, which this doc editor has no need for.
const lowlight = createLowlight(common);

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
    // codeBlock: false - StarterKit's own plain codeBlock node is replaced by CodeBlockLowlight
    // below (same node name/schema shape, so imported/exported documents are unaffected), which
    // adds per-token syntax highlighting on top.
    StarterKit.configure({ history: false, codeBlock: false }),
    CodeBlockLowlight.configure({ lowlight }),
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
    // multicolor: true - without it, Highlight has no `color` attribute at all (a single fixed
    // highlight color, not a picker) - see @tiptap/extension-highlight's own addAttributes().
    Highlight.configure({ multicolor: true }),
  ];
}

// The Tailwind arbitrary-variant styling for an `EditorContent` rendering this schema - shared by
// DocsEditor.tsx's live editor and DocVersionHistoryPanel.tsx's read-only version preview, so the
// preview genuinely looks like the same document (headings, code blocks, blockquotes, the empty-
// state placeholder) rather than a second, drifting copy of this string.
export const docProseClassName = [
  "prose prose-sm dark:prose-invert prose-neutral max-w-none",
  "[&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[50vh]",
  // Uniform rhythm between every top-level block (paragraph/heading/list/quote/code) instead of
  // Typography's own per-element-type spacing scale, which is what made the gaps between block
  // types look inconsistent.
  "[&_.ProseMirror>*]:my-0 [&_.ProseMirror>*+*]:mt-4",
  // Code blocks: full card width (not sized to content), a real monospace stack, and a small
  // static "Code" label so it reads as a distinct block at a glance. Per-language token colors
  // come from docCodeHighlight.css's .hljs-* rules, not this string.
  "[&_.ProseMirror_pre]:w-full [&_.ProseMirror_pre]:box-border [&_.ProseMirror_pre]:font-mono [&_.ProseMirror_pre]:text-[13px] [&_.ProseMirror_pre]:leading-relaxed",
  "[&_.ProseMirror_pre]:relative [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:pt-7",
  "[&_.ProseMirror_pre::before]:content-['Code'] [&_.ProseMirror_pre::before]:absolute [&_.ProseMirror_pre::before]:top-2 [&_.ProseMirror_pre::before]:right-3",
  "[&_.ProseMirror_pre::before]:text-[10px] [&_.ProseMirror_pre::before]:uppercase [&_.ProseMirror_pre::before]:tracking-wide [&_.ProseMirror_pre::before]:text-neutral-400",
  // Blockquote: a soft tint behind the existing left-border-and-italic Typography default, so it
  // reads as its own block rather than just indented italic text.
  "[&_.ProseMirror_blockquote]:bg-neutral-50 dark:[&_.ProseMirror_blockquote]:bg-neutral-800/40 [&_.ProseMirror_blockquote]:rounded-r-md [&_.ProseMirror_blockquote]:py-1",
  // Empty-doc placeholder ("Start writing…") - @tiptap/extension-placeholder decorates the empty
  // paragraph with `is-editor-empty` + a data-placeholder attribute rather than rendering real
  // text, so this is what actually makes it visible. Harmless on the read-only preview too, since
  // an empty version's paragraph is still marked is-editor-empty regardless of `editable`.
  "[&_.ProseMirror_p.is-editor-empty::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty::before]:float-left",
  "[&_.ProseMirror_p.is-editor-empty::before]:h-0 [&_.ProseMirror_p.is-editor-empty::before]:pointer-events-none",
  "[&_.ProseMirror_p.is-editor-empty::before]:text-neutral-400 dark:[&_.ProseMirror_p.is-editor-empty::before]:text-neutral-500",
  // Image selection/resize/crop/reorder styling lives entirely inside DocImageView.tsx (a custom
  // NodeView), driven by the `selected` prop Tiptap passes it directly - not global CSS, since
  // ProseMirror-selectednode lands on the NodeView's own wrapper element rather than the raw
  // <img> once a NodeView owns it.
].join(" ");
