// components/Modals/UsbImportModal.tsx
//
// "Import from phone" over a USB cable, three ways in:
// - Photos & videos: the camera roll as a grid, newest first, by day, already-imported marked.
// - Documents: every paper, slide deck, spreadsheet, dataset, notebook and archive the phone has
//   collected - from Downloads, Documents, WhatsApp and Telegram - searchable and filterable by type.
// - Browse phone: the phone's folders, for anything the first two don't cover.
// One selection spans all three, and everything lands in the library's "From phone" folder as the
// phone's own original bytes. See src-tauri/src/services/usb_phone.rs.

import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
    IoArrowBack,
    IoCheckmarkCircle,
    IoChevronForward,
    IoClose,
    IoFolderOpenOutline,
    IoFolderOutline,
    IoImageOutline,
    IoInformationCircleOutline,
    IoPlay,
    IoSearch,
    IoVideocam,
} from "react-icons/io5";
import {
    browseUsb,
    cancelUsbTransfer,
    closeUsbImport,
    getUsbState,
    importOverUsb,
    scanKey,
    scanUsbPhone,
    setUsbImportTab,
    subscribeUsb,
    usbThumbnail,
    usbUnlockHint,
    type UsbBrowseEntry,
    type UsbImportTab,
    type UsbMediaItem,
    type UsbStore,
} from "../../services/usbPhone";

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

const formatDate = (ms: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

// What gets imported - the same shape whichever tab it was picked from.
type ImportPick = Pick<UsbMediaItem, "object_id" | "name" | "size" | "modified" | "unique_id">;

// Document families, for the filter chips and the coloured extension badges.
const DOC_GROUPS: { id: string; label: string; exts: string[]; tone: string }[] = [
    { id: "pdf", label: "PDF", exts: ["pdf"], tone: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300" },
    {
        id: "office",
        label: "Office & text",
        exts: ["doc", "docx", "odt", "rtf", "txt", "md", "epub", "djvu", "ps", "eps", "xps", "ppt", "pptx", "odp", "key", "xls", "xlsx", "ods", "numbers", "pages"],
        tone: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
    },
    {
        id: "data",
        label: "Data",
        exts: ["csv", "tsv", "json", "xml", "yaml", "yml", "toml", "log", "dat", "root", "h5", "hdf5", "nc", "fits", "fit", "mat", "npy", "npz", "parquet", "feather", "sqlite", "db"],
        tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    },
    {
        id: "code",
        label: "Code & LaTeX",
        exts: ["tex", "bib", "cls", "sty", "ipynb", "py", "r", "m", "jl", "c", "cc", "cpp", "h", "hpp", "f90", "java", "js", "ts", "sh"],
        tone: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
    },
    { id: "archive", label: "Archives", exts: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"], tone: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
];

const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");
const groupOf = (name: string) => DOC_GROUPS.find((g) => g.exts.includes(extOf(name)));

const ExtBadge = ({ name }: { name: string }) => (
    <span
        className={`shrink-0 w-11 h-11 rounded-lg flex items-center justify-center text-[10px] font-bold uppercase tracking-wide ${
            groupOf(name)?.tone ?? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
        }`}
    >
        {extOf(name).slice(0, 5) || "file"}
    </span>
);

// Thumbnails come over the same cable as everything else, so they're cached for the session and
// fetched only for tiles actually on screen.
const thumbCache = new Map<string, string | null>();

const Thumb = ({ deviceId, item }: { deviceId: string; item: UsbMediaItem }) => {
    const key = `${deviceId}|${item.object_id}`;
    const [src, setSrc] = useState<string | null | undefined>(thumbCache.get(key));
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (src !== undefined || !ref.current) return;
        let cancelled = false;
        const observer = new IntersectionObserver(
            (entries) => {
                if (!entries.some((e) => e.isIntersecting)) return;
                observer.disconnect();
                void usbThumbnail(deviceId, item).then((url) => {
                    thumbCache.set(key, url);
                    if (!cancelled) setSrc(url);
                });
            },
            { rootMargin: "200px" }
        );
        observer.observe(ref.current);
        return () => {
            cancelled = true;
            observer.disconnect();
        };
    }, [deviceId, item.object_id, key, src]);

    return (
        <div ref={ref} className="absolute inset-0 flex items-center justify-center bg-neutral-100 dark:bg-neutral-800">
            {src ? (
                <img src={src} alt="" className="w-full h-full object-cover" draggable={false} />
            ) : item.kind === "video" ? (
                <IoVideocam className="text-neutral-400" size={22} />
            ) : (
                <IoImageOutline className="text-neutral-400" size={22} />
            )}
        </div>
    );
};

const dayLabel = (ms: number) => {
    if (!ms) return "Unknown date";
    const d = new Date(ms);
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
};

// Renders a long list a page at a time: the first page right away, more as the end scrolls into
// view. Thousands of tiles at once is what made clicks lag.
const PAGE = 200;
const useProgressive = (total: number, resetKey: unknown) => {
    const [limit, setLimit] = useState(PAGE);
    const sentinel = useRef<HTMLDivElement>(null);
    useEffect(() => setLimit(PAGE), [resetKey]);
    useEffect(() => {
        const el = sentinel.current;
        if (!el || limit >= total) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + PAGE);
            },
            { rootMargin: "600px" }
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [limit, total]);
    return { limit, sentinel: limit < total ? <div ref={sentinel} className="h-px" /> : null };
};

const Checkbox = ({ on }: { on: boolean }) => (
    <span
        className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
            on ? "bg-blue-500 border-blue-500 text-white" : "border-neutral-300 dark:border-neutral-600"
        }`}
    >
        {on && <IoCheckmarkCircle size={18} />}
    </span>
);

interface SelectionProps {
    selected: Map<string, ImportPick>;
    toggle: (items: ImportPick[], on?: boolean) => void;
}

// One grid tile. Memoized, so a batch of new items arriving (or one selection changing) only
// renders the tiles that actually changed - not the whole grid.
const Tile = memo(function Tile({
    deviceId,
    item,
    index,
    on,
    onPick,
}: {
    deviceId: string;
    item: UsbMediaItem;
    index: number;
    on: boolean;
    onPick: (index: number, shift: boolean) => void;
}) {
    return (
        <button
            type="button"
            title={`${item.name} · ${formatBytes(item.size)}`}
            onClick={(e) => onPick(index, e.shiftKey)}
            className={`relative aspect-square rounded-lg overflow-hidden ring-offset-2 ring-offset-white dark:ring-offset-neutral-900 ${on ? "ring-2 ring-blue-500" : ""}`}
        >
            <Thumb deviceId={deviceId} item={item} />
            {item.kind === "video" && (
                <span className="absolute bottom-1 left-1 flex items-center gap-0.5 px-1 py-0.5 rounded bg-black/60 text-white text-[10px]">
                    <IoPlay size={9} /> {formatBytes(item.size)}
                </span>
            )}
            {item.imported && <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/60 text-white text-[10px]">Imported</span>}
            <span
                className={`absolute top-1 right-1 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                    on ? "bg-blue-500 border-blue-500 text-white" : "border-white/90 bg-black/20"
                }`}
            >
                {on && <IoCheckmarkCircle size={18} />}
            </span>
        </button>
    );
});

// "Select new" when nothing is picked yet, "Deselect all" once everything it covers is - one button
// that always undoes itself. With everything already imported, it offers all of them instead.
const BulkSelect = ({ items, selected, toggle }: { items: UsbMediaItem[] } & SelectionProps) => {
    const fresh = items.filter((i) => !i.imported);
    const targets = fresh.length ? fresh : items;
    const allOn = targets.length > 0 && targets.every((i) => selected.has(i.unique_id));
    return (
        <button
            type="button"
            disabled={!targets.length}
            onClick={() => toggle(targets, !allOn)}
            className="ml-auto px-2.5 py-1 rounded-lg text-[12px] border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
        >
            {allOn ? `Deselect all (${targets.length})` : fresh.length ? `Select new (${fresh.length})` : `Select all (${items.length})`}
        </button>
    );
};

// ------------------------------------------------------------------------- photos & videos

const MediaTab = memo(function MediaTab({ deviceId, items, selected, toggle }: { deviceId: string; items: UsbMediaItem[] } & SelectionProps) {
    const [filter, setFilter] = useState<"all" | "image" | "video">("all");
    const lastClicked = useRef<number | null>(null);
    const shown = useMemo(
        () => items.filter((i) => filter === "all" || i.kind === filter).sort((a, b) => b.modified - a.modified),
        [items, filter]
    );
    const { limit, sentinel } = useProgressive(shown.length, filter);
    const groups = useMemo(() => {
        const out: { label: string; items: { item: UsbMediaItem; index: number }[] }[] = [];
        shown.slice(0, limit).forEach((item, index) => {
            const label = dayLabel(item.modified);
            if (!out.length || out[out.length - 1].label !== label) out.push({ label, items: [] });
            out[out.length - 1].items.push({ item, index });
        });
        return out;
    }, [shown, limit]);

    const click = useStableCallback((index: number, shift: boolean) => {
        if (shift && lastClicked.current !== null) {
            const [a, b] = [lastClicked.current, index].sort((x, y) => x - y);
            toggle(shown.slice(a, b + 1), !selected.has(shown[index].unique_id));
        } else {
            toggle([shown[index]]);
        }
        lastClicked.current = index;
    });

    return (
        <>
            <div className="flex items-center gap-2 mb-2">
                <div className="flex items-center gap-1 p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-800">
                    {(["all", "image", "video"] as const).map((f) => (
                        <button
                            key={f}
                            type="button"
                            onClick={() => setFilter(f)}
                            className={`px-2.5 py-1 rounded-md text-[12px] font-medium ${
                                filter === f ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm" : "text-neutral-500 dark:text-neutral-400"
                            }`}
                        >
                            {f === "all" ? "All" : f === "image" ? "Photos" : "Videos"}
                        </button>
                    ))}
                </div>
                <BulkSelect items={shown} selected={selected} toggle={toggle} />
            </div>
            {groups.map((g) => (
                <section key={g.label} className="mb-4" style={{ contentVisibility: "auto", containIntrinsicSize: "400px" }}>
                    <div className="sticky top-0 z-10 py-1.5 text-[12px] font-semibold text-neutral-600 dark:text-neutral-300 bg-white/95 dark:bg-neutral-900/95">
                        {g.label}
                    </div>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1.5">
                        {g.items.map(({ item, index }) => (
                            <Tile key={item.object_id} deviceId={deviceId} item={item} index={index} on={selected.has(item.unique_id)} onPick={click} />
                        ))}
                    </div>
                </section>
            ))}
            {sentinel}
        </>
    );
});

// ------------------------------------------------------------------------- documents

const DocumentsTab = memo(function DocumentsTab({ items, selected, toggle }: { items: UsbMediaItem[] } & SelectionProps) {
    const [query, setQuery] = useState("");
    const [group, setGroup] = useState<string | null>(null);
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return items
            .filter((i) => !group || groupOf(i.name)?.id === group)
            .filter((i) => !q || i.name.toLowerCase().includes(q))
            .sort((a, b) => b.modified - a.modified);
    }, [items, query, group]);
    const { limit, sentinel } = useProgressive(shown.length, `${query}|${group}`);
    const counts = useMemo(() => {
        const c: Record<string, number> = {};
        for (const i of items) {
            const g = groupOf(i.name)?.id;
            if (g) c[g] = (c[g] ?? 0) + 1;
        }
        return c;
    }, [items]);

    return (
        <>
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 w-[220px]">
                    <IoSearch size={13} className="text-neutral-400" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search documents"
                        className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-neutral-800 dark:text-neutral-100"
                    />
                </div>
                <button
                    type="button"
                    onClick={() => setGroup(null)}
                    className={`px-2.5 py-1 rounded-full text-[12px] font-medium border ${
                        !group ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 border-transparent" : "border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300"
                    }`}
                >
                    All ({items.length})
                </button>
                {DOC_GROUPS.filter((g) => counts[g.id]).map((g) => (
                    <button
                        key={g.id}
                        type="button"
                        onClick={() => setGroup(group === g.id ? null : g.id)}
                        className={`px-2.5 py-1 rounded-full text-[12px] font-medium border ${
                            group === g.id
                                ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 border-transparent"
                                : "border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300"
                        }`}
                    >
                        {g.label} ({counts[g.id]})
                    </button>
                ))}
                <BulkSelect items={shown} selected={selected} toggle={toggle} />
            </div>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {shown.slice(0, limit).map((item) => {
                    const on = selected.has(item.unique_id);
                    return (
                        <li key={item.object_id}>
                            <button
                                type="button"
                                onClick={() => toggle([item])}
                                className={`w-full flex items-center gap-3 px-2 py-2 rounded-lg text-left ${on ? "bg-blue-50 dark:bg-blue-500/10" : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"}`}
                            >
                                <Checkbox on={on} />
                                <ExtBadge name={item.name} />
                                <div className="flex-1 min-w-0">
                                    <div className="truncate text-[13px] text-neutral-800 dark:text-neutral-100">{item.name}</div>
                                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                                        {formatBytes(item.size)}
                                        {item.modified ? ` · ${formatDate(item.modified)}` : ""}
                                        {item.imported ? " · imported" : ""}
                                    </div>
                                </div>
                            </button>
                        </li>
                    );
                })}
            </ul>
            {sentinel}
        </>
    );
});

// ------------------------------------------------------------------------- browse

const BrowseTab = ({ deviceId, selected, toggle }: { deviceId: string } & SelectionProps) => {
    // The path from the storage roots down, as (object id, name) pairs.
    const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
    const [entries, setEntries] = useState<UsbBrowseEntry[] | null>(null);
    const [error, setError] = useState("");
    const folder = trail.length ? trail[trail.length - 1].id : null;

    useEffect(() => {
        let cancelled = false;
        setEntries(null);
        setError("");
        browseUsb(deviceId, folder)
            .then((e) => !cancelled && setEntries(e))
            .catch((e) => !cancelled && setError(String(e)));
        return () => {
            cancelled = true;
        };
    }, [deviceId, folder]);

    const files = (entries ?? []).filter((e) => !e.is_folder);

    return (
        <>
            <div className="flex items-center gap-1 mb-2 text-[12px] text-neutral-600 dark:text-neutral-300 flex-wrap">
                <button type="button" disabled={!trail.length} onClick={() => setTrail(trail.slice(0, -1))} className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30">
                    <IoArrowBack size={14} />
                </button>
                <button type="button" onClick={() => setTrail([])} className="px-1.5 py-0.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 font-medium">
                    Phone
                </button>
                {trail.map((t, i) => (
                    <span key={t.id} className="flex items-center gap-1">
                        <IoChevronForward size={11} className="text-neutral-400" />
                        <button type="button" onClick={() => setTrail(trail.slice(0, i + 1))} className="px-1.5 py-0.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800">
                            {t.name}
                        </button>
                    </span>
                ))}
                {files.length > 0 && (
                    <button
                        type="button"
                        onClick={() => toggle(files, !files.every((f) => selected.has(f.unique_id)))}
                        className="ml-auto px-2.5 py-1 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                        {files.every((f) => selected.has(f.unique_id)) ? "Deselect" : "Select"} all files here ({files.length})
                    </button>
                )}
            </div>
            {error ? (
                <div className="py-10 text-center text-[13px] text-red-600 dark:text-red-400">{error}</div>
            ) : !entries ? (
                <div className="py-10 text-center text-[12px] text-neutral-500 animate-pulse">Opening…</div>
            ) : !entries.length ? (
                <div className="py-10 text-center text-[13px] text-neutral-500 dark:text-neutral-400">This folder is empty.</div>
            ) : (
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                    {entries.map((e) =>
                        e.is_folder ? (
                            <li key={e.object_id}>
                                <button
                                    type="button"
                                    onClick={() => setTrail([...trail, { id: e.object_id, name: e.name }])}
                                    className="w-full flex items-center gap-3 px-2 py-2 rounded-lg text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                                >
                                    <span className="shrink-0 w-5" />
                                    <span className="shrink-0 w-11 h-11 rounded-lg bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-500">
                                        <IoFolderOutline size={20} />
                                    </span>
                                    <span className="flex-1 min-w-0 truncate text-[13px] text-neutral-800 dark:text-neutral-100">{e.name}</span>
                                    <IoChevronForward size={13} className="text-neutral-400" />
                                </button>
                            </li>
                        ) : (
                            <li key={e.object_id}>
                                <button
                                    type="button"
                                    onClick={() => toggle([e])}
                                    className={`w-full flex items-center gap-3 px-2 py-2 rounded-lg text-left ${
                                        selected.has(e.unique_id) ? "bg-blue-50 dark:bg-blue-500/10" : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                                    }`}
                                >
                                    <Checkbox on={selected.has(e.unique_id)} />
                                    <ExtBadge name={e.name} />
                                    <div className="flex-1 min-w-0">
                                        <div className="truncate text-[13px] text-neutral-800 dark:text-neutral-100">{e.name}</div>
                                        <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                                            {formatBytes(e.size)}
                                            {e.modified ? ` · ${formatDate(e.modified)}` : ""}
                                            {e.imported ? " · imported" : ""}
                                        </div>
                                    </div>
                                </button>
                            </li>
                        )
                    )}
                </ul>
            )}
        </>
    );
};

// ------------------------------------------------------------------------- window

const TABS: { id: UsbImportTab; label: string }[] = [
    { id: "media", label: "Photos & videos" },
    { id: "documents", label: "Documents" },
    { id: "browse", label: "Browse phone" },
];

const UsbImportModal = ({ deviceId, tab, store }: { deviceId: string; tab: UsbImportTab; store: UsbStore }) => {
    const phone = store.phones.find((p) => p.id === deviceId);
    const [selected, setSelected] = useState<Map<string, ImportPick>>(new Map());
    const [transferId, setTransferId] = useState<string | null>(null);
    // A list is read the first time its tab is shown, and kept: reopening the window shows it at
    // once (Refresh re-reads the phone).
    useEffect(() => {
        if (tab === "browse" || getUsbState().media[scanKey(deviceId, tab)]) return;
        void scanUsbPhone(deviceId, tab);
    }, [deviceId, tab]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") closeUsbImport();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // The tab strip follows a click at once; the (possibly heavy) content catches up a moment later
    // without holding the click up.
    const contentTab = useDeferredValue(tab);
    const scan = contentTab === "browse" ? undefined : store.media[scanKey(deviceId, contentTab)];
    const transfer = transferId ? store.transfers.find((t) => t.id === transferId) : undefined;
    const running = transfer?.state === "running";
    const selectedSize = [...selected.values()].reduce((a, i) => a + i.size, 0);

    useEffect(() => {
        if (transfer?.state === "done") setSelected(new Map());
    }, [transfer?.state]);

    const toggle = useStableCallback((items: ImportPick[], on?: boolean) => {
        setSelected((prev) => {
            const next = new Map(prev);
            for (const it of items) {
                const want = on ?? !next.has(it.unique_id);
                if (want) next.set(it.unique_id, it);
                else next.delete(it.unique_id);
            }
            return next;
        });
    });

    const startImport = async () => {
        if (!selected.size) return;
        try {
            setTransferId(await importOverUsb(deviceId, [...selected.values()]));
        } catch {
            /* the transfer event carries the error */
        }
    };

    const count = (mode: "media" | "documents") => store.media[scanKey(deviceId, mode)]?.items.length;

    return (
        <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/30 backdrop-blur-sm"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget && !running) closeUsbImport();
            }}
        >
            <div className="w-[920px] max-w-[calc(100vw-32px)] h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-neutral-900 shadow-[0_16px_48px_rgba(0,0,0,0.2)] ring-1 ring-black/[0.06] dark:ring-white/[0.08] overflow-hidden">
                <div className="flex items-center gap-3 px-5 pt-3.5 border-b border-neutral-200 dark:border-neutral-800">
                    <div className="min-w-0 pb-3">
                        <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100 truncate">Import from {phone?.name ?? "phone"}</h2>
                        <div className="text-[12px] text-neutral-500 dark:text-neutral-400">
                            USB cable · originals, straight into “From phone”
                            {contentTab !== "browse" && scan?.done && (
                                <>
                                    {" · "}
                                    <button type="button" onClick={() => void scanUsbPhone(deviceId, contentTab)} className="underline hover:text-neutral-800 dark:hover:text-neutral-200">
                                        Refresh
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                    <div className="ml-auto self-end flex gap-1">
                        {TABS.map((t) => {
                            const n = t.id === "browse" ? undefined : count(t.id);
                            return (
                                <button
                                    key={t.id}
                                    type="button"
                                    onClick={() => setUsbImportTab(t.id)}
                                    className={`px-3 py-2 text-[13px] font-medium border-b-2 -mb-px ${
                                        tab === t.id
                                            ? "border-neutral-900 dark:border-neutral-100 text-neutral-900 dark:text-white"
                                            : "border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                                    }`}
                                >
                                    {t.label}
                                    {n !== undefined && <span className="ml-1 text-[11px] text-neutral-400">{n}</span>}
                                </button>
                            );
                        })}
                    </div>
                    <button
                        type="button"
                        onClick={() => closeUsbImport()}
                        disabled={running}
                        className="self-start p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
                        title="Close"
                    >
                        <IoClose size={18} />
                    </button>
                </div>

                {phone?.kind === "iphone" && tab === "media" && (
                    <div className="mx-5 mt-3 flex gap-2 p-2.5 rounded-lg bg-blue-50 dark:bg-blue-500/10 text-blue-800 dark:text-blue-300 text-[12px]">
                        <IoInformationCircleOutline className="shrink-0 mt-0.5" size={14} />
                        <span>
                            For untouched originals (HEIC photos, HEVC video), set the iPhone's <strong>Settings › Photos › Transfer to Mac or PC</strong> to{" "}
                            <strong>Keep Originals</strong>. Otherwise the iPhone converts them on the way out.
                        </span>
                    </div>
                )}

                <div className="flex-1 overflow-y-auto px-5 py-3">
                    {phone?.state === "locked" ? (
                        <div className="py-16 text-center text-[13px] text-neutral-600 dark:text-neutral-300">{usbUnlockHint(phone)}</div>
                    ) : contentTab === "browse" ? (
                        <BrowseTab deviceId={deviceId} selected={selected} toggle={toggle} />
                    ) : scan?.error && !scan.items.length ? (
                        <div className="py-16 text-center text-[13px] text-neutral-600 dark:text-neutral-300 max-w-md mx-auto">{scan.error}</div>
                    ) : scan?.done && !scan.items.length ? (
                        <div className="py-16 text-center text-[13px] text-neutral-500 dark:text-neutral-400">
                            {contentTab === "documents" ? "No documents found in Downloads, Documents, WhatsApp or Telegram. Try Browse phone." : "No photos or videos found."}
                        </div>
                    ) : contentTab === "documents" ? (
                        <DocumentsTab items={scan?.items ?? []} selected={selected} toggle={toggle} />
                    ) : (
                        <MediaTab deviceId={deviceId} items={scan?.items ?? []} selected={selected} toggle={toggle} />
                    )}
                    {contentTab !== "browse" && scan && !scan.done && (
                        <div className="py-3 text-center text-[12px] text-neutral-500 dark:text-neutral-400 animate-pulse">Reading the phone…</div>
                    )}
                </div>

                <div className="flex items-center gap-3 px-5 py-3 border-t border-neutral-200 dark:border-neutral-800">
                    {transfer && transfer.state !== "done" && transfer.state !== "cancelled" ? (
                        <div className="flex-1 min-w-0">
                            <div className="flex justify-between text-[12px] text-neutral-600 dark:text-neutral-300">
                                <span className="truncate">
                                    {transfer.state === "failed" ? transfer.error : `Importing ${transfer.file_index + 1} of ${transfer.file_count} · ${transfer.name}`}
                                </span>
                                <span>
                                    {formatBytes(transfer.done_bytes)} / {formatBytes(transfer.total_bytes)}
                                </span>
                            </div>
                            <div className="mt-1 h-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                                <div
                                    className={`h-full rounded-full ${transfer.state === "failed" ? "bg-red-500" : "bg-blue-500"} transition-[width] duration-150`}
                                    style={{ width: `${transfer.total_bytes ? (transfer.done_bytes / transfer.total_bytes) * 100 : 0}%` }}
                                />
                            </div>
                        </div>
                    ) : transfer?.state === "done" && !selected.size ? (
                        <div className="flex-1 flex items-center gap-2 text-[13px] text-green-700 dark:text-green-400">
                            <IoCheckmarkCircle size={16} /> Imported {transfer.file_count} to “From phone”
                            {transfer.paths[0] && (
                                <button
                                    type="button"
                                    onClick={() => void invoke("open_file_from_directory", { filepath: transfer.paths[0] })}
                                    className="ml-1 flex items-center gap-1 text-neutral-600 dark:text-neutral-300 hover:underline"
                                >
                                    <IoFolderOpenOutline size={14} /> Show
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="flex-1 flex items-center gap-2 text-[12px] text-neutral-600 dark:text-neutral-300">
                            {selected.size > 0 ? (
                                <>
                                    <span>{selected.size} selected</span>
                                    <button type="button" onClick={() => setSelected(new Map())} className="hover:underline">
                                        Clear
                                    </button>
                                </>
                            ) : (
                                <span className="text-neutral-400">Pick from any tab - photos, documents and folders can go in one import.</span>
                            )}
                        </div>
                    )}
                    {running ? (
                        <button
                            type="button"
                            onClick={() => transferId && void cancelUsbTransfer(transferId)}
                            className="px-4 py-2 rounded-lg text-[13px] font-medium border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        >
                            Cancel
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={() => void startImport()}
                            disabled={!selected.size}
                            className="px-4 py-2 rounded-lg text-[13px] font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-white disabled:opacity-40"
                        >
                            {selected.size ? `Import ${selected.size} · ${formatBytes(selectedSize)}` : "Import"}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

// A callback whose identity never changes, so the memoized tabs aren't re-rendered because of it.
function useStableCallback<A extends unknown[]>(fn: (...args: A) => void) {
    const ref = useRef(fn);
    ref.current = fn;
    return useRef((...args: A) => ref.current(...args)).current;
}

// Mounted once (Dashboard), next to PhoneTransferHost.
export const UsbImportHost = () => {
    const [store, setStore] = useState<UsbStore>(getUsbState());
    useEffect(() => subscribeUsb(setStore), []);
    if (!store.importing) return null;
    return <UsbImportModal key={store.importing.device} deviceId={store.importing.device} tab={store.importing.tab} store={store} />;
};

export default UsbImportModal;
