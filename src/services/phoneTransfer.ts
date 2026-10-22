// Desktop half of "Transfer to phone". See src-tauri/src/services/phone_transfer.rs for the
// transport; this module is the one store every Transfer entry point (sidebar menu, galleries,
// file docker, timeline menu) shares, plus openPhoneTransfer() so any of them can raise the one
// dialog Dashboard mounts - without threading a callback through each component in between.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TransferFile {
    path: string;
    name: string;
}

export interface PhoneDevice {
    id: string;
    name: string;
    platform: "iphone" | "ipad" | "android" | "other" | string;
    online: boolean;
    // Whether its current connection is HTTPS (only meaningful while online).
    secure: boolean;
    last_seen: number;
}

// One address this computer can be reached on: the encrypted QR when this install has a
// certificate, and the plain-HTTP one that's only shown when the user asks for it.
export interface PhoneTransferAddress {
    host: string;
    secure_url: string | null;
    secure_qr: string | null;
    plain_url: string;
    plain_qr: string;
}

export type Encryption = { state: "ready" } | { state: "pending" } | { state: "unavailable"; reason: string };

export interface PhoneTransferInfo {
    addresses: PhoneTransferAddress[];
    devices: PhoneDevice[];
    encryption: Encryption;
    // The QR codes' pairing key stops working after this; fetch fresh info then.
    expires_in_secs: number;
}

// A phone that scanned a code and waits for approval, showing the same code on its screen.
export interface PairRequest {
    id: string;
    name: string;
    platform: string;
    code: string;
    secure: boolean;
}

export interface HistoryEntry {
    at: number;
    kind: "sent" | "received" | "receive_failed" | "paired" | "pair_denied" | "removed";
    device: string;
    name: string | null;
    size: number | null;
    secure: boolean;
    detail: string | null;
}

export type TransferState = "queued" | "offered" | "sending" | "done" | "interrupted";

export interface TransferStatus {
    offer_id: string;
    device_id: string;
    name: string;
    size: number;
    sent: number;
    state: TransferState;
}

// A file the phone is sending to this computer (its page's "Send to computer").
export interface IncomingStatus {
    id: string;
    device_id: string;
    device_name: string;
    name: string;
    size: number;
    received: number;
    state: "receiving" | "done" | "failed";
    path: string | null;
    error: string | null;
    // "timeline" when the phone chose "Add to timeline" - see onPhoneTimelineFile.
    target: "timeline" | "library";
    // Files picked or shared together; they go on the timeline together, in order.
    batch: string | null;
}

export interface PhoneTransferStore {
    // The files the dialog is open for; null when it's closed. Empty means "get files from a
    // phone" - the dialog then only pairs and lists phones.
    request: TransferFile[] | null;
    info: PhoneTransferInfo | null;
    devices: PhoneDevice[];
    transfers: Record<string, TransferStatus>;
    // Phone -> computer, in arrival order, until dismissed from the tray.
    incoming: IncomingStatus[];
    // Phones waiting for someone to approve them - shown even when the dialog is closed.
    pairRequests: PairRequest[];
    // Loaded on demand by the dialog's History view; null until then.
    history: HistoryEntry[] | null;
    error: string;
}

type Listener = (state: PhoneTransferStore) => void;
type ConnectListener = (device: PhoneDevice) => void;

let state: PhoneTransferStore = {
    request: null,
    info: null,
    devices: [],
    transfers: {},
    incoming: [],
    pairRequests: [],
    history: null,
    error: "",
};
const listeners = new Set<Listener>();
const connectListeners = new Set<ConnectListener>();
const timelineListeners = new Set<(file: IncomingStatus) => void>();
const arrivalListeners = new Set<(file: IncomingStatus) => void>();
const arrived = new Set<string>();
const handedToTimeline = new Set<string>();
let listening = false;

const setState = (patch: Partial<PhoneTransferStore>) => {
    state = { ...state, ...patch };
    const snapshot = { ...state };
    listeners.forEach((l) => l(snapshot));
};

// A small file can finish - and its "done" event land - before phone_transfer_send's own reply
// does, so a status never moves a transfer backwards.
const RANK: Record<TransferState, number> = { queued: 0, offered: 1, sending: 2, interrupted: 2, done: 3 };

const putTransfers = (statuses: TransferStatus[]) => {
    const transfers = { ...state.transfers };
    for (const s of statuses) {
        const prev = transfers[s.offer_id];
        if (!prev || RANK[s.state] >= RANK[prev.state]) transfers[s.offer_id] = s;
    }
    setState({ transfers });
};

const errorText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

// Subscribed once, lazily, and never torn down: transfers keep running (and reporting progress)
// after the dialog closes, and reopening it should show where they got to.
const ensureListening = () => {
    if (listening) return;
    listening = true;
    void listen<PhoneDevice[]>("phone-transfer-devices", (e) => setState({ devices: e.payload }));
    void listen<TransferStatus>("phone-transfer-progress", (e) => putTransfers([e.payload]));
    void listen<IncomingStatus>("phone-transfer-incoming", (e) => {
        const i = state.incoming.findIndex((x) => x.id === e.payload.id);
        const incoming = [...state.incoming];
        if (i >= 0) incoming[i] = e.payload;
        else incoming.push(e.payload);
        setState({ incoming });
        const file = e.payload;
        if (file.state === "done" && file.path && !arrived.has(file.id)) {
            arrived.add(file.id);
            arrivalListeners.forEach((l) => l(file));
        }
        if (file.state === "done" && file.target === "timeline" && !handedToTimeline.has(file.id)) {
            handedToTimeline.add(file.id);
            // No editor listening means no video is open - the file is safe in the library either way.
            if (timelineListeners.size) timelineListeners.forEach((l) => l(file));
            else void reportPhonePlacement(file, false, "No video is open in Briefcast — saved to your library");
        }
    });
    void listen<PhoneDevice>("phone-transfer-connected", (e) => connectListeners.forEach((l) => l(e.payload)));
    void listen<PairRequest>("phone-transfer-pair-request", (e) =>
        setState({ pairRequests: [...state.pairRequests.filter((r) => r.id !== e.payload.id), e.payload] })
    );
    void listen<string>("phone-transfer-pair-resolved", (e) =>
        setState({ pairRequests: state.pairRequests.filter((r) => r.id !== e.payload) })
    );
    void listen<HistoryEntry>("phone-transfer-history", (e) => {
        if (state.history) setState({ history: [e.payload, ...state.history] });
    });
    // A pairing key was spent or encryption became ready: the QR on screen is stale.
    void listen("phone-transfer-info-changed", () => {
        if (state.request) void startPhoneTransfer().catch(() => {});
    });
};

export const getPhoneTransferState = () => state;

export const subscribePhoneTransfer = (listener: Listener) => {
    ensureListening();
    listeners.add(listener);
    listener({ ...state });
    return () => {
        listeners.delete(listener);
    };
};

// Fired whenever a phone's page connects (newly paired or coming back) - the dialog uses it to
// send straight to a phone that just scanned the code.
export const onPhoneConnected = (listener: ConnectListener) => {
    ensureListening();
    connectListeners.add(listener);
    return () => {
        connectListeners.delete(listener);
    };
};

export const startPhoneTransfer = async () => {
    ensureListening();
    try {
        const info = await invoke<PhoneTransferInfo>("start_phone_transfer_server");
        setState({ info, devices: info.devices, error: "" });
        return info;
    } catch (e) {
        setState({ error: errorText(e) });
        throw e;
    }
};

export const openPhoneTransfer = (files: TransferFile[]) => {
    if (!files.length) return;
    setState({ request: files, error: "" });
    void startPhoneTransfer().catch(() => {
        /* surfaced through state.error */
    });
};

// Pair a phone / show the phones, with nothing to send - for getting files FROM a phone.
export const openPhoneReceive = () => {
    setState({ request: [], error: "" });
    void startPhoneTransfer().catch(() => {
        /* surfaced through state.error */
    });
};

export const closePhoneTransfer = () => setState({ request: null });

// Clears finished (done or failed) incoming files from the tray; ones still arriving stay.
export const dismissIncoming = () => setState({ incoming: state.incoming.filter((x) => x.state === "receiving") });

// The tray needs the event listeners running from app start, not only once a dialog has opened -
// a paired phone can send at any time.
export const initPhoneTransfer = () => ensureListening();

export const sendToPhone = async (deviceId: string, files: TransferFile[]) => {
    try {
        const statuses = await invoke<TransferStatus[]>("phone_transfer_send", { deviceId, files });
        setState({ error: "" });
        putTransfers(statuses);
        return statuses;
    } catch (e) {
        setState({ error: errorText(e) });
        throw e;
    }
};

// The video editor takes files a phone sent with "Add to timeline" - it subscribes while a video is
// open, and must answer each one with reportPhonePlacement.
export const onPhoneTimelineFile = (listener: (file: IncomingStatus) => void) => {
    ensureListening();
    timelineListeners.add(listener);
    return () => {
        timelineListeners.delete(listener);
    };
};

// Every file a phone finished sending here, once each (the home screen lists them).
export const onPhoneFileArrived = (listener: (file: IncomingStatus) => void) => {
    ensureListening();
    arrivalListeners.add(listener);
    return () => {
        arrivalListeners.delete(listener);
    };
};

// Which video is open in the editor (null: none) - phones offer "Add to timeline" while there is one.
export const setPhoneTimeline = (name: string | null) => invoke("phone_transfer_set_timeline", { name }).catch(() => {});

// Tells the phone that sent `file` where it ended up.
export const reportPhonePlacement = (file: IncomingStatus, placed: boolean, note?: string) =>
    invoke("phone_transfer_placed", { deviceId: file.device_id, uploadId: file.id, placed, note: note ?? null }).catch(() => {});

export const forgetPhone = async (deviceId: string) => {
    await invoke("phone_transfer_forget", { deviceId });
};

export const answerPairRequest = async (requestId: string, approve: boolean) => {
    setState({ pairRequests: state.pairRequests.filter((r) => r.id !== requestId) });
    try {
        await invoke("phone_transfer_answer_pair", { requestId, approve });
    } catch (e) {
        setState({ error: errorText(e) });
    }
};

export const loadPhoneHistory = async () => {
    try {
        const history = await invoke<HistoryEntry[]>("phone_transfer_history", { limit: 200 });
        setState({ history });
    } catch (e) {
        setState({ error: errorText(e) });
    }
};
