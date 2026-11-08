// components/links/LinksControl.tsx
//
// The "Linked" control every viewer mounts for the item it is showing (PDF, image, video, note,
// whiteboard, mind map). A quiet link button that carries a count; opening it lists what this item
// is linked to - one click jumps there - and "Link something" attaches anything else in the library
// (see contexts/ItemLinksContext). Arriving from a link also gets a "back to <where you came from>"
// chip beside the button, so hopping PDF -> video -> whiteboard in a presentation always has a way
// straight back.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./links.css";
import { createPortal } from "react-dom";
import { IoClose, IoSearch } from "react-icons/io5";
import { TbArrowBackUp, TbBinaryTree2, TbFile, TbFileTypePdf, TbLink, TbLinkPlus, TbMusic, TbNotes, TbPhoto, TbPresentation, TbUnlink, TbVideo } from "react-icons/tb";
import { useItemLinks, type LinkCandidate } from "../../contexts/ItemLinksContext";
import { KIND_LABEL, type ItemRef, type ResolvedLink } from "../../utils/itemLinks";

type Family = ResolvedLink["family"];

const FAMILY_STYLE: Record<Family, { icon: React.ReactNode; tile: string }> = {
  video: { icon: <TbVideo size={15} />, tile: "bg-violet-500/12 text-violet-600 dark:text-violet-400" },
  audio: { icon: <TbMusic size={15} />, tile: "bg-pink-500/12 text-pink-600 dark:text-pink-400" },
  image: { icon: <TbPhoto size={15} />, tile: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" },
  pdf: { icon: <TbFileTypePdf size={15} />, tile: "bg-red-500/12 text-red-600 dark:text-red-400" },
  doc: { icon: <TbNotes size={15} />, tile: "bg-blue-500/12 text-blue-600 dark:text-blue-400" },
  whiteboard: { icon: <TbPresentation size={15} />, tile: "bg-amber-500/14 text-amber-600 dark:text-amber-400" },
  mindmap: { icon: <TbBinaryTree2 size={15} />, tile: "bg-teal-500/12 text-teal-600 dark:text-teal-400" },
  document: { icon: <TbFile size={15} />, tile: "bg-neutral-500/12 text-neutral-600 dark:text-neutral-300" },
  other: { icon: <TbFile size={15} />, tile: "bg-neutral-500/12 text-neutral-600 dark:text-neutral-300" },
};

const FILTERS: { id: "all" | Family; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pdf", label: "PDF" },
  { id: "video", label: "Video" },
  { id: "image", label: "Image" },
  { id: "whiteboard", label: "Whiteboard" },
  { id: "doc", label: "Notes" },
  { id: "mindmap", label: "Mind map" },
];

const Tile: React.FC<{ family: Family }> = ({ family }) => (
  <span className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${FAMILY_STYLE[family].tile}`}>{FAMILY_STYLE[family].icon}</span>
);

export type LinksControlVariant = "pill" | "header" | "player";
type Placement = "left" | "below" | "above";

interface LinksControlProps {
  self: ItemRef;
  title: string;
  variant?: LinksControlVariant;
  placement?: Placement;
}

const POPOVER_W = 296;

const LinksPopover: React.FC<{
  anchor: DOMRect;
  placement: Placement;
  api: NonNullable<ReturnType<typeof useItemLinks>>;
  onClose: () => void;
}> = ({ anchor, placement, api, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"list" | "pick">(api.items.length === 0 ? "pick" : "list");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | Family>("all");
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [busy, setBusy] = useState(false);

  // Placed from the button's rect, then nudged on-screen using the popover's measured size. The
  // player's control bar sits at the bottom, so "above" flips to "below" (and vice versa) when the
  // preferred side has no room.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const m = 10;
    let left: number;
    let top: number;
    if (placement === "left") {
      left = anchor.left - width - 10;
      top = anchor.top;
      if (left < m) left = anchor.right + 10;
    } else {
      left = anchor.right - width;
      const roomBelow = window.innerHeight - anchor.bottom - m;
      const roomAbove = anchor.top - m;
      const below = placement === "below" ? roomBelow >= height || roomBelow >= roomAbove : roomAbove < height && roomBelow > roomAbove;
      top = below ? anchor.bottom + 8 : anchor.top - height - 8;
    }
    left = Math.min(Math.max(m, left), window.innerWidth - width - m);
    top = Math.min(Math.max(m, top), window.innerHeight - height - m);
    setPos({ left, top });
  }, [anchor, placement, mode, api.items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (mode === "pick" && api.items.length > 0) setMode("list");
      else onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [mode, api.items.length, onClose]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return api.candidates
      .filter((c) => (filter === "all" || c.family === filter) && (!q || c.title.toLowerCase().includes(q)))
      .slice(0, 60);
  }, [api.candidates, query, filter]);

  const attach = async (c: LinkCandidate) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.link(c.ref);
      setQuery("");
      setMode("list");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Linked items"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: POPOVER_W }}
      className={`fixed z-[1000] rounded-2xl bg-white/90 dark:bg-neutral-900/90 backdrop-blur-2xl shadow-[0_18px_50px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.06] dark:ring-white/[0.1] text-neutral-800 dark:text-neutral-100 overflow-hidden ${pos ? "linksPop" : "opacity-0"}`}
    >
      {mode === "list" ? (
        <>
          <div className="px-3.5 pt-3 pb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wide uppercase text-neutral-400 dark:text-neutral-500">Linked · {api.items.length}</span>
          </div>
          {api.backTo && (
            <button
              type="button"
              onClick={() => {
                onClose();
                api.openBack();
              }}
              className="mx-2 mb-1 w-[calc(100%-1rem)] flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs text-blue-600 dark:text-blue-400 bg-blue-500/[0.07] hover:bg-blue-500/[0.13] transition-colors"
            >
              <TbArrowBackUp size={15} className="shrink-0" />
              <span className="truncate">Back to {api.backTo.title}</span>
            </button>
          )}
          <ul className="max-h-72 overflow-y-auto px-2 pb-1 overscroll-contain">
            {api.items.map((item) => (
              <li key={item.key} className="group relative">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    api.openItem(item);
                  }}
                  className="w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-xl text-left hover:bg-black/[0.045] dark:hover:bg-white/[0.07] transition-colors"
                >
                  <Tile family={item.family} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium truncate pr-6">{item.title}</span>
                    <span className="block text-[11px] text-neutral-400 dark:text-neutral-500">{KIND_LABEL[item.family]}</span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Unlink ${item.title}`}
                  data-tip="Unlink"
                  onClick={() => void api.unlink(item)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 text-neutral-400 hover:text-red-500 hover:bg-red-500/10 transition-[opacity,color,background-color]"
                >
                  <TbUnlink size={14} />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setMode("pick")}
            className="w-full flex items-center gap-2 px-3.5 py-2.5 text-[13px] font-medium text-blue-600 dark:text-blue-400 border-t border-black/[0.05] dark:border-white/[0.07] hover:bg-blue-500/[0.06] transition-colors"
          >
            <TbLinkPlus size={16} /> Link something…
          </button>
        </>
      ) : (
        <>
          <div className="px-3 pt-3 pb-2 flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 h-8 px-2.5 rounded-lg bg-black/[0.045] dark:bg-white/[0.07] focus-within:ring-1 focus-within:ring-blue-500">
              <IoSearch size={14} className="shrink-0 text-neutral-400" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search videos, PDFs, notes, boards…"
                className="w-full bg-transparent outline-none text-[13px] placeholder:text-neutral-400"
              />
            </div>
            {api.items.length > 0 && (
              <button type="button" aria-label="Back to linked items" onClick={() => setMode("list")} className="w-7 h-7 rounded-full flex items-center justify-center text-neutral-400 hover:bg-black/[0.06] dark:hover:bg-white/10">
                <IoClose size={15} />
              </button>
            )}
          </div>
          <div className="px-3 pb-2 flex gap-1 overflow-x-auto linksScroll">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`shrink-0 px-2 h-6 rounded-full text-[11px] font-medium transition-colors ${filter === f.id ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900" : "text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.06] dark:hover:bg-white/10"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <ul className="max-h-64 overflow-y-auto px-2 pb-2 overscroll-contain">
            {shown.length === 0 ? (
              <li className="px-2 py-4 text-center text-xs text-neutral-400 dark:text-neutral-500">Nothing to link</li>
            ) : (
              shown.map((c) => (
                <li key={`${c.ref.kind}:${c.ref.id}`}>
                  <button type="button" onClick={() => void attach(c)} className="w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-xl text-left hover:bg-black/[0.045] dark:hover:bg-white/[0.07] transition-colors">
                    <Tile family={c.family} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium truncate">{c.title}</span>
                      <span className="block text-[11px] text-neutral-400 dark:text-neutral-500">{KIND_LABEL[c.family]}</span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </>
      )}
    </div>,
    document.body,
  );
};

const LinksControl: React.FC<LinksControlProps> = ({ self, title, variant = "header", placement }) => {
  const api = useItemLinks(self, title);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);

  // Pick up links made elsewhere (another viewer, the Docs header) whenever this item changes.
  const refresh = api?.refresh;
  useEffect(() => {
    void refresh?.();
  }, [refresh, self.kind, self.id]);

  if (!api) return null;
  const count = api.items.length;
  const place: Placement = placement ?? (variant === "pill" ? "left" : variant === "player" ? "above" : "below");

  const toggle = () => {
    if (anchor) return close();
    void api.refresh();
    if (btnRef.current) setAnchor(btnRef.current.getBoundingClientRect());
  };

  const label = count > 0 ? `${count} linked item${count === 1 ? "" : "s"}` : "Link to a video, PDF, note or whiteboard";
  const base = "relative shrink-0 flex items-center justify-center transition-[background-color,color,transform] duration-150 active:scale-90";
  const cls =
    variant === "pill"
      ? `${base} w-6 h-6 rounded-full ${anchor || count > 0 ? "text-blue-600 dark:text-blue-400" : "text-neutral-500 dark:text-neutral-400"} ${anchor ? "bg-blue-500/10" : "hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"}`
      : variant === "player"
        ? `${base} w-7 h-7 rounded-md ${anchor ? "bg-white/25" : "bg-white/10 hover:bg-white/20"} text-white`
        : `${base} w-8 h-8 rounded-full ${anchor ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" : count > 0 ? "text-blue-600 dark:text-blue-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]" : "text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"}`;

  const backChipCls =
    variant === "player"
      ? "bg-white/10 hover:bg-white/20 text-white"
      : "bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl ring-1 ring-black/[0.05] dark:ring-white/[0.08] text-blue-600 dark:text-blue-400 hover:bg-white dark:hover:bg-neutral-800";

  return (
    <>
      {api.backTo && !anchor && variant !== "pill" && (
        <button
          type="button"
          data-tip={`Back to ${api.backTo.title}`}
          onClick={api.openBack}
          className={`linksPop shrink-0 max-w-[11rem] flex items-center gap-1 h-7 px-2 rounded-full text-[11px] font-medium transition-colors ${backChipCls}`}
        >
          <TbArrowBackUp size={13} className="shrink-0" />
          <span className="truncate">{api.backTo.title}</span>
        </button>
      )}
      <button ref={btnRef} type="button" data-tip={label} data-tip-side={place === "left" ? "left" : undefined} aria-label={label} aria-expanded={!!anchor} onClick={toggle} className={cls}>
        <TbLink size={variant === "pill" ? 14 : variant === "player" ? 15 : 18} />
        {count > 0 && (
          <span key={count} className="linksPop absolute -top-1 -right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-blue-600 text-white text-[9px] font-bold leading-[15px] text-center tabular-nums ring-2 ring-white dark:ring-neutral-900">
            {count}
          </span>
        )}
      </button>
      {anchor && <LinksPopover anchor={anchor} placement={place} api={api} onClose={close} />}
    </>
  );
};

export default LinksControl;
