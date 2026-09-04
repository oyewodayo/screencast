// components/docker/VideoTimelineDocker.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/tauri";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/api/dialog";
import { BsCursor } from "react-icons/bs";
import { MdBlurOn, MdFlip, MdGraphicEq, MdPictureInPictureAlt } from "react-icons/md";
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
  IoAddCircleOutline,
  IoImageOutline,
} from "react-icons/io5";
import { DockerFile } from "./FileToolsDocker";
import { ExportQuality, UseVideoEditStoreResult } from "../../hooks/useVideoEditStore";
import { AudioOverlay, BlurOverlay, Clip, ImageOverlay, PipOverlay, TextOverlay } from "../../utils/videoEditTypes";
import { FILE_CATEGORY_EXTENSIONS } from "../../utils/fileCategory";
import { getWaveformPeaks, sliceWaveformWindow } from "../../utils/audioWaveform";
import { overlaysActiveAt, resizeAudioOverlayTime as resizeAudioOverlayTimeHandler, resizePipOverlayTime as resizePipOverlayTimeHandler } from "../../handlers/videoEditHandlers";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import AudioOverlayPopover from "./AudioOverlayPopover";
import ClipEffectsPopover from "./ClipEffectsPopover";
import ExportOptionsPopover from "./ExportOptionsPopover";
import SilenceDetectionPopover, { SilenceDetectionState } from "./SilenceDetectionPopover";
import { ActiveClipEffects, TRANSITION_PRESETS } from "../../utils/videoColorFilters";

const MIN_PX_PER_SEC = 8;
const MAX_PX_PER_SEC = 200;
const DEFAULT_PX_PER_SEC = 40;
const THUMB_TARGET_WIDTH = 100; // px - roughly how wide each filmstrip frame should be
const NICE_TICK_INTERVALS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600]; // seconds
const MIN_TICK_SPACING_PX = 70;
const MIN_CLIP_LENGTH = 0.05;
const MIN_OVERLAY_DURATION = 0.1; // matches videoEditHandlers.ts's own MIN_OVERLAY_DURATION
// How close (in on-screen pixels, not seconds - so the snap "feels" equally sticky regardless of
// zoom level) a dragged overlay edge/position needs to land next to a snap target before it's
// pulled onto it exactly. Applied to the RAW (pre-clamp) candidate value in every overlay drag/
// resize handler below, so a snap can never itself push a value out of its own valid bounds - the
// existing min/max clamp right after always runs on the (possibly snapped) result.
const SNAP_THRESHOLD_PX = 8;

// Pulls `value` onto whichever entry in `targets` is within SNAP_THRESHOLD_PX of it, if any -
// otherwise returns `value` unchanged. Shared by every overlay drag/resize handler (text/image/
// blur/audio) so dragging or retiming any of them snaps to the same landmarks: the playhead and
// every clip boundary (see overlaySnapTargets below). Ties broken by whichever target is nearest,
// not by array order.
function snapToTargets(value: number, targets: number[], pxPerSec: number): number {
  const thresholdSec = SNAP_THRESHOLD_PX / pxPerSec;
  let best = value;
  let bestDist = thresholdSec;
  for (const target of targets) {
    const dist = Math.abs(value - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = target;
    }
  }
  return best;
}
// Generous tolerance on the "still inside the tracked clip" check in the live-preview tracking
// effect below - seeking to an arbitrary time doesn't always land exactly there (keyframe-
// interval snapping, decoder rounding), so a strict [start,end) check evaluated on the very first
// tick after a seek could look like we'd already left the clip we just jumped to, and cascade
// straight past it to the *next* one - which is exactly what "played the first clip then skipped
// straight to the third" was: the seek to clip 2 landed a hair outside its stored [start,end), so
// that effect immediately advanced again before clip 2 ever got a chance to play. Also used by
// handleTransportPlayClick to decide "are we sitting at the very end of the sequence".
const SEEK_TOLERANCE_SEC = 0.25;

const formatTimestamp = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

interface ThumbFrame {
  time: number; // source time this frame was captured at
  src: string;
}

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

// The audio-overlay chip's real waveform - a genuine decode (see audioWaveform.ts), not a
// decorative placeholder. Needs its own component (rather than being computed inline in the
// lane's .map() below) because decoding is async and per-file: each chip tracks its own decoded
// peaks via its own hook state, which .map() callbacks can't own directly. Re-slices (not
// re-decodes) whenever the visible window (trimStart/duration, from drag or resize) or pixel size
// changes, so a live trim drag updates the waveform every frame from already-decoded data.
const AudioChipWaveform: React.FC<{ overlay: AudioOverlay; widthPx: number; heightPx: number }> = ({ overlay, widthPx, heightPx }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWaveformPeaks(overlay.src)
      .then((p) => {
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        /* getWaveformPeaks already logs - a failed decode just leaves the chip waveform-less */
      });
    return () => {
      cancelled = true;
    };
  }, [overlay.src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || widthPx <= 0 || heightPx <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(widthPx * dpr));
    canvas.height = Math.max(1, Math.round(heightPx * dpr));
    ctx.scale(dpr, dpr);

    const duration = overlay.endTime - overlay.startTime;
    const buckets = Math.max(8, Math.floor(widthPx / 2));
    const windowed = sliceWaveformWindow(peaks, overlay.sourceDuration, overlay.trimStart, duration, buckets);
    const barWidth = widthPx / buckets;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    windowed.forEach((amp, i) => {
      const barHeight = Math.max(1, amp * heightPx);
      ctx.fillRect(i * barWidth, (heightPx - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
    });
  }, [peaks, widthPx, heightPx, overlay.trimStart, overlay.startTime, overlay.endTime, overlay.sourceDuration]);

  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" style={{ width: widthPx, height: heightPx }} />;
};

// Real waveform for a CLIP's own audio (not an AudioOverlay) - same decode-once/slice-per-render
// shape as AudioChipWaveform above, just keyed by the clip's sourcePath/start/end instead of an
// overlay's src/trimStart/duration, so a clip's trim handles have precise audio-driven cut points
// to line up against instead of guessing from the filmstrip's video frames alone. Drawn baseline-up
// as a bottom ledge (not centered, unlike the audio-overlay chip) with its own scrim behind it, so
// it reads clearly over a filmstrip frame of any brightness instead of competing with it.
const ClipWaveform: React.FC<{ sourcePath: string; trimStart: number; trimEnd: number; sourceDuration: number | null; widthPx: number; heightPx: number }> = ({
  sourcePath,
  trimStart,
  trimEnd,
  sourceDuration,
  widthPx,
  heightPx,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWaveformPeaks(sourcePath)
      .then((p) => {
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        /* getWaveformPeaks already logs - a source with no audio track (or a failed decode) just
           leaves this clip waveform-less, same degradation AudioChipWaveform already accepts. */
      });
    return () => {
      cancelled = true;
    };
  }, [sourcePath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || !sourceDuration || widthPx <= 0 || heightPx <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(widthPx * dpr));
    canvas.height = Math.max(1, Math.round(heightPx * dpr));
    ctx.scale(dpr, dpr);

    const duration = Math.max(0, trimEnd - trimStart);
    const buckets = Math.max(8, Math.floor(widthPx / 2));
    const windowed = sliceWaveformWindow(peaks, sourceDuration, trimStart, duration, buckets);
    const barWidth = widthPx / buckets;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    windowed.forEach((amp, i) => {
      const barHeight = Math.max(1, amp * heightPx);
      ctx.fillRect(i * barWidth, heightPx - barHeight, Math.max(1, barWidth - 1), barHeight);
    });
  }, [peaks, widthPx, heightPx, trimStart, trimEnd, sourceDuration]);

  if (!peaks) return null;
  return (
    <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{ height: heightPx }}>
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
      <canvas ref={canvasRef} className="absolute inset-0" style={{ width: widthPx, height: heightPx }} />
    </div>
  );
};

// The main video's own audio level (volume + mute) - see videoEditTypes.ts's
// videoAudioMuted/videoAudioVolume doc comment for why this is separate from any AudioOverlay's
// own volume/mute. Its own component (rather than inlined in the lane's JSX) purely so
// useClampedPopoverPosition - which measures this popover's actual rendered size to keep it
// on-screen, see that hook's own comment for why the raw anchor alone isn't enough near the
// bottom of the window - can be called unconditionally the way hooks require; the parent only
// mounts this at all while the popover should be showing.
const TrackAudioPopover: React.FC<{
  anchor: PopoverAnchor;
  volume: number;
  muted: boolean;
  onSetVolume: (volume: number) => void;
  onSetMuted: (muted: boolean) => void;
}> = ({ anchor, volume, muted, onSetVolume, onSetMuted }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  return createPortal(
    <div
      ref={ref}
      data-track-audio-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-56 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
    >
      <span className="text-xs font-medium">Video audio</span>
      <label className="flex items-center gap-2 text-[11px]">
        <span className="w-12 shrink-0 text-white/60">Volume</span>
        <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => onSetVolume(Number(e.target.value))} className="flex-1 accent-teal-400" />
        <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round(volume * 100)}%</span>
      </label>
      <button
        type="button"
        onClick={() => onSetMuted(!muted)}
        className={`self-start px-2 py-1 rounded text-[11px] transition-colors ${muted ? "text-red-400 bg-red-500/10" : "text-white/70 hover:text-white hover:bg-white/10"}`}
      >
        {muted ? "Muted" : "Mute"}
      </button>
    </div>,
    document.body
  );
};

interface VideoTimelineDockerProps {
  file: DockerFile;
  playableSrc: string;
  // Lifted to Dashboard.tsx (single call site - useVideoEditStore is a stateful hook, unsafe to
  // call from more than one component) so the preview-layer text-overlay editor near VideoPlayer
  // and this docker's timeline lane can share the exact same edit state/undo-redo stack.
  editStore: UseVideoEditStoreResult;
  currentTime: number;
  // sourcePath names which file's timeline `time` belongs to - required now that a clip dragged
  // in from elsewhere means "seek to this time" is ambiguous without saying which file. Dashboard
  // swaps the player's actual source when it differs from what's currently loaded; see its
  // handleSeekActiveFile for the details.
  onSeek: (sourcePath: string, time: number) => void;
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

  // Drag-in support - inserting a whole other file as a new clip anywhere on the timeline.
  //
  // A file being dragged from the Briefcast sidebar right now (in-page pointer drag, tracked in
  // Dashboard.tsx) - null otherwise. Used only to know a drop here should insert a clip; the
  // actual drop is still a plain HTML5 dragover/drop pair (see the track's onDragOver/onDrop
  // below), since - unlike reordering clips already on this timeline - this drag both starts and
  // ends outside this component, and HTML5 DnD's own target-under-cursor dispatch is the simplest
  // way to know when it lands here. This in-page case is reliable via plain dragover/drop because
  // it never leaves the webview.
  draggingLibraryFile: { path: string; name: string } | null;
  // Files Dashboard has confirmed were dropped on *this* track from an external source (Explorer),
  // with the client-X position they landed at - resolved once (fetch each duration, insert each
  // clip), then cleared via onTimelineInsertHandled. Unlike the in-page case above, an external
  // drag's hover position can't be tracked via this component's own dragover handler - Dashboard
  // resolves it by polling the OS cursor position instead (see its onFileDropEvent handler for
  // why: WebView2's DOM dragover isn't reliably delivered for a drag whose *origin* is a
  // different native window, only Tauri's own file-drop event is, and that carries no position).
  pendingTimelineInsert: { paths: string[]; clientX: number } | null;
  onTimelineInsertHandled: () => void;

  // Reports the current position on the assembled/output timeline (same space text overlay
  // start/endTime use) upward, so the preview-layer overlay (mounted next to VideoPlayer, a
  // sibling subtree Dashboard owns) can time-gate which overlays are visible without duplicating
  // this component's own tricky SEEK_TOLERANCE_SEC-guarded active-clip tracking.
  onOutputTimeChange?: (outputTime: number) => void;
  // Reports the ACTIVE clip's own color/Ken Burns effect fields upward, so VideoPlayer (mounted
  // as a sibling subtree by Dashboard) can drive live CSS filter/transform on the <video> element
  // without needing to know about clips at all - same "report state this component already tracks
  // upward for a sibling to consume" reasoning as onOutputTimeChange just above.
  onActiveClipChange?: (effects: ActiveClipEffects | null) => void;

  // Text-overlay selection, lifted to Dashboard.tsx since it's shared with the preview-layer
  // editor mounted next to VideoPlayer - keeps a chip's selected styling here in sync with
  // whichever overlay (if any) is actually open for editing there.
  selectedOverlayId?: string | null;
  onSelectOverlay?: (id: string | null) => void;
  // Whether the "Text" tool is armed - the next click on the video preview places a new overlay
  // (handled by VideoOverlayLayer) and disarms this. Lifted for the same reason as above.
  isPlacingText?: boolean;
  onToggleArmPlaceText?: () => void;

  // Image-overlay selection/placement, same threading/reasoning as the text-overlay props above.
  selectedImageOverlayId?: string | null;
  onSelectImageOverlay?: (id: string | null) => void;
  isPlacingImage?: boolean;
  onToggleArmPlaceImage?: () => void;

  // Blur-region selection/placement, same threading/reasoning as the text/image-overlay props above.
  selectedBlurOverlayId?: string | null;
  onSelectBlurOverlay?: (id: string | null) => void;
  isPlacingBlur?: boolean;
  onToggleArmPlaceBlur?: () => void;

  // PiP-overlay selection/placement, same threading/reasoning as the text/image/blur-overlay props
  // above - see PipOverlayLayer.tsx for where placement/rendering actually happens (a sibling of
  // VideoOverlayLayer, not part of it).
  selectedPipOverlayId?: string | null;
  onSelectPipOverlay?: (id: string | null) => void;
  isPlacingPip?: boolean;
  onToggleArmPlacePip?: () => void;

  // Whether the on-canvas crop tool (ClipCropOverlay, mounted as a sibling next to VideoPlayer by
  // Dashboard) is armed - unlike text/image/blur, there's nothing to "place", it just shows/hides
  // a drag window over whichever clip is currently on screen, so there's no onPlacementConsumed
  // counterpart here; toggling this button again (or the same toggle inside ClipEffectsPopover) is
  // what turns it back off.
  isCroppingClip?: boolean;
  onToggleCroppingClip?: () => void;
}

// The video-specific "file tools" docker: a scrubbable timeline (ruler + playhead + reorderable
// clip blocks) instead of the generic info/actions panel FileToolsDocker uses for other
// categories. The playhead is real (synced both ways with the actual player via currentTime/
// onSeek); the thumbnail filmstrip is captured from real frames and sliced per clip. Every toolbar
// button above it is wired to real state (see ActionButton) - split/delete/crop/mirror/effects/
// text/image/blur/audio all mutate the edit store directly.
// Track-level actions (rename/convert/reveal/delete) live in the "..." menu on the left rail,
// reusing the same handlers FileToolsDocker's generic panel uses for every other category.
const VideoTimelineDocker: React.FC<VideoTimelineDockerProps> = ({
  file,
  playableSrc,
  editStore,
  currentTime,
  onSeek,
  isPlaying,
  onTogglePlay,
  onConvert,
  onRename,
  onDelete,
  onExported,
  draggingLibraryFile,
  pendingTimelineInsert,
  onTimelineInsertHandled,
  onOutputTimeChange,
  onActiveClipChange,
  selectedOverlayId = null,
  onSelectOverlay,
  isPlacingText = false,
  onToggleArmPlaceText,
  selectedImageOverlayId = null,
  onSelectImageOverlay,
  isPlacingImage = false,
  onToggleArmPlaceImage,
  selectedBlurOverlayId = null,
  onSelectBlurOverlay,
  isPlacingBlur = false,
  onToggleArmPlaceBlur,
  selectedPipOverlayId = null,
  onSelectPipOverlay,
  isPlacingPip = false,
  onToggleArmPlacePip,
  isCroppingClip = false,
  onToggleCroppingClip,
}) => {
  const hiddenVideoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  // One hidden <audio> per audio overlay, kept in sync with the main player below - no existing
  // pattern for this in the codebase (see the plan's own Context: every other `new Audio(...)`
  // usage is a one-shot UI sound effect, not a seekable/synced source).
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const trackAreaRef = useRef<HTMLDivElement>(null);

  const [duration, setDuration] = useState<number>(0);
  // Native pixel size of the primary file, read off the same hidden capture <video> already used
  // for thumbnails once its metadata loads - Save needs this to know what resolution to render
  // text/image overlay PNGs at for burn-in (see videoOverlayRender.ts / exportEdited), since
  // TextOverlay/ImageOverlay only store position/size as frame-relative fractions.
  const [videoPixelSize, setVideoPixelSize] = useState<{ width: number; height: number } | null>(null);
  const [pxPerSec, setPxPerSec] = useState<number>(DEFAULT_PX_PER_SEC);
  const [thumbnails, setThumbnails] = useState<ThumbFrame[]>([]);
  const [coverThumbnail, setCoverThumbnail] = useState<string | null>(null);

  // Visibility/lock are still cosmetic-only (no backend behind them yet) - mute/volume are real,
  // backed by editStore.videoAudioMuted/videoAudioVolume (see the track-audio popover further
  // down), unlike when this comment was first written.
  const [trackVisible, setTrackVisible] = useState(true);
  const [trackLocked, setTrackLocked] = useState(false);
  const [trackAudioPopoverAnchor, setTrackAudioPopoverAnchor] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!trackAudioPopoverAnchor) return;
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-track-audio-popover]")) return;
      setTrackAudioPopoverAnchor(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [trackAudioPopoverAnchor]);
  const [menuOpen, setMenuOpen] = useState(false);
  // The "..." menu is rendered through a portal (see moreMenuButtonRef/moreMenuPosition below)
  // rather than as a normal absolutely-positioned child - the Timeline panel has overflow-hidden
  // (for the track's rounded corners/border), and this menu anchors near the bottom of a short
  // rail, so once it grew past 3 items its top rows were silently clipped by that ancestor. A
  // portal escapes that clipping entirely; its position is just computed from the button's own
  // viewport rect instead of relying on CSS positioning relative to an ancestor.
  const moreMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [moreMenuPosition, setMoreMenuPosition] = useState<{ top: number; left: number } | null>(null);

  // Audio overlay selection/placement - unlike text/image, fully local to this component (see the
  // plan's own Context: audio has no box on the video frame, so VideoOverlayLayer/Dashboard never
  // need to know about it at all).
  const [isPlacingAudio, setIsPlacingAudio] = useState(false);
  const [selectedAudioOverlayId, setSelectedAudioOverlayId] = useState<string | null>(null);
  const [audioPopoverAnchor, setAudioPopoverAnchor] = useState<{ left: number; top: number } | null>(null);

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
      if (video.videoWidth > 0 && video.videoHeight > 0) setVideoPixelSize({ width: video.videoWidth, height: video.videoHeight });

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
  const selectedClip = selectedClipId ? editStore.clips.find((c) => c.id === selectedClipId) ?? null : null;
  // Effects popover (color grade/Ken Burns/transition) for whichever clip is selected - opened
  // from the toolbar's Effects button, closed the same "outside click" way AudioOverlayPopover
  // closes itself, plus whenever selection moves to a different clip (below) so it never keeps
  // pointing at a clip that's no longer selected.
  const [effectsPopoverAnchor, setEffectsPopoverAnchor] = useState<{ left: number; top: number } | null>(null);
  const effectsButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setEffectsPopoverAnchor(null);
  }, [selectedClipId]);

  // Save button's quality/destination options (ExportOptionsPopover) - both default to exactly
  // the behavior export_trimmed_video already had before this existed: "standard" quality, and a
  // null customOutputPath meaning "next to the source file" (see handleSave below).
  const [exportOptionsAnchor, setExportOptionsAnchor] = useState<{ left: number; top: number } | null>(null);
  const exportOptionsButtonRef = useRef<HTMLButtonElement>(null);
  const [exportQuality, setExportQuality] = useState<ExportQuality>("standard");
  const [customOutputPath, setCustomOutputPath] = useState<string | null>(null);

  // Trim Silence toolbar button - anchor null means the popover is closed; silenceState only
  // matters while it's open (loading/empty/error/results, see SilenceDetectionPopover). Scoped to
  // the currently SELECTED clip only (same "select a clip first" gating Crop/Effects already use),
  // since detect_silence needs one concrete source file/range to scan.
  const [silenceAnchor, setSilenceAnchor] = useState<{ left: number; top: number } | null>(null);
  const [silenceState, setSilenceState] = useState<SilenceDetectionState>({ status: "loading" });
  const silenceButtonRef = useRef<HTMLButtonElement>(null);

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
    maxEnd: number;
    liveValue: number;
    // The playhead's position translated into this clip's own source-time space, captured once at
    // drag start - null when the playhead isn't currently inside this clip's own range, meaning
    // there's nothing meaningful to snap to. See beginResizeDrag for how it's derived.
    playheadSourceTime: number | null;
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
  const baseClips: Clip[] =
    editStore.clips.length > 0 ? editStore.clips : duration > 0 ? [{ id: "__pending__", sourcePath: file.path, start: 0, end: duration }] : [];

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

  // Live drag state for the text-overlay lane below - same delta-based/live-preview shape as
  // resizeDrag/clipDrag above, just retiming a TextOverlay instead of a Clip. Kept as separate
  // state (rather than reusing resizeDrag/clipDrag) since the clamping rules differ (against
  // totalOutputDuration, not a source file's own duration) and an overlay id could otherwise be
  // mistaken for a clip id sharing the same drag state shape.
  const [overlayResizeDrag, setOverlayResizeDrag] = useState<null | {
    id: string;
    edge: "start" | "end";
    startClientX: number;
    startValue: number;
    oppositeBound: number;
    liveValue: number;
  }>(null);
  const [overlayDrag, setOverlayDrag] = useState<null | {
    id: string;
    startClientX: number;
    startTime: number;
    duration: number;
    isDragging: boolean;
    liveStartTime: number;
  }>(null);

  const renderOverlays: TextOverlay[] = editStore.textOverlays.map((o) => {
    if (overlayResizeDrag && o.id === overlayResizeDrag.id) {
      return overlayResizeDrag.edge === "start" ? { ...o, startTime: overlayResizeDrag.liveValue } : { ...o, endTime: overlayResizeDrag.liveValue };
    }
    if (overlayDrag && o.id === overlayDrag.id) {
      return { ...o, startTime: overlayDrag.liveStartTime, endTime: overlayDrag.liveStartTime + overlayDrag.duration };
    }
    return o;
  });

  const beginOverlayResizeDrag = (overlay: TextOverlay, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectOverlay?.(overlay.id);
    const startValue = edge === "start" ? overlay.startTime : overlay.endTime;
    const oppositeBound = edge === "start" ? overlay.endTime : overlay.startTime;
    setOverlayResizeDrag({ id: overlay.id, edge, startClientX: e.clientX, startValue, oppositeBound, liveValue: startValue });
  };
  const handleOverlayResizeDragMove = (e: React.PointerEvent) => {
    if (!overlayResizeDrag) return;
    e.stopPropagation();
    const deltaSec = (e.clientX - overlayResizeDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(overlayResizeDrag.startValue + deltaSec, overlaySnapTargets, pxPerSec);
    const clamped =
      overlayResizeDrag.edge === "start"
        ? Math.max(0, Math.min(raw, overlayResizeDrag.oppositeBound - MIN_OVERLAY_DURATION))
        : Math.min(totalOutputDuration, Math.max(raw, overlayResizeDrag.oppositeBound + MIN_OVERLAY_DURATION));
    setOverlayResizeDrag((prev) => (prev ? { ...prev, liveValue: clamped } : prev));
  };
  const endOverlayResizeDrag = () => {
    if (!overlayResizeDrag) return;
    const { id, edge, liveValue } = overlayResizeDrag;
    setOverlayResizeDrag(null);
    editStore.resizeTextOverlayTime(id, edge, liveValue);
  };

  const beginOverlayDrag = (overlay: TextOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setOverlayDrag({
      id: overlay.id,
      startClientX: e.clientX,
      startTime: overlay.startTime,
      duration: overlay.endTime - overlay.startTime,
      isDragging: false,
      liveStartTime: overlay.startTime,
    });
  };
  const handleOverlayDragMove = (e: React.PointerEvent) => {
    if (!overlayDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - overlayDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const deltaSec = (e.clientX - overlayDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(overlayDrag.startTime + deltaSec, overlaySnapTargets, pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - overlayDrag.duration));
    setOverlayDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveStartTime } : prev));
  };
  const endOverlayDrag = () => {
    if (!overlayDrag) return;
    const { id, isDragging, liveStartTime, duration } = overlayDrag;
    setOverlayDrag(null);
    if (isDragging) {
      editStore.moveTextOverlayTime(id, liveStartTime);
    }
    onSelectOverlay?.(id);
    // Selecting a text overlay only actually opens it for editing in the main preview once the
    // playhead sits inside its own time range - VideoOverlayLayer's editingSession is gated on
    // "active at currentOutputTime" (so text off-screen at the current moment doesn't render an
    // editor for it). Without this, clicking a chip whose range the playhead wasn't already inside
    // updated selectedOverlayId but visibly did nothing in the preview, which read as "selecting
    // from the timeline doesn't work" even though the click itself was registering correctly.
    if (currentOutputTime < liveStartTime || currentOutputTime >= liveStartTime + duration) {
      seekToOutputTime(liveStartTime);
    }
  };

  // Same shape as the text-overlay lane's drag state just above, retiming an ImageOverlay instead
  // - kept as its own state for the same reason overlayResizeDrag/overlayDrag are kept separate
  // from resizeDrag/clipDrag (a shared id namespace between drag kinds would be a real hazard).
  const [imageOverlayResizeDrag, setImageOverlayResizeDrag] = useState<null | {
    id: string;
    edge: "start" | "end";
    startClientX: number;
    startValue: number;
    oppositeBound: number;
    liveValue: number;
  }>(null);
  const [imageOverlayDrag, setImageOverlayDrag] = useState<null | {
    id: string;
    startClientX: number;
    startTime: number;
    duration: number;
    isDragging: boolean;
    liveStartTime: number;
  }>(null);

  const renderImageOverlays: ImageOverlay[] = editStore.imageOverlays.map((o) => {
    if (imageOverlayResizeDrag && o.id === imageOverlayResizeDrag.id) {
      return imageOverlayResizeDrag.edge === "start" ? { ...o, startTime: imageOverlayResizeDrag.liveValue } : { ...o, endTime: imageOverlayResizeDrag.liveValue };
    }
    if (imageOverlayDrag && o.id === imageOverlayDrag.id) {
      return { ...o, startTime: imageOverlayDrag.liveStartTime, endTime: imageOverlayDrag.liveStartTime + imageOverlayDrag.duration };
    }
    return o;
  });

  const beginImageOverlayResizeDrag = (overlay: ImageOverlay, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectImageOverlay?.(overlay.id);
    const startValue = edge === "start" ? overlay.startTime : overlay.endTime;
    const oppositeBound = edge === "start" ? overlay.endTime : overlay.startTime;
    setImageOverlayResizeDrag({ id: overlay.id, edge, startClientX: e.clientX, startValue, oppositeBound, liveValue: startValue });
  };
  const handleImageOverlayResizeDragMove = (e: React.PointerEvent) => {
    if (!imageOverlayResizeDrag) return;
    e.stopPropagation();
    const deltaSec = (e.clientX - imageOverlayResizeDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(imageOverlayResizeDrag.startValue + deltaSec, overlaySnapTargets, pxPerSec);
    const clamped =
      imageOverlayResizeDrag.edge === "start"
        ? Math.max(0, Math.min(raw, imageOverlayResizeDrag.oppositeBound - MIN_OVERLAY_DURATION))
        : Math.min(totalOutputDuration, Math.max(raw, imageOverlayResizeDrag.oppositeBound + MIN_OVERLAY_DURATION));
    setImageOverlayResizeDrag((prev) => (prev ? { ...prev, liveValue: clamped } : prev));
  };
  const endImageOverlayResizeDrag = () => {
    if (!imageOverlayResizeDrag) return;
    const { id, edge, liveValue } = imageOverlayResizeDrag;
    setImageOverlayResizeDrag(null);
    editStore.resizeImageOverlayTime(id, edge, liveValue);
  };

  const beginImageOverlayDrag = (overlay: ImageOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setImageOverlayDrag({
      id: overlay.id,
      startClientX: e.clientX,
      startTime: overlay.startTime,
      duration: overlay.endTime - overlay.startTime,
      isDragging: false,
      liveStartTime: overlay.startTime,
    });
  };
  const handleImageOverlayDragMove = (e: React.PointerEvent) => {
    if (!imageOverlayDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - imageOverlayDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const deltaSec = (e.clientX - imageOverlayDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(imageOverlayDrag.startTime + deltaSec, overlaySnapTargets, pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - imageOverlayDrag.duration));
    setImageOverlayDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveStartTime } : prev));
  };
  const endImageOverlayDrag = () => {
    if (!imageOverlayDrag) return;
    const { id, isDragging, liveStartTime, duration } = imageOverlayDrag;
    setImageOverlayDrag(null);
    if (isDragging) {
      editStore.moveImageOverlayTime(id, liveStartTime);
    }
    onSelectImageOverlay?.(id);
    // Same reasoning as endOverlayDrag's own comment: image overlays are also only rendered (and
    // so only visibly show selection handles) while the playhead is inside their own time range
    // (see activeImageOverlays' overlaysActiveAt filter in VideoOverlayLayer.tsx), so selecting one
    // from the timeline while the playhead is elsewhere needs to bring the playhead along with it.
    if (currentOutputTime < liveStartTime || currentOutputTime >= liveStartTime + duration) {
      seekToOutputTime(liveStartTime);
    }
  };

  // ---- Blur-overlay lane drag (move) / resize (retime) - same shape as the image-overlay block
  // above, just against editStore's blur methods and onSelectBlurOverlay instead. ----------------
  const [blurOverlayResizeDrag, setBlurOverlayResizeDrag] = useState<null | {
    id: string;
    edge: "start" | "end";
    startClientX: number;
    startValue: number;
    oppositeBound: number;
    liveValue: number;
  }>(null);
  const [blurOverlayDrag, setBlurOverlayDrag] = useState<null | {
    id: string;
    startClientX: number;
    startTime: number;
    duration: number;
    isDragging: boolean;
    liveStartTime: number;
  }>(null);

  const renderBlurOverlays: BlurOverlay[] = editStore.blurOverlays.map((o) => {
    if (blurOverlayResizeDrag && o.id === blurOverlayResizeDrag.id) {
      return blurOverlayResizeDrag.edge === "start" ? { ...o, startTime: blurOverlayResizeDrag.liveValue } : { ...o, endTime: blurOverlayResizeDrag.liveValue };
    }
    if (blurOverlayDrag && o.id === blurOverlayDrag.id) {
      return { ...o, startTime: blurOverlayDrag.liveStartTime, endTime: blurOverlayDrag.liveStartTime + blurOverlayDrag.duration };
    }
    return o;
  });

  const beginBlurOverlayResizeDrag = (overlay: BlurOverlay, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectBlurOverlay?.(overlay.id);
    const startValue = edge === "start" ? overlay.startTime : overlay.endTime;
    const oppositeBound = edge === "start" ? overlay.endTime : overlay.startTime;
    setBlurOverlayResizeDrag({ id: overlay.id, edge, startClientX: e.clientX, startValue, oppositeBound, liveValue: startValue });
  };
  const handleBlurOverlayResizeDragMove = (e: React.PointerEvent) => {
    if (!blurOverlayResizeDrag) return;
    e.stopPropagation();
    const deltaSec = (e.clientX - blurOverlayResizeDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(blurOverlayResizeDrag.startValue + deltaSec, overlaySnapTargets, pxPerSec);
    const clamped =
      blurOverlayResizeDrag.edge === "start"
        ? Math.max(0, Math.min(raw, blurOverlayResizeDrag.oppositeBound - MIN_OVERLAY_DURATION))
        : Math.min(totalOutputDuration, Math.max(raw, blurOverlayResizeDrag.oppositeBound + MIN_OVERLAY_DURATION));
    setBlurOverlayResizeDrag((prev) => (prev ? { ...prev, liveValue: clamped } : prev));
  };
  const endBlurOverlayResizeDrag = () => {
    if (!blurOverlayResizeDrag) return;
    const { id, edge, liveValue } = blurOverlayResizeDrag;
    setBlurOverlayResizeDrag(null);
    editStore.resizeBlurOverlayTime(id, edge, liveValue);
  };

  const beginBlurOverlayDrag = (overlay: BlurOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setBlurOverlayDrag({
      id: overlay.id,
      startClientX: e.clientX,
      startTime: overlay.startTime,
      duration: overlay.endTime - overlay.startTime,
      isDragging: false,
      liveStartTime: overlay.startTime,
    });
  };
  const handleBlurOverlayDragMove = (e: React.PointerEvent) => {
    if (!blurOverlayDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - blurOverlayDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const deltaSec = (e.clientX - blurOverlayDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(blurOverlayDrag.startTime + deltaSec, overlaySnapTargets, pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - blurOverlayDrag.duration));
    setBlurOverlayDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveStartTime } : prev));
  };
  const endBlurOverlayDrag = () => {
    if (!blurOverlayDrag) return;
    const { id, isDragging, liveStartTime, duration } = blurOverlayDrag;
    setBlurOverlayDrag(null);
    if (isDragging) {
      editStore.moveBlurOverlayTime(id, liveStartTime);
    }
    onSelectBlurOverlay?.(id);
    if (currentOutputTime < liveStartTime || currentOutputTime >= liveStartTime + duration) {
      seekToOutputTime(liveStartTime);
    }
  };

  // ---- PiP-overlay lane drag (move) / resize (trim into source) - move is shaped like the blur
  // block above (a PipOverlay has no popover of its own to manage here, unlike audio - clicking its
  // actual video bubble in the preview, PipOverlayLayer.tsx, is what opens PipOverlayPopover), but
  // resize reuses the pure resizePipOverlayTime handler the same way audio's own resize does below,
  // since a PipOverlay trims into a real source file too (trimStart/sourceDuration), unlike blur's
  // free-stretch box. ------------------------------------------------------------------------------
  const [pipOverlayResizeDrag, setPipOverlayResizeDrag] = useState<null | { id: string; edge: "start" | "end"; startClientX: number; liveValue: number }>(null);
  const [pipOverlayDrag, setPipOverlayDrag] = useState<null | {
    id: string;
    startClientX: number;
    startTime: number;
    duration: number;
    isDragging: boolean;
    liveStartTime: number;
  }>(null);

  const renderPipOverlays: PipOverlay[] = editStore.pipOverlays.map((o) => {
    if (pipOverlayResizeDrag && o.id === pipOverlayResizeDrag.id) {
      return pipOverlayResizeDrag.edge === "start" ? { ...o, startTime: pipOverlayResizeDrag.liveValue } : { ...o, endTime: pipOverlayResizeDrag.liveValue };
    }
    if (pipOverlayDrag && o.id === pipOverlayDrag.id) {
      return { ...o, startTime: pipOverlayDrag.liveStartTime, endTime: pipOverlayDrag.liveStartTime + pipOverlayDrag.duration };
    }
    return o;
  });

  const beginPipOverlayResizeDrag = (overlay: PipOverlay, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectPipOverlay?.(overlay.id);
    setPipOverlayResizeDrag({ id: overlay.id, edge, startClientX: e.clientX, liveValue: edge === "start" ? overlay.startTime : overlay.endTime });
  };
  const handlePipOverlayResizeDragMove = (e: React.PointerEvent) => {
    if (!pipOverlayResizeDrag) return;
    e.stopPropagation();
    const overlay = editStore.pipOverlays.find((o) => o.id === pipOverlayResizeDrag.id);
    if (!overlay) return;
    const deltaSec = (e.clientX - pipOverlayResizeDrag.startClientX) / pxPerSec;
    const raw = snapToTargets((pipOverlayResizeDrag.edge === "start" ? overlay.startTime : overlay.endTime) + deltaSec, overlaySnapTargets, pxPerSec);
    const preview = resizePipOverlayTimeHandler([overlay], overlay.id, pipOverlayResizeDrag.edge, totalOutputDuration, raw)[0];
    const liveValue = pipOverlayResizeDrag.edge === "start" ? preview.startTime : preview.endTime;
    setPipOverlayResizeDrag((prev) => (prev ? { ...prev, liveValue } : prev));
  };
  const endPipOverlayResizeDrag = () => {
    if (!pipOverlayResizeDrag) return;
    const { id, edge, liveValue } = pipOverlayResizeDrag;
    setPipOverlayResizeDrag(null);
    editStore.resizePipOverlayTime(id, edge, liveValue);
  };

  const beginPipOverlayDrag = (overlay: PipOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setPipOverlayDrag({
      id: overlay.id,
      startClientX: e.clientX,
      startTime: overlay.startTime,
      duration: overlay.endTime - overlay.startTime,
      isDragging: false,
      liveStartTime: overlay.startTime,
    });
  };
  const handlePipOverlayDragMove = (e: React.PointerEvent) => {
    if (!pipOverlayDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - pipOverlayDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const deltaSec = (e.clientX - pipOverlayDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(pipOverlayDrag.startTime + deltaSec, overlaySnapTargets, pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - pipOverlayDrag.duration));
    setPipOverlayDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveStartTime } : prev));
  };
  const endPipOverlayDrag = () => {
    if (!pipOverlayDrag) return;
    const { id, isDragging, liveStartTime, duration } = pipOverlayDrag;
    setPipOverlayDrag(null);
    if (isDragging) {
      editStore.movePipOverlayTime(id, liveStartTime);
    }
    onSelectPipOverlay?.(id);
    // Same reasoning as endBlurOverlayDrag's own comment: bring the playhead into the overlay's
    // own range on select, so choosing (or just placing) one from the timeline immediately shows
    // its actual video bubble in the preview instead of leaving it invisible off-screen in time -
    // the gap that made a freshly-added PiP look like it silently failed. Skipped while actively
    // playing, though (unlike the other overlay lanes this was copied from) - a PiP chip is often
    // placed right at/near 0:00 (wherever the playhead happened to sit when it was added), so a
    // plain click to just glance at/select it while mid-playback would otherwise yank playback
    // straight back to the start, which reads as "clicking the timeline restarts the video".
    if (!isPlaying && (currentOutputTime < liveStartTime || currentOutputTime >= liveStartTime + duration)) {
      seekToOutputTime(liveStartTime);
    }
  };

  // ---- Audio overlay placement / drag (move) / resize (trim into source) ---------------------
  //
  // Fully local to this component (see this file's own top-of-plan Context: an audio overlay has
  // no box on the video frame, so unlike text/image, neither VideoOverlayLayer nor Dashboard ever
  // need to know about its selection/placement state at all).
  //
  // Placement mirrors VideoOverlayLayer.tsx's own isPlacingImage effect, including its context-ref
  // snapshot - onAddAudioOverlay-equivalent work here reads currentOutputTime/totalOutputDuration,
  // both of which change continuously during playback, and depending on isPlacingAudio alone (via
  // this ref) is what keeps the effect from tearing down and re-running (re-opening the file
  // dialog) while the async picker is still open - the exact "endless file-dialog" bug that
  // pattern was built to fix for images.
  // Initialized with placeholder 0s, not the real currentOutputTime/totalOutputDuration - both are
  // locals computed later in this component's own body (currentOutputTime from the clip-tracking
  // logic further down), so reading them directly here would be a genuine temporal-dead-zone
  // reference, unlike VideoOverlayLayer's own version of this pattern where the equivalent values
  // are props (available from the top of that function). The effect below - which, unlike this
  // initializer, is a closure not invoked until after the full render completes - overwrites this
  // with real values on every render, well before isPlacingAudio can ever actually flip true.
  const placeAudioContextRef = useRef({ currentOutputTime: 0, totalOutputDuration: 0 });
  useEffect(() => {
    placeAudioContextRef.current = { currentOutputTime, totalOutputDuration };
  });
  useEffect(() => {
    if (!isPlacingAudio) return;
    const { currentOutputTime, totalOutputDuration } = placeAudioContextRef.current;
    let cancelled = false;
    (async () => {
      try {
        const selected = await openFileDialog({ multiple: false, filters: [{ name: "Audio", extensions: FILE_CATEGORY_EXTENSIONS.audio }] });
        if (cancelled || !selected || Array.isArray(selected)) return; // cancelled

        const info = await invoke<Record<string, string>>("get_conversion_info", { inputPath: selected });
        const match = info.duration?.match(/[\d.]+/);
        const sourceDuration = match ? parseFloat(match[0]) : NaN;
        if (cancelled || !Number.isFinite(sourceDuration) || sourceDuration <= 0) return;

        const startTime = currentOutputTime;
        // Defaults to the source's *full* natural length (clamped to what's left of the output
        // timeline), unlike text/image's arbitrary short default - music/voiceover overlays
        // usually want to play out completely rather than needing an immediate manual resize.
        const endTime = Math.min(totalOutputDuration, startTime + sourceDuration);
        if (endTime <= startTime) return; // no room left on the timeline to place it

        const id = editStore.addAudioOverlay(selected, sourceDuration, startTime, endTime);
        setSelectedAudioOverlayId(id);
      } catch (err) {
        console.error("Failed to add audio overlay:", err);
      } finally {
        if (!cancelled) setIsPlacingAudio(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlacingAudio]);

  const [audioOverlayDrag, setAudioOverlayDrag] = useState<null | {
    id: string;
    startClientX: number;
    startTime: number;
    duration: number;
    isDragging: boolean;
    liveStartTime: number;
  }>(null);
  const [audioOverlayResizeDrag, setAudioOverlayResizeDrag] = useState<null | { id: string; edge: "start" | "end"; startClientX: number; liveValue: number }>(null);

  const renderAudioOverlays: AudioOverlay[] = editStore.audioOverlays.map((o) => {
    if (audioOverlayResizeDrag && o.id === audioOverlayResizeDrag.id) {
      return audioOverlayResizeDrag.edge === "start" ? { ...o, startTime: audioOverlayResizeDrag.liveValue } : { ...o, endTime: audioOverlayResizeDrag.liveValue };
    }
    if (audioOverlayDrag && o.id === audioOverlayDrag.id) {
      return { ...o, startTime: audioOverlayDrag.liveStartTime, endTime: audioOverlayDrag.liveStartTime + audioOverlayDrag.duration };
    }
    return o;
  });

  const selectAudioOverlay = (id: string, e: React.PointerEvent) => {
    setSelectedAudioOverlayId(id);
    setAudioPopoverAnchor({ left: e.currentTarget.getBoundingClientRect().left, top: e.currentTarget.getBoundingClientRect().bottom + 6 });
  };

  // Resize's live preview reuses the exact same pure resizeAudioOverlayTime handler the eventual
  // commit calls (rather than re-deriving its own clamping math) - guarantees the chip's live size
  // during the drag can never show something the commit would then clamp back from, which would
  // otherwise read as the chip "snapping" once you let go.
  const beginAudioOverlayResizeDrag = (overlay: AudioOverlay, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    selectAudioOverlay(overlay.id, e);
    setAudioOverlayResizeDrag({ id: overlay.id, edge, startClientX: e.clientX, liveValue: edge === "start" ? overlay.startTime : overlay.endTime });
  };
  const handleAudioOverlayResizeDragMove = (e: React.PointerEvent) => {
    if (!audioOverlayResizeDrag) return;
    e.stopPropagation();
    const overlay = editStore.audioOverlays.find((o) => o.id === audioOverlayResizeDrag.id);
    if (!overlay) return;
    const deltaSec = (e.clientX - audioOverlayResizeDrag.startClientX) / pxPerSec;
    const raw = snapToTargets((audioOverlayResizeDrag.edge === "start" ? overlay.startTime : overlay.endTime) + deltaSec, overlaySnapTargets, pxPerSec);
    const preview = resizeAudioOverlayTimeHandler([overlay], overlay.id, audioOverlayResizeDrag.edge, totalOutputDuration, raw)[0];
    const liveValue = audioOverlayResizeDrag.edge === "start" ? preview.startTime : preview.endTime;
    setAudioOverlayResizeDrag((prev) => (prev ? { ...prev, liveValue } : prev));
  };
  const endAudioOverlayResizeDrag = () => {
    if (!audioOverlayResizeDrag) return;
    const { id, edge, liveValue } = audioOverlayResizeDrag;
    setAudioOverlayResizeDrag(null);
    editStore.resizeAudioOverlayTime(id, edge, liveValue);
  };

  const beginAudioOverlayDrag = (overlay: AudioOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setAudioOverlayDrag({
      id: overlay.id,
      startClientX: e.clientX,
      startTime: overlay.startTime,
      duration: overlay.endTime - overlay.startTime,
      isDragging: false,
      liveStartTime: overlay.startTime,
    });
  };
  const handleAudioOverlayDragMove = (e: React.PointerEvent) => {
    if (!audioOverlayDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - audioOverlayDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const deltaSec = (e.clientX - audioOverlayDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(audioOverlayDrag.startTime + deltaSec, overlaySnapTargets, pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - audioOverlayDrag.duration));
    setAudioOverlayDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveStartTime } : prev));
  };
  const endAudioOverlayDrag = (e: React.PointerEvent) => {
    if (!audioOverlayDrag) return;
    const { id, isDragging, liveStartTime, duration } = audioOverlayDrag;
    setAudioOverlayDrag(null);
    if (isDragging) {
      editStore.moveAudioOverlayTime(id, liveStartTime);
    }
    selectAudioOverlay(id, e);
    // Same reasoning as endOverlayDrag/endImageOverlayDrag: bring the playhead along if it isn't
    // already inside the (possibly just-moved) overlay's own range, so selecting it from the
    // timeline is never visibly a no-op.
    if (currentOutputTime < liveStartTime || currentOutputTime >= liveStartTime + duration) {
      seekToOutputTime(liveStartTime);
    }
  };

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
    onSeek(renderClips[index].sourcePath, sourceTime);
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

  const beginResizeDrag = (clip: Clip, index: number, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedClipId(clip.id);
    const startValue = edge === "start" ? clip.start : clip.end;
    const oppositeBound = edge === "start" ? clip.end : clip.start;
    // This clip's *own* source file's duration - every clip can come from a different file, so
    // there's no single shared duration to clamp the end edge against anymore. Falls back to no
    // upper clamp if it isn't known yet (e.g. a just-dropped file whose ffprobe lookup is still
    // in flight) rather than blocking the drag.
    const maxEnd = editStore.getSourceDuration(clip.sourcePath) ?? Number.POSITIVE_INFINITY;
    // See resizeDrag's own doc comment on playheadSourceTime - this clip's own (pre-drag) output
    // range never moves as a result of trimming its OWN start/end (see outputStarts' own doc
    // comment: a clip's output position depends only on clips BEFORE it), so it's safe to read
    // straight off the ambient outputStarts/clipDurations here rather than re-deriving anything.
    const clipOutputStart = outputStarts[index];
    const clipOutputEnd = clipOutputStart + clipDurations[index];
    const playheadSourceTime =
      currentOutputTime >= clipOutputStart && currentOutputTime < clipOutputEnd ? clip.start + (currentOutputTime - clipOutputStart) : null;
    setResizeDrag({ id: clip.id, edge, startClientX: e.clientX, startValue, oppositeBound, maxEnd, liveValue: startValue, playheadSourceTime });
  };
  const handleResizeDragMove = (e: React.PointerEvent) => {
    if (!resizeDrag) return;
    e.stopPropagation();
    const deltaSec = (e.clientX - resizeDrag.startClientX) / pxPerSec;
    const raw =
      resizeDrag.playheadSourceTime != null
        ? snapToTargets(resizeDrag.startValue + deltaSec, [resizeDrag.playheadSourceTime], pxPerSec)
        : resizeDrag.startValue + deltaSec;
    const clamped =
      resizeDrag.edge === "start"
        ? Math.max(0, Math.min(raw, resizeDrag.oppositeBound - MIN_CLIP_LENGTH))
        : Math.min(resizeDrag.maxEnd, Math.max(raw, resizeDrag.oppositeBound + MIN_CLIP_LENGTH));
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
      onSeek(clip.sourcePath, clip.start);
    }
  };

  // Split/Delete always act on the clip currently under the *playhead* (activeClipIndexRef),
  // never on a bare time value searched across all clips - once clips can come from different
  // files, a raw source time alone is ambiguous (two clips from different files can easily share
  // overlapping ranges), so the caller has to say which clip it means.
  const handleSplit = () => {
    const idx = activeClipIndexRef.current;
    if (idx >= 0 && idx < baseClips.length) editStore.splitAt(idx, currentTime);
  };
  const handleDeleteSegment = () => {
    const selectedIndex = selectedClipId ? baseClips.findIndex((c) => c.id === selectedClipId) : -1;
    const index = selectedIndex !== -1 ? selectedIndex : activeClipIndexRef.current;
    if (index < 0 || index >= baseClips.length) return;
    editStore.deleteClipAt(index);
    if (selectedIndex !== -1) setSelectedClipId(null);
  };

  // Delete/Backspace deletes whatever is actually selected - a text overlay takes priority over a
  // clip (an overlay chip and a clip can't be selected at the same time in this UI, but if that
  // ever changed, the overlay is the more "local" selection). Deliberately does NOT fall back to
  // handleDeleteSegment's own "nothing selected -> delete the clip at the playhead" behavior the
  // toolbar button uses - that's fine for a deliberate button click, but a bare keypress with
  // nothing selected acting on whatever the playhead happens to be sitting on would be a surprising
  // way to lose a clip. Same target.tagName/isContentEditable guard Dashboard's own arrow-key
  // navigation effect uses, so this doesn't hijack Delete/Backspace while typing anywhere (renaming
  // a file, typing in a text overlay, etc).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

      // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redoes - the two conventional redo
      // bindings, kept both since Windows apps commonly use either. Checked ahead of Delete/
      // Backspace below since they share nothing (different key, mutually exclusive on any given
      // keydown) but both live in this one listener to avoid a second document-level effect doing
      // the same target-is-typing guard. Note TextNoteEditor's own textarea already
      // stopPropagation()s every keydown (see its onKeyDown) specifically so the browser's native
      // in-field undo isn't fought over by this listener - it never even sees those events.
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "z") {
        e.preventDefault();
        if (e.shiftKey) editStore.redo();
        else editStore.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === "y") {
        e.preventDefault();
        editStore.redo();
        return;
      }
      // Ctrl/Cmd+D duplicates whatever overlay is currently selected - same "text takes priority
      // over image" ordering as Delete/Backspace below, for the same reason (the two can't be
      // selected at once in this UI, but if that ever changed, the more "local" selection wins).
      // preventDefault() here also stops the browser's own Ctrl+D "bookmark this page" default.
      if ((e.ctrlKey || e.metaKey) && key === "d") {
        e.preventDefault();
        if (selectedOverlayId) {
          onSelectOverlay?.(editStore.duplicateTextOverlay(selectedOverlayId));
        } else if (selectedImageOverlayId) {
          onSelectImageOverlay?.(editStore.duplicateImageOverlay(selectedImageOverlayId));
        } else if (selectedBlurOverlayId) {
          onSelectBlurOverlay?.(editStore.duplicateBlurOverlay(selectedBlurOverlayId));
        } else if (selectedAudioOverlayId) {
          setSelectedAudioOverlayId(editStore.duplicateAudioOverlay(selectedAudioOverlayId));
          setAudioPopoverAnchor(null);
        }
        return;
      }

      if (e.key !== "Delete" && e.key !== "Backspace") return;

      if (selectedOverlayId) {
        e.preventDefault();
        editStore.deleteTextOverlay(selectedOverlayId);
        onSelectOverlay?.(null);
      } else if (selectedImageOverlayId) {
        e.preventDefault();
        editStore.deleteImageOverlay(selectedImageOverlayId);
        onSelectImageOverlay?.(null);
      } else if (selectedBlurOverlayId) {
        e.preventDefault();
        editStore.deleteBlurOverlay(selectedBlurOverlayId);
        onSelectBlurOverlay?.(null);
      } else if (selectedAudioOverlayId) {
        e.preventDefault();
        editStore.deleteAudioOverlay(selectedAudioOverlayId);
        setSelectedAudioOverlayId(null);
        setAudioPopoverAnchor(null);
      } else if (selectedClipId) {
        e.preventDefault();
        handleDeleteSegment();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOverlayId, selectedImageOverlayId, selectedBlurOverlayId, selectedAudioOverlayId, selectedClipId, editStore]);

  // Pressing Play after the sequence has already played through to the end needs to restart from
  // clip 0 - native <video> never auto-rewinds on .play() once it's reached "ended", it just sits
  // at the last frame, so without this a stalled-at-the-end timeline looked like Play did nothing
  // at all (because, from the player's point of view, it didn't - there was nowhere further to
  // play to). Only triggers right at the end of the *last* clip, so pausing partway through and
  // pressing Play again still resumes from wherever you paused instead of jumping back to 0.
  const handleTransportPlayClick = () => {
    const lastIndex = baseClips.length - 1;
    const last = baseClips[lastIndex];
    const atEnd = !!last && !isPlaying && activeClipIndexRef.current >= lastIndex && currentTime >= last.end - SEEK_TOLERANCE_SEC;
    if (atEnd) {
      const first = baseClips[0];
      activeClipIndexRef.current = 0;
      lastAppliedTimeRef.current = first.start;
      onSeek(first.sourcePath, first.start);
    }
    onTogglePlay();
  };

  const handleSave = async () => {
    const result = await editStore.exportEdited(videoPixelSize, { quality: exportQuality, outputPath: customOutputPath ?? undefined });
    if (result) onExported(result.path, result.name);
  };

  // Defaults the save dialog to exactly the same "<name> (edited).<ext>" filename
  // export_trimmed_video would otherwise pick on its own (see its own doc comment,
  // conversion.rs) - the user is choosing WHERE to put it, not renaming it.
  const handleChooseExportLocation = async () => {
    const stem = file.path.replace(/\.[^./\\]+$/, "").split(/[\\/]/).pop() ?? file.name;
    const ext = file.path.split(".").pop() ?? "mp4";
    const chosen = await saveFileDialog({ defaultPath: `${stem} (edited).${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (chosen) setCustomOutputPath(chosen);
  };

  // Scans the selected clip's own source file for dead air (detect_silence, conversion.rs), then
  // opens SilenceDetectionPopover to show what it found - nothing is actually cut until the user
  // clicks "Remove" there. Ranges come back in the SOURCE file's own absolute time (detect_silence
  // analyzes the whole file, not just this clip's trim window - see its own doc comment), so
  // trimSilenceForClip does its own intersection against the clip's current [start,end) rather than
  // trusting these as already scoped to it.
  const handleDetectSilence = async () => {
    if (!selectedClip) return;
    const rect = silenceButtonRef.current?.getBoundingClientRect();
    if (rect) setSilenceAnchor({ left: rect.left, top: rect.bottom + 4 });
    setSilenceState({ status: "loading" });
    try {
      const allRanges = await invoke<{ start: number; end: number }[]>("detect_silence", { inputPath: selectedClip.sourcePath });
      const withinClip = allRanges.filter((r) => r.end > selectedClip.start && r.start < selectedClip.end);
      setSilenceState(withinClip.length > 0 ? { status: "results", ranges: withinClip } : { status: "empty" });
    } catch (err) {
      setSilenceState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };
  const handleRemoveSilence = () => {
    if (!selectedClip || silenceState.status !== "results") return;
    editStore.trimSilenceForClip(selectedClip.id, silenceState.ranges);
    setSilenceAnchor(null);
  };

  // Drag-in: a file dropped on the track, from either the Briefcast sidebar (draggingLibraryFile,
  // native HTML5 onDrop right below - reliable here since this drag never leaves the webview) or
  // Explorer (pendingTimelineInsert, routed here by Dashboard once its cursor-position polling
  // confirms the drop landed on this track - see pendingTimelineInsert's own doc comment).
  const handleTrackDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault(); // required for onDrop to fire at all
  };
  const handleTrackDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (draggingLibraryFile) {
      void editStore.insertClipAt(draggingLibraryFile.path, computeOverIndex(e.clientX));
    }
  };

  useEffect(() => {
    if (!pendingTimelineInsert) return;
    const { paths, clientX } = pendingTimelineInsert;
    const index = computeOverIndex(clientX);
    (async () => {
      for (const path of paths) {
        // eslint-disable-next-line no-await-in-loop
        await editStore.insertClipAt(path, index);
      }
      onTimelineInsertHandled();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTimelineInsert]);

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
    onSeek(first.sourcePath, first.start);
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
    if (currentTime >= active.start - SEEK_TOLERANCE_SEC && currentTime < active.end + SEEK_TOLERANCE_SEC) return; // still inside it

    const nextIndex = activeIdx + 1;
    if (nextIndex < baseClips.length) {
      activeClipIndexRef.current = nextIndex;
      lastAppliedTimeRef.current = baseClips[nextIndex].start;
      onSeek(baseClips[nextIndex].sourcePath, baseClips[nextIndex].start);
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

  // Reliable fallback to dragging a clip in - a native file picker, unaffected by any of the
  // drag-and-drop fragility (in-page vs. cross-window, WebView2/Tauri interception, etc.) that
  // draggingLibraryFile/pendingTimelineInsert above have to work around. Inserts right after
  // whichever clip is currently under the playhead, same insertion point a drop at the playhead
  // would produce.
  const handleInsertClipViaPicker = async () => {
    setMenuOpen(false);
    const selected = await openFileDialog({ multiple: false, filters: [{ name: "Video", extensions: FILE_CATEGORY_EXTENSIONS.video }] });
    if (!selected || Array.isArray(selected)) return; // cancelled
    const insertIndex = Math.max(0, activeClipIndexRef.current + 1);
    await editStore.insertClipAt(selected, insertIndex);
  };

  // Playhead position on the (output/assembled) ruler - maps currentTime (a raw source
  // timestamp) via whichever clip is currently tracked as active (activeClipIndexRef, clamped
  // into range in case clips changed shape since it was last set). Also the "current output
  // time" text overlays are time-gated against - factored out under its own name (rather than
  // just feeding playheadLeft) so it can be reported upward via onOutputTimeChange too.
  const activeIndexForDisplay = Math.min(Math.max(activeClipIndexRef.current, 0), renderClips.length - 1);
  const currentOutputTime =
    renderClips.length > 0
      ? outputStarts[activeIndexForDisplay] +
        Math.max(0, Math.min(currentTime - renderClips[activeIndexForDisplay].start, clipDurations[activeIndexForDisplay]))
      : 0;
  const playheadLeft = currentOutputTime * pxPerSec;

  // Snap landmarks for every overlay drag/resize handler above (they're all defined earlier in
  // this component but close over this by reference, same forward-reference pattern
  // currentOutputTime's own consumers above already rely on) - the playhead plus every clip's own
  // boundary, deduped isn't needed since snapToTargets just takes whichever is nearest regardless
  // of duplicates.
  const overlaySnapTargets = [currentOutputTime, ...outputStarts, ...outputStarts.map((s, i) => s + clipDurations[i])];

  useEffect(() => {
    onOutputTimeChange?.(currentOutputTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOutputTime]);

  // Reports the ACTIVE clip's own color/Ken Burns fields upward - only recomputes when the active
  // clip's identity or its own effect fields actually change (not every tick, unlike
  // currentOutputTime above), since color/Ken Burns preview is driven off video.currentTime
  // directly by VideoPlayer's own rAF loop, not by React state per frame.
  const activeClip = renderClips[activeIndexForDisplay] as Clip | undefined;
  useEffect(() => {
    onActiveClipChange?.(
      activeClip
        ? {
            id: activeClip.id,
            sourceStart: activeClip.start,
            sourceEnd: activeClip.end,
            colorFilter: activeClip.colorFilter,
            kenBurns: activeClip.kenBurns,
            crop: activeClip.crop,
            flipHorizontal: activeClip.flipHorizontal,
          }
        : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClip?.id, activeClip?.start, activeClip?.end, activeClip?.colorFilter, activeClip?.kenBurns, activeClip?.crop, activeClip?.flipHorizontal]);

  // Keeps every audio overlay's hidden <audio> element in lockstep with the main player: paused
  // whenever the playhead is outside its own [startTime,endTime) range (overlaysActiveAt, same
  // gating text/image overlays already use for visibility), otherwise playing/paused to match
  // isPlaying with its own currentTime hard-set only on a real discontinuity (a scrub/seek, or
  // more than ~150ms of drift) - letting the browser's own playback clock advance it the rest of
  // the time avoids fighting/stuttering it every frame the way resetting currentTime continuously
  // would. Volume applies both the overlay's own level and a linear fade in/out envelope.
  useEffect(() => {
    const activeIds = new Set(overlaysActiveAt(editStore.audioOverlays, currentOutputTime).map((o) => o.id));
    editStore.audioOverlays.forEach((o) => {
      const audio = audioElementsRef.current.get(o.id);
      if (!audio) return;
      if (!activeIds.has(o.id)) {
        if (!audio.paused) audio.pause();
        return;
      }
      const desiredTime = o.trimStart + (currentOutputTime - o.startTime);
      if (Math.abs(audio.currentTime - desiredTime) > 0.15) audio.currentTime = desiredTime;
      if (isPlaying && audio.paused) {
        audio.play().catch((err) => console.error("Audio overlay failed to play:", o.src, err));
      }
      if (!isPlaying && !audio.paused) audio.pause();

      const fadeIn = o.fadeInSec ?? 0;
      const fadeOut = o.fadeOutSec ?? 0;
      let envelope = 1;
      if (fadeIn > 0) envelope = Math.min(envelope, (currentOutputTime - o.startTime) / fadeIn);
      if (fadeOut > 0) envelope = Math.min(envelope, (o.endTime - currentOutputTime) / fadeOut);
      audio.volume = o.muted ? 0 : o.volume * Math.max(0, Math.min(1, envelope));
    });
  }, [currentOutputTime, isPlaying, editStore.audioOverlays]);

  return (
    <div className="w-full flex flex-col gap-2">
      {/* Hidden capture rig - never shown, just decodes frames for the filmstrip/cover. */}
      <video ref={hiddenVideoRef} src={playableSrc} muted preload="metadata" style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
      <canvas ref={captureCanvasRef} style={{ display: "none" }} />
      {editStore.audioOverlays.map((o) => (
        <audio
          key={o.id}
          ref={(el) => {
            if (el) {
              audioElementsRef.current.set(o.id, el);
            } else {
              // Removing a playing <audio> element from the DOM does NOT stop it per the HTML
              // media spec - it keeps playing until garbage collected, which is not deterministic
              // and can easily be seconds later. Without this, deleting an audio overlay while
              // it's audibly playing left it audibly playing with no visible chip/UI left to
              // indicate anything was still running.
              audioElementsRef.current.get(o.id)?.pause();
              audioElementsRef.current.delete(o.id);
            }
          }}
          src={convertFileSrc(o.src)}
          preload="auto"
          onError={(e) => {
            const el = e.currentTarget;
            console.error("Audio overlay failed to load:", o.src, "mediaError:", el.error?.code, el.error?.message);
          }}
          style={{ display: "none" }}
        />
      ))}

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
          <ActionButton
            title={selectedClipId ? (isCroppingClip ? "Stop cropping" : "Crop clip") : "Select a clip to crop"}
            onClick={() => onToggleCroppingClip?.()}
            disabled={!selectedClipId}
          >
            <IoCropOutline size={15} className={isCroppingClip ? "text-blue-400" : undefined} />
          </ActionButton>
          <ActionButton
            title={selectedClipId ? "Mirror clip horizontally" : "Select a clip to mirror"}
            onClick={() => selectedClip && editStore.updateClipEffects(selectedClip.id, { flipHorizontal: !selectedClip.flipHorizontal })}
            disabled={!selectedClipId}
          >
            <MdFlip size={15} className={selectedClip?.flipHorizontal ? "text-blue-400" : undefined} />
          </ActionButton>
          <button
            ref={effectsButtonRef}
            type="button"
            title={selectedClipId ? "Clip effects" : "Select a clip to edit its effects"}
            disabled={!selectedClipId}
            onClick={() => {
              if (effectsPopoverAnchor) {
                setEffectsPopoverAnchor(null);
                return;
              }
              const rect = effectsButtonRef.current?.getBoundingClientRect();
              if (rect) setEffectsPopoverAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`flex items-center justify-center w-7 h-7 rounded transition-colors disabled:text-neutral-600 disabled:cursor-default ${
              effectsPopoverAnchor ? "bg-neutral-700 text-blue-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <IoSparklesOutline size={15} />
          </button>
          <button
            ref={silenceButtonRef}
            type="button"
            title={selectedClipId ? "Find and remove silent gaps in this clip" : "Select a clip to trim silence"}
            disabled={!selectedClipId}
            onClick={() => {
              if (silenceAnchor) {
                setSilenceAnchor(null);
                return;
              }
              void handleDetectSilence();
            }}
            className={`flex items-center justify-center w-7 h-7 rounded transition-colors disabled:text-neutral-600 disabled:cursor-default ${
              silenceAnchor ? "bg-neutral-700 text-blue-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <MdGraphicEq size={15} />
          </button>
          <ActionButton
            title={isPlacingText ? "Click the video preview to place text" : "Add text overlay"}
            onClick={() => onToggleArmPlaceText?.()}
          >
            <IoText size={15} className={isPlacingText ? "text-blue-400" : undefined} />
          </ActionButton>
          <ActionButton
            title={isPlacingImage ? "Choosing an image…" : "Add image overlay"}
            onClick={() => onToggleArmPlaceImage?.()}
          >
            <IoImageOutline size={15} className={isPlacingImage ? "text-amber-400" : undefined} />
          </ActionButton>
          <ActionButton
            title={isPlacingBlur ? "Click the video preview to place a blur region" : "Add blur region"}
            onClick={() => onToggleArmPlaceBlur?.()}
          >
            <MdBlurOn size={15} className={isPlacingBlur ? "text-sky-400" : undefined} />
          </ActionButton>
          <ActionButton
            title={isPlacingPip ? "Choosing a video file…" : "Add picture-in-picture video (e.g. a separately-recorded webcam)"}
            onClick={() => onToggleArmPlacePip?.()}
          >
            <MdPictureInPictureAlt size={15} className={isPlacingPip ? "text-fuchsia-400" : undefined} />
          </ActionButton>
          <ActionButton
            title={isPlacingAudio ? "Choosing an audio file…" : "Add audio overlay"}
            onClick={() => setIsPlacingAudio((v) => !v)}
          >
            <IoMusicalNotesOutline size={15} className={isPlacingAudio ? "text-teal-400" : undefined} />
          </ActionButton>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center">
            <button
              type="button"
              title={editStore.exportError ?? "Save the trimmed/cut/reordered result as a new file - the original is never modified"}
              onClick={handleSave}
              disabled={!editStore.canUndo || editStore.isExporting}
              className="flex items-center gap-1.5 h-7 pl-2.5 pr-2 rounded-l text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-400 disabled:cursor-default"
            >
              <IoSaveOutline size={14} />
              {editStore.isExporting
                ? editStore.exportProgress != null
                  ? `Saving… ${Math.round(editStore.exportProgress)}%`
                  : "Saving…"
                : "Save"}
            </button>
            <button
              ref={exportOptionsButtonRef}
              type="button"
              title="Export options (quality, destination)"
              disabled={!editStore.canUndo || editStore.isExporting}
              onClick={() => {
                if (exportOptionsAnchor) {
                  setExportOptionsAnchor(null);
                  return;
                }
                const rect = exportOptionsButtonRef.current?.getBoundingClientRect();
                if (rect) setExportOptionsAnchor({ left: rect.left, top: rect.bottom + 4 });
              }}
              className="flex items-center justify-center h-7 w-5 rounded-r border-l border-blue-500/50 bg-blue-600 text-white hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-400 disabled:border-neutral-600 disabled:cursor-default"
            >
              <IoChevronDown size={10} />
            </button>
          </div>
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

      {/* Save failures previously only showed up as the Save button's hover tooltip, easy to miss
          entirely without devtools open - surfaced here so the actual ffmpeg/IO error is visible
          at a glance. */}
      {editStore.exportError && (
        <div className="px-2 py-1.5 rounded-md bg-red-950/60 border border-red-800 text-red-300 text-xs break-words">
          Save failed: {editStore.exportError}
        </div>
      )}

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
            title="Track volume/mute"
            onClick={(e) => {
              // Always (re)opens rather than toggling - closing is the outside-pointerdown effect's
              // job alone (see trackAudioPopoverAnchor's own effect above). A toggle here would race
              // it: pointerdown fires (and could close it) before this click handler runs, so a
              // toggle keyed off the pre-click state could immediately reopen what the same press
              // had just closed - same reasoning AudioOverlayPopover/AnimationPicker's own triggers
              // already settled on elsewhere in this codebase.
              const rect = e.currentTarget.getBoundingClientRect();
              setTrackAudioPopoverAnchor({ left: rect.right + 8, top: rect.top - 4 });
            }}
            className={editStore.videoAudioMuted ? "text-red-400 hover:text-red-300" : "text-neutral-400 hover:text-neutral-200"}
          >
            {editStore.videoAudioMuted ? <IoVolumeMuteOutline size={15} /> : <IoVolumeHighOutline size={15} />}
          </button>
          <button
            type="button"
            title={isPlaying ? "Pause" : "Play"}
            onClick={handleTransportPlayClick}
            className="text-neutral-400 hover:text-neutral-200"
          >
            {isPlaying ? <IoPause size={15} /> : <IoPlay size={15} />}
          </button>
          <div className="relative">
            <button
              ref={moreMenuButtonRef}
              type="button"
              title="More"
              onClick={() => {
                if (menuOpen) {
                  setMenuOpen(false);
                  return;
                }
                const rect = moreMenuButtonRef.current?.getBoundingClientRect();
                if (rect) setMoreMenuPosition({ top: rect.top, left: rect.right + 4 });
                setMenuOpen(true);
              }}
              className="text-neutral-400 hover:text-neutral-200"
            >
              <IoEllipsisHorizontal size={15} />
            </button>
            {menuOpen &&
              moreMenuPosition &&
              createPortal(
                <>
                  {/* Full-viewport backdrop, behind the menu, just to catch outside clicks. */}
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  {/* text-neutral-200 set explicitly (not just inherited, unlike before this was
                      a portal) - document.body, where this now renders, is outside the Timeline
                      panel's own text-neutral-200 ancestor, so without this the menu items fell
                      back to the page's default (invisible-on-dark) text color. */}
                  <div
                    className="fixed w-44 bg-neutral-800 border border-neutral-700 rounded-md shadow-lg z-50 text-sm text-neutral-200"
                    style={{ top: moreMenuPosition.top, left: moreMenuPosition.left }}
                  >
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
                        void handleInsertClipViaPicker();
                      }}
                    >
                      <IoAddCircleOutline size={13} /> Insert clip…
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
                </>,
                document.body
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

            {/* Track - data-timeline-track marks this as the drop target Dashboard looks for via
                document.elementFromPoint when routing an external (Explorer) file drop; see
                pendingTimelineInsert's doc comment above. */}
            <div
              data-timeline-track="true"
              className={`h-16 relative py-1 cursor-pointer ${draggingLibraryFile ? "bg-blue-500/10 outline-dashed outline-2 outline-blue-400 -outline-offset-2" : ""}`}
              onPointerDown={handleScrubPointerDown}
              onPointerMove={handleScrubPointerMove}
              onDragOver={handleTrackDragOver}
              onDrop={handleTrackDrop}
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
                    onPointerCancel={endClipDrag}
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
                    {!isPending && (
                      <ClipWaveform
                        sourcePath={clip.sourcePath}
                        trimStart={clip.start}
                        trimEnd={clip.end}
                        sourceDuration={editStore.getSourceDuration(clip.sourcePath)}
                        widthPx={width}
                        heightPx={20}
                      />
                    )}
                  </div>
                );
              })}

              {/* Transition markers - purely decorative (not interactive; edit the transition
                  itself via the selected clip's Effects popover), at each boundary where the clip
                  on the RIGHT has transitionIn set. Communicates the documented preview-vs-export
                  gap (see ClipTransitionIn's own doc comment): live preview shows a hard cut here
                  regardless of which transition style is picked - the real transition only
                  renders in the exported file. */}
              {renderClips.map((clip, i) => {
                if (i === 0 || clip.id === "__pending__" || !clip.transitionIn) return null;
                const left = outputStarts[i] * pxPerSec;
                return (
                  <div
                    key={`transition-${clip.id}`}
                    title={`${TRANSITION_PRESETS.find((p) => p.value === clip.transitionIn?.type)?.label ?? "Transition"} (preview shows a hard cut; export renders the real transition)`}
                    className="absolute inset-y-1 w-4 -ml-2 flex items-center justify-center rounded bg-blue-500/80 z-10 pointer-events-none"
                    style={{ left }}
                  >
                    <IoSwapHorizontalOutline size={10} className="text-white" />
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
                      onPointerDown={beginResizeDrag(baseClips[i], i, "start")}
                      onPointerMove={handleResizeDragMove}
                      onPointerUp={endResizeDrag}
                      onPointerCancel={endResizeDrag}
                      title="Drag to trim this clip's start"
                      className="absolute inset-y-1 w-2 -ml-1 bg-teal-400 hover:bg-teal-300 rounded cursor-ew-resize z-10"
                      style={{ left }}
                    />
                    <div
                      onPointerDown={beginResizeDrag(baseClips[i], i, "end")}
                      onPointerMove={handleResizeDragMove}
                      onPointerUp={endResizeDrag}
                      onPointerCancel={endResizeDrag}
                      title="Drag to trim this clip's end"
                      className="absolute inset-y-1 w-2 -ml-1 bg-teal-400 hover:bg-teal-300 rounded cursor-ew-resize z-10"
                      style={{ left: left + width }}
                    />
                  </React.Fragment>
                );
              })}
            </div>

            {/* Text-overlay lane - chips positioned/sized by time (not source-time, since
                overlays have no source file of their own), sharing the same pxPerSec scale as
                the clip track above. Whole-chip drag retimes both edges together (moveTextOverlayTime);
                the two edge handles retime just one side (resizeTextOverlayTime) - same
                move-vs-resize split as the clip track, adapted from beginClipDrag/beginResizeDrag. */}
            <div className="h-8 relative border-t border-neutral-800">
              {renderOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = Math.max(1, (overlay.endTime - overlay.startTime) * pxPerSec);
                const isSelected = selectedOverlayId === overlay.id;
                return (
                  <div
                    key={overlay.id}
                    onPointerDown={beginOverlayDrag(overlay)}
                    onPointerMove={handleOverlayDragMove}
                    onPointerUp={endOverlayDrag}
                    onPointerCancel={endOverlayDrag}
                    title={overlay.text || "Text overlay"}
                    className={`absolute inset-y-1 rounded overflow-hidden border-2 bg-neutral-800 flex items-center px-2 text-[11px] text-white truncate cursor-grab active:cursor-grabbing ${
                      isSelected ? "border-dashed border-white" : "border-purple-400"
                    }`}
                    style={{ left, width }}
                  >
                    {overlay.text || "Text"}
                  </div>
                );
              })}
              {renderOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = (overlay.endTime - overlay.startTime) * pxPerSec;
                return (
                  <React.Fragment key={`overlay-resize-${overlay.id}`}>
                    <div
                      onPointerDown={beginOverlayResizeDrag(overlay, "start")}
                      onPointerMove={handleOverlayResizeDragMove}
                      onPointerUp={endOverlayResizeDrag}
                      onPointerCancel={endOverlayResizeDrag}
                      title="Drag to retime this overlay's start"
                      className="absolute inset-y-1 w-2 -ml-1 bg-purple-400 hover:bg-purple-300 rounded cursor-ew-resize z-10"
                      style={{ left }}
                    />
                    <div
                      onPointerDown={beginOverlayResizeDrag(overlay, "end")}
                      onPointerMove={handleOverlayResizeDragMove}
                      onPointerUp={endOverlayResizeDrag}
                      onPointerCancel={endOverlayResizeDrag}
                      title="Drag to retime this overlay's end"
                      className="absolute inset-y-1 w-2 -ml-1 bg-purple-400 hover:bg-purple-300 rounded cursor-ew-resize z-10"
                      style={{ left: left + width }}
                    />
                  </React.Fragment>
                );
              })}
            </div>

            {/* Image-overlay lane - same time-based chip/drag/resize pattern as the text-overlay
                lane above, just amber instead of purple and with no editable text to show. */}
            <div className="h-8 relative border-t border-neutral-800">
              {renderImageOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = Math.max(1, (overlay.endTime - overlay.startTime) * pxPerSec);
                const isSelected = selectedImageOverlayId === overlay.id;
                const fileName = overlay.src.split(/[\\/]/).pop() ?? overlay.src;
                return (
                  <div
                    key={overlay.id}
                    onPointerDown={beginImageOverlayDrag(overlay)}
                    onPointerMove={handleImageOverlayDragMove}
                    onPointerUp={endImageOverlayDrag}
                    onPointerCancel={endImageOverlayDrag}
                    title={fileName}
                    className={`absolute inset-y-1 rounded overflow-hidden border-2 bg-neutral-800 flex items-center gap-1 px-2 text-[11px] text-white truncate cursor-grab active:cursor-grabbing ${
                      isSelected ? "border-dashed border-white" : "border-amber-400"
                    }`}
                    style={{ left, width }}
                  >
                    <IoImageOutline size={11} className="shrink-0" />
                    {fileName}
                  </div>
                );
              })}
              {renderImageOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = (overlay.endTime - overlay.startTime) * pxPerSec;
                return (
                  <React.Fragment key={`image-overlay-resize-${overlay.id}`}>
                    <div
                      onPointerDown={beginImageOverlayResizeDrag(overlay, "start")}
                      onPointerMove={handleImageOverlayResizeDragMove}
                      onPointerUp={endImageOverlayResizeDrag}
                      onPointerCancel={endImageOverlayResizeDrag}
                      title="Drag to retime this image's start"
                      className="absolute inset-y-1 w-2 -ml-1 bg-amber-400 hover:bg-amber-300 rounded cursor-ew-resize z-10"
                      style={{ left }}
                    />
                    <div
                      onPointerDown={beginImageOverlayResizeDrag(overlay, "end")}
                      onPointerMove={handleImageOverlayResizeDragMove}
                      onPointerUp={endImageOverlayResizeDrag}
                      onPointerCancel={endImageOverlayResizeDrag}
                      title="Drag to retime this image's end"
                      className="absolute inset-y-1 w-2 -ml-1 bg-amber-400 hover:bg-amber-300 rounded cursor-ew-resize z-10"
                      style={{ left: left + width }}
                    />
                  </React.Fragment>
                );
              })}
            </div>

            {/* Blur-overlay lane - same time-based chip/drag/resize pattern as the text/image
                lanes above, sky-blue instead of purple/amber and with no filename/text to show. */}
            <div className="h-8 relative border-t border-neutral-800">
              {renderBlurOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = Math.max(1, (overlay.endTime - overlay.startTime) * pxPerSec);
                const isSelected = selectedBlurOverlayId === overlay.id;
                return (
                  <div
                    key={overlay.id}
                    onPointerDown={beginBlurOverlayDrag(overlay)}
                    onPointerMove={handleBlurOverlayDragMove}
                    onPointerUp={endBlurOverlayDrag}
                    onPointerCancel={endBlurOverlayDrag}
                    title="Blur region"
                    className={`absolute inset-y-1 rounded overflow-hidden border-2 bg-neutral-800 flex items-center gap-1 px-2 text-[11px] text-white truncate cursor-grab active:cursor-grabbing ${
                      isSelected ? "border-dashed border-white" : "border-sky-400"
                    }`}
                    style={{ left, width }}
                  >
                    <MdBlurOn size={12} className="shrink-0" />
                    Blur
                  </div>
                );
              })}
              {renderBlurOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = (overlay.endTime - overlay.startTime) * pxPerSec;
                return (
                  <React.Fragment key={`blur-overlay-resize-${overlay.id}`}>
                    <div
                      onPointerDown={beginBlurOverlayResizeDrag(overlay, "start")}
                      onPointerMove={handleBlurOverlayResizeDragMove}
                      onPointerUp={endBlurOverlayResizeDrag}
                      onPointerCancel={endBlurOverlayResizeDrag}
                      title="Drag to retime this blur region's start"
                      className="absolute inset-y-1 w-2 -ml-1 bg-sky-400 hover:bg-sky-300 rounded cursor-ew-resize z-10"
                      style={{ left }}
                    />
                    <div
                      onPointerDown={beginBlurOverlayResizeDrag(overlay, "end")}
                      onPointerMove={handleBlurOverlayResizeDragMove}
                      onPointerUp={endBlurOverlayResizeDrag}
                      onPointerCancel={endBlurOverlayResizeDrag}
                      title="Drag to retime this blur region's end"
                      className="absolute inset-y-1 w-2 -ml-1 bg-sky-400 hover:bg-sky-300 rounded cursor-ew-resize z-10"
                      style={{ left: left + width }}
                    />
                  </React.Fragment>
                );
              })}
            </div>

            {/* PiP-overlay lane - same time-based chip/drag pattern as the blur lane above (fuchsia
                instead of sky-blue), with edge handles that trim into the source (resizePipOverlayTime)
                instead of just retiming an empty box, matching the audio lane's own resize style.
                This is the ONLY way to see/reach a PiP layer once the playhead scrubs outside its
                own time range - clicking or dragging a chip brings the playhead back into view
                (endPipOverlayDrag), since PipOverlayLayer only renders a PiP's actual video bubble
                while the playhead is inside that range. */}
            <div className="h-8 relative border-t border-neutral-800">
              {renderPipOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = Math.max(1, (overlay.endTime - overlay.startTime) * pxPerSec);
                const isSelected = selectedPipOverlayId === overlay.id;
                return (
                  <div
                    key={overlay.id}
                    onPointerDown={beginPipOverlayDrag(overlay)}
                    onPointerMove={handlePipOverlayDragMove}
                    onPointerUp={endPipOverlayDrag}
                    onPointerCancel={endPipOverlayDrag}
                    title="Picture-in-picture - click to jump the playhead here"
                    className={`absolute inset-y-1 rounded overflow-hidden border-2 bg-neutral-800 flex items-center justify-between gap-1 px-2 text-[11px] text-white cursor-grab active:cursor-grabbing ${
                      isSelected ? "border-dashed border-white" : "border-fuchsia-400"
                    }`}
                    style={{ left, width }}
                  >
                    <span className="flex items-center gap-1 min-w-0 truncate">
                      <MdPictureInPictureAlt size={12} className="shrink-0" />
                      PiP
                    </span>
                    <button
                      type="button"
                      title="Delete this PiP layer"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        editStore.deletePipOverlay(overlay.id);
                        if (selectedPipOverlayId === overlay.id) onSelectPipOverlay?.(null);
                      }}
                      className="shrink-0 p-0.5 rounded hover:bg-white/20 text-white/70 hover:text-white"
                    >
                      <IoTrashOutline size={11} />
                    </button>
                  </div>
                );
              })}
              {renderPipOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = (overlay.endTime - overlay.startTime) * pxPerSec;
                return (
                  <React.Fragment key={`pip-overlay-resize-${overlay.id}`}>
                    <div
                      onPointerDown={beginPipOverlayResizeDrag(overlay, "start")}
                      onPointerMove={handlePipOverlayResizeDragMove}
                      onPointerUp={endPipOverlayResizeDrag}
                      onPointerCancel={endPipOverlayResizeDrag}
                      title="Drag to trim this PiP's start"
                      className="absolute inset-y-1 w-2 -ml-1 bg-fuchsia-400 hover:bg-fuchsia-300 rounded cursor-ew-resize z-10"
                      style={{ left }}
                    />
                    <div
                      onPointerDown={beginPipOverlayResizeDrag(overlay, "end")}
                      onPointerMove={handlePipOverlayResizeDragMove}
                      onPointerUp={endPipOverlayResizeDrag}
                      onPointerCancel={endPipOverlayResizeDrag}
                      title="Drag to trim this PiP's end"
                      className="absolute inset-y-1 w-2 -ml-1 bg-fuchsia-400 hover:bg-fuchsia-300 rounded cursor-ew-resize z-10"
                      style={{ left: left + width }}
                    />
                  </React.Fragment>
                );
              })}
            </div>

            {/* Audio-overlay lane - same time-based chip pattern as the text/image lanes above,
                teal instead of purple/amber, with a real waveform instead of an icon+filename and
                edge handles that trim into the source (resizeAudioOverlayTime) instead of just
                retiming an empty box. */}
            <div className="h-8 relative border-t border-neutral-800">
              {renderAudioOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = Math.max(1, (overlay.endTime - overlay.startTime) * pxPerSec);
                const isSelected = selectedAudioOverlayId === overlay.id;
                const fileName = overlay.src.split(/[\\/]/).pop() ?? overlay.src;
                return (
                  <div
                    key={overlay.id}
                    onPointerDown={beginAudioOverlayDrag(overlay)}
                    onPointerMove={handleAudioOverlayDragMove}
                    onPointerUp={endAudioOverlayDrag}
                    onPointerCancel={endAudioOverlayDrag}
                    title={fileName}
                    className={`absolute inset-y-1 rounded overflow-hidden border-2 bg-neutral-800 cursor-grab active:cursor-grabbing ${
                      isSelected ? "border-dashed border-white" : "border-teal-400"
                    } ${overlay.muted ? "opacity-50" : ""}`}
                    style={{ left, width }}
                  >
                    <AudioChipWaveform overlay={overlay} widthPx={width} heightPx={28} />
                  </div>
                );
              })}
              {renderAudioOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = (overlay.endTime - overlay.startTime) * pxPerSec;
                return (
                  <React.Fragment key={`audio-overlay-resize-${overlay.id}`}>
                    <div
                      onPointerDown={beginAudioOverlayResizeDrag(overlay, "start")}
                      onPointerMove={handleAudioOverlayResizeDragMove}
                      onPointerUp={endAudioOverlayResizeDrag}
                      onPointerCancel={endAudioOverlayResizeDrag}
                      title="Drag to trim this audio's start"
                      className="absolute inset-y-1 w-2 -ml-1 bg-teal-400 hover:bg-teal-300 rounded cursor-ew-resize z-10"
                      style={{ left }}
                    />
                    <div
                      onPointerDown={beginAudioOverlayResizeDrag(overlay, "end")}
                      onPointerMove={handleAudioOverlayResizeDragMove}
                      onPointerUp={endAudioOverlayResizeDrag}
                      onPointerCancel={endAudioOverlayResizeDrag}
                      title="Drag to trim this audio's end"
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

      {exportOptionsAnchor && (
        <ExportOptionsPopover
          anchor={exportOptionsAnchor}
          quality={exportQuality}
          onQualityChange={setExportQuality}
          customOutputName={customOutputPath ? customOutputPath.split(/[\\/]/).pop() ?? customOutputPath : null}
          onChooseLocation={handleChooseExportLocation}
          onResetLocation={() => setCustomOutputPath(null)}
          onClose={() => setExportOptionsAnchor(null)}
        />
      )}

      {silenceAnchor && (
        <SilenceDetectionPopover anchor={silenceAnchor} state={silenceState} onRemove={handleRemoveSilence} onClose={() => setSilenceAnchor(null)} />
      )}

      {selectedClipId &&
        effectsPopoverAnchor &&
        (() => {
          const clipIndex = editStore.clips.findIndex((c) => c.id === selectedClipId);
          const clip = editStore.clips[clipIndex];
          if (!clip) return null;
          return (
            <ClipEffectsPopover
              clip={clip}
              hasPrecedingClip={clipIndex > 0}
              anchor={effectsPopoverAnchor}
              onUpdate={(patch) => editStore.updateClipEffects(clip.id, patch)}
              onClose={() => setEffectsPopoverAnchor(null)}
              isCropping={isCroppingClip}
              onToggleCropping={() => onToggleCroppingClip?.()}
            />
          );
        })()}

      {selectedAudioOverlayId &&
        audioPopoverAnchor &&
        (() => {
          const overlay = editStore.audioOverlays.find((o) => o.id === selectedAudioOverlayId);
          if (!overlay) return null;
          return (
            <AudioOverlayPopover
              overlay={overlay}
              anchor={audioPopoverAnchor}
              onUpdate={(patch) => editStore.updateAudioOverlayContent(overlay.id, patch)}
              onDuplicate={() => {
                setSelectedAudioOverlayId(editStore.duplicateAudioOverlay(overlay.id));
                setAudioPopoverAnchor(null);
              }}
              onDelete={() => {
                editStore.deleteAudioOverlay(overlay.id);
                setSelectedAudioOverlayId(null);
                setAudioPopoverAnchor(null);
              }}
              onClose={() => setAudioPopoverAnchor(null)}
            />
          );
        })()}

      {/* The main video's own audio level - see videoEditTypes.ts's videoAudioMuted/videoAudioVolume
          doc comment for why this is a separate control from any AudioOverlay's own volume/mute.
          Inlined here (not its own component file) since it's only two controls, unlike
          AudioOverlayPopover's fuller set (fades, duplicate, delete). */}
      {trackAudioPopoverAnchor && (
        <TrackAudioPopover
          anchor={trackAudioPopoverAnchor}
          volume={editStore.videoAudioVolume}
          muted={editStore.videoAudioMuted}
          onSetVolume={editStore.setVideoAudioVolume}
          onSetMuted={editStore.setVideoAudioMuted}
        />
      )}
    </div>
  );
};

export default VideoTimelineDocker;
