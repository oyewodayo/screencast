// components/docs/DocImageCropModal.tsx
//
// A dedicated full-picture crop modal for doc images, opened from DocImageView.tsx's floating
// toolbar. Structurally adapted from src/components/video/ImageOverlayCropPanel.tsx (portal-
// rendered, rAF-throttled pointer-drag pan+resize of a crop rect via setPointerCapture) - that
// pan/resize math is already fully generic over "a rect inside a displayRect" and is reused near-
// verbatim here. Unlike that panel, there's no persisted crop-fraction field to seed from: this is
// a one-shot destructive crop that produces a brand new asset file (never overwrites the
// original), so the rect always starts as the full image.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose } from "react-icons/io5";
import { computeLetterboxRect } from "../../utils/videoFrameRect";
import { cropCanvas } from "../../handlers/imageEditHandlers";
import { saveImageBytes } from "../../utils/docImagePaste";
import { preloadImage } from "../../utils/imageObjectCache";

interface CropRectPx {
  xPx: number;
  yPx: number;
  wPx: number;
  hPx: number;
}

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const MIN_CROP_FRACTION = 0.05;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

interface DocImageCropModalProps {
  docId: string;
  src: string;
  onCancel: () => void;
  onApply: (newSrc: string) => void;
}

const DocImageCropModal: React.FC<DocImageCropModalProps> = ({ docId, src, onCancel, onApply }) => {
  const [panelSize] = useState(() => ({
    width: Math.min(880, window.innerWidth * 0.85),
    height: Math.min(620, window.innerHeight * 0.75),
  }));

  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const displayRect = useMemo(
    () => (naturalSize ? computeLetterboxRect(panelSize.width, panelSize.height, naturalSize.width, naturalSize.height) : null),
    [naturalSize, panelSize]
  );

  const [rect, setRect] = useState<CropRectPx | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A plain <img src=...> tag with no crossOrigin taints any canvas it's later drawn into - every
  // toBlob()/toDataURL() on that canvas throws a SecurityError, even for this app's own asset://
  // images (see imageObjectCache.ts's preloadImage doc comment - this is a known, already-solved
  // problem elsewhere in the codebase, e.g. ImageEditor.tsx's crop/rotate/flip). preloadImage sets
  // crossOrigin="anonymous" before assigning src, giving back a decoded HTMLImageElement that's
  // safe to draw into a canvas - used as the crop's draw source, kept separate from the plain
  // <img> below (which is purely visual and never touches a canvas, so it doesn't need this).
  const [loadedImg, setLoadedImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    preloadImage(src)
      .then((img) => {
        if (cancelled) return;
        setLoadedImg(img);
        setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load image for cropping:", err);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Always seeds the full image - no prior crop to restore, unlike ImageOverlayCropPanel.
  useEffect(() => {
    if (!displayRect || rect) return;
    setRect({ xPx: 0, yPx: 0, wPx: displayRect.width, hPx: displayRect.height });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRect]);

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

  const handleReset = () => {
    if (!displayRect) return;
    setRect({ xPx: 0, yPx: 0, wPx: displayRect.width, hPx: displayRect.height });
  };

  const handleApply = async () => {
    if (!rect || !displayRect || !naturalSize || !loadedImg) return;
    if (displayRect.width <= 0 || displayRect.height <= 0) return;
    setSaving(true);
    setError(null);
    try {
      const scaleX = naturalSize.width / displayRect.width;
      const scaleY = naturalSize.height / displayRect.height;

      // cropCanvas only crops an existing canvas - the source has to be rasterized onto one at
      // natural resolution first. Drawing from `loadedImg` (crossOrigin="anonymous", via
      // preloadImage) rather than the plain display <img> below is what keeps this canvas
      // untainted.
      const full = document.createElement("canvas");
      full.width = naturalSize.width;
      full.height = naturalSize.height;
      const ctx = full.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");
      ctx.drawImage(loadedImg, 0, 0, naturalSize.width, naturalSize.height);

      const cropped = cropCanvas(full, rect.xPx * scaleX, rect.yPx * scaleY, rect.wPx * scaleX, rect.hPx * scaleY);

      const blob = await new Promise<Blob>((resolve, reject) =>
        cropped.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to encode cropped image"))), "image/png")
      );
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const newSrc = await saveImageBytes(docId, bytes, "png");
      onApply(newSrc);
    } catch (err) {
      console.error("Failed to crop image:", err);
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

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
            src={src}
            alt=""
            draggable={false}
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

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center justify-between">
          <button type="button" onClick={handleReset} className="text-xs text-white/50 hover:text-white/80">
            Reset
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onCancel} className="px-3.5 py-1.5 rounded-lg text-sm text-white/80 hover:bg-white/10">
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleApply()}
              className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Cropping…" : "Apply Crop"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default DocImageCropModal;
