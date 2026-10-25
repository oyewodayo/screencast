// components/docker/ToolPanelHost.tsx
//
// Where the video editor's "settings" popovers (Clip effects, Speed, Reduce noise, audio overlay)
// render. Dashboard provides its sidebar's Tools tab element here while a video is being edited
// and the sidebar is open; those popovers then portal into it as docked panels instead of floating
// over the timeline - they stay open while you scrub or reselect clips, and don't cover the work.
// With no host (sidebar collapsed, or not editing a video) they fall back to the original floating
// popover, so every caller works either way.
//
// Quick one-shot actions (Trim silence, Auto zoom, View switch, Extract audio, track volume, Save
// options) deliberately stay floating: they're "find -> apply/cancel" steps best kept right next
// to the button that opened them.
import React, { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";

export const ToolPanelHostContext = createContext<HTMLElement | null>(null);

export const useToolPanelHost = (): HTMLElement | null => useContext(ToolPanelHostContext);

// Opens the sidebar on its Tools tab - for a floating control's "All settings", which then docks
// its full panel there. Null where there's no sidebar to open.
export const ToolPanelOpenContext = createContext<(() => void) | null>(null);
export const useOpenToolPanel = (): (() => void) | null => useContext(ToolPanelOpenContext);

// Shown in a docked/floating clip panel's header while a multi-selection is what it edits.
export const SelectionCountBadge: React.FC<{ count?: number }> = ({ count }) =>
  count && count > 1 ? (
    <span title={`Changes apply to all ${count} selected clips`} className="px-1.5 py-0.5 rounded-full text-[10px] font-medium text-blue-300 bg-blue-500/15">
      {count} clips
    </span>
  ) : null;

// Outer shell for a docked panel - fills the sidebar's width instead of a fixed popover width, and
// keeps the popovers' own dark styling (their controls are all white-on-dark) as a card.
export const DOCKED_PANEL_CLASS = "w-full rounded-lg bg-neutral-900 ring-1 ring-black/5 dark:ring-white/10 text-white/90 flex flex-col";

// Outside-click dismissal for a floating panel - deferred a couple of frames, so the click that
// opens the sidebar docks the panel (useDockSnap) instead of closing it. Clicks inside `selector`
// (the panel, the button that opened it) never close it. Docked panels don't dismiss at all.
export function useFloatingDismiss(selector: string, onClose: () => void, docked: boolean) {
  const dockedRef = useRef(docked);
  dockedRef.current = docked;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (docked) return;
    const openedAt = performance.now();
    const handle = (e: MouseEvent) => {
      // The click that opened this panel is still bubbling when it mounts - not a click outside it.
      if (e.timeStamp < openedAt) return;
      if (e.target instanceof Element && e.target.closest(selector)) return;
      // A click on something that's gone by now (the Music panel's "Add", which opens the next
      // panel as it closes) was handled by that thing - it isn't a click outside this panel.
      if (e.target instanceof Node && !e.target.isConnected) return;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!dockedRef.current) onCloseRef.current();
        })
      );
    };
    document.addEventListener("click", handle);
    return () => document.removeEventListener("click", handle);
  }, [docked, selector]);
}

// When a floating panel docks into the sidebar, it glides from where it was floating to its place
// there (a FLIP animation - the docked element is drawn at the old spot, then eased home).
export function useDockSnap(ref: React.RefObject<HTMLElement | null>, docked: boolean) {
  const floatingRect = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const from = floatingRect.current;
    if (!el || !docked || !from || typeof el.animate !== "function") return;
    floatingRect.current = null;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) + Math.abs(dy) < 4 || to.width === 0) return;
    el.animate(
      [
        { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width})`, boxShadow: "0 18px 40px rgba(0,0,0,0.45)" },
        { transformOrigin: "top left", transform: "none", boxShadow: "0 0 0 rgba(0,0,0,0)" },
      ],
      { duration: 300, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
    );
  }, [docked, ref]);
  // Remember where it floats (its position settles after the first layout, so every render).
  useEffect(() => {
    if (!docked && ref.current) floatingRect.current = ref.current.getBoundingClientRect();
  });
}
