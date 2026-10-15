import { useEffect, useMemo, useRef, useState } from "react";
import { IoArrowDown, IoArrowUp, IoCheckmark, IoChevronDown, IoSwapVertical } from "react-icons/io5";

// Sorting for the file galleries (videos, images, PDFs, documents): by date modified, name or
// size, ascending or descending - remembered per gallery, so each keeps its own order.

export type SortKey = "date" | "name" | "size";
export type SortDir = "asc" | "desc";

interface SortableFile {
    name: string;
    size: number;
    // Milliseconds since the epoch, from list_briefcast_files. Absent on entries from an older
    // backend, which then sort as oldest.
    modified?: number;
}

const KEYS: { value: SortKey; label: string }[] = [
    { value: "date", label: "Date modified" },
    { value: "name", label: "Name" },
    { value: "size", label: "Size" },
];

// What each direction reads as for each key - "Newest first" says more than "Descending".
const DIR_LABELS: Record<SortKey, Record<SortDir, string>> = {
    date: { desc: "Newest first", asc: "Oldest first" },
    name: { asc: "A to Z", desc: "Z to A" },
    size: { desc: "Largest first", asc: "Smallest first" },
};

// Each key's natural first direction when picked: newest, A-Z, largest.
const DEFAULT_DIR: Record<SortKey, SortDir> = { date: "desc", name: "asc", size: "desc" };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const storageKey = (gallery: string) => `briefcast.gallerySort.${gallery}`;

const loadSort = (gallery: string): { key: SortKey; dir: SortDir } => {
    try {
        const raw = localStorage.getItem(storageKey(gallery));
        if (raw) {
            const parsed = JSON.parse(raw);
            if (KEYS.some((k) => k.value === parsed.key) && (parsed.dir === "asc" || parsed.dir === "desc")) {
                return parsed;
            }
        }
    } catch {
        // Unavailable storage just means the default order.
    }
    return { key: "date", dir: "desc" };
};

export const sortFiles = <T extends SortableFile>(files: T[], key: SortKey, dir: SortDir): T[] => {
    const sign = dir === "asc" ? 1 : -1;
    return [...files].sort((a, b) => {
        let c = 0;
        if (key === "date") c = (a.modified ?? 0) - (b.modified ?? 0);
        else if (key === "size") c = a.size - b.size;
        // Ties (and the name sort itself) fall back to natural name order: "Clip 2" before "Clip 10".
        if (c === 0) c = collator.compare(a.name, b.name) * (key === "name" ? 1 : sign);
        return c * sign;
    });
};

// The galleries' sorted file list, plus the control that changes it.
export const useGallerySort = <T extends SortableFile>(files: T[], gallery: string) => {
    const [sort, setSort] = useState(() => loadSort(gallery));
    useEffect(() => {
        try {
            localStorage.setItem(storageKey(gallery), JSON.stringify(sort));
        } catch {
            // Best effort - the order still applies for this session.
        }
    }, [gallery, sort]);
    const sorted = useMemo(() => sortFiles(files, sort.key, sort.dir), [files, sort.key, sort.dir]);
    const control = <GallerySortControl sortKey={sort.key} dir={sort.dir} onChange={(key, dir) => setSort({ key, dir })} />;
    return { sorted, control };
};

const GallerySortControl = ({
    sortKey,
    dir,
    onChange,
}: {
    sortKey: SortKey;
    dir: SortDir;
    onChange: (key: SortKey, dir: SortDir) => void;
}) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const close = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        document.addEventListener("mousedown", close);
        document.addEventListener("keydown", esc);
        return () => {
            document.removeEventListener("mousedown", close);
            document.removeEventListener("keydown", esc);
        };
    }, [open]);

    const keyLabel = KEYS.find((k) => k.value === sortKey)?.label ?? "Date modified";

    return (
        <div ref={ref} className="relative flex items-center gap-1 normal-case tracking-normal">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="flex items-center gap-1.5 h-8 pl-2.5 pr-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs text-neutral-700 dark:text-neutral-200 hover:border-neutral-300 dark:hover:border-neutral-600"
                title="Sort files"
            >
                <IoSwapVertical className="text-neutral-400" />
                <span>
                    {keyLabel} <span className="text-neutral-400">· {DIR_LABELS[sortKey][dir]}</span>
                </span>
                <IoChevronDown className={`text-neutral-400 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            <button
                type="button"
                onClick={() => onChange(sortKey, dir === "asc" ? "desc" : "asc")}
                className="flex items-center justify-center w-8 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600"
                title={`Switch to ${DIR_LABELS[sortKey][dir === "asc" ? "desc" : "asc"].toLowerCase()}`}
            >
                {dir === "asc" ? <IoArrowUp /> : <IoArrowDown />}
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-1.5 z-30 w-52 py-1 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg text-sm">
                    <div className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Sort by</div>
                    {KEYS.map((k) => (
                        <button
                            key={k.value}
                            type="button"
                            onClick={() => {
                                onChange(k.value, k.value === sortKey ? dir : DEFAULT_DIR[k.value]);
                                setOpen(false);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        >
                            <IoCheckmark className={k.value === sortKey ? "text-emerald-500" : "opacity-0"} />
                            {k.label}
                        </button>
                    ))}
                    <div className="my-1 border-t border-neutral-200 dark:border-neutral-700" />
                    <div className="px-3 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Order</div>
                    {(["asc", "desc"] as SortDir[])
                        .sort((a, b) => (a === DEFAULT_DIR[sortKey] ? -1 : b === DEFAULT_DIR[sortKey] ? 1 : 0))
                        .map((d) => (
                            <button
                                key={d}
                                type="button"
                                onClick={() => {
                                    onChange(sortKey, d);
                                    setOpen(false);
                                }}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                            >
                                <IoCheckmark className={d === dir ? "text-emerald-500" : "opacity-0"} />
                                {DIR_LABELS[sortKey][d]}
                            </button>
                        ))}
                </div>
            )}
        </div>
    );
};
