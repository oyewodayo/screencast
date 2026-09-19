// components/video/VideoEditorHome.tsx
//
// The Video Editor's landing screen - shown whenever the docker's Video Editor icon is clicked,
// the same way WhiteboardHome/MindmapHome back their own tool icons. Its job is to answer "which
// video am I editing?" from a standing start: pick one from the library, pick one you edited
// recently, or reach outside Briefcast entirely with "Open video from anywhere".
//
// Unlike Whiteboard/Mindmap there's no VideoEditorWorkspace home|editor switch here, because the
// editor itself isn't a separate component to switch to - opening a video just puts Dashboard in
// the state it's always had for an open video (VideoPlayer in the main pane + FileToolsDocker's
// video timeline/tools below), with dockerMode forced to "file-tools" so the tools are already
// open rather than needing the "show tools for this file" click. See Dashboard.tsx's
// VideoEditorScreen for the two states that model that.
import React, { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { IoCutOutline, IoFilmOutline, IoFolderOpenOutline, IoPlay, IoSearchOutline, IoTimeOutline } from "react-icons/io5";
import { formatFileSize, truncateFileName } from "../../utils/Formater";
import { thumbnailLimiter } from "../../utils/concurrencyLimiter";

export interface VideoEditorFile {
  name: string;
  path: string;
  size: number;
}

interface VideoEditorHomeProps {
  // Every video in the library, flattened across folders - this screen is explicitly "edit any
  // video", so it deliberately ignores whichever folder/category the sidebar happens to be on.
  videos: VideoEditorFile[];
  // Recently-opened file paths (utils/homeScreenFiles.ts), newest first. Filtered against
  // `videos` below, so a recent entry for a deleted/moved file or a non-video simply drops out.
  recentPaths: string[];
  // Poster-frame preview for a tile - Dashboard.tsx's resolveVideoThumbnailUrl, the same cached
  // ffmpeg frame extraction VideoFolderGallery's tiles use.
  resolveThumbnailUrl: (file: { name: string; path: string }, bypassCache?: boolean) => Promise<string>;
  onOpenVideo: (file: VideoEditorFile) => void;
  // Opens the OS file picker filtered to video extensions and edits whatever comes back, from
  // anywhere on disk - the reason this screen exists as a standalone tool rather than only being
  // reachable from a file that's already open in the library.
  onOpenExternalVideo: () => void;
}

// Below this many videos the search box is more clutter than help - same threshold reasoning as
// WhiteboardHome's own search box.
const SEARCH_VISIBLE_THRESHOLD = 6;

const VideoEditorHome: React.FC<VideoEditorHomeProps> = ({
  videos,
  recentPaths,
  resolveThumbnailUrl,
  onOpenVideo,
  onOpenExternalVideo,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});

  const recentVideos = useMemo(() => {
    const byPath = new Map(videos.map((video) => [video.path, video]));
    return recentPaths.map((path) => byPath.get(path)).filter((video): video is VideoEditorFile => video !== undefined);
  }, [videos, recentPaths]);

  const filteredVideos = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const matching = query ? videos.filter((video) => video.name.toLowerCase().includes(query)) : videos;
    return [...matching].sort((a, b) => a.name.localeCompare(b.name));
  }, [videos, searchQuery]);

  // Only the tiles actually on screen need a poster frame, and each one is a real ffmpeg process
  // spawn - so this goes through the shared thumbnailLimiter (see concurrencyLimiter.ts) exactly
  // like VideoFolderGallery does, rather than firing one invoke per video in the library at once.
  const visibleFiles = useMemo(() => {
    const seen = new Set<string>();
    return [...recentVideos, ...filteredVideos].filter((video) => {
      if (seen.has(video.path)) return false;
      seen.add(video.path);
      return true;
    });
  }, [recentVideos, filteredVideos]);

  useEffect(() => {
    let cancelled = false;
    visibleFiles
      .filter((file) => !thumbUrls[file.path])
      .forEach((file) => {
        thumbnailLimiter(() => resolveThumbnailUrl(file))
          .then((url) => {
            if (cancelled) return;
            setThumbUrls((prev) => (prev[file.path] ? prev : { ...prev, [file.path]: url }));
          })
          .catch((err) => console.error(`Failed to resolve thumbnail for ${file.path}:`, err));
      });
    return () => {
      cancelled = true;
    };
    // thumbUrls is deliberately not a dependency - it changes on every resolved thumbnail, which
    // would re-run this effect once per tile. Same reasoning as VideoFolderGallery's own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleFiles, resolveThumbnailUrl]);

  // VideoPlayer's "set current frame as thumbnail" rewrites the cached jpg at the same path, so
  // the guard above would never revisit it - bypassCache=true is what gets the new bytes.
  useEffect(() => {
    const unlistenPromise = listen<string>("video-thumbnail-updated", (event) => {
      const file = visibleFiles.find((f) => f.path === event.payload);
      if (!file) return;
      resolveThumbnailUrl(file, true)
        .then((url) => setThumbUrls((prev) => ({ ...prev, [file.path]: url })))
        .catch((err) => console.error(`Failed to refresh thumbnail for ${file.path}:`, err));
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [visibleFiles, resolveThumbnailUrl]);

  const renderTile = (video: VideoEditorFile): React.ReactNode => (
    <button
      key={video.path}
      type="button"
      onClick={() => onOpenVideo(video)}
      title={`Edit ${video.name}`}
      className="group text-left rounded-lg overflow-hidden bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800 hover:border-blue-400 dark:hover:border-blue-500 shadow-sm hover:shadow transition-all outline-none focus-visible:border-blue-500"
    >
      <div className="relative aspect-video bg-neutral-100 dark:bg-neutral-950 flex items-center justify-center overflow-hidden">
        {thumbUrls[video.path] ? (
          <img src={thumbUrls[video.path]} alt="" className="w-full h-full object-cover" draggable={false} />
        ) : (
          <IoFilmOutline size={28} className="text-neutral-300 dark:text-neutral-700" />
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/35 transition-colors">
          <IoPlay size={26} className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" />
        </div>
      </div>
      <div className="px-3 py-2">
        <p className="text-sm font-medium text-gray-800 dark:text-neutral-100 truncate">{truncateFileName(video.name, 30)}</p>
        <p className="text-xs text-neutral-400 dark:text-neutral-500">{formatFileSize(video.size)}</p>
      </div>
    </button>
  );

  return (
    <div className="w-full h-full overflow-y-auto bg-gray-100 dark:bg-neutral-950">
      <div className="max-w-5xl mx-auto px-6 py-8 pb-24">
        <div className="flex items-center gap-3 mb-1">
          <span className="p-2 rounded-lg bg-blue-500/10 text-blue-500 dark:text-blue-400">
            <IoCutOutline size={22} />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-gray-800 dark:text-neutral-100">Video editor</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Trim, cut, add overlays and export - pick any video to start.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onOpenExternalVideo}
            className="flex items-center gap-2 px-4 py-2.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 active:scale-[0.98] transition-all outline-none"
          >
            <IoFolderOpenOutline size={18} />
            Open video from anywhere
          </button>
          {videos.length >= SEARCH_VISIBLE_THRESHOLD && (
            <div className="relative flex-1 min-w-[12rem] max-w-xs">
              <IoSearchOutline
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500 pointer-events-none"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search videos"
                className="w-full pl-9 pr-3 py-2.5 rounded-md text-sm bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800 text-gray-800 dark:text-neutral-100 placeholder:text-neutral-400 focus:border-blue-400 dark:focus:border-blue-500 outline-none"
              />
            </div>
          )}
        </div>

        {recentVideos.length > 0 && !searchQuery.trim() && (
          <section className="mt-8">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-3">
              <IoTimeOutline size={14} />
              Recent
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">{recentVideos.map(renderTile)}</div>
          </section>
        )}

        <section className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-3">
            {searchQuery.trim() ? `Results (${filteredVideos.length})` : "In your library"}
          </h2>
          {filteredVideos.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">{filteredVideos.map(renderTile)}</div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-12 rounded-lg border border-dashed border-gray-300 dark:border-neutral-800 text-center">
              <IoFilmOutline size={32} className="text-neutral-300 dark:text-neutral-700" />
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                {searchQuery.trim() ? `No videos match "${searchQuery.trim()}".` : "No videos in your library yet."}
              </p>
              {!searchQuery.trim() && (
                <button
                  type="button"
                  onClick={onOpenExternalVideo}
                  className="mt-1 text-sm text-blue-600 dark:text-blue-400 hover:underline outline-none"
                >
                  Open one from your computer instead
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default VideoEditorHome;
