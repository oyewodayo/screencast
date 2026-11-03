// components/docker/AiVoicePanel.tsx
//
// The music panel's AI voice tab: type (or paste) a script, pick a voice, and a natural-sounding
// voice-over lands on the timeline at the playhead - made on this PC by a neural voice model, so it
// is free, private and works offline (src-tauri/src/services/tts.rs).
//
//   First use  a one-time download (the voice model is a few hundred MB) with real progress and a
//              cancel - nothing else in the panel is offered until the voice can actually speak.
//   Script     a plain text box that remembers its draft; the length reads out as words and an
//              estimated duration, before anything is generated. Ctrl+Enter makes it.
//   Voices     a card per voice - accent, gender, character - and a play button on each: a few
//              seconds of that voice, made once and kept, so choosing is by ear, not by name.
//   Pace       speed, and how long the gaps between sentences are (Brisk / Natural / Measured).
//   Make       progress by sentence, cancellable. The take is placed like a recorded voice-over:
//              speech for music that ducks under it, one "AI voice" strip in the mixer. Changing the
//              words and making it again REPLACES the take it placed (same start); "Add as another"
//              keeps both. Saying the same thing in the same voice again is instant.
//   History    every voice-over made, this video's first (where each sits), then the rest of the
//              library. Clicking one brings back its words, voice and pace, and makes it the take
//              "Replace" re-makes in place - so a line can be fixed long after it was made.
import { convertFileSrc } from "@tauri-apps/api/core";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IoAdd, IoCheckmark, IoChevronDown, IoChevronForward, IoCloudDownloadOutline, IoLockClosedOutline, IoPause, IoPlay, IoRefresh, IoSparkles, IoStop } from "react-icons/io5";
import {
  cancelTts,
  cancelTtsDownload,
  downloadTts,
  estimateSeconds,
  formatDuration,
  isCancelled,
  MAX_SPEED,
  MIN_SPEED,
  onTtsDownload,
  onTtsProgress,
  PAUSE_STYLES,
  pauseStyleFor,
  readVoicePrefs,
  SpokenFile,
  ttsPreview,
  ttsRelease,
  ttsStatus,
  ttsHistory,
  ttsSynthesize,
  TtsStatus,
  VoiceMeta,
  VoiceOverEntry,
  VOICES,
  wordCount,
  wordsFromFileName,
  writeVoicePrefs,
} from "../../utils/aiVoice";

interface AiVoicePanelProps {
  // The playhead - where a new voice-over starts.
  placeAt: number;
  timelinePlaying: boolean;
  onTimelinePlay: (play: boolean) => void;
  onSeek: (time: number) => void;
  // Places the finished takes at `at` and removes the pieces `replaces` names (same contract as the
  // Record tab); returns the new pieces' ids.
  onTakes: (takes: { path: string; seconds: number; label: string }[], at: number, replaces: string[]) => string[];
  // The audio pieces in this video's edit - which voice-overs in the history are on it, and where.
  pieces: { id: string; src: string; startTime: number }[];
}

const LABEL = "AI voice";
const MAX_CHARS = 12_000;

// The engine holds a few hundred MB while loaded; let go a while after the panel closes (coming
// straight back finds it still warm).
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// A stable colour per voice for its tile.
function tileStyle(id: string): React.CSSProperties {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return { background: `linear-gradient(135deg, hsl(${h} 58% 52%), hsl(${(h + 50) % 360} 62% 30%))` };
}

type Placed = { ids: string[]; at: number; seconds: number; file: SpokenFile; voice: string };

const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

const AiVoicePanel: React.FC<AiVoicePanelProps> = ({ placeAt, timelinePlaying, onTimelinePlay, onSeek, onTakes, pieces }) => {
  const initial = useMemo(readVoicePrefs, []);
  const [text, setText] = useState(initial.text);
  const [voice, setVoice] = useState(initial.voice);
  const [speed, setSpeed] = useState(initial.speed);
  const [pause, setPause] = useState(initial.pause);

  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [download, setDownload] = useState<{ downloaded: number; total: number } | null>(null);
  const [making, setMaking] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  // What the take on the timeline was made from, to tell "replace" from "nothing to do".
  const placedFrom = useRef<string>("");

  const audioRef = useRef<HTMLAudioElement>(null);
  // What the one audio element is playing: a voice's sample, or the placed take.
  const [playing, setPlaying] = useState<{ kind: "sample"; voice: string } | { kind: "take" } | { kind: "history"; path: string } | null>(null);
  const [history, setHistory] = useState<VoiceOverEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(true);
  const refreshHistory = useCallback(() => {
    ttsHistory()
      .then(setHistory)
      .catch((e) => console.warn("Couldn't list voice-overs:", e));
  }, []);
  useEffect(refreshHistory, [refreshHistory]);
  const [sampleLoading, setSampleLoading] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    ttsStatus()
      .then(setStatus)
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, []);

  useEffect(() => {
    if (releaseTimer) clearTimeout(releaseTimer);
    refreshStatus();
    let offs: (() => void)[] = [];
    let alive = true;
    void Promise.all([onTtsDownload(setDownload), onTtsProgress(setMaking)]).then((fns) => {
      if (alive) offs = fns;
      else fns.forEach((f) => f());
    });
    return () => {
      alive = false;
      offs.forEach((f) => f());
      audioRef.current?.pause();
      releaseTimer = setTimeout(() => void ttsRelease().catch(() => {}), 120_000);
    };
  }, [refreshStatus]);

  // The draft and the choices are kept (a brief edit shouldn't write to disk on every keystroke).
  useEffect(() => {
    const t = setTimeout(() => writeVoicePrefs({ voice, speed, pause, text }), 400);
    return () => clearTimeout(t);
  }, [voice, speed, pause, text]);

  const pauseValue = PAUSE_STYLES.find((p) => p.id === pause)?.value ?? 1;
  const words = wordCount(text);
  const estimate = estimateSeconds(text, speed, pauseValue);
  const busy = making !== null;
  const ready = status?.state === "ready";
  const requestKey = `${voice}|${speed.toFixed(2)}|${pause}|${text.trim()}`;
  const upToDate = placed !== null && placedFrom.current === requestKey;

  const startDownload = async () => {
    setError(null);
    setDownload({ downloaded: 0, total: 1 });
    try {
      await downloadTts();
      refreshStatus();
    } catch (e) {
      if (!isCancelled(e)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownload(null);
    }
  };

  const playUrl = (path: string, what: NonNullable<typeof playing>) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (timelinePlaying) onTimelinePlay(false);
    audio.src = convertFileSrc(path);
    setPlaying(what);
    void audio.play().catch(() => setPlaying(null));
  };

  const toggleSample = async (id: string) => {
    const audio = audioRef.current;
    if (playing?.kind === "sample" && playing.voice === id) {
      audio?.pause();
      return;
    }
    setError(null);
    setSampleLoading(id);
    try {
      playUrl(await ttsPreview(id), { kind: "sample", voice: id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSampleLoading(null);
    }
  };

  const make = async (asNew: boolean) => {
    if (busy || !text.trim()) return;
    audioRef.current?.pause();
    setError(null);
    setMaking({ done: 0, total: 1 });
    try {
      const file = await ttsSynthesize(text, voice, speed, pauseValue);
      // A replacement starts where the one it replaces did; a new one, at the playhead.
      const replacing = !asNew && placed ? placed : null;
      const at = replacing ? replacing.at : placeAt;
      const ids = onTakes([{ path: file.path, seconds: file.seconds, label: LABEL }], at, replacing ? replacing.ids : []);
      placedFrom.current = requestKey;
      setPlaced({ ids, at, seconds: file.seconds, file, voice });
      refreshHistory();
    } catch (e) {
      if (!isCancelled(e)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMaking(null);
    }
  };

  // A voice-over from the history: its words, voice and pace back in the editor, and - when it's on
  // this video - it becomes the take "Replace" re-makes where it sits. One made before scripts were
  // kept brings back its voice only; paste the words and Replace still lands in its place.
  const recall = (entry: VoiceOverEntry) => {
    if (busy) return;
    const recalledSpeed = entry.speed !== null ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, entry.speed)) : null;
    if (entry.text !== null) setText(entry.text);
    if (entry.voice && VOICES.some((v) => v.id === entry.voice)) setVoice(entry.voice);
    if (recalledSpeed !== null) setSpeed(recalledSpeed);
    if (entry.pause !== null) setPause(pauseStyleFor(entry.pause));
    const onVideo = pieces.filter((p) => samePath(p.src, entry.path));
    if (onVideo.length === 0) {
      placedFrom.current = "";
      setPlaced(null);
      return;
    }
    const at = Math.min(...onVideo.map((p) => p.startTime));
    // Up to date only while the editor holds exactly what made it.
    placedFrom.current =
      entry.text !== null && entry.voice && recalledSpeed !== null && entry.pause !== null
        ? `${entry.voice}|${recalledSpeed.toFixed(2)}|${pauseStyleFor(entry.pause)}|${entry.text.trim()}`
        : "";
    setPlaced({ ids: onVideo.map((p) => p.id), at, seconds: entry.seconds, file: { path: entry.path, seconds: entry.seconds, cached: true }, voice: entry.voice ?? voice });
    onSeek(at);
  };

  // The history's voice-over, again, at the playhead - the file is reused, nothing is re-made.
  const placeAgain = (entry: VoiceOverEntry) => {
    const ids = onTakes([{ path: entry.path, seconds: entry.seconds, label: LABEL }], placeAt, []);
    placedFrom.current = "";
    setPlaced({ ids, at: placeAt, seconds: entry.seconds, file: { path: entry.path, seconds: entry.seconds, cached: true }, voice: entry.voice ?? voice });
  };

  // Where each voice-over sits on this video (its earliest piece), or null when it isn't on it.
  const startOf = (entry: VoiceOverEntry): number | null => {
    const on = pieces.filter((p) => samePath(p.src, entry.path));
    return on.length > 0 ? Math.min(...on.map((p) => p.startTime)) : null;
  };

  const historyRow = (entry: VoiceOverEntry) => {
    const at = startOf(entry);
    const isPlaying = playing?.kind === "history" && playing.path === entry.path;
    const isPlaced = placed !== null && samePath(placed.file.path, entry.path);
    const name = VOICES.find((v) => v.id === entry.voice)?.name;
    return (
      <div
        key={entry.path}
        role="button"
        tabIndex={0}
        onClick={() => recall(entry)}
        onKeyDown={(e) => {
          if (e.key === "Enter") recall(entry);
        }}
        title={entry.text !== null ? "Bring back these words, voice and pace - then Replace re-makes it in place" : "Made before scripts were kept: brings back its voice - paste the words, then Replace re-makes it in place"}
        className={`group flex items-start gap-1.5 p-1.5 rounded-md cursor-pointer outline-none ${isPlaced ? "bg-teal-500/15 ring-1 ring-teal-400/50" : "bg-white/[0.03] hover:bg-white/[0.07] focus-visible:ring-1 focus-visible:ring-white/30"}`}
      >
        <button
          type="button"
          title={isPlaying ? "Stop" : "Listen"}
          onClick={(e) => {
            e.stopPropagation();
            if (isPlaying) audioRef.current?.pause();
            else playUrl(entry.path, { kind: "history", path: entry.path });
          }}
          className="shrink-0 mt-0.5 h-6 w-6 rounded-full flex items-center justify-center bg-white/10 text-white/85 hover:bg-white/20"
        >
          {isPlaying ? <IoPause size={10} /> : <IoPlay size={10} className="ml-0.5" />}
        </button>
        <div className="min-w-0 flex-1 leading-snug">
          <div className={`text-[11px] line-clamp-2 ${entry.text !== null ? "text-white/85" : "text-white/55 italic"}`}>{entry.text ?? `${wordsFromFileName(entry.path)}…`}</div>
          <div className="text-[9.5px] text-white/40 tabular-nums">
            {name ?? "AI voice"} · {entry.seconds.toFixed(1)}s{at !== null && ` · at ${clock(at)}`}
            {entry.text === null && " · words not saved"}
          </div>
        </div>
        <button
          type="button"
          title={`Place it again at ${clock(placeAt)} - instant, nothing is re-made`}
          onClick={(e) => {
            e.stopPropagation();
            placeAgain(entry);
          }}
          className="shrink-0 mt-0.5 h-6 w-6 rounded-md flex items-center justify-center text-white/45 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 focus:opacity-100"
        >
          <IoAdd size={13} />
        </button>
      </div>
    );
  };

  // Ctrl/Cmd+Enter from the script box.
  const onScriptKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void make(false);
    }
  };

  // ---- Not ready: the download offer, or why there isn't one ------------------------------------

  if (status && status.state === "unsupported") {
    return <p className="text-[11px] leading-snug text-white/55">The AI voice runs on Windows for now - it isn't available on this computer yet.</p>;
  }

  if (!ready) {
    const pct = download ? Math.min(100, (download.downloaded / Math.max(1, download.total)) * 100) : 0;
    return (
      <div className="flex flex-col gap-3 min-h-0">
        <div className="rounded-lg p-3 ring-1 ring-white/10 bg-gradient-to-b from-teal-500/[0.12] to-transparent flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <span className="h-8 w-8 rounded-lg flex items-center justify-center bg-teal-500/20 text-teal-200">
              <IoSparkles size={16} />
            </span>
            <div>
              <div className="text-[13px] font-medium text-white">Natural AI voice</div>
              <div className="text-[10px] text-white/50">Studio-quality narration, made on your PC</div>
            </div>
          </div>
          <ul className="flex flex-col gap-1 text-[11px] text-white/70">
            <li className="flex items-center gap-1.5"><IoCheckmark className="text-teal-300 shrink-0" size={12} /> Sounds like a person, not a robot</li>
            <li className="flex items-center gap-1.5"><IoCheckmark className="text-teal-300 shrink-0" size={12} /> Free and unlimited - no account, no credits</li>
            <li className="flex items-center gap-1.5"><IoLockClosedOutline className="text-teal-300 shrink-0" size={12} /> Your script never leaves this computer</li>
            <li className="flex items-center gap-1.5"><IoCheckmark className="text-teal-300 shrink-0" size={12} /> Works offline once set up</li>
          </ul>
          {download ? (
            <div className="flex flex-col gap-1.5">
              <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full rounded-full bg-teal-400 transition-[width] duration-300" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex items-center text-[10px] text-white/55">
                <span className="flex-1 tabular-nums">
                  Setting up · {Math.round(download.downloaded / 1_000_000)} of {Math.round(download.total / 1_000_000)} MB
                </span>
                <button type="button" onClick={() => void cancelTtsDownload()} className="px-1.5 py-0.5 rounded hover:bg-white/10 text-white/70 hover:text-white">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={!status}
              onClick={() => void startDownload()}
              className="flex items-center justify-center gap-1.5 h-8 rounded-md bg-teal-500 hover:bg-teal-400 disabled:opacity-50 text-white text-xs font-medium"
            >
              <IoCloudDownloadOutline size={14} />
              {status ? `Set up the voice · ${status.downloadMb} MB, once` : "Checking…"}
            </button>
          )}
        </div>
        {error && <p className="text-[11px] leading-snug text-red-300/90">{error}</p>}
      </div>
    );
  }

  // ---- Ready ------------------------------------------------------------------------------------

  const selected: VoiceMeta = VOICES.find((v) => v.id === voice) ?? VOICES[0];
  const makeLabel = placed && !upToDate ? "Replace voice-over" : `Add voice-over at ${clock(placeAt)}`;

  return (
    <div className="flex flex-col gap-2.5 min-h-0 overflow-y-auto pr-0.5">
      <audio
        ref={audioRef}
        preload="auto"
        onEnded={() => setPlaying(null)}
        onPause={() => setPlaying(null)}
      />

      <div className="flex flex-col gap-1">
        <textarea
          autoFocus
          value={text}
          maxLength={MAX_CHARS}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onScriptKey}
          placeholder="Type or paste what the voice should say…"
          rows={5}
          className="w-full resize-none rounded-md bg-white/[0.07] px-2 py-1.5 text-xs leading-relaxed text-white placeholder:text-white/35 outline-none focus:ring-1 focus:ring-teal-400 disabled:opacity-60"
        />
        <div className="flex items-center text-[10px] text-white/45 tabular-nums">
          <span>
            {words} {words === 1 ? "word" : "words"}
            {words > 0 && ` · about ${formatDuration(estimate)}`}
          </span>
          <span className="flex-1" />
          <span title="Numbers, dates, money and abbreviations are read the way you'd say them">Reads “$5.50” as “five dollars and fifty cents”</span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center text-[10px] uppercase tracking-wide text-white/40">
          <span className="flex-1">Voice</span>
          <span className="normal-case tracking-normal">{selected.accent} · {selected.gender}</span>
        </div>
        <div className="grid grid-cols-2 @[520px]:grid-cols-3 gap-1.5" role="radiogroup" aria-label="Voice">
          {VOICES.map((v) => {
            const on = v.id === voice;
            const isPlaying = playing?.kind === "sample" && playing.voice === v.id;
            const loading = sampleLoading === v.id;
            return (
              <div
                key={v.id}
                role="radio"
                aria-checked={on}
                tabIndex={0}
                onClick={() => setVoice(v.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setVoice(v.id);
                  }
                }}
                className={`group flex items-center gap-1.5 p-1.5 rounded-md cursor-pointer outline-none transition-colors ${on ? "bg-teal-500/15 ring-1 ring-teal-400/60" : "bg-white/[0.04] hover:bg-white/[0.08] focus-visible:ring-1 focus-visible:ring-white/30"}`}
              >
                <button
                  type="button"
                  title={isPlaying ? "Stop" : `Hear ${v.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleSample(v.id);
                  }}
                  className="relative shrink-0 h-8 w-8 rounded-md flex items-center justify-center text-white shadow-inner"
                  style={tileStyle(v.id)}
                >
                  {loading ? (
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  ) : isPlaying ? (
                    <IoPause size={13} />
                  ) : (
                    <IoPlay size={13} className="ml-0.5 opacity-90" />
                  )}
                  {isPlaying && <span className="absolute inset-0 rounded-md ring-2 ring-white/70 animate-pulse" />}
                </button>
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="flex items-center gap-1 text-[11px] text-white">
                    <span className="truncate">{v.name}</span>
                    {v.recommended && <span className="shrink-0 text-[8px] px-1 rounded bg-teal-400/25 text-teal-100">Best</span>}
                  </div>
                  <div className="truncate text-[9.5px] text-white/45">{v.feel}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-md bg-white/[0.04] p-2">
        <label className="flex items-center gap-2 text-[11px] text-white/75">
          <span className="w-12 shrink-0">Speed</span>
          <input
            type="range"
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={0.05}
            value={speed}
            disabled={busy}
            onChange={(e) => setSpeed(Number(e.target.value))}
            onDoubleClick={() => setSpeed(1)}
            title="Double-click to reset"
            className="flex-1 accent-teal-400"
          />
          <span className="w-9 text-right tabular-nums text-white/60">{speed.toFixed(2)}×</span>
        </label>
        <div className="flex items-center gap-2 text-[11px] text-white/75">
          <span className="w-12 shrink-0">Pauses</span>
          <div className="flex flex-1 p-0.5 rounded-md bg-white/5">
            {PAUSE_STYLES.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy}
                title={p.hint}
                onClick={() => setPause(p.id)}
                className={`flex-1 px-1.5 py-0.5 rounded text-[10.5px] ${pause === p.id ? "bg-white/15 text-white" : "text-white/55 hover:text-white"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {making ? (
        <div className="flex items-center gap-2">
          <div className="flex-1 flex flex-col gap-1">
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full rounded-full bg-teal-400 transition-[width] duration-200" style={{ width: `${Math.min(100, (making.done / Math.max(1, making.total)) * 100)}%` }} />
            </div>
            <span className="text-[10px] text-white/50 tabular-nums">
              {making.done === 0 ? "Warming up the voice…" : `Speaking · part ${Math.min(making.done + 1, making.total)} of ${making.total}`}
            </span>
          </div>
          <button type="button" onClick={() => void cancelTts()} className="flex items-center gap-1 px-2 h-7 rounded-md bg-white/10 hover:bg-white/15 text-[11px] text-white/85">
            <IoStop size={11} /> Stop
          </button>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={!text.trim() || upToDate}
            onClick={() => void make(false)}
            title="Ctrl+Enter"
            className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md bg-teal-500 hover:bg-teal-400 disabled:bg-white/10 disabled:text-white/35 text-white text-xs font-medium transition-colors"
          >
            {placed && !upToDate ? <IoRefresh size={13} /> : <IoSparkles size={13} />}
            {upToDate ? "Placed on the timeline" : makeLabel}
          </button>
          {placed && !upToDate && (
            <button
              type="button"
              disabled={!text.trim()}
              onClick={() => void make(true)}
              title={`Keep the one already placed and add this at ${clock(placeAt)} as a second voice-over`}
              className="flex items-center gap-1 px-2 h-8 rounded-md bg-white/10 hover:bg-white/15 disabled:opacity-40 text-[11px] text-white/85"
            >
              <IoAdd size={13} /> Add as another
            </button>
          )}
        </div>
      )}

      {placed && !busy && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-teal-500/10 ring-1 ring-teal-400/20 text-[11px]">
          <button
            type="button"
            title={playing?.kind === "take" ? "Stop" : "Listen to it on its own"}
            onClick={() => (playing?.kind === "take" ? audioRef.current?.pause() : playUrl(placed.file.path, { kind: "take" }))}
            className="shrink-0 h-6 w-6 rounded-full flex items-center justify-center bg-teal-400/25 text-teal-100 hover:bg-teal-400/40"
          >
            {playing?.kind === "take" ? <IoPause size={11} /> : <IoPlay size={11} className="ml-0.5" />}
          </button>
          <button type="button" onClick={() => onSeek(placed.at)} title="Jump to where it starts" className="flex-1 min-w-0 text-left truncate text-teal-100/90 hover:text-white">
            {placed.file.cached ? "Placed (ready instantly)" : "Placed"} at {clock(placed.at)} · {placed.seconds.toFixed(1)}s
          </button>
        </div>
      )}

      {error && <p className="text-[11px] leading-snug text-red-300/90">{error}</p>}

      {history.length > 0 && (
        <div className="flex flex-col gap-1">
          <button type="button" onClick={() => setHistoryOpen((o) => !o)} className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-white/40 hover:text-white/70">
            {historyOpen ? <IoChevronDown size={11} /> : <IoChevronForward size={11} />}
            <span className="flex-1 text-left">History</span>
            <span className="normal-case tracking-normal">{history.filter((h) => startOf(h) !== null).length} on this video</span>
          </button>
          {historyOpen && (
            <>
              {history
                .filter((h) => startOf(h) !== null)
                .sort((a, b) => startOf(a)! - startOf(b)!)
                .map(historyRow)}
              {history.some((h) => startOf(h) === null) && <div className="pt-1 text-[9.5px] uppercase tracking-wide text-white/30">Earlier</div>}
              {history.filter((h) => startOf(h) === null).map(historyRow)}
            </>
          )}
        </div>
      )}

      <p className="text-[10px] leading-snug text-white/35">
        Made on this PC and saved in your library's Voice-overs folder. Music dips under it automatically, and it gets its own “{LABEL}” strip in the mixer.
      </p>
    </div>
  );
};

export default AiVoicePanel;
