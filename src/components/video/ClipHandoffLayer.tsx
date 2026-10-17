// components/video/ClipHandoffLayer.tsx
//
// Gapless playback across clip boundaries. The timeline previews by pointing one <video> at each
// clip's source in turn; when the next clip lives in another file (every image clip is its own
// proxy video) or elsewhere in the same file, that player has to load or seek before it can show
// anything, and playback visibly stalled at every cut.
//
// While a clip plays, this layer warms the NEXT one: a detached <video> on its source, seeked to its
// first frame and decoded. When playback crosses the cut, Dashboard hands over to it (begin()) in the
// same tick: it's mounted over the player with the incoming clip's look (crop, Ken Burns, mirror,
// colour preset and grade - the same clipFrameStyle/GradeCanvas pair the transition preview uses) and
// plays on. The main player loads underneath, seeks to wherever the standby has got to
// (targetTime()), and once it's on that frame the standby steps aside - the swap lands on the same
// picture, so it can't be seen. Meanwhile state() stands in for the player's own playback state, so
// the playhead, the transition preview and music sync all keep moving through the switch.
//
// Sound: the standby plays the clip's audio at the player's volume until the player takes over.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { FrameRect } from "../../utils/videoFrameRect";
import { Clip } from "../../utils/videoEditTypes";
import { clipFrameStyle } from "../../utils/videoColorFilters";
import { clipOutputDuration, sourceToOutputOffset, speedAtSource } from "../../utils/clipTiming";
import { Lut3D, hasGrade } from "../../utils/colorGrade";
import { bakedLutForGrade } from "../../utils/gradeLuts";
import GradeCanvas from "./GradeCanvas";

export interface PlaybackState {
  src: string | null;
  time: number;
  hasFrame: boolean;
  paused: boolean;
  seeking?: boolean;
  volume?: number;
  muted?: boolean;
}

export interface ClipHandoffApi {
  // Takes over playback of `sourcePath` from `start` if a warmed standby is ready for it.
  begin: (sourcePath: string, start: number) => boolean;
  cancel: () => void;
  isActive: () => boolean;
  // The standby's state while it's on screen.
  state: () => PlaybackState | null;
  // Where the main player should seek to land on the standby's frame.
  targetTime: () => number;
}

interface ClipHandoffLayerProps {
  frameRect: FrameRect;
  clips: Clip[];
  activeClipId: string | null;
  apiRef: React.MutableRefObject<ClipHandoffApi | null>;
  resolveClipUrl: (sourcePath: string) => Promise<string>;
  // The main player's own state (never the handoff stand-in).
  getMainState: () => PlaybackState | null;
  // True while the main player is still loading a source switch.
  isMainSwitching: () => boolean;
  seekMain: (time: number) => void;
  // Reports the standby's source time a few times a second while it's on screen (the playhead).
  onTime: (time: number) => void;
}

interface Standby {
  key: string;
  clipId: string;
  sourcePath: string;
  start: number;
  url: string;
  video: HTMLVideoElement;
}

// How far ahead of the standby the main player seeks - roughly one seek's latency, so it lands level.
const SEEK_LEAD_SEC = 0.08;
// Close enough to swap without a visible jump (about two frames).
const SYNC_TOLERANCE_SEC = 0.07;
// A handoff that never syncs (a source that won't load) gives up and shows the player as it is.
const MAX_HANDOFF_MS = 4000;
const POOL_MAX = 3;

const needsHandoff = (from: Clip, to: Clip) => to.sourcePath !== from.sourcePath || Math.abs(to.start - from.end) > 0.05;

const ClipHandoffLayer: React.FC<ClipHandoffLayerProps> = ({ frameRect, clips, activeClipId, apiRef, resolveClipUrl, getMainState, isMainSwitching, seekMain, onTime }) => {
  const poolRef = useRef<Map<string, Standby>>(new Map());
  const [active, setActive] = useState<{ standby: Standby; clip: Clip; lut: Lut3D | null } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const lutsRef = useRef<Map<string, Lut3D | null>>(new Map());

  const release = (s: Standby) => {
    s.video.pause();
    s.video.removeAttribute("src");
    s.video.load(); // frees the decoder
  };

  // Warm the clip after the one on screen.
  const activeIndex = activeClipId ? clips.findIndex((c) => c.id === activeClipId) : -1;
  const current = activeIndex >= 0 ? clips[activeIndex] : undefined;
  const next = activeIndex >= 0 ? clips[activeIndex + 1] : undefined;
  const nextKey = current && next && needsHandoff(current, next) ? `${next.sourcePath}|${next.start.toFixed(3)}` : null;
  useEffect(() => {
    if (!next || !nextKey) return;
    let cancelled = false;
    const pool = poolRef.current;
    resolveClipUrl(next.sourcePath)
      .then((url) => {
        if (cancelled) return;
        let s = pool.get(nextKey);
        if (s && s.url !== url) {
          release(s);
          pool.delete(nextKey);
          s = undefined;
        }
        if (!s) {
          const video = document.createElement("video");
          video.muted = true;
          video.preload = "auto";
          video.playsInline = true;
          video.crossOrigin = "anonymous"; // GradeCanvas reads its frames, as it does the player's
          video.src = url;
          video.currentTime = next.start;
          s = { key: nextKey, clipId: next.id, sourcePath: next.sourcePath, start: next.start, url, video };
          pool.set(nextKey, s);
        } else {
          s.clipId = next.id;
          if (s.video.paused && Math.abs(s.video.currentTime - next.start) > 0.01) s.video.currentTime = next.start;
        }
        // Evict the oldest standbys not on screen.
        for (const [k, old] of pool) {
          if (pool.size <= POOL_MAX) break;
          if (old === activeRef.current?.standby || k === nextKey) continue;
          release(old);
          pool.delete(k);
        }
      })
      .catch(() => {});
    if (hasGrade(next.grade) && !lutsRef.current.has(next.id)) {
      bakedLutForGrade(next.grade)
        .then((lut) => lutsRef.current.set(next.id, lut))
        .catch(() => lutsRef.current.set(next.id, null));
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextKey, next?.id, resolveClipUrl]);

  useEffect(
    () => () => {
      for (const s of poolRef.current.values()) release(s);
      poolRef.current.clear();
    },
    []
  );

  const finish = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    a.standby.video.pause();
    a.standby.video.muted = true;
    // Ready for a replay of the same cut.
    a.standby.video.currentTime = a.standby.start;
    activeRef.current = null;
    setActive(null);
  }, []);

  useEffect(() => {
    apiRef.current = {
      begin: (sourcePath, start) => {
        const s = [...poolRef.current.values()].find((x) => x.sourcePath === sourcePath && Math.abs(x.start - start) < 0.01);
        const clip = s ? clipsRef.current.find((c) => c.id === s.clipId) : undefined;
        const v = s?.video;
        if (!s || !clip || !v || v.readyState < 2 || v.seeking || Math.abs(v.currentTime - start) > 0.05) return false;
        const main = getMainState();
        v.volume = Math.max(0, Math.min(1, main?.volume ?? 1));
        v.muted = !!main?.muted || !!clip.muted;
        v.playbackRate = Math.max(0.0625, Math.min(16, speedAtSource(clip, start)));
        void v.play().catch(() => {});
        const next = { standby: s, clip, lut: lutsRef.current.get(clip.id) ?? null };
        activeRef.current = next;
        setActive(next);
        return true;
      },
      cancel: finish,
      isActive: () => activeRef.current !== null,
      state: () => {
        const a = activeRef.current;
        if (!a) return null;
        const v = a.standby.video;
        return { src: a.standby.url, time: v.currentTime, hasFrame: v.readyState >= 2, paused: v.paused, seeking: v.seeking };
      },
      targetTime: () => {
        const a = activeRef.current;
        return a ? a.standby.video.currentTime + SEEK_LEAD_SEC * a.standby.video.playbackRate : 0;
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, finish, getMainState]);

  // While on screen: follow the clip's Ken Burns, report time, and step aside once the player is level.
  const hostRef = useRef<HTMLDivElement>(null);
  const lookRef = useRef<HTMLDivElement>(null);
  const standbyVideoRef = useRef<HTMLVideoElement | null>(null);
  standbyVideoRef.current = active?.standby.video ?? null;
  const W = frameRect.width;
  const H = frameRect.height;
  useEffect(() => {
    const host = hostRef.current;
    if (!active || !host) return;
    const { standby, clip } = active;
    const video = standby.video;
    video.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
    host.replaceChildren(video);
    const began = performance.now();
    let lastReport = 0;
    let raf = 0;
    const duration = clipOutputDuration(clip);
    const tick = () => {
      const now = performance.now();
      const look = lookRef.current;
      if (look) {
        const progress = duration > 0 ? sourceToOutputOffset(clip, video.currentTime) / duration : 0;
        const style = clipFrameStyle(clip, Math.max(0, Math.min(1, progress)), { width: W, height: H });
        look.style.transform = style.transform;
        look.style.filter = style.filter;
      }
      if (now - lastReport > 200) {
        lastReport = now;
        onTime(video.currentTime);
      }
      const main = getMainState();
      if (main && !isMainSwitching() && main.hasFrame && !main.seeking) {
        const gap = main.time - video.currentTime;
        if (Math.abs(gap) <= SYNC_TOLERANCE_SEC) return finish();
        // Loaded but not level (it started from the cut, or drifted): put it where the standby is.
        if (gap < -SYNC_TOLERANCE_SEC || gap > 0.25) seekMain(video.currentTime + SEEK_LEAD_SEC * video.playbackRate);
      }
      if (now - began > MAX_HANDOFF_MS || video.ended) return finish();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      host.replaceChildren();
    };
  }, [active, W, H, finish, getMainState, isMainSwitching, seekMain, onTime]);

  if (!active) return null;
  const L = frameRect.left;
  const T = frameRect.top;
  const containerW = W + 2 * L;
  const containerH = H + 2 * T;
  const initial = clipFrameStyle(active.clip, 0, { width: W, height: H });
  return (
    <div
      className="absolute pointer-events-none bg-black"
      // The player's whole <video> box, clipped to the picture - same placement as the player itself.
      style={{ left: -L, top: -T, width: containerW, height: containerH, clipPath: `inset(${T}px ${L}px ${T}px ${L}px)` }}
    >
      <div ref={lookRef} className="absolute inset-0" style={{ transform: initial.transform || undefined, filter: initial.filter || undefined }}>
        <div ref={hostRef} className="absolute inset-0" />
        {active.lut && <GradeCanvas key={active.standby.key} videoRef={standbyVideoRef} lut={active.lut} />}
      </div>
    </div>
  );
};

export default ClipHandoffLayer;
