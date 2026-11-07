// components/SidebarFileIcon.tsx
//
// Leading icon for a sidebar file row - a small rounded tile that shows a real thumbnail for
// image files (lazy-loaded, see below) and a colored category glyph for everything else,
// replacing the old approach of baking an emoji into the row's text (formatFileName's icon -
// still used for plain-text contexts like toast messages, just not here anymore where a real
// icon/thumbnail element sits alongside the name).
//
// Thumbnails are lazy - only resolved once the tile actually scrolls near the viewport, via
// IntersectionObserver, not eagerly for every row on mount. A library folder can hold hundreds of
// images (the image gallery grid exists precisely because that's common - see
// ImageFolderGallery.tsx).
//
// The actual resolve is routed through thumbnailLimiter (concurrencyLimiter.ts), a SHARED cap
// across every SidebarFileIcon instance (and the gallery) - the viewport is not, on its own, a
// real concurrency limit: IntersectionObserver's rootMargin means every row within ~200px of the
// visible area becomes "intersecting" in the same instant on first render or a fast scroll, not
// one at a time, which in practice meant dozens of full-resolution photo decodes firing at once
// and freezing the whole app ("Not Responding", fan noise, multi-GB RAM growth - observed
// directly). See that module's own doc comment for the full story.
//
// resolveThumbnailUrl is the same resolveImageThumbnailUrl Dashboard.tsx already threads into the
// gallery, backed by the same on-disk cache (get_image_thumbnail) - a photo already thumbnailed
// via the gallery resolves here instantly, and vice versa.
import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { thumbnailLimiter } from "../utils/concurrencyLimiter";

// Module-level thumbnail URL cache so closing/reopening the sidebar or switching tabs/views
// renders already-resolved thumbnails synchronously on first paint with zero IPC round-trip.
const resolvedThumbCache = new Map<string, string>();
const failedThumbCache = new Set<string>();

if (typeof window !== "undefined") {
  listen<string>("video-thumbnail-updated", (event) => {
    if (event.payload) {
      resolvedThumbCache.delete(event.payload);
      failedThumbCache.delete(event.payload);
    }
  }).catch(() => {});
}

// Single shared IntersectionObserver across all sidebar icons so opening a sidebar with 100+
// items doesn't allocate 100 separate IntersectionObserver instances on the main thread.
const observerCallbacks = new Map<Element, () => void>();
let sharedObserver: IntersectionObserver | null = null;

function observeElement(el: Element, onIntersect: () => void): () => void {
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const cb = observerCallbacks.get(entry.target);
          if (cb) {
            observerCallbacks.delete(entry.target);
            sharedObserver?.unobserve(entry.target);
            cb();
          }
        }
      },
      { rootMargin: "200px" }
    );
  }
  observerCallbacks.set(el, onIntersect);
  sharedObserver.observe(el);
  return () => {
    observerCallbacks.delete(el);
    sharedObserver?.unobserve(el);
  };
}

interface SidebarFileIconProps {
  name: string;
  path: string;
  isImage: boolean;
  resolveThumbnailUrl?: (file: { name: string; path: string }) => Promise<string>;
  fallbackIcon: React.ReactNode;
  fallbackClassName: string;
  // Grid view: a full-width 16:9 tile instead of the 20px row icon. Same lazy/limited resolve;
  // `isImage` just means "has a thumbnail to resolve" (the grid also passes videos).
  large?: boolean;
}

const SidebarFileIcon: React.FC<SidebarFileIconProps> = ({
  name,
  path,
  isImage,
  resolveThumbnailUrl,
  fallbackIcon,
  fallbackClassName,
  large = false,
}) => {
  const tileRef = useRef<HTMLDivElement>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(() => (isImage ? resolvedThumbCache.get(path) ?? null : null));
  const [thumbFailed, setThumbFailed] = useState<boolean>(() => (isImage ? failedThumbCache.has(path) : false));

  useEffect(() => {
    if (!isImage || !resolveThumbnailUrl) return;
    const cached = resolvedThumbCache.get(path);
    if (cached) {
      setThumbUrl(cached);
      setThumbFailed(false);
      return;
    }
    if (failedThumbCache.has(path)) {
      setThumbFailed(true);
      return;
    }
    const el = tileRef.current;
    if (!el) return;

    let cancelled = false;
    const stopObserving = observeElement(el, () => {
      thumbnailLimiter(() => resolveThumbnailUrl({ name, path }))
        .then((url) => {
          resolvedThumbCache.set(path, url);
          if (!cancelled) setThumbUrl(url);
        })
        .catch((err) => {
          failedThumbCache.add(path);
          if (!cancelled) setThumbFailed(true);
          console.error(`Failed to resolve sidebar thumbnail for ${path}:`, err);
        });
    });
    return () => {
      cancelled = true;
      stopObserving();
    };
    // path/name identify which file this tile is for; isImage/resolveThumbnailUrl gate whether it
    // applies at all - thumbUrl deliberately excluded, it's the effect's own output, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImage, resolveThumbnailUrl, name, path]);

  const isLoadingThumb = isImage && !thumbUrl && !thumbFailed;

  return (
    <div
      ref={tileRef}
      className={
        large
          ? `w-full aspect-video rounded-lg overflow-hidden bg-gray-100 dark:bg-neutral-800 flex items-center justify-center ring-1 ring-black/5 dark:ring-white/5 ${
              isLoadingThumb ? "animate-pulse bg-gray-200/80 dark:bg-neutral-800/90" : ""
            }`
          : `shrink-0 w-5 h-5 rounded-md overflow-hidden bg-gray-100 dark:bg-neutral-800 flex items-center justify-center ${
              isLoadingThumb ? "animate-pulse" : ""
            }`
      }
    >
      {thumbUrl ? (
        <img src={thumbUrl} alt="" draggable={false} loading="lazy" className="w-full h-full object-cover" />
      ) : (
        <span className={`${fallbackClassName} ${large ? "scale-[1.8]" : ""} ${isLoadingThumb ? "opacity-40" : ""}`}>{fallbackIcon}</span>
      )}
    </div>
  );
};

export default SidebarFileIcon;
