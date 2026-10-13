// utils/homeLibraryItems.ts
//
// The home screen's "From your library" list: library files (recordings, images, PDFs...) and
// Briefcast's own creations (documents, whiteboards, mind maps), which live in their own stores
// rather than the library folder, merged into one most-recent-first list. Pinned files stay on top
// in pin order (homeScreenFiles.ts); everything else ranks by the later of when it was last opened
// here and when it last changed.

export type HomeItemKind = "file" | "doc" | "whiteboard" | "mindmap";

export interface HomeItem {
  key: string; // file path, or "<kind>:<id>"
  kind: HomeItemKind;
  id: string; // file path for files
  name: string;
  time: number; // ms since the epoch, 0 = unknown
  pinned: boolean;
}

export interface HomeFileLike {
  path: string;
  name: string;
  modified?: number;
}

export interface HomeCreationLike {
  id: string;
  name: string;
  updated_at: string;
}

export const HOME_LIST_SIZE = 8;

export function homeItemKey(kind: Exclude<HomeItemKind, "file">, id: string): string {
  return `${kind}:${id}`;
}

function parseTime(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function buildHomeItems(input: {
  files: HomeFileLike[];
  pinnedPaths: string[];
  recentPaths: string[];
  openedAt: Record<string, number>;
  docs: HomeCreationLike[];
  whiteboards: HomeCreationLike[];
  mindmaps: HomeCreationLike[];
  limit?: number;
}): HomeItem[] {
  const { files, pinnedPaths, recentPaths, openedAt, limit = HOME_LIST_SIZE } = input;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const fileItem = (f: HomeFileLike, pinned: boolean): HomeItem => ({
    key: f.path,
    kind: "file",
    id: f.path,
    name: f.name,
    time: Math.max(openedAt[f.path] ?? 0, f.modified ?? 0),
    pinned,
  });

  const pinned = pinnedPaths
    .map((p) => byPath.get(p))
    .filter((f): f is HomeFileLike => !!f)
    .map((f) => fileItem(f, true));

  // Files compete on recency only once opened here (or, before any open history exists, the whole
  // library by modified time) - otherwise every untouched recording would crowd out the
  // documents someone is actually working on.
  const recentFiles = recentPaths.map((p) => byPath.get(p)).filter((f): f is HomeFileLike => !!f);
  const fileCandidates = (recentFiles.length > 0 ? recentFiles : files).filter((f) => !pinnedPaths.includes(f.path)).map((f) => fileItem(f, false));

  const creation = (kind: Exclude<HomeItemKind, "file">) => (c: HomeCreationLike): HomeItem => {
    const key = homeItemKey(kind, c.id);
    return { key, kind, id: c.id, name: c.name || "Untitled", time: Math.max(openedAt[key] ?? 0, parseTime(c.updated_at)), pinned: false };
  };
  const rest = [
    ...fileCandidates,
    ...input.docs.map(creation("doc")),
    ...input.whiteboards.map(creation("whiteboard")),
    ...input.mindmaps.map(creation("mindmap")),
  ].sort((a, b) => b.time - a.time);

  return [...pinned, ...rest].slice(0, limit);
}

export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}
