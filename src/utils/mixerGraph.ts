// utils/mixerGraph.ts
//
// The live preview's side of the mixer, on one shared AudioContext:
//
//   track <audio>/<video> -> automation gain -> track-fx worklet -+
//   the main player's sound (VideoPlayer) -> track-fx worklet -----+-> master input
//                                                                        |
//   master input -> master-bus worklet (trim, limiter, LUFS/true-peak meter) -> listen -> speakers
//
// Each channel's worklet is the sample-exact twin of the export's EQ/compressor/balance
// (audioFx.ts) and reports that channel's level for the mixer's meters; the master worklet does the
// export's master stage (masterBus.ts) and measures what comes out of it. `listen` is the player's
// listening volume - after the master, so turning the speakers down never changes what the meters,
// the limiter or the saved video see.
//
// An element is only routed once its channel needs it (effects or automation set, the mixer open
// for its meters, or the master bus in use): createMediaElementSource takes the element's sound over
// for good, so an editor that never touches the mixer plays exactly as before. The element's own
// `volume` still applies first - the browser scales the samples before Web Audio sees them - which
// is the export's order too (volume, ducking and fades, automation, then the effects).
import { useSyncExternalStore } from "react";
import type { AudioFx } from "./audioFx";
import { isNeutralMaster, SILENT_READING, type MasterBus, type MasterReading } from "./masterBus";

const TRACK_FX_URL = "/audio-worklets/track-fx-processor.js";
const MASTER_URL = "/audio-worklets/master-bus-processor.js";

// Each worklet module is added to a context once, however many places ask for it.
const moduleLoads = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();
export function loadWorkletModule(ctx: BaseAudioContext, url: string): Promise<void> {
  let loads = moduleLoads.get(ctx);
  if (!loads) moduleLoads.set(ctx, (loads = new Map()));
  let load = loads.get(url);
  if (!load) {
    load = ctx.audioWorklet.addModule(url);
    load.catch(() => loads?.delete(url));
    loads.set(url, load);
  }
  return load;
}
export const loadTrackFxModule = (ctx: BaseAudioContext): Promise<void> => loadWorkletModule(ctx, TRACK_FX_URL);

let sharedCtx: AudioContext | null = null;
// The one context every channel plays through - so they can all meet on the master bus.
export function mixerContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 48000 });
  return sharedCtx;
}

// ---- Channel levels and scopes ------------------------------------------------------------------

// Peak levels (linear, per side) by meter id, refreshed ~30 times a second while sound flows.
const levels = new Map<string, { l: number; r: number; at: number }>();

export function readLevel(meterId: string): { l: number; r: number } {
  const v = levels.get(meterId);
  // Silence once the worklet stops reporting (paused, or the element went quiet).
  if (!v || performance.now() - v.at > 250) return { l: 0, r: 0 };
  return v;
}

// Each channel's worklet by meter id, and an analyser hung off it the first time a scope asks.
const meterNodes = new Map<string, AudioNode>();
const meterAnalysers = new Map<string, AnalyserNode>();

// The live signal of one channel, for drawing its waveform - null until that channel is routed.
export function channelAnalyser(meterId: string): AnalyserNode | null {
  const existing = meterAnalysers.get(meterId);
  if (existing) return existing;
  const node = meterNodes.get(meterId);
  if (!node) return null;
  const analyser = new AnalyserNode(node.context, { fftSize: 2048, smoothingTimeConstant: 0.6 });
  node.connect(analyser);
  meterAnalysers.set(meterId, analyser);
  return analyser;
}

// A worklet node for one channel - only once loadTrackFxModule(ctx) has resolved. Up-mixes its
// input to stereo the Web Audio way (mono -> both sides at full level), as the export does.
export function createTrackFxNode(ctx: BaseAudioContext, meterId: string): AudioWorkletNode {
  const node = new AudioWorkletNode(ctx, "track-fx-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });
  node.port.onmessage = (e) => {
    if (e.data?.type === "level") levels.set(meterId, { l: e.data.l, r: e.data.r, at: performance.now() });
  };
  meterNodes.set(meterId, node);
  // A channel rebuilt (the player remounted) gets a fresh scope tap.
  meterAnalysers.delete(meterId);
  return node;
}

export function setNodeFx(node: AudioWorkletNode, fx: AudioFx | undefined) {
  node.port.postMessage({ type: "fx", fx: fx ?? null });
}

// ---- Master bus -----------------------------------------------------------------------------------

interface Master {
  input: GainNode;
  node: AudioWorkletNode | null;
  listen: GainNode;
  analyser: AnalyserNode;
}
let master: Master | null = null;
let masterSettings: MasterBus | null = null;
let lastReading: { reading: MasterReading; at: number } = { reading: SILENT_READING, at: 0 };

// Where every channel connects. Plays straight to the speakers until the master worklet has loaded,
// then through it - spliced in once, with no await between the disconnect and the reconnect.
export function masterInput(): AudioNode {
  if (master) return master.input;
  const ctx = mixerContext();
  const input = new GainNode(ctx, { gain: 1 });
  const listen = new GainNode(ctx, { gain: timelineMuted ? 0 : listenLevel });
  const analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.78 });
  input.connect(listen);
  input.connect(analyser);
  listen.connect(ctx.destination);
  const m: Master = { input, node: null, listen, analyser };
  master = m;
  loadWorkletModule(ctx, MASTER_URL)
    .then(() => {
      const node = new AudioWorkletNode(ctx, "master-bus-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      node.port.onmessage = (e) => {
        const d = e.data;
        if (d?.type !== "meter") return;
        lastReading = {
          reading: { momentary: d.m, shortTerm: d.s, integrated: d.i, truePeakL: d.tpL, truePeakR: d.tpR, gainReductionDb: d.gr > 0 ? 20 * Math.log10(d.gr) : -Infinity },
          at: performance.now(),
        };
      };
      sendMasterSettings(node);
      input.disconnect();
      input.connect(node);
      node.connect(listen);
      node.connect(analyser);
      m.node = node;
    })
    .catch((err) => console.error("Master bus unavailable - the mix plays without it:", err));
  return input;
}

function sendMasterSettings(node: AudioWorkletNode) {
  const m = masterSettings;
  node.port.postMessage({ type: "master", trimDb: m?.trimDb ?? 0, limiter: m?.limiter ?? null });
}

// The open project's master settings (null when nothing's open or it has none).
export function setMasterBus(settings: MasterBus | null | undefined) {
  masterSettings = isNeutralMaster(settings) ? null : settings ?? null;
  if (master?.node) sendMasterSettings(master.node);
}

// Whether the master stage does anything - every channel is then routed through it.
export const masterBusActive = (): boolean => masterSettings !== null;

// The latest reading - silence once the worklet stops reporting (the context suspended).
export function readMaster(): MasterReading {
  if (!master?.node || performance.now() - lastReading.at > 400) return { ...lastReading.reading, momentary: -Infinity, shortTerm: lastReading.reading.shortTerm, truePeakL: 0, truePeakR: 0, gainReductionDb: 0 };
  return lastReading.reading;
}

// Starts the integrated loudness measurement over.
export function resetMasterLoudness() {
  master?.node?.port.postMessage({ type: "reset" });
}

// The whole mix after the master, for the audio-only stage's waveform.
export function mixerAnalyser(): AnalyserNode {
  masterInput();
  return master!.analyser;
}

// The player's listening volume, applied after the master.
let listenLevel = 1;
export function setListenLevel(level: number) {
  listenLevel = Math.max(0, Math.min(1, level));
  applyListen();
}
function applyListen() {
  if (master) master.listen.gain.setTargetAtTime(timelineMuted ? 0 : listenLevel, master.listen.context.currentTime, 0.015);
}

// The timeline's sound switched off while a voice-over is recorded over the picture (VoiceRecorder) -
// so the speakers stay quiet and nothing plays back into the mic. Every sound honours it: the master
// output here, and the player, the audio tracks and picture-in-picture where they set their volume
// (useTimelineMuted). The recorder's own "hear yourself" bypasses it.
let timelineMuted = false;
const mutedListeners = new Set<() => void>();
export function setTimelineMuted(muted: boolean) {
  if (muted === timelineMuted) return;
  timelineMuted = muted;
  applyListen();
  mutedListeners.forEach((l) => l());
}
export const isTimelineMuted = (): boolean => timelineMuted;
export function useTimelineMuted(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      mutedListeners.add(onChange);
      return () => mutedListeners.delete(onChange);
    },
    isTimelineMuted
  );
}

// ---- Media elements (audio tracks, picture-in-picture) -----------------------------------------

interface RoutedElement {
  node: AudioWorkletNode;
  // Volume automation (audioAutomation.ts), scheduled ahead by setElementGain.
  automation: GainNode;
}
const routed = new WeakMap<HTMLMediaElement, RoutedElement>();
const routing = new WeakMap<HTMLMediaElement, Promise<RoutedElement | null>>();

// Routes `el` through its own fx node (once - later calls just retune it) and applies `fx`.
// Resolves null if the worklet can't load; the element then keeps playing unprocessed.
export function routeElement(el: HTMLMediaElement, meterId: string, fx: AudioFx | undefined): Promise<RoutedElement | null> {
  const existing = routed.get(el);
  if (existing) {
    setNodeFx(existing.node, fx);
    return Promise.resolve(existing);
  }
  let pending = routing.get(el);
  if (!pending) {
    const ctx = mixerContext();
    pending = loadTrackFxModule(ctx)
      .then(() => {
        // Source, nodes and connections together, with no await in between - the element's own
        // output stops the moment createMediaElementSource runs.
        const source = ctx.createMediaElementSource(el);
        const automation = new GainNode(ctx, { gain: 1 });
        const node = createTrackFxNode(ctx, meterId);
        source.connect(automation).connect(node).connect(masterInput());
        const entry = { node, automation };
        routed.set(el, entry);
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        return entry;
      })
      .catch((err) => {
        console.error("Mixer effects unavailable - this track plays without them:", err);
        return null;
      });
    routing.set(el, pending);
  }
  return pending.then((entry) => {
    // The latest settings, not the ones this call was first made with.
    if (entry) setNodeFx(entry.node, latestFx.get(el) ?? fx);
    return entry;
  });
}

const latestFx = new WeakMap<HTMLMediaElement, AudioFx | undefined>();
const sentFx = new WeakMap<HTMLMediaElement, string>();

// Keeps `el`'s effects in step with `fx`: routes it the first time it needs routing (`fx` does
// something, or the mixer wants its level) and retunes it when the settings change. Cheap to call
// on every playback tick.
export function syncElementFx(el: HTMLMediaElement, meterId: string, fx: AudioFx | undefined, needsRouting: boolean) {
  latestFx.set(el, fx);
  const key = JSON.stringify(fx ?? null);
  const existing = routed.get(el);
  if (existing) {
    if (sentFx.get(el) !== key) {
      sentFx.set(el, key);
      setNodeFx(existing.node, fx);
    }
    return;
  }
  if (routing.has(el) || needsRouting || masterBusActive()) {
    sentFx.set(el, key);
    void routeElement(el, meterId, fx);
  }
}

// How far ahead the automation is laid down, and how finely - re-laid on every playback tick
// (~25 times a second), so a seek or an edit takes over within one tick.
const AUTOMATION_HORIZON_SEC = 0.15;
const AUTOMATION_STEP_SEC = 0.01;

// Drives `el`'s automation gain from `gainAt` (its own media time -> linear gain): set outright while
// paused; while playing, a run of short linear ramps along the curve from where it is now, so even a
// steep move is smooth rather than stepped. False when `el` isn't routed (yet) - the caller then
// folds the gain into the element's volume instead.
export function setElementGain(el: HTMLMediaElement, gainAt: ((mediaTime: number) => number) | null): boolean {
  const entry = routed.get(el);
  if (!entry) return false;
  const param = entry.automation.gain;
  const now = entry.automation.context.currentTime;
  const hold = (p: AudioParam, t: number) => (typeof p.cancelAndHoldAtTime === "function" ? p.cancelAndHoldAtTime(t) : p.cancelScheduledValues(t));
  hold(param, now);
  if (!gainAt) {
    param.setValueAtTime(1, now);
    return true;
  }
  const from = el.currentTime;
  if (el.paused) {
    param.setValueAtTime(gainAt(from), now);
    return true;
  }
  const rate = el.playbackRate || 1;
  param.setValueAtTime(gainAt(from), now);
  for (let dt = AUTOMATION_STEP_SEC; dt <= AUTOMATION_HORIZON_SEC + 1e-9; dt += AUTOMATION_STEP_SEC) {
    param.linearRampToValueAtTime(gainAt(from + dt * rate), now + dt);
  }
  return true;
}

// The shared context is created suspended when nothing has been clicked yet - playback resumes it.
export function resumeMixer() {
  if (sharedCtx?.state === "suspended") sharedCtx.resume().catch(() => {});
}
