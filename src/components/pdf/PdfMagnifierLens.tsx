// components/pdf/PdfMagnifierLens.tsx
// An optical magnifying lens tool for the PDF reader:
// - Renders a sleek physical loupe (circle or rounded rectangle) over the document
// - Real-time smooth tracking across single-page and two-page spreads
// - High-DPI background pre-rendering for razor-sharp vector clarity on text, math formulas, and diagrams
// - Composites annotations (ink, highlighters, text notes) under the lens
// - Interactive floating controls: zoom levels (1.5x - 5x), lens size (S, M, L), shape, reticle/crosshair toggle
// - Pin mode: click to lock the lens in place on the page, with drag-repositioning so users can inspect formulas while annotating
// - Keyboard shortcuts: M to toggle, Escape to unpin/close, +/- to zoom, [/] to resize lens, Alt+Scroll to zoom factor

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  IoAdd,
  IoRemove,
  IoClose,
  IoEllipseOutline,
  IoSquareOutline,
  IoScanOutline,
} from "react-icons/io5";
import { BsPinAngle, BsPinAngleFill, BsArrowsMove } from "react-icons/bs";

export interface PdfMagnifierLensProps {
  active: boolean;
  onClose: () => void;
  viewerRef: React.RefObject<HTMLDivElement | null>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  pdfDoc: PDFDocumentProxy | null;
  currentPageIndex: number;
  twoPageMode: boolean;
  numPages: number;
  zoom: number;
  onPinChange?: (isPinned: boolean) => void;
}

export type LensSizeKey = "sm" | "md" | "lg";
export type LensShape = "circle" | "rect";

const LENS_SIZES: Record<LensSizeKey, { circle: { w: number; h: number }; rect: { w: number; h: number } }> = {
  sm: { circle: { w: 180, h: 180 }, rect: { w: 260, h: 160 } },
  md: { circle: { w: 240, h: 240 }, rect: { w: 340, h: 210 } },
  lg: { circle: { w: 320, h: 320 }, rect: { w: 420, h: 260 } },
};

const ZOOM_STEPS = [1.5, 2.0, 2.5, 3.0, 4.0, 5.0];

interface PinnedPosition {
  pageIndex: number;
  relX: number; // Offset from page element's top-left in CSS px
  relY: number;
}

const PdfMagnifierLens: React.FC<PdfMagnifierLensProps> = ({
  active,
  onClose,
  viewerRef,
  scrollContainerRef,
  pdfDoc,
  currentPageIndex,
  twoPageMode,
  numPages,
  zoom,
  onPinChange,
}) => {
  const [magnification, setMagnification] = useState<number>(2.5);
  const [sizeKey, setSizeKey] = useState<LensSizeKey>("md");
  const [shape, setShape] = useState<LensShape>("circle");
  const [showReticle, setShowReticle] = useState<boolean>(true);
  const [isPinned, setIsPinned] = useState<boolean>(false);
  const [pinnedPos, setPinnedPos] = useState<PinnedPosition | null>(null);

  // Mouse client coordinates (viewport space)
  const [mousePos, setMousePos] = useState<{ clientX: number; clientY: number } | null>(null);
  const [isHoveringViewer, setIsHoveringViewer] = useState<boolean>(true);
  const [isDraggingPinned, setIsDraggingPinned] = useState<boolean>(false);

  const lensCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; startRelX: number; startRelY: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // High-res cache: pageIndex -> { canvas, scale }
  const highResCacheRef = useRef<Map<number, { canvas: HTMLCanvasElement; scale: number }>>(new Map());
  const inFlightRendersRef = useRef<Set<number>>(new Set());

  // Notify parent of pin state changes
  useEffect(() => {
    onPinChange?.(isPinned);
  }, [isPinned, onPinChange]);

  const { w: lensWidth, h: lensHeight } = LENS_SIZES[sizeKey][shape];

  // Pre-render visible pages at high resolution in the background
  useEffect(() => {
    if (!active || !pdfDoc) return;

    const visiblePages = twoPageMode
      ? [currentPageIndex, currentPageIndex + 1].filter((p) => p < numPages)
      : [currentPageIndex];

    const targetScale = Math.min(4.5, Math.max(2.4, zoom * magnification * 1.35));

    for (const pageIdx of visiblePages) {
      const cached = highResCacheRef.current.get(pageIdx);
      if (cached && Math.abs(cached.scale - targetScale) < 0.25) continue;
      if (inFlightRendersRef.current.has(pageIdx)) continue;

      inFlightRendersRef.current.add(pageIdx);
      void (async () => {
        try {
          const page = await pdfDoc.getPage(pageIdx + 1);
          const vp = page.getViewport({ scale: targetScale });
          const offscreen = document.createElement("canvas");
          offscreen.width = Math.round(vp.width);
          offscreen.height = Math.round(vp.height);
          const ctx = offscreen.getContext("2d");
          if (ctx) {
            await page.render({ canvas: offscreen, canvasContext: ctx, viewport: vp }).promise;
            highResCacheRef.current.set(pageIdx, { canvas: offscreen, scale: targetScale });
            requestDraw();
          }
        } catch (err) {
          console.warn("High-res magnifier pre-render failed:", err);
        } finally {
          inFlightRendersRef.current.delete(pageIdx);
        }
      })();
    }
  }, [active, pdfDoc, currentPageIndex, twoPageMode, numPages, zoom, magnification]);

  // Request a redraw on the next animation frame
  const requestDraw = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      drawLens();
    });
  }, [magnification, lensWidth, lensHeight, shape, showReticle, isPinned, pinnedPos, mousePos]);

  // Find target coordinates and render the magnified view
  const drawLens = useCallback(() => {
    const canvas = lensCanvasRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!canvas || !scrollContainer) return;

    const dpr = window.devicePixelRatio || 1;
    const expectedW = Math.round(lensWidth * dpr);
    const expectedH = Math.round(lensHeight * dpr);

    if (canvas.width !== expectedW || canvas.height !== expectedH) {
      canvas.width = expectedW;
      canvas.height = expectedH;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    // Clean page background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, lensWidth, lensHeight);

    // Determine center position of the lens in client coordinates
    let lensCenterX = 0;
    let lensCenterY = 0;

    if (isPinned && pinnedPos) {
      const pageEl = scrollContainer.querySelector<HTMLElement>(`[data-pdf-page-index="${pinnedPos.pageIndex}"]`);
      if (pageEl) {
        const pageRect = pageEl.getBoundingClientRect();
        lensCenterX = pageRect.left + pinnedPos.relX;
        lensCenterY = pageRect.top + pinnedPos.relY;
      } else {
        // Pinned page is out of view
        lensCenterX = window.innerWidth / 2;
        lensCenterY = window.innerHeight / 2;
      }
    } else if (mousePos) {
      lensCenterX = mousePos.clientX;
      lensCenterY = mousePos.clientY;
    } else {
      const containerRect = scrollContainer.getBoundingClientRect();
      lensCenterX = containerRect.left + containerRect.width / 2;
      lensCenterY = containerRect.top + containerRect.height / 2;
    }

    // Locate the page under the lens center
    const pageElements = Array.from(scrollContainer.querySelectorAll<HTMLElement>("[data-pdf-page-index]"));
    let targetPageEl: HTMLElement | null = null;
    let targetPageRect: DOMRect | null = null;

    for (const el of pageElements) {
      const r = el.getBoundingClientRect();
      if (lensCenterX >= r.left && lensCenterX <= r.right && lensCenterY >= r.top && lensCenterY <= r.bottom) {
        targetPageEl = el;
        targetPageRect = r;
        break;
      }
    }

    // If near the border or gap, select the closest page
    if (!targetPageEl && pageElements.length > 0) {
      let closestDist = Infinity;
      for (const el of pageElements) {
        const r = el.getBoundingClientRect();
        const cx = Math.max(r.left, Math.min(r.right, lensCenterX));
        const cy = Math.max(r.top, Math.min(r.bottom, lensCenterY));
        const dist = Math.hypot(lensCenterX - cx, lensCenterY - cy);
        if (dist < closestDist) {
          closestDist = dist;
          targetPageEl = el;
          targetPageRect = r;
        }
      }
    }

    if (targetPageEl && targetPageRect && targetPageRect.width > 0 && targetPageRect.height > 0) {
      const pageIndex = Number(targetPageEl.getAttribute("data-pdf-page-index"));
      const canvases = targetPageEl.querySelectorAll("canvas");
      const baseCanvas = canvases[0] as HTMLCanvasElement | undefined;
      const overlayCanvas = canvases[1] as HTMLCanvasElement | undefined;

      const cached = highResCacheRef.current.get(pageIndex);
      const srcCanvas = cached?.canvas ?? baseCanvas;

      if (srcCanvas && srcCanvas.width > 0 && srcCanvas.height > 0) {
        const cursorPageX = lensCenterX - targetPageRect.left;
        const cursorPageY = lensCenterY - targetPageRect.top;

        const sourceWidth = lensWidth / magnification;
        const sourceHeight = lensHeight / magnification;
        const sourceLeft = cursorPageX - sourceWidth / 2;
        const sourceTop = cursorPageY - sourceHeight / 2;

        const clampLeft = Math.max(0, sourceLeft);
        const clampTop = Math.max(0, sourceTop);
        const clampRight = Math.min(targetPageRect.width, sourceLeft + sourceWidth);
        const clampBottom = Math.min(targetPageRect.height, sourceTop + sourceHeight);

        if (clampRight > clampLeft && clampBottom > clampTop) {
          const visibleSrcW = clampRight - clampLeft;
          const visibleSrcH = clampBottom - clampTop;

          const scaleToLens = lensWidth / sourceWidth;
          const dx = (clampLeft - sourceLeft) * scaleToLens;
          const dy = (clampTop - sourceTop) * scaleToLens;
          const dw = visibleSrcW * scaleToLens;
          const dh = visibleSrcH * scaleToLens;

          const canvasToPageX = srcCanvas.width / targetPageRect.width;
          const canvasToPageY = srcCanvas.height / targetPageRect.height;

          const sx = clampLeft * canvasToPageX;
          const sy = clampTop * canvasToPageY;
          const sw = visibleSrcW * canvasToPageX;
          const sh = visibleSrcH * canvasToPageY;

          ctx.save();
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(srcCanvas, sx, sy, sw, sh, dx, dy, dw, dh);

          // Composite annotations
          if (overlayCanvas && overlayCanvas.width > 0 && overlayCanvas.height > 0) {
            const ocToPageX = overlayCanvas.width / targetPageRect.width;
            const ocToPageY = overlayCanvas.height / targetPageRect.height;
            ctx.drawImage(
              overlayCanvas,
              clampLeft * ocToPageX,
              clampTop * ocToPageY,
              visibleSrcW * ocToPageX,
              visibleSrcH * ocToPageY,
              dx,
              dy,
              dw,
              dh
            );
          }
          ctx.restore();
        }
      }
    }

    // Reticle (hairline crosshairs with open center aperture)
    if (showReticle) {
      const cx = lensWidth / 2;
      const cy = lensHeight / 2;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(59, 130, 246, 0.85)";

      // Subtle drop glow for visibility on both dark and light content
      ctx.shadowColor = "rgba(255, 255, 255, 0.9)";
      ctx.shadowBlur = 2;

      const gap = 5;
      const tick = 14;

      ctx.beginPath();
      // Horizontal ticks
      ctx.moveTo(cx - gap - tick, cy);
      ctx.lineTo(cx - gap, cy);
      ctx.moveTo(cx + gap, cy);
      ctx.lineTo(cx + gap + tick, cy);

      // Vertical ticks
      ctx.moveTo(cx, cy - gap - tick);
      ctx.lineTo(cx, cy - gap);
      ctx.moveTo(cx, cy + gap);
      ctx.lineTo(cx, cy + gap + tick);

      ctx.stroke();

      // Delicate center ring
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    }
  }, [
    lensWidth,
    lensHeight,
    magnification,
    showReticle,
    isPinned,
    pinnedPos,
    mousePos,
    scrollContainerRef,
  ]);

  // Redraw when state or view changes
  useEffect(() => {
    requestDraw();
  }, [requestDraw, magnification, sizeKey, shape, showReticle, isPinned, pinnedPos, mousePos, zoom, currentPageIndex]);

  // Track mouse movement and viewer scroll
  useEffect(() => {
    if (!active) return;
    const scrollContainer = scrollContainerRef.current;
    const viewer = viewerRef.current;
    if (!viewer || !scrollContainer) return;

    const handlePointerMove = (e: PointerEvent): void => {
      if (isDraggingPinned) return;
      const rect = viewer.getBoundingClientRect();
      const isInside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;

      setIsHoveringViewer(isInside);
      if (isInside || !isPinned) {
        setMousePos({ clientX: e.clientX, clientY: e.clientY });
        requestDraw();
      }
    };

    const handleScroll = (): void => {
      requestDraw();
    };

    window.addEventListener("pointermove", handlePointerMove);
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  }, [active, isPinned, isDraggingPinned, viewerRef, scrollContainerRef, requestDraw]);

  // Click-to-pin listener in capture phase: when in follow mode, clicking on a PDF page pins the lens
  useEffect(() => {
    if (!active || isPinned) return;
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const handleCapturePointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // Ignore clicks on control buttons, toolbar docks, or floating panels
      if (target.closest("[data-magnifier-ignore]") || target.closest("button") || target.closest("input")) return;

      // Check if click lands on or inside a PDF page
      const pageEl = target.closest<HTMLElement>("[data-pdf-page-index]");
      if (pageEl) {
        e.preventDefault();
        e.stopPropagation();
        const pageIndex = Number(pageEl.getAttribute("data-pdf-page-index"));
        const pageRect = pageEl.getBoundingClientRect();
        setPinnedPos({
          pageIndex,
          relX: e.clientX - pageRect.left,
          relY: e.clientY - pageRect.top,
        });
        setIsPinned(true);
      }
    };

    window.addEventListener("pointerdown", handleCapturePointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", handleCapturePointerDown, true);
    };
  }, [active, isPinned, scrollContainerRef]);

  // Keyboard controls for the magnifier
  useEffect(() => {
    if (!active) return;

    const handleKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

      if (e.key === "Escape") {
        e.preventDefault();
        if (isPinned) {
          setIsPinned(false);
        } else {
          onClose();
        }
        return;
      }

      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setMagnification((m) => {
          const idx = ZOOM_STEPS.findIndex((s) => s >= m);
          return idx < ZOOM_STEPS.length - 1 ? ZOOM_STEPS[idx + 1] : m;
        });
        return;
      }

      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setMagnification((m) => {
          const idx = ZOOM_STEPS.findIndex((s) => s >= m);
          return idx > 0 ? ZOOM_STEPS[idx - 1] : m;
        });
        return;
      }

      if (e.key === "[") {
        e.preventDefault();
        setSizeKey((k) => (k === "lg" ? "md" : k === "md" ? "sm" : "lg"));
        return;
      }

      if (e.key === "]") {
        e.preventDefault();
        setSizeKey((k) => (k === "sm" ? "md" : k === "md" ? "lg" : "sm"));
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, isPinned, onClose]);

  // Wheel zoom factor when holding Alt or Shift over the PDF reader
  useEffect(() => {
    if (!active) return;
    const viewer = viewerRef.current;
    if (!viewer) return;

    const handleWheel = (e: WheelEvent): void => {
      if (e.altKey || e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (e.deltaY < 0) {
          setMagnification((m) => {
            const idx = ZOOM_STEPS.findIndex((s) => s >= m);
            return idx < ZOOM_STEPS.length - 1 ? ZOOM_STEPS[idx + 1] : m;
          });
        } else if (e.deltaY > 0) {
          setMagnification((m) => {
            const idx = ZOOM_STEPS.findIndex((s) => s >= m);
            return idx > 0 ? ZOOM_STEPS[idx - 1] : m;
          });
        }
      }
    };

    viewer.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewer.removeEventListener("wheel", handleWheel);
  }, [active, viewerRef]);

  // Dragging the pinned lens
  const handleDragHandleDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!pinnedPos) return;

    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startRelX: pinnedPos.relX,
      startRelY: pinnedPos.relY,
    };
    setIsDraggingPinned(true);

    const onPointerMove = (ev: PointerEvent): void => {
      if (!dragStartRef.current) return;
      const dx = ev.clientX - dragStartRef.current.mouseX;
      const dy = ev.clientY - dragStartRef.current.mouseY;
      setPinnedPos((prev) => (prev ? { ...prev, relX: dragStartRef.current!.startRelX + dx, relY: dragStartRef.current!.startRelY + dy } : prev));
      requestDraw();
    };

    const onPointerUp = (): void => {
      setIsDraggingPinned(false);
      dragStartRef.current = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  // Magnification step buttons
  const handleZoomIn = (): void => {
    setMagnification((m) => {
      const idx = ZOOM_STEPS.findIndex((s) => s >= m);
      return idx < ZOOM_STEPS.length - 1 ? ZOOM_STEPS[idx + 1] : m;
    });
  };

  const handleZoomOut = (): void => {
    setMagnification((m) => {
      const idx = ZOOM_STEPS.findIndex((s) => s >= m);
      return idx > 0 ? ZOOM_STEPS[idx - 1] : m;
    });
  };

  const handleCycleZoom = (): void => {
    setMagnification((m) => {
      const idx = ZOOM_STEPS.findIndex((s) => s >= m);
      return idx < ZOOM_STEPS.length - 1 ? ZOOM_STEPS[idx + 1] : ZOOM_STEPS[0];
    });
  };

  const handleCycleSize = (): void => {
    setSizeKey((k) => (k === "sm" ? "md" : k === "md" ? "lg" : "sm"));
  };

  const toggleShape = (): void => {
    setShape((s) => (s === "circle" ? "rect" : "circle"));
  };

  const handleTogglePin = (): void => {
    if (isPinned) {
      setIsPinned(false);
    } else {
      // Pin at current center position
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) return;

      let clientX = mousePos?.clientX ?? window.innerWidth / 2;
      let clientY = mousePos?.clientY ?? window.innerHeight / 2;

      const pageElements = Array.from(scrollContainer.querySelectorAll<HTMLElement>("[data-pdf-page-index]"));
      for (const el of pageElements) {
        const r = el.getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
          const pageIndex = Number(el.getAttribute("data-pdf-page-index"));
          setPinnedPos({
            pageIndex,
            relX: clientX - r.left,
            relY: clientY - r.top,
          });
          setIsPinned(true);
          return;
        }
      }

      // If outside, pick first visible page
      if (pageElements.length > 0) {
        const el = pageElements[0];
        const pageIndex = Number(el.getAttribute("data-pdf-page-index"));
        const r = el.getBoundingClientRect();
        setPinnedPos({
          pageIndex,
          relX: r.width / 2,
          relY: r.height / 2,
        });
        setIsPinned(true);
      }
    }
  };

  // If follow mode and pointer left viewer, hide gracefully
  if (!active || (!isPinned && !isHoveringViewer && !mousePos)) {
    return null;
  }

  // Calculate lens screen position relative to viewer container
  const viewer = viewerRef.current;
  const viewerRect = viewer?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

  let screenCenterX = 0;
  let screenCenterY = 0;

  if (isPinned && pinnedPos) {
    const pageEl = scrollContainerRef.current?.querySelector<HTMLElement>(`[data-pdf-page-index="${pinnedPos.pageIndex}"]`);
    if (pageEl) {
      const pageRect = pageEl.getBoundingClientRect();
      screenCenterX = pageRect.left + pinnedPos.relX;
      screenCenterY = pageRect.top + pinnedPos.relY;
    } else {
      screenCenterX = viewerRect.left + viewerRect.width / 2;
      screenCenterY = viewerRect.top + viewerRect.height / 2;
    }
  } else if (mousePos) {
    screenCenterX = mousePos.clientX;
    screenCenterY = mousePos.clientY;
  } else {
    screenCenterX = viewerRect.left + viewerRect.width / 2;
    screenCenterY = viewerRect.top + viewerRect.height / 2;
  }

  let lensLeft = screenCenterX - viewerRect.left - lensWidth / 2;
  let lensTop = screenCenterY - viewerRect.top - lensHeight / 2;

  // Keep lens inside the viewer boundaries
  lensLeft = Math.max(12, Math.min(viewerRect.width - lensWidth - 12, lensLeft));
  lensTop = Math.max(12, Math.min(viewerRect.height - lensHeight - 12, lensTop));

  // Determine if floating controls fit below or above
  const controlsAbove = lensTop + lensHeight + 52 > viewerRect.height;

  return (
    <div
      data-magnifier-ignore
      style={{
        left: lensLeft,
        top: lensTop,
        width: lensWidth,
        height: lensHeight,
      }}
      className={`absolute z-40 select-none transition-[box-shadow,border-color] duration-200 ${
        isPinned ? "pointer-events-auto" : "pointer-events-none"
      }`}
    >
      {/* Outer lens frame with optical bezel styling */}
      <div
        style={{
          width: lensWidth,
          height: lensHeight,
          borderRadius: shape === "circle" ? "9999px" : "22px",
        }}
        className={`relative overflow-hidden transition-[border-radius] duration-200 ring-4 ${
          isPinned
            ? "ring-blue-500/90 shadow-[0_24px_64px_rgba(37,99,235,0.32),0_6px_20px_rgba(0,0,0,0.22)]"
            : "ring-white/95 dark:ring-neutral-800/95 shadow-[0_24px_64px_rgba(0,0,0,0.36),0_6px_18px_rgba(0,0,0,0.2)]"
        }`}
      >
        {/* Rendered magnified canvas */}
        <canvas
          ref={lensCanvasRef}
          style={{ width: lensWidth, height: lensHeight }}
          className="block w-full h-full bg-white"
        />

        {/* Optical glass sheen / reflection gradient */}
        <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-white/30 via-white/5 to-transparent rounded-[inherit]" />

        {/* Drag handle when pinned */}
        {isPinned && (
          <div
            onPointerDown={handleDragHandleDown}
            className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-neutral-900/80 hover:bg-neutral-900 text-white/90 text-[10.5px] font-medium backdrop-blur-md cursor-grab active:cursor-grabbing shadow-lg ring-1 ring-white/15 select-none hover:scale-105 active:scale-95 transition-all"
            title="Drag to reposition the magnifying lens"
          >
            <BsArrowsMove size={11} className="text-blue-400" />
            <span>Drag</span>
          </div>
        )}
      </div>

      {/* Floating control bar attached to the lens */}
      <div
        data-magnifier-ignore
        style={{ pointerEvents: "auto" }}
        className={`absolute left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 rounded-full bg-neutral-900/92 dark:bg-neutral-900/95 text-white backdrop-blur-xl shadow-2xl ring-1 ring-white/15 text-xs z-50 whitespace-nowrap ${
          controlsAbove ? "-top-11" : "-bottom-11"
        }`}
      >
        {/* Zoom controls */}
        <button
          type="button"
          onClick={handleZoomOut}
          disabled={magnification <= ZOOM_STEPS[0]}
          className="flex items-center justify-center w-6 h-6 rounded-full text-neutral-300 hover:text-white hover:bg-white/15 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          title="Zoom out (-)"
          aria-label="Zoom out"
        >
          <IoRemove size={13} />
        </button>

        <button
          type="button"
          onClick={handleCycleZoom}
          className="px-1.5 py-0.5 font-bold text-[11px] tabular-nums hover:text-blue-400 rounded transition-colors"
          title="Click to cycle magnification level"
        >
          {magnification.toFixed(1).replace(/\.0$/, "")}×
        </button>

        <button
          type="button"
          onClick={handleZoomIn}
          disabled={magnification >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
          className="flex items-center justify-center w-6 h-6 rounded-full text-neutral-300 hover:text-white hover:bg-white/15 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          title="Zoom in (+)"
          aria-label="Zoom in"
        >
          <IoAdd size={13} />
        </button>

        <div className="w-px h-3.5 bg-white/20 my-auto mx-0.5" />

        {/* Lens size cycle */}
        <button
          type="button"
          onClick={handleCycleSize}
          className="px-1.5 py-0.5 rounded text-[10.5px] font-semibold text-neutral-300 hover:text-white hover:bg-white/15 transition-colors uppercase tracking-tight"
          title={`Lens size: ${sizeKey.toUpperCase()} (cycle with [ / ])`}
          aria-label="Lens size"
        >
          {sizeKey}
        </button>

        {/* Lens shape toggle */}
        <button
          type="button"
          onClick={toggleShape}
          className="flex items-center justify-center w-6 h-6 rounded-full text-neutral-300 hover:text-white hover:bg-white/15 transition-colors"
          title={shape === "circle" ? "Switch to rectangular lens" : "Switch to circular lens"}
          aria-label="Toggle lens shape"
        >
          {shape === "circle" ? <IoSquareOutline size={12} /> : <IoEllipseOutline size={12} />}
        </button>

        {/* Reticle toggle */}
        <button
          type="button"
          onClick={() => setShowReticle((v) => !v)}
          className={`flex items-center justify-center w-6 h-6 rounded-full transition-colors ${
            showReticle ? "text-blue-400 bg-blue-500/20" : "text-neutral-400 hover:text-white hover:bg-white/15"
          }`}
          title={showReticle ? "Hide alignment crosshair" : "Show alignment crosshair"}
          aria-label="Toggle crosshair"
        >
          <IoScanOutline size={13} />
        </button>

        <div className="w-px h-3.5 bg-white/20 my-auto mx-0.5" />

        {/* Pin / Unpin button */}
        <button
          type="button"
          onClick={handleTogglePin}
          className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-all ${
            isPinned
              ? "bg-blue-500 text-white shadow-sm"
              : "text-neutral-300 hover:text-white hover:bg-white/15"
          }`}
          title={isPinned ? "Click to unpin (follow mouse)" : "Click to pin in place (or click document)"}
          aria-label={isPinned ? "Unpin lens" : "Pin lens"}
        >
          {isPinned ? <BsPinAngleFill size={11} /> : <BsPinAngle size={11} />}
          <span>{isPinned ? "Pinned" : "Pin"}</span>
        </button>

        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center w-6 h-6 rounded-full text-neutral-400 hover:text-red-400 hover:bg-white/15 transition-colors ml-0.5"
          title="Close magnifying lens (Esc / M)"
          aria-label="Close magnifier"
        >
          <IoClose size={15} />
        </button>
      </div>
    </div>
  );
};

export default PdfMagnifierLens;
