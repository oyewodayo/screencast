// components/CountdownOverlay.tsx
//
// The "countdown-overlay" window's page: the big number shown between pressing Record and capture
// starting. Purely a display - utils/recordingCountdown.ts owns the timing and sends each second
// here. A click anywhere cancels the recording.

import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { COUNTDOWN_CANCEL_EVENT, COUNTDOWN_TICK_EVENT, CountdownTick } from "../utils/recordingCountdown";

const RADIUS = 92;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const CountdownOverlay = () => {
  const [tick, setTick] = useState<CountdownTick>({ remaining: 0, total: 0 });

  useEffect(() => {
    const unlisten = listen<CountdownTick>(COUNTDOWN_TICK_EVENT, (e) => setTick(e.payload));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  if (tick.remaining <= 0) return null;

  return (
    <button
      type="button"
      onClick={() => void emit(COUNTDOWN_CANCEL_EVENT)}
      title="Click to cancel"
      className="fixed inset-0 flex items-center justify-center cursor-pointer select-none outline-none"
    >
      <div className="relative w-[204px] h-[204px] rounded-full bg-neutral-900/80 backdrop-blur-xl ring-1 ring-white/10 shadow-[0_12px_40px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center">
        {/* The ring drains over each second - keyed on the number so it restarts every tick. */}
        <svg key={tick.remaining} className="absolute inset-0 -rotate-90" viewBox="0 0 204 204">
          <circle cx="102" cy="102" r={RADIUS} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="5" />
          <circle
            cx="102"
            cy="102"
            r={RADIUS}
            fill="none"
            stroke="#ef4444"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            style={{ animation: "countdown-ring 1s linear forwards" }}
          />
        </svg>
        <span key={`n-${tick.remaining}`} className="text-white text-[84px] font-semibold leading-none tabular-nums" style={{ animation: "countdown-pop 0.35s ease-out" }}>
          {tick.remaining}
        </span>
        <span className="mt-2 text-[11px] font-medium tracking-wide text-white/55">Recording starts…</span>
        <span className="text-[10px] text-white/35">click to cancel</span>
      </div>
      <style>{`
        @keyframes countdown-ring { from { stroke-dashoffset: 0; } to { stroke-dashoffset: ${CIRCUMFERENCE}; } }
        @keyframes countdown-pop { from { transform: scale(1.35); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      `}</style>
    </button>
  );
};

export default CountdownOverlay;
