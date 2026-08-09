// utils/docLibraryHistory.ts
//
// Pin tracking for DocsHome, parallel to homeScreenFiles.ts but id-keyed instead of path-keyed
// (docs have a stable UUID that never changes, unlike a file's path) and pin-only - no "recent"
// list, since list_docs already sorts by updated_at desc, which already surfaces recently-edited
// docs; a separate MRU list would just duplicate that. No slot cap either: DocsHome is a full list
// view, not a limited home-screen preview widget.

const PINNED_DOCS_KEY = "briefcast.pinnedDocs.v1";

function loadIds(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_DOCS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch (err) {
    console.error(`Failed to load ${PINNED_DOCS_KEY}, resetting:`, err);
    return [];
  }
}

function saveIds(ids: string[]): void {
  localStorage.setItem(PINNED_DOCS_KEY, JSON.stringify(ids));
}

export function getPinnedDocIds(): string[] {
  return loadIds();
}

// Pins are stored newest-first, same convention as homeScreenFiles.ts's togglePin.
export function toggleDocPin(id: string): string[] {
  const pinned = loadIds();
  const next = pinned.includes(id) ? pinned.filter((p) => p !== id) : [id, ...pinned];
  saveIds(next);
  return next;
}

// Drops a doc from the pinned list once it's deleted, so a pin entry never outlives its doc.
export function forgetDocPin(id: string): string[] {
  const next = loadIds().filter((p) => p !== id);
  saveIds(next);
  return next;
}
