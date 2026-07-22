// components/docker/FileToolsDocker.tsx
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import {
  IoFolderOpenOutline,
  IoTrashOutline,
  IoSwapHorizontalOutline,
  IoTimeOutline,
  IoServerOutline,
  IoResizeOutline,
  IoCheckmark,
} from "react-icons/io5";
import { getFileCategory, isConvertibleCategory } from "../../utils/fileCategory";
import { FILE_TOOLS_COPY } from "./fileToolsConfig";
import VideoTimelineDocker from "./VideoTimelineDocker";

// `path` here is always the real filesystem path (never the asset:// URL used for playback) —
// every action below (ffprobe, rename, reveal, trash) needs the real path, same convention as
// FileEntry elsewhere in Dashboard.tsx.
export interface DockerFile {
  name: string;
  path: string;
}

interface FileInfo {
  duration?: string;
  size?: string;
  resolution?: string;
}

const formatDuration = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

interface FileToolsDockerProps {
  file: DockerFile;
  // Asset:// URL for `file`, needed only by the video category's timeline (it loads its own
  // hidden <video> to capture thumbnail frames - ffprobe/canvas can't do that on the real fs path).
  playableSrc: string | null;
  currentTime: number;
  onSeek: (time: number) => void;
  onConvert: (file: DockerFile) => void;
  onRename: (file: DockerFile, newName: string) => Promise<void>;
  onDelete: (file: DockerFile) => Promise<void>;
}

// The file-type-specific alternative to RecordingDocker (see BottomDocker's dockerMode switch):
// instead of screen-recording setup, this shows at-a-glance info and quick actions for whichever
// file is currently open, tailored to its category via FILE_TOOLS_COPY. This is deliberately one
// component rather than four near-identical ones — the info/actions block is identical across
// categories today, and a category's own editing controls (once built) can be added as an
// additional branch here without duplicating the shared parts.
const FileToolsDocker: React.FC<FileToolsDockerProps> = ({ file, playableSrc, currentTime, onSeek, onConvert, onRename, onDelete }) => {
  const category = getFileCategory(file.name);
  const copy = category ? FILE_TOOLS_COPY[category] : null;

  // Video gets its own rich timeline docker instead of the generic info/actions panel below.
  if (category === "video" && playableSrc) {
    return (
      <VideoTimelineDocker
        file={file}
        playableSrc={playableSrc}
        currentTime={currentTime}
        onSeek={onSeek}
        onConvert={onConvert}
        onRename={onRename}
        onDelete={onDelete}
      />
    );
  }

  return <FileToolsDockerGeneric file={file} category={category} copy={copy} onConvert={onConvert} onRename={onRename} onDelete={onDelete} />;
};

// The original generic panel (info + rename/convert/reveal/delete), still used for audio/image/
// pdf. Split out from FileToolsDocker itself so the video-vs-everything-else dispatch above stays
// a single, obvious early return instead of one giant component with a category branch buried
// inside its JSX.
const FileToolsDockerGeneric: React.FC<{
  file: DockerFile;
  category: ReturnType<typeof getFileCategory>;
  copy: (typeof FILE_TOOLS_COPY)[keyof typeof FILE_TOOLS_COPY] | null;
  onConvert: (file: DockerFile) => void;
  onRename: (file: DockerFile, newName: string) => Promise<void>;
  onDelete: (file: DockerFile) => Promise<void>;
}> = ({ file, category, copy, onConvert, onRename, onDelete }) => {
  const [info, setInfo] = useState<FileInfo>({});
  const [loadingInfo, setLoadingInfo] = useState(false);

  useEffect(() => {
    setInfo({});
    // ffprobe has nothing meaningful to report for a PDF - skip the round-trip entirely.
    if (category === "pdf") return;
    let cancelled = false;
    setLoadingInfo(true);
    invoke<Record<string, string>>("get_conversion_info", { inputPath: file.path })
      .then((result) => {
        if (cancelled) return;
        const next: FileInfo = {};
        if (result.duration) {
          const seconds = parseFloat(result.duration);
          if (!Number.isNaN(seconds)) next.duration = formatDuration(seconds);
        }
        if (result.input_size) next.size = result.input_size;
        if (result.resolution) next.resolution = result.resolution;
        setInfo(next);
      })
      .catch((error) => console.error("Failed to load file info:", error))
      .finally(() => {
        if (!cancelled) setLoadingInfo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, category]);

  const baseName = (name: string): string => {
    const dotIndex = name.lastIndexOf(".");
    return dotIndex > 0 ? name.slice(0, dotIndex) : name;
  };

  const [renameValue, setRenameValue] = useState(baseName(file.name));
  useEffect(() => {
    setRenameValue(baseName(file.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.name]);

  const [isRenaming, setIsRenaming] = useState(false);
  const trimmedRenameValue = renameValue.trim();
  const commitRename = async () => {
    if (!trimmedRenameValue || trimmedRenameValue === baseName(file.name)) return;
    setIsRenaming(true);
    try {
      await onRename(file, trimmedRenameValue);
    } finally {
      setIsRenaming(false);
    }
  };

  const handleShowInFolder = () => {
    invoke("open_file_from_directory", { filepath: file.path }).catch((error) =>
      console.error("Failed to reveal file:", error)
    );
  };

  const hasInfo = info.duration || info.resolution || info.size;

  return (
    <div className="w-full flex flex-wrap items-end justify-between gap-4 overflow-auto">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <div className="p-1 text-sm">Rename</div>
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
              }}
              className="p-2.5 rounded text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700"
            />
            <button
              type="button"
              onClick={commitRename}
              disabled={isRenaming || !trimmedRenameValue || trimmedRenameValue === baseName(file.name)}
              title="Save name"
              className="p-2.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none"
            >
              <IoCheckmark />
            </button>
          </div>
        </div>

        <div>
          <div className="p-1 text-sm">Info</div>
          <div className="flex items-center gap-3 p-2.5 rounded-md text-xs bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 border border-neutral-200 dark:border-neutral-700 min-h-[42px]">
            {category === "pdf" ? (
              <span className="text-neutral-400 dark:text-neutral-500 italic">No file info for PDFs</span>
            ) : loadingInfo ? (
              <span className="text-neutral-400 dark:text-neutral-500 italic">Loading…</span>
            ) : hasInfo ? (
              <>
                {info.duration && (
                  <span className="flex items-center gap-1">
                    <IoTimeOutline />
                    {info.duration}
                  </span>
                )}
                {info.resolution && (
                  <span className="flex items-center gap-1">
                    <IoResizeOutline />
                    {info.resolution}
                  </span>
                )}
                {info.size && (
                  <span className="flex items-center gap-1">
                    <IoServerOutline />
                    {info.size}
                  </span>
                )}
              </>
            ) : (
              <span className="text-neutral-400 dark:text-neutral-500 italic">No info available</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col items-end gap-2">
        <div className="flex items-end gap-2">
          {isConvertibleCategory(category) && (
            <button
              type="button"
              onClick={() => onConvert(file)}
              className="flex items-center gap-1.5 p-2.5 rounded-md text-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              <IoSwapHorizontalOutline /> Convert
            </button>
          )}
          <button
            type="button"
            onClick={handleShowInFolder}
            className="flex items-center gap-1.5 p-2.5 rounded-md text-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            <IoFolderOpenOutline /> Show in folder
          </button>
          <button
            type="button"
            onClick={() => onDelete(file)}
            className="flex items-center gap-1.5 p-2.5 rounded-md text-sm border border-red-200 dark:border-red-500/30 bg-white dark:bg-neutral-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
          >
            <IoTrashOutline /> Delete
          </button>
        </div>
        {copy && <p className="text-xs text-neutral-400 dark:text-neutral-500 max-w-xs text-right">{copy.blurb}</p>}
      </div>
    </div>
  );
};

export default FileToolsDocker;
