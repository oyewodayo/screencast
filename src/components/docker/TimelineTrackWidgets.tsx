// Pure timeline track subcomponents & helpers extracted from VideoTimelineDocker.tsx.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { AudioOverlay, Clip } from "../../utils/videoEditTypes";
import { getWaveformPeaks, sliceWaveformWindow } from "../../utils/audioWaveform";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { readPreviewHead } from "../../utils/previewHead";
import { outputOffsetToSource } from "../../utils/clipTiming";
import { fadeLevel, type FadeCurve, type PieceFades } from "../../utils/audioJoins";
import { subscribeVideoFrames, wantVideoFrames, type FrameWant } from "../../utils/videoFrameCache";
import useCanvasRestoreTick from "../../hooks/useCanvasRestoreTick";

export const nearestFrame = (frames: ThumbFrame[], time: number): ThumbFrame | null => {
  if (frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(frames[lo - 1].time - time) <= Math.abs(frames[lo].time - time)) return frames[lo - 1];
  return frames[lo];
};

export interface ThumbFrame {
  time: number; // source time this frame was captured at
  src: string;
}

// A tile's ask: a frame within `tolerance` seconds of `time` (source time).
export interface DetailWant {
  time: number;
  tolerance: number;
}

export const ActionButton: React.FC<{
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, disabled, children }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    disabled={disabled}
    className="shrink-0 flex items-center justify-center w-7 h-7 rounded text-neutral-300 hover:bg-neutral-700 disabled:text-neutral-600 disabled:hover:bg-transparent disabled:cursor-default"
  >
    {children}
  </button>
);

// The audio-overlay chip's real waveform - a genuine decode (see audioWaveform.ts), not a
// decorative placeholder. Needs its own component (rather than being computed inline in the
// lane's .map() below) because decoding is async and per-file: each chip tracks its own decoded
// peaks via its own hook state, which .map() callbacks can't own directly. Re-slices (not
// re-decodes) whenever the visible window (trimStart/duration, from drag or resize) or pixel size
// changes, so a live trim drag updates the waveform every frame from already-decoded data.
// `visible`: the part of the chip (its own px) to draw - a canvas can't be millions of px wide.
// A fade's gain `x` seconds into it - the curves export gives afade (fade_curve, conversion.rs):
// straight for a fade set in the panel, a quarter sine for an automatic equal-power crossfade.
export const fadeGain = (x: number, d: number, curve: FadeCurve): number => {
  if (d <= 0) return 1;
  const t = Math.max(0, Math.min(1, x / d));
  return curve === "equalPower" ? Math.sin((t * Math.PI) / 2) : t;
};
export const sameFades = (a: PieceFades | undefined, b: PieceFades | undefined) =>
  a === b || (!!a && !!b && a.fadeIn === b.fadeIn && a.fadeOut === b.fadeOut && a.fadeInCurve === b.fadeInCurve && a.fadeOutCurve === b.fadeOutCurve);

// An audio piece's fades as they'll be heard (joinFades - its own, plus join crossfades), drawn on
// the chip the way editors show them: the stretch above the fade's curve shaded, the curve a line.
export const AudioFadeShade: React.FC<{ side: "in" | "out"; seconds: number; curve: FadeCurve; pxPerSec: number; widthPx: number; heightPx: number }> = ({ side, seconds, curve, pxPerSec, widthPx, heightPx }) => {
  const w = Math.min(widthPx, seconds * pxPerSec);
  if (w < 1.5 || heightPx <= 0) return null;
  const steps = 16;
  const pts: string[] = [];
  for (let k = 0; k <= steps; k++) {
    const x = (k / steps) * w;
    const gain = fadeGain(side === "in" ? x : w - x, w, curve);
    pts.push(`${x.toFixed(1)},${(heightPx * (1 - gain)).toFixed(1)}`);
  }
  const line = pts.join(" ");
  const area = side === "in" ? `0,0 ${w.toFixed(1)},0 ${line}` : `${line} ${w.toFixed(1)},0 0,0`;
  return (
    <svg className="absolute top-0 pointer-events-none z-[3]" style={{ [side === "in" ? "left" : "right"]: 0 }} width={w} height={heightPx} viewBox={`0 0 ${w} ${heightPx}`}>
      <polygon points={area} fill="rgba(0,0,0,0.42)" />
      <polyline points={line} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

// A fade's knob at the chip's top corner: drag it inward to fade in (or out) over longer, double-
// click to take the fade away. Shows the length while it moves. One undo step per drag (the store
// merges a run of the same edit).
export const AudioFadeKnob: React.FC<{
  side: "in" | "out";
  seconds: number;
  maxSeconds: number;
  pxPerSec: number;
  widthPx: number;
  shown: boolean;
  onChange: (seconds: number) => void;
}> = ({ side, seconds, maxSeconds, pxPerSec, widthPx, shown, onChange }) => {
  const drag = useRef<{ x: number; from: number; last: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const fadePx = Math.min(widthPx, seconds * pxPerSec);
  const size = 10;
  const left = side === "in" ? Math.max(2, Math.min(widthPx - size - 2, fadePx - size / 2)) : Math.max(2, Math.min(widthPx - size - 2, widthPx - fadePx - size / 2));
  const label = (s: number) => `Fade ${side} ${s < 10 ? s.toFixed(2) : s.toFixed(1)}s`;
  return (
    <div
      // Over the trim handle (z-12), which keeps the rest of the edge below this corner.
      className="tl-fade-knob absolute z-[13] cursor-ew-resize"
      data-on={shown || live !== null ? "true" : undefined}
      title={`${seconds > 0 ? label(seconds) : `Fade ${side}`} - drag to change, double-click to remove`}
      style={{ left, top: 3, width: size, height: size }}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, from: seconds, last: seconds };
        setLive(seconds);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = (e.clientX - d.x) / pxPerSec;
        const next = Math.round(Math.max(0, Math.min(maxSeconds, d.from + (side === "in" ? dx : -dx))) * 20) / 20;
        if (next === d.last) return;
        d.last = next;
        setLive(next);
        onChange(next);
      }}
      onPointerUp={(e) => {
        drag.current = null;
        setLive(null);
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setLive(null);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onChange(0);
      }}
    >
      <span className="block w-full h-full rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.6)] ring-1 ring-black/40" />
      {live !== null && (
        <span className={`absolute -top-[2px] ${side === "in" ? "left-[14px]" : "right-[14px]"} px-1 rounded-sm bg-black/80 text-[9px] leading-[13px] font-semibold tabular-nums text-white whitespace-nowrap pointer-events-none`}>
          {label(live)}
        </span>
      )}
    </div>
  );
};

export const AudioChipWaveform: React.FC<{ overlay: AudioOverlay; widthPx: number; heightPx: number; visible: [number, number]; fades?: PieceFades }> = React.memo(({ overlay, widthPx, heightPx, visible, fades }) => {
  const [vFrom, vTo] = [Math.max(0, visible[0]), Math.min(widthPx, visible[1])];
  const vWidth = Math.max(0, vTo - vFrom);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const canvasRestoreTick = useCanvasRestoreTick();

  useEffect(() => {
    let cancelled = false;
    getWaveformPeaks(overlay.src)
      .then((p) => {
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        /* getWaveformPeaks already logs - a failed decode just leaves the chip waveform-less */
      });
    return () => {
      cancelled = true;
    };
  }, [overlay.src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || vWidth <= 0 || heightPx <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(vWidth * dpr));
    canvas.height = Math.max(1, Math.round(heightPx * dpr));
    ctx.scale(dpr, dpr);

    const duration = overlay.endTime - overlay.startTime;
    const secPerPx = duration / widthPx;
    const buckets = Math.max(8, Math.floor(vWidth / 2));
    const windowed = sliceWaveformWindow(peaks, overlay.sourceDuration, overlay.trimStart + vFrom * secPerPx, vWidth * secPerPx, buckets);
    const barWidth = vWidth / buckets;
    // Through a fade the bars taper exactly as the sound does (the same gain the mix applies).
    ctx.fillStyle = overlay.muted ? "rgba(212,212,216,0.55)" : "rgba(204,251,241,0.88)";
    windowed.forEach((amp, i) => {
      const t = (vFrom + (i + 0.5) * barWidth) * secPerPx;
      const gain = fades ? fadeLevel(fades, t, duration) : 1;
      const barHeight = Math.max(1, amp * gain * heightPx);
      ctx.fillRect(i * barWidth, (heightPx - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
    });
    // canvasRestoreTick: a pure redraw trigger, see useCanvasRestoreTick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, widthPx, heightPx, vFrom, vWidth, overlay.trimStart, overlay.startTime, overlay.endTime, overlay.sourceDuration, overlay.muted, fades?.fadeIn, fades?.fadeOut, fades?.fadeInCurve, fades?.fadeOutCurve, canvasRestoreTick]);

  return <canvas ref={canvasRef} className="absolute top-0 pointer-events-none" style={{ left: vFrom, width: vWidth, height: heightPx }} />;
}, (prev, next) =>
  prev.overlay === next.overlay &&
  prev.widthPx === next.widthPx &&
  prev.heightPx === next.heightPx &&
  prev.visible[0] === next.visible[0] &&
  prev.visible[1] === next.visible[1] &&
  sameFades(prev.fades, next.fades)
);

// The audio panel's preview position on its own track (previewHead.ts) - a line with the time, moved
// straight on the DOM every frame (the timeline itself never re-renders for it). While the preview
// plays, the timeline scrolls to keep the line in view. The line (or its time tag) can be dragged
// back and forth to scrub the preview - it never drags the track itself.
export const PreviewHeadLine: React.FC<{ overlayId: string; trimStart: number; pxPerSec: number; chipLeft: number; scrollRef: React.RefObject<HTMLDivElement | null> }> = ({
  overlayId,
  trimStart,
  pxPerSec,
  chipLeft,
  scrollRef,
}) => {
  const lineRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const geometry = useRef({ trimStart, pxPerSec, chipLeft });
  geometry.current = { trimStart, pxPerSec, chipLeft };
  const draggingRef = useRef(false);
  const scrubTo = (clientX: number) => {
    const chip = lineRef.current?.parentElement;
    const head = readPreviewHead(overlayId);
    if (!chip || !head) return;
    const { trimStart: from, pxPerSec: pps } = geometry.current;
    head.seek(from + (clientX - chip.getBoundingClientRect().left) / pps);
  };
  const grab = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      draggingRef.current = true;
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      e.stopPropagation();
      scrubTo(e.clientX);
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      e.stopPropagation();
      draggingRef.current = false;
      scrubTo(e.clientX);
    },
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
  };
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const line = lineRef.current;
      if (!line) return;
      const head = readPreviewHead(overlayId);
      if (!head || !head.visible) {
        line.style.display = "none";
        return;
      }
      const { trimStart: from, pxPerSec: pps, chipLeft: left } = geometry.current;
      const x = (head.at - from) * pps;
      line.style.display = "block";
      line.style.transform = `translateX(${x.toFixed(1)}px)`;
      if (labelRef.current) {
        const s = head.at - from;
        labelRef.current.textContent = `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
      }
      const area = scrollRef.current;
      if (head.playing && head.leads && area && !draggingRef.current) {
        const abs = left + x;
        if (abs < area.scrollLeft + 24 || abs > area.scrollLeft + area.clientWidth - 48) area.scrollLeft = Math.max(0, abs - area.clientWidth * 0.25);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [overlayId, scrollRef]);
  return (
    <div ref={lineRef} className="absolute inset-y-0 left-0 z-20 pointer-events-none" style={{ display: "none" }}>
      <div className="absolute inset-y-0 -left-px w-0.5 bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,0.9)]" />
      {/* The grab zone - wider than the line, so it's easy to catch. */}
      <div {...grab} title="Drag to scrub" className="absolute inset-y-0 -left-[5px] w-[10px] pointer-events-auto cursor-ew-resize" />
      <span
        {...grab}
        ref={labelRef}
        title="Drag to scrub"
        className="absolute top-0 left-1 px-1 rounded-b text-[9px] font-medium tabular-nums text-black bg-amber-300 pointer-events-auto cursor-ew-resize select-none"
      />
    </div>
  );
};

export const IMAGE_CLIP_TOOL_HINT = "Not available for image clips";

// The classic spoked "wheel" activity indicator - 12 spokes fading round the circle, spun fast.
export const SpokeWheel: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin text-white" style={{ animationDuration: "0.5s" }} aria-hidden>
    {Array.from({ length: 12 }, (_, i) => (
      <line key={i} x1="12" y1="2.5" x2="12" y2="7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity={0.15 + (0.85 * i) / 11} transform={`rotate(${i * 30} 12 12)`} />
    ))}
  </svg>
);

// A fixed-position menu kept fully inside the window - the track's "..." menu opens from a button
// near the bottom of the screen, where opening straight down used to cut most of it off.
export const ViewportClampedMenu: React.FC<{ anchor: PopoverAnchor; className: string; children: React.ReactNode }> = ({ anchor, className, children }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  return (
    <div ref={ref} className={`fixed ${className}`} style={{ top: position.top, left: position.left }}>
      {children}
    </div>
  );
};
// How long a freeze frame holds (clip menu) - stretch it on the timeline like any image clip.
export const FREEZE_FRAME_SECONDS = 2;

// Space kept past the last clip for the "+" add button (36px wide, 10px from the clip).
export const ADD_BUTTON_ROOM_PX = 56;

// An image clip's filmstrip - the same picture on every tile, from the gallery's own cached
// thumbnail (get_image_thumbnail) rather than a full-resolution photo decode per tile. The primary
// file's frame cache above can't serve these: it only ever holds frames of the primary video.
const imageClipThumbUrls = new Map<string, Promise<string>>();
// Tiles [first, last) only - the caller puts a spacer before them (see drawWindow).
export const ImageClipTiles: React.FC<{ sourcePath: string; first: number; last: number; tileWidth: number }> = ({ sourcePath, first, last, tileWidth }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let pending = imageClipThumbUrls.get(sourcePath);
    if (!pending) {
      pending = invoke<string>("get_image_thumbnail", { inputPath: sourcePath })
        .then((thumbPath) => invoke<string>("convert_file_path_to_url", { filepath: thumbPath }))
        .then((absolutePath) => convertFileSrc(absolutePath));
      pending.catch(() => imageClipThumbUrls.delete(sourcePath)); // let a later render retry
      imageClipThumbUrls.set(sourcePath, pending);
    }
    pending
      .then((resolved) => !cancelled && setUrl(resolved))
      .catch((err) => console.error("Failed to load image clip thumbnail for", sourcePath, err));
    return () => {
      cancelled = true;
    };
  }, [sourcePath]);
  return (
    <>
      {Array.from({ length: last - first }, (_, j) => first + j).map((i) =>
        url ? (
          <img key={i} src={url} className="h-full shrink-0 object-cover" style={{ width: tileWidth }} draggable={false} alt="" />
        ) : (
          <div key={i} className="h-full shrink-0 bg-neutral-800" style={{ width: tileWidth }} />
        )
      )}
    </>
  );
};

// A video clip from a file other than the primary one - its own frames (videoFrameCache.ts),
// never the primary's: borrowing those is what made an inserted video show the clips around it.
// Like the primary's strip, the tiles drawn ask for a frame inside their own stretch of source,
// nearest `viewCenter` (px into the clip) first - exact when zoomed into a long video.
export const ForeignVideoClipTiles: React.FC<{ clip: Clip; first: number; last: number; tileWidth: number; width: number; pxPerSec: number; viewCenter: number }> = ({ clip, first, last, tileWidth, width, pxPerSec, viewCenter }) => {
  const [frames, setFrames] = useState<ThumbFrame[]>([]);
  const owner = useRef({}).current;
  useEffect(() => {
    setFrames([]);
    const stop = subscribeVideoFrames(clip.sourcePath, setFrames);
    return () => {
      wantVideoFrames(clip.sourcePath, owner, []);
      stop();
    };
  }, [clip.sourcePath, owner]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const tolerance = Math.max(0.25, ((tileWidth / pxPerSec) * (clip.speed ?? 1)) / 2);
      const wants: (FrameWant & { distance: number })[] = [];
      for (let k = first; k < last; k++) {
        const time = Math.min(clip.end, outputOffsetToSource(clip, Math.min((k + 0.5) * tileWidth, width) / pxPerSec));
        wants.push({ time, tolerance, distance: Math.abs((k + 0.5) * tileWidth - viewCenter) });
      }
      wants.sort((a, b) => a.distance - b.distance);
      wantVideoFrames(clip.sourcePath, owner, wants.map(({ time, tolerance }) => ({ time, tolerance })));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [clip, first, last, tileWidth, width, pxPerSec, viewCenter, owner]);
  return (
    <>
      {Array.from({ length: last - first }, (_, j) => first + j).map((k) => {
        const outputOffset = Math.min((k + 0.5) * tileWidth, width) / pxPerSec;
        const t = nearestFrame(frames, Math.min(clip.end, outputOffsetToSource(clip, outputOffset)));
        return t ? (
          <img key={k} src={t.src} className="h-full shrink-0 object-cover" style={{ width: tileWidth }} draggable={false} alt="" />
        ) : (
          <div key={k} className="h-full shrink-0 bg-neutral-800" style={{ width: tileWidth }} />
        );
      })}
    </>
  );
};

// Real waveform for a CLIP's own audio (not an AudioOverlay) - same decode-once/slice-per-render
// shape as AudioChipWaveform above, just keyed by the clip's sourcePath/start/end instead of an
// overlay's src/trimStart/duration, so a clip's trim handles have precise audio-driven cut points
// to line up against instead of guessing from the filmstrip's video frames alone. Drawn baseline-up
// as a bottom ledge (not centered, unlike the audio-overlay chip) with its own scrim behind it, so
// it reads clearly over a filmstrip frame of any brightness instead of competing with it.
export const ClipWaveform: React.FC<{ sourcePath: string; trimStart: number; trimEnd: number; sourceDuration: number | null; widthPx: number; heightPx: number; visible: [number, number] }> = React.memo(({
  sourcePath,
  trimStart,
  trimEnd,
  sourceDuration,
  widthPx,
  heightPx,
  visible,
}) => {
  // Only the visible part of the clip (its own px) is drawn - see AudioChipWaveform.
  const [vFrom, vTo] = [Math.max(0, visible[0]), Math.min(widthPx, visible[1])];
  const vWidth = Math.max(0, vTo - vFrom);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const canvasRestoreTick = useCanvasRestoreTick();

  useEffect(() => {
    let cancelled = false;
    getWaveformPeaks(sourcePath)
      .then((p) => {
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        /* getWaveformPeaks already logs - a source with no audio track (or a failed decode) just
           leaves this clip waveform-less, same degradation AudioChipWaveform already accepts. */
      });
    return () => {
      cancelled = true;
    };
  }, [sourcePath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || !sourceDuration || vWidth <= 0 || heightPx <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(vWidth * dpr));
    canvas.height = Math.max(1, Math.round(heightPx * dpr));
    ctx.scale(dpr, dpr);

    const duration = Math.max(0, trimEnd - trimStart);
    const secPerPx = duration / Math.max(1, widthPx);
    const buckets = Math.max(8, Math.floor(vWidth / 2));
    const windowed = sliceWaveformWindow(peaks, sourceDuration, trimStart + vFrom * secPerPx, vWidth * secPerPx, buckets);
    const barWidth = vWidth / buckets;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    windowed.forEach((amp, i) => {
      const barHeight = Math.max(1, amp * heightPx);
      ctx.fillRect(i * barWidth, heightPx - barHeight, Math.max(1, barWidth - 1), barHeight);
    });
    // canvasRestoreTick: a pure redraw trigger, see useCanvasRestoreTick.
  }, [peaks, widthPx, heightPx, vFrom, vWidth, trimStart, trimEnd, sourceDuration, canvasRestoreTick]);

  if (!peaks) return null;
  return (
    <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{ height: heightPx }}>
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
      <canvas ref={canvasRef} className="absolute top-0" style={{ left: vFrom, width: vWidth, height: heightPx }} />
    </div>
  );
}, (prev, next) =>
  prev.sourcePath === next.sourcePath &&
  prev.trimStart === next.trimStart &&
  prev.trimEnd === next.trimEnd &&
  prev.sourceDuration === next.sourceDuration &&
  prev.widthPx === next.widthPx &&
  prev.heightPx === next.heightPx &&
  prev.visible[0] === next.visible[0] &&
  prev.visible[1] === next.visible[1]
);

// The main video's own audio level (volume + mute) - see videoEditTypes.ts's
// videoAudioMuted/videoAudioVolume doc comment for why this is separate from any AudioOverlay's
// own volume/mute. Its own component (rather than inlined in the lane's JSX) purely so
// useClampedPopoverPosition - which measures this popover's actual rendered size to keep it
// on-screen, see that hook's own comment for why the raw anchor alone isn't enough near the
// bottom of the window - can be called unconditionally the way hooks require; the parent only
// mounts this at all while the popover should be showing.
export const TrackAudioPopover: React.FC<{
  anchor: PopoverAnchor;
  volume: number;
  muted: boolean;
  onSetVolume: (volume: number) => void;
  onSetMuted: (muted: boolean) => void;
}> = ({ anchor, volume, muted, onSetVolume, onSetMuted }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  return createPortal(
    <div
      ref={ref}
      data-track-audio-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-56 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
    >
      <span className="text-xs font-medium">Video audio</span>
      <label className="flex items-center gap-2 text-[11px]">
        <span className="w-12 shrink-0 text-white/60">Volume</span>
        <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => onSetVolume(Number(e.target.value))} className="flex-1 accent-teal-400" />
        <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(volume * 100)}%</span>
      </label>
      <button
        type="button"
        onClick={() => onSetMuted(!muted)}
        className={`self-start px-2 py-1 rounded text-[11px] transition-colors ${muted ? "text-red-400 bg-red-500/10" : "text-white/70 hover:text-white hover:bg-white/10"}`}
      >
        {muted ? "Muted" : "Mute"}
      </button>
    </div>,
    document.body
  );
};

// Horizontally scrollable toolbar cluster that stays dead-center aligned with static tools on both
// sides (no scrollbar height offset) and displays subtle fade + chevron edge indicators whenever
// hidden tools are available to scroll left or right.
export const ScrollableToolbarStrip: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const sync = () => {
      const maxScroll = el.scrollWidth - el.clientWidth;
      setCanLeft(el.scrollLeft > 2);
      setCanRight(maxScroll - el.scrollLeft > 2);
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, []);

  const nudge = (delta: number) => {
    scrollerRef.current?.scrollBy({ left: delta, behavior: "smooth" });
  };

  return (
    <div className="relative flex items-center min-w-0 flex-1 h-7">
      <div
        ref={scrollerRef}
        onWheel={(e) => {
          const el = scrollerRef.current;
          if (!el || el.scrollWidth <= el.clientWidth) return;
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.preventDefault();
            el.scrollLeft += e.deltaY;
          }
        }}
        className="timeline-toolbar-scroll flex items-center gap-0.5 min-w-0 w-full h-7 overflow-x-auto overflow-y-hidden"
      >
        {children}
      </div>
      {canLeft && (
        <div className="pointer-events-none absolute left-0 inset-y-0 w-8 flex items-center justify-start bg-gradient-to-r from-neutral-900 via-neutral-900/90 to-transparent">
          <button
            type="button"
            title="Scroll tools left"
            aria-label="Scroll tools left"
            onClick={() => nudge(-180)}
            className="pointer-events-auto flex items-center justify-center w-5 h-6 rounded bg-neutral-800/95 hover:bg-neutral-700 text-neutral-200 ring-1 ring-white/15 shadow transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        </div>
      )}
      {canRight && (
        <div className="pointer-events-none absolute right-0 inset-y-0 w-8 flex items-center justify-end bg-gradient-to-l from-neutral-900 via-neutral-900/90 to-transparent">
          <button
            type="button"
            title="More tools — scroll right"
            aria-label="Scroll tools right"
            onClick={() => nudge(180)}
            className="pointer-events-auto flex items-center justify-center w-5 h-6 rounded bg-neutral-800/95 hover:bg-neutral-700 text-neutral-200 ring-1 ring-white/15 shadow transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};

