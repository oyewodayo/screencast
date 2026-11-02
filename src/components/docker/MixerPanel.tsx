// components/docker/MixerPanel.tsx
//
// The mixer: one strip per sound in the edit - the video's own, each audio track (every piece of a
// cut-up track is one strip, audioChannelKey) and each picture-in-picture that plays its sound.
// A strip has a live level meter, its level (in dB), mute, solo and its effects (AudioFxEditor).
// Level, mute and effects are saved and exported; solo is a listening aid for this session only.
//
// Docked into the sidebar's Tools tab when it's open, floating otherwise (ToolPanelHost.tsx).
// While it's open every channel is routed through Web Audio so the meters can read it.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoChevronDown, IoChevronForward, IoPause, IoPlay } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, useDockSnap, useFloatingDismiss, useToolPanelHost } from "./ToolPanelHost";
import AudioFxEditor from "./AudioFxEditor";
import { isNeutralFx, linearToDb, type AudioFx } from "../../utils/audioFx";
import { channelAnalyser, readLevel } from "../../utils/mixerGraph";
import type { MasterBus } from "../../utils/masterBus";
import LiveScope from "./LiveScope";
import KnobSlider from "./KnobSlider";
import MasterStrip from "./MasterStrip";

// A strip's scope source: the piece that's sounding now, else any of its pieces that's routed.
const stripAnalyser = (meterIds: string[]): AnalyserNode | null => {
  const sounding = meterIds.find((id) => readLevel(id).l + readLevel(id).r > 0);
  for (const id of sounding ? [sounding, ...meterIds] : meterIds) {
    const analyser = channelAnalyser(id);
    if (analyser) return analyser;
  }
  return null;
};
import { setMixerOpen, toggleSolo, useMixerSession } from "../../utils/mixerState";

export interface MixerChannel {
  key: string;
  name: string;
  kind: "video" | "audio" | "pip";
  volume: number;
  muted: boolean;
  fx: AudioFx | undefined;
  // Meter ids (mixerGraph.ts) whose loudest one this strip shows.
  meterIds: string[];
  // e.g. "3 pieces".
  detail?: string;
  // Music ducking: how far it's pulled down under the voice right now (0..1 gain), and the most it
  // goes (dB) - the strip's ducking meter.
  ducking?: { read: () => number; levelDb: number };
}

// A ducked strip's live gain reduction: the bar grows as the music gives way to a voice and falls
// back as it returns - the ducking you've been hearing, seen.
const DuckMeter: React.FC<{ read: () => number; levelDb: number }> = ({ read, levelDb }) => {
  const barRef = useRef<HTMLSpanElement>(null);
  const [db, setDb] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let raf = 0;
    let lastText = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const g = Math.max(1e-6, Math.min(1, readRef.current()));
      const reduction = -20 * Math.log10(g);
      if (barRef.current) barRef.current.style.width = `${Math.min(100, (reduction / Math.max(1, -levelDb)) * 100).toFixed(1)}%`;
      if (now - lastText > 150) {
        lastText = now;
        setDb(reduction);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelDb]);
  const active = db > 0.3;
  return (
    <div className="flex items-center gap-2 text-[10px]" title={`Dips up to ${Math.round(-levelDb)} dB while someone speaks`}>
      <span className={`w-14 shrink-0 transition-colors ${active ? "text-amber-200" : "text-white/40"}`}>{active ? "Ducking" : "Ducks"}</span>
      <span className="relative flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <span ref={barRef} className="absolute right-0 inset-y-0 rounded-full bg-gradient-to-l from-amber-300 to-amber-500/60" style={{ width: 0 }} />
      </span>
      <span className={`w-11 shrink-0 text-right tabular-nums ${active ? "text-amber-200" : "text-white/40"}`}>{active ? `−${db.toFixed(1)}` : "0.0"} dB</span>
    </div>
  );
};

interface MixerPanelProps {
  anchor: { left: number; top: number };
  channels: MixerChannel[];
  // Strip to open with its effects showing.
  focusKey?: string | null;
  onVolume: (key: string, volume: number) => void;
  onMute: (key: string, muted: boolean) => void;
  onFx: (key: string, fx: AudioFx | undefined) => void;
  // The master bus and the delivery target (the export's loudness target) - MasterStrip.
  master: MasterBus | undefined;
  onMasterChange: (master: MasterBus | undefined) => void;
  loudnessTarget: number | null;
  onLoudnessTargetChange: (lufs: number | null) => void;
  // Plays just the audio selected on the timeline (Ctrl-click for more) - everything else silent -
  // so what's being mixed can be heard on its own. null selection = nothing to play.
  isPlaying: boolean;
  onTogglePlay: () => void;
  currentTime: number;
  selection: { label: string; from: number; to: number } | null;
  onClose: () => void;
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, "0")}`;

const METER_FLOOR_DB = -60;
const meterFraction = (v: number) => Math.max(0, Math.min(1, (linearToDb(v) - METER_FLOOR_DB) / -METER_FLOOR_DB));

// L/R peak bars with a falling peak hold, drawn straight onto the DOM every frame.
const Meter: React.FC<{ ids: string[] }> = ({ ids }) => {
  const barL = useRef<HTMLDivElement>(null);
  const barR = useRef<HTMLDivElement>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  useEffect(() => {
    let raf = 0;
    const shown = { l: 0, r: 0 };
    const tick = () => {
      let l = 0;
      let r = 0;
      for (const id of idsRef.current) {
        const v = readLevel(id);
        l = Math.max(l, v.l);
        r = Math.max(r, v.r);
      }
      // Instant attack, ~20 dB/s fall, like a hardware meter.
      shown.l = Math.max(meterFraction(l), shown.l - 0.006);
      shown.r = Math.max(meterFraction(r), shown.r - 0.006);
      for (const [el, f] of [
        [barL.current, shown.l],
        [barR.current, shown.r],
      ] as const) {
        if (!el) continue;
        el.style.width = `${(f * 100).toFixed(1)}%`;
        el.style.background = f > 0.95 ? "rgb(248,113,113)" : f > 0.8 ? "rgb(251,191,36)" : "rgb(45,212,191)";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="flex flex-col gap-[2px] w-full" title="Level (peak, -60 to 0 dBFS)">
      {[barL, barR].map((ref, i) => (
        <div key={i} className="h-[3px] rounded-full bg-white/10 overflow-hidden">
          <div ref={ref} className="h-full rounded-full" style={{ width: 0 }} />
        </div>
      ))}
    </div>
  );
};

const levelLabel = (v: number) => (v <= 0.0005 ? "-∞" : `${linearToDb(v) > 0 ? "+" : ""}${linearToDb(v).toFixed(1)}`);

const KIND_LABEL: Record<MixerChannel["kind"], string> = { video: "Video", audio: "Track", pip: "PiP" };

const MixerPanel: React.FC<MixerPanelProps> = ({ anchor, channels, focusKey, onVolume, onMute, onFx, master, onMasterChange, loudnessTarget, onLoudnessTargetChange, isPlaying, onTogglePlay, currentTime, selection, onClose }) => {
  const dockHost = useToolPanelHost();
  const { ref: panelRef, position } = useClampedPopoverPosition(anchor);
  useFloatingDismiss("[data-mixer-panel], [data-mixer-button]", onClose, !!dockHost);
  useDockSnap(panelRef, !!dockHost);
  const session = useMixerSession();
  const [expanded, setExpanded] = useState<string | null>(focusKey ?? null);
  useEffect(() => {
    if (focusKey) setExpanded(focusKey);
  }, [focusKey]);

  // Meters need every channel routed; closing ends solo too.
  useEffect(() => {
    setMixerOpen(true);
    return () => setMixerOpen(false);
  }, []);

  return createPortal(
    <div
      ref={panelRef}
      data-mixer-panel
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={dockHost ? `${DOCKED_PANEL_CLASS} p-3 gap-2` : "w-80 max-h-[min(640px,calc(100vh-16px))] p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2"}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Mixer</span>
        <span className="ml-auto flex items-center gap-2">
          {selection && (
            <span className="text-[10px] tabular-nums text-white/50" title={`Plays ${selection.label} on its own, ${clock(selection.from)} to ${clock(selection.to)}`}>
              {clock(Math.max(selection.from, Math.min(currentTime, selection.to)))} / {clock(selection.to)}
            </span>
          )}
          <button
            type="button"
            disabled={!selection && !isPlaying}
            onClick={onTogglePlay}
            title={isPlaying ? "Pause" : selection ? `Play ${selection.label} on its own` : "Select audio on the timeline to play it here - Ctrl-click for more"}
            className={`h-6 w-6 flex items-center justify-center rounded-full text-white transition-colors disabled:opacity-35 ${isPlaying ? "bg-teal-500 hover:bg-teal-400 shadow-[0_0_10px_rgba(45,212,191,0.55)]" : "bg-white/15 hover:bg-white/25"}`}
          >
            {isPlaying ? <IoPause size={12} /> : <IoPlay size={12} className="ml-px" />}
          </button>
        </span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>
      <p className="text-[10px] leading-snug text-white/45">Levels, EQ and compression for every sound, then the master bus - the saved video sounds like this. Solo is just for listening.</p>
      <div className={`-mt-0.5 flex items-center gap-1.5 px-2 py-1 rounded text-[10px] ${selection ? "bg-teal-500/10 text-teal-100/85" : "bg-white/[0.04] text-white/45"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${selection ? "bg-teal-300" : "bg-white/25"}`} />
        {selection ? (
          <span className="truncate">
            ▶ plays <span className="font-medium">{selection.label}</span> on its own · {clock(selection.from)}–{clock(selection.to)}
          </span>
        ) : (
          <span>Select audio on the timeline to play it here - Ctrl-click for more</span>
        )}
      </div>
      <div className={`flex flex-col gap-1 overflow-y-auto -mx-1 px-1 ${dockHost ? "max-h-[70vh]" : "min-h-0"}`}>
        {channels.map((ch) => {
          const isOpen = expanded === ch.key;
          const soloed = session.solo.has(ch.key);
          const silenced = session.solo.size > 0 && !soloed;
          const hasFx = !isNeutralFx(ch.fx);
          return (
            <div key={ch.key} className={`rounded-md ring-1 ${isOpen ? "ring-teal-400/30 bg-white/[0.04]" : "ring-white/5 bg-white/[0.02]"} ${ch.muted || silenced ? "opacity-60" : ""}`}>
              <div className="flex flex-col gap-1 px-2 py-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <button type="button" onClick={() => setExpanded(isOpen ? null : ch.key)} className="shrink-0 text-white/50 hover:text-white" title={isOpen ? "Hide effects" : "Show EQ, compressor and balance"}>
                    {isOpen ? <IoChevronDown size={12} /> : <IoChevronForward size={12} />}
                  </button>
                  <span className="shrink-0 px-1 rounded text-[9px] uppercase tracking-wide text-white/50 bg-white/5">{KIND_LABEL[ch.kind]}</span>
                  <span className="flex-1 min-w-0 text-[11px] truncate" title={ch.name}>
                    {ch.name}
                    {ch.detail && <span className="text-white/40"> · {ch.detail}</span>}
                  </span>
                  {hasFx && (
                    <span className="shrink-0 px-1 rounded text-[9px] font-medium text-teal-300 bg-teal-500/15" title="Has effects">
                      FX
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => onMute(ch.key, !ch.muted)}
                    title={ch.muted ? "Unmute" : "Mute (in the saved video too)"}
                    className={`shrink-0 w-5 h-5 rounded text-[10px] font-semibold ${ch.muted ? "bg-red-500/80 text-white" : "bg-white/10 text-white/60 hover:text-white"}`}
                  >
                    M
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleSolo(ch.key)}
                    title={soloed ? "Stop soloing" : "Solo - hear only this (while editing; not saved)"}
                    className={`shrink-0 w-5 h-5 rounded text-[10px] font-semibold ${soloed ? "bg-amber-400 text-black" : "bg-white/10 text-white/60 hover:text-white"}`}
                  >
                    S
                  </button>
                </div>
                <Meter ids={ch.meterIds} />
                {ch.ducking && <DuckMeter read={ch.ducking.read} levelDb={ch.ducking.levelDb} />}
                <label className="flex items-center gap-2 text-[11px]">
                  <KnobSlider min={0} max={1} step={0.005} value={ch.volume} onChange={(v) => onVolume(ch.key, v)} resetTo={1} title="Level - double-click for 0 dB" />
                  <span className="w-11 shrink-0 text-right tabular-nums text-white/60">{levelLabel(ch.volume)} dB</span>
                </label>
              </div>
              {isOpen && (
                <div className="px-2 pb-2 pt-1.5 border-t border-white/10 flex flex-col gap-2">
                  {/* The strip's sound after its effects - whichever of its pieces is playing. */}
                  <LiveScope getAnalyser={() => stripAnalyser(ch.meterIds)} active height={40} />
                  <AudioFxEditor fx={ch.fx} onChange={(fx) => onFx(ch.key, fx)} />
                </div>
              )}
            </div>
          );
        })}
        {channels.length === 0 && <p className="text-[11px] text-white/50 py-2">Nothing in this edit makes a sound yet.</p>}
      </div>
      <MasterStrip master={master} onChange={onMasterChange} target={loudnessTarget} onTargetChange={onLoudnessTargetChange} />
    </div>,
    dockHost ?? document.body
  );
};

export default MixerPanel;
