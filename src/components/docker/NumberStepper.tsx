// components/docker/NumberStepper.tsx
//
// A numeric field editable two ways at once: type a value directly, or click the up/down
// steppers - shared by SpeedPopover (speed/duration) and NoiseReductionPopover (strength), any
// popover pairing a Slider with a precise numeric readout. Shows a formatted (suffixed, fixed-
// precision) string while not focused, and the raw editable number while it is, so a mid-edit
// value like "1." isn't fought over by re-formatting on every keystroke.
import React, { useState } from "react";
import { IoChevronDown, IoChevronUp } from "react-icons/io5";

const NumberStepper: React.FC<{
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
  suffix: string;
  onChange: (next: number) => void;
}> = ({ value, min, max, step, decimals, suffix, onChange }) => {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) onChange(Math.max(min, Math.min(max, parsed)));
    setDraft(null);
  };
  const nudge = (delta: number) => onChange(Math.max(min, Math.min(max, value + delta)));

  return (
    <div className="flex items-center shrink-0 rounded bg-black/40 ring-1 ring-white/10 overflow-hidden">
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? `${value.toFixed(decimals)}${suffix}`}
        onFocus={() => setDraft(value.toFixed(decimals))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setDraft(null);
        }}
        className="w-14 bg-transparent pl-1.5 py-1 text-[11px] text-right tabular-nums text-white/90 outline-none"
      />
      <div className="flex flex-col border-l border-white/10">
        <button
          type="button"
          tabIndex={-1}
          title="Increase"
          onClick={() => nudge(step)}
          className="px-1 h-3.5 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10"
        >
          <IoChevronUp size={9} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          title="Decrease"
          onClick={() => nudge(-step)}
          className="px-1 h-3.5 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 border-t border-white/10"
        >
          <IoChevronDown size={9} />
        </button>
      </div>
    </div>
  );
};

export default NumberStepper;
