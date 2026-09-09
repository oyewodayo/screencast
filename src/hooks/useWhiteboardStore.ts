// hooks/useWhiteboardStore.ts
//
// Mirrors useBoardStore.ts's shape (load-on-mount, debounced autosave, undo/redo command stack)
// but keyed by whiteboardId and talking to services/whiteboards.rs instead of boards.rs. Does not
// create whiteboards on disk itself - WhiteboardHome's "New whiteboard" flow calls
// create_whiteboard directly, then navigates here with an id that's already guaranteed to exist.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WhiteboardCommand, WhiteboardDocument, WhiteboardEdge, WhiteboardNode } from "../utils/whiteboardTypes";
import { applyCommand, invertCommand, undoDeleteNode } from "../handlers/whiteboardHandlers";

const AUTOSAVE_DEBOUNCE_MS = 800;

export interface UseWhiteboardStoreResult {
  doc: WhiteboardDocument | null;
  loading: boolean;
  loadError: string | null;
  addNode: (node: WhiteboardNode) => void;
  editNode: (before: WhiteboardNode, after: WhiteboardNode) => void;
  // Deletes a node AND every edge attached to it, as one undo step - see whiteboardTypes.ts's
  // 'delete-node' command doc comment for why edges can't be left dangling.
  deleteNode: (node: WhiteboardNode) => void;
  // Replaces several nodes at once as a single undo step - multi-selection drag/resize.
  batchEditNodes: (before: WhiteboardNode[], after: WhiteboardNode[]) => void;
  addEdge: (edge: WhiteboardEdge) => void;
  editEdge: (before: WhiteboardEdge, after: WhiteboardEdge) => void;
  deleteEdge: (edge: WhiteboardEdge) => void;
  // Full replacement order for the whole nodes array - "Bring to front" / "Send to back".
  reorderNodes: (newOrder: WhiteboardNode[]) => void;
  setShowGrid: (show: boolean) => void;
  // Not an undo command - same reasoning as Board/Docs not undo-tracking a title edit.
  renameWhiteboard: (name: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isSaving: boolean;
  saveError: string | null;
  // Forces any pending debounced save to write immediately - WhiteboardEditor calls this before
  // navigating back to Whiteboard Home (and before regenerating the thumbnail) so trailing edits
  // from the last few hundred ms aren't lost.
  flushSave: () => void;
}

export default function useWhiteboardStore(whiteboardId: string | undefined): UseWhiteboardStoreResult {
  const [doc, setDoc] = useState<WhiteboardDocument | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<WhiteboardCommand[]>([]);
  const [redoStack, setRedoStack] = useState<WhiteboardCommand[]>([]);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const docRef = useRef<WhiteboardDocument | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  useEffect(() => {
    if (!whiteboardId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setLoadError(null);
      setUndoStack([]);
      setRedoStack([]);
      try {
        const json = await invoke<string>("load_whiteboard", { id: whiteboardId });
        if (cancelled) return;
        const parsed = JSON.parse(json);
        setDoc({ showGrid: true, edges: [], ...parsed });
      } catch (err) {
        console.error("Failed to load whiteboard:", err);
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [whiteboardId]);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const current = docRef.current;
    if (!whiteboardId || !current) return;
    setIsSaving(true);
    invoke("save_whiteboard", { id: whiteboardId, json: JSON.stringify(current) })
      .then(() => {
        setIsSaving(false);
        setSaveError(null);
      })
      .catch((err) => {
        setIsSaving(false);
        setSaveError(err instanceof Error ? err.message : String(err));
      });
  }, [whiteboardId]);

  const scheduleAutosave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Flush any pending save when switching whiteboards or unmounting so trailing edits aren't lost.
  useEffect(() => {
    return () => flushSave();
  }, [whiteboardId, flushSave]);

  const dispatch = useCallback(
    (command: WhiteboardCommand) => {
      setDoc((prev) => (prev ? applyCommand(prev, command) : prev));
      setUndoStack((prev) => [...prev, command]);
      setRedoStack([]);
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const addNode = useCallback((node: WhiteboardNode) => dispatch({ type: "add-node", item: node }), [dispatch]);

  const editNode = useCallback(
    (before: WhiteboardNode, after: WhiteboardNode) => {
      if (before.id !== after.id) return;
      dispatch({ type: "edit-node", before, after });
    },
    [dispatch]
  );

  const deleteNode = useCallback(
    (node: WhiteboardNode) => {
      const current = docRef.current;
      const edges = current ? current.edges.filter((e) => e.source.nodeId === node.id || e.target.nodeId === node.id) : [];
      dispatch({ type: "delete-node", item: node, edges });
    },
    [dispatch]
  );

  const batchEditNodes = useCallback(
    (before: WhiteboardNode[], after: WhiteboardNode[]) => {
      if (before.length === 0 || after.length === 0) return;
      dispatch({ type: "batch-edit-nodes", before, after });
    },
    [dispatch]
  );

  const addEdge = useCallback((edge: WhiteboardEdge) => dispatch({ type: "add-edge", item: edge }), [dispatch]);

  const editEdge = useCallback(
    (before: WhiteboardEdge, after: WhiteboardEdge) => {
      if (before.id !== after.id) return;
      dispatch({ type: "edit-edge", before, after });
    },
    [dispatch]
  );

  const deleteEdge = useCallback((edge: WhiteboardEdge) => dispatch({ type: "delete-edge", item: edge }), [dispatch]);

  const reorderNodes = useCallback(
    (newOrder: WhiteboardNode[]) => {
      const current = docRef.current;
      if (!current) return;
      dispatch({ type: "reorder-nodes", before: current.nodes, after: newOrder });
    },
    [dispatch]
  );

  // Not undo-tracked (same reasoning as renameWhiteboard below) - a grid-visibility toggle isn't
  // something a user expects Ctrl+Z to step back through.
  const setShowGrid = useCallback((show: boolean) => {
    setDoc((prev) => (prev ? { ...prev, showGrid: show } : prev));
    scheduleAutosave();
  }, [scheduleAutosave]);

  const renameWhiteboard = useCallback(
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
      setDoc((prev) => {
        if (!prev) return prev;
        // delete-node's inverse needs to restore both the node and every edge it cascaded away -
        // more than invertCommand's return type alone can express (see its own doc comment on this
        // case), so this one command type is undone directly rather than via applyCommand+invertCommand.
        if (command.type === "delete-node") return undoDeleteNode(prev, command);
        return applyCommand(prev, invertCommand(command));
      });
      setRedoStack((prevRedo) => [...prevRedo, command]);
      scheduleAutosave();
      return prevUndo.slice(0, -1);
    });
  }, [scheduleAutosave]);

  const redo = useCallback(() => {
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;
      const command = prevRedo[prevRedo.length - 1];
      // Forward direction never needs special-casing - applyCommand's "delete-node" branch already
      // removes both the node and its cascade-listed edges in one go.
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
    addNode,
    editNode,
    deleteNode,
    batchEditNodes,
    addEdge,
    editEdge,
    deleteEdge,
    reorderNodes,
    setShowGrid,
    renameWhiteboard,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    isSaving,
    saveError,
    flushSave,
  };
}
