// components/docker/Slider.tsx
//
// A custom-drawn replacement for native <input type="range"> - built for SpeedPopover (whose
// native slider, being a flex-1 item with no min-w-0, was overflowing its popover: a flex item's
// default min-width is "auto" i.e. its own intrinsic content size, and a native range input's
// UA-stylesheet intrinsic width is wider than the room a w-64 popover actually has once the label
// and NumberStepper next to it are accounted for - it never had *reason* to shrink below that
// intrinsic size, hence the overflow), but drawn from scratch (not just a min-w-0 patch on the
// native element) so this app's controls have their own distinct feel instead of every browser's
// stock slider: a gradient fill, tick marks at meaningful reference points (this app's own preset
// values, not generic 10/20/30% marks), and a thumb that grows under the pointer.
import React, { useRef, useState } from "react";

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  // Reference points worth calling out on the track - SpeedPopover passes its own preset speeds
  // (0.5/1/1.5/2x) so the slider's ticks land exactly on the same values the preset buttons above
  // it jump to, not an arbitrary generic subdivision.
  marks?: readonly number[];
  onChange: (next: number) => void;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
// Steps the way a native range input does - round to the nearest step from `min`, not from 0, so
// a min that isn't itself a multiple of step (0.25 with a 0.05 step, here) still lands exactly on
// the same values typing/clicking a preset would produce, instead of drifting by a fraction of a
// step.
const snapToStep = (v: number, min: number, step: number) => min + Math.round((v - min) / step) * step;

const Slider: React.FC<SliderProps> = ({ value, min, max, step, marks, onChange }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const percent = ((clamp(value, min, max) - min) / (max - min)) * 100;

  const valueFromClientX = (clientX: number): number => {
    const rect = trackRef.current!.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return clamp(snapToStep(min + ratio * (max - min), min, step), min, max);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    onChange(valueFromClientX(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    onChange(valueFromClientX(e.clientX));
  };
  const onPointerUp = () => setDragging(false);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange(clamp(value + step, min, max));
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange(clamp(value - step, min, max));
    else if (e.key === "Home") onChange(min);
    else if (e.key === "End") onChange(max);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      className="relative flex-1 min-w-0 h-4 flex items-center cursor-pointer touch-none select-none outline-none"
    >
      <div className="absolute inset-x-0 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400"
          style={{ width: `${percent}%` }}
        />
      </div>
      {marks?.map((mark) => {
        const markPercent = ((clamp(mark, min, max) - min) / (max - min)) * 100;
        return (
          <div
            key={mark}
            className={`absolute top-1/2 -translate-y-1/2 w-px h-2 rounded-full transition-colors ${
              value >= mark ? "bg-white/70" : "bg-white/25"
            }`}
            style={{ left: `${markPercent}%` }}
          />
        );
      })}
      <div
        className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full bg-white shadow ring-2 ring-blue-400/70 transition-transform ${
          dragging ? "scale-125" : "hover:scale-110"
        }`}
        style={{ left: `${percent}%`, width: 12, height: 12 }}
      />
    </div>
  );
};

export default Slider;
