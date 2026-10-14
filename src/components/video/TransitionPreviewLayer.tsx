// components/video/TransitionPreviewLayer.tsx
//
// Live preview of clip transitions. A transition plays over the START of the clip it leads into:
// for its first `d` seconds, the previous clip's frozen last frame gives way to the new clip as
// it plays (fades, wipes, slides, opens a circle...). Export renders exactly that (see
// transition_fold_step, conversion.rs: the outgoing clip is held on its last frame and the xfade
// starts where it ends), so this layer only has to draw one thing on top of the player: that
// frozen frame, animated out.
//
// - The frozen frame is captured once per transition from the outgoing clip's own preview source
//   (clipPreviewSource.ts - so an image is its letterboxed proxy, exactly what the player showed)
//   by seeking a detached <video> to the clip's last frame and drawing it to a canvas. Captured
//   ahead of time for the NEXT transition too, so it's ready the moment playback crosses over.
// - It's laid out over the player's whole <video> box with the outgoing clip's own end-state look
//   (crop, Ken Burns at its end, mirror, color grade - clipFrameStyle), so it lines up pixel for
//   pixel with the frame it replaces.
// - Progress comes from the player's real currentTime every animation frame (getPlaybackState),
//   written straight to the DOM rather than through React state. Until the player has actually
//   swapped to the new clip's source and decoded a frame, the frozen frame stays fully opaque -
//   which also hides the source swap itself.
import React, { useEffect, useRef, useState } from "react";
import { FrameRect } from "../../utils/videoFrameRect";
import { Clip, LeakDirection, TransitionLook, TransitionType } from "../../utils/videoEditTypes";
import { clipFrameStyle } from "../../utils/videoColorFilters";
import { hasGrade, sampleLut } from "../../utils/colorGrade";
import { clipOutputDuration, sourceToOutputOffset } from "../../utils/clipTiming";
import { bakedLutForGrade } from "../../utils/gradeLuts";

interface TransitionPreviewLayerProps {
  frameRect: FrameRect;
  clips: Clip[];
  // The clip the player is showing right now (VideoTimelineDocker's onActiveClipChange).
  activeClipId: string | null;
  getPlaybackState: () => { src: string | null; time: number; hasFrame: boolean } | null;
  // What the player loads for a clip's source (Dashboard's resolveTimelineClipUrl) - compared
  // against the player's own src to know whether it has swapped to the incoming clip yet.
  resolveClipUrl: (sourcePath: string) => Promise<string>;
}

// Same clamp as transition_fold_step: at most 90% of the clip it plays over.
export function transitionDuration(clip: Clip): number {
  const own = clipOutputDuration(clip);
  return Math.max(0.05, Math.min(clip.transitionIn?.duration ?? 0, own * 0.9));
}

const hasTransition = (clip: Clip | undefined): clip is Clip => !!clip?.transitionIn && clip.transitionIn.duration > 0;

// Last frame of the outgoing clip, by source URL + source time. A handful at most stay alive.
const frameCache = new Map<string, Promise<HTMLCanvasElement>>();
const FRAME_CACHE_MAX = 8;

function captureFrame(url: string, time: number): Promise<HTMLCanvasElement> {
  const key = `${url}|${time.toFixed(3)}`;
  let pending = frameCache.get(key);
  if (pending) return pending;
  pending = new Promise<HTMLCanvasElement>((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous"; // same as the main player's <video>
    const finish = (error?: string) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load(); // releases the decoder
      if (error) reject(new Error(error));
    };
    const timer = setTimeout(() => finish("Timed out capturing a transition frame"), 15000);
    video.addEventListener("error", () => finish("Couldn't load the clip for its transition frame"), { once: true });
    video.addEventListener(
      "loadedmetadata",
      () => {
        video.addEventListener(
          "seeked",
          () => {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth || 2;
            canvas.height = video.videoHeight || 2;
            canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
            finish();
            resolve(canvas);
          },
          { once: true }
        );
        video.currentTime = Math.max(0, Math.min(time, video.duration - 0.05));
      },
      { once: true }
    );
    video.src = url;
  });
  pending.catch(() => frameCache.delete(key));
  frameCache.set(key, pending);
  if (frameCache.size > FRAME_CACHE_MAX) frameCache.delete(frameCache.keys().next().value!);
  return pending;
}

// The outgoing clip's last frame with its color grade applied - the frozen frame stands in for what
// the player was showing, which (for a graded clip) was GradeCanvas's graded picture. Same baked
// LUT, applied per pixel once per capture.
const gradedFrameCache = new Map<string, Promise<HTMLCanvasElement>>();
function gradedFrame(url: string, time: number, grade: Clip["grade"]): Promise<HTMLCanvasElement> {
  if (!hasGrade(grade)) return captureFrame(url, time);
  const key = `${url}|${time.toFixed(3)}|${JSON.stringify(grade)}`;
  let pending = gradedFrameCache.get(key);
  if (!pending) {
    pending = Promise.all([captureFrame(url, time), bakedLutForGrade(grade)]).then(([raw, lut]) => {
      if (!lut) return raw;
      const canvas = document.createElement("canvas");
      canvas.width = raw.width;
      canvas.height = raw.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(raw, 0, 0);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = image.data;
      for (let i = 0; i < px.length; i += 4) {
        const [r, g, b] = sampleLut(lut, px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
        px[i] = r * 255;
        px[i + 1] = g * 255;
        px[i + 2] = b * 255;
      }
      ctx.putImageData(image, 0, 0);
      return canvas;
    });
    pending.catch(() => gradedFrameCache.delete(key));
    gradedFrameCache.set(key, pending);
    if (gradedFrameCache.size > FRAME_CACHE_MAX) gradedFrameCache.delete(gradedFrameCache.keys().next().value!);
  }
  return pending;
}

// One frame before the outgoing clip's own end, in its source time.
const lastFrameTime = (clip: Clip): number => Math.max(clip.start, clip.end - 1 / 30);

const PIXELIZE_MAX_BLOCK_PX = 40;

// A light leak's hot spot at progress p, as fractions of the frame - the same path
// transition_glow_filter (conversion.rs) gives ffmpeg.
function leakSpot(direction: LeakDirection | undefined, p: number): [number, number] {
  const sweep = -0.2 + 1.4 * p;
  switch (direction) {
    case "left":
      return [1.2 - 1.4 * p, 0.35];
    case "down":
      return [0.4, sweep];
    case "up":
      return [0.4, 1.2 - 1.4 * p];
    case "diagonal":
      return [sweep, sweep];
    case "center":
      return [0.5, 0.5];
    default:
      return [sweep, 0.35];
  }
}

const withAlpha = (hex: string, alpha: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

const TransitionPreviewLayer: React.FC<TransitionPreviewLayerProps> = ({ frameRect, clips, activeClipId, getPlaybackState, resolveClipUrl }) => {
  const activeIndex = activeClipId ? clips.findIndex((clip) => clip.id === activeClipId) : -1;
  const incoming = activeIndex > 0 && hasTransition(clips[activeIndex]) ? clips[activeIndex] : null;
  const outgoing = incoming ? clips[activeIndex - 1] : null;

  const [frame, setFrame] = useState<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const [incomingUrl, setIncomingUrl] = useState<{ clipId: string; url: string } | null>(null);
  const frameKey = outgoing && incoming ? `${incoming.id}|${outgoing.sourcePath}|${lastFrameTime(outgoing)}|${JSON.stringify(outgoing.grade ?? null)}` : null;

  // Capture (or reuse) the frozen frame for the transition on screen now, and warm the one after.
  useEffect(() => {
    let cancelled = false;
    if (outgoing && incoming && frameKey) {
      resolveClipUrl(outgoing.sourcePath)
        .then((url) => gradedFrame(url, lastFrameTime(outgoing), outgoing.grade))
        .then((canvas) => !cancelled && setFrame({ key: frameKey, canvas }))
        .catch((err) => console.error("Transition preview: couldn't capture the outgoing frame", err));
      resolveClipUrl(incoming.sourcePath)
        .then((url) => !cancelled && setIncomingUrl({ clipId: incoming.id, url }))
        .catch(() => {});
    }
    const current = activeIndex >= 0 ? clips[activeIndex] : undefined;
    if (current && hasTransition(clips[activeIndex + 1])) {
      resolveClipUrl(current.sourcePath)
        .then((url) => gradedFrame(url, lastFrameTime(current), current.grade))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey, activeIndex, clips[activeIndex]?.id, clips[activeIndex]?.end, clips[activeIndex + 1]?.transitionIn?.type, resolveClipUrl]);

  const moverRef = useRef<HTMLDivElement>(null);
  const blackRef = useRef<HTMLDivElement>(null);
  // Light leak / flash glow, over everything (see transition_glow_filter, conversion.rs).
  const glowRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const pixelCanvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const readyCanvas = frame && frame.key === frameKey ? frame.canvas : null;

  // The captured canvas is a real DOM node (drawn once, never re-rendered) - mounted by hand.
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host || !readyCanvas) return;
    readyCanvas.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
    host.replaceChildren(readyCanvas);
    return () => {
      host.replaceChildren();
    };
  }, [readyCanvas]);

  // Container (= the player's <video> box) size: frameRect is the letterboxed picture centered in it.
  const containerW = frameRect.width + 2 * frameRect.left;
  const containerH = frameRect.height + 2 * frameRect.top;

  useEffect(() => {
    const root = rootRef.current;
    const mover = moverRef.current;
    const black = blackRef.current;
    const glow = glowRef.current;
    if (!incoming || !readyCanvas || !root || !mover || !black || !glow) return;
    const type: TransitionType = incoming.transitionIn!.type;
    const look: TransitionLook = incoming.transitionIn!.look ?? {};
    const strength = Math.max(0.1, Math.min(1.5, look.intensity ?? 1));
    const duration = transitionDuration(incoming);
    const expectedUrl = incomingUrl?.clipId === incoming.id ? incomingUrl.url : null;
    const { left: L, top: T, width: W, height: H } = frameRect;
    const R = containerW - L - W;
    const B = containerH - T - H;
    const cx = L + W / 2;
    const cy = T + H / 2;

    const show = (visible: boolean) => {
      root.style.display = visible ? "" : "none";
    };
    const render = (p: number) => {
      mover.style.opacity = "1";
      mover.style.transform = "";
      mover.style.transformOrigin = "";
      mover.style.clipPath = "";
      mover.style.setProperty("mask-image", "");
      mover.style.setProperty("-webkit-mask-image", "");
      mover.style.filter = "";
      black.style.opacity = "0";
      glow.style.opacity = "0";
      glow.style.mixBlendMode = "screen";
      const pixel = pixelCanvasRef.current;
      if (pixel) pixel.style.display = "none";
      switch (type) {
        case "fadeblack":
          // Out to black over the first half, black out over the second (xfade fadeblack).
          if (p < 0.5) black.style.opacity = String(p * 2);
          else {
            mover.style.opacity = "0";
            black.style.opacity = String(2 - p * 2);
          }
          break;
        case "fadewhite": {
          const color = look.color ?? "#ffffff";
          if (color.toLowerCase() === "#ffffff" && look.intensity === undefined) {
            // Out to white over the first half, white out over the second (xfade fadewhite).
            glow.style.background = "#ffffff";
            if (p < 0.5) glow.style.opacity = String(p * 2);
            else {
              mover.style.opacity = "0";
              glow.style.opacity = String(2 - p * 2);
            }
          } else {
            // Crossfade washed in the flash colour at its peak (the export's glow pass).
            mover.style.opacity = String(1 - p);
            glow.style.background = color;
            glow.style.mixBlendMode = color.toLowerCase() === "#000000" ? "normal" : "screen";
            glow.style.opacity = String(Math.min(1, strength * Math.sin(Math.PI * p)));
          }
          break;
        }
        case "lightleak": {
          // Crossfade under a coloured burn whose hot spot travels across, white-hot at its peak.
          mover.style.opacity = String(1 - p);
          const [sx, sy] = leakSpot(look.direction, p);
          const size = Math.max(0.3, Math.min(2.5, look.size ?? 1));
          const color = look.color ?? "#ff7a2e";
          glow.style.background = [
            `radial-gradient(ellipse ${0.83 * size * W}px ${0.83 * size * H}px at ${sx * 100}% ${sy * 100}%, rgba(255,252,240,1) 0%, ${withAlpha(color, 0.95)} 35%, ${withAlpha(color, 0)} 100%)`,
            `linear-gradient(${withAlpha(color, 0.5)}, ${withAlpha(color, 0.5)})`,
          ].join(", ");
          glow.style.opacity = String(Math.min(1, Math.sin(Math.PI * p) * 1.15 * strength));
          break;
        }
        case "whip": {
          // A sideways smear through a white flash.
          mover.style.opacity = String(1 - p);
          mover.style.transform = `translateX(${-W * 0.3 * p}px)`;
          mover.style.filter = `blur(${Math.sin(Math.PI * p) * W * 0.03}px)`;
          glow.style.background = "#ffffff";
          glow.style.opacity = String(Math.min(1, 0.8 * strength * Math.sin(Math.PI * p) ** 2));
          break;
        }
        case "horzopen": {
          // The incoming clip opens out of a line through the middle - horizontal, or vertical (doors).
          const vertical = look.orientation === "vertical";
          const span = vertical ? W : H;
          const mid = vertical ? cx : cy;
          const soft = span * 0.04;
          const band = p * (span / 2 + soft);
          const a = mid - band;
          const b = mid + band;
          const mask = `linear-gradient(to ${vertical ? "right" : "bottom"}, #000 ${a}px, transparent ${a + soft}px, transparent ${Math.max(a + soft, b - soft)}px, #000 ${b}px)`;
          mover.style.setProperty("mask-image", mask);
          mover.style.setProperty("-webkit-mask-image", mask);
          break;
        }
        case "wipeleft":
          mover.style.clipPath = `inset(${T}px ${R + W * p}px ${B}px ${L}px)`;
          break;
        case "wiperight":
          mover.style.clipPath = `inset(${T}px ${R}px ${B}px ${L + W * p}px)`;
          break;
        case "slideleft":
          mover.style.transform = `translateX(${-W * p}px)`;
          break;
        case "slideright":
          mover.style.transform = `translateX(${W * p}px)`;
          break;
        case "circleopen": {
          const radius = (p * Math.hypot(W, H)) / 2;
          const mask = `radial-gradient(circle at ${cx}px ${cy}px, transparent ${radius}px, #000 ${radius + 1}px)`;
          mover.style.setProperty("mask-image", mask);
          mover.style.setProperty("-webkit-mask-image", mask);
          break;
        }
        case "radial": {
          const angle = p * 360;
          const mask = `conic-gradient(from 0deg at ${cx}px ${cy}px, transparent ${angle}deg, #000 ${angle}deg)`;
          mover.style.setProperty("mask-image", mask);
          mover.style.setProperty("-webkit-mask-image", mask);
          break;
        }
        case "zoomin":
          mover.style.transformOrigin = `${cx}px ${cy}px`;
          mover.style.transform = `scale(${1 + p})`;
          mover.style.opacity = String(1 - p);
          break;
        case "pixelize": {
          // Coarsens toward the midpoint, then hands over to the new clip.
          if (p >= 0.5 || !pixel) {
            mover.style.opacity = "0";
            break;
          }
          const block = 1 + (PIXELIZE_MAX_BLOCK_PX - 1) * (p * 2);
          const w = Math.max(1, Math.round(W / block));
          const h = Math.max(1, Math.round(H / block));
          if (pixel.width !== w || pixel.height !== h) {
            pixel.width = w;
            pixel.height = h;
          }
          pixel.getContext("2d")?.drawImage(readyCanvas, 0, 0, w, h);
          pixel.style.display = "block";
          break;
        }
        default:
          // fade, dissolve
          mover.style.opacity = String(1 - p);
      }
    };

    let raf = 0;
    const tick = () => {
      const state = getPlaybackState();
      let progress: number | null = null;
      if (state) {
        // Not swapped to the incoming clip yet (or no frame decoded) - hold the frozen frame.
        if (!expectedUrl || state.src !== expectedUrl || !state.hasFrame) progress = 0;
        else progress = sourceToOutputOffset(incoming, state.time) / duration;
      }
      if (progress === null || progress >= 1 || progress < -0.05) show(false);
      else {
        show(true);
        render(Math.max(0, progress));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [incoming, readyCanvas, incomingUrl, frameRect.left, frameRect.top, frameRect.width, frameRect.height, containerW, containerH, getPlaybackState]);

  if (!incoming || !outgoing || !readyCanvas) return null;
  const { left: L, top: T, width: W, height: H } = frameRect;
  // The transformed box is the whole <video> box, centred on the frame - offsets in frame px.
  const look = clipFrameStyle(outgoing, 1, { width: W, height: H });
  return (
    <div
      ref={rootRef}
      className="absolute pointer-events-none"
      // The player's whole <video> box, clipped to the picture - the export frame.
      style={{ left: -L, top: -T, width: containerW, height: containerH, display: "none", clipPath: `inset(${T}px ${L}px ${T}px ${L}px)` }}
    >
      <div ref={moverRef} className="absolute inset-0">
        <div className="absolute inset-0" style={{ transform: look.transform || undefined, filter: look.filter || undefined }}>
          <div ref={canvasHostRef} className="absolute inset-0" />
          <canvas
            ref={pixelCanvasRef}
            className="absolute"
            style={{ left: L, top: T, width: W, height: H, imageRendering: "pixelated", display: "none" }}
          />
        </div>
      </div>
      <div ref={blackRef} className="absolute bg-black" style={{ left: L, top: T, width: W, height: H, opacity: 0 }} />
      <div ref={glowRef} className="absolute" style={{ left: L, top: T, width: W, height: H, opacity: 0, mixBlendMode: "screen" }} />
    </div>
  );
};

export default TransitionPreviewLayer;
