// components/ImageEditor.tsx
//
// Top-level image-editing surface - the "image" category's counterpart to PdfAnnotator.tsx.
// Owns tool/color/zoom/selection state, wires ImageEditorToolbar <-> ImageEditorCanvas <-> the
// image-edit store, and runs the two IO actions that aren't part of the store's own load/edit/
// autosave lifecycle: geometry ops (crop/rotate/flip, which read/write the working canvas directly
// - see ImageEditorCanvasHandle) and "Save a copy" (flattens to a real PNG file).
//
// The store itself is lifted to Dashboard.tsx (mirroring useVideoEditStore for the video editor)
// so a future sibling panel could share the exact same document instead of a second, out-of-sync
// copy. Selection, by contrast, is owned entirely here - it used to be lifted too (for
// ImageCollageDocker's thumbnail strip to share), but that docker is gone, and nothing else needs
// to observe or drive it anymore.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { IoBuildOutline, IoCheckmark, IoCopyOutline, IoDownloadOutline } from "react-icons/io5";
import { UseImageEditStoreResult } from "../hooks/useImageEditStore";
import { canvasToPngBytes } from "../handlers/pdfExportHandlers";
import {
  DEFAULT_BLUR_RADIUS,
  cropCanvas,
  getSelectionBounds,
  makePlacedImageObject,
  moveObjectsBackward,
  moveObjectsForward,
  moveObjectsToBack,
  moveObjectsToFront,
  rectsIntersect,
  rotateFlipCanvas,
  transformObjectForGeometry,
  translateObject,
} from "../handlers/imageEditHandlers";
import { GeometrySnapshot, ImageAdjustments, ImageAnnotationObject, ImageEditTool, NEUTRAL_ADJUSTMENTS } from "../utils/imageEditTypes";
import { fileToDataUrl } from "../utils/imageObjectCache";
import ImageEditorCanvas, { ImageEditorCanvasHandle } from "./image/ImageEditorCanvas";
import ImageEditorToolbar, { IconButton, SaveStatus, ZoomControl } from "./image/ImageEditorToolbar";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
// Same downscale-before-embedding / initial-size-cap convention PdfAnnotator.tsx uses for its own
// "insert image" - see fileToDataUrl's own doc comment (imageObjectCache.ts) for why the cap
// exists (keeps the autosave sidecar JSON, which embeds this as base64, from ballooning).
const INSERT_IMAGE_MAX_DIMENSION_PX = 2048;
const INSERT_IMAGE_MAX_INITIAL_WIDTH_FRACTION = 0.5;
const INSERT_IMAGE_MAX_INITIAL_HEIGHT_FRACTION = 0.8;

// Pen/arrow/rect/ellipse share one Width range - a fine annotation line/outline rarely needs to
// get much past this. A highlighter is a different instrument entirely (a broad marker swipe, not
// a pointer line), so it gets its own much wider range and remembered value below rather than
// being squeezed into the pen's scale - see the isHighlightWidth/highlightWidth split just below.
const PEN_MIN_WIDTH = 1;
const PEN_MAX_WIDTH = 24;
const HIGHLIGHT_MIN_WIDTH = 8;
const HIGHLIGHT_MAX_WIDTH = 160;
const DEFAULT_HIGHLIGHT_WIDTH = 32;
// These are typically 4K screenshots (3840x2160), where the old 28px default read as a barely-
// legible speck once the doc-fit zoom kicked in - see the text-editing input's own min-CSS-size
// floor in ImageEditorCanvas.tsx for the other half of this fix.
const DEFAULT_FONT_SIZE = 48;
const DEFAULT_TEXT_BACKGROUND_COLOR = "#000000";

// Fixed natural-pixel offset for a duplicated object, so the copy is never stacked exactly on top
// of (and thus indistinguishable from) the original - same idea as most editors' paste offset.
const DUPLICATE_OFFSET = 24;
// Per keypress, in natural (canvas) pixels - Shift multiplies this, same convention most design
// tools use for "small nudge" vs "big nudge".
const NUDGE_STEP = 1;
const NUDGE_STEP_SHIFT = 10;
const COPY_STATUS_RESET_MS = 1500;

// Which tools' next-drawn object takes the armed color/width - module-level (not recreated every
// render) since these never change; only used via .includes() below.
const COLOR_TOOLS: ImageEditTool[] = ["pen", "highlighter", "arrow", "rect", "ellipse", "text", "step"];
const WIDTH_TOOLS: ImageEditTool[] = ["pen", "highlighter", "arrow", "rect", "ellipse"];
const DEFAULT_BLUR_MODE: "blur" | "redact" = "blur";
// Floor for the precision Width/Height inputs - matches the drag handles' own MIN_DIAGONAL_DEVICE_PX
// intent (ImageAnnotationEditor.tsx): stop a typed value from collapsing the image to nothing.
const MIN_PLACED_IMAGE_SIZE = 8;

interface ImageEditorProps {
  sourcePath: string; // raw filesystem path, for Save a copy
  title?: string;
  // Fired once "Save a copy" finishes writing "<name> (edited).png" - mirrors
  // Dashboard.tsx's handleVideoExported (refresh the file list, then select the new file).
  onSaved: (newPath: string, newFileName: string) => void;
  store: UseImageEditStoreResult;
  // Toggled by the sidebar's tools button (same one that opens video's timeline docker) - shows
  // or hides the ImageEditorToolbar side panel. The canvas and its tool/selection state are
  // unaffected either way; this only controls whether the controls are on screen. Also flipped
  // to true automatically when the Crop tool is armed (see the effect below) and to false by the
  // panel's own close button, so it's a two-way toggle rather than a plain boolean prop.
  isToolsPanelOpen: boolean;
  onToolsPanelOpenChange: (open: boolean) => void;
}

const isEditableTarget = (el: Element | null): boolean => {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
};

const clampZoom = (z: number): number => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100));

const ImageEditor: React.FC<ImageEditorProps> = ({ sourcePath, title, onSaved, store, isToolsPanelOpen, onToolsPanelOpenChange }) => {
  const canvasRef = useRef<ImageEditorCanvasHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [tool, setTool] = useState<ImageEditTool>("select");
  const [color, setColor] = useState<string>("#e03131");
  const [strokeWidth, setStrokeWidth] = useState<number>(4);
  // Remembered separately from `strokeWidth` (pen/arrow/rect/ellipse) so switching tools never
  // clobbers either one's last-used value - see PEN_MIN_WIDTH/HIGHLIGHT_MIN_WIDTH above.
  const [highlightWidth, setHighlightWidth] = useState<number>(DEFAULT_HIGHLIGHT_WIDTH);
  const [fontSize, setFontSize] = useState<number>(DEFAULT_FONT_SIZE);
  const [textBold, setTextBold] = useState<boolean>(false);
  const [textBackground, setTextBackground] = useState<boolean>(false);
  const [textBackgroundColor, setTextBackgroundColor] = useState<string>(DEFAULT_TEXT_BACKGROUND_COLOR);
  const [shapeFilled, setShapeFilled] = useState<boolean>(false);
  const [arrowDashed, setArrowDashed] = useState<boolean>(false);
  const [arrowDoubleHeaded, setArrowDoubleHeaded] = useState<boolean>(false);
  const [blurMode, setBlurMode] = useState<"blur" | "redact">(DEFAULT_BLUR_MODE);
  const [blurRadius, setBlurRadius] = useState<number>(DEFAULT_BLUR_RADIUS);
  // Placed-image frame styling - there's no "armed tool" for placed-image (see
  // onInsertImageClick's own doc comment), so these values do double duty: they seed the *next*
  // inserted image (insertImageFile below) and, once one is selected, edit it directly, same
  // dual-purpose pattern fontSize/textBold/etc. already use for text.
  const [imageCornerRadius, setImageCornerRadius] = useState<number>(0);
  const [imageBorderWidth, setImageBorderWidth] = useState<number>(0);
  const [imageBorderColor, setImageBorderColor] = useState<string>("#ffffff");
  const [imageShadow, setImageShadow] = useState<boolean>(false);
  // Unlike the frame-styling fields above, width/height are read straight off the selected
  // image itself (handleImageWidthChange/handleImageHeightChange below) rather than mirrored into
  // their own state - there's no "next inserted image" size to remember the way there is a next
  // border/shadow, since insertImageFile already computes a sensible auto-fit size on its own.
  // The lock, though, is a pure UI preference with nothing on the object to read it back from, so
  // it does need its own state.
  const [imageAspectLocked, setImageAspectLocked] = useState<boolean>(true);
  const [zoom, setZoom] = useState<number>(1);
  // Which objects are selected - a plain id array (not a Set) since it's small and needs to be a
  // stable, easily-diffed value for props/effect deps. Multi-object: populated by a marquee drag
  // or shift-click in ImageEditorCanvas, not just single clicks.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Live-previewed while a brightness/contrast/saturation slider is being dragged; committed to
  // the store (one undo entry) only on release - see ImageEditorToolbar's onAdjustmentsCommit.
  const [liveAdjustments, setLiveAdjustments] = useState<ImageAdjustments | null>(null);
  const [isSavingCopy, setIsSavingCopy] = useState<boolean>(false);
  const [saveCopyError, setSaveCopyError] = useState<string | null>(null);
  // Transient feedback for the header's Copy button - "copied"/"error" revert to "idle" on their
  // own after COPY_STATUS_RESET_MS, same brief-confirmation pattern most copy-to-clipboard buttons
  // use (there's nothing else to poll: the browser gives no persistent "is this still on the
  // clipboard" state to reflect).
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  // Surfaces a failed crop/rotate/flip - these read pixels back off the working canvas
  // (toDataURL), which throws if the canvas is ever tainted (see preloadImage's crossOrigin fix
  // in imageObjectCache.ts for the concrete case that used to break this silently).
  const [geometryError, setGeometryError] = useState<string | null>(null);

  const didFitZoomRef = useRef(false);
  // Read by the pinch-gesture handler below so a touchmove mid-gesture can scale from the zoom
  // level the pinch *started* at without that handler needing to be torn down/rebound (and thus
  // lose its in-progress gesture state) every time zoom itself changes.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Reset per-image tool/adjustment/selection UI state when a different image is opened - a fresh
  // doc always starts with nothing selected, and a stale tool/live-adjustment/selection from the
  // previous image would otherwise dangle.
  useEffect(() => {
    setTool("select");
    setLiveAdjustments(null);
    setSelectedIds([]);
    didFitZoomRef.current = false;
  }, [sourcePath]);

  // The Crop tool's Apply/Cancel controls live in the (now collapsible) tools panel, not on the
  // canvas itself - arming Crop from the keyboard shortcut ("C") while the panel is closed would
  // otherwise strand the user mid-crop with no visible way to confirm it, so force the panel open
  // whenever Crop becomes active regardless of how it was triggered.
  useEffect(() => {
    if (tool === "crop" && !isToolsPanelOpen) onToolsPanelOpenChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // Fits the image to the available viewport once its true dimensions are known (a large photo
  // otherwise opens zoomed to 100%, mostly offscreen) - same one-shot-on-load idea
  // ImageOverlayCropPanel.tsx uses for its own displayRect, just against the whole content pane
  // instead of a fixed panel size.
  useEffect(() => {
    if (didFitZoomRef.current || !store.doc || !containerRef.current) return;
    const { clientWidth, clientHeight } = containerRef.current;
    if (clientWidth === 0 || clientHeight === 0) return;
    const fit = Math.min(1, (clientWidth - 48) / store.doc.baseWidth, (clientHeight - 48) / store.doc.baseHeight);
    setZoom(Math.max(MIN_ZOOM, Math.round(fit * 100) / 100));
    didFitZoomRef.current = true;
  }, [store.doc]);

  // The file-list sidebar (Dashboard.tsx) animates open/closed via a CSS width transition rather
  // than mounting/unmounting, which continuously reflows this pane's own width for its duration;
  // the tools panel toggle just below reflows it once, instantly. Either way, the canvas's own CSS
  // box never changes size (zoom is untouched by either), only its on-screen position does - which
  // can leave the browser's painted canvas layer visually lagging behind the freshly-repositioned
  // selection chrome (a plain DOM overlay that reflows immediately) until something forces a fresh
  // paint. Re-running the canvas draw on every observed size change of this pane is a cheap,
  // no-op-on-the-data way to force that repaint regardless of what resized it or by how much -
  // rAF-coalesced since a CSS transition can fire this several times per frame.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf: number | null = null;
    const observer = new ResizeObserver(() => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        canvasRef.current?.forceRepaint();
      });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, []);

  // Trackpad pinch and two-finger touchscreen pinch both zoom the canvas, same as most image/map
  // viewers. Browsers (Chrome/Edge/Safari) report a trackpad pinch as a wheel event with ctrlKey
  // set - that's indistinguishable from an actual held-Ctrl scroll, but a plain scroll wheel never
  // sets ctrlKey on its own, so gating on it here doesn't swallow normal wheel scrolling/panning.
  // Real touchscreen pinch has no such synthesized event, so it's handled separately via
  // touchstart/touchmove distance tracking. touch-action: pan-x pan-y (set below on the container)
  // stops the browser from also applying its own native pinch-zoom to the page while this runs.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z * (1 - e.deltaY * 0.01)));
    };

    let pinchStartDistance: number | null = null;
    let pinchStartZoom = 1;
    const touchDistance = (touches: TouchList): number => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

    const handleTouchStart = (e: TouchEvent): void => {
      if (e.touches.length !== 2) return;
      pinchStartDistance = touchDistance(e.touches);
      pinchStartZoom = zoomRef.current;
    };
    const handleTouchMove = (e: TouchEvent): void => {
      if (e.touches.length !== 2 || pinchStartDistance === null) return;
      e.preventDefault();
      setZoom(clampZoom(pinchStartZoom * (touchDistance(e.touches) / pinchStartDistance)));
    };
    const handleTouchEnd = (e: TouchEvent): void => {
      if (e.touches.length < 2) pinchStartDistance = null;
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd);
    el.addEventListener("touchcancel", handleTouchEnd);
    return () => {
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, []);

  // Drops any selected id that no longer exists - geometry ops clear every object, and undo/redo
  // can land on a document where a currently-selected id was never re-added.
  useEffect(() => {
    if (selectedIds.length === 0) return;
    const existingIds = new Set(store.doc?.objects.map((o) => o.id) ?? []);
    const filtered = selectedIds.filter((id) => existingIds.has(id));
    if (filtered.length !== selectedIds.length) setSelectedIds(filtered);
  }, [store.doc, selectedIds]);

  // Memoized (not recomputed inline) so its reference is stable across renders that don't actually
  // change the doc or the selection - it's a useCallback/useEffect dependency below, and a fresh
  // array every render would tear down and rebuild the global keydown listener on every render.
  const selectedObjects = useMemo(
    () => (store.doc ? store.doc.objects.filter((o) => selectedIds.includes(o.id)) : []),
    [store.doc, selectedIds]
  );
  // Color/width/font-size sync-from-selection and the onFontSizeChange dual-purpose edit below
  // only make sense for exactly one selected object - a mixed multi-selection just leaves the
  // panel's controls at whatever they last were rather than trying to show/edit "mixed" values.
  const primarySelectedObject = selectedObjects.length === 1 ? selectedObjects[0] : null;
  const effectiveAdjustments = liveAdjustments ?? store.doc?.adjustments ?? NEUTRAL_ADJUSTMENTS;

  // Syncs the toolbar's color/width/font-size controls FROM whatever just got selected, so
  // clicking a shape shows *its* color rather than whatever was last picked for drawing a new
  // one - keyed on the selected id (not the object itself, which changes reference on every
  // unrelated doc edit) so this runs once per selection change, not on every keystroke/drag that
  // happens to the currently-selected object afterward.
  useEffect(() => {
    if (!primarySelectedObject) return;
    if ("color" in primarySelectedObject) setColor(primarySelectedObject.color);
    // Excludes "placed-image" - see selectedWithWidth's own comment below for why its `width`
    // field (the image's actual pixel width) must never be read as a stroke width.
    if ("width" in primarySelectedObject && primarySelectedObject.type !== "placed-image") {
      if (primarySelectedObject.type === "highlight") setHighlightWidth(primarySelectedObject.width);
      else setStrokeWidth(primarySelectedObject.width);
    }
    if (primarySelectedObject.type === "text") {
      setFontSize(primarySelectedObject.fontSize);
      setTextBold(primarySelectedObject.bold);
      setTextBackground(primarySelectedObject.background);
      setTextBackgroundColor(primarySelectedObject.backgroundColor);
    }
    if (primarySelectedObject.type === "rect" || primarySelectedObject.type === "ellipse") {
      setShapeFilled(primarySelectedObject.filled);
    }
    if (primarySelectedObject.type === "arrow") {
      setArrowDashed(primarySelectedObject.dashed ?? false);
      setArrowDoubleHeaded(primarySelectedObject.doubleHeaded ?? false);
    }
    if (primarySelectedObject.type === "blur") {
      setBlurMode(primarySelectedObject.mode ?? "blur");
      setBlurRadius(primarySelectedObject.blurRadius);
    }
    if (primarySelectedObject.type === "placed-image") {
      setImageCornerRadius(primarySelectedObject.cornerRadius ?? 0);
      setImageBorderWidth(primarySelectedObject.borderWidth ?? 0);
      setImageBorderColor(primarySelectedObject.borderColor ?? "#ffffff");
      setImageShadow(primarySelectedObject.shadow ?? false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    primarySelectedObject?.id,
    // Also re-sync when fontSize changes on the *same* selected text object, not just when
    // selection moves to a different one - TextAnnotationEditor's resize handle sets fontSize
    // directly via store.editObject (ImageEditorCanvas.tsx), bypassing this component's own
    // onFontSizeChange entirely, so without this the Size slider would keep showing the value
    // from before the drag until the object was deselected and reselected.
    primarySelectedObject?.type === "text" ? primarySelectedObject.fontSize : undefined,
  ]);

  // Color/width apply to whichever color/width-bearing tool is armed (for the *next* thing
  // drawn) or, when something's selected, edit those objects directly instead (every selected
  // object that has the field, as one undo step when there's more than one) - same dual-purpose
  // pattern the pre-existing onFontSizeChange below already used for text.
  const selectedWithColor = useMemo(() => selectedObjects.filter((o) => "color" in o), [selectedObjects]);
  // Excludes "placed-image" even though it technically has a `width` field - that field is the
  // image's own pixel width (see PlacedImageObject's doc comment), not a stroke/line width, and
  // sharing the property name with StrokeObject/ArrowObject/RectObject/EllipseObject's actual
  // stroke width was a real bug: selecting an inserted image lit up the generic Width slider
  // (ranged for a *stroke*, 1-24px) bound directly to the image's real width, so a small drag
  // could visibly collapse a 1000+px image down to a sliver with no way back except Undo.
  const selectedWithWidth = useMemo(() => selectedObjects.filter((o) => "width" in o && o.type !== "placed-image"), [selectedObjects]);
  const showColor = COLOR_TOOLS.includes(tool) || selectedWithColor.length > 0;
  const showWidth = WIDTH_TOOLS.includes(tool) || selectedWithWidth.length > 0;
  const showFill = tool === "rect" || tool === "ellipse" || primarySelectedObject?.type === "rect" || primarySelectedObject?.type === "ellipse";
  const showArrowStyle = tool === "arrow" || primarySelectedObject?.type === "arrow";
  const showBlurMode = tool === "blur" || primarySelectedObject?.type === "blur";
  const showImageStyle = primarySelectedObject?.type === "placed-image";
  // Which Width scale is in play right now - the highlighter's own much wider one, or the shared
  // pen/arrow/rect/ellipse one - covers both "highlighter is armed" and "an existing highlight is
  // selected via the Select tool", same two cases showWidth itself already accounts for.
  const isHighlightWidth = tool === "highlighter" || primarySelectedObject?.type === "highlight";
  const activeWidth = isHighlightWidth ? highlightWidth : strokeWidth;

  const handleColorChange = useCallback(
    (next: string) => {
      setColor(next);
      if (selectedWithColor.length === 1) store.editObject(selectedWithColor[0], { ...selectedWithColor[0], color: next });
      else if (selectedWithColor.length > 1) {
        store.batchEditObjects(
          selectedWithColor,
          selectedWithColor.map((o) => ({ ...o, color: next }))
        );
      }
    },
    [selectedWithColor, store]
  );
  const handleStrokeWidthChange = useCallback(
    (next: number) => {
      if (isHighlightWidth) setHighlightWidth(next);
      else setStrokeWidth(next);
      if (selectedWithWidth.length === 1) store.editObject(selectedWithWidth[0], { ...selectedWithWidth[0], width: next });
      else if (selectedWithWidth.length > 1) {
        store.batchEditObjects(
          selectedWithWidth,
          selectedWithWidth.map((o) => ({ ...o, width: next }))
        );
      }
    },
    [selectedWithWidth, store, isHighlightWidth]
  );

  // Every geometry op (crop/rotate/flip) rasterizes the *base photo alone* (getBaseOnlyCanvas -
  // no annotation objects baked in) through the given pixel transform, then carries every
  // annotation object through the matching coordinate transform so each one survives as a live,
  // editable object instead of being flattened into the new bitmap - see
  // transformObjectForGeometry's own doc comment (imageEditHandlers.ts) for the per-object-type
  // details, and GeometryTransformParams for what `transformObject` below receives. Both the
  // before/after snapshots' `adjustments` are always neutral since each bitmap already has
  // whatever adjustments were live at the time baked into its own pixels - keeping the real
  // (possibly non-neutral) values on the `before` snapshot the way this used to work would double
  // them the instant an Undo restored it.
  const applyGeometry = useCallback(
    (
      pixelTransform: (canvas: HTMLCanvasElement) => HTMLCanvasElement,
      transformObject: (object: ImageAnnotationObject, srcWidth: number, srcHeight: number, outWidth: number, outHeight: number) => ImageAnnotationObject | null
    ) => {
      if (!store.doc) return;
      const baseCanvas = canvasRef.current?.getBaseOnlyCanvas();
      if (!baseCanvas) return;
      try {
        const beforeDataUrl = baseCanvas.toDataURL("image/png");
        const afterCanvas = pixelTransform(baseCanvas);
        const afterDataUrl = afterCanvas.toDataURL("image/png");
        const afterObjects = store.doc.objects
          .map((o) => transformObject(o, baseCanvas.width, baseCanvas.height, afterCanvas.width, afterCanvas.height))
          .filter((o): o is ImageAnnotationObject => o !== null);

        const before: GeometrySnapshot = {
          baseImageOverride: beforeDataUrl,
          baseWidth: baseCanvas.width,
          baseHeight: baseCanvas.height,
          adjustments: { ...NEUTRAL_ADJUSTMENTS },
          objects: store.doc.objects,
        };
        const after: GeometrySnapshot = {
          baseImageOverride: afterDataUrl,
          baseWidth: afterCanvas.width,
          baseHeight: afterCanvas.height,
          adjustments: { ...NEUTRAL_ADJUSTMENTS },
          objects: afterObjects,
        };
        store.commitGeometry(before, after);
        // Keeps whichever selected objects survived the transform selected (most do - only a crop
        // that moved an object fully outside the new bounds drops one), rather than unconditionally
        // clearing selection the way flattening-everything used to require.
        const survivingIds = new Set(afterObjects.map((o) => o.id));
        setSelectedIds((ids) => ids.filter((id) => survivingIds.has(id)));
        setGeometryError(null);
      } catch (err) {
        console.error("Failed to apply crop/rotate/flip:", err);
        setGeometryError(err instanceof Error ? err.message : String(err));
      }
    },
    [store]
  );

  const handleRotateCCW = useCallback(
    () =>
      applyGeometry(
        (c) => rotateFlipCanvas(c, 3, false, false),
        (o, srcWidth, srcHeight, outWidth, outHeight) =>
          transformObjectForGeometry(o, { srcWidth, srcHeight, outWidth, outHeight, quarterTurns: 3, flipH: false, flipV: false })
      ),
    [applyGeometry]
  );
  const handleRotateCW = useCallback(
    () =>
      applyGeometry(
        (c) => rotateFlipCanvas(c, 1, false, false),
        (o, srcWidth, srcHeight, outWidth, outHeight) =>
          transformObjectForGeometry(o, { srcWidth, srcHeight, outWidth, outHeight, quarterTurns: 1, flipH: false, flipV: false })
      ),
    [applyGeometry]
  );
  const handleFlipH = useCallback(
    () =>
      applyGeometry(
        (c) => rotateFlipCanvas(c, 0, true, false),
        (o, srcWidth, srcHeight, outWidth, outHeight) =>
          transformObjectForGeometry(o, { srcWidth, srcHeight, outWidth, outHeight, quarterTurns: 0, flipH: true, flipV: false })
      ),
    [applyGeometry]
  );
  const handleFlipV = useCallback(
    () =>
      applyGeometry(
        (c) => rotateFlipCanvas(c, 0, false, true),
        (o, srcWidth, srcHeight, outWidth, outHeight) =>
          transformObjectForGeometry(o, { srcWidth, srcHeight, outWidth, outHeight, quarterTurns: 0, flipH: false, flipV: true })
      ),
    [applyGeometry]
  );

  const handleCropApply = useCallback(() => {
    const rect = canvasRef.current?.getCropRect();
    if (!rect || rect.w < 1 || rect.h < 1) {
      setTool("select");
      return;
    }
    applyGeometry(
      (c) => cropCanvas(c, rect.x, rect.y, rect.w, rect.h),
      (o, _srcWidth, _srcHeight, outWidth, outHeight) => {
        const moved = translateObject(o, -rect.x, -rect.y);
        // Drops anything left with zero overlap against the cropped canvas - keeping it around,
        // invisible and unreachable outside the new bounds, would just be a silent leak.
        return rectsIntersect(getSelectionBounds(moved), { x: 0, y: 0, w: outWidth, h: outHeight }) ? moved : null;
      }
    );
    setTool("select");
  }, [applyGeometry]);

  const handleCropCancel = useCallback(() => setTool("select"), []);

  const handleDeleteSelected = useCallback(() => {
    if (selectedObjects.length === 0) return;
    if (selectedObjects.length === 1) store.deleteObject(selectedObjects[0]);
    else store.batchDeleteObjects(selectedObjects);
    setSelectedIds([]);
  }, [selectedObjects, store]);

  // Clones every selected object (fresh id/timestamps, nudged by DUPLICATE_OFFSET so the copy
  // never sits exactly on top of the original) and selects the copies - one undo step regardless
  // of how many objects were selected, via batchAddObjects.
  const handleDuplicateSelected = useCallback(() => {
    if (selectedObjects.length === 0) return;
    const now = Date.now();
    const clones: ImageAnnotationObject[] = selectedObjects.map((o) =>
      translateObject({ ...o, id: crypto.randomUUID(), createdAt: now, updatedAt: now }, DUPLICATE_OFFSET, DUPLICATE_OFFSET)
    );
    if (clones.length === 1) store.addObject(clones[0]);
    else store.batchAddObjects(clones);
    setSelectedIds(clones.map((o) => o.id));
  }, [selectedObjects, store]);

  // Layer order (front/back/forward/backward) - store.reorderObjects already existed (it's what
  // undo/redo across a drag-to-reorder would use), it just had no UI calling it yet. Guarded on
  // `store.doc` rather than `selectedObjects.length` alone since these read the *whole* objects
  // array, not just the selected ones.
  const handleBringToFront = useCallback(() => {
    if (!store.doc || selectedIds.length === 0) return;
    store.reorderObjects(moveObjectsToFront(store.doc.objects, selectedIds));
  }, [store, selectedIds]);
  const handleSendToBack = useCallback(() => {
    if (!store.doc || selectedIds.length === 0) return;
    store.reorderObjects(moveObjectsToBack(store.doc.objects, selectedIds));
  }, [store, selectedIds]);
  const handleBringForward = useCallback(() => {
    if (!store.doc || selectedIds.length === 0) return;
    store.reorderObjects(moveObjectsForward(store.doc.objects, selectedIds));
  }, [store, selectedIds]);
  const handleSendBackward = useCallback(() => {
    if (!store.doc || selectedIds.length === 0) return;
    store.reorderObjects(moveObjectsBackward(store.doc.objects, selectedIds));
  }, [store, selectedIds]);

  // Arrow-key nudge - moves every selected object by NUDGE_STEP (NUDGE_STEP_SHIFT with Shift) as
  // one undo step, the fine-positioning counterpart to dragging with the mouse.
  const handleNudgeSelected = useCallback(
    (dx: number, dy: number) => {
      if (selectedObjects.length === 0) return;
      if (selectedObjects.length === 1) store.editObject(selectedObjects[0], translateObject(selectedObjects[0], dx, dy));
      else store.batchEditObjects(selectedObjects, selectedObjects.map((o) => translateObject(o, dx, dy)));
    },
    [selectedObjects, store]
  );

  // Precision fallback for the drag handles' own resize (Width/Height number inputs in the
  // toolbar's Image section) - same center-anchored convention ImageAnnotationEditor's own drag
  // resize uses (see its doc comment), so typing a value doesn't shift the image's position the
  // way a top-left-anchored resize would. Locked to the image's current aspect ratio unless
  // imageAspectLocked has been turned off, in which case the other dimension is left untouched -
  // the one deliberate way to stretch an image this editor supports (the drag handles don't).
  const handleImageWidthChange = useCallback(
    (newWidth: number) => {
      if (primarySelectedObject?.type !== "placed-image" || !Number.isFinite(newWidth)) return;
      const obj = primarySelectedObject;
      const width = Math.max(MIN_PLACED_IMAGE_SIZE, newWidth);
      const height = imageAspectLocked ? Math.max(MIN_PLACED_IMAGE_SIZE, width * (obj.height / obj.width)) : obj.height;
      const centerX = obj.x + obj.width / 2;
      const centerY = obj.y + obj.height / 2;
      store.editObject(obj, { ...obj, width, height, x: centerX - width / 2, y: centerY - height / 2 });
    },
    [primarySelectedObject, imageAspectLocked, store]
  );
  const handleImageHeightChange = useCallback(
    (newHeight: number) => {
      if (primarySelectedObject?.type !== "placed-image" || !Number.isFinite(newHeight)) return;
      const obj = primarySelectedObject;
      const height = Math.max(MIN_PLACED_IMAGE_SIZE, newHeight);
      const width = imageAspectLocked ? Math.max(MIN_PLACED_IMAGE_SIZE, height * (obj.width / obj.height)) : obj.width;
      const centerX = obj.x + obj.width / 2;
      const centerY = obj.y + obj.height / 2;
      store.editObject(obj, { ...obj, width, height, x: centerX - width / 2, y: centerY - height / 2 });
    },
    [primarySelectedObject, imageAspectLocked, store]
  );

  // The "join/collage" building block: reads a picked/pasted file into a downscaled-if-needed
  // data URL (fileToDataUrl - same helper and size cap PdfAnnotator.tsx's own image insertion
  // uses), sizes it to fit within the current photo (capped by both width and height fractions,
  // never upscaled past its own natural size) and centers it, then adds and selects it so its
  // move/resize/rotate handles (ImageAnnotationEditor, via ImageEditorCanvas) show immediately.
  const insertImageFile = useCallback(
    async (file: File): Promise<void> => {
      if (!store.doc) return;
      try {
        const loaded = await fileToDataUrl(file, INSERT_IMAGE_MAX_DIMENSION_PX);
        const scale = Math.min(
          1,
          (store.doc.baseWidth * INSERT_IMAGE_MAX_INITIAL_WIDTH_FRACTION) / loaded.width,
          (store.doc.baseHeight * INSERT_IMAGE_MAX_INITIAL_HEIGHT_FRACTION) / loaded.height
        );
        const width = loaded.width * scale;
        const height = loaded.height * scale;
        const x = (store.doc.baseWidth - width) / 2;
        const y = (store.doc.baseHeight - height) / 2;

        const object = makePlacedImageObject(x, y, width, height, loaded.dataUrl, imageCornerRadius, imageBorderWidth, imageBorderColor, imageShadow);
        store.addObject(object);
        setTool("select");
        setSelectedIds([object.id]);
      } catch (err) {
        console.error("Failed to insert image:", err);
      }
    },
    [store, imageCornerRadius, imageBorderWidth, imageBorderColor, imageShadow]
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleInsertImageClick = useCallback((): void => {
    fileInputRef.current?.click();
  }, []);
  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-selecting the same file consecutively
      if (file) void insertImageFile(file);
    },
    [insertImageFile]
  );

  // Global paste-image support, same behavior/guard as PdfAnnotator.tsx's own paste listener -
  // skipped while focus is in an editable field (most relevantly this editor's own inline
  // text-note input) so pasting into a text label isn't hijacked into inserting an image instead.
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent): void => {
      if (isEditableTarget(document.activeElement)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageItem = Array.from(items).find((item) => item.type.startsWith("image/"));
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      void insertImageFile(file);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [insertImageFile]);

  const handleSaveCopy = useCallback(async () => {
    const canvas = canvasRef.current?.getWorkingCanvas();
    if (!canvas) return;
    setIsSavingCopy(true);
    setSaveCopyError(null);
    try {
      const bytes = await canvasToPngBytes(canvas);
      const outputPath = await invoke<string>("save_edited_image", { imagePath: sourcePath, bytes: Array.from(bytes) });
      const outputName = outputPath.split(/[\\/]/).pop() ?? outputPath;
      onSaved(outputPath, outputName);
    } catch (err) {
      console.error("Failed to save edited image:", err);
      setSaveCopyError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSavingCopy(false);
    }
  }, [sourcePath, onSaved]);

  // Copies the annotated result straight to the OS clipboard as a PNG - for the common "annotate a
  // screenshot, then paste it into Slack/an email/a doc" workflow, which otherwise means Save a
  // copy, then go find the file just to attach it somewhere else. Separate from handleSaveCopy
  // above since it never touches the filesystem (no invoke, no onSaved) and needs its own
  // transient success/error feedback rather than the persistent SaveStatus indicator.
  const handleCopyToClipboard = useCallback(async () => {
    const canvas = canvasRef.current?.getWorkingCanvas();
    if (!canvas) return;
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to encode image as PNG"))), "image/png");
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setCopyStatus("copied");
    } catch (err) {
      console.error("Failed to copy image to clipboard:", err);
      setCopyStatus("error");
    } finally {
      setTimeout(() => setCopyStatus("idle"), COPY_STATUS_RESET_MS);
    }
  }, []);

  // Full shortcut set, mirroring PdfAnnotator.tsx's own keydown handler shape (ignored while
  // focus is in an editable field - most relevantly the inline text-note input this editor's own
  // canvas opens for the Text tool, which needs every one of these keys for itself).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (isEditableTarget(document.activeElement)) return;

      if (e.key === "Escape") {
        e.preventDefault();
        if (tool === "crop") handleCropCancel();
        else {
          setTool("select");
          setSelectedIds([]);
        }
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedObjects.length > 0) {
        e.preventDefault();
        handleDeleteSelected();
        return;
      }

      if (
        selectedObjects.length > 0 &&
        (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        e.preventDefault();
        const step = e.shiftKey ? NUDGE_STEP_SHIFT : NUDGE_STEP;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        handleNudgeSelected(dx, dy);
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === "z" && !e.shiftKey) {
          e.preventDefault();
          if (store.canUndo) store.undo();
        } else if (key === "y" || (key === "z" && e.shiftKey)) {
          e.preventDefault();
          if (store.canRedo) store.redo();
        } else if (key === "d") {
          e.preventDefault();
          handleDuplicateSelected();
        } else if (key === "a") {
          e.preventDefault();
          if (store.doc) setSelectedIds(store.doc.objects.map((o) => o.id));
        } else if (key === "=" || key === "+" || e.code === "Equal" || e.code === "NumpadAdd") {
          e.preventDefault();
          setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + 0.25) * 100) / 100));
        } else if (key === "-" || e.code === "Minus" || e.code === "NumpadSubtract") {
          e.preventDefault();
          setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - 0.25) * 100) / 100));
        } else if (key === "0") {
          e.preventDefault();
          setZoom(1);
        } else if (key === "]") {
          e.preventDefault();
          if (e.shiftKey) handleBringToFront();
          else handleBringForward();
        } else if (key === "[") {
          e.preventDefault();
          if (e.shiftKey) handleSendToBack();
          else handleSendBackward();
        }
        return;
      }

      if (e.altKey) return;

      switch (e.key.toLowerCase()) {
        case "v":
          e.preventDefault();
          setTool("select");
          break;
        case "p":
          e.preventDefault();
          setTool("pen");
          break;
        case "h":
          e.preventDefault();
          setTool("highlighter");
          break;
        case "a":
          e.preventDefault();
          setTool("arrow");
          break;
        case "r":
          e.preventDefault();
          setTool("rect");
          break;
        case "o":
          e.preventDefault();
          setTool("ellipse");
          break;
        case "t":
          e.preventDefault();
          setTool("text");
          break;
        case "b":
          e.preventDefault();
          setTool("blur");
          break;
        case "n":
          e.preventDefault();
          setTool("step");
          break;
        case "c":
          e.preventDefault();
          setTool("crop");
          break;
        case "[":
          e.preventDefault();
          if (tool === "highlighter") setHighlightWidth((w) => Math.max(HIGHLIGHT_MIN_WIDTH, w - 4));
          else setStrokeWidth((w) => Math.max(PEN_MIN_WIDTH, w - 1));
          break;
        case "]":
          e.preventDefault();
          if (tool === "highlighter") setHighlightWidth((w) => Math.min(HIGHLIGHT_MAX_WIDTH, w + 4));
          else setStrokeWidth((w) => Math.min(PEN_MAX_WIDTH, w + 1));
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // Depends on store.canUndo/canRedo/undo/redo/doc individually (not the whole `store` object,
    // which useImageEditStore returns as a brand-new object literal every render) so this
    // listener isn't torn down and rebuilt on every unrelated render - same reasoning
    // selectedObjects itself is memoized for above.
  }, [
    tool,
    selectedObjects,
    store.canUndo,
    store.canRedo,
    store.undo,
    store.redo,
    store.doc,
    handleCropCancel,
    handleDeleteSelected,
    handleDuplicateSelected,
    handleNudgeSelected,
    handleBringToFront,
    handleSendToBack,
    handleBringForward,
    handleSendBackward,
  ]);

  if (store.loadError && !store.doc) {
    return (
      <div className="flex items-center justify-center h-full w-full text-red-600 dark:text-red-400 italic">
        Failed to load image: {store.loadError}
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col bg-gradient-to-b from-neutral-100 to-neutral-200 dark:from-neutral-900 dark:to-neutral-950">
      {/* Persistent header - stays visible regardless of the tools panel, so viewing/zooming and
          checking/triggering the autosave never depend on that panel being open. Everything that
          actually edits the image (tools, geometry ops, adjustments, undo/redo) lives in the
          panel instead. The tools toggle here mirrors the sidebar's own tools button (Dashboard.tsx)
          rather than replacing it - collapsing the file-list sidebar hides that one entirely, and
          this is otherwise the only way back into the panel. */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-white/75 dark:bg-neutral-900/80 backdrop-blur-xl border-b border-black/[0.04] dark:border-white/[0.08]">
        <IconButton title={isToolsPanelOpen ? "Hide image tools" : "Show image tools"} active={isToolsPanelOpen} onClick={() => onToolsPanelOpenChange(!isToolsPanelOpen)}>
          <IoBuildOutline size={15} />
        </IconButton>
        {title && (
          <span className="text-sm font-medium text-neutral-600 dark:text-neutral-300 truncate min-w-0" title={title}>
            {title}
          </span>
        )}
        <div className="flex items-center gap-3 shrink-0 ml-auto">
          <ZoomControl zoom={zoom} onZoomChange={setZoom} minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} />
          <IconButton
            title={copyStatus === "error" ? "Failed to copy - try again" : copyStatus === "copied" ? "Copied!" : "Copy to clipboard"}
            active={copyStatus === "copied"}
            onClick={handleCopyToClipboard}
          >
            {copyStatus === "copied" ? <IoCheckmark size={16} className="text-emerald-500" /> : <IoCopyOutline size={16} />}
          </IconButton>
          <IconButton title="Save a copy" onClick={handleSaveCopy}>
            <IoDownloadOutline size={16} />
          </IconButton>
          <SaveStatus isSaving={isSavingCopy || store.isSaving} saveError={saveCopyError ?? store.saveError} />
        </div>
      </div>

      {geometryError && (
        <div className="shrink-0 mx-auto mt-2 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-xs">
          Failed to apply crop/rotate/flip: {geometryError}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div
          ref={containerRef}
          // overscroll-contain keeps scroll momentum from chaining into the sidebar/tools panel
          // (or the window itself) once this pane's own content is scrolled to its edge - each of
          // the three panels should scroll independently based on where the cursor actually is.
          className="flex-1 min-w-0 overflow-auto overscroll-contain flex items-center justify-center p-6"
          style={{ touchAction: "pan-x pan-y" }}
        >
          {store.doc ? (
            <ImageEditorCanvas
              ref={canvasRef}
              doc={store.doc}
              baseImageSrc={store.baseImageSrc}
              adjustments={effectiveAdjustments}
              tool={tool}
              color={color}
              strokeWidth={activeWidth}
              fontSize={fontSize}
              textBold={textBold}
              textBackground={textBackground}
              textBackgroundColor={textBackgroundColor}
              shapeFilled={shapeFilled}
              arrowDashed={arrowDashed}
              arrowDoubleHeaded={arrowDoubleHeaded}
              blurMode={blurMode}
              blurRadius={blurRadius}
              zoom={zoom}
              selectedObjectIds={selectedIds}
              onSelectObjects={setSelectedIds}
              onAddObject={store.addObject}
              onTextCommitted={(id) => {
                setTool("select");
                setSelectedIds([id]);
              }}
              onEditObject={store.editObject}
              onBatchEditObjects={store.batchEditObjects}
              onDeleteObject={store.deleteObject}
            />
          ) : (
            <span className="text-neutral-400 dark:text-neutral-500 text-sm italic">Loading image…</span>
          )}
        </div>

        {isToolsPanelOpen && (
          <ImageEditorToolbar
            tool={tool}
            onToolChange={setTool}
            color={color}
            onColorChange={handleColorChange}
            showColor={showColor}
            strokeWidth={activeWidth}
            widthMin={isHighlightWidth ? HIGHLIGHT_MIN_WIDTH : PEN_MIN_WIDTH}
            widthMax={isHighlightWidth ? HIGHLIGHT_MAX_WIDTH : PEN_MAX_WIDTH}
            onStrokeWidthChange={handleStrokeWidthChange}
            showWidth={showWidth}
            fontSize={fontSize}
            onFontSizeChange={(size) => {
              setFontSize(size);
              if (primarySelectedObject?.type === "text") store.editObject(primarySelectedObject, { ...primarySelectedObject, fontSize: size });
            }}
            showFontSize={tool === "text" || primarySelectedObject?.type === "text"}
            textBold={textBold}
            onTextBoldChange={(bold) => {
              setTextBold(bold);
              if (primarySelectedObject?.type === "text") store.editObject(primarySelectedObject, { ...primarySelectedObject, bold });
            }}
            textBackground={textBackground}
            onTextBackgroundChange={(background) => {
              setTextBackground(background);
              if (primarySelectedObject?.type === "text") store.editObject(primarySelectedObject, { ...primarySelectedObject, background });
            }}
            textBackgroundColor={textBackgroundColor}
            onTextBackgroundColorChange={(next) => {
              setTextBackgroundColor(next);
              if (primarySelectedObject?.type === "text") store.editObject(primarySelectedObject, { ...primarySelectedObject, backgroundColor: next });
            }}
            shapeFilled={shapeFilled}
            onShapeFilledChange={(filled) => {
              setShapeFilled(filled);
              if (primarySelectedObject?.type === "rect" || primarySelectedObject?.type === "ellipse") {
                store.editObject(primarySelectedObject, { ...primarySelectedObject, filled });
              }
            }}
            showFill={showFill}
            arrowDashed={arrowDashed}
            onArrowDashedChange={(dashed) => {
              setArrowDashed(dashed);
              if (primarySelectedObject?.type === "arrow") store.editObject(primarySelectedObject, { ...primarySelectedObject, dashed });
            }}
            arrowDoubleHeaded={arrowDoubleHeaded}
            onArrowDoubleHeadedChange={(doubleHeaded) => {
              setArrowDoubleHeaded(doubleHeaded);
              if (primarySelectedObject?.type === "arrow") store.editObject(primarySelectedObject, { ...primarySelectedObject, doubleHeaded });
            }}
            showArrowStyle={showArrowStyle}
            blurMode={blurMode}
            onBlurModeChange={(mode) => {
              setBlurMode(mode);
              if (primarySelectedObject?.type === "blur") store.editObject(primarySelectedObject, { ...primarySelectedObject, mode });
            }}
            showBlurMode={showBlurMode}
            blurRadius={blurRadius}
            onBlurRadiusChange={(radius) => {
              setBlurRadius(radius);
              if (primarySelectedObject?.type === "blur") store.editObject(primarySelectedObject, { ...primarySelectedObject, blurRadius: radius });
            }}
            imageCornerRadius={imageCornerRadius}
            onImageCornerRadiusChange={(radius) => {
              setImageCornerRadius(radius);
              if (primarySelectedObject?.type === "placed-image") {
                store.editObject(primarySelectedObject, { ...primarySelectedObject, cornerRadius: radius });
              }
            }}
            imageBorderWidth={imageBorderWidth}
            onImageBorderWidthChange={(width) => {
              setImageBorderWidth(width);
              if (primarySelectedObject?.type === "placed-image") {
                store.editObject(primarySelectedObject, { ...primarySelectedObject, borderWidth: width });
              }
            }}
            imageBorderColor={imageBorderColor}
            onImageBorderColorChange={(next) => {
              setImageBorderColor(next);
              if (primarySelectedObject?.type === "placed-image") {
                store.editObject(primarySelectedObject, { ...primarySelectedObject, borderColor: next });
              }
            }}
            imageShadow={imageShadow}
            onImageShadowChange={(shadow) => {
              setImageShadow(shadow);
              if (primarySelectedObject?.type === "placed-image") store.editObject(primarySelectedObject, { ...primarySelectedObject, shadow });
            }}
            imageWidth={primarySelectedObject?.type === "placed-image" ? primarySelectedObject.width : 0}
            onImageWidthChange={handleImageWidthChange}
            imageHeight={primarySelectedObject?.type === "placed-image" ? primarySelectedObject.height : 0}
            onImageHeightChange={handleImageHeightChange}
            imageAspectLocked={imageAspectLocked}
            onImageAspectLockedChange={setImageAspectLocked}
            onCropImageClick={() => canvasRef.current?.beginImageCrop()}
            showImageStyle={showImageStyle}
            onRotateCCW={handleRotateCCW}
            onRotateCW={handleRotateCW}
            onFlipH={handleFlipH}
            onFlipV={handleFlipV}
            onCropApply={handleCropApply}
            onCropCancel={handleCropCancel}
            onInsertImageClick={handleInsertImageClick}
            adjustments={effectiveAdjustments}
            onAdjustmentsChange={setLiveAdjustments}
            onAdjustmentsCommit={(next) => {
              store.commitAdjustments(next);
              setLiveAdjustments(null);
            }}
            canUndo={store.canUndo}
            canRedo={store.canRedo}
            onUndo={store.undo}
            onRedo={store.redo}
            hasSelection={selectedObjects.length > 0}
            onDeleteSelected={handleDeleteSelected}
            onDuplicateSelected={handleDuplicateSelected}
            onBringToFront={handleBringToFront}
            onSendToBack={handleSendToBack}
            onBringForward={handleBringForward}
            onSendBackward={handleSendBackward}
            onClose={() => onToolsPanelOpenChange(false)}
          />
        )}
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileInputChange} className="hidden" />
    </div>
  );
};

export default ImageEditor;
