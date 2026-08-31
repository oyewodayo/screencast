// components/board/BoardCanvas.tsx
//
// The Board feature's interactive <canvas>: renders the composed layout (via
// boardHandlers.ts's renderBoardToCanvas) and handles pointer-driven select/move/resize/rotate.
// The canvas's own pixel buffer always stays at doc.canvasWidth/canvasHeight (renderBoardToCanvas
// draws at scale 1) so it's crisp at any zoom - only its CSS size is scaled by the `zoom` prop
// (BoardEditor owns that state, including fit-to-window). All the pointer/hit-test math below
// works in canvas-buffer space throughout; only pointerToCanvasSpace's canvas.width/rect.width
// ratio needs to know a CSS/buffer size mismatch can exist.
//
// Live drag/resize/rotate updates are staged locally (liveImages) and only committed to the store
// as a single edit/batch-edit on pointer release - a "stage locally, commit once" discipline that
// keeps a whole drag gesture to exactly one undo step.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoCopyOutline, IoSwapHorizontalOutline, IoTrashOutline } from "react-icons/io5";
import { TbStackBack, TbStackFront } from "react-icons/tb";
import { BoardDocument, BoardImage, BoardItem, BoardText } from "../../utils/boardTypes";
import {
  applyGroupResize,
  applyGroupRotate,
  applyMove,
  applyResize,
  applyRotate,
  GroupBounds,
  groupBoundingBox,
  growTextItemToFitContent,
  hitTestBoardItem,
  paddedCanvasSize,
  renderBoardToCanvas,
  ResizeCorner,
  resizeHandlePoints,
  rotateHandlePoint,
} from "../../handlers/boardHandlers";
import { preloadBoardFonts } from "../../utils/boardFonts";

// All three below are CSS-pixel sizes, not canvas-buffer ones - the buffer stays at
// doc.canvasWidth/canvasHeight regardless of zoom (see this file's own top comment), so a fixed
// buffer-space radius would shrink to almost nothing on screen at a low zoom (a corner handle that
// reads fine at 100% all but disappears at the 27% this got reported at) and balloon at a high one.
// Every use of these below divides by `zoom` to convert back into buffer space, so the actual
// on-screen size - both what's drawn and what's clickable - stays constant no matter the zoom
// level. Bumped from the previous 10/5px buffer-space values (which were already the effective
// on-screen size at 100% zoom) to comfortably-sized targets in their own right, not just
// zoom-corrected versions of numbers that were already on the small side.
const HANDLE_HIT_RADIUS = 14;
const HANDLE_DRAW_RADIUS = 7;
const ROTATE_HANDLE_OFFSET = 32;
// How close (CSS px, divided by zoom at its one use site below, same convention as the three
// constants above) a dragged item's edge/center has to come to another item's edge/center - or the
// canvas's own edges/center - before handlePointerMove's "move" branch snaps it flush and shows a
// guide line. Deliberately smaller than HANDLE_HIT_RADIUS - a hit-test radius wants to be forgiving
// about where you click, but a snap threshold that's too generous makes items feel like they're
// fighting the pointer instead of just landing where you put them.
const SNAP_THRESHOLD = 6;

type DragMode = "move" | "resize" | "rotate";

interface DragState {
  mode: DragMode;
  ids: Set<string>;
  corner?: ResizeCorner;
  startX: number;
  startY: number;
  startImages: BoardItem[]; // full doc.images snapshot at drag start
  // Set ONLY when this resize/rotate started on the multi-selection's own GROUP bounding-box
  // handles (ids.size > 1) rather than a single item's own handles - see handlePointerDown's
  // group-vs-single branch. handlePointerMove checks these to know which transform to apply.
  groupBounds?: GroupBounds; // resize: the bbox as it was at drag start
  groupAnchor?: { x: number; y: number }; // resize: the bbox corner OPPOSITE the one being dragged
  groupCenter?: { x: number; y: number }; // rotate: bbox center to orbit every item around
  startAngle?: number; // rotate: pointer's angle relative to groupCenter when the drag began
}

interface BoardCanvasProps {
  doc: BoardDocument;
  // CSS-only display scale - the canvas's own pixel buffer always stays at doc.canvasWidth/Height
  // (renderBoardToCanvas keeps drawing at scale 1 into it) for crisp rendering; only style width/
  // height shrink or grow to fit the viewport. pointerToCanvasSpace's canvas.width/rect.width ratio
  // already generically handles the CSS/buffer size mismatch this introduces, so no other pointer
  // math below needs to know zoom exists.
  zoom: number;
  imageBitmaps: Map<string, HTMLImageElement>;
  selectedIds: Set<string>;
  onSelect: (ids: Set<string>) => void;
  onEditImage: (before: BoardItem, after: BoardItem) => void;
  onBatchEditImages: (before: BoardItem[], after: BoardItem[]) => void;
  // Right-click menu on a single item tile (see the contextMenu state below) - "Replace image"
  // only ever offered for an image (text has no source photo to swap); the rest apply to either
  // kind. All five are the exact same actions BoardStylePanel's own buttons already call; this is
  // just a faster, no-side-panel-required path to them, and also what stops WebView2's native
  // "Save image as / Copy image / Inspect" context menu from appearing over board tiles at all.
  onReplaceImage: (image: BoardImage) => void;
  onBringToFront: (ids: Set<string>) => void;
  onSendToBack: (ids: Set<string>) => void;
  onDuplicateItem: (item: BoardItem) => void;
  onDeleteItem: (item: BoardItem) => void;
}

const BoardCanvas: React.FC<BoardCanvasProps> = ({
  doc,
  zoom,
  imageBitmaps,
  selectedIds,
  onSelect,
  onEditImage,
  onBatchEditImages,
  onReplaceImage,
  onBringToFront,
  onSendToBack,
  onDuplicateItem,
  onDeleteItem,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [liveImages, setLiveImages] = useState<BoardItem[] | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [contextMenu, setContextMenu] = useState<{ item: BoardItem; x: number; y: number } | null>(null);

  // Bumped once BoardText's bundled "Modern" webfonts (see boardFonts.css/preloadBoardFonts's own
  // doc comments) finish loading, purely to force draw() below to run again - draw() never reads
  // this value itself, it's only listed in draw's dependency array as a trigger. Without it, a
  // board that already uses one of these fonts on first open would draw its very first frame (or
  // every frame until the next edit) with a fallback face: canvas text, unlike DOM text, doesn't
  // automatically repaint once a font it already tried to use finishes loading in the background.
  const [fontsReadyTick, setFontsReadyTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    preloadBoardFonts().then(() => {
      if (!cancelled) setFontsReadyTick((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Marquee (rubber-band) select - starts whenever a plain pointerdown misses every item (see
  // handlePointerDown's final fallback below). `marqueeRef` holds the gesture's fixed start info
  // (not React state - nothing here needs to trigger a render on its own, only marqueeRect below
  // does); `marqueeRect` is the live rectangle, read by both draw() (to render the rubber band) and
  // handlePointerMove (to recompute which items are enclosed on every move). Shift+drag is additive
  // - `baseSelection` is a snapshot of whatever was already selected when the drag started, and the
  // live selection sent to onSelect is always baseSelection plus whatever's newly enclosed, so
  // releasing the drag never loses a selection that existed before it began.
  const marqueeRef = useRef<{ baseSelection: Set<string>; startX: number; startY: number } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  // Snap guide lines shown while a plain "move" drag (single or multi-item) is in progress - see
  // handlePointerMove's "move" branch, the only place this is ever set to anything non-empty.
  // `vertical`/`horizontal` are canvas-buffer-space (unpadded doc space) line positions, at most one
  // of each since a drag only ever snaps to its single closest target per axis. Cleared on every
  // pointer move that isn't a snapped "move" drag, and always on drag end (see endDrag).
  const [snapGuides, setSnapGuides] = useState<{ vertical: number[]; horizontal: number[] }>({ vertical: [], horizontal: [] });

  // Double-click-to-edit text - see BoardText's own doc comment in boardTypes.ts for why this is a
  // transparent textarea overlay (visible caret/selection only - color: transparent, see the style
  // below) driving the SAME liveImages staging drag/resize/rotate already use, rather than a styled
  // one rendering its own visible text: every keystroke re-stages the draft into liveImages so the
  // canvas underneath redraws with the item's real font/color/background/alignment live, and the
  // overlay never has to duplicate that rendering itself or fight with stale canvas content showing
  // through a transparent-background text box. Committed (via onEditImage, one undo step for the
  // whole edit) on blur; Escape discards the draft instead. Enter is deliberately NOT intercepted -
  // it inserts a newline, same as any multi-line text field; blur (click elsewhere) is what ends
  // editing, matching Notion/Figma text-box conventions.
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editingTextDraft, setEditingTextDraft] = useState("");

  const commitTextEdit = (): void => {
    const id = editingTextId;
    setEditingTextId(null);
    setLiveImages(null);
    if (!id) return;
    const before = doc.images.find((item) => item.id === id);
    if (!before || before.kind !== "text" || before.text === editingTextDraft) return;
    onEditImage(before, growTextItemToFitContent({ ...before, text: editingTextDraft, updatedAt: Date.now() }));
  };

  const cancelTextEdit = (): void => {
    setEditingTextId(null);
    setLiveImages(null);
  };

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [contextMenu]);

  const displayImages = liveImages ?? doc.images;

  const draw = useCallback((): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height, padding } = paddedCanvasSize(doc);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    renderBoardToCanvas(canvas, { ...doc, images: displayImages }, imageBitmaps, 1);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Selection chrome is drawn in the same unpadded document space item.x/y already are
    // (matching hitTestBoardItem/applyMove etc.) - offset by the same padding
    // renderBoardToCanvas insets its own image drawing by, so the outline/handles land exactly on
    // top of the images they belong to regardless of the board's current padding.
    ctx.save();
    ctx.translate(padding, padding);
    const selectedItems: BoardItem[] = [];
    for (const image of displayImages) {
      if (!selectedIds.has(image.id)) continue;
      selectedItems.push(image);
      drawSelectionChrome(ctx, image, selectedIds.size === 1, zoom);
    }
    // A second, dashed bounding box around the WHOLE selection once there's more than one item -
    // this is what resize/rotate actually grab for a multi-selection (see handlePointerDown's
    // group branch), so it needs its own visible outline/handles distinct from each item's own
    // (solid, handle-less) box above. Recomputed from `displayImages` (not `doc.images`) so it
    // tracks a live group drag in progress, same as the individual outlines already do.
    if (selectedItems.length > 1) {
      drawGroupSelectionChrome(ctx, groupBoundingBox(selectedItems), zoom);
    }
    if (marqueeRect) {
      ctx.save();
      ctx.fillStyle = "rgba(59, 130, 246, 0.1)";
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1 / zoom;
      ctx.fillRect(marqueeRect.x, marqueeRect.y, marqueeRect.width, marqueeRect.height);
      ctx.strokeRect(marqueeRect.x, marqueeRect.y, marqueeRect.width, marqueeRect.height);
      ctx.restore();
    }
    if (snapGuides.vertical.length > 0 || snapGuides.horizontal.length > 0) {
      ctx.save();
      ctx.strokeStyle = "#ec4899";
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([4 / zoom, 4 / zoom]);
      for (const vx of snapGuides.vertical) {
        ctx.beginPath();
        ctx.moveTo(vx, 0);
        ctx.lineTo(vx, doc.canvasHeight);
        ctx.stroke();
      }
      for (const hy of snapGuides.horizontal) {
        ctx.beginPath();
        ctx.moveTo(0, hy);
        ctx.lineTo(doc.canvasWidth, hy);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fontsReadyTick is a pure redraw
    // trigger (see its own doc comment above), draw() never reads it directly.
  }, [doc, displayImages, imageBitmaps, selectedIds, zoom, marqueeRect, snapGuides, fontsReadyTick]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Converts a client-space (clientX/clientY) point into the board's own unpadded document space -
  // the same space item.x/y, hitTestBoardItem, applyMove/Resize/Rotate, and resizeHandlePoints all
  // work in. canvas.width/rect.width first undoes any zoom (CSS size vs. buffer size), then padding
  // is subtracted back out since the buffer itself is padding pixels bigger than the document on
  // every side (see paddedCanvasSize). Takes plain coordinates rather than a specific event type so
  // both the pointer handlers below AND handleContextMenu (a MouseEvent, not a PointerEvent) can
  // share it.
  const clientToCanvasSpace = (clientX: number, clientY: number): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const { padding } = paddedCanvasSize(doc);
    return { x: (clientX - rect.left) * scaleX - padding, y: (clientY - rect.top) * scaleY - padding };
  };
  const pointerToCanvasSpace = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => clientToCanvasSpace(e.clientX, e.clientY);

  // Right-click on a tile selects it (single-select, replacing whatever else was selected - a
  // context menu acting on a multi-selection would be ambiguous about which item's photo "Replace"
  // even means) and opens the custom menu instead of WebView2's native one (see onReplaceImage/
  // onDeleteItem props' own doc comment). Right-clicking empty canvas space just suppresses the
  // native menu with nothing to replace it - there's no board-level action to offer there today.
  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    e.preventDefault();
    const { x, y } = clientToCanvasSpace(e.clientX, e.clientY);
    const hit = hitTestBoardItem(doc.images, x, y);
    if (!hit) {
      setContextMenu(null);
      return;
    }
    onSelect(new Set([hit.id]));
    setContextMenu({ item: hit, x: e.clientX, y: e.clientY });
  };

  // Double-click a text tile to start editing it in place - see editingTextId's own doc comment.
  // No-ops for an image/blur tile (or empty canvas) - there's nothing to type into.
  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const { x, y } = clientToCanvasSpace(e.clientX, e.clientY);
    const hit = hitTestBoardItem(doc.images, x, y);
    if (!hit || hit.kind !== "text") return;
    onSelect(new Set([hit.id]));
    setEditingTextId(hit.id);
    setEditingTextDraft(hit.text);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const { x, y } = pointerToCanvasSpace(e);
    // /zoom converts the CSS-pixel constants above back into buffer space - see their own doc
    // comment. Matches exactly what drawSelectionChrome/drawGroupSelectionChrome render, so the
    // clickable area always lines up with what's actually drawn on screen.
    const hitRadius = HANDLE_HIT_RADIUS / zoom;

    if (selectedIds.size === 1) {
      const image = doc.images.find((img) => selectedIds.has(img.id));
      // A locked item can end up selected via BoardLayerPanel (which selects by id, not by hit-
      // testing - see hitTestBoardItem's own doc comment) - its resize/rotate handles simply don't
      // exist as far as pointer-down is concerned, so this falls through to the plain hit-test
      // below, which also skips it, so a click anywhere near it just starts a marquee/deselects.
      if (image && !image.locked) {
        const handles = resizeHandlePoints(image);
        for (const corner of Object.keys(handles) as ResizeCorner[]) {
          if (Math.hypot(x - handles[corner].x, y - handles[corner].y) <= hitRadius) {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { mode: "resize", ids: selectedIds, corner, startX: x, startY: y, startImages: doc.images };
            return;
          }
        }
        const rotateHandle = rotateHandlePoint(image, ROTATE_HANDLE_OFFSET / zoom);
        if (Math.hypot(x - rotateHandle.x, y - rotateHandle.y) <= hitRadius) {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { mode: "rotate", ids: selectedIds, startX: x, startY: y, startImages: doc.images };
          return;
        }
      }
    } else if (selectedIds.size > 1) {
      // Group resize/rotate - grabs the WHOLE selection's bounding-box handles (see
      // drawGroupSelectionChrome) instead of any one item's own. Resize scales every selected
      // item's position and size around the anchor corner (see applyGroupResize's own doc
      // comment); rotate orbits every item around the shared bbox center (applyGroupRotate).
      const selectedItems = doc.images.filter((img) => selectedIds.has(img.id));
      if (selectedItems.length > 1) {
        const bounds = groupBoundingBox(selectedItems);
        const cornerPoints: Record<ResizeCorner, { x: number; y: number }> = {
          nw: { x: bounds.x, y: bounds.y },
          ne: { x: bounds.x + bounds.width, y: bounds.y },
          sw: { x: bounds.x, y: bounds.y + bounds.height },
          se: { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        };
        const opposite: Record<ResizeCorner, ResizeCorner> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };
        for (const corner of Object.keys(cornerPoints) as ResizeCorner[]) {
          if (Math.hypot(x - cornerPoints[corner].x, y - cornerPoints[corner].y) <= hitRadius) {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = {
              mode: "resize",
              ids: selectedIds,
              corner,
              startX: x,
              startY: y,
              startImages: doc.images,
              groupBounds: bounds,
              groupAnchor: cornerPoints[opposite[corner]],
            };
            return;
          }
        }
        const groupCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        const rotateHandlePos = { x: groupCenter.x, y: bounds.y - ROTATE_HANDLE_OFFSET / zoom };
        if (Math.hypot(x - rotateHandlePos.x, y - rotateHandlePos.y) <= hitRadius) {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = {
            mode: "rotate",
            ids: selectedIds,
            startX: x,
            startY: y,
            startImages: doc.images,
            groupCenter,
            startAngle: Math.atan2(y - groupCenter.y, x - groupCenter.x),
          };
          return;
        }
      }
    }

    const hit = hitTestBoardItem(doc.images, x, y);
    if (!hit) {
      // Missed every item - start a marquee (rubber-band) drag instead of just clearing the
      // selection outright. Shift+drag is additive: baseSelection snapshots whatever was already
      // selected so handlePointerMove can union it with whatever the rectangle newly encloses,
      // and a plain click-and-release with no movement still behaves like the old "click empty
      // space to deselect" (handlePointerMove never having enlarged marqueeRect off zero size).
      e.currentTarget.setPointerCapture(e.pointerId);
      marqueeRef.current = { baseSelection: e.shiftKey ? new Set(selectedIds) : new Set(), startX: x, startY: y };
      setMarqueeRect({ x, y, width: 0, height: 0 });
      if (!e.shiftKey) onSelect(new Set());
      return;
    }

    let nextSelection: Set<string>;
    if (e.shiftKey) {
      nextSelection = new Set(selectedIds);
      if (nextSelection.has(hit.id)) nextSelection.delete(hit.id);
      else nextSelection.add(hit.id);
    } else {
      nextSelection = selectedIds.has(hit.id) ? selectedIds : new Set([hit.id]);
    }
    onSelect(nextSelection);

    if (nextSelection.has(hit.id)) {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { mode: "move", ids: nextSelection, startX: x, startY: y, startImages: doc.images };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const marquee = marqueeRef.current;
    if (marquee) {
      const { x, y } = pointerToCanvasSpace(e);
      const rect = {
        x: Math.min(marquee.startX, x),
        y: Math.min(marquee.startY, y),
        width: Math.abs(x - marquee.startX),
        height: Math.abs(y - marquee.startY),
      };
      setMarqueeRect(rect);
      const enclosed = doc.images.filter((item) => !item.locked && rectsIntersect(groupBoundingBox([item]), rect));
      const next = new Set(marquee.baseSelection);
      for (const item of enclosed) next.add(item.id);
      onSelect(next);
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = pointerToCanvasSpace(e);
    const dx = x - drag.startX;
    const dy = y - drag.startY;

    // Group resize/rotate (see handlePointerDown's group branch, which is the only place that ever
    // sets groupBounds/groupAnchor/groupCenter) - transform just the selected items via
    // applyGroupResize/applyGroupRotate, then merge back into the full item list the same way the
    // plain single-item branch below already does.
    if (drag.mode === "resize" && drag.corner && drag.groupBounds && drag.groupAnchor) {
      if (snapGuides.vertical.length > 0 || snapGuides.horizontal.length > 0) setSnapGuides({ vertical: [], horizontal: [] });
      const b = drag.groupBounds;
      const anchor = drag.groupAnchor;
      const startCorner = {
        x: drag.corner === "nw" || drag.corner === "sw" ? b.x : b.x + b.width,
        y: drag.corner === "nw" || drag.corner === "ne" ? b.y : b.y + b.height,
      };
      const scaleX = groupResizeScale(startCorner.x, anchor.x, x);
      const scaleY = groupResizeScale(startCorner.y, anchor.y, y);
      const transformed = applyGroupResize(
        drag.startImages.filter((img) => drag.ids.has(img.id)),
        anchor.x,
        anchor.y,
        scaleX,
        scaleY
      );
      const byId = new Map(transformed.map((item) => [item.id, item]));
      setLiveImages(drag.startImages.map((item) => byId.get(item.id) ?? item));
      return;
    }
    if (drag.mode === "rotate" && drag.groupCenter && drag.startAngle !== undefined) {
      if (snapGuides.vertical.length > 0 || snapGuides.horizontal.length > 0) setSnapGuides({ vertical: [], horizontal: [] });
      const currentAngle = Math.atan2(y - drag.groupCenter.y, x - drag.groupCenter.x);
      const transformed = applyGroupRotate(
        drag.startImages.filter((img) => drag.ids.has(img.id)),
        drag.groupCenter.x,
        drag.groupCenter.y,
        snapAngle(currentAngle - drag.startAngle)
      );
      const byId = new Map(transformed.map((item) => [item.id, item]));
      setLiveImages(drag.startImages.map((item) => byId.get(item.id) ?? item));
      return;
    }

    if (drag.mode === "move") {
      // Snap the whole dragged selection's group bounding box (not each item separately - a
      // multi-item drag should snap as one rigid block, same as it moves as one) to the nearest
      // edge/center of every OTHER item plus the canvas's own edges/center, within SNAP_THRESHOLD.
      // computeSnapTargets/snapMoveDelta do the actual nearest-target search; this just wires their
      // result into the raw pointer delta and remembers where to draw the guide line(s).
      const movedSelected = drag.startImages
        .filter((image) => drag.ids.has(image.id))
        .map((image) => applyMove(image, dx, dy));
      const draggedBox = groupBoundingBox(movedSelected);
      const others = doc.images.filter((image) => !drag.ids.has(image.id));
      const targets = computeSnapTargets(others, doc.canvasWidth, doc.canvasHeight);
      const snap = snapMoveDelta(draggedBox, targets, SNAP_THRESHOLD / zoom);
      setSnapGuides({ vertical: snap.guideX !== null ? [snap.guideX] : [], horizontal: snap.guideY !== null ? [snap.guideY] : [] });
      const finalDx = dx + snap.dx;
      const finalDy = dy + snap.dy;
      setLiveImages(drag.startImages.map((image) => (drag.ids.has(image.id) ? applyMove(image, finalDx, finalDy) : image)));
      return;
    }

    if (drag.mode === "resize" && drag.corner) {
      // Single-item resize snap: the dragged corner's raw (x, y) is snapped independently on each
      // axis to the nearest edge/center of every OTHER item plus the canvas's own edges/center,
      // same target set computeSnapTargets/move-snap already use. Only when the item itself isn't
      // rotated - applyResize below works in the item's own LOCAL (unrotated) frame, so a raw
      // canvas-space snap only lines up with what's visibly on screen when local space and canvas
      // space are the same thing; a rotated item just resizes without snap assistance instead of
      // snapping to the wrong axis.
      const corner = drag.corner;
      const target = drag.startImages.find((image) => drag.ids.has(image.id));
      let snappedX = x;
      let snappedY = y;
      let guideX: number | null = null;
      let guideY: number | null = null;
      if (target && Math.abs(target.rotation) < 0.001) {
        const others = doc.images.filter((image) => !drag.ids.has(image.id));
        const targets = computeSnapTargets(others, doc.canvasWidth, doc.canvasHeight);
        const threshold = SNAP_THRESHOLD / zoom;
        let bestDistX = threshold;
        for (const tx of targets.x) {
          const dist = Math.abs(x - tx);
          if (dist < bestDistX) {
            bestDistX = dist;
            snappedX = tx;
            guideX = tx;
          }
        }
        let bestDistY = threshold;
        for (const ty of targets.y) {
          const dist = Math.abs(y - ty);
          if (dist < bestDistY) {
            bestDistY = dist;
            snappedY = ty;
            guideY = ty;
          }
        }
      }
      setSnapGuides({ vertical: guideX !== null ? [guideX] : [], horizontal: guideY !== null ? [guideY] : [] });
      // A text item specifically also gets grown post-resize: narrowing its width can force more
      // wrapped lines than its (also just-changed) height now fits, which would otherwise silently
      // clip text the same way an untouched box would (see growTextItemToFitContent's own doc
      // comment) - every other kind is unaffected, resized exactly as dragged.
      setLiveImages(
        drag.startImages.map((image) => {
          if (!drag.ids.has(image.id)) return image;
          const resized = applyResize(image, corner, snappedX, snappedY);
          return resized.kind === "text" ? growTextItemToFitContent(resized) : resized;
        })
      );
      return;
    }

    if (snapGuides.vertical.length > 0 || snapGuides.horizontal.length > 0) setSnapGuides({ vertical: [], horizontal: [] });
    setLiveImages(
      drag.startImages.map((image) => {
        if (!drag.ids.has(image.id)) return image;
        if (drag.mode === "rotate") {
          const rotated = applyRotate(image, x, y);
          return { ...rotated, rotation: snapAngle(rotated.rotation) };
        }
        return image;
      })
    );
  };

  const endDrag = (): void => {
    if (marqueeRef.current) {
      marqueeRef.current = null;
      setMarqueeRect(null);
      return;
    }

    if (snapGuides.vertical.length > 0 || snapGuides.horizontal.length > 0) setSnapGuides({ vertical: [], horizontal: [] });

    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !liveImages) {
      setLiveImages(null);
      return;
    }

    const beforeById = new Map(drag.startImages.map((img) => [img.id, img]));
    const afterById = new Map(liveImages.map((img) => [img.id, img]));
    const before = [...drag.ids].map((id) => beforeById.get(id)).filter((img): img is BoardItem => !!img);
    const after = [...drag.ids].map((id) => afterById.get(id)).filter((img): img is BoardItem => !!img);

    setLiveImages(null);
    if (before.length === 0 || after.length === 0) return;
    const changed = before.some((img, i) => JSON.stringify(img) !== JSON.stringify(after[i]));
    if (!changed) return;
    if (before.length === 1) onEditImage(before[0], after[0]);
    else onBatchEditImages(before, after);
  };

  const { width: bufferWidth, height: bufferHeight, padding } = paddedCanvasSize(doc);
  // From displayImages (liveImages while editing, doc.images otherwise), NOT doc.images directly -
  // the overlay below sizes itself off this item's own x/y/width/height, and doc.images only ever
  // has the pre-edit committed height (the store isn't touched until commitTextEdit on blur). Using
  // the live one is what makes the actual editable/clickable overlay area grow in step with the
  // canvas underneath as growTextItemToFitContent grows it on every keystroke (see the textarea's
  // own onChange above) - without this the overlay would stay stuck at its old (too short) height
  // while the visibly-taller box rendered underneath it.
  const editingItem = editingTextId ? (displayImages.find((item) => item.id === editingTextId) as BoardText | undefined) : undefined;

  return (
    <>
      {/* Sized exactly like the canvas below (same width/height) purely so the text-edit overlay
          has a positioned ancestor to place itself against with plain left/top math - no change to
          how this sits in BoardEditor.tsx's own centering flex container, since the wrapper is the
          same box the bare canvas used to be. */}
      <div className="relative shrink-0" style={{ width: bufferWidth * zoom, height: bufferHeight * zoom }}>
        <canvas
          ref={canvasRef}
          style={{
            width: bufferWidth * zoom,
            height: bufferHeight * zoom,
            // Always-on checkerboard sitting behind the canvas's own pixels - invisible wherever the
            // board has an opaque background (a color, a grid with a base fill, or a chosen image),
            // but shows through cleanly wherever that background is transparent - color mode's
            // backgroundColor null, grid mode's baseColor null, or image mode with nothing chosen
            // yet - or an image's own opacity is under 100%, the same "see-through" convention every
            // other image editor uses. See boardHandlers.ts's renderBoardToCanvas for which of the
            // three background modes is actually responsible for what gets drawn into the pixels
            // this sits behind.
            backgroundImage:
              "repeating-conic-gradient(#0000000f 0% 25%, transparent 0% 50%), repeating-conic-gradient(#0000000f 0% 25%, transparent 0% 50%)",
            backgroundSize: "20px 20px",
            backgroundPosition: "0 0, 10px 10px",
          }}
          className="rounded-sm shadow-lg cursor-default touch-none bg-white dark:bg-neutral-700"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onContextMenu={handleContextMenu}
          onDoubleClick={handleDoubleClick}
        />

        {editingItem && (
          <textarea
            key={editingItem.id}
            autoFocus
            value={editingTextDraft}
            onChange={(e) => {
              setEditingTextDraft(e.target.value);
              // growTextItemToFitContent here, not just on final commit, is what makes the box
              // visibly grow downward AS the user types (matches editingItem's own live-height doc
              // comment below) rather than only snapping to its new size once editing ends.
              setLiveImages(
                doc.images.map((item) =>
                  item.id === editingItem.id && item.kind === "text" ? growTextItemToFitContent({ ...item, text: e.target.value }) : item
                )
              );
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitTextEdit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancelTextEdit();
              }
              // Enter is deliberately left alone - see this component's editingTextId doc comment.
            }}
            spellCheck={false}
            style={{
              position: "absolute",
              left: (padding + editingItem.x) * zoom,
              top: (padding + editingItem.y) * zoom,
              width: editingItem.width * zoom,
              height: editingItem.height * zoom,
              transform: `rotate(${editingItem.rotation}rad)`,
              transformOrigin: "center",
              padding: editingItem.padding * zoom,
              fontSize: editingItem.fontSize * zoom,
              fontFamily: editingItem.fontFamily,
              fontWeight: editingItem.fontWeight,
              fontStyle: editingItem.fontStyle,
              textAlign: editingItem.textAlign,
              lineHeight: 1.25,
              // Invisible text/background on purpose - liveImages (see onChange) restages the same
              // draft into the canvas underneath on every keystroke, which already renders it with
              // the item's real font/color/background/corner-radius. This overlay exists only to
              // capture keystrokes/IME/selection at the right screen position - color: transparent
              // keeps its own (unstyled, unclipped) text invisible while the caret and native
              // selection highlight stay visible, so there's no double-rendered or mismatched text
              // flashing on top of the real one.
              color: "transparent",
              caretColor: editingItem.color,
              background: "transparent",
              border: "none",
              outline: "none",
              resize: "none",
              boxSizing: "border-box",
            }}
          />
        )}
      </div>

      {contextMenu &&
        createPortal(
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: "fixed", top: contextMenu.y, left: contextMenu.x }}
            className="w-44 py-1 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-md border border-neutral-200/80 dark:border-neutral-700/80 shadow-xl ring-1 ring-black/5 z-[9999]"
          >
            {contextMenu.item.kind === "image" && (
              <button
                type="button"
                onClick={() => {
                  onReplaceImage(contextMenu.item as BoardImage);
                  setContextMenu(null);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/70 transition-colors"
              >
                <IoSwapHorizontalOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                Replace image
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onDuplicateItem(contextMenu.item);
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/70 transition-colors"
            >
              <IoCopyOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
              Duplicate
            </button>
            <button
              type="button"
              onClick={() => {
                onBringToFront(new Set([contextMenu.item.id]));
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/70 transition-colors"
            >
              <TbStackFront size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
              Bring to front
            </button>
            <button
              type="button"
              onClick={() => {
                onSendToBack(new Set([contextMenu.item.id]));
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/70 transition-colors"
            >
              <TbStackBack size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
              Send to back
            </button>
            <div className="my-1 border-t border-neutral-100 dark:border-neutral-700/70" />
            <button
              type="button"
              onClick={() => {
                onDeleteItem(contextMenu.item);
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
            >
              <IoTrashOutline size={15} className="shrink-0" />
              Delete{" "}
              {contextMenu.item.kind === "text"
                ? "text"
                : contextMenu.item.kind === "blur"
                  ? "blur"
                  : contextMenu.item.kind === "shape"
                    ? "shape"
                    : "image"}
            </button>
          </div>,
          document.body
        )}
    </>
  );
};


function drawSelectionChrome(ctx: CanvasRenderingContext2D, image: BoardItem, showHandles: boolean, zoom: number): void {
  ctx.save();
  const cx = image.x + image.width / 2;
  const cy = image.y + image.height / 2;
  ctx.translate(cx, cy);
  ctx.rotate(image.rotation);
  ctx.translate(-cx, -cy);

  // Every size/offset below divides by `zoom` to convert this file's CSS-pixel constants
  // (HANDLE_DRAW_RADIUS/ROTATE_HANDLE_OFFSET) back into buffer space, so the selection outline and
  // handles hold a constant on-screen size at any zoom level - see those constants' own doc
  // comment, and handlePointerDown's hitRadius which this must stay in visual sync with.
  const lineWidth = 2 / zoom;
  const handleRadius = HANDLE_DRAW_RADIUS / zoom;
  const rotateOffset = ROTATE_HANDLE_OFFSET / zoom;

  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([]);
  ctx.strokeRect(image.x, image.y, image.width, image.height);

  if (showHandles) {
    const drawHandle = (hx: number, hy: number): void => {
      ctx.beginPath();
      ctx.arc(hx, hy, handleRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#3b82f6";
      ctx.fill();
      // A white ring around each dot - without it a blue handle sitting on top of a blue-ish or
      // dark photo can all but disappear; the ring keeps it visible against any photo underneath.
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    };

    for (const [hx, hy] of [
      [image.x, image.y],
      [image.x + image.width, image.y],
      [image.x, image.y + image.height],
      [image.x + image.width, image.y + image.height],
    ]) {
      drawHandle(hx, hy);
    }

    ctx.beginPath();
    ctx.moveTo(cx, image.y);
    ctx.lineTo(cx, image.y - rotateOffset);
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    drawHandle(cx, image.y - rotateOffset);
  }

  ctx.restore();
}

// Draws the group bounding box + its own resize/rotate handles - what handlePointerDown's group
// branch actually grabs when 2+ items are selected, so it needs a visibly distinct (dashed) outline
// from each item's own solid one, drawn once around the whole selection rather than per item.
function drawGroupSelectionChrome(ctx: CanvasRenderingContext2D, bounds: GroupBounds, zoom: number): void {
  ctx.save();
  const lineWidth = 2 / zoom;
  const handleRadius = HANDLE_DRAW_RADIUS / zoom;
  const rotateOffset = ROTATE_HANDLE_OFFSET / zoom;

  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([4 / zoom, 4 / zoom]);
  ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.setLineDash([]);

  const drawHandle = (hx: number, hy: number): void => {
    ctx.beginPath();
    ctx.arc(hx, hy, handleRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#3b82f6";
    ctx.fill();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  };

  for (const [hx, hy] of [
    [bounds.x, bounds.y],
    [bounds.x + bounds.width, bounds.y],
    [bounds.x, bounds.y + bounds.height],
    [bounds.x + bounds.width, bounds.y + bounds.height],
  ]) {
    drawHandle(hx, hy);
  }

  const cx = bounds.x + bounds.width / 2;
  ctx.beginPath();
  ctx.moveTo(cx, bounds.y);
  ctx.lineTo(cx, bounds.y - rotateOffset);
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  drawHandle(cx, bounds.y - rotateOffset);

  ctx.restore();
}

// Converts a group-resize pointer position into a scale factor: how far the dragged corner has
// moved from the anchor, relative to how far it started - used identically for both axes (see
// handlePointerMove's two calls). Floors the magnitude (not the sign - dragging back past the
// anchor is allowed to flip the group) so a bbox with near-zero width/height at drag start, or a
// drag pulled almost onto the anchor point, can't collapse the whole selection to nothing.
const MIN_GROUP_SCALE = 0.05;
function groupResizeScale(startCornerCoord: number, anchorCoord: number, currentCoord: number): number {
  const startDist = startCornerCoord - anchorCoord;
  if (Math.abs(startDist) < 1) return 1;
  const scale = (currentCoord - anchorCoord) / startDist;
  return (scale < 0 ? -1 : 1) * Math.max(MIN_GROUP_SCALE, Math.abs(scale));
}

// Plain AABB overlap test - used by the marquee-select move handler to decide which items' own
// (rotated) bounding boxes fall inside the drag rectangle. Both rects are already axis-aligned in
// canvas-buffer space (an item's rect comes from groupBoundingBox([item]), which already accounts
// for rotation), so a simple separating-axis check is all this needs.
function rectsIntersect(a: GroupBounds, b: GroupBounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// Collects every snap-worthy line for a move drag: each non-dragged item's own left/center/right
// (x) and top/center/bottom (y) edges, plus the canvas's own left/center/right and top/center/
// bottom - so a dragged item can snap flush with either another item or the board itself. Used by
// handlePointerMove's "move" branch, recomputed fresh every pointer move (cheap - board item counts
// are small, and only "other" items are considered, not the dragged selection itself).
function computeSnapTargets(others: BoardItem[], canvasWidth: number, canvasHeight: number): { x: number[]; y: number[] } {
  const x: number[] = [0, canvasWidth / 2, canvasWidth];
  const y: number[] = [0, canvasHeight / 2, canvasHeight];
  for (const item of others) {
    const box = groupBoundingBox([item]);
    x.push(box.x, box.x + box.width / 2, box.x + box.width);
    y.push(box.y, box.y + box.height / 2, box.y + box.height);
  }
  return { x, y };
}

// Finds the single closest snap target per axis (if any is within `threshold`) for a dragged
// group's bounding box, checking its own left/center/right against every x target and its top/
// center/bottom against every y target. Returns the extra (dx, dy) to add on top of the raw pointer
// delta to land exactly on that target, plus the target's own position for drawing a guide line -
// null on an axis with nothing close enough to snap to.
function snapMoveDelta(
  draggedBox: GroupBounds,
  targets: { x: number[]; y: number[] },
  threshold: number
): { dx: number; dy: number; guideX: number | null; guideY: number | null } {
  const candidatesX = [draggedBox.x, draggedBox.x + draggedBox.width / 2, draggedBox.x + draggedBox.width];
  const candidatesY = [draggedBox.y, draggedBox.y + draggedBox.height / 2, draggedBox.y + draggedBox.height];

  let dx = 0;
  let bestDistX = threshold;
  let guideX: number | null = null;
  for (const cx of candidatesX) {
    for (const tx of targets.x) {
      const dist = Math.abs(cx - tx);
      if (dist < bestDistX) {
        bestDistX = dist;
        dx = tx - cx;
        guideX = tx;
      }
    }
  }

  let dy = 0;
  let bestDistY = threshold;
  let guideY: number | null = null;
  for (const cy of candidatesY) {
    for (const ty of targets.y) {
      const dist = Math.abs(cy - ty);
      if (dist < bestDistY) {
        bestDistY = dist;
        dy = ty - cy;
        guideY = ty;
      }
    }
  }

  return { dx, dy, guideX, guideY };
}

// Rotation-angle snapping (radians) - separate from the edge/center position snapping above, but
// the same idea applied to angle instead of x/y: rounds to the nearest 15deg increment whenever
// the raw angle is already close, so "make this level" or "make this exactly 45deg" doesn't need
// pixel-perfect pointer precision. Used by both single-item rotate (applyRotate's own absolute
// pointer-angle result) and group rotate (the delta angle applyGroupRotate orbits every item by).
const ROTATION_SNAP_INCREMENT = Math.PI / 12; // 15deg
const ROTATION_SNAP_THRESHOLD = (3 * Math.PI) / 180; // ~3deg
function snapAngle(angle: number): number {
  const nearest = Math.round(angle / ROTATION_SNAP_INCREMENT) * ROTATION_SNAP_INCREMENT;
  return Math.abs(angle - nearest) <= ROTATION_SNAP_THRESHOLD ? nearest : angle;
}

export default BoardCanvas;
