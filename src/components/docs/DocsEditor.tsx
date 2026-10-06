// components/docs/DocsEditor.tsx
//
// Top-level Docs editing surface - the Docs feature's counterpart to BoardEditor.tsx. Owns the
// useDocsEditStore instance and the Tiptap editor bound to its Y.Doc via @tiptap/extension-
// collaboration. Layout follows Google Docs: a title row carrying the doc-level actions (find,
// comments, history, page setup, export), one formatting bar (DocToolbar.tsx), and the page.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { Extension } from "@tiptap/core";
import { useEditor, EditorContent } from "@tiptap/react";
import katex from "katex";
import Collaboration from "@tiptap/extension-collaboration";
import Placeholder from "@tiptap/extension-placeholder";
import { IoArrowBack, IoChatbubbleOutline, IoClose, IoCloudDoneOutline, IoOptionsOutline, IoSearch, IoTimeOutline, IoWarningOutline } from "react-icons/io5";
import { MdArrowDropDown, MdDescription, MdFileDownload, MdInsertLink, MdPrint } from "react-icons/md";
import { BsFiletypeDocx, BsFiletypeHtml, BsFiletypeMd, BsFiletypePdf, BsFiletypeTxt } from "react-icons/bs";
import useDocsEditStore from "../../hooks/useDocsEditStore";
import useDocDictation from "../../hooks/useDocDictation";
import { docJsonToMarkdown } from "../../utils/docMarkdown";
import { buildDocxBytes } from "../../utils/docDocx";
import { LibraryFileEntry } from "../../utils/docTypes";
import { createDocImagePasteExtension, uploadImageFromPath } from "../../utils/docImagePaste";
import { createSlashCommandExtension } from "../../utils/docSlashCommand";
import DocFindReplace from "../../utils/docFindReplace";
import DocDictation from "../../utils/docDictationExtension";
import DocPaint from "../../utils/docPaintExtension";
import { getDocContentExtensions, docProseClassName } from "../../utils/docSchemaExtensions";
import DocVersionHistoryPanel from "./DocVersionHistoryPanel";
import DocFindReplaceBar from "./DocFindReplaceBar";
import DocCommentsSidebar from "./DocCommentsSidebar";
import DocPageSetupPopover from "./DocPageSetupPopover";
import DocToolbar, { Dropdown, menuItemClass } from "./DocToolbar";
import DocAutoPaginate, { getPaginationPageCount } from "../../utils/docAutoPaginate";
import { PAGE_DIMENSIONS_IN, pageHeightPx, pageWidthPx, resolveMargins } from "../../utils/docPageGeometry";
import { DocHorizontalRuler, DocVerticalRuler, RULER_SIZE, useRulerUnit } from "./DocRuler";
import "./docCodeHighlight.css";
import "./docFindReplace.css";
import "./docComments.css";
import "./docPageLayout.css";
import "./docLinks.css";
import "./docDictation.css";
import "./docPaint.css";
import "../board/boardFonts.css";

interface DocsEditorProps {
  docId: string;
  onBack: () => void;
  libraryFiles: LibraryFileEntry[];
  onOpenLinkedFile?: (path: string, name: string) => void;
}

// Google Docs bindings the stock extensions don't provide. Priority above StarterKit so Mod-Enter
// inserts a page break (Docs) rather than HardBreak's own Mod-Enter line break; Shift-Enter still
// gives a line break.
const DocShortcuts = Extension.create({
  name: "docShortcuts",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => this.editor.commands.setPageBreak(),
      "Mod-\\": () => this.editor.chain().unsetAllMarks().clearNodes().run(),
      "Alt-Shift-5": () => this.editor.commands.toggleStrike(),
    };
  },
});

type ExportKind = "pdf" | "docx" | "html" | "md" | "txt";

const EXPORT_FORMATS: Record<ExportKind, { name: string; short: string; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  pdf: { name: "PDF document", short: "PDF", label: "PDF document (.pdf)", icon: BsFiletypePdf },
  docx: { name: "Word document", short: "Word document", label: "Microsoft Word (.docx)", icon: BsFiletypeDocx },
  html: { name: "Web page", short: "web page", label: "Web page (.html)", icon: BsFiletypeHtml },
  md: { name: "Markdown", short: "Markdown", label: "Markdown (.md)", icon: BsFiletypeMd },
  txt: { name: "Plain text", short: "plain text", label: "Plain text (.txt)", icon: BsFiletypeTxt },
};

interface Notice {
  text: string;
  path?: string;
  error?: boolean;
}

function exportBaseName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "Document").slice(0, 120);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

// A self-contained .html: images are inlined as data: URLs (their src is an asset:// URL into the
// doc's own folder, which means nothing outside this app) and a small stylesheet stands in for the
// editor's Tailwind prose styles.
async function buildStandaloneHtml(title: string, bodyHtml: string): Promise<string> {
  const dom = new DOMParser().parseFromString(`<body>${bodyHtml}</body>`, "text/html");
  await Promise.all(
    Array.from(dom.querySelectorAll("img")).map(async (img) => {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) return;
      try {
        const blob = await (await fetch(src)).blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        img.setAttribute("src", dataUrl);
      } catch {
        // leave the original src - a broken image beats a failed export
      }
    })
  );
  // Equations as native MathML (every current browser renders it, no fonts or stylesheet to
  // bundle); the LaTeX source stays in data-latex. Numbered display equations get their (n).
  let equationNumber = 0;
  dom.querySelectorAll<HTMLElement>("[data-math-inline], [data-math-block]").forEach((el) => {
    const display = el.hasAttribute("data-math-block");
    const latex = el.getAttribute("data-latex") ?? "";
    try {
      el.innerHTML = katex.renderToString(latex, { displayMode: display, output: "mathml", throwOnError: false, strict: "ignore" });
    } catch {
      el.textContent = display ? `$$${latex}$$` : `$${latex}$`;
    }
    if (display && latex.trim() && el.getAttribute("data-numbered") !== "false") {
      const tag = dom.createElement("span");
      tag.className = "eq-number";
      tag.textContent = `(${++equationNumber})`;
      el.appendChild(tag);
    }
  });
  const css = [
    "body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.6;color:#1f1f1f;max-width:7.5in;margin:48px auto;padding:0 24px}",
    "h1,h2,h3,h4{line-height:1.25;margin:1.4em 0 .5em}",
    "p{margin:0 0 .9em}img{max-width:100%;height:auto}",
    "table{border-collapse:collapse;width:100%;margin:1em 0}th,td{border:1px solid #d0d0d0;padding:6px 10px;vertical-align:top;text-align:left}th{background:#f3f3f3}",
    "blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid #d0d0d0;color:#555}",
    "pre{background:#f6f8fa;padding:12px 14px;border-radius:6px;overflow:auto}code{font-family:Consolas,'Courier New',monospace;font-size:.92em}",
    "[data-math-block]{position:relative;text-align:center;margin:1em 0;padding:0 3.5em}[data-math-block] math{display:block}.eq-number{position:absolute;right:0;top:50%;transform:translateY(-50%)}",
    "a{color:#1a56db}[data-page-break]{break-after:page}hr{border:0;border-top:1px solid #d0d0d0;margin:1.5em 0}",
  ].join("");
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title || "Document")}</title>\n<style>${css}</style>\n</head>\n<body>\n${dom.body.innerHTML}\n</body>\n</html>\n`;
}

const RULER_STORAGE_KEY = "briefcast.docs.showRuler";
// Height of the sticky ruler bar: the ruler plus its pt-1.5 / pb-2 padding.
const RULER_BAR_PX = RULER_SIZE + 6 + 8;

function readRulerVisible(): boolean {
  try {
    return localStorage.getItem(RULER_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

const headerIconClass = (active = false) =>
  `relative h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full transition-colors ${
    active
      ? "bg-[#d3e3fd] text-[#041e49] dark:bg-blue-500/30 dark:text-blue-50"
      : "text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.06] dark:hover:bg-white/10"
  }`;

const DocsEditor: React.FC<DocsEditorProps> = ({ docId, onBack, libraryFiles, onOpenLinkedFile }) => {
  const store = useDocsEditStore(docId);
  const [linkOpen, setLinkOpen] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<"export" | "pageSetup" | "linkFile" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [showComments, setShowComments] = useState(false);

  const menuProps = (id: "export" | "pageSetup" | "linkFile") => ({
    open: headerMenu === id,
    onOpenChange: (next: boolean) => setHeaderMenu((cur) => (next ? id : cur === id ? null : cur)),
  });

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
        DocDictation,
        DocPaint,
        DocShortcuts,
        Placeholder.configure({ placeholder: "Start writing, type “/” for blocks, or press Ctrl+Shift+S to dictate…" }),
      ],
      editable: !store.loading,
      // Focuses the content area as soon as the doc is ready, so opening a doc (new or existing)
      // lets you start typing immediately instead of requiring a click into the editor first.
      autofocus: "start",
      // Auto-fills the title from the first line typed/pasted, but only while the title is still
      // an untouched default - self-limiting, since setTitle moves it off that pattern and the
      // guard below then no-ops on every later keystroke. A blank/whitespace-only title also counts
      // as default, so a doc whose title was cleared by hand still gets one.
      onUpdate: ({ editor: e }) => {
        const isDefaultTitle = store.title.trim() === "" || /^Untitled document \d+$/.test(store.title);
        if (!isDefaultTitle) return;
        // The first textblock's own text, not getText()'s first line - inline nodes inside one
        // block (links, images) otherwise run together with the next block's text.
        let firstLine = "";
        e.state.doc.descendants((node) => {
          if (firstLine) return false;
          if (node.isTextblock) {
            firstLine = node.textContent.trim();
            return false;
          }
          return true;
        });
        if (!firstLine) return;
        store.setTitle(firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine);
      },
    },
    [store.ydoc]
  );

  const dictation = useDocDictation(editor && !store.loading ? editor : null, store.title);

  const pageSize = store.pageSize ?? "letter";
  const margins = resolveMargins(store.margins);
  const [rulerUnit, setRulerUnit] = useRulerUnit();
  const [rulerVisible, setRulerVisible] = useState(readRulerVisible);
  const toggleRuler = useCallback(() => {
    setRulerVisible((v) => {
      try {
        localStorage.setItem(RULER_STORAGE_KEY, v ? "0" : "1");
      } catch {
        // per-viewer convenience only
      }
      return !v;
    });
  }, []);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  // Visible size of the page scroller - how far the rulers' drag guide lines reach.
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFrameSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [store.loading]);

  // Meta-only transaction, not an editor recreation - changing page size or margins shouldn't
  // disturb cursor position or the Collaboration binding; docAutoPaginate.ts's plugin `update()`
  // recomputes on it (a top/bottom margin change doesn't resize view.dom, so its ResizeObserver
  // wouldn't notice on its own).
  useEffect(() => {
    if (!editor) return;
    editor.commands.setPaginationLayout(pageSize, margins);
  }, [editor, pageSize, margins]);

  const handleBack = useCallback(() => {
    dictation.stop();
    store.flushSave().catch((err) => console.error("Failed to save before navigating back:", err));
    onBack();
  }, [store, onBack, dictation]);

  const noticeTimerRef = useRef<number | null>(null);
  const showNotice = useCallback((next: Notice, ms: number) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice(next);
    noticeTimerRef.current = ms > 0 ? window.setTimeout(() => setNotice(null), ms) : null;
  }, []);
  useEffect(() => () => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
  }, []);

  const handlePrint = useCallback(() => {
    setHeaderMenu(null);
    // Chrome/Edge's print dialog derives both its default "Save as PDF" filename and the printed
    // page's header text from document.title - otherwise index.html's static app-wide value.
    // Swap it in just for the dialog, restoring it on afterprint (fires on print or cancel).
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

  // The mark is applied first (crypto.randomUUID() as its own commentId) so the anchor exists in
  // the doc even if the add_doc_comment invoke below fails - a comment record with no mark would be
  // useless, but a mark with no record is at worst an inert highlight, cleaned up the next time
  // anyone tries to delete it (unsetComment no-ops harmlessly if the backend record never landed).
  const submitComment = useCallback(
    async (text: string) => {
      if (!editor || editor.state.selection.empty) return;
      const markId = crypto.randomUUID();
      editor.chain().focus().setComment(markId).run();
      const comment = await store.addComment(markId, text);
      if (comment) setShowComments(true);
    },
    [editor, store]
  );

  // Deleting a comment also strips its mark from wherever it currently sits in the doc, so a
  // deleted comment never leaves an orphaned highlight behind.
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

  // Toolbar-driven counterpart to docImagePaste.ts's paste/drop handling.
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

  // Every format goes through a real Save dialog now - exports used to land silently in the
  // Briefcast folder under a timestamped name with only an "Exported" flash, so finding the file
  // meant going looking for it. The result line then offers Open / Show in folder.
  const handleExport = useCallback(
    async (kind: ExportKind) => {
      if (!editor) return;
      setHeaderMenu(null);
      const format = EXPORT_FORMATS[kind];
      const outputPath = await saveFileDialog({
        defaultPath: `${exportBaseName(store.title)}.${kind}`,
        filters: [{ name: format.name, extensions: [kind] }],
      }).catch(() => null);
      if (!outputPath) return; // cancelled
      showNotice({ text: `Exporting ${format.short}…` }, 0);
      try {
        let saved: string;
        if (kind === "pdf") {
          saved = await invoke<string>("export_doc_pdf", { docTitle: store.title, pageSize: store.pageSize, outputPath });
        } else if (kind === "docx") {
          const bytes = await buildDocxBytes(editor.getJSON(), store.title, {
            comments: store.comments,
            pageSize: store.pageSize,
            headerText: store.headerText,
            footerText: store.footerText,
            margins: store.margins,
          });
          saved = await invoke<string>("export_doc_binary", { docTitle: store.title, extension: "docx", bytes: Array.from(bytes), outputPath });
        } else {
          const content =
            kind === "md"
              ? docJsonToMarkdown(editor.getJSON(), store.comments)
              : kind === "html"
                ? await buildStandaloneHtml(store.title, editor.getHTML())
                : editor.getText({ blockSeparator: "\n\n" });
          saved = await invoke<string>("export_doc", { docTitle: store.title, extension: kind, content, outputPath });
        }
        showNotice({ text: `Saved ${saved.split(/[\\/]/).pop()}`, path: saved }, 10000);
      } catch (err) {
        console.error(`Failed to export document as .${kind}:`, err);
        showNotice({ text: err instanceof Error ? err.message : String(err), error: true }, 8000);
      }
    },
    [editor, store.title, store.comments, store.pageSize, store.headerText, store.footerText, store.margins, showNotice]
  );

  const handleSaveNow = useCallback(async () => {
    try {
      await store.flushSave();
      showNotice({ text: "All changes saved" }, 2000);
    } catch (err) {
      showNotice({ text: err instanceof Error ? err.message : String(err), error: true }, 6000);
    }
  }, [store, showNotice]);

  // Recomputed per doc change, not per render - the editor re-renders this component on every
  // transaction, including selection-only ones that can't change the counts.
  const { wordCount, charCount } = useMemo(() => {
    if (!editor) return { wordCount: 0, charCount: 0 };
    const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, " ", " ");
    const trimmed = text.trim();
    return { wordCount: trimmed ? trimmed.split(/\s+/).length : 0, charCount: text.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, editor?.state.doc]);

  const openComments = store.comments.filter((c) => !c.resolved_at).length;
  const linkedFile = useMemo(() => libraryFiles.find((f) => f.path === store.linkedTo), [libraryFiles, store.linkedTo]);
  const filteredLibraryFiles = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    if (!q) return libraryFiles;
    return libraryFiles.filter((f) => f.name.toLowerCase().includes(q));
  }, [libraryFiles, fileFilter]);

  const statusNotice: Notice | null = dictation.message ? { text: dictation.message } : notice;
  const showRuler = rulerVisible && !store.loading && !store.loadError;
  const pageCount = editor ? getPaginationPageCount(editor.state) : 1;

  return (
    <div
      className="w-full h-full flex flex-col bg-[var(--doc-canvas)] [--doc-canvas:#f9fbfd] dark:[--doc-canvas:#0a0a0a] print:bg-white print:h-auto print:block"
      // App-level shortcuts captured at this wrapper (rather than as Tiptap keyboard shortcuts)
      // because they open UI this component owns and should work with focus on the toolbar too.
      onKeyDownCapture={(e) => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
          e.preventDefault();
          setShowFindReplace(true);
        } else if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
          e.preventDefault();
          setLinkOpen((v) => !v);
        } else if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
          e.preventDefault();
          handlePrint();
        } else if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
          // Saving is automatic, but Ctrl+S is reflex - flush now and say so instead of letting
          // the WebView open its own "save page as" dialog.
          e.preventDefault();
          void handleSaveNow();
        } else if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
          // Google Docs' voice typing shortcut (Tiptap's own Mod-Shift-s strike is on Alt+Shift+5).
          e.preventDefault();
          e.stopPropagation();
          dictation.toggle();
        }
      }}
    >
      {/* Paper size for Print and Download PDF. Page margin is 0 on purpose: with no margin there is
          nowhere for Chromium to stamp its own date/title/URL header and footer. The doc's margins
          come from the print frame around the page instead (top/bottom: its repeating thead/tfoot
          spacer rows, docPageLayout.css; left/right: the card's print padding below). The card's
          width/padding are a real stylesheet rule (not inline style) so the `@media print`
          override can win - inline style beats any class regardless of media query. On screen the
          card is one sheet tall at minimum; docAutoPaginate.ts pads the last page to full height. */}
      <style>{`
        @page { size: ${PAGE_DIMENSIONS_IN[pageSize].cssSize}; margin: 0; }
        .doc-page-card { max-width: ${pageWidthPx(pageSize)}px; padding: ${margins.top}in ${margins.right}in ${margins.bottom}in ${margins.left}in; min-height: ${pageHeightPx(pageSize)}px; }
        @media print {
          .doc-page-card { max-width: none; padding: 0 ${margins.right}in 0 ${margins.left}in; min-height: 0; }
        }
      `}</style>

      {/* Repeating header/footer: hidden on screen, shown only for print. `position: fixed` makes an
          element repeat on every printed page in Chromium - the only reliable way to get repeating
          page chrome out of a print engine with no margin-box content support. */}
      {store.headerText && (
        <div
          className="doc-print-keep hidden print:block fixed text-xs text-neutral-500 -translate-y-1/2"
          style={{ top: `${margins.top / 2}in`, left: `${margins.left}in`, right: `${margins.right}in` }}
        >
          {store.headerText}
        </div>
      )}
      {store.footerText && (
        <div
          className="doc-print-keep hidden print:block fixed text-xs text-neutral-500 translate-y-1/2"
          style={{ bottom: `${margins.bottom / 2}in`, left: `${margins.left}in`, right: `${margins.right}in` }}
        >
          {store.footerText}
        </div>
      )}

      <header className="shrink-0 flex items-center gap-2 pl-2 pr-3 pt-2 print:hidden">
        <button type="button" onClick={handleBack} data-tip="Back to docs" aria-label="Back to docs" className={headerIconClass()}>
          <IoArrowBack size={19} />
        </button>
        <MdDescription size={30} className="shrink-0 text-[#4285f4]" aria-hidden />

        <div className="min-w-0 flex-1 flex flex-col">
          <input
            value={store.title}
            onChange={(e) => store.setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                editor?.commands.focus();
              }
            }}
            placeholder="Untitled document"
            aria-label="Document title"
            spellCheck={false}
            style={{ fieldSizing: "content" } as React.CSSProperties}
            className="min-w-[8rem] max-w-full px-1.5 -ml-1.5 h-7 rounded text-[17px] leading-7 bg-transparent border border-transparent hover:border-neutral-300 dark:hover:border-neutral-700 focus:border-blue-500 outline-none text-neutral-900 dark:text-neutral-100 truncate"
          />
          <div className="flex items-center gap-2 h-5 text-xs text-neutral-500 dark:text-neutral-400 min-w-0">
            {store.saveError ? (
              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400" data-tip={String(store.saveError)}>
                <IoWarningOutline size={14} /> Couldn’t save
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 shrink-0">
                <IoCloudDoneOutline size={14} /> {store.isSaving ? "Saving…" : "Saved"}
              </span>
            )}
            {editor && !store.loading && (
              <span className="shrink-0" data-tip={`${charCount.toLocaleString()} characters`}>
                · {wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"}
                {pageCount > 1 && ` · ${pageCount} pages`}
              </span>
            )}
            {linkedFile && (
              <span className="inline-flex items-center gap-1 min-w-0">
                ·
                <button
                  type="button"
                  data-tip="Open linked recording"
                  onClick={() => onOpenLinkedFile?.(linkedFile.path, linkedFile.name)}
                  className="inline-flex items-center gap-1 min-w-0 hover:text-blue-600 dark:hover:text-blue-400"
                >
                  <MdInsertLink size={14} className="shrink-0" />
                  <span className="truncate max-w-[14rem]">{linkedFile.name}</span>
                </button>
                <button
                  type="button"
                  data-tip="Unlink recording"
                  aria-label="Unlink recording"
                  onClick={() => void store.unlinkDoc()}
                  className="p-0.5 rounded hover:bg-black/[0.06] dark:hover:bg-white/10 hover:text-red-500"
                >
                  <IoClose size={12} />
                </button>
              </span>
            )}
            {statusNotice && (
              <span className={`inline-flex items-center gap-1.5 min-w-0 ${statusNotice.error ? "text-red-600 dark:text-red-400" : "text-blue-700 dark:text-blue-300"}`}>
                <span className="truncate">· {statusNotice.text}</span>
                {statusNotice.path && (
                  <>
                    <button
                      type="button"
                      onClick={() => void invoke("open_file_with_default_app", { filepath: statusNotice.path })}
                      className="shrink-0 font-medium underline-offset-2 hover:underline"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => void invoke("open_file_from_directory", { filepath: statusNotice.path })}
                      className="shrink-0 font-medium underline-offset-2 hover:underline"
                    >
                      Show in folder
                    </button>
                  </>
                )}
              </span>
            )}
          </div>
        </div>

        <button type="button" data-tip="Find and replace" data-tip-kbd="Ctrl+F" aria-label="Find and replace" onClick={() => setShowFindReplace((v) => !v)} className={headerIconClass(showFindReplace)}>
          <IoSearch size={18} />
        </button>
        <button
          type="button"
          data-tip="Version history"
          aria-label="Version history"
          onClick={() => {
            store.refreshVersions();
            setShowVersionHistory(true);
          }}
          className={headerIconClass(showVersionHistory)}
        >
          <IoTimeOutline size={20} />
        </button>
        <button type="button" data-tip="Comments" aria-label="Comments" onClick={() => setShowComments((v) => !v)} className={headerIconClass(showComments)}>
          <IoChatbubbleOutline size={19} />
          {openComments > 0 && (
            <span className="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-blue-600 text-white text-[10px] leading-4 font-semibold text-center">
              {openComments}
            </span>
          )}
        </button>
        {!store.linkedTo && (
          <Dropdown
            {...menuProps("linkFile")}
            label="Link to a recording"
            align="right"
            keepSelection={false}
            trigger={<MdInsertLink size={20} />}
            triggerClassName={headerIconClass(headerMenu === "linkFile")}
            panelClassName="w-64 p-1.5"
          >
            <input
              autoFocus
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
              placeholder="Filter recordings…"
              className="w-full mb-1 px-2 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100"
            />
            <div className="max-h-60 overflow-y-auto">
              {filteredLibraryFiles.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-neutral-400 dark:text-neutral-500">No matching files</p>
              ) : (
                filteredLibraryFiles.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => {
                      void store.linkDoc(f.path);
                      setHeaderMenu(null);
                      setFileFilter("");
                    }}
                    className={`${menuItemClass} rounded-md truncate`}
                  >
                    <span className="truncate">{f.name}</span>
                  </button>
                ))
              )}
            </div>
          </Dropdown>
        )}
        <Dropdown
          {...menuProps("pageSetup")}
          label="Page setup"
          align="right"
          keepSelection={false}
          bare
          trigger={<IoOptionsOutline size={19} />}
          triggerClassName={headerIconClass(headerMenu === "pageSetup")}
        >
          <DocPageSetupPopover
            pageSize={store.pageSize}
            headerText={store.headerText}
            footerText={store.footerText}
            margins={store.margins}
            unit={rulerUnit}
            onApply={(patch) => void store.setPageSetup(patch)}
            onClose={() => setHeaderMenu(null)}
          />
        </Dropdown>

        <Dropdown
          {...menuProps("export")}
          label="Export"
          align="right"
          trigger={
            <>
              <MdFileDownload size={18} />
              <span>Export</span>
              <MdArrowDropDown size={18} className="-mr-1.5" />
            </>
          }
          triggerClassName="ml-1 h-9 pl-3.5 pr-3 inline-flex items-center gap-1.5 rounded-full text-sm font-medium bg-[#c2e7ff] hover:bg-[#b0dcf7] text-[#001d35] dark:bg-blue-500/25 dark:hover:bg-blue-500/35 dark:text-blue-50 transition-colors"
          panelClassName="w-64 py-1.5"
        >
          <div className="px-3 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Download as</div>
          {(Object.keys(EXPORT_FORMATS) as ExportKind[]).map((kind) => {
            const { label, icon: Icon } = EXPORT_FORMATS[kind];
            return (
              <button key={kind} type="button" onClick={() => void handleExport(kind)} className={menuItemClass}>
                <Icon size={17} className="shrink-0 text-neutral-500 dark:text-neutral-400" />
                {label}
              </button>
            );
          })}
          <div className="my-1.5 h-px bg-neutral-200 dark:bg-neutral-700" />
          <button type="button" onClick={handlePrint} className={menuItemClass}>
            <MdPrint size={18} className="shrink-0 text-neutral-500 dark:text-neutral-400" />
            <span className="flex-1">Print…</span>
            <span className="text-xs text-neutral-400">Ctrl+P</span>
          </button>
        </Dropdown>
      </header>

      {editor && !store.loading && (
        <DocToolbar
          editor={editor}
          dictation={dictation}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
          onInsertImage={() => void handleInsertImage()}
          onAddComment={(text) => void submitComment(text)}
          rulerVisible={rulerVisible}
          onToggleRuler={toggleRuler}
        />
      )}

      {editor && showFindReplace && <DocFindReplaceBar editor={editor} onClose={() => setShowFindReplace(false)} />}

      <div className="flex-1 min-h-0 flex border-t border-neutral-200 dark:border-neutral-800 print:block print:border-0">
        {/* print:overflow-visible/h-auto/block - without these, this flex/overflow-auto box (built
            for on-screen scrolling) clips the document to the viewport instead of flowing across
            printed pages. */}
        <div className="relative flex-1 min-w-0 min-h-0 flex flex-col print:block">
        <div
          ref={scrollerRef}
          className={`flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 pb-10 ${showRuler ? "" : "pt-6"} bg-[var(--doc-canvas)] print:h-auto print:overflow-visible print:block print:p-0 print:bg-white`}
        >
          {showRuler && editor && (
            // Sticky inside the scroller and exactly as wide as the page card, so ruler positions
            // line up with the page at any window width.
            <div className="sticky top-0 z-20 -mx-4 sm:-mx-8 px-4 sm:px-8 pt-1.5 pb-2 mb-2 bg-[var(--doc-canvas)] print:hidden">
              <div className="mx-auto" style={{ maxWidth: pageWidthPx(pageSize) }}>
                <DocHorizontalRuler
                  editor={editor}
                  pageSize={pageSize}
                  margins={margins}
                  unit={rulerUnit}
                  onUnitChange={setRulerUnit}
                  onMarginsChange={(m) => void store.setPageSetup({ margins: m })}
                  onOpenPageSetup={() => setHeaderMenu("pageSetup")}
                  pageRef={pageRef}
                  guideLengthPx={Math.max(0, frameSize.height - RULER_BAR_PX)}
                />
              </div>
            </div>
          )}
          {store.loading || !editor ? (
            <div className="flex items-center justify-center h-full text-neutral-400 dark:text-neutral-500 text-sm">Loading…</div>
          ) : store.loadError ? (
            <div className="flex items-center justify-center h-full text-red-500 dark:text-red-400 text-sm">{store.loadError}</div>
          ) : (
            // The "page": a bounded card on the backdrop, square-cornered like a printed page (and
            // like docAutoPaginate.ts's flat page-gap dividers). Width and padding - the exact real
            // 1in print margin, which docAutoPaginate.ts measures against - come from the
            // `.doc-page-card` rule injected above.
            // Print frame: see the <style> comment above and docPageLayout.css. On screen the table
            // collapses to plain blocks.
            <table className="doc-print-frame">
              <thead aria-hidden>
                <tr>
                  <td>
                    <div className="doc-print-spacer" style={{ height: `${margins.top}in` }} />
                  </td>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <div ref={pageRef} className="doc-page-card mx-auto bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-[0_1px_3px_rgba(60,64,67,0.15)] print:shadow-none print:ring-0 print:mx-0 print:min-h-0">
                      <EditorContent editor={editor} className={docProseClassName} />
                    </div>
                  </td>
                </tr>
              </tbody>
              <tfoot aria-hidden>
                <tr>
                  <td>
                    <div className="doc-print-spacer" style={{ height: `${margins.bottom}in` }} />
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
        {showRuler && (
          <div className="hidden sm:block print:hidden">
            <DocVerticalRuler
              pageSize={pageSize}
              margins={margins}
              unit={rulerUnit}
              onMarginsChange={(m) => void store.setPageSetup({ margins: m })}
              onOpenPageSetup={() => setHeaderMenu("pageSetup")}
              scrollerRef={scrollerRef}
              pageRef={pageRef}
              topInset={RULER_BAR_PX}
              guideLengthPx={frameSize.width}
            />
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
        <DocVersionHistoryPanel docId={docId} versions={store.versions} onClose={() => setShowVersionHistory(false)} onRestore={store.restoreVersion} />
      )}
    </div>
  );
};

export default DocsEditor;
