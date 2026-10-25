// components/PhoneIncomingTray.tsx
//
// Files arriving from a phone (its Briefcast page's "Send to computer" - see
// src-tauri/src/services/phone_transfer.rs receive_upload). Sits in Dashboard's top-right stack
// beside the exports chip, because a phone can send at any time, with no dialog open.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IoAlertCircle, IoCheckmarkCircle, IoClose, IoFolderOpenOutline, IoPhonePortraitOutline } from "react-icons/io5";
import { dismissIncoming, getPhoneTransferState, initPhoneTransfer, subscribePhoneTransfer, type IncomingStatus } from "../services/phoneTransfer";

const formatBytes = (n: number) => {
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

interface Props {
    onOpen: (path: string, name: string) => void;
}

const PhoneIncomingTray = ({ onOpen }: Props) => {
    const [incoming, setIncoming] = useState<IncomingStatus[]>(getPhoneTransferState().incoming);
    // When each file's first byte arrived, for the speed readout.
    const started = useRef<Record<string, number>>({});

    useEffect(() => {
        initPhoneTransfer();
        return subscribePhoneTransfer((s) => setIncoming(s.incoming));
    }, []);

    // Once everything has landed, tidy itself away after a while - but never while a file is still
    // arriving, and never a failure the user hasn't seen.
    const active = incoming.some((x) => x.state === "receiving");
    const failed = incoming.some((x) => x.state === "failed");
    useEffect(() => {
        if (!incoming.length || active || failed) return;
        const id = window.setTimeout(dismissIncoming, 15000);
        return () => window.clearTimeout(id);
    }, [incoming, active, failed]);

    if (!incoming.length) return null;

    const from = incoming[incoming.length - 1].device_name;
    const shown = incoming.slice(-5).reverse();

    return (
        <div className="w-[320px] rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-xl shadow-[0_8px_24px_rgba(0,0,0,0.18)] ring-1 ring-black/[0.06] dark:ring-white/[0.08] overflow-hidden">
            <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-neutral-100 dark:border-neutral-700/70">
                <IoPhonePortraitOutline className="text-neutral-500 dark:text-neutral-400 shrink-0" size={15} />
                <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
                    {active ? `Receiving from ${from}` : `From ${from}`}
                </span>
                <button
                    type="button"
                    title="Dismiss"
                    onClick={dismissIncoming}
                    className="shrink-0 rounded-full p-0.5 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
                >
                    <IoClose size={15} />
                </button>
            </div>
            <ul className="py-1">
                {shown.map((item) => {
                    let detail: ReactNode;
                    if (item.state === "receiving") {
                        if (item.received > 0 && !started.current[item.id]) started.current[item.id] = Date.now();
                        const secs = started.current[item.id] ? (Date.now() - started.current[item.id]) / 1000 : 0;
                        const speed = secs > 0.5 ? item.received / secs : 0;
                        const pct = item.size ? Math.min(100, (item.received / item.size) * 100) : 0;
                        detail = (
                            <div className="mt-1">
                                <div className="flex justify-between text-[11px] text-neutral-500 dark:text-neutral-400">
                                    <span>
                                        {formatBytes(item.received)}
                                        {item.size ? ` of ${formatBytes(item.size)}` : ""}
                                    </span>
                                    {speed > 0 && <span>{formatBytes(speed)}/s</span>}
                                </div>
                                <div className="mt-1 h-1 rounded-full bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
                                    <div className="h-full rounded-full bg-blue-500 transition-[width] duration-150" style={{ width: `${pct}%` }} />
                                </div>
                            </div>
                        );
                    } else if (item.state === "failed") {
                        detail = <div className="text-[11px] text-red-600 dark:text-red-400 line-clamp-2">{item.error || "Didn't arrive"}</div>;
                    } else {
                        detail = (
                            <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                                {formatBytes(item.size)} · {item.target === "timeline" ? "sent for the timeline · " : ""}in “From phone”
                            </div>
                        );
                    }
                    const done = item.state === "done" && item.path;
                    return (
                        <li key={item.id} className="group flex items-start gap-2.5 px-3.5 py-2">
                            {item.state === "done" ? (
                                <IoCheckmarkCircle className="text-emerald-500 shrink-0 mt-0.5" size={16} />
                            ) : item.state === "failed" ? (
                                <IoAlertCircle className="text-red-500 shrink-0 mt-0.5" size={16} />
                            ) : (
                                <span className="shrink-0 mt-1 w-3.5 h-3.5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                            )}
                            <div className="flex-1 min-w-0">
                                {done ? (
                                    <button
                                        type="button"
                                        title="Open"
                                        onClick={() => onOpen(item.path!, item.name)}
                                        className="block max-w-full truncate text-left text-[13px] text-neutral-800 dark:text-neutral-100 hover:text-blue-600 dark:hover:text-blue-400"
                                    >
                                        {item.name}
                                    </button>
                                ) : (
                                    <div className="truncate text-[13px] text-neutral-800 dark:text-neutral-100">{item.name}</div>
                                )}
                                {detail}
                            </div>
                            {done && (
                                <button
                                    type="button"
                                    title="Show in folder"
                                    onClick={() => void invoke("open_file_from_directory", { filepath: item.path })}
                                    className="shrink-0 p-1 rounded-md text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-black/5 dark:hover:bg-white/10"
                                >
                                    <IoFolderOpenOutline size={14} />
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>
            {incoming.length > shown.length && (
                <div className="px-3.5 pb-2 text-[11px] text-neutral-400 dark:text-neutral-500">
                    +{incoming.length - shown.length} more in “From phone”
                </div>
            )}
        </div>
    );
};

export default PhoneIncomingTray;
