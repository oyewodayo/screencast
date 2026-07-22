// components/pdf/TextNoteEditor.tsx
import React, { useEffect, useRef, useState } from "react";
import { MdFormatBold, MdFormatItalic } from "react-icons/md";
import { TEXT_FONT_FAMILY, applyColorRun, shiftColorRunsForEdit, shiftTextRangesForEdit, toggleTextRange } from "../../handlers/pdfAnnotationHandlers";
import { TextColorRun, TextRange } from "../../utils/pdfAnnotationTypes";
import ColorSwatchPicker from "./ColorSwatchPicker";

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
  initialColorRuns: TextColorRun[];
  initialBoldRuns: TextRange[];
  initialItalicRuns: TextRange[];
  // Fired after every change (keystroke, color pick, bold/italic toggle) with the full current
  // content — the parent stages it in refs (not state) and only actually persists it at commit,
  // same "not React state up there" reasoning liveTextRef used before this component started
  // managing its own live formatting state locally for the backdrop preview below.
  onContentChange: (text: string, color: string, colorRuns: TextColorRun[], boldRuns: TextRange[], italicRuns: TextRange[]) => void;
  onCommit: () => void;
  onCancel: () => void;
  onMoveEnd: (newLeft: number, newTop: number) => void;
  onResizeEnd: (newFontSize: number) => void;
  onResizeWidthEnd: (newWidth: number) => void;
}

// Splits `text` into colored/bold/italic <span> segments at every formatting boundary — the DOM
// counterpart to renderTextObject's canvas version in pdfAnnotationHandlers.ts, same boundary-cut
// approach, just emitting React nodes instead of fillText calls (the browser does the actual line
// wrapping here, via the backdrop's own CSS, rather than a manual wrapTextBlock pass).
function renderFormattedSegments(
  text: string,
  colorRuns: TextColorRun[],
  boldRuns: TextRange[],
  italicRuns: TextRange[],
  baseColor: string
): React.ReactNode {
  if (text.length === 0) return null;

  const cutSet = new Set<number>([0, text.length]);
  const addBoundaries = (ranges: TextRange[]): void => {
    for (const range of ranges) {
      cutSet.add(Math.max(0, Math.min(text.length, range.start)));
      cutSet.add(Math.max(0, Math.min(text.length, range.end)));
    }
  };
  addBoundaries(colorRuns);
  addBoundaries(boldRuns);
  addBoundaries(italicRuns);
  const cuts = Array.from(cutSet).sort((a, b) => a - b);

  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i];
    const end = cuts[i + 1];
    if (end <= start) continue;
    const segment = text.slice(start, end);
    const color = colorRuns.find((run) => run.start <= start && run.end >= end)?.color ?? baseColor;
    const bold = boldRuns.some((run) => run.start <= start && run.end >= end);
    const italic = italicRuns.some((run) => run.start <= start && run.end >= end);
    nodes.push(
      <span key={start} style={{ color, fontWeight: bold ? 700 : 400, fontStyle: italic ? "italic" : "normal" }}>
        {segment}
      </span>
    );
  }
  return nodes;
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
  initialColorRuns,
  initialBoldRuns,
  initialItalicRuns,
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
  const [colorRuns, setColorRuns] = useState<TextColorRun[]>(initialColorRuns);
  const [boldRuns, setBoldRuns] = useState<TextRange[]>(initialBoldRuns);
  const [italicRuns, setItalicRuns] = useState<TextRange[]>(initialItalicRuns);

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
    onContentChange(text, color, colorRuns, boldRuns, italicRuns);
  }, [text, color, colorRuns, boldRuns, italicRuns, onContentChange]);

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
        className="h-7 px-1.5 flex items-center gap-1 justify-start rounded-t bg-black/10 hover:bg-black/20 transition-colors"
        style={{ cursor: "move" }}
      >
        <div onPointerDown={(e) => e.stopPropagation()} className="flex items-center gap-1">
          <ColorSwatchPicker color={color} onChange={handleColorPick} size="sm" />
          <button
            type="button"
            title="Bold selection"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleToggleBold}
            className="w-5 h-5 flex items-center justify-center rounded text-black/60 hover:text-black hover:bg-black/10 transition-colors"
          >
            <MdFormatBold size={14} />
          </button>
          <button
            type="button"
            title="Italicize selection"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleToggleItalic}
            className="w-5 h-5 flex items-center justify-center rounded text-black/60 hover:text-black hover:bg-black/10 transition-colors"
          >
            <MdFormatItalic size={14} />
          </button>
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
            border: "1px dashed rgba(0,0,0,0.3)",
            borderTop: "none",
            background: "rgba(255,255,255,0.92)",
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
