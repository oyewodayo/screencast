// components/docs/DocsEditor.tsx
//
// Top-level Docs editing surface - the Docs feature's counterpart to BoardEditor.tsx. Owns the
// useDocsEditStore instance and the Tiptap editor bound to its Y.Doc via @tiptap/extension-
// collaboration. Layout follows Google Docs: a title row carrying the doc-level actions (find,
// comments, history, page setup, export), one formatting bar (DocToolbar.tsx), and the page.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { Extension } from "@tiptap/core";
import { useEditor, EditorContent } from "@tiptap/react";
import katex from "katex";
import Collaboration from "@tiptap/extension-collaboration";
import Placeholder from "@tiptap/extension-placeholder";
import { IoArrowBack, IoChatbubbleOutline, IoHelpCircleOutline, IoClose, IoCloudDoneOutline, IoOptionsOutline, IoSearch, IoTimeOutline, IoWarningOutline } from "react-icons/io5";
import { MdArrowDropDown, MdDescription, MdFileDownload, MdInsertLink, MdPrint } from "react-icons/md";
import { TbBooks, TbListTree, TbTypography } from "react-icons/tb";
import DocHelpPanel from "./DocHelpPanel";
import DocStyleDialog from "./DocStyleDialog";
import { PAPER_STYLES } from "../../utils/docPaperStyles";
import { BsFiletypeDocx, BsFiletypeHtml, BsFiletypeMd, BsFiletypePdf, BsFiletypeTxt } from "react-icons/bs";
import useDocsEditStore from "../../hooks/useDocsEditStore";
import useDocDictation from "../../hooks/useDocDictation";
import useBibliography from "../../hooks/useBibliography";
import useDocFonts from "../../hooks/useDocFonts";
import useDocLayout from "../../hooks/useDocLayout";
import { bodyStyleVars, writeLayout } from "../../utils/docLayout";
import { DEFAULT_NUMBERING } from "../../utils/docNumbering";
import { addFontFilesToDocument } from "../../utils/docFonts";
import { docJsonToMarkdown } from "../../utils/docMarkdown";
import { buildDocxBytes } from "../../utils/docDocx";
import { LibraryFileEntry } from "../../utils/docTypes";
import { createDocImagePasteExtension, uploadImageFromPath } from "../../utils/docImagePaste";
import { createSlashCommandExtension } from "../../utils/docSlashCommand";
import DocFindReplace from "../../utils/docFindReplace";
import DocDictation from "../../utils/docDictationExtension";
import DocPaint from "../../utils/docPaintExtension";
import { getDocContentExtensions, docProseClassName } from "../../utils/docSchemaExtensions";
import { captionLabel, crossRefText, computeStructureFromJson, createDocStructureExtension, getDocStructure, type DocStructure } from "../../utils/docStructure";
import { citationSpaceBefore, formatCitation, styleInfo, segmentsToText } from "../../utils/docCitationStyles";
import { CITATION_EDIT_EVENT, CROSSREF_EDIT_EVENT, OPEN_PICKER_EVENT, type InlineEditDetail, type OpenPickerDetail } from "../../utils/docStructureNodes";
import DocVersionHistoryPanel from "./DocVersionHistoryPanel";
import DocReferencesSidebar from "./DocReferencesSidebar";
import DocOutlinePanel from "./DocOutlinePanel";
import DocCitePicker, { type CitePickerMode } from "./DocCitePicker";
import DocCrossRefPicker, { type CrossRefPickerMode } from "./DocCrossRefPicker";
import DocFindReplaceBar from "./DocFindReplaceBar";
import DocCommentsSidebar from "./DocCommentsSidebar";
import DocPageSetupPopover from "./DocPageSetupPopover";
import DocToolbar, { Dropdown, menuItemClass } from "./DocToolbar";
import DocAutoPaginate, { columnRowGapPx, getPaginationPageCount, pageAtPos } from "../../utils/docAutoPaginate";
import { PAGE_DIMENSIONS_IN, PAGE_GAP_PX, pageContentHeightPx, pageHeightPx, pageWidthPx, resolveMargins } from "../../utils/docPageGeometry";
import { DocHorizontalRuler, DocVerticalRuler, RULER_SIZE, useRulerUnit } from "./DocRuler";
import "./docCodeHighlight.css";
import "./docFindReplace.css";
import "./docComments.css";
import "./docPageLayout.css";
import "./docLinks.css";
import "./docDictation.css";
import "./docPaint.css";
import "./docStructure.css";
import "./docFonts.css";
import "./docLayout.css";
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
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

async function buildStandaloneHtml(title: string, bodyHtml: string, structure: DocStructure | null): Promise<string> {
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
  // Captions get their "Figure 2." label and an anchor; cross-references become links to it;
  // citations get their formatted text.
  const captionCounts = { figure: 0, table: 0 };
  dom.querySelectorAll<HTMLElement>("[data-caption]").forEach((el) => {
    const kind = el.getAttribute("data-caption") === "table" ? "table" : "figure";
    const label = dom.createElement("strong");
    const numbering = structure?.numbering ?? DEFAULT_NUMBERING;
    const index = captionCounts[kind]++;
    label.textContent = `${structure?.captionLabels[kind][index] ?? captionLabel(kind, index + 1, numbering)}${numbering.captionSeparator}`;
    el.prepend(label, "\u00a0 ");
    const id = el.getAttribute("data-caption-id");
    if (id) el.id = id;
  });
  dom.querySelectorAll<HTMLElement>("[data-math-block][data-id]").forEach((el) => {
    el.id = el.getAttribute("data-id") ?? "";
  });
  dom.querySelectorAll<HTMLElement>("[data-xref]").forEach((el) => {
    const id = el.getAttribute("data-xref") ?? "";
    const target = structure?.targets.get(id);
    if (!target) {
      el.textContent = "??";
      return;
    }
    const a = dom.createElement("a");
    a.href = `#${id}`;
    a.textContent = crossRefText(target, el.getAttribute("data-xref-form") === "number" ? "number" : "label");
    el.replaceChildren(a);
  });
  dom.querySelectorAll<HTMLElement>("[data-cite]").forEach((el) => {
    const refIds = (el.getAttribute("data-cite") ?? "").split(",").filter(Boolean);
    const cite = structure ? formatCitation(refIds, el.getAttribute("data-locator"), structure.lookup, structure.context) : null;
    el.textContent = "";
    const previous = el.previousSibling?.textContent ?? "";
    const space = citationSpaceBefore(el.previousSibling ? previous.slice(-1) || "x" : "", !!cite?.superscript);
    if (cite?.superscript) el.appendChild(dom.createElement("sup")).textContent = cite.text;
    else el.textContent = space + (cite?.text ?? "[?]");
  });
  // Headings get ids (GitHub's slug rule, made unique) for the table of contents' links.
  const usedIds = new Set<string>();
  const headingEls = Array.from(dom.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
  headingEls.forEach((h) => {
    const base = slugify(h.textContent ?? "") || "section";
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    h.id = id;
  });
  dom.querySelectorAll<HTMLElement>("[data-toc]").forEach((el) => {
    const maxLevel = Number(el.getAttribute("data-max-level")) || 3;
    const entries = headingEls.filter((h) => Number(h.tagName[1]) <= maxLevel && h.textContent?.trim());
    const min = entries.reduce((m, h) => Math.min(m, Number(h.tagName[1])), 6);
    const nav = dom.createElement("nav");
    nav.className = "toc";
    nav.appendChild(dom.createElement("p")).textContent = "Contents";
    const list = nav.appendChild(dom.createElement("ol"));
    for (const h of entries) {
      const li = list.appendChild(dom.createElement("li"));
      li.style.paddingLeft = `${(Number(h.tagName[1]) - min) * 1.5}em`;
      const a = li.appendChild(dom.createElement("a"));
      a.href = `#${h.id}`;
      a.textContent = h.textContent ?? "";
    }
    el.replaceWith(nav);
  });
  dom.querySelectorAll<HTMLElement>("[data-bibliography]").forEach((el) => {
    const refs = structure?.bibliography ?? [];
    const list = dom.createElement("ol");
    list.className = structure && styleInfo(structure.style).numeric ? "references" : "references apa";
    for (const ref of refs) {
      const li = list.appendChild(dom.createElement("li"));
      if (ref.label) li.appendChild(dom.createElement("span")).textContent = ref.label;
      const body = li.appendChild(dom.createElement("div"));
      for (const seg of ref.segments) {
        let node: Node = dom.createTextNode(seg.text);
        if (seg.bold) node = Object.assign(dom.createElement("b"), { textContent: seg.text });
        if (seg.italic) {
          const i = dom.createElement("i");
          i.appendChild(node);
          node = i;
        }
        if (seg.link) {
          const a = dom.createElement("a");
          a.href = seg.link;
          a.appendChild(node);
          node = a;
        }
        body.appendChild(node);
      }
    }
    el.replaceWith(list);
  });
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
      tag.textContent = `(${structure?.equationLabels[equationNumber] ?? equationNumber + 1})`;
      equationNumber++;
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
    "[data-caption]{font-size:.92em;text-align:center;margin:.4em 0 1.2em}[data-caption=table]{text-align:left;margin:1.2em 0 .4em}",
    ".toc p{font-weight:600;font-size:1.1em;margin-bottom:.4em}.toc ol,.references{list-style:none;padding:0}.toc li{margin:.15em 0}",
    ".references li{display:grid;grid-template-columns:2.4em 1fr;gap:.35em;margin:.45em 0;font-size:.95em}.references li>span{text-align:right}",
    ".references.apa li{display:block;padding-left:.5in;text-indent:-.5in}.references a{color:inherit;text-decoration:none}",
    "[data-math-block]{position:relative;text-align:center;margin:1em 0;padding:0 3.5em}[data-math-block] math{display:block}.eq-number{position:absolute;right:0;top:50%;transform:translateY(-50%)}",
    "a{color:#1a56db}[data-page-break]{break-after:page}hr{border:0;border-top:1px solid #d0d0d0;margin:1.5em 0}",
  ].join("");
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title || "Document")}</title>\n<style>${css}</style>\n</head>\n<body>\n${dom.body.innerHTML}\n</body>\n</html>\n`;
}

const RULER_STORAGE_KEY = "briefcast.docs.showRuler";
const OUTLINE_STORAGE_KEY = "briefcast.docs.showOutline";

function readOutlineVisible(): boolean {
  try {
    return localStorage.getItem(OUTLINE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

// The citation / cross-reference picker floating over the page: opened from the toolbar, the
// slash menu, or by clicking an existing citation or reference (then in edit mode).
type FloatingPicker =
  | { kind: "cite"; mode: CitePickerMode; anchor: DOMRect }
  | { kind: "xref"; mode: CrossRefPickerMode; anchor: DOMRect };

const FloatingPanel: React.FC<{ anchor: DOMRect; onClose: () => void; children: React.ReactNode }> = ({ anchor, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Below the anchor, flipped above it near the bottom of the window; re-placed as the panel grows
  // (a pasted BibTeX entry, a lookup message) so it never runs off screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.min(Math.max(8, anchor.left), window.innerWidth - w - 8);
      const below = anchor.bottom + 6;
      const preferred = below + h > window.innerHeight - 8 ? anchor.top - h - 6 : below;
      // Always fully on screen, even when the anchor itself has scrolled out of view.
      const top = Math.min(Math.max(8, preferred), Math.max(8, window.innerHeight - h - 8));
      setPos((cur) => (cur && cur.left === left && cur.top === top ? cur : { left, top }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      className="fixed z-[60] bg-white dark:bg-neutral-800 rounded-xl border border-neutral-200/70 dark:border-neutral-700 shadow-[0_4px_16px_rgba(60,64,67,0.18),0_1px_3px_rgba(60,64,67,0.25)] print:hidden"
    >
      {children}
    </div>,
    document.body
  );
};
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
  const [showReferences, setShowReferences] = useState(false);
  // The two-column paper guide ("?") shares the right-hand slot with Comments and References.
  const [showHelp, setShowHelp] = useState(false);
  const [showStyle, setShowStyle] = useState(false);
  const [showOutline, setShowOutline] = useState(readOutlineVisible);
  const [picker, setPicker] = useState<FloatingPicker | null>(null);
  const bib = useBibliography(store.ydoc);
  const docFonts = useDocFonts(store.ydoc);
  const layout = useDocLayout(store.ydoc);
  const toggleOutline = useCallback(() => {
    setShowOutline((v) => {
      try {
        localStorage.setItem(OUTLINE_STORAGE_KEY, v ? "0" : "1");
      } catch {
        // per-viewer convenience only
      }
      return !v;
    });
  }, []);
  // Comments and References share the right-hand slot.
  const toggleComments = useCallback(() => {
    setShowReferences(false);
    setShowHelp(false);
    setShowComments((v) => !v);
  }, []);
  const toggleReferences = useCallback(() => {
    setShowComments(false);
    setShowHelp(false);
    setShowReferences((v) => !v);
  }, []);
  const toggleHelp = useCallback(() => {
    setShowComments(false);
    setShowReferences(false);
    setShowHelp((v) => !v);
  }, []);

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
        // Numbers figures, tables, equations and citations; formats the reference list.
        createDocStructureExtension(bib.store),
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

  const closePicker = useCallback(() => setPicker(null), []);
  const openPicker = useCallback((kind: "cite" | "xref", anchor: DOMRect) => {
    // A toolbar button collapsed into the More menu has no box; anchor at the cursor instead.
    if (editor && anchor.width === 0 && anchor.height === 0) {
      const c = editor.view.coordsAtPos(editor.state.selection.from);
      anchor = new DOMRect(c.left, c.top, 1, c.bottom - c.top);
    }
    setPicker(kind === "cite" ? { kind, mode: { kind: "insert" }, anchor } : { kind, mode: { kind: "insert" }, anchor });
  }, [editor]);
  // Clicking a citation or cross-reference in the text opens its editor; the slash menu opens the
  // insert pickers at the cursor. All arrive as DOM events from docStructureNodes.ts.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onCite = (e: Event) => {
      const { pos, rect } = (e as CustomEvent<InlineEditDetail>).detail;
      const node = editor.state.doc.nodeAt(pos);
      if (node?.type.name !== "citation") return;
      setPicker({ kind: "cite", mode: { kind: "edit", pos, refIds: [...(node.attrs.refIds as string[])], locator: (node.attrs.locator as string | null) ?? null }, anchor: rect });
    };
    const onXref = (e: Event) => {
      const { pos, rect } = (e as CustomEvent<InlineEditDetail>).detail;
      const node = editor.state.doc.nodeAt(pos);
      if (node?.type.name !== "crossRef") return;
      setPicker({ kind: "xref", mode: { kind: "edit", pos, targetId: (node.attrs.targetId as string | null) ?? null }, anchor: rect });
    };
    const onOpen = (e: Event) => {
      const { kind, rect } = (e as CustomEvent<OpenPickerDetail>).detail;
      openPicker(kind, rect);
    };
    dom.addEventListener(CITATION_EDIT_EVENT, onCite);
    dom.addEventListener(CROSSREF_EDIT_EVENT, onXref);
    dom.addEventListener(OPEN_PICKER_EVENT, onOpen);
    return () => {
      dom.removeEventListener(CITATION_EDIT_EVENT, onCite);
      dom.removeEventListener(CROSSREF_EDIT_EVENT, onXref);
      dom.removeEventListener(OPEN_PICKER_EVENT, onOpen);
    };
  }, [editor, openPicker]);

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
    editor.commands.setPaginationLayout(pageSize, margins, layout.columns);
  }, [editor, pageSize, margins, layout.columns]);

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
          const json = editor.getJSON();
          const live = getDocStructure(editor.state);
          const bytes = await buildDocxBytes(json, store.title, {
            structure: computeStructureFromJson(json, bib.store),
            headingPages: (live?.headings ?? []).map((h) => pageAtPos(editor.view, h.pos)),
            comments: store.comments,
            pageSize: store.pageSize,
            headerText: store.headerText,
            footerText: store.footerText,
            margins: store.margins,
          });
          saved = await invoke<string>("export_doc_binary", { docTitle: store.title, extension: "docx", bytes: Array.from(bytes), outputPath });
        } else {
          const json = editor.getJSON();
          const structure = computeStructureFromJson(json, bib.store);
          const content =
            kind === "md"
              ? docJsonToMarkdown(json, store.comments, structure)
              : kind === "html"
                ? await buildStandaloneHtml(store.title, editor.getHTML(), structure)
                : editor.getText({
                    blockSeparator: "\n\n",
                    // Generated blocks have no text of their own; write out what they show.
                    textSerializers: {
                      caption: ({ node }) => {
                        const kindName = node.attrs.kind === "table" ? "table" : "figure";
                        const n = structure.targets.get(String(node.attrs.id ?? ""))?.number;
                        return `${n ? captionLabel(kindName, n, structure.numbering) : ""}${structure.numbering.captionSeparator} ${node.textContent}`;
                      },
                      bibliography: () =>
                        structure.bibliography.map((ref) => `${ref.label ? `${ref.label} ` : ""}${segmentsToText(ref.segments)}`).join("\n"),
                      tableOfContents: ({ node }) =>
                        ["Contents", ...structure.headings.filter((h) => h.text && h.level <= Number(node.attrs.maxLevel ?? 3)).map((h) => `${"  ".repeat(h.level - 1)}${h.text}`)].join("\n"),
                    },
                  });
          saved = await invoke<string>("export_doc", { docTitle: store.title, extension: kind, content, outputPath });
        }
        showNotice({ text: `Saved ${saved.split(/[\\/]/).pop()}`, path: saved }, 10000);
      } catch (err) {
        console.error(`Failed to export document as .${kind}:`, err);
        showNotice({ text: err instanceof Error ? err.message : String(err), error: true }, 8000);
      }
    },
    [editor, store.title, store.comments, store.pageSize, store.headerText, store.footerText, store.margins, showNotice, bib.store]
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
  // A ready-made style (docPaperStyles.ts) in one step - also what the guide's button does.
  const applyPaperStyle = (id: (typeof PAPER_STYLES)[number]["id"]) => {
    const p = PAPER_STYLES.find((x) => x.id === id);
    if (!p || !store.ydoc || !bib.store) return;
    const bibStore = bib.store;
    store.ydoc.transact(() => {
      writeLayout(store.ydoc!, { columns: p.columns, columnGap: p.columnGap, body: p.body });
      bibStore.setNumbering(p.numbering);
      bibStore.setStyle(p.citationStyle);
    });
    void store.setPageSetup({ margins: p.margins });
  };
  const twoColumns = layout.columns === 2;
  // Page card classes and custom properties for the document's body style and columns
  // (docLayout.css).
  const cardClass = [layout.body ? "doc-typeset" : "", layout.body?.justify ? "doc-justify" : "", layout.body?.hyphenate ? "doc-hyphenate" : "", twoColumns ? "doc-cols-2" : ""]
    .filter(Boolean)
    .join(" ");
  const cardStyle = {
    ...bodyStyleVars(layout.body),
    ...(twoColumns
      ? {
          "--doc-col-gap": `${layout.columnGap}in`,
          "--doc-col-height": `${pageContentHeightPx(pageSize, margins)}px`,
          "--doc-row-gap": `${columnRowGapPx(margins)}px`,
          minHeight: pageCount * pageHeightPx(pageSize) + (pageCount - 1) * PAGE_GAP_PX,
          // A two-column page never narrows with the window (the view scrolls sideways instead):
          // its columns, page breaks and page count must be exactly the printed ones.
          minWidth: pageWidthPx(pageSize),
        }
      : {}),
  } as React.CSSProperties;

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

        <button type="button" data-tip={showOutline ? "Hide outline" : "Show outline"} aria-label="Document outline" aria-pressed={showOutline} onClick={toggleOutline} className={headerIconClass(showOutline)}>
          <TbListTree size={19} strokeWidth={1.75} />
        </button>
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
        <button type="button" data-tip="Document style: font, spacing, columns, captions" aria-label="Document style" aria-pressed={showStyle} onClick={() => setShowStyle(true)} className={headerIconClass(showStyle)}>
          <TbTypography size={20} strokeWidth={1.75} />
        </button>
        <button type="button" data-tip="References" aria-label="References" aria-pressed={showReferences} onClick={toggleReferences} className={headerIconClass(showReferences)}>
          <TbBooks size={20} strokeWidth={1.75} />
          {bib.entries.length > 0 && (
            <span className="absolute top-1 right-0.5 min-w-4 h-4 px-1 rounded-full bg-neutral-600 dark:bg-neutral-500 text-white text-[10px] leading-4 font-semibold text-center tabular-nums">
              {bib.entries.length}
            </span>
          )}
        </button>
        <button type="button" data-tip="Guide: writing a two-column paper" aria-label="Help: writing a two-column paper" aria-pressed={showHelp} onClick={toggleHelp} className={headerIconClass(showHelp)}>
          <IoHelpCircleOutline size={21} />
        </button>
        <button type="button" data-tip="Comments" aria-label="Comments" onClick={toggleComments} className={headerIconClass(showComments)}>
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
            columns={layout.columns}
            columnGap={layout.columnGap}
            onColumnsChange={(columns, columnGap) => store.ydoc && writeLayout(store.ydoc, { columns, columnGap })}
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
          onOpenPicker={openPicker}
          docFonts={docFonts}
          onAddFont={() => (store.ydoc ? addFontFilesToDocument(docId, store.ydoc) : Promise.resolve([]))}
          twoColumns={layout.columns === 2}
          typeset={!!layout.body}
        />
      )}

      {editor && showFindReplace && <DocFindReplaceBar editor={editor} onClose={() => setShowFindReplace(false)} />}

      <div className="flex-1 min-h-0 flex border-t border-neutral-200 dark:border-neutral-800 print:block print:border-0">
        {editor && showOutline && !store.loading && <DocOutlinePanel editor={editor} scrollerRef={scrollerRef} onClose={toggleOutline} />}
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
              <div className="mx-auto" style={{ maxWidth: pageWidthPx(pageSize), minWidth: layout.columns === 2 ? pageWidthPx(pageSize) : undefined }}>
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
                    <div
                      ref={pageRef}
                      lang="en"
                      style={cardStyle}
                      className={`doc-page-card ${cardClass} mx-auto bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-[0_1px_3px_rgba(60,64,67,0.15)] print:shadow-none print:ring-0 print:mx-0 print:min-h-0`}
                    >
                      {/* Two columns: one drawn sheet per page behind the multicol rows. */}
                      {twoColumns &&
                        Array.from({ length: pageCount }, (_, k) => (
                          <div key={k} className="doc-sheet" aria-hidden style={{ top: k * (pageHeightPx(pageSize) + PAGE_GAP_PX), height: pageHeightPx(pageSize) }} />
                        ))}
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
        {editor && showHelp && bib.store && (
          <DocHelpPanel
            isJournal={layout.columns === 2 && !!layout.body}
            onApplyJournal={() => applyPaperStyle("journal")}
            onOpenStyle={() => setShowStyle(true)}
            onClose={() => setShowHelp(false)}
          />
        )}
        {editor && showReferences && bib.store && (
          <DocReferencesSidebar editor={editor} store={bib.store} entries={bib.entries} style={bib.style} onClose={() => setShowReferences(false)} />
        )}
      </div>

      {editor && picker && bib.store && (
        <FloatingPanel key={`${picker.kind}:${picker.anchor.left}:${picker.anchor.top}`} anchor={picker.anchor} onClose={closePicker}>
          {picker.kind === "cite" ? (
            <DocCitePicker editor={editor} store={bib.store} entries={bib.entries} mode={picker.mode} onClose={closePicker} />
          ) : (
            <DocCrossRefPicker editor={editor} mode={picker.mode} onClose={closePicker} />
          )}
        </FloatingPanel>
      )}

      {showStyle && store.ydoc && bib.store && (
        <DocStyleDialog
          ydoc={store.ydoc}
          layout={layout}
          bib={bib.store}
          citationStyle={bib.style}
          docFonts={docFonts}
          onMargins={(m) => void store.setPageSetup({ margins: m })}
          onClose={() => setShowStyle(false)}
        />
      )}

      {showVersionHistory && (
        <DocVersionHistoryPanel docId={docId} versions={store.versions} onClose={() => setShowVersionHistory(false)} onRestore={store.restoreVersion} />
      )}
    </div>
  );
};

export default DocsEditor;
