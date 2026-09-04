// components/docs/DocVersionHistoryPanel.tsx
//
// A modal overlay opened from DocsEditor.tsx's toolbar - lists every version_history.rs snapshot
// for the open doc, lets you preview one, and restore it. The preview is a genuine rendering of
// that version's content (headings, lists, tables, colors, images), not a flattened text dump: a
// version's raw Yjs bytes are decoded into a scratch Y.Doc, converted to ProseMirror JSON via
// y-prosemirror's yDocToProsemirrorJSON (the same library already used the other direction by
// docxImport.ts), and rendered through a second, read-only Tiptap instance sharing the exact same
// schema (getDocContentExtensions) and styling (docProseClassName) as the live editor.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import * as Y from "yjs";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { IoClose, IoTimeOutline } from "react-icons/io5";
import { DocVersionSummary } from "../../utils/docTypes";
import { getDocContentExtensions, docProseClassName } from "../../utils/docSchemaExtensions";

interface DocVersionHistoryPanelProps {
  docId: string;
  versions: DocVersionSummary[];
  onClose: () => void;
  onRestore: (versionId: string) => Promise<void>;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatAbsolute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

const DocVersionHistoryPanel: React.FC<DocVersionHistoryPanelProps> = ({ docId, versions, onClose, onRestore }) => {
  // Newest first is already how useDocsEditStore.ts's `versions` comes back from list_doc_versions
  // (docs.rs sorts descending), so no re-sort needed here.
  const [selectedId, setSelectedId] = useState<string | null>(versions[0]?.id ?? null);
  const [previewDoc, setPreviewDoc] = useState<{ versionId: string; json: JSONContent } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (selectedId === null && versions[0]) setSelectedId(versions[0].id);
  }, [versions, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    setConfirmRestore(false);

    invoke<number[]>("load_doc_version", { id: docId, versionId: selectedId })
      .then((bytes) => {
        if (cancelled) return;
        const tempDoc = new Y.Doc();
        try {
          Y.applyUpdate(tempDoc, new Uint8Array(bytes));
          const json = yDocToProsemirrorJSON(tempDoc, "default") as JSONContent;
          setPreviewDoc({ versionId: selectedId, json });
        } finally {
          tempDoc.destroy();
        }
      })
      .catch((err) => {
        console.error("Failed to load document version:", err);
        if (!cancelled) setPreviewError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [docId, selectedId]);

  const extensions = useMemo(() => getDocContentExtensions(), []);
  const previewEditor = useEditor(
    {
      extensions,
      editable: false,
      content: previewDoc?.json,
    },
    [previewDoc?.versionId]
  );

  const selectedVersion = versions.find((v) => v.id === selectedId) ?? null;

  const handleRestore = useCallback(async () => {
    if (!selectedId) return;
    setRestoring(true);
    try {
      await onRestore(selectedId);
      onClose();
    } catch (err) {
      console.error("Failed to restore document version:", err);
      setPreviewError(err instanceof Error ? err.message : String(err));
      setRestoring(false);
    }
  }, [selectedId, onRestore, onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 print:hidden" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col w-[90vw] max-w-4xl h-[80vh] bg-white dark:bg-neutral-900 rounded-xl shadow-2xl overflow-hidden"
      >
        <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <IoTimeOutline size={18} className="text-neutral-500 dark:text-neutral-400" />
          <h2 className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Version history</h2>
          <button
            type="button"
            title="Close"
            onClick={onClose}
            className="ml-auto p-1.5 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <IoClose size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="w-56 shrink-0 border-r border-neutral-200 dark:border-neutral-800 overflow-y-auto py-2">
            {versions.length === 0 ? (
              <p className="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-500">No versions yet</p>
            ) : (
              versions.map((v, index) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setSelectedId(v.id)}
                  className={`w-full text-left px-3 py-2 text-sm ${
                    selectedId === v.id
                      ? "bg-blue-50 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300"
                      : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                  }`}
                >
                  <div className="font-medium">{index === 0 ? "Latest" : formatRelative(v.created_at)}</div>
                  <div className="text-xs opacity-70">{formatAbsolute(v.created_at)}</div>
                </button>
              ))
            )}
          </div>

          <div className="flex-1 min-w-0 flex flex-col">
            <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-neutral-200 dark:border-neutral-800">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                {selectedVersion ? formatAbsolute(selectedVersion.created_at) : ""}
              </span>
              <button
                type="button"
                disabled={!selectedVersion || restoring}
                onClick={() => (confirmRestore ? void handleRestore() : setConfirmRestore(true))}
                className="ml-auto px-3 py-1.5 text-xs font-medium rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90 disabled:opacity-40"
              >
                {restoring ? "Restoring…" : confirmRestore ? "Confirm restore?" : "Restore this version"}
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-8 py-8">
              {previewLoading ? (
                <p className="text-sm text-neutral-400 dark:text-neutral-500">Loading…</p>
              ) : previewError ? (
                <p className="text-sm text-red-500 dark:text-red-400">{previewError}</p>
              ) : previewEditor ? (
                <EditorContent editor={previewEditor} className={docProseClassName} />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DocVersionHistoryPanel;
