// hooks/useVideoEditStore.ts
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CaptionLine, buildCaptionLines, buildCaptionsAss, buildSrt, defaultCaptionSettings, replaceCaptionLineText } from "../utils/captions";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AdjustmentLayer, AudioOverlay, BlurOverlay, CaptionSettings, CaptionTrack, CaptionWord, Clip, ClipTransitionIn, EditableFields, KeepSegment, ImageOverlay, OverlayAnimation, PipOverlay, TextOverlay, VideoEditCommand, VideoEditState, createEmptyState, isVideoEditState, isImageClipPath, isVideoProjectPath, IMAGE_CLIP_MAX_SECONDS, DEFAULT_IMAGE_CLIP_SECONDS, VideoChapter } from "../utils/videoEditTypes";
import { adjustmentLayerExport, makeAdjustmentLayer } from "../utils/adjustmentLayers";
import { exportBlendMode } from "../utils/blendModes";
import { chaptersForExport } from "../utils/videoChapters";
import { confirmCloseWithActiveExports, hasActiveJobs, setEditorCloseGuard, type ExportJobPayload } from "../utils/exportQueue";
import {
  applyCommand,
  addOverlay,
  applyAutoZoomAtClicks as applyAutoZoomAtClicksHandler,
  AutoZoomClick,
  buildViewSwitchOverlays,
  ViewSwitchEvent,
  bringOverlayToFront,
  deleteClipAt as deleteClipAtHandler,
  deleteClips as deleteClipsHandler,
  duplicateClips as duplicateClipsHandler,
  setImageClipLengths as setImageClipLengthsHandler,
  mergeClipsInPlace,
  cutClipRanges as cutClipRangesHandler,
  insertFreezeFrame as insertFreezeFrameHandler,
  reverseClip as reverseClipHandler,
  unreverseClip as unreverseClipHandler,
  deleteOverlay,
  duplicateOverlay,
  duplicateTimedOverlay,
  insertClip as insertClipHandler,
  isDetachedAudioOverlay,
  makeAudioOverlay,
  makeBlurOverlay,
  makeImageOverlay,
  makePipOverlay,
  makeTextOverlay,
  moveOverlayTime,
  removeSilentRanges as removeSilentRangesHandler,
  reorderClip as reorderClipHandler,
  resizeAudioOverlayTime,
  resizeClipEdge as resizeClipEdgeHandler,
  resizeOverlayTime,
  resizePipOverlayTime,
  splitPipOverlayAt,
  splitAudioOverlayAt,
  deletePipOverlayAndCloseGap,
  sendOverlayToBack,
  splitClipAt,
  toKeepSegments,
  updateClip as updateClipHandler,
  updateOverlay,
} from "../handlers/videoEditHandlers";
import { gradeCubeForClip } from "../utils/gradeLuts";
import { clipOutputDuration } from "../utils/clipTiming";
import { computeSpeechTimeline, duckEnvelopeFor, isDucked } from "../utils/musicDucking";
import type { OverlayKeyframe } from "../utils/keyframes";
import type { OverlayAsset } from "../utils/videoAssets";

// One cell of a split screen (addSplitScreen) - where it sits and which source it plays from where.
export interface SplitScreenCell {
  sourcePath: string;
  sourceDuration: number;
  // Seconds into the source the cell starts playing from.
  trimStart: number;
  x: number;
  y: number;
  width: number;
  height: number;
  // Fraction of the cell's own height; 0 = square corners.
  cornerRadius: number;
  muted: boolean;
}
import { renderAssetFrames } from "../utils/videoAssets";

interface ExportKeyframe {
  time: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  easing: string;
}
import { beatOutputTimes, fitImageClipsToBeats } from "../utils/beatSync";
import { BLUR_SIGMA_FRACTION, blurNeedsMask, renderBlurMaskToPng, renderImageOverlayToPng, renderImageRevealFrames, renderTextOverlayToPng, renderTextRevealFrames } from "../utils/videoOverlayRender";
import { isTextReveal } from "../utils/textReveal";
const appWindow = getCurrentWebviewWindow()

const AUTOSAVE_DEBOUNCE_MS = 800;
// An audio overlay can hang past the video's end, but must start at least this far before it.
export const MIN_AUDIO_START_ROOM_SEC = 0.5;

interface ConversionProgressPayload {
  input_path: string;
  progress: number;
  status: "starting" | "processing" | "completed" | "failed";
  message: string;
}

// Each graded clip's baked LUT as .cube text, attached to its export segment - the same table the
// preview's WebGL layer draws with (gradeLuts.ts), so the export grades exactly as previewed.
async function withGradeLuts(segments: KeepSegment[], clips: Clip[]): Promise<KeepSegment[]> {
  const cubes = await Promise.all(clips.map((clip) => gradeCubeForClip(clip.grade)));
  return segments.map((segment, i) => (cubes[i] ? { ...segment, lutCube: cubes[i]! } : segment));
}

// ffprobe-backed duration lookup for a file that isn't the one this edit session belongs to (a
// clip dragged in from elsewhere) - reuses get_conversion_info, the same command the generic
// file-tools info panel already calls for exactly this kind of "duration of an arbitrary file"
// question. Returns null rather than throwing on failure (unsupported file, ffprobe error, etc.)
// so a bad drag-in degrades to "can't resize this clip's end past what shows on-screen right now"
// instead of crashing the whole editor.
async function fetchDuration(path: string): Promise<number | null> {
  // A still has no length of its own - an image clip can be stretched up to its preview proxy's.
  if (isImageClipPath(path)) return IMAGE_CLIP_MAX_SECONDS;
  try {
    const info = await invoke<Record<string, string>>("get_conversion_info", { inputPath: path });
    const match = info.duration?.match(/[\d.]+/);
    const parsed = match ? parseFloat(match[0]) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch (err) {
    console.error("Failed to read duration for", path, err);
    return null;
  }
}

// Same-kind edits closer together than this merge into one undo step (pushCommand).
const EDIT_MERGE_MS = 700;

// Mirrors export_trimmed_video's own `quality`/`output_path` params (conversion.rs) - both
// optional so a caller that passes nothing gets the exact same default behavior as before this
// existed (resolve_export_quality's own "standard" fallback, and the default "<name> (edited).ext"
// location next to the source).
export type ExportQuality = "standard" | "high" | "small";
export interface ExportOptions {
  quality?: ExportQuality;
  outputPath?: string;
  // A platform format (Shorts/Reels, square...) and how the picture fits it - see OutputFrame in
  // conversion.rs. Overlays and captions are drawn at this size when it's set.
  // track: Fill following the subject - the crop window's centre over output time as
  // [seconds, x, y] knots (reframeTrack.ts); replaces the anchor.
  outputFrame?: { width: number; height: number; mode: "fit-blur" | "fit" | "fill"; anchorX?: number; anchorY?: number; track?: [number, number, number][] } | null;
  // Loudness target in LUFS (-14 YouTube/Spotify, -16 podcasts); null/undefined = as mixed.
  loudnessLufs?: number | null;
}

// export_trimmed_video's OverlayImage.animation: every whole-overlay animation burns in exactly as
// it previews - "pop" included (a per-frame scale, overlay_pop_scale_expr in conversion.rs).
function exportOverlayAnimation(animation: OverlayAnimation | undefined): string {
  if (!animation || animation === "none") return "none";
  // Title reveals are drawn into their own frames; an image never uses them.
  if (isTextReveal(animation)) return "none";
  return animation;
}

type TextOverlayContentPatch = Partial<
  Pick<TextOverlay, "text" | "color" | "backgroundColor" | "colorRuns" | "boldRuns" | "italicRuns" | "textAlign" | "strokeColor" | "strokeWidth" | "cornerStyle" | "animation" | "x" | "y" | "width" | "height" | "fontSize" | "keyframes" | "reveal" | "blendMode" | "track">
>;
type ImageOverlayContentPatch = Partial<
  Pick<ImageOverlay, "x" | "y" | "width" | "height" | "opacity" | "cornerRadius" | "rotation" | "borderColor" | "shadow" | "flipHorizontal" | "flipVertical" | "src" | "keyframes" | "asset" | "reveal" | "blendMode" | "track">
>;
type BlurOverlayContentPatch = Partial<Pick<BlurOverlay, "x" | "y" | "width" | "height" | "intensity" | "shape" | "cornerRadius" | "rotation" | "keyframes" | "track">>;
export type AdjustmentLayerPatch = Partial<Omit<AdjustmentLayer, "id" | "createdAt" | "updatedAt">>;
type AudioOverlayContentPatch = Partial<Pick<AudioOverlay, "volume" | "fadeInSec" | "fadeOutSec" | "muted" | "src" | "bpm" | "beats" | "duckUnderSpeech" | "duckLevel">>;
// What a caller can set up front on a new audio overlay beyond its timing (a library song arrives
// with its part, title, licence, beats and ducking already decided).
export type NewAudioOverlayExtras = Partial<Pick<AudioOverlay, "trimStart" | "label" | "library" | "bpm" | "beats" | "fadeInSec" | "fadeOutSec" | "volume" | "duckUnderSpeech" | "duckLevel">>;
type PipOverlayContentPatch = Partial<Pick<PipOverlay, "x" | "y" | "width" | "height" | "shape" | "cornerRadius" | "crop" | "volume" | "muted" | "blendMode">>;
type ClipEffectsPatch = Partial<Pick<Clip, "colorFilter" | "grade" | "stabilize" | "speedRamp" | "kenBurns" | "transitionIn" | "crop" | "flipHorizontal" | "speed" | "noiseReduction" | "audioCleanup" | "muted">>;

export interface UseVideoEditStoreResult {
  loading: boolean;
  // Ordered clips - array order is playback order in preview/export, independent of each clip's
  // own source start/end or which file it comes from. This is the single source of truth;
  // there's no separate trim/gap state.
  clips: Clip[];
  // Text overlays (captions/titles) and image overlays (logos/watermarks/stickers), both
  // positioned/timed on the same output/assembled timeline as clips. Preview-only in v1 - not yet
  // burned into exported files (see exportEdited below).
  textOverlays: TextOverlay[];
  imageOverlays: ImageOverlay[];
  // Returns the new overlay's id so the caller (VideoOverlayLayer) can immediately select it and
  // open TextNoteEditor for first-time typing, same "isNew" flow PdfPage's text tool uses.
  addTextOverlay: (x: number, y: number, width: number, fontSize: number, startTime: number, endTime: number) => string;
  // The one generic patch entry point for content/formatting/position/size edits - mirrors
  // updateOverlay (videoEditHandlers.ts) being "the one generic patch fn every edit goes through"
  // for the same reasons resizeClipEdge covers both a clip's edges under one function.
  updateTextOverlayContent: (id: string, patch: TextOverlayContentPatch) => void;
  // Drags one edge of an overlay's time range (the timeline lane's resize handles) - clamped
  // against the current total output duration, computed internally from `clips`.
  resizeTextOverlayTime: (id: string, edge: "start" | "end", time: number) => void;
  // Drags a whole overlay chip (both edges together, preserving duration) - the timeline lane's
  // move-the-chip-body case.
  moveTextOverlayTime: (id: string, newStartTime: number) => void;
  deleteTextOverlay: (id: string) => void;
  // Clones the overlay (new id, nudged position, same everything else - see duplicateOverlay in
  // videoEditHandlers.ts) and returns the copy's id so the caller can select it right away.
  duplicateTextOverlay: (id: string) => string;
  // Reorders within textOverlays only - array order is what determines stacking (later renders on
  // top), and text/image overlays are separate render passes, so this never crosses kinds.
  bringTextOverlayToFront: (id: string) => void;
  sendTextOverlayToBack: (id: string) => void;
  // Same shape as the text-overlay methods above, minus a "content-only, no id yet" add step -
  // an image overlay's identity (the file it points at) is only known once a file's been picked,
  // so it's created with its full src/geometry in one call rather than an empty placeholder.
  // `asset` makes it a shape/animated element (videoAssets.ts) rather than a picture.
  addImageOverlay: (src: string, x: number, y: number, width: number, height: number, startTime: number, endTime: number, asset?: OverlayAsset) => string;
  updateImageOverlayContent: (id: string, patch: ImageOverlayContentPatch) => void;
  resizeImageOverlayTime: (id: string, edge: "start" | "end", time: number) => void;
  moveImageOverlayTime: (id: string, newStartTime: number) => void;
  deleteImageOverlay: (id: string) => void;
  duplicateImageOverlay: (id: string) => string;
  bringImageOverlayToFront: (id: string) => void;
  sendImageOverlayToBack: (id: string) => void;
  // Blurred regions - same frame-relative x/y/width/height basis as image overlays, but with no
  // z-order of their own (see BlurOverlay's own doc comment in videoEditTypes.ts for why) and no
  // content to swap out (only `intensity` is ever patched, alongside position/size).
  blurOverlays: BlurOverlay[];
  addBlurOverlay: (x: number, y: number, width: number, height: number, intensity: number, startTime: number, endTime: number) => string;
  updateBlurOverlayContent: (id: string, patch: BlurOverlayContentPatch) => void;
  resizeBlurOverlayTime: (id: string, edge: "start" | "end", time: number) => void;
  moveBlurOverlayTime: (id: string, newStartTime: number) => void;
  deleteBlurOverlay: (id: string) => void;
  duplicateBlurOverlay: (id: string) => string;
  // Adjustment layers (adjustmentLayers.ts) - timed like overlays, stacked in array order.
  adjustmentLayers: AdjustmentLayer[];
  addAdjustmentLayer: (startTime: number, endTime: number, patch?: AdjustmentLayerPatch) => string;
  updateAdjustmentLayer: (id: string, patch: AdjustmentLayerPatch) => void;
  resizeAdjustmentLayerTime: (id: string, edge: "start" | "end", time: number) => void;
  moveAdjustmentLayerTime: (id: string, newStartTime: number) => void;
  deleteAdjustmentLayer: (id: string) => void;
  duplicateAdjustmentLayer: (id: string) => string;
  // Chapters (videoChapters.ts), anchored to source moments; replaced as a whole list.
  chapters: VideoChapter[];
  setChapters: (chapters: VideoChapter[]) => void;
  // Everything one export needs, snapshotted now - what the background queue renders while
  // editing carries on (exportQueue.ts). Null when there's nothing to export.
  prepareExport: (timelinePixelSize: { width: number; height: number } | null, options?: ExportOptions) => Promise<ExportJobPayload | null>;
  // Background music/voiceover overlays - unlike text/image, these have no position on the frame
  // (VideoOverlayLayer isn't involved at all) and their whole UI lives in VideoTimelineDocker's own
  // timeline lane. `addAudioOverlay` takes the source file's own duration (already known by the
  // caller, via get_conversion_info) rather than looking it up itself, matching how addImageOverlay
  // is given its content up front instead of a "content added later" placeholder flow.
  audioOverlays: AudioOverlay[];
  addAudioOverlay: (src: string, sourceDuration: number, startTime: number, endTime: number, extras?: NewAudioOverlayExtras) => string;
  updateAudioOverlayContent: (id: string, patch: AudioOverlayContentPatch) => void;
  cutImagesOnBeat: (everyBeats: number) => void;
  // Trims into the source (see resizeAudioOverlayTime in videoEditHandlers.ts) rather than just
  // retiming an empty box - the one meaningful behavioral difference from resizeTextOverlayTime/
  // resizeImageOverlayTime.
  resizeAudioOverlayTime: (id: string, edge: "start" | "end", time: number) => void;
  moveAudioOverlayTime: (id: string, newStartTime: number) => void;
  deleteAudioOverlay: (id: string) => void;
  duplicateAudioOverlay: (id: string) => string;
  // "Unlink" the primary video's own sound: adds one audio overlay per already-extracted clip
  // audio file AND mutes the video track, as a single undo step - so the result can be trimmed,
  // lowered, muted or deleted per piece without touching the picture. Replaces any overlays a
  // previous detach created (isDetachedAudioOverlay) instead of stacking a second copy.
  detachVideoAudio: (tracks: { src: string; sourceDuration: number; startTime: number; endTime: number; label?: string }[]) => void;
  // Picture-in-picture video layers (e.g. a separately-recorded webcam - see FormData.
  // separate_webcam_capture, recording.rs) - same "real source file, trims into it" shape as audio
  // overlays above, plus frame-relative geometry/shape like image overlays. See PipOverlay's own
  // doc comment (videoEditTypes.ts) for why this can't reuse ImageOverlay's PNG-based rendering.
  pipOverlays: PipOverlay[];
  addPipOverlay: (sourcePath: string, sourceDuration: number, x: number, y: number, width: number, height: number, startTime: number, endTime: number) => string;
  // A whole split screen in one undo step: one PiP per cell, plus an optional full-frame colour
  // backdrop behind them (so the gaps between cells show a colour, not the main video).
  addSplitScreen: (cells: SplitScreenCell[], startTime: number, endTime: number, backdropColor: string | null) => string[];
  // Puts a highlight intro (highlightIntro.ts) in front of the timeline as one undo step: every
  // overlay moves along by the intro's length so it stays on the same shot - except music when
  // `keepMusicInPlace` (a beat-synced intro was cut to the music where it already is) - and the
  // first real shot gets `into` as its transition.
  insertHighlightIntro: (introClips: Clip[], into: ClipTransitionIn | null, keepMusicInPlace: boolean) => void;
  updatePipOverlayContent: (id: string, patch: PipOverlayContentPatch) => void;
  resizePipOverlayTime: (id: string, edge: "start" | "end", time: number) => void;
  movePipOverlayTime: (id: string, newStartTime: number) => void;
  // Removes the piece AND closes the gap it leaves in its own split chain - see
  // deletePipOverlayAndCloseGap (videoEditHandlers.ts).
  deletePipOverlay: (id: string) => void;
  // Cuts one PiP at an output-timeline time; returns the new second piece's id ("" if the cut was
  // refused - too close to either edge).
  splitPipOverlay: (id: string, outputTime: number) => string;
  // Cuts an audio overlay at the playhead - returns the second piece's id ("" if refused).
  splitAudioOverlay: (id: string, outputTime: number) => string;
  duplicatePipOverlay: (id: string) => string;
  // The primary video's OWN audio level - see VideoEditState.videoAudioMuted's own doc comment for
  // why this is distinct from any AudioOverlay's own volume/muted. Read by VideoPlayer.tsx (stacked
  // multiplicatively on top of its own local listening volume) and export_trimmed_video.
  videoAudioMuted: boolean;
  videoAudioVolume: number;
  setVideoAudioMuted: (muted: boolean) => void;
  setVideoAudioVolume: (volume: number) => void;
  // Burned-in captions (the Captions tool) - see CaptionTrack, videoEditTypes.ts. null until the
  // first transcript is added.
  captions: CaptionTrack | null;
  // Adds/replaces word transcripts (keyed by source path), creating the track with default
  // settings the first time.
  setCaptionTranscripts: (language: string, transcripts: Record<string, CaptionWord[]>, options?: { captionsEnabled?: boolean }) => void;
  cutClipRanges: (cuts: { clipId: string; start: number; end: number }[]) => void;
  updateCaptionSettings: (patch: Partial<CaptionSettings>) => void;
  editCaptionLine: (line: CaptionLine, text: string) => void;
  clearCaptions: () => void;
  // Called once the real video duration is known (from the hidden capture <video>'s
  // loadedmetadata) - only seeds a fresh, unedited state; a no-op once real state exists (either
  // loaded from the sidecar or already seeded), so it's safe to call on every metadata load.
  setDuration: (duration: number) => void;
  // Duration of any source file referenced by a clip, if known yet - null until fetched (for a
  // dragged-in file) or before setDuration runs (for the primary file). Callers should treat null
  // as "don't clamp yet" rather than blocking the interaction.
  getSourceDuration: (sourcePath: string) => number | null;
  splitAt: (index: number, sourceTime: number) => void;
  deleteClipAt: (index: number) => void;
  reorderClip: (fromIndex: number, toIndex: number) => void;
  duplicateClip: (id: string) => void;
  // Ctrl/Shift multi-selection: one undo step for the whole selection.
  deleteClips: (ids: string[]) => void;
  duplicateClips: (ids: string[]) => void;
  // Every image clip to one length (a fast photo montage) - one undo step.
  setImageClipLengths: (seconds: number) => void;
  // Selected clips -> one clip (clip menu > Merge). Back-to-back split pieces just join (instant,
  // still editable); anything else is rendered into one new file with its effects baked in. Resolves
  // to the merged clip's id, or null if it couldn't be done.
  mergeClips: (ids: string[], frame: { width: number; height: number } | null) => Promise<string | null>;
  // Stops a merge that's still rendering - the timeline is left exactly as it was.
  cancelMerge: () => void;
  freezeFrame: (clipId: string, sourceTime: number, stillPath: string, seconds: number) => void;
  // A reversed render's path to reverse the clip, or null to un-reverse it.
  setClipReversed: (clipId: string, reversedPath: string | null) => void;
  resizeClipEdge: (id: string, edge: "start" | "end", time: number) => void;
  // Color grade / Ken Burns / crossfade-in, all three on one patch entry point - same "one
  // generic patch fn" shape as updateTextOverlayContent, just for a clip's own non-geometric
  // fields (see updateClip, videoEditHandlers.ts).
  updateClipEffects: (id: string, patch: ClipEffectsPatch) => void;
  // Same patch applied to every clip as ONE undo step (NoiseReductionPopover's "Apply to all clips").
  updateAllClipEffects: (patch: ClipEffectsPatch) => void;
  // A patch applied to each of `ids` as ONE undo step - the toolbar's effects/speed/cleanup tools
  // acting on a Ctrl/Shift-click multi-selection. A function patch is asked per clip (null skips
  // that clip), for edits that depend on the clip itself.
  // Flushes, then stops saving to the open file's current path - see the implementation.
  prepareFileMove: () => Promise<() => void>;
  updateClipsEffects: (ids: string[], patch: ClipEffectsPatch | ((clip: Clip) => ClipEffectsPatch | null)) => void;
  // Applies the result of a detect_silence scan (conversion.rs) to one clip, splitting out and
  // dropping every detected dead-air range in a single undo step - see removeSilentRanges,
  // videoEditHandlers.ts, for the actual splice logic.
  trimSilenceForClip: (clipId: string, silentRanges: { start: number; end: number }[]) => void;
  // Applies the "auto zoom on click" tool's own splice logic to one clip, inserting a zoom-in/
  // zoom-out Ken Burns pair around each click in a single undo step - see applyAutoZoomAtClicks,
  // videoEditHandlers.ts.
  applyAutoZoomAtClicks: (clipId: string, clicks: AutoZoomClick[]) => void;
  // Applies a recorded screen<->camera view-switch timeline to one clip as a batch of full-frame
  // PipOverlays cutting to `webcamPath`, one per camera-active interval, in a single undo step -
  // see buildViewSwitchOverlays, videoEditHandlers.ts, for the actual interval math.
  applyViewSwitchOverlays: (
    clipId: string,
    events: ViewSwitchEvent[],
    webcamPath: string,
    clipOutputStart: number
  ) => void;
  // Inserts a whole new clip - from the Briefcast library or an external file dropped onto the
  // timeline - at `atIndex`, fetching its duration first if not already known. Resolves once the
  // clip has actually been added (or been skipped, if the duration lookup failed).
  insertClipAt: (sourcePath: string, atIndex: number) => Promise<void>;
  // Swaps the media a clip plays (right-click > Replace) - keeps its place, length and effects.
  replaceClipSource: (id: string, newSourcePath: string) => Promise<void>;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isExporting: boolean;
  exportProgress: number | null;
  exportError: string | null;
  // videoPixelSize (the primary file's native resolution) is required to render text/image
  // overlays for burn-in - pass null (no overlays possible, e.g. audio-only export path) to skip
  // rendering them and export a plain trim, same as before overlays existed.
  exportEdited: (
    videoPixelSize: { width: number; height: number } | null,
    options?: ExportOptions
  ) => Promise<{ path: string; name: string } | null>;
  // Renders just one clip, with its own effects, to `outputPath` - the clip menu's "Save clip as".
  // No overlays/captions/music: those live on the whole timeline, not on any one clip.
  exportClip: (clipId: string, videoPixelSize: { width: number; height: number } | null, outputPath: string) => Promise<{ path: string; name: string } | null>;
}

// Non-destructive edit state (an ordered, reorderable, multi-source-capable list of clips) for
// one video, backed by a JSON sidecar next to the source file - never a duplicated copy of the
// video itself. Modeled on useAnnotationStore.ts: same load-on-file-change, same debounced
// autosave, same undo/redo stack shape. `sourcePath` is this session's *primary* file - the one
// the sidecar is saved next to and the one Save's output is named after - not necessarily the
// source of every clip once files have been dragged in from elsewhere.
export default function useVideoEditStore(sourcePath: string | undefined): UseVideoEditStoreResult {
  const [state, setState] = useState<VideoEditState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [undoStack, setUndoStack] = useState<VideoEditCommand[]>([]);
  const [redoStack, setRedoStack] = useState<VideoEditCommand[]>([]);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  // Bumped on every duration lookup so components reading getSourceDuration re-render once a
  // fetch resolves - the durations themselves live in a ref (not state) since they're derived,
  // cacheable-forever-per-path data, not part of the edit history.
  const [, setDurationVersion] = useState(0);

  const stateRef = useRef<VideoEditState | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceDurationsRef = useRef<Record<string, number>>({});
  // Mirrors isExporting for the close-guard effect below, which needs the CURRENT value at the
  // moment the user tries to close the window, not whatever was true when that effect last
  // re-subscribed - same "ref alongside state" reasoning as activeClipEffectsRef (VideoPlayer.tsx).
  const isExportingRef = useRef(false);
  isExportingRef.current = isExporting;
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  // Tracks the CURRENT sourcePath prop (as opposed to whatever `sourcePath` an in-flight async
  // callback's own closure captured at call time) - written directly during render, not via an
  // effect, so it's already accurate before any awaited callback in this render's closures could
  // possibly resume. insertClipAt's own race guard is the one thing that needs this: `stateRef`
  // alone can't tell "did the user switch files while I was awaiting a duration lookup", since
  // switching files still leaves stateRef.current non-null (just pointing at the NEW file's state).
  const sourcePathRef = useRef(sourcePath);
  sourcePathRef.current = sourcePath;

  const getSourceDuration = useCallback((path: string): number | null => sourceDurationsRef.current[path] ?? null, []);

  const registerSourceDuration = useCallback((path: string, duration: number) => {
    if (sourceDurationsRef.current[path] === duration) return;
    sourceDurationsRef.current[path] = duration;
    setDurationVersion((v) => v + 1);
  }, []);

  // In-session undo/redo cache, keyed by file path - VideoTimelineDocker doesn't unmount when the
  // sidebar's selection changes (only its `file` prop changes), so without this the load effect
  // below would wipe undo/redo back to empty every time someone navigates to a different video and
  // back, even though the underlying edit state was correctly reloaded from the sidecar. This is
  // purely in-memory (cleared on app restart) - the sidecar itself only ever needs to remember the
  // *result* of edits, not the steps that produced it.
  const historyCacheRef = useRef<Map<string, { undoStack: VideoEditCommand[]; redoStack: VideoEditCommand[] }>>(new Map());
  const prevSourcePathRef = useRef<string | undefined>(undefined);

  // Load (or note the absence of) the sidecar whenever the target video changes. If there's no
  // sidecar yet, `state` stays null until setDuration seeds a fresh one - duration isn't known
  // here, only in the timeline's own hidden-video metadata load.
  useEffect(() => {
    // Stash the outgoing file's history before switching away from it - `undoStack`/`redoStack`
    // here are still whatever the outgoing file left them as, since nothing has reset them yet.
    if (prevSourcePathRef.current) {
      historyCacheRef.current.set(prevSourcePathRef.current, { undoStack, redoStack });
    }
    prevSourcePathRef.current = sourcePath;

    // No file open (e.g. "Back" to the Video Editor's home) - drop the outgoing file's clips too,
    // or the next video opened would briefly mount its timeline on THEM, and that timeline's first
    // seek would point the player back at the previous file. (The pending autosave is already
    // flushed by the cleanup below, which runs before this.)
    if (!sourcePath) {
      setState(null);
      setUndoStack([]);
      setRedoStack([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setState(null);
    const cached = historyCacheRef.current.get(sourcePath);
    setUndoStack(cached?.undoStack ?? []);
    setRedoStack(cached?.redoStack ?? []);

    invoke<string | null>("load_video_edit_state", { videoPath: sourcePath }).then(
      (json) => {
        if (cancelled) return;
        if (json) {
          try {
            const parsed = JSON.parse(json);
            if (isVideoEditState(parsed)) {
              // textOverlays/imageOverlays didn't exist when isVideoEditState's shape was first
              // written - default them here (once, at load) rather than in the type guard, so
              // sidecars saved before these features existed still load instead of being treated
              // as corrupt.
              setState({
                ...parsed,
                textOverlays: parsed.textOverlays ?? [],
                imageOverlays: parsed.imageOverlays ?? [],
                blurOverlays: parsed.blurOverlays ?? [],
                audioOverlays: parsed.audioOverlays ?? [],
                pipOverlays: parsed.pipOverlays ?? [],
                adjustmentLayers: parsed.adjustmentLayers ?? [],
                chapters: parsed.chapters ?? [],
                videoAudioMuted: parsed.videoAudioMuted ?? false,
                videoAudioVolume: parsed.videoAudioVolume ?? 1,
                captions: parsed.captions ?? null,
              });
              // Any clip referencing a file other than the primary one (dragged in from
              // elsewhere) needs its duration re-fetched after a reload, since the cache above is
              // purely in-memory and doesn't survive switching away and back, let alone a restart.
              const distinctPaths = new Set(parsed.clips.map((c: Clip) => c.sourcePath));
              distinctPaths.delete(sourcePath);
              distinctPaths.forEach((path) => {
                fetchDuration(path).then((duration) => {
                  if (!cancelled && duration != null) registerSourceDuration(path, duration);
                });
              });
            }
          } catch (err) {
            console.error("Failed to parse video edit state:", err);
          }
        }
        setLoading(false);
      },
      (err) => {
        if (cancelled) return;
        console.error("Failed to load video edit state:", err);
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcePath]);

  // Returns the save's own promise (rather than firing-and-forgetting it, like most callers here
  // only need) so the close-guard effect below can actually AWAIT it finishing before letting the
  // window close - a bare setTimeout-scheduled invoke() has no way to block window teardown, so
  // without this a close right after an edit could tear down the webview before the IPC call ever
  // reached Rust.
  // The path this file was just moved/renamed AWAY from (prepareFileMove) - nothing is saved there
  // any more, or the switch-files flush below would recreate a stale .edits.json at the old path
  // right after the real one travelled with the file.
  const movedAwayFromRef = useRef<string | null>(null);
  const flushSave = useCallback((): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const current = stateRef.current;
    if (!sourcePath || !current || movedAwayFromRef.current === sourcePath) return Promise.resolve();
    return invoke("save_video_edit_state", { videoPath: sourcePath, json: JSON.stringify(current) })
      .then(() => undefined)
      .catch((err) => {
        console.error("Failed to save video edit state:", err);
      });
  }, [sourcePath]);

  // Call right before the open file is moved or renamed: saves any pending edit to the current path
  // (so it travels with the file), then stops saving there. Resolves to an undo for a move that
  // then fails.
  const prepareFileMove = useCallback(async (): Promise<() => void> => {
    await flushSave();
    const path = sourcePath ?? null;
    movedAwayFromRef.current = path;
    return () => {
      if (movedAwayFromRef.current === path) movedAwayFromRef.current = null;
    };
  }, [flushSave, sourcePath]);

  const scheduleAutosave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Flush any pending save when switching files or unmounting so a trailing edit isn't lost.
  useEffect(() => {
    return () => {
      void flushSave();
    };
  }, [sourcePath, flushSave]);
  // Runs after the switch's cleanups above, so the moved-away path is only muted for that one flush
  // - a different file later taking the old name saves normally.
  useEffect(() => {
    movedAwayFromRef.current = null;
  }, [sourcePath]);

  // Guards the whole app window closing while this file's editor is open - mirrors
  // useDocsEditStore's own onCloseRequested guard (save-on-quit), plus a video-specific check the
  // docs editor has no equivalent of: closing mid-export would kill the ffmpeg child process
  // mid-write (see cancel_conversion), leaving a truncated "(edited)" file on disk with no
  // indication anything went wrong. Registered only while a file is actually open, same as the
  // docs editor's own version, so closing from anywhere else in the app is unaffected.
  useEffect(() => {
    if (!sourcePath) return;
    let ownClose = false; // true once *we* called appWindow.close() - let that one through untouched
    let pendingClose: Promise<void> | null = null; // dedupes a rapid double-click on the close button

    const unlistenPromise = appWindow.onCloseRequested(async (event) => {
      if (ownClose) return;
      event.preventDefault();
      if (pendingClose) {
        await pendingClose;
        return;
      }
      pendingClose = (async () => {
        if (hasActiveJobs()) {
          // Background exports (exportQueue.ts) - cancelled if the user goes ahead.
          if (!(await confirmCloseWithActiveExports())) return;
        } else if (isExportingRef.current) {
          const shouldCancelAndClose = await ask(
            "A video export is still in progress. Closing now will cancel it, and the exported file will be incomplete.",
            { title: "Export in progress", kind: "warning" }
          );
          if (!shouldCancelAndClose) return; // leave the window open - nothing else to do
          await invoke("cancel_conversion").catch(() => {}); // best-effort; proceeding to close either way
        }
        await flushSave();
        ownClose = true;
        await appWindow.close();
      })();
      await pendingClose;
      pendingClose = null; // lets a later close attempt (the user declined this one) re-prompt cleanly
    });

    setEditorCloseGuard(true);
    return () => {
      setEditorCloseGuard(false);
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [sourcePath, flushSave]);

  const setDuration = useCallback(
    (duration: number) => {
      if (sourcePath) registerSourceDuration(sourcePath, duration);
      // A project's "duration" is only its black preview canvas's - its timeline always comes from
      // the sidecar written when it was created, never a clip spanning the canvas itself.
      if (sourcePath && isVideoProjectPath(sourcePath)) return;
      setState((prev) => (prev ? prev : sourcePath ? createEmptyState(sourcePath, duration) : prev));
    },
    [sourcePath, registerSourceDuration]
  );

  const lastCommandRef = useRef<{ label: VideoEditCommand["label"]; at: number } | null>(null);
  const pushCommand = useCallback(
    (before: EditableFields, after: EditableFields, label: VideoEditCommand["label"]) => {
      // A recording never ends up with nothing to preview/export; a project may be emptied (it's
      // just an empty timeline waiting for media).
      if (after.clips.length === 0 && !(sourcePath && isVideoProjectPath(sourcePath))) return;
      const command: VideoEditCommand = { before, after, label };
      // Kept in step right away, not only once React re-renders (the effect mirroring `state`):
      // every operation builds its `after` from stateRef.current, so back-to-back edits in one
      // go - inserting several picked/dropped files in a row - would otherwise each start from
      // the same stale timeline and overwrite one another, leaving only the last one standing.
      if (stateRef.current) stateRef.current = { ...stateRef.current, ...applyCommand(command) };
      setState((prev) => (prev ? { ...prev, ...applyCommand(command), updatedAt: new Date().toISOString() } : prev));
      // A run of the same kind of edit in quick succession - a slider being dragged, a value being
      // nudged - is one undo step: it keeps the first edit's "before" and the latest "after".
      const now = Date.now();
      const merge = label.startsWith("edit-") && lastCommandRef.current?.label === label && now - lastCommandRef.current.at < EDIT_MERGE_MS;
      lastCommandRef.current = { label, at: now };
      setUndoStack((prev) => (merge && prev.length > 0 && prev[prev.length - 1].label === label ? [...prev.slice(0, -1), { ...prev[prev.length - 1], after }] : [...prev, command]));
      setRedoStack([]);
      scheduleAutosave();
    },
    [scheduleAutosave, sourcePath]
  );

  // Snapshot helper - every pushCommand call needs the *other* two overlay arrays passed through
  // unchanged alongside whichever one an operation actually touches, so this is the one place that
  // shape is assembled rather than repeating `{ clips, textOverlays, imageOverlays }` at every call
  // site with the risk of one field silently missing from a future addition.
  const snapshot = (current: VideoEditState, patch: Partial<EditableFields>): EditableFields => ({
    clips: current.clips,
    textOverlays: current.textOverlays,
    imageOverlays: current.imageOverlays,
    blurOverlays: current.blurOverlays,
    audioOverlays: current.audioOverlays,
    pipOverlays: current.pipOverlays,
    adjustmentLayers: current.adjustmentLayers ?? [],
    chapters: current.chapters ?? [],
    videoAudioMuted: current.videoAudioMuted,
    videoAudioVolume: current.videoAudioVolume,
    captions: current.captions ?? null,
    ...patch,
  });

  const splitAt = useCallback(
    (index: number, sourceTime: number) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = splitClipAt(current.clips, index, sourceTime);
      if (clips === current.clips) return; // too close to an edge - no-op
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "split");
    },
    [pushCommand]
  );

  const deleteClipAt = useCallback(
    (index: number) => {
      const current = stateRef.current;
      // A recording never deletes down to nothing left (there'd be nothing to fall back on) - a
      // project may, since an empty project is just an empty timeline waiting for media.
      if (!current || (current.clips.length <= 1 && !(sourcePath && isVideoProjectPath(sourcePath)))) return;
      const clips = deleteClipAtHandler(current.clips, index);
      if (clips === current.clips) return;
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "delete");
    },
    [pushCommand, sourcePath]
  );

  // Freeze frame / reverse (clip menu): the media they need is rendered by the caller first
  // (extract_frame_still / render_reversed_clip), then applied here as one undo step each.
  const freezeFrame = useCallback(
    (clipId: string, sourceTime: number, stillPath: string, seconds: number) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = insertFreezeFrameHandler(current.clips, clipId, sourceTime, stillPath, seconds);
      if (clips === current.clips) return;
      registerSourceDuration(stillPath, IMAGE_CLIP_MAX_SECONDS);
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "insert");
    },
    [pushCommand, registerSourceDuration]
  );
  const setClipReversed = useCallback(
    (clipId: string, reversedPath: string | null) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = reversedPath ? reverseClipHandler(current.clips, clipId, reversedPath) : unreverseClipHandler(current.clips, clipId);
      if (reversedPath) {
        const clip = current.clips.find((c) => c.id === clipId);
        if (clip) registerSourceDuration(reversedPath, clip.end - clip.start);
      }
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "edit-clip-effects");
    },
    [pushCommand, registerSourceDuration]
  );

  // A copy of one clip, effects and all, placed right after it.
  const duplicateClip = useCallback(
    (id: string) => {
      const current = stateRef.current;
      const index = current?.clips.findIndex((c) => c.id === id) ?? -1;
      if (!current || index < 0) return;
      const clips = insertClipHandler(current.clips, index + 1, { ...current.clips[index], id: crypto.randomUUID() });
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "insert");
    },
    [pushCommand]
  );

  const deleteClips = useCallback(
    (ids: string[]) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = deleteClipsHandler(current.clips, ids);
      if (clips === current.clips) return;
      // pushCommand refuses emptying a recording, same rule as deleteClipAt.
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "delete");
    },
    [pushCommand]
  );

  const duplicateClips = useCallback(
    (ids: string[]) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = duplicateClipsHandler(current.clips, ids, () => crypto.randomUUID());
      if (clips === current.clips) return;
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "insert");
    },
    [pushCommand]
  );

  const setImageClipLengths = useCallback(
    (seconds: number) => {
      const current = stateRef.current;
      if (!current) return;
      pushCommand(snapshot(current, {}), snapshot(current, { clips: setImageClipLengthsHandler(current.clips, seconds) }), "trim");
    },
    [pushCommand]
  );

  const trimSilenceForClip = useCallback(
    (clipId: string, silentRanges: { start: number; end: number }[]) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = removeSilentRangesHandler(current.clips, clipId, silentRanges);
      if (clips === current.clips) return;
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "trim-silence");
    },
    [pushCommand]
  );

  const applyAutoZoomAtClicks = useCallback(
    (clipId: string, clicks: AutoZoomClick[]) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = applyAutoZoomAtClicksHandler(current.clips, clipId, clicks);
      if (clips === current.clips) return;
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "auto-zoom");
    },
    [pushCommand]
  );

  const applyViewSwitchOverlays = useCallback(
    (clipId: string, events: ViewSwitchEvent[], webcamPath: string, clipOutputStart: number) => {
      const current = stateRef.current;
      if (!current) return;
      const clip = current.clips.find((c) => c.id === clipId);
      if (!clip) return;
      const newOverlays = buildViewSwitchOverlays(events, clip.start, clip.end, clipOutputStart, clip.speed, webcamPath);
      if (newOverlays.length === 0) return;
      const pipOverlays = [...current.pipOverlays, ...newOverlays];
      pushCommand(snapshot(current, {}), snapshot(current, { pipOverlays }), "view-switch-cut");
    },
    [pushCommand]
  );

  const reorderClip = useCallback(
    (fromIndex: number, toIndex: number) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = reorderClipHandler(current.clips, fromIndex, toIndex);
      if (clips === current.clips) return;
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "reorder");
    },
    [pushCommand]
  );

  const resizeClipEdge = useCallback(
    (id: string, edge: "start" | "end", time: number) => {
      const current = stateRef.current;
      if (!current) return;
      const target = current.clips.find((c) => c.id === id);
      if (!target) return;
      const maxEnd = getSourceDuration(target.sourcePath) ?? Number.POSITIVE_INFINITY;
      const clips = resizeClipEdgeHandler(current.clips, id, edge, maxEnd, time);
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "trim");
    },
    [pushCommand, getSourceDuration]
  );

  const updateClipEffects = useCallback(
    (id: string, patch: ClipEffectsPatch) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = updateClipHandler(current.clips, id, patch);
      if (clips === current.clips) return;
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "edit-clip-effects");
    },
    [pushCommand]
  );

  const updateAllClipEffects = useCallback(
    (patch: ClipEffectsPatch) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = current.clips.reduce((acc, clip) => updateClipHandler(acc, clip.id, patch), current.clips);
      if (clips === current.clips) return;
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "edit-clip-effects");
    },
    [pushCommand]
  );

  const updateClipsEffects = useCallback(
    (ids: string[], patch: ClipEffectsPatch | ((clip: Clip) => ClipEffectsPatch | null)) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = ids.reduce((acc, id) => {
        const clip = acc.find((c) => c.id === id);
        const clipPatch = clip && (typeof patch === "function" ? patch(clip) : patch);
        return clipPatch ? updateClipHandler(acc, id, clipPatch) : acc;
      }, current.clips);
      if (clips === current.clips) return;
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "edit-clip-effects");
    },
    [pushCommand]
  );

  // Total duration of the assembled/output timeline right now - the same quantity
  // VideoTimelineDocker derives as `totalOutputDuration` from its (possibly live-drag) render
  // clips, recomputed here from the last *committed* clips since overlay time edits are a
  // separate operation from an in-progress clip resize, never concurrent with one.
  // (end-start)/speed, not just (end-start), once a clip has a speed edit (Clip.speed's own doc
  // comment, videoEditTypes.ts) - a sped-up clip plays back in LESS output time than its source
  // range spans, so summing raw source ranges here would over-clamp every overlay's own end time
  // against a timeline length longer than the real one.
  const totalOutputDuration = (clips: Clip[]): number => clips.reduce((sum, c) => sum + clipOutputDuration(c), 0);

  const addTextOverlay = useCallback(
    (x: number, y: number, width: number, fontSize: number, startTime: number, endTime: number): string => {
      const current = stateRef.current;
      if (!current) return "";
      const overlay = makeTextOverlay(x, y, width, fontSize, startTime, endTime);
      const textOverlays = addOverlay(current.textOverlays, overlay);
      pushCommand(snapshot(current, {}), snapshot(current, { textOverlays }), "add-text");
      return overlay.id;
    },
    [pushCommand]
  );

  const updateTextOverlayContent = useCallback(
    (id: string, patch: TextOverlayContentPatch) => {
      const current = stateRef.current;
      if (!current) return;
      const textOverlays = updateOverlay<TextOverlay>(current.textOverlays, id, patch);
      pushCommand(snapshot(current, {}), snapshot(current, { textOverlays }), "edit-text");
    },
    [pushCommand]
  );

  const resizeTextOverlayTime = useCallback(
    (id: string, edge: "start" | "end", time: number) => {
      const current = stateRef.current;
      if (!current) return;
      const textOverlays = resizeOverlayTime(current.textOverlays, id, edge, totalOutputDuration(current.clips), time);
      pushCommand(snapshot(current, {}), snapshot(current, { textOverlays }), "edit-text");
    },
    [pushCommand]
  );

  const moveTextOverlayTime = useCallback(
    (id: string, newStartTime: number) => {
      const current = stateRef.current;
      if (!current) return;
      const textOverlays = moveOverlayTime(current.textOverlays, id, newStartTime, totalOutputDuration(current.clips));
      pushCommand(snapshot(current, {}), snapshot(current, { textOverlays }), "edit-text");
    },
    [pushCommand]
  );

  const deleteTextOverlay = useCallback(
    (id: string) => {
      const current = stateRef.current;
      if (!current) return;
      const textOverlays = deleteOverlay(current.textOverlays, id);
      pushCommand(snapshot(current, {}), snapshot(current, { textOverlays }), "delete-text");
    },
    [pushCommand]
  );

  // Returns the new copy's id so the caller (VideoOverlayLayer, from either the right-click menu
  // or the style panel's Duplicate button) can immediately select it, same "hand the new id back"
  // shape addTextOverlay already uses for its own "select it right away" flow.
  const duplicateTextOverlay = useCallback(
    (id: string): string => {
      const current = stateRef.current;
      if (!current) return "";
      const original = current.textOverlays.find((o) => o.id === id);
      if (!original) return "";
      const copy = duplicateOverlay(original);
      const textOverlays = addOverlay(current.textOverlays, copy);
      pushCommand(snapshot(current, {}), snapshot(current, { textOverlays }), "add-text");
      return copy.id;
    },
    [pushCommand]
  );

  const bringTextOverlayToFront = useCallback(
    (id: string) => {
      const current = stateRef.current;
      if (!current) return;
      const textOverlays = bringOverlayToFront(current.textOverlays, id);
      if (textOverlays === current.textOverlays) return;
      pushCommand(snapshot(current, {}), snapshot(current, { textOverlays }), "edit-text");
    },
    [pushCommand]
  );

  const sendTextOverlayToBack = useCallback(
    (id: string) => {
      const current = stateRef.current;
      if (!current) return;
      const textOverlays = sendOverlayToBack(current.textOverlays, id);
      if (textOverlays === current.textOverlays) return;
      pushCommand(snapshot(current, {}), snapshot(current, { textOverlays }), "edit-text");
    },
    [pushCommand]
  );

  const addImageOverlay = useCallback(
    (src: string, x: number, y: number, width: number, height: number, startTime: number, endTime: number, asset?: OverlayAsset): string => {
      const current = stateRef.current;
      if (!current) return "";
      const overlay = makeImageOverlay(src, x, y, width, height, startTime, endTime, asset);
      const imageOverlays = addOverlay(current.imageOverlays, overlay);
      pushCommand(snapshot(current, {}), snapshot(current, { imageOverlays }), "add-image");
      return overlay.id;
    },
    [pushCommand]
  );

  const updateImageOverlayContent = useCallback(
    (id: string, patch: ImageOverlayContentPatch) => {
      const current = stateRef.current;
      if (!current) return;
      const imageOverlays = updateOverlay<ImageOverlay>(current.imageOverlays, id, patch);
      pushCommand(snapshot(current, {}), snapshot(current, { imageOverlays }), "edit-image");
    },
    [pushCommand]
  );

  const resizeImageOverlayTime = useCallback(
    (id: string, edge: "start" | "end", time: number) => {
      const current = stateRef.current;
      if (!current) return;
      const imageOverlays = resizeOverlayTime(current.imageOverlays, id, edge, totalOutputDuration(current.clips), time);
      pushCommand(snapshot(current, {}), snapshot(current, { imageOverlays }), "edit-image");
    },
    [pushCommand]
  );

  const moveImageOverlayTime = useCallback(
    (id: string, newStartTime: number) => {
      const current = stateRef.current;
      if (!current) return;
      const imageOverlays = moveOverlayTime(current.imageOverlays, id, newStartTime, totalOutputDuration(current.clips));
      pushCommand(snapshot(current, {}), snapshot(current, { imageOverlays }), "edit-image");
    },
    [pushCommand]
  );

  const deleteImageOverlay = useCallback(
    (id: string) => {
      const current = stateRef.current;
      if (!current) return;
      const imageOverlays = deleteOverlay(current.imageOverlays, id);
      pushCommand(snapshot(current, {}), snapshot(current, { imageOverlays }), "delete-image");
    },
    [pushCommand]
  );

  const duplicateImageOverlay = useCallback(
    (id: string): string => {
      const current = stateRef.current;
      if (!current) return "";
      const original = current.imageOverlays.find((o) => o.id === id);
      if (!original) return "";
      const copy = duplicateOverlay(original);
      const imageOverlays = addOverlay(current.imageOverlays, copy);
      pushCommand(snapshot(current, {}), snapshot(current, { imageOverlays }), "add-image");
      return copy.id;
    },
    [pushCommand]
  );

  const bringImageOverlayToFront = useCallback(
    (id: string) => {
      const current = stateRef.current;
      if (!current) return;
      const imageOverlays = bringOverlayToFront(current.imageOverlays, id);
      if (imageOverlays === current.imageOverlays) return;
      pushCommand(snapshot(current, {}), snapshot(current, { imageOverlays }), "edit-image");
    },
    [pushCommand]
  );

  const sendImageOverlayToBack = useCallback(
    (id: string) => {
      const current = stateRef.current;
      if (!current) return;
      const imageOverlays = sendOverlayToBack(current.imageOverlays, id);
      if (imageOverlays === current.imageOverlays) return;
      pushCommand(snapshot(current, {}), snapshot(current, { imageOverlays }), "edit-image");
    },
    [pushCommand]
  );

  const addBlurOverlay = useCallback(
    (x: number, y: number, width: number, height: number, intensity: number, startTime: number, endTime: number): string => {
      const current = stateRef.current;
      if (!current) return "";
      const overlay = makeBlurOverlay(x, y, width, height, intensity, startTime, endTime);
      const blurOverlays = addOverlay(current.blurOverlays, overlay);
      pushCommand(snapshot(current, {}), snapshot(current, { blurOverlays }), "add-blur");
      return overlay.id;
    },
    [pushCommand]
  );

  const updateBlurOverlayContent = useCallback(
    (id: string, patch: BlurOverlayContentPatch) => {
      const current = stateRef.current;
      if (!current) return;
      const blurOverlays = updateOverlay<BlurOverlay>(current.blurOverlays, id, patch);
      pushCommand(snapshot(current, {}), snapshot(current, { blurOverlays }), "edit-blur");
    },
    [pushCommand]
  );

  const resizeBlurOverlayTime = useCallback(
    (id: string, edge: "start" | "end", time: number) => {
      const current = stateRef.current;
      if (!current) return;
      const blurOverlays = resizeOverlayTime(current.blurOverlays, id, edge, totalOutputDuration(current.clips), time);
      pushCommand(snapshot(current, {}), snapshot(current, { blurOverlays }), "edit-blur");
    },
    [pushCommand]
  );

  const moveBlurOverlayTime = useCallback(
    (id: string, newStartTime: number) => {
      const current = stateRef.current;
      if (!current) return;
      const blurOverlays = moveOverlayTime(current.blurOverlays, id, newStartTime, totalOutputDuration(current.clips));
      pushCommand(snapshot(current, {}), snapshot(current, { blurOverlays }), "edit-blur");
    },
    [pushCommand]
  );

  const deleteBlurOverlay = useCallback(
    (id: string) => {
      const current = stateRef.current;
      if (!current) return;
      const blurOverlays = deleteOverlay(current.blurOverlays, id);
      pushCommand(snapshot(current, {}), snapshot(current, { blurOverlays }), "delete-blur");
    },
    [pushCommand]
  );

  const duplicateBlurOverlay = useCallback(
    (id: string): string => {
      const current = stateRef.current;
      if (!current) return "";
      const original = current.blurOverlays.find((o) => o.id === id);
      if (!original) return "";
      const copy = duplicateOverlay(original);
      const blurOverlays = addOverlay(current.blurOverlays, copy);
      pushCommand(snapshot(current, {}), snapshot(current, { blurOverlays }), "add-blur");
      return copy.id;
    },
    [pushCommand]
  );

  const addAdjustmentLayer = useCallback(
    (startTime: number, endTime: number, patch?: AdjustmentLayerPatch): string => {
      const current = stateRef.current;
      if (!current) return "";
      const layer = makeAdjustmentLayer(startTime, endTime, patch);
      pushCommand(snapshot(current, {}), snapshot(current, { adjustmentLayers: [...(current.adjustmentLayers ?? []), layer] }), "add-adjustment");
      return layer.id;
    },
    [pushCommand]
  );

  const updateAdjustmentLayer = useCallback(
    (id: string, patch: AdjustmentLayerPatch) => {
      const current = stateRef.current;
      if (!current) return;
      const adjustmentLayers = updateOverlay<AdjustmentLayer>(current.adjustmentLayers ?? [], id, patch);
      pushCommand(snapshot(current, {}), snapshot(current, { adjustmentLayers }), "edit-adjustment");
    },
    [pushCommand]
  );

  const resizeAdjustmentLayerTime = useCallback(
    (id: string, edge: "start" | "end", time: number) => {
      const current = stateRef.current;
      if (!current) return;
      const adjustmentLayers = resizeOverlayTime(current.adjustmentLayers ?? [], id, edge, totalOutputDuration(current.clips), time);
      pushCommand(snapshot(current, {}), snapshot(current, { adjustmentLayers }), "edit-adjustment");
    },
    [pushCommand]
  );

  const moveAdjustmentLayerTime = useCallback(
    (id: string, newStartTime: number) => {
      const current = stateRef.current;
      if (!current) return;
      const adjustmentLayers = moveOverlayTime(current.adjustmentLayers ?? [], id, newStartTime, totalOutputDuration(current.clips));
      pushCommand(snapshot(current, {}), snapshot(current, { adjustmentLayers }), "edit-adjustment");
    },
    [pushCommand]
  );

  const deleteAdjustmentLayer = useCallback(
    (id: string) => {
      const current = stateRef.current;
      if (!current) return;
      pushCommand(snapshot(current, {}), snapshot(current, { adjustmentLayers: deleteOverlay(current.adjustmentLayers ?? [], id) }), "delete-adjustment");
    },
    [pushCommand]
  );

  const duplicateAdjustmentLayer = useCallback(
    (id: string): string => {
      const current = stateRef.current;
      const original = current?.adjustmentLayers?.find((l) => l.id === id);
      if (!current || !original) return "";
      const now = Date.now();
      const copy: AdjustmentLayer = { ...original, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
      pushCommand(snapshot(current, {}), snapshot(current, { adjustmentLayers: [...current.adjustmentLayers, copy] }), "add-adjustment");
      return copy.id;
    },
    [pushCommand]
  );

  const setChapters = useCallback(
    (chapters: VideoChapter[]) => {
      const current = stateRef.current;
      if (!current) return;
      pushCommand(snapshot(current, {}), snapshot(current, { chapters }), "edit-chapters");
    },
    [pushCommand]
  );

  const addAudioOverlay = useCallback(
    (src: string, sourceDuration: number, startTime: number, endTime: number, extras?: NewAudioOverlayExtras): string => {
      const current = stateRef.current;
      if (!current) return "";
      const overlay = { ...makeAudioOverlay(src, sourceDuration, startTime, endTime), ...extras };
      const audioOverlays = addOverlay(current.audioOverlays, overlay);
      pushCommand(snapshot(current, {}), snapshot(current, { audioOverlays }), "add-audio");
      return overlay.id;
    },
    [pushCommand]
  );

  const detachVideoAudio = useCallback(
    (tracks: { src: string; sourceDuration: number; startTime: number; endTime: number; label?: string }[]) => {
      const current = stateRef.current;
      if (!current || tracks.length === 0) return;
      // Replace, don't stack: a previous detach's overlays would otherwise keep playing underneath
      // the new ones. User-added music (not from a detach) is left alone.
      let audioOverlays = current.audioOverlays.filter((o) => !isDetachedAudioOverlay(o));
      for (const t of tracks) audioOverlays = addOverlay(audioOverlays, { ...makeAudioOverlay(t.src, t.sourceDuration, t.startTime, t.endTime, t.label), detached: true });
      pushCommand(snapshot(current, {}), snapshot(current, { audioOverlays, videoAudioMuted: true }), "detach-audio");
    },
    [pushCommand]
  );

  const updateAudioOverlayContent = useCallback(
    (id: string, patch: AudioOverlayContentPatch) => {
      const current = stateRef.current;
      if (!current) return;
      const audioOverlays = updateOverlay<AudioOverlay>(current.audioOverlays, id, patch);
      pushCommand(snapshot(current, {}), snapshot(current, { audioOverlays }), "edit-audio");
    },
    [pushCommand]
  );

  // Beat sync: every image clip fitted to end `everyBeats` beats after it starts (beatSync.ts),
  // against all music tracks' beats - one undo step.
  const cutImagesOnBeat = useCallback(
    (everyBeats: number) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = fitImageClipsToBeats(current.clips, beatOutputTimes(current.audioOverlays), everyBeats);
      if (clips === current.clips) return;
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "trim");
    },
    [pushCommand]
  );

  const resizeAudioOverlayTimeCb = useCallback(
    (id: string, edge: "start" | "end", time: number) => {
      const current = stateRef.current;
      if (!current) return;
      // Only the file's own length bounds an audio overlay's end - it may run past the video's end
      // (shown dimmed on the lane; export's amix stops at the video's own length).
      const audioOverlays = resizeAudioOverlayTime(current.audioOverlays, id, edge, Number.POSITIVE_INFINITY, time);
      pushCommand(snapshot(current, {}), snapshot(current, { audioOverlays }), "edit-audio");
    },
    [pushCommand]
  );

  const moveAudioOverlayTime = useCallback(
    (id: string, newStartTime: number) => {
      const current = stateRef.current;
      if (!current) return;
      // Free to hang past the video's end (see resizeAudioOverlayTimeCb), but it has to start inside it.
      const latestStart = Math.max(0, totalOutputDuration(current.clips) - MIN_AUDIO_START_ROOM_SEC);
      const audioOverlays = moveOverlayTime(current.audioOverlays, id, Math.min(newStartTime, latestStart), Number.POSITIVE_INFINITY);
      pushCommand(snapshot(current, {}), snapshot(current, { audioOverlays }), "edit-audio");
    },
    [pushCommand]
  );

  const deleteAudioOverlay = useCallback(
    (id: string) => {
      const current = stateRef.current;
      if (!current) return;
      const audioOverlays = deleteOverlay(current.audioOverlays, id);
      pushCommand(snapshot(current, {}), snapshot(current, { audioOverlays }), "delete-audio");
    },
    [pushCommand]
  );

  const duplicateAudioOverlay = useCallback(
    (id: string): string => {
      const current = stateRef.current;
      if (!current) return "";
      const original = current.audioOverlays.find((o) => o.id === id);
      if (!original) return "";
      const copy = duplicateTimedOverlay(original, totalOutputDuration(current.clips));
      const audioOverlays = addOverlay(current.audioOverlays, copy);
      pushCommand(snapshot(current, {}), snapshot(current, { audioOverlays }), "add-audio");
      return copy.id;
    },
    [pushCommand]
  );

  const addPipOverlay = useCallback(
    (sourcePath: string, sourceDuration: number, x: number, y: number, width: number, height: number, startTime: number, endTime: number): string => {
      const current = stateRef.current;
      if (!current) return "";
      const overlay = makePipOverlay(sourcePath, sourceDuration, x, y, width, height, startTime, endTime);
      const pipOverlays = addOverlay(current.pipOverlays, overlay);
      pushCommand(snapshot(current, {}), snapshot(current, { pipOverlays }), "add-pip");
      return overlay.id;
    },
    [pushCommand]
  );

  const addSplitScreen = useCallback(
    (cells: SplitScreenCell[], startTime: number, endTime: number, backdropColor: string | null): string[] => {
      const current = stateRef.current;
      if (!current || cells.length === 0) return [];
      const pips = cells.map((c) => ({
        ...makePipOverlay(c.sourcePath, c.sourceDuration, c.x, c.y, c.width, c.height, startTime, endTime),
        shape: (c.cornerRadius > 0 ? "rounded" : "rectangle") as PipOverlay["shape"],
        ...(c.cornerRadius > 0 ? { cornerRadius: c.cornerRadius } : {}),
        // Never past the end of its own source.
        trimStart: Math.max(0, Math.min(c.trimStart, c.sourceDuration - (endTime - startTime))),
        muted: c.muted,
      }));
      const backdrop = backdropColor
        ? [
            makeImageOverlay("", 0, 0, 1, 1, startTime, endTime, {
              kind: "rectangle",
              color: backdropColor,
              entrance: "none",
              exit: false,
              loop: "none",
            }),
          ]
        : [];
      pushCommand(
        snapshot(current, {}),
        snapshot(current, { pipOverlays: [...current.pipOverlays, ...pips], imageOverlays: [...current.imageOverlays, ...backdrop] }),
        "add-pip"
      );
      return pips.map((p) => p.id);
    },
    [pushCommand]
  );

  const insertHighlightIntro = useCallback(
    (introClips: Clip[], into: ClipTransitionIn | null, keepMusicInPlace: boolean) => {
      const current = stateRef.current;
      if (!current || introClips.length === 0) return;
      const shift = introClips.reduce((sum, c) => sum + clipOutputDuration(c), 0);
      const later = <T extends { startTime: number; endTime: number }>(o: T): T => ({ ...o, startTime: o.startTime + shift, endTime: o.endTime + shift });
      const [first, ...rest] = current.clips;
      const firstShot = first ? (into ? { ...first, transitionIn: into } : first) : undefined;
      pushCommand(
        snapshot(current, {}),
        snapshot(current, {
          clips: [...introClips, ...(firstShot ? [firstShot] : []), ...rest],
          textOverlays: current.textOverlays.map(later),
          imageOverlays: current.imageOverlays.map(later),
          blurOverlays: current.blurOverlays.map(later),
          pipOverlays: current.pipOverlays.map(later),
          adjustmentLayers: (current.adjustmentLayers ?? []).map(later),
          audioOverlays: keepMusicInPlace ? current.audioOverlays : current.audioOverlays.map(later),
        }),
        "insert"
      );
    },
    [pushCommand]
  );

  const updatePipOverlayContent = useCallback(
    (id: string, patch: PipOverlayContentPatch) => {
      const current = stateRef.current;
      if (!current) return;
      const pipOverlays = updateOverlay<PipOverlay>(current.pipOverlays, id, patch);
      pushCommand(snapshot(current, {}), snapshot(current, { pipOverlays }), "edit-pip");
    },
    [pushCommand]
  );

  const resizePipOverlayTimeCb = useCallback(
    (id: string, edge: "start" | "end", time: number) => {
      const current = stateRef.current;
      if (!current) return;
      const pipOverlays = resizePipOverlayTime(current.pipOverlays, id, edge, totalOutputDuration(current.clips), time);
      pushCommand(snapshot(current, {}), snapshot(current, { pipOverlays }), "edit-pip");
    },
    [pushCommand]
  );

  const movePipOverlayTime = useCallback(
    (id: string, newStartTime: number) => {
      const current = stateRef.current;
      if (!current) return;
      const pipOverlays = moveOverlayTime(current.pipOverlays, id, newStartTime, totalOutputDuration(current.clips));
      pushCommand(snapshot(current, {}), snapshot(current, { pipOverlays }), "edit-pip");
    },
    [pushCommand]
  );

  const deletePipOverlay = useCallback(
    (id: string) => {
      const current = stateRef.current;
      if (!current) return;
      const pipOverlays = deletePipOverlayAndCloseGap(current.pipOverlays, id);
      pushCommand(snapshot(current, {}), snapshot(current, { pipOverlays }), "delete-pip");
    },
    [pushCommand]
  );

  const splitAudioOverlay = useCallback(
    (id: string, outputTime: number): string => {
      const current = stateRef.current;
      if (!current) return "";
      const audioOverlays = splitAudioOverlayAt(current.audioOverlays, id, outputTime);
      if (audioOverlays === current.audioOverlays) return "";
      pushCommand(snapshot(current, {}), snapshot(current, { audioOverlays }), "edit-audio");
      const index = audioOverlays.findIndex((o) => o.id === id);
      return audioOverlays[index + 1]?.id ?? "";
    },
    [pushCommand]
  );

  const splitPipOverlay = useCallback(
    (id: string, outputTime: number): string => {
      const current = stateRef.current;
      if (!current) return "";
      const pipOverlays = splitPipOverlayAt(current.pipOverlays, id, outputTime);
      if (pipOverlays === current.pipOverlays) return "";
      pushCommand(snapshot(current, {}), snapshot(current, { pipOverlays }), "edit-pip");
      const index = pipOverlays.findIndex((o) => o.id === id);
      return pipOverlays[index + 1]?.id ?? "";
    },
    [pushCommand]
  );

  const duplicatePipOverlay = useCallback(
    (id: string): string => {
      const current = stateRef.current;
      if (!current) return "";
      const original = current.pipOverlays.find((o) => o.id === id);
      if (!original) return "";
      const copy = duplicateTimedOverlay(original, totalOutputDuration(current.clips));
      const pipOverlays = addOverlay(current.pipOverlays, copy);
      pushCommand(snapshot(current, {}), snapshot(current, { pipOverlays }), "add-pip");
      return copy.id;
    },
    [pushCommand]
  );

  const setVideoAudioMuted = useCallback(
    (muted: boolean) => {
      const current = stateRef.current;
      if (!current) return;
      pushCommand(snapshot(current, {}), snapshot(current, { videoAudioMuted: muted }), "edit-track-audio");
    },
    [pushCommand]
  );

  const setVideoAudioVolume = useCallback(
    (volume: number) => {
      const current = stateRef.current;
      if (!current) return;
      const clamped = Math.max(0, Math.min(1, volume));
      pushCommand(snapshot(current, {}), snapshot(current, { videoAudioVolume: clamped }), "edit-track-audio");
    },
    [pushCommand]
  );

  const setCaptionTranscripts = useCallback(
    (language: string, transcripts: Record<string, CaptionWord[]>, options?: { captionsEnabled?: boolean }) => {
      const current = stateRef.current;
      if (!current) return;
      const existing = current.captions;
      // A first transcript made just to edit by (the Transcript panel) leaves burned-in captions
      // off until the user turns them on; an existing track keeps whatever it was set to.
      const settings = existing?.settings ?? { ...defaultCaptionSettings(), enabled: options?.captionsEnabled ?? true };
      const captions: CaptionTrack = {
        language,
        transcripts: { ...(existing?.transcripts ?? {}), ...transcripts },
        settings,
      };
      pushCommand(snapshot(current, {}), snapshot(current, { captions }), "edit-captions");
    },
    [pushCommand]
  );

  // Edit by transcript (TranscriptEditorPanel): removes source ranges from specific clips as one
  // undo step - see cutClipRanges (videoEditHandlers.ts) and transcriptEdit.ts for how word
  // selections and pause tightening become these ranges.
  const cutClipRanges = useCallback(
    (cuts: { clipId: string; start: number; end: number }[]) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = cutClipRangesHandler(current.clips, cuts);
      if (clips === current.clips) return;
      pushCommand(snapshot(current, {}), snapshot(current, { clips }), "edit-transcript");
    },
    [pushCommand]
  );

  const updateCaptionSettings = useCallback(
    (patch: Partial<CaptionSettings>) => {
      const current = stateRef.current;
      if (!current?.captions) return;
      const captions: CaptionTrack = { ...current.captions, settings: { ...current.captions.settings, ...patch } };
      pushCommand(snapshot(current, {}), snapshot(current, { captions }), "edit-captions");
    },
    [pushCommand]
  );

  const editCaptionLine = useCallback(
    (line: CaptionLine, text: string) => {
      const current = stateRef.current;
      if (!current?.captions) return;
      const captions = replaceCaptionLineText(current.captions, line, text);
      if (captions === current.captions) return;
      pushCommand(snapshot(current, {}), snapshot(current, { captions }), "edit-captions");
    },
    [pushCommand]
  );

  const clearCaptions = useCallback(() => {
    const current = stateRef.current;
    if (!current?.captions) return;
    pushCommand(snapshot(current, {}), snapshot(current, { captions: null }), "edit-captions");
  }, [pushCommand]);

  const insertClipAt = useCallback(
    async (newClipSourcePath: string, atIndex: number) => {
      const current = stateRef.current;
      // `current == null` here means the edit store hasn't finished loading/seeding yet (a real
      // possible race right after opening a file), which would silently swallow every insert.
      if (!current) return;
      // Captured before the await below - if the user switches to a different video while a
      // duration lookup is in flight, sourcePathRef.current no longer matches this by the time we
      // come back, and the insert (meant for the file open when the drag happened) must be
      // dropped instead of landing on whatever file happens to be open now. Without this,
      // `stateRef.current` after the await still looks perfectly valid - it's just the NEW file's
      // state - so the insert would silently land in the wrong video's edit history.
      const requestedForSourcePath = sourcePath;
      let duration = getSourceDuration(newClipSourcePath);
      if (duration == null) {
        duration = await fetchDuration(newClipSourcePath);
        if (duration == null) return; // couldn't read this file - nothing to insert
        if (sourcePathRef.current !== requestedForSourcePath) return; // switched files mid-lookup
        registerSourceDuration(newClipSourcePath, duration);
      }
      if (sourcePathRef.current !== requestedForSourcePath) return; // switched files mid-lookup
      const latest = stateRef.current;
      if (!latest) return;
      // An image clip starts at a slideshow-friendly length rather than its (very long) maximum.
      const end = isImageClipPath(newClipSourcePath) ? Math.min(duration, DEFAULT_IMAGE_CLIP_SECONDS) : duration;
      const newClip: Clip = { id: crypto.randomUUID(), sourcePath: newClipSourcePath, start: 0, end };
      const clips = insertClipHandler(latest.clips, atIndex, newClip);
      pushCommand(snapshot(latest, {}), snapshot(latest, { clips }), "insert");
    },
    [pushCommand, getSourceDuration, registerSourceDuration, sourcePath]
  );

  // The new media plays from its start for as long as the old clip ran (or all of it, if it's
  // shorter), so the rest of the timeline doesn't shift. Look and motion carry over; what only
  // made sense for the old file's own content - a reversed render, a noise sample - doesn't.
  const replaceClipSource = useCallback(
    async (id: string, newSourcePath: string) => {
      const requestedForSourcePath = sourcePath; // same mid-lookup file-switch guard as insertClipAt
      let duration = getSourceDuration(newSourcePath);
      if (duration == null) {
        duration = await fetchDuration(newSourcePath);
        if (duration == null || sourcePathRef.current !== requestedForSourcePath) return;
        registerSourceDuration(newSourcePath, duration);
      }
      if (sourcePathRef.current !== requestedForSourcePath) return;
      const latest = stateRef.current;
      const old = latest?.clips.find((c) => c.id === id);
      if (!latest || !old) return;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { reversedFrom, ...kept } = old;
      if (kept.audioCleanup?.noiseSample) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { noiseSample, ...cleanup } = kept.audioCleanup;
        kept.audioCleanup = cleanup;
      }
      const sourceLength = old.end - old.start;
      const replaced: Clip = { ...kept, sourcePath: newSourcePath, start: 0, end: Math.min(duration, sourceLength) };
      const clips = latest.clips.map((c) => (c.id === id ? replaced : c));
      pushCommand(snapshot(latest, {}), snapshot(latest, { clips }), "replace-clip");
    },
    [pushCommand, getSourceDuration, registerSourceDuration, sourcePath]
  );

  const undo = useCallback(() => {
    lastCommandRef.current = null;
    setUndoStack((prevUndo) => {
      if (prevUndo.length === 0) return prevUndo;
      const command = prevUndo[prevUndo.length - 1];
      setState((prev) => (prev ? { ...prev, ...command.before, updatedAt: new Date().toISOString() } : prev));
      setRedoStack((prevRedo) => [...prevRedo, command]);
      scheduleAutosave();
      return prevUndo.slice(0, -1);
    });
  }, [scheduleAutosave]);

  const redo = useCallback(() => {
    lastCommandRef.current = null;
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;
      const command = prevRedo[prevRedo.length - 1];
      setState((prev) => (prev ? { ...prev, ...applyCommand(command), updatedAt: new Date().toISOString() } : prev));
      setUndoStack((prevUndo) => [...prevUndo, command]);
      scheduleAutosave();
      return prevRedo.slice(0, -1);
    });
  }, [scheduleAutosave]);

  // Surfaces export_trimmed_video's progress (it runs through the same run_conversion machinery
  // every other conversion does, so it emits the same 'conversion-progress' event, keyed by the
  // primary file's path regardless of how many distinct source files the export actually reads
  // from - see export_trimmed_video's own comment on `progress_key`) filtered down to this file,
  // so the Save button can show real percentage instead of just a spinner.
  useEffect(() => {
    if (!sourcePath) return;
    let unlisten: (() => void) | undefined;
    listen<ConversionProgressPayload>("conversion-progress", (event) => {
      if (event.payload.input_path !== sourcePath) return;
      if (event.payload.status === "completed" || event.payload.status === "failed") {
        setExportProgress(null);
      } else {
        setExportProgress(event.payload.progress);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [sourcePath]);

  // `videoPixelSize` is the primary file's native pixel resolution - the caller (VideoTimelineDocker)
  // already reads it off the same hidden capture <video> it uses for thumbnails, since
  // TextOverlay/ImageOverlay only ever store position/size as frame-relative fractions (see
  // videoEditTypes.ts) and rendering an overlay to a real PNG needs real pixel dimensions.
  // Overlays whose own render comes back null (empty text, zero-size box, an image that failed to
  // decode) are just skipped rather than failing the whole export.
  // Builds everything one export of the timeline needs - overlays rendered to pictures, blur and
  // picture-in-picture boxes in output pixels, adjustment layers with their masks, captions,
  // chapters - from the timeline as it is right now. The background export queue (exportQueue.ts)
  // renders it later while editing carries on, so nothing here may read the timeline again.
  // `timelinePixelSize` is the primary file's native resolution: TextOverlay/ImageOverlay keep
  // position/size as frame fractions, and rendering an overlay to a real PNG needs real pixels.
  // Overlays whose render comes back null (empty text, zero-size box, an image that failed to
  // decode) are skipped rather than failing the export.
  const prepareExport = useCallback(
    async (timelinePixelSize: { width: number; height: number } | null, options?: ExportOptions): Promise<ExportJobPayload | null> => {
      const current = stateRef.current;
      if (!sourcePath || !current || current.clips.length === 0) return null;
      // Overlays, blur regions, picture-in-picture and captions are laid out on the FINAL frame -
      // the platform format's when one is chosen (export fits the video into it first).
      const videoPixelSize = options?.outputFrame ? { width: options.outputFrame.width, height: options.outputFrame.height } : timelinePixelSize;
      const overlays: {
        dataBase64: string;
        x: number;
        y: number;
        startTime: number;
        endTime: number;
        animation: string;
        keyframes?: ExportKeyframe[];
        frames?: { unique: string[]; sequence: number[] };
        blendMode?: string;
      }[] = [];
      if (videoPixelSize) {
        const { width: pxW, height: pxH } = videoPixelSize;
        // Keyframes in the export's terms: absolute output seconds, and the rendered PNG's own
        // top-left in pixels (offset from the overlay's x/y by however the renderer padded it).
        const exportKeyframes = (o: { x: number; y: number; startTime: number; keyframes?: OverlayKeyframe[] }, xPx: number, yPx: number) =>
          o.keyframes && o.keyframes.length > 0
            ? o.keyframes.map((k) => ({
                time: o.startTime + k.time,
                x: xPx + (k.x - o.x) * pxW,
                y: yPx + (k.y - o.y) * pxH,
                scale: k.scale,
                opacity: k.opacity,
                easing: k.easing,
              }))
            : undefined;
        // Pictures and elements first, then text: the preview stacks text above them
        // (VideoOverlayLayer draws its text boxes last), so the export does too.
        for (const o of current.imageOverlays) {
          const blendMode = exportBlendMode(o.blendMode);
          if (o.asset) {
            // A shape/animated element burns in as a frame sequence of its own animation -
            // drawn by the same function as the preview (videoAssets.ts).
            // eslint-disable-next-line no-await-in-loop
            const seq = await renderAssetFrames(o, pxW, pxH);
            if (seq)
              overlays.push({
                dataBase64: "",
                x: seq.xPx,
                y: seq.yPx,
                startTime: o.startTime,
                endTime: o.endTime,
                animation: exportOverlayAnimation(o.animation),
                keyframes: exportKeyframes(o, seq.xPx, seq.yPx),
                frames: { unique: seq.unique, sequence: seq.sequence },
                blendMode,
              });
            continue;
          }
          if (o.reveal) {
            // A revealing picture burns in as a frame sequence of its reveal (imageReveal.ts).
            // eslint-disable-next-line no-await-in-loop
            const seq = await renderImageRevealFrames(o, pxW, pxH);
            if (seq)
              overlays.push({
                dataBase64: "",
                x: seq.xPx,
                y: seq.yPx,
                startTime: o.startTime,
                endTime: o.endTime,
                animation: exportOverlayAnimation(o.animation),
                keyframes: exportKeyframes(o, seq.xPx, seq.yPx),
                frames: { unique: seq.unique, sequence: seq.sequence },
                blendMode,
              });
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          const rendered = await renderImageOverlayToPng(o, pxW, pxH);
          if (rendered) overlays.push({ dataBase64: rendered.dataUrl, x: rendered.xPx, y: rendered.yPx, startTime: o.startTime, endTime: o.endTime, animation: exportOverlayAnimation(o.animation), keyframes: exportKeyframes(o, rendered.xPx, rendered.yPx), blendMode });
        }
        for (const o of current.textOverlays) {
          const blendMode = exportBlendMode(o.blendMode);
          if (isTextReveal(o.animation)) {
            // Letter-by-letter titles burn in as a frame sequence (textReveal.ts).
            // eslint-disable-next-line no-await-in-loop
            const seq = await renderTextRevealFrames(o, pxW, pxH);
            if (seq)
              overlays.push({
                dataBase64: "",
                x: seq.xPx,
                y: seq.yPx,
                startTime: o.startTime,
                endTime: o.endTime,
                animation: "none",
                keyframes: exportKeyframes(o, seq.xPx, seq.yPx),
                frames: { unique: seq.unique, sequence: seq.sequence },
                blendMode,
              });
            continue;
          }
          const rendered = renderTextOverlayToPng(o, pxW, pxH);
          if (rendered) overlays.push({ dataBase64: rendered.dataUrl, x: rendered.xPx, y: rendered.yPx, startTime: o.startTime, endTime: o.endTime, animation: exportOverlayAnimation(o.animation), keyframes: exportKeyframes(o, rendered.xPx, rendered.yPx), blendMode });
        }
      }

      // A plain rectangle has no fixed content to pre-render (it depends on whatever the
      // underlying frame looks like at each instant), so it just resolves position/size to real
      // output pixels and lets Rust build the crop+blur+overlay filter chain directly off the
      // video's own decoded frames. Anything else - ellipse, rounded corners, or rotated - gets a
      // black/white mask PNG (renderBlurMaskToPng) that Rust applies via `alphamerge`. `sigma` is
      // the preview's own Gaussian (CSS blur) in output pixels; keyframes (a motion track) move it.
      const blurOverlays = videoPixelSize
        ? current.blurOverlays.map((o) => {
            const W = videoPixelSize.width;
            const H = videoPixelSize.height;
            const base = {
              x: Math.round(o.x * W),
              y: Math.round(o.y * H),
              width: Math.round(o.width * W),
              height: Math.round(o.height * H),
              intensity: o.intensity,
              sigma: Math.max(0, o.intensity) * BLUR_SIGMA_FRACTION * H,
              startTime: o.startTime,
              endTime: o.endTime,
              maskDataBase64: undefined as string | undefined,
              keyframes: undefined as ExportKeyframe[] | undefined,
            };
            const mask = blurNeedsMask(o) ? renderBlurMaskToPng(o, W, H) : null;
            const placed = mask ? { ...base, x: mask.xPx, y: mask.yPx, width: mask.widthPx, height: mask.heightPx, maskDataBase64: mask.dataUrl } : base;
            // The region has to fit in the frame (export crops it out of each frame).
            placed.width = Math.max(2, Math.min(W, placed.width));
            placed.height = Math.max(2, Math.min(H, placed.height));
            if (o.keyframes && o.keyframes.length > 0) {
              const dx = placed.x - o.x * W;
              const dy = placed.y - o.y * H;
              placed.keyframes = o.keyframes.map((k) => ({ time: o.startTime + k.time, x: k.x * W + dx, y: k.y * H + dy, scale: 1, opacity: 1, easing: k.easing }));
            } else if (!placed.maskDataBase64) {
              // A still rectangle is cut to the part of it that's on the frame.
              const x0 = Math.max(0, placed.x);
              const y0 = Math.max(0, placed.y);
              placed.width = Math.max(2, Math.min(W, placed.x + placed.width) - x0);
              placed.height = Math.max(2, Math.min(H, placed.y + placed.height) - y0);
              placed.x = Math.min(x0, W - placed.width);
              placed.y = Math.min(y0, H - placed.height);
            }
            return placed;
          })
        : [];

      // No client-side rendering step for PiP either (unlike text/image) - there's no picture to
      // pre-render (it depends on the pip source's own decoded frames at each instant), so this
      // just resolves position/size to real output pixels and lets Rust build the
      // trim+scale+mask+overlay filter chain directly (see pip_overlay_chain, conversion.rs).
      const pipOverlays = videoPixelSize
        ? current.pipOverlays.map((o) => ({
            sourcePath: o.sourcePath,
            x: Math.round(o.x * videoPixelSize.width),
            y: Math.round(o.y * videoPixelSize.height),
            width: Math.round(o.width * videoPixelSize.width),
            height: Math.round(o.height * videoPixelSize.height),
            shape: o.shape,
            cornerRadius: o.cornerRadius,
            crop: o.crop,
            trimStart: o.trimStart,
            startTime: o.startTime,
            endTime: o.endTime,
            // Collapsed to a single 0..1 number for Rust (no separate muted flag) - same
            // "0.0 when muted, otherwise the real level" convention effective_video_volume
            // already uses (conversion.rs) for the primary track's own mute/volume pair.
            volume: (o.muted ?? true) ? 0 : o.volume,
            blendMode: exportBlendMode(o.blendMode),
          }))
        : [];

      // No client-side rendering step for audio - these pass straight through to Rust, which reads
      // the source files directly and builds the amix/afade/adelay chain itself. Ducked music gets
      // the same speech envelope the preview plays (musicDucking.ts).
      const speech = current.audioOverlays.some(isDucked) ? await computeSpeechTimeline(current) : [];
      const audioOverlays = current.audioOverlays
        .filter((o) => !o.muted)
        .map((o) => ({
          sourcePath: o.src,
          startTime: o.startTime,
          endTime: o.endTime,
          trimStart: o.trimStart,
          volume: o.volume,
          fadeIn: o.fadeInSec ?? 0,
          fadeOut: o.fadeOutSec ?? 0,
          duck: duckEnvelopeFor(o, speech),
        }));

      // Captions go to Rust as a finished ASS script (burned in last, with libass) rather than
      // per-line PNGs - hundreds of timed lines, each re-drawn per word for emphasis, is exactly
      // what a subtitle renderer is for and far too many overlay inputs for the PNG path.
      const captionLines = current.captions?.settings.enabled ? buildCaptionLines(current.clips, current.captions) : [];
      const captionsAss =
        videoPixelSize && current.captions && captionLines.length > 0
          ? buildCaptionsAss(captionLines, current.captions.settings, videoPixelSize.width, videoPixelSize.height)
          : null;

      const adjustmentLayers = videoPixelSize
        ? (current.adjustmentLayers ?? []).map((l) => adjustmentLayerExport(l, videoPixelSize.width, videoPixelSize.height)).filter((l) => l !== null)
        : [];

      return {
        args: {
          outputBasePath: sourcePath,
          segments: await withGradeLuts(toKeepSegments(current.clips), current.clips),
          overlays,
          blurOverlays,
          audioOverlays,
          pipOverlays,
          audioMuted: current.videoAudioMuted,
          audioVolume: current.videoAudioVolume,
          videoWidth: timelinePixelSize?.width ?? null,
          videoHeight: timelinePixelSize?.height ?? null,
          quality: options?.quality ?? null,
          outputPath: options?.outputPath ?? null,
          captionsAss,
          outputFrame: options?.outputFrame ?? null,
          loudnessLufs: options?.loudnessLufs ?? null,
          adjustmentLayers,
          chapters: chaptersForExport(current.clips, current.chapters ?? []),
        },
        sourcePath,
        durationSec: totalOutputDuration(current.clips),
        share: {
          title: (sourcePath.split(/[\\/]/).pop() ?? "Video").replace(/\.[^.]+$/, ""),
          chapters: chaptersForExport(current.clips, current.chapters ?? []),
          srt: captionLines.length > 0 ? buildSrt(captionLines) : null,
          language: current.captions?.language ?? null,
        },
      };
    },
    [sourcePath]
  );

  // Renders the timeline now, in the foreground - what the queue's runner does with a prepared job.
  const exportEdited = useCallback(
    async (timelinePixelSize: { width: number; height: number } | null, options?: ExportOptions): Promise<{ path: string; name: string } | null> => {
      setIsExporting(true);
      setExportError(null);
      try {
        const payload = await prepareExport(timelinePixelSize, options);
        if (!payload) return null;
        const resultPath = await invoke<string>("export_trimmed_video", { ...payload.args, jobId: null });
        const name = resultPath.split(/[\\/]/).pop() ?? resultPath;
        return { path: resultPath, name };
      } catch (err) {
        setExportError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setIsExporting(false);
        setExportProgress(null);
      }
    },
    [prepareExport]
  );

  const mergeCancelledRef = useRef(false);
  const cancelMerge = useCallback(() => {
    mergeCancelledRef.current = true;
    void invoke("cancel_conversion").catch((err) => console.error("Failed to cancel the merge:", err));
  }, []);

  const mergeClips = useCallback(
    async (ids: string[], frame: { width: number; height: number } | null): Promise<string | null> => {
      const current = stateRef.current;
      if (!current || !sourcePath) return null;
      const inPlace = mergeClipsInPlace(current.clips, ids);
      if (inPlace) {
        pushCommand(snapshot(current, {}), snapshot(current, { clips: inPlace }), "merge-clips");
        return inPlace.find((c) => ids.includes(c.id))?.id ?? null;
      }
      const selected = current.clips.filter((c) => ids.includes(c.id));
      if (selected.length < 2) return null;
      const first = selected[0];
      const requestedForSourcePath = sourcePath;
      mergeCancelledRef.current = false;
      const outputPath = await invoke<string>("merged_clip_output_path", { sourcePath: first.sourcePath });
      // Cancelled (cancelMerge kills the render, so the invoke below rejects): no timeline change,
      // and the half-written file goes.
      const discardIfCancelled = () => {
        if (!mergeCancelledRef.current) return false;
        void invoke("discard_merged_clip", { path: outputPath }).catch((err) => console.error(err));
        return true;
      };
      // Same render "Save clip as" uses, over the whole selection in timeline order - so the
      // transitions between the selected clips are kept, while the first one's own transition in
      // stays a live setting on the merged clip.
      let resultPath: string;
      try {
        resultPath = await invoke<string>("export_trimmed_video", {
          outputBasePath: sourcePath,
          segments: await withGradeLuts(toKeepSegments([{ ...first, transitionIn: undefined }, ...selected.slice(1)]), selected),
          overlays: [],
          blurOverlays: [],
          audioOverlays: [],
          pipOverlays: [],
          audioMuted: false,
          audioVolume: 1,
          videoWidth: frame?.width ?? null,
          videoHeight: frame?.height ?? null,
          quality: null,
          outputPath,
          captionsAss: null,
          outputFrame: null,
          loudnessLufs: null,
        });
      } catch (err) {
        if (discardIfCancelled()) return null;
        throw err;
      }
      if (discardIfCancelled()) return null;
      const duration = await fetchDuration(resultPath);
      if (duration == null || sourcePathRef.current !== requestedForSourcePath) return null;
      registerSourceDuration(resultPath, duration);
      const latest = stateRef.current;
      if (!latest) return null;
      const merged: Clip = { id: crypto.randomUUID(), sourcePath: resultPath, start: 0, end: duration, ...(first.transitionIn ? { transitionIn: first.transitionIn } : {}) };
      const at = latest.clips.findIndex((c) => c.id === first.id);
      if (at < 0) return null; // the first clip was removed while this rendered
      const rest = latest.clips.filter((c) => !ids.includes(c.id));
      const restIndex = latest.clips.slice(0, at).filter((c) => !ids.includes(c.id)).length;
      const clips = [...rest.slice(0, restIndex), merged, ...rest.slice(restIndex)];
      pushCommand(snapshot(latest, {}), snapshot(latest, { clips }), "merge-clips");
      return merged.id;
    },
    [pushCommand, registerSourceDuration, sourcePath]
  );

  const exportClip = useCallback(
    async (clipId: string, videoPixelSize: { width: number; height: number } | null, outputPath: string): Promise<{ path: string; name: string } | null> => {
      const clip = stateRef.current?.clips.find((c) => c.id === clipId);
      if (!sourcePath || !clip || !stateRef.current) return null;
      const current = stateRef.current;
      setIsExporting(true);
      setExportError(null);
      try {
        const resultPath = await invoke<string>("export_trimmed_video", {
          outputBasePath: sourcePath,
          // Alone, there's nothing for it to transition in from.
          segments: await withGradeLuts(toKeepSegments([{ ...clip, transitionIn: undefined }]), [clip]),
          overlays: [],
          blurOverlays: [],
          audioOverlays: [],
          pipOverlays: [],
          audioMuted: current.videoAudioMuted,
          audioVolume: current.videoAudioVolume,
          videoWidth: videoPixelSize?.width ?? null,
          videoHeight: videoPixelSize?.height ?? null,
          quality: null,
          outputPath,
          captionsAss: null,
          outputFrame: null,
          loudnessLufs: null,
        });
        return { path: resultPath, name: resultPath.split(/[\\/]/).pop() ?? resultPath };
      } catch (err) {
        setExportError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setIsExporting(false);
        setExportProgress(null);
      }
    },
    [sourcePath]
  );

  return {
    loading,
    exportClip,
    cutImagesOnBeat,
    duplicateClip,
    freezeFrame,
    setClipReversed,
    clips: state?.clips ?? [],
    textOverlays: state?.textOverlays ?? [],
    imageOverlays: state?.imageOverlays ?? [],
    blurOverlays: state?.blurOverlays ?? [],
    audioOverlays: state?.audioOverlays ?? [],
    pipOverlays: state?.pipOverlays ?? [],
    addTextOverlay,
    updateTextOverlayContent,
    resizeTextOverlayTime,
    moveTextOverlayTime,
    deleteTextOverlay,
    duplicateTextOverlay,
    bringTextOverlayToFront,
    sendTextOverlayToBack,
    addImageOverlay,
    updateImageOverlayContent,
    resizeImageOverlayTime,
    moveImageOverlayTime,
    deleteImageOverlay,
    duplicateImageOverlay,
    bringImageOverlayToFront,
    sendImageOverlayToBack,
    addBlurOverlay,
    updateBlurOverlayContent,
    resizeBlurOverlayTime,
    moveBlurOverlayTime,
    deleteBlurOverlay,
    duplicateBlurOverlay,
    adjustmentLayers: state?.adjustmentLayers ?? [],
    addAdjustmentLayer,
    updateAdjustmentLayer,
    resizeAdjustmentLayerTime,
    moveAdjustmentLayerTime,
    deleteAdjustmentLayer,
    duplicateAdjustmentLayer,
    chapters: state?.chapters ?? [],
    setChapters,
    prepareExport,
    addAudioOverlay,
    detachVideoAudio,
    updateAudioOverlayContent,
    resizeAudioOverlayTime: resizeAudioOverlayTimeCb,
    moveAudioOverlayTime,
    deleteAudioOverlay,
    duplicateAudioOverlay,
    addPipOverlay,
    addSplitScreen,
    insertHighlightIntro,
    updatePipOverlayContent,
    resizePipOverlayTime: resizePipOverlayTimeCb,
    movePipOverlayTime,
    deletePipOverlay,
    splitPipOverlay,
    splitAudioOverlay,
    duplicatePipOverlay,
    applyViewSwitchOverlays,
    videoAudioMuted: state?.videoAudioMuted ?? false,
    videoAudioVolume: state?.videoAudioVolume ?? 1,
    setVideoAudioMuted,
    setVideoAudioVolume,
    captions: state?.captions ?? null,
    setCaptionTranscripts,
    cutClipRanges,
    updateCaptionSettings,
    editCaptionLine,
    clearCaptions,
    setDuration,
    getSourceDuration,
    splitAt,
    deleteClipAt,
    reorderClip,
    resizeClipEdge,
    updateClipEffects,
    updateAllClipEffects,
    updateClipsEffects,
    prepareFileMove,
    trimSilenceForClip,
    applyAutoZoomAtClicks,
    insertClipAt,
    deleteClips,
    duplicateClips,
    setImageClipLengths,
    mergeClips,
    cancelMerge,
    replaceClipSource,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    isExporting,
    exportProgress,
    exportError,
    exportEdited,
  };
}
