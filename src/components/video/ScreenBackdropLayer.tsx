// components/video/ScreenBackdropLayer.tsx
//
// The Screen Style's frame over the preview: wallpaper, shadow and the rounded hole the edited
// picture shows through - drawn at the export's own pixel size by drawScreenBackdrop, the very
// picture the export overlays (screenStyle.ts), and scaled to the frame on screen.
import React, { useEffect, useRef } from "react";
import { drawScreenBackdrop, loadBackgroundPicture, type ScreenStyle } from "../../utils/screenStyle";

interface Props {
  style: ScreenStyle;
  // The export's frame size in px.
  frame: { width: number; height: number };
}

const ScreenBackdropLayer: React.FC<Props> = ({ style, frame }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify(style);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const paint = (picture: HTMLImageElement | null) => {
      if (cancelled) return;
      canvas.width = frame.width;
      canvas.height = frame.height;
      const ctx = canvas.getContext("2d");
      if (ctx) drawScreenBackdrop(ctx, frame.width, frame.height, style, picture);
    };
    if (style.background.kind === "image") void loadBackgroundPicture(style.background.path).then(paint);
    else paint(null);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, frame.width, frame.height]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
};

export default ScreenBackdropLayer;
