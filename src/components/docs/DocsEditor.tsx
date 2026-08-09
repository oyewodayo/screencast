// components/docs/DocsEditor.tsx
//
// Top-level Docs editing surface - the Docs feature's counterpart to BoardEditor.tsx. Owns the
// useDocsEditStore instance and the Tiptap editor bound to its Y.Doc via @tiptap/extension-
// collaboration. Much shorter than BoardEditor since there's no canvas/selection/image logic here
// - just a title field, a formatting toolbar, and the editable content area.
import React, { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { IoArrowBack, IoClose } from "react-icons/io5";
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
} from "react-icons/md";
import useDocsEditStore from "../../hooks/useDocsEditStore";
import { docJsonToMarkdown } from "../../utils/docMarkdown";
import { LibraryFileEntry } from "../../utils/docTypes";

interface DocsEditorProps {
  docId: string;
  onBack: () => void;
  libraryFiles: LibraryFileEntry[];
  onOpenLinkedFile?: (path: string, name: string) => void;
}

const toolbarButtonClass = (active: boolean, disabled = false): string =>
  `p-2 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
    active ? "bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400" : ""
  } ${disabled ? "opacity-40 cursor-not-allowed hover:bg-transparent dark:hover:bg-transparent" : ""}`;

const DocsEditor: React.FC<DocsEditorProps> = ({ docId, onBack, libraryFiles, onOpenLinkedFile }) => {
  const store = useDocsEditStore(docId);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [fileFilter, setFileFilter] = useState("");

  const editor = useEditor(
    {
      extensions: [
        // Collaboration's own history (Yjs UndoManager) replaces StarterKit's plain history -
        // undo/redo need to walk CRDT operations, not a linear command stack, once this doc can
        // eventually receive remote updates too.
        StarterKit.configure({ history: false }),
        ...(store.ydoc ? [Collaboration.configure({ document: store.ydoc })] : []),
        Underline,
        Link.configure({ openOnClick: false, autolink: false }),
      ],
      editable: !store.loading,
    },
    [store.ydoc]
  );

  const handleBack = useCallback(() => {
    store.flushSave();
    onBack();
  }, [store, onBack]);

  const toggleLink = useCallback(() => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    setLinkUrl("");
    setShowLinkInput(true);
  }, [editor]);

  const applyLink = useCallback(() => {
    if (!editor) return;
    const url = linkUrl.trim();
    if (url) editor.chain().focus().setLink({ href: url }).run();
    setShowLinkInput(false);
    setLinkUrl("");
  }, [editor, linkUrl]);

  const handleExport = useCallback(
    async (extension: "md" | "txt") => {
      if (!editor) return;
      setShowExportMenu(false);
      const content = extension === "md" ? docJsonToMarkdown(editor.getJSON()) : editor.getText({ blockSeparator: "\n\n" });
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

  const linkedFile = useMemo(() => libraryFiles.find((f) => f.path === store.linkedTo), [libraryFiles, store.linkedTo]);
  const filteredLibraryFiles = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    if (!q) return libraryFiles;
    return libraryFiles.filter((f) => f.name.toLowerCase().includes(q));
  }, [libraryFiles, fileFilter]);

  return (
    <div className="w-full h-full flex flex-col bg-gradient-to-b from-neutral-100 to-neutral-200 dark:from-neutral-900 dark:to-neutral-950">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm">
        <button
          type="button"
          onClick={handleBack}
          title="Back to docs"
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
        <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800 bg-white/60 dark:bg-neutral-900/60 flex-wrap">
          <button type="button" title="Undo" disabled={!editor.can().undo?.()} onClick={() => editor.can().undo?.() && editor.chain().focus().undo().run()} className={toolbarButtonClass(false, !editor.can().undo?.())}>
            <MdUndo size={18} />
          </button>
          <button type="button" title="Redo" disabled={!editor.can().redo?.()} onClick={() => editor.can().redo?.() && editor.chain().focus().redo().run()} className={toolbarButtonClass(false, !editor.can().redo?.())}>
            <MdRedo size={18} />
          </button>

          <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-1" />

          <button type="button" title="Bold" onClick={() => editor.chain().focus().toggleBold().run()} className={toolbarButtonClass(editor.isActive("bold"))}>
            <MdFormatBold size={18} />
          </button>
          <button type="button" title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} className={toolbarButtonClass(editor.isActive("italic"))}>
            <MdFormatItalic size={18} />
          </button>
          <button type="button" title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()} className={toolbarButtonClass(editor.isActive("underline"))}>
            <MdFormatUnderlined size={18} />
          </button>
          <button type="button" title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()} className={toolbarButtonClass(editor.isActive("strike"))}>
            <MdStrikethroughS size={18} />
          </button>
          <button type="button" title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()} className={toolbarButtonClass(editor.isActive("code"))}>
            <MdCode size={18} />
          </button>

          <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-1" />

          {([1, 2, 3] as const).map((level) => (
            <button
              key={level}
              type="button"
              title={`Heading ${level}`}
              onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
              className={`${toolbarButtonClass(editor.isActive("heading", { level }))} text-sm font-semibold`}
            >
              H{level}
            </button>
          ))}

          <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-1" />

          <button type="button" title="Blockquote" onClick={() => editor.chain().focus().toggleBlockquote().run()} className={toolbarButtonClass(editor.isActive("blockquote"))}>
            <MdFormatQuote size={18} />
          </button>
          <button type="button" title="Code block" onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={toolbarButtonClass(editor.isActive("codeBlock"))}>
            <MdDataObject size={18} />
          </button>

          <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-1" />

          <button type="button" title="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()} className={toolbarButtonClass(editor.isActive("bulletList"))}>
            <MdFormatListBulleted size={18} />
          </button>
          <button type="button" title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={toolbarButtonClass(editor.isActive("orderedList"))}>
            <MdFormatListNumbered size={18} />
          </button>

          <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-1" />

          <div className="relative">
            <button type="button" title={editor.isActive("link") ? "Remove link" : "Add link"} onClick={toggleLink} className={toolbarButtonClass(editor.isActive("link"))}>
              {editor.isActive("link") ? <MdLinkOff size={18} /> : <MdLink size={18} />}
            </button>
            {/* The Tauri dialog allowlist only exposes "message"/"open" - no native text-prompt
                dialog - so the URL has to come from an inline popover instead of window.prompt. */}
            {showLinkInput && (
              <div className="absolute left-0 top-full mt-1 z-10 flex items-center gap-1 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg p-1.5">
                <input
                  autoFocus
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
            )}
          </div>

          <div className="ml-auto flex items-center gap-1">
            {store.linkedTo ? (
              <div className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-md bg-neutral-100 dark:bg-neutral-800 text-xs text-neutral-600 dark:text-neutral-300">
                <MdInsertLink size={14} />
                <button
                  type="button"
                  title="Open linked recording"
                  onClick={() => linkedFile && onOpenLinkedFile?.(linkedFile.path, linkedFile.name)}
                  className="truncate max-w-[10rem] hover:underline text-left"
                >
                  {linkedFile?.name ?? "Linked file"}
                </button>
                <button
                  type="button"
                  title="Unlink"
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
                  title="Link to recording"
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

            <div className="relative">
              <button type="button" title="Export" onClick={() => setShowExportMenu((v) => !v)} className={toolbarButtonClass(showExportMenu)}>
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
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-8 py-6">
        {store.loading || !editor ? (
          <div className="flex items-center justify-center h-full text-neutral-400 dark:text-neutral-500 text-sm">Loading…</div>
        ) : store.loadError ? (
          <div className="flex items-center justify-center h-full text-red-500 dark:text-red-400 text-sm">{store.loadError}</div>
        ) : (
          <EditorContent
            editor={editor}
            className="max-w-3xl mx-auto prose prose-sm dark:prose-invert prose-neutral [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[60vh]"
          />
        )}
      </div>
    </div>
  );
};

export default DocsEditor;
