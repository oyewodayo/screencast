// components/sidebar/folderCollapse.ts
//
// Which sidebar folders are collapsed - in memory only (resets on restart), like every other
// sidebar toggle. A folder isn't in the set until explicitly collapsed, so everything starts
// expanded.
//
// A tiny store rather than Dashboard state: a caret click then re-renders only the file tree
// subscribed to it (SidebarFileTree), not the whole page around it - so it answers at once however
// big the library or busy the editor. Dashboard still asks and steers it (revealing the open file,
// opening a folder to create a subfolder in it, following a folder rename) through the methods.
import { useSyncExternalStore } from "react";

let collapsed: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const publish = (next: ReadonlySet<string>) => {
  if (next === collapsed) return;
  collapsed = next;
  listeners.forEach((l) => l());
};

export const folderCollapse = {
  has: (folder: string): boolean => collapsed.has(folder),
  toggle(folder: string) {
    const next = new Set(collapsed);
    if (next.has(folder)) next.delete(folder);
    else next.add(folder);
    publish(next);
  },
  expand(folder: string) {
    if (!collapsed.has(folder)) return;
    const next = new Set(collapsed);
    next.delete(folder);
    publish(next);
  },
  // A folder moved or renamed: its collapsed state follows it (and its subfolders').
  repath(map: (folder: string) => string) {
    publish(new Set([...collapsed].map(map)));
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: (): ReadonlySet<string> => collapsed,
};

export function useCollapsedFolders(): ReadonlySet<string> {
  return useSyncExternalStore(folderCollapse.subscribe, folderCollapse.snapshot);
}
