// hooks/useWhiteboardStore.ts
//
// Mirrors useBoardStore.ts's shape (load-on-mount, debounced autosave, undo/redo command stack)
// but keyed by whiteboardId and talking to services/whiteboards.rs instead of boards.rs, PLUS a
// page dimension Board has no equivalent of: every node/edge mutator below applies to whichever
// WhiteboardPage is currently active (doc.activePageId), never the whole document - see
// whiteboardTypes.ts's WhiteboardPage doc comment for why a whiteboard is a set of independent
// pages rather than one flat nodes/edges pair.
//
// Undo/redo is deliberately PER PAGE, not one global stack across the whole document: switching
// pages (setActivePage) resets both stacks. This keeps every mutator's "which page does this
// command apply to" question trivially answerable (always "whichever page is active right now" -
// commands never need to carry a pageId of their own) at the cost of not being able to undo a
// page-2 edit after switching back to page 1 - a reasonable trade for a canvas-per-page tool where
// cross-page undo is rarely what anyone actually wants anyway.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WhiteboardCommand, WhiteboardDocument, WhiteboardEdge, WhiteboardNode, WhiteboardPage, createEmptyWhiteboardPage } from "../utils/whiteboardTypes";
import { applyCommand, invertCommand, undoDeleteNode } from "../handlers/whiteboardHandlers";

const AUTOSAVE_DEBOUNCE_MS = 800;

export interface UseWhiteboardStoreResult {
  doc: WhiteboardDocument | null;
  // The page currently being edited/viewed (doc.pages.find(p => p.id === doc.activePageId)) -
  // every mutator below reads/writes this page. Never null once doc has loaded (load always
  // ensures activePageId points at a real page - see the load effect and migrateDocument below).
  activePage: WhiteboardPage | null;
  loading: boolean;
  loadError: string | null;
  addNode: (node: WhiteboardNode) => void;
  // Adds a node and one edge connecting it to an existing node, as a single undo step - the
  // hover-arrow "quick clone + connect" gesture (see WhiteboardCanvas.tsx's HoverConnectArrows).
  addNodeWithEdge: (node: WhiteboardNode, edge: WhiteboardEdge) => void;
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
  // ---- Pages - none of these are undo-tracked (same reasoning as renameWhiteboard: page
  // structure is workspace organization, not diagram content you'd expect Ctrl+Z to touch).
  addPage: () => void;
  renamePage: (pageId: string, name: string) => void;
  // Refuses to delete the whiteboard's last remaining page - every whiteboard always has at least
  // one page, same invariant a spreadsheet enforces on its last sheet tab.
  deletePage: (pageId: string) => void;
  duplicatePage: (pageId: string) => void;
  reorderPages: (newOrder: WhiteboardPage[]) => void;
  // Switches which page is active - resets undo/redo (see this file's own top comment) and, when
  // switching away from an empty untitled page created by mistake, does nothing special; that
  // cleanup is left to the user via deletePage.
  setActivePage: (pageId: string) => void;
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

// An edge saved before arrowhead types existed (still-earlier version of this feature) carries
// boolean `startArrow`/`endArrow` instead of `startArrowType`/`endArrowType` - translate those in
// place (true -> "triangle", the only style that boolean era ever drew; false/absent -> "none").
// `raw: any` deliberately, same reasoning as migrateDocument's own doc comment below.
function migrateEdge(raw: any): any {
  if (raw.startArrowType !== undefined && raw.endArrowType !== undefined) return raw;
  const { startArrow, endArrow, ...rest } = raw;
  return {
    ...rest,
    startArrowType: raw.startArrowType ?? (startArrow ? "triangle" : "none"),
    endArrowType: raw.endArrowType ?? (endArrow ? "triangle" : "none"),
  };
}

// Normalizes a just-loaded document into the current shape - a whiteboard saved before pages
// existed (WHITEBOARD_SCHEMA_VERSION 1) has top-level `nodes`/`edges` instead of
// `pages`/`activePageId`; wrap those into a single page so every consumer past this point can
// assume `pages`/`activePageId` always exist. Every page's edges also get migrateEdge applied
// (see its own doc comment) regardless of whether the page structure itself is old or current,
// since the two migrations happened at different times and are independent of each other. Untyped
// `raw: any` deliberately - this is the one place on-disk data may not yet match
// WhiteboardDocument's current shape, same convention useBoardStore.ts's load effect uses for its
// own pre-BoardText normalization.
function migrateDocument(raw: any): WhiteboardDocument {
  const pages: WhiteboardPage[] =
    Array.isArray(raw.pages) && raw.pages.length > 0
      ? raw.pages
      : [{ ...createEmptyWhiteboardPage(crypto.randomUUID(), "Page 1"), nodes: raw.nodes ?? [], edges: raw.edges ?? [] }];
  const migratedPages = pages.map((page: any) => ({ ...page, edges: (page.edges ?? []).map(migrateEdge) }));
  const activePageId = raw.activePageId ?? migratedPages[0].id;
  return { showGrid: true, ...raw, pages: migratedPages, activePageId };
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
        setDoc(migrateDocument(JSON.parse(json)));
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

  // Applies `fn` to whichever page is currently active, leaving every other page untouched -
  // every node/edge command below goes through this. Bumps the document's own updatedAt (not each
  // page's - pages don't carry their own timestamp, only the document does) so "last edited" on
  // the home grid reflects an edit made on any page.
  const updateActivePage = useCallback((fn: (page: WhiteboardPage) => WhiteboardPage) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const pages = prev.pages.map((p) => (p.id === prev.activePageId ? fn(p) : p));
      return { ...prev, pages, updatedAt: new Date().toISOString() };
    });
  }, []);

  const dispatch = useCallback(
    (command: WhiteboardCommand) => {
      updateActivePage((page) => applyCommand(page, command));
      setUndoStack((prev) => [...prev, command]);
      setRedoStack([]);
      scheduleAutosave();
    },
    [updateActivePage, scheduleAutosave]
  );

  const activePage = doc ? doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0] ?? null : null;

  const addNode = useCallback((node: WhiteboardNode) => dispatch({ type: "add-node", item: node }), [dispatch]);

  const addNodeWithEdge = useCallback((node: WhiteboardNode, edge: WhiteboardEdge) => dispatch({ type: "add-node-with-edge", node, edge }), [dispatch]);

  const editNode = useCallback(
    (before: WhiteboardNode, after: WhiteboardNode) => {
      if (before.id !== after.id) return;
      dispatch({ type: "edit-node", before, after });
    },
    [dispatch]
  );

  const deleteNode = useCallback(
    (node: WhiteboardNode) => {
      const page = docRef.current?.pages.find((p) => p.id === docRef.current!.activePageId);
      const edges = page ? page.edges.filter((e) => e.source.nodeId === node.id || e.target.nodeId === node.id) : [];
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
      const page = docRef.current?.pages.find((p) => p.id === docRef.current!.activePageId);
      if (!page) return;
      dispatch({ type: "reorder-nodes", before: page.nodes, after: newOrder });
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

  const addPage = useCallback(() => {
    setDoc((prev) => {
      if (!prev) return prev;
      const page = createEmptyWhiteboardPage(crypto.randomUUID(), `Page ${prev.pages.length + 1}`);
      return { ...prev, pages: [...prev.pages, page], activePageId: page.id, updatedAt: new Date().toISOString() };
    });
    setUndoStack([]);
    setRedoStack([]);
    scheduleAutosave();
  }, [scheduleAutosave]);

  const renamePage = useCallback(
    (pageId: string, name: string) => {
      setDoc((prev) => (prev ? { ...prev, pages: prev.pages.map((p) => (p.id === pageId ? { ...p, name } : p)), updatedAt: new Date().toISOString() } : prev));
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const deletePage = useCallback(
    (pageId: string) => {
      setDoc((prev) => {
        if (!prev || prev.pages.length <= 1) return prev;
        const pages = prev.pages.filter((p) => p.id !== pageId);
        const activePageId = prev.activePageId === pageId ? pages[0].id : prev.activePageId;
        return { ...prev, pages, activePageId, updatedAt: new Date().toISOString() };
      });
      setUndoStack([]);
      setRedoStack([]);
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const duplicatePage = useCallback(
    (pageId: string) => {
      setDoc((prev) => {
        if (!prev) return prev;
        const source = prev.pages.find((p) => p.id === pageId);
        if (!source) return prev;
        const idMap = new Map<string, string>();
        const nodes = source.nodes.map((n) => {
          const newId = crypto.randomUUID();
          idMap.set(n.id, newId);
          return { ...n, id: newId };
        });
        const edges = source.edges.map((e) => ({
          ...e,
          id: crypto.randomUUID(),
          source: e.source.nodeId ? { ...e.source, nodeId: idMap.get(e.source.nodeId) } : e.source,
          target: e.target.nodeId ? { ...e.target, nodeId: idMap.get(e.target.nodeId) } : e.target,
        }));
        const copy: WhiteboardPage = { id: crypto.randomUUID(), name: `${source.name} copy`, nodes, edges };
        const sourceIndex = prev.pages.findIndex((p) => p.id === pageId);
        const pages = [...prev.pages.slice(0, sourceIndex + 1), copy, ...prev.pages.slice(sourceIndex + 1)];
        return { ...prev, pages, activePageId: copy.id, updatedAt: new Date().toISOString() };
      });
      setUndoStack([]);
      setRedoStack([]);
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const reorderPages = useCallback(
    (newOrder: WhiteboardPage[]) => {
      setDoc((prev) => (prev ? { ...prev, pages: newOrder, updatedAt: new Date().toISOString() } : prev));
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const setActivePage = useCallback(
    (pageId: string) => {
      setDoc((prev) => (prev && prev.activePageId !== pageId ? { ...prev, activePageId: pageId } : prev));
      setUndoStack([]);
      setRedoStack([]);
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const undo = useCallback(() => {
    setUndoStack((prevUndo) => {
      if (prevUndo.length === 0) return prevUndo;
      const command = prevUndo[prevUndo.length - 1];
      // delete-node's inverse needs to restore both the node and every edge it cascaded away -
      // more than invertCommand's return type alone can express (see its own doc comment on this
      // case), so this one command type is undone directly rather than via applyCommand+invertCommand.
      if (command.type === "delete-node") updateActivePage((page) => undoDeleteNode(page, command));
      else updateActivePage((page) => applyCommand(page, invertCommand(command)));
      setRedoStack((prevRedo) => [...prevRedo, command]);
      scheduleAutosave();
      return prevUndo.slice(0, -1);
    });
  }, [updateActivePage, scheduleAutosave]);

  const redo = useCallback(() => {
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;
      const command = prevRedo[prevRedo.length - 1];
      // Forward direction never needs special-casing - applyCommand's "delete-node" branch already
      // removes both the node and its cascade-listed edges in one go.
      updateActivePage((page) => applyCommand(page, command));
      setUndoStack((prevUndo) => [...prevUndo, command]);
      scheduleAutosave();
      return prevRedo.slice(0, -1);
    });
  }, [updateActivePage, scheduleAutosave]);

  return {
    doc,
    activePage,
    loading,
    loadError,
    addNode,
    addNodeWithEdge,
    editNode,
    deleteNode,
    batchEditNodes,
    addEdge,
    editEdge,
    deleteEdge,
    reorderNodes,
    setShowGrid,
    renameWhiteboard,
    addPage,
    renamePage,
    deletePage,
    duplicatePage,
    reorderPages,
    setActivePage,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    isSaving,
    saveError,
    flushSave,
  };
}
