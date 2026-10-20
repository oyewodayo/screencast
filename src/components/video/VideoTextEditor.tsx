// components/video/VideoTextEditor.tsx
//
// In-place editor for a video text overlay when its controls live in the sidebar (the docked
// Text panel, OverlayDockedPanels.tsx). Adapted from TextNoteEditor (pdf/) - same transparent
// textarea over a formatted "backdrop", same staged-content contract with the parent
// (onContentChange after every change, onCommit on blur/Ctrl+Enter, onCancel on Escape) - but:
//
//  - no formatting bar on the box: colour, highlight, bold/italic and alignment come from the
//    sidebar through the imperative handle below, so the box on the video is just the text;
//  - the backdrop is drawn exactly like the finished overlay (VideoOverlayLayer's read-only
//    render): live font size, padding, outline, corner shape, background and shadow, so every
//    sidebar change shows on the text immediately instead of only after the edit ends.
//
// What's left on the box itself is the minimum to place it: a small grip to drag it, a corner
// handle for text size, and the right edge for wrap width.
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { IoMove } from "react-icons/io5";
import { TEXT_FONT_FAMILY, applyColorRun, shiftColorRunsForEdit, shiftTextRangesForEdit, toggleTextRange } from "../../handlers/pdfAnnotationHandlers";
import { TextAlign, TextColorRun, TextRange } from "../../utils/pdfAnnotationTypes";
import { renderFormattedSegments } from "../../utils/textFormatting";
import { TextOverlayCornerStyle } from "../../utils/videoEditTypes";

const MIN_FONT_SIZE_PX = 8;
const MAX_FONT_SIZE_PX = 400;
const MIN_WIDTH_PX = 40;

export interface VideoTextFormat {
  color: string;
  backgroundColor: string | undefined;
  textAlign: TextAlign;
}

export interface VideoTextEditorHandle {
  // Colour/bold/italic act on the selected characters - or on all of the text when nothing is
  // selected, so the sidebar buttons always do something visible.
  applyColor: (color: string) => void;
  toggleBold: () => void;
  toggleItalic: () => void;
  setBackground: (color: string | undefined) => void;
  setAlign: (align: TextAlign) => void;
}

interface VideoTextEditorProps {
  left: number;
  top: number;
  width: number;
  fontSize: number;
  paddingPx: number;
  strokeColor?: string;
  strokeWidth?: number;
  cornerStyle?: TextOverlayCornerStyle;
  initialText: string;
  initialColor: string;
  initialBackgroundColor: string | undefined;
  initialColorRuns: TextColorRun[];
  initialBoldRuns: TextRange[];
  initialItalicRuns: TextRange[];
  initialTextAlign: TextAlign;
  onContentChange: (
    text: string,
    color: string,
    backgroundColor: string | undefined,
    colorRuns: TextColorRun[],
    boldRuns: TextRange[],
    italicRuns: TextRange[],
    textAlign: TextAlign
  ) => void;
  // The whole-box formatting the sidebar displays as "current" (fires only when one changes).
  onFormatChange?: (format: VideoTextFormat) => void;
  onCommit: () => void;
  onCancel: () => void;
  onMoveEnd: (newLeft: number, newTop: number) => void;
  onResizeEnd: (newFontSize: number) => void;
  onResizeWidthEnd: (newWidth: number) => void;
}

const VideoTextEditor = forwardRef<VideoTextEditorHandle, VideoTextEditorProps>(
  (
    {
      left,
      top,
      width,
      fontSize,
      paddingPx,
      strokeColor,
      strokeWidth,
      cornerStyle,
      initialText,
      initialColor,
      initialBackgroundColor,
      initialColorRuns,
      initialBoldRuns,
      initialItalicRuns,
      initialTextAlign,
      onContentChange,
      onFormatChange,
      onCommit,
      onCancel,
      onMoveEnd,
      onResizeEnd,
      onResizeWidthEnd,
    },
    ref
  ) => {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const backdropRef = useRef<HTMLDivElement>(null);
    // Guards against commit AND cancel both firing for one session (see TextNoteEditor).
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

    // The range a formatting action applies to: the selection, or everything.
    const targetRange = (): [number, number] => {
      const el = textareaRef.current;
      if (el && el.selectionStart !== el.selectionEnd) return [el.selectionStart, el.selectionEnd];
      return [0, text.length];
    };

    useImperativeHandle(ref, () => ({
      applyColor: (picked) => {
        const el = textareaRef.current;
        if (el && el.selectionStart !== el.selectionEnd) {
          const { selectionStart: start, selectionEnd: end } = el;
          setColorRuns((prev) => applyColorRun(prev, start, end, picked));
        } else {
          setColorRuns([]);
          setColor(picked);
        }
      },
      toggleBold: () => {
        const [start, end] = targetRange();
        if (end > start) setBoldRuns((prev) => toggleTextRange(prev, start, end));
      },
      toggleItalic: () => {
        const [start, end] = targetRange();
        if (end > start) setItalicRuns((prev) => toggleTextRange(prev, start, end));
      },
      setBackground: setBackgroundColor,
      setAlign: setTextAlign,
    }));

    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }, []);

    useEffect(() => {
      onContentChange(text, color, backgroundColor, colorRuns, boldRuns, italicRuns, textAlign);
    }, [text, color, backgroundColor, colorRuns, boldRuns, italicRuns, textAlign, onContentChange]);

    useEffect(() => {
      onFormatChange?.({ color, backgroundColor, textAlign });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [color, backgroundColor, textAlign]);

    // Keeps the textarea exactly as tall as the formatted text it sits over, whatever changed it -
    // typing, or a size/padding/width change from the sidebar.
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }, [text, fontSize, paddingPx, width, boldRuns, italicRuns]);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
      const newText = e.target.value;
      setColorRuns((prev) => shiftColorRunsForEdit(prev, text, newText));
      setBoldRuns((prev) => shiftTextRangesForEdit(prev, text, newText));
      setItalicRuns((prev) => shiftTextRangesForEdit(prev, text, newText));
      setText(newText);
    };

    // Drag gestures stay imperative (direct style writes) until release, as in TextNoteEditor -
    // the final value goes up once, through the matching on*End callback.
    const startDrag = (
      e: React.PointerEvent<HTMLElement>,
      onMove: (dx: number, dy: number) => void,
      onUp: () => void
    ): void => {
      e.stopPropagation();
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const move = (ev: PointerEvent) => onMove(ev.clientX - startX, ev.clientY - startY);
      const up = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        onUp();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

    const handleMovePointerDown = (e: React.PointerEvent<HTMLElement>): void => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      startDrag(
        e,
        (dx, dy) => {
          wrapper.style.left = `${left + dx}px`;
          wrapper.style.top = `${top + dy}px`;
        },
        () => onMoveEnd(parseFloat(wrapper.style.left), parseFloat(wrapper.style.top))
      );
    };

    const handleSizePointerDown = (e: React.PointerEvent<HTMLElement>): void => {
      const textarea = textareaRef.current;
      const backdrop = backdropRef.current;
      if (!textarea || !backdrop) return;
      let next = fontSize;
      startDrag(
        e,
        (_dx, dy) => {
          next = Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, fontSize + dy));
          textarea.style.fontSize = `${next}px`;
          backdrop.style.fontSize = `${next}px`;
          textarea.style.height = "auto";
          textarea.style.height = `${textarea.scrollHeight}px`;
        },
        () => onResizeEnd(next)
      );
    };

    const handleWidthPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
      const wrapper = wrapperRef.current;
      const textarea = textareaRef.current;
      if (!wrapper || !textarea) return;
      let next = width;
      startDrag(
        e,
        (dx) => {
          next = Math.max(MIN_WIDTH_PX, width + dx);
          wrapper.style.width = `${next}px`;
          textarea.style.height = "auto";
          textarea.style.height = `${textarea.scrollHeight}px`;
        },
        () => onResizeWidthEnd(next)
      );
    };

    const hasStroke = !!(strokeColor && strokeWidth);
    // Same look VideoOverlayLayer gives the committed overlay - keep the two in step.
    const shared: React.CSSProperties = {
      fontFamily: TEXT_FONT_FAMILY,
      fontSize,
      lineHeight: 1.3,
      padding: paddingPx,
      textAlign,
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
    };

    return (
      <div ref={wrapperRef} className="absolute" style={{ left, top, width, zIndex: 20 }}>
        <div
          ref={backdropRef}
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none"
          style={{
            ...shared,
            background: backgroundColor ?? "transparent",
            borderRadius: cornerStyle === "pill" ? 9999 : cornerStyle === "rounded" ? 8 : 0,
            WebkitTextStroke: hasStroke ? `${strokeWidth}px ${strokeColor}` : undefined,
            paintOrder: hasStroke ? "stroke fill" : undefined,
            textShadow: backgroundColor || hasStroke ? undefined : "0 1px 3px rgba(0,0,0,0.85), 0 0 6px rgba(0,0,0,0.5)",
          }}
        >
          {renderFormattedSegments(text, colorRuns, boldRuns, italicRuns, color)}
          {/* A trailing newline in a textarea adds a line the backdrop wouldn't otherwise have. */}
          {text.endsWith("\n") ? "​" : null}
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation(); // keep the timeline's shortcuts out of typing
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            } else if (e.key.toLowerCase() === "b" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              const [start, end] = targetRange();
              if (end > start) setBoldRuns((prev) => toggleTextRange(prev, start, end));
            } else if (e.key.toLowerCase() === "i" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              const [start, end] = targetRange();
              if (end > start) setItalicRuns((prev) => toggleTextRange(prev, start, end));
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="Type something…"
          rows={1}
          className="relative block w-full placeholder-white/50"
          style={{
            ...shared,
            minHeight: fontSize * 1.3 + paddingPx * 2,
            color: "transparent",
            caretColor: color,
            background: "transparent",
            border: "none",
            resize: "none",
            overflow: "hidden",
            outline: "1.5px dashed rgba(255,255,255,0.7)",
            outlineOffset: 3,
          }}
        />
        {/* Move grip, just outside the top-left corner. */}
        <button
          type="button"
          title="Drag to move"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={handleMovePointerDown}
          className="absolute -left-3 -top-3 w-6 h-6 flex items-center justify-center rounded-full bg-blue-500 text-white shadow-md ring-2 ring-white/80 hover:bg-blue-400"
          style={{ cursor: "move" }}
        >
          <IoMove size={13} />
        </button>
        {/* Text size: drag the bottom-right handle down to grow, up to shrink. */}
        <div
          title="Drag to resize the text"
          onPointerDown={handleSizePointerDown}
          className="absolute -right-2 -bottom-2 w-3.5 h-3.5 rounded-sm bg-white ring-2 ring-blue-500 shadow"
          style={{ cursor: "nwse-resize" }}
        />
        {/* Wrap width: the right edge. */}
        <div
          title="Drag to change the width"
          onPointerDown={handleWidthPointerDown}
          className="absolute top-2 bottom-4 -right-2 w-2 group"
          style={{ cursor: "ew-resize" }}
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-1 rounded bg-white/40 group-hover:bg-blue-400 transition-colors" />
        </div>
      </div>
    );
  }
);

VideoTextEditor.displayName = "VideoTextEditor";

export default VideoTextEditor;
