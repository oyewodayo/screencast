// components/HomeLibrarySection.tsx
//
// Minimal, scannable "From your library" section on the Home screen.
// Supports List and Grid views (persisted), inline library search, hover-only pin toggles for any
// item (files, docs, whiteboards, mind maps), cached thumbnails on video/image cards, and the
// shared single-decoder hover/focus video preview.

import React, { memo, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  IoClose,
  IoGridOutline,
  IoListOutline,
  IoPhonePortraitOutline,
  IoPin,
  IoPinOutline,
  IoPlay,
  IoSearchOutline,
} from "react-icons/io5";
import { FileCategory, getFileCategory } from "../utils/fileCategory";
import { formatFileSize, formatMediaDuration, truncateFileName } from "../utils/Formater";
import { relativeTime, type HomeItem } from "../utils/homeLibraryItems";
import type { FileEntry } from "../utils/libraryEntries";
import type { FileArrival } from "../utils/homeScreenFiles";
import { thumbnailLimiter } from "../utils/concurrencyLimiter";
import { isVideoProjectPath } from "../utils/videoEditTypes";
import {
  VideoHoverPreviewOverlay,
  cancelVideoPreview,
  scheduleVideoPreview,
  stopAllVideoPreviews,
} from "./video/VideoHoverPreview";

// Session thumbnail cache so returning to Home paints resolved thumbnails synchronously on frame 1.
const homeThumbCache = new Map<string, string>();
const homeThumbFailed = new Set<string>();

if (typeof window !== "undefined") {
  listen<string>("video-thumbnail-updated", (event) => {
    if (event.payload) {
      homeThumbCache.delete(event.payload);
      homeThumbFailed.delete(event.payload);
    }
  }).catch(() => {});
}

export interface HomeKindMeta {
  label: string;
  icon: React.ReactNode;
  color: string;
}

interface HomeLibrarySectionProps {
  items: HomeItem[];
  hasAnyItems: boolean;
  viewMode: "list" | "grid";
  onViewModeChange: (mode: "list" | "grid") => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  libraryFilesByPath: Map<string, FileEntry>;
  arrivals: Record<string, FileArrival>;
  durations: Map<string, number>;
  homeKinds: Record<Exclude<HomeItem["kind"], "file">, HomeKindMeta>;
  categoryIcon: (category: FileCategory | null) => React.ReactNode;
  categoryIconColorClassName: (category: FileCategory | null) => string;
  resolveImageThumbnailUrl: (file: { name: string; path: string }, bypassCache?: boolean) => Promise<string>;
  resolveVideoThumbnailUrl: (file: { name: string; path: string }, bypassCache?: boolean) => Promise<string>;
  onOpenItem: (item: HomeItem) => void;
  onTogglePinKey: (key: string) => void;
}

const SURFACE_TINT: Record<string, string> = {
  whiteboard: "bg-amber-50/70 dark:bg-amber-500/[0.08]",
  mindmap: "bg-amber-50/70 dark:bg-amber-500/[0.08]",
  doc: "bg-blue-50/70 dark:bg-blue-500/[0.08]",
  pdf: "bg-rose-50/70 dark:bg-rose-500/[0.08]",
  audio: "bg-pink-50/70 dark:bg-pink-500/[0.08]",
  document: "bg-sky-50/70 dark:bg-sky-500/[0.08]",
};

interface HomeGridThumbProps {
  item: HomeItem;
  file: FileEntry | undefined;
  category: FileCategory | null;
  kind: HomeKindMeta | null;
  durationSec: number | undefined;
  categoryIcon: (category: FileCategory | null) => React.ReactNode;
  categoryIconColorClassName: (category: FileCategory | null) => string;
  resolveImageThumbnailUrl: (file: { name: string; path: string }, bypassCache?: boolean) => Promise<string>;
  resolveVideoThumbnailUrl: (file: { name: string; path: string }, bypassCache?: boolean) => Promise<string>;
}

const HomeGridThumb: React.FC<HomeGridThumbProps> = memo(
  ({
    item,
    file,
    category,
    kind,
    durationSec,
    categoryIcon,
    categoryIconColorClassName,
    resolveImageThumbnailUrl,
    resolveVideoThumbnailUrl,
  }) => {
    const isVisualMedia = item.kind === "file" && (category === "video" || category === "image");
    const isPlayableVideo = item.kind === "file" && category === "video" && !isVideoProjectPath(item.id) && (file?.size ?? 1) > 0;
    const [thumbUrl, setThumbUrl] = useState<string | null>(() => (isVisualMedia ? homeThumbCache.get(item.id) ?? null : null));
    const [failed, setFailed] = useState<boolean>(() => (isVisualMedia ? homeThumbFailed.has(item.id) : false));

    useEffect(() => {
      if (!isVisualMedia) return;
      const cached = homeThumbCache.get(item.id);
      if (cached) {
        setThumbUrl(cached);
        setFailed(false);
        return;
      }
      if (homeThumbFailed.has(item.id)) {
        setFailed(true);
        return;
      }
      let cancelled = false;
      const resolver = category === "video" ? resolveVideoThumbnailUrl : resolveImageThumbnailUrl;
      thumbnailLimiter(() => resolver({ name: file?.name ?? item.name, path: item.id }))
        .then((url) => {
          homeThumbCache.set(item.id, url);
          if (!cancelled) setThumbUrl(url);
        })
        .catch(() => {
          homeThumbFailed.add(item.id);
          if (!cancelled) setFailed(true);
        });
      return () => {
        cancelled = true;
      };
    }, [isVisualMedia, category, item.id, item.name, file?.name, resolveImageThumbnailUrl, resolveVideoThumbnailUrl]);

    if (isVisualMedia) {
      return (
        <div className="relative w-full aspect-video bg-neutral-100 dark:bg-neutral-800/80 overflow-hidden flex items-center justify-center">
          {thumbUrl && !failed ? (
            <img
              src={thumbUrl}
              alt=""
              draggable={false}
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover"
            />
          ) : (
            <span className={`scale-125 ${categoryIconColorClassName(category)} ${!failed ? "opacity-40 animate-pulse" : "opacity-60"}`}>
              {categoryIcon(category)}
            </span>
          )}
          {category === "video" && (
            <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="w-7 h-7 rounded-full bg-black/45 text-white flex items-center justify-center opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all">
                <IoPlay size={12} className="translate-x-[1px]" />
              </span>
            </span>
          )}
          {isPlayableVideo && (
            <VideoHoverPreviewOverlay scope="home" path={item.id} fit="cover" backdropClassName="bg-black" />
          )}
          {durationSec !== undefined && durationSec > 0 && (
            <span className="absolute right-1.5 bottom-1.5 z-[2] px-1.5 py-0.5 rounded bg-black/65 text-white text-[10px] font-medium tabular-nums pointer-events-none">
              {formatMediaDuration(durationSec)}
            </span>
          )}
        </div>
      );
    }

    const tintKey = kind ? item.kind : (category ?? "");
    const tint = SURFACE_TINT[tintKey] ?? "bg-gray-100/70 dark:bg-neutral-800/60";
    return (
      <div className={`relative w-full aspect-video ${tint} flex items-center justify-center overflow-hidden`}>
        <span className={`scale-[1.45] ${kind ? kind.color : categoryIconColorClassName(category)}`}>
          {kind ? kind.icon : categoryIcon(category)}
        </span>
      </div>
    );
  }
);

HomeGridThumb.displayName = "HomeGridThumb";

const HomeLibrarySection: React.FC<HomeLibrarySectionProps> = memo(
  ({
    items,
    hasAnyItems,
    viewMode,
    onViewModeChange,
    searchQuery,
    onSearchQueryChange,
    libraryFilesByPath,
    arrivals,
    durations,
    homeKinds,
    categoryIcon,
    categoryIconColorClassName,
    resolveImageThumbnailUrl,
    resolveVideoThumbnailUrl,
    onOpenItem,
    onTogglePinKey,
  }) => {
    useEffect(() => () => stopAllVideoPreviews(), [viewMode]);

    if (!hasAnyItems && !searchQuery.trim()) return null;

    return (
      <div className={`relative w-full transition-all ${viewMode === "grid" ? "max-w-3xl" : "max-w-lg"}`}>
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-400 dark:text-neutral-500">
            From your library
          </p>
          <div className="flex items-center gap-1.5">
            {/* Subtle inline library search */}
            <div className="relative flex items-center">
              <IoSearchOutline
                size={12}
                className="absolute left-2 text-gray-400 dark:text-neutral-500 pointer-events-none"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && searchQuery) {
                    e.stopPropagation();
                    onSearchQueryChange("");
                  }
                }}
                placeholder="Search…"
                aria-label="Search library"
                className="h-7 w-32 focus:w-44 pl-6 pr-6 rounded-md bg-white/85 dark:bg-neutral-900/85 backdrop-blur-sm border border-gray-200/80 dark:border-neutral-800 focus:border-blue-400/80 dark:focus:border-blue-500 text-xs text-gray-700 dark:text-neutral-200 placeholder:text-gray-400 dark:placeholder:text-neutral-500 outline-none transition-all"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => onSearchQueryChange("")}
                  aria-label="Clear search"
                  className="absolute right-1.5 p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-neutral-200"
                >
                  <IoClose size={12} />
                </button>
              )}
            </div>

            {/* List / Grid view toggle */}
            <div
              role="group"
              aria-label="Library view mode"
              className="inline-flex items-center rounded-md bg-white/85 dark:bg-neutral-900/85 backdrop-blur-sm border border-gray-200/80 dark:border-neutral-800 p-0.5 gap-0.5"
            >
              <button
                type="button"
                onClick={() => onViewModeChange("list")}
                title="List view"
                aria-label="List view"
                aria-pressed={viewMode === "list"}
                className={`p-1 rounded transition-colors ${
                  viewMode === "list"
                    ? "bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400"
                    : "text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300"
                }`}
              >
                <IoListOutline size={14} />
              </button>
              <button
                type="button"
                onClick={() => onViewModeChange("grid")}
                title="Grid view"
                aria-label="Grid view"
                aria-pressed={viewMode === "grid"}
                className={`p-1 rounded transition-colors ${
                  viewMode === "grid"
                    ? "bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400"
                    : "text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300"
                }`}
              >
                <IoGridOutline size={14} />
              </button>
            </div>
          </div>
        </div>

        {items.length === 0 ? (
          <div className="py-8 text-center rounded-lg border border-dashed border-gray-200/80 dark:border-neutral-800 text-xs text-gray-400 dark:text-neutral-500">
            No items match “{searchQuery.trim()}”
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {items.map((item) => {
              const file = item.kind === "file" ? libraryFilesByPath.get(item.id) : undefined;
              const kind = item.kind === "file" ? null : homeKinds[item.kind];
              const category = file || item.kind === "file" ? getFileCategory(item.name) : null;
              const isPlayableVideo =
                item.kind === "file" && category === "video" && !isVideoProjectPath(item.id) && (file?.size ?? 1) > 0;
              const durationSec = file ? durations.get(file.path) : undefined;
              const displayName = file ? file.name : item.name;
              return (
                <div
                  key={item.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (isPlayableVideo) cancelVideoPreview("home", item.id);
                    onOpenItem(item);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (isPlayableVideo) cancelVideoPreview("home", item.id);
                      onOpenItem(item);
                    }
                  }}
                  onPointerEnter={() => {
                    if (isPlayableVideo) scheduleVideoPreview("home", item.id, file?.size);
                  }}
                  onPointerLeave={() => {
                    if (isPlayableVideo) cancelVideoPreview("home", item.id);
                  }}
                  onFocus={() => {
                    if (isPlayableVideo) scheduleVideoPreview("home", item.id, file?.size);
                  }}
                  onBlur={() => {
                    if (isPlayableVideo) cancelVideoPreview("home", item.id);
                  }}
                  title={displayName}
                  className="group relative flex flex-col rounded-xl overflow-hidden bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm border border-gray-200/80 dark:border-neutral-800 hover:border-blue-400/80 dark:hover:border-blue-500 hover:shadow-sm text-left cursor-pointer transition-all outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  {/* Hover-only pin toggle (stays visible when pinned) */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePinKey(item.key);
                    }}
                    title={item.pinned ? "Unpin from home" : "Pin to home"}
                    aria-label={item.pinned ? "Unpin from home" : "Pin to home"}
                    className={`absolute top-1.5 right-1.5 z-10 p-1 rounded-md backdrop-blur-sm transition-all ${
                      item.pinned
                        ? "bg-white/90 dark:bg-neutral-900/90 text-blue-600 dark:text-blue-400 shadow-xs opacity-100"
                        : "bg-white/85 dark:bg-neutral-900/85 text-gray-500 dark:text-neutral-300 hover:text-blue-600 dark:hover:text-blue-400 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    }`}
                  >
                    {item.pinned ? <IoPin size={12} /> : <IoPinOutline size={12} />}
                  </button>

                  <HomeGridThumb
                    item={item}
                    file={file}
                    category={category}
                    kind={kind}
                    durationSec={durationSec}
                    categoryIcon={categoryIcon}
                    categoryIconColorClassName={categoryIconColorClassName}
                    resolveImageThumbnailUrl={resolveImageThumbnailUrl}
                    resolveVideoThumbnailUrl={resolveVideoThumbnailUrl}
                  />

                  <div className="flex flex-col gap-1 px-2.5 py-2 flex-1">
                    <span className="text-[12.5px] font-medium text-gray-800 dark:text-neutral-100 line-clamp-2 leading-snug break-all">
                      {displayName}
                    </span>
                    <span className="mt-auto flex items-center gap-1.5 text-[11px] tabular-nums text-gray-400 dark:text-neutral-500 truncate w-full">
                      {file && arrivals[file.path] ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 truncate max-w-full"
                          title={`Sent from ${arrivals[file.path].from} ${relativeTime(arrivals[file.path].at)}`}
                        >
                          <IoPhonePortraitOutline size={11} className="shrink-0" />
                          <span className="truncate">{arrivals[file.path].from}</span>
                        </span>
                      ) : file ? (
                        <span className="truncate">{formatFileSize(file.size)}</span>
                      ) : (
                        <>
                          <span className="truncate">{kind ? kind.label : (category ?? "File")}</span>
                          {item.time > 0 && (
                            <>
                              <span aria-hidden>·</span>
                              <span className="shrink-0">{relativeTime(item.time)}</span>
                            </>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {items.map((item) => {
              const file = item.kind === "file" ? libraryFilesByPath.get(item.id) : undefined;
              const kind = item.kind === "file" ? null : homeKinds[item.kind];
              const category = file || item.kind === "file" ? getFileCategory(item.name) : null;
              return (
                <div
                  key={item.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenItem(item)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenItem(item);
                    }
                  }}
                  title={file ? file.name : item.name}
                  className="group flex items-center gap-3 px-3 py-2 rounded-lg bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm border border-gray-200/80 dark:border-neutral-800 hover:border-blue-400/80 dark:hover:border-blue-500 hover:shadow-xs text-left cursor-pointer transition-all outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <span className={`shrink-0 ${kind ? kind.color : categoryIconColorClassName(category)}`}>
                    {kind ? kind.icon : categoryIcon(category)}
                  </span>
                  <span className="text-sm text-gray-700 dark:text-neutral-200 truncate">
                    {file ? truncateFileName(file.name) : item.name}
                  </span>
                  <span className="ml-auto flex items-center gap-2 shrink-0 text-xs tabular-nums text-gray-400 dark:text-neutral-500">
                    {file && arrivals[file.path] ? (
                      <span
                        className="flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2 py-0.5"
                        title={`Sent from ${arrivals[file.path].from} ${relativeTime(arrivals[file.path].at)}`}
                      >
                        <IoPhonePortraitOutline size={12} />
                        <span className="max-w-[9rem] truncate">{arrivals[file.path].from}</span>
                        {arrivals[file.path].count > 1 && <span>· +{arrivals[file.path].count - 1} more</span>}
                        <span aria-hidden>·</span>
                        <span>{relativeTime(arrivals[file.path].at)}</span>
                      </span>
                    ) : file ? (
                      <>
                        {durations.has(file.path) && (
                          <>
                            <span>{formatMediaDuration(durations.get(file.path)!)}</span>
                            <span aria-hidden>·</span>
                          </>
                        )}
                        <span>{formatFileSize(file.size)}</span>
                      </>
                    ) : (
                      <>
                        <span>{kind ? kind.label : (category ?? "File")}</span>
                        {item.time > 0 && (
                          <>
                            <span aria-hidden>·</span>
                            <span>{relativeTime(item.time)}</span>
                          </>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTogglePinKey(item.key);
                      }}
                      title={item.pinned ? "Unpin from home" : "Pin to home"}
                      aria-label={item.pinned ? "Unpin from home" : "Pin to home"}
                      className={`p-0.5 rounded transition-opacity ${
                        item.pinned
                          ? "text-blue-600 dark:text-blue-400 opacity-100"
                          : "text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 opacity-0 group-hover:opacity-100 focus:opacity-100"
                      }`}
                    >
                      {item.pinned ? <IoPin size={13} /> : <IoPinOutline size={13} />}
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }
);

HomeLibrarySection.displayName = "HomeLibrarySection";

export default HomeLibrarySection;
