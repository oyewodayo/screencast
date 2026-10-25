// components/video/ProjectStage.tsx
//
// Plays a still-image project (a VideoEditState of picture clips - what buildStyledProject makes)
// on one canvas, before it exists as a file: for the "Create a video" dialog's stage, so what you
// see there is the project the editor will open with, not an impression of it. Each picture is
// letterboxed into the frame as export fits it, through the clip's look (gradeLooks.ts, the
// function the grade LUT bakes) and its Ken Burns window (kenBurnsWindow); transitions are drawn by
// stageTransitions.ts; collage backdrops, photo cells, elements (drawAssetFrame) and captions
// (drawTextOverlay with their letter reveals) on top, each with its entrance (overlayAnimationStyle).
// The clock is the song's when one is playing alongside (songClock), so cuts land on its beats.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ClipCrop, GradeLookName, ImageOverlay, TextOverlay, VideoEditState, VideoProjectFrame } from "../../utils/videoEditTypes";
import { applyLook } from "../../utils/gradeLooks";
import { kenBurnsWindow } from "../../utils/videoColorFilters";
import { drawAssetFrame } from "../../utils/videoAssets";
import { drawTextOverlay } from "../../utils/videoOverlayRender";
import { isTextReveal, textRevealFrameKey, textRevealState } from "../../utils/textReveal";
import { overlayAnimationStyle } from "../../utils/overlayAnimation";
import { loadTitleFonts } from "../../utils/titleFonts";
import { drawStageTransition, stageCanDraw } from "./stageTransitions";
import { drawPhotoFill, needsPhotoFill } from "../../utils/photoFill";
import { drawClipFx, hasClipFx } from "../../utils/clipFx";

// A decoded picture: an image, or a canvas it was scaled down into.
export type StagePicture = HTMLCanvasElement | HTMLImageElement;

// A picture letterboxed into a w x h frame on black (export's frame_fit_chain), through the look.
// With `blurFill`, a photo of another shape sits over its own blurred copy instead (photoFill.ts -
// what Create stores for it).
// A look is a per-pixel pass, so a frame with one is made at no more than LOOK_MAX_PX pixels (it's
// drawn scaled to the stage, where the difference doesn't show).
const LOOK_MAX_PX = 1_200_000;
function fittedFrame(img: StagePicture, fw: number, fh: number, look: GradeLookName | null, blurFill: boolean): HTMLCanvasElement {
  const k = look ? Math.min(1, Math.sqrt(LOOK_MAX_PX / (fw * fh))) : 1;
  const w = Math.max(2, Math.round(fw * k));
  const h = Math.max(2, Math.round(fh * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: !!look })!;
  if (blurFill && needsPhotoFill(img.width / img.height, { width: w, height: h })) drawPhotoFill(ctx, img, w, h);
  else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    const s = Math.min(w / img.width, h / img.height);
    const dw = img.width * s;
    const dh = img.height * s;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  if (look) {
    // A picture the browser won't let us read back just plays without the look on the stage.
    try {
      const data = ctx.getImageData(0, 0, w, h);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const [r, g, b] = applyLook(look, 0.85, px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
        px[i] = r * 255;
        px[i + 1] = g * 255;
        px[i + 2] = b * 255;
      }
      ctx.putImageData(data, 0, 0);
    } catch (err) {
      console.warn("Look preview unavailable for this picture", err);
    }
  }
  return canvas;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

interface ProjectStageProps {
  project: VideoEditState;
  frame: VideoProjectFrame;
  // The pictures by path, decoded and scaled down to stage size (readable, so the look can apply).
  images: Map<string, StagePicture>;
  // Photos of another shape fill the frame over a blurred copy of themselves, not black bars.
  blurFill: boolean;
  // The clips' files that are videos - played live (`images` holds a poster for each, shown until
  // the video can draw).
  videoPaths?: Set<string>;
  playing: boolean;
  // Restarts the loop just before the second shot (a style being tried out).
  restartKey: string;
  // Seconds into the edit from the song playing alongside - followed when it answers.
  songClock: (() => number | null) | null;
}

// Videos play from a small pool of muted <video> elements - WebView2 only runs a few decoders at
// once, and two are enough for a cut between two video shots.
const VIDEO_POOL = 2;

const ProjectStage: React.FC<ProjectStageProps> = ({ project, frame, images, blurFill, videoPaths, playing, restartKey, songClock }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 320, h: 320 });
  const [fontsReady, setFontsReady] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fontKey = project.textOverlays.map((o) => o.fontFamily ?? "").join("|");
  useEffect(() => {
    let cancelled = false;
    void loadTitleFonts(fontKey.split("|")).then(() => !cancelled && setFontsReady((n) => n + 1));
    return () => {
      cancelled = true;
    };
  }, [fontKey]);

  // The frame on screen, as large as fits the stage.
  const scale = Math.min(box.w / frame.width, box.h / frame.height);
  const W = Math.max(2, Math.floor(frame.width * scale));
  const H = Math.max(2, Math.floor(frame.height * scale));
  const dpr = window.devicePixelRatio || 1;
  const PW = Math.round(W * dpr);
  const PH = Math.round(H * dpr);

  // Each clip's picture fitted to the frame through its look - made the first time that clip is
  // drawn, not all at once (a look is a per-pixel pass; trying a style mustn't stall on sixteen of
  // them), and kept while frame size and fill stay the same.
  const fittedCache = useRef(new Map<string, HTMLCanvasElement>());
  useEffect(() => {
    fittedCache.current.clear();
  }, [PW, PH, blurFill]);

  const starts = useMemo(() => {
    const out = [0];
    for (const c of project.clips) out.push(out[out.length - 1] + (c.end - c.start));
    return out;
  }, [project.clips]);
  const total = Math.max(0.5, starts[starts.length - 1]);

  const videoPool = useRef(new Map<string, HTMLVideoElement>());
  useEffect(() => {
    const pool = videoPool.current;
    return () => {
      pool.forEach((v) => {
        v.pause();
        v.removeAttribute("src");
        v.load();
      });
      pool.clear();
    };
  }, []);

  const clockRef = useRef({ offset: 0 });
  useEffect(() => {
    // Start a moment before the second shot comes in, so a new style shows straight away.
    clockRef.current = { offset: starts.length > 2 ? Math.max(0, starts[1] - 0.5) : 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = PW;
    canvas.height = PH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const pics = [document.createElement("canvas"), document.createElement("canvas"), document.createElement("canvas")];
    pics.forEach((p) => {
      p.width = PW;
      p.height = PH;
    });
    const scratch = new Map<string, HTMLCanvasElement>();
    const scratchFor = (id: string) => {
      let c = scratch.get(id);
      if (!c) scratch.set(id, (c = document.createElement("canvas")));
      return c;
    };

    // A picture fitted into the frame (bars round it), then - with a crop - the crop's window on that
    // frame stretched to fill it: what export does (frame_fit_chain, then crop_chain).
    const drawFittedCropped = (c: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, crop?: ClipCrop) => {
      const s = Math.min(PW / sw, PH / sh);
      const fx = (PW - sw * s) / 2;
      const fy = (PH - sh * s) / 2;
      if (!crop) {
        c.drawImage(src, fx, fy, sw * s, sh * s);
        return;
      }
      // The crop window in frame px, back into the picture's own px.
      const wx = crop.x * PW;
      const wy = crop.y * PH;
      const ww = crop.width * PW;
      const wh = crop.height * PH;
      c.save();
      c.setTransform(PW / ww, 0, 0, PH / wh, (-wx * PW) / ww, (-wy * PH) / wh);
      c.drawImage(src, fx, fy, sw * s, sh * s);
      c.restore();
    };

    // The pool's element for a video, opened if it isn't (closing the least recently used).
    const videoFor = (path: string): HTMLVideoElement => {
      const pool = videoPool.current;
      let v = pool.get(path);
      if (v) {
        pool.delete(path);
        pool.set(path, v);
        return v;
      }
      if (pool.size >= VIDEO_POOL) {
        const [oldPath, old] = pool.entries().next().value!;
        old.pause();
        old.removeAttribute("src");
        old.load();
        pool.delete(oldPath);
      }
      v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.crossOrigin = "anonymous";
      v.src = convertFileSrc(path);
      pool.set(path, v);
      return v;
    };
    // The last frame each video shot showed - what it holds through the transition out of it.
    const lastFrames = new Map<number, HTMLCanvasElement>();
    let liveVideo: string | null = null;

    // A video shot at `local` seconds: its frame (cropped to fill, or fitted), kept in step with the
    // stage's clock - playing along while the stage plays, seeking when it drifts.
    const paintVideo = (pctx: CanvasRenderingContext2D, i: number, local: number): boolean => {
      const clip = project.clips[i];
      const v = videoFor(clip.sourcePath);
      liveVideo = clip.sourcePath;
      const want = clip.start + Math.max(0, Math.min(local, clip.end - clip.start - 0.04));
      if (v.readyState >= 1 && Math.abs(v.currentTime - want) > (playing ? 0.35 : 0.04) && !v.seeking) v.currentTime = want;
      if (playing && v.paused) v.play().catch(() => undefined);
      if (!playing && !v.paused) v.pause();
      if (v.readyState < 2 || !v.videoWidth) return false;
      drawFittedCropped(pctx, v, v.videoWidth, v.videoHeight, clip.crop);
      return true;
    };

    // Clip i at `local` seconds into it, with its Ken Burns window. `outgoing`: the shot a
    // transition is leaving - a video holds its last frame there.
    const picture = (target: HTMLCanvasElement, i: number, local: number, outgoing = false) => {
      const clip = project.clips[i];
      // A clip effect draws the moving picture through itself (clipFx.ts, as the editor does).
      const into = hasClipFx(clip.fx) ? pics[2] : target;
      const held = outgoing && videoPaths?.has(clip.sourcePath) ? lastFrames.get(i) : undefined;
      if (held) {
        const hctx = into.getContext("2d")!;
        hctx.setTransform(1, 0, 0, 1, 0, 0);
        hctx.drawImage(held, 0, 0);
      } else paint(into, i, local, outgoing);
      if (hasClipFx(clip.fx)) {
        const tctx = target.getContext("2d")!;
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        tctx.clearRect(0, 0, PW, PH);
        drawClipFx(tctx, clip.fx, into, local, PW, PH, PW / dpr, PH / dpr, dpr);
      }
    };
    const paint = (into: HTMLCanvasElement, i: number, local: number, outgoing = false) => {
      const pctx = into.getContext("2d")!;
      const clip = project.clips[i];
      const look = clip.grade?.look?.name ?? null;
      const key = `${clip.sourcePath}|${look}`;
      let src = fittedCache.current.get(key);
      const img = images.get(clip.sourcePath);
      if (!src && img && !videoPaths?.has(clip.sourcePath)) {
        if (fittedCache.current.size > 48) fittedCache.current.clear();
        fittedCache.current.set(key, (src = fittedFrame(img, PW, PH, look, blurFill)));
      } else if (!src && img && clip.crop) {
        // A video still seeking shows its poster framed exactly as the video will be.
        const poster = document.createElement("canvas");
        poster.width = PW;
        poster.height = PH;
        drawFittedCropped(poster.getContext("2d")!, img, img.width, img.height, clip.crop);
        fittedCache.current.set(key, (src = poster));
      } else if (!src && img) fittedCache.current.set(key, (src = fittedFrame(img, PW, PH, null, false)));
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      pctx.fillStyle = "#000";
      pctx.fillRect(0, 0, PW, PH);
      if (videoPaths?.has(clip.sourcePath) && !outgoing && paintVideo(pctx, i, local)) {
        let keep = lastFrames.get(i);
        if (!keep) {
          keep = document.createElement("canvas");
          keep.width = PW;
          keep.height = PH;
          lastFrames.set(i, keep);
        }
        keep.getContext("2d")!.drawImage(into, 0, 0);
        return;
      }
      if (!src) return;
      const length = clip.end - clip.start;
      const win = clip.kenBurns ? kenBurnsWindow(clip.kenBurns, Math.max(0, Math.min(1, local / length)), length) : null;
      if (!win) {
        pctx.drawImage(src, 0, 0, PW, PH);
        return;
      }
      const sw = src.width / win.zoom;
      const sh = src.height / win.zoom;
      pctx.drawImage(src, win.cx * src.width - sw / 2, win.cy * src.height - sh / 2, sw, sh, 0, 0, PW, PH);
    };

    const drawClips = (t: number) => {
      let i = 0;
      while (i < project.clips.length - 1 && t >= starts[i + 1]) i++;
      const local = t - starts[i];
      picture(pics[1], i, local);
      const tr = project.clips[i].transitionIn;
      if (i === 0 || !tr || local >= tr.duration) {
        ctx.drawImage(pics[1], 0, 0);
        return;
      }
      // Stills hold their last frame through the transition, as export does.
      picture(pics[0], i - 1, starts[i] - starts[i - 1], true);
      drawStageTransition(ctx, stageCanDraw(tr.type) ? tr.type : "fade", local / tr.duration, pics[0], pics[1], PW, PH, dpr);
    };

    // Collage and brand backdrops: a solid colour, or the picture itself blurred, dimmed, desaturated.
    const adjusted = document.createElement("canvas");
    adjusted.width = PW;
    adjusted.height = PH;
    const drawBackdrops = (t: number) => {
      for (const a of project.adjustmentLayers) {
        if (t < a.startTime || t >= a.endTime) continue;
        const fin = a.fadeIn ? Math.min(1, (t - a.startTime) / a.fadeIn) : 1;
        const fout = a.fadeOut ? Math.min(1, (a.endTime - t) / a.fadeOut) : 1;
        const alpha = Math.max(0, Math.min(fin, fout)) * (a.opacity ?? 1);
        if (a.fill) {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = a.fill;
          ctx.fillRect(0, 0, PW, PH);
          ctx.globalAlpha = 1;
          continue;
        }
        const filter = [
          a.blur ? `blur(${a.blur * PH}px)` : "",
          a.brightness !== undefined ? `brightness(${a.brightness})` : "",
          a.saturation !== undefined ? `saturate(${a.saturation})` : "",
          a.contrast !== undefined ? `contrast(${a.contrast})` : "",
        ]
          .join(" ")
          .trim();
        if (!filter) continue;
        const actx = adjusted.getContext("2d")!;
        actx.clearRect(0, 0, PW, PH);
        actx.drawImage(canvas, 0, 0);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.filter = filter;
        // Scaled a touch so the blur's soft edge stays outside the frame.
        const m = (a.blur ?? 0) * PH * 2;
        ctx.drawImage(adjusted, -m, -m, PW + 2 * m, PH + 2 * m);
        ctx.restore();
      }
    };

    // A light streak sweeping across a picture (its "glare" reveal) - on its first moment and again
    // every shineEvery seconds.
    const shineLayer = document.createElement("canvas");
    const drawShine = (o: ImageOverlay, cell: { canvas: HTMLCanvasElement; pad: number }, x: number, y: number, t: number) => {
      const r = o.reveal;
      if (r?.style !== "glare") return;
      const pass = 0.8;
      let local = t - o.startTime;
      if (r.shineEvery && local > pass) local = (local - pass) % r.shineEvery;
      if (local < 0 || local > pass) return;
      const p = local / pass;
      const cw = cell.canvas.width;
      const ch = cell.canvas.height;
      shineLayer.width = cw;
      shineLayer.height = ch;
      const s = shineLayer.getContext("2d")!;
      s.drawImage(cell.canvas, 0, 0);
      s.globalCompositeOperation = "source-atop";
      const bx = -cw * 0.5 + p * cw * 2;
      const g = s.createLinearGradient(bx - cw * 0.25, 0, bx + cw * 0.25, ch * 0.4);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.5, r.shineColor ?? "rgba(255,255,255,0.85)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      s.fillStyle = g;
      s.fillRect(0, 0, cw, ch);
      ctx.drawImage(shineLayer, x - cell.pad, y - cell.pad);
    };

    // An overlay's entrance/exit around its box's centre.
    const withAnimation = (o: ImageOverlay | TextOverlay, t: number, cx: number, cy: number, draw: () => void) => {
      const a = overlayAnimationStyle(isTextReveal(o.animation) ? "none" : o.animation, o.startTime, o.endTime, t, PW, PH);
      if (a.opacity <= 0) return;
      ctx.save();
      ctx.globalAlpha = a.opacity * ("opacity" in o && typeof o.opacity === "number" ? o.opacity : 1);
      ctx.translate(cx + a.translateXPx, cy + a.translateYPx);
      ctx.scale(a.scale * (a.scaleX ?? 1), a.scale);
      ctx.translate(-cx, -cy);
      draw();
      ctx.restore();
    };

    const drawImageOverlay = (o: ImageOverlay, t: number) => {
      const x = o.x * PW;
      const y = o.y * PH;
      const w = o.width * PW;
      const h = o.height * PH;
      withAnimation(o, t, x + w / 2, y + h / 2, () => {
        if (o.asset) {
          ctx.translate(x + w / 2, y + h / 2);
          if (o.rotation) ctx.rotate((o.rotation * Math.PI) / 180);
          drawAssetFrame(ctx, o.asset, w, h, t - o.startTime, o.endTime - o.startTime);
          return;
        }
        const cell = photoCell(o, w, h);
        if (!cell) return;
        ctx.drawImage(cell.canvas, x - cell.pad, y - cell.pad);
        drawShine(o, cell, x, y, t);
      });
    };

    // A photo cell - the cropped picture in its frame, with its shadow - drawn once, then placed.
    const cells = new Map<string, { canvas: HTMLCanvasElement; pad: number } | null>();
    const photoCell = (o: ImageOverlay, w: number, h: number) => {
      if (cells.has(o.id)) return cells.get(o.id)!;
      const img = images.get(o.src);
      if (!img) return null;
      const r = (o.cornerRadius ?? 0) * PH;
      const f = o.borderColor && o.borderWidth ? o.borderWidth * PH : 0;
      const pad = Math.ceil(f + (o.shadow ? 28 * (PH / 1080) : 0));
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(w + 2 * pad);
      canvas.height = Math.ceil(h + 2 * pad);
      const c = canvas.getContext("2d")!;
      c.translate(pad, pad);
      if (o.shadow) {
        c.save();
        c.shadowColor = "rgba(0,0,0,0.45)";
        c.shadowBlur = 16 * (PH / 1080);
        c.shadowOffsetY = 6 * (PH / 1080);
        c.fillStyle = o.borderColor ?? "#000";
        roundRect(c, -f, -f, w + 2 * f, h + 2 * f, r);
        c.fill();
        c.restore();
      } else if (f) {
        c.fillStyle = o.borderColor!;
        roundRect(c, -f, -f, w + 2 * f, h + 2 * f, r);
        c.fill();
      }
      roundRect(c, 0, 0, w, h, r);
      c.clip();
      c.imageSmoothingQuality = "high";
      c.drawImage(img, (o.cropX ?? 0) * img.width, (o.cropY ?? 0) * img.height, (o.cropWidth ?? 1) * img.width, (o.cropHeight ?? 1) * img.height, 0, 0, w, h);
      const cell = { canvas, pad };
      cells.set(o.id, cell);
      return cell;
    };

    // A title is drawn again only while its letters are moving - settled, it's the same picture.
    const titles = new Map<string, { key: string; drawn: ReturnType<typeof drawTextOverlay> }>();
    const drawText = (o: TextOverlay, t: number) => {
      const kind = isTextReveal(o.animation) ? o.animation : null;
      const state = kind ? textRevealState(o.text, kind, t - o.startTime, o.endTime - o.startTime, o.reveal) : undefined;
      const key = state ? textRevealFrameKey(state, Math.round(t * 240)) : "still";
      let entry = titles.get(o.id);
      if (!entry || entry.key !== key || key.startsWith("f")) titles.set(o.id, (entry = { key, drawn: drawTextOverlay(o, PW, PH, state, scratchFor(o.id)) }));
      const drawn = entry.drawn;
      if (!drawn) return;
      withAnimation(o, t, (o.x + o.width / 2) * PW, (o.y + o.height / 2) * PH, () => ctx.drawImage(drawn.canvas, drawn.xPx, drawn.yPx));
    };

    // The next shot's frame is made while the browser is idle, so the cut into it never waits.
    let warming = 0;
    const warmNext = (t: number) => {
      if (warming) return;
      let i = 0;
      while (i < project.clips.length - 1 && t >= starts[i + 1]) i++;
      const next = project.clips[(i + 1) % project.clips.length];
      const key = `${next.sourcePath}|${next.grade?.look?.name ?? null}`;
      const img = images.get(next.sourcePath);
      if (!img || videoPaths?.has(next.sourcePath) || fittedCache.current.has(key)) return;
      const run = () => {
        warming = 0;
        if (!fittedCache.current.has(key)) fittedCache.current.set(key, fittedFrame(img, PW, PH, next.grade?.look?.name ?? null, blurFill));
      };
      warming = typeof requestIdleCallback === "function" ? requestIdleCallback(run, { timeout: 400 }) : window.setTimeout(run, 30);
    };

    let raf = 0;
    let last = performance.now();
    let drawnAt = -1;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (playing) clockRef.current.offset += (now - last) / 1000;
      last = now;
      const song = songClock?.();
      if (song != null) clockRef.current.offset = Math.max(0, song);
      // Paused (or the song holding still): the frame on screen is already right.
      if (clockRef.current.offset === drawnAt) return;
      drawnAt = clockRef.current.offset;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, PW, PH);
      if (!project.clips.length) return;
      const t = clockRef.current.offset % total;
      liveVideo = null;
      drawClips(t);
      warmNext(t);
      // Only the shot on screen plays.
      videoPool.current.forEach((v, path) => path !== liveVideo && !v.paused && v.pause());
      drawBackdrops(t);
      for (const o of project.imageOverlays) if (t >= o.startTime && t < o.endTime) drawImageOverlay(o, t);
      for (const o of project.textOverlays) if (t >= o.startTime && t < o.endTime) drawText(o, t);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (warming && typeof cancelIdleCallback === "function") cancelIdleCallback(warming);
    };
  }, [project, starts, total, images, PW, PH, dpr, playing, songClock, fontsReady, blurFill, videoPaths]);

  return (
    <div ref={boxRef} className="absolute inset-0 flex items-center justify-center">
      <canvas ref={canvasRef} style={{ width: W, height: H }} className="rounded-md shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]" />
    </div>
  );
};

export default ProjectStage;
