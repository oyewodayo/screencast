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
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import * as Y from "yjs";
import { DocComment, DocPageSize, DocVersionSummary } from "../utils/docTypes";
import { extractPlainText } from "../utils/docYjsText";
const appWindow = getCurrentWebviewWindow()

const AUTOSAVE_DEBOUNCE_MS = 800;
// Confirmed with the user: a periodic snapshot every ~10 minutes while a doc is actively being
// edited (only if something changed since the last one - see dirtySinceVersionRef), plus one more
// whenever a doc is opened (see loadDoc's own snapshot call) - covers both "undo a mistake from a
// few minutes ago" and "go back to yesterday's version" without any manual action. Retention (last
// 20 per doc) is enforced server-side, in docs.rs's write_version.
const VERSION_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

interface LoadedDoc {
  bytes: number[];
  title: string;
  created_at: string;
  updated_at: string;
  linked_to: string | null;
  page_size: DocPageSize | null;
  header_text: string | null;
  footer_text: string | null;
}

interface DocPageSetupResult {
  page_size: DocPageSize | null;
  header_text: string | null;
  footer_text: string | null;
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
  // navigating back to Docs Home (fire-and-forget there), and the save-on-quit effect below
  // awaits it before letting the app window actually close.
  flushSave: () => Promise<void>;
  // The recording/file this doc is "notes for", if any - see services/docs.rs's link_doc_to_file.
  // Written straight through to Rust, not routed through the debounced save_doc path, since it's a
  // meta-only field independent of the Yjs byte snapshot.
  linkedTo: string | null;
  linkDoc: (filePath: string) => Promise<void>;
  unlinkDoc: () => Promise<void>;
  // Version history - see docs.rs's "Version history" section for the storage/retention side.
  versions: DocVersionSummary[];
  refreshVersions: () => void;
  restoreVersion: (versionId: string) => Promise<void>;
  // Comments - see docs.rs's "Comments" section. markId is the id shared between a DocComment
  // record and the live `comment` mark (docCommentMark.ts) anchoring it.
  comments: DocComment[];
  refreshComments: () => void;
  addComment: (markId: string, text: string) => Promise<DocComment | null>;
  resolveComment: (commentId: string) => Promise<void>;
  reopenComment: (commentId: string) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
  // Page setup - see docs.rs's set_doc_page_setup. Meta-only, like linkedTo, written straight
  // through rather than routed through the debounced save_doc path.
  pageSize: DocPageSize | null;
  headerText: string | null;
  footerText: string | null;
  setPageSetup: (pageSize: DocPageSize | null, headerText: string | null, footerText: string | null) => Promise<void>;
}

export default function useDocsEditStore(docId: string | undefined): UseDocsEditStoreResult {
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [title, setTitleState] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [linkedTo, setLinkedTo] = useState<string | null>(null);
  const [versions, setVersions] = useState<DocVersionSummary[]>([]);
  const [comments, setComments] = useState<DocComment[]>([]);
  const [pageSize, setPageSizeState] = useState<DocPageSize | null>(null);
  const [headerText, setHeaderTextState] = useState<string | null>(null);
  const [footerText, setFooterTextState] = useState<string | null>(null);

  const ydocRef = useRef<Y.Doc | null>(null);
  const titleRef = useRef<string>("");
  const docIdRef = useRef<string | undefined>(docId);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once the open Y.Doc has changed since the last version snapshot (on-open or periodic) -
  // separate from the autosave path entirely, since autosave's own "is there anything pending"
  // state (saveTimerRef) resets every 800ms regardless of version-snapshot cadence.
  const dirtySinceVersionRef = useRef(false);
  // Bumped on every loadDoc() call (initial load, doc switch, or a restore's own reload) so a
  // load that's been superseded by a newer one can detect that and bail before touching state,
  // replacing the single effect-scoped `cancelled` flag this used to rely on - loadDoc is now
  // called from more than one place, so that flag couldn't be scoped to just the docId effect
  // anymore.
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const current = ydocRef.current;
    const id = docIdRef.current;
    if (!id || !current) return;
    // Snapshot synchronously, before any await - a caller (docId-change effect below) may
    // destroy ydocRef.current right after calling this, so the bytes must be captured now.
    const bytes = Array.from(Y.encodeStateAsUpdate(current));
    setIsSaving(true);
    try {
      await invoke("save_doc", { id, bytes, title: titleRef.current });
      setIsSaving(false);
      setSaveError(null);
      // Keeps docs_search.rs's FTS5 index fresh on every autosave - fire-and-forget, a search
      // index lagging slightly behind an in-flight edit isn't worth surfacing as a save error.
      const body = extractPlainText(current.getXmlFragment("default"));
      invoke("index_doc_content", { id, title: titleRef.current, body }).catch((err) =>
        console.error("Failed to update search index:", err)
      );
    } catch (err) {
      setIsSaving(false);
      setSaveError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  const scheduleAutosave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Save-on-quit: this hook only exists while a doc is actually open (DocsEditor is mounted),
  // so registering here - rather than app-wide - automatically scopes the guard to "only when
  // there's something to save"; closing from DocsHome or anywhere else is unaffected.
  useEffect(() => {
    let ownClose = false; // true once *we* called appWindow.close() - let that one through untouched
    let pendingClose: Promise<void> | null = null; // dedupes a rapid double-click on the close button

    const unlistenPromise = appWindow.onCloseRequested(async (event) => {
      if (ownClose) return;
      event.preventDefault();
      if (!pendingClose) {
        pendingClose = flushSave()
          .catch((err) => {
            // A save failure must never trap the user in an unclosable app - log and quit anyway.
            console.error("Failed to save on quit:", err);
          })
          .then(() => {
            ownClose = true;
            return appWindow.close();
          });
      }
      await pendingClose;
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [flushSave]);

  const refreshVersions = useCallback((idOverride?: string) => {
    const id = idOverride ?? docIdRef.current;
    if (!id) return;
    invoke<DocVersionSummary[]>("list_doc_versions", { id })
      .then(setVersions)
      .catch((err) => console.error("Failed to list document versions:", err));
  }, []);

  const refreshComments = useCallback((idOverride?: string) => {
    const id = idOverride ?? docIdRef.current;
    if (!id) return;
    invoke<DocComment[]>("list_doc_comments", { id })
      .then(setComments)
      .catch((err) => console.error("Failed to list document comments:", err));
  }, []);

  // (Re)loads docIdRef.current's content from disk into a fresh Y.Doc, replacing whatever was
  // there. Used both by the docId-change effect below (a normal doc switch/first open) and by
  // restoreVersion (reloading in place after the backend has overwritten doc.bin with an older
  // version) - factored out specifically so those two callers don't duplicate this. Superseded
  // loads (a newer loadDoc() call started before this one's invoke() resolved) detect that via
  // loadGenerationRef and bail without touching state, replacing the old effect-scoped `cancelled`
  // flag, which couldn't be shared across more than one call site.
  const loadDoc = useCallback(async () => {
    const id = docIdRef.current;
    if (!id) return;
    const generation = ++loadGenerationRef.current;

    ydocRef.current?.destroy();
    ydocRef.current = null;
    setYdoc(null);
    setLoading(true);
    setLoadError(null);

    try {
      const result = await invoke<LoadedDoc>("load_doc", { id });
      if (loadGenerationRef.current !== generation) return;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(result.bytes));
      // Fires on every change to the doc, local edits included - the same signal a future
      // real-time provider's incoming remote updates would also flow through.
      doc.on("update", () => {
        dirtySinceVersionRef.current = true;
        scheduleAutosave();
      });
      ydocRef.current = doc;
      setTitleState(result.title);
      titleRef.current = result.title;
      setLinkedTo(result.linked_to);
      setPageSizeState(result.page_size);
      setHeaderTextState(result.header_text);
      setFooterTextState(result.footer_text);
      setYdoc(doc);
      refreshComments(id);

      // On-open snapshot - docs.rs's write_version dedups against the latest existing version, so
      // this is a no-op on disk (and in the returned list) if nothing changed since the last one.
      dirtySinceVersionRef.current = false;
      invoke("create_doc_version", { id, bytes: result.bytes })
        .then(() => refreshVersions(id))
        .catch((err) => console.error("Failed to snapshot document version on open:", err));

      // On-open reindex - the other half of keeping docs_search.rs's FTS5 index current (the
      // autosave path in flushSave is the other), and also what backfills a doc that predates the
      // index or was just restored from trash (DocsHome.tsx's own lazy backfill pass would
      // otherwise be the only thing to pick it up).
      invoke("index_doc_content", { id, title: result.title, body: extractPlainText(doc.getXmlFragment("default")) }).catch((err) =>
        console.error("Failed to update search index on open:", err)
      );
    } catch (err) {
      console.error("Failed to load document:", err);
      if (loadGenerationRef.current === generation) setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (loadGenerationRef.current === generation) setLoading(false);
    }
  }, [scheduleAutosave, refreshVersions, refreshComments]);

  useEffect(() => {
    docIdRef.current = docId;
    if (!docId) return;

    // Switching documents (or first open) - flush whatever the previous Y.Doc had pending before
    // loadDoc() destroys it. Safe to call even on first mount, when ydocRef is still null.
    // flushSave() now throws on failure (so the save-on-quit handler above can catch it) - this
    // fire-and-forget call needs its own catch or a failed autosave-on-navigate produces an
    // unhandled promise rejection.
    flushSave().catch((err) => console.error("Failed to save while switching documents:", err));
    void loadDoc();
  }, [docId, flushSave, loadDoc]);

  // Periodic version snapshot while a doc is open - re-armed whenever `ydoc` itself changes
  // (a real doc switch, or restoreVersion's own reload), which conveniently also means a doc with
  // no edits since it was opened never even starts a wasted timer render-over-render.
  useEffect(() => {
    if (!ydoc) return;
    const interval = setInterval(() => {
      if (!dirtySinceVersionRef.current) return;
      const id = docIdRef.current;
      if (!id) return;
      const bytes = Array.from(Y.encodeStateAsUpdate(ydoc));
      dirtySinceVersionRef.current = false;
      invoke("create_doc_version", { id, bytes })
        .then(() => refreshVersions(id))
        .catch((err) => console.error("Failed to snapshot document version:", err));
    }, VERSION_SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [ydoc, refreshVersions]);

  const restoreVersion = useCallback(
    async (versionId: string) => {
      const id = docIdRef.current;
      if (!id) return;
      // Cancel (don't flush) any pending autosave - those in-memory bytes are about to be
      // discarded wholesale by loadDoc()'s reload below, and flushing them first would just
      // immediately get overwritten by restore_doc_version's own write to doc.bin anyway.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      await invoke("restore_doc_version", { id, versionId });
      await loadDoc();
    },
    [loadDoc]
  );

  // Final flush + teardown on unmount (the docId-change branch above already handles the
  // switching-documents case).
  useEffect(() => {
    return () => {
      flushSave().catch((err) => console.error("Failed to save on unmount:", err));
      ydocRef.current?.destroy();
      ydocRef.current = null;
      // Bumping the generation here (not just on the next loadDoc() call) is what makes an
      // in-flight load's own `if (loadGenerationRef.current !== generation) return` catch a true
      // unmount too, not just "superseded by a newer load" - without this, a load() started right
      // before navigating away from a doc would still call setState after unmount once its
      // invoke() resolved.
      loadGenerationRef.current++;
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
    try {
      const result = await invoke<DocSummaryResult>("link_doc_to_file", { id, filePath });
      setLinkedTo(result.linked_to);
    } catch (err) {
      // Call sites use `void store.linkDoc(...)` (no .catch of their own), so a failure here
      // must not become an unhandled rejection.
      console.error("Failed to link document:", err);
    }
  }, []);

  const addComment = useCallback(async (markId: string, text: string): Promise<DocComment | null> => {
    const id = docIdRef.current;
    if (!id) return null;
    try {
      const comment = await invoke<DocComment>("add_doc_comment", { id, commentId: markId, markId, text });
      setComments((prev) => [...prev, comment]);
      return comment;
    } catch (err) {
      console.error("Failed to add comment:", err);
      return null;
    }
  }, []);

  const resolveComment = useCallback(async (commentId: string) => {
    const id = docIdRef.current;
    if (!id) return;
    try {
      const updated = await invoke<DocComment>("resolve_doc_comment", { id, commentId });
      setComments((prev) => prev.map((c) => (c.id === commentId ? updated : c)));
    } catch (err) {
      console.error("Failed to resolve comment:", err);
    }
  }, []);

  const reopenComment = useCallback(async (commentId: string) => {
    const id = docIdRef.current;
    if (!id) return;
    try {
      const updated = await invoke<DocComment>("reopen_doc_comment", { id, commentId });
      setComments((prev) => prev.map((c) => (c.id === commentId ? updated : c)));
    } catch (err) {
      console.error("Failed to reopen comment:", err);
    }
  }, []);

  const deleteComment = useCallback(async (commentId: string) => {
    const id = docIdRef.current;
    if (!id) return;
    try {
      await invoke("delete_doc_comment", { id, commentId });
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      console.error("Failed to delete comment:", err);
    }
  }, []);

  const setPageSetup = useCallback(async (nextPageSize: DocPageSize | null, nextHeaderText: string | null, nextFooterText: string | null) => {
    const id = docIdRef.current;
    if (!id) return;
    try {
      const result = await invoke<DocPageSetupResult>("set_doc_page_setup", {
        id,
        pageSize: nextPageSize,
        headerText: nextHeaderText,
        footerText: nextFooterText,
      });
      setPageSizeState(result.page_size);
      setHeaderTextState(result.header_text);
      setFooterTextState(result.footer_text);
    } catch (err) {
      console.error("Failed to update page setup:", err);
    }
  }, []);

  const unlinkDoc = useCallback(async () => {
    const id = docIdRef.current;
    if (!id) return;
    try {
      const result = await invoke<DocSummaryResult>("unlink_doc", { id });
      setLinkedTo(result.linked_to);
    } catch (err) {
      console.error("Failed to unlink document:", err);
    }
  }, []);

  return {
    ydoc,
    title,
    setTitle,
    loading,
    loadError,
    isSaving,
    saveError,
    flushSave,
    linkedTo,
    linkDoc,
    unlinkDoc,
    versions,
    refreshVersions,
    restoreVersion,
    comments,
    refreshComments,
    addComment,
    resolveComment,
    reopenComment,
    deleteComment,
    pageSize,
    headerText,
    footerText,
    setPageSetup,
  };
}
