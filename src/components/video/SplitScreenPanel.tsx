// components/video/SplitScreenPanel.tsx
//
// Builds a split screen at the playhead: pick a layout, which shot plays in each cell (timeline
// clips - the selected ones first - or any video file), whose sound you hear, and the gap, corners
// and gap colour. Applying adds one PiP per cell (and a colour backdrop behind them) in a single
// undo step - see useVideoEditStore's addSplitScreen and splitLayouts.ts.
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IoClose, IoFolderOpenOutline, IoVolumeHighOutline, IoVolumeMuteOutline } from "react-icons/io5";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { Clip, isImageClipPath } from "../../utils/videoEditTypes";
import { clipOutputDuration } from "../../utils/clipTiming";
import { MEDIA_VIDEO_EXTENSIONS } from "../../utils/fileCategory";
import { SPLIT_LAYOUTS, SplitLayoutId, defaultSplitLayout, splitCells } from "../../utils/splitLayouts";
import type { SplitScreenCell } from "../../hooks/useVideoEditStore";

interface SplitScreenPanelProps {
  anchor: PopoverAnchor;
  clips: Clip[];
  // Timeline-selected clip ids - their shots fill the cells first.
  selectedClipIds: string[];
  playhead: number;
  totalDuration: number;
  // Output frame width / height.
  frameAspect: number;
  onApply: (cells: SplitScreenCell[], startTime: number, endTime: number, backdropColor: string | null) => void;
  onClose: () => void;
}

// A cell's source: a timeline clip (plays from that clip's start) or a picked file (from 0).
type CellSource = { kind: "clip"; clipId: string } | { kind: "file"; path: string };

const GAP_COLORS = ["#000000", "#ffffff", "#111827", "#1e1b4b", "#7c2d12"];
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

// Source durations, probed once per file for the life of the app.
const durationCache = new Map<string, Promise<number>>();
function sourceDuration(path: string): Promise<number> {
  let pending = durationCache.get(path);
  if (!pending) {
    pending = invoke<Record<string, string>>("get_conversion_info", { inputPath: path }).then((info) => {
      const match = info.duration?.match(/[\d.]+/);
      const d = match ? parseFloat(match[0]) : NaN;
      if (!Number.isFinite(d) || d <= 0) throw new Error(`No duration for ${path}`);
      return d;
    });
    pending.catch(() => durationCache.delete(path));
    durationCache.set(path, pending);
  }
  return pending;
}

const SplitScreenPanel: React.FC<SplitScreenPanelProps> = ({ anchor, clips, selectedClipIds, playhead, totalDuration, frameAspect, onApply, onClose }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);

  // Video clips with where each starts on the output timeline.
  const videoClips = useMemo(() => {
    let at = 0;
    return clips.flatMap((clip, index) => {
      const start = at;
      at += clipOutputDuration(clip);
      return isImageClipPath(clip.sourcePath) ? [] : [{ clip, index, start }];
    });
  }, [clips]);

  // First shots: the selected clips in timeline order, else the clip at the playhead and those after it.
  const initialSources = useMemo((): CellSource[] => {
    const selected = videoClips.filter((v) => selectedClipIds.includes(v.clip.id));
    if (selected.length >= 2) return selected.map((v) => ({ kind: "clip", clipId: v.clip.id }));
    const from = Math.max(0, videoClips.findIndex((v) => v.start + clipOutputDuration(v.clip) > playhead));
    return [...videoClips.slice(from), ...videoClips.slice(0, from)].map((v) => ({ kind: "clip", clipId: v.clip.id }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [layout, setLayout] = useState<SplitLayoutId>(() => defaultSplitLayout(frameAspect, Math.max(2, Math.min(4, initialSources.length))));
  const cellCount = SPLIT_LAYOUTS.find((l) => l.id === layout)!.cells;
  const [sources, setSources] = useState<CellSource[]>(initialSources);
  const [audible, setAudible] = useState<number | null>(0);
  const [gap, setGap] = useState(0.012);
  const [corners, setCorners] = useState(0);
  const [gapColor, setGapColor] = useState(GAP_COLORS[0]);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const sourceFor = (i: number): CellSource | undefined => sources[i] ?? sources[i % Math.max(1, sources.length)];
  const pathOf = (src: CellSource | undefined) => (src ? (src.kind === "file" ? src.path : clips.find((c) => c.id === src.clipId)?.sourcePath) : undefined);
  const trimOf = (src: CellSource | undefined) => (src?.kind === "clip" ? clips.find((c) => c.id === src.clipId)?.start ?? 0 : 0);

  // Probe every source in use.
  const paths = Array.from({ length: cellCount }, (_, i) => pathOf(sourceFor(i))).filter((p): p is string => !!p);
  const pathsKey = Array.from(new Set(paths)).join("|");
  useEffect(() => {
    let cancelled = false;
    for (const path of new Set(paths)) {
      if (durations[path]) continue;
      sourceDuration(path)
        .then((d) => !cancelled && setDurations((prev) => ({ ...prev, [path]: d })))
        .catch(() => !cancelled && setError(`Couldn't read ${baseName(path)}.`));
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey]);

  // Longest the split can run: to the timeline's end, and no cell past its own source's end.
  const room = Math.max(0, totalDuration - playhead);
  const maxLen = Math.max(
    0.5,
    Math.min(
      room,
      ...Array.from({ length: cellCount }, (_, i) => {
        const src = sourceFor(i);
        const d = durations[pathOf(src) ?? ""];
        return d ? d - trimOf(src) : Infinity;
      })
    )
  );
  const [length, setLength] = useState(5);
  const len = Math.min(length, maxLen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickFile = async (i: number) => {
    const picked = await openFileDialog({ multiple: false, filters: [{ name: "Video", extensions: [...MEDIA_VIDEO_EXTENSIONS] }] });
    if (!picked || Array.isArray(picked)) return;
    setSources((prev) => {
      const next = [...prev];
      next[i] = { kind: "file", path: picked };
      return next;
    });
  };

  const cells = splitCells(layout, frameAspect, gap);
  const ready = paths.length === cellCount && paths.every((p) => durations[p]);

  const apply = () => {
    if (!ready) return;
    onApply(
      cells.map((rect, i) => {
        const src = sourceFor(i);
        const path = pathOf(src)!;
        return { ...rect, sourcePath: path, sourceDuration: durations[path], trimStart: trimOf(src), cornerRadius: corners, muted: audible !== i };
      }),
      playhead,
      playhead + len,
      gap > 0 ? gapColor : null
    );
  };

  const thumbW = 54;
  const thumbH = Math.max(24, Math.min(80, thumbW / frameAspect));

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Split screen"
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-[360px] max-h-[80vh] overflow-y-auto p-3 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium">Split screen</span>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1 -m-1 rounded text-white/50 hover:text-white hover:bg-white/10">
          <IoClose size={14} />
        </button>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {SPLIT_LAYOUTS.map((l) => (
          <button
            key={l.id}
            type="button"
            title={l.label}
            onClick={() => setLayout(l.id)}
            className={`flex flex-col items-center gap-1 p-1.5 rounded-lg transition-colors ${layout === l.id ? "bg-blue-500/20 ring-1 ring-blue-400/60" : "bg-white/[0.04] hover:bg-white/10"}`}
          >
            <span className="relative block rounded-sm bg-black/60" style={{ width: thumbW, height: thumbH }}>
              {splitCells(l.id, frameAspect, 0.04).map((c, i) => (
                <span
                  key={i}
                  className={`absolute rounded-[2px] ${i === 0 ? "bg-blue-400/80" : "bg-white/45"}`}
                  style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.width * 100}%`, height: `${c.height * 100}%` }}
                />
              ))}
            </span>
            <span className="text-[9.5px] text-white/60 leading-tight text-center">{l.label}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Shots</span>
        {Array.from({ length: cellCount }, (_, i) => {
          const src = sourceFor(i);
          const value = src?.kind === "clip" ? src.clipId : src?.kind === "file" ? "file" : "";
          return (
            <div key={i} className="flex items-center gap-1.5 text-[11px]">
              <span className={`w-5 h-5 shrink-0 rounded flex items-center justify-center text-[10px] font-semibold ${i === 0 ? "bg-blue-500/70" : "bg-white/15"}`}>{i + 1}</span>
              <select
                value={value}
                onChange={(e) => {
                  if (e.target.value === "__pick") {
                    void pickFile(i);
                    return;
                  }
                  if (e.target.value === "file") return;
                  setSources((prev) => {
                    const next = [...prev];
                    next[i] = { kind: "clip", clipId: e.target.value };
                    return next;
                  });
                }}
                className="flex-1 min-w-0 h-7 px-1.5 rounded-md bg-black/40 ring-1 ring-white/10 text-white outline-none focus:ring-blue-400"
              >
                {videoClips.map((v) => (
                  <option key={v.clip.id} value={v.clip.id} className="bg-neutral-800">
                    Clip {v.index + 1} · {baseName(v.clip.sourcePath)} ({fmt(v.start)})
                  </option>
                ))}
                {src?.kind === "file" && (
                  <option value="file" className="bg-neutral-800">
                    {baseName(src.path)}
                  </option>
                )}
                <option value="__pick" className="bg-neutral-800">
                  Choose a video file…
                </option>
              </select>
              <button type="button" title="Choose a video file" onClick={() => void pickFile(i)} className="p-1 rounded text-white/55 hover:text-white hover:bg-white/10">
                <IoFolderOpenOutline size={14} />
              </button>
              <button
                type="button"
                title={audible === i ? "This shot's sound plays - click to mute" : "Play this shot's sound (mutes the others)"}
                onClick={() => setAudible(audible === i ? null : i)}
                className={`p-1 rounded ${audible === i ? "text-blue-300 bg-blue-500/15" : "text-white/40 hover:text-white hover:bg-white/10"}`}
              >
                {audible === i ? <IoVolumeHighOutline size={14} /> : <IoVolumeMuteOutline size={14} />}
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 text-[11px]">
        <label className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-white/60">Gap</span>
          <input type="range" min={0} max={0.06} step={0.002} value={gap} onChange={(e) => setGap(Number(e.target.value))} className="flex-1 accent-blue-400" />
          <span className="w-10 text-right tabular-nums text-white/60">{(gap * 100).toFixed(1)}%</span>
        </label>
        {gap > 0 && (
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-white/60">Gap colour</span>
            {GAP_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => setGapColor(c)}
                className={`w-5 h-5 rounded-full ${gapColor === c ? "ring-2 ring-blue-400" : "ring-1 ring-white/25"}`}
                style={{ background: c }}
              />
            ))}
          </div>
        )}
        <label className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-white/60">Corners</span>
          <input type="range" min={0} max={0.2} step={0.005} value={corners} onChange={(e) => setCorners(Number(e.target.value))} className="flex-1 accent-blue-400" />
          <span className="w-10 text-right tabular-nums text-white/60">{Math.round(corners * 100)}%</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-white/60">Length</span>
          <input type="range" min={0.5} max={Math.max(0.5, maxLen)} step={0.1} value={len} onChange={(e) => setLength(Number(e.target.value))} className="flex-1 accent-blue-400" />
          <span className="w-10 text-right tabular-nums text-white/60">{len.toFixed(1)}s</span>
        </label>
      </div>

      {error && <p className="text-[11px] text-red-400">{error}</p>}
      {videoClips.length === 0 && <p className="text-[11px] text-white/50">No video clips on the timeline - choose a file for each shot.</p>}

      <button
        type="button"
        disabled={!ready || room <= 0}
        onClick={apply}
        className="h-8 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-500 disabled:opacity-50 transition-colors"
      >
        {ready ? `Add split screen at ${fmt(playhead)}` : "Reading shots…"}
      </button>
      <p className="text-[10px] leading-snug text-white/40">
        Each shot is a picture-in-picture layer you can still move, crop and retime. Select clips on the timeline first to fill the shots in order.
      </p>
    </div>,
    document.body
  );
};

export default SplitScreenPanel;
