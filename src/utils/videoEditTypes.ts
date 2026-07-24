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

export interface Clip {
  id: string;
  sourcePath: string;
  start: number;
  end: number;
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
  updatedAt: string;
}

// The subset of VideoEditState that undo/redo actually needs to snapshot - `duration` is fixed
// per video and never changes as a result of an edit, so leaving it out of every command keeps
// undo/redo comparisons and payload sizes smaller for no loss.
export interface EditableFields {
  clips: Clip[];
}

// Whole-state before/after snapshots rather than PDF-annotations-style per-object diffs - split/
// delete/trim/reorder are coarse, click-or-drag-driven operations over a handful of clips at
// most, so a snapshot is simpler than a diff without losing any real undo/redo precision.
export interface VideoEditCommand {
  before: EditableFields;
  after: EditableFields;
  label: "trim" | "split" | "delete" | "reorder" | "insert";
}

export function createEmptyState(sourcePath: string, duration: number): VideoEditState {
  return {
    duration,
    clips: [{ id: crypto.randomUUID(), sourcePath, start: 0, end: duration }],
    updatedAt: new Date().toISOString(),
  };
}

// Sidecars are only ever written by this app, but the edit-state shape changed twice during
// development (earlier versions stored a flat `segments` list, then a trim+cuts+deletedRanges
// shape) - rather than migrate those one-off shapes, a sidecar that doesn't look like the current
// shape is treated the same as "no sidecar yet" and a fresh state is seeded instead of crashing.
export function isVideoEditState(value: unknown): value is VideoEditState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.duration === "number" && Array.isArray(v.clips);
}
