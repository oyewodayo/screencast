// components/docker/VideoTimelineDocker.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { BsCursor } from "react-icons/bs";
import { MdFlip } from "react-icons/md";
import {
  IoArrowUndo,
  IoArrowRedo,
  IoCutOutline,
  IoTrashOutline,
  IoCropOutline,
  IoSparklesOutline,
  IoText,
  IoMusicalNotesOutline,
  IoScanOutline,
  IoRemove,
  IoAdd,
  IoEyeOutline,
  IoEyeOffOutline,
  IoLockClosedOutline,
  IoLockOpenOutline,
  IoVolumeHighOutline,
  IoVolumeMuteOutline,
  IoEllipsisHorizontal,
  IoFolderOpenOutline,
  IoSwapHorizontalOutline,
  IoChevronDown,
} from "react-icons/io5";
import { DockerFile } from "./FileToolsDocker";

const MIN_PX_PER_SEC = 8;
const MAX_PX_PER_SEC = 200;
const DEFAULT_PX_PER_SEC = 40;
const THUMB_TARGET_WIDTH = 100; // px - roughly how wide each filmstrip frame should be
const NICE_TICK_INTERVALS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600]; // seconds
const MIN_TICK_SPACING_PX = 70;

const formatTimestamp = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

// Inert-for-now toolbar button — visually present (matching the reference layout) but not wired
// to anything yet. Dimmed and labeled so it reads as "not implemented", not broken.
const ToolButton: React.FC<{ title: string; children: React.ReactNode; active?: boolean }> = ({
  title,
  children,
  active,
}) => (
  <button
    type="button"
    title={`${title} (coming soon)`}
    disabled
    className={`flex items-center justify-center w-7 h-7 rounded text-neutral-500 disabled:cursor-default ${
      active ? "bg-neutral-700 text-neutral-200" : ""
    }`}
  >
    {children}
  </button>
);

interface VideoTimelineDockerProps {
  file: DockerFile;
  playableSrc: string;
  currentTime: number;
  onSeek: (time: number) => void;
  onConvert: (file: DockerFile) => void;
  onRename: (file: DockerFile, newName: string) => Promise<void>;
  onDelete: (file: DockerFile) => Promise<void>;
}

// The video-specific "file tools" docker: a scrubbable timeline (ruler + playhead + thumbnail
// filmstrip) instead of the generic info/actions panel FileToolsDocker uses for other categories.
// The playhead is real (synced both ways with the actual player via currentTime/onSeek) and the
// thumbnail filmstrip is captured from real frames; most of the toolbar above it is a visual
// scaffold for now — see ToolButton's "(coming soon)" tooltip. Track-level actions (rename/
// convert/reveal/delete) live in the "..." menu on the left rail, reusing the same handlers
// FileToolsDocker's generic panel uses for every other category.
const VideoTimelineDocker: React.FC<VideoTimelineDockerProps> = ({
  file,
  playableSrc,
  currentTime,
  onSeek,
  onConvert,
  onRename,
  onDelete,
}) => {
  const hiddenVideoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);

  const [duration, setDuration] = useState<number>(0);
  const [pxPerSec, setPxPerSec] = useState<number>(DEFAULT_PX_PER_SEC);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [coverThumbnail, setCoverThumbnail] = useState<string | null>(null);

  // Cosmetic-only track state (visibility/lock/mute) - no backend behind these yet, but they're
  // real toggles rather than dead buttons, unlike the top toolbar's placeholders.
  const [trackVisible, setTrackVisible] = useState(true);
  const [trackLocked, setTrackLocked] = useState(false);
  const [trackMuted, setTrackMuted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const baseName = (name: string): string => {
    const dotIndex = name.lastIndexOf(".");
    return dotIndex > 0 ? name.slice(0, dotIndex) : name;
  };
  const [renamingInline, setRenamingInline] = useState(false);
  const [renameValue, setRenameValue] = useState(baseName(file.name));
  useEffect(() => {
    setRenameValue(baseName(file.name));
    setRenamingInline(false);
  }, [file.name]);

  // Load metadata once per file, then capture an evenly-spaced filmstrip by seeking a hidden
  // <video> and drawing each frame to a canvas - the visible player above has its own playback
  // going, so reusing it here would fight the user's own scrubbing/playback.
  useEffect(() => {
    setDuration(0);
    setThumbnails([]);
    setCoverThumbnail(null);

    const video = hiddenVideoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas) return;
    let cancelled = false;

    const captureFrameAt = (time: number): Promise<string | null> =>
      new Promise((resolve) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          const ctx = canvas.getContext("2d");
          if (!ctx || video.videoWidth === 0) {
            resolve(null);
            return;
          }
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.6));
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = time;
      });

    const handleLoadedMetadata = async () => {
      if (cancelled) return;
      const total = video.duration;
      if (!Number.isFinite(total) || total <= 0) return;
      setDuration(total);

      const containerWidth = trackAreaRef.current?.clientWidth ?? 600;
      const count = Math.max(4, Math.min(40, Math.round(containerWidth / THUMB_TARGET_WIDTH)));

      const cover = await captureFrameAt(0);
      if (cancelled) return;
      setCoverThumbnail(cover);

      const frames: string[] = [];
      for (let i = 0; i < count; i++) {
        if (cancelled) break;
        const time = (i / count) * total;
        const frame = await captureFrameAt(time);
        if (cancelled) break;
        frames.push(frame ?? "");
        setThumbnails([...frames]);
      }
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
  }, [playableSrc]);

  const totalWidth = Math.max(1, duration * pxPerSec);

  const tickInterval = useMemo(() => {
    return (
      NICE_TICK_INTERVALS.find((interval) => interval * pxPerSec >= MIN_TICK_SPACING_PX) ??
      NICE_TICK_INTERVALS[NICE_TICK_INTERVALS.length - 1]
    );
  }, [pxPerSec]);

  const ticks = useMemo(() => {
    if (duration <= 0) return [];
    const result: number[] = [];
    for (let t = 0; t <= duration; t += tickInterval) result.push(t);
    return result;
  }, [duration, tickInterval]);

  const timeFromClientX = (clientX: number): number => {
    const el = trackAreaRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const offsetX = clientX - rect.left + el.scrollLeft;
    return Math.max(0, Math.min(offsetX / pxPerSec, duration));
  };

  const handleScrubPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    onSeek(timeFromClientX(e.clientX));
  };
  const handleScrubPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    onSeek(timeFromClientX(e.clientX));
  };

  const handleFitToWindow = () => {
    const containerWidth = trackAreaRef.current?.clientWidth ?? 0;
    if (duration <= 0 || containerWidth <= 0) return;
    setPxPerSec(Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, containerWidth / duration)));
  };

  const commitRename = async () => {
    const trimmed = renameValue.trim();
    setMenuOpen(false);
    if (trimmed && trimmed !== baseName(file.name)) await onRename(file, trimmed);
    setRenamingInline(false);
  };

  const handleShowInFolder = () => {
    setMenuOpen(false);
    invoke("open_file_from_directory", { filepath: file.path }).catch((error) =>
      console.error("Failed to reveal file:", error)
    );
  };

  const playheadLeft = Math.min(currentTime, duration) * pxPerSec;

  return (
    <div className="w-full flex flex-col gap-2">
      {/* Hidden capture rig - never shown, just decodes frames for the filmstrip/cover. */}
      <video ref={hiddenVideoRef} src={playableSrc} muted preload="metadata" style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
      <canvas ref={captureCanvasRef} style={{ display: "none" }} />

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-1 py-1 rounded-md bg-neutral-900 text-neutral-200">
        <div className="flex items-center gap-0.5">
          <button type="button" title="Select tool" className="flex items-center gap-0.5 justify-center h-7 px-1.5 rounded bg-neutral-700 text-white">
            <BsCursor size={13} />
            <IoChevronDown size={10} />
          </button>
          <div className="w-px h-5 bg-neutral-700 mx-1" />
          <ToolButton title="Undo"><IoArrowUndo size={15} /></ToolButton>
          <ToolButton title="Redo"><IoArrowRedo size={15} /></ToolButton>
          <div className="w-px h-5 bg-neutral-700 mx-1" />
          <ToolButton title="Split at playhead"><IoCutOutline size={15} /></ToolButton>
          <ToolButton title="Delete selection"><IoTrashOutline size={15} /></ToolButton>
          <div className="w-px h-5 bg-neutral-700 mx-1" />
          <ToolButton title="Crop"><IoCropOutline size={15} /></ToolButton>
          <ToolButton title="Mirror"><MdFlip size={15} /></ToolButton>
          <ToolButton title="Effects"><IoSparklesOutline size={15} /></ToolButton>
          <ToolButton title="Text"><IoText size={15} /></ToolButton>
          <ToolButton title="Audio"><IoMusicalNotesOutline size={15} /></ToolButton>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            title="Fit to window"
            onClick={handleFitToWindow}
            className="flex items-center justify-center w-7 h-7 rounded text-neutral-300 hover:bg-neutral-700"
          >
            <IoScanOutline size={15} />
          </button>
          <div className="flex items-center gap-1 rounded-full bg-neutral-800 pl-1 pr-2 py-0.5">
            <button
              type="button"
              title="Zoom out"
              onClick={() => setPxPerSec((z) => Math.max(MIN_PX_PER_SEC, Math.round(z * 0.8)))}
              className="flex items-center justify-center w-6 h-6 rounded-full text-neutral-300 hover:bg-neutral-700"
            >
              <IoRemove size={13} />
            </button>
            <input
              type="range"
              min={MIN_PX_PER_SEC}
              max={MAX_PX_PER_SEC}
              value={pxPerSec}
              onChange={(e) => setPxPerSec(Number(e.target.value))}
              className="w-20 accent-blue-500"
            />
            <button
              type="button"
              title="Zoom in"
              onClick={() => setPxPerSec((z) => Math.min(MAX_PX_PER_SEC, Math.round(z * 1.25)))}
              className="flex items-center justify-center w-6 h-6 rounded-full text-neutral-300 hover:bg-neutral-700"
            >
              <IoAdd size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="w-full flex border border-neutral-800 rounded-md overflow-hidden bg-neutral-950 text-neutral-200">
        {/* Track control rail */}
        <div className="w-14 shrink-0 flex flex-col items-center gap-1.5 py-2 bg-neutral-900 border-r border-neutral-800">
          <button
            type="button"
            title={trackVisible ? "Hide preview" : "Show preview"}
            onClick={() => setTrackVisible((v) => !v)}
            className="text-neutral-400 hover:text-neutral-200"
          >
            {trackVisible ? <IoEyeOutline size={15} /> : <IoEyeOffOutline size={15} />}
          </button>
          <button
            type="button"
            title={trackLocked ? "Unlock track" : "Lock track"}
            onClick={() => setTrackLocked((v) => !v)}
            className="text-neutral-400 hover:text-neutral-200"
          >
            {trackLocked ? <IoLockClosedOutline size={15} /> : <IoLockOpenOutline size={15} />}
          </button>
          <button
            type="button"
            title={trackMuted ? "Unmute track" : "Mute track"}
            onClick={() => setTrackMuted((v) => !v)}
            className="text-neutral-400 hover:text-neutral-200"
          >
            {trackMuted ? <IoVolumeMuteOutline size={15} /> : <IoVolumeHighOutline size={15} />}
          </button>
          <div className="relative">
            <button
              type="button"
              title="More"
              onClick={() => setMenuOpen((v) => !v)}
              className="text-neutral-400 hover:text-neutral-200"
            >
              <IoEllipsisHorizontal size={15} />
            </button>
            {menuOpen && (
              <div className="absolute left-6 bottom-0 w-40 bg-neutral-800 border border-neutral-700 rounded-md shadow-lg z-20 text-sm">
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 hover:bg-neutral-700"
                  onClick={() => {
                    setMenuOpen(false);
                    setRenamingInline(true);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="w-full flex items-center gap-1.5 text-left px-3 py-2 hover:bg-neutral-700"
                  onClick={() => {
                    setMenuOpen(false);
                    onConvert(file);
                  }}
                >
                  <IoSwapHorizontalOutline size={13} /> Convert
                </button>
                <button
                  type="button"
                  className="w-full flex items-center gap-1.5 text-left px-3 py-2 hover:bg-neutral-700"
                  onClick={handleShowInFolder}
                >
                  <IoFolderOpenOutline size={13} /> Show in folder
                </button>
                <button
                  type="button"
                  className="w-full flex items-center gap-1.5 text-left px-3 py-2 hover:bg-neutral-700 text-red-400"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete(file);
                  }}
                >
                  <IoTrashOutline size={13} /> Delete
                </button>
              </div>
            )}
          </div>

          <div className="mt-1 w-10 h-7 rounded border border-neutral-700 bg-neutral-800 flex items-center justify-center overflow-hidden">
            {coverThumbnail ? (
              <img src={coverThumbnail} alt="Cover" className="w-full h-full object-cover" />
            ) : (
              <span className="text-[8px] text-neutral-500">Cover</span>
            )}
          </div>
        </div>

        {/* Scrollable ruler + track */}
        <div ref={trackAreaRef} className="flex-1 overflow-x-auto overflow-y-hidden relative select-none">
          <div style={{ width: totalWidth }} className="relative">
            {/* Ruler */}
            <div
              className="h-6 relative border-b border-neutral-800 cursor-pointer"
              onPointerDown={handleScrubPointerDown}
              onPointerMove={handleScrubPointerMove}
            >
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 h-full flex flex-col items-start" style={{ left: t * pxPerSec }}>
                  <div className="w-px h-2 bg-neutral-700" />
                  <span className="text-[10px] text-neutral-500 pl-1">{formatTimestamp(t)}</span>
                </div>
              ))}
            </div>

            {/* Track */}
            <div
              className="h-16 relative py-1 cursor-pointer"
              onPointerDown={handleScrubPointerDown}
              onPointerMove={handleScrubPointerMove}
            >
              <div className="absolute inset-y-1 left-0 rounded overflow-hidden border-2 border-teal-500 bg-black flex" style={{ width: totalWidth }}>
                {thumbnails.map((src, i) =>
                  src ? (
                    <img key={i} src={src} className="h-full flex-1 object-cover" draggable={false} alt="" />
                  ) : (
                    <div key={i} className="h-full flex-1 bg-neutral-800" />
                  )
                )}
                <div className="absolute top-0 left-0 right-0 px-1.5 py-0.5 bg-black/60 flex items-center justify-between gap-2 pointer-events-none">
                  {renamingInline ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingInline(false);
                      }}
                      className="pointer-events-auto flex-1 min-w-0 bg-neutral-900 text-white text-[11px] rounded px-1 border border-blue-400"
                    />
                  ) : (
                    <span className="text-[11px] text-white truncate">{file.name}</span>
                  )}
                  <span className="text-[11px] text-neutral-300 tabular-nums shrink-0">{formatTimestamp(duration)}</span>
                </div>
              </div>
            </div>

            {/* Playhead */}
            <div className="absolute top-0 bottom-0 w-px bg-white pointer-events-none" style={{ left: playheadLeft }}>
              <div className="w-2.5 h-2.5 bg-white rounded-sm -ml-[5px] -mt-0.5" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VideoTimelineDocker;
