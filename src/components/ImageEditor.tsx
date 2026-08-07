// components/ImageEditor.tsx
//
// Top-level image-editing surface - the "image" category's counterpart to PdfAnnotator.tsx.
// Owns tool/color/zoom state, wires ImageEditorToolbar <-> ImageEditorCanvas <-> the image-edit
// store, and runs the two IO actions that aren't part of the store's own load/edit/autosave
// lifecycle: geometry ops (crop/rotate/flip, which read/write the working canvas directly - see
// ImageEditorCanvasHandle) and "Save a copy" (flattens to a real PNG file).
//
// The store itself and the current selection are *not* owned here - both are lifted to
// Dashboard.tsx (mirroring useVideoEditStore/selectedImageOverlayId's own lift for the video
// editor) so a future sibling panel could share the exact same document and selection instead of
// a second, out-of-sync copy.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { IoBuildOutline, IoDownloadOutline } from "react-icons/io5";
import { UseImageEditStoreResult } from "../hooks/useImageEditStore";
import { canvasToPngBytes } from "../handlers/pdfExportHandlers";
import { cropCanvas, makePlacedImageObject, rotateFlipCanvas } from "../handlers/imageEditHandlers";
import { ImageAdjustments, ImageEditTool, NEUTRAL_ADJUSTMENTS } from "../utils/imageEditTypes";
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
  selectedObjectId: string | null;
  onSelectObject: (id: string | null) => void;
}

const isEditableTarget = (el: Element | null): boolean => {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
};

const clampZoom = (z: number): number => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100));

const ImageEditor: React.FC<ImageEditorProps> = ({
  sourcePath,
  title,
  onSaved,
  store,
  isToolsPanelOpen,
  onToolsPanelOpenChange,
  selectedObjectId,
  onSelectObject,
}) => {
  const canvasRef = useRef<ImageEditorCanvasHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [tool, setTool] = useState<ImageEditTool>("select");
  const [color, setColor] = useState<string>("#e03131");
  const [strokeWidth, setStrokeWidth] = useState<number>(4);
  const [fontSize, setFontSize] = useState<number>(28);
  const [zoom, setZoom] = useState<number>(1);
  // Live-previewed while a brightness/contrast/saturation slider is being dragged; committed to
  // the store (one undo entry) only on release - see ImageEditorToolbar's onAdjustmentsCommit.
  const [liveAdjustments, setLiveAdjustments] = useState<ImageAdjustments | null>(null);
  const [isSavingCopy, setIsSavingCopy] = useState<boolean>(false);
  const [saveCopyError, setSaveCopyError] = useState<string | null>(null);
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

  // Reset per-image tool/adjustment UI state when a different image is opened (selection itself
  // is reset by Dashboard.tsx, which owns it) - a fresh doc always starts with nothing selected,
  // and a stale tool/live-adjustment from the previous image would otherwise dangle.
  useEffect(() => {
    setTool("select");
    setLiveAdjustments(null);
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

  // Drops a selection that no longer exists - geometry ops clear every object, and undo/redo can
  // land on a document where the currently-selected id was never re-added.
  useEffect(() => {
    if (selectedObjectId && !store.doc?.objects.some((o) => o.id === selectedObjectId)) onSelectObject(null);
  }, [store.doc, selectedObjectId, onSelectObject]);

  const selectedObject = selectedObjectId ? store.doc?.objects.find((o) => o.id === selectedObjectId) ?? null : null;
  const effectiveAdjustments = liveAdjustments ?? store.doc?.adjustments ?? NEUTRAL_ADJUSTMENTS;

  // Syncs the toolbar's color/width/font-size controls FROM whatever just got selected, so
  // clicking a shape shows *its* color rather than whatever was last picked for drawing a new
  // one - keyed on selectedObjectId (not selectedObject itself, which changes reference on every
  // unrelated doc edit) so this runs once per selection change, not on every keystroke/drag that
  // happens to the currently-selected object afterward.
  useEffect(() => {
    if (!selectedObject) return;
    if ("color" in selectedObject) setColor(selectedObject.color);
    if ("width" in selectedObject) setStrokeWidth(selectedObject.width);
    if (selectedObject.type === "text") setFontSize(selectedObject.fontSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedObjectId]);

  // Color/width apply to whichever color/width-bearing tool is armed (for the *next* thing
  // drawn) or, when one's selected, edit that object directly instead - same dual-purpose
  // pattern the pre-existing onFontSizeChange below already used for text.
  const COLOR_TOOLS: ImageEditTool[] = ["pen", "highlighter", "arrow", "rect", "ellipse", "text"];
  const WIDTH_TOOLS: ImageEditTool[] = ["pen", "highlighter", "arrow", "rect", "ellipse"];
  const showColor = COLOR_TOOLS.includes(tool) || (!!selectedObject && "color" in selectedObject);
  const showWidth = WIDTH_TOOLS.includes(tool) || (!!selectedObject && "width" in selectedObject);

  const handleColorChange = useCallback(
    (next: string) => {
      setColor(next);
      if (selectedObject && "color" in selectedObject) store.editObject(selectedObject, { ...selectedObject, color: next });
    },
    [selectedObject, store]
  );
  const handleStrokeWidthChange = useCallback(
    (next: number) => {
      setStrokeWidth(next);
      if (selectedObject && "width" in selectedObject) store.editObject(selectedObject, { ...selectedObject, width: next });
    },
    [selectedObject, store]
  );

  // Every geometry op (crop/rotate/flip) follows the same shape: snapshot the canvas exactly as
  // it's currently composed (the "before" undo state), run the pixel transform, then hand both
  // bitmaps to the store - see GeometrySnapshot's doc comment (imageEditTypes.ts) for why this
  // flattens rather than transforming each annotation object's coordinates.
  const applyGeometry = useCallback(
    (transform: (canvas: HTMLCanvasElement) => HTMLCanvasElement) => {
      const canvas = canvasRef.current?.getWorkingCanvas();
      if (!canvas) return;
      try {
        const beforeDataUrl = canvas.toDataURL("image/png");
        const afterCanvas = transform(canvas);
        const afterDataUrl = afterCanvas.toDataURL("image/png");
        store.commitGeometry(beforeDataUrl, afterDataUrl, afterCanvas.width, afterCanvas.height);
        onSelectObject(null);
        setGeometryError(null);
      } catch (err) {
        console.error("Failed to apply crop/rotate/flip:", err);
        setGeometryError(err instanceof Error ? err.message : String(err));
      }
    },
    [store, onSelectObject]
  );

  const handleRotateCCW = useCallback(() => applyGeometry((c) => rotateFlipCanvas(c, 3, false, false)), [applyGeometry]);
  const handleRotateCW = useCallback(() => applyGeometry((c) => rotateFlipCanvas(c, 1, false, false)), [applyGeometry]);
  const handleFlipH = useCallback(() => applyGeometry((c) => rotateFlipCanvas(c, 0, true, false)), [applyGeometry]);
  const handleFlipV = useCallback(() => applyGeometry((c) => rotateFlipCanvas(c, 0, false, true)), [applyGeometry]);

  const handleCropApply = useCallback(() => {
    const rect = canvasRef.current?.getCropRect();
    if (!rect || rect.w < 1 || rect.h < 1) {
      setTool("select");
      return;
    }
    applyGeometry((c) => cropCanvas(c, rect.x, rect.y, rect.w, rect.h));
    setTool("select");
  }, [applyGeometry]);

  const handleCropCancel = useCallback(() => setTool("select"), []);

  const handleDeleteSelected = useCallback(() => {
    if (selectedObject) {
      store.deleteObject(selectedObject);
      onSelectObject(null);
    }
  }, [selectedObject, store, onSelectObject]);

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

        const object = makePlacedImageObject(x, y, width, height, loaded.dataUrl);
        store.addObject(object);
        setTool("select");
        onSelectObject(object.id);
      } catch (err) {
        console.error("Failed to insert image:", err);
      }
    },
    [store, onSelectObject]
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
          onSelectObject(null);
        }
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedObject) {
        e.preventDefault();
        handleDeleteSelected();
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
        } else if (key === "=" || key === "+" || e.code === "Equal" || e.code === "NumpadAdd") {
          e.preventDefault();
          setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + 0.25) * 100) / 100));
        } else if (key === "-" || e.code === "Minus" || e.code === "NumpadSubtract") {
          e.preventDefault();
          setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - 0.25) * 100) / 100));
        } else if (key === "0") {
          e.preventDefault();
          setZoom(1);
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
        case "c":
          e.preventDefault();
          setTool("crop");
          break;
        case "[":
          e.preventDefault();
          setStrokeWidth((w) => Math.max(1, w - 1));
          break;
        case "]":
          e.preventDefault();
          setStrokeWidth((w) => Math.min(24, w + 1));
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [tool, selectedObject, store.canUndo, store.canRedo, store.undo, store.redo, handleCropCancel, handleDeleteSelected, onSelectObject]);

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
          className="flex-1 min-w-0 overflow-auto flex items-center justify-center p-6"
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
              strokeWidth={strokeWidth}
              fontSize={fontSize}
              zoom={zoom}
              selectedObjectId={selectedObjectId}
              onSelectObject={onSelectObject}
              onAddObject={store.addObject}
              onEditObject={store.editObject}
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
            strokeWidth={strokeWidth}
            onStrokeWidthChange={handleStrokeWidthChange}
            showWidth={showWidth}
            fontSize={fontSize}
            onFontSizeChange={(size) => {
              setFontSize(size);
              if (selectedObject?.type === "text") store.editObject(selectedObject, { ...selectedObject, fontSize: size });
            }}
            showFontSize={tool === "text" || selectedObject?.type === "text"}
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
            hasSelection={!!selectedObject}
            onDeleteSelected={handleDeleteSelected}
            onClose={() => onToolsPanelOpenChange(false)}
          />
        )}
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileInputChange} className="hidden" />
    </div>
  );
};

export default ImageEditor;
