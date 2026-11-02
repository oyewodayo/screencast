// utils/musicLibrary.ts
//
// The free music & sound-effects library behind MusicLibraryPanel: catalog types (mirroring
// src-tauri/src/commands/music_library.rs), downloads (deduped, so a preview tap and a prefetch of
// the same file share one request), search, "suggested for this video", picking which part of a
// song to use, saved/recent tracks, and the credit line a CC-BY track asks for.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { downloadDir, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { trackEvent } from "./telemetry";
import { AudioLibraryInfo } from "./videoEditTypes";
import { builtinSfxFile, isBuiltinSfxId } from "./builtinSfx";

export interface MusicAsset {
  url: string;
  size: number;
  sha256: string;
  start?: number;
}

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  kind: "music" | "sfx";
  genre?: string;
  moods: string[];
  tags: string[];
  energy?: number;
  duration: number;
  bpm?: number;
  beats?: number[];
  highlightStart?: number;
  peaks: number[];
  file: MusicAsset;
  preview?: MusicAsset;
  license: { name: string; url?: string; attribution?: string; sourceUrl?: string };
}

export interface MusicCatalogResponse {
  catalog: { version: number; updatedAt?: string; tracks: MusicTrack[] };
  fetchedAt: number;
  offline: boolean;
  error?: string | null;
}

export type TrackVariant = "preview" | "full";

export const fetchMusicCatalog = (refresh = false) => invoke<MusicCatalogResponse>("get_music_catalog", { refresh });

const inFlight = new Map<string, Promise<string>>();
// A local, verified copy of the track's preview clip or full file.
export function getTrackFile(trackId: string, variant: TrackVariant): Promise<string> {
  // Briefcast's own sounds are made here, not downloaded (one file for preview and full).
  if (isBuiltinSfxId(trackId)) return builtinSfxFile(trackId);
  const key = `${trackId}:${variant}`;
  let p = inFlight.get(key);
  if (!p) {
    p = invoke<string>("get_music_track_file", { trackId, variant }).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

export function onMusicDownloadProgress(cb: (p: { trackId: string; variant: TrackVariant; downloaded: number; total: number }) => void) {
  return listen<{ trackId: string; variant: TrackVariant; downloaded: number; total: number }>("music-download-progress", (e) => cb(e.payload));
}

export const restoreMusicTrack = (trackId: string, expectedPath: string): Promise<string | null> =>
  isBuiltinSfxId(trackId)
    ? builtinSfxFile(trackId).then((path) => (path === expectedPath ? null : path))
    : invoke<string | null>("restore_music_track", { trackId, expectedPath });

// ---- Downloads ------------------------------------------------------------------------------

// Saving tracks to your computer is free today. This is the one switch to flip if it becomes a paid
// feature - the panel hides the Download buttons when it's false.
export const canDownloadLibraryTracks = (): boolean => true;

// Asks where to save the track (Downloads, named "Title - Artist.m4a"), then writes it there.
// Resolves to the saved path, or null if the dialog was cancelled.
export async function downloadLibraryTrack(track: MusicTrack): Promise<string | null> {
  const ext = track.file.url.split(/[?#]/)[0].split(".").pop()?.toLowerCase() || "m4a";
  const fileName = `${track.title} - ${track.artist}.${ext}`.replace(/[\\/:*?"<>|]/g, "");
  const defaultPath = await downloadDir()
    .then((dir) => join(dir, fileName))
    .catch(() => fileName);
  const dest = await save({ defaultPath, filters: [{ name: "Audio", extensions: [ext] }] });
  if (!dest) return null;
  const saved = await invoke<string>("save_music_track", { trackId: track.id, destPath: dest });
  // Which catalog track and kind only - nothing about the user's files. Tells us whether downloads
  // are worth building on before they're ever charged for.
  trackEvent("music_track_downloaded", { kind: track.kind, track: track.id });
  return saved;
}

// ---- Search & suggestions -------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

// Every word of the query must match somewhere (title, artist, genre, moods, tags); title hits rank
// first, then artist, then the rest - the order a person would expect for "lofi chill" or "ding".
export function searchTracks(tracks: MusicTrack[], query: string): MusicTrack[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return tracks;
  const scored: { t: MusicTrack; score: number }[] = [];
  for (const t of tracks) {
    const title = norm(t.title);
    const artist = norm(t.artist);
    const rest = norm([t.genre ?? "", ...t.moods, ...t.tags].join(" "));
    let score = 0;
    let all = true;
    for (const w of words) {
      if (title.split(/\s+/).some((p) => p.startsWith(w))) score += 4;
      else if (title.includes(w)) score += 3;
      else if (artist.includes(w)) score += 2;
      else if (rest.includes(w)) score += 1;
      else {
        all = false;
        break;
      }
    }
    if (all) scored.push({ t, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.t.title.localeCompare(b.t.title)).map((s) => s.t);
}

export interface VideoContext {
  // Seconds of video the music would cover.
  videoDuration: number;
  // The video has someone talking (its own sound, or a detached voice).
  hasSpeech: boolean;
  // Mostly photos - a montage wants more drive than a talk does.
  isMontage: boolean;
}

// Small stable hash, so ties between equally good tracks break the same way all day but differently
// tomorrow - the list feels alive without reshuffling under the cursor.
function dailyHash(id: string): number {
  const day = Math.floor(Date.now() / 86_400_000);
  let h = 2166136261 ^ day;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// The few songs most likely to fit this video: calm ones under speech, driving ones under a photo
// montage, and long enough from their best part to cover the whole video.
export function suggestTracks(tracks: MusicTrack[], ctx: VideoContext, favourites: Set<string> = new Set(), limit = 6): MusicTrack[] {
  return tracks
    .filter((t) => t.kind === "music")
    .map((t) => {
      const energy = t.energy ?? 3;
      let score = 0;
      if (ctx.hasSpeech) score += energy <= 2 ? 3 : energy === 3 ? 1 : -2;
      else if (ctx.isMontage) score += energy >= 4 ? 3 : energy === 3 ? 1.5 : 0;
      else score += energy === 3 ? 2 : energy === 4 ? 1.5 : 1;
      if (ctx.hasSpeech && t.tags.some((tag) => /background|study|podcast|tutorial/.test(tag))) score += 1;
      const usable = t.duration - (t.highlightStart ?? 0);
      if (usable >= ctx.videoDuration) score += 2;
      else if (t.duration >= ctx.videoDuration) score += 1;
      if (favourites.has(t.id)) score += 0.5;
      return { t, score: score + dailyHash(t.id) * 0.9 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.t);
}

// Which part of a song to use for `wanted` seconds: from its best part when that leaves enough
// song, otherwise as late as still fits, otherwise the whole song.
export function defaultPart(track: Pick<MusicTrack, "duration" | "highlightStart">, wanted: number): { start: number; length: number } {
  const length = Math.max(0.1, Math.min(wanted, track.duration));
  const start = Math.max(0, Math.min(track.highlightStart ?? 0, track.duration - length));
  return { start, length };
}

// Snaps a part's start to the nearest beat within `tolerance`, so a cut-in lands on the groove.
export function snapToBeat(time: number, beats: number[] | undefined, tolerance = 0.25): number {
  if (!beats?.length) return time;
  let best = time;
  let bestDist = tolerance;
  for (const b of beats) {
    const d = Math.abs(b - time);
    if (d < bestDist) [best, bestDist] = [b, d];
    if (b > time + tolerance) break;
  }
  return best;
}

// ---- Credits --------------------------------------------------------------------------------

export function libraryInfoOf(t: MusicTrack): AudioLibraryInfo {
  return {
    trackId: t.id,
    title: t.title,
    artist: t.artist,
    kind: t.kind,
    license: t.license.name,
    ...(t.license.url ? { licenseUrl: t.license.url } : {}),
    ...(t.license.attribution ? { attribution: t.license.attribution } : {}),
    ...(t.license.sourceUrl ? { sourceUrl: t.license.sourceUrl } : {}),
  };
}

export const needsCredit = (info: Pick<AudioLibraryInfo, "license" | "attribution">) => /^CC-BY/i.test(info.license) || !!info.attribution;

export function creditLine(info: AudioLibraryInfo): string {
  if (info.attribution) return info.attribution;
  // "CC-BY-4.0" reads as "CC BY 4.0", the way Creative Commons writes it.
  return `"${info.title}" by ${info.artist}, licensed under ${info.license.replace(/-/g, " ")}${info.licenseUrl ? ` (${info.licenseUrl})` : ""}`;
}

// One "Music:" block for a video description - every library track that asks for credit, once.
export function creditsFor(infos: (AudioLibraryInfo | undefined)[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const info of infos) {
    if (!info || !needsCredit(info) || seen.has(info.trackId)) continue;
    seen.add(info.trackId);
    lines.push(creditLine(info));
  }
  return lines.length ? `Music:\n${lines.join("\n")}` : "";
}

// ---- Saved & recent (per-device conveniences - a blocked localStorage just means none) ---------

const SAVED_KEY = "briefcast.music.saved";
const RECENT_KEY = "briefcast.music.recent";
const RECENT_MAX = 20;

function readIds(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeIds(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Not persisted - fine, it's a convenience.
  }
}

export const readSavedTracks = () => readIds(SAVED_KEY);
export function toggleSavedTrack(id: string): string[] {
  const saved = readIds(SAVED_KEY);
  const next = saved.includes(id) ? saved.filter((x) => x !== id) : [id, ...saved];
  writeIds(SAVED_KEY, next);
  return next;
}
export const readRecentTracks = () => readIds(RECENT_KEY);
export function pushRecentTrack(id: string): string[] {
  const next = [id, ...readIds(RECENT_KEY).filter((x) => x !== id)].slice(0, RECENT_MAX);
  writeIds(RECENT_KEY, next);
  return next;
}

export const formatTrackTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
