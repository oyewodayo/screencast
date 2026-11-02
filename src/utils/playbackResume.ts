// utils/playbackResume.ts
//
// Two closely-related bits of "pick up where you left off" state, persisted in localStorage the
// same way appSettings.ts and homeScreenFiles.ts are — the Rust backend hands the frontend nothing
// but paths and names (FileEntry/FileMap in Dashboard.tsx), so anything about how a file was last
// *viewed* has to live on this side, keyed by file.path like every other per-file bit of frontend
// state already is:
//
//   1. Playback positions - how far into a video/audio file playback had got. Previously this was
//      an in-memory ref in Dashboard.tsx that only covered audio (audioPositionsRef), so leaving a
//      video for Docs/Board/home and coming back always restarted it at 0.
//   2. Last-opened file per sidebar category - so clicking the Video/Audio/Image/Pdf/Documents tab
//      brings back whatever was last open under that tab instead of leaving whatever unrelated
//      file happened to be on screen.
//
// Positions are written on every timeupdate tick (~4/sec while playing), which is far too often to
// hit localStorage each time, so reads/writes go through an in-memory cache and only get flushed
// out on a timer (and on window teardown). That also means a read is always cheap and always
// current, even between flushes.

import type { FileCategory } from "./fileCategory";

const POSITIONS_KEY = "briefcast.playbackPositions.v1";
const LAST_OPENED_KEY = "briefcast.lastOpenedByCategory.v1";

// A few seconds in isn't a position worth restoring - it's indistinguishable from "start over" to
// anyone watching, and resuming there just looks like the seek bar is broken. Positions below this
// are dropped rather than stored.
const MIN_RESUME_SECONDS = 5;

// Positions accumulate one entry per file ever played, and nothing ever prompts a user to clean
// them out, so the map is capped and evicts least-recently-saved first. A library big enough to
// blow past this is one where the oldest entries are long stale anyway.
const MAX_TRACKED_FILES = 200;

const FLUSH_INTERVAL_MS = 3000;

interface StoredPosition {
  time: number;
  // Used only for eviction ordering, not shown anywhere.
  savedAt: number;
}

type PositionMap = Record<string, StoredPosition>;

export interface LastOpenedFile {
  path: string;
  name: string;
}

type LastOpenedMap = Partial<Record<FileCategory, LastOpenedFile>>;

function readJson<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch (err) {
    console.error(`Failed to load ${key}, resetting:`, err);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Playback positions
// ---------------------------------------------------------------------------

// Loaded once on first touch, then kept as the authoritative copy for the rest of the session -
// localStorage is only ever the write-behind destination, never re-read.
let positions: PositionMap | null = null;
// ReturnType<typeof setTimeout> rather than `number` so the bare (unqualified) setTimeout
// below type-checks under both the DOM and Node lib typings - this module is exercised by
// playbackResume.test.ts, which runs in vitest's `node` environment where `window` doesn't exist.
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function positionMap(): PositionMap {
  if (positions === null) positions = readJson<PositionMap>(POSITIONS_KEY, {});
  return positions;
}

// Writes the in-memory map out now. Exported so a caller can force it at a moment where losing the
// last few seconds of ticks would actually be noticeable (closing a file, unmounting the player)
// instead of waiting for the timer.
export function flushPlaybackPositions(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (positions === null) return;
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch (err) {
    console.error("Failed to persist playback positions:", err);
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPlaybackPositions();
  }, FLUSH_INTERVAL_MS);
}

function evictIfNeeded(map: PositionMap): void {
  const paths = Object.keys(map);
  if (paths.length <= MAX_TRACKED_FILES) return;
  paths
    .sort((a, b) => map[a].savedAt - map[b].savedAt)
    .slice(0, paths.length - MAX_TRACKED_FILES)
    .forEach((path) => delete map[path]);
}

// Where playback of `path` should resume, or undefined for "start at the beginning". Undefined
// rather than 0 so it can be handed straight to VideoPlayer's optional `initialTime` prop.
export function getResumeTime(path: string): number | undefined {
  const stored = positionMap()[path];
  return stored && stored.time >= MIN_RESUME_SECONDS ? stored.time : undefined;
}

// Called from the player's timeupdate round-trip. A position inside the opening seconds clears any
// previously stored one rather than being saved: the user has deliberately gone back to the start,
// and leaving the old position behind would undo that the next time the file is opened.
export function recordPlaybackPosition(path: string, time: number): void {
  if (!Number.isFinite(time) || time < 0) return;
  const map = positionMap();
  if (time < MIN_RESUME_SECONDS) {
    if (map[path]) {
      delete map[path];
      scheduleFlush();
    }
    return;
  }
  map[path] = { time, savedAt: Date.now() };
  evictIfNeeded(map);
  scheduleFlush();
}

// Called when a file plays through to its end - a finished video has no position worth resuming,
// and without this it would reopen a second before the credits and immediately end again.
export function clearPlaybackPosition(path: string): void {
  const map = positionMap();
  if (!map[path]) return;
  delete map[path];
  flushPlaybackPositions();
}

// ---------------------------------------------------------------------------
// Last-opened file per sidebar category
// ---------------------------------------------------------------------------

// Small and written at most once per file open, so unlike positions above this one goes straight
// to localStorage on every write - there's nothing to batch.
let lastOpened: LastOpenedMap | null = null;

function lastOpenedMap(): LastOpenedMap {
  if (lastOpened === null) lastOpened = readJson<LastOpenedMap>(LAST_OPENED_KEY, {});
  return lastOpened;
}

function saveLastOpened(): void {
  try {
    localStorage.setItem(LAST_OPENED_KEY, JSON.stringify(lastOpened ?? {}));
  } catch (err) {
    console.error("Failed to persist last-opened files:", err);
  }
}

export function getLastOpenedFile(category: FileCategory): LastOpenedFile | null {
  const entry = lastOpenedMap()[category];
  return entry && typeof entry.path === "string" && typeof entry.name === "string" ? entry : null;
}

export function recordLastOpenedFile(category: FileCategory, file: LastOpenedFile): void {
  lastOpenedMap()[category] = { path: file.path, name: file.name };
  saveLastOpened();
}

export function forgetLastOpenedFile(category: FileCategory): void {
  const map = lastOpenedMap();
  if (!map[category]) return;
  delete map[category];
  saveLastOpened();
}

// ---------------------------------------------------------------------------
// Path lifecycle - mirrors homeScreenFiles.ts's repathFile/forgetFile, and is called from the same
// rename/move/delete sites, so neither a resume position nor a last-opened entry outlives or goes
// stale against the file it points at.
// ---------------------------------------------------------------------------

export function repathPlaybackState(oldPath: string, newPath: string): void {
  const map = positionMap();
  if (map[oldPath]) {
    map[newPath] = map[oldPath];
    delete map[oldPath];
    flushPlaybackPositions();
  }

  const opened = lastOpenedMap();
  let openedChanged = false;
  (Object.keys(opened) as FileCategory[]).forEach((category) => {
    const entry = opened[category];
    if (entry && entry.path === oldPath) {
      // The name travels with the path - a rename changes both, a move changes only the path, but
      // newPath's basename is correct either way.
      opened[category] = { path: newPath, name: newPath.split(/[\\/]/).pop() || entry.name };
      openedChanged = true;
    }
  });
  if (openedChanged) saveLastOpened();
}

export function forgetPlaybackState(path: string): void {
  const map = positionMap();
  if (map[path]) {
    delete map[path];
    flushPlaybackPositions();
  }

  const opened = lastOpenedMap();
  let openedChanged = false;
  (Object.keys(opened) as FileCategory[]).forEach((category) => {
    if (opened[category]?.path === path) {
      delete opened[category];
      openedChanged = true;
    }
  });
  if (openedChanged) saveLastOpened();
}

// Last line of defence for the pending-flush window: the app closing (or the WebView tearing the
// page down) would otherwise drop up to FLUSH_INTERVAL_MS of position updates. Guarded because
// this module is also imported under vitest's non-DOM environments.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPlaybackPositions);
}
