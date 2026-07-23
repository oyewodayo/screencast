// hooks/useVideoEditStore.ts
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { Clip, EditableFields, VideoEditCommand, VideoEditState, createEmptyState, isVideoEditState } from "../utils/videoEditTypes";
import {
  applyCommand,
  deleteClipAt as deleteClipAtHandler,
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

interface UseVideoEditStoreResult {
  loading: boolean;
  // Ordered clips - array order is playback order in preview/export, independent of each clip's
  // own source start/end. This is the single source of truth; there's no separate trim/gap state.
  clips: Clip[];
  // Called once the real video duration is known (from the hidden capture <video>'s
  // loadedmetadata) - only seeds a fresh, unedited state; a no-op once real state exists (either
  // loaded from the sidecar or already seeded), so it's safe to call on every metadata load.
  setDuration: (duration: number) => void;
  splitAt: (sourceTime: number) => void;
  deleteClipAt: (sourceTime: number) => void;
  reorderClip: (fromIndex: number, toIndex: number) => void;
  resizeClipEdge: (id: string, edge: "start" | "end", time: number) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isExporting: boolean;
  exportProgress: number | null;
  exportError: string | null;
  exportEdited: () => Promise<{ path: string; name: string } | null>;
}

// Non-destructive edit state (an ordered, reorderable list of clips) for one video, backed by a
// JSON sidecar next to the source file - never a duplicated copy of the video itself. Modeled on
// useAnnotationStore.ts: same load-on-file-change, same debounced autosave, same undo/redo stack
// shape.
export default function useVideoEditStore(sourcePath: string | undefined): UseVideoEditStoreResult {
  const [state, setState] = useState<VideoEditState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [undoStack, setUndoStack] = useState<VideoEditCommand[]>([]);
  const [redoStack, setRedoStack] = useState<VideoEditCommand[]>([]);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const stateRef = useRef<VideoEditState | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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
            if (isVideoEditState(parsed)) setState(parsed);
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

  const setDuration = useCallback((duration: number) => {
    setState((prev) => (prev ? prev : createEmptyState(duration)));
  }, []);

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
    (sourceTime: number) => {
      const current = stateRef.current;
      if (!current) return;
      const clips = splitClipAt(current.clips, sourceTime);
      if (clips === current.clips) return; // too close to an edge - no-op
      pushCommand({ clips: current.clips }, { clips }, "split");
    },
    [pushCommand]
  );

  const deleteClipAt = useCallback(
    (sourceTime: number) => {
      const current = stateRef.current;
      if (!current || current.clips.length <= 1) return; // never delete down to nothing left
      const clips = deleteClipAtHandler(current.clips, sourceTime);
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
      const clips = resizeClipEdgeHandler(current.clips, id, edge, current.duration, time);
      pushCommand({ clips: current.clips }, { clips }, "trim");
    },
    [pushCommand]
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
  // every other conversion does, so it emits the same 'conversion-progress' event) filtered down
  // to this file, so the Save button can show real percentage instead of just a spinner.
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
        inputPath: sourcePath,
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
    splitAt,
    deleteClipAt,
    reorderClip,
    resizeClipEdge,
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
