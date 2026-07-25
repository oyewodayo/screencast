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

export interface Clip {
  id: string;
  sourcePath: string;
  start: number;
  end: number;
}

// Background shape behind a text overlay's box - "rounded"/"pill" only actually differ visually
// when a backgroundColor is set (an invisible box has no edges to round). Video-only: TextObject
// (PDF notes) has no equivalent, since a PDF page has no notion of a "caption chip" aesthetic.
export type TextOverlayCornerStyle = "square" | "rounded" | "pill";
// Video-only, same reasoning: a still PDF page has no time axis to fade across, so this concept
// has nothing to mirror on the TextObject side. "fade" ramps opacity 0->1 over the first
// TEXT_FADE_DURATION_SEC of the overlay's time range and 1->0 over the last, clamped so a very
// short overlay still fades fully in before fading back out rather than overlapping oddly.
export type TextOverlayAnimation = "none" | "fade";

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
  animation?: TextOverlayAnimation; // undefined means "none", the pre-existing look
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

// What export_trimmed_video (Rust) actually consumes - plain, ordered [start,end) ranges, each
// naming its own source file. Kept as a separate type from Clip (rather than reusing Clip
// directly) so call sites are explicit about which shape they need; the id is UI-only and never
// crosses the invoke boundary.
export interface KeepSegment {
  sourcePath: string;
  start: number;
  end: number;
}

export interface VideoEditState {
  // The primary file's own duration - the file this edit session/sidecar belongs to. Clips can
  // reference other files entirely (each carries its own sourcePath); their durations are looked
  // up on demand and never stored here.
  duration: number;
  clips: Clip[];
  textOverlays: TextOverlay[];
  imageOverlays: ImageOverlay[];
  updatedAt: string;
}

// The subset of VideoEditState that undo/redo actually needs to snapshot - `duration` is fixed
// per video and never changes as a result of an edit, so leaving it out of every command keeps
// undo/redo comparisons and payload sizes smaller for no loss.
export interface EditableFields {
  clips: Clip[];
  textOverlays: TextOverlay[];
  imageOverlays: ImageOverlay[];
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
    | "split"
    | "delete"
    | "reorder"
    | "insert"
    | "add-text"
    | "edit-text"
    | "delete-text"
    | "add-image"
    | "edit-image"
    | "delete-image";
}

export function createEmptyState(sourcePath: string, duration: number): VideoEditState {
  return {
    duration,
    clips: [{ id: crypto.randomUUID(), sourcePath, start: 0, end: duration }],
    textOverlays: [],
    imageOverlays: [],
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
