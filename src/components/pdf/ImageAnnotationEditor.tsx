// components/pdf/ImageAnnotationEditor.tsx
import React, { useRef } from "react";

const HANDLE_SIZE = 10;
const ROTATE_HANDLE_OFFSET = 24; // device px above the top edge
const MIN_DIAGONAL_DEVICE_PX = 24;
const ROTATE_SNAP_RADIANS = Math.PI / 12; // 15°, applied while Shift is held

interface ImageAnnotationEditorProps {
  left: number; // device/CSS px, relative to the page's canvas stack (same convention as TextNoteEditor)
  top: number;
  width: number;
  height: number;
  rotation: number; // radians, fed straight into ctx.rotate()/CSS rotate() — see the sign-convention
  // note on rotatePointAroundCenter in pdfAnnotationHandlers.ts if touching the hit-test math.
  src: string;
  onMoveEnd: (newLeft: number, newTop: number) => void;
  onResizeEnd: (newWidth: number, newHeight: number, newLeft: number, newTop: number) => void;
  onRotateEnd: (newRotation: number) => void;
  onDelete: () => void;
}

// A selected image's move/resize/rotate chrome. Follows TextNoteEditor.tsx's pattern exactly:
// each gesture is driven by direct style mutation on wrapperRef during pointermove (no React
// re-render mid-drag) and reports only the final value to the parent on release. Unlike text,
// images support rotation, so resize here is center-anchored and aspect-locked rather than
// opposite-corner-anchored — that avoids needing to track which screen-space corner a given local
// corner maps to as the box spins, and matches how most editors handle rotatable image resize.
const ImageAnnotationEditor: React.FC<ImageAnnotationEditorProps> = ({
  left,
  top,
  width,
  height,
  rotation,
  src,
  onMoveEnd,
  onResizeEnd,
  onRotateEnd,
  onDelete,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);

  // `left`/`top`/`width`/`height` (and therefore centerX/centerY below) are in *page-local*
  // coordinates — relative to the wrapper's positioned ancestor (the page's canvas-stack
  // container in PdfPage.tsx) — but PointerEvent.clientX/clientY are viewport-relative. Those two
  // spaces only coincide if that container sits at the browser's top-left corner, which it never
  // does (toolbar, padding, centered/scrollable layout). Resize/rotate need the *absolute*
  // pointer position (to measure distance/angle from a fixed center), so — unlike the move
  // handler above, which only ever diffs two client-space readings and so doesn't care — they
  // must convert through this on every move (not just once at pointerdown, so a mid-gesture
  // scroll doesn't throw it off either).
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

  // Center-anchored, aspect-locked resize: the box's screen-space center stays fixed while
  // width/height scale together. The pointer's offset from center is rotated by -rotation into
  // the box's own (unrotated) local axes before measuring distance, so dragging a corner scales
  // along the box's axes rather than the screen's — this is plain device-space trigonometry (no
  // PDF-space involved), so the sign is the everyday "undo a +rotation" -rotation, unlike the
  // hit-test math in pdfAnnotationHandlers.ts which crosses a y-up/y-down boundary.
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
    const startDist = Math.hypot(startWidth / 2, startHeight / 2);
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);

    const handleMove = (moveEvent: PointerEvent): void => {
      const pointerLocal = clientToLocal(moveEvent.clientX, moveEvent.clientY);
      const dx = pointerLocal.x - centerX;
      const dy = pointerLocal.y - centerY;
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;
      const currentDist = Math.hypot(localX, localY);
      const scale = Math.max(MIN_DIAGONAL_DEVICE_PX / startDist, currentDist / startDist);

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
      onResizeEnd(
        parseFloat(wrapper.style.width),
        parseFloat(wrapper.style.height),
        parseFloat(wrapper.style.left),
        parseFloat(wrapper.style.top)
      );
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
      <div onPointerDown={handleMovePointerDown} title="Drag to move" className="absolute inset-0 ring-2 ring-blue-500" style={{ cursor: "move" }}>
        <img src={src} alt="" draggable={false} className="w-full h-full object-fill pointer-events-none select-none" />
      </div>

      {([[true, true], [false, true], [true, false], [false, false]] as const).map(([cornerLeft, cornerTop]) => (
        <div
          key={`${cornerLeft}-${cornerTop}`}
          onPointerDown={handleResizePointerDown}
          title="Drag to resize"
          className="bg-white border-2 border-blue-500 rounded-full shadow-sm"
          style={cornerHandleStyle(cornerLeft, cornerTop)}
        />
      ))}

      <div
        onPointerDown={handleRotatePointerDown}
        title="Drag to rotate (hold Shift to snap to 15°)"
        className="absolute bg-white border-2 border-blue-500 rounded-full shadow-sm"
        style={{ left: width / 2 - HANDLE_SIZE / 2, top: -ROTATE_HANDLE_OFFSET - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE, cursor: "grab" }}
      />
      <div
        className="absolute bg-blue-500 pointer-events-none"
        style={{ left: width / 2 - 1, top: -ROTATE_HANDLE_OFFSET, width: 2, height: ROTATE_HANDLE_OFFSET }}
      />

      <button
        type="button"
        title="Delete image"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onDelete}
        className="absolute -top-3 -left-3 w-6 h-6 flex items-center justify-center rounded-full bg-white border border-black/10 shadow-sm text-neutral-600 hover:text-red-600 hover:border-red-300 text-xs leading-none"
      >
        ×
      </button>
    </div>
  );
};

export default ImageAnnotationEditor;
