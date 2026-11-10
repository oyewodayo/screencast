import React, { useState, useEffect, useRef } from "react";
import {
  IoFolderOpenOutline,
  IoSaveOutline,
  IoArrowUndo,
  IoArrowRedo,
  IoCutOutline,
  IoTrashOutline,
  IoCopyOutline,
  IoCheckmarkDoneOutline,
  IoAddCircleOutline,
  IoMusicalNotesOutline,
  IoTextOutline,
  IoLayersOutline,
  IoShapesOutline,
  IoLocateOutline,
  IoVolumeHighOutline,
  IoSwapHorizontalOutline,
  IoReaderOutline,
  IoSparklesOutline,
  IoColorPaletteOutline,
  IoSettingsOutline,
  IoHelpCircleOutline,
  IoClose,
  IoPhonePortraitOutline,
  IoContractOutline,
  IoImageOutline,
  IoPencilOutline,
  IoFilmOutline,
  IoCheckmark,
} from "react-icons/io5";
import { MdFlip, MdOutlineClosedCaption } from "react-icons/md";

export interface EditorMenuBarProps {
  fileName: string;
  filePath?: string;
  duration?: number;
  isEdited?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  onNewProject?: () => void;
  onOpenFile?: () => void;
  onRename?: (newName: string) => void;
  onConvert?: () => void;
  onCompress?: () => void;
  onMoveOrCopy?: () => void;
  onTransferToPhone?: () => void;
  onSetThumbnail?: () => void;
  onShowInFolder?: () => void;
  onExport?: () => void;
  onClose?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onSplit?: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  onSelectAll?: () => void;
  onFlipHorizontal?: () => void;
  onOpenEffects?: () => void;
  onInsertMedia?: () => void;
  onAddAudio?: () => void;
  onAddText?: () => void;
  onAddScene?: () => void;
  onAddElements?: () => void;
  onAddStickers?: () => void;
  onAutoZoom?: () => void;
  onTrimSilence?: () => void;
  onViewSwitches?: () => void;
  onCaptions?: () => void;
  onTranscript?: () => void;
  onScreenStyle?: () => void;
  onColorGrade?: () => void;
  onFindShorts?: () => void;
  onScreenOptions?: () => void;
  onAudioSettings?: () => void;
  onShortcuts?: () => void;
  onPreferences?: () => void;
}

type MenuKey = "file" | "edit" | "insert" | "tools" | "settings";

function formatSeconds(sec?: number): string {
  if (!sec || isNaN(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export const EditorMenuBar: React.FC<EditorMenuBarProps> = ({
  fileName,
  filePath,
  duration,
  isEdited = false,
  canUndo = false,
  canRedo = false,
  onNewProject,
  onOpenFile,
  onRename,
  onConvert,
  onCompress,
  onMoveOrCopy,
  onTransferToPhone,
  onSetThumbnail,
  onShowInFolder,
  onExport,
  onClose,
  onUndo,
  onRedo,
  onSplit,
  onDelete,
  onDuplicate,
  onSelectAll,
  onFlipHorizontal,
  onOpenEffects,
  onInsertMedia,
  onAddAudio,
  onAddText,
  onAddScene,
  onAddElements,
  onAddStickers,
  onAutoZoom,
  onTrimSilence,
  onViewSwitches,
  onCaptions,
  onTranscript,
  onScreenStyle,
  onColorGrade,
  onFindShorts,
  onScreenOptions,
  onAudioSettings,
  onShortcuts,
  onPreferences,
}) => {
  const [activeMenu, setActiveMenu] = useState<MenuKey | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(fileName);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRenameValue(fileName);
  }, [fileName]);

  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  // Click outside to close active menu
  useEffect(() => {
    if (!activeMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActiveMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeMenu]);

  const toggleMenu = (key: MenuKey) => {
    setActiveMenu((prev) => (prev === key ? null : key));
  };

  const handleMenuHover = (key: MenuKey) => {
    if (activeMenu !== null && activeMenu !== key) {
      setActiveMenu(key);
    }
  };

  const triggerAction = (action?: () => void) => {
    setActiveMenu(null);
    action?.();
  };

  const submitRename = () => {
    setIsRenaming(false);
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== fileName) {
      onRename?.(trimmed);
    } else {
      setRenameValue(fileName);
    }
  };

  return (
    <div
      ref={menuBarRef}
      className="h-9 shrink-0 bg-[#141416] border-b border-white/10 flex items-center px-2.5 gap-1.5 text-xs select-none z-40 relative shadow-sm"
    >
      {/* Briefcast App Icon (crisp pure white) */}
      <div
        className="flex items-center gap-1.5 pr-2 border-r border-white/10 shrink-0 cursor-pointer hover:opacity-80"
        onClick={() => toggleMenu("file")}
        title="Briefcast Menu"
      >
        <img
          src="/screencast.png"
          alt="Briefcast"
          style={{ filter: "brightness(0) invert(1)" }}
          className="w-4 h-4 object-contain brightness-0 invert"
        />
        <span className="font-semibold text-xs tracking-tight text-white hidden sm:inline">Briefcast</span>
      </div>

      {/* Menu Bar Items */}
      <div className="flex items-center gap-0.5">
        {/* FILE MENU */}
        <div className="relative">
          <button
            type="button"
            className={`px-2 py-1 rounded text-xs cursor-pointer ${
              activeMenu === "file" ? "bg-white/15 text-white" : "text-white/70 hover:text-white hover:bg-white/10"
            }`}
            onClick={() => toggleMenu("file")}
            onMouseEnter={() => handleMenuHover("file")}
          >
            File
          </button>
          {activeMenu === "file" && (
            <div className="absolute left-0 top-full mt-1 w-56 rounded-md bg-[#18181b] border border-neutral-700/80 shadow-2xl py-1 text-xs text-white z-50">
              {onNewProject && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onNewProject)}
                >
                  <span className="flex items-center gap-2">
                    <IoAddCircleOutline size={14} /> New Project / Recording
                  </span>
                  <span className="text-[10px] text-white/40">Ctrl+N</span>
                </button>
              )}
              {onOpenFile && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onOpenFile)}
                >
                  <span className="flex items-center gap-2">
                    <IoFolderOpenOutline size={14} /> Open File…
                  </span>
                  <span className="text-[10px] text-white/40">Ctrl+O</span>
                </button>
              )}
              <div className="border-t border-white/10 my-1" />
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                onClick={() => {
                  setActiveMenu(null);
                  setIsRenaming(true);
                }}
              >
                <span className="flex items-center gap-2">
                  <IoPencilOutline size={14} /> Rename
                </span>
                <span className="text-[10px] text-white/40">F2</span>
              </button>
              {onInsertMedia && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onInsertMedia)}
                >
                  <span className="flex items-center gap-2">
                    <IoAddCircleOutline size={14} /> Insert videos or images…
                  </span>
                </button>
              )}
              {onConvert && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onConvert)}
                >
                  <span className="flex items-center gap-2">
                    <IoSwapHorizontalOutline size={14} /> Convert
                  </span>
                </button>
              )}
              {onCompress && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onCompress)}
                >
                  <span className="flex items-center gap-2">
                    <IoContractOutline size={14} /> Compress
                  </span>
                </button>
              )}
              {onMoveOrCopy && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onMoveOrCopy)}
                >
                  <span className="flex items-center gap-2">
                    <IoFolderOpenOutline size={14} /> Move or copy to…
                  </span>
                </button>
              )}
              {onTransferToPhone && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onTransferToPhone)}
                >
                  <span className="flex items-center gap-2">
                    <IoPhonePortraitOutline size={14} /> Transfer to phone
                  </span>
                </button>
              )}
              {onSetThumbnail && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onSetThumbnail)}
                >
                  <span className="flex items-center gap-2">
                    <IoImageOutline size={14} /> Set thumbnail…
                  </span>
                </button>
              )}
              {onShowInFolder && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onShowInFolder)}
                >
                  <span className="flex items-center gap-2">
                    <IoFolderOpenOutline size={14} /> Show in folder
                  </span>
                </button>
              )}
              <div className="border-t border-white/10 my-1" />
              {onExport && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onExport)}
                >
                  <span className="flex items-center gap-2 font-medium text-blue-400 hover:text-white">
                    <IoSaveOutline size={14} /> Save & Export
                  </span>
                  <span className="text-[10px] text-white/40">Ctrl+E</span>
                </button>
              )}
              {onClose && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-red-600 hover:text-white"
                  onClick={() => triggerAction(onClose)}
                >
                  <span className="flex items-center gap-2">
                    <IoClose size={14} /> Close Editor
                  </span>
                  <span className="text-[10px] text-white/40">Esc</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* EDIT MENU */}
        <div className="relative">
          <button
            type="button"
            className={`px-2 py-1 rounded text-xs cursor-pointer ${
              activeMenu === "edit" ? "bg-white/15 text-white" : "text-white/70 hover:text-white hover:bg-white/10"
            }`}
            onClick={() => toggleMenu("edit")}
            onMouseEnter={() => handleMenuHover("edit")}
          >
            Edit
          </button>
          {activeMenu === "edit" && (
            <div className="absolute left-0 top-full mt-1 w-52 rounded-md bg-[#18181b] border border-neutral-700/80 shadow-2xl py-1 text-xs text-white z-50">
              <button
                type="button"
                disabled={!canUndo}
                className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent"
                onClick={() => triggerAction(onUndo)}
              >
                <span className="flex items-center gap-2">
                  <IoArrowUndo size={14} /> Undo
                </span>
                <span className="text-[10px] text-white/40">Ctrl+Z</span>
              </button>
              <button
                type="button"
                disabled={!canRedo}
                className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent"
                onClick={() => triggerAction(onRedo)}
              >
                <span className="flex items-center gap-2">
                  <IoArrowRedo size={14} /> Redo
                </span>
                <span className="text-[10px] text-white/40">Ctrl+Y</span>
              </button>
              <div className="border-t border-white/10 my-1" />
              {onSplit && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onSplit)}
                >
                  <span className="flex items-center gap-2">
                    <IoCutOutline size={14} /> Split at Playhead
                  </span>
                  <span className="text-[10px] text-white/40">S</span>
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onDelete)}
                >
                  <span className="flex items-center gap-2 text-red-400 hover:text-white">
                    <IoTrashOutline size={14} /> Delete Selected
                  </span>
                  <span className="text-[10px] text-white/40">Del</span>
                </button>
              )}
              {onDuplicate && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onDuplicate)}
                >
                  <span className="flex items-center gap-2">
                    <IoCopyOutline size={14} /> Duplicate Clip
                  </span>
                  <span className="text-[10px] text-white/40">Ctrl+D</span>
                </button>
              )}
              {onSelectAll && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onSelectAll)}
                >
                  <span className="flex items-center gap-2">
                    <IoCheckmarkDoneOutline size={14} /> Select All
                  </span>
                  <span className="text-[10px] text-white/40">Ctrl+A</span>
                </button>
              )}
              <div className="border-t border-white/10 my-1" />
              {onFlipHorizontal && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onFlipHorizontal)}
                >
                  <span className="flex items-center gap-2">
                    <MdFlip size={14} /> Flip Horizontal
                  </span>
                </button>
              )}
              {onOpenEffects && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onOpenEffects)}
                >
                  <span className="flex items-center gap-2">
                    <IoSparklesOutline size={14} /> Clip Effects & Looks…
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* INSERT MENU */}
        <div className="relative">
          <button
            type="button"
            className={`px-2 py-1 rounded text-xs cursor-pointer ${
              activeMenu === "insert" ? "bg-white/15 text-white" : "text-white/70 hover:text-white hover:bg-white/10"
            }`}
            onClick={() => toggleMenu("insert")}
            onMouseEnter={() => handleMenuHover("insert")}
          >
            Insert
          </button>
          {activeMenu === "insert" && (
            <div className="absolute left-0 top-full mt-1 w-56 rounded-md bg-[#18181b] border border-neutral-700/80 shadow-2xl py-1 text-xs text-white z-50">
              {onInsertMedia && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onInsertMedia)}
                >
                  <span className="flex items-center gap-2">
                    <IoAddCircleOutline size={14} /> Insert Videos or Images…
                  </span>
                </button>
              )}
              {onAddAudio && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onAddAudio)}
                >
                  <span className="flex items-center gap-2">
                    <IoMusicalNotesOutline size={14} /> Add Audio / Voiceover…
                  </span>
                </button>
              )}
              {onAddText && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onAddText)}
                >
                  <span className="flex items-center gap-2">
                    <IoTextOutline size={14} /> Add Text Overlay
                  </span>
                  <span className="text-[10px] text-white/40">T</span>
                </button>
              )}
              {onAddScene && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onAddScene)}
                >
                  <span className="flex items-center gap-2">
                    <IoLayersOutline size={14} /> Add Scene from Scratch
                  </span>
                </button>
              )}
              <div className="border-t border-white/10 my-1" />
              {onAddElements && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onAddElements)}
                >
                  <span className="flex items-center gap-2">
                    <IoShapesOutline size={14} /> Shapes & Badges…
                  </span>
                </button>
              )}
              {onAddStickers && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onAddStickers)}
                >
                  <span className="flex items-center gap-2">
                    <IoSparklesOutline size={14} /> Stickers…
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* TOOLS MENU */}
        <div className="relative">
          <button
            type="button"
            className={`px-2 py-1 rounded text-xs cursor-pointer ${
              activeMenu === "tools" ? "bg-white/15 text-white" : "text-white/70 hover:text-white hover:bg-white/10"
            }`}
            onClick={() => toggleMenu("tools")}
            onMouseEnter={() => handleMenuHover("tools")}
          >
            Tools
          </button>
          {activeMenu === "tools" && (
            <div className="absolute left-0 top-full mt-1 w-56 rounded-md bg-[#18181b] border border-neutral-700/80 shadow-2xl py-1 text-xs text-white z-50">
              {onAutoZoom && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onAutoZoom)}
                >
                  <span className="flex items-center gap-2">
                    <IoLocateOutline size={14} /> Auto Zoom on Click
                  </span>
                </button>
              )}
              {onTrimSilence && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onTrimSilence)}
                >
                  <span className="flex items-center gap-2">
                    <IoVolumeHighOutline size={14} /> Trim Silence…
                  </span>
                </button>
              )}
              {onViewSwitches && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onViewSwitches)}
                >
                  <span className="flex items-center gap-2">
                    <IoSwapHorizontalOutline size={14} /> Screen ↔ Camera Switches…
                  </span>
                </button>
              )}
              <div className="border-t border-white/10 my-1" />
              {onCaptions && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onCaptions)}
                >
                  <span className="flex items-center gap-2">
                    <MdOutlineClosedCaption size={15} /> Captions & Subtitles…
                  </span>
                  <span className="text-[10px] text-white/40">C</span>
                </button>
              )}
              {onTranscript && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onTranscript)}
                >
                  <span className="flex items-center gap-2">
                    <IoReaderOutline size={14} /> Edit by Transcript…
                  </span>
                </button>
              )}
              {onScreenStyle && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onScreenStyle)}
                >
                  <span className="flex items-center gap-2">
                    <IoColorPaletteOutline size={14} /> Screen Style & Frame…
                  </span>
                </button>
              )}
              {onColorGrade && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onColorGrade)}
                >
                  <span className="flex items-center gap-2">
                    <IoSparklesOutline size={14} /> Color Grading & Looks…
                  </span>
                </button>
              )}
              {onFindShorts && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onFindShorts)}
                >
                  <span className="flex items-center gap-2">
                    <IoFilmOutline size={14} /> Find Shorts & Highlights…
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* SETTINGS MENU */}
        <div className="relative">
          <button
            type="button"
            className={`px-2 py-1 rounded text-xs cursor-pointer ${
              activeMenu === "settings" ? "bg-white/15 text-white" : "text-white/70 hover:text-white hover:bg-white/10"
            }`}
            onClick={() => toggleMenu("settings")}
            onMouseEnter={() => handleMenuHover("settings")}
          >
            Settings
          </button>
          {activeMenu === "settings" && (
            <div className="absolute left-0 top-full mt-1 w-52 rounded-md bg-[#18181b] border border-neutral-700/80 shadow-2xl py-1 text-xs text-white z-50">
              {onScreenOptions && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onScreenOptions)}
                >
                  <span className="flex items-center gap-2">
                    <IoSettingsOutline size={14} /> Screen Recording Options…
                  </span>
                </button>
              )}
              {onAudioSettings && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onAudioSettings)}
                >
                  <span className="flex items-center gap-2">
                    <IoVolumeHighOutline size={14} /> Audio & Mic Settings…
                  </span>
                </button>
              )}
              {onShortcuts && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onShortcuts)}
                >
                  <span className="flex items-center gap-2">
                    <IoHelpCircleOutline size={14} /> Keyboard Shortcuts
                  </span>
                  <span className="text-[10px] text-white/40">?</span>
                </button>
              )}
              <div className="border-t border-white/10 my-1" />
              {onPreferences && (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-blue-600 hover:text-white"
                  onClick={() => triggerAction(onPreferences)}
                >
                  <span className="flex items-center gap-2">
                    <IoSettingsOutline size={14} /> Preferences…
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="h-4 w-px bg-white/15 mx-1" />

      {/* File Name & Duration in front of the menu */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <IoFilmOutline size={14} className="text-blue-400 shrink-0" />
        {isRenaming ? (
          <div className="flex items-center gap-1">
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") {
                  setIsRenaming(false);
                  setRenameValue(fileName);
                }
              }}
              onBlur={submitRename}
              className="h-6 px-1.5 py-0.5 rounded text-xs bg-black/60 border border-blue-500 text-white outline-none w-56 font-medium"
            />
            <button
              type="button"
              onClick={submitRename}
              className="p-1 rounded hover:bg-white/10 text-emerald-400"
              title="Save name"
            >
              <IoCheckmark size={14} />
            </button>
          </div>
        ) : (
          <div
            className="flex items-center gap-1.5 truncate group cursor-pointer"
            onClick={() => setIsRenaming(true)}
            title={`${filePath ?? fileName} (Click to rename)`}
          >
            <span className="font-medium text-white/90 truncate max-w-[280px] hover:text-white">
              {fileName}
            </span>
            <IoPencilOutline size={11} className="text-white/30 group-hover:text-white/70 shrink-0" />
          </div>
        )}

        {duration !== undefined && duration > 0 && (
          <span className="text-[11px] text-white/40 shrink-0">
            {formatSeconds(duration)}
          </span>
        )}

        {/* Saved / Edited Status Pill */}
        {isEdited ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-400/90 font-medium px-1.5 py-0.5 rounded-full bg-amber-500/10 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Edited
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400/80 font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/10 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Saved
          </span>
        )}
      </div>

      {/* Right Side Quick Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          disabled={!canUndo}
          onClick={onUndo}
          title="Undo (Ctrl+Z)"
          className="p-1.5 rounded text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <IoArrowUndo size={14} />
        </button>
        <button
          type="button"
          disabled={!canRedo}
          onClick={onRedo}
          title="Redo (Ctrl+Y)"
          className="p-1.5 rounded text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <IoArrowRedo size={14} />
        </button>

        {onExport && (
          <button
            type="button"
            onClick={onExport}
            title="Save and export video (Ctrl+E)"
            className="ml-1 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-medium text-xs flex items-center gap-1.5 shadow-sm"
          >
            <IoSaveOutline size={13} />
            <span>Save & Export</span>
          </button>
        )}

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close editor (Esc)"
            className="ml-1 p-1.5 rounded text-white/60 hover:text-white hover:bg-white/10"
          >
            <IoClose size={16} />
          </button>
        )}
      </div>
    </div>
  );
};

export default EditorMenuBar;
