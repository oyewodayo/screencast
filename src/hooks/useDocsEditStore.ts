// hooks/useDocsEditStore.ts
//
// Mirrors useBoardStore.ts's shape (load-on-mount, debounced autosave, flushSave) but keyed by
// docId and talking to services/docs.rs. One real difference from every other *EditStore hook in
// this codebase: the "document" here is a Y.Doc, a stateful object with its own event emitter that
// Tiptap's Collaboration extension binds to by instance at useEditor construction time - so unlike
// useBoardStore's plain `doc` React state, the Y.Doc must be a *stable reference* across re-renders
// for a given docId, only created/destroyed when docId itself changes. Content changes therefore
// aren't tracked via a command-stack `dispatch` the way Board's undo/redo is - Yjs's own "update"
// event is the single change signal, which also happens to be exactly the hook a future real-time
// sync provider would tap into, so no rework is needed when that phase arrives.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import * as Y from "yjs";

const AUTOSAVE_DEBOUNCE_MS = 800;

interface LoadedDoc {
  bytes: number[];
  title: string;
  created_at: string;
  updated_at: string;
  linked_to: string | null;
}

interface DocSummaryResult {
  linked_to: string | null;
}

export interface UseDocsEditStoreResult {
  ydoc: Y.Doc | null;
  title: string;
  setTitle: (title: string) => void;
  loading: boolean;
  loadError: string | null;
  isSaving: boolean;
  saveError: string | null;
  // Forces any pending debounced save to write immediately - DocsEditor calls this before
  // navigating back to Docs Home, same reasoning as BoardEditor's own flushSave call.
  flushSave: () => void;
  // The recording/file this doc is "notes for", if any - see services/docs.rs's link_doc_to_file.
  // Written straight through to Rust, not routed through the debounced save_doc path, since it's a
  // meta-only field independent of the Yjs byte snapshot.
  linkedTo: string | null;
  linkDoc: (filePath: string) => Promise<void>;
  unlinkDoc: () => Promise<void>;
}

export default function useDocsEditStore(docId: string | undefined): UseDocsEditStoreResult {
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [title, setTitleState] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [linkedTo, setLinkedTo] = useState<string | null>(null);

  const ydocRef = useRef<Y.Doc | null>(null);
  const titleRef = useRef<string>("");
  const docIdRef = useRef<string | undefined>(docId);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const current = ydocRef.current;
    const id = docIdRef.current;
    if (!id || !current) return;
    setIsSaving(true);
    const bytes = Array.from(Y.encodeStateAsUpdate(current));
    invoke("save_doc", { id, bytes, title: titleRef.current })
      .then(() => {
        setIsSaving(false);
        setSaveError(null);
      })
      .catch((err) => {
        setIsSaving(false);
        setSaveError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const scheduleAutosave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  useEffect(() => {
    docIdRef.current = docId;
    if (!docId) return;
    let cancelled = false;

    // Switching documents (or unmounting) - flush whatever the previous Y.Doc had pending, then
    // release its internal observers. Safe to call even on first mount, when ydocRef is still null.
    flushSave();
    ydocRef.current?.destroy();
    ydocRef.current = null;
    setYdoc(null);
    setLoading(true);
    setLoadError(null);

    (async () => {
      try {
        const result = await invoke<LoadedDoc>("load_doc", { id: docId });
        if (cancelled) return;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, new Uint8Array(result.bytes));
        // Fires on every change to the doc, local edits included - the same signal a future
        // real-time provider's incoming remote updates would also flow through.
        doc.on("update", scheduleAutosave);
        ydocRef.current = doc;
        setTitleState(result.title);
        setLinkedTo(result.linked_to);
        setYdoc(doc);
      } catch (err) {
        console.error("Failed to load document:", err);
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Final flush + teardown on unmount (the docId-change branch above already handles the
  // switching-documents case).
  useEffect(() => {
    return () => {
      flushSave();
      ydocRef.current?.destroy();
      ydocRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTitle = useCallback(
    (next: string) => {
      setTitleState(next);
      titleRef.current = next;
      scheduleAutosave();
    },
    [scheduleAutosave]
  );

  const linkDoc = useCallback(async (filePath: string) => {
    const id = docIdRef.current;
    if (!id) return;
    const result = await invoke<DocSummaryResult>("link_doc_to_file", { id, filePath });
    setLinkedTo(result.linked_to);
  }, []);

  const unlinkDoc = useCallback(async () => {
    const id = docIdRef.current;
    if (!id) return;
    const result = await invoke<DocSummaryResult>("unlink_doc", { id });
    setLinkedTo(result.linked_to);
  }, []);

  return { ydoc, title, setTitle, loading, loadError, isSaving, saveError, flushSave, linkedTo, linkDoc, unlinkDoc };
}
