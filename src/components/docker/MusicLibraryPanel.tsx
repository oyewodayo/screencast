// components/docker/MusicLibraryPanel.tsx
//
// The editor's free music & sound-effects library: browse or search, tap to hear a song instantly
// (its short preview clip, already fetched for the first rows), pick which part of it to use on a
// waveform that opens at the song's best part, and add it - downloaded, verified, placed at the
// playhead with its fades, beats and ducking already set up. Sound effects add in one click.
//
// Docked into the sidebar's Tools tab when it's there (ToolPanelHost), floating otherwise, like
// the other editor panels. The catalog and every file come through Rust (music_library.rs) -
// cached on disk, so the library keeps working offline for whatever has been used before.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoAdd, IoBookmark, IoBookmarkOutline, IoCheckmark, IoClose, IoCloudOfflineOutline, IoDownloadOutline, IoFolderOpenOutline, IoMusicalNotes, IoPause, IoPlay, IoRefreshOutline, IoSearchOutline, IoSparkles } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import {
  canDownloadLibraryTracks,
  defaultPart,
  downloadLibraryTrack,
  fetchMusicCatalog,
  formatTrackTime,
  getTrackFile,
  MusicTrack,
  needsCredit,
  onMusicDownloadProgress,
  pushRecentTrack,
  readRecentTracks,
  readSavedTracks,
  searchTracks,
  snapToBeat,
  suggestTracks,
  toggleSavedTrack,
  VideoContext,
} from "../../utils/musicLibrary";
import { DOCKED_PANEL_CLASS, useDockSnap, useFloatingDismiss, useToolPanelHost } from "./ToolPanelHost";
import { BUILTIN_SFX_TRACKS, isBuiltinSfxId } from "../../utils/builtinSfx";
import AiVoicePanel from "./AiVoicePanel";
import VoiceRecorder from "./VoiceRecorder";

export interface TrackBeats {
  bpm: number;
  beats: number[];
}

interface MusicLibraryPanelProps {
  anchor: { left: number; top: number };
  // Where an added track starts on the output timeline, and how much video is left from there.
  placeAt: number;
  videoDuration: number;
  context: VideoContext;
  timelinePlaying: boolean;
  // Called as a preview starts, so the timeline isn't playing underneath it.
  onPreviewStart: () => void;
  // Returns the new overlay's id.
  onAdd: (track: MusicTrack, path: string, part: { start: number; length: number }, beats: TrackBeats | undefined) => string;
  // Beats that were still being detected when the track was added.
  onLateBeats: (overlayId: string, beats: TrackBeats) => void;
  onPickFile: () => void;
  // The Record tab (VoiceRecorder): the playhead, the transport, and placing a take.
  recordAt: number;
  onTimelinePlay: (play: boolean) => void;
  onSeek: (time: number) => void;
  onTakes: (takes: { path: string; seconds: number; label: string }[], at: number, replaces: string[]) => string[];
  onClose: () => void;
}

type Filter = "foryou" | "all" | "saved" | "recent" | `mood:${string}`;
type Catalog = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; tracks: MusicTrack[]; offline: boolean; error?: string | null };

const PREFETCH_ROWS = 4;
const BEATS_WAIT_MS = 1500;
const MIN_PART_SEC = 1;

// A stable colour per track for its tile - no cover art to fetch, and the list still reads at a glance.
function tileStyle(id: string): React.CSSProperties {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return { background: `linear-gradient(135deg, hsl(${h} 55% 46%), hsl(${(h + 45) % 360} 60% 28%))` };
}

// Peaks resampled to `bars` (max per bucket), as one SVG path - a single element per waveform.
function waveformPath(peaks: number[], bars: number, height: number): string {
  if (peaks.length === 0) return "";
  let d = "";
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i / bars) * peaks.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * peaks.length));
    let p = 0;
    for (let j = from; j < to; j++) p = Math.max(p, peaks[j] ?? 0);
    const h = Math.max(1, (p / 100) * height);
    d += `M${i + 0.5} ${(height - h) / 2}v${h}`;
  }
  return d;
}

// A glowing line that runs around the play tile as the track plays - a progress bar shaped like the
// button. Frozen where it is while paused; gone when nothing's playing. Drawn straight onto the SVG
// each animation frame (never through React state), so only the one tile on screen does any work.
const PlayRing: React.FC<{ state: "playing" | "paused"; getProgress: () => number | null }> = ({ state, getProgress }) => {
  const lineRef = useRef<SVGRectElement>(null);
  useEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    const draw = () => {
      const p = getProgress();
      if (p != null && Number.isFinite(p)) line.style.strokeDashoffset = String(100 - Math.max(0, Math.min(1, p)) * 100);
    };
    draw();
    if (state !== "playing") return;
    let raf = 0;
    const tick = () => {
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, getProgress]);
  return (
    <svg viewBox="0 0 36 36" className="absolute inset-0 w-full h-full pointer-events-none overflow-visible" aria-hidden>
      <rect x={1} y={1} width={34} height={34} rx={6} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={1.5} />
      <rect
        ref={lineRef}
        x={1}
        y={1}
        width={34}
        height={34}
        rx={6}
        fill="none"
        stroke="white"
        strokeWidth={2}
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray="100"
        strokeDashoffset="100"
        style={{ filter: "drop-shadow(0 0 2px rgba(255,255,255,0.95)) drop-shadow(0 0 5px rgba(255,255,255,0.55))" }}
      />
    </svg>
  );
};

interface RowProps {
  track: MusicTrack;
  expanded: boolean;
  saved: boolean;
  playing: boolean;
  loading: boolean;
  onToggleExpand: (t: MusicTrack) => void;
  onTogglePlay: (t: MusicTrack) => void;
  onToggleSaved: (id: string) => void;
  onQuickAdd: (t: MusicTrack) => void;
  // Save to your computer - absent when downloads are switched off (canDownloadLibraryTracks).
  onDownload?: (t: MusicTrack) => void;
  download?: "saving" | "saved";
  // The progress ring around the play tile - only for the track that's playing or paused.
  ring?: "playing" | "paused";
  getProgress: () => number | null;
  children?: React.ReactNode;
}

const TrackRow = memo(({ track, expanded, saved, playing, loading, onToggleExpand, onTogglePlay, onToggleSaved, onQuickAdd, onDownload, download, ring, getProgress, children }: RowProps) => {
  const isSfx = track.kind === "sfx";
  const subtitle = isSfx ? track.tags.slice(0, 2).join(" · ") : [track.artist, track.genre].filter(Boolean).join(" · ");
  return (
    <li className={`group/row rounded-md ${expanded ? "bg-white/[0.06] ring-1 ring-teal-400/30" : "hover:bg-white/[0.04]"}`}>
      <div className="flex items-center gap-2 px-1.5 py-1.5">
        <button
          type="button"
          onClick={() => onTogglePlay(track)}
          title={playing ? "Pause" : isSfx ? "Play this sound" : "Play a preview"}
          className="relative shrink-0 w-9 h-9 rounded-md flex items-center justify-center text-white shadow-inner group"
          style={tileStyle(track.id)}
        >
          {loading ? (
            <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
          ) : playing ? (
            <IoPause size={15} />
          ) : ring === "paused" ? (
            <IoPlay size={15} className="ml-0.5" />
          ) : (
            <>
              <IoMusicalNotes size={14} className="opacity-70 group-hover:opacity-0 transition-opacity" />
              <IoPlay size={15} className="absolute ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
            </>
          )}
          {ring && !loading && <PlayRing state={ring} getProgress={getProgress} />}
        </button>
        <button type="button" onClick={() => (isSfx ? onTogglePlay(track) : onToggleExpand(track))} className="flex-1 min-w-0 text-left" title={isSfx ? track.title : "Choose the part to use"}>
          <div className={`text-xs font-medium truncate ${playing ? "text-teal-300" : "text-white/90"}`}>{track.title}</div>
          <div className="text-[10px] text-white/45 truncate">{subtitle}</div>
        </button>
        {/* The length, swapped for a Download button while the row is hovered (or while saving). */}
        <span className={`shrink-0 w-8 text-right text-[10px] tabular-nums text-white/45 ${onDownload ? "group-hover/row:hidden" : ""} ${download ? "hidden" : ""}`}>
          {isSfx ? `${track.duration.toFixed(1)}s` : formatTrackTime(track.duration)}
        </span>
        {onDownload && (
          <button
            type="button"
            onClick={() => onDownload(track)}
            disabled={download === "saving"}
            title={download === "saved" ? "Saved to your computer" : "Download to your computer"}
            className={`shrink-0 w-8 h-6 items-center justify-end rounded ${download ? "flex" : "hidden group-hover/row:flex"} ${
              download === "saved" ? "text-teal-300" : "text-white/55 hover:text-white"
            }`}
          >
            {download === "saving" ? (
              <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            ) : download === "saved" ? (
              <IoCheckmark size={14} />
            ) : (
              <IoDownloadOutline size={14} />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => onToggleSaved(track.id)}
          title={saved ? "Remove from Saved" : "Save for later"}
          className={`shrink-0 p-1 rounded hover:bg-white/10 ${saved ? "text-teal-300" : "text-white/35 hover:text-white/80"}`}
        >
          {saved ? <IoBookmark size={13} /> : <IoBookmarkOutline size={13} />}
        </button>
        <button
          type="button"
          onClick={() => (isSfx ? onQuickAdd(track) : onToggleExpand(track))}
          title={isSfx ? "Add at the playhead" : "Choose the part, then add"}
          className="shrink-0 p-1 rounded-full bg-white/5 hover:bg-teal-500 text-white/70 hover:text-white"
        >
          <IoAdd size={14} />
        </button>
      </div>
      {children}
    </li>
  );
});

interface PartPickerProps {
  track: MusicTrack;
  part: { start: number; length: number };
  wanted: number;
  beats: number[] | undefined;
  playhead: number | null;
  playing: boolean;
  fullReady: boolean;
  progress: number | null;
  adding: boolean;
  error: string | null;
  onChange: (part: { start: number; length: number }) => void;
  onTogglePlay: () => void;
  onAdd: () => void;
}

// The song's whole waveform with the part that will play highlighted: drag the window to move it,
// click anywhere to centre it there. The start snaps to the beat when the beats are known.
const PartPicker: React.FC<PartPickerProps> = ({ track, part, wanted, beats, playhead, playing, fullReady, progress, adding, error, onChange, onTogglePlay, onAdd }) => {
  const stripRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ grabOffset: number } | null>(null);
  const path = useMemo(() => waveformPath(track.peaks, 120, 40), [track.peaks]);
  const d = track.duration;
  const timeAt = (clientX: number) => {
    const rect = stripRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(d, ((clientX - rect.left) / rect.width) * d));
  };
  const moveTo = (start: number) => onChange({ start: Math.max(0, Math.min(snapToBeat(start, beats), d - part.length)), length: part.length });
  const setLength = (length: number) => {
    const l = Math.max(MIN_PART_SEC, Math.min(length, d));
    onChange({ start: Math.min(part.start, d - l), length: l });
  };
  const lengths = [
    { label: "Fit video", value: wanted, title: "As long as the rest of the video" },
    { label: "15s", value: 15 },
    { label: "30s", value: 30 },
    { label: "Full", value: d, title: "The whole song" },
  ].filter((l, i, all) => l.value > 0 && all.findIndex((o) => Math.abs(o.value - l.value) < 0.5) === i);

  return (
    <div className="px-2 pb-2 flex flex-col gap-2">
      <div
        ref={stripRef}
        className="relative h-12 rounded bg-black/30 cursor-pointer select-none touch-none"
        onPointerDown={(e) => {
          const t = timeAt(e.clientX);
          e.currentTarget.setPointerCapture(e.pointerId);
          if (t >= part.start && t <= part.start + part.length) dragRef.current = { grabOffset: t - part.start };
          else {
            dragRef.current = { grabOffset: part.length / 2 };
            moveTo(t - part.length / 2);
          }
        }}
        onPointerMove={(e) => dragRef.current && moveTo(timeAt(e.clientX) - dragRef.current.grabOffset)}
        onPointerUp={() => (dragRef.current = null)}
        onPointerCancel={() => (dragRef.current = null)}
      >
        <svg viewBox="0 0 120 40" preserveAspectRatio="none" className="absolute inset-0 w-full h-full text-white/25" aria-hidden>
          <path d={path} stroke="currentColor" strokeWidth={0.55} />
        </svg>
        <div
          className="absolute inset-y-0 rounded border-2 border-teal-400 bg-teal-400/15 overflow-hidden pointer-events-none"
          style={{ left: `${(part.start / d) * 100}%`, width: `${(part.length / d) * 100}%` }}
        >
          <svg
            viewBox="0 0 120 40"
            preserveAspectRatio="none"
            className="absolute inset-y-0 h-full text-teal-200"
            style={{ left: `${(-part.start / part.length) * 100}%`, width: `${(d / part.length) * 100}%` }}
            aria-hidden
          >
            <path d={path} stroke="currentColor" strokeWidth={0.55} />
          </svg>
        </div>
        {track.highlightStart != null && (
          <div title="The song's best part" className="absolute -top-1 w-1.5 h-1.5 rounded-full bg-amber-300 -ml-[3px] pointer-events-none" style={{ left: `${(track.highlightStart / d) * 100}%` }} />
        )}
        {playhead != null && <div className="absolute inset-y-0 w-px bg-white pointer-events-none" style={{ left: `${(playhead / d) * 100}%` }} />}
      </div>
      <div className="flex items-center justify-between text-[10px] tabular-nums text-white/50">
        <span>
          {formatTrackTime(part.start)} – {formatTrackTime(part.start + part.length)}
        </span>
        <span>{part.length < 60 ? `${part.length.toFixed(1)}s` : formatTrackTime(part.length)} used</span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {lengths.map((l) => (
          <button
            key={l.label}
            type="button"
            title={l.title}
            onClick={() => setLength(l.value)}
            className={`px-1.5 py-0.5 rounded text-[10px] ${Math.abs(part.length - Math.min(l.value, d)) < 0.05 ? "bg-teal-500/25 text-teal-200" : "bg-white/5 text-white/70 hover:bg-white/15"}`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onTogglePlay} className="flex items-center gap-1 h-7 px-2.5 rounded-full text-[11px] bg-white/10 hover:bg-white/15 text-white/90" title="Hear exactly this part">
          {playing ? <IoPause size={12} /> : <IoPlay size={12} />}
          {playing ? "Pause" : "Play part"}
        </button>
        <button type="button" onClick={onAdd} disabled={adding} className="flex-1 h-7 rounded-full text-[11px] font-medium bg-teal-500 hover:bg-teal-400 disabled:bg-teal-700 text-white">
          {adding ? (progress != null && !fullReady ? `Downloading… ${Math.round(progress * 100)}%` : "Adding…") : "Add to video"}
        </button>
      </div>
      {needsCredit({ license: track.license.name, attribution: track.license.attribution }) && (
        <p className="text-[10px] leading-snug text-white/45">Free to use with credit ({track.license.name.replace(/-/g, " ")}) - the line to paste is in the track's panel once added.</p>
      )}
      {error && <p className="text-[10px] leading-snug text-red-300">{error}</p>}
    </div>
  );
};

const MusicLibraryPanel: React.FC<MusicLibraryPanelProps> = ({ anchor, placeAt, videoDuration, context, timelinePlaying, onPreviewStart, onAdd, onLateBeats, onPickFile, recordAt, onTimelinePlay, onSeek, onTakes, onClose }) => {
  const dockHost = useToolPanelHost();
  const { ref: panelRef, position } = useClampedPopoverPosition(anchor);
  const [catalog, setCatalog] = useState<Catalog>({ status: "loading" });
  const [tab, setTab] = useState<"music" | "sfx">("music");
  // The Record tab is open (the library's own tab is kept for coming back to).
  const [recordOpen, setRecordOpen] = useState(false);
  // The AI voice tab (AiVoicePanel), the same way.
  const [voiceOpen, setVoiceOpen] = useState(false);
  const tabStripRef = useRef<HTMLDivElement>(null);
  // Keep the chosen tab in view when the strip is narrower than its tabs.
  useEffect(() => {
    const on = tabStripRef.current?.querySelector<HTMLElement>("[data-tab-on]");
    on?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, recordOpen, voiceOpen]);
  const [filter, setFilter] = useState<Filter>("foryou");
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState<string[]>(readSavedTracks);
  const [recent, setRecent] = useState<string[]>(readRecentTracks);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [part, setPart] = useState<{ start: number; length: number }>({ start: 0, length: 30 });
  const [fullPaths, setFullPaths] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [detectedBeats, setDetectedBeats] = useState<Record<string, TrackBeats>>({});
  const [addingId, setAddingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // What's playing: a row's preview clip, or the expanded song's chosen part.
  const [playing, setPlaying] = useState<{ id: string; mode: "row" | "part" } | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [partPlayhead, setPartPlayhead] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Where in the song the loaded file starts (a preview clip starts at its own `start`), and where to stop.
  // Where in the song the loaded file starts, where this playback began (song time) and where to stop.
  const playMapRef = useRef<{ offset: number; stopAt: number | null; from: number }>({ offset: 0, stopAt: null, from: 0 });
  // Paused by the user (resumes where it stopped) - as opposed to stopped, ended or replaced.
  const [paused, setPaused] = useState<{ id: string; mode: "row" | "part" } | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const userPauseRef = useRef(false);
  const beatJobs = useRef(new Map<string, Promise<TrackBeats | undefined>>());
  const playToken = useRef(0);

  const wanted = Math.max(MIN_PART_SEC, videoDuration - placeAt || 30);

  const load = useCallback((refresh: boolean) => {
    setCatalog((c) => (c.status === "ready" ? c : { status: "loading" }));
    fetchMusicCatalog(refresh)
      .then((r) => setCatalog({ status: "ready", tracks: r.catalog.tracks, offline: r.offline, error: r.error }))
      .catch((err) => setCatalog({ status: "error", error: String(err) }));
  }, []);
  useEffect(() => load(false), [load]);

  useEffect(() => {
    const unlisten = onMusicDownloadProgress((p) => p.variant === "full" && setProgress((prev) => ({ ...prev, [p.trackId]: p.total ? p.downloaded / p.total : 0 })));
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Closing the panel stops the preview; the timeline starting does too.
  useEffect(() => {
    const audio = audioRef.current;
    return () => audio?.pause();
  }, []);
  useEffect(() => {
    if (timelinePlaying) audioRef.current?.pause();
  }, [timelinePlaying]);

  // A click elsewhere closes it - unless that click opened the sidebar, which docks it instead.
  useFloatingDismiss("[data-music-library-panel], [data-music-library-button]", onClose, !!dockHost);
  useDockSnap(panelRef, !!dockHost);

  // The catalog plus Briefcast's own sound effects (made on the spot - always there, even offline).
  const tracks = useMemo(() => (catalog.status === "ready" ? [...catalog.tracks, ...BUILTIN_SFX_TRACKS] : []), [catalog]);
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const savedSet = useMemo(() => new Set(saved), [saved]);
  const tabTracks = useMemo(() => tracks.filter((t) => t.kind === tab), [tracks, tab]);
  const moods = useMemo(() => {
    const counts = new Map<string, number>();
    tabTracks.forEach((t) => t.moods.forEach((m) => counts.set(m, (counts.get(m) ?? 0) + 1)));
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([m]) => m);
  }, [tabTracks]);

  const effectiveFilter: Filter = tab === "sfx" && filter === "foryou" ? "all" : filter;
  const { suggested, list } = useMemo(() => {
    if (query.trim()) return { suggested: [] as MusicTrack[], list: searchTracks(tabTracks, query) };
    if (effectiveFilter === "saved") return { suggested: [], list: saved.map((id) => byId.get(id)).filter((t): t is MusicTrack => !!t && t.kind === tab) };
    if (effectiveFilter === "recent") return { suggested: [], list: recent.map((id) => byId.get(id)).filter((t): t is MusicTrack => !!t && t.kind === tab) };
    if (effectiveFilter.startsWith("mood:")) {
      const mood = effectiveFilter.slice(5);
      return { suggested: [], list: tabTracks.filter((t) => t.moods.includes(mood)) };
    }
    const sorted = [...tabTracks].sort((a, b) => a.title.localeCompare(b.title));
    if (effectiveFilter === "foryou") {
      const top = suggestTracks(tabTracks, context, savedSet);
      const topIds = new Set(top.map((t) => t.id));
      return { suggested: top, list: sorted.filter((t) => !topIds.has(t.id)) };
    }
    return { suggested: [], list: sorted };
  }, [query, effectiveFilter, tabTracks, saved, recent, byId, tab, context, savedSet]);

  // Fetch the first few previews ahead of a tap, so the first plays start instantly.
  const visibleKey = [...suggested, ...list]
    .slice(0, PREFETCH_ROWS)
    .map((t) => t.id)
    .join("|");
  useEffect(() => {
    if (!visibleKey) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      for (const id of visibleKey.split("|")) {
        if (cancelled) return;
        await getTrackFile(id, "preview").catch(() => undefined);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [visibleKey]);

  const beatsFor = useCallback((t: MusicTrack, path: string): Promise<TrackBeats | undefined> => {
    if (t.bpm && t.beats?.length) return Promise.resolve({ bpm: t.bpm, beats: t.beats });
    let job = beatJobs.current.get(t.id);
    if (!job) {
      job = invoke<TrackBeats>("detect_beats", { sourcePath: path })
        .then((b) => {
          setDetectedBeats((prev) => ({ ...prev, [t.id]: b }));
          return b;
        })
        .catch(() => undefined);
      beatJobs.current.set(t.id, job);
    }
    return job;
  }, []);

  const fetchFull = useCallback(
    (t: MusicTrack) =>
      getTrackFile(t.id, "full").then((path) => {
        setFullPaths((prev) => (prev[t.id] === path ? prev : { ...prev, [t.id]: path }));
        if (t.kind === "music") void beatsFor(t, path);
        return path;
      }),
    [beatsFor],
  );

  const stop = useCallback(() => {
    playToken.current++;
    audioRef.current?.pause();
    setPlaying(null);
    setPaused(null);
    setLoadingId(null);
  }, []);

  // Plays `variant` of a track from `from` (seconds into the song) until `to`.
  const play = useCallback(
    async (t: MusicTrack, mode: "row" | "part", variant: "preview" | "full", from: number, to: number | null) => {
      const token = ++playToken.current;
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      setPaused(null);
      setLoadingId(t.id);
      try {
        const path = variant === "full" ? await fetchFull(t) : await getTrackFile(t.id, "preview");
        if (token !== playToken.current) return;
        const offset = variant === "preview" ? (t.preview?.start ?? 0) : 0;
        playMapRef.current = { offset, stopAt: to, from };
        const src = convertFileSrc(path);
        if (audio.src !== src) audio.src = src;
        audio.currentTime = Math.max(0, from - offset);
        onPreviewStart();
        await audio.play();
        if (token === playToken.current) setPlaying({ id: t.id, mode });
      } catch (err) {
        // AbortError: this play() was superseded (another tap, a pause) - not a failure.
        if (token === playToken.current && (err as Error)?.name !== "AbortError") setErrors((prev) => ({ ...prev, [t.id]: String(err) }));
      } finally {
        if (token === playToken.current) setLoadingId(null);
      }
    },
    [fetchFull, onPreviewStart],
  );

  // Rows are memoized; these read the latest state through refs so their identity never changes.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const pauseCurrent = useCallback(() => {
    const current = playingRef.current;
    if (!current) return;
    userPauseRef.current = true;
    setPaused(current);
    audioRef.current?.pause();
  }, []);
  const resume = useCallback(() => {
    const p = pausedRef.current;
    const audio = audioRef.current;
    if (!p || !audio) return;
    onPreviewStart();
    audio
      .play()
      .then(() => {
        setPlaying(p);
        setPaused(null);
      })
      .catch(() => {});
  }, [onPreviewStart]);
  const toggleRowPlay = useCallback(
    (t: MusicTrack) => {
      const p = playingRef.current ?? pausedRef.current;
      if (playingRef.current?.id === t.id) return pauseCurrent();
      if (p?.id === t.id && pausedRef.current) return resume();
      void play(t, "row", "preview", t.preview?.start ?? 0, null);
    },
    [play, pauseCurrent, resume],
  );
  // How far through the current playback is, 0..1 - the part being heard, or the whole clip.
  const getProgress = useCallback((): number | null => {
    const a = audioRef.current;
    if (!a) return null;
    const { offset, stopAt, from } = playMapRef.current;
    if (stopAt != null && stopAt > from) return (a.currentTime + offset - from) / (stopAt - from);
    return a.duration > 0 ? a.currentTime / a.duration : 0;
  }, []);

  const expandedIdRef = useRef(expandedId);
  expandedIdRef.current = expandedId;
  const expand = useCallback(
    (t: MusicTrack) => {
      if (expandedIdRef.current === t.id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(t.id);
      setPart(defaultPart(t, wanted));
      setErrors((prev) => ({ ...prev, [t.id]: "" }));
      // Expanding is intent: start fetching the song now so "Play part" and "Add" are instant.
      fetchFull(t).catch((err) => setErrors((prev) => ({ ...prev, [t.id]: String(err) })));
    },
    [wanted, fetchFull],
  );

  const togglePartPlay = (t: MusicTrack) => {
    if (playing?.id === t.id && playing.mode === "part") return pauseCurrent();
    if (paused?.id === t.id && paused.mode === "part") return resume();
    // The preview clip covers the part? Play that while the song is still downloading.
    const p = t.preview;
    const inPreview = p?.start != null && part.start >= p.start && part.start + Math.min(part.length, 8) <= p.start + 30;
    const variant = fullPaths[t.id] || !inPreview ? "full" : "preview";
    void play(t, "part", variant, part.start, part.start + part.length);
  };

  const toggleSaved = useCallback((id: string) => setSaved(toggleSavedTrack(id)), []);

  const [downloads, setDownloads] = useState<Record<string, "saving" | "saved">>({});
  const download = useCallback((t: MusicTrack) => {
    const clear = () =>
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[t.id];
        return next;
      });
    setDownloads((prev) => ({ ...prev, [t.id]: "saving" }));
    downloadLibraryTrack(t)
      .then((path) => {
        if (!path) return clear(); // cancelled
        setDownloads((prev) => ({ ...prev, [t.id]: "saved" }));
        window.setTimeout(clear, 2500);
      })
      .catch((err) => {
        clear();
        setErrors((prev) => ({ ...prev, [t.id]: String(err) }));
      });
  }, []);
  const downloadsOn = canDownloadLibraryTracks();

  const add = async (t: MusicTrack, chosen: { start: number; length: number }) => {
    setAddingId(t.id);
    setErrors((prev) => ({ ...prev, [t.id]: "" }));
    try {
      const path = await fetchFull(t);
      let beats: TrackBeats | undefined;
      let lateJob: Promise<TrackBeats | undefined> | null = null;
      if (t.kind === "music") {
        const job = beatsFor(t, path);
        beats = await Promise.race([job, new Promise<undefined>((r) => window.setTimeout(r, BEATS_WAIT_MS))]);
        if (!beats) lateJob = job;
      }
      stop();
      const id = onAdd(t, path, chosen, beats);
      setRecent(pushRecentTrack(t.id));
      if (lateJob && id) void lateJob.then((b) => b && onLateBeats(id, b));
    } catch (err) {
      setErrors((prev) => ({ ...prev, [t.id]: String(err) }));
    } finally {
      setAddingId(null);
    }
  };
  const addRef = useRef(add);
  addRef.current = add;
  const quickAdd = useCallback((t: MusicTrack) => void addRef.current(t, { start: 0, length: t.duration }), []);

  const renderRow = (t: MusicTrack) => {
    const expanded = expandedId === t.id && t.kind === "music";
    // Only the expanded row (or one showing an error) gets children - a fresh JSX child on every row
    // would defeat TrackRow's memo and re-render the whole list on each preview tick.
    const extra = expanded ? (
      <PartPicker
        track={t}
        part={part}
        wanted={wanted}
        beats={t.beats ?? detectedBeats[t.id]?.beats}
        playhead={playing?.id === t.id && playing.mode === "part" ? partPlayhead : null}
        playing={playing?.id === t.id && playing.mode === "part"}
        fullReady={!!fullPaths[t.id]}
        progress={progress[t.id] ?? null}
        adding={addingId === t.id}
        error={errors[t.id] || null}
        onChange={(p) => {
          setPart(p);
          if ((playing ?? paused)?.id === t.id && (playing ?? paused)?.mode === "part") stop();
        }}
        onTogglePlay={() => togglePartPlay(t)}
        onAdd={() => void add(t, part)}
      />
    ) : errors[t.id] ? (
      <p className="px-2 pb-1.5 text-[10px] text-red-300">{errors[t.id]}</p>
    ) : undefined;
    return (
      <TrackRow
        key={t.id}
        track={t}
        expanded={expanded}
        saved={savedSet.has(t.id)}
        playing={playing?.id === t.id}
        loading={loadingId === t.id}
        ring={playing?.id === t.id ? "playing" : paused?.id === t.id ? "paused" : undefined}
        getProgress={getProgress}
        onToggleExpand={expand}
        onTogglePlay={toggleRowPlay}
        onToggleSaved={toggleSaved}
        onQuickAdd={quickAdd}
        onDownload={downloadsOn && !isBuiltinSfxId(t.id) ? download : undefined}
        download={downloads[t.id]}
      >
        {extra}
      </TrackRow>
    );
  };

  const chip = (value: Filter, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => {
        setFilter(value);
        setQuery("");
      }}
      className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] capitalize transition-colors ${
        effectiveFilter === value && !query ? "bg-teal-500 text-white" : "bg-white/5 text-white/65 hover:bg-white/10 hover:text-white"
      }`}
    >
      {label}
    </button>
  );

  const emptyText = query.trim()
    ? `Nothing matches "${query.trim()}".`
    : effectiveFilter === "saved"
      ? "Tap the bookmark on any track to keep it here."
      : effectiveFilter === "recent"
        ? "Tracks you add show up here."
        : "Nothing here yet.";

  return createPortal(
    <div
      ref={panelRef}
      data-music-library-panel
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={dockHost ? `${DOCKED_PANEL_CLASS} p-3 gap-2.5` : "w-80 h-[min(600px,calc(100vh-16px))] p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !query) onClose();
      }}
    >
      <audio
        ref={audioRef}
        preload="auto"
        onPause={() => {
          setPlaying(null);
          // Anything but the user's own pause (the timeline starting, a part reaching its end) stops.
          if (!userPauseRef.current) setPaused(null);
          userPauseRef.current = false;
        }}
        onEnded={() => {
          setPlaying(null);
          setPaused(null);
        }}
        onTimeUpdate={(e) => {
          const { offset, stopAt } = playMapRef.current;
          const songTime = e.currentTarget.currentTime + offset;
          setPartPlayhead(songTime);
          if (stopAt != null && songTime >= stopAt) e.currentTarget.pause();
        }}
      />

      <div className="flex items-center gap-2">
        <IoMusicalNotes size={14} className="text-teal-300 shrink-0" />
        <div
          ref={tabStripRef}
          // Tabs scroll sideways rather than wrapping onto two lines; the wheel scrolls them too.
          onWheel={(e) => {
            if (e.deltaY !== 0 && e.currentTarget.scrollWidth > e.currentTarget.clientWidth) e.currentTarget.scrollLeft += e.deltaY;
          }}
          className="flex min-w-0 p-0.5 rounded-md bg-white/5 text-[11px] whitespace-nowrap overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>button]:shrink-0"
        >
          {(["music", "sfx"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setTab(k);
                setRecordOpen(false);
                setVoiceOpen(false);
                setExpandedId(null);
              }}
              data-tab-on={tab === k && !recordOpen && !voiceOpen ? "" : undefined}
              className={`px-2 py-0.5 rounded ${tab === k && !recordOpen && !voiceOpen ? "bg-white/15 text-white" : "text-white/55 hover:text-white"}`}
            >
              {k === "music" ? "Music" : "Sound effects"}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setRecordOpen(true);
              setVoiceOpen(false);
              audioRef.current?.pause();
            }}
            title="Record a voice-over (or anything) straight onto the timeline"
            data-tab-on={recordOpen ? "" : undefined}
            className={`flex items-center gap-1 px-2 py-0.5 rounded ${recordOpen ? "bg-white/15 text-white" : "text-white/55 hover:text-white"}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${recordOpen ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.9)]" : "bg-red-500/70"}`} />
            Record
          </button>
          <button
            type="button"
            onClick={() => {
              setVoiceOpen(true);
              setRecordOpen(false);
              audioRef.current?.pause();
            }}
            title="Turn a script into a natural-sounding voice-over - made on this PC"
            data-tab-on={voiceOpen ? "" : undefined}
            className={`flex items-center gap-1 px-2 py-0.5 rounded ${voiceOpen ? "bg-white/15 text-white" : "text-white/55 hover:text-white"}`}
          >
            <IoSparkles size={11} className={voiceOpen ? "text-teal-300" : "text-teal-300/70"} />
            AI voice
          </button>
        </div>
        <span className="flex-1" />
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      {voiceOpen ? (
        <AiVoicePanel placeAt={recordAt} timelinePlaying={timelinePlaying} onTimelinePlay={onTimelinePlay} onSeek={onSeek} onTakes={onTakes} />
      ) : recordOpen ? (
        <VoiceRecorder recordAt={recordAt} timelinePlaying={timelinePlaying} onTimelinePlay={onTimelinePlay} onSeek={onSeek} onTakes={onTakes} />
      ) : (
      <>
      <label className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-white/[0.07] focus-within:ring-1 focus-within:ring-teal-400">
        <IoSearchOutline size={13} className="text-white/40 shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder={tab === "music" ? "Search songs, moods, genres" : "Search sound effects"}
          className="flex-1 min-w-0 bg-transparent text-xs text-white placeholder:text-white/35 outline-none"
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} className="text-white/40 hover:text-white">
            <IoClose size={12} />
          </button>
        )}
      </label>

      <div className="flex gap-1 overflow-x-auto pb-0.5 -mx-0.5 px-0.5 [scrollbar-width:none]">
        {tab === "music" && chip("foryou", "For you")}
        {chip("all", "All")}
        {chip("saved", "Saved")}
        {chip("recent", "Recent")}
        {moods.map((m) => chip(`mood:${m}`, m))}
      </div>

      {catalog.status === "ready" && catalog.offline && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-amber-500/10 text-[10px] text-amber-200/90" title={catalog.error ?? undefined}>
          <IoCloudOfflineOutline size={12} className="shrink-0" />
          <span className="flex-1">Offline - showing the library as last seen. Tracks you've used still work.</span>
          <button type="button" onClick={() => load(true)} className="underline hover:text-white">
            Retry
          </button>
        </div>
      )}

      {/* Floating, the panel has a fixed height (so it's placed on-screen from the moment it opens,
          before the list has loaded) and the list takes whatever's left of it. */}
      <div className={`overflow-y-auto -mx-1 px-1 ${dockHost ? "max-h-[60vh]" : "flex-1 min-h-0"}`}>
        {catalog.status === "loading" && (
          <ul className="flex flex-col gap-1" aria-busy>
            {Array.from({ length: 5 }, (_, i) => (
              <li key={i} className="flex items-center gap-2 px-1.5 py-1.5">
                <div className="w-9 h-9 rounded-md bg-white/[0.06] animate-pulse" />
                <div className="flex-1 flex flex-col gap-1.5">
                  <div className="h-2.5 w-2/3 rounded bg-white/[0.06] animate-pulse" />
                  <div className="h-2 w-1/3 rounded bg-white/[0.04] animate-pulse" />
                </div>
              </li>
            ))}
          </ul>
        )}
        {catalog.status === "error" && (
          <div className="flex flex-col items-center gap-2 py-6 px-3 text-center">
            <IoCloudOfflineOutline size={22} className="text-white/35" />
            <p className="text-[11px] leading-snug text-white/60">{catalog.error}</p>
            <button type="button" onClick={() => load(true)} className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] bg-white/10 hover:bg-white/15">
              <IoRefreshOutline size={12} /> Try again
            </button>
          </div>
        )}
        {catalog.status === "ready" && (
          <>
            {suggested.length > 0 && (
              <>
                <div className="px-1.5 pt-0.5 pb-1 text-[10px] uppercase tracking-wide text-white/40">Suggested for this video</div>
                <ul className="flex flex-col gap-0.5 mb-2">{suggested.map(renderRow)}</ul>
                {list.length > 0 && <div className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-white/40">More music</div>}
              </>
            )}
            {list.length > 0 ? <ul className="flex flex-col gap-0.5">{list.map(renderRow)}</ul> : suggested.length === 0 && <p className="py-6 text-center text-[11px] text-white/45">{emptyText}</p>}
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/10">
        <button type="button" onClick={onPickFile} className="flex items-center gap-1.5 text-[11px] text-white/60 hover:text-white">
          <IoFolderOpenOutline size={13} /> Use a file from your computer…
        </button>
        <span className="text-[10px] text-white/30" title={`Every track is free to use in your videos - CC0, or CC BY with a credit line we give you.${downloadsOn ? " Hover a track to download it." : ""}`}>
          {downloadsOn ? "Free to use & download" : "Free to use"}
        </span>
      </div>
      </>
      )}
    </div>,
    dockHost ?? document.body,
  );
};

export default MusicLibraryPanel;
