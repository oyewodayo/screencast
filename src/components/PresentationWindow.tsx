// PresentationWindow.tsx
//
// The live display itself: a borderless full-screen window (opened on the chosen monitor by
// services/presentation.ts; declared in tauri.conf.json) showing the cameras the operator put on it. It holds
// no state of its own - it renders the last "presentation-state" the main window sent, and opens
// the shown cameras at up to 1080p directly (no re-encoding on the way to the TV).
//
// Keys pressed while it has focus are forwarded to the main window as requests, so there's one
// place the display's state changes. The cursor hides after a moment so it never sits on the
// picture the room is looking at.

import { useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IoClose } from "react-icons/io5";
import PresentationStage from "./PresentationStage";
import { useCameraStreams } from "../hooks/useCameraStreams";
import { PHONE_CAMERA_DEVICE } from "../services/phoneCamera";
import {
    PRESENTATION_PHONE_OFFER_EVENT,
    iceGatheringComplete,
    PRESENTATION_REQUEST_EVENT,
    PRESENTATION_STATE_EVENT,
    PresentationRequest,
    PresentationState,
    liveCamera,
    presentationActionForKey,
    visibleCameras,
} from "../services/presentation";

const CURSOR_IDLE_MS = 2000;

const request = (r: PresentationRequest) => void emit(PRESENTATION_REQUEST_EVENT, r);

const PresentationWindow = () => {
    const [state, setState] = useState<PresentationState | null>(null);
    const [pointerActive, setPointerActive] = useState(false);
    const idleTimer = useRef<number | undefined>(undefined);

    // The phone camera, relayed from the main window (see syncPhoneRelay in presentation.ts):
    // each offer replaces the previous connection; a null offer means it left the display.
    const [phoneStream, setPhoneStream] = useState<MediaStream | null>(null);
    useEffect(() => {
        let pc: RTCPeerConnection | null = null;
        const unlistenState = listen<PresentationState>(PRESENTATION_STATE_EVENT, (e) => setState(e.payload));
        const unlistenOffer = listen<{ sdp: string } | null>(PRESENTATION_PHONE_OFFER_EVENT, async (e) => {
            pc?.close();
            pc = null;
            setPhoneStream(null);
            if (!e.payload) return;
            const conn = new RTCPeerConnection({ iceServers: [] });
            pc = conn;
            conn.ontrack = (t) => setPhoneStream(t.streams[0] ?? new MediaStream([t.track]));
            try {
                await conn.setRemoteDescription({ type: "offer", sdp: e.payload.sdp });
                await conn.setLocalDescription(await conn.createAnswer());
                await iceGatheringComplete(conn);
                if (pc !== conn) return;
                request({ type: "phone-answer", sdp: conn.localDescription?.sdp ?? "" });
            } catch (err) {
                console.error("Couldn't receive the phone camera:", err);
            }
        });
        // Ask for the current state (and the phone) once both listeners exist - the main window
        // may have sent either before this page finished loading.
        Promise.all([unlistenState, unlistenOffer]).then(() => request({ type: "ready" }));
        return () => {
            unlistenState.then((fn) => fn());
            unlistenOffer.then((fn) => fn());
            pc?.close();
        };
    }, []);

    // Alt+F4 would destroy this pre-declared window for the rest of the session - stop the
    // display instead, which hides it.
    useEffect(() => {
        const unlisten = getCurrentWindow().onCloseRequested((e) => {
            e.preventDefault();
            request({ type: "close" });
        });
        return () => {
            unlisten.then((fn) => fn());
        };
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                request({ type: "close" });
                return;
            }
            const action = presentationActionForKey(e);
            if (action) {
                e.preventDefault();
                request({ type: "action", action });
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const onPointerMove = () => {
        setPointerActive(true);
        window.clearTimeout(idleTimer.current);
        idleTimer.current = window.setTimeout(() => setPointerActive(false), CURSOR_IDLE_MS);
    };
    useEffect(() => () => window.clearTimeout(idleTimer.current), []);

    // Every shown camera stays open, including the ones off air in "single": opening a camera
    // takes the better part of a second, and a cut has to be instant. A camera taken off the
    // display is released.
    // Nothing is opened while the display is stopped (the window stays loaded, hidden).
    const shown = state?.active ? visibleCameras(state) : [];
    const live = state ? liveCamera(state) : null;
    const { streams, errors } = useCameraStreams(shown, "hd");

    return (
        <div
            className="fixed inset-0 bg-black select-none"
            style={{ cursor: pointerActive ? "default" : "none" }}
            onMouseMove={onPointerMove}
        >
            {state && (
                <PresentationStage
                    cameras={shown}
                    live={live}
                    layout={state.layout}
                    fit={state.fit}
                    showNames={state.showNames}
                    streams={phoneStream ? { ...streams, [PHONE_CAMERA_DEVICE]: phoneStream } : streams}
                    errors={errors}
                />
            )}
            {pointerActive && (
                <button
                    type="button"
                    onClick={() => request({ type: "close" })}
                    className="absolute top-4 right-4 flex items-center gap-2 px-3 py-2 rounded-xl bg-black/60 hover:bg-black/80 text-white text-sm backdrop-blur"
                    title="Stop the live display (Esc)"
                >
                    <IoClose size={18} />
                    Stop display
                </button>
            )}
        </div>
    );
};

export default PresentationWindow;
