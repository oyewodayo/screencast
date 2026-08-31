// components/ImageFolderGallery.tsx
//
// Thumbnail grid shown in the main board when an Image folder is selected in the sidebar
// (rather than a single file) - lets the user see every image in the folder at a glance and
// double-click one to open it full-size in ImageEditor (see Dashboard.tsx's selectedFolder
// state). Right-click (or the hover kebab button) opens a per-image context menu - copy path/
// image, rename, convert, delete - the same actions the sidebar's own 3-dot menu already offers,
// wired to the same Dashboard.tsx handlers so both stay in sync automatically.
//
// Multi-select follows the same Explorer-standard conventions the sidebar's own checkbox
// multi-select doesn't (it has no keyboard-modifier support) - plain click selects only that
// tile, Ctrl/Cmd-click toggles one tile without touching the rest, Shift-click selects the whole
// range since the last-clicked tile. All three drive the SAME selectedFilePaths Set Dashboard.tsx
// already threads through the sidebar's bulk action bar, so a gallery selection and a sidebar
// selection are one and the same thing, not two parallel selection models.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoChevronForward, IoClose, IoEllipsisVertical, IoFolderOutline, IoImageOutline, IoTrashOutline } from "react-icons/io5";
import { formatFileName } from "../utils/Formater";
import { preloadImage } from "../utils/imageObjectCache";

interface GalleryFile {
  name: string;
  path: string;
}

interface ImageFolderGalleryProps {
  files: GalleryFile[];
  folderLabel: string;
  // Small (~480px) preview for a grid tile - see Dashboard.tsx's resolveImageThumbnailUrl. NOT
  // the same as resolveFullUrl below: pointing every tile at a full-resolution decode is what
  // used to make a large folder slow to load and re-decode on every scroll (see that resolver's
  // own doc comment for the full story).
  resolveThumbnailUrl: (file: GalleryFile) => Promise<string>;
  // Full-resolution asset URL - used by "Copy image" (which should copy full quality, not a
  // thumbnail) and nothing else here; opening a file is handled by onOpenImage below instead,
  // via Dashboard.tsx's own loadFileForPlayback.
  resolveFullUrl: (file: GalleryFile) => Promise<string>;
  onOpenImage: (file: GalleryFile) => void;
  onDeleteFile: (file: GalleryFile) => void;
  onConvertFile: (file: GalleryFile) => void;
  // Rename is inline (matches the sidebar's own inline rename), so its state is lifted to
  // Dashboard.tsx - one rename in flight at a time, shared with the sidebar list, rather than a
  // second parallel rename state living only here.
  renamingFile: string | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: (file: GalleryFile) => void;
  onCommitRename: (file: GalleryFile) => void;
  onCancelRename: () => void;
  // Lifted multi-selection - see this file's own doc comment above. `selectedFilePaths` spans
  // every folder/category (it's Dashboard.tsx's one shared selection set), not just this one, so
  // every consumer here filters it down to `files` first.
  selectedFilePaths: Set<string>;
  onToggleFileSelected: (path: string) => void;
  onSelectOnly: (path: string) => void;
  onSelectRange: (paths: string[]) => void;
  onClearSelection: () => void;
  // Every folder in the library, for the selection panel's "Move to" list - excludes whichever
  // one is `currentFolder` (nothing to gain moving a selection into the folder it's already in).
  folderOptions: { key: string; label: string }[];
  currentFolder: string;
  onMoveFiles: (files: GalleryFile[], destFolder: string) => void;
  onBulkDelete: (files: GalleryFile[]) => void;
}

const STATUS_RESET_MS = 1500;
// See the thumbnail-resolving effect below for why this is bounded rather than unlimited.
const THUMB_CONCURRENCY = 4;

const ImageFolderGallery: React.FC<ImageFolderGalleryProps> = ({
  files,
  folderLabel,
  resolveThumbnailUrl,
  resolveFullUrl,
  onOpenImage,
  onDeleteFile,
  onConvertFile,
  renamingFile,
  renameValue,
  onRenameValueChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  selectedFilePaths,
  onToggleFileSelected,
  onSelectOnly,
  onSelectRange,
  onClearSelection,
  folderOptions,
  currentFolder,
  onMoveFiles,
  onBulkDelete,
}) => {
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [contextMenu, setContextMenu] = useState<{ file: GalleryFile; x: number; y: number } | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [bulkMoveOpen, setBulkMoveOpen] = useState<boolean>(false);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Anchor for Shift-click range-select - the index of the last tile clicked WITHOUT Shift (a
  // plain or Ctrl/Cmd click). A ref, not state: it only needs to be read back on a later click,
  // never rendered.
  const lastClickedIndexRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const pending = files.filter((file) => !thumbUrls[file.path]);
    let nextIndex = 0;

    // Resolves at most THUMB_CONCURRENCY files at once instead of firing every file in the
    // folder simultaneously - even a small, fast-to-generate thumbnail still means a backend
    // invoke (and, for HEIC/HEIF, a bundled heif-thumbnailer process spawn - see
    // resolveImageThumbnailUrl in Dashboard.tsx) per file, and firing 100+ of those at once
    // thrashes the machine and is *slower* overall than a bounded queue, not just harder on it.
    // Once a photo's thumbnail is cached (get_image_thumbnail's content-addressed temp cache),
    // this cost is paid exactly once - a second visit to the same folder resolves instantly
    // regardless of this concurrency cap.
    const worker = async () => {
      while (!cancelled) {
        const i = nextIndex++;
        if (i >= pending.length) return;
        const file = pending[i];
        try {
          const url = await resolveThumbnailUrl(file);
          if (cancelled) return;
          setThumbUrls((prev) => (prev[file.path] ? prev : { ...prev, [file.path]: url }));
        } catch (err) {
          console.error(`Failed to resolve thumbnail for ${file.path}:`, err);
        }
      }
    };
    for (let i = 0; i < Math.min(THUMB_CONCURRENCY, pending.length); i++) void worker();

    return () => {
      cancelled = true;
    };
    // Only re-run when the folder's file list itself changes - thumbUrls updates every time a
    // thumbnail resolves, and including it here would re-trigger this effect on every single one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, resolveThumbnailUrl]);

  // Closes the context menu on any click/tap outside it - same pattern VideoOverlayLayer.tsx's
  // own right-click menu uses, including the pointerdown (not click) listener so a press that
  // opens a *different* tile's menu doesn't get eaten by this one closing first.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [contextMenu]);

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

  // Draws the resolved image into an offscreen canvas and copies that as a PNG - same approach
  // ImageEditor.tsx's own "Copy to clipboard" uses. preloadImage sets crossOrigin="anonymous" on
  // the asset:// source, which is what keeps the canvas untainted (a plain <img> would throw a
  // SecurityError on toBlob) - see imageObjectCache.ts's doc comment for the concrete history.
  const handleCopyImage = async (file: GalleryFile) => {
    try {
      const url = await resolveFullUrl(file);
      const img = await preloadImage(url);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas is not supported");
      ctx.drawImage(img, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to encode image as PNG"))), "image/png");
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flashStatus("Image copied");
    } catch (err) {
      console.error("Failed to copy image to clipboard:", err);
      flashStatus("Copy failed");
    }
  };

  const openMenuFor = (file: GalleryFile, x: number, y: number) => {
    setContextMenu({ file, x, y });
  };

  const selectedInFolder = files.filter((file) => selectedFilePaths.has(file.path));

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full gap-3 text-gray-500 dark:text-neutral-400">
        <IoImageOutline size={40} className="text-gray-300 dark:text-neutral-700" />
        <p className="text-sm">No images in {folderLabel}</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full overflow-y-auto p-4">
      {actionStatus && (
        <div className="absolute top-2 right-3 z-20 px-2.5 py-1 rounded-md bg-neutral-900/90 text-white text-xs shadow-lg">
          {actionStatus}
        </div>
      )}
      <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-3">
        {folderLabel} — {files.length} image{files.length === 1 ? "" : "s"}
      </p>
      <div
        className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3"
        onClick={(e) => {
          // Clicking empty grid space (not a tile - tile clicks are handled and don't bubble
          // here unhandled) clears the selection, matching a normal file manager's background
          // click. Guarded on the event target being the grid itself so this never fires for a
          // click that originated on a tile and merely bubbled up.
          if (e.target === e.currentTarget) onClearSelection();
        }}
      >
        {files.map((file, index) => (
          <div
            key={file.path}
            role="button"
            tabIndex={0}
            onClick={(e) => {
              if (e.shiftKey && lastClickedIndexRef.current !== null) {
                const [from, to] = [lastClickedIndexRef.current, index].sort((a, b) => a - b);
                onSelectRange(files.slice(from, to + 1).map((f) => f.path));
              } else if (e.ctrlKey || e.metaKey) {
                onToggleFileSelected(file.path);
                lastClickedIndexRef.current = index;
              } else {
                onSelectOnly(file.path);
                lastClickedIndexRef.current = index;
              }
            }}
            onDoubleClick={() => onOpenImage(file)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onOpenImage(file);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenuFor(file, e.clientX, e.clientY);
            }}
            title={file.name}
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
            <div className="aspect-square w-full bg-gray-100 dark:bg-neutral-800 flex items-center justify-center overflow-hidden">
              {thumbUrls[file.path] ? (
                <img
                  src={thumbUrls[file.path]}
                  alt={file.name}
                  loading="lazy"
                  draggable={false}
                  className="w-full h-full object-cover"
                />
              ) : (
                <IoImageOutline size={22} className="text-gray-300 dark:text-neutral-700" />
              )}
            </div>
            {renamingFile === file.path ? (
              <input
                autoFocus
                value={renameValue}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onRenameValueChange(e.target.value)}
                onBlur={() => onCommitRename(file)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") onCommitRename(file);
                  if (e.key === "Escape") onCancelRename();
                }}
                className="mx-1 my-1 min-w-0 border border-blue-400 rounded px-1 text-[11px] bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100"
              />
            ) : (
              <span className="text-[11px] text-gray-600 dark:text-neutral-300 truncate px-1.5 py-1">
                {formatFileName(file.name)}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Selection panel - fixed (not just sticky-within-scroll) so it stays in view regardless
          of scroll position, per the user's own "sticky option at the right" ask. Only for a real
          multi-selection (2+) - a single selected tile already has its own highlighted ring and
          per-tile kebab/context menu, so a panel for exactly one would just be visual noise
          duplicating what's already on screen. Bulk convert deliberately isn't offered here
          (unlike the sidebar's own bulk bar, which does have it for video/audio) - a folder-sized
          image selection can run into the dozens/hundreds, and queuing that many ffmpeg
          conversions at once doesn't scale the way a single-file Convert (still in the per-image
          context menu) does; Move and Delete are the operations that actually benefit from being
          batched. */}
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
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setBulkMoveOpen((prev) => !prev)}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
                >
                  <IoFolderOutline size={16} className="text-neutral-400 dark:text-neutral-500 shrink-0" />
                  <span className="flex-1 text-left">Move to</span>
                  <IoChevronForward
                    size={12}
                    className={`text-neutral-400 dark:text-neutral-500 transition-transform ${bulkMoveOpen ? "rotate-90" : ""}`}
                  />
                </button>
                {bulkMoveOpen && (
                  <div className="mt-1 max-h-40 overflow-y-auto border border-gray-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-900 shadow-inner">
                    {folderOptions.filter((folder) => folder.key !== currentFolder).length === 0 ? (
                      <p className="px-3 py-1.5 text-xs text-neutral-400 dark:text-neutral-500 italic">No other folders</p>
                    ) : (
                      folderOptions
                        .filter((folder) => folder.key !== currentFolder)
                        .map((folder) => (
                          <button
                            key={folder.key || "__root__"}
                            type="button"
                            className="w-full text-left px-3 py-1.5 text-xs truncate hover:bg-gray-100 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300"
                            onClick={() => {
                              onMoveFiles(selectedInFolder, folder.key);
                              setBulkMoveOpen(false);
                            }}
                          >
                            {folder.label}
                          </button>
                        ))
                    )}
                  </div>
                )}
              </div>
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

      {contextMenu &&
        createPortal(
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 9999 }}
            className="w-40 py-1 rounded-md bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 shadow-lg text-sm"
          >
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700"
              onClick={() => {
                onOpenImage(contextMenu.file);
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
                void handleCopyImage(contextMenu.file);
                setContextMenu(null);
              }}
            >
              Copy image
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
          </div>,
          document.body
        )}
    </div>
  );
};

export default ImageFolderGallery;
