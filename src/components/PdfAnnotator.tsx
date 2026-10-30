// components/PdfAnnotator.tsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import { IoContract } from "react-icons/io5";
import { invoke } from "@tauri-apps/api/core";
import usePdfDocument from "../hooks/usePdfDocument";
import useAnnotationStore from "../hooks/useAnnotationStore";
import usePageRenderCache from "../hooks/usePageRenderCache";
import { AnnotationObject, AnnotationTool, CommentObject } from "../utils/pdfAnnotationTypes";
import { makeImageObject } from "../handlers/pdfAnnotationHandlers";
import { exportAnnotatedPdf } from "../handlers/pdfExportHandlers";
import { fileToDataUrl } from "../utils/imageObjectCache";
import AnnotationToolbar from "./pdf/AnnotationToolbar";
import { CommentsChip, EditButton, PageNavigator, SaveIndicator, ZoomControl } from "./pdf/PdfViewerControls";
import PageFlipOverlay, { FlipRect, PageFlip } from "./pdf/PageFlipOverlay";
import PdfPage from "./pdf/PdfPage";
import PdfSidebar, { PdfSidebarView } from "./pdf/PdfSidebar";
import PdfMagnifierLens from "./pdf/PdfMagnifierLens";
import { loadSettings } from "../utils/appSettings";
import Toast from "./custom/Toast";

const IMAGE_MAX_DIMENSION_PX = 2048; // downscale threshold before embedding into the sidecar JSON
const IMAGE_MAX_INITIAL_WIDTH_FRACTION = 0.5; // fraction of the page's width, at 100% zoom, an inserted image is capped to

interface PdfAnnotatorProps {
  src: string; // asset:// URL, for loading PDF bytes via pdf.js
  sourcePath: string; // raw filesystem path, for the annotations sidecar
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}

// Scroll/touch page-turn tuning.
const PAGE_TURN_COOLDOWN_MS = 500; // stops one trackpad flick or swipe from flipping several pages
const WHEEL_TURN_THRESHOLD = 25;
const SWIPE_TURN_THRESHOLD_PX = 60;
const BOUNDARY_SLOP_PX = 2; // treat "within 2px of the edge" as *at* the edge
const PINCH_ZOOM_SENSITIVITY = 0.01;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
// Horizontal page turns: a two-finger trackpad swipe (wheel deltaX, accumulated over the gesture)
// or a one-finger touch swipe in Select mode.
const H_WHEEL_TURN_THRESHOLD = 60;
const H_WHEEL_GESTURE_GAP_MS = 180; // this long without horizontal wheel events = the swipe (and its momentum tail) is over
// Must match the scroll container's padding (p-8) and the two-page spread's gap (gap-4) below.
const VIEW_PADDING_PX = 32;
const SPREAD_GAP_PX = 16;
// Extra room fit-to-screen leaves clear on each side for the floating controls (zoom pill top
// right; Edit button, tools dock and page navigator bottom right) so they sit beside the page
// rather than on it. Symmetric, so the fitted page stays centered.
const FIT_CHROME_X_PX = 60;
const FIT_CHROME_Y_PX = 40;

const prefersReducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

// Composites a rendered page's stacked canvases (page bitmap, committed ink, in-progress scratch)
// into one standalone canvas, for the page-turn animation to keep showing after the real page has
// already moved on to its new content.
const snapshotPage = (wrapper: Element | undefined): HTMLCanvasElement | null => {
  if (!wrapper) return null;
  const layers = Array.from(wrapper.querySelectorAll(":scope > canvas")) as HTMLCanvasElement[];
  const base = layers[0];
  if (!base || base.width <= 1) return null;
  const out = document.createElement("canvas");
  out.width = base.width;
  out.height = base.height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  for (const layer of layers) if (layer.width > 0 && layer.height > 0) ctx.drawImage(layer, 0, 0, out.width, out.height);
  return out;
};

// Top-level PDF markup surface: pdf.js-rendered pages with a freehand ink overlay, replacing
// the old plain <iframe> viewer (which couldn't support drawing at all). Owns the active tool
// and viewport state; delegates PDF loading to usePdfDocument and annotation persistence/
// undo-redo to useAnnotationStore.
const PdfAnnotator: React.FC<PdfAnnotatorProps> = ({ src, sourcePath, isFullscreen, onToggleFullscreen }) => {
  const { pdfDoc, numPages, loading: pdfLoading, error: pdfError } = usePdfDocument(src);
  const store = useAnnotationStore(sourcePath);
  const pageCache = usePageRenderCache();

  const [currentPageIndex, setCurrentPageIndex] = useState<number>(0);
  const [zoom, setZoom] = useState<number>(() => loadSettings().pdfDefaultZoom);
  // Fit-to-screen: on by default, so a document opens with its page (or spread) filling the view,
  // and kept up as the window/sidebar resizes or the view mode changes. Any manual zoom (buttons,
  // typed value, shortcuts, pinch) turns it off; the Fit button turns it back on.
  // Opening fitted can be turned off in Settings, in which case the PDF opens at pdfDefaultZoom.
  const [fitMode, setFitMode] = useState<boolean>(() => loadSettings().pdfFitOnOpen);
  // Pages aren't shown until the first fit lands, so they don't render once at the default zoom
  // only to be thrown away a frame later.
  const [initialFitDone, setInitialFitDone] = useState<boolean>(() => !loadSettings().pdfFitOnOpen);
  const [viewSize, setViewSize] = useState<{ width: number; height: number } | null>(null);
  const [twoPageMode, setTwoPageMode] = useState<boolean>(false);
  // The vertical tools dock, revealed by the Edit button. Closed on open so the document reads as
  // a document first.
  const [toolsOpen, setToolsOpen] = useState<boolean>(false);
  const [flip, setFlip] = useState<PageFlip | null>(null);
  const flipIdRef = useRef<number>(0);
  // null = neither panel open. Mutually exclusive with itself only (not with the annotation
  // tool) — you can keep drawing while browsing thumbnails/contents.
  const [sidebarView, setSidebarView] = useState<PdfSidebarView | null>(null);
  // null = no tool selected ("deselected" / plain viewing mode) — clicking the already-active
  // tool in the toolbar toggles it back to null instead of leaving it stuck selected.
  // Starts deselected since the dock starts closed; opening the dock restores the last tool used
  // (initially the default tool from Settings).
  const [tool, setTool] = useState<AnnotationTool | null>(null);
  const [magnifierActive, setMagnifierActive] = useState<boolean>(false);
  const [isMagnifierPinned, setIsMagnifierPinned] = useState<boolean>(false);
  const [settingsDefaultTool] = useState<AnnotationTool | null>(() => {
    const defaultTool = loadSettings().pdfDefaultTool;
    return defaultTool === "none" ? null : defaultTool;
  });
  const lastToolRef = useRef<AnnotationTool | null>(settingsDefaultTool);
  // Pen, highlighter, and text notes each remember their own last-picked color (matches how real
  // markup apps behave — switching tools shouldn't lose your highlighter color because you
  // picked black for the pen a moment ago).
  const [penColor, setPenColor] = useState<string>(() => loadSettings().pdfDefaultPenColor);
  const [highlighterColor, setHighlighterColor] = useState<string>(() => loadSettings().pdfDefaultHighlighterColor);
  const [textColor, setTextColor] = useState<string>(() => loadSettings().pdfDefaultPenColor);
  const [strokeWidth, setStrokeWidth] = useState<number>(() => loadSettings().pdfDefaultStrokeWidth);
  // The same 1-20 width slider doubles as the text tool's font size, mapped to a legible PDF-space
  // point range (~10-48) rather than reusing the raw 1-20 value, which would be unreadably small.
  const textFontSize = 8 + strokeWidth * 2;

  // Which image annotation (if any) currently shows move/resize/rotate handles. Lifted up here
  // (rather than living inside PdfPage) because an image can be inserted/pasted while any page is
  // showing, and selection needs to follow it regardless of which <PdfPage> instance ends up
  // holding the matching object — see PdfPage's selectedObjectId/onSelectObject props.
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Export-to-flattened-PDF state, kept local to this component rather than in useAnnotationStore
  // — it's a one-shot rendering/IO action over the current doc, not part of the store's own
  // load/edit/autosave lifecycle.
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<{ completed: number; total: number } | null>(null);
  const [exportMessage, setExportMessage] = useState<string>("");
  const [exportError, setExportError] = useState<string>("");

  const activeColor = tool === "highlighter" ? highlighterColor : tool === "text" ? textColor : penColor;
  const setActiveColor = tool === "highlighter" ? setHighlighterColor : tool === "text" ? setTextColor : setPenColor;

  // Invariant: in two-page mode, currentPageIndex is always the *left* page of the spread (an
  // even index — spreads are fixed pairs 0-1, 2-3, 4-5..., not "whatever's currently on the
  // left"), so navigation, the page-jump input, and boundary math all stay simple and predictable.
  const pageStep = twoPageMode ? 2 : 1;
  const clampedPageIndex = (() => {
    let idx = Math.min(currentPageIndex, Math.max(numPages - 1, 0));
    if (twoPageMode) idx -= idx % 2;
    return idx;
  })();
  const rightPageIndex = clampedPageIndex + 1;
  const hasRightPage = twoPageMode && rightPageIndex < numPages;

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const spreadRef = useRef<HTMLDivElement>(null);
  const lastPageTurnAtRef = useRef<number>(0);
  // Set right before a page change so the post-navigation scroll-position effect knows which
  // edge of the new page/spread to land on (see the effect below for why this matters).
  const pendingScrollAnchorRef = useRef<"top" | "bottom">("top");

  // Snapshots the spread as it is right now (before the page index changes) and hands it to
  // PageFlipOverlay, which animates the leaf turning over the real, already-updated spread.
  const startPageFlip = (target: number): void => {
    const root = rootRef.current;
    const spread = spreadRef.current;
    // Read per turn (cheap) so switching it in Settings applies to the already-open document.
    if (!root || !spread || prefersReducedMotion() || loadSettings().pdfPageTurn !== "flip") return;
    const [leftEl, rightEl] = Array.from(spread.children);
    const rootBox = root.getBoundingClientRect();
    const rectOf = (el: Element): FlipRect => {
      const r = el.getBoundingClientRect();
      return { left: r.left - rootBox.left, top: r.top - rootBox.top, width: r.width, height: r.height };
    };
    const leftCanvas = snapshotPage(leftEl);
    const rightCanvas = snapshotPage(rightEl);
    if (!leftEl || !leftCanvas) return;
    const leftRect = rectOf(leftEl);
    const rightRect = rightEl ? rectOf(rightEl) : null;
    const spineX = rightRect ? (leftRect.left + leftRect.width + rightRect.left) / 2 : leftRect.left + leftRect.width + SPREAD_GAP_PX / 2;

    if (target > clampedPageIndex) {
      if (!rightRect || !rightCanvas) return; // the last spread has no right page to turn
      setFlip({
        id: ++flipIdRef.current,
        direction: 1,
        spineX,
        leaf: { canvas: rightCanvas, rect: rightRect },
        cover: { canvas: leftCanvas, rect: leftRect },
        under: target + 1 < numPages ? { pageIndex: target + 1, rect: rightRect } : null,
        backPageIndex: target,
      });
    } else {
      setFlip({
        id: ++flipIdRef.current,
        direction: -1,
        spineX,
        leaf: { canvas: leftCanvas, rect: leftRect },
        cover: rightRect && rightCanvas ? { canvas: rightCanvas, rect: rightRect } : null,
        under: { pageIndex: target, rect: leftRect },
        backPageIndex: target + 1 < numPages ? target + 1 : null,
      });
    }
  };

  // Clamped first, then snapped to a spread's left page - the other order could land on the odd
  // last index and look like a page change that isn't one.
  const handlePageChange = (rawIndex: number, anchor: "top" | "bottom" = rawIndex >= clampedPageIndex ? "top" : "bottom"): void => {
    let target = Math.min(Math.max(rawIndex, 0), Math.max(numPages - 1, 0));
    if (twoPageMode) target -= target % 2;
    if (target === clampedPageIndex) return;
    if (twoPageMode) startPageFlip(target);
    pendingScrollAnchorRef.current = anchor;
    setCurrentPageIndex(target);
  };

  const handleToggleMagnifier = useCallback(() => {
    setMagnifierActive((prev) => {
      const next = !prev;
      if (next) {
        setTool(null);
      } else {
        setIsMagnifierPinned(false);
      }
      return next;
    });
  }, []);

  const handleToolChange = (nextTool: AnnotationTool): void => {
    setSelectedObjectId(null); // switching to a drawing tool exits image-selection mode
    setToolsOpen(true); // a tool shortcut (P, H, ...) reveals the dock it belongs to
    if (!isMagnifierPinned) {
      setMagnifierActive(false);
    }
    const next = tool === nextTool ? null : nextTool;
    lastToolRef.current = next;
    setTool(next);
  };

  const handleDeselectTool = (): void => {
    setTool(null);
    lastToolRef.current = null;
    if (!isMagnifierPinned) {
      setMagnifierActive(false);
    }
  };

  // Closing the dock puts the viewer back into plain reading mode (an invisible-but-armed pen
  // would be a trap); opening it picks up where the user left off.
  const handleToggleTools = (): void => {
    if (toolsOpen) {
      setToolsOpen(false);
      setTool(null);
      setSelectedObjectId(null);
    } else {
      setToolsOpen(true);
      setTool(lastToolRef.current);
    }
  };

  // Every user-driven zoom goes through here so it leaves fit-to-screen mode.
  const applyManualZoom = (next: number | ((z: number) => number)): void => {
    setFitMode(false);
    setZoom(next);
  };

  // Selecting an image only ever makes sense on the page it's actually on — clear it on every
  // navigation rather than leaving a stale id around that happens to self-clean once the relevant
  // <PdfPage> re-renders with different `objects`.
  useEffect(() => {
    setSelectedObjectId(null);
  }, [clampedPageIndex]);

  // Reads a File (from the hidden file input or a paste event) into an ImageObject sized to fit
  // the current page and centered on the current viewport, adds it, and selects it so its
  // move/resize/rotate handles show immediately.
  const insertImageFile = useCallback(
    async (file: File): Promise<void> => {
      if (!pdfDoc) return;
      try {
        const loaded = await fileToDataUrl(file, IMAGE_MAX_DIMENSION_PX);
        const page = await pdfDoc.getPage(clampedPageIndex + 1);
        const pageViewportAtScale1 = page.getViewport({ scale: 1 });
        const zoomViewport = page.getViewport({ scale: zoom });
        const [pdfCenterX, pdfCenterY] = zoomViewport.convertToPdfPoint(zoomViewport.width / 2, zoomViewport.height / 2);

        const width = Math.min(loaded.width, pageViewportAtScale1.width * IMAGE_MAX_INITIAL_WIDTH_FRACTION);
        const height = width * (loaded.height / loaded.width);
        const x = pdfCenterX - width / 2;
        const y = pdfCenterY + height / 2;

        const object = makeImageObject(clampedPageIndex, x, y, width, height, loaded.dataUrl);
        store.addObject(object);
        setSelectedObjectId(object.id);
      } catch (err) {
        console.error("Failed to insert image:", err);
      }
    },
    // store.addObject specifically (not the whole `store`) — useAnnotationStore returns a fresh
    // object every render, so depending on `store` itself would tear down and resubscribe the
    // paste listener effect below on every render instead of just when addObject actually changes.
    [pdfDoc, clampedPageIndex, zoom, store.addObject]
  );

  const handleInsertImageClick = (): void => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file consecutively
    if (file) void insertImageFile(file);
  };

  // Flattens every page's bitmap + its annotations into a brand-new standalone PDF (see
  // pdfExportHandlers.ts) and writes it to "<name> (annotated).pdf" next to the source file — so
  // the markup survives moving/sharing just the PDF, not only autosaving to this app's own
  // sidecar JSON.
  const handleExport = useCallback(async (): Promise<void> => {
    if (!pdfDoc || numPages === 0 || isExporting) return;
    setIsExporting(true);
    setExportProgress({ completed: 0, total: numPages });
    setExportError("");
    try {
      const bytes = await exportAnnotatedPdf(pdfDoc, numPages, store.getPageObjects, (completed, total) =>
        setExportProgress({ completed, total })
      );
      const outputPath = await invoke<string>("save_exported_pdf", { pdfPath: sourcePath, bytes: Array.from(bytes) });
      const outputName = outputPath.split(/[\\/]/).pop() ?? outputPath;
      setExportMessage(`Exported to ${outputName}`);
    } catch (err) {
      console.error("Failed to export annotated PDF:", err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
      setExportProgress(null);
    }
  }, [pdfDoc, numPages, isExporting, store.getPageObjects, sourcePath]);

  // Global paste-image support: works regardless of which tool is active, as long as focus isn't
  // in an editable element that should receive the paste itself (e.g. a text-note textarea).
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent): void => {
      const target = e.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT")) {
        return;
      }
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

  const handleSidebarViewChange = (view: PdfSidebarView): void => {
    setSidebarView((prev) => (prev === view ? null : view));
  };

  // Comments panel -> the comment in place: go to its page (snapped to its spread in two-page
  // mode), switch to Select so its card is interactive, and let the PdfPage holding it open it.
  const [focusComment, setFocusComment] = useState<{ id: string; nonce: number } | null>(null);
  const handleOpenComment = (comment: CommentObject): void => {
    handleDeselectTool();
    setSelectedObjectId(null);
    handlePageChange(comment.pageIndex);
    setFocusComment((prev) => ({ id: comment.id, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  const handleToggleTwoPageMode = (): void => {
    setTwoPageMode((prev) => {
      const next = !prev;
      if (next) setCurrentPageIndex((idx) => idx - (idx % 2));
      return next;
    });
  };

  // Track the viewing area's size for fit-to-screen (window resizes, the sidebar opening, entering
  // fullscreen all change it).
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit-to-screen: the largest zoom at which the whole current page - or both pages of the
  // spread - fits inside the padded viewing area. A last, odd single page in two-page mode is
  // sized as if it had a partner, so the zoom doesn't jump when you reach it.
  useEffect(() => {
    if (!fitMode || !pdfDoc || numPages === 0 || !viewSize) return;
    let cancelled = false;
    const indices = twoPageMode ? [clampedPageIndex, Math.min(clampedPageIndex + 1, numPages - 1)] : [clampedPageIndex];
    Promise.all(indices.map((i) => pdfDoc.getPage(i + 1).then((page) => page.getViewport({ scale: 1 }))))
      .then((viewports) => {
        if (cancelled) return;
        const contentWidth = viewports.reduce((sum, vp) => sum + vp.width, 0);
        const contentHeight = Math.max(...viewports.map((vp) => vp.height));
        const chromeX = isFullscreen ? 0 : FIT_CHROME_X_PX;
        const chromeY = isFullscreen ? 0 : FIT_CHROME_Y_PX;
        const availWidth = viewSize.width - 2 * (VIEW_PADDING_PX + chromeX) - (twoPageMode ? SPREAD_GAP_PX : 0);
        const availHeight = viewSize.height - 2 * (VIEW_PADDING_PX + chromeY);
        const fit = Math.min(availWidth / contentWidth, availHeight / contentHeight);
        // Floored to whole percent: never a hair too big (which would add scrollbars), and keeps
        // render-cache keys stable across tiny resizes.
        setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.floor(fit * 100) / 100)));
        setInitialFitDone(true);
      })
      .catch(() => {
        if (!cancelled) setInitialFitDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fitMode, pdfDoc, numPages, viewSize, twoPageMode, clampedPageIndex, isFullscreen]);

  // In two-page mode a turn needs the *next/previous spread* ready (the flip animation shows it
  // immediately) - PdfPage's own prefetch only reaches one page either side.
  useEffect(() => {
    if (!twoPageMode || !pdfDoc || !initialFitDone) return;
    const timer = window.setTimeout(() => {
      for (const i of [clampedPageIndex + 2, clampedPageIndex + 3, clampedPageIndex - 1, clampedPageIndex - 2]) {
        if (i >= 0 && i < numPages) pageCache.getPage(pdfDoc, i, zoom).catch(() => {});
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [twoPageMode, pdfDoc, initialFitDone, clampedPageIndex, numPages, zoom, pageCache]);

  // Every page/spread change lands the scroll container at the edge that keeps reading
  // continuous: advancing forward starts you at the top of the new page, going back leaves you
  // at the bottom (so you land where you'd expect to have "come from"). The double rAF gives the
  // browser a layout pass first — scrollHeight needs to reflect the newly rendered page's actual
  // size (especially for the 'bottom' anchor) before we can read it.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const anchor = pendingScrollAnchorRef.current;
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.scrollTop = anchor === "bottom" ? el.scrollHeight : 0;
      })
    );
    return () => cancelAnimationFrame(raf);
  }, [clampedPageIndex]);

  // Scroll/swipe-driven page turning: normal wheel/touch scrolling within a page is untouched
  // (native overflow-auto handles it) — this only fires when the user keeps scrolling *past* an
  // edge the content has already reached, converting that "nothing left to scroll" gesture into
  // a page turn instead of it just doing nothing.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const isAtTop = () => el.scrollTop <= BOUNDARY_SLOP_PX;
    const isAtBottom = () => el.scrollTop + el.clientHeight >= el.scrollHeight - BOUNDARY_SLOP_PX;
    const withinCooldown = () => Date.now() - lastPageTurnAtRef.current < PAGE_TURN_COOLDOWN_MS;
    const turnPage = (direction: 1 | -1): void => {
      lastPageTurnAtRef.current = Date.now();
      handlePageChange(clampedPageIndex + direction * pageStep, direction > 0 ? "top" : "bottom");
    };

    // Trackpad pinch-to-zoom: Chromium reports a pinch gesture as a wheel event with
    // ctrlKey=true (there's no separate "gesture" event outside Safari), which conveniently
    // also covers a literal held-Ctrl + scroll-wheel zoom for free via the same code path.
    // preventDefault stops the browser's own whole-page zoom from firing instead.
    let pinchRestoreRaf1: number | null = null;
    let pinchRestoreRaf2: number | null = null;
    const handlePinchZoom = (e: WheelEvent): void => {
      e.preventDefault();
      if (pinchRestoreRaf1 !== null) cancelAnimationFrame(pinchRestoreRaf1);
      if (pinchRestoreRaf2 !== null) cancelAnimationFrame(pinchRestoreRaf2);

      // Preserve scroll position as a *fraction* of the scrollable content rather than trying to
      // keep the exact point under the cursor fixed — the container has fixed, zoom-independent
      // padding/gaps (p-8, the two-page gap-4) that a precise cursor-anchored formula would need
      // to account for, and getting that math wrong would drift over repeated pinch steps. This
      // is a deliberately simpler, robust approximation: no jarring jump back to the corner, at
      // the cost of not being pixel-perfect under the cursor.
      const scrollableWidth = el.scrollWidth - el.clientWidth;
      const scrollableHeight = el.scrollHeight - el.clientHeight;
      const fracX = scrollableWidth > 0 ? el.scrollLeft / scrollableWidth : 0.5;
      const fracY = scrollableHeight > 0 ? el.scrollTop / scrollableHeight : 0.5;

      const factor = Math.exp(-e.deltaY * PINCH_ZOOM_SENSITIVITY);
      applyManualZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));

      // Double rAF: the page needs an actual layout pass at the new zoom before scrollWidth/
      // Height reflect its new size — same technique as the page-change scroll-anchor effect.
      pinchRestoreRaf1 = requestAnimationFrame(() => {
        pinchRestoreRaf2 = requestAnimationFrame(() => {
          pinchRestoreRaf1 = null;
          pinchRestoreRaf2 = null;
          const newScrollableWidth = el.scrollWidth - el.clientWidth;
          const newScrollableHeight = el.scrollHeight - el.clientHeight;
          el.scrollLeft = fracX * newScrollableWidth;
          el.scrollTop = fracY * newScrollableHeight;
        });
      });
    };

    // Two-finger horizontal trackpad swipe: right-to-left = next, left-to-right = previous, like
    // turning a book's pages. Only when there's no horizontal scrolling for it to mean instead
    // (or it's pushing past the edge already reached). One turn per gesture: after turning, the
    // rest of the swipe and its momentum tail are swallowed until the events stop for a moment.
    const canScrollX = () => el.scrollWidth - el.clientWidth > BOUNDARY_SLOP_PX;
    const isAtLeft = () => el.scrollLeft <= BOUNDARY_SLOP_PX;
    const isAtRight = () => el.scrollLeft + el.clientWidth >= el.scrollWidth - BOUNDARY_SLOP_PX;
    let hAccum = 0;
    let hLocked = false;
    let hGestureTimer: number | undefined;
    const handleHorizontalWheel = (e: WheelEvent): void => {
      window.clearTimeout(hGestureTimer);
      hGestureTimer = window.setTimeout(() => {
        hAccum = 0;
        hLocked = false;
      }, H_WHEEL_GESTURE_GAP_MS);
      if (canScrollX() && !(e.deltaX > 0 ? isAtRight() : isAtLeft())) return; // let it scroll
      e.preventDefault();
      if (hLocked) return;
      hAccum += e.deltaX;
      if (Math.abs(hAccum) < H_WHEEL_TURN_THRESHOLD) return;
      const direction = hAccum > 0 ? 1 : -1;
      hAccum = 0;
      hLocked = true;
      if (direction > 0 ? clampedPageIndex + pageStep <= numPages - 1 : clampedPageIndex > 0) turnPage(direction);
    };

    const handleWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) {
        handlePinchZoom(e);
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        handleHorizontalWheel(e);
        return;
      }

      if (withinCooldown()) return;
      if (e.deltaY > WHEEL_TURN_THRESHOLD && isAtBottom() && clampedPageIndex + pageStep <= numPages - 1) {
        e.preventDefault();
        turnPage(1);
      } else if (e.deltaY < -WHEEL_TURN_THRESHOLD && isAtTop() && clampedPageIndex > 0) {
        e.preventDefault();
        turnPage(-1);
      }
    };

    // Touch: single-finger tracked as a discrete start->end swipe rather than continuous deltas,
    // so it doesn't fight the browser's native momentum scrolling while the gesture is still in
    // progress - the page-turn decision only gets made once, when the finger lifts. Two-finger
    // pinch is genuinely continuous instead (zoom needs to visibly track the fingers as they
    // move, not just resolve once at the end) - tracked by the distance between the two touch
    // points, compared move-to-move (not against the gesture's starting distance) so each step's
    // zoom factor is small and incremental, the same shape handlePinchZoom already uses for wheel
    // deltas, via the same functional setZoom updater (sidesteps needing a ref to the latest zoom
    // value, since this effect's own closures don't get to see it change without re-running).
    let touchStartY: number | null = null;
    let touchStartX: number | null = null;
    let touchIsMulti = false;
    let lastPinchDistance: number | null = null;

    const touchDistance = (touches: TouchList): number => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx, dy);
    };

    const handleTouchStart = (e: TouchEvent): void => {
      // A touch on a selected object's chrome (image handles, the ink selection box) is that
      // editor's drag - never a page-turn swipe.
      if (e.target instanceof Element && e.target.closest("[data-annotation-editor]")) {
        touchStartY = null;
        touchStartX = null;
        touchIsMulti = true;
        lastPinchDistance = null;
        return;
      }
      touchIsMulti = e.touches.length > 1;
      touchStartY = touchIsMulti ? null : e.touches[0].clientY;
      touchStartX = touchIsMulti ? null : e.touches[0].clientX;
      lastPinchDistance = touchIsMulti ? touchDistance(e.touches) : null;
    };
    const handleTouchMove = (e: TouchEvent): void => {
      if (e.touches.length < 2) return; // single-finger case stays untouched (native scroll)

      const currentDistance = touchDistance(e.touches);
      if (!touchIsMulti || lastPinchDistance === null) {
        // A second finger just landed mid-gesture (this touch sequence started as a single-finger
        // swipe) - baseline here instead of computing a factor against a distance that was never
        // actually measured between two points.
        touchIsMulti = true;
        touchStartY = null;
        lastPinchDistance = currentDistance;
        return;
      }
      // Stops the OS/WebView's own native viewport pinch-zoom from firing instead - same reason
      // handleWheel's ctrlKey branch calls preventDefault, just for the touch-native equivalent.
      e.preventDefault();
      if (lastPinchDistance > 0) {
        const factor = currentDistance / lastPinchDistance;
        applyManualZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));
      }
      lastPinchDistance = currentDistance;
    };
    const handleTouchEnd = (e: TouchEvent): void => {
      if (touchIsMulti || touchStartY === null || withinCooldown()) {
        touchStartY = null;
        return;
      }
      const endY = e.changedTouches[0]?.clientY;
      const endX = e.changedTouches[0]?.clientX;
      const startY = touchStartY;
      const startX = touchStartX;
      touchStartY = null;
      touchStartX = null;
      if (endY === undefined) return;

      // One-finger horizontal swipe turns the page in Select mode (with a drawing tool active the
      // same gesture is a stroke). Finger right-to-left = next, like a book.
      const deltaX = startX !== null && endX !== undefined ? startX - endX : 0;
      if (tool === null && Math.abs(deltaX) > SWIPE_TURN_THRESHOLD_PX && Math.abs(deltaX) > Math.abs(startY - endY) * 1.5 && !canScrollX()) {
        if (deltaX > 0 && clampedPageIndex + pageStep <= numPages - 1) turnPage(1);
        else if (deltaX < 0 && clampedPageIndex > 0) turnPage(-1);
        return;
      }

      const deltaY = startY - endY; // positive = finger swiped upward = forward/next intent
      if (deltaY > SWIPE_TURN_THRESHOLD_PX && isAtBottom() && clampedPageIndex + pageStep <= numPages - 1) {
        turnPage(1);
      } else if (deltaY < -SWIPE_TURN_THRESHOLD_PX && isAtTop() && clampedPageIndex > 0) {
        turnPage(-1);
      }
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    // Not passive - the pinch branch inside handleTouchMove needs to call preventDefault, which a
    // passive listener would silently (and, in Chromium, noisily-in-the-console) ignore.
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      if (pinchRestoreRaf1 !== null) cancelAnimationFrame(pinchRestoreRaf1);
      if (pinchRestoreRaf2 !== null) cancelAnimationFrame(pinchRestoreRaf2);
      window.clearTimeout(hGestureTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clampedPageIndex, numPages, pageStep, tool]);

  // Full keyboard shortcut set for the toolbar — see each IconButton's title in
  // AnnotationToolbar.tsx for the matching hint shown on hover. Ignored while focus is in a
  // text field, number input, or the width slider — those already use some of these keys for
  // their own purpose (typing "p", nudging a slider with arrows, etc.), and we don't want to
  // steal that. Escape exits fullscreen first if active, taking priority over every other
  // Escape behavior (deselecting a tool), matching the universal "Escape = leave fullscreen"
  // convention every other app follows.
  useEffect(() => {
    const isEditableTarget = (el: Element | null): boolean => {
      if (!el) return false;
      if (el instanceof HTMLElement && el.isContentEditable) return true;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    };

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (isEditableTarget(document.activeElement)) return;

      if (e.key === "Escape") {
        e.preventDefault();
        if (magnifierActive) {
          if (isMagnifierPinned) {
            setIsMagnifierPinned(false);
          } else {
            setMagnifierActive(false);
          }
          return;
        }
        if (isFullscreen) onToggleFullscreen();
        else {
          handleDeselectTool();
          setSelectedObjectId(null);
        }
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        handlePageChange(clampedPageIndex - pageStep, "bottom");
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        handlePageChange(clampedPageIndex + pageStep, "top");
        return;
      }

      // Ctrl/Cmd combos: undo/redo and zoom. Anything else held with Ctrl/Cmd (Ctrl+P, Ctrl+S,
      // ...) is deliberately left alone rather than falling through to the plain-letter tool
      // shortcuts below, which would otherwise hijack e.g. Ctrl+P (print) into selecting the pen.
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === "z" && !e.shiftKey) {
          e.preventDefault();
          if (store.canUndo) store.undo();
        } else if (key === "y" || (key === "z" && e.shiftKey)) {
          e.preventDefault();
          if (store.canRedo) store.redo();
        } else if (key === "=" || key === "+" || e.code === "Equal" || e.code === "NumpadAdd") {
          // e.code (the physical key position, unaffected by Shift/layout/locale) is checked
          // alongside e.key - on some keyboard layouts a Ctrl-held combo can report a `.key` that
          // doesn't match the plain unshifted character the layout's own base key would normally
          // produce, which is exactly the kind of thing that'd make this shortcut work on some
          // machines and not others for no reason visible in the code itself.
          e.preventDefault();
          applyManualZoom((z) => Math.min(MAX_ZOOM, Math.round((z + 0.25) * 100) / 100));
        } else if (key === "-" || e.code === "Minus" || e.code === "NumpadSubtract") {
          e.preventDefault();
          applyManualZoom((z) => Math.max(MIN_ZOOM, Math.round((z - 0.25) * 100) / 100));
        } else if (key === "0") {
          e.preventDefault();
          setFitMode(true);
        }
        return;
      }

      if (e.altKey) return; // don't claim plain letters under Alt either

      switch (e.key.toLowerCase()) {
        case "v":
          e.preventDefault();
          handleDeselectTool();
          break;
        case "m":
          e.preventDefault();
          handleToggleMagnifier();
          break;
        case "p":
          e.preventDefault();
          handleToolChange("pen");
          break;
        case "h":
          e.preventDefault();
          handleToolChange("highlighter");
          break;
        case "t":
          e.preventDefault();
          handleToolChange("text");
          break;
        case "e":
          e.preventDefault();
          handleToolChange("eraser");
          break;
        case "b":
          e.preventDefault();
          handleToggleTwoPageMode();
          break;
        case "f":
          e.preventDefault();
          onToggleFullscreen();
          break;
        case "[":
          e.preventDefault();
          setStrokeWidth((w) => Math.max(1, w - 1));
          break;
        case "]":
          e.preventDefault();
          setStrokeWidth((w) => Math.min(20, w + 1));
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    clampedPageIndex,
    numPages,
    pageStep,
    twoPageMode,
    tool,
    toolsOpen,
    store.canUndo,
    store.canRedo,
    store.undo,
    store.redo,
    isFullscreen,
    onToggleFullscreen,
    magnifierActive,
    isMagnifierPinned,
    handleToggleMagnifier,
  ]);

  if (pdfError) {
    return (
      <div className="flex items-center justify-center h-full w-full text-red-600 dark:text-red-400 italic">
        Failed to load PDF: {pdfError}
      </div>
    );
  }

  const renderPage = (pageIndex: number, key: string) => (
    <PdfPage
      key={key}
      pdfDoc={pdfDoc!}
      pageIndex={pageIndex}
      numPages={numPages}
      zoom={zoom}
      cache={pageCache}
      objects={store.getPageObjects(pageIndex)}
      tool={tool}
      color={activeColor}
      width={strokeWidth}
      textFontSize={textFontSize}
      eraserRadius={Math.max(12, strokeWidth * 3)}
      interactive={!store.loading}
      selectedObjectId={selectedObjectId}
      onSelectObject={setSelectedObjectId}
      onStrokeComplete={(object: AnnotationObject) => store.addObject(object)}
      onObjectEdit={store.editObject}
      onObjectDelete={store.deleteObject}
      onEraseBegin={store.beginErase}
      onEraseAt={store.eraseAt}
      onEraseEnd={store.endErase}
      focusComment={focusComment}
    />
  );

  const showPages = !(pdfLoading || !pdfDoc || store.loading || !initialFitDone);

  return (
    // Absolutely sized rather than h-screen: Dashboard's BottomDocker floats over the bottom of
    // this pane, so the viewer stops at its published height (--docker-height) - otherwise the
    // fitted page and the floating bottom-right controls would sit underneath it. Presentation
    // mode hides the docker, so it gets the full height there.
    <div
      ref={rootRef}
      style={{ bottom: isFullscreen ? 0 : "var(--docker-height, 64px)" }}
      className="absolute inset-x-0 top-0 flex flex-col overflow-hidden bg-gradient-to-b from-neutral-100 to-neutral-200 dark:from-neutral-900 dark:to-neutral-950">
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileInputChange} className="hidden" />
      {isFullscreen && (
        // Presentation mode: no chrome at all - just the page(s) and a single, always-visible way
        // back out (the shortcuts - F, Escape - still work with nothing rendered to hint at them).
        <button
          type="button"
          data-tip="Exit fullscreen"
          data-tip-kbd="F"
          aria-label="Exit fullscreen"
          onClick={onToggleFullscreen}
          className="fixed top-4 right-4 z-50 flex items-center justify-center w-9 h-9 rounded-full bg-black/40 text-white hover:bg-black/60 backdrop-blur-sm transition-colors"
        >
          <IoContract size={16} />
        </button>
      )}

      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 items-center">
        {exportMessage && <Toast key={`export-msg-${exportMessage}`} message={exportMessage} variant="info" onDismiss={() => setExportMessage("")} />}
        {exportError && <Toast key={`export-err-${exportError}`} message={`Export failed: ${exportError}`} variant="error" onDismiss={() => setExportError("")} />}
      </div>

      {/* min-h-0 here (and min-w-0 one level down) is load-bearing: without it a flex child can't
          shrink below its content's intrinsic size in either axis, so overflow-auto never
          actually gets a chance to scroll - instead the oversized content (e.g. a wide landscape
          page) blows out this container's own flex-item width upstream in Dashboard.tsx. */}
      <div className="flex-1 min-h-0 flex items-stretch overflow-hidden">
        {!isFullscreen && sidebarView && pdfDoc && (
          <PdfSidebar
            pdfDoc={pdfDoc}
            numPages={numPages}
            currentPageIndex={clampedPageIndex}
            onPageChange={handlePageChange}
            view={sidebarView}
            comments={store.comments}
            visiblePageIndices={hasRightPage ? [clampedPageIndex, rightPageIndex] : [clampedPageIndex]}
            onOpenComment={handleOpenComment}
          />
        )}
        {/* align-items: safe center - centered when the page fits, start-aligned the moment it
            doesn't (plain centering an overflowing flex item pushes its top past the scrollable
            range, making the top of a tall page unreachable). */}
        <div ref={scrollContainerRef} className="flex-1 min-h-0 min-w-0 overflow-auto flex [align-items:safe_center] justify-center p-8">
          {!showPages ? (
            <div className="text-gray-500 dark:text-neutral-400 italic">Loading…</div>
          ) : twoPageMode ? (
            <div ref={spreadRef} className="flex items-start gap-4">
              {renderPage(clampedPageIndex, "left")}
              {hasRightPage && renderPage(rightPageIndex, "right")}
            </div>
          ) : (
            renderPage(clampedPageIndex, "single")
          )}
        </div>
      </div>

      {flip && pdfDoc && <PageFlipOverlay key={flip.id} flip={flip} pdfDoc={pdfDoc} cache={pageCache} zoom={zoom} onDone={() => setFlip(null)} />}

      {magnifierActive && (
        <PdfMagnifierLens
          active={magnifierActive}
          onClose={() => {
            setMagnifierActive(false);
            setIsMagnifierPinned(false);
          }}
          viewerRef={rootRef}
          scrollContainerRef={scrollContainerRef}
          pdfDoc={pdfDoc}
          currentPageIndex={clampedPageIndex}
          twoPageMode={twoPageMode}
          numPages={numPages}
          zoom={zoom}
          onPinChange={setIsMagnifierPinned}
        />
      )}

      {!isFullscreen && (
        <>
          <div className="absolute top-4 left-4 z-30">
            <SaveIndicator isSaving={store.isSaving} saveError={store.saveError} exportProgress={exportProgress} />
          </div>
          {/* Centered on the same vertical axis as the Edit button / tools dock below it. */}
          <div className="absolute top-4 right-[26px] z-30">
            <ZoomControl
              zoom={zoom}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              fitMode={fitMode}
              onZoomChange={applyManualZoom}
              onFit={() => setFitMode(true)}
              magnifierActive={magnifierActive}
              onToggleMagnifier={handleToggleMagnifier}
            />
          </div>

          {/* Bottom-right stack: the tools dock rises out of the Edit button; the page navigator
              stays put underneath it. top-[160px] keeps the dock clear of the zoom column - in a
              short window the dock scrolls instead of running into it. */}
          <div className="absolute top-[150px] bottom-5 right-5 z-30 flex flex-col justify-end items-end gap-3 pointer-events-none">
            <div className="min-h-0 flex flex-col items-center gap-3">
              <AnnotationToolbar
                open={toolsOpen}
                sidebarView={sidebarView}
                onSidebarViewChange={handleSidebarViewChange}
                commentCount={store.comments.length}
                tool={tool}
                onToolChange={handleToolChange}
                onDeselectTool={handleDeselectTool}
                onInsertImageClick={handleInsertImageClick}
                color={activeColor}
                onColorChange={setActiveColor}
                strokeWidth={strokeWidth}
                onStrokeWidthChange={setStrokeWidth}
                twoPageMode={twoPageMode}
                onToggleTwoPageMode={handleToggleTwoPageMode}
                onToggleFullscreen={onToggleFullscreen}
                canUndo={store.canUndo}
                canRedo={store.canRedo}
                onUndo={store.undo}
                onRedo={store.redo}
                isExporting={isExporting}
                onExport={handleExport}
                magnifierActive={magnifierActive}
                onToggleMagnifier={handleToggleMagnifier}
              />
              {/* With the dock closed (the default when reopening a document), this is what tells
                  you the PDF already carries comments - the dock's own Comments entry takes over
                  once it's open. */}
              {!toolsOpen && store.comments.length > 0 && (
                <div className="shrink-0 pointer-events-auto">
                  <CommentsChip count={store.comments.length} active={sidebarView === "comments"} onClick={() => handleSidebarViewChange("comments")} />
                </div>
              )}
              <div className="shrink-0 pointer-events-auto">
                <EditButton open={toolsOpen} onToggle={handleToggleTools} />
              </div>
            </div>
            <div className="shrink-0 pointer-events-auto">
              <PageNavigator
                currentPageIndex={clampedPageIndex}
                numPages={numPages}
                pageStep={pageStep}
                twoPageMode={twoPageMode}
                onPageChange={handlePageChange}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default PdfAnnotator;
