// hooks/useBoardStore.ts
//
// Mirrors useImageEditStore.ts's shape (load-on-mount, debounced autosave, undo/redo command
// stack) but keyed by boardId instead of a source file path, and talking to the new
// services/boards.rs commands instead of image_annotations.rs. Does not create boards on disk
// itself - BoardHome's "New board" flow calls create_board directly, then navigates here with an
// id that's already guaranteed to exist.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BoardBackgroundMode, BoardCommand, BoardDocument, BoardGradientBackground, BoardGridBackground, BoardItem } from "../utils/boardTypes";
import { applyCommand, invertCommand, resolveBackgroundMode, resolveBoardGradient, resolveBoardGrid } from "../handlers/boardHandlers";

const AUTOSAVE_DEBOUNCE_MS = 800;

export interface UseBoardStoreResult {
  doc: BoardDocument | null;
  loading: boolean;
  loadError: string | null;
  // Named after images for historical reasons (images came first) but generic over BoardItem -
  // works identically for a BoardText item, same as boardHandlers.ts's own geometry helpers these
  // ultimately dispatch to.
  addImage: (item: BoardItem) => void;
  editImage: (before: BoardItem, after: BoardItem) => void;
  deleteImage: (item: BoardItem) => void;
  // Replaces several items at once as a single undo step - multi-selection drag, "Arrange in a
  // row". `before`/`after` must be the same items (matched by id) before/after the batch op.
  batchEditImages: (before: BoardItem[], after: BoardItem[]) => void;
  // Adds/removes several items at once as ONE undo step - "Duplicate" on a multi-selection, and
  // bulk delete. Distinct from calling addImage/deleteImage in a loop, which would create one undo
  // step per item.
  addItems: (items: BoardItem[]) => void;
  deleteItems: (items: BoardItem[]) => void;
  // Full replacement order for the whole images array - drag-to-reorder in the layers list.
  reorderImages: (newOrder: BoardItem[]) => void;
  // `null` = transparent - see BoardDocument's own doc comment.
  setBackgroundColor: (color: string | null) => void;
  // Which of the three background renderers is active - see BoardBackgroundMode's own doc comment.
  // Switching modes never touches backgroundColor/backgroundGrid/backgroundImage - each is
  // remembered independently so flipping back to a previously-used mode restores it as last left.
  setBackgroundMode: (mode: BoardBackgroundMode) => void;
  setBackgroundGrid: (grid: BoardGridBackground) => void;
  setBackgroundGradient: (gradient: BoardGradientBackground) => void;
  // Asset filename already imported into this board's assets/ folder (see BoardEditor.tsx's
  // handleChooseBackgroundImage), or null to clear it - this setter doesn't do any importing
  // itself, same division of responsibility as addImage/BoardEditor's own handleAddImages.
  setBackgroundImage: (assetFileName: string | null) => void;
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
        const parsed = JSON.parse(json);
        // BoardText didn't exist when older boards were saved, so every entry in their `images`
        // array is an image with no `kind` field at all - normalized to "image" here, once, so
        // every other reader in the app can treat `kind` as always present rather than re-deriving
        // "no kind = image" itself. A `kind: "text"` entry (impossible before this feature existed)
        // passes through unchanged. `parsed`/`item` are untyped (JSON.parse's own `any`) precisely
        // because this is the one place on-disk data may not yet match BoardItem's shape.
        const images: BoardItem[] = (parsed.images ?? []).map((item: any) => (item.kind ? item : { ...item, kind: "image" as const }));
        setDoc({ padding: 0, ...parsed, images });
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

  const addImage = useCallback((item: BoardItem) => dispatch({ type: "add", item }), [dispatch]);
  const deleteImage = useCallback((item: BoardItem) => dispatch({ type: "delete", item }), [dispatch]);
  const editImage = useCallback(
    (before: BoardItem, after: BoardItem) => {
      if (before.id !== after.id) return;
      dispatch({ type: "edit", before, after });
    },
    [dispatch]
  );

  const batchEditImages = useCallback(
    (before: BoardItem[], after: BoardItem[]) => {
      if (before.length === 0 || after.length === 0) return;
      dispatch({ type: "batch-edit", before, after });
    },
    [dispatch]
  );

  const addItems = useCallback(
    (items: BoardItem[]) => {
      if (items.length === 0) return;
      dispatch({ type: "add-batch", items });
    },
    [dispatch]
  );

  const deleteItems = useCallback(
    (items: BoardItem[]) => {
      if (items.length === 0) return;
      dispatch({ type: "delete-batch", items });
    },
    [dispatch]
  );

  const reorderImages = useCallback(
    (newOrder: BoardItem[]) => {
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

  const setBackgroundMode = useCallback(
    (mode: BoardBackgroundMode) => {
      const current = docRef.current;
      if (!current || resolveBackgroundMode(current) === mode) return;
      dispatch({ type: "background-mode", before: resolveBackgroundMode(current), after: mode });
    },
    [dispatch]
  );

  const setBackgroundGrid = useCallback(
    (grid: BoardGridBackground) => {
      const current = docRef.current;
      if (!current) return;
      dispatch({ type: "background-grid", before: resolveBoardGrid(current), after: grid });
    },
    [dispatch]
  );

  const setBackgroundGradient = useCallback(
    (gradient: BoardGradientBackground) => {
      const current = docRef.current;
      if (!current) return;
      dispatch({ type: "background-gradient", before: resolveBoardGradient(current), after: gradient });
    },
    [dispatch]
  );

  const setBackgroundImage = useCallback(
    (assetFileName: string | null) => {
      const current = docRef.current;
      if (!current || (current.backgroundImage ?? null) === assetFileName) return;
      dispatch({ type: "background-image", before: current.backgroundImage ?? null, after: assetFileName });
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
    addItems,
    deleteItems,
    reorderImages,
    setBackgroundColor,
    setBackgroundMode,
    setBackgroundGrid,
    setBackgroundGradient,
    setBackgroundImage,
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
