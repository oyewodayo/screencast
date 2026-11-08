// components/video/PointerLayer.tsx
//
// The editor-drawn pointer of an "Editable pointer" recording (pointerTrack.ts), over the clip on
// screen: smoothed, sized, with click ripples, hidden while idle - painted every animation frame
// from the player's exact source time, by the same drawCursor/drawRipple the export's sprites are
// painted with. It moves and zooms with the clip's own framing (fit into the project frame, then
// mirror / crop / Ken Burns - clipFrameAffine), as export composites it before those.
import React, { useEffect, useRef, useState } from "react";
import type { Clip } from "../../utils/videoEditTypes";
import type { FrameRect } from "../../utils/videoFrameRect";
import { clipFrameAffine, containRect } from "../../utils/videoColorFilters";
import { drawCursor, drawRipple, hasPointerPath, pointerPath, pointerStateAt, rippleRadius, type PointerRecording, type PointerStyle } from "../../utils/pointerTrack";
import { sourcePixelSize } from "../../utils/screenPolish";

interface Props {
  frameRect: FrameRect;
  clips: Clip[];
  activeClipId: string | null;
  recordings: Map<string, PointerRecording | null>;
  style: PointerStyle;
  // The project frame in px (what the clips are fitted into).
  frame: { width: number; height: number } | null;
  getPlaybackState: () => { time: number; hasFrame: boolean } | null;
}

const PointerLayer: React.FC<Props> = ({ frameRect, clips, activeClipId, recordings, style, frame, getPlaybackState }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clip = clips.find((c) => c.id === activeClipId) ?? null;
  const rec = clip ? recordings.get(clip.sourcePath) ?? null : null;
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSourceSize(null);
    if (clip && hasPointerPath(rec)) void sourcePixelSize(clip.sourcePath).then((s) => !cancelled && setSourceSize(s));
    return () => {
      cancelled = true;
    };
  }, [clip?.sourcePath, rec]);

  // Everything the painter reads, kept current without restarting the loop.
  const live = useRef({ clip, rec, style, frame, sourceSize, frameRect });
  live.current = { clip, rec, style, frame, sourceSize, frameRect };
  const active = !!clip && hasPointerPath(rec) && style.show && !!frame && !!sourceSize;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    let raf = 0;
    const paint = () => {
      raf = requestAnimationFrame(paint);
      const { clip: c, rec: r, style: st, frame: f, sourceSize: src, frameRect: box } = live.current;
      const ctx = canvas.getContext("2d");
      if (!ctx || !c || !hasPointerPath(r) || !f || !src) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(box.width * dpr));
      const h = Math.max(1, Math.round(box.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      const playback = getPlaybackState();
      if (!playback) return;
      const s = playback.time;
      const state = pointerStateAt(r, pointerPath(r, st.smoothing), st, s);
      // Capture pixels -> the source picture's pixels -> its place fitted in the project frame ->
      // the clip's framing -> canvas pixels.
      const toVideo = src.width / r.width;
      const fit = containRect(f.width, f.height, src.width, src.height);
      const m = clipFrameAffine(c, (s - c.start) / Math.max(0.01, c.end - c.start));
      const px = (xCapture: number) => (m.ax * ((fit.x + xCapture * toVideo * (fit.width / src.width)) / f.width) + m.bx) * w;
      const py = (yCapture: number) => (m.ay * ((fit.y + yCapture * toVideo * (fit.height / src.height)) / f.height) + m.by) * h;
      const kx = toVideo * (fit.width / src.width / f.width) * Math.abs(m.ax) * w * st.size;
      const ky = toVideo * (fit.height / src.height / f.height) * m.ay * h * st.size;
      if (state.ripple) {
        const radius = rippleRadius(r, st);
        drawRipple(ctx, px(state.ripple.x), py(state.ripple.y), (radius * kx) / st.size, (radius * ky) / st.size, state.ripple.age, st.rippleColor);
      }
      if (state.cursorId !== -1) {
        const cursor = state.cursorId !== null ? r.cursors.get(state.cursorId) ?? null : null;
        drawCursor(ctx, cursor, r.nominalCursorHeight, px(state.x), py(state.y), kx, ky, state.opacity);
      }
    };
    raf = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(raf);
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [active, getPlaybackState]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
};

export default PointerLayer;
