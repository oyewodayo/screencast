import React from "react";
import {
  IoCutOutline,
  IoDocumentTextOutline,
  IoFolderOpenOutline,
  IoGitNetworkOutline,
  IoImagesOutline,
} from "react-icons/io5";
import type { AppSettings } from "../utils/appSettings";
import type { HomeItem } from "../utils/homeLibraryItems";
import type { FileArrival } from "../utils/homeScreenFiles";
import type { FileEntry } from "../utils/libraryEntries";
import type { FileCategory } from "../utils/fileCategory";
import LiveCameraRecordingView from "./LiveCameraRecordingView";
import HomeLibrarySection from "./HomeLibrarySection";
import HomeQuickStart from "./HomeQuickStart";

const CAMERA_ONLY_RECORD_TYPES = ["va", "v"];

interface HomeWorkspaceProps {
  homeBackgroundStyle: AppSettings["homeBackgroundStyle"];
  isRecording: boolean;
  recordType: string;
  videoDevices: string[];
  isPaused: boolean;
  homeItems: HomeItem[];
  hasAnyHomeItems: boolean;
  homeLibraryView: "list" | "grid";
  onHomeLibraryViewChange: (mode: "list" | "grid") => void;
  homeLibrarySearch: string;
  onHomeLibrarySearchChange: (q: string) => void;
  libraryFilesByPath: Map<string, FileEntry>;
  boardThumbById: Map<string, string>;
  arrivals: Record<string, FileArrival>;
  durations: Map<string, number>;
  homeKinds: Record<string, { icon: React.ReactNode; label: string; color: string }>;
  categoryIcon: (category: FileCategory | null) => React.ReactNode;
  categoryIconColorClassName: (category: FileCategory | null) => string;
  resolveImageThumbnailUrl: (file: { name: string; path: string }) => Promise<string>;
  resolveVideoThumbnailUrl: (file: { name: string; path: string }) => Promise<string>;
  onOpenItem: (item: HomeItem) => void;
  onTogglePinKey: (key: string) => void;
  onOpenVideoEditor: () => void;
  onOpenDocs: () => void;
  onOpenWhiteboard: () => void;
  onOpenBoard: () => void;
  onOpenExternalFile: () => void;
  onStartRecordingSetup: () => void;
  onTryAnnotation: () => void;
  onOpenPhoneCamera: () => void;
}

const HomeWorkspace: React.FC<HomeWorkspaceProps> = ({
  homeBackgroundStyle,
  isRecording,
  recordType,
  videoDevices,
  isPaused,
  homeItems,
  hasAnyHomeItems,
  homeLibraryView,
  onHomeLibraryViewChange,
  homeLibrarySearch,
  onHomeLibrarySearchChange,
  libraryFilesByPath,
  boardThumbById,
  arrivals,
  durations,
  homeKinds,
  categoryIcon,
  categoryIconColorClassName,
  resolveImageThumbnailUrl,
  resolveVideoThumbnailUrl,
  onOpenItem,
  onTogglePinKey,
  onOpenVideoEditor,
  onOpenDocs,
  onOpenWhiteboard,
  onOpenBoard,
  onOpenExternalFile,
  onStartRecordingSetup,
  onTryAnnotation,
  onOpenPhoneCamera,
}) => {
  const isCameraOnlyRecording = isRecording && CAMERA_ONLY_RECORD_TYPES.includes(recordType);

  return (
    <div className="relative flex flex-col items-center justify-[safe_center] h-full w-full gap-6 px-8 pt-8 pb-24 overflow-y-auto overflow-x-hidden">
      {/* Subtle decorative backdrop on the empty home screen (Settings > Appearance > Home screen background). */}
      {homeBackgroundStyle === "graph" && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute -top-1/4 -left-1/4 w-[35%] h-[35%] rounded-full blur-2xl opacity-[0.07] dark:opacity-[0.05] bg-[radial-gradient(circle,theme(colors.blue.400),transparent_45%)]" />
          <svg className="absolute inset-0 w-full h-full text-gray-400/40 dark:text-neutral-500/30" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="home-empty-grid" width="36" height="36" patternUnits="userSpaceOnUse">
                <path d="M 36 0 L 0 0 0 36" fill="none" stroke="currentColor" strokeWidth="1" />
              </pattern>
              <radialGradient id="home-empty-grid-fade" cx="50%" cy="45%" r="65%">
                <stop offset="0%" stopColor="white" stopOpacity="1" />
                <stop offset="100%" stopColor="white" stopOpacity="0" />
              </radialGradient>
              <mask id="home-empty-grid-mask">
                <rect width="100%" height="100%" fill="url(#home-empty-grid-fade)" />
              </mask>
            </defs>
            <rect width="100%" height="100%" fill="url(#home-empty-grid)" mask="url(#home-empty-grid-mask)" />
          </svg>
        </div>
      )}

      {isCameraOnlyRecording ? (
        <LiveCameraRecordingView videoDevices={videoDevices} isPaused={isPaused} />
      ) : (
        <div className="relative flex flex-col items-center gap-4 text-center w-full max-w-3xl">
          <p className="text-xl text-gray-800 dark:text-neutral-100 font-semibold tracking-tight">
            What would you like to create?
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 w-full">
            {[
              { label: "Video", icon: <IoCutOutline size={20} />, onClick: onOpenVideoEditor },
              { label: "Document", icon: <IoDocumentTextOutline size={20} />, onClick: onOpenDocs },
              { label: "Whiteboard", icon: <IoGitNetworkOutline size={20} />, onClick: onOpenWhiteboard },
              { label: "Design", icon: <IoImagesOutline size={20} />, onClick: onOpenBoard },
              { label: "Open file", icon: <IoFolderOpenOutline size={20} />, onClick: onOpenExternalFile },
            ].map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                className="flex flex-col items-center justify-center gap-2 h-[84px] rounded-xl bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm border border-gray-200/80 dark:border-neutral-800 text-gray-600 dark:text-neutral-300 hover:border-blue-400/80 dark:hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 hover:shadow-sm transition-all"
              >
                {action.icon}
                <span className="text-xs font-medium">{action.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!isCameraOnlyRecording && (
        <HomeQuickStart
          libraryCount={homeItems.length}
          onStartRecordingSetup={onStartRecordingSetup}
          onTryAnnotation={onTryAnnotation}
          onOpenWhiteboard={onOpenWhiteboard}
          onOpenPhoneCamera={onOpenPhoneCamera}
        />
      )}

      <HomeLibrarySection
        items={homeItems}
        hasAnyItems={hasAnyHomeItems}
        viewMode={homeLibraryView}
        onViewModeChange={onHomeLibraryViewChange}
        searchQuery={homeLibrarySearch}
        onSearchQueryChange={onHomeLibrarySearchChange}
        libraryFilesByPath={libraryFilesByPath}
        boardThumbById={boardThumbById}
        arrivals={arrivals}
        durations={durations}
        homeKinds={homeKinds}
        categoryIcon={categoryIcon}
        categoryIconColorClassName={categoryIconColorClassName}
        resolveImageThumbnailUrl={resolveImageThumbnailUrl}
        resolveVideoThumbnailUrl={resolveVideoThumbnailUrl}
        onOpenItem={onOpenItem}
        onTogglePinKey={onTogglePinKey}
      />
    </div>
  );
};

export default HomeWorkspace;
