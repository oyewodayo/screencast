// components/shorts/ShortPreview.tsx
//
// A phone-shaped preview of one short (ShortsStudio), drawn into a 9:16 canvas the way export
// frames it - Fill following the same camera path export renders (reframeWindowAt), or the whole
// picture over a blurred copy of itself - with the title (the very PNG export burns in) and
// captions (the editor's own caption renderer) on top.
//
// Still, it shows its first frame (a poster picture). Playing, it borrows the studio's one shared
// <video> and plays its clips back to back on it: WebView2 can only run a few video decoders at
// once, and the editor's own player already holds some - one element per card starved them all.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { IoPlay } from "react-icons/io5";
import type { Clip, CaptionSettings, TextOverlay } from "../../utils/videoEditTypes";
import { clipOutputDuration, sourceToOutputOffset } from "../../utils/clipTiming";
import { activeWordIndex, captionFontPx, captionLineAt, type CaptionLine } from "../../utils/captions";
import { fillWindow, reframeWindowAt, type ReframeKnot } from "../../utils/reframeTrack";
import { resolveClipPreviewUrl } from "../../utils/clipPreviewSource";
import { renderTextOverlayToPng } from "../../utils/videoOverlayRender";
import { CaptionLineView } from "../video/CaptionOverlayLayer";
import { SHORT_SIZE, type ShortLayout } from "../../utils/shortsBuild";

// The largest a card is drawn; ShortsStudio shrinks it to fit short windows.
export const MAX_CARD_W = 236;
export const cardHeight = (w: number) => Math.round((w * SHORT_SIZE.height) / SHORT_SIZE.width);

interface Props {
  width: number;
  clips: Clip[];
  frame: { width: number; height: number } | null;
  layout: ShortLayout;
  knots: ReframeKnot[] | null;
  title: TextOverlay | null;
  captionLines: CaptionLine[];
  captionSettings: CaptionSettings | null;
  // The short's first frame as a picture URL (null while it's being grabbed).
  poster: string | null;
  // The studio's shared player - handed to the card that's playing, null for the others.
  video: HTMLVideoElement | null;
  playing: boolean;
  onTogglePlay: () => void;
  onEnded: () => void;
  children?: React.ReactNode;
}

type Source = HTMLVideoElement | HTMLImageElement;
const sourceSize = (s: Source) => (s instanceof HTMLVideoElement ? { w: s.videoWidth, h: s.videoHeight } : { w: s.naturalWidth, h: s.naturalHeight });

const ShortPreview: React.FC<Props> = ({ width: CARD_W, clips, frame, layout, knots, title, captionLines, captionSettings, poster, video, playing, onTogglePlay, onEnded, children }) => {
  const CARD_H = cardHeight(CARD_W);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const posterRef = useRef<HTMLImageElement | null>(null);
  const [caption, setCaption] = useState<{ lineId: string | null; word: number }>({ lineId: null, word: -1 });

  const pieces = useMemo(() => {
    let at = 0;
    return clips.map((clip) => {
      const p = { clip, outStart: at };
      at += clipOutputDuration(clip);
      return p;
    });
  }, [clips]);
  const total = pieces.length ? pieces[pieces.length - 1].outStart + clipOutputDuration(pieces[pieces.length - 1].clip) : 0;

  // Latest values for the draw loop, without restarting it.
  const live = useRef({ layout, knots, frame, captionLines });
  live.current = { layout, knots, frame, captionLines };

  // Draws one picture of the short at output time t: the frame's framing, the cold open's flash,
  // the progress bar and the caption under the playhead.
  const draw = (source: Source, t: number, piece: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const { w: vw, h: vh } = sourceSize(source);
    if (!canvas || !ctx || !vw || !vh) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const { layout, knots, frame } = live.current;
    if (layout === "follow") {
      // The window is in fractions of the timeline's frame; the picture sits in that frame contained.
      const F = frame ?? { width: vw, height: vh };
      const win = fillWindow(F, SHORT_SIZE);
      const c = knots && knots.length ? reframeWindowAt(knots, t) : { x: 0.5, y: 0.5 };
      const scale = Math.min(F.width / vw, F.height / vh);
      const ox = (F.width - vw * scale) / 2;
      const oy = (F.height - vh * scale) / 2;
      const sx = ((c.x - win.w / 2) * F.width - ox) / scale;
      const sy = ((c.y - win.h / 2) * F.height - oy) / scale;
      ctx.drawImage(source, sx, sy, (win.w * F.width) / scale, (win.h * F.height) / scale, 0, 0, W, H);
    } else {
      // The whole picture over a soft, darkened blow-up of itself.
      const cover = Math.max(W / vw, H / vh) * 1.1;
      ctx.filter = "blur(18px) brightness(0.75)";
      ctx.drawImage(source, (W - vw * cover) / 2, (H - vh * cover) / 2, vw * cover, vh * cover);
      ctx.filter = "none";
      const fit = Math.min(W / vw, H / vh);
      ctx.drawImage(source, (W - vw * fit) / 2, (H - vh * fit) / 2, vw * fit, vh * fit);
    }
    const p = pieces[piece];
    const tr = p?.clip.transitionIn;
    if (p && tr && tr.type === "fadewhite") {
      const u = (t - p.outStart) / tr.duration;
      if (u >= 0 && u < 1) {
        ctx.fillStyle = `rgba(255,255,255,${(1 - Math.abs(u * 2 - 1)) * 0.85})`;
        ctx.fillRect(0, 0, W, H);
      }
    }
    if (progressRef.current) progressRef.current.style.transform = `scaleX(${total > 0 ? Math.min(1, t / total) : 0})`;
    const line = captionLineAt(live.current.captionLines, t);
    const next = { lineId: line?.id ?? null, word: line ? activeWordIndex(line, t) : -1 };
    setCaption((prev) => (prev.lineId === next.lineId && prev.word === next.word ? prev : next));
  };

  // Still: the poster, at the start.
  const drawPoster = () => {
    if (posterRef.current?.complete && posterRef.current.naturalWidth) draw(posterRef.current, 0, 0);
  };
  useEffect(() => {
    if (!poster) return;
    const img = new Image();
    img.onload = () => {
      posterRef.current = img;
      if (!playing) drawPoster();
    };
    img.src = poster;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poster]);
  // A paused card keeps the frame it stopped on; anything that changes the picture redraws the start.
  useEffect(() => {
    if (!playing) drawPoster();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, knots, captionLines, pieces, CARD_W]);

  // Playing: the clips back to back on the shared player, drawn every frame.
  useEffect(() => {
    if (!playing || !video || pieces.length === 0) return;
    let stopped = false;
    let raf = 0;
    let piece = 0;
    let jumping = true;

    const goTo = async (i: number) => {
      const p = pieces[i];
      piece = i;
      if (video.dataset.path !== p.clip.sourcePath) {
        const url = await resolveClipPreviewUrl(p.clip.sourcePath, frame);
        if (stopped) return;
        video.dataset.path = p.clip.sourcePath;
        const ready = new Promise<void>((resolve) => video.addEventListener("loadedmetadata", () => resolve(), { once: true }));
        video.src = url;
        // Chromium may leave a media element idle after a src change until asked to load.
        video.load();
        await ready;
      }
      video.playbackRate = p.clip.speed ?? 1;
      if (Math.abs(video.currentTime - p.clip.start) > 0.03) {
        const seeked = new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
        video.currentTime = p.clip.start;
        await seeked;
      }
    };
    const outputTime = () => {
      const p = pieces[piece];
      return p.outStart + sourceToOutputOffset(p.clip, Math.max(p.clip.start, Math.min(p.clip.end, video.currentTime)));
    };
    // Running through a short cut instead of seeking over it (see tick): back to normal once in.
    let skipping = false;
    const endSkip = () => {
      skipping = false;
      video.muted = false;
      video.playbackRate = pieces[piece].clip.speed ?? 1;
    };
    const tick = () => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      if (jumping) return;
      if (skipping) {
        // Holding the last frame until the next piece starts.
        if (video.currentTime >= pieces[piece].clip.start - 0.01) endSkip();
        else return;
      }
      const p = pieces[piece];
      if (video.currentTime >= p.clip.end - 0.02) {
        const next = pieces[piece + 1];
        const gap = next ? next.clip.start - video.currentTime : Infinity;
        // A removed pause or "um" is a small jump forward in the same file. A seek there decodes from
        // the last keyframe (seconds, on files with sparse keyframes), so run through it muted at 4x.
        if (next && next.clip.sourcePath === p.clip.sourcePath && gap > 0 && gap <= 1.2) {
          piece += 1;
          skipping = true;
          video.muted = true;
          video.playbackRate = 4;
          return;
        }
        if (piece + 1 < pieces.length) {
          jumping = true;
          void goTo(piece + 1).then(() => {
            jumping = false;
            if (!stopped) void video.play().catch(() => {});
          });
          return;
        }
        stopped = true;
        video.pause();
        drawPoster();
        onEnded();
        return;
      }
      draw(video, outputTime(), piece);
    };
    void goTo(0)
      .then(() => {
        if (stopped) return;
        jumping = false;
        return video.play();
      })
      .catch((err) => console.warn("Short preview couldn't play:", err));
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      video.pause();
      video.muted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, video, pieces]);

  // The title as the exact picture export burns in, scaled to the card.
  const titlePng = useMemo(() => (title ? renderTextOverlayToPng(title, SHORT_SIZE.width, SHORT_SIZE.height) : null), [title]);
  const scale = CARD_W / SHORT_SIZE.width;
  const line = caption.lineId ? captionLines.find((l) => l.id === caption.lineId) ?? null : null;

  return (
    <div
      role="button"
      tabIndex={0}
      data-short-preview
      onClick={onTogglePlay}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onTogglePlay();
        }
      }}
      className="group relative overflow-hidden rounded-[22px] bg-black ring-1 ring-white/10 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.8)] transition duration-300 hover:ring-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 cursor-pointer select-none"
      style={{ width: CARD_W, height: CARD_H }}
    >
      <canvas ref={canvasRef} width={CARD_W * 2} height={CARD_H * 2} className="absolute inset-0 h-full w-full" />
      {!poster && !playing && <div className="absolute inset-0 animate-pulse bg-white/[0.04]" />}
      {titlePng && (
        <img
          src={titlePng.dataUrl}
          alt=""
          draggable={false}
          className="absolute pointer-events-none"
          style={{ left: titlePng.xPx * scale, top: titlePng.yPx * scale, transform: `scale(${scale})`, transformOrigin: "0 0", maxWidth: "none" }}
        />
      )}
      {captionSettings && line && (
        <div className="absolute inset-0 flex flex-col items-center justify-end pointer-events-none" style={{ paddingBottom: captionSettings.offset * CARD_H }}>
          <CaptionLineView line={line} activeWord={caption.word} settings={captionSettings} fontPx={captionFontPx(captionSettings, CARD_H)} />
        </div>
      )}
      <div className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${playing ? "opacity-0" : "opacity-100"}`}>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md ring-1 ring-white/20 transition-transform duration-300 group-hover:scale-110">
          <IoPlay size={20} className="translate-x-[1px]" />
        </span>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/10">
        <div ref={progressRef} className="h-full origin-left bg-white/85" style={{ transform: "scaleX(0)" }} />
      </div>
      {children}
    </div>
  );
};

export default ShortPreview;
