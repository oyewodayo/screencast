// components/VideoFolderGallery.tsx
//
// Thumbnail grid shown in the main board when a Video folder is selected in the sidebar (rather
// than a single file) - the video counterpart to ImageFolderGallery.tsx, and deliberately built
// as a close mirror of it rather than a shared generic component: the two differ enough in tile
// content (a poster-frame video needs a play-icon overlay and a 16:9 crop instead of a photo's
// square one, no "Copy image" - there's no OS convention for copying video to the clipboard) and
// forcing them through one shared abstraction felt more likely to destabilize the
// already-working, already-tuned image gallery than to save real code. If a third media type ever
// needs this same shape, that's the point to actually extract the shared selection/menu/panel
// logic into a hook - see this file's own selection/context-menu/bulk-panel code, which is
// otherwise identical to ImageFolderGallery.tsx's.
//
// Multi-select follows the same Explorer-standard conventions the sidebar's own checkbox
// multi-select doesn't (it has no keyboard-modifier support) - plain click selects only that
// tile, Ctrl/Cmd-click toggles one tile without touching the rest, Shift-click selects the whole
// range since the last-clicked tile. All three drive the SAME selectedFilePaths Set Dashboard.tsx
// already threads through the sidebar's bulk action bar, so a gallery selection and a sidebar
// selection are one and the same thing, not two parallel selection models.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { IoChevronForward, IoClose, IoEllipsisVertical, IoFolderOutline, IoPlay, IoTrashOutline, IoVideocam, IoPhonePortraitOutline } from "react-icons/io5";
import { openPhoneTransfer } from "../services/phoneTransfer";
import { formatFileSize, truncateFileName } from "../utils/Formater";
import { thumbnailLimiter } from "../utils/concurrencyLimiter";
import { useGallerySort } from "./GallerySort";
import { useBatchedRecord } from "../hooks/useBatchedRecord";
import InlineRenameInput from "./InlineRenameInput";
import FloatingContextMenu from "./FloatingContextMenu";
import { isVideoProjectPath } from "../utils/videoEditTypes";

interface GalleryFile {
  name: string;
  path: string;
  size: number;
  modified?: number;
}

interface VideoFolderGalleryProps {
  files: GalleryFile[];
  folderLabel: string;
  // Poster-frame preview for a grid tile - see Dashboard.tsx's resolveVideoThumbnailUrl (a single
  // ffmpeg frame extraction, cached on the backend by get_video_thumbnail). bypassCache forces a
  // fresh URL past both Dashboard's own cache and the browser's HTTP cache - only ever passed by
  // the video-thumbnail-updated listener below, never by the normal per-file resolve effect.
  resolveThumbnailUrl: (file: GalleryFile, bypassCache?: boolean) => Promise<string>;
  onOpenVideo: (file: GalleryFile) => void;
  onDeleteFile: (file: GalleryFile) => void;
  // Opens the file Info panel (FileInfoModal, owned by Dashboard.tsx).
  onShowInfo: (file: GalleryFile) => void;
  onConvertFile: (file: GalleryFile) => void;
  // Rename is inline (matches the sidebar's own inline rename), so its state is lifted to
  // Dashboard.tsx - one rename in flight at a time, shared with the sidebar list, rather than a
  // second parallel rename state living only here.
  renamingFile: string | null;
  onStartRename: (file: GalleryFile) => void;
  onCommitRename: (file: GalleryFile, newName: string) => void;
  onCancelRename: () => void;
  // Lifted multi-selection - see this file's own doc comment above. `selectedFilePaths` spans
  // every folder/category (it's Dashboard.tsx's one shared selection set), not just this one, so
  // every consumer here filters it down to `files` first.
  selectedFilePaths: Set<string>;
  onToggleFileSelected: (path: string) => void;
  onSelectOnly: (path: string) => void;
  onSelectRange: (paths: string[]) => void;
  onClearSelection: () => void;
  // Opens Dashboard's shared "Move or copy to..." menu (MoveCopyMenu.tsx) for these files.
  onOpenMoveCopy: (files: GalleryFile[], anchor: { left: number; top: number }) => void;
  // Opens the "Set thumbnail" picker for this video (opening it first if needed).
  onSetThumbnail: (file: GalleryFile) => void;
  onBulkDelete: (files: GalleryFile[]) => void;
}

const STATUS_RESET_MS = 1500;

// Off-screen tiles skip layout and paint entirely; "auto" remembers each tile's real size once
// it has rendered, so the scrollbar doesn't jump.
const TILE_STYLE: React.CSSProperties = { contentVisibility: "auto", containIntrinsicSize: "auto 220px" };

const VideoFolderGallery: React.FC<VideoFolderGalleryProps> = ({
  files: unsortedFiles,
  folderLabel,
  resolveThumbnailUrl,
  onOpenVideo,
  onDeleteFile,
  onShowInfo,
  onConvertFile,
  renamingFile,
  onStartRename,
  onCommitRename,
  onCancelRename,
  selectedFilePaths,
  onToggleFileSelected,
  onSelectOnly,
  onSelectRange,
  onClearSelection,
  onOpenMoveCopy,
  onSetThumbnail,
  onBulkDelete,
}) => {
  const { sorted: files, control: sortControl } = useGallerySort(unsortedFiles, "video");
  // Batched - one grid render per ~32ms of resolved thumbnails, not one per thumbnail.
  const [thumbUrls, putThumbUrl] = useBatchedRecord<string>();
  const [contextMenu, setContextMenu] = useState<{ file: GalleryFile; x: number; y: number } | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Anchor for Shift-click range-select - the index of the last tile clicked WITHOUT Shift (a
  // plain or Ctrl/Cmd click). A ref, not state: it only needs to be read back on a later click,
  // never rendered.
  const lastClickedIndexRef = useRef<number | null>(null);

  useEffect(() => {
    const pending = files.filter((file) => !thumbUrls[file.path]);

    // Routed through the shared thumbnailLimiter (concurrencyLimiter.ts), the same one
    // ImageFolderGallery/SidebarFileIcon use - a poster-frame extraction is a real ffmpeg process
    // spawn, and this cap has to hold across every source of thumbnail requests at once, not just
    // within this one gallery (see that module's own doc comment for the "Not Responding" history
    // that made this necessary).
    pending.forEach((file) => {
      thumbnailLimiter(() => resolveThumbnailUrl(file))
        .then((url) => putThumbUrl(file.path, url))
        .catch((err) => console.error(`Failed to resolve thumbnail for ${file.path}:`, err));
    });
    // Only re-run when the folder's file list itself changes - thumbUrls updates every time a
    // thumbnail resolves, and including it here would re-trigger this effect on every single one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, resolveThumbnailUrl]);

  // VideoPlayer.tsx's "set current frame as thumbnail" re-extracts get_video_thumbnail's cached
  // jpg in place - same path, new bytes - which this effect's own "already have a URL for this
  // file, skip it" guard above would otherwise never revisit. bypassCache=true is what actually
  // gets fresh bytes rather than the identical (now-stale) URL Dashboard.tsx already cached.
  useEffect(() => {
    const unlistenPromise = listen<string>("video-thumbnail-updated", (event) => {
      const file = files.find((f) => f.path === event.payload);
      if (!file) return;
      resolveThumbnailUrl(file, true)
        .then((url) => putThumbUrl(file.path, url, true))
        .catch((err) => console.error(`Failed to refresh thumbnail for ${file.path}:`, err));
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [files, resolveThumbnailUrl]);

  useEffect(() => () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
  }, []);

  const flashStatus = (message: string) => {
    setActionStatus(message);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setActionStatus(null), STATUS_RESET_MS);
  };

  const handleCopyPath = async (file: GalleryFile) => {
    try {
      await navigator.clipboard.writeText(file.path);
      flashStatus("Path copied");
    } catch (err) {
      console.error("Failed to copy path to clipboard:", err);
      flashStatus("Copy failed");
    }
  };

  const openMenuFor = (file: GalleryFile, x: number, y: number) => {
    setContextMenu({ file, x, y });
  };

  // The tile handlers read Dashboard's callbacks through this ref, so the memoized grid below
  // doesn't depend on them: they're fresh arrows on every Dashboard render, and the dashboard
  // re-renders constantly for reasons unrelated to this folder.
  const latest = useRef({ onSelectRange, onToggleFileSelected, onSelectOnly, onOpenVideo, onCommitRename, onCancelRename });
  latest.current = { onSelectRange, onToggleFileSelected, onSelectOnly, onOpenVideo, onCommitRename, onCancelRename };

  // Rebuilt only when something a tile shows changes - not on every parent render, which used to
  // re-diff every tile each time and made the page feel sticky.
  const tiles = useMemo(
    () =>
      files.map((file, index) => (
        <div
          key={file.path}
          role="button"
          tabIndex={0}
          onClick={(e) => {
            if (e.shiftKey && lastClickedIndexRef.current !== null) {
              const [from, to] = [lastClickedIndexRef.current, index].sort((a, b) => a - b);
              latest.current.onSelectRange(files.slice(from, to + 1).map((f) => f.path));
            } else if (e.ctrlKey || e.metaKey) {
              latest.current.onToggleFileSelected(file.path);
              lastClickedIndexRef.current = index;
            } else {
              latest.current.onSelectOnly(file.path);
              lastClickedIndexRef.current = index;
            }
          }}
          onDoubleClick={() => latest.current.onOpenVideo(file)}
          onKeyDown={(e) => {
            if (e.key === "Enter") latest.current.onOpenVideo(file);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenuFor(file, e.clientX, e.clientY);
          }}
          title={renamingFile === file.path ? undefined : file.name}
          style={TILE_STYLE}
          className={`group relative flex flex-col rounded-md overflow-hidden border bg-white dark:bg-neutral-900 text-left cursor-pointer transition-colors ${
            selectedFilePaths.has(file.path)
              ? "border-blue-400 dark:border-blue-500 ring-1 ring-blue-400 dark:ring-blue-500"
              : "border-gray-200 dark:border-neutral-800 hover:border-blue-300 dark:hover:border-blue-600"
          }`}
        >
          <button
            type="button"
            title="More actions"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              openMenuFor(file, rect.right, rect.bottom);
            }}
            className="absolute top-1 right-1 z-10 p-1 rounded opacity-0 group-hover:opacity-100 bg-black/40 text-white hover:bg-black/60 transition-opacity"
          >
            <IoEllipsisVertical size={13} />
          </button>
          {/* aspect-video (16:9), not the image gallery's aspect-square - video source material
              is almost always widescreen, and cropping a poster frame to a square would cut off
              real content in a way it wouldn't for a typically-portrait or already-square photo. */}
          <div className="aspect-video w-full bg-gray-100 dark:bg-neutral-800 flex items-center justify-center overflow-hidden relative">
            {thumbUrls[file.path] ? (
              <img
                src={thumbUrls[file.path]}
                alt={file.name}
                loading="lazy"
                decoding="async"
                draggable={false}
                className="w-full h-full object-contain"
              />
            ) : (
              <IoVideocam size={22} className="text-gray-300 dark:text-neutral-700" />
            )}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-8 h-8 rounded-full bg-black/50 flex items-center justify-center opacity-80 group-hover:opacity-100 group-hover:scale-110 transition-all">
                <IoPlay size={14} className="text-white translate-x-[1px]" />
              </div>
            </div>
          </div>
          {renamingFile === file.path ? (
            <InlineRenameInput
              fileName={file.name}
              onCommit={(value) => latest.current.onCommitRename(file, value)}
              onCancel={() => latest.current.onCancelRename()}
              className="mx-1 my-1 min-w-0 border border-blue-400 rounded px-1 text-[11px] bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100"
            />
          ) : (
            <div className="flex items-center justify-between gap-1 px-1.5 py-1">
              <span className="text-[11px] text-gray-600 dark:text-neutral-300 truncate min-w-0">
                {truncateFileName(file.name)}
              </span>
              <span className="text-[10px] text-gray-400 dark:text-neutral-500 shrink-0 whitespace-nowrap">
                {formatFileSize(file.size)}
              </span>
            </div>
          )}
        </div>
      )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, thumbUrls, selectedFilePaths, renamingFile]
  );

  const selectedInFolder = files.filter((file) => selectedFilePaths.has(file.path));

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full gap-3 text-gray-500 dark:text-neutral-400">
        <IoVideocam size={40} className="text-gray-300 dark:text-neutral-700" />
        <p className="text-sm">No videos in {folderLabel}</p>
      </div>
    );
  }

  // pb tracks --docker-height (published by BottomDocker's ResizeObserver, see player.css for the
  // sibling usage) so the last grid row can always scroll clear of the fixed bottom icon bar
  // instead of rendering underneath it.
  return (
    <div className="relative w-full h-full overflow-y-auto overscroll-contain p-4 pb-[var(--docker-height,64px)]">
      {actionStatus && (
        <div className="absolute top-2 right-3 z-20 px-2.5 py-1 rounded-md bg-neutral-900/90 text-white text-xs shadow-lg">
          {actionStatus}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500">
          {folderLabel} — {files.length} video{files.length === 1 ? "" : "s"}
        </p>
        {sortControl}
      </div>
      <div
        className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3"
        onClick={(e) => {
          // Clicking empty grid space (not a tile - tile clicks are handled and don't bubble
          // here unhandled) clears the selection, matching a normal file manager's background
          // click. Guarded on the event target being the grid itself so this never fires for a
          // click that originated on a tile and merely bubbled up.
          if (e.target === e.currentTarget) onClearSelection();
        }}
      >
        {tiles}
      </div>

      {/* Selection panel - fixed (not just sticky-within-scroll) so it stays in view regardless
          of scroll position. Only for a real multi-selection (2+) - a single selected tile
          already has its own highlighted ring and per-tile kebab/context menu. Bulk convert
          deliberately isn't offered here (unlike the sidebar's own bulk bar) - a folder-sized
          video selection can run into the dozens, and queuing that many ffmpeg conversions at
          once doesn't scale the way a single-file Convert (still in the per-video context menu)
          does; Move and Delete are the operations that actually benefit from being batched. */}
      {selectedInFolder.length > 1 && (
        <>
          <style>{`
            @keyframes gallerySelectionPanelIn {
              from { opacity: 0; transform: translateX(10px) scale(0.98); }
              to { opacity: 1; transform: translateX(0) scale(1); }
            }
          `}</style>
          <div
            style={{ animation: "gallerySelectionPanelIn 160ms cubic-bezier(0.16, 1, 0.3, 1)" }}
            className="fixed top-20 right-4 z-30 w-64 rounded-2xl bg-white/95 dark:bg-neutral-900/95 backdrop-blur-md border border-gray-200/80 dark:border-neutral-700/80 shadow-2xl shadow-black/10 dark:shadow-black/40 ring-1 ring-black/5 overflow-hidden"
          >
            <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-gray-100 dark:border-neutral-800">
              <div className="flex -space-x-2.5 shrink-0">
                {selectedInFolder.slice(0, 3).map((file) => (
                  <div
                    key={file.path}
                    className="w-8 h-8 rounded-lg ring-2 ring-white dark:ring-neutral-900 overflow-hidden bg-gray-100 dark:bg-neutral-800 shrink-0"
                  >
                    {thumbUrls[file.path] && (
                      <img src={thumbUrls[file.path]} alt="" draggable={false} className="w-full h-full object-cover" />
                    )}
                  </div>
                ))}
                {selectedInFolder.length > 3 && (
                  <div className="w-8 h-8 rounded-lg ring-2 ring-white dark:ring-neutral-900 bg-blue-600 text-white text-[10px] font-semibold flex items-center justify-center shrink-0">
                    +{selectedInFolder.length - 3}
                  </div>
                )}
              </div>
              <p className="flex-1 min-w-0 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                {selectedInFolder.length} selected
              </p>
              <button
                type="button"
                title="Clear selection"
                onClick={onClearSelection}
                className="shrink-0 p-1 rounded-full text-neutral-400 hover:text-neutral-600 hover:bg-gray-100 dark:hover:text-neutral-200 dark:hover:bg-neutral-800 transition-colors"
              >
                <IoClose size={16} />
              </button>
            </div>
            <div className="p-1.5 flex flex-col gap-0.5">
              <button
                type="button"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  onOpenMoveCopy(selectedInFolder, { left: rect.left, top: rect.bottom + 4 });
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
              >
                <IoFolderOutline size={16} className="text-neutral-400 dark:text-neutral-500 shrink-0" />
                <span className="flex-1 text-left">Move or copy to…</span>
                <IoChevronForward size={12} className="text-neutral-400 dark:text-neutral-500" />
              </button>
              <button
                type="button"
                onClick={() => openPhoneTransfer(selectedInFolder.filter((f) => !isVideoProjectPath(f.path)))}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
              >
                <IoPhonePortraitOutline size={16} className="text-neutral-400 dark:text-neutral-500 shrink-0" />
                <span className="flex-1 text-left">Transfer to phone</span>
              </button>
              <button
                type="button"
                onClick={() => onBulkDelete(selectedInFolder)}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
              >
                <IoTrashOutline size={16} className="shrink-0" />
                <span className="flex-1 text-left">Delete</span>
              </button>
            </div>
          </div>
        </>
      )}

      {contextMenu && (
        <FloatingContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          className="w-40 py-1 rounded-md bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 shadow-lg text-sm"
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700"
            onClick={() => {
              onOpenVideo(contextMenu.file);
              setContextMenu(null);
            }}
          >
            Open
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700"
            onClick={() => {
              void handleCopyPath(contextMenu.file);
              setContextMenu(null);
            }}
          >
            Copy path
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700"
            onClick={() => {
              onStartRename(contextMenu.file);
              setContextMenu(null);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700"
            onClick={() => {
              onConvertFile(contextMenu.file);
              setContextMenu(null);
            }}
          >
            Convert
          </button>
          {!isVideoProjectPath(contextMenu.file.path) && (
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700"
              onClick={() => {
                onSetThumbnail(contextMenu.file);
                setContextMenu(null);
              }}
            >
              Set thumbnail…
            </button>
          )}
          {/* Opens the shared Move/Copy menu (MoveCopyMenu.tsx) - for the whole selection when
              this tile is part of one, the same rule as the sidebar's own file menu. */}
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const target = selectedFilePaths.has(contextMenu.file.path) && selectedInFolder.length > 1 ? selectedInFolder : [contextMenu.file];
              onOpenMoveCopy(target, { left: rect.right + 4, top: rect.top });
              setContextMenu(null);
            }}
          >
            <span className="flex-1 text-left">Move or copy to…</span>
            <IoChevronForward size={11} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
          </button>
          {!isVideoProjectPath(contextMenu.file.path) && (
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700"
              onClick={() => {
                const target = selectedFilePaths.has(contextMenu.file.path) && selectedInFolder.length > 1 ? selectedInFolder : [contextMenu.file];
                openPhoneTransfer(target.filter((f) => !isVideoProjectPath(f.path)));
                setContextMenu(null);
              }}
            >
              Transfer to phone
            </button>
          )}
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700"
            onClick={() => {
              onShowInfo(contextMenu.file);
              setContextMenu(null);
            }}
          >
            Info
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700 text-red-600 dark:text-red-400"
            onClick={() => {
              onDeleteFile(contextMenu.file);
              setContextMenu(null);
            }}
          >
            Delete
          </button>
        </FloatingContextMenu>
      )}
    </div>
  );
};

export default VideoFolderGallery;
