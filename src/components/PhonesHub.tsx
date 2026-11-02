// components/PhonesHub.tsx
//
// The Phones panel: every phone paired with Briefcast in one place - connect a new one, see which
// are online, rename, remove, and send to any of them. Opened from the dock (openPhonesHub). It
// slides in over the right of the window and leaves the library sidebar usable, because each card
// is a drop target: drag a file from the sidebar or from Explorer onto a phone and it's sent (the
// same data-phone-drop targets the drag shelf uses - see PhoneShelf.tsx).
//
// Built to stay usable with a lot of phones: online first, search, and a clean-up for phones that
// haven't been seen in a month.

import { useEffect, useMemo, useRef, useState } from "react";
import {
    IoAdd,
    IoArrowBack,
    IoClose,
    IoCloudUploadOutline,
    IoLockClosed,
    IoLockOpenOutline,
    IoPencil,
    IoPhonePortraitOutline,
    IoSearch,
    IoTabletPortraitOutline,
    IoTimeOutline,
    IoTrashOutline,
} from "react-icons/io5";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
    closePhonesHub,
    forgetPhone,
    getPhoneTransferState,
    loadPhoneHistory,
    openPhonesHub,
    renamePhone,
    subscribePhoneTransfer,
    type PhoneDevice,
    type PhoneTransferStore,
} from "../services/phoneTransfer";
import { formatAgo, formatBytes, HistoryView, PairingPanel } from "./Modals/PhoneTransferModal";
import { dropOnPhone } from "./PhoneShelf";

const STALE_MS = 30 * 24 * 3600 * 1000;

const PhoneCard = ({ device, store, dropHover }: { device: PhoneDevice; store: PhoneTransferStore; dropHover: boolean }) => {
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState(device.name);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (renaming) inputRef.current?.select();
    }, [renaming]);
    const Icon = device.platform === "ipad" ? IoTabletPortraitOutline : IoPhonePortraitOutline;

    // What's moving right now, both ways.
    const outgoing = Object.values(store.transfers).filter((t) => t.device_id === device.id && (t.state === "sending" || t.state === "offered" || t.state === "queued"));
    const outTotal = outgoing.reduce((a, t) => a + t.size, 0);
    const outSent = outgoing.reduce((a, t) => a + t.sent, 0);
    const incoming = store.incoming.filter((f) => f.device_id === device.id && f.state === "receiving");
    const queued = outgoing.filter((t) => t.state === "queued").length;

    const commitRename = async () => {
        setRenaming(false);
        const next = name.trim();
        if (!next || next === device.name) {
            setName(device.name);
            return;
        }
        try {
            await renamePhone(device.id, next);
        } catch {
            setName(device.name);
        }
    };
    const pickAndSend = async () => {
        const picked = await openFileDialog({ multiple: true, title: `Send to ${device.name}` });
        const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
        if (paths.length) void dropOnPhone(device.id, paths);
    };

    return (
        <li
            data-phone-drop={device.id}
            className={`group rounded-2xl border p-3.5 transition-all duration-200 ${
                dropHover
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-500/10 scale-[1.02] shadow-lg"
                    : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900"
            }`}
        >
            <div className="flex items-center gap-3">
                <div className="relative shrink-0 w-11 h-11 rounded-xl bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-600 dark:text-neutral-300">
                    <Icon size={21} />
                    <span
                        className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-white dark:ring-neutral-900 ${
                            device.online ? "bg-green-500" : "bg-neutral-300 dark:bg-neutral-600"
                        }`}
                    />
                </div>
                <div className="flex-1 min-w-0">
                    {renaming ? (
                        <input
                            ref={inputRef}
                            value={name}
                            maxLength={40}
                            onChange={(e) => setName(e.target.value)}
                            onBlur={() => void commitRename()}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void commitRename();
                                if (e.key === "Escape") {
                                    // Cancels the rename only - not the panel's own Escape-to-close.
                                    e.stopPropagation();
                                    setName(device.name);
                                    setRenaming(false);
                                }
                            }}
                            className="w-full rounded-md border border-blue-400 bg-white dark:bg-neutral-950 px-2 py-0.5 text-[14px] font-medium text-neutral-900 dark:text-neutral-100 outline-none"
                            aria-label="Phone name"
                        />
                    ) : (
                        <button
                            type="button"
                            onClick={() => setRenaming(true)}
                            title="Rename"
                            className="flex items-center gap-1.5 max-w-full text-left text-[14px] font-semibold text-neutral-900 dark:text-neutral-100"
                        >
                            <span className="truncate">{device.name}</span>
                            <IoPencil size={11} className="shrink-0 text-neutral-400 opacity-0 group-hover:opacity-100" />
                        </button>
                    )}
                    <div className="text-[12px] text-neutral-500 dark:text-neutral-400 truncate">
                        {device.online ? (
                            device.secure ? (
                                <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
                                    <IoLockClosed size={11} /> Connected · encrypted
                                </span>
                            ) : (
                                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                                    <IoLockOpenOutline size={11} /> Connected · unencrypted
                                </span>
                            )
                        ) : (
                            `Last seen ${formatAgo(device.last_seen)}`
                        )}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => void pickAndSend()}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-white"
                >
                    <IoCloudUploadOutline size={14} /> Send
                </button>
                <button
                    type="button"
                    title="Remove this phone"
                    onClick={() => setConfirmRemove(true)}
                    className="shrink-0 p-1.5 rounded-md text-neutral-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                >
                    <IoTrashOutline size={15} />
                </button>
            </div>

            {(outgoing.length > 0 || incoming.length > 0) && (
                <div className="mt-3 space-y-1.5">
                    {outgoing.length > 0 && (
                        <div>
                            <div className="flex justify-between text-[11.5px] text-neutral-500 dark:text-neutral-400">
                                <span>
                                    {queued === outgoing.length
                                        ? `${queued} waiting for it to open Briefcast`
                                        : `Sending ${outgoing.length} file${outgoing.length > 1 ? "s" : ""}`}
                                </span>
                                <span className="tabular-nums">
                                    {formatBytes(outSent)} / {formatBytes(outTotal)}
                                </span>
                            </div>
                            <div className="mt-1 h-1 rounded-full bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
                                <div className="h-full rounded-full bg-blue-500 transition-[width] duration-150" style={{ width: `${outTotal ? (outSent / outTotal) * 100 : 0}%` }} />
                            </div>
                        </div>
                    )}
                    {incoming.length > 0 && (
                        <div className="text-[11.5px] text-neutral-500 dark:text-neutral-400">
                            Receiving {incoming.length} file{incoming.length > 1 ? "s" : ""} from it…
                        </div>
                    )}
                </div>
            )}

            {!device.online && outgoing.length === 0 && (
                <div className="mt-2 text-[11.5px] text-neutral-400 dark:text-neutral-500">
                    Reconnects by itself when Briefcast is opened on the phone — anything you send waits for it.
                </div>
            )}

            {confirmRemove && (
                <div className="mt-3 flex items-center gap-2 rounded-xl bg-red-50 dark:bg-red-500/10 p-2.5">
                    <div className="flex-1 text-[12px] text-red-800 dark:text-red-300">Remove {device.name}? It will need to scan the code again to reconnect.</div>
                    <button type="button" onClick={() => setConfirmRemove(false)} className="px-2.5 py-1 rounded-md text-[12px] text-neutral-600 dark:text-neutral-300 hover:bg-white/60 dark:hover:bg-white/5">
                        Keep
                    </button>
                    <button type="button" onClick={() => void forgetPhone(device.id)} className="px-2.5 py-1 rounded-md text-[12px] font-medium bg-red-600 text-white hover:bg-red-700">
                        Remove
                    </button>
                </div>
            )}
        </li>
    );
};

export default function PhonesHub({ store, dropHover }: { store: PhoneTransferStore; dropHover: string | null }) {
    const [query, setQuery] = useState("");
    const [view, setView] = useState<"phones" | "connect" | "history">("phones");
    const [confirmCleanup, setConfirmCleanup] = useState(false);
    const [, tick] = useState(0);
    // "Last seen 3 min ago" keeps itself current.
    useEffect(() => {
        const t = window.setInterval(() => tick((n) => n + 1), 30_000);
        return () => window.clearInterval(t);
    }, []);
    // A brand-new install with no phones opens straight on the code to scan.
    const empty = store.devices.length === 0;
    useEffect(() => {
        if (empty && view === "phones") setView("connect");
    }, [empty, view]);
    // A phone that finishes pairing while the code is up: back to the list, where it now is.
    const deviceCount = useRef(store.devices.length);
    useEffect(() => {
        if (store.devices.length > deviceCount.current && view === "connect") setView("phones");
        deviceCount.current = store.devices.length;
    }, [store.devices.length, view]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") closePhonesHub();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const online = store.devices.filter((d) => d.online).length;
    const phones = useMemo(() => {
        const q = query.trim().toLowerCase();
        return [...store.devices]
            .filter((d) => !q || d.name.toLowerCase().includes(q) || d.platform.includes(q))
            .sort((a, b) => Number(b.online) - Number(a.online) || b.last_seen - a.last_seen);
    }, [store.devices, query]);
    const stale = store.devices.filter((d) => !d.online && d.last_seen && Date.now() - d.last_seen > STALE_MS);

    return (
        <div className="fixed inset-y-0 right-0 z-[9990] w-[460px] max-w-full flex flex-col bg-neutral-50/95 dark:bg-neutral-950/95 backdrop-blur-xl shadow-[-18px_0_50px_rgba(0,0,0,0.18)] ring-1 ring-black/[0.06] dark:ring-white/[0.06] phones-hub-in">
            <div className="flex items-center gap-3 px-5 pt-5 pb-3">
                {view !== "phones" && !empty ? (
                    <button type="button" onClick={() => setView("phones")} title="Back" className="p-1.5 -ml-1.5 rounded-md text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800">
                        <IoArrowBack size={17} />
                    </button>
                ) : null}
                <div className="flex-1 min-w-0">
                    <div className="text-[17px] font-semibold text-neutral-900 dark:text-neutral-100">
                        {view === "connect" ? "Connect a phone" : view === "history" ? "History" : "Phones"}
                    </div>
                    {view === "phones" && (
                        <div className="text-[12.5px] text-neutral-500 dark:text-neutral-400">
                            {online} connected · {store.devices.length} paired · drop files on a phone to send
                        </div>
                    )}
                </div>
                {view === "phones" && (
                    <button
                        type="button"
                        onClick={() => {
                            setView("history");
                            void loadPhoneHistory();
                        }}
                        title="History"
                        className="p-1.5 rounded-md text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800"
                    >
                        <IoTimeOutline size={17} />
                    </button>
                )}
                <button type="button" onClick={closePhonesHub} title="Close" className="p-1.5 rounded-md text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800">
                    <IoClose size={18} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-6">
                {view === "connect" &&
                    (store.info ? (
                        <PairingPanel info={store.info} receiving fileCount={0} onBack={empty ? null : () => setView("phones")} />
                    ) : (
                        <div className="py-16 text-center text-[13px] text-neutral-500">{store.error || "Getting the code ready…"}</div>
                    ))}

                {view === "history" && <HistoryView history={store.history} />}

                {view === "phones" && (
                    <>
                        <div className="flex gap-2 mb-3">
                            {store.devices.length > 4 && (
                                <label className="flex-1 flex items-center gap-2 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3">
                                    <IoSearch size={14} className="text-neutral-400" />
                                    <input
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                        placeholder="Find a phone"
                                        className="flex-1 bg-transparent py-2 text-[13px] text-neutral-900 dark:text-neutral-100 outline-none"
                                    />
                                </label>
                            )}
                            <button
                                type="button"
                                onClick={() => setView("connect")}
                                className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-medium bg-blue-600 text-white hover:bg-blue-700 ${
                                    store.devices.length > 4 ? "" : "w-full"
                                }`}
                            >
                                <IoAdd size={16} /> Connect a phone
                            </button>
                        </div>
                        <ul className="space-y-2.5">
                            {phones.map((d) => (
                                <PhoneCard key={d.id} device={d} store={store} dropHover={dropHover === d.id} />
                            ))}
                        </ul>
                        {phones.length === 0 && query && <div className="py-10 text-center text-[13px] text-neutral-500">No phone called “{query}”.</div>}
                        {stale.length > 0 && !query && (
                            <div className="mt-5 rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 p-3 text-[12.5px] text-neutral-600 dark:text-neutral-300">
                                {confirmCleanup ? (
                                    <div className="flex items-center gap-2">
                                        <span className="flex-1">Remove {stale.length} phone{stale.length > 1 ? "s" : ""} not seen for a month?</span>
                                        <button type="button" onClick={() => setConfirmCleanup(false)} className="px-2.5 py-1 rounded-md hover:bg-neutral-200/60 dark:hover:bg-neutral-800">
                                            Keep
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setConfirmCleanup(false);
                                                stale.forEach((d) => void forgetPhone(d.id));
                                            }}
                                            className="px-2.5 py-1 rounded-md font-medium bg-red-600 text-white hover:bg-red-700"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                ) : (
                                    <button type="button" onClick={() => setConfirmCleanup(true)} className="w-full text-left">
                                        {stale.length} phone{stale.length > 1 ? "s haven't" : " hasn't"} been seen for a month — <span className="font-medium underline">clean up</span>
                                    </button>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

// Mounted once by Dashboard. Subscribes on its own, so transfer progress (several updates a second)
// re-renders this panel, never the whole app; `dropHover` - the phone under a drag - is all it's
// handed.
export function PhonesHubHost({ dropHover }: { dropHover: string | null }) {
    const [store, setStore] = useState<PhoneTransferStore>(getPhoneTransferState());
    useEffect(() => subscribePhoneTransfer(setStore), []);
    return store.hubOpen ? <PhonesHub store={store} dropHover={dropHover} /> : null;
}

// The dock's way in, with how many phones are connected right now.
export function PhonesDockButton({ className }: { className: string }) {
    const [store, setStore] = useState<PhoneTransferStore>(getPhoneTransferState());
    useEffect(() => subscribePhoneTransfer(setStore), []);
    const online = store.devices.filter((d) => d.online).length;
    return (
        <button
            type="button"
            className={`${className} relative`}
            onClick={() => (store.hubOpen ? closePhonesHub() : openPhonesHub())}
            title={online ? `Phones - ${online} connected` : "Phones"}
        >
            <IoPhonePortraitOutline />
            {online > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-green-500 text-white text-[9.5px] font-bold leading-[15px] text-center">
                    {online}
                </span>
            )}
        </button>
    );
}
