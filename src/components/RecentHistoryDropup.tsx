import { useEffect, useRef, useState, useMemo } from "react";
import {
  IoTimeOutline,
  IoClose,
  IoCloseCircle,
  IoSearchOutline,
  IoPin,
  IoDocumentTextOutline,
  IoGitNetworkOutline,
  IoMapOutline,
  IoVideocamOutline,
  IoMusicalNotesOutline,
  IoImagesOutline,
  IoDocumentOutline,
  IoPhonePortraitOutline,
} from "react-icons/io5";
import type { HomeItem } from "../utils/homeLibraryItems";
import { relativeTime } from "../utils/homeLibraryItems";
import type { FileEntry } from "../utils/libraryEntries";
import { getFileCategory, FileCategory } from "../utils/fileCategory";
import { formatFileSize, formatMediaDuration, truncateFileName } from "../utils/Formater";

export interface RecentHistoryDropupProps {
  items: HomeItem[];
  onOpenItem: (item: HomeItem) => void;
  libraryFilesByPath?: Map<string, FileEntry>;
  arrivals?: Record<string, { from: string; at: number; count: number }>;
  libraryPreviewDurations?: Map<string, number>;
  disabled?: boolean;
}

const CATEGORY_COLORS: Record<FileCategory, string> = {
  video: "text-violet-500 dark:text-violet-400",
  audio: "text-pink-500 dark:text-pink-400",
  image: "text-emerald-500 dark:text-emerald-400",
  pdf: "text-red-500 dark:text-red-400",
  document: "text-blue-500 dark:text-blue-400",
};

export default function RecentHistoryDropup({
  items,
  onOpenItem,
  libraryFilesByPath,
  arrivals,
  libraryPreviewDurations,
  disabled = false,
}: RecentHistoryDropupProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  // Focus search input on open
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      // Small timeout to wait for render
      const t = setTimeout(() => searchInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const name = item.name.toLowerCase();
      if (name.includes(q)) return true;
      if (item.kind !== "file" && item.kind.toLowerCase().includes(q)) return true;
      if (item.kind === "file") {
        const cat = getFileCategory(item.name);
        if (cat && cat.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [items, query]);

  const renderItemIcon = (item: HomeItem) => {
    if (item.kind === "doc") {
      return <IoDocumentTextOutline size={16} className="text-blue-500 dark:text-blue-400 shrink-0" />;
    }
    if (item.kind === "whiteboard") {
      return <IoGitNetworkOutline size={16} className="text-amber-500 dark:text-amber-400 shrink-0" />;
    }
    if (item.kind === "mindmap") {
      return <IoMapOutline size={16} className="text-emerald-500 dark:text-emerald-400 shrink-0" />;
    }

    const cat = getFileCategory(item.name);
    const color = cat ? CATEGORY_COLORS[cat] : "text-neutral-400 dark:text-neutral-500";

    switch (cat) {
      case "video":
        return <IoVideocamOutline size={16} className={`${color} shrink-0`} />;
      case "audio":
        return <IoMusicalNotesOutline size={16} className={`${color} shrink-0`} />;
      case "image":
        return <IoImagesOutline size={16} className={`${color} shrink-0`} />;
      case "pdf":
        return <IoDocumentOutline size={16} className={`${color} shrink-0`} />;
      default:
        return <IoDocumentTextOutline size={16} className={`${color} shrink-0`} />;
    }
  };

  const getItemMeta = (item: HomeItem) => {
    if (item.kind === "file") {
      const file = libraryFilesByPath?.get(item.id);
      const arrival = file && arrivals ? arrivals[file.path] : undefined;

      if (arrival) {
        return (
          <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400 truncate">
            <IoPhonePortraitOutline size={11} className="shrink-0" />
            <span className="truncate">From {arrival.from}</span>
            <span>·</span>
            <span className="shrink-0">{relativeTime(arrival.at)}</span>
          </span>
        );
      }

      const cat = getFileCategory(item.name);
      const catLabel = cat ? (cat.charAt(0).toUpperCase() + cat.slice(1)) : "File";
      const dur = file && libraryPreviewDurations?.has(file.path)
        ? formatMediaDuration(libraryPreviewDurations.get(file.path)!)
        : null;

      const sizeStr = file && file.size > 0 ? formatFileSize(file.size) : null;
      const timeStr = item.time > 0 ? relativeTime(item.time) : null;

      const parts = [dur, sizeStr, timeStr].filter(Boolean);
      return <span className="truncate">{parts.length > 0 ? parts.join(" · ") : catLabel}</span>;
    }

    const kindLabels: Record<string, string> = {
      doc: "Document",
      whiteboard: "Whiteboard",
      mindmap: "Mind map",
    };
    const label = kindLabels[item.kind] || item.kind;
    const timeStr = item.time > 0 ? relativeTime(item.time) : null;

    return <span className="truncate">{timeStr ? `${label} · ${timeStr}` : label}</span>;
  };

  return (
    <div className="relative inline-flex items-center" ref={containerRef}>
      <button
        type="button"
        title="Recent history"
        onClick={() => !disabled && setIsOpen((prev) => !prev)}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={
          disabled
            ? "p-1.5 rounded-md text-base outline-none text-neutral-300 dark:text-neutral-600 cursor-not-allowed"
            : `cursor-pointer p-1.5 rounded-md text-base transition-all duration-150 active:scale-90 outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 ${
                isOpen
                  ? "bg-blue-500/15 text-blue-600 dark:text-blue-400 hover:bg-blue-500/25"
                  : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
              }`
        }
      >
        <IoTimeOutline />
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Recent library items"
          className="absolute bottom-full mb-2 right-0 w-80 sm:w-96 max-w-[calc(100vw-2rem)] max-h-[26rem] flex flex-col rounded-xl bg-white/95 dark:bg-neutral-900/95 backdrop-blur-md border border-neutral-200 dark:border-neutral-800 shadow-2xl z-50 overflow-hidden text-neutral-800 dark:text-neutral-200 animate-in fade-in zoom-in-95 duration-100"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-200 dark:border-neutral-800">
            <div className="flex items-center gap-1.5">
              <IoTimeOutline size={15} className="text-neutral-400 dark:text-neutral-500" />
              <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                Recent history
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 font-medium">
                {filteredItems.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="p-1 rounded-md text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              title="Close"
            >
              <IoClose size={15} />
            </button>
          </div>

          {/* Quick Filter Bar */}
          {items.length > 5 && (
            <div className="px-2.5 pt-2 pb-1">
              <div className="relative flex items-center">
                <IoSearchOutline className="absolute left-2.5 text-neutral-400 pointer-events-none" size={13} />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter recent items..."
                  className="w-full pl-8 pr-7 py-1 text-xs rounded-lg bg-neutral-100 dark:bg-neutral-800/80 border border-neutral-200/70 dark:border-neutral-700/60 focus:outline-none focus:ring-1 focus:ring-blue-500 text-neutral-800 dark:text-neutral-100 placeholder-neutral-400"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="absolute right-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                    title="Clear filter"
                  >
                    <IoCloseCircle size={13} />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Items List */}
          <div className="flex-1 overflow-y-auto max-h-[19rem] p-1.5 space-y-0.5 overscroll-contain">
            {filteredItems.length === 0 ? (
              <div className="py-8 text-center text-xs text-neutral-400 dark:text-neutral-500">
                {query ? "No matching items found" : "No recent items yet"}
              </div>
            ) : (
              filteredItems.map((item) => {
                const file = item.kind === "file" && libraryFilesByPath ? libraryFilesByPath.get(item.id) : undefined;
                const displayName = file ? truncateFileName(file.name, 34) : truncateFileName(item.name, 34);

                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      onOpenItem(item);
                      setIsOpen(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800/80 text-left transition-colors group cursor-pointer"
                  >
                    {renderItemIcon(item)}

                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-neutral-800 dark:text-neutral-200 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                        {displayName}
                      </div>
                      <div className="text-[11px] text-neutral-400 dark:text-neutral-500 flex items-center gap-1.5 mt-0.5">
                        {getItemMeta(item)}
                      </div>
                    </div>

                    {item.pinned && (
                      <span title="Pinned" className="shrink-0 text-amber-500">
                        <IoPin size={12} />
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
