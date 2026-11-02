// components/UsbPhoneTray.tsx
//
// The "smart" half of USB transfer: plug a phone in and Briefcast says so, with the next step
// right there - import from it, send it files, or (when it's locked or charging-only) exactly
// what to tap on the phone. Sits in Dashboard's top-right stack next to the exports chip, and
// carries the progress of any USB transfer. See src-tauri/src/services/usb_phone.rs.
//
// A card can be minimized to a small chip (still showing transfer progress) and expanded again;
// which phones are minimized is remembered, so a phone someone keeps plugged in stays out of the way.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { IoAlertCircle, IoCheckmarkCircle, IoFolderOpenOutline, IoLockClosedOutline, IoRemove } from "react-icons/io5";
import { MdUsb } from "react-icons/md";
import {
    cancelUsbTransfer,
    dismissUsbTransfers,
    getUsbState,
    openUsbImport,
    sendOverUsb,
    subscribeUsb,
    usbUnlockHint,
    type UsbPhone,
    type UsbStore,
} from "../services/usbPhone";

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

// Picks files and sends them to an Android phone over the cable.
export const pickAndSendOverUsb = async (phone: UsbPhone) => {
    const picked = await open({ multiple: true, title: `Send to ${phone.name}` });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!paths.length) return;
    await sendOverUsb(
        phone.id,
        paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() ?? p }))
    );
};

const MINIMIZED_KEY = "briefcast-usb-minimized";

const loadMinimized = (): Set<string> => {
    try {
        return new Set(JSON.parse(localStorage.getItem(MINIMIZED_KEY) || "[]"));
    } catch {
        return new Set();
    }
};

const CARD = "rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-xl shadow-[0_8px_24px_rgba(0,0,0,0.18)] ring-1 ring-black/[0.06] dark:ring-white/[0.08]";

const UsbPhoneTray = () => {
    const [store, setStore] = useState<UsbStore>(getUsbState());
    const [minimized, setMinimized] = useState<Set<string>>(loadMinimized);
    useEffect(() => subscribeUsb(setStore), []);

    const setMin = (id: string, on: boolean) =>
        setMinimized((prev) => {
            const next = new Set(prev);
            if (on) next.add(id);
            else next.delete(id);
            try {
                localStorage.setItem(MINIMIZED_KEY, JSON.stringify([...next]));
            } catch {
                /* only a convenience */
            }
            return next;
        });

    // A phone whose import window is open doesn't need its card on top of that window.
    const phones = store.phones.filter((p) => store.importing?.device !== p.id);
    // A minimized phone's chip already shows its progress.
    const minimizedNames = new Set(store.phones.filter((p) => minimized.has(p.id)).map((p) => p.name));
    const transfers = store.transfers.filter((t) => !minimizedNames.has(t.device_name)).slice(-3);
    if (!phones.length && !transfers.length) return null;

    return (
        <div className="flex flex-col items-end gap-2">
            {phones.map((phone) => {
                const running = store.transfers.find((t) => t.state === "running" && t.device_name === phone.name);
                const pct = running?.total_bytes ? Math.floor((running.done_bytes / running.total_bytes) * 100) : null;
                if (minimized.has(phone.id)) {
                    return (
                        <button
                            key={phone.id}
                            type="button"
                            title={`${phone.name} - click to expand`}
                            onClick={() => setMin(phone.id, false)}
                            className={`${CARD} flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 text-[12px] font-medium text-neutral-700 dark:text-neutral-200 hover:bg-white dark:hover:bg-neutral-700`}
                        >
                            <MdUsb size={14} className={phone.state === "locked" ? "text-amber-500" : "text-emerald-500"} />
                            <span className="max-w-[120px] truncate">{phone.name}</span>
                            {pct !== null && <span className="text-blue-600 dark:text-blue-400">{pct}%</span>}
                        </button>
                    );
                }
                return (
                <div key={phone.id} className={`${CARD} w-[320px] px-3.5 py-3`}>
                    <div className="flex items-center gap-2">
                        <MdUsb className="text-neutral-500 dark:text-neutral-400 shrink-0" size={16} />
                        <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
                            {phone.name} connected
                        </span>
                        <button
                            type="button"
                            title="Minimize"
                            onClick={() => setMin(phone.id, true)}
                            className="shrink-0 rounded-full p-0.5 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
                        >
                            <IoRemove size={15} />
                        </button>
                    </div>
                    {phone.state === "locked" ? (
                        <div className="mt-1.5 flex gap-1.5 text-[12px] text-amber-700 dark:text-amber-300">
                            <IoLockClosedOutline className="shrink-0 mt-0.5" size={13} />
                            {usbUnlockHint(phone)}
                        </div>
                    ) : (
                        <>
                            <div className="mt-2 flex gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => openUsbImport(phone.id)}
                                    className="flex-1 px-2.5 py-1.5 rounded-lg text-[12px] font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-white"
                                >
                                    Import from phone
                                </button>
                                {phone.can_receive && (
                                    <button
                                        type="button"
                                        onClick={() => void pickAndSendOverUsb(phone)}
                                        className="flex-1 px-2.5 py-1.5 rounded-lg text-[12px] font-medium border border-neutral-200 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                                    >
                                        Send files…
                                    </button>
                                )}
                            </div>
                            {!phone.can_receive && (
                                <div className="mt-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                                    iPhones only share photos and videos over USB. For documents, or to send files to it, use Transfer to phone.
                                </div>
                            )}
                        </>
                    )}
                </div>
                );
            })}

            {transfers.length > 0 && (
                <div className={`${CARD} w-[320px] px-3.5 py-2`}>
                    {transfers.map((t) => {
                        const pct = t.total_bytes ? Math.min(100, (t.done_bytes / t.total_bytes) * 100) : 0;
                        const verb = t.direction === "to_phone" ? `to ${t.device_name}` : `from ${t.device_name}`;
                        return (
                            <div key={t.id} className="py-1.5">
                                <div className="flex items-center gap-2 text-[12px]">
                                    {t.state === "done" ? (
                                        <IoCheckmarkCircle className="text-emerald-500 shrink-0" size={14} />
                                    ) : t.state === "failed" ? (
                                        <IoAlertCircle className="text-red-500 shrink-0" size={14} />
                                    ) : null}
                                    <span className="flex-1 min-w-0 truncate text-neutral-700 dark:text-neutral-200">
                                        {t.state === "running"
                                            ? `${t.file_count > 1 ? `${t.file_index + 1}/${t.file_count} · ` : ""}${t.name}`
                                            : t.state === "done"
                                            ? `${t.file_count} file${t.file_count === 1 ? "" : "s"} ${t.direction === "to_phone" ? "sent" : "imported"} ${verb}`
                                            : t.state === "cancelled"
                                            ? "Cancelled"
                                            : t.error}
                                    </span>
                                    {t.state === "running" && (
                                        <button type="button" onClick={() => void cancelUsbTransfer(t.id)} className="text-neutral-500 hover:underline">
                                            Cancel
                                        </button>
                                    )}
                                    {t.state === "done" && t.paths[0] && (
                                        <button
                                            type="button"
                                            title="Show in folder"
                                            onClick={() => void invoke("open_file_from_directory", { filepath: t.paths[0] })}
                                            className="text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                                        >
                                            <IoFolderOpenOutline size={14} />
                                        </button>
                                    )}
                                </div>
                                {t.state === "running" && (
                                    <>
                                        <div className="mt-1 h-1 rounded-full bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
                                            <div className="h-full rounded-full bg-blue-500 transition-[width] duration-150" style={{ width: `${pct}%` }} />
                                        </div>
                                        <div className="mt-0.5 text-[10px] text-neutral-500 dark:text-neutral-400">
                                            {formatBytes(t.done_bytes)} of {formatBytes(t.total_bytes)} · USB {verb}
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}
                    {transfers.every((t) => t.state !== "running") && (
                        <button type="button" onClick={dismissUsbTransfers} className="mt-0.5 text-[11px] text-neutral-500 hover:underline">
                            Clear
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default UsbPhoneTray;
