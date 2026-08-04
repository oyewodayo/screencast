// hooks/useImageEditStore.ts
//
// Mirrors useAnnotationStore.ts (the PDF sidecar/undo-redo/autosave hook) closely - same
// load-or-create-on-mount, debounced-autosave, command-stack shape - adapted for a single working
// image instead of a multi-page document. See imageEditTypes.ts/imageEditHandlers.ts for the
// object/command model this operates on.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import {
  GeometrySnapshot,
  ImageAdjustments,
  ImageAnnotationObject,
  ImageEditCommand,
  ImageEditDocument,
  NEUTRAL_ADJUSTMENTS,
  createEmptyDocument,
} from "../utils/imageEditTypes";
import { applyCommand, invertCommand } from "../handlers/imageEditHandlers";
import { preloadImage } from "../utils/imageObjectCache";

const AUTOSAVE_DEBOUNCE_MS = 800;

export interface UseImageEditStoreResult {
  doc: ImageEditDocument | null;
  loading: boolean;
  loadError: string | null;
  // The source to decode/draw right now - the sidecar's own baked bitmap once a geometry op has
  // run, otherwise the original file on disk (assetSrc), so a plain view-and-annotate session
  // never has to base64-encode the whole photo into a sidecar.
  baseImageSrc: string;
  addObject: (object: ImageAnnotationObject) => void;
  editObject: (before: ImageAnnotationObject, after: ImageAnnotationObject) => void;
  deleteObject: (object: ImageAnnotationObject) => void;
  // Replaces several objects at once as a single undo step - e.g. "Arrange as grid". `before`
  // and `after` must be the same objects (matched by id, same array order) before/after whatever
  // batch transform produced `after`.
  batchEditObjects: (before: ImageAnnotationObject[], after: ImageAnnotationObject[]) => void;
  // Full replacement order for the whole objects array - the collage docker's drag-to-reorder.
  reorderObjects: (newOrder: ImageAnnotationObject[]) => void;
  commitAdjustments: (next: ImageAdjustments) => void;
  // `beforeImageDataUrl` is a snapshot of the fully composed canvas (base + adjustments + every
  // object) taken by the caller immediately before applying the rotate/flip/crop transform - see
  // GeometrySnapshot's own doc comment for why undo needs a concrete bitmap here even though the
  // *document's* baseImageOverride may still be undefined at this point.
  commitGeometry: (beforeImageDataUrl: string, afterImageDataUrl: string, afterWidth: number, afterHeight: number) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isSaving: boolean;
  saveError: string | null;
}

export default function useImageEditStore(sourcePath: string | undefined, assetSrc: string | undefined): UseImageEditStoreResult {
  const [doc, setDoc] = useState<ImageEditDocument | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<ImageEditCommand[]>([]);
  const [redoStack, setRedoStack] = useState<ImageEditCommand[]>([]);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const docRef = useRef<ImageEditDocument | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  useEffect(() => {
    if (!sourcePath || !assetSrc) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setLoadError(null);
      setUndoStack([]);
      setRedoStack([]);
      try {
        const json = await invoke<string | null>("load_image_annotations", { imagePath: sourcePath });
        if (cancelled) return;
        if (json) {
          setDoc(JSON.parse(json));
          return;
        }
        const img = await preloadImage(assetSrc);
        if (cancelled) return;
        setDoc(createEmptyDocument(img.naturalWidth, img.naturalHeight));
      } catch (err) {
        console.error("Failed to load image edits:", err);
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        try {
          const img = await preloadImage(assetSrc);
          if (!cancelled) setDoc(createEmptyDocument(img.naturalWidth, img.naturalHeight));
        } catch (decodeErr) {
          console.error("Failed to decode image after edit-load failure:", decodeErr);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sourcePath, assetSrc]);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const current = docRef.current;
    if (!sourcePath || !current) return;
    setIsSaving(true);
    invoke("save_image_annotations", { imagePath: sourcePath, json: JSON.stringify(current) })
      .then(() => {
        setIsSaving(false);
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

  // Flush any pending save when switching files or unmounting so trailing edits aren't lost.
  useEffect(() => {
    return () => flushSave();
  }, [sourcePath, flushSave]);

  const dispatch = useCallback(
    (command: ImageEditCommand) => {
      setDoc((prev) => (prev ? applyCommand(prev, command) : prev));
      setUndoStack((prev) => [...prev, command]);
      setRedoStack([]);
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const addObject = useCallback((object: ImageAnnotationObject) => dispatch({ type: "add", object }), [dispatch]);
  const deleteObject = useCallback((object: ImageAnnotationObject) => dispatch({ type: "delete", object }), [dispatch]);
  const editObject = useCallback(
    (before: ImageAnnotationObject, after: ImageAnnotationObject) => {
      if (before.id !== after.id) return;
      dispatch({ type: "edit", before, after });
    },
    [dispatch]
  );

  const batchEditObjects = useCallback(
    (before: ImageAnnotationObject[], after: ImageAnnotationObject[]) => {
      if (before.length === 0 || after.length === 0) return;
      dispatch({ type: "batch-edit", before, after });
    },
    [dispatch]
  );

  const reorderObjects = useCallback(
    (newOrder: ImageAnnotationObject[]) => {
      const current = docRef.current;
      if (!current) return;
      dispatch({ type: "reorder", before: current.objects, after: newOrder });
    },
    [dispatch]
  );

  const commitAdjustments = useCallback(
    (next: ImageAdjustments) => {
      const current = docRef.current;
      if (!current) return;
      const before = current.adjustments;
      if (before.brightness === next.brightness && before.contrast === next.contrast && before.saturation === next.saturation) return;
      dispatch({ type: "adjustments", before, after: next });
    },
    [dispatch]
  );

  const commitGeometry = useCallback(
    (beforeImageDataUrl: string, afterImageDataUrl: string, afterWidth: number, afterHeight: number) => {
      const current = docRef.current;
      if (!current) return;
      const before: GeometrySnapshot = {
        baseImageOverride: beforeImageDataUrl,
        baseWidth: current.baseWidth,
        baseHeight: current.baseHeight,
        adjustments: current.adjustments,
        objects: current.objects,
      };
      const after: GeometrySnapshot = {
        baseImageOverride: afterImageDataUrl,
        baseWidth: afterWidth,
        baseHeight: afterHeight,
        adjustments: { ...NEUTRAL_ADJUSTMENTS },
        objects: [],
      };
      dispatch({ type: "geometry", before, after });
    },
    [dispatch]
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
    baseImageSrc: doc?.baseImageOverride ?? assetSrc ?? "",
    addObject,
    editObject,
    deleteObject,
    batchEditObjects,
    reorderObjects,
    commitAdjustments,
    commitGeometry,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    isSaving,
    saveError,
  };
}
