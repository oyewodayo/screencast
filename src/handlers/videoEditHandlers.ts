// handlers/videoEditHandlers.ts
//
// Pure functions only, mirroring pdfAnnotationHandlers.ts's style: no React, callers pass in
// everything they need explicitly. useVideoEditStore is the only caller.

import { pipTrack } from "../utils/videoTracks";
import { clipSpeedSteps, subSpan } from "../utils/clipTiming";
import type { OverlayAsset } from "../utils/videoAssets";
import { AudioOverlay, BlurOverlay, Clip, ClipCrop, EditableFields, ImageOverlay, KeepSegment, PipOverlay, TextOverlay, VideoEditCommand, isImageClipPath } from "../utils/videoEditTypes";

const MIN_CLIP_LENGTH = 0.05;
const MIN_OVERLAY_DURATION = 0.1;

export function applyCommand(command: VideoEditCommand): EditableFields {
  return command.after;
}

export function invertCommand(command: VideoEditCommand): VideoEditCommand {
  return { before: command.after, after: command.before, label: command.label };
}

// Rust's ClipCrop (conversion.rs) requires width/height as plain (non-Option) f64 - a crop object
// missing them, e.g. a stale {x,y,size} value left over from an older shape this type used earlier
// (in-memory state from before a shape change, or an already-saved sidecar file written by that
// older version), would otherwise fail JSON deserialization on invoke and hard-error the whole
// export. Dropping it back to "uncropped" here is the same defensive fallback ClipCropOverlay's
// own `committed`/clipFrameAffine already use for display - export just needs the same safety
// net at its own boundary.
function sanitizeCrop(crop: ClipCrop | undefined): ClipCrop | undefined {
  if (!crop || !Number.isFinite(crop.width) || !Number.isFinite(crop.height) || crop.width <= 0 || crop.height <= 0) return undefined;
  return crop;
}

// The plain [start,end) ranges export_trimmed_video needs, each naming its own source file, in
// the same order as `clips` - that order is exactly the desired playback/output order, so this is
// a type-only projection, not a sort or a merge.
// One segment per clip. A speed-ramped clip carries its constant-speed steps (clipSpeedSteps - the
// same steps the preview plays at), which export renders as a single continuous time map, so its
// length is exact.
export function toKeepSegments(clips: Clip[]): KeepSegment[] {
  return clips.map((clip) => {
    const { sourcePath, start, end, speed, colorFilter, stabilize, kenBurns, transitionIn, crop, flipHorizontal, noiseReduction, audioCleanup } = clip;
    return {
      sourcePath,
      start,
      end,
      speed,
      colorFilter,
      stabilize,
      kenBurns,
      transitionIn,
      crop: sanitizeCrop(crop),
      flipHorizontal,
      noiseReduction,
      audioCleanup,
      speedSteps: clip.speedRamp ? clipSpeedSteps(clip) : undefined,
      muted: clip.muted || undefined,
      fx: clip.fx && clip.fx.intensity > 0 ? clip.fx : undefined,
    };
  });
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

// A piece [start, end] cut out of `clip`: every setting carried over (look, grade, motion, speed,
// audio, reverse...), its speed ramp and Ken Burns move narrowed to the part of them this piece
// covers - so the pieces of a clip together play exactly as it did. Only the first piece keeps the
// transition (the rest join their neighbour by a plain cut).
export function clipPiece(clip: Clip, start: number, end: number, opts: { id?: string; first: boolean }): Clip {
  const piece: Clip = { ...clip, id: opts.id ?? crypto.randomUUID(), start, end, transitionIn: opts.first ? clip.transitionIn : undefined };
  if (clip.speedRamp) piece.speedRamp = { ...clip.speedRamp, span: subSpan(clip, clip.speedRamp.span, start, end) };
  if (clip.kenBurns) piece.kenBurns = { ...clip.kenBurns, span: subSpan(clip, clip.kenBurns.span, start, end) };
  if (!piece.speedRamp?.span) delete piece.speedRamp?.span;
  if (!piece.kenBurns?.span) delete piece.kenBurns?.span;
  if (!piece.transitionIn) delete piece.transitionIn;
  return piece;
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
    clipPiece(clip, clip.start, sourceTime, { first: true }),
    clipPiece(clip, sourceTime, clip.end, { first: false }),
    ...clips.slice(index + 1),
  ];
}

// The "remove every detected dead-air gap in this clip" gesture (detect_silence, conversion.rs;
// the Trim Silence button) as ONE undo command - cutClipRanges on this clip. Ranges are clamped to
// the clip (detect_silence scans the WHOLE source file); a piece shorter than MIN_CLIP_LENGTH is
// dropped rather than kept as a sliver; a clip that's silent throughout is removed.
export function removeSilentRanges(clips: Clip[], clipId: string, silentRanges: { start: number; end: number }[]): Clip[] {
  return cutClipRanges(clips, silentRanges.map((r) => ({ clipId, start: r.start, end: r.end })));
}

// Removes source ranges from specific clips (by id), splitting a clip into the pieces left
// between its cuts - what edit-by-transcript's deletions and pause tightening apply
// (transcriptEdit.ts) and silence removal. Pieces are clipPiece's (every setting kept, ramps and
// Ken Burns continued). The first piece also keeps the clip's id, so anything keyed on it
// (selection, transcript word keys) survives the cut.
export function cutClipRanges(clips: Clip[], cuts: { clipId: string; start: number; end: number }[]): Clip[] {
  if (cuts.length === 0) return clips;
  let changed = false;
  const next = clips.flatMap((clip) => {
    const own = cuts
      .filter((c) => c.clipId === clip.id)
      .map((c) => ({ start: Math.max(clip.start, c.start), end: Math.min(clip.end, c.end) }))
      .filter((c) => c.end > c.start)
      .sort((a, b) => a.start - b.start);
    if (own.length === 0) return [clip];
    changed = true;
    const kept: { start: number; end: number }[] = [];
    let cursor = clip.start;
    for (const range of own) {
      if (range.start > cursor) kept.push({ start: cursor, end: range.start });
      cursor = Math.max(cursor, range.end);
    }
    if (clip.end > cursor) kept.push({ start: cursor, end: clip.end });
    return kept
      .filter((k) => k.end - k.start >= MIN_CLIP_LENGTH)
      .map((k, i) => clipPiece(clip, k.start, k.end, { id: i === 0 ? clip.id : undefined, first: i === 0 }));
  });
  return changed ? next : clips;
}

// Freeze frame: the clip split at `sourceTime` with a still of that frame (`stillPath`, an image
// clip `seconds` long) between the two halves. At the clip's very start/end there's nothing to
// split, so the still just goes before/after it. The still has no transition of its own; the
// second half loses the clip's (it now follows the still by a plain cut).
export function insertFreezeFrame(clips: Clip[], clipId: string, sourceTime: number, stillPath: string, seconds: number): Clip[] {
  const index = clips.findIndex((c) => c.id === clipId);
  if (index === -1) return clips;
  const clip = clips[index];
  const still: Clip = { id: crypto.randomUUID(), sourcePath: stillPath, start: 0, end: seconds, colorFilter: clip.colorFilter, grade: clip.grade, crop: clip.crop, flipHorizontal: clip.flipHorizontal };
  if (sourceTime - clip.start < MIN_CLIP_LENGTH) return [...clips.slice(0, index), still, ...clips.slice(index)];
  if (clip.end - sourceTime < MIN_CLIP_LENGTH) return [...clips.slice(0, index + 1), still, ...clips.slice(index + 1)];
  const first = clipPiece(clip, clip.start, sourceTime, { id: clip.id, first: true });
  const second = clipPiece(clip, sourceTime, clip.end, { first: false });
  return [...clips.slice(0, index), first, still, second, ...clips.slice(index + 1)];
}

// Reverse / un-reverse: a reversed clip points at the backwards render of its own range.
// `reversedFrom` describes that render - which original range it covers - not the clip's current
// trim, so splitting, trimming or freezing a frame in a reversed clip needs no bookkeeping: a
// clip at [a,b] of the render (render time t = original end - t) un-reverses to
// [original end - b, original end - a]. Every other setting is kept either way.
export function reverseClip(clips: Clip[], clipId: string, reversedPath: string): Clip[] {
  return clips.map((c) =>
    c.id === clipId && !c.reversedFrom
      ? { ...c, sourcePath: reversedPath, start: 0, end: c.end - c.start, reversedFrom: { sourcePath: c.sourcePath, start: c.start, end: c.end } }
      : c
  );
}
export function unreverseClip(clips: Clip[], clipId: string): Clip[] {
  return clips.map((c) => {
    if (c.id !== clipId || !c.reversedFrom) return c;
    const { reversedFrom, ...rest } = c;
    return { ...rest, sourcePath: reversedFrom.sourcePath, start: reversedFrom.end - c.end, end: reversedFrom.end - c.start };
  });
}

// One recorded click, already resolved to this clip's own SOURCE-time coordinate space (same
// space Clip.start/end occupy) and frame-relative x/y (see load_click_sidecar, recording.rs, and
// ClickEvent's own doc comment there for how these get produced during recording).
export interface AutoZoomClick {
  time: number;
  x: number;
  y: number;
}

// Bracketing durations for the punch-in/punch-out pair generated around each click - tuned once
// here (not user-adjustable in v1) to read as a deliberate "zoom in on this, hold, zoom back out"
// beat: LEAD_IN ramps up to the peak zoom by shortly after the click itself (the ramp is still
// finishing as the click lands, which reads better than already being fully zoomed in before
// anything happened), HOLD is how long it stays near peak, LEAD_OUT ramps back to normal.
const AUTO_ZOOM_LEAD_IN_SEC = 0.8;
const AUTO_ZOOM_HOLD_SEC = 1.5;
const AUTO_ZOOM_LEAD_OUT_SEC = 0.8;
const AUTO_ZOOM_INTENSITY = 0.6;

// Splits `clipId`'s own [start,end) around each click that falls inside it, inserting a zoom-in-
// then-zoom-out pair of Ken Burns segments centered on that click's own position for each one - the
// "auto zoom on click" toolbar action's actual splice logic, batched into ONE undo command the same
// "batch cuts land as one command, not 2*N" reasoning removeSilentRanges above already established
// (see its own doc comment). Clicks too close together to each get their own non-overlapping zoom
// window are skipped entirely (not merged, not truncated) - simpler than trying to blend two
// overlapping zooms into one, and a skipped click still gets its own zoom on a later call once
// earlier ones have been removed to make room.
export function applyAutoZoomAtClicks(clips: Clip[], clipId: string, clicks: AutoZoomClick[]): Clip[] {
  const index = clips.findIndex((c) => c.id === clipId);
  if (index === -1) return clips;
  const clip = clips[index];

  const sorted = clicks.filter((c) => c.time > clip.start && c.time < clip.end).sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return clips;

  const pieces: Clip[] = [];
  let cursor = clip.start;
  for (const click of sorted) {
    const zoomStart = Math.max(cursor, click.time - AUTO_ZOOM_LEAD_IN_SEC);
    const peak = click.time + AUTO_ZOOM_HOLD_SEC;
    const zoomEnd = Math.min(clip.end, peak + AUTO_ZOOM_LEAD_OUT_SEC);
    if (zoomStart < cursor || peak - zoomStart < MIN_CLIP_LENGTH || zoomEnd - peak < MIN_CLIP_LENGTH) continue;

    // Every setting kept (clipPiece); the zoom pieces get their own move in place of any the clip had.
    const plain = (a: number, b: number) => {
      const piece = clipPiece(clip, a, b, { first: pieces.length === 0 });
      delete piece.kenBurns;
      return piece;
    };
    if (zoomStart > cursor) pieces.push(plain(cursor, zoomStart));
    pieces.push({ ...plain(zoomStart, peak), kenBurns: { preset: "zoom-in", intensity: AUTO_ZOOM_INTENSITY, targetX: click.x, targetY: click.y } });
    pieces.push({ ...plain(peak, zoomEnd), kenBurns: { preset: "zoom-out", intensity: AUTO_ZOOM_INTENSITY, targetX: click.x, targetY: click.y } });
    cursor = zoomEnd;
  }
  if (pieces.length === 0) return clips;
  if (clip.end > cursor) {
    const rest = clipPiece(clip, cursor, clip.end, { first: false });
    delete rest.kenBurns;
    pieces.push(rest);
  }

  return [...clips.slice(0, index), ...pieces, ...clips.slice(index + 1)];
}

// Removes the clip at `index` outright - what was that stretch of source video is simply no
// longer represented anywhere in the array, no separate "deleted range" bookkeeping needed.
export function deleteClipAt(clips: Clip[], index: number): Clip[] {
  if (index < 0 || index >= clips.length) return clips;
  return clips.filter((_, i) => i !== index);
}

// Multi-selection versions of delete/duplicate (Ctrl/Shift-click on the timeline). Same array in,
// same array out when none of `ids` is present, so callers can skip the undo step.
export function deleteClips(clips: Clip[], ids: string[]): Clip[] {
  const remove = new Set(ids);
  const next = clips.filter((c) => !remove.has(c.id));
  return next.length === clips.length ? clips : next;
}

// Every image clip shown for `seconds` (of output time - speed is respected) in one go: the quick way
// to a fast photo montage where each picture flashes by. Video clips are left alone.
export function setImageClipLengths(clips: Clip[], seconds: number): Clip[] {
  return clips.map((c) => (isImageClipPath(c.sourcePath) ? { ...c, end: c.start + Math.max(MIN_CLIP_LENGTH, seconds * (c.speed ?? 1)) } : c));
}

// Merge (multi-selection, clip menu): when the selected clips are back-to-back pieces of the same
// recording - what Split leaves behind - with nothing between them in the source and the same
// settings, they're simply one longer clip again: no render, everything stays editable. Returns
// null when that isn't the case (then the caller renders them into a single new file instead).
const MERGE_GAP_EPSILON_SEC = 0.001;
const sameSettings = (a: Clip, b: Clip): boolean =>
  JSON.stringify([a.speed ?? 1, a.colorFilter, a.grade, a.crop, !!a.flipHorizontal, a.kenBurns, a.stabilize, a.noiseReduction, a.audioCleanup, !!a.muted]) ===
  JSON.stringify([b.speed ?? 1, b.colorFilter, b.grade, b.crop, !!b.flipHorizontal, b.kenBurns, b.stabilize, b.noiseReduction, b.audioCleanup, !!b.muted]);
export function mergeClipsInPlace(clips: Clip[], ids: string[]): Clip[] | null {
  const indices = ids.map((id) => clips.findIndex((c) => c.id === id)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (indices.length < 2) return null;
  const run = indices.map((i) => clips[i]);
  for (let k = 1; k < run.length; k++) {
    const prev = run[k - 1];
    const cur = run[k];
    if (indices[k] !== indices[k - 1] + 1) return null; // not side by side on the timeline
    if (cur.sourcePath !== prev.sourcePath || isImageClipPath(cur.sourcePath)) return null;
    if (Math.abs(cur.start - prev.end) > MERGE_GAP_EPSILON_SEC) return null; // something was cut out between
    if (cur.transitionIn || cur.speedRamp || prev.speedRamp || cur.reversedFrom || prev.reversedFrom || !sameSettings(prev, cur)) return null;
  }
  const merged: Clip = { ...run[0], end: run[run.length - 1].end };
  return [...clips.slice(0, indices[0]), merged, ...clips.slice(indices[indices.length - 1] + 1)];
}

// Each copy lands right after its own original - what a single Duplicate already does.
export function duplicateClips(clips: Clip[], ids: string[], makeId: () => string): Clip[] {
  const copy = new Set(ids);
  if (!clips.some((c) => copy.has(c.id))) return clips;
  return clips.flatMap((c) => (copy.has(c.id) ? [c, { ...c, id: makeId() }] : [c]));
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

// The one generic patch entry point for a clip's non-geometric fields (color grade, Ken Burns,
// transition) - same "one function, Partial<T> patch" shape as updateOverlay, but standalone
// since Clip (unlike every overlay type) has no updatedAt for anything to read back, so it can't
// reuse updateOverlay<T extends {id,updatedAt}> as-is.
export function updateClip(clips: Clip[], id: string, patch: Partial<Pick<Clip, "colorFilter" | "grade" | "stabilize" | "speedRamp" | "kenBurns" | "transitionIn" | "crop" | "flipHorizontal" | "speed" | "noiseReduction" | "audioCleanup" | "muted" | "fx">>): Clip[] {
  return clips.map((c) => (c.id === id ? { ...c, ...patch } : c));
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

export function makeImageOverlay(src: string, x: number, y: number, width: number, height: number, startTime: number, endTime: number, asset?: OverlayAsset): ImageOverlay {
  const now = Date.now();
  return { id: crypto.randomUUID(), src, ...(asset ? { asset } : {}), x, y, width, height, opacity: 1, startTime, endTime, createdAt: now, updatedAt: now };
}

export function makeBlurOverlay(x: number, y: number, width: number, height: number, intensity: number, startTime: number, endTime: number): BlurOverlay {
  const now = Date.now();
  return { id: crypto.randomUUID(), x, y, width, height, intensity, startTime, endTime, createdAt: now, updatedAt: now };
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

export function makeAudioOverlay(src: string, sourceDuration: number, startTime: number, endTime: number, label?: string): AudioOverlay {
  const now = Date.now();
  return { id: crypto.randomUUID(), src, sourceDuration, startTime, endTime, trimStart: 0, volume: 1, ...(label ? { label } : {}), createdAt: now, updatedAt: now };
}

// Whether an audio overlay came from "Detach audio" rather than being music the user added.
// Overlays detached before the `detached` flag existed are recognized by where detach writes its
// files (the app cache's detached-audio folder), so re-detaching also cleans those up.
export function isDetachedAudioOverlay(o: AudioOverlay): boolean {
  return o.detached === true || /[\\/]detached-audio[\\/]/.test(o.src);
}

// Stacks audio overlays into rows so overlapping ones (e.g. a detached voice and music pair, or
// several detached streams) get their own row instead of drawing on top of each other. Greedy
// by start time: each overlay takes the first row whose last overlay has already ended.
export function packAudioRows(overlays: AudioOverlay[]): { rowOf: Map<string, number>; rowCount: number } {
  const rowEnds: number[] = [];
  const rowOf = new Map<string, number>();
  const sorted = [...overlays].sort((a, b) => a.startTime - b.startTime || a.createdAt - b.createdAt);
  for (const o of sorted) {
    let row = rowEnds.findIndex((end) => end <= o.startTime + 1e-6);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(o.endTime);
    } else {
      rowEnds[row] = o.endTime;
    }
    rowOf.set(o.id, row);
  }
  return { rowOf, rowCount: rowEnds.length };
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

export function makePipOverlay(
  sourcePath: string,
  sourceDuration: number,
  x: number,
  y: number,
  width: number,
  height: number,
  startTime: number,
  endTime: number
): PipOverlay {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    sourcePath,
    sourceDuration,
    x,
    y,
    width,
    height,
    shape: "circle",
    trimStart: 0,
    startTime,
    endTime,
    volume: 1,
    muted: true,
    createdAt: now,
    updatedAt: now,
  };
}

// One screen<->camera toggle recorded during a "sva" + separate_webcam_capture recording (see
// record_view_switch, recording.rs) - already resolved to this clip's own SOURCE-time coordinate
// space (same space Clip.start/end occupy), same "backend records raw events, frontend resolves
// them against the selected clip" split AutoZoomClick above uses for click data.
export interface ViewSwitchEvent {
  time: number;
  mode: "screen" | "camera";
}

// Turns an alternating sequence of screen/camera toggle events into the camera-active [start,end)
// intervals within clipId's own [start,end) range, one full-frame PipOverlay per interval cutting
// to `webcamPath` - see RECORDING_UPGRADE_NOTES.md's view-switching feature design for why a
// full-frame PipOverlay (rather than a Clip-level cut) is the right representation: export's own
// pip_overlay_chain (conversion.rs) already produces exactly the time-gated
// `overlay=...:enable='between(t,t1,t2)'` a hard cut needs, with zero new Rust filter logic.
//
// `events` should be every switch the recording ever logged, not pre-filtered to this clip - the
// mode active AT clipStart has to be inferred from the last event at or before it (a clip trimmed
// to start mid-camera-view has no "screen" event of its own inside its own range to say so).
// Defaults to "screen" if no such event exists (either the recording predates the very first
// switch, or - the common case - the user never switched away from the screen view at all before
// this clip's own start).
//
// `clipOutputStart` is where clipId's own [start,end) source range begins on the OUTPUT timeline
// (PipOverlay.startTime/endTime's own coordinate space - see its doc comment, videoEditTypes.ts -
// unlike Clip.start/end, which are source-time) - the caller already has this on hand from its own
// outputStarts/clipDurations arrays (see VideoTimelineDocker.tsx's own doc comment on those), so
// it's taken as a parameter rather than recomputed here from a full clip list this function has no
// other reason to need. `clipSpeed` (Clip.speed, undefined means 1) converts a source-time span
// into the OUTPUT-time span it actually occupies, same conversion outputStarts/clipDurations
// themselves already apply - a camera interval inside a 2x-speed clip plays back in half the
// source-time span it spans.
export function buildViewSwitchOverlays(
  events: ViewSwitchEvent[],
  clipStart: number,
  clipEnd: number,
  clipOutputStart: number,
  clipSpeed: number | undefined,
  webcamPath: string
): PipOverlay[] {
  const speed = clipSpeed ?? 1;
  const toOutputTime = (sourceTime: number) => clipOutputStart + (sourceTime - clipStart) / speed;

  const sorted = [...events].sort((a, b) => a.time - b.time);
  let currentMode: "screen" | "camera" = "screen";
  let i = 0;
  while (i < sorted.length && sorted[i].time <= clipStart) {
    currentMode = sorted[i].mode;
    i++;
  }

  const intervals: { start: number; end: number }[] = [];
  let intervalStart: number | null = currentMode === "camera" ? clipStart : null;
  for (; i < sorted.length && sorted[i].time < clipEnd; i++) {
    const ev = sorted[i];
    if (ev.mode === "camera" && intervalStart === null) {
      intervalStart = Math.max(ev.time, clipStart);
    } else if (ev.mode === "screen" && intervalStart !== null) {
      intervals.push({ start: intervalStart, end: ev.time });
      intervalStart = null;
    }
  }
  if (intervalStart !== null) {
    intervals.push({ start: intervalStart, end: clipEnd });
  }

  const now = Date.now();
  return intervals
    .filter(({ start, end }) => end > start)
    .map(({ start, end }) => ({
      id: crypto.randomUUID(),
      sourcePath: webcamPath,
      // Reads the webcam file starting at the SAME position within it as this interval's own
      // position within the main recording - both files started rolling at the same instant (one
      // ffmpeg process, two outputs - see win.rs's recording_with_output_sva), so source-time in
      // one is source-time in the other.
      trimStart: start,
      sourceDuration: end - start,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      shape: "rectangle" as const,
      startTime: toOutputTime(start),
      endTime: toOutputTime(end),
      // Muted - the mic (if any) already went to the main track during recording (win.rs's own
      // comment on why a separately-captured webcam file never has its own audio track to begin
      // with), same reasoning makePipOverlay's own `muted: true` default documents.
      volume: 0,
      muted: true,
      createdAt: now,
      updatedAt: now,
    }));
}

// Drags one edge of a PiP overlay's time range - same trim-into-source reasoning as
// resizeAudioOverlayTime above (a PipOverlay is a real video source too, not an abstract
// stretchable box like text/image/blur), copied rather than shared with it since the two types
// have no common base beyond id/startTime/endTime/trimStart/sourceDuration, which duplicateTimedOverlay's
// own generic constraint already shows isn't quite worth abstracting over for just this one method.
export function resizePipOverlayTime(overlays: PipOverlay[], id: string, edge: "start" | "end", maxOutputEnd: number, time: number): PipOverlay[] {
  return overlays.map((o) => {
    if (o.id !== id) return o;
    if (edge === "start") {
      const minStart = o.startTime - o.trimStart;
      const clampedStart = Math.max(minStart, Math.min(time, o.endTime - MIN_OVERLAY_DURATION));
      const trimStart = o.trimStart + (clampedStart - o.startTime);
      return { ...o, startTime: clampedStart, trimStart, updatedAt: Date.now() };
    }
    const trimEnd = o.trimStart + (o.endTime - o.startTime);
    const roomInSource = o.sourceDuration - trimEnd;
    const maxEnd = Math.min(maxOutputEnd, o.endTime + Math.max(0, roomInSource));
    const clampedEnd = Math.min(maxEnd, Math.max(time, o.startTime + MIN_OVERLAY_DURATION));
    return { ...o, endTime: clampedEnd, updatedAt: Date.now() };
  });
}

// Cuts one PiP overlay in two at `outputTime` - the PiP-lane counterpart to splitClipAt. The
// second piece picks up exactly where the first leaves off in the pip's own source (trimStart
// advanced by the first piece's length), so playing both back to back is visually identical to
// the unsplit original. Everything else (geometry, shape, crop, audio) carries over to both pieces.
// Returns the input unchanged when the cut would leave either piece shorter than
// MIN_OVERLAY_DURATION (same "too close to an edge" rule splitClipAt applies to clips).
export function splitPipOverlayAt(overlays: PipOverlay[], id: string, outputTime: number): PipOverlay[] {
  const index = overlays.findIndex((o) => o.id === id);
  if (index === -1) return overlays;
  const o = overlays[index];
  if (outputTime - o.startTime < MIN_OVERLAY_DURATION || o.endTime - outputTime < MIN_OVERLAY_DURATION) return overlays;
  const now = Date.now();
  const first: PipOverlay = { ...o, endTime: outputTime, updatedAt: now };
  const second: PipOverlay = {
    ...o,
    id: crypto.randomUUID(),
    startTime: outputTime,
    trimStart: o.trimStart + (outputTime - o.startTime),
    createdAt: now,
    updatedAt: now,
  };
  return [...overlays.slice(0, index), first, second, ...overlays.slice(index + 1)];
}

// Cuts an audio overlay in two at `outputTime` (Split with an audio chip selected) - the way to
// keep just the part of a song you want: cut, then delete the unwanted piece. Same shape as
// splitPipOverlayAt; the fade-in stays on the first piece and the fade-out on the second, so the
// song's own beginning and end still fade as they did.
export function splitAudioOverlayAt(overlays: AudioOverlay[], id: string, outputTime: number): AudioOverlay[] {
  const index = overlays.findIndex((o) => o.id === id);
  if (index === -1) return overlays;
  const o = overlays[index];
  if (outputTime - o.startTime < MIN_OVERLAY_DURATION || o.endTime - outputTime < MIN_OVERLAY_DURATION) return overlays;
  const now = Date.now();
  const first: AudioOverlay = { ...o, endTime: outputTime, fadeOutSec: undefined, updatedAt: now };
  const second: AudioOverlay = {
    ...o,
    id: crypto.randomUUID(),
    startTime: outputTime,
    trimStart: o.trimStart + (outputTime - o.startTime),
    fadeInSec: undefined,
    createdAt: now,
    updatedAt: now,
  };
  return [...overlays.slice(0, index), first, second, ...overlays.slice(index + 1)];
}

// Tolerance for "this piece starts exactly where that one ends" - pieces produced by
// splitPipOverlayAt share the exact same boundary value, but a boundary that has since been moved
// through the store's own float math can drift by a hair.
const PIP_CHAIN_EPSILON_SEC = 0.001;

// Deletes one PiP piece and closes the gap it leaves - the PiP-lane counterpart to deleting a clip
// (which the concat-based clip track does implicitly). Only the pieces CHAINED directly after the
// deleted one move back: each successive piece of the same source that starts exactly where the
// previous one ends, i.e. what splitting one PiP produces. Cut the unwanted middle out of a split
// PiP and the pieces either side of it join up and play back to back. Anything not touching the
// chain - a separately-placed PiP, or the gapped per-interval pieces a view-switch recording
// produces (buildViewSwitchOverlays), which must stay in sync with the screen track - is left
// exactly where it is.
export function deletePipOverlayAndCloseGap(overlays: PipOverlay[], id: string): PipOverlay[] {
  const deleted = overlays.find((o) => o.id === id);
  if (!deleted) return overlays;
  const remaining = overlays.filter((o) => o.id !== id);
  const gap = deleted.endTime - deleted.startTime;

  const chainIds = new Set<string>();
  let chainEnd = deleted.endTime;
  for (;;) {
    const next = remaining.find(
      (o) => !chainIds.has(o.id) && o.sourcePath === deleted.sourcePath && pipTrack(o) === pipTrack(deleted) && Math.abs(o.startTime - chainEnd) <= PIP_CHAIN_EPSILON_SEC
    );
    if (!next) break;
    chainIds.add(next.id);
    chainEnd = next.endTime;
  }
  if (chainIds.size === 0) return remaining;

  const now = Date.now();
  return remaining.map((o) => (chainIds.has(o.id) ? { ...o, startTime: o.startTime - gap, endTime: o.endTime - gap, updatedAt: now } : o));
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
