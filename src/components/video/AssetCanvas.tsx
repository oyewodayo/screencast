// components/video/AssetCanvas.tsx
//
// Live drawing of a shape/animated element (videoAssets.ts) - fills its parent box plus the
// margin effects spill into, and redraws every animation frame from `getTime`, so it stays locked
// to the player (or, in the element gallery, to a free-running clock). Drawing goes through the
// same drawAssetFrame export uses. Rotation, opacity and position are the parent's job (CSS), the
// same as for a picture overlay; flip and shadow are drawn here since they depend on the shape.
import React, { useEffect, useRef } from "react";
import { OverlayAsset, assetMarginPx, drawAssetFrame } from "../../utils/videoAssets";

interface AssetCanvasProps {
  asset: OverlayAsset;
  widthPx: number;
  heightPx: number;
  duration: number;
  // Seconds into the element's life right now - read every animation frame.
  getTime: () => number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  shadow?: boolean;
  className?: string;
}

const AssetCanvas: React.FC<AssetCanvasProps> = ({ asset, widthPx, heightPx, duration, getTime, flipHorizontal, flipVertical, shadow, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getTimeRef = useRef(getTime);
  getTimeRef.current = getTime;
  const margin = assetMarginPx(widthPx, heightPx, asset.kind);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: asset.entrance === "glitch" });
    if (!canvas || !ctx || widthPx <= 0 || heightPx <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = widthPx + 2 * margin;
    const cssH = heightPx + 2 * margin;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    let raf = 0;
    let lastTime = Number.NaN;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const t = getTimeRef.current();
      // Paused on one frame - nothing to redraw.
      if (t === lastTime) return;
      lastTime = t;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, (cssW / 2) * dpr, (cssH / 2) * dpr);
      ctx.globalAlpha = 1;
      drawAssetFrame(ctx, asset, widthPx, heightPx, t, duration, { flipHorizontal, flipVertical, shadow });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [asset, widthPx, heightPx, duration, margin, flipHorizontal, flipVertical, shadow]);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute pointer-events-none ${className ?? ""}`}
      style={{ left: -margin, top: -margin, width: widthPx + 2 * margin, height: heightPx + 2 * margin }}
    />
  );
};

export default AssetCanvas;
