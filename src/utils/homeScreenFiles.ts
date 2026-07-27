// utils/homeScreenFiles.ts
//
// Pin/recent-history tracking for the home screen's "From your library" preview list, persisted
// in localStorage the same way appSettings.ts is — FileEntry/FileMap (Dashboard.tsx) carry no
// metadata from the Rust backend, so pin state and open-history live purely on the frontend,
// keyed by file.path (already the identity used everywhere else in Dashboard.tsx).

export const MAX_HOME_SCREEN_FILES = 6;

const PINNED_KEY = "briefcast.pinnedFiles.v1";
const RECENT_KEY = "briefcast.recentFiles.v1";

function loadPaths(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch (err) {
    console.error(`Failed to load ${key}, resetting:`, err);
    return [];
  }
}

function savePaths(key: string, paths: string[]): void {
  localStorage.setItem(key, JSON.stringify(paths));
}

export function getPinnedPaths(): string[] {
  return loadPaths(PINNED_KEY);
}

export function getRecentPaths(): string[] {
  return loadPaths(RECENT_KEY);
}

// Pins are stored newest-first — pinning a file puts it at the top, ahead of everything already
// pinned, which stays in place otherwise. Pinning past MAX_HOME_SCREEN_FILES evicts only the
// single oldest pin (now at the tail) rather than refusing the new one or disturbing the rest —
// the home screen only ever has that many slots to show.
export function togglePin(path: string): string[] {
  const pinned = getPinnedPaths();
  const next = pinned.includes(path)
    ? pinned.filter((p) => p !== path)
    : [path, ...pinned].slice(0, MAX_HOME_SCREEN_FILES);
  savePaths(PINNED_KEY, next);
  return next;
}

// Most-recently-opened first, capped at MAX_HOME_SCREEN_FILES — the home screen's fallback
// ordering whenever nothing is pinned.
export function recordFileOpened(path: string): string[] {
  const next = [path, ...getRecentPaths().filter((p) => p !== path)].slice(0, MAX_HOME_SCREEN_FILES);
  savePaths(RECENT_KEY, next);
  return next;
}

// Keeps pin/recent-history entries pointing at a file across rename/move, instead of them silently
// going stale the moment its path on disk changes.
export function repathFile(oldPath: string, newPath: string): { pinned: string[]; recent: string[] } {
  const rewrite = (paths: string[]) => paths.map((p) => (p === oldPath ? newPath : p));
  const pinned = rewrite(getPinnedPaths());
  const recent = rewrite(getRecentPaths());
  savePaths(PINNED_KEY, pinned);
  savePaths(RECENT_KEY, recent);
  return { pinned, recent };
}

// Drops a file from both lists entirely — called once it's deleted, so a pin/recent-history entry
// never outlives the file it pointed at.
export function forgetFile(path: string): { pinned: string[]; recent: string[] } {
  const pinned = getPinnedPaths().filter((p) => p !== path);
  const recent = getRecentPaths().filter((p) => p !== path);
  savePaths(PINNED_KEY, pinned);
  savePaths(RECENT_KEY, recent);
  return { pinned, recent };
}
