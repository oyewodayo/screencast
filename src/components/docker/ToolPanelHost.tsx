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
import React, { createContext, useContext } from "react";

export const ToolPanelHostContext = createContext<HTMLElement | null>(null);

export const useToolPanelHost = (): HTMLElement | null => useContext(ToolPanelHostContext);

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
