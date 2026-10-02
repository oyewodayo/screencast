import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoCheckmark } from "react-icons/io5";

// The recording panel's dropdown menu. Replaces native <select> pop-ups, which Windows draws
// itself - unpadded, unthemed, and ignoring dark mode. The trigger is whatever the caller renders
// (`children`); this owns the menu: padded rows, a check on the current choice, keyboard
// navigation, and closing on outside click or Esc.
//
// Opens upward by default - the panel sits at the bottom of the window. The menu is portalled to
// <body> with fixed positioning, so the panel's own overflow scrolling can't clip it.

export interface DropdownOption {
    value: string;
    label: string;
    hint?: string;
}

interface DockerDropdownProps {
    value: string;
    options: DropdownOption[];
    onChange: (value: string) => void;
    disabled?: boolean;
    // Heading inside the menu, e.g. "Resolution".
    title?: string;
    align?: "left" | "right";
    menuClassName?: string;
    // The trigger's contents; it's wrapped in the button that opens the menu.
    children: React.ReactNode;
    triggerClassName?: string;
    triggerTitle?: string;
    emptyLabel?: string;
}

const DockerDropdown: React.FC<DockerDropdownProps> = ({
    value,
    options,
    onChange,
    disabled,
    title,
    align = "left",
    menuClassName = "",
    children,
    triggerClassName = "",
    triggerTitle,
    emptyLabel = "Nothing to choose",
}) => {
    const [open, setOpen] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const rootRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<React.CSSProperties>({ visibility: "hidden" });

    const openMenu = () => {
        if (disabled) return;
        setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
        setOpen(true);
    };

    // Above the trigger, or below it when there isn't room above; aligned to the trigger's edge,
    // and kept on screen.
    const place = () => {
        if (!rootRef.current || !listRef.current) return;
        const t = rootRef.current.getBoundingClientRect();
        const menuH = listRef.current.offsetHeight;
        const menuW = Math.max(listRef.current.offsetWidth, t.width);
        const below = t.top < menuH + 16;
        let left = align === "right" ? t.right - menuW : t.left;
        left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));
        setPos({
            position: "fixed",
            left,
            minWidth: t.width,
            ...(below ? { top: t.bottom + 8 } : { bottom: window.innerHeight - t.top + 8 }),
        });
    };

    useLayoutEffect(() => {
        if (!open) return;
        place();
        listRef.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (!rootRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
        };
        // The trigger moved out from under the menu - close rather than float detached.
        const onMove = (e: Event) => {
            if (!listRef.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        window.addEventListener("resize", onMove);
        window.addEventListener("scroll", onMove, true);
        return () => {
            document.removeEventListener("mousedown", onDown);
            window.removeEventListener("resize", onMove);
            window.removeEventListener("scroll", onMove, true);
        };
    }, [open]);

    // Keep the highlighted row in view while arrowing through a long list (microphones).
    useEffect(() => {
        if (!open) return;
        listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
    }, [highlight, open]);

    const choose = (v: string) => {
        onChange(v);
        setOpen(false);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        // Keys stay with the menu - the live display's 1-9 shortcuts mustn't also fire.
        e.stopPropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(options.length - 1, h + 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(0, h - 1));
        } else if (e.key === "Home") {
            e.preventDefault();
            setHighlight(0);
        } else if (e.key === "End") {
            e.preventDefault();
            setHighlight(options.length - 1);
        } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            const o = options[highlight];
            if (o) choose(o.value);
        } else if (e.key === "Tab") {
            setOpen(false);
        }
    };

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                disabled={disabled}
                title={triggerTitle}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => (open ? setOpen(false) : openMenu())}
                onKeyDown={(e) => {
                    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                        e.preventDefault();
                        openMenu();
                    }
                }}
                className={`${triggerClassName} ${open ? "ring-2 ring-blue-500/30 border-blue-500/50" : ""}`}
            >
                {children}
            </button>

            {open && createPortal(
                <div
                    ref={listRef}
                    role="listbox"
                    tabIndex={-1}
                    onKeyDown={onKeyDown}
                    style={pos}
                    className={`z-[60] w-max max-w-[min(360px,calc(100vw-32px))] max-h-72 overflow-y-auto p-1.5 rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white/95 dark:bg-neutral-900/95 backdrop-blur shadow-xl shadow-black/10 outline-none ${menuClassName}`}
                >
                    {title && (
                        <div className="px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                            {title}
                        </div>
                    )}
                    {options.length === 0 ? (
                        <div className="px-3 py-2 text-[13px] text-neutral-500">{emptyLabel}</div>
                    ) : (
                        options.map((o, i) => {
                            const selected = o.value === value;
                            return (
                                <div
                                    key={o.value}
                                    role="option"
                                    aria-selected={selected}
                                    data-index={i}
                                    onMouseEnter={() => setHighlight(i)}
                                    onClick={() => choose(o.value)}
                                    className={`flex items-center gap-3 px-3 py-2 rounded-xl text-[13px] cursor-pointer select-none ${
                                        i === highlight ? "bg-neutral-100 dark:bg-neutral-800" : ""
                                    } ${selected ? "font-semibold text-neutral-900 dark:text-white" : "text-neutral-700 dark:text-neutral-200"}`}
                                >
                                    <span className="flex-1 min-w-0 truncate">{o.label}</span>
                                    {o.hint && <span className="shrink-0 text-[11px] font-normal text-neutral-400">{o.hint}</span>}
                                    <IoCheckmark className={`shrink-0 text-blue-500 ${selected ? "" : "invisible"}`} size={15} />
                                </div>
                            );
                        })
                    )}
                </div>,
                document.body
            )}
        </div>
    );
};

export default DockerDropdown;
