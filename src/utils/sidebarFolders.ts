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

// Per-folder file order: by name (the default), newest first, or oldest first. Kept per folder
// path so e.g. "recordings" can show the latest take on top while other folders stay A-Z.
const FOLDER_SORT_KEY = "briefcast.folderSort.v1";
export type FolderSort = "name" | "date-desc" | "date-asc";
export type FolderSortMap = Record<string, FolderSort>;

export function getFolderSorts(): FolderSortMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOLDER_SORT_KEY) ?? "{}");
    const out: FolderSortMap = {};
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) if (v === "date-desc" || v === "date-asc") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// name -> newest first -> oldest first -> name.
export function cycleFolderSort(folder: string): FolderSortMap {
  const sorts = getFolderSorts();
  const cur = sorts[folder] ?? "name";
  const next: FolderSort = cur === "name" ? "date-desc" : cur === "date-desc" ? "date-asc" : "name";
  if (next === "name") delete sorts[folder];
  else sorts[folder] = next;
  try {
    localStorage.setItem(FOLDER_SORT_KEY, JSON.stringify(sorts));
  } catch {
    /* preference only */
  }
  return sorts;
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

// The sidebar's width: dragged wider for long names and big thumbnails, never narrower than its
// original 300px and at most 2.2x that. Kept separately for browsing and for editing a video - a
// roomy sidebar for the editor's docked panels (mixer, effects, AI voice) needn't eat into the
// picture while just watching - so it moves between the two as the editor opens and closes.
// Or collapsed to a rail of icons (SIDEBAR_RAIL_W) for the most picture while editing.
export type SidebarMode = "browsing" | "editing";
const WIDTH_KEYS: Record<SidebarMode, string> = { browsing: "briefcast.sidebarWidth.v1", editing: "briefcast.sidebarWidth.editing.v1" };
const COLLAPSED_KEY = "briefcast.sidebarCollapsed.v1";
export const SIDEBAR_MIN_W = 300;
export const SIDEBAR_MAX_W = 660;
export const SIDEBAR_RAIL_W = 56;

export const clampSidebarWidth = (w: number): number => Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, Number.isFinite(w) ? w : SIDEBAR_MIN_W)));

export function getSidebarWidth(mode: SidebarMode): number {
  try {
    // Editing starts from the browsing width until it's been set on its own.
    const saved = localStorage.getItem(WIDTH_KEYS[mode]) ?? (mode === "editing" ? localStorage.getItem(WIDTH_KEYS.browsing) : null);
    return clampSidebarWidth(Number(saved ?? SIDEBAR_MIN_W));
  } catch {
    return SIDEBAR_MIN_W;
  }
}

export function saveSidebarWidth(mode: SidebarMode, w: number): number {
  const width = clampSidebarWidth(w);
  try {
    localStorage.setItem(WIDTH_KEYS[mode], String(width));
  } catch {
    /* preference only */
  }
  return width;
}

export function getSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
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
