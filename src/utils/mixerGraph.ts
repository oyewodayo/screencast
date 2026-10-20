// utils/mixerGraph.ts
//
// The live preview's side of the mixer: routes a media element (an audio track's hidden <audio>,
// a picture-in-picture's <video>, the main player's own sound) through the track-fx worklet - the
// sample-exact twin of the export's EQ/compressor/balance (audioFx.ts) - and collects each
// channel's level for the mixer's meters.
//
// An element is only routed once its channel needs it (effects set, or the mixer open for its
// meters): createMediaElementSource takes the element's sound over for good, so an editor that
// never touches the mixer plays exactly as before. The element's own `volume` still applies first
// - the browser scales the samples before Web Audio sees them - which is the export's order too
// (volume, ducking and fades, then the effects).
import type { AudioFx } from "./audioFx";

const MODULE_URL = "/audio-worklets/track-fx-processor.js";

const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();

export function loadTrackFxModule(ctx: BaseAudioContext): Promise<void> {
  let load = moduleLoads.get(ctx);
  if (!load) {
    load = ctx.audioWorklet.addModule(MODULE_URL);
    moduleLoads.set(ctx, load);
  }
  return load;
}

// Peak levels (linear, per side) by meter id, refreshed ~30 times a second while sound flows.
const levels = new Map<string, { l: number; r: number; at: number }>();

export function readLevel(meterId: string): { l: number; r: number } {
  const v = levels.get(meterId);
  // Silence once the worklet stops reporting (paused, or the element went quiet).
  if (!v || performance.now() - v.at > 250) return { l: 0, r: 0 };
  return v;
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
  return node;
}

export function setNodeFx(node: AudioWorkletNode, fx: AudioFx | undefined) {
  node.port.postMessage({ type: "fx", fx: fx ?? null });
}

// ---- Media elements (audio tracks, picture-in-picture) -----------------------------------------

let sharedCtx: AudioContext | null = null;
function mixerContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 48000 });
  return sharedCtx;
}

interface RoutedElement {
  node: AudioWorkletNode;
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
        // Source, node and connections together, with no await in between - the element's own
        // output stops the moment createMediaElementSource runs.
        const source = ctx.createMediaElementSource(el);
        const node = createTrackFxNode(ctx, meterId);
        source.connect(node).connect(ctx.destination);
        const entry = { node };
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
  if (routing.has(el) || needsRouting) {
    sentFx.set(el, key);
    void routeElement(el, meterId, fx);
  }
}

// The shared context is created suspended when nothing has been clicked yet - playback resumes it.
export function resumeMixer() {
  if (sharedCtx?.state === "suspended") sharedCtx.resume().catch(() => {});
}
