// components/docker/VideoTimelineDocker.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeReframe, anchorKnots } from "../../utils/reframeAnalysis";
import { fillWindow } from "../../utils/reframeTrack";
import type { ReframePreview } from "../video/ReframePreviewLayer";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { BsCursor } from "react-icons/bs";
import { MdBlurOn, MdClosedCaptionOff, MdFlip, MdGraphicEq, MdOutlineNoiseControlOff, MdPictureInPictureAlt, MdViewQuilt, MdFlashOn, MdTune, MdVideoLibrary } from "react-icons/md";
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
  IoFolderOutline,
  IoSwapHorizontalOutline,
  IoSwapHorizontal,
  IoChevronDown,
  IoSaveOutline,
  IoPlay,
  IoPause,
  IoAddCircleOutline,
  IoImageOutline,
  IoShapesOutline,
  IoLocateOutline,
  IoSpeedometerOutline,
  IoSyncOutline,
  IoDownloadOutline,
  IoDocumentTextOutline,
  IoPhonePortraitOutline,
} from "react-icons/io5";
import { openPhoneTransfer } from "../../services/phoneTransfer";
import { DockerFile } from "./FileToolsDocker";
import { ExportQuality, MIN_AUDIO_START_ROOM_SEC, UseVideoEditStoreResult } from "../../hooks/useVideoEditStore";
import { AdjustmentLayer, AudioOverlay, BlurOverlay, Clip, IMAGE_CLIP_EXTENSIONS, ImageOverlay, PipOverlay, TextOverlay, hasAudioCleanup, isImageClipPath, isVideoProjectPath } from "../../utils/videoEditTypes";
import { FILE_CATEGORY_EXTENSIONS, MEDIA_VIDEO_EXTENSIONS } from "../../utils/fileCategory";
import { getWaveformPeaks, sliceWaveformWindow } from "../../utils/audioWaveform";
import { buildViewSwitchOverlays, mergeClipsInPlace, overlaysActiveAt, packAudioRows, resizeAudioOverlayTime as resizeAudioOverlayTimeHandler, resizePipOverlayTime as resizePipOverlayTimeHandler } from "../../handlers/videoEditHandlers";
import type { ViewSwitchEvent } from "../../handlers/videoEditHandlers";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import ElementsGallery from "../video/ElementsGallery";
import SplitScreenPanel from "../video/SplitScreenPanel";
import HighlightIntroPanel from "../video/HighlightIntroPanel";
import ShortsStudio from "../shorts/ShortsStudio";
import { assetEntry, makeAsset } from "../../utils/videoAssets";
import AudioOverlayPopover from "./AudioOverlayPopover";
import MusicLibraryPanel from "./MusicLibraryPanel";
import { libraryInfoOf, restoreMusicTrack, VideoContext } from "../../utils/musicLibrary";
import { BUILTIN_SFX_TRACKS, TRANSITION_SOUNDS, builtinSfxFile } from "../../utils/builtinSfx";
import { computeSpeechTimeline, DEFAULT_DUCK_LEVEL, duckGainAt, isDucked, isSpeechOverlay, TimeRange } from "../../utils/musicDucking";
import ClipEffectsPopover, { DEFAULT_COLOR_INTENSITY, DEFAULT_KEN_BURNS_INTENSITY, DEFAULT_TRANSITION_DURATION } from "./ClipEffectsPopover";
import ClipContextMenu, { ClipMoveTarget } from "./ClipContextMenu";
import MoveCopyMenu, { FileTransferOptions } from "./MoveCopyMenu";
import ClipViewerModal from "./ClipViewerModal";
import { beatOutputTimes } from "../../utils/beatSync";
import { clipOutputDuration, outputOffsetToSource, sourceToOutputOffset } from "../../utils/clipTiming";
import TranscriptEditorPanel from "./TranscriptEditorPanel";
import { transitionDuration } from "../video/TransitionPreviewLayer";
import SpeedPopover from "./SpeedPopover";
import NoiseReductionPopover from "./NoiseReductionPopover";
import ExtractAudioPopover, { DetachMode, SeparationEngineStatus } from "./ExtractAudioPopover";
import ExportOptionsPopover, { EXPORT_FORMATS, ExportFormat, ExportFraming } from "./ExportOptionsPopover";
import SilenceDetectionPopover, { SilenceDetectionState } from "./SilenceDetectionPopover";
import AutoZoomPopover, { AutoZoomState } from "./AutoZoomPopover";
import ViewSwitchPopover, { ViewSwitchDetectState } from "./ViewSwitchPopover";
import ToolModePopover, { TimelineToolMode } from "./ToolModePopover";
import { useToolPanelHost } from "./ToolPanelHost";
import CaptionsPanel from "./CaptionsPanel";
import ChaptersPanel from "./ChaptersPanel";
import ScreenStylePanel from "./ScreenStylePanel";
import { MdOutlineWallpaper } from "react-icons/md";
import { useClipRecordings } from "../../hooks/useClipRecordings";
import { hasPointerPath, pointerStyleOf } from "../../utils/pointerTrack";
import { buildKeyChips, keystrokeStyleOf } from "../../utils/keystrokes";
import { enqueue as enqueueExport } from "../../utils/exportQueue";
import { copyItems, emptyClipboardItems } from "../../utils/timelineClipboard";
import { outputChapters } from "../../utils/videoChapters";
import { IoBookmarkOutline, IoColorFilterOutline, IoPersonCircleOutline, IoSparkles } from "react-icons/io5";
import { buildCaptionLines } from "../../utils/captions";
import { ActiveClipEffects, ClipEffectBadge, TRANSITION_PRESETS, clipEffectBadges } from "../../utils/videoColorFilters";
import { GRADE_LOOKS } from "../../utils/gradeLooks";
import { CLIP_FX } from "../../utils/clipFx";

// Clip effect badges (clipEffectBadges), coloured by kind.
const BADGE_TONES: Record<ClipEffectBadge["tone"], string> = {
  look: "bg-amber-400/90 text-black",
  fx: "bg-fuchsia-500/90 text-white",
  motion: "bg-sky-500/90 text-white",
  time: "bg-orange-500/90 text-white",
  frame: "bg-black/75 text-teal-300",
  sound: "bg-red-600/90 text-white",
};
import ToolSearch from "./ToolSearch";
import MixerPanel, { type MixerChannel } from "./MixerPanel";
import { audioChannelKey, audioChannelName, fileStem, isNeutralFx } from "../../utils/audioFx";

// A video-track layer covering the whole frame - B-roll rather than a picture-in-picture.
const isFullFrameLayer = (o: PipOverlay) => o.x <= 0.001 && o.y <= 0.001 && o.width >= 0.999 && o.height >= 0.999;
import { resumeMixer, syncElementFx } from "../../utils/mixerGraph";
import { VIDEO_CHANNEL, getMixerSession, pipChannelKey, silencedBySolo, useMixerSession } from "../../utils/mixerState";
import { isTrackHidden, pipTrack, tracksInUse, videoTrackLabel } from "../../utils/videoTracks";
import { subscribeVideoFrames } from "../../utils/videoFrameCache";
import { getPlayableUrl, isPictureless } from "../../utils/playableVideo";
import useCanvasRestoreTick from "../../hooks/useCanvasRestoreTick";

const MIN_PX_PER_SEC = 8;
const AUDIO_ROW_HEIGHT = 32; // px - one row of the audio lane; overlapping audio stacks into more rows
const MAX_PX_PER_SEC = 200;
const DEFAULT_PX_PER_SEC = 40;
const THUMB_TILE_HEIGHT = 52; // px - filmstrip tile height inside the h-16 clip track
// Filmstrip frame cache density: one captured frame every FRAME_CACHE_STEP_SEC of source time,
// capped at MAX_CACHED_FRAMES (the step widens for long videos). Tiles pick their nearest cached
// frame, so this is what bounds how short a shot can be and still show up on the strip.
const FRAME_CACHE_STEP_SEC = 0.5;
const MAX_CACHED_FRAMES = 360;
const THUMB_CAPTURE_HEIGHT = 90; // px - frames are downscaled at capture; tiles never draw larger

// Nearest cached frame to `time` (frames sorted by time), or null if none captured yet.
const nearestFrame = (frames: ThumbFrame[], time: number): ThumbFrame | null => {
  if (frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(frames[lo - 1].time - time) <= Math.abs(frames[lo].time - time)) return frames[lo - 1];
  return frames[lo];
};
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
// How close to a clip's end playback counts as having finished it - a little under a frame, so a
// file whose real length rounds a hair short of the clip's stored end still moves on.
const CLIP_END_EPSILON_SEC = 0.05;
// The per-frame boundary check crosses within half a frame of the cut.
const FRAME_BOUNDARY_SEC = 0.012;
// How far an audio overlay may drift from the picture while playing before it's re-seeked.
const AUDIO_DRIFT_TOLERANCE_SEC = 0.3;
// After re-seeking an audio overlay, how long to let it rebuffer before judging its drift again -
// and the jump (a scrub, not drift) that's corrected even inside that window.
const AUDIO_SEEK_SETTLE_MS = 1000;
const AUDIO_JUMP_SEC = 1;

// Module-level (not a useRef) so it survives this component unmounting - which happens every time
// the tools/timeline panel is closed (BottomDocker swaps back to the recording docker) and
// reopened, not just when a different file is opened. A useRef here was the original bug: it
// reset to null on every one of those remounts, so the bootstrap effect below saw "never
// bootstrapped" and force-seeked back to clip 0 every single time the panel was reopened, even on
// a video that was already mid-playback - the "opening the timeline restarts the video" report.
// Keyed by file path so switching files still bootstraps normally; a small, session-lifetime
// cache (a few bytes per file ever opened) is an acceptable tradeoff for not needing to lift this
// state through Dashboard/BottomDocker just to keep it alive across the panel toggle.
const bootstrappedClipIdByFile = new Map<string, string>();
// Called whenever a file is (re)opened for playback: the player starts over on the file's own
// picture (a project's blank canvas), so "already playing from its first clip" no longer holds and
// the timeline must put playback on the first clip again when it next mounts. Without this, a
// project opened a second time in a session played its black canvas under a full timeline.
export const forgetTimelineBootstrap = (path: string): void => {
  bootstrappedClipIdByFile.delete(path);
};

const formatTimestamp = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

type StoreClipPatch = Parameters<UseVideoEditStoreResult["updateClipEffects"]>[1];

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
    className="shrink-0 flex items-center justify-center w-7 h-7 rounded text-neutral-300 hover:bg-neutral-700 disabled:text-neutral-600 disabled:hover:bg-transparent disabled:cursor-default"
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
  const canvasRestoreTick = useCanvasRestoreTick();

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
    // canvasRestoreTick: a pure redraw trigger, see useCanvasRestoreTick.
  }, [peaks, widthPx, heightPx, overlay.trimStart, overlay.startTime, overlay.endTime, overlay.sourceDuration, canvasRestoreTick]);

  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" style={{ width: widthPx, height: heightPx }} />;
};

const IMAGE_CLIP_TOOL_HINT = "Not available for image clips";

// The classic spoked "wheel" activity indicator - 12 spokes fading round the circle, spun fast.
const SpokeWheel: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin text-white" style={{ animationDuration: "0.5s" }} aria-hidden>
    {Array.from({ length: 12 }, (_, i) => (
      <line key={i} x1="12" y1="2.5" x2="12" y2="7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity={0.15 + (0.85 * i) / 11} transform={`rotate(${i * 30} 12 12)`} />
    ))}
  </svg>
);

// A fixed-position menu kept fully inside the window - the track's "..." menu opens from a button
// near the bottom of the screen, where opening straight down used to cut most of it off.
const ViewportClampedMenu: React.FC<{ anchor: PopoverAnchor; className: string; children: React.ReactNode }> = ({ anchor, className, children }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  return (
    <div ref={ref} className={`fixed ${className}`} style={{ top: position.top, left: position.left }}>
      {children}
    </div>
  );
};
// How long a freeze frame holds (clip menu) - stretch it on the timeline like any image clip.
const FREEZE_FRAME_SECONDS = 2;

// Space kept past the last clip for the "+" add button (36px wide, 10px from the clip).
const ADD_BUTTON_ROOM_PX = 56;

// An image clip's filmstrip - the same picture on every tile, from the gallery's own cached
// thumbnail (get_image_thumbnail) rather than a full-resolution photo decode per tile. The primary
// file's frame cache above can't serve these: it only ever holds frames of the primary video.
const imageClipThumbUrls = new Map<string, Promise<string>>();
const ImageClipTiles: React.FC<{ sourcePath: string; tileCount: number; tileWidth: number }> = ({ sourcePath, tileCount, tileWidth }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let pending = imageClipThumbUrls.get(sourcePath);
    if (!pending) {
      pending = invoke<string>("get_image_thumbnail", { inputPath: sourcePath })
        .then((thumbPath) => invoke<string>("convert_file_path_to_url", { filepath: thumbPath }))
        .then((absolutePath) => convertFileSrc(absolutePath));
      pending.catch(() => imageClipThumbUrls.delete(sourcePath)); // let a later render retry
      imageClipThumbUrls.set(sourcePath, pending);
    }
    pending
      .then((resolved) => !cancelled && setUrl(resolved))
      .catch((err) => console.error("Failed to load image clip thumbnail for", sourcePath, err));
    return () => {
      cancelled = true;
    };
  }, [sourcePath]);
  return (
    <>
      {Array.from({ length: tileCount }, (_, i) =>
        url ? (
          <img key={i} src={url} className="h-full shrink-0 object-cover" style={{ width: tileWidth }} draggable={false} alt="" />
        ) : (
          <div key={i} className="h-full shrink-0 bg-neutral-800" style={{ width: tileWidth }} />
        )
      )}
    </>
  );
};

// A video clip from a file other than the primary one - its own frames (videoFrameCache.ts),
// never the primary's: borrowing those is what made an inserted video show the clips around it.
const ForeignVideoClipTiles: React.FC<{ clip: Clip; tileCount: number; tileWidth: number; width: number; pxPerSec: number }> = ({ clip, tileCount, tileWidth, width, pxPerSec }) => {
  const [frames, setFrames] = useState<ThumbFrame[]>([]);
  useEffect(() => {
    setFrames([]);
    return subscribeVideoFrames(clip.sourcePath, setFrames);
  }, [clip.sourcePath]);
  return (
    <>
      {Array.from({ length: tileCount }, (_, k) => {
        const outputOffset = Math.min((k + 0.5) * tileWidth, width) / pxPerSec;
        const t = nearestFrame(frames, Math.min(clip.end, outputOffsetToSource(clip, outputOffset)));
        return t ? (
          <img key={k} src={t.src} className="h-full shrink-0 object-cover" style={{ width: tileWidth }} draggable={false} alt="" />
        ) : (
          <div key={k} className="h-full shrink-0 bg-neutral-800" style={{ width: tileWidth }} />
        );
      })}
    </>
  );
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
  const canvasRestoreTick = useCanvasRestoreTick();

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
    // canvasRestoreTick: a pure redraw trigger, see useCanvasRestoreTick.
  }, [peaks, widthPx, heightPx, trimStart, trimEnd, sourceDuration, canvasRestoreTick]);

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
  // `resume`: keep playing after the seek (playback crossing into the next clip).
  onSeek: (sourcePath: string, time: number, resume?: boolean) => void;
  // Real play/pause state of the main player, and a way to toggle it - the transport button in
  // the track control rail below, same round-trip idea as currentTime/onSeek.
  isPlaying: boolean;
  onTogglePlay: () => void;
  onConvert: (file: DockerFile) => void;
  onRename: (file: DockerFile, newName: string) => Promise<void>;
  onDelete: (file: DockerFile) => Promise<void>;
  // "Move or copy to..." in the "..." menu (MoveCopyMenu.tsx) - absent hides it.
  fileTransfer?: FileTransferOptions;
  // "Set thumbnail..." in the "..." menu - opens the player's thumbnail picker.
  onSetThumbnail?: () => void;
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
  // The exact output time right now, read off the player itself (Dashboard's getExactOutputTime) -
  // for keeping audio overlays in sync, where the ~4Hz currentTime is too stale to measure against.
  getExactOutputTime?: () => number | null;
  // The player's source time right now, frame-accurate - null while it can't be trusted (mid-switch).
  getPlayerTime?: () => number | null;
  // Reports the ACTIVE clip's own color/Ken Burns effect fields upward, so VideoPlayer (mounted
  // as a sibling subtree by Dashboard) can drive live CSS filter/transform on the <video> element
  // without needing to know about clips at all - same "report state this component already tracks
  // upward for a sibling to consume" reasoning as onOutputTimeChange just above.
  onActiveClipChange?: (effects: ActiveClipEffects | null) => void;
  // While Export is set to Fill another shape: the window it keeps, for the player to show.
  onReframePreviewChange?: (preview: ReframePreview | null) => void;
  // The reverse direction for noise reduction specifically: VideoPlayer (a sibling) is the one
  // that actually knows whether the live Web Audio denoiser is idle/calibrating/active (see its
  // own onNoiseReductionStatusChange prop), and NoiseReductionPopover (rendered by THIS component)
  // is what needs to show that as a spinner - Dashboard just relays the value it already round-
  // trips through activeClipEffects's own reverse-direction sibling, onActiveClipChange, above.
  noiseReductionStatus?: "idle" | "calibrating" | "active";
  // NoiseReductionPopover's "Hold to compare" - forwarded to VideoPlayer's setNoisePreviewBypass
  // (via videoPlayerRef, held by Dashboard - this component has no ref to VideoPlayer itself).
  onPreviewNoiseOriginal?: (bypass: boolean) => void;

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
  // Adjustment layers (AdjustmentLayersLayer.tsx draws them and their settings).
  selectedAdjustmentId?: string | null;
  onSelectAdjustment?: (id: string | null) => void;
  isPlacingBlur?: boolean;
  onToggleArmPlaceBlur?: () => void;

  // PiP-overlay selection/placement, same threading/reasoning as the text/image/blur-overlay props
  // above - see PipOverlayLayer.tsx for where placement/rendering actually happens (a sibling of
  // VideoOverlayLayer, not part of it).
  selectedPipOverlayId?: string | null;
  onSelectPipOverlay?: (id: string | null) => void;
  isPlacingPip?: boolean;
  onToggleArmPlacePip?: () => void;
  // "Fix webcam background" - marks a webcam bubble baked into the recording (WebcamBubbleMarker).
  onMarkWebcamBubble?: () => void;
  // Find & hide - outline something once, hide it everywhere (FindHideTool).
  onFindAndHide?: () => void;

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
  fileTransfer,
  onSetThumbnail,
  onExported,
  draggingLibraryFile,
  pendingTimelineInsert,
  onTimelineInsertHandled,
  onOutputTimeChange,
  getExactOutputTime,
  getPlayerTime,
  onActiveClipChange,
  onReframePreviewChange,
  noiseReductionStatus = "idle",
  onPreviewNoiseOriginal,
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
  selectedAdjustmentId = null,
  onSelectAdjustment,
  isPlacingBlur = false,
  onToggleArmPlaceBlur,
  selectedPipOverlayId = null,
  onSelectPipOverlay,
  isPlacingPip = false,
  onToggleArmPlacePip,
  onMarkWebcamBubble,
  onFindAndHide,
  isCroppingClip = false,
  onToggleCroppingClip,
}) => {
  // The sidebar's Tools tab while it's open (see ToolPanelHost.tsx) - the clip/audio settings
  // popovers dock into it instead of floating, which changes how they open and close below.
  const toolPanelHost = useToolPanelHost();
  const rootRef = useRef<HTMLDivElement>(null);
  const hiddenVideoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  // One hidden <audio> per audio overlay, kept in sync with the main player below - no existing
  // pattern for this in the codebase (see the plan's own Context: every other `new Audio(...)`
  // usage is a one-shot UI sound effect, not a seekable/synced source).
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // Removing a playing <audio> from the DOM does NOT stop it (per the media spec it plays on until
  // garbage collected, which can be seconds later) - so an overlay that's deleted, or the whole
  // timeline closing, pauses its element explicitly.
  const audioOverlayIdsKey = editStore.audioOverlays.map((o) => o.id).join("|");
  useEffect(() => {
    const live = new Set(audioOverlayIdsKey ? audioOverlayIdsKey.split("|") : []);
    audioElementsRef.current.forEach((el, id) => {
      if (live.has(id)) return;
      el.pause();
      audioElementsRef.current.delete(id);
    });
  }, [audioOverlayIdsKey]);
  useEffect(() => {
    const elements = audioElementsRef.current;
    return () => elements.forEach((el) => el.pause());
  }, []);
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const trackContentRef = useRef<HTMLDivElement>(null);
  // Whether lanes are sitting below the timeline's capped height right now. The themed scrollbar
  // is subtle enough that rows down there (e.g. a second Voice/Music pair) went unnoticed while
  // still playing, so a visible "more below" hint is shown whenever this is true.
  const [lanesHiddenBelow, setLanesHiddenBelow] = useState(false);
  useEffect(() => {
    const area = trackAreaRef.current;
    const content = trackContentRef.current;
    if (!area || !content) return;
    const update = () => setLanesHiddenBelow(area.scrollHeight - area.scrollTop - area.clientHeight > 4);
    update();
    area.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(area);
    observer.observe(content);
    return () => {
      area.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  const [duration, setDuration] = useState<number>(0);
  // A video project (made from images, see isVideoProjectPath) rather than a recording.
  const isProject = isVideoProjectPath(file.path);
  // Native pixel size of the primary file, read off the same hidden capture <video> already used
  // for thumbnails once its metadata loads - Save needs this to know what resolution to render
  // text/image overlay PNGs at for burn-in (see videoOverlayRender.ts / exportEdited), since
  // TextOverlay/ImageOverlay only store position/size as frame-relative fractions.
  const [videoPixelSize, setVideoPixelSize] = useState<{ width: number; height: number } | null>(null);
  const [pxPerSec, setPxPerSec] = useState<number>(DEFAULT_PX_PER_SEC);
  const [thumbnails, setThumbnails] = useState<ThumbFrame[]>([]);
  const [coverThumbnail, setCoverThumbnail] = useState<string | null>(null);
  // The file's actual thumbnail (get_video_thumbnail - the one the gallery and Explorer show),
  // reloaded the moment "Set thumbnail" saves a new one; the captured first frame above only
  // stands in until it arrives, or for a file whose thumbnail can't be read.
  const [savedThumbnail, setSavedThumbnail] = useState<string | null>(null);
  useEffect(() => {
    setSavedThumbnail(null);
    if (isVideoProjectPath(file.path)) return;
    let cancelled = false;
    const load = (bust: boolean) =>
      invoke<string>("get_video_thumbnail", { inputPath: file.path })
        .then((thumbPath) => invoke<string>("convert_file_path_to_url", { filepath: thumbPath }))
        .then((absolutePath) => {
          if (!cancelled) setSavedThumbnail(convertFileSrc(absolutePath) + (bust ? `?t=${Date.now()}` : ""));
        })
        .catch(() => {});
    void load(false);
    const unlisten = listen<string>("video-thumbnail-updated", (event) => {
      if (event.payload === file.path) void load(true);
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, [file.path]);

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
  // The "..." menu's "Move or copy to..." opens in its place, at the same spot.
  const [transferAnchor, setTransferAnchor] = useState<PopoverAnchor | null>(null);
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

  // Load metadata once per file, then build a dense frame cache (every FRAME_CACHE_STEP_SEC of
  // source time, downscaled to THUMB_CAPTURE_HEIGHT) by seeking a hidden <video> and drawing each
  // frame to a canvas - the visible player above has its own playback going, so reusing it here
  // would fight the user's own scrubbing/playback. Captured coarse-to-fine (every 16th slot, then
  // 8th, 4th, 2nd, all) so the whole strip is roughly filled within a second or two and then
  // sharpens; clip blocks pick the nearest cached frame per tile at render time, so zooming in
  // reveals short shots a fixed handful of samples would have skipped entirely.
  useEffect(() => {
    setDuration(0);
    setThumbnails([]);
    setCoverThumbnail(null);

    const video = hiddenVideoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas) return;
    let cancelled = false;

    const captureFrameAt = (time: number, maxHeight: number | null): Promise<string | null> =>
      new Promise((resolve) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          const ctx = canvas.getContext("2d");
          if (!ctx || video.videoWidth === 0) {
            resolve(null);
            return;
          }
          const scale = maxHeight ? Math.min(1, maxHeight / video.videoHeight) : 1;
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.7));
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = time;
      });

    let swappedToPlayable = false;
    const handleLoadedMetadata = async () => {
      if (cancelled) return;
      // Sound but no picture (an HEVC .MOV) - capture from the playable copy instead, once. Its
      // own loadedmetadata comes back through here and carries on below.
      if (!isProject && !swappedToPlayable && isPictureless(video)) {
        swappedToPlayable = true;
        try {
          const url = await getPlayableUrl(file.path);
          if (!cancelled) video.src = url;
        } catch (err) {
          console.error("No playable copy for the filmstrip:", err);
        }
        return;
      }
      const total = video.duration;
      if (!Number.isFinite(total) || total <= 0) return;
      setDuration(total);
      editStore.setDuration(total);
      if (video.videoWidth > 0 && video.videoHeight > 0) setVideoPixelSize({ width: video.videoWidth, height: video.videoHeight });
      // A project's primary file is only its black preview canvas - nothing worth a filmstrip.
      if (isProject) return;

      const cover = await captureFrameAt(0, null);
      if (cancelled) return;
      setCoverThumbnail(cover);

      const count = Math.max(2, Math.min(MAX_CACHED_FRAMES, Math.ceil(total / FRAME_CACHE_STEP_SEC)));
      // Sample each slot's midpoint (never exactly `total`, which some decoders can't seek to).
      const slotTime = (i: number) => Math.min(total - 0.01, ((i + 0.5) / count) * total);
      const order: number[] = [];
      const seen = new Set<number>();
      for (let stride = 16; stride >= 1; stride /= 2) {
        for (let i = 0; i < count; i += stride) {
          if (!seen.has(i)) {
            seen.add(i);
            order.push(i);
          }
        }
      }

      const frames: ThumbFrame[] = [];
      let lastFlush = performance.now();
      for (let n = 0; n < order.length; n++) {
        if (cancelled) return;
        const time = slotTime(order[n]);
        const frame = await captureFrameAt(time, THUMB_CAPTURE_HEIGHT);
        if (cancelled) return;
        if (frame) frames.push({ time, src: frame });
        // Batch React updates - a setState per frame for ~200 frames would re-render the whole
        // timeline hundreds of times.
        const now = performance.now();
        if (now - lastFlush > 250 || n === order.length - 1) {
          lastFlush = now;
          setThumbnails([...frames].sort((a, b) => a.time - b.time));
        }
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

  // Which timeline tool is armed - "select" (the pre-existing default: click a clip to select it,
  // drag past a few px to reorder, drag its edges to trim) or "razor" (click anywhere on a clip to
  // split it right there, the same standard-NLE modal-tool idea Premiere/Resolve's own razor tool
  // uses - stays armed across multiple cuts rather than reverting to select after one). Sticky
  // rather than per-click, matching that same convention. The toolbar's "Select tool" button/
  // dropdown is what switches this.
  const [toolMode, setToolMode] = useState<TimelineToolMode>("select");
  const [toolModeAnchor, setToolModeAnchor] = useState<{ left: number; top: number } | null>(null);
  const toolModeButtonRef = useRef<HTMLButtonElement>(null);
  // The whole toolbar - ToolSearch (Ctrl+K) finds tools by its buttons' titles.
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Ctrl/Shift-click builds a multi-selection (Duplicate/Delete act on all of it). The last clip
  // picked is the primary selectedClipId every single-clip tool - crop, speed, effects - uses.
  const [selectedClipIdsRaw, setSelectedClipIds] = useState<string[]>([]);
  // Pruned to clips that still exist (after a delete or undo).
  const selectedClipIds = selectedClipIdsRaw.filter((id) => editStore.clips.some((c) => c.id === id));
  const selectedClipId = selectedClipIds.length > 0 ? selectedClipIds[selectedClipIds.length - 1] : null;
  const setSelectedClipId = useCallback((id: string | null) => setSelectedClipIds(id ? [id] : []), []);
  const selectedClip = selectedClipId ? editStore.clips.find((c) => c.id === selectedClipId) ?? null : null;
  // Audio cleanup/extraction, silence trimming and the recording-sidecar tools (auto zoom, view
  // switches) all need real footage - a still image clip has no audio or recording data to read.
  const selectedIsImage = !!selectedClip && isImageClipPath(selectedClip.sourcePath);
  // Speed, effects, mirror and audio cleanup act on the WHOLE multi-selection as one undo step,
  // not just its last pick - each popover still shows (and edits from) the primary clip's values.
  // Per clip, a patch drops what that clip can't take: a transition-in on the first clip, footage-
  // only fixes on a still, and Ken Burns keeps each clip's own zoom target.
  const selectedCount = selectedClipIds.length;
  const updateSelectedClips = (patch: StoreClipPatch) => {
    if (selectedCount === 0) return;
    const firstClipId = editStore.clips[0]?.id;
    editStore.updateClipsEffects(selectedClipIds, (clip) => {
      const next: StoreClipPatch = { ...patch };
      const isImage = isImageClipPath(clip.sourcePath);
      if (clip.id === firstClipId) delete next.transitionIn;
      if (isImage) {
        delete next.stabilize;
        delete next.noiseReduction;
        delete next.audioCleanup;
      }
      if (next.kenBurns && clip.id !== selectedClipId) next.kenBurns = { ...next.kenBurns, targetX: clip.kenBurns?.targetX, targetY: clip.kenBurns?.targetY };
      return Object.keys(next).length > 0 ? next : null;
    });
  };
  const selectionLabel = selectedCount > 1 ? `${selectedCount} selected clips` : "clip";
  // Effects popover (color grade/Ken Burns/transition) for whichever clip is selected - opened
  // from the toolbar's Effects button, closed the same "outside click" way AudioOverlayPopover
  // closes itself, plus whenever selection moves to a different clip (below) so it never keeps
  // pointing at a clip that's no longer selected.
  const [effectsPopoverAnchor, setEffectsPopoverAnchor] = useState<{ left: number; top: number } | null>(null);
  const effectsButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toolPanelHost) setEffectsPopoverAnchor(null);
  }, [selectedClipId, toolPanelHost]);

  // Speed popover - split out of ClipEffectsPopover into its own standalone toolbar button/popover
  // (same "select a clip first" gating, closed the same way on selection change) since speed has
  // enough of its own subfeatures to earn a dedicated surface rather than being one more section
  // buried inside "Clip effects", the same reasoning Crop already got its own toolbar button for.
  const [speedPopoverAnchor, setSpeedPopoverAnchor] = useState<{ left: number; top: number } | null>(null);
  const speedButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toolPanelHost) setSpeedPopoverAnchor(null);
  }, [selectedClipId, toolPanelHost]);

  // Noise reduction popover - same standalone toolbar button/popover shape as Speed just above,
  // for the same reason: an audio-cleanup feature with its own presets/strength control earns its
  // own surface rather than being buried in "Clip effects" (which stays color/Ken Burns/transition
  // only). Backed by both a live preview (VideoPlayer.tsx's Web Audio worklet) and the real
  // export-time filter (afftdn, conversion.rs).
  const [noiseReductionPopoverAnchor, setNoiseReductionPopoverAnchor] = useState<{ left: number; top: number } | null>(null);
  const noiseReductionButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toolPanelHost) setNoiseReductionPopoverAnchor(null);
  }, [selectedClipId, toolPanelHost]);

  // Extract-audio popover - same standalone toolbar button/popover shape as Speed/Reduce noise
  // above. isExtractingAudio is local (not threaded through editStore's isExporting/exportProgress)
  // since this is a short, independent operation on one clip's own source file, unrelated to the
  // Save button's whole-timeline export.
  const [extractAudioAnchor, setExtractAudioAnchor] = useState<{ left: number; top: number } | null>(null);
  const extractAudioButtonRef = useRef<HTMLButtonElement>(null);
  const [isExtractingAudio, setIsExtractingAudio] = useState(false);
  useEffect(() => {
    setExtractAudioAnchor(null);
  }, [selectedClipId]);

  // Save button's quality/destination options (ExportOptionsPopover) - both default to exactly
  // the behavior export_trimmed_video already had before this existed: "standard" quality, and a
  // null customOutputPath meaning "next to the source file" (see handleSave below).
  const [exportOptionsAnchor, setExportOptionsAnchor] = useState<{ left: number; top: number } | null>(null);
  const exportOptionsButtonRef = useRef<HTMLButtonElement>(null);
  const [exportQuality, setExportQuality] = useState<ExportQuality>("standard");
  const [customOutputPath, setCustomOutputPath] = useState<string | null>(null);
  // Platform format / framing / loudness for Save (ExportOptionsPopover) - defaults keep the
  // timeline's own frame and mix, exactly what Save always did.
  const [exportFormat, setExportFormat] = useState<ExportFormat>("original");
  const [exportFraming, setExportFraming] = useState<ExportFraming>("fit-blur");
  const [exportLoudness, setExportLoudness] = useState<number | null>(null);
  const [exportAnchor, setExportAnchor] = useState({ x: 0.5, y: 0.5 });
  const [exportFollowSubject, setExportFollowSubject] = useState(true);
  const [reframeStatus, setReframeStatus] = useState<string | null>(null);

  // Trim Silence toolbar button - anchor null means the popover is closed; silenceState only
  // matters while it's open (loading/empty/error/results, see SilenceDetectionPopover). Scoped to
  // the currently SELECTED clip only (same "select a clip first" gating Crop/Effects already use),
  // since detect_silence needs one concrete source file/range to scan.
  const [silenceAnchor, setSilenceAnchor] = useState<{ left: number; top: number } | null>(null);
  const [silenceState, setSilenceState] = useState<SilenceDetectionState>({ status: "loading" });
  const silenceButtonRef = useRef<HTMLButtonElement>(null);

  // Auto Zoom toolbar button - same shape/gating as Trim Silence above, reading load_click_sidecar
  // (recording.rs) instead of running detect_silence.
  const [autoZoomAnchor, setAutoZoomAnchor] = useState<{ left: number; top: number } | null>(null);
  const [autoZoomState, setAutoZoomState] = useState<AutoZoomState>({ status: "loading" });
  const autoZoomButtonRef = useRef<HTMLButtonElement>(null);

  // Apply View Switches toolbar button - same shape/gating as Auto Zoom above, reading
  // get_webcam_sidecar_path + load_view_switch_sidecar (recording.rs) instead of
  // load_click_sidecar. viewSwitchDataRef holds the raw events + webcam path detect resolved,
  // since handleApplyViewSwitch needs them again (editStore.applyViewSwitchOverlays re-derives the
  // actual overlays itself, same "detect shows a preview, apply re-runs the real logic on the
  // original data" split handleDetectAutoZoom/handleApplyAutoZoom already use) but
  // ViewSwitchDetectState's own "results" variant only carries a count for display.
  const [viewSwitchAnchor, setViewSwitchAnchor] = useState<{ left: number; top: number } | null>(null);

  // Captions tool (CaptionsPanel) - whole-timeline, so unlike Effects/Speed it needs no selected
  // clip and isn't closed by selection changes.
  const [captionsAnchor, setCaptionsAnchor] = useState<{ left: number; top: number } | null>(null);
  // Chapters (ChaptersPanel) - whole-timeline like Captions.
  const [chaptersAnchor, setChaptersAnchor] = useState<{ left: number; top: number } | null>(null);
  // Screen style (ScreenStylePanel) - the frame, the drawn pointer and shortcut keys, whole-video.
  const [screenStyleAnchor, setScreenStyleAnchor] = useState<{ left: number; top: number } | null>(null);
  const clipRecordings = useClipRecordings(editStore.clips);
  const hasEditablePointer = [...clipRecordings.values()].some((r) => hasPointerPath(r));
  const shortcutCount = useMemo(() => buildKeyChips(editStore.clips, clipRecordings).reduce((n, c) => n + c.count, 0), [editStore.clips, clipRecordings]);
  // Elements gallery (shapes and animated elements - videoAssets.ts).
  const [elementsAnchor, setElementsAnchor] = useState<{ left: number; top: number } | null>(null);
  // Split screen builder (SplitScreenPanel).
  const [splitAnchor, setSplitAnchor] = useState<{ left: number; top: number } | null>(null);
  // Make it a Short (ShortsStudio).
  const [shortsOpen, setShortsOpen] = useState(false);
  // Highlight intro builder (HighlightIntroPanel).
  const [introAnchor, setIntroAnchor] = useState<{ left: number; top: number } | null>(null);
  // The music & sound-effects library (MusicLibraryPanel).
  const [musicAnchor, setMusicAnchor] = useState<{ left: number; top: number } | null>(null);
  // The mixer (MixerPanel), and the strip it opens with its effects showing.
  const [mixerAnchor, setMixerAnchor] = useState<{ left: number; top: number } | null>(null);
  const [mixerFocus, setMixerFocus] = useState<string | null>(null);
  const mixerButtonRef = useRef<HTMLButtonElement>(null);
  const mixerSession = useMixerSession();
  const openMixer = (focus: string | null) => {
    const rect = mixerButtonRef.current?.getBoundingClientRect();
    setMixerFocus(focus);
    setMixerAnchor(rect ? { left: rect.left, top: rect.bottom + 4 } : { left: 80, top: 80 });
  };
  // "Mixer & effects" asked for from elsewhere (a picture-in-picture's panel) - mixerState.ts.
  const lastMixerRequest = useRef(mixerSession.request);
  useEffect(() => {
    if (mixerSession.request === lastMixerRequest.current) return;
    lastMixerRequest.current = mixerSession.request;
    if (mixerSession.request) openMixer(mixerSession.request.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixerSession.request]);
  const captionsButtonRef = useRef<HTMLButtonElement>(null);
  // Edit by transcript (TranscriptEditorPanel) - whole-timeline like Captions, sharing its transcripts.
  const [transcriptAnchor, setTranscriptAnchor] = useState<{ left: number; top: number } | null>(null);
  const transcriptButtonRef = useRef<HTMLButtonElement>(null);
  const captionLines = useMemo(() => buildCaptionLines(editStore.clips, editStore.captions), [editStore.clips, editStore.captions]);
  // Image clips have no speech to transcribe.
  const captionSourcePaths = useMemo(
    () => Array.from(new Set(editStore.clips.map((c) => c.sourcePath).filter((path) => !isImageClipPath(path)))),
    [editStore.clips]
  );

  // Docked, the settings panels follow the clip selection (effects above skip their close when
  // docked) and nothing closes them on an outside click - so opening one closes whichever other
  // was showing, keeping the sidebar's Tools tab to the one tool you're working with.
  const dockedPanelsOpen = {
    effects: effectsPopoverAnchor !== null,
    speed: speedPopoverAnchor !== null,
    noise: noiseReductionPopoverAnchor !== null,
    audio: audioPopoverAnchor !== null,
    captions: captionsAnchor !== null,
    transcript: transcriptAnchor !== null,
    music: musicAnchor !== null,
    mixer: mixerAnchor !== null,
  };
  const prevDockedPanelsOpen = useRef(dockedPanelsOpen);
  useEffect(() => {
    const prev = prevDockedPanelsOpen.current;
    prevDockedPanelsOpen.current = dockedPanelsOpen;
    if (!toolPanelHost) return;
    const opened = (Object.keys(dockedPanelsOpen) as (keyof typeof dockedPanelsOpen)[]).find((k) => dockedPanelsOpen[k] && !prev[k]);
    if (!opened) return;
    if (opened !== "effects") setEffectsPopoverAnchor(null);
    if (opened !== "speed") setSpeedPopoverAnchor(null);
    if (opened !== "noise") setNoiseReductionPopoverAnchor(null);
    if (opened !== "audio") setAudioPopoverAnchor(null);
    if (opened !== "captions") setCaptionsAnchor(null);
    if (opened !== "transcript") setTranscriptAnchor(null);
    if (opened !== "music") setMusicAnchor(null);
    if (opened !== "mixer") setMixerAnchor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolPanelHost, dockedPanelsOpen.effects, dockedPanelsOpen.speed, dockedPanelsOpen.noise, dockedPanelsOpen.audio, dockedPanelsOpen.captions, dockedPanelsOpen.transcript, dockedPanelsOpen.music, dockedPanelsOpen.mixer]);
  const [viewSwitchState, setViewSwitchState] = useState<ViewSwitchDetectState>({ status: "loading" });
  const viewSwitchButtonRef = useRef<HTMLButtonElement>(null);
  const viewSwitchDataRef = useRef<{ events: ViewSwitchEvent[]; webcamPath: string; clipOutputStart: number } | null>(null);

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
    // Captured once at drag start (not re-read from the clip mid-drag, which never changes its own
    // speed during a resize anyway) - handleResizeDragMove needs this to convert a mouse delta
    // (always in OUTPUT pixels/seconds, via the shared pxPerSec scale) into the SOURCE-seconds
    // adjustment clip.start/end actually need.
    speed: number;
    // -1 when dragging an image clip's START handle: a still has no source to trim into (its start
    // is always 0), so that handle sets the clip's length instead - dragging it left lengthens the
    // clip, i.e. moves `end` the opposite way to the pointer. 1 everywhere else.
    direction: 1 | -1;
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
  // A project never gets that placeholder: its primary file is a black canvas, not footage, so an
  // empty project's timeline is genuinely empty.
  const baseClips: Clip[] =
    editStore.clips.length > 0 || isProject ? editStore.clips : duration > 0 ? [{ id: "__pending__", sourcePath: file.path, start: 0, end: duration }] : [];

  // Applies the in-progress resize (if any) so every position derived below - block widths, tick
  // marks, the playhead, other handles - stays visually consistent with the live drag instead of
  // only jumping once it's released.
  const renderClips: Clip[] = resizeDrag
    ? baseClips.map((c) =>
        c.id === resizeDrag.id ? (resizeDrag.edge === "start" ? { ...c, start: resizeDrag.liveValue } : { ...c, end: resizeDrag.liveValue }) : c
      )
    : baseClips;

  // A clip's OWN output-timeline duration - (end-start)/speed, not just (end-start) - once it has
  // a speed edit (Clip.speed's own doc comment, videoEditTypes.ts): a 10s source range at 2x speed
  // plays back in 5 output seconds. Every position/width derived from this (outputStarts,
  // totalOutputDuration, totalWidth, every clip block/handle's own left/width style) automatically
  // reflects that just by being computed from this array, but currentOutputTime's own
  // source-time-elapsed-within-clip mapping and the resize-drag pixel<->source-seconds conversion
  // below both need their OWN explicit /speed or *speed - grep this file for `.speed` for every site.
  const clipDurations = renderClips.map((c) => clipOutputDuration(c));
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

  // Which kind of thing was selected most recently - what Ctrl+C copies when there are several.
  const lastSelectedRef = useRef<"clips" | "overlay">("overlay");
  useEffect(() => {
    if (selectedClipIds.length > 0) lastSelectedRef.current = "clips";
  }, [selectedClipIds.join()]);
  useEffect(() => {
    if (selectedOverlayId || selectedImageOverlayId || selectedBlurOverlayId || selectedAdjustmentId || selectedAudioOverlayId || selectedPipOverlayId) lastSelectedRef.current = "overlay";
  }, [selectedOverlayId, selectedImageOverlayId, selectedBlurOverlayId, selectedAdjustmentId, selectedAudioOverlayId, selectedPipOverlayId]);

  // ---- Adjustment-layer lane: move / retime, the blur lane's shape. ----------------------------
  const [adjustResizeDrag, setAdjustResizeDrag] = useState<null | { id: string; edge: "start" | "end"; startClientX: number; startValue: number; oppositeBound: number; liveValue: number }>(null);
  const [adjustDrag, setAdjustDrag] = useState<null | { id: string; startClientX: number; startTime: number; duration: number; isDragging: boolean; liveStartTime: number }>(null);
  const renderAdjustmentLayers: AdjustmentLayer[] = editStore.adjustmentLayers.map((l) => {
    if (adjustResizeDrag && l.id === adjustResizeDrag.id) return adjustResizeDrag.edge === "start" ? { ...l, startTime: adjustResizeDrag.liveValue } : { ...l, endTime: adjustResizeDrag.liveValue };
    if (adjustDrag && l.id === adjustDrag.id) return { ...l, startTime: adjustDrag.liveStartTime, endTime: adjustDrag.liveStartTime + adjustDrag.duration };
    return l;
  });
  const beginAdjustResizeDrag = (layer: AdjustmentLayer, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectAdjustment?.(layer.id);
    const startValue = edge === "start" ? layer.startTime : layer.endTime;
    setAdjustResizeDrag({ id: layer.id, edge, startClientX: e.clientX, startValue, oppositeBound: edge === "start" ? layer.endTime : layer.startTime, liveValue: startValue });
  };
  const handleAdjustResizeDragMove = (e: React.PointerEvent) => {
    if (!adjustResizeDrag) return;
    e.stopPropagation();
    const raw = snapToTargets(adjustResizeDrag.startValue + (e.clientX - adjustResizeDrag.startClientX) / pxPerSec, overlaySnapTargets, pxPerSec);
    const liveValue =
      adjustResizeDrag.edge === "start"
        ? Math.max(0, Math.min(raw, adjustResizeDrag.oppositeBound - MIN_OVERLAY_DURATION))
        : Math.min(totalOutputDuration, Math.max(raw, adjustResizeDrag.oppositeBound + MIN_OVERLAY_DURATION));
    setAdjustResizeDrag((prev) => (prev ? { ...prev, liveValue } : prev));
  };
  const endAdjustResizeDrag = () => {
    if (!adjustResizeDrag) return;
    const { id, edge, liveValue } = adjustResizeDrag;
    setAdjustResizeDrag(null);
    editStore.resizeAdjustmentLayerTime(id, edge, liveValue);
  };
  const beginAdjustDrag = (layer: AdjustmentLayer) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setAdjustDrag({ id: layer.id, startClientX: e.clientX, startTime: layer.startTime, duration: layer.endTime - layer.startTime, isDragging: false, liveStartTime: layer.startTime });
  };
  const handleAdjustDragMove = (e: React.PointerEvent) => {
    if (!adjustDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - adjustDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const raw = snapToTargets(adjustDrag.startTime + (e.clientX - adjustDrag.startClientX) / pxPerSec, overlaySnapTargets, pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - adjustDrag.duration));
    setAdjustDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveStartTime } : prev));
  };
  const endAdjustDrag = () => {
    if (!adjustDrag) return;
    const { id, isDragging, liveStartTime, duration } = adjustDrag;
    setAdjustDrag(null);
    if (isDragging) editStore.moveAdjustmentLayerTime(id, liveStartTime);
    onSelectAdjustment?.(id);
    if (currentOutputTime < liveStartTime || currentOutputTime >= liveStartTime + duration) seekToOutputTime(liveStartTime);
  };
  const addAdjustmentLayer = () => {
    const total = totalOutputDuration;
    if (total <= 0) return;
    const length = Math.min(5, total);
    const startTime = Math.max(0, Math.min(currentOutputTime, total - length));
    const id = editStore.addAdjustmentLayer(startTime, startTime + length, { look: { preset: "cinematic", intensity: 0.7 } });
    onSelectAdjustment?.(id);
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
    // The video track it started on, and the one under the pointer now (dragging up or down moves
    // it between tracks; the drop zone above the top one makes a new track).
    startTrack: number;
    liveTrack: number;
  }>(null);

  const renderPipOverlays: PipOverlay[] = editStore.pipOverlays.map((o) => {
    if (pipOverlayResizeDrag && o.id === pipOverlayResizeDrag.id) {
      return pipOverlayResizeDrag.edge === "start" ? { ...o, startTime: pipOverlayResizeDrag.liveValue } : { ...o, endTime: pipOverlayResizeDrag.liveValue };
    }
    if (pipOverlayDrag && o.id === pipOverlayDrag.id) {
      return { ...o, startTime: pipOverlayDrag.liveStartTime, endTime: pipOverlayDrag.liveStartTime + pipOverlayDrag.duration, track: pipOverlayDrag.liveTrack };
    }
    return o;
  });
  // One lane per video track in use, top track first (it draws over the ones below it).
  const videoTrackLanes = tracksInUse(renderPipOverlays).reverse();

  // B-roll: pick videos; they go full frame over the main video from the playhead, back to back,
  // on the lowest free video track.
  const handleAddBroll = async () => {
    const selected = await openFileDialog({ multiple: true, filters: [{ name: "Video", extensions: [...MEDIA_VIDEO_EXTENSIONS] }] });
    const paths = selected === null ? [] : Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    const at = currentOutputTime < totalOutputDuration - 1 ? currentOutputTime : 0;
    const ids = await editStore.addVideoLayers(paths, at);
    if (ids[0]) onSelectPipOverlay?.(ids[0]);
  };

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
    if (toolMode === "razor") {
      // Razor mode cuts the PiP right where the click landed, same as it does for clip blocks.
      editStore.splitPipOverlay(overlay.id, outputTimeFromClientX(e.clientX));
      onSelectPipOverlay?.(overlay.id);
      setSelectedClipId(null);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setPipOverlayDrag({
      id: overlay.id,
      startClientX: e.clientX,
      startTime: overlay.startTime,
      duration: overlay.endTime - overlay.startTime,
      isDragging: false,
      liveStartTime: overlay.startTime,
      startTrack: pipTrack(overlay),
      liveTrack: pipTrack(overlay),
    });
  };
  const handlePipOverlayDragMove = (e: React.PointerEvent) => {
    if (!pipOverlayDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - pipOverlayDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const deltaSec = (e.clientX - pipOverlayDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(pipOverlayDrag.startTime + deltaSec, overlaySnapTargets, pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - pipOverlayDrag.duration));
    // The video-track lane under the pointer - or, above the top one, a new track over every other
    // layer. (Lanes are in the DOM top track first.)
    const lanes = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-video-track]") ?? []);
    let overTrack: number | null = null;
    for (const lane of lanes) {
      const r = lane.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY < r.bottom) overTrack = Number(lane.dataset.videoTrack);
    }
    if (overTrack === null && lanes.length > 0 && e.clientY < lanes[0].getBoundingClientRect().top) {
      overTrack = Math.max(0, ...editStore.pipOverlays.filter((o) => o.id !== pipOverlayDrag.id).map(pipTrack)) + 1;
    }
    setPipOverlayDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved || (overTrack !== null && overTrack !== prev.liveTrack), liveStartTime, liveTrack: overTrack ?? prev.liveTrack } : prev));
  };
  const endPipOverlayDrag = () => {
    if (!pipOverlayDrag) return;
    const { id, isDragging, liveStartTime, duration, startTrack, liveTrack } = pipOverlayDrag;
    setPipOverlayDrag(null);
    if (isDragging) {
      editStore.movePipOverlayTime(id, liveStartTime, liveTrack !== startTrack ? liveTrack : undefined);
    }
    onSelectPipOverlay?.(id);
    setSelectedClipId(null);
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

        // At the playhead - or, with the playhead at the very end, back at the start.
        const startTime = currentOutputTime < totalOutputDuration - MIN_AUDIO_START_ROOM_SEC ? currentOutputTime : 0;
        // The whole file, even past the video's end: the overhang shows dimmed on the lane (and is
        // left out of the export), and stays there to drag/trim back in - cutting it off here lost
        // the rest of the song for good.
        const endTime = startTime + sourceDuration;

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
  const audioRows = packAudioRows(renderAudioOverlays);
  // The lanes run as far as the longest audio overhang, so all of it stays on screen to work with.
  const laneEndTime = renderAudioOverlays.reduce((end, o) => Math.max(end, o.endTime), totalOutputDuration);

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
    const preview = resizeAudioOverlayTimeHandler([overlay], overlay.id, audioOverlayResizeDrag.edge, Number.POSITIVE_INFINITY, raw)[0];
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
    if (e.button === 2) return;
    // Razor cuts the audio right where it's clicked - the audio lane's counterpart to
    // handleRazorClipPointerDown - and selects the piece after the cut.
    if (toolMode === "razor") {
      const second = editStore.splitAudioOverlay(overlay.id, outputTimeFromClientX(e.clientX));
      if (second) {
        setSelectedAudioOverlayId(second);
        setAudioPopoverAnchor(null);
      }
      return;
    }
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
    // Same rule as the store's moveAudioOverlayTime: may hang past the video's end, must start inside it.
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - MIN_AUDIO_START_ROOM_SEC));
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
    for (let t = 0; t <= laneEndTime; t += tickInterval) result.push(t);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneEndTime, totalOutputDuration, tickInterval]);

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
      const dur = clipDurations[i]; // an OUTPUT duration - see its own doc comment
      if (outputTime <= start + dur || i === renderClips.length - 1) {
        // outputTime - start is an OUTPUT-time delta into this clip; * speed converts it to the
        // SOURCE-time delta actually needed to seek the underlying <video> (whose own currentTime
        // is always source time) - a plain 1:1 add here would seek proportionally too little into
        // a sped-up clip's own source range (too much for a slowed-down one).
        return { index: i, sourceTime: outputOffsetToSource(renderClips[i], Math.max(0, Math.min(outputTime - start, dur))) };
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
    if (e.button !== 0) return; // right-click opens menus, it doesn't move the playhead
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

  const beginResizeDrag = (clip: Clip, index: number, handle: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedClipId(clip.id);
    // See resizeDrag's `direction`: an image clip's start handle drives its end.
    const direction: 1 | -1 = handle === "start" && isImageClipPath(clip.sourcePath) ? -1 : 1;
    const edge = direction === -1 ? "end" : handle;
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
    // The clip's average speed - what turns a mouse movement into a source-time trim. For a ramp
    // that's only approximate mid-drag; the clip's real length is re-derived the moment it lands.
    const speed = (clip.end - clip.start) / Math.max(1e-6, clipOutputDuration(clip));
    const clipOutputStart = outputStarts[index];
    const clipOutputEnd = clipOutputStart + clipDurations[index];
    // (currentOutputTime - clipOutputStart) is an OUTPUT-time delta - * speed converts it to the
    // SOURCE-time delta clip.start actually needs, same reasoning clipAtOutputTime's own comment
    // gives for the identical conversion.
    // No playhead snap for the reversed image handle - the pointer isn't at the edge that moves.
    const playheadSourceTime =
      direction === 1 && currentOutputTime >= clipOutputStart && currentOutputTime < clipOutputEnd ? outputOffsetToSource(clip, currentOutputTime - clipOutputStart) : null;
    setResizeDrag({ id: clip.id, edge, startClientX: e.clientX, startValue, oppositeBound, maxEnd, liveValue: startValue, playheadSourceTime, speed, direction });
  };
  const handleResizeDragMove = (e: React.PointerEvent) => {
    if (!resizeDrag) return;
    e.stopPropagation();
    // The raw pixel delta is always in OUTPUT pixels (pxPerSec is the shared output-time<->pixel
    // scale) - * speed converts the resulting seconds into the SOURCE-seconds adjustment
    // clip.start/end actually need, same reasoning clipAtOutputTime's own comment gives. Passing
    // pxPerSec/speed (rather than the plain scale) into snapToTargets keeps its own "N screen
    // pixels" snap threshold correct in this now-source-time-scaled space instead of snapping N*
    // speed pixels early/late for a sped-up/slowed-down clip's own trim handle.
    const deltaSec = ((e.clientX - resizeDrag.startClientX) / pxPerSec) * resizeDrag.speed * resizeDrag.direction;
    const raw =
      resizeDrag.playheadSourceTime != null
        ? snapToTargets(resizeDrag.startValue + deltaSec, [resizeDrag.playheadSourceTime], pxPerSec / resizeDrag.speed)
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

  // Razor mode's own pointerdown on a clip block - splits right where the click landed instead of
  // starting a drag/select. clipAtOutputTime (not the clip/index this specific block already knows)
  // is what handleSplit/the playhead-based split button already trust to turn a click position into
  // the right (index, sourceTime) pair - reusing it here keeps this one splitting rule instead of a
  // second, subtly different one.
  const handleRazorClipPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const { index, sourceTime } = clipAtOutputTime(outputTimeFromClientX(e.clientX));
    editStore.splitAt(index, sourceTime);
  };

  const handleClipPointerDown = (clip: Clip, index: number) => (e: React.PointerEvent) => {
    // Right button: the clip menu (onContextMenu) - not a drag, a razor cut or a scrub.
    if (e.button === 2) {
      e.stopPropagation();
      return;
    }
    if (toolMode === "razor") {
      handleRazorClipPointerDown(e);
      return;
    }
    beginClipDrag(clip, index)(e);
  };
  const handleClipDragMove = (e: React.PointerEvent) => {
    if (!clipDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - clipDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    setClipDrag((prev) =>
      prev ? { ...prev, isDragging: prev.isDragging || moved, overIndex: computeOverIndex(e.clientX) } : prev
    );
  };
  const endClipDrag = (e: React.PointerEvent) => {
    if (!clipDrag) return;
    const { index, clip, isDragging, overIndex } = clipDrag;
    setClipDrag(null);
    if (isDragging) {
      editStore.reorderClip(index, overIndex);
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl-click toggles this clip in or out of the selection.
      setSelectedClipIds(selectedClipIds.includes(clip.id) ? selectedClipIds.filter((id) => id !== clip.id) : [...selectedClipIds, clip.id]);
      onSelectPipOverlay?.(null);
    } else if (e.shiftKey && selectedClipId) {
      // Shift-click selects the run from the last-picked clip to this one, this one last (primary).
      const anchorIndex = baseClips.findIndex((c) => c.id === selectedClipId);
      const step = index >= anchorIndex ? 1 : -1;
      const run: string[] = [];
      for (let i = anchorIndex; i !== index + step; i += step) run.push(baseClips[i].id);
      setSelectedClipIds(run);
      onSelectPipOverlay?.(null);
    } else {
      setSelectedClipId(clip.id);
      // One selection at a time across the clip and PiP lanes, so Split/Delete (which prefer a
      // selected PiP) can never act on a PiP the user has since clicked away from.
      onSelectPipOverlay?.(null);
      // Selecting a clip only jumps the playhead to its start while playback is paused - same
      // reasoning as endPipOverlayDrag's own comment just below: yanking the playhead back to a
      // clip's start on a plain click mid-playback reads as "clicking the timeline restarts the
      // video", not as a deliberate seek.
      if (!isPlaying) {
        activeClipIndexRef.current = index;
        lastAppliedTimeRef.current = clip.start;
        onSeek(clip.sourcePath, clip.start);
      }
    }
  };

  // Split/Delete always act on the clip currently under the *playhead* (activeClipIndexRef),
  // never on a bare time value searched across all clips - once clips can come from different
  // files, a raw source time alone is ambiguous (two clips from different files can easily share
  // overlapping ranges), so the caller has to say which clip it means.
  //
  // Exception: a selected PiP chip takes over both - Split cuts that PiP at the playhead (if the
  // playhead is inside it) and Delete removes that PiP piece, closing the gap it leaves in its own
  // split chain (deletePipOverlayAndCloseGap). Splitting/deleting the main clip underneath a PiP
  // the user had explicitly selected was exactly the wrong-target surprise this avoids.
  const selectedPip = selectedPipOverlayId ? editStore.pipOverlays.find((o) => o.id === selectedPipOverlayId) : undefined;
  const handleSplit = () => {
    // A selected audio chip takes Split the same way a selected PiP does: cut it at the playhead,
    // keep the second piece selected (it's usually the one to keep trimming/deleting).
    if (selectedAudioOverlayId) {
      const audio = editStore.audioOverlays.find((o) => o.id === selectedAudioOverlayId);
      if (audio && currentOutputTime > audio.startTime && currentOutputTime < audio.endTime) {
        const second = editStore.splitAudioOverlay(audio.id, currentOutputTime);
        if (second) {
          setSelectedAudioOverlayId(second);
          setAudioPopoverAnchor(null);
        }
      }
      return;
    }
    if (selectedPip) {
      // Split at currentOutputTime - the PiP lane's own coordinate space - not currentTime, which
      // is the active clip's SOURCE time. Deliberately never falls through to splitting the clip:
      // with a PiP selected, a playhead outside it just means there's nothing of it to cut there.
      if (currentOutputTime > selectedPip.startTime && currentOutputTime < selectedPip.endTime) {
        editStore.splitPipOverlay(selectedPip.id, currentOutputTime);
      }
      return;
    }
    const idx = activeClipIndexRef.current;
    if (idx >= 0 && idx < baseClips.length) editStore.splitAt(idx, currentTime);
  };
  const handleDeleteSegment = () => {
    if (selectedPip) {
      editStore.deletePipOverlay(selectedPip.id);
      onSelectPipOverlay?.(null);
      return;
    }
    if (selectedClipIds.length > 1) {
      editStore.deleteClips(selectedClipIds);
      setSelectedClipId(null);
      return;
    }
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
      // Minimized docker (BottomDocker keeps this mounted, display:none, so docked tool panels
      // survive) - no Delete/Split/undo on a timeline nobody can see.
      if (rootRef.current && rootRef.current.offsetParent === null) return;

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
      // Ctrl/Cmd+C copies the selected overlay or clips (Ctrl+X cuts them) - pasted at the playhead
      // with Ctrl+V (Dashboard's paste handler, timelineClipboard.ts).
      if ((e.ctrlKey || e.metaKey) && (key === "c" || key === "x")) {
        const items = emptyClipboardItems();
        const one = <T extends { id: string }>(list: T[], id: string | null) => list.filter((o) => o.id === id);
        // Whatever was selected last wins (a clip and an overlay can both be selected).
        if (lastSelectedRef.current === "clips" && selectedClipIds.length > 0) items.clips = editStore.clips.filter((c) => selectedClipIds.includes(c.id));
        else if (selectedOverlayId) items.textOverlays = one(editStore.textOverlays, selectedOverlayId);
        else if (selectedImageOverlayId) items.imageOverlays = one(editStore.imageOverlays, selectedImageOverlayId);
        else if (selectedBlurOverlayId) items.blurOverlays = one(editStore.blurOverlays, selectedBlurOverlayId);
        else if (selectedAdjustmentId) items.adjustmentLayers = one(editStore.adjustmentLayers, selectedAdjustmentId);
        else if (selectedAudioOverlayId) items.audioOverlays = one(editStore.audioOverlays, selectedAudioOverlayId);
        else if (selectedPipOverlayId) items.pipOverlays = one(editStore.pipOverlays, selectedPipOverlayId);
        else if (selectedClipIds.length > 0) items.clips = editStore.clips.filter((c) => selectedClipIds.includes(c.id));
        else return;
        e.preventDefault();
        void copyItems(items);
        if (key === "x" && items.clips.length > 0) {
          if (editStore.clips.length > selectedClipIds.length) {
            editStore.deleteClips(selectedClipIds);
            setSelectedClipIds([]);
          }
        } else if (key === "x") {
          if (selectedOverlayId) {
            editStore.deleteTextOverlay(selectedOverlayId);
            onSelectOverlay?.(null);
          } else if (selectedImageOverlayId) {
            editStore.deleteImageOverlay(selectedImageOverlayId);
            onSelectImageOverlay?.(null);
          } else if (selectedBlurOverlayId) {
            editStore.deleteBlurOverlay(selectedBlurOverlayId);
            onSelectBlurOverlay?.(null);
          } else if (selectedAdjustmentId) {
            editStore.deleteAdjustmentLayer(selectedAdjustmentId);
            onSelectAdjustment?.(null);
          } else if (selectedAudioOverlayId) {
            editStore.deleteAudioOverlay(selectedAudioOverlayId);
            setSelectedAudioOverlayId(null);
            setAudioPopoverAnchor(null);
          } else if (selectedPipOverlayId) {
            editStore.deletePipOverlay(selectedPipOverlayId);
            onSelectPipOverlay?.(null);
          } else if (items.clips.length > 0 && editStore.clips.length > selectedClipIds.length) {
            editStore.deleteClips(selectedClipIds);
            setSelectedClipIds([]);
          }
        }
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
        } else if (selectedAdjustmentId) {
          onSelectAdjustment?.(editStore.duplicateAdjustmentLayer(selectedAdjustmentId));
        } else if (selectedAudioOverlayId) {
          setSelectedAudioOverlayId(editStore.duplicateAudioOverlay(selectedAudioOverlayId));
          setAudioPopoverAnchor(null);
        } else if (selectedClipIds.length > 0) {
          editStore.duplicateClips(selectedClipIds);
        }
        return;
      }

      // Ctrl/Cmd+A selects every clip on the timeline (then Delete, Duplicate, Speed, Effects...
      // act on all of them); Escape clears the selection. preventDefault stops the page's own
      // select-all highlighting everything.
      if ((e.ctrlKey || e.metaKey) && key === "a") {
        if (editStore.clips.length === 0) return;
        e.preventDefault();
        onSelectOverlay?.(null);
        onSelectImageOverlay?.(null);
        onSelectBlurOverlay?.(null);
        onSelectPipOverlay?.(null);
        setSelectedAudioOverlayId(null);
        setAudioPopoverAnchor(null);
        setSelectedClipIds(editStore.clips.map((c) => c.id));
        return;
      }
      if (e.key === "Escape" && selectedClipIds.length > 1) {
        setSelectedClipIds(selectedClipId ? [selectedClipId] : []);
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
      } else if (selectedAdjustmentId) {
        e.preventDefault();
        editStore.deleteAdjustmentLayer(selectedAdjustmentId);
        onSelectAdjustment?.(null);
      } else if (selectedAudioOverlayId) {
        e.preventDefault();
        editStore.deleteAudioOverlay(selectedAudioOverlayId);
        setSelectedAudioOverlayId(null);
        setAudioPopoverAnchor(null);
      } else if (selectedPipOverlayId || selectedClipId) {
        e.preventDefault();
        handleDeleteSegment();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOverlayId, selectedImageOverlayId, selectedBlurOverlayId, selectedAdjustmentId, selectedAudioOverlayId, selectedPipOverlayId, selectedClipId, selectedClipIds.join(), editStore]);

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

  // Fill following the subject: the camera path (reframeAnalysis.ts - memoised, so the preview
  // and Save share one analysis).
  const exportSize = EXPORT_FORMATS.find((f) => f.value === exportFormat)?.size;
  const following = !!exportSize && exportFraming === "fill" && exportFollowSubject && !!videoPixelSize;
  const runReframe = () =>
    analyzeReframe(editStore.clips, videoPixelSize!, exportSize!, (done, total) =>
      setReframeStatus(done < total ? `Finding the subject… clip ${done + 1} of ${total}` : null)
    );

  // Shows the kept window on the player while the export options are open.
  const exportOptionsOpen = !!exportOptionsAnchor;
  useEffect(() => {
    if (!onReframePreviewChange) return;
    if (!exportOptionsOpen || !exportSize || exportFraming !== "fill" || !videoPixelSize) {
      onReframePreviewChange(null);
      return;
    }
    const win = fillWindow(videoPixelSize, exportSize);
    const label = `${exportFormat}${exportFollowSubject ? " · following the subject" : ""}`;
    if (!exportFollowSubject) {
      onReframePreviewChange({ window: win, knots: anchorKnots(videoPixelSize, exportSize, exportAnchor), label });
      return;
    }
    let cancelled = false;
    onReframePreviewChange({ window: win, knots: anchorKnots(videoPixelSize, exportSize, { x: 0.5, y: 0.5 }), label: `${exportFormat} · finding the subject…` });
    runReframe()
      .then((knots) => !cancelled && onReframePreviewChange({ window: win, knots, label }))
      .catch((err) => {
        if (cancelled) return;
        setReframeStatus(`Couldn't follow the subject: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportOptionsOpen, exportFormat, exportFraming, exportFollowSubject, exportAnchor, videoPixelSize, editStore.clips]);
  useEffect(() => () => onReframePreviewChange?.(null), [onReframePreviewChange]);

  // Rendering overlays to pictures for the export takes a moment before the job is queued.
  const [preparingExport, setPreparingExport] = useState(false);
  const handleSave = async () => {
    let track: [number, number, number][] | undefined;
    if (following) {
      try {
        track = (await runReframe()).map((k) => [k.t, k.x, k.y]);
      } catch (err) {
        setReframeStatus(`Couldn't follow the subject: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    // Rendered by the background queue (exportQueue.ts) - editing carries straight on, and the
    // exports chip shows the frame being rendered, the progress and what's left.
    setPreparingExport(true);
    try {
      const payload = await editStore.prepareExport(videoPixelSize, {
        quality: exportQuality,
        outputPath: customOutputPath ?? undefined,
        outputFrame: exportSize ? { ...exportSize, mode: exportFraming, anchorX: exportAnchor.x, anchorY: exportAnchor.y, track } : null,
        loudnessLufs: exportLoudness,
      });
      if (!payload) return;
      const format = EXPORT_FORMATS.find((f) => f.value === exportFormat);
      const detail = [format && format.size ? format.label : null, exportQuality === "high" ? "High quality" : exportQuality === "small" ? "Small file" : "Standard", formatTimestamp(totalOutputDuration)].filter(Boolean).join(" · ");
      enqueueExport(payload, file.name.replace(/\.[^.]+$/, ""), detail);
    } finally {
      setPreparingExport(false);
    }
  };

  // Defaults the save dialog to exactly the same "<name> (edited).<ext>" filename
  // export_trimmed_video would otherwise pick on its own (see its own doc comment,
  // conversion.rs) - the user is choosing WHERE to put it, not renaming it.
  const handleChooseExportLocation = async () => {
    const stem = file.path.replace(/\.[^./\\]+$/, "").split(/[\\/]/).pop() ?? file.name;
    // A project renders to "<name>.mp4" (see export_trimmed_video), not another project file.
    const ext = isProject ? "mp4" : file.path.split(".").pop() ?? "mp4";
    const chosen = await saveFileDialog({ defaultPath: isProject ? `${stem}.mp4` : `${stem} (edited).${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (chosen) setCustomOutputPath(chosen);
  };

  // Extracts the selected clip's own audio (trim + speed + noise reduction, same fields
  // export_trimmed_video would apply to this clip, via extract_clip_audio - conversion.rs) to a
  // standalone file the user picks via a native save dialog. Track-level mute/volume folds into a
  // single `volume` the same way effective_video_volume does for the whole-timeline export, since
  // a clip has no volume of its own.
  const handleExtractAudio = async (format: "mp3" | "wav" | "aac") => {
    if (!selectedClip) return;
    const stem = selectedClip.sourcePath.replace(/\.[^./\\]+$/, "").split(/[\\/]/).pop() ?? "audio";
    const chosen = await saveFileDialog({ defaultPath: `${stem} - audio.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (!chosen) return;
    setIsExtractingAudio(true);
    try {
      await invoke("extract_clip_audio", {
        sourcePath: selectedClip.sourcePath,
        start: selectedClip.start,
        end: selectedClip.end,
        speed: selectedClip.speed ?? 1,
        noiseReduction: selectedClip.noiseReduction ?? null,
        audioCleanup: selectedClip.audioCleanup ?? null,
        volume: editStore.videoAudioMuted ? 0 : editStore.videoAudioVolume,
        outputFormat: format,
        outputPath: chosen,
      });
      setExtractAudioAnchor(null);
    } catch (err) {
      window.alert(`Failed to extract audio: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExtractingAudio(false);
    }
  };

  // Detach-audio popover's own facts, fetched each time it opens: how many audio streams the
  // selected clip's source really has, and which (if any) Demucs engine is installed.
  const [detachStreamCount, setDetachStreamCount] = useState<number | null>(null);
  const [separationEngine, setSeparationEngine] = useState<SeparationEngineStatus | undefined>(undefined);
  const [detachStatus, setDetachStatus] = useState<string | null>(null);
  // Backend command that cancels whichever long step is running (engine download or separation);
  // null when nothing cancellable is in flight. Drives the popover's Cancel button.
  const [activeCancelCommand, setActiveCancelCommand] = useState<"cancel_separation_engine_download" | "cancel_voice_music_separation" | null>(null);
  useEffect(() => {
    if (!extractAudioAnchor || !selectedClip) return;
    let cancelled = false;
    setDetachStreamCount(null);
    setSeparationEngine(undefined);
    invoke<unknown[]>("probe_audio_streams", { sourcePath: selectedClip.sourcePath })
      .then((streams) => !cancelled && setDetachStreamCount(streams.length))
      .catch(() => !cancelled && setDetachStreamCount(1));
    invoke<SeparationEngineStatus>("get_separation_engine")
      .then((status) => !cancelled && setSeparationEngine(status))
      .catch(() => !cancelled && setSeparationEngine({ installed: null, downloadBytes: null }));
    return () => {
      cancelled = true;
    };
    // Re-probe only when the popover opens or points at a different source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractAudioAnchor !== null, selectedClip?.sourcePath]);

  // Detach audio: renders every clip's own audio (trim/speed/noise reduction applied, so each
  // file's length matches that clip's output duration exactly) into the app cache, lays the
  // results on the audio lane at that clip's output position, and mutes the video track - one undo
  // step (detachVideoAudio). Two modes:
  //  - "streams": one file per audio stream the source actually has (probe_audio_streams), so a
  //    multi-track file comes apart into its real tracks; a single-track file gives one row.
  //  - "voice-music": the clip's mixed audio is extracted, then split by Demucs
  //    (separate_voice_music) into "Voice" and "Music" rows.
  // Clips whose source has no audio are skipped. Placement is a snapshot: reordering clips
  // afterwards does not drag their detached audio along.
  const handleDetachAudio = async (mode: DetachMode) => {
    const clips = editStore.clips;
    if (clips.length === 0) return;
    setIsExtractingAudio(true);
    try {
      // First "Voice and music" use: fetch the engine (download_separation_engine, audio_tracks.rs)
      // before touching the timeline. The popover's button already reads "Download engine (~N MB)
      // and detach", so clicking it is the consent - no second confirm dialog.
      if (mode === "voice-music" && !separationEngine?.installed) {
        setActiveCancelCommand("cancel_separation_engine_download");
        setDetachStatus("Downloading AI audio engine…");
        const unlisten = await listen<{ downloaded: number; total: number }>("separation-engine-download", (e) => {
          const { downloaded, total } = e.payload;
          const pct = total > 0 ? Math.floor((downloaded / total) * 100) : 0;
          setDetachStatus(`Downloading AI audio engine… ${pct}% (${Math.round(downloaded / 1_000_000)} of ${Math.round(total / 1_000_000)} MB)`);
        });
        try {
          const installed = await invoke<string>("download_separation_engine");
          setSeparationEngine((prev) => ({ installed, downloadBytes: prev?.downloadBytes ?? null }));
        } finally {
          unlisten();
          setActiveCancelCommand(null);
        }
      }
      const dir = await join(await appCacheDir(), "detached-audio");
      const tracks: { src: string; sourceDuration: number; startTime: number; endTime: number; label?: string }[] = [];
      const streamsBySource = new Map<string, { index: number; language?: string | null; title?: string | null }[]>();
      let outputStart = 0;
      for (let ci = 0; ci < clips.length; ci++) {
        const clip = clips[ci];
        const clipDuration = clipOutputDuration(clip);
        const startTime = outputStart;
        outputStart += clipDuration;
        // A still image clip has no audio to detach - it just leaves silence on the new track.
        if (clipDuration < MIN_OVERLAY_DURATION || isImageClipPath(clip.sourcePath)) continue;
        const clipOf = clips.length > 1 ? ` (clip ${ci + 1} of ${clips.length})` : "";

        let streams = streamsBySource.get(clip.sourcePath);
        if (!streams) {
          streams = await invoke<{ index: number; language?: string | null; title?: string | null }[]>("probe_audio_streams", { sourcePath: clip.sourcePath }).catch(() => [{ index: 0 }]);
          streamsBySource.set(clip.sourcePath, streams);
        }
        if (streams.length === 0) continue;

        const extract = async (streamIndex: number | null) => {
          const outputPath = await join(dir, `${crypto.randomUUID()}.wav`);
          await invoke("extract_clip_audio", {
            sourcePath: clip.sourcePath,
            start: clip.start,
            end: clip.end,
            speed: clip.speed ?? 1,
            noiseReduction: clip.noiseReduction ?? null,
            audioCleanup: clip.audioCleanup ?? null,
            volume: editStore.videoAudioVolume,
            outputFormat: "wav",
            outputPath,
            streamIndex,
          });
          return outputPath;
        };
        const place = (src: string, label?: string) => tracks.push({ src, sourceDuration: clipDuration, startTime, endTime: startTime + clipDuration, label });

        if (mode === "streams") {
          for (const stream of streams) {
            setDetachStatus(`Extracting track ${stream.index + 1} of ${streams.length}${clipOf}…`);
            const src = await extract(streams.length > 1 ? stream.index : null);
            const name = stream.title || (stream.language ? `Track ${stream.index + 1} · ${stream.language}` : `Track ${stream.index + 1}`);
            place(src, streams.length > 1 ? name : undefined);
          }
        } else {
          setDetachStatus(`Extracting audio${clipOf}…`);
          const mixed = await extract(null);
          // On a laptop CPU this runs several times slower than real time, so show the engine's
          // own progress and allow Cancel rather than a bare spinner.
          const separatingLabel = `Separating voice and music${clipOf}`;
          setDetachStatus(`${separatingLabel}… starting`);
          setActiveCancelCommand("cancel_voice_music_separation");
          const unlisten = await listen<{ percent: number }>("separation-progress", (e) => {
            setDetachStatus(`${separatingLabel}… ${Math.floor(e.payload.percent)}%`);
          });
          let stems: { voicePath: string; musicPath: string };
          try {
            stems = await invoke<{ voicePath: string; musicPath: string }>("separate_voice_music", { inputPath: mixed, outputDir: dir });
          } finally {
            unlisten();
            setActiveCancelCommand(null);
          }
          place(stems.voicePath, "Voice");
          place(stems.musicPath, "Music");
        }
      }
      if (tracks.length === 0) {
        window.alert("This video has no audio to detach.");
        return;
      }
      editStore.detachVideoAudio(tracks);
      setExtractAudioAnchor(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "SEPARATION_DOWNLOAD_CANCELLED" || message === "SEPARATION_CANCELLED") return;
      window.alert(
        message === "SEPARATION_ENGINE_MISSING"
          ? "Voice/music separation needs Demucs, which isn't installed. Install it with \"pip install demucs\" and try again."
          : `Failed to detach audio: ${message}`
      );
    } finally {
      setIsExtractingAudio(false);
      setDetachStatus(null);
    }
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

  // Reads back whatever click_tracker.rs recorded for the selected clip's own source file (see
  // load_click_sidecar, recording.rs) - None means that recording was never made with "Track
  // clicks" on, not an error. ClickEvent's own fields (conversion.rs) arrive as elapsedSecs -
  // seconds since the hook was installed, which lines up with this clip's own SOURCE time (both
  // are "seconds from the start of the recording") as long as this clip's sourcePath is still the
  // original recording the sidecar belongs to.
  const handleDetectAutoZoom = async () => {
    if (!selectedClip) return;
    const rect = autoZoomButtonRef.current?.getBoundingClientRect();
    if (rect) setAutoZoomAnchor({ left: rect.left, top: rect.bottom + 4 });
    setAutoZoomState({ status: "loading" });
    try {
      const json = await invoke<string | null>("load_click_sidecar", { videoPath: selectedClip.sourcePath });
      if (!json) {
        setAutoZoomState({ status: "empty", reason: "no-sidecar" });
        return;
      }
      const allClicks: { elapsedSecs: number; xFraction: number; yFraction: number }[] = JSON.parse(json);
      const withinClip = allClicks
        .filter((c) => c.elapsedSecs > selectedClip.start && c.elapsedSecs < selectedClip.end)
        .map((c) => ({ time: c.elapsedSecs, x: c.xFraction, y: c.yFraction }));
      setAutoZoomState(withinClip.length > 0 ? { status: "results", clicks: withinClip } : { status: "empty", reason: "no-clicks-in-range" });
    } catch (err) {
      setAutoZoomState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };
  const handleApplyAutoZoom = () => {
    if (!selectedClip || autoZoomState.status !== "results") return;
    editStore.applyAutoZoomAtClicks(selectedClip.id, autoZoomState.clicks);
    setAutoZoomAnchor(null);
  };

  // Reads back get_webcam_sidecar_path + load_view_switch_sidecar (recording.rs) for the selected
  // clip's own source file - both None/empty is normal (no separate_webcam_capture, or the toggle
  // was simply never used), not an error. clipOutputStart comes straight from the ambient
  // outputStarts/clipDurations this component already computes for every clip on the timeline
  // (see their own doc comment above) - buildViewSwitchOverlays needs it to place the resulting
  // PipOverlays in OUTPUT-timeline coordinates rather than this clip's own source-time ones.
  const handleDetectViewSwitch = async () => {
    if (!selectedClip) return;
    const rect = viewSwitchButtonRef.current?.getBoundingClientRect();
    if (rect) setViewSwitchAnchor({ left: rect.left, top: rect.bottom + 4 });
    setViewSwitchState({ status: "loading" });
    try {
      const webcamPath = await invoke<string | null>("get_webcam_sidecar_path", { videoPath: selectedClip.sourcePath });
      if (!webcamPath) {
        setViewSwitchState({ status: "empty", reason: "no-webcam-file" });
        return;
      }
      const json = await invoke<string | null>("load_view_switch_sidecar", { videoPath: selectedClip.sourcePath });
      if (!json) {
        setViewSwitchState({ status: "empty", reason: "no-sidecar" });
        return;
      }
      const events: ViewSwitchEvent[] = JSON.parse(json).map((e: { elapsedSecs: number; mode: string }) => ({
        time: e.elapsedSecs,
        mode: e.mode,
      }));
      const clipIndex = renderClips.findIndex((c) => c.id === selectedClip.id);
      const clipOutputStart = clipIndex >= 0 ? outputStarts[clipIndex] : 0;
      const overlays = buildViewSwitchOverlays(events, selectedClip.start, selectedClip.end, clipOutputStart, selectedClip.speed, webcamPath);
      if (overlays.length === 0) {
        setViewSwitchState({ status: "empty", reason: "no-switches-in-range" });
        return;
      }
      viewSwitchDataRef.current = { events, webcamPath, clipOutputStart };
      setViewSwitchState({ status: "results", intervalCount: overlays.length });
    } catch (err) {
      setViewSwitchState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };
  const handleApplyViewSwitch = () => {
    if (!selectedClip || viewSwitchState.status !== "results" || !viewSwitchDataRef.current) return;
    const { events, webcamPath, clipOutputStart } = viewSwitchDataRef.current;
    editStore.applyViewSwitchOverlays(selectedClip.id, events, webcamPath, clipOutputStart);
    setViewSwitchAnchor(null);
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
  // Tracked in bootstrappedClipIdByFile (module-level, keyed by file.path) rather than a useRef -
  // see that declaration's own comment for why a ref here previously reset on every reopen of
  // this panel and force-seeked an already-playing video back to the start each time.
  useEffect(() => {
    const first = baseClips[0];
    // A project emptied of every clip goes back to its blank canvas (its primary file) rather
    // than leaving the deleted clip's picture on screen - and forgets the old first clip, so
    // bringing it back (undo) plays from it again.
    if (!first && isProject && !editStore.loading) {
      bootstrappedClipIdByFile.delete(file.path);
      activeClipIndexRef.current = 0;
      onSeek(file.path, 0);
      return;
    }
    if (!first || first.id === "__pending__" || bootstrappedClipIdByFile.get(file.path) === first.id) return;
    bootstrappedClipIdByFile.set(file.path, first.id);
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
    // Leaving forward is judged against the clip's end itself (less a frame's worth), not end +
    // tolerance: a clip that runs to the end of its file - any freshly added or duplicated whole
    // video - stops dead at `end` when the <video> hits "ended", so it never got past end +
    // tolerance and playback stalled there instead of moving on to the next clip. The tolerance
    // stays on the start side, where a seek can land a hair early (see SEEK_TOLERANCE_SEC).
    if (currentTime >= active.start - SEEK_TOLERANCE_SEC && currentTime < active.end - CLIP_END_EPSILON_SEC) return; // still inside it

    const nextIndex = activeIdx + 1;
    if (nextIndex < baseClips.length) {
      // Playback running out of one clip carries on into the next - even if the <video> paused
      // itself on reaching the end of its file. A scrub past the end while paused stays paused.
      advanceToClip(nextIndex, isPlaying || wasPlayingRef.current);
    } else if (isPlaying && !stopRequestedRef.current && currentTime >= active.end - CLIP_END_EPSILON_SEC) {
      // Finished the last clip in playback order - stop there rather than playing on into the
      // rest of its source (an image clip's proxy runs for minutes; a trimmed video's tail was
      // cut for a reason). Play again restarts from clip 0 (handleTransportPlayClick).
      stopRequestedRef.current = true;
      onTogglePlay();
    }
  }, [currentTime, editStore.clips]);
  function advanceToClip(index: number, resume: boolean) {
    const clip = baseClips[index];
    activeClipIndexRef.current = index;
    lastAppliedTimeRef.current = clip.start;
    onSeek(clip.sourcePath, clip.start, resume);
  }
  // The effect above only hears the player's position a few times a second (timeupdate), so on its
  // own a clip ran up to a quarter second past its cut before the next one was asked for. While
  // playing, this checks every frame and crosses over on the frame the clip ends - the next clip's
  // standby (ClipHandoffLayer) takes over in the same tick.
  const boundaryCheckRef = useRef<() => void>(() => {});
  const stopRequestedRef = useRef(false);
  boundaryCheckRef.current = () => {
    const t = getPlayerTime?.();
    const index = activeClipIndexRef.current;
    const clip = baseClips[index];
    if (t == null || !clip || t < clip.start - SEEK_TOLERANCE_SEC) return;
    if (t < clip.end - FRAME_BOUNDARY_SEC) return;
    if (index + 1 < baseClips.length) advanceToClip(index + 1, true);
    else if (!stopRequestedRef.current) {
      // The end of the last clip - stop there (see the effect above). Once: isPlaying only turns
      // false a render later, and a second toggle would start it again.
      stopRequestedRef.current = true;
      onTogglePlay();
    }
  };
  useEffect(() => {
    if (isPlaying) stopRequestedRef.current = false;
    if (!isPlaying || !getPlayerTime) return;
    let raf = 0;
    const tick = () => {
      boundaryCheckRef.current();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, getPlayerTime]);
  // isPlaying as of the previous commit, for the effect above: on reaching the end of its file the
  // <video> reports its final time and its pause together, so that effect can see the clip end
  // with isPlaying already false. Declared after it so it still holds the previous value there.
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    wasPlayingRef.current = isPlaying;
  });

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
  // `atEnd` appends instead (the "+" after the last clip).
  // `atIndex` puts them at that exact slot instead (the clip menu's Insert clip > Before/After).
  const handleInsertClipViaPicker = async (atEnd = false, atIndex?: number) => {
    setMenuOpen(false);
    const selected = await openFileDialog({
      multiple: true,
      filters: [
        { name: "Videos and images", extensions: [...MEDIA_VIDEO_EXTENSIONS, ...IMAGE_CLIP_EXTENSIONS] },
      ],
    });
    if (!selected) return; // cancelled
    const paths = Array.isArray(selected) ? selected : [selected];
    // An empty timeline has no active clip - append; otherwise insert after the one on screen, in
    // the order picked.
    let insertIndex =
      atIndex ?? (atEnd ? editStore.clips.length : baseClips.length === 0 ? 0 : Math.max(0, activeClipIndexRef.current + 1));
    for (const path of paths) {
      // eslint-disable-next-line no-await-in-loop
      await editStore.insertClipAt(path, insertIndex);
      insertIndex += 1;
    }
  };

  // ---- Clip menu (right-click a clip) & clip viewer ------------------------------------------
  // The clips a rendered merge is working on (clip menu > Merge) - they show a spinner at each break
  // point between them, with a Cancel under it, until the render finishes.
  const [mergingIds, setMergingIds] = useState<string[] | null>(null);
  // Break points are at the start of every merging clip after the first one in timeline order.
  const firstMergingIndex = mergingIds ? editStore.clips.findIndex((c) => mergingIds.includes(c.id)) : -1;
  const [clipMenu, setClipMenu] = useState<{ clipId: string; anchor: { left: number; top: number } } | null>(null);
  const [viewerClipId, setViewerClipId] = useState<string | null>(null);
  // Selects the clip too (without moving the playhead, so "Split at playhead" still means the
  // playhead's spot), which is what "All effects…" then opens against.
  const openClipMenu = (clip: Clip) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Right-clicking inside a multi-selection keeps it, so the menu's Duplicate/Delete cover it all.
    if (!selectedClipIds.includes(clip.id)) setSelectedClipId(clip.id);
    setClipMenu({ clipId: clip.id, anchor: { left: e.clientX, top: e.clientY } });
  };
  const menuClipIndex = clipMenu ? editStore.clips.findIndex((c) => c.id === clipMenu.clipId) : -1;
  const menuClip = menuClipIndex >= 0 ? editStore.clips[menuClipIndex] : null;
  // The selection the menu's Duplicate/Delete act on - just the clicked clip unless it's part of one.
  const menuSelection = menuClip && selectedClipIds.includes(menuClip.id) ? selectedClipIds : menuClip ? [menuClip.id] : [];
  // The playhead's source time, if it's inside `clip` right now.
  const playheadInClip = (clip: Clip): number | null => {
    const active = baseClips[activeClipIndexRef.current];
    return active?.id === clip.id && currentTime > clip.start && currentTime < clip.end ? currentTime : null;
  };
  const moveClip = (index: number, target: ClipMoveTarget) => {
    const last = editStore.clips.length - 1;
    const to = target === "earlier" ? index - 1 : target === "later" ? index + 1 : target === "start" ? 0 : last;
    editStore.reorderClip(index, Math.max(0, Math.min(last, to)));
  };
  const handleSaveClipAs = async (clip: Clip, index: number) => {
    const stem = clip.sourcePath.replace(/\.[^./\\]+$/, "").split(/[\\/]/).pop() ?? "clip";
    const chosen = await saveFileDialog({ defaultPath: `${stem} - clip ${index + 1}.mp4`, filters: [{ name: "MP4", extensions: ["mp4"] }] });
    if (!chosen) return;
    const result = await editStore.exportClip(clip.id, videoPixelSize, chosen);
    if (result) onExported(result.path, result.name);
  };
  const handleViewClip = (clip: Clip) => {
    if (isPlaying) onTogglePlay(); // one thing playing at a time
    setViewerClipId(clip.id);
  };
  const handleReplaceClip = async (clipId: string) => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Videos and images", extensions: [...MEDIA_VIDEO_EXTENSIONS, ...IMAGE_CLIP_EXTENSIONS] }],
    });
    if (!selected || Array.isArray(selected)) return; // cancelled
    await editStore.replaceClipSource(clipId, selected);
  };
  const viewerIndex = viewerClipId ? editStore.clips.findIndex((c) => c.id === viewerClipId) : -1;
  // A clip action that renders media first (freeze frame, reverse): shows what's happening on the
  // track while it runs, and the reason if it fails.
  const [busyMessage, setBusyMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const runBusy = (text: string, task: () => Promise<void>) => {
    setBusyMessage({ text });
    task()
      .then(() => setBusyMessage(null))
      .catch((err) => {
        console.error(text, err);
        setBusyMessage({ text: String(err), error: true });
        window.setTimeout(() => setBusyMessage(null), 6000);
      });
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
        Math.max(
          0,
          Math.min(
            // (currentTime - clip.start) is a SOURCE-time delta (currentTime is the underlying
            // <video>'s own currentTime) - divide by speed to convert it into the OUTPUT-time
            // delta clipDurations[...] (now itself an output duration, see its own doc comment)
            // is expressed in, or a sped-up clip's own playhead position would read as running
            // past its output duration long before source playback actually finishes.
            sourceToOutputOffset(renderClips[activeIndexForDisplay], currentTime),
            clipDurations[activeIndexForDisplay]
          )
        )
      : 0;
  const playheadLeft = currentOutputTime * pxPerSec;

  // Snap landmarks for every overlay drag/resize handler above (they're all defined earlier in
  // this component but close over this by reference, same forward-reference pattern
  // currentOutputTime's own consumers above already rely on) - the playhead plus every clip's own
  // boundary, deduped isn't needed since snapToTargets just takes whichever is nearest regardless
  // of duplicates.
  // Music beats too (beat sync), so text, images and cuts can be dropped right on the beat.
  const beatTimes = useMemo(() => beatOutputTimes(editStore.audioOverlays), [editStore.audioOverlays]);
  const chapterMarks = useMemo(() => outputChapters(editStore.clips, editStore.chapters), [editStore.clips, editStore.chapters]);
  const overlaySnapTargets = [currentOutputTime, ...outputStarts, ...outputStarts.map((s, i) => s + clipDurations[i]), ...beatTimes, ...chapterMarks.map((c) => c.time)];

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
            grade: activeClip.grade,
            kenBurns: activeClip.kenBurns,
            crop: activeClip.crop,
            flipHorizontal: activeClip.flipHorizontal,
            speed: activeClip.speed,
            speedRamp: activeClip.speedRamp,
            noiseReduction: activeClip.noiseReduction,
            audioCleanup: activeClip.audioCleanup,
            muted: activeClip.muted,
            sourcePath: activeClip.sourcePath,
            frame: videoPixelSize ?? undefined,
          }
        : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoPixelSize?.width, videoPixelSize?.height, activeClip?.id, activeClip?.start, activeClip?.end, activeClip?.colorFilter, activeClip?.grade, activeClip?.kenBurns, activeClip?.crop, activeClip?.flipHorizontal, activeClip?.speed, activeClip?.speedRamp, activeClip?.noiseReduction, activeClip?.audioCleanup, activeClip?.muted, activeClip?.sourcePath]);
  // Leaving the editor takes the timeline's framing with it - otherwise the player keeps fitting
  // whatever it shows next into this file's frame (a wide film shrunk into a tall recording's frame).
  useEffect(() => () => onActiveClipChange?.(null), [onActiveClipChange]);

  // Keeps every audio overlay's hidden <audio> element in lockstep with the main player: paused
  // whenever the playhead is outside its own [startTime,endTime) range (overlaysActiveAt, same
  // gating text/image overlays already use for visibility), otherwise playing/paused to match
  // isPlaying with its own currentTime hard-set only on a real discontinuity (a scrub/seek, or
  // more than ~150ms of drift) - letting the browser's own playback clock advance it the rest of
  // the time avoids fighting/stuttering it every frame the way resetting currentTime continuously
  // would. Volume applies both the overlay's own level and a linear fade in/out envelope.
  //
  // Measured against the player's exact time (getExactOutputTime), not currentOutputTime: that one
  // comes from a ~4Hz timeupdate and reaches here only after a full re-render, by which point the
  // audio has played on - the gap alone used to exceed the old 0.15s threshold, so every tick
  // re-seeked the audio, which is what made detached audio skip and stutter. While playing, small
  // drift is left alone (a seek is far more audible than 0.3s of slip); paused or after a scrub
  // it's snapped exactly. Also re-checked a few times a second while playing, independent of renders.
  // ---- Music library + ducking ----------------------------------------------------------------
  // Where a library track lands (the playhead - or, with it at the very end, the start; same rule
  // as a file) and what the library's "Suggested for this video" goes on.
  const musicPlaceAt = currentOutputTime < totalOutputDuration - MIN_AUDIO_START_ROOM_SEC ? currentOutputTime : 0;
  const musicContext = useMemo<VideoContext>(() => {
    const imageClips = editStore.clips.filter((c) => isImageClipPath(c.sourcePath)).length;
    const hasSpeech =
      (!editStore.videoAudioMuted && editStore.clips.some((c) => !c.muted && !isImageClipPath(c.sourcePath))) || editStore.audioOverlays.some((o) => isSpeechOverlay(o) && !o.muted);
    return { videoDuration: totalOutputDuration, hasSpeech, isMontage: editStore.clips.length > 0 && imageClips / editStore.clips.length >= 0.5 };
  }, [editStore.clips, editStore.videoAudioMuted, editStore.audioOverlays, totalOutputDuration]);

  // Speech on the output timeline, for ducked tracks - only worked out once something is ducked.
  // The per-file scans are cached (musicDucking.ts), so re-running this after an edit is cheap.
  const anyDucked = editStore.audioOverlays.some(isDucked);
  const speechRangesRef = useRef<TimeRange[]>([]);
  useEffect(() => {
    if (!anyDucked) return;
    let cancelled = false;
    computeSpeechTimeline({ clips: editStore.clips, videoAudioMuted: editStore.videoAudioMuted, audioOverlays: editStore.audioOverlays }).then((r) => {
      if (!cancelled) speechRangesRef.current = r;
    });
    return () => {
      cancelled = true;
    };
  }, [anyDucked, editStore.clips, editStore.videoAudioMuted, editStore.audioOverlays]);

  // A library song missing from disk (app data cleared, project opened on another machine) is
  // fetched again - checked once per overlay per session, which is just a file-exists test.
  const restoreCheckedRef = useRef(new Set<string>());
  useEffect(() => {
    for (const o of editStore.audioOverlays) {
      const key = `${o.id}|${o.src}`;
      if (!o.library || restoreCheckedRef.current.has(key)) continue;
      restoreCheckedRef.current.add(key);
      restoreMusicTrack(o.library.trackId, o.src)
        .then((path) => path && path !== o.src && editStore.updateAudioOverlayContent(o.id, { src: path }))
        .catch((err) => console.warn("Couldn't restore library track", o.library?.title, err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editStore.audioOverlays]);

  const syncAudioOverlaysRef = useRef<() => void>(() => {});
  const audioSeekAtRef = useRef<Map<string, number>>(new Map());
  syncAudioOverlaysRef.current = () => {
    const now = (isPlaying ? getExactOutputTime?.() : null) ?? currentOutputTime;
    const activeIds = new Set(overlaysActiveAt(editStore.audioOverlays, now).map((o) => o.id));
    editStore.audioOverlays.forEach((o) => {
      const audio = audioElementsRef.current.get(o.id);
      if (!audio) return;
      if (!activeIds.has(o.id)) {
        if (!audio.paused) audio.pause();
        return;
      }
      const desiredTime = o.trimStart + (now - o.startTime);
      const drift = Math.abs(audio.currentTime - desiredTime);
      const tolerance = isPlaying && !audio.paused ? AUDIO_DRIFT_TOLERANCE_SEC : 0.05;
      // A seek stalls the element while it rebuffers, its currentTime frozen at the target while the
      // picture moves on - re-checking during that window always saw fresh drift and seeked again,
      // a loop that kept the audio stuttering. So: never while it's still seeking, and only a real
      // jump (a scrub) right after one.
      const settling = audio.seeking || performance.now() - (audioSeekAtRef.current.get(o.id) ?? 0) < AUDIO_SEEK_SETTLE_MS;
      if (drift > tolerance && (!settling || drift > AUDIO_JUMP_SEC)) {
        audio.currentTime = desiredTime;
        audioSeekAtRef.current.set(o.id, performance.now());
      }
      if (isPlaying && audio.paused) {
        audio.play().catch((err) => console.error("Audio overlay failed to play:", o.src, err));
      }
      if (!isPlaying && !audio.paused) audio.pause();

      const fadeIn = o.fadeInSec ?? 0;
      const fadeOut = o.fadeOutSec ?? 0;
      let envelope = 1;
      if (fadeIn > 0) envelope = Math.min(envelope, (now - o.startTime) / fadeIn);
      if (fadeOut > 0) envelope = Math.min(envelope, (o.endTime - now) / fadeOut);
      const duck = isDucked(o) ? duckGainAt(speechRangesRef.current, now, o.duckLevel ?? DEFAULT_DUCK_LEVEL) : 1;
      const session = getMixerSession();
      const soloOff = silencedBySolo(session, audioChannelKey(o));
      audio.volume = o.muted || soloOff ? 0 : o.volume * Math.max(0, Math.min(1, envelope)) * duck;
      // Its mixer effects - the element is routed through them once it has any, or the mixer's
      // meters want it (mixerGraph.ts).
      syncElementFx(audio, `audio:${o.id}`, o.fx, !isNeutralFx(o.fx) || session.open);
      if (isPlaying) resumeMixer();
    });
  };
  useEffect(() => {
    syncAudioOverlaysRef.current();
  }, [currentOutputTime, isPlaying, editStore.audioOverlays, mixerSession]);
  // The mixer's strips: the video's own sound, each audio track (its pieces together) and each
  // picture-in-picture whose sound plays.
  const mixerChannels = useMemo<MixerChannel[]>(() => {
    const channels: MixerChannel[] = [
      { key: VIDEO_CHANNEL, name: "Video sound", kind: "video", volume: editStore.videoAudioVolume, muted: editStore.videoAudioMuted, fx: editStore.videoAudioFx, meterIds: ["video"] },
    ];
    const groups = new Map<string, AudioOverlay[]>();
    for (const o of editStore.audioOverlays) {
      const key = audioChannelKey(o);
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    for (const [key, pieces] of groups) {
      const first = pieces[0];
      channels.push({
        key,
        name: audioChannelName(first),
        kind: "audio",
        volume: first.volume,
        muted: pieces.every((p) => p.muted),
        fx: first.fx,
        meterIds: pieces.map((p) => `audio:${p.id}`),
        detail: pieces.length > 1 ? `${pieces.length} pieces` : undefined,
      });
    }
    for (const p of editStore.pipOverlays) {
      if (p.muted !== false) continue;
      channels.push({
        key: pipChannelKey(p.id),
        name: fileStem(p.sourcePath),
        kind: "pip",
        volume: Number.isFinite(p.volume) ? p.volume : 1,
        muted: false,
        fx: p.fx,
        meterIds: [`pip:${p.id}`],
      });
    }
    return channels;
  }, [editStore.videoAudioVolume, editStore.videoAudioMuted, editStore.videoAudioFx, editStore.audioOverlays, editStore.pipOverlays]);

  useEffect(() => {
    if (!isPlaying || editStore.audioOverlays.length === 0) return;
    // Faster while something is ducked, so its volume ramps glide rather than step.
    const id = window.setInterval(() => syncAudioOverlaysRef.current(), anyDucked ? 40 : 100);
    return () => window.clearInterval(id);
  }, [isPlaying, editStore.audioOverlays.length, anyDucked]);

  return (
    // The webview's native menu (Save image as / Copy image / Inspect) means nothing on a timeline -
    // clips get their own menu (openClipMenu), everything else simply gets none.
    <div ref={rootRef} className="w-full flex flex-col gap-2" onContextMenu={(e) => e.preventDefault()}>
      {clipMenu && menuClip && (
        <ClipContextMenu
          anchor={clipMenu.anchor}
          clip={menuClip}
          index={menuClipIndex}
          clipCount={editStore.clips.length}
          isImage={isImageClipPath(menuClip.sourcePath)}
          canSplit={playheadInClip(menuClip) !== null}
          canDelete={isProject || editStore.clips.length > 1}
          onClose={() => setClipMenu(null)}
          onView={() => handleViewClip(menuClip)}
          onSaveAs={() => void handleSaveClipAs(menuClip, menuClipIndex)}
          onSplit={() => {
            const at = playheadInClip(menuClip);
            if (at !== null) editStore.splitAt(menuClipIndex, at);
          }}
          selectionCount={menuSelection.length}
          mergeIsInstant={menuSelection.length > 1 && mergeClipsInPlace(editStore.clips, menuSelection) !== null}
          onMerge={() => {
            const ids = menuSelection;
            if (mergeClipsInPlace(editStore.clips, ids)) {
              void editStore.mergeClips(ids, videoPixelSize).then((mergedId) => mergedId && setSelectedClipId(mergedId));
              return;
            }
            if (mergingIds) return; // one render at a time
            setMergingIds(ids);
            runBusy(`Merging ${ids.length} clips…`, async () => {
              try {
                const mergedId = await editStore.mergeClips(ids, videoPixelSize);
                if (mergedId) setSelectedClipId(mergedId);
              } finally {
                setMergingIds(null);
              }
            });
          }}
          onDuplicate={() => (menuSelection.length > 1 ? editStore.duplicateClips(menuSelection) : editStore.duplicateClip(menuClip.id))}
          onReplace={() => void handleReplaceClip(menuClip.id)}
          onInsert={(where) => void handleInsertClipViaPicker(false, where === "before" ? menuClipIndex : menuClipIndex + 1)}
          onFreezeFrame={() => {
            const at = playheadInClip(menuClip);
            if (at === null) return;
            const clipId = menuClip.id;
            runBusy("Freezing the frame…", async () => {
              const still = await invoke<string>("extract_frame_still", { sourcePath: menuClip.sourcePath, time: at });
              editStore.freezeFrame(clipId, at, still, FREEZE_FRAME_SECONDS);
            });
          }}
          onToggleReverse={() => {
            const clip = menuClip;
            if (clip.reversedFrom) {
              editStore.setClipReversed(clip.id, null);
              return;
            }
            runBusy("Reversing the clip…", async () => {
              const reversed = await invoke<string>("render_reversed_clip", { sourcePath: clip.sourcePath, start: clip.start, end: clip.end });
              editStore.setClipReversed(clip.id, reversed);
            });
          }}
          onMove={(target) => moveClip(menuClipIndex, target)}
          onSetTransition={(type) =>
            editStore.updateClipEffects(menuClip.id, {
              transitionIn: type ? { type, duration: menuClip.transitionIn?.duration ?? DEFAULT_TRANSITION_DURATION } : undefined,
            })
          }
          onSetMotion={(preset) =>
            editStore.updateClipEffects(menuClip.id, {
              kenBurns: preset ? { ...menuClip.kenBurns, preset, intensity: menuClip.kenBurns?.intensity ?? DEFAULT_KEN_BURNS_INTENSITY } : undefined,
            })
          }
          onSetColor={(preset) =>
            editStore.updateClipEffects(menuClip.id, {
              colorFilter: preset === "none" ? undefined : { preset, intensity: menuClip.colorFilter?.intensity ?? DEFAULT_COLOR_INTENSITY },
            })
          }
          onSetAllImageLengths={(seconds) => editStore.setImageClipLengths(seconds)}
          onSetLength={(seconds) => editStore.resizeClipEdge(menuClip.id, "end", menuClip.start + seconds * (menuClip.speed ?? 1))}
          onToggleMirror={() => editStore.updateClipEffects(menuClip.id, { flipHorizontal: !menuClip.flipHorizontal })}
          onOpenEffects={() => setEffectsPopoverAnchor({ left: clipMenu.anchor.left, top: clipMenu.anchor.top })}
          onReveal={() => invoke("open_file_from_directory", { filepath: menuClip.sourcePath }).catch((error) => console.error("Failed to reveal file:", error))}
          onDelete={() => {
            if (menuSelection.length > 1) editStore.deleteClips(menuSelection);
            else editStore.deleteClipAt(menuClipIndex);
            setSelectedClipId(null);
          }}
        />
      )}
      {viewerIndex >= 0 && (
        <ClipViewerModal
          clip={editStore.clips[viewerIndex]}
          index={viewerIndex}
          clipCount={editStore.clips.length}
          frame={videoPixelSize}
          onClose={() => setViewerClipId(null)}
        />
      )}
      {/* Hidden capture rig - never shown, just decodes frames for the filmstrip/cover. */}
      {/* crossOrigin="anonymous" is required here, not optional - without it, drawing this asset://-
          sourced video onto captureCanvasRef taints the canvas, and toDataURL() throws
          ("Tainted canvases may not be exported") on every single capture. That throw happens
          inside captureFrameAt's "seeked" listener, outside the promise chain, so it was never
          visible as a rejection anywhere - it just silently killed the filmstrip and cover capture
          permanently for every video. Same fix already applied to asset://-sourced <img>s
          elsewhere (imageObjectCache.ts, boardImageCache.ts) - just never carried over to this
          <video> capture rig. */}
      <video ref={hiddenVideoRef} src={playableSrc} crossOrigin="anonymous" muted preload="metadata" style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
      <canvas ref={captureCanvasRef} style={{ display: "none" }} />
      {editStore.audioOverlays.map((o) => (
        <audio
          key={o.id}
          // Only registers - an inline ref is detached and re-attached on every render, so pausing
          // on detach here paused the audio several times a second during playback (the sync
          // effect then restarted it), which is what made audio overlays skip. Removal is handled
          // by the effect after audioElementsRef's declaration.
          ref={(el) => {
            if (el) audioElementsRef.current.set(o.id, el);
          }}
          src={convertFileSrc(o.src)}
          // Lets Web Audio read its samples (the mixer's effects and meters) - asset:// answers CORS.
          crossOrigin="anonymous"
          preload="auto"
          onError={(e) => {
            const el = e.currentTarget;
            console.error("Audio overlay failed to load:", o.src, "mediaError:", el.error?.code, el.error?.message);
          }}
          style={{ display: "none" }}
        />
      ))}

      {/* Toolbar */}
      <div ref={toolbarRef} className="flex items-center justify-between gap-2 px-1 py-1 rounded-md bg-neutral-900 text-neutral-200 min-w-0">
        {/* Select tool stays fixed (never scrolls away) - only the tool cluster to its right, which
            keeps growing as features get added, scrolls once the panel is too narrow to fit it all.
            min-w-0 on every ancestor down to the scroll container itself is required for the
            overflow-x-auto below to ever actually kick in - a flex child's default min-width:auto
            otherwise refuses to shrink below its content's own natural width, which would silently
            defeat this and just widen the whole toolbar (or overflow the panel) instead of scrolling. */}
        <div className="flex items-center gap-0.5 min-w-0">
          <button
            ref={toolModeButtonRef}
            type="button"
            title={toolMode === "razor" ? "Razor tool - click a clip or audio to cut it there" : "Select tool"}
            onClick={() => {
              if (toolModeAnchor) {
                setToolModeAnchor(null);
                return;
              }
              const rect = toolModeButtonRef.current?.getBoundingClientRect();
              if (rect) setToolModeAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center gap-0.5 justify-center h-7 px-1.5 rounded text-white ${
              toolMode === "razor" ? "bg-blue-600" : "bg-neutral-700"
            }`}
          >
            {toolMode === "razor" ? <IoCutOutline size={14} /> : <BsCursor size={13} />}
            <IoChevronDown size={10} />
          </button>
          <ToolSearch toolbarRef={toolbarRef} />
          <div className="w-px h-5 bg-neutral-700 mx-1 shrink-0" />
          <div className="timeline-toolbar-scroll flex items-center gap-0.5 min-w-0 overflow-x-auto">
          <ActionButton title="Undo" onClick={editStore.undo} disabled={!editStore.canUndo}>
            <IoArrowUndo size={15} />
          </ActionButton>
          <ActionButton title="Redo" onClick={editStore.redo} disabled={!editStore.canRedo}>
            <IoArrowRedo size={15} />
          </ActionButton>
          <div className="w-px h-5 bg-neutral-700 mx-1 shrink-0" />
          <ActionButton
            title={selectedPip ? "Split selected PiP at playhead" : "Split at playhead"}
            onClick={handleSplit}
            disabled={selectedPip ? !(currentOutputTime > selectedPip.startTime && currentOutputTime < selectedPip.endTime) : duration <= 0}
          >
            <IoCutOutline size={15} />
          </ActionButton>
          <ActionButton
            title={selectedPip ? "Delete selected PiP piece" : selectedClipId ? "Delete selected clip" : "Delete clip at playhead"}
            onClick={handleDeleteSegment}
            disabled={!selectedPip && editStore.clips.length <= 1}
          >
            <IoTrashOutline size={15} />
          </ActionButton>
          <div className="w-px h-5 bg-neutral-700 mx-1 shrink-0" />
          <ActionButton
            title={selectedClipId ? (isCroppingClip ? "Stop cropping" : "Crop clip") : "Select a clip to crop"}
            onClick={() => onToggleCroppingClip?.()}
            disabled={!selectedClipId}
          >
            <IoCropOutline size={15} className={isCroppingClip ? "text-blue-400" : undefined} />
          </ActionButton>
          <button
            ref={speedButtonRef}
            type="button"
            title={selectedClipId ? (selectedCount > 1 ? `Speed for ${selectionLabel}` : "Clip speed") : "Select a clip to change its speed"}
            disabled={!selectedClipId}
            onClick={() => {
              if (speedPopoverAnchor) {
                setSpeedPopoverAnchor(null);
                return;
              }
              const rect = speedButtonRef.current?.getBoundingClientRect();
              if (rect) setSpeedPopoverAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors disabled:text-neutral-600 disabled:cursor-default ${
              speedPopoverAnchor ? "bg-neutral-700 text-blue-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <IoSpeedometerOutline size={15} className={selectedClip?.speed && selectedClip.speed !== 1 ? "text-blue-400" : undefined} />
          </button>
          <button
            ref={noiseReductionButtonRef}
            type="button"
            title={selectedIsImage ? IMAGE_CLIP_TOOL_HINT : selectedClipId ? "Clean up audio (reduce or remove noise, hum, rumble)" : "Select a clip to clean up its audio"}
            disabled={!selectedClipId || selectedIsImage}
            onClick={() => {
              if (noiseReductionPopoverAnchor) {
                setNoiseReductionPopoverAnchor(null);
                return;
              }
              const rect = noiseReductionButtonRef.current?.getBoundingClientRect();
              if (rect) setNoiseReductionPopoverAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors disabled:text-neutral-600 disabled:cursor-default ${
              noiseReductionPopoverAnchor ? "bg-neutral-700 text-blue-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            {selectedClipId === activeClip?.id && noiseReductionStatus === "calibrating" ? (
              <IoSyncOutline size={15} className="text-blue-400 animate-spin" />
            ) : (
              <MdOutlineNoiseControlOff size={15} className={selectedClip && hasAudioCleanup(selectedClip) ? "text-blue-400" : undefined} />
            )}
          </button>
          <button
            ref={extractAudioButtonRef}
            type="button"
            title={selectedIsImage ? IMAGE_CLIP_TOOL_HINT : selectedClipId ? "Extract or detach audio" : "Select a clip to extract or detach its audio"}
            disabled={!selectedClipId || selectedIsImage}
            onClick={() => {
              if (extractAudioAnchor) {
                setExtractAudioAnchor(null);
                return;
              }
              const rect = extractAudioButtonRef.current?.getBoundingClientRect();
              if (rect) setExtractAudioAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors disabled:text-neutral-600 disabled:cursor-default ${
              extractAudioAnchor ? "bg-neutral-700 text-blue-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <IoDownloadOutline size={15} />
          </button>
          <ActionButton
            title={selectedClipId ? `Mirror ${selectionLabel} horizontally` : "Select a clip to mirror"}
            onClick={() => selectedClip && updateSelectedClips({ flipHorizontal: !selectedClip.flipHorizontal })}
            disabled={!selectedClipId}
          >
            <MdFlip size={15} className={selectedClip?.flipHorizontal ? "text-blue-400" : undefined} />
          </ActionButton>
          <button
            ref={effectsButtonRef}
            type="button"
            title={selectedClipId ? (selectedCount > 1 ? `Effects for ${selectionLabel}` : "Clip effects") : "Select a clip to edit its effects"}
            disabled={!selectedClipId}
            onClick={() => {
              if (effectsPopoverAnchor) {
                setEffectsPopoverAnchor(null);
                return;
              }
              const rect = effectsButtonRef.current?.getBoundingClientRect();
              if (rect) setEffectsPopoverAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors disabled:text-neutral-600 disabled:cursor-default ${
              effectsPopoverAnchor ? "bg-neutral-700 text-blue-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <IoSparklesOutline size={15} />
          </button>
          <button
            ref={silenceButtonRef}
            type="button"
            title={selectedIsImage ? IMAGE_CLIP_TOOL_HINT : selectedClipId ? "Find and remove silent gaps in this clip" : "Select a clip to trim silence"}
            disabled={!selectedClipId || selectedIsImage}
            onClick={() => {
              if (silenceAnchor) {
                setSilenceAnchor(null);
                return;
              }
              void handleDetectSilence();
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors disabled:text-neutral-600 disabled:cursor-default ${
              silenceAnchor ? "bg-neutral-700 text-blue-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <MdGraphicEq size={15} />
          </button>
          <button
            ref={autoZoomButtonRef}
            type="button"
            title={selectedIsImage ? IMAGE_CLIP_TOOL_HINT : selectedClipId ? "Zoom in automatically on recorded clicks in this clip" : "Select a clip to auto zoom"}
            disabled={!selectedClipId || selectedIsImage}
            onClick={() => {
              if (autoZoomAnchor) {
                setAutoZoomAnchor(null);
                return;
              }
              void handleDetectAutoZoom();
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors disabled:text-neutral-600 disabled:cursor-default ${
              autoZoomAnchor ? "bg-neutral-700 text-blue-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <IoLocateOutline size={15} />
          </button>
          <button
            ref={viewSwitchButtonRef}
            type="button"
            title={selectedIsImage ? IMAGE_CLIP_TOOL_HINT : selectedClipId ? "Cut to the camera during recorded screen/camera view switches in this clip" : "Select a clip to apply view switches"}
            disabled={!selectedClipId || selectedIsImage}
            onClick={() => {
              if (viewSwitchAnchor) {
                setViewSwitchAnchor(null);
                return;
              }
              void handleDetectViewSwitch();
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors disabled:text-neutral-600 disabled:cursor-default ${
              viewSwitchAnchor ? "bg-neutral-700 text-blue-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <IoSwapHorizontal size={15} />
          </button>
          <ActionButton
            title={isPlacingText ? "Click the video preview to place text" : "Add text overlay"}
            onClick={() => onToggleArmPlaceText?.()}
          >
            <IoText size={15} className={isPlacingText ? "text-blue-400" : undefined} />
          </ActionButton>
          <button
            ref={captionsButtonRef}
            type="button"
            title="Captions - generate, style and burn in captions"
            onClick={() => {
              if (captionsAnchor) {
                setCaptionsAnchor(null);
                return;
              }
              const rect = captionsButtonRef.current?.getBoundingClientRect();
              if (rect) setCaptionsAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${
              captionsAnchor ? "bg-neutral-700 text-blue-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <MdClosedCaptionOff size={16} className={editStore.captions?.settings.enabled ? "text-blue-400" : undefined} />
          </button>
          <button
            ref={transcriptButtonRef}
            type="button"
            title="Edit by transcript - delete words to cut them, remove filler words and long pauses"
            onClick={() => {
              if (transcriptAnchor) {
                setTranscriptAnchor(null);
                return;
              }
              const rect = transcriptButtonRef.current?.getBoundingClientRect();
              if (rect) setTranscriptAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${
              transcriptAnchor ? "bg-neutral-700 text-blue-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <IoDocumentTextOutline size={15} />
          </button>
          <ActionButton
            title={isPlacingImage ? "Choosing an image…" : "Add image overlay"}
            onClick={() => onToggleArmPlaceImage?.()}
          >
            <IoImageOutline size={15} className={isPlacingImage ? "text-amber-400" : undefined} />
          </ActionButton>
          <button
            type="button"
            data-elements-trigger
            title="Add shapes and animated elements"
            onClick={(e) => {
              if (elementsAnchor) {
                setElementsAnchor(null);
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              setElementsAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${
              elementsAnchor ? "bg-neutral-700 text-amber-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <IoShapesOutline size={15} />
          </button>
          <button
            type="button"
            title="Split screen - several shots at once"
            onClick={(e) => {
              if (splitAnchor) {
                setSplitAnchor(null);
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              setSplitAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${
              splitAnchor ? "bg-neutral-700 text-fuchsia-400" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <MdViewQuilt size={16} />
          </button>
          <button
            type="button"
            title="Highlight intro - a burst of quick cuts before the video"
            onClick={(e) => {
              if (introAnchor) {
                setIntroAnchor(null);
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              setIntroAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${
              introAnchor ? "bg-neutral-700 text-amber-300" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <MdFlashOn size={16} />
          </button>
          <ActionButton
            title={isPlacingBlur ? "Click the video preview to place a blur region" : "Add blur region"}
            onClick={() => onToggleArmPlaceBlur?.()}
          >
            <MdBlurOn size={15} className={isPlacingBlur ? "text-sky-400" : undefined} />
          </ActionButton>
          <ActionButton title="Add adjustment layer - grade or blur everything beneath it for a stretch of the video" onClick={addAdjustmentLayer}>
            <IoColorFilterOutline size={15} className={selectedAdjustmentId ? "text-violet-300" : undefined} />
          </ActionButton>
          <button
            type="button"
            title="Chapters - for the exported file and YouTube"
            onClick={(e) => {
              if (chaptersAnchor) {
                setChaptersAnchor(null);
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              setChaptersAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${chaptersAnchor ? "bg-neutral-700 text-violet-300" : "text-neutral-300 hover:bg-neutral-700"}`}
          >
            <IoBookmarkOutline size={15} />
          </button>
          <button
            type="button"
            data-screen-style-panel
            title="Screen style - frame the video on a wallpaper with rounded corners and a shadow; smooth the pointer, show clicks and shortcut keys"
            onClick={(e) => {
              if (screenStyleAnchor) {
                setScreenStyleAnchor(null);
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              setScreenStyleAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${screenStyleAnchor ? "bg-neutral-700 text-emerald-300" : "text-neutral-300 hover:bg-neutral-700"}`}
          >
            <MdOutlineWallpaper size={15} className={editStore.screenStyle ? "text-emerald-300" : undefined} />
          </button>
          <ActionButton
            title={isPlacingPip ? "Choosing a video file…" : "Add picture-in-picture video (e.g. a separately-recorded webcam)"}
            onClick={() => onToggleArmPlacePip?.()}
          >
            <MdPictureInPictureAlt size={15} className={isPlacingPip ? "text-fuchsia-400" : undefined} />
          </ActionButton>
          <ActionButton title="Add B-roll - videos over the main one, full frame, on a video track above it" onClick={() => void handleAddBroll()}>
            <MdVideoLibrary size={15} />
          </ActionButton>
          {onFindAndHide && (
            <ActionButton title="Find & hide - draw around something once (a logo, a name, a face) and blur or cover it everywhere it appears" onClick={onFindAndHide}>
              <IoEyeOffOutline size={16} />
            </ActionButton>
          )}
          {onMarkWebcamBubble && (
            <ActionButton title="Fix webcam background - blur or replace what's behind you in a webcam bubble recorded into the video" onClick={onMarkWebcamBubble}>
              <IoPersonCircleOutline size={16} />
            </ActionButton>
          )}
          <button
            type="button"
            data-music-library-button
            title={isPlacingAudio ? "Choosing an audio file…" : "Add music & sound effects (free library, or a file of your own)"}
            onClick={(e) => {
              if (musicAnchor) {
                setMusicAnchor(null);
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              setMusicAnchor({ left: rect.left, top: rect.bottom + 4 });
            }}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${
              musicAnchor ? "bg-neutral-700 text-teal-300" : "text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            <IoMusicalNotesOutline size={15} className={isPlacingAudio ? "text-teal-400" : undefined} />
          </button>
          <button
            ref={mixerButtonRef}
            type="button"
            data-mixer-button
            title="Mixer - levels, EQ and compression for every sound"
            onClick={() => (mixerAnchor ? setMixerAnchor(null) : openMixer(null))}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${mixerAnchor ? "bg-neutral-700 text-teal-300" : "text-neutral-300 hover:bg-neutral-700"}`}
          >
            <MdTune size={15} />
          </button>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            title="Make it a Short - your best moments as vertical clips with captions"
            onClick={() => setShortsOpen(true)}
            disabled={captionSourcePaths.length === 0 || !editStore.editState}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium text-violet-200 bg-violet-500/15 hover:bg-violet-500/25 transition-colors disabled:opacity-40 disabled:cursor-default"
          >
            <IoSparkles size={13} />
            Shorts
          </button>
          <div className="flex items-center">
            <button
              type="button"
              title={editStore.exportError ?? "Save the trimmed/cut/reordered result as a new file - the original is never modified"}
              onClick={handleSave}
              // An unedited recording would only export a copy of itself, so Save waits for an edit -
              // but a project has never been rendered at all, so it can always be saved (once it
              // has a clip).
              disabled={(isProject ? editStore.clips.length === 0 : !editStore.canUndo) || preparingExport}
              className="flex items-center gap-1.5 h-7 pl-2.5 pr-2 rounded-l text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-400 disabled:cursor-default"
            >
              <IoSaveOutline size={14} />
              {preparingExport ? "Preparing…" : "Save"}
            </button>
            <button
              ref={exportOptionsButtonRef}
              type="button"
              title="Export options (quality, destination)"
              disabled={!editStore.canUndo || preparingExport}
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
      <div className="relative w-full flex border border-neutral-800 rounded-md overflow-hidden bg-neutral-950 text-neutral-200">
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
                  <ViewportClampedMenu
                    anchor={moreMenuPosition}
                    className="w-56 bg-neutral-800 border border-neutral-700 rounded-md shadow-lg z-50 text-sm text-neutral-200 whitespace-nowrap"
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
                      <IoAddCircleOutline size={13} /> Insert videos or images…
                    </button>
                    {/* A project file isn't media ffmpeg can convert - Save renders it instead. */}
                    {!isProject && (
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
                    )}
                    {fileTransfer && (
                      <button
                        type="button"
                        className="w-full flex items-center gap-1.5 text-left px-3 py-2 hover:bg-neutral-700"
                        onClick={() => {
                          setMenuOpen(false);
                          setTransferAnchor(moreMenuPosition);
                        }}
                      >
                        <IoFolderOutline size={13} /> Move or copy to…
                      </button>
                    )}
                    {!isProject && (
                      <button
                        type="button"
                        className="w-full flex items-center gap-1.5 text-left px-3 py-2 hover:bg-neutral-700"
                        onClick={() => {
                          setMenuOpen(false);
                          openPhoneTransfer([file]);
                        }}
                      >
                        <IoPhonePortraitOutline size={13} /> Transfer to phone
                      </button>
                    )}
                    {onSetThumbnail && !isProject && (
                      <button
                        type="button"
                        className="w-full flex items-center gap-1.5 text-left px-3 py-2 hover:bg-neutral-700"
                        onClick={() => {
                          setMenuOpen(false);
                          onSetThumbnail();
                        }}
                      >
                        <IoImageOutline size={13} /> Set thumbnail…
                      </button>
                    )}
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
                  </ViewportClampedMenu>
                </>,
                document.body
              )}
          </div>

          {fileTransfer && transferAnchor && <MoveCopyMenu files={[file]} options={fileTransfer} anchor={transferAnchor} alwaysDark onClose={() => setTransferAnchor(null)} />}

          {/* Clicking the cover opens "Set thumbnail" - the place people look for it. */}
          <button
            type="button"
            title={onSetThumbnail && !isProject ? "Set thumbnail…" : "Cover"}
            disabled={!onSetThumbnail || isProject}
            onClick={() => onSetThumbnail?.()}
            className="mt-1 w-10 h-7 rounded border border-neutral-700 bg-neutral-800 flex items-center justify-center overflow-hidden enabled:hover:ring-2 enabled:hover:ring-blue-400 disabled:cursor-default"
          >
            {savedThumbnail || coverThumbnail ? (
              <img
                src={savedThumbnail ?? coverThumbnail ?? undefined}
                alt="Cover"
                className="w-full h-full object-cover"
                onError={() => setSavedThumbnail(null)}
              />
            ) : (
              <span className="text-[8px] text-neutral-500">Cover</span>
            )}
          </button>
        </div>

        {/* Scrollable ruler + track */}
        {/* Capped height: lanes only exist once something is on them (empty ones are hidden
            above), and past ~4 lanes the stack scrolls vertically here instead of growing the
            panel up over the video preview. The ruler stays pinned while scrolling. */}
        <div ref={trackAreaRef} className="flex-1 max-h-[236px] overflow-x-auto overflow-y-auto relative select-none">
          {/* An empty project's track fills the panel (its drop zone/"Add media" needs the room);
              otherwise the clips' own width plus space for the "+" after the last clip. */}
          <div
            ref={trackContentRef}
            style={isProject && baseClips.length === 0 ? { width: "100%", minWidth: 320 } : { width: Math.max(totalWidth, laneEndTime * pxPerSec) + ADD_BUTTON_ROOM_PX }}
            className="relative"
          >
            {/* Ruler - represents the *assembled* (playback-order) timeline, not raw source time */}
            <div
              className="sticky top-0 z-30 bg-neutral-950 h-6 border-b border-neutral-800 cursor-pointer"
              onPointerDown={handleScrubPointerDown}
              onPointerMove={handleScrubPointerMove}
            >
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 h-full flex flex-col items-start" style={{ left: t * pxPerSec }}>
                  <div className="w-px h-2 bg-neutral-700" />
                  <span className="text-[10px] text-neutral-500 pl-1">{formatTimestamp(t)}</span>
                </div>
              ))}
              {/* Beat markers (beat sync) - small amber ticks along the bottom of the ruler. */}
              {beatTimes.map((t, i) => (
                <div key={`beat-${i}`} className="absolute bottom-0 w-px h-2 bg-amber-400/80 pointer-events-none" style={{ left: t * pxPerSec }} />
              ))}
              {/* Chapter markers - violet flags; the label shows on hover. */}
              {chapterMarks.map((c) => (
                <div key={c.id} title={c.label} className="absolute top-0 h-full pointer-events-auto" style={{ left: c.time * pxPerSec }}>
                  <div className="absolute top-0 bottom-0 w-px bg-violet-400/90" />
                  <div className="absolute top-0 left-0 w-2.5 h-2 bg-violet-400/90" style={{ clipPath: "polygon(0 0, 100% 0, 70% 50%, 100% 100%, 0 100%)" }} />
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
              {busyMessage && (
                <div
                  className={`absolute right-2 -top-6 z-30 px-2 py-0.5 rounded-full text-[10px] font-medium shadow ring-1 ring-black/40 ${
                    busyMessage.error ? "bg-red-600 text-white" : "bg-neutral-800 text-white/80"
                  }`}
                >
                  {busyMessage.text}
                </div>
              )}
              {isProject && baseClips.length === 0 && (
                <div className="absolute inset-1 flex items-center justify-center gap-2 rounded border border-dashed border-neutral-600 text-[11px] text-neutral-400">
                  Drop images or videos here, or
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => void handleInsertClipViaPicker()}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-teal-600 text-white hover:bg-teal-500"
                  >
                    <IoAddCircleOutline size={12} /> Add media
                  </button>
                </div>
              )}
              {renderClips.map((clip, i) => {
                const isPending = clip.id === "__pending__";
                const left = outputStarts[i] * pxPerSec;
                const width = Math.max(1, clipDurations[i] * pxPerSec);
                const isSelected = selectedClipIds.includes(clip.id);
                const isDragging = clipDrag?.index === i && clipDrag.isDragging;
                const isDragOver = clipDrag?.isDragging && clipDrag.overIndex === i && clipDrag.index !== i;
                // Fixed-width tiles (video aspect at THUMB_TILE_HEIGHT), each showing the cached
                // frame nearest the source time at its own center - so tile count, and therefore
                // how many distinct shots are visible, grows with zoom instead of stretching a
                // fixed handful of frames across the clip.
                const tileWidth = videoPixelSize ? Math.max(24, Math.round((THUMB_TILE_HEIGHT * videoPixelSize.width) / videoPixelSize.height)) : 92;
                const tileCount = Math.max(1, Math.ceil(width / tileWidth));
                const isForeignVideo = !isImageClipPath(clip.sourcePath) && clip.sourcePath !== file.path;
                const clipThumbs = thumbnails.length === 0 || isForeignVideo ? [] : Array.from({ length: tileCount }, (_, k) => {
                  const outputOffset = Math.min((k + 0.5) * tileWidth, width) / pxPerSec;
                  return nearestFrame(thumbnails, Math.min(clip.end, outputOffsetToSource(clip, outputOffset)));
                });
                return (
                  <div
                    key={clip.id}
                    onPointerDown={isPending ? undefined : handleClipPointerDown(baseClips[i], i)}
                    onContextMenu={isPending ? undefined : openClipMenu(baseClips[i])}
                    onPointerMove={toolMode === "razor" ? undefined : handleClipDragMove}
                    onPointerUp={toolMode === "razor" ? undefined : endClipDrag}
                    onPointerCancel={toolMode === "razor" ? undefined : endClipDrag}
                    title={isPending ? undefined : toolMode === "razor" ? `Clip ${i + 1} of ${renderClips.length} — click to split here` : `Clip ${i + 1} of ${renderClips.length} — click to select (Ctrl/Shift-click for more), drag to reorder`}
                    className={`absolute inset-y-1 rounded overflow-hidden border-2 bg-black flex ${
                      isPending ? "" : toolMode === "razor" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"
                    } ${isSelected ? "border-dashed border-white" : "border-teal-500"} ${isDragging ? "opacity-40" : ""} ${
                      mergingIds?.includes(clip.id) ? "animate-pulse" : ""
                    } ${
                      isDragOver ? "ring-2 ring-blue-400" : ""
                    }`}
                    style={{ left, width }}
                  >
                    {isImageClipPath(clip.sourcePath) ? (
                      <ImageClipTiles sourcePath={clip.sourcePath} tileCount={tileCount} tileWidth={tileWidth} />
                    ) : isForeignVideo ? (
                      <ForeignVideoClipTiles clip={clip} tileCount={tileCount} tileWidth={tileWidth} width={width} pxPerSec={pxPerSec} />
                    ) : clipThumbs.length > 0 ? (
                      clipThumbs.map((t, ti) =>
                        t ? (
                          <img key={ti} src={t.src} className="h-full shrink-0 object-cover" style={{ width: tileWidth }} draggable={false} alt="" />
                        ) : (
                          <div key={ti} className="h-full shrink-0 bg-neutral-800" style={{ width: tileWidth }} />
                        )
                      )
                    ) : (
                      <div className="h-full w-full bg-neutral-800" />
                    )}
                    {/* What's on this clip - look, colour, effect, motion, speed, framing, sound -
                        as small badges; clicking them opens the clip's effects. */}
                    {!isPending &&
                      (() => {
                        const badges = clipEffectBadges(baseClips[i] ?? clip, {
                          look: (name) => GRADE_LOOKS.find((l) => l.value === name)?.label,
                          fx: (kind) => CLIP_FX.find((f) => f.value === kind)?.label,
                        });
                        if (!badges.length) return null;
                        const summary = badges.map((b) => b.label).join(" · ");
                        return (
                          <button
                            type="button"
                            title={`${summary} - click to edit this clip's effects`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setSelectedClipIds([clip.id]);
                              setEffectsPopoverAnchor({ left: rect.left, top: rect.bottom + 4 });
                            }}
                            className="absolute top-0.5 left-0.5 z-[6] flex gap-0.5 overflow-hidden rounded-sm hover:ring-1 hover:ring-white/70"
                            style={{ maxWidth: Math.max(0, width - 8) }}
                          >
                            {badges.map((b) => (
                              <span key={b.key} className={`shrink-0 px-1 rounded-sm text-[8.5px] leading-[13px] font-semibold tracking-wide whitespace-nowrap ${BADGE_TONES[b.tone]}`}>
                                {b.label}
                              </span>
                            ))}
                          </button>
                        );
                      })()}
                    {!isPending && !isImageClipPath(clip.sourcePath) && (
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

              {/* "+" right after the last clip - the quick way to keep adding images/videos to the
                  end, without hunting for "Insert" in the track menu. Pointer-down is stopped so it
                  doesn't also scrub the playhead under it. */}
              {baseClips.length > 0 && !resizeDrag && !clipDrag?.isDragging && (
                <button
                  type="button"
                  title="Add images or videos to the end"
                  aria-label="Add images or videos to the end"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => void handleInsertClipViaPicker(true)}
                  className="absolute top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center bg-neutral-800 border border-dashed border-teal-500/70 text-teal-400 shadow-sm hover:bg-teal-500 hover:text-white hover:border-solid hover:border-teal-400 hover:scale-105 active:scale-95 transition-all"
                  style={{ left: totalOutputDuration * pxPerSec + 10 }}
                >
                  <IoAdd size={20} />
                </button>
              )}

              {/* Transitions - at each boundary where the clip on the RIGHT has transitionIn set: a band
                  over the stretch of that clip the transition plays across (its first `d` seconds -
                  see transition_fold_step), the boundary marker, and the transition's name in small
                  type under the cut. The name opens that clip's menu, to change or remove it. */}
              {renderClips.map((clip, i) => {
                if (i === 0 || clip.id === "__pending__" || !clip.transitionIn) return null;
                if (mergingIds?.includes(clip.id) && i > firstMergingIndex) return null; // the merge's Cancel sits there
                const left = outputStarts[i] * pxPerSec;
                const label = TRANSITION_PRESETS.find((p) => p.value === clip.transitionIn?.type)?.label ?? "Transition";
                const seconds = transitionDuration(clip);
                return (
                  <React.Fragment key={`transition-${clip.id}`}>
                    <div
                      className="absolute inset-y-1 rounded-r pointer-events-none z-[5] bg-gradient-to-r from-blue-400/45 to-blue-400/0"
                      style={{ left, width: seconds * pxPerSec }}
                    />
                    <div
                      title={`${label} · ${seconds.toFixed(1)}s`}
                      className="absolute inset-y-1 w-4 -ml-2 flex items-center justify-center rounded bg-blue-500/80 z-10 pointer-events-none"
                      style={{ left }}
                    >
                      <IoSwapHorizontalOutline size={10} className="text-white" />
                    </div>
                    <button
                      type="button"
                      title={`${label} · ${seconds.toFixed(1)}s - click to change`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => openClipMenu(baseClips[i])(e)}
                      className="absolute z-20 -translate-x-1/2 px-1 rounded-sm bg-blue-600 text-[9px] leading-[13px] font-medium text-white whitespace-nowrap shadow ring-1 ring-black/40 hover:bg-blue-500"
                      style={{ left, bottom: -6 }}
                    >
                      {label}
                    </button>
                  </React.Fragment>
                );
              })}

              {/* A rendered merge in progress: a fast spinner on every break point between the clips it's
                  joining, and a Cancel under each (where a transition's name usually sits) that stops
                  the render and leaves the timeline as it was. */}
              {mergingIds &&
                renderClips.map((clip, i) => {
                  if (i <= firstMergingIndex || !mergingIds.includes(clip.id)) return null;
                  const left = outputStarts[i] * pxPerSec;
                  return (
                    <React.Fragment key={`merging-${clip.id}`}>
                      <div className="absolute inset-y-1 z-30 -translate-x-1/2 flex items-center justify-center pointer-events-none" style={{ left }}>
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/60">
                          <SpokeWheel />
                        </span>
                      </div>
                      <button
                        type="button"
                        title="Stop merging - the clips stay as they were"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => editStore.cancelMerge()}
                        className="absolute z-30 -translate-x-1/2 px-1.5 rounded-sm bg-neutral-700 text-[9px] leading-[13px] font-medium text-white whitespace-nowrap shadow ring-1 ring-black/40 hover:bg-red-600"
                        style={{ left, bottom: -6 }}
                      >
                        Cancel
                      </button>
                    </React.Fragment>
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
                    {/* Each handle sits just inside its own clip's edge rather than centred on it -
                        centred, a clip's end handle and the next clip's start handle covered the
                        same pixels and the later one always won, so only the last clip's end could
                        ever be dragged out to lengthen it. */}
                    <div
                      onPointerDown={beginResizeDrag(baseClips[i], i, "start")}
                      onPointerMove={handleResizeDragMove}
                      onPointerUp={endResizeDrag}
                      onPointerCancel={endResizeDrag}
                      title={isImageClipPath(clip.sourcePath) ? "Drag to change how long this image shows" : "Drag to trim this clip's start"}
                      className="absolute inset-y-1 w-2 bg-teal-400 hover:bg-teal-300 rounded cursor-ew-resize z-10"
                      style={{ left }}
                    />
                    <div
                      onPointerDown={beginResizeDrag(baseClips[i], i, "end")}
                      onPointerMove={handleResizeDragMove}
                      onPointerUp={endResizeDrag}
                      onPointerCancel={endResizeDrag}
                      title={isImageClipPath(clip.sourcePath) ? "Drag to change how long this image shows" : "Drag to trim this clip's end"}
                      className="absolute inset-y-1 w-2 -ml-2 bg-teal-400 hover:bg-teal-300 rounded cursor-ew-resize z-10"
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
            <div className={`h-8 relative border-t border-neutral-800 ${renderOverlays.length === 0 ? "hidden" : ""}`}>
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
            <div className={`h-8 relative border-t border-neutral-800 ${renderImageOverlays.length === 0 ? "hidden" : ""}`}>
              {renderImageOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = Math.max(1, (overlay.endTime - overlay.startTime) * pxPerSec);
                const isSelected = selectedImageOverlayId === overlay.id;
                const fileName = overlay.asset ? assetEntry(overlay.asset.kind).label : overlay.src.split(/[\\/]/).pop() ?? overlay.src;
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
                    {overlay.asset ? <IoShapesOutline size={11} className="shrink-0" /> : <IoImageOutline size={11} className="shrink-0" />}
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
            <div className={`h-8 relative border-t border-neutral-800 ${renderBlurOverlays.length === 0 ? "hidden" : ""}`}>
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

            {/* Adjustment-layer lane - violet; the chip names what the layer does. */}
            <div className={`h-8 relative border-t border-neutral-800 ${renderAdjustmentLayers.length === 0 ? "hidden" : ""}`}>
              {renderAdjustmentLayers.map((layer) => {
                const left = layer.startTime * pxPerSec;
                const width = Math.max(1, (layer.endTime - layer.startTime) * pxPerSec);
                const isSelected = selectedAdjustmentId === layer.id;
                const what = [
                  layer.look && layer.look.preset !== "none" ? layer.look.preset : null,
                  (layer.blur ?? 0) > 0 ? "blur" : null,
                  layer.region ? (layer.region.invert ? "outside" : "area") : null,
                ].filter(Boolean).join(" · ");
                return (
                  <React.Fragment key={layer.id}>
                    <div
                      onPointerDown={beginAdjustDrag(layer)}
                      onPointerMove={handleAdjustDragMove}
                      onPointerUp={endAdjustDrag}
                      onPointerCancel={endAdjustDrag}
                      title={`Adjustment layer${layer.placement === "over" ? " over everything" : " on the video"}${what ? ` - ${what}` : ""}`}
                      className={`absolute inset-y-1 rounded overflow-hidden border-2 flex items-center gap-1 px-2 text-[11px] text-white truncate cursor-grab active:cursor-grabbing ${
                        isSelected ? "border-dashed border-white bg-violet-900/60" : "border-violet-400 bg-violet-950/60"
                      }`}
                      style={{ left, width }}
                    >
                      <IoColorFilterOutline size={12} className="shrink-0" />
                      {layer.name ?? (what || "Adjustment")}
                    </div>
                    <div
                      onPointerDown={beginAdjustResizeDrag(layer, "start")}
                      onPointerMove={handleAdjustResizeDragMove}
                      onPointerUp={endAdjustResizeDrag}
                      onPointerCancel={endAdjustResizeDrag}
                      title="Drag to retime this adjustment layer's start"
                      className="absolute inset-y-1 w-2 -ml-1 bg-violet-400 hover:bg-violet-300 rounded cursor-ew-resize z-10"
                      style={{ left }}
                    />
                    <div
                      onPointerDown={beginAdjustResizeDrag(layer, "end")}
                      onPointerMove={handleAdjustResizeDragMove}
                      onPointerUp={endAdjustResizeDrag}
                      onPointerCancel={endAdjustResizeDrag}
                      title="Drag to retime this adjustment layer's end"
                      className="absolute inset-y-1 w-2 -ml-1 bg-violet-400 hover:bg-violet-300 rounded cursor-ew-resize z-10"
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
            {videoTrackLanes.map((track) => {
              const hidden = isTrackHidden(editStore.hiddenVideoTracks, track);
              const laneLayers = renderPipOverlays.filter((o) => pipTrack(o) === track);
              return (
            <div key={`vtrack-${track}`} data-video-track={track} className={`h-8 relative border-t border-neutral-800 ${pipOverlayDrag?.isDragging && pipOverlayDrag.liveTrack === track ? "bg-fuchsia-500/5" : ""}`}>
              {/* The track's name and eye - stays in view as the timeline scrolls. */}
              <div className="sticky left-0 z-20 inline-flex items-center gap-0.5 h-full pl-1 pr-1.5 bg-gradient-to-r from-neutral-950 via-neutral-950/90 to-transparent pointer-events-none">
                <span className="text-[9px] font-semibold text-fuchsia-300/80" title={`Video track ${videoTrackLabel(track)} - higher tracks draw over lower ones`}>
                  {videoTrackLabel(track)}
                  {pipOverlayDrag?.isDragging && pipOverlayDrag.liveTrack === track && laneLayers.length === 1 && !editStore.pipOverlays.some((o) => o.id !== pipOverlayDrag.id && pipTrack(o) === track) && (
                    <span className="ml-1 font-normal text-fuchsia-200/80">new track - over everything below</span>
                  )}
                </span>
                <button
                  type="button"
                  title={hidden ? `Show ${videoTrackLabel(track)} (in the preview and the saved video)` : `Hide ${videoTrackLabel(track)} (in the preview and the saved video)`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => editStore.setVideoTrackHidden(track, !hidden)}
                  className="pointer-events-auto p-0.5 rounded text-neutral-400 hover:text-white"
                >
                  {hidden ? <IoEyeOffOutline size={11} /> : <IoEyeOutline size={11} />}
                </button>
              </div>
              {laneLayers.map((overlay) => {
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
                    title={toolMode === "razor" ? "Picture-in-picture - click to split it here" : "Picture-in-picture - click to select (then Split/Delete act on it), drag to move"}
                    className={`absolute inset-y-1 rounded overflow-hidden border-2 bg-neutral-800 flex items-center justify-between gap-1 px-2 text-[11px] text-white ${hidden ? "opacity-40" : ""} ${
                      toolMode === "razor" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"
                    } ${
                      isSelected ? "border-dashed border-white" : "border-fuchsia-400"
                    }`}
                    style={{ left, width }}
                  >
                    <span className="flex items-center gap-1 min-w-0 truncate">
                      {isFullFrameLayer(overlay) ? <MdVideoLibrary size={12} className="shrink-0" /> : <MdPictureInPictureAlt size={12} className="shrink-0" />}
                      {isFullFrameLayer(overlay) ? fileStem(overlay.sourcePath) : "PiP"}
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
              {laneLayers.map((overlay) => {
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
              );
            })}

            {/* Audio-overlay lane - same time-based chip pattern as the text/image lanes above,
                teal instead of purple/amber, with a real waveform instead of an icon+filename and
                edge handles that trim into the source (resizeAudioOverlayTime) instead of just
                retiming an empty box. */}
            <div
              className={`relative border-t border-neutral-800 ${renderAudioOverlays.length === 0 ? "hidden" : ""}`}
              style={{ height: audioRows.rowCount * AUDIO_ROW_HEIGHT }}
            >
              {renderAudioOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = Math.max(1, (overlay.endTime - overlay.startTime) * pxPerSec);
                const top = (audioRows.rowOf.get(overlay.id) ?? 0) * AUDIO_ROW_HEIGHT + 4;
                const isSelected = selectedAudioOverlayId === overlay.id;
                const fileName = overlay.src.split(/[\\/]/).pop() ?? overlay.src;
                return (
                  <div
                    key={overlay.id}
                    data-audio-chip
                    onPointerDown={beginAudioOverlayDrag(overlay)}
                    onPointerMove={handleAudioOverlayDragMove}
                    onPointerUp={endAudioOverlayDrag}
                    onPointerCancel={endAudioOverlayDrag}
                    title={toolMode === "razor" ? `${fileName} — click to cut here` : overlay.label ? `${overlay.label} — ${fileName}` : fileName}
                    className={`absolute rounded overflow-hidden border-2 bg-neutral-800 ${toolMode === "razor" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"} ${
                      isSelected ? "border-dashed border-white" : "border-teal-400"
                    } ${overlay.muted ? "opacity-50" : ""}`}
                    style={{ left, width, top, height: AUDIO_ROW_HEIGHT - 8 }}
                  >
                    <AudioChipWaveform overlay={overlay} widthPx={width} heightPx={AUDIO_ROW_HEIGHT - 12} />
                    {overlay.endTime > totalOutputDuration && (
                      <div
                        title="Past the end of the video - not in the export. Drag the end handle back, or use Fit to video."
                        className="absolute inset-y-0 right-0 bg-neutral-950/70 bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgba(255,255,255,0.08)_4px_8px)] pointer-events-none"
                        style={{ width: Math.min(width, (overlay.endTime - Math.max(overlay.startTime, totalOutputDuration)) * pxPerSec) }}
                      />
                    )}
                    {overlay.label && (
                      <span className="absolute left-1.5 top-0 text-[9px] font-medium leading-tight text-white bg-black/60 px-1 rounded-b pointer-events-none">
                        {overlay.label}
                      </span>
                    )}
                  </div>
                );
              })}
              {renderAudioOverlays.map((overlay) => {
                const left = overlay.startTime * pxPerSec;
                const width = (overlay.endTime - overlay.startTime) * pxPerSec;
                const handleStyle = { top: (audioRows.rowOf.get(overlay.id) ?? 0) * AUDIO_ROW_HEIGHT + 4, height: AUDIO_ROW_HEIGHT - 8 };
                return (
                  <React.Fragment key={`audio-overlay-resize-${overlay.id}`}>
                    <div
                      onPointerDown={beginAudioOverlayResizeDrag(overlay, "start")}
                      onPointerMove={handleAudioOverlayResizeDragMove}
                      onPointerUp={endAudioOverlayResizeDrag}
                      onPointerCancel={endAudioOverlayResizeDrag}
                      title="Drag to trim this audio's start"
                      className="absolute w-2 -ml-1 bg-teal-400 hover:bg-teal-300 rounded cursor-ew-resize z-10"
                      style={{ ...handleStyle, left }}
                    />
                    <div
                      onPointerDown={beginAudioOverlayResizeDrag(overlay, "end")}
                      onPointerMove={handleAudioOverlayResizeDragMove}
                      onPointerUp={endAudioOverlayResizeDrag}
                      onPointerCancel={endAudioOverlayResizeDrag}
                      title="Drag to trim this audio's end"
                      className="absolute w-2 -ml-1 bg-teal-400 hover:bg-teal-300 rounded cursor-ew-resize z-10"
                      style={{ ...handleStyle, left: left + width }}
                    />
                  </React.Fragment>
                );
              })}
            </div>

            {/* Playhead */}
            <div className="absolute top-0 bottom-0 z-40 w-px bg-white pointer-events-none" style={{ left: playheadLeft }}>
              <div className="w-2.5 h-2.5 bg-white rounded-sm -ml-[5px] -mt-0.5" />
            </div>
          </div>
        </div>

        {lanesHiddenBelow && (
          <button
            type="button"
            title="Some tracks are below - scroll to see them"
            onClick={() => trackAreaRef.current?.scrollBy({ top: 96, behavior: "smooth" })}
            className="absolute bottom-1.5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] text-white bg-neutral-700/90 hover:bg-neutral-600 shadow ring-1 ring-white/10"
          >
            More tracks below ↓
          </button>
        )}
      </div>

      {exportOptionsAnchor && (
        <ExportOptionsPopover
          anchor={exportOptionsAnchor}
          quality={exportQuality}
          onQualityChange={setExportQuality}
          customOutputName={customOutputPath ? customOutputPath.split(/[\\/]/).pop() ?? customOutputPath : null}
          onChooseLocation={handleChooseExportLocation}
          onResetLocation={() => setCustomOutputPath(null)}
          format={exportFormat}
          onFormatChange={setExportFormat}
          framing={exportFraming}
          onFramingChange={setExportFraming}
          loudness={exportLoudness}
          onLoudnessChange={setExportLoudness}
          fillAnchor={exportAnchor}
          onFillAnchorChange={setExportAnchor}
          followSubject={exportFollowSubject}
          onFollowSubjectChange={setExportFollowSubject}
          reframeStatus={reframeStatus}
          onClose={() => setExportOptionsAnchor(null)}
        />
      )}

      {silenceAnchor && (
        <SilenceDetectionPopover anchor={silenceAnchor} state={silenceState} onRemove={handleRemoveSilence} onClose={() => setSilenceAnchor(null)} />
      )}

      {autoZoomAnchor && (
        <AutoZoomPopover anchor={autoZoomAnchor} state={autoZoomState} onApply={handleApplyAutoZoom} onClose={() => setAutoZoomAnchor(null)} />
      )}

      {viewSwitchAnchor && (
        <ViewSwitchPopover anchor={viewSwitchAnchor} state={viewSwitchState} onApply={handleApplyViewSwitch} onClose={() => setViewSwitchAnchor(null)} />
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
              hasPrecedingClip={clipIndex > 0 || selectedCount > 1}
              previousClip={clipIndex > 0 ? editStore.clips[clipIndex - 1] : undefined}
              isOnScreen={activeClip?.id === clip.id}
              anchor={effectsPopoverAnchor}
              selectedCount={selectedCount}
              onUpdate={updateSelectedClips}
              onAddTransitionSound={
                clipIndex > 0
                  ? (soundId) => {
                      const sound = TRANSITION_SOUNDS.find((s) => s.id === soundId);
                      const track = BUILTIN_SFX_TRACKS.find((t) => t.id === soundId);
                      if (!sound || !track) return;
                      const start = Math.max(0, (outputStarts[clipIndex] ?? 0) - sound.lead);
                      builtinSfxFile(soundId)
                        .then((path) => {
                          const id = editStore.addAudioOverlay(path, track.duration, start, start + track.duration, { label: track.title, library: libraryInfoOf(track) });
                          setSelectedAudioOverlayId(id);
                        })
                        .catch((err) => console.error("Couldn't make the transition sound", err));
                    }
                  : undefined
              }
              onClose={() => setEffectsPopoverAnchor(null)}
            />
          );
        })()}

      {selectedClipId &&
        speedPopoverAnchor &&
        (() => {
          const clip = editStore.clips.find((c) => c.id === selectedClipId);
          if (!clip) return null;
          return (
            <SpeedPopover
              speed={clip.speed ?? 1}
              sourceDuration={clip.end - clip.start}
              anchor={speedPopoverAnchor}
              selectedCount={selectedCount}
              onUpdate={(speed) => updateSelectedClips({ speed })}
              ramp={clip.speedRamp}
              onRampChange={(speedRamp) => updateSelectedClips({ speedRamp })}
              onClose={() => setSpeedPopoverAnchor(null)}
            />
          );
        })()}

      {selectedClipId &&
        noiseReductionPopoverAnchor &&
        (() => {
          const clip = editStore.clips.find((c) => c.id === selectedClipId);
          if (!clip) return null;
          return (
            <NoiseReductionPopover
              strength={clip.noiseReduction ?? 0}
              cleanup={clip.audioCleanup}
              status={noiseReductionStatus}
              anchor={noiseReductionPopoverAnchor}
              clipCount={editStore.clips.length}
              selectedCount={selectedCount}
              onUpdate={updateSelectedClips}
              onApplyToAll={(patch) => editStore.updateAllClipEffects(patch)}
              onClose={() => setNoiseReductionPopoverAnchor(null)}
              sourcePath={clip.sourcePath}
              clipStart={clip.start}
              clipEnd={clip.end}
              playhead={activeClip?.id === clip.id ? currentTime : undefined}
              onSeek={(t) => onSeek(clip.sourcePath, t)}
              onPreviewOriginal={onPreviewNoiseOriginal}
              isPlaying={isPlaying}
              onTogglePlay={handleTransportPlayClick}
            />
          );
        })()}

      {mixerAnchor && (
        <MixerPanel
          anchor={mixerAnchor}
          channels={mixerChannels}
          focusKey={mixerFocus}
          onVolume={(key, volume) => {
            if (key === VIDEO_CHANNEL) editStore.setVideoAudioVolume(volume);
            else if (key.startsWith("pip:")) editStore.updatePipOverlayContent(key.slice(4), { volume });
            else editStore.updateAudioChannel(key, { volume });
          }}
          onMute={(key, muted) => {
            if (key === VIDEO_CHANNEL) editStore.setVideoAudioMuted(muted);
            else if (key.startsWith("pip:")) editStore.updatePipOverlayContent(key.slice(4), { muted });
            else editStore.updateAudioChannel(key, { muted });
          }}
          onFx={(key, fx) => {
            if (key === VIDEO_CHANNEL) editStore.setVideoAudioFx(fx);
            else if (key.startsWith("pip:")) editStore.updatePipOverlayContent(key.slice(4), { fx: isNeutralFx(fx) ? undefined : fx });
            else editStore.updateAudioChannel(key, { fx });
          }}
          onClose={() => setMixerAnchor(null)}
        />
      )}

      {musicAnchor && (
        <MusicLibraryPanel
          anchor={musicAnchor}
          placeAt={musicPlaceAt}
          videoDuration={totalOutputDuration}
          context={musicContext}
          timelinePlaying={isPlaying}
          onPreviewStart={() => {
            if (isPlaying) onTogglePlay();
          }}
          onAdd={(track, path, part, beats) => {
            const isMusic = track.kind === "music";
            const startTime = musicPlaceAt;
            const id = editStore.addAudioOverlay(path, track.duration, startTime, startTime + part.length, {
              trimStart: part.start,
              label: track.title,
              library: libraryInfoOf(track),
              ...(beats ?? {}),
              // Starting mid-song fades in so it doesn't land on a cut-off note; stopping before the
              // song does fades out, so it never ends abruptly.
              ...(isMusic && part.start > 0.05 ? { fadeInSec: 0.4 } : {}),
              ...(isMusic && part.start + part.length < track.duration - 0.5 ? { fadeOutSec: Math.min(2, part.length / 4) } : {}),
              // Under a voice, music sits back automatically.
              ...(isMusic && musicContext.hasSpeech ? { duckUnderSpeech: true } : {}),
            });
            setSelectedAudioOverlayId(id);
            if (isMusic) {
              // A song's finer controls live in its own panel - open it where the library was.
              setAudioPopoverAnchor(musicAnchor);
              setMusicAnchor(null);
            }
            return id;
          }}
          onLateBeats={(id, b) => editStore.updateAudioOverlayContent(id, { bpm: b.bpm, beats: b.beats })}
          onPickFile={() => {
            setMusicAnchor(null);
            setIsPlacingAudio(true);
          }}
          onClose={() => setMusicAnchor(null)}
        />
      )}

      {shortsOpen && editStore.editState && (
        <ShortsStudio
          editState={editStore.editState}
          sourcePaths={captionSourcePaths}
          frame={videoPixelSize}
          sourceDuration={editStore.getSourceDuration}
          primaryPath={file.path}
          onTranscribed={(language, transcripts) => editStore.setCaptionTranscripts(language, transcripts, { captionsEnabled: false })}
          prepareExport={editStore.prepareExport}
          onClose={() => setShortsOpen(false)}
        />
      )}

      {introAnchor && (
        <HighlightIntroPanel
          anchor={introAnchor}
          clips={editStore.clips}
          selectedClipIds={selectedClipIds}
          audioOverlays={editStore.audioOverlays}
          onApply={(introClips, into, keepMusic) => {
            editStore.insertHighlightIntro(introClips, into, keepMusic);
            setIntroAnchor(null);
          }}
          onClose={() => setIntroAnchor(null)}
        />
      )}

      {splitAnchor && (
        <SplitScreenPanel
          anchor={splitAnchor}
          clips={editStore.clips}
          selectedClipIds={selectedClipIds}
          playhead={currentOutputTime}
          totalDuration={totalOutputDuration}
          frameAspect={videoPixelSize && videoPixelSize.height > 0 ? videoPixelSize.width / videoPixelSize.height : 16 / 9}
          onApply={(cells, startTime, endTime, backdrop) => {
            editStore.addSplitScreen(cells, startTime, endTime, backdrop);
            setSplitAnchor(null);
          }}
          onClose={() => setSplitAnchor(null)}
        />
      )}

      {elementsAnchor && (
        <ElementsGallery
          anchor={elementsAnchor}
          onClose={() => setElementsAnchor(null)}
          onPick={(kind) => {
            const entry = assetEntry(kind);
            const frameAspect = videoPixelSize && videoPixelSize.height > 0 ? videoPixelSize.width / videoPixelSize.height : 16 / 9;
            // Wide elements (underlines, bars) by width; everything else about a third of the frame tall.
            let height = entry.aspect >= 3 ? 0.5 / entry.aspect * frameAspect : 0.32;
            let width = (height * entry.aspect) / frameAspect;
            if (width > 0.6) {
              width = 0.6;
              height = (width * frameAspect) / entry.aspect;
            }
            if (entry.fullFrame) {
              width = 1;
              height = 1;
            }
            const length = kind === "countdown" ? 3 : kind === "progress" ? 5 : kind === "reveal" ? 2.6 : entry.fullFrame ? 6 : 4;
            const total = totalOutputDuration > 0 ? totalOutputDuration : length;
            const startTime = Math.max(0, Math.min(currentOutputTime, total - Math.min(length, total)));
            const endTime = Math.min(total, startTime + length);
            const id = editStore.addImageOverlay("", 0.5 - width / 2, 0.5 - height / 2, width, height, startTime, endTime, makeAsset(kind));
            onSelectImageOverlay?.(id);
            setElementsAnchor(null);
          }}
        />
      )}

      {chaptersAnchor && (
        <ChaptersPanel
          anchor={chaptersAnchor}
          clips={editStore.clips}
          chapters={editStore.chapters}
          captions={editStore.captions}
          currentOutputTime={currentOutputTime}
          durationSec={totalOutputDuration}
          primarySourcePath={file.path}
          onChange={editStore.setChapters}
          onSeek={seekToOutputTime}
          onClose={() => setChaptersAnchor(null)}
        />
      )}

      {screenStyleAnchor && (
        <ScreenStylePanel
          anchor={screenStyleAnchor}
          screenStyle={editStore.screenStyle}
          onScreenStyle={editStore.setScreenStyle}
          pointerStyle={pointerStyleOf(editStore.pointerStyle)}
          onPointerStyle={editStore.updatePointerStyle}
          keystrokeStyle={keystrokeStyleOf(editStore.keystrokeStyle)}
          onKeystrokeStyle={editStore.updateKeystrokeStyle}
          hasPointer={hasEditablePointer}
          shortcutCount={shortcutCount}
          onClose={() => setScreenStyleAnchor(null)}
        />
      )}

      {captionsAnchor && (
        <CaptionsPanel
          anchor={captionsAnchor}
          captions={editStore.captions}
          lines={captionLines}
          sourcePaths={captionSourcePaths}
          primarySourcePath={file.path}
          currentOutputTime={currentOutputTime}
          onGenerated={editStore.setCaptionTranscripts}
          onUpdateSettings={editStore.updateCaptionSettings}
          onEditLine={editStore.editCaptionLine}
          onClear={editStore.clearCaptions}
          onSeekLine={(line) => onSeek(line.sourcePath, line.sourceStart)}
          onClose={() => setCaptionsAnchor(null)}
        />
      )}

      {transcriptAnchor && (
        <TranscriptEditorPanel
          anchor={transcriptAnchor}
          captions={editStore.captions}
          clips={editStore.clips}
          sourcePaths={captionSourcePaths}
          currentOutputTime={currentOutputTime}
          onGenerated={(language, transcripts) => editStore.setCaptionTranscripts(language, transcripts, { captionsEnabled: false })}
          onCut={editStore.cutClipRanges}
          onSeek={(token) => seekToOutputTime(token.outputStart)}
          onClose={() => setTranscriptAnchor(null)}
        />
      )}

      {toolModeAnchor && <ToolModePopover mode={toolMode} anchor={toolModeAnchor} onSelect={setToolMode} onClose={() => setToolModeAnchor(null)} />}

      {selectedClipId && extractAudioAnchor && (
        <ExtractAudioPopover
          anchor={extractAudioAnchor}
          isExtracting={isExtractingAudio}
          onExtract={handleExtractAudio}
          onDetach={handleDetachAudio}
          streamCount={detachStreamCount}
          separationEngine={separationEngine}
          detachStatus={detachStatus}
          onCancel={activeCancelCommand ? () => void invoke(activeCancelCommand) : null}
          onClose={() => setExtractAudioAnchor(null)}
        />
      )}

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
              videoEnd={totalOutputDuration}
              timelinePlaying={isPlaying}
              onPreviewStart={() => {
                if (isPlaying) onTogglePlay();
              }}
              onSplitAtPlayhead={
                currentOutputTime > overlay.startTime + 0.1 && currentOutputTime < overlay.endTime - 0.1
                  ? () => {
                      const second = editStore.splitAudioOverlay(overlay.id, currentOutputTime);
                      if (second) {
                        setSelectedAudioOverlayId(second);
                        setAudioPopoverAnchor(null);
                      }
                    }
                  : null
              }
              hasImageClips={editStore.clips.some((c) => isImageClipPath(c.sourcePath))}
              onCutImagesOnBeat={editStore.cutImagesOnBeat}
              onOpenMixer={() => openMixer(audioChannelKey(overlay))}
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
