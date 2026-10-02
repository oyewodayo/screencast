// services/presentation.ts
//
// The live camera display ("Present" mode): connected cameras shown full screen on a chosen
// monitor - a TV, projector or confidence screen at a service or event - while the operator
// decides from the main window which cameras are on it and how they're arranged.
//
// The main window owns this state. Every change is broadcast as a "presentation-state" event,
// and the display window (PresentationWindow.tsx, its own webview) renders whatever it last
// received. The display only ever sends requests back ("presentation-request"): "ready" when it
// loads, so it can be sent the current state, and "close" when the operator presses Esc on it.
//
// Cameras plugged into this PC (USB webcams, HDMI capture cards) are opened by the display window
// itself, at up to 1080p, so nothing is re-encoded on the way. The phone camera is different: its
// stream exists only inside the main window's WebRTC connection to the phone, so while it's on the
// display the main window relays it to the display window over a second, local WebRTC connection
// (see syncPhoneRelay) - signalled through Tauri events, never leaving this PC.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition } from "@tauri-apps/api/window";
import { isRegistered, register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { PHONE_CAMERA_DEVICE, PHONE_CAMERA_LABEL, getPhoneCameraState, subscribePhoneCamera } from "./phoneCamera";

// grid: every shown camera, tiled evenly. spotlight: the live camera large, the others in a
// column beside it. single: only the live camera - cutting between cameras like a vision mixer.
export type PresentationLayout = "grid" | "spotlight" | "single";
export type PresentationFit = "fill" | "fit";

export interface PresentationState {
    active: boolean;
    // Every camera that can be put on the display, in order (the phone as PHONE_CAMERA_DEVICE).
    cameras: string[];
    // Cameras the operator has taken off the display.
    hidden: string[];
    layout: PresentationLayout;
    // The camera that's "on air" in spotlight/single; null means the first shown camera.
    live: string | null;
    fit: PresentationFit;
    showNames: boolean;
    // A get_monitors id; null means "the last monitor" (the TV, on a laptop with one attached).
    monitorId: string | null;
}

export const PRESENTATION_STATE_EVENT = "presentation-state";
export const PRESENTATION_REQUEST_EVENT = "presentation-request";
export const PRESENTATION_WINDOW_LABEL = "presentation";

// What the operator can do to the display - from the control bar, the modal, the keyboard, or
// the display window itself (which forwards its keys here as requests).
//   cut: put camera N (1-based, in `cameras` order) on air, alone if the layout was the grid.
//   toggle: add camera N to / take it off the display.
//   all: every camera back on, tiled.
//   layout: switch to a layout, or to the next one.
export type PresentationAction =
    | { type: "cut"; index: number }
    | { type: "toggle"; index: number }
    | { type: "all" }
    | { type: "layout"; layout?: PresentationLayout };

export type PresentationRequest =
    | { type: "ready" }
    | { type: "close" }
    | { type: "action"; action: PresentationAction }
    | { type: "phone-answer"; sdp: string };

// Main -> display: a fresh offer for the relayed phone stream, or null when it's off the display.
export const PRESENTATION_PHONE_OFFER_EVENT = "presentation-phone-offer";

// What to call a camera on screen - the phone's sentinel id isn't a name.
export const cameraDisplayName = (camera: string) => (camera === PHONE_CAMERA_DEVICE ? PHONE_CAMERA_LABEL : camera);

// Resolves once ICE gathering is done (or after a short cap), so each side's description carries
// its candidates and the exchange is a single offer and answer - nothing to trickle.
export const iceGatheringComplete = (pc: RTCPeerConnection, capMs = 1500) =>
    new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const done = () => {
            pc.removeEventListener("icegatheringstatechange", check);
            clearTimeout(timer);
            resolve();
        };
        const check = () => pc.iceGatheringState === "complete" && done();
        pc.addEventListener("icegatheringstatechange", check);
        const timer = setTimeout(done, capMs);
    });

const STORAGE_KEY = "briefcast.presentation";

// The operator's arrangement survives restarts: a church sets this up once.
const PERSISTED: (keyof PresentationState)[] = ["hidden", "layout", "live", "fit", "showNames", "monitorId"];

const load = (): PresentationState => {
    const base: PresentationState = {
        active: false,
        cameras: [],
        hidden: [],
        layout: "grid",
        live: null,
        fit: "fill",
        showNames: false,
        monitorId: null,
    };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            for (const k of PERSISTED) if (saved[k] !== undefined) (base as any)[k] = saved[k];
        }
    } catch {
        // Defaults are fine.
    }
    return base;
};

let state: PresentationState = load();
type Listener = (s: PresentationState) => void;
const listeners = new Set<Listener>();

const persist = () => {
    try {
        const saved: Record<string, unknown> = {};
        for (const k of PERSISTED) saved[k] = state[k];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
        // Best effort.
    }
};

const publish = () => {
    listeners.forEach((l) => l(state));
    persist();
    if (state.active) void emit(PRESENTATION_STATE_EVENT, state);
    void syncPhoneRelay();
};

// ---- Phone relay (main window side) ----
// The relay exists only while the display is live, has said it's ready, and shows the phone, and
// is rebuilt whenever the phone's own stream changes (a reconnect hands over a new MediaStream).
let displayReady = false;
let relay: RTCPeerConnection | null = null;
let relayedStream: MediaStream | null = null;

const closeRelay = (notify: boolean) => {
    if (!relay) return;
    relay.close();
    relay = null;
    relayedStream = null;
    if (notify) void emit(PRESENTATION_PHONE_OFFER_EVENT, null);
};

const syncPhoneRelay = async () => {
    const stream = getPhoneCameraState().stream;
    const wanted = state.active && displayReady && !!stream && visibleCameras(state).includes(PHONE_CAMERA_DEVICE);
    if (!wanted || !stream) return closeRelay(state.active && displayReady);
    if (relay && relayedStream === stream) return;
    closeRelay(false);

    const pc = new RTCPeerConnection({ iceServers: [] });
    relay = pc;
    relayedStream = stream;
    for (const track of stream.getVideoTracks()) {
        const sender = pc.addTrack(track, stream);
        // A local link has bandwidth to spare - let the encoder keep the phone's detail for a TV.
        const params = sender.getParameters();
        params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: 8_000_000 }];
        void sender.setParameters(params).catch(() => {});
    }
    try {
        await pc.setLocalDescription(await pc.createOffer());
        await iceGatheringComplete(pc);
        if (relay !== pc) return;
        await emit(PRESENTATION_PHONE_OFFER_EVENT, { sdp: pc.localDescription?.sdp });
    } catch (err) {
        console.error("Phone relay to the live display failed:", err);
        if (relay === pc) closeRelay(false);
    }
};

const answerPhoneRelay = async (sdp: string) => {
    try {
        await relay?.setRemoteDescription({ type: "answer", sdp });
    } catch (err) {
        console.error("Phone relay answer rejected:", err);
    }
};

export const getPresentationState = () => state;

export const subscribePresentation = (listener: Listener): (() => void) => {
    listeners.add(listener);
    listener(state);
    return () => {
        listeners.delete(listener);
    };
};

export const updatePresentation = (patch: Partial<PresentationState>) => {
    state = { ...state, ...patch };
    publish();
};

// The cameras actually on the display, in order.
export const visibleCameras = (s: PresentationState) => s.cameras.filter((c) => !s.hidden.includes(c));

// The camera on air in spotlight/single: the chosen one if it's shown, otherwise the first shown.
export const liveCamera = (s: PresentationState): string | null => {
    const shown = visibleCameras(s);
    return s.live && shown.includes(s.live) ? s.live : shown[0] ?? null;
};

export const toggleCameraHidden = (camera: string) => {
    const hidden = state.hidden.includes(camera) ? state.hidden.filter((c) => c !== camera) : [...state.hidden, camera];
    updatePresentation({ hidden });
};

// Puts a camera on air - showing it first if it was hidden.
export const goLive = (camera: string) => {
    updatePresentation({ live: camera, hidden: state.hidden.filter((c) => c !== camera) });
};

const LAYOUT_ORDER: PresentationLayout[] = ["grid", "spotlight", "single"];

export const applyPresentationAction = (action: PresentationAction) => {
    if (action.type === "cut" || action.type === "toggle") {
        const camera = state.cameras[action.index - 1];
        if (!camera) return;
        if (action.type === "toggle") return toggleCameraHidden(camera);
        updatePresentation({
            live: camera,
            hidden: state.hidden.filter((c) => c !== camera),
            layout: state.layout === "grid" ? "single" : state.layout,
        });
    } else if (action.type === "all") {
        updatePresentation({ hidden: [], layout: "grid" });
    } else {
        const next = action.layout ?? LAYOUT_ORDER[(LAYOUT_ORDER.indexOf(state.layout) + 1) % LAYOUT_ORDER.length];
        updatePresentation({ layout: next });
    }
};

// Plain keys, for whichever Briefcast window has focus (the main window and the display share
// them): 1-9 cut to that camera, Shift+1-9 add/remove it, 0 shows all, G/S/O pick grid/
// spotlight/one camera, L cycles layouts. Ignored while typing.
export const presentationActionForKey = (e: KeyboardEvent): PresentationAction | null => {
    if (e.ctrlKey || e.altKey || e.metaKey) return null;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return null;
    const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
    if (digit !== undefined) {
        const n = Number(digit);
        if (n === 0) return e.shiftKey ? null : { type: "all" };
        return { type: e.shiftKey ? "toggle" : "cut", index: n };
    }
    if (e.shiftKey) return null;
    switch (e.key.toLowerCase()) {
        case "g":
            return { type: "layout", layout: "grid" };
        case "s":
            return { type: "layout", layout: "spotlight" };
        case "o":
            return { type: "layout", layout: "single" };
        case "l":
            return { type: "layout" };
        default:
            return null;
    }
};

// System-wide while the display is live, so the operator can cut cameras from another app
// (slides, lyrics): Alt+Shift+1-9 cut, Alt+Shift+0 all cameras, Alt+Shift+L next layout. Alt+Shift
// rather than Ctrl+Alt (AltGr on many keyboards), matching the recording's Alt+Shift+V.
const GLOBAL_SHORTCUTS: [string, PresentationAction][] = [
    ...Array.from({ length: 9 }, (_, i) => [`Alt+Shift+${i + 1}`, { type: "cut", index: i + 1 }] as [string, PresentationAction]),
    ["Alt+Shift+0", { type: "all" }],
    ["Alt+Shift+L", { type: "layout" }],
];

const registerGlobalShortcuts = async () => {
    for (const [shortcut, action] of GLOBAL_SHORTCUTS) {
        try {
            // Re-registered rather than skipped: after a page reload the plugin still holds the
            // shortcut, bound to the dead page's callback (see bindShortcut in Dashboard.tsx).
            if (await isRegistered(shortcut)) await unregister(shortcut);
            await register(shortcut, (event) => {
                if (event.state === "Pressed") applyPresentationAction(action);
            });
        } catch (err) {
            // Taken by another app - the in-app keys still work.
            console.warn(`Couldn't register ${shortcut}:`, err);
        }
    }
};

const unregisterGlobalShortcuts = async () => {
    for (const [shortcut] of GLOBAL_SHORTCUTS) {
        try {
            if (await isRegistered(shortcut)) await unregister(shortcut);
        } catch {
            // Already gone.
        }
    }
};

let unlistenRequests: (() => void) | null = null;

const ensureRequestListener = async () => {
    if (unlistenRequests) return;
    unlistenRequests = await listen<PresentationRequest>(PRESENTATION_REQUEST_EVENT, (event) => {
        const r = event.payload;
        if (r.type === "ready" && state.active) {
            // A (re)loaded display has no relay of its own yet - build a fresh one.
            displayReady = true;
            closeRelay(false);
            void emit(PRESENTATION_STATE_EVENT, state);
            void syncPhoneRelay();
        }
        if (r.type === "close") void stopPresentation();
        if (r.type === "action") applyPresentationAction(r.action);
        if (r.type === "phone-answer") void answerPhoneRelay(r.sdp);
    });
    subscribePhoneCamera(() => void syncPhoneRelay());
};

// The display window is pre-declared in tauri.conf.json (created hidden at startup, like the
// app's other overlays) and only ever shown, moved and hidden from here - building windows from a
// command has hung this app before (see ANNOTATION_FEATURE_DISABLED in Dashboard.tsx).
const displayWindow = async () => {
    const w = await WebviewWindow.getByLabel(PRESENTATION_WINDOW_LABEL);
    if (!w) throw new Error("The live display window is missing - restart Briefcast");
    return w;
};

interface MonitorGeometry {
    id: string;
    x: number;
    y: number;
}

// Full screen on `monitorId`, or the last monitor (the TV, on a laptop with one attached) when
// it's unset or no longer connected.
const placeOnMonitor = async (w: WebviewWindow, monitorId: string | null) => {
    const monitors = await invoke<MonitorGeometry[]>("get_monitors");
    const m = monitors.find((mon) => mon.id === monitorId) ?? monitors[monitors.length - 1];
    if (!m) throw new Error("No display found");
    // Full screen pins a window to its current monitor, so leave it before moving.
    await w.setFullscreen(false);
    await w.setPosition(new PhysicalPosition(m.x + 50, m.y + 50));
    await w.setFullscreen(true);
};

export const startPresentation = async (monitorId?: string | null) => {
    await ensureRequestListener();
    const target = monitorId === undefined ? state.monitorId : monitorId;
    state = { ...state, active: true, monitorId: target };
    publish();
    try {
        const w = await displayWindow();
        await placeOnMonitor(w, target);
        await w.show();
    } catch (err) {
        state = { ...state, active: false };
        publish();
        throw err;
    }
    // The page has been loaded and listening since startup.
    displayReady = true;
    void emit(PRESENTATION_STATE_EVENT, state);
    void syncPhoneRelay();
    void registerGlobalShortcuts();
};

export const stopPresentation = async () => {
    displayReady = false;
    state = { ...state, active: false };
    publish();
    // Tells the display to let go of its cameras.
    void emit(PRESENTATION_STATE_EVENT, state);
    await unregisterGlobalShortcuts();
    const w = await WebviewWindow.getByLabel(PRESENTATION_WINDOW_LABEL);
    if (w) {
        await w.setFullscreen(false);
        await w.hide();
    }
};
