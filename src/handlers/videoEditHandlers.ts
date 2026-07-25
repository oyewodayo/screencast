// handlers/videoEditHandlers.ts
//
// Pure functions only, mirroring pdfAnnotationHandlers.ts's style: no React, callers pass in
// everything they need explicitly. useVideoEditStore is the only caller.

import { AudioOverlay, Clip, EditableFields, ImageOverlay, KeepSegment, TextOverlay, VideoEditCommand } from "../utils/videoEditTypes";

const MIN_CLIP_LENGTH = 0.05;
const MIN_OVERLAY_DURATION = 0.1;

export function applyCommand(command: VideoEditCommand): EditableFields {
  return command.after;
}

export function invertCommand(command: VideoEditCommand): VideoEditCommand {
  return { before: command.after, after: command.before, label: command.label };
}

// The plain [start,end) ranges export_trimmed_video needs, each naming its own source file, in
// the same order as `clips` - that order is exactly the desired playback/output order, so this is
// a type-only projection, not a sort or a merge.
export function toKeepSegments(clips: Clip[]): KeepSegment[] {
  return clips.map(({ sourcePath, start, end }) => ({ sourcePath, start, end }));
}

// Which clip (by array position) `sourceTime` falls into, restricted to `sourcePath` - without
// that restriction this would be ambiguous once clips can come from different files (two clips
// from different sources can easily share overlapping time ranges, e.g. both starting at 0).
// Only meaningful for "is the clip I already know about still the one under the playhead" checks
// (the live-preview tracking effect, mainly) - operations that need to find *which* clip a click
// or the playhead landed on (Split, Delete) are given that clip's array index directly by the
// caller instead of re-deriving it from a bare time value, for the same reason.
export function clipIndexAt(clips: Clip[], sourcePath: string, sourceTime: number): number {
  return clips.findIndex((c) => c.sourcePath === sourcePath && sourceTime >= c.start && sourceTime < c.end);
}

// Splits the clip at `index` into two adjacent clips (same sourcePath) in its old array slot,
// preserving playback order. No-op (returns the same array reference) if `index` is out of range,
// or `sourceTime` is too close to that clip's own edges to leave two meaningful pieces.
export function splitClipAt(clips: Clip[], index: number, sourceTime: number): Clip[] {
  const clip = clips[index];
  if (!clip) return clips;
  if (sourceTime - clip.start < MIN_CLIP_LENGTH || clip.end - sourceTime < MIN_CLIP_LENGTH) return clips;
  return [
    ...clips.slice(0, index),
    { id: crypto.randomUUID(), sourcePath: clip.sourcePath, start: clip.start, end: sourceTime },
    { id: crypto.randomUUID(), sourcePath: clip.sourcePath, start: sourceTime, end: clip.end },
    ...clips.slice(index + 1),
  ];
}

// Removes the clip at `index` outright - what was that stretch of source video is simply no
// longer represented anywhere in the array, no separate "deleted range" bookkeeping needed.
export function deleteClipAt(clips: Clip[], index: number): Clip[] {
  if (index < 0 || index >= clips.length) return clips;
  return clips.filter((_, i) => i !== index);
}

// Moves the clip at `fromIndex` to sit at `toIndex` in the array - i.e. changes its playback
// position without touching its own source start/end. Both indices are clamped into range so a
// drag that overshoots either end of the track just lands at that end instead of erroring.
export function reorderClip(clips: Clip[], fromIndex: number, toIndex: number): Clip[] {
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= clips.length) return clips;
  const clamped = Math.max(0, Math.min(toIndex, clips.length - 1));
  const next = [...clips];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(clamped, 0, moved);
  return next;
}

// Inserts a brand-new clip (dragged in from the Briefcast library or an external file) at
// `index`, shifting everything from that position onward later in the playback order. Clamped so
// dropping before the first clip or past the last one still lands somewhere valid.
export function insertClip(clips: Clip[], index: number, newClip: Clip): Clip[] {
  const clamped = Math.max(0, Math.min(index, clips.length));
  return [...clips.slice(0, clamped), newClip, ...clips.slice(clamped)];
}

// Drags one edge of a single clip - independent of every other clip. Clamped only against that
// clip's own opposite edge and `maxEnd` (the *that clip's own source file's* duration, looked up
// by the caller - every clip can come from a different file, so there's no single shared
// duration to clamp every clip's end against anymore); deliberately not clamped against
// neighboring clips, since clips are addressed by array order (playback position) rather than
// source-time adjacency and are allowed to have gaps or, if dragged that far, overlaps between
// them in source time.
export function resizeClipEdge(clips: Clip[], id: string, edge: "start" | "end", maxEnd: number, time: number): Clip[] {
  return clips.map((c) => {
    if (c.id !== id) return c;
    if (edge === "start") {
      const clamped = Math.max(0, Math.min(time, c.end - MIN_CLIP_LENGTH));
      return { ...c, start: clamped };
    }
    const clamped = Math.min(maxEnd, Math.max(time, c.start + MIN_CLIP_LENGTH));
    return { ...c, end: clamped };
  });
}

// ---- Overlays (text + image) -----------------------------------------------------------------
//
// Same pure/no-React style as the clip functions above. CRUD and timing logic (update/delete/
// retime/move/active-at) is identical in shape for text and image overlays - both are just
// {id, startTime, endTime, updatedAt}-shaped rows on the same output timeline - so it's written
// once here, generically, rather than duplicated per overlay kind. Formatting mutation specific to
// TEXT content (color runs, bold/italic ranges) is handled by the generic helpers already in
// pdfAnnotationHandlers.ts (applyColorRun, shiftColorRunsForEdit, toggleTextRange, etc.) - nothing
// here duplicates those either.

export function makeTextOverlay(x: number, y: number, width: number, fontSize: number, startTime: number, endTime: number): TextOverlay {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    text: "",
    color: "#ffffff",
    x,
    y,
    width,
    height: fontSize * 1.3,
    fontSize,
    startTime,
    endTime,
    createdAt: now,
    updatedAt: now,
  };
}

export function makeImageOverlay(src: string, x: number, y: number, width: number, height: number, startTime: number, endTime: number): ImageOverlay {
  const now = Date.now();
  return { id: crypto.randomUUID(), src, x, y, width, height, opacity: 1, startTime, endTime, createdAt: now, updatedAt: now };
}

export function addOverlay<T>(overlays: T[], overlay: T): T[] {
  return [...overlays, overlay];
}

// The one generic patch function every overlay edit goes through - content, color/bold/italic,
// move, box-resize, font-resize, and retime are all just a Partial<T> from the caller's point of
// view, the same way resizeClipEdge is the one function covering both a clip's edges.
export function updateOverlay<T extends { id: string; updatedAt: number }>(overlays: T[], id: string, patch: Partial<T>): T[] {
  return overlays.map((o) => (o.id === id ? { ...o, ...patch, updatedAt: Date.now() } : o));
}

export function deleteOverlay<T extends { id: string }>(overlays: T[], id: string): T[] {
  return overlays.filter((o) => o.id !== id);
}

// Which overlays should be visible/rendered at this point on the output timeline.
export function overlaysActiveAt<T extends { startTime: number; endTime: number }>(overlays: T[], outputTime: number): T[] {
  return overlays.filter((o) => outputTime >= o.startTime && outputTime < o.endTime);
}

// Drags one edge of a single overlay's time range - same shape as resizeClipEdge, but clamped
// against the assembled timeline's own total duration (overlays have no per-file source duration
// to clamp against) and a minimum overlay length instead of MIN_CLIP_LENGTH.
export function resizeOverlayTime<T extends { id: string; startTime: number; endTime: number; updatedAt: number }>(
  overlays: T[],
  id: string,
  edge: "start" | "end",
  maxEnd: number,
  time: number
): T[] {
  return overlays.map((o) => {
    if (o.id !== id) return o;
    if (edge === "start") {
      const clamped = Math.max(0, Math.min(time, o.endTime - MIN_OVERLAY_DURATION));
      return { ...o, startTime: clamped, updatedAt: Date.now() };
    }
    const clamped = Math.min(maxEnd, Math.max(time, o.startTime + MIN_OVERLAY_DURATION));
    return { ...o, endTime: clamped, updatedAt: Date.now() };
  });
}

// Moves a whole overlay's time range (both edges together, preserving its duration) - the drag-
// the-chip-body case, as opposed to resizeOverlayTime's drag-one-edge case. Clamped so the range
// never slides past either end of the assembled timeline.
export function moveOverlayTime<T extends { id: string; startTime: number; endTime: number; updatedAt: number }>(
  overlays: T[],
  id: string,
  newStartTime: number,
  maxEnd: number
): T[] {
  return overlays.map((o) => {
    if (o.id !== id) return o;
    const duration = o.endTime - o.startTime;
    const clampedStart = Math.max(0, Math.min(newStartTime, maxEnd - duration));
    return { ...o, startTime: clampedStart, endTime: clampedStart + duration, updatedAt: Date.now() };
  });
}

// A small position nudge so a freshly duplicated overlay doesn't land exactly on top of the
// original (which would look like nothing happened until you dragged one aside) - same idea as
// most design tools' "paste in place, offset a few px" convention. Time range is copied as-is;
// only position is nudged, since retiming a duplicate is exactly the kind of thing the timeline
// lane's own drag already handles well.
const DUPLICATE_POSITION_OFFSET = 0.03;

export function duplicateOverlay<T extends { id: string; x: number; y: number; createdAt: number; updatedAt: number }>(overlay: T): T {
  const now = Date.now();
  return {
    ...overlay,
    id: crypto.randomUUID(),
    x: Math.min(1, overlay.x + DUPLICATE_POSITION_OFFSET),
    y: Math.min(1, overlay.y + DUPLICATE_POSITION_OFFSET),
    createdAt: now,
    updatedAt: now,
  };
}

// Stacking order within one overlay kind's own array is just array order (later = rendered on
// top - see VideoOverlayLayer's activeOverlays/activeImageOverlays .map() calls) - "front"/"back"
// are therefore just "move to the end"/"move to the start" of that same array. Note text and
// image overlays are two entirely separate render passes (all images render, then all text -
// see VideoOverlayLayer's return), so these only ever reorder within one kind; there's no single
// combined z-order across both yet.
export function bringOverlayToFront<T extends { id: string }>(overlays: T[], id: string): T[] {
  const index = overlays.findIndex((o) => o.id === id);
  if (index === -1 || index === overlays.length - 1) return overlays;
  const next = [...overlays];
  const [item] = next.splice(index, 1);
  next.push(item);
  return next;
}

export function sendOverlayToBack<T extends { id: string }>(overlays: T[], id: string): T[] {
  const index = overlays.findIndex((o) => o.id === id);
  if (index <= 0) return overlays;
  const next = [...overlays];
  const [item] = next.splice(index, 1);
  next.unshift(item);
  return next;
}

// ---- Audio overlays ----------------------------------------------------------------------------
//
// Not folded into the generic overlay functions above: an audio overlay has a finite SOURCE file
// behind it (unlike text/image, which have nothing to "run out of"), so its own resize/duplicate
// need source-aware logic the shape-only generics can't express. addOverlay/updateOverlay/
// deleteOverlay/overlaysActiveAt/moveOverlayTime above are still reused as-is for audio - a move
// (drag the chip body) is exactly "shift startTime/endTime together, leave everything else alone"
// regardless of overlay kind.

export function makeAudioOverlay(src: string, sourceDuration: number, startTime: number, endTime: number): AudioOverlay {
  const now = Date.now();
  return { id: crypto.randomUUID(), src, sourceDuration, startTime, endTime, trimStart: 0, volume: 1, createdAt: now, updatedAt: now };
}

// Drags one edge of an audio overlay's time range - unlike resizeOverlayTime (text/image, which
// can freely stretch an empty box), this trims *into the source audio* the same way resizeClipEdge
// trims a video clip: the dragged edge's own output-timeline boundary and its corresponding
// trimStart offset move together, so (endTime-startTime) always stays equal to however much of the
// source is actually selected - never time-stretched, always 1x playback.
export function resizeAudioOverlayTime(overlays: AudioOverlay[], id: string, edge: "start" | "end", maxOutputEnd: number, time: number): AudioOverlay[] {
  return overlays.map((o) => {
    if (o.id !== id) return o;
    if (edge === "start") {
      // Can't reveal more of the source than exists before the current trim window (trimStart
      // can't go below 0), and can't push the start past leaving MIN_OVERLAY_DURATION before end.
      const minStart = o.startTime - o.trimStart;
      const clampedStart = Math.max(minStart, Math.min(time, o.endTime - MIN_OVERLAY_DURATION));
      const trimStart = o.trimStart + (clampedStart - o.startTime);
      return { ...o, startTime: clampedStart, trimStart, updatedAt: Date.now() };
    }
    // End edge: can't extend past whatever's left of the source after the current trim window
    // (trimStart + duration can't exceed sourceDuration), or past the assembled timeline's own end.
    const trimEnd = o.trimStart + (o.endTime - o.startTime);
    const roomInSource = o.sourceDuration - trimEnd;
    const maxEnd = Math.min(maxOutputEnd, o.endTime + Math.max(0, roomInSource));
    const clampedEnd = Math.min(maxEnd, Math.max(time, o.startTime + MIN_OVERLAY_DURATION));
    return { ...o, endTime: clampedEnd, updatedAt: Date.now() };
  });
}

// A time-offset sibling to duplicateOverlay above (which requires x/y - meaningless for an audio
// overlay, which has no position on the frame) - nudges startTime/endTime together by a small
// constant instead, clamped to the assembled timeline's own end the same way moveOverlayTime is.
const DUPLICATE_TIME_OFFSET_SEC = 0.5;

export function duplicateTimedOverlay<T extends { id: string; startTime: number; endTime: number; createdAt: number; updatedAt: number }>(
  overlay: T,
  maxOutputEnd: number
): T {
  const now = Date.now();
  // Clamping duration itself first (not just startTime) matters when the overlay is already
  // longer than the current timeline - nothing re-clamps an overlay's own endTime when clips are
  // trimmed shorter after it was placed, so `duration > maxOutputEnd` is a real, reachable case,
  // not just a defensive check. Without this, Math.max(0, ...) below would floor startTime at 0
  // but leave endTime (= startTime + the ORIGINAL duration) still overshooting maxOutputEnd.
  const duration = Math.min(overlay.endTime - overlay.startTime, Math.max(0, maxOutputEnd));
  const startTime = Math.max(0, Math.min(overlay.startTime + DUPLICATE_TIME_OFFSET_SEC, maxOutputEnd - duration));
  return { ...overlay, id: crypto.randomUUID(), startTime, endTime: startTime + duration, createdAt: now, updatedAt: now };
}
