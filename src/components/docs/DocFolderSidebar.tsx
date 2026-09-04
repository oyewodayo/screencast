// components/docs/DocFolderSidebar.tsx
//
// The left-hand folder rail for DocsHome - a recursive, expand/collapsible tree built from
// docs.rs's flat folders.json (parent_id pointers, not real nested directories - see docTypes.ts's
// DocFolder comment). Rename/delete follow the same two-step "confirm?" and click-outside-closes-
// menu conventions DocsHome already uses for individual documents, and folder creation uses an
// inline text row (not window.prompt - the Tauri dialog allowlist has no native text-prompt, same
// reason DocsEditor.tsx's link popover is inline instead of a prompt()).
import React, { useCallback, useEffect, useState } from "react";
import { IoAdd, IoChevronDown, IoChevronForward, IoDocumentTextOutline, IoEllipsisVertical, IoFolderOutline, IoTrashOutline } from "react-icons/io5";
import { DOC_DRAG_MIME, DocFolder } from "../../utils/docTypes";

interface DocFolderSidebarProps {
  folders: DocFolder[];
  selectedFolderId: string | null;
  onSelectFolder: (id: string | null) => void;
  onCreateFolder: (parentId: string | null, name: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  // Fired when a doc card dragged from DocsHome's grid (see its onDragStart) is dropped on a row
  // here - `folderId` is null for the "All Documents" root row (un-files the doc). Wired straight
  // to DocsHome's handleMoveDocToFolder, the same handler the "Move to ▸" menu already uses, so
  // there's exactly one place that actually calls set_doc_folder.
  onDropDoc: (docId: string, folderId: string | null) => void;
}

// Sentinel key for the "All Documents" root row's own drag-over highlight state, since its real
// identity (`null`) can't double as a Set/state key the way every real folder's string id can.
const ROOT_DROP_KEY = "__root__";

// Which inline text row is currently open, if any - at most one across the whole tree (creating
// and renaming are mutually exclusive states, same as DocsHome's own openMenuId/confirmDeleteId).
type PendingRow = { kind: "create"; parentId: string | null } | { kind: "rename"; id: string } | null;

const DocFolderSidebar: React.FC<DocFolderSidebarProps> = ({
  folders,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onDropDoc,
}) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pendingRow, setPendingRow] = useState<PendingRow>(null);
  const [inputValue, setInputValue] = useState("");
  // Which row (folder id, or ROOT_DROP_KEY) a dragged doc is currently over, for a highlight ring
  // - at most one at a time, cleared on dragleave/drop just like the app's other transient row states.
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  // Shared by every drop-target row (root + every folder) so the accept/highlight/commit dance
  // can't drift between them - `key` is the row's own dragOverKey identity, `folderId` is what
  // gets passed to onDropDoc (null for the root row).
  const dropTargetProps = useCallback(
    (key: string, folderId: string | null) => ({
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(DOC_DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragOverKey !== key) setDragOverKey(key);
      },
      onDragLeave: () => setDragOverKey((prev) => (prev === key ? null : prev)),
      onDrop: (e: React.DragEvent) => {
        const docId = e.dataTransfer.getData(DOC_DRAG_MIME);
        setDragOverKey(null);
        if (!docId) return;
        e.preventDefault();
        onDropDoc(docId, folderId);
      },
    }),
    [dragOverKey, onDropDoc]
  );

  useEffect(() => {
    if (!openMenuId) return;
    const closeMenu = () => {
      setOpenMenuId(null);
      setConfirmDeleteId(null);
    };
    document.addEventListener("click", closeMenu);
    return () => document.removeEventListener("click", closeMenu);
  }, [openMenuId]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startCreate = useCallback((parentId: string | null) => {
    setPendingRow({ kind: "create", parentId });
    setInputValue("");
    setOpenMenuId(null);
    if (parentId) setExpandedIds((prev) => new Set(prev).add(parentId));
  }, []);

  const startRename = useCallback((folder: DocFolder) => {
    setPendingRow({ kind: "rename", id: folder.id });
    setInputValue(folder.name);
    setOpenMenuId(null);
  }, []);

  const commitPendingRow = useCallback(() => {
    const value = inputValue.trim();
    if (!pendingRow || !value) {
      setPendingRow(null);
      return;
    }
    if (pendingRow.kind === "create") onCreateFolder(pendingRow.parentId, value);
    else onRenameFolder(pendingRow.id, value);
    setPendingRow(null);
  }, [pendingRow, inputValue, onCreateFolder, onRenameFolder]);

  const inputRow = (
    <div className="flex items-center gap-1 px-2 py-1">
      <input
        autoFocus
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onBlur={commitPendingRow}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitPendingRow();
          if (e.key === "Escape") setPendingRow(null);
        }}
        placeholder="Folder name"
        className="w-full px-1.5 py-0.5 text-xs rounded border border-blue-300 dark:border-blue-500 bg-white dark:bg-neutral-800 outline-none text-neutral-800 dark:text-neutral-100"
      />
    </div>
  );

  const renderChildren = (parentId: string | null, depth: number): React.ReactNode => {
    const children = folders.filter((f) => f.parent_id === parentId);
    return (
      <>
        {children.map((folder) => {
          const hasChildren = folders.some((f) => f.parent_id === folder.id);
          const isExpanded = expandedIds.has(folder.id);
          const isRenaming = pendingRow?.kind === "rename" && pendingRow.id === folder.id;
          return (
            <div key={folder.id}>
              {isRenaming ? (
                <div style={{ paddingLeft: `${depth * 14}px` }}>{inputRow}</div>
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectFolder(folder.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectFolder(folder.id);
                    }
                  }}
                  {...dropTargetProps(folder.id, folder.id)}
                  style={{ paddingLeft: `${depth * 14}px` }}
                  className={`group relative flex items-center gap-1 pr-1 py-1 rounded-md text-sm cursor-pointer ${
                    dragOverKey === folder.id
                      ? "ring-2 ring-inset ring-blue-400 dark:ring-blue-500 bg-blue-50 dark:bg-blue-500/10"
                      : selectedFolderId === folder.id
                      ? "bg-blue-100 dark:bg-blue-500/25 text-blue-700 dark:text-blue-300"
                      : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  }`}
                >
                  <button
                    type="button"
                    title={isExpanded ? "Collapse" : "Expand"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpanded(folder.id);
                    }}
                    className={`shrink-0 p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 ${hasChildren ? "" : "invisible"}`}
                  >
                    {isExpanded ? <IoChevronDown size={12} /> : <IoChevronForward size={12} />}
                  </button>
                  <IoFolderOutline size={14} className="shrink-0" />
                  <span className="flex-1 truncate">{folder.name}</span>

                  <button
                    type="button"
                    title="Folder options"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(null);
                      setOpenMenuId((prev) => (prev === folder.id ? null : folder.id));
                    }}
                    className={`shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-opacity ${
                      openMenuId === folder.id ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    }`}
                  >
                    <IoEllipsisVertical size={13} />
                  </button>

                  {openMenuId === folder.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute right-0 top-full mt-1 z-20 w-44 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => startCreate(folder.id)}
                        className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                      >
                        <IoAdd size={14} /> New subfolder
                      </button>
                      <button
                        type="button"
                        onClick={() => startRename(folder)}
                        className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => (confirmDeleteId === folder.id ? onDeleteFolder(folder.id) : setConfirmDeleteId(folder.id))}
                        className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                      >
                        <IoTrashOutline size={14} />
                        {confirmDeleteId === folder.id ? "Confirm delete?" : "Delete folder"}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {isExpanded && renderChildren(folder.id, depth + 1)}
            </div>
          );
        })}
        {pendingRow?.kind === "create" && pendingRow.parentId === parentId && (
          <div style={{ paddingLeft: `${(parentId ? depth : 0) * 14}px` }}>{inputRow}</div>
        )}
      </>
    );
  };

  return (
    <div className="w-56 shrink-0 h-full overflow-y-auto border-r border-neutral-200 dark:border-neutral-800 px-2 py-3">
      <div className="flex items-center justify-between px-1 mb-1">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">Folders</span>
        <button
          type="button"
          title="New folder"
          onClick={() => startCreate(null)}
          className="p-1 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <IoAdd size={15} />
        </button>
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelectFolder(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelectFolder(null);
          }
        }}
        {...dropTargetProps(ROOT_DROP_KEY, null)}
        className={`flex items-center gap-1.5 px-1.5 py-1 rounded-md text-sm cursor-pointer mb-1 ${
          dragOverKey === ROOT_DROP_KEY
            ? "ring-2 ring-inset ring-blue-400 dark:ring-blue-500 bg-blue-50 dark:bg-blue-500/10"
            : selectedFolderId === null
            ? "bg-blue-100 dark:bg-blue-500/25 text-blue-700 dark:text-blue-300"
            : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        }`}
      >
        <IoDocumentTextOutline size={14} className="shrink-0" />
        All Documents
      </div>

      {renderChildren(null, 0)}
    </div>
  );
};

export default DocFolderSidebar;
