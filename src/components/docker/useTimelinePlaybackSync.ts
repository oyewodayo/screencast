// components/docker/useTimelinePlaybackSync.ts
//
// Keeps main-player playback synchronized with the timeline's edited clip sequence:
//   - Bootstraps playback onto clip 0 (or the saved return position) when a file/reorder loads.
//   - Advances smoothly from clip N to clip N+1 in playback order (via timeupdate + 60fps rAF
//     boundary checks) and pauses cleanly at the end of the final clip.
//   - Restarts from clip 0 if Play is triggered while parked at the very end of the sequence.
import React, { useEffect, useRef } from "react";
import { getResumeTime } from "../../utils/playbackResume";
import type { Clip } from "../../utils/videoEditTypes";
import {
  bootstrappedClipIdByFile,
  CLIP_END_EPSILON_SEC,
  FRAME_BOUNDARY_SEC,
  leftAtByFile,
  SEEK_TOLERANCE_SEC,
} from "./timelineHelpers";

export interface UseTimelinePlaybackSyncParams {
  filePath: string;
  isProject: boolean;
  editLoading: boolean;
  baseClips: Clip[];
  editClips: Clip[];
  renderClipsCount: number;
  currentTime: number;
  isPlaying: boolean;
  activeClipIndexRef: React.MutableRefObject<number>;
  lastAppliedTimeRef: React.MutableRefObject<number>;
  setActiveClipIndex: (index: number) => void;
  onSeek: (sourcePath: string, time: number, resume?: boolean) => void;
  onTogglePlay: () => void;
  onPausePlayer?: () => void;
  getPlayerTime?: () => number | null;
  seekToOutputTime: (outputTime: number) => void;
}

export function useTimelinePlaybackSync({
  filePath,
  isProject,
  editLoading,
  baseClips,
  editClips,
  renderClipsCount,
  currentTime,
  isPlaying,
  activeClipIndexRef,
  lastAppliedTimeRef,
  setActiveClipIndex,
  onSeek,
  onTogglePlay,
  onPausePlayer,
  getPlayerTime,
  seekToOutputTime,
}: UseTimelinePlaybackSyncParams) {
  const stopRequestedRef = useRef(false);
  const wasPlayingRef = useRef(false);

  const advanceToClip = (index: number, resume: boolean) => {
    const clip = baseClips[index];
    setActiveClipIndex(index);
    lastAppliedTimeRef.current = clip.start;
    onSeek(clip.sourcePath, clip.start, resume);
  };

  const stopAtEnd = () => {
    if (onPausePlayer) return onPausePlayer();
    if (stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    onTogglePlay();
  };

  // Bootstrap: force playback onto clip 0 (or saved return point) when a new first clip loads.
  useEffect(() => {
    const first = baseClips[0];
    if (!first && isProject && !editLoading) {
      bootstrappedClipIdByFile.delete(filePath);
      setActiveClipIndex(0);
      onSeek(filePath, 0);
      return;
    }
    if (!first || first.id === "__pending__") return;
    if (bootstrappedClipIdByFile.get(filePath) === first.id) {
      if (activeClipIndexRef.current < 0 || activeClipIndexRef.current >= baseClips.length) {
        const idx = baseClips.findIndex(
          (c) => c.sourcePath === filePath && currentTime >= c.start - SEEK_TOLERANCE_SEC && currentTime <= c.end + SEEK_TOLERANCE_SEC
        );
        setActiveClipIndex(idx >= 0 ? idx : 0);
      }
      return;
    }
    bootstrappedClipIdByFile.set(filePath, first.id);
    const leftAt = leftAtByFile.get(filePath);
    leftAtByFile.delete(filePath);
    const playerAt = getResumeTime(filePath);
    const unchanged =
      leftAt && (leftAt.playerAt === undefined ? playerAt === undefined : playerAt !== undefined && Math.abs(playerAt - leftAt.playerAt) < 1.5);
    if (leftAt && unchanged && leftAt.outputTime > 0 && renderClipsCount > 0) {
      seekToOutputTime(leftAt.outputTime);
      return;
    }
    setActiveClipIndex(0);
    lastAppliedTimeRef.current = first.start;
    onSeek(first.sourcePath, first.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseClips[0]?.id]);

  // Live-preview advancement on timeupdate ticks.
  useEffect(() => {
    if (baseClips.length === 0 || currentTime === lastAppliedTimeRef.current) return;
    const activeIdx = activeClipIndexRef.current;
    if (activeIdx < 0 || activeIdx >= baseClips.length) return;
    const active = baseClips[activeIdx];
    if (currentTime >= active.start - SEEK_TOLERANCE_SEC && currentTime < active.end - CLIP_END_EPSILON_SEC) return;

    const nextIndex = activeIdx + 1;
    if (nextIndex < baseClips.length) {
      advanceToClip(nextIndex, isPlaying || wasPlayingRef.current);
    } else if (isPlaying && currentTime >= active.end - CLIP_END_EPSILON_SEC) {
      stopAtEnd();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, editClips]);

  // Per-frame boundary check while playing so clip cuts happen on the exact frame.
  const boundaryCheckRef = useRef<() => void>(() => {});
  boundaryCheckRef.current = () => {
    const t = getPlayerTime?.();
    const index = activeClipIndexRef.current;
    const clip = baseClips[index];
    if (t == null || !clip || t < clip.start - SEEK_TOLERANCE_SEC) return;
    if (t < clip.end - FRAME_BOUNDARY_SEC) return;
    if (index + 1 < baseClips.length) advanceToClip(index + 1, true);
    else stopAtEnd();
  };

  useEffect(() => {
    if (isPlaying) stopRequestedRef.current = false;
    if (!isPlaying) return;
    const lastIndex = baseClips.length - 1;
    const last = baseClips[lastIndex];
    const t = getPlayerTime?.() ?? currentTime;
    if (last && activeClipIndexRef.current >= lastIndex && t >= last.end - SEEK_TOLERANCE_SEC) advanceToClip(0, true);
    if (!getPlayerTime) return;
    let raf = 0;
    const tick = () => {
      boundaryCheckRef.current();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, getPlayerTime]);

  useEffect(() => {
    wasPlayingRef.current = isPlaying;
  });
}
