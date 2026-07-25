// components/video/ImageOverlayCropPanel.tsx
//
// The dedicated crop mode opened from an image overlay's style panel (see VideoOverlayLayer.tsx's
// "Crop" button) - a distinct full-picture view with a draggable/resizable crop rectangle, rather
// than more handles bolted onto the overlay's own (often small) box on the video frame. Portal-
// rendered to document.body, same reason the context menu elsewhere in this file already is: it
// needs to sit above everything, including .video-container's own overflow:hidden clipping.
//
// Nothing is written to the store until Apply - Cancel/backdrop-click discards this panel's local
// rect entirely, mirroring the "stage locally, commit once" shape the rest of this file's editing
// sessions already use (see VideoOverlayLayer's own top comment on the text-overlay session model).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose } from "react-icons/io5";
import { convertFileSrc } from "@tauri-apps/api/tauri";
import { ImageOverlay } from "../../utils/videoEditTypes";
import { computeLetterboxRect } from "../../utils/videoFrameRect";

interface CropRectPx {
  xPx: number;
  yPx: number;
  wPx: number;
  hPx: number;
}

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
// Smaller than this (as a fraction of the displayed image's shorter side) and the crop rect stops
// being a meaningfully draggable/visible target, and risks producing a degenerate near-zero-size
// exported region.
const MIN_CROP_FRACTION = 0.05;

interface ImageOverlayCropPanelProps {
  overlay: ImageOverlay;
  onCancel: () => void;
  onApply: (crop: { cropX: number; cropY: number; cropWidth: number; cropHeight: number }) => void;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const ImageOverlayCropPanel: React.FC<ImageOverlayCropPanelProps> = ({ overlay, onCancel, onApply }) => {
  const imageSrc = useMemo(() => convertFileSrc(overlay.src), [overlay.src]);

  // Fixed at mount rather than tracked via ResizeObserver - this is a modal-like one-shot tool, not
  // a persistent layout piece, so it doesn't need to react to the window resizing mid-crop the way
  // the main video frame does.
  const [panelSize] = useState(() => ({
    width: Math.min(880, window.innerWidth * 0.85),
    height: Math.min(620, window.innerHeight * 0.75),
  }));

  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const displayRect = useMemo(
    () => (naturalSize ? computeLetterboxRect(panelSize.width, panelSize.height, naturalSize.width, naturalSize.height) : null),
    [naturalSize, panelSize]
  );

  // The committed crop rect (display px, relative to displayRect's own top-left) - what Apply
  // reads. Live drag state below overrides this only for rendering while a drag is in progress;
  // this itself only updates once a drag actually ends.
  const [rect, setRect] = useState<CropRectPx | null>(null);

  // Seeds the initial rect from the overlay's existing crop (or the full image, if never cropped)
  // the moment the display geometry becomes known - runs once per panel open, not on every
  // subsequent naturalSize/displayRect recompute (there isn't one; both are derived once the image
  // loads and never change again for the lifetime of this panel).
  useEffect(() => {
    if (!displayRect || rect) return;
    const cropX = overlay.cropX ?? 0;
    const cropY = overlay.cropY ?? 0;
    const cropWidth = overlay.cropWidth ?? 1;
    const cropHeight = overlay.cropHeight ?? 1;
    setRect({
      xPx: cropX * displayRect.width,
      yPx: cropY * displayRect.height,
      wPx: cropWidth * displayRect.width,
      hPx: cropHeight * displayRect.height,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRect]);

  // ---- Pan (drag the rect's body) and resize (drag a corner) - both rAF-throttled the same way
  // image drag/resize/rotate already are elsewhere in VideoOverlayLayer.tsx: raw pointermove events
  // outrun the display's own paint budget, so only the *latest* position is kept between frames.

  const [panDrag, setPanDrag] = useState<null | { startClientX: number; startClientY: number; startRect: CropRectPx; liveRect: CropRectPx }>(null);
  const panRafRef = useRef<number | null>(null);
  const panLatestRef = useRef<{ clientX: number; clientY: number } | null>(null);

  const [resizeDrag, setResizeDrag] = useState<null | { corner: Corner; startClientX: number; startClientY: number; startRect: CropRectPx; liveRect: CropRectPx }>(
    null
  );
  const resizeRafRef = useRef<number | null>(null);
  const resizeLatestRef = useRef<{ clientX: number; clientY: number } | null>(null);

  useEffect(() => {
    return () => {
      if (panRafRef.current != null) cancelAnimationFrame(panRafRef.current);
      if (resizeRafRef.current != null) cancelAnimationFrame(resizeRafRef.current);
    };
  }, []);

  const beginPan = (e: React.PointerEvent) => {
    if (!rect) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setPanDrag({ startClientX: e.clientX, startClientY: e.clientY, startRect: rect, liveRect: rect });
  };
  const handlePanMove = (e: React.PointerEvent) => {
    if (!panDrag || !displayRect) return;
    e.stopPropagation();
    panLatestRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (panRafRef.current != null) return;
    panRafRef.current = requestAnimationFrame(() => {
      panRafRef.current = null;
      const latest = panLatestRef.current;
      if (!latest) return;
      setPanDrag((prev) => {
        if (!prev) return prev;
        const dx = latest.clientX - prev.startClientX;
        const dy = latest.clientY - prev.startClientY;
        const xPx = clamp(prev.startRect.xPx + dx, 0, displayRect.width - prev.startRect.wPx);
        const yPx = clamp(prev.startRect.yPx + dy, 0, displayRect.height - prev.startRect.hPx);
        return { ...prev, liveRect: { ...prev.startRect, xPx, yPx } };
      });
    });
  };
  const endPan = () => {
    if (!panDrag) return;
    if (panRafRef.current != null) {
      cancelAnimationFrame(panRafRef.current);
      panRafRef.current = null;
    }
    setRect(panDrag.liveRect);
    setPanDrag(null);
  };

  const beginResize = (corner: Corner) => (e: React.PointerEvent) => {
    if (!rect) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setResizeDrag({ corner, startClientX: e.clientX, startClientY: e.clientY, startRect: rect, liveRect: rect });
  };
  const handleResizeMove = (e: React.PointerEvent) => {
    if (!resizeDrag || !displayRect) return;
    e.stopPropagation();
    resizeLatestRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (resizeRafRef.current != null) return;
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = null;
      const latest = resizeLatestRef.current;
      if (!latest) return;
      setResizeDrag((prev) => {
        if (!prev) return prev;
        const dx = latest.clientX - prev.startClientX;
        const dy = latest.clientY - prev.startClientY;
        const { corner, startRect } = prev;
        const minSize = Math.min(displayRect.width, displayRect.height) * MIN_CROP_FRACTION;

        let { xPx, wPx } = startRect;
        if (corner === "nw" || corner === "sw") {
          const newX = clamp(startRect.xPx + dx, 0, startRect.xPx + startRect.wPx - minSize);
          wPx = startRect.wPx + (startRect.xPx - newX);
          xPx = newX;
        } else {
          const newRight = clamp(startRect.xPx + startRect.wPx + dx, startRect.xPx + minSize, displayRect.width);
          wPx = newRight - startRect.xPx;
        }

        let { yPx, hPx } = startRect;
        if (corner === "nw" || corner === "ne") {
          const newY = clamp(startRect.yPx + dy, 0, startRect.yPx + startRect.hPx - minSize);
          hPx = startRect.hPx + (startRect.yPx - newY);
          yPx = newY;
        } else {
          const newBottom = clamp(startRect.yPx + startRect.hPx + dy, startRect.yPx + minSize, displayRect.height);
          hPx = newBottom - startRect.yPx;
        }

        return { ...prev, liveRect: { xPx, yPx, wPx, hPx } };
      });
    });
  };
  const endResize = () => {
    if (!resizeDrag) return;
    if (resizeRafRef.current != null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }
    setRect(resizeDrag.liveRect);
    setResizeDrag(null);
  };

  const liveRect = panDrag?.liveRect ?? resizeDrag?.liveRect ?? rect;

  const handleReset = useCallback(() => {
    if (!displayRect) return;
    setRect({ xPx: 0, yPx: 0, wPx: displayRect.width, hPx: displayRect.height });
  }, [displayRect]);

  const handleApply = useCallback(() => {
    if (!rect || !displayRect || displayRect.width <= 0 || displayRect.height <= 0) return;
    onApply({
      cropX: rect.xPx / displayRect.width,
      cropY: rect.yPx / displayRect.height,
      cropWidth: rect.wPx / displayRect.width,
      cropHeight: rect.hPx / displayRect.height,
    });
  }, [rect, displayRect, onApply]);

  const cornerCursor: Record<Corner, string> = { nw: "cursor-nwse-resize", se: "cursor-nwse-resize", ne: "cursor-nesw-resize", sw: "cursor-nesw-resize" };
  const cornerPositionClass: Record<Corner, string> = {
    nw: "-left-1.5 -top-1.5",
    ne: "-right-1.5 -top-1.5",
    sw: "-left-1.5 -bottom-1.5",
    se: "-right-1.5 -bottom-1.5",
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="flex flex-col gap-3 p-4 rounded-2xl bg-neutral-900 ring-1 ring-white/10 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-6">
          <h3 className="text-sm font-semibold text-white">Crop image</h3>
          <button type="button" title="Close" onClick={onCancel} className="p-1 rounded-full hover:bg-white/10 text-white/60 hover:text-white">
            <IoClose size={16} />
          </button>
        </div>

        <div className="relative flex items-center justify-center" style={{ width: panelSize.width, height: panelSize.height }}>
          <img
            src={imageSrc}
            alt=""
            draggable={false}
            onLoad={(e) => {
              if (!naturalSize) setNaturalSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
            }}
            className="select-none pointer-events-none"
            style={
              displayRect
                ? { position: "absolute", left: displayRect.left, top: displayRect.top, width: displayRect.width, height: displayRect.height }
                : { position: "absolute", opacity: 0, width: 1, height: 1 }
            }
          />

          {!naturalSize && <span className="text-white/50 text-sm">Loading picture…</span>}

          {displayRect && liveRect && (
            <div style={{ position: "absolute", left: displayRect.left, top: displayRect.top, width: displayRect.width, height: displayRect.height }}>
              {/* Dims everything outside the crop rect via four bands, rather than a clip-path
                  polygon - simpler to keep exactly in sync with a rect that's being live-dragged
                  every frame. */}
              <div className="absolute bg-black/60" style={{ left: 0, top: 0, right: 0, height: liveRect.yPx }} />
              <div className="absolute bg-black/60" style={{ left: 0, top: liveRect.yPx + liveRect.hPx, right: 0, bottom: 0 }} />
              <div className="absolute bg-black/60" style={{ left: 0, top: liveRect.yPx, width: liveRect.xPx, height: liveRect.hPx }} />
              <div className="absolute bg-black/60" style={{ left: liveRect.xPx + liveRect.wPx, top: liveRect.yPx, right: 0, height: liveRect.hPx }} />

              <div
                onPointerDown={beginPan}
                onPointerMove={handlePanMove}
                onPointerUp={endPan}
                onPointerCancel={endPan}
                title="Drag to move"
                className="absolute outline outline-2 outline-white cursor-move"
                style={{ left: liveRect.xPx, top: liveRect.yPx, width: liveRect.wPx, height: liveRect.hPx }}
              >
                {CORNERS.map((corner) => (
                  <div
                    key={corner}
                    onPointerDown={beginResize(corner)}
                    onPointerMove={handleResizeMove}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    title="Drag to resize"
                    className={`absolute w-3.5 h-3.5 rounded-full bg-amber-400 hover:bg-amber-300 ring-2 ring-white/80 ${cornerPositionClass[corner]} ${cornerCursor[corner]}`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <button type="button" onClick={handleReset} className="text-xs text-white/50 hover:text-white/80">
            Reset
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onCancel} className="px-3.5 py-1.5 rounded-lg text-sm text-white/80 hover:bg-white/10">
              Cancel
            </button>
            <button type="button" onClick={handleApply} className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700">
              Apply Crop
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ImageOverlayCropPanel;
