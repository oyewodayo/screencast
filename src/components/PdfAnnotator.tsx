// components/PdfAnnotator.tsx
import React, { useEffect, useRef, useState } from "react";
import usePdfDocument from "../hooks/usePdfDocument";
import useAnnotationStore from "../hooks/useAnnotationStore";
import usePageRenderCache from "../hooks/usePageRenderCache";
import { AnnotationObject, AnnotationTool } from "../utils/pdfAnnotationTypes";
import AnnotationToolbar from "./pdf/AnnotationToolbar";
import PdfPage from "./pdf/PdfPage";
import { loadSettings } from "../utils/appSettings";

interface PdfAnnotatorProps {
  src: string; // asset:// URL, for loading PDF bytes via pdf.js
  sourcePath: string; // raw filesystem path, for the annotations sidecar
  title?: string;
}

// Scroll/touch page-turn tuning.
const PAGE_TURN_COOLDOWN_MS = 500; // stops one trackpad flick or swipe from flipping several pages
const WHEEL_TURN_THRESHOLD = 25;
const SWIPE_TURN_THRESHOLD_PX = 60;
const BOUNDARY_SLOP_PX = 2; // treat "within 2px of the edge" as *at* the edge

// Top-level PDF markup surface: pdf.js-rendered pages with a freehand ink overlay, replacing
// the old plain <iframe> viewer (which couldn't support drawing at all). Owns the active tool
// and viewport state; delegates PDF loading to usePdfDocument and annotation persistence/
// undo-redo to useAnnotationStore.
const PdfAnnotator: React.FC<PdfAnnotatorProps> = ({ src, sourcePath, title }) => {
  const { pdfDoc, numPages, loading: pdfLoading, error: pdfError } = usePdfDocument(src);
  const store = useAnnotationStore(sourcePath);
  const pageCache = usePageRenderCache();

  const [currentPageIndex, setCurrentPageIndex] = useState<number>(0);
  const [zoom, setZoom] = useState<number>(() => loadSettings().pdfDefaultZoom);
  const [twoPageMode, setTwoPageMode] = useState<boolean>(false);
  // null = no tool selected ("deselected" / plain viewing mode) — clicking the already-active
  // tool in the toolbar toggles it back to null instead of leaving it stuck selected.
  const [tool, setTool] = useState<AnnotationTool | null>(() => {
    const defaultTool = loadSettings().pdfDefaultTool;
    return defaultTool === "none" ? null : defaultTool;
  });
  // Pen and highlighter remember their own last-picked color (matches how real markup apps
  // behave — switching tools shouldn't lose your highlighter color because you picked black
  // for the pen a moment ago).
  const [penColor, setPenColor] = useState<string>(() => loadSettings().pdfDefaultPenColor);
  const [highlighterColor, setHighlighterColor] = useState<string>(() => loadSettings().pdfDefaultHighlighterColor);
  const [strokeWidth, setStrokeWidth] = useState<number>(() => loadSettings().pdfDefaultStrokeWidth);

  const activeColor = tool === "highlighter" ? highlighterColor : penColor;
  const setActiveColor = tool === "highlighter" ? setHighlighterColor : setPenColor;

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

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastPageTurnAtRef = useRef<number>(0);
  // Set right before a page change so the post-navigation scroll-position effect knows which
  // edge of the new page/spread to land on (see the effect below for why this matters).
  const pendingScrollAnchorRef = useRef<"top" | "bottom">("top");

  const handlePageChange = (rawIndex: number, anchor: "top" | "bottom" = rawIndex >= clampedPageIndex ? "top" : "bottom"): void => {
    let target = rawIndex;
    if (twoPageMode) target -= target % 2;
    target = Math.min(Math.max(target, 0), Math.max(numPages - 1, 0));
    if (target === clampedPageIndex) return;
    pendingScrollAnchorRef.current = anchor;
    setCurrentPageIndex(target);
  };

  const handleToolChange = (nextTool: AnnotationTool): void => {
    setTool((prev) => (prev === nextTool ? null : nextTool));
  };

  const handleDeselectTool = (): void => {
    setTool(null);
  };

  const handleToggleTwoPageMode = (): void => {
    setTwoPageMode((prev) => {
      const next = !prev;
      if (next) setCurrentPageIndex((idx) => idx - (idx % 2));
      return next;
    });
  };

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

    const handleWheel = (e: WheelEvent): void => {
      if (withinCooldown()) return;
      if (e.deltaY > WHEEL_TURN_THRESHOLD && isAtBottom() && clampedPageIndex + pageStep <= numPages - 1) {
        e.preventDefault();
        turnPage(1);
      } else if (e.deltaY < -WHEEL_TURN_THRESHOLD && isAtTop() && clampedPageIndex > 0) {
        e.preventDefault();
        turnPage(-1);
      }
    };

    // Touch: tracked as a discrete start->end swipe rather than continuous deltas, so it doesn't
    // fight the browser's native momentum scrolling while the gesture is still in progress —
    // the decision only gets made once, when the finger lifts.
    let touchStartY: number | null = null;
    let touchIsMulti = false;

    const handleTouchStart = (e: TouchEvent): void => {
      touchIsMulti = e.touches.length > 1;
      touchStartY = touchIsMulti ? null : e.touches[0].clientY;
    };
    const handleTouchMove = (e: TouchEvent): void => {
      if (e.touches.length > 1) {
        touchIsMulti = true;
        touchStartY = null;
      }
    };
    const handleTouchEnd = (e: TouchEvent): void => {
      if (touchIsMulti || touchStartY === null || withinCooldown()) {
        touchStartY = null;
        return;
      }
      const endY = e.changedTouches[0]?.clientY;
      const startY = touchStartY;
      touchStartY = null;
      if (endY === undefined) return;

      const deltaY = startY - endY; // positive = finger swiped upward = forward/next intent
      if (deltaY > SWIPE_TURN_THRESHOLD_PX && isAtBottom() && clampedPageIndex + pageStep <= numPages - 1) {
        turnPage(1);
      } else if (deltaY < -SWIPE_TURN_THRESHOLD_PX && isAtTop() && clampedPageIndex > 0) {
        turnPage(-1);
      }
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: true });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clampedPageIndex, numPages, pageStep]);

  // Left/Up = previous page, Right/Down = next page. Ignored while focus is in a text field,
  // number input, or the width slider — those already use arrow keys for their own purpose
  // (e.g. nudging the width slider), and we don't want to steal that.
  useEffect(() => {
    const isEditableTarget = (el: Element | null): boolean => {
      if (!el) return false;
      if (el instanceof HTMLElement && el.isContentEditable) return true;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    };

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (isEditableTarget(document.activeElement)) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        handlePageChange(clampedPageIndex - pageStep, "bottom");
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        handlePageChange(clampedPageIndex + pageStep, "top");
      } else if (e.key === "Escape") {
        handleDeselectTool();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [clampedPageIndex, numPages, pageStep]);

  if (pdfError) {
    return (
      <div className="flex items-center justify-center h-full w-full text-red-600 italic">
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
      eraserRadius={Math.max(12, strokeWidth * 3)}
      interactive={!store.loading}
      onStrokeComplete={(object: AnnotationObject) => store.addObject(object)}
      onEraseBegin={store.beginErase}
      onEraseAt={store.eraseAt}
      onEraseEnd={store.endErase}
    />
  );

  return (
    <div className="w-full h-screen flex flex-col bg-gradient-to-b from-neutral-100 to-neutral-200">
      <AnnotationToolbar
        title={title}
        tool={tool}
        onToolChange={handleToolChange}
        onDeselectTool={handleDeselectTool}
        color={activeColor}
        onColorChange={setActiveColor}
        strokeWidth={strokeWidth}
        onStrokeWidthChange={setStrokeWidth}
        currentPageIndex={clampedPageIndex}
        numPages={numPages}
        pageStep={pageStep}
        onPageChange={handlePageChange}
        zoom={zoom}
        onZoomChange={setZoom}
        twoPageMode={twoPageMode}
        onToggleTwoPageMode={handleToggleTwoPageMode}
        canUndo={store.canUndo}
        canRedo={store.canRedo}
        onUndo={store.undo}
        onRedo={store.redo}
        isSaving={store.isSaving}
        saveError={store.saveError}
      />

      {/* min-h-0 is load-bearing: without it a flex-1 child can't shrink below its content's
          intrinsic height, so overflow-auto never actually gets a chance to scroll. */}
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto flex items-start justify-center p-8">
        {pdfLoading || !pdfDoc || store.loading ? (
          <div className="text-gray-500 italic mt-20">Loading…</div>
        ) : twoPageMode ? (
          <div className="flex items-start gap-4">
            {renderPage(clampedPageIndex, "left")}
            {hasRightPage && renderPage(rightPageIndex, "right")}
          </div>
        ) : (
          renderPage(clampedPageIndex, "single")
        )}
      </div>
    </div>
  );
};

export default PdfAnnotator;
