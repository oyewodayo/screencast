// hooks/useVideoEditStore.ts
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { Clip, EditableFields, VideoEditCommand, VideoEditState, createEmptyState, isVideoEditState } from "../utils/videoEditTypes";
import {
  applyCommand,
  deleteClipAt as deleteClipAtHandler,
  insertClip as insertClipHandler,
  reorderClip as reorderClipHandler,
  resizeClipEdge as resizeClipEdgeHandler,
  splitClipAt,
  toKeepSegments,
} from "../handlers/videoEditHandlers";

const AUTOSAVE_DEBOUNCE_MS = 800;

interface ConversionProgressPayload {
  input_path: string;
  progress: number;
  status: "starting" | "processing" | "completed" | "failed";
  message: string;
}

// ffprobe-backed duration lookup for a file that isn't the one this edit session belongs to (a
// clip dragged in from elsewhere) - reuses get_conversion_info, the same command the generic
// file-tools info panel already calls for exactly this kind of "duration of an arbitrary file"
// question. Returns null rather than throwing on failure (unsupported file, ffprobe error, etc.)
// so a bad drag-in degrades to "can't resize this clip's end past what shows on-screen right now"
// instead of crashing the whole editor.
async function fetchDuration(path: string): Promise<number | null> {
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

interface UseVideoEditStoreResult {
  loading: boolean;
  // Ordered clips - array order is playback order in preview/export, independent of each clip's
  // own source start/end or which file it comes from. This is the single source of truth;
  // there's no separate trim/gap state.
  clips: Clip[];
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
  resizeClipEdge: (id: string, edge: "start" | "end", time: number) => void;
  // Inserts a whole new clip - from the Briefcast library or an external file dropped onto the
  // timeline - at `atIndex`, fetching its duration first if not already known. Resolves once the
  // clip has actually been added (or been skipped, if the duration lookup failed).
  insertClipAt: (sourcePath: string, atIndex: number) => Promise<void>;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isExporting: boolean;
  exportProgress: number | null;
  exportError: string | null;
  exportEdited: () => Promise<{ path: string; name: string } | null>;
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
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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

    if (!sourcePath) return;
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
              setState(parsed);
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

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const current = stateRef.current;
    if (!sourcePath || !current) return;
    invoke("save_video_edit_state", { videoPath: sourcePath, json: JSON.stringify(current) }).catch((err) =>
      console.error("Failed to save video edit state:", err)
    );
  }, [sourcePath]);

  const scheduleAutosave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Flush any pending save when switching files or unmounting so a trailing edit isn't lost.
  useEffect(() => {
    return () => flushSave();
  }, [sourcePath, flushSave]);

  const setDuration = useCallback(
    (duration: number) => {
      if (sourcePath) registerSourceDuration(sourcePath, duration);
      setState((prev) => (prev ? prev : sourcePath ? createEmptyState(sourcePath, duration) : prev));
    },
    [sourcePath, registerSourceDuration]
  );

  const pushCommand = useCallback(
    (before: EditableFields, after: EditableFields, label: VideoEditCommand["label"]) => {
      if (after.clips.length === 0) return; // never leave nothing to preview/export
      const command: VideoEditCommand = { before, after, label };
      setState((prev) => (prev ? { ...prev, ...applyCommand(command), updatedAt: new Date().toISOString() } : prev));
      setUndoStack((prev) => [...prev, command]);
      setRedoStack([]);
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const splitAt = useCallback(
    (index: number, sourceTime: number) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = splitClipAt(current.clips, index, sourceTime);
      if (clips === current.clips) return; // too close to an edge - no-op
      pushCommand({ clips: current.clips }, { clips }, "split");
    },
    [pushCommand]
  );

  const deleteClipAt = useCallback(
    (index: number) => {
      const current = stateRef.current;
      if (!current || current.clips.length <= 1) return; // never delete down to nothing left
      const clips = deleteClipAtHandler(current.clips, index);
      if (clips === current.clips) return;
      pushCommand({ clips: current.clips }, { clips }, "delete");
    },
    [pushCommand]
  );

  const reorderClip = useCallback(
    (fromIndex: number, toIndex: number) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = reorderClipHandler(current.clips, fromIndex, toIndex);
      if (clips === current.clips) return;
      pushCommand({ clips: current.clips }, { clips }, "reorder");
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
      pushCommand({ clips: current.clips }, { clips }, "trim");
    },
    [pushCommand, getSourceDuration]
  );

  const insertClipAt = useCallback(
    async (newClipSourcePath: string, atIndex: number) => {
      const current = stateRef.current;
      // Temporary diagnostic, see the matching log in VideoTimelineDocker's handleTrackDrop -
      // `current == null` here means the edit store hasn't finished loading/seeding yet (a real
      // possible race right after opening a file), which would silently swallow every insert.
      console.log("[useVideoEditStore] insertClipAt called", { newClipSourcePath, atIndex, hasState: !!current });
      if (!current) return;
      let duration = getSourceDuration(newClipSourcePath);
      if (duration == null) {
        duration = await fetchDuration(newClipSourcePath);
        console.log("[useVideoEditStore] fetched duration for inserted clip", { newClipSourcePath, duration });
        if (duration == null) return; // couldn't read this file - nothing to insert
        registerSourceDuration(newClipSourcePath, duration);
      }
      const latest = stateRef.current;
      if (!latest) return;
      const newClip: Clip = { id: crypto.randomUUID(), sourcePath: newClipSourcePath, start: 0, end: duration };
      const clips = insertClipHandler(latest.clips, atIndex, newClip);
      pushCommand({ clips: latest.clips }, { clips }, "insert");
    },
    [pushCommand, getSourceDuration, registerSourceDuration]
  );

  const undo = useCallback(() => {
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

  const exportEdited = useCallback(async (): Promise<{ path: string; name: string } | null> => {
    const current = stateRef.current;
    if (!sourcePath || !current || current.clips.length === 0) return null;
    setIsExporting(true);
    setExportError(null);
    try {
      const outputPath = await invoke<string>("export_trimmed_video", {
        outputBasePath: sourcePath,
        segments: toKeepSegments(current.clips),
      });
      const name = outputPath.split(/[\\/]/).pop() ?? outputPath;
      return { path: outputPath, name };
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsExporting(false);
      setExportProgress(null);
    }
  }, [sourcePath]);

  return {
    loading,
    clips: state?.clips ?? [],
    setDuration,
    getSourceDuration,
    splitAt,
    deleteClipAt,
    reorderClip,
    resizeClipEdge,
    insertClipAt,
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
