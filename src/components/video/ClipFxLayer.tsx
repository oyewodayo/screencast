// components/video/ClipFxLayer.tsx
//
// Live preview of the clip effect (Clip.fx - echo, RGB split, colour cycle...) on the clip the player
// is showing: every animation frame, the player's picture as shown (its framing transform and
// filter, or GradeCanvas's graded copy) is painted into a frame-sized canvas and drawn through the
// effect (clipFx.ts) - the same functions export's clip_fx.rs mirrors - with the "vignette" colour
// preset's layer on top, where export lays it. Hidden (and idle) whenever the clip on screen has no
// effect. Transitions read this canvas (data-clip-fx) as the incoming picture, so a clip comes in
// with its effect already on, as in the export.
import React, { useEffect, useRef } from "react";
import { FrameRect } from "../../utils/videoFrameRect";
import { Clip } from "../../utils/videoEditTypes";
import { drawClipFx, drawVignette, hasClipFx } from "../../utils/clipFx";
import { paintDisplayedPicture } from "./transitionCanvas";
import { sourceToOutputOffset } from "../../utils/clipTiming";

interface ClipFxLayerProps {
  frameRect: FrameRect;
  clips: Clip[];
  activeClipId: string | null;
  getPlaybackState: () => { src: string | null; time: number; hasFrame: boolean } | null;
  getVideoElement: () => HTMLVideoElement | null;
}

const ClipFxLayer: React.FC<ClipFxLayerProps> = ({ frameRect, clips, activeClipId, getPlaybackState, getVideoElement }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clip = activeClipId ? clips.find((c) => c.id === activeClipId) : undefined;
  const fx = clip && hasClipFx(clip.fx) ? clip.fx : null;
  const picRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !clip || !fx) return;
    const vignette = clip.colorFilter?.preset === "vignette" ? clip.colorFilter.intensity : 0;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const video = getVideoElement();
      const state = getPlaybackState();
      if (!video || !state || !state.hasFrame || video.readyState < 2) return;
      const dpr = window.devicePixelRatio || 1;
      const { width: W, height: H } = frameRect;
      const w = Math.max(1, Math.round(W * dpr));
      const h = Math.max(1, Math.round(H * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      picRef.current ??= document.createElement("canvas");
      const pic = picRef.current;
      if (pic.width !== w || pic.height !== h) {
        pic.width = w;
        pic.height = h;
      }
      const pctx = pic.getContext("2d");
      const ctx = canvas.getContext("2d");
      if (!pctx || !ctx) return;
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      pctx.fillStyle = "#000";
      pctx.fillRect(0, 0, w, h);
      pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The <video>'s layout box relative to the frame's top-left (this canvas's).
      const self = canvas.getBoundingClientRect();
      const parent = (video.offsetParent ?? video.parentElement)?.getBoundingClientRect();
      const box = parent
        ? { x: parent.left + video.offsetLeft - self.left, y: parent.top + video.offsetTop - self.top, w: video.offsetWidth, h: video.offsetHeight }
        : { x: 0, y: 0, w: W, h: H };
      const graded = video.parentElement?.querySelector<HTMLCanvasElement>("canvas[data-grade-canvas]");
      const source = graded && graded.style.display !== "none" && graded.width > 0 ? graded : video;
      paintDisplayedPicture(pctx, source, box, video.style.transform, video.style.transformOrigin, video.style.filter);
      drawClipFx(ctx, fx, pic, Math.max(0, sourceToOutputOffset(clip, state.time)), w, h, W, H, dpr);
      if (vignette > 0) drawVignette(ctx, vignette, w, h);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id, clip?.start, clip?.end, clip?.speed, clip?.speedRamp, clip?.colorFilter?.preset, clip?.colorFilter?.intensity, fx?.kind, fx?.intensity, frameRect.width, frameRect.height, getPlaybackState, getVideoElement]);

  return (
    <canvas
      ref={canvasRef}
      data-clip-fx
      className="absolute pointer-events-none"
      style={{ left: 0, top: 0, width: frameRect.width, height: frameRect.height, display: fx ? "block" : "none" }}
    />
  );
};

export default ClipFxLayer;
