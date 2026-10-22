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
import { GradeLookName, ImageOverlay, TextOverlay, VideoEditState, VideoProjectFrame } from "../../utils/videoEditTypes";
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
function fittedFrame(img: StagePicture, w: number, h: number, look: GradeLookName | null, blurFill: boolean): HTMLCanvasElement {
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
  playing: boolean;
  // Restarts the loop just before the second shot (a style being tried out).
  restartKey: string;
  // Seconds into the edit from the song playing alongside - followed when it answers.
  songClock: (() => number | null) | null;
}

const ProjectStage: React.FC<ProjectStageProps> = ({ project, frame, images, blurFill, playing, restartKey, songClock }) => {
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

  // Each clip's picture fitted to the frame through its look - only redone when that changes.
  const fittedCache = useRef(new Map<string, HTMLCanvasElement>());
  const fitted = useMemo(() => {
    const next = new Map<string, HTMLCanvasElement>();
    for (const clip of project.clips) {
      const img = images.get(clip.sourcePath);
      const look = clip.grade?.look?.name ?? null;
      const key = `${clip.sourcePath}|${look}|${PW}x${PH}|${blurFill}`;
      if (!img || next.has(key)) continue;
      next.set(key, fittedCache.current.get(key) ?? fittedFrame(img, PW, PH, look, blurFill));
    }
    fittedCache.current = next;
    return next;
  }, [project.clips, images, PW, PH, blurFill]);

  const starts = useMemo(() => {
    const out = [0];
    for (const c of project.clips) out.push(out[out.length - 1] + (c.end - c.start));
    return out;
  }, [project.clips]);
  const total = Math.max(0.5, starts[starts.length - 1]);

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

    // Clip i at `local` seconds into it, with its Ken Burns window.
    const picture = (target: HTMLCanvasElement, i: number, local: number) => {
      const clip = project.clips[i];
      // A clip effect draws the moving picture through itself (clipFx.ts, as the editor does).
      const into = hasClipFx(clip.fx) ? pics[2] : target;
      paint(into, i, local);
      if (hasClipFx(clip.fx)) {
        const tctx = target.getContext("2d")!;
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        tctx.clearRect(0, 0, PW, PH);
        drawClipFx(tctx, clip.fx, into, local, PW, PH, PW / dpr, PH / dpr, dpr);
      }
    };
    const paint = (into: HTMLCanvasElement, i: number, local: number) => {
      const pctx = into.getContext("2d")!;
      const clip = project.clips[i];
      const src = fitted.get(`${clip.sourcePath}|${clip.grade?.look?.name ?? null}|${PW}x${PH}|${blurFill}`);
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      pctx.fillStyle = "#000";
      pctx.fillRect(0, 0, PW, PH);
      if (!src) return;
      const length = clip.end - clip.start;
      const win = clip.kenBurns ? kenBurnsWindow(clip.kenBurns, Math.max(0, Math.min(1, local / length)), length) : null;
      if (!win) {
        pctx.drawImage(src, 0, 0);
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
      picture(pics[0], i - 1, starts[i] - starts[i - 1]);
      drawStageTransition(ctx, stageCanDraw(tr.type) ? tr.type : "fade", local / tr.duration, pics[0], pics[1], PW, PH, dpr);
    };

    const drawBackdrops = (t: number) => {
      for (const a of project.adjustmentLayers) {
        if (!a.fill || t < a.startTime || t >= a.endTime) continue;
        const fin = a.fadeIn ? Math.min(1, (t - a.startTime) / a.fadeIn) : 1;
        const fout = a.fadeOut ? Math.min(1, (a.endTime - t) / a.fadeOut) : 1;
        ctx.globalAlpha = Math.max(0, Math.min(fin, fout)) * (a.opacity ?? 1);
        ctx.fillStyle = a.fill;
        ctx.fillRect(0, 0, PW, PH);
        ctx.globalAlpha = 1;
      }
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
        if (cell) ctx.drawImage(cell.canvas, x - cell.pad, y - cell.pad);
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
      drawClips(t);
      drawBackdrops(t);
      for (const o of project.imageOverlays) if (t >= o.startTime && t < o.endTime) drawImageOverlay(o, t);
      for (const o of project.textOverlays) if (t >= o.startTime && t < o.endTime) drawText(o, t);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [project, fitted, starts, total, images, PW, PH, dpr, playing, songClock, fontsReady, blurFill]);

  return (
    <div ref={boxRef} className="absolute inset-0 flex items-center justify-center">
      <canvas ref={canvasRef} style={{ width: W, height: H }} className="rounded-md shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]" />
    </div>
  );
};

export default ProjectStage;
