// components/video/SplitScreenPanel.tsx
//
// Builds a split screen at the playhead around a live preview of the real shots: pick a layout
// (the speaker under the media, side by side, a card floating over the main video, stacks and
// grids), fill each cell (timeline clips - the selected ones first - or any video or picture,
// chosen or dragged in from the sidebar onto the cell), then frame it right there: drag a shot to
// move it in its cell, scroll to zoom, drag the divider to resize (it snaps to thirds and half).
//
// Every video shot is framed on its subject to begin with (analyze_subject_track - where the
// movement is, which for a talking head is the face and hands), so a 16:9 speaker dropped into a
// short wide cell keeps their face instead of being centre-cropped through it.
//
// The clip under the playhead plays from the playhead itself, muted, so it stays in step with the
// main video's sound underneath (which is what you hear unless another shot's sound is chosen).
//
// Applying adds one layer per cell - a PiP for a video, a picture overlay for a picture, each
// cropped to its framing - and a colour backdrop behind them, in a single undo step
// (useVideoEditStore's addSplitScreen, splitLayouts.ts).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IoClose, IoFolderOpenOutline, IoSwapVertical, IoSwapHorizontal, IoSparkles, IoAdd, IoVolumeHighOutline } from "react-icons/io5";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { Clip, IMAGE_CLIP_EXTENSIONS, isImageClipPath } from "../../utils/videoEditTypes";
import { clipOutputDuration, outputOffsetToSource } from "../../utils/clipTiming";
import { MEDIA_VIDEO_EXTENSIONS } from "../../utils/fileCategory";
import {
  CENTRED,
  CellFraming,
  CellRect,
  MAX_CELL_ZOOM,
  SplitGroupSettings,
  SPLIT_LAYOUTS,
  SplitLayoutId,
  cardCell,
  coverWindow,
  defaultRatio,
  defaultSplitLayout,
  featherMask,
  framingCrop,
  framingOfCrop,
  snapRatio,
  splitCells,
  splitLayout,
} from "../../utils/splitLayouts";
import type { SplitScreenCell } from "../../hooks/useVideoEditStore";
import type { ClipCrop } from "../../utils/videoEditTypes";

// A split screen already made, opened again to change it: its settings, time and shots by cell.
export interface ExistingSplit {
  group: string;
  settings: SplitGroupSettings;
  startTime: number;
  endTime: number;
  members: { cell: number; path: string; trim: number; muted: boolean; crop?: ClipCrop; shotAspect: number }[];
}

interface SplitScreenPanelProps {
  anchor: PopoverAnchor;
  clips: Clip[];
  // Timeline-selected clip ids - their shots fill the cells first.
  selectedClipIds: string[];
  playhead: number;
  totalDuration: number;
  // Output frame width / height.
  frameAspect: number;
  onApply: (cells: SplitScreenCell[], startTime: number, endTime: number, backdropColor: string | null, settings: SplitGroupSettings) => void;
  onClose: () => void;
  // Editing a split screen already on the timeline rather than adding one.
  existing?: ExistingSplit;
}

// A cell's source: a timeline clip (plays from the playhead when it's the clip under it, else from
// that clip's start) or a picked file (from 0).
type CellSource = { kind: "clip"; clipId: string } | { kind: "file"; path: string; trim?: number };
// Who fills a cell, independent of the layout: the main shot (the clip under the playhead) or the
// n-th other shot - so switching layouts keeps every shot and its framing.
type Slot = "main" | `o${number}`;
// A slot's framing; `auto` = framed on the subject (until it's dragged or zoomed by hand).
type SlotFraming = CellFraming & { auto: boolean };

const GAP_COLORS = ["#000000", "#ffffff", "#111827", "#1e1b4b", "#7c2d12"];
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const RATIO_LABELS: [number, string][] = [
  [1 / 3, "⅓"],
  [1 / 2, "½"],
  [2 / 3, "⅔"],
];
// Longest stretch of a shot read to find its subject - enough to see where someone sits.
const SUBJECT_SECONDS = 12;

// Pictures the webview can show directly (HEIC/HEIF need decoding first, so they stay timeline-only).
const PICTURE_EXTENSIONS = IMAGE_CLIP_EXTENSIONS.filter((e) => e !== "heic" && e !== "heif");
const isPicture = (path: string) => PICTURE_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");
const isUsableMedia = (path: string) => isPicture(path) || MEDIA_VIDEO_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");

// What a shot looks like at a moment: a picture as itself, a video's frame there as a still (a
// cached full-size PNG, extract_frame_still). Its size is the shot's real shape.
interface Still {
  src: string;
  width: number;
  height: number;
}
const stillKey = (path: string, time: number) => (isPicture(path) ? path : `${path}@${time.toFixed(1)}`);
const stillCache = new Map<string, Promise<Still>>();
function loadStill(path: string, time: number): Promise<Still> {
  const key = stillKey(path, time);
  let pending = stillCache.get(key);
  if (!pending) {
    pending = (async () => {
      const file = isPicture(path) ? path : await invoke<string>("extract_frame_still", { sourcePath: path, time: Math.round(time * 10) / 10 });
      const src = convertFileSrc(file);
      const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => (img.naturalWidth > 0 ? resolve({ width: img.naturalWidth, height: img.naturalHeight }) : reject(new Error("empty")));
        img.onerror = () => reject(new Error(`Couldn't open ${path}`));
        img.src = src;
      });
      return { src, ...size };
    })();
    pending.catch(() => stillCache.delete(key));
    stillCache.set(key, pending);
  }
  return pending;
}

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

// Where a window of w x h (fractions of the shot) best sits over the shot's subject for a stretch:
// the confidence-weighted median of analyze_subject_track's per-frame best windows (a median, so a
// moment of someone walking past doesn't drag the framing off the speaker).
interface SubjectSample {
  x: number;
  y: number;
  confidence: number;
}
const subjectCache = new Map<string, Promise<{ cx: number; cy: number }>>();
function subjectCentre(path: string, start: number, end: number, w: number, h: number): Promise<{ cx: number; cy: number }> {
  const key = `${path}|${start.toFixed(1)}|${end.toFixed(1)}|${w.toFixed(3)}|${h.toFixed(3)}`;
  let pending = subjectCache.get(key);
  if (!pending) {
    pending = invoke<{ samples: SubjectSample[] }>("analyze_subject_track", { sourcePath: path, start, end, cropW: w, cropH: h }).then(({ samples }) => {
      if (samples.length === 0) return { cx: 0.5, cy: 0.5 };
      const median = (pick: (s: SubjectSample) => number) => {
        const sorted = [...samples].sort((a, b) => pick(a) - pick(b));
        const total = sorted.reduce((sum, s) => sum + s.confidence + 0.02, 0);
        let acc = 0;
        for (const s of sorted) {
          acc += s.confidence + 0.02;
          if (acc >= total / 2) return pick(s);
        }
        return pick(sorted[sorted.length - 1]);
      };
      return { cx: median((s) => s.x), cy: median((s) => s.y) };
    });
    pending.catch(() => subjectCache.delete(key));
    subjectCache.set(key, pending);
  }
  return pending;
}

// Soft edges in the preview: the mask export draws (featherMask), approximated by two crossed
// linear fades.
function featherStyle(rect: CellRect, frameAspect: number, feather: number): React.CSSProperties {
  if (feather <= 0) return {};
  const m = featherMask(rect.width * frameAspect, rect.height, feather);
  const fade = (dir: string, inset: number) => `linear-gradient(${dir}, transparent 0%, #000 ${inset * 200}%, #000 ${100 - inset * 200}%, transparent 100%)`;
  const image = `${fade("to right", m.x)}, ${fade("to bottom", m.y)}`;
  return { WebkitMaskImage: image, maskImage: image, WebkitMaskComposite: "source-in", maskComposite: "intersect" };
}

const SplitScreenPanel: React.FC<SplitScreenPanelProps> = ({ anchor, clips, selectedClipIds, playhead: playheadNow, totalDuration, frameAspect, onApply, onClose, existing }) => {
  // An existing split screen is changed where it is.
  const playhead = existing?.startTime ?? playheadNow;
  const { ref, position } = useClampedPopoverPosition(anchor);

  // Timeline clips with where each starts on the output timeline - videos, and pictures the
  // webview can show.
  const videoClips = useMemo(() => {
    let at = 0;
    return clips.flatMap((clip, index) => {
      const start = at;
      at += clipOutputDuration(clip);
      return isImageClipPath(clip.sourcePath) && !isPicture(clip.sourcePath) ? [] : [{ clip, index, start, end: at }];
    });
  }, [clips]);
  // The clip under the playhead - the speaker in a commentary split.
  const underPlayhead = videoClips.find((v) => playhead >= v.start && playhead < v.end) ?? null;

  // First shots: the selected clips (the one under the playhead as the main shot when it's among
  // them, or always when fewer than two are selected); the other cells wait for a drop.
  const initial = useMemo(() => {
    if (existing) {
      // Its shots by cell: the layout's main cell is the main slot, the rest in order.
      const spec0 = splitLayout(existing.settings.layout);
      const byCell = [...existing.members].sort((a, b) => a.cell - b.cell);
      const asSource = (m: (typeof byCell)[number]): CellSource => ({ kind: "file", path: m.path, trim: m.trim });
      const mainMember = spec0.main >= 0 ? byCell.find((m) => m.cell === spec0.main) : undefined;
      return { main: mainMember ? asSource(mainMember) : null, others: byCell.filter((m) => m !== mainMember).map(asSource), shots: byCell.length };
    }
    const selected = videoClips.filter((v) => selectedClipIds.includes(v.clip.id));
    const mainClip = underPlayhead && (selected.length < 2 || selected.some((v) => v.clip.id === underPlayhead.clip.id)) ? underPlayhead : null;
    const main: CellSource | null = mainClip ? { kind: "clip", clipId: mainClip.clip.id } : null;
    const others = selected.filter((v) => v !== mainClip).map((v): CellSource => ({ kind: "clip", clipId: v.clip.id }));
    return { main, others, shots: (main ? 1 : 0) + others.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [layout, setLayoutState] = useState<SplitLayoutId>(() => existing?.settings.layout ?? defaultSplitLayout(frameAspect, Math.max(2, Math.min(4, initial.shots))));
  const [ratio, setRatio] = useState(() => existing?.settings.ratio ?? defaultRatio(layout, frameAspect));
  // Two-cell layouts: the main shot in the other cell (the speaker on top, or on the right).
  const [flipped, setFlipped] = useState(false);
  const [mainShot, setMainShot] = useState<CellSource | null>(initial.main);
  const [others, setOthers] = useState<(CellSource | null)[]>(initial.others);
  // An existing split's slot for each of its cells, as the layout assigns them (see slotOf below).
  const existingSlot = (cell: number): Slot => {
    const main = existing ? splitLayout(existing.settings.layout).main : -1;
    return cell === main ? "main" : `o${main >= 0 && cell > main ? cell - 1 : cell}`;
  };
  // Opened again: every shot keeps the framing it was given (read back off its crop).
  const [framings, setFramings] = useState<Partial<Record<Slot, SlotFraming>>>(() => {
    if (!existing || existing.settings.layout === "card") return {};
    const rects0 = splitCells(existing.settings.layout, frameAspect, existing.settings.gap, existing.settings.ratio);
    return Object.fromEntries(
      existing.members
        .filter((m) => rects0[m.cell])
        .map((m) => [existingSlot(m.cell), { ...framingOfCrop(m.shotAspect, (rects0[m.cell].width / rects0[m.cell].height) * frameAspect, m.crop), auto: false }])
    );
  });
  const [autoCentres, setAutoCentres] = useState<Partial<Record<Slot, { cx: number; cy: number }>>>({});
  const [framingBusy, setFramingBusy] = useState<Partial<Record<Slot, boolean>>>({});
  // Card: its size (fraction of the frame's width), centre and soft edges.
  const [cardSize, setCardSize] = useState(existing?.settings.cardSize ?? (frameAspect < 1 ? 0.7 : 0.4));
  const [cardCentre, setCardCentre] = useState(existing?.settings.cardCentre ?? { x: 0.5, y: frameAspect < 1 ? 0.2 : 0.25 });
  const [feather, setFeather] = useState(existing?.settings.feather ?? 0.06);
  // Whose sound plays: the main video's (underneath) or one shot's as well.
  const [sound, setSound] = useState<"video" | Slot>(() => {
    const heard = existing?.members.find((m) => !m.muted);
    return heard ? existingSlot(heard.cell) : "video";
  });
  const [gap, setGap] = useState(existing?.settings.gap ?? 0.008);
  const [corners, setCorners] = useState(existing?.settings.corners ?? 0);
  const [gapColor, setGapColor] = useState(existing?.settings.gapColor ?? GAP_COLORS[0]);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [stills, setStills] = useState<Record<string, Still>>({});
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<null | "frame" | "divider" | "card">(null);
  const [snapLabel, setSnapLabel] = useState<string | null>(null);
  const [hoverCell, setHoverCell] = useState<number | null>(null);

  const spec = splitLayout(layout);
  const setLayout = (id: SplitLayoutId) => {
    if (id === layout) return;
    if (splitLayout(id).divider !== spec.divider) setRatio(defaultRatio(id, frameAspect));
    setLayoutState(id);
  };
  const mainCell = spec.main < 0 ? -1 : spec.divider && flipped ? 1 - spec.main : spec.main;
  const slotOf = (i: number): Slot => (i === mainCell ? "main" : `o${mainCell >= 0 && i > mainCell ? i - 1 : i}`);
  const shotOf = (slot: Slot): CellSource | null => (slot === "main" ? mainShot : others[Number(slot.slice(1))] ?? null);
  const setShot = (slot: Slot, shot: CellSource) => {
    setError(null);
    if (slot === "main") setMainShot(shot);
    else {
      const k = Number(slot.slice(1));
      setOthers((prev) => {
        const next = [...prev];
        while (next.length <= k) next.push(null);
        next[k] = shot;
        return next;
      });
    }
    // A new shot is framed afresh.
    setFramings((prev) => ({ ...prev, [slot]: undefined }));
    setAutoCentres((prev) => ({ ...prev, [slot]: undefined }));
  };

  const clipOf = (src: CellSource | null) => (src?.kind === "clip" ? videoClips.find((v) => v.clip.id === src.clipId) ?? null : null);
  const pathOf = (src: CellSource | null) => (src ? (src.kind === "file" ? src.path : clipOf(src)?.clip.sourcePath) : undefined);
  // In step with the main video: the clip under the playhead, from the playhead.
  const isSynced = (src: CellSource | null) => !!underPlayhead && src?.kind === "clip" && src.clipId === underPlayhead.clip.id && !isPicture(underPlayhead.clip.sourcePath);
  const trimOf = (src: CellSource | null) => {
    const path = pathOf(src);
    if (!path || isPicture(path)) return 0;
    if (src?.kind === "file") return src.trim ?? 0;
    const v = clipOf(src);
    if (!v) return 0;
    return isSynced(src) ? outputOffsetToSource(v.clip, playhead - v.start) : v.clip.start;
  };

  const cellCount = spec.cells;
  const cellSlots = Array.from({ length: cellCount }, (_, i) => slotOf(i));
  const cellShots = cellSlots.map(shotOf);
  const cellPaths = cellShots.map(pathOf);
  const cellStills = cellShots.map((s, i) => {
    const p = cellPaths[i];
    return p ? stills[stillKey(p, trimOf(s))] : undefined;
  });

  // Load what every cell needs: its still (and so its shape) and, for a video, its length.
  const loadKey = cellShots.map((s, i) => `${cellPaths[i] ?? ""}@${trimOf(s).toFixed(1)}`).join("|");
  useEffect(() => {
    let cancelled = false;
    cellShots.forEach((s, i) => {
      const path = cellPaths[i];
      if (!path) return;
      const time = trimOf(s);
      const key = stillKey(path, time);
      if (!stills[key])
        loadStill(path, time)
          .then((still) => !cancelled && setStills((prev) => ({ ...prev, [key]: still })))
          .catch(() => !cancelled && setError(`Couldn't open ${baseName(path)}.`));
      if (!isPicture(path) && !durations[path])
        sourceDuration(path)
          .then((d) => !cancelled && setDurations((prev) => ({ ...prev, [path]: d })))
          .catch(() => !cancelled && setError(`Couldn't read ${baseName(path)}.`));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  // Longest the split can run: to the timeline's end, no shot past its own source's end, and the
  // synced shot no further than its clip (past a cut it would drift from the main video).
  const room = Math.max(0, totalDuration - playhead);
  const maxLen = Math.max(
    0.5,
    Math.min(
      room,
      ...cellShots.map((s, i) => {
        const path = cellPaths[i] ?? "";
        // A picture can be on screen for as long as needed.
        if (!path || isPicture(path)) return Infinity;
        const d = durations[path];
        const synced = isSynced(s) && underPlayhead ? underPlayhead.end - playhead : Infinity;
        return Math.min(synced, d ? d - trimOf(s) : Infinity);
      })
    )
  );
  const [length, setLength] = useState(existing ? existing.endTime - existing.startTime : 5);
  const len = Math.min(length, maxLen);

  // Each cell's rect: the layout's, or for the card the shot's own shape at its size and place.
  const cardAspect = cellStills[0] ? cellStills[0].width / cellStills[0].height : 16 / 9;
  const rects: CellRect[] = layout === "card" ? [cardCell(frameAspect, cardAspect, cardSize, cardCentre)] : splitCells(layout, frameAspect, gap, ratio);
  const cellAspect = (r: CellRect) => (r.width / r.height) * frameAspect;
  const framingOf = (slot: Slot): CellFraming => {
    const f = framings[slot];
    if (f && !f.auto) return f;
    return { ...(autoCentres[slot] ?? CENTRED), zoom: 1 };
  };
  const cropOf = (i: number) => {
    const still = cellStills[i];
    if (!still || layout === "card") return { x: 0, y: 0, width: 1, height: 1 };
    return framingCrop(still.width / still.height, cellAspect(rects[i]), framingOf(cellSlots[i]));
  };

  // Frame every auto-framed video shot on its subject - again when its cell changes shape (after
  // the divider settles: each ask is instant once the shot has been read, but not free).
  const autoKey =
    layout === "card"
      ? ""
      : cellShots
          .map((s, i) => {
            const path = cellPaths[i];
            const still = cellStills[i];
            if (!path || !still || isPicture(path) || framings[cellSlots[i]]?.auto === false) return "";
            const win = coverWindow(still.width / still.height, cellAspect(rects[i]));
            return `${cellSlots[i]}:${path}:${trimOf(s).toFixed(1)}:${win.w.toFixed(2)}:${win.h.toFixed(2)}`;
          })
          .join("|");
  useEffect(() => {
    if (!autoKey.replace(/\|/g, "")) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      cellShots.forEach((s, i) => {
        const path = cellPaths[i];
        const still = cellStills[i];
        const slot = cellSlots[i];
        if (!path || !still || isPicture(path) || framings[slot]?.auto === false) return;
        const win = coverWindow(still.width / still.height, cellAspect(rects[i]));
        // Nothing to move: the whole shot already fits one way and the other.
        if (win.w > 0.98 && win.h > 0.98) return;
        const start = trimOf(s);
        setFramingBusy((prev) => ({ ...prev, [slot]: true }));
        subjectCentre(path, start, start + Math.max(1, Math.min(len, SUBJECT_SECONDS)), win.w, win.h)
          .then((centre) => !cancelled && setAutoCentres((prev) => ({ ...prev, [slot]: centre })))
          .catch(() => {})
          .finally(() => !cancelled && setFramingBusy((prev) => ({ ...prev, [slot]: false })));
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickFile = async (slot: Slot) => {
    const picked = await openFileDialog({
      multiple: false,
      filters: [
        { name: "Videos and pictures", extensions: [...MEDIA_VIDEO_EXTENSIONS, ...PICTURE_EXTENSIONS] },
        { name: "Video", extensions: [...MEDIA_VIDEO_EXTENSIONS] },
        { name: "Pictures", extensions: [...PICTURE_EXTENSIONS] },
      ],
    });
    if (!picked || Array.isArray(picked)) return;
    setShot(slot, { kind: "file", path: picked });
  };
  // A file dragged from the sidebar onto a cell or a shot's row (Dashboard sends "media-drop" to
  // whatever [data-media-drop] element it lands on).
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onDrop = (e: Event) => {
      const { path } = (e as CustomEvent<{ path: string }>).detail;
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-shot]");
      if (!target) return;
      if (!isUsableMedia(path)) {
        setError(`${baseName(path)} isn't a video or a picture.`);
        return;
      }
      setShot(target.dataset.shot as Slot, { kind: "file", path });
    };
    root.addEventListener("media-drop", onDrop);
    return () => root.removeEventListener("media-drop", onDrop);
  });

  // The preview: the frame at the panel's width, or shorter for a tall frame.
  const previewW = Math.round(Math.min(336, 300 * frameAspect));
  const previewH = Math.round(previewW / frameAspect);

  // Dragging a shot inside its cell moves which part of it shows; dragging the card moves the card.
  const beginCellDrag = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    const still = cellStills[i];
    if (!still) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    if (layout === "card") {
      const start = cardCentre;
      setDragging("card");
      const move = (ev: PointerEvent) => setCardCentre({ x: Math.min(1, Math.max(0, start.x + (ev.clientX - x0) / previewW)), y: Math.min(1, Math.max(0, start.y + (ev.clientY - y0) / previewH)) });
      const up = () => {
        setDragging(null);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      return;
    }
    const slot = cellSlots[i];
    const crop = cropOf(i);
    const zoom = framingOf(slot).zoom;
    // The shot's drawn size in preview pixels.
    const shotW = (rects[i].width * previewW) / crop.width;
    const shotH = (rects[i].height * previewH) / crop.height;
    const cx0 = crop.x + crop.width / 2;
    const cy0 = crop.y + crop.height / 2;
    setDragging("frame");
    const move = (ev: PointerEvent) => {
      const cx = Math.min(1 - crop.width / 2, Math.max(crop.width / 2, cx0 - (ev.clientX - x0) / shotW));
      const cy = Math.min(1 - crop.height / 2, Math.max(crop.height / 2, cy0 - (ev.clientY - y0) / shotH));
      setFramings((prev) => ({ ...prev, [slot]: { cx, cy, zoom, auto: false } }));
    };
    const up = () => {
      setDragging(null);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // Scrolling over a shot zooms it (about its current centre); over the card, resizes the card.
  // Native and non-passive, so the panel itself doesn't scroll meanwhile.
  const previewRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!cell) return;
    const i = Number(cell.dataset.cell);
    if (!cellStills[i]) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    if (layout === "card") {
      setCardSize((s) => Math.min(0.95, Math.max(0.15, s * factor)));
      return;
    }
    const slot = cellSlots[i];
    const crop = cropOf(i);
    const current = framingOf(slot);
    const zoom = Math.min(MAX_CELL_ZOOM, Math.max(1, current.zoom * factor));
    setFramings((prev) => ({ ...prev, [slot]: { cx: crop.x + crop.width / 2, cy: crop.y + crop.height / 2, zoom, auto: false } }));
  };
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // The divider between two cells: drag to share the frame differently, magnetic at ⅓, ½ and ⅔.
  const beginDividerDrag = (e: React.PointerEvent) => {
    if (e.button !== 0 || !spec.divider) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const box = previewRef.current!.getBoundingClientRect();
    const shorter = Math.min(frameAspect, 1);
    const g = spec.divider === "row" ? gap * shorter : (gap * shorter) / frameAspect;
    setDragging("divider");
    const move = (ev: PointerEvent) => {
      const p = spec.divider === "row" ? (ev.clientY - box.top) / box.height : (ev.clientX - box.left) / box.width;
      const r = snapRatio((p - 1.5 * g) / Math.max(0.01, 1 - 3 * g));
      setRatio(r);
      setSnapLabel(RATIO_LABELS.find(([v]) => Math.abs(v - r) < 1e-6)?.[1] ?? null);
    };
    const up = () => {
      setDragging(null);
      setSnapLabel(null);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const ready = cellCount > 0 && cellPaths.every((p, i) => !!p && !!cellStills[i] && (isPicture(p) || !!durations[p]));
  const missing = cellPaths.filter((p) => !p).length;

  const apply = () => {
    if (!ready) return;
    onApply(
      rects.map((rect, i) => {
        const shot = cellShots[i];
        const path = cellPaths[i]!;
        const still = cellStills[i]!;
        const picture = isPicture(path) ? { width: still.width, height: still.height } : undefined;
        const slot = cellSlots[i];
        return {
          ...rect,
          sourcePath: path,
          sourceDuration: picture ? len : durations[path],
          trimStart: trimOf(shot),
          cornerRadius: corners,
          // The synced shot stays silent - its sound is the main video's, already playing.
          muted: picture ? true : sound !== slot || isSynced(shot),
          image: picture,
          frameAspect,
          shotAspect: still.width / still.height,
          ...(layout === "card" ? (feather > 0 ? { mask: featherMask(rect.width * frameAspect, rect.height, feather) } : {}) : { crop: cropOf(i) }),
        };
      }),
      playhead,
      playhead + len,
      layout !== "card" && gap > 0 ? gapColor : null,
      { layout, ratio, gap, gapColor, corners, feather, cardSize, cardCentre }
    );
  };

  const thumbW = 54;
  const thumbH = Math.max(24, Math.min(80, thumbW / frameAspect));
  // A cell's chrome is tied to the number badge's colour: the main shot neutral, the others blue.
  const badge = (i: number) => (cellSlots[i] === "main" ? "bg-white/25" : "bg-blue-500/80");
  const shotLabel = (src: CellSource | null) => {
    if (!src) return "";
    if (src.kind === "file") return baseName(src.path);
    const v = clipOf(src);
    return v ? `${isPicture(v.clip.sourcePath) ? "Picture" : "Clip"} ${v.index + 1} · ${baseName(v.clip.sourcePath)}` : "";
  };
  // Shots with a sound of their own to choose from (the synced one's is the main video's).
  const soundSlots = cellSlots.filter((_, i) => cellPaths[i] && !isPicture(cellPaths[i]!) && !isSynced(cellShots[i]));
  const dividerPos = spec.divider ? (spec.divider === "row" ? rects[1].y - (rects[1].y - rects[0].y - rects[0].height) / 2 : rects[1].x - (rects[1].x - rects[0].x - rects[0].width) / 2) : 0;
  const ease = dragging ? "none" : "left 220ms cubic-bezier(.2,.8,.2,1), top 220ms cubic-bezier(.2,.8,.2,1), width 220ms cubic-bezier(.2,.8,.2,1), height 220ms cubic-bezier(.2,.8,.2,1)";

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Split screen"
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-[360px] max-h-[86vh] overflow-y-auto p-3 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium">{existing ? "Edit split screen" : "Split screen"}</span>
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
            <span className={`relative block rounded-sm overflow-hidden ${l.main < 0 ? "bg-white/30" : "bg-black/60"}`} style={{ width: thumbW, height: thumbH }}>
              {l.main < 0 && <span className="absolute left-1/2 -translate-x-1/2 bottom-0 w-[40%] h-[45%] rounded-t-full bg-white/45" />}
              {splitCells(l.id, frameAspect, 0.04, defaultRatio(l.id, frameAspect)).map((c, i) => (
                <span
                  key={i}
                  className={`absolute rounded-[2px] overflow-hidden ${i === l.main ? "bg-white/40" : "bg-blue-400/85"}`}
                  style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.width * 100}%`, height: `${c.height * 100}%` }}
                >
                  {/* The speaker: a head-and-shoulders mark in the main shot's cell. */}
                  {i === l.main && <span className="absolute left-1/2 -translate-x-1/2 bottom-0 w-[46%] h-[60%] rounded-t-full bg-white/55" />}
                </span>
              ))}
            </span>
            <span className="text-[9.5px] text-white/60 leading-tight text-center">{l.label}</span>
          </button>
        ))}
      </div>

      {/* The live preview - the real shots, framed as they'll export. */}
      <div className="flex justify-center">
        <div
          ref={previewRef}
          className="relative rounded-md overflow-hidden select-none ring-1 ring-white/10"
          style={{ width: previewW, height: previewH, background: layout === "card" ? "#000" : gap > 0 ? gapColor : "#000" }}
        >
          {/* Behind a card: the main video at the playhead, as it plays. */}
          {layout === "card" && underPlayhead && (
            <MainBackdrop path={underPlayhead.clip.sourcePath} time={isPicture(underPlayhead.clip.sourcePath) ? 0 : outputOffsetToSource(underPlayhead.clip, playhead - underPlayhead.start)} />
          )}
          {rects.map((r, i) => {
            const still = cellStills[i];
            const slot = cellSlots[i];
            const crop = cropOf(i);
            const w = r.width * previewW;
            const h = r.height * previewH;
            const auto = !!cellPaths[i] && !isPicture(cellPaths[i]!) && layout !== "card" && framings[slot]?.auto !== false;
            return (
              <div
                key={slot}
                data-cell={i}
                data-shot={slot}
                data-media-drop
                onPointerDown={(e) => beginCellDrag(e, i)}
                onDoubleClick={() => setFramings((prev) => ({ ...prev, [slot]: undefined }))}
                onPointerEnter={() => setHoverCell(i)}
                onPointerLeave={() => setHoverCell((h) => (h === i ? null : h))}
                title={still ? (layout === "card" ? "Drag to move the card - scroll to resize" : "Drag to frame - scroll to zoom - double-click to frame on the subject") : "Drop a video or picture here, or click to choose one"}
                className={`absolute overflow-hidden ${still ? (layout === "card" ? "cursor-move" : "cursor-grab active:cursor-grabbing") : "cursor-pointer"}`}
                style={{
                  left: r.x * previewW,
                  top: r.y * previewH,
                  width: w,
                  height: h,
                  borderRadius: corners * h,
                  transition: ease,
                  ...(layout === "card" ? featherStyle(r, frameAspect, feather) : {}),
                }}
                onClick={() => !cellPaths[i] && void pickFile(slot)}
              >
                {still ? (
                  <img
                    src={still.src}
                    alt=""
                    draggable={false}
                    className="absolute max-w-none pointer-events-none"
                    style={{
                      width: w / crop.width,
                      height: h / crop.height,
                      left: (-crop.x * w) / crop.width,
                      top: (-crop.y * h) / crop.height,
                      transition: dragging ? "none" : "left 420ms cubic-bezier(.2,.8,.2,1), top 420ms cubic-bezier(.2,.8,.2,1), width 220ms ease, height 220ms ease",
                    }}
                  />
                ) : cellPaths[i] ? (
                  <div className="absolute inset-0 bg-white/[0.06] animate-pulse" />
                ) : (
                  <div className="absolute inset-[3px] rounded-[inherit] border border-dashed border-white/25 bg-white/[0.03] flex flex-col items-center justify-center gap-1 text-white/45 hover:text-white/80 hover:border-white/50 transition-colors">
                    <IoAdd size={16} />
                    <span className="text-[9.5px] leading-tight text-center px-2">Drop a video or picture</span>
                  </div>
                )}
                <span className={`absolute left-1 top-1 min-w-[16px] h-4 px-1 rounded text-[9px] font-semibold flex items-center justify-center gap-0.5 ${badge(i)}`}>
                  {i + 1}
                  {(sound === "video" ? isSynced(cellShots[i]) : sound === slot) && <IoVolumeHighOutline size={9} />}
                </span>
                {auto && (framingBusy[slot] || hoverCell === i) && (
                  <span className="absolute right-1 top-1 h-4 px-1 rounded bg-black/55 text-[8.5px] text-white/80 flex items-center gap-0.5 pointer-events-none">
                    <IoSparkles size={8} className={framingBusy[slot] ? "animate-pulse text-fuchsia-300" : "text-fuchsia-300"} />
                    {framingBusy[slot] ? "Framing…" : "Auto-framed"}
                  </span>
                )}
              </div>
            );
          })}
          {spec.divider && (
            <div
              onPointerDown={beginDividerDrag}
              title="Drag to resize - swap with the button"
              className={`absolute z-10 flex items-center justify-center group ${spec.divider === "row" ? "left-0 right-0 h-3 -translate-y-1/2 cursor-row-resize" : "top-0 bottom-0 w-3 -translate-x-1/2 cursor-col-resize"}`}
              style={spec.divider === "row" ? { top: dividerPos * previewH } : { left: dividerPos * previewW }}
            >
              <span className={`absolute bg-white/70 rounded-full transition-opacity ${dragging === "divider" ? "opacity-100" : "opacity-0 group-hover:opacity-100"} ${spec.divider === "row" ? "left-2 right-2 h-[2px]" : "top-2 bottom-2 w-[2px]"}`} />
              <button
                type="button"
                title="Swap the two shots"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setFlipped((f) => !f);
                  setRatio((r) => 1 - r);
                }}
                className="relative w-5 h-5 rounded-full bg-neutral-900/90 ring-1 ring-white/30 text-white/80 hover:text-white hover:ring-white/60 flex items-center justify-center shadow"
              >
                {spec.divider === "row" ? <IoSwapVertical size={11} /> : <IoSwapHorizontal size={11} />}
              </button>
              {snapLabel && (
                <span className={`absolute px-1.5 py-0.5 rounded bg-blue-500 text-[9px] font-semibold ${spec.divider === "row" ? "right-2 -top-4" : "top-2 left-3"}`}>{snapLabel}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-white/40">
          Shots <span className="normal-case tracking-normal text-white/30">- drag files from the sidebar onto a cell</span>
        </span>
        {cellSlots.map((slot, i) => {
          const src = cellShots[i];
          const value = src?.kind === "clip" ? src.clipId : src?.kind === "file" ? "file" : "";
          return (
            <div key={slot} data-shot={slot} data-media-drop className="flex items-center gap-1.5 text-[11px] rounded-md">
              <span className={`w-5 h-5 shrink-0 rounded flex items-center justify-center text-[10px] font-semibold ${badge(i)}`}>{i + 1}</span>
              <select
                value={value}
                onChange={(e) => {
                  if (e.target.value === "__pick") {
                    void pickFile(slot);
                    return;
                  }
                  if (e.target.value === "file" || e.target.value === "") return;
                  setShot(slot, { kind: "clip", clipId: e.target.value });
                }}
                title={shotLabel(src)}
                className="flex-1 min-w-0 h-7 px-1.5 rounded-md bg-black/40 ring-1 ring-white/10 text-white outline-none focus:ring-blue-400"
              >
                {!src && (
                  <option value="" className="bg-neutral-800">
                    Empty - drop or choose a shot
                  </option>
                )}
                {videoClips.map((v) => (
                  <option key={v.clip.id} value={v.clip.id} className="bg-neutral-800">
                    {isPicture(v.clip.sourcePath) ? "Picture" : "Clip"} {v.index + 1} · {baseName(v.clip.sourcePath)}{" "}
                    {v === underPlayhead && !isPicture(v.clip.sourcePath) ? "(in sync with the playhead)" : `(${fmt(v.start)})`}
                  </option>
                ))}
                {src?.kind === "file" && (
                  <option value="file" className="bg-neutral-800">
                    {baseName(src.path)}
                  </option>
                )}
                <option value="__pick" className="bg-neutral-800">
                  Choose a video or picture…
                </option>
              </select>
              <button type="button" title="Choose a video or picture" onClick={() => void pickFile(slot)} className="p-1 rounded text-white/55 hover:text-white hover:bg-white/10">
                <IoFolderOpenOutline size={14} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 text-[11px]">
        {soundSlots.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-white/60">Sound</span>
            <div className="flex flex-wrap gap-1">
              {(["video", ...soundSlots] as ("video" | Slot)[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSound(s)}
                  title={s === "video" ? "Keep the main video's sound" : "Play this shot's sound too (alongside the main video's)"}
                  className={`h-6 px-2 rounded-md transition-colors ${sound === s ? "bg-blue-500/25 text-blue-200 ring-1 ring-blue-400/60" : "bg-white/[0.05] text-white/60 hover:bg-white/10"}`}
                >
                  {s === "video" ? "Main video" : `Shot ${cellSlots.indexOf(s) + 1}`}
                </button>
              ))}
            </div>
          </div>
        )}
        {layout === "card" ? (
          <>
            <label className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-white/60">Size</span>
              <input type="range" min={0.15} max={0.95} step={0.01} value={cardSize} onChange={(e) => setCardSize(Number(e.target.value))} className="flex-1 accent-blue-400" />
              <span className="w-10 text-right tabular-nums text-white/60">{Math.round(cardSize * 100)}%</span>
            </label>
            <label className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-white/60">Soft edges</span>
              <input type="range" min={0} max={0.15} step={0.005} value={feather} onChange={(e) => setFeather(Number(e.target.value))} className="flex-1 accent-blue-400" />
              <span className="w-10 text-right tabular-nums text-white/60">{Math.round((feather / 0.15) * 100)}%</span>
            </label>
          </>
        ) : (
          <>
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
          </>
        )}
        <label className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-white/60">Corners</span>
          <input type="range" min={0} max={0.2} step={0.005} value={corners} onChange={(e) => setCorners(Number(e.target.value))} className="flex-1 accent-blue-400" />
          <span className="w-10 text-right tabular-nums text-white/60">{Math.round(corners * 100)}%</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-white/60">Length</span>
          <input type="range" min={0.5} max={Math.max(0.5, maxLen)} step={0.1} value={len} onChange={(e) => setLength(Number(e.target.value))} className="flex-1 accent-blue-400" />
          <button
            type="button"
            title="As long as the shots allow"
            onClick={() => setLength(Infinity)}
            className={`w-10 text-right tabular-nums ${len >= maxLen - 0.05 ? "text-blue-300" : "text-white/60 hover:text-white"}`}
          >
            {len.toFixed(1)}s
          </button>
        </label>
      </div>

      {error && <p className="text-[11px] text-red-400">{error}</p>}

      <button
        type="button"
        disabled={!ready || room <= 0}
        onClick={apply}
        className="h-8 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-500 disabled:opacity-50 transition-colors"
      >
        {missing > 0 ? `Add ${missing === 1 ? "a shot" : `${missing} shots`} to continue` : ready ? (existing ? "Update split screen" : `Add split screen at ${fmt(playhead)}`) : "Reading shots…"}
      </button>
      <p className="text-[10px] leading-snug text-white/40">
        Drag a shot to frame it, scroll to zoom, double-click to frame on the subject again. Each shot stays its own layer you can still move, crop and retime.
      </p>
    </div>,
    document.body
  );
};

// The main video behind a card, fitted into the frame the way the timeline shows it.
const MainBackdrop: React.FC<{ path: string; time: number }> = ({ path, time }) => {
  const [still, setStill] = useState<Still | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadStill(path, time)
      .then((s) => !cancelled && setStill(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, time]);
  return still ? <img src={still.src} alt="" draggable={false} className="absolute inset-0 w-full h-full object-contain pointer-events-none" /> : null;
};

export default SplitScreenPanel;
