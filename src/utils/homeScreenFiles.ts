// utils/homeScreenFiles.ts
//
// Pin/recent-history tracking for the home screen's "From your library" preview list, persisted
// in localStorage the same way appSettings.ts is — FileEntry/FileMap (Dashboard.tsx) carry no
// metadata from the Rust backend, so pin state and open-history live purely on the frontend,
// keyed by file.path (already the identity used everywhere else in Dashboard.tsx).

export const MAX_HOME_SCREEN_FILES = 6;

const PINNED_KEY = "briefcast.pinnedFiles.v1";
const RECENT_KEY = "briefcast.recentFiles.v1";
// When each home-screen item was last opened, ms since the epoch - keyed by file path, or by
// "doc:<id>" / "whiteboard:<id>" / "mindmap:<id>" for Briefcast's own creations. Lets something
// opened but not edited still rank as recent (its file/updated time wouldn't move).
const OPENED_AT_KEY = "briefcast.openedAt.v1";
const MAX_OPENED_AT = 200;
// Files that came in from a phone (Wi-Fi transfer, its share sheet, or a USB import), keyed by
// path - they join the recent list so the home screen shows what just arrived, and from where.
const ARRIVALS_KEY = "briefcast.fileArrivals.v1";
const MAX_ARRIVALS = 50;

export interface FileArrival {
  from: string; // the phone's name
  at: number;
  batch: string;
  // Files of the same batch this entry stands for (itself included).
  count: number;
}

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

export function getOpenedAt(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(OPENED_AT_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return {};
  }
}

function saveOpenedAt(map: Record<string, number>): void {
  // Newest MAX_OPENED_AT only - the home screen shows a handful, this just must not grow forever.
  const kept = Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_OPENED_AT);
  try {
    localStorage.setItem(OPENED_AT_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage unavailable - recency falls back to modified times */
  }
}

export function recordItemOpened(key: string, at = Date.now()): Record<string, number> {
  const next = { ...getOpenedAt(), [key]: at };
  saveOpenedAt(next);
  return next;
}

// Most-recently-opened first, capped at MAX_HOME_SCREEN_FILES — the home screen's fallback
// ordering whenever nothing is pinned.
export function recordFileOpened(path: string): string[] {
  const next = [path, ...getRecentPaths().filter((p) => p !== path)].slice(0, MAX_HOME_SCREEN_FILES);
  savePaths(RECENT_KEY, next);
  recordItemOpened(path);
  return next;
}

export function getArrivals(): Record<string, FileArrival> {
  try {
    const parsed = JSON.parse(localStorage.getItem(ARRIVALS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveArrivals(map: Record<string, FileArrival>): void {
  const kept = Object.entries(map)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_ARRIVALS);
  try {
    localStorage.setItem(ARRIVALS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage unavailable - arrivals just aren't tagged */
  }
}

// A file arrived from a phone: it goes to the top of the recent list, tagged with where it came
// from. One row per batch - a later file of the same batch takes the earlier one's place and
// carries the count - so twelve shared photos show as one entry rather than pushing everything
// the user was working on off the home screen.
export function recordFileArrived(
  path: string,
  from: string,
  batch: string,
  at = Date.now()
): { recent: string[]; arrivals: Record<string, FileArrival> } {
  const arrivals = getArrivals();
  const earlier = Object.keys(arrivals).filter((p) => p !== path && arrivals[p].batch === batch);
  const count = 1 + earlier.reduce((n, p) => Math.max(n, arrivals[p].count), 0);
  for (const p of earlier) delete arrivals[p];
  arrivals[path] = { from, at, batch, count };
  saveArrivals(arrivals);
  const recent = [path, ...getRecentPaths().filter((p) => p !== path && !earlier.includes(p))].slice(0, MAX_HOME_SCREEN_FILES);
  savePaths(RECENT_KEY, recent);
  recordItemOpened(path, at);
  return { recent, arrivals: getArrivals() };
}

// Keeps pin/recent-history entries pointing at a file across rename/move, instead of them silently
// going stale the moment its path on disk changes.
export function repathFile(oldPath: string, newPath: string): { pinned: string[]; recent: string[] } {
  const rewrite = (paths: string[]) => paths.map((p) => (p === oldPath ? newPath : p));
  const pinned = rewrite(getPinnedPaths());
  const recent = rewrite(getRecentPaths());
  savePaths(PINNED_KEY, pinned);
  savePaths(RECENT_KEY, recent);
  const opened = getOpenedAt();
  if (oldPath in opened) {
    opened[newPath] = opened[oldPath];
    delete opened[oldPath];
    saveOpenedAt(opened);
  }
  const arrivals = getArrivals();
  if (oldPath in arrivals) {
    arrivals[newPath] = arrivals[oldPath];
    delete arrivals[oldPath];
    saveArrivals(arrivals);
  }
  return { pinned, recent };
}

// Drops a file from both lists entirely — called once it's deleted, so a pin/recent-history entry
// never outlives the file it pointed at.
export function forgetFile(path: string): { pinned: string[]; recent: string[] } {
  const pinned = getPinnedPaths().filter((p) => p !== path);
  const recent = getRecentPaths().filter((p) => p !== path);
  savePaths(PINNED_KEY, pinned);
  savePaths(RECENT_KEY, recent);
  const opened = getOpenedAt();
  if (path in opened) {
    delete opened[path];
    saveOpenedAt(opened);
  }
  const arrivals = getArrivals();
  if (path in arrivals) {
    delete arrivals[path];
    saveArrivals(arrivals);
  }
  return { pinned, recent };
}
