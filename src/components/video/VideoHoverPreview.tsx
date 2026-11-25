// components/video/VideoHoverPreview.tsx
//
// Shared, zero-overhead hover/focus video preview used by VideoEditorHome, VideoFolderGallery, and
// SidebarFileIcon. Guarantees:
//   1. At most ONE <video> decoder active across the entire window at any instant (moving from the
//      sidebar to the gallery or vice versa immediately tears down the previous decoder).
//   2. A 350ms dwell delay before mounting <video> so fast pointer sweeps allocate zero decoders.
//   3. Keyed per-tile subscriptions so activating/stopping a preview re-renders ONLY the 1-2
//      affected overlays, never parent grids or sibling rows.
//   4. Explicit pause + src removal + load() on unmount to release WebView2/Chromium media
//      pipelines immediately, plus automatic teardown on window blur / tab hide.
//   5. Session-cached skip list for codecs WebView2 cannot decode (e.g. some .avi containers), so
//      re-hovering them never spawns a doomed decoder twice.

import React, { memo, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isVideoProjectPath } from "../../utils/videoEditTypes";

export const HOVER_PREVIEW_DELAY_MS = 350;

type Listener = () => void;

const listenersByKey = new Map<string, Set<Listener>>();
const unplayablePaths = new Set<string>();

let activeKey: string | null = null;
let pendingKey: string | null = null;
let pendingTimer: number | null = null;

function previewKey(scope: string, path: string): string {
  return `${scope}\0${path}`;
}

function notifyKey(key: string | null) {
  if (!key) return;
  const set = listenersByKey.get(key);
  if (!set) return;
  for (const fn of set) fn();
}

function setActiveKey(next: string | null) {
  if (activeKey === next) return;
  const prev = activeKey;
  activeKey = next;
  notifyKey(prev);
  notifyKey(next);
}

function clearPendingTimer() {
  if (pendingTimer !== null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingKey = null;
}

export function canHoverPreviewVideo(path: string, size?: number): boolean {
  if (!path) return false;
  if (size !== undefined && size <= 0) return false;
  if (isVideoProjectPath(path)) return false;
  if (unplayablePaths.has(path)) return false;
  return true;
}

/**
 * Schedules a muted hover/focus preview for `(scope, path)` after a short dwell delay.
 * Immediately stops any preview currently playing on a different tile.
 */
export function scheduleVideoPreview(scope: string, path: string, size?: number): void {
  if (!canHoverPreviewVideo(path, size)) {
    stopAllVideoPreviews();
    return;
  }
  const key = previewKey(scope, path);
  if (activeKey === key) {
    clearPendingTimer();
    return;
  }
  if (pendingKey === key) return;
  // Release any previous decoder right away so two previews never overlap.
  setActiveKey(null);
  clearPendingTimer();
  pendingKey = key;
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    if (pendingKey === key) {
      pendingKey = null;
      setActiveKey(key);
    }
  }, HOVER_PREVIEW_DELAY_MS);
}

/**
 * Immediately cancels a pending or active preview for `(scope, path)`.
 */
export function cancelVideoPreview(scope: string, path: string): void {
  const key = previewKey(scope, path);
  if (pendingKey === key) clearPendingTimer();
  if (activeKey === key) setActiveKey(null);
}

/**
 * Stops whichever hover preview is currently scheduled or playing anywhere in the app.
 */
export function stopAllVideoPreviews(): void {
  clearPendingTimer();
  setActiveKey(null);
}

function subscribeKey(key: string, listener: Listener): () => void {
  let set = listenersByKey.get(key);
  if (!set) {
    set = new Set();
    listenersByKey.set(key, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listenersByKey.delete(key);
  };
}

// Tear down any running preview if the window loses focus or is hidden.
if (typeof window !== "undefined") {
  window.addEventListener("blur", stopAllVideoPreviews);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAllVideoPreviews();
  });
}

export function useIsVideoPreviewActive(scope: string, path: string): boolean {
  const key = previewKey(scope, path);
  const [active, setActive] = useState(() => activeKey === key);

  useEffect(() => {
    setActive(activeKey === key);
    return subscribeKey(key, () => setActive(activeKey === key));
  }, [key]);

  return active;
}

interface VideoHoverPlayerProps {
  path: string;
  /** Optional known start offset in seconds; if omitted, seeks to 15% of video duration once metadata loads. */
  start?: number;
  fit?: "cover" | "contain";
  backdropClassName?: string;
  onFailed?: () => void;
}

/**
 * Lightweight muted looping <video> element that fades in once playing and explicitly releases
 * its media pipeline on unmount.
 */
export const VideoHoverPlayer: React.FC<VideoHoverPlayerProps> = memo(
  ({ path, start, fit = "cover", backdropClassName = "", onFailed }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const onFailedRef = useRef(onFailed);
    onFailedRef.current = onFailed;
    const [shown, setShown] = useState(false);
    const [failed, setFailed] = useState(false);

    // Assign and tear down `el.src` symmetrically inside the effect so React StrictMode's
    // mount -> cleanup -> remount cycle cleanly restores the source instead of wiping it, while
    // still releasing WebView2's media decoder immediately on unmount.
    useEffect(() => {
      const el = videoRef.current;
      if (!el) return;
      let active = true;
      setShown(false);
      setFailed(false);

      el.muted = true;
      el.defaultMuted = true;
      el.src = convertFileSrc(path);

      const handleLoadedMetadata = () => {
        if (!active) return;
        const target =
          start !== undefined
            ? start
            : Number.isFinite(el.duration) && el.duration > 2
              ? el.duration * 0.15
              : 0;
        if (target > 0) {
          try {
            el.currentTime = target;
          } catch {
            // ignore non-seekable streams
          }
        }
        void el.play().catch(() => {});
      };

      const handlePlaying = () => {
        if (active) setShown(true);
      };

      const handleError = () => {
        if (!active || !el.getAttribute("src")) return;
        unplayablePaths.add(path);
        setFailed(true);
        onFailedRef.current?.();
      };

      el.addEventListener("loadedmetadata", handleLoadedMetadata);
      el.addEventListener("playing", handlePlaying);
      el.addEventListener("error", handleError);
      el.load();
      void el.play().catch(() => {});

      return () => {
        active = false;
        el.removeEventListener("loadedmetadata", handleLoadedMetadata);
        el.removeEventListener("playing", handlePlaying);
        el.removeEventListener("error", handleError);
        try {
          el.pause();
          el.removeAttribute("src");
          el.load();
        } catch {
          // ignore cleanup errors on detached media elements
        }
      };
    }, [path, start]);

    if (failed) return null;

    return (
      <video
        ref={videoRef}
        muted
        autoPlay
        loop
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        preload="auto"
        className={`absolute inset-0 w-full h-full pointer-events-none ${
          fit === "contain" ? "object-contain" : "object-cover"
        } ${backdropClassName} transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
      />
    );
  }
);

VideoHoverPlayer.displayName = "VideoHoverPlayer";

interface VideoHoverPreviewOverlayProps {
  scope: string;
  path: string;
  start?: number;
  fit?: "cover" | "contain";
  backdropClassName?: string;
}

/**
 * Drop-in overlay for any video thumbnail tile. Renders NOTHING (zero DOM, zero <video>) unless
 * this exact `(scope, path)` is the single globally active preview.
 */
export const VideoHoverPreviewOverlay: React.FC<VideoHoverPreviewOverlayProps> = memo(
  ({ scope, path, start, fit = "cover", backdropClassName = "" }) => {
    const active = useIsVideoPreviewActive(scope, path);
    if (!active) return null;
    return (
      <VideoHoverPlayer
        path={path}
        start={start}
        fit={fit}
        backdropClassName={backdropClassName}
        onFailed={() => cancelVideoPreview(scope, path)}
      />
    );
  }
);

VideoHoverPreviewOverlay.displayName = "VideoHoverPreviewOverlay";
