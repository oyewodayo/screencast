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

import type { AudioFx } from "./audioFx";
import type { ChromaKey } from "./chromaKey";
import type { LayerMask } from "./layerMask";
import type { CutoutBackground } from "./cutoutBackground";
import { TextAlign, TextColorRun, TextRange } from "./pdfAnnotationTypes";
import type { ClipSpeedRamp } from "./clipTiming";
import type { OverlayKeyframe } from "./keyframes";
import type { OverlayAsset } from "./videoAssets";
import type { TextRevealSettings } from "./textReveal";
import type { ImageRevealSettings } from "./imageReveal";
import type { ScreenStyle } from "./screenStyle";
import type { PointerStyle } from "./pointerTrack";
import type { KeystrokeStyle } from "./keystrokes";
import type { SpriteTrackSpec } from "./spriteTrack";

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

// Manual color grading for one clip, plus an optional imported 3D LUT - all baked into a single
// lookup table (colorGrade.ts) that both the preview's WebGL layer and export's ffmpeg `lut3d`
// apply, so the two match exactly. Every slider is -1..1 except exposure (stops, -2..2); missing
// or 0 means untouched. Applied on top of the clip's color preset (colorFilter), if it has one.
export interface ClipGrade {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number; // + warmer, - cooler
  tint?: number; // + magenta, - green
  highlights?: number;
  shadows?: number;
  // A .cube file from disk (camera log conversions, film looks), applied first, mixed by intensity.
  lut?: { path: string; name: string; intensity: number };
  // A built-in creative look (gradeLooks.ts) applied last, on top of the corrections, mixed by
  // intensity 0..1 - baked into the same LUT, so preview and export match exactly.
  look?: { name: GradeLookName; intensity: number };
}
export type GradeLookName = "film" | "tealorange" | "moody" | "golden" | "cyber" | "bleach" | "pastel" | "noir";

// A simple, non-keyframed motion effect animated across THIS clip's own [start,end) source
// range, not the output timeline - preview (VideoPlayer, driven off video.currentTime directly
// via rAF, not React state - see the effect in VideoPlayer.tsx) and export (a time-varying
// ffmpeg crop+scale chain, see ken_burns_chain in conversion.rs) both compute progress the same
// way: 0 at the clip's own start, 1 at its own end.
// The window is a zoom + centre over time (kenBurnsWindow, videoColorFilters.ts); the newer ones
// move on the clip's own clock in seconds (oscillations keep their pace whatever the clip's length).
export type KenBurnsPreset =
  | "zoom-in"
  | "zoom-out"
  | "pan-left"
  | "pan-right"
  | "pan-up"
  | "pan-down"
  | "push"
  | "punch-in"
  | "bounce-in"
  | "drift"
  | "sway"
  | "float"
  | "breathe"
  | "pulse"
  | "shake"
  | "vibrate";
export interface ClipKenBurns {
  preset: KenBurnsPreset;
  intensity?: number; // 0..1, undefined means 0.5 (moderate) - how far the zoom/pan travels
  // Where a "zoom-in"/"zoom-out" preset centers its crop window - fraction of the source frame,
  // undefined means the frame's own center (0.5, 0.5), the pre-existing look. Ignored by
  // "pan-left"/"pan-right", which have their own fixed direction. Lets the "auto zoom on click"
  // tool (applyAutoZoomAtClicks, videoEditHandlers.ts) center a punch-in on where a click actually
  // landed instead of the frame's middle - both preview (kenBurnsWindow, videoColorFilters.ts)
  // and export (ken_burns_chain, conversion.rs) read this the same way a plain zoom does.
  targetX?: number;
  targetY?: number;
  // The part of the move (0..1) this clip plays - a piece split out of a Ken Burns clip continues
  // the move rather than restarting it. undefined = all of it.
  span?: [number, number];
}

// A free-form crop window into this clip's own frame - independent x/y/width/height (fractions of
// the source frame), NOT locked to the frame's own aspect ratio, so e.g. trimming a browser-tab
// strip off just the top (full width, shorter height) is representable. Since the cropped region's
// own aspect generally won't match the export's fixed output resolution, both preview and export
// STRETCH it to fill that resolution rather than letterboxing/padding - preview via a non-uniform
// CSS scale+translate on the <video> element (see clipFrameAffine in videoColorFilters.ts),
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
// from. It plays over the START of this clip - the previous clip's frozen last frame giving way
// to this one over `duration` seconds - so it never shortens either clip, and the timeline's
// length is exactly the export's (overlays and captions stay in sync). Export: transition_fold_step
// (conversion.rs); live preview: TransitionPreviewLayer, drawing the same thing over the player.
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
  | "dissolve"
  | "fadewhite"
  | "horzopen"
  // Not ffmpeg names: a crossfade / horizontal blur plus a glow pass (transition_fold_step).
  | "lightleak"
  | "whip"
  // Not ffmpeg names: xfade custom expressions (page_curl_expr, zoom_blur_expr, color_sweep_expr).
  | "pagecurl"
  | "zoomblur"
  | "colorsweep"
  // Not ffmpeg names: both pictures move - composited from the two frames (transitionCanvas.ts in
  // the preview, canvas_transition in conversion.rs).
  | "blocks"
  | "mosaic"
  | "split"
  | "slider"
  | "strips"
  | "beam"
  | "iris"
  | "spin"
  | "glitch"
  | "slice"
  | "push"
  | "cube"
  | "flip"
  | "tiles";
// The shape an iris transition opens out of.
export type IrisShape = "triangle" | "diamond" | "hexagon" | "star" | "heart";
// Where a light leak's hot spot travels.
export type LeakDirection = "right" | "left" | "down" | "up" | "diagonal" | "center";
// The look of transitions that have one (TransitionLookControls). All optional - undefined is the
// default look. Export: transition_glow_filter (conversion.rs); preview: TransitionPreviewLayer.
export interface TransitionLook {
  // Light leak / flash / colour sweep colour, "#rrggbb".
  color?: string;
  // Glow strength, 0.1..1.5 (1 = default).
  intensity?: number;
  direction?: LeakDirection;
  // Light leak hot-spot size, 0.3..2.5 (1 = default).
  size?: number;
  // Bar open: out of a horizontal line (default) or a vertical one. Strips: columns (default) or rows.
  orientation?: "horizontal" | "vertical";
  // Iris: the shape the new clip opens out of (default triangle).
  shape?: IrisShape;
}
export interface ClipTransitionIn {
  type: TransitionType;
  look?: TransitionLook;
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
  grade?: ClipGrade;
  // Camera-shake removal (two-pass vidstab at export, see stabilization_transforms in
  // conversion.rs). Previewed by the clip viewer's "Preview stabilized" render, not live - it needs
  // the whole clip analysed first. strength 0..1.
  stabilize?: { strength: number };
  // Set while the clip plays backwards: sourcePath/start/end then point at the reversed render
  // (render_reversed_clip, conversion.rs) and this remembers the original range, for un-reversing.
  reversedFrom?: { sourcePath: string; start: number; end: number };
  // A speed curve across the clip, on top of `speed` - see clipTiming.ts, which every duration and
  // time mapping goes through so preview, timeline, captions and export agree.
  speedRamp?: ClipSpeedRamp;
  kenBurns?: ClipKenBurns;
  transitionIn?: ClipTransitionIn;
  crop?: ClipCrop;
  // Horizontal mirror of the clip's own frame - applied first, before crop/Ken Burns, in both the
  // live preview (VideoPlayer's CSS transform) and export (conversion.rs's segment_effect_chain),
  // so crop/pan coordinates always describe the already-mirrored frame identically in both places.
  // Undefined/false means the pre-existing unmirrored look.
  flipHorizontal?: boolean;
  // Playback-rate multiplier for JUST this clip's own [start,end) source range - 0.25..4, undefined
  // means 1 (unchanged, the pre-existing look). Unlike every other field on this type, this changes
  // how long the clip occupies on the OUTPUT timeline: (end-start)/speed seconds, not (end-start) -
  // a 10s source range at 2x speed plays back in 5 output seconds. That ripples into everywhere a
  // clip's own duration is read as "how long this plays for" rather than "how much source it
  // covers" - VideoTimelineDocker.tsx's own outputStarts/clipDurations, the resize-drag pixel<->
  // source-seconds conversion, and currentOutputTime's own source-time-elapsed-within-clip mapping
  // all divide/multiply by this explicitly (grep `.speed` in that file for every site). Export
  // applies it via `setpts=PTS/speed` on the video and an atempo chain on the audio (see
  // atempo_chain, conversion.rs, for why that's a *chain* and not a single filter) - both BEFORE
  // any Ken Burns/transition timing on that segment, so their own duration math already operates in
  // OUTPUT time and needs no separate speed-awareness of its own.
  speed?: number;
  // Background-noise reduction strength, 0..1 - undefined/0 means off, the pre-existing look.
  // Exported via afftdn (conversion.rs's audio_trim_chain); VideoPlayer.tsx also runs a live
  // preview of it through a Web Audio worklet (spectral subtraction, same algorithm family as
  // afftdn but not bit-identical) so NoiseReductionPopover's strength slider is audible while
  // editing, not just after export.
  noiseReduction?: number;
  // How noiseReduction is applied plus the extra cleanup stages around it - see AudioCleanup.
  // Undefined keeps the original behaviour (spectral "reduce" mode, no extra stages).
  audioCleanup?: AudioCleanup;
  // The clip's own sound is silenced, in the preview and the export - e.g. the quick cuts of a
  // highlight intro (highlightIntro.ts), which play over music.
  muted?: boolean;
  // An effect over the clip's whole picture (echo, RGB split, colour cycle...) - clipFx.ts in the
  // preview, services/clip_fx.rs on export.
  fx?: ClipFx;
}

export type ClipFxKind = "echo" | "rgbsplit" | "huecycle" | "focus" | "colorin" | "flicker";
export interface ClipFx {
  kind: ClipFxKind;
  intensity: number; // 0..1
}

// Optional audio-cleanup stages for one clip, applied in this order in both the live preview
// (VideoPlayer.tsx's Web Audio graph) and the export (conversion.rs's audio_cleanup_filters):
// low-cut -> hum notches -> denoise (Clip.noiseReduction, in `mode`) -> gate.
export interface AudioCleanup {
  // "reduce": spectral noise reduction (afftdn on export) - keeps some room tone, safest on
  // music/ambience. "remove": RNNoise voice isolation (arnndn on export) - strips everything that
  // isn't voice, for speech-only footage. Undefined means "reduce".
  mode?: "reduce" | "remove";
  // 80Hz high-pass - rumble, handling noise, wind, AC/traffic low end.
  lowCut?: boolean;
  // Mains hum (and its first harmonics) at 50Hz (Europe/Africa/Asia) or 60Hz (Americas).
  hum?: 50 | 60;
  // Downward expander that silences what's left between phrases.
  gate?: boolean;
  // Loudness levelling - evens out quiet and loud speakers (speechnorm + loudnorm on export, a
  // slow AGC + limiter worklet in the live preview). Runs last.
  level?: boolean;
  // A noise-only stretch of this clip's own source file, in source seconds, that "reduce" mode
  // learns its noise profile from (afftdn sample_noise on export, the spectral worklet's learned
  // profile live). Picked on the popover's waveform; ignored by "remove" mode.
  noiseSample?: { start: number; end: number };
}

export const hasAudioCleanup = (clip: { noiseReduction?: number; audioCleanup?: AudioCleanup }): boolean =>
  (clip.noiseReduction ?? 0) > 0 || !!clip.audioCleanup?.lowCut || !!clip.audioCleanup?.hum || !!clip.audioCleanup?.gate || !!clip.audioCleanup?.level;

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
// "pop" scales the box from nothing past full size and back (an ease-out-back overshoot); it
// exports as a per-frame scale (overlay_pop_scale_expr, conversion.rs).
// "typewriter"/"words"/"rise" are text-only title reveals, letter by letter or word by word -
// see textReveal.ts; they export exactly (as a frame sequence).
export type OverlayAnimation =
  | "none"
  | "fade"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "pop"
  | "flip"
  | "zoom"
  | "drop"
  | "typewriter"
  | "words"
  | "rise"
  | "scatter"
  | "blur"
  | "drop"
  | "spread"
  | "wave";

// How an overlay mixes with the picture under it - CSS mix-blend-mode names (the preview sets them
// on the overlay's element). Export composites the same formula (blend_composite, conversion.rs);
// only modes whose ffmpeg counterpart was measured equal to the spec are offered (see blendModes.ts).
export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "hard-light" | "darken" | "lighten" | "difference" | "exclusion" | "plus-lighter";

// Set on an overlay whose keyframes came from motion tracking (motionTracking.ts): what was
// followed and how, so the panel can show it and track again. The keyframes themselves are
// ordinary keyframes - preview and export play them like any other.
export interface OverlayTrackInfo {
  sourcePath: string;
  // The target box at the moment it was picked: output-frame fractions, and that moment's time
  // from the overlay's start.
  target: { x: number; y: number; width: number; height: number };
  anchorTime: number;
  // Whether the overlay grows and shrinks with the object.
  followScale: boolean;
  // Share of the tracked span where the object was lost (the overlay held there).
  lostFraction: number;
  trackedAt: number;
}

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
  // Keyframed motion - position/scale/opacity over the overlay's life (keyframes.ts); when set,
  // these drive where it is instead of x/y alone.
  keyframes?: OverlayKeyframe[];
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
  blendMode?: BlendMode; // undefined means "normal"
  track?: OverlayTrackInfo;
  // Controls for a letter-by-letter title reveal (animation "typewriter"/"words"/"rise") - pace,
  // delay, caret, exit, accent underline. See textReveal.ts.
  reveal?: TextRevealSettings;
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
  // Keyframed motion - position/scale/opacity over the overlay's life (keyframes.ts); when set,
  // these drive where it is instead of x/y alone.
  keyframes?: OverlayKeyframe[];
  src: string;
  // A shape or animated element (videoAssets.ts) drawn in place of a picture - `src` is "" then.
  // Everything else (box, rotation, opacity, flip, shadow, animation, keyframes, timing) applies
  // the same; corners, border and crop are picture-only.
  asset?: OverlayAsset;
  // How the picture inside the box reveals itself - wipe, glare streak, focus pull (imageReveal.ts).
  reveal?: ImageRevealSettings;
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
  blendMode?: BlendMode; // undefined means "normal"
  track?: OverlayTrackInfo;
  // Only this part of the picture shows (layerMask.ts) - in the box's own space.
  mask?: LayerMask;
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
  // Keyframed position (e.g. a motion track following a face): x/y as on text/image keyframes;
  // scale and opacity aren't used - the region keeps its size and strength.
  keyframes?: OverlayKeyframe[];
  track?: OverlayTrackInfo;
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
  // Short name shown on the timeline chip - set by "Detach audio" ("Voice", "Music", "Track 2 ·
  // eng"); user-added music has none and shows its file name in the tooltip only.
  label?: string;
  // True for overlays produced by "Detach audio" (the video's own sound, split out). A later detach
  // replaces all of these rather than stacking a second copy on top - which would otherwise keep
  // playing the old Music/Voice underneath the new ones, hidden in lower lane rows.
  detached?: boolean;
  // Beat sync: the track's tempo and beats (its own file's seconds), from detect_beats - drawn on
  // the timeline, snapped to, and what "cut images on the beat" fits to (beatSync.ts).
  bpm?: number;
  beats?: number[];
  // Set for songs and sound effects added from the built-in music library (MusicLibraryPanel):
  // what it is and the licence it was offered under - the credit line export offers to copy, and
  // what restore_music_track uses to fetch the file again if it's gone missing from disk.
  library?: AudioLibraryInfo;
  // Music ducking: this track dips to duckLevel (0..1, default DEFAULT_DUCK_LEVEL) wherever someone
  // is speaking - the video's own sound, or a detached Voice track - in the preview and the export
  // alike (src/utils/musicDucking.ts).
  duckUnderSpeech?: boolean;
  duckLevel?: number;
  // Its mixer channel's EQ/compressor/balance (audioFx.ts) - every piece of one track (same
  // label, or same file) carries the same settings; the mixer edits them together.
  fx?: AudioFx;
  createdAt: number;
  updatedAt: number;
}

export interface AudioLibraryInfo {
  trackId: string;
  title: string;
  artist: string;
  kind: "music" | "sfx";
  license: string;
  licenseUrl?: string;
  // The credit line the licence asks for (CC-BY), when it asks for one.
  attribution?: string;
  sourceUrl?: string;
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
  cornerRadius?: number; // fraction of this PiP box's own height, "rounded" only - undefined means a modest default
  // Region of the pip SOURCE frame actually shown (fractions of the source's own width/height, same
  // basis as Clip.crop) - applied before the box's own cover-fit, in both the preview
  // (PipOverlayLayer.tsx) and export (pip_overlay_chain, conversion.rs). Undefined means the whole frame.
  crop?: ClipCrop;
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
  blendMode?: BlendMode; // undefined means "normal"
  // Its sound's EQ/compressor/balance (audioFx.ts).
  fx?: AudioFx;
  // Which video track it's on: 1 = V2 (just above the main video), 2 = V3, ... Higher tracks draw
  // over lower ones (videoTracks.ts). Undefined means 1.
  track?: number;
  // 0..1, undefined = 1; and linear fade in/out at its ends, in seconds (a B-roll dissolve).
  opacity?: number;
  fadeIn?: number;
  fadeOut?: number;
  // Green/blue-screen keying (chromaKey.ts) - the screen turns transparent.
  chromaKey?: ChromaKey;
  // Only this part of the layer shows (layerMask.ts) - in the box's own space, so it moves with it.
  mask?: LayerMask;
  // Background removed (backgroundRemoval.ts): the person cut out of `sourcePath` into a video with
  // transparency, shown in place of the source's picture (its sound still comes from the source).
  // `region`: only that part of the source was cut out (a bubble baked into a screen recording -
  // webcamBubble.ts) - the cut-out is then already cropped, and `crop` doesn't apply to it.
  // `background`: what shows behind the person, inside the layer (cutoutBackground.ts); none =
  // see-through.
  cutout?: { path: string; sourcePath: string; region?: ClipCrop; background?: CutoutBackground };
  // A webcam bubble lifted off the main recording it was baked into (webcamBubble.ts): `sourcePath`
  // is that recording, `crop` the bubble, and the layer sits exactly over it.
  bakedBubble?: boolean;
  createdAt: number;
  updatedAt: number;
}

// An adjustment layer: grades and/or blurs everything beneath it for its time range, at once -
// "under" sits on the video itself (beneath blur regions and every overlay: grade the footage,
// keep titles crisp); "over" sits above every overlay and picture-in-picture (only captions stay
// on top). The preview is a backdrop-filter of CSS filter functions (adjustmentLayers.ts) and
// export composes the very same functions in the same order (adjustment_layer_chain, conversion.rs).
export type AdjustmentPlacement = "under" | "over";
export interface AdjustmentRegion {
  // Fractions of the frame, like an overlay's box.
  x: number;
  y: number;
  width: number;
  height: number;
  shape: "rectangle" | "ellipse";
  // Soft edge, 0..1 of the region's shorter half-side.
  feather: number;
  // Apply everywhere EXCEPT the region (a spotlight: blur or darken the background).
  invert: boolean;
  // The region moving over the layer's life - following a subject (motion tracking) or animated:
  // its top-left (x, y) at each time from the layer's start; scale/opacity unused.
  keyframes?: OverlayKeyframe[];
  // How the keyframes were found, when they came from motion tracking.
  track?: OverlayTrackInfo;
}
export interface AdjustmentLayer {
  id: string;
  name?: string;
  startTime: number;
  endTime: number;
  placement: AdjustmentPlacement;
  // A colour look preset (the same presets clips have; "vignette" is the vignette field instead).
  look?: ClipColorFilter;
  // CSS filter factors: 1 = unchanged (brightness/contrast/saturation), degrees for hue.
  brightness?: number;
  contrast?: number;
  saturation?: number;
  hue?: number;
  // Gaussian blur, as a fraction of the frame's height (0 = none).
  blur?: number;
  vignette?: number;
  // 0..1 - how much of the adjustment shows; fades ramp it in/out at the ends (seconds).
  opacity?: number;
  fadeIn?: number;
  fadeOut?: number;
  // Where it applies; undefined = the whole frame.
  region?: AdjustmentRegion;
  // A solid colour ("#rrggbb") instead of the adjusted picture - with a region, what masks the
  // main video: the area (or, inverted, everything around it) shows this colour.
  fill?: string;
  createdAt: number;
  updatedAt: number;
}

// A chapter of the edited video, anchored to a moment of a SOURCE file (like captions) so it
// stays on the same shot through later cuts and reorders - videoChapters.ts maps it onto the
// output timeline. Exported into the file, its .chapters.json and the YouTube description.
export interface VideoChapter {
  id: string;
  sourcePath: string;
  sourceTime: number;
  label: string;
}

// What export_trimmed_video (Rust) actually consumes - plain, ordered [start,end) ranges, each
// Burned-in captions (the editor's Captions tool) - one word-timed transcript per SOURCE file, in
// that file's own seconds, rather than a list of output-timed caption cues. The visible lines are
// derived from these through the current clips at preview/export time (buildCaptionLines,
// captions.ts), so captions stay in sync through every trim/cut/reorder/speed change made after
// they were generated, with nothing to re-time by hand.
export interface CaptionWord {
  start: number;
  end: number;
  text: string;
  // Forces a new caption line at this word - set on each imported subtitle cue's first word, so
  // an .srt/.vtt keeps its own line breaks instead of being regrouped.
  lineStart?: boolean;
}
export type CaptionStylePreset =
  | "highlight"
  | "outline"
  | "clean"
  | "card"
  | "classic"
  | "pop"
  | "neon"
  | "bubble"
  | "typewriter"
  | "comic"
  | "tv"
  | "headline"
  | "button"
  | "spotlight"
  | "chip";
export type CaptionPosition = "top" | "middle" | "bottom";
export interface CaptionSettings {
  enabled: boolean;
  preset: CaptionStylePreset;
  // Highlights the word being spoken (karaoke-style) in emphasisColor; off shows plain lines.
  emphasis: boolean;
  emphasisColor: string;
  position: CaptionPosition;
  // Gap from the anchored edge as a fraction of frame height (ignored for "middle").
  offset: number;
  // Multiplier on the preset's base text size (frame height based).
  size: number;
  maxWordsPerLine: number;
  uppercase: boolean;
}
export interface CaptionTrack {
  language: string;
  // Keyed by Clip.sourcePath.
  transcripts: Record<string, CaptionWord[]>;
  settings: CaptionSettings;
}

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
  speed?: number;
  noiseReduction?: number;
  audioCleanup?: AudioCleanup;
  // The clip's grade baked to .cube text (gradeCubeForClip) - applied with ffmpeg's lut3d.
  lutCube?: string;
  stabilize?: { strength: number };
  // A speed ramp's constant-speed steps (clipSpeedSteps); export renders them as one continuous
  // time map (speed_steps, conversion.rs). When set, `speed` is ignored.
  speedSteps?: { sourceStart: number; sourceEnd: number; speed: number }[];
  muted?: boolean;
  // The editor-drawn pointer of an "Editable pointer" recording (pointerTrack.ts): its ripples and
  // cursor as sprite tracks timed in the source's seconds, composited onto the clip's own picture.
  pointerLayers?: SpriteTrackSpec[];
  fx?: ClipFx;
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
  adjustmentLayers: AdjustmentLayer[];
  chapters: VideoChapter[];
  // The primary video's OWN audio level - distinct from any AudioOverlay's own volume/muted (those
  // are separate mixed-in tracks; this is the original soundtrack that was always there). A plain
  // pair of fields rather than an array item like the overlays above, matching the "one track"
  // mental model VideoTimelineDocker's own trackVisible/trackLocked/trackMuted rail already assumes
  // - there's only ever one of these per edit session, never a list.
  videoAudioMuted: boolean;
  videoAudioVolume: number; // 0..1, defaults to 1
  // The video's own sound's mixer channel - EQ/compressor/balance after its volume (audioFx.ts).
  videoAudioFx?: AudioFx;
  // Video tracks (PipOverlay.track) switched off with their eye toggle - left out of the preview
  // and the export alike.
  hiddenVideoTracks?: number[];
  // null until captions are first generated - see CaptionTrack.
  captions: CaptionTrack | null;
  // Screen-recording polish (Screen Style panel): the frame around the video - wallpaper, padding,
  // corners, shadow (screenStyle.ts; undefined/null = none); how the editor draws the pointer of
  // recordings made with "Editable pointer" (pointerTrack.ts); and the keyboard-shortcut chips
  // (keystrokes.ts). The latter two hold only what was changed from their defaults.
  screenStyle?: ScreenStyle | null;
  pointerStyle?: Partial<PointerStyle>;
  keystrokeStyle?: Partial<KeystrokeStyle>;
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
  adjustmentLayers: AdjustmentLayer[];
  chapters: VideoChapter[];
  videoAudioMuted: boolean;
  videoAudioVolume: number;
  videoAudioFx?: AudioFx;
  hiddenVideoTracks?: number[];
  captions: CaptionTrack | null;
  screenStyle?: ScreenStyle | null;
  pointerStyle?: Partial<PointerStyle>;
  keystrokeStyle?: Partial<KeystrokeStyle>;
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
    | "auto-zoom"
    | "split"
    | "delete"
    | "reorder"
    | "insert"
    | "replace-clip"
    | "merge-clips"
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
    | "view-switch-cut"
    | "edit-track-audio"
    | "detach-audio"
    | "edit-captions"
    | "edit-transcript"
    | "add-adjustment"
    | "edit-adjustment"
    | "delete-adjustment"
    | "edit-chapters"
    | "track-motion"
    | "edit-mixer"
    | "edit-video-tracks"
    | "find-hide"
    | "edit-screen-style";
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
    adjustmentLayers: [],
    chapters: [],
    videoAudioMuted: false,
    videoAudioVolume: 1,
    captions: null,
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

// ---- Image clips & video projects ----------------------------------------------------------
//
// A clip's sourcePath can also be a still image - the clip then shows that image for (end-start)
// seconds. There's no "source length" to run out of, so an image clip's start is always 0 and its
// end is however long it's been stretched, capped at IMAGE_CLIP_MAX_SECONDS (the length of the
// preview proxy it plays through - see get_image_clip_proxy in conversion.rs). Every clip effect
// still applies: Ken Burns, crop, flip, color grade and transitions are what turn a set of photos
// into a slideshow. Mirrors is_still_image_path (conversion.rs). HEIC/HEIF (iPhone photos) work
// too - the backend decodes them once to a cached PNG before ffmpeg ever reads them - and a phone
// photo's EXIF rotation is honored everywhere (ffmpeg auto-rotates; thumbnails apply it).
export const IMAGE_CLIP_EXTENSIONS = ["png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp", "gif", "heic", "heif"];
export const IMAGE_CLIP_MAX_SECONDS = 600;
export const DEFAULT_IMAGE_CLIP_SECONDS = 5;

export const isImageClipPath = (path: string): boolean =>
  IMAGE_CLIP_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");

// A video project (services/video_edits.rs) - a timeline not attached to any one recording, made
// from images or started empty. The file itself only records the frame size; its timeline is the
// usual .edits.json sidecar next to it.
export const VIDEO_PROJECT_EXTENSION = "briefvideo";
export const isVideoProjectPath = (path: string): boolean => path.toLowerCase().endsWith(`.${VIDEO_PROJECT_EXTENSION}`);

export interface VideoProjectFrame {
  width: number;
  height: number;
}

export interface NewProjectOptions {
  // Seconds each image is shown for.
  imageDuration: number;
  // Ken Burns on every image clip, alternating zoom in/out so a slideshow doesn't feel mechanical.
  kenBurns: boolean;
  // Crossfade into every image after the first.
  transition: TransitionType | null;
  // Overrides `transition`: these, in turn, into each image after the first (a "mix").
  transitionCycle?: TransitionType[];
  // A built-in look (gradeLooks.ts) on every clip.
  look?: GradeLookName;
}

// How long the transition into each image of a new project lasts.
export const projectTransitionSeconds = (imageSeconds: number) => Math.min(1, imageSeconds / 3);

// Initial timeline for a new project - one clip per image, in the order given.
export function createProjectState(imagePaths: string[], options: NewProjectOptions): VideoEditState {
  const kenBurnsCycle: KenBurnsPreset[] = ["zoom-in", "zoom-out", "pan-right", "pan-left"];
  const duration = Math.min(IMAGE_CLIP_MAX_SECONDS, Math.max(0.5, options.imageDuration));
  return {
    // A project has no primary media of its own (only the black canvas it previews on).
    duration: 0,
    clips: imagePaths.map((sourcePath, i) => ({
      id: crypto.randomUUID(),
      sourcePath,
      start: 0,
      end: duration,
      ...(options.kenBurns ? { kenBurns: { preset: kenBurnsCycle[i % kenBurnsCycle.length], intensity: 0.5 } } : {}),
      ...(i > 0 && (options.transitionCycle?.length || options.transition)
        ? { transitionIn: { type: options.transitionCycle?.length ? options.transitionCycle[(i - 1) % options.transitionCycle.length] : options.transition!, duration: projectTransitionSeconds(duration) } }
        : {}),
      ...(options.look ? { grade: { look: { name: options.look, intensity: 0.85 } } } : {}),
    })),
    textOverlays: [],
    imageOverlays: [],
    blurOverlays: [],
    audioOverlays: [],
    pipOverlays: [],
    adjustmentLayers: [],
    chapters: [],
    videoAudioMuted: false,
    videoAudioVolume: 1,
    captions: null,
    updatedAt: new Date().toISOString(),
  };
}
