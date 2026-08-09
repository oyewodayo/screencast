// components/docs/DocsEditor.tsx
//
// Top-level Docs editing surface - the Docs feature's counterpart to BoardEditor.tsx. Owns the
// useDocsEditStore instance and the Tiptap editor bound to its Y.Doc via @tiptap/extension-
// collaboration. Much shorter than BoardEditor since there's no canvas/selection/image logic here
// - just a title field, a formatting toolbar, and the editable content area.
import React, { useCallback, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { IoArrowBack } from "react-icons/io5";
import {
  MdFormatBold,
  MdFormatItalic,
  MdFormatUnderlined,
  MdFormatListBulleted,
  MdFormatListNumbered,
  MdLink,
  MdLinkOff,
} from "react-icons/md";
import useDocsEditStore from "../../hooks/useDocsEditStore";

interface DocsEditorProps {
  docId: string;
  onBack: () => void;
}

const toolbarButtonClass = (active: boolean): string =>
  `p-2 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
    active ? "bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400" : ""
  }`;

const DocsEditor: React.FC<DocsEditorProps> = ({ docId, onBack }) => {
  const store = useDocsEditStore(docId);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

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
          {store.isSaving ? "Saving…" : store.saveError ? "Save failed" : ""}
        </span>
      </div>

      {editor && (
        <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800 bg-white/60 dark:bg-neutral-900/60 flex-wrap">
          <button type="button" title="Bold" onClick={() => editor.chain().focus().toggleBold().run()} className={toolbarButtonClass(editor.isActive("bold"))}>
            <MdFormatBold size={18} />
          </button>
          <button type="button" title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} className={toolbarButtonClass(editor.isActive("italic"))}>
            <MdFormatItalic size={18} />
          </button>
          <button type="button" title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()} className={toolbarButtonClass(editor.isActive("underline"))}>
            <MdFormatUnderlined size={18} />
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
