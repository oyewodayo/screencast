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
  IoSaveOutline,
  IoPlay,
  IoPause,
} from "react-icons/io5";
import { DockerFile } from "./FileToolsDocker";
import useVideoEditStore from "../../hooks/useVideoEditStore";
import { Clip } from "../../utils/videoEditTypes";
import { clipIndexAt } from "../../handlers/videoEditHandlers";

const MIN_PX_PER_SEC = 8;
const MAX_PX_PER_SEC = 200;
const DEFAULT_PX_PER_SEC = 40;
const THUMB_TARGET_WIDTH = 100; // px - roughly how wide each filmstrip frame should be
const NICE_TICK_INTERVALS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600]; // seconds
const MIN_TICK_SPACING_PX = 70;
const MIN_CLIP_LENGTH = 0.05;

const formatTimestamp = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

interface ThumbFrame {
  time: number; // source time this frame was captured at
  src: string;
}

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

// Real (wired) toolbar button — Undo/Redo/Split/Delete, unlike ToolButton's stubs above.
const ActionButton: React.FC<{
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, disabled, children }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    disabled={disabled}
    className="flex items-center justify-center w-7 h-7 rounded text-neutral-300 hover:bg-neutral-700 disabled:text-neutral-600 disabled:hover:bg-transparent disabled:cursor-default"
  >
    {children}
  </button>
);

interface VideoTimelineDockerProps {
  file: DockerFile;
  playableSrc: string;
  currentTime: number;
  onSeek: (time: number) => void;
  // Real play/pause state of the main player, and a way to toggle it - the transport button in
  // the track control rail below, same round-trip idea as currentTime/onSeek.
  isPlaying: boolean;
  onTogglePlay: () => void;
  onConvert: (file: DockerFile) => void;
  onRename: (file: DockerFile, newName: string) => Promise<void>;
  onDelete: (file: DockerFile) => Promise<void>;
  // Fired once a Save export finishes - the new (edited) render, added to the library as a
  // separate file. `file` itself is never touched by editing or exporting.
  onExported: (newPath: string, newFileName: string) => void;
}

// The video-specific "file tools" docker: a scrubbable timeline (ruler + playhead + reorderable
// clip blocks) instead of the generic info/actions panel FileToolsDocker uses for other
// categories. The playhead is real (synced both ways with the actual player via currentTime/
// onSeek); the thumbnail filmstrip is captured from real frames and sliced per clip. Most of the
// toolbar above it is a visual scaffold for now — see ToolButton's "(coming soon)" tooltip.
// Track-level actions (rename/convert/reveal/delete) live in the "..." menu on the left rail,
// reusing the same handlers FileToolsDocker's generic panel uses for every other category.
const VideoTimelineDocker: React.FC<VideoTimelineDockerProps> = ({
  file,
  playableSrc,
  currentTime,
  onSeek,
  isPlaying,
  onTogglePlay,
  onConvert,
  onRename,
  onDelete,
  onExported,
}) => {
  const hiddenVideoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);

  const editStore = useVideoEditStore(file.path);

  const [duration, setDuration] = useState<number>(0);
  const [pxPerSec, setPxPerSec] = useState<number>(DEFAULT_PX_PER_SEC);
  const [thumbnails, setThumbnails] = useState<ThumbFrame[]>([]);
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

  // Load metadata once per file, then capture an evenly-spaced filmstrip (tagged with the source
  // time each frame was captured at, so individual clip blocks can later slice out just their own
  // frames) by seeking a hidden <video> and drawing each frame to a canvas - the visible player
  // above has its own playback going, so reusing it here would fight the user's own scrubbing/
  // playback.
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
      editStore.setDuration(total);

      const containerWidth = trackAreaRef.current?.clientWidth ?? 600;
      const count = Math.max(4, Math.min(40, Math.round(containerWidth / THUMB_TARGET_WIDTH)));

      const cover = await captureFrameAt(0);
      if (cancelled) return;
      setCoverThumbnail(cover);

      const frames: ThumbFrame[] = [];
      for (let i = 0; i < count; i++) {
        if (cancelled) break;
        const time = (i / count) * total;
        const frame = await captureFrameAt(time);
        if (cancelled) break;
        frames.push({ time, src: frame ?? "" });
        setThumbnails([...frames]);
      }
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
  }, [playableSrc]);

  const tickInterval = useMemo(() => {
    return (
      NICE_TICK_INTERVALS.find((interval) => interval * pxPerSec >= MIN_TICK_SPACING_PX) ??
      NICE_TICK_INTERVALS[NICE_TICK_INTERVALS.length - 1]
    );
  }, [pxPerSec]);

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  // Live drag state for resizing a single clip's start/end edge - delta-based (pixels moved since
  // the drag began, converted to a time delta) rather than re-deriving from click position, so it
  // works the same regardless of where that clip currently sits in the (reorderable) track.
  // Clamped live against that same clip's *other* edge (captured at drag start, since it doesn't
  // move during this drag) so the block can't visibly invert before the drag even ends.
  const [resizeDrag, setResizeDrag] = useState<null | {
    id: string;
    edge: "start" | "end";
    startClientX: number;
    startValue: number;
    oppositeBound: number;
    liveValue: number;
  }>(null);

  // Reordering runs on plain pointer events, not the HTML5 drag-and-drop API - Tauri's window
  // intercepts native browser drag events at the WebView level for its own OS file-drop handling
  // (see Dashboard.tsx's onFileDropEvent, used for dragging files in from Explorer), which meant
  // dragstart/dragover/drop for in-page reordering never actually reached the DOM. Pointer events
  // aren't affected by that, and this app's resize handles already prove the pattern works.
  //
  // A pointer-down on a clip starts tracking; it only becomes a reorder (rather than a plain
  // click-to-select) once the pointer has moved past CLICK_DRAG_THRESHOLD_PX, so a quick tap still
  // selects instead of always triggering a reorder to the same slot.
  const CLICK_DRAG_THRESHOLD_PX = 4;
  const [clipDrag, setClipDrag] = useState<null | {
    index: number;
    clip: Clip;
    startClientX: number;
    isDragging: boolean;
    overIndex: number;
  }>(null);

  // Falls back to one clip spanning the whole source while the edit store is still loading (or
  // this is a fresh, never-edited video) - the track/preview always has *something* to render
  // against rather than going blank until the sidecar round-trip resolves. Never draggable/
  // resizable itself (see the `__pending__` checks below) since it isn't real state yet.
  const baseClips: Clip[] = editStore.clips.length > 0 ? editStore.clips : duration > 0 ? [{ id: "__pending__", start: 0, end: duration }] : [];

  // Applies the in-progress resize (if any) so every position derived below - block widths, tick
  // marks, the playhead, other handles - stays visually consistent with the live drag instead of
  // only jumping once it's released.
  const renderClips: Clip[] = resizeDrag
    ? baseClips.map((c) =>
        c.id === resizeDrag.id ? (resizeDrag.edge === "start" ? { ...c, start: resizeDrag.liveValue } : { ...c, end: resizeDrag.liveValue }) : c
      )
    : baseClips;

  const clipDurations = renderClips.map((c) => Math.max(0, c.end - c.start));
  const outputStarts: number[] = [];
  {
    let acc = 0;
    for (const d of clipDurations) {
      outputStarts.push(acc);
      acc += d;
    }
  }
  const totalOutputDuration = clipDurations.reduce((a, b) => a + b, 0);
  const totalWidth = Math.max(1, totalOutputDuration * pxPerSec);

  const ticks = useMemo(() => {
    if (totalOutputDuration <= 0) return [];
    const result: number[] = [];
    for (let t = 0; t <= totalOutputDuration; t += tickInterval) result.push(t);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalOutputDuration, tickInterval]);

  // Which clip (by array index) is currently considered "active" for live-preview purposes - the
  // single source of truth the tracking effect below advances, and that every deliberate
  // seek (scrub, clip select) sets directly rather than letting it be *inferred* from currentTime.
  // Inferring it from "whichever clip's source range contains currentTime" is what caused
  // reordered playback to silently ignore the new order: the native <video> defaults to source
  // time 0 on load, and after a reorder that raw position can legitimately belong to some *other*
  // clip than whichever one is actually first in the new playback order.
  const activeClipIndexRef = useRef<number>(-1);
  const lastAppliedTimeRef = useRef<number>(-1);

  // Output-timeline (assembled/preview order) pixel position -> which clip it falls into and the
  // corresponding source-video time, by walking the clip list in playback order.
  const clipAtOutputTime = (outputTime: number): { index: number; sourceTime: number } => {
    for (let i = 0; i < renderClips.length; i++) {
      const start = outputStarts[i];
      const dur = clipDurations[i];
      if (outputTime <= start + dur || i === renderClips.length - 1) {
        return { index: i, sourceTime: renderClips[i].start + Math.max(0, Math.min(outputTime - start, dur)) };
      }
    }
    return { index: 0, sourceTime: 0 };
  };

  const outputTimeFromClientX = (clientX: number): number => {
    const el = trackAreaRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const offsetX = clientX - rect.left + el.scrollLeft;
    return Math.max(0, Math.min(offsetX / pxPerSec, totalOutputDuration));
  };

  // A deliberate scrub/seek always knows exactly which clip it landed in, so it sets
  // activeClipIndexRef directly instead of leaving it for the tracking effect to guess.
  const seekToOutputTime = (outputTime: number) => {
    const { index, sourceTime } = clipAtOutputTime(outputTime);
    activeClipIndexRef.current = index;
    lastAppliedTimeRef.current = sourceTime;
    onSeek(sourceTime);
  };

  const handleScrubPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedClipId(null);
    seekToOutputTime(outputTimeFromClientX(e.clientX));
  };
  const handleScrubPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    seekToOutputTime(outputTimeFromClientX(e.clientX));
  };

  const handleFitToWindow = () => {
    const containerWidth = trackAreaRef.current?.clientWidth ?? 0;
    if (totalOutputDuration <= 0 || containerWidth <= 0) return;
    setPxPerSec(Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, containerWidth / totalOutputDuration)));
  };

  const beginResizeDrag = (clip: Clip, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedClipId(clip.id);
    const startValue = edge === "start" ? clip.start : clip.end;
    const oppositeBound = edge === "start" ? clip.end : clip.start;
    setResizeDrag({ id: clip.id, edge, startClientX: e.clientX, startValue, oppositeBound, liveValue: startValue });
  };
  const handleResizeDragMove = (e: React.PointerEvent) => {
    if (!resizeDrag) return;
    e.stopPropagation();
    const deltaSec = (e.clientX - resizeDrag.startClientX) / pxPerSec;
    const raw = resizeDrag.startValue + deltaSec;
    const clamped =
      resizeDrag.edge === "start"
        ? Math.max(0, Math.min(raw, resizeDrag.oppositeBound - MIN_CLIP_LENGTH))
        : Math.min(duration, Math.max(raw, resizeDrag.oppositeBound + MIN_CLIP_LENGTH));
    setResizeDrag((prev) => (prev ? { ...prev, liveValue: clamped } : prev));
  };
  const endResizeDrag = () => {
    if (!resizeDrag) return;
    const { id, edge, liveValue } = resizeDrag;
    setResizeDrag(null);
    editStore.resizeClipEdge(id, edge, liveValue);
  };

  // Which slot the pointer is currently over, for reorder purposes - the first clip whose
  // midpoint sits to the right of the pointer (dropping past every midpoint lands after the last
  // clip). Matches reorderClip's splice-based semantics: dropping at index i means "insert before
  // whatever is currently at i".
  const computeOverIndex = (clientX: number): number => {
    const outputPx = outputTimeFromClientX(clientX) * pxPerSec;
    for (let i = 0; i < renderClips.length; i++) {
      const midPx = (outputStarts[i] + clipDurations[i] / 2) * pxPerSec;
      if (outputPx < midPx) return i;
    }
    return renderClips.length - 1;
  };

  const beginClipDrag = (clip: Clip, index: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setClipDrag({ index, clip, startClientX: e.clientX, isDragging: false, overIndex: index });
  };
  const handleClipDragMove = (e: React.PointerEvent) => {
    if (!clipDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - clipDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    setClipDrag((prev) =>
      prev ? { ...prev, isDragging: prev.isDragging || moved, overIndex: computeOverIndex(e.clientX) } : prev
    );
  };
  const endClipDrag = () => {
    if (!clipDrag) return;
    const { index, clip, isDragging, overIndex } = clipDrag;
    setClipDrag(null);
    if (isDragging) {
      editStore.reorderClip(index, overIndex);
    } else {
      setSelectedClipId(clip.id);
      activeClipIndexRef.current = index;
      lastAppliedTimeRef.current = clip.start;
      onSeek(clip.start);
    }
  };

  const handleSplit = () => editStore.splitAt(currentTime);
  const handleDeleteSegment = () => {
    const selected = selectedClipId ? baseClips.find((c) => c.id === selectedClipId) : undefined;
    editStore.deleteClipAt(selected ? selected.start : currentTime);
    if (selected) setSelectedClipId(null);
  };
  const handleSave = async () => {
    const result = await editStore.exportEdited();
    if (result) onExported(result.path, result.name);
  };

  // Bootstrap: whenever a different clip becomes first in playback order - initial load, or a
  // reorder that puts something else at index 0 - force playback to actually start there, rather
  // than trusting wherever the native <video> defaults to (source time 0, or wherever the user
  // last happened to be). Keyed on the first clip's *id* rather than its start/end, so resizing
  // that same clip's own edges mid-edit doesn't yank playback back to the start every time.
  const bootstrappedFirstClipIdRef = useRef<string | null>(null);
  useEffect(() => {
    const first = baseClips[0];
    if (!first || first.id === "__pending__" || bootstrappedFirstClipIdRef.current === first.id) return;
    bootstrappedFirstClipIdRef.current = first.id;
    activeClipIndexRef.current = 0;
    lastAppliedTimeRef.current = first.start;
    onSeek(first.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseClips[0]?.id]);

  // Live-preview: keeps playback following the clips in their *playback* (array) order rather
  // than raw source order. `activeClipIndexRef` is only ever *advanced* here, never re-derived
  // from "whichever clip this source time happens to belong to" (see the ref's own comment above
  // for why that broke reordering) - every tick just checks whether currentTime is still inside
  // the clip already being tracked, and if not, jumps straight to the start of the next clip in
  // array order, which may be earlier *or* later in the source file than where it just was. This
  // is what makes a reordered timeline actually preview in the new order using nothing but seeks
  // on the same raw <video> element - no re-encoding needed for preview, only at Save. Only
  // active while this timeline panel is mounted, since onSeek is the only way to reach the real
  // player from here - closing the panel mid-edit just means preview following pauses, edits
  // themselves are unaffected either way.
  useEffect(() => {
    if (baseClips.length === 0 || currentTime === lastAppliedTimeRef.current) return;
    const activeIdx = activeClipIndexRef.current;
    if (activeIdx < 0 || activeIdx >= baseClips.length) return; // not bootstrapped yet
    const active = baseClips[activeIdx];
    if (currentTime >= active.start && currentTime < active.end) return; // still inside it

    const nextIndex = activeIdx + 1;
    if (nextIndex < baseClips.length) {
      activeClipIndexRef.current = nextIndex;
      lastAppliedTimeRef.current = baseClips[nextIndex].start;
      onSeek(baseClips[nextIndex].start);
    }
    // else: finished the last clip in playback order - let native playback end there naturally.
  }, [currentTime, editStore.clips]);

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

  // Playhead position on the (output/assembled) ruler - maps currentTime (a raw source
  // timestamp) via whichever clip is currently considered active, falling back to the nearest
  // valid index if currentTime doesn't cleanly fall inside any clip right this instant (e.g. mid-
  // transition, the one tick before the effect above seeks onward).
  const activeIndexForDisplay = (() => {
    const idx = clipIndexAt(renderClips, currentTime);
    if (idx !== -1) return idx;
    return Math.min(Math.max(activeClipIndexRef.current, 0), renderClips.length - 1);
  })();
  const playheadLeft =
    renderClips.length > 0
      ? (outputStarts[activeIndexForDisplay] +
          Math.max(0, Math.min(currentTime - renderClips[activeIndexForDisplay].start, clipDurations[activeIndexForDisplay]))) *
        pxPerSec
      : 0;

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
          <ActionButton title="Undo" onClick={editStore.undo} disabled={!editStore.canUndo}>
            <IoArrowUndo size={15} />
          </ActionButton>
          <ActionButton title="Redo" onClick={editStore.redo} disabled={!editStore.canRedo}>
            <IoArrowRedo size={15} />
          </ActionButton>
          <div className="w-px h-5 bg-neutral-700 mx-1" />
          <ActionButton title="Split at playhead" onClick={handleSplit} disabled={duration <= 0}>
            <IoCutOutline size={15} />
          </ActionButton>
          <ActionButton
            title={selectedClipId ? "Delete selected clip" : "Delete clip at playhead"}
            onClick={handleDeleteSegment}
            disabled={editStore.clips.length <= 1}
          >
            <IoTrashOutline size={15} />
          </ActionButton>
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
            title={editStore.exportError ?? "Save the trimmed/cut/reordered result as a new file - the original is never modified"}
            onClick={handleSave}
            disabled={!editStore.canUndo || editStore.isExporting}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-400 disabled:cursor-default"
          >
            <IoSaveOutline size={14} />
            {editStore.isExporting
              ? editStore.exportProgress != null
                ? `Saving… ${Math.round(editStore.exportProgress)}%`
                : "Saving…"
              : "Save"}
          </button>
          <div className="w-px h-5 bg-neutral-700 mx-1" />
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
          <button
            type="button"
            title={isPlaying ? "Pause" : "Play"}
            onClick={onTogglePlay}
            className="text-neutral-400 hover:text-neutral-200"
          >
            {isPlaying ? <IoPause size={15} /> : <IoPlay size={15} />}
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
            {/* Ruler - represents the *assembled* (playback-order) timeline, not raw source time */}
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

            {/* Filename / total duration - shown once, independent of which clip currently sits
                first (reordering shouldn't make this label jump between blocks). */}
            <div className="h-5 flex items-center justify-between gap-2 px-1.5 text-[11px] text-neutral-300">
              {renamingInline ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenamingInline(false);
                  }}
                  className="flex-1 min-w-0 bg-neutral-900 text-white rounded px-1 border border-blue-400"
                />
              ) : (
                <span className="truncate">{file.name}</span>
              )}
              <span className="tabular-nums shrink-0">{formatTimestamp(totalOutputDuration)}</span>
            </div>

            {/* Track */}
            <div
              className="h-16 relative py-1 cursor-pointer"
              onPointerDown={handleScrubPointerDown}
              onPointerMove={handleScrubPointerMove}
            >
              {/* Clip blocks, laid out sequentially in playback order - click to select (dashed
                  outline), drag past a few px to reorder (see beginClipDrag's comment for why
                  this is pointer-based rather than the HTML5 drag-and-drop API), edge handles
                  below to resize. */}
              {renderClips.map((clip, i) => {
                const isPending = clip.id === "__pending__";
                const left = outputStarts[i] * pxPerSec;
                const width = Math.max(1, clipDurations[i] * pxPerSec);
                const isSelected = selectedClipId === clip.id;
                const isDragging = clipDrag?.index === i && clipDrag.isDragging;
                const isDragOver = clipDrag?.isDragging && clipDrag.overIndex === i && clipDrag.index !== i;
                const clipThumbs = thumbnails.filter((t) => t.time >= clip.start && t.time < clip.end);
                return (
                  <div
                    key={clip.id}
                    onPointerDown={isPending ? undefined : beginClipDrag(baseClips[i], i)}
                    onPointerMove={handleClipDragMove}
                    onPointerUp={endClipDrag}
                    title={isPending ? undefined : `Clip ${i + 1} of ${renderClips.length} — click to select, drag to reorder`}
                    className={`absolute inset-y-1 rounded overflow-hidden border-2 bg-black flex ${
                      isPending ? "" : "cursor-grab active:cursor-grabbing"
                    } ${isSelected ? "border-dashed border-white" : "border-teal-500"} ${isDragging ? "opacity-40" : ""} ${
                      isDragOver ? "ring-2 ring-blue-400" : ""
                    }`}
                    style={{ left, width }}
                  >
                    {clipThumbs.length > 0 ? (
                      clipThumbs.map((t, ti) =>
                        t.src ? (
                          <img key={ti} src={t.src} className="h-full flex-1 object-cover" draggable={false} alt="" />
                        ) : (
                          <div key={ti} className="h-full flex-1 bg-neutral-800" />
                        )
                      )
                    ) : (
                      <div className="h-full w-full bg-neutral-800" />
                    )}
                  </div>
                );
              })}

              {/* Resize handles - two per real clip (start/end edges), kept as separate overlay
                  elements (not nested inside the draggable clip block above) so interacting with
                  them can't accidentally trigger that block's native drag-to-reorder. */}
              {renderClips.map((clip, i) => {
                if (clip.id === "__pending__") return null;
                const left = outputStarts[i] * pxPerSec;
                const width = clipDurations[i] * pxPerSec;
                return (
                  <React.Fragment key={`resize-${clip.id}`}>
                    <div
                      onPointerDown={beginResizeDrag(baseClips[i], "start")}
                      onPointerMove={handleResizeDragMove}
                      onPointerUp={endResizeDrag}
                      title="Drag to trim this clip's start"
                      className="absolute inset-y-1 w-2 -ml-1 bg-teal-400 hover:bg-teal-300 rounded cursor-ew-resize z-10"
                      style={{ left }}
                    />
                    <div
                      onPointerDown={beginResizeDrag(baseClips[i], "end")}
                      onPointerMove={handleResizeDragMove}
                      onPointerUp={endResizeDrag}
                      title="Drag to trim this clip's end"
                      className="absolute inset-y-1 w-2 -ml-1 bg-teal-400 hover:bg-teal-300 rounded cursor-ew-resize z-10"
                      style={{ left: left + width }}
                    />
                  </React.Fragment>
                );
              })}
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
