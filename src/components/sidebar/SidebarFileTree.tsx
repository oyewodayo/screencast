// components/sidebar/SidebarFileTree.tsx
//
// The sidebar's file list - every folder of the active tab with its files (or the trash), with
// pinning, drag and drop, rename, the per-file menus and the add-to-video actions. Split out of
// Dashboard so it renders on its own terms: memoized, with stable page actions passed in
// (useStableCallbacks), it re-renders only when something it shows changes - not on every tick of
// playback or edit elsewhere on the page - and a caret click (folderCollapse) re-renders it alone.
//
// Clicks answer at once: a tapped file or folder lights up straight away, and the opening itself
// (loading the file, switching the page) starts on the next frame, after that has been painted.
import React, { memo, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  IoAddCircleOutline,
  IoArrowUndoOutline,
  IoChevronForward,
  IoFolderOpenOutline,
  IoFolderOutline,
  IoInformationCircleOutline,
  IoPin,
  IoPinOutline,
  IoSwapVerticalOutline,
  IoTimeOutline,
  IoTrashOutline,
} from "react-icons/io5";
import { formatFileName } from "../../utils/Formater";
import type { FileCategory } from "../../utils/fileCategory";
import { canMoveFolder, cycleFolderSort, togglePinnedFolder, type FolderSortMap } from "../../utils/sidebarFolders";
import { FileEntry, GALLERY_CATEGORIES, SidebarTab, TrashEntry, formatDeletedAt } from "../../utils/libraryEntries";
import type { DocSummary } from "../../utils/docTypes";
import type { BoardScreen } from "../board/BoardWorkspace";
import type { DocsScreen } from "../docs/DocsWorkspace";
import type { PopoverAnchor } from "../../hooks/useClampedPopoverPosition";
import { folderCollapse, useCollapsedFolders } from "./folderCollapse";
import SidebarFileRow, { type SidebarRowActions } from "./SidebarFileRow";
import { useStableCallbacks } from "../../hooks/useStableCallbacks";

export interface SidebarFileTreeProps {
  activeFileCategory: SidebarTab;
  filteredEntries: [string, FileEntry[]][];
  filteredTrashItems: TrashEntry[];
  firstUnpinnedIndex: number;
  isSearchingFiles: boolean;
  fileSearchQuery: string;
  isGridView: boolean;
  // The open file's path, the gallery's folder, and the files ticked for a bulk move.
  selectedPath: string | undefined;
  selectedFolder: string | null;
  selectedFilePaths: Set<string>;
  // A video is open in the editor (file rows offer to add to it).
  editingVideo: boolean;
  boardScreen: BoardScreen | null;
  pinnedFolders: string[];
  folderSorts: FolderSortMap;
  setFolderSorts: Dispatch<SetStateAction<FolderSortMap>>;
  pinnedPaths: string[];
  linkedDocsByPath: Map<string, DocSummary[]>;
  openMenu: string | null;
  addMenuFor: string | null;
  linkDocsMenuOpenFor: string | null;
  renamingFile: string | null;
  renameInGallery: boolean;
  creatingFolderIn: string | null;
  newFolderValue: string;
  draggingFiles: FileEntry[] | null;
  draggingFolder: string | null;
  dragOverFolder: string | null;
  // Page actions - stable (useStableCallbacks), always the page's latest.
  addMediaToVideo: (path: string, mode: "end" | "insert" | "overlay") => unknown;
  cancelRename: () => void;
  categoryIcon: (category: FileCategory | null) => React.ReactNode;
  categoryIconColorClassName: (category: FileCategory | null) => string;
  commitCreateFolder: () => unknown;
  commitRename: (file: FileEntry, value: string) => unknown;
  filesToActOn: (file: FileEntry) => FileEntry[];
  folderDepth: (folder: string) => number;
  folderDisplayName: (folder: string) => string;
  handleAddFilesToBoard: (files: FileEntry[]) => unknown;
  handleCopyFileImage: (file: FileEntry) => unknown;
  handleCopyFilePath: (file: FileEntry) => unknown;
  handleDeleteFile: (file: FileEntry) => unknown;
  handleDeleteFolder: (folder: string) => unknown;
  handleDeleteForever: (item: TrashEntry) => unknown;
  handleEmptyTrash: () => unknown;
  handleLinkNotes: (file: FileEntry) => unknown;
  handleMoveFiles: (files: FileEntry[], folder: string) => unknown;
  handleMoveFolder: (folder: string, dest: string) => unknown;
  handleRestoreFromTrash: (item: TrashEntry) => unknown;
  handleSetThumbnail: (file: FileEntry) => unknown;
  handleSidebarFilePointerDown: (file: FileEntry) => (e: React.PointerEvent) => void;
  handleSidebarFilePointerMove: (e: React.PointerEvent) => void;
  handleSidebarFilePointerUp: (file: FileEntry) => (e: React.PointerEvent) => unknown;
  handleTogglePin: (file: FileEntry) => unknown;
  isFolderEmpty: (folder: string) => boolean;
  // Whether the press on a file row turned into a drag (rather than a tap that opens it).
  isSidebarDragging: () => boolean;
  openFolderGallery: (folder: string) => Promise<void>;
  refreshDocsIndex: () => unknown;
  resolveImageThumbnailUrl: (file: { name: string; path: string }, bypassCache?: boolean) => Promise<string>;
  resolveVideoThumbnailUrl: (file: { name: string; path: string }, bypassCache?: boolean) => Promise<string>;
  startCreateFolder: (parent: string) => void;
  startRename: (file: FileEntry, inGallery?: boolean) => void;
  toggleFileSelected: (path: string) => void;
  setAddMenuFor: Dispatch<SetStateAction<string | null>>;
  setConversionFile: Dispatch<SetStateAction<{ path: string; name: string } | null>>;
  setCreatingFolderIn: Dispatch<SetStateAction<string | null>>;
  setDocsScreen: Dispatch<SetStateAction<DocsScreen | null>>;
  setDraggingFiles: Dispatch<SetStateAction<FileEntry[] | null>>;
  setDraggingFolder: Dispatch<SetStateAction<string | null>>;
  setDragOverFolder: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string>>;
  setFolderMoveMenu: Dispatch<SetStateAction<{ folder: string; anchor: { left: number; top: number } } | null>>;
  setInfoFile: Dispatch<SetStateAction<{ path: string; name: string } | null>>;
  setInfoTrashItem: Dispatch<SetStateAction<TrashEntry | null>>;
  setLinkDocsMenuOpenFor: Dispatch<SetStateAction<string | null>>;
  setNewFolderValue: Dispatch<SetStateAction<string>>;
  setOpenMenu: Dispatch<SetStateAction<string | null>>;
  setPinnedFolders: Dispatch<SetStateAction<string[]>>;
  setSelectedFile: Dispatch<SetStateAction<{ path: string; name: string; sourcePath: string } | null>>;
  setTransferMenu: Dispatch<SetStateAction<{ files: { name: string; path: string }[]; anchor: PopoverAnchor } | null>>;
}

// After the browser has painted what's on screen now (a frame, then a task).
const afterPaint = (run: () => void) => requestAnimationFrame(() => setTimeout(run, 0));

const SidebarFileTree: React.FC<SidebarFileTreeProps> = (props) => {
  const {
    activeFileCategory,
    filteredEntries,
    filteredTrashItems,
    firstUnpinnedIndex,
    isSearchingFiles,
    fileSearchQuery,
    isGridView,
    selectedPath,
    selectedFolder,
    selectedFilePaths,
    editingVideo,
    boardScreen,
    pinnedFolders,
    folderSorts,
    setFolderSorts,
    pinnedPaths,
    linkedDocsByPath,
    openMenu,
    addMenuFor,
    linkDocsMenuOpenFor,
    renamingFile,
    renameInGallery,
    creatingFolderIn,
    newFolderValue,
    draggingFiles,
    draggingFolder,
    dragOverFolder,
    addMediaToVideo,
    cancelRename,
    categoryIcon,
    categoryIconColorClassName,
    commitCreateFolder,
    commitRename,
    filesToActOn,
    folderDepth,
    folderDisplayName,
    handleAddFilesToBoard,
    handleCopyFileImage,
    handleCopyFilePath,
    handleDeleteFile,
    handleDeleteFolder,
    handleDeleteForever,
    handleEmptyTrash,
    handleLinkNotes,
    handleMoveFiles,
    handleMoveFolder,
    handleRestoreFromTrash,
    handleSetThumbnail,
    handleSidebarFilePointerDown,
    handleSidebarFilePointerMove,
    handleSidebarFilePointerUp,
    handleTogglePin,
    isFolderEmpty,
    isSidebarDragging,
    openFolderGallery,
    refreshDocsIndex,
    resolveImageThumbnailUrl,
    resolveVideoThumbnailUrl,
    startCreateFolder,
    startRename,
    toggleFileSelected,
    setAddMenuFor,
    setConversionFile,
    setCreatingFolderIn,
    setDocsScreen,
    setDraggingFiles,
    setDraggingFolder,
    setDragOverFolder,
    setError,
    setFolderMoveMenu,
    setInfoFile,
    setInfoTrashItem,
    setLinkDocsMenuOpenFor,
    setNewFolderValue,
    setOpenMenu,
    setPinnedFolders,
    setSelectedFile,
    setTransferMenu,
  } = props;
  const collapsedFolders = useCollapsedFolders();

  // What was just clicked, shown as selected until the page catches up (or the open is called off).
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [openingFolder, setOpeningFolder] = useState<string | null>(null);
  useEffect(() => setOpeningPath(null), [selectedPath]);
  useEffect(() => setOpeningFolder(null), [selectedFolder]);
  const shownPath = openingPath ?? selectedPath;
  const shownFolder = openingFolder ?? selectedFolder;

  // A tap on a file: lit at once, opened after that's painted. A drag goes straight through.
  const tapFile = (file: FileEntry) => (e: React.PointerEvent) => {
    if (isSidebarDragging()) {
      void handleSidebarFilePointerUp(file)(e);
      return;
    }
    setOpeningPath(file.path);
    afterPaint(() => void Promise.resolve(handleSidebarFilePointerUp(file)(e)).finally(() => setOpeningPath(null)));
  };
  // What every row is handed - the same object each render, so rows skip re-rendering when
  // nothing of their own changed.
  const rowActions: SidebarRowActions = useStableCallbacks({
    addMediaToVideo,
    cancelRename,
    categoryIcon,
    categoryIconColorClassName,
    commitRename,
    filesToActOn,
    handleAddFilesToBoard,
    handleCopyFileImage,
    handleCopyFilePath,
    handleDeleteFile,
    handleLinkNotes,
    handleSetThumbnail,
    handleSidebarFilePointerDown,
    handleSidebarFilePointerMove,
    handleTogglePin,
    refreshDocsIndex,
    resolveImageThumbnailUrl,
    resolveVideoThumbnailUrl,
    startRename,
    toggleFileSelected,
    setAddMenuFor,
    setConversionFile,
    setDocsScreen,
    setDraggingFiles,
    setDragOverFolder,
    setError,
    setInfoFile,
    setLinkDocsMenuOpenFor,
    setOpenMenu,
    setSelectedFile,
    setTransferMenu,
    tapFile: (file: FileEntry) => tapFile(file),
  });
  const openFolder = (folder: string) => {
    if (!GALLERY_CATEGORIES.includes(activeFileCategory)) return;
    setOpeningFolder(folder);
    afterPaint(() => void openFolderGallery(folder).finally(() => setOpeningFolder(null)));
  };

  return (
    <>
    {activeFileCategory === "trash" ? (
      filteredTrashItems.length === 0 ? (
        <p>{isSearchingFiles ? "No matching trash items" : "Trash is empty"}</p>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {filteredTrashItems.length} item{filteredTrashItems.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={handleEmptyTrash}
              className="text-xs text-red-600 dark:text-red-400 hover:underline"
            >
              Empty Trash
            </button>
          </div>
          <ul className="space-y-0.5">
            {filteredTrashItems.map((item) => (
              <li
                key={item.trashed_name}
                className="flex items-center justify-between gap-2 group px-1 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-neutral-800"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate" title={item.name}>{formatFileName(item.name)}</div>
                  <div className="text-[10px] text-neutral-400 dark:text-neutral-500">Deleted {formatDeletedAt(item.deleted_at)}</div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    type="button"
                    title="Info"
                    onClick={() => setInfoTrashItem(item)}
                    className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-200 dark:hover:bg-neutral-700"
                  >
                    <IoInformationCircleOutline size={14} />
                  </button>
                  <button
                    type="button"
                    title="Restore"
                    onClick={() => handleRestoreFromTrash(item)}
                    className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-200 dark:hover:bg-neutral-700"
                  >
                    <IoArrowUndoOutline size={14} />
                  </button>
                  <button
                    type="button"
                    title="Delete forever"
                    onClick={() => handleDeleteForever(item)}
                    className="p-1 rounded text-red-500 hover:bg-red-100 dark:hover:bg-red-500/20"
                  >
                    <IoTrashOutline size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )
    ) : filteredEntries.length === 0 ? (
      <p>{isSearchingFiles ? `No ${activeFileCategory} files match "${fileSearchQuery.trim()}"` : `No ${activeFileCategory} files found`}</p>
    ) : (
      filteredEntries.map(([folder, fileList], folderIndex) => (
        <div
          key={folder}
          className="mb-3"
          // Folder-as-drop-target: reacts to an in-app file drag (draggingFiles) or an
          // OS file being dragged in from outside (e.dataTransfer.types includes
          // "Files", e.g. from Windows Explorer — this "types" check works during
          // dragover regardless of Tauri's native file-drop interception, which only
          // affects the final `drop` event's data, not the drag session itself) —
          // plain mouse hovering does neither, so it never lights up on its own.
          // This is purely visual/targeting state: for an external OS drag, the actual
          // import happens in the top-level onFileDropEvent listener above (which is
          // where the real file paths are available), not in onDrop below — a plain
          // HTML5 drop of an OS file never carries a usable path here.
          onDragOver={(e) => {
            if (draggingFolder !== null) {
              if (!canMoveFolder(draggingFolder, folder)) return;
            } else if (!draggingFiles && !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            if (dragOverFolder !== folder) setDragOverFolder(folder);
          }}
          onDragLeave={() => setDragOverFolder((prev) => (prev === folder ? null : prev))}
          onDrop={(e) => {
            e.preventDefault();
            if (draggingFolder !== null) void handleMoveFolder(draggingFolder, folder);
            else if (draggingFiles) handleMoveFiles(draggingFiles, folder);
          }}
        >
          {folderIndex === 0 && firstUnpinnedIndex !== 0 && (
            <div className="flex items-center gap-1 -mx-1 px-1 mb-1 text-[10px] font-semibold uppercase tracking-wide text-blue-500 dark:text-blue-400">
              <IoPin size={10} /> Pinned
            </div>
          )}
          {folderIndex === firstUnpinnedIndex && firstUnpinnedIndex > 0 && (
            <div className="-mx-1 px-1 mb-1 pt-2 border-t border-gray-200 dark:border-neutral-700 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500">
              All folders
            </div>
          )}
          <div
            className={`group/folder flex items-center justify-between gap-1 -mx-1 px-1 py-0.5 rounded transition-colors ${
              dragOverFolder === folder ? "bg-blue-100 dark:bg-blue-500/20 ring-1 ring-blue-400" : ""
            }`}
            style={{ paddingLeft: 4 + folderDepth(folder) * 10 }}
            // Drag a folder onto another folder (or the Briefcast root) to move all of it.
            draggable={folder !== ""}
            onDragStart={(e) => {
              if (folder === "") return;
              e.stopPropagation();
              setDraggingFolder(folder);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", folder);
            }}
            onDragEnd={() => {
              setDraggingFolder(null);
              setDragOverFolder(null);
            }}
          >
            <h4
              className={`text-xs font-semibold flex items-center gap-1 min-w-0 truncate cursor-pointer ${
                GALLERY_CATEGORIES.includes(activeFileCategory) && shownFolder === folder
                  ? "text-blue-600 dark:text-blue-400"
                  : "text-gray-500 dark:text-neutral-400"
              }`}
              // Full relative path here (not just folderDisplayName's leaf segment) so
              // two folders sharing a name at different nesting depths - e.g. two
              // "MSC Research" folders - are distinguishable on hover instead of both
              // showing an identical tooltip.
              title={`Open "${folder || "Briefcast"}"`}
            >
              <button
                type="button"
                title={`${collapsedFolders.has(folder) ? "Expand" : "Collapse"} "${folder || "Briefcast"}"`}
                onClick={(e) => {
                  e.stopPropagation();
                  folderCollapse.toggle(folder);
                }}
                className="shrink-0 p-1 -m-1 rounded hover:bg-gray-200 dark:hover:bg-neutral-700"
              >
                <IoChevronForward size={10} className={`transition-transform ${collapsedFolders.has(folder) ? "" : "rotate-90"}`} />
              </button>
              <span className="flex items-center gap-1 min-w-0 ml-1" onClick={() => openFolder(folder)}>
                <IoFolderOutline size={12} className="shrink-0" />
                <span className="truncate">{folderDisplayName(folder)}</span>
              </span>
              {pinnedFolders.includes(folder) && <IoPin size={11} className="shrink-0 text-blue-500 dark:text-blue-400" />}
            </h4>
            <div className="flex items-center gap-0.5 shrink-0">
              {(
                <button
                  type="button"
                  title={
                    folderSorts[folder] === "date-desc"
                      ? "Sorted by date: newest first - click for oldest first"
                      : folderSorts[folder] === "date-asc"
                        ? "Sorted by date: oldest first - click for name order"
                        : "Sorted by name - click to sort by date (newest first)"
                  }
                  onClick={() => setFolderSorts(cycleFolderSort(folder))}
                  className={`p-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 transition-opacity ${
                    folderSorts[folder]
                      ? "text-blue-500 dark:text-blue-400"
                      : "text-gray-400 hover:text-blue-500 opacity-0 group-hover/folder:opacity-100"
                  }`}
                >
                  {folderSorts[folder] ? (
                    <span className="flex items-center">
                      <IoTimeOutline size={12} />
                      <span className="text-[10px] leading-none">{folderSorts[folder] === "date-desc" ? "↓" : "↑"}</span>
                    </span>
                  ) : (
                    <IoSwapVerticalOutline size={13} />
                  )}
                </button>
              )}
             <div className="flex items-center gap-0.5 opacity-0 group-hover/folder:opacity-100 transition-opacity">
              {folder !== "" && (
                <button
                  type="button"
                  title={pinnedFolders.includes(folder) ? "Unpin folder" : "Pin folder to the top"}
                  onClick={() => setPinnedFolders(togglePinnedFolder(folder))}
                  className={`p-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 ${
                    pinnedFolders.includes(folder) ? "text-blue-500 dark:text-blue-400" : "text-gray-400 hover:text-blue-500"
                  }`}
                >
                  {pinnedFolders.includes(folder) ? <IoPin size={13} /> : <IoPinOutline size={13} />}
                </button>
              )}
              {isFolderEmpty(folder) && (
                <button
                  type="button"
                  title="Delete empty folder"
                  onClick={() => handleDeleteFolder(folder)}
                  className="p-0.5 rounded text-gray-400 hover:text-red-500 hover:bg-gray-200 dark:hover:bg-neutral-700"
                >
                  <IoTrashOutline size={13} />
                </button>
              )}
              {folder !== "" && (
                <button
                  type="button"
                  title="Move folder to…"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setFolderMoveMenu({ folder, anchor: { left: rect.left, top: rect.bottom + 4 } });
                  }}
                  className="p-0.5 rounded text-gray-400 hover:text-blue-500 hover:bg-gray-200 dark:hover:bg-neutral-700"
                >
                  <IoFolderOpenOutline size={13} />
                </button>
              )}
              <button
                type="button"
                title="New subfolder"
                onClick={() => startCreateFolder(folder)}
                className="p-0.5 rounded text-gray-400 hover:text-blue-500 hover:bg-gray-200 dark:hover:bg-neutral-700"
              >
                <IoAddCircleOutline size={14} />
              </button>
             </div>
            </div>
          </div>

          {!collapsedFolders.has(folder) && creatingFolderIn === folder && (
            <div className="flex items-center gap-1 mt-1" style={{ paddingLeft: 4 + (folderDepth(folder) + 1) * 10 }}>
              <IoFolderOutline size={12} className="text-gray-400 shrink-0" />
              <input
                autoFocus
                value={newFolderValue}
                onChange={(e) => setNewFolderValue(e.target.value)}
                onBlur={commitCreateFolder}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCreateFolder();
                  if (e.key === "Escape") setCreatingFolderIn(null);
                }}
                placeholder="Folder name"
                className="flex-1 min-w-0 border border-blue-400 rounded px-1 text-xs bg-white dark:bg-neutral-800"
              />
            </div>
          )}

          {collapsedFolders.has(folder) && !isSearchingFiles ? null : fileList.length === 0 ? (
            <p
              className="text-[11px] text-neutral-400 dark:text-neutral-500 italic mt-1"
              style={{ paddingLeft: 4 + (folderDepth(folder) + 1) * 10 }}
            >
              No {activeFileCategory} files
            </p>
          ) : (
            <ul
              // Grid tiles fill the width: two across at the narrowest sidebar, more as it widens.
              className={isGridView ? "mt-1 grid gap-2 grid-cols-[repeat(auto-fill,minmax(118px,1fr))]" : "mt-1 space-y-0.5"}
              style={{ paddingLeft: 4 + (folderDepth(folder) + 1) * 10 }}
            >
              {fileList.map((file) => (
                <SidebarFileRow
                  key={file.path}
                  file={file}
                  selected={shownPath === file.path}
                  isOpen={selectedPath === file.path}
                  checked={selectedFilePaths.has(file.path)}
                  dragging={!!draggingFiles?.some((f) => f.path === file.path)}
                  renaming={renamingFile === file.path}
                  pinned={pinnedPaths.includes(file.path)}
                  menuOpen={openMenu === file.path}
                  addMenuOpen={addMenuFor === file.path}
                  linkMenuOpen={linkDocsMenuOpenFor === file.path}
                  linkedDocs={linkedDocsByPath.get(file.path)}
                  anyChecked={selectedFilePaths.size > 0}
                  isGridView={isGridView}
                  editingVideo={editingVideo}
                  boardEditor={boardScreen?.mode === "editor"}
                  renameInGallery={renameInGallery}
                  actions={rowActions}
                />
              ))}
            </ul>
          )}
        </div>
      ))
    )}

    </>
  );
};

export default memo(SidebarFileTree);
