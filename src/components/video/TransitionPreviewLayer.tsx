// components/video/TransitionPreviewLayer.tsx
//
// Live preview of clip transitions. A transition plays over the START of the clip it leads into:
// for its first `d` seconds, the previous clip gives way to the new clip as both play (fades,
// wipes, slides, opens a circle...). The outgoing clip keeps PLAYING past its own out-point - its
// tail handle, the source media after the cut - exactly as export renders it (transition_tail,
// conversion.rs), so the timeline's length never changes and nothing freezes. Stills (images) and
// stabilized clips hold their last frame instead, in both places. This layer only has to draw one
// thing on top of the player: that outgoing picture, animated out.
//
// - The moving tail is a pooled, pre-warmed <video> of the outgoing clip's source (tailVideo),
//   seeked to the clip's out-point while the clip is still playing, then run in step with the
//   player every frame - same rate as the clip's end speed, re-synced on drift, paused and seeked
//   with the player when scrubbing. It's shown only once it's actually on the right frame.
// - Underneath it, always: the outgoing clip's last frame, captured once per transition from its
//   own preview source (clipPreviewSource.ts - so an image is its letterboxed proxy, exactly what
//   the player showed) by seeking a detached <video> and drawing it to a canvas. That's the whole
//   picture for a still, and the instant fallback while the tail is still seeking.
// - It's laid out over the player's whole <video> box with the outgoing clip's own end-state look
//   (crop, Ken Burns at its end, mirror, color grade - clipFrameStyle), so it lines up pixel for
//   pixel with the frame it replaces.
// - Progress comes from the player's real currentTime every animation frame (getPlaybackState),
//   written straight to the DOM rather than through React state. Until the player has actually
//   swapped to the new clip's source and decoded a frame, the frozen frame stays fully opaque -
//   which also hides the source swap itself.
import React, { useEffect, useRef, useState } from "react";
import { FrameRect } from "../../utils/videoFrameRect";
import { Clip, TransitionLook, TransitionType, isImageClipPath } from "../../utils/videoEditTypes";
import { renderTransitionFrame } from "./transitionFrame";
import { TransitionPictures, isCanvasTransition, paintDisplayedPicture } from "./transitionCanvas";
import { clipFrameStyle } from "../../utils/videoColorFilters";
import { Lut3D, hasGrade, sampleLut } from "../../utils/colorGrade";
import { clipOutputDuration, sourceToOutputOffset, speedAtSource } from "../../utils/clipTiming";
import { bakedLutForGrade } from "../../utils/gradeLuts";
import GradeCanvas from "./GradeCanvas";

interface TransitionPreviewLayerProps {
  frameRect: FrameRect;
  clips: Clip[];
  // The clip the player is showing right now (VideoTimelineDocker's onActiveClipChange).
  activeClipId: string | null;
  getPlaybackState: () => { src: string | null; time: number; hasFrame: boolean; paused: boolean } | null;
  // The player's <video> - the incoming clip as shown, for transitions that move it too.
  getVideoElement?: () => HTMLVideoElement | null;
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

// Whether the outgoing clip plays on through the transition (its tail handle) rather than holding
// its last frame - the same rule export applies (transition_tail, conversion.rs).
export const hasMovingTail = (clip: Clip): boolean => !isImageClipPath(clip.sourcePath) && !clip.stabilize;

// The outgoing clip's speed at its out-point - the rate its tail keeps playing at.
const tailSpeed = (clip: Clip): number => Math.max(0.0625, Math.min(16, speedAtSource(clip, Math.max(clip.start, clip.end - 1e-3))));

// Detached tail players, by source URL + out-point: created (and seeked to the out-point) while the
// outgoing clip is still on screen, so the tail is decoded and waiting when playback crosses over.
const tailPool = new Map<string, HTMLVideoElement>();
const TAIL_POOL_MAX = 3;

function tailVideo(url: string, start: number): HTMLVideoElement {
  const key = `${url}|${start.toFixed(3)}`;
  let video = tailPool.get(key);
  if (!video) {
    video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    video.crossOrigin = "anonymous"; // same as the main player - GradeCanvas reads its frames
    video.src = url;
    video.currentTime = start;
    tailPool.set(key, video);
    for (const [k, old] of tailPool) {
      if (tailPool.size <= TAIL_POOL_MAX) break;
      if (old.isConnected) continue;
      old.removeAttribute("src");
      old.load(); // releases the decoder
      tailPool.delete(k);
    }
  }
  return video;
}

// A reusable canvas the size of the frame in device pixels, cleared to black, scaled to frame px.
function framePictureContext(canvas: HTMLCanvasElement, W: number, H: number, dpr: number): CanvasRenderingContext2D | null {
  const w = Math.max(1, Math.round(W * dpr));
  const h = Math.max(1, Math.round(H * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// GradeCanvas's graded copy of a <video>, when it's the one being shown.
const shownGradeCanvas = (scope: Element | null | undefined): HTMLCanvasElement | null => {
  const canvas = scope?.querySelector<HTMLCanvasElement>("canvas[data-grade-canvas]");
  return canvas && canvas.style.display !== "none" && canvas.width > 0 ? canvas : null;
};

const TransitionPreviewLayer: React.FC<TransitionPreviewLayerProps> = ({ frameRect, clips, activeClipId, getPlaybackState, getVideoElement, resolveClipUrl }) => {
  const activeIndex = activeClipId ? clips.findIndex((clip) => clip.id === activeClipId) : -1;
  const incoming = activeIndex > 0 && hasTransition(clips[activeIndex]) ? clips[activeIndex] : null;
  const outgoing = incoming ? clips[activeIndex - 1] : null;

  const [frame, setFrame] = useState<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const [incomingUrl, setIncomingUrl] = useState<{ clipId: string; url: string } | null>(null);
  const [tail, setTail] = useState<{ key: string; video: HTMLVideoElement } | null>(null);
  // The outgoing clip's grade as a LUT, for the moving tail (GradeCanvas) - the frozen frame bakes
  // it in on capture.
  const [tailLut, setTailLut] = useState<{ key: string; lut: Lut3D | null } | null>(null);
  const frameKey = outgoing && incoming ? `${incoming.id}|${outgoing.sourcePath}|${lastFrameTime(outgoing)}|${JSON.stringify(outgoing.grade ?? null)}` : null;
  const moving = !!outgoing && hasMovingTail(outgoing);

  // Capture (or reuse) the frozen frame for the transition on screen now, and warm the one after.
  useEffect(() => {
    let cancelled = false;
    if (outgoing && incoming && frameKey) {
      resolveClipUrl(outgoing.sourcePath)
        .then((url) => {
          if (!cancelled && hasMovingTail(outgoing)) setTail({ key: frameKey, video: tailVideo(url, outgoing.end) });
          return gradedFrame(url, lastFrameTime(outgoing), outgoing.grade);
        })
        .then((canvas) => !cancelled && setFrame({ key: frameKey, canvas }))
        .catch((err) => console.error("Transition preview: couldn't capture the outgoing frame", err));
      if (hasMovingTail(outgoing)) {
        (hasGrade(outgoing.grade) ? bakedLutForGrade(outgoing.grade) : Promise.resolve(null))
          .then((lut) => !cancelled && setTailLut({ key: frameKey, lut }))
          .catch(() => !cancelled && setTailLut({ key: frameKey, lut: null }));
      }
      resolveClipUrl(incoming.sourcePath)
        .then((url) => !cancelled && setIncomingUrl({ clipId: incoming.id, url }))
        .catch(() => {});
    }
    const current = activeIndex >= 0 ? clips[activeIndex] : undefined;
    if (current && hasTransition(clips[activeIndex + 1])) {
      resolveClipUrl(current.sourcePath)
        .then((url) => {
          if (hasMovingTail(current)) tailVideo(url, current.end);
          return gradedFrame(url, lastFrameTime(current), current.grade);
        })
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
  // Drawn transition layers (page curl, colour sweep), over everything.
  const fxCanvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Both pictures as shown, for the transitions that move both (transitionCanvas.ts).
  const oldPicRef = useRef<HTMLCanvasElement | null>(null);
  const newPicRef = useRef<HTMLCanvasElement | null>(null);
  const readyCanvas = frame && frame.key === frameKey ? frame.canvas : null;
  // The moving tail, once its player and (for a graded clip) its LUT are in hand.
  const readyTail = moving && tail?.key === frameKey && tailLut?.key === frameKey ? tail.video : null;
  const tailLutReady = readyTail ? tailLut!.lut : null;
  const tailWrapRef = useRef<HTMLDivElement>(null);
  const tailHostRef = useRef<HTMLDivElement>(null);
  // Set during render (not in an effect) so GradeCanvas, whose effects run before ours, sees it.
  const tailRef = useRef<HTMLVideoElement | null>(null);
  tailRef.current = readyTail;

  // The tail player is a pooled DOM node - mounted by hand, paused when this transition ends.
  useEffect(() => {
    const host = tailHostRef.current;
    if (!host || !readyTail) return;
    readyTail.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
    host.replaceChildren(readyTail);
    return () => {
      readyTail.pause();
      host.replaceChildren();
    };
  }, [readyTail]);

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
    const duration = transitionDuration(incoming);
    const expectedUrl = incomingUrl?.clipId === incoming.id ? incomingUrl.url : null;
    const geometry = { L: frameRect.left, T: frameRect.top, W: frameRect.width, H: frameRect.height, containerW, containerH };

    const show = (visible: boolean) => {
      root.style.display = visible ? "" : "none";
    };
    const tailVideoEl = readyTail;
    const tailWrap = tailWrapRef.current;
    const tailStart = outgoing!.end;
    const rate = tailSpeed(outgoing!);
    let tailShown = false;
    if (tailWrap) tailWrap.style.visibility = "hidden";

    // Keeps the tail on the frame export would show at this point of the transition: the clip's
    // out-point plus the elapsed transition time at the clip's end speed (its file's last frame if
    // the source runs out first - export holds that frame too). Plays with the player, re-syncing
    // on drift; seeks frame-exactly while paused/scrubbing. Shown only once it's really there.
    const syncTail = (p: number, playing: boolean) => {
      if (!tailVideoEl || !tailWrap) return;
      const end = Number.isFinite(tailVideoEl.duration) ? tailVideoEl.duration - 0.04 : Infinity;
      const want = Math.min(tailStart + p * duration * rate, end);
      if (playing) {
        if (tailVideoEl.playbackRate !== rate) tailVideoEl.playbackRate = rate;
        if (Math.abs(tailVideoEl.currentTime - want) > 0.15 && !tailVideoEl.seeking) tailVideoEl.currentTime = want;
        if (tailVideoEl.paused) tailVideoEl.play().catch(() => {});
      } else {
        if (!tailVideoEl.paused) tailVideoEl.pause();
        if (Math.abs(tailVideoEl.currentTime - want) > 0.02 && !tailVideoEl.seeking) tailVideoEl.currentTime = want;
      }
      const onFrame = tailVideoEl.readyState >= 2 && !tailVideoEl.seeking && Math.abs(tailVideoEl.currentTime - want) < 0.2;
      if (onFrame !== tailShown) {
        tailShown = onFrame;
        tailWrap.style.visibility = onFrame ? "visible" : "hidden";
      }
    };
    // The outgoing picture as the mover shows it (its tail or frozen frame, in the clip's end-state
    // look) and the incoming one as the player shows it, each painted into a frame-sized canvas.
    const outgoingLook = clipFrameStyle(outgoing!, 1, { width: frameRect.width, height: frameRect.height });
    const pictures = (): TransitionPictures | null => {
      const video = getVideoElement?.();
      if (!video) return null;
      const dpr = window.devicePixelRatio || 1;
      const { width: W, height: H } = frameRect;
      oldPicRef.current ??= document.createElement("canvas");
      newPicRef.current ??= document.createElement("canvas");
      const oldCtx = framePictureContext(oldPicRef.current, W, H, dpr);
      const newCtx = framePictureContext(newPicRef.current, W, H, dpr);
      if (!oldCtx || !newCtx) return null;
      const box = { x: -frameRect.left, y: -frameRect.top, w: containerW, h: containerH };
      const oldEl = tailShown && tailVideoEl ? shownGradeCanvas(tailWrap) ?? tailVideoEl : readyCanvas;
      paintDisplayedPicture(oldCtx, oldEl, box, outgoingLook.transform, "", outgoingLook.filter);
      // The <video>'s own layout box (transforms aside), relative to the frame's top-left.
      const rootRect = root.getBoundingClientRect();
      const parentRect = (video.offsetParent ?? video.parentElement)?.getBoundingClientRect();
      const vbox = parentRect
        ? { x: parentRect.left + video.offsetLeft - (rootRect.left + frameRect.left), y: parentRect.top + video.offsetTop - (rootRect.top + frameRect.top), w: video.offsetWidth, h: video.offsetHeight }
        : box;
      // The incoming clip with its effect on (ClipFxLayer's canvas, frame-sized), when it has one.
      const withFx = root.parentElement?.querySelector<HTMLCanvasElement>("canvas[data-clip-fx]");
      if (withFx && withFx.style.display !== "none" && withFx.width > 0) newCtx.drawImage(withFx, 0, 0, frameRect.width, frameRect.height);
      else paintDisplayedPicture(newCtx, shownGradeCanvas(video.parentElement) ?? video, vbox, video.style.transform, video.style.transformOrigin, video.style.filter);
      return { old: oldPicRef.current, next: newPicRef.current };
    };
    const render = (p: number) =>
      renderTransitionFrame(
        type,
        look,
        p,
        {
          mover,
          black,
          glow,
          pixel: pixelCanvasRef.current,
          fx: fxCanvasRef.current,
          source: tailShown && tailVideoEl ? tailVideoEl : readyCanvas,
          pictures: isCanvasTransition(type) ? pictures : undefined,
        },
        geometry
      );

    let raf = 0;
    const tick = () => {
      const state = getPlaybackState();
      let progress: number | null = null;
      let swapped = false;
      if (state) {
        // Not swapped to the incoming clip yet (or no frame decoded) - hold the out-point.
        swapped = !!expectedUrl && state.src === expectedUrl && state.hasFrame;
        progress = swapped ? sourceToOutputOffset(incoming, state.time) / duration : 0;
      }
      if (progress === null || progress >= 1 || progress < -0.05) {
        show(false);
        if (tailVideoEl && !tailVideoEl.paused) tailVideoEl.pause();
      } else {
        const p = Math.max(0, progress);
        syncTail(p, swapped && !state!.paused);
        show(true);
        render(p);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, readyCanvas, readyTail, incomingUrl, frameRect.left, frameRect.top, frameRect.width, frameRect.height, containerW, containerH, getPlaybackState, getVideoElement]);

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
          {readyTail && (
            <div ref={tailWrapRef} className="absolute inset-0" style={{ visibility: "hidden" }}>
              <div ref={tailHostRef} className="absolute inset-0" />
              <GradeCanvas key={frameKey ?? ""} videoRef={tailRef} lut={tailLutReady} />
            </div>
          )}
          <canvas
            ref={pixelCanvasRef}
            className="absolute"
            style={{ left: L, top: T, width: W, height: H, imageRendering: "pixelated", display: "none" }}
          />
        </div>
      </div>
      <div ref={blackRef} className="absolute bg-black" style={{ left: L, top: T, width: W, height: H, opacity: 0 }} />
      <div ref={glowRef} className="absolute" style={{ left: L, top: T, width: W, height: H, opacity: 0, mixBlendMode: "screen" }} />
      <canvas ref={fxCanvasRef} className="absolute" style={{ left: L, top: T, width: W, height: H, display: "none" }} />
    </div>
  );
};

export default TransitionPreviewLayer;
