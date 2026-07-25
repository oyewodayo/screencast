// components/pdf/TextNoteEditor.tsx
import React, { useEffect, useRef, useState } from "react";
import { MdFormatAlignCenter, MdFormatAlignJustify, MdFormatAlignLeft, MdFormatAlignRight, MdFormatBold, MdFormatItalic } from "react-icons/md";
import { TEXT_FONT_FAMILY, applyColorRun, shiftColorRunsForEdit, shiftTextRangesForEdit, toggleTextRange } from "../../handlers/pdfAnnotationHandlers";
import { TextAlign, TextColorRun, TextRange } from "../../utils/pdfAnnotationTypes";
import { renderFormattedSegments } from "../../utils/textFormatting";
import BackgroundSwatchPicker from "./BackgroundSwatchPicker";
import ColorSwatchPicker from "./ColorSwatchPicker";

const ALIGN_OPTIONS: { value: TextAlign; icon: React.ComponentType<{ size?: number }>; title: string }[] = [
  { value: "left", icon: MdFormatAlignLeft, title: "Align left" },
  { value: "center", icon: MdFormatAlignCenter, title: "Align center" },
  { value: "right", icon: MdFormatAlignRight, title: "Align right" },
  { value: "justify", icon: MdFormatAlignJustify, title: "Justify" },
];

const MIN_FONT_SIZE_DEVICE_PX = 8;
const MAX_FONT_SIZE_DEVICE_PX = 200;
const MIN_WIDTH_DEVICE_PX = 60;
const MAX_WIDTH_DEVICE_PX = 4000;
const CARET_COLOR = "#1a1a1a";

interface TextNoteEditorProps {
  left: number; // device/CSS px, relative to the page's canvas stack
  top: number;
  width: number;
  fontSize: number;
  initialText: string;
  initialColor: string;
  initialBackgroundColor: string | undefined;
  initialColorRuns: TextColorRun[];
  initialBoldRuns: TextRange[];
  initialItalicRuns: TextRange[];
  initialTextAlign: TextAlign;
  // Fired after every change (keystroke, color pick, bold/italic toggle, alignment) with the full
  // current content — the parent stages it in refs (not state) and only actually persists it at
  // commit, same "not React state up there" reasoning liveTextRef used before this component
  // started managing its own live formatting state locally for the backdrop preview below.
  onContentChange: (
    text: string,
    color: string,
    backgroundColor: string | undefined,
    colorRuns: TextColorRun[],
    boldRuns: TextRange[],
    italicRuns: TextRange[],
    textAlign: TextAlign
  ) => void;
  onCommit: () => void;
  onCancel: () => void;
  onMoveEnd: (newLeft: number, newTop: number) => void;
  onResizeEnd: (newFontSize: number) => void;
  onResizeWidthEnd: (newWidth: number) => void;
}

// A real DOM <textarea> overlaid on the page at the note's position — canvas can't accept
// keyboard text input directly, so editing happens here and only gets baked into the overlay
// canvas (via renderObject in pdfAnnotationHandlers) once committed. A small header strip above
// it drags the whole note and hosts color/bold/italic controls; a corner handle at its top-right
// resizes the font; a strip along the right edge resizes the wrap width. Move/resize stay purely
// imperative (direct style mutation) while a drag is in progress — no React re-renders per pixel.
//
// Text/color/bold/italic, unlike position/size, DO need to live in React state here: the textarea
// itself is rendered with fully transparent text over a "backdrop" div showing the real colored/
// styled characters, so the two must be kept in exact sync on every keystroke for the live preview
// to track what's actually being typed. The backdrop also carries the note's visible chrome
// (background/border) so it shows through the invisible-text textarea sitting on top of it.
const TextNoteEditor: React.FC<TextNoteEditorProps> = ({
  left,
  top,
  width,
  fontSize,
  initialText,
  initialColor,
  initialBackgroundColor,
  initialColorRuns,
  initialBoldRuns,
  initialItalicRuns,
  initialTextAlign,
  onContentChange,
  onCommit,
  onCancel,
  onMoveEnd,
  onResizeEnd,
  onResizeWidthEnd,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Guards against commit AND cancel both firing for the same session — e.g. Escape triggers
  // onCancel synchronously, which unmounts this component, which can itself fire a native blur
  // on the way out. Without this, that stray blur would call onCommit right after onCancel
  // already resolved the session, corrupting whatever happened next (a fresh add, a new edit).
  const resolvedRef = useRef(false);

  const [text, setText] = useState(initialText);
  const [color, setColor] = useState(initialColor);
  const [backgroundColor, setBackgroundColor] = useState<string | undefined>(initialBackgroundColor);
  const [colorRuns, setColorRuns] = useState<TextColorRun[]>(initialColorRuns);
  const [boldRuns, setBoldRuns] = useState<TextRange[]>(initialBoldRuns);
  const [italicRuns, setItalicRuns] = useState<TextRange[]>(initialItalicRuns);
  const [textAlign, setTextAlign] = useState<TextAlign>(initialTextAlign);

  const commit = (): void => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    onCommit();
  };
  const cancel = (): void => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    onCancel();
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.select();
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // Reports the full current content up to the parent on every change. onContentChange is a
  // stable (useCallback'd) reference from PdfPage, so this only actually re-fires when the
  // content itself changes — the initial fire on mount is a harmless no-op re-write of what the
  // parent already staged.
  useEffect(() => {
    onContentChange(text, color, backgroundColor, colorRuns, boldRuns, italicRuns, textAlign);
  }, [text, color, backgroundColor, colorRuns, boldRuns, italicRuns, textAlign, onContentChange]);

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const newText = e.target.value;
    // Reshape all three range lists for the edit *before* text state updates below — shifting
    // needs both the before and after text to isolate what actually changed.
    setColorRuns((prev) => shiftColorRunsForEdit(prev, text, newText));
    setBoldRuns((prev) => shiftTextRangesForEdit(prev, text, newText));
    setItalicRuns((prev) => shiftTextRangesForEdit(prev, text, newText));
    setText(newText);
    e.currentTarget.style.height = "auto";
    e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
  };

  // No selection (a collapsed caret): recolor the whole note, resetting any per-word colors —
  // matches the tool's original, pre-per-selection-color behavior, so previously-colored words
  // don't linger as a surprising leftover once you "recolor the whole thing". A real selection
  // instead colors just that character range.
  const handleColorPick = (pickedColor: string): void => {
    const el = textareaRef.current;
    if (el && el.selectionStart !== el.selectionEnd) {
      const { selectionStart: start, selectionEnd: end } = el;
      setColorRuns((prev) => applyColorRun(prev, start, end, pickedColor));
    } else {
      setColorRuns([]);
      setColor(pickedColor);
    }
  };

  // Bold/italic only ever act on an actual selection (unlike color, there's no sensible "whole
  // note" fallback for a boolean toggle triggered from a collapsed caret) and use standard
  // toggle semantics: fully-formatted selections turn it off, anything else turns it fully on.
  const handleToggleBold = (): void => {
    const el = textareaRef.current;
    if (!el || el.selectionStart === el.selectionEnd) return;
    const { selectionStart: start, selectionEnd: end } = el;
    setBoldRuns((prev) => toggleTextRange(prev, start, end));
  };
  const handleToggleItalic = (): void => {
    const el = textareaRef.current;
    if (!el || el.selectionStart === el.selectionEnd) return;
    const { selectionStart: start, selectionEnd: end } = el;
    setItalicRuns((prev) => toggleTextRange(prev, start, end));
  };

  const handleMovePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    e.preventDefault();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startLeft = left;
    const startTop = top;

    const handleMove = (moveEvent: PointerEvent): void => {
      const newLeft = startLeft + (moveEvent.clientX - startClientX);
      const newTop = startTop + (moveEvent.clientY - startClientY);
      wrapper.style.left = `${newLeft}px`;
      wrapper.style.top = `${newTop}px`;
    };
    const handleUp = (upEvent: PointerEvent): void => {
      handle.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onMoveEnd(parseFloat(wrapper.style.left), parseFloat(wrapper.style.top));
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    e.preventDefault();
    const textarea = textareaRef.current;
    if (!textarea) return;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    const startClientY = e.clientY;
    const startFontSize = fontSize;

    const handleMove = (moveEvent: PointerEvent): void => {
      const dy = startClientY - moveEvent.clientY; // dragging up grows the text, down shrinks it
      const nextSize = Math.min(MAX_FONT_SIZE_DEVICE_PX, Math.max(MIN_FONT_SIZE_DEVICE_PX, startFontSize + dy));
      textarea.style.font = `${nextSize}px ${TEXT_FONT_FAMILY}`;
      textarea.style.minHeight = `${nextSize * 1.3}px`;
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    const handleUp = (upEvent: PointerEvent): void => {
      handle.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      const finalSize = parseFloat(textarea.style.font) || startFontSize;
      onResizeEnd(finalSize);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const handleWidthResizePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    e.preventDefault();
    const wrapper = wrapperRef.current;
    const textarea = textareaRef.current;
    if (!wrapper || !textarea) return;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    const startClientX = e.clientX;
    const startWidth = width;

    const handleMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startClientX;
      const nextWidth = Math.min(MAX_WIDTH_DEVICE_PX, Math.max(MIN_WIDTH_DEVICE_PX, startWidth + dx));
      wrapper.style.width = `${nextWidth}px`;
      // Re-wrapping at the new width almost always changes how many lines are needed.
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    const handleUp = (upEvent: PointerEvent): void => {
      handle.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      const finalWidth = parseFloat(wrapper.style.width) || startWidth;
      onResizeWidthEnd(finalWidth);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  return (
    <div ref={wrapperRef} className="absolute" style={{ left, top, width, zIndex: 20 }}>
      {/* Header doubles as the move handle (drag anywhere on it) and hosts per-note quick
          controls — color, bold, italic. The control group stops propagation so clicking any of
          them opens/toggles instead of starting a drag; each control also suppresses its own
          mousedown default so it never steals focus away from the textarea (which would blur it
          and, for a still-empty new note, commit the session out from under the picker/buttons —
          see ColorSwatchPicker's mousedown handling for the original fix). */}
      <div
        onPointerDown={handleMovePointerDown}
        title="Drag to move"
        // A translucent, backdrop-blurred pill (not the page-relative bg-black/10 this used to be)
        // so the controls stay legible sitting directly on top of arbitrary page content — a dark
        // photo, a busy diagram — not just plain white/light backgrounds.
        className="h-7 px-1.5 flex items-center gap-1 justify-start rounded-t bg-white/80 dark:bg-neutral-800/85 backdrop-blur-md shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.1] hover:bg-white/90 dark:hover:bg-neutral-800/95 transition-colors"
        style={{ cursor: "move" }}
      >
        <div onPointerDown={(e) => e.stopPropagation()} className="flex items-center gap-1">
          <ColorSwatchPicker color={color} onChange={handleColorPick} size="sm" />
          <BackgroundSwatchPicker color={backgroundColor} onChange={setBackgroundColor} size="sm" />
          <button
            type="button"
            title="Bold selection"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleToggleBold}
            className="w-5 h-5 flex items-center justify-center rounded text-black/60 dark:text-white/70 hover:text-black dark:hover:text-white hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
          >
            <MdFormatBold size={14} />
          </button>
          <button
            type="button"
            title="Italicize selection"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleToggleItalic}
            className="w-5 h-5 flex items-center justify-center rounded text-black/60 dark:text-white/70 hover:text-black dark:hover:text-white hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
          >
            <MdFormatItalic size={14} />
          </button>
          <div className="w-px h-4 bg-black/10 dark:bg-white/15 mx-0.5" />
          {/* Alignment applies to the whole box, not a character selection - a plain single-select
              group (unlike bold/italic's per-selection toggle), so it stays active regardless of
              caret position. */}
          {ALIGN_OPTIONS.map(({ value, icon: Icon, title }) => (
            <button
              key={value}
              type="button"
              title={title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTextAlign(value)}
              className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${
                textAlign === value
                  ? "text-blue-600 dark:text-blue-400 bg-blue-500/10"
                  : "text-black/60 dark:text-white/70 hover:text-black dark:hover:text-white hover:bg-black/10 dark:hover:bg-white/10"
              }`}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      </div>
      <div
        onPointerDown={handleResizePointerDown}
        title="Drag to resize text"
        className="absolute top-0 right-0 w-4 h-4 flex items-center justify-center bg-black/10 hover:bg-black/25 transition-colors rounded-tr"
        style={{ cursor: "ns-resize" }}
      >
        <div className="w-1.5 h-1.5 border-r-2 border-b-2 border-black/50" />
      </div>
      {/* Width handle: a grab strip along the whole right edge, below the move bar / font-size
          corner so it doesn't fight them for the same pixels. */}
      <div
        onPointerDown={handleWidthResizePointerDown}
        title="Drag to resize width"
        className="absolute top-3 bottom-0 -right-1 w-2 group"
        style={{ cursor: "ew-resize" }}
      >
        <div className="absolute inset-y-0 right-0.5 w-0.5 rounded bg-black/10 group-hover:bg-blue-400 transition-colors" />
      </div>
      {/* Backdrop + textarea overlap exactly: the backdrop (below, z-0) carries the note's visible
          chrome and renders the real colored/bold/italic text; the textarea (above, z-1) is fully
          transparent except its caret, so it's what's actually focused/typed into/selected while
          looking like you're typing straight into the colored text underneath. */}
      <div style={{ position: "relative" }}>
        <div
          aria-hidden="true"
          className="absolute inset-0 whitespace-pre-wrap break-words pointer-events-none"
          style={{
            zIndex: 0,
            font: `${fontSize}px ${TEXT_FONT_FAMILY}`,
            lineHeight: 1.3,
            padding: 2,
            textAlign,
            border: "1px dashed rgba(0,0,0,0.3)",
            borderTop: "none",
            // Matches what actually gets baked into the page at commit (renderTextObject draws the
            // same fill, or none) — no fill picked reads as fully transparent here too, rather than
            // defaulting to an opaque white box that wouldn't actually be there once committed.
            background: backgroundColor ?? "transparent",
          }}
        >
          {renderFormattedSegments(text, colorRuns, boldRuns, italicRuns, color)}
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextareaChange}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation(); // don't let page-turn/undo-redo shortcuts fire while typing
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            } else if (e.key.toLowerCase() === "b" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleToggleBold();
            } else if (e.key.toLowerCase() === "i" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleToggleItalic();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()} // don't let the page's own click-to-place handler see this
          placeholder="Type a note…"
          className="block w-full shadow-sm relative placeholder-neutral-500"
          style={{
            zIndex: 1,
            minHeight: fontSize * 1.3,
            font: `${fontSize}px ${TEXT_FONT_FAMILY}`,
            color: "transparent",
            caretColor: CARET_COLOR,
            lineHeight: 1.3,
            textAlign,
            background: "transparent",
            border: "1px dashed transparent",
            borderTop: "none",
            padding: 2,
            resize: "none",
            overflow: "hidden",
            outline: "none",
          }}
        />
      </div>
    </div>
  );
};

export default TextNoteEditor;
