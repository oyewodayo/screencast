// components/docs/DocsEditor.tsx
//
// Top-level Docs editing surface - the Docs feature's counterpart to BoardEditor.tsx. Owns the
// useDocsEditStore instance and the Tiptap editor bound to its Y.Doc via @tiptap/extension-
// collaboration. Much shorter than BoardEditor since there's no canvas/selection/image logic here
// - just a title field, a formatting toolbar, and the editable content area.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useEditor, EditorContent } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import Placeholder from "@tiptap/extension-placeholder";
import { IoArrowBack, IoChatbubbleOutline, IoClose, IoOptionsOutline, IoSearch, IoTimeOutline } from "react-icons/io5";
import {
  MdFormatBold,
  MdFormatItalic,
  MdFormatUnderlined,
  MdStrikethroughS,
  MdCode,
  MdDataObject,
  MdFormatQuote,
  MdFormatListBulleted,
  MdFormatListNumbered,
  MdLink,
  MdLinkOff,
  MdUndo,
  MdRedo,
  MdFileDownload,
  MdInsertLink,
  MdFormatAlignLeft,
  MdFormatAlignCenter,
  MdFormatAlignRight,
  MdFormatAlignJustify,
  MdFormatColorText,
  MdFormatColorFill,
  MdTableChart,
  MdTableRows,
  MdImage,
  MdSuperscript,
  MdSubscript,
  MdFormatClear,
  MdFormatLineSpacing,
  MdFormatIndentIncrease,
  MdFormatIndentDecrease,
  MdAddComment,
} from "react-icons/md";
import useDocsEditStore from "../../hooks/useDocsEditStore";
import { docJsonToMarkdown } from "../../utils/docMarkdown";
import { buildDocxBytes } from "../../utils/docDocx";
import { LibraryFileEntry } from "../../utils/docTypes";
import { createDocImagePasteExtension, uploadImageFromPath } from "../../utils/docImagePaste";
import { createSlashCommandExtension } from "../../utils/docSlashCommand";
import DocFindReplace from "../../utils/docFindReplace";
import { getDocContentExtensions, docProseClassName } from "../../utils/docSchemaExtensions";
import DocVersionHistoryPanel from "./DocVersionHistoryPanel";
import DocFindReplaceBar from "./DocFindReplaceBar";
import DocCommentsSidebar from "./DocCommentsSidebar";
import DocPageSetupPopover from "./DocPageSetupPopover";
import DocColorPicker from "./DocColorPicker";
import DocAutoPaginate from "../../utils/docAutoPaginate";
import { PAGE_DIMENSIONS_IN, PAGE_MARGIN_IN, marginPx, pageWidthPx } from "../../utils/docPageGeometry";
import "./docCodeHighlight.css";
import "./docFindReplace.css";
import "./docComments.css";
import "./docPageLayout.css";
import "./docLinks.css";
import "../board/boardFonts.css";

interface DocsEditorProps {
  docId: string;
  onBack: () => void;
  libraryFiles: LibraryFileEntry[];
  onOpenLinkedFile?: (path: string, name: string) => void;
}

const toolbarButtonClass = (active: boolean, disabled = false): string =>
  `p-2 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors ${
    active ? "bg-blue-100 dark:bg-blue-500/25 text-blue-600 dark:text-blue-300 ring-1 ring-inset ring-blue-200 dark:ring-blue-500/40" : ""
  } ${disabled ? "opacity-40 cursor-not-allowed hover:bg-transparent dark:hover:bg-transparent" : ""}`;

const toolbarDivider = <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-2" />;

// Classic web-safe fonts (matches what .docx documents and Word itself most commonly use, for
// importing/exporting fidelity) plus a handful of modern ones - the latter self-hosted via
// boardFonts.css (imported below) rather than plain OS font names, the same "renders the same on
// every machine, not just ones that happen to have it installed" reasoning that file's own header
// comment gives for BoardText's font picker. Bebas Neue is left out here - a display-only all-caps
// face fits BoardText's poster-style text but not general document prose.
const FONT_FAMILIES = [
  "Arial",
  "Calibri",
  "Cambria",
  "Courier New",
  "Georgia",
  "Helvetica",
  "Times New Roman",
  "Verdana",
  "Inter",
  "Poppins",
  "Montserrat",
  "Space Grotesk",
  "Playfair Display",
];


const DocsEditor: React.FC<DocsEditorProps> = ({ docId, onBack, libraryFiles, onOpenLinkedFile }) => {
  const store = useDocsEditStore(docId);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [showTextColorPicker, setShowTextColorPicker] = useState(false);
  const [showHighlightPicker, setShowHighlightPicker] = useState(false);
  const [showAlignMenu, setShowAlignMenu] = useState(false);
  const [showLineSpacingMenu, setShowLineSpacingMenu] = useState(false);
  const [showTableOptions, setShowTableOptions] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [showPageSetup, setShowPageSetup] = useState(false);

  const editor = useEditor(
    {
      extensions: [
        // Schema-contributing extensions (StarterKit, Underline, Link, Image, Table+*, TextAlign,
        // TextStyle, Color) live in getDocContentExtensions() - shared with docxImport.ts's
        // headless schema builder so the live editor and the importer can never drift apart.
        ...getDocContentExtensions(docId),
        // Collaboration's own history (Yjs UndoManager) replaces StarterKit's plain history -
        // undo/redo need to walk CRDT operations, not a linear command stack, once this doc can
        // eventually receive remote updates too.
        ...(store.ydoc ? [Collaboration.configure({ document: store.ydoc })] : []),
        createDocImagePasteExtension(docId),
        createSlashCommandExtension(docId),
        DocFindReplace,
        DocAutoPaginate,
        Placeholder.configure({ placeholder: "Start writing…" }),
      ],
      editable: !store.loading,
      // Focuses the content area as soon as the doc is ready, so opening a doc (new or existing)
      // lets you start typing immediately instead of requiring a click into the editor first.
      autofocus: "start",
      // Auto-fills the title from the first line typed/pasted, but only while the title is still
      // an untouched default - self-limiting, since setTitle moves it off that pattern and the
      // guard below then no-ops on every later keystroke. Also treats a blank/whitespace-only
      // title as "still default", not just the exact "Untitled document N" string - a doc can end
      // up with an empty title (e.g. from an older create path, or a title cleared by hand), and
      // without this the regex-only check leaves auto-fill permanently disabled for that doc.
      onUpdate: ({ editor: e }) => {
        const isDefaultTitle = store.title.trim() === "" || /^Untitled document \d+$/.test(store.title);
        if (!isDefaultTitle) return;
        const firstLine = e.getText({ blockSeparator: "\n" }).split("\n")[0]?.trim() ?? "";
        if (!firstLine) return;
        store.setTitle(firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine);
      },
    },
    [store.ydoc]
  );

  // Meta-only transaction, not an editor recreation - changing page size shouldn't disturb cursor
  // position or the Collaboration binding, and docAutoPaginate.ts's own plugin `update()` hook
  // reacts to this to trigger an immediate recompute (a page-size change doesn't itself resize
  // view.dom, so the extension's ResizeObserver wouldn't fire for it on its own).
  useEffect(() => {
    if (!editor || store.pageSize === null) return;
    editor.commands.setPaginationPageSize(store.pageSize);
  }, [editor, store.pageSize]);

  const handleBack = useCallback(() => {
    store.flushSave().catch((err) => console.error("Failed to save before navigating back:", err));
    onBack();
  }, [store, onBack]);

  const handlePrint = useCallback(() => {
    setShowExportMenu(false);
    // Chrome/Edge's print dialog derives both its default "Save as PDF" filename and the printed
    // page's header text from document.title - which is otherwise a static app-wide value
    // (index.html's <title>), not this document's title. Swap it in just for the print dialog,
    // then restore it once the dialog closes (afterprint fires whether printed or cancelled) so
    // the app's own window/tab title isn't left showing a stale document name.
    const previousTitle = document.title;
    const safeTitle = store.title.replace(/[\\/:*?"<>|]/g, "_").trim();
    document.title = safeTitle || previousTitle;
    const restore = () => {
      document.title = previousTitle;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }, [store.title]);

  const toggleLink = useCallback(() => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    // Toggle closed if the popover's already open (matches every other toolbar popover's own
    // open/close button in this file) - previously this only ever forced it open, so clicking the
    // link icon a second time to dismiss it silently did nothing.
    setShowLinkInput((prev) => {
      const next = !prev;
      if (next) {
        setLinkUrl("");
        setLinkText("");
      }
      return next;
    });
  }, [editor]);

  const applyLink = useCallback(() => {
    if (!editor) return;
    const url = linkUrl.trim();
    if (url) {
      if (editor.state.selection.empty) {
        // Nothing selected to attach the link mark to - a mark needs a range of text to wrap, so
        // setLink alone would silently do nothing here. Insert the link's own text (whatever the
        // user typed in the Text field, falling back to the URL itself) as new marked text at the
        // cursor instead, same as Word/Docs' own "no selection" insert-link behavior.
        const displayText = linkText.trim() || url;
        editor
          .chain()
          .focus()
          .insertContent({ type: "text", text: displayText, marks: [{ type: "link", attrs: { href: url } }] })
          .run();
      } else {
        editor.chain().focus().setLink({ href: url }).run();
      }
    }
    setShowLinkInput(false);
    setLinkUrl("");
    setLinkText("");
  }, [editor, linkUrl, linkText]);

  // The mark is applied first (crypto.randomUUID() as its own commentId) so the anchor exists in
  // the doc even if the add_doc_comment invoke below fails - a comment record with no mark would be
  // useless, but a mark with no record is at worst an inert highlight, cleaned up the next time
  // anyone tries to delete it (unsetComment no-ops harmlessly if the backend record never landed).
  const submitComment = useCallback(async () => {
    if (!editor) return;
    const text = commentDraft.trim();
    if (!text) return;
    const markId = crypto.randomUUID();
    editor.chain().focus().setComment(markId).run();
    setCommentDraft("");
    setShowCommentInput(false);
    const comment = await store.addComment(markId, text);
    if (comment) setShowComments(true);
  }, [editor, commentDraft, store]);

  // Deleting a comment also strips its mark from wherever it currently sits in the doc, so a
  // deleted comment never leaves an orphaned highlight behind - unsetComment no-ops harmlessly if
  // the mark was already gone for some other reason.
  const handleDeleteComment = useCallback(
    (commentId: string) => {
      if (editor) {
        const target = store.comments.find((c) => c.id === commentId);
        if (target) editor.commands.unsetComment(target.mark_id);
      }
      void store.deleteComment(commentId);
    },
    [editor, store]
  );

  // Toolbar-driven counterpart to docImagePaste.ts's paste/drop handling - the only other way to
  // get an image into a doc up to now, which meant there was no clean way to insert one without
  // already having it on the clipboard or in an open OS window to drag from.
  const handleInsertImage = useCallback(async () => {
    if (!editor) return;
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      });
      if (!selected || Array.isArray(selected)) return; // cancelled
      const src = await uploadImageFromPath(docId, selected);
      editor.chain().focus().setImage({ src }).run();
    } catch (err) {
      console.error("Failed to insert image:", err);
    }
  }, [editor, docId]);

  const handleExport = useCallback(
    async (extension: "md" | "txt") => {
      if (!editor) return;
      setShowExportMenu(false);
      const content = extension === "md" ? docJsonToMarkdown(editor.getJSON(), store.comments) : editor.getText({ blockSeparator: "\n\n" });
      try {
        await invoke("export_doc", { docTitle: store.title, extension, content });
        setExportStatus("Exported");
      } catch (err) {
        console.error("Failed to export document:", err);
        setExportStatus(err instanceof Error ? err.message : String(err));
      } finally {
        setTimeout(() => setExportStatus(null), 3000);
      }
    },
    [editor, store.title]
  );

  const handleExportDocx = useCallback(async () => {
    if (!editor) return;
    setShowExportMenu(false);
    setExportStatus("Exporting…");
    try {
      const bytes = await buildDocxBytes(editor.getJSON(), store.title, {
        comments: store.comments,
        pageSize: store.pageSize,
        headerText: store.headerText,
        footerText: store.footerText,
      });
      await invoke("export_doc_binary", { docTitle: store.title, extension: "docx", bytes: Array.from(bytes) });
      setExportStatus("Exported");
    } catch (err) {
      console.error("Failed to export document as .docx:", err);
      setExportStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setTimeout(() => setExportStatus(null), 3000);
    }
  }, [editor, store.title]);

  // Recomputed on every render, not memoized on editor content - the toolbar area already
  // re-renders on every transaction (see the canUndo/canRedo comment above), so this is no more
  // work than that, and memoizing against a Tiptap editor instance (which never itself changes
  // identity on content edits) would just leave the count stale.
  const wordCount = useMemo(() => {
    if (!editor) return 0;
    const text = editor.getText().trim();
    return text ? text.split(/\s+/).length : 0;
  }, [editor, editor?.state.doc]);
  const charCount = editor ? editor.getText().length : 0;

  const linkedFile = useMemo(() => libraryFiles.find((f) => f.path === store.linkedTo), [libraryFiles, store.linkedTo]);
  const filteredLibraryFiles = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    if (!q) return libraryFiles;
    return libraryFiles.filter((f) => f.name.toLowerCase().includes(q));
  }, [libraryFiles, fileFilter]);

  return (
    <div
      className="w-full h-full flex flex-col bg-gradient-to-b from-neutral-100 to-neutral-200 dark:from-neutral-900 dark:to-neutral-950 print:bg-white print:h-auto print:block"
      // Ctrl/Cmd+F opens the find bar instead of the browser's own native page-search - captured
      // at this wrapper (not a Tiptap keyboard-shortcut binding) since opening/closing is UI state
      // this component owns, not something docFindReplace.ts's extension has any reason to know
      // about.
      onKeyDownCapture={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          setShowFindReplace(true);
          return;
        }
        // Ctrl/Cmd+K opens the same "Add link"/"Remove link" popover the toolbar button does - one
        // of the most reflexive shortcuts from both Word and Docs, previously toolbar-only here.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
          e.preventDefault();
          toggleLink();
          return;
        }
        // Escape closes whatever toolbar popover is currently open - one handler here rather than
        // repeating the same keydown case in every popover, since this wrapper already sees every
        // keystroke in capture phase before the popover's own contents do. Harmless to call on
        // every Escape press even when nothing is open (each setter is a no-op against its own
        // already-false state). showFindReplace is deliberately not reset here - DocFindReplaceBar
        // owns its own Escape handling (it also needs to clear the live search decorations via
        // editor.commands.clearSearch(), not just hide the bar), and showComments is a persistent
        // docked panel, not a transient popover, so it's left open like the rest of the app's
        // sidebars are.
        if (e.key === "Escape") {
          setShowLinkInput(false);
          setShowExportMenu(false);
          setShowFilePicker(false);
          setShowTextColorPicker(false);
          setShowHighlightPicker(false);
          setShowAlignMenu(false);
          setShowLineSpacingMenu(false);
          setShowTableOptions(false);
          setShowCommentInput(false);
          setShowPageSetup(false);
          setShowVersionHistory(false);
        }
      }}
    >
      {/* Sets the actual paper size/margin Chromium's print engine uses for Print/Save-as-PDF -
          CSS `@page { size: ... }` is well-supported there (unlike Paged Media margin-box *content*,
          which isn't - see the header/footer divs below for why those use a different mechanism).
          The page card's own width/padding are set here too (as a real stylesheet rule targeting
          `.doc-page-card`, not inline style props) specifically so the `@media print` override
          below can win: an inline `style` attribute always beats any class - including a
          `print:...` one - regardless of the media query, so a `print:max-w-none`/`print:p-0`
          Tailwind class on this element would silently never have applied while width/padding were
          set inline. */}
      <style>{`
        @page { size: ${PAGE_DIMENSIONS_IN[store.pageSize ?? "letter"].cssSize}; margin: ${PAGE_MARGIN_IN}in; }
        .doc-page-card { max-width: ${pageWidthPx(store.pageSize ?? "letter")}px; padding: ${marginPx()}px; }
        @media print {
          .doc-page-card { max-width: none; padding: 0; }
        }
      `}</style>

      {/* Repeating header/footer: hidden on screen, shown only for print. `position: fixed` is a
          Chromium-specific quirk (not standards Paged Media) that makes an element repeat on every
          printed page rather than appearing once - the only reliable way to get repeating page
          chrome out of a Chromium print engine, which has no margin-box content support. */}
      {store.headerText && (
        <div
          className="hidden print:block fixed text-xs text-neutral-500"
          style={{ top: "0.3in", left: `${PAGE_MARGIN_IN}in`, right: `${PAGE_MARGIN_IN}in` }}
        >
          {store.headerText}
        </div>
      )}
      {store.footerText && (
        <div
          className="hidden print:block fixed text-xs text-neutral-500"
          style={{ bottom: "0.3in", left: `${PAGE_MARGIN_IN}in`, right: `${PAGE_MARGIN_IN}in` }}
        >
          {store.footerText}
        </div>
      )}

      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm print:hidden">
        <button
          type="button"
          onClick={handleBack}
          title="Back to docs" aria-label="Back to docs"
          className="p-2 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <IoArrowBack size={18} />
        </button>

        <input
          value={store.title}
          onChange={(e) => store.setTitle(e.target.value)}
          placeholder="Untitled document"
          className="min-w-0 flex-1 max-w-xs px-2 py-1 rounded-md text-sm font-medium bg-transparent border border-transparent hover:border-neutral-300 dark:hover:border-neutral-700 focus:border-blue-400 dark:focus:border-blue-500 outline-none text-neutral-800 dark:text-neutral-100"
        />

        {editor && !store.loading && (
          <span className="text-xs text-neutral-400 dark:text-neutral-500 shrink-0 print:hidden">
            {wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"} · {charCount.toLocaleString()} characters
          </span>
        )}

        <span className="text-xs text-neutral-400 dark:text-neutral-500 shrink-0">
          {exportStatus ?? (store.isSaving ? "Saving…" : store.saveError ? "Save failed" : "")}
        </span>
      </div>

      {editor && !store.loading && (
        // `editor.can().undo`/`.redo` only exist once Collaboration is in the extensions list
        // (they're registered by Collaboration itself, since StarterKit's own history is
        // disabled) - and `useEditor`'s swap to the Collaboration-bound instance happens in an
        // effect that runs strictly *after* the render where store.loading first flips to false
        // (React batches setYdoc+setLoading together, but useEditor's own effect to recreate the
        // editor for the new ydoc is a separate, later pass) - so there's exactly one render frame
        // where store.loading is already false but `editor` is still the pre-Collaboration
        // instance. Calling editor.can().undo() unguarded during that frame throws on a
        // nonexistent command and, with no error boundary anywhere in the app, takes down the
        // entire render tree - confirmed via a headless React+StrictMode repro reproducing the
        // exact "editor.can(...).undo is not a function" crash. Optional-chaining the call (not
        // just gating the surrounding render on `loading`) is what actually closes this gap.
        //
        // Two rows, not one long wrapping bar: row 1 is everything about how text itself looks
        // (undo/redo, style, font, character formatting, colors) - the "Home tab" equivalent; row
        // 2 is document structure/insertion and doc-level tools (alignment/spacing/lists, insert,
        // comments/links/find/history/page setup/export). Deliberately grouped rather than left to
        // wrap wherever the window happens to run out of width.
        <>
          <div className="shrink-0 flex items-center gap-1 px-3 pt-2 pb-1 bg-white/95 dark:bg-neutral-900/95 flex-wrap print:hidden">
          {/* editor.can()/isActive() checks that a button needs more than once (disabled state +
              className + onClick guard, or className + icon choice) are hoisted to a local const
              rather than re-invoked per usage - this toolbar re-renders on every editor
              transaction (every keystroke), so repeating the same check 2-3x per button in each
              render was pure waste. */}
          {(() => {
            const canUndo = editor.can().undo?.() ?? false;
            const canRedo = editor.can().redo?.() ?? false;
            return (
              <>
                <button type="button" title="Undo" aria-label="Undo" disabled={!canUndo} onClick={() => canUndo && editor.chain().focus().undo().run()} className={toolbarButtonClass(false, !canUndo)}>
                  <MdUndo size={18} />
                </button>
                <button type="button" title="Redo" aria-label="Redo" disabled={!canRedo} onClick={() => canRedo && editor.chain().focus().redo().run()} className={toolbarButtonClass(false, !canRedo)}>
                  <MdRedo size={18} />
                </button>
              </>
            );
          })()}

          {toolbarDivider}

          {/* One dropdown (Normal/Heading 1-3) rather than three separate H1/H2/H3 buttons - same
              information, closer to Word's own Home-tab "Styles" gallery footprint. */}
          <select
            title="Paragraph style" aria-label="Paragraph style"
            value={([1, 2, 3] as const).find((level) => editor.isActive("heading", { level }))?.toString() ?? "normal"}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "normal") editor.chain().focus().setParagraph().run();
              else editor.chain().focus().toggleHeading({ level: Number(value) as 1 | 2 | 3 }).run();
            }}
            className="w-28 px-1.5 py-1.5 text-xs rounded-md border border-neutral-200 dark:border-neutral-700 bg-transparent text-neutral-700 dark:text-neutral-200 outline-none"
          >
            <option value="normal">Normal</option>
            <option value="1">Heading 1</option>
            <option value="2">Heading 2</option>
            <option value="3">Heading 3</option>
          </select>

          {toolbarDivider}

          {/* Font family/size are frequent, everyday operations (matching an imported document's
              own font, or setting one before exporting) - kept directly on the bar rather than
              behind a click, same reasoning Google Docs' own toolbar uses for keeping them always
              visible instead of in an overflow menu. */}
          <select
            title="Font family" aria-label="Font family"
            value={editor.getAttributes("textStyle").fontFamily ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              if (value) editor.chain().focus().setFontFamily(value).run();
              else editor.chain().focus().unsetFontFamily().run();
            }}
            className="w-28 px-1.5 py-1.5 text-xs rounded-md border border-neutral-200 dark:border-neutral-700 bg-transparent text-neutral-700 dark:text-neutral-200 outline-none"
          >
            <option value="">Font</option>
            {FONT_FAMILIES.map((font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ))}
          </select>
          <input
            type="number"
            title="Font size (pt)" aria-label="Font size (pt)"
            min={1}
            max={200}
            value={editor.getAttributes("textStyle").fontSize ?? ""}
            placeholder="pt"
            onChange={(e) => {
              const value = parseFloat(e.target.value);
              if (e.target.value && !Number.isNaN(value)) editor.chain().focus().setFontSize(value).run();
              else editor.chain().focus().unsetFontSize().run();
            }}
            className="w-14 px-1.5 py-1.5 text-xs rounded-md border border-neutral-200 dark:border-neutral-700 bg-transparent text-neutral-700 dark:text-neutral-200 outline-none"
          />

          {toolbarDivider}

          <button type="button" title="Bold" aria-label="Bold" onClick={() => editor.chain().focus().toggleBold().run()} className={toolbarButtonClass(editor.isActive("bold"))}>
            <MdFormatBold size={18} />
          </button>
          <button type="button" title="Italic" aria-label="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} className={toolbarButtonClass(editor.isActive("italic"))}>
            <MdFormatItalic size={18} />
          </button>
          {(() => {
            // On a link, "Underline" toggles the link's own underlineOff attribute (see
            // docLinkExtension.ts) instead of the generic underline mark - an autolinked URL/email
            // never gets that mark applied, only docLinks.css's default styling does, and plain
            // CSS has no per-instance "toggle" of its own the way a mark or attribute does.
            const onLink = editor.isActive("link");
            const linkUnderlineOff = editor.getAttributes("link").underlineOff === true;
            const underlineActive = onLink ? !linkUnderlineOff : editor.isActive("underline");
            return (
              <button
                type="button"
                title="Underline" aria-label="Underline"
                onClick={() =>
                  onLink
                    ? editor.chain().focus().updateAttributes("link", { underlineOff: !linkUnderlineOff }).run()
                    : editor.chain().focus().toggleUnderline().run()
                }
                className={toolbarButtonClass(underlineActive)}
              >
                <MdFormatUnderlined size={18} />
              </button>
            );
          })()}
          <button type="button" title="Strikethrough" aria-label="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()} className={toolbarButtonClass(editor.isActive("strike"))}>
            <MdStrikethroughS size={18} />
          </button>
          <button type="button" title="Inline code" aria-label="Inline code" onClick={() => editor.chain().focus().toggleCode().run()} className={toolbarButtonClass(editor.isActive("code"))}>
            <MdCode size={18} />
          </button>
          <button type="button" title="Superscript" aria-label="Superscript" onClick={() => editor.chain().focus().toggleSuperscript().run()} className={toolbarButtonClass(editor.isActive("superscript"))}>
            <MdSuperscript size={18} />
          </button>
          <button type="button" title="Subscript" aria-label="Subscript" onClick={() => editor.chain().focus().toggleSubscript().run()} className={toolbarButtonClass(editor.isActive("subscript"))}>
            <MdSubscript size={18} />
          </button>
          <button
            type="button"
            title="Clear formatting" aria-label="Clear formatting"
            onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
            className={toolbarButtonClass(false)}
          >
            <MdFormatClear size={18} />
          </button>

          {toolbarDivider}

          <div className="relative">
            <button type="button" title="Text color" aria-label="Text color" onClick={() => setShowTextColorPicker((v) => !v)} className={toolbarButtonClass(showTextColorPicker)}>
              <span className="flex flex-col items-center">
                <MdFormatColorText size={18} />
                <span
                  className="block w-4 h-1 rounded-sm mt-0.5"
                  style={{ backgroundColor: (editor.getAttributes("textStyle").color as string | undefined) ?? "currentColor" }}
                />
              </span>
            </button>
            {showTextColorPicker && (
              <div className="absolute left-0 top-full mt-1 z-10">
                <DocColorPicker
                  value={(editor.getAttributes("textStyle").color as string | undefined) ?? null}
                  onChange={(color) => editor.chain().focus().setColor(color).run()}
                  onClear={() => {
                    editor.chain().focus().unsetColor().run();
                    setShowTextColorPicker(false);
                  }}
                  onClose={() => setShowTextColorPicker(false)}
                  storageKey="text"
                  clearLabel="Clear color"
                />
              </div>
            )}
          </div>

          <div className="relative">
            <button type="button" title="Highlight color" aria-label="Highlight color" onClick={() => setShowHighlightPicker((v) => !v)} className={toolbarButtonClass(showHighlightPicker)}>
              <span className="flex flex-col items-center">
                <MdFormatColorFill size={18} />
                <span
                  className="block w-4 h-1 rounded-sm mt-0.5"
                  style={{ backgroundColor: (editor.getAttributes("highlight").color as string | undefined) ?? "transparent", outline: "1px solid currentColor" }}
                />
              </span>
            </button>
            {showHighlightPicker && (
              <div className="absolute left-0 top-full mt-1 z-10">
                <DocColorPicker
                  value={(editor.getAttributes("highlight").color as string | undefined) ?? null}
                  onChange={(color) => editor.chain().focus().setHighlight({ color }).run()}
                  onClear={() => {
                    editor.chain().focus().unsetHighlight().run();
                    setShowHighlightPicker(false);
                  }}
                  onClose={() => setShowHighlightPicker(false)}
                  storageKey="highlight"
                  clearLabel="Clear highlight"
                />
              </div>
            )}
          </div>
          </div>

          <div className="shrink-0 flex items-center gap-1 px-3 pt-1 pb-2 border-b border-neutral-200 dark:border-neutral-800 bg-white/95 dark:bg-neutral-900/95 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex-wrap print:hidden">
          <div className="relative">
            {(() => {
              const activeAlign = (["left", "center", "right", "justify"] as const).find((align) => editor.isActive({ textAlign: align })) ?? "left";
              const AlignIcon = { left: MdFormatAlignLeft, center: MdFormatAlignCenter, right: MdFormatAlignRight, justify: MdFormatAlignJustify }[activeAlign];
              return (
                <button type="button" title="Align" aria-label="Align" onClick={() => setShowAlignMenu((v) => !v)} className={toolbarButtonClass(showAlignMenu)}>
                  <AlignIcon size={18} />
                </button>
              );
            })()}
            {showAlignMenu && (
              <div className="absolute left-0 top-full mt-1 z-10 flex items-center gap-1 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg p-1.5">
                {(
                  [
                    ["left", MdFormatAlignLeft, "Align left"],
                    ["center", MdFormatAlignCenter, "Align center"],
                    ["right", MdFormatAlignRight, "Align right"],
                    ["justify", MdFormatAlignJustify, "Justify"],
                  ] as const
                ).map(([align, Icon, label]) => (
                  <button
                    key={align}
                    type="button"
                    title={label}
                    aria-label={label}
                    onClick={() => {
                      editor.chain().focus().setTextAlign(align).run();
                      setShowAlignMenu(false);
                    }}
                    className={toolbarButtonClass(editor.isActive({ textAlign: align }))}
                  >
                    <Icon size={18} />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <button type="button" title="Line spacing" aria-label="Line spacing" onClick={() => setShowLineSpacingMenu((v) => !v)} className={toolbarButtonClass(showLineSpacingMenu)}>
              <MdFormatLineSpacing size={18} />
            </button>
            {showLineSpacingMenu && (
              <div className="absolute left-0 top-full mt-1 z-10 w-24 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg p-1">
                {[1, 1.15, 1.5, 2].map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      editor.chain().focus().setLineSpacing(value).run();
                      setShowLineSpacingMenu(false);
                    }}
                    className="w-full text-left px-2 py-1.5 text-xs rounded text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  >
                    {value}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    editor.chain().focus().unsetLineSpacing().run();
                    setShowLineSpacingMenu(false);
                  }}
                  className="w-full text-left px-2 py-1.5 text-xs rounded text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700 border-t border-neutral-100 dark:border-neutral-700 mt-0.5 pt-1.5"
                >
                  Default
                </button>
              </div>
            )}
          </div>

          <button type="button" title="Decrease indent" aria-label="Decrease indent" onClick={() => editor.chain().focus().outdent().run()} className={toolbarButtonClass(false)}>
            <MdFormatIndentDecrease size={18} />
          </button>
          <button type="button" title="Increase indent" aria-label="Increase indent" onClick={() => editor.chain().focus().indent().run()} className={toolbarButtonClass(false)}>
            <MdFormatIndentIncrease size={18} />
          </button>

          {toolbarDivider}

          <button type="button" title="Blockquote" aria-label="Blockquote" onClick={() => editor.chain().focus().toggleBlockquote().run()} className={toolbarButtonClass(editor.isActive("blockquote"))}>
            <MdFormatQuote size={18} />
          </button>
          <button type="button" title="Code block" aria-label="Code block" onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={toolbarButtonClass(editor.isActive("codeBlock"))}>
            <MdDataObject size={18} />
          </button>

          {toolbarDivider}

          <button type="button" title="Bullet list" aria-label="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()} className={toolbarButtonClass(editor.isActive("bulletList"))}>
            <MdFormatListBulleted size={18} />
          </button>
          <button type="button" title="Numbered list" aria-label="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={toolbarButtonClass(editor.isActive("orderedList"))}>
            <MdFormatListNumbered size={18} />
          </button>

          {toolbarDivider}

          <button type="button" title="Insert image" aria-label="Insert image" onClick={() => void handleInsertImage()} className={toolbarButtonClass(false)}>
            <MdImage size={18} />
          </button>

          <div className="relative">
            {(() => {
              const isLinkActive = editor.isActive("link");
              return (
                <button
                  type="button"
                  title={isLinkActive ? "Remove link" : "Add link"}
                  aria-label={isLinkActive ? "Remove link" : "Add link"}
                  onClick={toggleLink}
                  className={toolbarButtonClass(isLinkActive)}
                >
                  {isLinkActive ? <MdLinkOff size={18} /> : <MdLink size={18} />}
                </button>
              );
            })()}
            {/* The Tauri dialog allowlist only exposes "message"/"open" - no native text-prompt
                dialog - so the URL has to come from an inline popover instead of window.prompt. */}
            {showLinkInput && (
              <div className="absolute left-0 top-full mt-1 z-10 flex flex-col gap-1 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg p-1.5">
                {/* Only shown with no selection - with one, the selected text already *is* the
                    link's visible label, same as before. Without one, setLink has no text range to
                    attach the mark to, so applyLink instead inserts this (or the URL itself, if
                    left blank) as new text at the cursor. */}
                {editor.state.selection.empty && (
                  <input
                    autoFocus
                    value={linkText}
                    onChange={(e) => setLinkText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyLink();
                      if (e.key === "Escape") setShowLinkInput(false);
                    }}
                    placeholder="Text to display"
                    className="w-48 px-2 py-1 text-sm rounded border border-neutral-200 dark:border-neutral-700 bg-transparent outline-none text-neutral-800 dark:text-neutral-100"
                  />
                )}
                <div className="flex items-center gap-1">
                  <input
                    autoFocus={!editor.state.selection.empty}
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyLink();
                      if (e.key === "Escape") setShowLinkInput(false);
                    }}
                    placeholder="https://…"
                    className="w-48 px-2 py-1 text-sm rounded border border-neutral-200 dark:border-neutral-700 bg-transparent outline-none text-neutral-800 dark:text-neutral-100"
                  />
                  <button type="button" onClick={applyLink} className="px-2 py-1 text-sm rounded bg-blue-600 text-white hover:bg-blue-700">
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            title="Insert table" aria-label="Insert table"
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
            className={toolbarButtonClass(false)}
          >
            <MdTableChart size={18} />
          </button>

          {editor.isActive("table") && (
            <div className="relative">
              <button type="button" title="Table options" aria-label="Table options" onClick={() => setShowTableOptions((v) => !v)} className={toolbarButtonClass(showTableOptions)}>
                <MdTableRows size={18} />
              </button>
              {showTableOptions && (
                <div className="absolute left-0 top-full mt-1 z-10 w-48 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg p-1.5 space-y-0.5">
                  <button type="button" onClick={() => editor.chain().focus().addRowBefore().run()} className="w-full text-left px-2 py-1.5 text-xs rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
                    + Row above
                  </button>
                  <button type="button" onClick={() => editor.chain().focus().addRowAfter().run()} className="w-full text-left px-2 py-1.5 text-xs rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
                    + Row below
                  </button>
                  <button type="button" onClick={() => editor.chain().focus().deleteRow().run()} className="w-full text-left px-2 py-1.5 text-xs rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
                    Delete row
                  </button>
                  <button type="button" onClick={() => editor.chain().focus().addColumnBefore().run()} className="w-full text-left px-2 py-1.5 text-xs rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
                    + Column left
                  </button>
                  <button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()} className="w-full text-left px-2 py-1.5 text-xs rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
                    + Column right
                  </button>
                  <button type="button" onClick={() => editor.chain().focus().deleteColumn().run()} className="w-full text-left px-2 py-1.5 text-xs rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
                    Delete column
                  </button>
                  <button
                    type="button"
                    onClick={() => editor.chain().focus().deleteTable().run()}
                    className="w-full text-left px-2 py-1.5 text-xs rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 border-t border-neutral-100 dark:border-neutral-700 mt-0.5 pt-1.5"
                  >
                    Delete table
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="ml-auto flex items-center gap-1">
            <div className="relative">
              <button
                type="button"
                title="Add comment" aria-label="Add comment"
                disabled={!editor || editor.state.selection.empty}
                onClick={() => {
                  setCommentDraft("");
                  setShowCommentInput(true);
                }}
                className={toolbarButtonClass(showCommentInput, !editor || editor.state.selection.empty)}
              >
                <MdAddComment size={18} />
              </button>
              {showCommentInput && (
                <div className="absolute right-0 top-full mt-1 z-10 w-64 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg p-2">
                  <textarea
                    autoFocus
                    rows={3}
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setShowCommentInput(false);
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitComment();
                    }}
                    placeholder="Comment…"
                    className="w-full px-2 py-1.5 text-sm rounded border border-neutral-200 dark:border-neutral-700 bg-transparent outline-none text-neutral-800 dark:text-neutral-100 resize-none"
                  />
                  <div className="flex justify-end gap-1.5 mt-1.5">
                    <button
                      type="button"
                      onClick={() => setShowCommentInput(false)}
                      className="px-2 py-1 text-xs rounded text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!commentDraft.trim()}
                      onClick={() => void submitComment()}
                      className="px-2.5 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
                    >
                      Comment
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              title="Comments" aria-label="Comments"
              onClick={() => setShowComments((v) => !v)}
              className={toolbarButtonClass(showComments)}
            >
              <IoChatbubbleOutline size={17} />
            </button>

            {store.linkedTo ? (
              <div className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-md bg-neutral-100 dark:bg-neutral-800 text-xs text-neutral-600 dark:text-neutral-300">
                <MdInsertLink size={14} />
                <button
                  type="button"
                  title="Open linked recording" aria-label="Open linked recording"
                  onClick={() => linkedFile && onOpenLinkedFile?.(linkedFile.path, linkedFile.name)}
                  className="truncate max-w-[10rem] hover:underline text-left"
                >
                  {linkedFile?.name ?? "Linked file"}
                </button>
                <button
                  type="button"
                  title="Unlink" aria-label="Unlink"
                  onClick={() => void store.unlinkDoc()}
                  className="p-0.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-red-500"
                >
                  <IoClose size={14} />
                </button>
              </div>
            ) : (
              <div className="relative">
                <button
                  type="button"
                  title="Link to recording" aria-label="Link to recording"
                  onClick={() => setShowFilePicker((v) => !v)}
                  className={toolbarButtonClass(showFilePicker)}
                >
                  <MdInsertLink size={18} />
                </button>
                {showFilePicker && (
                  <div className="absolute right-0 top-full mt-1 z-10 w-56 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg p-1.5">
                    <input
                      autoFocus
                      value={fileFilter}
                      onChange={(e) => setFileFilter(e.target.value)}
                      placeholder="Filter recordings…"
                      className="w-full mb-1 px-2 py-1 text-sm rounded border border-neutral-200 dark:border-neutral-700 bg-transparent outline-none text-neutral-800 dark:text-neutral-100"
                    />
                    <div className="max-h-48 overflow-y-auto">
                      {filteredLibraryFiles.length === 0 ? (
                        <p className="px-2 py-1.5 text-xs text-neutral-400 dark:text-neutral-500">No matching files</p>
                      ) : (
                        filteredLibraryFiles.map((f) => (
                          <button
                            key={f.path}
                            type="button"
                            onClick={() => {
                              void store.linkDoc(f.path);
                              setShowFilePicker(false);
                              setFileFilter("");
                            }}
                            className="w-full text-left truncate px-2 py-1.5 text-sm rounded text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                          >
                            {f.name}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              title="Find and replace (Ctrl+F)" aria-label="Find and replace (Ctrl+F)"
              onClick={() => setShowFindReplace(true)}
              className={toolbarButtonClass(showFindReplace)}
            >
              <IoSearch size={17} />
            </button>

            <button
              type="button"
              title="Version history" aria-label="Version history"
              onClick={() => {
                store.refreshVersions();
                setShowVersionHistory(true);
              }}
              className={toolbarButtonClass(false)}
            >
              <IoTimeOutline size={18} />
            </button>

            <div className="relative">
              <button type="button" title="Page setup" aria-label="Page setup" onClick={() => setShowPageSetup((v) => !v)} className={toolbarButtonClass(showPageSetup)}>
                <IoOptionsOutline size={18} />
              </button>
              {showPageSetup && (
                <DocPageSetupPopover
                  pageSize={store.pageSize}
                  headerText={store.headerText}
                  footerText={store.footerText}
                  onApply={(size, header, footer) => void store.setPageSetup(size, header, footer)}
                  onClose={() => setShowPageSetup(false)}
                />
              )}
            </div>

            <div className="relative">
              <button type="button" title="Export" aria-label="Export" onClick={() => setShowExportMenu((v) => !v)} className={toolbarButtonClass(showExportMenu)}>
                <MdFileDownload size={18} />
              </button>
              {showExportMenu && (
                <div className="absolute right-0 top-full mt-1 z-10 w-44 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => void handleExport("md")}
                    className="w-full text-left px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  >
                    Markdown (.md)
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleExport("txt")}
                    className="w-full text-left px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  >
                    Plain text (.txt)
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleExportDocx()}
                    className="w-full text-left px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  >
                    Word Document (.docx)
                  </button>
                  <button
                    type="button"
                    onClick={handlePrint}
                    className="w-full text-left px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 border-t border-neutral-100 dark:border-neutral-700"
                  >
                    Print / Save as PDF
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        </>
      )}

      {editor && showFindReplace && <DocFindReplaceBar editor={editor} onClose={() => setShowFindReplace(false)} />}

      <div className="flex-1 min-h-0 flex print:block">
        {/* print:overflow-visible/h-auto/block - without these, this flex/overflow-auto box (built
            for on-screen scrolling) clips the document to whatever fits in the viewport instead of
            flowing across printed pages, since overflow:auto content doesn't reflow for print the
            way normal block content does. */}
        <div className="flex-1 min-w-0 overflow-y-auto px-8 py-10 print:flex-none print:h-auto print:overflow-visible print:block print:p-0">
          {store.loading || !editor ? (
            <div className="flex items-center justify-center h-full text-neutral-400 dark:text-neutral-500 text-sm">Loading…</div>
          ) : store.loadError ? (
            <div className="flex items-center justify-center h-full text-red-500 dark:text-red-400 text-sm">{store.loadError}</div>
          ) : (
            // The "page": a bounded card on the surrounding gray backdrop, rather than content
            // floating directly on the app background - gives the document a distinct identity the
            // way Docs/Notion-style editors do, instead of blending into the chrome around it.
            // Square corners, not rounded - a real printed page has a flat-cut edge, and
            // docAutoPaginate.ts's own page-gap dividers (docPageLayout.css) are flat too, so a
            // rounded top/bottom here would be the one page edge in the whole document that
            // doesn't match the rest.
            // Width and padding (the exact real 1in print margin, not an arbitrary Tailwind spacing
            // step - both for true on-screen/print WYSIWYG and because docAutoPaginate.ts measures
            // against this real content-area size) come from the `.doc-page-card` rule injected
            // above, whose own `@media print` override hands full-page sizing to the `@page` rule.
            <div className="doc-page-card mx-auto bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-sm min-h-[75vh] print:shadow-none print:ring-0 print:mx-0 print:min-h-0">
              <EditorContent editor={editor} className={docProseClassName} />
            </div>
          )}
        </div>

        {editor && showComments && (
          <DocCommentsSidebar
            editor={editor}
            comments={store.comments}
            onResolve={(id) => void store.resolveComment(id)}
            onReopen={(id) => void store.reopenComment(id)}
            onDelete={handleDeleteComment}
            onClose={() => setShowComments(false)}
          />
        )}
      </div>

      {showVersionHistory && (
        <DocVersionHistoryPanel
          docId={docId}
          versions={store.versions}
          onClose={() => setShowVersionHistory(false)}
          onRestore={store.restoreVersion}
        />
      )}
    </div>
  );
};

export default DocsEditor;
