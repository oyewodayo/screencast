// components/docker/MoveCopyMenu.tsx
//
// "Move or copy to..." - for the open file (the timeline's "..." menu, the file docker's actions
// row) and for any file or selection in the library (sidebar menus, the bulk bar, every gallery's
// right-click menu and selection panel). Works the same for a file opened from outside the library,
// where Copy is the default: it brings a copy in and leaves the original where it was. Dashboard's
// handleTransferFiles does the work (transfer_file, utility.rs).
//
// Built to be fast with a deep library rather than a tree to scroll through:
// - type to find a folder (matched on its whole path, shown under each hit so two "ATLAS" folders
//   can't be confused) - or, when nothing is called that, create it right there with Enter;
// - the last few destinations sit at the top, since filing tends to go to the same few places;
// - fully keyboard driven: up/down + Enter to choose, Tab flips Move/Copy, Esc closes.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoAdd, IoCheckmark, IoClose, IoDocumentOutline, IoFolderOpenOutline, IoFolderOutline, IoSearch, IoTimeOutline } from "react-icons/io5";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";

export type FileTransferDestination = { kind: "library"; folder: string } | { kind: "new-folder"; parent: string; name: string } | { kind: "pick" };

export interface FileTransferRequest {
  copy: boolean;
  dest: FileTransferDestination;
}

export interface FileTransferOptions {
  // Every library folder ("" = the Briefcast root), sorted so each sits right after its parent.
  folders: { key: string; label: string }[];
  // Which of them holds `path`, or null for a file from outside the library.
  folderOf: (path: string) => string | null;
  onTransfer: (files: { name: string; path: string }[], request: FileTransferRequest) => Promise<void>;
}

interface MoveCopyMenuProps {
  files: { name: string; path: string }[];
  options: FileTransferOptions;
  anchor: PopoverAnchor;
  // Always dark, for the timeline docker (which is dark in both themes); otherwise the menu follows
  // the app's light/dark theme like the sidebar and galleries it opens from.
  alwaysDark?: boolean;
  onClose: () => void;
}

// Class sets for the two looks - the light one carries its own dark: variants.
const THEMES = {
  dark: {
    panel: "bg-neutral-800 border-neutral-700 text-neutral-200",
    divider: "border-neutral-700",
    hover: "hover:bg-neutral-700",
    active: "bg-neutral-700",
    tabIdle: "text-neutral-300 hover:bg-neutral-700",
    muted: "text-neutral-400",
    faint: "text-neutral-500",
    iconButton: "text-neutral-400 hover:bg-neutral-700 hover:text-white",
    addButton: "text-neutral-500 hover:text-white hover:bg-neutral-600",
    input: "bg-neutral-900 border-neutral-600 text-neutral-100 placeholder:text-neutral-500",
    fileChip: "bg-neutral-900/60 text-neutral-200",
  },
  auto: {
    panel: "bg-white border-gray-200 text-neutral-700 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-200",
    divider: "border-gray-200 dark:border-neutral-700",
    hover: "hover:bg-gray-100 dark:hover:bg-neutral-700",
    active: "bg-gray-100 dark:bg-neutral-700",
    tabIdle: "text-neutral-600 hover:bg-gray-100 dark:text-neutral-300 dark:hover:bg-neutral-700",
    muted: "text-neutral-500 dark:text-neutral-400",
    faint: "text-neutral-400 dark:text-neutral-500",
    iconButton: "text-neutral-400 hover:bg-gray-100 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-white",
    addButton: "text-neutral-400 hover:text-neutral-700 hover:bg-gray-200 dark:text-neutral-500 dark:hover:text-white dark:hover:bg-neutral-600",
    input: "bg-white border-gray-300 text-neutral-800 placeholder:text-neutral-400 dark:bg-neutral-900 dark:border-neutral-600 dark:text-neutral-100 dark:placeholder:text-neutral-500",
    fileChip: "bg-gray-50 text-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-200",
  },
};

const RECENT_KEY = "briefcast.moveCopy.recentFolders";
const RECENT_MAX = 3;

// Per-viewer convenience only - a missing/blocked localStorage just means no "Recent" section.
const readRecent = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
};
const rememberRecent = (key: string) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...readRecent().filter((k) => k !== key)].slice(0, RECENT_MAX)));
  } catch {
    // ignore
  }
};

const depthOf = (key: string) => (key === "" ? 0 : key.split("/").length);
const joinKey = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

type Row = { kind: "folder"; key: string; label: string; section: "recent" | "all" | "match" } | { kind: "create"; name: string; parent: string };

const MoveCopyMenu: React.FC<MoveCopyMenuProps> = ({ files, options, anchor, alwaysDark, onClose }) => {
  const t = THEMES[alwaysDark ? "dark" : "auto"];
  const { ref, position } = useClampedPopoverPosition(anchor);
  const folders = files.map((f) => options.folderOf(f.path));
  const isExternal = folders.every((f) => f === null);
  // The folder they all share, if they do - a selection spanning folders has no "current" one.
  const currentFolder = folders.length > 0 && folders.every((f) => f === folders[0]) ? folders[0] : null;
  const [copy, setCopy] = useState(isExternal);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  useEffect(() => {
    if (newFolderParent !== null) nameInputRef.current?.focus();
  }, [newFolderParent]);

  const labelOf = (key: string) => options.folders.find((f) => f.key === key)?.label ?? (key === "" ? "Briefcast" : key.split("/").pop()!);
  const isDisabled = (key: string) => key === currentFolder && !copy;

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const known = new Set(options.folders.map((f) => f.key));
      const recent: Row[] = readRecent()
        .filter((k) => known.has(k) && k !== currentFolder)
        .map((k) => ({ kind: "folder", key: k, label: labelOf(k), section: "recent" }));
      return [...recent, ...options.folders.map((f): Row => ({ kind: "folder", key: f.key, label: f.label, section: "all" }))];
    }
    // Name matches first (starts-with before contains), then folders matched only via a parent.
    const scored = options.folders
      .map((f) => {
        const label = f.label.toLowerCase();
        const path = (f.key || "briefcast").toLowerCase();
        const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : path.includes(q) ? 2 : -1;
        return { f, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.f.key.localeCompare(b.f.key));
    const matches: Row[] = scored.map(({ f }) => ({ kind: "folder", key: f.key, label: f.label, section: "match" }));
    const name = query.trim();
    const parent = currentFolder ?? "";
    const exists = options.folders.some((f) => f.key.toLowerCase() === joinKey(parent, name).toLowerCase());
    const create: Row[] = exists || name.includes("/") || name.includes("\\") ? [] : [{ kind: "create", name, parent }];
    // Nothing found: creating it is the obvious next step, so it goes first (and is what Enter does).
    return matches.length === 0 ? create : [...matches, ...create];
  }, [query, options.folders, currentFolder]);

  const selectable = (r: Row) => r.kind === "create" || !isDisabled(r.key);

  // Keep the highlight on something choosable as the list changes under it.
  useEffect(() => {
    const first = rows.findIndex(selectable);
    setActiveIndex(first === -1 ? 0 : first);
  }, [rows, copy]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const run = async (dest: FileTransferDestination) => {
    if (dest.kind === "library") rememberRecent(dest.folder);
    if (dest.kind === "new-folder") rememberRecent(joinKey(dest.parent, dest.name));
    setBusy(true);
    try {
      await options.onTransfer(files, { copy, dest });
    } finally {
      setBusy(false);
      onClose();
    }
  };

  const choose = (r: Row | undefined) => {
    if (!r || busy || !selectable(r)) return;
    if (r.kind === "create") void run({ kind: "new-folder", parent: r.parent, name: r.name });
    else void run({ kind: "library", folder: r.key });
  };

  const commitNewFolder = () => {
    const name = newFolderName.trim();
    if (newFolderParent === null || !name) return;
    void run({ kind: "new-folder", parent: newFolderParent, name });
  };

  const moveActive = (dir: 1 | -1) => {
    if (rows.length === 0) return;
    let i = activeIndex;
    for (let n = 0; n < rows.length; n++) {
      i = (i + dir + rows.length) % rows.length;
      if (selectable(rows[i])) break;
    }
    setActiveIndex(i);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(rows[activeIndex]);
    } else if (e.key === "Tab") {
      e.preventDefault();
      setCopy((c) => !c);
    }
  };

  const rowClass = `w-full flex items-center gap-1.5 text-left px-3 py-1.5 ${t.hover} disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default`;
  const fileName = (f: { name: string; path: string }) => f.name || f.path.split(/[\\/]/).pop() || f.path;
  const allNames = files.map(fileName).join("\n");
  const verb = copy ? "Copy" : "Move";

  const renderRow = (r: Row, i: number) => {
    const isActive = i === activeIndex;
    if (r.kind === "create") {
      return (
        <button
          key="__create__"
          type="button"
          data-row={i}
          disabled={busy}
          onMouseEnter={() => setActiveIndex(i)}
          onClick={() => choose(r)}
          className={`${rowClass} ${isActive ? t.active : ""}`}
        >
          <IoAdd size={14} className="shrink-0 text-blue-500 dark:text-blue-400" />
          <span className="truncate flex-1">
            Create <span className="font-medium">“{r.name}”</span>
            <span className={t.muted}> in {labelOf(r.parent)}</span>
          </span>
        </button>
      );
    }
    const isHere = r.key === currentFolder;
    const indent = r.section === "all" ? depthOf(r.key) * 12 : 0;
    return (
      <React.Fragment key={`${r.section}:${r.key}`}>
        <div className={`group flex items-center ${isActive ? t.active : ""}`} onMouseEnter={() => selectable(r) && setActiveIndex(i)}>
          <button
            type="button"
            data-row={i}
            disabled={busy || isDisabled(r.key)}
            title={isHere ? (copy ? `Make a copy in ${r.label}` : "Already here") : r.key || "Briefcast"}
            onClick={() => choose(r)}
            className={rowClass}
            style={{ paddingLeft: 12 + indent }}
          >
            {r.section === "recent" ? <IoTimeOutline size={13} className={`shrink-0 ${t.muted}`} /> : <IoFolderOutline size={13} className={`shrink-0 ${t.muted}`} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{r.label}</span>
              {/* Where it lives, wherever the row isn't already showing that by its indent. */}
              {r.section !== "all" && r.key.includes("/") && <span className={`block truncate text-[10px] ${t.faint}`}>{r.key.split("/").slice(0, -1).join(" › ")}</span>}
            </span>
            {isHere && <span className={`text-[10px] ${t.faint}`}>current</span>}
          </button>
          {r.section === "all" && (
            <button
              type="button"
              title={`New folder inside ${r.label}`}
              disabled={busy}
              onClick={() => {
                setNewFolderParent(r.key);
                setNewFolderName("");
              }}
              className={`mr-1 p-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 ${t.addButton}`}
            >
              <IoAdd size={13} />
            </button>
          )}
        </div>
        {r.section === "all" && newFolderParent === r.key && (
          <form
            className="flex items-center gap-1 pr-1.5 py-1"
            style={{ paddingLeft: 12 + (depthOf(r.key) + 1) * 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              commitNewFolder();
            }}
          >
            <IoFolderOutline size={13} className="shrink-0 text-blue-500 dark:text-blue-400" />
            <input
              ref={nameInputRef}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setNewFolderParent(null);
                  searchRef.current?.focus();
                }
              }}
              placeholder="New folder name"
              className={`min-w-0 flex-1 px-1.5 py-0.5 rounded border text-xs outline-none focus:border-blue-500 ${t.input}`}
            />
            <button
              type="submit"
              disabled={busy || !newFolderName.trim()}
              title={copy ? "Create and copy here" : "Create and move here"}
              className={`p-1 rounded text-blue-500 dark:text-blue-400 ${t.hover} disabled:opacity-40`}
            >
              <IoCheckmark size={14} />
            </button>
          </form>
        )}
      </React.Fragment>
    );
  };

  const firstAllIndex = rows.findIndex((r) => r.kind === "folder" && r.section === "all");
  const hasRecent = rows.some((r) => r.kind === "folder" && r.section === "recent");
  const sectionLabel = (text: string) => <p className={`px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wide ${t.faint}`}>{text}</p>;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={busy ? undefined : onClose} />
      <div
        ref={ref}
        style={{ position: "fixed", left: position.left, top: position.top }}
        className={`z-[61] w-72 max-h-[min(480px,calc(100vh-16px))] flex flex-col border rounded-md shadow-lg text-sm ${t.panel}`}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
        }}
      >
        <div className={`flex items-center gap-1 p-1.5 border-b ${t.divider}`}>
          {(["move", "copy"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              title="Tab switches"
              onClick={() => {
                setCopy(mode === "copy");
                searchRef.current?.focus();
              }}
              className={`flex-1 px-2 py-1 rounded text-xs ${copy === (mode === "copy") ? "bg-blue-600 text-white" : t.tabIdle}`}
            >
              {mode === "move" ? "Move to" : "Copy to"}
            </button>
          ))}
          <button type="button" title="Close (Esc)" onClick={onClose} className={`p-1 rounded ${t.iconButton}`}>
            <IoClose size={13} />
          </button>
        </div>

        {/* What's being moved - a menu opened from a sidebar row or gallery tile otherwise gives no
            sign of which file (or how many) it's acting on. */}
        <div title={allNames} className={`mx-2 mt-2 flex items-center gap-1.5 px-2 py-1.5 rounded text-xs ${t.fileChip}`}>
          <IoDocumentOutline size={13} className={`shrink-0 ${t.muted}`} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{files.length === 1 ? fileName(files[0]) : `${files.length} files`}</span>
            {files.length > 1 && (
              <span className={`block truncate text-[10px] ${t.muted}`}>
                {files.slice(0, 2).map(fileName).join(", ")}
                {files.length > 2 ? ` +${files.length - 2} more` : ""}
              </span>
            )}
          </span>
          {currentFolder !== null && <span className={`shrink-0 text-[10px] ${t.faint}`}>in {labelOf(currentFolder)}</span>}
        </div>
        {isExternal && (
          <p className={`px-3 pt-1.5 text-[11px] leading-snug ${t.muted}`}>
            {files.length > 1 ? "These files aren't" : "This file isn't"} in your library.{" "}
            {copy ? "Copy brings a copy in and leaves the original where it is." : "Move takes it out of its current folder."}
          </p>
        )}

        <div className="px-2 pt-2">
          <div className={`flex items-center gap-1.5 px-2 rounded border focus-within:border-blue-500 ${t.input}`}>
            <IoSearch size={12} className={`shrink-0 ${t.faint}`} />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Find or create a folder…"
              className="min-w-0 flex-1 py-1 bg-transparent text-xs outline-none"
              aria-label="Find or create a folder"
            />
          </div>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {rows.length === 0 && <p className={`px-3 py-2 text-xs italic ${t.faint}`}>No folders</p>}
          {rows.map((r, i) => (
            <React.Fragment key={`wrap:${i}`}>
              {i === 0 && hasRecent && sectionLabel("Recent")}
              {i === firstAllIndex && hasRecent && sectionLabel("All folders")}
              {renderRow(r, i)}
            </React.Fragment>
          ))}
        </div>

        <div className={`border-t py-1 ${t.divider}`}>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setQuery("");
              setNewFolderParent(currentFolder ?? "");
              setNewFolderName("");
            }}
            className={rowClass}
          >
            <IoAdd size={13} className="shrink-0" /> {verb} to new folder…
          </button>
          <button type="button" disabled={busy} onClick={() => void run({ kind: "pick" })} className={rowClass}>
            <IoFolderOpenOutline size={13} className="shrink-0" /> Other location on this PC…
          </button>
          <p className={`px-3 pt-1 pb-0.5 text-[10px] ${t.faint}`}>↑↓ choose · Enter {verb.toLowerCase()} · Tab move/copy · Esc close</p>
        </div>
      </div>
    </>,
    document.body
  );
};

export default MoveCopyMenu;
