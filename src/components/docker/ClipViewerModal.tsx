// components/docker/ClipViewerModal.tsx
//
// "View clip" from the clip menu - plays one clip on its own, looped within just its own range,
// with its own speed and look (crop, Ken Burns, mirror, color - clipFrameStyle) exactly as the
// main preview shows it. Loads the same preview source the player would (clipPreviewSource.ts),
// so an image clip plays its letterboxed proxy rather than a bare picture. Leaves the timeline
// and the main player alone - closing it puts you right back where you were.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoPause, IoPlay, IoRepeat } from "react-icons/io5";
import { Clip, VideoProjectFrame, isImageClipPath } from "../../utils/videoEditTypes";
import { clipFrameStyle } from "../../utils/videoColorFilters";
import { FALLBACK_PREVIEW_FRAME, resolveClipPreviewUrl } from "../../utils/clipPreviewSource";

interface ClipViewerModalProps {
  clip: Clip;
  index: number;
  clipCount: number;
  // The timeline's frame (VideoTimelineDocker's videoPixelSize) - sizes the stage and, for an
  // image clip, picks the matching proxy.
  frame: VideoProjectFrame | null;
  onClose: () => void;
}

const formatTime = (seconds: number): string => {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

const ClipViewerModal: React.FC<ClipViewerModalProps> = ({ clip, index, clipCount, frame, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [elapsed, setElapsed] = useState(0); // output seconds into the clip
  const speed = clip.speed ?? 1;
  const duration = (clip.end - clip.start) / speed;
  const stage = frame ?? FALLBACK_PREVIEW_FRAME;
  const name = clip.sourcePath.split(/[\\/]/).pop() ?? clip.sourcePath;
  const loopRef = useRef(loop);
  loopRef.current = loop;

  useEffect(() => {
    let cancelled = false;
    resolveClipPreviewUrl(clip.sourcePath, frame)
      .then((resolved) => !cancelled && setUrl(resolved))
      .catch((err) => !cancelled && setError(`Couldn't load this clip: ${err}`));
    return () => {
      cancelled = true;
    };
  }, [clip.sourcePath, frame]);

  // Keeps playback inside [start, end) and the clip's look in sync, every animation frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    let raf = 0;
    const tick = () => {
      if (video.currentTime >= clip.end || video.currentTime < clip.start - 0.05) {
        video.currentTime = clip.start;
        if (!loopRef.current) video.pause();
      }
      const progress = (video.currentTime - clip.start) / Math.max(0.01, clip.end - clip.start);
      const look = clipFrameStyle(clip, progress);
      video.style.transform = look.transform;
      video.style.filter = look.filter;
      setElapsed(Math.max(0, (video.currentTime - clip.start) / speed));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [url, clip, speed]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };

  useEffect(() => {
    // Capture phase + stopPropagation: while this is open, no key reaches the timeline's own
    // shortcuts underneath (Delete would otherwise delete the clip being watched).
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape") onClose();
      else if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/70 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={`Clip ${index + 1}`} className="w-full max-w-4xl rounded-xl bg-neutral-900 ring-1 ring-white/10 shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/10">
          <span className="flex-1 min-w-0 truncate text-sm text-neutral-100">
            <span className="text-neutral-400">
              {isImageClipPath(clip.sourcePath) ? "Image" : "Video"} clip {index + 1} of {clipCount} ·{" "}
            </span>
            {name}
          </span>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-full text-neutral-400 hover:text-white hover:bg-white/10">
            <IoClose size={18} />
          </button>
        </div>

        <div className="bg-black flex items-center justify-center">
          <div className="relative overflow-hidden bg-black" style={{ aspectRatio: `${stage.width} / ${stage.height}`, maxHeight: "65vh", width: "100%", maxWidth: `calc(65vh * ${stage.width / stage.height})` }}>
            {url && (
              <video
                ref={videoRef}
                src={url}
                crossOrigin="anonymous"
                autoPlay
                playsInline
                onLoadedMetadata={(e) => {
                  e.currentTarget.currentTime = clip.start;
                  e.currentTarget.playbackRate = speed;
                }}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onClick={togglePlay}
                className="absolute inset-0 w-full h-full object-contain cursor-pointer"
              />
            )}
            {!url && !error && <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-500">Loading…</div>}
            {error && <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-red-300">{error}</div>}
          </div>
        </div>

        <div className="flex items-center gap-3 px-4 py-2.5">
          <button type="button" onClick={togglePlay} disabled={!url} aria-label={isPlaying ? "Pause" : "Play"} className="p-1.5 rounded-full text-white hover:bg-white/10 disabled:opacity-40">
            {isPlaying ? <IoPause size={18} /> : <IoPlay size={18} />}
          </button>
          <input
            type="range"
            min={0}
            max={duration}
            step={0.01}
            value={Math.min(elapsed, duration)}
            onChange={(e) => {
              const video = videoRef.current;
              if (video) video.currentTime = clip.start + Number(e.target.value) * speed;
            }}
            className="flex-1 accent-teal-400"
            aria-label="Position in clip"
          />
          <span className="text-[11px] tabular-nums text-neutral-400 w-[92px] text-right">
            {formatTime(elapsed)} / {formatTime(duration)}
          </span>
          <button
            type="button"
            onClick={() => setLoop((v) => !v)}
            aria-pressed={loop}
            title={loop ? "Looping - click to play once" : "Play once - click to loop"}
            className={`p-1.5 rounded-full hover:bg-white/10 ${loop ? "text-teal-400" : "text-neutral-500"}`}
          >
            <IoRepeat size={16} />
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ClipViewerModal;
