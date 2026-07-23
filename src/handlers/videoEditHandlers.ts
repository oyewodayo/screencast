// handlers/videoEditHandlers.ts
//
// Pure functions only, mirroring pdfAnnotationHandlers.ts's style: no React, callers pass in
// everything they need explicitly. useVideoEditStore is the only caller.

import { Clip, EditableFields, KeepSegment, VideoEditCommand } from "../utils/videoEditTypes";

const MIN_CLIP_LENGTH = 0.05;

export function applyCommand(command: VideoEditCommand): EditableFields {
  return command.after;
}

export function invertCommand(command: VideoEditCommand): VideoEditCommand {
  return { before: command.after, after: command.before, label: command.label };
}

// The plain [start,end) ranges export_trimmed_video needs, in the same order as `clips` - that
// order is exactly the desired playback/output order, so this is a type-only projection, not a
// sort or a merge.
export function toKeepSegments(clips: Clip[]): KeepSegment[] {
  return clips.map(({ start, end }) => ({ start, end }));
}

// Which clip (by array position) `sourceTime` falls into, if any. Normal editing never produces
// overlapping clips, so this is expected to be unambiguous; if it ever isn't, the first match
// (lowest array index) wins.
export function clipIndexAt(clips: Clip[], sourceTime: number): number {
  return clips.findIndex((c) => sourceTime >= c.start && sourceTime < c.end);
}

// Splits the clip at `sourceTime` into two adjacent clips in the same array slot, preserving
// playback order. No-op (returns the same array reference) if `sourceTime` isn't strictly inside
// any clip, or is too close to that clip's own edges to leave two meaningful pieces.
export function splitClipAt(clips: Clip[], sourceTime: number): Clip[] {
  const index = clipIndexAt(clips, sourceTime);
  if (index === -1) return clips;
  const clip = clips[index];
  if (sourceTime - clip.start < MIN_CLIP_LENGTH || clip.end - sourceTime < MIN_CLIP_LENGTH) return clips;
  return [
    ...clips.slice(0, index),
    { id: crypto.randomUUID(), start: clip.start, end: sourceTime },
    { id: crypto.randomUUID(), start: sourceTime, end: clip.end },
    ...clips.slice(index + 1),
  ];
}

// Removes the clip at `sourceTime` outright - what was that stretch of source video is simply no
// longer represented anywhere in the array, no separate "deleted range" bookkeeping needed.
export function deleteClipAt(clips: Clip[], sourceTime: number): Clip[] {
  const index = clipIndexAt(clips, sourceTime);
  if (index === -1) return clips;
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

// Drags one edge of a single clip - independent of every other clip. Clamped only against that
// clip's own opposite edge and the overall video duration; deliberately not clamped against
// neighboring clips, since clips are addressed by array order (playback position) rather than
// source-time adjacency and are allowed to have gaps or, if dragged that far, overlaps between
// them in source time.
export function resizeClipEdge(clips: Clip[], id: string, edge: "start" | "end", duration: number, time: number): Clip[] {
  return clips.map((c) => {
    if (c.id !== id) return c;
    if (edge === "start") {
      const clamped = Math.max(0, Math.min(time, c.end - MIN_CLIP_LENGTH));
      return { ...c, start: clamped };
    }
    const clamped = Math.min(duration, Math.max(time, c.start + MIN_CLIP_LENGTH));
    return { ...c, end: clamped };
  });
}
