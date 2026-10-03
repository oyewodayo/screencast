// SnipOverlay.tsx
//
// The screenshot picker (commands/snip.rs): a borderless window over every monitor showing the
// desktop frozen at the moment Screenshot was pressed. Drag to capture an area, click to capture
// the window under the cursor, or switch to Screen and click a monitor. Whatever's picked is
// cropped from the frozen pixels by the backend, saved, and copied to the clipboard.
//
// The page loads the frozen image itself (on mount, and on every "snip-armed") and only then shows
// its window, so there's never a black frame between Briefcast hiding and the picker appearing.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PhysicalPosition, PhysicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { IoClose, IoCopyOutline, IoCropOutline, IoDesktopOutline, IoTimerOutline } from "react-icons/io5";

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
interface SnipInfo {
    width: number;
    height: number;
    origin_x: number;
    origin_y: number;
    windows: { title: string; rect: Rect }[];
    monitors: Rect[];
    primary: number;
}

type Mode = "area" | "screen";
type Format = "png" | "jpeg";

const PREFS_KEY = "briefcast.snip";
const loadPrefs = (): { format: Format; copy: boolean } => {
    try {
        const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
        return { format: p.format === "jpeg" ? "jpeg" : "png", copy: p.copy !== false };
    } catch {
        return { format: "png", copy: true };
    }
};

// "Screenshot 2026-10-02 at 21.38.19" - sorts by time and reads naturally in the gallery.
const fileNameNow = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `Screenshot ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};

const contains = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;

// A drag shorter than this is a click (pick the window), not an area.
const DRAG_THRESHOLD = 4;

const SnipOverlay = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [info, setInfo] = useState<SnipInfo | null>(null);
    const [mode, setMode] = useState<Mode>("area");
    const [prefs, setPrefs] = useState(loadPrefs);
    const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
    const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
    const [busy, setBusy] = useState(false);
    const [delayOpen, setDelayOpen] = useState(false);
    const infoRef = useRef<SnipInfo | null>(null);

    // Physical pixels of the frozen image per CSS pixel of this window - re-read on resize, since
    // the window is sized to the desktop only once a screenshot starts.
    const [viewWidth, setViewWidth] = useState(window.innerWidth);
    useEffect(() => {
        const onResize = () => setViewWidth(window.innerWidth);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);
    const scale = info ? info.width / viewWidth : 1;

    const load = useCallback(async () => {
        setDrag(null);
        setBusy(false);
        setDelayOpen(false);
        const next = await invoke<SnipInfo | null>("snip_info");
        if (!next) return;
        const bytes = await invoke<ArrayBuffer>("snip_frame");
        const canvas = canvasRef.current;
        if (!canvas || bytes.byteLength !== next.width * next.height * 4) return;
        canvas.width = next.width;
        canvas.height = next.height;
        canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(bytes), next.width, next.height), 0, 0);
        // Cover the whole virtual desktop (every monitor), then wait for the page to see its new
        // size before showing, so pointer positions map onto the right pixels from the first move.
        const win = getCurrentWindow();
        await win.setPosition(new PhysicalPosition(next.origin_x, next.origin_y));
        await win.setSize(new PhysicalSize(next.width, next.height));
        await new Promise<void>((resolve) => {
            const settled = () => Math.abs(window.innerWidth * window.devicePixelRatio - next.width) < 2;
            if (settled()) return resolve();
            const done = () => {
                window.removeEventListener("resize", check);
                clearTimeout(timer);
                resolve();
            };
            const check = () => settled() && done();
            window.addEventListener("resize", check);
            const timer = setTimeout(done, 400);
        });
        setViewWidth(window.innerWidth);
        infoRef.current = next;
        setInfo(next);
        await win.show();
        await win.setFocus();
    }, []);

    useEffect(() => {
        void load();
        const unlisten = listen("snip-armed", () => void load());
        // Alt+F4 would destroy this pre-declared window for the session - cancel instead.
        const unlistenClose = getCurrentWindow().onCloseRequested((e) => {
            e.preventDefault();
            reset();
            void invoke("snip_cancel");
        });
        return () => {
            unlisten.then((fn) => fn());
            unlistenClose.then((fn) => fn());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]);

    useEffect(() => {
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        } catch {
            // Best effort.
        }
    }, [prefs]);

    // Clears the picture so the next screenshot never flashes this one.
    const reset = () => {
        infoRef.current = null;
        setInfo(null);
        setDrag(null);
        const canvas = canvasRef.current;
        if (canvas) {
            canvas.width = 1;
            canvas.height = 1;
        }
    };

    const finish = async (rect: Rect) => {
        if (busy || rect.width < 1 || rect.height < 1) return;
        setBusy(true);
        try {
            await invoke("snip_finish", {
                selection: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                },
                format: prefs.format,
                fileName: fileNameNow(),
                copy: prefs.copy,
            });
        } catch (err) {
            console.error("Screenshot failed:", err);
        } finally {
            reset();
        }
    };

    const cancel = async () => {
        reset();
        await invoke("snip_cancel");
    };

    const retakeWithDelay = async (seconds: number) => {
        reset();
        await invoke("snip_begin", { delayMs: seconds * 1000 });
    };

    // What a click right now would capture.
    const hovered = (() => {
        if (!info || !pointer) return null;
        const screen = info.monitors.find((m) => contains(m, pointer.x, pointer.y)) ?? null;
        if (mode === "screen") return screen;
        // The desktop itself ("Program Manager", spanning every monitor) isn't a window anyone
        // means to capture - clicking it takes the screen under the cursor instead.
        const win = info.windows.find((w) => w.title !== "Program Manager" && contains(w.rect, pointer.x, pointer.y));
        return win?.rect ?? screen;
    })();

    const dragRect: Rect | null = drag
        ? {
              x: Math.min(drag.x0, drag.x1),
              y: Math.min(drag.y0, drag.y1),
              width: Math.abs(drag.x1 - drag.x0),
              height: Math.abs(drag.y1 - drag.y0),
          }
        : null;
    const isDragging = !!dragRect && (dragRect.width > DRAG_THRESHOLD * scale || dragRect.height > DRAG_THRESHOLD * scale);
    const highlight = isDragging ? dragRect : hovered;

    const toPhysical = (e: React.PointerEvent) => ({ x: e.clientX * scale, y: e.clientY * scale });

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") void cancel();
            if (e.key === "Enter" && hovered) void finish(hovered);
            // F: the screen under the cursor; A: area/window mode; S: screen mode.
            if (e.key.toLowerCase() === "f" && infoRef.current && pointer) {
                const m = infoRef.current.monitors.find((r) => contains(r, pointer.x, pointer.y));
                if (m) void finish(m);
            }
            if (e.key.toLowerCase() === "a") setMode("area");
            if (e.key.toLowerCase() === "s") setMode("screen");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    const toCss = (r: Rect) => ({ left: r.x / scale, top: r.y / scale, width: r.width / scale, height: r.height / scale });
    const toolbarMonitor = info ? info.monitors[info.primary] ?? info.monitors[0] : null;

    return (
        <div className="fixed inset-0 overflow-hidden select-none bg-black" style={{ cursor: "crosshair" }}>
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

            {info && (
                <div
                    className="absolute inset-0"
                    onPointerMove={(e) => {
                        const p = toPhysical(e);
                        setPointer(p);
                        if (drag) setDrag({ ...drag, x1: p.x, y1: p.y });
                    }}
                    onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        (e.target as Element).setPointerCapture(e.pointerId);
                        const p = toPhysical(e);
                        if (mode === "area") setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
                    }}
                    onPointerUp={(e) => {
                        if (e.button !== 0) return;
                        if (isDragging && dragRect) void finish(dragRect);
                        else if (hovered) void finish(hovered);
                        setDrag(null);
                    }}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        void cancel();
                    }}
                >
                    {/* Everything outside the highlight is dimmed; the highlight itself shows the
                        frozen screen at full brightness. */}
                    {highlight ? (
                        <div
                            className={`absolute pointer-events-none ${isDragging ? "border-2 border-white" : "border-[3px] border-blue-500"}`}
                            style={{ ...toCss(highlight), boxShadow: "0 0 0 100000px rgba(0,0,0,0.45)" }}
                        >
                            <span className="absolute left-0 -top-7 px-2 py-0.5 rounded-md bg-neutral-900/90 text-white text-xs font-medium tabular-nums whitespace-nowrap">
                                {Math.round(highlight.width)} × {Math.round(highlight.height)}
                            </span>
                        </div>
                    ) : (
                        <div className="absolute inset-0 bg-black/45 pointer-events-none" />
                    )}
                </div>
            )}

            {info && toolbarMonitor && (
                <div
                    className="absolute flex justify-center pointer-events-none"
                    style={{ left: toolbarMonitor.x / scale, top: toolbarMonitor.y / scale + 20, width: toolbarMonitor.width / scale }}
                >
                    <div
                        className="pointer-events-auto flex items-center gap-1 p-1.5 rounded-2xl bg-white/95 dark:bg-neutral-900/95 text-neutral-800 dark:text-neutral-100 shadow-2xl ring-1 ring-black/10 dark:ring-white/10 backdrop-blur"
                        style={{ cursor: "default" }}
                        onPointerDown={(e) => e.stopPropagation()}
                    >
                        {(
                            [
                                ["area", "Area or window", <IoCropOutline key="a" size={17} />, "Drag an area, or click a window (A)"],
                                ["screen", "Screen", <IoDesktopOutline key="s" size={17} />, "Click a screen (S)"],
                            ] as const
                        ).map(([value, label, icon, tip]) => (
                            <button
                                key={value}
                                type="button"
                                data-tip={tip}
                                onClick={() => setMode(value)}
                                className={`flex items-center gap-2 h-9 px-3 rounded-xl text-[13px] font-medium transition-colors ${
                                    mode === value ? "bg-blue-500 text-white" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                                }`}
                            >
                                {icon}
                                {label}
                            </button>
                        ))}

                        <span className="w-px h-6 mx-1 bg-neutral-200 dark:bg-neutral-700" />

                        <div className="relative">
                            <button
                                type="button"
                                data-tip="Retake after a delay - to open a menu first"
                                onClick={() => setDelayOpen((o) => !o)}
                                className="flex items-center gap-1.5 h-9 px-3 rounded-xl text-[13px] font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800"
                            >
                                <IoTimerOutline size={17} />
                                Delay
                            </button>
                            {delayOpen && (
                                <div className="absolute left-0 top-full mt-2 p-1.5 rounded-2xl bg-white dark:bg-neutral-900 shadow-xl ring-1 ring-black/10 dark:ring-white/10 min-w-[150px]">
                                    {[3, 5, 10].map((s) => (
                                        <button
                                            key={s}
                                            type="button"
                                            onClick={() => void retakeWithDelay(s)}
                                            className="w-full text-left px-3 py-2 rounded-xl text-[13px] hover:bg-neutral-100 dark:hover:bg-neutral-800"
                                        >
                                            In {s} seconds
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <button
                            type="button"
                            data-tip="Save as PNG (sharp text) or JPG (smaller photos)"
                            onClick={() => setPrefs((p) => ({ ...p, format: p.format === "png" ? "jpeg" : "png" }))}
                            className="h-9 px-3 rounded-xl text-[12px] font-semibold uppercase tracking-wide hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        >
                            {prefs.format === "png" ? "PNG" : "JPG"}
                        </button>

                        <button
                            type="button"
                            role="switch"
                            aria-checked={prefs.copy}
                            data-tip="Also copy the screenshot, ready to paste"
                            onClick={() => setPrefs((p) => ({ ...p, copy: !p.copy }))}
                            className={`flex items-center gap-1.5 h-9 px-3 rounded-xl text-[13px] font-medium transition-colors ${
                                prefs.copy ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                            }`}
                        >
                            <IoCopyOutline size={16} />
                            Copy
                        </button>

                        <span className="w-px h-6 mx-1 bg-neutral-200 dark:bg-neutral-700" />

                        <button
                            type="button"
                            data-tip="Cancel"
                            data-tip-kbd="Esc"
                            onClick={() => void cancel()}
                            className="flex items-center justify-center w-9 h-9 rounded-xl hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        >
                            <IoClose size={18} />
                        </button>
                    </div>
                </div>
            )}

            {info && toolbarMonitor && !drag && (
                <div
                    className="absolute flex justify-center pointer-events-none"
                    style={{ left: toolbarMonitor.x / scale, top: toolbarMonitor.y / scale + 76, width: toolbarMonitor.width / scale }}
                >
                    <span className="px-3 py-1.5 rounded-full bg-neutral-900/80 text-white text-xs">
                        {mode === "area"
                            ? "Drag to capture an area, or click a window · F for the whole screen · Esc to cancel"
                            : "Click a screen to capture it · Esc to cancel"}
                    </span>
                </div>
            )}
        </div>
    );
};

export default SnipOverlay;
