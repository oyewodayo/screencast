// utils/sidebarFolders.ts
//
// Media-sidebar folder helpers: pinned folders (kept on top while editing), folder-aware search
// and the grid/list view preference. Persisted in localStorage like homeScreenFiles.ts - the
// backend's FileMap carries no metadata, so this lives on the frontend keyed by the folder's
// relative path (the same key Dashboard's FileMap uses; "" is the root and can't be pinned).

const PINNED_FOLDERS_KEY = "briefcast.pinnedFolders.v1";
const VIEW_MODE_KEY = "briefcast.sidebarViewMode.v1";

export type SidebarViewMode = "list" | "grid";

export function getPinnedFolders(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PINNED_FOLDERS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string" && p !== "") : [];
  } catch {
    return [];
  }
}

// Newest pin first, same convention as togglePin for files.
export function togglePinnedFolder(folder: string): string[] {
  if (folder === "") return getPinnedFolders();
  const pinned = getPinnedFolders();
  const next = pinned.includes(folder) ? pinned.filter((f) => f !== folder) : [folder, ...pinned];
  try {
    localStorage.setItem(PINNED_FOLDERS_KEY, JSON.stringify(next));
  } catch (err) {
    console.error("Failed to save pinned folders:", err);
  }
  return next;
}

export function getSidebarViewMode(): SidebarViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function saveSidebarViewMode(mode: SidebarViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    /* preference only */
  }
}

// Index in `pinned` of the folder itself or its nearest pinned ancestor, or -1 when neither is
// pinned. A subfolder rides along with a pinned parent so the tree stays intact on top.
export function pinRank(folder: string, pinned: string[]): number {
  let best = -1;
  pinned.forEach((p, i) => {
    if ((folder === p || folder.startsWith(p + "/")) && (best === -1 || p.length < pinned[best].length)) best = i;
  });
  return best;
}

// Pinned groups first (newest pin first), everything else after; inside a group - and among the
// unpinned - the usual relative-path order, which keeps every folder right after its parent.
export function orderFolders<T>(entries: [string, T][], pinned: string[]): [string, T][] {
  return [...entries].sort(([a], [b]) => {
    const ra = pinRank(a, pinned);
    const rb = pinRank(b, pinned);
    if ((ra === -1) !== (rb === -1)) return ra === -1 ? 1 : -1;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}

// Search matches a folder when the query is in its path (so "papers" finds Workshops/Papers and
// everything under it) or in the root's display name.
export function folderMatchesQuery(folder: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) return false;
  const label = folder === "" ? "briefcast" : folder.toLowerCase();
  return label.includes(normalizedQuery);
}

// Keeps pins pointing at a folder (and anything pinned inside it) after it was moved or renamed.
export function repathFolderKey(key: string, from: string, to: string): string {
  if (key === from) return to;
  return key.startsWith(from + "/") ? to + key.slice(from.length) : key;
}

export function repathPinnedFolders(from: string, to: string): string[] {
  const next = getPinnedFolders().map((f) => repathFolderKey(f, from, to));
  try {
    localStorage.setItem(PINNED_FOLDERS_KEY, JSON.stringify(next));
  } catch (err) {
    console.error("Failed to save pinned folders:", err);
  }
  return next;
}

// Where a dragged/moved folder would land: the destination's child named like the folder itself.
export function movedFolderKey(folder: string, destFolder: string): string {
  const name = folder.split("/").pop()!;
  return destFolder === "" ? name : `${destFolder}/${name}`;
}

// A folder can't go into itself or its own subtree, and moving it where it already is is a no-op.
export function canMoveFolder(folder: string, destFolder: string): boolean {
  if (folder === "" || destFolder === folder || destFolder.startsWith(folder + "/")) return false;
  return movedFolderKey(folder, destFolder) !== folder;
}
