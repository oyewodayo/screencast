// components/image/TextAnnotationEditor.tsx
//
// A selected text object's move/resize/rotate chrome - text's counterpart to
// ImageAnnotationEditor.tsx (reused as-is for placed images), following the exact same pattern:
// each gesture is driven by direct style mutation on wrapperRef during pointermove (no React
// re-render mid-drag), reporting only the final value to the parent on release. The one real
// difference: an image's resize directly sets width/height, but text has no independent
// width/height to set - both are derived from fontSize plus the string's own measured width (see
// textObjectBounds in imageEditHandlers.ts) - so resize here scales fontSize instead, using the
// same center-anchored, rotation-aware distance-from-center math ImageAnnotationEditor's own
// resize already uses.
import React, { useRef } from "react";

const HANDLE_SIZE = 10;
const ROTATE_HANDLE_OFFSET = 24; // device px above the top edge
const MIN_FONT_SIZE = 8;
const ROTATE_SNAP_RADIANS = Math.PI / 12; // 15°, applied while Shift is held

interface TextAnnotationEditorProps {
  left: number; // device/CSS px, relative to the canvas stack (same convention as ImageAnnotationEditor)
  top: number;
  width: number;
  height: number;
  rotation: number; // radians
  fontSize: number; // natural (unzoomed) px - the value the resize handles actually scale
  onMoveEnd: (newLeft: number, newTop: number) => void;
  onResizeEnd: (newFontSize: number) => void;
  onRotateEnd: (newRotation: number) => void;
  onDelete: () => void;
  // Re-enters inline text editing. Handled directly on the move-handle below rather than relying
  // on a native dblclick bubbling up to ImageEditorCanvas's own onDoubleClick - this overlay (not
  // the canvas underneath) is the actual double-click target once an object is selected, and every
  // click here already goes through setPointerCapture/preventDefault/a full move-gesture setup
  // (see handleMovePointerDown), any one of which is a plausible way for a double-click to end up
  // not registering as one in some browser/webview - handling it locally sidesteps that entirely
  // instead of needing to prove bubbling behaves as expected everywhere this runs.
  onDoubleClick: () => void;
}

const TextAnnotationEditor: React.FC<TextAnnotationEditorProps> = ({
  left,
  top,
  width,
  height,
  rotation,
  fontSize,
  onMoveEnd,
  onResizeEnd,
  onRotateEnd,
  onDelete,
  onDoubleClick,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);

  // See ImageAnnotationEditor's own doc comment on this exact helper for why resize/rotate need
  // it (converting viewport-relative pointer coordinates into the same page-local space
  // left/top/width/height are already in) while move doesn't (it only ever diffs two client-space
  // readings).
  const clientToLocal = (clientX: number, clientY: number): { x: number; y: number } => {
    const parent = wrapperRef.current?.offsetParent as HTMLElement | null;
    const rect = parent?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
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
      wrapper.style.left = `${startLeft + (moveEvent.clientX - startClientX)}px`;
      wrapper.style.top = `${startTop + (moveEvent.clientY - startClientY)}px`;
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

  // Center-anchored uniform scale of fontSize - the pointer's offset from center is rotated by
  // -rotation into the box's own (unrotated) local axes first, so dragging a corner scales along
  // the text's own axes rather than the screen's, same reasoning as ImageAnnotationEditor's resize.
  // The live wrapper resize (width/height/left/top) is cosmetic - a growing/shrinking outline box
  // for feedback during the drag - the actual on-canvas text only re-renders once onResizeEnd
  // commits the new fontSize, same "DOM chrome moves live, canvas commits on release" split
  // ImageAnnotationEditor's own resize already uses for images.
  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    e.preventDefault();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    const centerX = left + width / 2;
    const centerY = top + height / 2;
    const startWidth = width;
    const startHeight = height;
    const startDist = Math.max(1, Math.hypot(startWidth / 2, startHeight / 2));
    const startFontSize = fontSize;
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    let liveFontSize = fontSize;

    const handleMove = (moveEvent: PointerEvent): void => {
      const pointerLocal = clientToLocal(moveEvent.clientX, moveEvent.clientY);
      const dx = pointerLocal.x - centerX;
      const dy = pointerLocal.y - centerY;
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;
      const currentDist = Math.hypot(localX, localY);
      const scale = Math.max(MIN_FONT_SIZE / startFontSize, currentDist / startDist);

      liveFontSize = startFontSize * scale;
      const newWidth = startWidth * scale;
      const newHeight = startHeight * scale;
      wrapper.style.width = `${newWidth}px`;
      wrapper.style.height = `${newHeight}px`;
      wrapper.style.left = `${centerX - newWidth / 2}px`;
      wrapper.style.top = `${centerY - newHeight / 2}px`;
    };
    const handleUp = (upEvent: PointerEvent): void => {
      handle.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onResizeEnd(Math.round(liveFontSize));
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const handleRotatePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    e.preventDefault();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    const centerX = left + width / 2;
    const centerY = top + height / 2;
    const startPointerLocal = clientToLocal(e.clientX, e.clientY);
    const startAngle = Math.atan2(startPointerLocal.y - centerY, startPointerLocal.x - centerX);
    const startRotation = rotation;
    let liveRotation = rotation;

    const handleMove = (moveEvent: PointerEvent): void => {
      const pointerLocal = clientToLocal(moveEvent.clientX, moveEvent.clientY);
      const angle = Math.atan2(pointerLocal.y - centerY, pointerLocal.x - centerX);
      let next = startRotation + (angle - startAngle);
      if (moveEvent.shiftKey) next = Math.round(next / ROTATE_SNAP_RADIANS) * ROTATE_SNAP_RADIANS;
      liveRotation = next;
      wrapper.style.transform = `rotate(${next}rad)`;
    };
    const handleUp = (upEvent: PointerEvent): void => {
      handle.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onRotateEnd(liveRotation);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const cornerHandleStyle = (cornerLeft: boolean, cornerTop: boolean): React.CSSProperties => ({
    position: "absolute",
    left: cornerLeft ? -HANDLE_SIZE / 2 : undefined,
    right: cornerLeft ? undefined : -HANDLE_SIZE / 2,
    top: cornerTop ? -HANDLE_SIZE / 2 : undefined,
    bottom: cornerTop ? undefined : -HANDLE_SIZE / 2,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    cursor: cornerLeft === cornerTop ? "nwse-resize" : "nesw-resize",
  });

  return (
    <div
      ref={wrapperRef}
      className="absolute"
      style={{ left, top, width, height, transform: `rotate(${rotation}rad)`, transformOrigin: "center center", zIndex: 20 }}
    >
      <div
        onPointerDown={handleMovePointerDown}
        onDoubleClick={onDoubleClick}
        title="Drag to move (double-click to edit text)"
        className="absolute inset-0 ring-2 ring-blue-500 rounded-sm"
        style={{ cursor: "move" }}
      />

      {([[true, true], [false, true], [true, false], [false, false]] as const).map(([cornerLeft, cornerTop]) => (
        <div
          key={`${cornerLeft}-${cornerTop}`}
          onPointerDown={handleResizePointerDown}
          title="Drag to resize text"
          className="bg-white border-2 border-blue-500 rounded-full shadow-sm"
          style={cornerHandleStyle(cornerLeft, cornerTop)}
        />
      ))}

      <div
        onPointerDown={handleRotatePointerDown}
        title="Drag to rotate (hold Shift to snap to 15°)"
        className="absolute bg-white border-2 border-blue-500 rounded-full shadow-sm"
        style={{
          left: width / 2 - HANDLE_SIZE / 2,
          top: -ROTATE_HANDLE_OFFSET - HANDLE_SIZE / 2,
          width: HANDLE_SIZE,
          height: HANDLE_SIZE,
          cursor: "grab",
        }}
      />
      <div
        className="absolute bg-blue-500 pointer-events-none"
        style={{ left: width / 2 - 1, top: -ROTATE_HANDLE_OFFSET, width: 2, height: ROTATE_HANDLE_OFFSET }}
      />

      <button
        type="button"
        title="Delete text"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onDelete}
        className="absolute -top-3 -left-3 w-6 h-6 flex items-center justify-center rounded-full bg-white border border-black/10 shadow-sm text-neutral-600 hover:text-red-600 hover:border-red-300 text-xs leading-none"
      >
        ×
      </button>
    </div>
  );
};

export default TextAnnotationEditor;
