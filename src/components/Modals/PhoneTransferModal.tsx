// components/Modals/PhoneTransferModal.tsx
//
// "Transfer to phone". Two faces: the paired phones (pick one, it's sent) and the QR code that
// pairs a new one. A phone that scans the code while this is open gets the files immediately - the
// whole first-time flow is "scan", nothing else. See src/services/phoneTransfer.ts and
// src-tauri/src/services/phone_transfer.rs for how the files actually get there.
//
// Mounted once by Dashboard as <PhoneTransferHost />; every entry point opens it through
// openPhoneTransfer(files). The host also shows the "Allow this phone?" prompt, whether or not the
// dialog is open - a phone can only be trusted once someone at this computer approves it.
//
// Security model, as the user sees it: the QR is the encrypted address whenever this install has a
// certificate. The plain-HTTP code exists for networks where that can't work, but only behind an
// explicit, clearly labelled choice - never as a silent fallback.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    IoAdd,
    IoArrowBack,
    IoCheckmarkCircle,
    IoClose,
    IoCopyOutline,
    IoLockClosed,
    IoLockOpenOutline,
    IoPhonePortraitOutline,
    IoTabletPortraitOutline,
    IoTimeOutline,
    IoTrashOutline,
    IoWarning,
} from "react-icons/io5";
import {
    answerPairRequest,
    closePhoneTransfer,
    forgetPhone,
    getPhoneTransferState,
    loadPhoneHistory,
    onPhoneConnected,
    openPhonesHub,
    sendToPhone,
    startPhoneTransfer,
    subscribePhoneTransfer,
    type HistoryEntry,
    type PairRequest,
    type PhoneDevice,
    type PhoneTransferInfo,
    type PhoneTransferStore,
    type TransferFile,
    type TransferStatus,
} from "../../services/phoneTransfer";
import { MdUsb } from "react-icons/md";
import {
    getUsbState,
    openUsbImport,
    sendOverUsb,
    subscribeUsb,
    usbUnlockHint,
    type UsbStore,
} from "../../services/usbPhone";

export const formatBytes = (n: number) => {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n;
    let i = -1;
    do {
        v /= 1024;
        i++;
    } while (v >= 1024 && i < units.length - 1);
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
};

export const formatAgo = (ms: number) => {
    if (!ms) return "never";
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
};

// What one phone's row shows for the files in this dialog, rolled up from their offers.
interface RowProgress {
    state: "queued" | "sending" | "done" | "interrupted";
    sent: number;
    total: number;
}

const rollUp = (offers: TransferStatus[]): RowProgress | null => {
    if (!offers.length) return null;
    const total = offers.reduce((a, o) => a + o.size, 0);
    const sent = offers.reduce((a, o) => a + (o.state === "done" ? o.size : o.sent), 0);
    const state = offers.every((o) => o.state === "done")
        ? "done"
        : offers.some((o) => o.state === "interrupted")
        ? "interrupted"
        : offers.every((o) => o.state === "queued")
        ? "queued"
        : "sending";
    return { state, sent, total };
};

const StepList = ({ steps }: { steps: string[] }) => (
    <ol className="space-y-2.5 text-[13px] text-neutral-700 dark:text-neutral-300">
        {steps.map((text, i) => (
            <li key={i} className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[11px] font-semibold flex items-center justify-center">
                    {i + 1}
                </span>
                <span>{text}</span>
            </li>
        ))}
    </ol>
);

// The QR for pairing a phone: encrypted by default, plain HTTP only on request and labelled.
export const PairingPanel = ({
    info,
    receiving,
    fileCount,
    onBack,
}: {
    info: PhoneTransferInfo;
    receiving: boolean;
    fileCount: number;
    onBack: (() => void) | null;
}) => {
    const [addressIndex, setAddressIndex] = useState(0);
    const [plain, setPlain] = useState(false);
    const [copied, setCopied] = useState(false);

    const addresses = info.addresses;
    const active = addresses[Math.min(addressIndex, Math.max(addresses.length - 1, 0))];
    const secureReady = info.encryption.state === "ready" && !!active?.secure_qr;
    const showingPlain = plain || !secureReady;
    const qr = active ? (showingPlain ? (plain ? active.plain_qr : null) : active.secure_qr) : null;
    const url = active ? (showingPlain ? (plain ? active.plain_url : null) : active.secure_url) : null;

    const handleCopy = async () => {
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch {
            /* the address is on screen to type anyway */
        }
    };

    const steps = [
        "Put your phone on the same network as this computer.",
        "Scan the code with your phone's camera and open the link.",
        "Approve the phone here when Briefcast asks - check the code matches on both screens.",
        receiving
            ? "Tap Send to computer on the phone and pick your photos, videos or files."
            : fileCount === 1
            ? "The file starts downloading straight away."
            : "The files start downloading straight away.",
    ];

    return (
        <div>
            {onBack && (
                <button
                    type="button"
                    onClick={onBack}
                    className="mb-3 flex items-center gap-1.5 text-[13px] text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white"
                >
                    <IoArrowBack size={14} /> Back to your phones
                </button>
            )}

            {plain && (
                <div className="mb-4 flex gap-2.5 p-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 text-[13px] leading-relaxed">
                    <IoLockOpenOutline className="shrink-0 mt-0.5" size={16} />
                    <span>
                        <strong className="font-semibold">Unencrypted connection.</strong> Anyone on this network could see the files you
                        send or receive. Use it only on a network you trust.
                        {secureReady && (
                            <button type="button" onClick={() => setPlain(false)} className="ml-1 underline font-medium">
                                Back to encrypted
                            </button>
                        )}
                    </span>
                </div>
            )}

            <div className="flex gap-6">
                <div className="shrink-0">
                    {qr ? (
                        <div
                            className={`w-[212px] h-[212px] p-2 rounded-xl bg-white ring-2 [&>svg]:w-full [&>svg]:h-full ${
                                plain ? "ring-amber-400" : "ring-green-500/70"
                            }`}
                            dangerouslySetInnerHTML={{ __html: qr }}
                        />
                    ) : (
                        <div className="w-[212px] h-[212px] p-4 rounded-xl bg-neutral-100 dark:bg-neutral-800 flex flex-col items-center justify-center text-center gap-2">
                            {info.encryption.state === "pending" ? (
                                <>
                                    <span className="w-6 h-6 rounded-full border-2 border-neutral-400 border-t-transparent animate-spin" />
                                    <span className="text-[12px] text-neutral-600 dark:text-neutral-300">
                                        Setting up encryption for this computer… (first time only)
                                    </span>
                                </>
                            ) : (
                                <>
                                    <IoWarning className="text-amber-500" size={22} />
                                    <span className="text-[12px] text-neutral-600 dark:text-neutral-300">
                                        {info.encryption.state === "unavailable"
                                            ? info.encryption.reason
                                            : "This network address can't be encrypted."}
                                    </span>
                                </>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex-1 min-w-0">
                    <StepList steps={steps} />

                    {!plain && secureReady && (
                        <p className="mt-3 flex items-center gap-1.5 text-[12px] text-green-700 dark:text-green-400">
                            <IoLockClosed size={12} /> Encrypted from the first byte. The phone checks this computer's certificate.
                        </p>
                    )}

                    {url && (
                        <div className="mt-3 flex items-center gap-2">
                            <code className="flex-1 min-w-0 truncate px-3 py-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-[12px] text-neutral-800 dark:text-neutral-200">
                                {url.split("#")[0]}
                            </code>
                            <button
                                type="button"
                                onClick={handleCopy}
                                title="Copy pairing link"
                                className="shrink-0 px-2.5 py-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                            >
                                {copied ? <IoCheckmarkCircle className="text-green-500" size={16} /> : <IoCopyOutline size={16} />}
                            </button>
                        </div>
                    )}

                    {addresses.length > 1 && (
                        <div className="mt-2.5">
                            <div className="text-[12px] text-neutral-500 dark:text-neutral-400">
                                Phone not connecting? This computer has more than one network address &mdash; try another:
                            </div>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {addresses.map((a, i) => (
                                    <button
                                        key={a.host}
                                        type="button"
                                        onClick={() => setAddressIndex(i)}
                                        className={`px-2 py-1 rounded-md text-[12px] font-medium border ${
                                            i === addressIndex
                                                ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 border-transparent"
                                                : "bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                                        }`}
                                    >
                                        {a.host}
                                        {i === 0 ? " (auto)" : ""}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {!plain && (
                        <div className="mt-4 pt-3 border-t border-neutral-100 dark:border-neutral-800">
                            <div className="text-[12px] text-neutral-500 dark:text-neutral-400">
                                {secureReady ? "Phone can't open the page?" : "Need to connect anyway?"}
                            </div>
                            <button
                                type="button"
                                onClick={() => setPlain(true)}
                                className="mt-1.5 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium border border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-500/10"
                            >
                                <IoLockOpenOutline size={13} /> Use an unencrypted connection…
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// Phones on a USB cable, above everything else: when one is plugged in it's the fastest, most
// private way there is, so it's offered first.
const UsbSection = ({ files, receiving }: { files: TransferFile[]; receiving: boolean }) => {
    const [usb, setUsb] = useState<UsbStore>(getUsbState());
    const [sent, setSent] = useState<Record<string, string>>({});
    const [error, setError] = useState("");
    useEffect(() => subscribeUsb(setUsb), []);
    if (!usb.phones.length) return null;

    return (
        <div className="mb-5">
            <div className="text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-2">Connected by USB cable</div>
            {error && <div className="mb-2 text-[12px] text-red-600 dark:text-red-400">{error}</div>}
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 rounded-xl ring-1 ring-neutral-200 dark:ring-neutral-800">
                {usb.phones.map((phone) => {
                    const transfer = sent[phone.id] ? usb.transfers.find((t) => t.id === sent[phone.id]) : undefined;
                    const pct = transfer?.total_bytes ? Math.min(100, (transfer.done_bytes / transfer.total_bytes) * 100) : 0;
                    let action: ReactNode;
                    if (phone.state === "locked") {
                        action = <span className="text-[12px] text-amber-700 dark:text-amber-300 max-w-[220px] text-right">{usbUnlockHint(phone)}</span>;
                    } else if (receiving) {
                        action = (
                            <button
                                type="button"
                                onClick={() => {
                                    closePhoneTransfer();
                                    openUsbImport(phone.id);
                                }}
                                className="shrink-0 px-3.5 py-1.5 rounded-lg text-[13px] font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-white"
                            >
                                Import from phone
                            </button>
                        );
                    } else if (!phone.can_receive) {
                        action = <span className="text-[12px] text-neutral-500 dark:text-neutral-400 max-w-[220px] text-right">iPhones don't accept files over USB - use Wi-Fi below.</span>;
                    } else if (transfer?.state === "running") {
                        action = (
                            <div className="w-[150px]">
                                <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-1">{Math.floor(pct)}%</div>
                                <div className="h-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                                    <div className="h-full rounded-full bg-blue-500 transition-[width] duration-150" style={{ width: `${pct}%` }} />
                                </div>
                            </div>
                        );
                    } else if (transfer?.state === "done") {
                        action = (
                            <span className="flex items-center gap-1 text-[13px] font-medium text-green-600 dark:text-green-400">
                                <IoCheckmarkCircle size={16} /> Sent
                            </span>
                        );
                    } else {
                        action = (
                            <div className="flex items-center gap-2">
                                {transfer?.state === "failed" && (
                                    <span className="text-[12px] text-red-600 dark:text-red-400 max-w-[180px] truncate" title={transfer.error ?? ""}>
                                        {transfer.error}
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => {
                                        setError("");
                                        sendOverUsb(phone.id, files)
                                            .then((id) => setSent((prev) => ({ ...prev, [phone.id]: id })))
                                            .catch((e) => setError(String(e)));
                                    }}
                                    className="shrink-0 px-3.5 py-1.5 rounded-lg text-[13px] font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-white"
                                >
                                    {transfer ? "Send again" : "Send"}
                                </button>
                            </div>
                        );
                    }
                    return (
                        <li key={phone.id} className="flex items-center gap-3 px-3.5 py-3">
                            <div className="shrink-0 w-9 h-9 rounded-lg bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-600 dark:text-neutral-300">
                                <MdUsb size={18} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="text-[14px] font-medium text-neutral-900 dark:text-neutral-100 truncate">{phone.name}</div>
                                <div className="text-[12px] text-neutral-500 dark:text-neutral-400 truncate">
                                    USB cable · fastest, nothing leaves the cable
                                </div>
                            </div>
                            {action}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
};

const HISTORY_TEXT: Record<HistoryEntry["kind"], string> = {
    sent: "Sent",
    received: "Received",
    receive_failed: "Failed to receive",
    paired: "Paired",
    pair_denied: "Refused",
    removed: "Removed",
};

// The local record of pairings and transfers (phone_transfer_history.jsonl).
export const HistoryView = ({ history }: { history: HistoryEntry[] | null }) => {
    useEffect(() => {
        void loadPhoneHistory();
    }, []);
    if (!history) return <div className="h-40 rounded-xl bg-neutral-100 dark:bg-neutral-800 animate-pulse" />;
    if (!history.length) {
        return <div className="py-10 text-center text-[13px] text-neutral-500 dark:text-neutral-400">Nothing yet.</div>;
    }
    return (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 rounded-xl ring-1 ring-neutral-200 dark:ring-neutral-800">
            {history.map((h, i) => {
                const transfer = h.kind === "sent" || h.kind === "received" || h.kind === "receive_failed";
                const bad = h.kind === "receive_failed" || h.kind === "pair_denied";
                return (
                    <li key={`${h.at}-${i}`} className="flex items-start gap-3 px-3.5 py-2.5">
                        <span className={`mt-0.5 shrink-0 ${h.secure ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
                            {h.secure ? <IoLockClosed size={13} title="Encrypted" /> : <IoLockOpenOutline size={13} title="Unencrypted" />}
                        </span>
                        <div className="flex-1 min-w-0 text-[13px]">
                            <div className={`truncate ${bad ? "text-red-600 dark:text-red-400" : "text-neutral-800 dark:text-neutral-100"}`}>
                                {HISTORY_TEXT[h.kind]} {transfer ? <strong className="font-medium">{h.name}</strong> : null}
                                {transfer ? (h.kind === "sent" ? " to " : " from ") : " "}
                                {h.device}
                            </div>
                            <div className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
                                {new Date(h.at).toLocaleString()}
                                {h.size ? ` · ${formatBytes(h.size)}` : ""}
                                {h.detail ? ` · ${h.detail}` : ""}
                            </div>
                        </div>
                    </li>
                );
            })}
        </ul>
    );
};

// "Allow this phone?" - the second half of pairing. Shown above everything, dialog open or not.
const PairRequestPrompt = ({ request }: { request: PairRequest }) => (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="w-[380px] max-w-[calc(100vw-32px)] rounded-2xl bg-white dark:bg-neutral-900 shadow-[0_16px_48px_rgba(0,0,0,0.25)] ring-1 ring-black/[0.06] dark:ring-white/[0.08] p-5">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
                <IoPhonePortraitOutline size={18} className="text-neutral-500" />
                Allow “{request.name}” to connect?
            </div>
            <div className="mt-4 text-center font-mono text-[40px] font-bold tracking-[0.18em] text-neutral-900 dark:text-neutral-100">
                {request.code}
            </div>
            <p className="mt-2 text-[13px] text-neutral-600 dark:text-neutral-300 text-center">
                Only allow it if the phone shows this same code. Once allowed, it can send files to this computer and receive the ones you
                send it.
            </p>
            {!request.secure && (
                <div className="mt-3 flex gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 text-[12px]">
                    <IoLockOpenOutline className="shrink-0 mt-0.5" size={14} />
                    This phone is using the unencrypted connection.
                </div>
            )}
            <div className="mt-5 flex gap-2">
                <button
                    type="button"
                    onClick={() => void answerPairRequest(request.id, false)}
                    className="flex-1 py-2 rounded-lg text-[13px] font-medium border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                    Don't allow
                </button>
                <button
                    type="button"
                    onClick={() => void answerPairRequest(request.id, true)}
                    className="flex-1 py-2 rounded-lg text-[13px] font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-white"
                >
                    Allow
                </button>
            </div>
        </div>
    </div>
);

const PhoneTransferModal = ({ files, store }: { files: TransferFile[]; store: PhoneTransferStore }) => {
    // Offer ids sent from this dialog, per phone - the dialog only reports on its own files.
    const [sent, setSent] = useState<Record<string, string[]>>({});
    const [pairing, setPairing] = useState(false);
    const [view, setView] = useState<"main" | "history">("main");
    const [busy, setBusy] = useState<string | null>(null);
    // When each phone's bytes first started moving, for the speed readout.
    const startedAt = useRef<Record<string, { time: number; bytes: number }>>({});
    const [, tick] = useState(0);

    const { info, devices, transfers, error } = store;
    // Opened from "Get files from phone": nothing to send, the phone does the sending.
    const receiving = files.length === 0;
    const showPairing = pairing || (info !== null && devices.length === 0);

    const send = async (device: PhoneDevice) => {
        setBusy(device.id);
        try {
            const statuses = await sendToPhone(device.id, files);
            setSent((prev) => ({ ...prev, [device.id]: statuses.map((s) => s.offer_id) }));
            delete startedAt.current[device.id];
        } catch {
            /* surfaced through store.error */
        } finally {
            setBusy(null);
        }
    };

    // The first-time flow: a phone that connects while the code is on screen gets the files.
    const sendRef = useRef(send);
    sendRef.current = send;
    const sentRef = useRef(sent);
    sentRef.current = sent;
    const receivingRef = useRef(receiving);
    receivingRef.current = receiving;
    const showPairingRef = useRef(showPairing);
    showPairingRef.current = showPairing;
    useEffect(
        () =>
            onPhoneConnected((device) => {
                if (!showPairingRef.current || sentRef.current[device.id]) return;
                setPairing(false);
                if (!receivingRef.current) void sendRef.current(device);
            }),
        []
    );

    // Keeps "x min ago" and the speed readout current while the dialog is open.
    useEffect(() => {
        const id = window.setInterval(() => tick((n) => n + 1), 1000);
        return () => window.clearInterval(id);
    }, []);

    // The QR's pairing key expires; fetch a fresh code just after it does.
    useEffect(() => {
        if (!info) return;
        const id = window.setTimeout(() => void startPhoneTransfer().catch(() => {}), info.expires_in_secs * 1000 + 500);
        return () => window.clearTimeout(id);
    }, [info]);

    const title = receiving
        ? "Photos, videos and files you send land in the “From phone” folder"
        : files.length === 1
        ? files[0].name
        : `${files.length} files`;

    const renderStatus = (device: PhoneDevice) => {
        if (receiving) return null;
        const ids = sent[device.id];
        const progress = ids ? rollUp(ids.map((id) => transfers[id]).filter(Boolean)) : null;
        const sendButton = (label: string, primary: boolean) => (
            <button
                type="button"
                disabled={busy === device.id}
                onClick={() => void send(device)}
                className={`shrink-0 px-3.5 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-50 ${
                    primary
                        ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-white"
                        : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                }`}
            >
                {label}
            </button>
        );

        if (!progress) return sendButton("Send", true);
        if (progress.state === "done") {
            return (
                <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1 text-[13px] font-medium text-green-600 dark:text-green-400">
                        <IoCheckmarkCircle size={16} /> Sent
                    </span>
                    {sendButton("Send again", false)}
                </div>
            );
        }
        if (progress.state === "interrupted") {
            return (
                <div className="flex items-center gap-2">
                    <span className="text-[12px] text-amber-600 dark:text-amber-400">Stopped on the phone</span>
                    {sendButton("Retry", false)}
                </div>
            );
        }
        if (progress.state === "queued") {
            return <span className="text-[12px] text-neutral-500 dark:text-neutral-400">Waiting for the phone…</span>;
        }

        const pct = progress.total ? Math.min(100, (progress.sent / progress.total) * 100) : 0;
        const start = startedAt.current[device.id];
        if (!start && progress.sent > 0) startedAt.current[device.id] = { time: Date.now(), bytes: progress.sent };
        const elapsed = start ? (Date.now() - start.time) / 1000 : 0;
        const speed = start && elapsed > 0.5 ? (progress.sent - start.bytes) / elapsed : 0;
        return (
            <div className="w-[150px]">
                <div className="flex justify-between text-[11px] text-neutral-500 dark:text-neutral-400 mb-1">
                    <span>{progress.sent ? `${Math.floor(pct)}%` : "Starting…"}</span>
                    {speed > 0 && <span>{formatBytes(speed)}/s</span>}
                </div>
                <div className="h-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                    <div className="h-full rounded-full bg-blue-500 transition-[width] duration-150" style={{ width: `${pct}%` }} />
                </div>
            </div>
        );
    };

    return (
        <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/30 backdrop-blur-sm"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) closePhoneTransfer();
            }}
        >
            <div className="w-[600px] max-w-[calc(100vw-32px)] max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-neutral-900 shadow-[0_16px_48px_rgba(0,0,0,0.2)] ring-1 ring-black/[0.06] dark:ring-white/[0.08] overflow-hidden">
                <div className="flex items-center gap-2.5 px-5 py-4 border-b border-neutral-200 dark:border-neutral-800">
                    <IoPhonePortraitOutline className="text-neutral-500 dark:text-neutral-400 shrink-0" size={18} />
                    <div className="min-w-0">
                        <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">{receiving ? "Get files from your phone" : "Transfer to phone"}</h2>
                        <div className="text-[12px] text-neutral-500 dark:text-neutral-400 truncate">
                            {title}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setView(view === "history" ? "main" : "history")}
                        className={`ml-auto flex items-center gap-1 px-2 py-1.5 rounded-lg text-[12px] font-medium ${
                            view === "history"
                                ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900"
                                : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        }`}
                        title="Transfer history"
                    >
                        <IoTimeOutline size={14} /> History
                    </button>
                    <button
                        type="button"
                        onClick={closePhoneTransfer}
                        className="p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        title="Close"
                    >
                        <IoClose size={18} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-5">
                    {error && (
                        <div className="mb-4 flex gap-2.5 p-3 rounded-lg bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 text-[13px] leading-relaxed">
                            <IoWarning className="shrink-0 mt-0.5" size={16} />
                            <span>{error}</span>
                        </div>
                    )}

                    {view === "main" && <UsbSection files={files} receiving={receiving} />}

                    {!info && !error ? (
                        <div className="h-[212px] rounded-xl bg-neutral-100 dark:bg-neutral-800 animate-pulse" />
                    ) : view === "history" ? (
                        <HistoryView history={store.history} />
                    ) : showPairing && info ? (
                        <PairingPanel
                            info={info}
                            receiving={receiving}
                            fileCount={files.length}
                            onBack={devices.length > 0 ? () => setPairing(false) : null}
                        />
                    ) : (
                        <div>
                            <div className="text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-2">Your phones</div>
                            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 rounded-xl ring-1 ring-neutral-200 dark:ring-neutral-800">
                                {devices.map((device) => {
                                    const Icon = device.platform === "ipad" ? IoTabletPortraitOutline : IoPhonePortraitOutline;
                                    return (
                                        <li key={device.id} className="group flex items-center gap-3 px-3.5 py-3">
                                            <div className="relative shrink-0 w-9 h-9 rounded-lg bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-600 dark:text-neutral-300">
                                                <Icon size={18} />
                                                <span
                                                    className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white dark:ring-neutral-900 ${
                                                        device.online ? "bg-green-500" : "bg-neutral-300 dark:bg-neutral-600"
                                                    }`}
                                                />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-[14px] font-medium text-neutral-900 dark:text-neutral-100 truncate">{device.name}</div>
                                                <div className="text-[12px] text-neutral-500 dark:text-neutral-400 truncate">
                                                    {device.online ? (
                                                        <span className="inline-flex items-center gap-1">
                                                            {device.secure ? (
                                                                <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
                                                                    <IoLockClosed size={11} /> Encrypted
                                                                </span>
                                                            ) : (
                                                                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                                                                    <IoLockOpenOutline size={11} /> Unencrypted
                                                                </span>
                                                            )}
                                                            {receiving ? " · tap Send to computer on the phone" : " · connected"}
                                                        </span>
                                                    ) : receiving
                                                        ? `Not open right now · seen ${formatAgo(device.last_seen)} — open its Briefcast page`
                                                        : `Not open right now · seen ${formatAgo(device.last_seen)} — files wait until it is`}
                                                </div>
                                            </div>
                                            {renderStatus(device)}
                                            <button
                                                type="button"
                                                title="Forget this phone"
                                                onClick={() => void forgetPhone(device.id)}
                                                className="shrink-0 p-1.5 rounded-md text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                                            >
                                                <IoTrashOutline size={14} />
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                            <button
                                type="button"
                                onClick={() => setPairing(true)}
                                className="mt-3 flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                            >
                                <IoAdd size={16} /> Connect another phone
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    closePhoneTransfer();
                                    openPhonesHub();
                                }}
                                className="mt-3 ml-1 px-3 py-2 rounded-lg text-[13px] text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                            >
                                Manage phones
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// Mounted once (Dashboard). Renders the dialog whenever openPhoneTransfer() has asked for it; the
// key resets the dialog's own per-request state for each new set of files.
export const PhoneTransferHost = () => {
    const [store, setStore] = useState<PhoneTransferStore>(getPhoneTransferState());
    useEffect(() => subscribePhoneTransfer(setStore), []);
    useEffect(() => {
        if (!store.request) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") closePhoneTransfer();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [store.request]);
    return (
        <>
            {store.request && (
                <PhoneTransferModal key={store.request.map((f) => f.path).join("\n")} files={store.request} store={store} />
            )}
            {store.pairRequests[0] && <PairRequestPrompt key={store.pairRequests[0].id} request={store.pairRequests[0]} />}
        </>
    );
};

export default PhoneTransferModal;
