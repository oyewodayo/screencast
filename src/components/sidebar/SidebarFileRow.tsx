// components/sidebar/SidebarFileRow.tsx
//
// One file in the sidebar tree (SidebarFileTree): its icon or tile, name, badges, the bulk-move
// checkbox, the add-to-video and per-file menus. Memoized on plain values - is it selected,
// ticked, renaming, its menus open - and one stable set of page actions, so selecting a file
// re-renders two rows, collapsing a folder only that folder's, and a library of thousands answers
// a click as fast as one of ten.
import React, { memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as Y from "yjs";
import {
  IoAdd,
  IoAddCircleOutline,
  IoCopyOutline,
  IoCreateOutline,
  IoChevronForward,
  IoFolderOutline,
  IoImageOutline,
  IoInformationCircleOutline,
  IoPhonePortraitOutline,
  IoPin,
  IoPinOutline,
  IoSwapHorizontalOutline,
  IoTrashOutline,
} from "react-icons/io5";
import { MdOutlineDescription } from "react-icons/md";
import SidebarFileIcon from "../SidebarFileIcon";
import InlineRenameInput from "../InlineRenameInput";
import { FileNameText } from "../SidebarResize";
import { getFileCategory, isConvertibleCategory, isCompressibleCategory } from "../../utils/fileCategory";
import { IoContractOutline } from "react-icons/io5";
import { isVideoProjectPath } from "../../utils/videoEditTypes";
import { openPhoneTransfer } from "../../services/phoneTransfer";
import type { DocSummary } from "../../utils/docTypes";
import type { FileEntry } from "../../utils/libraryEntries";
import type { SidebarFileTreeProps } from "./SidebarFileTree";

export type SidebarRowActions = Pick<SidebarFileTreeProps, "addMediaToVideo" | "cancelRename" | "categoryIcon" | "categoryIconColorClassName" | "commitRename" | "filesToActOn" | "handleAddFilesToBoard" | "handleCopyFileImage" | "handleCopyFilePath" | "handleDeleteFile" | "handleLinkNotes" | "handleSetThumbnail" | "handleSidebarFilePointerDown" | "handleSidebarFilePointerMove" | "handleTogglePin" | "refreshDocsIndex" | "resolveImageThumbnailUrl" | "resolveVideoThumbnailUrl" | "startRename" | "toggleFileSelected" | "setAddMenuFor" | "setConversionFile" | "setCompressionFile" | "setDocsScreen" | "setDraggingFiles" | "setDragOverFolder" | "setError" | "setInfoFile" | "setLinkDocsMenuOpenFor" | "setOpenMenu" | "setSelectedFile" | "setTransferMenu"> & {
  // The tree's tap: lights the row at once, opens the file after that's painted.
  tapFile: (file: FileEntry) => (e: React.PointerEvent) => void;
};

interface SidebarFileRowProps {
  file: FileEntry;
  // This row's own state.
  selected: boolean;
  // It's the file open right now (not merely the one just tapped).
  isOpen: boolean;
  checked: boolean;
  dragging: boolean;
  renaming: boolean;
  pinned: boolean;
  menuOpen: boolean;
  addMenuOpen: boolean;
  linkMenuOpen: boolean;
  linkedDocs: DocSummary[] | undefined;
  // The tree's state every row shares.
  anyChecked: boolean;
  isGridView: boolean;
  editingVideo: boolean;
  boardEditor: boolean;
  renameInGallery: boolean;
  actions: SidebarRowActions;
}

const SidebarFileRow: React.FC<SidebarFileRowProps> = ({ file, selected, isOpen, checked, dragging, renaming, pinned, menuOpen, addMenuOpen, linkMenuOpen, linkedDocs, anyChecked, isGridView, editingVideo, boardEditor, renameInGallery, actions }) => {
  const {
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
    setCompressionFile,
    setDocsScreen,
    setDraggingFiles,
    setDragOverFolder,
    setError,
    setInfoFile,
    setLinkDocsMenuOpenFor,
    setOpenMenu,
    setSelectedFile,
    setTransferMenu,
    tapFile,
  } = actions;
  return (
    <li
      data-file-path={file.path}
      draggable
      onDragStart={(e) => {
        // While a video is being edited, dragging a video, picture or sound
        // takes it into the editor (handleSidebarFilePointerDown) - the
        // browser's own drag would cancel that gesture the moment it began.
        if (editingVideo && ["video", "image", "audio"].includes(getFileCategory(file.name) ?? "")) {
          e.preventDefault();
          return;
        }
        setDraggingFiles(filesToActOn(file));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        setDraggingFiles(null);
        setDragOverFolder(null);
      }}
      className={`${isGridView ? "relative flex flex-col gap-1 min-w-0 group cursor-pointer p-1 rounded-lg" : "flex items-center gap-1.5 min-w-0 group cursor-pointer -mx-1 px-1 py-1 rounded-md"} hover:bg-gray-50 dark:hover:bg-neutral-800 ${
        selected ? 'bg-blue-50 dark:bg-blue-500/10' : ''
      } ${dragging ? 'opacity-40' : ''}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onClick={(e) => e.stopPropagation()}
        onChange={() => toggleFileSelected(file.path)}
        title="Select for bulk move"
        className={`shrink-0 accent-blue-500 transition-opacity ${isGridView ? "absolute top-2 left-2 z-10" : ""} ${
          anyChecked || checked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      />
      {isGridView ? (
        // Same tap-to-open / drag-to-timeline gesture as the filename in list view.
        <div
          className="w-full"
          title={file.name}
          onPointerDown={(e) => handleSidebarFilePointerDown(file)(e)}
          onPointerMove={handleSidebarFilePointerMove}
          onPointerUp={(e) => tapFile(file)(e)}
        >
          <SidebarFileIcon
            large
            name={file.name}
            path={file.path}
            isImage={["image", "video"].includes(getFileCategory(file.name) ?? "")}
            resolveThumbnailUrl={getFileCategory(file.name) === "video" ? resolveVideoThumbnailUrl : resolveImageThumbnailUrl}
            fallbackIcon={categoryIcon(getFileCategory(file.name))}
            fallbackClassName={categoryIconColorClassName(getFileCategory(file.name))}
          />
        </div>
      ) : (
        <SidebarFileIcon
          name={file.name}
          path={file.path}
          isImage={getFileCategory(file.name) === "image"}
          resolveThumbnailUrl={resolveImageThumbnailUrl}
          fallbackIcon={categoryIcon(getFileCategory(file.name))}
          fallbackClassName={categoryIconColorClassName(getFileCategory(file.name))}
        />
      )}
      {/* Name + badges: one row under the tile in grid view, plain siblings of the row in list view. */}
      <div className={isGridView ? "flex items-center gap-1 min-w-0 px-0.5 text-xs" : "contents"}>
      {/* MODIFIED: Now clicking plays the file in VideoPlayer */}
      {renaming && !renameInGallery ? (
        <InlineRenameInput
          fileName={file.name}
          onCommit={(value) => void commitRename(file, value)}
          onCancel={cancelRename}
          className="flex-1 min-w-0 border border-blue-400 rounded px-1 text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100"
        />
      ) : (
        <div
          className={`flex-1 min-w-0 truncate hover:text-blue-500 dark:hover:text-blue-400 ${
            selected ? 'text-blue-600 dark:text-blue-400 font-medium' : ''
          }`}
          title={file.name}
          onPointerDown={(e) => handleSidebarFilePointerDown(file)(e)}
          onPointerMove={handleSidebarFilePointerMove}
          onPointerUp={(e) => tapFile(file)(e)}
        >
          <FileNameText name={file.name} />
        </div>
      )}

      {pinned && (
        <IoPin
          size={12}
          className="shrink-0 text-gray-400 dark:text-neutral-500"
          title="Pinned to home"
        />
      )}

      {!!linkedDocs && (
        <MdOutlineDescription
          size={13}
          className="shrink-0 text-gray-400 dark:text-neutral-500"
          title={`${linkedDocs!.length} linked note(s)`}
        />
      )}

      </div>
      {/* Add + menu: floating over the tile's corner in grid view (on hover, or while a menu is open). */}
      <div
        className={
          isGridView
            ? `absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-md bg-white/90 dark:bg-neutral-900/85 shadow-sm transition-opacity ${
              menuOpen || addMenuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`
            : "contents"
        }
      >
      {/* Add to the video being edited: insert, append, or show on the picture. */}
      {editingVideo && ["video", "image", "audio"].includes(getFileCategory(file.name) ?? "") && !isOpen && (
        <div className="relative">
          <button
            title="Add to the video you're editing (or drag it onto the timeline or the picture)"
            className={`p-1 rounded-md transition-colors ${addMenuOpen ? 'opacity-100 bg-gray-200 dark:bg-neutral-700' : 'opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-neutral-700'}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (getFileCategory(file.name) === "audio") {
                void addMediaToVideo(file.path, "end");
                return;
              }
              setAddMenuFor(addMenuOpen ? null : file.path);
            }}
          >
            <IoAdd size={14} />
          </button>
          {addMenuOpen && (
            <div
              onPointerDown={(e) => e.stopPropagation()}
              className="absolute right-0 top-full mt-1.5 w-52 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-md border border-gray-200/80 dark:border-neutral-700/80 shadow-xl overflow-hidden z-20 py-1 text-sm text-neutral-700 dark:text-neutral-200"
            >
              {(
                [
                  ["insert", "Insert at the playhead"],
                  ["end", "Add to the end"],
                  ["overlay", getFileCategory(file.name) === "image" ? "Show on the video" : "Show on the video (picture-in-picture)"],
                ] as const
              ).map(([how, label]) => (
                <button
                  key={how}
                  className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-neutral-700/70"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAddMenuFor(null);
                    void addMediaToVideo(file.path, how);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Three vertical dots menu */}
      <div className="relative">
        <button
          className={`p-1 rounded-md transition-colors ${
            menuOpen
              ? 'opacity-100 bg-gray-200 dark:bg-neutral-700'
              : 'opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-neutral-700'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            setOpenMenu(menuOpen ? null : file.path);
            setLinkDocsMenuOpenFor(null);
          }}
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
            <path d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
          </svg>
        </button>

        {/* Popup Menu - see the "Closes a file row's 3-dot menu" effect
            above for outside-click/Escape handling. onPointerDown here
            stops that same document-level listener from treating a click
            *inside* this menu (e.g. expanding "Move to") as a click
            outside it - mirrors ImageFolderGallery.tsx's own context menu. */}
        {menuOpen && (
          <>
            <style>{`
              @keyframes sidebarFileMenuIn {
                from { opacity: 0; transform: translateY(-4px) scale(0.98); }
                to { opacity: 1; transform: translateY(0) scale(1); }
              }
            `}</style>
            <div
              onPointerDown={(e) => e.stopPropagation()}
              style={{ animation: "sidebarFileMenuIn 140ms cubic-bezier(0.16, 1, 0.3, 1)" }}
              className="absolute right-0 top-full mt-1.5 w-48 rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-md border border-gray-200/80 dark:border-neutral-700/80 shadow-xl ring-1 ring-black/5 overflow-hidden z-20 py-1"
            >
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  handleTogglePin(file);
                }}
              >
                {pinned ? (
                  <IoPin size={15} className="shrink-0 text-blue-500 dark:text-blue-400" />
                ) : (
                  <IoPinOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                )}
                <span className="flex-1 text-left">
                  {pinned ? "Unpin from home" : "Pin to home"}
                </span>
              </button>
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleLinkNotes(file);
                }}
              >
                <MdOutlineDescription size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                <span className="flex-1 text-left">Link notes</span>
                {linkedDocs && linkedDocs.length >= 2 && (
                  <IoChevronForward
                    size={12}
                    className={`shrink-0 text-neutral-400 dark:text-neutral-500 transition-transform ${linkMenuOpen ? 'rotate-90' : ''}`}
                  />
                )}
              </button>
              {linkMenuOpen && (
                <div className="mx-1.5 mb-1 max-h-40 overflow-y-auto rounded-lg bg-gray-50 dark:bg-neutral-900/60 py-0.5">
                  {(linkedDocs ?? []).map((doc) => (
                    <button
                      key={doc.id}
                      className="w-full text-left pl-6 pr-3 py-1.5 text-xs truncate hover:bg-gray-100 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenu(null);
                        setLinkDocsMenuOpenFor(null);
                        setSelectedFile(null);
                        setDocsScreen({ mode: "editor", docId: doc.id });
                      }}
                    >
                      {doc.title || "Untitled document"}
                    </button>
                  ))}
                  <button
                    className="w-full text-left pl-6 pr-3 py-1.5 text-xs truncate hover:bg-gray-100 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300"
                    onClick={(e) => {
                      e.stopPropagation();
                      setLinkDocsMenuOpenFor(null);
                      void (async () => {
                        try {
                          const id = crypto.randomUUID();
                          const title = `Notes for ${file.name}`;
                          const bytes = Array.from(Y.encodeStateAsUpdate(new Y.Doc()));
                          await invoke("create_doc", { id, title, bytes });
                          await invoke("link_doc_to_file", { id, filePath: file.path });
                          await refreshDocsIndex();
                          setOpenMenu(null);
                          setSelectedFile(null);
                          setDocsScreen({ mode: "editor", docId: id });
                        } catch (error) {
                          console.error("Failed to create linked notes:", error);
                          setError(`Failed to create linked notes: ${error}`);
                        }
                      })();
                    }}
                  >
                    + New linked doc
                  </button>
                </div>
              )}
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(file);
                }}
              >
                <IoCreateOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                <span className="flex-1 text-left">Rename</span>
              </button>
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleCopyFilePath(file);
                }}
              >
                <IoCopyOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                <span className="flex-1 text-left">Copy path</span>
              </button>
              {getFileCategory(file.name) === "image" && (
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCopyFileImage(file);
                  }}
                >
                  <IoImageOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                  <span className="flex-1 text-left">Copy image</span>
                </button>
              )}
               {isConvertibleCategory(getFileCategory(file.name)) && (
                 <button
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConversionFile(file);
                      setOpenMenu(null);
                    }}
                  >
                  <IoSwapHorizontalOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                  <span className="flex-1 text-left">Convert</span>
                </button>
               )}
               {isCompressibleCategory(getFileCategory(file.name)) && (
                 <button
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCompressionFile(file);
                      setOpenMenu(null);
                    }}
                  >
                  <IoContractOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                  <span className="flex-1 text-left">Compress</span>
                </button>
               )}

              {/* Only when a board is actually open (boardEditorRef) and
                  this is an image - see handleAddFilesToBoard. */}
              {boardEditor && getFileCategory(file.name) === "image" && (
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleAddFilesToBoard(filesToActOn(file));
                  }}
                >
                  <IoAddCircleOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                  <span className="flex-1 text-left">
                    {filesToActOn(file).length > 1 ? `Add ${filesToActOn(file).length} to board` : "Add to board"}
                  </span>
                </button>
              )}

              {/* Opens the shared Move/Copy menu (MoveCopyMenu.tsx) beside this one. */}
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setTransferMenu({ files: filesToActOn(file), anchor: { left: rect.right + 4, top: rect.top } });
                  setOpenMenu(null);
                }}
              >
                <IoFolderOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                <span className="flex-1 text-left">
                  {filesToActOn(file).length > 1 ? `Move or copy ${filesToActOn(file).length} items…` : "Move or copy to…"}
                </span>
                <IoChevronForward size={12} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
              </button>
              {/* A project file is an edit list, not media a phone can play -
                  Save renders it first. */}
              {!isVideoProjectPath(file.path) && (
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    openPhoneTransfer(filesToActOn(file).filter((f) => !isVideoProjectPath(f.path)));
                    setOpenMenu(null);
                  }}
                >
                  <IoPhonePortraitOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                  <span className="flex-1 text-left">
                    {filesToActOn(file).length > 1 ? `Transfer ${filesToActOn(file).length} to phone` : "Transfer to phone"}
                  </span>
                </button>
              )}
              {getFileCategory(file.name) === "video" && !isVideoProjectPath(file.path) && (
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleSetThumbnail(file);
                  }}
                >
                  <IoImageOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                  <span className="flex-1 text-left">Set thumbnail…</span>
                </button>
              )}

              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  setInfoFile({ path: file.path, name: file.name });
                  setOpenMenu(null);
                }}
              >
                <IoInformationCircleOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                <span className="flex-1 text-left">Info</span>
              </button>

              <div className="my-1 border-t border-gray-100 dark:border-neutral-700/70" />
              <button
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteFile(file);
                  }}
                >
                <IoTrashOutline size={15} className="shrink-0" />
                <span className="flex-1 text-left">Delete</span>
              </button>
            </div>
          </>
        )}
      </div>
      </div>
    </li>
  );
};

export default memo(SidebarFileRow);
