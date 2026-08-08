// components/image/ImageEditorCanvas.tsx
//
// The image editor's drawing surface. Two stacked full-resolution canvases (natural image pixels,
// CSS-scaled to the current zoom% for on-screen display - same "offscreen full-res, CSS-scaled"
// split ImageOverlayCropPanel.tsx/PdfPage.tsx already use) plus a DOM interaction layer on top:
//
// - `canvasRef` always holds exactly renderComposedCanvas's output (base photo + adjustments +
//   every committed annotation object) and nothing else - this is the canvas getWorkingCanvas()
//   exposes to the parent for crop/rotate/flip snapshots and the final Save. Selection chrome is
//   never drawn onto it, so it's always safe to read back as-is.
// - `previewCanvasRef` is a transparent overlay cleared and redrawn each pointermove with only the
//   in-progress gesture (a freehand stroke being drawn, a shape's rubber-band drag) - discarded
//   once the gesture commits (the object then appears on the real canvas via the store round-trip).
// - Selection outline/resize handles/the crop rect/the marquee/snap guides are plain positioned
//   DOM elements (mirrors ImageAnnotationEditor.tsx/ImageOverlayCropPanel.tsx's own selection-
//   chrome convention), not canvas-drawn, so they never risk leaking into an exported frame.
//
// Selection is multi-object (`selectedObjectIds`): a marquee drag or shift-click can select more
// than one at once, and dragging any selected object moves the whole group together as one undo
// step. Resize handles and the placed-image move/resize/rotate chrome are still single-object only
// (see the `primarySelectedObject`-gated blocks below) - multi-object resize isn't supported.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  ImageAdjustments,
  ImageAnnotationObject,
  ImageEditDocument,
  ImageEditTool,
  Pt,
} from "../../utils/imageEditTypes";
import {
  Bounds,
  ResizeCorner,
  TEXT_BACKGROUND_ALPHA,
  TEXT_FONT_FAMILY,
  findObjectAt,
  findObjectsInRect,
  getObjectBounds,
  getSelectionBounds,
  makeArrowObject,
  makeBlurObject,
  makeEllipseObject,
  makeHighlightObject,
  makeRectObject,
  makeStrokeObject,
  makeTextObject,
  renderComposedCanvas,
  renderLiveStroke,
  resizeBoxObject,
  textObjectBounds,
  textObjectVisualBounds,
  translateObject,
} from "../../handlers/imageEditHandlers";
import { getCachedImage, preloadImage } from "../../utils/imageObjectCache";
import ImageAnnotationEditor from "../pdf/ImageAnnotationEditor";
import TextAnnotationEditor from "./TextAnnotationEditor";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageEditorCanvasHandle {
  getWorkingCanvas: () => HTMLCanvasElement | null;
  getCropRect: () => CropRect | null;
}

interface ImageEditorCanvasProps {
  doc: ImageEditDocument;
  baseImageSrc: string;
  adjustments: ImageAdjustments;
  tool: ImageEditTool;
  color: string;
  strokeWidth: number;
  fontSize: number;
  textBold: boolean;
  textBackground: boolean;
  textBackgroundColor: string;
  zoom: number;
  selectedObjectIds: string[];
  onSelectObjects: (ids: string[]) => void;
  onAddObject: (object: ImageAnnotationObject) => void;
  // Fired once a text object is created or an edit to one is committed - unlike every other tool
  // (pen/shape/etc., where drawing IS the positioning gesture), placing text is click-then-type
  // with no drag step, so there's no way to land it exactly where you want in one motion. The
  // caller (ImageEditor.tsx) uses this to drop into the Select tool with the object already
  // selected, so repositioning it is an immediate drag rather than "switch tools, click it, then
  // drag".
  onTextCommitted: (objectId: string) => void;
  onEditObject: (before: ImageAnnotationObject, after: ImageAnnotationObject) => void;
  onBatchEditObjects: (before: ImageAnnotationObject[], after: ImageAnnotationObject[]) => void;
  onDeleteObject: (object: ImageAnnotationObject) => void;
}

const HANDLE_SIZE = 12; // CSS px, independent of zoom - matches ImageAnnotationEditor's HANDLE_SIZE feel
const HANDLE_HIT_PADDING = 6;
// Screen-space (not natural-pixel) threshold so snapping feels the same regardless of zoom level -
// divided by zoom before comparing against natural-space distances, same convention
// HANDLE_HIT_PADDING above already uses.
const SNAP_THRESHOLD_SCREEN_PX = 6;

type DragState =
  | { kind: "freehand"; tool: "pen" | "highlighter"; points: Pt[] }
  | { kind: "shape"; tool: "arrow" | "rect" | "ellipse" | "blur"; startX: number; startY: number; curX: number; curY: number }
  | { kind: "move"; objects: ImageAnnotationObject[]; startX: number; startY: number; curX: number; curY: number }
  | { kind: "resize"; object: ImageAnnotationObject; corner: ResizeCorner; curX: number; curY: number }
  | { kind: "arrow-endpoint"; object: ImageAnnotationObject; endpoint: "start" | "end"; curX: number; curY: number }
  | { kind: "crop"; startX: number; startY: number; curX: number; curY: number }
  // Rubber-band select on empty canvas - `additive` (shift held when the drag started) means the
  // objects it ends up touching are added to whatever was already selected rather than replacing it.
  | { kind: "marquee"; additive: boolean; startX: number; startY: number; curX: number; curY: number };

interface TextEditorState {
  mode: "create" | "edit";
  x: number;
  y: number;
  value: string;
  original?: Extract<ImageAnnotationObject, { type: "text" }>;
}

interface SnapGuide {
  axis: "v" | "h";
  pos: number; // natural-space coordinate the guide line sits at
}

// Lets the live text-editing input's own CSS background match the translucent alpha
// renderTextObject draws on the canvas (ctx.globalAlpha there, this here) - a plain hex can't
// express that on its own, and CSS opacity would fade the typed characters along with it.
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const int = parseInt(full, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function unionBounds(boxes: Bounds[]): Bounds {
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Finds the smallest snap on each axis independently (so a horizontal-only or vertical-only
// alignment still snaps even if the other axis has nothing nearby) across every edge/center of
// `movingBounds` against every edge/center of every target box - the same 9-point comparison
// (left/center/right and top/center/bottom) most design tools' smart guides use.
function computeSnap(movingBounds: Bounds, targets: Bounds[], threshold: number): { dx: number; dy: number; guides: SnapGuide[] } {
  const movingXs = [movingBounds.x, movingBounds.x + movingBounds.w / 2, movingBounds.x + movingBounds.w];
  const movingYs = [movingBounds.y, movingBounds.y + movingBounds.h / 2, movingBounds.y + movingBounds.h];

  let bestDx = 0;
  let bestDxDist = threshold;
  let snappedX: number | null = null;
  let bestDy = 0;
  let bestDyDist = threshold;
  let snappedY: number | null = null;

  for (const t of targets) {
    const targetXs = [t.x, t.x + t.w / 2, t.x + t.w];
    const targetYs = [t.y, t.y + t.h / 2, t.y + t.h];
    for (const mx of movingXs) {
      for (const tx of targetXs) {
        const dist = Math.abs(mx - tx);
        if (dist < bestDxDist) {
          bestDxDist = dist;
          bestDx = tx - mx;
          snappedX = tx;
        }
      }
    }
    for (const my of movingYs) {
      for (const ty of targetYs) {
        const dist = Math.abs(my - ty);
        if (dist < bestDyDist) {
          bestDyDist = dist;
          bestDy = ty - my;
          snappedY = ty;
        }
      }
    }
  }

  const guides: SnapGuide[] = [];
  if (snappedX !== null) guides.push({ axis: "v", pos: snappedX });
  if (snappedY !== null) guides.push({ axis: "h", pos: snappedY });
  return { dx: snappedX !== null ? bestDx : 0, dy: snappedY !== null ? bestDy : 0, guides };
}

const ImageEditorCanvas = forwardRef<ImageEditorCanvasHandle, ImageEditorCanvasProps>(function ImageEditorCanvas(
  {
    doc,
    baseImageSrc,
    adjustments,
    tool,
    color,
    strokeWidth,
    fontSize,
    textBold,
    textBackground,
    textBackgroundColor,
    zoom,
    selectedObjectIds,
    onSelectObjects,
    onAddObject,
    onTextCommitted,
    onEditObject,
    onBatchEditObjects,
    onDeleteObject,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const baseImageElRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  // The last snap-adjusted (dx, dy) computed during a live "move" drag - handlePointerUp commits
  // this instead of recomputing straight from curX/curY, so the object doesn't visibly jump away
  // from a snapped-to guide the instant the pointer is released.
  const lastMoveDeltaRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  const [liveObjects, setLiveObjects] = useState<ImageAnnotationObject[] | null>(null);
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<CropRect | null>(null);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);

  const { baseWidth, baseHeight, objects } = doc;

  // Resets whenever crop mode is (re-)entered, so switching tools away and back always starts
  // from "the whole image" rather than remembering a stale rect from a cancelled attempt.
  useEffect(() => {
    if (tool === "crop") setCropRect({ x: 0, y: 0, w: baseWidth, h: baseHeight });
    else setCropRect(null);
  }, [tool, baseWidth, baseHeight]);

  useEffect(() => {
    let cancelled = false;
    preloadImage(baseImageSrc).then(
      (img) => {
        if (cancelled) return;
        baseImageElRef.current = img;
        redraw();
      },
      (err) => console.error("Failed to decode image for editing:", err)
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseImageSrc]);

  // Placed (inserted) images embed their own src directly on the object (see PlacedImageObject's
  // doc comment) rather than going through baseImageSrc above - decodes any that aren't already in
  // the shared cache (a freshly-inserted one already is, by the time it's added; this mainly
  // covers reopening a document - undo/redo, or a fresh load - that already has some) and redraws
  // once each resolves.
  useEffect(() => {
    let cancelled = false;
    const missing = objects.filter((o): o is Extract<ImageAnnotationObject, { type: "placed-image" }> => o.type === "placed-image" && !getCachedImage(o.src));
    Promise.all(missing.map((o) => preloadImage(o.src))).then(
      () => {
        if (!cancelled && missing.length > 0) redraw();
      },
      (err) => console.error("Failed to decode placed image:", err)
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objects]);

  // The object currently being edited via the inline input (edit mode only - create mode has no
  // pre-existing object to hide). A plain id/null, not the whole textEditor object, so it only
  // changes on starting/stopping an edit or switching which object - never on every keystroke
  // (textEditor.value changes every keystroke, but isn't read here) - see redraw's own comment for
  // why that distinction matters.
  const hiddenWhileEditingId = textEditor?.mode === "edit" ? textEditor.original?.id ?? null : null;

  // Excludes hiddenWhileEditingId from the composed canvas while it's being edited - without this,
  // the committed object keeps rendering directly underneath the live editing input for the whole
  // edit, and since the input's own size/position only approximates the real measured bounds (a
  // native <input> isn't pixel-identical to canvas-drawn text, more so once background/bold/large
  // sizes are involved), the two visibly don't line up - it reads as the label being duplicated
  // rather than as one label being edited.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const liveById = liveObjects ? new Map(liveObjects.map((o) => [o.id, o])) : null;
    const displayObjects = objects.filter((o) => o.id !== hiddenWhileEditingId).map((o) => liveById?.get(o.id) ?? o);
    renderComposedCanvas(canvas, baseImageElRef.current, baseWidth, baseHeight, adjustments, displayObjects);
  }, [objects, baseWidth, baseHeight, adjustments, liveObjects, hiddenWhileEditingId]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const clearPreview = (): void => {
    const canvas = previewCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  useImperativeHandle(
    ref,
    () => ({
      getWorkingCanvas: () => canvasRef.current,
      getCropRect: () => cropRect,
    }),
    [cropRect]
  );

  const toNaturalPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  };

  const selectedObjects = objects.filter((o) => selectedObjectIds.includes(o.id));
  // Resize handles, the placed-image chrome, and the color/width-sync-from-selection effect
  // (ImageEditor.tsx) only make sense for exactly one selected object - null the moment a second
  // one joins the selection.
  const primarySelectedObject = selectedObjectIds.length === 1 ? selectedObjects[0] ?? null : null;
  const liveById = liveObjects ? new Map(liveObjects.map((o) => [o.id, o])) : null;

  const getHandles = (object: ImageAnnotationObject): { id: string; x: number; y: number; cursor: string }[] => {
    if (object.type === "arrow") {
      return [
        { id: "start", x: object.x1, y: object.y1, cursor: "move" },
        { id: "end", x: object.x2, y: object.y2, cursor: "move" },
      ];
    }
    // getObjectBounds already returns null for every type with its own dedicated chrome instead
    // of these generic corner handles (text, placed-image) - see its own doc comment.
    const bounds = getObjectBounds(object);
    if (!bounds) return [];
    const corners: { id: ResizeCorner; cursor: string }[] = [
      { id: "nw", cursor: "nwse-resize" },
      { id: "ne", cursor: "nesw-resize" },
      { id: "sw", cursor: "nesw-resize" },
      { id: "se", cursor: "nwse-resize" },
    ];
    return corners.map((c) => ({
      id: c.id,
      cursor: c.cursor,
      x: c.id.includes("w") ? bounds.x : bounds.x + bounds.w,
      y: c.id.includes("n") ? bounds.y : bounds.y + bounds.h,
    }));
  };

  const scheduleLiveRedraw = (compute: () => void): void => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      compute();
    });
  };

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const commitTextEditor = (): void => {
    const state = textEditor;
    setTextEditor(null);
    if (!state) return;
    const text = state.value.trim();
    if (!text) return;
    if (state.mode === "create") {
      const object = makeTextObject(state.x, state.y, text, color, fontSize, textBold, textBackground, textBackgroundColor);
      onAddObject(object);
      onTextCommitted(object.id);
    } else if (state.original) {
      onEditObject(state.original, { ...state.original, text, updatedAt: Date.now() });
      onTextCommitted(state.original.id);
    }
  };

  const openTextEditorAt = (x: number, y: number): void => setTextEditor({ mode: "create", x, y, value: "" });

  const beginEditExistingText = (object: Extract<ImageAnnotationObject, { type: "text" }>): void => {
    setTextEditor({ mode: "edit", x: object.x, y: object.y, value: object.text, original: object });
  };

  const handlePointerDown = (e: React.PointerEvent): void => {
    if (textEditor) return; // let the inline input's own blur/Enter commit first
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const { x, y } = toNaturalPoint(e.clientX, e.clientY);

    if (tool === "crop") {
      dragRef.current = { kind: "crop", startX: x, startY: y, curX: x, curY: y };
      return;
    }

    if (tool === "text") {
      openTextEditorAt(x, y);
      return;
    }

    if (tool === "pen" || tool === "highlighter") {
      dragRef.current = { kind: "freehand", tool, points: [{ x, y, pressure: e.pressure || 0.5 }] };
      return;
    }

    if (tool === "arrow" || tool === "rect" || tool === "ellipse" || tool === "blur") {
      dragRef.current = { kind: "shape", tool, startX: x, startY: y, curX: x, curY: y };
      return;
    }

    // tool === "select"
    if (primarySelectedObject) {
      const hitRadius = HANDLE_HIT_PADDING / zoom + HANDLE_SIZE / 2 / zoom;
      const handle = getHandles(primarySelectedObject).find((h) => Math.hypot(h.x - x, h.y - y) <= hitRadius);
      if (handle) {
        dragRef.current =
          primarySelectedObject.type === "arrow"
            ? { kind: "arrow-endpoint", object: primarySelectedObject, endpoint: handle.id as "start" | "end", curX: x, curY: y }
            : { kind: "resize", object: primarySelectedObject, corner: handle.id as ResizeCorner, curX: x, curY: y };
        return;
      }
    }

    const hit = findObjectAt(objects, x, y);
    if (hit) {
      // Shift-click toggles membership without starting a drag - same convention as marquee's own
      // `additive` flag, and matches most design tools' "shift adjusts the set, plain click acts
      // on it" split.
      if (e.shiftKey) {
        onSelectObjects(selectedObjectIds.includes(hit.id) ? selectedObjectIds.filter((id) => id !== hit.id) : [...selectedObjectIds, hit.id]);
        return;
      }
      // Clicking (without shift) on an object that's already part of a multi-selection drags the
      // whole group; clicking anything else collapses the selection down to just that object first.
      const alreadyInGroup = selectedObjectIds.length > 1 && selectedObjectIds.includes(hit.id);
      const groupIds = alreadyInGroup ? selectedObjectIds : [hit.id];
      if (!alreadyInGroup) onSelectObjects(groupIds);
      // Reset before the drag starts, not just after it ends - a plain click (select without any
      // actual movement) never fires a pointermove, so lastMoveDeltaRef would otherwise still hold
      // whatever delta the *previous* real drag left behind, and handlePointerUp's "move" case
      // would re-apply that stale offset to the object that was just clicked, snapping or flinging
      // it despite no drag having happened this time.
      lastMoveDeltaRef.current = { dx: 0, dy: 0 };
      dragRef.current = { kind: "move", objects: objects.filter((o) => groupIds.includes(o.id)), startX: x, startY: y, curX: x, curY: y };
    } else if (e.shiftKey) {
      dragRef.current = { kind: "marquee", additive: true, startX: x, startY: y, curX: x, curY: y };
    } else {
      onSelectObjects([]);
      dragRef.current = { kind: "marquee", additive: false, startX: x, startY: y, curX: x, curY: y };
    }
  };

  const handlePointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = toNaturalPoint(e.clientX, e.clientY);

    if (drag.kind === "freehand") {
      drag.points.push({ x, y, pressure: e.pressure || 0.5 });
      const canvas = previewCanvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        renderLiveStroke(ctx, drag.tool, drag.points, color, strokeWidth);
      }
      return;
    }

    if (drag.kind === "shape") {
      drag.curX = x;
      drag.curY = y;
      scheduleLiveRedraw(() => {
        const canvas = previewCanvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const nx = Math.min(drag.startX, drag.curX);
        const ny = Math.min(drag.startY, drag.curY);
        const nw = Math.abs(drag.curX - drag.startX);
        const nh = Math.abs(drag.curY - drag.startY);
        if (drag.tool === "arrow") {
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = strokeWidth;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(drag.startX, drag.startY);
          ctx.lineTo(drag.curX, drag.curY);
          ctx.stroke();
          ctx.restore();
        } else if (drag.tool === "blur") {
          ctx.save();
          ctx.strokeStyle = "rgba(255,255,255,0.9)";
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 2;
          ctx.strokeRect(nx, ny, nw, nh);
          ctx.restore();
        } else {
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = strokeWidth;
          if (drag.tool === "rect") ctx.strokeRect(nx, ny, nw, nh);
          else {
            ctx.beginPath();
            ctx.ellipse(nx + nw / 2, ny + nh / 2, nw / 2, nh / 2, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
      });
      return;
    }

    if (drag.kind === "crop") {
      drag.curX = x;
      drag.curY = y;
      scheduleLiveRedraw(() => {
        const nx = Math.max(0, Math.min(baseWidth, Math.min(drag.startX, drag.curX)));
        const ny = Math.max(0, Math.min(baseHeight, Math.min(drag.startY, drag.curY)));
        const fx = Math.max(0, Math.min(baseWidth, Math.max(drag.startX, drag.curX)));
        const fy = Math.max(0, Math.min(baseHeight, Math.max(drag.startY, drag.curY)));
        setCropRect({ x: nx, y: ny, w: Math.max(1, fx - nx), h: Math.max(1, fy - ny) });
      });
      return;
    }

    if (drag.kind === "marquee") {
      drag.curX = x;
      drag.curY = y;
      scheduleLiveRedraw(() => {
        setMarqueeRect({
          x: Math.min(drag.startX, drag.curX),
          y: Math.min(drag.startY, drag.curY),
          w: Math.abs(drag.curX - drag.startX),
          h: Math.abs(drag.curY - drag.startY),
        });
      });
      return;
    }

    if (drag.kind === "move") {
      drag.curX = x;
      drag.curY = y;
      scheduleLiveRedraw(() => {
        let dx = drag.curX - drag.startX;
        let dy = drag.curY - drag.startY;
        // Hold Shift while dragging to temporarily suspend snapping - the same escape hatch most
        // design tools give for a move that's deliberately meant to land off-guide.
        if (!e.shiftKey) {
          const movedIds = new Set(drag.objects.map((o) => o.id));
          const targets: Bounds[] = [{ x: 0, y: 0, w: baseWidth, h: baseHeight }, ...objects.filter((o) => !movedIds.has(o.id)).map(getSelectionBounds)];
          const movingBounds = unionBounds(drag.objects.map((o) => getSelectionBounds(translateObject(o, dx, dy))));
          const snap = computeSnap(movingBounds, targets, SNAP_THRESHOLD_SCREEN_PX / zoom);
          dx += snap.dx;
          dy += snap.dy;
          setSnapGuides(snap.guides);
        } else {
          setSnapGuides([]);
        }
        lastMoveDeltaRef.current = { dx, dy };
        setLiveObjects(drag.objects.map((o) => translateObject(o, dx, dy)));
      });
      return;
    }

    if (drag.kind === "resize") {
      drag.curX = x;
      drag.curY = y;
      scheduleLiveRedraw(() => {
        const object = drag.object;
        if (object.type === "rect" || object.type === "ellipse" || object.type === "blur") {
          setLiveObjects([resizeBoxObject(object, drag.corner, drag.curX, drag.curY)]);
        }
      });
      return;
    }

    if (drag.kind === "arrow-endpoint") {
      drag.curX = x;
      drag.curY = y;
      scheduleLiveRedraw(() => {
        const object = drag.object;
        if (object.type !== "arrow") return;
        setLiveObjects([drag.endpoint === "start" ? { ...object, x1: drag.curX, y1: drag.curY } : { ...object, x2: drag.curX, y2: drag.curY }]);
      });
      return;
    }
  };

  const handlePointerUp = (): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    clearPreview();
    if (!drag) return;

    if (drag.kind === "freehand") {
      if (drag.points.length > 1) {
        onAddObject(drag.tool === "pen" ? makeStrokeObject(drag.points, color, strokeWidth) : makeHighlightObject(drag.points, color, strokeWidth));
      }
      return;
    }

    if (drag.kind === "shape") {
      const nx = Math.min(drag.startX, drag.curX);
      const ny = Math.min(drag.startY, drag.curY);
      const nw = Math.abs(drag.curX - drag.startX);
      const nh = Math.abs(drag.curY - drag.startY);
      if (drag.tool === "arrow") {
        if (Math.hypot(drag.curX - drag.startX, drag.curY - drag.startY) > 2) {
          onAddObject(makeArrowObject(drag.startX, drag.startY, drag.curX, drag.curY, color, strokeWidth));
        }
      } else if (nw > 2 && nh > 2) {
        if (drag.tool === "rect") onAddObject(makeRectObject(nx, ny, nw, nh, color, strokeWidth));
        else if (drag.tool === "ellipse") onAddObject(makeEllipseObject(nx, ny, nw, nh, color, strokeWidth));
        else onAddObject(makeBlurObject(nx, ny, nw, nh));
      }
      return;
    }

    if (drag.kind === "marquee") {
      setMarqueeRect(null);
      const rect = {
        x: Math.min(drag.startX, drag.curX),
        y: Math.min(drag.startY, drag.curY),
        w: Math.abs(drag.curX - drag.startX),
        h: Math.abs(drag.curY - drag.startY),
      };
      const hitIds = findObjectsInRect(objects, rect).map((o) => o.id);
      onSelectObjects(drag.additive ? Array.from(new Set([...selectedObjectIds, ...hitIds])) : hitIds);
      return;
    }

    if (drag.kind === "move") {
      setLiveObjects(null);
      setSnapGuides([]);
      const { dx, dy } = lastMoveDeltaRef.current;
      if (dx !== 0 || dy !== 0) {
        if (drag.objects.length === 1) onEditObject(drag.objects[0], translateObject(drag.objects[0], dx, dy));
        else onBatchEditObjects(drag.objects, drag.objects.map((o) => translateObject(o, dx, dy)));
      }
      return;
    }

    if (drag.kind === "resize") {
      setLiveObjects(null);
      const object = drag.object;
      if (object.type === "rect" || object.type === "ellipse" || object.type === "blur") {
        onEditObject(object, resizeBoxObject(object, drag.corner, drag.curX, drag.curY));
      }
      return;
    }

    if (drag.kind === "arrow-endpoint") {
      setLiveObjects(null);
      const object = drag.object;
      if (object.type === "arrow") {
        onEditObject(object, drag.endpoint === "start" ? { ...object, x1: drag.curX, y1: drag.curY } : { ...object, x2: drag.curX, y2: drag.curY });
      }
      return;
    }
    // "crop" needs no per-gesture commit - cropRect state just stays as the drag left it, read
    // later by the parent via getCropRect() when the user clicks Apply.
  };

  const displaySize = { width: baseWidth * zoom, height: baseHeight * zoom };
  const primaryLive = primarySelectedObject ? liveById?.get(primarySelectedObject.id) ?? primarySelectedObject : null;
  const selectionBounds: Bounds | null = primaryLive ? getObjectBounds(primaryLive) : null;
  const cursorForTool: React.CSSProperties["cursor"] =
    tool === "select" ? "default" : tool === "crop" ? "crosshair" : tool === "text" ? "text" : "crosshair";

  return (
    <div ref={containerRef} className="relative" style={{ width: displaySize.width, height: displaySize.height }}>
      <canvas ref={canvasRef} width={baseWidth} height={baseHeight} style={{ width: "100%", height: "100%", position: "absolute", inset: 0 }} />
      <canvas
        ref={previewCanvasRef}
        width={baseWidth}
        height={baseHeight}
        style={{ width: "100%", height: "100%", position: "absolute", inset: 0, pointerEvents: "none" }}
      />

      <div
        className="absolute inset-0"
        style={{ cursor: cursorForTool }}
        // A plain click's default action shifts focus (usually to nothing, since this div isn't
        // itself focusable) as part of mousedown - same "prevent the browser from stealing focus
        // out from under an element we're about to focus ourselves" fix ColorSwatchPicker.tsx uses
        // for its own popover. Without it, the Text tool's autoFocus on the freshly-mounted
        // editing <input> below wins the race only long enough to register, then this div's own
        // native mousedown default action blurs it again on the very same click - the input
        // mounts, focuses, and unmounts within one gesture, which reads as "clicking with the Text
        // tool does nothing" since a human can't perceive a flash that fast.
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={(e) => {
          if (tool !== "select") return;
          const { x, y } = toNaturalPoint(e.clientX, e.clientY);
          const hit = findObjectAt(objects, x, y);
          if (hit?.type === "text") {
            onSelectObjects([hit.id]);
            beginEditExistingText(hit);
          }
        }}
      >
        {/* Single-selection outline + resize handles - unchanged from before multi-select existed.
            Suppressed once a second object joins the selection (see the multi-select boxes below
            instead), since resize handles only ever act on one object at a time. */}
        {selectionBounds && tool === "select" && (
          <div
            className="absolute border-2 border-dashed border-blue-400 pointer-events-none"
            style={{
              left: selectionBounds.x * zoom,
              top: selectionBounds.y * zoom,
              width: selectionBounds.w * zoom,
              height: selectionBounds.h * zoom,
            }}
          />
        )}

        {primaryLive &&
          tool === "select" &&
          getHandles(primaryLive).map((h) => (
            <div
              key={h.id}
              onPointerDown={(e) => {
                e.stopPropagation();
                handlePointerDown(e);
              }}
              className="absolute rounded-full bg-white border-2 border-blue-500 shadow-sm"
              style={{
                left: h.x * zoom - HANDLE_SIZE / 2,
                top: h.y * zoom - HANDLE_SIZE / 2,
                width: HANDLE_SIZE,
                height: HANDLE_SIZE,
                cursor: h.cursor,
              }}
            />
          ))}

        {/* Placed (inserted) images get their own dedicated move/resize/rotate chrome - reused
            directly from the PDF annotator rather than this canvas's generic axis-aligned
            handles, since it already supports rotation-aware, center-anchored resize (see
            PlacedImageObject's own doc comment). Only shown for a single, non-grouped selection -
            same reasoning as the resize handles above. */}
        {primarySelectedObject?.type === "placed-image" &&
          tool === "select" &&
          (() => {
            const display = primaryLive?.type === "placed-image" ? primaryLive : primarySelectedObject;
            return (
              <ImageAnnotationEditor
                left={display.x * zoom}
                top={display.y * zoom}
                width={display.width * zoom}
                height={display.height * zoom}
                rotation={display.rotation}
                src={primarySelectedObject.src}
                onMoveEnd={(newLeft, newTop) => onEditObject(primarySelectedObject, { ...primarySelectedObject, x: newLeft / zoom, y: newTop / zoom })}
                onResizeEnd={(newWidth, newHeight, newLeft, newTop) =>
                  onEditObject(primarySelectedObject, {
                    ...primarySelectedObject,
                    width: newWidth / zoom,
                    height: newHeight / zoom,
                    x: newLeft / zoom,
                    y: newTop / zoom,
                  })
                }
                onRotateEnd={(newRotation) => onEditObject(primarySelectedObject, { ...primarySelectedObject, rotation: newRotation })}
                onDelete={() => onDeleteObject(primarySelectedObject)}
              />
            );
          })()}

        {/* Text gets the same kind of dedicated move/resize/rotate chrome placed images do, for
            the same reason (rotation-aware resize needs center-anchored math the generic
            axis-aligned handles above don't do) - "resize" scales fontSize rather than a
            width/height that doesn't independently exist for text (see TextAnnotationEditor's own
            doc comment). Hidden while the inline text-editing input is open (!textEditor) so the
            two pieces of chrome for the same object never show at once. */}
        {primarySelectedObject?.type === "text" &&
          tool === "select" &&
          !textEditor &&
          (() => {
            const display = primaryLive?.type === "text" ? primaryLive : primarySelectedObject;
            // Visual bounds (includes the background backdrop's padding, when it has one) so the
            // move/resize/rotate chrome traces the box the user actually sees, not just the glyphs.
            const bounds = textObjectVisualBounds(display);
            return (
              <TextAnnotationEditor
                left={bounds.x * zoom}
                top={bounds.y * zoom}
                width={bounds.w * zoom}
                height={bounds.h * zoom}
                rotation={display.rotation}
                fontSize={display.fontSize}
                onMoveEnd={(newLeft, newTop) => onEditObject(primarySelectedObject, { ...primarySelectedObject, x: newLeft / zoom, y: newTop / zoom })}
                onResizeEnd={(newFontSize) => {
                  // The drag itself is center-anchored (TextAnnotationEditor scales its wrapper
                  // outward from the box's own center), but fontSize alone doesn't determine
                  // position - x/y is the text's top-left, and a bigger/smaller fontSize means a
                  // bigger/smaller measured box anchored at that same top-left. Without also
                  // shifting x/y here to keep the *center* fixed, the commit would visibly jump
                  // the instant the handle is released, snapping from "grew outward from center"
                  // (what the drag just showed) to "grew from the old top-left" (what actually
                  // rendered) - recomputing the new bounds and re-deriving x/y from the same
                  // center the drag preview used keeps the two in agreement.
                  const before = textObjectBounds(primarySelectedObject);
                  const centerX = before.x + before.w / 2;
                  const centerY = before.y + before.h / 2;
                  const after = textObjectBounds({ ...primarySelectedObject, fontSize: newFontSize });
                  onEditObject(primarySelectedObject, {
                    ...primarySelectedObject,
                    fontSize: newFontSize,
                    x: centerX - after.w / 2,
                    y: centerY - after.h / 2,
                  });
                }}
                onRotateEnd={(newRotation) => onEditObject(primarySelectedObject, { ...primarySelectedObject, rotation: newRotation })}
                onDelete={() => onDeleteObject(primarySelectedObject)}
                onDoubleClick={() => beginEditExistingText(primarySelectedObject)}
              />
            );
          })()}

        {/* Multi-selection: a plain dashed box per selected object (via getSelectionBounds, which
            - unlike getObjectBounds above - covers every object type) tracking live position
            during a group drag - no resize handles, since multi-object resize isn't supported. */}
        {tool === "select" &&
          selectedObjectIds.length > 1 &&
          selectedObjects.map((o) => {
            const bounds = getSelectionBounds(liveById?.get(o.id) ?? o);
            return (
              <div
                key={o.id}
                className="absolute border-2 border-dashed border-blue-400 pointer-events-none"
                style={{ left: bounds.x * zoom, top: bounds.y * zoom, width: bounds.w * zoom, height: bounds.h * zoom }}
              />
            );
          })}

        {/* Rubber-band marquee - a translucent fill so the drag gesture itself is visible, not
            just its eventual result. */}
        {marqueeRect && (
          <div
            className="absolute bg-blue-400/10 border border-blue-400 pointer-events-none"
            style={{ left: marqueeRect.x * zoom, top: marqueeRect.y * zoom, width: marqueeRect.w * zoom, height: marqueeRect.h * zoom }}
          />
        )}

        {/* Smart-guide lines - full-canvas-height/width so an alignment against something far from
            the dragged object is still obviously visible, same convention Figma/PowerPoint use. */}
        {snapGuides.map((g, i) =>
          g.axis === "v" ? (
            <div key={i} className="absolute w-px bg-pink-500 pointer-events-none" style={{ left: g.pos * zoom, top: 0, height: displaySize.height }} />
          ) : (
            <div key={i} className="absolute h-px bg-pink-500 pointer-events-none" style={{ top: g.pos * zoom, left: 0, width: displaySize.width }} />
          )
        )}

        {tool === "crop" && cropRect && (
          <>
            <div className="absolute bg-black/60 pointer-events-none" style={{ left: 0, top: 0, right: 0, height: cropRect.y * zoom }} />
            <div
              className="absolute bg-black/60 pointer-events-none"
              style={{ left: 0, top: (cropRect.y + cropRect.h) * zoom, right: 0, bottom: 0 }}
            />
            <div
              className="absolute bg-black/60 pointer-events-none"
              style={{ left: 0, top: cropRect.y * zoom, width: cropRect.x * zoom, height: cropRect.h * zoom }}
            />
            <div
              className="absolute bg-black/60 pointer-events-none"
              style={{ left: (cropRect.x + cropRect.w) * zoom, top: cropRect.y * zoom, right: 0, height: cropRect.h * zoom }}
            />
            <div
              className="absolute outline outline-2 outline-white pointer-events-none"
              style={{ left: cropRect.x * zoom, top: cropRect.y * zoom, width: cropRect.w * zoom, height: cropRect.h * zoom }}
            />
          </>
        )}
      </div>

      {textEditor && (
        <input
          type="text"
          autoFocus
          autoComplete="off"
          placeholder="Type text…"
          value={textEditor.value}
          onChange={(e) => setTextEditor((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
          onKeyDown={(e) => {
            // Stop the keystroke from also reaching ImageEditor.tsx's document-level shortcut
            // handler - it already bails out via isEditableTarget(document.activeElement), but
            // that only works once this input has actually taken focus; stopping propagation here
            // is a second, unconditional guard against the same class of "two listeners on the
            // same keydown" conflict the arrow-key file-navigation bug turned out to be.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setTextEditor(null);
            }
          }}
          onBlur={commitTextEditor}
          // A real (if translucent) fill + visible ring, not just a bare transparent box - against
          // a busy or dark screenshot a transparent input with only a thin ring was easy to miss
          // entirely, which read as "clicking with the Text tool does nothing". When the
          // Background style is on, this fill switches to the *actual* configured background
          // color (at the same alpha renderTextObject draws with) instead of the generic neutral
          // one, so what's on screen while typing already matches what commits to the canvas -
          // otherwise there was no way to tell the background color setting was doing anything
          // until after committing.
          className={`absolute outline-none ring-2 ring-blue-500 rounded px-1 shadow-lg ${
            textBackground ? "" : "bg-white/90 dark:bg-neutral-900/90"
          }`}
          style={{
            left: textEditor.x * zoom,
            top: textEditor.y * zoom,
            // Floored at 14 CSS px regardless of zoom - these are typically 4K screenshots opened
            // fit-to-window at well under 100% zoom, where fontSize*zoom alone shrinks the caret
            // and typed characters down to a couple of CSS pixels: technically present, but
            // unreadable and effectively "the text tool doesn't work". The committed object itself
            // still uses the real, unfloored fontSize (see commitTextEditor/renderTextObject) -
            // only this live editing affordance gets the floor.
            fontSize: Math.max(14, fontSize * zoom),
            // Same constant renderTextObject uses for the committed object, not a second hardcoded
            // copy of the string - keeps the live editor's font guaranteed identical to what's
            // about to be drawn to canvas rather than two literals that could silently drift apart.
            fontFamily: TEXT_FONT_FAMILY,
            fontWeight: textBold ? 700 : 400,
            color,
            backgroundColor: textBackground ? hexToRgba(textBackgroundColor, TEXT_BACKGROUND_ALPHA) : undefined,
            minWidth: 80,
            zIndex: 20,
          }}
        />
      )}
    </div>
  );
});

export default ImageEditorCanvas;
