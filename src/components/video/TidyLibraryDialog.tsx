// components/video/TidyLibraryDialog.tsx
//
// "Tidy up library": puts what earlier versions scattered back where it now belongs - video
// projects into the library's Projects folder, finished videos (exports) into Exports - and clears
// out the saved settings of files that no longer exist. Nothing happens until it's confirmed: it
// shows exactly what it will do, every item can be left out, files are moved (never renamed or
// deleted) the way the sidebar moves them - their edits, pins, history and linked notes going with
// them - and leftovers go to Briefcast's Trash, where they can still be restored.
import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IoCheckmarkCircle, IoChevronForward, IoClose, IoSparkles } from "react-icons/io5";
import { getFileCategory } from "../../utils/fileCategory";
import { isVideoProjectPath } from "../../utils/videoEditTypes";
import { isExportName } from "../../utils/videoLibraryMeta";
import type { FileEntry } from "../../utils/libraryEntries";

interface TidyLibraryDialogProps {
  files: FileEntry[];
  // A file's folder in the library ("" = the root).
  folderOf: (path: string) => string | null;
  // Moves files into a library folder (Dashboard's handleMoveFiles); resolves to how many moved.
  onMove: (files: FileEntry[], folder: string) => Promise<number>;
  // Called once the tidy-up has finished (the library is re-listed).
  onDone: () => void;
  onClose: () => void;
}

const PROJECTS = "Projects";
const EXPORTS = "Exports";
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

type SectionId = "projects" | "exports" | "leftovers";

interface Result {
  projects: number;
  exports: number;
  leftovers: number;
  skipped: number;
}

const TidyLibraryDialog: React.FC<TidyLibraryDialogProps> = ({ files, folderOf, onMove, onDone, onClose }) => {
  const projects = useMemo(() => files.filter((f) => isVideoProjectPath(f.path) && folderOf(f.path) !== PROJECTS), [files, folderOf]);
  const exports = useMemo(() => files.filter((f) => getFileCategory(f.name) === "video" && !isVideoProjectPath(f.path) && isExportName(f.path) && folderOf(f.path) !== EXPORTS), [files, folderOf]);
  const [leftovers, setLeftovers] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Everything is in until it's ticked off.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<SectionId | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  // Makes the two folders and finds the leftovers (prepare_library_tidy, sidecars.rs).
  useEffect(() => {
    invoke<string[]>("prepare_library_tidy")
      .then(setLeftovers)
      .catch((e) => {
        setLeftovers([]);
        setError(String(e));
      });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !working && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, working]);

  const included = (path: string) => !excluded.has(path);
  const toggle = (path: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleAll = (paths: string[], on: boolean) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      paths.forEach((p) => (on ? next.delete(p) : next.add(p)));
      return next;
    });

  const chosenProjects = projects.filter((f) => included(f.path));
  const chosenExports = exports.filter((f) => included(f.path));
  const chosenLeftovers = (leftovers ?? []).filter(included);
  const total = chosenProjects.length + chosenExports.length + chosenLeftovers.length;
  const nothingToDo = leftovers !== null && projects.length + exports.length + leftovers.length === 0;

  const run = async () => {
    const done: Result = { projects: 0, exports: 0, leftovers: 0, skipped: 0 };
    try {
      if (chosenProjects.length) {
        setWorking(`Moving ${chosenProjects.length} project${chosenProjects.length === 1 ? "" : "s"}…`);
        done.projects = await onMove(chosenProjects, PROJECTS);
      }
      if (chosenExports.length) {
        setWorking(`Moving ${chosenExports.length} finished video${chosenExports.length === 1 ? "" : "s"}…`);
        done.exports = await onMove(chosenExports, EXPORTS);
      }
      if (chosenLeftovers.length) {
        setWorking("Clearing leftover settings…");
        for (const path of chosenLeftovers) {
          // eslint-disable-next-line no-await-in-loop
          await invoke("move_to_trash", { path }).then(
            () => (done.leftovers += 1),
            () => (done.skipped += 1)
          );
        }
      }
      done.skipped += chosenProjects.length - done.projects + (chosenExports.length - done.exports);
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(null);
      setResult(done);
      onDone();
    }
  };

  const section = (id: SectionId, title: string, where: string, items: { path: string; name: string }[]) => {
    if (items.length === 0) return null;
    const on = items.filter((i) => included(i.path)).length;
    return (
      <div className="rounded-xl border border-gray-200 dark:border-neutral-800 overflow-hidden">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <input
            type="checkbox"
            checked={on === items.length}
            ref={(el) => {
              if (el) el.indeterminate = on > 0 && on < items.length;
            }}
            onChange={(e) => toggleAll(items.map((i) => i.path), e.target.checked)}
            className="accent-blue-500"
            aria-label={`Include ${title.toLowerCase()}`}
          />
          <button type="button" onClick={() => setOpen(open === id ? null : id)} className="flex-1 min-w-0 flex items-center gap-2 text-left outline-none">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-gray-800 dark:text-neutral-100">
                {on} {title}
              </span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">{where}</span>
            </span>
            <IoChevronForward size={14} className={`shrink-0 text-neutral-400 transition-transform ${open === id ? "rotate-90" : ""}`} />
          </button>
        </div>
        {open === id && (
          <ul className="max-h-48 overflow-y-auto border-t border-gray-100 dark:border-neutral-800 py-1">
            {items.map((i) => (
              <li key={i.path}>
                <label className="flex items-center gap-2 px-3 py-1 text-xs text-neutral-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-800/60 cursor-pointer" title={i.path}>
                  <input type="checkbox" checked={included(i.path)} onChange={() => toggle(i.path)} className="accent-blue-500" />
                  <span className="truncate">{i.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4" onPointerDown={(e) => e.target === e.currentTarget && !working && onClose()}>
      <div role="dialog" aria-label="Tidy up library" className="w-full max-w-lg max-h-[86vh] overflow-y-auto rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl ring-1 ring-black/5 dark:ring-white/10 p-5 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="p-2 rounded-lg bg-blue-500/10 text-blue-500 dark:text-blue-400">
            <IoSparkles size={18} />
          </span>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-50">Tidy up your library</h2>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Projects and finished videos get folders of their own; leftovers from deleted files are cleared.</p>
          </div>
          <button type="button" onClick={onClose} disabled={!!working} aria-label="Close" className="p-1 -m-1 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-40">
            <IoClose size={18} />
          </button>
        </div>

        {result ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <IoCheckmarkCircle size={36} className="text-emerald-500" />
            <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">
              {[
                result.projects ? `${result.projects} project${result.projects === 1 ? "" : "s"} moved to Projects` : null,
                result.exports ? `${result.exports} finished video${result.exports === 1 ? "" : "s"} moved to Exports` : null,
                result.leftovers ? `${result.leftovers} leftover${result.leftovers === 1 ? "" : "s"} moved to Trash` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "Nothing needed moving"}
            </p>
            {result.skipped > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">{result.skipped} couldn&rsquo;t be moved and stayed where they were.</p>}
            <button type="button" onClick={onClose} className="mt-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
              Done
            </button>
          </div>
        ) : leftovers === null ? (
          <p className="py-6 text-center text-sm text-neutral-500">Looking through your library…</p>
        ) : nothingToDo ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <IoCheckmarkCircle size={32} className="text-emerald-500" />
            <p className="text-sm text-neutral-600 dark:text-neutral-300">Your library is already tidy.</p>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {section("projects", projects.length === 1 ? "video project" : "video projects", "Into the Projects folder", projects)}
              {section("exports", exports.length === 1 ? "finished video" : "finished videos", "Exports - into the Exports folder", exports)}
              {section("leftovers", leftovers.length === 1 ? "leftover settings file" : "leftover settings files", "Saved edits of files that no longer exist - to Trash", leftovers.map((p) => ({ path: p, name: baseName(p) })))}
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
              Files are only moved, never deleted - their edits, pins and history go with them. One whose name is already taken in its new folder is kept alongside as &ldquo;name (2)&rdquo;. Leftovers go to Briefcast&rsquo;s Trash, where you can restore them.
            </p>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={onClose} disabled={!!working} className="px-3.5 py-2 rounded-lg text-sm text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-40">
                Cancel
              </button>
              <button type="button" onClick={() => void run()} disabled={!!working || total === 0} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 min-w-[9rem]">
                {working ?? `Tidy up ${total} item${total === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default TidyLibraryDialog;
