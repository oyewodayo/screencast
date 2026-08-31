// components/board/BoardEditor.tsx
//
// Top-level Board editing surface - the "Board" feature's counterpart to ImageEditor.tsx. Owns
// the useBoardStore instance, image-decode cache, and selection state; wires the top toolbar,
// BoardCanvas, and BoardStylePanel together, and runs the two IO actions that aren't part of the
// store's own load/edit/autosave lifecycle: importing a newly-picked image file (copies it into
// this board's own assets/ folder, see import_board_image) and exporting a flattened PNG.
import { forwardRef, ReactNode, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/tauri";
import { open as openFileDialog } from "@tauri-apps/api/dialog";
import {
  IoAdd,
  IoAppsOutline,
  IoArrowBack,
  IoArrowRedo,
  IoArrowUndo,
  IoChevronDown,
  IoColorPaletteOutline,
  IoDownloadOutline,
  IoExpandOutline,
  IoGridOutline,
  IoImageOutline,
  IoLayersOutline,
  IoRadioButtonOnOutline,
  IoRemove,
  IoReorderThreeOutline,
} from "react-icons/io5";
import { TbCircleDashed } from "react-icons/tb";
import useBoardStore from "../../hooks/useBoardStore";
import { BoardBackgroundMode, BoardImage, createDefaultBoardImage } from "../../utils/boardTypes";
import { FILE_CATEGORY_EXTENSIONS } from "../../utils/fileCategory";
import { canvasToPngBytes } from "../../handlers/pdfExportHandlers";
import {
  applyMove,
  AutoLayoutResult,
  DEFAULT_BOARD_GRID,
  layoutImagesInCircle,
  layoutImagesInCircleWithCenter,
  layoutImagesInFan,
  layoutImagesInGrid,
  layoutImagesInRow,
  paddedCanvasSize,
  renderBoardToCanvas,
  resolveBackgroundMode,
  resolveBoardGrid,
  resolveBoardPadding,
} from "../../handlers/boardHandlers";
import { boardAssetPath, preloadBoardImage } from "../../utils/boardImageCache";
import BoardCanvas from "./BoardCanvas";
import BoardStylePanel from "./BoardStylePanel";

const THUMBNAIL_MAX_DIMENSION = 480;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

// The toolbar's "Arrange" preset menu - one entry per boardHandlers.ts auto-layout function. Order
// here is the order they appear in the dropdown.
type ArrangeStyle = "row" | "grid" | "circle" | "circleCenter" | "fan";
const ARRANGE_STYLES: { key: ArrangeStyle; label: string; description: string; icon: ReactNode }[] = [
  { key: "row", label: "Row", description: "Side by side, wrapping to fit", icon: <IoReorderThreeOutline size={16} /> },
  { key: "grid", label: "Grid", description: "Even squares, Instagram-style", icon: <IoAppsOutline size={16} /> },
  { key: "circle", label: "Circle", description: "Round photos, evenly spaced in a ring", icon: <TbCircleDashed size={16} /> },
  { key: "circleCenter", label: "Circle (center focus)", description: "One round photo featured in the middle", icon: <IoRadioButtonOnOutline size={16} /> },
  { key: "fan", label: "Fan", description: "Overlapping, like scattered photos", icon: <IoLayersOutline size={16} /> },
];

// The toolbar's "Background" mode picker - one entry per BoardBackgroundMode (boardTypes.ts).
// Order here is left-to-right order in the segmented control.
const BACKGROUND_MODE_META: Record<BoardBackgroundMode, { label: string; icon: ReactNode }> = {
  color: { label: "Color", icon: <IoColorPaletteOutline size={16} /> },
  grid: { label: "Grid", icon: <IoGridOutline size={16} /> },
  image: { label: "Image", icon: <IoImageOutline size={16} /> },
};

interface BoardEditorProps {
  boardId: string;
  onBack: () => void;
  // Whatever the sidebar file list is currently dragging (Dashboard.tsx's own draggingFiles state,
  // threaded straight through BoardWorkspace) - lets the canvas below accept a drop of already-
  // imported library images without a second, parallel drag-tracking mechanism. null outside a
  // sidebar drag gesture, same lifetime as the source state.
  libraryDraggingFiles?: { name: string; path: string }[] | null;
}

// Imperative escape hatch for Dashboard.tsx's OTHER entry points into "add these library files to
// the currently-open board" - the sidebar row's "Add to board" menu item and the bulk-selection
// action bar. Both live outside this component (in Dashboard.tsx/its sidebar), and neither has a
// drag gesture to piggyback on the way libraryDraggingFiles above does, so they need a way to reach
// in and reuse the same import pipeline rather than duplicating it up in Dashboard.tsx (which would
// also mean lifting useBoardStore's autosave/undo state out of BoardEditor entirely).
export interface BoardEditorHandle {
  addImagesFromPaths: (paths: string[]) => Promise<void>;
}

// WebView2 has no HEIC/HEIF decoder at all (same limitation Dashboard.tsx's own
// resolveImageDisplayUrl works around) - pre-decode through the backend's cached PNG preview first
// for any HEIC/HEIF source, both so a naturalSize/dimension read can actually decode it AND so
// what gets copied into this board's assets/ is a real PNG the canvas can render later, not a HEIC
// file convertFileSrc can't display either. A no-op passthrough for every other format. Shared by
// importAndPlaceImages (placed images) and handleChooseBackgroundImage (the board background) -
// both need the exact same treatment before handing a path to import_board_image.
async function resolveImportableImagePath(sourcePath: string): Promise<string> {
  const ext = sourcePath.split(".").pop()?.toLowerCase() ?? "";
  if (!["heic", "heif"].includes(ext)) return sourcePath;
  return invoke<string>("get_heic_preview", { inputPath: sourcePath });
}

const isEditableTarget = (el: Element | null): boolean => {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
};

// Arrow-key nudge direction per key - plain arrow = 1px, Shift+arrow = 10px, same convention
// design tools (Figma, etc.) use for pixel-precise moves too fine to reliably drag by hand.
const NUDGE_DIRECTIONS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
const NUDGE_STEP = 1;
const NUDGE_STEP_SHIFT = 10;

const BoardEditor = forwardRef<BoardEditorHandle, BoardEditorProps>(({ boardId, onBack, libraryDraggingFiles }, ref) => {
  const store = useBoardStore(boardId);
  const [briefcastDir, setBriefcastDir] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [imageBitmaps, setImageBitmaps] = useState<Map<string, HTMLImageElement>>(new Map());
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importWarning, setImportWarning] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isDragOverCanvas, setIsDragOverCanvas] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const didFitZoomRef = useRef(false);

  useEffect(() => {
    invoke<string>("get_briefcast_dir").then(setBriefcastDir).catch((err) => console.error("Failed to resolve Briefcast folder:", err));
  }, []);

  // Sets zoom so the given *unpadded* content size, plus `padding` on every side, fits the
  // visible container - shared by the initial fit-on-load below and by auto-layout
  // (applyAutoLayout/handleAddImages), which pass a freshly-computed height directly rather than
  // waiting a render for store.doc to catch up.
  const fitToSize = useCallback((canvasWidth: number, canvasHeight: number, padding: number) => {
    const el = containerRef.current;
    const totalWidth = canvasWidth + padding * 2;
    const totalHeight = canvasHeight + padding * 2;
    if (!el || totalWidth <= 0 || totalHeight <= 0) return;
    const { clientWidth, clientHeight } = el;
    if (clientWidth === 0 || clientHeight === 0) return;
    const fit = Math.min(1, (clientWidth - 48) / totalWidth, (clientHeight - 48) / totalHeight);
    setZoom(Math.max(MIN_ZOOM, Math.round(fit * 100) / 100));
  }, []);

  const handleFitToWindow = useCallback(() => {
    if (!store.doc) return;
    fitToSize(store.doc.canvasWidth, store.doc.canvasHeight, resolveBoardPadding(store.doc));
  }, [store.doc, fitToSize]);

  // Resets the one-shot fit-on-load guard whenever a different board is opened, then fits as soon
  // as that board's real canvas size is known - a freshly-opened tall board otherwise starts at
  // 100% zoom, mostly scrolled out of view. Same pattern ImageEditor.tsx uses for its own zoom.
  useEffect(() => {
    didFitZoomRef.current = false;
  }, [boardId]);

  useEffect(() => {
    if (didFitZoomRef.current || !store.doc) return;
    fitToSize(store.doc.canvasWidth, store.doc.canvasHeight, resolveBoardPadding(store.doc));
    didFitZoomRef.current = true;
  }, [store.doc, fitToSize]);

  // Decodes any placed image OR the background image (renderBoardToCanvas reads both out of this
  // same imageBitmaps map - see its own doc comment) whose asset isn't cached yet - runs whenever
  // the document's own image list or background image changes (new import, undo/redo landing on a
  // different set of images/background).
  useEffect(() => {
    if (!briefcastDir || !store.doc) return;
    let cancelled = false;
    const missingAssetFileNames = [
      ...store.doc.images.map((img) => img.assetFileName),
      ...(store.doc.backgroundImage ? [store.doc.backgroundImage] : []),
    ].filter((assetFileName) => !imageBitmaps.has(assetFileName));
    if (missingAssetFileNames.length === 0) return;

    Promise.all(
      missingAssetFileNames.map(async (assetFileName) => {
        const src = convertFileSrc(boardAssetPath(briefcastDir, boardId, assetFileName));
        const bitmap = await preloadBoardImage(src);
        return [assetFileName, bitmap] as const;
      })
    ).then((loaded) => {
      if (cancelled) return;
      setImageBitmaps((prev) => {
        const next = new Map(prev);
        for (const [key, bitmap] of loaded) next.set(key, bitmap);
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefcastDir, store.doc?.images, store.doc?.backgroundImage, boardId]);

  // Drops a selection whose image no longer exists (deleted, or undo/redo landed elsewhere).
  useEffect(() => {
    if (!store.doc) return;
    const stillPresent = new Set(store.doc.images.map((img) => img.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => stillPresent.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [store.doc]);

  // Shared by every entry point that adds images to this board: the file-dialog button below, a
  // sidebar drag-drop onto the canvas, and Dashboard.tsx's imperative addImagesFromPaths (the
  // sidebar row's "Add to board" menu item / bulk-selection action bar) - see BoardEditorHandle's
  // doc comment above for why those two need to reach in rather than duplicating this pipeline.
  //
  // Imports every file first (decode + copy into this board's assets/), *then* lays the whole
  // batch out together via layoutImagesInRow, starting below whatever's already on the board - a
  // tidy, non-overlapping row/wrap instead of each image landing at nearly the same diagonal-offset
  // spot and stacking on top of the last one, which is what naively placing each image as it's
  // imported used to do.
  //
  // Each file is imported independently (own try/catch) rather than one try wrapping the whole
  // loop: a library drag/selection is realistically a mixed batch (e.g. a Photos folder of HEIC
  // alongside a few PNGs someone already converted), and one undecodable file used to silently
  // abort the entire batch - including every file before it that had already decoded fine.
  const importAndPlaceImages = useCallback(async (paths: string[]): Promise<void> => {
    if (!store.doc || paths.length === 0) return;
    setIsImporting(true);
    setImportWarning(null);
    const failed: string[] = [];
    try {
      const newImages: BoardImage[] = [];
      for (const sourcePath of paths) {
        try {
          const importablePath = await resolveImportableImagePath(sourcePath);

          const id = crypto.randomUUID();
          const naturalSize = await new Promise<{ width: number; height: number }>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => reject(new Error("Failed to decode image"));
            img.src = convertFileSrc(importablePath);
          });

          const assetFileName = await invoke<string>("import_board_image", { boardId, sourcePath: importablePath, assetId: id });
          newImages.push(createDefaultBoardImage(id, assetFileName, naturalSize.width, naturalSize.height, 0, 0));
        } catch (err) {
          console.error(`Failed to add image to board: ${sourcePath}`, err);
          failed.push(sourcePath.split(/[\\/]/).pop() ?? sourcePath);
        }
      }
      if (newImages.length === 0 || !store.doc) return;

      const gap = resolveBoardPadding(store.doc);
      const startY = store.doc.images.length > 0 ? Math.max(...store.doc.images.map((img) => img.y + img.height)) + gap : gap;
      const result = layoutImagesInRow(newImages, store.doc.canvasWidth, gap, startY);
      for (const image of result.images) store.addImage(image);

      // Grow-only, never shrink: importing is additive, so a new (possibly narrower) batch should
      // never shrink a board whose existing content already needed more room - unlike "Arrange in
      // a row" below, which recomputes every image and can legitimately shrink-to-fit.
      const width = Math.max(store.doc.canvasWidth, Math.round(result.canvasWidth));
      const height = Math.max(store.doc.canvasHeight, Math.round(result.canvasHeight));
      if (width !== store.doc.canvasWidth || height !== store.doc.canvasHeight) store.setCanvasSize(width, height);
      fitToSize(width, height, gap);
      setSelectedIds(new Set(result.images.map((img) => img.id)));
    } finally {
      setIsImporting(false);
      if (failed.length > 0) {
        setImportWarning(`Couldn't add ${failed.length} image${failed.length === 1 ? "" : "s"}: ${failed.join(", ")}`);
      }
    }
  }, [store, boardId, fitToSize]);

  const handleAddImages = useCallback(async (): Promise<void> => {
    if (!store.doc) return;
    const selected = await openFileDialog({ multiple: true, filters: [{ name: "Image", extensions: FILE_CATEGORY_EXTENSIONS.image }] });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await importAndPlaceImages(paths);
  }, [store, importAndPlaceImages]);

  useImperativeHandle(ref, () => ({ addImagesFromPaths: importAndPlaceImages }), [importAndPlaceImages]);

  // Background-image picker (see BoardBackgroundMode's "image" mode) - a much smaller sibling of
  // importAndPlaceImages above: no layout/canvas-size math (a background isn't a placed image, it
  // doesn't participate in "Arrange"), and only ever one file. Still goes through
  // resolveImportableImagePath (HEIC) and the same import_board_image copy-into-assets/ command -
  // a background image lives in this board's own assets/ folder exactly like a placed one does, so
  // it keeps working even if the original source file is later moved or deleted.
  const [isImportingBackground, setIsImportingBackground] = useState(false);
  const handleChooseBackgroundImage = useCallback(async (): Promise<void> => {
    const selected = await openFileDialog({ multiple: false, filters: [{ name: "Image", extensions: FILE_CATEGORY_EXTENSIONS.image }] });
    if (!selected || Array.isArray(selected)) return;
    setIsImportingBackground(true);
    try {
      const importablePath = await resolveImportableImagePath(selected);
      const assetFileName = await invoke<string>("import_board_image", { boardId, sourcePath: importablePath, assetId: crypto.randomUUID() });
      store.setBackgroundImage(assetFileName);
    } catch (err) {
      console.error("Failed to set background image:", err);
      setImportWarning("Couldn't set that image as the background.");
    } finally {
      setIsImportingBackground(false);
    }
  }, [boardId, store]);

  // Drop target for a sidebar image drag (see libraryDraggingFiles prop doc comment) - accepts the
  // drop only while the dragged batch actually contains at least one image, so dropping e.g. a
  // dragged PDF here shows the browser's native "not droppable" cursor instead of silently doing
  // nothing.
  const draggedLibraryImagePaths = useMemo(
    () =>
      (libraryDraggingFiles ?? [])
        .filter((file) => FILE_CATEGORY_EXTENSIONS.image.includes(file.name.split(".").pop()?.toLowerCase() ?? ""))
        .map((file) => file.path),
    [libraryDraggingFiles]
  );

  const selectedImages = useMemo(() => (store.doc ? store.doc.images.filter((img) => selectedIds.has(img.id)) : []), [store.doc, selectedIds]);

  const handleStyleChange = useCallback(
    (before: BoardImage[], after: BoardImage[]) => {
      if (before.length === 1) store.editImage(before[0], after[0]);
      else store.batchEditImages(before, after);
    },
    [store]
  );

  const handleDeleteSelected = useCallback(
    (ids: Set<string>) => {
      if (!store.doc) return;
      for (const image of store.doc.images) {
        if (ids.has(image.id)) store.deleteImage(image);
      }
      setSelectedIds(new Set());
    },
    [store]
  );

  const handleBringToFront = useCallback(
    (ids: Set<string>) => {
      if (!store.doc) return;
      const rest = store.doc.images.filter((img) => !ids.has(img.id));
      const moved = store.doc.images.filter((img) => ids.has(img.id));
      store.reorderImages([...rest, ...moved]);
    },
    [store]
  );

  const handleSendToBack = useCallback(
    (ids: Set<string>) => {
      if (!store.doc) return;
      const rest = store.doc.images.filter((img) => !ids.has(img.id));
      const moved = store.doc.images.filter((img) => ids.has(img.id));
      store.reorderImages([...moved, ...rest]);
    },
    [store]
  );

  // Applies any of the "Arrange" auto-layouts below AND resizes the canvas (both dimensions - it
  // recomputes every image, so unlike handleAddImages's grow-only batch append, it's safe to
  // shrink-to-fit too, removing any dead space the previous canvas size left unused) to what that
  // arrangement actually needed (see boardHandlers.ts's AutoLayoutResult). Two separate undo-tracked
  // commands, so undoing an arrange takes two steps (positions, then size) rather than one, but
  // keeps setCanvasSize a single-purpose command reusable outside arranging too.
  const applyAutoLayout = useCallback(
    (result: AutoLayoutResult, before: BoardImage[]) => {
      if (!store.doc) return;
      const width = Math.max(200, Math.round(result.canvasWidth));
      const height = Math.max(200, Math.round(result.canvasHeight));
      store.batchEditImages(before, result.images);
      store.setCanvasSize(width, height);
      fitToSize(width, height, resolveBoardPadding(store.doc));
    },
    [store, fitToSize]
  );

  // Which preset the toolbar's "Arrange" menu last applied - remembered so the Padding row's
  // "Apply" button (see its own comment further down) can re-run the *same* preset with a freshly
  // edited gap, rather than always snapping back to "row" regardless of what's actually on the
  // board.
  const [arrangeStyle, setArrangeStyle] = useState<ArrangeStyle>("row");
  // Anchor rect (in viewport coordinates) for the trigger button, or null when the menu is closed -
  // doubles as both "is it open" and "where should it render". Portaled to document.body below
  // rather than rendered as a plain absolute child (see arrangeButtonRef's onClick) because the
  // toolbar's own backdrop-blur-sm establishes a stacking context: a menu confined inside it can
  // never paint above the canvas pane, which is a later sibling outside that stacking context and
  // therefore always paints on top regardless of this menu's own z-index - it doesn't matter how
  // high z-30 is if the whole stacking context it lives in is what's behind.
  const [arrangeMenuAnchor, setArrangeMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const isArrangeMenuOpen = arrangeMenuAnchor !== null;
  const arrangeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isArrangeMenuOpen) return;
    const close = () => setArrangeMenuAnchor(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [isArrangeMenuOpen]);

  // Same anchor/portal pattern as arrangeMenuAnchor above (see its own doc comment for why a plain
  // absolute child doesn't work under the toolbar's backdrop-blur-sm) for the "Background" mode
  // picker further down the toolbar.
  const [backgroundMenuAnchor, setBackgroundMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const isBackgroundMenuOpen = backgroundMenuAnchor !== null;
  const backgroundButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isBackgroundMenuOpen) return;
    const close = () => setBackgroundMenuAnchor(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [isBackgroundMenuOpen]);

  // Defensively defaulted the same way every other doc field with a "didn't exist on old boards"
  // story is (resolveBoardPadding, resolveBackgroundMode/resolveBoardGrid themselves) - read once
  // here rather than re-deriving inline at each of the panel's three per-mode branches below.
  const currentBackgroundMode: BoardBackgroundMode = store.doc ? resolveBackgroundMode(store.doc) : "color";
  const currentGrid = store.doc ? resolveBoardGrid(store.doc) : DEFAULT_BOARD_GRID;

  // "Circle (center focus)" needs to know which image is the hero - a single selected image is a
  // deliberate choice ("make THIS one the centerpiece"), so it wins whenever exactly one image is
  // selected; layoutImagesInCircleWithCenter itself falls back to the first image otherwise.
  const singleSelectedImageId = selectedIds.size === 1 ? [...selectedIds][0] : undefined;

  const handleArrange = useCallback(
    (style: ArrangeStyle) => {
      if (!store.doc || store.doc.images.length < 2) return;
      const gap = resolveBoardPadding(store.doc);
      const result =
        style === "row"
          ? layoutImagesInRow(store.doc.images, store.doc.canvasWidth, gap)
          : style === "grid"
          ? layoutImagesInGrid(store.doc.images, gap)
          : style === "circle"
          ? layoutImagesInCircle(store.doc.images, gap)
          : style === "circleCenter"
          ? layoutImagesInCircleWithCenter(store.doc.images, gap, singleSelectedImageId)
          : layoutImagesInFan(store.doc.images, gap);
      applyAutoLayout(result, store.doc.images);
      setArrangeStyle(style);
      setArrangeMenuAnchor(null);
    },
    [store, applyAutoLayout, singleSelectedImageId]
  );

  const renderOffscreen = useCallback(
    (maxDimension?: number): HTMLCanvasElement | null => {
      if (!store.doc) return null;
      const { width, height } = paddedCanvasSize(store.doc);
      const scale = maxDimension ? Math.min(1, maxDimension / Math.max(width, height)) : 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      renderBoardToCanvas(canvas, store.doc, imageBitmaps, scale);
      return canvas;
    },
    [store.doc, imageBitmaps]
  );

  const handleExport = useCallback(async () => {
    if (!store.doc) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const canvas = renderOffscreen();
      if (!canvas) return;
      const bytes = await canvasToPngBytes(canvas);
      await invoke<string>("export_board_png", { boardName: store.doc.name, bytes: Array.from(bytes) });
    } catch (err) {
      console.error("Failed to export board:", err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  }, [store.doc, renderOffscreen]);

  const handleBack = useCallback(async () => {
    store.flushSave();
    try {
      const thumb = renderOffscreen(THUMBNAIL_MAX_DIMENSION);
      if (thumb) {
        const bytes = await canvasToPngBytes(thumb);
        await invoke("save_board_thumbnail", { boardId, bytes: Array.from(bytes) });
      }
    } catch (err) {
      console.error("Failed to save board thumbnail:", err);
    }
    onBack();
  }, [store, renderOffscreen, boardId, onBack]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (isEditableTarget(document.activeElement)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0) {
        e.preventDefault();
        handleDeleteSelected(selectedIds);
        return;
      }
      if (e.key === "Escape") {
        setSelectedIds(new Set());
        return;
      }
      if (!e.ctrlKey && !e.metaKey && e.key in NUDGE_DIRECTIONS && selectedIds.size > 0 && store.doc) {
        e.preventDefault();
        const [dirX, dirY] = NUDGE_DIRECTIONS[e.key];
        const step = e.shiftKey ? NUDGE_STEP_SHIFT : NUDGE_STEP;
        const targets = store.doc.images.filter((img) => selectedIds.has(img.id));
        if (targets.length > 0) {
          const moved = targets.map((img) => applyMove(img, dirX * step, dirY * step));
          if (targets.length === 1) store.editImage(targets[0], moved[0]);
          else store.batchEditImages(targets, moved);
        }
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === "z" && !e.shiftKey && store.canUndo) {
          e.preventDefault();
          store.undo();
        } else if ((key === "y" || (key === "z" && e.shiftKey)) && store.canRedo) {
          e.preventDefault();
          store.redo();
        } else if (key === "a") {
          e.preventDefault();
          if (store.doc) setSelectedIds(new Set(store.doc.images.map((img) => img.id)));
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds, handleDeleteSelected, store]);

  const nameInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="w-full h-full flex flex-col bg-gradient-to-b from-neutral-100 to-neutral-200 dark:from-neutral-900 dark:to-neutral-950">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm">
        <button
          type="button"
          onClick={handleBack}
          title="Back to boards"
          className="p-2 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <IoArrowBack size={18} />
        </button>

        <input
          ref={nameInputRef}
          value={store.doc?.name ?? ""}
          onChange={(e) => store.renameBoard(e.target.value)}
          placeholder="Untitled board"
          className="min-w-0 flex-1 max-w-xs px-2 py-1 rounded-md text-sm font-medium bg-transparent border border-transparent hover:border-neutral-300 dark:hover:border-neutral-700 focus:border-blue-400 dark:focus:border-blue-500 outline-none text-neutral-800 dark:text-neutral-100"
        />

        <button
          type="button"
          onClick={() => void handleAddImages()}
          disabled={isImporting || !store.doc}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <IoAdd size={16} /> Add images
        </button>

        <div className="w-px h-6 bg-neutral-200 dark:bg-neutral-700 mx-1" />

        {/* "Arrange" preset menu - see ARRANGE_STYLES/handleArrange above. Portaled to document.body
            (see arrangeMenuAnchor's own doc comment for why a plain absolute child doesn't work
            here) and positioned from the trigger button's own rect, so it always renders on top
            regardless of the toolbar's stacking context. */}
        <button
          ref={arrangeButtonRef}
          type="button"
          title="Arrange images"
          onClick={(e) => {
            e.stopPropagation();
            if (isArrangeMenuOpen) {
              setArrangeMenuAnchor(null);
            } else {
              setBackgroundMenuAnchor(null);
              const rect = arrangeButtonRef.current?.getBoundingClientRect();
              if (rect) setArrangeMenuAnchor({ top: rect.bottom + 6, left: rect.left });
            }
          }}
          disabled={!store.doc || store.doc.images.length < 2}
          className={`flex items-center gap-1 p-2 rounded-md disabled:opacity-40 ${
            isArrangeMenuOpen
              ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
              : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          }`}
        >
          {ARRANGE_STYLES.find((s) => s.key === arrangeStyle)?.icon}
          <IoChevronDown size={12} className={`transition-transform ${isArrangeMenuOpen ? "rotate-180" : ""}`} />
        </button>
        {arrangeMenuAnchor &&
          createPortal(
            <div
              onPointerDown={(e) => e.stopPropagation()}
              style={{ position: "fixed", top: arrangeMenuAnchor.top, left: arrangeMenuAnchor.left }}
              className="w-56 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-md border border-gray-200/80 dark:border-neutral-700/80 shadow-xl ring-1 ring-black/5 overflow-hidden z-[9999] py-1"
            >
              {ARRANGE_STYLES.map((style) => (
                <button
                  key={style.key}
                  type="button"
                  onClick={() => handleArrange(style.key)}
                  className={`w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                    arrangeStyle === style.key
                      ? "bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300"
                      : "text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70"
                  }`}
                >
                  <span className="shrink-0 mt-0.5">{style.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{style.label}</span>
                    <span className="block text-xs text-neutral-400 dark:text-neutral-500">{style.description}</span>
                  </span>
                </button>
              ))}
            </div>,
            document.body
          )}
        {/* "Background" mode picker - Color (the original control, now one of three modes) / Grid
            (gridlines, optionally over a base fill) / Image (a full-bleed photo). Same portal
            pattern as "Arrange" above - see arrangeMenuAnchor's doc comment for why. */}
        <button
          ref={backgroundButtonRef}
          type="button"
          title="Board background"
          onClick={(e) => {
            e.stopPropagation();
            if (isBackgroundMenuOpen) {
              setBackgroundMenuAnchor(null);
            } else {
              setArrangeMenuAnchor(null);
              const rect = backgroundButtonRef.current?.getBoundingClientRect();
              if (rect) setBackgroundMenuAnchor({ top: rect.bottom + 6, left: rect.left });
            }
          }}
          disabled={!store.doc}
          className={`flex items-center gap-1 p-2 rounded-md disabled:opacity-40 ${
            isBackgroundMenuOpen
              ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
              : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          }`}
        >
          {BACKGROUND_MODE_META[currentBackgroundMode].icon}
          <IoChevronDown size={12} className={`transition-transform ${isBackgroundMenuOpen ? "rotate-180" : ""}`} />
        </button>
        {backgroundMenuAnchor &&
          store.doc &&
          createPortal(
            <div
              onPointerDown={(e) => e.stopPropagation()}
              style={{ position: "fixed", top: backgroundMenuAnchor.top, left: backgroundMenuAnchor.left }}
              className="w-72 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-md border border-gray-200/80 dark:border-neutral-700/80 shadow-xl ring-1 ring-black/5 z-[9999] p-3"
            >
              <div className="flex gap-1 p-1 rounded-lg bg-neutral-100 dark:bg-neutral-900 mb-3">
                {(Object.keys(BACKGROUND_MODE_META) as BoardBackgroundMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => store.setBackgroundMode(mode)}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      currentBackgroundMode === mode
                        ? "bg-white dark:bg-neutral-700 text-blue-600 dark:text-blue-400 shadow-sm"
                        : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                    }`}
                  >
                    {BACKGROUND_MODE_META[mode].icon}
                    {BACKGROUND_MODE_META[mode].label}
                  </button>
                ))}
              </div>

              {currentBackgroundMode === "color" && (
                <div className="flex items-center gap-2">
                  {/* A native color input can't represent "no color" - the button next to it
                      toggles backgroundColor between null (transparent, see BoardDocument's own
                      doc comment) and the swatch's last value, since HTML color inputs never fire
                      onChange with an empty value on their own. */}
                  <input
                    type="color"
                    value={store.doc.backgroundColor ?? "#f5f5f5"}
                    onChange={(e) => store.setBackgroundColor(e.target.value)}
                    className={`w-9 h-9 shrink-0 rounded border border-neutral-300 dark:border-neutral-600 bg-transparent cursor-pointer ${
                      store.doc.backgroundColor === null ? "opacity-30" : ""
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => store.setBackgroundColor(store.doc?.backgroundColor === null ? "#f5f5f5" : null)}
                    className="flex-1 px-2 py-1.5 rounded-md text-xs font-medium bg-neutral-100 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                  >
                    {store.doc.backgroundColor === null ? "Restore color" : "Make transparent"}
                  </button>
                </div>
              )}

              {currentBackgroundMode === "grid" && (
                <div className="flex flex-col gap-3">
                  <label className="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                    Line color
                    <input
                      type="color"
                      value={currentGrid.lineColor}
                      onChange={(e) => store.setBackgroundGrid({ ...currentGrid, lineColor: e.target.value })}
                      className="w-9 h-9 rounded border border-neutral-300 dark:border-neutral-600 bg-transparent cursor-pointer"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                    Spacing ({currentGrid.spacing}px)
                    <input
                      type="range"
                      min={10}
                      max={160}
                      value={currentGrid.spacing}
                      onChange={(e) => store.setBackgroundGrid({ ...currentGrid, spacing: Number(e.target.value) })}
                      className="w-32 accent-blue-500"
                    />
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={currentGrid.baseColor ?? "#ffffff"}
                      onChange={(e) => store.setBackgroundGrid({ ...currentGrid, baseColor: e.target.value })}
                      className={`w-9 h-9 shrink-0 rounded border border-neutral-300 dark:border-neutral-600 bg-transparent cursor-pointer ${
                        currentGrid.baseColor === null ? "opacity-30" : ""
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => store.setBackgroundGrid({ ...currentGrid, baseColor: currentGrid.baseColor === null ? "#ffffff" : null })}
                      className="flex-1 px-2 py-1.5 rounded-md text-xs font-medium bg-neutral-100 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                    >
                      {currentGrid.baseColor === null ? "Restore base color" : "Make base transparent"}
                    </button>
                  </div>
                </div>
              )}

              {currentBackgroundMode === "image" && (
                <div className="flex flex-col gap-2.5">
                  {store.doc.backgroundImage && briefcastDir && (
                    <img
                      src={convertFileSrc(boardAssetPath(briefcastDir, boardId, store.doc.backgroundImage))}
                      alt=""
                      className="w-full h-24 object-cover rounded-md border border-neutral-200 dark:border-neutral-700"
                    />
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleChooseBackgroundImage()}
                      disabled={isImportingBackground}
                      className="flex-1 px-2 py-1.5 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {isImportingBackground ? "Importing…" : store.doc.backgroundImage ? "Change image" : "Choose image"}
                    </button>
                    {store.doc.backgroundImage && (
                      <button
                        type="button"
                        onClick={() => store.setBackgroundImage(null)}
                        className="px-2 py-1.5 rounded-md text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>,
            document.body
          )}

        <div className="w-px h-6 bg-neutral-200 dark:bg-neutral-700 mx-1" />

        {/* Mat/frame border around the whole board - a pure rendering-time inset (see
            paddedCanvasSize), so this just updates live on every keystroke/spinner click, no
            "Apply" step needed. The button beside it is the deliberately separate, explicit
            action for the *other* thing padding governs - the gap between images, which can't be
            live the same way without either fighting free-drag positions or silently doing
            nothing until a rearrange happens (the exact bug the old gridline-width control had). */}
        <label className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400" title="Board padding">
          Padding
          <input
            type="number"
            min={0}
            max={400}
            value={store.doc?.padding ?? 0}
            onChange={(e) => store.setPadding(Number(e.target.value))}
            disabled={!store.doc}
            className="w-14 px-1.5 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 text-xs tabular-nums disabled:opacity-40"
          />
        </label>
        <button
          type="button"
          title={`Re-apply "${ARRANGE_STYLES.find((s) => s.key === arrangeStyle)?.label}" using the current padding value`}
          onClick={() => handleArrange(arrangeStyle)}
          disabled={!store.doc || store.doc.images.length < 2}
          className="px-2 py-1 rounded-md text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
        >
          Apply
        </button>

        <div className="w-px h-6 bg-neutral-200 dark:bg-neutral-700 mx-1" />

        <button
          type="button"
          title="Undo"
          onClick={store.undo}
          disabled={!store.canUndo}
          className="p-2 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
        >
          <IoArrowUndo size={18} />
        </button>
        <button
          type="button"
          title="Redo"
          onClick={store.redo}
          disabled={!store.canRedo}
          className="p-2 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
        >
          <IoArrowRedo size={18} />
        </button>

        <div className="w-px h-6 bg-neutral-200 dark:bg-neutral-700 mx-1" />

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title="Zoom out"
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - 0.1) * 100) / 100))}
            className="p-1.5 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <IoRemove size={16} />
          </button>
          <input
            type="number"
            min={Math.round(MIN_ZOOM * 100)}
            max={Math.round(MAX_ZOOM * 100)}
            value={Math.round(zoom * 100)}
            onChange={(e) => {
              // Number("") is 0, not NaN, but an in-progress "cleared the field to retype" state
              // shouldn't snap zoom to the minimum - only a genuinely non-numeric value falls back
              // (to the current zoom, a no-op) rather than clamping straight to MIN_ZOOM.
              const value = Number(e.target.value);
              if (!Number.isFinite(value)) return;
              setZoom(Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value / 100)) * 100) / 100);
            }}
            title="Zoom"
            className="w-12 px-1 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 text-xs tabular-nums text-center"
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">%</span>
          <button
            type="button"
            title="Zoom in"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + 0.1) * 100) / 100))}
            className="p-1.5 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <IoAdd size={16} />
          </button>
          <button
            type="button"
            title="Fit to window"
            onClick={handleFitToWindow}
            disabled={!store.doc}
            className="p-1.5 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
          >
            <IoExpandOutline size={16} />
          </button>
        </div>

        <div className="flex-1" />

        {store.isSaving && <span className="text-xs text-neutral-400 dark:text-neutral-500">Saving…</span>}

        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={isExporting || !store.doc || store.doc.images.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90 disabled:opacity-50"
        >
          <IoDownloadOutline size={16} /> {isExporting ? "Exporting…" : "Export image"}
        </button>
      </div>

      {exportError && (
        <div className="shrink-0 mx-auto mt-1 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-xs">
          Failed to export: {exportError}
        </div>
      )}

      {importWarning && (
        <div className="shrink-0 mx-auto mt-1 px-3 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs">
          {importWarning}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div
          ref={containerRef}
          className={`relative flex-1 min-w-0 overflow-auto flex items-center justify-center p-6 transition-colors ${
            isDragOverCanvas && draggedLibraryImagePaths.length > 0 ? "bg-blue-50/60 dark:bg-blue-500/10" : ""
          }`}
          // Sidebar-image-drop target - see libraryDraggingFiles/draggedLibraryImagePaths above.
          // Only reacts (preventDefault, which is what actually allows a drop to fire at all) when
          // the batch being dragged has at least one image in it, so dragging a non-image file
          // here shows the browser's own "not droppable" cursor rather than a highlight that lies.
          onDragOver={(e) => {
            if (draggedLibraryImagePaths.length === 0) return;
            // No explicit dropEffect here - the sidebar's own onDragStart (shared with the
            // folder-to-folder move drag) sets effectAllowed to "move", and forcing "copy" here
            // (semantically closer to what actually happens - the source file stays put) against
            // a "move"-only effectAllowed risks the browser showing a "not allowed" cursor even
            // though the drop still works fine either way; the highlight below already tells the
            // user this is a valid target.
            e.preventDefault();
            if (!isDragOverCanvas) setIsDragOverCanvas(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setIsDragOverCanvas(false);
          }}
          onDrop={(e) => {
            if (draggedLibraryImagePaths.length === 0) return;
            e.preventDefault();
            setIsDragOverCanvas(false);
            void importAndPlaceImages(draggedLibraryImagePaths);
          }}
        >
          {isDragOverCanvas && draggedLibraryImagePaths.length > 0 && (
            <div className="absolute inset-3 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-blue-400 dark:border-blue-500 bg-white/70 dark:bg-neutral-900/70 pointer-events-none">
              <span className="text-sm font-medium text-blue-600 dark:text-blue-400">
                Drop to add {draggedLibraryImagePaths.length} image{draggedLibraryImagePaths.length === 1 ? "" : "s"} to board
              </span>
            </div>
          )}
          {store.doc ? (
            <BoardCanvas
              doc={store.doc}
              zoom={zoom}
              imageBitmaps={imageBitmaps}
              selectedIds={selectedIds}
              onSelect={setSelectedIds}
              onEditImage={store.editImage}
              onBatchEditImages={store.batchEditImages}
            />
          ) : store.loadError ? (
            <span className="text-red-500 dark:text-red-400 text-sm">Failed to load board: {store.loadError}</span>
          ) : (
            <span className="text-neutral-400 dark:text-neutral-500 text-sm italic">Loading board…</span>
          )}
        </div>

        {selectedImages.length > 0 && (
          <BoardStylePanel
            images={selectedImages}
            onChange={handleStyleChange}
            onDelete={handleDeleteSelected}
            onBringToFront={handleBringToFront}
            onSendToBack={handleSendToBack}
          />
        )}
      </div>
    </div>
  );
});

BoardEditor.displayName = "BoardEditor";

export default BoardEditor;
