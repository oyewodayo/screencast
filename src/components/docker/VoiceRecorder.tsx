// components/docker/VoiceRecorder.tsx
//
// The music panel's Record tab: a voice-over (or any sound) recorded straight onto the timeline -
// from one microphone, or from several at once, each to its own track.
//
//   Inputs    every microphone connected, each with its own live level meter (and a clip warning),
//             running as soon as the tab opens so levels are set before the take, not discovered
//             after it. Arm one, some or all. The list follows devices as they're plugged in or
//             out, and ↻ rescans on demand. Windows' "Default"/"Communications" entries are only
//             aliases of real devices, so they're left out (the default one is armed first).
//   Options   a 3-2-1 count-in; record over the picture (the timeline plays while you speak, and
//             the take lands where it started); clean-up (the browser's noise/echo suppression
//             and auto level - off gives the raw feed a good mic deserves); hear yourself.
//   Take      each armed mic's waveform draws live as you speak; each is written as 24-bit WAV into
//             the library's Voice-overs folder WHILE it records (takeWriter.ts) - nothing held in
//             memory, so an hours-long take is no harder than a short one, and a crash keeps all but
//             the last second. Stop finishes the files and lays them on the timeline at
//             the same moment - one "Voice-over" track for a single mic, one track per mic for
//             several (its own mixer strip), all counting as speech for music that dips under it.
//   Retake    replaces the last pass (every mic's take) with a new one from the same moment.
//
// Captured on the mixer's own context through recorder-processor.js - every mic's recorder is
// started and stopped in the same render quantum, so the takes line up, and each is exactly as long
// as its samples say.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { IoCheckmark, IoMicOutline, IoRefresh, IoStop } from "react-icons/io5";
import { loadWorkletModule, mixerContext, setTimelineMuted } from "../../utils/mixerGraph";
import { TakeTrail, TakeWriter } from "../../utils/takeWriter";
import { linearToDb } from "../../utils/audioFx";

interface VoiceRecorderProps {
  // The playhead - where a take starts on the timeline.
  recordAt: number;
  timelinePlaying: boolean;
  onTimelinePlay: (play: boolean) => void;
  onSeek: (time: number) => void;
  // Places one pass's saved takes at `at` - each on the track its label names - and removes the
  // pieces a Retake replaces. Returns the new pieces' ids.
  onTakes: (takes: { path: string; seconds: number; label: string }[], at: number, replaces: string[]) => string[];
}

type Phase = { kind: "idle" } | { kind: "count"; n: number } | { kind: "recording" } | { kind: "saving" };

interface Prefs {
  countIn: boolean;
  overPicture: boolean;
  // The timeline's sound off while recording - nothing for the mic to pick up from the speakers.
  muteTimeline: boolean;
  cleanup: boolean;
  monitor: boolean;
  // The armed microphones; empty = the system's default one.
  deviceIds: string[];
}
const PREFS_KEY = "briefcast.voiceRecorder";
const DEFAULT_PREFS: Prefs = { countIn: true, overPicture: true, muteTimeline: true, cleanup: true, monitor: false, deviceIds: [] };
const readPrefs = (): Prefs => {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return { ...DEFAULT_PREFS, ...saved, deviceIds: Array.isArray(saved.deviceIds) ? saved.deviceIds : [] };
  } catch {
    return DEFAULT_PREFS;
  }
};

interface Mic {
  deviceId: string;
  groupId: string;
  label: string;
}

// One armed microphone's capture.
interface Input {
  mic: Mic;
  node: AudioWorkletNode;
  peak: number;
  clipAt: number;
  // While recording: the file it's going into, and its waveform so far.
  writer: TakeWriter | null;
  trail: TakeTrail;
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;
// "Microphone (USB PnP Sound Device)" -> "USB PnP Sound Device" - the part that tells two apart.
const shortName = (label: string) => label.match(/\(([^)]+)\)\s*$/)?.[1] ?? label;
const ALIAS_IDS = new Set(["default", "communications"]);

const VoiceRecorder: React.FC<VoiceRecorderProps> = ({ recordAt, timelinePlaying, onTimelinePlay, onSeek, onTakes }) => {
  const [prefs, setPrefs] = useState(readPrefs);
  const setPref = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // Remembering the choices is a convenience.
      }
      return next;
    });

  // ---- Devices ----------------------------------------------------------------------------------
  const [mics, setMics] = useState<Mic[] | null>(null);
  const [defaultGroup, setDefaultGroup] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Device names only appear once the page may use the microphone, so the first scan asks for it.
  const scan = useCallback(async () => {
    setScanning(true);
    try {
      let list = await navigator.mediaDevices.enumerateDevices();
      if (!list.some((d) => d.kind === "audioinput" && d.label)) {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
        list = await navigator.mediaDevices.enumerateDevices();
      }
      const inputs = list.filter((d) => d.kind === "audioinput");
      setDefaultGroup(inputs.find((d) => d.deviceId === "default")?.groupId ?? null);
      setMics(inputs.filter((d) => !ALIAS_IDS.has(d.deviceId)).map((d) => ({ deviceId: d.deviceId, groupId: d.groupId, label: d.label || "Microphone" })));
      setError(null);
    } catch (err) {
      setMics([]);
      setError(err instanceof DOMException && err.name === "NotAllowedError" ? "Briefcast isn't allowed to use the microphone." : `Couldn't list the microphones: ${String(err)}`);
    } finally {
      setScanning(false);
    }
  }, []);
  useEffect(() => {
    void scan();
    navigator.mediaDevices.addEventListener("devicechange", scan);
    return () => navigator.mediaDevices.removeEventListener("devicechange", scan);
  }, [scan]);

  // The armed mics that are actually connected - or, with none chosen yet (or every chosen one
  // unplugged), the system default.
  const armed: Mic[] = (() => {
    if (!mics || mics.length === 0) return [];
    const chosen = mics.filter((m) => prefs.deviceIds.includes(m.deviceId));
    if (chosen.length > 0) return chosen;
    return [mics.find((m) => m.groupId === defaultGroup) ?? mics[0]];
  })();
  const armedKey = armed.map((m) => m.deviceId).join("|");
  const toggleMic = (id: string) => {
    const current = armed.map((m) => m.deviceId);
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    if (next.length > 0) setPref({ deviceIds: next });
  };
  const allArmed = !!mics && mics.length > 0 && armed.length === mics.length;

  // ---- Capture ----------------------------------------------------------------------------------
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const [, setPeaksVersion] = useState(0);
  const [lastTake, setLastTake] = useState<{ ids: string[]; at: number; seconds: number } | null>(null);
  const inputsRef = useRef<Map<string, Input>>(new Map());
  const [ready, setReady] = useState(false);
  const monitorsRef = useRef<GainNode[]>([]);
  const meterRefs = useRef<Map<string, { bar: HTMLDivElement | null; clip: HTMLSpanElement | null }>>(new Map());
  // The pass in progress - with its own handles on the recorders, so closing the panel mid-take
  // (which lets go of the microphones) can still collect and save it.
  const takeRef = useRef<{ inputs: Input[]; at: number; startedTimeline: boolean; replaces: string[]; startedAt: number } | null>(null);
  const live = useRef({ recordAt, timelinePlaying, onTimelinePlay, onTakes });
  live.current = { recordAt, timelinePlaying, onTimelinePlay, onTakes };

  // Every armed mic open while the tab is: the meters need them, and opening them only at Record
  // would put the device start-up in front of the first word. Reopened when the armed set or the
  // clean-up setting changes (the browser applies those when a stream opens) - never mid-take.
  useEffect(() => {
    if (armed.length === 0 || takeRef.current) return;
    let cancelled = false;
    const streams: MediaStream[] = [];
    const nodes: AudioNode[] = [];
    const opened = new Map<string, Input>();
    (async () => {
      const ctx = mixerContext();
      try {
        await loadWorkletModule(ctx, "/audio-worklets/recorder-processor.js");
      } catch (err) {
        if (!cancelled) setError(`Recording isn't available: ${String(err)}`);
        return;
      }
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const failures: string[] = [];
      for (const mic of armed) {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: mic.deviceId },
              channelCount: 1,
              echoCancellation: prefs.cleanup,
              noiseSuppression: prefs.cleanup,
              autoGainControl: prefs.cleanup,
            },
          });
        } catch {
          failures.push(shortName(mic.label));
          continue;
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streams.push(stream);
        const source = ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(ctx, "recorder-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        // A silent path to the speakers keeps the graph pulling the recorder.
        const sink = new GainNode(ctx, { gain: 0 });
        const monitor = new GainNode(ctx, { gain: prefs.monitor ? 1 : 0 });
        source.connect(node).connect(sink).connect(ctx.destination);
        source.connect(monitor).connect(ctx.destination);
        nodes.push(source, node, sink, monitor);
        monitorsRef.current.push(monitor);
        const input: Input = { mic, node, peak: 0, clipAt: 0, writer: null, trail: new TakeTrail() };
        node.port.onmessage = (e) => {
          const d = e.data;
          if (d.type === "level") {
            input.peak = d.peak;
            if (d.peak >= 0.989) input.clipAt = performance.now();
          } else if (d.type === "samples") {
            const s = d.samples as Float32Array;
            input.writer?.push(s);
            let p = 0;
            for (let i = 0; i < s.length; i++) p = Math.max(p, Math.abs(s[i]));
            input.trail.push(p);
            setPeaksVersion((v) => v + 1);
          } else if (d.type === "stopped") {
            stoppedWaiters.current.get(input)?.();
          }
        };
        opened.set(mic.deviceId, input);
      }
      if (cancelled) return;
      inputsRef.current = opened;
      setReady(opened.size > 0);
      setError(failures.length > 0 ? `Couldn't open ${failures.join(", ")} - it may be in use by another app.` : null);
    })();
    return () => {
      cancelled = true;
      setReady(false);
      inputsRef.current = new Map();
      monitorsRef.current = [];
      nodes.forEach((n) => n.disconnect());
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armedKey, prefs.cleanup]);

  useEffect(() => {
    monitorsRef.current.forEach((g) => (g.gain.value = prefs.monitor ? 1 : 0));
  }, [prefs.monitor]);

  // The input meters, straight to the DOM every frame.
  useEffect(() => {
    let raf = 0;
    const shown = new Map<string, number>();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      inputsRef.current.forEach((input, id) => {
        const els = meterRefs.current.get(id);
        if (!els) return;
        const f = Math.max(0, Math.min(1, (linearToDb(input.peak) + 60) / 60));
        const s = Math.max(f, (shown.get(id) ?? 0) - 0.012);
        shown.set(id, s);
        if (els.bar) {
          els.bar.style.width = `${(s * 100).toFixed(1)}%`;
          els.bar.style.background = f > 0.95 ? "rgb(248,113,113)" : f > 0.8 ? "rgb(251,191,36)" : "rgb(45,212,191)";
        }
        if (els.clip) els.clip.style.opacity = now - input.clipAt < 1500 ? "1" : "0";
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // The take's clock - and a writer that's failed (disk full, folder gone) said at once, not at Stop.
  useEffect(() => {
    if (phase.kind !== "recording") return;
    const id = window.setInterval(() => {
      setElapsed((performance.now() - (takeRef.current?.startedAt ?? performance.now())) / 1000);
      const failed = takeRef.current?.inputs.find((i) => i.writer?.failed);
      if (failed) setError(`${shortName(failed.mic.label)} can't be saved: ${failed.writer!.failed}`);
    }, 100);
    return () => window.clearInterval(id);
  }, [phase.kind]);

  const begin = (at: number, replaces: string[]) => {
    const inputs = [...inputsRef.current.values()];
    if (inputs.length === 0) return;
    const startedTimeline = prefs.overPicture && !live.current.timelinePlaying;
    const multi = inputs.length > 1;
    // A file per mic, opened now - samples arriving before it's ready wait in its batch.
    for (const input of inputs) {
      input.writer = new TakeWriter(multi ? `Voice-over ${shortName(input.mic.label)}` : "Voice-over", input.node.context.sampleRate);
      input.trail = new TakeTrail();
    }
    // All in one go, so every mic starts on the same render quantum.
    for (const input of inputs) input.node.port.postMessage({ type: "record", on: true });
    takeRef.current = { inputs, at, startedTimeline, replaces, startedAt: performance.now() };
    if (prefs.muteTimeline) setTimelineMuted(true);
    setElapsed(0);
    setPeaksVersion((v) => v + 1);
    if (startedTimeline) live.current.onTimelinePlay(true);
    setPhase({ kind: "recording" });
  };

  const countTimer = useRef<number | null>(null);
  const start = (replaces: string[] = [], from: number | null = null) => {
    setError(null);
    const at = from ?? live.current.recordAt;
    if (from !== null) onSeek(from);
    if (!prefs.countIn) {
      begin(at, replaces);
      return;
    }
    let n = 3;
    setPhase({ kind: "count", n });
    countTimer.current = window.setInterval(() => {
      n -= 1;
      if (n > 0) setPhase({ kind: "count", n });
      else {
        window.clearInterval(countTimer.current!);
        countTimer.current = null;
        begin(at, replaces);
      }
    }, 1000);
  };
  const cancelCount = () => {
    if (countTimer.current) window.clearInterval(countTimer.current);
    countTimer.current = null;
    setPhase({ kind: "idle" });
  };

  const stoppedWaiters = useRef<Map<Input, () => void>>(new Map());
  const stop = async () => {
    const take = takeRef.current;
    if (!take) return;
    setPhase({ kind: "saving" });
    await Promise.all(
      take.inputs.map(
        (input) =>
          new Promise<void>((resolve) => {
            stoppedWaiters.current.set(input, resolve);
            input.node.port.postMessage({ type: "record", on: false });
            window.setTimeout(resolve, 1000); // never wait on a node that's gone
          })
      )
    );
    stoppedWaiters.current.clear();
    if (take.startedTimeline) live.current.onTimelinePlay(false);
    setTimelineMuted(false);
    takeRef.current = null;
    const sampleRate = take.inputs[0].node.context.sampleRate;
    const multi = take.inputs.length > 1;
    const saved: { path: string; seconds: number; label: string }[] = [];
    const failures: string[] = [];
    for (const input of take.inputs) {
      const writer = input.writer;
      input.writer = null;
      if (!writer) continue;
      const seconds = writer.samples / sampleRate;
      if (seconds < 0.2) {
        await writer.discard();
        continue;
      }
      try {
        const path = await writer.close();
        saved.push({ path, seconds, label: multi ? `Voice-over · ${shortName(input.mic.label)}` : "Voice-over" });
      } catch (err) {
        failures.push(`${shortName(input.mic.label)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A Retake's old pass only goes once the new one is safely saved.
    if (saved.length > 0) {
      const ids = live.current.onTakes(saved, take.at, take.replaces);
      setLastTake({ ids, at: take.at, seconds: Math.max(...saved.map((t) => t.seconds)) });
    }
    setError(failures.length > 0 ? `Couldn't save: ${failures.join("; ")}` : saved.length === 0 ? "That take was too short to keep." : null);
    setPhase({ kind: "idle" });
  };

  // Closing the panel mid-take keeps the take.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(
    () => () => {
      if (countTimer.current) window.clearInterval(countTimer.current);
      if (takeRef.current) void stopRef.current();
      else setTimelineMuted(false);
    },
    []
  );

  const recording = phase.kind === "recording";
  const busy = phase.kind !== "idle";
  const shownInputs = [...inputsRef.current.values()];

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2.5">
      {/* Inputs: every mic, armed or not, with its level. */}
      <div className="flex flex-col gap-1 p-2 rounded-md bg-white/[0.04] ring-1 ring-white/5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-white/40">
          <IoMicOutline size={12} />
          <span className="flex-1">Microphones{armed.length > 1 ? ` · ${armed.length} tracks` : ""}</span>
          {mics && mics.length > 1 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setPref({ deviceIds: allArmed ? [armed[0].deviceId] : mics.map((m) => m.deviceId) })}
              className="normal-case tracking-normal px-1.5 py-0.5 rounded text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-40"
              title={allArmed ? "Record with just one" : "Record with every microphone, each to its own track"}
            >
              {allArmed ? "Just one" : "All"}
            </button>
          )}
          <button
            type="button"
            disabled={busy || scanning}
            onClick={() => void scan()}
            title="Look for microphones again - after plugging one in"
            className="p-0.5 rounded text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-40"
          >
            <IoRefresh size={13} className={scanning ? "animate-spin" : ""} />
          </button>
        </div>
        {mics === null && <p className="text-[11px] text-white/45 py-1">Looking for microphones…</p>}
        {mics?.length === 0 && !error && <p className="text-[11px] text-white/45 py-1">No microphone found - plug one in, then ↻.</p>}
        {mics?.map((mic) => {
          const isArmed = armed.some((m) => m.deviceId === mic.deviceId);
          return (
            <div key={mic.deviceId} className={`flex flex-col gap-1 px-1.5 py-1 rounded ${isArmed ? "bg-white/[0.05]" : ""}`}>
              <button
                type="button"
                disabled={busy}
                onClick={() => toggleMic(mic.deviceId)}
                className="flex items-center gap-2 text-left text-[11px] disabled:cursor-default"
                title={isArmed ? (armed.length > 1 ? "Don't record with this one" : "At least one microphone records") : "Record with this one too"}
              >
                <span className={`h-3.5 w-3.5 shrink-0 rounded-sm flex items-center justify-center ring-1 ${isArmed ? "bg-red-500 ring-red-400 text-white" : "ring-white/30"}`}>
                  {isArmed && <IoCheckmark size={10} />}
                </span>
                <span className={`flex-1 min-w-0 truncate ${isArmed ? "text-white" : "text-white/55"}`}>{mic.label}</span>
                {mic.groupId === defaultGroup && <span className="shrink-0 text-[9px] text-white/35">default</span>}
              </button>
              {isArmed && (
                <div className="flex items-center gap-2 pl-[22px]">
                  <div className="relative flex-1 h-1 rounded-full bg-white/10 overflow-hidden" title="Peak input level - aim for the loud words to land in the amber">
                    <div
                      ref={(el) => {
                        meterRefs.current.set(mic.deviceId, { ...(meterRefs.current.get(mic.deviceId) ?? { clip: null }), bar: el });
                      }}
                      className="h-full rounded-full"
                      style={{ width: 0 }}
                    />
                    <div className="absolute inset-y-0 left-[80%] w-px bg-white/25" />
                  </div>
                  <span
                    ref={(el) => {
                      meterRefs.current.set(mic.deviceId, { ...(meterRefs.current.get(mic.deviceId) ?? { bar: null }), clip: el });
                    }}
                    className="px-1 rounded bg-red-500/80 text-white text-[9px] font-semibold transition-opacity"
                    style={{ opacity: 0 }}
                    title="Clipping - move back from the mic or turn its gain down"
                  >
                    CLIP
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* The take: each mic's waveform as it's spoken, the clock, the big button. */}
      <div className="relative flex flex-col items-center gap-2 py-3 rounded-md bg-gradient-to-b from-red-500/[0.07] to-transparent ring-1 ring-white/5">
        <div className="w-full flex flex-col gap-1">
          {(shownInputs.length > 0 ? shownInputs : [null]).map((input, i) => (
            <TakeWaveform key={input?.mic.deviceId ?? i} peaks={input?.trail.bars ?? []} active={recording} height={shownInputs.length > 1 ? 28 : 48} />
          ))}
        </div>
        <div className="text-2xl font-light tabular-nums tracking-tight text-white/90">
          {phase.kind === "count" ? <span className="text-red-300 animate-pulse">{phase.n}</span> : clock(recording ? elapsed : lastTake && !busy ? lastTake.seconds : 0)}
        </div>
        <button
          type="button"
          disabled={!ready && !busy}
          onClick={() => (recording ? void stop() : phase.kind === "count" ? cancelCount() : phase.kind === "idle" ? start() : undefined)}
          title={recording ? "Stop and place the take" : phase.kind === "count" ? "Cancel" : "Record at the playhead"}
          className="relative h-14 w-14 rounded-full flex items-center justify-center bg-neutral-800 ring-2 ring-white/15 hover:ring-white/30 disabled:opacity-40 transition-shadow"
          style={recording ? { boxShadow: "0 0 0 6px rgba(239,68,68,0.18), 0 0 24px rgba(239,68,68,0.5)" } : undefined}
        >
          {recording ? <IoStop size={22} className="text-red-400" /> : <span className={`block h-6 w-6 rounded-full bg-red-500 ${phase.kind === "count" ? "animate-pulse" : ""}`} />}
          {recording && <span className="absolute inset-0 rounded-full ring-2 ring-red-500/60 animate-ping" />}
        </button>
        <div className="text-[10px] text-white/45 h-3">
          {recording
            ? "Recording - click to stop"
            : phase.kind === "saving"
              ? "Saving the take…"
              : phase.kind === "count"
                ? "Get ready…"
                : `Starts at ${clock(recordAt)} on the timeline${armed.length > 1 ? ` · ${armed.length} mics` : ""}`}
        </div>
      </div>

      {lastTake && !busy && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-teal-500/10 ring-1 ring-teal-400/20 text-[11px]">
          <span className="flex-1 min-w-0 truncate text-teal-100/90">
            Placed at {clock(lastTake.at)} · {lastTake.seconds.toFixed(1)}s{lastTake.ids.length > 1 ? ` · ${lastTake.ids.length} tracks` : ""}
          </span>
          <button
            type="button"
            onClick={() => start(lastTake.ids, lastTake.at)}
            title="Record it again from the same moment - the new take replaces this one"
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-white/10 hover:bg-white/15 text-white/85"
          >
            <IoRefresh size={11} /> Retake
          </button>
        </div>
      )}

      {error && <p className="text-[11px] leading-snug text-red-300/90">{error}</p>}

      <div className="flex flex-col gap-1.5 text-[11px] text-white/75">
        {(
          [
            ["countIn", "Count in 3-2-1", "A beat to breathe before the take starts"],
            ["overPicture", "Play the video while recording", "Narrate to picture - the timeline plays from the playhead and stops with you"],
            ["muteTimeline", "Mute the video's sound while recording", "The picture plays, the speakers stay quiet - so the mic doesn't record the video's sound (which comes back as an echo)"],
            ["cleanup", "Clean up voice", "Noise and echo suppression with auto level - turn off for a good mic in a quiet room (raw, studio feed)"],
            ["monitor", "Hear yourself", "Plays the mic back as you record - use headphones, or it will feed back"],
          ] as const
        ).map(([key, label, hint]) => (
          <label key={key} className="flex items-center gap-2 cursor-pointer" title={hint}>
            <input type="checkbox" checked={prefs[key]} disabled={busy && key !== "monitor"} onChange={(e) => setPref({ [key]: e.target.checked })} className="accent-red-400" />
            {label}
          </label>
        ))}
      </div>
      {prefs.overPicture && !prefs.muteTimeline && !busy && (
        <p className="text-[10px] leading-snug text-amber-300/90">
          The video's sound will play while you record - wear headphones, or the mic picks it up and it echoes. (If it does, the take's panel can find and remove it.)
        </p>
      )}
      <p className="mt-auto text-[10px] leading-snug text-white/35">Saved as 24-bit WAV in your library's Voice-overs folder - one track per microphone.</p>
    </div>
  );
};

// The take so far, the whole of it squeezed to fit, growing from the left as it's spoken.
const TakeWaveform: React.FC<{ peaks: number[]; active: boolean; height: number }> = ({ peaks, active, height }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const count = peaks.length;
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(0, mid, w, 1);
    if (count === 0) return;
    // 3 px a bar while short; squeezed once the take is longer than the box.
    const bar = Math.min(3, w / count);
    const per = Math.max(1, Math.ceil(count / (w / bar)));
    let x = 0;
    for (let i = 0; i < count; i += per) {
      let p = 0;
      for (let j = i; j < Math.min(count, i + per); j++) p = Math.max(p, peaks[j]);
      const bh = Math.max(1, Math.sqrt(p) * (h - 4));
      ctx.fillStyle = p > 0.98 ? "rgb(248,113,113)" : active ? "rgb(252,165,165)" : "rgba(252,165,165,0.6)";
      ctx.fillRect(x, mid - bh / 2, Math.max(1, bar - 1), bh);
      x += bar;
    }
  }, [peaks, count, active, height]);
  return <canvas ref={ref} className="w-full px-3" style={{ height }} />;
};

export default VoiceRecorder;
