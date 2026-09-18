// hooks/useMindmapStore.ts
//
// Same shape as useWhiteboardStore.ts (load-on-mount, debounced autosave, undo/redo command stack)
// keyed by mindmapId and talking to services/mindmaps.rs. Simpler in one respect: a mindmap is a
// SINGLE canvas, with no page dimension - so every mutator writes the document's own nodes/edges
// directly and the undo stack is document-wide rather than per page.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MindmapDocument, MindmapEdge, MindmapNode } from "../utils/mindmapTypes";
import { MindmapCommand, applyMindmapCommand, edgesTouching, invertMindmapCommand } from "../handlers/mindmapHandlers";

const AUTOSAVE_DEBOUNCE_MS = 800;

export interface UseMindmapStoreResult {
  doc: MindmapDocument | null;
  loading: boolean;
  loadError: string | null;
  addNodes: (nodes: MindmapNode[], edges?: MindmapEdge[]) => void;
  editNodes: (before: MindmapNode[], after: MindmapNode[]) => void;
  // Deletes nodes AND every connector touching them, as one undo step - an edge pointing at a
  // removed node has nothing to resolve its endpoint against.
  deleteNodes: (nodes: MindmapNode[]) => void;
  addEdge: (edge: MindmapEdge) => void;
  editEdge: (before: MindmapEdge, after: MindmapEdge) => void;
  deleteEdge: (edge: MindmapEdge) => void;
  reorderNodes: (newOrder: MindmapNode[]) => void;
  // Name/description are undo-tracked together as one "document details" edit - unlike the
  // whiteboard, where renaming isn't undoable at all. The difference is that here the description
  // is real content (it's published alongside the roadmap and read by whoever opens it), not just a
  // filing label, so losing it to a mistyped edit with no way back would be a genuine loss.
  editDetails: (name: string, description: string) => void;
  setShowGrid: (show: boolean) => void;
  setSnapToGrid: (snap: boolean) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isSaving: boolean;
  saveError: string | null;
  flushSave: () => void;
}

// Normalizes a just-loaded document into the current shape. Untyped `raw: any` deliberately - this
// is the one place on-disk data may not match MindmapDocument's current shape, same convention
// useWhiteboardStore.ts's own migrateDocument uses.
function migrateDocument(raw: any): MindmapDocument {
  return {
    description: "",
    showGrid: true,
    snapToGrid: true,
    ...raw,
    nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw.edges) ? raw.edges : [],
  };
}

export default function useMindmapStore(mindmapId: string | undefined): UseMindmapStoreResult {
  const [doc, setDoc] = useState<MindmapDocument | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<MindmapCommand[]>([]);
  const [redoStack, setRedoStack] = useState<MindmapCommand[]>([]);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const docRef = useRef<MindmapDocument | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  useEffect(() => {
    if (!mindmapId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      setUndoStack([]);
      setRedoStack([]);
      try {
        const json = await invoke<string>("load_mindmap", { id: mindmapId });
        if (cancelled) return;
        setDoc(migrateDocument(JSON.parse(json)));
      } catch (err) {
        console.error("Failed to load mindmap:", err);
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mindmapId]);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const current = docRef.current;
    if (!mindmapId || !current) return;
    setIsSaving(true);
    invoke("save_mindmap", { id: mindmapId, json: JSON.stringify(current) })
      .then(() => {
        setIsSaving(false);
        setSaveError(null);
      })
      .catch((err) => {
        setIsSaving(false);
        setSaveError(err instanceof Error ? err.message : String(err));
      });
  }, [mindmapId]);

  const scheduleAutosave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Flush any pending save when switching mindmaps or unmounting so trailing edits aren't lost.
  useEffect(() => {
    return () => flushSave();
  }, [mindmapId, flushSave]);

  const dispatch = useCallback(
    (command: MindmapCommand) => {
      setDoc((prev) => (prev ? { ...applyMindmapCommand(prev, command), updatedAt: new Date().toISOString() } : prev));
      setUndoStack((prev) => [...prev, command]);
      setRedoStack([]);
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const addNodes = useCallback((nodes: MindmapNode[], edges: MindmapEdge[] = []) => dispatch({ type: "add-nodes", nodes, edges }), [dispatch]);
  const editNodes = useCallback((before: MindmapNode[], after: MindmapNode[]) => dispatch({ type: "edit-nodes", before, after }), [dispatch]);
  const addEdge = useCallback((edge: MindmapEdge) => dispatch({ type: "add-edge", edge }), [dispatch]);
  const editEdge = useCallback((before: MindmapEdge, after: MindmapEdge) => dispatch({ type: "edit-edge", before, after }), [dispatch]);
  const deleteEdge = useCallback((edge: MindmapEdge) => dispatch({ type: "delete-edge", edge }), [dispatch]);
  const reorderNodes = useCallback((newOrder: MindmapNode[]) => {
    const before = docRef.current?.nodes ?? [];
    dispatch({ type: "reorder-nodes", before, after: newOrder });
  }, [dispatch]);

  // Resolved against the CURRENT document rather than taking an edges argument, so callers can't
  // accidentally leave a connector behind by passing a stale list.
  const deleteNodes = useCallback(
    (nodes: MindmapNode[]) => {
      const current = docRef.current;
      if (!current) return;
      const ids = new Set(nodes.map((n) => n.id));
      // Captured now so undo can put each node back at its original z-position - see the
      // "add-nodes" command's own `indices` doc comment.
      const indices = nodes.map((n) => current.nodes.findIndex((c) => c.id === n.id));
      dispatch({ type: "delete-nodes", nodes, edges: edgesTouching(current.edges, ids), indices });
    },
    [dispatch]
  );

  const editDetails = useCallback(
    (name: string, description: string) => {
      const current = docRef.current;
      if (!current) return;
      if (current.name === name && current.description === description) return;
      dispatch({ type: "edit-doc", before: { name: current.name, description: current.description }, after: { name, description } });
    },
    [dispatch]
  );

  // Grid visibility/snapping are view preferences, not roadmap content - saved with the document but
  // never undo-tracked, same treatment the whiteboard gives its own two.
  const setShowGrid = useCallback(
    (show: boolean) => {
      setDoc((prev) => (prev ? { ...prev, showGrid: show } : prev));
      scheduleAutosave();
    },
    [scheduleAutosave]
  );
  const setSnapToGrid = useCallback(
    (snap: boolean) => {
      setDoc((prev) => (prev ? { ...prev, snapToGrid: snap } : prev));
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const undo = useCallback(() => {
    setUndoStack((prevUndo) => {
      if (prevUndo.length === 0) return prevUndo;
      const command = prevUndo[prevUndo.length - 1];
      setDoc((prev) => (prev ? { ...applyMindmapCommand(prev, invertMindmapCommand(command)), updatedAt: new Date().toISOString() } : prev));
      setRedoStack((prevRedo) => [...prevRedo, command]);
      scheduleAutosave();
      return prevUndo.slice(0, -1);
    });
  }, [scheduleAutosave]);

  const redo = useCallback(() => {
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;
      const command = prevRedo[prevRedo.length - 1];
      setDoc((prev) => (prev ? { ...applyMindmapCommand(prev, command), updatedAt: new Date().toISOString() } : prev));
      setUndoStack((prevUndo) => [...prevUndo, command]);
      scheduleAutosave();
      return prevRedo.slice(0, -1);
    });
  }, [scheduleAutosave]);

  return {
    doc,
    loading,
    loadError,
    addNodes,
    editNodes,
    deleteNodes,
    addEdge,
    editEdge,
    deleteEdge,
    reorderNodes,
    editDetails,
    setShowGrid,
    setSnapToGrid,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    isSaving,
    saveError,
    flushSave,
  };
}
