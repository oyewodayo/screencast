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
import { thumbnailLimiter } from "../utils/concurrencyLimiter";

interface SidebarFileIconProps {
  name: string;
  path: string;
  isImage: boolean;
  resolveThumbnailUrl?: (file: { name: string; path: string }) => Promise<string>;
  fallbackIcon: React.ReactNode;
  fallbackClassName: string;
}

const SidebarFileIcon: React.FC<SidebarFileIconProps> = ({
  name,
  path,
  isImage,
  resolveThumbnailUrl,
  fallbackIcon,
  fallbackClassName,
}) => {
  const tileRef = useRef<HTMLDivElement>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage || !resolveThumbnailUrl) return;
    const el = tileRef.current;
    if (!el) return;

    let cancelled = false;
    // rootMargin gives the resolve a head start before the tile is actually on screen, so it's
    // usually already resolved (or at least in flight) by the time a fast scroll brings it fully
    // into view, without going as far as resolving everything up front.
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        observer.disconnect();
        thumbnailLimiter(() => resolveThumbnailUrl({ name, path }))
          .then((url) => {
            if (!cancelled) setThumbUrl(url);
          })
          .catch((err) => console.error(`Failed to resolve sidebar thumbnail for ${path}:`, err));
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
    // path/name identify which file this tile is for; isImage/resolveThumbnailUrl gate whether it
    // applies at all - thumbUrl deliberately excluded, it's the effect's own output, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImage, resolveThumbnailUrl, name, path]);

  return (
    <div
      ref={tileRef}
      className="shrink-0 w-5 h-5 rounded-md overflow-hidden bg-gray-100 dark:bg-neutral-800 flex items-center justify-center"
    >
      {thumbUrl ? (
        <img src={thumbUrl} alt="" draggable={false} loading="lazy" className="w-full h-full object-cover" />
      ) : (
        <span className={fallbackClassName}>{fallbackIcon}</span>
      )}
    </div>
  );
};

export default SidebarFileIcon;
