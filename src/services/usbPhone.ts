// Desktop side of phones on a USB cable - see src-tauri/src/services/usb_phone.rs. One store shared
// by the plug-in card (UsbPhoneTray), the import window (UsbImportModal: camera roll, documents, or
// browse the whole phone) and the Transfer dialog, which lists USB phones above the Wi-Fi ones.

import { startTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface UsbPhone {
    id: string;
    name: string;
    kind: "android" | "iphone" | "other";
    // "locked": an Android screen lock or an iPhone that hasn't trusted this computer yet - its
    // storage is hidden until then.
    state: "ready" | "locked";
    can_receive: boolean;
    free_bytes: number | null;
}

export interface UsbMediaItem {
    object_id: string;
    name: string;
    size: number;
    kind: "image" | "video" | "document" | "other";
    modified: number;
    unique_id: string;
    imported: boolean;
}

export interface UsbTransfer {
    id: string;
    direction: "to_phone" | "from_phone";
    device_name: string;
    file_index: number;
    file_count: number;
    name: string;
    done_bytes: number;
    total_bytes: number;
    state: "running" | "done" | "failed" | "cancelled";
    error: string | null;
    paths: string[];
}

export interface UsbMediaScan {
    items: UsbMediaItem[];
    done: boolean;
    error: string | null;
}

// "media": the camera roll. "documents": PDFs, papers, slides, data and archives from Downloads,
// Documents, WhatsApp and Telegram.
export type UsbScanMode = "media" | "documents";
export type UsbImportTab = UsbScanMode | "browse";

export interface UsbBrowseEntry {
    object_id: string;
    name: string;
    is_folder: boolean;
    size: number;
    modified: number;
    kind: "folder" | "image" | "video" | "document" | "other";
    unique_id: string;
    imported: boolean;
}

export interface UsbStore {
    phones: UsbPhone[];
    // Scan results by scanKey(device, mode), filled in batches while the phone is read.
    media: Record<string, UsbMediaScan>;
    transfers: UsbTransfer[];
    // The import window, when open.
    importing: { device: string; tab: UsbImportTab } | null;
}

export const scanKey = (device: string, mode: UsbScanMode) => `${device}|${mode}`;

type Listener = (s: UsbStore) => void;

let state: UsbStore = { phones: [], media: {}, transfers: [], importing: null };
const listeners = new Set<Listener>();
let started = false;

const setState = (patch: Partial<UsbStore>) => {
    state = { ...state, ...patch };
    const snapshot = { ...state };
    listeners.forEach((l) => l(snapshot));
};

const importListeners = new Set<(transfer: UsbTransfer) => void>();
const importsAnnounced = new Set<string>();

const ensureStarted = () => {
    if (started) return;
    started = true;
    void invoke<UsbPhone[]>("usb_phones").then((phones) => setState({ phones }));
    void listen<UsbPhone[]>("usb-phones", (e) => setState({ phones: e.payload }));
    // A big phone sends a couple of hundred small batches. Applying each one would re-render the
    // whole grid every few milliseconds and leave clicks waiting, so they're merged and applied a
    // few times a second (and at once when the scan finishes).
    void listen<{ device_id: string; scan_id: string; mode: UsbScanMode; items: UsbMediaItem[]; done: boolean; error: string | null }>("usb-phone-media", (e) => {
        const key = scanKey(e.payload.device_id, e.payload.mode);
        // Only the latest scan of a list counts - a replaced one must not mix into it.
        if (currentScan.get(key) !== e.payload.scan_id) return;
        const pending = pendingBatches.get(key) ?? { items: [], done: false, error: null };
        pending.items.push(...e.payload.items);
        pending.done = e.payload.done;
        pending.error = e.payload.error;
        pendingBatches.set(key, pending);
        if (e.payload.done) flushBatches();
        else if (!flushTimer) flushTimer = window.setTimeout(flushBatches, 250);
    });
    void listen<UsbTransfer>("usb-transfer", (e) => {
        const i = state.transfers.findIndex((t) => t.id === e.payload.id);
        const transfers = [...state.transfers];
        if (i >= 0) transfers[i] = e.payload;
        else transfers.push(e.payload);
        setState({ transfers });
        // Freshly imported items show as imported without a rescan.
        if (e.payload.direction === "from_phone" && e.payload.state === "done") {
            markImported(e.payload.id);
            if (!importsAnnounced.has(e.payload.id)) {
                importsAnnounced.add(e.payload.id);
                importListeners.forEach((l) => l(e.payload));
            }
        }
    });
};

const pendingBatches = new Map<string, UsbMediaScan>();
let flushTimer = 0;
// The scan each list currently belongs to, and the items already in it (by the phone's unique id).
const currentScan = new Map<string, string>();
const seenItems = new Map<string, Set<string>>();

const flushBatches = () => {
    window.clearTimeout(flushTimer);
    flushTimer = 0;
    if (!pendingBatches.size) return;
    const media = { ...state.media };
    for (const [key, batch] of pendingBatches) {
        const prev = media[key] ?? { items: [], done: false, error: null };
        const seen = seenItems.get(key) ?? new Set<string>();
        seenItems.set(key, seen);
        const fresh = batch.items.filter((i) => !seen.has(i.unique_id) && (seen.add(i.unique_id), true));
        media[key] = { items: prev.items.concat(fresh), done: batch.done, error: batch.error };
    }
    pendingBatches.clear();
    // Low priority: rendering a grown list must never hold up a click.
    startTransition(() => setState({ media }));
};

// Import requests by transfer id, so finished ones can be ticked off in the grid.
const pendingImports = new Map<string, { device: string; uniqueIds: Set<string> }>();

const markImported = (transferId: string) => {
    const pending = pendingImports.get(transferId);
    if (!pending) return;
    pendingImports.delete(transferId);
    const media = { ...state.media };
    for (const mode of ["media", "documents"] as const) {
        const scan = media[scanKey(pending.device, mode)];
        if (scan) {
            media[scanKey(pending.device, mode)] = {
                ...scan,
                items: scan.items.map((it) => (pending.uniqueIds.has(it.unique_id) ? { ...it, imported: true } : it)),
            };
        }
    }
    setState({ media });
};

export const getUsbState = () => state;

// Every finished import from a phone, once each, with the paths it saved (the home screen lists them).
export const onUsbImported = (listener: (transfer: UsbTransfer) => void) => {
    ensureStarted();
    importListeners.add(listener);
    return () => {
        importListeners.delete(listener);
    };
};

export const subscribeUsb = (listener: Listener) => {
    ensureStarted();
    listeners.add(listener);
    listener({ ...state });
    return () => {
        listeners.delete(listener);
    };
};

// Starts (or restarts) reading one list from the phone. A newer scan replaces an older one, both
// here and in the worker.
export const scanUsbPhone = async (deviceId: string, mode: UsbScanMode) => {
    const key = scanKey(deviceId, mode);
    const scanId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    currentScan.set(key, scanId);
    seenItems.set(key, new Set());
    pendingBatches.delete(key);
    setState({ media: { ...state.media, [key]: { items: [], done: false, error: null } } });
    await invoke("usb_phone_scan", { deviceId, mode, scanId });
};

// Opens the import window on a tab; each scan runs once per window, on first view of its tab.
export const openUsbImport = (deviceId: string, tab: UsbImportTab = "media") => setState({ importing: { device: deviceId, tab } });

export const setUsbImportTab = (tab: UsbImportTab) => state.importing && setState({ importing: { ...state.importing, tab } });

export const browseUsb = (deviceId: string, folder: string | null) =>
    invoke<UsbBrowseEntry[]>("usb_phone_browse", { deviceId, folder });

export const closeUsbImport = () => setState({ importing: null });

// Photos: the phone's own preview. Videos (and photos a phone has no preview for): made by
// Briefcast from the file itself, then cached - so it needs to know what the item is.
export const usbThumbnail = (deviceId: string, item: Pick<UsbMediaItem, "object_id" | "kind" | "name" | "size" | "unique_id">) =>
    invoke<string | null>("usb_phone_thumbnail", {
        deviceId,
        objectId: item.object_id,
        kind: item.kind,
        name: item.name,
        size: item.size,
        uniqueId: item.unique_id,
    }).catch(() => null);

export const sendOverUsb = (deviceId: string, files: { path: string; name: string }[]) =>
    invoke<string>("usb_phone_send", { deviceId, files });

export const importOverUsb = async (
    deviceId: string,
    items: Pick<UsbMediaItem, "object_id" | "name" | "size" | "modified" | "unique_id">[]
) => {
    const id = await invoke<string>("usb_phone_import", {
        deviceId,
        items: items.map(({ object_id, name, size, modified, unique_id }) => ({ object_id, name, size, modified, unique_id })),
    });
    pendingImports.set(id, { device: deviceId, uniqueIds: new Set(items.map((i) => i.unique_id)) });
    return id;
};

export const cancelUsbTransfer = (transferId: string) => invoke("usb_transfer_cancel", { transferId });

export const dismissUsbTransfers = () => setState({ transfers: state.transfers.filter((t) => t.state === "running") });

// What a phone that's plugged in but "locked" needs from its owner.
export const usbUnlockHint = (phone: UsbPhone) =>
    phone.kind === "iphone"
        ? "Unlock your iPhone and tap Trust when it asks about this computer."
        : "Unlock your phone, then tap the USB notification and choose File transfer.";
