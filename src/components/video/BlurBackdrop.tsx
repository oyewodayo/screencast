// components/video/BlurBackdrop.tsx
//
// A canvas's Blur background in the player (VideoPlayer's frameBackground): the frame on screen,
// zoomed to cover it, drawn small into a canvas and blurred by CSS - what export draws around a
// clip that doesn't fill the frame (frame_fit_blur_chain: cover-scaled, boxblur, a touch darker).
// Redrawn for every new frame the video presents (requestVideoFrameCallback - playing, seeking or
// switching clips alike), from the decoder the player already has: no second <video>.
import React, { useEffect } from "react";

interface BlurBackdropProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  // The frame's size on screen, px.
  width: number;
  height: number;
  // Mounted: the player puts it where the clip's crop / Ken Burns has the picture.
  onReady: () => void;
}

// The blurred copy's resolution - it's blurred to a wash anyway.
const DRAW_WIDTH = 64;

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const BlurBackdrop: React.FC<BlurBackdropProps> = ({ videoRef, canvasRef, width, height, onReady }) => {
  const drawHeight = Math.max(2, Math.round((DRAW_WIDTH * height) / Math.max(1, width)));

  useEffect(() => {
    const video = videoRef.current as FrameCallbackVideo | null;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!video || !canvas || !ctx) return;
    onReady();
    const draw = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh || video.readyState < 2) return;
      // Cover: the middle of the frame, in the canvas's shape.
      const want = canvas.width / canvas.height;
      const sw = vw / vh > want ? vh * want : vw;
      const sh = vw / vh > want ? vh : vw / want;
      try {
        ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
      } catch {
        // A frame that can't be read (mid source switch) - the next one will be.
      }
    };
    let handle = 0;
    let stopped = false;
    const loop = () => {
      if (stopped) return;
      draw();
      handle = video.requestVideoFrameCallback?.(loop) ?? 0;
    };
    let raf = 0;
    if (typeof video.requestVideoFrameCallback === "function") loop();
    else {
      const tick = () => {
        draw();
        raf = requestAnimationFrame(tick);
      };
      tick();
    }
    // A paused seek or a new source presents a frame too, but redraw on these to be sure.
    video.addEventListener("seeked", draw);
    video.addEventListener("loadeddata", draw);
    return () => {
      stopped = true;
      if (handle) video.cancelVideoFrameCallback?.(handle);
      cancelAnimationFrame(raf);
      video.removeEventListener("seeked", draw);
      video.removeEventListener("loadeddata", draw);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, canvasRef, drawHeight]);

  // Bleeds past the frame so the blur's soft rim falls outside it (the frame clips it).
  const bleed = Math.ceil(height * 0.06);
  return (
    <canvas
      ref={canvasRef}
      width={DRAW_WIDTH}
      height={drawHeight}
      className="absolute"
      style={{ left: -bleed, top: -bleed, width: width + 2 * bleed, height: height + 2 * bleed, filter: `blur(${Math.max(4, height * 0.025)}px) brightness(0.92)` }}
    />
  );
};

export default BlurBackdrop;
