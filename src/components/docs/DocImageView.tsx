// components/docs/DocImageView.tsx
//
// The first custom Tiptap NodeView in this codebase - registered via DocImage.addNodeView() in
// docSchemaExtensions.ts. Fully owns live-editor rendering of an `image` node: draws the <img> at
// its committed width/height (node.attrs, or natural/max-width when unset), and - only while
// `selected` (the prop Tiptap passes directly, not a CSS class) - renders resize handles, a drag
// grip, and a small Crop/Delete toolbar. The image is an inline node (docSchemaExtensions.ts's
// `inline: true`), so it can sit anywhere within a line of text, not just as its own block between
// paragraphs - the NodeViewWrapper below renders as a <span> (not a <div>) accordingly, since a
// block-level tag can't legally sit inside a <p>.
import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeViewWrapper, NodeViewProps } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import { MdCrop, MdDelete, MdDragIndicator } from "react-icons/md";
import DocImageCropModal from "./DocImageCropModal";

const MIN_SIZE = 40;
type Handle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
const HANDLES: Handle[] = ["nw", "ne", "sw", "se", "n", "s", "e", "w"];
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const HANDLE_POSITION_CLASS: Record<Handle, string> = {
  nw: "-left-1.5 -top-1.5 cursor-nwse-resize",
  ne: "-right-1.5 -top-1.5 cursor-nesw-resize",
  sw: "-left-1.5 -bottom-1.5 cursor-nesw-resize",
  se: "-right-1.5 -bottom-1.5 cursor-nwse-resize",
  n: "left-1/2 -translate-x-1/2 -top-1.5 cursor-ns-resize",
  s: "left-1/2 -translate-x-1/2 -bottom-1.5 cursor-ns-resize",
  e: "-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize",
  w: "-left-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize",
};

interface DragState {
  handle: Handle;
  startClientX: number;
  startClientY: number;
  startWidth: number;
  startHeight: number;
  aspect: number;
}

// Shared by the live drop-indicator (during pointermove) and the actual move (on pointerup) - both
// need to answer "exactly which text position would the image land at if dropped here", resolved
// against the CURRENT (not-yet-modified) doc so the indicator and the eventual drop are always in
// exact agreement. The image is an inline node (docSchemaExtensions.ts's DocImage.configure({
// inline: true, ... })), so it can go anywhere inline content can - no snapping to a block boundary
// needed, unlike the block-node version of this feature this replaced.
function resolveInlinePos(view: EditorView, clientX: number, clientY: number): number | null {
  const coords = view.posAtCoords({ left: clientX, top: clientY });
  return coords ? coords.pos : null;
}

interface DropIndicatorRect {
  left: number;
  top: number;
  height: number;
}

const DocImageView: React.FC<NodeViewProps> = ({ node, selected, updateAttributes, deleteNode, extension, view, getPos }) => {
  const docId = (extension.options as { docId: string | null }).docId;
  const imgRef = useRef<HTMLImageElement>(null);
  const [showCrop, setShowCrop] = useState(false);

  // Live-drag size, independent from the committed node.attrs - only flows into updateAttributes
  // on pointerup (see endResize), so intermediate resize frames never hit the Y.Doc.
  const [liveSize, setLiveSize] = useState<{ width: number; height: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const latestRef = useRef<{ clientX: number; clientY: number } | null>(null);

  const committedWidth = node.attrs.width as number | null;
  const committedHeight = node.attrs.height as number | null;
  const displayWidth = liveSize?.width ?? committedWidth ?? undefined;
  const displayHeight = liveSize?.height ?? committedHeight ?? undefined;

  const beginResize = (handle: Handle) => (e: React.PointerEvent) => {
    const img = imgRef.current;
    if (!img) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startWidth = committedWidth ?? img.clientWidth;
    const startHeight = committedHeight ?? img.clientHeight;
    dragRef.current = {
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWidth,
      startHeight,
      aspect: startWidth / startHeight,
    };
    setLiveSize({ width: startWidth, height: startHeight });
  };

  const handleResizeMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    latestRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const drag = dragRef.current;
      const latest = latestRef.current;
      if (!drag || !latest) return;
      const dx = latest.clientX - drag.startClientX;
      const dy = latest.clientY - drag.startClientY;
      const { handle, startWidth, startHeight, aspect } = drag;

      let width = startWidth;
      let height = startHeight;

      const isCorner = handle.length === 2;
      if (isCorner) {
        // Corner handles: aspect-locked. Drive off whichever axis has the larger |delta| so
        // diagonal drag direction works regardless of the image's own aspect ratio.
        const signX = handle.includes("e") ? 1 : -1;
        const signY = handle.includes("s") ? 1 : -1;
        const dxAdj = dx * signX;
        const dyAdj = dy * signY;
        if (Math.abs(dxAdj) >= Math.abs(dyAdj)) {
          width = clamp(startWidth + dxAdj, MIN_SIZE, Number.MAX_SAFE_INTEGER);
          height = width / aspect;
        } else {
          height = clamp(startHeight + dyAdj, MIN_SIZE, Number.MAX_SAFE_INTEGER);
          width = height * aspect;
        }
      } else {
        // Edge midpoint handles: single-axis only ("drag from edge to resize").
        if (handle === "e") width = clamp(startWidth + dx, MIN_SIZE, Number.MAX_SAFE_INTEGER);
        if (handle === "w") width = clamp(startWidth - dx, MIN_SIZE, Number.MAX_SAFE_INTEGER);
        if (handle === "s") height = clamp(startHeight + dy, MIN_SIZE, Number.MAX_SAFE_INTEGER);
        if (handle === "n") height = clamp(startHeight - dy, MIN_SIZE, Number.MAX_SAFE_INTEGER);
      }

      setLiveSize({ width: Math.round(width), height: Math.round(height) });
    });
  };

  const endResize = () => {
    if (!dragRef.current) return;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    dragRef.current = null;
    setLiveSize((size) => {
      if (size) updateAttributes({ width: size.width, height: size.height });
      return null; // fall back to the now-committed node.attrs on the next render
    });
  };

  const handleCropApplied = (newSrc: string) => {
    // Cleared rather than kept, so the cropped image re-renders at its new natural size instead
    // of stretching into the old (now wrong) aspect ratio - the user can re-resize afterward.
    updateAttributes({ src: newSrc, width: null, height: null });
    setShowCrop(false);
  };

  // Direct pointer-driven move rather than native HTML5 drag-and-drop (which Tiptap normally
  // supports via a data-drag-handle attribute) - ReactNodeViewRenderer wraps this component's own
  // rendered element inside a SEPARATE outer container that ProseMirror actually treats as the
  // node's `dom` (and auto-marks draggable=true), so a native dragstart's target ends up being
  // that outer container, not anything inside this component - the onDragStart wiring NodeView-
  // Wrapper attaches to its own (inner, descendant) element can never receive it, since dragstart
  // doesn't propagate to descendants. Moving the node with a plain pointer gesture - delete it
  // from its current position, then insert it at wherever the pointer released - sidesteps that
  // entirely and matches the same "stage locally, commit on release" shape resize/crop use above.
  const isMovingRef = useRef(false);
  const pendingDropPosRef = useRef<number | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const moveLatestRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicatorRect | null>(null);

  const beginMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    isMovingRef.current = true;
    pendingDropPosRef.current = null;
  };

  const handleMoveMove = (e: React.PointerEvent) => {
    if (!isMovingRef.current) return;
    e.stopPropagation();
    moveLatestRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (moveRafRef.current != null) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const latest = moveLatestRef.current;
      if (!latest) return;
      const insertPos = resolveInlinePos(view, latest.clientX, latest.clientY);
      pendingDropPosRef.current = insertPos;
      if (insertPos == null) {
        setDropIndicator(null);
        return;
      }
      try {
        // A thin vertical caret at the exact character position, mimicking a text cursor - bottom
        // minus top naturally gives the correct line-height at that point with no extra work.
        const coords = view.coordsAtPos(insertPos);
        setDropIndicator({ left: coords.left, top: coords.top, height: coords.bottom - coords.top });
      } catch {
        setDropIndicator(null);
      }
    });
  };

  const cancelMove = () => {
    isMovingRef.current = false;
    pendingDropPosRef.current = null;
    if (moveRafRef.current != null) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
    setDropIndicator(null);
  };

  const handleMoveUp = (e: React.PointerEvent) => {
    if (!isMovingRef.current) return;
    e.stopPropagation();
    const insertPos = pendingDropPosRef.current ?? resolveInlinePos(view, e.clientX, e.clientY);
    cancelMove();
    if (insertPos == null) return;
    try {
      const pos = getPos();
      if (typeof pos !== "number") return;
      const currentNode = view.state.doc.nodeAt(pos);
      if (!currentNode) return;

      let tr = view.state.tr.delete(pos, pos + currentNode.nodeSize);
      const mappedTarget = Math.min(tr.mapping.map(insertPos), tr.doc.content.size);
      tr = tr.insert(mappedTarget, currentNode);
      view.dispatch(tr);
    } catch (err) {
      console.error("Failed to move image:", err);
    }
  };

  return (
    <NodeViewWrapper as="span" className="relative inline-block max-w-full">
      <img
        ref={imgRef}
        src={node.attrs.src}
        alt={node.attrs.alt ?? ""}
        title={node.attrs.title ?? undefined}
        style={{ width: displayWidth, height: displayHeight }}
        className={`rounded-md max-w-full block cursor-pointer ${selected ? "outline outline-2 outline-blue-500 outline-offset-2" : ""}`}
      />

      {selected && (
        <>
          {HANDLES.map((handle) => (
            <div
              key={handle}
              onPointerDown={beginResize(handle)}
              onPointerMove={handleResizeMove}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className={`absolute w-3 h-3 rounded-full bg-blue-500 ring-2 ring-white ${HANDLE_POSITION_CLASS[handle]}`}
            />
          ))}

          <div className="absolute -top-8 left-0 flex items-center gap-1 bg-neutral-900 text-white rounded-md px-1.5 py-1 shadow-lg">
            <span
              onPointerDown={beginMove}
              onPointerMove={handleMoveMove}
              onPointerUp={handleMoveUp}
              onPointerCancel={cancelMove}
              className="cursor-grab active:cursor-grabbing p-0.5 hover:bg-white/10 rounded"
              title="Drag to move"
            >
              <MdDragIndicator size={14} />
            </span>
            {docId && (
              <button type="button" onClick={() => setShowCrop(true)} className="p-0.5 hover:bg-white/10 rounded" title="Crop">
                <MdCrop size={14} />
              </button>
            )}
            <button type="button" onClick={() => deleteNode()} className="p-0.5 hover:bg-white/10 rounded" title="Delete">
              <MdDelete size={14} />
            </button>
          </div>
        </>
      )}

      {dropIndicator &&
        createPortal(
          <div
            className="fixed z-[9999] w-0.5 bg-blue-500 rounded-full pointer-events-none"
            style={{ left: dropIndicator.left - 1, top: dropIndicator.top, height: dropIndicator.height }}
          />,
          document.body
        )}

      {showCrop && docId && (
        <DocImageCropModal docId={docId} src={node.attrs.src} onCancel={() => setShowCrop(false)} onApply={handleCropApplied} />
      )}
    </NodeViewWrapper>
  );
};

export default DocImageView;
