// utils/videoEditTypes.ts
//
// Non-destructive video edit state: an ordered list of clips, each a [start,end) range of a
// source video - not necessarily the *same* source video, since a clip can be dragged in from any
// other file in the Briefcast library or from Explorer. The array's order *is* the playback order
// in the preview/export - reordering is just moving a clip to a different index, independent of
// where its source range sits in its own file. There's no separate trim/cut/delete concept:
// trimming the head is dragging the very first clip's start, trimming the tail is dragging the
// very last clip's end, splitting divides one clip into two adjacent clips (same sourcePath), and
// deleting removes a clip from the array outright.

import { TextAlign, TextColorRun, TextRange } from "./pdfAnnotationTypes";

// A per-clip color grade, applied to that clip's own trimmed segment (both live preview -
// VideoPlayer's CSS `filter`, see cssFilterForColorPreset in videoColorFilters.ts - and export
// burn-in - ffmpeg `eq`/`colorbalance`/`vignette` chained onto that segment's own trim step
// before concat, see color_filter_chain in conversion.rs). "none"/undefined both mean the
// pre-existing unfiltered look - "none" is a real selectable choice (so a style-panel button can
// show it as the active one) while undefined is simply "never touched this clip's grade at all".
export type ColorFilterPreset = "none" | "vibrant" | "cinematic" | "bw" | "warm" | "cool" | "vignette";
export interface ClipColorFilter {
  preset: ColorFilterPreset;
  intensity: number; // 0..1, scales the preset's own strength from identity (0) to full (1)
}

// A simple, non-keyframed motion effect animated across THIS clip's own [start,end) source
// range, not the output timeline - preview (VideoPlayer, driven off video.currentTime directly
// via rAF, not React state - see the effect in VideoPlayer.tsx) and export (a time-varying
// ffmpeg crop+scale chain, see ken_burns_chain in conversion.rs) both compute progress the same
// way: 0 at the clip's own start, 1 at its own end.
export type KenBurnsPreset = "zoom-in" | "zoom-out" | "pan-left" | "pan-right";
export interface ClipKenBurns {
  preset: KenBurnsPreset;
  intensity?: number; // 0..1, undefined means 0.5 (moderate) - how far the zoom/pan travels
}

// A free-form crop window into this clip's own frame - independent x/y/width/height (fractions of
// the source frame), NOT locked to the frame's own aspect ratio, so e.g. trimming a browser-tab
// strip off just the top (full width, shorter height) is representable. Since the cropped region's
// own aspect generally won't match the export's fixed output resolution, both preview and export
// STRETCH it to fill that resolution rather than letterboxing/padding - preview via a non-uniform
// CSS scale+translate on the <video> element (see cropStaticTransform in videoColorFilters.ts),
// export via crop_chain's own trailing `scale=out_w:out_h` (conversion.rs), which stretches by
// design (no force_original_aspect_ratio). All four undefined means uncropped (equivalent to
// {x:0,y:0,width:1,height:1}).
export interface ClipCrop {
  x: number; // 0..(1-width), left edge, fraction of source frame width
  y: number; // 0..(1-height), top edge, fraction of source frame height
  width: number; // 0 < width <= 1, fraction of source frame width
  height: number; // 0 < height <= 1, fraction of source frame height
}

// A transition INTO this clip FROM whichever clip immediately precedes it in playback (array)
// order - deliberately not "transitionOut" on the earlier clip, so reordering clips naturally
// keeps "the transition" attached to whichever pairing is now adjacent, with no extra
// bookkeeping. Meaningless (ignored) on the very first clip - there's nothing to transition
// from. Preview-only shows a hard cut at the boundary regardless of which transition is picked
// (see the transition marker in VideoTimelineDocker) - the real transition only renders in the
// export, same "one side documented as behind" precedent TextOverlay/ImageOverlay's own "slide"
// animation already set.
// Names ffmpeg's own `xfade` filter transition names directly (see conversion.rs's
// TRANSITION_ALLOWLIST) rather than inventing a separate friendly-name-to-xfade-name mapping
// layer - one flat vocabulary shared by the UI, the sidecar JSON, and the export filter string,
// so adding another xfade transition later is a one-line addition to both this union and the
// Rust allowlist, not a new translation table entry too.
export type TransitionType =
  | "fade"
  | "fadeblack"
  | "wipeleft"
  | "wiperight"
  | "slideleft"
  | "slideright"
  | "circleopen"
  | "zoomin"
  | "pixelize"
  | "radial"
  | "dissolve";
export interface ClipTransitionIn {
  type: TransitionType;
  duration: number; // seconds, e.g. 0.5 - clamped against both flanking clips' own durations
                     // server-side (see export_trimmed_video) so a too-long transition can't
                     // produce an invalid ffmpeg offset.
}

export interface Clip {
  id: string;
  sourcePath: string;
  start: number;
  end: number;
  colorFilter?: ClipColorFilter;
  kenBurns?: ClipKenBurns;
  transitionIn?: ClipTransitionIn;
  crop?: ClipCrop;
  // Horizontal mirror of the clip's own frame - applied first, before crop/Ken Burns, in both the
  // live preview (VideoPlayer's CSS transform) and export (conversion.rs's segment_effect_chain),
  // so crop/pan coordinates always describe the already-mirrored frame identically in both places.
  // Undefined/false means the pre-existing unmirrored look.
  flipHorizontal?: boolean;
}

// Background shape behind a text overlay's box - "rounded"/"pill" only actually differ visually
// when a backgroundColor is set (an invisible box has no edges to round). Video-only: TextObject
// (PDF notes) has no equivalent, since a PDF page has no notion of a "caption chip" aesthetic.
export type TextOverlayCornerStyle = "square" | "rounded" | "pill";
// Video-only, same reasoning: a still PDF page has no time axis to animate across, so this concept
// has nothing to mirror on TextObject. Shared by both TextOverlay and ImageOverlay (see each
// type's own `animation` field) rather than declared twice - entering/leaving an overlay's time
// range is the same underlying timing envelope regardless of what's inside the box. "fade" ramps
// opacity 0->1 over the first OVERLAY_ANIMATION_RAMP_SEC of the overlay's time range and 1->0 over
// the last; "slide-<direction>" instead keeps opacity at 1 and, over that same ramp, slides the box
// in from (and back out to) the named off-screen side. Both clamp their ramp to half the overlay's
// own duration so a very short overlay still finishes entering before it starts leaving.
// "pop" is preview-only, same as every "slide-*" variant already was before this comment existed
// - see exportEdited's own comment (useVideoEditStore.ts) for why burning a scale-varying overlay
// into the export is deferred rather than attempted here.
export type OverlayAnimation = "none" | "fade" | "slide-left" | "slide-right" | "slide-up" | "slide-down" | "pop";

// A caption/title composited over the video preview (v1 is preview-only - not yet burned into
// exported files, see export_trimmed_video). Core text/formatting mirrors TextObject
// (pdfAnnotationTypes.ts), reusing the same TextRange/TextColorRun types rather than redeclaring
// them - but this type is deliberately allowed to grow fields TextObject never will (stroke,
// corner shape, animation below): a video caption calls for a different visual vocabulary than a
// static PDF margin note, and forcing them through one shared shape would mean either bloating
// TextObject with video-only concepts or contorting video features to fit a PDF-shaped model.
// TextNoteEditor stays shared for the part that genuinely *is* the same (typing, per-character
// color/bold/italic, box position/size) - everything below is video-specific styling layered on
// top of it by VideoOverlayLayer, not by TextNoteEditor itself.
export interface TextOverlay {
  id: string;
  text: string;
  color: string;
  backgroundColor?: string;
  colorRuns?: TextColorRun[];
  boldRuns?: TextRange[];
  italicRuns?: TextRange[];
  // Undefined means "left". See TextObject's identical field (pdfAnnotationTypes.ts) for the
  // canvas-bake caveat on "justify" - irrelevant here in v1 since overlays are never canvas-baked
  // (preview-only, DOM-rendered, where justify works natively either way).
  textAlign?: TextAlign;
  // Outline around the glyphs themselves (distinct from backgroundColor's box fill) - the classic
  // "white text, black outline" caption look that stays legible over any footage without needing
  // a background chip at all. Undefined/0 width means no stroke, the pre-existing look.
  strokeColor?: string;
  strokeWidth?: number;
  cornerStyle?: TextOverlayCornerStyle; // undefined means "square", the pre-existing look
  animation?: OverlayAnimation; // undefined means "none", the pre-existing look
  // Breathing room around the text inside its box, most visible with backgroundColor/stroke set -
  // fraction of frameRect.height (same basis as fontSize, not width - padding is a vertical-scale
  // concept here). Undefined means the pre-existing fixed 2px look, both in the live preview
  // (VideoOverlayLayer) and export burn-in (videoOverlayRender.ts) - kept as a fraction rather than
  // raw px so it scales consistently with the frame the same way fontSize/x/y already do.
  padding?: number;
  // Normalized 0..1 fractions of the letterboxed VIDEO FRAME (not the player container) - stays
  // pixel-stable relative to the actual picture regardless of window size/fullscreen, since
  // object-fit:contain preserves the frame's own aspect ratio. y-down (top edge), unlike
  // TextObject's PDF-page y-up space - matches ordinary DOM/CSS convention, no inversion needed.
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  // Seconds in OUTPUT/ASSEMBLED-timeline time (same space the ruler/playhead already use, see
  // outputStarts/playheadLeft in VideoTimelineDocker) - stays "at this point in the edited video"
  // as clips are trimmed/reordered/split, rather than pinned to raw source time.
  startTime: number;
  endTime: number;
  createdAt: number;
  updatedAt: number;
}

// A logo/watermark/sticker composited over the video preview - same output-timeline positioning
// and preview-only scope as TextOverlay, but with no text-editing surface of its own (no
// TextNoteEditor involved - VideoOverlayLayer drives its drag/resize directly). `src` is a plain
// filesystem path (like Clip.sourcePath), converted to a displayable asset:// URL at render time
// via convertFileSrc - not a base64 data URL - so the sidecar JSON stays small regardless of the
// source image's resolution, unlike PDF's pasted-image annotations (which have no source file to
// point back at, so a data URL is their only option).
export interface ImageOverlay {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number; // 0..1, defaults to 1
  cornerRadius?: number; // fraction of frame height; undefined means 0 (square corners)
  rotation?: number; // degrees, clockwise; undefined means 0
  borderColor?: string; // undefined means no border
  shadow?: boolean; // undefined/false means no drop shadow
  flipHorizontal?: boolean; // undefined/false means not mirrored
  flipVertical?: boolean;
  animation?: OverlayAnimation; // undefined means "none", the pre-existing look
  // The visible sub-rectangle of the source picture, set via the dedicated Crop mode
  // (ImageOverlayCropPanel.tsx) - fractions of the SOURCE IMAGE's own natural pixel dimensions,
  // unlike every other field on this type (all normalized against the video frame instead). All
  // four undefined means "uncropped" (equivalent to 0,0,1,1) - existing overlays render exactly as
  // before with no migration needed.
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
  startTime: number;
  endTime: number;
  createdAt: number;
  updatedAt: number;
}

// A blurred region composited over the video preview - spatially fraction-of-frame like
// ImageOverlay (same x/y/width/height basis), but with no picture/text content of its own: what
// renders inside the box is whatever the underlying video frame looks like, sampled and blurred,
// not a separate layer stacked on top. That's also why this has no z-order (bringToFront/
// sendToBack) the way TextOverlay/ImageOverlay do - there's nothing for a blur region to stack
// against except the video itself, which is always "behind" by construction. Export burns this in
// via ffmpeg (see export_trimmed_video) - a plain axis-aligned rectangle (shape:"rectangle", no
// cornerRadius/rotation) uses a mask-free crop+boxblur+overlay chain; ellipse/rounded/rotated
// instead render a client-side mask PNG first (renderBlurMaskToPng, videoOverlayRender.ts) and
// apply it via crop+boxblur+alphamerge+overlay - see blurNeedsMask's own doc comment.
export type BlurShape = "rectangle" | "ellipse";

export interface BlurOverlay {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  // 0..1 - strength of the blur, resolved to a pixel radius at render/export time (see
  // BLUR_PREVIEW_SCALE in VideoOverlayLayer.tsx and the matching radius formula in
  // export_trimmed_video) rather than stored as a raw px radius, so it stays meaningful
  // independent of the frame's/output video's actual resolution.
  intensity: number;
  shape?: BlurShape; // undefined means "rectangle", the pre-existing look
  cornerRadius?: number; // fraction of frameRect.height, rectangle only - same basis as ImageOverlay.cornerRadius
  rotation?: number; // degrees, clockwise - same basis as ImageOverlay.rotation
  startTime: number;
  endTime: number;
  createdAt: number;
  updatedAt: number;
}

// A background music/voiceover clip composited into the video's own audio track - same output-
// timeline positioning as TextOverlay/ImageOverlay, but with a finite SOURCE file it plays a
// sub-window of (trimStart) rather than an abstract, freely-stretchable time window - dragging an
// edge on the timeline trims *into the source*, the same way a Clip's own start/end already does,
// not just retiming an empty box the way text/image edges do. No `trimEnd` field: always derived
// as `trimStart + (endTime - startTime)`, which structurally guarantees "1x playback, no time-
// stretch" instead of needing two fields kept in sync by every mutation.
export interface AudioOverlay {
  id: string;
  src: string;
  startTime: number;
  endTime: number;
  trimStart: number;
  // The source file's own full duration, fetched once (ffprobe, via get_conversion_info) at
  // placement time - lets trim handles clamp against the source's real bounds without an async
  // lookup on every drag frame.
  sourceDuration: number;
  volume: number; // 0..1, defaults to 1
  fadeInSec?: number; // undefined/0 means no fade
  fadeOutSec?: number;
  muted?: boolean;
  createdAt: number;
  updatedAt: number;
}

// A picture-in-picture video layer - e.g. a webcam recording captured separately from the screen
// (see FormData.separate_webcam_capture, recording.rs) and composited back on top of the primary
// clip track. Unlike TextOverlay/ImageOverlay/BlurOverlay, this has real moving-picture content of
// its own that can't be pre-rendered to a flat PNG the way those are for export (videoOverlayRender.ts) -
// both the live preview (a real <video> element, see VideoOverlayLayer.tsx) and export
// (export_trimmed_video's own PipOverlay struct, conversion.rs) instead composite the actual video
// frames directly, same technique recording.rs's build_camera_overlay_filter_complex already uses
// for the baked-in overlay this feature is the editable alternative to. Same trimStart/
// sourceDuration shape as AudioOverlay (a real source file, not an abstract stretchable box).
export type PipShape = "circle" | "rounded" | "rectangle";
export interface PipOverlay {
  id: string;
  sourcePath: string;
  // Normalized 0..1 fractions of the video frame, same basis as ImageOverlay's own x/y/width/height.
  x: number;
  y: number;
  width: number;
  height: number;
  shape: PipShape;
  cornerRadius?: number; // fraction of frame height, "rounded" only - undefined means a modest default
  trimStart: number;
  sourceDuration: number;
  startTime: number;
  endTime: number;
  // Muted by default - a PiP is commonly a webcam recorded via FormData.separate_webcam_capture,
  // which never has an audio track at all (the mic already goes to the main track in that case -
  // see win.rs's own comment), so silence is the safer default; an arbitrary picked video with its
  // own real audio can turn this on. makePipOverlay (videoEditHandlers.ts) always sets `muted`
  // explicitly (true) rather than leaving it undefined, unlike AudioOverlay's own muted field
  // (there, undefined/false both mean audible) - so this being undefined should never actually
  // happen for a pip created through the normal add flow.
  volume: number; // 0..1, defaults to 1
  muted?: boolean;
  createdAt: number;
  updatedAt: number;
}

// What export_trimmed_video (Rust) actually consumes - plain, ordered [start,end) ranges, each
// naming its own source file. Kept as a separate type from Clip (rather than reusing Clip
// directly) so call sites are explicit about which shape they need; the id is UI-only and never
// crosses the invoke boundary.
export interface KeepSegment {
  sourcePath: string;
  start: number;
  end: number;
  colorFilter?: ClipColorFilter;
  kenBurns?: ClipKenBurns;
  transitionIn?: ClipTransitionIn;
  crop?: ClipCrop;
  flipHorizontal?: boolean;
}

export interface VideoEditState {
  // The primary file's own duration - the file this edit session/sidecar belongs to. Clips can
  // reference other files entirely (each carries its own sourcePath); their durations are looked
  // up on demand and never stored here.
  duration: number;
  clips: Clip[];
  textOverlays: TextOverlay[];
  imageOverlays: ImageOverlay[];
  blurOverlays: BlurOverlay[];
  audioOverlays: AudioOverlay[];
  pipOverlays: PipOverlay[];
  // The primary video's OWN audio level - distinct from any AudioOverlay's own volume/muted (those
  // are separate mixed-in tracks; this is the original soundtrack that was always there). A plain
  // pair of fields rather than an array item like the overlays above, matching the "one track"
  // mental model VideoTimelineDocker's own trackVisible/trackLocked/trackMuted rail already assumes
  // - there's only ever one of these per edit session, never a list.
  videoAudioMuted: boolean;
  videoAudioVolume: number; // 0..1, defaults to 1
  updatedAt: string;
}

// The subset of VideoEditState that undo/redo actually needs to snapshot - `duration` is fixed
// per video and never changes as a result of an edit, so leaving it out of every command keeps
// undo/redo comparisons and payload sizes smaller for no loss.
export interface EditableFields {
  clips: Clip[];
  textOverlays: TextOverlay[];
  imageOverlays: ImageOverlay[];
  blurOverlays: BlurOverlay[];
  audioOverlays: AudioOverlay[];
  pipOverlays: PipOverlay[];
  videoAudioMuted: boolean;
  videoAudioVolume: number;
}

// Whole-state before/after snapshots rather than PDF-annotations-style per-object diffs - split/
// delete/trim/reorder are coarse, click-or-drag-driven operations over a handful of clips (or text/
// image overlays) at most, so a snapshot is simpler than a diff without losing any real undo/redo
// precision. "edit-text"/"edit-image" cover content/color/bold/italic/move/resize/retime as one
// label each, the same way "trim" already covers both a clip's start and end edge.
export interface VideoEditCommand {
  before: EditableFields;
  after: EditableFields;
  label:
    | "trim"
    | "trim-silence"
    | "split"
    | "delete"
    | "reorder"
    | "insert"
    | "edit-clip-effects"
    | "add-text"
    | "edit-text"
    | "delete-text"
    | "add-image"
    | "edit-image"
    | "delete-image"
    | "add-blur"
    | "edit-blur"
    | "delete-blur"
    | "add-audio"
    | "edit-audio"
    | "delete-audio"
    | "add-pip"
    | "edit-pip"
    | "delete-pip"
    | "edit-track-audio";
}

export function createEmptyState(sourcePath: string, duration: number): VideoEditState {
  return {
    duration,
    clips: [{ id: crypto.randomUUID(), sourcePath, start: 0, end: duration }],
    textOverlays: [],
    imageOverlays: [],
    blurOverlays: [],
    audioOverlays: [],
    pipOverlays: [],
    videoAudioMuted: false,
    videoAudioVolume: 1,
    updatedAt: new Date().toISOString(),
  };
}

// Sidecars are only ever written by this app, but the edit-state shape changed twice during
// development (earlier versions stored a flat `segments` list, then a trim+cuts+deletedRanges
// shape) - rather than migrate those one-off shapes, a sidecar that doesn't look like the current
// shape is treated the same as "no sidecar yet" and a fresh state is seeded instead of crashing.
// Deliberately does NOT check for `textOverlays`/`imageOverlays` - both were added after clips
// already shipped, so older sidecars legitimately lack them; the load path (useVideoEditStore)
// defaults each to [] rather than rejecting an otherwise-valid file over a field that didn't exist
// yet when it was written.
//
// Each clip's own shape IS validated (not just "clips is an array") - an old sidecar from one of
// those earlier formats can still satisfy "duration is a number, clips is an array" while its
// clip objects are shaped completely differently (no sourcePath, e.g.) - loading one of those
// as-is used to reach export_trimmed_video with a clip missing sourcePath, which JSON.stringify
// silently drops (an undefined property never gets serialized at all), surfacing as a confusing
// Rust-side "missing field `sourcePath`" error at Save time instead of failing here, up front,
// where "not really today's shape" was already the whole point of this function.
function isClip(value: unknown): value is Clip {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.sourcePath === "string" && typeof c.start === "number" && typeof c.end === "number";
}

export function isVideoEditState(value: unknown): value is VideoEditState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.duration === "number" && Array.isArray(v.clips) && v.clips.every(isClip);
}
