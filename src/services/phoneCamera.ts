// Desktop half of the phone-as-camera feature. See src-tauri/src/services/phone_camera.rs for
// the transport design and why it works this way; in short, the phone's browser captures with
// getUserMedia and pushes over WebRTC, the Rust server only relays signalling, and *this* module
// is the receiving peer - the WebView is a full Chromium, so it can terminate the connection
// itself rather than needing a WebRTC stack in Rust.
//
// Deliberately a module-level singleton rather than React state: the same live MediaStream has to
// be visible to the pairing modal, the overlay preview, and the recorder that runs during a
// capture, and those live in different branches of the tree. A store with subscribers keeps them
// on one stream without threading a provider through the whole app or - far worse - opening a
// second peer connection per consumer.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Must match PHONE_DEVICE_SENTINEL in src-tauri/src/services/phone_camera.rs. Both sides also
// rely on this never being a plausible DirectShow friendly name, so it can't collide with a
// real camera in the "Video device(s)" list.
export const PHONE_CAMERA_DEVICE = "__briefcast_phone_camera__";

// What the device checklist shows for the sentinel above.
export const PHONE_CAMERA_LABEL = "Phone camera";

export interface PhoneCameraAddress {
    url: string;
    host: string;
    qr_svg: string;
}

export interface PhoneCameraInfo {
    url: string;
    host: string;
    port: number;
    qr_svg: string;
    // Other addresses this machine is listening on. Present because auto-detection can land on a
    // WSL/Hyper-V virtual adapter a phone has no route to, and that failure is otherwise entirely
    // silent - see lan_addresses in src-tauri/src/services/phone_camera.rs.
    alternatives: PhoneCameraAddress[];
    phone_connected: boolean;
}

export type PhoneCameraStatus =
    | "off"          // server not running
    | "waiting"      // server up, no phone has opened the page
    | "connecting"   // phone is negotiating
    | "live"         // stream flowing
    | "error";

export interface PhoneCameraState {
    status: PhoneCameraStatus;
    info: PhoneCameraInfo | null;
    stream: MediaStream | null;
    error: string;
}

type Listener = (state: PhoneCameraState) => void;

let state: PhoneCameraState = { status: "off", info: null, stream: null, error: "" };
const listeners = new Set<Listener>();

let pc: RTCPeerConnection | null = null;
// ICE candidates that arrived before the peer was ready for them. Tauri event handlers aren't
// serialised against each other, and the phone starts trickling candidates the moment it has sent
// its offer - so a candidate can very reasonably land while handleOffer is still awaiting
// setRemoteDescription. addIceCandidate throws in that window, and a silently dropped candidate is
// exactly the kind of thing that turns into an intermittent "sometimes it never connects".
let pendingCandidates: RTCIceCandidateInit[] = [];
let remoteDescriptionSet = false;
let unlistenSignal: UnlistenFn | null = null;
let unlistenState: UnlistenFn | null = null;

const emit = () => {
    // Copied per notification so subscribers comparing previous/next in an effect see a new
    // object and don't skip an update whose only change was a nested field.
    const snapshot = { ...state };
    listeners.forEach((l) => l(snapshot));
};

const setState = (patch: Partial<PhoneCameraState>) => {
    state = { ...state, ...patch };
    emit();
};

export const getPhoneCameraState = (): PhoneCameraState => state;

export const subscribePhoneCamera = (listener: Listener): (() => void) => {
    listeners.add(listener);
    listener({ ...state });
    return () => {
        listeners.delete(listener);
    };
};

const sendSignal = async (payload: Record<string, unknown>) => {
    try {
        await invoke("phone_camera_send_signal", { payload: JSON.stringify(payload) });
    } catch {
        // The phone dropped mid-negotiation. The socket's own close handler drives the state
        // change, so there's nothing useful to surface from an individual failed send.
    }
};

const teardownPeer = () => {
    if (pc) {
        try {
            pc.close();
        } catch {
            /* already closed */
        }
        pc = null;
    }
    pendingCandidates = [];
    remoteDescriptionSet = false;
    if (state.stream) {
        state.stream.getTracks().forEach((t) => t.stop());
    }
};

// The phone always creates the offer - it's the side that owns the media, so it knows what it's
// offering before the desktop knows anything at all. This side only ever answers.
const handleOffer = async (sdp: string) => {
    teardownPeer();
    setState({ status: "connecting", error: "" });

    // No ICE servers, matching the phone page: both ends are on the same LAN by construction, so
    // host candidates connect directly and the feature keeps working with no internet at all.
    pc = new RTCPeerConnection({ iceServers: [] });

    pc.ontrack = (event) => {
        const [incoming] = event.streams;
        if (incoming) setState({ stream: incoming, status: "live", error: "" });
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) void sendSignal({ type: "ice", candidate: event.candidate.toJSON() });
    };

    pc.onconnectionstatechange = () => {
        if (!pc) return;
        if (pc.connectionState === "failed") {
            setState({
                status: "error",
                error: "Lost the direct connection to the phone. Check that both devices are on the same Wi-Fi network.",
            });
        } else if (pc.connectionState === "disconnected") {
            setState({ status: "connecting" });
        }
    };

    try {
        await pc.setRemoteDescription({ type: "offer", sdp });
        remoteDescriptionSet = true;
        // Anything that arrived during the await above is now safe to apply.
        const queued = pendingCandidates;
        pendingCandidates = [];
        for (const candidate of queued) {
            try {
                await pc.addIceCandidate(candidate);
            } catch {
                /* a candidate this peer can't use - ICE has others */
            }
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal({ type: "answer", sdp: answer.sdp });
    } catch (e) {
        setState({ status: "error", error: `Could not connect to the phone: ${e}` });
    }
};

const handleSignal = async (raw: string) => {
    let msg: any;
    try {
        msg = JSON.parse(raw);
    } catch {
        return;
    }

    if (msg.type === "offer") {
        await handleOffer(msg.sdp);
    } else if (msg.type === "ice" && msg.candidate) {
        if (!pc || !remoteDescriptionSet) {
            // Too early - queued and flushed by handleOffer once the remote description lands.
            pendingCandidates.push(msg.candidate);
            return;
        }
        try {
            await pc.addIceCandidate(msg.candidate);
        } catch {
            // A candidate arriving after the peer is gone. Not fatal - ICE has others.
        }
    } else if (msg.type === "bye") {
        teardownPeer();
        setState({ stream: null, status: "waiting" });
    }
};

// Starts (or re-attaches to) the pairing server. Safe to call repeatedly - the Rust side is
// idempotent, so reopening the pairing panel never disturbs a phone that's already streaming.
export const startPhoneCamera = async (): Promise<PhoneCameraInfo> => {
    if (!unlistenSignal) {
        unlistenSignal = await listen<string>("phone-camera-signal", (e) => {
            void handleSignal(e.payload);
        });
    }
    if (!unlistenState) {
        unlistenState = await listen<string>("phone-camera-state", (e) => {
            if (e.payload === "disconnected") {
                teardownPeer();
                setState({ stream: null, status: "waiting" });
            } else if (e.payload === "connected") {
                // The phone has loaded the page but hasn't offered yet - it's still waiting on
                // the user to tap Start and grant camera permission.
                setState({ status: "connecting", error: "" });
            }
        });
    }

    try {
        const info = await invoke<PhoneCameraInfo>("start_phone_camera_server");
        setState({
            info,
            error: "",
            status: state.stream ? "live" : info.phone_connected ? "connecting" : "waiting",
        });
        return info;
    } catch (e) {
        setState({ status: "error", error: String(e) });
        throw e;
    }
};

// Tears the whole thing down: peer, stream, server, and event subscriptions.
export const stopPhoneCamera = async (): Promise<void> => {
    teardownPeer();
    unlistenSignal?.();
    unlistenState?.();
    unlistenSignal = null;
    unlistenState = null;
    try {
        await invoke("stop_phone_camera_server");
    } catch {
        /* already stopped */
    }
    setState({ status: "off", info: null, stream: null, error: "" });
};

// ---------------------------------------------------------------------------
// Recording the phone stream
// ---------------------------------------------------------------------------

// Picks the best container the WebView will actually give us. Recent Chromium can write H.264
// straight into mp4, which lets the Rust side skip a re-encode; older builds only do webm. Both
// are handled by save_phone_camera_capture, so this is purely an optimisation.
const pickMimeType = (): string => {
    const candidates = [
        "video/mp4;codecs=h264",
        "video/webm;codecs=h264",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
};

export interface PhoneCaptureHandle {
    stop: () => Promise<void>;
}

// Records the live phone stream to `<stem>_webcam.mp4` alongside the screen recording, which is
// exactly where the editor's PiP layer already looks (get_webcam_sidecar_path, recording.rs).
//
// Note there's no path parameter: the backend resolves the destination from the recording it
// already has in progress. start_recording returns a human-readable message rather than a path,
// so a path threaded through here is a path waiting to be wrong.
//
// `recordingStartedAt` is the timestamp ffmpeg was launched at. The gap between that and the
// first frame here is unavoidable - start_recording spawns ffmpeg and waits out its early-exit
// check before returning - so it's measured and handed to the Rust side, which pads the front of
// the camera file to put both files on a shared t=0.
export const startPhoneCapture = (
    recordingStartedAt: number,
    onError?: (message: string) => void
): PhoneCaptureHandle | null => {
    const stream = state.stream;
    if (!stream) return null;

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
    } catch (e) {
        onError?.(`Could not record the phone camera: ${e}`);
        return null;
    }

    const effectiveMime = recorder.mimeType || mimeType || "video/webm";
    const startOffsetMs = Math.max(0, Date.now() - recordingStartedAt);

    // Each chunk is written straight through to disk rather than accumulated here. Everything
    // crossing Tauri's IPC goes as JSON, and a few minutes of 1080p held whole and inflated into a
    // JSON byte array is enough to wedge the WebView - see phone_camera_capture_chunk's own
    // comment. Streaming also means a crash mid-recording leaves the footage so far on disk.
    let chunkCount = 0;
    let writeFailed = false;
    // Writes are chained rather than fired in parallel: `invoke` resolves out of order under load,
    // and these are appends to one file, where order is the entire content.
    let writeChain: Promise<void> = Promise.resolve();

    const toBase64 = (buffer: ArrayBuffer): string => {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        // Chunked through String.fromCharCode because spreading a megabyte-plus array blows the
        // argument limit.
        const STEP = 0x8000;
        for (let i = 0; i < bytes.length; i += STEP) {
            binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
        }
        return btoa(binary);
    };

    recorder.ondataavailable = (e) => {
        if (e.data.size === 0 || writeFailed) return;
        const isFirst = chunkCount === 0;
        chunkCount += 1;
        writeChain = writeChain.then(async () => {
            if (writeFailed) return;
            try {
                const buffer = await e.data.arrayBuffer();
                await invoke("phone_camera_capture_chunk", {
                    mimeType: effectiveMime,
                    chunkB64: toBase64(buffer),
                    first: isFirst,
                });
            } catch (err) {
                // Stop after the first failure: every later chunk appends to the same file, so
                // continuing past a gap would produce a silently corrupt recording.
                writeFailed = true;
                onError?.(`Failed to save the phone camera recording: ${err}`);
            }
        });
    };

    const finished = new Promise<void>((resolve) => {
        recorder.onstop = async () => {
            try {
                await writeChain;
                if (chunkCount === 0) {
                    onError?.("The phone camera stopped before anything was recorded.");
                    return;
                }
                if (writeFailed) return;
                await invoke("save_phone_camera_capture", { startOffsetMs });
            } catch (e) {
                onError?.(`Failed to save the phone camera recording: ${e}`);
            } finally {
                resolve();
            }
        };
    });

    // One chunk per second: small enough that each IPC message stays around a megabyte, frequent
    // enough that little is lost if the app dies mid-recording.
    recorder.start(1000);

    return {
        stop: async () => {
            if (recorder.state !== "inactive") recorder.stop();
            await finished;
        },
    };
};
