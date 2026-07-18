// hooks/useAnnotationStore.ts
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import {
  AnnotationCommand,
  AnnotationObject,
  PdfAnnotationDocument,
  Pt,
  createEmptyDocument,
} from "../utils/pdfAnnotationTypes";
import { applyCommand, hitTestEraser, invertCommand } from "../handlers/pdfAnnotationHandlers";

const AUTOSAVE_DEBOUNCE_MS = 800;

interface UseAnnotationStoreResult {
  loading: boolean;
  loadError: string | null;
  getPageObjects: (pageIndex: number) => AnnotationObject[];
  addObject: (object: AnnotationObject) => void;
  beginErase: (pageIndex: number) => void;
  eraseAt: (pageIndex: number, point: Pt, radiusInPdfUnits: number) => void;
  endErase: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isSaving: boolean;
  lastSavedAt: number | null;
  saveError: string | null;
}

export default function useAnnotationStore(sourcePath: string | undefined): UseAnnotationStoreResult {
  const [doc, setDoc] = useState<PdfAnnotationDocument | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<AnnotationCommand[]>([]);
  const [redoStack, setRedoStack] = useState<AnnotationCommand[]>([]);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const docRef = useRef<PdfAnnotationDocument | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEraseRef = useRef<{ pageIndex: number; removed: AnnotationObject[] } | null>(null);

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  // Load (or initialize) the sidecar whenever the target PDF changes.
  useEffect(() => {
    if (!sourcePath) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setUndoStack([]);
    setRedoStack([]);

    invoke<string | null>("load_pdf_annotations", { pdfPath: sourcePath }).then(
      (json) => {
        if (cancelled) return;
        try {
          const loaded: PdfAnnotationDocument = json
            ? JSON.parse(json)
            : createEmptyDocument(sourcePath.split(/[\\/]/).pop() ?? sourcePath);
          setDoc(loaded);
        } catch (err) {
          console.error("Failed to parse PDF annotations:", err);
          setDoc(createEmptyDocument(sourcePath.split(/[\\/]/).pop() ?? sourcePath));
        }
        setLoading(false);
      },
      (err) => {
        if (cancelled) return;
        console.error("Failed to load PDF annotations:", err);
        setLoadError(err instanceof Error ? err.message : String(err));
        setDoc(createEmptyDocument(sourcePath.split(/[\\/]/).pop() ?? sourcePath));
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [sourcePath]);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const current = docRef.current;
    if (!sourcePath || !current) return;
    setIsSaving(true);
    invoke("save_pdf_annotations", { pdfPath: sourcePath, json: JSON.stringify(current) })
      .then(() => {
        setIsSaving(false);
        setLastSavedAt(Date.now());
        setSaveError(null);
      })
      .catch((err) => {
        setIsSaving(false);
        setSaveError(err instanceof Error ? err.message : String(err));
      });
  }, [sourcePath]);

  const scheduleAutosave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Flush any pending save when switching files or unmounting so trailing strokes aren't lost.
  useEffect(() => {
    return () => flushSave();
  }, [sourcePath, flushSave]);

  const getPageObjects = useCallback(
    (pageIndex: number): AnnotationObject[] => {
      return doc?.pages.find((p) => p.pageIndex === pageIndex)?.objects ?? [];
    },
    [doc]
  );

  const addObject = useCallback(
    (object: AnnotationObject) => {
      setDoc((prev) => (prev ? applyCommand(prev, { type: "add", object }) : prev));
      setUndoStack((prev) => [...prev, { type: "add", object }]);
      setRedoStack([]);
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const beginErase = useCallback((pageIndex: number) => {
    pendingEraseRef.current = { pageIndex, removed: [] };
  }, []);

  const eraseAt = useCallback(
    (pageIndex: number, point: Pt, radiusInPdfUnits: number) => {
      const current = docRef.current;
      if (!current) return;
      const pageObjects = current.pages.find((p) => p.pageIndex === pageIndex)?.objects ?? [];
      const hits = hitTestEraser(pageObjects, point, radiusInPdfUnits);
      if (hits.length === 0) return;

      if (pendingEraseRef.current && pendingEraseRef.current.pageIndex === pageIndex) {
        const alreadyRemoved = new Set(pendingEraseRef.current.removed.map((o) => o.id));
        for (const hit of hits) {
          if (!alreadyRemoved.has(hit.id)) pendingEraseRef.current.removed.push(hit);
        }
      }

      setDoc((prev) => (prev ? applyCommand(prev, { type: "erase", pageIndex, removed: hits }) : prev));
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const endErase = useCallback(() => {
    const pending = pendingEraseRef.current;
    pendingEraseRef.current = null;
    if (!pending || pending.removed.length === 0) return;
    setUndoStack((prev) => [...prev, { type: "erase", pageIndex: pending.pageIndex, removed: pending.removed }]);
    setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    setUndoStack((prevUndo) => {
      if (prevUndo.length === 0) return prevUndo;
      const command = prevUndo[prevUndo.length - 1];

      if (command.type === "add") {
        setDoc((prev) => (prev ? applyCommand(prev, invertCommand(command)) : prev));
      } else {
        // Re-add every object the erase removed.
        setDoc((prev) => {
          if (!prev) return prev;
          let next = prev;
          for (const object of command.removed) {
            next = applyCommand(next, { type: "add", object });
          }
          return next;
        });
      }

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
    loading,
    loadError,
    getPageObjects,
    addObject,
    beginErase,
    eraseAt,
    endErase,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    isSaving,
    lastSavedAt,
    saveError,
  };
}
