// TooltipLayer.tsx
//
// App-wide tooltips. Native `title` tooltips are drawn by Windows - plain, unthemed, slow to
// appear and placed wherever the cursor happens to be. Instead, any element with a `data-tip`
// attribute gets a styled bubble from this one layer (mounted once per window, in App.tsx):
//
//   <button data-tip="Refresh devices">            plain tip
//   <button data-tip="Cut to camera" data-tip-kbd="1">   with a shortcut shown as a key
//
// One listener on the document rather than a wrapper per element, so adding a tip is just an
// attribute. The first tip waits a moment (no flicker while the mouse crosses the UI); moving
// straight on to a neighbouring control shows the next one at once, as in native toolbars.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY_MS = 450;
// After a tip closes, the next one within this window shows immediately.
const WARM_MS = 400;
const GAP = 8;
const EDGE = 8;

interface Tip {
    text: string;
    kbd: string | null;
    rect: DOMRect;
}

const tipTarget = (node: EventTarget | null): HTMLElement | null =>
    node instanceof Element ? (node.closest("[data-tip]") as HTMLElement | null) : null;

const TooltipLayer = () => {
    const [tip, setTip] = useState<Tip | null>(null);
    const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
    const [below, setBelow] = useState(false);
    const bubbleRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let current: HTMLElement | null = null;
        let timer: number | undefined;
        let lastHidden = 0;

        const show = (el: HTMLElement) => {
            const text = el.getAttribute("data-tip");
            if (!text || !el.isConnected) return;
            setTip({ text, kbd: el.getAttribute("data-tip-kbd"), rect: el.getBoundingClientRect() });
        };

        const hide = () => {
            window.clearTimeout(timer);
            if (current) lastHidden = Date.now();
            current = null;
            setTip(null);
        };

        const onOver = (e: PointerEvent) => {
            const el = tipTarget(e.target);
            if (el === current) return;
            window.clearTimeout(timer);
            if (!el) {
                if (current) hide();
                return;
            }
            const warm = current !== null || Date.now() - lastHidden < WARM_MS;
            current = el;
            setTip(null);
            if (warm) show(el);
            else timer = window.setTimeout(() => current === el && show(el), SHOW_DELAY_MS);
        };

        const onOut = (e: PointerEvent) => {
            // Leaving the window entirely.
            if (!e.relatedTarget) hide();
        };

        document.addEventListener("pointerover", onOver, true);
        document.addEventListener("pointerout", onOut, true);
        // Anything that changes what's under the tip ends it.
        document.addEventListener("pointerdown", hide, true);
        document.addEventListener("keydown", hide, true);
        window.addEventListener("scroll", hide, true);
        window.addEventListener("blur", hide);
        return () => {
            window.clearTimeout(timer);
            document.removeEventListener("pointerover", onOver, true);
            document.removeEventListener("pointerout", onOut, true);
            document.removeEventListener("pointerdown", hide, true);
            document.removeEventListener("keydown", hide, true);
            window.removeEventListener("scroll", hide, true);
            window.removeEventListener("blur", hide);
        };
    }, []);

    // Centred above the element, flipped below when there's no room, and kept inside the window.
    useLayoutEffect(() => {
        if (!tip || !bubbleRef.current) return;
        const { width, height } = bubbleRef.current.getBoundingClientRect();
        const r = tip.rect;
        const flip = r.top - height - GAP < EDGE;
        const left = Math.max(EDGE, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - EDGE));
        const top = flip ? r.bottom + GAP : r.top - height - GAP;
        setBelow(flip);
        setStyle({ left, top, ["--arrow-x" as string]: `${r.left + r.width / 2 - left}px` });
    }, [tip]);

    if (!tip) return null;

    return createPortal(
        <div
            ref={bubbleRef}
            role="tooltip"
            style={{ position: "fixed", ...style }}
            className="z-[100] pointer-events-none max-w-[300px] px-3 py-2 rounded-xl bg-neutral-900/95 dark:bg-neutral-100/95 text-white dark:text-neutral-900 text-[12px] leading-snug shadow-lg shadow-black/20 backdrop-blur-sm animate-[tipIn_120ms_ease-out]"
        >
            <span className="flex items-start gap-2">
                <span className="min-w-0">{tip.text}</span>
                {tip.kbd && (
                    <span className="shrink-0 flex items-center gap-0.5">
                        {tip.kbd.split("+").map((k) => (
                            <kbd
                                key={k}
                                className="px-1.5 min-w-[18px] text-center rounded-md bg-white/15 dark:bg-black/10 text-[10px] font-mono font-semibold leading-[18px]"
                            >
                                {k}
                            </kbd>
                        ))}
                    </span>
                )}
            </span>
            {/* Arrow pointing at the element. */}
            <span
                className={`absolute w-2.5 h-2.5 rotate-45 bg-neutral-900/95 dark:bg-neutral-100/95 ${below ? "-top-1" : "-bottom-1"}`}
                style={{ left: "calc(var(--arrow-x) - 5px)" }}
            />
        </div>,
        document.body
    );
};

export default TooltipLayer;
