// hooks/useBoardStore.ts
//
// Mirrors useImageEditStore.ts's shape (load-on-mount, debounced autosave, undo/redo command
// stack) but keyed by boardId instead of a source file path, and talking to the new
// services/boards.rs commands instead of image_annotations.rs. Does not create boards on disk
// itself - BoardHome's "New board" flow calls create_board directly, then navigates here with an
// id that's already guaranteed to exist.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { BoardCommand, BoardDocument, BoardImage } from "../utils/boardTypes";
import { applyCommand, invertCommand } from "../handlers/boardHandlers";

const AUTOSAVE_DEBOUNCE_MS = 800;

export interface UseBoardStoreResult {
  doc: BoardDocument | null;
  loading: boolean;
  loadError: string | null;
  addImage: (image: BoardImage) => void;
  editImage: (before: BoardImage, after: BoardImage) => void;
  deleteImage: (image: BoardImage) => void;
  // Replaces several images at once as a single undo step - multi-selection drag, "Arrange in a
  // row". `before`/`after` must be the same images (matched by id) before/after the batch op.
  batchEditImages: (before: BoardImage[], after: BoardImage[]) => void;
  // Full replacement order for the whole images array - drag-to-reorder in the layers list.
  reorderImages: (newOrder: BoardImage[]) => void;
  // `null` = transparent - see BoardDocument's own doc comment.
  setBackgroundColor: (color: string | null) => void;
  setCanvasSize: (width: number, height: number) => void;
  // Mat/frame border around the whole board - see BoardDocument's own doc comment. Purely a
  // rendering-time inset (boardHandlers.ts's paddedCanvasSize), so this alone is enough to update
  // live - no re-arrange step needed the way the old gridline-width control required.
  setPadding: (padding: number) => void;
  // Not an undo command - same reasoning as the video/PDF editors not undo-tracking a title edit.
  renameBoard: (name: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isSaving: boolean;
  saveError: string | null;
  // Forces any pending debounced save to write immediately - BoardEditor calls this before
  // navigating back to Board Home (and before regenerating the thumbnail) so trailing edits from
  // the last few hundred ms aren't lost.
  flushSave: () => void;
}

export default function useBoardStore(boardId: string | undefined): UseBoardStoreResult {
  const [doc, setDoc] = useState<BoardDocument | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<BoardCommand[]>([]);
  const [redoStack, setRedoStack] = useState<BoardCommand[]>([]);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const docRef = useRef<BoardDocument | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setLoadError(null);
      setUndoStack([]);
      setRedoStack([]);
      try {
        const json = await invoke<string>("load_board", { id: boardId });
        if (cancelled) return;
        // A field added to BoardDocument after a board was first saved is simply absent from
        // that board's on-disk JSON - defaulted here, once, right after parse. This is on top of
        // (not instead of) every consumer's own defensive guard (e.g. boardHandlers.ts's
        // resolveBoardPadding) - a missing `padding` already reached the zoom-percentage readout
        // as NaN once because only *some* consumers guarded it; belt and suspenders now.
        setDoc({ padding: 0, ...JSON.parse(json) });
      } catch (err) {
        console.error("Failed to load board:", err);
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const current = docRef.current;
    if (!boardId || !current) return;
    setIsSaving(true);
    invoke("save_board", { id: boardId, json: JSON.stringify(current) })
      .then(() => {
        setIsSaving(false);
        setSaveError(null);
      })
      .catch((err) => {
        setIsSaving(false);
        setSaveError(err instanceof Error ? err.message : String(err));
      });
  }, [boardId]);

  const scheduleAutosave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Flush any pending save when switching boards or unmounting so trailing edits aren't lost.
  useEffect(() => {
    return () => flushSave();
  }, [boardId, flushSave]);

  const dispatch = useCallback(
    (command: BoardCommand) => {
      setDoc((prev) => (prev ? applyCommand(prev, command) : prev));
      setUndoStack((prev) => [...prev, command]);
      setRedoStack([]);
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const addImage = useCallback((image: BoardImage) => dispatch({ type: "add", image }), [dispatch]);
  const deleteImage = useCallback((image: BoardImage) => dispatch({ type: "delete", image }), [dispatch]);
  const editImage = useCallback(
    (before: BoardImage, after: BoardImage) => {
      if (before.id !== after.id) return;
      dispatch({ type: "edit", before, after });
    },
    [dispatch]
  );

  const batchEditImages = useCallback(
    (before: BoardImage[], after: BoardImage[]) => {
      if (before.length === 0 || after.length === 0) return;
      dispatch({ type: "batch-edit", before, after });
    },
    [dispatch]
  );

  const reorderImages = useCallback(
    (newOrder: BoardImage[]) => {
      const current = docRef.current;
      if (!current) return;
      dispatch({ type: "reorder", before: current.images, after: newOrder });
    },
    [dispatch]
  );

  const setBackgroundColor = useCallback(
    (color: string | null) => {
      const current = docRef.current;
      if (!current || current.backgroundColor === color) return;
      dispatch({ type: "background", before: current.backgroundColor, after: color });
    },
    [dispatch]
  );

  // Applied after "Arrange in a row" so the canvas grows or shrinks to fit whatever that layout
  // actually needed - see boardHandlers.ts's AutoLayoutResult.
  const setCanvasSize = useCallback(
    (width: number, height: number) => {
      const current = docRef.current;
      if (!current || (current.canvasWidth === width && current.canvasHeight === height)) return;
      dispatch({ type: "canvas-size", before: { width: current.canvasWidth, height: current.canvasHeight }, after: { width, height } });
    },
    [dispatch]
  );

  const setPadding = useCallback(
    (padding: number) => {
      const current = docRef.current;
      const clamped = Math.max(0, Math.round(padding || 0));
      if (!current || current.padding === clamped) return;
      dispatch({ type: "padding", before: current.padding, after: clamped });
    },
    [dispatch]
  );

  // Renames write straight through (debounced), same as flushSave's own save path, rather than
  // going through dispatch/applyCommand - a title isn't part of the undo/redo history.
  const renameBoard = useCallback(
    (name: string) => {
      setDoc((prev) => (prev ? { ...prev, name, updatedAt: new Date().toISOString() } : prev));
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const undo = useCallback(() => {
    setUndoStack((prevUndo) => {
      if (prevUndo.length === 0) return prevUndo;
      const command = prevUndo[prevUndo.length - 1];
      setDoc((prev) => (prev ? applyCommand(prev, invertCommand(command)) : prev));
      setRedoStack((prevRedo) => [...prevRedo, command]);
      scheduleAutosave();
      return prevUndo.slice(0, -1);
    });
  }, [scheduleAutosave]);

  const redo = useCallback(() => {
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;
      const command = prevRedo[prevRedo.length - 1];
      setDoc((prev) => (prev ? applyCommand(prev, command) : prev));
      setUndoStack((prevUndo) => [...prevUndo, command]);
      scheduleAutosave();
      return prevRedo.slice(0, -1);
    });
  }, [scheduleAutosave]);

  return {
    doc,
    loading,
    loadError,
    addImage,
    editImage,
    deleteImage,
    batchEditImages,
    reorderImages,
    setBackgroundColor,
    setCanvasSize,
    setPadding,
    renameBoard,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    isSaving,
    saveError,
    flushSave,
  };
}
