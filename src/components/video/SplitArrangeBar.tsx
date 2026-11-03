// components/video/SplitArrangeBar.tsx
//
// Rearranging a split screen right on the picture: while one of its layers is selected (and the
// video is paused), a bar over the frame offers every layout for that many shots, a swap (or, with
// three or more, moving every shot on one cell), the divider's usual places, and the full panel
// for anything more (adding or changing shots). Each change is one undo step
// (useVideoEditStore's updateSplitGroup, splitGroups.ts).
import React from "react";
import { IoSwapHorizontal, IoSwapVertical, IoRepeat, IoOptionsOutline } from "react-icons/io5";
import { SPLIT_LAYOUTS, SplitGroupSettings, SplitLayoutId, defaultRatio, splitCells, splitLayout } from "../../utils/splitLayouts";

interface SplitArrangeBarProps {
  settings: SplitGroupSettings;
  cells: number;
  frameAspect: number;
  onChange: (change: { settings?: Partial<SplitGroupSettings>; rotate?: boolean }) => void;
  onEdit: () => void;
}

const RATIOS: [number, string][] = [
  [1 / 3, "⅓"],
  [1 / 2, "½"],
  [2 / 3, "⅔"],
];

const SplitArrangeBar: React.FC<SplitArrangeBarProps> = ({ settings, cells, frameAspect, onChange, onEdit }) => {
  const layouts = SPLIT_LAYOUTS.filter((l) => l.cells === cells);
  const spec = splitLayout(settings.layout);
  const thumbH = 22;
  const thumbW = Math.max(14, Math.min(36, thumbH * frameAspect));
  const pick = (id: SplitLayoutId) => {
    if (id === settings.layout) return;
    const next = splitLayout(id);
    onChange({ settings: { layout: id, ...(next.divider !== spec.divider ? { ratio: defaultRatio(id, frameAspect) } : {}) } });
  };
  return (
    <div
      className="flex items-center gap-1 p-1 rounded-xl bg-neutral-900/90 backdrop-blur-md ring-1 ring-white/15 shadow-xl text-white/80 pointer-events-auto"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {layouts.map((l) => (
        <button
          key={l.id}
          type="button"
          title={l.label}
          onClick={() => pick(l.id)}
          className={`p-1 rounded-md transition-colors ${l.id === settings.layout ? "bg-blue-500/25 ring-1 ring-blue-400/60" : "hover:bg-white/10"}`}
        >
          <span className="relative block rounded-[2px] bg-black/60" style={{ width: thumbW, height: thumbH }}>
            {splitCells(l.id, frameAspect, 0.05, l.id === settings.layout ? settings.ratio : defaultRatio(l.id, frameAspect)).map((c, i) => (
              <span
                key={i}
                className={`absolute rounded-[1px] ${l.id === settings.layout ? "bg-blue-300/90" : "bg-white/50"}`}
                style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.width * 100}%`, height: `${c.height * 100}%` }}
              />
            ))}
          </span>
        </button>
      ))}
      {cells >= 2 && (
        <>
          <span className="w-px h-5 bg-white/15 mx-0.5" />
          <button
            type="button"
            title={cells === 2 ? "Swap the shots" : "Move every shot on one place"}
            onClick={() => onChange({ rotate: true, ...(spec.divider ? { settings: { ratio: 1 - settings.ratio } } : {}) })}
            className="p-1.5 rounded-md hover:bg-white/10 hover:text-white"
          >
            {cells > 2 ? <IoRepeat size={14} /> : spec.divider === "row" ? <IoSwapVertical size={14} /> : <IoSwapHorizontal size={14} />}
          </button>
        </>
      )}
      {spec.divider && (
        <>
          <span className="w-px h-5 bg-white/15 mx-0.5" />
          {RATIOS.map(([r, label]) => (
            <button
              key={label}
              type="button"
              title={`First shot takes ${label}`}
              onClick={() => onChange({ settings: { ratio: r } })}
              className={`w-6 h-6 rounded-md text-[11px] tabular-nums transition-colors ${Math.abs(settings.ratio - r) < 0.01 ? "bg-blue-500/25 text-blue-200" : "hover:bg-white/10"}`}
            >
              {label}
            </button>
          ))}
        </>
      )}
      <span className="w-px h-5 bg-white/15 mx-0.5" />
      <button type="button" title="Edit the split screen - shots, framing, gap, length" onClick={onEdit} className="flex items-center gap-1 h-6 px-1.5 rounded-md text-[11px] hover:bg-white/10 hover:text-white">
        <IoOptionsOutline size={13} />
        Edit
      </button>
    </div>
  );
};

export default SplitArrangeBar;
