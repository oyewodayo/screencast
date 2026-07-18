// components/pdf/TextNoteEditor.tsx
import React, { useEffect, useRef } from "react";
import { TEXT_FONT_FAMILY } from "../../handlers/pdfAnnotationHandlers";

const MIN_FONT_SIZE_DEVICE_PX = 8;
const MAX_FONT_SIZE_DEVICE_PX = 200;

interface TextNoteEditorProps {
  left: number; // device/CSS px, relative to the page's canvas stack
  top: number;
  width: number;
  fontSize: number;
  color: string;
  initialText: string;
  onTextChange: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onMoveEnd: (newLeft: number, newTop: number) => void;
  onResizeEnd: (newFontSize: number) => void;
}

// A real DOM <textarea> overlaid on the page at the note's position — canvas can't accept
// keyboard text input directly, so editing happens here and only gets baked into the overlay
// canvas (via renderObject in pdfAnnotationHandlers) once committed. A small header strip above
// it drags the whole note; a corner handle at its top-right resizes the font. Both are purely
// imperative (direct style mutation) while a drag is in progress — no React re-renders per
// pixel — and only report the *final* value to the parent once, on release.
const TextNoteEditor: React.FC<TextNoteEditorProps> = ({
  left,
  top,
  width,
  fontSize,
  color,
  initialText,
  onTextChange,
  onCommit,
  onCancel,
  onMoveEnd,
  onResizeEnd,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Guards against commit AND cancel both firing for the same session — e.g. Escape triggers
  // onCancel synchronously, which unmounts this component, which can itself fire a native blur
  // on the way out. Without this, that stray blur would call onCommit right after onCancel
  // already resolved the session, corrupting whatever happened next (a fresh add, a new edit).
  const resolvedRef = useRef(false);

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

  return (
    <div ref={wrapperRef} className="absolute" style={{ left, top, width, zIndex: 20 }}>
      <div
        onPointerDown={handleMovePointerDown}
        title="Drag to move"
        className="h-3 rounded-t bg-black/10 hover:bg-black/25 transition-colors"
        style={{ cursor: "move" }}
      />
      <div
        onPointerDown={handleResizePointerDown}
        title="Drag to resize text"
        className="absolute top-0 right-0 w-4 h-4 flex items-center justify-center bg-black/10 hover:bg-black/25 transition-colors rounded-tr"
        style={{ cursor: "ns-resize" }}
      >
        <div className="w-1.5 h-1.5 border-r-2 border-b-2 border-black/50" />
      </div>
      <textarea
        ref={textareaRef}
        defaultValue={initialText}
        onChange={(e) => {
          onTextChange(e.target.value);
          e.currentTarget.style.height = "auto";
          e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation(); // don't let page-turn/undo-redo shortcuts fire while typing
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          }
        }}
        onPointerDown={(e) => e.stopPropagation()} // don't let the page's own click-to-place handler see this
        placeholder="Type a note…"
        className="block w-full shadow-sm"
        style={{
          minHeight: fontSize * 1.3,
          font: `${fontSize}px ${TEXT_FONT_FAMILY}`,
          color,
          lineHeight: 1.3,
          background: "rgba(255,255,255,0.92)",
          border: "1px dashed rgba(0,0,0,0.3)",
          borderTop: "none",
          padding: 2,
          resize: "none",
          overflow: "hidden",
          outline: "none",
        }}
      />
    </div>
  );
};

export default TextNoteEditor;
