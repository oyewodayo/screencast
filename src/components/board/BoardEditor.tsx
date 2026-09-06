// components/board/BoardEditor.tsx
//
// Top-level Board editing surface - the "Board" feature's counterpart to ImageEditor.tsx. Owns
// the useBoardStore instance, image-decode cache, and selection state; wires the top toolbar,
// BoardCanvas, and BoardStylePanel together, and runs the two IO actions that aren't part of the
// store's own load/edit/autosave lifecycle: importing a newly-picked image file (copies it into
// this board's own assets/ folder, see import_board_image) and exporting a flattened PNG.
import { forwardRef, ReactNode, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
// Self-hosted @font-face rules for BoardText's "Modern" font group - see this file's own doc
// comment for why bundled rather than relying on the host OS. A plain side-effect import: nothing
// here references its exports, it just needs to be loaded once wherever the Board feature mounts.
import "./boardFonts.css";
import {
  IoAdd,
  IoAppsOutline,
  IoText,
  IoArrowBack,
  IoArrowRedo,
  IoArrowUndo,
  IoCheckmarkCircle,
  IoChevronDown,
  IoCloudDownloadOutline,
  IoColorFilterOutline,
  IoColorPaletteOutline,
  IoCopyOutline,
  IoEllipseOutline,
  IoExpandOutline,
  IoGridOutline,
  IoHeartOutline,
  IoImageOutline,
  IoLayersOutline,
  IoRadioButtonOnOutline,
  IoRemove,
  IoReorderThreeOutline,
  IoSaveOutline,
  IoShapesOutline,
  IoShareOutline,
  IoSquareOutline,
} from "react-icons/io5";
import {
  TbArrowBigRight,
  TbArrowUpRight,
  TbAspectRatio,
  TbBlur,
  TbCircleDashed,
  TbColumns,
  TbHexagon,
  TbLayoutAlignBottom,
  TbLayoutAlignCenter,
  TbLayoutAlignLeft,
  TbLayoutAlignMiddle,
  TbLayoutAlignRight,
  TbLayoutAlignTop,
  TbLayoutDistributeHorizontal,
  TbLayoutDistributeVertical,
  TbLine,
  TbOctagon,
  TbPentagon,
  TbSpiral,
  TbStairsUp,
  TbStar,
  TbTriangle,
} from "react-icons/tb";
import useBoardStore from "../../hooks/useBoardStore";
import {
  BoardBackgroundMode,
  BoardBlur,
  BoardImage,
  BoardItem,
  BoardShape,
  BoardText,
  createDefaultBoardBlur,
  createDefaultBoardImage,
  createDefaultBoardShape,
  createDefaultBoardText,
} from "../../utils/boardTypes";
import { FILE_CATEGORY_EXTENSIONS } from "../../utils/fileCategory";
import { canvasToPngBytes } from "../../handlers/pdfExportHandlers";
import {
  applyMove,
  AutoLayoutResult,
  DEFAULT_BOARD_GRADIENT,
  DEFAULT_BOARD_GRID,
  groupBoundingBox,
  layoutImagesInCascade,
  layoutImagesInCircle,
  layoutImagesInCircleWithCenter,
  layoutImagesInFan,
  layoutImagesInGrid,
  layoutImagesInHeart,
  layoutImagesInMasonry,
  layoutImagesInRow,
  layoutImagesInSpiral,
  paddedCanvasSize,
  renderBoardToCanvas,
  resolveBackgroundMode,
  resolveBoardGradient,
  resolveBoardGrid,
  resolveBoardPadding,
} from "../../handlers/boardHandlers";
import { boardAssetPath, preloadBoardImage } from "../../utils/boardImageCache";
import { BOARD_SIZE_PRESET_GROUPS, BOARD_SIZE_PRESETS } from "../../utils/boardCanvasSizes";
import BoardCanvas from "./BoardCanvas";
import BoardLayerPanel from "./BoardLayerPanel";
import BoardStylePanel from "./BoardStylePanel";

const THUMBNAIL_MAX_DIMENSION = 480;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

// The toolbar's "Shape" menu - one entry per named quick-add. Several share the same underlying
// shapeType ("polygon" for Triangle/Pentagon/Hexagon/Octagon, just at a different `sides` - see
// BoardShape's own doc comment in boardTypes.ts for why that's one parameterized shapeType rather
// than four separate ones) rather than each being its own distinct type; createDefaultBoardShape's
// `overrides` param is what lets this one preset list drive all of them through a single factory.
// Grouped into sections (Basic/Polygons/Stars/Lines) purely for the dropdown's own layout below.
interface ShapeAddPreset {
  id: string;
  label: string;
  icon: ReactNode;
  shapeType: BoardShape["shapeType"];
  sides?: number;
  points?: number;
  group: "Basic" | "Polygons" | "Stars" | "Lines";
}
const SHAPE_ADD_PRESETS: ShapeAddPreset[] = [
  { id: "rectangle", label: "Rectangle", icon: <IoSquareOutline size={16} />, shapeType: "rectangle", group: "Basic" },
  { id: "ellipse", label: "Ellipse", icon: <IoEllipseOutline size={16} />, shapeType: "ellipse", group: "Basic" },
  { id: "triangle", label: "Triangle", icon: <TbTriangle size={16} />, shapeType: "polygon", sides: 3, group: "Basic" },
  { id: "pentagon", label: "Pentagon", icon: <TbPentagon size={16} />, shapeType: "polygon", sides: 5, group: "Polygons" },
  { id: "hexagon", label: "Hexagon", icon: <TbHexagon size={16} />, shapeType: "polygon", sides: 6, group: "Polygons" },
  { id: "octagon", label: "Octagon", icon: <TbOctagon size={16} />, shapeType: "polygon", sides: 8, group: "Polygons" },
  { id: "star", label: "Star", icon: <TbStar size={16} />, shapeType: "star", points: 5, group: "Stars" },
  { id: "starburst", label: "Starburst", icon: <TbStar size={16} />, shapeType: "star", points: 8, group: "Stars" },
  { id: "line", label: "Line", icon: <TbLine size={16} />, shapeType: "line", group: "Lines" },
  { id: "arrow", label: "Arrow", icon: <TbArrowUpRight size={16} />, shapeType: "arrow", group: "Lines" },
  { id: "block-arrow", label: "Block arrow", icon: <TbArrowBigRight size={16} />, shapeType: "block-arrow", group: "Lines" },
];
const SHAPE_ADD_GROUPS: ShapeAddPreset["group"][] = ["Basic", "Polygons", "Stars", "Lines"];

// The toolbar's "Align" menu - edge/center alignment (needs 2+ selected items) plus even
// distribution (needs 3+, since "distribute" is meaningless for a pair). Both act on each
// selected item's own rotated bounding box (groupBoundingBox([item]), the same helper the group
// resize/rotate gizmo in BoardCanvas.tsx uses) rather than raw x/y, so a rotated item aligns by
// what's actually visible on screen, not its unrotated origin.
type AlignEdge = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
const ALIGN_ACTIONS: { key: AlignEdge; label: string; icon: ReactNode }[] = [
  { key: "left", label: "Align left", icon: <TbLayoutAlignLeft size={16} /> },
  { key: "hcenter", label: "Align center", icon: <TbLayoutAlignCenter size={16} /> },
  { key: "right", label: "Align right", icon: <TbLayoutAlignRight size={16} /> },
  { key: "top", label: "Align top", icon: <TbLayoutAlignTop size={16} /> },
  { key: "vcenter", label: "Align middle", icon: <TbLayoutAlignMiddle size={16} /> },
  { key: "bottom", label: "Align bottom", icon: <TbLayoutAlignBottom size={16} /> },
];
type DistributeAxis = "horizontal" | "vertical";
const DISTRIBUTE_ACTIONS: { key: DistributeAxis; label: string; icon: ReactNode }[] = [
  { key: "horizontal", label: "Distribute horizontally", icon: <TbLayoutDistributeHorizontal size={16} /> },
  { key: "vertical", label: "Distribute vertically", icon: <TbLayoutDistributeVertical size={16} /> },
];

// The toolbar's "Arrange" preset menu - one entry per boardHandlers.ts auto-layout function. Order
// here is the order they appear in the dropdown.
type ArrangeStyle = "row" | "grid" | "masonry" | "circle" | "circleCenter" | "spiral" | "heart" | "fan" | "cascade";
const ARRANGE_STYLES: { key: ArrangeStyle; label: string; description: string; icon: ReactNode }[] = [
  { key: "row", label: "Row", description: "Side by side, wrapping to fit", icon: <IoReorderThreeOutline size={16} /> },
  { key: "grid", label: "Grid", description: "Even squares, Instagram-style", icon: <IoAppsOutline size={16} /> },
  { key: "masonry", label: "Masonry", description: "Pinterest-style columns, natural photo shapes kept", icon: <TbColumns size={16} /> },
  { key: "circle", label: "Circle", description: "Round photos, evenly spaced in a ring", icon: <TbCircleDashed size={16} /> },
  { key: "circleCenter", label: "Circle (center focus)", description: "One round photo featured in the middle", icon: <IoRadioButtonOnOutline size={16} /> },
  { key: "spiral", label: "Spiral", description: "A sunflower-seed spiral winding to the center", icon: <TbSpiral size={16} /> },
  { key: "heart", label: "Heart", description: "Round photos arranged into a heart", icon: <IoHeartOutline size={16} /> },
  { key: "fan", label: "Fan", description: "Overlapping, like scattered photos", icon: <IoLayersOutline size={16} /> },
  { key: "cascade", label: "Cascade", description: "A tidy stepped stack along a diagonal", icon: <TbStairsUp size={16} /> },
];

// The toolbar's "Background" mode picker - one entry per BoardBackgroundMode (boardTypes.ts).
// Order here is left-to-right order in the segmented control.
const BACKGROUND_MODE_META: Record<BoardBackgroundMode, { label: string; icon: ReactNode }> = {
  color: { label: "Color", icon: <IoColorPaletteOutline size={16} /> },
  grid: { label: "Grid", icon: <IoGridOutline size={16} /> },
  gradient: { label: "Gradient", icon: <IoColorFilterOutline size={16} /> },
  image: { label: "Image", icon: <IoImageOutline size={16} /> },
};

// Shared toolbar button tokens - three tiers, each reserved for one visual role so the toolbar
// reads as a considered system rather than every button improvising its own treatment:
//  - TOOLBAR_ICON_BTN: a plain icon-only action (Back). Ghost by default, no border - it never
//    needs to announce itself the way a control with a menu behind it does.
//  - TOOLBAR_CHIP / TOOLBAR_CHIP_ACTIVE: a labeled control that opens something (a dropdown, a
//    menu) - a real bordered chip, not a hover-only ghost button, so its "there's more here" role
//    is visible before the pointer ever reaches it. ACTIVE is the open/pressed state.
// Undo/Redo and Zoom intentionally do NOT use these - they're rendered as bordered segmented
// controls instead (see their own comments below), the standard convention for a tightly coupled
// pair/group rather than a menu trigger.
// shrink-0 + whitespace-nowrap on all three: this row has grown past what a narrow window fits
// (see the container's own overflow-x-auto below), and a plain flex child shrinks by default -
// without these, the row didn't wrap or scroll, it silently squeezed each chip's own box down
// until its label text wrapped internally instead ("Add images" broke into two lines). shrink-0
// forces every chip to keep its natural width and let the CONTAINER scroll instead.
const TOOLBAR_ICON_BTN =
  "shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors disabled:opacity-40 disabled:pointer-events-none";
const TOOLBAR_CHIP =
  "shrink-0 flex items-center gap-1.5 h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 text-sm font-medium whitespace-nowrap hover:border-neutral-300 dark:hover:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-40 disabled:pointer-events-none";
const TOOLBAR_CHIP_ACTIVE =
  "shrink-0 flex items-center gap-1.5 h-9 px-3 rounded-lg border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 text-sm font-medium whitespace-nowrap transition-colors";

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
  // Toggled by the toolbar's "Layers" chip - see BoardLayerPanel.tsx. Off by default so it doesn't
  // eat into canvas space for boards nobody needs a layer list for.
  const [showLayerPanel, setShowLayerPanel] = useState(false);
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
      ...store.doc.images.filter((item): item is BoardImage => item.kind === "image").map((img) => img.assetFileName),
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

  // Swaps one placed image's underlying photo without touching anything else about it - position,
  // size, rotation, and every style field (padding/border/corner radius/frame color/opacity) all
  // stay exactly as they were, so a carefully arranged tile keeps its spot in the layout instead of
  // needing to be deleted, re-added, and re-arranged just to fix a wrong photo. Same HEIC-aware
  // import_board_image pipeline as everything else that brings a file onto this board - the old
  // asset file is simply left behind in assets/ (same as a deleted image's asset today; this board
  // feature has never cleaned those up on delete either, so replace isn't introducing a new gap).
  const [isReplacingImage, setIsReplacingImage] = useState(false);
  const handleReplaceImage = useCallback(
    async (target: BoardImage): Promise<void> => {
      const selected = await openFileDialog({ multiple: false, filters: [{ name: "Image", extensions: FILE_CATEGORY_EXTENSIONS.image }] });
      if (!selected || Array.isArray(selected)) return;
      setIsReplacingImage(true);
      try {
        const importablePath = await resolveImportableImagePath(selected);
        const naturalSize = await new Promise<{ width: number; height: number }>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error("Failed to decode image"));
          img.src = convertFileSrc(importablePath);
        });
        const assetFileName = await invoke<string>("import_board_image", { boardId, sourcePath: importablePath, assetId: crypto.randomUUID() });
        store.editImage(target, { ...target, assetFileName, naturalWidth: naturalSize.width, naturalHeight: naturalSize.height, updatedAt: Date.now() });
      } catch (err) {
        console.error("Failed to replace image:", err);
        setImportWarning("Couldn't replace that image.");
      } finally {
        setIsReplacingImage(false);
      }
    },
    [boardId, store]
  );

  // Drops a new text box centered on the board's current canvas (not the viewport - the canvas can
  // be scrolled/zoomed, but its own center is always a well-defined, board-relative spot) and
  // immediately selects it, so BoardStylePanel's text section (the one place its content gets
  // edited - see BoardText's own doc comment) is right there ready to type into. No layout/import
  // step needed the way images have (importAndPlaceImages) - a text item has no source file, so
  // it's just one addImage call.
  const handleAddText = useCallback((): void => {
    if (!store.doc) return;
    const id = crypto.randomUUID();
    const x = store.doc.canvasWidth / 2 - 130;
    const y = store.doc.canvasHeight / 2 - 45;
    const text = createDefaultBoardText(id, x, y);
    store.addImage(text);
    setSelectedIds(new Set([id]));
  }, [store]);

  // Same "drop centered, select immediately" pattern as handleAddText above - a blur region has no
  // source file either, so this is just one addImage call. Sized/shaped so it drops in ready to
  // drag straight onto whatever needs covering (see createDefaultBoardBlur's own defaults).
  const handleAddBlur = useCallback((): void => {
    if (!store.doc) return;
    const id = crypto.randomUUID();
    const x = store.doc.canvasWidth / 2 - 90;
    const y = store.doc.canvasHeight / 2 - 90;
    const blur = createDefaultBoardBlur(id, x, y);
    store.addImage(blur);
    setSelectedIds(new Set([id]));
  }, [store]);

  // Same "drop centered, select immediately" pattern as handleAddText/handleAddBlur above - see
  // createDefaultBoardShape's per-shapeType defaults (boardTypes.ts) for each preset's starting
  // size, and SHAPE_ADD_PRESETS' own doc comment for why several presets share one shapeType.
  const handleAddShape = useCallback(
    (preset: ShapeAddPreset): void => {
      if (!store.doc) return;
      const id = crypto.randomUUID();
      const shape = createDefaultBoardShape(id, preset.shapeType, 0, 0, { sides: preset.sides, points: preset.points });
      const x = store.doc.canvasWidth / 2 - shape.width / 2;
      const y = store.doc.canvasHeight / 2 - shape.height / 2;
      store.addImage({ ...shape, x, y });
      setSelectedIds(new Set([id]));
    },
    [store]
  );

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
    (before: BoardItem[], after: BoardItem[]) => {
      if (before.length === 1) store.editImage(before[0], after[0]);
      else store.batchEditImages(before, after);
    },
    [store]
  );

  // Copies one image's "look" - everything BoardStylePanel's image section edits EXCEPT geometry
  // (x/y/width/height/rotation stay each target's own) and identity (id/assetFileName/kind/natural
  // size) - onto every OTHER image on the board, regardless of whether those others are currently
  // selected. This is the "apply this image's style to all" the sidebar review flagged: today,
  // giving a whole board a matching border/frame/corner-radius meant repeating the same slider
  // drags per image by hand.
  const handleApplyImageStyleToAll = useCallback(
    (source: BoardImage) => {
      if (!store.doc) return;
      const targets = store.doc.images.filter((item): item is BoardImage => item.kind === "image" && item.id !== source.id);
      if (targets.length === 0) return;
      const styled = targets.map((img) => ({
        ...img,
        padding: source.padding,
        borderWidth: source.borderWidth,
        borderColor: source.borderColor,
        cornerRadius: source.cornerRadius,
        backgroundColor: source.backgroundColor,
        opacity: source.opacity,
        shadow: source.shadow,
        updatedAt: Date.now(),
      }));
      store.batchEditImages(targets, styled);
    },
    [store]
  );

  // Text counterpart to handleApplyImageStyleToAll above - same reasoning, same exclusions
  // (geometry/identity/content stay per-item; only the look copies across).
  const handleApplyTextStyleToAll = useCallback(
    (source: BoardText) => {
      if (!store.doc) return;
      const targets = store.doc.images.filter((item): item is BoardText => item.kind === "text" && item.id !== source.id);
      if (targets.length === 0) return;
      const styled = targets.map((t) => ({
        ...t,
        fontFamily: source.fontFamily,
        fontSize: source.fontSize,
        fontWeight: source.fontWeight,
        fontStyle: source.fontStyle,
        textAlign: source.textAlign,
        color: source.color,
        backgroundColor: source.backgroundColor,
        cornerRadius: source.cornerRadius,
        padding: source.padding,
        opacity: source.opacity,
        updatedAt: Date.now(),
      }));
      store.batchEditImages(targets, styled);
    },
    [store]
  );

  // Blur counterpart to handleApplyImageStyleToAll/handleApplyTextStyleToAll above - same
  // reasoning: geometry (position/size/rotation) stays per-item, only shape/corner radius/strength/
  // opacity copy across.
  const handleApplyBlurStyleToAll = useCallback(
    (source: BoardBlur) => {
      if (!store.doc) return;
      const targets = store.doc.images.filter((item): item is BoardBlur => item.kind === "blur" && item.id !== source.id);
      if (targets.length === 0) return;
      const styled = targets.map((b) => ({
        ...b,
        shape: source.shape,
        mode: source.mode,
        cornerRadius: source.cornerRadius,
        strength: source.strength,
        opacity: source.opacity,
        updatedAt: Date.now(),
      }));
      store.batchEditImages(targets, styled);
    },
    [store]
  );

  // Shape counterpart to the three above - fill/stroke/corner radius/opacity copy across; shapeType
  // itself stays put (turning every rectangle on the board into an arrow because one of them
  // changed its own type would be a bigger, unrequested change than "apply this one's style").
  const handleApplyShapeStyleToAll = useCallback(
    (source: BoardShape) => {
      if (!store.doc) return;
      const targets = store.doc.images.filter((item): item is BoardShape => item.kind === "shape" && item.id !== source.id);
      if (targets.length === 0) return;
      const styled = targets.map((s) => ({
        ...s,
        fillColor: source.fillColor,
        strokeColor: source.strokeColor,
        strokeWidth: source.strokeWidth,
        cornerRadius: source.cornerRadius,
        opacity: source.opacity,
        updatedAt: Date.now(),
      }));
      store.batchEditImages(targets, styled);
    },
    [store]
  );

  const handleDeleteSelected = useCallback(
    (ids: Set<string>) => {
      if (!store.doc) return;
      const targets = store.doc.images.filter((item) => ids.has(item.id));
      // One deleteItems call, not one deleteImage per item - the latter (this function's own
      // previous implementation) created one undo step per deleted item, so undoing a 5-item
      // delete took 5 separate Ctrl+Z presses instead of one.
      store.deleteItems(targets);
      setSelectedIds(new Set());
    },
    [store]
  );

  // Copies every selected item, offset slightly down-right so the duplicates are visibly distinct
  // from their originals rather than sitting exactly on top of them, and selects the copies (not
  // the originals) so the very next drag moves the new ones - the same "duplicate lands ready to
  // reposition" convention Figma/Canva/etc. use. One addItems call for one undo step regardless of
  // how many items were selected. Images/blurs reuse the SAME assetFileName as their original
  // rather than copying the underlying file on disk - nothing about rendering or deletion requires
  // per-BoardImage-uniqueness (imageBitmaps is keyed by assetFileName, and deleting one duplicate
  // was already never wired to delete the shared asset file either), so a physical copy would only
  // add disk I/O for no behavioral benefit.
  const DUPLICATE_OFFSET = 24;
  const handleDuplicateSelected = useCallback(
    (ids: Set<string>) => {
      if (!store.doc || ids.size === 0) return;
      const originals = store.doc.images.filter((item) => ids.has(item.id));
      if (originals.length === 0) return;
      const now = Date.now();
      const copies = originals.map((item) => ({
        ...item,
        id: crypto.randomUUID(),
        x: item.x + DUPLICATE_OFFSET,
        y: item.y + DUPLICATE_OFFSET,
        // Never inherit lock - a duplicate is meant to land ready to reposition (see this
        // function's own doc comment above), which a locked copy would immediately defeat.
        locked: false,
        createdAt: now,
        updatedAt: now,
      }));
      store.addItems(copies);
      setSelectedIds(new Set(copies.map((c) => c.id)));
    },
    [store]
  );

  // Moves every selected item by (dx, dy) * step - shared by the keyboard arrow-key handler below
  // AND BoardStylePanel's own directional-pad control, so the two are guaranteed to always agree on
  // what a "nudge" actually does rather than two independent implementations drifting apart. `dx`/
  // `dy` are unit direction (-1/0/1), `step` is the actual pixel distance - callers pass
  // NUDGE_STEP/NUDGE_STEP_SHIFT for keyboard's plain/Shift convention, and the D-pad's own buttons
  // mirror that exact convention (click vs. Shift-click) rather than inventing a different one.
  const handleNudge = useCallback(
    (dx: number, dy: number, step: number) => {
      if (!store.doc || selectedIds.size === 0) return;
      const targets = store.doc.images.filter((img) => selectedIds.has(img.id));
      if (targets.length === 0) return;
      const moved = targets.map((img) => applyMove(img, dx * step, dy * step));
      if (targets.length === 1) store.editImage(targets[0], moved[0]);
      else store.batchEditImages(targets, moved);
    },
    [store, selectedIds]
  );

  // Aligns every selected item to a shared edge/center line, computed from the group's own
  // rotated bounding boxes (min/max of each item's groupBoundingBox, not raw x/y) so the result
  // matches what's visually flush on screen even when items are rotated. One batch-edit, one undo
  // step, regardless of how many items are selected.
  const handleAlignSelected = useCallback(
    (edge: AlignEdge) => {
      if (!store.doc || selectedIds.size < 2) return;
      const targets = store.doc.images.filter((img) => selectedIds.has(img.id));
      if (targets.length < 2) return;
      const boxed = targets.map((item) => ({ item, box: groupBoundingBox([item]) }));
      let reference: number;
      if (edge === "left") reference = Math.min(...boxed.map((b) => b.box.x));
      else if (edge === "right") reference = Math.max(...boxed.map((b) => b.box.x + b.box.width));
      else if (edge === "hcenter") {
        const minX = Math.min(...boxed.map((b) => b.box.x));
        const maxX = Math.max(...boxed.map((b) => b.box.x + b.box.width));
        reference = (minX + maxX) / 2;
      } else if (edge === "top") reference = Math.min(...boxed.map((b) => b.box.y));
      else if (edge === "bottom") reference = Math.max(...boxed.map((b) => b.box.y + b.box.height));
      else {
        const minY = Math.min(...boxed.map((b) => b.box.y));
        const maxY = Math.max(...boxed.map((b) => b.box.y + b.box.height));
        reference = (minY + maxY) / 2;
      }
      const moved = boxed.map(({ item, box }) => {
        let dx = 0;
        let dy = 0;
        if (edge === "left") dx = reference - box.x;
        else if (edge === "right") dx = reference - (box.x + box.width);
        else if (edge === "hcenter") dx = reference - (box.x + box.width / 2);
        else if (edge === "top") dy = reference - box.y;
        else if (edge === "bottom") dy = reference - (box.y + box.height);
        else dy = reference - (box.y + box.height / 2);
        return applyMove(item, dx, dy);
      });
      store.batchEditImages(targets, moved);
    },
    [store, selectedIds]
  );

  // Spreads 3+ selected items with equal gaps between them along one axis, keeping the two
  // outermost items fixed in place (the natural "distribute" convention - only what's between the
  // ends moves). Sorted by current position along that axis first, so the visual left-to-right (or
  // top-to-bottom) order is preserved rather than shuffled.
  const handleDistributeSelected = useCallback(
    (axis: DistributeAxis) => {
      if (!store.doc || selectedIds.size < 3) return;
      const targets = store.doc.images.filter((img) => selectedIds.has(img.id));
      if (targets.length < 3) return;
      const boxed = targets.map((item) => ({ item, box: groupBoundingBox([item]) }));
      const sizeKey = axis === "horizontal" ? "width" : "height";
      const posKey = axis === "horizontal" ? "x" : "y";
      boxed.sort((a, b) => a.box[posKey] - b.box[posKey]);
      const first = boxed[0].box;
      const last = boxed[boxed.length - 1].box;
      const span = last[posKey] + last[sizeKey] - first[posKey];
      const totalSize = boxed.reduce((sum, b) => sum + b.box[sizeKey], 0);
      const gap = (span - totalSize) / (boxed.length - 1);
      let cursor = first[posKey];
      const orderedTargets: BoardItem[] = [];
      const moved: BoardItem[] = [];
      for (const { item, box } of boxed) {
        const delta = cursor - box[posKey];
        moved.push(applyMove(item, axis === "horizontal" ? delta : 0, axis === "horizontal" ? 0 : delta));
        orderedTargets.push(item);
        cursor += box[sizeKey] + gap;
      }
      store.batchEditImages(orderedTargets, moved);
    },
    [store, selectedIds]
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

  // "Move one step" counterpart to handleBringToFront/handleSendToBack above - swaps the item with
  // whichever single neighbor currently sits one step toward the front (higher index - drawn later,
  // on top) or back (lower index). Used only by BoardLayerPanel's per-row chevrons; the panel itself
  // disables a button once its item is already at that end of the stack, so the bounds check here is
  // just a defensive no-op rather than something a user can normally trigger.
  const handleStepReorder = useCallback(
    (id: string, direction: "forward" | "backward") => {
      if (!store.doc) return;
      const images = store.doc.images;
      const index = images.findIndex((img) => img.id === id);
      if (index === -1) return;
      const swapWith = direction === "forward" ? index + 1 : index - 1;
      if (swapWith < 0 || swapWith >= images.length) return;
      const next = [...images];
      [next[index], next[swapWith]] = [next[swapWith], next[index]];
      store.reorderImages(next);
    },
    [store]
  );

  // Toggles BoardItemBase.locked - see its own doc comment in boardTypes.ts. A plain single-item
  // edit (not undo-tracked as anything special), so locking/unlocking is itself undoable like any
  // other edit.
  const handleToggleLock = useCallback(
    (id: string) => {
      if (!store.doc) return;
      const before = store.doc.images.find((img) => img.id === id);
      if (!before) return;
      store.editImage(before, { ...before, locked: !before.locked, updatedAt: Date.now() });
    },
    [store]
  );

  // Free (not just one-step) reorder, driven by BoardLayerPanel's drag-and-drop rows - moves
  // draggedId out of the array and re-inserts it at targetId's current position, shifting whatever
  // was between them by one. One reorderImages call, one undo step, regardless of how far the drag
  // moved the item.
  const handleReorderLayer = useCallback(
    (draggedId: string, targetId: string) => {
      if (!store.doc || draggedId === targetId) return;
      const images = store.doc.images;
      const from = images.findIndex((img) => img.id === draggedId);
      const to = images.findIndex((img) => img.id === targetId);
      if (from === -1 || to === -1) return;
      const next = [...images];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      store.reorderImages(next);
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

  // Manual/preset canvas resize (the toolbar's "Size" menu) - unlike applyAutoLayout above, this
  // never touches item positions, only the canvas dimensions themselves: a settable size is meant
  // to define the *frame* the user is composing into (e.g. "I need this to end up 1080x1920 for an
  // Instagram Story"), not to reflow whatever's already been placed. Re-fits the view afterward
  // since a preset can flip the aspect ratio entirely (a 1600x1000 board going to a 1080x1920 story
  // would otherwise stay at whatever zoom the old, much wider canvas happened to be at).
  const handleApplyCanvasSize = useCallback(
    (width: number, height: number) => {
      if (!store.doc) return;
      const w = Math.max(200, Math.round(width));
      const h = Math.max(200, Math.round(height));
      store.setCanvasSize(w, h);
      fitToSize(w, h, resolveBoardPadding(store.doc));
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

  // Same anchor/portal pattern again for the toolbar's "Shape" menu (Rectangle/Ellipse/Line/Arrow) -
  // see arrangeMenuAnchor's own doc comment for why a portal over a plain absolute child.
  const [shapeMenuAnchor, setShapeMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const isShapeMenuOpen = shapeMenuAnchor !== null;
  const shapeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isShapeMenuOpen) return;
    const close = () => setShapeMenuAnchor(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [isShapeMenuOpen]);

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

  // Same anchor/portal pattern again for the toolbar's "Share" menu (Copy to clipboard / Save to
  // library / Save As...) - see arrangeMenuAnchor's own doc comment for why a portal over a plain
  // absolute child.
  const [shareMenuAnchor, setShareMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const isShareMenuOpen = shareMenuAnchor !== null;
  const shareButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isShareMenuOpen) return;
    const close = () => setShareMenuAnchor(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [isShareMenuOpen]);

  // Same anchor/portal pattern again for the toolbar's "Align" menu (align edges/centers,
  // distribute) - see arrangeMenuAnchor's own doc comment for why a portal over a plain absolute
  // child.
  const [alignMenuAnchor, setAlignMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const isAlignMenuOpen = alignMenuAnchor !== null;
  const alignButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isAlignMenuOpen) return;
    const close = () => setAlignMenuAnchor(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [isAlignMenuOpen]);

  // Same anchor/portal pattern again for the toolbar's "Size" menu (canvas-size presets + a manual
  // width/height field) - see arrangeMenuAnchor's own doc comment for why a portal over a plain
  // absolute child. `sizeDraft` is the menu's own local width/height text state for the manual
  // fields, reseeded from the board's actual current size every time the menu opens (see its
  // onClick below) rather than staying live-bound to store.doc, so mid-typing an edit isn't
  // clobbered by whatever the canvas size happens to be at that instant.
  const [sizeMenuAnchor, setSizeMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const isSizeMenuOpen = sizeMenuAnchor !== null;
  const sizeButtonRef = useRef<HTMLButtonElement>(null);
  const [sizeDraft, setSizeDraft] = useState<{ width: string; height: string }>({ width: "", height: "" });

  useEffect(() => {
    if (!isSizeMenuOpen) return;
    const close = () => setSizeMenuAnchor(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [isSizeMenuOpen]);

  // Defensively defaulted the same way every other doc field with a "didn't exist on old boards"
  // story is (resolveBoardPadding, resolveBackgroundMode/resolveBoardGrid themselves) - read once
  // here rather than re-deriving inline at each of the panel's three per-mode branches below.
  const currentBackgroundMode: BoardBackgroundMode = store.doc ? resolveBackgroundMode(store.doc) : "color";
  const currentGrid = store.doc ? resolveBoardGrid(store.doc) : DEFAULT_BOARD_GRID;
  const currentGradient = store.doc ? resolveBoardGradient(store.doc) : DEFAULT_BOARD_GRADIENT;
  // "Arrange"/"Apply" are only ever meaningful across 2+ images - see handleArrange's own comment
  // for why text items don't count here.
  const arrangeableImageCount = store.doc ? store.doc.images.filter((item) => item.kind === "image").length : 0;

  // "Circle (center focus)" needs to know which image is the hero - a single selected image is a
  // deliberate choice ("make THIS one the centerpiece"), so it wins whenever exactly one image is
  // selected; layoutImagesInCircleWithCenter itself falls back to the first image otherwise.
  const singleSelectedImageId = selectedIds.size === 1 ? [...selectedIds][0] : undefined;

  const handleArrange = useCallback(
    (style: ArrangeStyle) => {
      if (!store.doc) return;
      // Text items sit outside every auto-layout (see layoutImagesIn*'s own BoardImage[] param
      // types) - forcing a text box into a uniform image-sized cell would badly distort its
      // readable dimensions, so "Arrange" only ever touches images, leaving any text exactly
      // where it was.
      const imageItems = store.doc.images.filter((item): item is BoardImage => item.kind === "image");
      if (imageItems.length < 2) return;
      const gap = resolveBoardPadding(store.doc);
      const result = ((): AutoLayoutResult => {
        switch (style) {
          case "row":
            return layoutImagesInRow(imageItems, store.doc!.canvasWidth, gap);
          case "grid":
            return layoutImagesInGrid(imageItems, gap);
          case "masonry":
            return layoutImagesInMasonry(imageItems, gap);
          case "circle":
            return layoutImagesInCircle(imageItems, gap);
          case "circleCenter":
            return layoutImagesInCircleWithCenter(imageItems, gap, singleSelectedImageId);
          case "spiral":
            return layoutImagesInSpiral(imageItems, gap);
          case "heart":
            return layoutImagesInHeart(imageItems, gap);
          case "fan":
            return layoutImagesInFan(imageItems, gap);
          case "cascade":
            return layoutImagesInCascade(imageItems, gap);
        }
      })();
      applyAutoLayout(result, imageItems);
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

  // "Save to library" - one of the three actions behind the toolbar's "Share" menu (see
  // shareMenuAnchor below). Always lands in briefcast_dir()/Board/, so it shows up in the sidebar's
  // Image tab immediately - the fast, no-decisions option for "I just want this in my library."
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

  // "Save As..." - the other download option behind "Share": lets the user pick the exact
  // destination (Desktop, Downloads, anywhere) via the OS's own native save dialog, rather than
  // always landing in the library's Board folder the way handleExport above does. Goes through the
  // same import_board_image-style write-then-rename on the Rust side (export_board_png_to_path) but
  // to a caller-chosen path instead of one this app derives itself.
  const handleSaveAs = useCallback(async () => {
    if (!store.doc) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const canvas = renderOffscreen();
      if (!canvas) return;
      const bytes = await canvasToPngBytes(canvas);
      const safeName = store.doc.name.trim().replace(/[^a-zA-Z0-9 _-]/g, "_") || "Board";
      const destPath = await saveFileDialog({ defaultPath: `${safeName}.png`, filters: [{ name: "PNG Image", extensions: ["png"] }] });
      if (!destPath) return;
      await invoke("export_board_png_to_path", { destPath, bytes: Array.from(bytes) });
    } catch (err) {
      console.error("Failed to save board:", err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  }, [store.doc, renderOffscreen]);

  // Same flattened-PNG render as handleExport above, just handed to the OS clipboard instead of
  // written into the library - the fast path for "show someone this board right now" (paste into
  // a chat, a doc, anywhere) without a save-then-attach round trip. Pure browser API
  // (navigator.clipboard.write + ClipboardItem, same mechanism ImageEditor.tsx's own
  // handleCopyToClipboard and ImageFolderGallery.tsx's handleCopyImage already use elsewhere in
  // this app) - no Rust command involved, since Board already has the PNG bytes in memory and
  // never needs to touch disk for this.
  const [isCopyingToClipboard, setIsCopyingToClipboard] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copyStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyStatusTimerRef.current) clearTimeout(copyStatusTimerRef.current);
    },
    []
  );

  const handleCopyToClipboard = useCallback(async () => {
    if (!store.doc) return;
    setIsCopyingToClipboard(true);
    setExportError(null);
    try {
      const canvas = renderOffscreen();
      if (!canvas) return;
      const bytes = await canvasToPngBytes(canvas);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
      setCopyStatus("Copied to clipboard");
      if (copyStatusTimerRef.current) clearTimeout(copyStatusTimerRef.current);
      copyStatusTimerRef.current = setTimeout(() => setCopyStatus(null), 1800);
    } catch (err) {
      console.error("Failed to copy board to clipboard:", err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCopyingToClipboard(false);
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
        handleNudge(dirX, dirY, e.shiftKey ? NUDGE_STEP_SHIFT : NUDGE_STEP);
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
          // Locked items excluded - Ctrl+A is exactly the "accidentally sweep something up" case
          // locking exists to prevent (see BoardItemBase.locked's own doc comment); they're still
          // reachable individually through BoardLayerPanel.
          if (store.doc) setSelectedIds(new Set(store.doc.images.filter((img) => !img.locked).map((img) => img.id)));
        } else if (key === "d" && selectedIds.size > 0) {
          // preventDefault here is load-bearing, not just tidy - Ctrl+D is the browser's own
          // "bookmark this page" shortcut, which would otherwise fire alongside the duplicate.
          e.preventDefault();
          handleDuplicateSelected(selectedIds);
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds, handleDeleteSelected, handleDuplicateSelected, handleNudge, store]);

  const nameInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="w-full h-full flex flex-col bg-gradient-to-b from-neutral-100 to-neutral-200 dark:from-neutral-900 dark:to-neutral-950">
      {/* overflow-x-auto is the real fix for a chip running out of room (see TOOLBAR_CHIP's own
          comment) - once every chip refuses to shrink, something has to give when the window is
          narrow, and a horizontal scroll on the bar itself beats any chip silently wrapping its
          own label. shrink-0 on the back button/divider too, for the same reason. */}
      <div className="shrink-0 flex items-center gap-1.5 px-4 py-2.5 border-b border-neutral-200/80 dark:border-neutral-800/80 bg-white/95 dark:bg-neutral-900/95 backdrop-blur-xl overflow-x-auto">
        <button type="button" onClick={handleBack} title="Back to boards" className={TOOLBAR_ICON_BTN}>
          <IoArrowBack size={17} />
        </button>

        <input
          ref={nameInputRef}
          value={store.doc?.name ?? ""}
          onChange={(e) => store.renameBoard(e.target.value)}
          placeholder="Untitled board"
          className="min-w-[80px] shrink w-[180px] px-2.5 py-1.5 rounded-lg text-sm font-semibold bg-transparent border border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-800 focus:bg-white dark:focus:bg-neutral-900 focus:border-blue-400 dark:focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 outline-none text-neutral-900 dark:text-neutral-100 transition-colors"
        />

        <div className="shrink-0 w-px h-6 bg-neutral-200/80 dark:bg-neutral-800 mx-1" />

        <button
          type="button"
          onClick={() => void handleAddImages()}
          disabled={isImporting || !store.doc}
          className="shrink-0 flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm font-semibold tracking-tight text-white bg-gradient-to-b from-blue-500 to-blue-600 shadow-[0_1px_2px_rgba(37,99,235,0.35),0_0_0_1px_rgba(37,99,235,0.15)] hover:from-blue-600 hover:to-blue-700 hover:shadow-[0_2px_6px_rgba(37,99,235,0.4)] active:shadow-none transition-all disabled:opacity-50 disabled:shadow-none whitespace-nowrap"
        >
          <IoAdd size={16} /> Add images
        </button>

        <button type="button" title="Add text" onClick={handleAddText} disabled={!store.doc} className={TOOLBAR_CHIP}>
          <IoText size={15} /> Text
        </button>

        <button type="button" title="Add a blur region - drag it over anything you want to obscure" onClick={handleAddBlur} disabled={!store.doc} className={TOOLBAR_CHIP}>
          <TbBlur size={15} /> Blur
        </button>

        {/* "Shape" - each preset in SHAPE_ADD_PRESETS is just createDefaultBoardShape dropped
            centered on the canvas (same "center and select" pattern as Text/Blur above) - see
            BoardShape's own doc comment in boardTypes.ts for why Line/Arrow (and several of these
            presets sharing one "polygon"/"star" shapeType) reuse the exact same rotatable box every
            other kind does. Same portal-dropdown pattern as Arrange/Align above, grouped the same
            way Align's own menu groups Align vs. Distribute. */}
        <button
          ref={shapeButtonRef}
          type="button"
          title="Add a shape"
          onClick={(e) => {
            e.stopPropagation();
            if (isShapeMenuOpen) {
              setShapeMenuAnchor(null);
            } else {
              setArrangeMenuAnchor(null);
              setBackgroundMenuAnchor(null);
              setShareMenuAnchor(null);
              setAlignMenuAnchor(null);
              setSizeMenuAnchor(null);
              const rect = shapeButtonRef.current?.getBoundingClientRect();
              if (rect) setShapeMenuAnchor({ top: rect.bottom + 6, left: rect.left });
            }
          }}
          disabled={!store.doc}
          className={isShapeMenuOpen ? TOOLBAR_CHIP_ACTIVE : TOOLBAR_CHIP}
        >
          <IoShapesOutline size={15} /> Shape
          <IoChevronDown size={12} className={`transition-transform ${isShapeMenuOpen ? "rotate-180" : ""}`} />
        </button>
        {shapeMenuAnchor &&
          createPortal(
            <div
              onPointerDown={(e) => e.stopPropagation()}
              style={{ position: "fixed", top: shapeMenuAnchor.top, left: shapeMenuAnchor.left }}
              className="w-56 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-md border border-gray-200/80 dark:border-neutral-700/80 shadow-xl ring-1 ring-black/5 overflow-hidden z-[9999] py-1 max-h-[70vh] overflow-y-auto"
            >
              {SHAPE_ADD_GROUPS.map((group) => (
                <div key={group}>
                  <div className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">{group}</div>
                  <div className="grid grid-cols-4 gap-0.5 px-1.5 pb-1.5">
                    {SHAPE_ADD_PRESETS.filter((preset) => preset.group === group).map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        title={preset.label}
                        onClick={() => {
                          handleAddShape(preset);
                          setShapeMenuAnchor(null);
                        }}
                        className="flex flex-col items-center gap-1 py-2 rounded-lg text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                      >
                        {preset.icon}
                        <span className="text-[10px] leading-none truncate max-w-full px-0.5">{preset.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>,
            document.body
          )}

        <button
          type="button"
          title="Show every item on the board in stacking order, front to back"
          onClick={() => setShowLayerPanel((v) => !v)}
          disabled={!store.doc}
          className={showLayerPanel ? TOOLBAR_CHIP_ACTIVE : TOOLBAR_CHIP}
        >
          <IoLayersOutline size={15} /> Layers
        </button>

        <div className="shrink-0 w-px h-6 bg-neutral-200/80 dark:bg-neutral-800 mx-1" />

        {/* "Arrange" and "Background" - each a self-contained bordered "chip" trigger (not a
            shared grey pill) that opens its own portaled dropdown (see arrangeMenuAnchor's own doc
            comment for why a plain absolute child doesn't work under this toolbar's
            backdrop-blur-xl). Labeled rather than icon-only, so what each one does is legible
            without a hover to find out. */}
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
              setShareMenuAnchor(null);
              setAlignMenuAnchor(null);
              setSizeMenuAnchor(null);
              setShapeMenuAnchor(null);
              const rect = arrangeButtonRef.current?.getBoundingClientRect();
              if (rect) setArrangeMenuAnchor({ top: rect.bottom + 6, left: rect.left });
            }
          }}
          disabled={!store.doc || arrangeableImageCount < 2}
          className={isArrangeMenuOpen ? TOOLBAR_CHIP_ACTIVE : TOOLBAR_CHIP}
        >
          {ARRANGE_STYLES.find((s) => s.key === arrangeStyle)?.icon}
          Arrange
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
        {/* "Align" - edge/center alignment and even distribution across the current selection.
            Only meaningful for 2+ selected items (distribute needs 3+, disabled per-row below
            rather than hiding the whole menu, so it's discoverable before there's enough selected
            to use it). Same portal-dropdown pattern as Arrange/Background above. */}
        <button
          ref={alignButtonRef}
          type="button"
          title="Align or distribute the selected items"
          onClick={(e) => {
            e.stopPropagation();
            if (isAlignMenuOpen) {
              setAlignMenuAnchor(null);
            } else {
              setArrangeMenuAnchor(null);
              setBackgroundMenuAnchor(null);
              setShareMenuAnchor(null);
              setSizeMenuAnchor(null);
              setShapeMenuAnchor(null);
              const rect = alignButtonRef.current?.getBoundingClientRect();
              if (rect) setAlignMenuAnchor({ top: rect.bottom + 6, left: rect.left });
            }
          }}
          disabled={!store.doc || selectedIds.size < 2}
          className={isAlignMenuOpen ? TOOLBAR_CHIP_ACTIVE : TOOLBAR_CHIP}
        >
          <TbLayoutAlignLeft size={15} />
          Align
          <IoChevronDown size={12} className={`transition-transform ${isAlignMenuOpen ? "rotate-180" : ""}`} />
        </button>
        {alignMenuAnchor &&
          createPortal(
            <div
              onPointerDown={(e) => e.stopPropagation()}
              style={{ position: "fixed", top: alignMenuAnchor.top, left: alignMenuAnchor.left }}
              className="w-52 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-md border border-gray-200/80 dark:border-neutral-700/80 shadow-xl ring-1 ring-black/5 overflow-hidden z-[9999] py-1"
            >
              <div className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                Align
              </div>
              {ALIGN_ACTIONS.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => {
                    handleAlignSelected(action.key);
                    setAlignMenuAnchor(null);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                >
                  {action.icon}
                  {action.label}
                </button>
              ))}
              <div className="h-px bg-neutral-200/80 dark:bg-neutral-700/80 my-1" />
              <div className="px-3 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                Distribute
              </div>
              {DISTRIBUTE_ACTIONS.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  disabled={selectedIds.size < 3}
                  onClick={() => {
                    handleDistributeSelected(action.key);
                    setAlignMenuAnchor(null);
                  }}
                  title={selectedIds.size < 3 ? "Select at least 3 items to distribute" : undefined}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                >
                  {action.icon}
                  {action.label}
                </button>
              ))}
            </div>,
            document.body
          )}
        {/* "Background" mode picker - Color (the original control, now one of three modes) / Grid
            (gridlines, optionally over a base fill) / Image (a full-bleed photo). Same portal
            pattern and chip styling as "Arrange" above - see arrangeMenuAnchor's doc comment for
            why the portal, and TOOLBAR_CHIP's own comment for why a bordered chip over a shared
            grey pill. */}
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
              setShareMenuAnchor(null);
              setAlignMenuAnchor(null);
              setSizeMenuAnchor(null);
              setShapeMenuAnchor(null);
              const rect = backgroundButtonRef.current?.getBoundingClientRect();
              if (rect) setBackgroundMenuAnchor({ top: rect.bottom + 6, left: rect.left });
            }
          }}
          disabled={!store.doc}
          className={isBackgroundMenuOpen ? TOOLBAR_CHIP_ACTIVE : TOOLBAR_CHIP}
        >
          {BACKGROUND_MODE_META[currentBackgroundMode].icon}
          Background
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

              {currentBackgroundMode === "gradient" && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <label className="flex-1 flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                      From
                      <input
                        type="color"
                        value={currentGradient.from}
                        onChange={(e) => store.setBackgroundGradient({ ...currentGradient, from: e.target.value })}
                        className="w-9 h-9 rounded border border-neutral-300 dark:border-neutral-600 bg-transparent cursor-pointer"
                      />
                    </label>
                    <label className="flex-1 flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                      To
                      <input
                        type="color"
                        value={currentGradient.to}
                        onChange={(e) => store.setBackgroundGradient({ ...currentGradient, to: e.target.value })}
                        className="w-9 h-9 rounded border border-neutral-300 dark:border-neutral-600 bg-transparent cursor-pointer"
                      />
                    </label>
                  </div>
                  <label className="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                    Angle ({currentGradient.angleDeg}°)
                    <input
                      type="range"
                      min={0}
                      max={359}
                      value={currentGradient.angleDeg}
                      onChange={(e) => store.setBackgroundGradient({ ...currentGradient, angleDeg: Number(e.target.value) })}
                      className="w-32 accent-blue-500"
                    />
                  </label>
                  <div
                    className="h-10 rounded-md border border-neutral-200 dark:border-neutral-700"
                    style={{ background: `linear-gradient(${currentGradient.angleDeg}deg, ${currentGradient.from}, ${currentGradient.to})` }}
                  />
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
        {/* "Size" - the canvas's own pixel dimensions (not padding, not zoom): named social-platform
            presets (see boardCanvasSizes.ts) plus a manual width/height field for anything else.
            Never touches item positions, only canvasWidth/Height - see handleApplyCanvasSize's own
            comment for why. Same portal-dropdown pattern as Arrange/Align/Background above. */}
        <button
          ref={sizeButtonRef}
          type="button"
          title="Canvas size - social-media presets or a custom width/height"
          onClick={(e) => {
            e.stopPropagation();
            if (isSizeMenuOpen) {
              setSizeMenuAnchor(null);
            } else {
              setArrangeMenuAnchor(null);
              setBackgroundMenuAnchor(null);
              setShareMenuAnchor(null);
              setAlignMenuAnchor(null);
              setShapeMenuAnchor(null);
              setSizeDraft({ width: String(store.doc?.canvasWidth ?? ""), height: String(store.doc?.canvasHeight ?? "") });
              const rect = sizeButtonRef.current?.getBoundingClientRect();
              if (rect) setSizeMenuAnchor({ top: rect.bottom + 6, left: rect.left });
            }
          }}
          disabled={!store.doc}
          className={isSizeMenuOpen ? TOOLBAR_CHIP_ACTIVE : TOOLBAR_CHIP}
        >
          <TbAspectRatio size={15} />
          Size
          <IoChevronDown size={12} className={`transition-transform ${isSizeMenuOpen ? "rotate-180" : ""}`} />
        </button>
        {sizeMenuAnchor &&
          store.doc &&
          createPortal(
            <div
              onPointerDown={(e) => e.stopPropagation()}
              style={{ position: "fixed", top: sizeMenuAnchor.top, left: sizeMenuAnchor.left }}
              className="w-64 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-md border border-gray-200/80 dark:border-neutral-700/80 shadow-xl ring-1 ring-black/5 z-[9999] p-3 max-h-[70vh] overflow-y-auto"
            >
              <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1.5">Custom size</div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={200}
                  value={sizeDraft.width}
                  onChange={(e) => setSizeDraft((d) => ({ ...d, width: e.target.value }))}
                  className="w-full min-w-0 h-8 px-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 text-xs tabular-nums outline-none focus:border-blue-400 dark:focus:border-blue-500"
                />
                <span className="text-neutral-400 text-xs shrink-0">×</span>
                <input
                  type="number"
                  min={200}
                  value={sizeDraft.height}
                  onChange={(e) => setSizeDraft((d) => ({ ...d, height: e.target.value }))}
                  className="w-full min-w-0 h-8 px-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 text-xs tabular-nums outline-none focus:border-blue-400 dark:focus:border-blue-500"
                />
                <button
                  type="button"
                  onClick={() => {
                    const w = Number(sizeDraft.width);
                    const h = Number(sizeDraft.height);
                    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) handleApplyCanvasSize(w, h);
                    setSizeMenuAnchor(null);
                  }}
                  className="shrink-0 px-2.5 h-8 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                >
                  Apply
                </button>
              </div>

              {BOARD_SIZE_PRESET_GROUPS.map((group) => (
                <div key={group} className="mt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1">{group}</div>
                  {BOARD_SIZE_PRESETS.filter((preset) => preset.group === group).map((preset) => {
                    const isCurrent = store.doc?.canvasWidth === preset.width && store.doc?.canvasHeight === preset.height;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          handleApplyCanvasSize(preset.width, preset.height);
                          setSizeMenuAnchor(null);
                        }}
                        className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-left transition-colors ${
                          isCurrent
                            ? "bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300"
                            : "text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70"
                        }`}
                      >
                        <span className="text-sm">{preset.label}</span>
                        <span className="text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500 shrink-0">
                          {preset.width}×{preset.height}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>,
            document.body
          )}

        <div className="shrink-0 w-px h-6 bg-neutral-200/80 dark:bg-neutral-800 mx-1" />

        {/* Mat/frame border around the whole board - a pure rendering-time inset (see
            paddedCanvasSize), so this just updates live on every keystroke/spinner click, no
            "Apply" step needed. The button beside it is the deliberately separate, explicit
            action for the *other* thing padding governs - the gap between images, which can't be
            live the same way without either fighting free-drag positions or silently doing
            nothing until a rearrange happens (the exact bug the old gridline-width control had).
            No grey pill wrapper here - the number input's own border already gives this cluster a
            visible edge, so a second background box around it would be redundant chrome. */}
        <label className="shrink-0 flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400" title="Board padding">
          Padding
          <input
            type="number"
            min={0}
            max={400}
            value={store.doc?.padding ?? 0}
            onChange={(e) => store.setPadding(Number(e.target.value))}
            disabled={!store.doc}
            className="w-14 h-8 px-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 text-xs tabular-nums outline-none focus:border-blue-400 dark:focus:border-blue-500 disabled:opacity-40 transition-colors"
          />
        </label>
        <button
          type="button"
          title={`Re-apply "${ARRANGE_STYLES.find((s) => s.key === arrangeStyle)?.label}" using the current padding value`}
          onClick={() => handleArrange(arrangeStyle)}
          disabled={!store.doc || arrangeableImageCount < 2}
          className="shrink-0 h-8 px-2.5 rounded-lg text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap"
        >
          Apply
        </button>

        <div className="shrink-0 w-px h-6 bg-neutral-200/80 dark:bg-neutral-800 mx-1" />

        {/* Undo/Redo as one true two-segment control (shared border, hairline divider between the
            halves) rather than two loose buttons floating in a grey box - the visual convention
            for "this pair is one control" everywhere from Photoshop to Figma. */}
        <div className="shrink-0 inline-flex items-center h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden divide-x divide-neutral-200 dark:divide-neutral-700">
          <button
            type="button"
            title="Undo"
            onClick={store.undo}
            disabled={!store.canUndo}
            className="w-9 h-full flex items-center justify-center text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <IoArrowUndo size={16} />
          </button>
          <button
            type="button"
            title="Redo"
            onClick={store.redo}
            disabled={!store.canRedo}
            className="w-9 h-full flex items-center justify-center text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <IoArrowRedo size={16} />
          </button>
        </div>

        <div className="shrink-0 w-px h-6 bg-neutral-200/80 dark:bg-neutral-800 mx-1" />

        {/* Zoom as a single bordered segmented control (- / value / + / fit) - same "one shared
            border, hairline dividers between segments" language as Undo/Redo above, standard for
            a zoom control in every design tool. */}
        <div className="shrink-0 inline-flex items-center h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden divide-x divide-neutral-200 dark:divide-neutral-700">
          <button
            type="button"
            title="Zoom out"
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - 0.1) * 100) / 100))}
            className="w-8 h-full flex items-center justify-center text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
          >
            <IoRemove size={14} />
          </button>
          <div className="flex items-center gap-0.5 px-1.5 h-full bg-neutral-50/60 dark:bg-neutral-800/40">
            <input
              type="number"
              min={Math.round(MIN_ZOOM * 100)}
              max={Math.round(MAX_ZOOM * 100)}
              value={Math.round(zoom * 100)}
              onChange={(e) => {
                // Number("") is 0, not NaN, but an in-progress "cleared the field to retype" state
                // shouldn't snap zoom to the minimum - only a genuinely non-numeric value falls
                // back (to the current zoom, a no-op) rather than clamping straight to MIN_ZOOM.
                const value = Number(e.target.value);
                if (!Number.isFinite(value)) return;
                setZoom(Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value / 100)) * 100) / 100);
              }}
              title="Zoom"
              className="w-9 bg-transparent text-neutral-800 dark:text-neutral-100 text-xs font-medium tabular-nums text-center outline-none"
            />
            <span className="text-xs text-neutral-400 dark:text-neutral-500">%</span>
          </div>
          <button
            type="button"
            title="Zoom in"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + 0.1) * 100) / 100))}
            className="w-8 h-full flex items-center justify-center text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
          >
            <IoAdd size={14} />
          </button>
          <button
            type="button"
            title="Fit to window"
            onClick={handleFitToWindow}
            disabled={!store.doc}
            className="w-9 h-full flex items-center justify-center text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <IoExpandOutline size={14} />
          </button>
        </div>

        <div className="flex-1" />

        {store.isSaving && <span className="text-xs text-neutral-400 dark:text-neutral-500 mr-1">Saving…</span>}
        {copyStatus && (
          <span className="flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 mr-1">
            <IoCheckmarkCircle size={13} /> {copyStatus}
          </span>
        )}

        {/* "Share" - one menu for every way to get the board out of Briefcast: an instant copy
            (paste into a chat/doc/anywhere - the practical "share to any platform" on desktop),
            or a download to either the library's own Board folder or a location the user picks
            themselves. Same portal-dropdown pattern as Arrange/Background - see arrangeMenuAnchor's
            own doc comment for why. */}
        <button
          ref={shareButtonRef}
          type="button"
          title="Share this board - copy, or save as an image"
          onClick={(e) => {
            e.stopPropagation();
            if (isShareMenuOpen) {
              setShareMenuAnchor(null);
            } else {
              setArrangeMenuAnchor(null);
              setBackgroundMenuAnchor(null);
              setAlignMenuAnchor(null);
              setSizeMenuAnchor(null);
              setShapeMenuAnchor(null);
              const rect = shareButtonRef.current?.getBoundingClientRect();
              if (rect) setShareMenuAnchor({ top: rect.bottom + 6, left: rect.right - 224 });
            }
          }}
          disabled={!store.doc || store.doc.images.length === 0}
          className="shrink-0 flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-sm font-semibold tracking-tight bg-gradient-to-b from-neutral-800 to-neutral-950 dark:from-white dark:to-neutral-100 text-white dark:text-neutral-900 shadow-[0_1px_2px_rgba(0,0,0,0.25)] hover:shadow-[0_2px_6px_rgba(0,0,0,0.3)] active:shadow-none transition-all disabled:opacity-50 disabled:shadow-none whitespace-nowrap"
        >
          <IoShareOutline size={16} />
          {isExporting ? "Saving…" : isCopyingToClipboard ? "Copying…" : "Share"}
          <IoChevronDown size={12} className={`transition-transform ${isShareMenuOpen ? "rotate-180" : ""}`} />
        </button>
        {copyStatus && (
          <span className="flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 ml-1">
            <IoCheckmarkCircle size={13} /> {copyStatus}
          </span>
        )}
        {shareMenuAnchor &&
          createPortal(
            <div
              onPointerDown={(e) => e.stopPropagation()}
              style={{ position: "fixed", top: shareMenuAnchor.top, left: shareMenuAnchor.left }}
              className="w-56 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-md border border-gray-200/80 dark:border-neutral-700/80 shadow-xl ring-1 ring-black/5 overflow-hidden z-[9999] py-1"
            >
              <button
                type="button"
                onClick={() => {
                  setShareMenuAnchor(null);
                  void handleCopyToClipboard();
                }}
                className="w-full flex items-start gap-2.5 px-3 py-2 text-left text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
              >
                <IoCopyOutline size={16} className="shrink-0 mt-0.5 text-neutral-400 dark:text-neutral-500" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">Copy to clipboard</span>
                  <span className="block text-xs text-neutral-400 dark:text-neutral-500">Paste into a chat, doc, or anywhere else</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShareMenuAnchor(null);
                  void handleExport();
                }}
                className="w-full flex items-start gap-2.5 px-3 py-2 text-left text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
              >
                <IoCloudDownloadOutline size={16} className="shrink-0 mt-0.5 text-neutral-400 dark:text-neutral-500" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">Save to library</span>
                  <span className="block text-xs text-neutral-400 dark:text-neutral-500">Into your library's Board folder</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShareMenuAnchor(null);
                  void handleSaveAs();
                }}
                className="w-full flex items-start gap-2.5 px-3 py-2 text-left text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
              >
                <IoSaveOutline size={16} className="shrink-0 mt-0.5 text-neutral-400 dark:text-neutral-500" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">Save As…</span>
                  <span className="block text-xs text-neutral-400 dark:text-neutral-500">Choose exactly where to save</span>
                </span>
              </button>
            </div>,
            document.body
          )}
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
          // grid + place-items-center, not flex + items-center/justify-center - the two look
          // identical whenever the canvas fits inside the viewport, but only grid centering stays
          // scrollable to ALL of an oversized child once it's bigger than the container (a huge
          // board at a low zoom can still be bigger than the window - see the Circle/Heart/Masonry
          // arrangements this got reported against). Flexbox centering shifts an overflowing child
          // by a negative margin-equivalent offset that most browsers' scroll containers don't
          // extend scrollable range to cover, so the top/left overflow becomes permanently
          // unreachable while the bottom/right overflow scrolls fine - a well-documented Chromium/
          // Firefox flexbox quirk that CSS Grid's own centering doesn't share.
          className={`relative flex-1 min-w-0 overflow-auto grid place-items-center p-6 transition-colors ${
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
              onReplaceImage={(image) => void handleReplaceImage(image)}
              onBringToFront={handleBringToFront}
              onSendToBack={handleSendToBack}
              onDuplicateItem={(item) => handleDuplicateSelected(new Set([item.id]))}
              onDeleteItem={(item) => handleDeleteSelected(new Set([item.id]))}
            />
          ) : store.loadError ? (
            <span className="text-red-500 dark:text-red-400 text-sm">Failed to load board: {store.loadError}</span>
          ) : (
            <span className="text-neutral-400 dark:text-neutral-500 text-sm italic">Loading board…</span>
          )}
        </div>

        {showLayerPanel && store.doc && (
          <BoardLayerPanel
            items={store.doc.images}
            selectedIds={selectedIds}
            onSelect={setSelectedIds}
            onStepReorder={handleStepReorder}
            onReorder={handleReorderLayer}
            onToggleLock={handleToggleLock}
            onClose={() => setShowLayerPanel(false)}
          />
        )}

        {selectedImages.length > 0 && (
          <BoardStylePanel
            items={selectedImages}
            onChange={handleStyleChange}
            onDelete={handleDeleteSelected}
            onDuplicate={handleDuplicateSelected}
            onBringToFront={handleBringToFront}
            onSendToBack={handleSendToBack}
            onApplyStyleToAllImages={handleApplyImageStyleToAll}
            onApplyStyleToAllTexts={handleApplyTextStyleToAll}
            onApplyStyleToAllBlurs={handleApplyBlurStyleToAll}
            onApplyStyleToAllShapes={handleApplyShapeStyleToAll}
            boardImageCount={store.doc?.images.filter((item) => item.kind === "image").length ?? 0}
            boardTextCount={store.doc?.images.filter((item) => item.kind === "text").length ?? 0}
            boardBlurCount={store.doc?.images.filter((item) => item.kind === "blur").length ?? 0}
            boardShapeCount={store.doc?.images.filter((item) => item.kind === "shape").length ?? 0}
            onReplaceImage={(image) => void handleReplaceImage(image)}
            isReplacingImage={isReplacingImage}
            onNudge={handleNudge}
          />
        )}
      </div>
    </div>
  );
});

BoardEditor.displayName = "BoardEditor";

export default BoardEditor;
