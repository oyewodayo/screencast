// components/video/StagePanelParts.tsx
//
// The small controls the Stage panels share - sections, segmented choices, switches, icon buttons -
// and the scene ink swatches, so every part of the scene panel looks and behaves the same.
import React from "react";

export const Section: React.FC<{ title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }> = ({ title, aside, children }) => (
  <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2 min-h-[20px]">
      <span className="flex-1 min-w-0 truncate text-[10px] font-medium uppercase tracking-wider text-white/40">{title}</span>
      {aside}
    </div>
    {children}
  </div>
);

// One choice of a few, as a row of pressed/unpressed buttons.
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: React.ReactNode; title?: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-0.5 rounded-lg bg-white/[0.06] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`flex-1 h-7 flex items-center justify-center gap-1 rounded-md text-[11px] transition-colors ${o.value === value ? "bg-teal-500 text-white shadow-sm" : "text-white/65 hover:text-white hover:bg-white/10"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const Toggle: React.FC<{ label: React.ReactNode; value: boolean; onChange: (v: boolean) => void; title?: string }> = ({ label, value, onChange, title }) => (
  <button type="button" role="switch" aria-checked={value} title={title} onClick={() => onChange(!value)} className="flex items-center gap-2 py-0.5 text-left text-[11px] text-white/70 hover:text-white">
    <span className="flex-1">{label}</span>
    <span className={`relative w-7 h-4 rounded-full transition-colors ${value ? "bg-teal-500" : "bg-white/15"}`}>
      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-[left] ${value ? "left-3.5" : "left-0.5"}`} />
    </span>
  </button>
);

export const IconButton: React.FC<{ title: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }> = ({ title, onClick, disabled, danger, children }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    disabled={disabled}
    onClick={onClick}
    className={`w-6 h-6 flex items-center justify-center rounded-md text-white/50 disabled:opacity-30 disabled:pointer-events-none ${danger ? "hover:text-red-300 hover:bg-red-500/15" : "hover:text-white hover:bg-white/10"}`}
  >
    {children}
  </button>
);

export const STAGE_INKS = ["#111111", "#9a9a9a", "#ffffff", "#7a1f3d", "#2fbf5b", "#ef4444", "#3b82f6", "#f59e0b"];
export const field = "w-full rounded-md bg-black/30 ring-1 ring-white/10 focus:ring-teal-400 px-2 py-1.5 text-[12px] text-white outline-none placeholder:text-white/30";
