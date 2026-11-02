// components/PhoneShelf.tsx
//
// The phone shelf: drag any file anywhere in Briefcast - from the library sidebar or straight out of
// Explorer - and your paired phones slide in at the window's right edge, ready to catch it. Drop on
// one and it goes there: a progress ring runs round that phone while the file travels, then the
// cast arcs (Briefcast's mark) radiate and the shelf tucks itself away.
//
// Dashboard owns the drag itself (both kinds already flow through it) and tells this where the
// pointer is; any element carrying data-phone-drop="<device id>" is a target - these pills, and
// the Phones panel's cards (PhonesHub.tsx). Dashboard calls dropOnPhone() when one is hit.

import { useEffect, useMemo, useState } from "react";
import { IoCheckmark, IoPhonePortraitOutline, IoTabletPortraitOutline, IoTimeOutline } from "react-icons/io5";
import {
    getPhoneTransferState,
    refreshPhoneDevices,
    sendPathsToPhone,
    subscribePhoneTransfer,
    type PhoneTransferStore,
} from "../services/phoneTransfer";

// Drops still on their way, by phone - kept here rather than in the drag, which is over long
// before a big video arrives.
interface Flight {
    offers: string[];
    count: number;
    startedAt: number;
}
let flights: Record<string, Flight> = {};
const flightListeners = new Set<() => void>();
const setFlights = (next: Record<string, Flight>) => {
    flights = next;
    flightListeners.forEach((l) => l());
};

// The id of the phone under (x, y), if any - a shelf pill or a Phones panel card.
export const phoneDropAt = (x: number, y: number): string | null =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-phone-drop]")?.dataset.phoneDrop ?? null;

export const phonesPaired = () => getPhoneTransferState().devices.length > 0;

// Sends `paths` to a phone and follows the transfer on its pill.
export const dropOnPhone = async (deviceId: string, paths: string[]) => {
    if (!paths.length) return;
    setFlights({ ...flights, [deviceId]: { offers: [], count: paths.length, startedAt: Date.now() } });
    try {
        const statuses = await sendPathsToPhone(deviceId, paths);
        setFlights({ ...flights, [deviceId]: { ...flights[deviceId], offers: statuses.map((s) => s.offer_id) } });
    } catch {
        const { [deviceId]: _gone, ...rest } = flights;
        setFlights(rest);
    }
};

const RING = 2 * Math.PI * 25;

export default function PhoneShelf({ dragging, point }: { dragging: boolean; point: { x: number; y: number } | null }) {
    const [store, setStore] = useState<PhoneTransferStore>(getPhoneTransferState());
    const [, bump] = useState(0);
    useEffect(() => subscribePhoneTransfer(setStore), []);
    useEffect(() => {
        void refreshPhoneDevices();
        const l = () => bump((n) => n + 1);
        flightListeners.add(l);
        return () => {
            flightListeners.delete(l);
        };
    }, []);

    const hovered = dragging && point ? phoneDropAt(point.x, point.y) : null;

    // Where each drop has got to: 0..1, done, or waiting for a phone that isn't open.
    const progress = useMemo(() => {
        const out: Record<string, { fraction: number; done: boolean; queued: boolean }> = {};
        for (const [id, f] of Object.entries(flights)) {
            const offers = f.offers.map((o) => store.transfers[o]).filter(Boolean);
            const total = offers.reduce((a, o) => a + o.size, 0);
            const sent = offers.reduce((a, o) => a + (o.state === "done" ? o.size : o.sent), 0);
            out[id] = {
                fraction: total ? sent / total : 0,
                done: offers.length > 0 && offers.length === f.offers.length && offers.every((o) => o.state === "done"),
                queued: offers.length > 0 && offers.every((o) => o.state === "queued"),
            };
        }
        return out;
    }, [store.transfers, flights]);

    // A finished (or queued) drop lingers a beat for its ✓, then leaves the shelf.
    useEffect(() => {
        const timers = Object.entries(progress)
            .filter(([, p]) => p.done || p.queued)
            .map(([id]) =>
                window.setTimeout(() => {
                    const { [id]: _gone, ...rest } = flights;
                    setFlights(rest);
                }, 1600)
            );
        return () => timers.forEach((t) => window.clearTimeout(t));
    }, [progress]);

    const inFlight = Object.keys(flights);
    // With the Phones panel open its cards are the targets (and show progress) - no second set.
    const visible = !store.hubOpen && (dragging || inFlight.length > 0);
    const phones = [...store.devices]
        .filter((d) => dragging || inFlight.includes(d.id))
        .sort((a, b) => Number(b.online) - Number(a.online) || b.last_seen - a.last_seen);
    const shown = phones.slice(0, 7);
    if (!store.devices.length) return null;

    return (
        <div
            className={`fixed right-0 top-1/2 z-[9995] -translate-y-1/2 transition-all duration-300 ease-out ${
                visible ? "translate-x-0 opacity-100" : "translate-x-full opacity-0 pointer-events-none"
            }`}
            aria-hidden={!visible}
        >
            <div className="mr-3 flex flex-col items-center gap-2.5 rounded-[26px] bg-white/85 dark:bg-neutral-900/85 backdrop-blur-xl px-2.5 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.06] dark:ring-white/[0.08]">
                {dragging && <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">Send to</div>}
                {shown.map((d) => {
                    const Icon = d.platform === "ipad" ? IoTabletPortraitOutline : IoPhonePortraitOutline;
                    const p = progress[d.id];
                    const isHover = hovered === d.id;
                    return (
                        <div
                            key={d.id}
                            data-phone-drop={d.id}
                            className={`relative flex flex-col items-center gap-1 w-[76px] rounded-2xl py-2 transition-all duration-200 ${
                                isHover ? "scale-[1.14] bg-blue-500/10" : ""
                            }`}
                        >
                            <div className="relative w-[58px] h-[58px] flex items-center justify-center">
                                <svg className="absolute inset-0 -rotate-90" viewBox="0 0 58 58" aria-hidden>
                                    <circle cx="29" cy="29" r="25" fill="none" strokeWidth="3" className="stroke-neutral-200 dark:stroke-neutral-700" />
                                    {p && (
                                        <circle
                                            cx="29"
                                            cy="29"
                                            r="25"
                                            fill="none"
                                            strokeWidth="3"
                                            strokeLinecap="round"
                                            className={`transition-[stroke-dashoffset] duration-150 ${p.done ? "stroke-green-500" : "stroke-blue-500"}`}
                                            strokeDasharray={RING}
                                            strokeDashoffset={RING * (1 - (p.done ? 1 : p.fraction))}
                                        />
                                    )}
                                </svg>
                                <div
                                    className={`w-[46px] h-[46px] rounded-full flex items-center justify-center transition-colors ${
                                        isHover ? "bg-blue-500 text-white" : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200"
                                    }`}
                                >
                                    {p?.done ? <IoCheckmark size={22} className="text-green-500" /> : p?.queued ? <IoTimeOutline size={20} /> : <Icon size={21} />}
                                </div>
                                <span
                                    className={`absolute top-1 right-1 w-2.5 h-2.5 rounded-full ring-2 ring-white dark:ring-neutral-900 ${
                                        d.online ? "bg-green-500" : "bg-neutral-300 dark:bg-neutral-600"
                                    }`}
                                />
                                {/* The cast arcs radiate as a drop lands. */}
                                {p?.done && (
                                    <svg className="phone-shelf-burst absolute -inset-3 text-green-500" viewBox="0 0 48 48" aria-hidden>
                                        {[11, 20, 29].map((r, i) => (
                                            <path
                                                key={r}
                                                d={`M11 ${37 - r} A${r} ${r} 0 0 1 ${11 + r} 37`}
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="3"
                                                strokeLinecap="round"
                                                style={{ animationDelay: `${i * 0.1}s` }}
                                            />
                                        ))}
                                    </svg>
                                )}
                            </div>
                            <div className="max-w-[72px] truncate text-[11px] font-medium text-neutral-700 dark:text-neutral-200">{d.name}</div>
                            <div className="text-[9.5px] text-neutral-400 dark:text-neutral-500 -mt-0.5">
                                {p?.done ? "Sent" : p?.queued ? "Waits for it" : p ? `${Math.round(p.fraction * 100)}%` : d.online ? "Online" : "Later"}
                            </div>
                        </div>
                    );
                })}
                {dragging && phones.length > shown.length && (
                    <div className="text-[10.5px] text-neutral-400 dark:text-neutral-500">+{phones.length - shown.length} in Phones</div>
                )}
            </div>
        </div>
    );
}
