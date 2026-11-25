// components/whiteboard/WhiteboardPresentationBar.tsx
//
// Broadcast-ready floating bottom control bar for Whiteboard Presentation Mode.
// Steps smoothly across ordered Containment Frames (artboards) with live Laser Pointer and
// Pen annotation toggles — ideal for Briefcast screen recordings and live technical walkthroughs.

import React, { memo, useState } from "react";
import {
  IoChevronBack,
  IoChevronForward,
  IoChevronUp,
  IoClose,
  IoPencilOutline,
} from "react-icons/io5";

export interface PresentationSlide {
  id: string;
  label: string;
}

interface WhiteboardPresentationBarProps {
  slides: PresentationSlide[];
  activeIndex: number;
  laserArmed: boolean;
  penArmed: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJump: (index: number) => void;
  onToggleLaser: () => void;
  onTogglePen: () => void;
  onExit: () => void;
}

const WhiteboardPresentationBar: React.FC<WhiteboardPresentationBarProps> = memo(
  ({
    slides,
    activeIndex,
    laserArmed,
    penArmed,
    onPrev,
    onNext,
    onJump,
    onToggleLaser,
    onTogglePen,
    onExit,
  }) => {
    const [jumpOpen, setJumpOpen] = useState(false);
    const current = slides[activeIndex];

    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 px-2 py-1.5 rounded-full bg-neutral-900 text-white border border-neutral-700/80 shadow-2xl select-none"
      >
        <button
          type="button"
          onClick={onPrev}
          disabled={slides.length <= 1 || activeIndex <= 0}
          title="Previous frame (←)"
          className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 disabled:opacity-35 transition-colors"
        >
          <IoChevronBack size={15} />
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setJumpOpen((v) => !v)}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-full hover:bg-white/10 text-xs font-medium transition-colors max-w-[220px]"
            title="Jump to slide"
          >
            <span className="tabular-nums text-neutral-400">
              {slides.length > 0 ? `${activeIndex + 1}/${slides.length}` : "1/1"}
            </span>
            <span className="truncate">{current?.label || "Full Canvas"}</span>
            {slides.length > 1 && <IoChevronUp size={11} className="opacity-60 shrink-0" />}
          </button>

          {jumpOpen && slides.length > 1 && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 max-h-64 overflow-y-auto rounded-xl bg-neutral-900 border border-neutral-700 shadow-2xl py-1 text-xs">
              {slides.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    onJump(idx);
                    setJumpOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    idx === activeIndex ? "bg-blue-600 text-white" : "text-neutral-200 hover:bg-white/10"
                  }`}
                >
                  <span className="tabular-nums text-[10px] opacity-65 w-4">{idx + 1}</span>
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onNext}
          disabled={slides.length <= 1 || activeIndex >= slides.length - 1}
          title="Next frame (→ or Space)"
          className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 disabled:opacity-35 transition-colors"
        >
          <IoChevronForward size={15} />
        </button>

        <div className="w-px h-4 bg-neutral-700 mx-1" />

        <button
          type="button"
          onClick={onToggleLaser}
          title="Laser pointer (L)"
          className={`flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium transition-colors ${
            laserArmed ? "bg-red-500 text-white" : "text-neutral-300 hover:bg-white/10"
          }`}
        >
          <span className="w-2 h-2 rounded-full bg-red-400" />
          <span>Laser</span>
        </button>

        <button
          type="button"
          onClick={onTogglePen}
          title="Annotate with Pen (P)"
          className={`flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium transition-colors ${
            penArmed ? "bg-blue-600 text-white" : "text-neutral-300 hover:bg-white/10"
          }`}
        >
          <IoPencilOutline size={13} />
          <span>Draw</span>
        </button>

        <div className="w-px h-4 bg-neutral-700 mx-1" />

        <button
          type="button"
          onClick={onExit}
          title="Exit presentation (Esc)"
          className="flex items-center gap-1 h-7 px-2.5 rounded-full text-xs font-medium text-neutral-300 hover:bg-white/10 hover:text-white transition-colors"
        >
          <IoClose size={14} />
          <span>Exit</span>
        </button>
      </div>
    );
  }
);

WhiteboardPresentationBar.displayName = "WhiteboardPresentationBar";

export default WhiteboardPresentationBar;
