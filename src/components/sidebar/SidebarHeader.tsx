// components/sidebar/SidebarHeader.tsx
//
// The top of the sidebar's file pane: the category tabs (and Trash), the search box, the folder
// label with its controls - refresh, new folder, hide empty folders, sort, list or grid, and
// previous/next with audio's repeat/shuffle/autoplay - and the bulk action bar for ticked files.
// Split out of Dashboard; the file list itself is SidebarFileTree.
import React, { type Dispatch, type SetStateAction } from "react";
import {
  IoBuildOutline,
  IoChevronBack,
  IoChevronForward,
  IoClose,
  IoEyeOffOutline,
  IoEyeOutline,
  IoGridOutline,
  IoListOutline,
  IoPhonePortraitOutline,
  IoPlayForwardOutline,
  IoRefresh,
  IoRepeatOutline,
  IoSearch,
  IoShuffleOutline,
  IoSwapVerticalOutline,
  IoTrashOutline,
} from "react-icons/io5";
import { MdCreateNewFolder } from "react-icons/md";
import { FileCategory, isConvertibleCategory } from "../../utils/fileCategory";
import { openPhoneReceive } from "../../services/phoneTransfer";
import { saveSidebarViewMode, type SidebarViewMode } from "../../utils/sidebarFolders";
import type { FileEntry, SidebarTab } from "../../utils/libraryEntries";
import type { BoardScreen } from "../board/BoardWorkspace";
import type { PopoverAnchor } from "../../hooks/useClampedPopoverPosition";
import { FILE_CATEGORY_TABS } from "./categoryTabs";

export interface SidebarHeaderProps {
  activeFileCategory: SidebarTab;
  selectFileCategory: (category: FileCategory) => void;
  handleOpenTrash: () => void;
  // Search.
  fileSearchQuery: string;
  setFileSearchQuery: Dispatch<SetStateAction<string>>;
  isSearchingFiles: boolean;
  hiddenBySearch: number;
  // The folder label and its controls.
  sidebarHeaderLabel: string;
  isRefreshingFiles: boolean;
  handleRefreshFiles: () => unknown;
  startCreateFolder: (parent: string) => void;
  hideEmptyFolders: boolean;
  setHideEmptyFolders: Dispatch<SetStateAction<boolean>>;
  fileSortMode: "name-asc" | "name-desc" | "type";
  setFileSortMode: Dispatch<SetStateAction<"name-asc" | "name-desc" | "type">>;
  isGridView: boolean;
  setSidebarViewMode: Dispatch<SetStateAction<SidebarViewMode>>;
  // Playing through the files: audio's repeat / shuffle / autoplay, previous and next.
  selectedFile: { path: string; name: string; sourcePath: string } | null;
  isImageFileSelected: boolean;
  audioRepeatMode: "off" | "all" | "one";
  cycleAudioRepeatMode: () => void;
  audioShuffle: boolean;
  setAudioShuffle: Dispatch<SetStateAction<boolean>>;
  audioAutoplayNext: boolean;
  setAudioAutoplayNext: Dispatch<SetStateAction<boolean>>;
  navigateAudio: (direction: 1 | -1, options?: { wrap?: boolean }) => void;
  navigateImage: (direction: 1 | -1) => void;
  dockerMode: "record" | "file-tools";
  setDockerMode: Dispatch<SetStateAction<"record" | "file-tools">>;
  // The bulk action bar, for ticked files.
  selectedFilePaths: Set<string>;
  setSelectedFilePaths: Dispatch<SetStateAction<Set<string>>>;
  getSelectedFileEntries: () => FileEntry[];
  handleBulkDeleteFiles: (files: FileEntry[]) => unknown;
  handleAddFilesToBoard: (files: FileEntry[]) => unknown;
  boardScreen: BoardScreen | null;
  setBulkConversionFiles: Dispatch<SetStateAction<FileEntry[] | null>>;
  setTransferMenu: Dispatch<SetStateAction<{ files: { name: string; path: string }[]; anchor: PopoverAnchor } | null>>;
}

const SidebarHeader: React.FC<SidebarHeaderProps> = ({
  activeFileCategory,
  selectFileCategory,
  handleOpenTrash,
  fileSearchQuery,
  setFileSearchQuery,
  isSearchingFiles,
  hiddenBySearch,
  sidebarHeaderLabel,
  isRefreshingFiles,
  handleRefreshFiles,
  startCreateFolder,
  hideEmptyFolders,
  setHideEmptyFolders,
  fileSortMode,
  setFileSortMode,
  isGridView,
  setSidebarViewMode,
  selectedFile,
  isImageFileSelected,
  audioRepeatMode,
  cycleAudioRepeatMode,
  audioShuffle,
  setAudioShuffle,
  audioAutoplayNext,
  setAudioAutoplayNext,
  navigateAudio,
  navigateImage,
  dockerMode,
  setDockerMode,
  selectedFilePaths,
  setSelectedFilePaths,
  getSelectedFileEntries,
  handleBulkDeleteFiles,
  handleAddFilesToBoard,
  boardScreen,
  setBulkConversionFiles,
  setTransferMenu,
}) => (
  <>
    {/* File type tabs */}
    <div className="flex items-center justify-around border-b border-gray-300 dark:border-neutral-700 py-2 shrink-0">
      {FILE_CATEGORY_TABS.map(({ category, label, icon }) => (
        <button
          key={category}
          type="button"
          title={label}
          onClick={() => selectFileCategory(category)}
          className={`flex flex-col items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
            activeFileCategory === category
              ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
              : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-neutral-800"
          }`}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
      <button
        type="button"
        title="Trash"
        onClick={handleOpenTrash}
        className={`flex flex-col items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
          activeFileCategory === "trash"
            ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
            : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-neutral-800"
        }`}
      >
        <IoTrashOutline size={18} />
        <span>Trash</span>
      </button>
    </div>

    {/* File search - filters the active tab's files (and trash) by name as you type.
        Fixed below the tabs, same as the folder-label bar beneath it. */}
    <div className="px-3 py-2 border-b border-gray-200 dark:border-neutral-700 shrink-0">
      <div className="relative">
        <IoSearch size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500 pointer-events-none" />
        <input
          type="text"
          value={fileSearchQuery}
          onChange={(e) => setFileSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && fileSearchQuery) {
              e.stopPropagation();
              setFileSearchQuery("");
            }
          }}
          placeholder="Search files and folders"
          className="w-full pl-7 pr-7 py-1.5 rounded-md text-xs bg-gray-100 dark:bg-neutral-800 border border-transparent focus:border-blue-400 dark:focus:border-blue-500 outline-none text-neutral-800 dark:text-neutral-100 placeholder:text-gray-400 dark:placeholder:text-neutral-500"
        />
        {fileSearchQuery && (
          <button
            type="button"
            title="Clear search"
            onClick={() => setFileSearchQuery("")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700"
          >
            <IoClose size={13} />
          </button>
        )}
      </div>
      {/* The query stays while files are opened and tabs switched, so a search typed
          earlier can quietly leave most of the library out - say so, with the way back. */}
      {isSearchingFiles && activeFileCategory !== "trash" && hiddenBySearch > 0 && (
        <button
          type="button"
          onClick={() => setFileSearchQuery("")}
          title="Clear the search and show every folder (Esc in the search box)"
          className="mt-1.5 w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-left bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20"
        >
          <IoSearch size={11} className="shrink-0" />
          <span className="flex-1 min-w-0 truncate">
            Only matches for “{fileSearchQuery.trim()}” · {hiddenBySearch} {hiddenBySearch === 1 ? "folder" : "folders"} hidden
          </span>
          <span className="shrink-0 font-medium underline underline-offset-2">Show all</span>
        </button>
      )}
    </div>

    {/* Folder label + prev/next/repeat/shuffle/autoplay controls — fixed below the
        tabs, does not scroll with the file list beneath it. */}
    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-neutral-700 shrink-0">
      <h3 className="font-semibold text-gray-700 dark:text-neutral-300 text-sm truncate">{sidebarHeaderLabel}</h3>
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          title="Refresh files"
          onClick={handleRefreshFiles}
          disabled={isRefreshingFiles}
          className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          <IoRefresh size={15} className={isRefreshingFiles ? "animate-spin" : ""} />
        </button>
        {activeFileCategory !== "trash" && (
          <button
            type="button"
            title="Get files from phone"
            onClick={openPhoneReceive}
            className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
          >
            <IoPhonePortraitOutline size={15} />
          </button>
        )}
        {activeFileCategory !== "trash" && (
          <button
            type="button"
            title="New folder"
            onClick={() => startCreateFolder("")}
            className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
          >
            <MdCreateNewFolder size={16} />
          </button>
        )}
        {activeFileCategory !== "trash" && (
          <button
            type="button"
            title={`Sort: ${fileSortMode === "name-asc" ? "Name (A-Z)" : fileSortMode === "name-desc" ? "Name (Z-A)" : "Type"} - click to cycle`}
            onClick={() =>
              setFileSortMode((prev) => (prev === "name-asc" ? "name-desc" : prev === "name-desc" ? "type" : "name-asc"))
            }
            className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
          >
            <IoSwapVerticalOutline size={15} />
          </button>
        )}
        {activeFileCategory !== "trash" && (
          <button
            type="button"
            title={isGridView ? "Switch to list view" : "Switch to grid view (thumbnails)"}
            onClick={() => {
              const next: SidebarViewMode = isGridView ? "list" : "grid";
              setSidebarViewMode(next);
              saveSidebarViewMode(next);
            }}
            className={`p-1 rounded transition-colors ${
              isGridView
                ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
                : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
            }`}
          >
            {isGridView ? <IoListOutline size={15} /> : <IoGridOutline size={15} />}
          </button>
        )}
        {activeFileCategory !== "trash" && (
          <button
            type="button"
            title={hideEmptyFolders ? `Show folders with no ${activeFileCategory} files` : `Hide folders with no ${activeFileCategory} files`}
            onClick={() => setHideEmptyFolders((prev) => !prev)}
            className={`p-1 rounded transition-colors ${
              hideEmptyFolders
                ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
                : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
            }`}
          >
            {hideEmptyFolders ? <IoEyeOffOutline size={15} /> : <IoEyeOutline size={15} />}
          </button>
        )}
        {activeFileCategory !== "trash" && (
          <button
            type="button"
            disabled={!selectedFile}
            title={
              !selectedFile
                ? "Select a file to see its tools"
                : dockerMode === "file-tools"
                ? isImageFileSelected
                  ? "Hide image tools"
                  : "Show recording controls"
                : isImageFileSelected
                ? "Show image tools"
                : "Show tools for this file"
            }
            onClick={() => setDockerMode((prev) => (prev === "record" ? "file-tools" : "record"))}
            className={`p-1 rounded transition-colors disabled:opacity-30 disabled:pointer-events-none ${
              dockerMode === "file-tools"
                ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
                : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
            }`}
          >
            <IoBuildOutline size={15} />
          </button>
        )}
        {(activeFileCategory === "image" || activeFileCategory === "audio") && (
          <>
            {activeFileCategory === "audio" && (
              <>
                <button
                  type="button"
                  title={`Repeat: ${audioRepeatMode === "off" ? "off" : audioRepeatMode === "all" ? "all" : "one"}`}
                  onClick={cycleAudioRepeatMode}
                  className={`relative p-1 rounded hover:bg-gray-100 dark:hover:bg-neutral-800 ${
                    audioRepeatMode !== "off"
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400"
                  }`}
                >
                  <IoRepeatOutline size={14} />
                  {audioRepeatMode === "one" && (
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-blue-600 dark:bg-blue-500 text-white text-[8px] font-bold leading-none flex items-center justify-center">
                      1
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  title={`Shuffle: ${audioShuffle ? "on" : "off"}`}
                  onClick={() => setAudioShuffle((prev) => !prev)}
                  className={`p-1 rounded hover:bg-gray-100 dark:hover:bg-neutral-800 ${
                    audioShuffle
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400"
                  }`}
                >
                  <IoShuffleOutline size={14} />
                </button>
                <button
                  type="button"
                  title={`Autoplay next track: ${audioAutoplayNext ? "on" : "off"}`}
                  onClick={() => setAudioAutoplayNext((prev) => !prev)}
                  className={`p-1 rounded hover:bg-gray-100 dark:hover:bg-neutral-800 ${
                    audioAutoplayNext
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400"
                  }`}
                >
                  <IoPlayForwardOutline size={14} />
                </button>
                <div className="w-px h-4 bg-gray-300 dark:bg-neutral-600 mx-0.5" />
              </>
            )}
            <button
              type="button"
              title="Previous (←)"
              onClick={() => (activeFileCategory === "audio" ? navigateAudio(-1) : navigateImage(-1))}
              className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
            >
              <IoChevronBack size={14} />
            </button>
            <button
              type="button"
              title="Next (→)"
              onClick={() => (activeFileCategory === "audio" ? navigateAudio(1) : navigateImage(1))}
              className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
            >
              <IoChevronForward size={14} />
            </button>
          </>
        )}
      </div>
    </div>

    {/* Bulk action bar — only for a real multi-selection (not trash, which has its
        own per-item restore/delete-forever actions already). */}
    {activeFileCategory !== "trash" && selectedFilePaths.size > 0 && (
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 dark:border-neutral-700 shrink-0 bg-blue-50 dark:bg-blue-500/10">
        <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
          {selectedFilePaths.size} selected
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setTransferMenu({ files: getSelectedFileEntries(), anchor: { left: rect.left, top: rect.bottom + 4 } });
            }}
            className="flex items-center gap-0.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            Move / Copy
            <IoChevronForward size={11} />
          </button>
          {isConvertibleCategory(activeFileCategory) && (
            <button
              type="button"
              onClick={() => setBulkConversionFiles(getSelectedFileEntries())}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
            >
              Convert
            </button>
          )}
          {/* Only when a board is actually open - see BoardEditorHandle/boardEditorRef.
              Image tab only, matching FILE_CATEGORY_EXTENSIONS.image being the only
              thing Board can place on its canvas. */}
          {boardScreen?.mode === "editor" && activeFileCategory === "image" && (
            <button
              type="button"
              onClick={() => void handleAddFilesToBoard(getSelectedFileEntries())}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
            >
              Add to board
            </button>
          )}
          <button
            type="button"
            onClick={() => handleBulkDeleteFiles(getSelectedFileEntries())}
            className="text-xs font-medium text-red-600 dark:text-red-400 hover:underline"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setSelectedFilePaths(new Set())}
            className="text-xs text-neutral-500 dark:text-neutral-400 hover:underline"
          >
            Clear
          </button>
        </div>
      </div>
    )}

  </>
);

export default SidebarHeader;
