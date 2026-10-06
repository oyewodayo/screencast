// components/docs/DocToolbar.tsx
//
// The Docs formatting toolbar - one Google-Docs-style rounded bar instead of the previous two
// loosely grouped rows. Order follows Docs' own: history | paragraph style | font | size | character
// formatting | colour | insert | paragraph layout | lists | clear | more ... dictation.
//
// Responsive by container query rather than wrapping: as the bar narrows, the lowest-priority
// groups disappear from the bar (`hidden @6xl:flex` etc.) and the matching section of the "More"
// menu appears (`@6xl:hidden`), so every command stays one click away at any width and the bar
// never wraps onto a second line.
//
// Every popover here goes through <Dropdown>, which closes on outside click and Escape - the old
// toolbar's popovers only closed via their own button or a global Escape handler, so clicking back
// into the document left them hanging open.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import {
  MdAdd,
  MdAddComment,
  MdArrowDropDown,
  MdCheck,
  MdCode,
  MdDataObject,
  MdFormatAlignCenter,
  MdFormatAlignJustify,
  MdFormatAlignLeft,
  MdFormatAlignRight,
  MdFormatBold,
  MdFormatClear,
  MdFormatColorText,
  MdFormatIndentDecrease,
  MdFormatIndentIncrease,
  MdFormatItalic,
  MdFormatLineSpacing,
  MdFormatListBulleted,
  MdFormatListNumbered,
  MdFormatQuote,
  MdFormatUnderlined,
  MdHorizontalRule,
  MdImage,
  MdInsertPageBreak,
  MdLink,
  MdLinkOff,
  MdMic,
  MdMoreVert,
  MdRedo,
  MdRemove,
  MdStop,
  MdStraighten,
  MdStrikethroughS,
  MdSubscript,
  MdSuperscript,
  MdTitle,
  MdUndo,
} from "react-icons/md";
import { BiHighlight } from "react-icons/bi";
import { TbBooks, TbCornerDownRight, TbListDetails, TbMath, TbMathFunction, TbPhoto, TbQuote, TbTable, TbTableOptions } from "react-icons/tb";
import DocColorPicker from "./DocColorPicker";
import { DICTATION_LANGUAGES, DocDictation } from "../../hooks/useDocDictation";
import { PaintKind, getPaintState } from "../../utils/docPaintExtension";
import { markKeyHandled } from "../../utils/keyEvents";

// Classic web-safe fonts (what .docx documents and Word itself most commonly use, for import/export
// fidelity) plus a handful of modern ones self-hosted via boardFonts.css - renders the same on
// every machine. Bebas Neue is left out: a display-only all-caps face doesn't suit document prose.
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

// Google Docs' own size ladder for the -/+ buttons.
const FONT_SIZE_STEPS = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];

const PARAGRAPH_STYLES = [
  { value: "p", label: "Normal text", className: "text-sm" },
  { value: "1", label: "Heading 1", className: "text-2xl font-bold" },
  { value: "2", label: "Heading 2", className: "text-xl font-semibold" },
  { value: "3", label: "Heading 3", className: "text-lg font-semibold" },
  { value: "4", label: "Heading 4", className: "text-base font-semibold" },
] as const;

const LINE_SPACINGS = [
  { value: 1, label: "Single" },
  { value: 1.15, label: "1.15" },
  { value: 1.5, label: "1.5" },
  { value: 2, label: "Double" },
];

const ALIGNMENTS = [
  { value: "left", label: "Left align", icon: MdFormatAlignLeft, keys: "Ctrl+Shift+L" },
  { value: "center", label: "Center align", icon: MdFormatAlignCenter, keys: "Ctrl+Shift+E" },
  { value: "right", label: "Right align", icon: MdFormatAlignRight, keys: "Ctrl+Shift+R" },
  { value: "justify", label: "Justify", icon: MdFormatAlignJustify, keys: "Ctrl+Shift+J" },
] as const;

const VOICE_COMMANDS: [string, string][] = [
  ["“new line” / “new paragraph”", "Line or paragraph break"],
  ["“comma”, “period”, “question mark”", "Punctuation"],
  ["“open quote” … “close quote”", "Quotation marks"],
  ["“scratch that”", "Delete the last phrase"],
  ["“bullet list” / “numbered list”", "Start a list"],
  ["“heading one” … “normal text”", "Paragraph style"],
  ["“stop dictation”", "Stop listening"],
];

// ---------------------------------------------------------------------------------------------
// Primitives

const buttonBase =
  "h-7 min-w-7 px-1 inline-flex items-center justify-center gap-0.5 rounded text-neutral-700 dark:text-neutral-200 transition-colors select-none";

export function toolClass(active = false, disabled = false): string {
  if (disabled) return `${buttonBase} opacity-35 cursor-default`;
  return `${buttonBase} ${
    active ? "bg-[#d3e3fd] text-[#041e49] dark:bg-blue-500/30 dark:text-blue-50" : "hover:bg-black/[0.06] dark:hover:bg-white/10"
  }`;
}

const menuPanelClass =
  "absolute top-full mt-1 z-30 bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200/70 dark:border-neutral-700 shadow-[0_2px_6px_2px_rgba(60,64,67,0.15),0_1px_2px_rgba(60,64,67,0.3)]";

export const menuItemClass =
  "w-full flex items-center gap-3 px-3 py-1.5 text-sm text-left text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/70 disabled:opacity-40 disabled:hover:bg-transparent";

const Divider: React.FC<{ className?: string }> = ({ className = "" }) => (
  <div className={`w-px h-5 bg-neutral-300 dark:bg-neutral-600 mx-1 shrink-0 ${className}`} />
);

interface ToolButtonProps {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}

// Props for TooltipLayer's styled tooltips (data-tip) instead of the native `title` one. A shortcut
// given separately, or written at the end of the label as "(Ctrl+K)", shows as key caps.
export function tipProps(label: string, shortcut?: string): { "data-tip": string; "data-tip-kbd"?: string } {
  const m = shortcut ? null : label.match(/^(.*?)\s*\(((?:Ctrl|Alt|Shift|Esc)[^)]*)\)$/);
  const text = m ? m[1] : label;
  const kbd = shortcut ?? m?.[2];
  return kbd ? { "data-tip": text, "data-tip-kbd": kbd } : { "data-tip": text };
}

// onMouseDown preventDefault keeps the editor's selection (and focus) while clicking a tool.
const ToolButton: React.FC<ToolButtonProps> = ({ label, shortcut, active, disabled, onClick, children, className = "" }) => (
  <button
    type="button"
    {...tipProps(label, shortcut)}
    aria-label={label}
    aria-pressed={active}
    disabled={disabled}
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    className={`${toolClass(active, disabled)} ${className}`}
  >
    {children}
  </button>
);

interface DropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  label: string;
  align?: "left" | "right";
  className?: string;
  panelClassName?: string;
  triggerClassName?: string;
  children: React.ReactNode;
  // Keep the editor selection on trigger mousedown (false for popovers holding their own inputs).
  keepSelection?: boolean;
  // Render children as-is, for content that brings its own positioned panel.
  bare?: boolean;
}

export const Dropdown: React.FC<DropdownProps> = ({
  open,
  onOpenChange,
  trigger,
  label,
  align = "left",
  className = "",
  panelClassName = "",
  triggerClassName,
  children,
  keepSelection = true,
  bare = false,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Marked as used, so outer Esc handlers (highlighter mode) leave this one be.
      if (e.key === "Escape") {
        markKeyHandled(e);
        onOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        {...tipProps(label)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => keepSelection && e.preventDefault()}
        onClick={() => onOpenChange(!open)}
        className={triggerClassName ?? toolClass(open)}
      >
        {trigger}
      </button>
      {open && bare && children}
      {open && !bare && (
        <div role="menu" className={`${menuPanelClass} ${align === "right" ? "right-0" : "left-0"} ${panelClassName}`}>
          {children}
        </div>
      )}
    </div>
  );
};

// One open popover at a time across the whole bar.
export function useOpenMenu() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const bind = useCallback(
    (id: string) => ({
      open: openMenu === id,
      onOpenChange: (next: boolean) => setOpenMenu((cur) => (next ? id : cur === id ? null : cur)),
    }),
    [openMenu]
  );
  return { openMenu, setOpenMenu, bind };
}

const MenuSection: React.FC<{ title: string; className?: string; children: React.ReactNode }> = ({ title, className = "", children }) => (
  <div className={className}>
    <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{title}</div>
    {children}
  </div>
);

// ---------------------------------------------------------------------------------------------
// Helpers reading editor state

function currentParagraphStyle(editor: Editor): string {
  for (const level of [1, 2, 3, 4] as const) if (editor.isActive("heading", { level })) return String(level);
  return "p";
}

// The explicit fontSize mark if there is one, else the rendered size at the cursor (so headings and
// the default body size show a real number instead of a blank box).
function currentFontSizePt(editor: Editor): number | null {
  const explicit = editor.getAttributes("textStyle").fontSize as number | undefined;
  if (explicit) return explicit;
  try {
    const { node } = editor.view.domAtPos(editor.state.selection.from);
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return null;
    const px = parseFloat(getComputedStyle(el).fontSize);
    return Number.isFinite(px) ? Math.round(px * 0.75 * 2) / 2 : null;
  } catch {
    return null;
  }
}

function currentFontFamily(editor: Editor): string | null {
  const raw = editor.getAttributes("textStyle").fontFamily as string | undefined;
  if (!raw) return null;
  return raw.replace(/["']/g, "").split(",")[0].trim();
}

// ---------------------------------------------------------------------------------------------
// Controls

const FontSizeControl: React.FC<{ editor: Editor }> = ({ editor }) => {
  const size = currentFontSizePt(editor);
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (size !== null ? String(size) : "");

  // Typing into the box must not refocus the editor on every keystroke (the old input called
  // editor.chain().focus() in onChange, so typing "12" applied 1pt and bounced focus away after the
  // first digit). Commit on Enter/blur instead.
  const commit = (value: string) => {
    setDraft(null);
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return;
    editor.chain().focus().setFontSize(Math.max(1, Math.min(400, n))).run();
  };
  const step = (dir: 1 | -1) => {
    const cur = size ?? 11;
    const next = dir > 0 ? FONT_SIZE_STEPS.find((s) => s > cur) ?? cur + 12 : [...FONT_SIZE_STEPS].reverse().find((s) => s < cur) ?? Math.max(1, cur - 1);
    editor.chain().focus().setFontSize(next).run();
  };

  return (
    <div className="flex items-center shrink-0">
      <ToolButton label="Decrease font size" onClick={() => step(-1)}>
        <MdRemove size={16} />
      </ToolButton>
      <input
        value={display}
        aria-label="Font size"
        data-tip="Font size"
        inputMode="decimal"
        onFocus={(e) => {
          setDraft(display);
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ""))}
        onBlur={() => draft !== null && commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft ?? display);
          } else if (e.key === "Escape") {
            setDraft(null);
            editor.commands.focus();
          }
        }}
        className="w-9 h-6 text-center text-sm rounded border border-neutral-400/70 dark:border-neutral-500 bg-transparent text-neutral-800 dark:text-neutral-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
      <ToolButton label="Increase font size" onClick={() => step(1)}>
        <MdAdd size={16} />
      </ToolButton>
    </div>
  );
};

const TableGridPicker: React.FC<{ onPick: (rows: number, cols: number) => void }> = ({ onPick }) => {
  const [hover, setHover] = useState<[number, number]>([0, 0]);
  const rows = 8;
  const cols = 10;
  return (
    <div className="p-2.5" onMouseLeave={() => setHover([0, 0])}>
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${cols}, 1rem)` }}>
        {Array.from({ length: rows * cols }, (_, i) => {
          const r = Math.floor(i / cols) + 1;
          const c = (i % cols) + 1;
          const on = r <= hover[0] && c <= hover[1];
          return (
            <button
              key={i}
              type="button"
              aria-label={`${r} by ${c} table`}
              onMouseEnter={() => setHover([r, c])}
              onFocus={() => setHover([r, c])}
              onClick={() => onPick(r, c)}
              className={`w-4 h-4 rounded-[2px] border ${
                on ? "bg-blue-200 border-blue-500 dark:bg-blue-500/40 dark:border-blue-400" : "border-neutral-300 dark:border-neutral-600"
              }`}
            />
          );
        })}
      </div>
      <div className="mt-2 text-xs text-center text-neutral-500 dark:text-neutral-400">{hover[0] ? `${hover[1]} × ${hover[0]}` : "Insert table"}</div>
    </div>
  );
};

// Mic level bars, animated straight from levelRef in a rAF loop - no React state at audio rate.
const DictationLevelMeter: React.FC<{ levelRef: React.MutableRefObject<number> }> = ({ levelRef }) => {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  useLayoutEffect(() => {
    let raf = 0;
    let shown = 0;
    const tick = () => {
      const target = levelRef.current;
      shown = target > shown ? shown + (target - shown) * 0.6 : shown * 0.85;
      barsRef.current.forEach((bar, i) => {
        if (!bar) return;
        const weight = [0.7, 1, 0.8][i] ?? 1;
        bar.style.transform = `scaleY(${Math.max(0.2, Math.min(1, shown * weight * 1.6))})`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);
  return (
    <span className="flex items-center gap-[2px] h-3.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className="w-[3px] h-full rounded-full bg-current origin-center transition-none"
          style={{ transform: "scaleY(0.2)" }}
        />
      ))}
    </span>
  );
};

const DictationControl: React.FC<{ dictation: DocDictation; menu: ReturnType<ReturnType<typeof useOpenMenu>["bind"]> }> = ({ dictation, menu }) => {
  const { phase, pending, language, detectedLanguage } = dictation;
  const listening = phase === "listening";
  const busy = phase === "starting" || phase === "finishing";
  const langLabel =
    language === "auto"
      ? detectedLanguage
        ? `Auto · ${detectedLanguage}`
        : "Auto-detect"
      : DICTATION_LANGUAGES.find((l) => l.code === language)?.label ?? language;

  return (
    <div
      className={`flex items-center shrink-0 rounded-full transition-colors ${
        listening ? "bg-red-50 dark:bg-red-500/15 ring-1 ring-red-200 dark:ring-red-500/40" : ""
      }`}
    >
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={dictation.toggle}
        disabled={phase === "starting"}
        {...tipProps(listening ? "Stop voice typing" : "Voice typing", "Ctrl+Shift+S")}
        aria-label={listening ? "Stop voice typing" : "Voice typing"}
        aria-pressed={listening}
        className={`h-7 inline-flex items-center gap-1.5 rounded-full transition-colors ${
          listening
            ? "pl-2 pr-2.5 text-red-600 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-500/20"
            : `px-1.5 ${busy ? "text-blue-600 dark:text-blue-300" : "text-neutral-700 dark:text-neutral-200 hover:bg-black/[0.06] dark:hover:bg-white/10"}`
        }`}
      >
        {listening ? (
          <>
            <DictationLevelMeter levelRef={dictation.levelRef} />
            <span className="text-xs font-medium">{dictation.speaking ? "Listening" : pending > 0 ? "Writing…" : "Listening"}</span>
            <MdStop size={16} />
          </>
        ) : busy ? (
          <>
            <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
            <span className="text-xs font-medium">{phase === "starting" ? "Starting…" : `Finishing${pending > 1 ? ` (${pending})` : ""}…`}</span>
          </>
        ) : (
          <MdMic size={18} />
        )}
      </button>
      <Dropdown
        {...menu}
        label="Voice typing options"
        align="right"
        trigger={<MdArrowDropDown size={18} />}
        triggerClassName={`h-7 w-5 inline-flex items-center justify-center rounded-full text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.06] dark:hover:bg-white/10 ${
          menu.open ? "bg-black/[0.06] dark:bg-white/10" : ""
        }`}
        panelClassName="w-80 py-2"
      >
        <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Language · {langLabel}</div>
        <div className="max-h-52 overflow-y-auto">
          {DICTATION_LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              className={menuItemClass}
              onClick={() => {
                dictation.setLanguage(l.code);
                menu.onOpenChange(false);
              }}
            >
              <span className="w-4 shrink-0">{language === l.code && <MdCheck size={16} />}</span>
              {l.label}
            </button>
          ))}
        </div>
        <div className="my-1.5 h-px bg-neutral-200 dark:bg-neutral-700" />
        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Voice commands (English)</div>
        <dl className="px-3 space-y-1 text-xs">
          {VOICE_COMMANDS.map(([say, does]) => (
            <div key={say} className="flex gap-2">
              <dt className="flex-1 text-neutral-700 dark:text-neutral-200">{say}</dt>
              <dd className="text-neutral-500 dark:text-neutral-400 text-right">{does}</dd>
            </div>
          ))}
        </dl>
        <p className="px-3 pt-2 text-[11px] leading-snug text-neutral-400">
          Text appears after each pause. Click anywhere in the document to move where it goes. Runs fully on this computer.
        </p>
      </Dropdown>
    </div>
  );
};

// ---------------------------------------------------------------------------------------------
// The bar

export interface DocToolbarProps {
  editor: Editor;
  dictation: DocDictation;
  linkOpen: boolean;
  onLinkOpenChange: (open: boolean) => void;
  onInsertImage: () => void;
  onAddComment: (text: string) => void;
  rulerVisible: boolean;
  onToggleRuler: () => void;
  // Citation / cross-reference pickers, hosted by DocsEditor and anchored to `anchor`.
  onOpenPicker: (kind: "cite" | "xref", anchor: DOMRect) => void;
}

const DocToolbar: React.FC<DocToolbarProps> = ({ editor, dictation, linkOpen, onLinkOpenChange, onInsertImage, onAddComment, rulerVisible, onToggleRuler, onOpenPicker }) => {
  const { bind, setOpenMenu } = useOpenMenu();
  const close = () => setOpenMenu(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const comment = bind("comment");

  // The link popover is opened from outside too (Ctrl+K in DocsEditor), so it's controlled by props.
  useEffect(() => {
    if (!linkOpen) return;
    setOpenMenu(null);
    setLinkUrl((editor.getAttributes("link").href as string | undefined) ?? "");
    setLinkText("");
  }, [linkOpen, editor, setOpenMenu]);

  const canUndo = editor.can().undo?.() ?? false;
  const canRedo = editor.can().redo?.() ?? false;
  const paragraphStyle = currentParagraphStyle(editor);
  const fontFamily = currentFontFamily(editor);
  const textColor = (editor.getAttributes("textStyle").color as string | undefined) ?? null;
  const highlightColor = (editor.getAttributes("highlight").color as string | undefined) ?? null;
  const activeAlign = ALIGNMENTS.find((a) => editor.isActive({ textAlign: a.value })) ?? ALIGNMENTS[0];
  const lineSpacing = (editor.getAttributes("paragraph").lineSpacing ?? editor.getAttributes("heading").lineSpacing ?? null) as number | null;
  const paint = getPaintState(editor);

  // Text selected -> colour it now. Nothing selected -> arm highlighter mode (docPaintExtension.ts):
  // every selection made next gets this colour, and it's also stored so typed text takes it.
  const pickColor = (kind: PaintKind, color: string) => {
    const chain = editor.chain().focus();
    const withColor = kind === "color" ? chain.setColor(color) : chain.setHighlight({ color });
    if (editor.state.selection.empty) withColor.startPaint(kind, color).run();
    else withColor.run();
  };
  const clearColor = (kind: PaintKind) => {
    const chain = editor.chain().focus();
    (kind === "color" ? chain.unsetColor() : chain.unsetHighlight()).run();
    if (paint?.kind === kind) editor.commands.stopPaint();
    close();
  };
  // While a colour's highlighter mode is on, its button turns it off instead of opening the picker.
  const colorMenu = (kind: PaintKind, id: string) => {
    const b = bind(id);
    return {
      open: b.open,
      onOpenChange: (next: boolean) => {
        if (next && paint?.kind === kind) {
          editor.chain().focus().stopPaint().run();
          return;
        }
        b.onOpenChange(next);
      },
    };
  };
  const paintTrigger = (kind: PaintKind, open: boolean) =>
    `${toolClass(open || paint?.kind === kind)} ${paint?.kind === kind ? "ring-2 ring-blue-500/60" : ""}`;

  const onLink = editor.isActive("link");
  const inTable = editor.isActive("table");
  const hasSelection = !editor.state.selection.empty;

  // On a link, Underline toggles the link's own underlineOff attribute (docLinkExtension.ts) - an
  // autolinked URL's underline comes from docLinks.css, not an underline mark.
  const linkUnderlineOff = editor.getAttributes("link").underlineOff === true;
  const underlineActive = onLink ? !linkUnderlineOff : editor.isActive("underline");
  const toggleUnderline = () =>
    onLink
      ? editor.chain().focus().updateAttributes("link", { underlineOff: !linkUnderlineOff }).run()
      : editor.chain().focus().toggleUnderline().run();

  const applyLink = () => {
    const url = linkUrl.trim();
    if (url) {
      const href = /^[a-z][\w+.-]*:/i.test(url) || url.startsWith("#") ? url : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url) ? `mailto:${url}` : `https://${url}`;
      if (editor.state.selection.empty && !onLink) {
        // No range for the mark to wrap - insert the label (or the URL itself) as linked text.
        editor
          .chain()
          .focus()
          .insertContent({ type: "text", text: linkText.trim() || url, marks: [{ type: "link", attrs: { href } }] })
          .run();
      } else {
        editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
      }
    }
    onLinkOpenChange(false);
  };

  const submitComment = () => {
    const text = commentDraft.trim();
    if (!text) return;
    onAddComment(text);
    setCommentDraft("");
    close();
  };

  // Shared by the bar and the More menu's mirrored sections.
  const alignItems = ALIGNMENTS.map((a) => (
    <button
      key={a.value}
      type="button"
      className={menuItemClass}
      onClick={() => {
        editor.chain().focus().setTextAlign(a.value).run();
        close();
      }}
    >
      <a.icon size={18} />
      <span className="flex-1">{a.label}</span>
      <span className="text-xs text-neutral-400">{a.keys}</span>
    </button>
  ));
  const lineSpacingItems = (
    <>
      {LINE_SPACINGS.map((s) => (
        <button
          key={s.value}
          type="button"
          className={menuItemClass}
          onClick={() => {
            editor.chain().focus().setLineSpacing(s.value).run();
            close();
          }}
        >
          <span className="w-4 shrink-0">{lineSpacing === s.value && <MdCheck size={16} />}</span>
          {s.label}
        </button>
      ))}
      <button
        type="button"
        className={menuItemClass}
        onClick={() => {
          editor.chain().focus().unsetLineSpacing().run();
          close();
        }}
      >
        <span className="w-4 shrink-0">{lineSpacing === null && <MdCheck size={16} />}</span>
        Default
      </button>
    </>
  );
  const menuAction = (label: string, Icon: React.ComponentType<{ size?: number }>, run: () => void, opts: { active?: boolean; keys?: string; disabled?: boolean } = {}) => (
    <button
      key={label}
      type="button"
      disabled={opts.disabled}
      className={menuItemClass}
      onClick={() => {
        run();
        close();
      }}
    >
      <Icon size={18} />
      <span className="flex-1">{label}</span>
      {opts.active && <MdCheck size={16} className="text-blue-600 dark:text-blue-300" />}
      {opts.keys && <span className="text-xs text-neutral-400">{opts.keys}</span>}
    </button>
  );
  // The More menu's picker entries open at the cursor - the menu itself is gone by then.
  const openPickerAtCursor = (kind: "cite" | "xref") => {
    editor.commands.scrollIntoView();
    requestAnimationFrame(() => {
      const c = editor.view.coordsAtPos(editor.state.selection.from);
      onOpenPicker(kind, new DOMRect(c.left, c.top, 1, c.bottom - c.top));
    });
  };
  // Shared by the bar's equation menu and the More menu's Insert section. Inline equation turns
  // any selected text into the equation's source.
  const equationItems = (
    <>
      {menuAction("Equation", TbMathFunction, () => editor.chain().focus().insertMathBlock().run(), { keys: "$$" })}
      {menuAction("Inline equation", TbMath, () => editor.chain().focus().insertMathInline().run(), { keys: "$…$" })}
    </>
  );

  return (
    <div className="@container relative shrink-0 px-3 pt-1.5 pb-2 print:hidden">
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex items-center gap-0.5 h-10 px-2 rounded-full bg-[#edf2fa] dark:bg-neutral-800/80 ring-1 ring-black/[0.03] dark:ring-white/5"
      >
        <ToolButton label="Undo" shortcut="Ctrl+Z" disabled={!canUndo} onClick={() => editor.chain().focus().undo().run()}>
          <MdUndo size={18} />
        </ToolButton>
        <ToolButton label="Redo" shortcut="Ctrl+Y" disabled={!canRedo} onClick={() => editor.chain().focus().redo().run()}>
          <MdRedo size={18} />
        </ToolButton>

        <Divider />

        <Dropdown
          {...bind("style")}
          label="Styles"
          trigger={
            <>
              <span className="w-[5.5rem] text-left text-sm truncate">{PARAGRAPH_STYLES.find((s) => s.value === paragraphStyle)?.label}</span>
              <MdArrowDropDown size={18} />
            </>
          }
          triggerClassName={`${toolClass(false)} pl-2 pr-0.5 hidden @2xl:inline-flex`}
          className="hidden @2xl:block"
          panelClassName="w-60 py-1.5"
        >
          {PARAGRAPH_STYLES.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`${menuItemClass} py-2`}
              onClick={() => {
                if (s.value === "p") editor.chain().focus().setParagraph().run();
                else editor.chain().focus().setHeading({ level: Number(s.value) as 1 | 2 | 3 | 4 }).run();
                close();
              }}
            >
              <span className="w-4 shrink-0">{paragraphStyle === s.value && <MdCheck size={16} />}</span>
              <span className={`${s.className} text-neutral-900 dark:text-neutral-100 leading-tight`}>{s.label}</span>
            </button>
          ))}
        </Dropdown>

        <Divider className="hidden @2xl:block" />

        <Dropdown
          {...bind("font")}
          label="Font"
          trigger={
            <>
              <span className="w-24 text-left text-sm truncate" style={{ fontFamily: fontFamily ?? undefined }}>
                {fontFamily ?? "Default"}
              </span>
              <MdArrowDropDown size={18} />
            </>
          }
          triggerClassName={`${toolClass(false)} pl-2 pr-0.5`}
          className="hidden @3xl:block"
          panelClassName="w-56 py-1.5 max-h-80 overflow-y-auto"
        >
          <button
            type="button"
            className={menuItemClass}
            onClick={() => {
              editor.chain().focus().unsetFontFamily().run();
              close();
            }}
          >
            <span className="w-4 shrink-0">{fontFamily === null && <MdCheck size={16} />}</span>
            Default
          </button>
          <div className="my-1 h-px bg-neutral-200 dark:bg-neutral-700" />
          {FONT_FAMILIES.map((font) => (
            <button
              key={font}
              type="button"
              className={menuItemClass}
              onClick={() => {
                editor.chain().focus().setFontFamily(font).run();
                close();
              }}
            >
              <span className="w-4 shrink-0">{fontFamily === font && <MdCheck size={16} />}</span>
              <span style={{ fontFamily: font }}>{font}</span>
            </button>
          ))}
        </Dropdown>

        <Divider className="hidden @3xl:block" />

        <FontSizeControl editor={editor} />

        <Divider />

        <ToolButton label="Bold" shortcut="Ctrl+B" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
          <MdFormatBold size={19} />
        </ToolButton>
        <ToolButton label="Italic" shortcut="Ctrl+I" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <MdFormatItalic size={19} />
        </ToolButton>
        <ToolButton label="Underline" shortcut="Ctrl+U" active={underlineActive} onClick={toggleUnderline}>
          <MdFormatUnderlined size={19} />
        </ToolButton>

        <Dropdown
          {...colorMenu("color", "textColor")}
          label={paint?.kind === "color" ? "Stop text colour highlighter (Esc)" : "Text color"}
          triggerClassName={paintTrigger("color", bind("textColor").open)}
          trigger={
            <span className="flex flex-col items-center leading-none">
              <MdFormatColorText size={17} />
              <span className="block w-4 h-[3px] -mt-px rounded-sm" style={{ backgroundColor: textColor ?? "currentColor" }} />
            </span>
          }
          className="hidden @xl:block"
        >
          <DocColorPicker
            value={textColor}
            onChange={(color) => pickColor("color", color)}
            onClear={() => clearColor("color")}
            onClose={close}
            storageKey="text"
            clearLabel="Reset color"
          />
        </Dropdown>
        <Dropdown
          {...colorMenu("highlight", "highlight")}
          label={paint?.kind === "highlight" ? "Stop highlighter (Esc)" : "Highlight color"}
          triggerClassName={paintTrigger("highlight", bind("highlight").open)}
          trigger={
            <span className="flex flex-col items-center leading-none">
              <BiHighlight size={16} />
              <span
                className="block w-4 h-[3px] mt-px rounded-sm"
                style={{ backgroundColor: highlightColor ?? "transparent", boxShadow: highlightColor ? undefined : "inset 0 0 0 1px currentColor" }}
              />
            </span>
          }
          className="hidden @xl:block"
        >
          <DocColorPicker
            value={highlightColor}
            onChange={(color) => pickColor("highlight", color)}
            onClear={() => clearColor("highlight")}
            onClose={close}
            storageKey="highlight"
            clearLabel="None"
          />
        </Dropdown>

        <Divider className="hidden @xl:block" />

        <Dropdown
          open={linkOpen}
          onOpenChange={onLinkOpenChange}
          label={onLink ? "Edit link (Ctrl+K)" : "Insert link (Ctrl+K)"}
          trigger={<MdLink size={19} />}
          triggerClassName={toolClass(linkOpen || onLink)}
          panelClassName="w-80 p-3"
          keepSelection
        >
          <div className="space-y-2">
            {editor.state.selection.empty && !onLink && (
              <input
                autoFocus
                value={linkText}
                onChange={(e) => setLinkText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyLink()}
                placeholder="Text"
                className="w-full px-2.5 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100"
              />
            )}
            <div className="flex items-center gap-2">
              <input
                autoFocus={!editor.state.selection.empty || onLink}
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyLink()}
                placeholder="Paste or type a link"
                className="flex-1 min-w-0 px-2.5 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100"
              />
              <button
                type="button"
                disabled={!linkUrl.trim()}
                onClick={applyLink}
                className="px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
              >
                Apply
              </button>
            </div>
            {onLink && (
              <button
                type="button"
                onClick={() => {
                  editor.chain().focus().extendMarkRange("link").unsetLink().run();
                  onLinkOpenChange(false);
                }}
                className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400"
              >
                <MdLinkOff size={15} /> Remove link
              </button>
            )}
          </div>
        </Dropdown>

        <Dropdown
          open={comment.open}
          onOpenChange={(next) => (!next || hasSelection) && comment.onOpenChange(next)}
          label={hasSelection ? "Add comment" : "Select text to comment"}
          trigger={<MdAddComment size={18} />}
          triggerClassName={toolClass(comment.open, !hasSelection && !comment.open)}
          panelClassName="w-72 p-2.5"
          keepSelection
          className="hidden @md:block"
        >
          <textarea
            autoFocus
            rows={3}
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitComment();
            }}
            placeholder="Comment"
            className="w-full px-2.5 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100 resize-none"
          />
          <div className="flex justify-end gap-1.5 mt-2">
            <button type="button" onClick={close} className="px-3 py-1 text-sm rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
              Cancel
            </button>
            <button
              type="button"
              disabled={!commentDraft.trim()}
              onClick={submitComment}
              className="px-3 py-1 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              Comment
            </button>
          </div>
        </Dropdown>

        <div className="hidden @4xl:flex items-center gap-0.5">
          <ToolButton label="Insert image" onClick={onInsertImage}>
            <MdImage size={19} />
          </ToolButton>
          <Dropdown {...bind("table")} label="Insert table" trigger={<TbTable size={19} strokeWidth={1.75} />}>
            <TableGridPicker
              onPick={(rows, cols) => {
                editor.chain().focus().insertTable({ rows, cols, withHeaderRow: rows > 1 }).run();
                close();
              }}
            />
          </Dropdown>
          <Dropdown {...bind("equation")} label="Insert equation" trigger={<TbMathFunction size={19} strokeWidth={1.75} />} panelClassName="w-60 py-1.5">
            {equationItems}
          </Dropdown>
          <button
            type="button"
            {...tipProps("Cite a reference")}
            aria-label="Cite a reference"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => onOpenPicker("cite", e.currentTarget.getBoundingClientRect())}
            className={toolClass(false)}
          >
            <TbQuote size={19} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            {...tipProps("Cross-reference a figure, table or equation")}
            aria-label="Insert cross-reference"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => onOpenPicker("xref", e.currentTarget.getBoundingClientRect())}
            className={toolClass(false)}
          >
            <TbCornerDownRight size={19} strokeWidth={1.75} />
          </button>
        </div>

        {inTable && (
          <Dropdown {...bind("tableOps")} label="Table options" trigger={<TbTableOptions size={19} strokeWidth={1.75} />} panelClassName="w-52 py-1.5">
            {(
              [
                ["Insert row above", () => editor.chain().focus().addRowBefore().run(), editor.can().addRowBefore()],
                ["Insert row below", () => editor.chain().focus().addRowAfter().run(), editor.can().addRowAfter()],
                ["Insert column left", () => editor.chain().focus().addColumnBefore().run(), editor.can().addColumnBefore()],
                ["Insert column right", () => editor.chain().focus().addColumnAfter().run(), editor.can().addColumnAfter()],
                null,
                ["Merge cells", () => editor.chain().focus().mergeCells().run(), editor.can().mergeCells()],
                ["Split cell", () => editor.chain().focus().splitCell().run(), editor.can().splitCell()],
                ["Toggle header row", () => editor.chain().focus().toggleHeaderRow().run(), editor.can().toggleHeaderRow()],
                ["Toggle header column", () => editor.chain().focus().toggleHeaderColumn().run(), editor.can().toggleHeaderColumn()],
                null,
                ["Delete row", () => editor.chain().focus().deleteRow().run(), editor.can().deleteRow()],
                ["Delete column", () => editor.chain().focus().deleteColumn().run(), editor.can().deleteColumn()],
                null,
                ["Add caption", () => editor.chain().focus().insertCaption("table").run(), true],
              ] as ([string, () => void, boolean] | null)[]
            ).map((item, i) =>
              item ? (
                <button
                  key={item[0]}
                  type="button"
                  disabled={!item[2]}
                  className={menuItemClass}
                  onClick={() => {
                    item[1]();
                    close();
                  }}
                >
                  {item[0]}
                </button>
              ) : (
                <div key={i} className="my-1 h-px bg-neutral-200 dark:bg-neutral-700" />
              )
            )}
            <button
              type="button"
              className={`${menuItemClass} text-red-600 dark:text-red-400`}
              onClick={() => {
                editor.chain().focus().deleteTable().run();
                close();
              }}
            >
              Delete table
            </button>
          </Dropdown>
        )}

        <Divider className="hidden @4xl:block" />

        <div className="hidden @5xl:flex items-center gap-0.5">
          <Dropdown {...bind("align")} label="Align" trigger={<activeAlign.icon size={18} />} panelClassName="w-60 py-1.5">
            {alignItems}
          </Dropdown>
          <Dropdown {...bind("spacing")} label="Line spacing" trigger={<MdFormatLineSpacing size={18} />} panelClassName="w-44 py-1.5">
            {lineSpacingItems}
          </Dropdown>
        </div>

        <div className="hidden @3xl:flex items-center gap-0.5">
          <ToolButton label="Bulleted list" shortcut="Ctrl+Shift+8" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <MdFormatListBulleted size={19} />
          </ToolButton>
          <ToolButton label="Numbered list" shortcut="Ctrl+Shift+7" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <MdFormatListNumbered size={19} />
          </ToolButton>
        </div>

        <div className="hidden @6xl:flex items-center gap-0.5">
          <ToolButton label="Decrease indent" shortcut="Ctrl+[" onClick={() => editor.chain().focus().outdent().run()}>
            <MdFormatIndentDecrease size={18} />
          </ToolButton>
          <ToolButton label="Increase indent" shortcut="Ctrl+]" onClick={() => editor.chain().focus().indent().run()}>
            <MdFormatIndentIncrease size={18} />
          </ToolButton>
          <Divider />
          <ToolButton label="Clear formatting" shortcut="Ctrl+\" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
            <MdFormatClear size={18} />
          </ToolButton>
        </div>

        <Dropdown {...bind("more")} label="More" align="right" trigger={<MdMoreVert size={18} />} panelClassName="w-64 pb-1.5 max-h-[70vh] overflow-y-auto">
          <MenuSection title="Text">
            {menuAction("Strikethrough", MdStrikethroughS, () => editor.chain().focus().toggleStrike().run(), { active: editor.isActive("strike"), keys: "Alt+Shift+5" })}
            {menuAction("Inline code", MdCode, () => editor.chain().focus().toggleCode().run(), { active: editor.isActive("code"), keys: "Ctrl+E" })}
            {menuAction("Superscript", MdSuperscript, () => editor.chain().focus().toggleSuperscript().run(), { active: editor.isActive("superscript"), keys: "Ctrl+." })}
            {menuAction("Subscript", MdSubscript, () => editor.chain().focus().toggleSubscript().run(), { active: editor.isActive("subscript"), keys: "Ctrl+," })}
          </MenuSection>
          <MenuSection title="View">
            {menuAction("Show ruler", MdStraighten, onToggleRuler, { active: rulerVisible })}
          </MenuSection>
          <MenuSection title="Blocks">
            {menuAction("Quote", MdFormatQuote, () => editor.chain().focus().toggleBlockquote().run(), { active: editor.isActive("blockquote") })}
            {menuAction("Code block", MdDataObject, () => editor.chain().focus().toggleCodeBlock().run(), { active: editor.isActive("codeBlock") })}
            {menuAction("Horizontal line", MdHorizontalRule, () => editor.chain().focus().setHorizontalRule().run())}
            {menuAction("Page break", MdInsertPageBreak, () => editor.chain().focus().setPageBreak().run(), { keys: "Ctrl+Enter" })}
          </MenuSection>
          {/* Mirrors of whatever the bar has hidden at the current width. */}
          <MenuSection title="Style" className="@2xl:hidden">
            {PARAGRAPH_STYLES.map((s) =>
              menuAction(
                s.label,
                MdTitle,
                () => (s.value === "p" ? editor.chain().focus().setParagraph().run() : editor.chain().focus().setHeading({ level: Number(s.value) as 1 | 2 | 3 | 4 }).run()),
                { active: paragraphStyle === s.value }
              )
            )}
          </MenuSection>
          <MenuSection title="Lists" className="@3xl:hidden">
            {menuAction("Bulleted list", MdFormatListBulleted, () => editor.chain().focus().toggleBulletList().run(), { active: editor.isActive("bulletList") })}
            {menuAction("Numbered list", MdFormatListNumbered, () => editor.chain().focus().toggleOrderedList().run(), { active: editor.isActive("orderedList") })}
          </MenuSection>
          <MenuSection title="Insert" className="@4xl:hidden">
            {menuAction("Image", MdImage, onInsertImage)}
            {menuAction("Table (3 × 3)", TbTable, () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
            {equationItems}
            {menuAction("Citation…", TbQuote, () => openPickerAtCursor("cite"))}
            {menuAction("Cross-reference…", TbCornerDownRight, () => openPickerAtCursor("xref"))}
          </MenuSection>
          <MenuSection title="References & structure">
            {menuAction("Figure caption", TbPhoto, () => editor.chain().focus().insertCaption("figure").run())}
            {menuAction("Table caption", TbTable, () => editor.chain().focus().insertCaption("table").run())}
            {menuAction("Reference list", TbBooks, () => editor.chain().focus().insertBibliography().run())}
            {menuAction("Table of contents", TbListDetails, () => editor.chain().focus().insertTableOfContents().run())}
          </MenuSection>
          <MenuSection title="Align" className="@5xl:hidden">
            {alignItems}
          </MenuSection>
          <MenuSection title="Line spacing" className="@5xl:hidden">
            {lineSpacingItems}
          </MenuSection>
          <MenuSection title="Paragraph" className="@6xl:hidden">
            {menuAction("Decrease indent", MdFormatIndentDecrease, () => editor.chain().focus().outdent().run(), { keys: "Ctrl+[" })}
            {menuAction("Increase indent", MdFormatIndentIncrease, () => editor.chain().focus().indent().run(), { keys: "Ctrl+]" })}
            {menuAction("Clear formatting", MdFormatClear, () => editor.chain().focus().unsetAllMarks().clearNodes().run(), { keys: "Ctrl+\\" })}
          </MenuSection>
        </Dropdown>

        <div className="flex-1" />

        <DictationControl dictation={dictation} menu={bind("dictation")} />
      </div>
      {paint && (
        <div className="absolute left-1/2 top-full -translate-x-1/2 -mt-1 z-30 flex items-center gap-2 rounded-full bg-neutral-900 pl-3 pr-1.5 py-1 text-xs text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900">
          <span
            className="w-3.5 h-3.5 rounded-full ring-1 ring-white/40 dark:ring-black/20"
            style={{ backgroundColor: paint.color }}
            aria-hidden
          />
          <span>
            {paint.kind === "highlight" ? "Highlighter" : "Text colour"} on - select text to apply, again to remove
          </span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor.chain().focus().stopPaint().run()}
            className="ml-1 rounded-full px-2 py-0.5 font-medium bg-white/15 hover:bg-white/25 dark:bg-black/10 dark:hover:bg-black/20"
            data-tip="Stop"
            data-tip-kbd="Esc"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
};

export default DocToolbar;
