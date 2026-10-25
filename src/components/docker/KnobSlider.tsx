// components/docker/KnobSlider.tsx
//
// The audio panels' control: a slim slider with a small digital knob beside it - an LED ring like a
// hardware encoder's, lit from its zero (the centre for a +/- control such as EQ gain, balance or
// trim; the bottom otherwise) round to the value. The ring follows the value on a short spring, so
// it sweeps rather than jumps whether the slider, the knob or an undo moved it.
//
// The knob is a control too, the way one on a desk is: drag up/down (Shift for fine), scroll, or
// double-click to reset. The slider stays a native range input - keyboard, focus and screen
// readers keep working.
import React, { useEffect, useRef, useState } from "react";

interface KnobSliderProps {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  // What double-click returns to (the slider's and the knob's); none = no reset.
  resetTo?: number;
  tone?: "teal" | "amber";
  title?: string;
}

const SEGMENTS = 15;
const SWEEP = 270; // degrees, gap at the bottom
const START = 135; // degrees clockwise from 3 o'clock - the knob's minimum, bottom-left
const SIZE = 22;
const TONES = { teal: "45,212,191", amber: "252,211,77" };

const angleOf = (fraction: number) => START + fraction * SWEEP;
const polar = (deg: number, r: number) => {
  const rad = (deg * Math.PI) / 180;
  return [SIZE / 2 + r * Math.cos(rad), SIZE / 2 + r * Math.sin(rad)];
};

const KnobSlider: React.FC<KnobSliderProps> = ({ min, max, step, value, onChange, resetTo, tone = "teal", title }) => {
  const span = max - min || 1;
  const fraction = Math.max(0, Math.min(1, (value - min) / span));
  // A +/- control lights from its zero; anything else from its minimum.
  const origin = min < 0 && max > 0 ? (0 - min) / span : 0;

  // The ring's own position, easing toward the value.
  const [shown, setShown] = useState(fraction);
  const shownRef = useRef(fraction);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const d = fraction - shownRef.current;
      shownRef.current = Math.abs(d) < 0.002 ? fraction : shownRef.current + d * 0.3;
      setShown(shownRef.current);
      if (shownRef.current !== fraction) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fraction]);

  const snap = (v: number) => {
    const s = Math.round((v - min) / step) * step + min;
    return Math.max(min, Math.min(max, Number(s.toFixed(6))));
  };
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Knob drag: 140 px of travel covers the range (ten times that with Shift).
  const dragRef = useRef<{ y: number; from: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { y: e.clientY, from: valueRef.current };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const travel = e.shiftKey ? 1400 : 140;
    const next = snap(d.from + ((d.y - e.clientY) / travel) * span);
    if (next !== valueRef.current) onChangeRef.current(next);
  };
  const endDrag = () => {
    dragRef.current = null;
  };
  // Scroll: one step per notch (a non-passive listener, so the panel doesn't scroll instead).
  const knobRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = knobRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const next = snap(valueRef.current + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 1 : Math.max(1, Math.round(span / step / 50))));
      if (next !== valueRef.current) onChangeRef.current(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, step]);

  const rgb = TONES[tone];
  const lo = Math.min(origin, shown);
  const hi = Math.max(origin, shown);
  const [px, py] = polar(angleOf(shown), SIZE / 2 - 6.5);

  return (
    <span className="flex-1 min-w-0 flex items-center gap-1.5" title={title}>
      <svg
        ref={knobRef}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="shrink-0 cursor-ns-resize touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => resetTo !== undefined && onChange(resetTo)}
        aria-hidden
      >
        {Array.from({ length: SEGMENTS }, (_, i) => {
          const f = i / (SEGMENTS - 1);
          const lit = f >= lo - 1e-6 && f <= hi + 1e-6;
          const [x1, y1] = polar(angleOf(f), SIZE / 2 - 1);
          const [x2, y2] = polar(angleOf(f), SIZE / 2 - 3.5);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              strokeLinecap="round"
              strokeWidth={1.6}
              stroke={lit ? `rgb(${rgb})` : "rgba(255,255,255,0.14)"}
              style={lit ? { filter: `drop-shadow(0 0 1.5px rgba(${rgb},0.9))` } : undefined}
            />
          );
        })}
        <circle cx={SIZE / 2} cy={SIZE / 2} r={SIZE / 2 - 5} fill="url(#knob-face)" stroke="rgba(255,255,255,0.12)" strokeWidth={0.75} />
        <line x1={SIZE / 2} y1={SIZE / 2} x2={px} y2={py} stroke={`rgb(${rgb})`} strokeWidth={1.5} strokeLinecap="round" />
        <defs>
          <radialGradient id="knob-face" cx="40%" cy="35%" r="70%">
            <stop offset="0%" stopColor="rgb(82,82,91)" />
            <stop offset="100%" stopColor="rgb(24,24,27)" />
          </radialGradient>
        </defs>
      </svg>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => resetTo !== undefined && onChange(resetTo)}
        className={`studio-range studio-range-${tone} flex-1 min-w-0`}
        style={{ "--fill": `${(fraction * 100).toFixed(2)}%`, "--origin": `${(origin * 100).toFixed(2)}%` } as React.CSSProperties}
      />
    </span>
  );
};

export default KnobSlider;
